import { createHash } from 'node:crypto';
import type { TodayOperationsFollowUpRecord, TodayOperationsFollowUpUpdate } from './today-operations-anomaly.types';

export interface FollowUpCardRecord {
  record: TodayOperationsFollowUpRecord;
  revision: number;
  pendingCommandId?: string;
}

export interface FollowUpCardBatch {
  id: string;
  appId: string;
  recordIds: string[];
  createdAt: string;
}

export type FollowUpCardView =
  | { kind: 'summary' }
  | { kind: 'list'; page: number }
  | { kind: 'edit'; index: number };

export interface FollowUpCardMessage {
  batchId: string;
  summary: Record<string, unknown>;
  view: FollowUpCardView;
}

export interface FollowUpCardCommand {
  id: string;
  batchId: string;
  sourceMessageId: string;
  recordId: string;
  revision: number;
  expected: TodayOperationsFollowUpRecord;
  update: TodayOperationsFollowUpUpdate;
  actorOpenId: string;
  actorName: string;
  stage: 'pending' | 'written' | 'conflict' | 'completed';
  result?: TodayOperationsFollowUpRecord;
  patchedMessageIds: string[];
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  createdAt: string;
}

export interface FollowUpCardSnapshot {
  batch: FollowUpCardBatch;
  records: FollowUpCardRecord[];
  message?: FollowUpCardMessage;
  // Derived in the same ledger read; the record lock remains until all card copies settle.
  pendingCommands?: Array<Pick<FollowUpCardCommand, 'id' | 'stage' | 'update'>>;
}

export type FollowUpCardAction = {
  batchId: string;
  actorOpenId: string;
  messageId: string;
  eventId: string;
} & (
  | { kind: 'view'; action: 'list' | 'summary'; page: number }
  | { kind: 'view'; action: 'edit'; index: number }
  | { kind: 'submit'; index: number; revision: number; acknowledged: boolean; completed: boolean; treatmentMeasure: string }
);

export function followUpRecordFingerprint(record: TodayOperationsFollowUpRecord): string {
  return createHash('sha256').update(JSON.stringify([
    record.recordId, record.issueKey, record.date, record.source, record.item, record.description,
    record.building, record.acknowledged, record.completed, record.treatmentMeasure, record.handlerName, record.handledAt,
  ])).digest('hex');
}
