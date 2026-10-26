import {
  mapTool,
  mapFlow,
  scopeToolsSnapshot,
} from '../../server/modules/operations-tools/operations-tools.mapper';

describe('operations tools typed mapping and access', () => {
  it('preserves missing quantities and computes monthly maintenance without the erroneous formula', () => {
    const tool = mapTool({
      record_id: 'recA',
      fields: {
        工具名称: [{ text: '验电器' }],
        楼栋: '南通A楼',
        维护周期: '每月',
        当前维护日期: '2026-08-31',
        维护过期时间: '2030-08-31',
      },
    });
    expect(tool).toMatchObject({
      id: 'recA',
      building: 'A楼',
      quantity: null,
      maintenanceDue: '2026-09-30',
      inspectionDue: null,
    });
  });
  it('does not turn unnamed or ID-less placeholder rows into assets', () => {
    expect(
      mapTool({ record_id: 'empty', fields: { 楼栋: '南通A楼' } }),
    ).toBeNull();
    expect(mapTool({ fields: { 工具名称: '名称' } })).toBeNull();
  });
  it('keeps linked stable ids without treating display names as ids', () => {
    const flow = mapFlow('borrow', {
      record_id: 'flow1',
      fields: {
        借用工具: { link_record_ids: ['recA', 'recB'] },
        审批结果: '工具已出库',
        借用数量: 3,
      },
    });
    expect(flow).toMatchObject({
      toolIds: ['recA', 'recB'],
      status: '工具已出库',
      quantity: 3,
    });
    expect(
      mapFlow('repair', {
        record_id: 'repair1',
        fields: { 检修工具名称: '重名工具', 楼栋: 'A楼' },
      })?.toolIds,
    ).toEqual([]);
  });
  it('fails closed and never leaks a mixed-building flow to a building account', () => {
    const a = mapTool({
      record_id: 'recA',
      fields: { 工具名称: 'A工具', 楼栋: '南通A楼' },
    })!;
    const b = mapTool({
      record_id: 'recB',
      fields: { 工具名称: 'B工具', 楼栋: '南通B楼' },
    })!;
    const mixed = mapFlow('borrow', {
      record_id: 'flow1',
      fields: { 借用工具: ['recA', 'recB'], 审批结果: '工具已出库' },
    })!;
    const snapshot: any = {
      tools: [a, b],
      flows: [mixed],
      sources: {},
      generatedAt: '2026-09-30T00:00:00Z',
      refreshing: false,
    };
    expect(
      scopeToolsSnapshot(
        { role: 'inventory_admin', purchaseBuilding: 'A楼' },
        snapshot,
      ).tools,
    ).toEqual([a]);
    expect(
      scopeToolsSnapshot(
        { role: 'inventory_admin', purchaseBuilding: 'A楼' },
        snapshot,
      ).flows,
    ).toEqual([]);
    expect(() =>
      scopeToolsSnapshot(
        { role: 'inventory_admin', purchaseBuilding: null },
        snapshot,
      ),
    ).toThrow();
    expect(() =>
      scopeToolsSnapshot({ role: 'guest', purchaseBuilding: null }, snapshot),
    ).toThrow();
    expect(() =>
      scopeToolsSnapshot(
        { role: 'purchase_admin', purchaseBuilding: 'A楼' },
        snapshot,
      ),
    ).toThrow();
  });
});
