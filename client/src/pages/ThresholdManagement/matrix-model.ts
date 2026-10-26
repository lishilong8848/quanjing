import type { ThresholdRecord } from '@shared/threshold-management.interface';
import { normalizeThresholdEquipment } from '@shared/threshold-equipment';
import { buildThresholdComparisonGroups } from './comparison-groups';

export interface MatrixColumn {
  key: string;
  building: string;
  location: string;
}
export interface MatrixRow {
  key: string;
  section: string;
  parameter: string;
  unit: string;
  kind: string;
  origin: string;
  cells: Record<string, ThresholdRecord>;
  different: boolean;
  emphasizedIds: string[];
}
const buildingOrder = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
  '待核对',
];
function columnLocation(record: ThresholdRecord) {
  record = normalizeThresholdEquipment(record);
  let location = [
    record.location,
    record.model &&
      `${record.model}${record.brand ? `（${record.brand}）` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ')
    .trim();
  if (!location && !record.building && record.source)
    location = `原表${record.source.cell.replace(/\d+$/, '')}列`;
  if (!record.building) return location;
  if (
    location === record.building ||
    location === record.building.replace('楼', '') ||
    /^(?:[A-EH]、)*[A-EH]楼$/.test(location)
  )
    return '';
  location = location.split(record.building).join('');
  const letter = record.building.match(/^([A-EH])楼$/)?.[1];
  if (letter) location = location.replace(new RegExp(`^${letter}[-－]`), '');
  return location.replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, '').trim();
}
function comparableValue(value: string) {
  const text = value.trim();
  const numeric = text.match(/^([+-]?)(\d+)(?:\.(\d+))?\s*(%?)$/);
  if (!numeric) return text;
  const integer = numeric[2].replace(/^0+(?=\d)/, '');
  const fraction = (numeric[3] || '').replace(/0+$/, '');
  const sign = numeric[1] === '-' && (integer !== '0' || fraction) ? '-' : '';
  return `${sign}${integer}${fraction ? '.' + fraction : ''}${numeric[4]}`;
}
export function matrixSectionLabel(row: MatrixRow) {
  const records = Object.values(row.cells);
  if (
    records.length &&
    records.every((record) => {
      const equipment = normalizeThresholdEquipment(record);
      return (
        equipment.brand &&
        [equipment.brand, equipment.brand + equipment.device].includes(
          row.section,
        )
      );
    })
  )
    return '';
  return row.section;
}
export function buildThresholdMatrix(
  records: ThresholdRecord[],
  minimumBuildings: readonly string[] = [],
) {
  const comparisonKeys = new Map<string, number>();
  buildThresholdComparisonGroups(records).forEach((group, index) => {
    group.records.forEach((record) => comparisonKeys.set(record.id, index));
  });
  const columns = new Map<string, MatrixColumn>();
  const buckets = new Map<string, MatrixRow[]>();
  const rows: MatrixRow[] = [];
  const ordered = [...records].sort((a, b) => {
    if (!a.source || !b.source)
      return !a.source === !b.source ? 0 : a.source ? 1 : -1;
    return (
      Number(a.source.cell.match(/\d+$/)?.[0] || 0) -
      Number(b.source.cell.match(/\d+$/)?.[0] || 0)
    );
  });
  for (const record of ordered) {
    const building = record.building || '待核对';
    const location = columnLocation(record);
    const equipment = normalizeThresholdEquipment(record);
    const columnKey = JSON.stringify([
      building,
      location,
      equipment.model || '',
      equipment.brand || '',
    ]);
    columns.set(columnKey, { key: columnKey, building, location });
    const signature = JSON.stringify([
      comparisonKeys.get(record.id),
      record.device,
      record.section,
      record.parameter,
      record.unit,
    ]);
    const origin = record.source
      ? `${record.source.sheet}:${(record.source.parameterCell || record.source.cell).match(/\d+$/)?.[0] || record.source.cell}`
      : '';
    const bucket = buckets.get(signature) || [];
    let row = bucket.find((candidate) => !candidate.cells[columnKey]);
    if (!row) {
      row = {
        key: `${signature}:${origin}:${bucket.length}`,
        section: record.section,
        parameter: record.parameter,
        unit: record.unit,
        kind: record.kind,
        origin,
        cells: {},
        different: false,
        emphasizedIds: [],
      };
      bucket.push(row);
      buckets.set(signature, bucket);
      rows.push(row);
    }
    row.origin ||= origin;
    row.cells[columnKey] = record;
  }
  for (const row of rows) {
    const kinds = new Set(
      Object.values(row.cells).map((record) => record.kind),
    );
    if (kinds.size > 1) row.kind = '多类型';
    const values = new Map<string, number>();
    for (const record of Object.values(row.cells)) {
      const value = comparableValue(record.value);
      if (value && value !== '/')
        values.set(value, (values.get(value) || 0) + 1);
    }
    row.different = values.size > 1;
    const maximum = Math.max(0, ...values.values());
    const common = [...values].filter(([, count]) => count === maximum);
    if (row.different && maximum > 1 && common.length === 1) {
      row.emphasizedIds = Object.values(row.cells)
        .filter((record) => {
          const value = comparableValue(record.value);
          return value && value !== '/' && value !== common[0][0];
        })
        .map((record) => record.id);
    }
  }
  for (const building of minimumBuildings) {
    if (![...columns.values()].some((column) => column.building === building)) {
      const key = JSON.stringify([building, '', '', '']);
      columns.set(key, { key, building, location: '' });
    }
  }
  return {
    columns: [...columns.values()].sort((a, b) => {
      const rank = (name: string) =>
        buildingOrder.indexOf(name) < 0
          ? buildingOrder.length
          : buildingOrder.indexOf(name);
      return (
        rank(a.building) - rank(b.building) ||
        a.building.localeCompare(b.building, 'zh-CN') ||
        a.location.localeCompare(b.location, 'zh-CN', { numeric: true })
      );
    }),
    rows,
  };
}
