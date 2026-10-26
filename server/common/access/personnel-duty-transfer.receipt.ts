import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { HandoverContext, PendingDuty } from '../../../shared/personnel-handover.interface';
import { getAccessConfigurationStore } from './access-configuration.store';
import { handoverItemMutationId } from './personnel-handover.store';
import { personnelDutyAssignmentFingerprint } from './personnel-duty-routing';
import { filterActivePersonnelDutyMembers } from './personnel-duty-current';

export function confirmedPersonnelDutyTransferVersion(context: HandoverContext, item: PendingDuty, mutationId: string): string {
  const state = getAccessConfigurationStore().read(), assignment = state.personnelDutyAssignments?.[item.dutyRecordId];
  const duty = context.duties.find(row => row.recordId === item.dutyRecordId);
  if (!duty || !assignment || assignment.appId !== process.env.FEISHU_APP_ID?.trim() || assignment.kind !== duty.kind || assignment.version !== duty.version ||
    assignment.startsAt !== duty.startsAt || assignment.endsAt !== duty.endsAt ||
    filterActivePersonnelDutyMembers(state, assignment.appId, [{ openId: context.to.openId!, name: context.to.name }]).length !== 1 ||
    JSON.stringify(assignment.buildings) !== JSON.stringify(duty.buildings) || JSON.stringify(assignment.specialties) !== JSON.stringify(duty.specialties) ||
    handoverItemMutationId(assignment.confirmedBatchId, item.key) !== mutationId ||
    !assignment.members.some(person => person.personId === context.to.id && person.recordId === context.to.recordId && person.openId === context.to.openId) ||
    assignment.members.some(person => person.openId === context.from.openId)) throw new ConflictException('岗位事务尚未生效或交接回执不一致');
  return createHash('sha256').update(JSON.stringify([item.key, item.version, personnelDutyAssignmentFingerprint(assignment), context.from.id, context.from.recordId,
    context.from.openId, context.to.id, context.to.recordId, context.to.openId, mutationId])).digest('hex');
}
