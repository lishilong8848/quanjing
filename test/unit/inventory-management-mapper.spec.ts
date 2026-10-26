jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'app',
      app_secret: 'secret',
    })),
  }),
  { virtual: true },
);

import type {
  InventoryManagementSourceStatus,
  InventoryMovementCollection,
  InventoryMovementItem,
  InventoryOutboundMovementItem,
  InventorySourceKey,
} from '../../shared/inventory-management.interface';
import {
  buildInventoryManagementSnapshot,
  queryInventoryItems,
  queryInventoryMovements,
} from '../../server/modules/inventory-management/inventory-management.mapper';

const record = (recordId: string, fields: Record<string, unknown>) => ({
  record_id: recordId,
  fields,
});

const expectType = <Expected>(_value: Expected): void => undefined;

const movement = (
  overrides: Partial<InventoryMovementItem>,
): InventoryMovementItem => ({
  recordId: 'movement-1',
  type: 'inbound',
  sku: 'A1001',
  name: '应急电源',
  specification: 'UPS-1KVA',
  quantity: 1,
  unit: '台',
  building: 'D楼',
  destinationBuilding: '',
  location: 'D-01',
  reason: '',
  operator: '示例人员006',
  applicant: '示例人员020',
  status: '已入库',
  occurredAt: '2026-07-01T01:00:00.000Z',
  expectedReturnAt: null,
  overdue: false,
  ...overrides,
});

const outboundMovement = (
  overrides: Partial<InventoryOutboundMovementItem> = {},
): InventoryOutboundMovementItem => ({
  ...movement(overrides),
  type: 'outbound',
  status: '待库房确认',
  ...overrides,
});

const sectionStatus = Object.fromEntries(
  (
    [
      'inventory',
      'inbound',
      'outbound',
      'borrow',
      'catalog',
      'prices',
      'stocktake',
      'managers',
    ] satisfies InventorySourceKey[]
  ).map((key) => [
    key,
    { configured: true, count: 1 } satisfies InventoryManagementSourceStatus,
  ]),
) as Record<InventorySourceKey, InventoryManagementSourceStatus>;

describe('inventory management mapper', () => {
  it('retains month history across Shanghai year boundaries and selects the latest building snapshot', () => {
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-10-01T00:00:00Z',
      sourceUrl: '',
      inventory: [],
      catalog: [],
      inbound: [],
      outbound: [],
      borrow: [],
      prices: [],
      managers: [],
      sectionStatus,
      now: new Date('2026-10-01T00:00:00Z'),
      stocktakeSummaries: [
        record('dec', {
          楼栋: 'A楼',
          日期: '2025-12-01T00:00:00+08:00',
          盘点月份: 12,
          盘点总数: 10,
          已盘点数量: 10,
        }),
        record('jan-old', {
          楼栋: 'A楼',
          日期: '2026-01-01T00:00:00+08:00',
          盘点月份: 1,
          盘点总数: 12,
          已盘点数量: 1,
        }),
        record('jan-new', {
          楼栋: 'A楼',
          日期: '2026-01-02T00:00:00+08:00',
          盘点月份: 1,
          盘点总数: 12,
          已盘点数量: 9,
        }),
        record('future', {
          楼栋: 'A楼',
          日期: '2026-11-01T00:00:00+08:00',
          盘点月份: 11,
          盘点总数: 99,
          已盘点数量: 99,
        }),
      ],
    });
    expect(Reflect.get(snapshot.dashboard, 'stocktakeHistory')).toMatchObject([
      { year: 2026, month: 1, total: 12, completed: 9 },
      { year: 2025, month: 12, total: 10, completed: 10 },
    ]);
  });
  it('uses the warehouse Base fields for inventory risks, movements, and stocktake', () => {
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-07-10T06:00:00.000Z',
      sourceUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      inventory: [
        record('inv-1', {
          物品类别号: 'A1001',
          名称: ['opt-name'],
          '规格型号、设备序列号': ['opt-specification'],
          楼栋: ['D楼'],
          剩余库存: '-1',
          最小库存量: '1',
          剩余库存是否满足最小库存量: '-2',
          是否达到最小库存: '库存不足',
          年度使用频次: '0',
          现存物品价格: '120',
          存放位置: ['D-1F-112值班室00-0F'],
          入库存放位置: 'D-程序入库位置',
          负责人: '赵震兴 陶必亮',
          一级分类: ['opt-primary-category'],
          二级分类: ['opt-secondary-category'],
          计数单位: ['opt-unit'],
        }),
      ],
      catalog: [
        record('catalog-1', {
          物品类别号: 'A1001',
          名称: ['保险管'],
          '规格型号、设备序列号': ['FWH-450A 500V'],
          楼栋: ['D楼'],
          一级分类: ['A备品备件类'],
          二级分类: ['应急件A1'],
          最小库存量: 1,
          物品单价: 120,
          计数单位: ['个'],
          品牌: ['台达'],
        }),
      ],
      inbound: [
        record('in-1', {
          物品类别号: 'A1001',
          名称: ['opt-name'],
          入库数量: 3,
          入库日期: '2026-07-10 09:00:00',
          楼栋: ['D楼'],
          存放位置: ['opt-location'],
          示例人员019: '赵震兴',
        }),
      ],
      outbound: [
        record('out-1', {
          物品类别号: [{ id: 'catalog-1' }],
          '物品类别号（单选）': ['opt-sku'],
          名称: ['opt-name'],
          出库数量: 1,
          出库时间: '2026-07-10 10:00:00',
          楼栋: ['D楼'],
          存放位置: ['opt-location'],
          '楼栋（东西去到的楼栋）': ['B楼'],
          '出库原因/出库后使用地点': 'B楼更换',
          经办人: '赵震兴',
        }),
      ],
      borrow: [
        record('borrow-1', {
          物品类别号: [{ id: 'catalog-1' }],
          '物品类别号（单选）': ['opt-sku'],
          名称: ['opt-name'],
          借调数量: 2,
          借调时间: '2026-07-09 10:00:00',
          预期归还时间: '2026-07-09 18:00:00',
          借出楼栋: ['D楼'],
          借调原因: 'B楼临时使用',
          物品状态: ['未归还'],
        }),
      ],
      prices: [],
      stocktakeSummaries: [
        record('stocktake-1', {
          盘点月份: 7,
          楼栋: ['D楼'],
          盘点总数: '10',
          已盘点数量: '8',
          日期: '2026-07-01 01:00:00',
          示例人员019: '赵震兴 陶必亮',
        }),
        record('stocktake-old', {
          盘点月份: 6,
          楼栋: ['D楼'],
          盘点总数: '9',
          已盘点数量: '9',
          日期: '2026-06-01 01:00:00',
        }),
      ],
      managers: [
        record('manager-a', {
          楼栋: 'A楼',
          库房示例人员019员: [
            { id: 'ou_responsible_1', name: '示例人员019甲' },
            { id: 'ou_responsible_1', name: '示例人员019甲' },
            { id: 'ou_responsible_2', name: '示例人员019乙' },
          ],
          库房管理人: [{ id: 'ou_manager', name: '管理人不得展示' }],
          '类别号管理人员（负责人最好为1人）': [
            { id: 'ou_category', name: '类别人员不得展示' },
          ],
        }),
      ],
      sectionStatus,
      now: new Date('2026-07-10T06:00:00.000Z'),
    });

    expect(snapshot.dashboard.summary).toMatchObject({
      inventoryLines: 1,
      distinctSkus: 1,
      totalQuantity: -1,
      inventoryValue: 120,
      lowStockItems: 1,
      negativeStockItems: 1,
      idleItems: 1,
    });
    expect(snapshot.dashboard.buildings).toHaveLength(7);
    expect(snapshot.items[0]).toMatchObject({
      name: '保险管',
      specification: 'FWH-450A 500V',
      brand: '台达',
      primaryCategory: 'A备品备件类',
      secondaryCategory: '应急件A1',
      location: 'D-程序入库位置',
      unit: '个',
    });
    expect(
      snapshot.dashboard.buildings.find((item) => item.building === 'D楼'),
    ).toMatchObject({
      inventoryLines: 1,
      lowStockItems: 1,
      negativeStockItems: 1,
    });
    expect(snapshot.dashboard.stocktake).toMatchObject({
      year: 2026,
      month: 7,
      total: 10,
      completed: 8,
      completionRate: 80,
    });
    expect(
      snapshot.dashboard.stocktake.buildings.find(
        (item) => item.building === 'A楼',
      ),
    ).toMatchObject({ responsible: '示例人员019甲、示例人员019乙' });
    expect(snapshot.dashboard.movements.inbound[0]).toMatchObject({
      type: 'inbound',
      sku: 'A1001',
      name: '保险管',
      building: 'D楼',
      location: 'D-程序入库位置',
      quantity: 3,
      operator: '赵震兴',
    });
    expect(snapshot.dashboard.movements.outbound[0]).toMatchObject({
      type: 'outbound',
      name: '保险管',
      destinationBuilding: '',
      location: 'D-程序入库位置',
      reason: 'B楼更换',
      occurredAt: '2026-07-10T02:00:00.000Z',
      status: '已出库',
    });
    expect(snapshot.dashboard.movements.borrow[0]).toMatchObject({
      type: 'borrow',
      sku: 'A1001',
      name: '保险管',
      status: '未归还',
      overdue: true,
    });
  });

  it('prefers the configured formal location over transitional and legacy fields', () => {
    const envName = 'FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME';
    const original = process.env[envName];
    process.env[envName] = '迁移后存放位置';

    try {
      const snapshot = buildInventoryManagementSnapshot({
        generatedAt: '2026-08-25T01:00:00.000Z',
        sourceUrl: '',
        inventory: [
          record('inventory-shadow', {
            物品类别号: 'A1001',
            楼栋: 'A楼',
            入库存放位置: 'A-SHADOW',
            迁移后存放位置: 'A-NEW',
            存放位置: 'A-LEGACY',
          }),
          record('inventory-configured', {
            物品类别号: 'A1002',
            楼栋: 'A楼',
            迁移后存放位置: 'A-CONFIGURED',
            存放位置: 'A-LEGACY-2',
          }),
          record('inventory-legacy', {
            物品类别号: 'A1003',
            楼栋: 'A楼',
            存放位置: 'A-FALLBACK',
          }),
        ],
        catalog: [],
        inbound: [],
        outbound: [],
        borrow: [],
        prices: [],
        stocktakeSummaries: [],
        managers: [],
        sectionStatus,
      });

      expect(
        snapshot.items.map(({ sku, location }) => ({ sku, location })),
      ).toEqual([
        { sku: 'A1001', location: 'A-NEW' },
        { sku: 'A1002', location: 'A-CONFIGURED' },
        { sku: 'A1003', location: 'A-FALLBACK' },
      ]);
    } finally {
      if (original === undefined) delete process.env[envName];
      else process.env[envName] = original;
    }
  });

  it('normalizes new and legacy outbound records to the two confirmation states', () => {
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-08-11T06:00:00.000Z',
      sourceUrl: '',
      inventory: [],
      catalog: [],
      inbound: [],
      outbound: [
        record('out-new-pending', {
          物品类别号: 'A1001',
          名称: '待确认滤芯',
          楼栋: 'A楼',
          程序出库状态: '待库房确认',
          出库工作流状态: '已通过',
          程序出库申请数量: 2,
          程序出库申请时间: '2026-08-11T01:02:03.000Z',
          出库数量: 99,
          出库时间: '2026-08-11 12:00:00',
          出库创建标识: 'outbound-create-pending',
          '楼栋（东西去到的楼栋）': 'B楼',
        }),
        record('out-new-completed', {
          物品类别号: 'A1002',
          名称: '已出库滤芯',
          楼栋: 'A楼',
          程序出库状态: '已出库',
          出库工作流状态: '已通过',
          程序出库申请数量: 7,
          程序出库申请时间: '2026-08-10T01:02:03.000Z',
          出库数量: 3,
          出库时间: '2026-08-11 12:30:00',
          出库创建标识: 'outbound-create-completed',
          '楼栋（东西去到的楼栋）': 'C楼',
        }),
        record('out-legacy-cross-building', {
          物品类别号: 'A1003',
          名称: '旧跨楼待确认',
          楼栋: 'A楼',
          出库数量: 4,
          出库时间: '2026-08-11 11:00:00',
          是否借出本楼栋: '是',
          '楼栋（东西去到的楼栋）': 'D楼',
        }),
        record('out-legacy-completed', {
          物品类别号: 'A1004',
          名称: '旧普通出库',
          楼栋: 'A楼',
          出库数量: 5,
          出库时间: '2026-08-11 10:00:00',
          是否借出本楼栋: '否',
          '楼栋（东西去到的楼栋）': 'E楼',
        }),
        record('out-invalid-program-status', {
          物品类别号: 'A1005',
          名称: '异常状态旧单',
          楼栋: 'A楼',
          程序出库状态: ' 已出库 ',
          出库数量: 6,
          出库时间: '2026-08-11 09:00:00',
          是否借出本楼栋: '否',
          '楼栋（东西去到的楼栋）': 'H楼',
        }),
        record('out-program-partial-zero', {
          物品类别号: 'A1006',
          名称: '程序字段部分写入',
          楼栋: 'A楼',
          程序出库申请数量: 0,
          出库请求指纹: 'partial-fingerprint',
          出库数量: 88,
          出库时间: '2026-08-11 08:00:00',
          是否借出本楼栋: '否',
        }),
        record('out-program-completed-without-formal-fields', {
          物品类别号: 'A1007',
          名称: '已完成但正式字段缺失',
          楼栋: 'A楼',
          程序出库状态: '已出库',
          出库工作流状态: '已通过',
          程序出库申请数量: 9,
          程序出库申请时间: '2026-08-11T00:00:00.000Z',
          出库确认标识: 'confirm-without-formal',
        }),
      ],
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus,
      now: new Date('2026-08-11T06:00:00.000Z'),
    });
    expectType<InventoryOutboundMovementItem[]>(snapshot.movements.outbound);

    const outboundById = Object.fromEntries(
      snapshot.movements.outbound.map((item) => [item.recordId, item]),
    );

    expect(outboundById['out-new-pending']).toMatchObject({
      status: '待库房确认',
      quantity: 2,
      occurredAt: '2026-08-11T01:02:03.000Z',
      destinationBuilding: '',
      clientMutationId: 'outbound-create-pending',
    });
    expect(outboundById['out-new-completed']).toMatchObject({
      status: '已出库',
      quantity: 3,
      occurredAt: '2026-08-11T04:30:00.000Z',
      destinationBuilding: '',
      clientMutationId: 'outbound-create-completed',
    });
    expect(outboundById['out-legacy-cross-building']).toMatchObject({
      status: '待库房确认',
      quantity: 4,
      destinationBuilding: '',
    });
    expect(outboundById['out-legacy-completed']).toMatchObject({
      status: '已出库',
      quantity: 5,
      destinationBuilding: '',
    });
    expect(outboundById['out-invalid-program-status']).toMatchObject({
      status: '待路由',
      quantity: 0,
      occurredAt: null,
      destinationBuilding: '',
    });
    expect(outboundById['out-program-partial-zero']).toMatchObject({
      status: '待路由',
      quantity: 0,
      occurredAt: null,
    });
    expect(
      outboundById['out-program-completed-without-formal-fields'],
    ).toMatchObject({
      status: '已出库',
      quantity: 0,
      occurredAt: null,
    });

    const allOutbound = queryInventoryMovements(snapshot.movements, {
      type: 'outbound',
      status: 'all',
    });
    expect(allOutbound.summary.statusCounts).toHaveLength(3);
    expect(allOutbound.summary.statusCounts).toEqual(
      expect.arrayContaining([
        { status: '待路由', count: 2 },
        { status: '待库房确认', count: 2 },
        { status: '已出库', count: 3 },
      ]),
    );
    expect(
      queryInventoryMovements(snapshot.movements, {
        type: 'outbound',
        status: '待库房确认',
      }),
    ).toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ recordId: 'out-new-pending' }),
        expect.objectContaining({ recordId: 'out-legacy-cross-building' }),
      ]),
    });
  });

  it('maps all outbound approval states and keeps rejection reason separate from the business reason', () => {
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-08-26T06:00:00.000Z',
      sourceUrl: '',
      inventory: [],
      catalog: [],
      inbound: [],
      outbound: [
        ['routing', '待路由', '待路由', ''],
        ['approval-routing', '待审批', '待路由', ''],
        ['approval', '待审批', '待审批', ''],
        ['warehouse', '待库房确认', '已通过', ''],
        ['rejected', '已驳回', '已驳回', '库存用途不符合要求'],
        ['completed', '已出库', '已通过', ''],
      ].map(([id, programStatus, workflowStatus, rejectionReason], index) =>
        record(`out-${id}`, {
          物品类别号: `A10${index}`,
          名称: id,
          楼栋: 'A楼',
          程序出库状态: programStatus,
          出库工作流状态: workflowStatus,
          程序出库申请数量: index + 1,
          程序出库申请时间: '2026-08-26T01:02:03.000Z',
          ...(programStatus === '已出库'
            ? {
                出库数量: index + 1,
                出库时间: '2026-08-26T02:03:04.000Z',
              }
            : {}),
          '出库原因/出库后使用地点': '现场领用',
          出库驳回原因: rejectionReason,
          出库创建标识: `mutation-${id}`,
        }),
      ),
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus,
    });

    expect(
      snapshot.movements.outbound.map(
        ({ recordId, status, quantity, reason, approvalRejectionReason }) => ({
          recordId,
          status,
          quantity,
          reason,
          approvalRejectionReason,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: 'out-routing', status: '待路由' }),
        expect.objectContaining({
          recordId: 'out-approval-routing',
          status: '待审批',
        }),
        expect.objectContaining({ recordId: 'out-approval', status: '待审批' }),
        expect.objectContaining({
          recordId: 'out-warehouse',
          status: '待库房确认',
        }),
        expect.objectContaining({
          recordId: 'out-rejected',
          status: '已驳回',
          reason: '现场领用',
          approvalRejectionReason: '库存用途不符合要求',
        }),
        expect.objectContaining({
          recordId: 'out-completed',
          status: '已出库',
        }),
      ]),
    );
  });

  it('shows current approvers on a pending outbound before a final operator exists', () => {
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-09-24T14:22:00.000Z',
      sourceUrl: '',
      inventory: [],
      catalog: [],
      inbound: [],
      outbound: [
        record('out-h-pending', {
          物品类别号: 'D2043',
          名称: '便条纸',
          楼栋: 'H楼',
          程序出库状态: '待审批',
          出库工作流状态: '待审批',
          程序出库申请数量: 1,
          程序出库申请时间: '2026-09-24T14:22:00.000Z',
          出库创建标识: 'outbound-h-pending',
          出库当前审批人: [
            { id: 'ou_h_approver_1', name: '刘小杏' },
            { id: 'ou_h_approver_2', name: '示例人员011' },
          ],
        }),
      ],
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus,
    });

    expect(snapshot.movements.outbound[0].operator).toBe('刘小杏、示例人员011');
  });

  it('fails closed when program and approval workflow states are partial, invalid, or conflicting', () => {
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-08-26T06:00:00.000Z',
      sourceUrl: '',
      inventory: [],
      catalog: [],
      inbound: [],
      outbound: [
        record('out-missing-program-status', {
          物品类别号: 'A1101',
          名称: '程序状态缺失',
          楼栋: 'A楼',
          出库工作流状态: '待审批',
          是否借出本楼栋: '是',
        }),
        record('out-invalid-program-status', {
          物品类别号: 'A1102',
          名称: '程序状态非法',
          楼栋: 'A楼',
          程序出库状态: '处理中',
          出库工作流状态: '待审批',
        }),
        record('out-missing-workflow-status', {
          物品类别号: 'A1103',
          名称: '工作流状态缺失',
          楼栋: 'A楼',
          程序出库状态: '待库房确认',
        }),
        record('out-invalid-workflow-status', {
          物品类别号: 'A1104',
          名称: '工作流状态非法',
          楼栋: 'A楼',
          程序出库状态: '待库房确认',
          出库工作流状态: '未知状态',
        }),
        record('out-conflicting-workflow-status', {
          物品类别号: 'A1105',
          名称: '工作流状态冲突',
          楼栋: 'A楼',
          程序出库状态: '待库房确认',
          出库工作流状态: '待审批',
        }),
      ],
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus,
    });

    expect(
      snapshot.movements.outbound.map(({ recordId, status }) => ({
        recordId,
        status,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          recordId: 'out-missing-program-status',
          status: '待路由',
        },
        {
          recordId: 'out-invalid-program-status',
          status: '待路由',
        },
        {
          recordId: 'out-missing-workflow-status',
          status: '待路由',
        },
        {
          recordId: 'out-invalid-workflow-status',
          status: '待路由',
        },
        {
          recordId: 'out-conflicting-workflow-status',
          status: '待路由',
        },
      ]),
    );
  });

  it('accepts exact Feishu select wrappers but fails closed on ambiguous wrapper values', () => {
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-08-26T06:00:00.000Z',
      sourceUrl: '',
      inventory: [],
      catalog: [],
      inbound: [],
      outbound: [
        record('out-wrapped-approved', {
          物品类别号: 'A1201',
          名称: '包装值已通过',
          楼栋: 'A楼',
          程序出库状态: { select: { name: '待库房确认' } },
          出库工作流状态: [{ text: '已通过' }],
          程序出库申请数量: 1,
          程序出库申请时间: '2026-08-26T01:02:03.000Z',
        }),
        record('out-ambiguous-program-wrapper', {
          物品类别号: 'A1202',
          名称: '包装值冲突',
          楼栋: 'A楼',
          程序出库状态: {
            text: '待库房确认',
            value: '已出库',
          },
          出库工作流状态: { select: { name: '已通过' } },
        }),
      ],
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus,
    });
    const outboundById = Object.fromEntries(
      snapshot.movements.outbound.map((item) => [item.recordId, item]),
    );

    expect(outboundById['out-wrapped-approved']).toMatchObject({
      status: '待库房确认',
      quantity: 1,
    });
    expect(outboundById['out-ambiguous-program-wrapper']).toMatchObject({
      status: '待路由',
    });
  });

  it('parses movement dates only from explicit ISO, numeric timestamps, or Shanghai local text', () => {
    const timestamp = Date.parse('2026-08-11T03:04:05.000Z');
    const snapshot = buildInventoryManagementSnapshot({
      generatedAt: '2026-08-11T06:00:00.000Z',
      sourceUrl: '',
      inventory: [],
      catalog: [],
      inbound: [
        record('date-iso-offset', {
          物品类别号: 'D1001',
          楼栋: 'D楼',
          入库数量: 1,
          入库日期: '2026-08-11T09:30:45.123+08:00',
        }),
        record('date-timestamp-number', {
          物品类别号: 'D1002',
          楼栋: 'D楼',
          入库数量: 1,
          入库日期: timestamp,
        }),
        record('date-timestamp-text', {
          物品类别号: 'D1003',
          楼栋: 'D楼',
          入库数量: 1,
          入库日期: String(timestamp),
        }),
        record('date-shanghai-minute', {
          物品类别号: 'D1004',
          楼栋: 'D楼',
          入库数量: 1,
          入库日期: '2026-08-11 09:30',
        }),
        record('date-shanghai-millisecond', {
          物品类别号: 'D1005',
          楼栋: 'D楼',
          入库数量: 1,
          入库日期: '2026-08-11 09:30:45.123',
        }),
        record('date-missing-timezone', {
          物品类别号: 'D1006',
          楼栋: 'D楼',
          入库数量: 1,
          入库日期: '2026-08-11T09:30:45',
        }),
        record('date-invalid-calendar', {
          物品类别号: 'D1007',
          楼栋: 'D楼',
          入库数量: 1,
          入库日期: '2026-02-30 09:00:00',
        }),
      ],
      outbound: [],
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus,
    });
    const inboundById = Object.fromEntries(
      snapshot.movements.inbound.map((item) => [item.recordId, item]),
    );

    expect(inboundById['date-iso-offset'].occurredAt).toBe(
      '2026-08-11T01:30:45.123Z',
    );
    expect(inboundById['date-timestamp-number'].occurredAt).toBe(
      '2026-08-11T03:04:05.000Z',
    );
    expect(inboundById['date-timestamp-text'].occurredAt).toBe(
      '2026-08-11T03:04:05.000Z',
    );
    expect(inboundById['date-shanghai-minute'].occurredAt).toBe(
      '2026-08-11T01:30:00.000Z',
    );
    expect(inboundById['date-shanghai-millisecond'].occurredAt).toBe(
      '2026-08-11T01:30:45.123Z',
    );
    expect(inboundById['date-missing-timezone'].occurredAt).toBeNull();
    expect(inboundById['date-invalid-calendar'].occurredAt).toBeNull();
  });

  it('filters, scopes category metadata, sorts, and paginates normalized inventory items', () => {
    const items = [
      {
        recordId: '1',
        sku: 'A1001',
        name: '保险管',
        specification: 'FWH',
        brand: '台达',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '应急件A1',
        building: 'D楼' as const,
        location: 'D-01',
        storageType: '库内',
        quantity: -1,
        minimumQuantity: 1,
        difference: -2,
        unit: '个',
        annualUsage: 0,
        value: 120,
        owners: ['赵震兴'],
        lowStock: true,
        negativeStock: true,
        idle: true,
        pendingConfirmation: false,
      },
      {
        recordId: '2',
        sku: 'B2001',
        name: '强光手电',
        specification: 'GT18',
        brand: '神火',
        primaryCategory: 'B工具类',
        secondaryCategory: '日常工具B2',
        building: 'A楼' as const,
        location: 'A-01',
        storageType: '库内',
        quantity: 4,
        minimumQuantity: 1,
        difference: 3,
        unit: '个',
        annualUsage: 4,
        value: 300,
        owners: ['卢俊钳'],
        lowStock: false,
        negativeStock: false,
        idle: false,
        pendingConfirmation: false,
      },
    ];

    expect(
      queryInventoryItems(items, {
        page: 1,
        pageSize: 20,
        search: '赵震兴',
        building: 'D楼',
        risk: 'negative',
        sort: 'risk',
      }),
    ).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      items: [expect.objectContaining({ sku: 'A1001' })],
    });

    expect(
      queryInventoryItems(items, {
        page: 9,
        pageSize: 500,
        category: 'B工具类',
        sort: 'valueDesc',
      }),
    ).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      items: [expect.objectContaining({ sku: 'B2001' })],
    });

    expect(
      queryInventoryItems(
        [
          ...items,
          { ...items[1], recordId: '3' },
          { ...items[0], recordId: '4', primaryCategory: '   ' },
        ],
        {
          building: 'D楼',
        },
      ),
    ).toMatchObject({
      categories: ['A备品备件类'],
    });
  });

  it('filters, summarizes, sorts, and paginates complete movement records', () => {
    const movements = {
      inbound: [movement({ recordId: 'inbound-1' })],
      outbound: [
        outboundMovement({
          recordId: 'outbound-1',
          type: 'outbound',
          building: 'A楼',
          status: '已出库',
        }),
      ],
      borrow: [
        movement({
          recordId: 'borrow-old',
          type: 'borrow',
          quantity: 2,
          status: '未归还',
          occurredAt: '2026-07-01T01:00:00.000Z',
          expectedReturnAt: '2026-07-02T01:00:00.000Z',
          overdue: true,
        }),
        movement({
          recordId: 'borrow-new',
          type: 'borrow',
          quantity: 1,
          status: '已归还',
          occurredAt: '2026-07-03T01:00:00.000Z',
          expectedReturnAt: '2026-07-04T01:00:00.000Z',
        }),
      ],
    } satisfies InventoryMovementCollection;

    expect(
      queryInventoryMovements(movements, {
        type: 'borrow',
        page: 1,
        pageSize: 1,
        search: '应急',
        building: 'D楼',
        status: 'all',
      }),
    ).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1,
      totalPages: 2,
      items: [expect.objectContaining({ recordId: 'borrow-new' })],
      summary: {
        totalRecords: 2,
        totalQuantity: 3,
        overdueItems: 1,
        statusCounts: [
          { status: '未归还', count: 1 },
          { status: '已归还', count: 1 },
        ],
      },
    });

    expect(
      queryInventoryMovements(movements, {
        type: 'borrow',
        status: '未归还',
      }),
    ).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ recordId: 'borrow-old' })],
    });
  });
});
