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
import { readEnv } from '@server/common/config/external-services.config';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';
import type { TyphoonWarningSendState } from './typhoon-warning-alert';

const TYPHOON_WARNING_STATE_FILE = 'typhoon-warning-send-state.json';
const DEFAULT_LEASE_TIMEOUT_MS = 10 * 60 * 1000;

export interface TyphoonWarningStateStoreOptions {
  cwd?: string;
  nodeEnv?: string;
  explicitPath?: string;
  configuredDirectory?: string;
  leaseTimeoutMs?: number;
  now?: Date;
}

export interface TyphoonWarningMonitorLease {
  release: () => void;
}

export function resolveTyphoonWarningStatePath(
  options: TyphoonWarningStateStoreOptions = {},
): string {
  const explicitPath = options.explicitPath ?? readEnv(
    'TYPHOON_WARNING_SEND_STATE_PATH',
    ['DUTY_TYPHOON_WARNING_SEND_STATE_PATH'],
  );
  const configuredDirectory = options.configuredDirectory ?? readEnv(
    'TYPHOON_WARNING_STATE_DIR',
    ['DUTY_DAILY_REPORT_STATE_DIR'],
  );

  return resolveDutyDailyReportStateFilePath({
    cwd: options.cwd,
    nodeEnv: options.nodeEnv,
    explicitPath,
    configuredDirectory,
    fileName: TYPHOON_WARNING_STATE_FILE,
  });
}

export function readTyphoonWarningSendStateFile(
  options: TyphoonWarningStateStoreOptions = {},
): TyphoonWarningSendState {
  const statePath = resolveTyphoonWarningStatePath(options);
  migrateLegacyStateIfNeeded(statePath, options);
  if (!existsSync(statePath)) return {};

  try {
    return parseTyphoonWarningSendState(readFileSync(statePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`台风预警发送状态文件损坏：${message}`);
  }
}

export function writeTyphoonWarningSendStateFile(
  state: TyphoonWarningSendState,
  options: TyphoonWarningStateStoreOptions = {},
): void {
  const statePath = resolveTyphoonWarningStatePath(options);
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tempPath, statePath);
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

export function acquireTyphoonWarningMonitorLease(
  options: TyphoonWarningStateStoreOptions = {},
): TyphoonWarningMonitorLease | null {
  const statePath = resolveTyphoonWarningStatePath(options);
  const leasePath = `${statePath}.lock`;
  const now = options.now ?? new Date();
  const leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  mkdirSync(dirname(leasePath), { recursive: true });

  const token = `${process.pid}:${randomUUID()}`;
  const acquire = (): boolean => {
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(leasePath, 'wx');
      writeFileSync(
        fileDescriptor,
        `${JSON.stringify({
          token,
          acquiredAt: now.toISOString(),
        })}\n`,
        'utf8',
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      if (fileDescriptor !== undefined) {
        closeSync(fileDescriptor);
      }
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
        if (stored.token === token) {
          unlinkSync(leasePath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    },
  };
}

function migrateLegacyStateIfNeeded(
  statePath: string,
  options: TyphoonWarningStateStoreOptions,
): void {
  if (existsSync(statePath)) return;
  const explicitPath = options.explicitPath ?? readEnv(
    'TYPHOON_WARNING_SEND_STATE_PATH',
    ['DUTY_TYPHOON_WARNING_SEND_STATE_PATH'],
  );
  if (explicitPath.trim()) return;

  const cwd = resolve(options.cwd || process.cwd());
  const legacyPath = join(cwd, 'data', TYPHOON_WARNING_STATE_FILE);
  if (resolve(legacyPath) === resolve(statePath) || !existsSync(legacyPath)) {
    return;
  }

  const legacyState = parseTyphoonWarningSendState(
    readFileSync(legacyPath, 'utf8'),
  );
  writeTyphoonWarningSendStateFile(legacyState, {
    ...options,
    explicitPath: statePath,
  });
}

function parseTyphoonWarningSendState(value: string): TyphoonWarningSendState {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('内容不是对象');
  }

  const state = parsed as Record<string, unknown>;
  for (const key of [
    'warningKey',
    'level',
    'lastSentAt',
    'lastWarningTitle',
  ]) {
    if (state[key] !== undefined && typeof state[key] !== 'string') {
      throw new Error(`${key} 类型无效`);
    }
  }

  return {
    warningKey: state.warningKey as string | undefined,
    level: state.level as TyphoonWarningSendState['level'],
    lastSentAt: state.lastSentAt as string | undefined,
    lastWarningTitle: state.lastWarningTitle as string | undefined,
  };
}

function isStaleLease(
  leasePath: string,
  now: Date,
  leaseTimeoutMs: number,
): boolean {
  try {
    return now.getTime() - statSync(leasePath).mtimeMs >= leaseTimeoutMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
