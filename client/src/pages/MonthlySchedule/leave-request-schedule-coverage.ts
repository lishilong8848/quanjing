import { parseShanghaiLocalDateTime } from '@shared/leave-request-impact';

function addDaysToDateKey(dateKey: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return '';
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== dateKey
  ) {
    return '';
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getLeaveRangeMonthDateKeys(startAt: string, endAt: string): string[] {
  const start = parseShanghaiLocalDateTime(startAt);
  const end = parseShanghaiLocalDateTime(endAt);
  if (!start || !end || end.wallClockHourIndex <= start.wallClockHourIndex) {
    return [];
  }

  const coverageStartDateKey = addDaysToDateKey(start.dateKey, -1);
  if (!coverageStartDateKey) {
    return [];
  }

  const [startYear, startMonth] = coverageStartDateKey.split('-').map(Number);
  const [endYear, endMonth] = end.dateKey.split('-').map(Number);
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const lastMonth = new Date(Date.UTC(endYear, endMonth - 1, 1));
  const dates: string[] = [];
  while (cursor <= lastMonth) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return dates;
}

export function deduplicateScheduleDateKeysByMonth(
  dateKeys: string[],
): string[] {
  const firstDateByMonth = new Map<string, string>();

  for (const dateKey of dateKeys) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      continue;
    }
    const parsed = new Date(`${dateKey}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== dateKey
    ) {
      continue;
    }
    const monthKey = dateKey.slice(0, 7);
    if (!firstDateByMonth.has(monthKey)) {
      firstDateByMonth.set(monthKey, dateKey);
    }
  }

  return [...firstDateByMonth.values()];
}

export function getLeaveScheduleCoverageDateKeys(
  businessDateKey: string,
  startAt: string,
  endAt: string,
): string[] {
  return deduplicateScheduleDateKeysByMonth([
    businessDateKey,
    addDaysToDateKey(businessDateKey, -1),
    ...getLeaveRangeMonthDateKeys(startAt, endAt),
  ]);
}

export function resolveLeaveScheduleForceRefresh(
  requested: boolean,
  canForceRefresh: boolean,
): boolean {
  return requested && canForceRefresh;
}
