import { buildAttendanceHistoryResponse } from '../../server/modules/duty-schedule/attendance-history.model';
import type {
  AttendanceAnomaly,
  AttendanceExpectation,
} from '../../server/modules/duty-schedule/attendance-automation.rules';

function anomaly(
  overrides: Partial<AttendanceAnomaly> &
    Pick<AttendanceAnomaly, 'key' | 'name' | 'building' | 'reason'>,
): AttendanceAnomaly {
  return {
    shiftLabel: '白班',
    direction: 'OnDuty',
    expectedAt: '2026-09-02 09:00',
    status: 'on_duty',
    ...overrides,
  };
}

describe('attendance history model', () => {
  it('按统一口径归类，并生成人员与楼栋排行', () => {
    const result = buildAttendanceHistoryResponse({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      fetchedAt: '2026-09-19 10:00',
      checkedCount: 20,
      anomalies: [
        anomaly({ key: 'h-1', name: '示例人员008', building: 'H楼', reason: '迟到' }),
        anomaly({
          key: 'h-2',
          name: '示例人员008',
          building: 'H楼',
          direction: 'OffDuty',
          expectedAt: '2026-09-03 18:00',
          reason: '早退',
        }),
        anomaly({
          key: 'b-1',
          name: '示例人员013',
          building: 'B楼',
          expectedAt: '2026-09-04 09:00',
          reason: '未查询到有效打卡',
        }),
        anomaly({
          key: 'station-1',
          name: '陈诚',
          building: '110站',
          expectedAt: '2026-09-06 09:00',
          reason: '旷工',
        }),
      ],
      corrected: [
        {
          key: 'b-2',
          name: '示例人员017',
          building: 'B楼',
          shiftLabel: '白班',
          direction: 'OnDuty',
          expectedAt: '2026-09-05 09:00',
          status: 'on_duty',
        } satisfies AttendanceExpectation,
      ],
    });

    expect(result).toMatchObject({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      checkedCount: 20,
      anomalyCount: 4,
      abnormalPeople: 3,
      affectedBuildings: 3,
      correctedCount: 1,
    });
    expect(result.categoryBreakdown).toEqual([
      { category: 'late', label: '迟到', count: 1 },
      { category: 'early', label: '早退', count: 1 },
      { category: 'missing', label: '未打卡且未补卡', count: 2 },
      { category: 'corrected', label: '补卡后正常', count: 1 },
      { category: 'other', label: '其他异常', count: 0 },
    ]);
    expect(result.personRanking).toEqual([
      { name: '示例人员008', buildings: ['H楼'], count: 2 },
      { name: '陈诚', buildings: ['110站'], count: 1 },
      { name: '示例人员013', buildings: ['B楼'], count: 1 },
      { name: '示例人员017', buildings: ['B楼'], count: 1 },
    ]);
    expect(result.buildingRanking).toEqual([
      { building: 'B楼', peopleCount: 2, count: 2 },
      { building: 'H楼', peopleCount: 1, count: 2 },
      { building: '110站', peopleCount: 1, count: 1 },
    ]);
    expect(result.items.map((item) => item.category)).toEqual([
      'late',
      'early',
      'missing',
      'corrected',
      'missing',
    ]);
  });

  it('没有异常时返回稳定的空统计', () => {
    const result = buildAttendanceHistoryResponse({
      startDate: '2026-09-01',
      endDate: '2026-09-19',
      fetchedAt: '2026-09-19 10:00',
      checkedCount: 12,
      anomalies: [],
      corrected: [],
    });

    expect(result.anomalyCount).toBe(0);
    expect(result.abnormalPeople).toBe(0);
    expect(result.affectedBuildings).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.personRanking).toEqual([]);
    expect(result.buildingRanking).toEqual([]);
    expect(result.categoryBreakdown.every((item) => item.count === 0)).toBe(
      true,
    );
  });
});
