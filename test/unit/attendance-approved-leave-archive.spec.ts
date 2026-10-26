import { findApprovedLeaveMissingPunchRecordIds } from '../../server/modules/duty-schedule/attendance-automation-feishu.gateway';

const leave = {
  recordId: 'leave-d-1',
  building: 'D栋',
  leaveStaff: ['彭怀响'],
  substituteStaff: [],
  startAt: '2026-09-28 08:00:00',
  endAt: '2026-09-28 18:00:00',
};

function archiveRow(
  recordId: string,
  checks: Array<{ direction: 'OnDuty' | 'OffDuty'; expectedAt: string }>,
  fields: Record<string, unknown> = {},
) {
  return {
    record_id: recordId,
    fields: {
      记录类型: '考勤结果',
      姓名: '彭怀响',
      工作日期: Date.parse('2026-09-28T00:00:00+08:00'),
      时间状态: '未打卡',
      打卡次数: 0,
      原始记录JSON: JSON.stringify({
        attendanceChecks: checks.map((check, index) => ({
          expectation: {
            key: `d-${index}`,
            name: '彭怀响',
            building: 'D楼',
            shiftLabel: '白班',
            status: 'on_duty',
            ...check,
          },
        })),
      }),
      ...fields,
    },
  };
}

describe('approved leave archive reconciliation', () => {
  it('selects only pure missing-punch rows fully covered by approved leave', () => {
    const onDuty = {
      direction: 'OnDuty' as const,
      expectedAt: '2026-09-28 09:00:00',
    };
    const offDuty = {
      direction: 'OffDuty' as const,
      expectedAt: '2026-09-28 18:00:00',
    };
    expect(
      findApprovedLeaveMissingPunchRecordIds(
        [
          archiveRow('remove', [onDuty, offDuty]),
          archiveRow('partial', [
            onDuty,
            { ...offDuty, expectedAt: '2026-09-28 19:00:00' },
          ]),
          archiveRow('punched', [onDuty], {
            实际打卡时间: Date.parse('2026-09-28T09:02:00+08:00'),
          }),
          archiveRow('unreadable-punch-time', [onDuty], {
            实际打卡时间: '待人工核对',
          }),
          archiveRow('unreadable-punch-count', [onDuty], {
            打卡次数: '待人工核对',
          }),
          archiveRow('evidence', [onDuty], {
            补卡举证材料: [{ file_token: 'file-1' }],
          }),
          archiveRow('other-date', [onDuty], {
            工作日期: Date.parse('2026-09-27T00:00:00+08:00'),
          }),
        ] as any,
        ['2026-09-28'],
        [leave] as any,
      ),
    ).toEqual(['remove']);
  });
});
