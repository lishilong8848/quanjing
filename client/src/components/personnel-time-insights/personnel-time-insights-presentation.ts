import type { PersonnelTimeInsightsPersonSummary } from '@shared/personnel-time-insights.interface';

export interface PersonnelTimeInsightsRange {
  from: string;
  through: string;
}

export interface PersonnelTimeInsightsPersonGroup {
  building: string;
  people: PersonnelTimeInsightsPersonSummary[];
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const BUILDING_ORDER = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];

export function getDefaultPersonnelTimeInsightsRange(
  now = new Date(),
): PersonnelTimeInsightsRange {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    from: `${values.year}-01-01`,
    through: `${values.year}-${values.month}-${values.day}`,
  };
}

export function getCurrentMonthPersonnelTimeInsightsRange(
  now = new Date(),
): PersonnelTimeInsightsRange {
  const current = getDefaultPersonnelTimeInsightsRange(now).through;
  return { from: `${current.slice(0, 7)}-01`, through: current };
}

export function validatePersonnelTimeInsightsRange(
  from: string,
  through: string,
): string | null {
  if (!isValidDateKey(from) || !isValidDateKey(through)) {
    return '请选择有效的开始和结束日期';
  }
  if (from > through) return '开始日期不能晚于结束日期';
  const elapsed =
    (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000;
  if (elapsed > 366 * 5) return '查询周期不能超过五年';
  return null;
}

export function filterPersonnelTimeInsightsPeople(
  people: readonly PersonnelTimeInsightsPersonSummary[],
  query: string,
): PersonnelTimeInsightsPersonSummary[] {
  const terms = query
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return [...people];
  return people.filter((person) => {
    const haystack = `${person.name} ${person.building} ${person.position}`
      .toLocaleLowerCase('zh-CN')
      .replace(/\s+/gu, ' ');
    return terms.every((term) => haystack.includes(term));
  });
}

export function groupPersonnelTimeInsightsPeople(
  people: readonly PersonnelTimeInsightsPersonSummary[],
  mode: 'building' | 'all' = 'building',
): PersonnelTimeInsightsPersonGroup[] {
  if (people.length === 0) return [];
  if (mode === 'all') {
    return [{ building: '全部人员', people: [...people].sort(comparePeople) }];
  }
  const groups = new Map<string, PersonnelTimeInsightsPersonSummary[]>();
  people.forEach((person) => {
    const group = groups.get(person.building) ?? [];
    group.push(person);
    groups.set(person.building, group);
  });
  return [...groups]
    .map(([building, entries]) => ({
      building,
      people: [...entries].sort(comparePeople),
    }))
    .sort((left, right) => compareBuildings(left.building, right.building));
}

export function formatPersonnelHours(value: number): string {
  const normalized = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')}h`;
}

function comparePeople(
  left: PersonnelTimeInsightsPersonSummary,
  right: PersonnelTimeInsightsPersonSummary,
): number {
  const leftNegative = left.compensatoryAvailableHours < 0 ? 0 : 1;
  const rightNegative = right.compensatoryAvailableHours < 0 ? 0 : 1;
  return (
    leftNegative - rightNegative ||
    right.overtimeHours - left.overtimeHours ||
    left.name.localeCompare(right.name, 'zh-CN')
  );
}

function compareBuildings(left: string, right: string): number {
  const leftIndex = BUILDING_ORDER.indexOf(left);
  const rightIndex = BUILDING_ORDER.indexOf(right);
  if (leftIndex >= 0 || rightIndex >= 0) {
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  }
  return left.localeCompare(right, 'zh-CN');
}

function isValidDateKey(value: string): boolean {
  if (!DATE_KEY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
