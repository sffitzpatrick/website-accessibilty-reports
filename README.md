# accessibility-reports

This repository runs accessibility audits (axe) and link checks using Playwright.

**Quick CI note**
- The GitHub Actions workflows must install Playwright browsers and OS deps. Ensure the workflow runs:

```yaml
run: |
	npm install
	npm ci
	npx playwright install
	npx playwright install-deps
```

I have updated the workflows in `.github/workflows/` to call `npx playwright install-deps` after `npx playwright install` so the hosted runners have the required system libraries.

**Local quickstart**

1. Install Node deps and Playwright browsers:

```bash
npm install
npx playwright install
# (optional) install OS-level libs on Linux if Playwright warns
sudo npx playwright install-deps
```

2. Run a quick dry run (creates output dirs only):

```bash
node crawler.js --start-url=https://example.com --report-dir=tmp-out --max-pages=0 --dry-run
```

3. Run a limited live crawl (1 page):

```bash
node crawler.js --start-url=https://example.com --report-dir=tmp-out --max-pages=1
```


**Supported CLI flags and env fallbacks**
- `--start-url` (or `--start_url` / env `SITE_URL`) — site to crawl
- `--report-dir` (or `--report_dir` / env `REPORT_DIR`) — output directory
- `--max-pages` (or `--max_pages` / env `MAX_PAGES`) — max pages to scan
- `--site-name` (or `--site_name` / env `SITE_NAME`) — human label
- `--datestamp` (env `DATESTAMP`) — optional datestamp
- `--dry-run` — create dirs and show config, skip crawling
- `--ignore-robots` (env `IGNORE_ROBOTS`) — bypass robots.txt restrictions
- `--user-agent <ua>` (env `USER_AGENT`) — custom User-Agent header (default: Chrome on Windows)

The CLI accepts both hyphenated flags (recommended) and underscore-style flags used in existing GitHub Actions. Environment variables are also supported so existing workflows don't need changes.

**Document audit**

`document-crawler.js` crawls the site for linked documents (PDF, Word, Excel, PowerPoint), downloads each one and checks it for accessibility problems. It runs separately from `crawler.js`:

```bash
node document-crawler.js --start-url=https://example.com --report-dir=tmp-out --max-pages=50
```

It writes `documents.html` / `documents.csv` (one row per document), `document-issues.html` / `document-issues.csv` (one row per issue) and `documents.json` to the report directory. Documents are audited in memory and are not saved.

What is checked:
- PDF: tagged, real text (not a scanned image), title, language, figure alt text, heading tags, table header cells, bookmarks in long documents, form field names
- Word (`.docx`): title, heading styles and heading order, image alt text, table header rows
- Excel (`.xlsx`): title, default sheet names, merged cells, image/chart alt text, table header rows
- PowerPoint (`.pptx`): title, slide titles, image/chart alt text
- Legacy `.doc` / `.xls` / `.ppt`, OpenDocument and RTF files are listed as needing manual review

These are structural checks only. A document with no issues detected still needs a manual review of reading order, colour contrast and alt text quality.

Flags are the same as `crawler.js` (`--start-url`, `--report-dir`, `--max-pages`, `--site-name`, `--datestamp`, `--ignore-robots`, `--user-agent`, `--verbose`), plus:
- `--max-documents` (env `MAX_DOCUMENTS`) — max documents to audit (default 500)
- `--max-size` (env `MAX_DOCUMENT_MB`) — skip documents larger than this many MB (default 50)
