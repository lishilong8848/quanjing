export const ALARM_REVIEW_CUSTOM_OUTCOME = '自定义回复';
export const ALARM_REVIEW_REPLY_MAX_LENGTH = 500;
export const ALARM_REVIEW_OUTCOMES = ['人工复核无问题', '已通知现场跟进', '告警已闭环无法处理', ALARM_REVIEW_CUSTOM_OUTCOME] as const;
export type AlarmReviewOutcome = (typeof ALARM_REVIEW_OUTCOMES)[number];
export interface AlarmReviewRequest {
  recordIds: string[];
  outcome: AlarmReviewOutcome;
  customReply?: string;
  responsibleRecordId: string;
  clientMutationId: string;
  expectedVersions?: Record<string, string>;
}
export interface AlarmHumanReview {
  outcome: AlarmReviewOutcome;
  customReply?: string;
  responsibleName: string;
  version: string;
}
export interface AlarmReviewPerson { recordId: string; name: string; position: string; buildings: string[] }
export type AlarmReviewItemState = 'pending' | 'syncing' | 'success' | 'error';
export interface AlarmReviewTask {
  id: string;
  clientMutationId: string;
  outcome: AlarmReviewOutcome;
  customReply?: string;
  responsibleRecordId: string;
  responsibleName: string;
  items: Array<{ recordId: string; state: AlarmReviewItemState; message: string; review?: AlarmHumanReview }>;
  createdAt: string;
  updatedAt: string;
}
