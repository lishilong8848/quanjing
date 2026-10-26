import { businessAuthorizationSnapshot, validScopedBusinessPrincipal } from '../../../shared/business-permissions';
import { validBuildingScope } from '../../../shared/building-access';
import { professionalScopeIsValid } from '../../../shared/professional-access';
import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
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
  CreateInventoryMovementDeletionRequest,
  InventoryMovementDeletionTask,
} from '../../../shared/inventory-management.interface';
import {
  PURCHASE_ACCESS_BUILDINGS,
  type AccessPrincipal,
} from '../../../shared/access-control.interface';

export const INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_PATH =
  'INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_PATH';
export const INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_OPTIONS =
  'INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_OPTIONS';

const LEDGER_VERSION = 1;
const OWNER_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS = 250;
const MAX_DEFERRED_LOCK_RELEASE_DELAY_MS = 1_000;
const DEFAULT_TASK_LEASE_MS = 60_000;
const DEFAULT_RETENTION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1_024 * 1_024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{8,180}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);
const RECOVERED_UNCERTAIN_MESSAGE =
  '服务进程在删除阶段失联，结果暂不确定；系统不会重复删除，请使用原变更号继续核对';

export interface InventoryMovementDeletionTaskLedgerEntry {
  principal: AccessPrincipal;
  principalFingerprint: string;
  requestFingerprint: string;
  request: CreateInventoryMovementDeletionRequest;
  attemptCount: number;
  task: InventoryMovementDeletionTask;
  recovery?: InventoryMovementDeletionRecoveryState;
}

export interface InventoryMovementDeletionRecoveryState {
  version: 1;
  phase: 'prepared' | 'purchase_rolled_back' | 'delete_started';
  movement: {
    building: string;
    purchaseExecutionRecordId: string;
    sku: string;
    quantity: number;
  };
  purchase?: {
    executionRecordId: string;
    building: string;
    requestCode: string;
    sku: string;
    quantity: number;
    originalFields: Record<string, unknown>;
    rollbackFields: Record<string, unknown>;
  };
}

interface TaskOwner {
  version: 1;
  token: string;
  pid: number;
  processStartedAtMs: number;
  acquiredAt: string;
  leaseExpiresAt: string;
}

interface PersistedEntry extends InventoryMovementDeletionTaskLedgerEntry {
  owner?: TaskOwner;
}

interface PersistedLedger {
  version: 1;
  updatedAt: string;
  entries: PersistedEntry[];
}

export interface InventoryMovementDeletionTaskLedgerStoreOptions {
  now?: () => Date;
  taskLeaseMs?: number;
  retentionTtlMs?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockRetryDelayMs?: number;
}

@Injectable()
export class InventoryMovementDeletionTaskLedgerStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly taskLeaseMs: number;
  private readonly retentionTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly ownerToken = randomUUID();
  private readonly claimedTaskIds = new Set<string>();
  private deferredLockRelease: TaskOwner | null = null;
  private deferredLockReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredLockReleaseAttempt = 0;
  private failed: ServiceUnavailableException | null = null;

  constructor(
    @Optional()
    @Inject(INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_PATH)
    ledgerPathValue?: string,
    @Optional()
    @Inject(INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_OPTIONS)
    options: InventoryMovementDeletionTaskLedgerStoreOptions = {},
  ) {
    this.ledgerPath = resolve(
      clean(ledgerPathValue) ||
        clean(process.env.INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_PATH) ||
        join(
          process.cwd(),
          '.runtime',
          'inventory-movement-deletion-task-ledger.json',
        ),
    );
    this.lockPath = `${this.ledgerPath}.lock`;
    this.now = options.now || (() => new Date());
    this.taskLeaseMs = positiveInteger(
      options.taskLeaseMs,
      DEFAULT_TASK_LEASE_MS,
    );
    this.retentionTtlMs = positiveInteger(
      options.retentionTtlMs,
      DEFAULT_RETENTION_TTL_MS,
    );
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
    );
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

  async reserve(entryValue: InventoryMovementDeletionTaskLedgerEntry): Promise<{
    created: boolean;
    entry: InventoryMovementDeletionTaskLedgerEntry;
  }> {
    const entry = normalizeEntry(entryValue);
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      const existing = loaded.entries.find(
        (candidate) =>
          candidate.request.clientMutationId === entry.request.clientMutationId,
      );
      if (existing) {
        if (
          existing.principalFingerprint !== entry.principalFingerprint ||
          existing.requestFingerprint !== entry.requestFingerprint
        ) {
          throw new ConflictException(
            'clientMutationId 已被不同的删除请求占用',
          );
        }
        if (loaded.changed) this.persistLocked(loaded.entries);
        return { created: false, entry: cloneEntry(existing) };
      }
      const targetConflict = loaded.entries.find(
        (candidate) =>
          blocksSameTarget(candidate.task.status) &&
          candidate.request.movementType === entry.request.movementType &&
          candidate.request.recordId === entry.request.recordId,
      );
      if (targetConflict) {
        throw new ConflictException('该出入库记录已有删除任务正在处理');
      }
      if (
        loaded.entries.some((candidate) => candidate.task.id === entry.task.id)
      ) {
        throw new ConflictException('删除任务编号冲突');
      }
      evictExpiredAndOverflow(
        loaded.entries,
        this.now().getTime(),
        this.retentionTtlMs,
        this.maxEntries - 1,
      );
      if (loaded.entries.length >= this.maxEntries) {
        throw new ServiceUnavailableException(
          '库存删除任务账本容量已满，存在不能安全清理的任务',
        );
      }
      loaded.entries.push(entry);
      this.persistLocked(loaded.entries);
      return { created: true, entry: cloneEntry(entry) };
    });
  }

  async claimPending(taskIdValue: string): Promise<{
    claimed: boolean;
    entry: InventoryMovementDeletionTaskLedgerEntry;
  }> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry) throw new Error('库存删除任务不存在');
      const recoverableRunning =
        entry.task.status === 'running' && Boolean(entry.recovery);
      if (
        (entry.task.status !== 'pending' && !recoverableRunning) ||
        entry.owner ||
        this.claimedTaskIds.has(taskId)
      ) {
        if (loaded.changed) this.persistLocked(loaded.entries);
        return { claimed: false, entry: cloneEntry(entry) };
      }
      entry.owner = this.createOwner();
      entry.attemptCount += 1;
      entry.task = normalizeTask({
        ...entry.task,
        updatedAt: this.now().toISOString(),
      });
      this.persistLocked(loaded.entries);
      this.claimedTaskIds.add(taskId);
      return { claimed: true, entry: cloneEntry(entry) };
    });
  }

  async updateTask(
    taskIdValue: string,
    taskValue: InventoryMovementDeletionTask,
  ): Promise<InventoryMovementDeletionTaskLedgerEntry> {
    const taskId = clean(taskIdValue);
    const task = normalizeTask(taskValue);
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry) throw new Error('库存删除任务不存在');
      if (task.id !== taskId) throw new Error('库存删除任务编号不一致');
      if (!isInFlight(entry.task.status)) {
        throw new Error('库存删除终态任务不能再次更新');
      }
      if (
        !entry.owner ||
        !this.ownsOwner(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        throw new ServiceUnavailableException(
          '库存删除任务 lease 所有权已变更',
        );
      }
      if (entry.task.status === 'running' && task.status === 'pending') {
        throw new Error('库存删除运行任务不能退回等待态');
      }
      assertTaskMatchesRequest(task, entry.request);
      entry.task = task;
      if (isTerminal(task.status)) {
        delete entry.owner;
        this.claimedTaskIds.delete(taskId);
      } else if (entry.owner) {
        entry.owner = this.extendOwner(entry.owner);
      }
      this.persistLocked(loaded.entries);
      return cloneEntry(entry);
    });
  }

  async updateRecoveryState(
    taskIdValue: string,
    recoveryValue: InventoryMovementDeletionRecoveryState,
  ): Promise<InventoryMovementDeletionTaskLedgerEntry> {
    const taskId = clean(taskIdValue);
    const recovery = normalizeRecoveryState(recoveryValue);
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry) throw new Error('库存删除任务不存在');
      if (!isInFlight(entry.task.status)) {
        throw new Error('库存删除终态任务不能更新恢复计划');
      }
      if (
        !entry.owner ||
        !this.ownsOwner(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        throw new ServiceUnavailableException(
          '库存删除任务 lease 所有权已变更',
        );
      }
      assertRecoveryMatchesRequest(recovery, entry.request);
      assertRecoveryTransition(entry.recovery, recovery);
      entry.recovery = recovery;
      entry.task = normalizeTask({
        ...entry.task,
        updatedAt: this.now().toISOString(),
      });
      entry.owner = this.extendOwner(entry.owner);
      this.persistLocked(loaded.entries);
      return cloneEntry(entry);
    });
  }

  async renewClaim(
    taskIdValue: string,
  ): Promise<InventoryMovementDeletionTaskLedgerEntry> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (
        !entry ||
        !isInFlight(entry.task.status) ||
        !entry.owner ||
        !this.ownsOwner(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        throw new ServiceUnavailableException(
          '库存删除任务 lease 所有权已变更',
        );
      }
      entry.owner = this.extendOwner(entry.owner);
      this.persistLocked(loaded.entries);
      return cloneEntry(entry);
    });
  }

  async abandonPendingClaim(taskIdValue: string): Promise<boolean> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (
        !entry ||
        entry.task.status !== 'pending' ||
        !entry.owner ||
        !this.ownsOwner(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        if (loaded.changed) this.persistLocked(loaded.entries);
        return false;
      }
      delete entry.owner;
      this.claimedTaskIds.delete(taskId);
      this.persistLocked(loaded.entries);
      return true;
    });
  }

  async findByTaskId(
    taskIdValue: string,
  ): Promise<InventoryMovementDeletionTaskLedgerEntry | undefined> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (loaded.changed) this.persistLocked(loaded.entries);
      return entry ? cloneEntry(entry) : undefined;
    });
  }

  async listPending(): Promise<InventoryMovementDeletionTaskLedgerEntry[]> {
    return this.withLedgerLock(() => {
      const loaded = this.readLatestAndRecover();
      if (loaded.changed) this.persistLocked(loaded.entries);
      return loaded.entries
        .filter(
          (entry) =>
            entry.task.status === 'pending' ||
            (entry.task.status === 'running' &&
              !entry.owner &&
              Boolean(entry.recovery)),
        )
        .map(cloneEntry);
    });
  }

  getLeaseHeartbeatIntervalMs(): number {
    return Math.max(50, Math.floor(this.taskLeaseMs / 3));
  }

  private readLatestAndRecover(): {
    entries: PersistedEntry[];
    changed: boolean;
  } {
    if (this.failed) throw this.failed;
    try {
      if (!existsSync(this.ledgerPath)) return { entries: [], changed: false };
      if (statSync(this.ledgerPath).size > this.maxFileBytes) {
        throw new Error('库存删除任务账本超过最大字节数');
      }
      const parsed = parseLedger(readFileSync(this.ledgerPath, 'utf8'));
      const nowMs = this.now().getTime();
      let changed = false;
      for (const entry of parsed.entries) {
        if (!entry.owner || Date.parse(entry.owner.leaseExpiresAt) > nowMs) {
          continue;
        }
        if (entry.task.status === 'pending') {
          delete entry.owner;
          changed = true;
          continue;
        }
        if (entry.task.status === 'running') {
          delete entry.owner;
          if (entry.recovery) {
            changed = true;
            continue;
          }
          const completedAt = this.now().toISOString();
          entry.task = normalizeTask({
            ...entry.task,
            status: 'uncertain',
            message: RECOVERED_UNCERTAIN_MESSAGE,
            updatedAt: completedAt,
            completedAt,
            definitelyNotDeleted: false,
          });
          changed = true;
        }
      }
      if (
        evictExpiredAndOverflow(
          parsed.entries,
          nowMs,
          this.retentionTtlMs,
          this.maxEntries,
        )
      ) {
        changed = true;
      }
      if (parsed.entries.length > this.maxEntries) {
        throw new Error('库存删除任务账本容量超限');
      }
      return { entries: parsed.entries, changed };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.failClosed(error);
    }
  }

  private createOwner(): TaskOwner {
    const now = this.now();
    return {
      version: OWNER_VERSION,
      token: this.ownerToken,
      pid: process.pid,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      acquiredAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.taskLeaseMs).toISOString(),
    };
  }

  private extendOwner(owner: TaskOwner): TaskOwner {
    return {
      ...owner,
      leaseExpiresAt: new Date(
        this.now().getTime() + this.taskLeaseMs,
      ).toISOString(),
    };
  }

  private ownsOwner(owner: TaskOwner): boolean {
    return (
      owner.token === this.ownerToken &&
      owner.pid === process.pid &&
      Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) < 5_000
    );
  }

  private persistLocked(entries: PersistedEntry[]): void {
    if (this.failed) throw this.failed;
    const state: PersistedLedger = {
      version: LEDGER_VERSION,
      updatedAt: this.now().toISOString(),
      entries,
    };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes) {
      throw new ServiceUnavailableException('库存删除任务账本字节容量不足');
    }
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.ledgerPath);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The original persistence error remains authoritative.
        }
      }
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } catch {
        // The store is failed closed below, so this path will not be reused.
      }
      throw this.failClosed(error);
    }
  }

  private async withLedgerLock<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.failed) throw this.failed;
    const owner = await this.acquireLock();
    let result: T | undefined;
    let primaryError: unknown;
    try {
      result = await operation();
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await this.releaseLock(owner);
    } catch (error) {
      cleanupError = error;
    }
    if (
      cleanupError !== undefined &&
      isTransientLockReleaseError(cleanupError)
    ) {
      this.deferLockRelease(owner);
      cleanupError = undefined;
    }
    if (primaryError !== undefined) {
      if (cleanupError !== undefined) this.failClosed(cleanupError);
      throw primaryError;
    }
    if (cleanupError !== undefined) throw this.failClosed(cleanupError);
    return result as T;
  }

  private async acquireLock(): Promise<TaskOwner> {
    await this.flushDeferredLockRelease();
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
    } catch (error) {
      throw this.failClosed(error);
    }
    const deadline = performance.now() + this.lockTimeoutMs;
    while (true) {
      const owner = this.createOwner();
      let descriptor: number | undefined;
      try {
        descriptor = openSync(this.lockPath, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        return owner;
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            // The acquisition error below remains authoritative.
          }
        }
        if (!isFileExistsError(error)) throw this.failClosed(error);
      }
      if (this.reclaimStaleLock()) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new ServiceUnavailableException(
          `库存删除任务账本暂时繁忙：${this.lockPath}`,
        );
      }
      await delay(Math.min(this.lockRetryDelayMs, remaining));
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
          unlinkIfExists(quarantinePath);
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
    if (primaryError !== undefined) throw this.failClosed(primaryError);
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

  private acquireRecoveryGuard(retried = false): TaskOwner | null {
    const guardPath = `${this.lockPath}.recovery`;
    const owner = { ...this.createOwner(), token: randomUUID() };
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
        try {
          closeSync(descriptor);
        } catch {
          // The acquisition error remains authoritative.
        }
        try {
          unlinkIfExists(guardPath);
        } catch {
          // The store fails closed below when acquisition itself failed.
        }
      }
      if (!isFileExistsError(error)) throw this.failClosed(error);
      if (retried) return null;
      let inspection: 'missing' | 'active' | 'reclaimable';
      try {
        inspection = inspectReclaimablePath(guardPath, this.staleLockMs);
      } catch (inspectionError) {
        throw this.failClosed(inspectionError);
      }
      if (inspection === 'missing') return this.acquireRecoveryGuard(true);
      if (inspection === 'active') return null;
      const quarantinePath = `${guardPath}.${process.pid}.${randomUUID()}.stale`;
      try {
        renameSync(guardPath, quarantinePath);
        unlinkIfExists(quarantinePath);
      } catch (quarantineError) {
        if (!isFileMissingError(quarantineError)) {
          throw this.failClosed(quarantineError);
        }
      }
      return this.acquireRecoveryGuard(true);
    }
  }

  private releaseRecoveryGuard(owner: TaskOwner): void {
    const guardPath = `${this.lockPath}.recovery`;
    const current = parseLockOwner(readFileSync(guardPath, 'utf8'));
    if (!current || current.token !== owner.token) {
      throw new Error('库存删除账本文件锁恢复权已丢失');
    }
    unlinkSync(guardPath);
  }

  private async releaseLock(owner: TaskOwner): Promise<void> {
    const deadline =
      performance.now() +
      Math.min(this.lockTimeoutMs, DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS);
    while (true) {
      try {
        const current = parseLockOwner(readFileSync(this.lockPath, 'utf8'));
        if (!current || current.token !== owner.token) {
          throw new Error('库存删除账本文件锁所有权已丢失');
        }
        unlinkSync(this.lockPath);
        return;
      } catch (error) {
        if (isFileMissingError(error)) return;
        if (!isTransientLockReleaseError(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        await delay(Math.min(this.lockRetryDelayMs, remaining));
      }
    }
  }

  private deferLockRelease(owner: TaskOwner): void {
    this.deferredLockRelease = owner;
    this.deferredLockReleaseAttempt = 0;
    this.scheduleDeferredLockRelease();
  }

  private async flushDeferredLockRelease(): Promise<void> {
    const owner = this.deferredLockRelease;
    if (!owner) return;
    try {
      await this.releaseLock(owner);
      if (this.deferredLockRelease?.token === owner.token) {
        this.deferredLockRelease = null;
        this.deferredLockReleaseAttempt = 0;
      }
    } catch (error) {
      if (isTransientLockReleaseError(error)) {
        this.scheduleDeferredLockRelease();
        return;
      }
      if (this.deferredLockRelease?.token === owner.token) {
        this.deferredLockRelease = null;
        this.deferredLockReleaseAttempt = 0;
      }
    }
  }

  private scheduleDeferredLockRelease(): void {
    if (this.deferredLockReleaseTimer || !this.deferredLockRelease) return;
    const delayMs = Math.min(
      MAX_DEFERRED_LOCK_RELEASE_DELAY_MS,
      this.lockRetryDelayMs * 2 ** Math.min(this.deferredLockReleaseAttempt, 6),
    );
    this.deferredLockReleaseAttempt += 1;
    this.deferredLockReleaseTimer = setTimeout(() => {
      this.deferredLockReleaseTimer = null;
      void this.flushDeferredLockRelease();
    }, delayMs);
    this.deferredLockReleaseTimer.unref?.();
  }

  private failClosed(error: unknown): ServiceUnavailableException {
    if (!this.failed) {
      this.failed = new ServiceUnavailableException(
        `库存删除任务账本不可用：${errorMessage(error)}`,
      );
    }
    return this.failed;
  }
}

export function buildInventoryMovementDeletionRequestFingerprint(
  requestValue: CreateInventoryMovementDeletionRequest,
): string {
  const request = normalizeRequest(requestValue);
  return createHash('sha256')
    .update(
      JSON.stringify({
        clientMutationId: request.clientMutationId,
        movementType: request.movementType,
        recordId: request.recordId,
      }),
      'utf8',
    )
    .digest('hex');
}

function parseLedger(serialized: string): PersistedLedger {
  const parsed = JSON.parse(serialized) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.version !== LEDGER_VERSION ||
    !validTimestamp(parsed.updatedAt) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('库存删除任务账本结构或版本无效');
  }
  const entries = parsed.entries.map(normalizePersistedEntry);
  const taskIds = new Set<string>();
  const mutationIds = new Set<string>();
  for (const entry of entries) {
    if (
      taskIds.has(entry.task.id) ||
      mutationIds.has(entry.request.clientMutationId)
    ) {
      throw new Error('库存删除任务账本存在重复任务或变更号');
    }
    taskIds.add(entry.task.id);
    mutationIds.add(entry.request.clientMutationId);
  }
  return { version: 1, updatedAt: parsed.updatedAt, entries };
}

function normalizePersistedEntry(value: unknown): PersistedEntry {
  if (!isRecord(value)) throw new Error('库存删除任务账本条目无效');
  const entry = normalizeEntry(
    value as unknown as InventoryMovementDeletionTaskLedgerEntry,
  );
  const owner = normalizeOwner(value.owner);
  return owner && isInFlight(entry.task.status) ? { ...entry, owner } : entry;
}

function normalizeEntry(
  value: InventoryMovementDeletionTaskLedgerEntry,
): InventoryMovementDeletionTaskLedgerEntry {
  const principalFingerprint = clean(value?.principalFingerprint);
  const principal = normalizePrincipal(value?.principal);
  const request = normalizeRequest(value?.request);
  const requestFingerprint = clean(value?.requestFingerprint).toLowerCase();
  const attemptCount = Number(value?.attemptCount);
  if (
    principalFingerprint.length < 8 ||
    principalFingerprint.length > 512 ||
    CONTROL_CHARACTER_PATTERN.test(principalFingerprint) ||
    !HASH_PATTERN.test(requestFingerprint) ||
    requestFingerprint !==
      buildInventoryMovementDeletionRequestFingerprint(request) ||
    !Number.isSafeInteger(attemptCount) ||
    attemptCount < 0
  ) {
    throw new Error('库存删除任务账本幂等信息无效');
  }
  const task = normalizeTask(value?.task);
  assertTaskMatchesRequest(task, request);
  const recovery = normalizeRecoveryState(value?.recovery);
  if (recovery) assertRecoveryMatchesRequest(recovery, request);
  return cloneEntry({
    principalFingerprint,
    principal,
    requestFingerprint,
    request,
    attemptCount,
    task,
    ...(recovery ? { recovery } : {}),
  });
}

function normalizeRecoveryState(
  value: unknown,
): InventoryMovementDeletionRecoveryState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.movement)) {
    throw new Error('库存删除任务恢复计划无效');
  }
  const phase = clean(value.phase);
  const movement = {
    building: clean(value.movement.building),
    purchaseExecutionRecordId: clean(value.movement.purchaseExecutionRecordId),
    sku: clean(value.movement.sku),
    quantity: Number(value.movement.quantity),
  };
  if (
    !['prepared', 'purchase_rolled_back', 'delete_started'].includes(phase) ||
    !PURCHASE_ACCESS_BUILDINGS.includes(
      movement.building as (typeof PURCHASE_ACCESS_BUILDINGS)[number],
    ) ||
    (movement.purchaseExecutionRecordId &&
      !RECORD_ID_PATTERN.test(movement.purchaseExecutionRecordId)) ||
    !Number.isFinite(movement.quantity) ||
    movement.quantity < 0
  ) {
    throw new Error('库存删除任务恢复计划字段无效');
  }
  let purchase: InventoryMovementDeletionRecoveryState['purchase'];
  if (value.purchase !== undefined) {
    if (!isRecord(value.purchase)) {
      throw new Error('库存删除任务采购恢复计划无效');
    }
    purchase = {
      executionRecordId: clean(value.purchase.executionRecordId),
      building: clean(value.purchase.building),
      requestCode: clean(value.purchase.requestCode),
      sku: clean(value.purchase.sku),
      quantity: Number(value.purchase.quantity),
      originalFields: clonePlainRecord(value.purchase.originalFields),
      rollbackFields: clonePlainRecord(value.purchase.rollbackFields),
    };
    if (
      !RECORD_ID_PATTERN.test(purchase.executionRecordId) ||
      !PURCHASE_ACCESS_BUILDINGS.includes(
        purchase.building as (typeof PURCHASE_ACCESS_BUILDINGS)[number],
      ) ||
      !purchase.requestCode ||
      !purchase.sku ||
      !Number.isFinite(purchase.quantity) ||
      purchase.quantity <= 0 ||
      Object.keys(purchase.rollbackFields).length === 0
    ) {
      throw new Error('库存删除任务采购恢复计划字段无效');
    }
  }
  return {
    version: 1,
    phase: phase as InventoryMovementDeletionRecoveryState['phase'],
    movement,
    ...(purchase ? { purchase } : {}),
  };
}

function clonePlainRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('库存删除恢复字段快照无效');
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function assertRecoveryMatchesRequest(
  recovery: InventoryMovementDeletionRecoveryState,
  request: CreateInventoryMovementDeletionRequest,
): void {
  if (
    request.movementType !== 'inbound' &&
    (recovery.purchase || recovery.movement.purchaseExecutionRecordId)
  ) {
    throw new Error('出库删除任务不能包含采购恢复计划');
  }
  if (
    Boolean(recovery.purchase) !==
    Boolean(recovery.movement.purchaseExecutionRecordId)
  ) {
    throw new Error('库存删除任务采购恢复计划关联不一致');
  }
  if (
    recovery.purchase &&
    recovery.purchase.executionRecordId !==
      recovery.movement.purchaseExecutionRecordId
  ) {
    throw new Error('库存删除任务采购执行记录关联不一致');
  }
}

function assertRecoveryTransition(
  previous: InventoryMovementDeletionRecoveryState | undefined,
  next: InventoryMovementDeletionRecoveryState,
): void {
  if (!previous) {
    if (next.phase !== 'prepared' && next.phase !== 'delete_started') {
      throw new Error('库存删除恢复阶段起点无效');
    }
    return;
  }
  if (JSON.stringify(previous.movement) !== JSON.stringify(next.movement)) {
    throw new Error('库存删除恢复目标不能变更');
  }
  if (JSON.stringify(previous.purchase) !== JSON.stringify(next.purchase)) {
    throw new Error('库存删除采购恢复计划不能变更');
  }
  const order: Record<InventoryMovementDeletionRecoveryState['phase'], number> =
    {
      prepared: 0,
      purchase_rolled_back: 1,
      delete_started: 2,
    };
  if (order[next.phase] < order[previous.phase]) {
    throw new Error('库存删除恢复阶段不能回退');
  }
}

function normalizePrincipal(value: unknown): AccessPrincipal {
  if (!isRecord(value)) throw new Error('库存删除任务认证主体无效');
  if (validScopedBusinessPrincipal(value)) return businessAuthorizationSnapshot(value);
  if (value.role === 'admin' && value.purchaseBuilding === null) {
    return { role: 'admin', purchaseBuilding: null };
  }
  if ((value.role === 'inventory_admin' || value.role === 'building_admin') && validBuildingScope(value.role, value.purchaseBuilding, value.buildings)) {
    return { role: value.role, purchaseBuilding: value.purchaseBuilding as AccessPrincipal['purchaseBuilding'],
      ...(Array.isArray(value.buildings) ? { buildings: [...value.buildings] as NonNullable<AccessPrincipal['buildings']> } : {}) };
  }
  throw new Error('库存删除任务认证主体无效');
}

function normalizeRequest(
  value: CreateInventoryMovementDeletionRequest,
): CreateInventoryMovementDeletionRequest {
  if (!isRecord(value)) throw new Error('库存删除请求格式无效');
  const clientMutationId = clean(value.clientMutationId);
  const movementType = clean(value.movementType);
  const recordId = clean(value.recordId);
  if (
    !MUTATION_ID_PATTERN.test(clientMutationId) ||
    (movementType !== 'inbound' && movementType !== 'outbound') ||
    !RECORD_ID_PATTERN.test(recordId)
  ) {
    throw new Error('库存删除请求标识无效');
  }
  return {
    clientMutationId,
    movementType,
    recordId,
  };
}

function normalizeTask(
  value: InventoryMovementDeletionTask,
): InventoryMovementDeletionTask {
  if (!isRecord(value)) throw new Error('库存删除任务格式无效');
  const raw = value as unknown as Record<string, any>;
  const id = clean(value.id);
  const status = clean(value.status);
  const message = clean(value.message);
  const createdAt = clean(value.createdAt);
  const updatedAt = clean(value.updatedAt);
  if (
    !TASK_ID_PATTERN.test(id) ||
    !['pending', 'running', 'completed', 'failed', 'uncertain'].includes(
      status,
    ) ||
    !message ||
    CONTROL_CHARACTER_PATTERN.test(message) ||
    !validTimestamp(createdAt) ||
    !validTimestamp(updatedAt)
  ) {
    throw new Error('库存删除任务字段无效');
  }
  const base = { id, status, message, createdAt, updatedAt };
  if (status === 'pending' || status === 'running') {
    return base as InventoryMovementDeletionTask;
  }
  const completedAt = clean(raw.completedAt);
  if (!validTimestamp(completedAt)) {
    throw new Error('库存删除终态时间无效');
  }
  if (status === 'completed') {
    if (!isRecord(raw.result)) throw new Error('库存删除结果无效');
    const recordId = clean(raw.result.recordId);
    const type = clean(raw.result.type);
    const resultMessage = clean(raw.result.message);
    if (
      !RECORD_ID_PATTERN.test(recordId) ||
      (type !== 'inbound' && type !== 'outbound') ||
      typeof raw.result.purchaseRolledBack !== 'boolean' ||
      !resultMessage ||
      CONTROL_CHARACTER_PATTERN.test(resultMessage)
    ) {
      throw new Error('库存删除完成结果无效');
    }
    return {
      ...base,
      status,
      completedAt,
      result: {
        recordId,
        type,
        purchaseRolledBack: raw.result.purchaseRolledBack,
        message: resultMessage,
      },
    };
  }
  const definitelyNotDeleted = raw.definitelyNotDeleted;
  if (
    (status === 'failed' && definitelyNotDeleted !== true) ||
    (status === 'uncertain' && definitelyNotDeleted !== false)
  ) {
    throw new Error('库存删除失败结果分类无效');
  }
  return {
    ...base,
    status,
    completedAt,
    definitelyNotDeleted,
  } as InventoryMovementDeletionTask;
}

function assertTaskMatchesRequest(
  task: InventoryMovementDeletionTask,
  request: CreateInventoryMovementDeletionRequest,
): void {
  if (
    task.status === 'completed' &&
    (task.result.recordId !== request.recordId ||
      task.result.type !== request.movementType)
  ) {
    throw new Error('库存删除完成结果与请求不一致');
  }
}

function normalizeOwner(value: unknown): TaskOwner | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('库存删除任务 owner 无效');
  const owner: TaskOwner = {
    version: OWNER_VERSION,
    token: clean(value.token),
    pid: Number(value.pid),
    processStartedAtMs: Number(value.processStartedAtMs),
    acquiredAt: clean(value.acquiredAt),
    leaseExpiresAt: clean(value.leaseExpiresAt),
  };
  if (
    value.version !== OWNER_VERSION ||
    !owner.token ||
    !Number.isSafeInteger(owner.pid) ||
    !Number.isFinite(owner.processStartedAtMs) ||
    !validTimestamp(owner.acquiredAt) ||
    !validTimestamp(owner.leaseExpiresAt)
  ) {
    throw new Error('库存删除任务 owner 无效');
  }
  return owner;
}

function parseLockOwner(value: string): TaskOwner | undefined {
  try {
    return normalizeOwner(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function lockOwnerMayBeAlive(owner: TaskOwner): boolean {
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

function inspectReclaimablePath(
  path: string,
  staleAfterMs: number,
): 'missing' | 'active' | 'reclaimable' {
  try {
    const modifiedAt = statSync(path).mtimeMs;
    const owner = parseLockOwner(readFileSync(path, 'utf8'));
    if (owner) return lockOwnerMayBeAlive(owner) ? 'active' : 'reclaimable';
    return Date.now() - modifiedAt <= staleAfterMs ? 'active' : 'reclaimable';
  } catch (error) {
    if (isFileMissingError(error)) return 'missing';
    throw error;
  }
}

function evictExpiredAndOverflow(
  entries: PersistedEntry[],
  nowMs: number,
  retentionTtlMs: number,
  maximumEntries: number,
): boolean {
  let changed = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isEvictableTask(entry.task)) continue;
    const completedAt = Date.parse(entry.task.completedAt);
    if (completedAt + retentionTtlMs <= nowMs) {
      entries.splice(index, 1);
      changed = true;
    }
  }
  const evictable = entries
    .filter(
      (
        entry,
      ): entry is PersistedEntry & {
        task: Extract<
          InventoryMovementDeletionTask,
          { status: 'completed' | 'failed' }
        >;
      } => isEvictableTask(entry.task),
    )
    .sort(
      (left, right) =>
        Date.parse(left.task.completedAt) - Date.parse(right.task.completedAt),
    );
  while (entries.length > maximumEntries && evictable.length) {
    const candidate = evictable.shift()!;
    const index = entries.findIndex(
      (entry) => entry.task.id === candidate.task.id,
    );
    if (index >= 0) {
      entries.splice(index, 1);
      changed = true;
    }
  }
  return changed;
}

function blocksSameTarget(
  status: InventoryMovementDeletionTask['status'],
): boolean {
  return status === 'pending' || status === 'running';
}

function isInFlight(status: InventoryMovementDeletionTask['status']): boolean {
  return status === 'pending' || status === 'running';
}

function isTerminal(status: InventoryMovementDeletionTask['status']): boolean {
  return !isInFlight(status);
}

function isEvictableTask(
  task: InventoryMovementDeletionTask,
): task is Extract<
  InventoryMovementDeletionTask,
  { status: 'completed' | 'failed' }
> {
  return task.status === 'completed' || task.status === 'failed';
}

function cloneEntry<T extends InventoryMovementDeletionTaskLedgerEntry>(
  entry: T,
): T {
  return JSON.parse(JSON.stringify(entry)) as T;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFileExistsError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'EEXIST';
}

function isFileMissingError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function isTransientLockReleaseError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EBUSY' || code === 'EACCES' || code === 'EPERM';
}

function isNoSuchProcessError(error: unknown): boolean {
  return errorCode(error) === 'ESRCH';
}

function errorCode(error: unknown): string {
  return isRecord(error) ? clean(error.code) : '';
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
