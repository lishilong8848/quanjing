import type { PersonnelTimeInsightsPersonSummary } from '@shared/personnel-time-insights.interface';

export type PersonnelRecordKind = 'leave' | 'overtime';
export type PersonnelRecordGroupMode = 'building' | 'category' | 'person';
export interface PersonnelRecordDrilldown {
  kind: 'building' | 'person';
  value: string;
  label?: string;
}
export interface PersonnelRecordItem {
  key: string;
  recordId: string;
  personKey: string;
  name: string;
  building: string;
  date: string;
  startAt: string;
  endAt: string;
  hours: number;
  category: string;
  status: 'approved' | 'confirmed' | 'pending';
  travel: boolean;
}

export function buildPersonnelRecords(
  people: readonly PersonnelTimeInsightsPersonSummary[],
  kind: PersonnelRecordKind,
): PersonnelRecordItem[] {
  const records: PersonnelRecordItem[] = [];
  for (const person of people) {
    const identity = {
      personKey: person.key,
      name: person.name,
      building: person.building,
    };
    if (kind === 'leave') {
      person.details.leave.forEach((entry, index) =>
        records.push({
          ...identity,
          key: `${person.key}:leave:${entry.recordId}:${entry.date}:${index}`,
          recordId: entry.recordId,
          date: entry.date,
          startAt: entry.startAt,
          endAt: entry.endAt,
          hours: entry.hours,
          category: entry.leaveType,
          status: 'approved',
          travel: entry.travel,
        }),
      );
    } else {
      person.details.overtime.forEach((entry, index) =>
        records.push({
          ...identity,
          key: `${person.key}:overtime:${entry.recordId}:${index}`,
          recordId: entry.recordId,
          date: entry.startAt.slice(0, 10),
          startAt: entry.startAt,
          endAt: entry.endAt || '',
          hours: entry.hours,
          category: entry.disposition,
          status: 'confirmed',
          travel: false,
        }),
      );
      (person.details.pendingOvertime || []).forEach((entry, index) =>
        records.push({
          ...identity,
          key: `${person.key}:pending:${entry.recordId}:${index}`,
          recordId: entry.recordId,
          date: entry.startAt.slice(0, 10),
          startAt: entry.startAt,
          endAt: entry.endAt,
          hours: entry.hours,
          category: '待确认',
          status: 'pending',
          travel: false,
        }),
      );
    }
  }
  return records.sort(
    (a, b) =>
      b.startAt.localeCompare(a.startAt) ||
      a.name.localeCompare(b.name, 'zh-CN'),
  );
}

export function filterPersonnelRecords(
  records: readonly PersonnelRecordItem[],
  category = 'all',
  drilldown: PersonnelRecordDrilldown | null = null,
  query = '',
): PersonnelRecordItem[] {
  const terms = query
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/u)
    .filter(Boolean);
  return records.filter(
    (entry) =>
      (category === 'all' ||
        entry.category === category ||
        entry.status === category) &&
      (!drilldown ||
        (drilldown.kind === 'person'
          ? entry.personKey === drilldown.value
          : entry.building === drilldown.value)) &&
      terms.every((term) =>
        `${entry.name} ${entry.building} ${entry.category}`
          .toLocaleLowerCase('zh-CN')
          .includes(term),
      ),
  );
}

export function groupPersonnelRecords(
  records: readonly PersonnelRecordItem[],
  mode: PersonnelRecordGroupMode,
) {
  const groups = new Map<
    string,
    { key: string; label: string; items: PersonnelRecordItem[] }
  >();
  for (const entry of records) {
    const key =
      mode === 'person'
        ? entry.personKey
        : mode === 'category'
          ? entry.category
          : entry.building;
    const group = groups.get(key) || {
      key,
      label: mode === 'person' ? entry.name : key,
      items: [],
    };
    group.items.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.label.localeCompare(b.label, 'zh-CN'),
  );
}

export function rankPersonnelRecords(
  records: readonly PersonnelRecordItem[],
  mode: 'person' | 'building',
  metric: 'hours' | 'count',
) {
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      value: number;
      count: number;
      buildings: Set<string>;
    }
  >();
  for (const entry of records) {
    if (metric === 'hours' && entry.status === 'pending') continue;
    const key = mode === 'person' ? entry.personKey : entry.building;
    const group = groups.get(key) || {
      key,
      label: mode === 'person' ? entry.name : entry.building,
      value: 0,
      count: 0,
      buildings: new Set<string>(),
    };
    group.value += metric === 'hours' ? entry.hours : 1;
    group.count++;
    group.buildings.add(entry.building);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      value: Math.round(group.value * 100) / 100,
      buildings: [...group.buildings],
    }))
    .sort(
      (a, b) =>
        b.value - a.value ||
        a.label.localeCompare(b.label, 'zh-CN') ||
        a.key.localeCompare(b.key),
    );
}
