import {ConflictException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {LeaveWorkflowApplicationEntry,LeaveWorkflowTaskEntry} from './leave-workflow.store';
import type {LeaveApprovalPlan} from './leave-workflow.types';

export const leavePlanHash=(plan:LeaveApprovalPlan|null):string=>createHash('sha256').update(JSON.stringify(plan)).digest('hex');
type Candidate=Pick<LeaveWorkflowApplicationEntry,'approvalPlan'|'currentStage'|'status'|'resultRecipients'> & Partial<Pick<LeaveWorkflowApplicationEntry,'stageCards'|'resultCards'|'substituteAdjustmentCards'>> & {snapshot:Partial<LeaveWorkflowApplicationEntry['snapshot']>&{building:string}};
type Task=Pick<LeaveWorkflowTaskEntry,'recordId'|'kind'|'status'> & Partial<Pick<LeaveWorkflowTaskEntry,'payload'>>;

export function assertFutureManagerRoles(source:string,application:Candidate,managedRoles=false):void{
  const plan=application.approvalPlan,stages=plan?.stages;
  if(!plan||stages?.length!==2||stages[0].key!=='supervisor'||stages[1].key!=='manager'||!/^ou_[A-Za-z0-9_-]+$/.test(application.snapshot.applicantOpenId||''))throw new ConflictException('未来经理审批计划尚未明确');
  if(!stages[1].approvers.some(person=>person.openId===source)||new Set(stages[1].approvers.map(person=>person.openId)).size!==stages[1].approvers.length)throw new ConflictException('未来经理审批人已变化或重复');
  if(application.snapshot.applicantOpenId===source||!managedRoles&&(stages[0].approvers.some(person=>person.openId===source)||application.snapshot.applicantNotificationOpenIds?.includes(source)||application.snapshot.substituteOpenId===source||application.snapshot.shiftAssignments?.some(value=>value.substituteOpenId===source)||plan.notificationPlan.professionalRecipients.some(person=>person.openId===source)||plan.notificationPlan.substituteRecipients.some(person=>person.openId===source)))throw new ConflictException('前任兼任当前审批、申请人或独立通知职责，不能按未来经理整体替换');
  if(application.resultCards?.length||application.substituteAdjustmentCards?.length)throw new ConflictException('已存在结果通知投递，请先核对原通知');
}

export function assertFutureManagerTasks(recordId:string,tasks:readonly Task[],currentManagerVersion?:number):void{
  if(tasks.some(task=>task.recordId===recordId&&task.status!=='completed'&&!(currentManagerVersion!==undefined&&task.kind==='deliver_stage_cards'&&task.payload?.stageKey==='manager'&&task.payload.stageVersion===currentManagerVersion)))throw new ConflictException('原审批或通知任务尚未同步完成，请先恢复原任务');
}
