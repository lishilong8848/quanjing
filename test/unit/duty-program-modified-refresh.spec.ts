import { buildDutyProgramModifiedRefreshItem } from '../../server/modules/duty-schedule/duty-program-modified-refresh';

describe('duty program-modified refresh plan', () => {
  it('resets from planned staff before applying leave, vacancy, and travel rules', () => {
    expect(
      buildDutyProgramModifiedRefreshItem({
        recordId: 'rec1',
        plannedStaff: ['张三', '李四'],
        leaveStaff: ['李四'],
        substituteStaff: ['王五'],
        vacancySubstituteStaff: ['赵六'],
        travelStaff: ['张三'],
      }),
    ).toEqual({
      recordId: 'rec1',
      resetText: '张三 李四',
      finalText: '王五 赵六',
    });
  });

  it('deduplicates planned and vacancy staff names', () => {
    expect(
      buildDutyProgramModifiedRefreshItem({
        recordId: 'rec2',
        plannedStaff: ['张三', ' 张三 ', '李四'],
        leaveStaff: [],
        substituteStaff: [],
        vacancySubstituteStaff: ['李四', '王五', '王五'],
        travelStaff: [],
      }),
    ).toEqual({
      recordId: 'rec2',
      resetText: '张三 李四',
      finalText: '张三 李四 王五',
    });
  });

  it('drops leave staff without a substitute instead of restoring stale actual staff', () => {
    expect(
      buildDutyProgramModifiedRefreshItem({
        recordId: 'rec3',
        plannedStaff: ['张三', '李四'],
        leaveStaff: ['李四'],
        substituteStaff: [],
        vacancySubstituteStaff: [],
        travelStaff: [],
      }),
    ).toEqual({
      recordId: 'rec3',
      resetText: '张三 李四',
      finalText: '张三',
    });
  });
});
