jest.mock(
  '@server/common/config/external-services.config',
  () =>
    jest.requireActual('../../server/common/config/external-services.config'),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn().mockResolvedValue('app-token'),
  fetchBitableRecords: jest.fn().mockResolvedValue([]),
}));

import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import { InventoryManagementService } from '../../server/modules/inventory-management/inventory-management.service';

const TABLES = {
  inventory: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
  inbound: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_INBOUND_TABLE_ID',
  outbound: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  borrow: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_BORROW_TABLE_ID',
  catalog: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
  prices: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_PRICE_TABLE_ID',
  stocktake: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID',
  managers: 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_MANAGER_TABLE_ID',
} as const;

const ENV_KEYS = [
  'FEISHU_WAREHOUSE_SOURCE_URL',
  'FEISHU_WAREHOUSE_APP_TOKEN',
  'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
  'FEISHU_WAREHOUSE_INBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_BORROW_TABLE_ID',
  'FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
  'FEISHU_WAREHOUSE_PRICE_TABLE_ID',
  'FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID',
  'FEISHU_WAREHOUSE_MANAGER_TABLE_ID',
] as const;

describe('InventoryManagementService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-token');
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    process.env.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
    delete process.env.FEISHU_WAREHOUSE_APP_TOKEN;
    process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = TABLES.inventory;
    process.env.FEISHU_WAREHOUSE_INBOUND_TABLE_ID = TABLES.inbound;
    process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID = TABLES.outbound;
    process.env.FEISHU_WAREHOUSE_BORROW_TABLE_ID = TABLES.borrow;
    process.env.FEISHU_WAREHOUSE_CATALOG_TABLE_ID = TABLES.catalog;
    process.env.FEISHU_WAREHOUSE_PRICE_TABLE_ID = TABLES.prices;
    process.env.FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID = TABLES.stocktake;
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = TABLES.managers;
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reads the eight warehouse tables with the configured cache policy', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);
    const dashboard = await service.getDashboard(true);

    expect(resolveBitableAppToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appToken: 'QmxAbhXNJaA9YKsbfZyclzhGnSd' }),
    );
    expect(fetchBitableRecords).toHaveBeenCalledTimes(8);
    expect(
      (fetchBitableRecords as jest.Mock).mock.calls.map(
        (call) => call[1].tableId,
      ),
    ).toEqual(expect.arrayContaining(Object.values(TABLES)));
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: TABLES.inventory,
        cacheTtlMs: 4 * 60 * 60 * 1000,
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(dashboard.sourceUrl).toContain('QmxAbhXNJaA9YKsbfZyclzhGnSd');
    expect(dashboard.sectionStatus.inventory).toEqual({
      configured: true,
      count: 0,
    });
  });

  it('keeps the dashboard available when one optional source fails', async () => {
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_httpService: unknown, options: { tableId: string }) => {
        if (options.tableId === TABLES.stocktake) {
          return Promise.reject(new Error('token=do-not-log upstream failure'));
        }
        return Promise.resolve([]);
      },
    );

    const service = new InventoryManagementService({ axiosRef: {} } as never);
    const dashboard = await service.getDashboard();

    expect(dashboard.summary.inventoryLines).toBe(0);
    expect(dashboard.sectionStatus.stocktake).toEqual({
      configured: true,
      count: 0,
      message: '盘点记录表读取失败',
    });
    expect(dashboard.sectionStatus.managers).toEqual({
      configured: true,
      count: 0,
    });
  });

  it('reuses the mapped dashboard until a force refresh replaces it', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);

    const first = await service.getDashboard(false);
    const second = await service.getDashboard(false);

    expect(second).toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(8);

    const refreshed = await service.getDashboard(true);
    expect(refreshed).not.toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(16);
  });

  it('clears the mapped dashboard when the cache is invalidated', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);

    const first = await service.getDashboard(false);
    service.invalidateCache();
    const second = await service.getDashboard(false);

    expect(second).not.toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(16);
  });

  it('starts a fresh read after invalidation without letting the older read refill the cache', async () => {
    let releaseOlderRead!: (value: []) => void;
    let releaseFreshRead!: (value: []) => void;
    const olderReadResult = new Promise<[]>((resolve) => {
      releaseOlderRead = resolve;
    });
    const freshReadResult = new Promise<[]>((resolve) => {
      releaseFreshRead = resolve;
    });
    for (let index = 0; index < 8; index += 1) {
      (fetchBitableRecords as jest.Mock).mockImplementationOnce(
        () => olderReadResult,
      );
    }
    for (let index = 0; index < 8; index += 1) {
      (fetchBitableRecords as jest.Mock).mockImplementationOnce(
        () => freshReadResult,
      );
    }
    const service = new InventoryManagementService({ axiosRef: {} } as never);

    const olderRead = service.getDashboard(false);
    await Promise.resolve();
    await Promise.resolve();
    service.invalidateCache();
    const freshRead = service.getDashboard(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchBitableRecords).toHaveBeenCalledTimes(16);

    releaseFreshRead([]);
    const freshDashboard = await freshRead;
    releaseOlderRead([]);
    const olderDashboard = await olderRead;
    const cachedDashboard = await service.getDashboard(false);

    expect(cachedDashboard).toBe(freshDashboard);
    expect(cachedDashboard).not.toBe(olderDashboard);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(16);
  });

  it('keeps the last successful dashboard when a forced section refresh is incomplete', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);
    const first = await service.getDashboard(false);

    (fetchBitableRecords as jest.Mock).mockImplementation(
      async (_httpService, options: { tableId: string }) => {
        if (options.tableId === TABLES.stocktake) {
          throw new Error('temporary Feishu read failure');
        }
        return [];
      },
    );

    await expect(service.getDashboard(true)).resolves.toBe(first);
  });

  it('keeps the last successful dashboard when a forced refresh fails before table reads', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);
    const first = await service.getDashboard(false);
    (resolveBitableAppToken as jest.Mock).mockRejectedValueOnce(
      new Error('temporary token failure'),
    );

    await expect(service.getDashboard(true)).resolves.toBe(first);
  });

  it.each([false, true])(
    'waits for an older in-flight read (force=%s) before starting a new force refresh',
    async (olderReadIsForceRefresh) => {
      let releaseFirstWave!: (value: []) => void;
      const firstWave = new Promise<[]>((resolve) => {
        releaseFirstWave = resolve;
      });
      for (let index = 0; index < 8; index += 1) {
        (fetchBitableRecords as jest.Mock).mockImplementationOnce(
          () => firstWave,
        );
      }
      const service = new InventoryManagementService({ axiosRef: {} } as never);

      const olderRead = service.getDashboard(olderReadIsForceRefresh);
      await Promise.resolve();
      await Promise.resolve();
      const forcedRead = service.getDashboard(true);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(8);

      releaseFirstWave([]);
      const olderDashboard = await olderRead;
      const forcedDashboard = await forcedRead;

      expect(forcedDashboard).not.toBe(olderDashboard);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(16);
      expect(fetchBitableRecords).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ forceRefresh: true }),
      );
    },
  );

  it('reads and filters only the inventory ledger for the paged item endpoint', async () => {
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_httpService: unknown, options: { tableId: string }) => {
        if (options.tableId === TABLES.catalog) {
          return Promise.resolve([
            {
              record_id: 'catalog-low',
              fields: {
                物品类别号: 'SKU-LOW',
                名称: ['低库存滤芯'],
                楼栋: ['A楼'],
              },
            },
          ]);
        }
        return Promise.resolve([
          {
            record_id: 'rec-low',
            fields: {
              物品类别号: 'SKU-LOW',
              名称: ['opt-low'],
              楼栋: 'A楼',
              剩余库存: 1,
              最小库存量: 5,
            },
          },
          {
            record_id: 'rec-ok',
            fields: {
              物品类别号: 'SKU-OK',
              名称: '正常库存滤芯',
              楼栋: 'B楼',
              剩余库存: 10,
              最小库存量: 2,
            },
          },
        ]);
      },
    );

    const service = new InventoryManagementService({ axiosRef: {} } as never);
    const response = await service.getItems({ building: 'A楼', risk: 'low' });

    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: TABLES.inventory }),
    );
    expect(response.total).toBe(1);
    expect(response.items[0]?.sku).toBe('SKU-LOW');
    expect(response.items[0]?.name).toBe('低库存滤芯');
  });

  it('reads only the selected movement source with catalog and inventory context', async () => {
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_httpService: unknown, options: { tableId: string }) => {
        if (options.tableId === TABLES.catalog) {
          return Promise.resolve([
            {
              record_id: 'catalog-1',
              fields: {
                物品类别号: 'SKU-1',
                名称: ['应急电源'],
                计数单位: ['台'],
                楼栋: ['D楼'],
              },
            },
          ]);
        }
        if (options.tableId === TABLES.inventory) {
          return Promise.resolve([
            {
              record_id: 'inventory-1',
              fields: {
                物品类别号: 'SKU-1',
                楼栋: ['D楼'],
                存放位置: ['D-01'],
              },
            },
          ]);
        }
        if (options.tableId === TABLES.borrow) {
          return Promise.resolve([
            {
              record_id: 'borrow-open',
              fields: {
                物品类别号: [{ id: 'catalog-1' }],
                借出楼栋: ['D楼'],
                借调数量: 2,
                物品状态: ['未归还'],
                借调时间: '2026-07-10 10:00:00',
              },
            },
            {
              record_id: 'borrow-done',
              fields: {
                物品类别号: [{ id: 'catalog-1' }],
                借出楼栋: ['D楼'],
                借调数量: 1,
                物品状态: ['已归还'],
                借调时间: '2026-07-09 10:00:00',
              },
            },
          ]);
        }
        throw new Error(`unexpected table ${options.tableId}`);
      },
    );

    const service = new InventoryManagementService({ axiosRef: {} } as never);
    const response = await service.getMovements({
      type: 'borrow',
      page: 1,
      pageSize: 20,
      status: '未归还',
    });

    expect(fetchBitableRecords).toHaveBeenCalledTimes(3);
    expect(
      (fetchBitableRecords as jest.Mock).mock.calls.map(
        (call) => call[1].tableId,
      ),
    ).toEqual(
      expect.arrayContaining([TABLES.inventory, TABLES.catalog, TABLES.borrow]),
    );
    expect(fetchBitableRecords).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: TABLES.inbound }),
    );
    expect(fetchBitableRecords).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: TABLES.outbound }),
    );
    expect(response).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ recordId: 'borrow-open' })],
      summary: expect.objectContaining({ totalQuantity: 2 }),
    });
  });
});
