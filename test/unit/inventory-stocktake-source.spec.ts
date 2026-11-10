import { InventoryStocktakeSource } from '../../server/modules/inventory-management/inventory-stocktake.source';
import { selectStocktakeItems } from '../../server/modules/inventory-management/inventory-stocktake.rules';
import * as bitable from '../../server/common/feishu/bitable-direct-read';

describe('stocktake source field adaptation', () => {
  const envNames = ['INVENTORY', 'CATALOG', 'INBOUND', 'OUTBOUND'].map(
    (name) => `FEISHU_WAREHOUSE_${name}_TABLE_ID`,
  );
  const old = envNames.map((name) => process.env[name]);
  beforeEach(() => envNames.forEach((name) => (process.env[name] = name)));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  afterAll(() =>
    envNames.forEach((name, i) =>
      old[i] === undefined
        ? delete process.env[name]
        : (process.env[name] = old[i]),
    ),
  );
  it('skips only unnamed zero-stock placeholders while preserving real zero-stock items', async () => {
    const source = new InventoryStocktakeSource({} as any, {} as any);
    jest.spyOn(source as any, 'config').mockResolvedValue({ appToken: 'test', url: '' });
    jest.spyOn(bitable, 'fetchBitableRecords').mockImplementation(async (_http, { tableName }) =>
      tableName === '库存台账' ? [
        { record_id: 'blank', fields: { 楼栋: 'B楼', 剩余库存: 0 } },
        { record_id: 'real', fields: { 楼栋: 'B楼', 剩余库存: 0, 物品类别号: 'D1013', 名称: '电池' } },
        { record_id: 'named', fields: { 楼栋: 'B楼', 剩余库存: 0, 名称: '待补编号物品' } },
        { record_id: 'nonzero', fields: { 楼栋: 'B楼', 剩余库存: 2 } },
      ] : []);
    const result = await source.snapshot();
    expect(result.items.map(item => item.recordId)).toEqual(['real', 'named', 'nonzero']);
  });

  it('looks up only the requested stock and still revalidates its catalog specialty', async () => {
    const stock = { record_id: 'stock1', fields: { 物品类别号: 'D1013', 楼栋: 'B楼', 剩余库存: 2 } };
    const gateway = { getRecords: jest.fn().mockResolvedValue([stock]) };
    const source = new InventoryStocktakeSource({} as any, gateway as any);
    jest.spyOn(source as any, 'config').mockResolvedValue({ appToken: 'test', url: '' });
    const fetch = jest.spyOn(bitable, 'fetchBitableRecords').mockResolvedValue([
      { record_id: 'catalog1', fields: { 物品类别号: 'D1013', 楼栋: 'B楼', 专业: '暖通' } },
    ]);
    const item = { recordId: 'stock1', sku: 'D1013', building: 'B楼', specialty: '暖通' } as const;
    const principal = { role: 'professional_admin', purchaseBuilding: null, specialties: ['暖通'] } as const;
    await expect(source.current(item as any, principal))
      .resolves.toMatchObject({ recordId: 'stock1', quantity: 2, specialty: '暖通' });
    expect(gateway.getRecords).toHaveBeenCalledWith('test', envNames[0], ['stock1'], '库存台账');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tableId: envNames[1], forceRefresh: true, allowStale: false,
    }));
    fetch.mockResolvedValue([
      { record_id: 'catalog1', fields: { 物品类别号: 'D1013', 楼栋: 'B楼', 专业: '电气' } },
    ]);
    await expect(source.current(item as any, principal)).rejects.toThrow('超出授权');
  });

  async function snapshot(location: string, duplicate = false, multi = false) {
    const inventory = {
      record_id: 'stock1',
      fields: {
        物品类别号: 'D1013',
        楼栋: 'B楼',
        剩余库存: 2,
        存放位置: 'B-1F-126仓库-06-3F',
      },
    };
    jest.spyOn(bitable, 'fetchBitableRecords').mockImplementation(async (_http, { tableName }) =>
        tableName === '库存台账'
          ? [
              inventory,
              ...(duplicate ? [{ ...inventory, record_id: 'stock2' }] : []),
              ...(multi
                ? [
                    {
                      record_id: 'stock3',
                      fields: { ...inventory.fields, 物品类别号: 'B3007' },
                    },
                  ]
                : []),
            ]
          : tableName === '出库填写'
            ? [
                {
                  record_id: 'move1',
                  fields: {
                    物品类别号: multi ? {} : 'D1013',
                    ...(multi
                      ? {
                          '物品类别号（单选）': {
                            type: 1,
                            value: [
                              { text: 'D1013', type: 'text' },
                              { text: ',', type: 'text' },
                              { text: 'B3007', type: 'text' },
                            ],
                          },
                        }
                      : {}),
                    楼栋: 'B楼',
                    存放位置: location,
                    出库时间: Date.parse('2026-09-01T00:00:00+08:00'),
                    出库数量: 1,
                  },
                },
              ]
            : [],
      );
    const source = new InventoryStocktakeSource({} as any, {} as any);
    jest
      .spyOn(source as any, 'config')
      .mockResolvedValue({ appToken: 'test', url: '' });
    return source.snapshot('B楼', '2026-10');
  }
  it('limits movement searches to the prior Shanghai month and requires fresh complete reads', async () => {
    await snapshot('B-1F-126仓库-06-3F');
    const calls = jest.mocked(bitable.fetchBitableRecords).mock.calls.map(([, options]) => options);
    expect(calls).toHaveLength(4);
    for (const [tableName, dateField] of [['入库填写', '入库日期'], ['出库填写', '出库时间']]) {
      expect(calls.find((call) => call.tableName === tableName)).toMatchObject({
        forceRefresh: true,
        strict: true,
        allowStale: false,
        filter: { conjunction: 'and', conditions: [
          { field_name: dateField, operator: 'isGreater', value: ['ExactDate', String(Date.parse('2026-08-31T00:00:00+08:00'))] },
          { field_name: dateField, operator: 'isLess', value: ['ExactDate', String(Date.parse('2026-10-01T00:00:00+08:00'))] },
        ] },
      });
    }
    expect(calls.filter((call) => !call.filter).map((call) => call.tableName)).toEqual(['库存台账', '物品类别']);
  });
  it('bounds an incomplete snapshot without cancelling a shared source read', async () => {
    jest.useFakeTimers();
    let finishSharedRead: (records: bitable.BitableRecordItem[]) => void = () => {};
    const shared = new Promise<bitable.BitableRecordItem[]>((resolve) => { finishSharedRead = resolve; });
    const read = jest.spyOn(bitable, 'fetchBitableRecords').mockReturnValue(shared);
    const http = {} as any;
    const source = new InventoryStocktakeSource(http, {} as any);
    jest.spyOn(source as any, 'config').mockResolvedValue({ appToken: 'test', url: '' });
    const result = expect(source.snapshot(undefined, '2026-11')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await jest.advanceTimersByTimeAsync(180_000);
    await result;
    expect(read.mock.calls.every(([client]) => client === http)).toBe(true);
    finishSharedRead([]);
    await expect(shared).resolves.toEqual([]);
  });
  it('does not mistake a Feishu option ID for the location label', async () => {
    const data = await snapshot('optasobP2g');
    expect(data.movements[0].location).toBe('');
  });
  it('reads all bulk quantities once and uses the same strict field adaptation as single confirmation', async () => {
    const item = {
      recordId: 'stock1',
      building: 'B楼',
      sku: 'D1013',
      name: '开关',
      quantity: 2,
      location: 'B-1F-126仓库-06-3F',
    } as any;
    const record = {
      record_id: 'stock1',
      fields: {
        楼栋: 'B楼',
        物品类别号: 'D1013',
        剩余库存: 3,
        存放位置: item.location,
      },
    };
    const gateway = {
      getRecords: jest.fn().mockResolvedValue([record]),
      getRecord: jest.fn().mockResolvedValue(record),
    };
    const source = new InventoryStocktakeSource({} as any, gateway as any);
    jest
      .spyOn(source as any, 'config')
      .mockResolvedValue({ appToken: 'test', url: '' });
    expect(await source.currentMany([item])).toEqual([
      await source.current(item),
    ]);
    expect(gateway.getRecords).toHaveBeenCalledWith(
      'test',
      'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
      ['stock1'],
      '库存台账',
    );
    gateway.getRecords.mockResolvedValue([
      { ...record, fields: { ...record.fields, 剩余库存: null } },
    ]);
    await expect(source.currentMany([item])).rejects.toThrow('有效数量');
    gateway.getRecords.mockResolvedValue([]);
    await expect(source.currentMany([item])).rejects.toThrow('不存在');
  });
  it('preserves an explicit location and never merges ambiguous same-SKU ledger rows', async () => {
    const explicit = await snapshot('B-1F-126仓库-06-3F');
    expect(explicit.movements[0].location).toBe('B-1F-126仓库-06-3F');
    const ambiguous = await snapshot('optasobP2g', true);
    ambiguous.movements[0].status = '已出库';
    expect(() =>
      selectStocktakeItems({
        ...ambiguous,
        building: 'B楼',
        month: '2026-10',
        seed: 'fixed',
        history: [],
      }),
    ).toThrow('无法唯一匹配');
  });
  it('expands explicit multi-category records without omitting any stock line', async () => {
    const data = await snapshot('', false, true);
    expect(data.movements.map((m) => m.sku)).toEqual(['D1013', 'B3007']);
    data.movements.forEach((m) => (m.status = '已出库'));
    const selected = selectStocktakeItems({
      ...data,
      building: 'B楼',
      month: '2026-10',
      seed: 'fixed',
      history: [],
    });
    expect(
      selected.selected.filter((s) => s.reasons.includes('movement')),
    ).toHaveLength(2);
    expect(
      selected.selected.every((s) => s.movementIds.includes('move1')),
    ).toBe(true);
  });
});
