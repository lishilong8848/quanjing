import type {
  ExceptionFollowUpCreateRequest,
  ExceptionFollowUpItem,
  ExceptionFollowUpUpdateRequest,
  ExceptionFollowUpType,
} from '@shared/api.interface';
import { createHash } from 'node:crypto';

export interface NormalizedExceptionFollowUp {
  type: ExceptionFollowUpType;
  typeLabel: string;
  abnormalLabel: string;
  date: string;
  detail: string;
  detailedContent: string;
  handling: string;
}

export interface ExceptionFollowUpFieldsResult {
  fields: Record<string, unknown>;
  normalized: NormalizedExceptionFollowUp;
}

export interface ExceptionFollowUpUpdateFieldsResult {
  recordId: string;
  fields: Record<string, unknown>;
}

const EXCEPTION_TYPE_LABELS: Record<ExceptionFollowUpType, string> = {
  sealing_change: '封网&变更',
  schedule: '排班异常',
};

function normalizeText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExceptionFollowUpType(value: unknown): ExceptionFollowUpType {
  if (value === 'sealing_change' || value === 'schedule') {
    return value;
  }
  throw new Error('异常项类型不正确');
}

function getTodayShanghaiDateKey(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizeExceptionFollowUpDate(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return getTodayShanghaiDateKey();
  }

  const date = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('异常日期格式不正确');
  }
  return date;
}

export function getShanghaiDateStartMs(date: string): number {
  return new Date(`${date}T00:00:00+08:00`).getTime();
}

export function buildExceptionFollowUpDetailedContent(
  abnormalLabel: string,
  detail: string,
): string {
  const normalizedLabel = normalizeText(abnormalLabel);
  const normalizedDetail = normalizeText(detail);
  return normalizedLabel
    ? `${normalizedLabel}：${normalizedDetail}`
    : normalizedDetail;
}

export function splitExceptionFollowUpDetailedContent(
  detailedContent: string,
): {
  abnormalLabel: string;
  detail: string;
} {
  const normalized = normalizeText(detailedContent);
  const separatorIndex = normalized.indexOf('：');
  if (separatorIndex <= 0) {
    return {
      abnormalLabel: '',
      detail: normalized,
    };
  }

  return {
    abnormalLabel: normalized.slice(0, separatorIndex).trim(),
    detail: normalized.slice(separatorIndex + 1).trim(),
  };
}

export function buildExceptionFollowUpMatchKey(
  date: string,
  detailedContent: string,
): string {
  return `${normalizeExceptionFollowUpDate(date)}|${normalizeText(detailedContent)}`;
}

export function buildExceptionFollowUpIssueKey(
  type: ExceptionFollowUpType,
  date: string,
  detailedContent: string,
): string {
  const digest = createHash('sha256')
    .update(
      [
        normalizeExceptionFollowUpType(type),
        normalizeExceptionFollowUpDate(date),
        normalizeText(detailedContent),
      ].join('|'),
    )
    .digest('hex');
  return `manual:${digest}`;
}

export function buildExceptionFollowUpFields(
  request: ExceptionFollowUpCreateRequest,
): ExceptionFollowUpFieldsResult {
  const type = normalizeExceptionFollowUpType(request?.type);
  const typeLabel = EXCEPTION_TYPE_LABELS[type];
  const abnormalLabel = normalizeText(request?.abnormalLabel);
  const detail = normalizeText(request?.detail);
  const handling = normalizeText(request?.handling);
  const date = normalizeExceptionFollowUpDate(request?.date);

  if (!detail) {
    throw new Error('异常项内容不能为空');
  }
  if (!handling) {
    throw new Error('处理方式不能为空');
  }

  const detailedContent = buildExceptionFollowUpDetailedContent(
    abnormalLabel,
    detail,
  );
  const issueKey = buildExceptionFollowUpIssueKey(type, date, detailedContent);
  const handledAt = Date.now();
  return {
    fields: {
      日期: getShanghaiDateStartMs(date),
      异常项: detailedContent,
      异常说明: detailedContent,
      异常类型: typeLabel,
      来源: '人工登记',
      楼栋: '园区',
      异常唯一键: issueKey,
      最近发现时间: handledAt,
      已知悉: true,
      已处理完成: true,
      处理措施: handling,
      处理时间: handledAt,
      客户端变更ID: `manual-create:${issueKey.slice('manual:'.length)}`,
    },
    normalized: {
      type,
      typeLabel,
      abnormalLabel,
      date,
      detail,
      detailedContent,
      handling,
    },
  };
}

export function buildExceptionFollowUpUpdateFields(
  request: ExceptionFollowUpUpdateRequest,
): ExceptionFollowUpUpdateFieldsResult {
  const recordId = normalizeText(request?.recordId);
  const handling = normalizeText(request?.handling);

  if (!recordId) {
    throw new Error('缺少异常跟进记录 ID');
  }
  if (!handling) {
    throw new Error('处理方式不能为空');
  }

  return {
    recordId,
    fields: {
      已知悉: true,
      已处理完成: true,
      处理措施: handling,
      客户端变更ID: `manual-update:${createHash('sha256')
        .update(`${recordId}|${handling}`)
        .digest('hex')}`,
      处理时间: Date.now(),
    },
  };
}

export function buildExceptionFollowUpItem(options: {
  recordId: string;
  type: ExceptionFollowUpType;
  typeLabel: string;
  abnormalLabel: string;
  date: string;
  detail: string;
  detailedContent: string;
  handling: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}): ExceptionFollowUpItem {
  return {
    recordId: options.recordId,
    type: options.type,
    typeLabel: options.typeLabel,
    abnormalLabel: options.abnormalLabel,
    date: options.date,
    detail: options.detail,
    detailedContent: options.detailedContent,
    handling: options.handling,
    matchKey: buildExceptionFollowUpMatchKey(
      options.date,
      options.detailedContent,
    ),
    createdAt: options.createdAt || null,
    updatedAt: options.updatedAt || null,
  };
}

export function buildExceptionFollowUpNotification(
  item: NormalizedExceptionFollowUp,
  recordUrl?: string | null,
  title = '南通排班异常项处理跟进',
): string {
  const lines = [
    title,
    `异常日期：${item.date}`,
    `异常类型：${item.typeLabel}${item.abnormalLabel ? `（${item.abnormalLabel}）` : ''}`,
    `异常项：${item.detail}`,
    `处理方式：${item.handling}`,
  ];

  if (recordUrl) {
    lines.push(`记录链接：${recordUrl}`);
  }

  return lines.join('\n');
}
