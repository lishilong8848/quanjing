import {
  buildAlarmKpis,
  formatAlarmDateTime,
} from '../../client/src/pages/TodayOperationsPanorama/alarm-model';
import {
  formatAlarmBarLabel,
  resolveAlarmChartSelection,
} from '../../client/src/pages/TodayOperationsPanorama/alarm-chart-model';
import type { TodayOperationsAlarmSummary } from '../../shared/today-operations-alarm.interface';

const emptyTagCounts = {
  missing: 0,
  format: 0,
  pending: 0,
  vague: 0,
  nonOfficial: 0,
  semantic: 0,
};

describe('today operations alarm KPI model', () => {
  it('uses source-backed shares and only shows a trend when a comparable day exists', () => {
    const summary = {
      sevenDayTotal: 100,
      expectedTotal: 70,
      unexpectedTotal: 20,
      unclassifiedTotal: 10,
      yesterdayTotal: 12,
      yesterdayExpectedTotal: 8,
      yesterdayUnexpectedTotal: 3,
      yesterdayUnclassifiedTotal: 1,
      dayBeforeYesterdayTotal: 10,
      pendingTotal: 5,
      doubleUnhandledTotal: 3,
      excludedBuildingTotal: 3,
      tagAnomalyTotal: 4,
      tagAnomalyByType: { ...emptyTagCounts, semantic: 1, format: 3 },
      tagAnomalyByBuilding: [],
    } satisfies TodayOperationsAlarmSummary;
    const cards = buildAlarmKpis(summary);
    const sevenDayCard = cards.find((card) => card.key === 'alarms-seven-days');
    const expectedCard = cards.find((card) => card.key === 'alarms-expected');
    const unexpectedCard = cards.find(
      (card) => card.key === 'alarms-unexpected',
    );
    const doubleUnhandledCard = cards.find(
      (card) => card.key === 'alarms-double-unhandled',
    );
    const yesterdayCard = cards.find((card) => card.key === 'alarms-yesterday');
    const pendingCard = cards.find((card) => card.key === 'alarms-pending');

    expect(cards).toHaveLength(7);
    expect(cards.map((card) => card.key)).toEqual([
      'alarms-seven-days',
      'alarms-expected',
      'alarms-unexpected',
      'alarms-double-unhandled',
      'alarms-tag-anomaly',
      'alarms-yesterday',
      'alarms-pending',
    ]);
    expect(cards.map((card) => card.value)).toEqual([
      '100',
      '70',
      '20',
      '3',
      '4',
      '12',
      '5',
    ]);
    expect(sevenDayCard).toMatchObject({
      comparison: '覆盖最近7个完整自然日',
      direction: 'neutral',
    });
    expect(expectedCard).toMatchObject({
      comparison: '占近7天 70.0%',
      direction: 'neutral',
    });
    expect(unexpectedCard).toMatchObject({
      comparison: '占近7天 20.0%',
      direction: 'neutral',
      icon: 'alarm',
    });
    expect(yesterdayCard).toMatchObject({
      comparison: '较前日 20.0%',
      direction: 'up',
    });
    expect(doubleUnhandledCard).toEqual({
      key: 'alarms-double-unhandled',
      title: '双未告警数',
      value: '3',
      unit: '条',
      comparison: '占近7天 3.0%',
      direction: 'neutral',
      tone: 'red',
      icon: 'bell',
      sparkline: [],
      helpText:
        '统计近 7 个完整自然日内，处理状态为“未处理”且恢复状态为“未恢复”的告警。',
    });
    expect(doubleUnhandledCard?.icon).not.toBe(unexpectedCard?.icon);
    expect(pendingCard).toMatchObject({
      comparison: '占近7天 5.0%',
      direction: 'neutral',
    });
    expect(cards.find((card) => card.key === 'alarms-tag-anomaly')).toMatchObject({
      title: '异常打标',
      tone: 'orange',
      icon: 'tag',
    });
  });

  it('keeps the comparison neutral when the previous day has no denominator', () => {
    const summary = {
      sevenDayTotal: 0,
      expectedTotal: 0,
      unexpectedTotal: 0,
      unclassifiedTotal: 0,
      yesterdayTotal: 0,
      yesterdayExpectedTotal: 0,
      yesterdayUnexpectedTotal: 0,
      yesterdayUnclassifiedTotal: 0,
      dayBeforeYesterdayTotal: 0,
      pendingTotal: 0,
      doubleUnhandledTotal: 0,
      excludedBuildingTotal: 0,
      tagAnomalyTotal: 0,
      tagAnomalyByType: emptyTagCounts,
      tagAnomalyByBuilding: [],
    } satisfies TodayOperationsAlarmSummary;
    const cards = buildAlarmKpis(summary);
    const expectedCard = cards.find((card) => card.key === 'alarms-expected');
    const yesterdayCard = cards.find((card) => card.key === 'alarms-yesterday');

    expect(expectedCard?.comparison).toBe('占近7天 0.0%');
    expect(yesterdayCard).toMatchObject({
      comparison: '前日无可比数据',
      direction: 'neutral',
    });
  });

  it('clamps a negative double-unhandled count before calculating its share', () => {
    const summary = {
      sevenDayTotal: 100,
      expectedTotal: 0,
      unexpectedTotal: 0,
      unclassifiedTotal: 0,
      yesterdayTotal: 0,
      yesterdayExpectedTotal: 0,
      yesterdayUnexpectedTotal: 0,
      yesterdayUnclassifiedTotal: 0,
      dayBeforeYesterdayTotal: 0,
      pendingTotal: 0,
      doubleUnhandledTotal: -3,
      excludedBuildingTotal: 0,
      tagAnomalyTotal: 0,
      tagAnomalyByType: emptyTagCounts,
      tagAnomalyByBuilding: [],
    } satisfies TodayOperationsAlarmSummary;
    const doubleUnhandledCard = buildAlarmKpis(summary).find(
      (card) => card.key === 'alarms-double-unhandled',
    );

    expect(doubleUnhandledCard).toMatchObject({
      value: '0',
      comparison: '占近7天 0.0%',
    });
  });

  it('formats alarm timestamps in the Shanghai timezone for the compact table', () => {
    expect(formatAlarmDateTime('2026-07-18T21:20:14.000Z')).toBe(
      '2026/07/19 05:20',
    );
    expect(formatAlarmDateTime('')).toBe('—');
    expect(formatAlarmDateTime('not-a-date')).toBe('—');
  });

  it('hides zero alarm labels and only resolves non-zero bars as drilldowns', () => {
    expect(formatAlarmBarLabel(0)).toBe('');
    expect(formatAlarmBarLabel(-1)).toBe('');
    expect(formatAlarmBarLabel(Number.NaN)).toBe('');
    expect(formatAlarmBarLabel(12)).toBe('12');
    expect(formatAlarmBarLabel(1000)).toBe('1,000');

    const point = {
      building: 'B楼' as const,
      expected: 32,
      unexpected: 3,
      unclassified: 0,
      total: 35,
    };

    expect(resolveAlarmChartSelection('sevenDay', point, 'expected')).toEqual({
      building: 'B楼',
      expectation: 'expected',
      metric: 'expected',
      title: '近7天 · B楼 · 预期内告警清单',
    });
    expect(
      resolveAlarmChartSelection('sevenDay', point, 'unclassified'),
    ).toBeNull();
  });

  it.each([
    ['sevenDay', 'expected', 'expected', '近7天 · A楼 · 预期内告警清单'],
    ['sevenDay', 'unexpected', 'unexpected', '近7天 · A楼 · 预期外告警清单'],
    [
      'sevenDay',
      'unclassified',
      'unclassified',
      '近7天 · A楼 · 未分类告警清单',
    ],
    [
      'yesterday',
      'expected',
      'yesterdayExpected',
      '昨日 · A楼 · 预期内告警清单',
    ],
    [
      'yesterday',
      'unexpected',
      'yesterdayUnexpected',
      '昨日 · A楼 · 预期外告警清单',
    ],
    [
      'yesterday',
      'unclassified',
      'yesterdayUnclassified',
      '昨日 · A楼 · 未分类告警清单',
    ],
  ] as const)(
    'maps %s %s to the exact alarm detail metric',
    (period, expectation, metric, title) => {
      const point = {
        building: 'A楼' as const,
        expected: 1,
        unexpected: 1,
        unclassified: 1,
        total: 3,
      };

      expect(resolveAlarmChartSelection(period, point, expectation)).toEqual({
        building: 'A楼',
        expectation,
        metric,
        title,
      });
    },
  );
});
