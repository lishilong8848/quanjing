import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { readEnv } from '@server/common/config/external-services.config';
import {
  validateChinaWorkCalendarSnapshot,
  type ChinaWorkCalendarSnapshot,
} from '@shared/china-work-calendar';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';

const CHINA_WORK_CALENDAR_STATE_FILE = 'china-work-calendar-state.json';

export interface ChinaWorkCalendarYearCheckState {
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  notPublished?: boolean;
  consecutiveFailures?: number;
}

export interface ChinaWorkCalendarPersistedState {
  schemaVersion: 1;
  snapshot: ChinaWorkCalendarSnapshot;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  nextCheckAt?: string;
  lastError?: string;
  yearChecks?: Record<string, ChinaWorkCalendarYearCheckState>;
}

export interface ChinaWorkCalendarStateStoreOptions {
  cwd?: string;
  nodeEnv?: string;
  explicitPath?: string;
  configuredDirectory?: string;
}

export function resolveChinaWorkCalendarStatePath(
  options: ChinaWorkCalendarStateStoreOptions = {},
): string {
  const explicitPath =
    options.explicitPath?.trim() ||
    readEnv('CHINA_WORK_CALENDAR_STATE_PATH', [
      'DUTY_CHINA_WORK_CALENDAR_STATE_PATH',
    ]);
  const configuredDirectory =
    options.configuredDirectory?.trim() ||
    readEnv('CHINA_WORK_CALENDAR_STATE_DIR', ['DUTY_DAILY_REPORT_STATE_DIR']);

  return resolveDutyDailyReportStateFilePath({
    cwd: options.cwd,
    nodeEnv: options.nodeEnv,
    explicitPath,
    configuredDirectory,
    fileName: CHINA_WORK_CALENDAR_STATE_FILE,
  });
}

export function readChinaWorkCalendarStateFile(
  options: ChinaWorkCalendarStateStoreOptions = {},
): ChinaWorkCalendarPersistedState | null {
  const statePath = resolveChinaWorkCalendarStatePath(options);
  if (!existsSync(statePath)) return null;

  try {
    return validatePersistedState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`中国法定节假日历状态文件损坏：${message}`);
  }
}

export function writeChinaWorkCalendarStateFile(
  state: ChinaWorkCalendarPersistedState,
  options: ChinaWorkCalendarStateStoreOptions = {},
): void {
  let validatedState: ChinaWorkCalendarPersistedState;
  try {
    validatedState = validatePersistedState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`中国法定节假日历状态无效：${message}`);
  }

  const statePath = resolveChinaWorkCalendarStatePath(options);
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      tempPath,
      `${JSON.stringify(validatedState, null, 2)}\n`,
      'utf8',
    );
    renameSync(tempPath, statePath);
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

function validatePersistedState(
  value: unknown,
): ChinaWorkCalendarPersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('内容不是对象');
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    throw new Error('schemaVersion 必须为 1');
  }

  const result: ChinaWorkCalendarPersistedState = {
    schemaVersion: 1,
    snapshot: validateChinaWorkCalendarSnapshot(candidate.snapshot),
  };

  copyOptionalTimestamp(candidate, result, 'lastCheckedAt');
  copyOptionalTimestamp(candidate, result, 'lastSuccessAt');
  copyOptionalTimestamp(candidate, result, 'nextCheckAt');

  if (candidate.lastError !== undefined) {
    if (typeof candidate.lastError !== 'string') {
      throw new Error('lastError 类型无效');
    }
    result.lastError = candidate.lastError;
  }

  if (candidate.yearChecks !== undefined) {
    result.yearChecks = validateYearChecks(candidate.yearChecks);
  }

  return result;
}

function copyOptionalTimestamp(
  source: Record<string, unknown>,
  target: ChinaWorkCalendarPersistedState,
  key: 'lastCheckedAt' | 'lastSuccessAt' | 'nextCheckAt',
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${key} 时间无效`);
  }
  target[key] = value;
}

function validateYearChecks(
  value: unknown,
): Record<string, ChinaWorkCalendarYearCheckState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('yearChecks 类型无效');
  }

  const result: Record<string, ChinaWorkCalendarYearCheckState> = {};
  for (const [year, rawCheck] of Object.entries(value)) {
    if (!/^\d{4}$/.test(year)) {
      throw new Error(`yearChecks 年份无效：${year}`);
    }
    if (!rawCheck || typeof rawCheck !== 'object' || Array.isArray(rawCheck)) {
      throw new Error(`yearChecks.${year} 类型无效`);
    }

    const source = rawCheck as Record<string, unknown>;
    const check: ChinaWorkCalendarYearCheckState = {};
    copyYearCheckTimestamp(source, check, year, 'lastCheckedAt');
    copyYearCheckTimestamp(source, check, year, 'lastSuccessAt');

    if (source.notPublished !== undefined) {
      if (typeof source.notPublished !== 'boolean') {
        throw new Error(`yearChecks.${year}.notPublished 类型无效`);
      }
      check.notPublished = source.notPublished;
    }
    if (source.consecutiveFailures !== undefined) {
      if (
        !Number.isInteger(source.consecutiveFailures) ||
        (source.consecutiveFailures as number) < 0
      ) {
        throw new Error(`yearChecks.${year}.consecutiveFailures 无效`);
      }
      check.consecutiveFailures = source.consecutiveFailures as number;
    }
    result[year] = check;
  }

  return result;
}

function copyYearCheckTimestamp(
  source: Record<string, unknown>,
  target: ChinaWorkCalendarYearCheckState,
  year: string,
  key: 'lastCheckedAt' | 'lastSuccessAt',
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`yearChecks.${year}.${key} 时间无效`);
  }
  target[key] = value;
}
