import { businessAuthorizationSnapshot, validScopedBusinessPrincipal } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { professionalScopeIsValid } from '../../../shared/professional-access';
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
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundMovementCreateResponse,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  assertInventoryOutboundCanonicalRequest,
  assertInventoryOutboundCompletedResultMatchesRequest,
  buildInventoryOutboundRequestFingerprint,
} from './inventory-outbound-canonical';

export const INVENTORY_OUTBOUND_TASK_LEDGER_PATH =
  'INVENTORY_OUTBOUND_TASK_LEDGER_PATH';
export const INVENTORY_OUTBOUND_TASK_LEDGER_OPTIONS =
  'INVENTORY_OUTBOUND_TASK_LEDGER_OPTIONS';

const LEDGER_VERSION = 1;
const OWNER_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS = 250;
const DEFAULT_LEDGER_PERSIST_RETRY_WINDOW_MS = 500;
const MAX_DEFERRED_LOCK_RELEASE_DELAY_MS = 1_000;
const DEFAULT_TASK_LEASE_MS = 60_000;
const DEFAULT_RECENT_REQUEST_DEDUPE_MS = 10 * 60 * 1_000;
const DEFAULT_RETENTION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);
const RECOVERED_UNCERTAIN_MESSAGE =
  '服务进程在外部创建阶段失联，结果暂不确定；系统不会重复创建，将通过原编号对账并按需幂等补齐';

export type InventoryOutboundLedgerTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'uncertain';

export interface InventoryOutboundLedgerTask {
  id: string;
  status: InventoryOutboundLedgerTaskStatus;
  message: string;
  createdAt: string;
  preflightAttemptCount?: number;
  lastPreflightAttemptAt?: string;
  completedAt?: string;
  result?: InventoryOutboundMovementCreateResponse;
  definitelyNotWritten?: boolean;
}

export interface InventoryOutboundTaskLedgerEntry {
  professionalPrincipal?: AccessPrincipal;
  building: WarehouseBuilding;
  principalFingerprint: string;
  clientMutationId: string;
  requestFingerprint: string;
  request: InventoryOutboundMovementCreateRequest;
  task: InventoryOutboundLedgerTask;
}

interface TaskOwner {
  version: 1;
  token: string;
  pid: number;
  processStartedAtMs: number;
  acquiredAt: string;
  instanceToken?: string;
  leaseExpiresAt?: string;
}

interface PersistedEntry extends InventoryOutboundTaskLedgerEntry {
  owner?: TaskOwner;
}

interface PersistedLedger {
  version: 1;
  updatedAt: string;
  entries: PersistedEntry[];
}

export interface InventoryOutboundTaskLedgerStoreOptions {
  now?: () => Date;
  retentionTtlMs?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockRetryDelayMs?: number;
  taskLeaseMs?: number;
  recentRequestDedupeMs?: number;
}

@Injectable()
export class InventoryOutboundTaskLedgerStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly retentionTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly taskLeaseMs: number;
  private readonly recentRequestDedupeMs: number;
  private readonly taskOwnerToken = randomUUID();
  private readonly claimedTaskIds = new Set<string>();
  private deferredLockRelease: TaskOwner | null = null;
  private deferredLockReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredLockReleaseAttempt = 0;
  private failed: ServiceUnavailableException | null = null;

  constructor(
    @Optional()
    @Inject(INVENTORY_OUTBOUND_TASK_LEDGER_PATH)
    ledgerPathValue?: string,
    @Optional()
    @Inject(INVENTORY_OUTBOUND_TASK_LEDGER_OPTIONS)
    options: InventoryOutboundTaskLedgerStoreOptions = {},
  ) {
    this.ledgerPath = resolve(
      ledgerPathValue?.trim() ||
        join(process.cwd(), '.runtime', 'inventory-outbound-task-ledger.json'),
    );
    this.lockPath = `${this.ledgerPath}.lock`;
    this.now = options.now || (() => new Date());
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
    this.taskLeaseMs = positiveInteger(
      options.taskLeaseMs,
      DEFAULT_TASK_LEASE_MS,
    );
    this.recentRequestDedupeMs = positiveInteger(
      options.recentRequestDedupeMs,
      DEFAULT_RECENT_REQUEST_DEDUPE_MS,
    );
  }

  async reserve(entryValue: InventoryOutboundTaskLedgerEntry): Promise<{
    created: boolean;
    entry: InventoryOutboundTaskLedgerEntry;
  }> {
    const entry = normalizeEntry(entryValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover({
        protectedClientMutationId: entry.clientMutationId,
      });
      const existingByMutationId = loaded.entries.find(
        (candidate) => candidate.clientMutationId === entry.clientMutationId,
      );
      const existing =
        existingByMutationId ||
        findRecentEquivalentRequestEntry(
          loaded.entries,
          entry,
          this.now().getTime(),
          this.recentRequestDedupeMs,
        );
      if (existing) {
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, existing.task.id);
        }
        return { created: false, entry: cloneEntry(existing) };
      }
      if (
        loaded.entries.some((candidate) => candidate.task.id === entry.task.id)
      ) {
        throw this.failClosed(new Error('出库任务编号冲突'));
      }
      evictForCapacity(loaded.entries, this.maxEntries - 1);
      if (loaded.entries.length >= this.maxEntries) {
        throw new ServiceUnavailableException(
          '出库幂等任务账本容量已满，存在不能安全清理的在途或不确定任务',
        );
      }
      loaded.entries.push(entry);
      await this.persistLocked(loaded.entries, entry.task.id, entry.task.id);
      return { created: true, entry: cloneEntry(entry) };
    });
  }

  async claimPending(taskIdValue: string): Promise<{
    claimed: boolean;
    entry: InventoryOutboundTaskLedgerEntry;
  }> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry) throw this.failClosed(new Error('出库持久任务不存在'));
      if (
        entry.task.status !== 'pending' ||
        entry.owner ||
        this.claimedTaskIds.has(taskId)
      ) {
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, entry.task.id);
        }
        return { claimed: false, entry: cloneEntry(entry) };
      }
      entry.owner = this.createTaskOwner();
      await this.persistLocked(loaded.entries, taskId);
      this.claimedTaskIds.add(taskId);
      return { claimed: true, entry: cloneEntry(entry) };
    });
  }

  async claimUncertain(taskIdValue: string): Promise<{
    claimed: boolean;
    entry: InventoryOutboundTaskLedgerEntry;
  }> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover({ protectedTaskId: taskId });
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry) throw this.failClosed(new Error('出库持久任务不存在'));
      if (
        entry.task.status !== 'uncertain' ||
        entry.owner ||
        this.claimedTaskIds.has(taskId)
      ) {
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, entry.task.id);
        }
        return { claimed: false, entry: cloneEntry(entry) };
      }
      entry.owner = this.createTaskOwner();
      await this.persistLocked(loaded.entries, taskId);
      this.claimedTaskIds.add(taskId);
      return { claimed: true, entry: cloneEntry(entry) };
    });
  }

  async updateTask(
    taskIdValue: string,
    taskValue: InventoryOutboundLedgerTask,
  ): Promise<InventoryOutboundTaskLedgerEntry> {
    const taskId = clean(taskIdValue);
    const task = normalizeTask(taskValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry) throw this.failClosed(new Error('出库持久任务不存在'));
      if (task.id !== taskId) {
        throw this.failClosed(new Error('出库持久任务编号不一致'));
      }
      if (entry.task.status === 'pending' || entry.task.status === 'running') {
        if (
          !entry.owner ||
          !this.ownsTask(entry.owner) ||
          !this.claimedTaskIds.has(taskId)
        ) {
          throw this.failClosed(new Error('出库持久任务 owner 已变更'));
        }
      } else {
        throw this.failClosed(new Error('出库终态任务不能再次更新'));
      }
      if (entry.task.status === 'running' && task.status === 'pending') {
        throw this.failClosed(new Error('出库运行任务不能退回等待态'));
      }
      if (task.status === 'completed' && task.result) {
        assertInventoryOutboundCompletedResultMatchesRequest(
          entry.request,
          task.result,
        );
      }
      entry.task = task;
      if (isTerminal(task.status)) {
        delete entry.owner;
      } else if (entry.owner) {
        entry.owner = this.extendTaskOwnerLease(entry.owner);
      }
      await this.persistLocked(loaded.entries, taskId);
      if (isTerminal(task.status)) this.claimedTaskIds.delete(taskId);
      return cloneEntry(entry);
    });
  }

  async requeueDefinitelyRejectedWrite(
    taskIdValue: string,
    messageValue: string,
  ): Promise<InventoryOutboundTaskLedgerEntry> {
    const taskId = clean(taskIdValue);
    const message = clean(messageValue);
    if (!message) throw new Error('出库重试原因不能为空');
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (
        !entry ||
        entry.task.status !== 'running' ||
        !entry.owner ||
        !this.ownsTask(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        throw this.failClosed(new Error('出库运行任务 owner 已变更'));
      }
      entry.task = normalizeTask({
        ...entry.task,
        status: 'pending',
        message,
        preflightAttemptCount: entry.task.preflightAttemptCount || 1,
        lastPreflightAttemptAt: this.now().toISOString(),
        completedAt: undefined,
        definitelyNotWritten: undefined,
      });
      delete entry.owner;
      this.claimedTaskIds.delete(taskId);
      await this.persistLocked(loaded.entries, taskId);
      return cloneEntry(entry);
    });
  }

  async renewClaim(
    taskIdValue: string,
  ): Promise<InventoryOutboundTaskLedgerEntry> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (
        !entry ||
        (entry.task.status !== 'pending' &&
          entry.task.status !== 'running' &&
          entry.task.status !== 'uncertain') ||
        !entry.owner ||
        !this.ownsTask(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        this.claimedTaskIds.delete(taskId);
        throw new ServiceUnavailableException(
          '出库持久任务 lease 所有权已变更',
        );
      }
      entry.owner = this.extendTaskOwnerLease(entry.owner);
      await this.persistLocked(loaded.entries, taskId);
      return cloneEntry(entry);
    });
  }

  async abandonPendingClaim(taskIdValue: string): Promise<boolean> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry || entry.task.status !== 'pending') {
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, entry?.task.id);
        }
        return false;
      }
      if (
        !entry.owner ||
        !this.ownsTask(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, entry.task.id);
        }
        return false;
      }
      delete entry.owner;
      this.claimedTaskIds.delete(taskId);
      await this.persistLocked(loaded.entries);
      return true;
    });
  }

  async abandonUncertainClaim(taskIdValue: string): Promise<boolean> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover({ protectedTaskId: taskId });
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry || entry.task.status !== 'uncertain') {
        this.claimedTaskIds.delete(taskId);
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, entry?.task.id);
        }
        return false;
      }
      if (
        !entry.owner ||
        !this.ownsTask(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        this.claimedTaskIds.delete(taskId);
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, entry.task.id);
        }
        return false;
      }
      delete entry.owner;
      this.claimedTaskIds.delete(taskId);
      await this.persistLocked(loaded.entries);
      return true;
    });
  }

  async reconcileUncertain(
    taskIdValue: string,
    result: InventoryOutboundMovementCreateResponse,
  ): Promise<InventoryOutboundTaskLedgerEntry> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover({ protectedTaskId: taskId });
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (!entry) throw this.failClosed(new Error('出库持久任务不存在'));
      if (entry.task.status === 'completed') return cloneEntry(entry);
      if (entry.task.status !== 'uncertain') {
        throw this.failClosed(
          new Error('只有结果不确定的出库任务可以执行原编号对账'),
        );
      }
      if (
        !entry.owner ||
        !this.ownsTask(entry.owner) ||
        !this.claimedTaskIds.has(taskId)
      ) {
        this.claimedTaskIds.delete(taskId);
        throw new ServiceUnavailableException('出库不确定任务 owner 已变更');
      }
      const completedTask = normalizeTask({
        ...entry.task,
        status: 'completed',
        message: result.message,
        result,
        completedAt: this.now().toISOString(),
        definitelyNotWritten: undefined,
      });
      assertInventoryOutboundCompletedResultMatchesRequest(
        entry.request,
        result,
      );
      entry.task = completedTask;
      delete entry.owner;
      await this.persistLocked(loaded.entries, taskId);
      this.claimedTaskIds.delete(taskId);
      return cloneEntry(entry);
    });
  }

  async findByTaskId(
    taskIdValue: string,
  ): Promise<InventoryOutboundTaskLedgerEntry | undefined> {
    const taskId = clean(taskIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover({ protectedTaskId: taskId });
      const entry = loaded.entries.find(
        (candidate) => candidate.task.id === taskId,
      );
      if (loaded.changed) {
        await this.persistLocked(loaded.entries, entry?.task.id);
      }
      return entry ? cloneEntry(entry) : undefined;
    });
  }

  async findByMutationId(
    clientMutationIdValue: string,
  ): Promise<InventoryOutboundTaskLedgerEntry | undefined> {
    const clientMutationId = clean(clientMutationIdValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover({
        protectedClientMutationId: clientMutationId,
      });
      const entry = loaded.entries.find(
        (candidate) => candidate.clientMutationId === clientMutationId,
      );
      if (loaded.changed) {
        await this.persistLocked(loaded.entries, entry?.task.id);
      }
      return entry ? cloneEntry(entry) : undefined;
    });
  }

  async listPending(): Promise<InventoryOutboundTaskLedgerEntry[]> {
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      if (loaded.changed) await this.persistLocked(loaded.entries);
      return loaded.entries
        .filter((entry) => entry.task.status === 'pending')
        .map(cloneEntry);
    });
  }

  async listUncertain(): Promise<InventoryOutboundTaskLedgerEntry[]> {
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      if (loaded.changed) await this.persistLocked(loaded.entries);
      return loaded.entries
        .filter((entry) => entry.task.status === 'uncertain')
        .map(cloneEntry);
    });
  }

  getLeaseHeartbeatIntervalMs(): number {
    return Math.max(50, Math.floor(this.taskLeaseMs / 3));
  }

  private readLatestAndRecover(protection?: {
    protectedTaskId?: string;
    protectedClientMutationId?: string;
  }): {
    entries: PersistedEntry[];
    changed: boolean;
  } {
    if (this.failed) throw this.failed;
    try {
      if (!existsSync(this.ledgerPath)) return { entries: [], changed: false };
      if (statSync(this.ledgerPath).size > this.maxFileBytes) {
        throw new Error('出库任务账本超过允许的最大字节数');
      }
      const parsed = parseLedger(readFileSync(this.ledgerPath, 'utf8'));
      let changed = false;
      const nowMs = this.now().getTime();
      for (const entry of parsed.entries) {
        if (
          entry.task.status === 'pending' ||
          entry.task.status === 'uncertain'
        ) {
          if (entry.owner && !taskOwnerLeaseIsActive(entry.owner, nowMs)) {
            delete entry.owner;
            this.claimedTaskIds.delete(entry.task.id);
            changed = true;
          }
          continue;
        }
        if (entry.task.status !== 'running') continue;
        if (entry.owner && taskOwnerLeaseIsActive(entry.owner, nowMs)) continue;
        entry.task = {
          ...entry.task,
          status: 'uncertain',
          message: RECOVERED_UNCERTAIN_MESSAGE,
          definitelyNotWritten: false,
          completedAt: this.now().toISOString(),
        };
        delete entry.owner;
        this.claimedTaskIds.delete(entry.task.id);
        changed = true;
      }
      const retainedEntries = parsed.entries.filter((entry) => {
        if (!isEvictable(entry.task.status)) return true;
        const completedAt = Date.parse(entry.task.completedAt || '');
        const expired =
          Number.isFinite(completedAt) &&
          completedAt + this.retentionTtlMs <= nowMs;
        if (expired) changed = true;
        return !expired;
      });
      if (
        evictForCapacity(
          retainedEntries,
          this.maxEntries,
          protectedTaskIds(retainedEntries, protection),
        )
      ) {
        changed = true;
      }
      if (retainedEntries.length > this.maxEntries) {
        throw new ServiceUnavailableException(
          '出库幂等任务账本容量超限，存在不能安全清理的在途或不确定任务',
        );
      }
      return { entries: retainedEntries, changed };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.failClosed(error);
    }
  }

  private createTaskOwner(): TaskOwner {
    const now = this.now();
    return {
      version: OWNER_VERSION,
      token: randomUUID(),
      pid: process.pid,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      acquiredAt: now.toISOString(),
      instanceToken: this.taskOwnerToken,
      leaseExpiresAt: new Date(now.getTime() + this.taskLeaseMs).toISOString(),
    };
  }

  private extendTaskOwnerLease(owner: TaskOwner): TaskOwner {
    return {
      ...owner,
      leaseExpiresAt: new Date(
        this.now().getTime() + this.taskLeaseMs,
      ).toISOString(),
    };
  }

  private ownsTask(owner: TaskOwner): boolean {
    return (
      owner.instanceToken === this.taskOwnerToken &&
      owner.pid === process.pid &&
      Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) < 5_000
    );
  }

  private async persistLocked(
    entries: PersistedEntry[],
    protectedTaskId?: string,
    reserveClaimForTaskId?: string,
  ): Promise<void> {
    if (this.failed) throw this.failed;
    const updatedAt = this.now().toISOString();
    const reservedOwner = reserveClaimForTaskId
      ? this.createTaskOwner()
      : undefined;
    let serialized = serializeLedger(entries, updatedAt);
    while (
      serializedLedgerBytes(
        entries,
        updatedAt,
        reserveClaimForTaskId,
        reservedOwner,
      ) > this.maxFileBytes
    ) {
      const candidate = oldestEvictableEntry(entries, protectedTaskId);
      if (!candidate) {
        throw new ServiceUnavailableException(
          '出库幂等任务账本字节容量不足，存在不能安全清理的当前、在途或不确定任务',
        );
      }
      const index = entries.findIndex(
        (entry) => entry.task.id === candidate.task.id,
      );
      if (index < 0) {
        throw new ServiceUnavailableException('出库幂等任务账本字节容量不足');
      }
      entries.splice(index, 1);
      serialized = serializeLedger(entries, updatedAt);
    }
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let primaryError: unknown;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      await this.renameLedgerFile(temporaryPath);
    } catch (error) {
      primaryError = error;
    }
    const cleanupError = cleanupTemporaryFile(temporaryPath, descriptor);
    if (primaryError !== undefined) {
      if (isTransientLedgerPersistenceError(primaryError)) {
        const failure = new ServiceUnavailableException(
          `出库幂等任务账本暂时被占用，将自动重试：${safeErrorMessage(primaryError)}`,
        );
        attachCleanupError(failure, cleanupError);
        throw failure;
      }
      const failure = this.failClosed(primaryError);
      attachCleanupError(failure, cleanupError);
      throw failure;
    }
    if (cleanupError !== undefined) {
      if (isTransientLedgerPersistenceError(cleanupError)) {
        throw new ServiceUnavailableException(
          `出库幂等任务账本临时文件清理延后：${safeErrorMessage(cleanupError)}`,
        );
      }
      throw this.failClosed(cleanupError);
    }
  }

  private async renameLedgerFile(temporaryPath: string): Promise<void> {
    const deadline =
      performance.now() +
      Math.min(this.lockTimeoutMs, DEFAULT_LEDGER_PERSIST_RETRY_WINDOW_MS);
    while (true) {
      try {
        renameSync(temporaryPath, this.ledgerPath);
        return;
      } catch (error) {
        if (!isTransientLedgerPersistenceError(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        await delay(Math.min(this.lockRetryDelayMs, remaining));
      }
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
      if (primaryError instanceof Error) {
        attachCleanupError(primaryError, cleanupError);
      }
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
      const owner: TaskOwner = {
        version: OWNER_VERSION,
        token: randomUUID(),
        pid: process.pid,
        processStartedAtMs: PROCESS_STARTED_AT_MS,
        acquiredAt: this.now().toISOString(),
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
          `出库幂等任务账本暂时繁忙：等待文件锁超时：${this.lockPath}`,
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
      const failure = this.failClosed(primaryError);
      attachCleanupError(failure, cleanupError);
      throw failure;
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

  private acquireRecoveryGuard(retried = false): TaskOwner | null {
    const guardPath = `${this.lockPath}.recovery`;
    const owner: TaskOwner = {
      version: OWNER_VERSION,
      token: randomUUID(),
      pid: process.pid,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      acquiredAt: this.now().toISOString(),
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
      if (descriptor !== undefined) cleanupOwnedLockFile(guardPath, descriptor);
      if (!isFileExistsError(error)) throw this.failClosed(error);
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
  }

  private releaseRecoveryGuard(owner: TaskOwner): void {
    const guardPath = `${this.lockPath}.recovery`;
    const current = parseOwner(readFileSync(guardPath, 'utf8'));
    if (!current || current.token !== owner.token) {
      throw new Error('出库账本文件锁恢复权已丢失');
    }
    unlinkSync(guardPath);
  }

  private async releaseLock(owner: TaskOwner): Promise<void> {
    const deadline =
      performance.now() +
      Math.min(this.lockTimeoutMs, DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS);
    while (true) {
      try {
        const current = parseOwner(readFileSync(this.lockPath, 'utf8'));
        if (!current || current.token !== owner.token) {
          throw new Error('出库账本文件锁所有权已丢失');
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
      const detail = error instanceof Error ? error.message : String(error);
      this.failed = new ServiceUnavailableException(
        `出库幂等任务账本不可用：${detail}`,
      );
    }
    return this.failed;
  }
}

function parseLedger(value: string): PersistedLedger {
  const parsed = JSON.parse(value) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.version !== LEDGER_VERSION ||
    !validTimestamp(parsed.updatedAt) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('出库任务账本结构或版本无效');
  }
  const entries = parsed.entries.map(normalizePersistedEntry);
  const taskIds = new Set<string>();
  const mutationIds = new Set<string>();
  for (const entry of entries) {
    if (taskIds.has(entry.task.id) || mutationIds.has(entry.clientMutationId)) {
      throw new Error('出库任务账本存在重复任务或创建标识');
    }
    taskIds.add(entry.task.id);
    mutationIds.add(entry.clientMutationId);
  }
  return {
    version: LEDGER_VERSION,
    updatedAt: parsed.updatedAt,
    entries,
  };
}

function normalizePersistedEntry(value: unknown): PersistedEntry {
  if (!isRecord(value)) throw new Error('出库任务账本条目无效');
  const entry = normalizeEntry(value as InventoryOutboundTaskLedgerEntry);
  if (
    entry.task.status !== 'pending' &&
    entry.task.status !== 'running' &&
    entry.task.status !== 'uncertain'
  ) {
    return entry;
  }
  const owner = normalizeTaskOwner(value.owner);
  return owner ? { ...entry, owner } : entry;
}

function normalizeEntry(
  value: InventoryOutboundTaskLedgerEntry,
): InventoryOutboundTaskLedgerEntry {
  const building = clean(value?.building) as WarehouseBuilding;
  const principalFingerprint = clean(value?.principalFingerprint);
  const clientMutationId = clean(value?.clientMutationId);
  const requestFingerprint = clean(value?.requestFingerprint).toLowerCase();
  if (
    !WAREHOUSE_BUILDINGS.includes(building) ||
    principalFingerprint.length < 8 ||
    principalFingerprint.length > 512 ||
    CONTROL_CHARACTER_PATTERN.test(principalFingerprint) ||
    !MUTATION_ID_PATTERN.test(clientMutationId) ||
    !HASH_PATTERN.test(requestFingerprint) ||
    !isRecord(value?.request)
  ) {
    throw new Error('出库任务账本幂等信息无效');
  }
  const request = normalizeRequest(value.request);
  if (
    request.clientMutationId !== clientMutationId ||
    request.building !== building
  ) {
    throw new Error('出库任务账本请求身份不一致');
  }
  if (
    buildInventoryOutboundRequestFingerprint(request) !== requestFingerprint
  ) {
    throw new Error('出库任务账本请求指纹与规范请求不一致');
  }
  if (value.professionalPrincipal && !validScopedBusinessPrincipal(value.professionalPrincipal)) throw new Error('专业出库任务身份无效');
  const task = normalizeTask(value.task);
  if (task.status === 'completed' && task.result) {
    assertInventoryOutboundCompletedResultMatchesRequest(request, task.result);
  }
  return cloneEntry({
    building,
    principalFingerprint,
    clientMutationId,
    requestFingerprint,
    request,
    ...(value.professionalPrincipal ? { professionalPrincipal: businessAuthorizationSnapshot(value.professionalPrincipal) } : {}),
    task,
  });
}

function normalizeRequest(
  value: InventoryOutboundMovementCreateRequest,
): InventoryOutboundMovementCreateRequest {
  try {
    assertInventoryOutboundCanonicalRequest(value);
  } catch {
    throw new Error('出库任务账本规范请求无效');
  }
  if (
    value.type !== 'outbound' ||
    !clean(value.clientMutationId) ||
    !clean(value.catalogRecordId) ||
    !clean(value.sku) ||
    !WAREHOUSE_BUILDINGS.includes(value.building) ||
    typeof value.quantity !== 'number' ||
    !Number.isFinite(value.quantity) ||
    !clean(value.occurredAt) ||
    !clean(value.applicantOpenId) ||
    !clean(value.reason)
  ) {
    throw new Error('出库任务账本规范请求无效');
  }
  const request: InventoryOutboundMovementCreateRequest = {
    type: 'outbound',
    clientMutationId: clean(value.clientMutationId),
    catalogRecordId: clean(value.catalogRecordId),
    sku: clean(value.sku),
    building: value.building,
    quantity: value.quantity,
    occurredAt: clean(value.occurredAt),
    applicantOpenId: clean(value.applicantOpenId),
    reason: clean(value.reason),
  };
  try {
    assertInventoryOutboundCanonicalRequest(request);
  } catch {
    throw new Error('出库任务账本规范请求无效');
  }
  return request;
}

function normalizeTask(
  value: InventoryOutboundLedgerTask,
): InventoryOutboundLedgerTask {
  if (!isRecord(value)) throw new Error('出库任务内容无效');
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
    throw new Error('出库任务内容无效');
  }
  if (status === 'completed' && !value.result) {
    throw new Error('已完成的出库任务缺少规范结果');
  }
  if (status === 'failed' && value.definitelyNotWritten !== true) {
    throw new Error('失败的出库任务缺少未写入证明');
  }
  const hasAttemptCount = value.preflightAttemptCount !== undefined;
  const hasAttemptTimestamp = value.lastPreflightAttemptAt !== undefined;
  if (
    hasAttemptCount !== hasAttemptTimestamp ||
    (hasAttemptCount &&
      (!Number.isSafeInteger(value.preflightAttemptCount) ||
        Number(value.preflightAttemptCount) < 1 ||
        !validTimestamp(value.lastPreflightAttemptAt)))
  ) {
    throw new Error('出库任务预写入重试信息无效');
  }
  return JSON.parse(JSON.stringify(value)) as InventoryOutboundLedgerTask;
}

function findRecentEquivalentRequestEntry(
  entries: readonly PersistedEntry[],
  incoming: InventoryOutboundTaskLedgerEntry,
  nowMs: number,
  dedupeWindowMs: number,
): PersistedEntry | undefined {
  return entries.find(
    (candidate) =>
      candidate.building === incoming.building &&
      candidate.principalFingerprint === incoming.principalFingerprint &&
      candidate.requestFingerprint === incoming.requestFingerprint &&
      shouldReuseEquivalentRequest(candidate.task, nowMs, dedupeWindowMs),
  );
}

function shouldReuseEquivalentRequest(
  task: InventoryOutboundLedgerTask,
  nowMs: number,
  dedupeWindowMs: number,
): boolean {
  if (
    task.status === 'pending' ||
    task.status === 'running' ||
    task.status === 'uncertain'
  ) {
    return true;
  }
  if (task.status !== 'completed') return false;
  const completedAt = Date.parse(task.completedAt || '');
  return Number.isFinite(completedAt) && completedAt >= nowMs - dedupeWindowMs;
}

function cloneEntry(entry: PersistedEntry): InventoryOutboundTaskLedgerEntry {
  const { owner: _owner, ...publicEntry } = clonePersistedEntry(entry);
  return publicEntry;
}

function clonePersistedEntry(entry: PersistedEntry): PersistedEntry {
  return JSON.parse(JSON.stringify(entry)) as PersistedEntry;
}

function normalizeOwner(value: unknown): TaskOwner | null {
  if (
    !isRecord(value) ||
    value.version !== OWNER_VERSION ||
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
    version: OWNER_VERSION,
    token: clean(value.token),
    pid: value.pid,
    processStartedAtMs: value.processStartedAtMs,
    acquiredAt: value.acquiredAt,
    ...(clean(value.instanceToken) && validTimestamp(value.leaseExpiresAt)
      ? {
          instanceToken: clean(value.instanceToken),
          leaseExpiresAt: value.leaseExpiresAt,
        }
      : {}),
  };
}

function normalizeTaskOwner(value: unknown): TaskOwner | null {
  const owner = normalizeOwner(value);
  return owner?.instanceToken && owner.leaseExpiresAt ? owner : null;
}

function parseOwner(value: string): TaskOwner | null {
  try {
    return normalizeOwner(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function taskOwnerLeaseIsActive(owner: TaskOwner, nowMs: number): boolean {
  return Boolean(
    owner.instanceToken &&
    owner.leaseExpiresAt &&
    Date.parse(owner.leaseExpiresAt) > nowMs,
  );
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
    const owner = parseOwner(readFileSync(path, 'utf8'));
    if (owner) return lockOwnerMayBeAlive(owner) ? 'active' : 'reclaimable';
    return Date.now() - modifiedAt < staleAfterMs ? 'active' : 'reclaimable';
  } catch (error) {
    if (isFileMissingError(error)) return 'missing';
    throw error;
  }
}

function isTerminal(status: InventoryOutboundLedgerTaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'uncertain'
  );
}

function isEvictable(status: InventoryOutboundLedgerTaskStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function evictForCapacity(
  entries: PersistedEntry[],
  maximumEntries: number,
  protectedIds: ReadonlySet<string> = new Set(),
): boolean {
  if (entries.length <= maximumEntries) return false;
  const evictable = entries
    .filter(
      (entry) =>
        !protectedIds.has(entry.task.id) && isEvictable(entry.task.status),
    )
    .sort(
      (left, right) =>
        taskTerminalTimestamp(left) - taskTerminalTimestamp(right),
    );
  let changed = false;
  while (entries.length > maximumEntries && evictable.length > 0) {
    const candidate = evictable.shift()!;
    const index = entries.findIndex(
      (entry) => entry.task.id === candidate.task.id,
    );
    if (index < 0) continue;
    entries.splice(index, 1);
    changed = true;
  }
  return changed;
}

function oldestEvictableEntry(
  entries: PersistedEntry[],
  protectedTaskId?: string,
): PersistedEntry | undefined {
  return entries
    .filter(
      (entry) =>
        entry.task.id !== protectedTaskId && isEvictable(entry.task.status),
    )
    .sort(
      (left, right) =>
        taskTerminalTimestamp(left) - taskTerminalTimestamp(right),
    )[0];
}

function serializeLedger(entries: PersistedEntry[], updatedAt: string): string {
  const state: PersistedLedger = {
    version: LEDGER_VERSION,
    updatedAt,
    entries: entries.map(clonePersistedEntry),
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}

function serializedLedgerBytes(
  entries: PersistedEntry[],
  updatedAt: string,
  reserveClaimForTaskId: string | undefined,
  reservedOwner: TaskOwner | undefined,
): number {
  if (!reserveClaimForTaskId || !reservedOwner) {
    return Buffer.byteLength(serializeLedger(entries, updatedAt), 'utf8');
  }
  const simulatedEntries = entries.map(clonePersistedEntry);
  const reservedEntry = simulatedEntries.find(
    (entry) => entry.task.id === reserveClaimForTaskId,
  );
  if (!reservedEntry || reservedEntry.task.status !== 'pending') {
    return Number.POSITIVE_INFINITY;
  }
  reservedEntry.owner = reservedOwner;
  return Buffer.byteLength(
    serializeLedger(simulatedEntries, updatedAt),
    'utf8',
  );
}

function protectedTaskIds(
  entries: PersistedEntry[],
  protection?: {
    protectedTaskId?: string;
    protectedClientMutationId?: string;
  },
): Set<string> {
  const protectedIds = new Set<string>();
  if (protection?.protectedTaskId) {
    protectedIds.add(protection.protectedTaskId);
  }
  if (protection?.protectedClientMutationId) {
    const matchingEntry = entries.find(
      (entry) =>
        entry.clientMutationId === protection.protectedClientMutationId,
    );
    if (matchingEntry) protectedIds.add(matchingEntry.task.id);
  }
  return protectedIds;
}

function taskTerminalTimestamp(entry: PersistedEntry): number {
  const completedAt = Date.parse(entry.task.completedAt || '');
  if (Number.isFinite(completedAt)) return completedAt;
  const createdAt = Date.parse(entry.task.createdAt);
  return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER;
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
  return cleanupError ?? removeIfExists(temporaryPath);
}

function cleanupOwnedLockFile(lockPath: string, descriptor: number): unknown {
  let cleanupError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    cleanupError = error;
  }
  return cleanupError ?? removeIfExists(lockPath);
}

function removeIfExists(path: string): unknown {
  try {
    if (existsSync(path)) unlinkSync(path);
    return undefined;
  } catch (error) {
    return error;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, Math.max(1, milliseconds));
  });
}

function isFileExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isFileMissingError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isTransientLockReleaseError(error: unknown): boolean {
  return isTransientLedgerPersistenceError(error);
}

function isTransientLedgerPersistenceError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EBUSY' || code === 'EACCES' || code === 'EPERM';
}

function isNoSuchProcessError(error: unknown): boolean {
  return errorCode(error) === 'ESRCH';
}

function errorCode(error: unknown): string {
  return isRecord(error) ? clean(error.code) : '';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
