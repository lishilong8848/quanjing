import type { PersonnelTimeInsightsPersonSummary } from '../../shared/personnel-time-insights.interface';
import {
  filterPersonnelTimeInsightsPeople,
  getDefaultPersonnelTimeInsightsRange,
  groupPersonnelTimeInsightsPeople,
  validatePersonnelTimeInsightsRange,
} from '../../client/src/components/personnel-time-insights/personnel-time-insights-presentation';

const people = [
  person({
    key: 'h-1',
    name: '张三',
    building: 'H楼',
    overtimeHours: 10,
    compensatoryAvailableHours: 2,
  }),
  person({
    key: 'b-1',
    name: '李四',
    building: 'B楼',
    position: '电气工程师',
    overtimeHours: 4,
    compensatoryAvailableHours: -3,
  }),
  person({
    key: 'a-1',
    name: '王五',
    building: 'A楼',
    overtimeHours: 8,
    compensatoryAvailableHours: 6,
  }),
];

describe('personnel time insights presentation', () => {
  it('默认查询上海时区本年度年初至今天', () => {
    expect(
      getDefaultPersonnelTimeInsightsRange(
        new Date('2026-12-31T16:30:00.000Z'),
      ),
    ).toEqual({ from: '2027-01-01', through: '2027-01-01' });
  });

  it('默认按业务楼栋顺序分组，并在组内优先展示负调休余额', () => {
    expect(groupPersonnelTimeInsightsPeople(people)).toEqual([
      { building: 'H楼', people: [people[0]] },
      { building: 'A楼', people: [people[2]] },
      { building: 'B楼', people: [people[1]] },
    ]);
    expect(
      groupPersonnelTimeInsightsPeople([people[0], people[1]], 'all')[0].people,
    ).toEqual([people[1], people[0]]);
  });

  it('全部人员模式没有人员时返回空分组以触发明确空态', () => {
    expect(groupPersonnelTimeInsightsPeople([], 'all')).toEqual([]);
  });

  it('人员清单支持姓名、楼栋和岗位搜索', () => {
    expect(filterPersonnelTimeInsightsPeople(people, '电气')).toEqual([
      people[1],
    ]);
    expect(filterPersonnelTimeInsightsPeople(people, 'H楼 张三')).toEqual([
      people[0],
    ]);
  });

  it('拒绝逆序或超过五年的查询范围', () => {
    expect(
      validatePersonnelTimeInsightsRange('2026-02-01', '2026-01-01'),
    ).toBeTruthy();
    expect(
      validatePersonnelTimeInsightsRange('2020-01-01', '2026-01-02'),
    ).toBeTruthy();
    expect(
      validatePersonnelTimeInsightsRange('2026-01-01', '2026-12-31'),
    ).toBeNull();
  });
});

function person(
  overrides: Partial<PersonnelTimeInsightsPersonSummary>,
): PersonnelTimeInsightsPersonSummary {
  return {
    key: 'person',
    name: '人员',
    openId: null,
    building: '未分组',
    position: '未配置岗位',
    overtimePeople: 0,
    overtimeHours: 0,
    overtimePayHours: 0,
    feeSettlementHours: 0,
    compensatoryAccruedHours: 0,
    compensatoryUsedHours: 0,
    compensatoryAvailableHours: 0,
    leaveHours: 0,
    travelHours: 0,
    pendingOvertimeCount: 0,
    details: { overtime: [], leave: [] },
    ...overrides,
  };
}
