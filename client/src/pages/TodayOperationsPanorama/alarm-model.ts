import type {
  TodayOperationsAlarmSummary,
  TodayOperationsAlarmTagReviewStatus,
} from '@shared/today-operations-alarm.interface';

import type { PanoramaAlarmKpi, PanoramaDirection } from './data';

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function formatInteger(value: number): string {
  return normalizeCount(value).toLocaleString('zh-CN');
}

function formatShare(value: number, total: number): string {
  const normalizedValue = normalizeCount(value);
  const normalizedTotal = normalizeCount(total);
  if (normalizedTotal <= 0) return '0.0%';
  return `${((normalizedValue / normalizedTotal) * 100).toFixed(1)}%`;
}

export function formatAlarmDateTime(value: string): string {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const valueByPart = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${valueByPart.year}/${valueByPart.month}/${valueByPart.day} ${valueByPart.hour}:${valueByPart.minute}`;
}

function resolveDailyComparison(
  current: number,
  previous: number,
): { comparison: string; direction: PanoramaDirection } {
  if (previous <= 0) {
    return {
      comparison: '前日无可比数据',
      direction: 'neutral',
    };
  }

  const change = ((current - previous) / previous) * 100;
  if (change === 0) {
    return {
      comparison: '与前日持平',
      direction: 'neutral',
    };
  }

  return {
    comparison: `较前日 ${Math.abs(change).toFixed(1)}%`,
    direction: change > 0 ? 'up' : 'down',
  };
}

export function buildAlarmKpis(
  summary: TodayOperationsAlarmSummary,
  tagReview?: TodayOperationsAlarmTagReviewStatus,
): PanoramaAlarmKpi[] {
  const yesterdayComparison = resolveDailyComparison(
    summary.yesterdayTotal,
    summary.dayBeforeYesterdayTotal,
  );

  return [
    {
      key: 'alarms-seven-days',
      title: '近7天告警总数',
      value: formatInteger(summary.sevenDayTotal),
      unit: '条',
      comparison: '覆盖最近7个完整自然日',
      direction: 'neutral',
      tone: 'blue',
      icon: 'siren',
      sparkline: [],
    },
    {
      key: 'alarms-expected',
      title: '预期内告警',
      value: formatInteger(summary.expectedTotal),
      unit: '条',
      comparison: `占近7天 ${formatShare(
        summary.expectedTotal,
        summary.sevenDayTotal,
      )}`,
      direction: 'neutral',
      tone: 'blue',
      icon: 'shield',
      sparkline: [],
    },
    {
      key: 'alarms-unexpected',
      title: '预期外告警',
      value: formatInteger(summary.unexpectedTotal),
      unit: '条',
      comparison: `占近7天 ${formatShare(
        summary.unexpectedTotal,
        summary.sevenDayTotal,
      )}`,
      direction: 'neutral',
      tone: 'red',
      icon: 'alarm',
      sparkline: [],
    },
    {
      key: 'alarms-double-unhandled',
      title: '双未告警数',
      value: formatInteger(summary.doubleUnhandledTotal),
      unit: '条',
      comparison: `占近7天 ${formatShare(
        summary.doubleUnhandledTotal,
        summary.sevenDayTotal,
      )}`,
      direction: 'neutral',
      tone: 'red',
      icon: 'bell',
      sparkline: [],
      helpText:
        '统计近 7 个完整自然日内，处理状态为“未处理”且恢复状态为“未恢复”的告警。',
    },
    {
      key: 'alarms-tag-anomaly',
      title: '异常打标',
      value: formatInteger(summary.tagAnomalyTotal),
      unit: '条',
      comparison:
        tagReview?.state === 'processing'
          ? `语义复核中 ${tagReview.reviewed}/${tagReview.total}`
          : tagReview?.state === 'unconfigured'
            ? '当前展示规则异常'
            : tagReview?.state === 'error'
              ? '语义复核暂不可用'
              : '规则及语义复核结果',
      direction: 'neutral',
      tone: 'orange',
      icon: 'tag',
      sparkline: [],
      helpText: '按告警记录去重；一条告警可包含多项异常。语义错标由 AI 提示，需人工确认。',
    },
    {
      key: 'alarms-yesterday',
      title: '昨日告警总数',
      value: formatInteger(summary.yesterdayTotal),
      unit: '条',
      comparison: yesterdayComparison.comparison,
      direction: yesterdayComparison.direction,
      tone: 'blue',
      icon: 'calendar',
      sparkline: [],
    },
    {
      key: 'alarms-pending',
      title: '待处理告警数',
      value: formatInteger(summary.pendingTotal),
      unit: '条',
      comparison: `占近7天 ${formatShare(
        summary.pendingTotal,
        summary.sevenDayTotal,
      )}`,
      direction: 'neutral',
      tone: 'orange',
      icon: 'history',
      sparkline: [],
      progress:
        summary.sevenDayTotal > 0
          ? Math.round((summary.pendingTotal / summary.sevenDayTotal) * 100)
          : 0,
    },
  ];
}
