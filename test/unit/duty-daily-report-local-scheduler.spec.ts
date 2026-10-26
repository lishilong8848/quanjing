import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DutyDailyReportLocalSchedulerService } from '../../server/modules/duty-schedule/duty-daily-report-local-scheduler.service';

type DutyDailyReportLocalTask =
  | 'white-screenshot'
  | 'night-screenshot';

interface DutyDailyReportLocalRun {
  task: DutyDailyReportLocalTask;
  date: string;
  scheduledAt: Date;
}

interface LocalSchedulerLifecycle {
  onModuleInit?: () => void;
  onModuleDestroy?: () => void;
}

const schedulerModule = require(
  '../../server/modules/duty-schedule/duty-daily-report-local-scheduler.service',
) as {
  getNextDutyDailyReportRun?: (now: Date) => DutyDailyReportLocalRun;
  getDueDutyDailyReportRuns?: (
    now: Date,
    lookbackDays?: number,
  ) => DutyDailyReportLocalRun[];
};

describe('duty daily report local scheduler wiring', () => {
  it('registers a standalone scheduler and a shared task coordinator', () => {
    const schedulerPath = join(
      process.cwd(),
      'server/modules/duty-schedule/duty-daily-report-local-scheduler.service.ts',
    );
    const coordinatorPath = join(
      process.cwd(),
      'server/modules/duty-schedule/duty-daily-report-task-coordinator.service.ts',
    );
    const moduleSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.module.ts',
      ),
      'utf8',
    );

    expect(existsSync(schedulerPath)).toBe(true);
    expect(existsSync(coordinatorPath)).toBe(true);
    expect(moduleSource).toContain('DutyDailyReportLocalSchedulerService');
    expect(moduleSource).toContain('DutyDailyReportTaskCoordinatorService');
  });
});

describe('duty daily report local scheduler time calculation', () => {
  it('calculates the next run in Asia/Shanghai', () => {
    expect(typeof schedulerModule.getNextDutyDailyReportRun).toBe('function');
    if (!schedulerModule.getNextDutyDailyReportRun) return;

    expect(
      schedulerModule.getNextDutyDailyReportRun(
        new Date('2026-07-20T00:49:00.000Z'),
      ),
    ).toMatchObject({
      task: 'white-screenshot',
      date: '2026-07-20',
      scheduledAt: new Date('2026-07-20T00:50:00.000Z'),
    });
    expect(
      schedulerModule.getNextDutyDailyReportRun(
        new Date('2026-07-20T00:50:00.000Z'),
      ),
    ).toMatchObject({
      task: 'night-screenshot',
      date: '2026-07-20',
      scheduledAt: new Date('2026-07-20T09:50:00.000Z'),
    });
  });

  it('selects all missed runs for the current Shanghai date', () => {
    expect(typeof schedulerModule.getDueDutyDailyReportRuns).toBe('function');
    if (!schedulerModule.getDueDutyDailyReportRuns) return;

    expect(
      schedulerModule
        .getDueDutyDailyReportRuns(new Date('2026-07-20T02:09:00.000Z'))
        .map(({ task, date }) => ({ task, date })),
    ).toEqual([
      { task: 'white-screenshot', date: '2026-07-20' },
    ]);
  });

  it('selects missed runs for the configured two-day lookback window', () => {
    expect(typeof schedulerModule.getDueDutyDailyReportRuns).toBe('function');
    if (!schedulerModule.getDueDutyDailyReportRuns) return;

    expect(
      schedulerModule
        .getDueDutyDailyReportRuns(
          new Date('2026-07-22T02:09:00.000Z'),
          2,
        )
        .map(({ task, date }) => ({ task, date })),
    ).toEqual([
      { task: 'white-screenshot', date: '2026-07-20' },
      { task: 'night-screenshot', date: '2026-07-20' },
      { task: 'white-screenshot', date: '2026-07-21' },
      { task: 'night-screenshot', date: '2026-07-21' },
      { task: 'white-screenshot', date: '2026-07-22' },
    ]);
  });
});

describe('DutyDailyReportLocalSchedulerService', () => {
  const originalStandalone =
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS;
  const originalEnabled =
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_ENABLED;
  const originalStartupDelay =
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS;
  const originalReconcileInterval =
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS;
  const originalLookbackDays =
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_LOOKBACK_DAYS;

  beforeEach(() => {
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_LOOKBACK_DAYS = '0';
  });

  afterEach(() => {
    jest.useRealTimers();
    restoreEnvironment(
      'FORCE_FRAMEWORK_DISABLE_DATAPASS',
      originalStandalone,
    );
    restoreEnvironment(
      'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_ENABLED',
      originalEnabled,
    );
    restoreEnvironment(
      'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS',
      originalStartupDelay,
    );
    restoreEnvironment(
      'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS',
      originalReconcileInterval,
    );
    restoreEnvironment(
      'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_LOOKBACK_DAYS',
      originalLookbackDays,
    );
  });

  it('does not start local timers outside standalone mode', () => {
    jest.useFakeTimers();
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const coordinator = { run: jest.fn() };
    const lifecycle = createScheduler(coordinator);

    expect(typeof lifecycle.onModuleInit).toBe('function');
    if (!lifecycle.onModuleInit || !lifecycle.onModuleDestroy) return;

    lifecycle.onModuleInit();

    expect(jest.getTimerCount()).toBe(0);
    expect(coordinator.run).not.toHaveBeenCalled();
    lifecycle.onModuleDestroy();
  });

  it('delays startup catch-up and runs due tasks in order', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-20T02:09:00.000Z'));
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS = '1000';
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS =
      '60000';
    const coordinator = {
      run: jest.fn().mockResolvedValue({ success: true }),
    };
    const scheduler = createScheduler(coordinator);

    expect(typeof scheduler.onModuleInit).toBe('function');
    if (!scheduler.onModuleInit || !scheduler.onModuleDestroy) return;

    scheduler.onModuleInit();
    expect(coordinator.run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);

    expect(coordinator.run).toHaveBeenNthCalledWith(
      1,
      'white-screenshot',
      '2026-07-20',
    );
    expect(jest.getTimerCount()).toBe(2);

    scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('runs the exact scheduled task and schedules the following run', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-20T00:49:00.000Z'));
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS =
      '300000';
    const coordinator = {
      run: jest.fn().mockResolvedValue({ success: true }),
    };
    const scheduler = createScheduler(coordinator);

    expect(typeof scheduler.onModuleInit).toBe('function');
    if (!scheduler.onModuleInit || !scheduler.onModuleDestroy) return;

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60 * 1000);

    expect(coordinator.run).toHaveBeenCalledTimes(1);
    expect(coordinator.run).toHaveBeenCalledWith(
      'white-screenshot',
      '2026-07-20',
    );
    expect(jest.getTimerCount()).toBe(2);

    scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries a failed due task on the next reconciliation interval', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-20T02:09:00.000Z'));
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS = '1000';
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS =
      '1000';
    const coordinator = {
      run: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary Feishu failure'))
        .mockResolvedValue({ success: true }),
    };
    const scheduler = createScheduler(coordinator);

    expect(typeof scheduler.onModuleInit).toBe('function');
    if (!scheduler.onModuleInit || !scheduler.onModuleDestroy) return;

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(coordinator.run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(coordinator.run).toHaveBeenNthCalledWith(
      2,
      'white-screenshot',
      '2026-07-20',
    );

    scheduler.onModuleDestroy();
  });

  it('uses a one-hour default reconciliation interval', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-20T02:09:00.000Z'));
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS = '1000';
    delete process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS;
    const coordinator = {
      run: jest.fn().mockResolvedValue({ success: true }),
    };
    const scheduler = createScheduler(coordinator);

    expect(typeof scheduler.onModuleInit).toBe('function');
    if (!scheduler.onModuleInit || !scheduler.onModuleDestroy) return;

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(coordinator.run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(coordinator.run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(coordinator.run).toHaveBeenCalledTimes(2);

    scheduler.onModuleDestroy();
  });
});

function createScheduler(coordinator: {
  run: jest.Mock;
}): LocalSchedulerLifecycle {
  const Scheduler = DutyDailyReportLocalSchedulerService as unknown as new (
    taskCoordinator: typeof coordinator,
  ) => DutyDailyReportLocalSchedulerService;
  return new Scheduler(coordinator) as LocalSchedulerLifecycle;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
