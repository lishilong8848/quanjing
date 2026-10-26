import {
  MONTHLY_RESOURCE_BUILDINGS,
  type MonthlyEnergyBuilding,
  type MonthlyEnergyMetric,
  type MonthlyOperationsResourcesResponse,
} from '@shared/monthly-operations-resources.interface';
import type { BuildingFilter } from './model';
import type { MonthlyWaterMetric } from '@shared/monthly-operations-resources.interface';
export type ResourceMetric =
  | MonthlyEnergyMetric
  | MonthlyWaterMetric
  | 'wetBulb';
export const WATER_METRICS: MonthlyWaterMetric[] = [
  'water',
  'waterEast',
  'waterWest',
  'wue',
];
export function isWaterMetric(
  metric: ResourceMetric,
): metric is MonthlyWaterMetric {
  return WATER_METRICS.includes(metric as MonthlyWaterMetric);
}
export function resourceSource(metric: ResourceMetric) {
  return isWaterMetric(metric)
    ? 'water'
    : metric === 'wetBulb'
      ? 'weather'
      : 'energy';
}
export const RESOURCE_METRICS: Record<
  ResourceMetric,
  { label: string; unit: string; precision: number }
> = {
  water: { label: '用水总量', unit: 'm³', precision: 1 },
  waterEast: { label: '东区用水量', unit: 'm³', precision: 1 },
  waterWest: { label: '西区用水量', unit: 'm³', precision: 1 },
  wue: { label: 'WUE', unit: 'L/kWh', precision: 2 },
  pue: { label: 'PUE', unit: 'PUE', precision: 3 },
  total: { label: '总用电量', unit: 'kWh', precision: 0 },
  it: { label: 'IT 用电量', unit: 'kWh', precision: 0 },
  nonIt: { label: '非 IT 用电量', unit: 'kWh', precision: 0 },
  cooling: { label: '冷源用电量', unit: 'kWh', precision: 0 },
  terminal: { label: '末端空调用电量', unit: 'kWh', precision: 0 },
  auxiliary: { label: '辅助用电量', unit: 'kWh', precision: 0 },
  wetBulb: { label: '室外湿球温度', unit: '℃', precision: 1 },
};
export const ENERGY_BUILDINGS: MonthlyEnergyBuilding[] = [
  '园区',
  ...MONTHLY_RESOURCE_BUILDINGS,
];
export const BUILDING_COLORS = {
  园区: 'var(--mo-blue-deep)',
  A楼: 'var(--mo-blue)',
  B楼: 'var(--mo-amber)',
  C楼: 'var(--mo-teal)',
  D楼: 'var(--mo-violet)',
  E楼: 'var(--mo-sky)',
};
export interface PueBaselineReference {
  key: 'abc' | 'd';
  label: string;
  value: number;
}
export interface PueAnnualComparison {
  baseline: number | null;
  delta: number | null;
  percent: number | null;
  status: 'within' | 'above' | 'unrated';
  text: string;
}
export function pueAnnualComparison(
  building: MonthlyEnergyBuilding,
  value: number | null,
): PueAnnualComparison {
  if (value === null)
    return {
      baseline: null,
      delta: null,
      percent: null,
      status: 'unrated',
      text: '年度 PUE 暂无数据',
    };
  const baseline =
    building === 'D楼'
      ? 1.4
      : ['园区', 'A楼', 'B楼', 'C楼'].includes(building)
        ? 1.19
        : null;
  if (baseline === null)
    return {
      baseline: null,
      delta: null,
      percent: null,
      status: 'unrated',
      text: '暂无年度基线',
    };
  const delta = Number((value - baseline).toFixed(3));
  const percent = (delta / baseline) * 100;
  if (delta > 0)
    return {
      baseline,
      delta,
      percent,
      status: 'above',
      text: `高于基线 ${delta.toFixed(3)}（+${percent.toFixed(1)}%），未达标`,
    };
  if (delta < 0)
    return {
      baseline,
      delta,
      percent,
      status: 'within',
      text: `低于基线 ${Math.abs(delta).toFixed(3)}（${percent.toFixed(1)}%），达标`,
    };
  return {
    baseline,
    delta,
    percent,
    status: 'within',
    text: '与基线持平，达标',
  };
}
export function defaultResourceTrendWindow(period: { mode: string }) {
  return period.mode === 'year' ? ('period' as const) : ('recent' as const);
}
export function pueBaselineReferences(
  buildings: MonthlyEnergyBuilding[],
): PueBaselineReference[] {
  const references: PueBaselineReference[] = [];
  const hasAbc = buildings.some((building) =>
    ['园区', 'A楼', 'B楼', 'C楼'].includes(building),
  );
  if (hasAbc)
    references.push({
      key: 'abc',
      label: buildings.length === 1 ? '年度基线' : 'A–C 年度基线',
      value: 1.19,
    });
  if (buildings.includes('D楼'))
    references.push({
      key: 'd',
      label: buildings.length === 1 ? '年度基线' : 'D楼年度基线',
      value: 1.4,
    });
  return references;
}
export function energyBuilding(
  building: BuildingFilter,
): MonthlyEnergyBuilding | null {
  if (building === 'all') return '园区';
  return ENERGY_BUILDINGS.includes(building as MonthlyEnergyBuilding)
    ? (building as MonthlyEnergyBuilding)
    : null;
}
export interface ResourceTrendRow {
  name: string;
  [key: string]: number | string | null;
}
export function pueComparisonAxes(
  rows: ResourceTrendRow[],
  buildings: MonthlyEnergyBuilding[],
) {
  const primary = buildings.filter((building) => building !== 'E楼');
  if (!buildings.includes('E楼') || !primary.length)
    return { primary: buildings, secondary: null };
  const values = (names: MonthlyEnergyBuilding[]) =>
    rows.flatMap((row) =>
      names.flatMap((name) => {
        const value = row[name];
        return typeof value === 'number' && Number.isFinite(value)
          ? [value]
          : [];
      }),
    );
  const main = values(primary);
  const outlier = values(['E楼']);
  if (!main.length || !outlier.length)
    return { primary: buildings, secondary: null };
  const mainMin = Math.min(...main);
  const mainMax = Math.max(...main);
  const margin = Math.max(0.04, (mainMax - mainMin) * 0.6);
  return Math.min(...outlier) > mainMax + margin ||
    Math.max(...outlier) < mainMin - margin
    ? { primary, secondary: 'E楼' as const }
    : { primary: buildings, secondary: null };
}
export function pueWithWetBulb(
  rows: ResourceTrendRow[],
  weatherRows: ResourceTrendRow[],
  building: MonthlyEnergyBuilding,
) {
  const weatherByDate = new Map(
    weatherRows.map((row) => [row.name, row[building]]),
  );
  return rows.map((row) => {
    const temperature = weatherByDate.get(row.name);
    return {
      ...row,
      wetBulb:
        typeof temperature === 'number' && Number.isFinite(temperature)
          ? temperature
          : null,
    };
  });
}
function metricPoints(
  data: MonthlyOperationsResourcesResponse,
  metric: ResourceMetric,
  weighted: boolean,
) {
  if (metric === 'wetBulb')
    return data.weather.days.map((day) => ({
      date: day.date,
      building: day.building,
      value: day.value,
      weight: 1,
    }));
  if (isWaterMetric(metric))
    return data.water.days.map((day) => ({
      date: day.date,
      building: day.building,
      value: day[metric],
      weight: metric === 'wue' && weighted ? day.wueWeight : 1,
    }));
  return data.energy.days.map((day) => ({
    date: day.date,
    building: day.building,
    value: day[metric],
    weight: metric === 'pue' && weighted ? day.pueWeight : 1,
  }));
}
export function resourceTrend(
  data: MonthlyOperationsResourcesResponse | null,
  metric: ResourceMetric,
  start: string,
  end: string,
  grain: 'day' | 'month',
): ResourceTrendRow[] {
  if (!data) return [];
  const points = metricPoints(data, metric, grain === 'month');
  const buckets = new Map<
    string,
    Map<string, { value: number; weight: number }[]>
  >();
  for (const point of points) {
    if (point.date < start || point.date > end) continue;
    const label = grain === 'month' ? point.date.slice(0, 7) : point.date;
    if (!buckets.has(label)) buckets.set(label, new Map());
    const buildings = buckets.get(label)!;
    if (!buildings.has(point.building)) buildings.set(point.building, []);
    if (point.value !== null && point.weight !== null && point.weight > 0)
      buildings
        .get(point.building)!
        .push({ value: point.value, weight: point.weight });
  }
  return [...buckets]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, buildings]) =>
        Object.fromEntries([
          ['name', name],
          ...ENERGY_BUILDINGS.map((building) => {
            const values = buildings.get(building) ?? [];
            const value = !values.length
              ? null
              : metric === 'pue' || metric === 'wue' || metric === 'wetBulb'
                ? values.reduce((sum, row) => sum + row.value * row.weight, 0) /
                  values.reduce((sum, row) => sum + row.weight, 0)
                : values.reduce((sum, row) => sum + row.value, 0);
            return [building, value];
          }),
        ]) as ResourceTrendRow,
    );
}
export function resourceValue(
  data: MonthlyOperationsResourcesResponse | null,
  metric: ResourceMetric,
  building: BuildingFilter,
) {
  if (!data) return null;
  const selected = energyBuilding(building);
  if (!selected) return null;
  const points = metricPoints(data, metric, true)
    .filter(
      (day) =>
        day.building === selected &&
        day.date >= data.range.start &&
        day.date <= data.range.asOf,
    )
    .map((day) => ({ value: day.value, weight: day.weight }));
  const valid = points.filter(
    (point): point is { value: number; weight: number } =>
      point.value !== null && point.weight !== null && point.weight > 0,
  );
  if (!valid.length) return null;
  return metric === 'pue' || metric === 'wue' || metric === 'wetBulb'
    ? valid.reduce((sum, point) => sum + point.value * point.weight, 0) /
        valid.reduce((sum, point) => sum + point.weight, 0)
    : valid.reduce((sum, point) => sum + point.value, 0);
}
export function rackSummary(
  data: MonthlyOperationsResourcesResponse | null,
  building: BuildingFilter,
) {
  const rows =
    data?.racks.rows.filter(
      (row) => building === 'all' || row.building === building,
    ) ?? [];
  const complete = building === 'all' ? rows.length === 5 : rows.length === 1;
  const capacity = rows.reduce((sum, row) => sum + row.capacity, 0),
    online = rows.reduce((sum, row) => sum + row.online, 0);
  return {
    rows,
    capacity: complete ? capacity : null,
    online: complete ? online : null,
    rate: complete && capacity > 0 ? (online / capacity) * 100 : null,
    available: complete ? capacity - online : null,
  };
}
export function rackLoadRows(
  data: MonthlyOperationsResourcesResponse | null,
  building: BuildingFilter,
) {
  const loads = new Map(
    data?.load.rows.map((row) => [row.building, row.value]),
  );
  return rackSummary(data, building).rows.map((row) => ({
    ...row,
    loadRate: loads.get(row.building) ?? null,
  }));
}
export function resourceCoverage(
  data: MonthlyOperationsResourcesResponse | null,
  metric: ResourceMetric,
  building: BuildingFilter,
) {
  if (!data) return '';
  const selected = energyBuilding(building);
  const points = metricPoints(data, metric, true).filter(
    (day) =>
      day.building === selected &&
      day.date >= data.range.start &&
      day.date <= data.range.asOf,
  );
  const valid = points.filter(
    (day) => day.value !== null && day.weight !== null && day.weight > 0,
  ).length;
  return `有效 ${valid}/${points.length} 天`;
}
