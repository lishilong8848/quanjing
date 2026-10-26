const logic = () =>
  require('../../client/src/pages/InventoryManagement/inventory-stocktake.logic');
describe('盘点清单交互规则', () => {
  it('builds all pending bulk lines including hidden pages, retains zero and saved quantities, and rejects missing difference notes', () => {
    const lines = Array.from({ length: 65 }, (_, i) => ({
      inventory: {
        recordId: `r${i}`,
        building: 'A楼',
        quantity: 2,
        name: `物品${i}`,
      },
      status: i === 64 ? 'confirmed' : 'draft',
      version: 1,
      actualQuantity: i === 1 ? 1 : null,
      confirmer: null,
      note: i === 1 ? '已暂存差异' : '',
    }));
    const sheet = { month: '2026-10', building: 'A楼', lines };
    const drafts = new Map([
      [
        'review:2026-10:A楼:r0',
        { quantity: '0', person: null, note: '实盘为零' },
      ],
    ]);
    const result = logic().buildStocktakeBulkLines(sheet, drafts);
    expect(result).toHaveLength(64);
    expect(result[0]).toMatchObject({ actualQuantity: 0, note: '实盘为零' });
    expect(result[1]).toMatchObject({ actualQuantity: 1, note: '已暂存差异' });
    expect(result[2].actualQuantity).toBeNull();
    drafts.set('review:2026-10:A楼:r0', {
      quantity: '0',
      person: null,
      note: '',
    });
    expect(() => logic().buildStocktakeBulkLines(sheet, drafts)).toThrow(
      '差异说明',
    );
  });
  it('groups room names without merging the two distinct 315 locations', () => {
    const room = logic().stocktakeWarehouse;
    expect(room('A-315-4-1')).toBe('A-315');
    expect(room('A-3F-315储藏间06-2F')).toBe('A-3F-315储藏间');
    expect(room('A-3F-315储藏间04-3F')).toBe('A-3F-315储藏间');
    expect(room('库房 2 · 货架 10')).toBe('库房 2');
    expect(room('未知位置-甲')).toBe('未知位置-甲');
    expect(room('')).toBe('未配置库房');
    expect(room('A-1F-126储藏室06-2F')).toBe('A-1F-126储藏室');
    expect(room('H-2F-226储存间01-0F')).toBe('H-2F-226储存间');
    expect(room('D-3F-315储藏间0F-0F')).toBe('D-3F-315储藏间');
    expect(room('B-4F-园区总库01-1F')).toBe('B-4F-园区总库');
    expect(room('C-1F-112值班室-07-2F')).toBe('C-1F-112值班室');
  });
  it('orders rooms and shelves naturally and keeps every filtered record exactly once across pages', () => {
    const make = (id: string, location: string, status = 'draft') => ({
      inventory: { recordId: id, location, name: id },
      status,
    });
    const lines = [
      make('a', '库房 10 · 货架 1'),
      make('b', '库房 2 · 货架 10'),
      make('c', '库房 2 · 货架 2', 'confirmed'),
    ];
    const groups = logic().groupStocktakeLines(lines);
    expect(groups.map((g: any) => g.name)).toEqual(['库房 2', '库房 10']);
    expect(groups[0].lines.map((l: any) => l.inventory.recordId)).toEqual([
      'c',
      'b',
    ]);
    expect(groups[0].confirmed).toBe(1);
    const first = logic().stocktakeGroupPage(groups, 1, 1);
    const second = logic().stocktakeGroupPage(groups, 2, 1);
    expect(first[0]).toMatchObject({ name: '库房 2', total: 2, confirmed: 1 });
    expect(second[0]).toMatchObject({ name: '库房 2', total: 2, confirmed: 1 });
    const ids = [1, 2, 3].flatMap((page) =>
      logic()
        .stocktakeGroupPage(groups, page, 1)
        .flatMap((g: any) => g.lines.map((l: any) => l.inventory.recordId)),
    );
    expect(ids).toEqual(['c', 'b', 'a']);
    expect(lines.map((l) => l.inventory.recordId)).toEqual(['a', 'b', 'c']);
  });
  it('marks only changes to quantity, selected employee or note as unsaved', () => {
    const person = { recordId: 'employee-1', openId: 'ou_1', name: '甲' };
    const line = { actualQuantity: null, confirmer: null, note: '' };
    const draft = { quantity: '', person: null, note: '' };
    expect(logic().isStocktakeDraftDirty(line, draft)).toBe(false);
    expect(
      logic().isStocktakeDraftDirty(line, { ...draft, quantity: '0' }),
    ).toBe(true);
    expect(logic().isStocktakeDraftDirty(line, { ...draft, person })).toBe(
      true,
    );
    expect(
      logic().isStocktakeDraftDirty(
        { ...line, confirmer: person },
        { ...draft, person: { ...person, name: '甲更新' } },
      ),
    ).toBe(false);
    expect(
      logic().isStocktakeDraftDirty(
        { ...line, actualQuantity: 12 },
        { ...draft, quantity: '12' },
      ),
    ).toBe(false);
    expect(
      logic().isStocktakeDraftDirty(line, { ...draft, note: '差异' }),
    ).toBe(true);
  });
  it('groups shared generation failures while preserving building-specific errors', () => {
    expect(
      logic().stocktakeGenerationErrors([
        { building: 'A楼', error: '读取超时，请重试' },
        { building: 'B楼', error: '读取超时，请重试' },
        { building: 'C楼', error: '库存条目不明确' },
      ]),
    ).toBe('A楼、B楼：读取超时，请重试；C楼：库存条目不明确');
    expect(logic().stocktakeGenerationErrors([])).toBe('');
  });
  it('keeps valid historical months and rejects invalid or future URL months', () => {
    expect(logic().resolveStocktakeMonth('2025-12', '2026-10')).toBe('2025-12');
    expect(logic().shiftStocktakeMonth('2026-01', -1)).toBe('2025-12');
    expect(logic().shiftStocktakeMonth('2025-12', 1)).toBe('2026-01');
    for (const value of [null, '2026-13', '2026-11', '1999-12', 'bad'])
      expect(logic().resolveStocktakeMonth(value, '2026-10')).toBe('2026-10');
  });
  it('merges only the selected month and uses execution progress only for started buildings', () => {
    const history = [
      {
        year: 2026,
        month: 9,
        total: 30,
        completed: 30,
        completionRate: 100,
        buildings: [
          {
            building: 'A楼',
            total: 10,
            completed: 10,
            completionRate: 100,
            responsible: '甲',
          },
          {
            building: 'B楼',
            total: 20,
            completed: 20,
            completionRate: 100,
            responsible: '乙',
          },
        ],
      },
    ];
    const overview = {
      month: '2026-09',
      buildings: [
        { building: 'A楼', status: 'open', total: 5, confirmed: 2 },
        { building: 'B楼', status: 'not_started', total: 0, confirmed: 0 },
      ],
    };
    expect(
      logic().monthlyStocktakeProgress('2026-09', history, overview, [
        'A楼',
        'B楼',
      ]),
    ).toMatchObject({
      total: 25,
      completed: 22,
      completionRate: 88,
      buildings: [
        { total: 5, completed: 2, responsible: '甲' },
        { total: 20, completed: 20 },
      ],
    });
    expect(
      logic().monthlyStocktakeProgress('2026-08', history, overview, ['A楼']),
    ).toMatchObject({ year: 2026, month: 8, total: 0, completed: 0 });
    expect(
      logic().monthlyStocktakeProgress('2026-09', history, overview, ['B楼']),
    ).toMatchObject({ total: 20, completed: 20 });
  });
  it('explains timeouts without claiming that the write failed', () => {
    expect(
      logic().stocktakeError({ code: 'ECONNABORTED', message: 'timeout' }),
    ).toBe('请求超时，保存结果待确认，请保留草稿并重试');
    expect(
      logic().stocktakeError({
        name: 'TimeoutError',
        message: 'signal timed out',
      }),
    ).toBe('请求超时，保存结果待确认，请保留草稿并重试');
    expect(logic().stocktakeError(null)).toBe(
      '未能确认保存结果，请保留草稿并重试',
    );
  });
  it('keeps empty quantity distinct from zero and validates precision', () => {
    expect(logic().parseStocktakeQuantity('')).toBeNull();
    expect(logic().parseStocktakeQuantity('0')).toBe(0);
    expect(logic().parseStocktakeQuantity('1.125')).toBe(1.125);
    expect(() => logic().parseStocktakeQuantity('-1')).toThrow();
    expect(() => logic().parseStocktakeQuantity('1.1234')).toThrow();
  });
  it('filters from the same lines without changing totals or mutating them', () => {
    const lines = [
      {
        inventory: {
          recordId: 'a',
          name: '开关',
          sku: 'SKU-A',
          location: '库房',
          quantity: 2,
        },
        status: 'confirmed',
        actualQuantity: 1,
      },
      {
        inventory: {
          recordId: 'b',
          name: '胶带',
          sku: 'SKU-B',
          location: '库房',
          quantity: 2,
        },
        status: 'draft',
        actualQuantity: null,
      },
    ];
    expect(
      logic()
        .filterStocktakeLines(lines, 'difference', '')
        .map((r: any) => r.inventory.recordId),
    ).toEqual(['a']);
    expect(logic().filterStocktakeLines(lines, 'pending', '胶带')).toHaveLength(
      1,
    );
    expect(lines).toHaveLength(2);
  });
});
