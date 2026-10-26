import {
  classifyLedgerAsset,
  ledgerManagement,
} from '../../shared/equipment-ledger-classification';
import {
  mapLedgerRecords,
  queryLedger,
  summarizeLedger,
} from '../../server/modules/equipment-lifecycle/equipment-ledger.model';

const rows = (entries: Array<Record<string, unknown>>) =>
  mapLedgerRecords(
    entries.map((fields, i) => ({ record_id: `r${i}`, fields })),
    '2026-10-01',
  );

describe('ledger business families and composition', () => {
  it('separates explicit UPS and HVDC without guessing from models', () => {
    expect(
      classifyLedgerAsset({
        name: 'UPS电源',
        category: 'UPS/HVDC电源',
        specialty: '配电系统',
      }).family,
    ).toBe('UPS');
    expect(
      classifyLedgerAsset({
        name: 'HVDC',
        category: 'UPS/HVDC电源',
        specialty: '配电系统',
      }).family,
    ).toBe('HVDC');
    expect(
      classifyLedgerAsset({
        name: 'UPS/HVDC电源',
        category: 'UPS/HVDC电源',
        specialty: '配电系统',
      }).family,
    ).toBe('UPS/HVDC待分类');
    expect(
      classifyLedgerAsset({
        name: '柴油发电机',
        category: '柴油发电机',
        specialty: '配电系统',
      }),
    ).toEqual({ family: '柴发', system: '供配电' });
    expect(
      classifyLedgerAsset({
        name: 'UPS输出配电柜',
        category: '配电柜',
        specialty: '配电系统',
      }).family,
    ).toBe('配电柜');
  });
  it('counts distinct kinds independently of repeated records and excludes collections', () => {
    const assets = rows([
      ...Array.from({ length: 80 }, () => ({
        设备名称: 'UPS电源',
        大设备类型: 'UPS/HVDC电源',
        机楼: 'A楼',
      })),
      { 设备名称: 'HVDC', 大设备类型: 'UPS/HVDC电源', 机楼: 'D楼' },
      { 设备名称: '冷水机组', 大设备类型: '冷水机组', 机楼: 'B楼' },
      {
        设备名称: '消防探测器',
        大设备类型: '消防探测器',
        设备编号: '全部设备',
      },
    ]);
    const summary = summarizeLedger(assets);
    expect(summary.systems.find((p) => p.name === '供配电')).toMatchObject({
      count: 81,
      kindCount: 2,
      families: ['UPS', 'HVDC'],
    });
    expect(summary.systems.find((p) => p.name === '暖通')).toMatchObject({
      count: 1,
      kindCount: 1,
    });
    expect(summary.systems.reduce((n, p) => n + p.count, 0)).toBe(
      summary.metrics.total,
    );
    for (const point of summary.families) {
      expect(queryLedger(assets, { family: point.name }).total).toBe(
        point.count,
      );
      expect(point.inWarranty + point.expired + point.pending).toBe(
        point.count,
      );
    }
    for (const point of summary.systems)
      expect(queryLedger(assets, { system: point.name }).total).toBe(
        point.count,
      );
    expect(
      queryLedger(assets, {
        family: 'UPS',
        management: '自建楼',
        building: 'D楼',
      }).total,
    ).toBe(0);
    expect(
      queryLedger(assets, { family: 'HVDC', management: '代维楼' }).total,
    ).toBe(1);
  });
  it('keeps unknown categories and buildings explicit', () => {
    expect(ledgerManagement('A楼')).toBe('自建楼');
    expect(ledgerManagement('E楼')).toBe('代维楼');
    expect(ledgerManagement('未填写')).toBe('其他楼栋');
    const assets = rows([{ 设备名称: '未知设备', 机楼: 'F楼' }]);
    expect(summarizeLedger(assets).systems).toEqual([
      expect.objectContaining({ name: '其他', kindCount: 1, count: 1 }),
    ]);
    expect(queryLedger(assets, { management: '其他楼栋' }).total).toBe(1);
  });
});
