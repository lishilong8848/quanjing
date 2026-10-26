import { resolvePeriod, type PeriodSelection } from './period';
export { DEMO_MONTHS, DEMO_AS_OF } from './period';
export const BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
] as const;
export type Building = (typeof BUILDINGS)[number];
export type BuildingFilter = Building | 'all';
export type WorkKind =
  | 'event'
  | 'change'
  | 'drill'
  | 'maintenance'
  | 'alarm'
  | 'risk'
  | 'inspection';
export type WorkStatus = 'done' | 'active' | 'pending' | 'overdue';
export type Topic =
  | 'overview'
  | 'capacity'
  | 'energy'
  | 'events'
  | 'changes'
  | 'assurance'
  | 'alarms'
  | 'assessment';
export const KIND_LABELS: Record<WorkKind, string> = {
  event: '事件',
  change: '变更',
  drill: '演练',
  maintenance: '维护',
  alarm: '告警',
  risk: '风险排查',
  inspection: '巡检异常',
};
export const STATUS_LABELS: Record<WorkStatus, string> = {
  done: '已完成',
  active: '进行中',
  pending: '未开始',
  overdue: '已逾期',
};
export interface WorkRecord {
  id: string;
  kind: WorkKind;
  building: Building;
  title: string;
  date: string;
  status: WorkStatus;
  specialty: string;
  source: string;
  level: string;
  owner: string;
  score: number | null;
  recovered: boolean;
}
export interface ResourceBuilding {
  building: Building;
  racks: number;
  online: number;
  poweredOn: number;
  poweredOff: number;
  load: number;
  pue: number;
  dailyIt: number;
  dailyWater: number;
  waterReserve: number;
  fuelReserve: number;
  backupHours: number;
}
export interface DailyResource {
  day: string;
  total: number;
  it: number;
  nonIt: number;
  cooling: number;
  terminal: number;
  auxiliary: number;
  water: number;
  drainage: number;
  pue: number;
  wue: number;
  wetBulb: number;
}
export interface MonthlyData {
  month: string;
  asOf: string;
  resources: ResourceBuilding[];
  records: WorkRecord[];
}
export interface DetailSelection {
  demo?: boolean;
  metric?: import('./resource-model').ResourceMetric;
  title: string;
  id?: string;
  resource?: 'capacity' | 'energy' | 'water' | 'reserve' | 'load';
  kind?: WorkKind;
  status?: WorkStatus | 'unfinished';
  building?: Building;
  source?: string;
  date?: string;
  level?: string;
  specialty?: string;
  recovered?: boolean;
}
export function percentage(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}
export function previousMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return number === 1
    ? `${year - 1}-12`
    : `${year}-${String(number - 1).padStart(2, '0')}`;
}
export function filterRecords(
  records: WorkRecord[],
  selection: Omit<DetailSelection, 'title'>,
  search = '',
): WorkRecord[] {
  const query = search.trim().toLocaleLowerCase();
  return records.filter(
    (item) =>
      (!selection.id || item.id === selection.id) &&
      (!selection.kind || item.kind === selection.kind) &&
      (!selection.building || item.building === selection.building) &&
      (!selection.source || item.source === selection.source) &&
      (!selection.date || item.date === selection.date) &&
      (!selection.level || item.level === selection.level) &&
      (!selection.specialty || item.specialty === selection.specialty) &&
      (selection.recovered === undefined ||
        item.recovered === selection.recovered) &&
      (!selection.status ||
        (selection.status === 'unfinished'
          ? item.status !== 'done'
          : item.status === selection.status)) &&
      (!query ||
        [item.id, item.title, item.building, item.specialty, item.owner]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query)),
  );
}
export function buildMonthlyView(data: MonthlyData, building: BuildingFilter) {
  return buildPeriodView(
    [data],
    { mode: 'month', month: data.month },
    building,
  );
}

function dailyResources(
  data: MonthlyData,
  building: BuildingFilter,
): DailyResource[] {
  // Keep each building's variation stable when filtering it out of a campus view.
  const resources = data.resources
    .map((item, site) => ({ item, site }))
    .filter(({ item }) => building === 'all' || item.building === building);
  const days = Number(data.asOf.slice(-2));
  return resources.length
    ? Array.from({ length: days }, (_, index) => {
        const day = index + 1;
        let it = 0,
          total = 0,
          water = 0;
        resources.forEach(({ item, site }) => {
          const variation =
            1 +
            Math.sin(day * 0.64 + site) * 0.035 +
            Math.cos(day * 0.27) * 0.018;
          const dailyIt = Math.round(item.dailyIt * variation);
          it += dailyIt;
          total += Math.round(
            dailyIt * (item.pue + Math.sin(day * 0.48) * 0.012 - day * 0.0006),
          );
          water += Math.round(
            item.dailyWater * variation * (1 + Math.sin(day * 0.33) * 0.06),
          );
        });
        const nonIt = total - it;
        const cooling = Math.round(nonIt * 0.72);
        const terminal = Math.round(nonIt * 0.19);
        return {
          day: `${data.month}-${String(day).padStart(2, '0')}`,
          total,
          it,
          nonIt,
          cooling,
          terminal,
          auxiliary: nonIt - cooling - terminal,
          water,
          drainage: Math.round(water * 0.065),
          pue: total / it,
          wue: (water * 1000) / it,
          wetBulb: 27.4 + Math.sin(day * 0.42) * 2.2 - day * 0.13,
        };
      })
    : [];
}

export function aggregateResourceTrend(
  daily: DailyResource[],
  grain: 'day' | 'month',
): DailyResource[] {
  if (grain === 'day') return daily;
  const groups = new Map<string, DailyResource[]>();
  daily.forEach((day) => {
    const key = day.day.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), day]);
  });
  return Array.from(groups, ([month, rows]) => {
    const sum = (key: keyof Omit<DailyResource, 'day'>) =>
      rows.reduce((value, day) => value + day[key], 0);
    const total = sum('total'),
      it = sum('it'),
      water = sum('water');
    return {
      day: month,
      total,
      it,
      water,
      nonIt: sum('nonIt'),
      cooling: sum('cooling'),
      terminal: sum('terminal'),
      auxiliary: sum('auxiliary'),
      drainage: sum('drainage'),
      pue: total / it,
      wue: (water * 1000) / it,
      wetBulb: sum('wetBulb') / rows.length,
    };
  });
}

export function buildPeriodView(
  data: MonthlyData[],
  selection: PeriodSelection,
  building: BuildingFilter,
) {
  const period = resolvePeriod(selection);
  const months = data
    .filter(
      (item) =>
        item.month >= period.start.slice(0, 7) &&
        item.month <= period.asOf.slice(0, 7),
    )
    .sort((a, b) => a.month.localeCompare(b.month));
  const latest = months.at(-1);
  const activities = new Map<Building, { on: number; off: number }>();
  months.forEach((month) => {
    const days = Number(month.asOf.slice(-2));
    const startDay =
      month.month === period.start.slice(0, 7)
        ? Number(period.start.slice(-2))
        : 1;
    const endDay =
      month.month === period.asOf.slice(0, 7)
        ? Number(period.asOf.slice(-2))
        : days;
    month.resources.forEach((item) => {
      const previous = activities.get(item.building) ?? { on: 0, off: 0 };
      // Integer cumulative movements make adjacent date ranges additive.
      const movement = (total: number) =>
        Math.floor((total * endDay) / days) -
        Math.floor((total * (startDay - 1)) / days);
      activities.set(item.building, {
        on: previous.on + movement(item.poweredOn),
        off: previous.off + movement(item.poweredOff),
      });
    });
  });
  const resources = (latest?.resources ?? [])
    .filter((item) => building === 'all' || item.building === building)
    .map((item) => {
      const fraction =
        Number(period.asOf.slice(-2)) / Number(latest!.asOf.slice(-2));
      return {
        ...item,
        online:
          item.online -
          (item.poweredOn - Math.floor(item.poweredOn * fraction)) +
          (item.poweredOff - Math.floor(item.poweredOff * fraction)),
        poweredOn: activities.get(item.building)?.on ?? 0,
        poweredOff: activities.get(item.building)?.off ?? 0,
      };
    });
  const records = months
    .flatMap((item) => item.records)
    .filter(
      (item) =>
        (building === 'all' || item.building === building) &&
        item.date >= period.start &&
        item.date <= period.end,
    );
  const daily = months
    .flatMap((item) => dailyResources(item, building))
    .filter((day) => day.day >= period.start && day.day <= period.asOf);
  const sum = (
    key:
      | 'racks'
      | 'online'
      | 'poweredOn'
      | 'poweredOff'
      | 'waterReserve'
      | 'fuelReserve',
  ) => resources.reduce((value, item) => value + item[key], 0);
  const totalEnergy = daily.reduce((sum, day) => sum + day.total, 0);
  const itEnergy = daily.reduce((sum, day) => sum + day.it, 0);
  const water = daily.reduce((sum, day) => sum + day.water, 0);
  const kinds = Object.fromEntries(
    Object.keys(KIND_LABELS).map((kind) => {
      const items = records.filter((item) => item.kind === kind);
      const done = items.filter((item) => item.status === 'done').length;
      return [
        kind,
        {
          total: items.length,
          done,
          active: items.filter((item) => item.status === 'active').length,
          overdue: items.filter((item) => item.status === 'overdue').length,
          rate: percentage(done, items.length),
        },
      ];
    }),
  ) as Record<
    WorkKind,
    {
      total: number;
      done: number;
      active: number;
      overdue: number;
      rate: number;
    }
  >;
  return {
    month: period.asOf.slice(0, 7),
    asOf: period.asOf,
    period,
    building,
    trend: aggregateResourceTrend(daily, period.grain),
    resources,
    records,
    daily,
    kinds,
    totalEnergy,
    itEnergy,
    water,
    pue: itEnergy ? totalEnergy / itEnergy : null,
    wue: itEnergy ? (water * 1000) / itEnergy : null,
    racks: sum('racks'),
    online: sum('online'),
    rackRate: percentage(sum('online'), sum('racks')),
    poweredOn: sum('poweredOn'),
    poweredOff: sum('poweredOff'),
    waterReserve: sum('waterReserve'),
    fuelReserve: sum('fuelReserve'),
  };
}
export type MonthlyView = ReturnType<typeof buildPeriodView>;
export function groupRecords(
  records: WorkRecord[],
  field: 'building' | 'source' | 'specialty' | 'status',
) {
  const groups = new Map<string, number>();
  records.forEach((item) =>
    groups.set(item[field], (groups.get(item[field]) ?? 0) + 1),
  );
  return Array.from(groups, ([name, value]) => ({
    name: field === 'status' ? STATUS_LABELS[name as WorkStatus] : name,
    key: name,
    value,
  }));
}
export const numberFormat = (value: number, digits = 0) =>
  value.toLocaleString('zh-CN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
