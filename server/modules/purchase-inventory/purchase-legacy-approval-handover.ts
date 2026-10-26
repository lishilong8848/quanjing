import { createHash } from 'node:crypto';
import type { PurchaseWorkflowNotificationEntry, PurchaseWorkflowCardActionEntry } from './purchase-workflow.store';
import type { PurchaseAuthorityTarget } from './purchase-authority-target';
import type { PurchaseSingleManagerHandoverInput } from './purchase-single-handover';

export interface PurchaseLegacyApprovalHandoverInput extends PurchaseSingleManagerHandoverInput {
  sourceNotificationKey: string;
  scope: PurchaseAuthorityTarget;
}
export function legacyApprovalVersion(source: PurchaseWorkflowNotificationEntry, scope: PurchaseAuthorityTarget): string {
  return digest([source.key, source.recordId, source.recipientOpenId, source.messageId, source.cardContext, source.status, source.updatedAt, scope]);
}
export function legacyApprovalReceiptVersion(source: PurchaseWorkflowNotificationEntry): string { return digest([source.key, source.approvalHandover, source.approvalAuthority]); }
export function legacyApprovalAcceptedVersion(source: PurchaseWorkflowNotificationEntry, action: PurchaseWorkflowCardActionEntry): string {
  return digest([source.key, action.key, action.eventId, action.recordId, action.action, action.actorOpenId]);
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
