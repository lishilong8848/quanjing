import { cancelHotfixInitialization, runHotfixInitialization } from '../hotfix-runtime-activation';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { dirname, join } from 'node:path';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { HandoverAdapter, HandoverBatch, HandoverConfirmation, HandoverPreviewRequest } from '../../../shared/personnel-handover.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { getAccessConfigurationStore } from './access-configuration.store';
import { PersonnelHandoverAuthority } from './personnel-handover.authority';
import { PersonnelHandoverStore } from './personnel-handover.store';
import { PersonnelHandoverService, type HandoverActor } from './personnel-handover.service';
import { PERSONNEL_PREVIEW_READERS } from './personnel-preview.ports';
import { PERSONNEL_HANDOVER_SCOPE, personnelHandoverScopeProblem } from '../../../shared/personnel-handover-scope';
import type { PersonnelRecoveryActor, PersonnelRecoveryRequest, PersonnelRecoveryTask } from '../../../shared/personnel-task-recovery.interface';
import { assertRecoveryRequest } from './personnel-task-recovery.validation';

class SupportedAuthority extends PersonnelHandoverAuthority {
  override async snapshot(request:HandoverPreviewRequest) {
    const result=await super.snapshot(request);
    for (const duty of result.context.duties) { const problem = personnelHandoverScopeProblem(duty); if (problem) throw new ConflictException(problem); }
    return result;
  }
}

@Injectable()
export class PersonnelHandoverAdminService implements OnApplicationBootstrap,OnModuleDestroy {
  private readonly logger=new Logger(PersonnelHandoverAdminService.name);
  private readonly authority:SupportedAuthority;
  private readonly store:PersonnelHandoverStore;
  private worker?:PersonnelHandoverService;
  private timer?:ReturnType<typeof setTimeout>;
  private stopped=false;
  private working?:Promise<void>;
  constructor(private readonly configuration:AccessConfigurationService,directory:AccessConfigurationDirectory,private readonly modules:ModuleRef) {
    this.authority=new SupportedAuthority(configuration,directory);
    this.store=new PersonnelHandoverStore(join(dirname(getAccessConfigurationStore().filePath),'personnel-handover.json'));
  }
  async onApplicationBootstrap(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.schedule();
    });
  }
  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped=true;clearTimeout(this.timer);await this.working;
  }
  async preview(principal:AccessPrincipal,request:HandoverPreviewRequest){
    const actor=this.actor(principal);await this.authority.assertAdministrator(actor);
    this.noOverlappingBatch(request);
    const preview=await this.service().preview(actor,request);
    await this.authority.assertAdministrator(actor);return preview;
  }
  async confirm(principal:AccessPrincipal,input:HandoverConfirmation){
    const actor=this.actor(principal);await this.authority.assertAdministrator(actor);
    if (!input || Object.keys(input).some(key=>!['request','expectedFingerprint','clientMutationId'].includes(key))) throw new BadRequestException('交接确认请求无效');
    if (!Object.values(this.store.read().batches).some(batch=>batch.clientMutationId===input.clientMutationId)) this.noOverlappingBatch(input.request);
    const batch=await this.service().confirm(actor,input);this.schedule();return batch;
  }
  async list(principal:AccessPrincipal,mutationId?:string){
    await this.authority.assertAdministrator(this.actor(principal));
    if (mutationId!==undefined && !/^[A-Za-z0-9_-]{12,160}$/u.test(mutationId)) throw new BadRequestException('交接请求编号无效');
    return Object.values(this.store.read().batches).filter(batch=>!mutationId || batch.clientMutationId===mutationId).sort((a,b)=>b.acceptedAt.localeCompare(a.acceptedAt)).slice(0,100);
  }
  async read(principal:AccessPrincipal,id:string){
    await this.authority.assertAdministrator(this.actor(principal));return this.batch(id);
  }
  async listRecoveryTasks(principal:AccessPrincipal):Promise<PersonnelRecoveryTask[]>{
    const actor=this.recoveryActor(principal);this.assertRecoveryAdministrator(actor);
    const tasks:PersonnelRecoveryTask[]=[];
    for(const module of ['purchase','contracts'] as const){
      const rows=await this.recoveryPort(module).listRecoveryTasks();
      if(!Array.isArray(rows)||rows.some(task=>task.module!==module))throw new ServiceUnavailableException('原任务恢复清单无效');
      tasks.push(...rows);
    }
    this.assertRecoveryAdministrator(actor);
    const sorted=tasks.sort((left,right)=>(left.status==='completed'?1:0)-(right.status==='completed'?1:0)||right.createdAt.localeCompare(left.createdAt));
    return [...sorted.filter(task=>task.status!=='completed'),...sorted.filter(task=>task.status==='completed').slice(0,100)];
  }
  async previewRecoveryTask(principal:AccessPrincipal,input:PersonnelRecoveryRequest){
    const actor=this.recoveryActor(principal);this.assertRecoveryAdministrator(actor);assertRecoveryRequest(input);
    const result=await this.recoveryPort(input.module).previewRecoveryTask(input);
    this.assertRecoveryAdministrator(actor);return result;
  }
  async recoverTask(principal:AccessPrincipal,input:PersonnelRecoveryRequest){
    const actor=this.recoveryActor(principal);this.assertRecoveryAdministrator(actor);assertRecoveryRequest(input);
    return this.recoveryPort(input.module).recoverTask(input,actor,()=>this.assertRecoveryAdministrator(actor));
  }
  private recoveryActor(principal:AccessPrincipal):PersonnelRecoveryActor{const actor=this.actor(principal);return{id:actor.id,name:actor.name,authorizationVersion:actor.authorizationVersion!};}
  private assertRecoveryAdministrator(actor:PersonnelRecoveryActor):void{
    if(this.configuration.currentPrincipal(actor.id,actor.authorizationVersion)?.role!=='admin')throw new ForbiddenException('当前管理员权限已变化，请更新登录状态');
  }
  private recoveryPort(module:'purchase'|'contracts'):Required<Pick<HandoverAdapter,'listRecoveryTasks'|'previewRecoveryTask'|'recoverTask'>>{
    let adapter:HandoverAdapter;try{adapter=this.modules.get<HandoverAdapter>(PERSONNEL_PREVIEW_READERS[module],{strict:false});}catch{throw new ServiceUnavailableException('原任务恢复模块未就绪');}
    if(adapter.module!==module||typeof adapter.listRecoveryTasks!=='function'||typeof adapter.previewRecoveryTask!=='function'||typeof adapter.recoverTask!=='function')throw new ServiceUnavailableException('原任务恢复能力未就绪');
    return adapter as Required<Pick<HandoverAdapter,'listRecoveryTasks'|'previewRecoveryTask'|'recoverTask'>>;
  }
  async retry(principal:AccessPrincipal,id:string,version:number){
    await this.authority.assertAdministrator(this.actor(principal));
    const batch=this.batch(id);this.assertSupported(batch);
    if (batch.version!==version) throw new ConflictException('交接进度已更新，请核对后重试');
    if (batch.status==='cancelled') throw new ConflictException('交接已取消');
    if (batch.status==='error') {
      if(this.working)throw new ConflictException('另一个交接正在执行，请稍后重试');
      const resumed = await this.store.updateProgress(id, version, {
        ...(batch.permissionStatus === 'error' ? { permissionStatus: 'pending' as const } : {}),
        items: batch.items.filter(item => item.status === 'error').map(item => ({ key: item.item.key, status: item.receipt ? 'accepted' as const : 'pending' as const })),
      });
      this.launch(id);
      return resumed;
    }
    return batch;
  }
  async cancel(principal:AccessPrincipal,id:string,version:number){
    await this.authority.assertAdministrator(this.actor(principal));
    const batch=this.batch(id);this.assertSupported(batch);return this.service().cancel(this.actor(principal),id,version);
  }
  private actor(principal:AccessPrincipal):HandoverActor {
    if (principal.role!=='admin' || !principal.accountId || !principal.displayName || !Number.isSafeInteger(principal.authorizationVersion)) throw new UnauthorizedException('需要有效的管理员登录');
    return {id:principal.accountId,name:principal.displayName,authorizationVersion:principal.authorizationVersion};
  }
  private batch(id:string){
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new BadRequestException('交接批次编号无效');
    const batch=this.store.read().batches[id];if (!batch) throw new BadRequestException('交接批次不存在');return batch;
  }
  private noOverlappingBatch(request:HandoverPreviewRequest){
    if (!request) throw new BadRequestException('交接请求无效');
    const ids=[request.fromPersonId,request.toPersonId];
    if (Object.values(this.store.read().batches).some(batch=>!['success','cancelled'].includes(batch.status) && [batch.preview.from.id,batch.preview.to.id].some(id=>ids.includes(id)))) throw new ConflictException('相关人员已有未收口的交接，请先恢复原批次或取消未生效批次');
  }
  private assertSupported(batch:HandoverBatch){
    if (!supportedMode(batch) || batch.preview.baseline.duties.some(duty=>!duty.fingerprint) || batch.items.some(item=>!PERSONNEL_HANDOVER_SCOPE.modules.includes(item.item.module))) throw new ConflictException('此历史批次不属于已启用交接范围，保留原记录，请单独核对');
  }
  private service(){
    if (!this.worker) {
      const adapters=PERSONNEL_HANDOVER_SCOPE.modules.map(module=>{
        let value:HandoverAdapter;try{value=this.modules.get<HandoverAdapter>(PERSONNEL_PREVIEW_READERS[module],{strict:false});}catch{throw new ServiceUnavailableException('岗位交接模块未就绪');}
        if (value.module!==module || !['listPending','preflight','acceptTransfer','reconcile'].every(method=>typeof value[method as keyof HandoverAdapter]==='function')) throw new ServiceUnavailableException('交接模块能力不完整');
        return value;
      });
      this.worker=new PersonnelHandoverService(this.store,this.authority,adapters,PERSONNEL_HANDOVER_SCOPE);
    }
    return this.worker;
  }
  private launch(id:string){
    if (this.stopped || this.working) return;
    this.working=this.service().process(id).then(()=>undefined,()=>{this.logger.error('交接后台处理未完成，请从配置页面核对批次');}).finally(()=>{this.working=undefined;this.schedule();});
  }
  private schedule(){
    if (this.stopped || this.timer) return;
    this.timer=setTimeout(()=>{
      this.timer=undefined;
      try {
        const batch=Object.values(this.store.read().batches).find(batch=>['accepted','syncing'].includes(batch.status) && supportedMode(batch) && batch.preview.baseline.duties.every(duty=>!!duty.fingerprint) && batch.items.every(item=>PERSONNEL_HANDOVER_SCOPE.modules.includes(item.item.module)));
        if (batch) {this.assertSupported(batch);this.launch(batch.id);}
      } catch {this.logger.error('交接后台恢复被阻断，请从配置页面核对原批次');}
      this.schedule();
    },3000);this.timer.unref();
  }
}
function supportedMode(batch:HandoverBatch):boolean {
  return batch.preview.requested.mode==='offboarding'||batch.preview.requested.mode==='rotation'&&!!batch.preview.dutyRouting?.length&&!!batch.preview.requested.ownership?.length&&!!batch.preview.permissionOwnership?.length&&batch.preview.permissions.every(item=>!!item.transfer&&!!item.sourceRetained);
}
