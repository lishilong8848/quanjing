import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { mapEquipmentLifecycleDashboard } from './equipment-lifecycle.mapper';

type SourceStatus = 'fresh' | 'stale' | 'failed';

function record(
  recordId: string,
  fields: Record<string, unknown>,
  lastModifiedTime = 1_783_699_200_000,
): BitableRecordItem {
  return {
    record_id: recordId,
    fields,
    last_modified_time: lastModifiedTime,
  };
}

function source(
  records: BitableRecordItem[] | null,
  status: SourceStatus = 'fresh',
) {
  return { records, status };
}

describe('mapEquipmentLifecycleDashboard', () => {
  const syncedAt = '2026-07-18T10:00:00.000Z';
  const equipment = [
    record('eq-1', {
      描述: 'A楼-UPS-未到期',
      设备名称: 'UPS',
      专业: '电气',
      状态: '未到期',
      本次到期日期: '2027-01-15',
      管理员: [{ name: '示例人员008' }],
      楼栋: 'A楼',
      运维服役年限: 5,
      上次更换日期: '2022-01-15',
      预计下次更换日期: '2027-01-15',
    }),
    record('eq-2', {
      描述: 'A楼-UPS-待评估',
      设备名称: 'UPS',
      专业: '电气',
      状态: '待评估',
      本次到期日期: '2027-02-10',
      管理员: [{ name: '示例人员008' }],
      楼栋: 'A楼',
      运维服役年限: [5],
      上次更换日期: '2022-02-10',
      预计下次更换日期: '2027-02-10',
    }),
    record('eq-3', {
      描述: 'B楼-冷水机组-待评估',
      设备名称: '冷水机组',
      专业: '暖通',
      状态: '待评估',
      本次到期日期: '2027-02-20',
      管理员: [{ name: '示例人员013' }],
      楼栋: 'B楼',
      运维服役年限: 10,
      上次更换日期: '2017-02-20',
      预计下次更换日期: '2027-02-20',
    }),
    record('eq-4', {
      描述: 'A楼-状态待补充',
      设备名称: '配电柜',
      专业: '电气',
      状态: '',
      本次到期日期: '2027-03-20',
      管理员: [{ name: '示例人员008' }],
      楼栋: 'A楼',
    }),
  ];
  const longTermMaintenance = [
    record('long-1', {
      描述: 'A楼-UPS电容年度维护',
      维护名称: 'UPS电容维护',
      专业: '电气',
      楼栋: 'A楼',
      示例人员019: [{ name: '王师傅' }],
      上次维护日期: '2025-06-10',
      本次到期日期: '2026-06-10',
      到期倒计时: 326,
      状态: '在保',
      预计下次维护日期: '2027-06-10',
    }),
    record('long-2', { 楼栋: 'A楼', 状态: '到期' }),
    record('long-3', { 楼栋: 'B楼', 状态: '在保' }),
    record('long-4', { 楼栋: '110站', 状态: '在保' }),
    record('long-5', { 楼栋: '#1主变', 状态: '在保' }),
    record('long-6', { 楼栋: '#4主变', 状态: '到期' }),
  ];
  const keyParts = [
    record('part-1', {
      描述: 'A楼-UPS蓄电池',
      关键器件项目: 'UPS蓄电池',
      设备类型: 'UPS',
      专业: '电气',
      楼栋: 'A楼',
      示例人员019: [{ name: '李工' }],
      上次更换时间: '2023-01-01',
      下次更换时间: '2028-01-01',
      状态: '在保',
    }),
    record('part-2', { 楼栋: 'A楼', 状态: '三月预警' }),
    record('part-3', { 楼栋: 'B楼', 状态: '过保' }),
  ];
  const maintenanceContracts = [
    record('contract-1', {
      描述: 'A楼-UPS维保合同',
      楼栋: 'A楼',
      设备名称: 'UPS',
      专业: '电气',
      示例人员019: [{ name: '赵工' }],
      本轮截止日期: '2027-07-01',
      合同当前状态: '在保',
    }),
    record('contract-2', { 楼栋: 'A楼', 合同当前状态: '三月预警' }),
    record('contract-3', { 楼栋: 'B楼', 合同当前状态: '过保' }),
  ];

  test('maps the four real tables into one internally consistent dashboard', () => {
    const dashboard = mapEquipmentLifecycleDashboard(
      {
        equipment: source(equipment),
        longTermMaintenance: source(longTermMaintenance),
        keyParts: source(keyParts),
        maintenanceContracts: source(maintenanceContracts),
      },
      { month: '2026-07', syncedAt },
    );

    expect(dashboard.summary).toEqual({
      equipmentTotal: 4,
      keyPartTotal: 3,
      expiringEquipment: 2,
      expiredContracts: 1,
      maintenanceContracts: 3,
      longTermMaintenance: 4,
    });
    expect(dashboard.maintenanceContractInWarrantyRate).toBe(33.3);
    expect(dashboard.buildingUsage).toEqual([
      {
        building: 'A楼',
        notExpiredRate: 50,
        evaluationRate: 50,
        notExpired: 1,
        evaluation: 1,
      },
      {
        building: 'B楼',
        notExpiredRate: 0,
        evaluationRate: 100,
        notExpired: 0,
        evaluation: 1,
      },
    ]);
    expect(dashboard.longTermMaintenance).toEqual([
      { building: 'A楼', inWarranty: 1, expired: 1 },
      { building: 'B楼', inWarranty: 1, expired: 0 },
      { building: '110站', inWarranty: 1, expired: 0 },
    ]);
    expect(
      dashboard.longTermMaintenance.some(({ building }) =>
        building.includes('主变'),
      ),
    ).toBe(false);
    expect(dashboard.maintenanceContracts).toEqual([
      {
        building: 'A楼',
        inWarranty: 1,
        warning: 1,
        expired: 0,
      },
      {
        building: 'B楼',
        inWarranty: 0,
        warning: 0,
        expired: 1,
      },
    ]);
    expect(dashboard.keyPartWarnings).toEqual([
      {
        building: 'A楼',
        inWarranty: 1,
        warning: 1,
        expired: 0,
      },
      {
        building: 'B楼',
        inWarranty: 0,
        warning: 0,
        expired: 1,
      },
    ]);
    expect(dashboard.expiryHeatmap).toEqual([
      {
        building: 'A楼',
        values: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        building: 'B楼',
        values: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ]);
    expect(dashboard.topDevices).toEqual([
      { id: 'top-1', name: 'UPS', count: 2 },
      { id: 'top-2', name: '冷水机组', count: 1 },
      { id: 'top-3', name: '配电柜', count: 1 },
    ]);
    expect(dashboard.filterOptions).toEqual({
      buildings: ['A楼', 'B楼'],
      specialties: ['暖通', '电气'],
      managers: ['示例人员008', '示例人员013'],
      statuses: ['待评估', '未到期', '未填写'],
    });
    expect(dashboard.assets[0]).toEqual({
      id: 'eq-1',
      description: 'A楼-UPS-未到期',
      building: 'A楼',
      deviceName: 'UPS',
      specialty: '电气',
      manager: '示例人员008',
      managerInitial: '张',
      serviceYears: 5,
      lastReplacementDate: '2022-01-15',
      currentExpiryDate: '2027-01-15',
      status: '未到期',
      nextReplacementDate: '2027-01-15',
    });
    expect(dashboard.relatedRecords.longTermMaintenance[0]).toEqual({
      id: 'long-1',
      description: 'A楼-UPS电容年度维护',
      name: 'UPS电容维护',
      building: 'A楼',
      specialty: '电气',
      owner: '王师傅',
      status: '在保',
      previousDate: '2025-06-10',
      dueDate: '2026-06-10',
      nextDate: '2027-06-10',
      countdownDays: 326,
    });
    expect(dashboard.relatedRecords.longTermMaintenance).toHaveLength(4);
    expect(
      dashboard.relatedRecords.longTermMaintenance.some(({ building }) =>
        building.includes('主变'),
      ),
    ).toBe(false);
    expect(dashboard.relatedRecords.keyParts[0]).toMatchObject({
      id: 'part-1',
      name: 'UPS蓄电池',
      owner: '李工',
      dueDate: '2028-01-01',
    });
    expect(dashboard.relatedRecords.maintenanceContracts[0]).toMatchObject({
      id: 'contract-1',
      name: 'UPS',
      owner: '赵工',
      dueDate: '2027-07-01',
    });
    expect(dashboard.sourceStatus).toBe('fresh');
    expect(dashboard.availableMonths).toEqual(['2026-07']);
    expect(dashboard.sourceUpdatedAt).toBe('2026-07-10T16:00:00.000Z');
    expect(dashboard.sourceTables).toEqual([
      {
        key: 'equipment',
        status: 'fresh',
        recordCount: 4,
        updatedAt: '2026-07-10T16:00:00.000Z',
      },
      {
        key: 'longTermMaintenance',
        status: 'fresh',
        recordCount: 6,
        updatedAt: '2026-07-10T16:00:00.000Z',
      },
      {
        key: 'keyParts',
        status: 'fresh',
        recordCount: 3,
        updatedAt: '2026-07-10T16:00:00.000Z',
      },
      {
        key: 'maintenanceContracts',
        status: 'fresh',
        recordCount: 3,
        updatedAt: '2026-07-10T16:00:00.000Z',
      },
    ]);
    expect(dashboard.assets.at(-1)?.status).toBe('未填写');
    expect(dashboard.warnings).toEqual([
      '1条设备状态未填写，未纳入使用状态比例。',
    ]);
  });

  test('uses null and empty sections when a source has no usable snapshot', () => {
    const dashboard = mapEquipmentLifecycleDashboard(
      {
        equipment: source(null, 'failed'),
        longTermMaintenance: source(longTermMaintenance),
        keyParts: source(keyParts),
        maintenanceContracts: source(maintenanceContracts),
      },
      { month: '2026-07', syncedAt },
    );

    expect(dashboard.summary.equipmentTotal).toBeNull();
    expect(dashboard.summary.expiringEquipment).toBeNull();
    expect(dashboard.buildingUsage).toEqual([]);
    expect(dashboard.expiryHeatmap).toEqual([]);
    expect(dashboard.topDevices).toEqual([]);
    expect(dashboard.assets).toEqual([]);
    expect(dashboard.relatedRecords.longTermMaintenance).toHaveLength(4);
    expect(dashboard.relatedRecords.keyParts).toHaveLength(3);
    expect(dashboard.relatedRecords.maintenanceContracts).toHaveLength(3);
    expect(dashboard.summary.keyPartTotal).toBe(3);
    expect(dashboard.sourceStatus).toBe('partial');
    expect(dashboard.sourceTables[0]).toEqual({
      key: 'equipment',
      status: 'failed',
      recordCount: null,
      updatedAt: null,
    });
  });

  test('does not emit NaN when the mapper receives an empty contract snapshot', () => {
    const dashboard = mapEquipmentLifecycleDashboard(
      {
        equipment: source(equipment),
        longTermMaintenance: source(longTermMaintenance),
        keyParts: source(keyParts),
        maintenanceContracts: source([]),
      },
      { month: '2026-07', syncedAt },
    );

    expect(dashboard.maintenanceContractInWarrantyRate).toBeNull();
    expect(JSON.stringify(dashboard)).not.toContain('NaN');
  });
});
