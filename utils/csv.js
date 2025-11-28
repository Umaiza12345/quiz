// utils/csv.js
const { parse } = require('csv-parse/sync');

async function parseBufferToObjects(buf) {
  const s = buf.toString('utf-8');
  const records = parse(s, { columns: true, skip_empty_lines: true });
  return records;
}

module.exports = { parseBufferToObjects };
