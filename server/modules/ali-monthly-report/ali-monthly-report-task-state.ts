import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ALI_MONTHLY_REPORT_AUTOMATION_TYPES = [
  'alarm_analysis',
  'over_power',
  'staff_roster',
] as const;

export type AliMonthlyReportAutomationType =
  (typeof ALI_MONTHLY_REPORT_AUTOMATION_TYPES)[number];

export type AliMonthlyReportAutomationTaskStatus =
  | 'pending'
  | 'succeeded'
  | 'failed';

export interface AliMonthlyReportAutomationTaskState {
  status: AliMonthlyReportAutomationTaskStatus;
  attempts: number;
  updatedAt: string;
  fileName?: string;
  recordUrl?: string;
  error?: string;
}

export interface AliMonthlyReportAutomationPeriodState {
  year: number;
  month: number;
  lastAttemptAt?: string;
  lastNotifiedFingerprint?: string;
  lastNotificationAttemptAt?: string;
  lastNotificationError?: string;
  tasks: Record<
    AliMonthlyReportAutomationType,
    AliMonthlyReportAutomationTaskState
  >;
}

export interface AliMonthlyReportAutomationState {
  version: 1;
  periods: Record<string, AliMonthlyReportAutomationPeriodState>;
}

export interface AliMonthlyReportAutomationSummaryTask {
  reportType: AliMonthlyReportAutomationType;
  status: 'succeeded' | 'failed';
  attempts: number;
  fileName?: string;
  recordUrl?: string;
  error?: string;
}

export interface AliMonthlyReportAutomationSummary {
  taskId: string;
  year: number;
  month: number;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'partial_failure' | 'failure';
  succeeded: number;
  failed: number;
  notificationFingerprint: string;
  tasks: AliMonthlyReportAutomationSummaryTask[];
  notificationSent?: boolean;
  notificationError?: string;
}

export interface AliMonthlyReportTaskStateOptions {
  statePath?: string;
  cwd?: string;
  nodeEnv?: string;
}

export interface AliMonthlyReportTaskLeaseOptions extends AliMonthlyReportTaskStateOptions {
  leaseTimeoutMs?: number;
  now?: Date;
}

export interface AliMonthlyReportTaskLease {
  release: () => void;
}

const STATE_FILE_NAME = 'ali-monthly-report-task-state.json';
const PRODUCTION_STATE_DIRECTORY = 'nantong-schedule-state';
const DEFAULT_LEASE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function resolveAliMonthlyReportTaskStatePath(
  options: AliMonthlyReportTaskStateOptions = {},
): string {
  const configuredPath =
    options.statePath?.trim() ||
    process.env.ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH?.trim();
  if (configuredPath) return resolve(configuredPath);
  const cwd = resolve(options.cwd || process.cwd());
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV;
  const stateDirectory =
    nodeEnv === 'production'
      ? join(dirname(cwd), PRODUCTION_STATE_DIRECTORY)
      : join(cwd, '.runtime');
  return join(stateDirectory, STATE_FILE_NAME);
}

export function readAliMonthlyReportTaskStateFile(
  options: AliMonthlyReportTaskStateOptions = {},
): AliMonthlyReportAutomationState {
  const statePath = resolveAliMonthlyReportTaskStatePath(options);
  if (!existsSync(statePath)) return createEmptyAutomationState();

  try {
    return parseAutomationState(readFileSync(statePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`阿里月报自动任务状态文件损坏：${message}`);
  }
}

export function writeAliMonthlyReportTaskStateFile(
  state: AliMonthlyReportAutomationState,
  options: AliMonthlyReportTaskStateOptions = {},
): void {
  const statePath = resolveAliMonthlyReportTaskStatePath(options);
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, statePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function acquireAliMonthlyReportTaskLease(
  options: AliMonthlyReportTaskLeaseOptions = {},
): AliMonthlyReportTaskLease | null {
  const leasePath = `${resolveAliMonthlyReportTaskStatePath(options)}.lock`;
  const now = options.now ?? new Date();
  const leaseTimeoutMs = resolveLeaseTimeoutMs(options.leaseTimeoutMs);
  const token = `${process.pid}:${randomUUID()}`;
  mkdirSync(dirname(leasePath), { recursive: true });

  const acquire = (): boolean => {
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(leasePath, 'wx');
      writeFileSync(
        fileDescriptor,
        `${JSON.stringify({ token, acquiredAt: now.toISOString() })}\n`,
        'utf8',
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    }
  };

  if (!acquire()) {
    if (!isStaleLease(leasePath, now, leaseTimeoutMs)) return null;
    try {
      unlinkSync(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    if (!acquire()) return null;
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        const stored = JSON.parse(readFileSync(leasePath, 'utf8')) as {
          token?: string;
        };
        if (stored.token === token) unlinkSync(leasePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

export function aliMonthlyReportPeriodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function createAliMonthlyReportPeriodState(
  year: number,
  month: number,
  now: Date,
): AliMonthlyReportAutomationPeriodState {
  const updatedAt = now.toISOString();
  return {
    year,
    month,
    tasks: {
      alarm_analysis: { status: 'pending', attempts: 0, updatedAt },
      over_power: { status: 'pending', attempts: 0, updatedAt },
      staff_roster: { status: 'pending', attempts: 0, updatedAt },
    },
  };
}

function createEmptyAutomationState(): AliMonthlyReportAutomationState {
  return { version: 1, periods: {} };
}

function resolveLeaseTimeoutMs(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 1_000
    ? Math.floor(Number(value))
    : DEFAULT_LEASE_TIMEOUT_MS;
}

function isStaleLease(
  leasePath: string,
  now: Date,
  leaseTimeoutMs: number,
): boolean {
  try {
    const stored = JSON.parse(readFileSync(leasePath, 'utf8')) as {
      acquiredAt?: unknown;
    };
    if (typeof stored.acquiredAt === 'string') {
      const acquiredAt = Date.parse(stored.acquiredAt);
      if (Number.isFinite(acquiredAt)) {
        return now.getTime() - acquiredAt >= leaseTimeoutMs;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code) throw error;
  }

  try {
    return now.getTime() - statSync(leasePath).mtimeMs >= leaseTimeoutMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function parseAutomationState(value: string): AliMonthlyReportAutomationState {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.periods)) {
    throw new Error('格式无效');
  }

  const periods: Record<string, AliMonthlyReportAutomationPeriodState> = {};
  for (const [key, rawPeriod] of Object.entries(parsed.periods)) {
    periods[key] = parsePeriodState(rawPeriod);
  }
  return { version: 1, periods };
}

function parsePeriodState(
  value: unknown,
): AliMonthlyReportAutomationPeriodState {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.year) ||
    !Number.isInteger(value.month) ||
    !isRecord(value.tasks)
  ) {
    throw new Error('月份任务格式无效');
  }
  const year = value.year as number;
  const month = value.month as number;
  if (year < 2000 || year > 2200 || month < 1 || month > 12) {
    throw new Error('月份任务日期无效');
  }

  return {
    year,
    month,
    ...optionalStringFields(value, [
      'lastAttemptAt',
      'lastNotifiedFingerprint',
      'lastNotificationAttemptAt',
      'lastNotificationError',
    ]),
    tasks: {
      alarm_analysis: parseTaskState(value.tasks.alarm_analysis),
      over_power: parseTaskState(value.tasks.over_power),
      staff_roster: parseTaskState(value.tasks.staff_roster),
    },
  };
}

function parseTaskState(value: unknown): AliMonthlyReportAutomationTaskState {
  if (
    !isRecord(value) ||
    !['pending', 'succeeded', 'failed'].includes(String(value.status)) ||
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new Error('子任务格式无效');
  }
  return {
    status: value.status as AliMonthlyReportAutomationTaskStatus,
    attempts: value.attempts as number,
    updatedAt: value.updatedAt,
    ...optionalStringFields(value, ['fileName', 'recordUrl', 'error']),
  };
}

function optionalStringFields<T extends string>(
  value: Record<string, unknown>,
  keys: readonly T[],
): Partial<Record<T, string>> {
  const result: Partial<Record<T, string>> = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string') {
      throw new Error(`${key} 类型无效`);
    }
    result[key] = value[key];
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
