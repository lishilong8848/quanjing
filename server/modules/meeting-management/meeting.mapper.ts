import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import type {
  MeetingDetail,
  MeetingSummary,
} from '../../../shared/meeting-management.interface';

const SECTIONS = [
  ['management', '管理线', '管理线', false],
  ['professional', '专业线', '专业线', false],
  ['operations', '运营线', '运营线', false],
  ['current-actions', '本周待办', '本周代办', true],
  ['previous-actions', '上周周会待办', '上周周会待办', true],
  ['carryover', '上周遗留项', '上周遗留项', true],
  ['customer-actions', '阿里会议待办', '阿里会议待办', true],
] as const;

export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') {
    const field = value as Record<string, unknown>;
    if (typeof field.text === 'string') return field.text;
    if (field.value !== undefined) return text(field.value);
    if (typeof field.link === 'string') return field.link;
  }
  return '';
}

export function dateValue(value: unknown, dateOnly: boolean): string | null {
  const raw = typeof value === 'number' ? value : text(value).trim();
  if (raw === '' || raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00+08:00`);
    return Number.isFinite(parsed.getTime())
      ? dateOnly
        ? raw
        : parsed.toISOString()
      : null;
  }
  const parsed = new Date(
    typeof raw === 'string' && /^\d{13}$/.test(raw) ? Number(raw) : raw,
  );
  if (!Number.isFinite(parsed.getTime())) return null;
  if (!dateOnly) return parsed.toISOString();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function documentUrl(value: unknown): string | null {
  const field =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const match = text(field?.link ?? value).match(/https:\/\/[^\s<>\])]+/);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return null;
    if (
      !['feishu.cn', 'larksuite.com'].some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    )
      return null;
    if (!/^\/(docx|docs|wiki)\/[A-Za-z0-9]+\/?$/.test(url.pathname))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function mapWeeklyMeeting(record: BitableRecordItem): MeetingDetail {
  const id = record.record_id || record.id;
  if (!id) throw new Error('周报缺少记录 ID');
  const fields = record.fields || {};
  const title =
    text(fields['第几周']).trim() ||
    text(fields['文本']).trim() ||
    '未命名周报';
  const sections = SECTIONS.flatMap(([key, label, field, isAction]) => {
    const content = text(fields[field]).trim();
    return content ? [{ key, title: label, content, isAction }] : [];
  });
  return {
    id,
    title,
    date: dateValue(fields['日期'], true),
    weekLabel: title.match(/\d{4}年第\d{1,2}周/)?.[0] || null,
    scope: '机房',
    nature: '管理类',
    source: 'nantong-weekly',
    documentUrl: documentUrl(fields['链接']),
    updatedAt: dateValue(
      fields['最后更新'] ?? record.last_modified_time,
      false,
    ),
    hasActions: sections.some((section) => section.isAction),
    sectionTitles: sections.map((section) => section.title),
    sections,
  };
}

export function summarizeMeeting(meeting: MeetingDetail): MeetingSummary {
  const { sections, ...summary } = meeting;
  return {
    ...summary,
    excerpt: sections
      .filter((section) => !section.isAction)
      .map((section) =>
        section.content.replace(/\s+/g, ' ').replace(/^[\d.、\s-]+/, ''),
      )
      .join(' · ')
      .slice(0, 110),
    searchText: [
      meeting.title,
      meeting.date,
      meeting.subtype,
      ...(meeting.presenters || []).map((person) => person.name),
      ...(meeting.owners || []).map((person) => person.name),
      ...(meeting.specialties || []),
      ...sections.map((section) => section.content),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
  };
}
