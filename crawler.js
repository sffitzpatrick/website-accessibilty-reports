'use strict';

// -----------------------------
// Requires
// -----------------------------
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { createHtmlReport } = require('axe-html-reporter');
const robotsParser = require('robots-parser');
const axios = require('axios');

let program, pino, minimist;
try { ({ program } = require('commander')); } catch { program = null; }
try { pino = require('pino'); } catch { pino = null; }
try { minimist = require('minimist'); } catch { minimist = null; }

const { readCSV, writeReport, issueKey, screenshotPath } = require('./report-utils');

// -----------------------------
// CLI / Options
// -----------------------------
if (program) {
  program
    .option('--start-url <url>')
    .option('--site-name <name>')
    .option('--datestamp <date>')
    .option('--report-dir <dir>', './output')
    .option('--max-pages <n>', (v) => parseInt(v, 10), 100)
    .option('--dry-run', 'create output dirs and show config but do not crawl', false)
    .option('--ignore-robots', 'ignore robots.txt restrictions during crawl', false)
    .option('--user-agent <ua>', 'custom User-Agent header',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AccessibilityCrawler/1.0')
    .option('--verbose', 'enable debug logging', false);

  program.parse(process.argv);
}

const opts = program ? program.opts() : {};
const mm = minimist ? minimist(process.argv.slice(2)) : {};

// -----------------------------
// Option Resolution
// -----------------------------
const START_URL = opts.startUrl || process.env.SITE_URL || mm.start_url || mm.startUrl;
if (!START_URL) { console.error('❌ START_URL required'); process.exit(1); }

const SITE_NAME = opts.siteName || process.env.SITE_NAME || mm.site_name || mm.siteName || new URL(START_URL).hostname;
const DATESTAMP = opts.datestamp || process.env.DATESTAMP || mm.datestamp || new Date().toISOString().slice(0,10);
const REPORT_DIR = opts.reportDir || process.env.REPORT_DIR || mm.report_dir || mm.reportDir || './output';
const MAX_PAGES = parseInt(opts.maxPages || process.env.MAX_PAGES || mm.max_pages || mm.maxPages || 100, 10);
const DRY_RUN = opts.dryRun || process.env.DRY_RUN || mm.dry_run || false;
const IGNORE_ROBOTS = opts.ignoreRobots || process.env.IGNORE_ROBOTS || mm.ignore_robots || false;
const USER_AGENT = opts.userAgent || process.env.USER_AGENT;

// -----------------------------
// Logger
// -----------------------------
let logger;
if (pino) {
  logger = pino({ level: opts.verbose ? 'debug' : process.env.LOG_LEVEL || 'info' });
} else {
  const level = opts.verbose ? 'debug' : process.env.LOG_LEVEL || 'info';
  logger = {
    info: (...a) => console.log('[info]', ...a),
    debug: (...a) => level === 'debug' && console.debug('[debug]', ...a),
    warn: (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a)
  };
}

// -----------------------------
// Paths & State
// -----------------------------
const DIR_BASE = REPORT_DIR;
const OUTPUT_DIR = path.join(DIR_BASE, 'reports');
const SCREENSHOT_DIR = path.join(DIR_BASE, 'screenshots');
const RAW_JSON_DIR = path.join(DIR_BASE, 'axe_json');
const LINK_JSON_PATH = path.join(DIR_BASE, 'link_issues.json');
const LINK_CSV_PATH = path.join(DIR_BASE, 'broken-links.csv');

const visited = new Set();
const toVisit = new Set([START_URL]);
const checkedLinks = new Map();
const allLinkResults = [];

const baseUrl = new URL(START_URL);
const domainHost = baseUrl.hostname.replace(/^www\./, '');
const nonHtmlExts = /\.(css|js|pdf|png|jpe?g|svg|gif|ico|woff2?|ttf|eot|zip|mp4|mp3)$/i;
let robots;

// -----------------------------
// Helpers
// -----------------------------
async function createDirectory(dir) { await fs.promises.mkdir(dir, { recursive: true }); }

function normalizeUrl(url) {
  try {
    const u = new URL(url, START_URL);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    return u.href.replace(/\/$/, '');
  } catch { return null; }
}

function isHtmlPage(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./,'') === domainHost && !nonHtmlExts.test(u.pathname);
  } catch { return false; }
}

async function loadRobotsTxt() {
  if (IGNORE_ROBOTS) { robots = { isAllowed: () => true }; return; }
  try {
    const robotsUrl = baseUrl.origin + '/robots.txt';
    const res = await axios.get(robotsUrl, { timeout: 5000, headers: { 'User-Agent': USER_AGENT } });
    robots = robotsParser(robotsUrl, res.data);
    logger.info(`Loaded robots.txt from ${robotsUrl}`);
  } catch {
    robots = { isAllowed: () => true };
    logger.warn('robots.txt not found; crawling anyway');
  }
}

// -----------------------------
// Crawl / Extract / Check
// -----------------------------
// Scroll through the page so lazy-loaded images and widgets render, then wait
// for web fonts, so axe measures the page as a visitor would see it
async function settlePage(page) {
  await page.evaluate(async () => {
    const MAX_STEPS = 30; // guard against infinite-scroll pages
    for (let step = 0; step < MAX_STEPS && window.scrollY + window.innerHeight < document.body.scrollHeight; step++) {
      window.scrollBy(0, window.innerHeight);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    window.scrollTo(0, 0);
    await document.fonts.ready;
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

// Needs-review screenshots: one per issue key across the whole crawl, so a
// site-wide element is captured once rather than on every page
const MAX_SCREENSHOTS_PER_PAGE = 25;
const MAX_SCREENSHOT_ATTEMPTS = 2; // hidden elements fail every time; don't retry them on every page
const screenshotAttempts = new Map();
const screenshotsTaken = new Set();

// Each axe target entry is one frame hop; a nested array is a shadow DOM path
// (Playwright CSS locators pierce open shadow roots when chained)
function locatorFor(page, target) {
  let scope = page;
  for (const hop of target.slice(0, -1)) {
    if (Array.isArray(hop)) return null; // shadow DOM host inside a frame path; rare, skip
    scope = scope.frameLocator(hop);
  }
  const last = target[target.length - 1];
  const selectors = Array.isArray(last) ? last : [last];
  return selectors.reduce((loc, sel) => loc.locator(sel), scope).first();
}

async function screenshotNeedsReview(page, results) {
  let taken = 0;
  for (const rule of results.incomplete || []) {
    for (const node of rule.nodes || []) {
      if (taken >= MAX_SCREENSHOTS_PER_PAGE) return;

      const key = issueKey('needs-review', rule.id, node.target);
      const attempts = screenshotAttempts.get(key) || 0;
      if (screenshotsTaken.has(key) || attempts >= MAX_SCREENSHOT_ATTEMPTS) continue;
      screenshotAttempts.set(key, attempts + 1);

      const locator = locatorFor(page, node.target || []);
      if (!locator) continue;

      try {
        await locator.screenshot({ path: path.join(DIR_BASE, screenshotPath(key)), timeout: 2000, animations: 'disabled' });
        screenshotsTaken.add(key);
        taken++;
      } catch {
        // Hidden, zero-size or detached elements can't be captured
      }
    }
  }
}

async function crawlPage(page, url, index) {
  logger.info(`📄 Crawling: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await settlePage(page);
    // AxeBuilder injects axe into every frame, including cross-origin iframes,
    // which axe.run() in the top page alone cannot see into
    const results = await new AxeBuilder({ page }).analyze();
    await screenshotNeedsReview(page, results);

    const title = await page.title();
    const report = { meta: { scannedAt: new Date().toISOString(), url, documentTitle: title, index }, results };

    await fs.promises.writeFile(path.join(RAW_JSON_DIR, `${index}.json`), JSON.stringify(report,null,2));
    createHtmlReport({ results, options: { outputDir: OUTPUT_DIR, reportFileName: `${index}.html` } });

    return true;
  } catch (err) {
    logger.error(`❌ Failed: ${url} - ${err.message}`);
    return false;
  }
}

async function extractLinks(page, sourceUrl) {
  const links = await page.$$eval('a[href]', anchors =>
    anchors.map(a => ({ href: a.getAttribute('href'), text: (a.innerText||'').trim().slice(0,200) }))
  );
  return links
    .map(l => {
      if (!l.href || l.href.startsWith('#') || l.href.startsWith('mailto:') || l.href.startsWith('tel:') || l.href.startsWith('javascript:')) return null;
      try { return { url: new URL(l.href, sourceUrl).href, text: l.text }; } catch { return null; }
    })
    .filter(Boolean);
}

async function checkLinksConcurrently(links, sourceUrl, concurrency=10) {
  const queue = [...links];
  const workers = [];

  async function worker() {
    while(queue.length) {
      const { url, text } = queue.shift();
      if (checkedLinks.has(url)) continue;
      checkedLinks.set(url, true);
      try {
        const res = await axios.head(url, { maxRedirects:5, timeout:5000, headers:{'User-Agent':USER_AGENT} });
        if (res.status >= 400) allLinkResults.push({ source:sourceUrl, link:url, status:res.status, text });
      } catch(err) {
        allLinkResults.push({ source:sourceUrl, link:url, status:err.response?.status || null, error:err.code||err.message, text });
      }
    }
  }

  for(let i=0;i<concurrency;i++) workers.push(worker());
  await Promise.all(workers);
}

// -----------------------------
// Generate CSV + HTML
// -----------------------------
async function generateLinkReports() {
  // Write CSV
  const rows = ['Source Page,Link,Status,Link Text', ...allLinkResults.map(l =>
    `"${l.source}","${l.link}",${l.status||'FAILED'},"${(l.text||'').replace(/"/g,'""')}"`
  )];
  await fs.promises.writeFile(LINK_CSV_PATH, rows.join('\n'));

  // Read CSV and generate HTML
  const { headers, data } = readCSV(LINK_CSV_PATH);
  writeReport(data, headers, REPORT_DIR, 'broken-links', {
    title: 'Broken Links Report',
    linkColumns: ['Link', 'Source Page'],
    siteUrl: START_URL,
    siteName: SITE_NAME,
    datestamp: DATESTAMP
  });

  logger.info(`✅ Broken link report written: ${allLinkResults.length} issues`);
}

// -----------------------------
// Main Crawl Loop
// -----------------------------
(async () => {
  await createDirectory(REPORT_DIR);
  await createDirectory(OUTPUT_DIR);
  await createDirectory(RAW_JSON_DIR);
  await createDirectory(SCREENSHOT_DIR);

  logger.info({startUrl:START_URL, siteName:SITE_NAME, maxPages:MAX_PAGES, reportDir:DIR_BASE, dryRun:DRY_RUN}, 'Crawler configuration');

  if(DRY_RUN) { logger.info('Dry run enabled — exiting'); process.exit(0); }

  await loadRobotsTxt();

  const browser = await chromium.launch();
  // AxeBuilder opens a helper page to combine iframe results, which needs a shared context
  const context = await browser.newContext();
  const page = await context.newPage();
  let count = 0;

  while(toVisit.size && count < MAX_PAGES) {
    const rawUrl = toVisit.values().next().value;
    toVisit.delete(rawUrl);

    const url = normalizeUrl(rawUrl);
    if(!url || visited.has(url)) continue;
    if(!robots.isAllowed(url)) continue;

    visited.add(url);

    const success = await crawlPage(page, url, ++count);
    if(!success) continue;

    const links = await extractLinks(page, url);
    await checkLinksConcurrently(links, url, 10);

    links
      .map(l => normalizeUrl(l.url))
      .filter(isHtmlPage)
      .forEach(l => { if(!visited.has(l)) toVisit.add(l); });
  }

  await browser.close();

  // Generate CSV + HTML safely
  await generateLinkReports();

  logger.info(`✅ Completed. Pages scanned: ${count}, Broken links: ${allLinkResults.length}`);
})();