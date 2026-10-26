import type {
  MonthlyChange,
  MonthlyChangeState,
} from '@shared/monthly-operations-changes.interface';
import { monthsInRange } from './period';

export const CHANGE_STATES: Record<MonthlyChangeState, string> = {
  done: '已完成',
  cancelled: '已取消',
  failed: '变更失败',
  delayed: '延期中',
  returned: '已退回',
  running: '进行中',
  planned: '未开始',
  pending: '待确认',
};
export const CHANGE_FILTERS = {
  search: '',
  state: '',
  type: '',
  specialty: '',
  level: '',
  date: '',
  risk: '',
};
export type ChangeFilters = typeof CHANGE_FILTERS;
export function isVisibleChange(row: MonthlyChange) {
  return (
    !['cancelled', 'returned'].includes(row.state) &&
    ![row.progress, row.result].some((value) =>
      /^(?:已|变更)?(?:取消|退回|驳回)$/.test(value.trim()),
    )
  );
}
export function isPriorityChange(row: Pick<MonthlyChange, 'level'>) {
  return /^(?:中|中等|中高|高|极高|超高|重大)(?:风险)?(?:级)?$/.test(
    row.level.trim(),
  );
}
export function changeCohorts(records: MonthlyChange[]) {
  const all = records.filter(isVisibleChange);
  return {
    all,
    done: all.filter((r) => r.state === 'done'),
    running: all.filter((r) => r.state === 'running'),
    pending: all.filter((r) => r.state !== 'done'),
    priority: all.filter(isPriorityChange),
    emergency: all.filter((r) => r.type === '紧急变更'),
  };
}
export function changeScope(
  records: MonthlyChange[],
  start: string,
  end: string,
  building = 'all',
) {
  return records.filter(
    (r) =>
      isVisibleChange(r) &&
      r.date >= start &&
      r.date <= end &&
      (building === 'all' || r.buildings.includes(building)),
  );
}
export function filterChanges(records: MonthlyChange[], f: ChangeFilters) {
  const search = f.search.trim().toLocaleLowerCase();
  return records.filter(
    (r) =>
      isVisibleChange(r) &&
      (!f.risk || (f.risk === 'priority' && isPriorityChange(r))) &&
      (!f.state || r.state === f.state) &&
      (!f.type || r.type === f.type) &&
      (!f.specialty || r.specialty === f.specialty) &&
      (!f.level || r.level === f.level) &&
      (!f.date || r.date.startsWith(f.date)) &&
      (!search ||
        [r.code, r.title, ...r.buildings, r.workType, r.risk]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search)),
  );
}
export function sortChanges(records: MonthlyChange[]) {
  const score = (r: MonthlyChange) =>
    Number(r.state !== 'done') * 4 +
    Number(isPriorityChange(r)) * 2 +
    Number(r.state === 'running');
  return [...records].sort(
    (a, b) =>
      score(b) - score(a) ||
      b.plannedStart.localeCompare(a.plannedStart) ||
      a.id.localeCompare(b.id),
  );
}
export function changeGroups(
  records: MonthlyChange[],
  key: 'state' | 'type' | 'specialty',
) {
  const counts = new Map<string, number>();
  records.forEach((r) => {
    const name = key === 'state' ? CHANGE_STATES[r.state] : r[key];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return [...counts]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}
export function changeTrend(
  records: MonthlyChange[],
  start: string,
  end: string,
  grain: 'day' | 'month',
) {
  const keys =
    grain === 'month'
      ? monthsInRange(start, end)
      : Array.from(
          {
            length: Math.max(
              0,
              Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1,
            ),
          },
          (_, i) =>
            new Date(Date.parse(start) + i * 86400000)
              .toISOString()
              .slice(0, 10),
        );
  return keys.map((key) => {
    const items = records.filter((r) => r.date.startsWith(key));
    return {
      name:
        grain === 'month'
          ? key.replace('-', '/')
          : key.slice(5).replace('-', '/'),
      total: items.length,
      done: items.filter((r) => r.state === 'done').length,
    };
  });
}
