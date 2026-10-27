import type {
  PurchaseInventoryResponse,
  PurchaseInventoryRequestItem,
  PurchaseInventoryStage,
} from '@shared/purchase-inventory.interface';
import type {
  PurchaseApplicationBatchRequest,
  PurchaseApplicationSubmitResponse,
} from '@shared/purchase-application.interface';

export type PurchaseStage = PurchaseInventoryStage;
export type PurchaseStageFilter = PurchaseInventoryStage | 'all';
export type PurchaseApplicationFilter = 'all' | 'application' | 'approval';
export type PurchaseExecutionFilter = 'all' | 'executing' | 'receiving';

export interface PurchaseAnomalyItem {
  item: PurchaseInventoryRequestItem;
  issues: string[];
}

export interface PurchaseOrderGroup {
  requestCode: string;
  items: PurchaseInventoryRequestItem[];
}

export const purchaseStageLabels: Record<PurchaseStageFilter, string> = {
  all: '全部',
  application: '采购申请',
  approval: '审批中',
  rejected: '已驳回',
  executing: '采购执行',
  receiving: '收货签收',
  inbound: '签收待入库',
  stocked: '入库闭环',
};

export function createEmptyPurchaseInventoryDashboard(
  generatedAt = new Date().toISOString(),
): PurchaseInventoryResponse {
  return {
    generatedAt,
    refreshState: 'stale',
    refreshError: '采购数据正在加载，已先显示本次申请。',
    summary: {
      totalRequests: 0,
      pendingApprovals: 0,
      executingOrders: 0,
      awaitingReceipt: 0,
      stockedRequests: 0,
      estimatedAmount: 0,
      actualAmount: 0,
      catalogItems: 0,
      inventorySkus: 0,
      availableQuantity: 0,
      inventoryValue: 0,
      lowStockSkus: 0,
      pendingInbound: 0,
      stageCounts: {
        application: 0,
        approval: 0,
        rejected: 0,
        executing: 0,
        receiving: 0,
        inbound: 0,
        stocked: 0,
      },
    },
    requests: [],
    inventory: { categoryBreakdown: [], alerts: [] },
    movements: { recentInbound: [], recentOutbound: [] },
    sectionStatus: {
      submissions: { configured: true, count: 0 },
      executions: { configured: true, count: 0 },
      catalog: { configured: true, count: 0 },
      inventory: { configured: true, count: 0 },
      inbound: { configured: true, count: 0 },
      outbound: { configured: true, count: 0 },
    },
  };
}

export function filterProcurementItems(
  requests: PurchaseInventoryRequestItem[],
  stage: PurchaseStageFilter,
  keyword: string,
): PurchaseInventoryRequestItem[] {
  const normalizedKeyword = keyword.trim().toLowerCase();

  return requests.filter((item) => {
    if (stage !== 'all' && item.stage !== stage) return false;
    if (!normalizedKeyword) return true;

    return [
      item.requestCode,
      item.title,
      item.requester,
      item.purchaser,
      item.building,
      item.specialty,
      item.primaryCategory,
      item.secondaryCategory,
      item.supplier,
      item.inventorySku,
      item.statusLabel,
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalizedKeyword);
  });
}

export function filterPurchaseApplicationItems(
  requests: PurchaseInventoryRequestItem[],
  stage: PurchaseApplicationFilter,
  keyword: string,
): PurchaseInventoryRequestItem[] {
  return filterProcurementItems(requests, stage, keyword).filter(
    (item) => item.stage === 'application' || item.stage === 'approval',
  );
}

export function filterPurchaseExecutionItems(
  requests: PurchaseInventoryRequestItem[],
  stage: PurchaseExecutionFilter,
  keyword: string,
): PurchaseInventoryRequestItem[] {
  return filterProcurementItems(requests, stage, keyword).filter(
    (item) => item.stage === 'executing' || item.stage === 'receiving',
  );
}

export function filterPurchaseInboundItems(
  requests: PurchaseInventoryRequestItem[],
  keyword: string,
): PurchaseInventoryRequestItem[] {
  return filterProcurementItems(requests, 'inbound', keyword);
}

export function groupPurchaseOrderItems(
  items: PurchaseInventoryRequestItem[],
): PurchaseOrderGroup[] {
  const groups = new Map<string, PurchaseOrderGroup>();

  for (const item of items) {
    const requestCode = item.requestCode.trim();
    const groupKey = requestCode || `__ungrouped__${item.recordId}`;
    const existing = groups.get(groupKey);

    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(groupKey, { requestCode, items: [item] });
  }

  return [...groups.values()];
}

export function toggleVisiblePurchaseSelection(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of visibleIds) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function prunePurchaseSelection(
  selected: ReadonlySet<string>,
  availableIds: readonly string[],
): Set<string> {
  const available = new Set(availableIds);
  return new Set([...selected].filter((id) => available.has(id)));
}

export function removeDeletedPurchaseRequests(
  dashboard: PurchaseInventoryResponse,
  deletedIds: Iterable<string>,
): PurchaseInventoryResponse {
  const deleted = new Set(deletedIds);
  const requests = dashboard.requests.filter(
    (item) => !deleted.has(item.recordId),
  );
  if (requests.length === dashboard.requests.length) return dashboard;

  return replacePurchaseRequests(dashboard, requests);
}

export function buildPendingPurchaseApplicationItems(
  request: PurchaseApplicationBatchRequest,
  mutationId: string,
  createdAt = new Date().toISOString(),
): PurchaseInventoryRequestItem[] {
  return request.items.map((item) => ({
    recordId: `pending:${mutationId}:${item.lineId}`,
    clientMutationId: mutationId,
    clientLineId: item.lineId,
    pendingSync: true,
    submissionRecordId: null,
    executionRecordId: null,
    requestCode: '同步中',
    title: item.itemName,
    specification: item.specification,
    requester: request.shared.applicantName,
    requesterChatUrl: null,
    purchaser: '',
    purchaserChatUrl: null,
    building: request.shared.building,
    specialty: request.shared.specialty,
    primaryCategory: item.primaryCategory,
    secondaryCategory: item.secondaryCategory,
    stage: 'approval',
    statusLabel: '同步中',
    purchaseMethod: request.shared.purchaseMethod,
    procurementForm: request.shared.procurementForm,
    singleReason: request.shared.singleReason,
    purchaseLinks: item.onlineUrls?.length
      ? item.onlineUrls
      : request.shared.onlineUrl
        ? [request.shared.onlineUrl]
        : [],
    approvalTarget: '运维经理（马进宇 / 梅冰冰，任一审批）',
    supplier: request.shared.supplier,
    estimatedAmount: roundMoney(
      item.quantity * item.unitPrice + item.shippingFee - item.discount,
    ),
    actualAmount: null,
    quantity: item.quantity,
    actualQuantity: null,
    unit: item.unit,
    priority: '未设置',
    createdAt,
    expectedArrival: request.shared.expectedDeliveryDate || null,
    orderedAt: null,
    receivedAt: null,
    warehouseRequired: Boolean(item.catalogRecordId || item.sku),
    warehouseConfirmed: false,
    purchaseCompleted: false,
    inventorySku: item.sku,
    notes: request.shared.notes,
  }));
}

export function reconcilePendingPurchaseApplicationItems(
  items: PurchaseInventoryRequestItem[],
  result: PurchaseApplicationSubmitResponse,
): PurchaseInventoryRequestItem[] {
  const createdByLineId = new Map(
    result.created.map((created) => [created.lineId, created]),
  );

  return items.flatMap((item) => {
    const created = item.clientLineId
      ? createdByLineId.get(item.clientLineId)
      : undefined;
    if (!created) return [];
    return [
      {
        ...item,
        recordId: created.recordId,
        submissionRecordId: created.recordId,
        executionRecordId: created.executionRecordId ?? created.recordId,
        requestCode: created.requestCode,
        pendingSync: false,
        statusLabel: '待审批',
      },
    ];
  });
}

export function replacePurchaseApplicationOverlay(
  dashboard: PurchaseInventoryResponse,
  items: PurchaseInventoryRequestItem[],
): PurchaseInventoryResponse {
  const overlayIds = new Set(items.map((item) => item.recordId));
  const requests = [
    ...items,
    ...dashboard.requests.filter(
      (item) => !item.clientMutationId && !overlayIds.has(item.recordId),
    ),
  ];
  return replacePurchaseRequests(dashboard, requests);
}

function replacePurchaseRequests(
  dashboard: PurchaseInventoryResponse,
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
    ...dashboard,
    requests,
    summary: {
      ...dashboard.summary,
      totalRequests: requests.length,
      pendingApprovals: stageCounts.approval,
      executingOrders: stageCounts.executing,
      awaitingReceipt: stageCounts.receiving,
      stockedRequests: stageCounts.stocked,
      estimatedAmount: roundMoney(
        requests.reduce((sum, item) => sum + item.estimatedAmount, 0),
      ),
      actualAmount: roundMoney(
        requests.reduce((sum, item) => sum + (item.actualAmount ?? 0), 0),
      ),
      stageCounts,
    },
  };
}

export function buildPurchaseAnomalies(
  requests: PurchaseInventoryRequestItem[],
): PurchaseAnomalyItem[] {
  return requests.flatMap((item) => {
    const issues: string[] = [];
    if (!item.title.trim() || item.title === '未命名物品') {
      issues.push('缺少物品名称');
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      issues.push('数量未填写');
    }
    if (!item.building.trim()) issues.push('楼栋未匹配');
    if (!item.requester.trim()) issues.push('申请人未填写');
    if (!item.unit.trim()) issues.push('计数单位未填写');
    return issues.length ? [{ item, issues }] : [];
  });
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
