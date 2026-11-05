import { ForbiddenException } from '@nestjs/common';
import { canPerformBusinessAction } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import { assertPurchaseInboundExecutionScope } from '../inventory-management/inventory-access-policy';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import { resolvePurchaseLifecycleStage } from './purchase-lifecycle-projection';
import { planPurchaseReplica, type PurchaseReplica, type PurchaseReplicaIdentity } from './purchase-lifecycle-replica';
import type { PurchaseManagerApprovalBatchEntry } from './purchase-workflow.store';

export type PurchaseLifecycleOperation = 'approve' | 'order' | 'receive' | 'inbound';

/**
 * All fields except callback must come from current server-side sources. Resolve
 * them within the same ledger critical section as the actual business claim.
 * This does not persist a decision or implement event idempotency.
 */
export interface PurchaseLifecycleActionAuthority {
  appId: string;
  callback: {
    appId: string;
    batchId: string;
    recordId: string;
    operatorOpenId: string;
    messageId: string;
    action: PurchaseLifecycleOperation;
    cardRevision: number;
  };
  replica: PurchaseReplica;
  batch: PurchaseManagerApprovalBatchEntry;
  record: PurchaseWorkflowRecord;
  identity: {
    openId: string;
    active: boolean;
    principal: AccessPrincipal | null;
  };
  /** Current verified duty routing; null means unavailable and always denies. */
  currentDuty: {
    managers: readonly string[];
    purchasers: readonly string[];
    warehouse: readonly string[];
  } | null;
  /** Observers get full read-only content but never an actionable copy. */
  replicaPurpose: 'business' | 'observer';
  trustedNowMs: number;
}

const reject = (): never => { throw new ForbiddenException('采购卡片身份、权限或当前流程状态不符'); };
const within = (list: readonly string[], id: string): boolean => list.filter(value => value === id).length === 1;

/** Must be invoked again under the workflow lock immediately before each claim. */
export function assertPurchaseLifecycleAction(input: PurchaseLifecycleActionAuthority): void {
  const { callback: c, replica, batch, record, identity, currentDuty } = input;
  if ((batch as PurchaseManagerApprovalBatchEntry & { flowVersion?: string }).flowVersion !== 'lifecycle_v1' ||
      !input.appId || c.appId !== input.appId || c.batchId !== batch.approvalBatchId ||
      c.operatorOpenId !== identity.openId || identity.active !== true || !identity.principal ||
      identity.principal.requiresPasswordChange || input.replicaPurpose !== 'business' ||
      c.recordId !== record.recordId || !Number.isSafeInteger(c.cardRevision) || c.cardRevision < 1 ||
      c.cardRevision !== replica.appliedRevision || replica.state !== 'delivered' ||
      replica.appId !== input.appId || replica.batchId !== c.batchId ||
      replica.recipientOpenId !== c.operatorOpenId || replica.messageId !== c.messageId ||
      !Number.isSafeInteger(input.trustedNowMs) || input.trustedNowMs < replica.sentAtMs ||
      input.trustedNowMs - replica.sentAtMs > 14 * 24 * 60 * 60 * 1000) reject();
  const replicaIdentity: PurchaseReplicaIdentity = { appId: input.appId, batchId: c.batchId, recipientOpenId: c.operatorOpenId };
  try {
    const plan = planPurchaseReplica(replicaIdentity, replica, c.cardRevision, true, input.trustedNowMs);
    if (plan.action !== 'none' || plan.reason !== 'current') reject();
  } catch { reject(); }
  if (batch.recordIds.filter(id => id === c.recordId).length !== 1) reject();
  const items = batch.items.filter(item => item.executionRecordId === c.recordId);
  if (items.length !== 1) reject();
  const item = items[0];
  const target = purchaseAuthorityTarget(record);
  if (!target) reject();
  if (item.authorityTarget && (item.authorityTarget.building !== target.building || item.authorityTarget.specialty !== target.specialty)) reject();
  const stage = resolvePurchaseLifecycleStage(record.status);
  const principal = identity.principal;
  if (c.action === 'approve') {
    if (stage !== 'application' || !['active', 'reject_editing'].includes(batch.state) || item.status !== 'pending' ||
        !currentDuty || !within(currentDuty.managers, c.operatorOpenId) ||
        !batch.managerDeliveries || batch.managerDeliveries.filter(d => d.recipientOpenId === c.operatorOpenId).length !== 1 ||
        !canPerformBusinessAction(principal, { module: 'purchase', action: 'approve', ...target })) reject();
    return;
  }
  if (c.action === 'order') {
    if (stage !== 'ordering' || item.status !== 'approved' || item.purchaserOpenId !== c.operatorOpenId ||
        record.purchaserOpenId !== c.operatorOpenId || !currentDuty || !within(currentDuty.purchasers, c.operatorOpenId) ||
        !canPerformBusinessAction(principal, { module: 'purchase', action: 'order', ...target })) reject();
    return;
  }
  if (c.action === 'receive') {
    if (stage !== 'receipt' || item.status !== 'approved' || batch.requesterOpenId !== c.operatorOpenId ||
        record.requesterOpenId !== c.operatorOpenId ||
        !canPerformBusinessAction(principal, { module: 'purchase', action: 'receive', ...target })) reject();
    return;
  }
  if (c.action === 'inbound') {
    if (stage !== 'inbound' || item.status !== 'approved' || !currentDuty || !within(currentDuty.warehouse, c.operatorOpenId) ||
        !canPerformBusinessAction(principal, { module: 'inventory', action: 'confirm', ...target })) reject();
    assertPurchaseInboundExecutionScope(principal, target.building);
    return;
  }
  reject();
}
