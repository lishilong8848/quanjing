import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import * as bitableDirectRead from '../../common/feishu/bitable-direct-read';
import * as externalServicesConfig from '../../common/config/external-services.config';
import {
  InventoryWarehouseApproversNotConfiguredError,
  InventoryWarehouseRoleDirectory,
  readWarehouseRoleRecords,
  type InventoryWarehouseRoleReader,
} from './inventory-warehouse-role-directory';

describe('readWarehouseRoleRecords', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves the H-building approver from the warehouse Base when only the legacy manager table config exists', async () => {
    const environment: Record<string, string> = {
      FEISHU_WAREHOUSE_SOURCE_URL:
        'https://tenant.example/base/app_shared_warehouse',
      FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tbl_manager',
    };
    jest
      .spyOn(externalServicesConfig, 'readEnv')
      .mockImplementation((name) => environment[name] || '');
    const resolveAppToken = jest
      .spyOn(bitableDirectRead, 'resolveBitableAppToken')
      .mockImplementation(
        async (_httpService, options) => options.appToken || '',
      );
    const fetchRecords = jest
      .spyOn(bitableDirectRead, 'fetchBitableRecords')
      .mockResolvedValue([
        record('rec_h', {
          楼栋: 'H楼',
          库房责任人员: [{ id: 'ou_h_responsible', name: 'H楼责任人' }],
          库房管理人: [{ id: 'ou_h_manager', name: 'H楼管理人' }],
        }),
      ]);

    const directory = createDirectory(readWarehouseRoleRecords);

    await expect(directory.resolveApprovers('H楼')).resolves.toEqual([
      { openId: 'ou_h_responsible', name: 'H楼责任人' },
    ]);
    await expect(
      directory.resolveNotificationRecipients('H楼'),
    ).resolves.toEqual([{ openId: 'ou_h_manager', name: 'H楼管理人' }]);
    expect(resolveAppToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app_shared_warehouse',
        wikiToken: '',
      }),
    );
    expect(fetchRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app_shared_warehouse',
        tableId: 'tbl_manager',
      }),
    );
  });

  it('keeps an explicitly configured manager Base ahead of the warehouse Base', async () => {
    const environment: Record<string, string> = {
      FEISHU_WAREHOUSE_SOURCE_URL:
        'https://tenant.example/base/app_shared_warehouse',
      FEISHU_WAREHOUSE_MANAGER_SOURCE_URL:
        'https://tenant.example/base/app_dedicated_manager?table=tbl_manager',
      FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tbl_manager',
    };
    jest
      .spyOn(externalServicesConfig, 'readEnv')
      .mockImplementation((name) => environment[name] || '');
    const resolveAppToken = jest
      .spyOn(bitableDirectRead, 'resolveBitableAppToken')
      .mockImplementation(
        async (_httpService, options) => options.appToken || '',
      );
    jest.spyOn(bitableDirectRead, 'fetchBitableRecords').mockResolvedValue([]);

    await readWarehouseRoleRecords({} as never);

    expect(resolveAppToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app_dedicated_manager',
        wikiToken: '',
      }),
    );
  });

  it('does not project optional building aliases that are absent from the manager table', async () => {
    const environment: Record<string, string> = {
      FEISHU_WAREHOUSE_SOURCE_URL:
        'https://tenant.example/base/app_shared_warehouse',
      FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tbl_manager',
    };
    jest
      .spyOn(externalServicesConfig, 'readEnv')
      .mockImplementation((name) => environment[name] || '');
    jest
      .spyOn(bitableDirectRead, 'resolveBitableAppToken')
      .mockImplementation(
        async (_httpService, options) => options.appToken || '',
      );
    const fetchRecords = jest
      .spyOn(bitableDirectRead, 'fetchBitableRecords')
      .mockImplementation(async (_httpService, options) => {
        if (
          options.fieldNames?.some(
            (fieldName) =>
              !['楼栋', '库房责任人员', '库房管理人'].includes(fieldName),
          )
        ) {
          throw new Error('Feishu Bitable API error: FieldNameNotFound');
        }
        return [
          record('rec_b', {
            楼栋: 'B楼',
            库房责任人员: [
              { id: 'ou_b_responsible', name: 'B楼责任人' },
            ],
            库房管理人: [{ id: 'ou_b_manager', name: 'B楼管理人' }],
          }),
        ];
      });

    const directory = createDirectory(readWarehouseRoleRecords);

    await expect(directory.resolveApprovers('B楼')).resolves.toEqual([
      { openId: 'ou_b_responsible', name: 'B楼责任人' },
    ]);
    expect(fetchRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        strict: true,
        fieldNames: ['楼栋', '库房责任人员', '库房管理人'],
      }),
    );
  });
});

describe('InventoryWarehouseRoleDirectory', () => {
  it('separates approvers from notification-only warehouse managers', async () => {
    const cyclic: Record<string, unknown> = {
      value: { open_id: 'ou_manager_2', name: '库管乙' },
    };
    cyclic.self = cyclic;
    const reader = jest.fn<
      ReturnType<InventoryWarehouseRoleReader>,
      Parameters<InventoryWarehouseRoleReader>
    >(async () => [
      record('rec_a_1', {
        楼栋: ['A楼'],
        库房责任人员: [
          { id: 'ou_manager_1', name: '库管甲' },
          { openId: 'ou_manager_1', text: '重复姓名不得覆盖' },
          cyclic,
          { id: 'user_invalid', name: '无效人员' },
        ],
        库房管理人: [{ id: 'ou_manager_cc', name: '管理员知会人' }],
        类别号管理人员: [{ id: 'ou_category', name: '类别人员不得审批' }],
        主管: [{ id: 'ou_supervisor', name: '主管不得审批' }],
      }),
      record('rec_b_1', {
        楼栋: ['B栋'],
        库房责任人员: [{ id: 'ou_other_building', name: '其他楼责任人' }],
        库房管理人: [{ id: 'ou_other_cc', name: '其他楼管理员' }],
      }),
    ]);
    const directory = createDirectory(reader);

    await expect(directory.resolveApprovers('a栋')).resolves.toEqual([
      { openId: 'ou_manager_1', name: '库管甲' },
      { openId: 'ou_manager_2', name: '库管乙' },
    ]);
    await expect(
      directory.resolveNotificationRecipients('A楼'),
    ).resolves.toEqual([
      { openId: 'ou_manager_cc', name: '管理员知会人' },
    ]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it.each(['', '  ', '楼', '栋'])(
    'rejects an invalid building before reading Base: %j',
    async (building) => {
      const reader = jest.fn(async () => []);
      const directory = createDirectory(reader);

      await expect(directory.resolveApprovers(building)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(reader).not.toHaveBeenCalled();
    },
  );

  it('fails explicitly when the building has no valid 库房责任人员 Open ID', async () => {
    const directory = createDirectory(async () => [
      record('rec_a', {
        楼栋: 'A楼',
        库房责任人员: [{ id: 'invalid_user', name: '无效人员' }],
        库房管理人: [{ id: 'ou_manager', name: '管理人不得回退审批' }],
      }),
    ]);

    await expect(directory.resolveApprovers('A楼')).rejects.toBeInstanceOf(
      InventoryWarehouseApproversNotConfiguredError,
    );
  });

  it('serves a fresh local snapshot without another external read', async () => {
    let now = 1_000;
    const reader = jest.fn(async () => [
      record('rec_a', {
        楼栋: 'A楼',
        库房责任人员: [{ id: 'ou_manager_1', name: '库管甲' }],
      }),
    ]);
    const directory = createDirectory(reader, () => now, 5_000);

    await directory.resolveApprovers('A楼');
    now = 5_999;
    await expect(directory.resolveApprovers('A楼')).resolves.toEqual([
      { openId: 'ou_manager_1', name: '库管甲' },
    ]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('returns a stale snapshot immediately and refreshes it in the background', async () => {
    let now = 1_000;
    let releaseRefresh: ((records: BitableRecordItem[]) => void) | undefined;
    const reader = jest
      .fn<
        ReturnType<InventoryWarehouseRoleReader>,
        Parameters<InventoryWarehouseRoleReader>
      >()
      .mockResolvedValueOnce([
        record('rec_a_old', {
          楼栋: 'A楼',
          库房责任人员: [{ id: 'ou_old', name: '旧库管' }],
        }),
      ])
      .mockImplementationOnce(
        () =>
          new Promise<BitableRecordItem[]>((resolve) => {
            releaseRefresh = resolve;
          }),
      );
    const directory = createDirectory(reader, () => now, 100);
    await directory.resolveApprovers('A楼');
    now = 1_101;

    await expect(directory.resolveApprovers('A楼')).resolves.toEqual([
      { openId: 'ou_old', name: '旧库管' },
    ]);
    expect(reader).toHaveBeenCalledTimes(2);

    releaseRefresh?.([
      record('rec_a_new', {
        楼栋: 'A栋',
        库房责任人员: [{ id: 'ou_new', name: '新库管' }],
      }),
    ]);
    await eventually(() =>
      expect(directory.peekApprovers('A楼')).toEqual([
        { openId: 'ou_new', name: '新库管' },
      ]),
    );
  });

  it('fails closed after the maximum stale window while refreshing in the background', async () => {
    let now = 1_000;
    let releaseRefresh: ((records: BitableRecordItem[]) => void) | undefined;
    const reader = jest
      .fn<
        ReturnType<InventoryWarehouseRoleReader>,
        Parameters<InventoryWarehouseRoleReader>
      >()
      .mockResolvedValueOnce([
        record('rec_a_old', {
          楼栋: 'A楼',
          库房责任人员: [{ id: 'ou_old', name: '旧库管' }],
        }),
      ])
      .mockImplementationOnce(
        () =>
          new Promise<BitableRecordItem[]>((resolve) => {
            releaseRefresh = resolve;
          }),
      );
    const directory = createDirectory(reader, () => now, 100, 1_000);
    await directory.resolveApprovers('A楼');
    now = 2_101;

    await expect(directory.resolveApprovers('A楼')).rejects.toThrow(
      /权限缓存已过期/u,
    );
    expect(directory.peekApprovers('A楼')).toBeNull();
    expect(reader).toHaveBeenCalledTimes(2);

    releaseRefresh?.([
      record('rec_a_new', {
        楼栋: 'A楼',
        库房责任人员: [{ id: 'ou_new', name: '新库管' }],
      }),
    ]);
    await eventually(() =>
      expect(directory.peekApprovers('A楼')).toEqual([
        { openId: 'ou_new', name: '新库管' },
      ]),
    );
  });

  it('retries the background refresh after an expired cache refresh fails', async () => {
    let now = 1_000;
    const reader = jest
      .fn<
        ReturnType<InventoryWarehouseRoleReader>,
        Parameters<InventoryWarehouseRoleReader>
      >()
      .mockResolvedValueOnce([
        record('rec_a_old', {
          楼栋: 'A楼',
          库房责任人员: [{ id: 'ou_old', name: '旧库管' }],
        }),
      ])
      .mockRejectedValueOnce(new Error('temporary Base outage'))
      .mockResolvedValueOnce([
        record('rec_a_new', {
          楼栋: 'A楼',
          库房责任人员: [{ id: 'ou_new', name: '新库管' }],
        }),
      ]);
    const directory = createDirectory(reader, () => now, 100, 1_000);
    await directory.resolveApprovers('A楼');
    now = 2_101;

    await expect(directory.resolveApprovers('A楼')).rejects.toThrow(
      /权限缓存已过期/u,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(directory.resolveApprovers('A楼')).rejects.toThrow(
      /权限缓存已过期/u,
    );
    expect(reader).toHaveBeenCalledTimes(3);
    await eventually(() =>
      expect(directory.peekApprovers('A楼')).toEqual([
        { openId: 'ou_new', name: '新库管' },
      ]),
    );
  });

  it('deduplicates concurrent cold reads and returns defensive copies', async () => {
    const reader = jest.fn(async () => [
      record('rec_h', {
        楼栋: 'H楼',
        库房责任人员: [{ id: 'ou_h_manager', name: 'H楼库管' }],
      }),
    ]);
    const directory = createDirectory(reader);

    const [first, second] = await Promise.all([
      directory.resolveApprovers('H楼'),
      directory.resolveApprovers('H栋'),
    ]);
    first[0].name = '被调用方修改';

    expect(second).toEqual([{ openId: 'ou_h_manager', name: 'H楼库管' }]);
    await expect(directory.resolveApprovers('H楼')).resolves.toEqual([
      { openId: 'ou_h_manager', name: 'H楼库管' },
    ]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('fails closed on the initial read instead of inventing an approver', async () => {
    const directory = createDirectory(async () => {
      throw new ServiceUnavailableException('manager Base unavailable');
    });

    await expect(directory.resolveApprovers('A楼')).rejects.toThrow(
      'manager Base unavailable',
    );
  });
});

function createDirectory(
  reader: InventoryWarehouseRoleReader,
  clock: () => number = () => 1_000,
  cacheTtlMs = 5_000,
  maximumStaleMs = 30 * 60_000,
): InventoryWarehouseRoleDirectory {
  return new InventoryWarehouseRoleDirectory(
    {} as never,
    reader,
    clock,
    cacheTtlMs,
    maximumStaleMs,
  );
}

function record(
  recordId: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: recordId, fields };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}
