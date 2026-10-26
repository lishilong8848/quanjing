import {
  buildThresholdMatrix,
  matrixSectionLabel,
} from '../../client/src/pages/ThresholdManagement/matrix-model';
import type { ThresholdRecord } from '../../shared/threshold-management.interface';
import seed from '../../shared/electrical-thresholds.seed.json';
import hvac from '../../shared/hvac-thresholds.seed.json';
import { buildThresholdComparisonGroups } from '../../client/src/pages/ThresholdManagement/comparison-groups';

test('变频器清单显示共同设备类型，保留五栋楼和全部设定值', () => {
  const groups = buildThresholdComparisonGroups(
    (seed.records as ThresholdRecord[]).filter((r) => r.device === '变频器'),
  );
  expect(groups.map((g) => [g.label, g.records.length])).toEqual([
    ['冷塔', 255],
    ['冷冻一次泵', 245],
    ['冷却水泵', 130],
  ]);
  for (const group of groups)
    expect(group.buildings).toEqual(['A楼', 'B楼', 'C楼', 'D楼', 'E楼']);
});

test('SVG按楼层命名清单，不重复列举每栋楼的位置', () => {
  const groups = buildThresholdComparisonGroups(
    (seed.records as ThresholdRecord[]).filter((r) => r.device === 'SVG'),
  );
  expect(groups.map((g) => [g.label, g.records.length])).toEqual([
    ['一层', 312],
    ['二三四层', 304],
    ['E楼', 7],
  ]);
});

test('型号已包含品牌时标签不重复，水泵先显示用途并保留型号', () => {
  const ats = buildThresholdComparisonGroups(
    (seed.records as ThresholdRecord[]).filter((r) => r.device === 'ATS'),
  );
  expect(ats.map((g) => g.label)).toContain('GE ATS');
  expect(ats.map((g) => g.label)).toContain('ABB ATS');
  const pumps = buildThresholdComparisonGroups(
    (hvac.records as ThresholdRecord[]).filter((r) => r.device === '水泵'),
  );
  expect(pumps.map((g) => [g.label, g.records.length])).toEqual([
    ['一次泵 · HSC-S 10*12*12', 125],
    ['二次泵 · HSC-S 10*12*12', 125],
    ['冷却泵 · HSC-S 10*12*14', 125],
  ]);
});

test('变压器清单保持A-E楼列头，补列不会创建不存在的设定值，品牌不占参数分组', () => {
  const record = {
    ...make('d', 'D楼', '', '80'),
    device: '变压器',
    brand: '施耐德',
    section: '施耐德变压器',
  };
  const matrix = buildThresholdMatrix(
    [record],
    ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'],
  );
  expect(matrix.columns.map((c) => c.building)).toEqual([
    'A楼',
    'B楼',
    'C楼',
    'D楼',
    'E楼',
  ]);
  expect(Object.values(matrix.rows[0].cells)).toEqual([record]);
  expect(matrixSectionLabel(matrix.rows[0])).toBe('');
});

test('不同品牌不能合并同名参数或互相计算差异', () => {
  const matrix = buildThresholdMatrix([
    { ...make('a', 'A楼', '', '110'), brand: '品牌甲' },
    { ...make('b', 'B楼', '', '220'), brand: '品牌乙' },
  ]);
  expect(matrix.rows).toHaveLength(2);
  expect(matrix.rows.every((row) => !row.different)).toBe(true);
});

test('真实直流屏按三套品牌参数结构分开，赛迪生D/E楼仍可比较', () => {
  const groups = buildThresholdComparisonGroups(
    (seed.records as ThresholdRecord[]).filter((r) => r.device === '直流屏'),
  );
  expect(groups.map((g) => [g.label, g.records.length])).toEqual([
    ['五三通', 224],
    ['上海时待', 198],
    ['赛迪生', 525],
  ]);
  expect(groups[2].buildings.sort()).toEqual(['D楼', 'E楼']);
  expect(buildThresholdMatrix(groups[0].records).rows).toHaveLength(32);
  expect(buildThresholdMatrix(groups[1].records).rows).toHaveLength(66);
  expect(buildThresholdMatrix(groups[2].records).rows).toHaveLength(75);
});

test('同品牌同型号但参数类别不同也分组，重复参数不丢失', () => {
  const records = [
    make('a', 'A楼', '', '1'),
    make('b', 'B楼', '', '1'),
    { ...make('b2', 'B楼', '', '2', 'D5'), parameter: '额外参数' },
  ];
  expect(buildThresholdComparisonGroups(records)).toHaveLength(2);
  expect(
    buildThresholdComparisonGroups(records)
      .flatMap((g) => g.records)
      .map((r) => r.id)
      .sort(),
  ).toEqual(['a', 'b', 'b2']);
});

test('同名清单按楼栋区分，标签精简后不会合并不同参数结构', () => {
  const records = [
    { ...make('a', 'A楼', '冷塔', '1'), brand: '品牌甲', model: 'X' },
    { ...make('b', 'B楼', '冷塔', '1'), brand: '品牌甲', model: 'X' },
    {
      ...make('b2', 'B楼', '冷塔', '2'),
      brand: '品牌甲',
      model: 'X',
      parameter: '额外参数',
    },
  ];
  const groups = buildThresholdComparisonGroups(records);
  expect(groups.map((g) => [g.label, g.records.map((r) => r.id)])).toEqual([
    ['品牌甲 · X · 冷塔 · A楼', ['a']],
    ['品牌甲 · X · 冷塔 · B楼', ['b', 'b2']],
  ]);
});

const make = (
  id: string,
  building: string,
  location: string,
  value: string,
  cell = 'C4',
): ThresholdRecord => ({
  id,
  building,
  location,
  value,
  profession: '电气',
  device: 'UPS',
  section: '输出设定',
  parameter: '输出电压',
  unit: 'V',
  kind: '设定',
  enabled: '',
  note: '',
  version: 1,
  updatedAt: '',
  source: { sheet: 'UPS', cell, originalValue: value },
});
test('同一型号跨楼栋比较，不同型号保持独立参数行', () => {
  const result = buildThresholdMatrix([
    make('a300', 'A楼', '300K UPS · A楼', '220', 'D4'),
    make('b300', 'B楼', '300K UPS · B楼', '230', 'E4'),
    make('a400', 'A楼', '400K UPS · A楼', '220', 'K4'),
    make('b400', 'B楼', '400K UPS · B楼', '220', 'L4'),
  ]);
  expect(result.rows).toHaveLength(2);
  expect(result.columns.map((c) => [c.building, c.location])).toEqual([
    ['A楼', '300K UPS'],
    ['A楼', '400K UPS'],
    ['B楼', '300K UPS'],
    ['B楼', '400K UPS'],
  ]);
  expect(
    result.rows
      .flatMap((row) => Object.values(row.cells))
      .map((r) => r.id)
      .sort(),
  ).toEqual(['a300', 'a400', 'b300', 'b400']);
  expect(result.rows[0].different).toBe(true);
});
test('重复参数和同列重复记录不覆盖，缺楼栋/空白/零值不合并成假值', () => {
  const result = buildThresholdMatrix([
    make('first', 'A楼', 'A-120', '0', 'B4'),
    make('second', 'A楼', 'A-120', '1', 'B5'),
    make('unknown', '', '原表I列', '', 'I4'),
    { ...make('custom', 'A楼', 'A-120', '0'), source: null },
  ]);
  expect(result.rows).toHaveLength(3);
  expect(
    result.columns.some(
      (c) => c.building === '待核对' && c.location === '原表I列',
    ),
  ).toBe(true);
  const records = result.rows.flatMap((r) => Object.values(r.cells));
  expect(records.map((r) => r.id).sort()).toEqual([
    'custom',
    'first',
    'second',
    'unknown',
  ]);
  expect(records.find((r) => r.id === 'first')?.value).toBe('0');
  expect(records.find((r) => r.id === 'unknown')?.value).toBe('');
});
test('只比较同一参数的实际设定值，单位/分组不同的参数保持分行', () => {
  const result = buildThresholdMatrix([
    make('a', 'A楼', 'A楼', '220'),
    make('b', 'B楼', 'B楼', '220'),
    { ...make('c', 'C楼', 'C楼', '220'), unit: 'A' },
    { ...make('d', 'D楼', 'D楼', '220'), section: '旁路设定' },
  ]);
  expect(result.rows).toHaveLength(3);
  expect(result.rows.every((r) => !r.different)).toBe(true);
});

test('同型号不同设备块的同名参数跨原表行号对齐，同列重复参数保留各次出现', () => {
  const threshold = (
    id: string,
    location: string,
    cell: string,
    value: string,
  ) => ({
    ...make(id, 'A楼', location, value, cell),
    device: 'ATS',
    section: '',
    parameter: '阈值设置',
    source: { sheet: 'ATS', cell, originalValue: value },
  });
  const result = buildThresholdMatrix([
    threshold('h1', 'H型控制器 · A-120', 'B6', 'S1欠压310V'),
    threshold('l1', 'H型控制器 · A-144', 'J5', '欠压320V\nT1延时001S'),
    threshold('h2', 'H型控制器 · A-120', 'B8', '第二组H阈值'),
    threshold('l2', 'H型控制器 · A-144', 'J9', '第二组L阈值'),
  ]);
  expect(result.rows).toHaveLength(2);
  expect(
    result.rows.map((row) =>
      Object.values(row.cells)
        .map((r) => r.id)
        .sort(),
    ),
  ).toEqual([
    ['h1', 'l1'],
    ['h2', 'l2'],
  ]);
});
test('真实附件全部记录在矩阵转换后逐条保留，没有丢失或重复', () => {
  const records = seed.records as ThresholdRecord[];
  const devices = [...new Set(records.map((record) => record.device))];
  const converted = devices.flatMap((device) =>
    buildThresholdMatrix(
      records.filter((record) => record.device === device),
    ).rows.flatMap((row) => Object.values(row.cells)),
  );
  expect(converted).toHaveLength(records.length);
  expect(new Set(converted.map((record) => record.id)).size).toBe(
    records.length,
  );
  expect(converted.map((record) => record.id).sort()).toEqual(
    records.map((record) => record.id).sort(),
  );
});

test('位置留空时以独立型号区分同楼栋设备，不能合并300K和400K', () => {
  const result = buildThresholdMatrix([
    { ...make('300', 'A楼', '', '220'), model: '300K UPS' },
    { ...make('400', 'A楼', '', '230'), model: '400K UPS' },
  ]);
  expect(result.columns.map((c) => c.location)).toEqual([
    '300K UPS',
    '400K UPS',
  ]);
  expect(
    result.rows
      .flatMap((row) => Object.values(row.cells))
      .map((r) => r.id)
      .sort(),
  ).toEqual(['300', '400']);
});

test('仅强调偏离唯一多数值的单元格，空白和并列值不形成误导强调', () => {
  const row = (values: string[]) =>
    buildThresholdMatrix(
      values.map((value, index) =>
        make(String(index), `${String.fromCharCode(65 + index)}楼`, '', value),
      ),
    ).rows[0];
  expect(row(['220', '220', '230', '', '/']).emphasizedIds).toEqual(['2']);
  expect(row(['220', '230']).different).toBe(true);
  expect(row(['220', '230']).emphasizedIds).toEqual([]);
  expect(row(['220', '220', '230', '230']).emphasizedIds).toEqual([]);
  expect(row(['0', '0', '1']).emphasizedIds).toEqual(['2']);
  expect(row(['', '/']).different).toBe(false);
  expect(row(['20', '20.00', '020.0']).different).toBe(false);
  expect(row(['90%', '90.00 %']).different).toBe(false);
  expect(row(['-0.00', '0']).different).toBe(false);
  expect(row(['20.00', '20', '21.0']).emphasizedIds).toEqual(['2']);
  expect(row(['20', '20.01']).different).toBe(true);
});
test('暖通12类3788条记录矩阵无丢失，蓄冷罐转置为24参数×10区域', () => {
  const records = hvac.records as ThresholdRecord[];
  expect(records).toHaveLength(3788);
  const devices = [...new Set(records.map((r) => r.device))];
  expect(devices).toHaveLength(12);
  const converted = devices.flatMap((device) =>
    buildThresholdMatrix(
      records.filter((r) => r.device === device),
    ).rows.flatMap((r) => Object.values(r.cells)),
  );
  expect(converted.map((r) => r.id).sort()).toEqual(
    records.map((r) => r.id).sort(),
  );
  const tanks = buildThresholdMatrix(
    records.filter((r) => r.device === '蓄冷罐'),
  );
  expect(tanks.rows).toHaveLength(24);
  expect(tanks.columns).toHaveLength(10);
  expect(
    tanks.columns
      .filter((c) => c.building === 'A楼')
      .map((c) => c.location)
      .sort(),
  ).toEqual(['东区', '西区']);
});

test('真实ATS不同控制器分开且复合值完整保留，HVDC地址字段不替代', () => {
  const records = seed.records as ThresholdRecord[];
  const ats = buildThresholdMatrix(records.filter((r) => r.device === 'ATS'));
  const thresholds = ats.rows.filter(
    (r) => r.parameter === '阈值设置' && r.section === '',
  );
  expect(
    thresholds.every(
      (row) => new Set(Object.values(row.cells).map((r) => r.model)).size === 1,
    ),
  ).toBe(true);
  const controls = thresholds
    .flatMap((row) => Object.values(row.cells))
    .filter((r) => r.building === 'A楼');
  expect(controls.map((r) => r.source?.cell).sort()).toEqual(['B6', 'J5']);
  expect(
    controls.find((r) => r.source?.cell === 'J5')?.value.split('\n'),
  ).toHaveLength(8);
  const hvdc = records.filter((r) => r.device === 'HVDC');
  expect(hvdc.filter((r) => r.parameter === '通讯地址')).toHaveLength(5);
  expect(
    hvdc.filter((r) => r.parameter === '通讯地址').every((r) => r.value === ''),
  ).toBe(true);
  expect(hvdc.filter((r) => r.parameter === 'IP地址')).toHaveLength(5);
  expect(hvdc.filter((r) => r.parameter === '网关')).toHaveLength(5);
});
