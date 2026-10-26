import {
  ConflictException,
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
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundCategoryTask,
} from '../../../shared/inventory-management.interface';
import { buildStableInventoryMutationFingerprint } from './inventory-idempotency-fingerprint';

export const PURCHASE_INBOUND_CATEGORY_TASK_LEDGER_PATH =
  'PURCHASE_INBOUND_CATEGORY_TASK_LEDGER_PATH';
export const PURCHASE_INBOUND_CATEGORY_TASK_LEDGER_OPTIONS =
  'PURCHASE_INBOUND_CATEGORY_TASK_LEDGER_OPTIONS';

const LEDGER_VERSION = 1;
const DEFAULT_TASK_LEASE_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS = 250;
const DEFAULT_PERSIST_RETRY_WINDOW_MS = 500;
const MAX_DEFERRED_LOCK_RELEASE_DELAY_MS = 1_000;
const DEFAULT_RETENTION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1_024 * 1_024;

interface TaskOwner {
  token: string;
  acquiredAt: string;
  leaseExpiresAt: string;
}

export interface PurchaseInboundCategoryTaskLedgerEntry {
  principal: AccessPrincipal;
  principalFingerprint: string;
  requestFingerprint: string;
  request: PurchaseInboundCategoryPrepareRequest;
  attemptCount: number;
  task: PurchaseInboundCategoryTask;
  owner?: TaskOwner;
}

interface PersistedLedger {
  version: 1;
  updatedAt: string;
  entries: PurchaseInboundCategoryTaskLedgerEntry[];
  extensions?: Record<string, unknown>;
}

export interface PurchaseInboundCategoryTaskLedgerStoreOptions {
  now?: () => Date;
  taskLeaseMs?: number;
  lockTimeoutMs?: number;
  lockRetryDelayMs?: number;
  staleLockMs?: number;
  retentionTtlMs?: number;
  maxEntries?: number;
  maxFileBytes?: number;
}

@Injectable()
export class PurchaseInboundCategoryTaskLedgerStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly taskLeaseMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly staleLockMs: number;
  private readonly retentionTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly claimedTaskIds = new Set<string>();
  private deferredLockRelease: TaskOwner | null = null;
  private deferredLockReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredLockReleaseAttempt = 0;
  private failed: ServiceUnavailableException | null = null;

  constructor(
    @Optional()
    @Inject(PURCHASE_INBOUND_CATEGORY_TASK_LEDGER_PATH)
    ledgerPathValue?: string,
    @Optional()
    @Inject(PURCHASE_INBOUND_CATEGORY_TASK_LEDGER_OPTIONS)
    options: PurchaseInboundCategoryTaskLedgerStoreOptions = {},
  ) {
    this.ledgerPath = resolve(
      clean(ledgerPathValue) ||
        clean(process.env.PURCHASE_INBOUND_CATEGORY_TASK_LEDGER_PATH) ||
        join(
          process.cwd(),
          '.runtime',
          'purchase-inbound-category-task-ledger.json',
        ),
    );
    this.lockPath = `${this.ledgerPath}.lock`;
    this.now = options.now || (() => new Date());
    this.taskLeaseMs = positive(options.taskLeaseMs, DEFAULT_TASK_LEASE_MS);
    this.lockTimeoutMs = positive(
      options.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
    );
    this.lockRetryDelayMs = positive(
      options.lockRetryDelayMs,
      DEFAULT_LOCK_RETRY_DELAY_MS,
    );
    this.staleLockMs = positive(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
    this.retentionTtlMs = positive(
      options.retentionTtlMs,
      DEFAULT_RETENTION_TTL_MS,
    );
    this.maxEntries = positive(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxFileBytes = positive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  }

  async reserve(entryValue: PurchaseInboundCategoryTaskLedgerEntry): Promise<{
    created: boolean;
    entry: PurchaseInboundCategoryTaskLedgerEntry;
  }> {
    const candidate = cloneEntry(entryValue);
    return this.withLedgerLock(async () => {
      const ledger = this.readLedger();
      const outcome = this.reserveInLedger(ledger, candidate);
      if (outcome.changed) await this.writeLedger(ledger);
      return outcome.result;
    });
  }

  protected reserveInLedger(ledger: PersistedLedger, candidate: PurchaseInboundCategoryTaskLedgerEntry): {
    result: { created: boolean; entry: PurchaseInboundCategoryTaskLedgerEntry }; changed: boolean;
  } {
      const existing = ledger.entries.find(
        (entry) =>
          entry.request.clientMutationId === candidate.request.clientMutationId,
      );
      if (existing) {
        if (existing.requestFingerprint !== candidate.requestFingerprint) {
          const migratedFingerprint =
            this.fingerprintPersistedRequest(existing);
          if (
            migratedFingerprint !== candidate.requestFingerprint &&
            !this.sameBusinessRequest(existing, candidate)
          ) {
            throw new ConflictException(this.mutationConflictMessage());
          }
          existing.request = cloneRequest(candidate.request);
          existing.requestFingerprint = candidate.requestFingerprint;
          return { result: { created: false, entry: cloneEntry(existing) }, changed: true };
        }
        return { result: { created: false, entry: cloneEntry(existing) }, changed: false };
      }
      ledger.entries.push(candidate);
      this.prune(ledger);
      return { result: { created: true, entry: cloneEntry(candidate) }, changed: true };
  }

  protected transactLedger<T>(change: (ledger: PersistedLedger) => { result: T; changed: boolean }): Promise<T> {
    return this.withLedgerLock(async () => {
      const ledger = this.readLedger(), outcome = change(ledger);
      if (outcome.changed) await this.writeLedger(ledger);
      return outcome.result;
    });
  }

  protected mutationConflictMessage(): string {
    return 'clientMutationId 已被不同的物品类别号请求占用';
  }

  protected fingerprintPersistedRequest(
    entry: PurchaseInboundCategoryTaskLedgerEntry,
  ): string {
    return buildStableInventoryMutationFingerprint(entry.request);
  }

  protected sameBusinessRequest(
    existing: PurchaseInboundCategoryTaskLedgerEntry,
    candidate: PurchaseInboundCategoryTaskLedgerEntry,
  ): boolean {
    return samePurchaseInboundCategoryBusinessRequest(
      existing.request,
      candidate.request,
    );
  }

  protected runningTaskMessage(): string {
    return '正在后台生成物品类别号';
  }

  async findByTaskId(
    taskId: string,
  ): Promise<PurchaseInboundCategoryTaskLedgerEntry | null> {
    return this.withLedgerLock(() => {
      const entry = this.readLedger().entries.find(
        (candidate) => candidate.task.id === clean(taskId),
      );
      return entry ? cloneEntry(entry) : null;
    });
  }

  async listRecoverable(): Promise<PurchaseInboundCategoryTaskLedgerEntry[]> {
    return this.withLedgerLock(() =>
      this.readLedger()
        .entries.filter(
          (entry) =>
            entry.task.status === 'pending' || entry.task.status === 'running',
        )
        .map(cloneEntry),
    );
  }

  async claimPending(taskId: string): Promise<{
    claimed: boolean;
    entry: PurchaseInboundCategoryTaskLedgerEntry;
  }> {
    return this.withLedgerLock(async () => {
      const ledger = this.readLedger();
      const entry = ledger.entries.find(
        (candidate) => candidate.task.id === clean(taskId),
      );
      if (!entry) throw new Error('物品类别号任务不存在');
      const now = this.now();
      const leaseExpiresAt = Date.parse(
        clean(entry.owner?.leaseExpiresAt),
      );
      const leaseExpired =
        entry.task.status === 'running' &&
        (!entry.owner ||
          !clean(entry.owner.token) ||
          !Number.isFinite(leaseExpiresAt) ||
          leaseExpiresAt <= now.getTime());
      if (
        (entry.task.status !== 'pending' && !leaseExpired) ||
        this.claimedTaskIds.has(entry.task.id)
      ) {
        return { claimed: false, entry: cloneEntry(entry) };
      }
      entry.attemptCount += 1;
      entry.task = {
        ...entry.task,
        status: 'running',
        message: this.runningTaskMessage(),
        updatedAt: now.toISOString(),
      };
      entry.owner = {
        token: randomUUID(),
        acquiredAt: now.toISOString(),
        leaseExpiresAt: new Date(
          now.getTime() + this.taskLeaseMs,
        ).toISOString(),
      };
      await this.writeLedger(ledger);
      this.claimedTaskIds.add(entry.task.id);
      return { claimed: true, entry: cloneEntry(entry) };
    });
  }

  async updateTask(
    taskId: string,
    task: PurchaseInboundCategoryTask,
    ownerToken: string,
  ): Promise<PurchaseInboundCategoryTaskLedgerEntry> {
    return this.withLedgerLock(async () => {
      const ledger = this.readLedger();
      const entry = ledger.entries.find(
        (candidate) => candidate.task.id === clean(taskId),
      );
      if (!entry) throw new Error('物品类别号任务不存在');
      if (
        !entry.owner ||
        entry.owner.token !== clean(ownerToken) ||
        !this.claimedTaskIds.has(entry.task.id)
      ) {
        throw new ServiceUnavailableException('物品类别号任务租约已丢失');
      }
      entry.task = JSON.parse(
        JSON.stringify(task),
      ) as PurchaseInboundCategoryTask;
      if (task.status !== 'running') {
        delete entry.owner;
        this.claimedTaskIds.delete(entry.task.id);
      }
      await this.writeLedger(ledger);
      return cloneEntry(entry);
    });
  }

  async renewClaim(taskId: string, ownerToken: string): Promise<void> {
    await this.withLedgerLock(async () => {
      const ledger = this.readLedger();
      const entry = ledger.entries.find(
        (candidate) => candidate.task.id === clean(taskId),
      );
      if (
        !entry ||
        entry.task.status !== 'running' ||
        !entry.owner ||
        entry.owner.token !== clean(ownerToken) ||
        !this.claimedTaskIds.has(entry.task.id)
      ) {
        throw new Error('物品类别号任务租约已丢失');
      }
      entry.owner.leaseExpiresAt = new Date(
        this.now().getTime() + this.taskLeaseMs,
      ).toISOString();
      await this.writeLedger(ledger);
    });
  }

  getLeaseHeartbeatIntervalMs(): number {
    return Math.max(1_000, Math.floor(this.taskLeaseMs / 3));
  }

  private readLedger(): PersistedLedger {
    if (!existsSync(this.ledgerPath)) {
      return {
        version: LEDGER_VERSION,
        updatedAt: this.now().toISOString(),
        entries: [],
      };
    }
    const parsed = JSON.parse(
      readFileSync(this.ledgerPath, 'utf8'),
    ) as PersistedLedger;
    if (parsed?.version !== LEDGER_VERSION || !Array.isArray(parsed.entries)) {
      throw this.failClosed(new Error('物品类别号任务台账结构或版本无效'));
    }
    return parsed;
  }

  private prune(ledger: PersistedLedger): void {
    const cutoff = this.now().getTime() - this.retentionTtlMs;
    ledger.entries = ledger.entries.filter((entry) => {
      if (entry.task.status === 'pending' || entry.task.status === 'running')
        return true;
      return Date.parse(entry.task.updatedAt) >= cutoff;
    });
    if (ledger.entries.length > this.maxEntries) {
      const active = ledger.entries.filter(
        (entry) =>
          entry.task.status === 'pending' || entry.task.status === 'running',
      );
      const terminal = ledger.entries
        .filter(
          (entry) =>
            entry.task.status !== 'pending' && entry.task.status !== 'running',
        )
        .slice(-(this.maxEntries - active.length));
      ledger.entries = [...active, ...terminal];
    }
  }

  private async writeLedger(ledger: PersistedLedger): Promise<void> {
    ledger.updatedAt = this.now().toISOString();
    const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes) {
      throw this.failClosed(new Error('物品类别号任务台账容量不足'));
    }
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      const deadline = performance.now() + DEFAULT_PERSIST_RETRY_WINDOW_MS;
      while (true) {
        try {
          renameSync(temporaryPath, this.ledgerPath);
          return;
        } catch (error) {
          if (
            !isTransientWindowsError(error) ||
            performance.now() >= deadline
          ) {
            throw error;
          }
          await delay(this.lockRetryDelayMs);
        }
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the persistence error.
        }
      }
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } catch {
        // The original persistence error is authoritative.
      }
      if (isTransientWindowsError(error)) {
        throw new ServiceUnavailableException(
          `物品类别号任务台账暂时被占用，将自动重试：${errorMessage(error)}`,
        );
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
    if (cleanupError !== undefined && isTransientWindowsError(cleanupError)) {
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
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const deadline = performance.now() + this.lockTimeoutMs;
    while (true) {
      const now = this.now();
      const owner = {
        token: randomUUID(),
        acquiredAt: now.toISOString(),
        leaseExpiresAt: new Date(
          now.getTime() + this.staleLockMs,
        ).toISOString(),
      };
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
            // Preserve the acquisition error.
          }
        }
        if (!isCode(error, 'EEXIST')) throw this.failClosed(error);
      }
      this.reclaimStaleLock();
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new ServiceUnavailableException('物品类别号任务台账暂时繁忙');
      }
      await delay(Math.min(this.lockRetryDelayMs, remaining));
    }
  }

  private reclaimStaleLock(): void {
    try {
      const stale =
        this.now().getTime() - statSync(this.lockPath).mtimeMs >=
        this.staleLockMs;
      if (!stale) return;
      const quarantine = `${this.lockPath}.${process.pid}.${randomUUID()}.stale`;
      renameSync(this.lockPath, quarantine);
      try {
        unlinkSync(quarantine);
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
      }
    } catch (error) {
      if (!isCode(error, 'ENOENT') && !isCode(error, 'EEXIST')) {
        throw this.failClosed(error);
      }
    }
  }

  private async releaseLock(owner: TaskOwner): Promise<void> {
    const deadline = performance.now() + DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS;
    while (true) {
      try {
        const current = JSON.parse(
          readFileSync(this.lockPath, 'utf8'),
        ) as TaskOwner;
        if (current.token !== owner.token) {
          throw new Error('物品类别号任务台账文件锁所有权已丢失');
        }
        unlinkSync(this.lockPath);
        return;
      } catch (error) {
        if (isCode(error, 'ENOENT')) return;
        if (!isTransientWindowsError(error) || performance.now() >= deadline) {
          throw error;
        }
        await delay(this.lockRetryDelayMs);
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
      if (isTransientWindowsError(error)) this.scheduleDeferredLockRelease();
    }
  }

  private scheduleDeferredLockRelease(): void {
    if (this.deferredLockReleaseTimer || !this.deferredLockRelease) return;
    const timeout = Math.min(
      MAX_DEFERRED_LOCK_RELEASE_DELAY_MS,
      this.lockRetryDelayMs *
        2 ** Math.min(this.deferredLockReleaseAttempt++, 6),
    );
    this.deferredLockReleaseTimer = setTimeout(() => {
      this.deferredLockReleaseTimer = null;
      void this.flushDeferredLockRelease();
    }, timeout);
    this.deferredLockReleaseTimer.unref?.();
  }

  private failClosed(error: unknown): ServiceUnavailableException {
    if (!this.failed) {
      this.failed = new ServiceUnavailableException(
        `物品类别号任务台账不可用：${errorMessage(error)}`,
      );
    }
    return this.failed;
  }
}

export function buildPurchaseInboundCategoryRequestFingerprint(
  request: PurchaseInboundCategoryPrepareRequest,
): string {
  return buildStableInventoryMutationFingerprint(request);
}

function samePurchaseInboundCategoryBusinessRequest(
  left: PurchaseInboundCategoryPrepareRequest,
  right: PurchaseInboundCategoryPrepareRequest,
): boolean {
  const leftLocationRecordId = clean(left?.newItem?.locationRecordId);
  const rightLocationRecordId = clean(right?.newItem?.locationRecordId);
  return (
    !Object.prototype.hasOwnProperty.call(left as object, 'mode') &&
    !Object.prototype.hasOwnProperty.call(right as object, 'mode') &&
    clean(left?.executionRecordId) === clean(right?.executionRecordId) &&
    clean(left?.clientMutationId) === clean(right?.clientMutationId) &&
    left?.building === right?.building &&
    left?.quantity === right?.quantity &&
    normalizeTimestamp(left?.occurredAt) ===
      normalizeTimestamp(right?.occurredAt) &&
    clean(left?.newItem?.primaryCategory) ===
      clean(right?.newItem?.primaryCategory) &&
    clean(left?.newItem?.secondaryCategory) ===
      clean(right?.newItem?.secondaryCategory) &&
    clean(left?.newItem?.name) === clean(right?.newItem?.name) &&
    clean(left?.newItem?.specification) ===
      clean(right?.newItem?.specification) &&
    clean(left?.newItem?.location) === clean(right?.newItem?.location) &&
    (!leftLocationRecordId ||
      !rightLocationRecordId ||
      leftLocationRecordId === rightLocationRecordId) &&
    clean(left?.newItem?.brand) === clean(right?.newItem?.brand) &&
    clean(left?.newItem?.unit) === clean(right?.newItem?.unit) &&
    normalizeMinimumQuantity(left?.newItem?.minimumQuantity) ===
      normalizeMinimumQuantity(right?.newItem?.minimumQuantity)
  );
}

function normalizeTimestamp(value: unknown): string {
  const timestamp = Date.parse(clean(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function normalizeMinimumQuantity(value: unknown): number {
  return value === undefined ? 0 : Number(value);
}

function cloneRequest(
  request: PurchaseInboundCategoryPrepareRequest,
): PurchaseInboundCategoryPrepareRequest {
  return JSON.parse(
    JSON.stringify(request),
  ) as PurchaseInboundCategoryPrepareRequest;
}

function cloneEntry(
  entry: PurchaseInboundCategoryTaskLedgerEntry,
): PurchaseInboundCategoryTaskLedgerEntry {
  return JSON.parse(
    JSON.stringify(entry),
  ) as PurchaseInboundCategoryTaskLedgerEntry;
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}

function isTransientWindowsError(error: unknown): boolean {
  return ['EBUSY', 'EACCES', 'EPERM'].includes(
    String((error as { code?: unknown } | null)?.code || ''),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
