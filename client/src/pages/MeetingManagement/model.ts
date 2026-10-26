import type {
  MeetingSummary,
  MeetingSource,
} from '../../../../shared/meeting-management.interface';
export const SOURCE_LABELS: Record<MeetingSource, string> = {
  'nantong-weekly': '南通属地周会',
  training: '培训分享',
  'ali-meeting': '阿里及相关会议',
};
export const SOURCE_ROUTES: Record<MeetingSource, string> = {
  'nantong-weekly': '/meeting-management/nantong-weekly',
  training: '/meeting-management/training',
  'ali-meeting': '/meeting-management/ali-meetings',
};
export function hasMeetingResources(item: MeetingSummary) {
  return Boolean(
    item.documentUrl ||
    item.resources?.some((r) => r.kind !== 'meeting') ||
    item.attachmentNames?.length,
  );
}

export interface MeetingFilters {
  query?: string;
  year?: string;
  scope?: string;
  nature?: string;
  content?: string;
  source?: string;
  month?: string;
}

export function filterMeetings(
  records: MeetingSummary[],
  filters: MeetingFilters,
): MeetingSummary[] {
  const terms = (filters.query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return records.filter(
    (item) =>
      (!filters.year || item.date?.startsWith(filters.year)) &&
      (!filters.month || item.date?.startsWith(filters.month)) &&
      (!filters.source || item.source === filters.source) &&
      (!filters.scope || item.scope === filters.scope) &&
      (!filters.nature || item.nature === filters.nature) &&
      (!filters.content ||
        (filters.content === 'documents'
          ? hasMeetingResources(item)
          : item.hasActions)) &&
      terms.every((term) => item.searchText.includes(term)),
  );
}

export function sortMeetings(records: MeetingSummary[]): MeetingSummary[] {
  return [...records].sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      (b.updatedAt || '').localeCompare(a.updatedAt || '') ||
      a.id.localeCompare(b.id),
  );
}

export function meetingMetrics(records: MeetingSummary[]) {
  return {
    records: records.length,
    weeks: new Set(records.map((item) => item.weekLabel).filter(Boolean)).size,
    documents: records.filter(hasMeetingResources).length,
    withActions: records.filter((item) => item.hasActions).length,
  };
}

export function meetingActivityGroups(records: MeetingSummary[]) {
  return [
    { key: 'activity' as const, label: '会议动态', rows: records },
    {
      key: 'customer' as const,
      label: '客户沟通',
      rows: records.filter((r) => r.scope === '客户'),
    },
    {
      key: 'professional' as const,
      label: '专业研讨',
      rows: records.filter((r) => r.nature === '专业类'),
    },
    {
      key: 'learning' as const,
      label: '学习分享',
      rows: records.filter((r) => r.nature === '培训类'),
    },
  ];
}

export function meetingPage<T>(records: T[], requested: number, pageSize = 20) {
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(requested) || 1));
  return {
    page,
    pages,
    records: records.slice((page - 1) * pageSize, page * pageSize),
  };
}
