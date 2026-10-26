import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { TodayOperationsAnomalyService } from './today-operations-anomaly.service';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const SCHEDULE_HOUR = 8;
const SCHEDULE_MINUTE = 30;

export interface TodayOperationsAnomalyRun {
  businessDate: string;
  scheduledAt: Date;
}

@Injectable()
export class TodayOperationsAnomalyScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TodayOperationsAnomalyScheduler.name);
  private nextTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private started = false;

  constructor(private readonly service: TodayOperationsAnomalyService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (this.started || !this.isEnabled()) return;
      this.started = true;
      this.logger.log(
        '已启动今日航图异常提醒：每日 08:30（Asia/Shanghai），启动补跑及每 15 分钟后台任务重试',
      );
      this.scheduleNext();
      const timer = setTimeout(
        () => {
          this.startupTimer = null;
          void this.reconcile().finally(() => this.startInterval());
        },
        readPositiveInteger('TODAY_OPERATIONS_ANOMALY_STARTUP_DELAY_MS', 5_000),
      );
      timer.unref?.();
      this.startupTimer = timer;
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.started = false;
    if (this.nextTimer) clearTimeout(this.nextTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.nextTimer = null;
    this.startupTimer = null;
    this.reconcileTimer = null;
  }

  private scheduleNext(): void {
    const run = getNextTodayOperationsAnomalyRun(new Date());
    const timer = setTimeout(
      () => {
        this.nextTimer = null;
        void this.runSafely(run).finally(() => {
          if (this.started) this.scheduleNext();
        });
      },
      Math.max(1_000, run.scheduledAt.getTime() - Date.now()),
    );
    timer.unref?.();
    if (this.nextTimer) clearTimeout(this.nextTimer);
    this.nextTimer = timer;
  }

  private startInterval(): void {
    if (!this.started) return;
    const timer = setInterval(
      () => void this.reconcile(),
      readPositiveInteger(
        'TODAY_OPERATIONS_ANOMALY_RECONCILE_INTERVAL_MS',
        15 * 60_000,
      ),
    );
    timer.unref?.();
    this.reconcileTimer = timer;
  }

  private reconcile(): Promise<void> {
    if (this.active) return this.active;
    let execution!: Promise<void>;
    execution = (async () => {
      const due = getDueTodayOperationsAnomalyRun(new Date());
      const discoveryExecuted = due ? await this.runSafely(due) : false;
      if (!discoveryExecuted) {
        if (due) {
          try {
            const result =
              await this.service.reconcileScheduleConsistencyForBusinessDate(
                due.businessDate,
              );
            if (result.changed) {
              this.logger.log(
                `今日航图排班一致性复核完成：date=${due.businessDate}, detected=${result.detected}, autoResolved=${result.autoResolved}`,
              );
            }
          } catch (error) {
            this.logger.warn(
              `今日航图排班一致性复核失败，将在下轮重试：date=${due.businessDate}, error=${safeError(error)}`,
            );
          }
        }
        const pending = await this.service.runPendingTasks();
        if (pending.failed > 0) {
          this.logger.warn(
            `今日航图异常后台任务仍有 ${pending.failed} 项待重试`,
          );
        }
      }
    })().finally(() => {
      if (this.active === execution) this.active = null;
    });
    this.active = execution;
    return execution;
  }

  private async runSafely(run: TodayOperationsAnomalyRun): Promise<boolean> {
    try {
      if (await this.service.isBusinessDateScanCompleted(run.businessDate)) {
        return false;
      }
      const result = await this.service.runForBusinessDate(run.businessDate);
      await this.service.markBusinessDateScanCompleted(run.businessDate);
      this.logger.log(
        `今日航图异常扫描完成：date=${run.businessDate}, detected=${result.detected}, processed=${result.provisioned}, failed=${result.failed}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `今日航图异常扫描失败，将在巡检时重试：date=${run.businessDate}, error=${safeError(error)}`,
      );
      return false;
    }
  }

  private isEnabled(): boolean {
    if (process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS !== 'true') return false;
    const configured =
      process.env.TODAY_OPERATIONS_ANOMALY_SCHEDULER_ENABLED?.trim().toLowerCase();
    if (configured && ['0', 'false', 'off', 'no'].includes(configured)) {
      return false;
    }
    return this.service.isEnabled();
  }
}

export function getNextTodayOperationsAnomalyRun(
  now: Date,
): TodayOperationsAnomalyRun {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const today = buildRun(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  return today.scheduledAt.getTime() > now.getTime()
    ? today
    : buildRun(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() + 1,
      );
}

export function getDueTodayOperationsAnomalyRun(
  now: Date,
): TodayOperationsAnomalyRun | null {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const run = buildRun(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  return run.scheduledAt.getTime() <= now.getTime() ? run : null;
}

function buildRun(
  year: number,
  month: number,
  day: number,
): TodayOperationsAnomalyRun {
  const scheduledAt = new Date(
    Date.UTC(year, month, day, SCHEDULE_HOUR, SCHEDULE_MINUTE) -
      SHANGHAI_OFFSET_MS,
  );
  const local = new Date(scheduledAt.getTime() + SHANGHAI_OFFSET_MS);
  return {
    businessDate: [
      local.getUTCFullYear(),
      String(local.getUTCMonth() + 1).padStart(2, '0'),
      String(local.getUTCDate()).padStart(2, '0'),
    ].join('-'),
    scheduledAt,
  };
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 300);
}
