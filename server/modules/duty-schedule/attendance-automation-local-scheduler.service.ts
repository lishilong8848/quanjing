import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AttendanceAutomationCoordinatorService } from './attendance-automation-coordinator.service';
import {
  getDueAttendanceAutomationRuns,
  getNextAttendanceAutomationRun,
  type AttendanceAutomationRun,
} from './attendance-automation.scheduler';
import { getShanghaiDateKey } from './today-attendance.tasks';
import { getFeishuCardActionConsumerProfile } from '../../common/config/external-services.config';

@Injectable()
export class AttendanceAutomationLocalSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    AttendanceAutomationLocalSchedulerService.name,
  );
  private nextRunTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private externalSyncTimer: NodeJS.Timeout | null = null;
  private started = false;
  private startupAt: Date | null = null;

  constructor(
    private readonly coordinator: AttendanceAutomationCoordinatorService,
  ) {}

  onModuleInit(): void {
    if (this.started || !this.isEnabled()) return;
    this.started = true;
    this.startupAt = new Date();
    this.logger.log(
      '已启动限额考勤自动化：00:30 昨日归档及前两日异常复查；08:55/17:55 仅同步多维表；09:30/18:35 最终核验失败均按持久化次数与时间窗有界重试（Asia/Shanghai）',
    );
    this.scheduleNextRun();
    this.scheduleStartupRecovery();
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.nextRunTimer) clearTimeout(this.nextRunTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.externalSyncTimer) clearTimeout(this.externalSyncTimer);
    this.nextRunTimer = null;
    this.startupTimer = null;
    this.recoveryTimer = null;
    this.externalSyncTimer = null;
    this.startupAt = null;
  }

  private scheduleNextRun(afterScheduledAt?: Date): AttendanceAutomationRun {
    const now = new Date();
    const effectiveFrom =
      process.env.ATTENDANCE_AUTOMATION_EFFECTIVE_FROM?.trim() || '2026-08-28';
    const overdueFinalRun = afterScheduledAt
      ? getDueAttendanceAutomationRuns(now, 0, effectiveFrom)
          .filter(
            (candidate) =>
              isFinalAttendanceCheck(candidate) &&
              candidate.date === getShanghaiDateKey(now) &&
              candidate.scheduledAt.getTime() > afterScheduledAt.getTime(),
          )
          .sort(
            (left, right) =>
              left.scheduledAt.getTime() - right.scheduledAt.getTime(),
          )[0]
      : undefined;
    const run = overdueFinalRun || getNextAttendanceAutomationRun(now);
    const timer = setTimeout(
      () => {
        this.nextRunTimer = null;
        const queuedNextRun = this.started
          ? this.scheduleNextRun(run.scheduledAt)
          : null;
        const queuedNextTimer = this.nextRunTimer;
        void this.runSafely(run)
          .then((succeeded) => {
            if (!succeeded) this.scheduleFinalRecovery(run);
          })
          .finally(() => {
            if (
              this.started &&
              queuedNextRun &&
              queuedNextTimer &&
              this.nextRunTimer === queuedNextTimer &&
              queuedNextRun.scheduledAt.getTime() < Date.now()
            ) {
              this.scheduleNextRun(run.scheduledAt);
            }
          });
      },
      Math.max(1_000, run.scheduledAt.getTime() - Date.now()),
    );
    timer.unref?.();
    if (this.nextRunTimer) clearTimeout(this.nextRunTimer);
    this.nextRunTimer = timer;
    return run;
  }

  private scheduleStartupRecovery(): void {
    const timer = setTimeout(
      () => {
        this.startupTimer = null;
        void this.runStartupRecovery();
      },
      readPositiveInteger('ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS', 5_000),
    );
    timer.unref?.();
    this.startupTimer = timer;
  }

  private async runStartupRecovery(): Promise<void> {
    const now = new Date();
    const effectiveFrom =
      process.env.ATTENDANCE_AUTOMATION_EFFECTIVE_FROM?.trim() || '2026-08-28';
    const ordinaryDue = getDueAttendanceAutomationRuns(
      now,
      0,
      effectiveFrom,
      this.startupAt || now,
      readNonNegativeInteger(
        'ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES',
        24 * 60,
      ),
    );
    const requiredFinalChecks = getDueAttendanceAutomationRuns(
      now,
      0,
      effectiveFrom,
    ).filter((run) => isFinalAttendanceCheck(run));
    const due = [...ordinaryDue, ...requiredFinalChecks]
      .filter(
        (run, index, runs) =>
          runs.findIndex(
            (candidate) =>
              candidate.task === run.task && candidate.date === run.date,
          ) === index,
      )
      .sort(
        (left, right) =>
          left.scheduledAt.getTime() - right.scheduledAt.getTime(),
      );
    for (const run of due) {
      if (!this.started) return;
      if (isFinalAttendanceCheck(run)) {
        const status = this.readRunStatus(run);
        if (
          status?.state === 'failed' &&
          status.finalFailure &&
          !isLegacyEveningPersonalDeliveryFailure(run, status) &&
          !isLegacyCorrectionFailure(status)
        ) {
          continue;
        }
        const nextRetryAt = Date.parse(status?.nextRetryAt || '');
        if (
          status?.state === 'failed' &&
          Number.isFinite(nextRetryAt) &&
          nextRetryAt > Date.now()
        ) {
          this.scheduleFinalRecovery(run);
          continue;
        }
      }
      const succeeded = await this.runSafely(run);
      if (!succeeded) this.scheduleFinalRecovery(run);
    }
    await this.recoverExternalSyncsSafely();
  }

  private async runSafely(run: AttendanceAutomationRun): Promise<boolean> {
    if (
      isFinalAttendanceCheck(run) &&
      run.date !== getShanghaiDateKey(new Date())
    ) {
      return true;
    }
    try {
      const result = (await this.coordinator.run(run)) as {
        inProgress?: boolean;
      } | null;
      return !result?.inProgress;
    } catch (error) {
      this.logger.error(
        `考勤自动化任务失败：task=${run.task}, date=${run.date}, error=${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      await this.recoverExternalSyncsSafely();
    }
  }

  private async recoverExternalSyncsSafely(): Promise<void> {
    try {
      const notify = (
        this.coordinator as AttendanceAutomationCoordinatorService & {
          notifyPendingSyncFailures?: AttendanceAutomationCoordinatorService['notifyPendingSyncFailures'];
        }
      ).notifyPendingSyncFailures;
      if (typeof notify === 'function') {
        await notify.call(this.coordinator);
      }
    } catch (error) {
      this.logger.error(
        `考勤同步故障私信调度失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const recover = (
        this.coordinator as AttendanceAutomationCoordinatorService & {
          recoverPendingAttendanceArchives?: AttendanceAutomationCoordinatorService['recoverPendingAttendanceArchives'];
        }
      ).recoverPendingAttendanceArchives;
      if (typeof recover === 'function') {
        await recover.call(this.coordinator);
      }
    } catch (error) {
      this.logger.error(
        `飞书考勤归档后台续跑调度失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const recover = (
        this.coordinator as AttendanceAutomationCoordinatorService & {
          recoverPendingCorrections?: AttendanceAutomationCoordinatorService['recoverPendingCorrections'];
        }
      ).recoverPendingCorrections;
      if (typeof recover === 'function') {
        await recover.call(this.coordinator);
      }
    } catch (error) {
      this.logger.error(
        `补卡审批后台续跑调度失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const reconcile = (
        this.coordinator as AttendanceAutomationCoordinatorService & {
          reconcileApprovedLeaveAnomalies?: AttendanceAutomationCoordinatorService['reconcileApprovedLeaveAnomalies'];
        }
      ).reconcileApprovedLeaveAnomalies;
      if (typeof reconcile === 'function') {
        await reconcile.call(this.coordinator);
      }
    } catch (error) {
      this.logger.error(
        `已审批请假考勤误报收口失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.scheduleExternalSyncRecovery();
    }
  }

  private scheduleExternalSyncRecovery(): void {
    if (!this.started || this.externalSyncTimer) return;
    const timer = setTimeout(
      () => {
        this.externalSyncTimer = null;
        if (!this.started) return;
        void this.recoverExternalSyncsSafely();
      },
      readPositiveInteger(
        'ATTENDANCE_EXTERNAL_SYNC_RECOVERY_INTERVAL_MS',
        5 * 60_000,
      ),
    );
    timer.unref?.();
    this.externalSyncTimer = timer;
  }

  private scheduleFinalRecovery(run: AttendanceAutomationRun): void {
    if (
      !this.started ||
      this.recoveryTimer ||
      !isFinalAttendanceCheck(run) ||
      run.date !== getShanghaiDateKey(new Date())
    ) {
      return;
    }
    const status = this.readRunStatus(run);
    if (status?.state === 'completed') return;
    if (status?.state === 'failed' && status.finalFailure) return;
    const persistedNextRetryAt = Date.parse(status?.nextRetryAt || '');
    const retryDelay = Number.isFinite(persistedNextRetryAt)
      ? Math.max(1_000, persistedNextRetryAt - Date.now())
      : readPositiveInteger('ATTENDANCE_AUTOMATION_RETRY_DELAY_MS', 5 * 60_000);
    const timer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.started || run.date !== getShanghaiDateKey(new Date())) {
        return;
      }
      void this.runSafely(run).then((succeeded) => {
        if (!succeeded) this.scheduleFinalRecovery(run);
      });
    }, retryDelay);
    timer.unref?.();
    this.recoveryTimer = timer;
  }

  private readRunStatus(run: AttendanceAutomationRun): {
    state?: string;
    nextRetryAt?: string;
    finalFailure?: boolean;
    failureReason?: string;
    failureScope?: string;
    maxAttempts?: number;
  } | null {
    const coordinator = this
      .coordinator as AttendanceAutomationCoordinatorService & {
      getRunStatus?: AttendanceAutomationCoordinatorService['getRunStatus'];
    };
    return typeof coordinator.getRunStatus === 'function'
      ? coordinator.getRunStatus(run.task, run.date)
      : null;
  }

  private isEnabled(): boolean {
    const enabled = /^(1|true|on|yes)$/i.test(
      process.env.ATTENDANCE_AUTOMATION_ENABLED?.trim() || '',
    );
    if (!enabled) return false;
    let runtimeProfile: ReturnType<typeof getFeishuCardActionConsumerProfile>;
    try {
      runtimeProfile = getFeishuCardActionConsumerProfile();
    } catch (error) {
      this.logger.error(
        `考勤自动化未启动：运行角色配置无效，${error instanceof Error ? error.message : '未知错误'}`,
      );
      return false;
    }
    if (runtimeProfile !== 'production') {
      this.logger.log(
        `考勤自动化未启动：当前运行角色为 ${runtimeProfile || '未配置'}，仅 production 角色允许消费生产考勤任务`,
      );
      return false;
    }
    const clientId =
      process.env.DINGTALK_ATTENDANCE_CLIENT_ID?.trim() ||
      process.env.DINGTALK_ATTENDANCE_APP_KEY?.trim();
    const clientSecret =
      process.env.DINGTALK_ATTENDANCE_CLIENT_SECRET?.trim() ||
      process.env.DINGTALK_ATTENDANCE_APP_SECRET?.trim();
    if (!clientId || !clientSecret) {
      this.logger.error(
        '考勤自动化未启动：缺少 DINGTALK_ATTENDANCE_CLIENT_ID 或 DINGTALK_ATTENDANCE_CLIENT_SECRET',
      );
      return false;
    }
    return true;
  }
}

function isFinalAttendanceCheck(run: AttendanceAutomationRun): boolean {
  return (
    run.task === 'morning-off-duty-check' ||
    run.task === 'evening-off-duty-check'
  );
}

function isLegacyEveningPersonalDeliveryFailure(
  run: AttendanceAutomationRun,
  status: {
    failureReason?: string;
    failureScope?: string;
    maxAttempts?: number;
  },
): boolean {
  return (
    run.task === 'evening-off-duty-check' &&
    !status.failureScope &&
    status.maxAttempts === 1 &&
    /个人异常接收人读取失败|个人考勤异常卡片发送失败/u.test(
      status.failureReason || '',
    )
  );
}

function isLegacyCorrectionFailure(status: {
  failureReason?: string;
}): boolean {
  return /钉钉补卡审批查询失败|补卡记录及举证同步失败/u.test(
    status.failureReason || '',
  );
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
