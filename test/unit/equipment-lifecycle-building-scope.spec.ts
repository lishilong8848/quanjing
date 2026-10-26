import {
  mapEquipmentLifecycleDashboard,
  type EquipmentLifecycleSources,
} from '../../server/modules/equipment-lifecycle/equipment-lifecycle.mapper';

describe('lifecycle dashboard source scoping', () => {
  it('recomputes every metric and detail from the selected building and drops unknown floors', () => {
    const records = ['南通A楼', 'B楼', '未知'].map((building, i) => ({
      record_id: `record-${i}`,
      fields: {
        楼栋: building,
        设备名称: `设备${i}`,
        状态: '在保',
        合同当前状态: '过保',
        管理员: `人员${i}`,
      },
    }));
    const sources: EquipmentLifecycleSources = {
      equipment: { records, status: 'fresh' },
      keyParts: { records, status: 'fresh' },
      longTermMaintenance: { records, status: 'fresh' },
      maintenanceContracts: { records, status: 'fresh' },
    };
    const view = mapEquipmentLifecycleDashboard(sources, {
      month: '2026-10',
      syncedAt: '2026-10-03T00:00:00Z',
      building: 'A楼',
    } as Parameters<typeof mapEquipmentLifecycleDashboard>[1]);
    expect(view.summary.equipmentTotal).toBe(1);
    expect(view.summary.keyPartTotal).toBe(1);
    expect(view.summary.expiredContracts).toBe(1);
    expect(view.summary.longTermMaintenance).toBe(1);
    expect(view.assets.map((a) => a.building)).toEqual(['A楼']);
    expect(view.filterOptions.managers).toEqual(['人员0']);
    expect(view.sourceTables.every((t) => t.recordCount === 1)).toBe(true);
    expect(
      view.relatedRecords.maintenanceContracts.map((a) => a.building),
    ).toEqual(['A楼']);
    expect(JSON.stringify(view)).not.toContain('人员1');
    expect(JSON.stringify(view)).not.toContain('设备1');
    expect(sources.equipment.records).toHaveLength(3);
  });
});
