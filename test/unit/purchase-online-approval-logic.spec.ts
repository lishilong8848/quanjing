import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PurchaseInventoryRequestItem } from '../../shared/purchase-inventory.interface';

interface PurchaseOnlineApprovalSubmissionGate {
  tryStart: () => boolean;
  finish: () => void;
}

interface PurchaseOnlineApprovalLogic {
  canApprovePurchaseOnline?: (
    principal: AccessPrincipal,
    item: PurchaseInventoryRequestItem,
  ) => boolean;
  createPurchaseOnlineApprovalSubmissionGate?: () => PurchaseOnlineApprovalSubmissionGate;
  resolvePurchaseOnlineApprovalRefresh?: (
    refresh: () => Promise<boolean>,
  ) => Promise<boolean>;
  applyPurchaseApprovalOptimisticUpdate?: (
    dashboard: import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse,
    recordId: string,
    decision: 'approved' | 'rejected',
  ) => import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse;
  applyPurchaseReceiptOptimisticUpdate?: (
    dashboard: import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse,
    recordId: string,
  ) => import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse;
  applyPurchaseOrderOptimisticUpdate?: (
    dashboard: import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse,
    recordId: string,
    actualQuantity: number,
    actualAmount: number,
  ) => import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse;
  restorePurchaseOptimisticItem?: (
    dashboard: import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse,
    item: PurchaseInventoryRequestItem,
  ) => import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse;
}

const logicPath = resolve(
  'client/src/pages/PurchaseInventoryManagement/purchase-online-approval.logic.ts',
);

describe('purchase online approval logic', () => {
  it('allows a full administrator and the matching building administrator to approve', () => {
    const logic = loadLogic();
    if (!logic) return;
    expect(logic.canApprovePurchaseOnline).toBeDefined();
    if (!logic.canApprovePurchaseOnline) return;

    const item = approvalItem({ building: 'A楼' });
    expect(logic.canApprovePurchaseOnline(principal('admin'), item)).toBe(true);
    expect(logic.canApprovePurchaseOnline({ role: 'building_admin', purchaseBuilding: 'A楼' }, item)).toBe(true);
    expect(logic.canApprovePurchaseOnline({ role: 'building_admin', purchaseBuilding: 'B楼' }, item)).toBe(false);

    for (const role of [
      'editor',
      'purchase_admin',
      'supply_chain_admin',
      'purchase_applicant',
      'guest',
    ] as const) {
      expect(logic.canApprovePurchaseOnline(principal(role), item)).toBe(false);
    }
  });

  it('rejects records outside approval or without a writable execution record', () => {
    const logic = loadLogic();
    if (!logic) return;
    expect(logic.canApprovePurchaseOnline).toBeDefined();
    if (!logic.canApprovePurchaseOnline) return;

    const admin = principal('admin');
    expect(
      logic.canApprovePurchaseOnline(
        admin,
        approvalItem({ executionRecordId: null }),
      ),
    ).toBe(false);
    expect(
      logic.canApprovePurchaseOnline(
        admin,
        approvalItem({ stage: 'application' }),
      ),
    ).toBe(false);
    expect(
      logic.canApprovePurchaseOnline(
        admin,
        approvalItem({ stage: 'executing' }),
      ),
    ).toBe(false);
    expect(
      logic.canApprovePurchaseOnline(
        admin,
        approvalItem({ purchaseCompleted: true }),
      ),
    ).toBe(false);
  });

  it('allows only one approval submission until the active request finishes', () => {
    const logic = loadLogic();
    if (!logic) return;
    expect(logic.createPurchaseOnlineApprovalSubmissionGate).toBeDefined();
    if (!logic.createPurchaseOnlineApprovalSubmissionGate) return;

    const gate = logic.createPurchaseOnlineApprovalSubmissionGate();
    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it('normalizes a failed dashboard refresh without undoing a successful approval', async () => {
    const logic = loadLogic();
    if (!logic) return;
    expect(logic.resolvePurchaseOnlineApprovalRefresh).toBeDefined();
    if (!logic.resolvePurchaseOnlineApprovalRefresh) return;

    await expect(
      logic.resolvePurchaseOnlineApprovalRefresh(async () => true),
    ).resolves.toBe(true);
    await expect(
      logic.resolvePurchaseOnlineApprovalRefresh(async () => false),
    ).resolves.toBe(false);
    await expect(
      logic.resolvePurchaseOnlineApprovalRefresh(async () => {
        throw new Error('dashboard refresh failed');
      }),
    ).resolves.toBe(false);
  });

  it('updates approval, order and receipt stages immediately and can restore the original item', () => {
    const logic = loadLogic();
    if (!logic) return;
    expect(logic.applyPurchaseApprovalOptimisticUpdate).toBeDefined();
    expect(logic.applyPurchaseReceiptOptimisticUpdate).toBeDefined();
    expect(logic.applyPurchaseOrderOptimisticUpdate).toBeDefined();
    expect(logic.restorePurchaseOptimisticItem).toBeDefined();
    if (
      !logic.applyPurchaseApprovalOptimisticUpdate ||
      !logic.applyPurchaseOrderOptimisticUpdate ||
      !logic.applyPurchaseReceiptOptimisticUpdate ||
      !logic.restorePurchaseOptimisticItem
    ) {
      return;
    }

    const original = approvalItem();
    const dashboard = dashboardWith(original);
    const approved = logic.applyPurchaseApprovalOptimisticUpdate(
      dashboard,
      original.recordId,
      'approved',
    );
    expect(approved.requests[0]).toMatchObject({
      stage: 'executing',
      statusLabel: '审批通过（待下单）',
    });
    expect(approved.summary.pendingApprovals).toBe(0);
    expect(approved.summary.executingOrders).toBe(1);

    const ordered = logic.applyPurchaseOrderOptimisticUpdate(
      dashboardWith(original, {
        stage: 'executing',
        statusLabel: '审批通过（待下单）',
      }),
      original.recordId,
      2,
      100,
    );
    expect(ordered.requests[0]).toMatchObject({
      stage: 'receiving',
      statusLabel: '下单完成（待签收）',
      actualQuantity: 2,
      actualAmount: 100,
      purchaseCompleted: true,
    });
    expect(ordered.summary.executingOrders).toBe(0);
    expect(ordered.summary.awaitingReceipt).toBe(1);
    expect(ordered.summary.actualAmount).toBe(100);

    const received = logic.applyPurchaseReceiptOptimisticUpdate(
      dashboardWith(original, { stage: 'receiving' }),
      original.recordId,
    );
    expect(received.requests[0]).toMatchObject({
      stage: 'inbound',
      statusLabel: '到货已签收（待入库）',
      purchaseCompleted: true,
    });
    expect(received.summary.awaitingReceipt).toBe(0);
    expect(received.summary.stockedRequests).toBe(0);
    expect(received.summary.stageCounts.inbound).toBe(1);

    const restored = logic.restorePurchaseOptimisticItem(approved, original);
    expect(restored.requests[0]).toEqual(original);
    expect(restored.summary.pendingApprovals).toBe(1);
    expect(restored.summary.executingOrders).toBe(0);
  });
});

function loadLogic(): PurchaseOnlineApprovalLogic | null {
  const exists = existsSync(logicPath);
  expect(exists).toBe(true);
  if (!exists) return null;
  return jest.requireActual(logicPath) as PurchaseOnlineApprovalLogic;
}

function principal(role: AccessPrincipal['role']): AccessPrincipal {
  return { role, purchaseBuilding: null };
}

function approvalItem(
  overrides: Partial<PurchaseInventoryRequestItem> = {},
): PurchaseInventoryRequestItem {
  return {
    recordId: 'rec-approval',
    submissionRecordId: 'rec-submission',
    executionRecordId: 'rec-execution',
    requestCode: 'TEST-APPROVAL-001',
    title: '测试审批物品',
    requester: '刘小杏',
    purchaser: '',
    building: 'H楼',
    specialty: '其他',
    primaryCategory: '工具类',
    secondaryCategory: '手工具',
    stage: 'approval',
    statusLabel: '审批中',
    purchaseMethod: '综合采购',
    approvalTarget: '运维经理',
    supplier: '测试供应商',
    estimatedAmount: 10,
    actualAmount: null,
    quantity: 1,
    actualQuantity: null,
    unit: '件',
    priority: '未设置',
    createdAt: '2026-07-21T00:00:00.000Z',
    expectedArrival: '2026-07-26T00:00:00.000Z',
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

function dashboardWith(
  item: PurchaseInventoryRequestItem,
  overrides: Partial<PurchaseInventoryRequestItem> = {},
): import('../../shared/purchase-inventory.interface').PurchaseInventoryResponse {
  const request = { ...item, ...overrides };
  const stageCounts = {
    application: 0,
    approval: 0,
    rejected: 0,
    executing: 0,
    receiving: 0,
    inbound: 0,
    stocked: 0,
    [request.stage]: 1,
  };
  return {
    generatedAt: '2026-07-21T05:00:00.000Z',
    summary: {
      totalRequests: 1,
      pendingApprovals: stageCounts.approval,
      executingOrders: stageCounts.executing,
      awaitingReceipt: stageCounts.receiving,
      stockedRequests: stageCounts.stocked,
      estimatedAmount: request.estimatedAmount,
      actualAmount: request.actualAmount || 0,
      catalogItems: 0,
      inventorySkus: 0,
      availableQuantity: 0,
      inventoryValue: 0,
      lowStockSkus: 0,
      pendingInbound: 0,
      stageCounts,
    },
    requests: [request],
    inventory: { categoryBreakdown: [], alerts: [] },
    movements: { recentInbound: [], recentOutbound: [] },
    sectionStatus: {
      submissions: { configured: true, count: 1 },
      executions: { configured: true, count: 1 },
      catalog: { configured: true, count: 0 },
      inventory: { configured: true, count: 0 },
      inbound: { configured: true, count: 0 },
      outbound: { configured: true, count: 0 },
    },
  };
}
