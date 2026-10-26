import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  AliMonthlyReportTaskCoordinatorService,
  type AliMonthlyReportAutomationPeriod,
} from './ali-monthly-report-task-coordinator.service';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 60_000;
const PRIMARY_SCHEDULE_DAY = 3;
const CATCH_UP_SCHEDULE_DAY = 5;
const SCHEDULED_HOUR = 9;

@Injectable()
export class AliMonthlyReportScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AliMonthlyReportScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly coordinator: AliMonthlyReportTaskCoordinatorService,
  ) {}

  onModuleInit(): void {
    if (!isAliMonthlyReportSchedulerEnabled()) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const scheduledPeriod = resolveScheduledAliMonthlyReportPeriod(now);
    if (!scheduledPeriod) return;

    try {
      const periods = resolveDueAliMonthlyReportPeriods([], scheduledPeriod);
      for (const period of periods) {
        try {
          await this.coordinator.runDue(period, now);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `阿里月报自动任务 ${period.year}年${period.month}月执行失败：${message}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`读取阿里月报自动任务账本失败：${message}`);
    }
  }
}

export function isAliMonthlyReportSchedulerEnabled(
  value = process.env.ALI_MONTHLY_REPORT_SCHEDULER_ENABLED,
): boolean {
  return (
    String(value || '')
      .trim()
      .toLowerCase() !== 'false'
  );
}

export function resolveLatestDueAliMonthlyReportPeriod(
  now: Date,
): AliMonthlyReportAutomationPeriod {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = shanghai.getUTCFullYear();
  const monthIndex = shanghai.getUTCMonth();
  const day = shanghai.getUTCDate();
  const hour = shanghai.getUTCHours();
  const currentMonthDueHasPassed = day > 3 || (day === 3 && hour >= 9);

  const dueMonth = new Date(
    Date.UTC(year, monthIndex - (currentMonthDueHasPassed ? 0 : 1), 1),
  );
  const reportMonth = new Date(
    Date.UTC(dueMonth.getUTCFullYear(), dueMonth.getUTCMonth() - 1, 1),
  );
  return {
    year: reportMonth.getUTCFullYear(),
    month: reportMonth.getUTCMonth() + 1,
  };
}

export function resolveScheduledAliMonthlyReportPeriod(
  now: Date,
): AliMonthlyReportAutomationPeriod | null {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const day = shanghai.getUTCDate();
  const hour = shanghai.getUTCHours();
  const minute = shanghai.getUTCMinutes();

  if (
    minute !== 0 ||
    hour !== SCHEDULED_HOUR ||
    (day !== PRIMARY_SCHEDULE_DAY && day !== CATCH_UP_SCHEDULE_DAY)
  ) {
    return null;
  }

  return resolveLatestDueAliMonthlyReportPeriod(now);
}

export function resolveDueAliMonthlyReportPeriods(
  existingIncompletePeriods: readonly AliMonthlyReportAutomationPeriod[],
  latestDuePeriod: AliMonthlyReportAutomationPeriod,
): AliMonthlyReportAutomationPeriod[] {
  const latestOrdinal = periodOrdinal(latestDuePeriod);
  const periods = new Map<string, AliMonthlyReportAutomationPeriod>();
  for (const period of existingIncompletePeriods) {
    if (periodOrdinal(period) > latestOrdinal) continue;
    periods.set(periodKey(period), period);
  }
  periods.set(periodKey(latestDuePeriod), latestDuePeriod);
  return [...periods.values()].sort(
    (left, right) => periodOrdinal(left) - periodOrdinal(right),
  );
}

function periodOrdinal(period: AliMonthlyReportAutomationPeriod): number {
  return period.year * 12 + period.month - 1;
}

function periodKey(period: AliMonthlyReportAutomationPeriod): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`;
}
