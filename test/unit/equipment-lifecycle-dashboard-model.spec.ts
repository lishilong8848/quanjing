import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const modelPath = join(
  process.cwd(),
  'client/src/pages/EquipmentLifecycleDashboard/model.ts',
);

function loadModel():
  | typeof import('../../client/src/pages/EquipmentLifecycleDashboard/model')
  | null {
  if (!existsSync(modelPath)) return null;
  return require('../../client/src/pages/EquipmentLifecycleDashboard/model');
}

describe('equipment lifecycle dashboard model', () => {
  it('contains only client-side filtering and pagination, without dashboard fixtures', () => {
    const source = existsSync(modelPath) ? readFileSync(modelPath, 'utf8') : '';

    expect(source).not.toContain('SUMMARY_BY_MONTH');
    expect(source).not.toContain('MAY_BUILDING_USAGE');
    expect(source).not.toContain('ASSET_TEMPLATES');
    expect(source).not.toContain('getEquipmentLifecycleView');
    expect(source).not.toContain('length: 426');
  });

  it('combines dynamic string filters and preserves source rows', () => {
    const model = loadModel();
    expect(model).not.toBeNull();

    const assets = [
      {
        id: 'asset-1',
        description: 'A楼-UPS',
        building: 'A楼',
        deviceName: 'UPS',
        specialty: '电气',
        manager: '示例人员008',
        managerInitial: '张',
        serviceYears: 5,
        lastReplacementDate: '2021-01-01',
        currentExpiryDate: '2026-01-01',
        status: '在保',
        nextReplacementDate: null,
      },
      {
        id: 'asset-2',
        description: 'B楼-冷水机组',
        building: 'B楼',
        deviceName: '冷水机组',
        specialty: '暖通',
        manager: '示例人员013',
        managerInitial: '李',
        serviceYears: null,
        lastReplacementDate: null,
        currentExpiryDate: null,
        status: '需评估',
        nextReplacementDate: null,
      },
    ];

    const filtered = model!.filterLifecycleAssets(assets, {
      building: 'A楼',
      specialty: '电气',
      manager: '示例人员008',
      status: '在保',
    });

    expect(filtered).toEqual([assets[0]]);
    expect(filtered[0]).not.toBe(assets[0]);
    filtered[0].description = 'mutated';
    expect(assets[0].description).toBe('A楼-UPS');
  });

  it('prefers server filter options and derives a deterministic fallback', () => {
    const model = loadModel();
    expect(model).not.toBeNull();

    const assets = [
      {
        id: 'asset-1',
        description: 'B楼-UPS',
        building: 'B楼',
        deviceName: 'UPS',
        specialty: '电气',
        manager: '示例人员008',
        managerInitial: '张',
        serviceYears: 5,
        lastReplacementDate: null,
        currentExpiryDate: null,
        status: '在保',
        nextReplacementDate: null,
      },
      {
        id: 'asset-2',
        description: 'A楼-冷水机组',
        building: 'A楼',
        deviceName: '冷水机组',
        specialty: '暖通',
        manager: '示例人员013',
        managerInitial: '李',
        serviceYears: null,
        lastReplacementDate: null,
        currentExpiryDate: null,
        status: '需评估',
        nextReplacementDate: null,
      },
    ];
    const serverOptions = {
      buildings: ['E楼', 'A楼'],
      specialties: ['EHS'],
      managers: ['示例人员017'],
      statuses: ['在采'],
    };

    expect(model!.getLifecycleFilterOptions(assets, serverOptions)).toEqual(
      serverOptions,
    );
    expect(model!.getLifecycleFilterOptions(assets)).toEqual({
      buildings: ['A楼', 'B楼'],
      specialties: ['暖通', '电气'],
      managers: ['示例人员008', '示例人员013'],
      statuses: ['在保', '需评估'],
    });
  });

  it('clamps pagination boundaries, including an empty result', () => {
    const model = loadModel();
    expect(model).not.toBeNull();

    const assets = Array.from({ length: 23 }, (_, index) => ({
      id: `asset-${index}`,
    })) as any;

    expect(model!.paginateLifecycleAssets(assets, 99, 10)).toMatchObject({
      page: 3,
      pageSize: 10,
      total: 23,
      totalPages: 3,
      items: expect.any(Array),
    });
    expect(model!.paginateLifecycleAssets([], 3, 0)).toEqual({
      items: [],
      page: 1,
      pageSize: 1,
      total: 0,
      totalPages: 1,
    });
  });

  it('counts every asset per building without reusing usage-ring categories', () => {
    const model = loadModel();
    expect(model).not.toBeNull();

    const assets = [
      { id: 'a-1', building: 'A楼', status: '未到期' },
      { id: 'a-2', building: 'A楼', status: '状态未填写' },
      { id: 'b-1', building: 'B楼', status: '需评估' },
      { id: 'c-1', building: 'C楼', status: '已到期' },
    ] as any;

    expect(
      model!.getAssetCountsByBuilding(assets, ['A楼', 'B楼', 'C楼']),
    ).toEqual([2, 1, 1]);
    expect(
      model!.getAssetCountsByBuilding(assets, ['B楼', 'A楼', 'D楼']),
    ).toEqual([1, 2, 0]);
  });

  it('formats source timestamps for the Chinese dashboard and preserves invalid text', () => {
    const model = loadModel();
    expect(model).not.toBeNull();

    expect(model!.formatUpdatedAt('2026-07-18T01:05:00.000Z')).toBe(
      '2026-07-18 09:05',
    );
    expect(model!.formatUpdatedAt('2026-07-18 09:05')).toBe('2026-07-18 09:05');
    expect(model!.formatUpdatedAt('not-a-date')).toBe('not-a-date');
    expect(model!.formatUpdatedAt(null)).toBe('—');
  });

  it('builds drilldown rows from metrics, chart segments, heatmap cells and TOP5 labels', () => {
    const model = loadModel() as any;
    expect(typeof model?.buildLifecycleDrilldown).toBe('function');

    const view = {
      assets: [
        {
          id: 'eq-1',
          description: 'A楼-UPS-未到期',
          building: 'A楼',
          deviceName: 'UPS',
          specialty: '电气',
          manager: '示例人员008',
          status: '未到期',
          currentExpiryDate: '2027-01-15',
        },
        {
          id: 'eq-2',
          description: 'A楼-UPS-待评估',
          building: 'A楼',
          deviceName: 'UPS',
          specialty: '电气',
          manager: '示例人员013',
          status: '待评估',
          currentExpiryDate: '2027-02-10',
        },
        {
          id: 'eq-3',
          description: 'B楼-冷水机组-状态待补充',
          building: 'B楼',
          deviceName: '冷水机组',
          specialty: '暖通',
          manager: '示例人员017',
          status: '未填写',
          currentExpiryDate: '2027-02-20',
        },
      ],
      relatedRecords: {
        longTermMaintenance: [
          {
            id: 'long-1',
            name: 'UPS电容维护',
            description: 'A楼-UPS电容维护',
            building: 'A楼',
            specialty: '电气',
            owner: '王师傅',
            status: '到期',
            dueDate: '2026-06-10',
          },
        ],
        keyParts: [
          {
            id: 'part-1',
            name: 'UPS蓄电池',
            description: 'A楼-UPS蓄电池',
            building: 'A楼',
            specialty: '电气',
            owner: '李工',
            status: '三月预警',
            dueDate: '2027-09-01',
          },
        ],
        maintenanceContracts: [
          {
            id: 'contract-1',
            name: 'UPS',
            description: 'A楼-UPS维保合同',
            building: 'A楼',
            specialty: '电气',
            owner: '赵工',
            status: '过保',
            dueDate: '2026-01-01',
          },
        ],
      },
    };

    const expiring = model.buildLifecycleDrilldown(view, {
      source: 'equipment',
      title: '设备到期数',
      status: '待评估',
    });
    expect(expiring.rows.map(({ id }: any) => id)).toEqual(['eq-2']);

    const longTermTotal = model.buildLifecycleDrilldown(view, {
      source: 'longTermMaintenance',
      title: '长期维护总数',
    });
    expect(longTermTotal.rows.map(({ id }: any) => id)).toEqual(['long-1']);

    const longTermSegment = model.buildLifecycleDrilldown(view, {
      source: 'longTermMaintenance',
      title: 'A楼长期维护到期项',
      building: 'A楼',
      status: '到期',
    });
    expect(longTermSegment.rows.map(({ id }: any) => id)).toEqual(['long-1']);

    const heatmap = model.buildLifecycleDrilldown(view, {
      source: 'equipment',
      title: '二月到期设备',
      building: 'B楼',
      expiryMonth: 2,
    });
    expect(heatmap.rows.map(({ id }: any) => id)).toEqual(['eq-3']);

    const topDevice = model.buildLifecycleDrilldown(view, {
      source: 'equipment',
      title: 'UPS设备',
      deviceName: 'UPS',
    });
    expect(topDevice.rows.map(({ id }: any) => id)).toEqual(['eq-1', 'eq-2']);
    expect(topDevice.rows[0]).toMatchObject({
      source: 'equipment',
      name: 'UPS',
      owner: '示例人员008',
      dueDate: '2027-01-15',
    });
  });
});
