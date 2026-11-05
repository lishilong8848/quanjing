import type { PurchaseManagerApprovalBatchEntry, PurchaseLifecycleOutboxEntry } from './purchase-workflow.store';
import type { PurchaseReplicaIdentity, VerifiedPurchaseReplicaReceipt } from './purchase-lifecycle-replica';
import { projectPurchaseLifecycle, type PurchaseLifecycleItem, type PurchaseLifecycleViewer } from './purchase-lifecycle-projection';
import { buildPurchaseLifecycleCardPage, type PurchaseLifecycleBatchApprovalProof, type PurchaseLifecycleCallbackResolver, type PurchaseLifecycleManagerCallbackResolver } from './purchase-lifecycle-card';
import { PurchaseLifecyclePaginationError } from './purchase-lifecycle-pagination';
import { readEnv } from '../../common/config/external-services.config';
import { buildLifecycleReceiptPreparationFeedback, buildLifecycleReceiptUploadButtons, buildPurchaseLifecycleForm, type LifecycleReceiptPreparationFeedback, type PurchaseLifecycleFormBinding } from './purchase-lifecycle-form';

type LifecycleView = { kind: 'list' } | { kind: PurchaseLifecycleFormViewKind; recordId: string };
type PendingLifecycleDelivery = { identity: PurchaseReplicaIdentity; desiredRevision: number; desiredPage: number; desiredView?: LifecycleView; status: 'ready' | 'needs_reconciliation' };
export type PurchaseLifecycleFormViewKind = 'reject' | 'order' | 'receipt';
export interface PurchaseLifecycleFormPresentation {
  actualQuantity?: number;
  actualAmount?: number;
  signerOpenId?: string;
  receiptTime?: string;
  purchaseMethod?: string;
  receiptPhotoCount?: number;
  invoiceCount?: number;
}

/** The workflow store must fence the listed revision under its own lock. */
export interface PurchaseLifecycleDeliveryStore {
  listExpiredPreparedLifecycleDeliveries(limit: number, nowMs: number): Promise<Array<{ identity: PurchaseReplicaIdentity; attemptToken: string }>>;
  recoverExpiredPreparedLifecycleDelivery(identity: PurchaseReplicaIdentity, token: string, nowMs: number): Promise<PurchaseLifecycleOutboxEntry>;
  listExpiredLifecycleContinuations(limit: number, nowMs: number, afterKey: string): Promise<Array<{ identity: PurchaseReplicaIdentity; generation: number; messageId: string; sentAtMs: number; revision: number; cursor: string }>>;
  queueExpiredLifecycleContinuation(identity: PurchaseReplicaIdentity, expected: { generation: number; messageId: string; sentAtMs: number; revision: number }, nowMs: number, authorize: (batch: PurchaseManagerApprovalBatchEntry, entry: PurchaseLifecycleOutboxEntry) => void): Promise<PurchaseLifecycleOutboxEntry>;
  listPendingLifecycleDeliveries(limit: number, status: 'ready', nowMs: number): Promise<PendingLifecycleDelivery[]>;
  deferLifecycleDelivery(identity: PurchaseReplicaIdentity, expectedRevision: number, expectedPage: number, reason: 'source' | 'authorization', nowMs: number): Promise<PurchaseLifecycleOutboxEntry>;
  getLifecycleOutbox(identity: PurchaseReplicaIdentity): Promise<PurchaseLifecycleOutboxEntry | null>;
  getLifecycleReceiptPreparation?(identity:PurchaseReplicaIdentity,messageId:string,authorize:(batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchEntry['items'][number])=>void):Promise<LifecycleReceiptPreparationFeedback|null>;
  beginLifecycleDelivery(identity: PurchaseReplicaIdentity, nowMs: number, expectedRevision: number, expectedPage: number, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void): Promise<{ action: 'send' | 'update' | 'reconcile' | 'none'; entry: PurchaseLifecycleOutboxEntry & { pendingView?: LifecycleView } }>;
  issuePreparedLifecycleForm(identity: PurchaseReplicaIdentity, token: string, binding: PurchaseLifecycleFormBinding, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void): Promise<string>;
  resetLifecycleDesiredViewToList(identity: PurchaseReplicaIdentity, revision: number, page: number, view: LifecycleView, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void): Promise<PurchaseLifecycleOutboxEntry>;
  resetLifecycleDesiredPageToFirst(identity: PurchaseReplicaIdentity, expectedRevision: number, expectedPage: number, authorizeInvalidPage: (batch: PurchaseManagerApprovalBatchEntry, entry: PurchaseLifecycleOutboxEntry) => void): Promise<PurchaseLifecycleOutboxEntry>;
  markLifecycleDeliveryDispatched(identity: PurchaseReplicaIdentity, token: string, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void, expectedPreparation?:LifecycleReceiptPreparationFeedback|null): Promise<PurchaseLifecycleOutboxEntry>;
  abortPreparedLifecycleDelivery(identity: PurchaseReplicaIdentity, token: string): Promise<PurchaseLifecycleOutboxEntry>;
  completeLifecycleDelivery(identity: PurchaseReplicaIdentity, token: string, outcome: ({ kind: 'send'; receipt: VerifiedPurchaseReplicaReceipt } | { kind: 'update'; messageId: string; revision: number }) & { pageProof: { totalPages: number; authorizationFingerprint: string } }): Promise<PurchaseLifecycleOutboxEntry>;
}

/** A trusted server-side authorization snapshot; never construct from callback values. */
export interface PurchaseLifecycleDeliveryGrant {
  /** Synchronously compare live identity, employment, scope, duties and source versions. */
  assertCurrent(): void;
  /** Direct remote readback before dispatch; this is not an external CAS lock. */
  verifyLatest(): Promise<void>;
  /** Called under the store lock. Validate batch state and all preloaded source versions. */
  authorizeBatch(batch: PurchaseManagerApprovalBatchEntry, expectedRevision: number): void;
  /** Server-owned synchronous identity/duty/configuration fingerprint for the delivered projection. */
  authorizationFingerprint(batch: PurchaseManagerApprovalBatchEntry): string;
  /** Only data and grants for the specified recipient; special observers are separately authorized. */
  project(batch: PurchaseManagerApprovalBatchEntry, expectedRevision: number): {
    items: ReadonlyArray<PurchaseLifecycleItem>;
    viewer: PurchaseLifecycleViewer;
    batchApprovalProof?: PurchaseLifecycleBatchApprovalProof;
    resolveCallback?: PurchaseLifecycleCallbackResolver;
    resolveManagerCallback?: PurchaseLifecycleManagerCallbackResolver;
    formPresentations?: Readonly<Record<string, Partial<Record<PurchaseLifecycleFormViewKind, PurchaseLifecycleFormPresentation>>>>;
  };
}

export interface PurchaseLifecycleDeliveryAuthorizer {
  /** Must fail closed if personnel, permissions, duties or record data cannot be verified. */
  prepare(identity: PurchaseReplicaIdentity): Promise<PurchaseLifecycleDeliveryGrant>;
}

/** These dedicated gateway methods must not invoke shared automatic card-copy hooks. */
export interface PurchaseLifecycleDeliveryTransport {
  /** The send request binds the recipient and UUID; authenticated readback verifies message ID and time. */
  sendLifecycleCard(recipientOpenId: string, card: Record<string, unknown>, uuid: string, expectedAppId: string): Promise<VerifiedPurchaseReplicaReceipt>;
  updateLifecycleCard(messageId: string, card: Record<string, unknown>, expectedAppId: string): Promise<void>;
}

export interface PurchaseLifecycleDeliveryRunResult {
  scanned: number;
  delivered: number;
  unchanged: number;
  needsReconciliation: number;
  rejectedBeforeDispatch: number;
  pageReplanned: number;
}

function requireSynchronousCheck(result: unknown): void {
  if (result instanceof Promise) void result.catch(() => undefined);
  if (result !== undefined) throw new Error('采购卡片授权检查必须同步完成');
}
function requireFingerprint(value: unknown): string {
  if (value instanceof Promise) { void value.catch(() => undefined); throw new Error('采购卡片授权指纹必须同步核对'); }
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('采购卡片授权状态无效');
  return value;
}
class LifecycleFormViewStale extends Error {}
function validatedView(value: LifecycleView | undefined): LifecycleView {
  if (value === undefined) return { kind: 'list' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('采购卡片视图无效');
  if (value.kind === 'list' && Object.keys(value).join(',') === 'kind') return { kind: 'list' };
  if (['reject', 'order', 'receipt'].includes(value.kind) && Object.keys(value).sort().join(',') === 'kind,recordId' &&
    'recordId' in value && typeof value.recordId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.recordId)) return { kind: value.kind as PurchaseLifecycleFormViewKind, recordId: value.recordId };
  throw new Error('采购卡片视图无效');
}

/** Explicitly invoked worker; not registered or scheduled by this module. */
export class PurchaseLifecycleDeliveryService {
  private running = false;
  private continuationCursor = '';
  constructor(
    private readonly store: PurchaseLifecycleDeliveryStore,
    private readonly authorizer: PurchaseLifecycleDeliveryAuthorizer,
    private readonly transport: PurchaseLifecycleDeliveryTransport,
    private readonly clock: () => number = Date.now,
    private readonly attachmentBaseUrl: () => string = () => readEnv('PUBLIC_BASE_URL', ['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL']),
    private readonly receiptUploadReady: () => boolean = () => false,
    private readonly paymentUploadReady: () => boolean = () => false,
  ) {}

  async run(limit = 50): Promise<PurchaseLifecycleDeliveryRunResult> {
    if (this.running) throw new Error('采购全流程卡片投递正在运行');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('采购卡片队列读取数量无效');
    this.running = true;
    const result: PurchaseLifecycleDeliveryRunResult = { scanned: 0, delivered: 0, unchanged: 0, needsReconciliation: 0, rejectedBeforeDispatch: 0, pageReplanned: 0 };
    try {
      for (const abandoned of await this.store.listExpiredPreparedLifecycleDeliveries(limit, this.clock())) {
        // Recovery and mark-dispatched race under the same persistent token fence.
        try { await this.store.recoverExpiredPreparedLifecycleDelivery(abandoned.identity, abandoned.attemptToken, this.clock()); } catch { /* another process won; never resend an unknown dispatch */ }
      }
      const expired = await this.store.listExpiredLifecycleContinuations(limit, this.clock(), this.continuationCursor);
      if (!expired.length) this.continuationCursor = '';
      for (const candidate of expired) {
        this.continuationCursor = candidate.cursor;
        try {
          const grant = await this.authorizer.prepare(candidate.identity);
          requireSynchronousCheck(grant.assertCurrent());
          await grant.verifyLatest();
          await this.store.queueExpiredLifecycleContinuation(candidate.identity, candidate, this.clock(), batch => {
            requireSynchronousCheck(grant.assertCurrent());
            requireSynchronousCheck(grant.authorizeBatch(batch, candidate.revision));
            const view = grant.project(batch, candidate.revision);
            const items = projectPurchaseLifecycle(view.items, view.viewer);
            if (!items.some(item => item.currentStage && !['completed', 'terminated', 'unknown'].includes(item.currentStage) && item.actions.length > 0)) throw new Error('采购卡片已无本人待办');
          });
        } catch { /* revoked, changed, source unavailable or another worker won: skip */ }
      }
      const pending = await this.store.listPendingLifecycleDeliveries(limit, 'ready', this.clock());
      for (const selected of pending) {
        result.scanned += 1;
        let beginAttempted = false;
        let dispatched = false;
        let attemptToken = '';
        let failureReason: 'source' | 'authorization' = 'source';
        let grant: PurchaseLifecycleDeliveryGrant | undefined;
        try {
          if (selected.status !== 'ready' || !Number.isSafeInteger(selected.desiredRevision) || selected.desiredRevision < 1 || !Number.isSafeInteger(selected.desiredPage) || selected.desiredPage < 1) throw new Error('采购卡片队列状态无效');
          const identity = selected.identity;
          let desiredView = validatedView(selected.desiredView);
          grant = await this.authorizer.prepare(identity);
          const currentGrant = grant;
          let card: Record<string, unknown> | undefined;
          let fingerprint = '';
          let renderPage: ((continued: boolean, generation: number) => ReturnType<typeof buildPurchaseLifecycleCardPage>) | undefined;
          let buildForm: ((binding: PurchaseLifecycleFormBinding, token: string) => Record<string, unknown>) | undefined;
          let receiptMethod: string | undefined;
          let receiptFeedback: LifecycleReceiptPreparationFeedback | null = null;
          let receiptReady = false;
          let paymentReady = false;
          const authorizeReceiptFeedback = (batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchEntry['items'][number]) => {
            requireSynchronousCheck(currentGrant.assertCurrent());
            requireSynchronousCheck(currentGrant.authorizeBatch(batch,selected.desiredRevision));
            const projected = currentGrant.project(batch,selected.desiredRevision);
            const permitted = projectPurchaseLifecycle(projected.items,projected.viewer).find(row => row.recordId===item.executionRecordId);
            if (!permitted?.actions.includes('receive')) throw new Error('采购签收权限已变化');
          };
          if (desiredView.kind === 'receipt') {
            const ready: unknown = this.receiptUploadReady();
            if (ready instanceof Promise) void ready.catch(() => undefined);
            receiptReady = ready === true && typeof this.store.getLifecycleReceiptPreparation === 'function';
            if (receiptReady) {
              const existing = await this.store.getLifecycleOutbox(identity);
              if (existing?.replica.messageId) receiptFeedback = await this.store.getLifecycleReceiptPreparation!(identity, existing.replica.messageId, authorizeReceiptFeedback);
            }
          }
          beginAttempted = true;
          const begun = await this.store.beginLifecycleDelivery(identity, this.clock(), selected.desiredRevision, selected.desiredPage, batch => {
            failureReason = 'authorization';
            requireSynchronousCheck(currentGrant.assertCurrent());
            requireSynchronousCheck(currentGrant.authorizeBatch(batch, selected.desiredRevision));
            failureReason = 'source';
            const view = currentGrant.project(batch, selected.desiredRevision);
            const items = projectPurchaseLifecycle(view.items, view.viewer);
            if (!items.length) throw new Error('采购卡片没有已授权内容');
            if (view.viewer.kind !== 'observer' && items.some(item => item.currentStage === 'ordering' && item.actions.includes('order'))) {
              try { const ready: unknown = this.paymentUploadReady(); if (ready instanceof Promise) void ready.catch(() => undefined); paymentReady = ready === true; } catch { paymentReady = false; }
            }
            if (desiredView.kind !== 'list') {
              const selectedRecordId = desiredView.recordId;
              const item = items.find(row => row.recordId === selectedRecordId);
              const required = desiredView.kind === 'reject' ? 'approve' : desiredView.kind === 'order' ? 'order' : 'receive';
              const presentation = view.formPresentations?.[desiredView.recordId]?.[desiredView.kind];
              if (item && !item.actions.includes(required)) throw new LifecycleFormViewStale('采购表单已不可办理');
              if (!item || !presentation) throw new Error('采购表单权限或数据已变化');
              if (desiredView.kind === 'receipt') receiptMethod = presentation.purchaseMethod;
              buildForm = (binding, token) => buildPurchaseLifecycleForm({ binding, token,
                actualQuantity: presentation.actualQuantity, actualAmount: presentation.actualAmount, signerOpenId: presentation.signerOpenId,
                receiptTime: presentation.receiptTime, purchaseMethod: presentation.purchaseMethod,
                receiptPhotoCount: presentation.receiptPhotoCount, invoiceCount: presentation.invoiceCount });
            }
            fingerprint = requireFingerprint(currentGrant.authorizationFingerprint(batch));
            renderPage = (continued, generation) => buildPurchaseLifecycleCardPage({ approvalBatchId: identity.batchId, cardRevision: selected.desiredRevision, continued, generation, attachmentBaseUrl: this.attachmentBaseUrl(), paymentUploadReady: () => paymentReady, items, observer: view.viewer.kind === 'observer', batchApprovalProof: view.batchApprovalProof, resolveCallback: view.resolveCallback, resolveManagerCallback: view.resolveManagerCallback }, selected.desiredPage);
            card = renderPage(false, 1).card;
          });
          if (begun.action === 'none') { result.unchanged += 1; continue; }
          if (begun.action === 'reconcile') { result.needsReconciliation += 1; continue; }
          const replica = begun.entry.replica;
          attemptToken = begun.entry.attemptToken;
          if (!card || replica.pendingRevision !== selected.desiredRevision || begun.entry.pendingPage !== selected.desiredPage || !begun.entry.attemptToken ||
            replica.appId !== identity.appId || replica.batchId !== identity.batchId || replica.recipientOpenId !== identity.recipientOpenId ||
            (begun.action === 'send' && replica.state !== 'send_unknown') ||
            (begun.action === 'update' && replica.state !== 'update_unknown')) throw new Error('采购卡片投递凭据不匹配');
          const pendingView = validatedView(begun.entry.pendingView);
          let reopenAfterContinuation = false;
          if (JSON.stringify(pendingView) !== JSON.stringify(desiredView)) {
            // A new generation has no confirmed message ID yet; its form must be reopened after delivery.
            if (begun.action !== 'send' || desiredView.kind === 'list' || pendingView.kind !== 'list') throw new Error('采购卡片待发送视图不匹配');
            reopenAfterContinuation = true;
            desiredView = pendingView;
          }
          if (!renderPage) throw new Error('采购卡片内容无法核对');
          const actualPage = renderPage(replica.generation > 1, replica.generation);
          card = actualPage.card;
          if (reopenAfterContinuation) {
            const elements = (card.body as { elements: Record<string, unknown>[] }).elements;
            elements.unshift({ tag: 'div', text: { tag: 'plain_text', content: '原卡已过期，请在延续卡重新打开表单。' } });
            if (elements.length > 200 || Buffer.byteLength(JSON.stringify(card), 'utf8') > 30 * 1024) throw new Error('采购延续卡片超限');
          }
          const pageProof = { totalPages: actualPage.pageInfo.totalPages, authorizationFingerprint: fingerprint };
          if (desiredView.kind !== 'list') {
            if (begun.action !== 'update' || !replica.messageId || !buildForm) throw new Error('新续卡须先完成送达再打开表单');
            const binding: PurchaseLifecycleFormBinding = { action: desiredView.kind === 'reject' ? 'submit_item_reject' : desiredView.kind === 'order' ? 'submit_order' : 'submit_receipt',
              approvalBatchId: identity.batchId, executionRecordId: desiredView.recordId,
              role: desiredView.kind === 'reject' ? 'manager' : desiredView.kind === 'order' ? 'purchaser' : 'requester', flowVersion: 'lifecycle_v1', cardRevision: selected.desiredRevision };
            const token = await this.store.issuePreparedLifecycleForm(identity, attemptToken, binding, batch => {
              requireSynchronousCheck(currentGrant.assertCurrent());
              requireSynchronousCheck(currentGrant.authorizeBatch(batch, selected.desiredRevision));
              if (requireFingerprint(currentGrant.authorizationFingerprint(batch)) !== fingerprint) throw new Error('采购表单授权状态已变化');
              const current = currentGrant.project(batch, selected.desiredRevision);
              const item = projectPurchaseLifecycle(current.items, current.viewer).find(row => row.recordId === desiredView.recordId);
              const required = desiredView.kind === 'reject' ? 'approve' : desiredView.kind === 'order' ? 'order' : 'receive';
              if (!item || !item.actions.includes(required) || !current.formPresentations?.[desiredView.recordId]?.[desiredView.kind]) throw new Error('采购表单权限已变化');
            });
            const elements = (card.body as { elements: Record<string, unknown>[] }).elements;
            if (binding.action === 'submit_receipt') {
              if (receiptFeedback && receiptFeedback.executionRecordId === binding.executionRecordId)
                elements.push(...buildLifecycleReceiptPreparationFeedback(receiptFeedback,{recordId:binding.executionRecordId,recipientOpenId:identity.recipientOpenId,messageId:replica.messageId,nowMs:this.clock()}));
              elements.push(...buildLifecycleReceiptUploadButtons(binding, receiptMethod, receiptReady));
            }
            elements.push(buildForm(binding, token));
            elements.push({ tag: 'button', type: 'default', width: 'fill', text: { tag: 'plain_text', content: '返回采购列表' },
              behaviors: [{ type: 'callback', value: { version: 5, workflowType: 'purchase_lifecycle_page', action: 'page',
                approvalBatchId: identity.batchId, flowVersion: 'lifecycle_v1', cardRevision: selected.desiredRevision, page: selected.desiredPage } }] });
            if (elements.length > 200 || Buffer.byteLength(JSON.stringify(card), 'utf8') > 30 * 1024) throw new Error('采购表单卡片超限');
          }
          failureReason = 'authorization';
          requireSynchronousCheck(currentGrant.assertCurrent());
          failureReason = 'source';
          await currentGrant.verifyLatest();
          failureReason = 'authorization';
          requireSynchronousCheck(currentGrant.assertCurrent());
          if (receiptReady && desiredView.kind === 'receipt' && begun.action === 'update') {
            const ready:unknown = this.receiptUploadReady();
            if (ready instanceof Promise) void ready.catch(()=>undefined);
            if (ready !== true) throw new Error('采购签收附件功能状态已变化');
            const latest=await this.store.getLifecycleReceiptPreparation!(identity,replica.messageId,authorizeReceiptFeedback);
            if (JSON.stringify(latest)!==JSON.stringify(receiptFeedback) || (latest?.state==='ready' && (!Number.isSafeInteger(latest.intentExpiresAtMs) || Number(latest.intentExpiresAtMs)<=this.clock()))) throw new Error('采购签收附件状态已变化');
          }
          await this.store.markLifecycleDeliveryDispatched(identity, attemptToken, batch => {
            if (paymentReady) {
              const ready: unknown = this.paymentUploadReady();
              if (ready instanceof Promise) void ready.catch(() => undefined);
              if (ready !== true) throw new Error('采购付款附件功能状态已变化');
            }
            requireSynchronousCheck(currentGrant.assertCurrent());
            requireSynchronousCheck(currentGrant.authorizeBatch(batch, selected.desiredRevision));
            if (requireFingerprint(currentGrant.authorizationFingerprint(batch)) !== fingerprint) throw new Error('采购卡片授权状态已变化');
            const now = this.clock();
            if (!Number.isSafeInteger(now) || now < 1 || (begun.action === 'update' && (now < replica.sentAtMs || now - replica.sentAtMs > 14 * 86400_000))) throw new Error('采购卡片已过期，请重新规划续接');
          }, receiptReady && desiredView.kind === 'receipt' && begun.action === 'update' ? receiptFeedback : undefined);
          dispatched = true;
          if (begun.action === 'send') {
            const receipt = await this.transport.sendLifecycleCard(identity.recipientOpenId, card, replica.uuid, identity.appId);
            await this.store.completeLifecycleDelivery(identity, begun.entry.attemptToken, { kind: 'send', receipt, pageProof });
          } else {
            const messageId = replica.messageId;
            await this.transport.updateLifecycleCard(messageId, card, identity.appId);
            await this.store.completeLifecycleDelivery(identity, begun.entry.attemptToken, { kind: 'update', messageId, revision: selected.desiredRevision, pageProof });
          }
          result.delivered += 1;
        } catch (error) {
          // If a store error may have occurred after fencing, inspect without sending.
          // A network operation with any failed result always requires reconciliation.
          if (!attemptToken && !dispatched && grant && error instanceof LifecycleFormViewStale && selected.desiredView && selected.desiredView.kind !== 'list') {
            try {
              await grant.verifyLatest();
              const currentGrant = grant, stale = validatedView(selected.desiredView);
              if (stale.kind === 'list') throw new Error('采购表单视图已变化');
              await this.store.resetLifecycleDesiredViewToList(selected.identity, selected.desiredRevision, selected.desiredPage, stale, batch => {
                requireSynchronousCheck(currentGrant.assertCurrent());
                requireSynchronousCheck(currentGrant.authorizeBatch(batch, selected.desiredRevision));
                const view = currentGrant.project(batch, selected.desiredRevision);
                const item = projectPurchaseLifecycle(view.items, view.viewer).find(row => row.recordId === stale.recordId);
                const required = stale.kind === 'reject' ? 'approve' : stale.kind === 'order' ? 'order' : 'receive';
                if (!item || item.actions.includes(required)) throw new Error('采购表单仍可办理或已不可查看');
              });
              result.pageReplanned += 1;
            } catch { result.rejectedBeforeDispatch += 1; }
          } else if (!attemptToken && !dispatched && grant && error instanceof PurchaseLifecyclePaginationError && error.code === 'INVALID_PAGE' && selected.desiredPage > 1) {
            try {
              await grant.verifyLatest();
              const currentGrant = grant;
              await this.store.resetLifecycleDesiredPageToFirst(selected.identity, selected.desiredRevision, selected.desiredPage, batch => {
                requireSynchronousCheck(currentGrant.assertCurrent());
                requireSynchronousCheck(currentGrant.authorizeBatch(batch, selected.desiredRevision));
                const view = currentGrant.project(batch, selected.desiredRevision);
                const items = projectPurchaseLifecycle(view.items, view.viewer);
                if (!items.length) throw new Error('采购卡片没有已授权内容');
                const first = buildPurchaseLifecycleCardPage({ approvalBatchId: selected.identity.batchId, cardRevision: selected.desiredRevision, generation: 1, attachmentBaseUrl: this.attachmentBaseUrl(), paymentUploadReady: this.paymentUploadReady, items, observer: view.viewer.kind === 'observer', batchApprovalProof: view.batchApprovalProof, resolveCallback: view.resolveCallback, resolveManagerCallback: view.resolveManagerCallback }, 1);
                if (first.pageInfo.totalPages >= selected.desiredPage) throw new Error('采购卡片页码仍然有效');
              });
              result.pageReplanned += 1;
            } catch {
              result.rejectedBeforeDispatch += 1;
              try { await this.store.deferLifecycleDelivery(selected.identity, selected.desiredRevision, selected.desiredPage, 'source', this.clock()); } catch { /* stale or in-flight: never override */ }
            }
          } else if (dispatched) result.needsReconciliation += 1;
          else if (attemptToken) {
            try {
              await this.store.abortPreparedLifecycleDelivery(selected.identity, attemptToken);
              result.rejectedBeforeDispatch += 1;
              try { await this.store.deferLifecycleDelivery(selected.identity, selected.desiredRevision, selected.desiredPage, failureReason, this.clock()); } catch { /* stale or in-flight: never override */ }
            }
            catch { result.needsReconciliation += 1; }
          } else if (beginAttempted) {
            try {
              const state = await this.store.getLifecycleOutbox(selected.identity);
              if (!state || state.replica.state === 'send_unknown' || state.replica.state === 'update_unknown') result.needsReconciliation += 1;
              else {
                result.rejectedBeforeDispatch += 1;
                try { await this.store.deferLifecycleDelivery(selected.identity, selected.desiredRevision, selected.desiredPage, failureReason, this.clock()); } catch { /* stale or in-flight: never override */ }
              }
            } catch { result.needsReconciliation += 1; }
          } else {
            result.rejectedBeforeDispatch += 1;
            try { await this.store.deferLifecycleDelivery(selected.identity, selected.desiredRevision, selected.desiredPage, failureReason, this.clock()); } catch { /* stale or in-flight: never override */ }
          }
        }
      }
      return result;
    } finally { this.running = false; }
  }
}
