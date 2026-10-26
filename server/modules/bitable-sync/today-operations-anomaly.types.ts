export type TodayOperationsAnomalyCategory =
  | 'missing'
  | 'increase'
  | 'decrease';

export interface TodayOperationsAnomaly {
  anomalyId: string;
  businessDate: string;
  category: TodayOperationsAnomalyCategory;
  metricKey: string;
  metricLabel: string;
  scope: string;
  location: string;
  currentValue: number | null;
  previousValue: number | null;
  changePercent: number | null;
  unit: string;
  dataDate: string | null;
  comparisonDate: string | null;
  details: string[];
  detectedAt: string;
}

export interface TodayOperationsAnomalyEvent {
  anomalyEventId: string;
  businessDate: string;
  anomalies: TodayOperationsAnomaly[];
  detectedAt: string;
  followUpSource?: TodayOperationsFollowUpSource;
}

export type TodayOperationsAnomalyTerminal = 'acknowledged' | 'resolved';

export type TodayOperationsFollowUpSource =
  | '今日航图'
  | '每日巡视'
  | '考勤通晒'
  | '人工登记'
  | '历史手工跟进';

export interface TodayOperationsFollowUpRecord {
  recordId: string;
  issueKey: string;
  date: string;
  source: TodayOperationsFollowUpSource;
  item: string;
  description: string;
  building: string;
  acknowledged: boolean;
  completed: boolean;
  treatmentMeasure: string;
  handlerName: string;
  handledAt: string;
}

export interface TodayOperationsFollowUpUpdate {
  recordId: string;
  acknowledged: boolean;
  completed: boolean;
  treatmentMeasure: string;
  handlerName?: string;
  clientMutationId: string;
}
