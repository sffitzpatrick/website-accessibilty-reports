// summary-reporter.js
'use strict';

const fs = require('fs');
const path = require('path');
const csvWriter = require('csv-writer').createObjectCsvWriter;
const args = require('minimist')(process.argv.slice(2));

const { readCSV, writeReport, formatTarget, issueKey, screenshotPath } = require('./report-utils');

// -----------------------------
// Command-line / Environment
// -----------------------------
const SITE_NAME = args['site-name'] || process.env.SITE_NAME || '';
const DATESTAMP = args.datestamp || process.env.DATESTAMP || '';
const REPORT_DIR = args['report-dir'] || process.env.REPORT_DIR;
const SITE_URL = args['start-url'] || process.env.SITE_URL || '';

if (!REPORT_DIR) {
  console.error('❌ REPORT_DIR is required');
  process.exit(1);
}

// -----------------------------
// Paths
// -----------------------------
const JSON_DIR = path.join(__dirname, REPORT_DIR, 'axe_json');
const CSV_PATH = path.join(__dirname, REPORT_DIR, 'summary.csv');
const DETAILS_CSV_PATH = path.join(__dirname, REPORT_DIR, 'violations-detailed.csv');
const REMEDIATION_PATH = path.join(__dirname, REPORT_DIR, 'remediation.json');

// -----------------------------
// Prepare data
// -----------------------------
const summary = [];
const allViolations = [];

// Remediation issues, grouped by type + rule + selector so a template-level
// problem repeated across hundreds of pages becomes one issue
const issues = new Map();
let axeVersion = '';

// Severity weights
const WEIGHTS = { critical: 4, serious: 3, moderate: 2, minor: 1 };

// Caps that keep remediation.json small; the full occurrence list is in violations-detailed.csv
const MAX_EXAMPLE_PAGES = 10;
const MAX_RELATED_NODES = 5;

function formatChecks(node) {
  return ['any', 'all', 'none'].flatMap(kind => (node[kind] || []).map(check => ({
    kind,
    id: check.id,
    message: check.message,
    data: check.data ?? null,
    relatedNodes: (check.relatedNodes || []).slice(0, MAX_RELATED_NODES).map(rn => ({
      selector: formatTarget(rn.target),
      html: rn.html
    }))
  })));
}

function addIssues(type, rules, page) {
  rules.forEach(rule => {
    rule.nodes?.forEach(node => {
      const selector = formatTarget(node.target);
      const key = issueKey(type, rule.id, node.target);

      if (!issues.has(key)) {
        issues.set(key, {
          type,
          rule: rule.id,
          impact: node.impact || rule.impact || null,
          help: rule.help,
          description: rule.description,
          helpUrl: rule.helpUrl,
          wcag: (rule.tags || []).filter(tag => /^wcag|^best-practice$/.test(tag)),
          selector,
          html: node.html,
          failureSummary: node.failureSummary || null,
          checks: formatChecks(node),
          screenshot: null,
          pageCount: 0,
          examplePages: []
        });
      }

      // axe selectors are unique within a page, so each hit here is a new page
      const issue = issues.get(key);
      issue.pageCount++;
      // The crawler screenshots each needs-review issue once, on whichever page it saw it first
      if (!issue.screenshot && type === 'needs-review' && fs.existsSync(path.join(__dirname, REPORT_DIR, screenshotPath(key)))) {
        issue.screenshot = screenshotPath(key);
      }
      if (issue.examplePages.length < MAX_EXAMPLE_PAGES) issue.examplePages.push(page);
    });
  });
}

if (!fs.existsSync(JSON_DIR)) {
  console.error(`❌ JSON directory not found: ${JSON_DIR}`);
  process.exit(1);
}

// -----------------------------
// Read JSON and build summaries
// -----------------------------
fs.readdirSync(JSON_DIR).forEach(file => {
  if (!file.endsWith('.json')) return;

  const filePath = path.join(JSON_DIR, file);
  let data;

  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`⚠️ Skipping malformed JSON: ${file}`);
    return;
  }

  const violations = data.violations || data.results?.violations || [];
  const passes = data.passes || data.results?.passes || [];
  const incomplete = data.incomplete || data.results?.incomplete || [];
  axeVersion = axeVersion || data.testEngine?.version || data.results?.testEngine?.version || '';

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let severityScore = 0;

  const pageUrl = data.url || data.meta?.url || '';
  const pageTitle = data.documentTitle || data.meta?.documentTitle || '';

  console.log(`Processing ${file} — ${violations.length} violations, ${passes.length} passes`);

  violations.forEach(v => {
    const impact = v.impact || 'minor';
    const nodeCount = v.nodes?.length || 0;

    if (counts[impact] !== undefined) {
      counts[impact] += nodeCount;
      severityScore += nodeCount * (WEIGHTS[impact] || 0);
    }

    v.nodes?.forEach(node => {
      allViolations.push({
        page: file.replace('.json', ''),
        url: pageUrl,
        title: pageTitle,
        impact: impact,
        id: v.id || '',
        description: v.description || '',
        help: v.help || '',
        helpUrl: v.helpUrl || '',
        html: node.html || ''
      });
    });
  });

  const page = { page: file.replace('.json', ''), url: pageUrl, title: pageTitle };
  addIssues('violation', violations, page);
  addIssues('needs-review', incomplete, page);

  summary.push({
    page: file.replace('.json', ''),
    pageTitle,
    pageUrl,
    reportLink: `./reports/${file.replace('.json', '.html')}`,
    totalViolations: violations.length,
    totalPasses: passes.length,
    severityScore,
    ...counts
  });
});

// -----------------------------
// Async function to write CSV + HTML
// -----------------------------
async function generateReports() {
  try {
    // --- Write summary CSV ---
    await csvWriter({
      path: CSV_PATH,
      header: [
        { id: 'page', title: 'Page' },
        { id: 'pageTitle', title: 'Title' },
        { id: 'pageUrl', title: 'URL' },
        { id: 'reportLink', title: 'Report Link' },
        { id: 'totalViolations', title: 'Total Violations' },
        { id: 'totalPasses', title: 'Total Passes' },
        { id: 'critical', title: 'Critical' },
        { id: 'serious', title: 'Serious' },
        { id: 'moderate', title: 'Moderate' },
        { id: 'minor', title: 'Minor' },
        { id: 'severityScore', title: 'Severity Score' },
      ]
    }).writeRecords(summary);

    console.log('✅ summary.csv written');

    // --- Write detailed CSV ---
    await csvWriter({
      path: DETAILS_CSV_PATH,
      header: [
        { id: 'page', title: 'Page' },
        { id: 'url', title: 'URL' },
        { id: 'title', title: 'Title' },
        { id: 'impact', title: 'Impact' },
        { id: 'id', title: 'Rule ID' },
        { id: 'description', title: 'Description' },
        { id: 'help', title: 'Help' },
        { id: 'helpUrl', title: 'Help URL' },
        { id: 'html', title: 'HTML Element' },
      ]
    }).writeRecords(allViolations);

    console.log('✅ violations-detailed.csv written');

    // --- Write remediation JSON ---
    const sortedIssues = [...issues.values()].sort((a, b) =>
      (a.type === b.type ? 0 : a.type === 'violation' ? -1 : 1) ||
      (WEIGHTS[b.impact] || 0) - (WEIGHTS[a.impact] || 0) ||
      b.pageCount - a.pageCount
    );

    fs.writeFileSync(REMEDIATION_PATH, JSON.stringify({
      site: SITE_NAME,
      startUrl: SITE_URL,
      datestamp: DATESTAMP,
      axeVersion,
      pagesScanned: summary.length,
      totals: {
        violations: sortedIssues.filter(i => i.type === 'violation').length,
        needsReview: sortedIssues.filter(i => i.type === 'needs-review').length
      },
      issues: sortedIssues
    }, null, 2));

    console.log(`✅ remediation.json written (${sortedIssues.length} grouped issues)`);

    // --- Read summary CSV and generate HTML ---
    const { headers, data } = readCSV(CSV_PATH);

    writeReport(data, headers, REPORT_DIR, 'summary', {
      title: 'Accessibility Summary Report',
      linkColumns: ['URL', 'Report Link'],
      siteUrl: SITE_URL,
      siteName: SITE_NAME,
      datestamp: DATESTAMP
    });

    console.log('✅ summary.html written');

  } catch (err) {
    console.error('❌ Error generating reports', err);
  }
}

// Run
generateReports();