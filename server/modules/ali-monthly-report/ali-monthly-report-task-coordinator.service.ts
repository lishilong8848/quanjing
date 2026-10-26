import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AliMonthlyReportGenerateResponse } from '../../../shared/api.interface';
import { AliMonthlyReportService } from './ali-monthly-report.service';
import {
  ALI_MONTHLY_REPORT_AUTOMATION_TYPES,
  acquireAliMonthlyReportTaskLease,
  aliMonthlyReportPeriodKey,
  createAliMonthlyReportPeriodState,
  readAliMonthlyReportTaskStateFile,
  writeAliMonthlyReportTaskStateFile,
  type AliMonthlyReportAutomationPeriodState,
  type AliMonthlyReportAutomationSummary,
  type AliMonthlyReportAutomationSummaryTask,
  type AliMonthlyReportAutomationType,
  type AliMonthlyReportTaskStateOptions,
} from './ali-monthly-report-task-state';

export const ALI_MONTHLY_REPORT_COORDINATOR_OPTIONS = Symbol(
  'ALI_MONTHLY_REPORT_COORDINATOR_OPTIONS',
);

export interface AliMonthlyReportAutomationPeriod {
  year: number;
  month: number;
}

export interface AliMonthlyReportTaskCoordinatorOptions extends AliMonthlyReportTaskStateOptions {
  retryIntervalMs?: number;
  leaseTimeoutMs?: number;
}

export interface AliMonthlyReportAutomationServiceContract {
  generateForAutomation(
    reportType: AliMonthlyReportAutomationType,
    year: number,
    month: number,
  ): Promise<AliMonthlyReportGenerateResponse>;
  sendAutomationSummary(
    summary: AliMonthlyReportAutomationSummary,
  ): Promise<unknown>;
}

const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class AliMonthlyReportTaskCoordinatorService {
  private activePromise: Promise<AliMonthlyReportAutomationSummary | null> | null =
    null;

  constructor(
    @Inject(AliMonthlyReportService)
    private readonly service: AliMonthlyReportAutomationServiceContract,
    @Optional()
    @Inject(ALI_MONTHLY_REPORT_COORDINATOR_OPTIONS)
    private readonly options: AliMonthlyReportTaskCoordinatorOptions = {},
  ) {}

  listExistingIncompletePeriods(): AliMonthlyReportAutomationPeriod[] {
    const state = readAliMonthlyReportTaskStateFile(this.getStateOptions());
    return Object.values(state.periods)
      .filter((periodState) => periodNeedsWork(periodState))
      .map(({ year, month }) => ({ year, month }))
      .sort(comparePeriods);
  }

  runDue(
    period: AliMonthlyReportAutomationPeriod,
    now = new Date(),
  ): Promise<AliMonthlyReportAutomationSummary | null> {
    if (this.activePromise) return this.activePromise;

    const active = this.executeDue(period, now);
    this.activePromise = active;
    active.then(
      () => this.clearActivePromise(active),
      () => this.clearActivePromise(active),
    );
    return active;
  }

  private clearActivePromise(
    completed: Promise<AliMonthlyReportAutomationSummary | null>,
  ): void {
    if (this.activePromise === completed) this.activePromise = null;
  }

  private async executeDue(
    period: AliMonthlyReportAutomationPeriod,
    now: Date,
  ): Promise<AliMonthlyReportAutomationSummary | null> {
    assertPeriod(period);
    const stateOptions = this.getStateOptions();
    const lease = acquireAliMonthlyReportTaskLease({
      ...stateOptions,
      leaseTimeoutMs: this.options.leaseTimeoutMs,
      now,
    });
    if (!lease) return null;

    try {
      return await this.executeLockedDue(period, now, stateOptions);
    } finally {
      lease.release();
    }
  }

  private async executeLockedDue(
    period: AliMonthlyReportAutomationPeriod,
    now: Date,
    stateOptions: AliMonthlyReportTaskStateOptions,
  ): Promise<AliMonthlyReportAutomationSummary | null> {
    const state = readAliMonthlyReportTaskStateFile(stateOptions);
    const periodKey = aliMonthlyReportPeriodKey(period.year, period.month);
    const periodState =
      state.periods[periodKey] ||
      createAliMonthlyReportPeriodState(period.year, period.month, now);
    state.periods[periodKey] = periodState;

    const retryIntervalMs = this.getRetryIntervalMs();
    const taskTypes = ALI_MONTHLY_REPORT_AUTOMATION_TYPES.filter(
      (reportType) => periodState.tasks[reportType].status !== 'succeeded',
    );

    if (!taskTypes.length) {
      const fingerprint = buildSummaryFingerprint(periodState);
      if (periodState.lastNotifiedFingerprint === fingerprint) return null;
      if (
        !isRetryDue(periodState.lastNotificationAttemptAt, now, retryIntervalMs)
      ) {
        return null;
      }
      const summary = buildSummary(periodState, now, now, fingerprint);
      await this.notifyAndPersist(
        state,
        periodState,
        summary,
        fingerprint,
        now,
      );
      return summary;
    }

    if (!isRetryDue(periodState.lastAttemptAt, now, retryIntervalMs)) {
      return null;
    }

    periodState.lastAttemptAt = now.toISOString();
    writeAliMonthlyReportTaskStateFile(state, stateOptions);

    const operations = taskTypes.map((reportType) => {
      try {
        return Promise.resolve(
          this.service.generateForAutomation(
            reportType,
            period.year,
            period.month,
          ),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    });
    const settled = await Promise.allSettled(operations);
    const finishedAt = new Date();

    settled.forEach((result, index) => {
      const reportType = taskTypes[index];
      const previous = periodState.tasks[reportType];
      const attempts = previous.attempts + 1;
      if (result.status === 'fulfilled') {
        const response = result.value;
        const recordUrl = response.bitableRecordUrls?.find(Boolean)?.trim();
        if (response.success === true && recordUrl) {
          periodState.tasks[reportType] = {
            status: 'succeeded',
            attempts,
            updatedAt: finishedAt.toISOString(),
            fileName: response.files[0]?.name,
            recordUrl,
          };
          return;
        }
        periodState.tasks[reportType] = failedTask(
          attempts,
          finishedAt,
          response.success === false
            ? response.message || '生成或上传失败'
            : '未返回多维表记录链接',
        );
        return;
      }
      periodState.tasks[reportType] = failedTask(
        attempts,
        finishedAt,
        errorMessage(result.reason),
      );
    });

    writeAliMonthlyReportTaskStateFile(state, stateOptions);
    const fingerprint = buildSummaryFingerprint(periodState);
    const summary = buildSummary(periodState, now, finishedAt, fingerprint);
    if (periodState.lastNotifiedFingerprint !== fingerprint) {
      await this.notifyAndPersist(
        state,
        periodState,
        summary,
        fingerprint,
        now,
      );
    }
    return summary;
  }

  private async notifyAndPersist(
    state: ReturnType<typeof readAliMonthlyReportTaskStateFile>,
    periodState: AliMonthlyReportAutomationPeriodState,
    summary: AliMonthlyReportAutomationSummary,
    fingerprint: string,
    attemptedAt: Date,
  ): Promise<void> {
    periodState.lastNotificationAttemptAt = attemptedAt.toISOString();
    summary.notificationFingerprint = fingerprint;
    try {
      await this.service.sendAutomationSummary(summary);
      periodState.lastNotifiedFingerprint = fingerprint;
      delete periodState.lastNotificationError;
      summary.notificationSent = true;
    } catch (error) {
      const message = errorMessage(error);
      periodState.lastNotificationError = message;
      summary.notificationSent = false;
      summary.notificationError = message;
    }
    writeAliMonthlyReportTaskStateFile(state, this.getStateOptions());
  }

  private getStateOptions(): AliMonthlyReportTaskStateOptions {
    return {
      statePath: this.options.statePath,
      cwd: this.options.cwd,
      nodeEnv: this.options.nodeEnv,
    };
  }

  private getRetryIntervalMs(): number {
    const configured = this.options.retryIntervalMs;
    return Number.isFinite(configured) && Number(configured) >= 1_000
      ? Math.floor(Number(configured))
      : DEFAULT_RETRY_INTERVAL_MS;
  }
}

function assertPeriod(period: AliMonthlyReportAutomationPeriod): void {
  if (
    !Number.isInteger(period.year) ||
    period.year < 2000 ||
    period.year > 2200 ||
    !Number.isInteger(period.month) ||
    period.month < 1 ||
    period.month > 12
  ) {
    throw new Error('阿里月报自动任务月份无效');
  }
}

function isRetryDue(
  previousIso: string | undefined,
  now: Date,
  retryIntervalMs: number,
): boolean {
  if (!previousIso) return true;
  const previous = Date.parse(previousIso);
  if (!Number.isFinite(previous)) return true;
  return now.getTime() - previous >= retryIntervalMs;
}

function failedTask(attempts: number, finishedAt: Date, error: string) {
  return {
    status: 'failed' as const,
    attempts,
    updatedAt: finishedAt.toISOString(),
    error,
  };
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  return (singleLine || '未知错误').slice(0, 800);
}

function buildSummaryFingerprint(
  periodState: AliMonthlyReportAutomationPeriodState,
): string {
  return JSON.stringify(
    ALI_MONTHLY_REPORT_AUTOMATION_TYPES.map((reportType) => {
      const task = periodState.tasks[reportType];
      return task.status === 'succeeded'
        ? [reportType, 'succeeded']
        : [reportType, 'failed', normalizeFingerprintError(task.error)];
    }),
  );
}

function periodNeedsWork(
  periodState: AliMonthlyReportAutomationPeriodState,
): boolean {
  if (
    ALI_MONTHLY_REPORT_AUTOMATION_TYPES.some(
      (reportType) => periodState.tasks[reportType].status !== 'succeeded',
    )
  ) {
    return true;
  }
  return (
    periodState.lastNotifiedFingerprint !== buildSummaryFingerprint(periodState)
  );
}

function comparePeriods(
  left: AliMonthlyReportAutomationPeriod,
  right: AliMonthlyReportAutomationPeriod,
): number {
  return left.year - right.year || left.month - right.month;
}

function normalizeFingerprintError(error: string | undefined): string {
  const normalized = String(error || '未知错误')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const category = classifyFingerprintError(normalized);
  if (category) return `category:${category}`;

  return normalized
    .replace(
      /\b(?:request|trace|span|log|correlation)[_-]?id\s*[:=]\s*["']?[\w.-]+["']?/gi,
      '<id>',
    )
    .replace(
      /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/gi,
      '<timestamp>',
    )
    .replace(
      /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ t]\d{1,2}:\d{2}(?::\d{2})?)?\b/g,
      '<timestamp>',
    )
    .replace(
      /\b[a-z]:\\(?:temp|windows\\temp|users\\[^\\\s]+\\appdata\\local\\temp)\\[^\s"'<>|]*/gi,
      '<temp-path>',
    )
    .replace(/\/(?:var\/)?tmp\/[^\s"'<>]*/gi, '<temp-path>')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '<uuid>',
    )
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|秒)\b/gi,
      '<duration>',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function classifyFingerprintError(error: string): string | undefined {
  const categories: ReadonlyArray<readonly [string, RegExp]> = [
    ['timeout', /\b(?:timeout|timed out|readtimeout)\b|超时/i],
    [
      'permission',
      /\b(?:permission denied|forbidden|http 403|status 403)\b|权限不足|无权限/i,
    ],
    [
      'authentication',
      /\b(?:unauthorized|http 401|status 401)\b|鉴权失败|认证失败/i,
    ],
    [
      'rate-limit',
      /\b(?:rate limit|too many requests|http 429|status 429)\b|限流/i,
    ],
    [
      'network',
      /\b(?:econnreset|econnrefused|enotfound|socket hang up|network error)\b|网络错误|网络异常/i,
    ],
    [
      'dependency',
      /\b(?:module not found|no module named|pip install)\b|python 依赖/i,
    ],
    ['configuration', /\b(?:missing config|required config)\b|缺少.*配置/i],
  ];
  return categories.find(([, pattern]) => pattern.test(error))?.[0];
}

function buildSummary(
  periodState: AliMonthlyReportAutomationPeriodState,
  startedAt: Date,
  finishedAt: Date,
  notificationFingerprint: string,
): AliMonthlyReportAutomationSummary {
  const tasks: AliMonthlyReportAutomationSummaryTask[] =
    ALI_MONTHLY_REPORT_AUTOMATION_TYPES.map((reportType) => {
      const task = periodState.tasks[reportType];
      return {
        reportType,
        status: task.status === 'succeeded' ? 'succeeded' : 'failed',
        attempts: task.attempts,
        fileName: task.fileName,
        recordUrl: task.recordUrl,
        error:
          task.status === 'succeeded'
            ? undefined
            : task.error || '任务尚未完成',
      };
    });
  const succeeded = tasks.filter((task) => task.status === 'succeeded').length;
  const failed = tasks.length - succeeded;
  return {
    taskId: buildTaskId(periodState.year, periodState.month, startedAt),
    year: periodState.year,
    month: periodState.month,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status:
      failed === 0
        ? 'success'
        : succeeded === 0
          ? 'failure'
          : 'partial_failure',
    succeeded,
    failed,
    notificationFingerprint,
    tasks,
  };
}

function buildTaskId(year: number, month: number, now: Date): string {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const timestamp = [
    shanghai.getUTCFullYear(),
    String(shanghai.getUTCMonth() + 1).padStart(2, '0'),
    String(shanghai.getUTCDate()).padStart(2, '0'),
    String(shanghai.getUTCHours()).padStart(2, '0'),
    String(shanghai.getUTCMinutes()).padStart(2, '0'),
    String(shanghai.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  return `AMR-${year}${String(month).padStart(2, '0')}-${timestamp}`;
}
