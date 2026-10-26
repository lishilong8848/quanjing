import { buildLeaveShiftCandidateSets, validateLeaveShiftAssignmentPlan } from '../../server/modules/leave-workflow/leave-workflow.rules';
import * as twoLevel from '../../server/modules/leave-workflow/leave-two-level-substitution';
import type { LeaveRequestImpactSchedule, LeaveRequestShiftGroup } from '../../shared/leave-request-impact';
import type { LeaveSubstituteCandidate } from '../../server/modules/leave-workflow/leave-workflow.types';

const person = (id: string, name: string): LeaveSubstituteCandidate => ({ personRecordId: id, name, openId: `ou_${id}`, position: '运维值班员', buildings: ['C楼'] });
const applicant = person('rec_liang', '梁煊晨');
const wu = person('rec_wu', '吴亚兵');
const free = person('rec_free', '示例人员008');
const group: LeaveRequestShiftGroup = {
  shiftKey: '2026-10-16T09:00__2026-10-16T18:00', scheduleDate: '2026-10-16', startAt: '2026-10-16T09:00', endAt: '2026-10-16T18:00', kind: 'white', shift: '白班', buildings: ['D楼'], teams: ['A班'], scheduleRecordIds: ['rec_schedule_d'], leaveHours: 9,
};
const schedules: LeaveRequestImpactSchedule[] = [
  { recordId: 'rec_schedule_d', scheduleDate: '2026-10-16', building: 'D楼', shift: '白班', dutyStaffActual: [applicant.name] },
  { recordId: 'rec_schedule_c', scheduleDate: '2026-10-16', building: 'C楼', shift: '白班', dutyStaffActual: [wu.name] },
];
const candidateSets = (rows = schedules, enabled = true): any => buildLeaveShiftCandidateSets({ groups: [group], schedules: rows, applicant, selectablePeople: [wu, free], allowOnDutySubstitution: enabled } as any);
const options = () => twoLevel.buildTwoLevelSubstituteCandidates({ group, schedules, applicant, people: [wu, free] });
const signature = (groups: LeaveRequestShiftGroup[]): string => {
  expect(typeof (twoLevel as any).originalPostSignature).toBe('function');
  return (twoLevel as any).originalPostSignature(groups);
};
const selection = (): any => ({ shiftKey: group.shiftKey, substitutePersonRecordId: wu.personRecordId, backfillPersonRecordId: free.personRecordId, originalPostSignature: signature(options().find(row => row.person.personRecordId === wu.personRecordId)!.originalGroups) });
const validate = (selections: any[], sets = candidateSets(), groups = [group]) => validateLeaveShiftAssignmentPlan({ groups, selections, candidateSets: sets, actorOpenId: 'ou_approver', actorName: '审批人', changedAt: '2026-10-16T01:00:00.000Z' });

describe('two-level assignments through existing leave rules', () => {
  it('keeps the historical free-person-only builder behavior unless explicitly enabled', () => {
    expect(candidateSets(schedules, false)[0].candidates.map((row: any) => row.personRecordId)).toEqual(['rec_free']);
  });
  it('exposes original posts and backup choices through the actual candidate-set entry', () => {
    const set = candidateSets()[0];
    expect(set.candidates.map((row: any) => row.personRecordId)).toContain('rec_wu');
    expect(set.twoLevelCandidates.find((row: any) => row.person.personRecordId === 'rec_wu').originalGroups[0].scheduleRecordIds).toEqual(['rec_schedule_c']);
  });
  it('rejects on-duty selection without a backup instead of persisting a partially covered plan', () => {
    const choices = options();
    const sets: any = [{ shiftKey: group.shiftKey, candidates: choices.map(row => row.person), twoLevelCandidates: choices }];
    expect(validate([{ shiftKey: group.shiftKey, substitutePersonRecordId: wu.personRecordId }], sets).valid).toBe(false);
  });
  it('persists both posts and stable people identities in the same assignment decision', () => {
    const result = validate([selection()]);
    expect(result).toMatchObject({ valid: true, assignments: [{ substitutePersonRecordId: 'rec_wu', originalPostBackfills: [{ substitutePersonRecordId: 'rec_free', substituteOpenId: free.openId, group: { scheduleRecordIds: ['rec_schedule_c'], buildings: ['C楼'] } }] }] });
  });
  it('preserves the original-post backup validation message without accepting an incomplete plan', () => {
    expect(validate([{ ...selection(), backfillPersonRecordId: 'rec_unknown_backup' }])).toMatchObject({ valid: false, message: '请为替班人员的原岗位选择可用补位人员' });
  });
  it('rejects a changed original post rather than silently applying an old backup selection', () => {
    const oldSelection = selection();
    const changed = [{ ...schedules[0] }, { ...schedules[1], recordId: 'rec_schedule_c_changed', building: 'B楼' }];
    expect(validate([oldSelection], candidateSets(changed)).valid).toBe(false);
  });
  it('rejects a backup whose current schedule became occupied', () => {
    const oldSelection = selection();
    const changed = [...schedules, { recordId: 'rec_free_duty', scheduleDate: '2026-10-16', building: 'A楼', shift: '白班', dutyStaffActual: [free.name] }];
    expect(validate([oldSelection], candidateSets(changed)).valid).toBe(false);
  });
  it('checks backup occupancy against primary assignments from other overlapping leave groups', () => {
    const otherGroup = { ...group, shiftKey: '2026-10-16T09:00__2026-10-16T17:00', endAt: '2026-10-16T17:00', scheduleRecordIds: ['rec_other'] };
    const sets = [...candidateSets(), { shiftKey: otherGroup.shiftKey, candidates: [free] }];
    expect(validate([selection(), { shiftKey: otherGroup.shiftKey, substitutePersonRecordId: free.personRecordId }], sets, [group, otherGroup]).valid).toBe(false);
  });
  it('does not regard a long-day employee as a free second-level backup', () => {
    const rows = [...schedules, { recordId: 'rec_long_white', scheduleDate: '2026-10-16', building: 'A楼', shift: '长白', dutyStaffActual: [free.name] }];
    expect(twoLevel.buildTwoLevelSubstituteCandidates({ group, schedules: rows, applicant, people: [wu, free] }).some(row => row.person.personRecordId === wu.personRecordId)).toBe(false);
  });
});
