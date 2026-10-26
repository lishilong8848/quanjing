const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const OVERTIME_REQUEST_HISTORY_DAYS = 30;

function parseDateKey(value: string): number | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

function formatDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function getOvertimeHistoryEarliestDate(todayDate: string): string {
  const todayTimestamp = parseDateKey(todayDate);
  if (todayTimestamp === null) return '';
  return formatDateKey(todayTimestamp - OVERTIME_REQUEST_HISTORY_DAYS * DAY_MS);
}

export function isOvertimeHistoryDateAllowed(
  startDate: string,
  todayDate: string,
): boolean {
  const startTimestamp = parseDateKey(startDate);
  const earliestDate = getOvertimeHistoryEarliestDate(todayDate);
  const earliestTimestamp = parseDateKey(earliestDate);
  return (
    startTimestamp !== null &&
    earliestTimestamp !== null &&
    startTimestamp >= earliestTimestamp
  );
}

export function listOvertimeHistoryScheduleCoverageDates(
  todayDate: string,
): string[] {
  const todayTimestamp = parseDateKey(todayDate);
  const earliestDate = getOvertimeHistoryEarliestDate(todayDate);
  const earliestTimestamp = parseDateKey(earliestDate);
  if (todayTimestamp === null || earliestTimestamp === null) return [];

  const dates: string[] = [];
  for (
    let cursor = earliestTimestamp - DAY_MS;
    cursor <= todayTimestamp;
    cursor += DAY_MS
  ) {
    dates.push(formatDateKey(cursor));
  }
  return dates;
}
