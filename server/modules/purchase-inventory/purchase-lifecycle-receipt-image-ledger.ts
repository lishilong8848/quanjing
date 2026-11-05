import type { LifecycleReceiptImageBinding, LifecycleReceiptImageEventKeys, LifecycleReceiptImageIntent } from './purchase-lifecycle-receipt-image-binding';

/** Pure data only. The caller must authenticate event snapshots, authorize the
 * actor, hold the existing purchase ledger lock, and atomically persist the
 * returned whole ledger with business and card-refresh state. */
export type ReceiptImageIntentEntry = LifecycleReceiptImageIntent & { state:'open'|'bound'|'completed'|'cancelled'; taskId:string };
export type ReceiptImageTask = { taskId:string; intentId:string; messageFingerprint:string; payloadFingerprint:string; imageMessageId:string; imageKey:string; state:'ready'|'dispatching'|'uploaded'|'completed'|'manual_reconciliation'; dispatchStartedAtMs:number; leaseToken:string; leaseStartedAtMs:number; leaseUntilMs:number; fileToken:string };
export type ReceiptImageEvent = { eventFingerprint:string; messageFingerprint:string; payloadFingerprint:string; taskId:string };
export type ReceiptImageLedger = { version:1; intents:ReceiptImageIntentEntry[]; events:ReceiptImageEvent[]; tasks:ReceiptImageTask[] };
const hash=(s:unknown):s is string=>typeof s==='string' && /^[a-f0-9]{64}$/.test(s);
const id=(s:unknown):s is string=>typeof s==='string' && /^[A-Za-z0-9_:-]{1,256}$/.test(s);
const pref=(s:unknown,p:string):s is string=>id(s) && s.startsWith(p) && s.length>p.length;
const timestamp=(n:unknown):n is number=>Number.isSafeInteger(n) && Number(n)>=1_000_000_000_000;
const shape=(v:unknown,keys:string[]):v is Record<string,any>=>!!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const fail=():never=>{throw new Error('采购签收图片账本损坏或身份不一致');};
const intentKeys=['id','appId','actorOpenId','chatId','approvalBatchId','executionRecordId','cardMessageId','cardRevision','materialType','flowVersion','createdAtMs','expiresAtMs','state','taskId'];
const taskKeys=['taskId','intentId','messageFingerprint','payloadFingerprint','imageMessageId','imageKey','state','dispatchStartedAtMs','leaseToken','leaseStartedAtMs','leaseUntilMs','fileToken'];
const eventKeys=['eventFingerprint','messageFingerprint','payloadFingerprint','taskId'];
function checkIntent(value:unknown): value is ReceiptImageIntentEntry {
  if(!shape(value,intentKeys))return false;
  return id(value.id) && value.id.length>=16 && pref(value.appId,'cli_') && pref(value.actorOpenId,'ou_') && pref(value.chatId,'oc_') && id(value.approvalBatchId) && value.approvalBatchId.length>=8 && pref(value.executionRecordId,'rec') && pref(value.cardMessageId,'om_') && Number.isSafeInteger(value.cardRevision) && value.cardRevision>0 && ['receipt_photo','invoice'].includes(value.materialType) && value.flowVersion==='lifecycle_v1' && timestamp(value.createdAtMs) && timestamp(value.expiresAtMs) && value.expiresAtMs>value.createdAtMs && value.expiresAtMs-value.createdAtMs<=600000 && ['open','bound','completed','cancelled'].includes(value.state) && (value.state==='open'||value.state==='cancelled' ? value.taskId==='' : id(value.taskId));
}
function checkTask(value:unknown): value is ReceiptImageTask {
  if(!shape(value,taskKeys))return false;
  const state=value.state, token=value.fileToken, leased=value.leaseToken!=='';
  return id(value.taskId) && id(value.intentId) && hash(value.messageFingerprint) && hash(value.payloadFingerprint) && pref(value.imageMessageId,'om_') && id(value.imageKey) && ['ready','dispatching','uploaded','completed','manual_reconciliation'].includes(state) && (state==='ready' ? value.dispatchStartedAtMs===0 : timestamp(value.dispatchStartedAtMs)) && (value.leaseToken==='' || id(value.leaseToken)) && Number.isSafeInteger(value.leaseStartedAtMs) && Number.isSafeInteger(value.leaseUntilMs) && (leased ? timestamp(value.leaseStartedAtMs) && timestamp(value.leaseUntilMs) && value.leaseUntilMs>value.leaseStartedAtMs && value.leaseUntilMs-value.leaseStartedAtMs<=600000 : value.leaseStartedAtMs===0 && value.leaseUntilMs===0) && (state==='uploaded'||state==='completed' ? typeof token==='string' && /^[A-Za-z0-9_-]{1,256}$/.test(token) : token==='') && (state!=='completed' || !leased);
}
function checkEvent(value:unknown): value is ReceiptImageEvent { return shape(value,eventKeys) && hash(value.eventFingerprint) && hash(value.messageFingerprint) && hash(value.payloadFingerprint) && id(value.taskId); }

export function normalizeReceiptImageLedger(value:unknown):ReceiptImageLedger {
  if(!shape(value,['version','intents','events','tasks']) || value.version!==1 || !Array.isArray(value.intents) || !Array.isArray(value.events) || !Array.isArray(value.tasks) || value.intents.length>1000 || value.tasks.length>1000 || value.events.length>5000 || !value.intents.every(checkIntent) || !value.tasks.every(checkTask) || !value.events.every(checkEvent))return fail();
  const ledger=value as ReceiptImageLedger, intentIds=new Set<string>(),taskIds=new Set<string>(),eventIds=new Set<string>();
  for(const intent of ledger.intents){if(intentIds.has(intent.id))return fail();intentIds.add(intent.id);}
  for(const task of ledger.tasks){if(taskIds.has(task.taskId))return fail();taskIds.add(task.taskId);const intent=ledger.intents.find(row=>row.id===task.intentId);if(!intent || intent.taskId!==task.taskId || (task.state==='completed' ? intent.state!=='completed' : intent.state!=='bound'))return fail();}
  for(const intent of ledger.intents)if((intent.state==='bound'||intent.state==='completed') && !taskIds.has(intent.taskId))return fail();
  for(const event of ledger.events){if(eventIds.has(event.eventFingerprint))return fail();eventIds.add(event.eventFingerprint);const task=ledger.tasks.find(row=>row.taskId===event.taskId);if(!task || task.messageFingerprint!==event.messageFingerprint || task.payloadFingerprint!==event.payloadFingerprint)return fail();}
  for(const task of ledger.tasks)if(!ledger.events.some(event=>event.taskId===task.taskId))return fail();
  const messages=new Map<string,string>();for(const task of ledger.tasks){const old=messages.get(task.messageFingerprint);if(old && old!==task.taskId)return fail();messages.set(task.messageFingerprint,task.taskId);}
  return structuredClone(ledger);
}

/** Lookup only after extractVerifiedLifecycleReceiptImage; never trust request keys. */
export function findReceiptImageReplay(value:unknown, verified:LifecycleReceiptImageEventKeys): ReceiptImageTask | null {
  const ledger=normalizeReceiptImageLedger(value);
  if(!verified || !hash(verified.eventFingerprint) || !hash(verified.messageFingerprint) || !hash(verified.payloadFingerprint))return fail();
  const event=ledger.events.find(row=>row.eventFingerprint===verified.eventFingerprint);
  const task=ledger.tasks.find(row=>row.messageFingerprint===verified.messageFingerprint);
  if(event && (event.messageFingerprint!==verified.messageFingerprint || event.payloadFingerprint!==verified.payloadFingerprint || !task || event.taskId!==task.taskId))return fail();
  if(task && task.payloadFingerprint!==verified.payloadFingerprint)return fail();
  return task ? structuredClone(task) : null;
}

/** Called with a verified event before checking intent expiry. A new event ID
 * for an already accepted image must be saved in the same locked transaction. */
export function recordReceiptImageReplay(value:unknown,verified:LifecycleReceiptImageEventKeys):{ledger:ReceiptImageLedger;task:ReceiptImageTask}|null {
  const ledger=normalizeReceiptImageLedger(value),task=findReceiptImageReplay(ledger,verified);
  if(!task)return null;
  if(!ledger.events.some(row=>row.eventFingerprint===verified.eventFingerprint))ledger.events.push({eventFingerprint:verified.eventFingerprint,messageFingerprint:verified.messageFingerprint,payloadFingerprint:verified.payloadFingerprint,taskId:task.taskId});
  return {ledger:normalizeReceiptImageLedger(ledger),task};
}

/** The binding must first be produced by matchVerifiedLifecycleReceiptImage under
 * the same lock. Duplicate events return the same task; a new event ID for the
 * same image is also persisted so later conflicting reuse cannot pass. */
export function bindReceiptImage(value:unknown,binding:LifecycleReceiptImageBinding,taskId:string):{ledger:ReceiptImageLedger;task:ReceiptImageTask;created:boolean} {
  const ledger=normalizeReceiptImageLedger(value), existing=findReceiptImageReplay(ledger,binding);
  if(existing){
    if(!ledger.events.some(row=>row.eventFingerprint===binding.eventFingerprint))ledger.events.push({eventFingerprint:binding.eventFingerprint,messageFingerprint:binding.messageFingerprint,payloadFingerprint:binding.payloadFingerprint,taskId:existing.taskId});
    return {ledger:normalizeReceiptImageLedger(ledger),task:existing,created:false};
  }
  if(!id(taskId)||ledger.tasks.some(row=>row.taskId===taskId))return fail();
  const intent=ledger.intents.find(row=>row.id===binding.intent.id);
  if(!intent || intent.state!=='open')return fail();
  const {state:_state,taskId:_taskId,...original}=intent;
  if(intentKeys.filter(key=>key!=='state' && key!=='taskId').some(key=>(original as Record<string,unknown>)[key] !== (binding.intent as unknown as Record<string,unknown>)[key]))return fail();
  const task:ReceiptImageTask={taskId,intentId:intent.id,messageFingerprint:binding.messageFingerprint,payloadFingerprint:binding.payloadFingerprint,imageMessageId:binding.event.imageMessageId,imageKey:binding.event.imageKey,state:'ready',dispatchStartedAtMs:0,leaseToken:'',leaseStartedAtMs:0,leaseUntilMs:0,fileToken:''};
  intent.state='bound';intent.taskId=taskId;ledger.tasks.push(task);ledger.events.push({eventFingerprint:binding.eventFingerprint,messageFingerprint:binding.messageFingerprint,payloadFingerprint:binding.payloadFingerprint,taskId});
  return {ledger:normalizeReceiptImageLedger(ledger),task:structuredClone(task),created:true};
}

/** Called under the existing store lock; the caller persists the returned ledger
 * before releasing the lock. Expired dispatching tasks are never reset to ready. */
export function leaseReceiptImageTask(value:unknown,taskId:string,leaseToken:string,nowMs:number,leaseMs:number):{ledger:ReceiptImageLedger;task:ReceiptImageTask} {
  const ledger=normalizeReceiptImageLedger(value),task=ledger.tasks.find(row=>row.taskId===taskId);
  if(!task || !timestamp(nowMs) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken) || !Number.isSafeInteger(leaseMs) || leaseMs<1000 || leaseMs>600000 || !Number.isSafeInteger(nowMs+leaseMs) || task.state==='completed' || task.state==='manual_reconciliation')return fail();
  if(task.leaseToken && (nowMs<task.leaseStartedAtMs || nowMs<task.leaseUntilMs || task.leaseToken===leaseToken))return fail();
  task.leaseToken=leaseToken;task.leaseStartedAtMs=nowMs;task.leaseUntilMs=nowMs+leaseMs;
  return {ledger:normalizeReceiptImageLedger(ledger),task:structuredClone(task)};
}

/** A valid lease does not itself authorize the action; recheck business and
 * app/card state under the same lock before external dispatch or commit. */
export function assertReceiptImageLease(value:unknown,taskId:string,leaseToken:string,nowMs:number):ReceiptImageTask {
  const task=normalizeReceiptImageLedger(value).tasks.find(row=>row.taskId===taskId);
  if(!task || !timestamp(nowMs) || !task.leaseToken || task.leaseToken!==leaseToken || nowMs<task.leaseStartedAtMs || nowMs>=task.leaseUntilMs)return fail();
  return structuredClone(task);
}

/** Must run after the store verifies its current lease under the same lock. A
 * dispatching or uncertain task can never be made ready again automatically. */
export function transitionReceiptImageTask(value:unknown,taskId:string,operation:'dispatch'|'uploaded'|'uncertain'|'complete',fileToken='',nowMs=Date.now()):ReceiptImageLedger {
  const ledger=normalizeReceiptImageLedger(value),task=ledger.tasks.find(row=>row.taskId===taskId);
  if(!task)return fail();
  if(operation==='dispatch' && task.state==='ready' && !fileToken && timestamp(nowMs)){task.state='dispatching';task.dispatchStartedAtMs=nowMs;}
  else if(operation==='uploaded' && task.state==='dispatching' && /^[A-Za-z0-9_-]{1,256}$/.test(fileToken)){task.state='uploaded';task.fileToken=fileToken;}
  else if(operation==='uncertain' && task.state==='dispatching' && !fileToken)task.state='manual_reconciliation';
  else if(operation==='complete' && task.state==='uploaded' && !fileToken){task.state='completed';task.leaseToken='';task.leaseStartedAtMs=0;task.leaseUntilMs=0;const intent=ledger.intents.find(row=>row.id===task.intentId);if(!intent)return fail();intent.state='completed';}
  else if(operation==='uploaded' && task.state==='uploaded' && fileToken===task.fileToken) return ledger;
  else if(operation==='complete' && task.state==='completed' && !fileToken) return ledger;
  else return fail();
  return normalizeReceiptImageLedger(ledger);
}
