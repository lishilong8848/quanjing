import { BadGatewayException } from '@nestjs/common';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { getRecordId } from '../../common/feishu/bitable-direct-read';
import { attachmentDownloadExtra } from './purchase-comparison-card-media';
import type { PurchaseLifecycleAttachmentSelector } from './purchase-lifecycle-attachment-view';

export interface InternalPurchaseLifecycleAttachment { fileToken: string; extra?: string; size: number; contentType: string }
const invalid = (): never => { throw new BadGatewayException('采购附件来源无法核对'); };
const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/octet-stream']);

/** Only use with an authenticated application read of the exact Bitable record. */
export function resolveLifecycleAttachmentFromRecord(raw: BitableRecordItem, tableId: string, target: PurchaseLifecycleAttachmentSelector): InternalPurchaseLifecycleAttachment {
  if (!raw || getRecordId(raw) !== target.recordId || !/^tbl[A-Za-z0-9_-]+$/.test(tableId) ||
    !Number.isSafeInteger(target.index) || target.index < 0 || target.index >= 20 || !raw.fields) return invalid();
  const fields = raw.fields;
  let value: unknown;
  if (target.purpose === 'comparison') value = fields['三方比价依据（邮件/报价单）'];
  else if (target.purpose === 'payment') value = fields['付款截屏（显示付款金额）'];
  else {
    const unified = Object.keys(fields).filter(name => name.trim().startsWith('签收附件'));
    if (unified.length > 1) return invalid();
    if (target.purpose === 'receipt') value = unified.length ? fields[unified[0]] : fields['签收照片'];
    else if (target.purpose === 'invoice') {
      // A combined field does not prove which of its files is an invoice.
      if (unified.length) return invalid();
      value = fields['发票附件（自采必填项，非自采无需填写）'] || fields['发票附件'];
    } else return invalid();
  }
  if (!Array.isArray(value) || !value.length || value.length > 20 || target.index >= value.length) return invalid();
  const tokens = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.file_token !== 'string' || !TOKEN.test(entry.file_token) || tokens.has(entry.file_token)) return invalid();
    tokens.add(entry.file_token);
  }
  const entry = value[target.index] as Record<string, unknown>;
  const fileToken = entry.file_token as string;
  const contentType = typeof entry.type === 'string' ? entry.type.toLowerCase().replace('image/jpg', 'image/jpeg') : '';
  const size = entry.size;
  if (!TYPES.has(contentType) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 * 1024) return invalid();
  const extra = attachmentDownloadExtra(entry.url, tableId, target.recordId, fileToken, tokens);
  return { fileToken, size, contentType, ...(extra ? { extra } : {}) };
}

export function validateLifecycleAttachmentBytes(data: Buffer, expected: InternalPurchaseLifecycleAttachment, declaredType: unknown): void {
  if (!Buffer.isBuffer(data) || data.length !== expected.size || data.length > 20 * 1024 * 1024) return invalid();
  const declared = typeof declaredType === 'string' ? declaredType.split(';')[0].trim().toLowerCase() : '';
  if (declared !== expected.contentType && declared !== 'application/octet-stream') return invalid();
  const matches = expected.contentType === 'image/png' ? data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    expected.contentType === 'image/jpeg' ? data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255 :
    expected.contentType === 'image/webp' ? data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' :
    expected.contentType === 'application/pdf' ? data.length >= 5 && data.toString('ascii', 0, 5) === '%PDF-' : expected.contentType === 'application/octet-stream';
  if (!matches) return invalid();
}
