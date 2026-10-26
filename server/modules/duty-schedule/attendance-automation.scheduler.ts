import { createHash } from 'crypto';

export type AttendanceAutomationTask =
  | 'archive-yesterday'
  | 'morning-on-duty-reminder'
  | 'morning-off-duty-check'
  | 'evening-on-duty-reminder'
  | 'evening-off-duty-check';

export interface AttendanceAutomationRun {
  task: AttendanceAutomationTask;
  date: string;
  scheduledAt: Date;
}

interface AttendanceAutomationTaskDefinition {
  task: AttendanceAutomationTask;
  hour: number;
  minute: number;
  businessDateOffset: number;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const TASKS: readonly AttendanceAutomationTaskDefinition[] = [
  {
    task: 'archive-yesterday',
    hour: 0,
    minute: 30,
    businessDateOffset: -1,
  },
  {
    task: 'morning-on-duty-reminder',
    hour: 8,
    minute: 55,
    businessDateOffset: 0,
  },
  {
    task: 'morning-off-duty-check',
    hour: 9,
    minute: 30,
    businessDateOffset: 0,
  },
  {
    task: 'evening-on-duty-reminder',
    hour: 17,
    minute: 55,
    businessDateOffset: 0,
  },
  {
    task: 'evening-off-duty-check',
    hour: 18,
    minute: 35,
    businessDateOffset: 0,
  },
] as const;

export function getNextAttendanceAutomationRun(
  now: Date,
): AttendanceAutomationRun {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = shanghaiNow.getUTCFullYear();
  const month = shanghaiNow.getUTCMonth();
  const day = shanghaiNow.getUTCDate();

  for (const definition of TASKS) {
    const run = buildRun(year, month, day, definition);
    if (run.scheduledAt.getTime() > now.getTime()) return run;
  }

  return buildRun(year, month, day + 1, TASKS[0]);
}

export function getDueAttendanceAutomationRuns(
  now: Date,
  lookbackDays = 0,
  effectiveFrom = '2026-08-28',
  reconcileStartedAt?: Date,
  liveCatchUpMinutes = 10,
): AttendanceAutomationRun[] {
  parseDateKey(effectiveFrom);
  const liveFloor = reconcileStartedAt
    ? reconcileStartedAt.getTime() - Math.max(0, liveCatchUpMinutes) * 60 * 1000
    : Number.NEGATIVE_INFINITY;
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = shanghaiNow.getUTCFullYear();
  const month = shanghaiNow.getUTCMonth();
  const day = shanghaiNow.getUTCDate();
  const normalizedLookback = Number.isFinite(lookbackDays)
    ? Math.max(0, Math.floor(lookbackDays))
    : 0;

  return Array.from(
    { length: normalizedLookback + 1 },
    (_, index) => day - normalizedLookback + index,
  )
    .flatMap((runDay) =>
      TASKS.map((definition) => buildRun(year, month, runDay, definition)),
    )
    .filter(
      (run) =>
        run.scheduledAt.getTime() <= now.getTime() &&
        run.date >= effectiveFrom &&
        run.scheduledAt.getTime() >= liveFloor,
    );
}

export function buildYesterdayAttendanceWindow(runDate: string): {
  businessDate: string;
  start: string;
  end: string;
} {
  parseDateKey(runDate);
  return {
    businessDate: runDate,
    start: `${runDate} 00:00:00`,
    end: `${runDate} 23:59:59`,
  };
}

export function buildLiveAttendanceWindow(
  task: Exclude<AttendanceAutomationTask, 'archive-yesterday'>,
  date: string,
): { start: string; end: string } {
  parseDateKey(date);
  const endTime: Record<
    Exclude<AttendanceAutomationTask, 'archive-yesterday'>,
    string
  > = {
    'morning-on-duty-reminder': '08:55:59',
    'morning-off-duty-check': '09:30:59',
    'evening-on-duty-reminder': '17:55:59',
    'evening-off-duty-check': '18:35:59',
  };
  return { start: `${date} 00:00:00`, end: `${date} ${endTime[task]}` };
}

export function buildAttendanceAutomationIdempotencyKey(
  task: AttendanceAutomationTask,
  date: string,
  recipientId: string,
): string {
  const taskCode: Record<AttendanceAutomationTask, string> = {
    'archive-yesterday': 'ay',
    'morning-on-duty-reminder': 'mo',
    'morning-off-duty-check': 'mf35',
    'evening-on-duty-reminder': 'eo',
    'evening-off-duty-check': 'ef35',
  };
  const recipientHash = createHash('sha256')
    .update(recipientId)
    .digest('hex')
    .slice(0, 12);
  return `attn-${taskCode[task]}-${date.replaceAll('-', '')}-${recipientHash}`;
}

function buildRun(
  year: number,
  month: number,
  day: number,
  definition: AttendanceAutomationTaskDefinition,
): AttendanceAutomationRun {
  const scheduledAt = new Date(
    Date.UTC(year, month, day, definition.hour, definition.minute, 0, 0) -
      SHANGHAI_OFFSET_MS,
  );
  const businessDate = new Date(
    Date.UTC(year, month, day + definition.businessDateOffset),
  );
  return {
    task: definition.task,
    date: formatUtcDateKey(businessDate),
    scheduledAt,
  };
}

function parseDateKey(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`无效业务日期：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function formatUtcDateKey(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, '0'),
    String(value.getUTCDate()).padStart(2, '0'),
  ].join('-');
}
