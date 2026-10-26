import { canAccessBuilding } from '@shared/building-access';
import type { AccessPrincipal } from '@shared/access-control.interface';
import type {
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
} from '@shared/purchase-inventory.interface';

export function canApprovePurchaseOnline(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  return (
    (principal.role === 'admin' ||
      (principal.role === 'building_admin' &&
        canAccessBuilding(principal, item.building))) &&
    item.stage === 'approval' &&
    Boolean(item.executionRecordId) &&
    !item.purchaseCompleted
  );
}

export function createPurchaseOnlineApprovalSubmissionGate(): {
  tryStart: () => boolean;
  finish: () => void;
} {
  let submitting = false;
  return {
    tryStart() {
      if (submitting) return false;
      submitting = true;
      return true;
    },
    finish() {
      submitting = false;
    },
  };
}

export async function resolvePurchaseOnlineApprovalRefresh(
  refresh: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await refresh();
  } catch {
    return false;
  }
}

export function applyPurchaseApprovalOptimisticUpdate(
  dashboard: PurchaseInventoryResponse,
  recordId: string,
  decision: 'approved' | 'rejected',
): PurchaseInventoryResponse {
  return replacePurchaseRequest(dashboard, recordId, (item) => ({
    ...item,
    stage: decision === 'approved' ? 'executing' : 'rejected',
    statusLabel: decision === 'approved' ? '审批通过（待下单）' : '驳回申请',
    ...(decision === 'rejected' ? { purchaseMethod: '驳回' } : {}),
  }));
}

export function applyPurchaseReceiptOptimisticUpdate(
  dashboard: PurchaseInventoryResponse,
  recordId: string,
): PurchaseInventoryResponse {
  return replacePurchaseRequest(dashboard, recordId, (item) => ({
    ...item,
    stage: 'inbound',
    statusLabel: '到货已签收（待入库）',
    warehouseConfirmed: false,
    purchaseCompleted: true,
  }));
}

export function applyPurchaseOrderOptimisticUpdate(
  dashboard: PurchaseInventoryResponse,
  recordId: string,
  actualQuantity: number,
  actualAmount: number,
): PurchaseInventoryResponse {
  return replacePurchaseRequest(dashboard, recordId, (item) => ({
    ...item,
    stage: 'receiving',
    statusLabel: '下单完成（待签收）',
    actualQuantity,
    actualAmount,
    purchaseCompleted: true,
  }));
}

export function restorePurchaseOptimisticItem(
  dashboard: PurchaseInventoryResponse,
  originalItem: PurchaseInventoryRequestItem,
): PurchaseInventoryResponse {
  return replacePurchaseRequest(dashboard, originalItem.recordId, () => ({
    ...originalItem,
  }));
}

function replacePurchaseRequest(
  dashboard: PurchaseInventoryResponse,
  recordId: string,
  update: (item: PurchaseInventoryRequestItem) => PurchaseInventoryRequestItem,
): PurchaseInventoryResponse {
  let changed = false;
  const requests = dashboard.requests.map((item) => {
    if (item.recordId !== recordId && item.executionRecordId !== recordId) {
      return item;
    }
    changed = true;
    return update(item);
  });
  if (!changed) return dashboard;
  const stageCounts = {
    application: 0,
    approval: 0,
    rejected: 0,
    executing: 0,
    receiving: 0,
    inbound: 0,
    stocked: 0,
  };
  requests.forEach((item) => {
    stageCounts[item.stage] += 1;
  });
  return {
    ...dashboard,
    requests,
    summary: {
      ...dashboard.summary,
      pendingApprovals: stageCounts.approval,
      executingOrders: stageCounts.executing,
      awaitingReceipt: stageCounts.receiving,
      stockedRequests: stageCounts.stocked,
      actualAmount: requests.reduce(
        (total, item) => total + (item.actualAmount ?? 0),
        0,
      ),
      stageCounts,
    },
  };
}
