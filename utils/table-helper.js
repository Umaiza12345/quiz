/**
 * utils/table-helper.js
 * Very simple table extractor from plain text.
 * Returns an array of rows (arrays) and an array of objects if header detected.
 */

function normalizeLine(line) {
  return line.trim().replace(/\s{2,}/g, ' , '); // convert multiple spaces to a comma-like separator
}

function parseTableFromText(text) {
  if (!text) return { rows: [], objects: [] };
  // Try to split lines and then split by comma or multiple spaces
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], objects: [] };

  // detect delimiter: comma, tab, or many spaces
  const delim = lines[0].includes(',') ? ',' : (lines[0].includes('\t') ? '\t' : null);

  const rows = lines.map(line => {
    if (delim) return line.split(delim).map(c => c.trim());
    // fallback: split by 2+ spaces
    return normalizeLine(line).split(/\s*,\s*/).map(c => c.trim());
  });

  // If first row looks like headers (non-numeric), convert to objects
  const header = rows[0];
  let objects = [];
  if (header && header.length > 0 && header.some(h => /[A-Za-z]/.test(h))) {
    objects = rows.slice(1).map(row => {
      const obj = {};
      for (let i = 0; i < header.length; i++) {
        obj[header[i] || ('col' + i)] = row[i] || '';
      }
      return obj;
    });
  }

  return { rows, objects };
}

module.exports = { parseTableFromText };
