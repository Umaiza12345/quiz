// utils/pdf.js
const pdfParse = require('pdf-parse');
const { parseTableFromText } = require('./table-helper'); // small helper below or you can use heuristics

async function extractTextFromPdfBuffer(buf) {
  const res = await pdfParse(buf);
  // res.text contains all pages text in sequence
  return res.text;
}

/**
 * sumColumn(buf, { page, column })
 * - buf: Buffer of PDF
 * - page: page number (1-based)
 * - column: column name or column index
 *
 * This is a simple heuristic: convert pdf text to lines and find numeric column.
 * For robust table extraction, replace with pdfplumber (Python) or tabula.
 */
async function sumColumn(buf, { page = 2, column = 'value' } = {}) {
  const res = await pdfParse(buf);
  const pages = res.text.split(/\f/); // page breaks
  const pageText = (pages[page-1] || pages[0] || '').trim();
  // try to find lines containing the column header, or numeric tokens
  const lines = pageText.split('\n').map(l => l.trim()).filter(Boolean);

  // Try to parse as CSV-like (split on spaces or multiple spaces)
  let sum = 0;
  let found = false;
  for (const ln of lines) {
    // skip header lines
    if (!/\d/.test(ln)) continue;
    const tokens = ln.split(/\s{2,}|\t|,/); // try splitting
    for (const t of tokens) {
      const num = Number(t.replace(/[^0-9.\-]/g, ''));
      if (!Number.isNaN(num)) {
        sum += num;
        found = true;
        break; // one number per line
      }
    }
  }
  if (!found) {
    // fallback: sum all numeric tokens
    const allNums = pageText.match(/-?\d+(\.\d+)?/g) || [];
    sum = allNums.reduce((s, v) => s + Number(v), 0);
  }
  return sum;
}

module.exports = { extractTextFromPdfBuffer, sumColumn };