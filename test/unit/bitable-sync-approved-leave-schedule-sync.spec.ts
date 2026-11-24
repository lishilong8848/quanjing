import {
  SYSTEM_APPROVED_LEAVE_STAFF_FIELD,
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
} from '../../server/common/feishu/leave-approval-source';
import * as approvalSource from '../../server/common/feishu/leave-approval-source';
import * as bitableRead from '../../server/common/feishu/bitable-direct-read';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';

const createService = () => Object.assign(Object.create(BitableSyncService.prototype), {
  readLeaveRosterRevision: jest.fn().mockResolvedValue({ generation: 0, token: null }),
  patchVerifiedLeaveRoster: jest.fn().mockResolvedValue(undefined),
  recoverLeaveRoster: jest.fn().mockResolvedValue(undefined),
});

describe('BitableSyncService approved leave schedule sync', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes the effective actual staff and verifies the forced readback', async () => {
    const service = createService();
    service.SCHEDULE_APP_TOKEN = 'app_schedule';
    service.SCHEDULE_TABLE_ID = 'table_schedule';
    service.NON_DUTY_APP_TOKEN = 'app_non_duty';
    service.NON_DUTY_TABLE_ID = 'table_non_duty';
    jest.spyOn(bitableRead, 'getTenantAccessToken').mockResolvedValue('tenant_token');
    service.httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({ data: { code: 0 } }),
      },
    };
    service.fetchApprovedLeaveScheduleRows = jest
      .fn()
      .mockResolvedValueOnce([[], [
        actualStaffRecord(
          'schedule_white',
          'Leave Partner',
          'Leave Partner',
          ['Leave'],
          ['Substitute'],
        ),
      ]])
      .mockResolvedValueOnce([[], [
        actualStaffRecord(
          'schedule_white',
          'Leave Partner',
          'Substitute Partner',
          ['Leave'],
          ['Substitute'],
        ),
      ]]);

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
    expect(service.fetchApprovedLeaveScheduleRows.mock.calls).toEqual([
      [['schedule_white'], ['schedule_white'], undefined],
      [[], ['schedule_white']],
    ]);
  });

  it('exposes exact requested IDs for both schedule sources and verifies cross-month overnight substitutions', async () => {
    const service = createService();
    service.fetchApprovedLeaveScheduleRows = jest.fn().mockResolvedValue([
      [record('schedule_long_white', ['Alice'], ['Season'], '2026-09-01')],
      [record('schedule_night', ['Bob'], ['Season'], '2026-08-31')],
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
          startAt: '2026-08-31T21:00:00+08:00',
          endAt: '2026-09-01T18:00:00+08:00',
        },
      ),
    ).resolves.toEqual({ nonDutyRecords: 1, scheduleRecords: 1 });
    expect(service.fetchApprovedLeaveScheduleRows.mock.calls).toEqual([
      [['schedule_long_white', 'schedule_night'], ['schedule_long_white', 'schedule_night'], undefined],
    ]);
  });

  it('fails when an affected schedule does not expose the approved substitute', async () => {
    const service = createService();
    service.fetchApprovedLeaveScheduleRows = jest.fn().mockResolvedValue([[record('schedule_long_white', [])], []]);

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
    const service = createService();
    service.fetchApprovedLeaveScheduleRows = jest.fn().mockResolvedValue([[record('schedule_long_white', ['Alice'])], []]);

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

  it.each([
    ['missing', [[], [actualStaffRecord('recPresent', 'Leave', 'Leave', ['Leave'], ['Substitute'])]]],
    ['returned by both tables', [[record('recAmbiguous', ['Substitute'])], [actualStaffRecord('recPresent', 'Leave', 'Leave', ['Leave'], ['Substitute']), record('recAmbiguous', ['Substitute'])]]],
  ])('fails before writing any shift when a requested record is %s', async (_issue, rows) => {
    const post = jest.fn();
    const service = Object.assign(createService(), {
      fetchApprovedLeaveScheduleRows: jest.fn().mockResolvedValue(rows),
      httpService: { axiosRef: { post } },
    }) as BitableSyncService;
    await expect(service.syncApprovedLeaveScheduleSnapshot([
      { shiftKey: 'known_shift', scheduleRecordIds: ['recPresent', 'recAmbiguous'], substituteName: 'Substitute' },
    ])).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it('verifies a legacy single-substitute approval by applicant and leave range', async () => {
    const service = createService();
    service.fetchApprovedLeaveScheduleRows = jest.fn().mockResolvedValue([
      [record('schedule_long_white', ['Alice'], ['Season'], '2026-08-26')], [],
    ]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot([], {
        applicantName: 'Season',
        startAt: '2026-08-26T09:00:00+08:00',
        endAt: '2026-08-26T18:00:00+08:00',
        substituteName: 'Alice',
      }),
    ).resolves.toEqual({ nonDutyRecords: 1, scheduleRecords: 0 });
  });

  it('reads the approved dates for a legacy applicant without record IDs or a substitute', async () => {
    const service = createService();
    service.fetchApprovedLeaveScheduleRows = jest.fn().mockResolvedValue([
      [record('schedule_long_white', [], ['Season'], '2026-08-26')], [],
    ]);

    await expect(
      service.syncApprovedLeaveScheduleSnapshot([], {
        applicantName: 'Season',
        startAt: '2026-08-26T09:00:00+08:00',
        endAt: '2026-08-26T18:00:00+08:00',
      }),
    ).resolves.toEqual({ nonDutyRecords: 1, scheduleRecords: 0 });
    expect(service.fetchApprovedLeaveScheduleRows).toHaveBeenCalledTimes(1);
    expect(service.fetchApprovedLeaveScheduleRows).toHaveBeenCalledWith([], [], expect.objectContaining({ endDate: '2026-08-26' }));
  });

  it('reads and writes exact Feishu records through the HTTP adapter, including an overnight shift', async () => {
    const env = { id: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET };
    process.env.FEISHU_APP_ID = 'cli_leave_sync_unit_fixture';
    process.env.FEISHU_APP_SECRET = 'synthetic-unit-fixture-secret';
    const startAt = '2026-09-01T00:30:00+08:00';
    const endAt = '2026-09-01T12:00:00+08:00';
    const night = rawRow('recNightFixture001', '2026-08-31', '夜班');
    const longWhite = rawRow('recLongWhiteFixture002', '2026-09-01', '长白');
    const unrelated = rawRow('recUnrelatedFixture003', '2026-09-01', '夜班');
    const ids = [night.record_id, longWhite.record_id];
    const snapshot: Awaited<ReturnType<typeof approvalSource.fetchLeaveApprovalSnapshot>> = {
      verified: true,
      requests: [{ recordId: 'recApprovalFixture004', leaveStaff: ['申请人'], substituteStaff: ['替班人'],
        startAt, endAt, building: '', team: '', shift: '', impactedScheduleRecordIds: ids }],
    };
    const projection = jest.spyOn(approvalSource, 'fetchLeaveApprovalSnapshot').mockResolvedValue(snapshot);
    const verifiedProjection = jest.spyOn(approvalSource, 'refreshVerifiedLeaveApprovalSnapshot').mockResolvedValue(snapshot);
    const invalidation = jest.spyOn(bitableRead, 'invalidateBitableRecordCache').mockImplementation(() => undefined);
    const reads: Array<[string, string[]]> = [];
    const writes: string[] = [];
    let authRequests = 0;
    const service = Object.assign(createService(), {
      NON_DUTY_APP_TOKEN: 'appLongWhiteUnit', NON_DUTY_TABLE_ID: 'tblLongWhiteUnit',
      SCHEDULE_APP_TOKEN: 'appScheduleUnit', SCHEDULE_TABLE_ID: 'tblScheduleUnit',
      httpService: { axiosRef: { post: jest.fn(async (url: string, body: { record_ids?: string[]; records?: Array<{ record_id: string; fields: Record<string, unknown> }> }, config?: { headers?: { Authorization?: string } }) => {
        if (url.endsWith('/tenant_access_token/internal')) {
          authRequests += 1;
          return { status: 200, data: { code: 0, tenant_access_token: 'fixture-token' } };
        }
        expect(config?.headers?.Authorization).toBe('Bearer fixture-token');
        const tableId = url.match(/\/tables\/([^/]+)\/records\//)?.[1];
        expect(['tblLongWhiteUnit', 'tblScheduleUnit']).toContain(tableId);
        const table = tableId === 'tblLongWhiteUnit' ? [longWhite] : [night, unrelated];
        if (url.endsWith('/batch_get')) {
          const requested = body.record_ids!;
          reads.push([tableId!, requested]);
          const records = table.filter((row) => requested.includes(row.record_id));
          return { status: 200, data: { code: 0, data: {
            records: JSON.parse(JSON.stringify(records)), absent_record_ids: requested.filter((id) => !records.some((row) => row.record_id === id)), forbidden_record_ids: [],
          } } };
        }
        expect(url).toMatch(/\/batch_update$/);
        for (const update of body.records!) {
          const row = table.find((item) => item.record_id === update.record_id);
          expect(row).toBeDefined();
          writes.push(update.record_id);
          Object.assign(row!.fields, update.fields);
        }
        return { status: 200, data: { code: 0 } };
      }) } },
    }) as BitableSyncService;
    try {
      await expect(service.syncApprovedLeaveScheduleSnapshot(ids.map((id) => ({ shiftKey: id, scheduleRecordIds: [id], substituteName: '替班人' })), {
        applicantName: '申请人', startAt, endAt,
      })).resolves.toEqual({ nonDutyRecords: 1, scheduleRecords: 1 });
      expect(reads).toEqual(expect.arrayContaining([
        ['tblLongWhiteUnit', ids], ['tblScheduleUnit', ids],
        ['tblLongWhiteUnit', [longWhite.record_id]], ['tblScheduleUnit', [night.record_id]],
      ]));
      expect(reads).toHaveLength(4);
      expect(authRequests).toBe(1);
      expect([...writes].sort()).toEqual([...ids].sort());
      expect(unrelated.fields['值班人员（实际）程序修改']).toBe('申请人');
    } finally {
      projection.mockRestore();
      verifiedProjection.mockRestore();
      invalidation.mockRestore();
      if (env.id === undefined) delete process.env.FEISHU_APP_ID;
      else process.env.FEISHU_APP_ID = env.id;
      if (env.secret === undefined) delete process.env.FEISHU_APP_SECRET;
      else process.env.FEISHU_APP_SECRET = env.secret;
    }
  });
});

function rawRow(id: string, date: string, shift: string) {
  return { record_id: id, fields: {
    排班日期: date, 楼栋: 'D楼', 班次: shift, 人员文本: '申请人', 请假人员: '申请人', '值班人员（实际）程序修改': '申请人',
  } };
}

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
