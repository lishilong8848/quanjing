import type { AccessRole } from './access-control.interface';

export const PURCHASE_WORKFLOW_STATUSES = [
  '未开始（待审批）',
  '审批通过（待下单）',
  '下单完成（待签收）',
  '物品签收（待入库）',
  '采购完成（已入库）',
  '驳回申请',
  // 以下仅用于兼容历史记录，不再作为程序写入值。
  '审批通过（待库房确认）',
  '库房确认（待下单）',
  '到货已签收（待入库）',
  '物品签收已入库',
  '已终止',
] as const;

export type PurchaseWorkflowStatus =
  (typeof PURCHASE_WORKFLOW_STATUSES)[number];
export type PurchaseWorkflowStage =
  | 'application'
  | 'approval'
  | 'ordering'
  | 'receipt'
  | 'inbound'
  | 'completed'
  | 'terminated'
  | 'unknown';
export type PurchaseWorkflowAction = 'approve' | 'start' | 'order' | 'receive';
export type PurchaseWorkflowMethod =
  | '综合采购'
  | '需求自采'
  | '需求自采（楼内）'
  | '驳回'
  | '';

export interface PurchaseWorkflowUser {
  openId: string;
  name: string;
  positions: string[];
  buildings: string[];
  accessRole?: AccessRole;
  permissionPrincipal?: import('./access-control.interface').AccessPrincipal;
}

export interface PurchaseWorkflowRecord {
  specialty?: string;
  recordId: string;
  requestCode: string;
  status: string;
  itemName: string;
  specification?: string;
  sku?: string;
  location?: string;
  building: string;
  requesterOpenId: string;
  requesterName: string;
  purchaserOpenId: string;
  purchaserName: string;
  purchaseMethod: PurchaseWorkflowMethod;
  procurementForm?: '三方比价' | '单一采购';
  singleReason?: string;
  purchaseLinks?: string[];
  rejectionReason?: string;
  requestedQuantity: number;
  unit?: string;
  unitPrice?: number | null;
  createdAt?: number | null;
  actualQuantity: number | null;
  actualAmount: number | null;
  paymentAttachmentTokens?: string[];
  amountDifference?: number | null;
  quantityDifference?: number | null;
  approvalCompleted: boolean;
  warehouseConfirmed: boolean;
  purchaseCompleted: boolean;
  receiptConfirmed: boolean;
  signer: string;
  signerOpenId?: string;
  receiptTime: number | null;
  receiptPhotoTokens: string[];
  invoiceTokens: string[];
  supplier?: string;
  requirementSummary?: string;
  expectedDeliveryDate?: number | null;
  note?: string;
  approvalSource?: string;
  approvalWorkflowStatus?: string;
  approvalPolicyVersion?: string;
  approvalBatchId?: string;
  approvalActionId?: string;
  approvalWorkflowError?: string;
  approvalCardDeliveryStatus?: string;
  approvalCardDeliveredAt?: number | null;
  approvalCardMessageId?: string;
  approvalCardDeliveryUuid?: string;
  approvalCardDeliveryAttempts?: number;
  approvalCardLastAttemptAt?: number | null;
  receiptCardDeliveryStatus?: string;
  receiptCardBatchId?: string;
  receiptCardDeliveredAt?: number | null;
  receiptCardMessageId?: string;
  receiptCardDeliveryUuid?: string;
  receiptCardDeliveryAttempts?: number;
  receiptCardLastAttemptAt?: number | null;
  receiptCardDeliveryError?: string;
}

export interface PurchaseWorkflowApprovalInput {
  decision: 'approved' | 'rejected';
  purchaseMethod: Exclude<PurchaseWorkflowMethod, ''>;
  comment: string;
}

export interface PurchaseWorkflowOrderInput {
  actualQuantity: number;
  actualAmount: number;
  paymentAttachmentTokens: string[];
  note: string;
}

export interface PurchaseWorkflowReceiptInput {
  clientMutationId?: string;
  signer: string;
  signerOpenId: string;
  receiptTime: number;
  receiptPhotoTokens: string[];
  invoiceTokens: string[];
  note: string;
}

export interface PurchaseWorkflowTimelineItem {
  key: Exclude<PurchaseWorkflowStage, 'terminated' | 'unknown'>;
  label: string;
  state: 'completed' | 'current' | 'pending' | 'terminated';
}

export interface PurchaseWorkflowDetail {
  record: PurchaseWorkflowRecord;
  stage: PurchaseWorkflowStage;
  allowedActions: PurchaseWorkflowAction[];
  timeline: PurchaseWorkflowTimelineItem[];
  programEnabled: boolean;
  disabledReason: string;
}

export interface PurchaseWorkflowCommandResult {
  detail: PurchaseWorkflowDetail;
  idempotent: boolean;
  notificationWarnings: string[];
}

export type PurchaseWorkflowReceiptTaskState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface PurchaseWorkflowReceiptAcceptedResponse {
  pending: true;
  taskId: string;
  message: string;
}

export interface PurchaseWorkflowReceiptTask {
  id: string;
  recordId: string;
  status: PurchaseWorkflowReceiptTaskState;
  message: string;
  createdAt: string;
  completedAt?: string;
  result?: PurchaseWorkflowCommandResult;
  notificationWarnings?: string[];
}

export interface PurchaseWorkflowReceiptTaskStatusResponse {
  success: boolean;
  message?: string;
  task?: PurchaseWorkflowReceiptTask;
}

export interface PurchaseWorkflowOperationalStatus {
  enabled: boolean;
  disabledReason: string;
  nextRuns: Array<{ code: string; at: string }>;
  recentRuns: Array<{
    code: string;
    startedAt: string;
    finishedAt: string;
    processed: number;
    failed: number;
  }>;
}

export type PurchaseWorkflowReminderCode = 'warehouse' | 'order' | 'receipt';

export interface PurchaseWorkflowReminderRunResult {
  code: PurchaseWorkflowReminderCode;
  startedAt: string;
  finishedAt: string;
  processed: number;
  failed: number;
  errors: string[];
}

export interface PurchaseWorkflowSelfTestResponse {
  passed: boolean;
  marker: string;
  checks: Array<{ name: string; passed: boolean; message: string }>;
  createdRecordIds: string[];
  deletedRecordIds: string[];
  remainingRecordIds: string[];
}
