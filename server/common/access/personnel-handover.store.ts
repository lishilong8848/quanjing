import type { HandoverBatch, HandoverBatchItem, PersonnelHandoverPreview } from '../../../shared/personnel-handover.interface';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../process-lock-owner';
import { copyHandoverPreview, normalizeHandoverPreview } from './personnel-handover.baseline';
import { ID_PATTERN } from './access-configuration.validation';
import { normalizeAccessDisplayName } from './access-display-name';

export interface AcceptHandover { clientMutationId: string; actorId: string; actorName: string; preview: PersonnelHandoverPreview; }
export interface HandoverProgress { permissionStatus?: HandoverBatch['permissionStatus']; items?: (Pick<HandoverBatchItem, 'status' | 'receipt' | 'error'> & { key: string })[]; }
interface HandoverState { schemaVersion: 1; revision: number; batches: Record<string, HandoverBatch>; }
const MAX_BYTES=32 * 1024 * 1024;
const BATCH_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const record=(value:unknown):value is Record<string,unknown>=>!!value && typeof value === 'object' && !Array.isArray(value);
const isDate=(value:unknown):value is string=>typeof value === 'string' && Number.isFinite(Date.parse(value));
export function handoverItemMutationId(batchId: string, key: string): string {
  if (!BATCH_ID.test(batchId) || typeof key !== 'string' || !key || key.length > 512) throw new BadRequestException('交接分项身份无效');
  return `handover-${createHash('sha256').update(JSON.stringify([batchId,key])).digest('hex')}`;
}
export class PersonnelHandoverStore {
  private queue: Promise<unknown>=Promise.resolve();
  private persisted=false;
  constructor(readonly filePath: string) {}
  read(): HandoverState {
    try {
      assertPath(this.filePath);
      if (!existsSync(this.filePath)) { if (this.persisted) throw new Error('missing'); return { schemaVersion:1,revision:0,batches:{} }; }
      this.persisted=true;
      const info=lstatSync(this.filePath);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('size');
      const value:unknown=JSON.parse(readFileSync(this.filePath,'utf8'));
      if (!validState(value)) throw new Error('schema');
      return clone(value);
    } catch { throw new ServiceUnavailableException('交接台账无效，已停止交接，请联系管理员'); }
  }
  async accept(expected: number, request: AcceptHandover): Promise<HandoverBatch> {
    if (!Number.isSafeInteger(expected) || expected < 0 || !request || typeof request.clientMutationId !== 'string' || !/^[A-Za-z0-9_-]{12,160}$/u.test(request.clientMutationId) ||
      typeof request.actorId !== 'string' || !ID_PATTERN.test(request.actorId) || typeof request.actorName !== 'string' || normalizeAccessDisplayName(request.actorName) !== request.actorName) throw new BadRequestException('交接确认请求无效');
    const preview=copyHandoverPreview(request.preview);
    if (preview.conflicts.length || preview.permissions.some(item=>item.conflicts.length)) throw new ConflictException('交接清单存在冲突，请先核对');
    const input={ clientMutationId:request.clientMutationId,actorId:request.actorId,actorName:request.actorName };
    return this.atomic(state=>{
      const prior=Object.values(state.batches).find(batch=>batch.clientMutationId === input.clientMutationId);
      if (prior) {
        if (prior.actorId !== input.actorId || prior.fingerprint !== preview.fingerprint) throw new ConflictException('重复交接请求内容不一致');
        return { result:prior,changed:false };
      }
      if (state.revision !== expected) throw new ConflictException('交接台账已更新，请核对当前清单');
      if (preview.baseline.duties.some(duty=>!!duty.fingerprint) && Object.values(state.batches).some(batch=>!['success','cancelled'].includes(batch.status) && [batch.preview.from.id,batch.preview.to.id].some(id=>[preview.from.id,preview.to.id].includes(id)))) throw new ConflictException('相关人员已有未收口的交接，请先恢复原批次');
      if (Object.keys(state.batches).length >= 2000) throw new ServiceUnavailableException('交接台账容量已满，请联系管理员');
      const timestamp=new Date().toISOString();
      const batch:HandoverBatch={ id:randomUUID(),version:1,...input,fingerprint:preview.fingerprint,acceptedAt:timestamp,updatedAt:timestamp,status:'accepted',preview,permissionStatus:'pending',items:preview.pending.map(item=>({ item:clone(item),status:'pending' })) };
      state.batches[batch.id]=batch;
      return { result:batch,changed:true };
    });
  }
  async cancel(id:string,version:number,actorId:string):Promise<HandoverBatch> {
    if (!BATCH_ID.test(id) || !Number.isSafeInteger(version) || version<1 || !ID_PATTERN.test(actorId)) throw new BadRequestException('取消交接请求无效');
    return this.atomic(state=>{
      const batch=state.batches[id];
      if (!batch) throw new BadRequestException('交接批次不存在');
      if (batch.status==='cancelled') return {result:batch,changed:false};
      if (batch.version!==version) throw new ConflictException('交接进度已更新，请读取最新进度');
      if (batch.permissionStatus==='success' || batch.items.some(item=>item.receipt || item.status!=='pending')) throw new ConflictException('交接已生效，不能取消');
      batch.status='cancelled';batch.cancelledBy=actorId;
      batch.updatedAt=new Date(Math.max(Date.now(),Date.parse(batch.updatedAt))).toISOString();batch.cancelledAt=batch.updatedAt;batch.version++;
      return {result:batch,changed:true};
    });
  }
  async updateProgress(id: string, version: number, progress: HandoverProgress): Promise<HandoverBatch> {
    if (!BATCH_ID.test(id) || !Number.isSafeInteger(version) || version < 1 || !record(progress) || Object.keys(progress).some(key=>!['permissionStatus','items'].includes(key)) ||
      (progress.permissionStatus !== undefined && !['pending','success','error'].includes(progress.permissionStatus as NonNullable<HandoverProgress['permissionStatus']>)) ||
      (progress.items !== undefined && (!Array.isArray(progress.items) || progress.items.length > 10_000))) throw new BadRequestException('交接进度请求无效');
    const input: HandoverProgress=clone(progress as HandoverProgress);
    return this.atomic(state=>{
      const batch=state.batches[id];
      if (!batch) throw new BadRequestException('交接批次不存在');
      if (batch.status==='cancelled') throw new ConflictException('交接已取消');
      if (batch.version !== version) throw new ConflictException('交接进度已更新，请读取最新进度');
      if (batch.permissionStatus === 'success' && input.permissionStatus !== undefined && input.permissionStatus !== 'success') throw new ConflictException('已完成权限不能重新应用');
      const keys=new Set<string>();
      for (const patch of input.items || []) {
        if (!record(patch) || typeof patch.key !== 'string' || keys.has(patch.key) || Object.keys(patch).some(key=>!['key','status','receipt','error'].includes(key))) throw new BadRequestException('交接分项请求无效');
        keys.add(patch.key);
        const item=batch.items.find(entry=>entry.item.key === patch.key);
        if (!item) throw new BadRequestException('交接分项不存在');
        const transitions:Record<HandoverBatchItem['status'],readonly HandoverBatchItem['status'][]>={ pending:['pending','accepted','error','skipped'],accepted:['accepted','syncing','success','error'],syncing:['syncing','success','error'],error:['pending','error','accepted','syncing','success','skipped'],success:['success'],skipped:['skipped'] };
        if (['success','skipped'].includes(item.status) && patch.status !== item.status) throw new ConflictException('已完成项目不能重新办理');
        if (!transitions[item.status].includes(patch.status)) throw new ConflictException('交接分项状态不能跳过受理阶段');
        const next:HandoverBatchItem={ item:item.item,status:patch.status,...(patch.receipt || item.receipt ? { receipt:clone(patch.receipt || item.receipt!) } : {}),...(patch.error !== undefined ? { error:patch.error } : {}) };
        if (item.receipt && patch.receipt && JSON.stringify(item.receipt) !== JSON.stringify(patch.receipt)) throw new ConflictException('交接回执不能替换');
        if (!validItem(batch.id,next)) throw new BadRequestException('交接回执或分项状态无效');
        Object.assign(item,next); if (next.error === undefined) delete item.error;
      }
      if (input.permissionStatus !== undefined) batch.permissionStatus=input.permissionStatus;
      batch.status=statusOf(batch); batch.version++;
      batch.updatedAt=new Date(Math.max(Date.now(),Date.parse(batch.updatedAt))).toISOString();
      return { result:batch,changed:true };
    });
  }
  private atomic<T>(change:(state:HandoverState)=>{ result:T; changed:boolean }):Promise<T> {
    const operation=this.queue.then(()=>{
      assertPath(this.filePath); mkdirSync(dirname(this.filePath),{recursive:true});
      const lockPath=this.filePath+'.lock'; assertPath(lockPath);
      const owner=createProcessLockOwner(randomUUID());
      let lock:number;
      try { lock=openSync(lockPath,'wx',0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing=readOwner(lockPath);
        if (!existing || processLockOwnerMayBeAlive(existing,lstatSync(lockPath).mtimeMs)) throw new ConflictException('交接正在保存，请稍后重试');
        const guardPath=lockPath+'.recovery'; assertPath(guardPath);
        let guard:number; try { guard=openSync(guardPath,'wx',0o600); } catch { throw new ConflictException('交接锁正在恢复，请稍后重试'); }
        try {
          const again=readOwner(lockPath);
          if (!again || again.token !== existing.token || processLockOwnerMayBeAlive(again,lstatSync(lockPath).mtimeMs)) throw new ConflictException('交接正在保存，请稍后重试');
          unlinkSync(lockPath); lock=openSync(lockPath,'wx',0o600);
        } finally { closeSync(guard); unlinkSync(guardPath); }
      }
      const temporary=`${this.filePath}.${owner.token}.tmp`;
      try {
        writeFileSync(lock,JSON.stringify(owner)); fsyncSync(lock);
        const state=this.read(), outcome=change(state);
        if (!outcome.changed) return clone(outcome.result);
        state.revision++;
        if (!validState(state)) throw new ServiceUnavailableException('交接台账校验失败，未保存');
        const bytes=Buffer.from(JSON.stringify(state));
        if (bytes.length > MAX_BYTES) throw new ServiceUnavailableException('交接台账容量已满，未保存');
        assertPath(this.filePath); const handle=openSync(temporary,'wx',0o600);
        try { writeFileSync(handle,bytes); fsyncSync(handle); } finally { closeSync(handle); }
        renameSync(temporary,this.filePath); this.persisted=true;
        return clone(outcome.result);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
        closeSync(lock);
        const current=readOwner(lockPath);
        if (current?.token === owner.token || (existsSync(lockPath) && lstatSync(lockPath).size === 0)) unlinkSync(lockPath);
      }
    });
    this.queue=operation.catch(()=>undefined);
    return operation;
  }
}
function statusOf(batch:Pick<HandoverBatch,'permissionStatus'|'items'>):HandoverBatch['status'] {
  if (batch.permissionStatus === 'error' || batch.items.some(item=>item.status === 'error')) return 'error';
  if (batch.permissionStatus === 'success' && batch.items.every(item=>['success','skipped'].includes(item.status))) return 'success';
  return batch.permissionStatus === 'pending' && batch.items.every(item=>item.status === 'pending') ? 'accepted' : 'syncing';
}
function validItem(batchId:string, value:HandoverBatchItem):boolean {
  if (!record(value) || Object.keys(value).some(key=>!['item','status','receipt','error'].includes(key)) || !['pending','accepted','syncing','success','error','skipped'].includes(value.status) ||
    (value.error !== undefined && (value.status !== 'error' || typeof value.error !== 'string' || !value.error.trim() || value.error.length > 500))) return false;
  const receipt=value.receipt;
  if (['accepted','syncing','success','skipped'].includes(value.status) && !receipt) return false;
  if (!receipt) return true;
  return record(receipt) && Object.keys(receipt).every(key=>['itemKey','mutationId','module','recordId','version','status'].includes(key)) && receipt.itemKey === value.item.key && receipt.mutationId === handoverItemMutationId(batchId,value.item.key) &&
    receipt.module === value.item.module && receipt.recordId === value.item.recordId && typeof receipt.version === 'string' && receipt.version.length > 0 && receipt.version.length <= 500 &&
    ['accepted','already_completed'].includes(receipt.status) && (value.status === 'skipped' ? receipt.status === 'already_completed' : receipt.status === 'accepted');
}
function validState(value:unknown):value is HandoverState {
  try {
    if (!record(value) || Object.keys(value).some(key=>!['schemaVersion','revision','batches'].includes(key)) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !record(value.batches) || Object.keys(value.batches).length > 2000) return false;
    const mutations=new Set<string>();
    return Object.entries(value.batches).every(([id,batch])=>{
      if (!record(batch) || !BATCH_ID.test(id) || batch.id !== id || Object.keys(batch).some(key=>!['id','version','clientMutationId','fingerprint','actorId','actorName','acceptedAt','updatedAt','status','preview','permissionStatus','items','cancelledAt','cancelledBy'].includes(key)) ||
        !Number.isSafeInteger(batch.version) || Number(batch.version) < 1 || typeof batch.clientMutationId !== 'string' || !/^[A-Za-z0-9_-]{12,160}$/u.test(batch.clientMutationId) || mutations.has(batch.clientMutationId) ||
        typeof batch.actorId !== 'string' || !ID_PATTERN.test(batch.actorId) || typeof batch.actorName !== 'string' || normalizeAccessDisplayName(batch.actorName) !== batch.actorName || !isDate(batch.acceptedAt) || !isDate(batch.updatedAt) || Date.parse(batch.updatedAt) < Date.parse(batch.acceptedAt) ||
        !['pending','success','error'].includes(String(batch.permissionStatus)) || !Array.isArray(batch.items)) return false;
      mutations.add(batch.clientMutationId);
      const preview=normalizeHandoverPreview(batch.preview as PersonnelHandoverPreview);
      if (batch.fingerprint !== preview.fingerprint || JSON.stringify(preview) !== JSON.stringify(batch.preview) || preview.conflicts.length || preview.permissions.some(item=>item.conflicts.length) || batch.items.length !== preview.pending.length) return false;
      const typed=batch as unknown as HandoverBatch;
      if (typed.status==='cancelled') return isDate(typed.cancelledAt) && typed.cancelledAt===typed.updatedAt && typeof typed.cancelledBy==='string' && ID_PATTERN.test(typed.cancelledBy) && typed.permissionStatus!=='success' && typed.items.every((item,index)=>item.status==='pending' && !item.receipt && validItem(id,item) && JSON.stringify(item.item)===JSON.stringify(preview.pending[index]));
      if (typed.cancelledAt!==undefined || typed.cancelledBy!==undefined) return false;
      return typed.status === statusOf(typed) && typed.items.every((item,index)=>validItem(id,item) && JSON.stringify(item.item) === JSON.stringify(preview.pending[index]));
    });
  } catch { return false; }
}
function readOwner(file:string) {
  try { if (lstatSync(file).size > 2048) return null; return normalizeProcessLockOwner(JSON.parse(readFileSync(file,'utf8'))); } catch { return null; }
}
function assertPath(file:string):void {
  if (!isAbsolute(file) || file.slice(parse(file).root.length).includes(':')) throw new ServiceUnavailableException('交接台账路径无效');
  let current=resolve(file);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new ServiceUnavailableException('交接台账路径不能使用链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent=dirname(current); if (parent === current) return; current=parent;
  }
}
