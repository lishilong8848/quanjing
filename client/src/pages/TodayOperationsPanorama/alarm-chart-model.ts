import type {
  TodayOperationsAlarmBuildingPoint,
  TodayOperationsAlarmExpectation,
  TodayOperationsAlarmMetric,
} from '@shared/today-operations-alarm.interface';

export type AlarmChartPeriod = 'sevenDay' | 'yesterday';

export type AlarmChartPoint = Pick<
  TodayOperationsAlarmBuildingPoint,
  'building' | 'expected' | 'unexpected' | 'unclassified'
>;

export interface AlarmChartSelection {
  building: TodayOperationsAlarmBuildingPoint['building'];
  expectation: TodayOperationsAlarmExpectation;
  metric: TodayOperationsAlarmMetric;
  title: string;
}

const EXPECTATION_LABELS: Record<TodayOperationsAlarmExpectation, string> = {
  expected: '预期内',
  unexpected: '预期外',
  unclassified: '未分类',
};

const PERIOD_LABELS: Record<AlarmChartPeriod, string> = {
  sevenDay: '近7天',
  yesterday: '昨日',
};

const DRILLDOWN_METRICS: Record<
  AlarmChartPeriod,
  Record<TodayOperationsAlarmExpectation, TodayOperationsAlarmMetric>
> = {
  sevenDay: {
    expected: 'expected',
    unexpected: 'unexpected',
    unclassified: 'unclassified',
  },
  yesterday: {
    expected: 'yesterdayExpected',
    unexpected: 'yesterdayUnexpected',
    unclassified: 'yesterdayUnclassified',
  },
};

export function formatAlarmBarLabel(value: unknown): string {
  const count = Number(value);
  return Number.isFinite(count) && count > 0
    ? count.toLocaleString('zh-CN')
    : '';
}

export function resolveAlarmChartSelection(
  period: AlarmChartPeriod,
  point: AlarmChartPoint,
  expectation: TodayOperationsAlarmExpectation,
): AlarmChartSelection | null {
  const count = Number(point[expectation]);
  if (!Number.isFinite(count) || count <= 0) return null;

  return {
    building: point.building,
    expectation,
    metric: DRILLDOWN_METRICS[period][expectation],
    title: `${PERIOD_LABELS[period]} · ${point.building} · ${EXPECTATION_LABELS[expectation]}告警清单`,
  };
}
