import { createHash } from 'node:crypto';
import type { AttendanceSummarySection } from '../duty-schedule/attendance-automation.card';
import type { DailyOperationsPatrolReport } from '../duty-schedule/daily-operations-patrol.types';
import type {
  TodayOperationsAnomaly,
  TodayOperationsAnomalyEvent,
} from './today-operations-anomaly.types';

export function buildPatrolFollowUpEvent(
  report: DailyOperationsPatrolReport,
): TodayOperationsAnomalyEvent | null {
  const anomalies = report.checks.flatMap((check) =>
    check.issues.map((issue) => {
      const scope = findBuilding(`${issue.title} ${issue.detail}`) || '园区';
      return {
        anomalyId: stableId(
          `daily-patrol:${report.businessDate}:${issue.check}:${issue.id}`,
        ),
        businessDate: report.businessDate,
        category: issue.severity === 'unavailable' ? 'missing' : 'increase',
        metricKey: `dailyPatrol.${issue.check}.${issue.id}`,
        metricLabel: issue.title,
        scope,
        location: `南通每日运维巡视 > ${check.label}`,
        currentValue: null,
        previousValue: null,
        changePercent: null,
        unit: '',
        dataDate: issue.date || report.businessDate,
        comparisonDate: null,
        details: [issue.detail].filter(Boolean),
        detectedAt: report.generatedAt,
      } satisfies TodayOperationsAnomaly;
    }),
  );
  if (!anomalies.length) return null;
  return {
    anomalyEventId: stableId(`daily-patrol-event:${report.businessDate}`),
    businessDate: report.businessDate,
    anomalies: uniqueAnomalies(anomalies),
    detectedAt: report.generatedAt,
    followUpSource: '每日巡视',
  };
}

export function buildAttendanceFollowUpEvents(
  sections: readonly AttendanceSummarySection[],
  detectedAt: string,
): TodayOperationsAnomalyEvent[] {
  const byDate = new Map<string, TodayOperationsAnomaly[]>();
  for (const section of sections) {
    for (const item of section.anomalies) {
      const anomalies = byDate.get(section.date) || [];
      anomalies.push({
        anomalyId: stableId(`attendance-follow-up:${item.key}`),
        businessDate: section.date,
        category: 'missing',
        metricKey: `attendance.${item.key}`,
        metricLabel: `${item.name}${item.direction === 'OnDuty' ? '上班' : '下班'}考勤异常`,
        scope: item.building || '园区',
        location: `考勤自动化 > ${section.title}`,
        currentValue: null,
        previousValue: null,
        changePercent: null,
        unit: '',
        dataDate: section.date,
        comparisonDate: null,
        details: [
          `${item.shiftLabel} ${item.direction === 'OnDuty' ? '上班' : '下班'}：${item.reason}`,
        ],
        detectedAt,
      });
      byDate.set(section.date, anomalies);
    }
  }
  return [...byDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([businessDate, anomalies]) => ({
      anomalyEventId: stableId(`attendance-follow-up-event:${businessDate}`),
      businessDate,
      anomalies: uniqueAnomalies(anomalies),
      detectedAt,
      followUpSource: '考勤通晒' as const,
    }));
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueAnomalies(
  anomalies: readonly TodayOperationsAnomaly[],
): TodayOperationsAnomaly[] {
  return [
    ...new Map(
      anomalies.map((anomaly) => [anomaly.anomalyId, anomaly]),
    ).values(),
  ].sort((left, right) => left.metricKey.localeCompare(right.metricKey));
}

function findBuilding(value: string): string {
  return value.match(/(?:110站|[ABCDEH]楼)/u)?.[0] || '';
}
