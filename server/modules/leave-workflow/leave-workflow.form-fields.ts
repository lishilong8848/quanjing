import { createHash } from 'node:crypto';

export const LEAVE_BACKFILL_V2_FIELD_PREFIX = 'leave_bf2_';

export function leaveBackfillFieldName(
  shiftKey: string,
  primaryPersonRecordId: string,
  originalPostSignature: string,
): string {
  if (!/^[a-f0-9]{64}$/u.test(originalPostSignature)) throw new Error('原岗签名无效');
  const identity = createHash('sha256')
    .update(JSON.stringify([shiftKey, primaryPersonRecordId]))
    .digest('base64url');
  const signature = Buffer.from(originalPostSignature, 'hex').toString('base64url');
  return `${LEAVE_BACKFILL_V2_FIELD_PREFIX}${identity}.${signature}`;
}
