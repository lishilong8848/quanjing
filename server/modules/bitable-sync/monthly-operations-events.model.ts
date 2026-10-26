import type {
  MonthlyEvent,
  MonthlyEventReviewReport,
} from '../../../shared/monthly-operations-events.interface';
import {
  eventBuilding,
  eventSpecialty,
} from '../../../shared/monthly-operations-event-identity';
import {
  extractDateTimeIso,
  extractDisplayText,
  extractNumberValue,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { shanghaiDay } from './monthly-operations-resources.model';
const text = (field: unknown) => extractDisplayText(field).trim();
function checked(value: unknown) {
  return (
    value === true ||
    extractNumberValue(value) === 1 ||
    ['true', '是', '√'].includes(text(value).toLowerCase())
  );
}

function reportFieldValue(value: unknown, key: 'link' | 'text' | 'token') {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = reportFieldValue(item, key);
      if (result) return result;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function reportMentionPath(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = reportMentionPath(item);
      if (result) return result;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  const mentionType = String(
    (value as Record<string, unknown>).mentionType ?? '',
  ).toLowerCase();
  if (mentionType === 'wiki') return 'wiki';
  if (mentionType === 'docx') return 'docx';
  if (mentionType === 'box') return 'file';
  return '';
}

function reviewReport(
  value: unknown,
  label: MonthlyEventReviewReport['label'],
): MonthlyEventReviewReport | null {
  const raw = text(value);
  const markdown = raw.match(/^\[([^\]]+)]\((https:\/\/[^)\s]+)\)$/);
  const directLink = reportFieldValue(value, 'link');
  const token = reportFieldValue(value, 'token');
  const mentionPath = reportMentionPath(value);
  const tokenLink =
    token && mentionPath && /^[A-Za-z0-9_-]{16,80}$/.test(token)
      ? `https://example.feishu.cn/$%7BmentionPath%7D/PUBLIC_EXAMPLE_SOURCE`
      : '';
  const urlValue =
    directLink ||
    markdown?.[2] ||
    raw.match(/https:\/\/[^\s)]+/)?.[0] ||
    tokenLink;
  if (!urlValue) return null;
  try {
    const url = new URL(urlValue);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'vnet.feishu.cn' ||
      !/^\/(?:wiki|docx|file)\//.test(url.pathname)
    )
      return null;
    return {
      label,
      title:
        reportFieldValue(value, 'text') ||
        markdown?.[1]?.trim() ||
        (label === '首次复盘' ? '首次复盘报告' : '二次复盘报告'),
      url: url.toString(),
    };
  } catch {
    return null;
  }
}
export function eventFinalLevel(value: string) {
  return (
    value
      .toUpperCase()
      .match(/I[123]|E[0-4]?/g)
      ?.at(-1) ?? ''
  );
}
export function mapMonthlyEvents(records: BitableRecordItem[], asOf: string) {
  let excluded = 0,
    invalid = 0;
  const seen = new Set<string>();
  const rows: MonthlyEvent[] = [];
  for (const record of records) {
    const fields = record.fields ?? {},
      id = getRecordId(record);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (checked(fields['不计入事件'])) {
      excluded++;
      continue;
    }
    const occurredAt = extractDateTimeIso(fields['事件发生时间']);
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
      invalid++;
      continue;
    }
    const date = shanghaiDay(Date.parse(occurredAt));
    if (date > asOf) continue;
    const status =
      text(fields['最终状态']) || text(fields['事件状态']) || '状态待补充';
    const repairText = text(fields['检修进度']);
    const closed = status.startsWith('事件闭环')
      ? true
      : ['响应跟进', '应急恢复'].includes(status)
        ? false
        : null;
    const repair =
      status === '事件闭环转检修中' || repairText === '检修中'
        ? 'active'
        : status === '事件闭环转检修完成' || repairText === '检修完成'
          ? 'done'
          : !checked(fields['是否转检修'])
            ? 'none'
            : 'unknown';
    const level = text(fields['事件等级']) || '未标注',
      finalLevel = eventFinalLevel(level);
    const duration = extractNumberValue(fields['持续时间']);
    const title =
      text(fields['告警描述']) || text(fields['事件简述']) || '未填写事件描述';
    const reviewReports = [
      reviewReport(fields['1-回溯报告'], '首次复盘'),
      reviewReport(fields['2-回溯报告'], '二次复盘'),
    ].filter((report): report is MonthlyEventReviewReport => report !== null);
    rows.push({
      id,
      code: text(fields['事件编号']),
      title,
      building: eventBuilding(text(fields['机楼']), title),
      specialty: eventSpecialty(text(fields['专业']), title),
      source:
        text(fields['事件发现来源（统一）']) ||
        text(fields['事件发现来源']) ||
        '未标注',
      level,
      finalLevel,
      keyEvent: ['I1', 'I2'].includes(finalLevel) || finalLevel.startsWith('E'),
      occurredAt,
      date,
      status,
      closed,
      repair,
      durationDays:
        duration !== null && Number.isFinite(duration) && duration >= 0
          ? duration
          : null,
      progress: text(fields['事件目前进展']),
      recoveredAt: extractDateTimeIso(fields['事件恢复时间']),
      endedAt: extractDateTimeIso(fields['事件结束时间']),
      repairedAt: extractDateTimeIso(fields['检修完成时间']),
      needsReview: checked(fields['需回溯']),
      reviewReports,
      cause:
        text(fields['事件发生原因']) || text(fields['故障原因(ai识别可修改）']),
      resolution:
        text(fields['事件解决措施']) ||
        text(fields['处理措施（ai识别可修改）']),
    });
  }
  rows.sort(
    (a, b) =>
      b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
  );
  return { records: rows, excluded, invalid };
}

function eventMergeKey(record: MonthlyEvent) {
  const code = record.code.trim().toUpperCase();
  if (code) return `code:${code}`;
  const title = record.title
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return `event:${record.occurredAt}|${record.building}|${title}`;
}

function enrichEvent(primary: MonthlyEvent, supplement: MonthlyEvent) {
  const reports = new Map(
    [...primary.reviewReports, ...supplement.reviewReports].map((report) => [
      report.url,
      report,
    ]),
  );
  return {
    ...primary,
    needsReview: primary.needsReview || supplement.needsReview,
    reviewReports: [...reports.values()],
    cause: primary.cause || supplement.cause,
    resolution: primary.resolution || supplement.resolution,
    progress: primary.progress || supplement.progress,
  };
}

export function mergeMonthlyEventSources(
  primaryRecords: BitableRecordItem[],
  supplementRecords: BitableRecordItem[],
  asOf: string,
) {
  const primary = mapMonthlyEvents(primaryRecords, asOf);
  const supplement = mapMonthlyEvents(supplementRecords, asOf);
  const records = [...primary.records];
  const indexes = new Map(
    records.map((record, index) => [eventMergeKey(record), index]),
  );
  supplement.records.forEach((record) => {
    const key = eventMergeKey(record);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, records.length);
      records.push(record);
      return;
    }
    records[index] = enrichEvent(records[index], record);
  });
  records.sort(
    (a, b) =>
      b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
  );
  return {
    records,
    excluded: primary.excluded,
    invalid: primary.invalid,
  };
}
