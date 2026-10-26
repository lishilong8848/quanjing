export type AttendancePeriodicSummaryPeriod = 'weekly' | 'monthly';

export interface AttendancePeriodicSummaryRun {
  period: AttendancePeriodicSummaryPeriod;
  startDate: string;
  endDate: string;
  scheduledAt: Date;
}

export interface AttendancePeriodicSummaryBatch {
  scheduledAt: Date;
  runs: AttendancePeriodicSummaryRun[];
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const SCHEDULE_HOUR = 10;
const STARTUP_RECOVERY_WINDOW_MS = 30 * 60 * 1_000;

export function getNextAttendancePeriodicSummaryBatch(
  now: Date,
): AttendancePeriodicSummaryBatch {
  const weekly = buildNextWeeklyRun(now);
  const monthly = buildNextMonthlyRun(now);
  const scheduledAt = new Date(
    Math.min(weekly.scheduledAt.getTime(), monthly.scheduledAt.getTime()),
  );
  return {
    scheduledAt,
    runs: [weekly, monthly].filter(
      (run) => run.scheduledAt.getTime() === scheduledAt.getTime(),
    ),
  };
}

export function getRecoverableAttendancePeriodicSummaryRuns(
  now: Date,
): AttendancePeriodicSummaryRun[] {
  return [buildLatestWeeklyRun(now), buildLatestMonthlyRun(now)].filter((run) =>
    isAttendancePeriodicSummaryRunWithinDeliveryWindow(run, now),
  );
}

export function isAttendancePeriodicSummaryRunWithinDeliveryWindow(
  run: AttendancePeriodicSummaryRun,
  now: Date,
): boolean {
  return (
    now.getTime() >= run.scheduledAt.getTime() &&
    now.getTime() < run.scheduledAt.getTime() + STARTUP_RECOVERY_WINDOW_MS
  );
}

function buildNextWeeklyRun(now: Date): AttendancePeriodicSummaryRun {
  const local = shanghaiLocal(now);
  const weekday = local.getUTCDay();
  const daysUntilMonday = (8 - weekday) % 7;
  let scheduledAt = shanghaiDate(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + daysUntilMonday,
    SCHEDULE_HOUR,
  );
  if (scheduledAt.getTime() <= now.getTime()) {
    scheduledAt = new Date(scheduledAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
  }
  return buildWeeklyRun(scheduledAt);
}

function buildLatestWeeklyRun(now: Date): AttendancePeriodicSummaryRun {
  const local = shanghaiLocal(now);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  let scheduledAt = shanghaiDate(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysSinceMonday,
    SCHEDULE_HOUR,
  );
  if (scheduledAt.getTime() > now.getTime()) {
    scheduledAt = new Date(scheduledAt.getTime() - 7 * 24 * 60 * 60 * 1_000);
  }
  return buildWeeklyRun(scheduledAt);
}

function buildWeeklyRun(scheduledAt: Date): AttendancePeriodicSummaryRun {
  const scheduledLocal = shanghaiLocal(scheduledAt);
  const end = new Date(
    Date.UTC(
      scheduledLocal.getUTCFullYear(),
      scheduledLocal.getUTCMonth(),
      scheduledLocal.getUTCDate() - 1,
    ),
  );
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1_000);
  return {
    period: 'weekly',
    startDate: formatUtcDate(start),
    endDate: formatUtcDate(end),
    scheduledAt,
  };
}

function buildNextMonthlyRun(now: Date): AttendancePeriodicSummaryRun {
  const local = shanghaiLocal(now);
  let scheduledAt = shanghaiDate(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    1,
    SCHEDULE_HOUR,
  );
  if (scheduledAt.getTime() <= now.getTime()) {
    scheduledAt = shanghaiDate(
      local.getUTCFullYear(),
      local.getUTCMonth() + 1,
      1,
      SCHEDULE_HOUR,
    );
  }
  return buildMonthlyRun(scheduledAt);
}

function buildLatestMonthlyRun(now: Date): AttendancePeriodicSummaryRun {
  const local = shanghaiLocal(now);
  let scheduledAt = shanghaiDate(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    1,
    SCHEDULE_HOUR,
  );
  if (scheduledAt.getTime() > now.getTime()) {
    scheduledAt = shanghaiDate(
      local.getUTCFullYear(),
      local.getUTCMonth() - 1,
      1,
      SCHEDULE_HOUR,
    );
  }
  return buildMonthlyRun(scheduledAt);
}

function buildMonthlyRun(scheduledAt: Date): AttendancePeriodicSummaryRun {
  const scheduledLocal = shanghaiLocal(scheduledAt);
  const end = new Date(
    Date.UTC(scheduledLocal.getUTCFullYear(), scheduledLocal.getUTCMonth(), 0),
  );
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return {
    period: 'monthly',
    startDate: formatUtcDate(start),
    endDate: formatUtcDate(end),
    scheduledAt,
  };
}

function shanghaiLocal(value: Date): Date {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS);
}

function shanghaiDate(
  year: number,
  month: number,
  day: number,
  hour: number,
): Date {
  return new Date(Date.UTC(year, month, day, hour) - SHANGHAI_OFFSET_MS);
}

function formatUtcDate(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, '0'),
    String(value.getUTCDate()).padStart(2, '0'),
  ].join('-');
}
