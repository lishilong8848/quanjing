import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);
const PROCESS_START_TOLERANCE_MS = 5_000;

export interface ProcessLockOwner {
  version: 1 | 2;
  pid: number;
  token: string;
  processStartedAtMs?: number;
  acquiredAt?: string;
}

export function createProcessLockOwner(
  token: string,
  acquiredAt = new Date(),
): ProcessLockOwner {
  return {
    version: 1,
    pid: process.pid,
    token,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
    acquiredAt: acquiredAt.toISOString(),
  };
}

export function normalizeProcessLockOwner(
  value: unknown,
): ProcessLockOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const version = record.version === undefined ? 1 : Number(record.version);
  if (
    (version !== 1 && version !== 2) ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    typeof record.token !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(record.token)
  ) {
    return null;
  }
  const hasValidProcessIdentity =
    typeof record.processStartedAtMs === 'number' &&
    Number.isFinite(record.processStartedAtMs) &&
    record.processStartedAtMs > 0 &&
    typeof record.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(record.acquiredAt));
  if (version === 2 && !hasValidProcessIdentity) {
    return null;
  }
  return {
    version,
    pid: Number(record.pid),
    token: record.token,
    ...(hasValidProcessIdentity
      ? {
          processStartedAtMs: Number(record.processStartedAtMs),
          acquiredAt: record.acquiredAt as string,
        }
      : {}),
  };
}

export function processLockOwnerMayBeAlive(
  owner: ProcessLockOwner,
  lockModifiedAtMs: number,
): boolean {
  const actualStartedAtMs = inspectProcessStartedAtMs(owner.pid);
  if (actualStartedAtMs === null) return false;
  if (actualStartedAtMs === undefined) return true;
  if (typeof owner.processStartedAtMs === 'number') {
    return (
      Math.abs(actualStartedAtMs - owner.processStartedAtMs) <
      PROCESS_START_TOLERANCE_MS
    );
  }
  return actualStartedAtMs <= lockModifiedAtMs + PROCESS_START_TOLERANCE_MS;
}

function inspectProcessStartedAtMs(pid: number): number | null | undefined {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS;
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EINVAL') return null;
    return undefined;
  }
  if (process.platform !== 'win32') return undefined;

  const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows';
  const powershell = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const command = [
    `$candidate = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if (!$candidate) { exit 3 }',
    "$candidate.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)",
  ].join('; ');
  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    },
  );
  if (result.status === 3) return null;
  if (result.status !== 0 || result.error) return undefined;
  const startedAtMs = Date.parse(String(result.stdout || '').trim());
  return Number.isFinite(startedAtMs) ? startedAtMs : undefined;
}
