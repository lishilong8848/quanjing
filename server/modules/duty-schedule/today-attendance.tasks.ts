import type {
  TodayAttendanceEntry,
  TodayAttendanceFinalTask,
  TodayAttendanceTask,
} from '@shared/today-attendance.interface';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const TASK_TIME: ReadonlyArray<{
  task: TodayAttendanceTask;
  hour: number;
  minute: number;
}> = [
  { task: 'morning-on-duty-reminder', hour: 8, minute: 55 },
  { task: 'morning-off-duty-check', hour: 9, minute: 30 },
  { task: 'evening-on-duty-reminder', hour: 17, minute: 55 },
  { task: 'evening-off-duty-check', hour: 18, minute: 35 },
];

const FINAL_TASKS = new Set<TodayAttendanceTask>([
  'morning-off-duty-check',
  'evening-off-duty-check',
]);

export function getTodayAttendanceTasks(now: Date): TodayAttendanceTask[] {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const currentMinutes =
    shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
  return TASK_TIME.filter(
    ({ hour, minute }) => currentMinutes >= hour * 60 + minute,
  ).map(({ task }) => task);
}

export function getTodayAttendanceFinalTasks(
  now: Date,
): TodayAttendanceFinalTask[] {
  return getTodayAttendanceTasks(now).filter(
    (task): task is TodayAttendanceFinalTask => FINAL_TASKS.has(task),
  );
}

export function resolveTodayAttendanceFinalTask(
  now: Date,
  requestedTask?: TodayAttendanceFinalTask,
): TodayAttendanceFinalTask | null {
  const dueTasks = getTodayAttendanceFinalTasks(now);
  if (requestedTask) {
    return dueTasks.includes(requestedTask) ? requestedTask : null;
  }
  return dueTasks[dueTasks.length - 1] || null;
}

export function getShanghaiDateKey(now: Date): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

export function getTodayAttendanceTaskScheduledAt(
  task: TodayAttendanceTask,
  date: string,
): Date {
  const definition = TASK_TIME.find((candidate) => candidate.task === task);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!definition || !match) throw new Error(`无效考勤任务日期：${date}`);
  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      definition.hour - 8,
      definition.minute,
      0,
      0,
    ),
  );
}

export function dedupeTodayAttendanceEntries(
  entries: readonly TodayAttendanceEntry[],
): TodayAttendanceEntry[] {
  const byKey = new Map<string, TodayAttendanceEntry>();
  entries.forEach((entry) => byKey.set(entry.key, entry));
  return [...byKey.values()];
}
