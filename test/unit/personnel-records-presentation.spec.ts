import { buildPersonnelTimeInsights } from '../../server/modules/personnel-time-insights/personnel-time-insights.model';
import type { PersonnelTimeInsightsPersonSummary } from '../../shared/personnel-time-insights.interface';
import {
  buildPersonnelRecords,
  filterPersonnelRecords,
  groupPersonnelRecords,
  rankPersonnelRecords,
} from '../../client/src/components/attendance/personnel-records-presentation';

const metrics = buildPersonnelTimeInsights({
  from: '2026-10-01',
  through: '2026-10-11',
  overtimeApplications: [],
  overtimeConfirmations: [],
  leaveApplications: [],
}).metrics;
function person(
  key: string,
  building: string,
): PersonnelTimeInsightsPersonSummary {
  return {
    ...metrics,
    key,
    name: '同名员工',
    openId: key,
    building,
    position: '值班员',
    pendingOvertimeCount: 1,
    details: {
      leave: [
        {
          recordId: `leave-${key}`,
          date: '2026-10-02',
          startAt: '2026-10-02 09:00',
          endAt: '2026-10-02 18:00',
          hours: 8,
          leaveType: '年假',
          travel: false,
          legacyStartDateFallback: false,
        },
      ],
      overtime: [
        {
          recordId: `ot-${key}`,
          startAt: '2026-10-03 18:00',
          endAt: '2026-10-04 09:00',
          hours: 15,
          disposition: '调休',
          legacyDefaultedDisposition: false,
        },
      ],
      pendingOvertime: [
        {
          recordId: `pending-${key}`,
          startAt: '2026-10-05 18:00',
          endAt: '2026-10-06 09:00',
          hours: 15,
        },
      ],
    },
  };
}
describe('personnel records presentation', () => {
  it('将请休假和加班展开成互不混合的紧凑明细', () => {
    const people = [person('ou_a', 'A楼')];
    expect(buildPersonnelRecords(people, 'leave')).toEqual([
      expect.objectContaining({
        category: '年假',
        hours: 8,
        status: 'approved',
        date: '2026-10-02',
      }),
    ]);
    expect(buildPersonnelRecords(people, 'overtime')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: '调休',
          status: 'confirmed',
          hours: 15,
          endAt: '2026-10-04 09:00',
        }),
        expect.objectContaining({
          category: '待确认',
          status: 'pending',
          hours: 15,
          endAt: '2026-10-06 09:00',
        }),
      ]),
    );
  });
  it('按稳定人员身份筛选，避免同名员工下钻混在一起', () => {
    const rows = buildPersonnelRecords(
      [person('ou_a', 'A楼'), person('ou_b', 'B楼')],
      'leave',
    );
    expect(
      filterPersonnelRecords(rows, 'all', { kind: 'person', value: 'ou_a' }),
    ).toHaveLength(1);
    expect(
      filterPersonnelRecords(rows, 'all', { kind: 'building', value: 'B楼' })[0]
        .personKey,
    ).toBe('ou_b');
    expect(groupPersonnelRecords(rows, 'person')).toHaveLength(2);
    expect(filterPersonnelRecords(rows, '年假', null, 'A楼')).toHaveLength(1);
  });
  it('实际工时排行不混入待确认申请工时，待确认可按次数下钻', () => {
    const p = person('ou_a', 'A楼');
    const rows = buildPersonnelRecords([p], 'overtime');
    expect(rankPersonnelRecords(rows, 'person', 'hours')[0].value).toBe(15);
    const pending = filterPersonnelRecords(rows, 'pending');
    expect(rankPersonnelRecords(pending, 'person', 'count')[0].value).toBe(1);
    expect(filterPersonnelRecords(rows, 'confirmed')).toHaveLength(1);
    expect(groupPersonnelRecords(rows, 'category')).toHaveLength(2);
  });
  it('工时降序，兼容旧响应中没有待确认详情', () => {
    const a = person('ou_a', 'A楼'),
      b = person('ou_b', 'B楼');
    b.details.overtime[0].hours = 20;
    delete a.details.pendingOvertime;
    const rows = buildPersonnelRecords([a, b], 'overtime');
    expect(
      rankPersonnelRecords(rows, 'building', 'hours').map((e) => e.value),
    ).toEqual([20, 15]);
    expect(rows.filter((e) => e.status === 'pending')).toHaveLength(1);
  });
});
