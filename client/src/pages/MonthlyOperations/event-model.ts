import type { MonthlyEvent } from '@shared/monthly-operations-events.interface';
import {
  eventDeviceCode,
  eventRepeatKey,
} from '@shared/monthly-operations-event-identity';
export type EventScope = 'period' | 'year' | 'history';
export interface EventFilters {
  scope: EventScope;
  state:
    | 'all'
    | 'active'
    | 'open'
    | 'key'
    | 'done'
    | 'none'
    | 'unknown'
    | 'unresolved';
  source: string;
  specialty: string;
  level: string;
  date: string;
  query: string;
  building: string;
}
export const DEFAULT_EVENT_FILTERS: EventFilters = {
  scope: 'history',
  state: 'active',
  source: '',
  specialty: '',
  level: '',
  date: '',
  query: '',
  building: '',
};
export function eventScope(
  records: MonthlyEvent[],
  start: string,
  end: string,
  scope: EventScope,
) {
  return records.filter(
    (r) =>
      r.date <= end &&
      (scope === 'history' ||
        r.date >= (scope === 'year' ? end.slice(0, 4) + '-01-01' : start)),
  );
}
export function filterEvents(
  records: MonthlyEvent[],
  filters: EventFilters,
  start: string,
  end: string,
) {
  const q = filters.query.trim().toLowerCase();
  return eventScope(records, start, end, filters.scope).filter(
    (r) =>
      (!filters.source || r.source === filters.source) &&
      (!filters.specialty || r.specialty === filters.specialty) &&
      (!filters.level || r.finalLevel === filters.level) &&
      (!filters.date || r.date.startsWith(filters.date)) &&
      (!filters.building || r.building === filters.building) &&
      (!q ||
        [r.title, r.code, r.building, r.source, r.specialty, r.progress]
          .join(' ')
          .toLowerCase()
          .includes(q)) &&
      (filters.state === 'all' ||
        (filters.state === 'active' && r.repair === 'active') ||
        (filters.state === 'open' && r.closed === false) ||
        (filters.state === 'key' && r.keyEvent) ||
        (filters.state === 'done' && r.repair === 'done') ||
        (filters.state === 'none' && r.repair === 'none') ||
        (filters.state === 'unknown' && r.repair === 'unknown') ||
        (filters.state === 'unresolved' &&
          (r.closed === false || r.repair === 'active'))),
  );
}
export function eventGroups(
  records: MonthlyEvent[],
  field: 'source' | 'repair' | 'building' | 'specialty',
) {
  const map = new Map<string, number>();
  records.forEach((r) => map.set(r[field], (map.get(r[field]) ?? 0) + 1));
  return [...map]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export type EventPriorityReason =
  | '重复出现'
  | '3个月内重复'
  | '同设备多发'
  | 'I2及以上'
  | '需复盘'
  | '未闭环超过7天'
  | '检修中超过7天';

export interface EventPrioritySummary {
  records: MonthlyEvent[];
  repeated: MonthlyEvent[];
  deviceRepeated: MonthlyEvent[];
  rapidRepeated: MonthlyEvent[];
  highLevel: MonthlyEvent[];
  review: MonthlyEvent[];
  overdue: MonthlyEvent[];
  unlabeled: MonthlyEvent[];
  repeatGroupCount: number;
  rapidRepeatGroupCount: number;
  reasons: Record<string, EventPriorityReason[]>;
}

export function eventRepeatOccurrences(
  records: MonthlyEvent[],
  selected: MonthlyEvent,
  asOf: string,
) {
  const key = eventRepeatKey(selected.title, selected.building);
  if (!key || selected.date > asOf) return [];
  const occurrences = records
    .filter(
      (record) =>
        record.date <= asOf &&
        eventRepeatKey(record.title, record.building) === key,
    )
    .sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
    );
  return occurrences.length >= 3 ? occurrences : [];
}

export function eventDeviceOccurrences(
  records: MonthlyEvent[],
  selected: MonthlyEvent,
  asOf: string,
) {
  const device = eventDeviceCode(selected.title);
  if (!device || selected.date > asOf) return [];
  const occurrences = records
    .filter(
      (record) =>
        record.date <= asOf && eventDeviceCode(record.title) === device,
    )
    .sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
    );
  return occurrences.length >= 2 ? occurrences : [];
}

function elapsedDays(record: MonthlyEvent, asOf: string) {
  const start = Date.parse(`${record.date}T00:00:00Z`),
    end = Date.parse(`${asOf}T00:00:00Z`);
  const calendarDays =
    Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, Math.floor((end - start) / 86400000))
      : 0;
  return Math.max(
    calendarDays,
    record.durationDays !== null && Number.isFinite(record.durationDays)
      ? Math.max(0, record.durationDays)
      : 0,
  );
}

function threeMonthsEarlier(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 4, 1));
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return start.toISOString().slice(0, 10);
}

/** 全量历史重点事件：同故障 3 次、同设备 2 次、I2+、逾期未闭环或检修中。 */
export function eventPrioritySummary(
  records: MonthlyEvent[],
  asOf: string,
): EventPrioritySummary {
  const history = records.filter((record) => record.date <= asOf),
    groups = new Map<string, MonthlyEvent[]>(),
    deviceGroups = new Map<string, MonthlyEvent[]>();
  history.forEach((record) => {
    const device = eventDeviceCode(record.title);
    if (device) {
      const deviceGroup = deviceGroups.get(device) ?? [];
      deviceGroup.push(record);
      deviceGroups.set(device, deviceGroup);
    }
    const key = eventRepeatKey(record.title, record.building);
    if (!key) return;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  });
  const repeatGroups = [...groups].filter(([, group]) => group.length >= 3),
    rapidKeys = new Set(
      repeatGroups
        .filter(([, group]) => {
          const ordered = [...group].sort((a, b) =>
            a.occurredAt.localeCompare(b.occurredAt),
          );
          return ordered.some(
            (record, index) =>
              index >= 2 &&
              ordered[index - 2].date >= threeMonthsEarlier(record.date),
          );
        })
        .map(([key]) => key),
    ),
    repeated = repeatGroups
      .map(([key, group]) => ({
        key,
        latest: [...group].sort(
          (a, b) =>
            b.occurredAt.localeCompare(a.occurredAt) ||
            a.id.localeCompare(b.id),
        )[0],
      }))
      .sort(
        (a, b) =>
          Number(rapidKeys.has(b.key)) - Number(rapidKeys.has(a.key)) ||
          b.latest.occurredAt.localeCompare(a.latest.occurredAt),
      )
      .map(({ latest }) => latest),
    rapidRepeated = repeated.filter((record) =>
      rapidKeys.has(eventRepeatKey(record.title, record.building)),
    ),
    deviceRepeated = [...deviceGroups.values()]
      .filter((group) => group.length >= 2)
      .map(
        (group) =>
          [...group].sort(
            (a, b) =>
              b.occurredAt.localeCompare(a.occurredAt) ||
              a.id.localeCompare(b.id),
          )[0],
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    highLevel = history.filter((record) => record.keyEvent),
    review = history.filter(
      (record) => record.needsReview || record.reviewReports.length > 0,
    ),
    overdue = history.filter(
      (record) =>
        (record.closed === false || record.repair === 'active') &&
        elapsedDays(record, asOf) > 7,
    ),
    unlabeled = history.filter(
      (record) => record.building === '未标注' || record.specialty === '未标注',
    ),
    reasons: Record<string, EventPriorityReason[]> = {};
  const add = (record: MonthlyEvent, reason: EventPriorityReason) => {
    (reasons[record.id] ??= []).push(reason);
  };
  repeated.forEach((record) => {
    add(record, '重复出现');
    if (rapidKeys.has(eventRepeatKey(record.title, record.building)))
      add(record, '3个月内重复');
  });
  deviceRepeated.forEach((record) => add(record, '同设备多发'));
  highLevel.forEach((record) => add(record, 'I2及以上'));
  review.forEach((record) => add(record, '需复盘'));
  overdue.forEach((record) =>
    add(record, record.repair === 'active' ? '检修中超过7天' : '未闭环超过7天'),
  );
  return {
    records: history.filter((record) => reasons[record.id]),
    repeated,
    deviceRepeated,
    rapidRepeated,
    highLevel,
    review,
    overdue,
    unlabeled,
    repeatGroupCount: repeated.length,
    rapidRepeatGroupCount: rapidRepeated.length,
    reasons,
  };
}

export function eventMetricRecords(
  records: MonthlyEvent[],
  start: string,
  end: string,
  priority = eventPrioritySummary(records, end).records,
) {
  const scoped = (patch: Partial<EventFilters>) =>
    filterEvents(
      records,
      { ...DEFAULT_EVENT_FILTERS, state: 'all', ...patch },
      start,
      end,
    );
  return {
    year: scoped({ scope: 'year' }),
    period: scoped({ scope: 'period' }),
    open: scoped({ state: 'open' }),
    key: scoped({ state: 'key' }),
    active: scoped({ state: 'active' }),
    priority,
  };
}
export type EventMetric = keyof ReturnType<typeof eventMetricRecords>;
export function eventMonthlyTrend(records: MonthlyEvent[], end: string) {
  const [y, m] = end.split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 12 + i, 1)),
      name = date.toISOString().slice(0, 7);
    return {
      name,
      total: records.filter((r) => r.date.startsWith(name)).length,
    };
  });
}
