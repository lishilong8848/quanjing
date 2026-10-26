import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(
    process.cwd(),
    'server/modules/bitable-sync/bitable-sync.service.ts',
  ),
  'utf8',
);

function methodSource(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('BitableSyncService leave approval integration', () => {
  it.each([
    [
      'fetchFeishuNonDutyRecords',
      'private async fetchFeishuNonDutyRecords',
      'private async fetchFeishuScheduleRecords',
    ],
    [
      'fetchFeishuScheduleRecords',
      'private async fetchFeishuScheduleRecords',
      'private async fetchFeishuFestivalImportantRecords',
    ],
  ])(
    '%s reads schedule records and the approval snapshot concurrently',
    (_name, start, end) => {
      const block = methodSource(start, end);

      expect(block).toContain('strict = false');
      expect(block).toContain('Promise.all([');
      expect(block).toContain('fetchBitableRecords(this.httpService');
      expect(block).toContain('fetchLeaveApprovalSnapshot(this.httpService');
      expect(block).toContain('forceRefresh,');
      expect(block).toContain('strict,');
      expect(block).toContain(
        'enrichScheduleRecordsWithLeaveApproval(records, approvalSnapshot)',
      );
    },
  );

  it('always serves non-duty schedules from the approval-aware Feishu source', () => {
    const block = methodSource(
      'async getNonDutySchedules(',
      'async getDutyStaff()',
    );

    expect(block).toContain('return this.getNonDutySchedulesFromFeishu(params)');
    expect(block).not.toContain('this.db.select()');
    expect(block).not.toContain('nonDutySchedule.leaveStaff');
  });

  it('does not log raw leave staff or hard-coded record diagnostics', () => {
    expect(source).not.toContain('请假人员（请假表）原始值');
    expect(source).not.toContain('[特别关注]');
    expect(source).not.toContain("recordId === 'recvajwp9W91C0'");
  });
});
