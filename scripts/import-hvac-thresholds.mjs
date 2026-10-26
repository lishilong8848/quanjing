import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeThresholdWorkbookText } from './threshold-workbook-text.mjs';

// 设备网络参数属于业务数据，排除规则只针对凭证。
const sensitive = /密码|口令|密钥|password|token|secret/i;
export function convertHvacWorkbook(book) {
  normalizeThresholdWorkbookText(book);
  const records = [];
  const excluded = [];
  const ids = new Set();
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    const bounds = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    const address = (r, c) => XLSX.utils.encode_cell({ r, c });
    const merged = (r, c) => {
      const merge = (sheet['!merges'] || []).find(
        (m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c,
      );
      return merge ? merge.s : { r, c };
    };
    const text = (r, c, inherit = false) => {
      const point = inherit ? merged(r, c) : { r, c };
      const cell = sheet[address(point.r, point.c)];
      if (cell?.v === undefined) return '';
      if (cell.t === 'n' && cell.z && cell.z !== 'General')
        return XLSX.SSF.format(cell.z, cell.v).trim();
      return String(cell.v);
    };
    const device = name.replace(/^\d+-/, '');
    const add = (
      r,
      c,
      parameter,
      building,
      location,
      section = '',
      range = '',
      note = '',
      parameterCell,
      rangeCell,
      noteCell,
    ) => {
      const value = text(r, c);
      if (
        sensitive.test(
          [parameter, building, location, section, value, range, note].join(
            ' ',
          ),
        )
      ) {
        excluded.push({ sheet: name, cell: address(r, c) });
        return;
      }
      const key = `${name}:${address(r, c)}`;
      const id = `hvac-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
      if (ids.has(id)) throw new Error(`重复单元格 ${key}`);
      ids.add(id);
      const unit =
        parameter.match(
          /[（(]\s*(m³|m|min|%|℃|kPa|Pa|V|A|kW|Hz|s)\s*[）)]/i,
        )?.[1] || '';
      const kind = /告警|报警|阈值|阀值|保护|跳[断段]|上下限|[上下]限/.test(
        parameter,
      )
        ? '告警'
        : /额定|容量|型号|规格|软件版本|效率|罐体|罐壁|内径/.test(parameter)
          ? '额定参数'
          : '设定';
      records.push({
        id,
        profession: '暖通',
        device,
        section,
        parameter: parameter.trim(),
        building,
        location,
        value,
        range,
        unit,
        kind,
        enabled: '',
        note,
        version: 1,
        updatedAt: '',
        source: {
          sheet: name,
          cell: address(r, c),
          originalValue: value,
          ...(parameterCell ? { parameterCell } : {}),
          ...(rangeCell ? { rangeCell } : {}),
          ...(noteCell ? { noteCell } : {}),
        },
      });
    };
    if (name === '09-蓄冷罐') {
      for (let r = 3; r <= bounds.e.r; r++) {
        const building = text(r, 0, true).trim();
        const location = text(r, 1).trim();
        if (!building || !location) continue;
        for (let c = 2; c <= bounds.e.c; c++) {
          const parameter = text(2, c).trim();
          if (!parameter) continue;
          add(
            r,
            c,
            parameter,
            `${building.replace(/楼$/, '')}楼`,
            location,
            text(1, c, true),
            '',
            '',
            address(2, c),
          );
        }
      }
      continue;
    }
    const header = Array.from({ length: bounds.e.c + 1 }, (_, c) => text(3, c));
    const valueColumns = header.flatMap((v, c) =>
      v.trim() === '设定点' ? [c] : [],
    );
    if (valueColumns.length) {
      for (const c of valueColumns) {
        const building = text(1, c, true).trim();
        if (!/^[A-EH]楼$/.test(building))
          throw new Error(`${name} ${address(1, c)} 楼栋未识别`);
        const location = text(2, c, true).trim();
        const parameterColumn =
          name === '01-冷水机组' && c === 14
            ? 13
            : name === '08-变频补水机组参数表' && c === 15
              ? 14
              : 0;
        let section = '';
        for (let r = 4; r <= bounds.e.r; r++) {
          const parameter = text(r, parameterColumn).trim();
          if (!parameter) continue;
          if (name === '01-冷水机组' && parameter === '机组运行状态') {
            section = parameter;
            continue;
          }
          add(
            r,
            c,
            parameter,
            building,
            location,
            section,
            text(r, c + 1),
            text(r, c + 2),
            address(r, parameterColumn),
            address(r, c + 1),
            address(r, c + 2),
          );
        }
      }
      continue;
    }
    if (!['10-水泵', '11-加药装置', '12-空调软件版本'].includes(name))
      throw new Error(`${name} 工作表结构未识别`);
    for (let c = 1; c <= bounds.e.c; c++) {
      // Horizontal merged type/value columns represent one device, not a second blank device.
      if (merged(2, c).c !== c || !text(2, c).trim()) continue;
      const building = text(1, c, true).trim();
      if (!/^[A-EH]楼$/.test(building)) throw new Error(`${name} 楼栋未识别`);
      const location = [text(2, c), text(3, c, true)]
        .filter(Boolean)
        .join(' · ')
        .trim();
      for (let r = 4; r <= bounds.e.r; r++) {
        const parameter = text(r, 0).trim();
        if (parameter)
          add(r, c, parameter, building, location, '', '', '', address(r, 0));
      }
    }
  }
  return {
    schema: 1,
    records,
    audit: {
      sheets: book.SheetNames,
      counts: Object.fromEntries(
        book.SheetNames.map((name) => [
          name,
          records.filter((r) => r.source.sheet === name).length,
        ]),
      ),
      excluded,
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      '用法：node scripts/import-hvac-thresholds.mjs <xlsx> <seed.json>',
    );
  const result = convertHvacWorkbook(XLSX.readFile(input, { cellNF: true }));
  result.sourceSha256 = createHash('sha256')
    .update(readFileSync(input))
    .digest('hex');
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      records: result.records.length,
      counts: result.audit.counts,
      excluded: result.audit.excluded.length,
    }),
  );
}
