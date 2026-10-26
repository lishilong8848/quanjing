import { buildDutyProgramModifiedRefreshItem } from '../../server/modules/duty-schedule/duty-program-modified-refresh';

describe('duty program-modified refresh plan', () => {
  it('resets from planned staff before applying leave, vacancy, and travel rules', () => {
    expect(
      buildDutyProgramModifiedRefreshItem({
        recordId: 'rec1',
        plannedStaff: ['示例人员008', '示例人员013'],
        leaveStaff: ['示例人员013'],
        substituteStaff: ['示例人员017'],
        vacancySubstituteStaff: ['赵六'],
        travelStaff: ['示例人员008'],
      }),
    ).toEqual({
      recordId: 'rec1',
      resetText: '示例人员008 示例人员013',
      finalText: '示例人员017 赵六',
    });
  });

  it('deduplicates planned and vacancy staff names', () => {
    expect(
      buildDutyProgramModifiedRefreshItem({
        recordId: 'rec2',
        plannedStaff: ['示例人员008', ' 示例人员008 ', '示例人员013'],
        leaveStaff: [],
        substituteStaff: [],
        vacancySubstituteStaff: ['示例人员013', '示例人员017', '示例人员017'],
        travelStaff: [],
      }),
    ).toEqual({
      recordId: 'rec2',
      resetText: '示例人员008 示例人员013',
      finalText: '示例人员008 示例人员013 示例人员017',
    });
  });

  it('drops leave staff without a substitute instead of restoring stale actual staff', () => {
    expect(
      buildDutyProgramModifiedRefreshItem({
        recordId: 'rec3',
        plannedStaff: ['示例人员008', '示例人员013'],
        leaveStaff: ['示例人员013'],
        substituteStaff: [],
        vacancySubstituteStaff: [],
        travelStaff: [],
      }),
    ).toEqual({
      recordId: 'rec3',
      resetText: '示例人员008 示例人员013',
      finalText: '示例人员008',
    });
  });
});
