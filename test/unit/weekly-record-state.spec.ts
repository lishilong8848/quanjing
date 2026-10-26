import {
  weeklyTargetRecords,
  mergeWeeklyRecord,
} from '../../client/src/pages/MeetingManagement/weekly-record-state';
import {
  mapWeeklyMeeting,
  summarizeMeeting,
} from '../../server/modules/meeting-management/meeting.mapper';
import type { WeeklyJob } from '../../shared/weekly-workspace.interface';
import type { MeetingSnapshot } from '../../shared/meeting-management.interface';
const record = summarizeMeeting(
  mapWeeklyMeeting({ record_id: 'recNew', fields: { 日期: '2026-10-14' } }),
);
const job = {
  id: 'create-12345678',
  kind: 'generate',
  targetRecordId: 'new',
  status: 'accepted',
  endDate: '2026-10-14',
} as WeeklyJob;
it('受理即插入临时条目，成功使用真实ID且不重复', () => {
  expect(weeklyTargetRecords([], [job])[0].id).toBe('pending:create-12345678');
  const confirmed = {
    ...job,
    targetRecordId: 'recNew',
    status: 'success' as const,
    record,
  };
  expect(weeklyTargetRecords([record], [confirmed])).toHaveLength(1);
  expect(weeklyTargetRecords([], [{ ...job, status: 'error' }])).toEqual([]);
});
it('确认记录立即合并到页面清单，替换旧版本不重复插入', () => {
  const snapshot = {
    records: [{ ...record, title: '旧标题' }],
  } as MeetingSnapshot;
  const next = mergeWeeklyRecord(snapshot, record);
  expect(next.records).toEqual([record]);
  expect(snapshot.records[0].title).toBe('旧标题');
});
it('历史成功任务不能覆盖后续外部更新', () => {
  const newer = { ...record, title: '飞书已更新标题' };
  expect(
    weeklyTargetRecords(
      [newer],
      [{ ...job, targetRecordId: record.id, status: 'success', record }],
    )[0],
  ).toEqual(newer);
  expect(
    weeklyTargetRecords(
      [],
      [{ ...job, targetRecordId: record.id, status: 'success', record }],
    ),
  ).toEqual([]);
});
