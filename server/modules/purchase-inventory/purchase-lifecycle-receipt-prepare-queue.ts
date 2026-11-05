import { createHash } from 'node:crypto';

/** Pure queue state. Only trusted card callbacks may be passed to acceptance;
 * current identity, permission, card mapping and generation must be checked by
 * the purchase store under its lock before the returned state is persisted. */
export type ReceiptPrepareIdentity={appId:string;eventId:string;actorOpenId:string;chatId:string;cardMessageId:string;approvalBatchId:string;executionRecordId:string;cardRevision:number;materialType:'receipt_photo'|'invoice';flowVersion:'lifecycle_v1'};
export type ReceiptPrepareTask={taskId:string;fingerprint:string;identity:ReceiptPrepareIdentity;state:'pending'|'processing'|'completed'|'failed';createdAtMs:number;updatedAtMs:number;leaseToken:string;leaseUntilMs:number;attempts:number;intentId:string;failure:''|'chat_unverified'|'stale'|'not_authorized'|'internal_error';refreshPending:boolean};
export type ReceiptPrepareQueue={version:1;tasks:ReceiptPrepareTask[]};
const fail=():never=>{throw new Error('签收图片准备任务无法核对');};
const obj=(v:unknown):v is Record<string,any>=>!!v && typeof v==='object' && !Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>obj(v) && Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const valid=(v:unknown,pattern:RegExp):v is string=>typeof v==='string' && pattern.test(v);
const time=(v:unknown):v is number=>Number.isSafeInteger(v) && Number(v)>=1_000_000_000_000;
const id=/^[A-Za-z0-9_:-]{1,256}$/;
const dataKeys=['appId','eventId','actorOpenId','chatId','cardMessageId','approvalBatchId','executionRecordId','cardRevision','materialType','flowVersion'];
const taskKeys=['taskId','fingerprint','identity','state','createdAtMs','updatedAtMs','leaseToken','leaseUntilMs','attempts','intentId','failure','refreshPending'];
function assertIdentity(v:unknown):asserts v is ReceiptPrepareIdentity {
  if(!exact(v,dataKeys) || !valid(v.appId,/^cli_[A-Za-z0-9_-]{1,124}$/) || !valid(v.eventId,id) || !valid(v.actorOpenId,/^ou_[A-Za-z0-9_-]{1,128}$/) || !valid(v.chatId,/^oc_[A-Za-z0-9_-]{1,252}$/) || !valid(v.cardMessageId,/^om_[A-Za-z0-9_-]{1,252}$/) || !valid(v.approvalBatchId,/^[A-Za-z0-9_-]{8,160}$/) || !valid(v.executionRecordId,/^rec[A-Za-z0-9_-]{1,100}$/) || !Number.isSafeInteger(v.cardRevision) || v.cardRevision<1 || !['receipt_photo','invoice'].includes(v.materialType) || v.flowVersion!=='lifecycle_v1')fail();
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const taskId=(v:ReceiptPrepareIdentity)=>`receipt-prepare-${hash(['receipt-prepare-event-v1',v.appId,v.eventId])}`;
const fingerprint=(v:ReceiptPrepareIdentity)=>hash(['receipt-prepare-payload-v1',...dataKeys.map(key=>(v as unknown as Record<string,unknown>)[key])]);
export function normalizeReceiptPrepareQueue(value:unknown):ReceiptPrepareQueue {
  if(!exact(value,['version','tasks'])||value.version!==1||!Array.isArray(value.tasks)||value.tasks.length>5000)return fail();
  const ids=new Set<string>();
  for(const raw of value.tasks){
    if(!exact(raw,taskKeys))return fail();assertIdentity(raw.identity);
    if(raw.taskId!==taskId(raw.identity)||raw.fingerprint!==fingerprint(raw.identity)||ids.has(raw.taskId)||!time(raw.createdAtMs)||!time(raw.updatedAtMs)||raw.updatedAtMs<raw.createdAtMs||!Number.isSafeInteger(raw.attempts)||raw.attempts<0||raw.attempts>100||typeof raw.refreshPending!=='boolean')return fail();
    ids.add(raw.taskId);
    if(raw.state==='pending') { if(raw.leaseToken!==''||raw.leaseUntilMs!==0||raw.intentId!==''||raw.failure!==''||raw.refreshPending)return fail(); }
    else if(raw.state==='processing') {if(!valid(raw.leaseToken,id)||!time(raw.leaseUntilMs)||raw.leaseUntilMs<=raw.updatedAtMs||raw.intentId!==''||raw.failure!==''||raw.refreshPending)return fail();}
    else if(raw.state==='completed') {if(raw.leaseToken!==''||raw.leaseUntilMs!==0||!valid(raw.intentId,/^[A-Za-z0-9_-]{16,128}$/)||raw.failure!=='')return fail();}
    else if(raw.state==='failed') {if(raw.leaseToken!==''||raw.leaseUntilMs!==0||raw.intentId!==''||!['chat_unverified','stale','not_authorized','internal_error'].includes(raw.failure))return fail();}
    else return fail();
  }
  return structuredClone(value as ReceiptPrepareQueue);
}

/** Caller persists the result before acknowledging the card callback. */
export function acceptReceiptPrepare(value:unknown,identity:ReceiptPrepareIdentity,now:number):{queue:ReceiptPrepareQueue;task:ReceiptPrepareTask;created:boolean} {
  assertIdentity(identity);if(!time(now))return fail();const queue=normalizeReceiptPrepareQueue(value),key=taskId(identity),found=queue.tasks.find(t=>t.taskId===key);
  if(found){if(found.fingerprint!==fingerprint(identity))return fail();return {queue,task:structuredClone(found),created:false};}
  const task:ReceiptPrepareTask={taskId:key,fingerprint:fingerprint(identity),identity:structuredClone(identity),state:'pending',createdAtMs:now,updatedAtMs:now,leaseToken:'',leaseUntilMs:0,attempts:0,intentId:'',failure:'',refreshPending:false};
  queue.tasks.push(task);return {queue:normalizeReceiptPrepareQueue(queue),task:structuredClone(task),created:true};
}

/** Lease and state changes are plans; store writes, authorization, intent creation
 * and notification/outbox enqueue must be one transaction under its lock. */
export function leaseReceiptPrepare(value:unknown,key:string,leaseToken:string,now:number,leaseMs:number):ReceiptPrepareQueue {
  const queue=normalizeReceiptPrepareQueue(value),task=queue.tasks.find(t=>t.taskId===key);
  if(!task||!time(now)||!valid(leaseToken,id)||!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>600000||now<task.updatedAtMs||!(task.state==='pending'||task.state==='processing'&&task.leaseUntilMs<=now))return fail();
  task.state='processing';task.leaseToken=leaseToken;task.leaseUntilMs=now+leaseMs;task.updatedAtMs=now;task.attempts++;
  return normalizeReceiptPrepareQueue(queue);
}
export function finishReceiptPrepare(value:unknown,key:string,leaseToken:string,now:number,result:{intentId:string}|{failure:Exclude<ReceiptPrepareTask['failure'],''>}):ReceiptPrepareQueue {
  const queue=normalizeReceiptPrepareQueue(value),task=queue.tasks.find(t=>t.taskId===key);
  if(!task||task.state!=='processing'||task.leaseToken!==leaseToken||!time(now)||now<task.updatedAtMs||now>=task.leaseUntilMs||!obj(result))return fail();
  const candidate=result as Record<string,unknown>;
  if(exact(result,['intentId']) && valid(candidate.intentId,/^[A-Za-z0-9_-]{16,128}$/)){task.state='completed';task.intentId=candidate.intentId;}
  else if(exact(result,['failure']) && typeof candidate.failure==='string' && ['chat_unverified','stale','not_authorized','internal_error'].includes(candidate.failure)){task.state='failed';task.failure=candidate.failure as Exclude<ReceiptPrepareTask['failure'],''>;}
  else return fail();
  task.updatedAtMs=now;task.leaseToken='';task.leaseUntilMs=0;task.refreshPending=true;
  return normalizeReceiptPrepareQueue(queue);
}
