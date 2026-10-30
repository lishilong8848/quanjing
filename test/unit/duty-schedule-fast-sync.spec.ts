jest.mock(
  '@server/database/schema',
  () => ({
    appRoomScheduleEnhanced: {},
    appSyncConfig: {},
    appSealingInfo: {},
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({})),
    maskSecret: jest.fn((value?: string | null) => (value ? '***' : '')),
    parseFeishuBitableLink: jest.fn(() => ({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
    readEnv: jest.fn(() => ''),
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/database/unavailable-database',
  () => ({ isDatabaseDisabled: jest.fn(() => false) }),
  { virtual: true },
);

jest.mock(
  '@server/common/feishu/bitable-direct-read',
  () => ({
    extractDateTimeIso: jest.fn(() => null),
    extractDateValue: jest.fn((value?: unknown) =>
      typeof value === 'string' ? value : null,
    ),
    extractDisplayText: jest.fn((value?: unknown) =>
      typeof value === 'string' ? value : '',
    ),
    extractDisplayValues: jest.fn((value?: unknown) =>
      typeof value === 'string' ? [value] : Array.isArray(value) ? value : [],
    ),
    extractNumberValue: jest.fn(() => null),
    fetchBitableRecords: jest.fn(),
    getRecordId: jest.fn(
      (record: { record_id?: string; id?: string }) =>
        record.record_id || record.id || '',
    ),
    invalidateBitableRecordCache: jest.fn(),
    normalizeBuildingForFrontend: jest.fn((value: string) => value),
    normalizeBuildingLabel: jest.fn((value: string) => value),
    normalizeShiftForFrontend: jest.fn((value: string) => value),
    normalizeTeamForFrontend: jest.fn((value: string) => value),
    pickField: jest.fn((fields: Record<string, unknown>, names: string[]) =>
      names.map((name) => fields[name]).find((value) => value !== undefined),
    ),
    resolveBitableAppToken: jest.fn(async (_httpService, config) =>
      Promise.resolve(config.appToken),
    ),
    readBitableCacheScopeRevision: jest.fn(async () => null),
    readLatestPersistedBitableRecordSnapshot: jest.fn(async () => null),
  }),
  { virtual: true },
);

jest.mock('@server/common/feishu/leave-approval-source', () => ({
  ...jest.requireActual('@server/common/feishu/leave-approval-source'),
  fetchLeaveApprovalSnapshot: jest.fn(async () => ({ verified: true, requests: [] })),
  readCachedLeaveApprovalSnapshot: jest.fn(async () => ({ verified: true, requests: [] })),
}));

jest.mock(
  '@shared/exception-follow-up-match',
  () => ({
    normalizeExceptionFollowUpComparable: jest.fn((value: string) => value),
  }),
  { virtual: true },
);

import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import { fetchBitableRecords, readBitableCacheScopeRevision } from '../../server/common/feishu/bitable-direct-read';
import { readCachedLeaveApprovalSnapshot } from '../../server/common/feishu/leave-approval-source';
import { isDatabaseDisabled } from '../../server/common/database/unavailable-database';

describe('duty schedule fast sync', () => {
  it('limits even the legacy button endpoint to a real three-month source query without replacing historical database rows', async () => {
    const service = new DutyScheduleService(
      {} as never,
      { axiosRef: {} } as never,
    ) as any;
    const records = [
      {
        record_id: 'h-white',
        fields: {
          fldZSaDbGf: '2026-07-23',
          fldJi5bxBG: '周庆庆 施海伟',
          fld4xMPICY: '周庆庆，施海伟',
          fldZnstUS3: '支佳伟 江亮',
          __systemLeaveApprovalVerified: true,
          __systemApprovedLeaveStaff: ['周庆庆', '施海伟'],
          __systemApprovedSubstituteStaff: ['支佳伟', '江亮'],
          '值班人员（实际）程序修改': '支佳伟',
        },
      },
      {
        record_id: 'h-night',
        fields: {
          fldZSaDbGf: '2026-07-23',
          fldJi5bxBG: '李世龙 张宇航',
          '值班人员（实际）程序修改': '李世龙 张宇航',
        },
      },
    ];
    jest.mocked(fetchBitableRecords).mockImplementationOnce(async (_http, options) => {
      options.onPersisted?.({ sourceStartedAt: 10, fetchedAt: 20, invalidationToken: null });
      return records;
    });
    service.refreshProgramModifiedDutyStaffRecords = jest.fn(async () => {
      throw new Error('manual local sync must not write schedule fields');
    });
    service.replaceLocalScheduleRecords = jest.fn(async () => 2);
    let published: typeof records = [];
    service.localMonthSnapshots = {
      publish: jest.fn(async (_app, _table, _range, rows) => { published = rows; return 20; }),
      readMonth: jest.fn(async (_app, _table, month) => ({ sourceStartedAt: 10, records: published.filter(record => record.fields.fldZSaDbGf.startsWith(month)) })),
    };

    const result = await service.syncDutyScheduleToLocalFast(
      new Date('2026-07-23T10:00:00+08:00'),
    );

    expect(fetchBitableRecords).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ forceRefresh: true, requirePersisted: true,
      filter: { conjunction: 'and', conditions: [
        { field_name: '排班日期', operator: 'isGreater', value: ['ExactDate', String(Date.parse('2026-06-01T00:00:00+08:00') - 86400000)] },
        { field_name: '排班日期', operator: 'isLess', value: ['ExactDate', String(Date.parse('2026-08-31T00:00:00+08:00') + 86400000)] },
      ] } }));
    expect(service.refreshProgramModifiedDutyStaffRecords).not.toHaveBeenCalled();
    expect(service.replaceLocalScheduleRecords).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      total: 2,
      reset: 0,
      ruleUpdated: 0,
      localSynced: 2,
      failed: 0,
      scope: 'three_months',
      range: { startDate: '2026-06-01', endDate: '2026-08-31' },
    });
    expect(result.durationMs).toEqual(expect.any(Number));
  });

  it.each(['legacy-first', 'task-first'])('shares one three-month read and publication across new and legacy endpoints: %s', async order => {
    const service = new DutyScheduleService({} as never, { axiosRef: {} } as never) as any;
    let release!: () => void;
    service.fetchFeishuScheduleRecords = jest.fn((_force, _strict, _approval, _range, persistence) => new Promise(resolve => { release = () => {
      persistence.onPersisted({ sourceStartedAt: 10, fetchedAt: 20, invalidationToken: null }); resolve([]);
    }; }));
    service.replaceLocalScheduleRecords = jest.fn(async () => 0);
    service.localMonthSnapshots = { publish: jest.fn(async () => 20), readMonth: jest.fn(async () => ({ sourceStartedAt: 10, records: [] })) };
    const requestId = 'aadf135f-e7cf-42c1-acfe-459c4d24f819';
    let task: any, first: Promise<unknown>;
    if (order === 'legacy-first') {
      first = service.syncDutyScheduleToLocalFast(); task = service.startDutyLocalSyncTask(requestId);
    } else {
      task = service.startDutyLocalSyncTask(requestId); await Promise.resolve(); first = service.syncDutyScheduleToLocalFast();
    }
    const second = service.syncDutyScheduleToLocalFast();
    await new Promise(resolve => setImmediate(resolve));
    release(); await Promise.all([first!, second]);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.fetchFeishuScheduleRecords).toHaveBeenCalledTimes(1);
    expect(service.fetchFeishuScheduleRecords.mock.calls[0][3]).toMatchObject({ startDate: expect.stringMatching(/^\d{4}-\d{2}-01$/), endDate: expect.any(String), months: expect.arrayContaining([expect.any(String)]) });
    expect(service.localMonthSnapshots.publish).toHaveBeenCalledTimes(1);
    expect(service.getDutyLocalSyncTask(task.taskId)).toMatchObject({ status: 'succeeded', result: { scope: 'three_months' } });
    expect(service.replaceLocalScheduleRecords).not.toHaveBeenCalled();
  });

  it('sends an actual three-month source filter, with strict persistent reads', async () => {
    const service = new DutyScheduleService({} as never, { axiosRef: {} } as never) as any;
    jest.mocked(fetchBitableRecords).mockResolvedValueOnce([]);
    await service.fetchFeishuScheduleRecords(true, true, undefined, { startDate: '2025-12-01', endDate: '2026-02-28' }, { requirePersisted: true });
    expect(fetchBitableRecords).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ forceRefresh: true, strict: true, requirePersisted: true,
      filter: { conjunction: 'and', conditions: [
        { field_name: '排班日期', operator: 'isGreater', value: ['ExactDate', String(Date.parse('2025-12-01T00:00:00+08:00') - 86400000)] },
        { field_name: '排班日期', operator: 'isLess', value: ['ExactDate', String(Date.parse('2026-02-28T00:00:00+08:00') + 86400000)] },
      ] } }));
  });

  it.each(['during-source', 'during-publication'])('refuses success if the scope is invalidated %s', async moment => {
    const service = new DutyScheduleService({} as never, { axiosRef: {} } as never) as any;
    const revision = jest.mocked(readBitableCacheScopeRevision); revision.mockReset();
    revision.mockResolvedValueOnce('before').mockResolvedValueOnce(moment === 'during-source' ? 'after' : 'before').mockResolvedValue('after');
    service.fetchFeishuScheduleRecords = jest.fn(async (_force, _strict, _approval, _range, persistence) => {
      persistence.onPersisted({ sourceStartedAt: 10, fetchedAt: 20, invalidationToken: moment === 'during-source' ? 'after' : 'before' }); return [];
    });
    const publish = jest.fn(async () => 20);
    service.localMonthSnapshots = { publish, readMonth: jest.fn(async () => ({ sourceStartedAt: 10, records: [] })) };
    await expect(service.syncThreeMonthScheduleSnapshots(jest.fn(), new Date('2026-10-20'))).rejects.toThrow('来源已变化');
    expect(publish).toHaveBeenCalledTimes(moment === 'during-source' ? 0 : 1);
    revision.mockReset(); revision.mockResolvedValue(null);
  });

  it('does not publish when a source or required persistent snapshot fails', async () => {
    const service = new DutyScheduleService({} as never, { axiosRef: {} } as never) as any, publish = jest.fn();
    service.localMonthSnapshots = { publish };
    service.fetchFeishuScheduleRecords = jest.fn(async () => { throw Error('synthetic persistent failure'); });
    await expect(service.syncThreeMonthScheduleSnapshots(jest.fn())).rejects.toThrow('synthetic persistent failure');
    expect(publish).not.toHaveBeenCalled();
    service.fetchFeishuScheduleRecords.mockResolvedValue([]);
    await expect(service.syncThreeMonthScheduleSnapshots(jest.fn())).rejects.toThrow('尚未完整保存');
    expect(publish).not.toHaveBeenCalled(); expect(readCachedLeaveApprovalSnapshot).toBeDefined();
  });

  it('reports disk publication failure with DataPass disabled and never touches the database', async () => {
    jest.mocked(isDatabaseDisabled).mockReturnValue(true);
    const transaction = jest.fn(), service = new DutyScheduleService({ transaction } as never, { axiosRef: {} } as never) as any;
    service.fetchFeishuScheduleRecords = jest.fn(async (_force, _strict, _approval, _range, persistence) => {
      persistence.onPersisted({ sourceStartedAt: 10, fetchedAt: 20, invalidationToken: null }); return [];
    });
    service.localMonthSnapshots = { publish: jest.fn(async () => { throw Error('synthetic disk unavailable'); }) };
    try { await expect(service.syncThreeMonthScheduleSnapshots(jest.fn())).rejects.toThrow('synthetic disk unavailable'); expect(transaction).not.toHaveBeenCalled(); }
    finally { jest.mocked(isDatabaseDisabled).mockReturnValue(false); }
  });

  it('updates Feishu records through the batch endpoint', async () => {
    const post = jest.fn(async () => ({ data: { code: 0 } }));
    const service = new DutyScheduleService(
      {} as never,
      { axiosRef: { post } } as never,
    ) as any;

    await service.batchUpdateScheduleTextField(
      [
        { record_id: 'rec1', fields: { '值班人员（实际）程序修改': '张三' } },
        { record_id: 'rec2', fields: { '值班人员（实际）程序修改': '李四' } },
      ],
      'app_token',
      'table_id',
      'tenant_token',
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app_token/tables/table_id/records/batch_update',
      {
        records: [
          { record_id: 'rec1', fields: { '值班人员（实际）程序修改': '张三' } },
          { record_id: 'rec2', fields: { '值班人员（实际）程序修改': '李四' } },
        ],
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant_token' },
      }),
    );
  });

  it('replaces local schedule rows in one transaction with refreshed values', async () => {
    const deleteRows = jest.fn(async () => undefined);
    const insertValues = jest.fn(async () => undefined);
    const insertRows = jest.fn(() => ({ values: insertValues }));
    const transaction = jest.fn(async (callback) =>
      callback({ delete: deleteRows, insert: insertRows }),
    );
    const service = new DutyScheduleService(
      { transaction } as never,
      { axiosRef: {} } as never,
    ) as any;
    service.updateLastSyncTime = jest.fn(async () => undefined);
    const records = [
      {
        record_id: 'rec1',
        fields: {
          fldZSaDbGf: '2026-07-21',
          fldJi5bxBG: '张三 李四',
          '值班人员（实际）程序修改': '旧值',
        },
      },
    ];

    const count = await service.replaceLocalScheduleRecords(
      records,
      new Map([['rec1', '王五']]),
    );

    expect(count).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleteRows).toHaveBeenCalledTimes(1);
    expect(insertRows).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        recordId: 'rec1',
        dutyStaffActual: ['王五'],
      }),
    ]);
  });
});
