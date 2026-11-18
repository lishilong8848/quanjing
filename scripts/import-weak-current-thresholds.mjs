import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import XLSX from 'xlsx';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('用法：node scripts/import-weak-current-thresholds.mjs <xlsx> <seed.json>');

const bytes = readFileSync(input);
const workbook = XLSX.read(bytes);
const headings = ['告警值', '告警运算符', '恢复值', '恢复运算符', '告警等级', '告警类型', '告警内容'];
const buildings = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
const records = [];

for (const device of workbook.SheetNames) {
  const sheet = workbook.Sheets[device];
  const bounds = XLSX.utils.decode_range(sheet['!ref']);
  const address = (r, c) => XLSX.utils.encode_cell({ r, c });
  const read = (r, c) => {
    const cell = sheet[address(r, c)];
    if (cell?.t === 'e' || (cell?.f && cell.v === undefined)) {
      throw new Error(`${device}!${address(r, c)} 公式结果无效`);
    }
    return String(cell?.v ?? '').trim();
  };
  if (bounds.e.c !== 35 || read(1, 0) !== '收敛名称') throw new Error(`${device} 表头不符`);
  for (const [index, building] of buildings.entries()) {
    const start = index * headings.length + 1;
    if (read(0, start) !== building || headings.some((name, i) => read(1, start + i) !== name)) {
      throw new Error(`${device} ${building} 表头不符`);
    }
  }
  const mergedNames = new Map();
  for (const range of sheet['!merges'] ?? []) {
    if (range.s.r < 2 || range.s.c !== 0 || range.e.c !== 0) continue;
    for (let row = range.s.r; row <= range.e.r; row++) mergedNames.set(row, range.s.r);
  }
  for (let row = 2; row <= bounds.e.r; row++) {
    const nameRow = mergedNames.get(row) ?? row;
    const parameter = read(nameRow, 0);
    for (const [index, building] of buildings.entries()) {
      const first = index * headings.length + 1;
      const rule = headings.map((_, offset) => read(row, first + offset));
      if (!rule.some(Boolean)) continue;
      if (!parameter) throw new Error(`${device}!${address(row, first)} 缺少收敛名称`);
      const [alarm, alarmOperator, recovery, recoveryOperator, severity, type, content] = rule;
      const cell = address(row, first);
      const complete = Boolean(alarm && alarmOperator && recovery && recoveryOperator && severity && type);
      records.push({
        id: `weak-current-${createHash('sha256').update(`${device}\0${cell}`).digest('hex').slice(0, 24)}`,
        profession: '弱电',
        device,
        section: type || '待核对',
        parameter,
        building,
        location: '',
        value: `告警 ${alarmOperator} ${alarm || '（缺少值）'}\n恢复 ${recoveryOperator} ${recovery || '（缺少值）'}`,
        unit: '',
        kind: complete ? '告警' : '待核对',
        enabled: '',
        note: [severity && `告警等级：${severity}`, content && `告警内容：${content}`, !complete && '原表字段不完整，请核对'].filter(Boolean).join('\n'),
        version: 1,
        updatedAt: '',
        source: { sheet: device, cell, originalValue: JSON.stringify(rule), parameterCell: address(nameRow, 0) },
      });
    }
  }
}

if (!records.length || new Set(records.map(({ id }) => id)).size !== records.length) throw new Error('无有效记录或标识重复');
const fingerprint = createHash('sha256').update(bytes).digest('hex');
writeFileSync(output, `{
  "workbookSha256": "${fingerprint}",
  "records": [
${records.map((record) => `    ${JSON.stringify(record)}`).join(',\n')}
  ]
}\n`);
console.log(`共 ${workbook.SheetNames.length} 张表，${records.length} 条记录，${records.filter(({ kind }) => kind === '待核对').length} 条待核对`);
