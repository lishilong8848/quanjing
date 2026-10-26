import type {
  InventoryManagementItem,
  InventoryMovementItem,
} from '../../shared/inventory-management.interface';

const rules = () =>
  require('../../server/modules/inventory-management/inventory-stocktake.rules');
const items = (count = 21): InventoryManagementItem[] =>
  Array.from({ length: count }, (_, i) => ({
    recordId: `rec${i}`,
    sku: `SKU${i}`,
    name: `物资${i}`,
    specification: '',
    brand: '',
    primaryCategory: '',
    secondaryCategory: '',
    building: 'A楼',
    location: '一层',
    storageType: '',
    quantity: 2,
    minimumQuantity: 0,
    difference: 2,
    unit: '个',
    annualUsage: 0,
    value: 0,
    owners: [],
    lowStock: false,
    negativeStock: false,
    idle: true,
    pendingConfirmation: false,
  }));
const movement = (
  overrides: Partial<InventoryMovementItem> = {},
): InventoryMovementItem => ({
  recordId: 'move1',
  type: 'outbound',
  sku: 'SKU0',
  name: '物资0',
  specification: '',
  quantity: 1,
  unit: '个',
  building: 'A楼',
  destinationBuilding: '',
  location: '一层',
  reason: '',
  operator: '',
  applicant: '',
  status: '已出库',
  occurredAt: '2026-09-02T00:00:00+08:00',
  expectedReturnAt: null,
  overdue: false,
  ...overrides,
});

describe('库存盘点抽样', () => {
  it('rounds up 10%, excludes all preceding three months and keeps moved entries', () => {
    const result = rules().selectStocktakeItems({
      month: '2026-10',
      building: 'A楼',
      items: items(),
      movements: [movement()],
      history: [
        { month: '2026-07', building: 'A楼', recordIds: ['rec0', 'rec1'] },
        { month: '2026-08', building: 'A楼', recordIds: ['rec2'] },
        { month: '2026-09', building: 'A楼', recordIds: ['rec3'] },
      ],
      seed: 'fixed',
    });
    expect(result.randomTarget).toBe(3);
    expect(
      result.selected.filter((r: any) => r.reasons.includes('random')),
    ).toHaveLength(3);
    expect(
      result.selected.find((r: any) => r.item.recordId === 'rec0').reasons,
    ).toEqual(['movement']);
    expect(
      result.selected.some((r: any) =>
        ['rec1', 'rec2', 'rec3'].includes(r.item.recordId),
      ),
    ).toBe(false);
    expect(result.excludedRecordIds).toHaveLength(4);
  });
  it('deduplicates double hits, is reproducible and handles Shanghai month boundaries', () => {
    const input = {
      month: '2026-01',
      building: 'A楼',
      items: items(1),
      movements: [
        movement({ occurredAt: '2025-11-30T16:00:00Z' }),
        movement({ recordId: 'move2', occurredAt: '2025-12-31T15:59:59Z' }),
      ],
      history: [],
      seed: 'fixed',
    };
    const result = rules().selectStocktakeItems(input);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].reasons.sort()).toEqual(['movement', 'random']);
    expect(result.selected[0].movementIds).toEqual(['move1', 'move2']);
    expect(rules().selectStocktakeItems(input)).toEqual(result);
    expect(rules().stocktakeMonth(new Date('2025-12-31T16:00:00Z'))).toBe(
      '2026-01',
    );
  });
  it('reports shortfall without resampling recent entries; does not count pending outbound', () => {
    const result = rules().selectStocktakeItems({
      month: '2026-10',
      building: 'A楼',
      items: items(1),
      movements: [movement({ status: '待审批' })],
      history: [{ month: '2026-09', building: 'A楼', recordIds: ['rec0'] }],
      seed: 'fixed',
    });
    expect(result.selected).toEqual([]);
    expect(result.shortfall).toBe(1);
  });
  it('rejects missing or ambiguous inventory identities instead of omitting movements', () => {
    expect(() =>
      rules().selectStocktakeItems({
        month: '2026-10',
        building: 'A楼',
        items: items(),
        movements: [movement({ sku: 'missing' })],
        history: [],
        seed: 'fixed',
      }),
    ).toThrow('无法唯一匹配');
    expect(() =>
      rules().selectStocktakeItems({
        month: '2026-10',
        building: 'A楼',
        items: [items(1)[0], { ...items(1)[0], recordId: 'other' }],
        movements: [movement()],
        history: [],
        seed: 'fixed',
      }),
    ).toThrow('无法唯一匹配');
  });
  it('validates quantity including zero and requires a selected stable person', () => {
    expect(() =>
      rules().validateStocktakeDraft({
        actualQuantity: 0,
        confirmer: { recordId: 'person1', openId: 'ou_person', name: '示例' },
        note: '',
        bookQuantity: 0,
      }),
    ).not.toThrow();
    for (const actualQuantity of [null, '', -1, NaN, Infinity])
      expect(() =>
        rules().validateStocktakeDraft({
          actualQuantity,
          confirmer: { recordId: 'p', openId: 'ou_p' },
          note: '',
          bookQuantity: 0,
        }),
      ).toThrow();
    expect(() =>
      rules().validateStocktakeDraft({
        actualQuantity: 1,
        confirmer: null,
        note: '',
        bookQuantity: 1,
      }),
    ).toThrow('确认人');
    expect(() =>
      rules().validateStocktakeDraft({
        actualQuantity: 1,
        confirmer: { recordId: 'p', openId: 'ou_p' },
        note: '',
        bookQuantity: 2,
      }),
    ).toThrow('差异说明');
  });
});
