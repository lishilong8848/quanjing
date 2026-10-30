import { BadGatewayException, ConflictException } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import FormData = require('form-data');
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import type { PurchaseComparisonCardEvidence } from './purchase-comparison-card-evidence';
import { PurchaseComparisonCardAssetsStore } from './purchase-comparison-card-assets.store';

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MEDIA_FIELD = '三方比价依据（邮件/报价单）';
const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const API = 'https://open.feishu.cn/open-apis';
type Attachment = { fileToken: string; name: string; type: string; size: number };
export interface PurchaseComparisonMediaSource { appId: string; appToken: string; tableId: string; sourceUrl: string; }

export async function preparePurchaseComparisonCardEvidence(input: {
  source: PurchaseComparisonMediaSource;
  expected: PurchaseWorkflowRecord;
  actual: PurchaseWorkflowRecord;
  rawRecord: BitableRecordItem;
  token: string;
  http: Pick<HttpService, 'axiosRef'>;
  cache: PurchaseComparisonCardAssetsStore;
  previewBudget?: Set<string>;
}): Promise<PurchaseComparisonCardEvidence> {
  const { source, expected, actual, rawRecord, token, http, cache } = input;
  if (expected.procurementForm !== '三方比价' || actual.procurementForm !== '三方比价' ||
    !expected.recordId || actual.recordId !== expected.recordId || actual.requestCode !== expected.requestCode ||
    actual.building !== expected.building || actual.requesterOpenId !== expected.requesterOpenId || actual.status !== expected.status ||
    rawRecord.record_id !== expected.recordId || !expected.requestCode || !expected.requesterOpenId || !expected.building) {
    throw new ConflictException('比价附件与当前采购申请不一致，请核对原采购单');
  }
  const recordUrl = purchaseComparisonRecordUrl(source, expected.recordId);
  const attachments = readAttachments(rawRecord.fields?.[MEDIA_FIELD]);
  const tokenSet = [...attachments.map(item => item.fileToken)].sort();
  const scope = [source.appId, source.appToken, source.tableId, expected.requestCode, expected.building, expected.requesterOpenId, tokenSet];
  const result: PurchaseComparisonCardEvidence = { recordId: expected.recordId, recordUrl, attachments: [] };
  for (const attachment of attachments) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.type) || attachment.size <= 0 || attachment.size > MAX_PREVIEW_BYTES) {
      result.attachments.push({ name: attachment.name, disposition: 'original' });
      continue;
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([...scope, attachment.fileToken, attachment.type, attachment.size])).digest('hex');
    if (input.previewBudget && !input.previewBudget.has(fingerprint) && input.previewBudget.size >= 12) {
      result.attachments.push({ name: attachment.name, disposition: 'original' });
      continue;
    }
    const imageKey = await cache.getOrCreate(fingerprint, async () => {
      try {
        const response = await http.axiosRef.get<ArrayBuffer>(`${API}/drive/v1/medias/${encodeURIComponent(attachment.fileToken)}/download`, {
          headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: 10_000, maxRedirects: 0,
          maxContentLength: MAX_PREVIEW_BYTES, maxBodyLength: MAX_PREVIEW_BYTES,
        });
        const buffer = Buffer.from(response.data);
        const type = imageType(buffer);
        const declared = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
        if (!buffer.length || buffer.length > MAX_PREVIEW_BYTES || buffer.length !== attachment.size || !type || type !== attachment.type ||
          ![type, 'application/octet-stream'].includes(declared)) throw new Error('invalid-image');
        const form = new FormData();
        form.append('image_type', 'message');
        form.append('image', buffer, { filename: attachment.name, contentType: type });
        const uploaded = await http.axiosRef.post(`${API}/im/v1/images`, form, {
          headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }, timeout: 10_000, maxRedirects: 0,
          maxBodyLength: MAX_PREVIEW_BYTES + 64 * 1024, maxContentLength: 64 * 1024,
        });
        const key = uploaded.data?.data?.image_key;
        if (uploaded.data?.code !== 0 || typeof key !== 'string' || !/^img_[A-Za-z0-9_-]{1,300}$/.test(key)) throw new Error('upload');
        return key;
      } catch { throw new BadGatewayException('采购比价图片准备失败，通知任务将重试，请勿重复提交采购申请'); }
    });
    input.previewBudget?.add(fingerprint);
    result.attachments.push({ name: attachment.name, disposition: 'preview', imageKey });
  }
  return result;
}

export function purchaseComparisonRecordUrl(source: PurchaseComparisonMediaSource, recordId: string): string {
  if (!/^cli_[A-Za-z0-9_-]+$/.test(source.appId) || !TOKEN.test(source.appToken) || !/^tbl[A-Za-z0-9_-]+$/.test(source.tableId) || !/^rec[A-Za-z0-9_-]+$/.test(recordId)) {
    throw new BadGatewayException('采购比价附件来源配置无效');
  }
  let origin = 'https://vnet.feishu.cn';
  if (source.sourceUrl) {
    try {
      const configured = new URL(source.sourceUrl);
      if (configured.protocol !== 'https:' || !/^[a-z0-9-]+\.feishu\.cn$/.test(configured.hostname) || configured.hostname === 'open.feishu.cn' || configured.username || configured.password || configured.port) throw new Error();
      origin = configured.origin;
    } catch { throw new BadGatewayException('采购原记录地址配置无效'); }
  }
  const url = new URL(`/base/${source.appToken}`, origin);
  url.searchParams.set('table', source.tableId); url.searchParams.set('record', recordId);
  return url.toString();
}

function readAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || !value.length || value.length > 5) throw new BadGatewayException('当前采购单的比价附件缺失或数量异常，请核对原采购单');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.file_token !== 'string' || !TOKEN.test(item.file_token) || seen.has(item.file_token) ||
      typeof item.name !== 'string' || !item.name.trim() || /[\u0000-\u001f\u007f]/.test(item.name)) throw new BadGatewayException('当前采购单的比价附件信息无效，请核对原采购单');
    seen.add(item.file_token);
    const name = basename(item.name.replace(/\\/g, '/')).trim();
    if (!name || name.length > 255) throw new BadGatewayException('采购比价附件名称无效');
    return { fileToken: item.file_token, name, type: typeof item.type === 'string' ? item.type.toLowerCase().replace('image/jpg', 'image/jpeg') : '',
      size: typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size > 0 ? item.size : 0 };
  });
}
function imageType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
