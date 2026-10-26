import { ConflictException } from '@nestjs/common';
import type { InventoryOutboundApprovalRequestIdentity } from './inventory-outbound-approval.types';

export function assertSameOutboundApprovalRequest(
  expected: InventoryOutboundApprovalRequestIdentity,
  actual: InventoryOutboundApprovalRequestIdentity,
): void {
  const fields = [
    'recordId',
    'outboundNumber',
    'applicantOpenId',
    'sku',
    'quantity',
    'building',
    'reason',
  ] as const;
  if (
    fields.some((field) => expected[field] !== actual[field]) ||
    !Number.isFinite(Date.parse(expected.appliedAt)) ||
    Date.parse(expected.appliedAt) !== Date.parse(actual.appliedAt)
  ) {
    throw new ConflictException('出库申请与已持久化审批快照不一致');
  }
}

const REJECTION_REASON_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

export function normalizeInventoryOutboundRejectionReason(
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null;
  const withNormalizedLineEndings = value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n');
  if (
    REJECTION_REASON_CONTROL_CHARACTER_PATTERN.test(withNormalizedLineEndings)
  ) {
    return null;
  }
  const reason = withNormalizedLineEndings.trim();
  const length = Array.from(reason).length;
  return length >= 2 && length <= 500 ? reason : null;
}
