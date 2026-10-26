import type {
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
} from '../../shared/purchase-inventory.interface';
import type {
  PurchaseApplicationBatchRequest,
  PurchaseApplicationSubmitResponse,
} from '../../shared/purchase-application.interface';
import * as purchaseLogic from '../../client/src/pages/PurchaseInventoryManagement/logic';
import {
  buildPurchaseAnomalies,
  filterProcurementItems,
  filterPurchaseApplicationItems,
  filterPurchaseExecutionItems,
  filterPurchaseInboundItems,
  groupPurchaseOrderItems,
  prunePurchaseSelection,
  removeDeletedPurchaseRequests,
  toggleVisiblePurchaseSelection,
} from '../../client/src/pages/PurchaseInventoryManagement/logic';

function request(
  overrides: Partial<PurchaseInventoryRequestItem>,
): PurchaseInventoryRequestItem {
  return {
    recordId: 'record-1',
    submissionRecordId: 'submission-1',
    executionRecordId: null,
    requestCode: 'PR-001',
    title: '默认物品',
    requester: '申请人',
    purchaser: '',
    building: 'A楼',
    specialty: '电气',
    primaryCategory: '设备',
    secondaryCategory: '备件',
    stage: 'application',
    statusLabel: '待提交',
    purchaseMethod: '',
    procurementForm: '三方比价',
    singleReason: '',
    approvalTarget: '',
    supplier: '',
    estimatedAmount: 100,
    actualAmount: null,
    quantity: 1,
    actualQuantity: null,
    unit: '项',
    priority: '未设置',
    createdAt: '2026-07-10T02:00:00.000Z',
    expectedArrival: null,
    orderedAt: null,
    receivedAt: null,
    warehouseRequired: true,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    inventorySku: '',
    notes: '',
    ...overrides,
  };
}

function applicationBatch(): PurchaseApplicationBatchRequest {
  return {
    shared: {
      applicantRecordId: 'applicant-1',
      applicantOpenId: 'ou_applicant_1',
      applicantName: '张申请',
      applicantEmployeeNo: 'NT-001',
      applicantPosition: '工程师',
      applicantBuilding: 'A楼',
      building: 'A楼',
      specialty: '电气',
      purchaseMethod: '综合采购',
      purchaseChannel: '线下',
      supplier: '南通供应商',
      onlineUrl: '',
      procurementForm: '三方比价',
      comparisonSatisfied: '是',
      singleReason: '',
      requirementSummary: '补充现场备件',
      expectedDeliveryDate: '2026-08-20',
      immediateOutbound: false,
      notes: '加急',
    },
    items: [
      {
        lineId: 'line-1',
        mode: 'existing',
        catalogRecordId: 'catalog-1',
        sku: 'SKU-001',
        primaryCategory: '电气设备',
        secondaryCategory: '备件',
        itemName: '断路器',
        specification: 'DZ47',
        brand: '品牌甲',
        quantity: 2,
        unit: '只',
        unitPrice: 10,
        shippingFee: 2,
        discount: 1,
      },
      {
        lineId: 'line-2',
        mode: 'new',
        catalogRecordId: '',
        sku: '',
        primaryCategory: '工具',
        secondaryCategory: '手工具',
        itemName: '绝缘钳',
        specification: '8寸',
        brand: '品牌乙',
        quantity: 1,
        unit: '把',
        unitPrice: 30,
        shippingFee: 0,
        discount: 0,
      },
    ],
  };
}

function dashboard(
  requests: PurchaseInventoryRequestItem[],
): PurchaseInventoryResponse {
  const stageCounts: PurchaseInventoryResponse['summary']['stageCounts'] = {
    application: 0,
    approval: 0,
    rejected: 0,
    executing: 0,
    receiving: 0,
    inbound: 0,
    stocked: 0,
  };
  for (const item of requests) stageCounts[item.stage] += 1;
  return {
    generatedAt: '2026-08-11T06:00:00.000Z',
    summary: {
      totalRequests: requests.length,
      pendingApprovals: stageCounts.approval,
      executingOrders: stageCounts.executing,
      awaitingReceipt: stageCounts.receiving,
      stockedRequests: stageCounts.stocked,
      estimatedAmount: requests.reduce(
        (sum, item) => sum + item.estimatedAmount,
        0,
      ),
      actualAmount: requests.reduce(
        (sum, item) => sum + (item.actualAmount ?? 0),
        0,
      ),
      catalogItems: 9,
      inventorySkus: 7,
      availableQuantity: 32,
      inventoryValue: 1200,
      lowStockSkus: 2,
      pendingInbound: 1,
      stageCounts,
    },
    requests,
    inventory: { categoryBreakdown: [], alerts: [] },
    movements: { recentInbound: [], recentOutbound: [] },
    sectionStatus: {
      submissions: { configured: true, count: requests.length },
      executions: { configured: true, count: requests.length },
      catalog: { configured: true, count: 9 },
      inventory: { configured: true, count: 7 },
      inbound: { configured: true, count: 0 },
      outbound: { configured: true, count: 0 },
    },
  };
}

describe('purchase inventory management logic', () => {
  it('creates an empty dashboard baseline so cold submissions are visible immediately', () => {
    const createEmptyPurchaseInventoryDashboard = (
      purchaseLogic as unknown as Record<string, unknown>
    ).createEmptyPurchaseInventoryDashboard as (
      generatedAt: string,
    ) => PurchaseInventoryResponse;
    const buildPendingPurchaseApplicationItems = (
      purchaseLogic as unknown as Record<string, unknown>
    ).buildPendingPurchaseApplicationItems as (
      request: PurchaseApplicationBatchRequest,
      mutationId: string,
      createdAt: string,
    ) => PurchaseInventoryRequestItem[];
    const replacePurchaseApplicationOverlay = (
      purchaseLogic as unknown as Record<string, unknown>
    ).replacePurchaseApplicationOverlay as (
      dashboard: PurchaseInventoryResponse,
      items: PurchaseInventoryRequestItem[],
    ) => PurchaseInventoryResponse;

    expect(typeof createEmptyPurchaseInventoryDashboard).toBe('function');
    const empty = createEmptyPurchaseInventoryDashboard(
      '2026-08-11T06:00:00.000Z',
    );
    const visible = replacePurchaseApplicationOverlay(
      empty,
      buildPendingPurchaseApplicationItems(
        applicationBatch(),
        'mutation-cold',
        '2026-08-11T06:01:00.000Z',
      ),
    );

    expect(empty).toMatchObject({
      generatedAt: '2026-08-11T06:00:00.000Z',
      refreshState: 'stale',
      summary: { totalRequests: 0, pendingApprovals: 0 },
      requests: [],
    });
    expect(visible.summary.totalRequests).toBe(2);
    expect(visible.summary.pendingApprovals).toBe(2);
    expect(visible.requests).toHaveLength(2);
  });

  it('adds submitted draft lines immediately and reconciles only successful lines', () => {
    const buildPendingPurchaseApplicationItems = (
      purchaseLogic as unknown as Record<string, unknown>
    ).buildPendingPurchaseApplicationItems as (
      request: PurchaseApplicationBatchRequest,
      mutationId: string,
      createdAt: string,
    ) => PurchaseInventoryRequestItem[];
    const reconcilePendingPurchaseApplicationItems = (
      purchaseLogic as unknown as Record<string, unknown>
    ).reconcilePendingPurchaseApplicationItems as (
      items: PurchaseInventoryRequestItem[],
      result: PurchaseApplicationSubmitResponse,
    ) => PurchaseInventoryRequestItem[];
    const replacePurchaseApplicationOverlay = (
      purchaseLogic as unknown as Record<string, unknown>
    ).replacePurchaseApplicationOverlay as (
      dashboard: PurchaseInventoryResponse,
      items: PurchaseInventoryRequestItem[],
    ) => PurchaseInventoryResponse;
    expect(typeof buildPendingPurchaseApplicationItems).toBe('function');
    expect(typeof reconcilePendingPurchaseApplicationItems).toBe('function');
    expect(typeof replacePurchaseApplicationOverlay).toBe('function');
    const completed = request({
      recordId: 'completed-1',
      stage: 'stocked',
      statusLabel: '采购完成（已入库）',
      estimatedAmount: 100,
    });
    const pending = buildPendingPurchaseApplicationItems(
      applicationBatch(),
      'mutation-1',
      '2026-08-11T06:01:00.000Z',
    );

    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      recordId: 'pending:mutation-1:line-1',
      clientMutationId: 'mutation-1',
      clientLineId: 'line-1',
      pendingSync: true,
      stage: 'approval',
      statusLabel: '同步中',
      title: '断路器',
      estimatedAmount: 21,
    });

    const optimistic = replacePurchaseApplicationOverlay(
      dashboard([completed]),
      pending,
    );
    expect(optimistic.requests).toHaveLength(3);
    expect(optimistic.summary.totalRequests).toBe(3);
    expect(optimistic.summary.pendingApprovals).toBe(2);
    expect(optimistic.summary.stageCounts).toMatchObject({
      approval: 2,
      stocked: 1,
    });

    const result: PurchaseApplicationSubmitResponse = {
      success: false,
      created: [
        {
          lineId: 'line-1',
          recordId: 'record-real-1',
          executionRecordId: 'record-real-1',
          requestCode: 'CG260811-001',
        },
      ],
      failed: [{ lineId: 'line-2', message: '字段校验失败' }],
      warnings: [],
      message: '已提交 1 项，1 项失败',
    };
    const settled = reconcilePendingPurchaseApplicationItems(pending, result);
    const reconciled = replacePurchaseApplicationOverlay(optimistic, settled);

    expect(settled).toEqual([
      expect.objectContaining({
        recordId: 'record-real-1',
        executionRecordId: 'record-real-1',
        requestCode: 'CG260811-001',
        pendingSync: false,
        statusLabel: '待审批',
      }),
    ]);
    expect(reconciled.requests.map((item) => item.recordId)).toEqual([
      'record-real-1',
      'completed-1',
    ]);
    expect(reconciled.summary.stageCounts).toMatchObject({
      approval: 1,
      stocked: 1,
    });
  });

  it('groups every line item under its purchase order number without dropping items', () => {
    const grouped = groupPurchaseOrderItems([
      request({
        recordId: 'record-1',
        requestCode: 'CG260721-601',
        title: '羊角锤',
      }),
      request({
        recordId: 'record-2',
        requestCode: 'CG260721-601',
        title: '封箱胶带',
      }),
      request({
        recordId: 'record-3',
        requestCode: 'CG260721-602',
        title: '绝缘胶布',
      }),
    ]);

    expect(grouped).toEqual([
      {
        requestCode: 'CG260721-601',
        items: [
          expect.objectContaining({ recordId: 'record-1', title: '羊角锤' }),
          expect.objectContaining({ recordId: 'record-2', title: '封箱胶带' }),
        ],
      },
      {
        requestCode: 'CG260721-602',
        items: [
          expect.objectContaining({ recordId: 'record-3', title: '绝缘胶布' }),
        ],
      },
    ]);
  });

  it('normalises purchase codes before grouping table rows', () => {
    const grouped = groupPurchaseOrderItems([
      request({ recordId: 'record-1', requestCode: ' CG260721-601 ' }),
      request({ recordId: 'record-2', requestCode: 'CG260721-601' }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      requestCode: 'CG260721-601',
      items: [
        expect.objectContaining({ recordId: 'record-1' }),
        expect.objectContaining({ recordId: 'record-2' }),
      ],
    });
  });

  it('removes deleted requests immediately and recomputes request summaries without mutation', () => {
    const requests = [
      request({
        recordId: 'record-application',
        stage: 'application',
        estimatedAmount: 100,
        actualAmount: null,
      }),
      request({
        recordId: 'record-executing',
        stage: 'executing',
        estimatedAmount: 200,
        actualAmount: 150,
      }),
      request({
        recordId: 'record-stocked',
        stage: 'stocked',
        estimatedAmount: 300,
        actualAmount: 275,
      }),
    ];
    const dashboard: PurchaseInventoryResponse = {
      generatedAt: '2026-07-13T06:30:00.000Z',
      summary: {
        totalRequests: 3,
        pendingApprovals: 0,
        executingOrders: 1,
        awaitingReceipt: 0,
        stockedRequests: 1,
        estimatedAmount: 600,
        actualAmount: 425,
        catalogItems: 9,
        inventorySkus: 7,
        availableQuantity: 32,
        inventoryValue: 1200,
        lowStockSkus: 2,
        pendingInbound: 1,
        stageCounts: {
          application: 1,
          approval: 0,
          rejected: 0,
          executing: 1,
          receiving: 0,
          inbound: 0,
          stocked: 1,
        },
      },
      requests,
      inventory: { categoryBreakdown: [], alerts: [] },
      movements: { recentInbound: [], recentOutbound: [] },
      sectionStatus: {
        submissions: { configured: true, count: 3 },
        executions: { configured: true, count: 2 },
        catalog: { configured: true, count: 9 },
        inventory: { configured: true, count: 7 },
        inbound: { configured: true, count: 0 },
        outbound: { configured: true, count: 0 },
      },
    };

    const result = removeDeletedPurchaseRequests(dashboard, [
      'record-executing',
      'record-stocked',
    ]);

    expect(dashboard.requests).toHaveLength(3);
    expect(result.requests.map((item) => item.recordId)).toEqual([
      'record-application',
    ]);
    expect(result.summary).toMatchObject({
      totalRequests: 1,
      pendingApprovals: 0,
      executingOrders: 0,
      awaitingReceipt: 0,
      stockedRequests: 0,
      estimatedAmount: 100,
      actualAmount: 0,
      inventorySkus: 7,
      stageCounts: {
        application: 1,
        approval: 0,
        rejected: 0,
        executing: 0,
        receiving: 0,
        inbound: 0,
        stocked: 0,
      },
    });
  });

  it('filters live request items by lifecycle stage and keyword', () => {
    const requests = [
      request({
        requestCode: 'PR-202607-014',
        title: '110站蓄电池巡检仪',
        stage: 'executing',
        statusLabel: '待下单',
      }),
      request({
        recordId: 'record-2',
        requestCode: 'PR-202607-015',
        title: '消防末端试水装置',
        stage: 'approval',
        statusLabel: '审批中',
      }),
    ];

    const filtered = filterProcurementItems(requests, 'executing', '蓄电池');

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.requestCode).toBe('PR-202607-014');
  });

  it('searches purchaser, category, supplier, and inventory code fields', () => {
    const requests = [
      request({
        purchaser: '王采购',
        primaryCategory: '暖通设备',
        supplier: '南通供应商',
        inventorySku: 'SKU-100',
      }),
    ];

    expect(filterProcurementItems(requests, 'all', 'SKU-100')).toHaveLength(1);
    expect(filterProcurementItems(requests, 'all', '王采购')).toHaveLength(1);
  });

  it('keeps rejected records out of the application stage list', () => {
    const requests = [
      request({ recordId: 'application', stage: 'application' }),
      request({ recordId: 'approval', stage: 'approval' }),
      request({
        recordId: 'rejected',
        stage: 'rejected',
        statusLabel: '已驳回',
      }),
      request({ recordId: 'executing', stage: 'executing' }),
      request({ recordId: 'receiving', stage: 'receiving' }),
      request({ recordId: 'inbound', stage: 'inbound' }),
      request({ recordId: 'stocked', stage: 'stocked' }),
    ];

    expect(
      filterPurchaseApplicationItems(requests, 'all', '').map(
        (item) => item.stage,
      ),
    ).toEqual(['application', 'approval']);
    expect(
      filterPurchaseExecutionItems(requests, 'all', '').map(
        (item) => item.stage,
      ),
    ).toEqual(['executing', 'receiving']);
    expect(
      filterPurchaseExecutionItems(requests, 'all', ''),
    ).not.toContainEqual(expect.objectContaining({ stage: 'stocked' }));
    expect(
      filterPurchaseExecutionItems(requests, 'all', ''),
    ).not.toContainEqual(expect.objectContaining({ stage: 'inbound' }));
    expect(
      filterPurchaseExecutionItems(requests, 'all', ''),
    ).not.toContainEqual(expect.objectContaining({ stage: 'rejected' }));
    expect(
      filterPurchaseInboundItems(requests, '').map((item) => item.stage),
    ).toEqual(['inbound']);
    expect(filterPurchaseInboundItems(requests, '默认')).toHaveLength(1);
    expect(filterPurchaseInboundItems(requests, '不存在')).toHaveLength(0);
  });

  it('selects or clears the visible page without losing off-page selections', () => {
    const selected = new Set(['off-page']);

    const selectedPage = toggleVisiblePurchaseSelection(
      selected,
      ['row-1', 'row-2'],
      true,
    );
    expect([...selectedPage].sort()).toEqual(['off-page', 'row-1', 'row-2']);

    const clearedPage = toggleVisiblePurchaseSelection(
      selectedPage,
      ['row-1', 'row-2'],
      false,
    );
    expect([...clearedPage]).toEqual(['off-page']);
  });

  it('drops selections that no longer exist after a dashboard refresh', () => {
    expect([
      ...prunePurchaseSelection(new Set(['kept', 'deleted']), ['kept', 'new']),
    ]).toEqual(['kept']);
  });

  it('lists missing names, quantities, buildings, applicants, and units as anomalies', () => {
    const anomalies = buildPurchaseAnomalies([
      request({
        title: '未命名物品',
        requester: '',
        building: '',
        quantity: 0,
        unit: '',
      }),
      request({ recordId: 'healthy', title: '接线端子排', quantity: 2 }),
    ]);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      item: expect.objectContaining({ recordId: 'record-1' }),
      issues: [
        '缺少物品名称',
        '数量未填写',
        '楼栋未匹配',
        '申请人未填写',
        '计数单位未填写',
      ],
    });
  });
});
