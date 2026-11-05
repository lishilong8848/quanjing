import type { VerifiedLifecycleReceiptImageSnapshot } from './purchase-lifecycle-receipt-image-binding';

type ReceiptUploadTask = {
  taskId: string;
  leaseToken: string;
  state: 'ready' | 'uploaded' | 'dispatching' | 'completed' | 'manual_reconciliation';
  imageMessageId: string;
  imageKey: string;
};
/** The store must execute all authorization callbacks synchronously under the purchase ledger lock. */
export interface LifecycleReceiptImageStore {
  /** Match the authenticated snapshot against ALL active intents, check both idempotency keys and atomically enqueue. */
  acceptVerified(snapshot: VerifiedLifecycleReceiptImageSnapshot, authorize: (context: unknown) => void): Promise<{ accepted: boolean; enqueued: boolean; taskId?: string }>;
  /** Claims one existing task. `dispatching` must never be reset automatically. */
  claimUpload(taskId: string, authorize: (context: unknown) => void): Promise<ReceiptUploadTask>;
  releaseBeforeDispatch(taskId: string, leaseToken: string): Promise<void>;
  markUploadDispatched(taskId: string, leaseToken: string, authorize: (context: unknown) => void): Promise<void>;
  recordUploaded(taskId: string, leaseToken: string, fileToken: string): Promise<void>;
  markUploadUncertain(taskId: string, leaseToken: string): Promise<void>;
  /** Reauthorizes and atomically applies confirmed token, completion, intent and lifecycle refresh. */
  commitUploaded(taskId: string, leaseToken: string, authorize: (context: unknown) => void): Promise<void>;
}
export interface LifecycleReceiptImageGateway {
  downloadMessageImage(messageId: string, imageKey: string): Promise<Buffer>;
  uploadAttachment(content: Buffer): Promise<string>;
}
export interface LifecycleReceiptImageVerifier {
  verify(payload: unknown, effectiveAppId: string): Promise<VerifiedLifecycleReceiptImageSnapshot>;
}

/** Isolated coordinator; never registered until a single-ledger implementation is available. */
export class PurchaseLifecycleReceiptImageCoordinator {
  constructor(private readonly verifier: LifecycleReceiptImageVerifier | undefined,
    private readonly store: LifecycleReceiptImageStore | undefined,
    private readonly gateway: LifecycleReceiptImageGateway | undefined,
    private readonly effectiveAppId: () => string,
    private readonly authorize: (context: unknown) => void) {}

  private ready(): { verifier: LifecycleReceiptImageVerifier; store: LifecycleReceiptImageStore; gateway: LifecycleReceiptImageGateway } {
    if (!this.verifier || !this.store || !this.gateway || typeof this.authorize !== 'function' || !/^cli_[A-Za-z0-9_-]+$/.test(this.effectiveAppId())) throw new Error('采购签收图片安全处理尚未就绪');
    return { verifier: this.verifier, store: this.store, gateway: this.gateway };
  }

  async accept(payload: unknown): Promise<{ accepted: boolean; enqueued: boolean; taskId?: string }> {
    const { verifier, store } = this.ready();
    const appId = this.effectiveAppId();
    const snapshot = await verifier.verify(payload, appId);
    if (this.effectiveAppId() !== appId) throw new Error('采购签收图片应用身份已变化');
    return store.acceptVerified(snapshot, this.authorize);
  }

  async process(taskId: string): Promise<'completed' | 'manual_reconciliation'> {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(taskId)) throw new Error('采购签收图片任务无效');
    const { store, gateway } = this.ready();
    const task = await store.claimUpload(taskId, this.authorize);
    if (task.taskId !== taskId) throw new Error('采购签收图片任务租约无效');
    if (task.state === 'completed') return 'completed';
    if (!task.leaseToken) throw new Error('采购签收图片任务租约无效');
    if (task.state === 'dispatching' || task.state === 'manual_reconciliation') return 'manual_reconciliation';
    if (task.state === 'uploaded') { await store.commitUploaded(taskId, task.leaseToken, this.authorize); return 'completed'; }
    if (task.state !== 'ready') throw new Error('采购签收图片任务状态无效');
    let content: Buffer;
    try {
      content = await gateway.downloadMessageImage(task.imageMessageId, task.imageKey);
      if (!Buffer.isBuffer(content) || !content.length) throw new Error('采购签收图片内容为空');
    } catch (error) {
      await store.releaseBeforeDispatch(taskId, task.leaseToken);
      throw error;
    }
    await store.markUploadDispatched(taskId, task.leaseToken, this.authorize);
    try {
      const fileToken = await gateway.uploadAttachment(content);
      if (typeof fileToken !== 'string' || !fileToken.trim()) throw new Error('采购签收图片上传回执缺失');
      await store.recordUploaded(taskId, task.leaseToken, fileToken);
    } catch (error) {
      // Once upload started, neither timeout nor failed persistence proves no external write occurred.
      try { await store.markUploadUncertain(taskId, task.leaseToken); } catch { /* dispatched fence remains authoritative */ }
      throw error;
    }
    // A failure here leaves the saved uploaded receipt for a commit-only retry, never another upload.
    await store.commitUploaded(taskId, task.leaseToken, this.authorize);
    return 'completed';
  }
}
