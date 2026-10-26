import type { TodayOperationsKpiBuildingMetricHistoryPeriod } from '../../../shared/today-operations-kpi.interface';

export type DailyOperationsPatrolCheckKey =
  | 'facility'
  | 'schedule'
  | 'plan'
  | 'weather';

export type DailyOperationsPatrolCheckStatus =
  | 'normal'
  | 'alert'
  | 'unavailable';

export interface DailyOperationsPatrolIssue {
  id: string;
  check: DailyOperationsPatrolCheckKey;
  title: string;
  detail: string;
  date: string;
  severity: 'warning' | 'unavailable';
}
export interface DailyOperationsPatrolCheckResult {
  key: DailyOperationsPatrolCheckKey;
  label: string;
  status: DailyOperationsPatrolCheckStatus;
  count: number;
  summary: string;
  issues: DailyOperationsPatrolIssue[];
}

export interface DailyOperationsPatrolFacilityMetric {
  key: string;
  label: string;
  unit: string;
  history?: TodayOperationsKpiBuildingMetricHistoryPeriod[];
}

export interface DailyOperationsPatrolReport {
  businessDate: string;
  startDate: string;
  endDate: string;
  generatedAt: string;
  evaluatedFacilityPoints: number;
  checks: DailyOperationsPatrolCheckResult[];
  totalIssues: number;
  hasAlerts: boolean;
}
