export interface DutyStaffActualRefreshWindow {
  startDate: string;
  endDate: string;
}

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;

function formatShanghaiDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function addShanghaiDays(dateKey: string, days: number): string {
  const timestamp = new Date(`${dateKey}T00:00:00+08:00`).getTime();
  return formatShanghaiDateKey(new Date(timestamp + days * DAY_MS));
}

export function getDutyProgramModifiedRefreshWindow(
  now = new Date(),
): DutyStaffActualRefreshWindow {
  const startDate = formatShanghaiDateKey(now);
  return {
    startDate,
    endDate: addShanghaiDays(startDate, 15),
  };
}
