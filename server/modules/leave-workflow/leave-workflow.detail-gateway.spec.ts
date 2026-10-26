import type { HttpService } from '@nestjs/axios';
import { LeaveWorkflowDetailGateway } from './leave-workflow.detail-gateway';
import type { LeaveShiftSubstituteAssignment } from './leave-workflow.types';

describe('LeaveWorkflowDetailGateway', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'leave-detail-app';
    process.env.FEISHU_APP_SECRET = 'leave-detail-secret';
    process.env.FEISHU_LEAVE_REQUEST_APP_TOKEN = 'leave-base-token';
    process.env.FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID = 'tbl_leave_shift_detail';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates one pending row per shift and replays by stable detail id', async () => {
    const api = fakeApi();
    const gateway = new LeaveWorkflowDetailGateway(api.httpService);

    await gateway.ensurePendingRows('rec_leave_1', groups());
    await gateway.ensurePendingRows('rec_leave_1', groups());

    expect(api.rows).toHaveLength(2);
    expect(api.createCalls).toHaveLength(2);
    expect(api.createCalls.map((call) => call.clientToken)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      ]),
    );
    expect(new Set(api.createCalls.map((call) => call.clientToken)).size).toBe(
      2,
    );
  });

  it('updates only a stale assignment version and semantically rereads it', async () => {
    const api = fakeApi();
    const gateway = new LeaveWorkflowDetailGateway(api.httpService);
    await gateway.ensurePendingRows('rec_leave_1', groups());
    const assignments = groups().map((group, index) =>
      assignment(group, index === 0 ? 'zhang' : 'li'),
    );

    await gateway.upsertCurrentAssignments('rec_leave_1', 1, assignments);
    expect(api.updateCalls).toHaveLength(2);
    for (const call of api.updateCalls) {
      expect(call.fields).not.toHaveProperty('替班人员');
      expect(call.fields).toHaveProperty('替班人员记录ID');
      expect(call.fields).toHaveProperty('替班用户');
    }
    api.updateCalls.length = 0;
    await gateway.upsertCurrentAssignments('rec_leave_1', 1, assignments);

    expect(api.updateCalls).toHaveLength(0);
    api.rows[1].fields['替班安排版本'] = 0;
    await gateway.upsertCurrentAssignments('rec_leave_1', 1, assignments);
    expect(api.updateCalls).toHaveLength(1);
    await expect(
      gateway.readByLeaveRecordIds(['rec_leave_1']),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leaveRecordId: 'rec_leave_1',
          revision: 1,
          status: 'active',
        }),
      ]),
    );
  });

  it('fails closed when semantic reread returns the wrong schedule set', async () => {
    const api = fakeApi();
    const gateway = new LeaveWorkflowDetailGateway(api.httpService);
    await gateway.ensurePendingRows('rec_leave_1', groups());
    api.tamperReadback = true;

    await expect(
      gateway.upsertCurrentAssignments('rec_leave_1', 1, [
        assignment(groups()[0], 'zhang'),
        assignment(groups()[1], 'li'),
      ]),
    ).rejects.toThrow('排班记录集合');
  });

  it('discovers and caches the uniquely named detail table when config is absent', async () => {
    delete process.env.FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID;
    const api = fakeApi();
    const gateway = new LeaveWorkflowDetailGateway(api.httpService);

    await gateway.ensurePendingRows('rec_leave_1', groups());
    await gateway.ensurePendingRows('rec_leave_1', groups());

    expect(api.tableListCalls).toBe(1);
    expect(api.rows).toHaveLength(2);
  });
});

function groups() {
  return [
    {
      shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
      scheduleDate: '2026-08-26',
      startAt: '2026-08-26T09:00',
      endAt: '2026-08-26T18:00',
      kind: 'white' as const,
      shift: '白班',
      buildings: ['A楼'],
      teams: ['一班'],
      scheduleRecordIds: ['schedule_1', 'schedule_2'],
      leaveHours: 8,
    },
    {
      shiftKey: '2026-08-27T18:00__2026-08-28T09:00',
      scheduleDate: '2026-08-27',
      startAt: '2026-08-27T18:00',
      endAt: '2026-08-28T09:00',
      kind: 'night' as const,
      shift: '夜班',
      buildings: ['B楼'],
      teams: ['二班'],
      scheduleRecordIds: ['schedule_3'],
      leaveHours: 15,
    },
  ];
}

function assignment(
  group: ReturnType<typeof groups>[number],
  person: 'zhang' | 'li',
): LeaveShiftSubstituteAssignment {
  const isZhang = person === 'zhang';
  return {
    shiftKey: group.shiftKey,
    scheduleRecordIds: [...group.scheduleRecordIds],
    scheduleDate: group.scheduleDate,
    startAt: group.startAt,
    endAt: group.endAt,
    shift: group.shift,
    buildings: [...group.buildings],
    teams: [...group.teams],
    substitutePersonRecordId: isZhang ? 'rec_zhang' : 'rec_li',
    substituteName: isZhang ? '示例人员008' : '示例人员013',
    substituteOpenId: isZhang ? 'ou_zhang' : 'ou_li',
    updatedByOpenId: 'ou_supervisor',
    updatedByName: '示例人员001',
    updatedAt: '2026-08-25T10:00:00.000Z',
  };
}

function fakeApi() {
  const rows: Array<{ record_id: string; fields: Record<string, any> }> = [];
  const createCalls: Array<{
    clientToken: string;
    fields: Record<string, any>;
  }> = [];
  const updateCalls: Array<{ recordId: string; fields: Record<string, any> }> =
    [];
  let tamperReadback = false;
  let tableListCalls = 0;
  const post = jest.fn(async (url: string, body: any, config?: any) => {
    if (url.includes('/tenant_access_token/')) {
      return { data: { code: 0, tenant_access_token: 'tenant-token' } };
    }
    if (url.endsWith('/records/search')) {
      const condition = body?.filter?.conditions?.[0];
      const expected = String(condition?.value?.[0] || '');
      const fieldName = String(condition?.field_name || '');
      return {
        data: {
          code: 0,
          data: {
            items: rows.filter(
              (row) => String(row.fields[fieldName] || '') === expected,
            ),
            has_more: false,
          },
        },
      };
    }
    if (url.endsWith('/records')) {
      const record = {
        record_id: `rec_detail_${rows.length + 1}`,
        fields: { ...body.fields },
      };
      rows.push(record);
      createCalls.push({
        clientToken: String(config?.params?.client_token || ''),
        fields: { ...body.fields },
      });
      return { data: { code: 0, data: { record } } };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  const put = jest.fn(async (url: string, body: any) => {
    const recordId = url.split('/').pop() || '';
    const row = rows.find((item) => item.record_id === recordId);
    if (!row) throw new Error('missing row');
    row.fields = { ...row.fields, ...body.fields };
    updateCalls.push({ recordId, fields: { ...body.fields } });
    return { data: { code: 0, data: { record: row } } };
  });
  const get = jest.fn(async (url: string) => {
    if (url.endsWith('/tables')) {
      tableListCalls += 1;
      return {
        data: {
          code: 0,
          data: {
            items: [
              {
                table_id: 'tbl_leave_shift_detail',
                name: '请假替班班次明细',
              },
            ],
            has_more: false,
          },
        },
      };
    }
    const recordId = url.split('/').pop() || '';
    const row = rows.find((item) => item.record_id === recordId);
    if (!row) throw new Error('missing row');
    const fields = { ...row.fields };
    if (tamperReadback) fields['排班记录IDs'] = JSON.stringify(['wrong']);
    return {
      data: { code: 0, data: { record: { ...row, fields } } },
    };
  });
  const api = {
    rows,
    createCalls,
    updateCalls,
    get tableListCalls() {
      return tableListCalls;
    },
    get tamperReadback() {
      return tamperReadback;
    },
    set tamperReadback(value: boolean) {
      tamperReadback = value;
    },
    httpService: { axiosRef: { post, put, get } } as unknown as HttpService,
  };
  return api;
}
