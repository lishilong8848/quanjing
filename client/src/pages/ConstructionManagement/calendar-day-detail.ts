export type CalendarDayProjectStatus = 'scheduled' | 'attention';

export interface CalendarDayDetailSourceItem {
  recordId: string;
  workContent: string;
  constructionCode: string | null;
  building: string | null;
  specialty: string | null;
  stageLabel: string;
  stageEvidence: string;
  missing: string[];
  blocked: boolean;
}

export interface CalendarDayDetailRow {
  recordId: string;
  title: string;
  code: string | null;
  location: string;
  stageLabel: string;
  stageEvidence: string;
  status: CalendarDayProjectStatus;
  statusLabel: string;
  missing: string[];
}

export interface CalendarDayDetail {
  dateLabel: string;
  totalCount: number;
  attentionCount: number;
  rows: CalendarDayDetailRow[];
}

export function buildCalendarDayDetail(
  date: Date,
  items: CalendarDayDetailSourceItem[],
): CalendarDayDetail {
  const rows = items.map((item) => {
    const status: CalendarDayProjectStatus = item.blocked
      ? 'attention'
      : 'scheduled';

    return {
      recordId: item.recordId,
      title: item.workContent || '未命名施工项目',
      code: item.constructionCode,
      location: [item.building || '楼栋未填', item.specialty || '专业未填'].join(
        ' · ',
      ),
      stageLabel: item.stageLabel,
      stageEvidence: item.stageEvidence,
      status,
      statusLabel: status === 'attention' ? '需跟进' : '有施工',
      missing: item.missing,
    };
  });

  return {
    dateLabel: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    totalCount: rows.length,
    attentionCount: rows.filter((row) => row.status === 'attention').length,
    rows,
  };
}
