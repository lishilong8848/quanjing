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
type Attachment = { fileToken: string; name: string; type: string; size: number; extra?: string };
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
  const attachments = readAttachments(rawRecord.fields?.[MEDIA_FIELD], source.tableId, expected.recordId);
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
      let response;
      try {
        response = await http.axiosRef.get<ArrayBuffer>(`${API}/drive/v1/medias/${encodeURIComponent(attachment.fileToken)}/download`, {
          headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: 10_000, maxRedirects: 0,
          maxContentLength: MAX_PREVIEW_BYTES, maxBodyLength: MAX_PREVIEW_BYTES,
          ...(attachment.extra ? { params: { extra: attachment.extra } } : {}),
        });
      } catch {
        throw new BadGatewayException('采购比价图片下载失败，通知任务将重试，请勿重复提交采购申请');
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(response.data);
      } catch {
        throw new BadGatewayException('采购比价图片内容校验失败，通知任务将重试，请勿重复提交采购申请');
      }
      const type = imageType(buffer);
      const declared = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
      if (!buffer.length || buffer.length > MAX_PREVIEW_BYTES || buffer.length !== attachment.size || !type || type !== attachment.type ||
        ![type, 'application/octet-stream'].includes(declared)) {
        throw new BadGatewayException('采购比价图片内容校验失败，通知任务将重试，请勿重复提交采购申请');
      }
      try {
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
      } catch { throw new BadGatewayException('采购比价图片上传失败，通知任务将重试，请勿重复提交采购申请'); }
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

function readAttachments(value: unknown, tableId: string, recordId: string): Attachment[] {
  if (!Array.isArray(value) || !value.length || value.length > 5) throw new BadGatewayException('当前采购单的比价附件缺失或数量异常，请核对原采购单');
  const seen = new Set<string>();
  const attachments = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.file_token !== 'string' || !TOKEN.test(item.file_token) || seen.has(item.file_token) ||
      typeof item.name !== 'string' || !item.name.trim() || /[\u0000-\u001f\u007f]/.test(item.name)) throw new BadGatewayException('当前采购单的比价附件信息无效，请核对原采购单');
    seen.add(item.file_token);
    const name = basename(item.name.replace(/\\/g, '/')).trim();
    if (!name || name.length > 255) throw new BadGatewayException('采购比价附件名称无效');
    return { fileToken: item.file_token, name, type: typeof item.type === 'string' ? item.type.toLowerCase().replace('image/jpg', 'image/jpeg') : '',
      size: typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size > 0 ? item.size : 0 };
  });
  return attachments.map((attachment, index) => {
    const item = value[index] as Record<string, unknown>;
    const extra = attachmentDownloadExtra(item.url, tableId, recordId, attachment.fileToken, seen);
    return extra ? { ...attachment, extra } : attachment;
  });
}

export function attachmentDownloadExtra(value: unknown, tableId: string, recordId: string, token: string, allowedTokens: Set<string>): string | undefined {
  if (typeof value !== 'string' || !value.includes('extra=')) return undefined;
  const invalid = () => new BadGatewayException('采购比价附件授权信息无效，请核对原采购单');
  try {
    if (value.length > 8192) throw invalid();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || url.port || url.username || url.password || url.hash ||
      url.pathname !== `/open-apis/drive/v1/medias/${encodeURIComponent(token)}/download` ||
      [...url.searchParams.keys()].some(key => key !== 'extra') || url.searchParams.getAll('extra').length !== 1) throw invalid();
    const extra: unknown = JSON.parse(url.searchParams.get('extra') || '');
    if (!isObject(extra) || Object.keys(extra).join(',') !== 'bitablePerm' || !isObject(extra.bitablePerm)) throw invalid();
    const permission = extra.bitablePerm;
    if (permission.tableId !== tableId || Object.keys(permission).some(key => !['tableId', 'rev', 'attachments'].includes(key)) ||
      (permission.rev !== undefined && (!Number.isSafeInteger(permission.rev) || (permission.rev as number) < 0))) throw invalid();
    if (permission.attachments !== undefined) {
      if (!isObject(permission.attachments)) throw invalid();
      const fields = Object.entries(permission.attachments);
      if (fields.length !== 1 || !/^fld[A-Za-z0-9_-]+$/.test(fields[0][0]) || !isObject(fields[0][1])) throw invalid();
      const records = Object.entries(fields[0][1]);
      if (records.length !== 1 || records[0][0] !== recordId || !Array.isArray(records[0][1]) ||
        !records[0][1].includes(token) || records[0][1].some(item => typeof item !== 'string' || !allowedTokens.has(item))) throw invalid();
    }
    return JSON.stringify(extra);
  } catch {
    throw invalid();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function imageType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
