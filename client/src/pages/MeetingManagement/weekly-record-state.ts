import type {
  MeetingSnapshot,
  MeetingSummary,
} from '../../../../shared/meeting-management.interface';
import type { WeeklyJob } from '../../../../shared/weekly-workspace.interface';

export function mergeWeeklyRecord(
  snapshot: MeetingSnapshot,
  record: MeetingSummary,
): MeetingSnapshot {
  return {
    ...snapshot,
    records: [
      record,
      ...snapshot.records.filter((item) => item.id !== record.id),
    ],
  };
}
export function weeklyTargetRecords(
  records: MeetingSummary[],
  jobs: WeeklyJob[],
) {
  const merged = new Map(records.map((record) => [record.id, record]));
  for (const job of jobs) {
    if (
      job.record &&
      !merged.has(job.record.id) &&
      ['accepted', 'running'].includes(job.status)
    )
      merged.set(job.record.id, job.record);
    if (
      job.targetRecordId === 'new' &&
      ['accepted', 'running'].includes(job.status)
    )
      merged.set(`pending:${job.id}`, {
        id: `pending:${job.id}`,
        date: job.endDate || null,
        title: '周报创建中',
        weekLabel: null,
        scope: '机房',
        nature: '管理类',
        source: 'nantong-weekly',
        documentUrl: null,
        updatedAt: job.updatedAt,
        hasActions: false,
        sectionTitles: [],
        searchText: '',
      });
  }
  return [...merged.values()].sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id),
  );
}
