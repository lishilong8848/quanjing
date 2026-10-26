import type { ProcurementForm } from './purchase-application.interface';

export type PurchaseInventoryStage =
  | 'application'
  | 'approval'
  | 'rejected'
  | 'executing'
  | 'receiving'
  | 'inbound'
  | 'stocked';

export type PurchaseInventoryPriority = 'P0' | 'P1' | 'P2' | 'P3' | '未设置';
export type InventoryRiskTone = 'critical' | 'warning' | 'normal';
export type PurchaseInventorySectionKey =
  | 'submissions'
  | 'executions'
  | 'catalog'
  | 'inventory'
  | 'inbound'
  | 'outbound';

export interface PurchaseInventoryRequestItem {
  recordId: string;
  clientMutationId?: string;
  clientLineId?: string;
  pendingSync?: boolean;
  submissionRecordId: string | null;
  executionRecordId: string | null;
  requestCode: string;
  title: string;
  specification?: string;
  requester: string;
  requesterChatUrl: string | null;
  purchaser: string;
  purchaserChatUrl: string | null;
  building: string;
  specialty: string;
  primaryCategory: string;
  secondaryCategory: string;
  stage: PurchaseInventoryStage;
  statusLabel: string;
  purchaseMethod: string;
  procurementForm: ProcurementForm;
  singleReason: string;
  purchaseLinks?: string[];
  approvalTarget: string;
  supplier: string;
  estimatedAmount: number;
  actualAmount: number | null;
  quantity: number;
  actualQuantity: number | null;
  unit: string;
  priority: PurchaseInventoryPriority;
  createdAt: string | null;
  expectedArrival: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  warehouseRequired: boolean;
  warehouseConfirmed: boolean;
  purchaseCompleted: boolean;
  inventorySku: string;
  notes: string;
}

export interface PurchaseInventoryAlertItem {
  recordId: string;
  sku: string;
  name: string;
  building: string;
  category: string;
  location: string;
  availableQuantity: number;
  reorderPoint: number;
  difference: number;
  unit: string;
  value: number;
  owners: string[];
  riskTone: InventoryRiskTone;
}

export interface PurchaseInventoryMovementItem {
  recordId: string;
  type: 'inbound' | 'outbound';
  sku: string;
  name: string;
  quantity: number;
  status: string;
  building: string;
  location: string;
  sourceOrReason: string;
  operator: string;
  createdAt: string | null;
}

export interface PurchaseInventorySectionStatus {
  configured: boolean;
  count: number;
  message?: string;
}

export interface PurchaseInventoryResponse {
  generatedAt: string;
  refreshState?: 'fresh' | 'partial' | 'stale';
  refreshError?: string;
  summary: {
    totalRequests: number;
    pendingApprovals: number;
    executingOrders: number;
    awaitingReceipt: number;
    stockedRequests: number;
    estimatedAmount: number;
    actualAmount: number;
    catalogItems: number;
    inventorySkus: number;
    availableQuantity: number;
    inventoryValue: number;
    lowStockSkus: number;
    pendingInbound: number;
    stageCounts: Record<PurchaseInventoryStage, number>;
  };
  requests: PurchaseInventoryRequestItem[];
  inventory: {
    categoryBreakdown: Array<{
      category: string;
      skuCount: number;
      quantity: number;
    }>;
    alerts: PurchaseInventoryAlertItem[];
  };
  movements: {
    recentInbound: PurchaseInventoryMovementItem[];
    recentOutbound: PurchaseInventoryMovementItem[];
  };
  sectionStatus: Record<
    PurchaseInventorySectionKey,
    PurchaseInventorySectionStatus
  >;
}

export interface PurchaseRecordDeleteTarget {
  key: string;
  submissionRecordId: string | null;
  executionRecordId: string | null;
}

export interface PurchaseRecordBatchDeleteRequest {
  records: PurchaseRecordDeleteTarget[];
}

export interface PurchaseRecordBatchDeleteResponse {
  deletedItems: number;
  deletedSubmissionRecords: number;
  deletedExecutionRecords: number;
  durationMs: number;
}

export type PurchaseRecordEditableStatus =
  | 'application'
  | 'approval'
  | 'executing'
  | 'receiving'
  | 'warehouse'
  | 'stocked';

export interface PurchaseRecordUpdateFields {
  itemName?: string;
  quantity?: number;
  unit?: string;
  building?: string;
  supplier?: string;
  expectedArrival?: string | null;
  notes?: string;
  requesterOpenId?: string;
  status?: PurchaseRecordEditableStatus;
}

export interface PurchaseRecordUpdateRequest {
  submissionRecordId: string | null;
  executionRecordId: string | null;
  fields: PurchaseRecordUpdateFields;
}

export interface PurchaseRecordUpdateResponse {
  updatedSubmissionRecord: boolean;
  updatedExecutionRecord: boolean;
  durationMs: number;
}

export type PurchaseOnlineApprovalDecision = 'approved' | 'rejected';

export interface PurchaseOnlineApprovalRequest {
  decision: PurchaseOnlineApprovalDecision;
}

export interface PurchaseOnlineApprovalResponse {
  recordId: string;
  decision: PurchaseOnlineApprovalDecision;
  resultLabel: '审批通过' | '已驳回';
  idempotent: boolean;
  durationMs: number;
}

export type PurchaseOnlineApprovalTaskState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface PurchaseOnlineApprovalAcceptedResponse {
  pending: true;
  taskId: string;
  message: string;
}

export interface PurchaseOnlineApprovalTask {
  id: string;
  recordId: string;
  decision: PurchaseOnlineApprovalDecision;
  status: PurchaseOnlineApprovalTaskState;
  message: string;
  createdAt: string;
  completedAt?: string;
  result?: PurchaseOnlineApprovalResponse;
}

export interface PurchaseOnlineApprovalTaskStatusResponse {
  success: boolean;
  message?: string;
  task?: PurchaseOnlineApprovalTask;
}
