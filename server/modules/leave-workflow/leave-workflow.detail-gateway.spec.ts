import type { HttpService } from '@nestjs/axios';
import { invalidateBitableRecordCache } from '../../common/feishu/bitable-direct-read';
import { LeaveWorkflowDetailGateway } from './leave-workflow.detail-gateway';
import type { LeaveShiftSubstituteAssignment } from './leave-workflow.types';

jest.mock('../../common/feishu/bitable-direct-read', () => ({ invalidateBitableRecordCache: jest.fn() }));

describe('LeaveWorkflowDetailGateway', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.mocked(invalidateBitableRecordCache).mockClear();
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
    expect(api.searches).toEqual([
      expect.objectContaining({ conjunction: 'or', size: 2 }),
      expect.objectContaining({ conjunction: 'or', size: 2 }),
    ]);
    expect(invalidateBitableRecordCache).toHaveBeenCalledTimes(2);
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'leave-base-token', tableId: 'tbl_leave_shift_detail', deletePersisted: true,
    });
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
    const api = fakeApi({ richSearchText: true });
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
    jest.mocked(invalidateBitableRecordCache).mockClear();
    await gateway.upsertCurrentAssignments('rec_leave_1', 1, assignments);

    expect(api.updateCalls).toHaveLength(0);
    expect(invalidateBitableRecordCache).not.toHaveBeenCalled();
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

  it('batches more than 20 shifts and reads every page before deciding what to write', async () => {
    const api = fakeApi({ pageSize: 7 });
    const gateway = new LeaveWorkflowDetailGateway(api.httpService);
    const seed = groups()[0];
    const shifts = Array.from({ length: 21 }, (_, index) => {
      const date = `2026-08-${String(index + 1).padStart(2, '0')}`;
      return { ...seed, scheduleDate: date, startAt: `${date}T09:00`, endAt: `${date}T18:00`,
        shiftKey: `${date}T09:00__${date}T18:00`, scheduleRecordIds: [`rec_schedule_${index}`] };
    });
    await gateway.ensurePendingRows('rec_leave_1', shifts);
    expect(api.searches.map(({ size }) => size)).toEqual([20, 1]);
    api.searches.length = 0;

    await gateway.ensurePendingRows('rec_leave_1', shifts);

    expect(api.searches).toEqual([
      { conjunction: 'or', size: 20, pageToken: '' },
      { conjunction: 'or', size: 20, pageToken: '7' },
      { conjunction: 'or', size: 20, pageToken: '14' },
      { conjunction: 'and', size: 1, pageToken: '' },
    ]);
    expect(api.createCalls).toHaveLength(21);
  });

  it.each(['duplicate', 'wrong binding', 'newer version'] as const)('blocks prefix writes when a later row has %s', async (problem) => {
    const api = fakeApi();
    const gateway = new LeaveWorkflowDetailGateway(api.httpService);
    await gateway.ensurePendingRows('rec_leave_1', groups());
    if (problem === 'duplicate') api.rows.push({ ...api.rows[1], record_id: 'rec_duplicate' });
    if (problem === 'wrong binding') api.rows[1].fields['请假记录ID'] = 'rec_other_leave';
    if (problem === 'newer version') {
      api.rows[1].fields['状态'] = 'active';
      api.rows[1].fields['替班安排版本'] = 2;
    }

    await expect(gateway.upsertCurrentAssignments('rec_leave_1', 1, groups().map((group) => assignment(group, 'zhang'))))
      .rejects.toThrow(/不唯一|不匹配|版本已更新/);
    expect(api.createCalls).toHaveLength(2);
    expect(api.updateCalls).toHaveLength(0);
  });

  it.each([
    { items: [], has_more: false, total: 1 },
    { items: [], has_more: true },
    { items: [], has_more: 'false' },
    { items: [], page_token: 'continuation' },
    { items: [{ record_id: 'rec_other_detail', fields: { 明细唯一ID: 'outside' } }], has_more: false },
  ])('rejects an incomplete or out-of-scope batch receipt before writes (%#)', async (malformedPage) => {
    const api = fakeApi({ malformedPage });
    const gateway = new LeaveWorkflowDetailGateway(api.httpService);
    await expect(gateway.ensurePendingRows('rec_leave_1', groups())).rejects.toThrow(/分页|超出查询/);
    expect(api.createCalls).toHaveLength(0);
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
    substituteName: isZhang ? '张三' : '李四',
    substituteOpenId: isZhang ? 'ou_zhang' : 'ou_li',
    updatedByOpenId: 'ou_supervisor',
    updatedByName: '主管',
    updatedAt: '2026-08-25T10:00:00.000Z',
  };
}

function fakeApi(options: { pageSize?: number; richSearchText?: boolean; malformedPage?: object } = {}) {
  const rows: Array<{ record_id: string; fields: Record<string, any> }> = [];
  const searches: Array<{ conjunction: string; size: number; pageToken: string }> = [];
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
      const { conditions, conjunction } = body.filter;
      const pageToken = String(config?.params?.page_token || '');
      searches.push({ conjunction, size: conditions.length, pageToken });
      const matches = rows.filter((row) => conditions.some(({ field_name, value }: any) => row.fields[field_name] === value[0]));
      const start = Number(pageToken || 0);
      const end = start + (options.pageSize || 200);
      const hasMore = end < matches.length;
      const items = matches.slice(start, end).map((row) => options.richSearchText ? { ...row, fields:
        Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [key,
          typeof value === 'string' && key !== '状态'
            ? key === '楼栋' || key === '班组' ? value.split('、') : [{ type: 'text', text: value.slice(0, 4) }, { type: 'text', text: value.slice(4) }]
            : value,
        ])),
      } : row);
      return {
        data: {
          code: 0,
          data: options.malformedPage || { items, has_more: hasMore, total: matches.length,
            page_token: hasMore ? String(end) : 'terminal-token' },
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
    searches,
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
