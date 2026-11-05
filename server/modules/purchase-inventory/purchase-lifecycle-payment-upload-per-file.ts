import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { LifecyclePaymentUploadFile, LifecyclePaymentUploadRequest } from './purchase-lifecycle-payment-upload';
import type { LifecyclePaymentUploadIdentity, LifecyclePaymentUploadReceivedFile, LifecyclePaymentUploadSelector } from './purchase-lifecycle-payment-upload-isolated';

export type LifecyclePaymentFileState = 'pending' | 'dispatching' | 'confirmed' | 'manual_reconciliation';
export interface LifecyclePaymentFileSnapshot extends LifecyclePaymentUploadFile { index: number; state: LifecyclePaymentFileState; attemptId?: string }
/** Public-to-service snapshots MUST NOT contain attachment tokens or credentials. */
export interface LifecyclePaymentPerFileTask { key: string; state: 'active' | 'committed' | 'cancelled' | 'manual_reconciliation'; files: LifecyclePaymentFileSnapshot[] }

/** All operations are durable on the SAME workflow ledger; no independent lock is sufficient. */
export interface LifecyclePaymentPerFileStorePort {
  reserve(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest): Promise<LifecyclePaymentPerFileTask>;
  /** Reauthorize and persist this file's dispatch fence before any external call. */
  beginFile(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, key: string, index: number, attemptId: string): Promise<LifecyclePaymentPerFileTask>;
  /** Persist the returned token under its exact attempt fence; this does not attach it to a purchase. */
  confirmFile(key: string, index: number, attemptId: string, token: string): Promise<LifecyclePaymentPerFileTask>;
  /** CAS only from the same in-flight attempt; never erase an already confirmed token. */
  markFileUncertain(key: string, index: number, attemptId: string): Promise<void>;
  /** Reauthorize and atomically attach ALL confirmed tokens, queue refresh, and commit exactly once. */
  commit(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, key: string): Promise<LifecyclePaymentPerFileTask>;
}
export interface LifecyclePaymentPerFileGatewayPort { uploadOne(file: LifecyclePaymentUploadReceivedFile, attemptId: string, identity: LifecyclePaymentUploadIdentity): Promise<string> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/u;
const unavailable = (): never => { throw new ServiceUnavailableException('付款附件任务不可核对'); };

function snapshot(task: LifecyclePaymentPerFileTask, files: readonly LifecyclePaymentUploadFile[], expectedKey?: string): LifecyclePaymentPerFileTask {
  if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).sort().join(',') !== 'files,key,state' ||
    typeof task.key !== 'string' || !HASH.test(task.key) || (expectedKey && task.key !== expectedKey) ||
    !['active', 'committed', 'cancelled', 'manual_reconciliation'].includes(task.state) || !Array.isArray(task.files) || task.files.length !== files.length) return unavailable();
  for (let index = 0; index < files.length; index++) {
    const row = task.files[index], file = files[index]!;
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      !['index,name,sha256,size,state', 'attemptId,index,name,sha256,size,state'].includes(Object.keys(row).sort().join(',')) ||
      row.index !== index || row.sha256 !== file.sha256 || row.size !== file.size || row.name !== file.name ||
      !['pending', 'dispatching', 'confirmed', 'manual_reconciliation'].includes(row.state) ||
      (row.state === 'pending' ? row.attemptId !== undefined : typeof row.attemptId !== 'string' || !UUID.test(row.attemptId))) return unavailable();
  }
  if (task.state === 'committed' && task.files.some(row => row.state !== 'confirmed')) return unavailable();
  if (task.state === 'cancelled' && task.files.some(row => row.state !== 'pending')) return unavailable();
  return structuredClone(task);
}

function assertFileTransition(before: LifecyclePaymentPerFileTask, after: LifecyclePaymentPerFileTask, index: number, from: LifecyclePaymentFileState, to: LifecyclePaymentFileState, attemptId: string): void {
  if (before.state !== 'active' || after.state !== 'active' || before.files[index]?.state !== from || after.files[index]?.state !== to || after.files[index]?.attemptId !== attemptId) return unavailable();
  for (let other = 0; other < before.files.length; other++) {
    const left = before.files[other]!, right = after.files[other]!;
    if (other !== index && (left.index !== right.index || left.name !== right.name || left.sha256 !== right.sha256 || left.size !== right.size || left.state !== right.state || left.attemptId !== right.attemptId)) return unavailable();
  }
}

/** Unregistered orchestration only: auth, current scope and ledger locking must be enforced by the injected port. */
export class LifecyclePaymentPerFileOrchestrator {
  constructor(private readonly store: LifecyclePaymentPerFileStorePort | undefined, private readonly gateway: LifecyclePaymentPerFileGatewayPort | undefined) {}

  async upload(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, requestId: string, files: readonly LifecyclePaymentUploadReceivedFile[]): Promise<{ state: 'completed' | 'manual_reconciliation' }> {
    if (!this.store || !this.gateway || ['reserve', 'beginFile', 'confirmFile', 'markFileUncertain', 'commit'].some(key => typeof (this.store as unknown as Record<string, unknown>)[key] !== 'function') || typeof this.gateway.uploadOne !== 'function') throw new ServiceUnavailableException('逐文件付款上传尚未接入');
    if (!identity || typeof identity.assertCurrent !== 'function') throw new ServiceUnavailableException('付款身份不可核对');
    const identityCheck: unknown = identity.assertCurrent();
    if (identityCheck !== undefined) {
      if (identityCheck !== null && (typeof identityCheck === 'object' || typeof identityCheck === 'function')) void Promise.resolve(identityCheck).catch(() => undefined);
      throw new ServiceUnavailableException('付款身份不可核对');
    }
    if (!selector || typeof selector.approvalBatchId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/u.test(selector.approvalBatchId) ||
      typeof selector.executionRecordId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(selector.executionRecordId) || !Number.isSafeInteger(selector.generation) || selector.generation < 1 ||
      typeof requestId !== 'string' || !UUID.test(requestId) || !Array.isArray(files) || !files.length || files.length > 5) throw new BadRequestException('付款附件请求无效');
    const detached = files.map(file => {
      if (!file || !Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || file.size < 1 || file.size > 20 * 1024 * 1024 ||
        typeof file.originalname !== 'string' || !file.originalname.trim() || Array.from(file.originalname).length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(file.originalname) || typeof file.mimetype !== 'string' || !file.mimetype || file.mimetype.length > 128) throw new BadRequestException('付款附件无效');
      return { originalname: file.originalname.normalize('NFC'), mimetype: file.mimetype, size: file.size, buffer: Buffer.from(file.buffer) };
    });
    const descriptors = detached.map(file => ({ name: file.originalname, size: file.size, sha256: createHash('sha256').update(file.buffer).digest('hex') }));
    if (new Set(descriptors.map(file => `${file.sha256}:${file.size}`)).size !== descriptors.length) throw new BadRequestException('付款附件重复');
    const request = { requestId, files: descriptors };
    let task = snapshot(await this.store.reserve(identity, selector, request), descriptors);
    const key = task.key;
    if (task.state === 'committed') return { state: 'completed' };
    if (task.state === 'cancelled') throw new ServiceUnavailableException('付款上传请求已取消');
    if (task.state === 'manual_reconciliation' || task.files.some(file => file.state === 'dispatching' || file.state === 'manual_reconciliation')) return { state: 'manual_reconciliation' };
    for (let index = 0; index < detached.length; index++) {
      if (task.files[index]!.state === 'confirmed') continue;
      if (task.files[index]!.state !== 'pending') return unavailable();
      const attemptId = randomUUID();
      const previous = task;
      task = snapshot(await this.store.beginFile(identity, selector, request, key, index, attemptId), descriptors, key);
      assertFileTransition(previous, task, index, 'pending', 'dispatching', attemptId);
      try {
        const token = await this.gateway.uploadOne(detached[index]!, attemptId, identity);
        if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('invalid upload result');
        const dispatching = task;
        task = snapshot(await this.store.confirmFile(key, index, attemptId, token), descriptors, key);
        assertFileTransition(dispatching, task, index, 'dispatching', 'confirmed', attemptId);
      } catch {
        try { await this.store.markFileUncertain(key, index, attemptId); } catch { /* persisted dispatch fence remains */ }
        throw new ServiceUnavailableException('付款附件上传结果待核对，请勿重复上传');
      }
    }
    task = snapshot(await this.store.commit(identity, selector, request, key), descriptors, key);
    if (task.state !== 'committed') return unavailable();
    return { state: 'completed' };
  }
}
