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
import type {
  StocktakeGeneration,
  StocktakeSheet,
  StocktakeDraft,
  StocktakeBulkSummary,
  StocktakeBulkRequest,
  StocktakeBulkTask,
} from '../../../shared/inventory-stocktake.interface';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import {
  createProcessLockOwner,
  normalizeProcessLockOwner,
  processLockOwnerMayBeAlive,
  type ProcessLockOwner,
} from '../../common/process-lock-owner';

export interface StocktakeGenerationJob extends StocktakeGeneration {
  owner: ProcessLockOwner | null;
}
export interface StocktakeBulkJob extends StocktakeBulkTask {
  fingerprint: string;
  request: StocktakeBulkRequest | null;
  principal: AccessPrincipal;
  actor: string;
  owner: ProcessLockOwner | null;
}

interface StocktakeReceipt {
  key: string;
  fingerprint: string;
  result: unknown;
}
export interface StocktakeLedger {
  bulkJobs?: StocktakeBulkJob[];
  bulkBatches?: Array<
    StocktakeBulkSummary & {
      month: string;
      building: string;
      actor: string;
      undoneBy: string | null;
      before: Array<
        StocktakeDraft & { recordId: string; confirmedVersion: number }
      >;
    }
  >;
  resultRecords?: Record<string, string>;
  resultCreation?: {
    token: string;
    ids: string[];
    startedAt: string;
    uncertain: boolean;
  } | null;
  resultSyncOwner?: ProcessLockOwner | null;
  version: 1;
  historyStartedAt: string | null;
  sheets: StocktakeSheet[];
  receipts: StocktakeReceipt[];
  generationJobs: StocktakeGenerationJob[];
}
const MAX_BYTES = 32 * 1024 * 1024;
function validSync(line: {
  version: number;
  sync?: import('../../../shared/inventory-stocktake.interface').StocktakeSyncState;
}) {
  const sync = line.sync;
  return (
    !sync ||
    ((sync.clientMutationId === undefined ||
      (typeof sync.clientMutationId === 'string' &&
        sync.clientMutationId.length > 0 &&
        sync.clientMutationId.length <= 256)) &&
      Number.isSafeInteger(sync.version) &&
      sync.version > 0 &&
      sync.version <= line.version &&
      ['pending', 'syncing', 'success', 'error'].includes(sync.status) &&
      Number.isSafeInteger(sync.attempts) &&
      sync.attempts >= 0 &&
      sync.attempts <= 3 &&
      typeof sync.error === 'string' &&
      (sync.retryAt === null || Number.isFinite(Date.parse(sync.retryAt))) &&
      (sync.syncedAt === null || Number.isFinite(Date.parse(sync.syncedAt))))
  );
}

@Injectable()
export class InventoryStocktakeStore {
  readonly path: string;
  constructor(
    @Optional() @Inject('INVENTORY_STOCKTAKE_STORE_PATH') path?: string,
  ) {
    this.path = resolve(
      path ||
        join(process.cwd(), '.runtime', 'inventory-stocktake-ledger.json'),
    );
  }

  read(): StocktakeLedger {
    if (!existsSync(this.path))
      return {
        version: 1,
        historyStartedAt: null,
        sheets: [],
        receipts: [],
        generationJobs: [],
      };
    try {
      if (statSync(this.path).size > MAX_BYTES) throw new Error('size');
      const value = JSON.parse(
        readFileSync(this.path, 'utf8'),
      ) as StocktakeLedger;
      if (
        value.version !== 1 ||
        !Array.isArray(value.sheets) ||
        !Array.isArray(value.receipts) ||
        !(
          value.historyStartedAt === null ||
          typeof value.historyStartedAt === 'string'
        )
      )
        throw new Error('schema');
      if (value.generationJobs === undefined) value.generationJobs = [];
      if (
        value.bulkJobs !== undefined &&
        (!Array.isArray(value.bulkJobs) ||
          new Set(value.bulkJobs.map((j) => j?.id)).size !==
            value.bulkJobs.length ||
          value.bulkJobs.some(
            (j) =>
              !j ||
              !/^[a-zA-Z0-9_-]{8,128}$/.test(j.id) ||
              !/^20\d{2}-(0[1-9]|1[0-2])$/.test(j.month) ||
              !['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].includes(
                j.building,
              ) ||
              !['queued', 'running', 'success', 'error'].includes(j.status) ||
              !Number.isSafeInteger(j.attempts) ||
              j.attempts < 0 ||
              !Number.isSafeInteger(j.count) ||
              j.count < 1 ||
              typeof j.actor !== 'string' ||
              !j.actor ||
              typeof j.error !== 'string' ||
              !/^[a-f0-9]{64}$/.test(j.fingerprint) ||
              !j.principal ||
              !Number.isFinite(Date.parse(j.createdAt)) ||
              !Number.isFinite(Date.parse(j.updatedAt)) ||
              (j.status === 'running' && !normalizeProcessLockOwner(j.owner)) ||
              (j.status !== 'running' && j.owner !== null) ||
              (j.status === 'success'
                ? j.request !== null
                : !j.request ||
                  j.request.clientMutationId !== j.id ||
                  j.request.month !== j.month ||
                  j.request.building !== j.building ||
                  j.request.scope !== 'review' ||
                  !Array.isArray(j.request.lines) ||
                  j.request.lines.length !== j.count),
          ))
      )
        throw new Error('bulk-jobs');
      if (
        value.resultSyncOwner != null &&
        !normalizeProcessLockOwner(value.resultSyncOwner)
      )
        throw new Error('sync-owner');
      if (
        value.resultRecords !== undefined &&
        (!value.resultRecords ||
          typeof value.resultRecords !== 'object' ||
          Array.isArray(value.resultRecords) ||
          Object.entries(value.resultRecords).some(
            ([id, record]) => !id || typeof record !== 'string' || !record,
          ))
      )
        throw new Error('result-records');
      if (value.resultCreation != null) {
        const c = value.resultCreation;
        if (
          typeof c.token !== 'string' ||
          !/^[a-zA-Z0-9_-]{8,128}$/.test(c.token) ||
          !Array.isArray(c.ids) ||
          !c.ids.length ||
          c.ids.length > 100 ||
          new Set(c.ids).size !== c.ids.length ||
          c.ids.some((id) => typeof id !== 'string' || !id) ||
          !Number.isFinite(Date.parse(c.startedAt)) ||
          typeof c.uncertain !== 'boolean'
        )
          throw new Error('result-creation');
      }
      if (
        value.bulkBatches !== undefined &&
        (!Array.isArray(value.bulkBatches) ||
          new Set(value.bulkBatches.map((b) => b.id)).size !==
            value.bulkBatches.length ||
          value.bulkBatches.some(
            (b) =>
              !b.id ||
              !b.month ||
              !b.building ||
              !b.confirmer?.openId ||
              !['confirmed', 'undone'].includes(b.status) ||
              !Number.isFinite(Date.parse(b.confirmedAt)) ||
              (b.undoneAt !== null &&
                !Number.isFinite(Date.parse(b.undoneAt))) ||
              !Array.isArray(b.before) ||
              b.count !== b.before.length ||
              new Set(b.before.map((l) => l.recordId)).size !==
                b.before.length ||
              b.before.some(
                (l) =>
                  !l.recordId ||
                  !Number.isSafeInteger(l.confirmedVersion) ||
                  l.confirmedVersion < 2 ||
                  (l.actualQuantity !== null &&
                    (!Number.isFinite(l.actualQuantity) ||
                      l.actualQuantity < 0)) ||
                  typeof l.note !== 'string',
              ),
          ))
      )
        throw new Error('bulk-batches');
      if (
        !Array.isArray(value.generationJobs) ||
        value.generationJobs.some(
          (job) =>
            !job ||
            !job.id ||
            !/^20\d{2}-(0[1-9]|1[0-2])$/.test(job.month) ||
            !['queued', 'running', 'success', 'error'].includes(job.status) ||
            !Number.isSafeInteger(job.attempts) ||
            job.attempts < 0 ||
            !Number.isFinite(Date.parse(job.createdAt)) ||
            !Number.isFinite(Date.parse(job.updatedAt)) ||
            (job.retryAt !== null &&
              !Number.isFinite(Date.parse(job.retryAt))) ||
            !Array.isArray(job.buildings) ||
            job.buildings.some(
              (entry) =>
                !['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].includes(
                  entry.building,
                ) ||
                !['pending', 'done', 'error'].includes(entry.status) ||
                typeof entry.error !== 'string',
            ) ||
            (job.status === 'running' && !normalizeProcessLockOwner(job.owner)),
        )
      )
        throw new Error('generation');
      const keys = new Set<string>();
      for (const sheet of value.sheets) {
        const key = `${sheet.month}:${sheet.building}`;
        if (
          !sheet.month ||
          !sheet.building ||
          keys.has(key) ||
          !Array.isArray(sheet.lines) ||
          !Number.isSafeInteger(sheet.version) ||
          !['open', 'completed'].includes(sheet.status)
        )
          throw new Error('sheet');
        keys.add(key);
        if (
          new Set(sheet.lines.map((l) => l.inventory?.recordId)).size !==
            sheet.lines.length ||
          sheet.lines.some(
            (l) =>
              !l.inventory?.recordId ||
              !Number.isSafeInteger(l.version) ||
              !validSync(l) ||
              !['draft', 'confirmed'].includes(l.status),
          )
        )
          throw new Error('line');
        if (sheet.review) {
          const review = sheet.review;
          const selected = new Set(
            sheet.lines.map((l) => l.inventory.recordId),
          );
          if (
            !Array.isArray(review.lines) ||
            !Number.isSafeInteger(review.version) ||
            !['open', 'completed'].includes(review.status) ||
            new Set(review.lines.map((l) => l.inventory?.recordId)).size !==
              review.lines.length ||
            review.lines.some(
              (l) =>
                !l.inventory?.recordId ||
                selected.has(l.inventory.recordId) ||
                !Number.isSafeInteger(l.version) ||
                !validSync(l) ||
                !['draft', 'confirmed'].includes(l.status),
            )
          )
            throw new Error('review');
        }
      }
      if (
        value.receipts.some(
          (r) =>
            !r ||
            typeof r.key !== 'string' ||
            typeof r.fingerprint !== 'string' ||
            !Object.prototype.hasOwnProperty.call(r, 'result'),
        )
      )
        throw new Error('receipt');
      return value;
    } catch (error) {
      throw new ServiceUnavailableException(
        '盘点记录读取失败，已停止写入，请联系管理员核查台账',
      );
    }
  }

  replay<T>(key: string, fingerprint: string): T | undefined {
    return this.receipt<T>(this.read(), key, fingerprint);
  }

  mutate<T>(
    key: string,
    fingerprint: string,
    action: (state: StocktakeLedger) => T,
  ): T {
    return this.update((state) => {
      const existing = this.receipt<T>(state, key, fingerprint);
      if (existing !== undefined) return existing;
      const result = action(state);
      state.receipts.push({ key, fingerprint, result });
      return result;
    });
  }

  update<T>(action: (state: StocktakeLedger) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    const token = randomUUID();
    this.acquire(lock, token);
    try {
      const state = this.read();
      const result = action(state);
      if (
        result === undefined ||
        (result && typeof (result as { then?: unknown }).then === 'function')
      )
        throw new Error('盘点事务必须同步返回结果');
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > MAX_BYTES)
        throw new ServiceUnavailableException(
          '盘点记录容量已达上限，请联系管理员归档',
        );
      const temp = `${this.path}.${token}.tmp`;
      try {
        const fd = openSync(temp, 'wx', 0o600);
        try {
          writeFileSync(fd, bytes, 'utf8');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, this.path);
      } catch (error) {
        if (existsSync(temp)) unlinkSync(temp);
        throw new ServiceUnavailableException(
          '盘点记录保存失败，请保留草稿后重试',
        );
      }
      return result;
    } finally {
      // Only this owner may release the lock; never remove another process's lock.
      const owner = normalizeProcessLockOwner(
        JSON.parse(readFileSync(lock, 'utf8')),
      );
      if (owner?.token !== token)
        throw new ServiceUnavailableException(
          '盘点记录锁状态异常，请重新核对保存结果',
        );
      unlinkSync(lock);
    }
  }

  private receipt<T>(
    state: StocktakeLedger,
    key: string,
    fingerprint: string,
  ): T | undefined {
    const receipt = state.receipts.find((r) => r.key === key);
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint)
      throw new ConflictException('重复变更号对应的内容不同，请重新提交');
    return receipt.result as T;
  }

  private acquire(lock: string, token: string): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd: number;
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new ServiceUnavailableException('无法建立盘点记录锁');
        const recovery = `${lock}.recovery`;
        let recoveryFd: number | undefined;
        try {
          recoveryFd = openSync(recovery, 'wx', 0o600);
          const bytes = readFileSync(lock, 'utf8');
          const owner = normalizeProcessLockOwner(JSON.parse(bytes));
          if (
            !owner ||
            processLockOwnerMayBeAlive(owner, statSync(lock).mtimeMs) ||
            readFileSync(lock, 'utf8') !== bytes
          )
            throw new Error('busy');
          // Synchronous recovery is only permitted for a provably dead process.
          unlinkSync(lock);
          continue;
        } catch {
          throw new ConflictException('盘点记录正在处理，请稍后用原请求重试');
        } finally {
          if (recoveryFd !== undefined) {
            closeSync(recoveryFd);
            unlinkSync(recovery);
          }
        }
      }
      try {
        writeFileSync(
          fd,
          JSON.stringify(createProcessLockOwner(token)),
          'utf8',
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return;
    }
    throw new ConflictException('盘点记录正在处理，请稍后重试');
  }
}
