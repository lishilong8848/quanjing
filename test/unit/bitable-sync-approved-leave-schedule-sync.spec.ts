import {
  SYSTEM_APPROVED_LEAVE_STAFF_FIELD,
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
} from '../../server/common/feishu/leave-approval-source';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';

describe('BitableSyncService approved leave schedule sync', () => {
  it('writes the effective actual staff and verifies the forced readback', async () => {
    const service: any = Object.create(BitableSyncService.prototype);
    service.SCHEDULE_APP_TOKEN = 'app_schedule';
    service.SCHEDULE_TABLE_ID = 'table_schedule';
    service.NON_DUTY_APP_TOKEN = 'app_non_duty';
    service.NON_DUTY_TABLE_ID = 'table_non_duty';
    service.getTenantAccessToken = jest.fn().mockResolvedValue('tenant_token');
    service.httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({ data: { code: 0 } }),
      },
    };
    service.fetchFeishuNonDutyRecords = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    service.fetchFeishuScheduleRecords = jest
      .fn()
      .mockResolvedValueOnce([
        actualStaffRecord(
          'schedule_white',
          'Leave Partner',
          'Leave Partner',
          ['Leave'],
          ['Substitute'],
        ),
      ])
      .mockResolvedValueOnce([
        actualStaffRecord(
          'schedule_white',
          'Leave Partner',
          'Substitute Partner',
          ['Leave'],
          ['Substitute'],
        ),
      ]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot(
        [
          {
            shiftKey: '2026-09-04|B|white',
            scheduleRecordIds: ['schedule_white'],
            substituteName: 'Substitute',
          },
        ],
        {
          applicantName: 'Leave',
          startAt: '2026-09-04T09:00:00+08:00',
          endAt: '2026-09-04T18:00:00+08:00',
        },
      ),
    ).resolves.toEqual({ nonDutyRecords: 0, scheduleRecords: 1 });
    expect(service.httpService.axiosRef.post).toHaveBeenCalledWith(
      expect.stringContaining('/records/batch_update'),
      {
        records: [
          {
            record_id: 'schedule_white',
            fields: {
              '值班人员（实际）程序修改': 'Substitute Partner',
            },
          },
        ],
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant_token' },
      }),
    );
    expect(service.fetchFeishuScheduleRecords).toHaveBeenCalledTimes(2);
  });

  it('force refreshes both schedule sources and semantically verifies substitutes', async () => {
    const service: any = Object.create(BitableSyncService.prototype);
    service.fetchFeishuNonDutyRecords = jest
      .fn()
      .mockResolvedValue([
        record('schedule_long_white', ['Alice'], ['Season'], '2026-08-26'),
      ]);
    service.fetchFeishuScheduleRecords = jest
      .fn()
      .mockResolvedValue([
        record('schedule_night', ['Bob'], ['Season'], '2026-08-27'),
      ]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot(
        [
          {
            shiftKey: 'long-white-shift',
            scheduleRecordIds: ['schedule_long_white'],
            substituteName: 'Alice',
          },
          {
            shiftKey: 'night-shift',
            scheduleRecordIds: ['schedule_night'],
            substituteName: 'Bob',
          },
        ],
        {
          applicantName: 'Season',
          startAt: '2026-08-26T09:00:00+08:00',
          endAt: '2026-08-27T18:00:00+08:00',
        },
      ),
    ).resolves.toEqual({ nonDutyRecords: 1, scheduleRecords: 1 });
    expect(service.fetchFeishuNonDutyRecords).toHaveBeenCalledWith(true, true);
    expect(service.fetchFeishuScheduleRecords).toHaveBeenCalledWith(true, true);
  });

  it('fails when an affected schedule does not expose the approved substitute', async () => {
    const service: any = Object.create(BitableSyncService.prototype);
    service.fetchFeishuNonDutyRecords = jest
      .fn()
      .mockResolvedValue([record('schedule_long_white', [])]);
    service.fetchFeishuScheduleRecords = jest.fn().mockResolvedValue([]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot([
        {
          shiftKey: 'long-white-shift',
          scheduleRecordIds: ['schedule_long_white'],
          substituteName: 'Alice',
        },
      ]),
    ).rejects.toThrow(/readback mismatch/i);
  });

  it('fails when affected schedules expose the substitute but not the approved applicant', async () => {
    const service: any = Object.create(BitableSyncService.prototype);
    service.fetchFeishuNonDutyRecords = jest
      .fn()
      .mockResolvedValue([record('schedule_long_white', ['Alice'])]);
    service.fetchFeishuScheduleRecords = jest.fn().mockResolvedValue([]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot(
        [
          {
            shiftKey: 'long-white-shift',
            scheduleRecordIds: ['schedule_long_white'],
            substituteName: 'Alice',
          },
        ],
        {
          applicantName: 'Season',
          startAt: '2026-08-26T09:00:00+08:00',
          endAt: '2026-08-26T18:00:00+08:00',
        },
      ),
    ).rejects.toThrow(/readback mismatch/i);
  });

  it('verifies a legacy single-substitute approval by applicant and leave range', async () => {
    const service: any = Object.create(BitableSyncService.prototype);
    service.fetchFeishuNonDutyRecords = jest
      .fn()
      .mockResolvedValue([
        record('schedule_long_white', ['Alice'], ['Season'], '2026-08-26'),
      ]);
    service.fetchFeishuScheduleRecords = jest.fn().mockResolvedValue([]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot([], {
        applicantName: 'Season',
        startAt: '2026-08-26T09:00:00+08:00',
        endAt: '2026-08-26T18:00:00+08:00',
        substituteName: 'Alice',
      }),
    ).resolves.toEqual({ nonDutyRecords: 1, scheduleRecords: 0 });
  });

  it('force refreshes and verifies the approved applicant without a substitute', async () => {
    const service: any = Object.create(BitableSyncService.prototype);
    service.fetchFeishuNonDutyRecords = jest
      .fn()
      .mockResolvedValue([
        record('schedule_long_white', [], ['Season'], '2026-08-26'),
      ]);
    service.fetchFeishuScheduleRecords = jest.fn().mockResolvedValue([]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot([], {
        applicantName: 'Season',
        startAt: '2026-08-26T09:00:00+08:00',
        endAt: '2026-08-26T18:00:00+08:00',
      }),
    ).resolves.toEqual({ nonDutyRecords: 1, scheduleRecords: 0 });
    expect(service.fetchFeishuNonDutyRecords).toHaveBeenCalledWith(true, true);
    expect(service.fetchFeishuScheduleRecords).toHaveBeenCalledWith(true, true);
  });
});

function record(
  recordId: string,
  substitutes: string[],
  leaveStaff: string[] = [],
  scheduleDate?: string,
) {
  return {
    record_id: recordId,
    fields: {
      [SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]: substitutes,
      [SYSTEM_APPROVED_LEAVE_STAFF_FIELD]: leaveStaff,
      ...(scheduleDate ? { schedule_date: scheduleDate } : {}),
    },
  };
}

function actualStaffRecord(
  recordId: string,
  plannedStaff: string,
  actualStaff: string,
  leaveStaff: string[],
  substitutes: string[],
) {
  return {
    record_id: recordId,
    fields: {
      '人员（文本）': plannedStaff,
      '值班人员（实际）程序修改': actualStaff,
      [SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]: substitutes,
      [SYSTEM_APPROVED_LEAVE_STAFF_FIELD]: leaveStaff,
      schedule_date: '2026-09-04',
    },
  };
}
