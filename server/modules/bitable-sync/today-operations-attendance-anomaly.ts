import { createHash } from 'node:crypto';
import type { AttendanceDailySummary } from '../duty-schedule/attendance-daily-summary.store';
import type { TodayOperationsAnomaly } from './today-operations-anomaly.types';

export function buildYesterdayAttendanceAnomalies(input: {
  businessDate: string;
  summaryDate?: string;
  effectiveFrom?: string;
  summary: AttendanceDailySummary | null;
  summaryError?: string;
  detectedAt: string;
  required?: boolean;
}): TodayOperationsAnomaly[] {
  const summaryDate = input.summaryDate || input.summary?.businessDate || '';
  const effectiveFrom = input.effectiveFrom || '2026-08-28';
  if (!input.summary) {
    if (!input.required || !summaryDate || summaryDate < effectiveFrom)
      return [];
    const stableKey = `${input.businessDate}|attendance-source|${summaryDate}`;
    return [
      {
        anomalyId: createHash('sha256').update(stableKey).digest('hex'),
        businessDate: input.businessDate,
        category: 'missing',
        metricKey: `attendance.source.${summaryDate}`,
        metricLabel: '昨日考勤数据异常',
        scope: '园区',
        location: `考勤自动化 > ${summaryDate} 00:30 昨日归档`,
        currentValue: null,
        previousValue: null,
        changePercent: null,
        unit: '',
        dataDate: summaryDate,
        comparisonDate: null,
        details: [
          cleanError(
            input.summaryError,
            '00:30 同步结果不存在，昨日考勤按异常处理',
          ),
        ],
        detectedAt: input.detectedAt,
      },
    ];
  }
  return input.summary.anomalies.map((anomaly) => {
    const direction = anomaly.direction === 'OnDuty' ? '上班卡' : '下班卡';
    const identity =
      anomaly.status === 'substitute'
        ? '替班人员'
        : anomaly.status === 'vacancy_substitute'
          ? '临时替班人员'
          : '在岗人员';
    const stableKey = `${input.businessDate}|attendance|${anomaly.key}`;
    return {
      anomalyId: createHash('sha256').update(stableKey).digest('hex'),
      businessDate: input.businessDate,
      category: 'missing',
      metricKey: `attendance.${anomaly.key}`,
      metricLabel: '昨日考勤异常',
      scope: `${anomaly.building} · ${anomaly.name}`,
      location: `排班页面 > ${input.summary!.businessDate} ${anomaly.building} ${anomaly.shiftLabel}`,
      currentValue: null,
      previousValue: null,
      changePercent: null,
      unit: '',
      dataDate: input.summary.businessDate,
      comparisonDate: null,
      details: [
        `${identity}；${direction}应打 ${anomaly.expectedAt.slice(11, 16)}；${anomaly.reason}`,
      ],
      detectedAt: input.detectedAt,
    };
  });
}

function cleanError(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback)
    .replace(
      /(app[_-]?secret|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;}&]+/giu,
      '$1=***',
    )
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 300);
}
