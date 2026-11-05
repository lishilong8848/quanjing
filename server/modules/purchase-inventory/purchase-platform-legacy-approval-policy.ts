import { purchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';
import type { PurchaseWorkflowRecord, PurchaseWorkflowMethod } from '../../../shared/purchase-workflow.interface';

// Isolation-only contract: values must come from an already persisted, authorized
// server-side claim. This module cannot prove that provenance itself.
export interface PlatformLegacyApprovalClaim {
  recordId: string;
  eventId: string;
  serverActionId: string;
  decision: 'approved' | 'rejected';
  /** Snapshot of the record method at claim time; used for drift checks, never rewritten. */
  originalPurchaseMethod: PurchaseWorkflowMethod;
  /** Explicit method chosen with the request. Absent keeps the original method. */
  purchaseMethod?: PurchaseWorkflowMethod;
  originalBatchId: string;
  originalRequesterOpenId: string;
  authorityTarget: PurchaseAuthorityTarget;
}

type RelevantRecord = Pick<PurchaseWorkflowRecord, 'recordId' | 'status' | 'approvalCompleted' | 'purchaseMethod' | 'approvalBatchId' | 'approvalActionId' | 'requesterOpenId' | 'building' | 'specialty'>;
const methods = new Set<PurchaseWorkflowMethod>(['综合采购', '需求自采', '需求自采（楼内）']);

export function isSelectablePlatformLegacyPurchaseMethod(value: unknown): value is PurchaseWorkflowMethod {
  return typeof value === 'string' && methods.has(value as PurchaseWorkflowMethod);
}

/**
 * Resolves the method that will be written and stored on the claim.
 * - undefined: keep the original method (previous behaviour).
 * - a valid method with `approved`: use it.
 * - anything else, or any explicit method with `rejected`, is rejected.
 */
export function resolvePlatformLegacyPurchaseMethod(decision: 'approved' | 'rejected', original: unknown, selected: unknown): PurchaseWorkflowMethod {
  if (decision === 'rejected') {
    if (selected !== undefined) throw new Error('采购方式选择无效');
    return '驳回';
  }
  if (!methods.has(original as PurchaseWorkflowMethod)) throw new Error('采购原方式不可用');
  if (selected === undefined) return original as PurchaseWorkflowMethod;
  if (!isSelectablePlatformLegacyPurchaseMethod(selected) || decision !== 'approved') throw new Error('采购方式选择无效');
  return selected;
}

function assertIdentity(claim: PlatformLegacyApprovalClaim, record: RelevantRecord): void {
  const target = purchaseAuthorityTarget(record);
  if (!/^rec[A-Za-z0-9_-]+$/.test(claim.recordId) || !claim.eventId ||
      !/^pa_[A-Za-z0-9_-]{43}$/.test(claim.serverActionId) ||
      !['approved', 'rejected'].includes(claim.decision) ||
      record.recordId !== claim.recordId || (record.approvalBatchId || '') !== claim.originalBatchId ||
      record.requesterOpenId !== claim.originalRequesterOpenId || !target ||
      target.building !== claim.authorityTarget?.building || target.specialty !== claim.authorityTarget?.specialty ||
      (record.specialty && !target.specialty)) throw new Error('采购审批原记录或受理凭据不匹配');
}

/** The method the claim writes and confirms; throws when the stored selection is invalid. */
function claimPurchaseMethod(claim: PlatformLegacyApprovalClaim): PurchaseWorkflowMethod {
  try { return resolvePlatformLegacyPurchaseMethod(claim.decision, claim.originalPurchaseMethod, claim.purchaseMethod); }
  catch { throw new Error('采购审批方式选择无效'); }
}

/** Schema evidence must be supplied by a trusted metadata reader before any write. */
export function buildPlatformLegacyApprovalPatch(claim: PlatformLegacyApprovalClaim, record: RelevantRecord, actionMarkerFieldVerified: boolean): Record<string, string> {
  assertIdentity(claim, record);
  if (actionMarkerFieldVerified !== true || record.status !== '未开始（待审批）' || record.approvalCompleted ||
      record.approvalActionId || record.purchaseMethod !== claim.originalPurchaseMethod) {
    throw new Error('采购审批记录已变化或缺少可靠动作标识字段');
  }
  const method = claimPurchaseMethod(claim);
  return {
    '1️⃣物品采购方式': claim.decision === 'rejected' ? '驳回' : method,
    '采购流程': claim.decision === 'rejected' ? '驳回申请' : '审批通过（待下单）',
    '采购审批动作标识': claim.serverActionId,
  };
}

/** `markerPresent` is independently established from raw source/schema, not a defaulted mapped value. */
export function confirmPlatformLegacyApprovalResult(claim: PlatformLegacyApprovalClaim, record: RelevantRecord, markerPresent: boolean): boolean {
  try {
    assertIdentity(claim, record);
    const method = claim.decision === 'rejected' ? '驳回' : claimPurchaseMethod(claim);
    return markerPresent === true && record.approvalActionId === claim.serverActionId &&
      record.status === (claim.decision === 'rejected' ? '驳回申请' : '审批通过（待下单）') &&
      record.purchaseMethod === method;
  } catch { return false; }
}

/** Only the ledger may create this after validating the completed claim/work,
 * the active notification lease, and the stored original card binding together. */
export interface VerifiedPlatformLegacyCardResolution {
  recordId: string;
  eventId: string;
  serverActionId: string;
  messageId: string;
  recipientOpenId: string;
  decision: 'approved' | 'rejected';
  choice: 'comprehensive' | 'building_self' | 'reject';
  /** Written purchase method; the resolution marks the original card with this method. */
  purchaseMethod?: PurchaseWorkflowMethod;
  actorDisplayName: string;
  subjectDisplayName: string;
  processedAt: string;
}
