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
  getBitableRecordCacheGeneration: jest.fn().mockReturnValue(0),
}));

import {
  fetchBitableRecords,
  getBitableRecordCacheGeneration,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import { InventoryManagementService } from '../../server/modules/inventory-management/inventory-management.service';
import { describeInventoryLedgerImages } from '../../server/modules/inventory-management/inventory-inbound-photo.service';

const TABLES = {
  inventory: 'tblpVtCm9X0YYcdN',
  inbound: 'tblZh4wODXl6u3oD',
  outbound: 'tblUBmchdnY9G3Lx',
  borrow: 'tblsUXYZWDbMm6lZ',
  catalog: 'tblak6SEtFecgR40',
  prices: 'tblZKSgTfwfn3IGD',
  stocktake: 'tbluf9s52zrOr9IF',
  managers: 'tblWg8gr341c0HzF',
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
    (getBitableRecordCacheGeneration as jest.Mock).mockReturnValue(0);
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-token');
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    process.env.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://vnet.feishu.cn/base/QmxAbhXNJaA9YKsbfZyclzhGnSd?table=ldxJpJvX63st7SVm';
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

  it('shares overlapping forced source reads without sharing filtered responses', async () => {
    const service = new InventoryManagementService({axiosRef:{}} as never);
    let release!: (records: never[]) => void;
    const delayed = new Promise<never[]>(resolve => {release=resolve;});
    (fetchBitableRecords as jest.Mock).mockReturnValue(delayed);
    const items=service.getItems({building:'A楼'},true);
    const movements=service.getMovements({type:'inbound',building:'B楼'},true);
    await new Promise(resolve=>setImmediate(resolve));
    expect(fetchBitableRecords).toHaveBeenCalledTimes(3);
    release([]);await Promise.all([items,movements]);
    await service.getItems({},true);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(5);
  });

  it('does not use an ordinary in-flight read to satisfy a forced refresh', async () => {
    const service=new InventoryManagementService({axiosRef:{}} as never);
    let release!: (records: never[]) => void;
    const delayed=new Promise<never[]>(resolve=>{release=resolve;});
    (fetchBitableRecords as jest.Mock).mockReturnValue(delayed);
    const normal=service.getItems({},false),forced=service.getItems({},true);
    await new Promise(resolve=>setImmediate(resolve));
    expect(fetchBitableRecords).toHaveBeenCalledTimes(4);
    release([]);await Promise.all([normal,forced]);
  });

  it('drops a rejected shared read so the next explicit attempt can retry', async () => {
    const service=new InventoryManagementService({axiosRef:{}} as never);
    (fetchBitableRecords as jest.Mock).mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(service.getItems({},true)).rejects.toThrow('synthetic read failure');
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    await expect(service.getItems({},true)).resolves.toBeDefined();
    expect(fetchBitableRecords).toHaveBeenCalledTimes(4);
  });

  it('rejects old-generation reads and starts fresh reads after invalidation', async () => {
    const service=new InventoryManagementService({axiosRef:{}} as never);
    let release!: (records: never[]) => void;
    const delayed=new Promise<never[]>(resolve=>{release=resolve;});
    (fetchBitableRecords as jest.Mock).mockReturnValue(delayed);
    const old=service.getItems({},true);
    const oldCheck=expect(old).rejects.toThrow('数据在读取期间已变更');
    await new Promise(resolve=>setImmediate(resolve));
    (getBitableRecordCacheGeneration as jest.Mock).mockReturnValue(1);
    const current=service.getItems({},true);
    await new Promise(resolve=>setImmediate(resolve));
    expect(fetchBitableRecords).toHaveBeenCalledTimes(4);
    release([]);await oldCheck;await expect(current).resolves.toBeDefined();
  });

  it('retries a transient consistency conflict once for a display read', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);
    (fetchBitableRecords as jest.Mock).mockRejectedValueOnce(new Error('数据在读取期间已变更，请重新读取'));
    await expect(service.getItems({})).resolves.toMatchObject({ items: [], total: 0 });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(4);
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

  it('reuses a scoped dashboard and isolates other buildings and authorization versions', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);
    const principal = { role: 'inventory_admin', purchaseBuilding: 'A楼', accountId: 'scope-test', authorizationVersion: 1 } as const;
    const records = [
      { record_id: 'recA', fields: { 楼栋: 'A楼', 名称: 'A楼库存', 剩余库存: 2 } },
      { record_id: 'recB', fields: { 楼栋: 'B楼', 名称: 'B楼库存', 剩余库存: 5 } },
    ];
    (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) =>
      options.tableId === TABLES.inventory ? records : [],
    );

    const [first, repeated] = await Promise.all([
      service.getDashboard(false, principal),
      service.getDashboard(false, { ...principal }),
    ]);
    expect(repeated).toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(8);
    expect(first.summary.totalQuantity).toBe(2);

    const otherBuilding = await service.getDashboard(false, { ...principal, purchaseBuilding: 'B楼' });
    expect(otherBuilding.summary.totalQuantity).toBe(5);
    const newVersion = await service.getDashboard(false, { ...principal, authorizationVersion: 2 });
    expect(newVersion).not.toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(24);
  });

  it('reuses item projections for the same source arrays and remaps when the source changes', async () => {
    const service = new InventoryManagementService({ axiosRef: {} } as never);
    let records = [
      { record_id: 'recA', fields: { 楼栋: 'A楼', 名称: 'A楼库存', 剩余库存: 2 } },
      { record_id: 'recB', fields: { 楼栋: 'B楼', 名称: 'B楼库存', 剩余库存: 5 } },
    ];
    const catalog: unknown[] = [];
    (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) =>
      options.tableId === TABLES.inventory ? records : catalog,
    );
    const first = await service.getItems({ building: 'A楼' });
    const repeated = await service.getItems({ search: 'A楼库存' });
    expect(repeated.items[0]).toBe(first.items[0]);
    records = [{ ...records[0], fields: { ...records[0].fields, 剩余库存: 8 } }];
    (getBitableRecordCacheGeneration as jest.Mock).mockReturnValue(1);
    const updated = await service.getItems({ building: 'A楼' });
    expect(updated.items[0]).not.toBe(first.items[0]);
    expect(updated.items[0].quantity).toBe(8);
  });

  it('merges the current sparse photo fields onto already-filtered ledger rows', async () => {
    const photos = [{ file_token: 'private-photo-a', type: 'image/png', name: '测试.png' }];
    const inventory = [
      { record_id: 'recA', fields: { 楼栋: 'A楼', 名称: 'A楼库存' } },
      { record_id: 'recB', fields: { 楼栋: 'B楼', 名称: 'B楼库存', 物品图片: photos } },
    ];
    const gateway = { searchRecords: jest.fn().mockResolvedValue([
      { record_id: 'recA', fields: { 物品图片: photos } },
    ]) };
    (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) =>
      options.tableId === TABLES.inventory ? inventory : [],
    );
    const service = new InventoryManagementService({ axiosRef: {} } as never, undefined, gateway as never);
    const result = await service.getItems({ building: 'A楼' });
    expect(result.items.map((item) => item.recordId)).toEqual(['recA']);
    expect(result.items[0].images).toEqual(describeInventoryLedgerImages('recA', photos));
    expect(JSON.stringify(result)).not.toContain('private-photo-a');
    expect(gateway.searchRecords).toHaveBeenCalledWith(expect.objectContaining({ fieldNames: ['物品图片'] }));
    const next = await service.getItems({ building: 'B楼' });
    expect(next.items[0].images).toBeUndefined();
    expect(gateway.searchRecords).toHaveBeenCalledTimes(1);
  });

  it('reads the exact live record for image preview and rejects other buildings', async () => {
    const photos = [{ file_token: 'private-photo-a', type: 'image/png', name: '测试.png' }];
    const gateway = {
      tryGetRecord: jest.fn().mockResolvedValue({ record_id: 'recA', fields: { 楼栋: 'A楼', 物品图片: photos } }),
      getAttachmentFieldId: jest.fn().mockResolvedValue('fldImages'),
    };
    const photoService = {
      download: jest.fn().mockResolvedValue({ type: 'image/png' }),
      downloadThumbnail: jest.fn().mockResolvedValue({ type: 'image/jpeg' }),
    };
    const service = new InventoryManagementService({ axiosRef: {} } as never, photoService as never, gateway as never);
    const selector = describeInventoryLedgerImages('recA', photos)[0].url.split('/').at(-1)!;
    await expect(service.readItemImage({ role: 'inventory_admin', purchaseBuilding: 'B楼' }, 'recA', selector))
      .rejects.toThrow('物品图片不存在');
    await expect(service.readItemImage({ role: 'inventory_admin', purchaseBuilding: 'B楼' }, 'recA', selector, true))
      .rejects.toThrow('物品图片不存在');
    await expect(service.readItemImage({ role: 'admin', purchaseBuilding: null }, 'recA', selector))
      .resolves.toMatchObject({ type: 'image/png' });
    expect(photoService.download).toHaveBeenCalledTimes(1);
    await expect(service.readItemImage({ role: 'admin', purchaseBuilding: null }, 'recA', selector, true))
      .resolves.toMatchObject({ type: 'image/jpeg' });
    expect(photoService.downloadThumbnail).toHaveBeenCalledTimes(1);
    expect(gateway.tryGetRecord).toHaveBeenCalledWith('app-token', TABLES.inventory, 'recA', '库存台账');
    expect((fetchBitableRecords as jest.Mock).mock.calls.every(([, options]) => options.tableId === TABLES.catalog)).toBe(true);
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
