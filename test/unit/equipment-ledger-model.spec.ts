import {
  mapLedgerRecords,
  summarizeLedger,
  queryLedger,
} from '../../server/modules/equipment-lifecycle/equipment-ledger.model';

const record = (id: string, fields: Record<string, unknown>) => ({
  record_id: id,
  fields,
});
const records = [
  record('one', {
    机楼: 'A楼',
    设备名称: '冷水机组',
    品牌: '品牌A',
    型号: 'X1',
    设备编号: 'A-01',
    数量: 1,
    维保截止日期: '2026-10-01',
    质保年限来源: '原台账',
  }),
  record('two', {
    机楼: 'A楼',
    设备名称: '冷水机组',
    型号: 'X2',
    设备编号: 'A-02',
    数量: 1,
    维保截止日期: '2026-09-30',
  }),
  record('group', {
    机楼: 'A楼',
    设备名称: '冷水机组',
    设备编号: '全部冷机组',
    数量: 6,
    维保截止日期: '2027-01-01',
  }),
  record('three', {
    机楼: 'B楼',
    设备名称: 'UPS',
    型号: 'X1',
    设备编号: 'B-01',
    维保截止日期: '2027-01-01',
    质保年限来源: 'A/B楼参考推定',
  }),
  record('four', { 机楼: 'B楼', 设备名称: 'UPS', 设备编号: 'B-02' }),
];

describe('equipment ledger business model', () => {
  it('matches fuzzy multi-field terms, full-width text and punctuation within the selected building', () => {
    const assets = mapLedgerRecords(records, '2026-10-01');
    expect(
      queryLedger(assets, { search: '冷水 品牌a', building: 'A楼' }).items.map(
        (a) => a.id,
      ),
    ).toEqual(['one']);
    expect(
      queryLedger(assets, { search: 'Ａ０１' }).items.map((a) => a.id),
    ).toEqual(['one']);
    expect(
      queryLedger(assets, { search: 'ups x1', building: 'A楼' }).total,
    ).toBe(0);
  });
  it('counts detail records separately from collections and derives exact warranty boundaries', () => {
    const assets = mapLedgerRecords(records, '2026-10-01');
    expect(assets.map((a) => a.warranty)).toEqual([
      '在保',
      '过保',
      '在保',
      '待确认',
      '待确认',
    ]);
    const summary = summarizeLedger(assets);
    expect(summary.metrics).toMatchObject({
      total: 4,
      inWarranty: 1,
      expired: 1,
      pending: 2,
      categories: 2,
      models: 2,
      collections: 1,
    });
    expect(summary.categories.find((c) => c.name === '冷水机组')?.count).toBe(
      2,
    );
    expect(summary.models.find((c) => c.name === 'X1')?.count).toBe(2);
    expect(
      queryLedger(assets, { building: 'A楼', warranty: '过保' }).items.map(
        (a) => a.id,
      ),
    ).toEqual(['two']);
    expect(queryLedger(assets, { kind: 'collection' }).total).toBe(1);
  });

  it('handles combined filters, paginates and never turns missing model into a real model', () => {
    const assets = mapLedgerRecords(records, '2026-10-01');
    expect(
      queryLedger(assets, { search: 'x1', warranty: '待确认' }).total,
    ).toBe(1);
    expect(
      queryLedger(assets, { category: 'UPS', page: 9, pageSize: 1 }),
    ).toMatchObject({ page: 2, total: 2, totalPages: 2 });
    expect(queryLedger(assets, { model: '未填写' }).total).toBe(1);
    expect(summarizeLedger(assets).metrics.models).toBe(2);
    expect(records[0].fields['机楼']).toBe('A楼');
  });

  it('supports 40000 representative records and summary drilldown equality', () => {
    const rows = mapLedgerRecords(
      Array.from({ length: 40000 }, (_, i) =>
        record(`r-${i}`, {
          机楼: `${String.fromCharCode(65 + (i % 5))}楼`,
          设备名称: i % 2 ? 'UPS' : '冷机',
          型号: `M${i % 10}`,
          维保截止日期: i % 3 ? '2027-01-01' : '2026-01-01',
        }),
      ),
      '2026-10-01',
    );
    const summary = summarizeLedger(rows);
    for (const point of summary.categories)
      expect(queryLedger(rows, { category: point.name }).total).toBe(
        point.count,
      );
    expect(queryLedger(rows, { pageSize: 10000 }).items).toHaveLength(100);
    expect(queryLedger(rows, { building: 'C楼' }).total).toBe(8000);
  });

  it('marks invalid dates and reference derived warranty as unconfirmed', () => {
    const assets = mapLedgerRecords(
      [
        record('x', { 维保截止日期: '2026-02-30' }),
        record('y', { 维保截止日期: '2027-01-01', 质保年限来源: '参考推定' }),
      ],
      '2026-10-01',
    );
    expect(assets.map((a) => a.warranty)).toEqual(['待确认', '待确认']);
  });
  it('normalizes the verified imported building labels for lifecycle association', () => {
    expect(
      mapLedgerRecords([record('z', { 机楼: '南通A楼' })], '2026-10-01')[0]
        .building,
    ).toBe('A楼');
  });
});
