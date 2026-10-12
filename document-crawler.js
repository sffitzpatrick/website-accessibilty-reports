'use strict';

// Crawls a site for linked documents (PDF, Word, Excel, PowerPoint) and audits
// each one for accessibility. Runs independently of crawler.js.

// -----------------------------
// Requires
// -----------------------------
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const robotsParser = require('robots-parser');
const axios = require('axios');
const { program } = require('commander');
const pino = require('pino');

const { writeReport } = require('./report-utils');
const { auditDocument, typeFromUrl } = require('./document-audit');

// -----------------------------
// CLI / Options
// -----------------------------
program
  .option('--start-url <url>')
  .option('--site-name <name>')
  .option('--datestamp <date>')
  .option('--report-dir <dir>')
  .option('--max-pages <n>', 'max pages to crawl for document links')
  .option('--max-documents <n>', 'max documents to download and audit')
  .option('--max-size <mb>', 'skip documents larger than this many MB')
  .option('--ignore-robots', 'ignore robots.txt restrictions during crawl', false)
  .option('--user-agent <ua>', 'custom User-Agent header')
  .option('--verbose', 'enable debug logging', false);

program.parse(process.argv);
const opts = program.opts();

const START_URL = opts.startUrl || process.env.SITE_URL;
if (!START_URL) { console.error('❌ START_URL required'); process.exit(1); }

const SITE_NAME = opts.siteName || process.env.SITE_NAME || new URL(START_URL).hostname;
const DATESTAMP = opts.datestamp || process.env.DATESTAMP || new Date().toISOString().slice(0, 10);
const REPORT_DIR = opts.reportDir || process.env.REPORT_DIR || './output';
const MAX_PAGES = parseInt(opts.maxPages || process.env.MAX_PAGES || 100, 10);
const MAX_DOCUMENTS = parseInt(opts.maxDocuments || process.env.MAX_DOCUMENTS || 500, 10);
const MAX_BYTES = parseFloat(opts.maxSize || process.env.MAX_DOCUMENT_MB || 50) * 1024 * 1024;
const IGNORE_ROBOTS = opts.ignoreRobots || process.env.IGNORE_ROBOTS || false;
const USER_AGENT = opts.userAgent || process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AccessibilityCrawler/1.0';

const logger = pino({ level: opts.verbose ? 'debug' : process.env.LOG_LEVEL || 'info' });

// -----------------------------
// State
// -----------------------------
const DOWNLOAD_CONCURRENCY = 4;

const baseUrl = new URL(START_URL);
const domainHost = baseUrl.hostname.replace(/^www\./, '');
const assetExts = /\.(css|js|json|xml|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|eot|zip|mp4|mp3|wav|mov)$/i;

const visited = new Set();
const toVisit = new Map([[START_URL, { source: '', text: '' }]]);
// url -> { source, text, expected }; expected is false for links that only
// turned out not to be web pages, which may or may not be documents
const documents = new Map();
let robots;

// -----------------------------
// Helpers
// -----------------------------
function cleanUrl(url, base) {
  try {
    const u = new URL(url, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

// www and trailing-slash variants are the same page
function pageKey(url) {
  const u = new URL(url);
  u.hostname = u.hostname.replace(/^www\./, '');
  return u.href.replace(/\/$/, '');
}

function isInternalPage(url) {
  const u = new URL(url);
  return u.hostname.replace(/^www\./, '') === domainHost && !assetExts.test(u.pathname);
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

// isAllowed() is undefined for other hosts, which this robots.txt does not govern
function robotsBlocked(url) {
  return robots.isAllowed(url, USER_AGENT) === false;
}

function addDocument(url, source, text, expected) {
  if (!documents.has(url)) documents.set(url, { source, text, expected });
}

// -----------------------------
// Crawl
// -----------------------------
// Returns the page's links, or null when the URL is not a web page
async function crawlPage(page, url) {
  logger.info(`📄 Crawling: ${url}`);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const contentType = response?.headers()['content-type'] || '';
    if (contentType && !/html/i.test(contentType)) return null;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Embedded viewers count as well as links
    const links = await page.$$eval('a[href], iframe[src], embed[src], object[data]', nodes =>
      nodes.map(n => ({
        href: n.getAttribute('href') || n.getAttribute('src') || n.getAttribute('data'),
        text: (n.innerText || n.getAttribute('title') || '').trim().slice(0, 200)
      }))
    );
    return links
      .map(l => ({ url: cleanUrl(l.href, page.url()), text: l.text }))
      .filter(l => l.url);
  } catch (err) {
    // Navigating to a file download aborts the navigation
    logger.debug(`Not a page: ${url} - ${err.message}`);
    return null;
  }
}

async function crawlSite() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  let count = 0;

  while (toVisit.size && count < MAX_PAGES) {
    const [url, foundOn] = toVisit.entries().next().value;
    toVisit.delete(url);

    const key = pageKey(url);
    if (visited.has(key) || robotsBlocked(url)) continue;
    visited.add(key);
    count++;

    const links = await crawlPage(page, url);
    if (!links) {
      addDocument(url, foundOn.source, foundOn.text, false);
      continue;
    }

    for (const link of links) {
      if (typeFromUrl(link.url)) addDocument(link.url, url, link.text, true);
      else if (isInternalPage(link.url) && !visited.has(pageKey(link.url)) && !toVisit.has(link.url)) {
        toVisit.set(link.url, { source: url, text: link.text });
      }
    }
  }

  await browser.close();
  return count;
}

// -----------------------------
// Download / Audit
// -----------------------------
async function auditUrl(url, { source, text, expected }) {
  const result = { url, type: (typeFromUrl(url) || '').toUpperCase(), source, linkText: text, status: '', sizeKb: null, meta: {}, issues: [], error: '' };

  if (robotsBlocked(url)) {
    result.status = 'Skipped';
    result.error = 'Disallowed by robots.txt';
    return result;
  }

  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxRedirects: 5,
      maxContentLength: MAX_BYTES,
      headers: { 'User-Agent': USER_AGENT }
    });
    const buffer = Buffer.from(res.data);
    const audit = await auditDocument(buffer);

    if (!audit.type) {
      if (!expected) return null; // a broken page or other non-document; not ours to report
      result.status = 'Failed';
      result.error = `Link did not return a document (${res.headers['content-type'] || 'unknown content type'})`;
      return result;
    }

    result.type = audit.type.toUpperCase();
    result.sizeKb = Math.round(buffer.length / 1024);
    result.meta = audit.meta;
    result.issues = audit.issues;
    if (audit.issues.some(i => i.severity !== 'manual')) result.status = 'Issues found';
    else if (audit.issues.length) result.status = 'Needs manual review';
    else result.status = 'No issues detected';
  } catch (err) {
    if (!expected) return null;
    result.status = 'Failed';
    result.error = /maxContentLength/.test(err.message)
      ? `Larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB; not downloaded`
      : err.response?.status ? `HTTP ${err.response.status}` : err.message;
  }
  return result;
}

async function auditDocuments() {
  const queue = [...documents.entries()].slice(0, MAX_DOCUMENTS);
  const results = [];

  async function worker() {
    while (queue.length) {
      const [url, foundOn] = queue.shift();
      logger.info(`📎 Auditing: ${url}`);
      const result = await auditUrl(url, foundOn);
      if (result) results.push(result);
    }
  }

  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
  return results.sort((a, b) => a.url.localeCompare(b.url));
}

// -----------------------------
// Reports
// -----------------------------
function toCsv(headers, rows) {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers, ...rows.map(r => headers.map(h => r[h]))].map(r => r.map(cell).join(',')).join('\n');
}

async function writeReports(results) {
  const count = (r, severity) => r.issues.filter(i => i.severity === severity).length;

  const documentHeaders = ['Document', 'Type', 'Status', 'Errors', 'Warnings', 'Notes', 'Title', 'Size (KB)', 'Source Page', 'Link Text'];
  const documentRows = results.map(r => ({
    'Document': r.url,
    'Type': r.type,
    'Status': r.status,
    'Errors': count(r, 'error'),
    'Warnings': count(r, 'warning'),
    'Notes': r.error || r.issues.filter(i => i.severity === 'manual').map(i => i.message).join('; '),
    'Title': r.meta.title || '',
    'Size (KB)': r.sizeKb ?? '',
    'Source Page': r.source,
    'Link Text': r.linkText
  }));

  const issueHeaders = ['Document', 'Type', 'Severity', 'Issue', 'How to Fix', 'WCAG', 'Source Page'];
  const issueRows = results.flatMap(r => r.issues.map(i => ({
    'Document': r.url,
    'Type': r.type,
    'Severity': i.severity,
    'Issue': i.message,
    'How to Fix': i.details,
    'WCAG': i.wcag,
    'Source Page': r.source
  })));

  const reportMeta = { siteUrl: START_URL, siteName: SITE_NAME, datestamp: DATESTAMP };
  await fs.promises.writeFile(path.join(REPORT_DIR, 'documents.json'), JSON.stringify(results, null, 2));
  await fs.promises.writeFile(path.join(REPORT_DIR, 'documents.csv'), toCsv(documentHeaders, documentRows));
  await fs.promises.writeFile(path.join(REPORT_DIR, 'document-issues.csv'), toCsv(issueHeaders, issueRows));
  writeReport(documentRows, documentHeaders, REPORT_DIR, 'documents', {
    title: 'Document Accessibility Report', linkColumns: ['Document', 'Source Page'], ...reportMeta
  });
  writeReport(issueRows, issueHeaders, REPORT_DIR, 'document-issues', {
    title: 'Document Accessibility Issues', linkColumns: ['Document', 'Source Page'], ...reportMeta
  });
}

// -----------------------------
// Main
// -----------------------------
(async () => {
  await fs.promises.mkdir(REPORT_DIR, { recursive: true });
  logger.info({ startUrl: START_URL, siteName: SITE_NAME, maxPages: MAX_PAGES, maxDocuments: MAX_DOCUMENTS, reportDir: REPORT_DIR }, 'Document crawler configuration');

  await loadRobotsTxt();

  const pages = await crawlSite();
  const found = [...documents.values()].filter(d => d.expected).length;
  logger.info(`Crawled ${pages} pages, found ${found} document links`);
  if (found > MAX_DOCUMENTS) logger.warn(`Only the first ${MAX_DOCUMENTS} documents will be audited`);

  const results = await auditDocuments();
  await writeReports(results);

  const withIssues = results.filter(r => r.status === 'Issues found').length;
  const failed = results.filter(r => r.status === 'Failed').length;
  logger.info(`✅ Completed. Documents audited: ${results.length - failed}, with issues: ${withIssues}, failed to fetch: ${failed}`);
})();
