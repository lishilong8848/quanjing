import { InventoryStocktakeSource } from '../../server/modules/inventory-management/inventory-stocktake.source';
import { selectStocktakeItems } from '../../server/modules/inventory-management/inventory-stocktake.rules';

describe('stocktake source field adaptation', () => {
  const envNames = ['INVENTORY', 'CATALOG', 'INBOUND', 'OUTBOUND'].map(
    (name) => `FEISHU_WAREHOUSE_${name}_TABLE_ID`,
  );
  const old = envNames.map((name) => process.env[name]);
  beforeEach(() => envNames.forEach((name) => (process.env[name] = name)));
  afterAll(() =>
    envNames.forEach((name, i) =>
      old[i] === undefined
        ? delete process.env[name]
        : (process.env[name] = old[i]),
    ),
  );
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
    const gateway = {
      listRecords: jest.fn(async ({ tableName }) =>
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
      ),
    };
    const source = new InventoryStocktakeSource({} as any, gateway as any);
    jest
      .spyOn(source as any, 'config')
      .mockResolvedValue({ appToken: 'test', url: '' });
    return source.snapshot('B楼');
  }
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
