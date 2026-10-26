import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ALARM_REVIEW_CUSTOM_OUTCOME, ALARM_REVIEW_REPLY_MAX_LENGTH, ALARM_REVIEW_OUTCOMES, type AlarmReviewOutcome, type AlarmReviewRequest } from '../../../shared/today-operations-alarm-review.interface';
import { extractDisplayText } from '../../common/feishu/bitable-direct-read';

export const ALARM_REVIEW_FIELD = '人工复核结果';
export const ALARM_REVIEW_PERSON_FIELD = '复核示例人员019';
export const ALARM_REVIEW_REPLY_FIELD = '复核回复';
export function readAlarmReviewReply(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readAlarmReviewReply).join('');
  if (value && typeof value === 'object') {
    const field = value as { text?: unknown; value?: unknown };
    if (typeof field.text === 'string') return field.text;
    if ('value' in field) return readAlarmReviewReply(field.value);
  }
  return '';
}
export function normalizeAlarmReviewRequest(value: unknown): AlarmReviewRequest {
  const input = value as Partial<AlarmReviewRequest> | null;
  if (!input || !Array.isArray(input.recordIds) || !input.recordIds.length || input.recordIds.length > 50 ||
    input.recordIds.some((id) => typeof id !== 'string' || !/^rec[A-Za-z0-9]+$/.test(id)) ||
    !ALARM_REVIEW_OUTCOMES.includes(input.outcome as AlarmReviewOutcome) ||
    typeof input.responsibleRecordId !== 'string' || !/^rec[A-Za-z0-9]+$/.test(input.responsibleRecordId) ||
    typeof input.clientMutationId !== 'string' || !/^alarm-review-[A-Za-z0-9_-]{8,100}$/.test(input.clientMutationId)) {
    throw new BadRequestException('请选择 1–50 条告警、复核结果和示例人员019，并保留本次提交标识');
  }
  const recordIds = [...new Set(input.recordIds)].sort();
  const customReply = typeof input.customReply === 'string' ? input.customReply.trim() : '';
  if (input.outcome === ALARM_REVIEW_CUSTOM_OUTCOME && (!customReply || customReply.length > ALARM_REVIEW_REPLY_MAX_LENGTH)) {
    throw new BadRequestException(`请输入 1–${ALARM_REVIEW_REPLY_MAX_LENGTH} 字的自定义回复`);
  }
  if (input.expectedVersions && (typeof input.expectedVersions !== 'object' || Array.isArray(input.expectedVersions) ||
    recordIds.some((id) => !/^(unreviewed|[a-f0-9]{64})$/.test(input.expectedVersions?.[id] || '')))) {
    throw new BadRequestException('复核清单已变化，请重新打开后提交');
  }
  return { recordIds, outcome: input.outcome!, responsibleRecordId: input.responsibleRecordId, clientMutationId: input.clientMutationId,
    ...(input.outcome === ALARM_REVIEW_CUSTOM_OUTCOME ? { customReply } : {}),
    expectedVersions: Object.fromEntries(recordIds.map((id) => [id, input.expectedVersions?.[id] || 'unreviewed'])) };
}
export function reviewVersion(fields: Record<string, unknown>): string {
  const outcome = extractDisplayText(fields[ALARM_REVIEW_FIELD]).trim();
  const name = extractDisplayText(fields[ALARM_REVIEW_PERSON_FIELD]).trim();
  const reply = readAlarmReviewReply(fields[ALARM_REVIEW_REPLY_FIELD]).trim();
  if (!outcome && !name && !reply) return 'unreviewed';
  // 空回复保持已部署的历史版本，避免升级打断正在处理的旧任务。
  return createHash('sha256').update(JSON.stringify(reply ? [outcome, name, reply] : [outcome, name])).digest('hex');
}
export function buildReviewFields(outcome: AlarmReviewOutcome, userId: string, customReply?: string): Record<string, unknown> {
  return { [ALARM_REVIEW_FIELD]: outcome, [ALARM_REVIEW_PERSON_FIELD]: [{ id: userId }],
    [ALARM_REVIEW_REPLY_FIELD]: outcome === ALARM_REVIEW_CUSTOM_OUTCOME ? customReply?.trim() || '' : '' };
}
export function reviewMatches(fields: Record<string, unknown>, outcome: AlarmReviewOutcome, userId: string, customReply?: string): boolean {
  const people = fields[ALARM_REVIEW_PERSON_FIELD];
  return extractDisplayText(fields[ALARM_REVIEW_FIELD]).trim() === outcome && Array.isArray(people) &&
    people.length === 1 && people[0]?.id === userId &&
    readAlarmReviewReply(fields[ALARM_REVIEW_REPLY_FIELD]).trim() === (outcome === ALARM_REVIEW_CUSTOM_OUTCOME ? customReply?.trim() || '' : '');
}
