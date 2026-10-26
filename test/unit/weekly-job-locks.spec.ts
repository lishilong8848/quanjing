import {
  weeklyCreationBlockReason,
  weeklyRecordBlockReason,
  weeklyTargetsOverlap,
} from '../../shared/weekly-job-locks';
import type { WeeklyJob } from '../../shared/weekly-workspace.interface';

const job = {
  id: 'old-create-12345678',
  kind: 'generate',
  targetRecordId: 'new',
  endDate: '2026-10-09',
  status: 'uncertain',
  stage: 'row-create',
} as WeeklyJob;
it('旧条目结果未知不禁用新建入口，同日期提交仍给出明确原因', () => {
  expect(weeklyRecordBlockReason('new', [job])).toBe('');
  expect(weeklyCreationBlockReason('2026-10-14', [job])).toBe('');
  expect(weeklyCreationBlockReason('2026-10-09', [job])).toContain('待核对');
  expect(
    weeklyCreationBlockReason('2026-10-09', [{ ...job, status: 'running' }]),
  ).toContain('处理中');
});
it('实际条目结果未知继续锁写入，并与正常处理中区分', () => {
  const existing = { ...job, targetRecordId: 'recExisting' };
  expect(weeklyRecordBlockReason('recExisting', [existing])).toContain(
    '待核对',
  );
  expect(
    weeklyRecordBlockReason('recExisting', [
      { ...existing, status: 'running' },
    ]),
  ).toContain('处理中');
  expect(weeklyRecordBlockReason('pending:12345678', [])).toContain('处理中');
  expect(weeklyRecordBlockReason('recOther', [existing])).toBe('');
});
it('成功、失败和附件任务不锁日期；缺少日期的旧未知生成仍保守保护', () => {
  expect(
    weeklyCreationBlockReason('2026-10-09', [
      { ...job, status: 'success' },
      { ...job, status: 'error' },
      { ...job, kind: 'attachments' },
    ]),
  ).toBe('');
  expect(
    weeklyCreationBlockReason('2026-10-14', [{ ...job, endDate: undefined }]),
  ).toContain('待核对');
});
it('核对删除前继续锁日期，删除终态才解除', () => {
  expect(
    weeklyCreationBlockReason('2026-10-09', [{ ...job, status: 'deleting' }]),
  ).toContain('删除');
  expect(
    weeklyCreationBlockReason('2026-10-09', [{ ...job, status: 'deleted' }]),
  ).toBe('');
});
it('相同日期新建与真实记录生成互斥，其他日期和独立记录互不干扰', () => {
  expect(
    weeklyTargetsOverlap(job, { ...job, targetRecordId: 'recExisting' }),
  ).toBe(true);
  expect(weeklyTargetsOverlap(job, { ...job, endDate: '2026-10-14' })).toBe(
    false,
  );
  expect(
    weeklyTargetsOverlap(
      { ...job, targetRecordId: 'recA' },
      { ...job, targetRecordId: 'recB' },
    ),
  ).toBe(false);
});
