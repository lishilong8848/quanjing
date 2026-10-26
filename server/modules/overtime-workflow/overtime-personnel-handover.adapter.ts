import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { HandoverAdapter, HandoverContext, PendingDuty, PreflightResult, TransferReceipt, TransferResult } from '../../../shared/personnel-handover.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { authorityDutyMatchesTarget } from '../../common/access/personnel-authority.duties';
import { assertOvertimeHandoverCoverage, assertPriorHandoverClosed } from '../../common/access/personnel-handover.coverage';
import { OvertimeWorkflowStore, overtimeConfirmationOwner, overtimeConfirmationGeneration, type OvertimeWorkflowApplicationEntry } from './overtime-workflow.store';
import { OvertimeWorkflowService } from './overtime-workflow.service';
import { PersonnelDutyNotificationHandover, overtimeNotificationResponsibilities } from '../../common/access/personnel-duty-notification-handover';
import { confirmedPersonnelDutyTransferVersion } from '../../common/access/personnel-duty-transfer.receipt';

@Injectable()
export class OvertimePersonnelHandoverAdapter implements HandoverAdapter {
  readonly module = 'overtime' as const;
  private readonly notifications: PersonnelDutyNotificationHandover;
  constructor(private readonly store: OvertimeWorkflowStore, private readonly configuration: AccessConfigurationService, private readonly workflow: OvertimeWorkflowService) {
    this.notifications = new PersonnelDutyNotificationHandover(this.module, async context => overtimeNotificationResponsibilities(context, await this.store.personnelHandoverSnapshot()), undefined,
      async(context,item,mutationId,keys)=>this.store.retryFailedTasks(keys,()=>{this.assertTarget(context);confirmedPersonnelDutyTransferVersion(context,item,mutationId);}));
  }
  async listPending(context: HandoverContext): Promise<PendingDuty[]> {
    if (!this.workflow.isEnabled()) throw new ServiceUnavailableException('加班工作流未启用');
    const items: PendingDuty[] = [];
    for (const application of await this.coveredApplications(context)) {
      if (context.from.openId && application.phase === 'awaiting_confirmation' && overtimeConfirmationOwner(application) === context.from.openId) {
        const duty = await this.duty(context, application); if (!duty) continue;
        const confirmation = await this.store.getConfirmation(application.recordId);
        const uncertain = (await this.store.listTasks()).some(task => task.recordId === application.recordId && task.kind === 'deliver_confirmation' && task.attempts > 0 && task.status !== 'completed');
        items.push({ key: `overtime:${application.recordId}:confirmation`, module: 'overtime', recordId: application.recordId,
          title: `${application.snapshot.applicantName} · 加班确认`, dutyRecordId: duty.recordId, phase: uncertain ? 'reconcile' : 'execution', stageKey: 'confirmation', version: String(application.revision),
          status: confirmation ? 'in_progress' : 'pending', recipients: [{ name: application.confirmationResponsible?.name ?? application.actualApproverName, openId: context.from.openId }] });
        continue;
      }
      if (!context.from.openId || !application.approvers.some(person => person.openId === context.from.openId)) continue;
      const duty = await this.duty(context,application); if (!duty) continue;
      const action = await this.store.getApprovalAction(application.recordId);
      items.push({key:`overtime:${application.recordId}:approval`,module:'overtime',recordId:application.recordId,
        title:`${application.snapshot.applicantName} · 加班`,dutyRecordId:duty.recordId,phase:'approval',stageKey:'approval',version:String(application.revision),
        status:action?'in_progress':application.phase==='approval_pending'?'pending':'terminal',recipients:application.approvers.map(({name,openId})=>({name,openId}))});
    }
    return this.supportsRoleNotifications() ? [...items, ...await this.notifications.listPending(context)] : items;
  }
  async preflight(context: HandoverContext, item: PendingDuty, mutationId?:string): Promise<PreflightResult> {
    if (item.stageKey === 'role_notifications') {
      try { this.assertTarget(context); if (!this.supportsRoleNotifications()) throw new ConflictException(); return this.notifications.preflight(context, item, mutationId); }
      catch { return { ready: false, reason: '当前通知岗位未就绪，请恢复原配置后重试' }; }
    }
    try {
      this.assertTarget(context); const application=await this.application(item.recordId); await this.assertItem(context,item,application);
      if (mutationId) {
        const confirmation=item.stageKey==='confirmation',prior=(await this.store.listTasks()).find(task=>task.businessKey===`overtime:${item.recordId}:${confirmation?'confirmation:':''}${mutationId}`);
        if (prior) return {ready:prior.kind===(confirmation?'sync_confirmation_handover':'sync_approval_handover') && sameTarget(prior.payload.target,context) && prior.payload.sourceOpenId===context.from.openId && prior.payload.sourcePersonRecordId===context.from.recordId && prior.payload.dutyRecordId===item.dutyRecordId};
      }
      const acted=item.stageKey==='confirmation' ? await this.store.getConfirmation(item.recordId) : await this.store.getApprovalAction(item.recordId);
      if (acted || (item.stageKey==='confirmation' ? application.phase==='confirmed' : ['awaiting_confirmation','confirmed','rejected'].includes(application.phase))) return {ready:false,alreadyCompleted:true,reason:'原加班事项已受理，保留原处理和历史'};
      await this.coveredApplications(context);
      if (!application.snapshot.applicantOpenId) return {ready:false,reason:'申请人身份尚未明确，请先核对原申请'};
      if (application.snapshot.applicantOpenId===context.to.openId) return {ready:false,reason:'接任人不能审批自己的申请'};
      if (item.stageKey === 'confirmation') {
        if (application.phase !== 'awaiting_confirmation' || overtimeConfirmationOwner(application) !== context.from.openId || await this.store.getConfirmation(item.recordId)) return { ready: false, reason: '原加班确认已受理或负责人已变化，请更新交接清单' };
        if (application.revision !== Number(item.version)) return { ready: false, reason: '加班确认版本已变化，请重新预览' };
        if ((await this.store.listTasks()).some(task => task.recordId === item.recordId && task.kind === 'deliver_confirmation' && task.attempts > 0 && task.status !== 'completed')) return { ready: false, reason: '原确认卡片投递结果尚未明确，请先恢复原投递' };
        return { ready: true };
      }
      if (application.phase!=='approval_pending'||await this.store.getApprovalAction(item.recordId)) return {ready:false,reason:'原加班审批已受理，请更新交接清单'};
      if (application.revision!==Number(item.version)) return {ready:false,reason:'加班审批版本已变化，请重新预览'};
      return {ready:true};
    } catch { return {ready:false,reason:'加班人员、职责或审批阶段已变化，请核对后重试'}; }
  }
  async acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    if (item.stageKey === 'role_notifications') {
      this.assertTarget(context); if (!this.supportsRoleNotifications()) throw new ConflictException('通知岗位未就绪');
      return this.notifications.acceptTransfer(context, item, mutationId);
    }
    this.assertTarget(context); const application=await this.application(item.recordId); await this.assertItem(context,item,application);
    if (!application.snapshot.applicantOpenId) throw new ConflictException('申请人身份尚未明确，请先核对原申请');
    const isConfirmation = item.stageKey === 'confirmation';
    const prior=(await this.store.listTasks()).find(task=>task.businessKey===`overtime:${item.recordId}:${isConfirmation ? 'confirmation:' : ''}${mutationId}`);
    const acted=isConfirmation ? await this.store.getConfirmation(item.recordId) : await this.store.getApprovalAction(item.recordId);
    if (!prior && !acted && !(isConfirmation ? application.phase==='confirmed' : ['awaiting_confirmation','confirmed','rejected'].includes(application.phase))) await this.coveredApplications(context);
    if (prior && (prior.kind!==(isConfirmation ? 'sync_confirmation_handover' : 'sync_approval_handover')||!sameTarget(prior.payload.target,context)||prior.payload.sourceOpenId!==context.from.openId||prior.payload.sourcePersonRecordId!==context.from.recordId||prior.payload.dutyRecordId!==item.dutyRecordId)) throw new ConflictException('加班交接回执身份不一致');
    const target={name:context.to.name,openId:context.to.openId!,position:context.to.position,buildings:context.to.buildings,personRecordId:context.to.recordId};
    const input = {recordId:item.recordId,mutationId,dutyRecordId:item.dutyRecordId,sourceOpenId:context.from.openId!,sourcePersonRecordId:context.from.recordId,expectedRevision:Number(item.version),target:prior?prior.payload.target as typeof target:target};
    const guard = this.supportsRoleNotifications() ? () => { confirmedPersonnelDutyTransferVersion(context, item, mutationId); return true; } : undefined;
    const result = isConfirmation ? guard ? await this.store.acceptConfirmationHandover(input, guard) : await this.store.acceptConfirmationHandover(input)
      : guard ? await this.store.acceptApprovalHandover(input, guard) : await this.store.acceptApprovalHandover(input);
    return {itemKey:item.key,mutationId,module:'overtime',recordId:item.recordId,version:String(result.generation),status:result.status};
  }
  async reconcile(context: HandoverContext, receipt: TransferReceipt, options?: {retryFailed?:boolean}): Promise<TransferResult> {
    if (receipt.itemKey.startsWith('overtime:role-notifications:')) {
      try { this.assertTarget(context); if (!this.supportsRoleNotifications()) throw new ConflictException(); return this.notifications.reconcile(context, receipt, options); }
      catch { return { status: 'error', error: '当前通知岗位或接任人员已变化，请核对后恢复' }; }
    }
    const failed: TransferResult={status:'error',error:'加班交接回执或人员状态不一致，请核对后恢复'};
    if (receipt.module === 'overtime' && receipt.itemKey === `overtime:${receipt.recordId}:confirmation`) {
      if (receipt.status === 'already_completed') return (await this.store.getConfirmation(receipt.recordId))?.actorOpenId === context.from.openId ? { status: 'success' } : failed;
      const tasks = await this.store.listTasks(), task = tasks.find(entry => entry.businessKey === `overtime:${receipt.recordId}:confirmation:${receipt.mutationId}`);
      if (!task || task.kind !== 'sync_confirmation_handover' || !sameTarget(task.payload.target, context) || task.payload.sourceOpenId !== context.from.openId || task.payload.sourcePersonRecordId !== context.from.recordId || receipt.version !== String(task.payload.targetGeneration)) return failed;
      const application = await this.application(receipt.recordId);
      if (overtimeConfirmationGeneration(application) !== Number(receipt.version) || overtimeConfirmationOwner(application) !== context.to.openId || application.confirmationResponsible?.personRecordId !== context.to.recordId) return failed;
      if ((await this.store.getConfirmation(receipt.recordId))?.actorOpenId === context.to.openId) return { status: 'success' };
      try { this.assertTarget(context); } catch { return failed; }
      const related = tasks.filter(entry => entry.recordId === receipt.recordId && entry.kind === 'sync_confirmation_handover' && entry.payload.targetGeneration === Number(receipt.version));
      if (options?.retryFailed) {try {await this.retryNativeTasks(context,receipt,task,related.map(row=>row.key));return this.reconcile(context,receipt);}catch{return failed;}}
      if (related.some(entry => entry.status === 'failed' || entry.lastError)) return { status: 'error', error: '原确认卡片或新负责人投递尚未完成，请恢复原交接任务' };
      if (related.some(entry => entry.status !== 'completed')) return { status: 'syncing' };
      return application.confirmationCards.some(card => card.recipientOpenId === context.to.openId && card.businessKey === `overtime:${receipt.recordId}:confirmation:initial:v${receipt.version}`) ? { status: 'success' } : { status: 'syncing' };
    }
    if(receipt.module!=='overtime'||receipt.itemKey!==`overtime:${receipt.recordId}:approval`)return failed;
    if(receipt.status==='already_completed')return await this.store.getApprovalAction(receipt.recordId)?{status:'success'}:failed;
    const task=(await this.store.listTasks()).find(entry=>entry.businessKey===`overtime:${receipt.recordId}:${receipt.mutationId}`);
    if(!task||task.kind!=='sync_approval_handover'||!sameTarget(task.payload.target,context)||task.payload.sourceOpenId!==context.from.openId||task.payload.sourcePersonRecordId!==context.from.recordId||receipt.version!==String(task.payload.targetGeneration))return failed;
    try{this.assertTarget(context);}catch{return failed;}
    if (options?.retryFailed) {try {await this.retryNativeTasks(context,receipt,task,[task.key]);return this.reconcile(context,receipt);}catch{return failed;}}
    if(task.status==='failed'||task.lastError)return {status:'error',error:'旧卡片或新负责人投递尚未完成，请恢复原交接任务'};
    if(task.status!=='completed')return {status:'syncing'};
    const application=await this.application(receipt.recordId);
    if(await this.store.getApprovalAction(receipt.recordId))return {status:'success'};
    if(application.approvalGeneration!==Number(receipt.version))return failed;
    return application.approvers.every(person=>application.approvalCards.some(card=>card.recipientOpenId===person.openId&&card.businessKey===`overtime:${receipt.recordId}:approval:v${receipt.version}:${person.openId}`))?{status:'success'}:{status:'syncing'};
  }
  private assertTarget(context:HandoverContext):void{
    if(!this.workflow.isEnabled()||!context.to.active||!context.from.openId||!context.to.openId||context.from.id===context.to.id||context.from.openId===context.to.openId||!/^rec[A-Za-z0-9_]+$/u.test(context.to.recordId))throw new ConflictException('加班交接人员身份无效');
    assertFeishuBusinessIdentity(this.configuration,context.to.openId);
  }
  private async retryNativeTasks(context:HandoverContext,receipt:TransferReceipt,task:{payload:Record<string,unknown>},keys:string[]):Promise<void>{
    await this.store.retryFailedTasks(keys,()=>{this.assertTarget(context);confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'overtime',recordId:receipt.recordId,title:'加班交接',dutyRecordId:String(task.payload.dutyRecordId),stageKey:'native_recovery',phase:'execution',status:'pending',version:receipt.version,recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);});
  }
  private async coveredApplications(context:HandoverContext):Promise<OvertimeWorkflowApplicationEntry[]> {
    const snapshot=await this.store.personnelHandoverSnapshot();
    assertPriorHandoverClosed(context,'overtime',snapshot.applications,snapshot.tasks);
    for (const application of snapshot.applications) assertOvertimeHandoverCoverage(context,application,snapshot.tasks,this.supportsRoleNotifications());
    return snapshot.applications;
  }
  private async application(recordId:string):Promise<OvertimeWorkflowApplicationEntry>{const result=await this.store.getApplication(recordId);if(!result)throw new ConflictException('原加班审批记录不存在');return result;}
  private supportsRoleNotifications(): boolean { return typeof this.configuration.currentDutyRoutePeople === 'function'; }
  private async assertItem(context:HandoverContext,item:PendingDuty,application:OvertimeWorkflowApplicationEntry):Promise<void>{
    if(item.module!=='overtime'||item.recordId!==application.recordId||!['approval','confirmation'].includes(item.stageKey)||item.key!==`overtime:${item.recordId}:${item.stageKey}`||!Number.isSafeInteger(Number(item.version))||Number(item.version)<1||(await this.duty(context,application))?.recordId!==item.dutyRecordId)throw new ConflictException('加班交接职责或版本不一致');
  }
  private async duty(context:HandoverContext,application:OvertimeWorkflowApplicationEntry):Promise<AuthorityDuty|undefined>{
    const route=(await this.store.listTasks()).find(task=>task.recordId===application.recordId&&task.kind==='deliver_approval_cards'&&typeof task.payload.routeKind==='string')?.payload.routeKind;
    if(!['building_supervisor','h_duty_supervisor','station_110_electrical_supervisor','manager_group'].includes(String(route)))throw new ServiceUnavailableException('原加班审批岗位证据缺失，请先核对原路由');
    const kinds=route==='manager_group'?['overtime_manager']:['overtime_supervisor','building_supervisor'];
    const matches=context.duties.filter(duty=>kinds.includes(duty.kind)&&(duty.personnelIds.includes(context.from.id)||duty.personnelIds.includes(context.to.id))&&authorityDutyMatchesTarget(duty,{building:application.snapshot.building}));
    const preferred=matches.filter(duty=>duty.kind===kinds[0]),selected=preferred.length?preferred:matches;
    if(selected.length>1)throw new ConflictException('原加班审批匹配多个职责，请先核对岗位');return selected[0];
  }
}

function sameTarget(value:unknown,context:HandoverContext):boolean{if(!value||typeof value!=='object'||Array.isArray(value))return false;const target=value as Record<string,unknown>;return target.openId===context.to.openId&&target.personRecordId===context.to.recordId;}
