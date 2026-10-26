import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { HandoverAdapter, HandoverBatch, HandoverConfirmation, HandoverContext, HandoverModule, HandoverPreviewRequest, PendingDuty, PersonnelHandoverPreview } from '../../../shared/personnel-handover.interface';
import { handoverFingerprint, normalizeHandoverPreview, type PreviewContent } from './personnel-handover.baseline';
import { handoverItemMutationId, type PersonnelHandoverStore } from './personnel-handover.store';
import { pendingHandoverSelection } from './personnel-handover.preview';
import { AUTHORITY_DUTY_CATALOG, type AuthorityDutyKind } from '../../../shared/personnel-authority.interface';
import { normalizeHandoverPermissionOwnership } from './personnel-handover.ownership';

const ALL_MODULES: readonly HandoverModule[] = ['purchase','inventory','contracts','leave','overtime'];
const DUTY_MODULES: Partial<Record<AuthorityDutyKind, readonly HandoverModule[]>> = {
  building_supervisor:['leave','overtime'],leave_supervisor:['leave'],leave_manager:['leave'],
  overtime_supervisor:['overtime'],overtime_manager:['overtime'],warehouse_approver:['inventory'],warehouse_notify:['inventory'],
  purchase_manager:['purchase'],purchase_approver:['purchase'],purchase_executor:['purchase'],building_executor:['purchase'],
  contract_action:['contracts'],contract_notify:['contracts'],
  professional_supervisor:['leave','overtime'],professional_engineer:[],
};
export interface PersonnelHandoverScope { modules: readonly HandoverModule[]; dutyKinds: readonly AuthorityDutyKind[]; }

export interface HandoverActor { id: string; name: string; authorizationVersion?: number; }
export interface HandoverAuthorityPort {
  assertAdministrator(actor: HandoverActor): Promise<void>;
  snapshot(request: HandoverPreviewRequest): Promise<{ ready: boolean; content: PreviewContent; context: HandoverContext }>;
  restoreContext(preview: PersonnelHandoverPreview, batch?: HandoverBatch): Promise<HandoverContext>;
  applyPermissions(batch: HandoverBatch, mutationId: string): Promise<void>;
  permissionsApplied?(batch:HandoverBatch):Promise<boolean>;
}
export class PersonnelHandoverService {
  private readonly running=new Map<string,Promise<HandoverBatch>>();
  private readonly scope?: PersonnelHandoverScope;
  constructor(private readonly store: PersonnelHandoverStore, private readonly authority: HandoverAuthorityPort, private readonly adapters: readonly HandoverAdapter[], scope?: PersonnelHandoverScope) {
    if (scope !== undefined) {
      if (!scope || !Array.isArray(scope.modules) || !scope.modules.length || new Set(scope.modules).size !== scope.modules.length || scope.modules.some(module=>!ALL_MODULES.includes(module)) ||
        !Array.isArray(scope.dutyKinds) || !scope.dutyKinds.length || new Set(scope.dutyKinds).size !== scope.dutyKinds.length || scope.dutyKinds.some(kind=>!AUTHORITY_DUTY_CATALOG.some(duty=>duty.id === kind) || !DUTY_MODULES[kind]?.every(module=>scope.modules.includes(module)))) throw new BadRequestException('交接启用范围无效');
      this.scope={modules:[...scope.modules],dutyKinds:[...scope.dutyKinds]};
    }
  }
  async preview(actor: HandoverActor, request: HandoverPreviewRequest): Promise<PersonnelHandoverPreview> {
    await this.authority.assertAdministrator(actor);
    this.assertScopedRequest(request);
    const adapters=this.readyAdapters(), snapshot=await this.authority.snapshot(request);
    if (!snapshot.ready) throw new ServiceUnavailableException('人员职责尚未就绪，请先核对人员和岗位配置');
    const { content,context }=snapshot;
    this.assertContextScope(context,request);
    if (context.from.id !== request.fromPersonId || context.to.id !== request.toPersonId || !context.to.active || context.directoryVersion !== content.baseline.directoryVersion ||
      request.dutyRecordIds.some(id=>!context.duties.some(duty=>duty.recordId === id && content.baseline.duties.some(ref=>ref.recordId === id && ref.version === duty.version)))) throw new ConflictException('人员职责已变化，请重新预览');
    const all:PendingDuty[]=[];
    for (const adapter of this.contextAdapters(context,adapters).values()) {
      const items=await adapter.listPending(context);
      if (!Array.isArray(items) || items.some(item=>item.module !== adapter.module || this.scope && !request.dutyRecordIds.includes(item.dutyRecordId))) throw new ServiceUnavailableException('审批模块返回的交接清单无效');
      all.push(...items);
    }
    const selected=pendingHandoverSelection(all);
    const value:PreviewContent={ ...content,pending:selected.pending,excluded:selected.excluded,
      baseline:{ ...content.baseline,pending:selected.pending.map(item=>({ key:item.key,version:item.version })) },
      conflicts:[...content.conflicts,...selected.conflicts,...(selected.pending.length && !context.to.openId ? ['接任者尚未关联飞书身份，无法转交卡片待办'] : [])] };
    return normalizeHandoverPreview({ ...value,fingerprint:handoverFingerprint(value),createdAt:new Date().toISOString() });
  }
  async confirm(actor: HandoverActor, request: HandoverConfirmation): Promise<HandoverBatch> {
    await this.authority.assertAdministrator(actor);
    this.assertScopedRequest(request?.request);
    this.readyAdapters();
    if (!request || typeof request.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedFingerprint)) throw new BadRequestException('交接确认指纹无效');
    const existing=Object.values(this.store.read().batches).find(batch=>batch.clientMutationId === request.clientMutationId);
    if (existing) {
      this.assertBatchScope(existing);
      if (existing.actorId !== actor.id || existing.fingerprint !== request.expectedFingerprint || requestKey(existing.preview.requested) !== requestKey(request.request)) throw new ConflictException('重复交接请求内容不一致');
      return existing;
    }
    const preview=await this.preview(actor,request.request);
    if (preview.fingerprint !== request.expectedFingerprint) throw new ConflictException('交接清单已变化，请核对更新后的清单，原选择已保留');
    if (preview.conflicts.length || preview.permissions.some(item=>item.conflicts.length)) throw new ConflictException('交接清单存在冲突，请先核对');
    const context=await this.authority.restoreContext(preview);
    assertContextIdentity(context,preview);
    this.assertContextScope(context,request.request);
    if (context.directoryVersion !== preview.baseline.directoryVersion) throw new ConflictException('人员职责已变化，请重新预览');
    for (const item of preview.pending) {
      const checked=await this.readyAdapters().get(item.module)!.preflight(context,item);
      if (checked.ready !== true) throw new ConflictException(publicReason(checked.reason,'待办已变化，请更新交接清单'));
    }
    return this.store.accept(this.store.read().revision,{ actorId:actor.id,actorName:actor.name,clientMutationId:request.clientMutationId,preview });
  }
  process(id: string): Promise<HandoverBatch> {
    const prior=this.running.get(id); if (prior) return prior;
    const operation=this.run(id); this.running.set(id,operation);
    void operation.then(()=>this.running.delete(id),()=>this.running.delete(id));
    return operation;
  }
  async cancel(actor:HandoverActor,id:string,version:number):Promise<HandoverBatch> {
    await this.authority.assertAdministrator(actor);
    if (this.running.has(id)) throw new ConflictException('交接正在执行，不能取消');
    const operation=(async()=>{
      const batch=this.store.read().batches[id];
      if (!batch) throw new BadRequestException('交接批次不存在');
      this.assertBatchScope(batch);
      if (batch.status==='cancelled') return batch;
      if (batch.permissionStatus==='success' || await this.authority.permissionsApplied?.(batch)) throw new ConflictException('交接已生效，不能取消');
      return this.store.cancel(id,version,actor.id);
    })();
    this.running.set(id,operation);
    try{return await operation;}finally{this.running.delete(id);}
  }
  private async run(id: string): Promise<HandoverBatch> {
    const adapters=this.readyAdapters();
    let batch=this.store.read().batches[id];
    if (!batch) throw new BadRequestException('交接批次不存在');
    this.assertBatchScope(batch);
    if (batch.status === 'success' || batch.status==='cancelled') return batch;
    if (batch.permissionStatus!=='success' && this.authority.permissionsApplied) {
      try { if (await this.authority.permissionsApplied(batch)) batch=await this.store.updateProgress(id,batch.version,{permissionStatus:'success'}); }
      catch { return this.store.updateProgress(id,batch.version,{permissionStatus:'error'}); }
    }
    let context:HandoverContext;
    try {
      context=await this.authority.restoreContext(batch.preview,batch);
      assertContextIdentity(context,batch.preview);
      this.assertContextScope(context,batch.preview.requested);
    } catch {
      if (batch.permissionStatus !== 'success') return this.store.updateProgress(id,batch.version,{permissionStatus:'error'});
      return this.store.updateProgress(id,batch.version,{items:batch.items.filter(item=>!['success','skipped'].includes(item.status)).map(item=>({key:item.item.key,status:'error',error:'人员职责已变化，请核对后重试'}))});
    }
    if (batch.permissionStatus !== 'success') {
      try {
        if (this.scope) {
          const current:PendingDuty[]=[];
          for (const adapter of this.contextAdapters(context,adapters).values()) {
            const items=await adapter.listPending(context);
            if (!Array.isArray(items) || items.some(item=>item.module!==adapter.module || !batch.preview.requested.dutyRecordIds.includes(item.dutyRecordId))) throw new ConflictException('交接待办范围已变化');
            current.push(...items);
          }
          const next=pendingHandoverSelection(current),ordered=(items:readonly PendingDuty[])=>[...items].sort((a,b)=>a.key.localeCompare(b.key));
          if (next.conflicts.length || JSON.stringify(ordered(next.pending))!==JSON.stringify(ordered(batch.preview.pending))) throw new ConflictException('交接清单已变化，请重新预览');
          for (const item of next.pending) if (!(await adapters.get(item.module)!.preflight(context,item)).ready) throw new ConflictException('交接分项已变化，请重新预览');
        }
        await this.authority.applyPermissions(batch,handoverItemMutationId(id,'permissions'));
      }
      catch { return this.store.updateProgress(id,batch.version,{permissionStatus:'error'}); }
      batch=await this.store.updateProgress(id,batch.version,{permissionStatus:'success'});
    }
    const waitingRecords=new Set<string>();
    for (const selected of batch.items) {
      let entry=batch.items.find(item=>item.item.key === selected.item.key)!;
      if (['success','skipped'].includes(entry.status)) continue;
      const recordKey=JSON.stringify([entry.item.module,entry.item.recordId]);
      if (waitingRecords.has(recordKey)) continue;
      const adapter=adapters.get(entry.item.module)!;
      try {
        if (!entry.receipt) {
          if (this.scope) {
            const checked=await adapter.preflight(context,entry.item,handoverItemMutationId(id,entry.item.key));
            if (!checked.ready && !checked.alreadyCompleted) throw new ConflictException('交接分项已变化，请核对后重试');
          }
          const receipt=await adapter.acceptTransfer(context,entry.item,handoverItemMutationId(id,entry.item.key));
          batch=await this.store.updateProgress(id,batch.version,{items:[{key:entry.item.key,status:receipt.status === 'already_completed' ? 'skipped' : 'accepted',receipt}]});
          entry=batch.items.find(item=>item.item.key === selected.item.key)!;
          if (entry.status === 'skipped') continue;
        }
        const result=entry.status === 'accepted' ? await adapter.reconcile(context,entry.receipt!,{retryFailed:true}) : await adapter.reconcile(context,entry.receipt!);
        batch=await this.store.updateProgress(id,batch.version,{items:[{key:entry.item.key,status:result.status === 'success' ? 'success' : result.status === 'syncing' ? 'syncing' : 'error',...(result.status !== 'success' && result.status !== 'syncing' ? {error:'卡片和通知同步失败，请重试'} : {})}]});
      } catch {
        batch=await this.store.updateProgress(id,batch.version,{items:[{key:entry.item.key,status:'error',error:'交接分项未完成，请核对后重试'}]});
      }
      if (!['success','skipped'].includes(batch.items.find(item=>item.item.key===selected.item.key)!.status)) waitingRecords.add(recordKey);
    }
    return batch;
  }
  private readyAdapters():Map<HandoverModule,HandoverAdapter> {
    const map=new Map(this.adapters.map(adapter=>[adapter.module,adapter]));
    const modules=this.scope?.modules || ALL_MODULES;
    if (map.size !== this.adapters.length || [...map.keys()].some(module=>!ALL_MODULES.includes(module)) || (!this.scope && map.size !== 5) || !modules.every(module=>map.has(module))) throw new ServiceUnavailableException('审批模块尚未全部就绪，请暂缓交接');
    return new Map(modules.map(module=>[module,map.get(module)!]));
  }
  private contextAdapters(context:HandoverContext,adapters:Map<HandoverModule,HandoverAdapter>):Map<HandoverModule,HandoverAdapter> {
    if (!this.scope) return adapters;
    const relevant = new Set(context.duties.flatMap(duty => DUTY_MODULES[duty.kind] || []));
    return new Map([...adapters].filter(([module]) => relevant.has(module)));
  }
  private assertScopedRequest(request:HandoverPreviewRequest):void {
    if (!this.scope) return;
    if (!request || Object.keys(request).some(key=>!['fromPersonId','toPersonId','dutyRecordIds','mode','ownership'].includes(key)) || !Array.isArray(request.dutyRecordIds) || !request.dutyRecordIds.length) throw new BadRequestException('交接请求范围无效');
    requestKey(request);
  }
  private assertContextScope(context:HandoverContext,request:HandoverPreviewRequest):void {
    if (!this.scope) return;
    if (context.duties.length !== request.dutyRecordIds.length || context.duties.some(duty=>!request.dutyRecordIds.includes(duty.recordId))) throw new ConflictException('交接职责范围不一致，请重新预览');
    if (context.duties.some(duty=>!this.scope!.dutyKinds.includes(duty.kind))) throw new ServiceUnavailableException('所选职责不在已启用交接范围');
  }
  private assertBatchScope(batch:HandoverBatch):void {
    if (!this.scope) return;
    if (batch.preview.pending.some(item=>!this.scope!.modules.includes(item.module)) || batch.items.some(item=>!this.scope!.modules.includes(item.item.module))) throw new ServiceUnavailableException('交接批次包含未启用模块，原批次和历史保持');
  }
}
function requestKey(value:HandoverPreviewRequest):string {
  if (!value || !Array.isArray(value.dutyRecordIds) || value.dutyRecordIds.length > 100 || value.dutyRecordIds.some(id=>typeof id !== 'string') || new Set(value.dutyRecordIds).size !== value.dutyRecordIds.length) throw new BadRequestException('交接请求无效');
  return JSON.stringify([value.fromPersonId,value.toPersonId,value.mode,[...value.dutyRecordIds].sort(),...(value.ownership===undefined?[]:[normalizeHandoverPermissionOwnership(value.ownership,value.dutyRecordIds)])]);
}
function publicReason(value:unknown,fallback:string):string { return typeof value === 'string' && value.trim() && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : fallback; }
function assertContextIdentity(context:HandoverContext,preview:PersonnelHandoverPreview):void {
  if (!context.to.active || context.to.id !== preview.to.id || context.to.recordId !== preview.to.recordId || context.to.openId !== preview.to.openId ||
    context.from.id !== preview.from.id || context.from.recordId !== preview.from.recordId || context.from.openId !== preview.from.openId || context.from.active !== preview.from.active) throw new ConflictException('接任人员状态已变化，请重新核对交接清单');
}
