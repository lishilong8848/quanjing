import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ContractWorkflowRecord } from './contract-workflow.rules';

export interface ContractPaymentDigestCandidate {dedupeKey:string;record:ContractWorkflowRecord;fallbackRecipients:string[];}
export interface ContractPaymentDigestInput {key:string;candidates:ContractPaymentDigestCandidate[];sourceUrl:string;}
export interface ContractPaymentDigestDispatch {key:string;uuid:string;claimToken:string;receiverOpenId:string;content:Record<string,unknown>;candidateKeys:string[];}
interface DigestMessage extends Omit<ContractPaymentDigestDispatch,'key'|'claimToken'> {claimToken?:string;status:'sending'|'uncertain'|'delivered';firstAttemptAt:string;attempts:number;messageId?:string;}
export interface ContractPaymentDigestJob extends ContractPaymentDigestInput {appId:string;fingerprint:string;createdAt:string;completedAt?:string;messages:Record<string,DigestMessage>;}
export interface ContractPaymentDigestLedger {
  paymentDigests?:Record<string,ContractPaymentDigestJob>;
  deliveries:Record<string,{completedAt:string;messageId:string}>;
  processed:Record<string,{completedAt:string;messageIds:string[]}>;
}
export type ContractPaymentDigestResolver=(candidate:ContractPaymentDigestCandidate)=>string[];
export type ContractPaymentDigestRenderer=(records:ContractWorkflowRecord[],sourceUrl:string)=>Record<string,unknown>;

export function enqueueContractPaymentDigest(ledger:ContractPaymentDigestLedger,value:ContractPaymentDigestInput,appId:string):{job:ContractPaymentDigestJob;changed:boolean} {
  const input=normalize(value),fingerprint=digest([appId,input]),jobs=ledger.paymentDigests || {},prior=jobs[input.key];
  if(prior){if(prior.appId!==appId||prior.fingerprint!==fingerprint)throw new ConflictException('付款汇总重复事件的应用或内容不一致');return {job:structuredClone(prior),changed:false};}
  if(Object.keys(jobs).length>=2000)throw new ConflictException('付款汇总任务台账已满，请核对归档');
  const job:ContractPaymentDigestJob={...input,appId,fingerprint,createdAt:new Date().toISOString(),messages:{}};
  ledger.paymentDigests={...jobs,[input.key]:job};
  return {job:structuredClone(job),changed:true};
}

export function claimContractPaymentDigest(ledger:ContractPaymentDigestLedger,appId:string,resolve:ContractPaymentDigestResolver,render:ContractPaymentDigestRenderer,now:Date,authorizedRetry=false,key?:string):{dispatch?:ContractPaymentDigestDispatch;changed:boolean} {
  let changed=false;
  for(const job of Object.values(ledger.paymentDigests || {})){
    if(job.completedAt || key !== undefined && job.key !== key)continue;
    if(job.appId!==appId)throw new ConflictException('付款汇总所属飞书应用已变化，请核对原任务');
    changed=closeReadyCandidates(ledger,job,resolve)||changed;
    if(job.completedAt)continue;
    for(const message of Object.values(job.messages)){
      if(message.status!=='uncertain'||message.attempts>=(authorizedRetry?20:3)||now.getTime()-Date.parse(message.firstAttemptAt)>=55*60_000||now.getTime()<Date.parse(message.firstAttemptAt))continue;
      const candidates=job.candidates.filter(row=>message.candidateKeys.includes(row.dedupeKey));
      if(!candidates.some(row=>!ledger.processed[row.dedupeKey]&&recipients(resolve,row).includes(message.receiverOpenId))||message.candidateKeys.some(key=>ledger.deliveries[paymentDigestDeliveryKey(key,message.receiverOpenId)]))continue;
      message.status='sending';message.claimToken=randomUUID();message.attempts++;
      return {dispatch:dispatch(job,message),changed:true};
    }
    const byReceiver=new Map<string,ContractPaymentDigestCandidate[]>();
    for(const candidate of job.candidates){
      if(ledger.processed[candidate.dedupeKey])continue;
      for(const receiver of recipients(resolve,candidate)){
        if(ledger.deliveries[paymentDigestDeliveryKey(candidate.dedupeKey,receiver)]||hasUnsettledMessage(ledger,receiver,candidate.dedupeKey))continue;
        byReceiver.set(receiver,[...(byReceiver.get(receiver)||[]),candidate]);
      }
    }
    for(const [receiverOpenId,rows] of byReceiver){
      let selected=rows.slice(0,50),content=render(selected.map(row=>structuredClone(row.record)),job.sourceUrl);
      while(!validCard(content)&&selected.length>1){selected=selected.slice(0,Math.max(1,Math.floor(selected.length/2)));content=render(selected.map(row=>structuredClone(row.record)),job.sourceUrl);}
      if(!validCard(content))throw new BadRequestException('单条付款汇总内容超过消息大小限制，请核对付款计划');
      if(Object.keys(job.messages).length>=2000)throw new ConflictException('付款汇总投递台账已满，请核对原任务');
      const candidateKeys=selected.map(row=>row.dedupeKey),uuid=messageUuid(job,receiverOpenId,candidateKeys,content);
      if(job.messages[uuid])throw new ConflictException('付款汇总投递与原记录不一致，请核对');
      const message:DigestMessage={receiverOpenId,candidateKeys,content:structuredClone(content),uuid,claimToken:randomUUID(),status:'sending',firstAttemptAt:now.toISOString(),attempts:1};
      job.messages[uuid]=message;
      return {dispatch:dispatch(job,message),changed:true};
    }
  }
  return {changed};
}

export function settleContractPaymentDigest(ledger:ContractPaymentDigestLedger,input:ContractPaymentDigestDispatch,messageId:string|null,resolve:ContractPaymentDigestResolver):void {
  const job=ledger.paymentDigests?.[input.key],message=job?.messages[input.uuid];
  if(!job||!message||message.status!=='sending'||message.claimToken!==input.claimToken||digest(dispatch(job,message))!==digest(input))throw new ConflictException('付款汇总投递归属或内容已变化');
  if(messageId!==null&&(!/^om_[A-Za-z0-9_-]+$/.test(messageId)||messageId.length>160))throw new BadRequestException('付款汇总回执无效');
  if(messageId)for(const key of message.candidateKeys){const prior=ledger.deliveries[paymentDigestDeliveryKey(key,message.receiverOpenId)];if(prior&&prior.messageId!==messageId)throw new ConflictException('付款汇总原投递回执冲突，请核对');}
  message.status=messageId?'delivered':'uncertain';delete message.claimToken;
  if(messageId){
    message.messageId=messageId;
    for(const key of message.candidateKeys)ledger.deliveries[paymentDigestDeliveryKey(key,message.receiverOpenId)]={completedAt:new Date().toISOString(),messageId};
    closeReadyCandidates(ledger,job,resolve);
  }
}

export function recoverContractPaymentDigests(ledger:ContractPaymentDigestLedger):boolean {
  let changed=false;
  for(const job of Object.values(ledger.paymentDigests || {}))for(const message of Object.values(job.messages))if(message.status==='sending'){message.status='uncertain';delete message.claimToken;changed=true;}
  return changed;
}

export function validContractPaymentDigests(ledger:ContractPaymentDigestLedger):boolean {
  const jobs=ledger.paymentDigests;if(jobs===undefined)return true;
  if(!jobs||typeof jobs!=='object'||Array.isArray(jobs)||Object.keys(jobs).length>2000)return false;
  try{return Object.entries(jobs).every(([key,job])=>{
    if(!job||job.key!==key||!/^cli_[A-Za-z0-9_]+$/.test(job.appId)||job.fingerprint!==digest([job.appId,normalize(job)])||!Number.isFinite(Date.parse(job.createdAt))||job.completedAt!==undefined&&(!Number.isFinite(Date.parse(job.completedAt))||job.candidates.some(row=>!ledger.processed[row.dedupeKey]))||!job.messages||typeof job.messages!=='object'||Array.isArray(job.messages)||Object.keys(job.messages).length>2000)return false;
    return Object.entries(job.messages).every(([uuid,message])=>message&&uuid===message.uuid&&/^ou_[A-Za-z0-9]+$/.test(message.receiverOpenId)&&Array.isArray(message.candidateKeys)&&message.candidateKeys.length>0&&new Set(message.candidateKeys).size===message.candidateKeys.length&&message.candidateKeys.every(candidate=>job.candidates.some(row=>row.dedupeKey===candidate))&&validCard(message.content)&&uuid===messageUuid(job,message.receiverOpenId,message.candidateKeys,message.content)&&['sending','uncertain','delivered'].includes(message.status)&&Number.isFinite(Date.parse(message.firstAttemptAt))&&Number.isSafeInteger(message.attempts)&&message.attempts>0&&message.attempts<=20&&(message.status!=='sending'||typeof message.claimToken==='string')&&(message.status!=='delivered'||typeof message.messageId==='string'&&/^om_[A-Za-z0-9_-]+$/.test(message.messageId)&&message.candidateKeys.every(candidate=>ledger.deliveries[paymentDigestDeliveryKey(candidate,message.receiverOpenId)]?.messageId===message.messageId)));
  });}catch{return false;}
}

export function paymentDigestDeliveryKey(candidateKey:string,receiverOpenId:string):string {
  return `payment-digest:${candidateKey}:${createHash('sha256').update(receiverOpenId).digest('hex').slice(0,16)}`;
}

function normalize(value:ContractPaymentDigestInput):ContractPaymentDigestInput {
  if(!value||typeof value.key!=='string'||!/^[A-Za-z0-9:_-]{1,256}$/.test(value.key)||!Array.isArray(value.candidates)||!value.candidates.length||value.candidates.length>1000||new Set(value.candidates.map(row=>row?.dedupeKey)).size!==value.candidates.length||typeof value.sourceUrl!=='string'||value.sourceUrl.length>2048||JSON.stringify([value.key,value.candidates,value.sourceUrl]).length>1_000_000)throw new BadRequestException('付款汇总任务无效');
  const url=new URL(value.sourceUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new BadRequestException('付款汇总来源地址无效');
  const candidates=value.candidates.map(row=>{
    const record=row?.record;
    if(!record||record.kind!=='payment'||typeof record.recordId!=='string'||!/^rec[A-Za-z0-9_-]+$/.test(record.recordId)||typeof record.endDate!=='string'||row.dedupeKey!==`payment_due_reminder:${record.recordId}:${record.endDate}`||typeof record.name!=='string'||typeof record.code!=='string'||typeof record.specialty!=='string'||!Number.isFinite(record.amount)||!Array.isArray(record.ownerNames)||record.ownerNames.some(name=>typeof name!=='string')||!Array.isArray(record.ownerOpenIds)||record.ownerOpenIds.some(id=>!/^ou_[A-Za-z0-9]+$/.test(id))||!Array.isArray(row.fallbackRecipients)||row.fallbackRecipients.length>200||row.fallbackRecipients.some(id=>typeof id!=='string'||!/^ou_[A-Za-z0-9]+$/.test(id)))throw new BadRequestException('付款汇总候选记录无效');
    return {dedupeKey:row.dedupeKey,record:structuredClone(record),fallbackRecipients:[...new Set(row.fallbackRecipients)]};
  }).sort((left,right)=>left.dedupeKey.localeCompare(right.dedupeKey));
  return {key:value.key,candidates,sourceUrl:value.sourceUrl};
}
function recipients(resolve:ContractPaymentDigestResolver,candidate:ContractPaymentDigestCandidate):string[] {
  const values=resolve(structuredClone(candidate));if(!Array.isArray(values)||values.length>200||values.some(value=>typeof value!=='string'||!/^ou_[A-Za-z0-9]+$/.test(value)))throw new ConflictException('付款汇总当前岗位人员无效');return [...new Set(values)];
}
function closeReadyCandidates(ledger:ContractPaymentDigestLedger,job:ContractPaymentDigestJob,resolve:ContractPaymentDigestResolver):boolean {
  let changed=false;
  for(const candidate of job.candidates){
    if(ledger.processed[candidate.dedupeKey])continue;
    const current=recipients(resolve,candidate);
    if(current.length&&current.every(receiver=>ledger.deliveries[paymentDigestDeliveryKey(candidate.dedupeKey,receiver)])){
      ledger.processed[candidate.dedupeKey]={completedAt:new Date().toISOString(),messageIds:[...new Set(current.map(receiver=>ledger.deliveries[paymentDigestDeliveryKey(candidate.dedupeKey,receiver)].messageId))]};changed=true;
    }
  }
  if(!job.completedAt&&job.candidates.every(candidate=>ledger.processed[candidate.dedupeKey])){job.completedAt=new Date().toISOString();changed=true;}
  return changed;
}
function hasUnsettledMessage(ledger:ContractPaymentDigestLedger,receiver:string,key:string):boolean {
  return Object.values(ledger.paymentDigests || {}).some(job=>Object.values(job.messages).some(message=>message.receiverOpenId===receiver&&message.status!=='delivered'&&message.candidateKeys.includes(key)));
}
function dispatch(job:ContractPaymentDigestJob,message:DigestMessage):ContractPaymentDigestDispatch {
  return {key:job.key,receiverOpenId:message.receiverOpenId,uuid:message.uuid,claimToken:message.claimToken!,content:structuredClone(message.content),candidateKeys:[...message.candidateKeys]};
}
function validCard(content:unknown):content is Record<string,unknown> {return !!content&&typeof content==='object'&&!Array.isArray(content)&&Buffer.byteLength(JSON.stringify(content),'utf8')<=28_000;}
function messageUuid(job:ContractPaymentDigestJob,receiver:string,keys:string[],content:Record<string,unknown>):string {
  const hash=digest([job.appId,job.fingerprint,receiver,keys,content]);return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
function stable(value:unknown):unknown {
  if(Array.isArray(value))return value.map(stable);
  return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,stable(item)])):value;
}
function digest(value:unknown):string {return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');}
