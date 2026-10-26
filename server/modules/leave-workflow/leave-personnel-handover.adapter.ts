import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { HandoverAdapter, HandoverContext, PendingDuty, PreflightResult, TransferReceipt, TransferResult } from '../../../shared/personnel-handover.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { authorityDutyMatchesTarget } from '../../common/access/personnel-authority.duties';
import { assertLeaveHandoverCoverage, assertPriorHandoverClosed } from '../../common/access/personnel-handover.coverage';
import { LeaveWorkflowService } from './leave-workflow.service';
import { LeaveWorkflowStore, type LeaveWorkflowApplicationEntry, type LeaveWorkflowStage, type LeaveFutureManagerHandoverInput, type LeaveWorkflowTaskEntry } from './leave-workflow.store';
import {assertFutureManagerRoles,assertFutureManagerTasks,leavePlanHash} from './leave-future-manager-handover';
import { PersonnelDutyNotificationHandover, leaveNotificationResponsibilities } from '../../common/access/personnel-duty-notification-handover';
import { confirmedPersonnelDutyTransferVersion } from '../../common/access/personnel-duty-transfer.receipt';

@Injectable()
export class LeavePersonnelHandoverAdapter implements HandoverAdapter {
  readonly module = 'leave' as const;
  private readonly notifications: PersonnelDutyNotificationHandover;
  constructor(private readonly store: LeaveWorkflowStore, private readonly configuration: AccessConfigurationService, private readonly workflow: LeaveWorkflowService) {
    this.notifications = new PersonnelDutyNotificationHandover(this.module, async context => leaveNotificationResponsibilities(context, await this.store.personnelHandoverSnapshot()), async (context, item, mutationId) => {
      const rows = leaveNotificationResponsibilities(context, await this.store.personnelHandoverSnapshot()).filter(row => row.dutyRecordId === item.dutyRecordId && row.adjustmentRevision !== undefined);
      for (const row of rows) await this.store.enqueueTask({ recordId: row.recordId, businessKey: `leave:${row.recordId}:substitute-adjustment:${row.adjustmentRevision}:${mutationId}`, kind: 'deliver_substitute_adjustment_cards', payload: { revision: row.adjustmentRevision, handoverMutationId: mutationId } });
    }, async (context,item,mutationId,keys)=>this.store.retryFailedTasks(keys,()=>{this.assertTarget(context);confirmedPersonnelDutyTransferVersion(context,item,mutationId);}));
  }
  async listPending(context: HandoverContext): Promise<PendingDuty[]> {
    if (!this.workflow.isEnabled()) throw new ServiceUnavailableException('请休假工作流未启用');
    if (!context.from.openId) return [];
    const items: PendingDuty[] = [];
    for (const application of await this.coveredApplications(context)) {
      const future=application.status==='supervisor_pending'&&application.approvalPlan?.stages.find(candidate=>candidate.key==='manager');
      if(future&&future.approvers.some(person=>person.openId===context.from.openId)){
        const duty=this.duty(context,application,'manager');if(!duty)throw new ConflictException('未来经理职责未包含在交接范围');
        if(!application.currentStage||await this.store.getStageAction(application.recordId,application.currentStage.key,application.currentStage.version))throw new ConflictException('原示例人员001审批正在同步，请待阶段更新');
        items.push({key:`leave:${application.recordId}:future-manager:${application.revision}`,module:'leave',recordId:application.recordId,title:`${application.snapshot.applicantName} · 后续经理审批`,dutyRecordId:duty.recordId,phase:'approval',status:'pending',stageKey:'future_manager',version:`${application.revision}:${leavePlanHash(application.approvalPlan)}:${application.currentStage.version}`,recipients:future.approvers.map(({name,openId})=>({name,openId}))});
        if(!this.supportsRoleNotifications())continue;
      }
      const stage = application.currentStage;
      if (!stage?.approverOpenIds.includes(context.from.openId)) continue;
      const duty = this.duty(context, application, stage.key);
      if (!duty) continue;
      const plan = application.approvalPlan?.stages.find(candidate => candidate.key === stage.key);
      if (!plan || plan.approvers.some(person => person.openId === context.from.openId && person.personRecordId && person.personRecordId !== context.from.recordId)) throw new ConflictException('原审批人员身份与岗位不一致');
      const action = await this.store.getStageAction(application.recordId, stage.key, stage.version);
      items.push({ key: itemKey(application.recordId, stage), module: 'leave', recordId: application.recordId,
        title: `${application.snapshot.applicantName} · ${application.snapshot.leaveType}`, dutyRecordId: duty.recordId, phase: 'approval',
        status: action ? 'in_progress' : application.status === `${stage.key}_pending` ? 'pending' : 'terminal',
        stageKey: stage.key, version: String(stage.version), recipients: stage.approverOpenIds.map(openId => {
          const person = plan.approvers.find(candidate => candidate.openId === openId);
          if (!person?.name) throw new ConflictException('审批人快照缺失，请先核对原审批记录');
          return { openId, name: person.name };
        }) });
    }
    return this.supportsRoleNotifications() ? [...items, ...await this.notifications.listPending(context)] : items;
  }
  async preflight(context: HandoverContext, item: PendingDuty, mutationId?:string): Promise<PreflightResult> {
    if (item.stageKey === 'role_notifications') {
      try { this.assertTarget(context); if (!this.supportsRoleNotifications()) throw new ConflictException(); return this.notifications.preflight(context, item, mutationId); }
      catch { return { ready: false, reason: '当前通知岗位未就绪，请恢复原配置后重试' }; }
    }
    if(item.stageKey==='future_manager'){
      try{
        this.assertTarget(context);const application=await this.application(item.recordId),prior=mutationId?await this.store.getFutureManagerHandover(item.recordId,mutationId):null;
        if(prior)return {ready:this.futurePriorMatches(context,item,prior)};
        this.futureInput(context,item,application,mutationId||`handover-${'0'.repeat(64)}`);
        assertFutureManagerRoles(context.from.openId!,application,this.supportsRoleNotifications());
        const originalVersion=Number(item.version.split(':')[2]),action=await this.store.getStageAction(item.recordId,'supervisor',originalVersion);
        if(['approved','rejected','rejected_syncing'].includes(application.status)||action?.action==='reject'||await this.store.getStageAction(item.recordId,'manager',originalVersion+1))return {ready:false,alreadyCompleted:true,reason:'原审批已合法受理，保留原结果与历史'};
        if(action&&application.currentStage?.key!=='manager')return {ready:false,reason:'示例人员001审批正在同步，请待阶段更新后重试原交接'};
        assertFutureManagerTasks(item.recordId,await this.store.listTasks(),application.currentStage?.key==='manager'?application.currentStage.version:undefined);
        return {ready:true};
      }catch{return {ready:false,reason:'未来经理计划、职责或原审批已变化，请核对后重试'};}
    }
    try {
      this.assertTarget(context);
      const application = await this.application(item.recordId);
      const stage = this.expected(context, item, application);
      if (mutationId) {
        const prior=await this.store.getPersonnelHandover(item.recordId,mutationId);
        if (prior) return {ready:sameTarget(prior.payload.target,context) && prior.payload.sourceOpenId===context.from.openId && prior.payload.dutyRecordId===item.dutyRecordId && prior.payload.sourceStageKey===stage.key && prior.payload.sourceStageVersion===stage.version};
      }
      if (application.resolvedAction!==null || ['approved','rejected','approved_syncing','rejected_syncing'].includes(application.status) || await this.store.getStageAction(item.recordId,stage.key,stage.version)) return {ready:false,alreadyCompleted:true,reason:'原审批已受理，保留原处理和历史'};
      await this.coveredApplications(context);
      if (application.snapshot.applicantPersonRecordId === context.to.recordId || application.snapshot.applicantOpenId === context.to.openId) return { ready: false, reason: '接任人不能审批自己的申请' };
      if (application.status !== `${stage.key}_pending`) return { ready: false, reason: '审批阶段已变化，请更新交接清单' };
      if (!application.currentStage || JSON.stringify(application.currentStage) !== JSON.stringify(stage)) return { ready: false, reason: '审批阶段已变化，请更新交接清单' };
      return { ready: true };
    } catch { return { ready: false, reason: '请休假人员、职责或审批阶段已变化，请核对后重试' }; }
  }
  async acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    if (item.stageKey === 'role_notifications') {
      this.assertTarget(context); if (!this.supportsRoleNotifications()) throw new ConflictException('通知岗位未就绪');
      return this.notifications.acceptTransfer(context, item, mutationId);
    }
    if(item.stageKey==='future_manager'){
      this.assertTarget(context);const application=await this.application(item.recordId),prior=await this.store.getFutureManagerHandover(item.recordId,mutationId);
      if(prior&&!this.futurePriorMatches(context,item,prior))throw new ConflictException('未来经理交接回执身份不一致');
      const request=prior?prior.payload.futureInput as unknown as LeaveFutureManagerHandoverInput:this.futureInput(context,item,application,mutationId);
      const accepted=this.supportsRoleNotifications()?await this.store.acceptFutureManagerHandover(request,()=>{confirmedPersonnelDutyTransferVersion(context,item,mutationId);return true;}):await this.store.acceptFutureManagerHandover(request);
      return {itemKey:item.key,mutationId,module:'leave',recordId:item.recordId,version:String(accepted.stage?.version??accepted.revision),status:accepted.status};
    }
    this.assertTarget(context);
    const application = await this.application(item.recordId), stage = this.expected(context, item, application);
    const prior = await this.store.getPersonnelHandover(item.recordId, mutationId);
    const acted=await this.store.getStageAction(item.recordId,stage.key,stage.version);
    if (!prior && !acted && application.resolvedAction===null && !['approved','rejected','approved_syncing','rejected_syncing'].includes(application.status)) await this.coveredApplications(context);
    const target = { name: context.to.name, openId: context.to.openId!, personRecordId: context.to.recordId, position: context.to.position, buildings: context.to.buildings };
    if (prior && (!sameTarget(prior.payload.target, context) || prior.payload.sourceOpenId !== context.from.openId || prior.payload.dutyRecordId !== item.dutyRecordId || prior.payload.sourceStageKey !== stage.key || prior.payload.sourceStageVersion !== stage.version)) throw new ConflictException('交接回执身份不一致');
    const request = { recordId: item.recordId, mutationId, dutyRecordId: item.dutyRecordId,
      sourceOpenId: context.from.openId!, expectedStage: stage, target: prior ? prior.payload.target as typeof target : target };
    const accepted = this.supportsRoleNotifications()
      ? await this.store.acceptPersonnelHandover(request, () => { confirmedPersonnelDutyTransferVersion(context, item, mutationId); return true; })
      : await this.store.acceptPersonnelHandover(request);
    return { itemKey: item.key, mutationId, module: 'leave', recordId: item.recordId, version: String(accepted.stage?.version ?? stage.version), status: accepted.status };
  }
  async reconcile(context: HandoverContext, receipt: TransferReceipt, options?: {retryFailed?:boolean}): Promise<TransferResult> {
    if (receipt.itemKey.startsWith('leave:role-notifications:')) {
      try { this.assertTarget(context); if (!this.supportsRoleNotifications()) throw new ConflictException(); return this.notifications.reconcile(context, receipt, options); }
      catch { return { status: 'error', error: '当前通知岗位或接任人员已变化，请核对后恢复' }; }
    }
    if(receipt.itemKey.startsWith(`leave:${receipt.recordId}:future-manager:`)){
      const prior=await this.store.getFutureManagerHandover(receipt.recordId,receipt.mutationId),application=await this.application(receipt.recordId);
      if(receipt.status==='already_completed'){
        const manager=await this.store.getStageAction(receipt.recordId,'manager',Number(receipt.version)),supervisor=await this.store.getStageAction(receipt.recordId,'supervisor',Number(receipt.version));
        return ['approved','rejected'].includes(application.status)||manager||supervisor?.action==='reject'?{status:'success'}:{status:'error',error:'原审批尚未形成可核对的终态'};
      }
      const request=prior?.payload.futureInput as unknown as LeaveFutureManagerHandoverInput|undefined;
      if(!prior||!request||request.sourceOpenId!==context.from.openId||request.sourcePersonRecordId!==context.from.recordId||!sameTarget(prior.payload.target,context)||receipt.itemKey!==`leave:${receipt.recordId}:future-manager:${request.expectedRevision}`)return {status:'error',error:'未来经理交接回执或身份不一致'};
      if(prior.kind==='sync_personnel_handover')return this.reconcile(context,{...receipt,itemKey:`leave:${receipt.recordId}:manager:${prior.payload.sourceStageVersion}`});
      if(receipt.version!==String(prior.payload.targetRevision)||leavePlanHash(application.approvalPlan)!==prior.payload.targetPlanHash)return {status:'error',error:'未来经理计划已变化，请核对原交接'};
      try{this.assertTarget(context);}catch{return {status:'error',error:'接任人员业务权限已收回'};}
      if (options?.retryFailed) {
        await this.retryNativeTask(context,receipt,prior);
        return this.reconcile(context,receipt);
      }
      return prior.status==='completed'?{status:'success'}:prior.status==='failed'||prior.lastError?{status:'error',error:'未来经理计划核对未完成，请恢复原交接'}:{status:'syncing'};
    }
    const failed: TransferResult = { status: 'error', error: '请休假交接回执或人员状态不一致，请核对后恢复' };
    if (receipt.module !== 'leave') return failed;
    const application = await this.application(receipt.recordId);
    if (receipt.status === 'already_completed') {
      const match = /^leave:([A-Za-z0-9_-]+):(supervisor|manager):(\d+)$/u.exec(receipt.itemKey);
      return match?.[1] === receipt.recordId && (await this.store.getStageAction(receipt.recordId, match[2] as LeaveWorkflowStage['key'], Number(match[3])) || ['approved','rejected'].includes(application.status)) ? {status:'success'} : failed;
    }
    const task = await this.store.getPersonnelHandover(receipt.recordId, receipt.mutationId);
    if (!task || !sameTarget(task.payload.target, context) || task.payload.sourceOpenId !== context.from.openId ||
        receipt.itemKey !== `leave:${receipt.recordId}:${task.payload.sourceStageKey}:${task.payload.sourceStageVersion}` || receipt.version !== String(task.payload.targetStageVersion)) return failed;
    try { this.assertTarget(context); } catch { return failed; }
    if (options?.retryFailed) {
      try {await this.retryNativeTask(context,receipt,task);return this.reconcile(context,receipt);} catch {return failed;}
    }
    if (task.status === 'failed' || task.lastError) return {status:'error',error:'人员和卡片同步未完成，请恢复原交接任务'};
    if (task.status !== 'completed') return {status:'syncing'};
    const key = task.payload.sourceStageKey as LeaveWorkflowStage['key'], version = Number(task.payload.targetStageVersion);
    if (await this.store.getStageAction(receipt.recordId, key, version)) return {status:'success'};
    const stage = application.currentStage;
    if (!stage || stage.key !== key || stage.version !== version) return failed;
    return stage.approverOpenIds.every(openId => application.stageCards.some(card => card.recipientOpenId === openId && card.businessKey === `leave:${receipt.recordId}:stage:${key}:${version}:${openId}`)) ? {status:'success'} : {status:'syncing'};
  }
  private assertTarget(context: HandoverContext): void {
    if (!this.workflow.isEnabled() || !context.to.active || !context.from.openId || !context.to.openId || context.from.id === context.to.id || context.from.openId === context.to.openId || !/^rec[A-Za-z0-9_]+$/u.test(context.to.recordId)) throw new ConflictException('交接人员身份或工作流状态无效');
    assertFeishuBusinessIdentity(this.configuration, context.to.openId);
  }
  private async retryNativeTask(context:HandoverContext,receipt:TransferReceipt,task:LeaveWorkflowTaskEntry):Promise<void> {
    await this.store.retryFailedTasks([task.key],()=>{
      this.assertTarget(context);
      confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'leave',recordId:receipt.recordId,title:'请休假交接',dutyRecordId:String(task.payload.dutyRecordId),stageKey:'native_recovery',phase:'execution',status:'pending',version:receipt.version,recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);
    });
  }
  private futureInput(context:HandoverContext,item:PendingDuty,application:LeaveWorkflowApplicationEntry,mutationId:string):LeaveFutureManagerHandoverInput{
    const [revision,hash,version,...extra]=item.version.split(':'),duty=this.duty(context,application,'manager'),supervisor=application.approvalPlan?.stages.find(stage=>stage.key==='supervisor');
    if(item.module!=='leave'||item.recordId!==application.recordId||item.stageKey!=='future_manager'||item.phase!=='approval'||item.status!=='pending'||item.key!==`leave:${item.recordId}:future-manager:${revision}`||!duty||duty.kind!=='leave_manager'||duty.recordId!==item.dutyRecordId||extra.length||!Number.isSafeInteger(Number(revision))||Number(revision)<1||!Number.isSafeInteger(Number(version))||Number(version)<1||!/^[a-f0-9]{64}$/.test(hash)||!supervisor||leavePlanHash(application.approvalPlan)!==hash||!item.recipients.some(person=>person.openId===context.from.openId))throw new ConflictException('未来经理交接清单或版本不一致');
    return {recordId:item.recordId,mutationId,dutyRecordId:item.dutyRecordId,sourceOpenId:context.from.openId!,sourcePersonRecordId:context.from.recordId,expectedRevision:Number(revision),expectedCurrentStage:{key:'supervisor',version:Number(version),approverOpenIds:supervisor.approvers.map(person=>person.openId)},expectedPlanHash:hash,target:{name:context.to.name,openId:context.to.openId!,personRecordId:context.to.recordId,position:context.to.position,buildings:context.to.buildings}};
  }
  private futurePriorMatches(context:HandoverContext,item:PendingDuty,task:LeaveWorkflowTaskEntry):boolean{
    const request=task.payload.futureInput as unknown as LeaveFutureManagerHandoverInput|undefined;
    return !!request&&['verify_future_manager_handover','sync_personnel_handover'].includes(task.kind)&&task.payload.futureManager===true&&request.recordId===item.recordId&&request.mutationId===task.payload.mutationId&&request.dutyRecordId===item.dutyRecordId&&request.sourceOpenId===context.from.openId&&request.sourcePersonRecordId===context.from.recordId&&sameTarget(request.target,context)&&sameTarget(task.payload.target,context)&&item.key===`leave:${item.recordId}:future-manager:${request.expectedRevision}`&&item.version===`${request.expectedRevision}:${request.expectedPlanHash}:${request.expectedCurrentStage.version}`;
  }
  private async coveredApplications(context:HandoverContext):Promise<LeaveWorkflowApplicationEntry[]> {
    const snapshot=await this.store.personnelHandoverSnapshot();
    assertPriorHandoverClosed(context,'leave',snapshot.applications,snapshot.tasks);
    for (const application of snapshot.applications) assertLeaveHandoverCoverage(context,application,snapshot.tasks,this.supportsRoleNotifications());
    return snapshot.applications;
  }
  private async application(recordId: string): Promise<LeaveWorkflowApplicationEntry> {
    const application = await this.store.getApplication(recordId);
    if (!application) throw new ConflictException('请休假原审批记录不存在');
    return application;
  }
  private supportsRoleNotifications(): boolean { return typeof this.configuration.currentDutyRoutePeople === 'function'; }
  private expected(context: HandoverContext, item: PendingDuty, application: LeaveWorkflowApplicationEntry): LeaveWorkflowStage {
    const version = Number(item.version), key = item.stageKey;
    if (item.module !== 'leave' || item.recordId !== application.recordId || (key !== 'supervisor' && key !== 'manager') || !Number.isSafeInteger(version) || version < 1 || item.key !== `leave:${item.recordId}:${key}:${version}` || this.duty(context,application,key)?.recordId !== item.dutyRecordId) throw new ConflictException('交接审批阶段或职责不一致');
    const ids = item.recipients.map(person => person.openId);
    const priorActor = application.approvalPlan?.stages.find(stage => stage.key === key)?.approvers.find(person => person.openId === context.from.openId);
    if (priorActor?.personRecordId && priorActor.personRecordId !== context.from.recordId) throw new ConflictException('原审批人员稳定身份已变化');
    if (!ids.includes(context.from.openId!) || new Set(ids).size !== ids.length || !ids.every(id => /^ou_[A-Za-z0-9_-]{1,124}$/u.test(id))) throw new ConflictException('交接审批人快照无效');
    return { key, version, approverOpenIds: ids };
  }
  private duty(context: HandoverContext, application: LeaveWorkflowApplicationEntry, key: LeaveWorkflowStage['key']): AuthorityDuty | undefined {
    if (key === 'manager' && application.approvalPlan?.approvalClass === 'manager') return undefined;
    const kinds = key === 'supervisor' ? ['leave_supervisor','building_supervisor'] : ['leave_manager'];
    const matches = context.duties.filter(duty => kinds.includes(duty.kind) && (duty.personnelIds.includes(context.from.id) || duty.personnelIds.includes(context.to.id)) && authorityDutyMatchesTarget(duty,{building:application.snapshot.building}));
    const preferred = matches.filter(duty => duty.kind === kinds[0]), selected = preferred.length ? preferred : matches;
    if (selected.length > 1) throw new ConflictException('同一请休假阶段匹配多个职责，请先核对岗位');
    return selected[0];
  }
}

function itemKey(recordId: string, stage: LeaveWorkflowStage): string { return `leave:${recordId}:${stage.key}:${stage.version}`; }
function sameTarget(value: unknown, context: HandoverContext): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return target.openId === context.to.openId && target.personRecordId === context.to.recordId;
}
