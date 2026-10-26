import type { HttpService } from '@nestjs/axios';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecords,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { EquipmentLifecycleService } from './equipment-lifecycle.service';

jest.mock('../../common/feishu/bitable-direct-read', () => {
  const actual = jest.requireActual(
    '../../common/feishu/bitable-direct-read',
  ) as object;
  return {
    ...actual,
    fetchBitableRecords: jest.fn(),
    readLatestPersistedBitableRecords: jest.fn(),
    resolveBitableAppToken: jest.fn(),
  };
});

const mockedFetch = jest.mocked(fetchBitableRecords);
const mockedReadPersisted = jest.mocked(readLatestPersistedBitableRecords);
const mockedResolve = jest.mocked(resolveBitableAppToken);
const httpService = {} as HttpService;

const TABLES = {
  equipment: 'tblccc04f2d27416',
  longTermMaintenance: 'tblfee06d7d6b11e',
  keyParts: 'tbl957cc4cc0f69b',
  maintenanceContracts: 'tblf7eedcba458d7',
} as const;

function recordForTable(tableId: string): BitableRecordItem {
  if (tableId === TABLES.equipment) {
    return {
      record_id: 'eq-1',
      fields: {
        描述: 'A楼-UPS-未到期',
        设备名称: 'UPS',
        专业: '电气',
        状态: '未到期',
        楼栋: 'A楼',
        本次到期日期: '2027-01-01',
      },
    };
  }
  if (tableId === TABLES.longTermMaintenance) {
    return {
      record_id: 'long-1',
      fields: { 楼栋: 'A楼', 状态: '在保' },
    };
  }
  if (tableId === TABLES.keyParts) {
    return {
      record_id: 'part-1',
      fields: { 楼栋: 'A楼', 状态: '三月预警' },
    };
  }
  return {
    record_id: 'contract-1',
    fields: { 楼栋: 'A楼', 合同当前状态: '过保' },
  };
}

describe('EquipmentLifecycleService', () => {
  const relevantEnvNames = [
    'FEISHU_EQUIPMENT_LIFECYCLE_SOURCE_URL',
    'FEISHU_EQUIPMENT_LIFECYCLE_APP_TOKEN',
    'FEISHU_EQUIPMENT_LIFECYCLE_WIKI_TOKEN',
    'FEISHU_EQUIPMENT_LIFECYCLE_EQUIPMENT_TABLE_ID',
    'FEISHU_EQUIPMENT_LIFECYCLE_EQUIPMENT_VIEW_ID',
    'FEISHU_EQUIPMENT_LIFECYCLE_LONG_TERM_MAINTENANCE_TABLE_ID',
    'FEISHU_EQUIPMENT_LIFECYCLE_LONG_TERM_MAINTENANCE_VIEW_ID',
    'FEISHU_EQUIPMENT_LIFECYCLE_KEY_PARTS_TABLE_ID',
    'FEISHU_EQUIPMENT_LIFECYCLE_KEY_PARTS_VIEW_ID',
    'FEISHU_EQUIPMENT_LIFECYCLE_MAINTENANCE_CONTRACTS_TABLE_ID',
    'FEISHU_EQUIPMENT_LIFECYCLE_MAINTENANCE_CONTRACTS_VIEW_ID',
  ] as const;
  const originalEnv = new Map(
    relevantEnvNames.map((name) => [name, process.env[name]]),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of relevantEnvNames) {
      delete process.env[name];
    }
    mockedResolve.mockResolvedValue('WMcQbPn71aXwoGsNv0vcnzz2n6c');
    mockedReadPersisted.mockResolvedValue(null);
    mockedFetch.mockImplementation(async (_http, options) => [
      recordForTable(options.tableId),
    ]);
  });

  afterAll(() => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  test('reads all four configured views with strict projected field lists', async () => {
    const service = new EquipmentLifecycleService(httpService);

    const result = await service.getDashboard(true);

    expect(result.sourceStatus).toBe('fresh');
    expect(mockedResolve).toHaveBeenCalledTimes(4);
    expect(mockedResolve).toHaveBeenCalledWith(httpService, {
      appToken: 'WMcQbPn71aXwoGsNv0vcnzz2n6c',
      wikiToken: '',
      tableName: '长周期维护项',
    });
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        appToken: 'WMcQbPn71aXwoGsNv0vcnzz2n6c',
        tableId: TABLES.equipment,
        viewId: 'vewEnxNvZL',
        fieldNames: [
          '描述',
          '设备名称',
          '专业',
          '状态',
          '本次到期日期',
          '管理员',
          '楼栋',
          '运维服役年限',
          '上次更换日期',
          '预计下次更换日期',
        ],
        forceRefresh: true,
        strict: true,
        validateRecords: expect.any(Function),
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: TABLES.longTermMaintenance,
        viewId: 'vewiWIAXKq',
        fieldNames: [
          '描述',
          '维护名称',
          '专业',
          '楼栋',
          '示例人员019',
          '上次维护日期',
          '本次到期日期',
          '到期倒计时',
          '状态',
          '预计下次维护日期',
        ],
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: TABLES.keyParts,
        viewId: 'vewMtCv73j',
        fieldNames: [
          '描述',
          '关键器件项目',
          '设备类型',
          '专业',
          '楼栋',
          '示例人员019',
          '上次更换时间',
          '下次更换时间',
          '状态',
        ],
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: TABLES.maintenanceContracts,
        viewId: 'vewwBIXJAu',
        fieldNames: [
          '描述',
          '楼栋',
          '园区楼栋',
          '设备名称',
          '设备类型',
          '专业',
          '示例人员019',
          '本轮截止日期',
          '合同当前状态',
        ],
      }),
    );
  });

  test('marks a source failed without manufacturing zero when no snapshot exists', async () => {
    mockedFetch.mockImplementation(async (_http, options) => {
      if (options.tableId === TABLES.equipment) {
        throw new Error(
          'tenant_access_token=secret WMcQbPn71aXwoGsNv0vcnzz2n6c',
        );
      }
      return [recordForTable(options.tableId)];
    });
    const service = new EquipmentLifecycleService(httpService);

    const result = await service.getDashboard(true);

    expect(result.sourceStatus).toBe('partial');
    expect(result.summary.equipmentTotal).toBeNull();
    expect(result.summary.expiringEquipment).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('WMcQbPn71aXwoGsNv0vcnzz2n6c');
  });

  test('forces a live read on cold start so persisted cache cannot be mislabeled fresh', async () => {
    const service = new EquipmentLifecycleService(httpService);

    await service.getDashboard(false);

    expect(mockedFetch).toHaveBeenCalledTimes(4);
    for (const [, options] of mockedFetch.mock.calls) {
      expect(options.forceRefresh).toBe(true);
    }
  });

  test('uses an existing disk snapshot as stale when the cold-start live read fails', async () => {
    mockedFetch.mockImplementation(async (_http, options) => {
      if (options.tableId === TABLES.equipment) {
        throw new Error('live source unavailable');
      }
      return [recordForTable(options.tableId)];
    });
    mockedReadPersisted.mockImplementation(async (options) =>
      options.tableId === TABLES.equipment
        ? [recordForTable(TABLES.equipment)]
        : null,
    );
    const service = new EquipmentLifecycleService(httpService);

    const result = await service.getDashboard(false);

    expect(result.sourceStatus).toBe('partial');
    expect(result.summary.equipmentTotal).toBe(1);
    expect(result.sourceTables[0]).toMatchObject({
      key: 'equipment',
      status: 'stale',
      recordCount: 1,
    });
    expect(mockedReadPersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: TABLES.equipment,
        tableName: '设备生命周期管理表',
        viewId: 'vewEnxNvZL',
        fieldNames: expect.arrayContaining([
          '设备名称',
          '状态',
          '楼栋',
          '本次到期日期',
        ]),
      }),
    );
  });

  test('only labels an in-memory snapshot fresh inside its known freshness window', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const service = new EquipmentLifecycleService(httpService);
      await service.getDashboard(false);
      mockedFetch.mockClear();

      now.mockReturnValue(1_299_999);
      const cached = await service.getDashboard(false);

      expect(cached.sourceStatus).toBe('fresh');
      expect(mockedFetch).not.toHaveBeenCalled();

      now.mockReturnValue(1_300_001);
      mockedFetch.mockRejectedValue(new Error('live refresh failed'));
      const expired = await service.getDashboard(false);

      expect(mockedFetch).toHaveBeenCalledTimes(4);
      expect(expired.sourceStatus).toBe('stale');
      expect(
        expired.sourceTables.every(({ status }) => status === 'stale'),
      ).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  test('serves the per-table last-good snapshot as stale after refresh failure', async () => {
    const service = new EquipmentLifecycleService(httpService);
    await service.getDashboard(true);
    mockedFetch.mockImplementation(async (_http, options) => {
      if (options.tableId === TABLES.keyParts) {
        throw new Error('token=must-not-leak');
      }
      return [recordForTable(options.tableId)];
    });

    const result = await service.getDashboard(true);

    expect(result.sourceStatus).toBe('partial');
    expect(result.summary.keyPartTotal).toBe(1);
    expect(
      result.sourceTables.find(({ key }) => key === 'keyParts'),
    ).toMatchObject({
      status: 'stale',
      recordCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  test('treats an empty source as unusable instead of reporting a valid zero', async () => {
    mockedFetch.mockImplementation(async (_http, options) =>
      options.tableId === TABLES.equipment
        ? []
        : [recordForTable(options.tableId)],
    );
    const service = new EquipmentLifecycleService(httpService);

    const result = await service.getDashboard(true);

    expect(result.summary.equipmentTotal).toBeNull();
    expect(result.sourceTables[0].status).toBe('failed');
  });

  test('rejects a non-empty table when its required schema fields disappeared', async () => {
    mockedFetch.mockImplementation(async (_http, options) => {
      if (options.tableId === TABLES.keyParts) {
        return [
          {
            record_id: 'part-broken',
            fields: { 描述: '字段已被改名' },
          },
        ];
      }
      return [recordForTable(options.tableId)];
    });
    const service = new EquipmentLifecycleService(httpService);

    const result = await service.getDashboard(true);

    expect(result.sourceStatus).toBe('partial');
    expect(result.summary.keyPartTotal).toBeNull();
    expect(result.sourceTables.find(({ key }) => key === 'keyParts')).toEqual({
      key: 'keyParts',
      status: 'failed',
      recordCount: null,
      updatedAt: null,
    });
  });

  test('marks a last-good source stale when a later live response fails schema validation', async () => {
    const service = new EquipmentLifecycleService(httpService);
    await service.getDashboard(true);
    mockedFetch.mockImplementation(async (_http, options) => {
      if (options.tableId === TABLES.maintenanceContracts) {
        return [
          {
            record_id: 'contract-broken',
            fields: { 描述: '合同状态字段已被改名' },
          },
        ];
      }
      return [recordForTable(options.tableId)];
    });

    const result = await service.getDashboard(true);

    expect(result.sourceStatus).toBe('partial');
    expect(result.summary.maintenanceContracts).toBe(1);
    expect(
      result.sourceTables.find(({ key }) => key === 'maintenanceContracts'),
    ).toMatchObject({
      status: 'stale',
      recordCount: 1,
    });
  });

  test('throws a sanitized service-unavailable error when every source fails', async () => {
    mockedFetch.mockRejectedValue(
      new Error('tenant_access_token=secret WMcQbPn71aXwoGsNv0vcnzz2n6c'),
    );
    const service = new EquipmentLifecycleService(httpService);

    const operation = service.getDashboard(true);

    await expect(operation).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(operation).rejects.not.toThrow(/secret|WMcQb/u);
  });
});
