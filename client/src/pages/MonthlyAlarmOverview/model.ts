import type { MonthlyAlarmOverviewRecord } from '@shared/monthly-alarm-overview.interface';

const BUILDINGS = ['A', 'B', 'C', 'D', 'E'];

export function monthlyAlarmTotals(
  summary: MonthlyAlarmOverviewRecord[],
  building: string,
) {
  const sum = (metric: string) => {
    const park = summary.find(
      (row) => row.building === '园区' && row.metric === metric,
    );
    if (
      building === 'all' &&
      park?.quantity !== null &&
      park?.quantity !== undefined
    ) {
      return park.quantity;
    }
    const buildings = building === 'all' ? BUILDINGS : [building];
    return buildings.reduce(
      (value, name) =>
        value +
        (summary.find((row) => row.building === name && row.metric === metric)
          ?.quantity ?? 0),
      0,
    );
  };
  return {
    total: sum('告警总数'),
    restored: sum('恢复数'),
    unrestored: sum('未恢复数'),
    unexpected: sum('预期外告警'),
  };
}

export function monthlyAlarmUnrestoredRate(
  summary: MonthlyAlarmOverviewRecord[],
  building: string,
): number | null {
  const total = summary.find(
    (row) => row.building === building && row.metric === '告警总数',
  )?.quantity;
  const unrestored = summary.find(
    (row) => row.building === building && row.metric === '未恢复数',
  )?.quantity;
  return total && unrestored !== null && unrestored !== undefined
    ? (unrestored / total) * 100
    : null;
}

export function sortUnexpectedAlarms(
  records: MonthlyAlarmOverviewRecord[],
): MonthlyAlarmOverviewRecord[] {
  return [...records].sort(
    (a, b) => (b.quantity ?? 0) - (a.quantity ?? 0) || a.id.localeCompare(b.id),
  );
}
