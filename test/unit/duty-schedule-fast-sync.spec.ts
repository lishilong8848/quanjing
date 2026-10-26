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
  }),
  { virtual: true },
);

jest.mock(
  '@shared/exception-follow-up-match',
  () => ({
    normalizeExceptionFollowUpComparable: jest.fn((value: string) => value),
  }),
  { virtual: true },
);

import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';

describe('duty schedule fast sync', () => {
  it('recalculates current schedule values locally without mutating Feishu', async () => {
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
    service.fetchFeishuScheduleRecords = jest.fn(async () => records);
    service.refreshProgramModifiedDutyStaffRecords = jest.fn(async () => {
      throw new Error('manual local sync must not write schedule fields');
    });
    service.replaceLocalScheduleRecords = jest.fn(async () => 2);

    const result = await service.syncDutyScheduleToLocalFast(
      new Date('2026-07-23T10:00:00+08:00'),
    );

    expect(service.fetchFeishuScheduleRecords).toHaveBeenCalledTimes(1);
    expect(service.fetchFeishuScheduleRecords).toHaveBeenCalledWith(true);
    expect(service.refreshProgramModifiedDutyStaffRecords).not.toHaveBeenCalled();
    expect(service.replaceLocalScheduleRecords).toHaveBeenCalledWith(
      records,
      new Map([
        ['h-white', '支佳伟 江亮'],
        ['h-night', '李世龙 张宇航'],
      ]),
    );
    expect(result).toMatchObject({
      success: true,
      total: 2,
      reset: 0,
      ruleUpdated: 0,
      localSynced: 2,
      failed: 0,
    });
    expect(result.durationMs).toEqual(expect.any(Number));
  });

  it('updates Feishu records through the batch endpoint', async () => {
    const post = jest.fn(async () => ({ data: { code: 0 } }));
    const service = new DutyScheduleService(
      {} as never,
      { axiosRef: { post } } as never,
    ) as any;

    await service.batchUpdateScheduleTextField(
      [
        { record_id: 'rec1', fields: { '值班人员（实际）程序修改': '示例人员008' } },
        { record_id: 'rec2', fields: { '值班人员（实际）程序修改': '示例人员013' } },
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
          { record_id: 'rec1', fields: { '值班人员（实际）程序修改': '示例人员008' } },
          { record_id: 'rec2', fields: { '值班人员（实际）程序修改': '示例人员013' } },
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
          fldJi5bxBG: '示例人员008 示例人员013',
          '值班人员（实际）程序修改': '旧值',
        },
      },
    ];

    const count = await service.replaceLocalScheduleRecords(
      records,
      new Map([['rec1', '示例人员017']]),
    );

    expect(count).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleteRows).toHaveBeenCalledTimes(1);
    expect(insertRows).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        recordId: 'rec1',
        dutyStaffActual: ['示例人员017'],
      }),
    ]);
  });
});
