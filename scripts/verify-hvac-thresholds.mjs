import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { convertHvacWorkbook } from './import-hvac-thresholds.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    '用法：node scripts/verify-hvac-thresholds.mjs <xlsx> <seed.json>',
  );
const seed = JSON.parse(readFileSync(output, 'utf8'));
const book = XLSX.readFile(input, { cellNF: true });
const regenerated = convertHvacWorkbook(book);
assert.deepEqual(seed.records, regenerated.records);
assert.deepEqual(seed.audit, regenerated.audit);
assert.equal(
  seed.sourceSha256,
  createHash('sha256').update(readFileSync(input)).digest('hex'),
);
let verifiedSourceCells = 0;
const text = (sheet, address) => {
  const cell = sheet[address];
  if (cell?.v === undefined) return '';
  return cell.t === 'n' && cell.z && cell.z !== 'General'
    ? XLSX.SSF.format(cell.z, cell.v).trim()
    : String(cell.v);
};
for (const record of seed.records) {
  const sheet = book.Sheets[record.source.sheet];
  assert.equal(record.value, text(sheet, record.source.cell));
  verifiedSourceCells++;
  for (const [field, coordinate] of [
    ['range', 'rangeCell'],
    ['note', 'noteCell'],
  ]) {
    if (!record.source[coordinate]) continue;
    assert.equal(record[field], text(sheet, record.source[coordinate]));
    verifiedSourceCells++;
  }
}
console.log(
  JSON.stringify({
    records: seed.records.length,
    verifiedSourceCells,
    excluded: seed.audit.excluded.length,
    sourceSha256: seed.sourceSha256,
    result: 'pass',
  }),
);
