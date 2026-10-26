import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { normalizeThresholdWorkbookText } from './threshold-workbook-text.mjs';
import { convertElectricalWorkbook } from './import-electrical-thresholds.mjs';

test('WPS empty direct text does not hide rich-text building and delay values', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['中压逻辑时间设定值'],
    ['设备'],
    [
      '参数位置',
      'A-120',
      'A-144',
      'B-144',
      'B-120',
      'C-120',
      'C-144',
      'D-120',
      '',
      '',
      '',
    ],
    ['合闸延时', '2S', '2S', '2S', '2S', '', '', '', '', '', ''],
    ['报警延时', '/', '/', '/', '/', '/', '/', '/', '/', '/', '/'],
  ]);
  for (const [address, text] of [
    ['I3', 'D-144'],
    ['J3', 'E-120'],
    ['K3', 'E-144'],
    ['F4', '1.5S'],
  ]) {
    sheet[address] = {
      t: 's',
      v: '',
      r: `<t></t><r><t>${text[0]}</t></r><r><t>${text.slice(1)}</t></r>`,
    };
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '中压逻辑时间');
  const result = convertElectricalWorkbook(book);
  const cell = (address) =>
    result.records.find((record) => record.source.cell === address);
  assert.equal(cell('I4').building, 'D楼');
  assert.equal(cell('J4').building, 'E楼');
  assert.equal(cell('K4').location, 'E-144');
  assert.equal(cell('F4').value, '1.5S');
  assert.equal(cell('F5').value, '/');
  assert.equal(cell('F5').source.originalValue, '/');
});

test('rich text keeps spaces, newlines, entities and OOXML escaping, excluding phonetics', () => {
  const book = {
    SheetNames: ['test'],
    Sheets: {
      test: {
        A1: {
          t: 's',
          v: '',
          r: '<t></t><r><t xml:space="preserve"> A&amp;B &#x2F; </t></r><r><t>\n_x005F_x0041_</t></r><rPh><t>phonetic</t></rPh>',
        },
        B1: { t: 'n', v: 0 },
        C1: { t: 's', v: '/' },
      },
    },
  };
  assert.deepEqual(normalizeThresholdWorkbookText(book), [
    { sheet: 'test', cell: 'A1' },
  ]);
  assert.equal(book.Sheets.test.A1.v, ' A&B / \n_x0041_');
  assert.equal(book.Sheets.test.B1.v, 0);
  assert.equal(book.Sheets.test.C1.v, '/');
  assert.deepEqual(normalizeThresholdWorkbookText(book), []);
});
