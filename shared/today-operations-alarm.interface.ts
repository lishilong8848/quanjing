export const TODAY_OPERATIONS_ALARM_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
] as const;

export type TodayOperationsAlarmChartBuilding =
  (typeof TODAY_OPERATIONS_ALARM_BUILDINGS)[number];
export type TodayOperationsAlarmLevel = string;
export type TodayOperationsAlarmConfirmationStatus = '已确认' | '待确认';
export type TodayOperationsAlarmHandlingStatus = '未恢复' | '处理中' | '已关闭';
export type TodayOperationsAlarmProcessingStatus = string;
export type TodayOperationsAlarmRecoveryStatus = string;
export type TodayOperationsAlarmExpectation =
  | 'expected'
  | 'unexpected'
  | 'unclassified';
export type TodayOperationsAlarmMetric =
  | 'all'
  | 'expected'
  | 'unexpected'
  | 'unclassified'
  | 'yesterday'
  | 'yesterdayExpected'
  | 'yesterdayUnexpected'
  | 'yesterdayUnclassified'
  | 'pending'
  | 'doubleUnhandled'
  | 'tagAnomaly';

export type TodayOperationsAlarmTagIssueCode =
  | 'missing'
  | 'format'
  | 'pending'
  | 'vague'
  | 'nonOfficial'
  | 'semantic';

export interface TodayOperationsAlarmTagIssue {
  code: TodayOperationsAlarmTagIssueCode;
  side: 'acceptance' | 'confirmation' | 'both';
  label: string;
  reason: string;
  source: 'rule' | 'ai';
  suggestedTag?: string;
}

export interface TodayOperationsAlarmTagReviewStatus {
  state: 'unconfigured' | 'processing' | 'ready' | 'error';
  connection?: 'unconfigured' | 'connecting' | 'online' | 'unverified' | 'error';
  reviewed: number;
  total: number;
}

export interface TodayOperationsAlarmTagBuildingPoint {
  building: string;
  total: number;
  byType: Record<TodayOperationsAlarmTagIssueCode, number>;
}

export interface TodayOperationsAlarmWindow {
  timeZone: 'Asia/Shanghai';
  startDate: string;
  endDateExclusive: string;
  yesterdayDate: string;
}

export interface TodayOperationsAlarmSummary {
  sevenDayTotal: number;
  expectedTotal: number;
  unexpectedTotal: number;
  unclassifiedTotal: number;
  yesterdayTotal: number;
  yesterdayExpectedTotal: number;
  yesterdayUnexpectedTotal: number;
  yesterdayUnclassifiedTotal: number;
  dayBeforeYesterdayTotal: number;
  pendingTotal: number;
  doubleUnhandledTotal: number;
  excludedBuildingTotal: number;
  tagAnomalyTotal: number;
  tagAnomalyByType: Record<TodayOperationsAlarmTagIssueCode, number>;
  tagAnomalyByBuilding: TodayOperationsAlarmTagBuildingPoint[];
}

export interface TodayOperationsAlarmBuildingPoint {
  building: TodayOperationsAlarmChartBuilding;
  expected: number;
  unexpected: number;
  unclassified: number;
  total: number;
}

export interface TodayOperationsAlarmItem {
  humanReview?: import('./today-operations-alarm-review.interface').AlarmHumanReview;
  id: string;
  description: string;
  building: string;
  level: TodayOperationsAlarmLevel;
  expectation: TodayOperationsAlarmExpectation;
  occurredAt: string;
  acceptedAt: string;
  handlingDescription: string;
  owner: string;
  confirmationStatus: TodayOperationsAlarmConfirmationStatus;
  handlingStatus: TodayOperationsAlarmHandlingStatus;
  processingStatus: TodayOperationsAlarmProcessingStatus;
  recoveryStatus: TodayOperationsAlarmRecoveryStatus;
  createdAt: string;
  location: string;
  alarmCategory: string;
  monitorObject: string;
  acceptanceDescription: string;
  confirmationDescription: string;
  tagIssues: TodayOperationsAlarmTagIssue[];
}

export interface TodayOperationsAlarmPage {
  items: TodayOperationsAlarmItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface TodayOperationsAlarmOptions {
  buildings: string[];
  levels: TodayOperationsAlarmLevel[];
  statuses: TodayOperationsAlarmHandlingStatus[];
  processingStatuses: TodayOperationsAlarmProcessingStatus[];
  recoveryStatuses: TodayOperationsAlarmRecoveryStatus[];
}

export interface TodayOperationsAlarmDashboardResponse {
  window: TodayOperationsAlarmWindow;
  summary: TodayOperationsAlarmSummary;
  sevenDayByBuilding: TodayOperationsAlarmBuildingPoint[];
  yesterdayByBuilding: TodayOperationsAlarmBuildingPoint[];
  options: TodayOperationsAlarmOptions;
  page: TodayOperationsAlarmPage;
  sourceUpdatedAt: string | null;
  syncedAt: string;
  sourceStatus: 'fresh' | 'stale';
  dataStatus: 'ready' | 'empty';
  warnings: string[];
  tagReview: TodayOperationsAlarmTagReviewStatus;
}

export interface TodayOperationsAlarmDashboardQuery {
  date?: string;
  page?: string;
  pageSize?: string;
  metric?: string;
  building?: string;
  level?: string;
  status?: string;
  processingStatus?: string;
  recoveryStatus?: string;
  q?: string;
  tagIssueCode?: string;
  refresh?: string;
}
