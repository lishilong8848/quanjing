import * as impact from '../../shared/leave-request-impact';
import { buildLeaveShiftCandidateSets } from '../../server/modules/leave-workflow/leave-workflow.rules';
import { buildTwoLevelSubstituteCandidates } from '../../server/modules/leave-workflow/leave-two-level-substitution';
import { fixture, group, applicant, primary, backup, replacement, schedules } from './fixtures/leave-two-level';

describe('leave approval candidate calculation scope', () => {
  const people = [primary, backup, replacement];
  it('validates only the selected chain while retaining the same full-calculation result', () => {
    const selection = fixture().selection;
    const result = buildLeaveShiftCandidateSets({ groups: [group], schedules, applicant, selectablePeople: people, allowOnDutySubstitution: true, selections: [selection] } as any);
    const full = fixture().candidateSets[0].twoLevelCandidates!.find(row => row.person.personRecordId === primary.personRecordId)!;
    expect(result[0].twoLevelCandidates).toEqual([{ ...full, backfillCandidates: [backup] }]);
  });
  it('does not hide an ambiguous identity by narrowing the requested people first', () => {
    const result = buildLeaveShiftCandidateSets({ groups: [group], schedules, applicant, selectablePeople: [...people, { ...primary, personRecordId: 'rec_duplicate', openId: 'ou_duplicate' }], allowOnDutySubstitution: true, selections: [fixture().selection] } as any);
    expect(result[0].candidates).toEqual([]);
  });
  it('does not calculate the same original-schedule impact repeatedly for backup choices', () => {
    const spy = jest.spyOn(impact, 'calculateLeaveRequestImpact');
    const otherPrimary = { ...primary, personRecordId: 'rec_second', openId: 'ou_second', name: 'TEST第二替班' };
    const rows = [schedules[0], { ...schedules[1], dutyStaffActual: [primary.name, otherPrimary.name] }];
    try {
      buildTwoLevelSubstituteCandidates({ group, schedules: rows, applicant, people: [...people, otherPrimary] });
      const keys = spy.mock.calls.map(([_schedules, input]) => JSON.stringify([input.leaveStaffName, input.startAt, input.endAt]));
      expect(keys.length).toBe(new Set(keys).size);
    } finally { spy.mockRestore(); }
  });
  it('still rejects a selected backup who is now on duty', () => {
    const rows = [...schedules, { ...schedules[0], recordId: 'rec_new_conflict', dutyStaffActual: [backup.name] }];
    const result = buildLeaveShiftCandidateSets({ groups: [group], schedules: rows, applicant, selectablePeople: people, allowOnDutySubstitution: true, selections: [fixture().selection] } as any);
    expect(result[0].candidates).toEqual([]);
  });
});
