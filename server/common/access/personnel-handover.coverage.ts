import { ConflictException } from '@nestjs/common';
import type { HandoverContext } from '../../../shared/personnel-handover.interface';
import type { LeaveWorkflowApplicationEntry, LeaveWorkflowTaskEntry } from '../../modules/leave-workflow/leave-workflow.store';
import type { OvertimeWorkflowApplicationEntry, OvertimeWorkflowTaskEntry } from '../../modules/overtime-workflow/overtime-workflow.store';
import { authorityDutyMatchesTarget } from './personnel-authority.duties';
import {assertFutureManagerRoles,assertFutureManagerTasks} from '../../modules/leave-workflow/leave-future-manager-handover';

type LeaveEntry=Pick<LeaveWorkflowApplicationEntry,'recordId'|'status'|'approvalPlan'|'currentStage'|'resultRecipients'> & Partial<Pick<LeaveWorkflowApplicationEntry,'stageCards'|'resultCards'|'substituteAdjustmentCards'>> & {snapshot:Partial<LeaveWorkflowApplicationEntry['snapshot']>&Pick<LeaveWorkflowApplicationEntry['snapshot'],'building'>};
type LeaveTask=Pick<LeaveWorkflowTaskEntry,'recordId'|'kind'|'status'>;
type OvertimeEntry=Pick<OvertimeWorkflowApplicationEntry,'recordId'|'phase'|'approvers'|'managerRecipients'|'professionalRecipients'|'confirmationResponsible'|'actualApproverOpenId'> & {snapshot:Pick<OvertimeWorkflowApplicationEntry['snapshot'],'building'>};
type OvertimeTask=Pick<OvertimeWorkflowTaskEntry,'recordId'|'kind'|'status'>;
const leaveNotifications=new Set<LeaveTask['kind']>(['deliver_result_cards','deliver_substitute_adjustment_cards','deliver_substitute_update_notifications','deliver_stage_substitute_change_notifications']);

function inScope(context:HandoverContext,module:'leave'|'overtime',building:string):boolean {
  const kinds=module==='leave' ? ['building_supervisor','leave_supervisor','leave_manager'] : ['building_supervisor','overtime_supervisor','overtime_manager'];
  return context.duties.some(duty=>duty.enabled && kinds.includes(duty.kind) && (duty.personnelIds.includes(context.from.id)||duty.personnelIds.includes(context.to.id)) && authorityDutyMatchesTarget(duty,{building}));
}

export function assertPriorHandoverClosed(context:HandoverContext,module:'leave'|'overtime',applications:readonly {recordId:string;snapshot:{building:string}}[],tasks:readonly {recordId:string;kind:string;status:string;payload:Record<string,unknown>}[]):void {
  for (const task of tasks) {
    if (!task.kind.includes('handover') || task.status==='completed' || task.payload.patchOnly===true) continue;
    const application=applications.find(value=>value.recordId===task.recordId);
    if (!application || !inScope(context,module,application.snapshot.building)) continue;
    const target=task.payload.target as {openId?:unknown}|undefined;
    if (task.payload.sourceOpenId===context.from.openId && target?.openId===context.to.openId) continue;
    throw new ConflictException('相关审批的上一交接尚未收口，请先恢复原交接，不能继续授予新接任者权限');
  }
}

export function assertLeaveHandoverCoverage(context:HandoverContext,application:LeaveEntry,tasks:readonly LeaveTask[],managedNotifications=false):void {
  const source=context.from.openId;
  if (!source || !inScope(context,'leave',application.snapshot.building)) return;
  const futureManager=context.duties.some(duty=>duty.kind==='leave_manager'&&duty.specialties===null&&(duty.personnelIds.includes(context.from.id)||duty.personnelIds.includes(context.to.id))&&authorityDutyMatchesTarget(duty,{building:application.snapshot.building}));
  assertLeaveApplicationCoverage(source,application,tasks,futureManager,managedNotifications);
}
export function assertLeaveApplicationCoverage(source:string,application:LeaveEntry,tasks:readonly LeaveTask[],futureManager=false,managedNotifications=false):void {
  const active=['accepted','supervisor_pending','manager_pending','routing_failed','sync_error'].includes(application.status);
  const plan=application.approvalPlan,current=application.currentStage;
  if (active && (!plan || !current)) throw new ConflictException('请休假存在尚未明确的审批路由，请恢复原申请路由后重新预览');
  const index=plan?.stages.findIndex(stage=>stage.key===current?.key) ?? -1;
  if (active && index<0) throw new ConflictException('请休假当前阶段与审批计划不一致，请先核对原路由');
  if (active && plan!.stages.slice(index+1).some(stage=>stage.approvers.some(person=>person.openId===source))) {
    if(!futureManager)throw new ConflictException('请休假存在前任尚未开始的审批阶段，本批暂不支持转交，请先完成或调整原路由');
    assertFutureManagerRoles(source,application,managedNotifications);assertFutureManagerTasks(application.recordId,tasks);return;
  }
  const recipients=application.resultRecipients.some(person=>person.openId===source) || !!plan?.notificationPlan.finalResultRecipients.some(person=>person.openId===source);
  const ownCurrent=active && current?.approverOpenIds.includes(source);
  const pendingNotice=tasks.some(task=>task.recordId===application.recordId && task.status!=='completed' && leaveNotifications.has(task.kind));
  if (!managedNotifications && recipients && (pendingNotice || active && !ownCurrent || ['approved_syncing','rejected_syncing'].includes(application.status))) throw new ConflictException('请休假存在尚未完成或尚未开始的独立通知，本批暂不支持转交，请先核对并完成原通知');
}

export function assertOvertimeHandoverCoverage(context:HandoverContext,application:OvertimeEntry,tasks:readonly OvertimeTask[],managedNotifications=false):void {
  const source=context.from.openId;
  if (!source || !inScope(context,'overtime',application.snapshot.building) || application.phase==='source_deleted') return;
  assertOvertimeApplicationCoverage(source,application,tasks,managedNotifications);
}
export function assertOvertimeApplicationCoverage(source:string,application:OvertimeEntry,tasks:readonly OvertimeTask[],managedNotifications=false):void {
  if (application.phase==='pending_approval') throw new ConflictException('加班存在尚未明确的审批路由，请恢复原申请路由后重新预览');
  const approver=application.approvers.some(person=>person.openId===source),manager=application.managerRecipients.some(person=>person.openId===source),professional=application.professionalRecipients?.some(person=>person.openId===source);
  const ownApproval=application.phase==='approval_pending' && approver;
  const ownConfirmation=application.phase==='awaiting_confirmation' && (application.confirmationResponsible?.openId ?? application.actualApproverOpenId)===source;
  const unfinished=tasks.some(task=>task.recordId===application.recordId && task.status!=='completed' && ['notify_managers','apply_approval','apply_confirmation'].includes(task.kind));
  if (!managedNotifications && ((manager || professional) && (!['confirmed','rejected'].includes(application.phase) || unfinished) || approver && !ownApproval && !ownConfirmation && (['approved','awaiting_confirmation'].includes(application.phase) || unfinished))) throw new ConflictException('加班存在独立经理、专业或结果通知，本批暂不支持全部转交，请先核对并完成原通知');
}
