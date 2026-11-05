import { createHash } from 'node:crypto';
import type { PurchaseWorkflowRecord, PurchaseWorkflowUser } from '../../../shared/purchase-workflow.interface';
import type { PlatformApprovalPersistedAction } from './purchase-platform-approval-plan';
import { buildPurchaseManagerApprovalPatch, isManagerApprovalTargetApplied, type PurchaseManagerApprovalDecision } from './purchase-manager-approval.rules';
import { buildPurchasePlatformResolvedFields } from './purchase-manager-approval.fields';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import { normalizeAccessDisplayName } from '../../common/access/access-display-name';

type Purchaser = { openId: string; name: string };
/** Returned only by the trusted ledger after an exclusive worker lease. */
export interface PlatformApprovalWorkerJob {
  /** Includes immutable serverActionId: 256-bit CSPRNG generated at initial
   * claim, independent of the client request and persisted before any I/O. */
  action: PlatformApprovalPersistedAction;
  leaseToken: string;
  kind: 'dispatch' | 'reconcile' | 'complete' | 'done';
  batch: { approvalBatchId: string; flowVersion: 'legacy' | 'lifecycle_v1'; requesterOpenId: string; itemRecordId: string; itemStatus: 'processing' | 'approved' | 'rejected'; itemEventId: string };
  /** Frozen by beginDispatch before I/O, required for non-rejection recovery. */
  frozenPurchaser?: Purchaser;
}

/** Implementations MUST use the common purchase ledger lock, preserve existing
 * fields, and persist before returning. Tokens below are internal lease tokens,
 * never browser credentials. The production adapter is not implemented here. */
export interface PlatformApprovalWorkerStore {
  claimPending(eventId: string): Promise<PlatformApprovalWorkerJob | null>;
  /** Atomically verifies lease, server-generated action ID, batch/item state and immutable fingerprint;
   * persists dispatch fence, purchaser and patch hash. It NEVER returns true twice. */
  beginDispatch(job: PlatformApprovalWorkerJob, purchaser: Purchaser | undefined, patchHash: string): Promise<boolean>;
  /** Only before the dispatch fence: release the worker lease and retry later. */
  deferBeforeDispatch(job: PlatformApprovalWorkerJob, reason: string): Promise<void>;
  /** Marks outcome unknown/manual without releasing the dispatch fence. */
  markUnknown(job: PlatformApprovalWorkerJob, reason: string): Promise<void>;
  /** Persists the verified exact remote action/result before completion. */
  recordConfirmed(job: PlatformApprovalWorkerJob, evidence: { actionId: string; resultHash: string; purchaser?: Purchaser }): Promise<void>;
  /** One atomic transaction: finish ONLY this item, retain other batch items,
   * mark this exact action completed and enqueue original card refresh/outbox. */
  completeAndRefresh(job: PlatformApprovalWorkerJob): Promise<void>;
}
/** These fields must be returned only after the gateway has verified that the
 * corresponding Bitable fields exist and are readable. Missing is not empty. */
export type PlatformApprovalReadback = PurchaseWorkflowRecord & {
  platformApprovalTimeMs?: number;
  platformCurrentApproverOpenIds?: string[];
  platformActualApproverOpenIds?: string[];
};
export interface PlatformApprovalWorkerGateway {
  readRecord(recordId: string): Promise<PlatformApprovalReadback>;
  /** Server-side routing only; the store freezes it before first write. */
  resolvePurchaser(record: PurchaseWorkflowRecord, choice: 'comprehensive' | 'building_self'): Promise<Purchaser>;
  writeRecord(recordId: string, fields: Record<string, unknown>): Promise<void>;
}
export type PlatformApprovalWorkerResult = 'completed' | 'busy' | 'manual_reconciliation';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value ?? null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, stable(field)]));
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function validPurchaser(value: Purchaser | undefined): value is Purchaser {
  return !!value && /^ou_[A-Za-z0-9_-]+$/.test(value.openId) && !!normalizeAccessDisplayName(value.name) && normalizeAccessDisplayName(value.name) === value.name;
}
function decision(job: PlatformApprovalWorkerJob, purchaser?: Purchaser): PurchaseManagerApprovalDecision {
  if (job.action.choice === 'reject') return { choice: 'reject', rejectionReason: job.action.rejectionReason };
  if (!validPurchaser(purchaser)) throw new Error('采购人路由不可核对');
  return { choice: job.action.choice, rejectionReason: '', purchaser: { openId: purchaser.openId, name: purchaser.name, positions: [], buildings: [] } as PurchaseWorkflowUser };
}
function validateJob(job: PlatformApprovalWorkerJob, eventId: string): void {
  const action = job?.action, batch = job?.batch;
  if (!action || !['dispatch', 'reconcile', 'complete', 'done'].includes(job.kind) || action.source !== 'platform' || action.eventId !== eventId || !/^platform_[A-Za-z0-9_-]{16,64}$/.test(eventId) || !/^pa_[A-Za-z0-9_-]{43}$/.test(action.serverActionId) ||
      !/^[a-f0-9]{64}$/.test(action.fingerprint) || !Array.isArray(action.recordIds) || action.recordIds.length !== 1 || !/^rec[A-Za-z0-9_-]+$/.test(action.recordIds[0]) ||
      !['comprehensive', 'building_self', 'reject'].includes(action.choice) || !['platform', 'impersonation'].includes(action.identitySource) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(action.actorAccountId) || !/^[A-Za-z0-9_-]{1,160}$/.test(action.subjectAccountId) ||
      !Number.isSafeInteger(action.actorAuthorizationVersion) || action.actorAuthorizationVersion < 1 || !Number.isSafeInteger(action.subjectAuthorizationVersion) || action.subjectAuthorizationVersion < 1 ||
      normalizeAccessDisplayName(action.actorDisplayName) !== action.actorDisplayName || !action.actorDisplayName || normalizeAccessDisplayName(action.subjectDisplayName) !== action.subjectDisplayName || !action.subjectDisplayName ||
      (action.identitySource === 'platform' && (action.actorAccountId !== action.subjectAccountId || action.actorAuthorizationVersion !== action.subjectAuthorizationVersion || action.actorDisplayName !== action.subjectDisplayName)) ||
      !batch || !['legacy', 'lifecycle_v1'].includes(batch.flowVersion) ||
      batch.approvalBatchId !== action.approvalBatchId || batch.itemRecordId !== action.recordIds[0] ||
      (job.kind === 'done' ? batch.itemStatus !== (action.choice === 'reject' ? 'rejected' : 'approved') : batch.itemStatus !== 'processing') || batch.itemEventId !== eventId ||
      !/^ou_[A-Za-z0-9_-]+$/.test(batch.requesterOpenId) || !/^[A-Za-z0-9_-]{8,160}$/.test(job.leaseToken) ||
      !Number.isSafeInteger(action.acceptedAtMs) || action.acceptedAtMs < 1 || !action.authorityTarget) throw new Error('采购审批任务不一致');
}
function validateRecord(job: PlatformApprovalWorkerJob, record: PurchaseWorkflowRecord): void {
  const scope = purchaseAuthorityTarget(record), action = job.action;
  if (!scope || record.recordId !== action.recordIds[0] || record.requesterOpenId !== job.batch.requesterOpenId ||
      scope.building !== action.authorityTarget.building || scope.specialty !== action.authorityTarget.specialty ||
      (record.specialty?.trim() && !scope.specialty) || (record.approvalBatchId && record.approvalBatchId !== action.approvalBatchId) ||
      (job.batch.flowVersion === 'lifecycle_v1' && record.approvalBatchId !== action.approvalBatchId)) throw new Error('采购审批记录已变化');
}
function precondition(record: PurchaseWorkflowRecord): string {
  return hash({ recordId: record.recordId, approvalBatchId: record.approvalBatchId || '', status: record.status, actionId: record.approvalActionId || '',
    building: record.building, specialty: record.specialty || '', requesterOpenId: record.requesterOpenId, itemName: record.itemName,
    specification: record.specification, sku: record.sku, unit: record.unit, unitPrice: record.unitPrice, requestedQuantity: record.requestedQuantity,
    purchaseMethod: record.purchaseMethod, purchaseLinks: record.purchaseLinks, procurementForm: record.procurementForm, singleReason: record.singleReason });
}
function confirmed(job: PlatformApprovalWorkerJob, record: PlatformApprovalReadback, selected: PurchaseManagerApprovalDecision): boolean {
  const expectedState = job.action.choice === 'reject' ? '已驳回' : '已通过';
  return record.approvalActionId === job.action.serverActionId && isManagerApprovalTargetApplied(record, selected) &&
    record.approvalWorkflowStatus === expectedState && record.platformApprovalTimeMs === job.action.acceptedAtMs &&
    Array.isArray(record.platformCurrentApproverOpenIds) && record.platformCurrentApproverOpenIds.length === 0 &&
    (!job.action.actorFeishuOpenId || Array.isArray(record.platformActualApproverOpenIds) && record.platformActualApproverOpenIds.length === 1 && record.platformActualApproverOpenIds[0] === job.action.actorFeishuOpenId);
}

/** Isolated coordinator; does not register a module, schedule a task or make a
 * real network call. claimPending must distinguish live leases from recoverable
 * dispatches. An uncertain/expired dispatch is only read back, never resent. */
export function createPlatformApprovalCoordinator(store: PlatformApprovalWorkerStore, gateway: PlatformApprovalWorkerGateway) {
  async function finish(job: PlatformApprovalWorkerJob, row: PlatformApprovalReadback, selected: PurchaseManagerApprovalDecision, purchaser?: Purchaser): Promise<PlatformApprovalWorkerResult> {
    if (!confirmed(job, row, selected)) { await store.markUnknown(job, 'remote_result_unverified'); return 'manual_reconciliation'; }
    await store.recordConfirmed(job, { actionId: job.action.serverActionId, resultHash: hash({ recordId: row.recordId, actionId: row.approvalActionId, status: row.status, method: row.purchaseMethod, purchaserOpenId: row.purchaserOpenId, warehouseConfirmed: row.warehouseConfirmed, rejectionReason: row.rejectionReason, workflowStatus: row.approvalWorkflowStatus, approvalTimeMs: row.platformApprovalTimeMs, currentApprovers: row.platformCurrentApproverOpenIds, ...(job.action.actorFeishuOpenId ? { actualApprovers: row.platformActualApproverOpenIds } : {}) }), ...(purchaser ? { purchaser } : {}) });
    await store.completeAndRefresh(job);
    return 'completed';
  }
  return {
    async run(eventId: string): Promise<PlatformApprovalWorkerResult> {
      if (!/^platform_[A-Za-z0-9_-]{16,64}$/.test(eventId)) throw new Error('采购审批任务无效');
      const job = await store.claimPending(eventId);
      if (!job) return 'busy';
      validateJob(job, eventId);
      if (job.kind === 'done') return 'completed';
      if (job.kind === 'complete') { await store.completeAndRefresh(job); return 'completed'; }
      let row: PlatformApprovalReadback;
      try { row = await gateway.readRecord(job.action.recordIds[0]); }
      catch {
        if (job.kind === 'dispatch') { await store.deferBeforeDispatch(job, 'record_unavailable'); return 'busy'; }
        await store.markUnknown(job, 'record_unavailable'); return 'manual_reconciliation';
      }
      try { validateRecord(job, row); }
      catch { await store.markUnknown(job, 'record_changed'); return 'manual_reconciliation'; }
      let purchaser = job.frozenPurchaser;
      if (job.kind === 'dispatch' && job.action.choice !== 'reject') {
        try { purchaser = await gateway.resolvePurchaser(row, job.action.choice); if (!validPurchaser(purchaser)) throw new Error(); }
        catch { await store.deferBeforeDispatch(job, 'purchaser_unavailable'); return 'busy'; }
      }
      let selected: PurchaseManagerApprovalDecision;
      try { selected = decision(job, purchaser); }
      catch { await store.markUnknown(job, 'purchaser_unavailable'); return 'manual_reconciliation'; }
      if (job.kind === 'reconcile') return finish(job, row, selected, purchaser);
      // A pending dispatch may already reflect an external actor's result. It is
      // never claimed as our own merely because the visible status resembles ours.
      if (row.status !== '未开始（待审批）' || row.approvalActionId) { await store.markUnknown(job, 'record_not_pending'); return 'manual_reconciliation'; }
      let patch: Record<string, unknown>;
      try { patch = { ...buildPurchaseManagerApprovalPatch(row, selected), ...buildPurchasePlatformResolvedFields({ choice: job.action.choice, actorFeishuOpenId: job.action.actorFeishuOpenId, eventId: job.action.serverActionId, approvalTime: new Date(job.action.acceptedAtMs) }) }; }
      catch { await store.markUnknown(job, 'invalid_decision'); return 'manual_reconciliation'; }
      const expected = precondition(row);
      if (!await store.beginDispatch(job, purchaser, hash(patch))) return 'busy';
      // The fence is durable now. After any exception no path can issue another write.
      let observed: PlatformApprovalReadback;
      try {
        const current = await gateway.readRecord(job.action.recordIds[0]); validateRecord(job, current);
        if (precondition(current) !== expected) { await store.markUnknown(job, 'record_changed_before_write'); return 'manual_reconciliation'; }
        await gateway.writeRecord(current.recordId, patch);
        observed = await gateway.readRecord(current.recordId); validateRecord(job, observed);
      } catch { await store.markUnknown(job, 'write_or_readback_unknown'); return 'manual_reconciliation'; }
      return finish(job, observed, selected, purchaser);
    },
  };
}
