import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { OvertimeWorkflowService } from './overtime-workflow.service';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const REMINDER_HOUR = 9;
const REMINDER_RETRY_DELAY_MS = 60_000;
const MAX_REMINDER_RETRY_ATTEMPTS = 3;

@Injectable()
export class OvertimeWorkflowScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OvertimeWorkflowScheduler.name);
  private taskTimer: NodeJS.Timeout | null = null;
  private reminderTimer: NodeJS.Timeout | null = null;
  private reminderRetryTimer: NodeJS.Timeout | null = null;
  private taskRunInProgress = false;
  private reminderRunInProgress = false;
  private reminderRetryAttempts = 0;
  private started = false;

  constructor(private readonly service: OvertimeWorkflowService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (this.started) return;
      if (!this.service.isEnabled()) {
        this.logger.log('加班审批程序工作流未启用，后台调度未启动');
        return;
      }
      this.started = true;
      this.taskTimer = setInterval(
        () => void this.pollPendingTasks(),
        readTaskPollIntervalMs(),
      );
      this.taskTimer.unref?.();
      this.scheduleReminder();
      const now = new Date();
      if (shouldCatchUpOvertimeConfirmationReminders(now)) {
        void this.scanConfirmationReminders();
      } else {
        void this.pollPendingTasks();
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.started = false;
    if (this.taskTimer) clearInterval(this.taskTimer);
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.resetReminderRetry();
    this.taskTimer = null;
    this.reminderTimer = null;
  }

  async runNow(now: Date | number = new Date()): Promise<{
    remindersCreated: number;
    processed: number;
    failed: number;
  }> {
    const remindersCreated =
      await this.service.enqueueDueConfirmationReminders(now);
    const result = await this.service.runPendingTasks(now);
    return { remindersCreated, ...result };
  }

  private async pollPendingTasks(): Promise<void> {
    if (this.taskRunInProgress) return;
    this.taskRunInProgress = true;
    try {
      const cardRefresh = await this.service.refreshPendingConfirmationCards();
      if (cardRefresh.failed > 0) {
        this.logger.warn(
          `待确认加班卡片有 ${cardRefresh.failed} 条换链失败，将在下轮重试`,
        );
      }
      await this.service.runPendingTasks();
    } catch (error) {
      this.logger.error(
        `加班工作流后台任务轮询失败：${safeErrorMessage(error)}`,
      );
    } finally {
      this.taskRunInProgress = false;
    }
  }

  private async scanConfirmationReminders(): Promise<void> {
    if (this.reminderRunInProgress) return;
    this.reminderRunInProgress = true;
    try {
      await this.service.enqueueDueConfirmationReminders();
      await this.pollPendingTasks();
      this.resetReminderRetry();
    } catch (error) {
      this.logger.error(`加班确认每日提醒扫描失败：${safeErrorMessage(error)}`);
      this.scheduleReminderRetry();
    } finally {
      this.reminderRunInProgress = false;
    }
  }

  private scheduleReminderRetry(): void {
    if (
      !this.started ||
      this.reminderRetryTimer ||
      this.reminderRetryAttempts >= MAX_REMINDER_RETRY_ATTEMPTS
    ) {
      return;
    }
    this.reminderRetryAttempts += 1;
    this.reminderRetryTimer = setTimeout(() => {
      this.reminderRetryTimer = null;
      void this.scanConfirmationReminders();
    }, REMINDER_RETRY_DELAY_MS);
    this.reminderRetryTimer.unref?.();
  }

  private resetReminderRetry(): void {
    if (this.reminderRetryTimer) clearTimeout(this.reminderRetryTimer);
    this.reminderRetryTimer = null;
    this.reminderRetryAttempts = 0;
  }

  private scheduleReminder(): void {
    const delay = Math.max(
      1_000,
      nextOvertimeConfirmationReminderRun(new Date()).getTime() - Date.now(),
    );
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = null;
      this.resetReminderRetry();
      void this.scanConfirmationReminders().finally(() => {
        if (this.started) this.scheduleReminder();
      });
    }, delay);
    this.reminderTimer.unref?.();
  }
}

export function nextOvertimeConfirmationReminderRun(now: Date): Date {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  let candidate =
    Date.UTC(
      shanghai.getUTCFullYear(),
      shanghai.getUTCMonth(),
      shanghai.getUTCDate(),
      REMINDER_HOUR,
      0,
      0,
      0,
    ) - SHANGHAI_OFFSET_MS;
  if (candidate <= now.getTime()) candidate += ONE_DAY_MS;
  return new Date(candidate);
}

export function shouldCatchUpOvertimeConfirmationReminders(now: Date): boolean {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return shanghai.getUTCHours() >= REMINDER_HOUR;
}

function readTaskPollIntervalMs(): number {
  const configured = Number(readEnv('OVERTIME_WORKFLOW_TASK_POLL_INTERVAL_MS'));
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.floor(configured)
    : 5_000;
}

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || '');
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b(secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 300);
}
