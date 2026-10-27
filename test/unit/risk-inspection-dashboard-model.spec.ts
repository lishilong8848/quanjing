import type {
  AliRiskInspectionDashboard,
  AliRiskIssue,
  CrossInspectionIssue,
} from '../../shared/risk-inspection.interface';
import {
  DEFAULT_RISK_FILTERS,
  getRiskDashboardView,
  paginateRiskIssues,
} from '../../client/src/pages/RiskInspectionDashboard/model';
import * as riskDashboardModel from '../../client/src/pages/RiskInspectionDashboard/model';
import {
  buildCrossBuildingRectification,
  filterCrossLedgerIssues,
  getDefaultCrossOverviewMonth,
  getPaginationWindow,
} from '../../client/src/pages/RiskInspectionDashboard/dashboard-model';

function issue(
  id: string,
  specialty: string,
  level: AliRiskIssue['level'],
  status: AliRiskIssue['status'],
): AliRiskIssue {
  const levelLabels: Record<AliRiskIssue['level'], string> = {
    'ultra-low': '超低风险',
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    unknown: '未分级',
  };
  const statusLabels: Record<AliRiskIssue['status'], string> = {
    suspended: '已挂起',
    rectifying: '整改中',
    completed: '已完成',
    unknown: '状态未知',
  };

  return {
    id,
    building: 'A楼',
    specialty,
    level,
    levelLabel: levelLabels[level],
    description: `${id}问题`,
    discoveredAt: '2026-07-01',
    dueAt: '2026-07-20',
    closedAt: null,
    owner: '测试人员',
    status,
    statusLabel: statusLabels[status],
    overdueDays: 0,
    recordedInArk: false,
  };
}

const dashboard: AliRiskInspectionDashboard & {
  issues: AliRiskIssue[];
} = {
  month: '2026-07',
  summary: {
    historyTotal: 321,
    unrecorded: 12,
    monthlyAdded: 37,
    rectificationRate: 87.6,
    monthlyClosed: 19,
  },
  severityDistribution: [
    { key: 'high', label: '高风险', value: 2 },
    { key: 'low', label: '低风险', value: 1 },
  ],
  statusDistribution: [
    { key: 'rectifying', label: '整改中', value: 2 },
    { key: 'suspended', label: '已挂起', value: 1 },
  ],
  unresolvedIssues: [
    issue('risk-1', '消防', 'high', 'rectifying'),
    issue('risk-2', '电气', 'low', 'suspended'),
    issue('risk-3', '消防', 'high', 'rectifying'),
    issue('risk-4', '暖通', 'medium', 'rectifying'),
  ],
  overdueIssues: [
    { ...issue('risk-overdue', '消防', 'high', 'rectifying'), overdueDays: 8 },
  ],
  issues: [],
  completionTrend: [{ label: '7/1', value: 80 }],
  categoryDistribution: [{ label: '消防', normal: 2, overdue: 1 }],
  options: {
    specialties: ['消防', '电气', '暖通'],
    levels: ['low', 'medium', 'high'],
    statuses: ['rectifying', 'suspended'],
  },
  sourceUpdatedAt: '2026-07-18T01:30:00.000Z',
  syncedAt: '2026-07-18T02:00:00.000Z',
  sourceStatus: 'fresh',
  warnings: [],
};

describe('risk inspection dashboard model', () => {
  it('filters source-backed unresolved issues without changing source totals', () => {
    const view = getRiskDashboardView(dashboard, {
      specialty: '消防',
      level: 'high',
      status: 'rectifying',
    });

    expect(view.summary).toEqual(dashboard.summary);
    expect(view.unresolvedIssues.map(({ id }) => id)).toEqual([
      'risk-1',
      'risk-3',
    ]);
  });

  it('keeps all source-backed data when filters are reset', () => {
    const view = getRiskDashboardView(dashboard, DEFAULT_RISK_FILTERS);

    expect(view.unresolvedIssues).toHaveLength(4);
    expect(view.severityDistribution).toEqual(dashboard.severityDistribution);
    expect(view.overdueIssues[0].overdueDays).toBeGreaterThan(0);
  });

  it('uses a stable page slice for arbitrary live record counts', () => {
    const firstPage = paginateRiskIssues(dashboard.unresolvedIssues, 1, 3);
    const secondPage = paginateRiskIssues(dashboard.unresolvedIssues, 2, 3);

    expect(firstPage.map(({ id }) => id)).toEqual([
      'risk-1',
      'risk-2',
      'risk-3',
    ]);
    expect(secondPage.map(({ id }) => id)).toEqual(['risk-4']);
  });
});

describe('risk inspection metric issue lists', () => {
  const metricIssues: AliRiskIssue[] = [
    {
      ...issue('history-completed', '消防', 'low', 'completed'),
      building: 'A楼',
      description: 'UPS BATTERY 已闭环',
      discoveredAt: '2026-06-20',
      dueAt: '2026-06-30',
      closedAt: '2026-07-02',
      owner: 'Alice',
    },
    {
      ...issue('monthly-rectifying', '电气', 'medium', 'rectifying'),
      building: 'B楼',
      description: '配电柜温度异常',
      discoveredAt: '2026-07-08',
      dueAt: '2026-07-11',
      owner: '李四',
      overdueDays: 8,
    },
    {
      ...issue('monthly-suspended', '暖通', 'high', 'suspended'),
      building: 'C楼',
      description: '冷机房巡检问题',
      discoveredAt: '2026-07-10',
      dueAt: '2026-07-28',
      owner: '王五',
    },
    {
      ...issue('history-unknown', '其他', 'unknown', 'unknown'),
      discoveredAt: '2026-05-01',
      dueAt: null,
      owner: '赵六',
    },
  ];
  const metricDashboard = {
    ...dashboard,
    summary: {
      historyTotal: 4,
      unrecorded: 3,
      monthlyAdded: 2,
      rectificationRate: 50,
      monthlyClosed: 1,
    },
    issues: metricIssues,
    unresolvedIssues: metricIssues.filter(
      ({ status }) => status !== 'completed',
    ),
    overdueIssues: [metricIssues[1]],
  } as AliRiskInspectionDashboard;
  type MetricKey =
    | 'historyTotal'
    | 'unclosed'
    | 'overdueUnclosed'
    | 'monthlyAdded'
    | 'rectificationRate'
    | 'monthlyClosed';
  type SelectMetricIssues = (
    source: AliRiskInspectionDashboard,
    key: MetricKey,
  ) => AliRiskIssue[];
  type FilterMetricIssues = (
    source: readonly AliRiskIssue[],
    query: string,
  ) => AliRiskIssue[];
  type RectificationStats = (source: readonly AliRiskIssue[]) => {
    completed: number;
    eligible: number;
    rate: number;
  };

  it('selects the concrete issues behind all six Ali metric cards', () => {
    const selectAliMetricIssues = Reflect.get(
      riskDashboardModel,
      'selectAliMetricIssues',
    ) as SelectMetricIssues | undefined;

    expect(selectAliMetricIssues).toEqual(expect.any(Function));
    if (!selectAliMetricIssues) return;

    const before = JSON.stringify(metricDashboard.issues);
    expect(
      selectAliMetricIssues(metricDashboard, 'historyTotal').map(
        ({ id }) => id,
      ),
    ).toEqual([
      'history-completed',
      'monthly-rectifying',
      'monthly-suspended',
      'history-unknown',
    ]);
    expect(
      selectAliMetricIssues(metricDashboard, 'unclosed').map(({ id }) => id),
    ).toEqual(['monthly-rectifying', 'monthly-suspended', 'history-unknown']);
    expect(
      selectAliMetricIssues(metricDashboard, 'overdueUnclosed').map(
        ({ id }) => id,
      ),
    ).toEqual(['monthly-rectifying']);
    expect(
      selectAliMetricIssues(metricDashboard, 'monthlyAdded').map(
        ({ id }) => id,
      ),
    ).toEqual(['monthly-rectifying', 'monthly-suspended']);
    expect(
      selectAliMetricIssues(metricDashboard, 'rectificationRate').map(
        ({ id }) => id,
      ),
    ).toEqual(['history-completed', 'monthly-rectifying']);
    expect(
      selectAliMetricIssues(metricDashboard, 'monthlyClosed').map(
        ({ id }) => id,
      ),
    ).toEqual(['history-completed']);
    expect(selectAliMetricIssues(metricDashboard, 'historyTotal')).toHaveLength(
      metricDashboard.summary.historyTotal,
    );
    expect(selectAliMetricIssues(metricDashboard, 'unclosed')).toHaveLength(
      metricDashboard.unresolvedIssues.length,
    );
    expect(
      selectAliMetricIssues(metricDashboard, 'overdueUnclosed'),
    ).toHaveLength(metricDashboard.overdueIssues.length);
    expect(selectAliMetricIssues(metricDashboard, 'monthlyAdded')).toHaveLength(
      metricDashboard.summary.monthlyAdded,
    );
    expect(
      selectAliMetricIssues(metricDashboard, 'monthlyClosed'),
    ).toHaveLength(metricDashboard.summary.monthlyClosed);
    expect(JSON.stringify(metricDashboard.issues)).toBe(before);
  });

  it('keeps the unclosed metric in sync with the active filters', () => {
    const filtered = getRiskDashboardView(metricDashboard, {
      specialty: '电气',
      level: 'medium',
      status: 'rectifying',
    });

    expect(
      riskDashboardModel
        .selectAliMetricIssues(filtered, 'unclosed')
        .map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
  });

  it('searches metric issues across business fields after normalization', () => {
    const filterAliMetricIssues = Reflect.get(
      riskDashboardModel,
      'filterAliMetricIssues',
    ) as FilterMetricIssues | undefined;

    expect(filterAliMetricIssues).toEqual(expect.any(Function));
    if (!filterAliMetricIssues) return;

    expect(
      filterAliMetricIssues(metricIssues, '  battery  ').map(({ id }) => id),
    ).toEqual(['history-completed']);
    expect(
      filterAliMetricIssues(metricIssues, ' alice ').map(({ id }) => id),
    ).toEqual(['history-completed']);
    expect(
      filterAliMetricIssues(metricIssues, '2026-07-11').map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      filterAliMetricIssues(metricIssues, ' B楼 ').map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      filterAliMetricIssues(metricIssues, ' 电气 ').map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      filterAliMetricIssues(metricIssues, ' 中风险 ').map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      filterAliMetricIssues(metricIssues, ' 整改中 ').map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      filterAliMetricIssues(metricIssues, '2026-07-10').map(({ id }) => id),
    ).toEqual(['monthly-suspended']);
    expect(
      filterAliMetricIssues(metricIssues, '2026-07-02').map(({ id }) => id),
    ).toEqual(['history-completed']);
  });

  it('reports the completion numerator, denominator and rounded rate', () => {
    const getAliRectificationStats = Reflect.get(
      riskDashboardModel,
      'getAliRectificationStats',
    ) as RectificationStats | undefined;

    expect(getAliRectificationStats).toEqual(expect.any(Function));
    if (!getAliRectificationStats) return;

    const stats = getAliRectificationStats(metricIssues);
    expect(stats).toEqual({
      completed: 1,
      eligible: 2,
      rate: 50,
    });
    expect(stats.rate).toBe(metricDashboard.summary.rectificationRate);
    expect(getAliRectificationStats([])).toEqual({
      completed: 0,
      eligible: 0,
      rate: 0,
    });
  });

  it('selects the concrete Ali issues behind donut, trend and category charts', () => {
    type ChartIssueScope =
      | { kind: 'severity'; level: AliRiskIssue['level'] }
      | { kind: 'status'; status: AliRiskIssue['status'] }
      | { kind: 'specialty'; specialty: string }
      | { kind: 'trend'; periodStart: string };
    type SelectChartIssues = (
      source: AliRiskInspectionDashboard,
      scope: ChartIssueScope,
    ) => AliRiskIssue[];
    const selectAliChartIssues = Reflect.get(
      riskDashboardModel,
      'selectAliChartIssues',
    ) as SelectChartIssues | undefined;

    expect(selectAliChartIssues).toEqual(expect.any(Function));
    if (!selectAliChartIssues) return;

    expect(
      selectAliChartIssues(metricDashboard, {
        kind: 'severity',
        level: 'medium',
      }).map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      selectAliChartIssues(metricDashboard, {
        kind: 'status',
        status: 'rectifying',
      }).map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      selectAliChartIssues(metricDashboard, {
        kind: 'status',
        status: 'completed',
      }).map(({ id }) => id),
    ).toEqual([]);
    expect(
      selectAliChartIssues(metricDashboard, {
        kind: 'specialty',
        specialty: '电气',
      }).map(({ id }) => id),
    ).toEqual(['monthly-rectifying']);
    expect(
      selectAliChartIssues(metricDashboard, {
        kind: 'trend',
        periodStart: '7/8',
      }).map(({ id }) => id),
    ).toEqual(['monthly-rectifying', 'monthly-suspended']);
  });
});

function crossIssue(
  id: string,
  overrides: Partial<CrossInspectionIssue>,
): CrossInspectionIssue {
  return {
    id,
    building: 'A楼',
    month: '2026-07',
    tag: '消防',
    type: '安全隐患',
    description: `${id}问题`,
    owner: '张三',
    rectification: '待整改',
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('cross-inspection ledger filters', () => {
  const issues = [
    crossIssue('cross-1', {
      description: '配电柜积尘',
    }),
    crossIssue('cross-2', {
      building: 'B楼',
      month: '2026-06',
      type: '环境卫生',
      description: '通道堆物',
      owner: '李四',
    }),
    crossIssue('cross-3', {
      type: '环境卫生',
      description: '消防通道占用',
      owner: '王五',
    }),
  ];

  it.each([
    ['building', { building: 'A楼' }, ['cross-1', 'cross-3']],
    ['month', { month: '2026-06' }, ['cross-2']],
    ['type', { type: '安全隐患' }, ['cross-1']],
    ['description query', { query: '通道' }, ['cross-2', 'cross-3']],
    ['owner query', { query: '  李四  ' }, ['cross-2']],
  ])('filters ledger issues by %s only', (_label, filters, expectedIds) => {
    const result = filterCrossLedgerIssues(issues, {
      building: 'all',
      month: 'all',
      type: 'all',
      query: '',
      ...filters,
    });

    expect(result.map(({ id }) => id)).toEqual(expectedIds);
  });

  it('combines all ledger conditions without modifying the input', () => {
    const before = JSON.stringify(issues);

    const result = filterCrossLedgerIssues(issues, {
      building: 'A楼',
      month: '2026-07',
      type: '环境卫生',
      query: '  王五 ',
    });

    expect(result.map(({ id }) => id)).toEqual(['cross-3']);
    expect(result).not.toBe(issues);
    expect(JSON.stringify(issues)).toBe(before);
  });
});

describe('cross-inspection metric issue lists', () => {
  const issues = [
    crossIssue('cross-history-closed', {
      month: '5月',
      status: 'closed',
      rectification: '已整改',
    }),
    crossIssue('cross-legacy', {
      month: '5月',
      status: 'pending',
      rectification: '待整改',
    }),
    crossIssue('cross-monthly', {
      month: '6月',
      status: 'pending',
      rectification: '待整改',
    }),
  ];
  const dashboard = {
    selectedMonth: '6月',
    summary: {
      historyTotal: 3,
      monthlyTotal: 1,
      legacyTotal: 1,
      closureRate: 0,
    },
    buildingRectification: [],
    legacyIssues: [issues[1]],
    issues,
    options: {
      buildings: ['A楼'],
      months: ['6月', '5月'],
      types: ['安全隐患'],
    },
    sourceUpdatedAt: null,
    syncedAt: '2026-07-20T00:00:00.000Z',
    sourceStatus: 'fresh' as const,
    warnings: [],
  };

  it('keeps history, current month and legacy issue scopes distinct', () => {
    type CrossMetricKey =
      | 'historyTotal'
      | 'monthlyTotal'
      | 'legacyTotal'
      | 'closureRate';
    type SelectCrossMetricIssues = (
      source: typeof dashboard,
      key: CrossMetricKey,
    ) => CrossInspectionIssue[];
    const selectCrossMetricIssues = Reflect.get(
      riskDashboardModel,
      'selectCrossMetricIssues',
    ) as SelectCrossMetricIssues | undefined;

    expect(selectCrossMetricIssues).toEqual(expect.any(Function));
    if (!selectCrossMetricIssues) return;

    expect(
      selectCrossMetricIssues(dashboard, 'historyTotal').map(({ id }) => id),
    ).toEqual(['cross-history-closed', 'cross-legacy', 'cross-monthly']);
    expect(
      selectCrossMetricIssues(dashboard, 'monthlyTotal').map(({ id }) => id),
    ).toEqual(['cross-monthly']);
    expect(
      selectCrossMetricIssues(dashboard, 'legacyTotal').map(({ id }) => id),
    ).toEqual(['cross-legacy']);
    expect(
      selectCrossMetricIssues(dashboard, 'closureRate').map(({ id }) => id),
    ).toEqual(['cross-history-closed', 'cross-legacy', 'cross-monthly']);
  });
});

describe('cross-inspection issue overview', () => {
  const issues = [
    crossIssue('overview-a-closed', {
      building: 'A楼',
      month: '6月',
      status: 'closed',
      rectification: '已补齐',
    }),
    crossIssue('overview-a-open', {
      building: 'A楼',
      month: '6月',
      status: 'unresolved',
      rectification: '',
    }),
    crossIssue('overview-c-closed', {
      building: 'C楼',
      month: '6月',
      status: 'closed',
      rectification: '已更新',
    }),
    crossIssue('overview-july', {
      building: 'B楼',
      month: '7月',
      status: 'unresolved',
      rectification: '',
    }),
  ];

  it('defaults the independent overview month to the previous Shanghai month', () => {
    expect(
      getDefaultCrossOverviewMonth(
        ['7月', '6月', '5月'],
        '7月',
        new Date('2026-07-20T03:00:00.000Z'),
      ),
    ).toBe('6月');
    expect(
      getDefaultCrossOverviewMonth(
        ['1月', '12月'],
        '1月',
        new Date('2026-01-08T03:00:00.000Z'),
      ),
    ).toBe('12月');
  });

  it('falls back to the selected source month when the previous month is unavailable', () => {
    expect(
      getDefaultCrossOverviewMonth(
        ['7月', '5月'],
        '7月',
        new Date('2026-07-20T03:00:00.000Z'),
      ),
    ).toBe('7月');
  });

  it('builds the overview chart from the chosen month only', () => {
    expect(buildCrossBuildingRectification(issues, '6月')).toEqual([
      {
        building: 'A楼',
        issueCount: 2,
        completedCount: 1,
        rate: 50,
      },
      {
        building: 'C楼',
        issueCount: 1,
        completedCount: 1,
        rate: 100,
      },
    ]);
  });
});

describe('cross-inspection ledger pagination', () => {
  it('shows the first five pages near the start', () => {
    expect(getPaginationWindow(1, 10)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the current page centered in the middle', () => {
    expect(getPaginationWindow(6, 10)).toEqual([4, 5, 6, 7, 8]);
  });

  it('shows the final five pages near the end', () => {
    expect(getPaginationWindow(10, 10)).toEqual([6, 7, 8, 9, 10]);
  });

  it('clamps the window when the total page count shrinks', () => {
    expect(getPaginationWindow(9, 3)).toEqual([1, 2, 3]);
  });
});
