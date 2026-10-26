import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DutyDailyReportTaskCoordinatorService } from '@server/modules/duty-schedule/duty-daily-report-task-coordinator.service';

export type DutyDailyReportLocalTask =
  | 'white-screenshot'
  | 'night-screenshot';

export interface DutyDailyReportLocalRun {
  task: DutyDailyReportLocalTask;
  date: string;
  scheduledAt: Date;
}

interface DutyDailyReportLocalTaskDefinition {
  task: DutyDailyReportLocalTask;
  hour: number;
  minute: number;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_RECONCILE_LOOKBACK_DAYS = 2;
const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

const DUTY_DAILY_REPORT_LOCAL_TASKS: DutyDailyReportLocalTaskDefinition[] = [
  { task: 'white-screenshot', hour: 8, minute: 50 },
  { task: 'night-screenshot', hour: 17, minute: 50 },
];

@Injectable()
export class DutyDailyReportLocalSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    DutyDailyReportLocalSchedulerService.name,
  );
  private nextRunTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private activeReconcile: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly taskCoordinator: DutyDailyReportTaskCoordinatorService,
  ) {}

  onModuleInit(): void {
    if (this.started || !this.isEnabled()) return;
    this.started = true;
    this.logger.log(
      '已启动值班日报截图调度：08:50、17:50（Asia/Shanghai），未完成任务每 1 小时巡检补跑',
    );
    this.scheduleNextRun();
    this.scheduleStartupReconcile();
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.nextRunTimer) clearTimeout(this.nextRunTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.nextRunTimer = null;
    this.startupTimer = null;
    this.reconcileTimer = null;
  }

  private scheduleStartupReconcile(): void {
    const delayMs = this.readPositiveInteger(
      'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_STARTUP_DELAY_MS',
      30_000,
    );
    const timer = setTimeout(() => {
      this.startupTimer = null;
      void this.reconcile().finally(() => {
        if (this.started) this.startReconcileInterval();
      });
    }, delayMs);
    timer.unref?.();
    this.startupTimer = timer;
  }

  private startReconcileInterval(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    const intervalMs = this.readPositiveInteger(
      'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_RECONCILE_INTERVAL_MS',
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    const timer = setInterval(() => {
      void this.reconcile();
    }, intervalMs);
    timer.unref?.();
    this.reconcileTimer = timer;
  }

  private scheduleNextRun(): void {
    const run = getNextDutyDailyReportRun(new Date());
    const delayMs = Math.max(1_000, run.scheduledAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.nextRunTimer = null;
      void this.runSafely(run).finally(() => {
        if (this.started) this.scheduleNextRun();
      });
    }, delayMs);
    timer.unref?.();

    if (this.nextRunTimer) clearTimeout(this.nextRunTimer);
    this.nextRunTimer = timer;
  }

  private reconcile(): Promise<void> {
    if (this.activeReconcile) return this.activeReconcile;

    let execution!: Promise<void>;
    execution = this.runDueTasks(new Date()).finally(() => {
      if (this.activeReconcile === execution) {
        this.activeReconcile = null;
      }
    });
    this.activeReconcile = execution;
    return execution;
  }

  private async runDueTasks(now: Date): Promise<void> {
    const lookbackDays = this.readNonNegativeInteger(
      'DUTY_DAILY_REPORT_LOCAL_SCHEDULER_LOOKBACK_DAYS',
      DEFAULT_RECONCILE_LOOKBACK_DAYS,
    );
    for (const run of getDueDutyDailyReportRuns(now, lookbackDays)) {
      await this.runSafely(run);
    }
  }

  private async runSafely(run: DutyDailyReportLocalRun): Promise<void> {
    try {
      await this.taskCoordinator.run(run.task, run.date);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `值班日报本地任务执行失败，将在下次巡检重试：task=${run.task}, date=${run.date}, error=${message}`,
      );
    }
  }

  private isEnabled(): boolean {
    if (process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS !== 'true') {
      return false;
    }
    const configured =
      process.env.DUTY_DAILY_REPORT_LOCAL_SCHEDULER_ENABLED
        ?.trim()
        .toLowerCase();
    return !configured || !['0', 'false', 'off', 'no'].includes(configured);
  }

  private readPositiveInteger(name: string, fallback: number): number {
    const configured = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(configured) && configured >= 1_000
      ? configured
      : fallback;
  }

  private readNonNegativeInteger(name: string, fallback: number): number {
    const configured = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(configured) && configured >= 0
      ? configured
      : fallback;
  }
}

export function getNextDutyDailyReportRun(now: Date): DutyDailyReportLocalRun {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = shanghaiNow.getUTCFullYear();
  const month = shanghaiNow.getUTCMonth();
  const day = shanghaiNow.getUTCDate();

  for (const definition of DUTY_DAILY_REPORT_LOCAL_TASKS) {
    const run = buildRun(year, month, day, definition);
    if (run.scheduledAt.getTime() > now.getTime()) {
      return run;
    }
  }

  return buildRun(year, month, day + 1, DUTY_DAILY_REPORT_LOCAL_TASKS[0]);
}

export function getDueDutyDailyReportRuns(
  now: Date,
  lookbackDays = 0,
): DutyDailyReportLocalRun[] {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = shanghaiNow.getUTCFullYear();
  const month = shanghaiNow.getUTCMonth();
  const day = shanghaiNow.getUTCDate();
  const normalizedLookbackDays = Number.isFinite(lookbackDays)
    ? Math.max(0, Math.floor(lookbackDays))
    : 0;

  return Array.from(
    { length: normalizedLookbackDays + 1 },
    (_, index) => day - normalizedLookbackDays + index,
  )
    .flatMap((runDay) =>
      DUTY_DAILY_REPORT_LOCAL_TASKS.map((definition) =>
        buildRun(year, month, runDay, definition),
      ),
    )
    .filter((run) => run.scheduledAt.getTime() <= now.getTime());
}

export function getShanghaiDutyDateKey(now: Date): string {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return [
    shanghaiNow.getUTCFullYear(),
    String(shanghaiNow.getUTCMonth() + 1).padStart(2, '0'),
    String(shanghaiNow.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function buildRun(
  year: number,
  month: number,
  day: number,
  definition: DutyDailyReportLocalTaskDefinition,
): DutyDailyReportLocalRun {
  const scheduledAt = new Date(
    Date.UTC(
      year,
      month,
      day,
      definition.hour,
      definition.minute,
      0,
      0,
    ) - SHANGHAI_OFFSET_MS,
  );
  const shanghaiScheduledAt = new Date(
    scheduledAt.getTime() + SHANGHAI_OFFSET_MS,
  );

  return {
    task: definition.task,
    date: [
      shanghaiScheduledAt.getUTCFullYear(),
      String(shanghaiScheduledAt.getUTCMonth() + 1).padStart(2, '0'),
      String(shanghaiScheduledAt.getUTCDate()).padStart(2, '0'),
    ].join('-'),
    scheduledAt,
  };
}
