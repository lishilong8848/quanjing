import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { dirname, join } from 'node:path';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { InventoryLedgerDeletionRequest, InventoryLedgerDeletionTask } from '../../../shared/inventory-ledger-deletion.interface';
import { PurchaseInboundCategoryTaskLedgerStore } from './purchase-inbound-category-task-ledger.store';
import { buildStableInventoryMutationFingerprint } from './inventory-idempotency-fingerprint';

export interface LedgerDeletionEntry {
  principal: AccessPrincipal;
  principalFingerprint: string;
  requestFingerprint: string;
  request: InventoryLedgerDeletionRequest;
  task: InventoryLedgerDeletionTask;
  phase: 'prepared' | 'deleting';
  source?: { appToken: string; tableId: string };
}

export function isTemporaryLedgerDeletionReadFailure(error: unknown): boolean {
  const value = error as { code?: unknown; feishuCode?: unknown; message?: unknown; response?: { status?: unknown; data?: { code?: unknown } }; cause?: unknown } | undefined;
  const code = String(value?.code || '').toUpperCase();
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code) ||
    [429, 500, 502, 503, 504].includes(Number(value?.response?.status)) ||
    [1254290, 1254607, 99991400].includes(Number(value?.feishuCode ?? value?.response?.data?.code)) ||
    /timeout of \d+ms exceeded|ETIMEDOUT|ECONNABORTED|ECONNRESET|EAI_AGAIN|(?:读取|请求).{0,30}超时/i.test(String(value?.message || error || ''));
}

export function canRetryPreparedDeletion(entry: LedgerDeletionEntry): boolean {
  return entry.phase === 'prepared' && entry.task.status === 'failed' &&
    (entry.task.retryable === true || (entry.task.retryable === undefined &&
      !/权限|无权|越权|账号|已变化|无效|未配置|请刷新/.test(entry.task.message) && isTemporaryLedgerDeletionReadFailure(entry.task.message)));
}

/** A separate durable ledger using the existing atomic, locked JSON persistence. */
@Injectable()
export class InventoryLedgerDeletionStore extends PurchaseInboundCategoryTaskLedgerStore {
  constructor(@Optional() @Inject('INVENTORY_LEDGER_DELETION_PATH') file?: string) {
    super(file || join(dirname(process.env.INVENTORY_MOVEMENT_DELETION_TASK_LEDGER_PATH || join(process.cwd(), '.runtime', 'inventory-movement-deletion-task-ledger.json')), 'inventory-ledger-deletions.json'));
  }

  private rows(entries: unknown[]): LedgerDeletionEntry[] {
    for (const value of entries) {
      const row = value as LedgerDeletionEntry;
      if (!row?.request?.clientMutationId || !row.request.recordId || !row.principalFingerprint ||
        !['prepared', 'deleting'].includes(row.phase) || !['pending', 'running', 'completed', 'failed', 'uncertain'].includes(row.task?.status) ||
        (row.task.retryCount !== undefined && (!Number.isInteger(row.task.retryCount) || row.task.retryCount < 0 || row.task.retryCount > 2)) ||
        (row.task.nextAttemptAt !== undefined && (typeof row.task.nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(row.task.nextAttemptAt)))) ||
        (row.task.retryable !== undefined && typeof row.task.retryable !== 'boolean') ||
        (row.task.definitelyNotDeleted !== undefined && typeof row.task.definitelyNotDeleted !== 'boolean') ||
        (row.task.stage !== undefined && !['validating-source', 'reading-record', 'reading-catalog', 'checking-latest', 'deleting', 'reconciling', 'completed'].includes(row.task.stage)) ||
        row.requestFingerprint !== buildStableInventoryMutationFingerprint({ actor: row.principalFingerprint, request: row.request }) ||
        (row.phase === 'deleting' && (!row.source?.appToken || !row.source.tableId)))
        throw new Error('台账删除记录无法核验，请联系管理员');
    }
    return entries as LedgerDeletionEntry[];
  }

  reserveDeletion(entry: LedgerDeletionEntry, resumeFailed = false): Promise<LedgerDeletionEntry> {
    return this.transactLedger(ledger => {
      const rows = this.rows(ledger.entries);
      const previous = rows.find(row => row.request.clientMutationId === entry.request.clientMutationId);
      if (previous) {
        if (previous.requestFingerprint !== entry.requestFingerprint) throw new ConflictException('删除申请标识已被不同内容或账号使用');
        if (resumeFailed && canRetryPreparedDeletion(previous)) {
          if (rows.some(row => row !== previous && row.request.recordId === entry.request.recordId && ['pending', 'running', 'uncertain'].includes(row.task.status)))
            throw new ConflictException('这条台账已有其他删除任务，请先核对该任务');
          previous.principal = structuredClone(entry.principal);
          previous.task = { ...previous.task, status: 'pending', stage: 'validating-source',
            retryCount: previous.task.retryCount ?? 0, nextAttemptAt: undefined, retryable: false,
            definitelyNotDeleted: true, message: '已按原申请重新核对，删除尚未执行', updatedAt: new Date().toISOString() };
          return { changed: true, result: structuredClone(previous) };
        }
        return { changed: false, result: structuredClone(previous) };
      }
      if (rows.some(row => row.request.recordId === entry.request.recordId && ['pending', 'running', 'uncertain'].includes(row.task.status)))
        throw new ConflictException('这条台账已有删除任务，请先核对原任务');
      const cutoff = Date.now() - 90 * 86400000;
      const retained = rows.filter(row => ['pending', 'running', 'uncertain'].includes(row.task.status) || Date.parse(row.task.updatedAt) >= cutoff);
      if (retained.length >= 5000) throw new ConflictException('台账删除记录已达容量上限，请联系管理员');
      retained.push(structuredClone(entry));
      ledger.entries = retained as unknown as typeof ledger.entries;
      return { changed: true, result: structuredClone(entry) };
    });
  }

  findDeletion(id: string): Promise<LedgerDeletionEntry | undefined> {
    return this.transactLedger(ledger => ({ changed: false, result: structuredClone(this.rows(ledger.entries).find(row => row.request.clientMutationId === id)) }));
  }

  recoverableDeletions(): Promise<LedgerDeletionEntry[]> {
    return this.transactLedger(ledger => ({ changed: false, result: structuredClone(this.rows(ledger.entries).filter(row => ['pending', 'running', 'uncertain'].includes(row.task.status))) }));
  }

  saveDeletion(entry: LedgerDeletionEntry): Promise<void> {
    return this.transactLedger(ledger => {
      const rows = this.rows(ledger.entries), index = rows.findIndex(row => row.request.clientMutationId === entry.request.clientMutationId);
      if (index < 0 || rows[index].requestFingerprint !== entry.requestFingerprint) throw new ConflictException('删除任务身份已变化');
      if (rows[index].task.status === 'completed' && entry.task.status !== 'completed') throw new ConflictException('删除完成状态不能回退');
      if (rows[index].phase === 'deleting' && entry.phase !== 'deleting') throw new ConflictException('删除已发出，只能核对原申请结果');
      rows[index] = structuredClone(entry);
      ledger.entries = rows as unknown as typeof ledger.entries;
      return { changed: true, result: undefined };
    });
  }
}
