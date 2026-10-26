import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  PurchaseApplicationSubmissionTask,
  PurchaseApplicationSubmitResponse,
} from '../../../shared/purchase-application.interface';

export const PURCHASE_APPLICATION_TASK_LEDGER_PATH =
  'PURCHASE_APPLICATION_TASK_LEDGER_PATH';
export const PURCHASE_APPLICATION_TASK_LEDGER_OPTIONS =
  'PURCHASE_APPLICATION_TASK_LEDGER_OPTIONS';

const LEDGER_VERSION = 2;
const LOCK_VERSION = 1;
const DEFAULT_RETENTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);
const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const RECOVERED_UNCERTAIN_MESSAGE =
  '服务已重启，原任务结果暂不确定；系统不会重复执行，请使用原幂等号查询并核对采购清单';

export type PurchaseApplicationLedgerTask = PurchaseApplicationSubmissionTask;

export interface PurchaseApplicationTaskLedgerEntry {
  building: string;
  principalFingerprint: string;
  idempotencyKey: string;
  requestFingerprint: string;
  submissionFingerprint: string;
  task: PurchaseApplicationLedgerTask;
}

interface PersistedPurchaseApplicationTaskLedgerEntry extends PurchaseApplicationTaskLedgerEntry {
  retainedUntil: string;
  owner?: LedgerLockOwner;
}

interface PersistedPurchaseApplicationTaskLedger {
  version: 2;
  updatedAt: string;
  entries: PersistedPurchaseApplicationTaskLedgerEntry[];
}

interface LedgerLockOwner {
  version: 1;
  token: string;
  pid: number;
  processStartedAtMs: number;
  acquiredAt: string;
}

export interface PurchaseApplicationTaskLedgerStoreOptions {
  retentionTtlMs?: number;
  maxEntries?: number;
  now?: () => Date;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockRetryDelayMs?: number;
}

@Injectable()
export class PurchaseApplicationTaskLedgerStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly retentionTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly taskOwnerToken = randomUUID();
  private readonly entriesByTaskId = new Map<
    string,
    PersistedPurchaseApplicationTaskLedgerEntry
  >();
  private readonly taskIdsByIdentity = new Map<string, string>();
  private failed: ServiceUnavailableException | null = null;

  constructor(
    @Optional()
    @Inject(PURCHASE_APPLICATION_TASK_LEDGER_PATH)
    ledgerPathValue?: string,
    @Optional()
    @Inject(PURCHASE_APPLICATION_TASK_LEDGER_OPTIONS)
    options: PurchaseApplicationTaskLedgerStoreOptions = {},
  ) {
    this.ledgerPath = resolve(
      ledgerPathValue?.trim() ||
        join(
          process.cwd(),
          '.runtime',
          'purchase-application-task-ledger.json',
        ),
    );
    this.lockPath = `${this.ledgerPath}.lock`;
    this.retentionTtlMs = positiveInteger(
      options.retentionTtlMs,
      DEFAULT_RETENTION_TTL_MS,
    );
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.now = options.now || (() => new Date());
    this.lockTimeoutMs = positiveInteger(
      options.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
    );
    this.staleLockMs = positiveInteger(
      options.staleLockMs,
      DEFAULT_STALE_LOCK_MS,
    );
    this.lockRetryDelayMs = positiveInteger(
      options.lockRetryDelayMs,
      DEFAULT_LOCK_RETRY_DELAY_MS,
    );
  }

  reserve(entryValue: PurchaseApplicationTaskLedgerEntry): {
    created: boolean;
    entry: PurchaseApplicationTaskLedgerEntry;
  } {
    const entry = normalizeEntry(entryValue, this.retainedUntil());
    return this.withLedgerLock(() => {
      let changed = this.reloadLatestLocked();
      changed = this.pruneInMemory() || changed;
      const identity = identityKey(
        entry.building,
        entry.principalFingerprint,
        entry.idempotencyKey,
      );
      const existingTaskId = this.taskIdsByIdentity.get(identity);
      const existing = existingTaskId
        ? this.entriesByTaskId.get(existingTaskId)
        : undefined;
      if (existing) {
        if (changed) this.persistLocked();
        return { created: false, entry: cloneEntry(existing) };
      }
      if (this.entriesByTaskId.has(entry.task.id)) {
        throw this.failClosed(new Error('持久任务编号与幂等身份冲突'));
      }

      const reservedEntry = this.bindTaskOwner(entry);
      this.entriesByTaskId.set(reservedEntry.task.id, reservedEntry);
      this.taskIdsByIdentity.set(identity, entry.task.id);
      this.persistLocked();
      return { created: true, entry: cloneEntry(reservedEntry) };
    });
  }

  updateTask(
    taskIdValue: string,
    taskValue: PurchaseApplicationLedgerTask,
  ): PurchaseApplicationTaskLedgerEntry {
    const taskId = clean(taskIdValue);
    const task = normalizeTask(taskValue);
    return this.withLedgerLock(() => {
      this.reloadLatestLocked();
      this.pruneInMemory();
      const current = this.entriesByTaskId.get(taskId);
      if (!current) {
        throw this.failClosed(new Error('持久任务记录不存在'));
      }
      if (task.id !== taskId) {
        throw this.failClosed(new Error('持久任务编号不一致'));
      }
      if (isInFlight(current.task.status)) {
        if (!current.owner || !this.ownsTaskOwner(current.owner)) {
          throw this.failClosed(new Error('持久任务 owner 已变更'));
        }
      } else if (isInFlight(task.status)) {
        throw this.failClosed(new Error('终态持久任务不能重新进入执行态'));
      }
      current.task = task;
      if (isTerminal(task.status)) {
        delete current.owner;
        current.retainedUntil = this.retainedUntil();
      }
      this.persistLocked();
      return cloneEntry(current);
    });
  }

  findByIdentity(
    buildingValue: string,
    principalFingerprintValue: string,
    idempotencyKeyValue: string,
  ): PurchaseApplicationTaskLedgerEntry | undefined {
    return this.withLedgerLock(() => {
      let changed = this.reloadLatestLocked();
      changed = this.pruneInMemory() || changed;
      const taskId = this.taskIdsByIdentity.get(
        identityKey(
          buildingValue,
          principalFingerprintValue,
          idempotencyKeyValue,
        ),
      );
      const entry = taskId ? this.entriesByTaskId.get(taskId) : undefined;
      if (changed) this.persistLocked();
      return entry ? cloneEntry(entry) : undefined;
    });
  }

  findByTaskId(
    taskIdValue: string,
  ): PurchaseApplicationTaskLedgerEntry | undefined {
    return this.withLedgerLock(() => {
      let changed = this.reloadLatestLocked();
      changed = this.pruneInMemory() || changed;
      const entry = this.entriesByTaskId.get(clean(taskIdValue));
      if (changed) this.persistLocked();
      return entry ? cloneEntry(entry) : undefined;
    });
  }

  listCompletedTasksWithCreatedRecords(
    limitValue = 100,
  ): PurchaseApplicationTaskLedgerEntry[] {
    const limit = Math.max(1, Math.min(500, Math.floor(limitValue) || 1));
    return this.withLedgerLock(() => {
      let changed = this.reloadLatestLocked();
      changed = this.pruneInMemory() || changed;
      const entries = [...this.entriesByTaskId.values()]
        .filter(
          (entry) =>
            entry.task.status === 'completed' &&
            Boolean(entry.task.result?.created.length),
        )
        .sort((left, right) => terminalTimestamp(right) - terminalTimestamp(left))
        .slice(0, limit)
        .map(cloneEntry);
      if (changed) this.persistLocked();
      return entries;
    });
  }

  private reloadLatestLocked(): boolean {
    if (this.failed) throw this.failed;
    this.entriesByTaskId.clear();
    this.taskIdsByIdentity.clear();
    try {
      if (existsSync(this.ledgerPath)) {
        const state = parseLedger(readFileSync(this.ledgerPath, 'utf8'));
        for (const entry of state.entries) {
          const identity = identityKey(
            entry.building,
            entry.principalFingerprint,
            entry.idempotencyKey,
          );
          if (
            this.entriesByTaskId.has(entry.task.id) ||
            this.taskIdsByIdentity.has(identity)
          ) {
            throw new Error('账本存在重复任务或幂等身份');
          }
          this.entriesByTaskId.set(entry.task.id, entry);
          this.taskIdsByIdentity.set(identity, entry.task.id);
        }
      }
      let changed = false;
      const recoveredAt = this.now().toISOString();
      for (const entry of this.entriesByTaskId.values()) {
        if (!isInFlight(entry.task.status)) continue;
        if (entry.owner && taskOwnerMayBeAlive(entry.owner)) continue;
        entry.task = {
          ...entry.task,
          status: 'uncertain',
          message: RECOVERED_UNCERTAIN_MESSAGE,
          completedAt: recoveredAt,
        };
        delete entry.owner;
        entry.retainedUntil = this.retainedUntil();
        changed = true;
      }
      return changed;
    } catch (error) {
      this.entriesByTaskId.clear();
      this.taskIdsByIdentity.clear();
      throw this.failClosed(error);
    }
  }

  private bindTaskOwner(
    entry: PersistedPurchaseApplicationTaskLedgerEntry,
  ): PersistedPurchaseApplicationTaskLedgerEntry {
    if (!isInFlight(entry.task.status)) return entry;
    return {
      ...entry,
      owner: {
        version: LOCK_VERSION,
        token: this.taskOwnerToken,
        pid: process.pid,
        processStartedAtMs: PROCESS_STARTED_AT_MS,
        acquiredAt: this.now().toISOString(),
      },
    };
  }

  private ownsTaskOwner(owner: LedgerLockOwner): boolean {
    return (
      owner.pid === process.pid &&
      owner.processStartedAtMs === PROCESS_STARTED_AT_MS &&
      owner.token === this.taskOwnerToken
    );
  }

  private pruneInMemory(): boolean {
    const now = this.now().getTime();
    let changed = false;
    for (const entry of [...this.entriesByTaskId.values()]) {
      if (!isTerminal(entry.task.status)) continue;
      if (Date.parse(entry.retainedUntil) > now) continue;
      this.deleteInMemory(entry);
      changed = true;
    }

    const terminalEntries = [...this.entriesByTaskId.values()]
      .filter((entry) => isTerminal(entry.task.status))
      .sort(
        (left, right) => terminalTimestamp(left) - terminalTimestamp(right),
      );
    while (terminalEntries.length > this.maxEntries) {
      this.deleteInMemory(terminalEntries.shift()!);
      changed = true;
    }
    return changed;
  }

  private deleteInMemory(
    entry: PersistedPurchaseApplicationTaskLedgerEntry,
  ): void {
    this.entriesByTaskId.delete(entry.task.id);
    this.taskIdsByIdentity.delete(
      identityKey(
        entry.building,
        entry.principalFingerprint,
        entry.idempotencyKey,
      ),
    );
  }

  private persistLocked(): void {
    if (this.failed) throw this.failed;
    const state: PersistedPurchaseApplicationTaskLedger = {
      version: LEDGER_VERSION,
      updatedAt: this.now().toISOString(),
      entries: [...this.entriesByTaskId.values()].map(clonePersistedEntry),
    };
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let primaryError: unknown;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      // Same-directory rename gives atomic reader visibility. Node cannot
      // portably fsync a parent directory on Windows, so sudden-power-loss
      // durability still depends on the filesystem once rename returns.
      renameSync(temporaryPath, this.ledgerPath);
    } catch (error) {
      primaryError = error;
    }

    const cleanupError = cleanupTemporaryFile(temporaryPath, descriptor);
    if (primaryError !== undefined) {
      const primaryFailure = this.failClosed(primaryError);
      attachCleanupError(primaryFailure, cleanupError);
      throw primaryFailure;
    }
    if (cleanupError !== undefined) throw this.failClosed(cleanupError);
  }

  private withLedgerLock<T>(operation: () => T): T {
    if (this.failed) throw this.failed;
    const owner = this.acquireLock();
    let result: T | undefined;
    let primaryError: unknown;
    try {
      result = operation();
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    try {
      this.releaseLock(owner);
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError !== undefined) {
      if (cleanupError !== undefined && primaryError instanceof Error) {
        attachCleanupError(primaryError, cleanupError);
      }
      if (cleanupError !== undefined) this.failClosed(cleanupError);
      throw primaryError;
    }
    if (cleanupError !== undefined) throw this.failClosed(cleanupError);
    return result as T;
  }

  private acquireLock(): LedgerLockOwner {
    if (this.failed) throw this.failed;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
    } catch (error) {
      throw this.failClosed(error);
    }
    const deadline = performance.now() + this.lockTimeoutMs;
    while (true) {
      const owner: LedgerLockOwner = {
        version: LOCK_VERSION,
        token: randomUUID(),
        pid: process.pid,
        processStartedAtMs: PROCESS_STARTED_AT_MS,
        acquiredAt: new Date().toISOString(),
      };
      let descriptor: number | undefined;
      try {
        descriptor = openSync(this.lockPath, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        return owner;
      } catch (error) {
        if (descriptor !== undefined) {
          const cleanupError = cleanupOwnedLockFile(this.lockPath, descriptor);
          if (cleanupError !== undefined) throw this.failClosed(error);
        }
        if (!isFileExistsError(error)) throw this.failClosed(error);
      }

      if (this.reclaimStaleLock()) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new ServiceUnavailableException(
          `采购申请幂等账本暂时繁忙：等待文件锁超时：${this.lockPath}`,
        );
      }
      sleepSynchronously(Math.min(this.lockRetryDelayMs, remaining));
    }
  }

  private reclaimStaleLock(): boolean {
    const initial = this.inspectReclaimableLock();
    if (initial === 'missing') return true;
    if (initial !== 'reclaimable') return false;

    const recoveryOwner = this.acquireRecoveryGuard();
    if (!recoveryOwner) return false;
    let result = false;
    let primaryError: unknown;
    try {
      const confirmed = this.inspectReclaimableLock();
      if (confirmed === 'missing') {
        result = true;
      } else if (confirmed === 'reclaimable') {
        const quarantinePath = `${this.lockPath}.${process.pid}.${randomUUID()}.stale`;
        try {
          renameSync(this.lockPath, quarantinePath);
          const cleanupError = removeIfExists(quarantinePath);
          if (cleanupError !== undefined) throw cleanupError;
          result = true;
        } catch (error) {
          if (isFileMissingError(error)) {
            result = true;
          } else {
            primaryError = error;
          }
        }
      }
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    try {
      this.releaseRecoveryGuard(recoveryOwner);
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError !== undefined) {
      const primaryFailure = this.failClosed(primaryError);
      attachCleanupError(primaryFailure, cleanupError);
      throw primaryFailure;
    }
    if (cleanupError !== undefined) throw this.failClosed(cleanupError);
    return result;
  }

  private inspectReclaimableLock(): 'missing' | 'active' | 'reclaimable' {
    try {
      return inspectReclaimablePath(this.lockPath, this.staleLockMs);
    } catch (error) {
      throw this.failClosed(error);
    }
  }

  private acquireRecoveryGuard(retried = false): LedgerLockOwner | null {
    const guardPath = `${this.lockPath}.recovery`;
    const owner: LedgerLockOwner = {
      version: LOCK_VERSION,
      token: randomUUID(),
      pid: process.pid,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      acquiredAt: new Date().toISOString(),
    };
    let descriptor: number | undefined;
    try {
      descriptor = openSync(guardPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      return owner;
    } catch (error) {
      if (descriptor !== undefined) {
        cleanupOwnedLockFile(guardPath, descriptor);
      }
      if (isFileExistsError(error)) {
        if (retried) return null;
        const inspection = inspectReclaimablePath(guardPath, this.staleLockMs);
        if (inspection === 'missing') return this.acquireRecoveryGuard(true);
        if (inspection === 'active') return null;
        const quarantinePath = `${guardPath}.${process.pid}.${randomUUID()}.stale`;
        try {
          renameSync(guardPath, quarantinePath);
          const cleanupError = removeIfExists(quarantinePath);
          if (cleanupError !== undefined) throw cleanupError;
        } catch (quarantineError) {
          if (!isFileMissingError(quarantineError)) {
            throw this.failClosed(quarantineError);
          }
        }
        return this.acquireRecoveryGuard(true);
      }
      throw this.failClosed(error);
    }
  }

  private releaseRecoveryGuard(owner: LedgerLockOwner): void {
    const guardPath = `${this.lockPath}.recovery`;
    const current = parseLockOwner(readFileSync(guardPath, 'utf8'));
    if (!current || current.token !== owner.token) {
      throw new Error('账本文件锁恢复权已丢失');
    }
    unlinkSync(guardPath);
  }

  private releaseLock(owner: LedgerLockOwner): void {
    const current = parseLockOwner(readFileSync(this.lockPath, 'utf8'));
    if (!current || current.token !== owner.token) {
      throw new Error('账本文件锁所有权已丢失');
    }
    unlinkSync(this.lockPath);
  }

  private retainedUntil(): string {
    return new Date(this.now().getTime() + this.retentionTtlMs).toISOString();
  }

  private failClosed(error: unknown): ServiceUnavailableException {
    if (!this.failed) {
      const detail = error instanceof Error ? error.message : String(error);
      this.failed = new ServiceUnavailableException(
        `采购申请幂等账本不可用：${detail}`,
      );
    }
    return this.failed;
  }
}

function parseLedger(value: string): PersistedPurchaseApplicationTaskLedger {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || parsed.version !== LEDGER_VERSION) {
    throw new Error(
      `账本版本不受支持：${isRecord(parsed) ? String(parsed.version) : '未知'}；需要显式迁移到 v${LEDGER_VERSION}`,
    );
  }
  if (!validTimestamp(parsed.updatedAt) || !Array.isArray(parsed.entries)) {
    throw new Error('账本结构无效');
  }
  return {
    version: LEDGER_VERSION,
    updatedAt: parsed.updatedAt,
    entries: parsed.entries.map((entry) => normalizePersistedEntry(entry)),
  };
}

function normalizePersistedEntry(
  value: unknown,
): PersistedPurchaseApplicationTaskLedgerEntry {
  if (!isRecord(value) || !validTimestamp(value.retainedUntil)) {
    throw new Error('账本任务结构无效');
  }
  const entry = normalizeEntry(
    {
      building: value.building as string,
      principalFingerprint: value.principalFingerprint as string,
      idempotencyKey: value.idempotencyKey as string,
      requestFingerprint: value.requestFingerprint as string,
      submissionFingerprint: value.submissionFingerprint as string,
      task: value.task as PurchaseApplicationLedgerTask,
    },
    value.retainedUntil,
  );
  if (!isInFlight(entry.task.status)) return entry;
  const owner = normalizeProcessOwner(value.owner);
  return owner ? { ...entry, owner } : entry;
}

function normalizeEntry(
  value: PurchaseApplicationTaskLedgerEntry,
  retainedUntil: string,
): PersistedPurchaseApplicationTaskLedgerEntry {
  const building = clean(value?.building);
  const principalFingerprint = clean(value?.principalFingerprint);
  const idempotencyKey = clean(value?.idempotencyKey);
  const requestFingerprint = clean(value?.requestFingerprint).toLowerCase();
  const submissionFingerprint = clean(
    value?.submissionFingerprint,
  ).toLowerCase();
  if (
    !building ||
    principalFingerprint.length < 8 ||
    principalFingerprint.length > 512 ||
    CONTROL_CHARACTER_PATTERN.test(principalFingerprint) ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
    !HASH_PATTERN.test(requestFingerprint) ||
    !HASH_PATTERN.test(submissionFingerprint) ||
    !validTimestamp(retainedUntil)
  ) {
    throw new Error('账本任务幂等信息无效');
  }
  return {
    building,
    principalFingerprint,
    idempotencyKey,
    requestFingerprint,
    submissionFingerprint,
    task: normalizeTask(value.task),
    retainedUntil,
  };
}

function normalizeTask(
  value: PurchaseApplicationLedgerTask,
): PurchaseApplicationLedgerTask {
  if (!isRecord(value)) throw new Error('账本任务内容无效');
  const id = clean(value.id);
  const message = clean(value.message);
  const status = value.status;
  if (
    !id ||
    !message ||
    !['pending', 'running', 'completed', 'failed', 'uncertain'].includes(
      status,
    ) ||
    !validTimestamp(value.createdAt) ||
    (value.completedAt !== undefined && !validTimestamp(value.completedAt))
  ) {
    throw new Error('账本任务内容无效');
  }
  const result =
    value.result === undefined ? undefined : normalizeTaskResult(value.result);
  if (status === 'completed' && !result) {
    throw new Error('已完成的账本任务缺少结果');
  }
  return {
    id,
    status,
    message,
    createdAt: value.createdAt,
    ...(value.completedAt ? { completedAt: value.completedAt } : {}),
    ...(status === 'failed' && value.definitelyNotWritten === true
      ? { definitelyNotWritten: true }
      : {}),
    ...(result ? { result } : {}),
  };
}

function normalizeTaskResult(
  value: unknown,
): PurchaseApplicationSubmitResponse {
  if (
    !isRecord(value) ||
    typeof value.success !== 'boolean' ||
    !clean(value.message) ||
    !Array.isArray(value.created) ||
    !Array.isArray(value.failed) ||
    !Array.isArray(value.warnings)
  ) {
    throw new Error('账本任务结果无效');
  }
  return {
    success: value.success,
    message: clean(value.message),
    created: value.created.map((item) => normalizeCreatedResult(item)),
    failed: value.failed.map((item) => normalizeFailedResult(item)),
    warnings: value.warnings.map((item) => normalizeWarningResult(item)),
  };
}

function normalizeCreatedResult(
  value: unknown,
): PurchaseApplicationSubmitResponse['created'][number] {
  if (!isRecord(value)) throw new Error('账本创建结果无效');
  const lineId = clean(value.lineId);
  const recordId = clean(value.recordId);
  const requestCode = clean(value.requestCode);
  const executionRecordId = clean(value.executionRecordId);
  if (!lineId || !recordId || !requestCode) {
    throw new Error('账本创建结果无效');
  }
  return {
    lineId,
    recordId,
    requestCode,
    ...(executionRecordId ? { executionRecordId } : {}),
  };
}

function normalizeFailedResult(
  value: unknown,
): PurchaseApplicationSubmitResponse['failed'][number] {
  if (!isRecord(value)) throw new Error('账本失败结果无效');
  const lineId = clean(value.lineId);
  const message = clean(value.message);
  if (!lineId || !message) throw new Error('账本失败结果无效');
  return { lineId, message };
}

function normalizeWarningResult(
  value: unknown,
): PurchaseApplicationSubmitResponse['warnings'][number] {
  if (!isRecord(value)) throw new Error('账本警告结果无效');
  const lineId = clean(value.lineId);
  const executionRecordId = clean(value.executionRecordId);
  const message = clean(value.message);
  if (!lineId || !executionRecordId || !message) {
    throw new Error('账本警告结果无效');
  }
  return { lineId, executionRecordId, message };
}

function identityKey(
  buildingValue: string,
  principalFingerprintValue: string,
  idempotencyKeyValue: string,
): string {
  return JSON.stringify([
    clean(buildingValue),
    clean(principalFingerprintValue),
    clean(idempotencyKeyValue),
  ]);
}

function isTerminal(status: PurchaseApplicationLedgerTask['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'uncertain'
  );
}

function isInFlight(status: PurchaseApplicationLedgerTask['status']): boolean {
  return status === 'pending' || status === 'running';
}

function terminalTimestamp(
  entry: PersistedPurchaseApplicationTaskLedgerEntry,
): number {
  return Date.parse(entry.task.completedAt || entry.task.createdAt);
}

function cloneEntry(
  entry: PersistedPurchaseApplicationTaskLedgerEntry,
): PurchaseApplicationTaskLedgerEntry {
  const {
    retainedUntil: _retainedUntil,
    owner: _owner,
    ...value
  } = clonePersistedEntry(entry);
  return value;
}

function clonePersistedEntry(
  entry: PersistedPurchaseApplicationTaskLedgerEntry,
): PersistedPurchaseApplicationTaskLedgerEntry {
  return JSON.parse(
    JSON.stringify(entry),
  ) as PersistedPurchaseApplicationTaskLedgerEntry;
}

function parseLockOwner(value: string): LedgerLockOwner | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeProcessOwner(parsed);
  } catch {
    return null;
  }
}

function normalizeProcessOwner(value: unknown): LedgerLockOwner | null {
  if (
    !isRecord(value) ||
    value.version !== LOCK_VERSION ||
    !clean(value.token) ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartedAtMs !== 'number' ||
    !Number.isFinite(value.processStartedAtMs) ||
    !validTimestamp(value.acquiredAt)
  ) {
    return null;
  }
  return {
    version: LOCK_VERSION,
    token: clean(value.token),
    pid: value.pid,
    processStartedAtMs: value.processStartedAtMs,
    acquiredAt: value.acquiredAt,
  };
}

function lockOwnerMayBeAlive(owner: LedgerLockOwner): boolean {
  if (owner.pid === process.pid) {
    return Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) < 5_000;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error) && errorCode(error) !== 'EINVAL';
  }
}

function taskOwnerMayBeAlive(owner: LedgerLockOwner): boolean {
  if (owner.pid === process.pid) {
    return Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) < 5_000;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // Node has no portable way to query another process' start time on
    // Windows. A rapidly reused PID can therefore conservatively keep a task
    // pending; this is safer than replaying an external write.
    return !isNoSuchProcessError(error) && errorCode(error) !== 'EINVAL';
  }
}

function inspectReclaimablePath(
  path: string,
  staleAfterMs: number,
): 'missing' | 'active' | 'reclaimable' {
  try {
    const modifiedAt = statSync(path).mtimeMs;
    const owner = parseLockOwner(readFileSync(path, 'utf8'));
    if (owner) return lockOwnerMayBeAlive(owner) ? 'active' : 'reclaimable';
    return Date.now() - modifiedAt < staleAfterMs ? 'active' : 'reclaimable';
  } catch (error) {
    if (isFileMissingError(error)) return 'missing';
    throw error;
  }
}

function attachCleanupError(primary: Error, cleanupError: unknown): void {
  if (cleanupError === undefined) return;
  Object.defineProperty(primary, 'cleanupError', {
    configurable: true,
    enumerable: false,
    value: cleanupError,
  });
}

function cleanupTemporaryFile(
  temporaryPath: string,
  descriptor: number | undefined,
): unknown {
  let cleanupError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupError = error;
    }
  }
  const unlinkError = removeIfExists(temporaryPath);
  return cleanupError ?? unlinkError;
}

function cleanupOwnedLockFile(lockPath: string, descriptor: number): unknown {
  let cleanupError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    cleanupError = error;
  }
  const unlinkError = removeIfExists(lockPath);
  return cleanupError ?? unlinkError;
}

function removeIfExists(path: string): unknown {
  try {
    if (existsSync(path)) unlinkSync(path);
    return undefined;
  } catch (error) {
    return error;
  }
}

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, Math.max(1, milliseconds));
}

function isFileExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isFileMissingError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isNoSuchProcessError(error: unknown): boolean {
  return errorCode(error) === 'ESRCH';
}

function errorCode(error: unknown): string {
  return isRecord(error) ? clean(error.code) : '';
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
