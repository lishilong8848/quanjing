import { createHash } from 'node:crypto';
import type { PurchaseManagerApprovalCardEntry, PurchaseManagerApprovalActionEntry } from './purchase-workflow.store';

export interface PurchaseSingleManagerHandover {
  mutationId: string;
  sourceVersion: string;
  sourcePersonRecordId: string;
  targetOpenId: string;
  targetPersonRecordId: string;
  terminalNotificationKey: string;
  targetNotificationKey: string;
}
export interface PurchaseSingleManagerHandoverInput {
  recordId: string;
  sourceOpenId: string;
  sourcePersonRecordId: string;
  targetOpenId: string;
  targetPersonRecordId: string;
  expectedVersion: string;
  mutationId: string;
}
export function singleManagerCardVersion(card: PurchaseManagerApprovalCardEntry): string {
  return digest([card.key,card.messageId,card.supersededMessageIds,card.recipientOpenId,card.sourceNotificationKey,card.cardContext,card.state,card.choice,card.rejectionReasonDraft,card.actionEventId,card.updatedAt]);
}
export function singleManagerReceiptVersion(card: PurchaseManagerApprovalCardEntry): string { return digest([card.key,card.personnelHandover]); }
export function singleManagerAcceptedVersion(card:PurchaseManagerApprovalCardEntry,action:PurchaseManagerApprovalActionEntry):string{return digest([card.key,action.recordId,action.eventId,action.actorOpenId,action.messageId,action.choice,action.rejectionReason]);}
export function validSingleManagerHandover(value: unknown): value is PurchaseSingleManagerHandover {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>;
  return Object.keys(row).sort().join(',')==='mutationId,sourcePersonRecordId,sourceVersion,targetNotificationKey,targetOpenId,targetPersonRecordId,terminalNotificationKey' &&
    typeof row.mutationId==='string'&&/^handover-[a-f0-9]{64}$/.test(row.mutationId)&&typeof row.sourceVersion==='string'&&/^[a-f0-9]{64}$/.test(row.sourceVersion)&&
    [row.sourcePersonRecordId,row.targetPersonRecordId].every(id=>typeof id==='string'&&/^rec[A-Za-z0-9_]{1,97}$/.test(id))&&typeof row.targetOpenId==='string'&&/^ou_[A-Za-z0-9_-]{1,124}$/.test(row.targetOpenId)&&
    [row.terminalNotificationKey,row.targetNotificationKey].every(key=>typeof key==='string'&&key.length>0&&key.length<=768&&!/[\u0000-\u001f\u007f]/u.test(key))&&row.terminalNotificationKey!==row.targetNotificationKey;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
