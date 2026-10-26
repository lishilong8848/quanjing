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
  () => ({
    isDatabaseDisabled: jest.fn(() => true),
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/feishu/bitable-direct-read',
  () => ({
    extractDateTimeIso: jest.fn(() => null),
    extractDateValue: jest.fn((value?: unknown) => {
      if (typeof value === 'number') {
        const date = new Date(value);
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      }
      return typeof value === 'string' ? value : null;
    }),
    extractDisplayText: jest.fn((value?: unknown, separator = '、') => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        return value
          .map((item) =>
            typeof item === 'string'
              ? item
              : (item as { text?: string; name?: string })?.text ||
                (item as { text?: string; name?: string })?.name ||
                '',
          )
          .filter(Boolean)
          .join(separator);
      }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.users)) {
          return record.users
            .map((item) => (item as { name?: string })?.name || '')
            .filter(Boolean)
            .join(separator);
        }
      }
      return '';
    }),
    extractDisplayValues: jest.fn((value?: unknown) => {
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) {
        return value
          .map((item) =>
            typeof item === 'string'
              ? item
              : (item as { text?: string; name?: string })?.text ||
                (item as { text?: string; name?: string })?.name ||
                '',
          )
          .filter(Boolean);
      }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.text === 'string') return [record.text];
        if (typeof record.name === 'string') return [record.name];
      }
      return [];
    }),
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
import {
  fetchBitableRecords,
  invalidateBitableRecordCache,
} from '@server/common/feishu/bitable-direct-read';

describe('personnel movement handling', () => {
  function createService() {
    const service = new DutyScheduleService(
      {} as never,
      { axiosRef: {} } as never,
    ) as any;
    service.scheduleAppToken = 'scheduleApp';
    service.scheduleTableId = 'scheduleTable';
    service.personnelMovementConfig = {
      appToken: 'personApp',
      wikiToken: '',
      tableId: 'personTable',
      viewId: 'personView',
      tableName: '在职人员',
      sourceUrl: '',
    };
    service.getFeishuTenantAccessToken = jest.fn(async () => 'tenant-token');
    service.fetchScheduleFieldMetasWithFallback = jest.fn(async () => [
      {
        field_id: 'fldJi5bxBG',
        field_name: '人员（文本）',
        type: 1,
      },
      {
        field_id: 'fldProgram',
        field_name: '值班人员（实际）程序修改',
        type: 1,
      },
    ]);
    service.fetchBitableFieldMetas = jest.fn(async () => [
      { field_id: 'fldResigned', field_name: '离职/异动情况', type: 7 },
    ]);
    service.updateScheduleTextFields = jest.fn(async () => undefined);
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.batchUpdateScheduleTextField = jest.fn(async (updates) => ({
      updatedIds: updates.map((item: { record_id: string }) => item.record_id),
      failures: [],
    }));
    service.replaceLocalScheduleRecords = jest.fn(async () => 0);
    return service;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves travel metadata inferred from record fields when the remote field list is unavailable', async () => {
    const service = createService();
    const fetchWithFallback = (DutyScheduleService.prototype as any)
      .fetchScheduleFieldMetasWithFallback;
    service.fetchScheduleFieldMetasWithFallback =
      fetchWithFallback.bind(service);
    service.fetchScheduleFieldMetas = jest
      .fn()
      .mockRejectedValue(new Error('field metadata timeout'));

    const fields = await service.fetchScheduleFieldMetasWithFallback([
      {
        record_id: 'schedule-record',
        fields: {
          '人员（文本）': '示例人员008 示例人员013',
          '值班人员（实际）程序修改': '示例人员008 示例人员013',
          值班人员程序修改: '旧别名内容',
          差旅人员: '',
        },
      },
    ]);

    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field_id: '差旅人员',
          field_name: '差旅人员',
        }),
      ]),
    );
    expect(
      fields.filter((field: { field_name: string }) =>
        ['值班人员（实际）程序修改', '值班人员程序修改'].includes(
          field.field_name,
        ),
      ),
    ).toHaveLength(1);
    expect(
      fields.filter(
        (field: { field_name: string }) => field.field_name === '人员（文本）',
      ),
    ).toHaveLength(1);
  });

  it('reads the target record directly before applying a staff adjustment', async () => {
    const service = createService();
    const writableField = {
      field_id: 'fldProgram',
      field_name: '值班人员（实际）程序修改',
      type: 1,
    };
    service.fetchScheduleFieldMetasWithFallback = jest.fn(async () => [
      writableField,
    ]);
    service.fetchFeishuScheduleRecords = jest.fn(async () => {
      throw new Error('staff adjustment must not read the full schedule table');
    });
    service.fetchBitableRecordById = jest.fn(async () => ({
      record_id: 'recvneQw4pXQGk',
      fields: {
        [writableField.field_name]: '周庆庆 江亮',
      },
    }));
    service.updateScheduleTextField = jest.fn(async () => undefined);
    service.syncLocalDutyStaffActual = jest.fn(async () => undefined);

    await service.updateDutyStaffAdjustment({
      recordId: 'recvneQw4pXQGk',
      targetName: '江亮',
      replacementName: '施海伟',
    });

    expect(service.fetchBitableRecordById).toHaveBeenCalledWith(
      'scheduleApp',
      'scheduleTable',
      '值班排班',
      'recvneQw4pXQGk',
      'tenant-token',
    );
    expect(service.fetchFeishuScheduleRecords).not.toHaveBeenCalled();
    expect(service.updateScheduleTextField).toHaveBeenCalledWith(
      'recvneQw4pXQGk',
      writableField,
      '周庆庆 施海伟',
      'tenant-token',
    );
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'scheduleApp',
      tableId: 'scheduleTable',
      deletePersisted: true,
    });
  });

  it('marks resigned personnel and removes the name from future program-modified schedule rows', async () => {
    const service = createService();
    service.fetchFeishuScheduleRecords = jest.fn(async () => [
      {
        record_id: 'before-date',
        fields: {
          排班日期: '2026-07-07',
          '值班人员（实际）程序修改': '示例人员008 示例人员013',
        },
      },
      {
        record_id: 'future-program',
        fields: {
          排班日期: '2026-07-08',
          '值班人员（实际）程序修改': '示例人员008 示例人员013',
        },
      },
      {
        record_id: 'future-fallback',
        fields: {
          排班日期: '2026-07-09',
          '值班人员（实际）程序修改': '示例人员013 示例人员008',
        },
      },
      {
        record_id: 'future-other',
        fields: {
          排班日期: '2026-07-10',
          '值班人员（实际）程序修改': '示例人员017 示例人员013',
        },
      },
    ]);
    (fetchBitableRecords as jest.Mock).mockResolvedValueOnce([
      {
        record_id: 'person-rec',
        fields: {
          姓名: '示例人员008',
          员工姓名: [{ name: '示例人员008' }],
        },
      },
    ]);

    const result = await service.createPersonnelMovement({
      staffName: '示例人员008',
      movementType: '离职',
      movementDate: '2026-07-08',
    });

    expect(result).toMatchObject({
      success: true,
      staffName: '示例人员008',
      movementType: '离职',
      movementDate: '2026-07-08',
      personnelUpdated: true,
      total: 2,
      updated: 2,
      failed: 0,
    });
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'personApp',
      'personTable',
      '在职人员',
      'person-rec',
      { '离职/异动情况': true },
      'tenant-token',
    );
    expect(service.updateScheduleTextFields).toHaveBeenCalledTimes(2);
    expect(service.updateScheduleTextFields).toHaveBeenCalledWith(
      'future-program',
      [
        {
          field: {
            field_id: 'fldProgram',
            field_name: '值班人员（实际）程序修改',
            type: 1,
          },
          value: '示例人员013',
        },
      ],
      'tenant-token',
    );
    expect(service.updateScheduleTextFields).toHaveBeenCalledWith(
      'future-fallback',
      [
        {
          field: {
            field_id: 'fldProgram',
            field_name: '值班人员（实际）程序修改',
            type: 1,
          },
          value: '示例人员013',
        },
      ],
      'tenant-token',
    );
  });

  it('does not update the personnel table for non-resignation movements', async () => {
    const service = createService();
    service.fetchFeishuScheduleRecords = jest.fn(async () => [
      {
        record_id: 'future-program',
        fields: {
          排班日期: '2026-07-08',
          '值班人员（实际）程序修改': '示例人员008 示例人员013',
        },
      },
    ]);

    const result = await service.createPersonnelMovement({
      staffName: '示例人员008',
      movementType: '异动',
      movementDate: '2026-07-08',
    });

    expect(result).toMatchObject({
      success: true,
      personnelUpdated: false,
      total: 1,
      updated: 1,
    });
    expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    expect(service.updateScheduleTextFields).toHaveBeenCalledWith(
      'future-program',
      expect.any(Array),
      'tenant-token',
    );
  });

  it('refreshes program-modified duty staff for the requested window with leave substitutes and travel removed', async () => {
    const service = createService();
    service.fetchFeishuScheduleRecords = jest.fn(async () => [
      {
        record_id: 'outside-window',
        fields: {
          fldZSaDbGf: '2026-06-21',
          fldJi5bxBG: '示例人员008 示例人员013',
          '值班人员（实际）程序修改': '旧值',
        },
      },
      {
        record_id: 'target-row',
        fields: {
          fldZSaDbGf: '2026-06-22',
          fldJi5bxBG: '示例人员008 示例人员013',
          fld4xMPICY: '示例人员008',
          fldZnstUS3: '示例人员017',
          __systemLeaveApprovalVerified: true,
          __systemApprovedLeaveStaff: '示例人员008',
          __systemApprovedSubstituteStaff: '示例人员017',
          差旅人员: '示例人员013',
          '值班人员（实际）程序修改': '示例人员008 示例人员013',
        },
      },
    ]);

    const result = await service.refreshProgramModifiedDutyStaffFromRules({
      source: 'manual-sync',
      startDate: '2026-06-22',
      endDate: '2026-07-22',
    });

    expect(result).toMatchObject({
      success: true,
      source: 'manual-sync',
      startDate: '2026-06-22',
      endDate: '2026-07-22',
      scanned: 2,
      total: 1,
      updated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(service.batchUpdateScheduleTextField).toHaveBeenNthCalledWith(
      1,
      [{
        record_id: 'target-row',
        fields: { '值班人员（实际）程序修改': '示例人员008 示例人员013' },
      }],
      'scheduleApp',
      'scheduleTable',
      'tenant-token',
    );
    expect(service.batchUpdateScheduleTextField).toHaveBeenNthCalledWith(
      2,
      [{
        record_id: 'target-row',
        fields: { '值班人员（实际）程序修改': '示例人员017' },
      }],
      'scheduleApp',
      'scheduleTable',
      'tenant-token',
    );
  });

  it('removes leave staff from program-modified duty staff when no substitute is provided', async () => {
    const service = createService();
    service.fetchFeishuScheduleRecords = jest.fn(async () => [
      {
        record_id: 'leave-without-substitute',
        fields: {
          fldZSaDbGf: '2026-07-03',
          fldJi5bxBG: '示例人员008 示例人员013',
          fld4xMPICY: '示例人员008',
          __systemLeaveApprovalVerified: true,
          __systemApprovedLeaveStaff: '示例人员008',
          __systemApprovedSubstituteStaff: [],
          '值班人员（实际）程序修改': '示例人员008 示例人员013',
        },
      },
    ]);

    const result = await service.refreshProgramModifiedDutyStaffFromRules({
      source: 'manual-sync',
      startDate: '2026-06-22',
      endDate: '2026-07-22',
    });

    expect(result).toMatchObject({
      success: true,
      total: 1,
      updated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(service.batchUpdateScheduleTextField).toHaveBeenNthCalledWith(
      2,
      [{
        record_id: 'leave-without-substitute',
        fields: { '值班人员（实际）程序修改': '示例人员013' },
      }],
      'scheduleApp',
      'scheduleTable',
      'tenant-token',
    );
  });

  it('resets a manual program value from planned staff before applying rules', async () => {
    const service = createService();
    service.syncLocalDutyStaffActual = jest.fn(async () => undefined);
    service.fetchFeishuScheduleRecords = jest.fn(async () => [
      {
        record_id: 'manually-adjusted',
        fields: {
          fldZSaDbGf: '2026-07-14',
          fldJi5bxBG: '示例人员008',
          '值班人员（实际）程序修改': '江亮',
        },
      },
    ]);

    const result = await service.refreshProgramModifiedDutyStaffFromRules({
      source: 'manual-sync',
      startDate: '2026-07-14',
      endDate: '2026-07-17',
    });

    expect(result).toMatchObject({
      success: true,
      total: 1,
      updated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(service.batchUpdateScheduleTextField).toHaveBeenNthCalledWith(
      1,
      [{
        record_id: 'manually-adjusted',
        fields: { '值班人员（实际）程序修改': '示例人员008' },
      }],
      'scheduleApp',
      'scheduleTable',
      'tenant-token',
    );
  });
});
