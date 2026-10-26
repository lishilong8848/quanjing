import type { MonthlySourceState } from './monthly-operations-resources.interface';
import type { TodayOperationsAlarmTagIssue, TodayOperationsAlarmTagReviewStatus } from './today-operations-alarm.interface';
export interface MonthlyAlarm {
  id: string;
  title: string;
  building: string;
  date: string;
  tags: string[];
  tagIssues: TodayOperationsAlarmTagIssue[];
  acceptanceDescription: string;
  confirmationDescription: string;
  detail: { label: string; value: string }[];
  level: string;
  occurredAt: string;
  recoveredAt: string | null;
  confirmedAt: string | null;
  process: string;
  recovery: string;
  expected: string;
  category: string;
  object: string;
  location: string;
  minutes: number | null;
  repeatKey: string;
}
export interface MonthlyAlarmsResponse extends MonthlySourceState {
  range: { start: string; end: string; asOf: string };
  records: MonthlyAlarm[];
  invalid: number;
  tagReview: TodayOperationsAlarmTagReviewStatus;
}
