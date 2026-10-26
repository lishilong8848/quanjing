import { createHash } from 'node:crypto';
import type { TodayOperationsAlarmDashboardResponse } from '../../../shared/today-operations-alarm.interface';
import type {
  TodayOperationsKpiBuildingMetricDetails,
  TodayOperationsKpiResponse,
} from '../../../shared/today-operations-kpi.interface';
import type { TodayOperationsOverviewResponse } from '../../../shared/today-operations-overview.interface';
import type {
  TodayOperationsAnomaly,
  TodayOperationsAnomalyCategory,
} from './today-operations-anomaly.types';
import type { TodayOperationsScheduleConsistencyIssue } from './today-operations-schedule-consistency';

interface RelativeChangeInput {
  current: number;
  previous: number;
  threshold: number;
}

interface RelativeChangeResult {
  category: Extract<TodayOperationsAnomalyCategory, 'increase' | 'decrease'>;
  changePercent: number | null;
}

export interface DetectTodayOperationsAnomaliesInput {
  businessDate: string;
  detectedAt: string;
  thresholdPercent: number;
  kpi?: TodayOperationsKpiResponse;
  kpiError?: string;
  overview?: TodayOperationsOverviewResponse;
  overviewError?: string;
  alarms?: TodayOperationsAlarmDashboardResponse;
  alarmError?: string;
  scheduleConsistencyIssues?: TodayOperationsScheduleConsistencyIssue[];
  scheduleConsistencyError?: string;
}

interface AnomalyDraft extends Omit<
  TodayOperationsAnomaly,
  'anomalyId' | 'businessDate' | 'detectedAt'
> {}

const KPI_CHANGE_METRICS = {
  averagePue: {
    label: '平均PUE',
    unit: '',
    location: '今日航图 > 运行摘要 > 平均PUE',
  },
  itLoadRate: {
    label: 'IT负载率',
    unit: '%',
    location: '今日航图 > 运行摘要 > IT负载率',
  },
  electricityKwh: {
    label: '用电量',
    unit: 'KWh',
    location: '今日航图 > 运行摘要 > 用电量',
  },
  waterTons: {
    label: '耗水量',
    unit: 't',
    location: '今日航图 > 运行摘要 > 耗水量',
  },
} as const;

const OVERVIEW_SOURCE_LABELS = {
  events: '今日事件',
  changes: '今日变更',
  inspections: '今日检修',
  maintenance: '今日维保',
} as const;

const REQUIRED_BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const;

export function detectRelativeChange(
  input: RelativeChangeInput,
): RelativeChangeResult | null {
  if (
    !Number.isFinite(input.current) ||
    !Number.isFinite(input.previous) ||
    !Number.isFinite(input.threshold) ||
    input.threshold < 0
  ) {
    return null;
  }
  if (input.previous === 0) {
    return input.current > 0
      ? { category: 'increase', changePercent: null }
      : null;
  }
  const changePercent = round(
    ((input.current - input.previous) / Math.abs(input.previous)) * 100,
    1,
  );
  if (Math.abs(changePercent) <= input.threshold) return null;
  return {
    category: changePercent > 0 ? 'increase' : 'decrease',
    changePercent,
  };
}

export function detectTodayOperationsAnomalies(
  input: DetectTodayOperationsAnomaliesInput,
): TodayOperationsAnomaly[] {
  const drafts: AnomalyDraft[] = [];
  collectKpiAnomalies(input, drafts);
  collectOverviewAnomalies(input, drafts);
  collectAlarmAnomalies(input, drafts);
  collectScheduleConsistencyAnomalies(input, drafts);
  return drafts
    .map((draft) => toAnomaly(input, draft))
    .sort((left, right) =>
      `${left.category}:${left.metricKey}:${left.scope}`.localeCompare(
        `${right.category}:${right.metricKey}:${right.scope}`,
      ),
    );
}

export function detectTodayOperationsScheduleConsistencyAnomalies(input: {
  businessDate: string;
  detectedAt: string;
  issues: TodayOperationsScheduleConsistencyIssue[];
}): TodayOperationsAnomaly[] {
  const drafts: AnomalyDraft[] = [];
  collectScheduleConsistencyAnomalies(
    {
      businessDate: input.businessDate,
      detectedAt: input.detectedAt,
      thresholdPercent: 0,
      scheduleConsistencyIssues: input.issues,
    },
    drafts,
  );
  return drafts
    .map((draft) => toAnomaly(input, draft))
    .sort((left, right) =>
      `${left.category}:${left.metricKey}:${left.scope}`.localeCompare(
        `${right.category}:${right.metricKey}:${right.scope}`,
      ),
    );
}

function collectScheduleConsistencyAnomalies(
  input: DetectTodayOperationsAnomaliesInput,
  drafts: AnomalyDraft[],
): void {
  if (input.scheduleConsistencyError) {
    drafts.push(
      missingDraft({
        metricKey: 'scheduleConsistencySource',
        metricLabel: '排班与人员变动一致性',
        location: '排班页面 > 排班与人员变动一致性',
        details: [
          cleanError(
            input.scheduleConsistencyError,
            '排班与人员变动一致性数据不可用',
          ),
        ],
      }),
    );
    return;
  }

  for (const issue of input.scheduleConsistencyIssues || []) {
    drafts.push(
      missingDraft({
        metricKey: `scheduleConsistency.${issue.kind}.${issue.issueId}`,
        metricLabel:
          issue.kind === 'approved_leave_substitute_mismatch'
            ? '已审批请假替班未更新排班'
            : issue.kind === 'approved_substitute_missing'
              ? '已审批替班未更新排班'
              : '已审批请假仍在排班',
        scope: issue.scope,
        location: issue.location,
        dataDate: issue.dataDate,
        details: issue.details,
      }),
    );
  }
}

function collectKpiAnomalies(
  input: DetectTodayOperationsAnomaliesInput,
  drafts: AnomalyDraft[],
): void {
  if (!input.kpi) {
    drafts.push(
      missingDraft({
        metricKey: 'kpiSource',
        metricLabel: '运行摘要',
        location: '今日航图 > 运行摘要',
        details: [cleanError(input.kpiError, '顶部指标数据不可用')],
      }),
    );
    return;
  }
  if (input.kpi.sourceStatus === 'stale') {
    drafts.push(
      missingDraft({
        metricKey: 'kpiSource',
        metricLabel: '运行摘要',
        location: '今日航图 > 运行摘要',
        details: ['当前使用最近一次成功同步的数据'],
      }),
    );
  }

  for (const [metricKey, config] of Object.entries(KPI_CHANGE_METRICS) as Array<
    [
      keyof typeof KPI_CHANGE_METRICS,
      (typeof KPI_CHANGE_METRICS)[keyof typeof KPI_CHANGE_METRICS],
    ]
  >) {
    const metric = input.kpi.metrics[metricKey];
    if (metric.previousValue === null) {
      drafts.push(
        missingDraft({
          metricKey,
          metricLabel: config.label,
          location: config.location,
          details: [`${config.label}缺少对比值`],
          currentValue: metric.value,
          dataDate: metric.date,
          unit: config.unit,
        }),
      );
      continue;
    }
    const change = detectRelativeChange({
      current: metric.value,
      previous: metric.previousValue,
      threshold: input.thresholdPercent,
    });
    if (change) {
      drafts.push({
        ...change,
        metricKey,
        metricLabel: config.label,
        scope: '园区',
        location: config.location,
        currentValue: metric.value,
        previousValue: metric.previousValue,
        unit: config.unit,
        dataDate: metric.date,
        comparisonDate: null,
        details: [],
      });
    }
  }

  const buildingMetrics = input.kpi.details.buildingMetrics;
  if (!buildingMetrics) return;
  collectBuildingMetricGaps(
    'averagePue',
    '平均PUE',
    buildingMetrics.averagePue,
    drafts,
  );
  collectBuildingMetricGaps(
    'electricityKwh',
    '用电量',
    buildingMetrics.electricityKwh,
    drafts,
  );
  collectBuildingMetricGaps(
    'waterTons',
    '耗水量',
    buildingMetrics.waterTons,
    drafts,
  );
}

function collectBuildingMetricGaps(
  metricKey: string,
  metricLabel: string,
  metric: TodayOperationsKpiBuildingMetricDetails,
  drafts: AnomalyDraft[],
): void {
  for (const row of metric.rows) {
    if (!metric.includedBuildings.includes(row.building)) continue;
    const details: string[] = [];
    if (row.value === null) details.push(`${row.building}缺少当前值`);
    if (row.previousValue === null) details.push(`${row.building}缺少对比值`);
    if (details.length === 0) continue;
    drafts.push(
      missingDraft({
        metricKey,
        metricLabel,
        scope: row.building,
        location: `今日航图 > 运行摘要 > ${metricLabel} > ${row.building}`,
        details,
        currentValue: row.value,
        previousValue: row.previousValue,
        dataDate: metric.date,
        comparisonDate: metric.previousDate,
      }),
    );
  }
}

function collectOverviewAnomalies(
  input: DetectTodayOperationsAnomaliesInput,
  drafts: AnomalyDraft[],
): void {
  if (!input.overview) {
    drafts.push(
      missingDraft({
        metricKey: 'overviewSource',
        metricLabel: '机柜与运维概况',
        location: '今日航图 > 机柜与运维概况',
        details: [cleanError(input.overviewError, '概览数据不可用')],
      }),
    );
    return;
  }
  if (input.overview.sourceStatus !== 'fresh') {
    drafts.push(
      missingDraft({
        metricKey: 'overviewSource',
        metricLabel: '机柜与运维概况',
        location: '今日航图 > 机柜与运维概况',
        details: [`数据源状态：${input.overview.sourceStatus}`],
      }),
    );
  }
  for (const [kind, source] of Object.entries(
    input.overview.sourceStates,
  ) as Array<
    [
      keyof typeof OVERVIEW_SOURCE_LABELS,
      TodayOperationsOverviewResponse['sourceStates'][keyof typeof OVERVIEW_SOURCE_LABELS],
    ]
  >) {
    if (source.status !== 'failed') continue;
    const label = OVERVIEW_SOURCE_LABELS[kind];
    drafts.push(
      missingDraft({
        metricKey: `operations.${kind}`,
        metricLabel: label,
        location: `今日航图 > 02 运维概况一览 > ${label}`,
        details: [cleanError(source.errorMessage, `${label}数据源失败`)],
      }),
    );
  }

  const rack = input.overview.rackSummary;
  if (!rack) {
    drafts.push(
      missingDraft({
        metricKey: 'rackSource',
        metricLabel: '机柜使用概览',
        location: '今日航图 > 01 机柜使用概览',
        details: [
          cleanError(
            input.overview.rackSourceState?.errorMessage,
            '机柜数据不可用',
          ),
        ],
      }),
    );
    return;
  }
  for (const building of REQUIRED_BUILDINGS) {
    const usage = rack.buildingUsages.find((row) => row.building === building);
    if (!usage || usage.total <= 0) {
      drafts.push(
        missingDraft({
          metricKey: 'rackUsage',
          metricLabel: '机柜上架率',
          scope: building,
          location: `今日航图 > 01 机柜使用概览 > ${building}`,
          details: [`${building}缺少有效设计机柜或上架机柜数据`],
          dataDate: rack.capacityDate,
        }),
      );
    }
    if (!rack.buildingLoads.some((row) => row.building === building)) {
      drafts.push(
        missingDraft({
          metricKey: 'rackItLoad',
          metricLabel: '各楼IT负载率',
          scope: building,
          location: `今日航图 > 01 机柜使用概览 > 各楼IT负载率 > ${building}`,
          details: [`${building}缺少IT负载率`],
          dataDate: rack.loadDate,
        }),
      );
    }
  }
}

function collectAlarmAnomalies(
  input: DetectTodayOperationsAnomaliesInput,
  drafts: AnomalyDraft[],
): void {
  if (!input.alarms) {
    drafts.push(
      missingDraft({
        metricKey: 'alarmSource',
        metricLabel: '告警信息',
        location: '今日航图 > 03 园区近日告警信息总览',
        details: [cleanError(input.alarmError, '告警数据不可用')],
      }),
    );
    return;
  }
  if (input.alarms.sourceStatus === 'stale') {
    drafts.push(
      missingDraft({
        metricKey: 'alarmSource',
        metricLabel: '告警信息',
        location: '今日航图 > 03 园区近日告警信息总览',
        details: ['当前使用最近一次成功同步的告警数据'],
      }),
    );
  }
  const current = input.alarms.summary.yesterdayTotal;
  const previous = input.alarms.summary.dayBeforeYesterdayTotal;
  const change = detectRelativeChange({
    current,
    previous,
    threshold: input.thresholdPercent,
  });
  if (!change || change.category === 'decrease') return;
  const details = input.alarms.yesterdayByBuilding
    .filter((row) => row.total > 0)
    .sort((left, right) => right.total - left.total)
    .map((row) => `${row.building} ${row.total}条`);
  drafts.push({
    ...change,
    metricKey: 'alarms.yesterdayTotal',
    metricLabel: '昨日告警总数',
    scope: '园区',
    location: '今日航图 > 03 园区近日告警信息总览 > 昨日告警总数',
    currentValue: current,
    previousValue: previous,
    unit: '条',
    dataDate: input.alarms.window.yesterdayDate,
    comparisonDate: previousShanghaiDate(input.alarms.window.yesterdayDate),
    details,
  });
}

function missingDraft(
  input: Partial<AnomalyDraft> &
    Pick<AnomalyDraft, 'metricKey' | 'metricLabel' | 'location' | 'details'>,
): AnomalyDraft {
  return {
    category: 'missing',
    scope: '园区',
    currentValue: null,
    previousValue: null,
    changePercent: null,
    unit: '',
    dataDate: null,
    comparisonDate: null,
    ...input,
  };
}

function toAnomaly(
  input: Pick<
    DetectTodayOperationsAnomaliesInput,
    'businessDate' | 'detectedAt'
  >,
  draft: AnomalyDraft,
): TodayOperationsAnomaly {
  const stableKey = [
    input.businessDate,
    draft.category,
    draft.metricKey,
    draft.scope,
  ].join('|');
  return {
    ...draft,
    anomalyId: createHash('sha256').update(stableKey).digest('hex'),
    businessDate: input.businessDate,
    detectedAt: input.detectedAt,
  };
}

function previousShanghaiDate(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function cleanError(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).replace(/[\r\n\t]/gu, ' ').slice(0, 300);
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
