import { buildLeaveShiftCandidateSets, validateLeaveShiftAssignmentPlan } from '../../../server/modules/leave-workflow/leave-workflow.rules';
import { originalPostSignature } from '../../../server/modules/leave-workflow/leave-two-level-substitution';
import type { LeaveRequestImpactSchedule, LeaveRequestShiftGroup } from '../../../shared/leave-request-impact';
import type { LeaveSubstituteCandidate } from '../../../server/modules/leave-workflow/leave-workflow.types';

const person = (id: string, name: string): LeaveSubstituteCandidate => ({ personRecordId: id, name, openId: `ou_${id}`, position: '运维值班员', buildings: ['C楼'] });
export const applicant = person('rec_liang', '梁煊晨');
export const primary = person('rec_wu', '吴亚兵');
export const backup = person('rec_free', '张三');
export const replacement = person('rec_replacement', '李四');
export const group: LeaveRequestShiftGroup = {
  shiftKey: '2026-10-16T09:00__2026-10-16T18:00', scheduleDate: '2026-10-16', startAt: '2026-10-16T09:00', endAt: '2026-10-16T18:00', kind: 'white', shift: '白班', buildings: ['D楼'], teams: ['A班'], scheduleRecordIds: ['rec_schedule_d'], leaveHours: 9,
};
export const schedules: LeaveRequestImpactSchedule[] = [
  { recordId: 'rec_schedule_d', scheduleDate: group.scheduleDate, building: 'D楼', shift: '白班', dutyStaffActual: [applicant.name] },
  { recordId: 'rec_schedule_c', scheduleDate: group.scheduleDate, building: 'C楼', shift: '白班', dutyStaffActual: [primary.name, '同班同事'] },
];
export function fixture() {
  const candidateSets = buildLeaveShiftCandidateSets({ groups: [group], schedules, applicant, selectablePeople: [primary, backup, replacement], allowOnDutySubstitution: true });
  const originalGroups = candidateSets[0].twoLevelCandidates!.find(row => row.person.personRecordId === primary.personRecordId)!.originalGroups;
  const selection = { shiftKey: group.shiftKey, substitutePersonRecordId: primary.personRecordId, backfillPersonRecordId: backup.personRecordId, originalPostSignature: originalPostSignature(originalGroups) };
  const result = validateLeaveShiftAssignmentPlan({ groups: [group], candidateSets, selections: [selection], actorOpenId: 'ou_supervisor', actorName: '主管', changedAt: '2026-10-16T01:00:00.000Z' });
  if (result.valid === false) throw Error(result.message);
  const application = {
    clientMutationId: 'test-two-level-client', recordId: 'rec_leave_two_level',
    snapshot: {
      applicantName: applicant.name, applicantOpenId: applicant.openId, applicantPersonRecordId: applicant.personRecordId,
      building: 'D楼', position: applicant.position, leaveType: '年假', startAt: '2026-10-16T09:00:00+08:00', endAt: '2026-10-16T18:00:00+08:00', leaveHours: 9, approvalDayCount: 1, reason: 'TEST 两级替班',
      substituteRequired: true, shiftGroups: [group], candidateSets, shiftAssignments: [], assignmentRevision: 0,
    },
  };
  const plan = {
    approvalClass: 'ordinary' as const, discipline: null, approvalDayCount: 1,
    stages: [{ key: 'supervisor' as const, approvers: [{ name: '主管', openId: 'ou_supervisor', position: '主管', buildings: ['D楼'] }], resolutionPolicy: 'first_legal_action' as const }],
    notificationPlan: { finalResultRecipients: [], professionalRecipients: [], substituteRecipients: [] },
  };
  const cardContext = {
    recordId: application.recordId, applicationKey: `leave:${application.recordId}`, stageKey: 'supervisor' as const, stageVersion: 1,
    ...application.snapshot, candidateSets, shiftAssignments: [],
  };
  return { candidateSets, originalGroups, selection, assignments: result.assignments, application, plan, cardContext };
}
