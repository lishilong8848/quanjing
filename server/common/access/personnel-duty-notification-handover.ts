import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { HandoverContext, PendingDuty, PreflightResult, TransferReceipt, TransferResult } from '../../../shared/personnel-handover.interface';
import type { LeaveWorkflowApplicationEntry, LeaveWorkflowTaskEntry } from '../../modules/leave-workflow/leave-workflow.store';
import type { OvertimeWorkflowApplicationEntry, OvertimeWorkflowTaskEntry } from '../../modules/overtime-workflow/overtime-workflow.store';
import { leaveWorkflowDutyTarget, originalLeaveNotificationRoleRecipients } from '../../modules/leave-workflow/leave-workflow.rules';
import { overtimeApprovalDuty } from '../../modules/overtime-workflow/overtime-workflow.rules';
import { authorityDutyMatchesTarget } from './personnel-authority.duties';
import { confirmedPersonnelDutyTransferVersion } from './personnel-duty-transfer.receipt';
import { getAccessConfigurationStore } from './access-configuration.store';
import type { PersonnelDutyAssignment } from '../../../shared/personnel-duty-routing';

interface NotificationResponsibility {
  recordId: string;
  dutyRecordId: string;
  fingerprint: string;
  tasks: { key: string; status: string; lastError?: string }[];
  adjustmentRevision?: number;
}
type Module = 'leave' | 'overtime';
type Reader = (context: HandoverContext) => Promise<NotificationResponsibility[]>;
const leaveNoticeKinds = new Set(['deliver_result_cards', 'deliver_substitute_update_notifications', 'deliver_stage_substitute_change_notifications']);
const overtimeNoticeKinds = new Set(['notify_managers', 'apply_approval', 'apply_confirmation']);

export class PersonnelDutyNotificationHandover {
  constructor(private readonly module: Module, private readonly read: Reader, private readonly prepare?: (context: HandoverContext, item: PendingDuty, mutationId: string) => Promise<void>, private readonly retry?: (context: HandoverContext, item: PendingDuty, mutationId: string, keys: string[]) => Promise<void>) {}

  async listPending(context: HandoverContext): Promise<PendingDuty[]> {
    const rows = await this.read(context);
    return context.duties.filter(duty => rows.some(row => row.dutyRecordId === duty.recordId)).map(duty => this.item(context, duty,
      hash(rows.filter(row => row.dutyRecordId === duty.recordId).map(row => [row.recordId, row.fingerprint, row.tasks.map(task => task.key).sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))));
  }

  async preflight(context: HandoverContext, item: PendingDuty, mutationId?: string): Promise<PreflightResult> {
    try {
      this.assertItem(context, item);
      if (mutationId) {
        confirmedPersonnelDutyTransferVersion(context, item, mutationId);
        await this.read(context);
        return { ready: true };
      }
      const current = (await this.listPending(context)).find(row => row.key === item.key);
      return current?.version === item.version ? { ready: true } : { ready: false, alreadyCompleted: !current, reason: '原通知已经变化，请更新交接清单' };
    } catch { return { ready: false, reason: '通知职责或岗位事务未核对完成，请恢复原交接批次' }; }
  }

  async acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    this.assertItem(context, item);
    const proof = confirmedPersonnelDutyTransferVersion(context, item, mutationId);
    await this.prepare?.(context, item, mutationId);
    await this.read(context);
    return { itemKey: item.key, recordId: item.recordId, module: this.module, mutationId, version: `${item.version}:${proof}`, status: 'accepted' };
  }

  async reconcile(context: HandoverContext, receipt: TransferReceipt, options?: {retryFailed?:boolean}): Promise<TransferResult> {
    try {
      const [version, proof, ...extra] = receipt.version.split(':'), duty = context.duties.find(row => row.recordId === receipt.recordId);
      if (!duty || extra.length || !/^[a-f0-9]{64}$/.test(version) || !/^[a-f0-9]{64}$/.test(proof) || receipt.status !== 'accepted' || receipt.module !== this.module || receipt.itemKey !== this.key(duty.recordId)) throw new ConflictException();
      const item = this.item(context, duty, version);
      this.assertItem(context, item);
      if (confirmedPersonnelDutyTransferVersion(context, item, receipt.mutationId) !== proof) throw new ConflictException();
      const tasks = (await this.read(context)).filter(row => row.dutyRecordId === duty.recordId).flatMap(row => row.tasks);
      if (options?.retryFailed && tasks.some(task => task.status === 'failed' || task.status === 'pending' && task.lastError)) {
        if (!this.retry) throw new ConflictException('原通知恢复端口未就绪');
        await this.retry(context, item, receipt.mutationId, [...new Set(tasks.map(task => task.key))]);
        return this.reconcile(context, receipt);
      }
      if (tasks.some(task => task.status === 'failed' || task.lastError)) return { status: 'error', error: '原通知任务尚未恢复，请核对原通知投递' };
      return tasks.length ? { status: 'syncing' } : { status: 'success' };
    } catch { return { status: 'error', error: '通知岗位交接回执或原队列未核对完成，请恢复原批次' }; }
  }

  private assertItem(context: HandoverContext, item: PendingDuty): void {
    const kinds = this.module === 'leave' ? ['building_supervisor', 'leave_supervisor', 'leave_manager', 'professional_supervisor'] : ['building_supervisor', 'overtime_supervisor', 'overtime_manager', 'professional_supervisor'];
    if (!context.to.active || !context.from.openId || !context.to.openId || context.from.id === context.to.id || context.from.openId === context.to.openId ||
      item.module !== this.module || item.key !== this.key(item.recordId) || item.dutyRecordId !== item.recordId || item.stageKey !== 'role_notifications' || item.phase !== 'notification' || item.status !== 'pending' ||
      !/^[a-f0-9]{64}$/.test(item.version) || !context.duties.some(duty => duty.recordId === item.dutyRecordId && kinds.includes(duty.kind)) ||
      JSON.stringify(item.recipients) !== JSON.stringify([{ openId: context.from.openId, name: context.from.name }])) throw new ConflictException('通知交接人员或职责无效');
  }
  private key(dutyRecordId: string): string { return `${this.module}:role-notifications:${dutyRecordId}`; }
  private item(context: HandoverContext, duty: AuthorityDuty, version: string): PendingDuty {
    return { key: this.key(duty.recordId), recordId: duty.recordId, dutyRecordId: duty.recordId, module: this.module, stageKey: 'role_notifications', phase: 'notification', status: 'pending',
      title: `${duty.name} · 通知交接`, version, recipients: [{ openId: context.from.openId!, name: context.from.name }] };
  }
}

export function leaveNotificationResponsibilities(context: HandoverContext, snapshot: { applications: LeaveWorkflowApplicationEntry[]; tasks: LeaveWorkflowTaskEntry[] }): NotificationResponsibility[] {
  const rows: NotificationResponsibility[] = [];
  const assignments = getAccessConfigurationStore().read().personnelDutyAssignments;
  for (const application of snapshot.applications) {
    const active = ['accepted', 'supervisor_pending', 'manager_pending', 'routing_failed', 'sync_error', 'approved_syncing', 'rejected_syncing'].includes(application.status);
    if (!active && !(application.status === 'approved' && application.snapshot.substituteRequired && Date.parse(application.snapshot.endAt) >= Date.now()) &&
      !snapshot.tasks.some(task => task.recordId === application.recordId && task.status !== 'completed' && (leaveNoticeKinds.has(task.kind) || task.kind === 'deliver_substitute_adjustment_cards'))) continue;
    for (const duty of context.duties) {
      const kind = duty.kind === 'leave_manager' ? 'manager' : duty.kind === 'professional_supervisor' ? 'professional' : ['leave_supervisor', 'building_supervisor'].includes(duty.kind) ? 'supervisor' : null;
      if (!kind || !authorityDutyMatchesTarget(duty, leaveWorkflowDutyTarget(application))) continue;
      const recipients = originalLeaveNotificationRoleRecipients(application, kind);
      const bound = currentDutyBoundToTransfer(context, duty, assignments) && !(kind === 'manager' && application.approvalPlan?.approvalClass === 'manager');
      if (!recipients.length || !bound && !recipients.some(person => person.openId === context.from.openId || person.openId === context.to.openId)) continue;
      const stageRole = kind !== 'professional' && application.approvalPlan?.stages.some(stage => stage.key === kind && (bound || stage.approvers.some(person => person.openId === context.from.openId || person.openId === context.to.openId)));
      const tasks = snapshot.tasks.filter(task => task.recordId === application.recordId && task.status !== 'completed' && (leaveNoticeKinds.has(task.kind) || stageRole && task.kind === 'deliver_substitute_adjustment_cards'));
      const openAdjustment = stageRole && application.status === 'approved' && application.snapshot.substituteRequired && Date.parse(application.snapshot.endAt) >= Date.now();
      if (!active && !tasks.length && !openAdjustment) continue;
      const adjustmentRevision = openAdjustment ? application.snapshot.assignmentRevision ?? application.snapshot.substituteRevision ?? 0 : undefined;
      rows.push({ recordId: application.recordId, dutyRecordId: duty.recordId, fingerprint: hash([recipients, leaveWorkflowDutyTarget(application), adjustmentRevision ?? null]), tasks, ...(adjustmentRevision === undefined ? {} : { adjustmentRevision }) });
    }
  }
  return rows;
}

export function overtimeNotificationResponsibilities(context: HandoverContext, snapshot: { applications: OvertimeWorkflowApplicationEntry[]; tasks: OvertimeWorkflowTaskEntry[] }): NotificationResponsibility[] {
  const rows: NotificationResponsibility[] = [];
  const assignments = getAccessConfigurationStore().read().personnelDutyAssignments;
  for (const application of snapshot.applications) {
    if (application.phase === 'source_deleted') continue;
    const tasks = snapshot.tasks.filter(task => task.recordId === application.recordId && task.status !== 'completed' && overtimeNoticeKinds.has(task.kind));
    if (['confirmed', 'rejected'].includes(application.phase) && !tasks.length) continue;
    const route = overtimeApprovalDuty({ position: application.snapshot.position, buildings: [application.snapshot.building] });
    const specialty = ['电气', '暖通', '弱电', '消防', 'EHS'].find(value => application.snapshot.position.includes(value));
    const target = { building: [application.snapshot.building], ...(specialty ? { specialty } : {}) };
    for (const duty of context.duties) {
      if (!authorityDutyMatchesTarget(duty, target)) continue;
      const recipients = duty.kind === 'professional_supervisor' ? application.professionalRecipients || []
        : duty.kind === 'overtime_manager' ? [...application.managerRecipients, ...(route.kind === 'overtime_manager' ? application.approvers : [])]
        : ['overtime_supervisor', 'building_supervisor'].includes(duty.kind) && route.kind === 'overtime_supervisor' ? application.approvers : [];
      if (!recipients.length || !currentDutyBoundToTransfer(context, duty, assignments) && !recipients.some(person => person.openId === context.from.openId || person.openId === context.to.openId)) continue;
      rows.push({ recordId: application.recordId, dutyRecordId: duty.recordId, fingerprint: hash([recipients, target]), tasks });
    }
  }
  return rows;
}
function currentDutyBoundToTransfer(context: HandoverContext, duty: AuthorityDuty, assignments: Record<string, PersonnelDutyAssignment> | undefined): boolean {
  const assignment = assignments?.[duty.recordId];
  if (!duty.enabled || !assignment || assignment.appId !== process.env.FEISHU_APP_ID?.trim() || assignment.kind !== duty.kind || assignment.version !== duty.version ||
    assignment.startsAt !== duty.startsAt || assignment.endsAt !== duty.endsAt || JSON.stringify(assignment.buildings) !== JSON.stringify(duty.buildings) || JSON.stringify(assignment.specialties) !== JSON.stringify(duty.specialties)) return false;
  return [context.from, context.to].some(person => assignment.members.some(member => member.personId === person.id && member.recordId === person.recordId && member.openId === person.openId));
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
