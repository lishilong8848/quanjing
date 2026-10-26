import type { TodayOperationsAlarmDashboardResponse } from '../../../shared/today-operations-alarm.interface';
import type { TodayOperationsKpiResponse } from '../../../shared/today-operations-kpi.interface';
import type { TodayOperationsOverviewResponse } from '../../../shared/today-operations-overview.interface';
import {
  detectRelativeChange,
  detectTodayOperationsAnomalies,
} from './today-operations-anomaly.rules';

const detectedAt = '2026-08-20T00:30:00.000Z';

describe('today operations anomaly rules', () => {
  it('reports an unavailable rack without discarding other overview checks', () => {
    const overview = buildOverview();
    overview.rackSummary = null;
    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-20',
      detectedAt,
      thresholdPercent: 50,
      kpi: buildKpi(),
      overview,
      alarms: buildAlarms(),
    });
    expect(anomalies.some((item) => item.metricKey === 'rackSource')).toBe(
      true,
    );
  });
  it('alerts only when the absolute relative change is greater than the threshold', () => {
    expect(
      detectRelativeChange({ current: 151, previous: 100, threshold: 50 }),
    ).toEqual({ category: 'increase', changePercent: 51 });
    expect(
      detectRelativeChange({ current: 49, previous: 100, threshold: 50 }),
    ).toEqual({ category: 'decrease', changePercent: -51 });
    expect(
      detectRelativeChange({ current: 150, previous: 100, threshold: 50 }),
    ).toBeNull();
    expect(
      detectRelativeChange({ current: 50, previous: 100, threshold: 50 }),
    ).toBeNull();
  });

  it('treats a positive value after a zero baseline as a sudden increase', () => {
    expect(
      detectRelativeChange({ current: 28, previous: 0, threshold: 50 }),
    ).toEqual({ category: 'increase', changePercent: null });
    expect(
      detectRelativeChange({ current: 0, previous: 0, threshold: 50 }),
    ).toBeNull();
  });

  it('does not treat weekly rack power-on or power-off declines as anomalies', () => {
    const overview = buildOverview();
    overview.rackSummary!.poweredOnThisWeek = 0;
    overview.rackSummary!.poweredOnWeekDelta = -28;
    overview.rackSummary!.poweredOffThisWeek = 0;
    overview.rackSummary!.poweredOffWeekDelta = -12;

    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-23',
      detectedAt,
      thresholdPercent: 50,
      kpi: buildKpi(),
      overview,
      alarms: buildAlarms(),
    });

    expect(
      anomalies.some((item) => item.metricKey === 'rack.poweredOnThisWeek'),
    ).toBe(false);
    expect(
      anomalies.some((item) => item.metricKey === 'rack.poweredOffThisWeek'),
    ).toBe(false);
  });

  it('turns schedule and approved personnel-change mismatches into located anomalies', () => {
    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-23',
      detectedAt,
      thresholdPercent: 50,
      kpi: buildKpi(),
      overview: buildOverview(),
      alarms: buildAlarms(),
      scheduleConsistencyIssues: [
        {
          issueId: 'issue-zhouqingqing',
          kind: 'approved_substitute_missing',
          sourceRecordId: 'rec-leave',
          scheduleRecordId: 'rec-schedule',
          scope: '2026-08-22 A栋 夜班',
          location: '排班页面 > 2026-08-22 A栋 夜班',
          dataDate: '2026-08-22',
          details: [
            '已审批替班人员“周庆庆”未出现在该班次实际排班中',
            '当前实际人员：李董',
          ],
        },
      ],
    });

    expect(anomalies).toContainEqual(
      expect.objectContaining({
        category: 'missing',
        metricLabel: '已审批替班未更新排班',
        scope: '2026-08-22 A栋 夜班',
        location: '排班页面 > 2026-08-22 A栋 夜班',
        details: expect.arrayContaining([
          '已审批替班人员“周庆庆”未出现在该班次实际排班中',
        ]),
      }),
    );
  });

  it('identifies KPI building gaps and comparable metric changes without flagging intentional null baselines', () => {
    const kpi = buildKpi();
    kpi.metrics.averagePue = {
      value: 1.3,
      previousValue: 1.2,
      date: '2026-08-19',
    };
    kpi.metrics.waterTons = {
      value: 400,
      previousValue: 1000,
      date: '2026-08-19',
    };
    kpi.details.buildingMetrics!.averagePue.rows[1].previousValue = null;

    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-20',
      detectedAt,
      thresholdPercent: 50,
      kpi,
      overview: buildOverview(),
      alarms: buildAlarms(),
    });

    expect(anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'missing',
          metricKey: 'averagePue',
          scope: 'B楼',
          details: expect.arrayContaining(['B楼缺少对比值']),
        }),
        expect.objectContaining({
          category: 'decrease',
          metricKey: 'waterTons',
          changePercent: -60,
        }),
      ]),
    );
    expect(
      anomalies.some((item) => item.metricKey === 'safeOperationDays'),
    ).toBe(false);
    expect(anomalies.some((item) => item.metricKey === 'onDutyPeople')).toBe(
      false,
    );
  });

  it('locates failed overview sources and stale dashboards as missing data', () => {
    const kpi = buildKpi();
    kpi.sourceStatus = 'stale';
    const overview = buildOverview();
    overview.sourceStates.changes = {
      status: 'failed',
      errorCode: 'CHANGE_SOURCE_FAILED',
      errorMessage: '变更源读取失败',
    };
    const alarms = buildAlarms();
    alarms.sourceStatus = 'stale';

    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-20',
      detectedAt,
      thresholdPercent: 50,
      kpi,
      overview,
      alarms,
    });

    expect(anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricKey: 'kpiSource',
          category: 'missing',
        }),
        expect.objectContaining({
          metricKey: 'operations.changes',
          location: '今日航图 > 02 运维概况一览 > 今日变更',
        }),
        expect.objectContaining({
          metricKey: 'alarmSource',
          category: 'missing',
        }),
      ]),
    );
  });

  it('creates an alarm increase with the building breakdown for precise location', () => {
    const alarms = buildAlarms();
    alarms.summary.yesterdayTotal = 387;
    alarms.summary.dayBeforeYesterdayTotal = 154;
    alarms.yesterdayByBuilding = [
      {
        building: 'A楼',
        expected: 0,
        unexpected: 1,
        unclassified: 0,
        total: 1,
      },
      {
        building: 'C楼',
        expected: 363,
        unexpected: 0,
        unclassified: 0,
        total: 363,
      },
      {
        building: 'D楼',
        expected: 6,
        unexpected: 4,
        unclassified: 6,
        total: 16,
      },
    ];

    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-20',
      detectedAt,
      thresholdPercent: 50,
      kpi: buildKpi(),
      overview: buildOverview(),
      alarms,
    });

    expect(anomalies).toContainEqual(
      expect.objectContaining({
        category: 'increase',
        metricKey: 'alarms.yesterdayTotal',
        currentValue: 387,
        previousValue: 154,
        changePercent: 151.3,
        location: '今日航图 > 03 园区近日告警信息总览 > 昨日告警总数',
        details: ['C楼 363条', 'D楼 16条', 'A楼 1条'],
      }),
    );
  });

  it('does not treat a decrease in yesterday alarm total as an anomaly', () => {
    const alarms = buildAlarms();
    alarms.summary.yesterdayTotal = 15;
    alarms.summary.dayBeforeYesterdayTotal = 450;

    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-24',
      detectedAt,
      thresholdPercent: 50,
      kpi: buildKpi(),
      overview: buildOverview(),
      alarms,
    });

    expect(
      anomalies.some((item) => item.metricKey === 'alarms.yesterdayTotal'),
    ).toBe(false);
  });

  it('turns a precise KPI scan failure into one located missing-data anomaly', () => {
    const anomalies = detectTodayOperationsAnomalies({
      businessDate: '2026-08-20',
      detectedAt,
      thresholdPercent: 50,
      kpiError: '2026-08-18A楼缺少PUE',
      overview: buildOverview(),
      alarms: buildAlarms(),
    });

    expect(anomalies).toContainEqual(
      expect.objectContaining({
        category: 'missing',
        metricKey: 'kpiSource',
        location: '今日航图 > 运行摘要',
        details: ['2026-08-18A楼缺少PUE'],
      }),
    );
  });
});

function buildKpi(): TodayOperationsKpiResponse {
  return {
    sourceStatus: 'fresh',
    syncedAt: detectedAt,
    metrics: {
      safeOperationDays: {
        value: 2855,
        previousValue: null,
        date: '2026-08-20',
      },
      onDutyPeople: { value: 48, previousValue: null, date: '2026-08-20' },
      averagePue: { value: 1.256, previousValue: 1.221, date: '2026-08-19' },
      itLoadRate: { value: 52.5, previousValue: 52.8, date: '2026-08-20' },
      electricityKwh: {
        value: 1_042_400,
        previousValue: 1_043_704,
        date: '2026-08-19',
      },
      waterTons: { value: 1914.5, previousValue: 1830.2, date: '2026-08-20' },
    },
    details: {
      onDutyPeople: {
        scope: 'daily_shifts',
        date: '2026-08-20',
        buildings: [],
        total: 48,
        whiteShiftTotal: 48,
        nightShiftTotal: 14,
        shifts: {
          white: {
            shift: 'white',
            shiftLabel: '白班',
            total: 48,
            buildings: [],
          },
          night: {
            shift: 'night',
            shiftLabel: '夜班',
            total: 14,
            buildings: [],
          },
        },
      },
      buildingMetrics: {
        averagePue: buildBuildingMetric('2026-08-19', '2026-08-18', 1.25, 1.24),
        electricityKwh: buildBuildingMetric(
          '2026-08-19',
          '2026-08-18',
          200_000,
          190_000,
        ),
        waterTons: buildBuildingMetric('2026-08-20', '2026-08-19', 300, 280),
      },
    },
  };
}

function buildBuildingMetric(
  date: string,
  previousDate: string,
  value: number,
  previousValue: number,
) {
  const buildings = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const;
  return {
    date,
    previousDate,
    includedBuildings: [...buildings],
    rows: buildings.map((building) => ({ building, value, previousValue })),
  };
}

function buildOverview(): TodayOperationsOverviewResponse {
  const sourceState = {
    status: 'fresh' as const,
    errorCode: null,
    errorMessage: null,
  };
  return {
    businessDate: '2026-08-20',
    sourceStatus: 'fresh',
    syncedAt: detectedAt,
    rackSummary: {
      usageRate: 75,
      online: 4003,
      total: 5322,
      buildingUsages: [
        { building: 'A楼', online: 800, total: 1000, usageRate: 80 },
        { building: 'B楼', online: 800, total: 1000, usageRate: 80 },
        { building: 'C楼', online: 800, total: 1000, usageRate: 80 },
        { building: 'D楼', online: 800, total: 1000, usageRate: 80 },
        { building: 'E楼', online: 803, total: 1322, usageRate: 60.7 },
      ],
      poweredOnThisWeek: 28,
      poweredOffThisWeek: 0,
      poweredOnWeekDelta: 0,
      poweredOffWeekDelta: 0,
      weekStartDate: '2026-08-17',
      capacityDate: '2026-08-01',
      loadDate: '2026-08-20',
      buildingLoads: [
        { building: 'A楼', value: 71.3 },
        { building: 'B楼', value: 73.6 },
        { building: 'C楼', value: 74.1 },
        { building: 'D楼', value: 32.4 },
        { building: 'E楼', value: 14.6 },
      ],
    },
    operations: {
      todayEvents: 1,
      pendingEvents: 0,
      priorPendingEvents: 0,
      closedTodayEvents: 1,
      keyEvents: 0,
      todayChanges: 5,
      activeChanges: 5,
      priorActiveChanges: 0,
      keyChanges: 0,
      todayInspections: 1,
      activeInspections: 0,
      todayMaintenance: 23,
      activeMaintenance: 3,
    },
    details: { events: [], changes: [], inspections: [], maintenance: [] },
    focusDetails: { pendingEvents: [], activeChanges: [] },
    sourceStates: {
      events: { ...sourceState },
      changes: { ...sourceState },
      inspections: { ...sourceState },
      maintenance: { ...sourceState },
    },
  };
}

function buildAlarms(): TodayOperationsAlarmDashboardResponse {
  return {
    window: {
      timeZone: 'Asia/Shanghai',
      startDate: '2026-08-13',
      endDateExclusive: '2026-08-20',
      yesterdayDate: '2026-08-19',
    },
    summary: {
      sevenDayTotal: 100,
      expectedTotal: 90,
      unexpectedTotal: 10,
      unclassifiedTotal: 0,
      yesterdayTotal: 20,
      yesterdayExpectedTotal: 18,
      yesterdayUnexpectedTotal: 2,
      yesterdayUnclassifiedTotal: 0,
      dayBeforeYesterdayTotal: 20,
      pendingTotal: 0,
      doubleUnhandledTotal: 0,
      excludedBuildingTotal: 0,
    },
    sevenDayByBuilding: [],
    yesterdayByBuilding: [],
    options: {
      buildings: [],
      levels: [],
      statuses: [],
      processingStatuses: [],
      recoveryStatuses: [],
    },
    page: { items: [], page: 1, pageSize: 5, total: 0, totalPages: 0 },
    sourceUpdatedAt: detectedAt,
    syncedAt: detectedAt,
    sourceStatus: 'fresh',
    dataStatus: 'empty',
    warnings: [],
  };
}
