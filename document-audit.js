'use strict';

// Accessibility checks for linked documents (PDF, Word, Excel, PowerPoint).
// These are the checks a machine can make from the file structure; a passing
// document still needs a human to confirm reading order, contrast and alt text quality.

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

// -----------------------------
// Document types
// -----------------------------
const EXTENSION_TYPES = {
  pdf: 'pdf',
  doc: 'doc', dot: 'doc', docx: 'docx', docm: 'docx', dotx: 'docx',
  xls: 'xls', xlt: 'xls', xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx',
  ppt: 'ppt', pps: 'ppt', pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx',
  odt: 'odt', ods: 'ods', odp: 'odp', rtf: 'rtf'
};

// Formats we can identify but not inspect
const UNAUDITED_TYPES = {
  doc: 'Legacy Word (.doc) files',
  xls: 'Legacy Excel (.xls) files',
  ppt: 'Legacy PowerPoint (.ppt) files',
  ole: 'Legacy Office files',
  odt: 'OpenDocument text files',
  ods: 'OpenDocument spreadsheets',
  odp: 'OpenDocument presentations',
  rtf: 'RTF files'
};

function typeFromUrl(url) {
  try {
    const ext = new URL(url).pathname.split('.').pop().toLowerCase();
    return EXTENSION_TYPES[ext] || null;
  } catch { return null; }
}

function issue(id, severity, wcag, message, details = '') {
  return { id, severity, wcag, message, details };
}

// -----------------------------
// XML helpers
// -----------------------------
// Match on local names: OOXML prefixes are only a convention, and "strict"
// files use different namespace URIs for the same elements
function parseXml(xml) {
  try {
    return new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
  } catch { return null; }
}

function els(node, localName) {
  return node ? Array.from(node.getElementsByTagNameNS('*', localName)) : [];
}

function attr(el, localName) {
  for (const a of Array.from(el.attributes || [])) {
    if (a.localName === localName) return a.value;
  }
  return null;
}

function hasAncestor(el, localName) {
  for (let p = el.parentNode; p; p = p.parentNode) {
    if (p.localName === localName) return true;
  }
  return false;
}

function isOn(value) {
  return value === '1' || value === 'true';
}

function textOf(node) {
  return els(node, 't').map(t => t.textContent).join('').trim();
}

async function readXml(zip, name) {
  const file = zip.file(name);
  return file ? parseXml(await file.async('string')) : null;
}

async function coreTitle(zip) {
  const core = await readXml(zip, 'docProps/core.xml');
  return (els(core, 'title')[0]?.textContent || '').trim();
}

function missingTitleIssue() {
  return issue('missing-title', 'warning', '2.4.2', 'Document has no title',
    'Set a title in the file properties so assistive technology can announce it.');
}

// Drawing elements (pictures, charts) carry alt text in a cNvPr/docPr "descr" attribute
function lacksAltText(props) {
  if (isOn(attr(props, 'hidden'))) return false;
  if (els(props, 'decorative').some(d => isOn(attr(d, 'val')))) return false;
  return !(attr(props, 'descr') || '').trim();
}

// -----------------------------
// PDF
// -----------------------------
const MAX_PDF_PAGES = 200;
const BOOKMARK_PAGE_THRESHOLD = 20;

let pdfjsPromise;
function loadPdfjs() {
  // pdfjs-dist ships ES modules only
  pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function walkStructTree(node, stats) {
  if (!node) return;
  const role = node.role || '';
  if (role === 'Figure' || role === 'Formula') {
    stats.figures++;
    if (!(node.alt || '').trim()) stats.figuresWithoutAlt++;
  } else if (/^H[1-6]?$/.test(role)) {
    stats.headings++;
  } else if (role === 'Table') {
    stats.tables++;
  } else if (role === 'TH') {
    stats.headerCells++;
  }
  for (const child of node.children || []) walkStructTree(child, stats);
}

async function auditPdf(buffer) {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: true
  });

  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => {});
    if (err.name === 'PasswordException') {
      return { meta: {}, issues: [issue('password-protected', 'manual', '', 'Password-protected PDF could not be checked')] };
    }
    throw err;
  }

  try {
    const issues = [];
    const { info = {}, metadata } = await doc.getMetadata();
    const title = (info.Title || metadata?.get('dc:title') || '').trim();
    const pagesChecked = Math.min(doc.numPages, MAX_PDF_PAGES);

    const stats = { figures: 0, figuresWithoutAlt: 0, headings: 0, tables: 0, headerCells: 0 };
    let taggedPages = 0;
    let textChars = 0;
    const pagesWithoutText = [];
    let unlabelledFields = 0;

    for (let n = 1; n <= pagesChecked; n++) {
      const page = await doc.getPage(n);

      const tree = await page.getStructTree().catch(() => null);
      if (tree?.children?.length) {
        taggedPages++;
        walkStructTree(tree, stats);
      }

      const text = await page.getTextContent();
      const chars = text.items.reduce((sum, item) => sum + (item.str || '').trim().length, 0);
      textChars += chars;
      if (!chars) pagesWithoutText.push(n);

      if (info.IsAcroFormPresent) {
        const annotations = await page.getAnnotations();
        unlabelledFields += annotations.filter(a => a.subtype === 'Widget' && !a.hidden && !(a.alternativeText || '').trim()).length;
      }

      page.cleanup();
    }

    const tagged = taggedPages > 0;

    if (!textChars) {
      issues.push(issue('pdf-no-text', 'error', '1.1.1', 'PDF contains no real text',
        'It appears to be a scanned image. Run OCR and tag the result, or publish the source document.'));
    } else if (pagesWithoutText.length) {
      issues.push(issue('pdf-image-pages', 'warning', '1.1.1', `${pagesWithoutText.length} page(s) contain no text`,
        `Pages: ${pagesWithoutText.slice(0, 20).join(', ')}${pagesWithoutText.length > 20 ? '…' : ''}. Check that these are not scanned images.`));
    }

    if (!tagged) {
      issues.push(issue('pdf-untagged', 'error', '1.3.1', 'PDF is not tagged',
        'Without a tag structure, screen readers cannot convey headings, lists, tables or reading order.'));
    } else {
      if (stats.figuresWithoutAlt) {
        issues.push(issue('pdf-figure-alt', 'error', '1.1.1', `${stats.figuresWithoutAlt} of ${stats.figures} figure(s) have no alternate text`,
          'Add alternate text, or mark decorative images as artifacts.'));
      }
      if (!stats.headings && pagesChecked > 1) {
        issues.push(issue('pdf-no-headings', 'warning', '1.3.1', 'No heading tags found',
          'Multi-page documents need tagged headings for navigation.'));
      }
      if (stats.tables && !stats.headerCells) {
        issues.push(issue('pdf-table-headers', 'warning', '1.3.1', `${stats.tables} table(s) have no header cells`,
          'Tag header cells as TH so data cells can be associated with them.'));
      }
    }

    if (!title) {
      issues.push(issue('missing-title', 'error', '2.4.2', 'PDF has no title',
        'Set a title in the document properties.'));
    } else {
      const prefs = await doc.getViewerPreferences().catch(() => null);
      if (!prefs?.DisplayDocTitle) {
        issues.push(issue('pdf-title-not-displayed', 'warning', '2.4.2', 'PDF shows its file name instead of its title',
          'Set Initial View to show the document title (DisplayDocTitle).'));
      }
    }

    if (!(info.Language || '').trim()) {
      issues.push(issue('missing-language', 'error', '3.1.1', 'PDF has no document language',
        'Set the language in the document properties so screen readers pronounce it correctly.'));
    }

    if (doc.numPages > BOOKMARK_PAGE_THRESHOLD && !(await doc.getOutline().catch(() => null))?.length) {
      issues.push(issue('pdf-no-bookmarks', 'warning', '2.4.5', `No bookmarks in a ${doc.numPages}-page PDF`,
        'Long documents should have bookmarks that mirror the heading structure.'));
    }

    if (unlabelledFields) {
      issues.push(issue('pdf-form-labels', 'error', '4.1.2', `${unlabelledFields} form field(s) have no accessible name`,
        'Give each form field a tooltip describing it.'));
    }

    if (doc.numPages > pagesChecked) {
      issues.push(issue('pdf-partial', 'manual', '', `Only the first ${pagesChecked} of ${doc.numPages} pages were checked`));
    }

    return { meta: { title, pages: doc.numPages, tagged }, issues };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

// -----------------------------
// Word
// -----------------------------
const MIN_PARAGRAPHS_FOR_HEADINGS = 10;

async function auditDocx(zip) {
  const issues = [];
  const title = await coreTitle(zip);
  if (!title) issues.push(missingTitleIssue());

  // Style ids are localised ("Titre1"), but style names are always "heading N"
  const headingStyles = new Map();
  for (const style of els(await readXml(zip, 'word/styles.xml'), 'style')) {
    const name = attr(els(style, 'name')[0] || style, 'val') || '';
    const match = name.match(/^heading ([1-9])$/i);
    const outline = els(style, 'outlineLvl')[0];
    if (match) headingStyles.set(attr(style, 'styleId'), parseInt(match[1], 10));
    else if (outline) headingStyles.set(attr(style, 'styleId'), parseInt(attr(outline, 'val'), 10) + 1);
  }

  const doc = await readXml(zip, 'word/document.xml');
  if (!doc) throw new Error('word/document.xml is missing or unreadable');

  let textParagraphs = 0;
  let skippedLevels = 0;
  let previousLevel = 0;
  let headings = 0;
  for (const p of els(doc, 'p')) {
    if (!textOf(p)) continue;
    textParagraphs++;

    const pPr = els(p, 'pPr')[0];
    const styleId = pPr && els(pPr, 'pStyle')[0] ? attr(els(pPr, 'pStyle')[0], 'val') : null;
    const outline = pPr && els(pPr, 'outlineLvl')[0];
    let level = headingStyles.get(styleId);
    if (outline) level = parseInt(attr(outline, 'val'), 10) + 1;
    if (!level || level > 9) continue; // outline level 9 means body text

    headings++;
    if (level > previousLevel + 1) skippedLevels++;
    previousLevel = level;
  }

  if (!headings && textParagraphs >= MIN_PARAGRAPHS_FOR_HEADINGS) {
    issues.push(issue('docx-no-headings', 'error', '1.3.1', 'No heading styles used',
      'Use the built-in Heading styles rather than bold or larger text so the document can be navigated.'));
  } else if (skippedLevels) {
    issues.push(issue('docx-heading-order', 'warning', '1.3.1', `Heading levels are skipped in ${skippedLevels} place(s)`,
      'Headings should start at Heading 1 and not jump levels (for example Heading 1 to Heading 3).'));
  }

  // AlternateContent repeats each drawing in a Fallback branch; count it once
  const graphics = els(doc, 'docPr').filter(d => !hasAncestor(d, 'Fallback'));
  const withoutAlt = graphics.filter(lacksAltText).length;
  if (withoutAlt) {
    issues.push(issue('docx-image-alt', 'error', '1.1.1', `${withoutAlt} of ${graphics.length} image(s) or graphic(s) have no alt text`,
      'Add alt text, or mark the image as decorative.'));
  }

  // Either "Header Row" (tblLook) or "Repeat Header Rows" (tblHeader) identifies a header
  const tables = els(doc, 'tbl');
  const withoutHeader = tables.filter(tbl => {
    const rows = els(tbl, 'tr');
    if (rows.length < 2) return false;
    const look = els(tbl, 'tblLook')[0];
    const lookHasHeader = look && (isOn(attr(look, 'firstRow')) || (parseInt(attr(look, 'val') || '0', 16) & 0x20));
    return !lookHasHeader && !els(rows[0], 'tblHeader').length;
  }).length;
  if (withoutHeader) {
    issues.push(issue('docx-table-headers', 'warning', '1.3.1', `${withoutHeader} of ${tables.length} table(s) have no header row`,
      'Mark the first row as a header row in Table Design.'));
  }

  return { meta: { title }, issues };
}

// -----------------------------
// Excel
// -----------------------------
async function auditXlsx(zip) {
  const issues = [];
  const title = await coreTitle(zip);
  if (!title) issues.push(missingTitleIssue());

  const sheetNames = els(await readXml(zip, 'xl/workbook.xml'), 'sheet').map(s => attr(s, 'name') || '');
  const defaultNames = sheetNames.filter(n => /^Sheet\d+$/i.test(n));
  if (defaultNames.length) {
    issues.push(issue('xlsx-sheet-names', 'warning', '2.4.6', `${defaultNames.length} sheet(s) have default names`,
      `Rename ${defaultNames.slice(0, 5).join(', ')} to describe their contents.`));
  }

  // Worksheets can be huge, so count merged cells without building a DOM
  let mergedCells = 0;
  for (const file of zip.file(/^xl\/worksheets\/[^/]+\.xml$/)) {
    mergedCells += ((await file.async('string')).match(/<(\w+:)?mergeCell\b/g) || []).length;
  }
  if (mergedCells) {
    issues.push(issue('xlsx-merged-cells', 'warning', '1.3.1', `${mergedCells} merged cell range(s)`,
      'Merged cells make it hard for screen readers to work out which headers apply to a cell.'));
  }

  let graphics = 0;
  let withoutAlt = 0;
  for (const file of zip.file(/^xl\/drawings\/[^/]+\.xml$/)) {
    const drawing = parseXml(await file.async('string'));
    for (const props of els(drawing, 'cNvPr')) {
      if (!['nvPicPr', 'nvGraphicFramePr'].includes(props.parentNode?.localName)) continue;
      graphics++;
      if (lacksAltText(props)) withoutAlt++;
    }
  }
  if (withoutAlt) {
    issues.push(issue('xlsx-image-alt', 'error', '1.1.1', `${withoutAlt} of ${graphics} image(s) or chart(s) have no alt text`,
      'Add alt text, or mark the image as decorative.'));
  }

  let headerlessTables = 0;
  for (const file of zip.file(/^xl\/tables\/[^/]+\.xml$/)) {
    const table = els(parseXml(await file.async('string')), 'table')[0];
    if (table && attr(table, 'headerRowCount') === '0') headerlessTables++;
  }
  if (headerlessTables) {
    issues.push(issue('xlsx-table-headers', 'warning', '1.3.1', `${headerlessTables} table(s) have no header row`,
      'Turn on "Header Row" for each table.'));
  }

  return { meta: { title, sheets: sheetNames.length }, issues };
}

// -----------------------------
// PowerPoint
// -----------------------------
// Slide file numbers reflect creation order; the presentation part holds display order
async function slidePaths(zip) {
  const rels = new Map(
    els(await readXml(zip, 'ppt/_rels/presentation.xml.rels'), 'Relationship')
      .map(r => [attr(r, 'Id'), 'ppt/' + (attr(r, 'Target') || '').replace(/^\/?(ppt\/)?/, '')])
  );
  const ordered = els(await readXml(zip, 'ppt/presentation.xml'), 'sldId')
    .map(s => rels.get(attr(s, 'id')))
    .filter(p => p && zip.file(p));
  if (ordered.length) return ordered;

  const number = p => parseInt(p.match(/(\d+)\.xml$/)[1], 10);
  return zip.file(/^ppt\/slides\/slide\d+\.xml$/).map(f => f.name).sort((a, b) => number(a) - number(b));
}

async function auditPptx(zip) {
  const issues = [];
  const title = await coreTitle(zip);
  if (!title) issues.push(missingTitleIssue());

  const paths = await slidePaths(zip);
  const untitled = [];
  const altSlides = [];
  let graphics = 0;
  let withoutAlt = 0;

  for (let i = 0; i < paths.length; i++) {
    const slide = await readXml(zip, paths[i]);
    const root = els(slide, 'sld')[0];
    if (!root || attr(root, 'show') === '0') continue; // hidden slide

    const hasTitle = els(slide, 'sp').some(sp =>
      els(sp, 'ph').some(ph => ['title', 'ctrTitle'].includes(attr(ph, 'type'))) && textOf(sp));
    if (!hasTitle) untitled.push(i + 1);

    let missingHere = 0;
    for (const props of els(slide, 'cNvPr')) {
      if (!['nvPicPr', 'nvGraphicFramePr'].includes(props.parentNode?.localName)) continue;
      if (els(props.parentNode.parentNode, 'tbl').length) continue; // tables are read cell by cell
      graphics++;
      if (lacksAltText(props)) missingHere++;
    }
    if (missingHere) altSlides.push(i + 1);
    withoutAlt += missingHere;
  }

  if (untitled.length) {
    issues.push(issue('pptx-slide-titles', 'error', '2.4.6', `${untitled.length} of ${paths.length} slide(s) have no title`,
      `Slides: ${untitled.slice(0, 30).join(', ')}${untitled.length > 30 ? '…' : ''}. Screen reader users navigate by slide title.`));
  }
  if (withoutAlt) {
    issues.push(issue('pptx-image-alt', 'error', '1.1.1', `${withoutAlt} of ${graphics} image(s) or chart(s) have no alt text`,
      `Slides: ${altSlides.slice(0, 30).join(', ')}${altSlides.length > 30 ? '…' : ''}. Add alt text, or mark the image as decorative.`));
  }

  return { meta: { title, slides: paths.length }, issues };
}

// -----------------------------
// Entry point
// -----------------------------
const OLE_STREAMS = { doc: 'WordDocument', xls: 'Workbook', ppt: 'PowerPoint Document' };

// Identify by content, not by extension or Content-Type: a ".pdf" link can
// return a login page, and download endpoints often have no extension at all.
// Returns { type: null } when the bytes are not a recognised document.
async function auditDocument(buffer) {
  const head = buffer.subarray(0, 1024).toString('latin1');

  if (head.includes('%PDF-')) return { type: 'pdf', ...(await auditPdf(buffer)) };

  let type = null;
  if (head.startsWith('PK\x03\x04')) {
    const zip = await JSZip.loadAsync(buffer);
    if (zip.file('word/document.xml')) return { type: 'docx', ...(await auditDocx(zip)) };
    if (zip.file('xl/workbook.xml')) return { type: 'xlsx', ...(await auditXlsx(zip)) };
    if (zip.file('ppt/presentation.xml')) return { type: 'pptx', ...(await auditPptx(zip)) };

    const mimetype = zip.file('mimetype') ? await zip.file('mimetype').async('string') : '';
    if (mimetype.includes('opendocument.text')) type = 'odt';
    else if (mimetype.includes('opendocument.spreadsheet')) type = 'ods';
    else if (mimetype.includes('opendocument.presentation')) type = 'odp';
  } else if (head.startsWith('\xD0\xCF\x11\xE0')) {
    type = Object.keys(OLE_STREAMS).find(t => buffer.includes(Buffer.from(OLE_STREAMS[t], 'utf16le'))) || 'ole';
  } else if (head.startsWith('{\\rtf')) {
    type = 'rtf';
  }

  if (!type) return { type: null, meta: {}, issues: [] };
  return {
    type,
    meta: {},
    issues: [issue('not-audited', 'manual', '', `${UNAUDITED_TYPES[type]} cannot be checked automatically`,
      'Review manually, or republish as a tagged PDF or a current Office format.')]
  };
}

module.exports = { auditDocument, typeFromUrl };
