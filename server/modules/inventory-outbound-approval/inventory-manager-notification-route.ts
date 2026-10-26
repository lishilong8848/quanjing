import {BadRequestException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {InventoryManagerNotificationHandover,InventoryManagerNotificationHandoverInput,InventoryOutboundApprovalApprover,InventoryOutboundApprovalEntry,InventoryOutboundApprovalSnapshot} from './inventory-outbound-approval.types';

export function normalizeInventoryManagerNotificationInput(value:InventoryManagerNotificationHandoverInput):InventoryManagerNotificationHandoverInput {
  if(!value||!value.target||!/^rec[A-Za-z0-9_]+$/.test(value.recordId)||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1||value.expectedVersion>=Number.MAX_SAFE_INTEGER||!/^handover-[a-f0-9]{64}$/.test(value.mutationId)||!/^rec[A-Za-z0-9_]+$/.test(value.dutyRecordId)||!/^rec[A-Za-z0-9_]+$/.test(value.sourcePersonRecordId)||!/^rec[A-Za-z0-9_]+$/.test(value.target.personRecordId)||value.sourcePersonRecordId===value.target.personRecordId||!/^ou_[A-Za-z0-9_-]+$/.test(value.sourceOpenId)||!/^ou_[A-Za-z0-9_-]+$/.test(value.target.openId)||value.sourceOpenId===value.target.openId||typeof value.target.name!=='string'||!value.target.name.trim()||value.target.name.trim().length>256||/[\u0000-\u001f\u007f]/u.test(value.target.name)||!Number.isSafeInteger(value.expectedGeneration)||value.expectedGeneration<1||value.expectedGeneration>=Number.MAX_SAFE_INTEGER)throw new BadRequestException('库房知会人员、职责或代际无效');
  return {recordId:value.recordId,expectedVersion:value.expectedVersion,mutationId:value.mutationId,dutyRecordId:value.dutyRecordId,sourcePersonRecordId:value.sourcePersonRecordId,sourceOpenId:value.sourceOpenId,target:{personRecordId:value.target.personRecordId,openId:value.target.openId,name:value.target.name.trim()},expectedGeneration:value.expectedGeneration};
}
export const inventoryManagerNotificationFingerprint=(input:InventoryManagerNotificationHandoverInput)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function inventoryManagerNotificationGeneration(entry:Pick<InventoryOutboundApprovalEntry,'managerNotificationHandovers'>):number {
  return entry.managerNotificationHandovers?.at(-1)?.targetGeneration||1;
}
export function assertInventoryManagerNotificationCapacity(snapshot: InventoryOutboundApprovalSnapshot, routes: InventoryManagerNotificationHandover[]): void {
  const recipients = new Map<string, string>();
  for (const person of [{ openId: snapshot.applicantOpenId, name: snapshot.applicantName }, ...snapshot.approvers,
    ...(snapshot.managerRecipients || []), ...routes.map(route => route.target)]) {
    if (!recipients.has(person.openId)) recipients.set(person.openId, person.name);
  }
  const maximumLedger = { schemaVersion: 2, recordId: snapshot.recordId, version: snapshot.version,
    decisionEventId: 'e'.repeat(256), decisionAction: 'approve', managerNotificationHandovers: routes,
    deliveries: [...recipients].map(([recipientOpenId, recipientName]) => ({ recipientOpenId, recipientName,
      deliveryUuid: '0'.repeat(36), messageId: `om_${'m'.repeat(252)}` })) };
  if (Buffer.byteLength(JSON.stringify(maximumLedger), 'utf8') > 30 * 1024) {
    throw new BadRequestException('库房知会交接历史超过外部台账容量，请先归档核对');
  }
}
export function inventoryManagerNotificationState(entry: InventoryOutboundApprovalEntry, sourceOpenId: string): 'pending' | 'reconcile' | 'terminal' {
  const result = entry.resultNotifications.find(work => work.recipientOpenId === sourceOpenId);
  const patch = entry.cardPatches.find(work => work.recipientOpenId === sourceOpenId);
  if (result?.status === 'completed' || patch?.status === 'completed') return 'terminal';
  if (entry.registration.status !== 'ready' || [...entry.resultNotifications, ...(patch ? [patch] : [])].some(work =>
    work.status === 'running' || work.status === 'error' && work.attemptCount > 0)) return 'reconcile';
  return 'pending';
}
export function inventoryManagerNotificationRecipients(entry:Pick<InventoryOutboundApprovalEntry,'snapshot'|'managerNotificationHandovers'>):Array<InventoryOutboundApprovalApprover & {personRecordId?:string}> {
  let people:Array<InventoryOutboundApprovalApprover & {personRecordId?:string}>=(entry.snapshot.managerRecipients||[]).map(person=>({...person}));
  for(const route of entry.managerNotificationHandovers||[])people=[...new Map(people.map(person=>person.openId===route.sourceOpenId?route.target:person).map(person=>[person.openId,{...person}] as const)).values()];
  return people;
}
export function normalizeInventoryManagerNotificationHandovers(value:unknown,snapshot:InventoryOutboundApprovalSnapshot):InventoryManagerNotificationHandover[] {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>100)throw new Error('库房知会交接账本结构无效');
  const result:InventoryManagerNotificationHandover[]=[],mutations=new Set<string>();
  for(const row of value){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('库房知会交接记录无效');
    const input=normalizeInventoryManagerNotificationInput(row as InventoryManagerNotificationHandoverInput),fingerprint=inventoryManagerNotificationFingerprint(input),source=inventoryManagerNotificationRecipients({snapshot,managerNotificationHandovers:result}).find(person=>person.openId===input.sourceOpenId);
    if(Object.keys(row).sort().join(',')!=='acceptedAt,dutyRecordId,expectedGeneration,expectedVersion,fingerprint,mutationId,recordId,sourceOpenId,sourcePersonRecordId,target,targetGeneration'||input.recordId!==snapshot.recordId||input.expectedVersion!==snapshot.version||input.expectedGeneration!==result.length+1||row.targetGeneration!==input.expectedGeneration+1||row.fingerprint!==fingerprint||typeof row.acceptedAt!=='string'||!Number.isFinite(Date.parse(row.acceptedAt))||mutations.has(input.mutationId)||!source||source.personRecordId&&source.personRecordId!==input.sourcePersonRecordId)throw new Error('库房知会交接指纹、人员或代际不一致');
    mutations.add(input.mutationId);result.push({...input,targetGeneration:input.expectedGeneration+1,fingerprint,acceptedAt:row.acceptedAt});
  }
  return result;
}
