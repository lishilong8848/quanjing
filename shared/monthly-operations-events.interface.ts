import type { MonthlySourceState } from './monthly-operations-resources.interface';
export interface MonthlyEventReviewReport {
  label: '首次复盘' | '二次复盘';
  title: string;
  url: string;
}
export interface MonthlyEventReviewReportContent {
  title: string;
  kind: 'document' | 'file';
  content: string | null;
  message: string;
}
export interface MonthlyEvent {
  id: string;
  code: string;
  title: string;
  building: string;
  specialty: string;
  source: string;
  level: string;
  finalLevel: string;
  keyEvent: boolean;
  occurredAt: string;
  date: string;
  status: string;
  closed: boolean | null;
  repair: 'none' | 'active' | 'done' | 'unknown';
  durationDays: number | null;
  progress: string;
  recoveredAt: string | null;
  endedAt: string | null;
  repairedAt: string | null;
  needsReview: boolean;
  reviewReports: MonthlyEventReviewReport[];
  cause: string;
  resolution: string;
}
export interface MonthlyEventsResponse extends MonthlySourceState {
  range: { start: string; end: string; asOf: string };
  records: MonthlyEvent[];
  excluded: number;
  invalid: number;
}
