import {
  monthlyAlarmTotals,
  monthlyAlarmUnrestoredRate,
  sortUnexpectedAlarms,
} from '../../client/src/pages/MonthlyAlarmOverview/model';
import type { MonthlyAlarmOverviewRecord } from '../../shared/monthly-alarm-overview.interface';

const row = (building: string, metric: string, quantity: number) =>
  ({ building, metric, quantity }) as MonthlyAlarmOverviewRecord;

describe('月度告警总览汇总口径', () => {
  it('uses the park total once and sums buildings when the park metric is absent', () => {
    const summary = [
      row('园区', '告警总数', 948),
      row('园区', '恢复数', 930),
      row('园区', '未恢复数', 18),
      row('A', '告警总数', 244),
      row('A', '恢复数', 236),
      row('A', '未恢复数', 8),
      row('B', '告警总数', 288),
      row('B', '恢复数', 288),
      row('B', '未恢复数', 0),
      row('B', '预期外告警', 1),
      row('C', '预期外告警', 2),
    ];
    expect(monthlyAlarmTotals(summary, 'all')).toEqual({
      total: 948,
      restored: 930,
      unrestored: 18,
      unexpected: 3,
    });
    expect(monthlyAlarmTotals(summary, 'A')).toEqual({
      total: 244,
      restored: 236,
      unrestored: 8,
      unexpected: 0,
    });
  });

  it('calculates the unrestored rate from counts when the source rate differs', () => {
    const summary = [
      row('E', '告警总数', 40),
      row('E', '未恢复数', 25),
      row('E', '未恢复率', 0.11),
    ];
    expect(monthlyAlarmUnrestoredRate(summary, 'E')).toBe(62.5);
    expect(monthlyAlarmUnrestoredRate(summary, 'B')).toBeNull();
  });

  it('orders unexpected alarm entries by quantity descending', () => {
    const entries = [
      { id: 'one', quantity: 1 },
      { id: 'seven', quantity: 7 },
      { id: 'three', quantity: 3 },
    ] as MonthlyAlarmOverviewRecord[];
    expect(sortUnexpectedAlarms(entries).map(({ id }) => id)).toEqual([
      'seven',
      'three',
      'one',
    ]);
    expect(entries[0].id).toBe('one');
  });
});
