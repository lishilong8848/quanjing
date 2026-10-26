import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { convertHvacWorkbook } from './import-hvac-thresholds.mjs';
const bookWith = (name, rows, merges = []) => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = merges.map((range) => XLSX.utils.decode_range(range));
  XLSX.utils.book_append_sheet(book, sheet, name);
  return book;
};
test('设备通讯参数保留原文、空白和斜杠，口令仍排除', () => {
  const book = bookWith(
    '05-依米康风冷空调',
    [
      ['参数表'],
      ['楼栋', 'E楼'],
      ['型号/规格', '设备型号'],
      ['参数名称', '设定点', '运行范围', '备注'],
      ['通讯地址', '', '', ''],
      ['IP地址', '192.0.2.010', '', ''],
      ['主机IP', '/', '', ''],
      ['网关', '192.0.2.001', '', ''],
      ['子网掩码', '255.255.255.0', '', ''],
      ['密码', 'sensitive-qa', '', ''],
    ],
    ['B2:D2', 'B3:D3'],
  );
  const result = convertHvacWorkbook(book);
  assert.deepEqual(
    result.records.map((r) => [r.parameter, r.value]),
    [
      ['通讯地址', ''],
      ['IP地址', '192.0.2.010'],
      ['主机IP', '/'],
      ['网关', '192.0.2.001'],
      ['子网掩码', '255.255.255.0'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /sensitive-qa/);
});
test('合并楼栋下的两个型号分开，百分比/零值/范围/备注/空白保留', () => {
  const book = bookWith(
    '05-依米康风冷空调',
    [
      ['参数表'],
      ['楼栋', 'E楼'],
      ['型号/规格', '型号一', '', '', '型号二'],
      ['参数名称', '设定点', '运行范围', '备注', '设定点', '运行范围', '备注'],
      ['湿度', 0.5, '0-100', '配置', 0, '0-100', '配置'],
      ['空参数', '', '', '', '', '', ''],
      ['密码', 'sensitive-qa', '', '', 'sensitive-qa'],
    ],
    ['B2:G2', 'B3:D3', 'E3:G3'],
  );
  book.Sheets[book.SheetNames[0]].B5.z = '0%';
  const result = convertHvacWorkbook(book);
  assert.equal(result.records.length, 4);
  assert.deepEqual(
    result.records
      .filter((r) => r.parameter === '湿度')
      .map((r) => [r.building, r.location, r.value, r.range, r.note]),
    [
      ['E楼', '型号一', '50%', '0-100', '配置'],
      ['E楼', '型号二', '0', '0-100', '配置'],
    ],
  );
  assert.equal(result.records[1].value, '');
  assert.equal(result.records[0].source.rangeCell, 'C5');
  assert.doesNotMatch(JSON.stringify(result), /sensitive-qa/);
});
test('蓄冷罐转置后保留东/西区，精度按原单元格显示格式', () => {
  const book = bookWith(
    '09-蓄冷罐',
    [
      ['蓄冷罐'],
      ['相关参数', '', '', 'BA阈值'],
      ['机房楼号', '', '高度(m)', '低液位(m)'],
      ['A', '西区', 0.550000000000001, 27.15],
      ['', '东区', 0.55, 27.05],
    ],
    ['A4:A5'],
  );
  book.Sheets['09-蓄冷罐'].C4.z = '0.00';
  const result = convertHvacWorkbook(book);
  assert.equal(result.records.length, 4);
  assert.deepEqual(
    result.records.map((r) => r.building),
    ['A楼', 'A楼', 'A楼', 'A楼'],
  );
  assert.equal(result.records[0].value, '0.55');
  assert.equal(result.records[0].source.parameterCell, 'C3');
  assert.equal(result.records[2].location, '东区');
});
test('冷水机组格力列有独立参数；未识别结构拒绝猜测', () => {
  const rows = [
    ['参数表'],
    ['楼栋', 'A楼', '', '', '', '', '', '', '', '', '', '', '', '', 'D楼'],
    [
      '型号/规格',
      '开利',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '格力',
    ],
    [
      '参数名称',
      '设定点',
      '运行范围',
      '备注',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '参数名称',
      '设定点',
      '运行范围',
      '备注',
    ],
    [
      '开利参数',
      18,
      '/',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '格力参数',
      17.5,
      '17-18',
      '',
    ],
  ];
  const output = convertHvacWorkbook(bookWith('01-冷水机组', rows));
  assert.deepEqual(
    output.records.map((r) => r.parameter),
    ['开利参数', '格力参数'],
  );
  assert.throws(
    () => convertHvacWorkbook(bookWith('未知结构', [['test']])),
    /未识别/,
  );
});
