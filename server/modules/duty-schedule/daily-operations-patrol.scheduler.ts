import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DailyOperationsPatrolService } from './daily-operations-patrol.service';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const SCHEDULE_HOUR = 9;
const SCHEDULE_MINUTE = 30;
const CUTOFF_HOUR = 10;
const CUTOFF_MINUTE = 0;

export interface DailyOperationsPatrolRun {
  businessDate: string;
  scheduledAt: Date;
}

@Injectable()
export class DailyOperationsPatrolScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DailyOperationsPatrolScheduler.name);
  private nextTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private started = false;

  constructor(private readonly service: DailyOperationsPatrolService) {}

  onModuleInit(): void {
    if (this.started || !this.isEnabled()) return;
    this.started = true;
    this.logger.log(
      '已启动南通每日运维巡视同步：每日 09:30（Asia/Shanghai），09:30-10:00 内失败重试',
    );
    this.scheduleNext();
    this.scheduleStartupReconcile();
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.nextTimer) clearTimeout(this.nextTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.nextTimer = null;
    this.startupTimer = null;
    this.retryTimer = null;
  }

  private scheduleNext(): void {
    const run = getNextDailyOperationsPatrolRun(new Date());
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

  private scheduleStartupReconcile(): void {
    const timer = setTimeout(
      () => {
        this.startupTimer = null;
        void this.reconcile().finally(() => {
          if (this.started) this.startRetryInterval();
        });
      },
      readPositiveInteger('NANTONG_DAILY_PATROL_STARTUP_DELAY_MS', 5_000),
    );
    timer.unref?.();
    this.startupTimer = timer;
  }

  private startRetryInterval(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    const timer = setInterval(
      () => void this.reconcile(),
      readPositiveInteger(
        'NANTONG_DAILY_PATROL_RETRY_INTERVAL_MS',
        5 * 60_000,
      ),
    );
    timer.unref?.();
    this.retryTimer = timer;
  }

  private reconcile(): Promise<void> {
    if (this.active) return this.active;
    const run = getDueDailyOperationsPatrolRun(new Date());
    if (!run) return Promise.resolve();
    let execution!: Promise<void>;
    execution = this.runSafely(run).finally(() => {
      if (this.active === execution) this.active = null;
    });
    this.active = execution;
    return execution;
  }

  private async runSafely(run: DailyOperationsPatrolRun): Promise<void> {
    try {
      const result = await this.service.runForBusinessDate(run.businessDate);
      if (result.sent) {
        this.logger.log(`南通每日运维巡视同步完成：${run.businessDate}`);
      }
    } catch (error) {
      this.logger.error(
        `南通每日运维巡视同步失败，将在有效窗口内重试：date=${run.businessDate}, error=${safeError(error)}`,
      );
    }
  }

  private isEnabled(): boolean {
    if (process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS !== 'true') return false;
    return this.service.isEnabled();
  }
}

export function getNextDailyOperationsPatrolRun(
  now: Date,
): DailyOperationsPatrolRun {
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

export function getDueDailyOperationsPatrolRun(
  now: Date,
): DailyOperationsPatrolRun | null {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const run = buildRun(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const cutoff =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      CUTOFF_HOUR,
      CUTOFF_MINUTE,
    ) - SHANGHAI_OFFSET_MS;
  return now.getTime() >= run.scheduledAt.getTime() && now.getTime() < cutoff
    ? run
    : null;
}

function buildRun(
  year: number,
  month: number,
  day: number,
): DailyOperationsPatrolRun {
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
  return (error instanceof Error ? error.message : String(error || '未知错误'))
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 500);
}
