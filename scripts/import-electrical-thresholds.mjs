import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { normalizeThresholdWorkbookText } from './threshold-workbook-text.mjs';

// 设备网络参数属于业务数据，排除规则只针对凭证。
const sensitive = /密码|口令|密钥|password|token|secret/i;
const cleanHeading = (value) =>
  String(value || '')
    .replace(/[（(][^）)]*(?:密码|口令)[^）)]*[）)]/g, '')
    .trim();
export function convertElectricalWorkbook(
  book,
  { transformerSharedBuildings = [] } = {},
) {
  if (
    transformerSharedBuildings.some(
      (building) => !['A楼', 'B楼', 'C楼'].includes(building),
    ) ||
    new Set(transformerSharedBuildings).size !==
      transformerSharedBuildings.length
  )
    throw new Error('变压器共用楼栋必须为不重复的A/B/C楼');
  normalizeThresholdWorkbookText(book);
  const records = [];
  const excluded = [];
  const seen = new Set();
  const getRows = (name) => {
    const sheet = book.Sheets[name];
    if (!sheet?.['!ref']) return [];
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      range: { s: { r: 0, c: 0 }, e: XLSX.utils.decode_range(sheet['!ref']).e },
      defval: '',
    });
  };
  function add(sheetName, row, col, meta, enabled = '', sourceRefs = {}) {
    const sheet = book.Sheets[sheetName];
    const cell = XLSX.utils.encode_cell({ r: row, c: col });
    const source = sheet[cell];
    const originalValue = source
      ? String(
          source.z?.includes('%')
            ? XLSX.utils.format_cell(source)
            : (source.v ?? ''),
        )
      : '';
    const safeMeta = { ...meta, section: cleanHeading(meta.section) };
    if (
      sensitive.test(
        [
          safeMeta.parameter,
          safeMeta.section,
          originalValue,
          safeMeta.note,
        ].join(' '),
      )
    ) {
      excluded.push({ sheet: sheetName, cell, reason: '敏感配置' });
      return;
    }
    const key = `${sheetName}:${cell}:${safeMeta.building || ''}`;
    if (seen.has(key)) throw new Error(`重复数据坐标 ${key}`);
    seen.add(key);
    const unit =
      safeMeta.parameter.match(
        /[（(](V|A|kW|Hz|ms|s|秒|分|℃|%|kΩ|AH)[）)]/i,
      )?.[1] || '';
    const kind = safeMeta.parameter.startsWith('未标注')
      ? '待核对'
      : /告警|报警|阈值|门限|保护|超温|超高|超低|[上下]限/.test(
            safeMeta.parameter,
          )
        ? '告警'
        : /额定|容量|节数|组数|规格|品牌/.test(
              `${safeMeta.parameter} ${safeMeta.section}`,
            )
          ? '额定参数'
          : '设定';
    records.push({
      profession: '电气',
      device: sheetName,
      section: '',
      parameter: '',
      building: '',
      location: '',
      note: '',
      ...safeMeta,
      value: originalValue,
      unit,
      kind,
      enabled,
      id: `electrical-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
      version: 1,
      updatedAt: '',
      source: { sheet: sheetName, cell, originalValue, ...sourceRefs },
    });
  }
  function block(
    name,
    {
      parameterCol,
      groupCol,
      valueCols,
      start = 2,
      end = 199,
      section = '',
      location = '',
      headers,
      buildingOverride,
      inferUnnamed = false,
      paired = false,
      labelFallback,
      brands,
      sectionLabels = [],
      codeCol,
      trailingNotes = false,
      sectionHeaders,
    },
  ) {
    if (!book.Sheets[name]) return;
    const rows = getRows(name);
    const merges = book.Sheets[name]['!merges'] || [];
    let group = section;
    let pairActive = false;
    for (let row = start; row <= Math.min(end, rows.length - 1); row++) {
      const values = rows[row] || [];
      const labelMerge = merges.find(
        (merge) =>
          merge.s.r === row &&
          merge.e.r === row &&
          merge.s.c <= parameterCol &&
          merge.e.c >= parameterCol,
      );
      const sharedLabel =
        groupCol !== undefined &&
        labelMerge?.s.c === groupCol &&
        labelMerge.e.c < Math.min(...valueCols);
      if (groupCol !== undefined && values[groupCol] && !sharedLabel)
        group = cleanHeading(values[groupCol]);
      let parameter = cleanHeading(
        labelMerge ? values[labelMerge.s.c] : values[parameterCol],
      );
      if (sensitive.test(parameter)) {
        excluded.push({ sheet: name, row: row + 1, reason: '敏感配置' });
        continue;
      }
      if (/^(楼栋|参数\s*位置|参数|设备编号)$/.test(parameter)) {
        pairActive =
          paired && valueCols.some((col) => values[col] === '告警使能');
        continue;
      }
      const anyValue = valueCols.some(
        (col) => values[col] !== '' || (pairActive && values[col + 1] !== ''),
      );
      const sectionRow =
        !anyValue &&
        parameter &&
        ((labelMerge && labelMerge.e.c >= Math.min(...valueCols)) ||
          sectionLabels.includes(parameter));
      if (sectionRow) {
        group = parameter;
        pairActive = false;
        continue;
      }
      if (!parameter && !anyValue) continue;
      if (!parameter && labelFallback)
        parameter = cleanHeading(labelFallback(row));
      if (!parameter && !inferUnnamed) continue;
      const unnamed = !parameter;
      parameter ||= `未标注参数 · 第${row + 1}行`;
      for (const col of valueCols) {
        const header = headers?.[col] || '';
        const building =
          buildingOverride?.[col] ||
          header.match(/(?:^|[^A-Z])([ABCDEH])(?:楼|[-、]|$)/)?.[1];
        const buildingLabel = building
          ? building.endsWith('楼')
            ? building
            : `${building}楼`
          : '';
        const locationLabel =
          header ||
          `${location ? `${location} · ` : ''}原表${XLSX.utils.encode_col(col)}列`;
        const noteCoordinates = [];
        if (
          codeCol !== undefined &&
          values[codeCol] !== '' &&
          values[codeCol] !== undefined
        )
          noteCoordinates.push(codeCol);
        if (trailingNotes && col === Math.max(...valueCols)) {
          for (let extra = col + 2; extra < values.length; extra++) {
            if (values[extra] !== '' && values[extra] !== undefined)
              noteCoordinates.push(extra);
          }
        }
        const note = [
          !buildingLabel && !header ? '原表未标明楼栋或位置' : '',
          unnamed ? '原表未标明参数名称' : '',
          ...noteCoordinates.map((c) => String(values[c])),
        ]
          .filter(Boolean)
          .join('\n');
        const enabled = pairActive ? String(values[col] ?? '') : '';
        add(
          name,
          row,
          pairActive ? col + 1 : col,
          {
            parameter,
            section: sectionHeaders?.[col] || group,
            building: buildingLabel,
            location: location
              ? `${location} · ${locationLabel}`
              : locationLabel,
            note,
            ...(brands ? { brand: String(brands[col] ?? '') } : {}),
          },
          enabled,
          noteCoordinates.length
            ? {
                noteCell: noteCoordinates
                  .map((c) => XLSX.utils.encode_cell({ r: row, c }))
                  .join(','),
              }
            : {},
        );
      }
    }
  }
  const headers = (name, row) => getRows(name)[row] || [];
  const mergedHeaders = (name, row) => {
    const raw = headers(name, row);
    return raw.map((value, col) => {
      const merge = (book.Sheets[name]?.['!merges'] || []).find(
        (m) => m.s.r <= row && m.e.r >= row && m.s.c <= col && m.e.c >= col,
      );
      return merge ? getRows(name)[merge.s.r]?.[merge.s.c] || '' : value;
    });
  };
  block('电气关键设备参数表', {
    parameterCol: 1,
    valueCols: [2, 3, 4, 5, 6],
    start: 3,
    headers: headers('电气关键设备参数表', 2),
    section: cleanHeading(headers('电气关键设备参数表', 1)[1]) || '额定电流',
  });
  block('中压逻辑时间', {
    parameterCol: 0,
    valueCols: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    start: 3,
    headers: headers('中压逻辑时间', 2),
    section: '逻辑时间',
    sectionHeaders: mergedHeaders('中压逻辑时间', 1),
  });
  for (const [groupCol, parameterCol, valueCols, location] of [
    [1, 2, [3, 4, 5, 6, 7], '300K UPS'],
    [8, 9, [10, 11, 12, 13, 14], '400K UPS'],
  ])
    block('UPS', {
      groupCol,
      parameterCol,
      valueCols,
      start: 2,
      headers: headers('UPS', 1),
      location,
    });
  block('HVDC', {
    groupCol: 0,
    parameterCol: 1,
    valueCols: [2, 3, 4, 5, 6],
    headers: headers('HVDC', 1),
  });
  block('直流屏', {
    parameterCol: 0,
    valueCols: [1, 2, 3, 4, 5, 6, 7],
    start: 3,
    end: 34,
    buildingOverride: {
      1: 'A',
      2: 'A',
      3: 'A',
      4: 'B',
      5: 'B',
      6: 'B',
      7: 'B',
    },
    headers: headers('直流屏', 2),
    brands: headers('直流屏', 3),
    inferUnnamed: true,
  });
  block('直流屏', {
    parameterCol: 9,
    valueCols: [10, 11, 12],
    start: 3,
    end: 77,
    headers: headers('直流屏', 2),
    brands: headers('直流屏', 3),
  });
  for (const [groupCol, parameterCol, valueCols] of [
    [14, 15, [16, 17, 18]],
    [20, 21, [22, 23, 24, 25]],
  ])
    block('直流屏', {
      groupCol,
      parameterCol,
      valueCols,
      start: 3,
      end: 77,
      headers: headers('直流屏', 2),
      brands: headers('直流屏', 3),
    });
  const heater = getRows('柴发机组电加热');
  for (let col = 0; col < 4; col++)
    for (const building of col === 0
      ? ['A楼', 'B楼']
      : [`${['', 'C', 'D', 'E'][col]}楼`])
      if (heater[0]?.[col])
        add('柴发机组电加热', 1, col, {
          parameter: '水套加热温度',
          section: '',
          building,
          location: heater[0]?.[col] || '',
          note: '',
        });
  block('ATS', {
    parameterCol: 0,
    valueCols: [1, 2, 3, 4, 5],
    start: 2,
    end: 8,
    headers: headers('ATS', 1),
    location: 'H型控制器',
  });
  block('ATS', {
    parameterCol: 8,
    valueCols: [9, 10, 11, 12],
    start: 2,
    end: 8,
    headers: headers('ATS', 1),
    location: 'L5型控制器',
  });
  for (const [col, location] of [
    [13, 'GE ATS'],
    [14, 'ABB ATS'],
  ])
    block('ATS', {
      parameterCol: 8,
      valueCols: [col],
      start: 2,
      end: 8,
      headers: headers('ATS', 1),
      location,
    });
  const ats = getRows('ATS');
  for (const [start, section] of [
    [11, '1#-3#二次泵ATS'],
    [19, '4#-6#二次泵ATS'],
  ])
    for (let row = start; row < start + 7; row++)
      if (ats[row]?.[4])
        add('ATS', row, 4, {
          parameter: ats[row - start + 2]?.[0] || `未标注参数 · 第${row + 1}行`,
          section,
          building: 'D楼',
          location: section,
          note: String(ats[row]?.[5] || ''),
        });
  for (const [parameterCol, valueCols, location] of [
    [0, [1, 2, 3, 4, 5], '冷塔'],
    [8, [9, 10, 11, 12, 13], '冷冻一次泵'],
    [15, [16, 17, 18, 19, 20], '冷却水泵'],
  ])
    block('变频器', {
      parameterCol,
      valueCols,
      location,
      start: 2,
      headers: headers('变频器', 0),
      sectionLabels: ['1.3修改的参数'],
    });
  const transformers = getRows('变压器');
  for (let row = 1; row < 12; row++) {
    if (transformers[row]?.[1])
      for (const building of transformerSharedBuildings.length
        ? transformerSharedBuildings
        : [''])
        add(
          '变压器',
          row,
          3,
          {
            parameter: transformers[row][1],
            section: '',
            building,
            location: building ? '' : '原表D列',
            note: [building ? '' : '原表未标明楼栋', transformers[row][2]]
              .filter(Boolean)
              .join('\n'),
          },
          '',
          transformers[row][2]
            ? { noteCell: XLSX.utils.encode_cell({ r: row, c: 2 }) }
            : {},
        );
    for (const [parameterCol, col, building] of [
      [6, 7, 'D楼'],
      [10, 11, 'E楼'],
    ])
      if (transformers[row]?.[parameterCol])
        add('变压器', row, col, {
          parameter: transformers[row][parameterCol],
          section: row < 5 ? '施耐德变压器' : '金盘变压器',
          building,
          location: '',
          note: '',
        });
  }
  for (const name of ['交流列头柜', '直流列头柜'])
    block(name, {
      parameterCol: 1,
      valueCols: name === '交流列头柜' ? [2, 4, 6, 8] : [2, 4, 6, 8, 10],
      start: 1,
      headers: headers(name, 0),
      inferUnnamed: true,
      paired: true,
      trailingNotes: true,
    });
  block('燃油控制系统', {
    parameterCol: 0,
    valueCols: [2, 3, 4, 5, 6],
    start: 1,
    headers: headers('燃油控制系统', 0),
    codeCol: 1,
  });
  block('SVG', {
    parameterCol: 1,
    valueCols: [2, 3, 4, 5],
    start: 2,
    headers: headers('SVG', 0),
    location: '一层',
    sectionLabels: ['通讯参数'],
  });
  block('SVG', {
    parameterCol: 7,
    valueCols: [8, 9, 10, 11],
    start: 2,
    headers: headers('SVG', 0),
    location: '二三四层',
    sectionLabels: ['通讯参数'],
  });
  block('SVG', {
    parameterCol: 12,
    valueCols: [13],
    start: 2,
    buildingOverride: { 13: 'E' },
    location: 'E楼',
  });
  return {
    schema: 1,
    records,
    audit: {
      sheets: book.SheetNames,
      counts: Object.fromEntries(
        book.SheetNames.map((name) => [
          name,
          records.filter((r) => r.device === name).length,
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
  const [input, output, overrides] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      '用法：node scripts/import-electrical-thresholds.mjs <xlsx> <seed.json>',
    );
  const book = XLSX.readFile(input, { cellNF: true });
  const options = overrides
    ? JSON.parse((await import('node:fs')).readFileSync(overrides, 'utf8'))
    : {};
  const result = convertElectricalWorkbook(book, options);
  result.sourceSha256 = createHash('sha256')
    .update((await import('node:fs')).readFileSync(input))
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
