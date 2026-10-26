import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { AttendancePeriodicSummaryRun } from './attendance-periodic-summary.scheduler';
import {
  getNextAttendancePeriodicSummaryBatch,
  getRecoverableAttendancePeriodicSummaryRuns,
  isAttendancePeriodicSummaryRunWithinDeliveryWindow,
} from './attendance-periodic-summary.scheduler';
import { AttendancePeriodicSummaryService } from './attendance-periodic-summary.service';
import { summaryKey } from './attendance-periodic-summary.service';

@Injectable()
export class AttendancePeriodicSummaryLocalSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    AttendancePeriodicSummaryLocalSchedulerService.name,
  );
  private nextTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(private readonly service: AttendancePeriodicSummaryService) {}

  onModuleInit(): void {
    if (this.started || !this.isEnabled()) return;
    this.started = true;
    this.logger.log(
      '已启动考勤周期通晒：每周一 10:00 汇总上周、每月 1 日 10:00 汇总上月（Asia/Shanghai）',
    );
    this.scheduleNext();
    this.scheduleStartupRecovery();
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.nextTimer) clearTimeout(this.nextTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.nextTimer = null;
    this.startupTimer = null;
    this.retryTimers.clear();
  }

  private scheduleNext(): void {
    const batch = getNextAttendancePeriodicSummaryBatch(new Date());
    const timer = setTimeout(
      () => {
        this.nextTimer = null;
        void this.runBatch(batch.runs).finally(() => {
          if (this.started) this.scheduleNext();
        });
      },
      Math.max(1_000, batch.scheduledAt.getTime() - Date.now()),
    );
    timer.unref?.();
    if (this.nextTimer) clearTimeout(this.nextTimer);
    this.nextTimer = timer;
  }

  private scheduleStartupRecovery(): void {
    const timer = setTimeout(
      () => {
        this.startupTimer = null;
        void this.runBatch(
          getRecoverableAttendancePeriodicSummaryRuns(new Date()),
        );
      },
      readPositiveInteger(
        'ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS',
        8_000,
      ),
    );
    timer.unref?.();
    this.startupTimer = timer;
  }

  private async runBatch(
    runs: readonly AttendancePeriodicSummaryRun[],
  ): Promise<void> {
    for (const run of runs) await this.runSafely(run);
  }

  private async runSafely(run: AttendancePeriodicSummaryRun): Promise<void> {
    if (!isAttendancePeriodicSummaryRunWithinDeliveryWindow(run, new Date())) {
      return;
    }
    try {
      const result = await this.service.run(run);
      if (result.sent) {
        this.logger.log(
          `考勤${run.period === 'weekly' ? '周' : '月'}度通晒群发完成：${run.startDate} 至 ${run.endDate}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `考勤通晒失败，将定时重试：period=${run.period}, start=${run.startDate}, end=${run.endDate}, error=${safeError(error)}`,
      );
      this.scheduleRetry(run);
    }
  }

  private scheduleRetry(run: AttendancePeriodicSummaryRun): void {
    if (!this.started) return;
    const key = summaryKey(run);
    if (this.retryTimers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(key);
        void this.runSafely(run);
      },
      readPositiveInteger(
        'ATTENDANCE_PERIODIC_SUMMARY_RETRY_DELAY_MS',
        5 * 60_000,
      ),
    );
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  private isEnabled(): boolean {
    if (
      /^(1|true|on|yes)$/iu.test(
        process.env.NANTONG_HOTFIX_SMOKE_MODE?.trim() || '',
      )
    ) {
      return false;
    }
    const dedicated =
      process.env.ATTENDANCE_PERIODIC_SUMMARY_ENABLED?.trim() || '';
    if (dedicated) return /^(1|true|on|yes)$/iu.test(dedicated);
    return (
      process.env.NODE_ENV === 'production' &&
      /^(1|true|on|yes)$/iu.test(
        process.env.ATTENDANCE_AUTOMATION_ENABLED?.trim() || '',
      )
    );
  }
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
