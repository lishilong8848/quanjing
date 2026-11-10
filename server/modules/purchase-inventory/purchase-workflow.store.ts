import {
  parsePurchaseBatchFulfillmentCommandContext,
  serializePurchaseBatchFulfillmentCommandContext,
  type PurchaseBatchFulfillmentCommandContext,
} from './purchase-batch-fulfillment-card';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PURCHASE_STAGE_CARDS_LEDGER_CAPABILITY, retainPurchaseLedgerCapability, validatePurchaseLedgerCapability } from './purchase-ledger-capability';
import type { PurchaseLifecycleFormBinding } from './purchase-lifecycle-form';
import { acceptReceiptPrepare, finishReceiptPrepare, leaseReceiptPrepare, normalizeReceiptPrepareQueue, type ReceiptPrepareIdentity, type ReceiptPrepareQueue } from './purchase-lifecycle-receipt-prepare-queue';
import type { LifecycleReceiptPrepareLease } from './purchase-lifecycle-receipt-prepare-coordinator';
import { assertReceiptImageLease, bindReceiptImage, leaseReceiptImageTask, normalizeReceiptImageLedger, recordReceiptImageReplay, transitionReceiptImageTask, type ReceiptImageLedger, type ReceiptImageTask } from './purchase-lifecycle-receipt-image-ledger';
import { extractVerifiedLifecycleReceiptImage, matchVerifiedLifecycleReceiptImage, type LifecycleReceiptImageIntent, type VerifiedLifecycleReceiptImageSnapshot } from './purchase-lifecycle-receipt-image-binding';
import { beginLifecyclePaymentUpload, commitLifecyclePaymentUpload, markLifecyclePaymentUploadUncertain, planLifecyclePaymentUpload, purchaseLifecyclePaymentRequestKey, recordLifecyclePaymentUpload, validateLifecyclePaymentUploadEntry, type LifecyclePaymentUploadAuthority, type LifecyclePaymentUploadDecision, type LifecyclePaymentUploadEntry, type LifecyclePaymentUploadRequest } from './purchase-lifecycle-payment-upload';
import type { LifecyclePaymentUploadIdentity, LifecyclePaymentUploadSelector } from './purchase-lifecycle-payment-upload-isolated';
import type { LifecyclePaymentPerFileTask, LifecyclePaymentFileSnapshot } from './purchase-lifecycle-payment-upload-per-file';
import type { PurchasePlatformIdentityProof } from './purchase-platform-identity-proof';
import { normalizeAccessDisplayName } from '../../common/access/access-display-name';
import { planPlatformApproval, type PlatformApprovalRequest, type PlatformApprovalPersistedAction, type PlatformApprovalPlan } from './purchase-platform-approval-plan';
import type { PlatformApprovalWorkerJob, PlatformApprovalWorkerStore } from './purchase-platform-approval-coordinator';
import { buildPlatformLegacyApprovalPatch, confirmPlatformLegacyApprovalResult, isSelectablePlatformLegacyPurchaseMethod, type PlatformLegacyApprovalClaim, type VerifiedPlatformLegacyCardResolution } from './purchase-platform-legacy-approval-policy';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AccessRole } from '../../../shared/access-control.interface';
import type { PurchaseWorkflowAction, PurchaseWorkflowUser, PurchaseWorkflowRecord, PurchaseWorkflowMethod } from '../../../shared/purchase-workflow.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  parsePurchaseManagerApprovalCardContext,
  serializePurchaseManagerApprovalCardContext,
} from './purchase-manager-approval-card';
import {
  parsePurchaseManagerBatchApprovalCardContext,
  serializePurchaseManagerBatchApprovalCardContext,
  type PurchaseManagerBatchApprovalChoice,
  type PurchaseManagerBatchItemStatus,
} from './purchase-manager-batch-approval-card';
import { PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION } from './purchase-manager-approval.fields';
import { isBuildingSelfPurchaseAllowed } from './purchase-procurement-method-policy';
import { normalizeWarehouseInboundHandovers, normalizeWarehouseInboundHandoverInput, resolveWarehouseInboundRecipient, warehouseInboundHandoverFingerprint,
  type WarehouseInboundHandover, type WarehouseInboundHandoverInput } from './purchase-warehouse-handover';
import { singleManagerCardVersion, singleManagerReceiptVersion, singleManagerAcceptedVersion, validSingleManagerHandover, type PurchaseSingleManagerHandover, type PurchaseSingleManagerHandoverInput } from './purchase-single-handover';
import { normalizePurchaseAuthorityTarget, purchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';
import { resolvePurchaseStage } from './purchase-workflow.rules';
import { normalizePurchaseExecutorHandover, purchaseExecutorVersion, purchaseExecutorReceiptVersion, type PurchaseExecutorHandover, type PurchaseExecutorHandoverInput } from './purchase-executor-handover';
import { legacyApprovalVersion, legacyApprovalReceiptVersion, legacyApprovalAcceptedVersion, type PurchaseLegacyApprovalHandoverInput } from './purchase-legacy-approval-handover';
import { normalizeWebReceiptCommand, webReceiptRecoveryVersion, type PurchaseWebReceiptCommand } from './purchase-web-receipt-command';
import type { PersonnelRecoveryActor, PersonnelRecoveryRequest } from '../../../shared/personnel-task-recovery.interface';
import { assertRecoveryRequest } from '../../common/access/personnel-task-recovery.validation';
import { FairOperationQueue } from '../../common/fair-operation-queue';
import { newPurchaseReplica, purchaseReplicaUuid, planPurchaseReplica, beginPurchaseReplicaSend, beginPurchaseReplicaUpdate, confirmPurchaseReplicaSend, confirmPurchaseReplicaUpdate, continueExpiredPurchaseReplica, type PurchaseReplica, type PurchaseReplicaIdentity, type VerifiedPurchaseReplicaReceipt } from './purchase-lifecycle-replica';

export const PURCHASE_WORKFLOW_LEDGER_PATH = Symbol(
  'PURCHASE_WORKFLOW_LEDGER_PATH',
);
const MAX_COMMANDS = 500;
const MAX_REMINDERS = 500;
const MAX_CARD_ACTIONS = 500;
const MAX_NOTIFICATIONS = 500;
const MAX_MANAGER_APPROVAL_ACTIONS = 500;
const MAX_MANAGER_APPROVAL_BATCHES = 500;
const STAGE_SOURCE_ORDERING_HOLD_ERROR = '多维表显示待下单，缺少审批回执和采购人，需人工核对原单';
const MAX_MANAGER_APPROVAL_BATCH_ACTIONS = 500;
const MAX_LIFECYCLE_REPLICAS = 2000;
const MAX_LIFECYCLE_GENERATIONS = 100;
const LIFECYCLE_PREPARED_LEASE_MS = 120_000;
const LIFECYCLE_CARD_LIFETIME_MS = 14 * 86400_000;
const MAX_ERROR_LENGTH = 500;
const MAX_COMMAND_WARNINGS = 20;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const INVALID_LOCK_REREAD_DELAY_MS = 100;
const INVALID_LOCK_GRACE_MS = 5_000;
const STARTUP_LOCK_RETRY_DELAY_MS = 100;
const STARTUP_LOCK_MAX_RETRIES = 20;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_BUSINESS_EVENT_ID_LENGTH = 256;
const MAX_OPEN_ID_LENGTH = 128;
const MAX_DELIVERY_ID_LENGTH = 256;
const MAX_CARD_CONTEXT_LENGTH = 8_000;
const MAX_DELIVERY_AUDIT_ENTRIES = 1_000;
const MANAGER_DELIVERY_UNKNOWN_WINDOW_MS = 60 * 60 * 1000;
const MANAGER_CARD_RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIPT_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;
const OPEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FEISHU_MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,256}$/;
const INTERACTIVE_MESSAGE_UUID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_SOURCE =
  '(?:tenant[_-]?access[_-]?token|access[_-]?token|verification[_-]?token|encrypt[_-]?key|app[_-]?secret|password|secret|token)';
const QUOTED_SECRET_PATTERN = new RegExp(
  `(["']?${SENSITIVE_KEY_SOURCE}["']?\\s*[:=]\\s*)(["'])([^"'\\r\\n]*)\\2`,
  'gi',
);
const PLAIN_SECRET_PATTERN = new RegExp(
  `\\b(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)([^\\s,;}&]+)`,
  'gi',
);

interface SharedLedgerState {
  ledgerPath: string;
  lockPath: string;
  instanceId: string;
  operation: FairOperationQueue;
  readCache?: { source: Buffer; ledger: PurchaseWorkflowLedger };
  readOnlyOperation?: boolean;
  refCount: number;
  lockPromise: Promise<void> | null;
  lockOwned: boolean;
}

interface LedgerLockOwner {
  pid: number;
  instanceId: string;
}

class LedgerLockContentionException extends ServiceUnavailableException {}

type LedgerLockInspection =
  | { kind: 'owner'; owner: LedgerLockOwner }
  | { kind: 'invalid' }
  | { kind: 'missing' };

const sharedLedgerStates = new Map<string, SharedLedgerState>();

export type PurchaseWorkflowQueueStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export interface PurchaseWorkflowCardActionClaimInput {
  deliveryMessageId?: string;
  eventId: string;
  recordId: string;
  action: 'approve' | 'reject';
  actorOpenId: string;
}

export interface PurchaseWorkflowCardActionEntry {
  authority?: PurchaseCardActionAuthority;
  plannedPurchaser?: Pick<PurchaseWorkflowUser, 'openId' | 'name'>;
  key: string;
  eventId: string;
  recordId: string;
  action: 'approve' | 'reject';
  actorOpenId: string;
  status: PurchaseWorkflowQueueStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
}

export interface PurchaseCardActionAuthority { appId: string; scope: PurchaseAuthorityTarget; }

export type PurchaseWorkflowNotificationKind =
  | 'web_receipt_command'
  | 'approval_requested'
  | 'approval_transferred'
  | 'approval_resolved'
  | 'purchase_assigned'
  | 'purchase_rejected'
  | 'warehouse_inbound'
  | 'inventory_inbound_completed_resolution'
  | 'inventory_inbound_completed'
  | 'manual_inventory_inbound_completed_resolution'
  | 'manual_inventory_inbound_completed'
  | 'purchase_completed'
  | 'purchase_order_completed'
  | PurchaseManagerApprovalNotificationKind;

export type PurchaseManagerApprovalNotificationKind =
  | 'manager_approval_requested'
  | 'manager_approval_transferred'
  | 'manager_approval_resolved'
  | 'manager_approval_reopened'
  | 'manager_approval_attention_required'
  | 'manager_batch_approval_requested'
  | 'manager_batch_approval_refresh'
  | 'manager_batch_approval_result'
  | 'manager_batch_approval_attention_required'
  | 'manager_batch_purchase_assigned'
  | 'manager_batch_purchase_refresh'
  | 'manager_batch_executor_transferred'
  | 'manager_batch_receipt_requested'
  | 'manager_batch_receipt_refresh'
  | 'manager_batch_receipt_completed'
  | 'manager_batch_receipt_attachment'
  | 'manager_batch_order_command'
  | 'manager_batch_receipt_command';

export type PurchaseManagerApprovalSendOutcome =
  | 'unattempted'
  | 'unknown'
  | 'delivered'
  | 'manual_reconciliation';

export type PurchaseWorkflowNotificationStatus =
  | PurchaseWorkflowQueueStatus
  | 'manual_reconciliation';

export interface PurchaseManagerApprovalDeliveryAuditEntry {
  action:
    | 'send_started'
    | 'send_delivered'
    | 'send_rejected'
    | 'card_schema_v2_compatible'
    | 'legacy_card_schema_requeued'
    | 'receipt_delivery_requeued'
    | 'receipt_card_schema_requeued'
    | 'card_update_completed'
    | 'delivery_unknown_timeout'
    | 'operator_verified_delivered'
    | 'operator_verified_absent'
    | 'comparison_image_requeued'
    | 'lifecycle_replica_bound'
    | 'callback_bound'
    | 'replacement_bound';
  at: string;
  operatorOpenId: string;
  generation: number;
  deliveryUuid: string;
  messageId: string;
}

export interface PurchaseManagerLegacyCardRecoveryEvidence {
  approvalPolicyVersion: string;
  externalError: string;
}

export type PurchaseManagerApprovalChoice =
  | 'comprehensive'
  | 'building_self'
  | 'reject';

export type PurchaseManagerApprovalCardState =
  | 'initial'
  | 'reject_editing'
  | 'pending'
  | 'resolved'
  | 'manual_reconciliation';

export type PurchaseManagerApprovalActionStatus =
  | PurchaseWorkflowQueueStatus
  | 'manual_reconciliation';

export interface PurchaseManagerApprovalActionEntry {
  key: string;
  eventId: string;
  recordId: string;
  choice: PurchaseManagerApprovalChoice;
  rejectionReason: string;
  messageId: string;
  actorOpenId: string;
  status: PurchaseManagerApprovalActionStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
}

export interface PurchaseManagerApprovalActionClaimInput {
  eventId: string;
  recordId: string;
  choice: PurchaseManagerApprovalChoice;
  rejectionReason?: string;
  messageId: string;
  actorOpenId: string;
}

export interface PurchaseManagerApprovalCardIdentity {
  recordId: string;
  messageId: string;
  actorOpenId: string;
}

export interface PurchaseManagerApprovalCallbackBindingInput {
  recordId: string;
  messageId: string;
  actorOpenId?: string;
  recipientOpenId?: string;
}

export interface PurchaseManagerApprovalReplacementInput {
  oldMessageId: string;
  newMessageId: string;
  deliveryId?: string;
}

export interface PurchaseManagerApprovalCardEntry {
  personnelHandover?: PurchaseSingleManagerHandover;
  key: string;
  executionRecordId: string;
  messageId: string;
  supersededMessageIds: string[];
  recipientOpenId: string;
  sourceNotificationKey: string;
  sourceKind: 'manager_approval_requested';
  sourceStatus: 'completed';
  cardContext: string;
  state: PurchaseManagerApprovalCardState;
  choice: PurchaseManagerApprovalChoice | '';
  rejectionReasonDraft: string;
  actionEventId: string;
  actorOpenId: string;
  processedAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string;
}

export type PurchaseManagerApprovalBatchState =
  | 'awaiting_delivery'
  | 'active'
  | 'reject_editing'
  | 'processing'
  | 'resolved'
  | 'manual_reconciliation';

export interface PurchaseManagerApprovalBatchItemEntry {
  decisionSource?: 'platform';
  executorHandover?: PurchaseExecutorHandover;
  authorityTarget?: PurchaseAuthorityTarget;
  executionRecordId: string;
  status: PurchaseManagerBatchItemStatus;
  choice: PurchaseManagerBatchApprovalChoice;
  rejectionReason: string;
  actionEventId: string;
  actorOpenId: string;
  processedAt: string;
  lastError: string;
  purchaserOpenId: string;
  purchaserName: string;
  paymentAttachmentTokens: string[];
  receiptPhotoTokens: string[];
  invoiceTokens: string[];
}

export interface PurchaseManagerApprovalBatchPurchaserSnapshot {
  authorityTarget?: PurchaseAuthorityTarget;
  purchaserOpenId: string;
  purchaserName: string;
}

export interface PurchaseBatchFulfillmentCardIdentity {
  approvalBatchId: string;
  messageId: string;
  actorOpenId: string;
  role: 'purchaser' | 'requester';
  lifecycle?: { appId: string; cardRevision: number; formToken?: string };
}
export interface LifecycleReceiptPreparationView {
  taskId:string; executionRecordId:string; recipientOpenId:string; cardMessageId:string;
  materialType:'receipt_photo'|'invoice'; state:'pending'|'ready'|'failed'; intentId?:string; intentExpiresAtMs?:number;
}

export interface PurchaseManagerApprovalBatchEntry {
  flowVersion?: 'legacy' | 'lifecycle_v1';
  stageCardTransition?: PurchaseLifecycleStageCardTransitionReceipt;
  lifecycleAppId?: string;
  lifecycleInitialRecipients?: Array<{ openId: string; fullView: boolean }>;
  lifecycleAuthorityTargets?: Array<{ recordId: string; target: PurchaseAuthorityTarget }>;
  approvalBatchId: string;
  recipientOpenId: string;
  requesterOpenId: string;
  recordIds: string[];
  items: PurchaseManagerApprovalBatchItemEntry[];
  state: PurchaseManagerApprovalBatchState;
  selectedRejectRecordId: string;
  sourceNotificationKey: string;
  messageId: string;
  cardContext: string;
  revision: number;
  actorOpenId: string;
  processedAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string;
  pendingReceiptUpload?: PurchaseBatchReceiptUploadIntent;
  managerDeliveries?: PurchaseManagerApprovalDelivery[];
}

export interface PurchaseLifecycleStageCardTransitionInput {
  approvalBatchId: string;
  appId: string;
  batchRevision: number;
  verifiedAt: number;
  records: readonly PurchaseWorkflowRecord[];
  /** Record-not-found receipts from the same authenticated Feishu source. */
  missingRecordIds?: readonly string[];
  replicas: ReadonlyArray<{
    recipientOpenId: string;
    messageId: string;
    generation: number;
    appliedRevision: number;
  }>;
}

export interface PurchaseLifecycleStageCardTransitionCandidate {
  approvalBatchId: string;
  appId: string;
  batchRevision: number;
  recordIds: string[];
  replicas: Array<PurchaseLifecycleStageCardTransitionInput['replicas'][number] & {
    sentAtMs: number;
    managerApproval: boolean;
  }>;
}

export interface PurchaseLifecycleStageCardTransitionReceipt {
  version: 1;
  appId: string;
  switchedAt: string;
  originalRevision: number;
  originalBatchSha256: string;
  originalOutboxSha256: string;
  sourceReadbackSha256: string;
  originalCardContext: string;
  archivedMessageIds: string[];
  retirementMessageIds: string[];
  retiredCards: Array<{ messageId: string; retiredAt: string }>;
  originalState: PurchaseManagerApprovalBatchState;
  originalResolvedAt: string;
  initialRecipients: NonNullable<PurchaseManagerApprovalBatchEntry['lifecycleInitialRecipients']>;
  authorityTargets: NonNullable<PurchaseManagerApprovalBatchEntry['lifecycleAuthorityTargets']>;
  missingRecordIds: string[];
  heldSourceItems?: Array<{ recordId: string; reason: 'ordering_without_approval_receipt' }>;
  heldTerminalOrders?: Array<{ recordId: string; claimSha256: string }>;
  reopenedItems: Array<{
    recordId: string;
    actionEventId: string;
    actorOpenId: string;
    choice: PurchaseManagerApprovalBatchItemEntry['choice'];
    rejectionReason: string;
    processedAt: string;
    lastError: string;
  }>;
}

export interface PurchaseManagerApprovalDelivery {
  recipientOpenId: string;
  recipientName: string;
  sourceNotificationKey: string;
  messageId: string;
  selectedRejectRecordId: string;
}

export interface PurchaseBatchReceiptUploadIntent {
  executionRecordId: string;
  materialType: 'receipt_photo' | 'invoice';
  actorOpenId: string;
  messageId: string;
  createdAt: string;
  expiresAt: string;
  lifecycle?: { appId: string; cardRevision: number };
}

export type PurchaseManagerApprovalBatchActionStatus =
  | PurchaseWorkflowQueueStatus
  | 'manual_reconciliation';

export interface PurchaseManagerApprovalBatchActionEntry {
  key: string;
  eventId: string;
  approvalBatchId: string;
  recordIds: string[];
  choice: Exclude<PurchaseManagerBatchApprovalChoice, ''>;
  rejectionReason: string;
  messageId: string;
  actorOpenId: string;
  status: PurchaseManagerApprovalBatchActionStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
}

export interface PurchaseManagerApprovalBatchRegistrationInput {
  flowVersion?: 'legacy' | 'lifecycle_v1';
  approvalBatchId: string;
  recipientOpenId: string;
  requesterOpenId: string;
  recordIds: string[];
  managers?: Array<{ openId: string; name: string }>;
}

export interface PurchaseManagerReceiptBatchRecoveryInput extends PurchaseManagerApprovalBatchRegistrationInput {
  cardContext: string;
  batchIdSource?: 'derived' | 'persisted';
  createIfMissing?: boolean;
  delivered?: {
    messageId: string;
    deliveryUuid: string;
    attempts: number;
    deliveredAt: Date | number;
  };
  items: Array<{
    executionRecordId: string;
    choice: 'comprehensive' | 'building_self';
    purchaserOpenId: string;
    purchaserName: string;
    actualQuantity: number;
    actualAmount: number;
    note?: string;
    paymentAttachmentTokens?: string[];
  }>;
}

export type PurchaseManagerReceiptBatchRecoveryOutcome =
  | 'queued'
  | 'existing_pending'
  | 'existing_delivered'
  | 'rehydrated_delivered'
  | 'missing';

export interface PurchaseManagerApprovalBatchCardIdentity {
  approvalBatchId: string;
  messageId: string;
  actorOpenId: string;
  lifecycle?: { appId: string; cardRevision: number; formToken?: string };
}

export interface PurchaseManagerApprovalBatchCallbackBindingInput {
  approvalBatchId: string;
  messageId: string;
  actorOpenId: string;
}

export interface PurchaseManagerApprovalBatchPendingClaimInput extends PurchaseManagerApprovalBatchCardIdentity {
  eventId: string;
  choice: 'comprehensive' | 'building_self';
}

export interface PurchaseManagerApprovalBatchRejectClaimInput extends PurchaseManagerApprovalBatchCardIdentity {
  eventId: string;
  executionRecordId: string;
  rejectionReason: string;
}

export interface PurchaseManagerApprovalBatchItemApprovalClaimInput extends PurchaseManagerApprovalBatchCardIdentity {
  eventId: string;
  executionRecordId: string;
  choice: 'comprehensive' | 'building_self';
}

export interface PurchaseWorkflowNotificationInput {
  businessEventId: string;
  recordId: string;
  recipientOpenId: string;
  kind: PurchaseWorkflowNotificationKind;
  cardContext?: string;
}

export interface PurchaseWorkflowNotificationEntry {
  lifecycleBinding?: { appId: string; deliveryUuid: string; generation: number; revision: number; messageId: string };
  webReceipt?: PurchaseWebReceiptCommand;
  approvalHandover?: PurchaseSingleManagerHandover;
  approvalAuthority?: PurchaseCardActionAuthority;
  acceptedAppId?: string;
  key: string;
  businessEventId: string;
  recordId: string;
  recipientOpenId: string;
  kind: PurchaseWorkflowNotificationKind;
  status: PurchaseWorkflowNotificationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
  deliveryId: string;
  messageId: string;
  deliveryUuid: string;
  firstSendAttemptAt: string;
  sendOutcome: PurchaseManagerApprovalSendOutcome;
  deliveryGeneration: number;
  cardContext: string;
  deliveryAudit: PurchaseManagerApprovalDeliveryAuditEntry[];
}

export interface PurchaseWorkflowNotificationDelivery {
  deliveryId?: string;
  messageId?: string;
  businessStage?: 'completed' | 'terminated';
}

export interface PurchaseFulfillmentClaimProof { notificationKey: string; claimToken: string; }
export interface PurchaseAcceptedFulfillment {
  proof: PurchaseFulfillmentClaimProof & { appId: string; cardContext: string; lifecycleAuthority?: { batchId: string; recordId: string; actorOpenId: string; choice: 'comprehensive' | 'building_self'; building: string; specialty?: string; stageCards?: true } };
  actor: PurchaseWorkflowUser;
  /** Original, lock-authorized web receipt identity; not a reusable session proof. */
  platformIdentity?: PurchasePlatformIdentityProof;
  building: string;
  specialty?: string;
}

export interface PurchaseWorkflowCommandEntry {
  key: string;
  recordId: string;
  action: PurchaseWorkflowAction;
  fingerprint: string;
  expectedResultFingerprint: string;
  actorOpenId: string;
  accessRole: AccessRole | 'unknown';
  authenticationMode: 'feishu-oauth' | 'delegated-app' | 'unknown';
  startedAt: string;
  completedAt: string;
  notificationWarnings: string[];
  orderNotice?: PurchaseOrderNotice;
  platformIdentity?: PurchasePlatformIdentityProof;
  platformDispatch?: 'prepared' | 'dispatch_started';
  platformAttemptId?: string;
}

export interface PurchaseOrderNotice {
  recipientOpenIds: string[];
  text: string;
  deferUntilFulfillment?: boolean;
}

export interface PurchaseWorkflowCommandClaimInput {
  key: string;
  recordId: string;
  action: PurchaseWorkflowAction;
  fingerprint: string;
  expectedResultFingerprint: string;
  actorOpenId: string;
  accessRole: AccessRole | 'unknown';
  authenticationMode: 'feishu-oauth' | 'delegated-app' | 'unknown';
  startedAt: string;
  orderNotice?: PurchaseOrderNotice;
  platformIdentity?: PurchasePlatformIdentityProof;
}

type PurchaseWorkflowCommandRecordInput = Omit<
  PurchaseWorkflowCommandEntry,
  'fingerprint' | 'expectedResultFingerprint' | 'startedAt'
> &
  Partial<
    Pick<
      PurchaseWorkflowCommandEntry,
      'fingerprint' | 'expectedResultFingerprint' | 'startedAt'
    >
  >;

export interface PurchaseManagerBatchHandoverInput {
  approvalBatchId: string;
  expectedRevision: number;
  mutationId: string;
  dutyRecordId: string;
  sourcePersonRecordId: string;
  sourceOpenId: string;
  target: { personRecordId: string; openId: string; name: string };
}

export interface PurchaseManagerBatchHandover extends PurchaseManagerBatchHandoverInput {
  fingerprint: string;
  targetRevision: number;
  pendingRecordIds: string[];
  oldMessageId: string;
  oldCardContext: string;
  acceptedAt: string;
  status: PurchaseWorkflowQueueStatus;
  attempts: number;
  claimToken: string;
  leaseUntil: string;
  nextAttemptAt: string;
  oldCardPatchedAt?: string;
  confirmedRecordIds: string[];
  lastError: string;
  deliveryClaimToken?: string;
  deliveryLeaseUntil?: string;
  deliveryNextAttemptAt?: string;
  deliveryError?: string;
  deliveryConfirmedAt?: string;
  newMessageId?: string;
  deliveryConfirmedRecordIds?: string[];
}

export type PurchaseLifecycleView = { kind: 'list' } | { kind: 'reject' | 'order' | 'receipt'; recordId: string };
export interface PurchaseLifecycleOutboxEntry {
  replica: PurchaseReplica;
  desiredRevision: number;
  desiredPage: number;
  appliedPage: number;
  appliedTotalPages?: number;
  appliedAuthorizationFingerprint?: string;
  pendingPage?: number;
  desiredView?: PurchaseLifecycleView;
  pendingView?: PurchaseLifecycleView;
  appliedView?: PurchaseLifecycleView;
  viewEvents?: Array<{ eventId: string; sourceRevision: number; kind: string; recordId: string }>;
  pageEvents: Array<{ eventId: string; sourceRevision: number; targetPage: number }>;
  stageEvents: Array<{ notificationKey: string; targetRevision: number }>;
  nextAttemptAtMs: number;
  failureCount: number;
  retryReason?: 'source' | 'authorization';
  attemptToken: string;
  dispatchPhase?: 'prepared' | 'dispatch_started';
  preparedUntilMs?: number;
  fullView?: true;
  history: Array<{ generation: number; messageId: string; sentAtMs: number; appliedRevision: number }>;
}

export interface PurchaseLifecycleInitialRegistration {
  appId: string;
  recipients: ReadonlyArray<{ openId: string; fullView: boolean }>;
  authorityTargets: ReadonlyArray<{ recordId: string; target: PurchaseAuthorityTarget }>;
  authorize: (recipient: { openId: string; fullView: boolean }, batch: PurchaseManagerApprovalBatchRegistrationInput, targets: ReadonlyArray<{ recordId: string; target: PurchaseAuthorityTarget }>) => void;
}

interface PurchaseWorkflowLedger {
  requiredRuntimeCapability?: string;
  version: 2;
  commands: PurchaseWorkflowCommandEntry[];
  reminders: string[];
  cardActions: PurchaseWorkflowCardActionEntry[];
  notifications: PurchaseWorkflowNotificationEntry[];
  managerApprovalActions: PurchaseManagerApprovalActionEntry[];
  managerApprovalCards: PurchaseManagerApprovalCardEntry[];
  managerApprovalBatches: PurchaseManagerApprovalBatchEntry[];
  managerApprovalBatchActions: PurchaseManagerApprovalBatchActionEntry[];
  /** Isolated platform approvals; no production worker or controller is registered yet. */
  platformApprovalClaims?: PlatformApprovalPersistedAction[];
  platformApprovalWork?: PlatformApprovalWork[];
  platformLegacyApprovalClaims?: PlatformLegacyApprovalEntry[];
  personnelHandovers: PurchaseManagerBatchHandover[];
  warehouseInboundHandovers: WarehouseInboundHandover[];
  lifecycleOutbox?: PurchaseLifecycleOutboxEntry[];
  lifecycleFormCredentials?: PurchaseLifecycleFormCredential[];
  lifecyclePaymentUploads?: LifecyclePaymentUploadStoredEntry[];
  lifecyclePaymentBlocks?: LifecyclePaymentUploadBlock[];
  lifecycleReceiptPrepareQueue?: ReceiptPrepareQueue;
  lifecycleReceiptImageLedger?: ReceiptImageLedger;
  lifecycleReceiptImageSource?: { appId:string; sourceFingerprint:string };
}

interface PlatformApprovalWork {
  eventId: string;
  phase: 'queued' | 'leased' | 'dispatching' | 'manual' | 'confirmed' | 'completed';
  leaseToken: string;
  leaseStartedAtMs: number;
  leaseUntilMs: number;
  dispatchStartedAtMs?: number;
  patchHash?: string;
  purchaser?: { openId: string; name: string };
  resultHash?: string;
  reason?: string;
}

/** Isolated historical website claim. This is not a batch or a Feishu action. */
export interface PlatformLegacyApprovalEntry {
  eventId: string; serverActionId: string; fingerprint: string; acceptedAtMs: number;
  appId: string;
  sourceFingerprint: string;
  recordId: string; decision: 'approved' | 'rejected'; originalPurchaseMethod: string;
  /** Final written method; legacy entries without it keep the original method. */
  purchaseMethod?: string;
  originalRequesterOpenId: string; authorityTarget: PurchaseAuthorityTarget;
  originalBatchId: string;
  identity: PurchasePlatformIdentityProof;
  cards: Array<{ key: string; messageId: string; recipientOpenId: string }>;
  phase: 'queued'|'leased'|'dispatching'|'manual'|'confirmed'|'completed';
  leaseToken?: string; leaseStartedAtMs?: number; leaseUntilMs?: number;
  dispatchStartedAtMs?: number; patchHash?: string; resultHash?: string; completedAtMs?: number;
}
export interface PlatformLegacyApprovalStatus {
  recordId:string; decision:'approved'|'rejected'; status:'pending'|'running'|'completed'|'manual_reconciliation';
  acceptedAtMs:number; completedAtMs?:number;
}
export interface LifecycleReceiptImageAuthorizationContext {
  batch: PurchaseManagerApprovalBatchEntry;
  item: PurchaseManagerApprovalBatchItemEntry;
  intent: LifecycleReceiptImageIntent;
}

interface LifecyclePaymentUploadStoredEntry {
  appId: string;
  approvalBatchId: string;
  executionRecordId: string;
  actorOpenId: string;
  generation: number;
  entry: LifecyclePaymentUploadEntry;
  perFile?: Array<LifecyclePaymentFileSnapshot & { token?: string }>;
}

interface LifecyclePaymentUploadBlock {
  key: string;
  appId: string;
  approvalBatchId: string;
  executionRecordId: string;
  actorOpenId: string;
  generation: number;
  cancelledAtMs: number;
}
export type LifecyclePaymentUploadPublicStatus = 'not_found' | 'prepared' | 'resumable' | 'dispatching' | 'uploaded' | 'completed' | 'manual_reconciliation' | 'cancelled';

export type LifecyclePaymentUploadLockedAuthorization = (batch: PurchaseManagerApprovalBatchEntry, replica: PurchaseReplica, item: PurchaseManagerApprovalBatchItemEntry) => void;

interface PurchaseLifecycleFormCredential {
  hash: string;
  appId: string;
  actorOpenId: string;
  messageId: string;
  binding: PurchaseLifecycleFormBinding;
  expiresAtMs: number;
  consumedByEventId?: string;
}

export interface PurchaseLifecycleFormCredentialIdentity {
  appId: string;
  actorOpenId: string;
  messageId: string;
}

@Injectable()
export class PurchaseWorkflowStore {
  private readonly ledgerPath: string;
  private readonly sharedState: SharedLedgerState;
  private destroyed = false;

  constructor(
    @Optional() @Inject(PURCHASE_WORKFLOW_LEDGER_PATH) ledgerPath?: string,
  ) {
    this.ledgerPath = resolve(
      ledgerPath ||
        readEnv('PURCHASE_WORKFLOW_LEDGER_PATH') ||
        '.runtime/purchase-workflow-ledger.json',
    );
    this.sharedState = getSharedLedgerState(this.ledgerPath);
    this.sharedState.refCount += 1;
  }

  async onModuleInit(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.ensureLock();
        return;
      } catch (error) {
        if (
          !(error instanceof LedgerLockContentionException) ||
          attempt >= STARTUP_LOCK_MAX_RETRIES
        ) {
          throw error;
        }
        await delay(STARTUP_LOCK_RETRY_DELAY_MS);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sharedState.refCount = Math.max(0, this.sharedState.refCount - 1);
    if (this.sharedState.refCount > 0) return;

    await this.sharedState.operation.idle();
    if (this.sharedState.refCount > 0) return;
    await releaseLedgerLock(this.sharedState);
    if (sharedLedgerStates.get(this.ledgerPath) === this.sharedState) {
      sharedLedgerStates.delete(this.ledgerPath);
    }
  }

  /** Authorization must use current trusted duties and run synchronously within this ledger lock. */
  async issueLifecycleFormCredential(
    identity: PurchaseLifecycleFormCredentialIdentity,
    binding: PurchaseLifecycleFormBinding,
    authorize: (batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry) => void,
    now: Date | number = new Date(),
  ): Promise<string> {
    return this.enqueueCard(async () => {
      const time = resolveNow(now).getTime();
      const ledger = await this.read();
      if (typeof authorize !== 'function') throw new ForbiddenException('采购表单缺少职责校验');
      assertLifecycleFormBindingShape(identity, binding);
      const matches = ledger.managerApprovalBatches.filter(row => row.approvalBatchId === binding.approvalBatchId);
      if (matches.length !== 1) throw new ConflictException('采购表单批次不存在');
      const batch = matches[0]!;
      assertLifecycleCallbackWithinLedger(ledger, batch, { approvalBatchId: binding.approvalBatchId, actorOpenId: identity.actorOpenId, messageId: identity.messageId, lifecycle: { appId: identity.appId, cardRevision: binding.cardRevision } });
      const item = batch.items.find(row => row.executionRecordId === binding.executionRecordId);
      if (!item) throw new ConflictException('采购表单明细不存在');
      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(item)));
      const credentials = (ledger.lifecycleFormCredentials || []).filter(row => row.expiresAtMs > time);
      if (credentials.length >= 5000) throw new ServiceUnavailableException('采购表单队列已满');
      const token = randomBytes(32).toString('base64url');
      credentials.push({ hash: lifecycleFormTokenHash(token), ...identity, binding: structuredClone(binding), expiresAtMs: time + 60 * 60 * 1000 });
      ledger.lifecycleFormCredentials = credentials;
      await this.write(ledger);
      return token;
    });
  }

  /** This read is only for decoding form fields; each claim must re-check and consume atomically. */
  async lookupLifecycleFormCredential(token: string, identity: PurchaseLifecycleFormCredentialIdentity, now: Date | number = new Date()): Promise<PurchaseLifecycleFormBinding> {
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const entry = findLifecycleFormCredential(ledger, token, identity, resolveNow(now).getTime());
      return structuredClone(entry.binding);
    });
  }

  private lifecyclePaymentUploadAuthority(ledger: PurchaseWorkflowLedger, identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, authorize: LifecyclePaymentUploadLockedAuthorization): LifecyclePaymentUploadAuthority {
    if (!identity || typeof identity.assertCurrent !== 'function' || !selector || typeof authorize !== 'function' || identity.appId !== readEnv('FEISHU_APP_ID') ||
      !Number.isSafeInteger(selector.generation) || selector.generation < 1 || !BATCH_ID_PATTERN.test(selector.approvalBatchId) || !RECORD_ID_PATTERN.test(selector.executionRecordId)) throw new ForbiddenException('采购付款附件身份不可用');
    assertSynchronousLifecycleAuthorization(() => identity.assertCurrent());
    // Payment files and receipt images belong to the same frozen execution
    // source. Check inside every reservation/dispatch/commit transaction so a
    // fresh session after restart cannot adopt an older source's upload task.
    const paymentSource = ledger.lifecycleReceiptImageSource;
    if (!paymentSource || !identity.uploadSourceFingerprint || paymentSource.appId !== identity.appId || paymentSource.sourceFingerprint !== identity.uploadSourceFingerprint) throw new ConflictException('采购付款附件持久来源不可核对');
    const batchMatches = ledger.managerApprovalBatches.filter(row => row.approvalBatchId === selector.approvalBatchId);
    const batch = batchMatches[0];
    if (batchMatches.length !== 1 || !batch || batch.flowVersion !== 'lifecycle_v1' || batch.lifecycleAppId !== identity.appId) throw new ConflictException('采购付款批次不可用');
    const items = batch.items.filter(row => row.executionRecordId === selector.executionRecordId), item = items[0];
    if (items.length !== 1 || !item || item.status !== 'approved' || item.purchaserOpenId !== identity.openId || (item.executorHandover && !item.executorHandover.ready)) throw new ForbiddenException('采购付款职责或明细已变化');
    if (ledger.commands.some(row => row.recordId === selector.executionRecordId && row.action === 'order') || ledger.notifications.some(row => row.recordId === selector.executionRecordId && row.kind === 'manager_batch_order_command' && row.status !== 'failed')) throw new ConflictException('采购下单已受理，不能继续上传付款附件');
    const outbox = findLifecycleEntry(ledger.lifecycleOutbox || [], { appId: identity.appId, batchId: selector.approvalBatchId, recipientOpenId: identity.openId });
    const replica = outbox.replica;
    if (replica.generation !== selector.generation || !replica.messageId) throw new ConflictException('采购卡片代次已变化');
    if (item.executorHandover?.supersededMessageIds.includes(replica.messageId)) throw new ConflictException('采购职责已转交');
    assertLifecycleCallbackWithinLedger(ledger, batch, { approvalBatchId: selector.approvalBatchId, actorOpenId: identity.openId, messageId: replica.messageId, lifecycle: { appId: identity.appId, cardRevision: replica.appliedRevision } });
    assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(replica), structuredClone(item)));
    let expectedOrigin = '';
    try { const configured = new URL(readEnv('PUBLIC_BASE_URL', ['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL'])); if (configured.protocol !== 'https:' || configured.username || configured.password) throw new Error(); expectedOrigin = configured.origin; } catch { throw new ForbiddenException('本站访问地址不可用'); }
    return { session: { accountId: identity.accountId, authorizationVersion: identity.authorizationVersion, appId: identity.appId, openId: identity.openId, kind: identity.kind, shared: false, impersonated: false, active: true, requiresPasswordChange: false },
      origin: identity.origin, expectedOrigin, csrfVerified: true, currentAppId: readEnv('FEISHU_APP_ID'),
      target: { flowVersion: 'lifecycle_v1', approvalBatchId: selector.approvalBatchId, executionRecordId: selector.executionRecordId, purchaserOpenId: item.purchaserOpenId,
        orderState: 'waiting', messageId: replica.messageId, generation: replica.generation, cardRevision: replica.appliedRevision, desiredRevision: outbox.desiredRevision,
        replicaState: replica.state as 'delivered', sentAtMs: replica.sentAtMs } };
  }

  /** Same-lock plan and reservation; the caller's authorize must use a current trusted source snapshot. */
  async reserveLifecyclePaymentUpload(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, authorize: LifecyclePaymentUploadLockedAuthorization): Promise<LifecyclePaymentUploadDecision> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const authority = this.lifecyclePaymentUploadAuthority(ledger, identity, selector, authorize);
      const rows = normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads === undefined ? [] : raw.lifecyclePaymentUploads);
      const candidate = planLifecyclePaymentUpload(authority, request, null, [], Date.now(), () => identity.assertCurrent());
      if (normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks === undefined ? [] : raw.lifecyclePaymentBlocks).some(block => block.key === candidate.entry.key)) throw new ConflictException('付款上传请求已取消');
      const existing = rows.find(row => row.entry.key === candidate.entry.key);
      if (existing && (existing.appId !== identity.appId || existing.approvalBatchId !== selector.approvalBatchId || existing.executionRecordId !== selector.executionRecordId || existing.actorOpenId !== identity.openId || existing.generation !== selector.generation)) throw new ConflictException('付款上传请求身份不匹配');
      if(existing?.perFile) throw new ConflictException('付款上传任务必须使用原逐文件入口');
      if(rows.some(row=>row.entry.key!==candidate.entry.key && row.appId===identity.appId && row.approvalBatchId===selector.approvalBatchId && row.executionRecordId===selector.executionRecordId && !['committed','cancelled'].includes(row.entry.status))) throw new ConflictException('该采购明细已有未完成付款上传');
      const other = rows.filter(row => row.entry.key !== candidate.entry.key && row.entry.status !== 'cancelled').flatMap(row => row.entry.contentKeys);
      const decision = planLifecyclePaymentUpload(authority, request, existing?.entry || null, other, Date.now(), () => identity.assertCurrent());
      if (decision.kind === 'new') {
        if (rows.length >= 2000) throw new ServiceUnavailableException('采购付款上传账本已满');
        if (!Array.isArray(raw.lifecyclePaymentUploads)) raw.lifecyclePaymentUploads = [];
        (raw.lifecyclePaymentUploads as unknown[]).push({ appId: identity.appId, approvalBatchId: selector.approvalBatchId, executionRecordId: selector.executionRecordId, actorOpenId: identity.openId, generation: selector.generation, entry: decision.entry });
        await this.writeLifecycleRaw(raw, original);
      }
      return structuredClone(decision);
    });
  }

  async beginLifecyclePaymentUpload(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, supplied: LifecyclePaymentUploadEntry, attemptId: string, authorize: LifecyclePaymentUploadLockedAuthorization): Promise<LifecyclePaymentUploadEntry> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const authority = this.lifecyclePaymentUploadAuthority(ledger, identity, selector, authorize), rows = normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads);
      const row = rows.find(candidate => candidate.entry.key === supplied?.key);
      if(row?.perFile) throw new ConflictException('付款上传任务必须使用原逐文件入口');
      if (!row || row.appId !== identity.appId || row.approvalBatchId !== selector.approvalBatchId || row.executionRecordId !== selector.executionRecordId || row.actorOpenId !== identity.openId || row.generation !== selector.generation || row.entry.fingerprint !== supplied.fingerprint || normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks === undefined ? [] : raw.lifecyclePaymentBlocks).some(block => block.key === row.entry.key)) throw new ConflictException('付款上传任务身份不匹配');
      const decision = planLifecyclePaymentUpload(authority, request, row.entry, rows.filter(other => other.entry.key !== row.entry.key && other.entry.status !== 'cancelled').flatMap(other => other.entry.contentKeys), Date.now(), () => identity.assertCurrent());
      if (decision.kind !== 'start') throw new ConflictException('付款上传任务不能重复发送');
      const updated = beginLifecyclePaymentUpload(decision.entry, attemptId);
      applyPaymentUploadEntry(paymentUploadStoredRow(raw, row.entry.key), updated); await this.writeLifecycleRaw(raw, original);
      return structuredClone(updated);
    });
  }

  /** New per-file tasks share the same rows, cancellation tombstones and lock as
   * the earlier payment path; no independent ledger can bypass its fences. */
  async reserveLifecyclePaymentPerFile(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector,request:LifecyclePaymentUploadRequest,authorize:LifecyclePaymentUploadLockedAuthorization):Promise<LifecyclePaymentPerFileTask> {
    return this.enqueue(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent(),authority=this.lifecyclePaymentUploadAuthority(ledger,identity,selector,authorize);
      const rows=normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads===undefined?[]:raw.lifecyclePaymentUploads),blocks=normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks===undefined?[]:raw.lifecyclePaymentBlocks);
      const candidate=planLifecyclePaymentUpload(authority,request,null,[],Date.now(),()=>identity.assertCurrent()),existing=rows.find(row=>row.entry.key===candidate.entry.key);
      if(blocks.some(block=>block.key===candidate.entry.key))throw new ConflictException('付款上传请求已取消');
      if(existing && (!existing.perFile || existing.appId!==identity.appId || existing.approvalBatchId!==selector.approvalBatchId || existing.executionRecordId!==selector.executionRecordId || existing.actorOpenId!==identity.openId || existing.generation!==selector.generation))throw new ConflictException('付款上传请求身份不匹配');
      if(rows.some(row=>row.entry.key!==candidate.entry.key && row.appId===identity.appId && row.approvalBatchId===selector.approvalBatchId && row.executionRecordId===selector.executionRecordId && !['committed','cancelled'].includes(row.entry.status)))throw new ConflictException('该采购明细已有未完成付款上传');
      const other=rows.filter(row=>row.entry.key!==candidate.entry.key && row.entry.status!=='cancelled').flatMap(row=>row.entry.contentKeys);
      if(existing) {
        // Revalidate original content and binding without treating confirmed
        // per-file results as permission to repeat an external write.
        const prepared:LifecyclePaymentUploadEntry={...existing.entry,status:'prepared'};delete prepared.attemptId;delete prepared.tokens;
        planLifecyclePaymentUpload(authority,request,prepared,other,Date.now(),()=>identity.assertCurrent());
        return lifecyclePaymentPerFilePublic(existing);
      }
      const decision=planLifecyclePaymentUpload(authority,request,null,other,Date.now(),()=>identity.assertCurrent());
      if(rows.length>=2000)throw new ServiceUnavailableException('采购付款上传账本已满');
      const perFile=request.files.map((file,index)=>({index,name:file.name.normalize('NFC'),sha256:file.sha256,size:file.size,state:'pending' as const}));
      const row={appId:identity.appId,approvalBatchId:selector.approvalBatchId,executionRecordId:selector.executionRecordId,actorOpenId:identity.openId,generation:selector.generation,entry:decision.entry,perFile};
      normalizeLifecyclePaymentUploads([row]);if(!Array.isArray(raw.lifecyclePaymentUploads))raw.lifecyclePaymentUploads=[];(raw.lifecyclePaymentUploads as unknown[]).push(row);
      await this.writeLifecycleRaw(raw,original);return lifecyclePaymentPerFilePublic(row);
    });
  }

  async beginLifecyclePaymentPerFile(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector,request:LifecyclePaymentUploadRequest,key:string,index:number,attemptId:string,authorize:LifecyclePaymentUploadLockedAuthorization):Promise<LifecyclePaymentPerFileTask> {
    return this.enqueue(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent(),authority=this.lifecyclePaymentUploadAuthority(ledger,identity,selector,authorize),rows=normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads);
      const row=rows.find(entry=>entry.entry.key===key);
      if(!row?.perFile || row.appId!==identity.appId || row.approvalBatchId!==selector.approvalBatchId || row.executionRecordId!==selector.executionRecordId || row.actorOpenId!==identity.openId || row.generation!==selector.generation || normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks===undefined?[]:raw.lifecyclePaymentBlocks).some(block=>block.key===key))throw new ConflictException('付款上传任务身份不匹配');
      const prepared:LifecyclePaymentUploadEntry={...row.entry,status:'prepared'};delete prepared.attemptId;delete prepared.tokens;
      planLifecyclePaymentUpload(authority,request,prepared,rows.filter(other=>other.entry.key!==key && other.entry.status!=='cancelled').flatMap(other=>other.entry.contentKeys),Date.now(),()=>identity.assertCurrent());
      if(!Number.isSafeInteger(index)||index<0||index>=row.perFile.length || !UUID_PATTERN.test(attemptId) || !['prepared','dispatching'].includes(row.entry.status) || row.perFile.some(file=>file.state==='dispatching'||file.state==='manual_reconciliation'||file.attemptId===attemptId.toLowerCase()) || row.perFile[index]!.state!=='pending')throw new ConflictException('付款文件不可重复发送');
      row.perFile[index]={...row.perFile[index]!,state:'dispatching',attemptId:attemptId.toLowerCase()};
      row.entry={...row.entry,status:'dispatching',attemptId:row.entry.attemptId || attemptId.toLowerCase()};
      const stored=paymentUploadStoredRow(raw,key);stored.entry=structuredClone(row.entry);stored.perFile=structuredClone(row.perFile);normalizeLifecyclePaymentUploads([stored]);
      await this.writeLifecycleRaw(raw,original);return lifecyclePaymentPerFilePublic(row);
    });
  }

  async confirmLifecyclePaymentPerFile(key:string,index:number,attemptId:string,token:string):Promise<LifecyclePaymentPerFileTask> {
    return this.enqueue(async()=>{
      const {raw,original}=await this.readLifecycleConsistent(),row=normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads).find(item=>item.entry.key===key);
      if(!row?.perFile || !Number.isSafeInteger(index) || index<0 || index>=row.perFile.length || !UUID_PATTERN.test(attemptId) || !/^[A-Za-z0-9_-]{1,256}$/.test(token))throw new ConflictException('付款文件回执不可核对');
      const file=row.perFile[index]!;
      if(file.state==='confirmed' && file.attemptId===attemptId.toLowerCase() && file.token===token)return lifecyclePaymentPerFilePublic(row);
      if(row.entry.status!=='dispatching' || file.state!=='dispatching' || file.attemptId!==attemptId.toLowerCase() || row.perFile.some(other=>other.token===token))throw new ConflictException('付款文件回执不可核对');
      row.perFile[index]={...file,state:'confirmed',token};
      if(row.perFile.every(other=>other.state==='confirmed'))row.entry={...row.entry,status:'uploaded',tokens:row.perFile.map(other=>other.token!)};
      const stored=paymentUploadStoredRow(raw,key);stored.entry=structuredClone(row.entry);stored.perFile=structuredClone(row.perFile);normalizeLifecyclePaymentUploads([stored]);
      await this.writeLifecycleRaw(raw,original);return lifecyclePaymentPerFilePublic(row);
    });
  }

  async markLifecyclePaymentPerFileUncertain(key:string,index:number,attemptId:string):Promise<void> {
    await this.enqueue(async()=>{
      const {raw,original}=await this.readLifecycleConsistent(),row=normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads).find(item=>item.entry.key===key);
      if(!row?.perFile || !Number.isSafeInteger(index) || index<0 || index>=row.perFile.length || !UUID_PATTERN.test(attemptId))throw new ConflictException('付款文件回执不可核对');
      const file=row.perFile[index]!;
      if(file.state==='confirmed' && file.attemptId===attemptId.toLowerCase() || file.state==='manual_reconciliation' && file.attemptId===attemptId.toLowerCase())return;
      if(row.entry.status!=='dispatching' || file.state!=='dispatching' || file.attemptId!==attemptId.toLowerCase())throw new ConflictException('付款文件回执不可核对');
      row.perFile[index]={...file,state:'manual_reconciliation'};row.entry={...row.entry,status:'manual_reconciliation'};
      const stored=paymentUploadStoredRow(raw,key);stored.entry=structuredClone(row.entry);stored.perFile=structuredClone(row.perFile);normalizeLifecyclePaymentUploads([stored]);await this.writeLifecycleRaw(raw,original);
    });
  }

  async commitLifecyclePaymentPerFile(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector,request:LifecyclePaymentUploadRequest,key:string,authorize:LifecyclePaymentUploadLockedAuthorization):Promise<LifecyclePaymentPerFileTask> {
    return this.enqueue(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent(),authority=this.lifecyclePaymentUploadAuthority(ledger,identity,selector,authorize),rows=normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads);
      const row=rows.find(item=>item.entry.key===key);
      if(!row?.perFile || row.appId!==identity.appId || row.approvalBatchId!==selector.approvalBatchId || row.executionRecordId!==selector.executionRecordId || row.actorOpenId!==identity.openId || row.generation!==selector.generation || normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks===undefined?[]:raw.lifecyclePaymentBlocks).some(block=>block.key===key))throw new ConflictException('付款上传任务身份不匹配');
      const other=rows.filter(other=>other.entry.key!==key && other.entry.status!=='cancelled').flatMap(other=>other.entry.contentKeys);
      if(row.entry.status==='committed'){
        const replay=planLifecyclePaymentUpload(authority,request,row.entry,other,Date.now(),()=>identity.assertCurrent());
        if(replay.kind!=='replay')throw new ConflictException('付款上传结果不可核对');return lifecyclePaymentPerFilePublic(row);
      }
      const updated=commitLifecyclePaymentUpload(authority,request,row.entry,other,Date.now(),()=>identity.assertCurrent());
      const batches=Array.isArray(raw.managerApprovalBatches)?raw.managerApprovalBatches.filter(batch=>isRecord(batch)&&batch.approvalBatchId===selector.approvalBatchId):[],batch=batches[0];
      if(batches.length!==1 || !isRecord(batch) || !Array.isArray(batch.items) || !Number.isSafeInteger(batch.revision))throw new ConflictException('采购付款批次账本损坏');
      const items=batch.items.filter(item=>isRecord(item)&&item.executionRecordId===selector.executionRecordId),item=items[0];
      if(items.length!==1 || !isRecord(item) || !Array.isArray(item.paymentAttachmentTokens) || item.paymentAttachmentTokens.some(token=>typeof token!=='string'))throw new ConflictException('采购付款附件账本损坏');
      const tokens=mergeAttachmentTokens(item.paymentAttachmentTokens as string[],updated.tokens);if(tokens.length>20)throw new ConflictException('采购付款附件数量超限');
      const nextBatchRevision=Number(batch.revision)+1;if(!Number.isSafeInteger(nextBatchRevision))throw new ConflictException('采购付款批次版本超限');
      item.paymentAttachmentTokens=tokens;batch.revision=nextBatchRevision;batch.updatedAt=new Date().toISOString();
      const outbox=normalizeLifecycleOutbox(raw.lifecycleOutbox),affected=outbox.filter(entry=>entry.replica.batchId===selector.approvalBatchId && entry.replica.appId===identity.appId);
      if(!affected.length || !Array.isArray(raw.lifecycleOutbox))throw new ConflictException('采购卡片副本不可用');
      const revision=Math.max(...affected.map(entry=>entry.desiredRevision))+1;if(!Number.isSafeInteger(revision))throw new ConflictException('采购卡片版本超限');
      for(const entry of affected){const originals=raw.lifecycleOutbox.filter(candidate=>isRecord(candidate)&&isRecord(candidate.replica)&&lifecycleIdentityKey(candidate.replica as unknown as PurchaseReplicaIdentity)===lifecycleIdentityKey(entry.replica));if(originals.length!==1||!isRecord(originals[0]))throw new ConflictException('采购卡片副本账本损坏');originals[0].desiredRevision=revision;}
      row.entry=updated;const stored=paymentUploadStoredRow(raw,key);stored.entry=structuredClone(updated);stored.perFile=structuredClone(row.perFile);normalizeLifecyclePaymentUploads([stored]);
      await this.writeLifecycleRaw(raw,original);return lifecyclePaymentPerFilePublic(row);
    });
  }

  /** Confirmed evidence is stored without relying on later user authorization; it never attaches files. */
  async recordConfirmedLifecyclePaymentUpload(supplied: LifecyclePaymentUploadEntry, attemptId: string, tokens: string[]): Promise<LifecyclePaymentUploadEntry> {
    return this.enqueue(async () => {
      const { raw, original } = await this.readLifecycleConsistent(), rows = normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads);
      const row = rows.find(candidate => candidate.entry.key === supplied?.key);
      if(row?.perFile) throw new ConflictException('付款上传任务必须使用原逐文件入口');
      if (!row || row.entry.fingerprint !== supplied.fingerprint) throw new ConflictException('付款上传任务身份不匹配');
      const updated = recordLifecyclePaymentUpload(row.entry, attemptId, tokens);
      applyPaymentUploadEntry(paymentUploadStoredRow(raw, row.entry.key), updated); await this.writeLifecycleRaw(raw, original);
      return structuredClone(updated);
    });
  }

  async markUncertainLifecyclePaymentUpload(supplied: LifecyclePaymentUploadEntry, attemptId: string): Promise<void> {
    return this.enqueue(async () => {
      const { raw, original } = await this.readLifecycleConsistent(), rows = normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads);
      const row = rows.find(candidate => candidate.entry.key === supplied?.key);
      if(row?.perFile) throw new ConflictException('付款上传任务必须使用原逐文件入口');
      if (!row || row.entry.fingerprint !== supplied.fingerprint) throw new ConflictException('付款上传任务身份不匹配');
      const updated = markLifecyclePaymentUploadUncertain(row.entry, attemptId);
      applyPaymentUploadEntry(paymentUploadStoredRow(raw, row.entry.key), updated); await this.writeLifecycleRaw(raw, original);
    });
  }

  /** Atomically commits upload evidence, attachment merge and refresh, preserving unrelated raw data. */
  async commitLifecyclePaymentUpload(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, supplied: LifecyclePaymentUploadEntry, authorize: LifecyclePaymentUploadLockedAuthorization): Promise<void> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const authority = this.lifecyclePaymentUploadAuthority(ledger, identity, selector, authorize), rows = normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads);
      const row = rows.find(candidate => candidate.entry.key === supplied?.key);
      if(row?.perFile) throw new ConflictException('付款上传任务必须使用原逐文件入口');
      if (!row || row.appId !== identity.appId || row.approvalBatchId !== selector.approvalBatchId || row.executionRecordId !== selector.executionRecordId || row.actorOpenId !== identity.openId || row.generation !== selector.generation || row.entry.fingerprint !== supplied.fingerprint || normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks === undefined ? [] : raw.lifecyclePaymentBlocks).some(block => block.key === row.entry.key)) throw new ConflictException('付款上传任务身份不匹配');
      const updated = commitLifecyclePaymentUpload(authority, request, row.entry, rows.filter(other => other.entry.key !== row.entry.key && other.entry.status !== 'cancelled').flatMap(other => other.entry.contentKeys), Date.now(), () => identity.assertCurrent());
      const batches = Array.isArray(raw.managerApprovalBatches) ? raw.managerApprovalBatches.filter(batch => isRecord(batch) && batch.approvalBatchId === selector.approvalBatchId) : [];
      const batch = batches[0];
      if (batches.length !== 1 || !isRecord(batch) || !Array.isArray(batch.items) || !Number.isSafeInteger(batch.revision)) throw new ConflictException('采购付款批次账本损坏');
      const items = batch.items.filter(item => isRecord(item) && item.executionRecordId === selector.executionRecordId), item = items[0];
      if (items.length !== 1 || !isRecord(item) || !Array.isArray(item.paymentAttachmentTokens) || item.paymentAttachmentTokens.some(token => typeof token !== 'string')) throw new ConflictException('采购付款附件账本损坏');
      const tokens = mergeAttachmentTokens(item.paymentAttachmentTokens as string[], updated.tokens);
      if (tokens.length > 20) throw new ConflictException('采购付款附件数量超限');
      const nextBatchRevision = Number(batch.revision) + 1;
      if (!Number.isSafeInteger(nextBatchRevision)) throw new ConflictException('采购付款批次版本超限');
      item.paymentAttachmentTokens = tokens; batch.revision = nextBatchRevision; batch.updatedAt = new Date().toISOString();
      const outbox = normalizeLifecycleOutbox(raw.lifecycleOutbox), affected = outbox.filter(entry => entry.replica.batchId === selector.approvalBatchId && entry.replica.appId === identity.appId);
      if (!affected.length || !Array.isArray(raw.lifecycleOutbox)) throw new ConflictException('采购卡片副本不可用');
      const revision = Math.max(...affected.map(entry => entry.desiredRevision)) + 1;
      if (!Number.isSafeInteger(revision)) throw new ConflictException('采购卡片版本超限');
      for (const entry of affected) {
        const originals = raw.lifecycleOutbox.filter(candidate => isRecord(candidate) && isRecord(candidate.replica) && lifecycleIdentityKey(candidate.replica as unknown as PurchaseReplicaIdentity) === lifecycleIdentityKey(entry.replica));
        if (originals.length !== 1 || !isRecord(originals[0])) throw new ConflictException('采购卡片副本账本损坏');
        originals[0].desiredRevision = revision;
      }
      applyPaymentUploadEntry(paymentUploadStoredRow(raw, row.entry.key), updated);
      await this.writeLifecycleRaw(raw, original);
    });
  }

  /** Read-only status checks do not require the purchase to remain in the order stage. */
  private authorizeLifecyclePaymentStatus(ledger: PurchaseWorkflowLedger, identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, knownOwner: boolean): void {
    if (!identity || typeof identity.assertCurrent !== 'function' || identity.appId !== readEnv('FEISHU_APP_ID') || !selector || typeof selector.approvalBatchId !== 'string' || !BATCH_ID_PATTERN.test(selector.approvalBatchId) ||
      typeof selector.executionRecordId !== 'string' || !RECORD_ID_PATTERN.test(selector.executionRecordId) || !Number.isSafeInteger(selector.generation) || selector.generation < 1) throw new ForbiddenException('付款上传状态不可核对');
    assertSynchronousLifecycleAuthorization(() => identity.assertCurrent());
    const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === selector.approvalBatchId), batch = batches[0];
    if (batches.length !== 1 || !batch || batch.flowVersion !== 'lifecycle_v1' || batch.lifecycleAppId !== identity.appId) throw new ForbiddenException('付款上传状态不可核对');
    const items = batch.items.filter(item => item.executionRecordId === selector.executionRecordId);
    if (items.length !== 1 || (!knownOwner && items[0]!.purchaserOpenId !== identity.openId)) throw new ForbiddenException('付款上传状态不可核对');
    const entry = findLifecycleEntry(ledger.lifecycleOutbox || [], { appId: identity.appId, batchId: selector.approvalBatchId, recipientOpenId: identity.openId });
    const current = entry.replica.generation === selector.generation && entry.replica.state === 'delivered' && !!entry.replica.messageId;
    const previous = entry.history.some(row => row.generation === selector.generation && !!row.messageId);
    if (!current && !previous) throw new ForbiddenException('付款上传卡片身份不可核对');
  }

  async lifecyclePaymentUploadStatus(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, requestId: string): Promise<{ state: LifecyclePaymentUploadPublicStatus }> {
    return this.enqueueRead(async () => {
      const ledger = await this.read(), key = purchaseLifecyclePaymentRequestKey(identity.appId, requestId);
      const row = (ledger.lifecyclePaymentUploads || []).find(candidate => candidate.entry.key === key), block = (ledger.lifecyclePaymentBlocks || []).find(candidate => candidate.key === key);
      const owner = row || block;
      if (owner && (owner.appId !== identity.appId || owner.actorOpenId !== identity.openId || owner.approvalBatchId !== selector.approvalBatchId || owner.executionRecordId !== selector.executionRecordId || owner.generation !== selector.generation)) throw new ForbiddenException('付款上传状态不可核对');
      this.authorizeLifecyclePaymentStatus(ledger, identity, selector, !!owner);
      if (block) return { state: 'cancelled' };
      if (!row) return { state: 'not_found' };
      if (!['committed', 'cancelled'].includes(row.entry.status) && (!ledger.lifecycleReceiptImageSource || ledger.lifecycleReceiptImageSource.appId !== identity.appId || ledger.lifecycleReceiptImageSource.sourceFingerprint !== identity.uploadSourceFingerprint)) return { state: 'manual_reconciliation' };
      const currentReplica=(ledger.lifecycleOutbox || []).find(entry=>entry.replica.appId===identity.appId && entry.replica.batchId===selector.approvalBatchId && entry.replica.recipientOpenId===identity.openId)?.replica;
      if (currentReplica?.generation===selector.generation && currentReplica.state==='delivered' &&
          row.entry.status!=='committed' && row.entry.status!=='cancelled' && row.entry.status!=='manual_reconciliation' && row.perFile?.some(file=>file.state==='pending') &&
          row.perFile.every(file=>file.state==='pending'||file.state==='confirmed')) return {state:'resumable'};
      return { state: row.entry.status === 'committed' ? 'completed' : row.entry.status };
    });
  }

  /** A permanent tombstone and optional prepared-entry cancellation share one ledger transaction. */
  async cancelUnsentLifecyclePaymentUpload(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, requestId: string): Promise<{ state: 'cancelled' }> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent(), key = purchaseLifecyclePaymentRequestKey(identity.appId, requestId);
      const rows = normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads === undefined ? [] : raw.lifecyclePaymentUploads), blocks = normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks === undefined ? [] : raw.lifecyclePaymentBlocks);
      const row = rows.find(candidate => candidate.entry.key === key), block = blocks.find(candidate => candidate.key === key), owner = row || block;
      if (owner && (owner.appId !== identity.appId || owner.actorOpenId !== identity.openId || owner.approvalBatchId !== selector.approvalBatchId || owner.executionRecordId !== selector.executionRecordId || owner.generation !== selector.generation)) throw new ForbiddenException('付款上传状态不可核对');
      this.authorizeLifecyclePaymentStatus(ledger, identity, selector, !!owner);
      if (block) return { state: 'cancelled' };
      if (row && row.entry.status !== 'prepared') throw new ConflictException('付款上传已开始或结果待核对，不能自动取消');
      if (blocks.length >= 2000) throw new ServiceUnavailableException('付款上传取消账本已满');
      if (!Array.isArray(raw.lifecyclePaymentBlocks)) raw.lifecyclePaymentBlocks = [];
      (raw.lifecyclePaymentBlocks as unknown[]).push({ key, appId: identity.appId, approvalBatchId: selector.approvalBatchId, executionRecordId: selector.executionRecordId, actorOpenId: identity.openId, generation: selector.generation, cancelledAtMs: Date.now() });
      if (row) applyPaymentUploadEntry(paymentUploadStoredRow(raw, key), { ...row.entry, status: 'cancelled' });
      await this.writeLifecycleRaw(raw, original);
      return { state: 'cancelled' };
    });
  }

  /** Internal only: authorize must validate lifecycle mode, current identity and business scope. */
  async enqueueLifecycleRefresh(identity: PurchaseReplicaIdentity, desiredRevision: number, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void): Promise<PurchaseLifecycleOutboxEntry> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      assertLifecycleBatch(ledger, identity, authorize);
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox);
      const entry = upsertLifecycleEntry(entries, identity, desiredRevision);
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  /** Persists the in-flight fence before dispatch; unknown outcomes are never resent. */
  async beginLifecycleDelivery(identity: PurchaseReplicaIdentity, trustedNowMs: number, expectedDesiredRevision: number, expectedDesiredPage: number, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void): Promise<{ action: 'send' | 'update' | 'reconcile' | 'none'; entry: PurchaseLifecycleOutboxEntry }> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      assertLifecycleBatch(ledger, identity, authorize);
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox);
      const entry = findLifecycleEntry(entries, identity);
      if (!Number.isSafeInteger(expectedDesiredRevision) || expectedDesiredRevision < 1 || entry.desiredRevision !== expectedDesiredRevision || !Number.isSafeInteger(expectedDesiredPage) || expectedDesiredPage !== entry.desiredPage) throw new ConflictException('采购卡片内容版本或页码已变化，请重新生成');
      if (!Number.isSafeInteger(trustedNowMs) || trustedNowMs < entry.nextAttemptAtMs || !Number.isSafeInteger(trustedNowMs + LIFECYCLE_PREPARED_LEASE_MS)) throw new ConflictException('采购卡片尚未到重试时间');
      const plan = planPurchaseReplica(identity, entry.replica, entry.desiredRevision, true, trustedNowMs);
      if (plan.action === 'none' || plan.action === 'reconcile') return { action: plan.action, entry: structuredClone(entry) };
      if (entry.attemptToken) throw new ConflictException('采购卡片投递状态冲突');
      let replica = entry.replica;
      if (plan.action === 'continue') {
        if (entry.history.length >= MAX_LIFECYCLE_GENERATIONS) throw new ServiceUnavailableException('采购卡片续接次数已达上限，需人工核对');
        entry.history.push({ generation: replica.generation, messageId: replica.messageId, sentAtMs: replica.sentAtMs, appliedRevision: replica.appliedRevision });
        replica = continueExpiredPurchaseReplica(identity, replica, trustedNowMs, true);
        if (entry.desiredView && entry.desiredView.kind !== 'list') entry.desiredView = { kind: 'list' };
      }
      const action = plan.action === 'update' ? 'update' : 'send';
      entry.replica = action === 'send'
        ? beginPurchaseReplicaSend(identity, replica, entry.desiredRevision, true, trustedNowMs)
        : beginPurchaseReplicaUpdate(identity, replica, replica.messageId, entry.desiredRevision, true, trustedNowMs);
      entry.attemptToken = randomUUID();
      entry.pendingPage = entry.desiredPage;
      entry.pendingView = entry.desiredView || { kind: 'list' };
      entry.dispatchPhase = 'prepared';
      entry.preparedUntilMs = trustedNowMs + LIFECYCLE_PREPARED_LEASE_MS;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return { action, entry: structuredClone(entry) };
    });
  }

  /** Only an authenticated delivery receipt tied to the original attempt may complete it. */
  async completeLifecycleDelivery(identity: PurchaseReplicaIdentity, attemptToken: string, outcome: ({ kind: 'send'; receipt: VerifiedPurchaseReplicaReceipt } | { kind: 'update'; messageId: string; revision: number }) & { pageProof?: { totalPages: number; authorizationFingerprint: string } }): Promise<PurchaseLifecycleOutboxEntry> {
    return this.enqueue(async () => {
      const { raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox);
      const entry = findLifecycleEntry(entries, identity);
      if (!UUID_PATTERN.test(attemptToken) || entry.attemptToken !== attemptToken || entry.dispatchPhase !== 'dispatch_started') throw new ConflictException('采购卡片投递凭据已变化');
      entry.replica = outcome.kind === 'send'
        ? confirmPurchaseReplicaSend(identity, entry.replica, outcome.receipt)
        : confirmPurchaseReplicaUpdate(identity, entry.replica, outcome.messageId, outcome.revision);
      if (!Number.isSafeInteger(entry.pendingPage) || entry.pendingPage! < 1) throw new ConflictException('采购卡片投递页码无法核对');
      if (outcome.pageProof) {
        if (!Number.isSafeInteger(outcome.pageProof.totalPages) || outcome.pageProof.totalPages < entry.pendingPage! || outcome.pageProof.totalPages > 200 || !/^[a-f0-9]{64}$/.test(outcome.pageProof.authorizationFingerprint)) throw new ConflictException('采购卡片页数或授权证明无效');
        entry.appliedTotalPages = outcome.pageProof.totalPages;
        entry.appliedAuthorizationFingerprint = outcome.pageProof.authorizationFingerprint;
      } else { delete entry.appliedTotalPages; delete entry.appliedAuthorizationFingerprint; }
      entry.appliedPage = entry.pendingPage!;
      entry.appliedView = entry.pendingView || { kind: 'list' };
      delete entry.pendingPage;
      delete entry.pendingView;
      entry.nextAttemptAtMs = 0;
      entry.failureCount = 0;
      delete entry.retryReason;
      entry.attemptToken = '';
      delete entry.dispatchPhase;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  /** Persist immediately before network IO. Once started, result must be reconciled, never aborted. */
  async markLifecycleDeliveryDispatched(identity: PurchaseReplicaIdentity, attemptToken: string, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void, expectedPreparation?:LifecycleReceiptPreparationView|null): Promise<PurchaseLifecycleOutboxEntry> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      assertLifecycleBatch(ledger, identity, authorize);
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      if (!UUID_PATTERN.test(attemptToken) || entry.attemptToken !== attemptToken || entry.dispatchPhase !== 'prepared') throw new ConflictException('采购卡片待发凭据已变化');
      if (expectedPreparation !== undefined) {
        if (entry.desiredRevision!==entry.replica.pendingRevision) throw new ConflictException('采购签收附件卡片版本已变化');
        const current=lifecycleReceiptPreparationView(ledger,identity,entry.replica.messageId);
        if (JSON.stringify(current)!==JSON.stringify(expectedPreparation)) throw new ConflictException('采购签收附件准备状态已变化');
      }
      entry.dispatchPhase = 'dispatch_started';
      delete entry.preparedUntilMs;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  /** Safe only before markLifecycleDeliveryDispatched; dispatched outcomes require reconciliation. */
  async abortPreparedLifecycleDelivery(identity: PurchaseReplicaIdentity, attemptToken: string): Promise<PurchaseLifecycleOutboxEntry> {
    return this.enqueue(async () => {
      const { raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      if (!UUID_PATTERN.test(attemptToken) || entry.attemptToken !== attemptToken || entry.dispatchPhase !== 'prepared') throw new ConflictException('采购卡片已开始发送，必须先核对结果');
      const replica = entry.replica;
      if (replica.state === 'send_unknown') entry.replica = { ...replica, state: 'unattempted', pendingRevision: 0 };
      else if (replica.state === 'update_unknown') entry.replica = { ...replica, state: 'delivered', pendingRevision: 0 };
      else throw new ConflictException('采购卡片待发状态异常');
      entry.attemptToken = '';
      delete entry.pendingPage;
      delete entry.pendingView;
      delete entry.dispatchPhase;
      delete entry.preparedUntilMs;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  /** A prepared owner has no authority to send without first winning markDispatched. */
  async listExpiredPreparedLifecycleDeliveries(limit: number, trustedNowMs: number): Promise<Array<{ identity: PurchaseReplicaIdentity; attemptToken: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(trustedNowMs) || trustedNowMs < 1) throw new BadRequestException('采购卡片待发租约参数无效');
    return this.enqueueRead(async () => (await this.read()).lifecycleOutbox?.filter(entry => entry.dispatchPhase === 'prepared' && entry.preparedUntilMs !== undefined && entry.preparedUntilMs <= trustedNowMs).sort((a, b) => a.preparedUntilMs! - b.preparedUntilMs!).slice(0, limit).map(entry => ({ identity: { appId: entry.replica.appId, batchId: entry.replica.batchId, recipientOpenId: entry.replica.recipientOpenId }, attemptToken: entry.attemptToken })) || []);
  }

  async recoverExpiredPreparedLifecycleDelivery(identity: PurchaseReplicaIdentity, attemptToken: string, trustedNowMs: number): Promise<PurchaseLifecycleOutboxEntry> {
    if (!Number.isSafeInteger(trustedNowMs) || trustedNowMs < 1) throw new BadRequestException('采购卡片待发租约参数无效');
    return this.enqueue(async () => {
      const { raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      if (!UUID_PATTERN.test(attemptToken) || entry.attemptToken !== attemptToken || entry.dispatchPhase !== 'prepared' || entry.preparedUntilMs === undefined || entry.preparedUntilMs > trustedNowMs) throw new ConflictException('采购卡片待发租约已变化或尚未到期');
      const replica = entry.replica;
      if (replica.state === 'send_unknown') entry.replica = { ...replica, state: 'unattempted', pendingRevision: 0 };
      else if (replica.state === 'update_unknown') entry.replica = { ...replica, state: 'delivered', pendingRevision: 0 };
      else throw new ConflictException('采购卡片待发状态异常');
      entry.attemptToken = '';
      delete entry.pendingPage; delete entry.dispatchPhase; delete entry.preparedUntilMs;
      delete entry.pendingView;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  /** Cursor lets the worker progress past terminal or unauthorized old copies. */
  async hasExistingLifecycleWork(): Promise<boolean> {
    // Keep recovery available even after all visible cards appear settled: a
    // delivered copy may need a later authorized transition or reconciliation.
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const archived = stageCardTransitionBatchIds(ledger);
      const images = ledger.lifecycleReceiptImageLedger;
      const archivedIntents = new Set(images?.intents.filter(row => archived.has(row.approvalBatchId)).map(row => row.id));
      return ledger.managerApprovalBatches.some(batch => batch.flowVersion === 'lifecycle_v1') ||
        (ledger.lifecycleOutbox || []).some(row => !archived.has(row.replica.batchId)) ||
        (ledger.lifecyclePaymentUploads || []).some(row => !archived.has(row.approvalBatchId)) ||
        (ledger.lifecycleReceiptPrepareQueue?.tasks || []).some(row => !archived.has(row.identity.approvalBatchId)) ||
        !!images?.tasks.some(row => !archivedIntents.has(row.intentId));
    });
  }

  async listLifecycleStageCardTransitionCandidates(limit = 10): Promise<PurchaseLifecycleStageCardTransitionCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('采购分阶段卡片核对范围无效');
    }
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      return ledger.managerApprovalBatches.flatMap(batch => {
        if (batch.flowVersion !== 'lifecycle_v1' || !batch.lifecycleAppId ||
            !['active', 'resolved', 'manual_reconciliation'].includes(batch.state) ||
            batch.pendingReceiptUpload || !batch.cardContext ||
            hasStageCardCutoverAmbiguity(ledger, batch, new Set(batch.recordIds))) return [];
        const copies = (ledger.lifecycleOutbox || []).filter(row => row.replica.batchId === batch.approvalBatchId);
        if (!copies.length || copies.some(row => row.replica.state !== 'delivered' || row.attemptToken || row.dispatchPhase)) return [];
        return [{
          approvalBatchId: batch.approvalBatchId, appId: batch.lifecycleAppId, batchRevision: batch.revision,
          recordIds: batch.recordIds,
          replicas: copies.map(({ replica }) => ({
            recipientOpenId: replica.recipientOpenId, messageId: replica.messageId, generation: replica.generation,
            appliedRevision: replica.appliedRevision, sentAtMs: replica.sentAtMs,
            managerApproval: managerBatchDeliveries(batch).some(row => row.recipientOpenId === replica.recipientOpenId && row.messageId === replica.messageId),
          })),
        }];
      }).slice(0, limit);
    });
  }

  /**
   * Internal, post-readback cutover. Hold the normal writer lock, leave original
   * replica receipts and action records intact, and reuse the approval messages.
   */
  async transitionLifecycleBatchToStageCards(
    input: PurchaseLifecycleStageCardTransitionInput,
    now: Date | number = new Date(),
  ): Promise<{ changed: boolean; batch: PurchaseManagerApprovalBatchEntry }> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const timestamp = resolveNow(now);
      const batch = ledger.managerApprovalBatches.find(row => row.approvalBatchId === input.approvalBatchId);
      if (!batch || input.appId !== readEnv('FEISHU_APP_ID') || !/^cli_[A-Za-z0-9_-]+$/u.test(input.appId)) {
        throw new ConflictException('采购分阶段卡片批次或应用身份不一致');
      }
      if (batch.stageCardTransition?.appId === input.appId && batch.stageCardTransition.originalRevision === input.batchRevision) {
        return { changed: false, batch };
      }
      if (batch.flowVersion !== 'lifecycle_v1' || batch.lifecycleAppId !== input.appId || batch.revision !== input.batchRevision ||
          !Number.isSafeInteger(input.verifiedAt) || input.verifiedAt > timestamp.getTime() || timestamp.getTime() - input.verifiedAt > 60_000 ||
          batch.state === 'awaiting_delivery' || batch.state === 'processing' || batch.state === 'reject_editing' ||
          batch.pendingReceiptUpload || !batch.cardContext) {
        throw new ConflictException('采购分阶段卡片批次已变化或存在在途处理');
      }
      const batchId = batch.approvalBatchId;
      const recordIds = new Set(batch.recordIds);
      const copies = (ledger.lifecycleOutbox || []).filter(entry => entry.replica.batchId === batchId);
      const receiptKeys = new Set(input.replicas.map(row => JSON.stringify([row.recipientOpenId, row.messageId, row.generation, row.appliedRevision])));
      if (!copies.length || copies.length !== receiptKeys.size || copies.length !== input.replicas.length || copies.some(entry => {
        const replica = entry.replica;
        return replica.state !== 'delivered' || replica.appId !== input.appId || replica.sentAtMs > input.verifiedAt ||
          entry.attemptToken || entry.dispatchPhase ||
          !receiptKeys.has(JSON.stringify([replica.recipientOpenId, replica.messageId, replica.generation, replica.appliedRevision]));
      })) {
        throw new ConflictException('采购原卡回执不完整或有投递结果待核对');
      }
      const records = new Map(input.records.map(record => [record.recordId, record]));
      const missing = new Set(input.missingRecordIds || []);
      if (records.size !== input.records.length || missing.size !== (input.missingRecordIds || []).length ||
          records.size + missing.size !== recordIds.size || [...missing].some(id => !recordIds.has(id) || records.has(id))) {
        throw new ConflictException('采购分阶段卡片的明细核验不完整');
      }
      if (hasStageCardCutoverAmbiguity(ledger, batch, recordIds, timestamp.getTime())) {
        throw new ConflictException('采购仍有在途审批、履约、投递或附件，暂不能切换');
      }
      const heldTerminalOrders = ledger.commands.filter(command => recordIds.has(command.recordId) && !command.completedAt)
        .map(command => {
          const record = records.get(command.recordId);
          const receipt = terminalReceiptForHeldOrder(ledger, batch, command, timestamp.getTime());
          if (!record || !receipt || !['采购完成（已入库）', '物品签收已入库'].includes(record.status) ||
              !record.purchaseCompleted || !record.receiptConfirmed ||
              record.signerOpenId !== receipt.input.signerOpenId || record.receiptTime !== receipt.input.receiptTime) {
            throw new ConflictException('采购原下单结果待核对，未确认独立的签收入库终态');
          }
          return { recordId: command.recordId, claimSha256: purchaseCutoverDigest(command) };
        });
      const reopenedItems: PurchaseLifecycleStageCardTransitionReceipt['reopenedItems'] = [];
      const heldSourceItems: NonNullable<PurchaseLifecycleStageCardTransitionReceipt['heldSourceItems']> = [];
      const items = batch.items.map(item => {
        const record = records.get(item.executionRecordId);
        if (missing.has(item.executionRecordId) && item.status === 'manual_reconciliation') return item;
        if (!record || record.approvalBatchId !== batchId || record.requesterOpenId !== batch.requesterOpenId ||
            !item.authorityTarget || JSON.stringify(purchaseAuthorityTarget(record)) !== JSON.stringify(item.authorityTarget)) {
          throw new ConflictException('采购分阶段卡片明细与现有业务进度不一致');
        }
        if (item.status === 'pending' && hasUnconfirmedSourceOrdering(record)) {
          heldSourceItems.push({ recordId: item.executionRecordId, reason: 'ordering_without_approval_receipt' });
          return { ...item, status: 'manual_reconciliation' as const,
            lastError: STAGE_SOURCE_ORDERING_HOLD_ERROR };
        }
        if (!stageCardCutoverRecordMatches(item, record)) {
          throw new ConflictException('采购分阶段卡片明细与现有业务进度不一致');
        }
        if (item.status !== 'manual_reconciliation') return item;
        const rejectedBeforeWrite = item.lastError === '采购明细授权范围已变化，需要重新核对' &&
          ledger.managerApprovalBatchActions.some(action => action.approvalBatchId === batchId &&
            action.eventId === item.actionEventId && action.status === 'manual_reconciliation' &&
            action.recordIds.includes(item.executionRecordId));
        if (!rejectedBeforeWrite) throw new ConflictException('采购原审批结果未确认，保留人工核对');
        reopenedItems.push({
          recordId: item.executionRecordId, actionEventId: item.actionEventId, actorOpenId: item.actorOpenId,
          choice: item.choice, rejectionReason: item.rejectionReason, processedAt: item.processedAt, lastError: item.lastError,
        });
        return { ...item, status: 'pending' as const, actionEventId: '', actorOpenId: '', choice: '' as const,
          rejectionReason: '', processedAt: '', lastError: '' };
      });
      const deliveries = managerBatchDeliveries(batch);
      if (!deliveries.length || deliveries.some(delivery => !delivery.messageId ||
          !copies.some(({ replica }) => replica.recipientOpenId === delivery.recipientOpenId && replica.messageId === delivery.messageId))) {
        throw new ConflictException('采购原审批消息映射不完整');
      }
      const transition: PurchaseLifecycleStageCardTransitionReceipt = {
        version: 1, appId: input.appId, switchedAt: timestamp.toISOString(), originalRevision: batch.revision,
        originalBatchSha256: purchaseCutoverDigest(batch), originalOutboxSha256: purchaseCutoverDigest(copies),
        sourceReadbackSha256: purchaseCutoverDigest(batch.recordIds.map(id => records.get(id) ?? { missing: id })),
        originalCardContext: batch.cardContext,
        archivedMessageIds: [...new Set(copies.flatMap(({ replica, history }) => [replica.messageId, ...history.map(row => row.messageId)]))].sort(),
        retirementMessageIds: copies.map(({ replica }) => replica.messageId)
          .filter(id => !deliveries.some(delivery => delivery.messageId === id)).sort(),
        retiredCards: [],
        originalState: batch.state, originalResolvedAt: batch.resolvedAt,
        initialRecipients: batch.lifecycleInitialRecipients!,
        authorityTargets: batch.lifecycleAuthorityTargets!,
        missingRecordIds: [...missing], reopenedItems,
        ...(heldSourceItems.length ? { heldSourceItems } : {}),
        ...(heldTerminalOrders.length ? { heldTerminalOrders } : {}),
      };
      const {
        lifecycleAppId: _app, lifecycleInitialRecipients: _initial, lifecycleAuthorityTargets: _targets, ...preserved
      } = batch;
      const updated = withManagerApprovalBatchContext({
        ...preserved, flowVersion: 'legacy', stageCardTransition: transition,
        state: items.some(item => item.status === 'pending') ? 'active'
          : items.some(item => item.status === 'manual_reconciliation') ? 'manual_reconciliation' : 'resolved',
        items, revision: batch.revision + 1, updatedAt: transition.switchedAt,
        ...(reopenedItems.length ? { resolvedAt: '' } : {}),
      });
      if (!Array.isArray(raw.managerApprovalBatches) || !Array.isArray(raw.notifications)) {
        throw new ConflictException('采购分阶段卡片账本不可核对');
      }
      const position = raw.managerApprovalBatches.findIndex(row => isRecord(row) && row.approvalBatchId === batchId);
      if (position < 0) throw new ConflictException('采购分阶段卡片原批次不存在');
      const rawBatch = raw.managerApprovalBatches[position];
      if (!isRecord(rawBatch)) throw new ConflictException('采购分阶段卡片原批次不可核对');
      const { lifecycleAppId: _rawApp, lifecycleInitialRecipients: _rawInitial, lifecycleAuthorityTargets: _rawTargets, ...rawPreserved } = rawBatch;
      const converted = { ...rawPreserved, ...updated };
      // Validate with the same decoder that will read the ledger after the next
      // operation or restart, before any archived replicas lose their live owner.
      if (!sanitizeVersionedManagerApprovalBatch(converted)) throw new ConflictException('采购分阶段卡片转换无法读回');
      raw.managerApprovalBatches[position] = converted;
      // Refresh only the existing approval messages. A separate next-stage card
      // is routed by the normal legacy stage worker and its original event key.
      const priorNotificationKeys = new Set(ledger.notifications.map(row => row.key));
      enqueueManagerApprovalBatchStateNotifications(ledger, updated, 'manager_batch_approval_refresh', transition.switchedAt);
      enqueueCutoverStageCards(ledger, updated, records, transition.switchedAt);
      raw.notifications.push(...ledger.notifications.filter(row => !priorNotificationKeys.has(row.key)));
      await this.writeLifecycleRaw(raw, original);
      return { changed: true, batch: updated };
    });
  }

  async listStageCardRetirementTargets(limit = 20): Promise<Array<{
    approvalBatchId: string; appId: string; messageId: string; recipientOpenId: string; sentAtMs: number;
  }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('采购原卡归档核对范围无效');
    }
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      return ledger.managerApprovalBatches.flatMap(batch => {
        const transition = batch.stageCardTransition;
        if (!transition) return [];
        const pending = new Set(transition.retirementMessageIds.filter(id => !transition.retiredCards.some(row => row.messageId === id)));
        return (ledger.lifecycleOutbox || []).filter(row => row.replica.batchId === batch.approvalBatchId && pending.has(row.replica.messageId))
          .map(({ replica }) => ({ approvalBatchId: batch.approvalBatchId, appId: transition.appId,
            messageId: replica.messageId, recipientOpenId: replica.recipientOpenId, sentAtMs: replica.sentAtMs }));
      }).slice(0, limit);
    });
  }

  async markStageCardReplicaRetired(
    approvalBatchId: string, appId: string, messageId: string, now: Date | number = new Date(),
  ): Promise<void> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const batch = ledger.managerApprovalBatches.find(row => row.approvalBatchId === approvalBatchId);
      const transition = batch?.stageCardTransition;
      if (!transition || transition.appId !== appId || appId !== readEnv('FEISHU_APP_ID') ||
          !transition.retirementMessageIds.includes(messageId) || !Array.isArray(raw.managerApprovalBatches)) {
        throw new ConflictException('采购原卡归档回执不匹配');
      }
      if (transition.retiredCards.some(row => row.messageId === messageId)) return;
      const retiredAt = resolveNow(now).toISOString();
      const stored = raw.managerApprovalBatches.find(row => isRecord(row) && row.approvalBatchId === approvalBatchId);
      if (!isRecord(stored) || retiredAt < transition.switchedAt) throw new ConflictException('采购原卡归档时间不一致');
      stored.stageCardTransition = { ...transition, retiredCards: [...transition.retiredCards, { messageId, retiredAt }] };
      await this.writeLifecycleRaw(raw, original);
    });
  }

  /** Cursor lets the worker progress past terminal or unauthorized old copies. */
  async listExpiredLifecycleContinuations(limit: number, trustedNowMs: number, afterKey = ''): Promise<Array<{ identity: PurchaseReplicaIdentity; generation: number; messageId: string; sentAtMs: number; revision: number; cursor: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(trustedNowMs) || trustedNowMs < 1 || typeof afterKey !== 'string' || afterKey.length > 1000) throw new BadRequestException('采购卡片续接扫描参数无效');
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const archived = stageCardTransitionBatchIds(ledger);
      return ledger.lifecycleOutbox?.flatMap(entry => {
      const replica = entry.replica, cursor = lifecycleIdentityKey(replica);
      if (archived.has(replica.batchId) || cursor <= afterKey || replica.state !== 'delivered' || entry.attemptToken || entry.desiredRevision !== replica.appliedRevision || trustedNowMs - replica.sentAtMs <= LIFECYCLE_CARD_LIFETIME_MS) return [];
      return [{ identity: { appId: replica.appId, batchId: replica.batchId, recipientOpenId: replica.recipientOpenId }, generation: replica.generation, messageId: replica.messageId, sentAtMs: replica.sentAtMs, revision: replica.appliedRevision, cursor }];
      }).sort((a, b) => a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0).slice(0, limit) || [];
    });
  }

  async queueExpiredLifecycleContinuation(identity: PurchaseReplicaIdentity, expected: { generation: number; messageId: string; sentAtMs: number; revision: number }, trustedNowMs: number, authorize: (batch: PurchaseManagerApprovalBatchEntry, entry: PurchaseLifecycleOutboxEntry) => void): Promise<PurchaseLifecycleOutboxEntry> {
    if (!Number.isSafeInteger(trustedNowMs) || trustedNowMs < 1) throw new BadRequestException('采购卡片续接时间无效');
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity), replica = entry.replica;
      if (replica.state !== 'delivered' || entry.attemptToken || replica.generation !== expected.generation || replica.messageId !== expected.messageId || replica.sentAtMs !== expected.sentAtMs || replica.appliedRevision !== expected.revision || entry.desiredRevision !== expected.revision || trustedNowMs - replica.sentAtMs <= LIFECYCLE_CARD_LIFETIME_MS || !Number.isSafeInteger(entry.desiredRevision + 1)) throw new ConflictException('采购卡片续接状态已变化');
      assertLifecycleBatch(ledger, identity, batch => assertSynchronousLifecycleAuthorization(() => authorize(batch, structuredClone(entry))));
      entry.desiredRevision += 1;
      entry.nextAttemptAtMs = 0; entry.failureCount = 0; delete entry.retryReason;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  async getLifecycleOutbox(identity: PurchaseReplicaIdentity): Promise<PurchaseLifecycleOutboxEntry | null> {
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const entries = ledger.lifecycleOutbox || [];
      const key = lifecycleIdentityKey(identity);
      return structuredClone(entries.find(entry => lifecycleIdentityKey(entry.replica) === key) || null);
    });
  }

  /** Internal worker index: no card body, tokens or business records are returned. */
  async listPendingLifecycleDeliveries(limit: number, status: 'ready' | 'needs_reconciliation' = 'ready', trustedNowMs = Date.now()): Promise<Array<{ identity: PurchaseReplicaIdentity; desiredRevision: number; desiredPage: number; desiredView: PurchaseLifecycleView; status: 'ready' | 'needs_reconciliation' }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['ready', 'needs_reconciliation'].includes(status) || !Number.isSafeInteger(trustedNowMs) || trustedNowMs < 1) throw new BadRequestException('采购卡片队列读取数量无效');
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const archived = stageCardTransitionBatchIds(ledger);
      return [...(ledger.lifecycleOutbox || [])].sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs).flatMap(entry => {
        const { replica, desiredRevision } = entry;
        if (archived.has(replica.batchId)) return [];
        const pending = replica.state === 'send_unknown' || replica.state === 'update_unknown';
        if ((status === 'ready' && (pending || entry.nextAttemptAtMs > trustedNowMs)) || (status === 'needs_reconciliation' && !pending) || (!pending && replica.state === 'delivered' && desiredRevision <= replica.appliedRevision)) return [];
        return [{ identity: { appId: replica.appId, batchId: replica.batchId, recipientOpenId: replica.recipientOpenId }, desiredRevision, desiredPage: entry.desiredPage, desiredView: entry.desiredView || { kind: 'list' },
          status: pending ? 'needs_reconciliation' as const : 'ready' as const }];
      }).slice(0, limit);
    });
  }

  /** Delay only a definitely undispatched attempt; unknown sends remain fenced for reconciliation. */
  async deferLifecycleDelivery(identity: PurchaseReplicaIdentity, expectedRevision: number, expectedPage: number, reason: 'source' | 'authorization', trustedNowMs: number): Promise<PurchaseLifecycleOutboxEntry> {
    if (!Number.isSafeInteger(trustedNowMs) || trustedNowMs < 1 || (reason !== 'source' && reason !== 'authorization')) throw new BadRequestException('采购卡片重试参数无效');
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === identity.batchId);
      if (batches.length !== 1 || batches[0]!.flowVersion !== 'lifecycle_v1' || batches[0]!.lifecycleAppId !== identity.appId) throw new ConflictException('采购卡片批次无法核对');
      if (entry.desiredRevision !== expectedRevision || entry.desiredPage !== expectedPage || entry.attemptToken || (entry.replica.state !== 'unattempted' && entry.replica.state !== 'delivered')) throw new ConflictException('采购卡片投递状态已变化，不能安排重试');
      const count = Math.min(20, entry.failureCount + 1), base = reason === 'authorization' ? 30_000 : 5_000;
      const delay = Math.min(reason === 'authorization' ? 900_000 : 120_000, base * 2 ** Math.min(10, count - 1));
      if (!Number.isSafeInteger(trustedNowMs + delay)) throw new BadRequestException('采购卡片重试时间无效');
      entry.failureCount = count; entry.retryReason = reason; entry.nextAttemptAtMs = trustedNowMs + delay;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  /** Navigation queues a later PATCH; caller must synchronously authorize targetPage from a trusted projection. */
  async queueLifecycleFormView(identity: PurchaseReplicaIdentity, messageId: string, cardRevision: number, eventIdValue: string, view: PurchaseLifecycleView, authorize: (batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry) => void): Promise<{ queued: boolean; entry: PurchaseLifecycleOutboxEntry }> {
    const eventId = boundedText(eventIdValue, MAX_EVENT_ID_LENGTH), checkedView = normalizeLifecycleView(view);
    if (!eventId || eventId !== eventIdValue || checkedView.kind === 'list' || typeof authorize !== 'function') throw new BadRequestException('采购表单视图请求无效');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      const matches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === identity.batchId);
      if (matches.length !== 1 || !matches[0]) throw new ConflictException('采购表单批次不存在');
      const batch = matches[0], item = batch.items.find(row => row.executionRecordId === checkedView.recordId);
      if (!item || batch.recordIds.filter(id => id === checkedView.recordId).length !== 1) throw new ConflictException('采购表单明细不存在');
      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(item)));
      const previous = (entry.viewEvents || []).find(row => row.eventId === eventId);
      if (previous) {
        const time = Date.now();
        if (batch.flowVersion !== 'lifecycle_v1' || batch.lifecycleAppId !== identity.appId || identity.appId !== readEnv('FEISHU_APP_ID') || !['delivered', 'update_unknown'].includes(entry.replica.state) || entry.replica.messageId !== messageId || time < entry.replica.sentAtMs || time - entry.replica.sentAtMs > 14 * 86400_000 || previous.sourceRevision !== cardRevision || previous.kind !== checkedView.kind || previous.recordId !== checkedView.recordId) throw new ConflictException('采购表单事件内容冲突');
        return { queued: false, entry: structuredClone(entry) };
      }
      assertLifecycleCallbackWithinLedger(ledger, batch, { approvalBatchId: identity.batchId, actorOpenId: identity.recipientOpenId, messageId, lifecycle: { appId: identity.appId, cardRevision } });
      if ((entry.viewEvents || []).length >= 1000 || !Number.isSafeInteger(entry.desiredRevision + 1)) throw new ServiceUnavailableException('采购表单视图记录已满');
      entry.viewEvents = [...(entry.viewEvents || []), { eventId, sourceRevision: cardRevision, kind: checkedView.kind, recordId: checkedView.recordId }];
      entry.desiredView = checkedView; entry.desiredRevision += 1; entry.nextAttemptAtMs = 0; entry.failureCount = 0; delete entry.retryReason;
      raw.lifecycleOutbox = entries; await this.writeLifecycleRaw(raw, original);
      return { queued: true, entry: structuredClone(entry) };
    });
  }

  /** Sign only a prepared update; no token may be issued after network dispatch. */
  async resetLifecycleDesiredViewToList(identity: PurchaseReplicaIdentity, expectedRevision: number, expectedPage: number, expectedView: PurchaseLifecycleView, authorizeInvalidView: (batch: PurchaseManagerApprovalBatchEntry, entry: PurchaseLifecycleOutboxEntry) => void): Promise<PurchaseLifecycleOutboxEntry> {
    const view = normalizeLifecycleView(expectedView);
    if (view.kind === 'list' || typeof authorizeInvalidView !== 'function') throw new BadRequestException('采购表单视图校验无效');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      assertLifecycleBatch(ledger, identity, batch => assertSynchronousLifecycleAuthorization(() => authorizeInvalidView(batch, structuredClone(entry))));
      if (entry.desiredRevision !== expectedRevision || entry.desiredPage !== expectedPage || entry.attemptToken || JSON.stringify(entry.desiredView) !== JSON.stringify(view) || !Number.isSafeInteger(entry.desiredRevision + 1)) throw new ConflictException('采购表单视图状态已变化');
      entry.desiredView = { kind: 'list' }; entry.desiredRevision += 1; entry.nextAttemptAtMs = 0; entry.failureCount = 0; delete entry.retryReason;
      raw.lifecycleOutbox = entries; await this.writeLifecycleRaw(raw, original); return structuredClone(entry);
    });
  }

  async issuePreparedLifecycleForm(identity: PurchaseReplicaIdentity, attemptToken: string, binding: PurchaseLifecycleFormBinding, authorize: (batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry) => void): Promise<string> {
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      const expectedKind = binding.action === 'submit_item_reject' ? 'reject' : binding.action === 'submit_order' ? 'order' : 'receipt';
      if (!UUID_PATTERN.test(attemptToken) || entry.attemptToken !== attemptToken || entry.dispatchPhase !== 'prepared' || entry.replica.state !== 'update_unknown' ||
          !entry.pendingView || entry.pendingView.kind !== expectedKind || entry.pendingView.recordId !== binding.executionRecordId ||
          binding.approvalBatchId !== identity.batchId || binding.cardRevision !== entry.replica.pendingRevision || typeof authorize !== 'function') throw new ConflictException('采购表单待发凭据不匹配');
      const formIdentity = { appId: identity.appId, actorOpenId: identity.recipientOpenId, messageId: entry.replica.messageId };
      assertLifecycleFormBindingShape(formIdentity, binding);
      const batches = ledger.managerApprovalBatches.filter(row => row.approvalBatchId === identity.batchId);
      const batch = batches[0], item = batch?.items.find(row => row.executionRecordId === binding.executionRecordId);
      if (batches.length !== 1 || !batch || batch.flowVersion !== 'lifecycle_v1' || batch.lifecycleAppId !== identity.appId || identity.appId !== readEnv('FEISHU_APP_ID') || !item) throw new ConflictException('采购表单待发身份无法核对');
      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(item)));
      const now = Date.now();
      if (!Number.isSafeInteger(now) || now > (entry.preparedUntilMs || 0)) throw new ConflictException('采购表单待发租约已过期');
      const credentials = (ledger.lifecycleFormCredentials || []).filter(row => row.expiresAtMs > now && !(row.appId === identity.appId && row.actorOpenId === identity.recipientOpenId && row.messageId === formIdentity.messageId && row.binding.cardRevision === binding.cardRevision));
      if (credentials.length >= 5000) throw new ServiceUnavailableException('采购表单队列已满');
      const token = randomBytes(32).toString('base64url');
      credentials.push({ hash: lifecycleFormTokenHash(token), ...formIdentity, binding: structuredClone(binding), expiresAtMs: now + 60 * 60 * 1000 });
      raw.lifecycleFormCredentials = credentials; await this.writeLifecycleRaw(raw, original); return token;
    });
  }

  async queueLifecyclePage(identity: PurchaseReplicaIdentity, messageId: string, cardRevision: number, eventIdValue: string, targetPage: number, authorize: (batch: PurchaseManagerApprovalBatchEntry, replica: PurchaseReplica, page: number, proof: { totalPages: number; authorizationFingerprint: string }) => void): Promise<{ queued: boolean; entry: PurchaseLifecycleOutboxEntry }> {
    const eventId = boundedText(eventIdValue, MAX_EVENT_ID_LENGTH);
    if (!eventId || eventId !== eventIdValue || !Number.isSafeInteger(cardRevision) || cardRevision < 1 || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 200 || typeof authorize !== 'function') throw new BadRequestException('采购卡片翻页请求无效');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === identity.batchId);
      if (batches.length !== 1 || !batches[0] || batches[0].flowVersion !== 'lifecycle_v1' || batches[0].lifecycleAppId !== identity.appId || identity.appId !== readEnv('FEISHU_APP_ID') || entry.replica.messageId !== messageId) throw new ConflictException('采购卡片翻页身份不匹配');
      if (!entry.appliedTotalPages || !entry.appliedAuthorizationFingerprint || targetPage > entry.appliedTotalPages) throw new ConflictException('采购卡片页数或授权证明不可用');
      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batches[0]!), structuredClone(entry.replica), targetPage, { totalPages: entry.appliedTotalPages!, authorizationFingerprint: entry.appliedAuthorizationFingerprint! }));
      const previous = entry.pageEvents.find(event => event.eventId === eventId);
      if (previous) {
        if (previous.sourceRevision !== cardRevision || previous.targetPage !== targetPage) throw new ConflictException('采购卡片翻页事件内容冲突');
        return { queued: false, entry: structuredClone(entry) };
      }
      assertLifecycleCallbackWithinLedger(ledger, batches[0], { approvalBatchId: identity.batchId, actorOpenId: identity.recipientOpenId, messageId, lifecycle: { appId: identity.appId, cardRevision } });
      if (entry.pageEvents.length >= 1000) throw new ServiceUnavailableException('采购卡片翻页记录已满，需人工处理');
      entry.pageEvents.push({ eventId, sourceRevision: cardRevision, targetPage });
      const queued = entry.desiredPage !== targetPage || (entry.desiredView?.kind || 'list') !== 'list';
      if (queued) {
        if (!Number.isSafeInteger(entry.desiredRevision + 1)) throw new ConflictException('采购卡片版本已达上限');
        entry.desiredPage = targetPage;
        entry.desiredView = { kind: 'list' };
        entry.desiredRevision += 1;
        entry.nextAttemptAtMs = 0; entry.failureCount = 0; delete entry.retryReason;
      }
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return { queued, entry: structuredClone(entry) };
    });
  }

  /** Call only when a freshly revalidated projection no longer contains the saved page. */
  async resetLifecycleDesiredPageToFirst(identity: PurchaseReplicaIdentity, expectedRevision: number, expectedPage: number, authorizeInvalidPage: (batch: PurchaseManagerApprovalBatchEntry, entry: PurchaseLifecycleOutboxEntry) => void): Promise<PurchaseLifecycleOutboxEntry> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox), entry = findLifecycleEntry(entries, identity);
      assertLifecycleBatch(ledger, identity, batch => {
        if (typeof authorizeInvalidPage !== 'function') throw new ForbiddenException('采购卡片页码校验不可用');
        assertSynchronousLifecycleAuthorization(() => authorizeInvalidPage(batch, structuredClone(entry)));
      });
      if (!Number.isSafeInteger(expectedRevision) || entry.desiredRevision !== expectedRevision || !Number.isSafeInteger(expectedPage) || expectedPage <= 1 || entry.desiredPage !== expectedPage || entry.attemptToken || !Number.isSafeInteger(entry.desiredRevision + 1)) throw new ConflictException('采购卡片页码或发送状态已变化');
      entry.desiredPage = 1;
      entry.desiredRevision += 1;
      entry.nextAttemptAtMs = 0; entry.failureCount = 0; delete entry.retryReason;
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return structuredClone(entry);
    });
  }

  /** Enrolls from a durable claimed stage notification. It never completes or sends that notification. */
  async enrollLifecycleRecipientFromNotification(notificationKeyValue: string, claimToken: string, authorize: (batch: PurchaseManagerApprovalBatchEntry, notification: PurchaseWorkflowNotificationEntry) => void): Promise<PurchaseLifecycleOutboxEntry & { stageTargetRevision: number }> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const key = clean(notificationKeyValue);
      const notifications = ledger.notifications.filter(entry => entry.key === key);
      if (notifications.length !== 1 || !notifications[0]) throw new ConflictException('采购全流程阶段通知不存在');
      const notification = notifications[0];
      assertClaimOwnership(notification, claimToken);
      const originals = Array.isArray(raw.notifications) ? raw.notifications.filter(entry => isRecord(entry) && entry.key === key) : [];
      const source = originals[0];
      if (originals.length !== 1 || !isRecord(source) || source.sendOutcome !== 'unattempted' || source.messageId !== '' || source.firstSendAttemptAt !== '' ||
        source.deliveryUuid !== notification.deliveryUuid || source.claimToken !== claimToken || notification.sendOutcome !== 'unattempted' || notification.messageId || notification.firstSendAttemptAt) throw new ConflictException('原采购阶段通知发送结果需要核对');
      const batches = ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(notification.recordId));
      if (batches.length !== 1 || batches[0]!.flowVersion !== 'lifecycle_v1') throw new ConflictException('采购全流程通知批次无法核对');
      const batch = batches[0]!;
      if (!batch.lifecycleAppId || batch.lifecycleAppId !== readEnv('FEISHU_APP_ID') || typeof authorize !== 'function') throw new ForbiddenException('采购全流程通知授权不可用');
      const recipient = notification.recipientOpenId;
      const entries = normalizeLifecycleOutbox(raw.lifecycleOutbox);
      const identity = { appId: batch.lifecycleAppId, batchId: batch.approvalBatchId, recipientOpenId: recipient };
      const prior = entries.find(entry => lifecycleIdentityKey(entry.replica) === lifecycleIdentityKey(identity));
      const manager = notification.kind === 'manager_batch_approval_requested' && managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === recipient && delivery.sourceNotificationKey === notification.key);
      const requester = (notification.kind === 'manager_batch_approval_result' || notification.kind === 'manager_batch_receipt_requested') && batch.requesterOpenId === recipient;
      const purchaser = notification.kind === 'manager_batch_purchase_assigned' && batch.items.some(item => item.executionRecordId === notification.recordId && item.status === 'approved' && item.purchaserOpenId === recipient);
      const warehouse = notification.kind === 'warehouse_inbound' && batch.recordIds.includes(notification.recordId);
      const orderCompletion = notification.kind === 'purchase_order_completed' && !!prior;
      // Refresh tasks must only update an already enrolled recipient. They must
      // never create an additional copy, including when a handover revoked duty.
      const managerAttention = notification.kind === 'manager_batch_approval_attention_required' &&
        managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === recipient && !!delivery.messageId);
      const refresh = !!prior && (managerAttention || ['manager_batch_approval_refresh', 'manager_batch_purchase_refresh', 'manager_batch_receipt_refresh'].includes(notification.kind));
      if (!manager && !requester && !purchaser && !warehouse && !orderCompletion && !refresh) throw new ConflictException('采购全流程阶段通知人员不匹配');
      if (notification.cardContext && notification.kind.startsWith('manager_batch_')) {
        const context = parsePurchaseManagerBatchApprovalCardContext(notification.cardContext);
        if (context.approvalBatchId !== batch.approvalBatchId || !context.items.some(item => item.executionRecordId === notification.recordId)) throw new ConflictException('采购全流程阶段通知上下文不匹配');
      }
      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(notification)));
      const revision = Math.max(1, ...entries.filter(entry => entry.replica.batchId === batch.approvalBatchId).map(entry => entry.desiredRevision));
      const entry = prior || upsertLifecycleEntry(entries, identity, revision);
      const existing = entry.stageEvents.find(event => event.notificationKey === key);
      if (existing) return { ...structuredClone(entry), stageTargetRevision: existing.targetRevision };
      if (entry.stageEvents.length >= 1000) throw new ServiceUnavailableException('采购卡片阶段投递记录已满');
      const isFirstUnsent = entry.replica.state === 'unattempted' && entry.replica.appliedRevision === 0 && entry.stageEvents.length === 0;
      const stageTargetRevision = !prior || isFirstUnsent ? entry.desiredRevision : entry.desiredRevision + 1;
      if (!Number.isSafeInteger(stageTargetRevision)) throw new ConflictException('采购卡片版本已达上限');
      entry.desiredRevision = stageTargetRevision;
      entry.stageEvents.push({ notificationKey: key, targetRevision: stageTargetRevision });
      raw.lifecycleOutbox = entries;
      await this.writeLifecycleRaw(raw, original);
      return { ...structuredClone(entry), stageTargetRevision };
    });
  }

  /** Bind a stage notification only to an independently confirmed lifecycle replica. */
  async completeLifecycleStageNotification(notificationKeyValue: string, claimToken: string, expectedRevision: number, managerCardContext: string | undefined, authorize: (batch: PurchaseManagerApprovalBatchEntry, notification: PurchaseWorkflowNotificationEntry) => void, now: Date | number = new Date()): Promise<PurchaseWorkflowNotificationEntry> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const key = clean(notificationKeyValue), tasks = ledger.notifications.filter(entry => entry.key === key);
      const originals = Array.isArray(raw.notifications) ? raw.notifications.filter(entry => isRecord(entry) && entry.key === key) : [];
      if (tasks.length !== 1 || originals.length !== 1 || !isRecord(originals[0])) throw new ConflictException('采购全流程阶段通知无法核对');
      const task = tasks[0]!, source = originals[0];
      const batches = ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(task.recordId));
      if (batches.length !== 1 || batches[0]!.flowVersion !== 'lifecycle_v1') throw new ConflictException('采购全流程通知批次无法核对');
      const batch = batches[0]!;
      if (!batch.lifecycleAppId || batch.lifecycleAppId !== readEnv('FEISHU_APP_ID') || typeof authorize !== 'function') throw new ForbiddenException('采购全流程通知授权不可用');
      const identity = { appId: batch.lifecycleAppId, batchId: batch.approvalBatchId, recipientOpenId: task.recipientOpenId };
      const entry = findLifecycleEntry(ledger.lifecycleOutbox || [], identity), replica = entry.replica;
      const stageEvent = entry.stageEvents.find(event => event.notificationKey === key);
      if (!stageEvent || !Number.isSafeInteger(expectedRevision) || expectedRevision !== stageEvent.targetRevision) throw new ConflictException('采购全流程卡片尚未确认送达');
      const roleManager = task.kind === 'manager_batch_approval_requested' && managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === task.recipientOpenId && delivery.sourceNotificationKey === task.key);
      const roleRequester = (task.kind === 'manager_batch_approval_result' || task.kind === 'manager_batch_receipt_requested') && batch.requesterOpenId === task.recipientOpenId;
      const rolePurchaser = task.kind === 'manager_batch_purchase_assigned' && batch.items.some(item => item.executionRecordId === task.recordId && item.status === 'approved' && item.purchaserOpenId === task.recipientOpenId);
      const roleWarehouse = task.kind === 'warehouse_inbound' && batch.recordIds.includes(task.recordId);
      const roleOrderCompletion = task.kind === 'purchase_order_completed';
      const managerAttention = task.kind === 'manager_batch_approval_attention_required' &&
        managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === task.recipientOpenId && !!delivery.messageId);
      const roleRefresh = managerAttention || ['manager_batch_approval_refresh', 'manager_batch_purchase_refresh', 'manager_batch_receipt_refresh'].includes(task.kind);
      if (!roleManager && !roleRequester && !rolePurchaser && !roleWarehouse && !roleOrderCompletion && !roleRefresh) throw new ConflictException('采购全流程阶段通知人员不匹配');
      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(task)));
      if (task.status === 'completed') {
        const binding = task.lifecycleBinding;
        const matchesCurrent = binding && binding.generation === replica.generation && binding.messageId === replica.messageId && replica.appliedRevision >= binding.revision;
        const matchesHistory = binding && entry.history.some(previous => previous.generation === binding.generation && previous.messageId === binding.messageId && previous.appliedRevision >= binding.revision);
        if (!binding || binding.appId !== identity.appId || binding.deliveryUuid !== purchaseReplicaUuid(identity, binding.generation) || binding.revision < stageEvent.targetRevision || (!matchesCurrent && !matchesHistory) || !task.deliveryAudit.some(audit => audit.action === 'lifecycle_replica_bound' && audit.deliveryUuid === binding.deliveryUuid && audit.generation === binding.generation && audit.messageId === binding.messageId)) throw new ConflictException('采购全流程已有通知回执冲突');
        return structuredClone(task);
      }
      if (replica.state !== 'delivered' || replica.appliedRevision < stageEvent.targetRevision) throw new ConflictException('采购全流程卡片尚未确认送达');
      assertClaimOwnership(task, claimToken);
      if (source.sendOutcome !== 'unattempted' || source.messageId !== '' || source.firstSendAttemptAt !== '' || source.claimToken !== claimToken || source.deliveryUuid !== task.deliveryUuid || !Array.isArray(source.deliveryAudit)) throw new ConflictException('原采购阶段通知发送结果需要核对');
      const timestamp = resolveNow(now).toISOString();
      if (roleManager) {
        const context = parsePurchaseManagerBatchApprovalCardContext(managerCardContext || '');
        if (context.approvalBatchId !== batch.approvalBatchId || context.requesterOpenId !== batch.requesterOpenId || !sameStringArray(batch.recordIds, context.items.map(item => item.executionRecordId))) throw new ConflictException('采购审批卡上下文与批次不一致');
        if (task.cardContext && task.cardContext !== managerCardContext) throw new ConflictException('采购审批通知上下文已变化');
        const rawBatches = Array.isArray(raw.managerApprovalBatches) ? raw.managerApprovalBatches.filter(item => isRecord(item) && item.approvalBatchId === batch.approvalBatchId) : [];
        const originalBatch = rawBatches[0];
        if (rawBatches.length !== 1 || !isRecord(originalBatch) || !Array.isArray(originalBatch.managerDeliveries)) throw new ConflictException('采购审批接收人账本损坏');
        const deliveries = originalBatch.managerDeliveries.filter(item => isRecord(item) && item.recipientOpenId === task.recipientOpenId && item.sourceNotificationKey === task.key);
        const delivery = deliveries[0];
        if (deliveries.length !== 1 || !isRecord(delivery) || (delivery.messageId && delivery.messageId !== replica.messageId)) throw new ConflictException('采购审批消息已绑定其他卡片');
        if (ledger.managerApprovalBatches.some(other => managerBatchDeliveries(other).some(row => row.messageId === replica.messageId && (other.approvalBatchId !== batch.approvalBatchId || row.recipientOpenId !== task.recipientOpenId)))) throw new ConflictException('采购审批消息已绑定其他批次');
        delivery.messageId = replica.messageId;
        if (batch.recipientOpenId === task.recipientOpenId) originalBatch.messageId = replica.messageId;
        if (batch.state === 'awaiting_delivery') originalBatch.state = 'active';
        if (!batch.cardContext) originalBatch.cardContext = managerCardContext;
        originalBatch.updatedAt = timestamp;
        source.cardContext = managerCardContext;
      }
      source.status = 'completed'; source.updatedAt = timestamp; source.completedAt = timestamp; source.leaseUntil = ''; source.claimToken = ''; source.lastError = '';
      source.messageId = replica.messageId; source.sendOutcome = 'delivered';
      source.lifecycleBinding = { appId: identity.appId, deliveryUuid: replica.uuid, generation: replica.generation, revision: replica.appliedRevision, messageId: replica.messageId };
      source.deliveryAudit.push({ action: 'lifecycle_replica_bound', at: timestamp, operatorOpenId: '', generation: replica.generation, deliveryUuid: replica.uuid, messageId: replica.messageId });
      await this.writeLifecycleRaw(raw, original);
      const rebound = (await this.read()).notifications.find(row => row.key === key);
      if (!rebound) throw new ConflictException('采购全流程通知回执未能回读');
      return structuredClone(rebound);
    });
  }

  /** Returns only versioned new-flow records without a durable inbound resolution. */
  async listLifecycleInboundReconciliationCandidates(limit: number, afterRecordId = ''): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || (afterRecordId && !RECORD_ID_PATTERN.test(afterRecordId))) throw new BadRequestException('采购入库对账范围无效');
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const excluded = new Set(ledger.notifications.filter(entry => entry.kind === 'inventory_inbound_completed_resolution').map(entry => entry.recordId));
      const records = ledger.managerApprovalBatches.filter(batch => batch.flowVersion === 'lifecycle_v1').flatMap(batch => batch.recordIds);
      if (new Set(records).size !== records.length) throw new ConflictException('采购全流程入库明细归属不唯一');
      return records.filter(id => id > afterRecordId && !excluded.has(id)).sort().slice(0, limit);
    });
  }

  async isLifecycleRecord(recordIdValue: string): Promise<boolean> {
    const recordId = normalizeRecordId(recordIdValue);
    return this.enqueueRead(async () => {
      const batches = (await this.read()).managerApprovalBatches.filter(batch => batch.recordIds.includes(recordId));
      if (batches.length > 1 && batches.some(batch => batch.flowVersion === 'lifecycle_v1')) throw new ConflictException('采购全流程明细归属不唯一');
      return batches.length === 1 && batches[0]!.flowVersion === 'lifecycle_v1';
    });
  }

  async stageCardInboundAuthority(recordIdValue: string): Promise<{
    approvalBatchId: string; appId: string; target: PurchaseAuthorityTarget;
  } | null> {
    const recordId = normalizeRecordId(recordIdValue);
    return this.enqueueRead(async () => {
      const batches = (await this.read()).managerApprovalBatches.filter(batch => batch.recordIds.includes(recordId));
      const migrated = batches.find(batch => batch.stageCardTransition);
      if (!migrated) return null;
      const item = migrated.items.find(row => row.executionRecordId === recordId);
      if (batches.length !== 1 || item?.status !== 'approved' || !item.authorityTarget) {
        throw new ConflictException('采购分阶段入库明细状态不可核对');
      }
      return { approvalBatchId: migrated.approvalBatchId, appId: migrated.stageCardTransition!.appId, target: item.authorityTarget };
    });
  }

  async pendingWarehouseStageRecipients(recordIdValue: string): Promise<string[]> {
    const recordId = normalizeRecordId(recordIdValue);
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const transition = ledger.managerApprovalBatches.find(batch => batch.recordIds.includes(recordId))?.stageCardTransition;
      return ledger.notifications.filter(row => row.kind === 'warehouse_inbound' && row.recordId === recordId &&
        (!transition || retainedStageNotification(row, transition))).map(row => row.recipientOpenId);
    });
  }

  async lifecycleIdentityForNotification(keyValue: string, claimToken: string): Promise<PurchaseReplicaIdentity> {
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      const tasks = ledger.notifications.filter(row => row.key === clean(keyValue));
      if (tasks.length !== 1 || !tasks[0]) throw new ConflictException('采购阶段通知不存在');
      const task = tasks[0];
      assertClaimOwnership(task, claimToken);
      const batches = ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(task.recordId));
      if (batches.length !== 1 || batches[0]!.flowVersion !== 'lifecycle_v1' || !batches[0]!.lifecycleAppId) throw new ConflictException('采购全流程批次无法核对');
      return { appId: batches[0]!.lifecycleAppId!, batchId: batches[0]!.approvalBatchId, recipientOpenId: task.recipientOpenId };
    });
  }

  /** Keep a claimed stage task pending while its independently fenced card is delivered. */
  async deferLifecycleStageNotification(keyValue: string, claimToken: string, now: Date | number = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const key = clean(keyValue), tasks = ledger.notifications.filter(row => row.key === key);
      const sources = Array.isArray(raw.notifications) ? raw.notifications.filter(row => isRecord(row) && row.key === key) : [];
      if (tasks.length !== 1 || !tasks[0] || sources.length !== 1 || !isRecord(sources[0])) throw new ConflictException('采购阶段通知无法核对');
      const task = tasks[0], source = sources[0];
      assertClaimOwnership(task, claimToken);
      const batches = ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(task.recordId));
      if (batches.length !== 1 || batches[0]!.flowVersion !== 'lifecycle_v1' || source.claimToken !== claimToken || source.sendOutcome !== 'unattempted' || source.messageId !== '' || source.firstSendAttemptAt !== '') throw new ConflictException('采购阶段通知状态无法安全等待');
      const timestamp = resolveNow(now);
      source.status = 'pending'; source.claimToken = ''; source.leaseUntil = ''; source.updatedAt = timestamp.toISOString();
      source.nextAttemptAt = new Date(timestamp.getTime() + 5000).toISOString();
      source.attempts = Math.max(0, task.attempts - 1);
      await this.writeLifecycleRaw(raw, original);
    });
  }

  /** The caller must have just re-read and confirmed the authoritative completed status. */
  async enqueueLifecycleInboundReconciliation(recordIdValue: string): Promise<boolean> {
    const recordId = normalizeRecordId(recordIdValue);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const batches = ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(recordId));
      if (batches.length !== 1 || batches[0]!.flowVersion !== 'lifecycle_v1') throw new ConflictException('采购全流程入库批次无法核对');
      if (ledger.notifications.some(entry => entry.recordId === recordId && entry.kind === 'inventory_inbound_completed_resolution')) return false;
      if (ledger.notifications.filter(entry => isActiveStatus(entry.status)).length >= MAX_NOTIFICATIONS) throw new ServiceUnavailableException('采购通知任务队列已满，请稍后重试');
      const input = normalizeNotificationInput({ businessEventId: `inventory-inbound-completed-resolution:${recordId}`, recordId, recipientOpenId: 'system', kind: 'inventory_inbound_completed_resolution' });
      ledger.notifications.push(createNotificationEntry(input, new Date().toISOString()));
      await this.write(ledger);
      return true;
    });
  }

  /** Inspection only; the business claim must repeat these checks inside its own transaction. */
  async verifyLifecycleCallback(identity: PurchaseReplicaIdentity, messageId: string, authorize: (batch: PurchaseManagerApprovalBatchEntry, replica: PurchaseReplica) => void): Promise<{ batch: PurchaseManagerApprovalBatchEntry; replica: PurchaseReplica }> {
    return this.enqueueCardRead(async () => {
      const ledger = await this.read();
      const entry = findLifecycleEntry(ledger.lifecycleOutbox || [], identity);
      if (typeof authorize !== 'function' || entry.replica.state !== 'delivered' || entry.replica.messageId !== messageId) throw new ConflictException('采购卡片身份或状态无法核对');
      const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === identity.batchId);
      if (batches.length !== 1 || !batches[0]) throw new ConflictException('采购卡片批次无法核对');
      if (batches[0].flowVersion !== 'lifecycle_v1') throw new ConflictException('原有采购批次不能切换全流程卡片');
      const batch = structuredClone(batches[0]);
      const replica = structuredClone(entry.replica);
      assertSynchronousLifecycleAuthorization(() => authorize(batch, replica));
      return { batch, replica };
    });
  }

  private async readLifecycleConsistent(): Promise<{ ledger: PurchaseWorkflowLedger; raw: Record<string, unknown>; original: Buffer }> {
    let original: Buffer;
    try { original = await readFile(this.ledgerPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConflictException('采购批次账本尚未建立');
      throw error;
    }
    const ledger = await this.read();
    const current = await readFile(this.ledgerPath);
    if (!original.equals(current)) throw new ConflictException('采购工作流账本已变化，请重试');
    const raw: unknown = JSON.parse(original.toString('utf8'));
    if (!isRecord(raw)) throw new ConflictException('采购工作流账本损坏');
    return { ledger, raw, original };
  }

  private async writeLifecycleRaw(raw: Record<string, unknown>, original: Buffer): Promise<void> {
    if (!original.equals(await readFile(this.ledgerPath))) throw new ConflictException('采购工作流账本已变化，请重试');
    await this.write(raw as unknown as PurchaseWorkflowLedger);
  }

  async findCommand(key: string): Promise<PurchaseWorkflowCommandEntry | null> {
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      return ledger.commands.find((entry) => entry.key === key) || null;
    });
  }

  async claimCommand(
    input: PurchaseWorkflowCommandClaimInput,
    authorize?: () => void,
    accepted?: PurchaseAcceptedFulfillment['proof'],
  ): Promise<{ claimed: boolean; entry: PurchaseWorkflowCommandEntry }> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const existing =
        ledger.commands.find((entry) => entry.key === input.key) || null;
      if (existing) return { claimed: false, entry: existing };
      if (
        ledger.commands.filter((entry) => !entry.completedAt).length >=
        MAX_COMMANDS
      ) {
        throw new ServiceUnavailableException(
          '采购工作流在途命令已满，请稍后重试',
        );
      }

      const entry = sanitizeCommand({
        ...input,
        ...(input.platformIdentity ? { platformDispatch: 'prepared', platformAttemptId: randomUUID() } : {}),
        completedAt: '',
        notificationWarnings: [],
      });
      if (
        !entry.key ||
        !entry.recordId ||
        !entry.fingerprint ||
        !entry.expectedResultFingerprint
      ) {
        throw new BadRequestException('采购工作流命令认领参数无效');
      }
      if (input.action === 'order' && ledger.managerApprovalBatches.some(batch => batch.items.some(item => item.executionRecordId === input.recordId && item.executorHandover && !item.executorHandover.ready))) throw new ConflictException('采购职责正在交接，请稍后办理');
      if (!accepted && (input.action === 'order' || input.action === 'receive') && ledger.notifications.some(task => task.recordId === input.recordId && task.kind === (input.action === 'order' ? 'manager_batch_order_command' : 'manager_batch_receipt_command') && task.status !== 'failed')) throw new ConflictException('该采购记录已有卡片办理任务，请核对原任务');
      if (input.action === 'receive' && ledger.notifications.some(task => task.kind === 'web_receipt_command' && task.recordId === input.recordId && task.key !== accepted?.notificationKey)) throw new ConflictException('该采购记录已有正式签收任务，请查看原任务');
      if(accepted){const original=requireAcceptedFulfillment(ledger,accepted,input);if(original.proof.cardContext!==accepted.cardContext||original.proof.appId!==accepted.appId||JSON.stringify(original.proof.lifecycleAuthority||null)!==JSON.stringify(accepted.lifecycleAuthority||null)||JSON.stringify(original.platformIdentity||null)!==JSON.stringify(entry.platformIdentity||null))throw new ConflictException('原采购受理证明不一致');if(original.proof.lifecycleAuthority){if(!authorize)throw new ForbiddenException('采购全流程履约缺少当前权限校验');assertSynchronousLifecycleAuthorization(authorize);}}
      else if(entry.platformIdentity){if(!authorize || entry.actorOpenId !== (entry.platformIdentity.actorFeishuOpenId || '')) throw new ForbiddenException('采购命令平台身份不可核对');assertSynchronousLifecycleAuthorization(authorize);}
      else authorize?.();
      ledger.commands = trimCommandHistory([...ledger.commands, entry]);
      await this.write(ledger);
      return { claimed: true, entry };
    });
  }

  async releaseCommandClaim(
    key: string,
    fingerprint: string,
    platformAttemptId?: string,
    platformRelease: 'prepared' | 'definite_rejection' = 'prepared',
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const index = ledger.commands.findIndex((entry) => entry.key === key);
      const existing = index >= 0 ? ledger.commands[index] : null;
      if (
        !existing ||
        existing.completedAt ||
        existing.fingerprint !== clean(fingerprint) ||
        isHeldTerminalOrder(ledger, existing)
      ) {
        return false;
      }
      if (existing.platformIdentity && (existing.platformAttemptId !== platformAttemptId || existing.platformDispatch !== (platformRelease === 'prepared' ? 'prepared' : 'dispatch_started'))) return false;
      ledger.commands.splice(index, 1);
      await this.write(ledger);
      return true;
    });
  }

  /** Persist the external-write fence while holding the same command lock. */
  async beginPlatformCommandDispatch(key: string, fingerprint: string, attemptId: string): Promise<void> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const command = ledger.commands.find(entry => entry.key === clean(key));
      if (!command || command.completedAt || !command.platformIdentity || command.fingerprint !== clean(fingerprint) || command.platformAttemptId !== attemptId || command.platformDispatch !== 'prepared') throw new ConflictException('采购平台命令发送凭据已失效');
      command.platformDispatch = 'dispatch_started';
      await this.write(ledger);
    });
  }

  async recordCommand(
    input: PurchaseWorkflowCommandRecordInput,
  ): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read();
      const existing =
        ledger.commands.find((candidate) => candidate.key === input.key) ||
        null;
      if (existing?.platformIdentity && (input.actorOpenId !== existing.actorOpenId || input.platformIdentity && JSON.stringify(existing.platformIdentity) !== JSON.stringify(sanitizePlatformCommandIdentity(input.platformIdentity)))) throw new ConflictException('采购命令平台身份不可变更');
      const entry = sanitizeCommand({
        ...input,
        fingerprint: input.fingerprint || existing?.fingerprint || '',
        platformIdentity: existing?.platformIdentity || input.platformIdentity,
        platformDispatch: existing?.platformDispatch || input.platformDispatch,
        platformAttemptId: existing?.platformAttemptId || input.platformAttemptId,
        orderNotice: existing?.orderNotice || input.orderNotice,
        expectedResultFingerprint:
          input.expectedResultFingerprint ||
          existing?.expectedResultFingerprint ||
          '',
        startedAt: input.startedAt || existing?.startedAt || input.completedAt,
      });
      ledger.commands = [
        ...ledger.commands.filter((candidate) => candidate.key !== input.key),
        entry,
      ];
      ledger.commands = trimCommandHistory(ledger.commands);
      if (entry.action === 'order' && entry.completedAt && entry.orderNotice && !entry.orderNotice.deferUntilFulfillment &&
          !isHeldTerminalOrder(ledger, entry)) {
        enqueuePurchaseOrderNotices(ledger, entry);
        ledger.notifications = trimNotificationHistory(ledger.notifications, MAX_NOTIFICATIONS);
      }
      await this.write(ledger);
    });
  }

  async hasReminder(key: string): Promise<boolean> {
    return this.enqueueRead(async () =>
      (await this.read()).reminders.includes(key),
    );
  }

  async recordReminder(key: string): Promise<void> {
    await this.recordReminders([key]);
  }

  async recordReminders(keys: string[]): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read();
      const sanitized = keys.map(clean).filter(Boolean);
      const incoming = new Set(sanitized);
      ledger.reminders = [
        ...ledger.reminders.filter((candidate) => !incoming.has(candidate)),
        ...sanitized,
      ]
        .filter(Boolean)
        .slice(-MAX_REMINDERS);
      await this.write(ledger);
    });
  }

  async listRecentCommands(
    limit = 30,
  ): Promise<PurchaseWorkflowCommandEntry[]> {
    return this.enqueueRead(async () =>
      (await this.read()).commands
        .slice(-Math.max(1, Math.min(limit, 100)))
        .reverse(),
    );
  }

  async listPendingOrderNoticeCommands(limit = 20, afterKey = ''): Promise<PurchaseWorkflowCommandEntry[]> {
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      // A platform command's result fields do not prove which writer applied
      // them. Its existing claim remains the only way to resolve that outcome.
      const pending = ledger.commands.filter(entry => entry.action === 'order' && !entry.completedAt && !entry.platformIdentity &&
        entry.orderNotice && !entry.orderNotice.deferUntilFulfillment && !isHeldTerminalOrder(ledger, entry))
        .sort((left, right) => left.key.localeCompare(right.key));
      const next = pending.findIndex(entry => entry.key.localeCompare(afterKey) > 0);
      const start = next < 0 ? 0 : next;
      return structuredClone([...pending.slice(start), ...pending.slice(0, start)]
        .slice(0, Math.max(1, Math.min(100, Math.floor(limit) || 1))));
    });
  }

  async completePendingOrderNoticeCommand(
    expected: Pick<PurchaseWorkflowCommandEntry, 'key' | 'recordId' | 'fingerprint' | 'expectedResultFingerprint' | 'actorOpenId' | 'startedAt'>,
    now: Date | number = new Date(),
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = ledger.commands.find(command => command.key === expected.key);
      if (!entry || entry.action !== 'order' || entry.completedAt || entry.platformIdentity || !entry.orderNotice || entry.orderNotice.deferUntilFulfillment ||
        isHeldTerminalOrder(ledger, entry) ||
        entry.recordId !== expected.recordId || entry.fingerprint !== expected.fingerprint ||
        entry.expectedResultFingerprint !== expected.expectedResultFingerprint || entry.actorOpenId !== expected.actorOpenId || entry.startedAt !== expected.startedAt) return false;
      entry.completedAt = resolveNow(now).toISOString();
      enqueuePurchaseOrderNotices(ledger, entry);
      ledger.notifications = trimNotificationHistory(ledger.notifications, MAX_NOTIFICATIONS);
      await this.write(ledger);
      return true;
    });
  }

  async claimCardAction(
    input: PurchaseWorkflowCardActionClaimInput,
    now: Date | number = new Date(),
    authorize?: () => PurchaseCardActionAuthority,
  ): Promise<{ claimed: boolean; entry: PurchaseWorkflowCardActionEntry }> {
    return this.enqueueCard(async () => {
      const normalized = normalizeCardActionClaim(input);
      const ledger = await this.read();
      if (input.deliveryMessageId !== undefined && !ledger.notifications.some(notification =>
        notification.kind === 'approval_requested' && notification.recordId === normalized.recordId &&
        notification.recipientOpenId === normalized.actorOpenId && notification.status === 'completed' &&
        notification.messageId === input.deliveryMessageId && !!input.deliveryMessageId)) {
        throw new ForbiddenException('采购审批卡片与已送达授权不匹配');
      }
      const eventReplay = ledger.cardActions.find(
        (entry) => entry.eventId === normalized.eventId,
      );
      if (eventReplay) {
        if (!sameCardActionPayload(eventReplay, normalized)) {
          throw new ConflictException('采购审批回调事件与已有任务冲突');
        }
        return { claimed: false, entry: eventReplay };
      }
      const existing = ledger.cardActions.find(
        (entry) => entry.key === `approval:${normalized.recordId}`,
      );
      if (existing) return { claimed: false, entry: existing };
      if (ledger.notifications.some(notification => notification.kind === 'approval_requested' && notification.recordId === normalized.recordId && notification.recipientOpenId === normalized.actorOpenId && notification.approvalHandover && (!input.deliveryMessageId || notification.messageId === input.deliveryMessageId))) throw new ForbiddenException('采购原审批卡职责已转交');
      if (
        ledger.cardActions.filter((entry) => isActiveStatus(entry.status))
          .length >= MAX_CARD_ACTIONS
      ) {
        throw new ServiceUnavailableException(
          '采购审批任务队列已满，请稍后重试',
        );
      }

      const authority = authorize ? normalizePurchaseCardActionAuthority(authorize()) : undefined;
      const timestamp = resolveNow(now).toISOString();
      if (authority && input.deliveryMessageId) {
        const source = ledger.notifications.find(row => row.kind === 'approval_requested' && row.recordId === normalized.recordId && row.recipientOpenId === normalized.actorOpenId && row.messageId === input.deliveryMessageId && row.status === 'completed');
        if (!source || source.approvalAuthority && JSON.stringify(source.approvalAuthority) !== JSON.stringify(authority)) throw new ConflictException('采购审批原卡应用或范围不一致');
        source.approvalAuthority = authority;
        source.deliveryAudit = appendDeliveryAudit(source.deliveryAudit, { action: 'callback_bound', at: timestamp, operatorOpenId: normalized.actorOpenId,
          generation: source.deliveryGeneration, deliveryUuid: source.deliveryUuid, messageId: input.deliveryMessageId });
      }
      const entry: PurchaseWorkflowCardActionEntry = {
        key: `approval:${normalized.recordId}`,
        ...normalized,
        ...(authority ? { authority } : {}),
        status: 'pending',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
      };
      ledger.cardActions = trimTerminalHistory(
        [...ledger.cardActions, entry],
        MAX_CARD_ACTIONS,
      );
      await this.write(ledger);
      return { claimed: true, entry };
    });
  }

  async takeNextCardAction(
    now: Date | number = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<PurchaseWorkflowCardActionEntry | null> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const index = ledger.cardActions.findIndex((entry) =>
        isAvailable(entry, timestamp),
      );
      if (index < 0) return null;

      const current = ledger.cardActions[index];
      if (!current) return null;
      const updated: PurchaseWorkflowCardActionEntry = {
        ...current,
        status: 'processing',
        attempts: Math.min(current.attempts + 1, 1_000_000),
        updatedAt: timestamp.toISOString(),
        leaseUntil: new Date(
          timestamp.getTime() + normalizeLeaseMs(leaseMs),
        ).toISOString(),
        claimToken: randomUUID(),
      };
      ledger.cardActions[index] = updated;
      await this.write(ledger);
      return updated;
    });
  }

  async planCardActionPurchaser(key: string, claimToken: string, purchaser: Pick<PurchaseWorkflowUser, 'openId' | 'name'>): Promise<Pick<PurchaseWorkflowUser, 'openId' | 'name'>> {
    const planned = normalizeCardActionPurchaser(purchaser);
    const result = await this.updateCardAction(key, claimToken, entry => {
      if (entry.action !== 'approve') throw new ConflictException('采购原动作不是批准');
      return { ...entry, plannedPurchaser: entry.plannedPurchaser || planned };
    });
    if (!result?.plannedPurchaser) throw new ConflictException('采购原审批动作领取权已变化');
    return structuredClone(result.plannedPurchaser);
  }

  async completeCardAction(
    key: string,
    claimToken: string,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowCardActionEntry | null> {
    return this.updateCardAction(key, claimToken, (entry) => {
      const timestamp = resolveNow(now).toISOString();
      return {
        ...entry,
        status: 'completed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
      };
    });
  }

  async rescheduleCardAction(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowCardActionEntry | null> {
    return this.updateCardAction(key, claimToken, (entry) => ({
      ...entry,
      status: 'pending',
      updatedAt: resolveNow(now).toISOString(),
      nextAttemptAt: resolveNow(nextAttemptAt).toISOString(),
      leaseUntil: '',
      claimToken: '',
      completedAt: '',
      lastError: sanitizeError(error),
    }));
  }

  async failCardAction(
    key: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowCardActionEntry | null> {
    return this.updateCardAction(key, claimToken, (entry) => {
      const timestamp = resolveNow(now).toISOString();
      return {
        ...entry,
        status: 'failed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: sanitizeError(error),
      };
    });
  }

  async getCardAction(
    key: string,
  ): Promise<PurchaseWorkflowCardActionEntry | null> {
    const normalizedKey = clean(key);
    return this.enqueueCardRead(
      async () =>
        (await this.read()).cardActions.find(
          (entry) => entry.key === normalizedKey,
        ) || null,
    );
  }

  async listCardActions(
    filter: {
      recordId?: string;
      status?: PurchaseWorkflowQueueStatus;
    } = {},
  ): Promise<PurchaseWorkflowCardActionEntry[]> {
    const recordId = clean(filter.recordId);
    return this.enqueueRead(async () =>
      (await this.read()).cardActions.filter(
        (entry) =>
          (!recordId || entry.recordId === recordId) &&
          (!filter.status || entry.status === filter.status),
      ),
    );
  }

  async acceptManagerBatchHandover(
    value: PurchaseManagerBatchHandoverInput,
  ): Promise<{ status: 'accepted' | 'already_completed'; revision: number }> {
    const input = normalizePurchaseManagerHandoverInput(value);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.enqueue(async () => {
      const ledger = await this.read();
      const prior = ledger.personnelHandovers.find(entry => entry.mutationId === input.mutationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConflictException('采购交接回执或人员身份不一致');
        return { status: 'accepted', revision: prior.targetRevision };
      }
      const canonicalBatch = ledger.managerApprovalBatches.find(entry => entry.approvalBatchId === input.approvalBatchId);
      if (!canonicalBatch || !managerBatchDeliveries(canonicalBatch).some(delivery => delivery.recipientOpenId === input.sourceOpenId)) throw new ConflictException('原采购负责人或批次不一致');
      const batch = managerBatchCardView(canonicalBatch, input.sourceOpenId);
      if (batch.items.some(item => item.status === 'manual_reconciliation')) throw new ConflictException('采购原执行结果尚未确认，请先对账');
      if (batch.items.some(item => item.status === 'processing') || !batch.items.some(item => item.status === 'pending')) {
        return { status: 'already_completed', revision: batch.revision };
      }
      if (batch.revision !== input.expectedRevision || !['active', 'reject_editing'].includes(batch.state) ||
        !batch.messageId || !batch.cardContext || ledger.personnelHandovers.some(entry => entry.approvalBatchId === input.approvalBatchId && entry.status !== 'completed')) {
        throw new ConflictException('原采购批次或交接阶段已变化');
      }
      if (input.target.openId === batch.requesterOpenId) throw new ConflictException('接任人不能审批自己的采购申请');
      if (managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === input.target.openId)) throw new ConflictException('接任人已持有该批次审批卡，请选择其他接任人');
      const originalNotification = ledger.notifications.find(entry => entry.key === batch.sourceNotificationKey);
      if (!originalNotification || originalNotification.status !== 'completed' || originalNotification.sendOutcome !== 'delivered' ||
        originalNotification.messageId !== batch.messageId || originalNotification.recipientOpenId !== input.sourceOpenId) throw new ConflictException('原采购审批卡投递证据未确认');
      if (ledger.managerApprovalBatchActions.some(action => action.approvalBatchId === input.approvalBatchId && !action.completedAt)) throw new ConflictException('原采购审批动作正在执行，请保持原处理');
      if (ledger.personnelHandovers.length >= 2000) throw new ServiceUnavailableException('采购交接台账容量已满');
      const acceptedAt = new Date().toISOString(), targetRevision = batch.revision + 1;
      ledger.personnelHandovers.push({ ...input, fingerprint, targetRevision,
        pendingRecordIds: batch.items.filter(item => item.status === 'pending').map(item => item.executionRecordId),
        oldMessageId: batch.messageId, oldCardContext: batch.cardContext, acceptedAt, status: 'pending',
        attempts: 0, claimToken: '', leaseUntil: '', nextAttemptAt: acceptedAt, confirmedRecordIds: [], lastError: '' });
      const hasOtherDeliveredCard = managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId !== input.sourceOpenId && delivery.messageId);
      replaceManagerApprovalBatch(ledger, updateManagerBatchDelivery({ ...batch, revision: targetRevision,
        state: hasOtherDeliveredCard ? batch.state : 'awaiting_delivery',
        cardContext: hasOtherDeliveredCard ? batch.cardContext : '', updatedAt: acceptedAt,
      }, input.sourceOpenId, { recipientOpenId: input.target.openId, recipientName: input.target.name, messageId: '', selectedRejectRecordId: '' }));
      await this.write(ledger);
      return { status: 'accepted', revision: targetRevision };
    });
  }

  async getApprovalCardDelivery(input: Pick<PurchaseWorkflowCardActionClaimInput, 'recordId' | 'actorOpenId' | 'deliveryMessageId'>): Promise<PurchaseWorkflowNotificationEntry | null> {
    const recordId = clean(input.recordId), actorOpenId = boundedText(input.actorOpenId, MAX_OPEN_ID_LENGTH);
    const messageId = boundedText(input.deliveryMessageId, MAX_DELIVERY_ID_LENGTH);
    if (!RECORD_ID_PATTERN.test(recordId) || !OPEN_ID_PATTERN.test(actorOpenId) || !messageId) return null;
    return this.enqueueCardRead(async () => {
      const matches = (await this.read()).notifications.filter(notification => notification.kind === 'approval_requested' &&
        notification.recordId === recordId && notification.recipientOpenId === actorOpenId && notification.status === 'completed' && notification.messageId === messageId);
      if (matches.length > 1) throw new ConflictException('采购审批原消息映射不唯一');
      return matches[0] || null;
    });
  }

  async listPersonnelHandovers(): Promise<PurchaseManagerBatchHandover[]> {
    return this.enqueueRead(async () => (await this.read()).personnelHandovers.map(entry => structuredClone(entry)));
  }

  async executorHandoverSnapshot() {
    return this.enqueueRead(async () => {
      const ledger = await this.read();
      return structuredClone({ batches: ledger.managerApprovalBatches, commands: ledger.commands, notifications: ledger.notifications });
    });
  }

  async acceptLegacyApprovalHandover(input: PurchaseLegacyApprovalHandoverInput, authorize: () => void): Promise<{ status: 'accepted' | 'already_completed'; version: string }> {
    return this.enqueue(async () => {
      const ledger = await this.read(), source = ledger.notifications.find(row => row.key === input.sourceNotificationKey);
      if (!source || source.kind !== 'approval_requested' || source.recordId !== input.recordId || source.recipientOpenId !== input.sourceOpenId || source.status !== 'completed' || !source.messageId) throw new ConflictException('采购原审批投递凭据无效');
      const prior = source.approvalHandover;
      if (prior) {
        if (prior.mutationId !== input.mutationId || prior.sourceVersion !== input.expectedVersion || prior.sourcePersonRecordId !== input.sourcePersonRecordId || prior.targetOpenId !== input.targetOpenId || prior.targetPersonRecordId !== input.targetPersonRecordId || JSON.stringify(source.approvalAuthority?.scope) !== JSON.stringify(input.scope)) throw new ConflictException('采购原审批交接身份不一致');
        authorize(); return { status: 'accepted', version: legacyApprovalReceiptVersion(source) };
      }
      if (legacyApprovalVersion(source, input.scope) !== input.expectedVersion) throw new ConflictException('采购原审批清单版本已变化');
      const action = ledger.cardActions.find(row => row.recordId === input.recordId);
      if (action) {
        if (action.status === 'failed') throw new ConflictException('采购原审批结果未明确，请先恢复原动作');
        return { status: 'already_completed', version: legacyApprovalAcceptedVersion(source, action) };
      }
      const existingTargets = ledger.notifications.filter(row => row.kind === 'approval_requested' && row.recordId === input.recordId && row.recipientOpenId === input.targetOpenId && !row.approvalHandover);
      if (existingTargets.length > 1 || existingTargets.some(row => row.status !== 'completed' || !row.messageId)) throw new ConflictException('接任人原采购审批卡尚未确认，请先恢复原投递');
      const appId = process.env.FEISHU_APP_ID?.trim();
      const authority = normalizePurchaseCardActionAuthority({ appId, scope: input.scope });
      if (source.approvalAuthority && source.approvalAuthority.appId !== appId) throw new ConflictException('采购原审批属于其他应用');
      const timestamp = new Date().toISOString();
      const terminal = createNotificationEntry({ businessEventId: `legacy-approval-old:${input.mutationId}`, recordId: input.recordId, recipientOpenId: input.sourceOpenId, kind: 'approval_transferred' }, timestamp);
      const target = existingTargets[0] || createNotificationEntry({ businessEventId: `legacy-approval-new:${input.mutationId}`, recordId: input.recordId, recipientOpenId: input.targetOpenId, kind: 'approval_requested' }, timestamp);
      if (target.approvalAuthority && JSON.stringify(target.approvalAuthority) !== JSON.stringify(authority)) throw new ConflictException('接任人原采购审批范围不一致');
      if (!existingTargets.length) { target.approvalAuthority = authority; target.deliveryUuid = stableManagerDeliveryUuid(target.key, 1); }
      const marker: PurchaseSingleManagerHandover = { mutationId: input.mutationId, sourceVersion: input.expectedVersion, sourcePersonRecordId: input.sourcePersonRecordId,
        targetOpenId: input.targetOpenId, targetPersonRecordId: input.targetPersonRecordId, terminalNotificationKey: terminal.key, targetNotificationKey: target.key };
      if (!validSingleManagerHandover(marker) || ledger.notifications.filter(row => isActiveStatus(row.status)).length + (existingTargets.length ? 1 : 2) > MAX_NOTIFICATIONS || ledger.notifications.some(row => row.key === terminal.key || !existingTargets.length && row.key === target.key)) throw new ConflictException('采购原审批交接队列或标记无效');
      authorize(); source.approvalHandover = marker; source.approvalAuthority = authority;
      ledger.notifications.push(terminal); if (!existingTargets.length) ledger.notifications.push(target); await this.write(ledger);
      return { status: 'accepted', version: legacyApprovalReceiptVersion(source) };
    });
  }

  async markLegacyApprovalSendStarted(key: string, claimToken: string, authorityValue: PurchaseCardActionAuthority, context: string, authorize: () => void, now = new Date()) {
    const authority = normalizePurchaseCardActionAuthority(authorityValue), cardContext = normalizeOptionalCardContext(context)!;
    return this.updateNotification(key, claimToken, entry => {
      if (entry.kind !== 'approval_requested' || entry.approvalHandover || entry.approvalAuthority && JSON.stringify(entry.approvalAuthority) !== JSON.stringify(authority)) throw new ConflictException('采购原审批发卡身份已变化');
      if (entry.sendOutcome === 'manual_reconciliation' || !entry.deliveryUuid && entry.attempts > 1) throw new ConflictException('采购原审批发送结果不明，请先核对');
      if (entry.firstSendAttemptAt) {
        if (entry.cardContext !== cardContext || !entry.deliveryUuid || now.getTime() - Date.parse(entry.firstSendAttemptAt) > 55 * 60_000) throw new ConflictException('采购原审批投递已超出安全重试范围，请核对原消息');
        return entry;
      }
      authorize();
      const startedAt = resolveNow(now).toISOString(), deliveryUuid = entry.deliveryUuid || stableManagerDeliveryUuid(entry.key, entry.deliveryGeneration);
      return { ...entry, approvalAuthority: authority, cardContext, deliveryUuid, sendOutcome: 'unknown', firstSendAttemptAt: startedAt,
        deliveryAudit: appendDeliveryAudit(entry.deliveryAudit, { action: 'send_started', at: startedAt, operatorOpenId: '', generation: entry.deliveryGeneration, deliveryUuid, messageId: '' }) };
    });
  }

  async acceptExecutorHandover(input: PurchaseExecutorHandoverInput, authorize: () => void): Promise<{ status: 'accepted' | 'already_completed'; version: string }> {
    return this.enqueue(async () => {
      const ledger = await this.read(), batch = ledger.managerApprovalBatches.find(row => row.approvalBatchId === input.approvalBatchId);
      const item = batch?.items.find(row => row.executionRecordId === input.recordId), prior = item?.executorHandover;
      if (!batch || !item) throw new ConflictException('采购原执行明细不存在');
      if (prior?.mutationId === input.mutationId) {
        if (prior.sourceVersion !== input.expectedVersion || prior.sourceOpenId !== input.sourceOpenId || prior.sourcePersonRecordId !== input.sourcePersonRecordId ||
          prior.targetOpenId !== input.targetOpenId || prior.targetPersonRecordId !== input.targetPersonRecordId || prior.targetName !== input.targetName ||
          prior.choice !== input.choice || JSON.stringify(prior.scope) !== JSON.stringify(input.scope)) throw new ConflictException('采购原执行交接身份不一致');
        authorize();
        return { status: 'accepted', version: purchaseExecutorReceiptVersion(prior) };
      }
      if (item.status !== 'approved' || !['comprehensive', 'building_self'].includes(item.choice) || item.choice !== input.choice || item.purchaserOpenId !== input.sourceOpenId ||
        purchaseExecutorVersion(batch.approvalBatchId, item, input.scope) !== input.expectedVersion || prior && !prior.ready) throw new ConflictException('采购原执行人或交接版本已变化');
      const accepted = ledger.commands.find(row => row.recordId === input.recordId && row.action === 'order') ||
        ledger.notifications.find(row => row.recordId === input.recordId && row.kind === 'manager_batch_order_command' && row.status !== 'failed');
      if (accepted) return { status: 'already_completed', version: input.expectedVersion };
      const sourceCards = ledger.notifications.filter(row => row.kind === 'manager_batch_purchase_assigned' && row.recipientOpenId === input.sourceOpenId && row.cardContext === batch.cardContext);
      if (sourceCards.some(row => row.status !== 'completed' || row.sendOutcome !== 'delivered' || !row.messageId)) throw new ConflictException('采购原执行卡投递尚未明确，请先恢复原任务');
      const timestamp = new Date().toISOString();
      const task = createNotificationEntry({ businessEventId: `executor-handover:${input.mutationId}`, recordId: input.recordId,
        recipientOpenId: input.targetOpenId, kind: 'manager_batch_executor_transferred', cardContext: batch.cardContext }, timestamp);
      const target = createNotificationEntry({ businessEventId: `executor-handover-new:${input.mutationId}`, recordId: input.recordId,
        recipientOpenId: input.targetOpenId, kind: 'manager_batch_purchase_assigned', cardContext: batch.cardContext }, timestamp);
      const refresh = createNotificationEntry({ businessEventId: `executor-handover-old:${input.mutationId}`, recordId: input.recordId,
        recipientOpenId: input.sourceOpenId, kind: 'manager_batch_purchase_refresh', cardContext: batch.cardContext }, timestamp);
      const { expectedVersion, ...identity } = input;
      const marker = normalizePurchaseExecutorHandover({ ...identity, sourceVersion: expectedVersion, appId: process.env.FEISHU_APP_ID?.trim(),
        notificationKey: task.key, targetNotificationKey: target.key, refreshNotificationKey: refresh.key,
        supersededMessageIds: [...new Set([...(prior?.supersededMessageIds || []), ...sourceCards.map(row => row.messageId)])], ready: false });
      if (ledger.notifications.filter(row => isActiveStatus(row.status)).length + 3 > MAX_NOTIFICATIONS || ledger.notifications.some(row => [task.key, target.key, refresh.key].includes(row.key))) throw new ConflictException('采购原通知队列容量或交接键冲突');
      authorize();
      item.executorHandover = marker;
      ledger.notifications.push(task);
      await this.write(ledger);
      return { status: 'accepted', version: purchaseExecutorReceiptVersion(marker) };
    });
  }

  async completeExecutorHandover(key: string, claimToken: string, now = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), task = ledger.notifications.find(row => row.key === key);
      if (!task || task.kind !== 'manager_batch_executor_transferred') throw new ConflictException('采购原执行交接任务不存在');
      assertClaimOwnership(task, claimToken);
      const batch = ledger.managerApprovalBatches.find(row => row.cardContext === task.cardContext && row.recordIds.includes(task.recordId));
      const item = batch?.items.find(row => row.executionRecordId === task.recordId), marker = item?.executorHandover;
      if (!batch || !item || !marker || marker.notificationKey !== key || marker.targetOpenId !== task.recipientOpenId || marker.ready) throw new ConflictException('采购原执行交接领取权已变化');
      const timestamp = resolveNow(now).toISOString();
      const notifications = [
        createNotificationEntry({ businessEventId: `executor-handover-new:${marker.mutationId}`, recordId: task.recordId, recipientOpenId: marker.targetOpenId, kind: 'manager_batch_purchase_assigned', cardContext: batch.cardContext }, timestamp),
        createNotificationEntry({ businessEventId: `executor-handover-old:${marker.mutationId}`, recordId: task.recordId, recipientOpenId: marker.sourceOpenId, kind: 'manager_batch_purchase_refresh', cardContext: batch.cardContext }, timestamp),
      ];
      if (notifications[0].key !== marker.targetNotificationKey || notifications[1].key !== marker.refreshNotificationKey || ledger.notifications.filter(row => isActiveStatus(row.status)).length + 2 > MAX_NOTIFICATIONS || notifications.some(next => ledger.notifications.some(row => row.key === next.key))) throw new ConflictException('采购交接原后续通知不一致');
      item.purchaserOpenId = marker.targetOpenId; item.purchaserName = marker.targetName; item.authorityTarget = marker.scope; marker.ready = true;
      Object.assign(task, { status: 'completed', completedAt: timestamp, updatedAt: timestamp, claimToken: '', leaseUntil: '', lastError: '' });
      ledger.notifications.push(...notifications); batch.updatedAt = timestamp;
      await this.write(ledger);
    });
  }

  async acceptWarehouseInboundHandover(value: WarehouseInboundHandoverInput): Promise<{ status: 'accepted'; generation: number }> {
    const input = normalizeWarehouseInboundHandoverInput(value), fingerprint = warehouseInboundHandoverFingerprint(input);
    return this.enqueue(async () => {
      const ledger = await this.read(), prior = ledger.warehouseInboundHandovers.find(job => job.mutationId === input.mutationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConflictException('待入库提醒原交接身份或载荷不一致');
        return { status: 'accepted' as const, generation: prior.targetGeneration };
      }
      if (input.expectedGeneration !== ledger.warehouseInboundHandovers.filter(job => job.recordId === input.recordId).length + 1 ||
        resolveWarehouseInboundRecipient(ledger.warehouseInboundHandovers, input.recordId, input.sourceOpenId) !== input.sourceOpenId) throw new ConflictException('待入库提醒岗位或代际已变化');
      const sources = ledger.notifications.filter(row => row.recordId === input.recordId && row.kind === 'warehouse_inbound' && row.recipientOpenId === input.sourceOpenId);
      if (sources.some(row => row.status === 'processing' || row.status === 'manual_reconciliation' || row.sendOutcome === 'unknown' || row.sendOutcome === 'manual_reconciliation')) throw new ConflictException('原待入库提醒发送结果需先核对');
      if (ledger.warehouseInboundHandovers.length >= 2000) throw new ServiceUnavailableException('待入库提醒交接历史容量已满');
      const oldMessageIds = [...new Set(sources.flatMap(row => [row.messageId, ...row.deliveryAudit.map(audit => audit.messageId)]).filter(Boolean))];
      if (oldMessageIds.length > 1000 || oldMessageIds.some(id => !/^om_[A-Za-z0-9_-]{1,252}$/.test(id))) throw new ConflictException('原待入库提醒消息凭据需核对');
      const timestamp = new Date().toISOString();
      for (const row of sources) if (row.status !== 'completed' && !row.messageId) Object.assign(row, { status: 'completed', updatedAt: timestamp, completedAt: timestamp,
        leaseUntil: '', claimToken: '', nextAttemptAt: timestamp, lastError: '库房职责已转交，原未发送提醒已取消' });
      const notificationInput: PurchaseWorkflowNotificationInput = { recordId: input.recordId, businessEventId: `warehouse-inbound:${input.recordId}`, recipientOpenId: input.target.openId, kind: 'warehouse_inbound' };
      const key = notificationKey(notificationInput); let next = ledger.notifications.find(row => row.key === key);
      if (!next) {
        if (ledger.notifications.filter(row => isActiveStatus(row.status)).length >= MAX_NOTIFICATIONS) throw new ServiceUnavailableException('采购通知任务队列已满');
        next = createNotificationEntry(notificationInput, timestamp); ledger.notifications.push(next);
      }
      if (next.kind !== 'warehouse_inbound') throw new ConflictException('接任者提醒与原通知键冲突');
      ledger.warehouseInboundHandovers.push({ ...input, fingerprint, targetGeneration: input.expectedGeneration + 1, oldMessageIds, patchedMessageIds: [],
        notificationKey: key, acceptedAt: timestamp, updatedAt: timestamp, status: 'pending', attempts: 0, claimToken: '', leaseUntil: '', nextAttemptAt: timestamp,
        lastError: '', completedAt: '', deliveredMessageId: next.status === 'completed' ? next.messageId : '',
        deliveryConfirmedAt: next.status === 'completed' && next.messageId ? timestamp : '',
        deliveryDisposition: next.status === 'completed' && next.messageId ? 'delivered' : '' });
      await this.write(ledger); return { status: 'accepted' as const, generation: input.expectedGeneration + 1 };
    });
  }

  async retryWarehouseInboundHandover(mutationId: string, authorize: () => void): Promise<void> {
    await this.enqueue(async () => {
      const ledger=await this.read(),job=ledger.warehouseInboundHandovers.find(entry=>entry.mutationId===mutationId);
      if(!job)throw new ConflictException('原入库提醒交接不存在');
      const notification=ledger.notifications.find(task=>task.key===job.notificationKey);
      if(notification?.status==='manual_reconciliation')throw new ConflictException('原入库提醒发送结果尚未核对');
      authorize();let changed=false;
      if(job.status==='failed'){Object.assign(job,{status:'pending',lastError:'',nextAttemptAt:new Date().toISOString(),updatedAt:new Date().toISOString()});changed=true;}
      if(notification&&(notification.status==='failed'||notification.status==='pending'&&notification.lastError)){
        Object.assign(notification,{status:'pending',lastError:'',nextAttemptAt:new Date().toISOString(),completedAt:'',leaseUntil:'',claimToken:''});changed=true;
      }
      if(changed)await this.write(ledger);
    });
  }

  async findWarehouseInboundHandover(mutationId: string): Promise<WarehouseInboundHandover | undefined> {
    return this.enqueueRead(async () => (await this.read()).warehouseInboundHandovers.find(job => job.mutationId === mutationId));
  }

  async takeNextWarehouseInboundHandover(now = new Date(), leaseMs = DEFAULT_LEASE_MS): Promise<WarehouseInboundHandover | null> {
    return this.enqueue(async () => {
      const ledger = await this.read(), job = ledger.warehouseInboundHandovers.find(value => value.status !== 'completed' &&
        Date.parse(value.nextAttemptAt) <= now.getTime() && (value.status !== 'processing' || Date.parse(value.leaseUntil) <= now.getTime()));
      if (!job) return null;
      Object.assign(job, { status: 'processing', attempts: job.attempts + 1, claimToken: randomUUID(), leaseUntil: new Date(now.getTime() + normalizeLeaseMs(leaseMs)).toISOString(), updatedAt: now.toISOString() });
      await this.write(ledger); return job;
    });
  }

  async recordWarehouseInboundCardPatched(mutationId: string, token: string, messageId: string, now = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = requireWarehouseInboundHandover(ledger, mutationId, token);
      if (!job.oldMessageIds.includes(messageId)) throw new ConflictException('旧入库提醒不属于此交接');
      if (job.patchedMessageIds.includes(messageId)) return;
      job.patchedMessageIds.push(messageId); job.updatedAt = now.toISOString(); job.leaseUntil = new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString();
      await this.write(ledger);
    });
  }

  async renewWarehouseInboundHandover(mutationId: string, token: string, now = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = requireWarehouseInboundHandover(ledger, mutationId, token);
      job.leaseUntil = new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString();
      job.updatedAt = now.toISOString();
      await this.write(ledger);
    });
  }

  async completeWarehouseInboundHandover(mutationId: string, token: string, now = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = requireWarehouseInboundHandover(ledger, mutationId, token);
      if (job.oldMessageIds.some(id => !job.patchedMessageIds.includes(id))) throw new ConflictException('旧入库提醒尚未全部终态化');
      Object.assign(job, { status: 'completed', claimToken: '', leaseUntil: '', completedAt: now.toISOString(), updatedAt: now.toISOString(), lastError: '' });
      await this.write(ledger);
    });
  }

  async failWarehouseInboundHandover(mutationId: string, token: string, now = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = requireWarehouseInboundHandover(ledger, mutationId, token);
      Object.assign(job, { status: 'failed', claimToken: '', leaseUntil: '', updatedAt: now.toISOString(), nextAttemptAt: new Date(now.getTime() + 30_000).toISOString(), lastError: '入库提醒交接尚未完成，请恢复原任务' });
      await this.write(ledger);
    });
  }

  async takeNextPersonnelHandover(now: Date = new Date()): Promise<PurchaseManagerBatchHandover | null> {
    return this.enqueue(async () => {
      const ledger = await this.read(), timestamp = resolveNow(now), time = timestamp.getTime();
      const entry = ledger.personnelHandovers.find(job => job.status !== 'completed' &&
        (job.status !== 'processing' || Date.parse(job.leaseUntil) <= time) && Date.parse(job.nextAttemptAt) <= time);
      if (!entry) return null;
      entry.status = 'processing'; entry.claimToken = randomUUID(); entry.leaseUntil = new Date(time + DEFAULT_LEASE_MS).toISOString(); entry.attempts += 1;
      await this.write(ledger); return structuredClone(entry);
    });
  }

  async updatePersonnelHandoverProgress(mutationId: string, claimToken: string, step: 'patch' | 'record' | 'renew', recordId?: string, now: Date = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = requirePersonnelHandoverClaim(ledger, mutationId, claimToken);
      if (step === 'patch') job.oldCardPatchedAt = resolveNow(now).toISOString();
      if (step === 'record') {
        if (!job.oldCardPatchedAt || !recordId || !job.pendingRecordIds.includes(recordId)) throw new ConflictException('采购交接外部回执与原明细不一致');
        if (!job.confirmedRecordIds.includes(recordId)) job.confirmedRecordIds.push(recordId);
      }
      job.leaseUntil = new Date(resolveNow(now).getTime() + DEFAULT_LEASE_MS).toISOString();
      await this.write(ledger);
    });
  }

  async completePersonnelHandover(mutationId: string, claimToken: string, now: Date = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = requirePersonnelHandoverClaim(ledger, mutationId, claimToken);
      const batch = ledger.managerApprovalBatches.find(entry => entry.approvalBatchId === job.approvalBatchId);
      const delivery = batch && managerBatchDeliveries(batch).find(entry => entry.recipientOpenId === job.target.openId);
      if (!job.oldCardPatchedAt || job.pendingRecordIds.some(id => !job.confirmedRecordIds.includes(id)) || !batch ||
        batch.revision !== job.targetRevision || !delivery || delivery.messageId || !['awaiting_delivery', 'active', 'reject_editing'].includes(batch.state) ||
        job.pendingRecordIds.some(id => !batch.items.some(item => item.executionRecordId === id && item.status === 'pending'))) throw new ConflictException('采购交接旧卡、外部状态或当前批次尚未确认');
      const snapshot = parsePurchaseManagerBatchApprovalCardContext(job.oldCardContext);
      const context = serializePurchaseManagerBatchApprovalCardContext({ ...snapshot, items: snapshot.items.map(item => {
        const current = batch.items.find(candidate => candidate.executionRecordId === item.executionRecordId)!;
        return { ...item, status: current.status, choice: current.choice, rejectionReason: current.rejectionReason };
      }) });
      const notification = createNotificationEntry({
        businessEventId: `manager_batch_approval_requested:${job.approvalBatchId}:h-${job.mutationId.slice(-32)}`,
        recordId: job.pendingRecordIds[0], recipientOpenId: job.target.openId, kind: 'manager_batch_approval_requested', cardContext: context,
      }, resolveNow(now).toISOString());
      if (ledger.notifications.some(entry => entry.key === notification.key)) throw new ConflictException('采购交接新通知已被其他任务占用');
      if (ledger.notifications.filter(entry => isActiveStatus(entry.status)).length >= MAX_NOTIFICATIONS) throw new ServiceUnavailableException('采购通知队列已满');
      ledger.notifications.push(notification);
      replaceManagerApprovalBatch(ledger, updateManagerBatchDelivery(batch, job.target.openId, { sourceNotificationKey: notification.key }));
      job.status = 'completed'; job.claimToken = ''; job.leaseUntil = ''; job.lastError = '';
      await this.write(ledger);
    });
  }

  async failPersonnelHandover(mutationId: string, claimToken: string, now: Date = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = requirePersonnelHandoverClaim(ledger, mutationId, claimToken);
      job.status = 'failed'; job.claimToken = ''; job.leaseUntil = '';
      job.nextAttemptAt = new Date(resolveNow(now).getTime() + 30_000).toISOString(); job.lastError = '采购交接旧卡或外部状态尚未确认，可恢复原任务';
      await this.write(ledger);
    });
  }

  async takeNextPersonnelHandoverDelivery(now: Date = new Date()): Promise<{ job: PurchaseManagerBatchHandover; notification: PurchaseWorkflowNotificationEntry } | null> {
    return this.enqueue(async () => {
      const ledger = await this.read(), time = resolveNow(now).getTime();
      for (const job of ledger.personnelHandovers) {
        if (job.status !== 'completed' || job.deliveryConfirmedAt || job.deliveryClaimToken && Date.parse(job.deliveryLeaseUntil || '') > time || Date.parse(job.deliveryNextAttemptAt || job.acceptedAt) > time) continue;
        const notification = ledger.notifications.find(entry => entry.businessEventId === `manager_batch_approval_requested:${job.approvalBatchId}:h-${job.mutationId.slice(-32)}` && entry.recipientOpenId === job.target.openId);
        const batch = ledger.managerApprovalBatches.find(entry => entry.approvalBatchId === job.approvalBatchId);
        const delivery = batch && managerBatchDeliveries(batch).find(entry => entry.recipientOpenId === job.target.openId);
        if (!notification || notification.status !== 'completed' || notification.sendOutcome !== 'delivered' || !notification.messageId ||
          !delivery || delivery.messageId !== notification.messageId || delivery.sourceNotificationKey !== notification.key) continue;
        job.deliveryClaimToken = randomUUID(); job.deliveryLeaseUntil = new Date(time + DEFAULT_LEASE_MS).toISOString();
        await this.write(ledger); return { job: structuredClone(job), notification: structuredClone(notification) };
      }
      return null;
    });
  }

  async recordPersonnelHandoverDeliveryRecord(mutationId: string, claimToken: string, recordId: string, now: Date = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = ledger.personnelHandovers.find(entry => entry.mutationId === mutationId);
      if (!job || !claimToken || job.deliveryClaimToken !== claimToken || !job.pendingRecordIds.includes(recordId)) throw new ConflictException('采购投递回执明细或租约已变化');
      job.deliveryConfirmedRecordIds ??= [];
      if (!job.deliveryConfirmedRecordIds.includes(recordId)) job.deliveryConfirmedRecordIds.push(recordId);
      job.deliveryLeaseUntil = new Date(resolveNow(now).getTime() + DEFAULT_LEASE_MS).toISOString(); await this.write(ledger);
    });
  }

  async settlePersonnelHandoverDelivery(mutationId: string, claimToken: string, messageId: string | null, now: Date = new Date()): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), job = ledger.personnelHandovers.find(entry => entry.mutationId === mutationId);
      if (!job || !claimToken || job.deliveryClaimToken !== claimToken) throw new ConflictException('采购投递回执租约已变化');
      if (messageId) {
        if (job.pendingRecordIds.some(id => !job.deliveryConfirmedRecordIds?.includes(id))) throw new ConflictException('采购新卡投递回执尚未逐项确认');
        const notification = ledger.notifications.find(entry => entry.businessEventId === `manager_batch_approval_requested:${job.approvalBatchId}:h-${job.mutationId.slice(-32)}` && entry.recipientOpenId === job.target.openId);
        const batch = ledger.managerApprovalBatches.find(entry => entry.approvalBatchId === job.approvalBatchId);
        const delivery = batch && managerBatchDeliveries(batch).find(entry => entry.recipientOpenId === job.target.openId);
        if (!notification || notification.messageId !== messageId || notification.status !== 'completed' || notification.sendOutcome !== 'delivered' ||
          !delivery || delivery.messageId !== messageId || delivery.sourceNotificationKey !== notification.key) throw new ConflictException('采购投递回执与正式卡片不一致');
        job.newMessageId = messageId; job.deliveryConfirmedAt = resolveNow(now).toISOString(); delete job.deliveryError;
      } else {
        job.deliveryError = '采购新卡外部投递回执尚未确认，可恢复原任务'; job.deliveryNextAttemptAt = new Date(resolveNow(now).getTime() + 30_000).toISOString();
      }
      delete job.deliveryClaimToken; delete job.deliveryLeaseUntil; await this.write(ledger);
    });
  }

  async registerManagerApprovalBatch(
    inputValue: PurchaseManagerApprovalBatchRegistrationInput,
    now: Date | number = new Date(),
    lifecycleRegistration?: PurchaseLifecycleInitialRegistration,
  ): Promise<{
    created: boolean;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchRegistration(inputValue);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const initial = normalizeLifecycleInitialRegistration(input, lifecycleRegistration);
      if (initial && lifecycleRegistration) for (const recipient of initial.recipients) {
        assertSynchronousLifecycleAuthorization(() => lifecycleRegistration.authorize(structuredClone(recipient), structuredClone(input), structuredClone(initial.authorityTargets)));
      }
      const existing = ledger.managerApprovalBatches.find(
        (entry) => entry.approvalBatchId === input.approvalBatchId,
      );
      if (existing) {
        if (!sameManagerApprovalBatchRegistration(existing, input)) {
          throw new ConflictException('采购审批批次内容冲突');
        }
        if (initial && (existing.lifecycleAppId !== initial.appId || JSON.stringify(existing.lifecycleInitialRecipients) !== JSON.stringify(initial.recipients) || JSON.stringify(existing.lifecycleAuthorityTargets) !== JSON.stringify(initial.authorityTargets))) throw new ConflictException('采购全流程初始收件人或明细范围快照冲突');
        return { created: false, batch: existing };
      }
      const exactRecordSet = ledger.managerApprovalBatches.find((entry) =>
        sameRecordIdSet(entry.recordIds, input.recordIds),
      );
      if (exactRecordSet) {
        if (
          exactRecordSet.recipientOpenId !== input.recipientOpenId ||
          exactRecordSet.requesterOpenId !== input.requesterOpenId ||
          (exactRecordSet.flowVersion || 'legacy') !== (input.flowVersion || 'legacy') ||
          (input.flowVersion === 'lifecycle_v1' && exactRecordSet.approvalBatchId !== input.approvalBatchId)
        ) {
          throw new ConflictException('采购审批记录归属冲突');
        }
        return { created: false, batch: exactRecordSet };
      }
      const inputRecordIds = new Set(input.recordIds);
      if ((ledger.platformLegacyApprovalClaims || []).some(claim => inputRecordIds.has(claim.recordId))) throw new ConflictException('采购明细已有平台审批任务');
      if (
        ledger.managerApprovalBatches.some((entry) =>
          entry.recordIds.some((recordId) => inputRecordIds.has(recordId)),
        )
      ) {
        throw new ConflictException('采购审批记录已被其他批次占用');
      }
      if (
        input.flowVersion === 'lifecycle_v1' && ledger.managerApprovalBatches.filter(entry => entry.flowVersion === 'lifecycle_v1').length >= MAX_MANAGER_APPROVAL_BATCHES
      ) throw new ServiceUnavailableException('采购全流程卡片在途容量已满，请联系管理员');
      if (
        ledger.managerApprovalBatches.filter((entry) =>
          isActiveManagerApprovalBatch(entry),
        ).length >= MAX_MANAGER_APPROVAL_BATCHES
      ) {
        throw new ServiceUnavailableException(
          '采购批次审批队列已满，请稍后重试',
        );
      }
      if (
        ledger.notifications.filter((entry) => isActiveStatus(entry.status))
          .length + (input.managers?.length || 1) > MAX_NOTIFICATIONS
      ) {
        throw new ServiceUnavailableException(
          '采购通知任务队列已满，请稍后重试',
        );
      }

      const timestamp = resolveNow(now).toISOString();
      const notificationInput: PurchaseWorkflowNotificationInput = {
        businessEventId: `manager_batch_approval_requested:${input.approvalBatchId}`,
        recordId: input.recordIds[0]!,
        recipientOpenId: input.recipientOpenId,
        kind: 'manager_batch_approval_requested',
      };
      const notification = createNotificationEntry(
        notificationInput,
        timestamp,
      );
      const batch: PurchaseManagerApprovalBatchEntry = {
        ...input,
        ...(initial ? { lifecycleAppId: initial.appId, lifecycleInitialRecipients: initial.recipients, lifecycleAuthorityTargets: initial.authorityTargets } : {}),
        managerDeliveries: (input.managers || [{ openId: input.recipientOpenId, name: '' }]).map(person => ({
          recipientOpenId: person.openId, recipientName: person.name,
          sourceNotificationKey: notificationKey({ ...notificationInput, recipientOpenId: person.openId }),
          messageId: '', selectedRejectRecordId: '',
        })),
        items: input.recordIds.map((executionRecordId) => ({
          executionRecordId,
          ...(initial ? { authorityTarget: initial.authorityTargets.find(item => item.recordId === executionRecordId)!.target } : {}),
          status: 'pending',
          choice: '',
          rejectionReason: '',
          actionEventId: '',
          actorOpenId: '',
          processedAt: '',
          lastError: '',
          purchaserOpenId: '',
          purchaserName: '',
          paymentAttachmentTokens: [],
          receiptPhotoTokens: [],
          invoiceTokens: [],
        })),
        state: 'awaiting_delivery',
        selectedRejectRecordId: '',
        sourceNotificationKey: notification.key,
        messageId: '',
        cardContext: '',
        revision: 1,
        actorOpenId: '',
        processedAt: '',
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: '',
      };
      ledger.managerApprovalBatches.push(batch);
      if (initial) {
        const entries = ledger.lifecycleOutbox ||= [];
        for (const recipient of initial.recipients) upsertLifecycleEntry(entries, { appId: initial.appId, batchId: input.approvalBatchId, recipientOpenId: recipient.openId }, 1, recipient.fullView);
      }
      ledger.notifications.push(notification);
      for (const delivery of managerBatchDeliveries(batch).slice(1)) {
        ledger.notifications.push(createNotificationEntry({ ...notificationInput, recipientOpenId: delivery.recipientOpenId }, timestamp));
      }
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      ledger.managerApprovalBatches = trimManagerApprovalBatchHistory(
        ledger.managerApprovalBatches,
        ledger.notifications,
      );
      await this.write(ledger);
      return { created: true, batch };
    });
  }

  async recoverManagerReceiptBatchAndEnqueue(
    inputValue: PurchaseManagerReceiptBatchRecoveryInput,
    now: Date | number = new Date(),
  ): Promise<{
    outcome: PurchaseManagerReceiptBatchRecoveryOutcome;
    created: boolean;
    batch: PurchaseManagerApprovalBatchEntry | null;
    notification: PurchaseWorkflowNotificationEntry | null;
  }> {
    const registration = normalizeManagerApprovalBatchRegistration(inputValue);
    const cardContext = canonicalManagerBatchCardContext(
      inputValue.cardContext,
    );
    const context = parsePurchaseManagerBatchApprovalCardContext(cardContext);
    if (
      context.approvalBatchId !== registration.approvalBatchId ||
      context.requesterOpenId !== registration.requesterOpenId ||
      !sameStringArray(
        registration.recordIds,
        context.items.map((item) => item.executionRecordId),
      )
    ) {
      throw new ConflictException('采购签收恢复批次上下文不匹配');
    }
    if (
      !Array.isArray(inputValue.items) ||
      inputValue.items.length !== registration.recordIds.length
    ) {
      throw new BadRequestException('采购签收恢复批次明细无效');
    }
    const normalizedItems = registration.recordIds.map((executionRecordId) => {
      const source = inputValue.items.find(
        (item) => clean(item.executionRecordId) === executionRecordId,
      );
      if (
        !source ||
        (source.choice !== 'comprehensive' && source.choice !== 'building_self')
      ) {
        throw new BadRequestException('采购签收恢复批次审批结果无效');
      }
      const purchaserOpenId = boundedText(
        source.purchaserOpenId,
        MAX_OPEN_ID_LENGTH,
      );
      if (!OPEN_ID_PATTERN.test(purchaserOpenId)) {
        throw new BadRequestException('采购签收恢复批次采购人无效');
      }
      const actualQuantity = Number(source.actualQuantity);
      const actualAmount = Number(source.actualAmount);
      if (
        !Number.isFinite(actualQuantity) ||
        actualQuantity <= 0 ||
        !Number.isFinite(actualAmount) ||
        actualAmount < 0
      ) {
        throw new BadRequestException('采购签收恢复批次下单结果无效');
      }
      const entry: PurchaseManagerApprovalBatchItemEntry = {
        executionRecordId,
        status: 'approved',
        choice: source.choice,
        rejectionReason: '',
        actionEventId: 'base-receipt-recovery',
        actorOpenId: registration.recipientOpenId,
        processedAt: '',
        lastError: '',
        purchaserOpenId,
        purchaserName: boundedText(source.purchaserName, 200),
        paymentAttachmentTokens: sanitizeAttachmentTokens(
          source.paymentAttachmentTokens,
        ),
        receiptPhotoTokens: [],
        invoiceTokens: [],
      };
      return {
        entry,
        actualQuantity,
        actualAmount,
        note: boundedText(source.note, 500),
      };
    });
    const delivered = inputValue.delivered
      ? normalizeReceiptDeliveryEvidence(inputValue.delivered, now)
      : null;
    const batchIdSource =
      inputValue.batchIdSource === 'persisted' ? 'persisted' : 'derived';
    const createIfMissing = inputValue.createIfMissing !== false;
    return this.enqueue(async () => {
      const ledger = await this.read();
      const timestamp = resolveNow(now).toISOString();
      let created = false;
      const requestedRecordIds = new Set(registration.recordIds);
      const owners = ledger.managerApprovalBatches.filter((entry) =>
        entry.recordIds.some((recordId) => requestedRecordIds.has(recordId)),
      );
      if (owners.length > 1) {
        throw new ConflictException('采购签收记录存在多个批次所有者');
      }
      let batch = owners[0] || null;
      if (batch) {
        if (
          (batchIdSource === 'persisted' &&
            batch.approvalBatchId !== registration.approvalBatchId) ||
          batch.requesterOpenId !== registration.requesterOpenId ||
          batch.state !== 'resolved' ||
          !batch.cardContext ||
          registration.recordIds.some((recordId) => {
            const item = batch!.items.find(
              (candidate) => candidate.executionRecordId === recordId,
            );
            const expected = normalizedItems.find(
              (candidate) => candidate.entry.executionRecordId === recordId,
            );
            return (
              !item ||
              !expected ||
              item.status !== 'approved' ||
              item.choice !== expected.entry.choice ||
              item.purchaserOpenId !== expected.entry.purchaserOpenId
            );
          })
        ) {
          throw new ConflictException('采购签收恢复批次与已有台账冲突');
        }
      } else {
        const conflictingBatchId = ledger.managerApprovalBatches.find(
          (entry) => entry.approvalBatchId === registration.approvalBatchId,
        );
        if (conflictingBatchId) {
          throw new ConflictException('采购签收恢复批次标识已被其他记录占用');
        }
        if (!createIfMissing) {
          return {
            outcome: 'missing',
            created: false,
            batch: null,
            notification: null,
          };
        }
        const syntheticMessageId = `base-recovery-${createHash('sha256')
          .update(registration.approvalBatchId, 'utf8')
          .digest('hex')
          .slice(0, 32)}`;
        batch = {
          ...registration,
          items: normalizedItems.map(({ entry }) => ({
            ...entry,
            processedAt: timestamp,
          })),
          state: 'resolved',
          selectedRejectRecordId: '',
          sourceNotificationKey: `base-receipt-recovery:${registration.approvalBatchId}`,
          messageId: syntheticMessageId,
          cardContext,
          revision: 1,
          actorOpenId: registration.recipientOpenId,
          processedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: timestamp,
        };
        ledger.managerApprovalBatches.push(batch);
        created = true;
      }

      const effectiveBatch = batch;
      const effectiveCardContext = effectiveBatch.cardContext || cardContext;
      const notificationInput: PurchaseWorkflowNotificationInput = {
        businessEventId: `manager_batch_receipt_requested:${effectiveBatch.approvalBatchId}`,
        recordId: effectiveBatch.recordIds[0]!,
        recipientOpenId: effectiveBatch.requesterOpenId,
        kind: 'manager_batch_receipt_requested',
        cardContext: effectiveCardContext,
      };
      for (const item of normalizedItems) {
        const orderContext = serializePurchaseBatchFulfillmentCommandContext({
          version: 4,
          workflowType: 'purchase_batch_fulfillment',
          action: 'order',
          approvalBatchId: effectiveBatch.approvalBatchId,
          executionRecordId: item.entry.executionRecordId,
          actorOpenId: item.entry.purchaserOpenId,
          actualQuantity: item.actualQuantity,
          actualAmount: item.actualAmount,
          note: item.note,
          paymentAttachmentTokens: [...item.entry.paymentAttachmentTokens],
        });
        const orderInput: PurchaseWorkflowNotificationInput = {
          businessEventId: `manager_batch_order_command:base-recovery:${effectiveBatch.approvalBatchId}:${item.entry.executionRecordId}`,
          recordId: item.entry.executionRecordId,
          recipientOpenId: item.entry.purchaserOpenId,
          kind: 'manager_batch_order_command',
          cardContext: orderContext,
        };
        const existingOrder = ledger.notifications.find((entry) => {
          if (
            entry.kind !== 'manager_batch_order_command' ||
            entry.recordId !== item.entry.executionRecordId ||
            entry.status !== 'completed'
          ) {
            return false;
          }
          try {
            const context = parsePurchaseBatchFulfillmentCommandContext(
              entry.cardContext,
            );
            return (
              context.action === 'order' &&
              context.approvalBatchId === effectiveBatch.approvalBatchId
            );
          } catch {
            return false;
          }
        });
        if (existingOrder) {
          if (existingOrder.cardContext !== orderContext) {
            throw new ConflictException('采购签收恢复下单快照与已有台账冲突');
          }
          continue;
        }
        ledger.notifications.push({
          ...createNotificationEntry(orderInput, timestamp),
          status: 'completed',
          updatedAt: timestamp,
          completedAt: timestamp,
          nextAttemptAt: timestamp,
        });
      }
      const receiptOwners = ledger.notifications.filter(
        (entry) =>
          entry.kind === 'manager_batch_receipt_requested' &&
          entry.businessEventId === notificationInput.businessEventId,
      );
      if (receiptOwners.length > 1) {
        throw new ConflictException('采购签收恢复通知标识不唯一');
      }
      let notification = receiptOwners[0];
      if (notification) {
        if (
          notification.recipientOpenId !== notificationInput.recipientOpenId ||
          notification.cardContext !== effectiveCardContext
        ) {
          throw new ConflictException('采购签收恢复通知与已有台账冲突');
        }
        if (delivered) {
          if (
            notification.messageId &&
            notification.messageId !== delivered.messageId
          ) {
            throw new ConflictException('采购签收卡消息标识与本地台账冲突');
          }
          notification = toDeliveredReceiptNotification(
            notification,
            delivered,
          );
          const notificationIndex = ledger.notifications.findIndex(
            (entry) => entry.key === notification!.key,
          );
          ledger.notifications[notificationIndex] = notification;
        }
      } else {
        if (!createIfMissing && !delivered) {
          return {
            outcome: 'missing',
            created,
            batch: effectiveBatch,
            notification: null,
          };
        }
        if (
          ledger.notifications.filter((entry) => isActiveStatus(entry.status))
            .length >= MAX_NOTIFICATIONS
        ) {
          throw new ServiceUnavailableException(
            '采购通知任务队列已满，请稍后重试',
          );
        }
        notification = delivered
          ? toDeliveredReceiptNotification(
              createNotificationEntry(notificationInput, timestamp),
              delivered,
            )
          : createNotificationEntry(notificationInput, timestamp);
        ledger.notifications.push(notification);
      }
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      ledger.managerApprovalBatches = trimManagerApprovalBatchHistory(
        ledger.managerApprovalBatches,
        ledger.notifications,
      );
      await this.write(ledger);
      return {
        outcome: delivered
          ? created
            ? 'rehydrated_delivered'
            : 'existing_delivered'
          : notification.sendOutcome === 'delivered'
            ? 'existing_delivered'
            : created
              ? 'queued'
              : 'existing_pending',
        created,
        batch: effectiveBatch,
        notification,
      };
    });
  }

  async findManagerApprovalBatch(
    approvalBatchIdValue: string,
  ): Promise<PurchaseManagerApprovalBatchEntry | null> {
    const approvalBatchId =
      normalizeManagerApprovalBatchId(approvalBatchIdValue);
    return this.enqueueRead(async () => {
      const matches = (await this.read()).managerApprovalBatches.filter(
        (entry) => entry.approvalBatchId === approvalBatchId,
      );
      if (matches.length > 1) {
        throw new ConflictException('采购审批批次标识不唯一');
      }
      return matches[0] || null;
    });
  }

  async listManagerApprovalBatchIds(): Promise<string[]> {
    return this.enqueueRead(async () =>
      (await this.read()).managerApprovalBatches.map(
        (entry) => entry.approvalBatchId,
      ),
    );
  }

  async requeueLegacyIncompatibleManagerApprovalBatchDelivery(
    approvalBatchIdValue: string,
    evidence: PurchaseManagerLegacyCardRecoveryEvidence,
    now: Date | number = new Date(),
    recipientOpenIdValue?: string,
  ): Promise<{
    requeued: boolean;
    notification: PurchaseWorkflowNotificationEntry | null;
  }> {
    const approvalBatchId =
      normalizeManagerApprovalBatchId(approvalBatchIdValue);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const batch = ledger.managerApprovalBatches.find(
        (entry) => entry.approvalBatchId === approvalBatchId,
      );
      if (!batch) return { requeued: false, notification: null };
      const recipients = managerBatchDeliveries(batch).filter(delivery =>
        recipientOpenIdValue === undefined || delivery.recipientOpenId === clean(recipientOpenIdValue));
      const candidates = recipients.map(delivery => ({ delivery, notification: ledger.notifications.find(entry => entry.key === delivery.sourceNotificationKey) }));
      const eligible = candidates.filter(({ delivery, notification }) => notification && !delivery.messageId &&
        notification.recipientOpenId === delivery.recipientOpenId && notification.kind === 'manager_batch_approval_requested' &&
        notification.sendOutcome !== 'delivered' && !notification.messageId &&
        (notification.attempts > 0 || notification.firstSendAttemptAt || notification.sendOutcome !== 'unattempted') &&
        isProvenLegacyCardSchemaRejection(notification, evidence));
      if (eligible.length > 1) throw new ConflictException('多张采购审批卡需要恢复，请指定接收人');
      const current = eligible[0]?.notification;
      if (!current) return { requeued: false, notification: candidates.length === 1 ? candidates[0]!.notification || null : null };
      const notificationIndex = ledger.notifications.findIndex(entry => entry.key === current.key);
      const timestamp = resolveNow(now).toISOString();
      const nextGeneration = current.deliveryGeneration + 1;
      const notification: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'pending',
        attempts: 0,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
        deliveryId: '',
        messageId: '',
        cardContext: '',
        deliveryUuid: stableManagerDeliveryUuid(current.key, nextGeneration),
        firstSendAttemptAt: '',
        sendOutcome: 'unattempted',
        deliveryGeneration: nextGeneration,
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'legacy_card_schema_requeued',
          at: timestamp,
          operatorOpenId: '',
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId: '',
        }),
      };
      ledger.notifications[notificationIndex] = notification;
      await this.write(ledger);
      return { requeued: true, notification };
    });
  }

  async requeueFailedUnattemptedManagerBatchReceipt(
    approvalBatchIdValue: string,
    now: Date | number = new Date(),
  ): Promise<boolean> {
    const approvalBatchId =
      normalizeManagerApprovalBatchId(approvalBatchIdValue);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const batch = ledger.managerApprovalBatches.find(
        (entry) => entry.approvalBatchId === approvalBatchId,
      );
      const index = ledger.notifications.findIndex(
        (entry) =>
          isCanonicalStageReceipt(entry, batch, approvalBatchId),
      );
      const current = ledger.notifications[index];
      if (
        !batch ||
        !current ||
        current.status !== 'failed' ||
        current.recipientOpenId !== batch.requesterOpenId ||
        (current.cardContext !== batch.cardContext && current.cardContext !== batch.stageCardTransition?.originalCardContext) ||
        current.sendOutcome !== 'unattempted' ||
        current.firstSendAttemptAt ||
        current.messageId ||
        current.deliveryAudit.some(
          (entry) =>
            entry.action === 'send_started' || entry.action === 'send_rejected',
        ) ||
        current.deliveryAudit.some(
          (entry) => entry.action === 'receipt_delivery_requeued',
        )
      ) {
        return false;
      }
      const timestamp = resolveNow(now).toISOString();
      const nextGeneration = current.deliveryGeneration + 1;
      ledger.notifications[index] = {
        ...current,
        status: 'pending',
        attempts: 0,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
        deliveryId: '',
        deliveryUuid: stableManagerDeliveryUuid(current.key, nextGeneration),
        deliveryGeneration: nextGeneration,
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'receipt_delivery_requeued',
          at: timestamp,
          operatorOpenId: '',
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId: '',
        }),
      };
      await this.write(ledger);
      return true;
    });
  }

  async requeueFailedMigratedOrderCard(
    expected: PurchaseWorkflowNotificationEntry,
    batchId: string,
    now: Date,
    authorize: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const task = ledger.notifications.find(entry => entry.key === expected.key);
      const batch = ledger.managerApprovalBatches.find(entry => entry.approvalBatchId === batchId);
      const transition = batch?.stageCardTransition;
      if (!task || !batch || !transition || transition.appId !== readEnv('FEISHU_APP_ID') ||
          !isFailedUnattemptedMigratedOrderCard(task) || task.updatedAt !== expected.updatedAt ||
          task.deliveryUuid !== expected.deliveryUuid || task.cardContext !== expected.cardContext || task.cardContext !== batch.cardContext ||
          task.businessEventId !== `manager_batch_purchase_assigned:${batchId}:${batch.revision}` ||
          !lifecycleFulfillmentContextMatches(task.cardContext, batch, task.recordId) ||
          !batch.items.some(item => item.executionRecordId === task.recordId && item.status === 'approved' &&
            item.purchaserOpenId === task.recipientOpenId && item.authorityTarget) ||
          ledger.commands.some(entry => entry.recordId === task.recordId && entry.action === 'order') ||
          ledger.notifications.some(entry => entry.recordId === task.recordId && entry.kind === 'manager_batch_order_command') ||
          ledger.notifications.some(entry => entry.key !== task.key && entry.kind === task.kind &&
            entry.recipientOpenId === task.recipientOpenId && retainedStageNotification(entry, transition) &&
            lifecycleFulfillmentContextMatches(entry.cardContext, batch, entry.recordId))) return false;

      const entries = Array.isArray(raw.notifications) ? raw.notifications.filter(entry => isRecord(entry) && entry.key === task.key) : [];
      const source = entries[0];
      if (entries.length !== 1 || !isRecord(source) || source.sendOutcome !== 'unattempted' ||
          source.messageId !== '' || source.deliveryId !== '' || source.firstSendAttemptAt !== '' ||
          source.leaseUntil !== '' || source.claimToken !== '' || !Array.isArray(source.deliveryAudit) ||
          source.deliveryAudit.length !== 0 || source.deliveryUuid !== task.deliveryUuid ||
          source.deliveryGeneration !== task.deliveryGeneration) return false;

      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch)));
      const timestamp = resolveNow(now).toISOString();
      // Preserve the fifth attempt so the normal claim increments it to six.
      // Another failure cannot match the one-time recovery condition.
      Object.assign(source, { status: 'pending', updatedAt: timestamp, nextAttemptAt: timestamp, completedAt: '', lastError: '' });
      await this.writeLifecycleRaw(raw, original);
      return true;
    });
  }

  async requeueRejectedManagerBatchReceiptCardSchema(
    approvalBatchIdValue: string,
    now: Date | number = new Date(),
  ): Promise<boolean> {
    const approvalBatchId =
      normalizeManagerApprovalBatchId(approvalBatchIdValue);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const batch = ledger.managerApprovalBatches.find(
        (entry) => entry.approvalBatchId === approvalBatchId,
      );
      const index = ledger.notifications.findIndex(
        (entry) =>
          isCanonicalStageReceipt(entry, batch, approvalBatchId),
      );
      const current = ledger.notifications[index];
      if (
        !batch ||
        !current ||
        current.status !== 'failed' ||
        current.recipientOpenId !== batch.requesterOpenId ||
        (current.cardContext !== batch.cardContext && current.cardContext !== batch.stageCardTransition?.originalCardContext) ||
        current.sendOutcome !== 'unattempted' ||
        current.messageId ||
        !isProvenReceiptFormNameSchemaRejection(current) ||
        current.deliveryAudit.some(
          (entry) => entry.action === 'receipt_card_schema_requeued',
        )
      ) {
        return false;
      }
      const timestamp = resolveNow(now).toISOString();
      const nextGeneration = current.deliveryGeneration + 1;
      ledger.notifications[index] = {
        ...current,
        status: 'pending',
        attempts: 0,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
        deliveryId: '',
        messageId: '',
        deliveryUuid: stableManagerDeliveryUuid(current.key, nextGeneration),
        firstSendAttemptAt: '',
        sendOutcome: 'unattempted',
        deliveryGeneration: nextGeneration,
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'receipt_card_schema_requeued',
          at: timestamp,
          operatorOpenId: '',
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId: '',
        }),
      };
      await this.write(ledger);
      return true;
    });
  }

  async markManagerApprovalBatchSendStarted(
    key: string,
    claimToken: string,
    cardContext: string,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    const canonicalContext = canonicalManagerBatchCardContext(cardContext);
    const claimCheckStarted = Date.now(), claimCheckNow = resolveNow(now).getTime();
    return this.updateNotification(key, claimToken, (entry) => {
      if (!Number.isFinite(Date.parse(entry.leaseUntil)) || Date.parse(entry.leaseUntil) <= claimCheckNow + Date.now() - claimCheckStarted) throw new ConflictException('采购批次审批发卡租约已过期，请重试原通知任务');
      if (
        entry.kind !== 'manager_batch_approval_requested' &&
        entry.kind !== 'manager_batch_approval_result' &&
        entry.kind !== 'manager_batch_purchase_assigned' &&
        entry.kind !== 'manager_batch_receipt_requested' &&
        entry.kind !== 'manager_batch_receipt_completed'
      ) {
        throw new ConflictException('采购批次审批通知类型不支持发卡');
      }
      if (entry.sendOutcome === 'manual_reconciliation') {
        throw new ConflictException('采购批次审批卡发送结果需人工核对');
      }
      if (entry.cardContext && entry.cardContext !== canonicalContext) {
        throw new ConflictException('采购批次审批卡上下文与首次发送不一致');
      }
      const startedAt =
        entry.firstSendAttemptAt || resolveNow(now).toISOString();
      const alreadyAudited = entry.deliveryAudit.some(
        (audit) =>
          audit.action === 'send_started' &&
          audit.generation === entry.deliveryGeneration,
      );
      const alreadySchemaCompatible = entry.deliveryAudit.some(
        (audit) =>
          audit.action === 'card_schema_v2_compatible' &&
          audit.generation === entry.deliveryGeneration,
      );
      let deliveryAudit = entry.deliveryAudit;
      if (!alreadySchemaCompatible) {
        deliveryAudit = appendDeliveryAudit(deliveryAudit, {
          action: 'card_schema_v2_compatible',
          at: resolveNow(now).toISOString(),
          operatorOpenId: '',
          generation: entry.deliveryGeneration,
          deliveryUuid: entry.deliveryUuid,
          messageId: '',
        });
      }
      if (!alreadyAudited) {
        deliveryAudit = appendDeliveryAudit(deliveryAudit, {
          action: 'send_started',
          at: startedAt,
          operatorOpenId: '',
          generation: entry.deliveryGeneration,
          deliveryUuid: entry.deliveryUuid,
          messageId: '',
        });
      }
      return {
        ...entry,
        updatedAt: resolveNow(now).toISOString(),
        firstSendAttemptAt: startedAt,
        sendOutcome: 'unknown',
        cardContext: canonicalContext,
        deliveryAudit,
      };
    });
  }

  async recordManagerCardRejectedSend(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number | null,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.updateNotification(key, claimToken, (entry) => {
      if (
        !isManagerNotificationKind(entry.kind) ||
        entry.sendOutcome !== 'unknown'
      ) {
        throw new ConflictException('采购互动卡明确拒绝状态不允许记录');
      }
      const timestamp = resolveNow(now).toISOString();
      const terminal = nextAttemptAt === null;
      return {
        ...entry,
        status: terminal ? 'failed' : 'pending',
        updatedAt: timestamp,
        nextAttemptAt: terminal
          ? timestamp
          : resolveNow(nextAttemptAt).toISOString(),
        leaseUntil: '',
        claimToken: '',
        completedAt: terminal ? timestamp : '',
        lastError: sanitizeError(error),
        firstSendAttemptAt: '',
        sendOutcome: 'unattempted',
        deliveryAudit: appendDeliveryAudit(entry.deliveryAudit, {
          action: 'send_rejected',
          at: timestamp,
          operatorOpenId: '',
          generation: entry.deliveryGeneration,
          deliveryUuid: entry.deliveryUuid,
          messageId: '',
        }),
      };
    });
  }

  async completeManagerApprovalBatchRequestAndRegisterCard(
    key: string,
    claimToken: string,
    delivery: PurchaseWorkflowNotificationDelivery & { messageId: string },
    now: Date | number = new Date(),
  ): Promise<{
    notification: PurchaseWorkflowNotificationEntry;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const notificationIndex = ledger.notifications.findIndex(
        (entry) => entry.key === clean(key),
      );
      const current = ledger.notifications[notificationIndex];
      if (notificationIndex < 0 || !current) {
        throw new ConflictException('采购批次审批发卡通知不存在');
      }
      assertClaimOwnership(current, claimToken);
      if (
        current.kind !== 'manager_batch_approval_requested' ||
        current.sendOutcome !== 'unknown' ||
        !current.firstSendAttemptAt ||
        !current.cardContext
      ) {
        throw new ConflictException('采购批次审批发卡通知状态不允许完成');
      }
      const context = parsePurchaseManagerBatchApprovalCardContext(
        current.cardContext,
      );
      const batchIndex = ledger.managerApprovalBatches.findIndex(
        (entry) => entry.approvalBatchId === context.approvalBatchId,
      );
      const existingBatch = ledger.managerApprovalBatches[batchIndex];
      const managerDelivery = existingBatch && managerBatchDeliveries(existingBatch).find(item => item.recipientOpenId === current.recipientOpenId);
      if (
        batchIndex < 0 ||
        !existingBatch ||
        !managerDelivery || managerDelivery.messageId ||
        managerDelivery.sourceNotificationKey !== current.key ||
        !sameStringArray(
          existingBatch.recordIds,
          context.items.map((item) => item.executionRecordId),
        )
      ) {
        throw new ConflictException('采购批次审批发卡上下文与台账不一致');
      }
      const messageId = requiredDeliveryId(delivery?.messageId);
      if (
        ledger.managerApprovalBatches.some(
          (entry) =>
            managerBatchDeliveries(entry).some(item => item.messageId === messageId),
        )
      ) {
        throw new ConflictException('采购批次审批消息已绑定其他批次');
      }
      const timestamp = resolveNow(now).toISOString();
      const notification: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'completed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
        deliveryId:
          boundedText(delivery?.deliveryId, MAX_DELIVERY_ID_LENGTH) ||
          current.deliveryId,
        messageId,
        sendOutcome: 'delivered',
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'send_delivered',
          at: timestamp,
          operatorOpenId: '',
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId,
        }),
      };
      const batch = updateManagerBatchDelivery({
        ...existingBatch,
        state: existingBatch.state === 'awaiting_delivery' ? 'active' : existingBatch.state,
        cardContext: existingBatch.cardContext || current.cardContext,
        updatedAt: timestamp,
      }, current.recipientOpenId, { messageId });
      ledger.notifications[notificationIndex] = notification;
      ledger.managerApprovalBatches[batchIndex] = batch;
      if (existingBatch.state !== 'awaiting_delivery' &&
        (existingBatch.state === 'processing' || existingBatch.state === 'resolved' || existingBatch.state === 'manual_reconciliation' || existingBatch.cardContext !== current.cardContext)) {
        enqueueManagerApprovalBatchStateNotifications(ledger, batch, 'manager_batch_approval_refresh', timestamp);
      }
      await this.write(ledger);
      return { notification, batch };
    });
  }

  async findManagerApprovalBatchCard(
    messageIdValue: string,
    actorOpenIdValue: string,
  ): Promise<PurchaseManagerApprovalBatchEntry | null> {
    const messageId = boundedText(messageIdValue, MAX_DELIVERY_ID_LENGTH);
    const actorOpenId = boundedText(actorOpenIdValue, MAX_OPEN_ID_LENGTH);
    if (!messageId || !OPEN_ID_PATTERN.test(actorOpenId)) return null;
    return this.enqueueCardRead(async () => {
      const ledger = await this.read();
      const matches = ledger.managerApprovalBatches.filter(
        (entry) =>
          managerBatchDeliveries(entry).some(delivery => delivery.recipientOpenId === actorOpenId && (entry.flowVersion === 'lifecycle_v1'
            ? (ledger.lifecycleOutbox || []).some(row => row.replica.batchId === entry.approvalBatchId && row.replica.recipientOpenId === actorOpenId && row.replica.messageId === messageId && row.replica.state === 'delivered')
            : delivery.messageId === messageId)) &&
          entry.state !== 'awaiting_delivery',
      );
      if (matches.length > 1) {
        throw new ConflictException('采购批次审批卡消息映射不唯一');
      }
      return matches[0] ? { ...managerBatchCardView(matches[0], actorOpenId), ...(matches[0].flowVersion === 'lifecycle_v1' ? { messageId } : {}) } : null;
    });
  }

  async bindUnknownManagerApprovalBatchDeliveryFromCallback(
    inputValue: PurchaseManagerApprovalBatchCallbackBindingInput,
    now: Date | number = new Date(),
  ): Promise<{
    bound: boolean;
    notification: PurchaseWorkflowNotificationEntry;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const identity = normalizeManagerApprovalBatchCardIdentity(inputValue);
    return this.enqueueCard(async () => {
      const ledger = await this.read();
      const matches = ledger.managerApprovalBatches.filter(
        (entry) => entry.approvalBatchId === identity.approvalBatchId,
      );
      if (matches.length !== 1 || !matches[0]) {
        throw new ConflictException('采购批次审批卡批次映射不存在');
      }
      const batch = managerBatchCardView(matches[0], identity.actorOpenId);
      if (batch.recipientOpenId !== identity.actorOpenId) {
        throw new ConflictException('采购批次审批卡身份不匹配');
      }
      if (batch.messageId) {
        if (batch.messageId !== identity.messageId) {
          throw new ConflictException('采购批次审批卡已绑定其他消息');
        }
        const delivered = ledger.notifications.find(
          (entry) => entry.key === batch.sourceNotificationKey,
        );
        if (
          !delivered ||
          delivered.kind !== 'manager_batch_approval_requested' ||
          delivered.status !== 'completed' ||
          delivered.sendOutcome !== 'delivered'
        ) {
          throw new ConflictException('采购批次审批卡来源通知状态异常');
        }
        return { bound: false, notification: delivered, batch };
      }
      if (
        ledger.managerApprovalBatches.some(
          (entry) =>
            managerBatchDeliveries(entry).some(delivery => delivery.messageId === identity.messageId),
        ) ||
        ledger.managerApprovalCards.some(
          (card) =>
            card.messageId === identity.messageId ||
            card.supersededMessageIds.includes(identity.messageId),
        )
      ) {
        throw new ConflictException('采购批次审批卡消息已绑定其他记录');
      }
      const notificationIndex = ledger.notifications.findIndex(
        (entry) => entry.key === batch.sourceNotificationKey,
      );
      const current = ledger.notifications[notificationIndex];
      if (
        notificationIndex < 0 ||
        !current ||
        current.kind !== 'manager_batch_approval_requested' ||
        current.recipientOpenId !== identity.actorOpenId ||
        current.status !== 'manual_reconciliation' ||
        current.sendOutcome !== 'manual_reconciliation' ||
        !current.cardContext
      ) {
        throw new ConflictException('采购批次审批卡未知送达记录不存在');
      }
      const context = parsePurchaseManagerBatchApprovalCardContext(
        current.cardContext,
      );
      if (
        context.approvalBatchId !== batch.approvalBatchId ||
        context.requesterOpenId !== batch.requesterOpenId ||
        !sameStringArray(
          batch.recordIds,
          context.items.map((item) => item.executionRecordId),
        )
      ) {
        throw new ConflictException('采购批次审批卡上下文与台账不一致');
      }
      const timestamp = resolveNow(now).toISOString();
      const notification: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'completed',
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
        messageId: identity.messageId,
        sendOutcome: 'delivered',
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'callback_bound',
          at: timestamp,
          operatorOpenId: identity.actorOpenId,
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId: identity.messageId,
        }),
      };
      const activeBatch = updateManagerBatchDelivery({
        ...batch,
        state: batch.state === 'awaiting_delivery' ? 'active' : batch.state,
        cardContext: batch.cardContext || current.cardContext,
        updatedAt: timestamp,
      }, identity.actorOpenId, { messageId: identity.messageId });
      ledger.notifications[notificationIndex] = notification;
      replaceManagerApprovalBatch(ledger, activeBatch);
      if (batch.state !== 'awaiting_delivery') {
        enqueueManagerApprovalBatchStateNotifications(ledger, activeBatch, 'manager_batch_approval_refresh', timestamp);
      }
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { bound: true, notification, batch: managerBatchCardView(activeBatch, identity.actorOpenId) };
    });
  }

  async openManagerApprovalBatchRejectEditor(
    inputValue: PurchaseManagerApprovalBatchCardIdentity & {
      executionRecordId: string;
    },
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<{
    opened: boolean;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchCardIdentity(inputValue);
    const executionRecordId = normalizeRecordId(inputValue.executionRecordId);
    return this.enqueueCard(async () => {
      const ledger = await this.read();
      const batch = requireActiveManagerApprovalBatch(ledger, input);
      if (batch.flowVersion === 'lifecycle_v1' || batch.stageCardTransition) {
        if (!authorize) throw new ForbiddenException('采购全流程卡片缺少当前职责校验');
        assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch)));
      }
      if (batch.state !== 'active') return { opened: false, batch };
      const item = batch.items.find(
        (entry) => entry.executionRecordId === executionRecordId,
      );
      if (!item || item.status !== 'pending') {
        return { opened: false, batch };
      }
      const timestamp = resolveNow(now).toISOString();
      const updated = updateManagerBatchDelivery({
        ...batch,
        updatedAt: timestamp,
      }, input.actorOpenId, { selectedRejectRecordId: executionRecordId });
      replaceManagerApprovalBatch(ledger, updated);
      await this.write(ledger);
      return { opened: true, batch: managerBatchCardView(updated, input.actorOpenId) };
    });
  }

  async cancelManagerApprovalBatchRejectEditor(
    inputValue: PurchaseManagerApprovalBatchCardIdentity,
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<{
    cancelled: boolean;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchCardIdentity(inputValue);
    return this.enqueueCard(async () => {
      const ledger = await this.read();
      const batch = requireActiveManagerApprovalBatch(ledger, input);
      if (batch.flowVersion === 'lifecycle_v1' || batch.stageCardTransition) {
        if (!authorize) throw new ForbiddenException('采购全流程卡片缺少当前职责校验');
        assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch)));
      }
      if (batch.state !== 'reject_editing') {
        return { cancelled: false, batch };
      }
      const updated = updateManagerBatchDelivery({
        ...batch,
        state: 'active',
        updatedAt: resolveNow(now).toISOString(),
      }, input.actorOpenId, { selectedRejectRecordId: '' });
      replaceManagerApprovalBatch(ledger, updated);
      await this.write(ledger);
      return { cancelled: true, batch: managerBatchCardView(updated, input.actorOpenId) };
    });
  }

  async claimManagerApprovalBatchPendingApproval(
    inputValue: PurchaseManagerApprovalBatchPendingClaimInput,
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<{
    claimed: boolean;
    entry: PurchaseManagerApprovalBatchActionEntry | null;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchPendingClaim(inputValue);
    return this.claimManagerApprovalBatchAction(input, now, authorize);
  }

  /** Website source for a historical single card or a truly cardless record.
   * Kept isolated until a matching durable worker and card refresh are wired. */
  async claimPlatformLegacyApproval(input: {
    record: Pick<PurchaseWorkflowRecord, 'recordId'|'status'|'approvalCompleted'|'building'|'specialty'|'purchaseMethod'|'requesterOpenId'|'approvalBatchId'|'approvalActionId'>;
    requestId: string; decision: 'approved'|'rejected'; purchaseMethod?: PurchaseWorkflowMethod; identity: PurchasePlatformIdentityProof; appId: string; sourceFingerprint: string;
  }, authorize: (identity: PurchasePlatformIdentityProof, record: typeof input.record, mode: 'new'|'replay', appId:string, sourceFingerprint:string) => true): Promise<{kind:'claim'|'replay'; entry:PlatformLegacyApprovalEntry}> {
    if (!input || !/^cli_[A-Za-z0-9_-]+$/.test(input.appId) || !/^[a-f0-9]{64}$/.test(input.sourceFingerprint) || !/^[A-Za-z0-9_-]{16,64}$/.test(input.requestId) || !['approved','rejected'].includes(input.decision) ||
      (input.purchaseMethod !== undefined && (input.decision !== 'approved' || !isSelectablePlatformLegacyPurchaseMethod(input.purchaseMethod))) || typeof authorize !== 'function') throw new BadRequestException('平台采购审批请求无效');
    const record = structuredClone(input.record), identity = sanitizePlatformCommandIdentity(input.identity), target = purchaseAuthorityTarget(record);
    if (!record || !/^rec[A-Za-z0-9_-]+$/.test(record.recordId) || !target || (record.approvalBatchId && !BATCH_ID_PATTERN.test(record.approvalBatchId)) || typeof record.requesterOpenId !== 'string' || (record.requesterOpenId !== '' && !OPEN_ID_PATTERN.test(record.requesterOpenId))) throw new ConflictException('采购原记录不明确');
    const eventId = `platform_${input.requestId}`, selected = input.purchaseMethod;
    if (selected !== undefined && (input.decision !== 'approved' || !isSelectablePlatformLegacyPurchaseMethod(selected))) throw new BadRequestException('采购方式选择与审批决定冲突');
    // The fingerprint binds both the original snapshot and the explicit choice, so a
    // replayed request that changes the method is refused instead of silently kept.
    const fingerprint = createHash('sha256').update(JSON.stringify(selected === undefined
      ? ['platform-legacy-approval-v1',input.appId,input.sourceFingerprint,record.recordId,record.approvalBatchId || '',input.decision,record.purchaseMethod,record.requesterOpenId,target,identity]
      : ['platform-legacy-approval-v2',input.appId,input.sourceFingerprint,record.recordId,record.approvalBatchId || '',input.decision,record.purchaseMethod,record.requesterOpenId,target,identity,selected])).digest('hex');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const existing = (ledger.platformLegacyApprovalClaims || []).find(row => row.eventId === eventId);
      const allowed: unknown = authorize(input.identity, record, existing ? 'replay' : 'new', input.appId, input.sourceFingerprint);
      if (allowed !== true) { if (allowed instanceof Promise) void allowed.catch(() => undefined); throw new ForbiddenException('采购审批身份或权限不可用'); }
      if (existing) {
        // A new login or the result of this very command changes the session and
        // source snapshot. Replays compare the durable owner and intent, while
        // the current signed session above must still pass authorization.
        if (existing.recordId !== record.recordId || existing.appId !== input.appId || existing.sourceFingerprint !== input.sourceFingerprint ||
            existing.decision !== input.decision || existing.purchaseMethod !== selected ||
            existing.identity.source !== identity.source || existing.identity.actorAccountId !== identity.actorAccountId || existing.identity.subjectAccountId !== identity.subjectAccountId ||
            existing.originalBatchId !== (record.approvalBatchId || '') || existing.originalRequesterOpenId !== record.requesterOpenId ||
            JSON.stringify(existing.authorityTarget) !== JSON.stringify(target)) throw new ConflictException('采购审批请求编号已用于其他操作');
        return {kind:'replay' as const, entry:structuredClone(existing)};
      }
      const owners=ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(record.recordId));
      if (record.approvalBatchId ? owners.length !== 1 || owners[0]!.approvalBatchId !== record.approvalBatchId || owners[0]!.state !== 'active' || !owners[0]!.items.some(item => item.executionRecordId === record.recordId && item.status === 'pending') : owners.length !== 0) throw new ConflictException('采购审批批次归属或状态无法核对');
      if (owners[0]?.flowVersion === 'lifecycle_v1') throw new ConflictException('采购全流程卡统一处理尚未就绪');
      if ((ledger.platformApprovalClaims || []).some(row => row.eventId === eventId || row.recordIds.includes(record.recordId)) || (ledger.platformLegacyApprovalClaims || []).some(row => row.recordId === record.recordId) || ledger.managerApprovalActions.some(action => action.recordId === record.recordId && action.status !== 'failed') || ledger.managerApprovalBatchActions.some(action => action.recordIds.includes(record.recordId) && action.status !== 'failed')) throw new ConflictException('采购明细已有审批任务');
      if (record.status !== '未开始（待审批）' || record.approvalCompleted || record.approvalActionId ||
        (input.decision === 'approved' && !isSelectablePlatformLegacyPurchaseMethod(record.purchaseMethod) && record.purchaseMethod !== '') ||
        (selected !== undefined && selected !== record.purchaseMethod && !isSelectablePlatformLegacyPurchaseMethod(record.purchaseMethod))) throw new ConflictException('采购记录当前不能审批');
      if ((raw.managerApprovalCards !== undefined && (!Array.isArray(raw.managerApprovalCards) || raw.managerApprovalCards.some(row => !sanitizeManagerApprovalCard(row)))) || (raw.managerApprovalActions !== undefined && (!Array.isArray(raw.managerApprovalActions) || raw.managerApprovalActions.some(row => !sanitizeManagerApprovalAction(row)))) || (raw.managerApprovalBatches !== undefined && (!Array.isArray(raw.managerApprovalBatches) || raw.managerApprovalBatches.some(row => !sanitizeVersionedManagerApprovalBatch(row))))) throw new ConflictException('采购审批账本损坏');
      const cards = ledger.managerApprovalCards.filter(card => card.executionRecordId === record.recordId);
      if (cards.some(card => card.personnelHandover || !['initial','reject_editing'].includes(card.state)) || ledger.notifications.some(task => task.recordId === record.recordId && task.kind === 'manager_approval_requested' && task.status !== 'completed' && task.status !== 'failed')) throw new ConflictException('采购旧卡状态未确认');
      const entries = ledger.platformLegacyApprovalClaims || [];
      if (entries.length >= MAX_MANAGER_APPROVAL_ACTIONS) throw new ServiceUnavailableException('平台采购审批动作队列已满');
      if (record.approvalBatchId && cards.length) throw new ConflictException('采购明细同时存在旧单卡和批次卡');
      const entry:PlatformLegacyApprovalEntry = { eventId, serverActionId:`pa_${randomBytes(32).toString('base64url')}`, fingerprint, acceptedAtMs:Date.now(), appId:input.appId, sourceFingerprint:input.sourceFingerprint, recordId:record.recordId, originalBatchId:record.approvalBatchId || '', decision:input.decision, originalPurchaseMethod:record.purchaseMethod, ...(selected === undefined ? {} : {purchaseMethod:selected}), originalRequesterOpenId:record.requesterOpenId, authorityTarget:target, identity, cards:cards.map(card => ({key:card.key,messageId:card.messageId,recipientOpenId:card.recipientOpenId})), phase:'queued' };
      if (entries.some(row => row.serverActionId === entry.serverActionId) || (ledger.platformApprovalClaims || []).some(row => row.serverActionId === entry.serverActionId)) throw new ConflictException('采购审批动作标识冲突');
      if (raw.platformLegacyApprovalClaims !== undefined && !Array.isArray(raw.platformLegacyApprovalClaims)) throw new ConflictException('平台旧采购审批账本损坏');
      raw.platformLegacyApprovalClaims = [...((raw.platformLegacyApprovalClaims || []) as unknown[]), entry];
      await this.writeLifecycleRaw(raw, original);
      return {kind:'claim' as const,entry:structuredClone(entry)};
    });
  }

  /** Internal read-only port. appId must be taken from trusted current server
   * configuration; authorize must reverify the signed session, both live
   * identities, matching application, and approve permission for target. */
  async getPlatformLegacyApprovalStatus(input:{eventId:string;appId:string;identity:PurchasePlatformIdentityProof}, authorize:(identity:PurchasePlatformIdentityProof,target:PurchaseAuthorityTarget,appId:string)=>true):Promise<PlatformLegacyApprovalStatus> {
    if (!input || !/^platform_[A-Za-z0-9_-]{16,64}$/.test(input.eventId) || !/^cli_[A-Za-z0-9_-]+$/.test(input.appId) || typeof authorize !== 'function') throw new ForbiddenException('审批后台任务不存在或无权访问');
    const identity=sanitizePlatformCommandIdentity(input.identity);
    return this.enqueueCardRead(async () => {
      const ledger=await this.read(), entry=(ledger.platformLegacyApprovalClaims || []).find(row => row.eventId === input.eventId);
      if (!entry || entry.appId !== input.appId || entry.identity.source !== identity.source || entry.identity.actorAccountId !== identity.actorAccountId || entry.identity.subjectAccountId !== identity.subjectAccountId) throw new ForbiddenException('审批后台任务不存在或无权访问');
      const allowed:unknown=authorize(input.identity,structuredClone(entry.authorityTarget),input.appId);
      if (allowed !== true) { if (allowed instanceof Promise) void allowed.catch(() => undefined); throw new ForbiddenException('审批后台任务不存在或无权访问'); }
      const status:PlatformLegacyApprovalStatus['status']=entry.phase === 'completed' ? 'completed' : entry.phase === 'manual' ? 'manual_reconciliation' : entry.phase === 'queued' ? 'pending' : 'running';
      return {recordId:entry.recordId,decision:entry.decision,status,acceptedAtMs:entry.acceptedAtMs,...(entry.completedAtMs ? {completedAtMs:entry.completedAtMs} : {})};
    });
  }

  /** All methods below are isolated worker primitives; no production worker is registered. */
  async listRecoverablePlatformLegacyApprovals(afterEventId = '', limit = 20): Promise<string[]> {
    if ((afterEventId && !/^platform_[A-Za-z0-9_-]{16,64}$/.test(afterEventId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('采购审批恢复扫描参数无效');
    return this.enqueueCardRead(async () => {
      const {ledger} = await this.readLifecycleConsistent();
      const now = Date.now();
      return (ledger.platformLegacyApprovalClaims || [])
        .filter(entry => entry.phase !== 'completed' && entry.eventId > afterEventId &&
          (!entry.leaseToken || now >= (entry.leaseStartedAtMs || 0) && now >= (entry.leaseUntilMs || 0)))
        .map(entry => entry.eventId).sort().slice(0, limit);
    });
  }

  async leasePlatformLegacyApproval(eventId: string): Promise<{entry:PlatformLegacyApprovalEntry; token:string; kind:'dispatch'|'reconcile'|'complete'|'done'}|null> {
    return this.enqueueCard(async () => {
      const {ledger,raw,original} = await this.readLifecycleConsistent();
      const entry = (ledger.platformLegacyApprovalClaims || []).find(row => row.eventId === eventId);
      if (!entry) throw new ConflictException('平台旧采购审批不存在');
      if (entry.phase === 'completed') return {entry:structuredClone(entry),token:'',kind:'done'};
      const now = Date.now();
      if (entry.leaseToken && (now < (entry.leaseStartedAtMs || 0) || now < (entry.leaseUntilMs || 0))) return null;
      const kind = entry.phase === 'confirmed' ? 'complete' : entry.phase === 'dispatching' || entry.phase === 'manual' ? 'reconcile' : 'dispatch';
      const token = randomUUID(), next = {...entry, phase:kind === 'dispatch' ? 'leased' as const : entry.phase, leaseToken:token, leaseStartedAtMs:now, leaseUntilMs:now+DEFAULT_LEASE_MS};
      replacePlatformLegacyClaim(raw,next); await this.writeLifecycleRaw(raw,original);
      return {entry:structuredClone(next),token,kind};
    });
  }

  async beginPlatformLegacyApprovalDispatch(eventId:string, token:string, record:PurchaseWorkflowRecord, markerFieldVerified:boolean):Promise<Record<string,string>> {
    return this.enqueueCard(async () => {
      const {ledger,raw,original} = await this.readLifecycleConsistent(), entry = requirePlatformLegacyLease(ledger,eventId,token);
      if (entry.phase !== 'leased' || entry.dispatchStartedAtMs) throw new ConflictException('采购审批发送围栏已存在');
      const patch = buildPlatformLegacyApprovalPatch(platformLegacyPolicyClaim(entry),record,markerFieldVerified);
      const next:PlatformLegacyApprovalEntry = {...entry,phase:'dispatching',dispatchStartedAtMs:Date.now(),patchHash:createHash('sha256').update(JSON.stringify(patch)).digest('hex')};
      replacePlatformLegacyClaim(raw,next); await this.writeLifecycleRaw(raw,original); return patch;
    });
  }

  async confirmPlatformLegacyApproval(eventId:string,token:string,record:PurchaseWorkflowRecord,markerPresent:boolean):Promise<void> {
    return this.enqueueCard(async () => {
      const {ledger,raw,original} = await this.readLifecycleConsistent(), entry = requirePlatformLegacyLease(ledger,eventId,token);
      if (!['dispatching','manual'].includes(entry.phase) || !entry.dispatchStartedAtMs || !confirmPlatformLegacyApprovalResult(platformLegacyPolicyClaim(entry),record,markerPresent)) throw new ConflictException('采购审批远端回执未能核对');
      const resultHash = createHash('sha256').update(JSON.stringify([record.recordId,record.status,record.purchaseMethod,record.approvalActionId])).digest('hex');
      replacePlatformLegacyClaim(raw,{...entry,phase:'confirmed',resultHash}); await this.writeLifecycleRaw(raw,original);
    });
  }

  async markPlatformLegacyApprovalManual(eventId:string,token:string):Promise<void> {
    return this.enqueueCard(async () => {
      const {ledger,raw,original}=await this.readLifecycleConsistent(), entry=requirePlatformLegacyLease(ledger,eventId,token);
      if (!['dispatching','manual'].includes(entry.phase) || !entry.dispatchStartedAtMs) throw new ConflictException('采购审批尚未进入待核对状态');
      replacePlatformLegacyClaim(raw,{...entry,phase:'manual',leaseToken:'',leaseStartedAtMs:0,leaseUntilMs:0});
      await this.writeLifecycleRaw(raw,original);
    });
  }

  async completePlatformLegacyApproval(eventId:string,token:string):Promise<void> {
    return this.enqueueCard(async () => {
      const {ledger,raw,original} = await this.readLifecycleConsistent(), entry = requirePlatformLegacyLease(ledger,eventId,token);
      if (entry.phase !== 'confirmed' || !entry.resultHash) throw new ConflictException('采购审批回执尚未确认');
      const timestamp = new Date().toISOString(), choice = platformLegacyCardChoice(entry);
      if (!Array.isArray(raw.managerApprovalCards) || !Array.isArray(raw.notifications)) throw new ConflictException('采购原卡或通知账本损坏');
      if (entry.originalBatchId) {
        const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === entry.originalBatchId && batch.recordIds.includes(entry.recordId));
        const batch = batches[0], items = batch?.items.filter(item => item.executionRecordId === entry.recordId);
        if (batches.length !== 1 || !batch || items?.length !== 1 || items[0]!.status !== 'pending') throw new ConflictException('采购原批次明细已变化');
        const oldKeys = new Set(ledger.notifications.map(row => row.key));
        const updatedItems = batch.items.map(item => item.executionRecordId !== entry.recordId ? item : { ...item, status: entry.decision === 'rejected' ? 'rejected' as const : 'approved' as const, choice, rejectionReason: '', actionEventId: entry.eventId, actorOpenId: entry.identity.actorFeishuOpenId || '', processedAt: timestamp, ...(entry.decision === 'rejected' ? { decisionSource: 'platform' as const } : {}) });
        const state = updatedItems.some(item => item.status === 'manual_reconciliation') ? 'manual_reconciliation' as const : updatedItems.some(item => item.status === 'processing') ? 'processing' as const : updatedItems.some(item => item.status === 'pending') ? 'active' as const : 'resolved' as const;
        const updated = withManagerApprovalBatchContext({ ...batch, items: updatedItems, state, revision: batch.revision + 1, actorOpenId: entry.identity.actorFeishuOpenId || '', processedAt: timestamp, updatedAt: timestamp, resolvedAt: state === 'resolved' || state === 'manual_reconciliation' ? timestamp : '' });
        replaceManagerApprovalBatch(ledger, updated);
        enqueueManagerApprovalBatchStateNotifications(ledger, updated, 'manager_batch_approval_refresh', timestamp);
        queueExistingLifecycleBatchRefresh(ledger, updated);
        mergeRawPlatformApprovalCompletion(raw, ledger, updated, entry.recordId, oldKeys);
        replacePlatformLegacyClaim(raw,{...entry,phase:'completed',leaseToken:'',leaseStartedAtMs:0,leaseUntilMs:0,completedAtMs:Date.now()});
        await this.writeLifecycleRaw(raw,original);
        return;
      }
      if (ledger.notifications.filter(row => isActiveStatus(row.status)).length + entry.cards.length > MAX_NOTIFICATIONS) throw new ServiceUnavailableException('采购通知任务队列已满');
      for (const binding of entry.cards) {
        const cards = (raw.managerApprovalCards as unknown[]).filter(row => isRecord(row) && row.key === binding.key);
        if (cards.length !== 1 || !isRecord(cards[0])) throw new ConflictException('采购原卡绑定无法核对');
        const card = sanitizeManagerApprovalCard(cards[0]);
        if (!card || card.executionRecordId !== entry.recordId || card.messageId !== binding.messageId || card.recipientOpenId !== binding.recipientOpenId || card.personnelHandover || !['initial','reject_editing'].includes(card.state)) throw new ConflictException('采购原卡已变化');
        Object.assign(cards[0], {state:'resolved',choice,rejectionReasonDraft:'',actionEventId:entry.eventId,actorOpenId:'',processedAt:timestamp,updatedAt:timestamp,resolvedAt:timestamp});
        const input:PurchaseWorkflowNotificationInput = {businessEventId:`manager_approval_resolved:${entry.eventId}`,recordId:entry.recordId,recipientOpenId:binding.recipientOpenId,kind:'manager_approval_resolved',cardContext:card.cardContext};
        const key = notificationKey(input);
        if ((raw.notifications as unknown[]).some(row => isRecord(row) && row.key === key)) throw new ConflictException('采购原卡更新通知重复');
        const notification = createNotificationEntry(input,timestamp);
        notification.messageId = binding.messageId;
        (raw.notifications as unknown[]).push(notification);
      }
      replacePlatformLegacyClaim(raw,{...entry,phase:'completed',leaseToken:'',leaseStartedAtMs:0,leaseUntilMs:0,completedAtMs:Date.now()});
      await this.writeLifecycleRaw(raw,original);
    });
  }

  async getVerifiedPlatformLegacyCardResolution(notificationKeyValue:string,claimToken:string):Promise<VerifiedPlatformLegacyCardResolution> {
    return this.enqueueCardRead(async () => {
      const ledger = await this.read();
      const task = ledger.notifications.find(row => row.key === notificationKeyValue);
      if (!task || task.kind !== 'manager_approval_resolved') throw new ConflictException('采购原卡通知不存在');
      assertClaimOwnership(task,claimToken);
      if (!task.leaseUntil || Date.parse(task.leaseUntil) <= Date.now()) throw new ConflictException('采购原卡通知租约已失效');
      const entry = (ledger.platformLegacyApprovalClaims || []).find(row => task.businessEventId === `manager_approval_resolved:${row.eventId}` && row.recordId === task.recordId && row.phase === 'completed');
      const binding = entry?.cards.find(row => row.messageId === task.messageId && row.recipientOpenId === task.recipientOpenId);
      const card = binding && ledger.managerApprovalCards.find(row => row.key === binding.key && row.state === 'resolved' && row.actionEventId === entry!.eventId && row.messageId === binding.messageId && row.recipientOpenId === binding.recipientOpenId);
      if (!entry || !binding || !card || !entry.completedAtMs) throw new ConflictException('采购原卡审批回执不可核对');
      return {recordId:entry.recordId,eventId:entry.eventId,serverActionId:entry.serverActionId,messageId:binding.messageId,recipientOpenId:binding.recipientOpenId,decision:entry.decision,choice:platformLegacyCardChoice(entry),...(entry.decision === 'approved' ? {purchaseMethod:platformLegacyCardMethod(entry)} : {}),actorDisplayName:entry.identity.actorDisplayName,subjectDisplayName:entry.identity.subjectDisplayName,processedAt:new Date(entry.completedAtMs).toISOString()};
    });
  }

  /**
   * Isolated platform single-item claim. No controller or production worker is
   * wired to it yet. The caller must supply a verified in-process session proof;
   * authorization is repeated synchronously while holding the same lock as cards.
   * Record readback and all Feishu I/O must happen outside this lock.
   */
  async claimPlatformApprovalItem(input: {
    approvalBatchId: string;
    record: Pick<PurchaseWorkflowRecord, 'recordId' | 'status' | 'building' | 'specialty'>;
    request: PlatformApprovalRequest;
    identity: PurchasePlatformIdentityProof;
    lifecycleReady: boolean;
    lifecycleSource?: {appId:string;sourceFingerprint:string};
  }, authorize: (identity: PurchasePlatformIdentityProof, record: Pick<PurchaseWorkflowRecord, 'recordId' | 'status' | 'building' | 'specialty'>, mode: 'new' | 'replay') => true, now: Date | number = new Date()): Promise<PlatformApprovalPlan> {
    const batchId = normalizeManagerApprovalBatchId(input?.approvalBatchId);
    const record = structuredClone(input.record), request = structuredClone(input.request), identity = input.identity;
    const timestamp = resolveNow(now).toISOString();
    if (typeof authorize !== 'function') throw new ForbiddenException('采购审批缺少当前身份校验');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      if (!Array.isArray(raw.managerApprovalBatches)) throw new ConflictException('采购批次账本损坏');
      const sourceBatches = raw.managerApprovalBatches.filter(row => isRecord(row) && row.approvalBatchId === batchId);
      if ((ledger.platformLegacyApprovalClaims || []).some(claim => claim.recordId === record.recordId || claim.eventId === `platform_${request.requestId}`)) throw new ConflictException('采购明细已有平台审批任务');
      const candidates = ledger.managerApprovalBatches.filter(row => row.approvalBatchId === batchId);
      if (sourceBatches.length !== 1 || candidates.length !== 1 || !isRecord(sourceBatches[0])) throw new ConflictException('采购批次无法唯一核对');
      if(input.lifecycleSource&&(candidates[0]!.flowVersion!=='lifecycle_v1'||candidates[0]!.lifecycleAppId!==input.lifecycleSource.appId||input.lifecycleSource.appId!==readEnv('FEISHU_APP_ID')||ledger.lifecycleReceiptImageSource?.appId!==input.lifecycleSource.appId||ledger.lifecycleReceiptImageSource?.sourceFingerprint!==input.lifecycleSource.sourceFingerprint))throw new ConflictException('采购审批持久来源已变化');
      const rawRecordOwners = raw.managerApprovalBatches.filter(row => isRecord(row) && Array.isArray(row.recordIds) && row.recordIds.includes(record.recordId));
      if (rawRecordOwners.length !== 1 || rawRecordOwners[0] !== sourceBatches[0]) throw new ConflictException('采购明细批次归属不唯一');
      if ((raw.managerApprovalCards !== undefined && (!Array.isArray(raw.managerApprovalCards) || raw.managerApprovalCards.some(row => !sanitizeManagerApprovalCard(row)))) || (raw.managerApprovalActions !== undefined && (!Array.isArray(raw.managerApprovalActions) || raw.managerApprovalActions.some(row => !sanitizeManagerApprovalAction(row))))) throw new ConflictException('旧采购审批账本损坏');
      if (ledger.managerApprovalCards.some(card => card.executionRecordId === record.recordId) || ledger.managerApprovalActions.some(action => action.recordId === record.recordId && action.status !== 'failed')) throw new ConflictException('采购明细存在旧审批卡或动作，请先核对');
      // Do not let a damaged, silently discarded card action bypass the common claim.
      if (raw.managerApprovalBatchActions !== undefined && (!Array.isArray(raw.managerApprovalBatchActions) || raw.managerApprovalBatchActions.some(row => !sanitizeManagerApprovalBatchAction(row)))) throw new ConflictException('采购审批动作账本损坏');
      const claims = ledger.platformApprovalClaims || [];
      const actions = [...ledger.managerApprovalBatchActions.map(row => ({ eventId: row.eventId, approvalBatchId: row.approvalBatchId, status: row.status, source: 'card' as const, recordIds: row.recordIds })),
        ...claims.map(row => ({ ...row, status: (ledger.platformApprovalWork || []).find(work => work.eventId === row.eventId)?.phase === 'completed' ? 'completed' : row.status }))];
      const plan = planPlatformApproval({ batch: candidates[0]!, actions, record, request, identity, lifecycleReady: input.lifecycleReady }, authorize);
      if (plan.kind === 'replay') return plan;
      if (claims.length >= MAX_MANAGER_APPROVAL_BATCH_ACTIONS) throw new ServiceUnavailableException('平台采购审批动作队列已满');
      const source = sourceBatches[0];
      if (!Array.isArray(source.items)) throw new ConflictException('采购批次明细损坏');
      const sourceItems = source.items.filter(row => isRecord(row) && row.executionRecordId === plan.recordId);
      if (sourceItems.length !== 1 || !isRecord(sourceItems[0])) throw new ConflictException('采购批次明细无法唯一核对');
      Object.assign(sourceItems[0], { status: 'processing', choice: plan.action.choice, rejectionReason: plan.action.rejectionReason,
        actionEventId: plan.action.eventId, actorOpenId: '', processedAt: '', lastError: '',
        ...(plan.action.choice === 'reject' && !plan.action.rejectionReason ? {decisionSource:'platform'} : {}) });
      Object.assign(source, { state: 'processing', selectedRejectRecordId: '', revision: plan.expectedRevision + 1, actorOpenId: '', updatedAt: timestamp });
      if (raw.platformApprovalClaims !== undefined && !Array.isArray(raw.platformApprovalClaims)) throw new ConflictException('平台采购审批账本损坏');
      const rawClaims = (raw.platformApprovalClaims || []) as unknown[];
      const persisted: PlatformApprovalPersistedAction = { ...plan.action, serverActionId: `pa_${randomBytes(32).toString('base64url')}`, acceptedAtMs: Date.now() };
      if (claims.some(claim => claim.serverActionId === persisted.serverActionId)) throw new ConflictException('平台采购审批标识冲突');
      rawClaims.push(persisted); raw.platformApprovalClaims = rawClaims;
      replaceRawPlatformApprovalWork(raw, { eventId: persisted.eventId, phase: 'queued', leaseToken: '', leaseStartedAtMs: 0, leaseUntilMs: 0 });
      if (candidates[0]!.flowVersion === 'lifecycle_v1') {
        const next = sanitizeVersionedManagerApprovalBatch(source);
        if (!next) throw new ConflictException('采购审批批次无法核对');
        queueExistingLifecycleBatchRefresh(ledger,next);
        raw.lifecycleOutbox = ledger.lifecycleOutbox;
      }
      await this.writeLifecycleRaw(raw, original);
      return { ...plan, action: persisted };
    });
  }

  /** Read-only lifecycle web-task projection; private identity and source never leave this boundary. */
  async getLifecyclePlatformApprovalStatus(eventId:string,appId:string,identity:PurchasePlatformIdentityProof,
    authorize:(target:PurchaseAuthorityTarget)=>void):Promise<{recordId:string;decision:'approved'|'rejected';status:'pending'|'running'|'completed'|'manual_reconciliation';acceptedAtMs:number}|null> {
    if(!/^platform_[A-Za-z0-9_-]{16,64}$/.test(eventId)||appId!==readEnv('FEISHU_APP_ID')||!identity||typeof authorize!=='function')throw new ForbiddenException('采购审批任务身份不可用');
    return this.enqueueCardRead(async()=>{
      const ledger=await this.read(),claim=(ledger.platformApprovalClaims||[]).find(row=>row.eventId===eventId);
      if(!claim)return null;
      const batch=ledger.managerApprovalBatches.find(row=>row.approvalBatchId===claim.approvalBatchId);
      if(batch?.flowVersion!=='lifecycle_v1'||batch.lifecycleAppId!==appId||claim.actorAccountId!==identity.actorAccountId||claim.subjectAccountId!==identity.subjectAccountId||claim.identitySource!==identity.source)throw new ForbiddenException('采购审批任务不存在或无权访问');
      const target=normalizePurchaseAuthorityTarget(claim.authorityTarget);
      if(!target)throw new ConflictException('采购审批任务授权范围不可核对');
      assertSynchronousLifecycleAuthorization(()=>authorize(target));
      const work=(ledger.platformApprovalWork||[]).find(row=>row.eventId===eventId);
      if(!work)throw new ConflictException('采购审批任务状态不可核对');
      return {recordId:claim.recordIds[0]!,decision:claim.choice==='reject'?'rejected':'approved',status:work.phase==='completed'?'completed':work.phase==='manual'?'manual_reconciliation':work.phase==='queued'?'pending':'running',acceptedAtMs:claim.acceptedAtMs};
    });
  }

  async listRecoverableLifecyclePlatformApprovals(afterEventId='',limit=20):Promise<string[]> {
    if((afterEventId&&!/^platform_[A-Za-z0-9_-]{16,64}$/.test(afterEventId))||!Number.isSafeInteger(limit)||limit<1||limit>20)throw new BadRequestException('采购审批恢复范围无效');
    return this.enqueueCardRead(async()=>{
      const ledger=await this.read(),appId=readEnv('FEISHU_APP_ID'),now=Date.now();
      return (ledger.platformApprovalWork||[]).filter(work=>work.eventId>afterEventId&&work.phase!=='completed'&&!(work.phase==='manual'&&!work.dispatchStartedAtMs)&&(!work.leaseToken||work.leaseUntilMs<=now)).filter(work=>{
        const claim=(ledger.platformApprovalClaims||[]).find(row=>row.eventId===work.eventId);
        const batch=ledger.managerApprovalBatches.find(row=>row.approvalBatchId===claim?.approvalBatchId);
        return batch?.flowVersion==='lifecycle_v1'&&batch.lifecycleAppId===appId;
      }).map(work=>work.eventId).sort().slice(0,limit);
    });
  }

  /** Isolated adapter. Its existence does not register a worker or enable routing. */
  platformApprovalWorkerPort(): PlatformApprovalWorkerStore {
    return {
      claimPending: eventId => this.claimPlatformApprovalWork(eventId),
      beginDispatch: (job, purchaser, patchHash) => this.beginPlatformApprovalDispatch(job, purchaser, patchHash),
      deferBeforeDispatch: (job, reason) => this.updatePlatformApprovalWork(job, 'defer', reason),
      markUnknown: (job, reason) => this.updatePlatformApprovalWork(job, 'unknown', reason),
      recordConfirmed: (job, evidence) => this.confirmPlatformApprovalWork(job, evidence),
      completeAndRefresh: job => this.completePlatformApprovalWork(job),
    };
  }

  private async claimPlatformApprovalWork(eventId: string): Promise<PlatformApprovalWorkerJob | null> {
    if (!/^platform_[A-Za-z0-9_-]{16,64}$/.test(eventId)) throw new BadRequestException('平台采购审批任务无效');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const claim = (ledger.platformApprovalClaims || []).find(row => row.eventId === eventId);
      if (!claim) throw new ConflictException('平台采购审批认领不存在');
      const batch = ledger.managerApprovalBatches.find(row => row.approvalBatchId === claim.approvalBatchId)!;
      const item = batch.items.find(row => row.executionRecordId === claim.recordIds[0])!;
      const now = Date.now();
      if (!Number.isSafeInteger(now) || now < 1) throw new ConflictException('平台采购审批时钟无效');
      const current = (ledger.platformApprovalWork || []).find(row => row.eventId === eventId);
      if (!current) throw new ConflictException('平台采购审批工作记录缺失');
      if (current?.phase === 'completed') return platformApprovalWorkerJob(claim, batch, item, { ...current, leaseToken: 'completed' }, 'done');
      if (current && current.leaseToken && (now < current.leaseStartedAtMs || now < current.leaseUntilMs)) return null;
      if (current?.phase === 'manual' && !current.dispatchStartedAtMs) return null;
      const kind: PlatformApprovalWorkerJob['kind'] = current?.phase === 'confirmed' ? 'complete' : current && ['dispatching', 'manual'].includes(current.phase) ? 'reconcile' : 'dispatch';
      const next: PlatformApprovalWork = { ...(current || { eventId, phase: 'queued', leaseToken: '', leaseStartedAtMs: 0, leaseUntilMs: 0 }),
        phase: kind === 'dispatch' ? 'leased' : current!.phase, leaseToken: randomUUID(), leaseStartedAtMs: now, leaseUntilMs: now + DEFAULT_LEASE_MS };
      if (!Number.isSafeInteger(next.leaseUntilMs)) throw new ConflictException('平台采购审批租约无效');
      replaceRawPlatformApprovalWork(raw, next); await this.writeLifecycleRaw(raw, original);
      return platformApprovalWorkerJob(claim, batch, item, next, kind);
    });
  }

  private async beginPlatformApprovalDispatch(job: PlatformApprovalWorkerJob, purchaser: { openId: string; name: string } | undefined, patchHash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(patchHash)) throw new BadRequestException('采购审批写入摘要无效');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const { claim, work } = requirePlatformApprovalWorkerLease(ledger, job);
      if (work.phase !== 'leased' || job.kind !== 'dispatch') return false;
      if (claim.choice === 'reject' ? purchaser !== undefined : !validPlatformApprovalPurchaser(purchaser)) throw new ConflictException('采购审批采购人快照无效');
      const next: PlatformApprovalWork = { ...work, phase: 'dispatching', dispatchStartedAtMs: Date.now(), patchHash, ...(purchaser ? { purchaser: structuredClone(purchaser) } : {}) };
      delete next.reason; replaceRawPlatformApprovalWork(raw, next); await this.writeLifecycleRaw(raw, original); return true;
    });
  }

  private async updatePlatformApprovalWork(job: PlatformApprovalWorkerJob, outcome: 'defer' | 'unknown', reason: string): Promise<void> {
    if (!/^[a-z_]{1,80}$/.test(reason)) throw new BadRequestException('平台采购审批原因无效');
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const { work } = requirePlatformApprovalWorkerLease(ledger, job);
      if (outcome === 'defer' && (work.phase !== 'leased' || work.dispatchStartedAtMs)) throw new ConflictException('已发送的采购审批不可重试');
      if (outcome === 'unknown' && !['leased', 'dispatching', 'manual'].includes(work.phase)) throw new ConflictException('平台采购审批状态不可更改');
      const next: PlatformApprovalWork = { ...work, phase: outcome === 'defer' ? 'queued' : 'manual', leaseToken: '', leaseStartedAtMs: 0, leaseUntilMs: 0, reason };
      replaceRawPlatformApprovalWork(raw, next); await this.writeLifecycleRaw(raw, original);
    });
  }

  private async confirmPlatformApprovalWork(job: PlatformApprovalWorkerJob, evidence: { actionId: string; resultHash: string; purchaser?: { openId: string; name: string } }): Promise<void> {
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const { claim, work } = requirePlatformApprovalWorkerLease(ledger, job);
      if (!['dispatching', 'manual'].includes(work.phase) || !work.dispatchStartedAtMs || !work.patchHash || evidence?.actionId !== claim.serverActionId || !/^[a-f0-9]{64}$/.test(evidence.resultHash) || JSON.stringify(evidence.purchaser || null) !== JSON.stringify(work.purchaser || null)) throw new ConflictException('平台采购审批回执无法核对');
      const next: PlatformApprovalWork = { ...work, phase: 'confirmed', resultHash: evidence.resultHash };
      delete next.reason; replaceRawPlatformApprovalWork(raw, next); await this.writeLifecycleRaw(raw, original);
    });
  }

  private async completePlatformApprovalWork(job: PlatformApprovalWorkerJob): Promise<void> {
    return this.enqueueCard(async () => {
      const { ledger, raw, original } = await this.readLifecycleConsistent();
      const { claim, work, batch } = requirePlatformApprovalWorkerLease(ledger, job, true);
      if (work.phase === 'completed') return;
      if (work.phase !== 'confirmed' || !work.resultHash) throw new ConflictException('平台采购审批结果尚未核实');
      const timestamp = new Date().toISOString(), itemId = claim.recordIds[0]!;
      const nextBatch: PurchaseManagerApprovalBatchEntry = { ...batch, items: batch.items.map(item => item.executionRecordId !== itemId ? item : {
        ...item, status: claim.choice === 'reject' ? 'rejected' : 'approved', processedAt: timestamp, lastError: '', actorOpenId: claim.actorFeishuOpenId || '',
        purchaserOpenId: claim.choice === 'reject' ? '' : work.purchaser!.openId, purchaserName: claim.choice === 'reject' ? '' : work.purchaser!.name,
        ...(claim.choice === 'reject' ? {} : { authorityTarget: normalizePurchaseAuthorityTarget(claim.authorityTarget) }),
      }), updatedAt: timestamp };
      const notificationKeys = new Set(ledger.notifications.map(row => row.key));
      const finalized = finalizeManagerApprovalBatchAction(ledger, nextBatch, { actorOpenId: claim.actorFeishuOpenId || '' }, timestamp);
      replaceManagerApprovalBatch(ledger, finalized); queueExistingLifecycleBatchRefresh(ledger, finalized);
      mergeRawPlatformApprovalCompletion(raw, ledger, finalized, itemId, notificationKeys);
      const next: PlatformApprovalWork = { ...work, phase: 'completed', leaseToken: '', leaseStartedAtMs: 0, leaseUntilMs: 0 };
      delete next.reason; replaceRawPlatformApprovalWork(raw, next); await this.writeLifecycleRaw(raw, original);
    });
  }

  async claimManagerApprovalBatchItemReject(
    inputValue: PurchaseManagerApprovalBatchRejectClaimInput,
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<{
    claimed: boolean;
    entry: PurchaseManagerApprovalBatchActionEntry | null;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchRejectClaim(inputValue);
    return this.claimManagerApprovalBatchAction(input, now, authorize);
  }

  /** Lifecycle cards may approve only the one record authorized for this recipient. */
  async claimManagerApprovalBatchItemApproval(
    inputValue: PurchaseManagerApprovalBatchItemApprovalClaimInput,
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry) => void,
  ): Promise<{ claimed: boolean; entry: PurchaseManagerApprovalBatchActionEntry | null; batch: PurchaseManagerApprovalBatchEntry }> {
    const identity = normalizeManagerApprovalBatchCardIdentity(inputValue);
    const eventId = boundedText(inputValue.eventId, MAX_EVENT_ID_LENGTH), executionRecordId = normalizeRecordId(inputValue.executionRecordId);
    if (!eventId || (inputValue.choice !== 'comprehensive' && inputValue.choice !== 'building_self') || !identity.lifecycle || !authorize) throw new ForbiddenException('采购逐项审批身份或授权不可用');
    const input: NormalizedManagerApprovalBatchActionClaim = { ...identity, eventId, executionRecordId, choice: inputValue.choice, rejectionReason: '' };
    return this.claimManagerApprovalBatchAction(input, now, batch => {
      if (batch.flowVersion !== 'lifecycle_v1') throw new ConflictException('旧采购批次不支持全流程逐项审批');
      const item = batch.items.find(row => row.executionRecordId === executionRecordId);
      if (!item) throw new ConflictException('采购逐项审批明细不存在');
      assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(item)));
    });
  }

  private async claimManagerApprovalBatchAction(
    input: NormalizedManagerApprovalBatchActionClaim,
    now: Date | number,
    authorize?: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<{
    claimed: boolean;
    entry: PurchaseManagerApprovalBatchActionEntry | null;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    return this.enqueueCard(async () => {
      const ledger = await this.read();
      const replay = ledger.managerApprovalBatchActions.find(
        (entry) => entry.eventId === input.eventId,
      );
      if (replay && !sameManagerApprovalBatchActionPayload(replay, input)) {
        throw new ConflictException('采购批次审批回调事件与已有任务冲突');
      }
      const batch = requireActiveManagerApprovalBatch(ledger, input);
      if (input.executionRecordId && input.choice !== 'reject' && batch.flowVersion !== 'lifecycle_v1') throw new ConflictException('旧采购批次不支持全流程逐项审批');
      if (batch.flowVersion === 'lifecycle_v1' || batch.stageCardTransition) {
        if (!authorize) throw new ForbiddenException('采购全流程卡片缺少当前职责校验');
        assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch)));
      }
      if (batch.flowVersion === 'lifecycle_v1' && input.choice === 'reject') consumeLifecycleFormCredential(ledger, input, { action: 'submit_item_reject', role: 'manager', approvalBatchId: input.approvalBatchId, executionRecordId: input.executionRecordId, flowVersion: 'lifecycle_v1', cardRevision: input.lifecycle!.cardRevision }, input.eventId, resolveNow(now).getTime());
      if (replay) return { claimed: false, entry: replay, batch };
      if (
        input.choice === 'building_self' &&
        !isBuildingSelfPurchaseAllowed(
          parsePurchaseManagerBatchApprovalCardContext(batch.cardContext)
            .building,
        )
      ) {
        throw new ConflictException('H楼仅支持综合采购');
      }

      const blocking = ledger.managerApprovalBatchActions.find(
        (entry) =>
          entry.approvalBatchId === input.approvalBatchId &&
          isActiveStatus(entry.status),
      );
      if (blocking) return { claimed: false, entry: blocking, batch };
      const recordIds =
        input.choice === 'reject'
          ? (batch.flowVersion === 'lifecycle_v1' ? batch.state === 'active' : batch.state === 'reject_editing' && batch.selectedRejectRecordId === input.executionRecordId) &&
            batch.items.some(
              (item) =>
                item.executionRecordId === input.executionRecordId &&
                item.status === 'pending',
            )
            ? [input.executionRecordId]
            : []
          : input.executionRecordId
            ? batch.state === 'active' && batch.items.some(item => item.executionRecordId === input.executionRecordId && item.status === 'pending') ? [input.executionRecordId] : []
          : batch.state === 'active'
            ? batch.items
                .filter((item) => item.status === 'pending')
                .map((item) => item.executionRecordId)
            : [];
      if (recordIds.length === 0) return { claimed: false, entry: null, batch };
      if ((ledger.platformLegacyApprovalClaims || []).some(claim => recordIds.includes(claim.recordId))) throw new ConflictException('采购明细已有平台审批任务，请查看原任务');
      if (
        ledger.managerApprovalBatchActions.filter((entry) =>
          isActiveStatus(entry.status),
        ).length >= MAX_MANAGER_APPROVAL_BATCH_ACTIONS
      ) {
        throw new ServiceUnavailableException(
          '采购批次审批动作队列已满，请稍后重试',
        );
      }
      if (batch.flowVersion !== 'lifecycle_v1' && !batch.stageCardTransition) authorize?.(structuredClone(batch));
      const timestamp = resolveNow(now).toISOString();
      const entry: PurchaseManagerApprovalBatchActionEntry = {
        key: managerApprovalBatchActionKey(input.eventId),
        eventId: input.eventId,
        approvalBatchId: input.approvalBatchId,
        recordIds,
        choice: input.choice,
        rejectionReason: input.rejectionReason,
        messageId: input.messageId,
        actorOpenId: input.actorOpenId,
        status: 'pending',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
      };
      const claimedRecordIds = new Set(recordIds);
      const updated: PurchaseManagerApprovalBatchEntry = {
        ...batch,
        items: batch.items.map((item) =>
          claimedRecordIds.has(item.executionRecordId)
            ? {
                ...item,
                status: 'processing',
                choice: input.choice,
                rejectionReason: input.rejectionReason,
                actionEventId: input.eventId,
                actorOpenId: input.actorOpenId,
                processedAt: '',
                lastError: '',
              }
            : item,
        ),
        state: 'processing',
        selectedRejectRecordId: '',
        managerDeliveries: managerBatchDeliveries(batch).map(delivery => ({ ...delivery,
          selectedRejectRecordId: claimedRecordIds.has(delivery.selectedRejectRecordId) ? '' : delivery.selectedRejectRecordId,
        })),
        revision: batch.revision + 1,
        actorOpenId: input.actorOpenId,
        updatedAt: timestamp,
      };
      ledger.managerApprovalBatchActions.push(entry);
      replaceManagerApprovalBatch(ledger, updated);
      ledger.managerApprovalBatchActions =
        trimManagerApprovalBatchActionHistory(
          ledger.managerApprovalBatchActions,
        );
      await this.write(ledger);
      return { claimed: true, entry, batch: updated };
    });
  }

  async takeNextManagerApprovalBatchAction(
    now: Date | number = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<PurchaseManagerApprovalBatchActionEntry | null> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const index = ledger.managerApprovalBatchActions.findIndex((entry) =>
        isAvailable(entry, timestamp),
      );
      const current = ledger.managerApprovalBatchActions[index];
      if (index < 0 || !current) return null;
      const updated: PurchaseManagerApprovalBatchActionEntry = {
        ...current,
        status: 'processing',
        attempts: Math.min(current.attempts + 1, 1_000_000),
        updatedAt: timestamp.toISOString(),
        leaseUntil: new Date(
          timestamp.getTime() + normalizeLeaseMs(leaseMs),
        ).toISOString(),
        claimToken: randomUUID(),
      };
      ledger.managerApprovalBatchActions[index] = updated;
      await this.write(ledger);
      return updated;
    });
  }

  async completeManagerApprovalBatchActionRecord(
    key: string,
    claimToken: string,
    executionRecordIdValue: string,
    purchaser: PurchaseManagerApprovalBatchPurchaserSnapshot | undefined,
    now: Date | number = new Date(),
  ): Promise<{
    action: PurchaseManagerApprovalBatchActionEntry;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const executionRecordId = normalizeRecordId(executionRecordIdValue);
    return this.settleManagerApprovalBatchActionRecord(
      key,
      claimToken,
      executionRecordId,
      'completed',
      purchaser,
      undefined,
      now,
    );
  }

  async markManagerApprovalBatchActionRecordManual(
    key: string,
    claimToken: string,
    executionRecordIdValue: string,
    error: unknown,
    now: Date | number = new Date(),
  ): Promise<{
    action: PurchaseManagerApprovalBatchActionEntry;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const executionRecordId = normalizeRecordId(executionRecordIdValue);
    return this.settleManagerApprovalBatchActionRecord(
      key,
      claimToken,
      executionRecordId,
      'manual_reconciliation',
      undefined,
      error,
      now,
    );
  }

  private async settleManagerApprovalBatchActionRecord(
    keyValue: string,
    claimToken: string,
    executionRecordId: string,
    outcome: 'completed' | 'manual_reconciliation',
    purchaser: PurchaseManagerApprovalBatchPurchaserSnapshot | undefined,
    error: unknown,
    now: Date | number,
  ): Promise<{
    action: PurchaseManagerApprovalBatchActionEntry;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const claimed = requireClaimedManagerApprovalBatchActionAndBatch(
        ledger,
        clean(keyValue),
        claimToken,
      );
      if (!claimed.action.recordIds.includes(executionRecordId)) {
        throw new ConflictException('采购批次审批动作不包含该明细');
      }
      const target = claimed.batch.items.find(
        (item) => item.executionRecordId === executionRecordId,
      );
      if (!target) throw new ConflictException('采购批次审批明细不存在');
      if (
        target.status !== 'processing' ||
        target.actionEventId !== claimed.action.eventId
      ) {
        if (
          target.processedAt &&
          target.actionEventId === claimed.action.eventId &&
          (target.status === 'approved' ||
            target.status === 'rejected' ||
            target.status === 'manual_reconciliation')
        ) {
          return { action: claimed.action, batch: claimed.batch };
        }
        throw new ConflictException('采购批次审批明细状态不允许完成');
      }
      const settledStatus: PurchaseManagerBatchItemStatus =
        outcome === 'manual_reconciliation'
          ? 'manual_reconciliation'
          : claimed.action.choice === 'reject'
            ? 'rejected'
            : 'approved';
      if (claimed.batch.flowVersion === 'lifecycle_v1' && settledStatus === 'approved') {
        const currentTarget = normalizePurchaseAuthorityTarget(purchaser?.authorityTarget);
        if (!currentTarget || !target.authorityTarget || JSON.stringify(currentTarget) !== JSON.stringify(target.authorityTarget)) throw new ConflictException('采购明细楼栋或专业已变化，需重新核对');
      }
      let batch: PurchaseManagerApprovalBatchEntry = {
        ...claimed.batch,
        items: claimed.batch.items.map((item) =>
          item.executionRecordId === executionRecordId
            ? {
                ...item,
                status: settledStatus,
                processedAt: timestamp,
                lastError:
                  outcome === 'manual_reconciliation'
                    ? sanitizeError(error)
                    : '',
                purchaserOpenId:
                  settledStatus === 'approved'
                    ? normalizePurchaserSnapshot(purchaser).purchaserOpenId
                    : '',
                purchaserName:
                  settledStatus === 'approved'
                    ? normalizePurchaserSnapshot(purchaser).purchaserName
                    : '',
                ...(settledStatus==='approved'&&purchaser?.authorityTarget?{authorityTarget:normalizePurchaseAuthorityTarget(purchaser.authorityTarget)}:{}),
              }
            : item,
        ),
        updatedAt: timestamp,
      };
      let action = claimed.action;
      if (
        claimed.action.recordIds.every((recordId) => {
          const item = batch.items.find(
            (candidate) => candidate.executionRecordId === recordId,
          );
          return item && item.status !== 'processing';
        })
      ) {
        const hasManual = claimed.action.recordIds.some(
          (recordId) =>
            batch.items.find(
              (candidate) => candidate.executionRecordId === recordId,
            )?.status === 'manual_reconciliation',
        );
        action = {
          ...claimed.action,
          status: hasManual ? 'manual_reconciliation' : 'completed',
          updatedAt: timestamp,
          leaseUntil: '',
          claimToken: '',
          completedAt: timestamp,
          lastError: hasManual
            ? batch.items
                .filter(
                  (item) =>
                    item.actionEventId === claimed.action.eventId &&
                    item.status === 'manual_reconciliation',
                )
                .map((item) => item.lastError)
                .filter(Boolean)
                .join('；')
                .slice(0, MAX_ERROR_LENGTH)
            : '',
        };
        batch = finalizeManagerApprovalBatchAction(
          ledger,
          batch,
          action,
          timestamp,
        );
      } else {
        action = {
          ...claimed.action,
          attempts: 0,
          updatedAt: timestamp,
          lastError: '',
        };
      }
      ledger.managerApprovalBatchActions[claimed.actionIndex] = action;
      replaceManagerApprovalBatch(ledger, batch);
      queueExistingLifecycleBatchRefresh(ledger, batch);
      ledger.managerApprovalBatchActions =
        trimManagerApprovalBatchActionHistory(
          ledger.managerApprovalBatchActions,
        );
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { action, batch };
    });
  }

  async rescheduleManagerApprovalBatchAction(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number,
    now: Date | number = new Date(),
  ): Promise<PurchaseManagerApprovalBatchActionEntry | null> {
    return this.updateManagerApprovalBatchAction(key, claimToken, (entry) => ({
      ...entry,
      status: 'pending',
      updatedAt: resolveNow(now).toISOString(),
      nextAttemptAt: resolveNow(nextAttemptAt).toISOString(),
      leaseUntil: '',
      claimToken: '',
      completedAt: '',
      lastError: sanitizeError(error),
    }));
  }

  async failManagerApprovalBatchActionAndEnqueueRefresh(
    keyValue: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
  ): Promise<{
    action: PurchaseManagerApprovalBatchActionEntry;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const claimed = requireClaimedManagerApprovalBatchActionAndBatch(
        ledger,
        clean(keyValue),
        claimToken,
      );
      const action: PurchaseManagerApprovalBatchActionEntry = {
        ...claimed.action,
        status: 'failed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: sanitizeError(error),
      };
      let batch: PurchaseManagerApprovalBatchEntry = {
        ...claimed.batch,
        items: claimed.batch.items.map((item) =>
          item.actionEventId === action.eventId && item.status === 'processing'
            ? {
                ...item,
                status: 'pending',
                choice: '',
                rejectionReason: '',
                actionEventId: '',
                actorOpenId: '',
                processedAt: '',
                lastError: '',
              }
            : item,
        ),
        state: 'active',
        selectedRejectRecordId: '',
        revision: claimed.batch.revision + 1,
        updatedAt: timestamp,
      };
      batch = withManagerApprovalBatchContext(batch);
      enqueueManagerApprovalBatchStateNotifications(
        ledger,
        batch,
        'manager_batch_approval_refresh',
        timestamp,
      );
      ledger.managerApprovalBatchActions[claimed.actionIndex] = action;
      replaceManagerApprovalBatch(ledger, batch);
      await this.write(ledger);
      return { action, batch };
    });
  }

  async requeueKnownPrewriteManagerApprovalBatchAction(
    keyValue: string,
    recordIdValues: string[],
    now: Date | number = new Date(),
  ): Promise<{
    action: PurchaseManagerApprovalBatchActionEntry;
    batch: PurchaseManagerApprovalBatchEntry;
  } | null> {
    const key = clean(keyValue);
    const recordIds = [...new Set(recordIdValues.map(normalizeRecordId))];
    if (!key || recordIds.length === 0) {
      throw new ConflictException('采购批次审批恢复参数无效');
    }
    return this.enqueue(async () => {
      const ledger = await this.read();
      const actionIndex = ledger.managerApprovalBatchActions.findIndex(
        (entry) => entry.key === key,
      );
      const current = ledger.managerApprovalBatchActions[actionIndex];
      if (
        actionIndex < 0 ||
        !current ||
        current.status !== 'manual_reconciliation'
      ) {
        return null;
      }
      const batch = ledger.managerApprovalBatches.find(
        (entry) => entry.approvalBatchId === current.approvalBatchId,
      );
      if (!batch) {
        throw new ConflictException('采购批次审批恢复记录不存在');
      }
      if (
        ledger.managerApprovalBatchActions.some(
          (entry) =>
            entry.key !== current.key &&
            entry.approvalBatchId === current.approvalBatchId &&
            isActiveStatus(entry.status),
        )
      ) {
        throw new ConflictException('采购批次存在其他处理中动作');
      }
      const targetIds = new Set(recordIds);
      if (
        recordIds.some((recordId) => !current.recordIds.includes(recordId)) ||
        recordIds.some((recordId) => {
          const item = batch.items.find(
            (candidate) => candidate.executionRecordId === recordId,
          );
          return (
            !item ||
            item.status !== 'manual_reconciliation' ||
            item.actionEventId !== current.eventId
          );
        })
      ) {
        throw new ConflictException('采购批次审批恢复明细状态不一致');
      }
      const timestamp = resolveNow(now).toISOString();
      const action: PurchaseManagerApprovalBatchActionEntry = {
        ...current,
        status: 'pending',
        attempts: 0,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
      };
      let updatedBatch: PurchaseManagerApprovalBatchEntry = {
        ...batch,
        items: batch.items.map((item) =>
          targetIds.has(item.executionRecordId)
            ? {
                ...item,
                status: 'processing',
                processedAt: '',
                lastError: '',
                purchaserOpenId: '',
                purchaserName: '',
              }
            : item,
        ),
        state: 'processing',
        revision: batch.revision + 1,
        processedAt: '',
        updatedAt: timestamp,
        resolvedAt: '',
      };
      updatedBatch = withManagerApprovalBatchContext(updatedBatch);
      ledger.managerApprovalBatchActions[actionIndex] = action;
      replaceManagerApprovalBatch(ledger, updatedBatch);
      await this.write(ledger);
      return { action, batch: updatedBatch };
    });
  }

  async listManagerApprovalBatchActions(
    filter: {
      approvalBatchId?: string;
      status?: PurchaseManagerApprovalBatchActionStatus;
    } = {},
  ): Promise<PurchaseManagerApprovalBatchActionEntry[]> {
    const approvalBatchId = filter.approvalBatchId
      ? normalizeManagerApprovalBatchId(filter.approvalBatchId)
      : '';
    return this.enqueueRead(async () =>
      (await this.read()).managerApprovalBatchActions.filter(
        (entry) =>
          (!approvalBatchId || entry.approvalBatchId === approvalBatchId) &&
          (!filter.status || entry.status === filter.status),
      ),
    );
  }

  async getPurchaseBatchForFulfillmentCard(
    identityValue: PurchaseBatchFulfillmentCardIdentity,
    authorize?: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<{
    batch: PurchaseManagerApprovalBatchEntry;
    source: PurchaseWorkflowNotificationEntry;
  }> {
    const identity = normalizePurchaseBatchFulfillmentIdentity(identityValue);
    return this.enqueueCardRead(async () => {
      const result = requirePurchaseBatchFulfillmentSource(await this.read(), identity);
      if (result.batch.flowVersion === 'lifecycle_v1') {
        if (!authorize) throw new ForbiddenException('采购全流程卡片缺少当前职责校验');
        assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(result.batch)));
      }
      return result;
    });
  }

  /** Durable first step only; no private-chat network calls or image intent are
   * made while accepting the callback. This API is not registered for use. */
  async acceptLifecycleReceiptPrepare(
    input: Omit<ReceiptPrepareIdentity,'flowVersion'>,
    authorize: (batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchItemEntry)=>void,
  ): Promise<{taskId:string;status:'pending'|'ready'|'failed'}> {
    if (!input || typeof authorize !== 'function') throw new ForbiddenException('采购签收附件权限不可核对');
    return this.enqueueCard(async () => {
      const {ledger,raw,original}=await this.readLifecycleConsistent();
      const result=acceptReceiptPrepare(raw.lifecycleReceiptPrepareQueue ?? {version:1,tasks:[]},{...input,flowVersion:'lifecycle_v1'},Date.now());
      if (!result.created) {
        const batches=ledger.managerApprovalBatches.filter(row=>row.approvalBatchId===input.approvalBatchId),batch=batches[0];
        const item=batch?.items.find(row=>row.executionRecordId===input.executionRecordId);
        if (batches.length!==1 || batch?.flowVersion!=='lifecycle_v1' || batch.lifecycleAppId!==input.appId || input.appId!==readEnv('FEISHU_APP_ID') || batch.requesterOpenId!==input.actorOpenId || !item) throw new ForbiddenException('采购签收附件身份不可核对');
        assertSynchronousLifecycleAuthorization(()=>authorize(structuredClone(batch),structuredClone(item)));
        if (result.task.state==='failed') return {taskId:result.task.taskId,status:'failed' as const};
        if (result.task.state!=='completed') return {taskId:result.task.taskId,status:'pending' as const};
        const images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger ?? {version:1,intents:[],events:[],tasks:[]});
        const intent=images.intents.find(row=>row.id===result.task.intentId && row.appId===input.appId && row.actorOpenId===input.actorOpenId && row.cardMessageId===input.cardMessageId);
        if (!intent || intent.state!=='open' || intent.expiresAtMs<Date.now()) return {taskId:result.task.taskId,status:'failed' as const};
        const replica=(ledger.lifecycleOutbox || []).find(row=>row.replica.appId===input.appId && row.replica.batchId===input.approvalBatchId && row.replica.recipientOpenId===input.actorOpenId)?.replica;
        return {taskId:result.task.taskId,status:replica?.state==='delivered' && replica.messageId===intent.cardMessageId && replica.appliedRevision===intent.cardRevision ? 'ready' as const : 'pending' as const};
      }
      const identity:PurchaseBatchFulfillmentCardIdentity={approvalBatchId:input.approvalBatchId,actorOpenId:input.actorOpenId,messageId:input.cardMessageId,role:'requester',lifecycle:{appId:input.appId,cardRevision:input.cardRevision}};
      const {batch}=requirePurchaseBatchFulfillmentSource(ledger,identity);
      const item=batch.items.find(row=>row.executionRecordId===input.executionRecordId);
      if (batch.flowVersion!=='lifecycle_v1' || !item || item.status!=='approved' || (input.materialType==='invoice' && item.choice!=='building_self')) throw new ConflictException('采购签收附件对应明细不可处理');
      if (ledger.commands.some(row=>row.recordId===input.executionRecordId && row.action==='receive') || ledger.notifications.some(row=>row.recordId===input.executionRecordId && row.kind==='manager_batch_receipt_command' && row.status!=='failed')) throw new ConflictException('采购签收已受理，请核对原任务');
      assertSynchronousLifecycleAuthorization(()=>authorize(structuredClone(batch),structuredClone(item)));
      if (result.created) {
        const competing=result.queue.tasks.some(row=>row.taskId!==result.task.taskId && row.identity.appId===input.appId && row.identity.actorOpenId===input.actorOpenId && (row.state==='pending'||row.state==='processing'));
        const imageLedger=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger ?? {version:1,intents:[],events:[],tasks:[]});
        const current=Date.now();
        const activeIntent=imageLedger.intents.some(row=>row.appId===input.appId && row.actorOpenId===input.actorOpenId && (row.state==='bound'||row.state==='open' && row.expiresAtMs>=current));
        const oldIntent=ledger.managerApprovalBatches.some(row=>row.pendingReceiptUpload?.actorOpenId===input.actorOpenId && Date.parse(row.pendingReceiptUpload.expiresAt)>=current);
        if (competing || activeIntent || oldIntent) throw new ConflictException('当前已有签收图片上传准备或待处理意向，请先完成原任务');
      }
      if (result.created) { raw.lifecycleReceiptPrepareQueue=result.queue; await this.writeLifecycleRaw(raw,original); }
      return {taskId:result.task.taskId,status:result.task.state==='completed'?'ready':result.task.state==='failed'?'failed':'pending'};
    });
  }

  async claimLifecycleReceiptPrepare(taskId:string):Promise<LifecycleReceiptPrepareLease|null> {
    if (!/^receipt-prepare-[a-f0-9]{64}$/.test(taskId)) throw new BadRequestException('签收附件准备任务无效');
    return this.enqueueCard(async()=>{
      const {raw,original}=await this.readLifecycleConsistent();
      const queue=normalizeReceiptPrepareQueue(raw.lifecycleReceiptPrepareQueue ?? {version:1,tasks:[]});
      const task=queue.tasks.find(row=>row.taskId===taskId),now=Date.now();
      if (!task) throw new ConflictException('签收附件准备任务不存在');
      if (task.state==='completed' || task.state==='failed' || task.state==='processing' && now<task.leaseUntilMs) return null;
      const token=randomUUID(),updated=leaseReceiptPrepare(queue,taskId,token,now,DEFAULT_LEASE_MS);
      raw.lifecycleReceiptPrepareQueue=updated;await this.writeLifecycleRaw(raw,original);
      const {flowVersion:_flowVersion,...input}=task.identity;
      return {taskId,leaseToken:token,input};
    });
  }

  async listRecoverableLifecycleReceiptPrepare(afterTaskId='',limit=20):Promise<string[]> {
    if ((afterTaskId && !/^receipt-prepare-[a-f0-9]{64}$/.test(afterTaskId)) || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw new BadRequestException('签收附件准备恢复扫描参数无效');
    return this.enqueueCardRead(async()=>{
      const {ledger}=await this.readLifecycleConsistent(),now=Date.now();
      return (ledger.lifecycleReceiptPrepareQueue?.tasks || []).filter(task=>task.taskId>afterTaskId && now>=task.updatedAtMs && (task.state==='pending'||task.state==='processing'&&now>=task.leaseUntilMs)).map(task=>task.taskId).sort().slice(0,limit);
    });
  }

  /** Completes the private-chat check and creates the single intent and card
   * update together. The callbacks must run synchronously while the lock is held. */
  async completeLifecycleReceiptPrepare(lease:LifecycleReceiptPrepareLease,verifyPrivateChat:()=>void,
    authorize:(batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchItemEntry)=>void):Promise<void> {
    if (!lease || typeof verifyPrivateChat!=='function' || typeof authorize!=='function') throw new ForbiddenException('签收附件准备权限不可核对');
    await this.enqueueCard(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent(), queue=normalizeReceiptPrepareQueue(raw.lifecycleReceiptPrepareQueue);
      const task=queue.tasks.find(row=>row.taskId===lease.taskId), now=Date.now();
      if (!task || task.state!=='processing' || task.leaseToken!==lease.leaseToken || now>=task.leaseUntilMs) throw new ConflictException('签收附件准备租约已失效');
      const {flowVersion:_flowVersion,...savedInput}=task.identity;
      if (JSON.stringify(savedInput)!==JSON.stringify(lease.input)) throw new ConflictException('签收附件准备来源已变化');
      const identity:PurchaseBatchFulfillmentCardIdentity={approvalBatchId:savedInput.approvalBatchId,actorOpenId:savedInput.actorOpenId,messageId:savedInput.cardMessageId,role:'requester',lifecycle:{appId:savedInput.appId,cardRevision:savedInput.cardRevision}};
      const {batch}=requirePurchaseBatchFulfillmentSource(ledger,identity),item=batch.items.find(row=>row.executionRecordId===savedInput.executionRecordId);
      if (batch.flowVersion!=='lifecycle_v1' || !item || item.status!=='approved' || savedInput.materialType==='invoice' && item.choice!=='building_self') throw new ConflictException('采购签收附件对应明细不可处理');
      if (ledger.commands.some(row=>row.recordId===savedInput.executionRecordId && row.action==='receive') || ledger.notifications.some(row=>row.recordId===savedInput.executionRecordId && row.kind==='manager_batch_receipt_command' && row.status!=='failed')) throw new ConflictException('采购签收已受理，请核对原任务');
      assertSynchronousLifecycleAuthorization(verifyPrivateChat);
      assertSynchronousLifecycleAuthorization(()=>authorize(structuredClone(batch),structuredClone(item)));
      const imageLedger=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger ?? {version:1,intents:[],events:[],tasks:[]});
      if (imageLedger.intents.some(row=>row.appId===savedInput.appId && row.actorOpenId===savedInput.actorOpenId && (row.state==='bound'||row.state==='open' && row.expiresAtMs>=now)) || ledger.managerApprovalBatches.some(row=>row.pendingReceiptUpload?.actorOpenId===savedInput.actorOpenId && Date.parse(row.pendingReceiptUpload.expiresAt)>=now)) throw new ConflictException('当前已有签收图片上传意向');
      const outbox=normalizeLifecycleOutbox(raw.lifecycleOutbox),entry=findLifecycleEntry(outbox,{appId:savedInput.appId,batchId:savedInput.approvalBatchId,recipientOpenId:savedInput.actorOpenId});
      const nextRevision=entry.desiredRevision+1;
      if (!Number.isSafeInteger(nextRevision) || !Array.isArray(raw.lifecycleOutbox)) throw new ConflictException('采购卡片版本超限');
      const stored=raw.lifecycleOutbox.filter(row=>isRecord(row) && isRecord(row.replica) && lifecycleIdentityKey(row.replica as unknown as PurchaseReplicaIdentity)===lifecycleIdentityKey(entry.replica));
      if (stored.length!==1 || !isRecord(stored[0])) throw new ConflictException('采购卡片副本账本损坏');
      const intentId=randomUUID();
      imageLedger.intents.push({id:intentId,appId:savedInput.appId,actorOpenId:savedInput.actorOpenId,chatId:savedInput.chatId,approvalBatchId:savedInput.approvalBatchId,executionRecordId:savedInput.executionRecordId,cardMessageId:savedInput.cardMessageId,cardRevision:nextRevision,materialType:savedInput.materialType,flowVersion:'lifecycle_v1',createdAtMs:now,expiresAtMs:now+RECEIPT_UPLOAD_INTENT_TTL_MS,state:'open',taskId:''});
      raw.lifecycleReceiptImageLedger=normalizeReceiptImageLedger(imageLedger);
      raw.lifecycleReceiptPrepareQueue=finishReceiptPrepare(queue,lease.taskId,lease.leaseToken,now,{intentId});
      stored[0].desiredRevision=nextRevision;
      await this.writeLifecycleRaw(raw,original);
    });
  }

  async failLifecycleReceiptPrepare(lease:LifecycleReceiptPrepareLease):Promise<void> {
    if (!lease) throw new BadRequestException('签收附件准备任务无效');
    await this.enqueueCard(async()=>{
      const {raw,original}=await this.readLifecycleConsistent(),queue=normalizeReceiptPrepareQueue(raw.lifecycleReceiptPrepareQueue);
      const task=queue.tasks.find(row=>row.taskId===lease.taskId),now=Date.now();
      if (!task) throw new ConflictException('签收附件准备任务不存在');
      // A lost local acknowledgement cannot turn a committed intent into a failure.
      if (task.state==='completed' || task.state==='failed') return;
      if (task.state!=='processing' || task.leaseToken!==lease.leaseToken || now>=task.leaseUntilMs) throw new ConflictException('签收附件准备租约已失效');
      const {flowVersion:_flowVersion,...savedInput}=task.identity;
      if (JSON.stringify(savedInput)!==JSON.stringify(lease.input)) throw new ConflictException('签收附件准备来源已变化');
      raw.lifecycleReceiptPrepareQueue=finishReceiptPrepare(queue,lease.taskId,lease.leaseToken,now,{failure:'chat_unverified'});
      const entries=normalizeLifecycleOutbox(raw.lifecycleOutbox),matches=entries.filter(row=>row.replica.appId===savedInput.appId && row.replica.batchId===savedInput.approvalBatchId && row.replica.recipientOpenId===savedInput.actorOpenId && row.replica.messageId===savedInput.cardMessageId);
      if (matches.length===1 && Array.isArray(raw.lifecycleOutbox)) {
        const next=matches[0]!.desiredRevision+1;
        const rows=raw.lifecycleOutbox.filter(row=>isRecord(row) && isRecord(row.replica) && lifecycleIdentityKey(row.replica as unknown as PurchaseReplicaIdentity)===lifecycleIdentityKey(matches[0]!.replica));
        if (!Number.isSafeInteger(next) || rows.length!==1 || !isRecord(rows[0])) throw new ConflictException('采购卡片副本账本损坏');
        rows[0].desiredRevision=next;
      }
      await this.writeLifecycleRaw(raw,original);
    });
  }

  async getLifecycleReceiptPreparation(identity:PurchaseReplicaIdentity,messageId:string,
    authorize:(batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchItemEntry)=>void):Promise<LifecycleReceiptPreparationView|null> {
    if (!identity || typeof authorize!=='function' || identity.appId!==readEnv('FEISHU_APP_ID')) throw new ForbiddenException('签收附件状态不可核对');
    return this.enqueueCardRead(async()=>{
      const ledger=await this.read(), batches=ledger.managerApprovalBatches.filter(row=>row.approvalBatchId===identity.batchId),batch=batches[0];
      const replicas=(ledger.lifecycleOutbox || []).filter(row=>lifecycleIdentityKey(row.replica)===lifecycleIdentityKey(identity));
      if (batches.length!==1 || batch?.flowVersion!=='lifecycle_v1' || batch.lifecycleAppId!==identity.appId || batch.requesterOpenId!==identity.recipientOpenId || replicas.length!==1 || replicas[0]!.replica.messageId!==messageId) throw new ForbiddenException('签收附件状态不可核对');
      const view=lifecycleReceiptPreparationView(ledger,identity,messageId); if (!view) return null;
      const item=batch.items.find(row=>row.executionRecordId===view.executionRecordId);
      if (!item || item.status!=='approved') throw new ForbiddenException('签收附件权限不可核对');
      assertSynchronousLifecycleAuthorization(()=>authorize(structuredClone(batch),structuredClone(item)));
      return view;
    });
  }

  /** Verified Feishu image and intent are matched under the same lock. Event
   * and message keys both remain durable even when the intent has expired. */
  async ownsLifecycleReceiptImageMessage(appId:string,actorOpenId:string,eventId:string,messageId:string):Promise<boolean> {
    if(appId!==readEnv('FEISHU_APP_ID') || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(appId) || !OPEN_ID_PATTERN.test(actorOpenId) || !/^[A-Za-z0-9_:-]{1,256}$/.test(eventId) || !/^om_[A-Za-z0-9_:-]{1,253}$/.test(messageId))throw new ForbiddenException('签收图片路由身份不可核对');
    return this.enqueueCardRead(async()=>{
      const ledger=await this.read(),images=ledger.lifecycleReceiptImageLedger;
      const eventFingerprint=createHash('sha256').update(JSON.stringify(['lifecycle-receipt-event-v1',appId,eventId])).digest('hex');
      const messageFingerprint=createHash('sha256').update(JSON.stringify(['lifecycle-receipt-message-v1',appId,messageId])).digest('hex');
      const event=images?.events.find(row=>row.eventFingerprint===eventFingerprint);
      const tasks=(images?.tasks || []).filter(row=>row.messageFingerprint===messageFingerprint || row.taskId===event?.taskId);
      if(tasks.length){
        for(const task of tasks){const intent=images!.intents.find(row=>row.id===task.intentId);if(!intent || intent.appId!==appId || intent.actorOpenId!==actorOpenId)throw new ForbiddenException('签收图片原事件身份不匹配');}
        return true;
      }
      const now=Date.now();
      return (images?.intents || []).some(intent=>intent.appId===appId&&intent.actorOpenId===actorOpenId&&(intent.state==='bound'||intent.state==='open'&&intent.expiresAtMs>=now)) ||
        (ledger.lifecycleReceiptPrepareQueue?.tasks || []).some(task=>task.identity.appId===appId&&task.identity.actorOpenId===actorOpenId&&(task.state==='pending'||task.state==='processing'));
    });
  }

  async acceptVerifiedLifecycleReceiptImage(snapshot:VerifiedLifecycleReceiptImageSnapshot,
    authorize:(batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchItemEntry,intent:LifecycleReceiptImageIntent)=>void):Promise<{accepted:boolean;enqueued:boolean;taskId?:string}> {
    if (!snapshot || typeof authorize!=='function') throw new ForbiddenException('签收图片来源不可核对');
    return this.enqueueCard(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent(),appId=readEnv('FEISHU_APP_ID');
      const verified=extractVerifiedLifecycleReceiptImage(snapshot,appId);
      const images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger ?? {version:1,intents:[],events:[],tasks:[]});
      const replay=recordReceiptImageReplay(images,verified);
      if (replay) {
        const intent=images.intents.find(row=>row.id===replay.task.intentId);
        const batch=ledger.managerApprovalBatches.find(row=>row.approvalBatchId===intent?.approvalBatchId);
        const item=batch?.items.find(row=>row.executionRecordId===intent?.executionRecordId);
        if (!intent || intent.appId!==appId || intent.actorOpenId!==verified.event.actorOpenId || intent.chatId!==verified.event.chatId || batch?.flowVersion!=='lifecycle_v1' || batch.lifecycleAppId!==appId || batch.requesterOpenId!==intent.actorOpenId || !item) throw new ForbiddenException('签收图片来源不可核对');
        assertSynchronousLifecycleAuthorization(()=>authorize(structuredClone(batch),structuredClone(item),structuredClone(intent)));
        if (replay.ledger.events.length!==images.events.length) {raw.lifecycleReceiptImageLedger=replay.ledger;await this.writeLifecycleRaw(raw,original);}
        return {accepted:true,enqueued:false,taskId:replay.task.taskId};
      }
      const outstanding:LifecycleReceiptImageIntent[]=images.intents.filter(row=>row.state==='open').map(({state:_state,taskId:_taskId,...intent})=>intent);
      const binding=matchVerifiedLifecycleReceiptImage(snapshot,appId,outstanding,Date.now());
      if (images.intents.some(row=>row.appId===appId && row.actorOpenId===binding.intent.actorOpenId && row.state==='bound') || ledger.managerApprovalBatches.some(row=>row.pendingReceiptUpload?.actorOpenId===binding.intent.actorOpenId && Date.parse(row.pendingReceiptUpload.expiresAt)>=Date.now())) throw new ConflictException('签收图片存在其他待处理意向');
      const replica=(ledger.lifecycleOutbox || []).find(row=>row.replica.appId===appId && row.replica.batchId===binding.intent.approvalBatchId && row.replica.recipientOpenId===binding.intent.actorOpenId);
      if (!replica || replica.replica.state!=='delivered' || replica.replica.messageId!==binding.intent.cardMessageId || replica.replica.appliedRevision<binding.intent.cardRevision || replica.desiredRevision!==replica.replica.appliedRevision) throw new ConflictException('签收图片卡片尚未确认送达');
      const identity:PurchaseBatchFulfillmentCardIdentity={approvalBatchId:binding.intent.approvalBatchId,actorOpenId:binding.intent.actorOpenId,messageId:binding.intent.cardMessageId,role:'requester',lifecycle:{appId,cardRevision:replica.replica.appliedRevision}};
      const {batch}=requirePurchaseBatchFulfillmentSource(ledger,identity),item=batch.items.find(row=>row.executionRecordId===binding.intent.executionRecordId);
      if (!item || item.status!=='approved' || binding.intent.materialType==='invoice' && item.choice!=='building_self' || ledger.commands.some(row=>row.recordId===item.executionRecordId && row.action==='receive') || ledger.notifications.some(row=>row.recordId===item.executionRecordId && row.kind==='manager_batch_receipt_command' && row.status!=='failed')) throw new ConflictException('采购签收明细已变化');
      assertSynchronousLifecycleAuthorization(()=>authorize(structuredClone(batch),structuredClone(item),structuredClone(binding.intent)));
      const result=bindReceiptImage(images,binding,randomUUID());
      raw.lifecycleReceiptImageLedger=result.ledger;await this.writeLifecycleRaw(raw,original);
      return {accepted:true,enqueued:result.created,taskId:result.task.taskId};
    });
  }

  /** All upload mutations share the original purchase ledger lock and raw-byte CAS. */
  async bindLifecycleReceiptImageSource(appId:string,sourceFingerprint:string):Promise<void> {
    const binding=normalizeLifecycleReceiptImageSource({appId,sourceFingerprint});
    return this.enqueueCard(async()=>{
      try { await readFile(this.ledgerPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const empty = await this.read();
        empty.lifecycleReceiptImageSource = binding;
        await this.write(empty);
        return;
      }
      const {ledger,raw,original}=await this.readLifecycleConsistent();
      if(raw.lifecycleReceiptImageSource!==undefined){
        const existing=normalizeLifecycleReceiptImageSource(raw.lifecycleReceiptImageSource);
        if(existing.appId!==binding.appId || existing.sourceFingerprint!==binding.sourceFingerprint)throw new ConflictException('签收图片持久来源已变化，需人工核对');
        return;
      }
      const images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger ?? {version:1,intents:[],events:[],tasks:[]});
      const prepared=normalizeReceiptPrepareQueue(raw.lifecycleReceiptPrepareQueue ?? {version:1,tasks:[]});
      if(images.intents.length || images.tasks.length || images.events.length || prepared.tasks.length)throw new ConflictException('已有签收图片任务缺少持久来源，不可自动接管');
      const payments=normalizeLifecyclePaymentUploads(raw.lifecyclePaymentUploads ?? []),paymentBlocks=normalizeLifecyclePaymentBlocks(raw.lifecyclePaymentBlocks ?? []);
      if(payments.length || paymentBlocks.length || ledger.managerApprovalBatches.some(batch=>batch.flowVersion==='lifecycle_v1' && batch.items.some(item=>item.paymentAttachmentTokens.length>0)))throw new ConflictException('已有付款附件任务缺少持久来源，不可自动接管');
      raw.lifecycleReceiptImageSource=binding;await this.writeLifecycleRaw(raw,original);
    });
  }

  async verifyLifecycleReceiptImageSource(appId:string,sourceFingerprint:string):Promise<void> {
    const expected=normalizeLifecycleReceiptImageSource({appId,sourceFingerprint});
    return this.enqueueCardRead(async()=>{
      const ledger=await this.read(),stored=ledger.lifecycleReceiptImageSource;
      if(!stored || stored.appId!==expected.appId || stored.sourceFingerprint!==expected.sourceFingerprint)throw new ConflictException('签收图片持久来源不可核对');
    });
  }

  async inspectLifecycleReceiptImageUpload(taskId:string,authorize:(context:LifecycleReceiptImageAuthorizationContext)=>void):Promise<{task:ReceiptImageTask;context:LifecycleReceiptImageAuthorizationContext}> {
    return this.enqueueCardRead(async()=>{
      const {ledger,raw}=await this.readLifecycleConsistent(),images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger);
      const {task,batch,item,intent}=this.lifecycleReceiptImageContext(ledger,images,taskId,authorize);
      return structuredClone({task,context:{batch,item,intent}});
    });
  }

  async listRecoverableLifecycleReceiptImageUploads(afterTaskId='',limit=20):Promise<string[]> {
    if ((afterTaskId && !/^[A-Za-z0-9_:-]{1,256}$/.test(afterTaskId)) || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw new BadRequestException('签收图片恢复参数无效');
    return this.enqueueCardRead(async()=>{
      const {raw}=await this.readLifecycleConsistent();
      const images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger ?? {version:1,intents:[],events:[],tasks:[]}),now=Date.now();
      return images.tasks.filter(task=>task.taskId>afterTaskId && (task.state==='ready'||task.state==='uploaded') && (!task.leaseToken || now>=task.leaseStartedAtMs && now>=task.leaseUntilMs)).map(task=>task.taskId).sort().slice(0,limit);
    });
  }

  async claimLifecycleReceiptImageUpload(taskId:string,authorize:(context:LifecycleReceiptImageAuthorizationContext)=>void):Promise<ReceiptImageTask> {
    return this.enqueueCard(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent();
      const images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger);
      const {task}=this.lifecycleReceiptImageContext(ledger,images,taskId,authorize);
      // Never replace a dispatched attempt's token: a late confirmed receipt
      // must still be attributable to the original attempt after a restart.
      if (['completed','dispatching','manual_reconciliation'].includes(task.state)) return structuredClone(task);
      const leased=leaseReceiptImageTask(images,taskId,randomUUID(),Date.now(),60_000);
      raw.lifecycleReceiptImageLedger=leased.ledger;await this.writeLifecycleRaw(raw,original);return leased.task;
    });
  }

  async releaseLifecycleReceiptImageBeforeDispatch(taskId:string,leaseToken:string):Promise<void> {
    return this.enqueueCard(async()=>{
      const {raw,original}=await this.readLifecycleConsistent(),images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger);
      const task=images.tasks.find(row=>row.taskId===taskId);
      if (!task || !leaseToken || task.leaseToken!==leaseToken || task.state!=='ready') throw new ConflictException('签收图片任务不能释放');
      task.leaseToken='';task.leaseStartedAtMs=0;task.leaseUntilMs=0;
      raw.lifecycleReceiptImageLedger=normalizeReceiptImageLedger(images);await this.writeLifecycleRaw(raw,original);
    });
  }

  async dispatchLifecycleReceiptImageUpload(taskId:string,leaseToken:string,authorize:(context:LifecycleReceiptImageAuthorizationContext)=>void):Promise<void> {
    return this.enqueueCard(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent(),images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger);
      assertReceiptImageLease(images,taskId,leaseToken,Date.now());
      this.lifecycleReceiptImageContext(ledger,images,taskId,authorize);
      raw.lifecycleReceiptImageLedger=transitionReceiptImageTask(images,taskId,'dispatch');await this.writeLifecycleRaw(raw,original);
    });
  }

  async recordLifecycleReceiptImageUploaded(taskId:string,leaseToken:string,fileToken:string):Promise<void> {
    return this.enqueueCard(async()=>{
      const {raw,original}=await this.readLifecycleConsistent(),images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger);
      const task=images.tasks.find(row=>row.taskId===taskId);
      // Evidence recording does not grant business permission. Preserve the
      // known receipt even if authorization or the lease time changed in flight.
      if (!task || !leaseToken || task.leaseToken!==leaseToken || !['dispatching','uploaded'].includes(task.state)) throw new ConflictException('签收图片上传回执不匹配');
      raw.lifecycleReceiptImageLedger=transitionReceiptImageTask(images,taskId,'uploaded',fileToken);await this.writeLifecycleRaw(raw,original);
    });
  }

  async markLifecycleReceiptImageUploadUncertain(taskId:string,leaseToken:string):Promise<void> {
    return this.enqueueCard(async()=>{
      const {raw,original}=await this.readLifecycleConsistent(),images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger);
      const task=images.tasks.find(row=>row.taskId===taskId);
      if (!task || !leaseToken || task.leaseToken!==leaseToken) throw new ConflictException('签收图片上传回执不匹配');
      if (task.state==='uploaded' || task.state==='completed' || task.state==='manual_reconciliation') return;
      raw.lifecycleReceiptImageLedger=transitionReceiptImageTask(images,taskId,'uncertain');await this.writeLifecycleRaw(raw,original);
    });
  }

  async commitLifecycleReceiptImageUploaded(taskId:string,leaseToken:string,authorize:(context:LifecycleReceiptImageAuthorizationContext)=>void):Promise<void> {
    return this.enqueueCard(async()=>{
      const {ledger,raw,original}=await this.readLifecycleConsistent(),images=normalizeReceiptImageLedger(raw.lifecycleReceiptImageLedger);
      const {task,intent}=this.lifecycleReceiptImageContext(ledger,images,taskId,authorize);
      if (task.state==='completed') return;
      assertReceiptImageLease(images,taskId,leaseToken,Date.now());
      if (task.state!=='uploaded') throw new ConflictException('签收图片上传尚未确认');
      const batches=Array.isArray(raw.managerApprovalBatches)?raw.managerApprovalBatches.filter(row=>isRecord(row)&&row.approvalBatchId===intent.approvalBatchId):[],batch=batches[0];
      if (batches.length!==1 || !isRecord(batch) || !Array.isArray(batch.items) || !Number.isSafeInteger(batch.revision)) throw new ConflictException('签收图片批次账本损坏');
      const items=batch.items.filter(row=>isRecord(row)&&row.executionRecordId===intent.executionRecordId),item=items[0];
      const field=intent.materialType==='invoice'?'invoiceTokens':'receiptPhotoTokens';
      if (items.length!==1 || !isRecord(item) || !Array.isArray(item[field]) || item[field].some(token=>typeof token!=='string')) throw new ConflictException('签收图片明细账本损坏');
      const tokens=mergeAttachmentTokens(item[field] as string[],[task.fileToken]);
      if(tokens.length>20)throw new ConflictException('签收附件数量超限');
      const nextRevision=Number(batch.revision)+1;if(!Number.isSafeInteger(nextRevision))throw new ConflictException('签收批次版本超限');
      item[field]=tokens;batch.revision=nextRevision;batch.updatedAt=new Date().toISOString();
      const affected=normalizeLifecycleOutbox(raw.lifecycleOutbox).filter(row=>row.replica.appId===intent.appId&&row.replica.batchId===intent.approvalBatchId);
      if(!affected.length || !Array.isArray(raw.lifecycleOutbox))throw new ConflictException('签收卡片副本不可用');
      const revision=Math.max(...affected.map(row=>row.desiredRevision))+1;if(!Number.isSafeInteger(revision))throw new ConflictException('签收卡片版本超限');
      for(const entry of affected){const rows=raw.lifecycleOutbox.filter(row=>isRecord(row)&&isRecord(row.replica)&&lifecycleIdentityKey(row.replica as unknown as PurchaseReplicaIdentity)===lifecycleIdentityKey(entry.replica));if(rows.length!==1||!isRecord(rows[0]))throw new ConflictException('签收卡片副本账本损坏');rows[0].desiredRevision=revision;}
      raw.lifecycleReceiptImageLedger=transitionReceiptImageTask(images,taskId,'complete');
      await this.writeLifecycleRaw(raw,original);
    });
  }

  private lifecycleReceiptImageContext(ledger:PurchaseWorkflowLedger,images:ReceiptImageLedger,taskId:string,authorize:(context:LifecycleReceiptImageAuthorizationContext)=>void) {
    const task=images.tasks.find(row=>row.taskId===taskId),intent=images.intents.find(row=>row.id===task?.intentId),appId=readEnv('FEISHU_APP_ID');
    const batch=ledger.managerApprovalBatches.find(row=>row.approvalBatchId===intent?.approvalBatchId),item=batch?.items.find(row=>row.executionRecordId===intent?.executionRecordId);
    if (!task || !intent || typeof authorize!=='function' || intent.appId!==appId || intent.taskId!==task.taskId || !batch || batch.flowVersion!=='lifecycle_v1' || batch.lifecycleAppId!==appId || batch.requesterOpenId!==intent.actorOpenId || !item) throw new ForbiddenException('签收图片任务身份不可核对');
    if(task.state!=='completed'){
      const replica=(ledger.lifecycleOutbox || []).find(row=>row.replica.appId===appId&&row.replica.batchId===batch.approvalBatchId&&row.replica.recipientOpenId===intent.actorOpenId);
      if(!replica || replica.replica.state!=='delivered' || replica.replica.messageId!==intent.cardMessageId || replica.replica.appliedRevision<intent.cardRevision || replica.replica.appliedRevision!==replica.desiredRevision)throw new ConflictException('签收图片卡片状态已变化');
      requirePurchaseBatchFulfillmentSource(ledger,{approvalBatchId:batch.approvalBatchId,actorOpenId:intent.actorOpenId,messageId:intent.cardMessageId,role:'requester',lifecycle:{appId,cardRevision:replica.replica.appliedRevision}});
      if(item.status!=='approved' || intent.materialType==='invoice'&&item.choice!=='building_self' || ledger.commands.some(row=>row.recordId===item.executionRecordId&&row.action==='receive') || ledger.notifications.some(row=>row.recordId===item.executionRecordId&&row.kind==='manager_batch_receipt_command'&&row.status!=='failed'))throw new ConflictException('采购签收明细已变化');
    }
    assertSynchronousLifecycleAuthorization(()=>authorize({batch:structuredClone(batch),item:structuredClone(item),intent:structuredClone(intent)}));
    return {task,intent,batch,item};
  }

  async preparePurchaseBatchReceiptUpload(
    identityValue: PurchaseBatchFulfillmentCardIdentity,
    input: {
      executionRecordId: string;
      materialType: 'receipt_photo' | 'invoice';
    },
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry) => void,
  ): Promise<PurchaseManagerApprovalBatchEntry> {
    const identity = normalizePurchaseBatchFulfillmentIdentity(identityValue);
    if (identity.role !== 'requester') {
      throw new ConflictException('采购签收材料上传身份不匹配');
    }
    const executionRecordId = normalizeRecordId(input.executionRecordId);
    if (
      input.materialType !== 'receipt_photo' &&
      input.materialType !== 'invoice'
    ) {
      throw new BadRequestException('采购签收材料类型无效');
    }
    return this.enqueueCard(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const { batch } = requirePurchaseBatchFulfillmentSource(ledger, identity);
      const item = batch.items.find(
        (candidate) => candidate.executionRecordId === executionRecordId,
      );
      if (!item || item.status !== 'approved') {
        throw new ConflictException('采购签收明细不可处理');
      }
      if (batch.flowVersion === 'lifecycle_v1') {
        if (!authorize) throw new ForbiddenException('采购全流程卡片缺少当前职责校验');
        assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(item)));
        // The legacy intent format has no authenticated private-chat binding. Do not
        // create an unmatchable lifecycle intent or overwrite another active intent.
        // The lifecycle receiver must use a dedicated, authenticated intent instead.
        throw new ConflictException('采购全流程签收图片安全入口尚未就绪');
      }
      if (batch.requesterOpenId !== identity.actorOpenId) {
        throw new ConflictException('采购签收材料上传身份不匹配');
      }
      const appId=readEnv('FEISHU_APP_ID');
      const hasLifecyclePrepare=(ledger.lifecycleReceiptPrepareQueue?.tasks || []).some(task=>task.identity.appId===appId && task.identity.actorOpenId===identity.actorOpenId && (task.state==='pending'||task.state==='processing'));
      const hasLifecycleIntent=(ledger.lifecycleReceiptImageLedger?.intents || []).some(intent=>intent.appId===appId && intent.actorOpenId===identity.actorOpenId && (intent.state==='bound'||intent.state==='open' && intent.expiresAtMs>=timestamp.getTime()));
      if (hasLifecyclePrepare || hasLifecycleIntent) throw new ConflictException('存在全流程签收图片准备或意向，请核对原任务');
      if (input.materialType === 'invoice' && item.choice !== 'building_self') {
        throw new ConflictException('综合采购无需上传发票');
      }
      const pendingReceiptUpload: PurchaseBatchReceiptUploadIntent = {
        executionRecordId,
        materialType: input.materialType,
        actorOpenId: identity.actorOpenId,
        messageId: identity.messageId,
        ...(identity.lifecycle ? { lifecycle: identity.lifecycle } : {}),
        createdAt: timestamp.toISOString(),
        expiresAt: new Date(
          timestamp.getTime() + RECEIPT_UPLOAD_INTENT_TTL_MS,
        ).toISOString(),
      };
      const updated: PurchaseManagerApprovalBatchEntry = {
        ...batch,
        pendingReceiptUpload,
        revision: batch.revision + 1,
        updatedAt: timestamp.toISOString(),
      };
      replaceManagerApprovalBatch(ledger, updated);
      await this.write(ledger);
      return updated;
    });
  }

  async acceptPurchaseReceiptImageMessage(
    input: {
      eventId: string;
      actorOpenId: string;
      messageId: string;
      chatId: string;
      imageKey: string;
    },
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry) => void,
  ): Promise<{
    accepted: boolean;
    enqueued: boolean;
    notification: PurchaseWorkflowNotificationEntry | null;
  }> {
    const eventId = boundedText(input.eventId, MAX_EVENT_ID_LENGTH);
    const actorOpenId = boundedText(input.actorOpenId, MAX_OPEN_ID_LENGTH);
    const imageMessageId = boundedText(input.messageId, MAX_DELIVERY_ID_LENGTH);
    const chatId = boundedText(input.chatId, MAX_DELIVERY_ID_LENGTH);
    const imageKey = boundedText(input.imageKey, MAX_DELIVERY_ID_LENGTH);
    if (
      !eventId ||
      !OPEN_ID_PATTERN.test(actorOpenId) ||
      !imageMessageId ||
      !chatId ||
      !imageKey
    ) {
      throw new BadRequestException('采购签收图片消息无效');
    }
    return this.enqueueCard(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const existing = ledger.notifications.find(
        (entry) =>
          entry.businessEventId ===
          `manager_batch_receipt_attachment:${eventId}`,
      );
      if (existing) {
        return { accepted: true, enqueued: false, notification: existing };
      }
      const appId=readEnv('FEISHU_APP_ID');
      const hasLifecyclePrepare=(ledger.lifecycleReceiptPrepareQueue?.tasks || []).some(task=>task.identity.appId===appId && task.identity.actorOpenId===actorOpenId && (task.state==='pending'||task.state==='processing'));
      const hasLifecycleIntent=(ledger.lifecycleReceiptImageLedger?.intents || []).some(intent=>intent.appId===appId && intent.actorOpenId===actorOpenId && (intent.state==='bound'||intent.state==='open' && intent.expiresAtMs>=timestamp.getTime()));
      if (hasLifecyclePrepare || hasLifecycleIntent) throw new ConflictException('存在全流程签收图片准备或意向，请核对原任务');
      const candidates = ledger.managerApprovalBatches
        .filter((batch) => {
          const intent = batch.pendingReceiptUpload;
          return (
            intent?.actorOpenId === actorOpenId &&
            Date.parse(intent.expiresAt) >= timestamp.getTime()
          );
        })
        .sort(
          (left, right) =>
            Date.parse(right.pendingReceiptUpload!.createdAt) -
            Date.parse(left.pendingReceiptUpload!.createdAt),
        );
      // The legacy endpoint cannot distinguish concurrent old/new receipt intents safely.
      // Keep every intent intact until the lifecycle image receiver is explicitly wired.
      if (candidates.some(batch => batch.flowVersion === 'lifecycle_v1')) throw new ConflictException('存在全流程签收意向，请使用安全图片入口');
      const batch = candidates[0];
      const intent = batch?.pendingReceiptUpload;
      if (!batch || !intent) {
        return { accepted: false, enqueued: false, notification: null };
      }
      if (batch.flowVersion === 'lifecycle_v1') {
        assertLifecycleCallbackWithinLedger(ledger, batch, { approvalBatchId: batch.approvalBatchId, actorOpenId, messageId: intent.messageId, lifecycle: intent.lifecycle });
        const item = batch.items.find(row => row.executionRecordId === intent.executionRecordId);
        if (!item || item.status !== 'approved' || batch.requesterOpenId !== actorOpenId || !authorize) throw new ForbiddenException('采购签收职责或明细已变化');
        assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(item)));
      }
      if (
        ledger.notifications.filter((entry) => isActiveStatus(entry.status))
          .length >= MAX_NOTIFICATIONS
      ) {
        throw new ServiceUnavailableException(
          '采购通知任务队列已满，请稍后重试',
        );
      }
      const notificationInput: PurchaseWorkflowNotificationInput = {
        businessEventId: `manager_batch_receipt_attachment:${eventId}`,
        recordId: intent.executionRecordId,
        recipientOpenId: actorOpenId,
        kind: 'manager_batch_receipt_attachment',
        cardContext: JSON.stringify({
          version: 1,
          approvalBatchId: batch.approvalBatchId,
          executionRecordId: intent.executionRecordId,
          materialType: intent.materialType,
          actorOpenId,
          cardMessageId: intent.messageId,
          imageMessageId,
          chatId,
          imageKey,
        }),
      };
      const notification = createNotificationEntry(
        normalizeNotificationInput(notificationInput),
        timestamp.toISOString(),
      );
      ledger.notifications.push(notification);
      replaceManagerApprovalBatch(ledger, {
        ...batch,
        pendingReceiptUpload: undefined,
        revision: batch.revision + 1,
        updatedAt: timestamp.toISOString(),
      });
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { accepted: true, enqueued: true, notification };
    });
  }

  async claimPurchaseBatchFulfillmentCommand(
    identityValue: PurchaseBatchFulfillmentCardIdentity,
    contextValue: PurchaseBatchFulfillmentCommandContext | ((batch: PurchaseManagerApprovalBatchEntry) => PurchaseBatchFulfillmentCommandContext),
    eventIdValue: string,
    now: Date | number = new Date(),
    authorize?: (batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchEntry['items'][number]) => void,
  ): Promise<{
    claimed: boolean;
    entry: PurchaseWorkflowNotificationEntry;
    batch: PurchaseManagerApprovalBatchEntry;
    fulfillmentNotifications: PurchaseWorkflowNotificationEntry[];
    timing: { queueMs: number; readMs: number; decisionMs: number; writeMs: number };
  }> {
    const startedAt = Date.now();
    const identity = normalizePurchaseBatchFulfillmentIdentity(identityValue);
    const normalizeContext = (value: PurchaseBatchFulfillmentCommandContext) => parsePurchaseBatchFulfillmentCommandContext(serializePurchaseBatchFulfillmentCommandContext(value));
    const createContext: (batch: PurchaseManagerApprovalBatchEntry) => PurchaseBatchFulfillmentCommandContext = typeof contextValue === 'function' ? contextValue : () => contextValue;
    const fixedContext = typeof contextValue === 'function' ? undefined : normalizeContext(contextValue);
    const eventId = boundedText(eventIdValue, MAX_EVENT_ID_LENGTH);
    if (!eventId) throw new BadRequestException('采购卡片事件标识无效');
    const validateIdentity = (context: PurchaseBatchFulfillmentCommandContext) => {
      if (
        context.approvalBatchId !== identity.approvalBatchId ||
        context.actorOpenId !== identity.actorOpenId ||
        (context.action === 'order' && identity.role !== 'purchaser') ||
        (context.action === 'receipt' && identity.role !== 'requester')
      ) {
        throw new ConflictException('采购履约卡片命令身份不匹配');
      }
    };
    if (fixedContext) validateIdentity(fixedContext);
    return this.enqueueCard(async () => {
      const readStartedAt = Date.now();
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const readFinishedAt = Date.now();
      const { batch } = requirePurchaseBatchFulfillmentSource(ledger, identity);
      const context = fixedContext || normalizeContext(createContext(structuredClone(batch)));
      validateIdentity(context);
      let writeMs = 0;
      const result = (claimed: boolean, entry: PurchaseWorkflowNotificationEntry) => ({
        claimed, entry, batch,
        fulfillmentNotifications: structuredClone(ledger.notifications.filter((notification) =>
          batch.recordIds.includes(notification.recordId) &&
          ['manager_batch_order_command', 'manager_batch_receipt_command', 'web_receipt_command'].includes(notification.kind),
        )),
        timing: {
          queueMs: Math.max(0, readStartedAt - startedAt),
          readMs: Math.max(0, readFinishedAt - readStartedAt),
          decisionMs: Math.max(0, Date.now() - readFinishedAt - writeMs),
          writeMs,
        },
      });
      const item = batch.items.find(
        (candidate) =>
          candidate.executionRecordId === context.executionRecordId,
      );
      if (!item || item.status !== 'approved') {
        throw new ConflictException('采购履约明细不可处理');
      }
      if (context.action === 'order' && item.executorHandover && (!item.executorHandover.ready || item.executorHandover.supersededMessageIds.includes(identity.messageId))) throw new ConflictException('采购原执行卡职责已转交');
      if (
        (context.action === 'order' &&
          item.purchaserOpenId !== identity.actorOpenId) ||
        (context.action === 'receipt' &&
          batch.requesterOpenId !== identity.actorOpenId)
      ) {
        throw new ConflictException('采购履约卡片操作者身份不匹配');
      }
      if (batch.flowVersion === 'lifecycle_v1' || batch.stageCardTransition) {
        if (!authorize) throw new ForbiddenException('采购全流程卡片缺少当前职责校验');
        assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batch), structuredClone(item)));
      }
      if (batch.flowVersion === 'lifecycle_v1') consumeLifecycleFormCredential(ledger, identity, { action: context.action === 'order' ? 'submit_order' : 'submit_receipt', role: identity.role, approvalBatchId: identity.approvalBatchId, executionRecordId: context.executionRecordId, flowVersion: 'lifecycle_v1', cardRevision: identity.lifecycle!.cardRevision }, eventId, resolveNow(now).getTime());
      const kind =
        context.action === 'order'
          ? 'manager_batch_order_command'
          : 'manager_batch_receipt_command';
      const input: PurchaseWorkflowNotificationInput = {
        businessEventId: `${kind}:${eventId}`,
        recordId: context.executionRecordId,
        recipientOpenId: identity.actorOpenId,
        kind,
        cardContext: serializePurchaseBatchFulfillmentCommandContext(context),
      };
      const normalizedInput = normalizeNotificationInput(input);
      const existingForEvent = ledger.notifications.find(
        (entry) => entry.key === notificationKey(normalizedInput),
      );
      if (existingForEvent) {
        if ((batch.flowVersion === 'lifecycle_v1' || batch.stageCardTransition) && existingForEvent.cardContext !== normalizedInput.cardContext) throw new ConflictException('采购卡片事件与已有任务内容不一致');
        return result(false, existingForEvent);
      }
      const existingForRecord = ledger.notifications.find(
        (entry) =>
          entry.kind === kind &&
          entry.recordId === context.executionRecordId &&
          entry.status !== 'failed',
      );
      if (existingForRecord) {
        return result(false, existingForRecord);
      }
      if (ledger.commands.some(command => command.recordId === context.executionRecordId && command.action === (context.action === 'order' ? 'order' : 'receive'))) throw new ConflictException('该采购记录已有平台办理任务，请核对原任务');
      if (context.action === 'receipt' && ledger.notifications.some(task => task.kind === 'web_receipt_command' && task.recordId === context.executionRecordId)) throw new ConflictException('该采购记录已有网页签收任务，请查看原任务');
      if (
        ledger.notifications.filter((entry) => isActiveStatus(entry.status))
          .length >= MAX_NOTIFICATIONS
      ) {
        throw new ServiceUnavailableException(
          '采购通知任务队列已满，请稍后重试',
        );
      }
      if (batch.flowVersion !== 'lifecycle_v1' && !batch.stageCardTransition) authorize?.(structuredClone(batch),structuredClone(item));
      const entry = createNotificationEntry(normalizedInput, timestamp);
      const appId=process.env.FEISHU_APP_ID?.trim();
      if(authorize&&appId&&/^cli_[A-Za-z0-9_-]+$/.test(appId))entry.acceptedAppId=appId;
      ledger.notifications.push(entry);
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      const writeStartedAt = Date.now();
      await this.write(ledger);
      writeMs = Math.max(0, Date.now() - writeStartedAt);
      return result(true, entry);
    });
  }

  async bindLegacyFulfillmentApplication(proof:PurchaseFulfillmentClaimProof,record:PurchaseWorkflowRecord,expectedAppId:string):Promise<void>{
    await this.enqueue(async()=>{
      const appId=process.env.FEISHU_APP_ID?.trim(),ledger=await this.read(),notification=ledger.notifications.find(entry=>entry.key===proof.notificationKey);
      if(!appId||appId!==expectedAppId||!/^cli_[A-Za-z0-9_-]+$/.test(appId)||!notification||!isPurchaseBatchFulfillmentCommandKind(notification.kind)||notification.acceptedAppId&&notification.acceptedAppId!==appId)throw new ConflictException('原采购命令应用身份未核对');
      assertClaimOwnership(notification,proof.claimToken);
      const context=parsePurchaseBatchFulfillmentCommandContext(notification.cardContext),batch=ledger.managerApprovalBatches.find(entry=>entry.approvalBatchId===context.approvalBatchId);
      if(!batch||notification.kind!==(context.action==='order'?'manager_batch_order_command':'manager_batch_receipt_command')||record.recordId!==notification.recordId||context.executionRecordId!==record.recordId||notification.recipientOpenId!==context.actorOpenId||
        (context.action==='order'?record.purchaserOpenId:record.requesterOpenId)!==context.actorOpenId||parsePurchaseManagerBatchApprovalCardContext(batch.cardContext).building!==record.building)throw new ConflictException('原采购命令应用身份与原记录人员、楼栋未核对');
      if(notification.acceptedAppId)return;
      notification.acceptedAppId=appId;await this.write(ledger);
    });
  }

  async readAcceptedFulfillmentCommand(proof:PurchaseFulfillmentClaimProof,recordId:string,action:PurchaseWorkflowAction,actorOpenId:string):Promise<PurchaseAcceptedFulfillment>{
    return this.enqueueRead(async()=>structuredClone(requireAcceptedFulfillment(await this.read(),proof,{recordId,action,actorOpenId})));
  }

  async completePurchaseBatchFulfillmentCommandAndEnqueue(
    keyValue: string,
    claimToken: string,
    inputs: PurchaseWorkflowNotificationInput[],
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const key = clean(keyValue);
      const index = ledger.notifications.findIndex(
        (entry) => entry.key === key,
      );
      const current = ledger.notifications[index];
      if (index < 0 || !current) {
        throw new ConflictException('采购履约后台命令不存在');
      }
      assertClaimOwnership(current, claimToken);
      if (!isPurchaseBatchFulfillmentCommandKind(current.kind)) {
        throw new ConflictException('采购履约后台命令类型无效');
      }
      const completed: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'completed',
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
      };
      ledger.notifications[index] = completed;
      const migrated = ledger.managerApprovalBatches.find(row => row.recordIds.includes(current.recordId) && row.stageCardTransition);
      for (const value of inputs.map(normalizeNotificationInput)) {
        if (migrated && value.kind === 'manager_batch_receipt_requested' &&
            ledger.notifications.some(entry => isCanonicalStageReceipt(entry, migrated, migrated.approvalBatchId) &&
              entry.recipientOpenId === value.recipientOpenId)) continue;
        const notificationKeyValue = notificationKey(value);
        const existing = ledger.notifications.find(
          (entry) => entry.key === notificationKeyValue,
        );
        if (existing) {
          if (
            existing.kind !== value.kind ||
            existing.cardContext !== (value.cardContext || '')
          ) {
            throw new ConflictException('采购履约状态通知冲突');
          }
          continue;
        }
        ledger.notifications.push(createNotificationEntry(value, timestamp));
      }
      if (current.kind === 'manager_batch_order_command') {
        const order = ledger.commands.find(command => command.recordId === current.recordId && command.action === 'order' && command.completedAt && command.orderNotice?.deferUntilFulfillment);
        if (order?.orderNotice) {
          // Only suppress recipients whose card update or receipt intent is committed in this transaction.
          const cardRecipients = new Set(inputs.filter(input => ['manager_batch_receipt_requested', 'manager_batch_receipt_refresh', 'manager_batch_purchase_refresh'].includes(input.kind)).map(input => input.recipientOpenId));
          order.orderNotice = { ...order.orderNotice, deferUntilFulfillment: false,
            recipientOpenIds: order.orderNotice.recipientOpenIds.filter(id => !cardRecipients.has(id)) };
          enqueuePurchaseOrderNotices(ledger, order);
        }
      }
      const matchingBatches = ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(current.recordId));
      if (matchingBatches.some(batch => batch.flowVersion === 'lifecycle_v1')) {
        if (matchingBatches.length !== 1) throw new ConflictException('采购履约明细所属批次不唯一');
        const batch = matchingBatches[0]!;
        const context = parsePurchaseBatchFulfillmentCommandContext(current.cardContext);
        if (context.approvalBatchId !== batch.approvalBatchId || context.executionRecordId !== current.recordId) throw new ConflictException('采购履约命令与批次不一致');
        queueExistingLifecycleBatchRefresh(ledger, batch);
      }
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return completed;
    });
  }

  async failPurchaseBatchFulfillmentCommandAndEnqueueRefresh(
    keyValue: string,
    claimToken: string,
    error: unknown,
    refreshValue: PurchaseWorkflowNotificationInput,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const key = clean(keyValue);
      const index = ledger.notifications.findIndex(
        (entry) => entry.key === key,
      );
      const current = ledger.notifications[index];
      if (index < 0 || !current) {
        throw new ConflictException('采购履约后台命令不存在');
      }
      assertClaimOwnership(current, claimToken);
      if (!isPurchaseBatchFulfillmentCommandKind(current.kind)) {
        throw new ConflictException('采购履约后台命令类型无效');
      }
      const failed: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'failed',
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: sanitizeError(error),
      };
      ledger.notifications[index] = failed;
      const refresh = normalizeNotificationInput(refreshValue);
      const refreshKey = notificationKey(refresh);
      const existing = ledger.notifications.find(
        (entry) => entry.key === refreshKey,
      );
      if (existing) {
        if (
          existing.kind !== refresh.kind ||
          existing.cardContext !== (refresh.cardContext || '')
        ) {
          throw new ConflictException('采购履约失败状态通知冲突');
        }
      } else {
        ledger.notifications.push(createNotificationEntry(refresh, timestamp));
      }
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return failed;
    });
  }

  async stagePurchaseBatchAttachments(
    input: {
      approvalBatchId: string;
      executionRecordId: string;
      actorOpenId: string;
      purpose: 'payment' | 'receipt';
      paymentAttachmentTokens?: string[];
      receiptPhotoTokens?: string[];
      invoiceTokens?: string[];
    },
    now: Date | number = new Date(),
  ): Promise<PurchaseManagerApprovalBatchEntry> {
    const approvalBatchId = normalizeManagerApprovalBatchId(
      input.approvalBatchId,
    );
    const executionRecordId = normalizeRecordId(input.executionRecordId);
    const actorOpenId = boundedText(input.actorOpenId, MAX_OPEN_ID_LENGTH);
    if (!OPEN_ID_PATTERN.test(actorOpenId)) {
      throw new BadRequestException('采购附件上传身份无效');
    }
    return this.enqueue(async () => {
      const ledger = await this.read();
      const batch = ledger.managerApprovalBatches.find(
        (entry) => entry.approvalBatchId === approvalBatchId,
      );
      const item = batch?.items.find(
        (candidate) => candidate.executionRecordId === executionRecordId,
      );
      if (!batch || !item || item.status !== 'approved') {
        throw new ConflictException('采购附件明细不可处理');
      }
      if (input.purpose === 'payment' && item.executorHandover && !item.executorHandover.ready) throw new ConflictException('采购职责正在交接，请稍后上传');
      if (
        (input.purpose === 'payment' && item.purchaserOpenId !== actorOpenId) ||
        (input.purpose === 'receipt' && batch.requesterOpenId !== actorOpenId)
      ) {
        throw new ConflictException('采购附件上传身份不匹配');
      }
      const updated: PurchaseManagerApprovalBatchEntry = {
        ...batch,
        items: batch.items.map((candidate) =>
          candidate.executionRecordId === executionRecordId
            ? {
                ...candidate,
                paymentAttachmentTokens:
                  input.purpose === 'payment'
                    ? mergeAttachmentTokens(
                        candidate.paymentAttachmentTokens,
                        input.paymentAttachmentTokens,
                      )
                    : candidate.paymentAttachmentTokens,
                receiptPhotoTokens:
                  input.purpose === 'receipt'
                    ? mergeAttachmentTokens(
                        candidate.receiptPhotoTokens,
                        input.receiptPhotoTokens,
                      )
                    : candidate.receiptPhotoTokens,
                invoiceTokens:
                  input.purpose === 'receipt'
                    ? mergeAttachmentTokens(
                        candidate.invoiceTokens,
                        input.invoiceTokens,
                      )
                    : candidate.invoiceTokens,
              }
            : candidate,
        ),
        revision: batch.revision + 1,
        updatedAt: resolveNow(now).toISOString(),
      };
      replaceManagerApprovalBatch(ledger, updated);
      await this.write(ledger);
      return updated;
    });
  }

  async enqueueNotification(
    input: PurchaseWorkflowNotificationInput,
    now: Date | number = new Date(),
  ): Promise<{
    enqueued: boolean;
    entry: PurchaseWorkflowNotificationEntry;
  }> {
    const [result] = await this.enqueueNotifications([input], now);
    if (!result) throw new Error('Notification enqueue failed');
    return result;
  }

  async enqueueNotifications(
    inputs: PurchaseWorkflowNotificationInput[],
    now: Date | number = new Date(),
  ): Promise<
    Array<{
      enqueued: boolean;
      entry: PurchaseWorkflowNotificationEntry;
    }>
  > {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const normalizedInputs = inputs.map(normalizeNotificationInput);
      const ledger = await this.read();
      let changed = false;
      const results = normalizedInputs.map((input) => {
        if (input.kind === 'warehouse_inbound') {
          input = { ...input, recipientOpenId: resolveWarehouseInboundRecipient(ledger.warehouseInboundHandovers, input.recordId, input.recipientOpenId) };
          const transition = ledger.managerApprovalBatches.find(batch => batch.recordIds.includes(input.recordId))?.stageCardTransition;
          if (transition) {
            const separate = ledger.notifications.find(row => row.kind === 'warehouse_inbound' && row.recordId === input.recordId &&
              row.recipientOpenId === input.recipientOpenId && retainedStageNotification(row, transition));
            if (separate) return { enqueued: false, entry: separate };
            input = { ...input, businessEventId: 'warehouse-inbound:' + input.recordId + ':stage-cards' };
          }
        }
        const key = notificationKey(input);
        const existing = ledger.notifications.find(
          (entry) => entry.key === key,
        );
        if (existing) {
          if (
            existing.kind !== input.kind ||
            (isManualInboundNotificationKind(input.kind) &&
              existing.cardContext !== (input.cardContext || '')) ||
            (input.cardContext &&
              existing.cardContext &&
              existing.cardContext !== input.cardContext)
          ) {
            throw new ConflictException('采购通知任务与已有任务冲突');
          }
          if (
            input.cardContext &&
            !existing.cardContext &&
            existing.status === 'pending'
          ) {
            existing.cardContext = input.cardContext;
            changed = true;
          }
          return { enqueued: false, entry: existing };
        }
        if (input.kind === 'manager_approval_requested' && (ledger.platformLegacyApprovalClaims || []).some(claim => claim.recordId === input.recordId)) throw new ConflictException('采购明细已有平台审批任务');
        if (
          ledger.notifications.filter((entry) => isActiveStatus(entry.status))
            .length >= MAX_NOTIFICATIONS
        ) {
          throw new ServiceUnavailableException(
            '采购通知任务队列已满，请稍后重试',
          );
        }

        const entry = createNotificationEntry(input, timestamp);
        ledger.notifications.push(entry);
        changed = true;
        return { enqueued: true, entry };
      });
      if (changed) {
        ledger.notifications = trimNotificationHistory(
          ledger.notifications,
          MAX_NOTIFICATIONS,
        );
        await this.write(ledger);
      }
      return results;
    });
  }

  webReceiptSpoolDirectory(): string {
    return `${this.ledgerPath}.receipt-files`;
  }

  async findWebReceipt(taskId: string): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.enqueueRead(async () => structuredClone((await this.read()).notifications.find(entry => entry.kind === 'web_receipt_command' && entry.webReceipt?.taskId === taskId) || null));
  }

  async acceptWebReceipt(recordId: string, value: PurchaseWebReceiptCommand, authorize: () => void): Promise<PurchaseWorkflowNotificationEntry> {
    const payload = normalizeWebReceiptCommand(value);
    if (!RECORD_ID_PATTERN.test(recordId) || payload.recordId !== recordId) throw new BadRequestException('采购记录标识无效');
    return this.enqueue(async () => {
      const ledger = await this.read();
      const existing = ledger.notifications.find(entry => entry.webReceipt?.taskId === payload.taskId);
      if (existing) {
        if (existing.recordId !== recordId || existing.webReceipt?.fingerprint !== payload.fingerprint) throw new ConflictException('签收提交标识已用于其他内容');
        return structuredClone(existing);
      }
      if (ledger.commands.some(entry => entry.recordId === recordId && entry.action === 'receive') || ledger.notifications.some(entry => entry.recordId === recordId && (entry.kind === 'web_receipt_command' || entry.kind === 'manager_batch_receipt_command' && entry.status !== 'failed'))) throw new ConflictException('该采购记录已有正式签收任务，请查看原任务');
      if (ledger.notifications.filter(entry => isActiveStatus(entry.status)).length >= MAX_NOTIFICATIONS) throw new ServiceUnavailableException('采购后台任务已满，请稍后重试');
      assertSynchronousLifecycleAuthorization(authorize);
      const entry = { ...createNotificationEntry({ businessEventId: payload.taskId, recordId, recipientOpenId: payload.actor.openId, kind: 'web_receipt_command' }, new Date().toISOString()), webReceipt: payload };
      enqueueWebReceiptCardRefresh(ledger, entry);
      ledger.notifications = trimNotificationHistory([...ledger.notifications, entry], MAX_NOTIFICATIONS);
      await this.write(ledger);
      return structuredClone(entry);
    });
  }

  async updateWebReceipt(key: string, claimToken: string, change: (payload: PurchaseWebReceiptCommand) => void): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.updateNotification(key, claimToken, entry => {
      if (entry.kind !== 'web_receipt_command' || !entry.webReceipt) throw new ConflictException('原网页签收任务不存在');
      const payload = structuredClone(entry.webReceipt);
      change(payload);
      const normalized = normalizeWebReceiptCommand(payload);
      if (normalized.fingerprint !== entry.webReceipt.fingerprint) throw new ConflictException('原网页签收内容不可替换');
      return { ...entry, webReceipt: normalized, updatedAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 10 * 60_000).toISOString() };
    });
  }

  async markWebReceiptFilesRemoved(taskId: string): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read(), entry = ledger.notifications.find(task => task.webReceipt?.taskId === taskId);
      if (!entry?.webReceipt || entry.status !== 'completed') throw new ConflictException('签收任务尚未完成');
      if (entry.webReceipt.filesRemoved) return;
      entry.webReceipt.filesRemoved = true;
      await this.write(ledger);
    });
  }
  async recoverWebReceipt(input:PersonnelRecoveryRequest,actor:PersonnelRecoveryActor,authorize:()=>void):Promise<PurchaseWorkflowNotificationEntry>{
    assertRecoveryRequest(input);
    if(input.module!=='purchase')throw new BadRequestException('签收恢复类型无效');
    return this.enqueue(async()=>{
      const ledger=await this.read(),task=ledger.notifications.find(entry=>entry.kind==='web_receipt_command'&&entry.webReceipt?.taskId===input.taskId),payload=task?.webReceipt;
      if(!task||!payload||payload.appId!==process.env.FEISHU_APP_ID?.trim())throw new ConflictException('原签收任务或应用身份已变化');
      authorize();
      const replay=payload.recoveries?.find(audit=>audit.clientMutationId===input.clientMutationId);
      if(replay){if(replay.previousVersion!==input.expectedVersion||replay.actorId!==actor.id)throw new ConflictException('签收恢复重复请求内容不一致');return structuredClone(task);}
      if(['pending','processing','completed'].includes(task.status))return structuredClone(task);
      if(task.status!=='failed'||payload.filesRemoved||webReceiptRecoveryVersion(task)!==input.expectedVersion)throw new ConflictException('签收任务状态已变化，请更新后核对');
      if((payload.recoveries?.length||0)>=20)throw new ConflictException('原签收已多次恢复，请先核对持续失败原因');
      if(payload.files.some(file=>!file.token)&&ledger.commands.some(command=>command.recordId===task.recordId&&command.action==='receive'))throw new ConflictException('签收附件与已受理业务命令不一致，请先核对');
      if(payload.files.some(file=>!file.token && !!file.uploadStartedAt))throw new ConflictException('签收附件上传结果待核对，不能直接重新上传');
      payload.recoveries=[...(payload.recoveries||[]),{clientMutationId:input.clientMutationId,previousVersion:input.expectedVersion,actorId:actor.id,actorName:actor.name,authorizationVersion:actor.authorizationVersion,requestedAt:new Date().toISOString()}];
      normalizeWebReceiptCommand(payload);
      Object.assign(task,{status:'pending',nextAttemptAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastError:'',completedAt:'',claimToken:'',leaseUntil:''});
      enqueueWebReceiptCardRefresh(ledger,task);
      await this.write(ledger);return structuredClone(task);
    });
  }

  async takeNextNotification(
    now: Date | number = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
    allowedKinds?: readonly PurchaseWorkflowNotificationKind[],
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const allowedKindSet = allowedKinds ? new Set(allowedKinds) : null;
      const snapshots = new Map<string, InboundCompletionSnapshot>();
      // Never turn an already completed success card back into a send task.
      // Legacy late-added recipients lack the sealed cohort proof and require review.
      let quarantined = false;
      ledger.notifications = ledger.notifications.map(entry => {
        if ((!allowedKindSet || allowedKindSet.has(entry.kind)) && isInboundCompletedDeliveryKind(entry.kind) &&
          isAvailable(entry, timestamp) && inboundDeliveryGate(entry, ledger.notifications, snapshots) === 'unproven') {
          quarantined = true;
          return quarantineUnprovenInbound(entry, timestamp.toISOString());
        }
        return entry;
      });
      if (quarantined) await this.write(ledger);
      const expiredIndex = ledger.notifications.findIndex(
        (entry) =>
          (!allowedKindSet || allowedKindSet.has(entry.kind)) &&
          (entry.kind !== 'web_receipt_command' || allowedKindSet?.has(entry.kind)) &&
          (isIdempotentInventoryNotificationKind(entry.kind) || entry.kind === 'purchase_order_completed') &&
          isAvailable(entry, timestamp) &&
          isUnknownInboundCompletedDeliveryExpired(entry, timestamp),
      );
      if (expiredIndex >= 0) {
        const expired = ledger.notifications[expiredIndex];
        if (expired) {
          const completedAt = timestamp.toISOString();
          const manualNotification: PurchaseWorkflowNotificationEntry = {
            ...expired,
            status: 'manual_reconciliation',
            updatedAt: completedAt,
            leaseUntil: '',
            claimToken: '',
            completedAt,
            lastError: expired.kind === 'purchase_order_completed'
              ? '下单通知发送结果超过安全窗口仍不明确，已停止自动重发并等待人工核对'
              : expired.kind === 'warehouse_inbound'
              ? '待入库提醒发送结果超过一小时仍不明确，已停止自动重发并等待人工核对'
              : '入库成功卡发送结果超过一小时仍不明确，已停止自动重发并等待人工核对',
            sendOutcome: 'manual_reconciliation',
          };
          ledger.notifications.splice(expiredIndex, 1);
          ledger.notifications.push(manualNotification);
          ledger.notifications = trimNotificationHistory(
            ledger.notifications,
            MAX_NOTIFICATIONS,
          );
          await this.write(ledger);
        }
      }
      const index = ledger.notifications.findIndex(
        (entry) =>
          (!allowedKindSet || allowedKindSet.has(entry.kind)) &&
          !isManagerNotificationKind(entry.kind) &&
          (entry.kind !== 'web_receipt_command' || allowedKindSet?.has(entry.kind)) &&
          !ledger.warehouseInboundHandovers.some(job => job.notificationKey === entry.key && job.status !== 'completed') &&
          isAvailable(entry, timestamp) &&
          inboundDeliveryGate(entry, ledger.notifications, snapshots) !== 'waiting',
      );
      if (index < 0) return null;

      const current = ledger.notifications[index];
      if (!current) return null;
      const updated: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'processing',
        attempts: Math.min(current.attempts + 1, 1_000_000),
        updatedAt: timestamp.toISOString(),
        leaseUntil: new Date(
          timestamp.getTime() + normalizeLeaseMs(leaseMs),
        ).toISOString(),
        claimToken: randomUUID(),
      };
      ledger.notifications[index] = updated;
      await this.write(ledger);
      return updated;
    });
  }

  async takeNextManagerApprovalNotification(
    now: Date | number = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
    preferInitialApproval = false,
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const expiredIndex = ledger.notifications.findIndex(
        (entry) =>
          isManagerNotificationKind(entry.kind) &&
          isAvailable(entry, timestamp) &&
          isUnknownManagerDeliveryExpired(entry, timestamp),
      );
      if (expiredIndex >= 0) {
        const entry = ledger.notifications[expiredIndex];
        if (!entry) return null;
        const updatedAt = timestamp.toISOString();
        const manualNotification: PurchaseWorkflowNotificationEntry = {
          ...entry,
          status: 'manual_reconciliation',
          updatedAt,
          leaseUntil: '',
          claimToken: '',
          completedAt: updatedAt,
          lastError: '经理审批卡发送结果超过一小时仍不明确，已转人工核对',
          sendOutcome: 'manual_reconciliation',
          deliveryAudit: appendDeliveryAudit(entry.deliveryAudit, {
            action: 'delivery_unknown_timeout',
            at: updatedAt,
            operatorOpenId: '',
            generation: entry.deliveryGeneration,
            deliveryUuid: entry.deliveryUuid,
            messageId: '',
          }),
        };
        ledger.notifications[expiredIndex] = manualNotification;
        if (entry.kind === 'manager_approval_reopened') {
          const action = ledger.managerApprovalActions.find(
            (candidate) =>
              candidate.recordId === entry.recordId &&
              candidate.status === 'failed' &&
              entry.businessEventId ===
                `manager_approval_reopened:${candidate.eventId}`,
          );
          const card = ledger.managerApprovalCards.find(
            (candidate) =>
              candidate.key ===
                managerApprovalCardKey(entry.recordId, entry.recipientOpenId) &&
              candidate.messageId === entry.messageId &&
              candidate.cardContext === entry.cardContext,
          );
          if (!action || !card) {
            throw new ConflictException(
              '经理审批替代卡未知送达缺少对应动作或活动卡片',
            );
          }
          const lockedCard: PurchaseManagerApprovalCardEntry = {
            ...card,
            state: 'manual_reconciliation',
            choice: action.choice,
            rejectionReasonDraft: action.rejectionReason,
            actionEventId: action.eventId,
            actorOpenId: action.actorOpenId,
            processedAt: updatedAt,
            updatedAt,
            resolvedAt: '',
          };
          replaceManagerApprovalCard(ledger, lockedCard);
          enqueueManagerApprovalStateNotification(
            ledger,
            action,
            lockedCard,
            'manager_approval_attention_required',
            updatedAt,
            entry.deliveryGeneration,
          );
        }
        ledger.notifications = trimNotificationHistory(
          ledger.notifications,
          MAX_NOTIFICATIONS,
        );
        await this.write(ledger);
        return manualNotification;
      }
      const initialIndex = preferInitialApproval ? ledger.notifications.findIndex(
        (entry) =>
          (entry.kind === 'manager_approval_requested' ||
            entry.kind === 'manager_batch_approval_requested') &&
          entry.status === 'pending' && entry.attempts === 0 &&
          isAvailable(entry, timestamp),
      ) : -1;
      const index = initialIndex >= 0 ? initialIndex : ledger.notifications.findIndex(
        (entry) =>
          isManagerNotificationKind(entry.kind) &&
          entry.status !== 'manual_reconciliation' &&
          isAvailable(entry, timestamp),
      );
      if (index < 0) {
        return null;
      }

      const current = ledger.notifications[index];
      if (!current) return null;
      const updated: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'processing',
        attempts: Math.min(current.attempts + 1, 1_000_000),
        updatedAt: timestamp.toISOString(),
        leaseUntil: new Date(
          timestamp.getTime() + normalizeLeaseMs(leaseMs),
        ).toISOString(),
        claimToken: randomUUID(),
      };
      ledger.notifications[index] = updated;
      await this.write(ledger);
      return updated;
    });
  }

  async markManagerApprovalSendStarted(
    key: string,
    claimToken: string,
    cardContext: string,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    const canonicalContext = canonicalManagerCardContext(cardContext);
    const claimCheckStarted = Date.now(), claimCheckNow = resolveNow(now).getTime();
    return this.updateNotification(key, claimToken, (entry) => {
      if (!Number.isFinite(Date.parse(entry.leaseUntil)) || Date.parse(entry.leaseUntil) <= claimCheckNow + Date.now() - claimCheckStarted) throw new ConflictException('采购审批发卡租约已过期，请重试原通知任务');
      if (
        entry.kind !== 'manager_approval_requested' &&
        entry.kind !== 'manager_approval_reopened'
      ) {
        throw new ConflictException('经理审批通知类型不支持发卡');
      }
      if (entry.sendOutcome === 'manual_reconciliation') {
        throw new ConflictException('经理审批卡发送结果需人工核对');
      }
      if (entry.cardContext && entry.cardContext !== canonicalContext) {
        throw new ConflictException('经理审批卡上下文与首次发送不一致');
      }
      const startedAt =
        entry.firstSendAttemptAt || resolveNow(now).toISOString();
      const alreadyAudited = entry.deliveryAudit.some(
        (audit) =>
          audit.action === 'send_started' &&
          audit.generation === entry.deliveryGeneration,
      );
      return {
        ...entry,
        updatedAt: resolveNow(now).toISOString(),
        firstSendAttemptAt: startedAt,
        sendOutcome: 'unknown',
        cardContext: canonicalContext,
        deliveryAudit: alreadyAudited
          ? entry.deliveryAudit
          : appendDeliveryAudit(entry.deliveryAudit, {
              action: 'send_started',
              at: startedAt,
              operatorOpenId: '',
              generation: entry.deliveryGeneration,
              deliveryUuid: entry.deliveryUuid,
              messageId: '',
            }),
      };
    });
  }

  async markInboundCompletedSendStarted(
    key: string,
    claimToken: string,
    now: Date | number = new Date(),
    isCurrentlyAuthorized?: () => boolean,
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.updateNotification(key, claimToken, (entry, ledger) => {
      if (!isIdempotentInventoryNotificationKind(entry.kind)) {
        throw new ConflictException('入库通知类型不支持发卡');
      }
      if (entry.sendOutcome === 'manual_reconciliation') {
        throw new ConflictException('入库完成卡发送结果需人工核对');
      }
      const proof = inboundDeliveryGate(entry, ledger.notifications);
      if (proof === 'waiting') throw new ConflictException('入库通知收件人快照尚未完成，请等待原解析任务');
      if (proof === 'unproven') return quarantineUnprovenInbound(entry, resolveNow(now).toISOString());
      if (entry.kind === 'warehouse_inbound' && ledger.warehouseInboundHandovers.some(job => job.notificationKey === entry.key)) {
        if (!isCurrentlyAuthorized || isCurrentlyAuthorized() !== true) throw new ForbiddenException('接任者当前不可接收业务提醒');
      }
      const timestamp = resolveNow(now).toISOString();
      return {
        ...entry,
        updatedAt: timestamp,
        firstSendAttemptAt: entry.firstSendAttemptAt || timestamp,
        sendOutcome: 'unknown',
      };
    });
  }

  async markPurchaseOrderNoticeSendStarted(key: string, claimToken: string, now: Date | number = new Date()): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.updateNotification(key, claimToken, entry => {
      if (entry.kind !== 'purchase_order_completed' || entry.sendOutcome === 'manual_reconciliation' || isUnknownInboundCompletedDeliveryExpired(entry, resolveNow(now))) {
        throw new ConflictException('下单通知发送结果需核对');
      }
      const timestamp = resolveNow(now).toISOString();
      return { ...entry, updatedAt: timestamp, firstSendAttemptAt: entry.firstSendAttemptAt || timestamp, sendOutcome: 'unknown' };
    });
  }

  async completeManagerApprovalRequestAndRegisterCard(
    key: string,
    claimToken: string,
    delivery: PurchaseWorkflowNotificationDelivery & { messageId: string },
    now: Date | number = new Date(),
  ): Promise<{
    notification: PurchaseWorkflowNotificationEntry;
    card: PurchaseManagerApprovalCardEntry;
  }> {
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const ledger = await this.read();
      const index = ledger.notifications.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      if (index < 0) {
        throw new ConflictException('经理审批发卡通知不存在');
      }
      const current = ledger.notifications[index];
      if (!current) {
        throw new ConflictException('经理审批发卡通知不存在');
      }
      assertClaimOwnership(current, claimToken);
      if (
        current.kind !== 'manager_approval_requested' ||
        current.sendOutcome !== 'unknown' ||
        !current.firstSendAttemptAt ||
        !current.cardContext
      ) {
        throw new ConflictException('经理审批发卡通知状态不允许完成');
      }
      const messageId = requiredDeliveryId(delivery?.messageId);
      const timestamp = resolveNow(now).toISOString();
      const notification: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'completed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
        deliveryId:
          boundedText(delivery?.deliveryId, MAX_DELIVERY_ID_LENGTH) ||
          current.deliveryId,
        messageId,
        sendOutcome: 'delivered',
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'send_delivered',
          at: timestamp,
          operatorOpenId: '',
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId,
        }),
      };
      const card = registerManagerApprovalCard(
        ledger,
        notification,
        messageId,
        timestamp,
      );
      ledger.notifications[index] = notification;
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      ledger.managerApprovalCards = pruneResolvedManagerApprovalCards(
        ledger.managerApprovalCards,
        resolveNow(now),
        ledger.notifications,
      );
      await this.write(ledger);
      return { notification, card };
    });
  }

  async resolveUnknownManagerApprovalDelivery(
    key: string,
    input: {
      resolution: 'verified_delivered' | 'verified_absent';
      operatorOpenId: string;
      messageId?: string;
    },
    now: Date | number = new Date(),
  ): Promise<{
    notification: PurchaseWorkflowNotificationEntry;
    card: PurchaseManagerApprovalCardEntry | null;
  }> {
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const operatorOpenId = boundedText(
        input?.operatorOpenId,
        MAX_OPEN_ID_LENGTH,
      );
      if (!OPEN_ID_PATTERN.test(operatorOpenId)) {
        throw new Error('Invalid manager delivery resolution operator');
      }
      const ledger = await this.read();
      const index = ledger.notifications.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      if (index < 0) {
        throw new ConflictException('经理审批未知送达任务不存在');
      }
      const current = ledger.notifications[index];
      if (
        !current ||
        (current.kind !== 'manager_approval_requested' &&
          current.kind !== 'manager_approval_reopened') ||
        current.status !== 'manual_reconciliation' ||
        current.sendOutcome !== 'manual_reconciliation'
      ) {
        throw new ConflictException('经理审批送达状态不允许人工解除');
      }
      const timestamp = resolveNow(now).toISOString();
      if (input.resolution === 'verified_delivered') {
        const messageId = requiredDeliveryId(input.messageId);
        if (current.kind === 'manager_approval_reopened') {
          const resolved = completeManualReopenedManagerApprovalDelivery(
            ledger,
            current,
            messageId,
            operatorOpenId,
            'operator_verified_delivered',
            timestamp,
          );
          ledger.notifications = trimNotificationHistory(
            ledger.notifications,
            MAX_NOTIFICATIONS,
          );
          await this.write(ledger);
          return resolved;
        }
        const notification: PurchaseWorkflowNotificationEntry = {
          ...current,
          status: 'completed',
          updatedAt: timestamp,
          nextAttemptAt: timestamp,
          leaseUntil: '',
          claimToken: '',
          completedAt: timestamp,
          lastError: '',
          messageId,
          sendOutcome: 'delivered',
          deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
            action: 'operator_verified_delivered',
            at: timestamp,
            operatorOpenId,
            generation: current.deliveryGeneration,
            deliveryUuid: current.deliveryUuid,
            messageId,
          }),
        };
        const card = registerManagerApprovalCard(
          ledger,
          notification,
          messageId,
          timestamp,
        );
        ledger.notifications[index] = notification;
        await this.write(ledger);
        return { notification, card };
      }
      if (input.resolution !== 'verified_absent') {
        throw new Error('Invalid manager delivery resolution');
      }
      const nextGeneration = current.deliveryGeneration + 1;
      const reopened =
        current.kind === 'manager_approval_reopened'
          ? requireManualReopenedManagerApprovalRecovery(ledger, current)
          : null;
      const updated: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'pending',
        attempts: 0,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
        deliveryId: '',
        messageId: reopened ? current.messageId : '',
        deliveryUuid: stableManagerDeliveryUuid(current.key, nextGeneration),
        firstSendAttemptAt: '',
        sendOutcome: 'unattempted',
        deliveryGeneration: nextGeneration,
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'operator_verified_absent',
          at: timestamp,
          operatorOpenId,
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId: '',
        }),
      };
      ledger.notifications[index] = updated;
      if (reopened) {
        const card = restoreReopenedManagerApprovalCard(
          reopened.card,
          reopened.action,
          timestamp,
        );
        replaceManagerApprovalCard(ledger, card);
        completeManagerApprovalAttentionNotification(
          ledger,
          reopened.action,
          current.deliveryGeneration,
          timestamp,
        );
        ledger.notifications = trimNotificationHistory(
          ledger.notifications,
          MAX_NOTIFICATIONS,
        );
        await this.write(ledger);
        return { notification: updated, card };
      }
      await this.write(ledger);
      return { notification: updated, card: null };
    });
  }

  async bindUnknownManagerApprovalDeliveryFromCallback(
    input: PurchaseManagerApprovalCallbackBindingInput,
    now: Date | number = new Date(),
  ): Promise<{
    bound: boolean;
    notification: PurchaseWorkflowNotificationEntry;
    card: PurchaseManagerApprovalCardEntry;
  }> {
    const identity = normalizeManagerApprovalCallbackBinding(input);
    return this.enqueueCard(async () => {
      const ledger = await this.read();
      const existingCards = ledger.managerApprovalCards.filter(
        (card) =>
          card.executionRecordId === identity.recordId &&
          card.recipientOpenId === identity.actorOpenId,
      );
      if (existingCards.length > 1) {
        throw new ConflictException('经理审批卡记录映射不唯一');
      }
      const existingCard = existingCards[0];
      if (existingCard) {
        if (existingCard.messageId !== identity.messageId) {
          const reopenedCandidates = ledger.notifications.filter(
            (entry) =>
              entry.kind === 'manager_approval_reopened' &&
              entry.recordId === identity.recordId &&
              entry.recipientOpenId === identity.actorOpenId &&
              entry.status === 'manual_reconciliation' &&
              entry.sendOutcome === 'manual_reconciliation' &&
              Boolean(entry.cardContext),
          );
          if (reopenedCandidates.length !== 1) {
            throw new ConflictException(
              reopenedCandidates.length > 1
                ? '经理审批恢复卡未知送达候选不唯一'
                : '经理审批卡已绑定其他消息',
            );
          }
          const current = reopenedCandidates[0];
          if (!current) {
            throw new ConflictException('经理审批恢复卡未知送达候选不存在');
          }
          const resolved = completeManualReopenedManagerApprovalDelivery(
            ledger,
            current,
            identity.messageId,
            identity.actorOpenId,
            'callback_bound',
            resolveNow(now).toISOString(),
          );
          ledger.notifications = trimNotificationHistory(
            ledger.notifications,
            MAX_NOTIFICATIONS,
          );
          await this.write(ledger);
          return { bound: true, ...resolved };
        }
        const notification = ledger.notifications.find(
          (entry) => entry.key === existingCard.sourceNotificationKey,
        );
        if (
          !notification ||
          notification.kind !== 'manager_approval_requested' ||
          notification.status !== 'completed' ||
          notification.sendOutcome !== 'delivered'
        ) {
          throw new ConflictException('经理审批卡来源通知状态异常');
        }
        return { bound: false, notification, card: existingCard };
      }

      const candidates = ledger.notifications.filter(
        (entry) =>
          entry.kind === 'manager_approval_requested' &&
          entry.recordId === identity.recordId &&
          entry.recipientOpenId === identity.actorOpenId &&
          entry.status === 'manual_reconciliation' &&
          entry.sendOutcome === 'manual_reconciliation' &&
          Boolean(entry.cardContext),
      );
      if (candidates.length !== 1) {
        throw new ConflictException(
          candidates.length > 1
            ? '经理审批未知送达候选不唯一'
            : '经理审批未知送达候选不存在',
        );
      }
      if (
        ledger.managerApprovalCards.some(
          (card) =>
            card.messageId === identity.messageId ||
            card.supersededMessageIds.includes(identity.messageId),
        )
      ) {
        throw new ConflictException('经理审批卡消息已绑定其他记录');
      }
      const current = candidates[0];
      if (!current) {
        throw new ConflictException('经理审批未知送达候选不存在');
      }
      const context = parsePurchaseManagerApprovalCardContext(
        current.cardContext,
      );
      if (context.executionRecordId !== identity.recordId) {
        throw new ConflictException('经理审批卡上下文记录不匹配');
      }

      const timestamp = resolveNow(now).toISOString();
      const notification: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'completed',
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
        messageId: identity.messageId,
        sendOutcome: 'delivered',
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'callback_bound',
          at: timestamp,
          operatorOpenId: identity.actorOpenId,
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId: identity.messageId,
        }),
      };
      const notificationIndex = ledger.notifications.findIndex(
        (entry) => entry.key === current.key,
      );
      if (notificationIndex < 0) {
        throw new ConflictException('经理审批未知送达候选不存在');
      }
      ledger.notifications[notificationIndex] = notification;
      const card = registerManagerApprovalCard(
        ledger,
        notification,
        identity.messageId,
        timestamp,
      );
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { bound: true, notification, card };
    });
  }

  async replaceManagerApprovalCardMessage(
    key: string,
    claimToken: string,
    input: PurchaseManagerApprovalReplacementInput,
    now: Date | number = new Date(),
  ): Promise<{
    notification: PurchaseWorkflowNotificationEntry;
    card: PurchaseManagerApprovalCardEntry;
  }> {
    const oldMessageId = requiredDeliveryId(input?.oldMessageId);
    const newMessageId = requiredDeliveryId(input?.newMessageId);
    if (oldMessageId === newMessageId) {
      throw new Error('Manager approval replacement message must change');
    }
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const ledger = await this.read();
      const notificationIndex = ledger.notifications.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      const current = ledger.notifications[notificationIndex];
      if (notificationIndex < 0 || !current) {
        throw new ConflictException('经理审批恢复通知不存在');
      }
      assertClaimOwnership(current, claimToken);
      if (
        current.kind !== 'manager_approval_reopened' ||
        current.sendOutcome !== 'unknown' ||
        !current.firstSendAttemptAt ||
        !current.cardContext ||
        current.messageId !== oldMessageId
      ) {
        throw new ConflictException('经理审批恢复通知状态不允许替换消息');
      }
      const card = ledger.managerApprovalCards.find(
        (entry) =>
          entry.key ===
          managerApprovalCardKey(current.recordId, current.recipientOpenId),
      );
      if (
        !card ||
        card.messageId !== oldMessageId ||
        card.cardContext !== current.cardContext
      ) {
        throw new ConflictException('经理审批恢复通知与活动卡片不一致');
      }
      if (
        ledger.managerApprovalCards.some(
          (entry) =>
            entry.messageId === newMessageId ||
            entry.supersededMessageIds.includes(newMessageId),
        )
      ) {
        throw new ConflictException('经理审批替代消息已绑定其他记录');
      }

      const timestamp = resolveNow(now).toISOString();
      const notification: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'completed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
        deliveryId:
          boundedText(input?.deliveryId, MAX_DELIVERY_ID_LENGTH) ||
          current.deliveryId,
        messageId: newMessageId,
        sendOutcome: 'delivered',
        deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
          action: 'replacement_bound',
          at: timestamp,
          operatorOpenId: '',
          generation: current.deliveryGeneration,
          deliveryUuid: current.deliveryUuid,
          messageId: newMessageId,
        }),
      };
      const updatedCard: PurchaseManagerApprovalCardEntry = {
        ...card,
        messageId: newMessageId,
        supersededMessageIds: [
          ...new Set([...card.supersededMessageIds, oldMessageId]),
        ],
        updatedAt: timestamp,
      };
      ledger.notifications[notificationIndex] = notification;
      replaceManagerApprovalCard(ledger, updatedCard);
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { notification, card: updatedCard };
    });
  }

  async singleManagerHandoverSnapshot():Promise<{cards:PurchaseManagerApprovalCardEntry[];actions:PurchaseManagerApprovalActionEntry[];notifications:PurchaseWorkflowNotificationEntry[]}>{
    return this.enqueueRead(async()=>{const ledger=await this.read();return structuredClone({cards:ledger.managerApprovalCards,actions:ledger.managerApprovalActions,notifications:ledger.notifications});});
  }

  async acceptSingleManagerHandover(input:PurchaseSingleManagerHandoverInput,authorize:()=>void):Promise<{status:'accepted'|'already_completed';version:string}>{
    if(!input||!RECORD_ID_PATTERN.test(input.recordId)||!/^ou_[A-Za-z0-9_-]{1,124}$/.test(input.sourceOpenId)||!/^ou_[A-Za-z0-9_-]{1,124}$/.test(input.targetOpenId)||input.sourceOpenId===input.targetOpenId||
      ![input.sourcePersonRecordId,input.targetPersonRecordId].every(id=>/^rec[A-Za-z0-9_]{1,97}$/.test(id))||input.sourcePersonRecordId===input.targetPersonRecordId||!/^handover-[a-f0-9]{64}$/.test(input.mutationId)||!/^[a-f0-9]{64}$/.test(input.expectedVersion)||typeof authorize!=='function')throw new BadRequestException('采购单条交接身份或版本无效');
    return this.enqueue(async()=>{
      const ledger=await this.read(),cards=ledger.managerApprovalCards.filter(card=>card.executionRecordId===input.recordId&&card.recipientOpenId===input.sourceOpenId);
      if(cards.length!==1)throw new ConflictException('原采购审批卡映射不唯一');
      const card=cards[0];authorize();
      const prior=card.personnelHandover;
      if(prior){
        if(prior.mutationId!==input.mutationId||prior.sourceVersion!==input.expectedVersion||prior.sourcePersonRecordId!==input.sourcePersonRecordId||prior.targetOpenId!==input.targetOpenId||prior.targetPersonRecordId!==input.targetPersonRecordId)throw new ConflictException('采购原单条交接回执不一致');
        return{status:'accepted',version:singleManagerReceiptVersion(card)};
      }
      const acceptedAction=ledger.managerApprovalActions.find(action=>action.recordId===input.recordId&&action.status!=='failed');
      if(acceptedAction)return{status:'already_completed',version:singleManagerAcceptedVersion(card,acceptedAction)};
      if(!['initial','reject_editing'].includes(card.state)||singleManagerCardVersion(card)!==input.expectedVersion)throw new ConflictException('原采购审批卡已变化，请重新预览');
      if(ledger.notifications.some(task=>task.recordId===input.recordId&&task.recipientOpenId===input.sourceOpenId&&task.status!=='completed'&&isManagerNotificationKind(task.kind)))throw new ConflictException('原采购审批卡仍在同步，请先恢复原任务');
      const existingTarget=ledger.managerApprovalCards.find(value=>value.executionRecordId===input.recordId&&value.recipientOpenId===input.targetOpenId);
      if(existingTarget&&!existingTarget.personnelHandover)throw new ConflictException('接任人已有同一记录审批卡，请核对原卡');
      if(ledger.notifications.filter(task=>isActiveStatus(task.status)).length+2>MAX_NOTIFICATIONS)throw new ServiceUnavailableException('采购通知队列已满，请稍后恢复原交接');
      const timestamp=new Date().toISOString();
      const terminal=createNotificationEntry(normalizeNotificationInput({businessEventId:`single-manager-handover:${input.mutationId}:old`,recordId:input.recordId,recipientOpenId:input.sourceOpenId,kind:'manager_approval_transferred',cardContext:card.cardContext}),timestamp);terminal.messageId=card.messageId;
      const next=createNotificationEntry(normalizeNotificationInput({businessEventId:`single-manager-handover:${input.mutationId}:new`,recordId:input.recordId,recipientOpenId:input.targetOpenId,kind:'manager_approval_requested',cardContext:card.cardContext}),timestamp);
      const metadata:PurchaseSingleManagerHandover={mutationId:input.mutationId,sourceVersion:input.expectedVersion,sourcePersonRecordId:input.sourcePersonRecordId,targetOpenId:input.targetOpenId,targetPersonRecordId:input.targetPersonRecordId,terminalNotificationKey:terminal.key,targetNotificationKey:next.key};
      if(!validSingleManagerHandover(metadata)||ledger.notifications.some(task=>task.key===terminal.key||task.key===next.key))throw new ConflictException('采购交接消息标记冲突');
      card.personnelHandover=metadata;card.updatedAt=timestamp;ledger.notifications=trimNotificationHistory([...ledger.notifications,terminal,next],MAX_NOTIFICATIONS);await this.write(ledger);
      return{status:'accepted',version:singleManagerReceiptVersion(card)};
    });
  }

  async findManagerApprovalCard(
    messageId: string,
    recipientOpenId: string,
  ): Promise<PurchaseManagerApprovalCardEntry | null> {
    const normalizedMessageId = boundedText(messageId, MAX_DELIVERY_ID_LENGTH);
    const normalizedRecipient = boundedText(
      recipientOpenId,
      MAX_OPEN_ID_LENGTH,
    );
    if (!normalizedMessageId || !OPEN_ID_PATTERN.test(normalizedRecipient)) {
      return null;
    }
    return this.enqueueCardRead(async () => {
      const ledger = await this.read();
      if (
        ledger.managerApprovalCards.some((card) =>
          card.supersededMessageIds.includes(normalizedMessageId),
        )
      ) {
        return null;
      }
      const matches = ledger.managerApprovalCards.filter(
        (card) =>
          card.messageId === normalizedMessageId &&
          card.recipientOpenId === normalizedRecipient &&
          card.sourceKind === 'manager_approval_requested' &&
          card.sourceStatus === 'completed',
      );
      if (matches.length > 1) {
        throw new ConflictException('经理审批卡消息映射不唯一');
      }
      return matches[0] || null;
    });
  }

  async getManagerApprovalRecordState(recordId: string): Promise<PurchaseManagerApprovalCardEntry | null> {
    return this.enqueueCardRead(async () => {
      const cards = (await this.read()).managerApprovalCards.filter(card => card.executionRecordId === recordId && !card.personnelHandover);
      return cards.find(card => !['initial', 'reject_editing'].includes(card.state)) || null;
    });
  }

  async openManagerApprovalRejectEditor(
    input: PurchaseManagerApprovalCardIdentity,
    now: Date | number = new Date(),
  ): Promise<{
    opened: boolean;
    card: PurchaseManagerApprovalCardEntry;
  }> {
    const identity = normalizeManagerApprovalCardIdentity(input);
    return this.enqueueCard(async () => {
      const ledger = await this.read();
      const card = requireActiveManagerApprovalCard(ledger, identity);
      if ((ledger.platformLegacyApprovalClaims || []).some(claim => claim.recordId === identity.recordId)) throw new ConflictException('采购明细已有平台审批任务，请查看原任务');
      if(card.personnelHandover)return{opened:false,card};
      if (card.state !== 'initial') {
        return { opened: false, card };
      }
      const timestamp = resolveNow(now).toISOString();
      const updated: PurchaseManagerApprovalCardEntry = {
        ...card,
        state: 'reject_editing',
        choice: '',
        rejectionReasonDraft: '',
        actionEventId: '',
        actorOpenId: identity.actorOpenId,
        processedAt: '',
        updatedAt: timestamp,
        resolvedAt: '',
      };
      replaceManagerApprovalCard(ledger, updated);
      await this.write(ledger);
      return { opened: true, card: updated };
    });
  }

  async claimManagerApprovalAction(
    input: PurchaseManagerApprovalActionClaimInput,
    now: Date | number = new Date(),
    authorize?: (card: PurchaseManagerApprovalCardEntry) => void,
  ): Promise<{
    claimed: boolean;
    entry: PurchaseManagerApprovalActionEntry | null;
    card: PurchaseManagerApprovalCardEntry;
  }> {
    const normalized = normalizeManagerApprovalActionClaim(input);
    return this.enqueueCard(async () => {
      const ledger = await this.read();
      const eventReplay = ledger.managerApprovalActions.find(
        (entry) => entry.eventId === normalized.eventId,
      );
      if (
        eventReplay &&
        !sameManagerApprovalActionPayload(eventReplay, normalized)
      ) {
        throw new ConflictException('经理审批回调事件与已有任务冲突');
      }

      const card = requireActiveManagerApprovalCard(ledger, {
        recordId: normalized.recordId,
        messageId: normalized.messageId,
        actorOpenId: normalized.actorOpenId,
      });
      if (eventReplay) {
        return { claimed: false, entry: eventReplay, card };
      }
      if ((ledger.platformApprovalClaims || []).some(claim => claim.recordIds.includes(normalized.recordId)) || (ledger.platformLegacyApprovalClaims || []).some(claim => claim.recordId === normalized.recordId)) throw new ConflictException('采购明细已有平台审批任务，请查看原任务');
      if(card.personnelHandover)return{claimed:false,entry:null,card};
      if (
        normalized.choice === 'building_self' &&
        !isBuildingSelfPurchaseAllowed(
          parsePurchaseManagerApprovalCardContext(card.cardContext).building,
        )
      ) {
        throw new ConflictException('H楼仅支持综合采购');
      }

      const blockingAction = ledger.managerApprovalActions.find(
        (entry) =>
          entry.recordId === normalized.recordId && entry.status !== 'failed',
      );
      if (blockingAction) {
        return { claimed: false, entry: blockingAction, card };
      }

      const expectedState =
        normalized.choice === 'reject' ? 'reject_editing' : 'initial';
      if (card.state !== expectedState) {
        return { claimed: false, entry: null, card };
      }
      if (
        ledger.managerApprovalActions.filter((entry) =>
          isActiveStatus(entry.status),
        ).length >= MAX_MANAGER_APPROVAL_ACTIONS
      ) {
        throw new ServiceUnavailableException(
          '经理审批任务队列已满，请稍后重试',
        );
      }

      authorize?.(structuredClone(card));
      const timestamp = resolveNow(now).toISOString();
      const entry: PurchaseManagerApprovalActionEntry = {
        key: managerApprovalActionKey(normalized.eventId),
        ...normalized,
        status: 'pending',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: '',
        lastError: '',
      };
      const updatedCard: PurchaseManagerApprovalCardEntry = {
        ...card,
        state: 'pending',
        choice: normalized.choice,
        rejectionReasonDraft: normalized.rejectionReason,
        actionEventId: normalized.eventId,
        actorOpenId: normalized.actorOpenId,
        processedAt: '',
        updatedAt: timestamp,
        resolvedAt: '',
      };
      ledger.managerApprovalActions = trimManagerApprovalActionHistory(
        [...ledger.managerApprovalActions, entry],
        ledger.notifications,
      );
      replaceManagerApprovalCard(ledger, updatedCard);
      for (const copy of ledger.managerApprovalCards.filter(candidate => candidate.executionRecordId === normalized.recordId && !candidate.personnelHandover)) {
        replaceManagerApprovalCard(ledger, { ...copy, state: updatedCard.state, choice: updatedCard.choice,
          actionEventId: entry.eventId, actorOpenId: entry.actorOpenId, updatedAt: timestamp,
          rejectionReasonDraft: entry.rejectionReason, processedAt: '', resolvedAt: '' });
      }
      await this.write(ledger);
      return { claimed: true, entry, card: updatedCard };
    });
  }

  async takeNextManagerApprovalAction(
    now: Date | number = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<PurchaseManagerApprovalActionEntry | null> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const index = ledger.managerApprovalActions.findIndex((entry) =>
        isAvailable(entry, timestamp),
      );
      if (index < 0) return null;
      const current = ledger.managerApprovalActions[index];
      if (!current) return null;
      const updated: PurchaseManagerApprovalActionEntry = {
        ...current,
        status: 'processing',
        attempts: Math.min(current.attempts + 1, 1_000_000),
        updatedAt: timestamp.toISOString(),
        leaseUntil: new Date(
          timestamp.getTime() + normalizeLeaseMs(leaseMs),
        ).toISOString(),
        claimToken: randomUUID(),
      };
      ledger.managerApprovalActions[index] = updated;
      await this.write(ledger);
      return updated;
    });
  }

  async rescheduleManagerApprovalAction(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number,
    now: Date | number = new Date(),
  ): Promise<PurchaseManagerApprovalActionEntry | null> {
    return this.updateManagerApprovalAction(key, claimToken, (entry) => ({
      ...entry,
      status: 'pending',
      updatedAt: resolveNow(now).toISOString(),
      nextAttemptAt: resolveNow(nextAttemptAt).toISOString(),
      leaseUntil: '',
      claimToken: '',
      completedAt: '',
      lastError: sanitizeError(error),
    }));
  }

  async completeManagerApprovalActionAndEnqueueResolved(
    key: string,
    claimToken: string,
    now: Date | number = new Date(),
  ): Promise<{
    action: PurchaseManagerApprovalActionEntry;
    card: PurchaseManagerApprovalCardEntry;
    notification: PurchaseWorkflowNotificationEntry;
  }> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const claimed = requireClaimedManagerApprovalActionAndCard(
        ledger,
        key,
        claimToken,
      );
      const action: PurchaseManagerApprovalActionEntry = {
        ...claimed.action,
        status: 'completed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
      };
      const card: PurchaseManagerApprovalCardEntry = {
        ...claimed.card,
        state: 'resolved',
        choice: action.choice,
        rejectionReasonDraft: action.rejectionReason,
        actionEventId: action.eventId,
        actorOpenId: action.actorOpenId,
        processedAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: timestamp,
      };
      const notification = enqueueManagerApprovalStateNotification(
        ledger,
        action,
        card,
        'manager_approval_resolved',
        timestamp,
      );
      ledger.managerApprovalActions[claimed.actionIndex] = action;
      replaceManagerApprovalCard(ledger, card);
      for (const copy of ledger.managerApprovalCards.filter(candidate => candidate.executionRecordId === action.recordId && candidate.key !== card.key && !candidate.personnelHandover)) {
        const updatedCopy = { ...copy, state: card.state, choice: card.choice, rejectionReasonDraft: card.rejectionReasonDraft,
          actionEventId: card.actionEventId, actorOpenId: card.actorOpenId, processedAt: card.processedAt,
          updatedAt: card.updatedAt, resolvedAt: card.resolvedAt };
        replaceManagerApprovalCard(ledger, updatedCopy);
        enqueueManagerApprovalStateNotification(ledger, action, updatedCopy, 'manager_approval_resolved', timestamp);
      }
      ledger.managerApprovalActions = trimManagerApprovalActionHistory(
        ledger.managerApprovalActions,
        ledger.notifications,
      );
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { action, card, notification };
    });
  }

  async failManagerApprovalActionAndEnqueueReopen(
    key: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
  ): Promise<{
    action: PurchaseManagerApprovalActionEntry;
    card: PurchaseManagerApprovalCardEntry;
    notification: PurchaseWorkflowNotificationEntry;
  }> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const claimed = requireClaimedManagerApprovalActionAndCard(
        ledger,
        key,
        claimToken,
      );
      const action: PurchaseManagerApprovalActionEntry = {
        ...claimed.action,
        status: 'failed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: sanitizeError(error),
      };
      const card: PurchaseManagerApprovalCardEntry = {
        ...claimed.card,
        state: action.choice === 'reject' ? 'reject_editing' : 'initial',
        choice: '',
        rejectionReasonDraft:
          action.choice === 'reject' ? action.rejectionReason : '',
        actionEventId: '',
        actorOpenId: '',
        processedAt: '',
        updatedAt: timestamp,
        resolvedAt: '',
      };
      const notification = enqueueManagerApprovalStateNotification(
        ledger,
        action,
        card,
        'manager_approval_reopened',
        timestamp,
      );
      ledger.managerApprovalActions[claimed.actionIndex] = action;
      replaceManagerApprovalCard(ledger, card);
      for (const copy of ledger.managerApprovalCards.filter(candidate => candidate.executionRecordId === action.recordId && candidate.key !== card.key && !candidate.personnelHandover)) {
        const updatedCopy: PurchaseManagerApprovalCardEntry = { ...copy, state: 'initial', choice: '', rejectionReasonDraft: '',
          actionEventId: card.actionEventId, actorOpenId: card.actorOpenId, processedAt: card.processedAt,
          updatedAt: card.updatedAt, resolvedAt: card.resolvedAt };
        replaceManagerApprovalCard(ledger, updatedCopy);
        enqueueManagerApprovalStateNotification(ledger, action, updatedCopy, 'manager_approval_reopened', timestamp);
      }
      ledger.managerApprovalActions = trimManagerApprovalActionHistory(
        ledger.managerApprovalActions,
        ledger.notifications,
      );
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { action, card, notification };
    });
  }

  async markManagerApprovalManualReconciliation(
    key: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
  ): Promise<{
    action: PurchaseManagerApprovalActionEntry;
    card: PurchaseManagerApprovalCardEntry;
    notification: PurchaseWorkflowNotificationEntry;
  }> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now).toISOString();
      const ledger = await this.read();
      const claimed = requireClaimedManagerApprovalActionAndCard(
        ledger,
        key,
        claimToken,
      );
      const action: PurchaseManagerApprovalActionEntry = {
        ...claimed.action,
        status: 'manual_reconciliation',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: sanitizeError(error),
      };
      const card: PurchaseManagerApprovalCardEntry = {
        ...claimed.card,
        state: 'manual_reconciliation',
        choice: action.choice,
        rejectionReasonDraft: action.rejectionReason,
        actionEventId: action.eventId,
        actorOpenId: action.actorOpenId,
        processedAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: '',
      };
      const notification = enqueueManagerApprovalStateNotification(
        ledger,
        action,
        card,
        'manager_approval_attention_required',
        timestamp,
      );
      ledger.managerApprovalActions[claimed.actionIndex] = action;
      replaceManagerApprovalCard(ledger, card);
      for (const copy of ledger.managerApprovalCards.filter(candidate => candidate.executionRecordId === action.recordId && candidate.key !== card.key && !candidate.personnelHandover)) {
        const updatedCopy = { ...copy, state: card.state, choice: card.choice, rejectionReasonDraft: card.rejectionReasonDraft,
          actionEventId: card.actionEventId, actorOpenId: card.actorOpenId, processedAt: card.processedAt,
          updatedAt: card.updatedAt, resolvedAt: card.resolvedAt };
        replaceManagerApprovalCard(ledger, updatedCopy);
        enqueueManagerApprovalStateNotification(ledger, action, updatedCopy, 'manager_approval_attention_required', timestamp);
      }
      ledger.managerApprovalActions = trimManagerApprovalActionHistory(
        ledger.managerApprovalActions,
        ledger.notifications,
      );
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return { action, card, notification };
    });
  }

  async listManagerApprovalActions(
    filter: {
      recordId?: string;
      status?: PurchaseManagerApprovalActionStatus;
    } = {},
  ): Promise<PurchaseManagerApprovalActionEntry[]> {
    const recordId = clean(filter.recordId);
    return this.enqueueRead(async () =>
      (await this.read()).managerApprovalActions.filter(
        (entry) =>
          (!recordId || entry.recordId === recordId) &&
          (!filter.status || entry.status === filter.status),
      ),
    );
  }

  async completeNotification(
    key: string,
    claimToken: string,
    deliveryOrNow:
      | PurchaseWorkflowNotificationDelivery
      | string
      | Date
      | number = {},
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    const isTime =
      deliveryOrNow instanceof Date || typeof deliveryOrNow === 'number';
    const timestamp = isTime ? deliveryOrNow : now;
    const delivery: PurchaseWorkflowNotificationDelivery = isTime
      ? {}
      : typeof deliveryOrNow === 'string'
        ? { deliveryId: deliveryOrNow }
        : deliveryOrNow;
    return this.updateNotification(key, claimToken, (entry, ledger) => {
      const completedAt = resolveNow(timestamp).toISOString();
      const warehouseMessageId = entry.kind === 'warehouse_inbound' ? boundedText(delivery.messageId, MAX_DELIVERY_ID_LENGTH) : '';
      if (warehouseMessageId) for (const job of ledger.warehouseInboundHandovers.filter(value => value.notificationKey === entry.key)) {
        if (job.deliveredMessageId && job.deliveredMessageId !== warehouseMessageId) throw new ConflictException('接任者入库提醒投递回执冲突');
        job.deliveredMessageId = warehouseMessageId; job.deliveryConfirmedAt = completedAt; job.deliveryDisposition = 'delivered';
      }
      if (delivery.businessStage) {
        if (entry.kind !== 'warehouse_inbound' || warehouseMessageId || entry.sendOutcome === 'unknown') throw new ConflictException('业务终态不能代替未知发送回执');
        for (const job of ledger.warehouseInboundHandovers.filter(value => value.notificationKey === entry.key)) {
          if (!job.deliveredMessageId) {
            job.deliveryDisposition = delivery.businessStage === 'completed' ? 'business_completed' : 'business_terminated';
            job.deliveryConfirmedAt = completedAt;
          }
        }
      }
      return {
        ...entry,
        status: 'completed',
        updatedAt: completedAt,
        leaseUntil: '',
        claimToken: '',
        completedAt,
        lastError: '',
        deliveryId:
          boundedText(delivery.deliveryId, MAX_DELIVERY_ID_LENGTH) ||
          entry.deliveryId,
        messageId:
          boundedText(delivery.messageId, MAX_DELIVERY_ID_LENGTH) ||
          entry.messageId,
        sendOutcome:
          isInboundCompletedDeliveryKind(entry.kind) || (entry.kind === 'purchase_order_completed' && Boolean(delivery.messageId)) ||
          (entry.kind === 'warehouse_inbound' && Boolean(delivery.messageId)) ||
          ((isManagerNotificationKind(entry.kind) || entry.kind === 'approval_requested') && Boolean(delivery.messageId))
            ? 'delivered'
            : entry.sendOutcome,
      };
    });
  }

  async recordPurchaseBatchCardUpdateCompleted(
    key: string,
    claimToken: string,
    messageIdValue: string,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    const messageId = requiredDeliveryId(messageIdValue);
    return this.updateNotification(key, claimToken, (entry) => {
      if (
        entry.kind !== 'manager_batch_purchase_refresh' &&
        entry.kind !== 'manager_batch_receipt_refresh' &&
        entry.kind !== 'manager_approval_transferred'
        && entry.kind !== 'approval_transferred'
      ) {
        throw new ConflictException('采购履约卡更新任务类型不匹配');
      }
      if (
        entry.deliveryAudit.some(
          (audit) =>
            audit.action === 'card_update_completed' &&
            audit.messageId === messageId,
        )
      ) {
        return entry;
      }
      const timestamp = resolveNow(now).toISOString();
      return {
        ...entry,
        updatedAt: timestamp,
        deliveryAudit: appendDeliveryAudit(entry.deliveryAudit, {
          action: 'card_update_completed',
          at: timestamp,
          operatorOpenId: '',
          generation: entry.deliveryGeneration,
          deliveryUuid: entry.deliveryUuid,
          messageId,
        }),
      };
    });
  }

  async completeInboundCompletedResolutionAndEnqueueNotifications(
    key: string,
    claimToken: string,
    inputs: PurchaseWorkflowNotificationInput[],
    now: Date | number = new Date(),
  ): Promise<{
    resolution: PurchaseWorkflowNotificationEntry;
    notifications: PurchaseWorkflowNotificationEntry[];
  } | null> {
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const timestamp = resolveNow(now).toISOString();
      let normalizedInputs = inputs.map(normalizeNotificationInput);
      const ledger = await this.read();
      const resolutionIndex = ledger.notifications.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      if (resolutionIndex < 0) return null;
      const current = ledger.notifications[resolutionIndex];
      if (!current) return null;
      assertClaimOwnership(current, claimToken);
      if (!isInboundCompletedResolutionKind(current.kind)) {
        throw new ConflictException('通知解析任务类型不匹配');
      }

      for (const input of normalizedInputs) {
        const allowedKind =
          current.kind === 'manual_inventory_inbound_completed_resolution'
            ? input.kind === 'manual_inventory_inbound_completed'
            : input.kind === 'inventory_inbound_completed' ||
              input.kind === 'purchase_completed';
        if (
          input.recordId !== current.recordId ||
          !allowedKind ||
          (current.kind === 'manual_inventory_inbound_completed_resolution' &&
            input.cardContext !== current.cardContext)
        ) {
          throw new ConflictException('通知解析结果与入库记录不匹配');
        }
      }

      const snapshot = inboundCompletionSnapshot(ledger.notifications, current.recordId,
        current.kind === 'manual_inventory_inbound_completed_resolution' ? 'manual_inventory_inbound_completed' : 'inventory_inbound_completed');
      if (snapshot.sealed) {
        // A retried/reintroduced resolution cannot expand an already accepted event.
        normalizedInputs = snapshot.notifications.map(entry => ({
          businessEventId: entry.businessEventId, recordId: entry.recordId, recipientOpenId: entry.recipientOpenId,
          kind: entry.kind, ...(entry.cardContext ? { cardContext: entry.cardContext } : {}),
        }));
      }

      const existingByKey = new Map(
        ledger.notifications.map((entry) => [entry.key, entry] as const),
      );
      const missingByKey = new Map<string, PurchaseWorkflowNotificationInput>();
      for (const input of normalizedInputs) {
        const childKey = notificationKey(input);
        const existing = existingByKey.get(childKey);
        if (existing) {
          if (
            existing.kind !== input.kind ||
            (isManualInboundNotificationKind(input.kind) &&
              existing.cardContext !== (input.cardContext || '')) ||
            (input.cardContext &&
              existing.cardContext &&
              existing.cardContext !== input.cardContext)
          ) {
            throw new ConflictException('通知解析结果与已有任务冲突');
          }
          if (
            input.cardContext &&
            !existing.cardContext &&
            existing.status === 'pending'
          ) {
            existing.cardContext = input.cardContext;
          }
          continue;
        }
        missingByKey.set(childKey, input);
      }
      const activeAfterResolution = ledger.notifications.filter(
        (entry) => entry.key !== current.key && isActiveStatus(entry.status),
      ).length;
      if (activeAfterResolution + missingByKey.size > MAX_NOTIFICATIONS) {
        throw new ServiceUnavailableException(
          '采购通知任务队列已满，请稍后重试',
        );
      }

      const createdByKey = new Map<string, PurchaseWorkflowNotificationEntry>();
      for (const [childKey, input] of missingByKey) {
        const entry = createNotificationEntry(input, timestamp);
        ledger.notifications.push(entry);
        createdByKey.set(childKey, entry);
      }

      const resolution: PurchaseWorkflowNotificationEntry = {
        ...current,
        status: 'completed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: '',
      };
      ledger.notifications[resolutionIndex] = resolution;
      if (current.kind === 'inventory_inbound_completed_resolution' && !snapshot.sealed) {
        const matchingBatches = ledger.managerApprovalBatches.filter(batch => batch.recordIds.includes(current.recordId));
        if (matchingBatches.some(batch => batch.flowVersion === 'lifecycle_v1')) {
          if (matchingBatches.length !== 1) throw new ConflictException('采购入库明细所属批次不唯一');
          queueExistingLifecycleBatchRefresh(ledger, matchingBatches[0]!);
        }
      }
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);

      return {
        resolution,
        notifications: normalizedInputs.map((input) => {
          const childKey = notificationKey(input);
          const entry =
            createdByKey.get(childKey) || existingByKey.get(childKey);
          if (!entry) throw new Error('Notification resolution enqueue failed');
          return entry;
        }),
      };
    });
  }

  async rescheduleNotification(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.updateNotification(key, claimToken, (entry) => ({
      ...entry,
      status: 'pending',
      updatedAt: resolveNow(now).toISOString(),
      nextAttemptAt: resolveNow(nextAttemptAt).toISOString(),
      leaseUntil: '',
      claimToken: '',
      completedAt: '',
      lastError: sanitizeError(error),
    }));
  }

  async retryFailedNotifications(keys: readonly string[], authorize: () => void): Promise<void> {
    if (!Array.isArray(keys) || keys.length > 100 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !key || key.length > 1000)) throw new BadRequestException('采购恢复任务范围无效');
    await this.enqueue(async () => {
      const ledger = await this.read(), tasks = keys.map(key => ledger.notifications.find(task => task.key === key));
      if (tasks.some(task => !task || task.kind === 'web_receipt_command' || task.status === 'manual_reconciliation')) throw new ConflictException('原采购任务结果尚未核对，不能直接重试');
      authorize();
      let changed = false;
      for (const task of tasks) {
        if (!task || task.status !== 'failed' && !(task.status === 'pending' && task.lastError)) continue;
        task.status = 'pending'; task.nextAttemptAt = new Date().toISOString(); task.completedAt = ''; task.lastError = ''; task.claimToken = ''; task.leaseUntil = ''; changed = true;
      }
      if (changed) await this.write(ledger);
    });
  }

  async retryFailedComparisonImageNotifications(keys: readonly string[], actorId: string, preview = false): Promise<{ requeued: number; alreadyRequeued: number; candidates: Array<{ batchId: string; recipientName: string }> }> {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 20 || new Set(keys).size !== keys.length ||
      keys.some(key => typeof key !== 'string' || !key || key.length > 1000) || !actorId || actorId.length > MAX_OPEN_ID_LENGTH) {
      throw new BadRequestException('采购通知恢复范围无效');
    }
    return this.enqueue(async () => {
      const ledger = await this.read();
      // The normal reader accepts legacy records and fills missing delivery fields.
      // Recovery must inspect the original bytes while holding the same ledger lock,
      // otherwise an unknown historic send could look like an unattempted one.
      const original: unknown = JSON.parse((await readFile(this.ledgerPath)).toString('utf8'));
      if (!isRecord(original) || !Array.isArray(original.notifications)) {
        throw new ConflictException('采购通知原始记录无法核对，未恢复任何任务');
      }
      const tasks = keys.map(key => ledger.notifications.find(task => task.key === key));
      const recoverable: Array<{ task: PurchaseWorkflowNotificationEntry; source: Record<string, unknown> }> = [];
      const candidates: Array<{ batchId: string; recipientName: string }> = [];
      let alreadyRequeued = 0;
      for (const task of tasks) {
        if (!task) throw new ConflictException('采购通知不存在，未恢复任何任务');
        if (task.deliveryAudit.some(entry => entry.action === 'comparison_image_requeued')) {
          alreadyRequeued += 1;
          continue;
        }
        const batch = ledger.managerApprovalBatches.find(entry => managerBatchDeliveries(entry).some(delivery => delivery.sourceNotificationKey === task.key));
        const delivery = batch && managerBatchDeliveries(batch).find(entry => entry.sourceNotificationKey === task.key);
        const originals = original.notifications.filter(entry => isRecord(entry) && entry.key === task.key);
        const source = originals[0];
        if (task.kind !== 'manager_batch_approval_requested' || task.status !== 'failed' ||
          task.lastError !== '采购比价图片缓存暂不可用，请重试原通知任务' || task.sendOutcome !== 'unattempted' ||
          task.messageId || task.firstSendAttemptAt || task.deliveryAudit.length || !task.deliveryUuid ||
          originals.length !== 1 || !isRecord(source) || source.kind !== task.kind || source.status !== 'failed' ||
          source.sendOutcome !== 'unattempted' || source.messageId !== '' || source.deliveryId !== '' ||
          source.firstSendAttemptAt !== '' || !Array.isArray(source.deliveryAudit) || source.deliveryAudit.length !== 0 ||
          source.deliveryUuid !== task.deliveryUuid || source.deliveryGeneration !== task.deliveryGeneration ||
          source.businessEventId !== task.businessEventId || source.recordId !== task.recordId || source.recipientOpenId !== task.recipientOpenId ||
          source.lastError !== task.lastError || source.leaseUntil !== '' || source.claimToken !== '' ||
          !batch || !delivery || delivery.messageId || delivery.recipientOpenId !== task.recipientOpenId ||
          !['awaiting_delivery', 'active'].includes(batch.state) || batch.items.some(item => item.status !== 'pending') ||
          !batch.recordIds.includes(task.recordId)) {
          throw new ConflictException('采购通知状态已变化，未恢复任何任务');
        }
        recoverable.push({ task, source });
        candidates.push({ batchId: batch.approvalBatchId, recipientName: delivery.recipientName || '采购审批负责人' });
      }
      if (recoverable.length && !preview) {
        const timestamp = new Date().toISOString();
        for (const { task, source } of recoverable) {
          source.status = 'pending';
          source.attempts = 0;
          source.updatedAt = timestamp;
          source.nextAttemptAt = timestamp;
          source.completedAt = '';
          source.lastError = '';
          source.claimToken = '';
          source.leaseUntil = '';
          source.deliveryAudit = appendDeliveryAudit(task.deliveryAudit, {
            action: 'comparison_image_requeued', at: timestamp, operatorOpenId: actorId,
            generation: task.deliveryGeneration, deliveryUuid: task.deliveryUuid, messageId: '',
          });
        }
        // Preserve unrelated original fields and unrecognized delivery evidence.
        await this.write(original as unknown as PurchaseWorkflowLedger);
      }
      return { requeued: recoverable.length, alreadyRequeued, candidates };
    });
  }

  async failNotification(
    key: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.updateNotification(key, claimToken, (entry) => {
      const timestamp = resolveNow(now).toISOString();
      return {
        ...entry,
        status: 'failed',
        updatedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: sanitizeError(error),
      };
    });
  }

  async getNotification(
    key: string,
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    const normalizedKey = clean(key);
    return this.enqueueRead(
      async () =>
        (await this.read()).notifications.find(
          (entry) => entry.key === normalizedKey,
        ) || null,
    );
  }

  async listNotifications(
    filter: {
      recordId?: string;
      kind?: PurchaseWorkflowNotificationKind;
      status?: PurchaseWorkflowNotificationStatus;
      recipientOpenId?: string;
    } = {},
  ): Promise<PurchaseWorkflowNotificationEntry[]> {
    const recordId = clean(filter.recordId);
    const recipientOpenId = clean(filter.recipientOpenId);
    return this.enqueueRead(async () =>
      (await this.read()).notifications.filter(
        (entry) =>
          (!recordId || entry.recordId === recordId) &&
          (!recipientOpenId || entry.recipientOpenId === recipientOpenId) &&
          (!filter.kind || entry.kind === filter.kind) &&
          (!filter.status || entry.status === filter.status),
      ),
    );
  }

  private async updateCardAction(
    key: string,
    claimToken: string,
    update: (
      entry: PurchaseWorkflowCardActionEntry,
    ) => PurchaseWorkflowCardActionEntry,
  ): Promise<PurchaseWorkflowCardActionEntry | null> {
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const ledger = await this.read();
      const index = ledger.cardActions.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      if (index < 0) return null;
      const current = ledger.cardActions[index];
      if (!current) return null;
      assertClaimOwnership(current, claimToken);
      const updated = update(current);
      ledger.cardActions[index] = updated;
      ledger.cardActions = trimTerminalHistory(
        ledger.cardActions,
        MAX_CARD_ACTIONS,
      );
      await this.write(ledger);
      return updated;
    });
  }

  private async updateNotification(
    key: string,
    claimToken: string,
    update: (
      entry: PurchaseWorkflowNotificationEntry,
      ledger: PurchaseWorkflowLedger,
    ) => PurchaseWorkflowNotificationEntry,
  ): Promise<PurchaseWorkflowNotificationEntry | null> {
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const ledger = await this.read();
      const index = ledger.notifications.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      if (index < 0) return null;
      const current = ledger.notifications[index];
      if (!current) return null;
      assertClaimOwnership(current, claimToken);
      const updated = update(current, ledger);
      ledger.notifications[index] = updated;
      if (updated.webReceipt && updated.status !== current.status && ['completed', 'failed', 'manual_reconciliation'].includes(updated.status)) enqueueWebReceiptCardRefresh(ledger, updated);
      ledger.notifications = trimNotificationHistory(
        ledger.notifications,
        MAX_NOTIFICATIONS,
      );
      await this.write(ledger);
      return updated;
    });
  }

  private async updateManagerApprovalAction(
    key: string,
    claimToken: string,
    update: (
      entry: PurchaseManagerApprovalActionEntry,
    ) => PurchaseManagerApprovalActionEntry,
  ): Promise<PurchaseManagerApprovalActionEntry | null> {
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const ledger = await this.read();
      const index = ledger.managerApprovalActions.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      if (index < 0) return null;
      const current = ledger.managerApprovalActions[index];
      if (!current) return null;
      assertClaimOwnership(current, claimToken);
      const updated = update(current);
      ledger.managerApprovalActions[index] = updated;
      ledger.managerApprovalActions = trimManagerApprovalActionHistory(
        ledger.managerApprovalActions,
        ledger.notifications,
      );
      await this.write(ledger);
      return updated;
    });
  }

  private async updateManagerApprovalBatchAction(
    key: string,
    claimToken: string,
    update: (
      entry: PurchaseManagerApprovalBatchActionEntry,
    ) => PurchaseManagerApprovalBatchActionEntry,
  ): Promise<PurchaseManagerApprovalBatchActionEntry | null> {
    return this.enqueue(async () => {
      const normalizedKey = clean(key);
      const ledger = await this.read();
      const index = ledger.managerApprovalBatchActions.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      if (index < 0) return null;
      const current = ledger.managerApprovalBatchActions[index];
      if (!current) return null;
      assertClaimOwnership(current, claimToken);
      const updated = update(current);
      ledger.managerApprovalBatchActions[index] = updated;
      ledger.managerApprovalBatchActions =
        trimManagerApprovalBatchActionHistory(
          ledger.managerApprovalBatchActions,
        );
      await this.write(ledger);
      return updated;
    });
  }

  private enqueue<T>(operation: () => Promise<T>, interactive = false, readOnly = false): Promise<T> {
    const run = async () => {
      await this.ensureLock();
      this.sharedState.readOnlyOperation = readOnly;
      try {
        return await operation();
      } finally {
        this.sharedState.readOnlyOperation = false;
      }
    };
    return this.sharedState.operation.enqueue(run, interactive);
  }

  private enqueueCard<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation, true);
  }

  private enqueueRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation, false, true);
  }

  private enqueueCardRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation, true, true);
  }

  private ensureLock(): Promise<void> {
    if (!this.sharedState.lockPromise) {
      this.sharedState.lockPromise = acquireLedgerLock(this.sharedState).catch(
        (error: unknown) => {
          this.sharedState.lockPromise = null;
          throw error;
        },
      );
    }
    return this.sharedState.lockPromise;
  }

  private async read(): Promise<PurchaseWorkflowLedger> {
    try {
      // Always read bytes: mtime/size alone can miss an external same-size edit.
      const source = await readFile(this.ledgerPath);
      const cached = this.sharedState.readCache;
      if (cached?.source.equals(source)) {
        const ledger = structuredClone(cached.ledger);
        // This retention predicate depends on wall time even when file bytes are unchanged.
        ledger.managerApprovalCards = pruneResolvedManagerApprovalCards(ledger.managerApprovalCards, new Date(), ledger.notifications);
        return ledger;
      }
      const parsed = JSON.parse(source.toString('utf8')) as {
        requiredRuntimeCapability?: unknown;
        commands?: unknown;
        reminders?: unknown;
        cardActions?: unknown;
        notifications?: unknown;
        managerApprovalActions?: unknown;
        managerApprovalCards?: unknown;
        managerApprovalBatches?: unknown;
        managerApprovalBatchActions?: unknown;
        platformApprovalClaims?: unknown;
        platformApprovalWork?: unknown;
        platformLegacyApprovalClaims?: unknown;
        personnelHandovers?: unknown;
        warehouseInboundHandovers?: unknown;
        lifecycleOutbox?: unknown;
        lifecycleFormCredentials?: unknown;
        lifecyclePaymentUploads?: unknown;
        lifecyclePaymentBlocks?: unknown;
        lifecycleReceiptPrepareQueue?: unknown;
        lifecycleReceiptImageLedger?: unknown;
        lifecycleReceiptImageSource?: unknown;
      };
      validatePurchaseLedgerCapability(parsed.requiredRuntimeCapability);
      if (Array.isArray(parsed.managerApprovalBatches)) {
        if (parsed.requiredRuntimeCapability !== PURCHASE_STAGE_CARDS_LEDGER_CAPABILITY &&
            parsed.managerApprovalBatches.some(entry => isRecord(entry) && entry.stageCardTransition !== undefined)) {
          throw new ConflictException('采购分阶段卡片账本缺少运行能力标记');
        }
        const lifecycleIds = new Set(parsed.managerApprovalBatches.filter(entry => isRecord(entry) && entry.flowVersion === 'lifecycle_v1').map(entry => isRecord(entry) ? entry.approvalBatchId : undefined));
        for (const id of lifecycleIds) {
          if (parsed.managerApprovalBatches.filter(entry => isRecord(entry) && entry.approvalBatchId === id).length !== 1) throw new ConflictException('采购全流程批次存在重复记录');
        }
      }
      const notifications = Array.isArray(parsed.notifications)
        ? trimNotificationHistory(
            uniqueNotifications(
              parsed.notifications
                .map(sanitizeNotification)
                .filter(
                  (entry): entry is PurchaseWorkflowNotificationEntry =>
                    entry !== null,
                ),
            ),
            MAX_NOTIFICATIONS,
          )
        : [];
      const ledger: PurchaseWorkflowLedger = {
        version: 2,
        ...(parsed.requiredRuntimeCapability === undefined ? {} : {requiredRuntimeCapability:parsed.requiredRuntimeCapability as string}),
        ...(parsed.platformApprovalClaims === undefined ? {} : { platformApprovalClaims: normalizePlatformApprovalClaims(parsed.platformApprovalClaims) }),
        ...(parsed.platformApprovalWork === undefined ? {} : { platformApprovalWork: normalizePlatformApprovalWork(parsed.platformApprovalWork) }),
        ...(parsed.platformLegacyApprovalClaims === undefined ? {} : { platformLegacyApprovalClaims: normalizePlatformLegacyApprovalClaims(parsed.platformLegacyApprovalClaims) }),
        ...(parsed.lifecycleOutbox === undefined ? {} : { lifecycleOutbox: normalizeLifecycleOutbox(parsed.lifecycleOutbox) }),
        ...(parsed.lifecycleFormCredentials === undefined ? {} : { lifecycleFormCredentials: normalizeLifecycleFormCredentials(parsed.lifecycleFormCredentials) }),
        ...(parsed.lifecyclePaymentUploads === undefined ? {} : { lifecyclePaymentUploads: normalizeLifecyclePaymentUploads(parsed.lifecyclePaymentUploads) }),
        ...(parsed.lifecyclePaymentBlocks === undefined ? {} : { lifecyclePaymentBlocks: normalizeLifecyclePaymentBlocks(parsed.lifecyclePaymentBlocks) }),
        ...(parsed.lifecycleReceiptPrepareQueue === undefined ? {} : { lifecycleReceiptPrepareQueue: normalizeReceiptPrepareQueue(parsed.lifecycleReceiptPrepareQueue) }),
        ...(parsed.lifecycleReceiptImageLedger === undefined ? {} : { lifecycleReceiptImageLedger: normalizeReceiptImageLedger(parsed.lifecycleReceiptImageLedger) }),
        ...(parsed.lifecycleReceiptImageSource === undefined ? {} : { lifecycleReceiptImageSource: normalizeLifecycleReceiptImageSource(parsed.lifecycleReceiptImageSource) }),
        personnelHandovers: parsed.personnelHandovers === undefined ? [] : normalizePurchaseManagerHandovers(parsed.personnelHandovers),
        warehouseInboundHandovers: normalizeWarehouseInboundHandovers(parsed.warehouseInboundHandovers),
        commands: Array.isArray(parsed.commands)
          ? trimCommandHistory(parsed.commands.map(sanitizeCommand))
          : [],
        reminders: Array.isArray(parsed.reminders)
          ? parsed.reminders.map(clean).filter(Boolean).slice(-MAX_REMINDERS)
          : [],
        cardActions: Array.isArray(parsed.cardActions)
          ? trimTerminalHistory(
              uniqueCardActions(
                parsed.cardActions
                  .map(sanitizeCardAction)
                  .filter(
                    (entry): entry is PurchaseWorkflowCardActionEntry =>
                      entry !== null,
                  ),
              ),
              MAX_CARD_ACTIONS,
            )
          : [],
        notifications,
        managerApprovalActions: Array.isArray(parsed.managerApprovalActions)
          ? trimManagerApprovalActionHistory(
              uniqueManagerApprovalActions(
                parsed.managerApprovalActions
                  .map(sanitizeManagerApprovalAction)
                  .filter(
                    (entry): entry is PurchaseManagerApprovalActionEntry =>
                      entry !== null,
                  ),
              ),
              notifications,
            )
          : [],
        managerApprovalCards: Array.isArray(parsed.managerApprovalCards)
          ? pruneResolvedManagerApprovalCards(
              uniqueManagerApprovalCards(
                parsed.managerApprovalCards
                  .map(sanitizeManagerApprovalCard)
                  .filter(
                    (entry): entry is PurchaseManagerApprovalCardEntry =>
                      entry !== null,
                  ),
              ),
              new Date(),
              notifications,
            )
          : [],
        managerApprovalBatches: Array.isArray(parsed.managerApprovalBatches)
          ? trimManagerApprovalBatchHistory(
              uniqueManagerApprovalBatches(
                parsed.managerApprovalBatches
                  .map(sanitizeVersionedManagerApprovalBatch)
                  .filter(
                    (entry): entry is PurchaseManagerApprovalBatchEntry =>
                      entry !== null,
                  ),
              ),
              notifications,
            )
          : [],
        managerApprovalBatchActions: Array.isArray(
          parsed.managerApprovalBatchActions,
        )
          ? trimManagerApprovalBatchActionHistory(
              uniqueManagerApprovalBatchActions(
                parsed.managerApprovalBatchActions
                  .map(sanitizeManagerApprovalBatchAction)
                  .filter(
                    (entry): entry is PurchaseManagerApprovalBatchActionEntry =>
                      entry !== null,
                  ),
              ),
            )
          : [],
      };
      for (const claim of ledger.platformApprovalClaims || []) {
        const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === claim.approvalBatchId);
        const items = batches[0]?.items.filter(item => item.executionRecordId === claim.recordIds[0]);
        const work = (ledger.platformApprovalWork || []).find(row => row.eventId === claim.eventId);
        if (!work) throw new ConflictException('平台采购审批工作记录缺失');
        const expected = work?.phase === 'completed' ? claim.choice === 'reject' ? 'rejected' : 'approved' : 'processing';
        if (batches.length !== 1 || items?.length !== 1 || items[0]?.status !== expected || items[0]?.actionEventId !== claim.eventId ||
          (work?.phase !== 'completed' && batches[0]?.state !== 'processing')) throw new ConflictException('平台采购审批认领与批次不一致');
        if (work?.dispatchStartedAtMs && (claim.choice === 'reject' ? work.purchaser !== undefined : !validPlatformApprovalPurchaser(work.purchaser))) throw new ConflictException('平台采购审批采购人快照损坏');
      }
      for (const batch of ledger.managerApprovalBatches) for (const item of batch.items.filter(row => row.decisionSource === 'platform')) {
        const legacy = (ledger.platformLegacyApprovalClaims || []).filter(claim => claim.phase === 'completed' && item.status==='rejected' && claim.originalBatchId === batch.approvalBatchId && claim.recordId === item.executionRecordId && claim.eventId === item.actionEventId && claim.decision === 'rejected');
        const unified = (ledger.platformApprovalClaims || []).filter(claim => claim.approvalBatchId===batch.approvalBatchId&&claim.recordIds.length===1&&claim.recordIds[0]===item.executionRecordId&&claim.eventId===item.actionEventId&&claim.choice==='reject'&&claim.rejectionReason==='');
        if (legacy.length + unified.length !== 1) throw new ConflictException('平台采购审批来源无法核对');
      }
      for (const work of ledger.platformApprovalWork || []) if ((ledger.platformApprovalClaims || []).filter(claim => claim.eventId === work.eventId).length !== 1) throw new ConflictException('平台采购审批任务来源缺失');
      for (const row of ledger.lifecyclePaymentUploads || []) {
        const blocks = (ledger.lifecyclePaymentBlocks || []).filter(block => block.key === row.entry.key);
        if ((row.entry.status === 'cancelled') !== (blocks.length === 1) || blocks.some(block => block.appId !== row.appId || block.approvalBatchId !== row.approvalBatchId || block.executionRecordId !== row.executionRecordId || block.actorOpenId !== row.actorOpenId || block.generation !== row.generation)) throw new ConflictException('采购付款取消状态不一致');
      }
      for (const entry of ledger.lifecycleOutbox || []) {
        const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === entry.replica.batchId);
        if (batches.length !== 1 || lifecycleReceiptOwner(batches[0]!) !== entry.replica.appId) throw new ConflictException('采购卡片副本与批次版本不一致');
      }
      for (const batch of ledger.managerApprovalBatches.filter(row => row.stageCardTransition)) {
        const archived = (ledger.lifecycleOutbox || []).filter(entry => entry.replica.batchId === batch.approvalBatchId);
        if (!archived.length || purchaseCutoverDigest(archived) !== batch.stageCardTransition!.originalOutboxSha256) {
          throw new ConflictException('采购分阶段卡片原投递历史已变化');
        }
      }
      for (const batch of ledger.managerApprovalBatches.filter(row => row.flowVersion === 'lifecycle_v1')) {
        for (const person of batch.lifecycleInitialRecipients || []) {
          if (!(ledger.lifecycleOutbox || []).some(entry => entry.replica.batchId === batch.approvalBatchId && entry.replica.appId === batch.lifecycleAppId && entry.replica.recipientOpenId === person.openId)) throw new ConflictException('采购全流程初始副本丢失');
        }
      }
      for (const task of ledger.notifications.filter(row => row.lifecycleBinding)) {
        const binding = task.lifecycleBinding!;
        const batches = ledger.managerApprovalBatches.filter(batch => lifecycleReceiptOwner(batch) && batch.recordIds.includes(task.recordId));
        if (batches.length !== 1 || lifecycleReceiptOwner(batches[0]!) !== binding.appId) throw new ConflictException('采购通知副本批次映射损坏');
        const identity = { appId: binding.appId, batchId: batches[0]!.approvalBatchId, recipientOpenId: task.recipientOpenId };
        const entries = (ledger.lifecycleOutbox || []).filter(entry => lifecycleIdentityKey(entry.replica) === lifecycleIdentityKey(identity));
        if (entries.length !== 1 || binding.deliveryUuid !== purchaseReplicaUuid(identity, binding.generation)) throw new ConflictException('采购通知副本凭据映射损坏');
        const entry = entries[0]!;
        const stage = entry.stageEvents.find(event => event.notificationKey === task.key);
        const receipt = entry.replica.generation === binding.generation && entry.replica.messageId === binding.messageId && entry.replica.appliedRevision >= binding.revision ||
          entry.history.some(history => history.generation === binding.generation && history.messageId === binding.messageId && history.appliedRevision >= binding.revision);
        if (!stage || stage.targetRevision > binding.revision || !receipt || !task.deliveryAudit.some(audit => audit.action === 'lifecycle_replica_bound' && audit.deliveryUuid === binding.deliveryUuid && audit.generation === binding.generation && audit.messageId === binding.messageId)) throw new ConflictException('采购通知副本送达凭据损坏');
      }
      // Only explicitly read-only operations build a private snapshot. Mutations
      // never cache their tentative objects, or pay for an extra full ledger clone.
      if (this.sharedState.readOnlyOperation) this.sharedState.readCache = source.byteLength <= 16 * 1024 * 1024
        ? { source, ledger: structuredClone(ledger) } : undefined;
      return ledger;
    } catch (error) {
      this.sharedState.readCache = undefined;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyLedger();
      throw error;
    }
  }

  private async write(ledger: PurchaseWorkflowLedger): Promise<void> {
    retainPurchaseLedgerCapability(ledger);
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(ledger)}\n`,
        'utf8',
      );
      await rename(temporaryPath, this.ledgerPath);
      // Internal mutations are validated at their entry points, but the next read still
      // normalizes the new bytes before caching. A failed write never publishes state.
      this.sharedState.readCache = undefined;
    } finally {
      await removeFileIfExists(temporaryPath);
    }
  }
}

function validPlatformApprovalPurchaser(value: unknown): value is { openId: string; name: string } {
  return isRecord(value) && Object.keys(value).sort().join(',') === 'name,openId' && typeof value.openId === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(value.openId) &&
    typeof value.name === 'string' && !!value.name && normalizeAccessDisplayName(value.name) === value.name;
}

function normalizePlatformLegacyApprovalClaims(value: unknown): PlatformLegacyApprovalEntry[] {
  if (!Array.isArray(value) || value.length > MAX_MANAGER_APPROVAL_ACTIONS) throw new ConflictException('平台旧采购审批账本损坏');
  const events = new Set<string>(), records = new Set<string>(), actionIds = new Set<string>();
  return value.map(row => {
    if (!isRecord(row) || Object.keys(row).some(key => !['eventId','serverActionId','fingerprint','acceptedAtMs','appId','sourceFingerprint','recordId','originalBatchId','decision','originalPurchaseMethod','purchaseMethod','originalRequesterOpenId','authorityTarget','identity','cards','phase','leaseToken','leaseStartedAtMs','leaseUntilMs','dispatchStartedAtMs','patchHash','resultHash','completedAtMs'].includes(key)) ||
      typeof row.eventId !== 'string' || !/^platform_[A-Za-z0-9_-]{16,64}$/.test(row.eventId) || typeof row.serverActionId !== 'string' || !/^pa_[A-Za-z0-9_-]{43}$/.test(row.serverActionId) || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !Number.isSafeInteger(row.acceptedAtMs) || Number(row.acceptedAtMs) < 1 || typeof row.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(row.appId) || typeof row.recordId !== 'string' || !/^rec[A-Za-z0-9_-]+$/.test(row.recordId) || !['approved','rejected'].includes(row.decision as string) || typeof row.originalPurchaseMethod !== 'string' || !['综合采购','需求自采','需求自采（楼内）','驳回',''].includes(row.originalPurchaseMethod) || (row.decision === 'approved' && !['综合采购','需求自采','需求自采（楼内）'].includes(row.originalPurchaseMethod)) || typeof row.originalRequesterOpenId !== 'string' || (row.originalRequesterOpenId !== '' && !OPEN_ID_PATTERN.test(row.originalRequesterOpenId)) || !['queued','leased','dispatching','manual','confirmed','completed'].includes(row.phase as string) || !Array.isArray(row.cards) || row.cards.length > MAX_MANAGER_APPROVAL_ACTIONS) throw new ConflictException('平台旧采购审批账本损坏');
    if (typeof row.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint) || typeof row.originalBatchId !== 'string' || (row.originalBatchId !== '' && !BATCH_ID_PATTERN.test(row.originalBatchId)) || !normalizePurchaseAuthorityTarget(row.authorityTarget)) throw new ConflictException('平台旧采购审批范围或来源缺失');
    sanitizePlatformCommandIdentity(row.identity);
    // Entries written before explicit method selection carry no purchaseMethod and are
    // verified with the original v1 fingerprint; new entries bind the choice in v2.
    if (row.purchaseMethod !== undefined && (!['综合采购','需求自采','需求自采（楼内）'].includes(row.purchaseMethod as string) || row.decision !== 'approved')) throw new ConflictException('平台旧采购审批方式无效');
    const expectedFingerprint = createHash('sha256').update(JSON.stringify(row.purchaseMethod === undefined
      ? ['platform-legacy-approval-v1',row.appId,row.sourceFingerprint,row.recordId,row.originalBatchId,row.decision,row.originalPurchaseMethod,row.originalRequesterOpenId,row.authorityTarget,row.identity]
      : ['platform-legacy-approval-v2',row.appId,row.sourceFingerprint,row.recordId,row.originalBatchId,row.decision,row.originalPurchaseMethod,row.originalRequesterOpenId,row.authorityTarget,row.identity,row.purchaseMethod])).digest('hex');
    if (row.fingerprint !== expectedFingerprint || (row.phase !== 'queued' && row.phase !== 'completed' && !(row.phase === 'manual' && row.leaseToken === '' && row.leaseStartedAtMs === 0 && row.leaseUntilMs === 0) && (typeof row.leaseToken !== 'string' || !UUID_PATTERN.test(row.leaseToken) || !Number.isSafeInteger(row.leaseStartedAtMs) || !Number.isSafeInteger(row.leaseUntilMs) || Number(row.leaseStartedAtMs) < 1 || Number(row.leaseUntilMs) <= Number(row.leaseStartedAtMs))) || (['dispatching','manual','confirmed','completed'].includes(row.phase as string) && (!Number.isSafeInteger(row.dispatchStartedAtMs) || Number(row.dispatchStartedAtMs) < 1 || typeof row.patchHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.patchHash))) || (['confirmed','completed'].includes(row.phase as string) && (typeof row.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.resultHash))) || (row.phase === 'completed' && (!Number.isSafeInteger(row.completedAtMs) || Number(row.completedAtMs) < 1))) throw new ConflictException('平台旧采购审批执行状态损坏');
    if ((['queued','leased'].includes(row.phase as string) && (row.dispatchStartedAtMs !== undefined || row.patchHash !== undefined || row.resultHash !== undefined || row.completedAtMs !== undefined)) || (['dispatching','manual'].includes(row.phase as string) && (row.resultHash !== undefined || row.completedAtMs !== undefined)) || (row.phase === 'confirmed' && row.completedAtMs !== undefined) || (row.phase === 'queued' && (row.leaseToken !== undefined || row.leaseStartedAtMs !== undefined || row.leaseUntilMs !== undefined)) || (row.phase === 'completed' && (row.leaseToken !== '' || row.leaseStartedAtMs !== 0 || row.leaseUntilMs !== 0))) throw new ConflictException('平台旧采购审批执行状态不一致');
    const keys = new Set<string>();
    for (const card of row.cards) {
      if (!isRecord(card) || Object.keys(card).sort().join(',') !== 'key,messageId,recipientOpenId' || typeof card.key !== 'string' || !card.key || typeof card.messageId !== 'string' || !card.messageId || typeof card.recipientOpenId !== 'string' || !OPEN_ID_PATTERN.test(card.recipientOpenId) || keys.has(card.key)) throw new ConflictException('平台旧采购审批卡片绑定损坏');
      keys.add(card.key);
    }
    if (events.has(row.eventId) || records.has(row.recordId) || actionIds.has(row.serverActionId)) throw new ConflictException('平台旧采购审批认领重复');
    events.add(row.eventId); records.add(row.recordId); actionIds.add(row.serverActionId);
    return structuredClone(row) as unknown as PlatformLegacyApprovalEntry;
  });
}

function replacePlatformLegacyClaim(raw:Record<string,unknown>, entry:PlatformLegacyApprovalEntry):void {
  if (!Array.isArray(raw.platformLegacyApprovalClaims)) throw new ConflictException('平台旧采购审批账本损坏');
  const rows = raw.platformLegacyApprovalClaims.filter(row => isRecord(row) && row.eventId === entry.eventId);
  if (rows.length !== 1) throw new ConflictException('平台旧采购审批记录不唯一');
  const index = raw.platformLegacyApprovalClaims.indexOf(rows[0]); raw.platformLegacyApprovalClaims[index] = structuredClone(entry);
}

function normalizeLifecycleReceiptImageSource(value:unknown):{appId:string;sourceFingerprint:string} {
  if(!isRecord(value) || Object.keys(value).sort().join(',')!=='appId,sourceFingerprint' || typeof value.appId!=='string' || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(value.appId) || typeof value.sourceFingerprint!=='string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint))throw new ConflictException('签收图片持久来源损坏');
  return {appId:value.appId,sourceFingerprint:value.sourceFingerprint};
}
function requirePlatformLegacyLease(ledger:PurchaseWorkflowLedger,eventId:string,token:string):PlatformLegacyApprovalEntry {
  const entry = (ledger.platformLegacyApprovalClaims || []).find(row => row.eventId === eventId), now = Date.now();
  if (!entry || !token || entry.leaseToken !== token || !entry.leaseStartedAtMs || !entry.leaseUntilMs || now < entry.leaseStartedAtMs || now >= entry.leaseUntilMs) throw new ConflictException('平台旧采购审批租约失效');
  return entry;
}
function platformLegacyPolicyClaim(entry:PlatformLegacyApprovalEntry):PlatformLegacyApprovalClaim {
  return {recordId:entry.recordId,eventId:entry.eventId,serverActionId:entry.serverActionId,decision:entry.decision,originalPurchaseMethod:entry.originalPurchaseMethod as PlatformLegacyApprovalClaim['originalPurchaseMethod'],...(entry.purchaseMethod !== undefined ? {purchaseMethod:entry.purchaseMethod as PurchaseWorkflowMethod} : {}),originalBatchId:entry.originalBatchId,originalRequesterOpenId:entry.originalRequesterOpenId,authorityTarget:entry.authorityTarget};
}
function platformLegacyCardChoice(entry:PlatformLegacyApprovalEntry):'comprehensive'|'building_self'|'reject' {
  return entry.decision === 'rejected' ? 'reject' : platformLegacyCardMethod(entry) === '综合采购' ? 'comprehensive' : 'building_self';
}
/** Written method of a completed approval; legacy entries without it keep the original method. */
function platformLegacyCardMethod(entry:PlatformLegacyApprovalEntry):PurchaseWorkflowMethod {
  const selected = entry.purchaseMethod === undefined ? entry.originalPurchaseMethod : entry.purchaseMethod;
  if (!isSelectablePlatformLegacyPurchaseMethod(selected)) throw new ConflictException('平台旧采购审批方式无效');
  return selected;
}

function normalizePlatformApprovalWork(value: unknown): PlatformApprovalWork[] {
  if (!Array.isArray(value) || value.length > MAX_MANAGER_APPROVAL_BATCH_ACTIONS) throw new ConflictException('平台采购审批工作账本损坏');
  const ids = new Set<string>();
  return value.map(raw => {
    if (!isRecord(raw) || typeof raw.eventId !== 'string' || !/^platform_[A-Za-z0-9_-]{16,64}$/.test(raw.eventId) || ids.has(raw.eventId) ||
      !['queued', 'leased', 'dispatching', 'manual', 'confirmed', 'completed'].includes(String(raw.phase)) || typeof raw.leaseToken !== 'string' ||
      !Number.isSafeInteger(raw.leaseStartedAtMs) || !Number.isSafeInteger(raw.leaseUntilMs) || Number(raw.leaseStartedAtMs) < 0 || Number(raw.leaseUntilMs) < 0 ||
      (raw.reason !== undefined && (typeof raw.reason !== 'string' || !/^[a-z_]{1,80}$/.test(raw.reason))) ||
      (raw.patchHash !== undefined && (typeof raw.patchHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.patchHash))) ||
      (raw.resultHash !== undefined && (typeof raw.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.resultHash))) ||
      (raw.dispatchStartedAtMs !== undefined && (!Number.isSafeInteger(raw.dispatchStartedAtMs) || Number(raw.dispatchStartedAtMs) < 1)) ||
      (raw.purchaser !== undefined && !validPlatformApprovalPurchaser(raw.purchaser))) throw new ConflictException('平台采购审批工作账本损坏');
    const permitted = ['eventId','phase','leaseToken','leaseStartedAtMs','leaseUntilMs','dispatchStartedAtMs','patchHash','purchaser','resultHash','reason'];
    if (Object.keys(raw).some(key => !permitted.includes(key))) throw new ConflictException('平台采购审批工作账本损坏');
    const leased = raw.leaseToken !== '';
    if (leased ? !UUID_PATTERN.test(raw.leaseToken as string) || Number(raw.leaseStartedAtMs) < 1 || Number(raw.leaseUntilMs) <= Number(raw.leaseStartedAtMs) : raw.leaseStartedAtMs !== 0 || raw.leaseUntilMs !== 0) throw new ConflictException('平台采购审批租约损坏');
    const dispatched = raw.dispatchStartedAtMs !== undefined;
    if (dispatched !== (raw.patchHash !== undefined) || (['queued', 'leased'].includes(String(raw.phase)) && dispatched) ||
      (['dispatching', 'confirmed', 'completed'].includes(String(raw.phase)) && !dispatched) ||
      (['confirmed', 'completed'].includes(String(raw.phase)) !== (raw.resultHash !== undefined)) ||
      (['queued', 'completed'].includes(String(raw.phase)) && leased) || (raw.phase === 'leased' && !leased)) throw new ConflictException('平台采购审批工作状态损坏');
    ids.add(raw.eventId); return structuredClone(raw) as unknown as PlatformApprovalWork;
  });
}

function replaceRawPlatformApprovalWork(raw: Record<string, unknown>, work: PlatformApprovalWork): void {
  const rows = raw.platformApprovalWork === undefined ? [] : raw.platformApprovalWork;
  if (!Array.isArray(rows)) throw new ConflictException('平台采购审批工作账本损坏');
  const indexes = rows.map((row, index) => isRecord(row) && row.eventId === work.eventId ? index : -1).filter(index => index >= 0);
  if (indexes.length > 1) throw new ConflictException('平台采购审批工作记录重复');
  if (indexes.length) rows[indexes[0]!] = structuredClone(work); else rows.push(structuredClone(work));
  raw.platformApprovalWork = rows;
}

function platformApprovalWorkerJob(claim: PlatformApprovalPersistedAction, batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry, work: PlatformApprovalWork, kind: PlatformApprovalWorkerJob['kind']): PlatformApprovalWorkerJob {
  if (!['processing', 'approved', 'rejected'].includes(item.status)) throw new ConflictException('平台采购审批明细状态无效');
  return { action: structuredClone(claim), leaseToken: work.leaseToken, kind,
    batch: { approvalBatchId: batch.approvalBatchId, flowVersion: batch.flowVersion === 'lifecycle_v1' ? 'lifecycle_v1' : 'legacy', requesterOpenId: batch.requesterOpenId,
      itemRecordId: item.executionRecordId, itemStatus: item.status as 'processing' | 'approved' | 'rejected', itemEventId: item.actionEventId },
    ...(work.purchaser ? { frozenPurchaser: structuredClone(work.purchaser) } : {}) };
}

function requirePlatformApprovalWorkerLease(ledger: PurchaseWorkflowLedger, job: PlatformApprovalWorkerJob, allowCompleted = false): { claim: PlatformApprovalPersistedAction; work: PlatformApprovalWork; batch: PurchaseManagerApprovalBatchEntry } {
  const matches = (ledger.platformApprovalClaims || []).filter(row => row.eventId === job?.action?.eventId);
  const workRows = (ledger.platformApprovalWork || []).filter(row => row.eventId === job?.action?.eventId);
  if (matches.length !== 1 || workRows.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(job.action)) throw new ConflictException('平台采购审批任务身份不一致');
  const claim = matches[0]!, work = workRows[0]!, batches = ledger.managerApprovalBatches.filter(row => row.approvalBatchId === claim.approvalBatchId);
  if (batches.length !== 1) throw new ConflictException('平台采购审批批次无法核对');
  const batch = batches[0]!, items = batch.items.filter(row => row.executionRecordId === claim.recordIds[0]);
  if (items.length !== 1 || job.batch?.approvalBatchId !== batch.approvalBatchId || job.batch.itemRecordId !== claim.recordIds[0] || job.batch.itemEventId !== claim.eventId ||
      job.batch.flowVersion !== (batch.flowVersion === 'lifecycle_v1' ? 'lifecycle_v1' : 'legacy') || job.batch.requesterOpenId !== batch.requesterOpenId) throw new ConflictException('平台采购审批批次已变化');
  if (allowCompleted && work.phase === 'completed') return { claim, work, batch };
  const now = Date.now();
  if (!Number.isSafeInteger(now) || !work.leaseToken || job.leaseToken !== work.leaseToken || now < work.leaseStartedAtMs || now >= work.leaseUntilMs) throw new ConflictException('平台采购审批租约已失效');
  return { claim, work, batch };
}

function mergeRawPlatformApprovalCompletion(raw: Record<string, unknown>, ledger: PurchaseWorkflowLedger, finalized: PurchaseManagerApprovalBatchEntry, itemId: string, oldNotificationKeys: Set<string>): void {
  if (!Array.isArray(raw.managerApprovalBatches) || !Array.isArray(raw.notifications)) throw new ConflictException('采购审批原始账本损坏');
  const batches = raw.managerApprovalBatches.filter(row => isRecord(row) && row.approvalBatchId === finalized.approvalBatchId);
  if (batches.length !== 1 || !isRecord(batches[0]) || !Array.isArray(batches[0].items)) throw new ConflictException('采购审批原始批次无法核对');
  const source = batches[0];
  Object.assign(source, { state: finalized.state, cardContext: finalized.cardContext, selectedRejectRecordId: finalized.selectedRejectRecordId,
    revision: finalized.revision, actorOpenId: finalized.actorOpenId, processedAt: finalized.processedAt, updatedAt: finalized.updatedAt, resolvedAt: finalized.resolvedAt });
  for (const item of finalized.items.filter(row => row.executionRecordId === itemId)) {
    const matches = (source.items as unknown[]).filter(row => isRecord(row) && row.executionRecordId === item.executionRecordId);
    if (matches.length !== 1 || !isRecord(matches[0])) throw new ConflictException('采购审批原始明细无法核对');
    Object.assign(matches[0], { status: item.status, choice: item.choice, rejectionReason: item.rejectionReason, actionEventId: item.actionEventId, ...(item.decisionSource ? { decisionSource: item.decisionSource } : {}), processedAt: item.processedAt, lastError: item.lastError, actorOpenId: item.actorOpenId,
      purchaserOpenId: item.purchaserOpenId, purchaserName: item.purchaserName, ...(item.authorityTarget ? { authorityTarget: item.authorityTarget } : {}) });
  }
  if (source.managerDeliveries !== undefined) {
    if (!Array.isArray(source.managerDeliveries)) throw new ConflictException('采购审批原始收件人损坏');
    for (const delivery of managerBatchDeliveries(finalized)) {
      const matches = source.managerDeliveries.filter(row => isRecord(row) && row.recipientOpenId === delivery.recipientOpenId);
      if (matches.length !== 1 || !isRecord(matches[0])) throw new ConflictException('采购审批原始收件人无法核对');
      matches[0].selectedRejectRecordId = delivery.selectedRejectRecordId;
    }
  }
  for (const notification of ledger.notifications.filter(row => !oldNotificationKeys.has(row.key))) {
    if (raw.notifications.some(row => isRecord(row) && row.key === notification.key)) throw new ConflictException('采购审批原始通知重复');
    raw.notifications.push(structuredClone(notification));
  }
  const entries = (ledger.lifecycleOutbox || []).filter(entry => entry.replica.batchId === finalized.approvalBatchId);
  if (entries.length && !Array.isArray(raw.lifecycleOutbox)) throw new ConflictException('采购卡片原始副本损坏');
  for (const entry of entries) {
    const matches = (raw.lifecycleOutbox as unknown[]).filter(row => isRecord(row) && isRecord(row.replica) && lifecycleIdentityKey(row.replica as unknown as PurchaseReplica) === lifecycleIdentityKey(entry.replica));
    if (matches.length !== 1 || !isRecord(matches[0])) throw new ConflictException('采购卡片原始副本无法核对');
    matches[0].desiredRevision = entry.desiredRevision;
  }
}

function normalizePlatformApprovalClaims(value: unknown): PlatformApprovalPersistedAction[] {
  if (!Array.isArray(value) || value.length > MAX_MANAGER_APPROVAL_BATCH_ACTIONS) throw new ConflictException('平台采购审批账本损坏');
  const ids = new Set<string>(), serverIds = new Set<string>(), itemKeys = new Set<string>();
  return value.map(raw => {
    if (!isRecord(raw) || raw.source !== 'platform' || raw.status !== 'pending' || typeof raw.eventId !== 'string' || !/^platform_[A-Za-z0-9_-]{16,64}$/.test(raw.eventId) ||
        typeof raw.approvalBatchId !== 'string' || !BATCH_ID_PATTERN.test(raw.approvalBatchId) || typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint) || typeof raw.serverActionId !== 'string' || !/^pa_[A-Za-z0-9_-]{43}$/.test(raw.serverActionId) || !Number.isSafeInteger(raw.acceptedAtMs) || Number(raw.acceptedAtMs) < 1 ||
        !Array.isArray(raw.recordIds) || raw.recordIds.length !== 1 || typeof raw.recordIds[0] !== 'string' || !/^rec[A-Za-z0-9_-]+$/.test(raw.recordIds[0]) ||
        (raw.choice !== 'comprehensive' && raw.choice !== 'building_self' && raw.choice !== 'reject') || typeof raw.rejectionReason !== 'string' ||
        (raw.choice === 'reject' ? raw.rejectionReason!==raw.rejectionReason.trim() || Array.from(raw.rejectionReason).length > 500 : raw.rejectionReason !== '') ||
        typeof raw.actorAccountId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(raw.actorAccountId) || typeof raw.subjectAccountId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(raw.subjectAccountId) ||
        typeof raw.actorDisplayName !== 'string' || !raw.actorDisplayName || raw.actorDisplayName.length > 128 || normalizeAccessDisplayName(raw.actorDisplayName) !== raw.actorDisplayName || typeof raw.subjectDisplayName !== 'string' || !raw.subjectDisplayName || raw.subjectDisplayName.length > 128 || normalizeAccessDisplayName(raw.subjectDisplayName) !== raw.subjectDisplayName ||
        !Number.isSafeInteger(raw.actorAuthorizationVersion) || Number(raw.actorAuthorizationVersion) < 1 || !Number.isSafeInteger(raw.subjectAuthorizationVersion) || Number(raw.subjectAuthorizationVersion) < 1 ||
        (raw.identitySource !== 'platform' && raw.identitySource !== 'impersonation') || (raw.identitySource === 'platform' && (raw.actorAccountId !== raw.subjectAccountId || raw.actorAuthorizationVersion !== raw.subjectAuthorizationVersion || raw.actorDisplayName !== raw.subjectDisplayName)) ||
        typeof raw.sessionFamilyFingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.sessionFamilyFingerprint) || !Number.isSafeInteger(raw.sessionExpiresAt) || Number(raw.sessionExpiresAt) < 1 ||
        (raw.actorFeishuOpenId !== undefined && (typeof raw.actorFeishuOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(raw.actorFeishuOpenId)))) throw new ConflictException('平台采购审批账本损坏');
    const keys = ['source','status','eventId','serverActionId','acceptedAtMs','approvalBatchId','fingerprint','recordIds','choice','rejectionReason','actorAccountId','actorDisplayName','actorAuthorizationVersion','subjectAccountId','subjectDisplayName','subjectAuthorizationVersion','identitySource','authorityTarget','sessionFamilyFingerprint','sessionExpiresAt', ...(raw.actorFeishuOpenId === undefined ? [] : ['actorFeishuOpenId'])].sort().join(',');
    if (Object.keys(raw).sort().join(',') !== keys || !normalizePurchaseAuthorityTarget(raw.authorityTarget)) throw new ConflictException('平台采购审批账本损坏');
    const key = `${raw.approvalBatchId}:${raw.recordIds[0]}`;
    if (ids.has(raw.eventId) || serverIds.has(raw.serverActionId) || itemKeys.has(key)) throw new ConflictException('平台采购审批认领重复');
    ids.add(raw.eventId); serverIds.add(raw.serverActionId); itemKeys.add(key);
    return structuredClone(raw) as unknown as PlatformApprovalPersistedAction;
  });
}

function lifecycleIdentityKey(identity: PurchaseReplicaIdentity): string {
  newPurchaseReplica(identity);
  return JSON.stringify([identity.appId, identity.batchId, identity.recipientOpenId]);
}

function normalizeLifecycleView(value: unknown): PurchaseLifecycleView {
  if (value === undefined) return { kind: 'list' };
  if (!isRecord(value)) throw new ConflictException('采购卡片视图损坏');
  if (value.kind === 'list' && Object.keys(value).length === 1) return { kind: 'list' };
  if ((value.kind === 'reject' || value.kind === 'order' || value.kind === 'receipt') && Object.keys(value).sort().join(',') === 'kind,recordId' && typeof value.recordId === 'string' && RECORD_ID_PATTERN.test(value.recordId)) return { kind: value.kind, recordId: value.recordId };
  throw new ConflictException('采购卡片视图无效');
}

function normalizeLifecycleOutbox(value: unknown): PurchaseLifecycleOutboxEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIFECYCLE_REPLICAS) throw new ConflictException('采购卡片投递账本损坏');
  const keys = new Set<string>();
  return value.map((raw): PurchaseLifecycleOutboxEntry => {
    if (!isRecord(raw) || !isRecord(raw.replica) || !Array.isArray(raw.history) || raw.history.length >= MAX_LIFECYCLE_GENERATIONS || (raw.fullView !== undefined && raw.fullView !== true) ||
      !Number.isSafeInteger(raw.desiredRevision) || (raw.desiredRevision as number) < 1 || typeof raw.attemptToken !== 'string' ||
      !Number.isSafeInteger(raw.desiredPage) || (raw.desiredPage as number) < 1 || (raw.desiredPage as number) > 200 ||
      !Number.isSafeInteger(raw.appliedPage) || (raw.appliedPage as number) < 0 || (raw.appliedPage as number) > 200 || !Array.isArray(raw.pageEvents) || raw.pageEvents.length > 1000 || !Array.isArray(raw.stageEvents) || raw.stageEvents.length > 1000 ||
      !Number.isSafeInteger(raw.nextAttemptAtMs) || (raw.nextAttemptAtMs as number) < 0 || !Number.isSafeInteger(raw.failureCount) || (raw.failureCount as number) < 0 || (raw.failureCount as number) > 20 ||
      ((raw.failureCount as number) === 0 ? raw.nextAttemptAtMs !== 0 || raw.retryReason !== undefined : (raw.nextAttemptAtMs as number) < 1 || (raw.retryReason !== 'source' && raw.retryReason !== 'authorization'))) throw new ConflictException('采购卡片投递账本损坏');
    const replica = raw.replica as unknown as PurchaseReplica;
    let key: string;
    try {
      key = lifecycleIdentityKey(replica);
      planPurchaseReplica(replica, replica, raw.desiredRevision as number, false, 1);
    } catch { throw new ConflictException('采购卡片副本状态损坏'); }
    const pending = replica.state === 'send_unknown' || replica.state === 'update_unknown';
    if (keys.has(key) || (raw.desiredRevision as number) < replica.appliedRevision || (raw.desiredRevision as number) < replica.pendingRevision ||
      (pending ? !UUID_PATTERN.test(raw.attemptToken) || (raw.dispatchPhase !== 'prepared' && raw.dispatchPhase !== 'dispatch_started') || !Number.isSafeInteger(raw.pendingPage) || (raw.pendingPage as number) < 1 || (raw.pendingPage as number) > 200 : raw.attemptToken !== '' || raw.dispatchPhase !== undefined || raw.pendingPage !== undefined) ||
      (raw.preparedUntilMs !== undefined && (raw.dispatchPhase !== 'prepared' || !Number.isSafeInteger(raw.preparedUntilMs) || (raw.preparedUntilMs as number) < 1)) ||
      ((raw.appliedTotalPages === undefined) !== (raw.appliedAuthorizationFingerprint === undefined)) ||
      (raw.appliedTotalPages !== undefined && (!Number.isSafeInteger(raw.appliedTotalPages) || (raw.appliedTotalPages as number) < (raw.appliedPage as number) || (raw.appliedTotalPages as number) > 200 || typeof raw.appliedAuthorizationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.appliedAuthorizationFingerprint))) ||
      (replica.appliedRevision > 0 ? (raw.appliedPage as number) < 1 : raw.appliedPage !== 0)) throw new ConflictException('采购卡片投递账本冲突');
    keys.add(key);
    const desiredView = normalizeLifecycleView(raw.desiredView);
    const pendingView = pending ? normalizeLifecycleView(raw.pendingView) : undefined;
    const appliedView = raw.appliedView === undefined ? undefined : normalizeLifecycleView(raw.appliedView);
    if (!pending && raw.pendingView !== undefined) throw new ConflictException('采购卡片待发送视图状态冲突');
    if (raw.viewEvents !== undefined && (!Array.isArray(raw.viewEvents) || raw.viewEvents.length > 1000)) throw new ConflictException('采购卡片视图事件损坏');
    const seenViews = new Set<string>();
    const viewEvents = (Array.isArray(raw.viewEvents) ? raw.viewEvents : []).map(event => {
      if (!isRecord(event) || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > MAX_EVENT_ID_LENGTH || seenViews.has(event.eventId) || !Number.isSafeInteger(event.sourceRevision) || (event.sourceRevision as number) < 1 || !['reject', 'order', 'receipt'].includes(String(event.kind)) || typeof event.recordId !== 'string' || !RECORD_ID_PATTERN.test(event.recordId)) throw new ConflictException('采购卡片视图事件损坏');
      seenViews.add(event.eventId);
      return { eventId: event.eventId, sourceRevision: event.sourceRevision as number, kind: String(event.kind), recordId: event.recordId };
    });
    const eventIds = new Set<string>();
    const pageEvents = raw.pageEvents.map(event => {
      if (!isRecord(event) || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > MAX_EVENT_ID_LENGTH || eventIds.has(event.eventId) || !Number.isSafeInteger(event.sourceRevision) || (event.sourceRevision as number) < 1 || !Number.isSafeInteger(event.targetPage) || (event.targetPage as number) < 1 || (event.targetPage as number) > 200) throw new ConflictException('采购卡片翻页记录损坏');
      eventIds.add(event.eventId);
      return { eventId: event.eventId, sourceRevision: event.sourceRevision as number, targetPage: event.targetPage as number };
    });
    const stageKeys = new Set<string>();
    const stageEvents = raw.stageEvents.map(event => {
      if (!isRecord(event) || typeof event.notificationKey !== 'string' || !event.notificationKey || event.notificationKey.length > 1000 || stageKeys.has(event.notificationKey) || !Number.isSafeInteger(event.targetRevision) || (event.targetRevision as number) < 1 || (event.targetRevision as number) > (raw.desiredRevision as number)) throw new ConflictException('采购卡片阶段投递记录损坏');
      stageKeys.add(event.notificationKey);
      return { notificationKey: event.notificationKey, targetRevision: event.targetRevision as number };
    });
    const seen = new Set<string>();
    const history = raw.history.map((entry, index) => {
      if (!isRecord(entry) || entry.generation !== index + 1 || typeof entry.messageId !== 'string' || !/^om_[A-Za-z0-9_-]{1,124}$/.test(entry.messageId) ||
        seen.has(entry.messageId) || !Number.isSafeInteger(entry.sentAtMs) || (entry.sentAtMs as number) < 1 || !Number.isSafeInteger(entry.appliedRevision) || (entry.appliedRevision as number) < 1) throw new ConflictException('采购卡片续接历史损坏');
      seen.add(entry.messageId);
      return { generation: entry.generation as number, messageId: entry.messageId, sentAtMs: entry.sentAtMs as number, appliedRevision: entry.appliedRevision as number };
    });
    if (replica.generation !== history.length + 1 || (history.length > 0 && history[history.length - 1]!.messageId !== replica.predecessorMessageId) ||
      (replica.messageId && seen.has(replica.messageId))) throw new ConflictException('采购卡片续接历史冲突');
    return { replica: structuredClone(replica), desiredRevision: raw.desiredRevision as number, desiredPage: raw.desiredPage as number, appliedPage: raw.appliedPage as number, desiredView, ...(pendingView ? { pendingView } : {}), ...(appliedView ? { appliedView } : {}), viewEvents, ...(raw.appliedTotalPages !== undefined ? { appliedTotalPages: raw.appliedTotalPages as number, appliedAuthorizationFingerprint: raw.appliedAuthorizationFingerprint as string } : {}), pageEvents, stageEvents, nextAttemptAtMs: raw.nextAttemptAtMs as number, failureCount: raw.failureCount as number, ...(raw.retryReason ? { retryReason: raw.retryReason as 'source' | 'authorization' } : {}), attemptToken: raw.attemptToken, ...(pending ? { dispatchPhase: raw.dispatchPhase as 'prepared' | 'dispatch_started', pendingPage: raw.pendingPage as number } : {}), ...(raw.preparedUntilMs !== undefined ? { preparedUntilMs: raw.preparedUntilMs as number } : {}), ...(raw.fullView === true ? { fullView: true as const } : {}), history };
  });
}

function assertLifecycleBatch(ledger: PurchaseWorkflowLedger, identity: PurchaseReplicaIdentity, authorize: (batch: PurchaseManagerApprovalBatchEntry) => void): void {
  lifecycleIdentityKey(identity);
  if (typeof authorize !== 'function') throw new ForbiddenException('采购卡片授权不可用');
  const batches = ledger.managerApprovalBatches.filter(batch => batch.approvalBatchId === identity.batchId);
  if (batches.length !== 1 || !batches[0]) throw new ConflictException('采购卡片批次无法核对');
  if (batches[0].flowVersion !== 'lifecycle_v1') throw new ConflictException('原有采购批次不能切换全流程卡片');
  assertSynchronousLifecycleAuthorization(() => authorize(structuredClone(batches[0]!)));
}

function lifecycleReceiptOwner(batch: PurchaseManagerApprovalBatchEntry): string | undefined {
  return batch.flowVersion === 'lifecycle_v1' ? batch.lifecycleAppId : batch.stageCardTransition?.appId;
}

function stageCardTransitionBatchIds(ledger: PurchaseWorkflowLedger): Set<string> {
  return new Set(ledger.managerApprovalBatches.filter(batch => batch.stageCardTransition).map(batch => batch.approvalBatchId));
}

function purchaseCutoverDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hasStageCardCutoverAmbiguity(
  ledger: PurchaseWorkflowLedger,
  batch: PurchaseManagerApprovalBatchEntry,
  recordIds: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  const batchId = batch.approvalBatchId;
  const prepares = ledger.lifecycleReceiptPrepareQueue?.tasks || [];
  const images = ledger.lifecycleReceiptImageLedger?.intents || [];
  const platformEvents = new Set((ledger.platformApprovalClaims || []).filter(claim => claim.recordIds.some(id => recordIds.has(id))).map(claim => claim.eventId));
  return ledger.commands.some(row => recordIds.has(row.recordId) && !row.completedAt && !terminalReceiptForHeldOrder(ledger, batch, row, now)) ||
    ledger.cardActions.some(row => recordIds.has(row.recordId) && isActiveStatus(row.status)) ||
    ledger.managerApprovalActions.some(row => recordIds.has(row.recordId) && isActiveStatus(row.status)) ||
    ledger.managerApprovalBatchActions.some(row => row.approvalBatchId === batchId && isActiveStatus(row.status)) ||
    ledger.notifications.some(row => recordIds.has(row.recordId) && (
      row.status === 'processing' || ['unknown', 'manual_reconciliation'].includes(row.sendOutcome) ||
      (isActiveStatus(row.status) && (isPurchaseBatchFulfillmentCommandKind(row.kind) || row.kind === 'web_receipt_command')))) ||
    (ledger.platformApprovalWork || []).some(row => platformEvents.has(row.eventId) && row.phase !== 'completed') ||
    (ledger.platformLegacyApprovalClaims || []).some(row => recordIds.has(row.recordId) && row.phase !== 'completed') ||
    ledger.personnelHandovers.some(row => row.approvalBatchId === batchId && row.status !== 'completed') ||
    (ledger.lifecyclePaymentUploads || []).some(row => row.approvalBatchId === batchId && !['committed', 'cancelled'].includes(row.entry.status)) ||
    prepares.some(row => row.identity.approvalBatchId === batchId && (row.state === 'pending' || row.state === 'processing')) ||
    images.some(row => row.approvalBatchId === batchId && (row.state === 'open' || row.state === 'bound'));
}

function terminalReceiptForHeldOrder(
  ledger: PurchaseWorkflowLedger, batch: PurchaseManagerApprovalBatchEntry, command: PurchaseWorkflowCommandEntry, now: number,
): PurchaseWebReceiptCommand | undefined {
  const recordId = command.recordId;
  const startedAt = Date.parse(command.startedAt);
  if (command.action !== 'order' || command.key !== 'order:' + recordId || command.completedAt ||
      !command.platformIdentity || command.platformDispatch !== 'dispatch_started' || !command.platformAttemptId ||
      !Number.isFinite(startedAt) || now - startedAt < 5 * 60_000) return undefined;
  const item = batch.items.find(row => row.executionRecordId === recordId);
  if (item?.status !== 'approved' || !item.authorityTarget ||
      !Number.isFinite(Date.parse(item.processedAt)) || Date.parse(item.processedAt) > startedAt) return undefined;
  const receive = ledger.commands.find(row => row.recordId === recordId && row.key === 'receive:' + recordId &&
    row.action === 'receive' && row.platformDispatch === 'dispatch_started' && !!row.platformAttemptId && !!row.platformIdentity &&
    Date.parse(row.startedAt) > startedAt && Date.parse(row.completedAt) >= Date.parse(row.startedAt));
  if (!receive) return undefined;
  const task = ledger.notifications.find(row => row.recordId === recordId && row.kind === 'web_receipt_command' &&
    row.status === 'completed' && Date.parse(row.completedAt) >= Date.parse(receive.completedAt) &&
    row.webReceipt?.recordId === recordId && row.webReceipt.appId === batch.lifecycleAppId &&
    row.webReceipt.platformIdentity && row.webReceipt.files.every(file => !!file.token) &&
    purchaseCutoverDigest(row.webReceipt.platformIdentity) === purchaseCutoverDigest(receive.platformIdentity) &&
    purchaseCutoverDigest(row.webReceipt.scope) === purchaseCutoverDigest(item.authorityTarget));
  if (!task || !ledger.notifications.some(row => row.recordId === recordId && row.kind === 'inventory_inbound_completed_resolution' &&
      row.businessEventId === 'inventory-inbound-completed-resolution:' + recordId && row.status === 'completed' &&
      Date.parse(row.completedAt) >= Date.parse(task.completedAt))) return undefined;
  return task.webReceipt;
}

function isHeldTerminalOrder(ledger: PurchaseWorkflowLedger, command: PurchaseWorkflowCommandEntry): boolean {
  return command.action === 'order' && ledger.managerApprovalBatches.some(batch =>
    batch.stageCardTransition?.heldTerminalOrders?.some(item => item.recordId === command.recordId));
}

function stageCardCutoverRecordMatches(item: PurchaseManagerApprovalBatchItemEntry, record: PurchaseWorkflowRecord): boolean {
  const stage = resolvePurchaseStage(record.status);
  if (item.status === 'pending' || item.status === 'manual_reconciliation') {
    return stage === 'application' && !record.approvalActionId && !record.approvalCompleted &&
      !record.purchaseCompleted && !record.receiptConfirmed;
  }
  if (!item.actionEventId || record.approvalActionId !== item.actionEventId) return false;
  if (item.status === 'rejected') return stage === 'terminated';
  // The manager card's approval patch stamps its action and updates the workflow
  // and warehouse fields. It does not update the historical approval checkbox.
  const approved = record.approvalCompleted || (record.approvalSource === '程序卡片' &&
    record.approvalWorkflowStatus === '已通过' && record.warehouseConfirmed);
  return item.status === 'approved' && approved && OPEN_ID_PATTERN.test(record.purchaserOpenId) &&
    ['approval', 'ordering', 'receipt', 'inbound', 'completed'].includes(stage) &&
    item.purchaserOpenId === record.purchaserOpenId;
}

function hasUnconfirmedSourceOrdering(record: PurchaseWorkflowRecord): boolean {
  return record.status === '审批通过（待下单）' && !record.approvalActionId && !record.purchaserOpenId &&
    !record.approvalCompleted && !record.warehouseConfirmed && !record.purchaseCompleted && !record.receiptConfirmed &&
    !['已通过', '已驳回'].includes(record.approvalWorkflowStatus || '');
}

function assertSynchronousLifecycleAuthorization(authorize: () => unknown): void {
  const result = authorize();
  if (result !== undefined) {
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) void Promise.resolve(result).catch(() => undefined);
    throw new ForbiddenException('采购卡片授权必须在锁内同步完成');
  }
}

function findLifecycleEntry(entries: PurchaseLifecycleOutboxEntry[], identity: PurchaseReplicaIdentity): PurchaseLifecycleOutboxEntry {
  const key = lifecycleIdentityKey(identity);
  const entry = entries.find(item => lifecycleIdentityKey(item.replica) === key);
  if (!entry) throw new ConflictException('采购卡片投递任务不存在');
  return entry;
}

/** Call inside the workflow ledger transaction with a server-issued monotonic revision. */
export function upsertLifecycleEntry(entries: PurchaseLifecycleOutboxEntry[], identity: PurchaseReplicaIdentity, desiredRevision: number, fullView?: boolean): PurchaseLifecycleOutboxEntry {
  if (!Number.isSafeInteger(desiredRevision) || desiredRevision < 1) throw new BadRequestException('采购卡片版本无效');
  const key = lifecycleIdentityKey(identity);
  let entry = entries.find(item => lifecycleIdentityKey(item.replica) === key);
  if (!entry) {
    if (entries.length >= MAX_LIFECYCLE_REPLICAS) throw new ServiceUnavailableException('采购卡片投递队列已满');
    entry = { replica: newPurchaseReplica(identity), desiredRevision, desiredPage: 1, appliedPage: 0, pageEvents: [], stageEvents: [], nextAttemptAtMs: 0, failureCount: 0, attemptToken: '', ...(fullView ? { fullView: true as const } : {}), history: [] };
    entries.push(entry);
  } else {
    entry.desiredRevision = Math.max(entry.desiredRevision, desiredRevision);
    if (fullView === true) entry.fullView = true;
    else if (fullView === false) delete entry.fullView;
  }
  return entry;
}

/** Marks only existing recipients; dispatch rechecks each recipient's live authorization. */
function queueExistingLifecycleBatchRefresh(ledger: PurchaseWorkflowLedger, batch: PurchaseManagerApprovalBatchEntry): void {
  if (batch.flowVersion !== 'lifecycle_v1') return;
  const entries = (ledger.lifecycleOutbox || []).filter(entry => entry.replica.batchId === batch.approvalBatchId);
  if (!entries.length) return;
  const revision = Math.max(...entries.map(entry => entry.desiredRevision)) + 1;
  if (!Number.isSafeInteger(revision)) throw new ConflictException('采购卡片版本已达上限');
  for (const entry of entries) upsertLifecycleEntry(ledger.lifecycleOutbox!, entry.replica, revision);
}

function getSharedLedgerState(ledgerPath: string): SharedLedgerState {
  const existing = sharedLedgerStates.get(ledgerPath);
  if (existing) return existing;
  const created: SharedLedgerState = {
    ledgerPath,
    lockPath: `${ledgerPath}.lock`,
    instanceId: randomUUID(),
    operation: new FairOperationQueue(),
    refCount: 0,
    lockPromise: null,
    lockOwned: false,
  };
  sharedLedgerStates.set(ledgerPath, created);
  return created;
}

async function acquireLedgerLock(
  state: SharedLedgerState,
  retried = false,
): Promise<void> {
  await mkdir(dirname(state.ledgerPath), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(state.lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new ServiceUnavailableException('采购工作流账本锁创建失败');
    }
    return handleExistingLedgerLock(state, retried);
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        instanceId: state.instanceId,
      })}\n`,
      'utf8',
    );
  } catch {
    await handle.close();
    await removeFileIfExists(state.lockPath);
    throw new ServiceUnavailableException('采购工作流账本锁写入失败');
  }
  await handle.close();
  state.lockOwned = true;
}

async function handleExistingLedgerLock(
  state: SharedLedgerState,
  retried: boolean,
): Promise<void> {
  let inspection = await inspectLedgerLock(state.lockPath);
  if (inspection.kind === 'invalid') {
    await delay(INVALID_LOCK_REREAD_DELAY_MS);
    inspection = await inspectLedgerLock(state.lockPath);
  }

  if (inspection.kind === 'missing') {
    return retryLedgerLockAcquire(state, retried);
  }
  if (inspection.kind === 'owner') {
    const { owner } = inspection;
    if (owner.pid === process.pid && owner.instanceId === state.instanceId) {
      state.lockOwned = true;
      return;
    }
    if (isProcessAlive(owner.pid)) {
      throw new LedgerLockContentionException('采购工作流账本已由另一进程占用');
    }
    return quarantineAndRetryLedgerLock(state, retried);
  }

  const ageMs = await ledgerLockAgeMs(state.lockPath);
  if (ageMs === null) return retryLedgerLockAcquire(state, retried);
  if (ageMs < INVALID_LOCK_GRACE_MS) {
    throw new LedgerLockContentionException('采购工作流账本锁正在初始化');
  }
  return quarantineAndRetryLedgerLock(state, retried);
}

async function retryLedgerLockAcquire(
  state: SharedLedgerState,
  retried: boolean,
): Promise<void> {
  if (retried) {
    throw new ServiceUnavailableException('采购工作流账本锁恢复失败');
  }
  return acquireLedgerLock(state, true);
}

async function quarantineAndRetryLedgerLock(
  state: SharedLedgerState,
  retried: boolean,
): Promise<void> {
  if (retried) {
    throw new ServiceUnavailableException('采购工作流账本锁恢复失败');
  }
  const releaseRecoveryGuard = await acquireLedgerRecoveryGuard(state);
  try {
    let inspection = await inspectLedgerLock(state.lockPath);
    if (inspection.kind === 'invalid') {
      await delay(INVALID_LOCK_REREAD_DELAY_MS);
      inspection = await inspectLedgerLock(state.lockPath);
    }
    if (inspection.kind === 'missing') {
      return retryLedgerLockAcquire(state, retried);
    }
    if (inspection.kind === 'owner') {
      const { owner } = inspection;
      if (owner.pid === process.pid && owner.instanceId === state.instanceId) {
        state.lockOwned = true;
        return;
      }
      if (isProcessAlive(owner.pid)) {
        throw new LedgerLockContentionException(
          '采购工作流账本已由另一进程占用',
        );
      }
    } else {
      const ageMs = await ledgerLockAgeMs(state.lockPath);
      if (ageMs === null) return retryLedgerLockAcquire(state, retried);
      if (ageMs < INVALID_LOCK_GRACE_MS) {
        throw new LedgerLockContentionException('采购工作流账本锁正在初始化');
      }
    }

    const quarantined = await quarantineLedgerLock(state.lockPath);
    if (!quarantined) return retryLedgerLockAcquire(state, retried);
    return acquireLedgerLock(state, true);
  } finally {
    await releaseRecoveryGuard();
  }
}

async function acquireLedgerRecoveryGuard(
  state: SharedLedgerState,
): Promise<() => Promise<void>> {
  const guardPath = `${state.lockPath}.recovery`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(guardPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LedgerLockContentionException(
        '采购工作流账本锁正在由另一进程恢复',
      );
    }
    throw new ServiceUnavailableException('采购工作流账本恢复锁创建失败');
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        instanceId: state.instanceId,
      })}\n`,
      'utf8',
    );
  } catch {
    await handle.close();
    await removeFileIfExists(guardPath);
    throw new ServiceUnavailableException('采购工作流账本恢复锁写入失败');
  }
  await handle.close();
  return async () => {
    const inspection = await inspectLedgerLock(guardPath);
    if (
      inspection.kind === 'owner' &&
      inspection.owner.pid === process.pid &&
      inspection.owner.instanceId === state.instanceId
    ) {
      await removeFileIfExists(guardPath);
    }
  };
}

async function quarantineLedgerLock(lockPath: string): Promise<boolean> {
  const quarantinePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ServiceUnavailableException('采购工作流账本锁隔离失败');
  }
  try {
    await unlink(quarantinePath);
  } catch {
    process.emitWarning(
      'Purchase workflow stale lock was quarantined but cleanup failed; startup will continue.',
      { code: 'PURCHASE_WORKFLOW_STALE_LOCK_CLEANUP_FAILED' },
    );
  }
  return true;
}

async function ledgerLockAgeMs(lockPath: string): Promise<number | null> {
  try {
    const details = await stat(lockPath);
    return Math.max(0, Date.now() - details.mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ServiceUnavailableException('采购工作流账本锁状态读取失败');
  }
}

async function inspectLedgerLock(
  lockPath: string,
): Promise<LedgerLockInspection> {
  let text: string;
  try {
    text = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw new ServiceUnavailableException('采购工作流账本锁读取失败');
  }
  try {
    const value = JSON.parse(text) as {
      pid?: unknown;
      instanceId?: unknown;
    };
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.instanceId !== 'string' ||
      !value.instanceId
    ) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'owner',
      owner: { pid: value.pid as number, instanceId: value.instanceId },
    };
  } catch {
    return { kind: 'invalid' };
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH' && code !== 'EINVAL';
  }
}

async function releaseLedgerLock(state: SharedLedgerState): Promise<void> {
  if (!state.lockOwned) return;
  try {
    const inspection = await inspectLedgerLock(state.lockPath);
    if (inspection.kind !== 'owner') return;
    const { owner } = inspection;
    if (owner.pid === process.pid && owner.instanceId === state.instanceId) {
      await removeFileIfExists(state.lockPath);
    }
  } catch (error) {
    if (!(error instanceof ServiceUnavailableException)) throw error;
  } finally {
    state.lockOwned = false;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function normalizePurchaseManagerHandoverInput(value: PurchaseManagerBatchHandoverInput): PurchaseManagerBatchHandoverInput {
  if (!value || !value.target || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 || value.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    !/^handover-[a-f0-9]{64}$/u.test(value.mutationId) || !/^rec[A-Za-z0-9_]+$/u.test(value.dutyRecordId) ||
    !/^rec[A-Za-z0-9_]+$/u.test(value.sourcePersonRecordId) || !/^rec[A-Za-z0-9_]+$/u.test(value.target.personRecordId) ||
    value.sourcePersonRecordId === value.target.personRecordId || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(value.sourceOpenId) ||
    !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(value.target.openId) || value.sourceOpenId === value.target.openId ||
    typeof value.target.name !== 'string' || !value.target.name.trim() || value.target.name.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(value.target.name)) {
    throw new BadRequestException('采购交接人员、职责或版本无效');
  }
  return { approvalBatchId: normalizeManagerApprovalBatchId(value.approvalBatchId), expectedRevision: value.expectedRevision,
    mutationId: value.mutationId, dutyRecordId: value.dutyRecordId, sourcePersonRecordId: value.sourcePersonRecordId,
    sourceOpenId: value.sourceOpenId, target: { personRecordId: value.target.personRecordId, openId: value.target.openId, name: value.target.name.trim() } };
}

function normalizePurchaseManagerHandovers(value: unknown): PurchaseManagerBatchHandover[] {
  if (!Array.isArray(value) || value.length > 2000) throw new ServiceUnavailableException('采购交接账本结构无效');
  const mutations = new Set<string>();
  return value.map(raw => {
    if (!isRecord(raw)) throw new ServiceUnavailableException('采购交接账本证据无效');
    const input = normalizePurchaseManagerHandoverInput(raw as unknown as PurchaseManagerBatchHandoverInput);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (mutations.has(input.mutationId) || raw.fingerprint !== fingerprint || raw.targetRevision !== input.expectedRevision + 1 ||
      !['pending', 'processing', 'completed', 'failed'].includes(String(raw.status)) || !isoText(raw.acceptedAt) ||
      typeof raw.oldMessageId !== 'string' || !FEISHU_MESSAGE_ID_PATTERN.test(raw.oldMessageId) || typeof raw.oldCardContext !== 'string' ||
      !Array.isArray(raw.pendingRecordIds) || !raw.pendingRecordIds.length || raw.pendingRecordIds.some(id => typeof id !== 'string' || !RECORD_ID_PATTERN.test(id)) ||
      new Set(raw.pendingRecordIds).size !== raw.pendingRecordIds.length) throw new ServiceUnavailableException('采购交接账本指纹或阶段不一致');
    const context = parsePurchaseManagerBatchApprovalCardContext(raw.oldCardContext);
    if (context.approvalBatchId !== input.approvalBatchId || context.requesterOpenId === input.target.openId ||
      raw.pendingRecordIds.some(id => !context.items.some(item => item.executionRecordId === id))) throw new ServiceUnavailableException('采购交接原卡与批次不一致');
    const confirmed = raw.confirmedRecordIds === undefined ? [] : raw.confirmedRecordIds;
    const pendingRecordIds = raw.pendingRecordIds as string[];
    if (!Array.isArray(confirmed) || confirmed.some(id => !pendingRecordIds.includes(id)) || new Set(confirmed).size !== confirmed.length ||
      (raw.oldCardPatchedAt !== undefined && !isoText(raw.oldCardPatchedAt)) || confirmed.length > 0 && !raw.oldCardPatchedAt ||
      raw.status === 'completed' && (!raw.oldCardPatchedAt || confirmed.length !== raw.pendingRecordIds.length) ||
      raw.status === 'processing' && (typeof raw.claimToken !== 'string' || !UUID_PATTERN.test(raw.claimToken) || !isoText(raw.leaseUntil))) throw new ServiceUnavailableException('采购交接进度或租约证据无效');
    if (raw.deliveryClaimToken !== undefined && (typeof raw.deliveryClaimToken !== 'string' || !UUID_PATTERN.test(raw.deliveryClaimToken) || !isoText(raw.deliveryLeaseUntil)) ||
      raw.deliveryConfirmedAt !== undefined && (!isoText(raw.deliveryConfirmedAt) || typeof raw.newMessageId !== 'string' || !FEISHU_MESSAGE_ID_PATTERN.test(raw.newMessageId)) ||
      raw.newMessageId !== undefined && !raw.deliveryConfirmedAt || raw.deliveryNextAttemptAt !== undefined && !isoText(raw.deliveryNextAttemptAt)) throw new ServiceUnavailableException('采购交接投递回执证据无效');
    const deliveryRecords = raw.deliveryConfirmedRecordIds === undefined ? [] : raw.deliveryConfirmedRecordIds;
    if (!Array.isArray(deliveryRecords) || deliveryRecords.some(id => !pendingRecordIds.includes(id)) || new Set(deliveryRecords).size !== deliveryRecords.length ||
      raw.deliveryConfirmedAt && deliveryRecords.length !== pendingRecordIds.length) throw new ServiceUnavailableException('采购投递回执明细证据无效');
    mutations.add(input.mutationId);
    return { ...input, fingerprint, targetRevision: raw.targetRevision as number, pendingRecordIds: raw.pendingRecordIds as string[],
      oldMessageId: raw.oldMessageId, oldCardContext: raw.oldCardContext, acceptedAt: raw.acceptedAt as string, status: raw.status as PurchaseWorkflowQueueStatus,
      attempts: safeAttempts(raw.attempts), claimToken: raw.status === 'processing' ? String(raw.claimToken) : '', leaseUntil: raw.status === 'processing' ? String(raw.leaseUntil) : '',
      nextAttemptAt: isoText(raw.nextAttemptAt) || String(raw.acceptedAt), confirmedRecordIds: confirmed as string[], lastError: sanitizeError(raw.lastError),
      ...(raw.oldCardPatchedAt ? { oldCardPatchedAt: String(raw.oldCardPatchedAt) } : {}),
      ...(raw.deliveryClaimToken ? { deliveryClaimToken: String(raw.deliveryClaimToken), deliveryLeaseUntil: String(raw.deliveryLeaseUntil) } : {}),
      ...(raw.deliveryNextAttemptAt ? { deliveryNextAttemptAt: String(raw.deliveryNextAttemptAt) } : {}),
      ...(raw.deliveryError ? { deliveryError: sanitizeError(raw.deliveryError) } : {}),
      ...(deliveryRecords.length ? { deliveryConfirmedRecordIds: deliveryRecords as string[] } : {}),
      ...(raw.deliveryConfirmedAt ? { deliveryConfirmedAt: String(raw.deliveryConfirmedAt), newMessageId: String(raw.newMessageId) } : {}) };
  });
}

function requirePersonnelHandoverClaim(ledger: PurchaseWorkflowLedger, mutationId: string, claimToken: string): PurchaseManagerBatchHandover {
  const job = ledger.personnelHandovers.find(entry => entry.mutationId === mutationId);
  if (!job || job.status !== 'processing' || !claimToken || job.claimToken !== claimToken) throw new ConflictException('采购交接任务租约已变化');
  return job;
}

function requireWarehouseInboundHandover(ledger: PurchaseWorkflowLedger, mutationId: string, token: string): WarehouseInboundHandover {
  const job = ledger.warehouseInboundHandovers.find(value => value.mutationId === mutationId);
  if (!job || job.status !== 'processing' || !token || job.claimToken !== token) throw new ConflictException('入库提醒交接工作租约已变化');
  return job;
}

function emptyLedger(): PurchaseWorkflowLedger {
  return {
    version: 2,
    personnelHandovers: [],
    warehouseInboundHandovers: [],
    commands: [],
    reminders: [],
    cardActions: [],
    notifications: [],
    managerApprovalActions: [],
    managerApprovalCards: [],
    managerApprovalBatches: [],
    managerApprovalBatchActions: [],
  };
}

function normalizeCardActionClaim(
  value: PurchaseWorkflowCardActionClaimInput,
): Pick<
  PurchaseWorkflowCardActionEntry,
  'eventId' | 'recordId' | 'action' | 'actorOpenId'
> {
  const eventId = boundedText(value?.eventId, MAX_EVENT_ID_LENGTH);
  const recordId = clean(value?.recordId);
  const actorOpenId = boundedText(value?.actorOpenId, MAX_OPEN_ID_LENGTH);
  if (
    !eventId ||
    !RECORD_ID_PATTERN.test(recordId) ||
    (value?.action !== 'approve' && value?.action !== 'reject') ||
    !actorOpenId
  ) {
    throw new Error('Invalid purchase workflow card action claim');
  }
  return { eventId, recordId, action: value.action, actorOpenId };
}

function normalizeManagerApprovalCardIdentity(
  value: PurchaseManagerApprovalCardIdentity,
): PurchaseManagerApprovalCardIdentity {
  const recordId = clean(value?.recordId);
  const messageId = boundedText(value?.messageId, MAX_DELIVERY_ID_LENGTH);
  const actorOpenId = boundedText(value?.actorOpenId, MAX_OPEN_ID_LENGTH);
  if (
    !RECORD_ID_PATTERN.test(recordId) ||
    !messageId ||
    !OPEN_ID_PATTERN.test(actorOpenId)
  ) {
    throw new Error('Invalid manager approval card identity');
  }
  return { recordId, messageId, actorOpenId };
}

function normalizeManagerApprovalCallbackBinding(
  value: PurchaseManagerApprovalCallbackBindingInput,
): PurchaseManagerApprovalCardIdentity {
  const actorOpenId = boundedText(value?.actorOpenId, MAX_OPEN_ID_LENGTH);
  const recipientOpenId = boundedText(
    value?.recipientOpenId,
    MAX_OPEN_ID_LENGTH,
  );
  if (actorOpenId && recipientOpenId && actorOpenId !== recipientOpenId) {
    throw new Error('Manager approval callback actor does not match recipient');
  }
  return normalizeManagerApprovalCardIdentity({
    recordId: value?.recordId,
    messageId: value?.messageId,
    actorOpenId: actorOpenId || recipientOpenId,
  });
}

function normalizeManagerApprovalActionClaim(
  value: PurchaseManagerApprovalActionClaimInput,
): Pick<
  PurchaseManagerApprovalActionEntry,
  | 'eventId'
  | 'recordId'
  | 'choice'
  | 'rejectionReason'
  | 'messageId'
  | 'actorOpenId'
> {
  const eventId = boundedText(value?.eventId, MAX_EVENT_ID_LENGTH);
  const recordId = clean(value?.recordId);
  const choice = value?.choice;
  const messageId = boundedText(value?.messageId, MAX_DELIVERY_ID_LENGTH);
  const actorOpenId = boundedText(value?.actorOpenId, MAX_OPEN_ID_LENGTH);
  const rejectionReason = normalizeManagerRejectionReason(
    value?.rejectionReason,
  );
  if (
    !eventId ||
    !RECORD_ID_PATTERN.test(recordId) ||
    !isManagerApprovalChoice(choice) ||
    !messageId ||
    !OPEN_ID_PATTERN.test(actorOpenId) ||
    (choice === 'reject' && !rejectionReason) ||
    (choice !== 'reject' && rejectionReason)
  ) {
    throw new Error('Invalid manager approval action claim');
  }
  return {
    eventId,
    recordId,
    choice,
    rejectionReason,
    messageId,
    actorOpenId,
  };
}

interface NormalizedManagerApprovalBatchActionClaim extends PurchaseManagerApprovalBatchCardIdentity {
  eventId: string;
  executionRecordId: string;
  choice: Exclude<PurchaseManagerBatchApprovalChoice, ''>;
  rejectionReason: string;
}

function normalizeManagerApprovalBatchId(value: unknown): string {
  const normalized = clean(value);
  if (!BATCH_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid manager approval batch id');
  }
  return normalized;
}

function normalizeRecordId(value: unknown): string {
  const normalized = clean(value);
  if (!RECORD_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid manager approval batch record id');
  }
  return normalized;
}

function normalizeManagerApprovalBatchRegistration(
  value: PurchaseManagerApprovalBatchRegistrationInput,
): PurchaseManagerApprovalBatchRegistrationInput {
  const approvalBatchId = normalizeManagerApprovalBatchId(
    value?.approvalBatchId,
  );
  const recipientOpenId = boundedText(
    value?.recipientOpenId,
    MAX_OPEN_ID_LENGTH,
  );
  const requesterOpenId = boundedText(
    value?.requesterOpenId,
    MAX_OPEN_ID_LENGTH,
  );
  const recordIds = Array.isArray(value?.recordIds)
    ? value.recordIds.map(normalizeRecordId)
    : [];
  if (
    !OPEN_ID_PATTERN.test(recipientOpenId) ||
    !OPEN_ID_PATTERN.test(requesterOpenId) ||
    recordIds.length < 1 ||
    recordIds.length > 20 ||
    new Set(recordIds).size !== recordIds.length
  ) {
    throw new Error('Invalid manager approval batch registration');
  }
  const managers = value.managers?.map(person => ({ openId: clean(person.openId), name: boundedText(person.name, 200) }));
  if (managers && (!managers.length || managers.length > 100 || managers[0]?.openId !== recipientOpenId ||
    managers.some(person => !OPEN_ID_PATTERN.test(person.openId)) || new Set(managers.map(person => person.openId)).size !== managers.length)) {
    throw new Error('Invalid manager approval recipients');
  }
  if (value.flowVersion !== undefined && value.flowVersion !== 'legacy' && value.flowVersion !== 'lifecycle_v1') throw new Error('Invalid manager approval flow version');
  return { approvalBatchId, recipientOpenId, requesterOpenId, recordIds, ...(managers ? { managers } : {}), ...(value.flowVersion === undefined ? {} : { flowVersion: value.flowVersion }) };
}

function normalizeLifecycleInitialRegistration(input: PurchaseManagerApprovalBatchRegistrationInput, value?: PurchaseLifecycleInitialRegistration): { appId: string; recipients: Array<{ openId: string; fullView: boolean }>; authorityTargets: Array<{ recordId: string; target: PurchaseAuthorityTarget }> } | null {
  if (input.flowVersion !== 'lifecycle_v1') {
    if (value !== undefined) throw new ConflictException('旧采购单不能登记全流程卡片');
    return null;
  }
  if (!value || typeof value.authorize !== 'function' || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(value.appId) || value.appId !== readEnv('FEISHU_APP_ID') || !Array.isArray(value.recipients) || !value.recipients.length || value.recipients.length > 200) throw new ForbiddenException('采购全流程初始授权快照无效');
  const people = new Map<string, boolean>();
  for (const recipient of value.recipients) {
    if (!recipient || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(recipient.openId) || typeof recipient.fullView !== 'boolean') throw new ForbiddenException('采购全流程收件人快照无效');
    people.set(recipient.openId, !!people.get(recipient.openId) || recipient.fullView);
  }
  const managers = (input.managers || [{ openId: input.recipientOpenId, name: '' }]).map(row => row.openId);
  if (managers.some(openId => !people.has(openId)) || [...people].some(([openId, fullView]) => !managers.includes(openId) && !fullView)) throw new ForbiddenException('采购全流程初始收件人职责不匹配');
  if (!Array.isArray(value.authorityTargets) || value.authorityTargets.length !== input.recordIds.length) throw new ConflictException('采购全流程明细范围不完整');
  const targets = new Map<string, PurchaseAuthorityTarget>();
  for (const row of value.authorityTargets) {
    if (!row || !input.recordIds.includes(row.recordId) || targets.has(row.recordId)) throw new ConflictException('采购全流程明细范围冲突');
    const target = normalizePurchaseAuthorityTarget(row.target);
    if (!target) throw new ConflictException('采购全流程明细范围未知');
    targets.set(row.recordId, target);
  }
  return { appId: value.appId, recipients: [...people].map(([openId, fullView]) => ({ openId, fullView })).sort((a, b) => a.openId.localeCompare(b.openId)), authorityTargets: input.recordIds.map(recordId => ({ recordId, target: targets.get(recordId)! })) };
}

function normalizeManagerApprovalBatchCardIdentity(
  value: PurchaseManagerApprovalBatchCardIdentity,
): PurchaseManagerApprovalBatchCardIdentity {
  const approvalBatchId = normalizeManagerApprovalBatchId(
    value?.approvalBatchId,
  );
  const messageId = boundedText(value?.messageId, MAX_DELIVERY_ID_LENGTH);
  const actorOpenId = boundedText(value?.actorOpenId, MAX_OPEN_ID_LENGTH);
  if (!messageId || !OPEN_ID_PATTERN.test(actorOpenId)) {
    throw new Error('Invalid manager approval batch card identity');
  }
  const lifecycle = normalizeLifecycleCallbackBinding(value.lifecycle);
  return { approvalBatchId, messageId, actorOpenId, ...(lifecycle ? { lifecycle } : {}) };
}

function assertLifecycleFormBindingShape(identity: PurchaseLifecycleFormCredentialIdentity, binding: PurchaseLifecycleFormBinding): void {
  const expectedRole = binding?.action === 'submit_item_reject' ? 'manager' : binding?.action === 'submit_order' ? 'purchaser' : binding?.action === 'submit_receipt' ? 'requester' : '';
  if (!identity || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(identity.appId) || !OPEN_ID_PATTERN.test(identity.actorOpenId) || !FEISHU_MESSAGE_ID_PATTERN.test(identity.messageId) || !binding ||
    binding.flowVersion !== 'lifecycle_v1' || !expectedRole || binding.role !== expectedRole || !BATCH_ID_PATTERN.test(binding.approvalBatchId) || !RECORD_ID_PATTERN.test(binding.executionRecordId) || !Number.isSafeInteger(binding.cardRevision) || binding.cardRevision < 1) throw new ConflictException('采购表单绑定无效');
}

function lifecycleFormTokenHash(token: string): string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new ConflictException('采购表单凭据无效');
  return createHash('sha256').update(token).digest('hex');
}

function normalizeLifecycleFormCredentials(value: unknown): PurchaseLifecycleFormCredential[] {
  if (!Array.isArray(value) || value.length > 5000) throw new ConflictException('采购表单凭据存储损坏');
  const hashes = new Set<string>();
  return value.map(raw => {
    if (!isRecord(raw) || typeof raw.hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.hash) || hashes.has(raw.hash) || !Number.isSafeInteger(raw.expiresAtMs) || (raw.expiresAtMs as number) < 1 || (raw.consumedByEventId !== undefined && (typeof raw.consumedByEventId !== 'string' || !raw.consumedByEventId || raw.consumedByEventId.length > MAX_EVENT_ID_LENGTH))) throw new ConflictException('采购表单凭据存储损坏');
    const entry = raw as unknown as PurchaseLifecycleFormCredential;
    assertLifecycleFormBindingShape(entry, entry.binding);
    hashes.add(entry.hash);
    return entry;
  });
}

function findLifecycleFormCredential(ledger: PurchaseWorkflowLedger, token: string, identity: PurchaseLifecycleFormCredentialIdentity, now: number): PurchaseLifecycleFormCredential {
  const hash = lifecycleFormTokenHash(token);
  const matches = (ledger.lifecycleFormCredentials || []).filter(row => row.hash === hash);
  const entry = matches[0];
  if (matches.length !== 1 || !entry || entry.expiresAtMs <= now || entry.appId !== identity.appId || entry.actorOpenId !== identity.actorOpenId || entry.messageId !== identity.messageId) throw new ConflictException('采购表单已过期或身份不匹配，请重新打开');
  return entry;
}

function consumeLifecycleFormCredential(ledger: PurchaseWorkflowLedger, identity: PurchaseManagerApprovalBatchCardIdentity, binding: PurchaseLifecycleFormBinding, eventId: string, now: number): void {
  const lifecycle = identity.lifecycle;
  if (!lifecycle?.formToken) throw new ForbiddenException('采购表单缺少凭据');
  const entry = findLifecycleFormCredential(ledger, lifecycle.formToken, { appId: lifecycle.appId, actorOpenId: identity.actorOpenId, messageId: identity.messageId }, now);
  const actual = entry.binding;
  if (actual.action !== binding.action || actual.role !== binding.role || actual.approvalBatchId !== binding.approvalBatchId || actual.executionRecordId !== binding.executionRecordId || actual.flowVersion !== binding.flowVersion || actual.cardRevision !== binding.cardRevision || (entry.consumedByEventId && entry.consumedByEventId !== eventId)) throw new ConflictException('采购表单凭据已使用或内容不匹配');
  entry.consumedByEventId = eventId;
}

function normalizeLifecyclePaymentUploads(value: unknown): LifecyclePaymentUploadStoredEntry[] {
  if (!Array.isArray(value) || value.length > 2000) throw new ConflictException('采购付款上传账本损坏');
  const keys = new Set<string>(), content = new Set<string>();
  return value.map(raw => {
    if (!isRecord(raw) || typeof raw.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,124}$/u.test(raw.appId) ||
      typeof raw.approvalBatchId !== 'string' || !BATCH_ID_PATTERN.test(raw.approvalBatchId) || typeof raw.executionRecordId !== 'string' || !RECORD_ID_PATTERN.test(raw.executionRecordId) ||
      typeof raw.actorOpenId !== 'string' || !OPEN_ID_PATTERN.test(raw.actorOpenId) || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1 || !isRecord(raw.entry)) throw new ConflictException('采购付款上传账本损坏');
    const entry = raw.entry as unknown as LifecyclePaymentUploadEntry;
    try { validateLifecyclePaymentUploadEntry(entry); } catch { throw new ConflictException('采购付款上传账本损坏'); }
    if (keys.has(entry.key) || (entry.status !== 'cancelled' && entry.contentKeys.some(key => content.has(key)))) throw new ConflictException('采购付款上传账本存在重复');
    keys.add(entry.key); if (entry.status !== 'cancelled') for (const key of entry.contentKeys) content.add(key);
    const row:LifecyclePaymentUploadStoredEntry = { appId: raw.appId, approvalBatchId: raw.approvalBatchId, executionRecordId: raw.executionRecordId, actorOpenId: raw.actorOpenId, generation: Number(raw.generation), entry: structuredClone(entry) };
    if(raw.perFile!==undefined) row.perFile=normalizeLifecyclePaymentPerFile(raw.perFile,row);
    return row;
  });
}

function normalizeLifecyclePaymentPerFile(value:unknown,row:LifecyclePaymentUploadStoredEntry):NonNullable<LifecyclePaymentUploadStoredEntry['perFile']> {
  if(!Array.isArray(value) || value.length!==row.entry.fileCount) throw new ConflictException('逐文件付款上传账本损坏');
  const files=value.map((v,index)=>{
    if(!isRecord(v) || Object.keys(v).some(key=>!['index','name','sha256','size','state','attemptId','token'].includes(key)) || v.index!==index || typeof v.name!=='string' || !v.name.trim() || v.name.normalize('NFC')!==v.name || Array.from(v.name).length>255 || /[\u0000-\u001f\u007f/\\]/u.test(v.name) || typeof v.sha256!=='string' || !/^[a-f0-9]{64}$/.test(v.sha256) || !Number.isSafeInteger(v.size) || Number(v.size)<1 || Number(v.size)>20*1024*1024 || !['pending','dispatching','confirmed','manual_reconciliation'].includes(String(v.state))) throw new ConflictException('逐文件付款上传账本损坏');
    if(v.state==='pending' ? v.attemptId!==undefined || v.token!==undefined : typeof v.attemptId!=='string' || !UUID_PATTERN.test(v.attemptId) || (v.state==='confirmed' ? typeof v.token!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(v.token) : v.token!==undefined)) throw new ConflictException('逐文件付款上传状态损坏');
    const expected=createHash('sha256').update(JSON.stringify(['purchase-payment-content-v1',row.appId,row.approvalBatchId,row.executionRecordId,v.sha256,v.size])).digest('hex');
    if(expected!==row.entry.contentKeys[index]) throw new ConflictException('逐文件付款上传内容不一致');
    return {index,name:v.name,sha256:v.sha256,size:Number(v.size),state:v.state,...(v.attemptId===undefined?{}:{attemptId:v.attemptId}),...(v.token===undefined?{}:{token:v.token})} as NonNullable<LifecyclePaymentUploadStoredEntry['perFile']>[number];
  });
  const fp=createHash('sha256').update(JSON.stringify(['purchase-payment-files-v1',row.entry.bindingFingerprint,files.map(({sha256,size,name})=>({sha256,size,name}))])).digest('hex');
  if(fp!==row.entry.fingerprint || files.filter(file=>file.state==='dispatching').length>1 || files.filter(file=>file.state==='manual_reconciliation').length>1 || files.some(file=>file.state==='manual_reconciliation') && files.some(file=>file.state==='dispatching')) throw new ConflictException('逐文件付款上传状态不一致');
  const states=files.map(file=>file.state),status=row.entry.status;
  if((status==='prepared'||status==='cancelled') ? states.some(state=>state!=='pending') : status==='manual_reconciliation' ? !states.includes('manual_reconciliation') : status==='dispatching' ? states.includes('manual_reconciliation') || states.every(state=>state==='pending') || states.every(state=>state==='confirmed') : states.some(state=>state!=='confirmed')) throw new ConflictException('逐文件付款上传状态不一致');
  if(status!=='prepared' && status!=='cancelled' && !files.some(file=>file.attemptId===row.entry.attemptId)) throw new ConflictException('逐文件付款上传凭据不一致');
  if((status==='uploaded'||status==='committed') && JSON.stringify(files.map(file=>file.token))!==JSON.stringify(row.entry.tokens)) throw new ConflictException('逐文件付款上传回执不一致');
  return files;
}

function lifecyclePaymentPerFilePublic(row:LifecyclePaymentUploadStoredEntry):LifecyclePaymentPerFileTask {
  if(!row.perFile) throw new ConflictException('逐文件付款上传任务不存在');
  const state=row.entry.status==='committed'?'committed':row.entry.status==='cancelled'?'cancelled':row.entry.status==='manual_reconciliation'?'manual_reconciliation':'active';
  return {key:row.entry.key,state,files:row.perFile.map(({token:_token,...file})=>structuredClone(file))};
}

function normalizeLifecyclePaymentBlocks(value: unknown): LifecyclePaymentUploadBlock[] {
  if (!Array.isArray(value) || value.length > 2000) throw new ConflictException('采购付款取消账本损坏');
  const keys = new Set<string>();
  return value.map(raw => {
    if (!isRecord(raw) || typeof raw.key !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.key) || keys.has(raw.key) ||
      typeof raw.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,124}$/u.test(raw.appId) || typeof raw.approvalBatchId !== 'string' || !BATCH_ID_PATTERN.test(raw.approvalBatchId) ||
      typeof raw.executionRecordId !== 'string' || !RECORD_ID_PATTERN.test(raw.executionRecordId) || typeof raw.actorOpenId !== 'string' || !OPEN_ID_PATTERN.test(raw.actorOpenId) ||
      !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1 || !Number.isSafeInteger(raw.cancelledAtMs) || Number(raw.cancelledAtMs) < 1) throw new ConflictException('采购付款取消账本损坏');
    keys.add(raw.key);
    return { key: raw.key, appId: raw.appId, approvalBatchId: raw.approvalBatchId, executionRecordId: raw.executionRecordId, actorOpenId: raw.actorOpenId, generation: Number(raw.generation), cancelledAtMs: Number(raw.cancelledAtMs) };
  });
}

function paymentUploadStoredRow(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!Array.isArray(raw.lifecyclePaymentUploads)) throw new ConflictException('采购付款上传账本缺失');
  const matches = raw.lifecyclePaymentUploads.filter(row => isRecord(row) && isRecord(row.entry) && row.entry.key === key);
  if (matches.length !== 1 || !isRecord(matches[0])) throw new ConflictException('采购付款上传任务无法核对');
  return matches[0];
}

function applyPaymentUploadEntry(row: Record<string, unknown>, entry: LifecyclePaymentUploadEntry): void {
  if (!isRecord(row.entry)) throw new ConflictException('采购付款上传任务损坏');
  row.entry = { ...row.entry, ...structuredClone(entry) };
}

function normalizeLifecycleCallbackBinding(value: PurchaseManagerApprovalBatchCardIdentity['lifecycle']): PurchaseManagerApprovalBatchCardIdentity['lifecycle'] {
  if (value === undefined) return undefined;
  if (!value || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(value.appId) || !Number.isSafeInteger(value.cardRevision) || value.cardRevision < 1) throw new ConflictException('采购卡片版本凭据无效');
  if (value.formToken !== undefined) lifecycleFormTokenHash(value.formToken);
  return { appId: value.appId, cardRevision: value.cardRevision, ...(value.formToken === undefined ? {} : { formToken: value.formToken }) };
}

function normalizePurchaseBatchFulfillmentIdentity(
  value: PurchaseBatchFulfillmentCardIdentity,
): PurchaseBatchFulfillmentCardIdentity {
  const approvalBatchId = normalizeManagerApprovalBatchId(
    value?.approvalBatchId,
  );
  const messageId = boundedText(value?.messageId, MAX_DELIVERY_ID_LENGTH);
  const actorOpenId = boundedText(value?.actorOpenId, MAX_OPEN_ID_LENGTH);
  if (
    !messageId ||
    !OPEN_ID_PATTERN.test(actorOpenId) ||
    (value?.role !== 'purchaser' && value?.role !== 'requester')
  ) {
    throw new BadRequestException('采购履约卡片身份无效');
  }
  const lifecycle = normalizeLifecycleCallbackBinding(value.lifecycle);
  return { approvalBatchId, messageId, actorOpenId, role: value.role, ...(lifecycle ? { lifecycle } : {}) };
}

function normalizeManagerApprovalBatchPendingClaim(
  value: PurchaseManagerApprovalBatchPendingClaimInput,
): NormalizedManagerApprovalBatchActionClaim {
  const identity = normalizeManagerApprovalBatchCardIdentity(value);
  const eventId = boundedText(value?.eventId, MAX_EVENT_ID_LENGTH);
  if (
    !eventId ||
    (value?.choice !== 'comprehensive' && value?.choice !== 'building_self')
  ) {
    throw new Error('Invalid manager approval batch pending claim');
  }
  return {
    ...identity,
    eventId,
    executionRecordId: '',
    choice: value.choice,
    rejectionReason: '',
  };
}

function normalizeManagerApprovalBatchRejectClaim(
  value: PurchaseManagerApprovalBatchRejectClaimInput,
): NormalizedManagerApprovalBatchActionClaim {
  const identity = normalizeManagerApprovalBatchCardIdentity(value);
  const eventId = boundedText(value?.eventId, MAX_EVENT_ID_LENGTH);
  const executionRecordId = normalizeRecordId(value?.executionRecordId);
  const rejectionReason = normalizeManagerRejectionReason(
    value?.rejectionReason,
  );
  if (!eventId || !rejectionReason) {
    throw new Error('Invalid manager approval batch reject claim');
  }
  return {
    ...identity,
    eventId,
    executionRecordId,
    choice: 'reject',
    rejectionReason,
  };
}

function sameManagerApprovalBatchRegistration(
  entry: PurchaseManagerApprovalBatchEntry,
  input: PurchaseManagerApprovalBatchRegistrationInput,
): boolean {
  return (
    entry.approvalBatchId === input.approvalBatchId &&
    entry.recipientOpenId === input.recipientOpenId &&
    entry.requesterOpenId === input.requesterOpenId &&
    (entry.flowVersion || 'legacy') === (input.flowVersion || 'legacy') &&
    sameStringArray(entry.recordIds, input.recordIds)
  );
}

function sameManagerApprovalBatchActionPayload(
  entry: PurchaseManagerApprovalBatchActionEntry,
  input: NormalizedManagerApprovalBatchActionClaim,
): boolean {
  return (
    entry.eventId === input.eventId &&
    entry.approvalBatchId === input.approvalBatchId &&
    entry.choice === input.choice &&
    entry.rejectionReason === input.rejectionReason &&
    entry.messageId === input.messageId &&
    entry.actorOpenId === input.actorOpenId &&
    (!input.executionRecordId ||
      (entry.recordIds.length === 1 &&
        entry.recordIds[0] === input.executionRecordId))
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameRecordIdSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((recordId) => rightSet.has(recordId));
}

function isActiveManagerApprovalBatch(
  entry: PurchaseManagerApprovalBatchEntry,
): boolean {
  return (
    entry.state === 'awaiting_delivery' ||
    entry.state === 'active' ||
    entry.state === 'reject_editing' ||
    entry.state === 'processing'
  );
}

function requireActiveManagerApprovalBatch(
  ledger: PurchaseWorkflowLedger,
  identity: PurchaseManagerApprovalBatchCardIdentity,
): PurchaseManagerApprovalBatchEntry {
  if (ledger.personnelHandovers.some(job => job.approvalBatchId === identity.approvalBatchId && job.status !== 'completed')) {
    throw new ConflictException('采购人员交接正在同步，请稍后重试');
  }
  const matches = ledger.managerApprovalBatches.filter(
    (entry) => entry.approvalBatchId === identity.approvalBatchId,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new ConflictException('采购批次审批卡批次映射不存在');
  }
  const batch = managerBatchCardView(matches[0], identity.actorOpenId);
  assertLifecycleCallbackWithinLedger(ledger, batch, identity);
  if (
    (batch.flowVersion !== 'lifecycle_v1' && batch.messageId !== identity.messageId) ||
    batch.recipientOpenId !== identity.actorOpenId
  ) {
    throw new ConflictException('采购批次审批卡身份不匹配');
  }
  return batch;
}

/** Invoke under the same ledger lock as the business claim; metadata is untrusted. */
function lifecycleReceiptPreparationView(ledger:PurchaseWorkflowLedger,identity:PurchaseReplicaIdentity,messageId:string):LifecycleReceiptPreparationView|null {
  const tasks=(ledger.lifecycleReceiptPrepareQueue?.tasks || []).filter(row=>row.identity.appId===identity.appId && row.identity.approvalBatchId===identity.batchId && row.identity.actorOpenId===identity.recipientOpenId && row.identity.cardMessageId===messageId);
  const task=tasks[tasks.length-1];if (!task) return null;
  const view={taskId:task.taskId,executionRecordId:task.identity.executionRecordId,recipientOpenId:identity.recipientOpenId,cardMessageId:messageId,materialType:task.identity.materialType};
  if (task.state==='failed') return {...view,state:'failed'};
  if (task.state!=='completed') return {...view,state:'pending'};
  const intent=(ledger.lifecycleReceiptImageLedger?.intents || []).find(row=>row.id===task.intentId && row.appId===identity.appId && row.approvalBatchId===identity.batchId && row.executionRecordId===task.identity.executionRecordId && row.materialType===task.identity.materialType && row.actorOpenId===identity.recipientOpenId && row.cardMessageId===messageId);
  if (!intent || intent.state!=='open' || intent.expiresAtMs<Date.now()) return {...view,state:'failed'};
  return {...view,state:'ready',intentId:intent.id,intentExpiresAtMs:intent.expiresAtMs};
}

function assertLifecycleCallbackWithinLedger(ledger: PurchaseWorkflowLedger, batch: PurchaseManagerApprovalBatchEntry, identity: PurchaseManagerApprovalBatchCardIdentity): void {
  if (batch.flowVersion !== 'lifecycle_v1') {
    if (identity.lifecycle) throw new ConflictException('旧采购卡片不接受新版本凭据');
    if (batch.stageCardTransition && batch.stageCardTransition.appId !== readEnv('FEISHU_APP_ID')) {
      throw new ConflictException('采购分阶段卡片应用身份已变化');
    }
    return;
  }
  const binding = identity.lifecycle;
  if (!binding || binding.appId !== readEnv('FEISHU_APP_ID')) throw new ConflictException('采购全流程卡片缺少可信应用凭据');
  const key = lifecycleIdentityKey({ appId: binding.appId, batchId: identity.approvalBatchId, recipientOpenId: identity.actorOpenId });
  const entries = (ledger.lifecycleOutbox || []).filter(entry => lifecycleIdentityKey(entry.replica) === key);
  if (entries.length !== 1 || entries[0]!.replica.state !== 'delivered' || entries[0]!.replica.messageId !== identity.messageId ||
    entries[0]!.replica.appliedRevision !== binding.cardRevision || entries[0]!.desiredRevision !== binding.cardRevision) throw new ConflictException('采购全流程卡片消息或版本已变化');
  const sentAtMs = entries[0]!.replica.sentAtMs;
  const nowMs = Date.now();
  if (!Number.isSafeInteger(sentAtMs) || sentAtMs < 1 || !Number.isSafeInteger(nowMs) || nowMs < sentAtMs || nowMs - sentAtMs > 14 * 86400_000) {
    throw new ConflictException('采购卡片已过期或时间不可核对，请等待延续卡');
  }
}

function requireClaimedManagerApprovalBatchActionAndBatch(
  ledger: PurchaseWorkflowLedger,
  key: string,
  claimToken: string,
): {
  actionIndex: number;
  action: PurchaseManagerApprovalBatchActionEntry;
  batch: PurchaseManagerApprovalBatchEntry;
} {
  const actionIndex = ledger.managerApprovalBatchActions.findIndex(
    (entry) => entry.key === key,
  );
  const action = ledger.managerApprovalBatchActions[actionIndex];
  if (actionIndex < 0 || !action) {
    throw new ConflictException('采购批次审批动作不存在');
  }
  assertClaimOwnership(action, claimToken);
  const batches = ledger.managerApprovalBatches.filter(
    (entry) => entry.approvalBatchId === action.approvalBatchId,
  );
  if (batches.length !== 1 || !batches[0]) {
    throw new ConflictException('采购批次审批动作缺少唯一批次');
  }
  return { actionIndex, action, batch: batches[0] };
}

function requirePurchaseBatchFulfillmentSource(
  ledger: PurchaseWorkflowLedger,
  identity: PurchaseBatchFulfillmentCardIdentity,
): {
  batch: PurchaseManagerApprovalBatchEntry;
  source: PurchaseWorkflowNotificationEntry;
} {
  const batch = ledger.managerApprovalBatches.find(
    (entry) => entry.approvalBatchId === identity.approvalBatchId,
  );
  if (!batch) throw new ConflictException('采购履约批次不存在');
  assertLifecycleCallbackWithinLedger(ledger, batch, { approvalBatchId: identity.approvalBatchId, actorOpenId: identity.actorOpenId, messageId: identity.messageId, lifecycle: identity.lifecycle });
  const transition = batch.stageCardTransition;
  if (transition && (transition.appId !== readEnv('FEISHU_APP_ID') || transition.archivedMessageIds.includes(identity.messageId))) {
    throw new ConflictException('原全流程卡已归档，请使用对应环节卡片');
  }
  const expectedKind =
    identity.role === 'purchaser'
      ? 'manager_batch_purchase_assigned'
      : 'manager_batch_receipt_requested';
  const matches = ledger.notifications.filter(
    (entry) =>
      entry.kind === expectedKind &&
      entry.recipientOpenId === identity.actorOpenId &&
      (batch.flowVersion === 'lifecycle_v1' || entry.messageId === identity.messageId) &&
      (!transition || !entry.lifecycleBinding) &&
      entry.status === 'completed' &&
      entry.sendOutcome === 'delivered' &&
      (batch.flowVersion === 'lifecycle_v1' ? lifecycleFulfillmentContextMatches(entry.cardContext, batch, entry.recordId)
        : entry.cardContext === batch.cardContext || (transition && entry.cardContext === transition.originalCardContext)),
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new ConflictException('采购履约卡片消息映射不存在');
  }
  if (
    (identity.role === 'requester' &&
      batch.requesterOpenId !== identity.actorOpenId) ||
    (identity.role === 'purchaser' &&
      !batch.items.some(
        (item) =>
          item.status === 'approved' &&
          item.purchaserOpenId === identity.actorOpenId,
      ))
  ) {
    throw new ConflictException('采购履约卡片操作者身份不匹配');
  }
  return { batch, source: matches[0] };
}

function lifecycleFulfillmentContextMatches(value: string, batch: PurchaseManagerApprovalBatchEntry, recordId: string): boolean {
  try {
    const context = parsePurchaseManagerBatchApprovalCardContext(value);
    return context.approvalBatchId === batch.approvalBatchId && context.requesterOpenId === batch.requesterOpenId && context.items.some(item => item.executionRecordId === recordId);
  } catch { return false; }
}

function finalizeManagerApprovalBatchAction(
  ledger: PurchaseWorkflowLedger,
  batchValue: PurchaseManagerApprovalBatchEntry,
  action: Pick<PurchaseManagerApprovalBatchActionEntry, 'actorOpenId'>,
  timestamp: string,
): PurchaseManagerApprovalBatchEntry {
  const hasManual = batchValue.items.some(
    (item) => item.status === 'manual_reconciliation',
  );
  const hasProcessing = batchValue.items.some(
    (item) => item.status === 'processing',
  );
  const hasPending = batchValue.items.some((item) => item.status === 'pending');
  const state: PurchaseManagerApprovalBatchState = hasManual
    ? 'manual_reconciliation'
    : hasProcessing
      ? 'processing'
      : hasPending
        ? 'active'
        : 'resolved';
  let batch: PurchaseManagerApprovalBatchEntry = {
    ...batchValue,
    state,
    managerDeliveries: managerBatchDeliveries(batchValue).map(delivery => ({ ...delivery, selectedRejectRecordId: batchValue.items.some(item => item.executionRecordId === delivery.selectedRejectRecordId && item.status === 'pending') ? delivery.selectedRejectRecordId : '' })),
    selectedRejectRecordId: '',
    revision: batchValue.revision + 1,
    actorOpenId: action.actorOpenId,
    processedAt: timestamp,
    updatedAt: timestamp,
    resolvedAt:
      state === 'resolved' || state === 'manual_reconciliation'
        ? timestamp
        : '',
  };
  batch = withManagerApprovalBatchContext(batch);
  enqueueManagerApprovalBatchStateNotifications(
    ledger,
    batch,
    state === 'manual_reconciliation'
      ? 'manager_batch_approval_attention_required'
      : 'manager_batch_approval_refresh',
    timestamp,
  );
  if (
    (state === 'resolved' || state === 'manual_reconciliation') &&
    !managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === batch.requesterOpenId)
  ) {
    enqueueManagerApprovalBatchStateNotifications(
      ledger,
      batch,
      'manager_batch_approval_result',
      timestamp,
    );
  }
  if (state === 'resolved' || state === 'manual_reconciliation') {
    const purchaserOpenIds = [
      ...new Set(
        batch.items
          .filter((item) => item.status === 'approved')
          .map((item) => item.purchaserOpenId)
          .filter((openId) => OPEN_ID_PATTERN.test(openId)),
      ),
    ];
    for (const purchaserOpenId of purchaserOpenIds) {
      enqueueManagerApprovalBatchPurchaserNotification(
        ledger,
        batch,
        purchaserOpenId,
        timestamp,
      );
    }
  }
  return batch;
}

function enqueueManagerApprovalBatchPurchaserNotification(
  ledger: PurchaseWorkflowLedger,
  batch: PurchaseManagerApprovalBatchEntry,
  purchaserOpenId: string,
  timestamp: string,
): PurchaseWorkflowNotificationEntry {
  const firstRecordId = batch.items.find(
    (item) =>
      item.status === 'approved' && item.purchaserOpenId === purchaserOpenId,
  )?.executionRecordId;
  if (!firstRecordId) {
    throw new ConflictException('采购批次缺少采购人明细');
  }
  const input: PurchaseWorkflowNotificationInput = {
    businessEventId: `manager_batch_purchase_assigned:${batch.approvalBatchId}:${batch.revision}`,
    recordId: firstRecordId,
    recipientOpenId: purchaserOpenId,
    kind: 'manager_batch_purchase_assigned',
    cardContext: batch.cardContext,
  };
  const key = notificationKey(input);
  const existing = ledger.notifications.find((entry) => entry.key === key);
  if (existing) return existing;
  if (
    ledger.notifications.filter((entry) => isActiveStatus(entry.status))
      .length >= MAX_NOTIFICATIONS
  ) {
    throw new ServiceUnavailableException('采购通知任务队列已满，请稍后重试');
  }
  const notification = createNotificationEntry(input, timestamp);
  ledger.notifications.push(notification);
  return notification;
}

function retainedStageNotification(
  entry: PurchaseWorkflowNotificationEntry, transition: PurchaseLifecycleStageCardTransitionReceipt,
): boolean {
  return !entry.lifecycleBinding && !transition.archivedMessageIds.includes(entry.messageId) &&
    !(entry.status === 'failed' && entry.sendOutcome === 'unattempted' && !entry.messageId && !entry.firstSendAttemptAt &&
      !entry.deliveryAudit.some(event => event.action === 'send_started' || event.action === 'send_rejected'));
}

export function isFailedUnattemptedMigratedOrderCard(task: PurchaseWorkflowNotificationEntry): boolean {
  return task.kind === 'manager_batch_purchase_assigned' && task.status === 'failed' && task.attempts === 5 &&
    task.lastError === '当前采购岗位已变化，请使用现任人员的新卡片办理' && task.sendOutcome === 'unattempted' &&
    !task.lifecycleBinding && !task.messageId && !task.deliveryId && !task.firstSendAttemptAt &&
    !task.leaseUntil && !task.claimToken && !task.deliveryAudit.length && Boolean(task.deliveryUuid);
}

function isCanonicalStageReceipt(
  entry: PurchaseWorkflowNotificationEntry,
  batch: PurchaseManagerApprovalBatchEntry | undefined,
  approvalBatchId: string,
): boolean {
  const event = 'manager_batch_receipt_requested:' + approvalBatchId;
  if (entry.kind !== 'manager_batch_receipt_requested') return false;
  const transition = batch?.stageCardTransition;
  if (!transition) return entry.businessEventId === event;
  const expected = entry.businessEventId === event || entry.businessEventId === event + ':stage-cards';
  return expected && (entry.businessEventId.endsWith(':stage-cards')
      ? !entry.lifecycleBinding && !transition.archivedMessageIds.includes(entry.messageId)
      : retainedStageNotification(entry, transition)) &&
    lifecycleFulfillmentContextMatches(entry.cardContext, batch!, entry.recordId);
}

function enqueueCutoverStageCards(
  ledger: PurchaseWorkflowLedger,
  batch: PurchaseManagerApprovalBatchEntry,
  records: ReadonlyMap<string, PurchaseWorkflowRecord>,
  timestamp: string,
): void {
  const transition = batch.stageCardTransition!;
  const eligible = batch.items.filter(item => item.status === 'approved' && records.has(item.executionRecordId));
  const alreadySeparate = (kind: PurchaseWorkflowNotificationKind, recipientOpenId: string) =>
    ledger.notifications.some(task => task.kind === kind && task.recipientOpenId === recipientOpenId &&
      retainedStageNotification(task, transition) &&
      lifecycleFulfillmentContextMatches(task.cardContext, batch, task.recordId));
  const orderRecipients = new Set(eligible.filter(item =>
    resolvePurchaseStage(records.get(item.executionRecordId)!.status) === 'ordering'
  ).map(item => item.purchaserOpenId));
  for (const recipient of orderRecipients) {
    if (!alreadySeparate('manager_batch_purchase_assigned', recipient)) {
      enqueueManagerApprovalBatchPurchaserNotification(ledger, batch, recipient, timestamp);
    }
  }

  const firstReceipt = eligible.find(item => resolvePurchaseStage(records.get(item.executionRecordId)!.status) === 'receipt');
  if (!firstReceipt || alreadySeparate('manager_batch_receipt_requested', batch.requesterOpenId)) return;
  if (ledger.notifications.filter(task => isActiveStatus(task.status)).length >= MAX_NOTIFICATIONS) {
    throw new ServiceUnavailableException('采购通知任务队列已满，请稍后重试');
  }
  const base = 'manager_batch_receipt_requested:' + batch.approvalBatchId;
  const eventId = ledger.notifications.some(task => task.businessEventId === base) ? base + ':stage-cards' : base;
  ledger.notifications.push(createNotificationEntry({
    businessEventId: eventId, recordId: firstReceipt.executionRecordId,
    recipientOpenId: batch.requesterOpenId, kind: 'manager_batch_receipt_requested', cardContext: batch.cardContext,
  }, timestamp));
}

function withManagerApprovalBatchContext(
  batch: PurchaseManagerApprovalBatchEntry,
): PurchaseManagerApprovalBatchEntry {
  const source = parsePurchaseManagerBatchApprovalCardContext(
    batch.cardContext,
  );
  const itemStates = new Map(
    batch.items.map((item) => [item.executionRecordId, item]),
  );
  const cardContext = serializePurchaseManagerBatchApprovalCardContext({
    ...source,
    items: source.items.map((item) => {
      const state = itemStates.get(item.executionRecordId);
      if (!state) {
        throw new ConflictException('采购批次审批卡上下文明细缺失');
      }
      const { decisionSource: _previousSource, ...preserved } = item;
      return {
        ...preserved,
        status: state.status,
        choice: state.choice,
        rejectionReason: state.rejectionReason,
        ...(state.decisionSource ? { decisionSource: state.decisionSource } : {}),
      };
    }),
  });
  return { ...batch, cardContext };
}

function enqueueManagerApprovalBatchStateNotifications(
  ledger: PurchaseWorkflowLedger,
  batch: PurchaseManagerApprovalBatchEntry,
  kind: 'manager_batch_approval_refresh' | 'manager_batch_approval_result' | 'manager_batch_approval_attention_required',
  timestamp: string,
): void {
  const recipients = kind === 'manager_batch_approval_result'
    ? [batch.requesterOpenId]
    : managerBatchDeliveries(batch).filter(delivery => delivery.messageId).map(delivery => delivery.recipientOpenId);
  for (const recipientOpenId of new Set(recipients)) {
    const input: PurchaseWorkflowNotificationInput = {
      businessEventId: `${kind}:${batch.approvalBatchId}:${batch.revision}`,
      recordId: batch.recordIds[0]!, recipientOpenId, kind, cardContext: batch.cardContext,
    };
    const key = notificationKey(input);
    const existing = ledger.notifications.find(entry => entry.key === key);
    if (existing) {
      if (existing.kind !== kind || existing.cardContext !== batch.cardContext) throw new ConflictException('采购批次审批状态通知冲突');
      continue;
    }
    if (ledger.notifications.filter(entry => isActiveStatus(entry.status)).length >= MAX_NOTIFICATIONS) {
      throw new ServiceUnavailableException('采购通知任务队列已满，请稍后重试');
    }
    ledger.notifications.push(createNotificationEntry(input, timestamp));
  }
}

function replaceManagerApprovalBatch(
  ledger: PurchaseWorkflowLedger,
  batch: PurchaseManagerApprovalBatchEntry,
): void {
  const index = ledger.managerApprovalBatches.findIndex(
    (entry) => entry.approvalBatchId === batch.approvalBatchId,
  );
  if (index < 0) throw new ConflictException('采购审批批次不存在');
  ledger.managerApprovalBatches[index] = syncManagerBatchLegacyFields(batch);
}

export function managerBatchDeliveries(batch: PurchaseManagerApprovalBatchEntry): PurchaseManagerApprovalDelivery[] {
  return batch.managerDeliveries || [{
    recipientOpenId: batch.recipientOpenId, recipientName: '', sourceNotificationKey: batch.sourceNotificationKey,
    messageId: batch.messageId, selectedRejectRecordId: batch.selectedRejectRecordId,
  }];
}

export function managerBatchCardView(batch: PurchaseManagerApprovalBatchEntry, recipientOpenId: string): PurchaseManagerApprovalBatchEntry {
  const delivery = managerBatchDeliveries(batch).find(item => item.recipientOpenId === recipientOpenId);
  if (!delivery) throw new ConflictException('采购批次审批卡接收人不匹配');
  const active = batch.state === 'active' || batch.state === 'reject_editing';
  return { ...batch, ...delivery,
    state: active ? delivery.selectedRejectRecordId ? 'reject_editing' : 'active' : batch.state,
    selectedRejectRecordId: active ? delivery.selectedRejectRecordId : '',
  };
}

function syncManagerBatchLegacyFields(batch: PurchaseManagerApprovalBatchEntry): PurchaseManagerApprovalBatchEntry {
  return managerBatchCardView(batch, managerBatchDeliveries(batch)[0]!.recipientOpenId);
}

function updateManagerBatchDelivery(batch: PurchaseManagerApprovalBatchEntry, recipientOpenId: string, patch: Partial<PurchaseManagerApprovalDelivery>): PurchaseManagerApprovalBatchEntry {
  return syncManagerBatchLegacyFields({ ...batch, managerDeliveries: managerBatchDeliveries(batch).map(delivery =>
    delivery.recipientOpenId === recipientOpenId ? { ...delivery, ...patch } : delivery) });
}

function managerApprovalBatchActionKey(eventId: string): string {
  return `manager_batch_approval_action:${eventId}`;
}

function sanitizeVersionedManagerApprovalBatch(value: unknown): PurchaseManagerApprovalBatchEntry | null {
  if (isRecord(value) && value.flowVersion !== undefined && value.flowVersion !== 'legacy' && value.flowVersion !== 'lifecycle_v1') throw new ConflictException('采购批次流程版本不受支持');
  const batch = sanitizeManagerApprovalBatch(value);
  if (isRecord(value) && value.flowVersion === 'lifecycle_v1' && !batch) throw new ConflictException('采购全流程批次账本损坏');
  if (isRecord(value) && value.stageCardTransition !== undefined && !batch) throw new ConflictException('采购分阶段批次账本损坏');
  return batch;
}

function sanitizeManagerApprovalBatch(
  value: unknown,
): PurchaseManagerApprovalBatchEntry | null {
  if (!isRecord(value)) return null;
  let registration: PurchaseManagerApprovalBatchRegistrationInput;
  try {
    registration = normalizeManagerApprovalBatchRegistration({
      approvalBatchId: String(value.approvalBatchId || ''),
      recipientOpenId: String(value.recipientOpenId || ''),
      requesterOpenId: String(value.requesterOpenId || ''),
      ...(value.flowVersion === undefined ? {} : { flowVersion: value.flowVersion as PurchaseManagerApprovalBatchRegistrationInput['flowVersion'] }),
      recordIds: Array.isArray(value.recordIds)
        ? value.recordIds.map((entry) => String(entry))
        : [],
    });
  } catch {
    return null;
  }
  const stageCardTransition = value.stageCardTransition === undefined
    ? undefined : parseStageCardTransition(value.stageCardTransition, registration);
  const heldSourceRecords = new Set(stageCardTransition?.heldSourceItems?.map(item => item.recordId));
  if (
    !Array.isArray(value.items) ||
    value.items.length !== registration.recordIds.length
  ) {
    return null;
  }
  const items: PurchaseManagerApprovalBatchItemEntry[] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) return null;
    const executionRecordId = clean(rawItem.executionRecordId);
    const status = rawItem.status;
    const choice = rawItem.choice;
    const decisionSource = rawItem.decisionSource;
    const rejectionReason = normalizeManagerRejectionReason(
      rawItem.rejectionReason,
    );
    const sourceHold = heldSourceRecords.has(executionRecordId);
    if (
      !RECORD_ID_PATTERN.test(executionRecordId) ||
      !isManagerBatchItemStatus(status) ||
      !isManagerBatchChoice(choice) ||
      (sourceHold
        ? status !== 'manual_reconciliation' || choice !== '' || rejectionReason !== '' ||
          decisionSource !== undefined || rawItem.actionEventId !== '' || rawItem.actorOpenId !== '' ||
          rawItem.processedAt !== '' || rawItem.purchaserOpenId !== '' || rawItem.lastError !== STAGE_SOURCE_ORDERING_HOLD_ERROR
        : !isValidManagerBatchItemDecision(status, choice, rejectionReason, decisionSource))
    ) {
      return null;
    }
    if (rawItem.executorHandover !== undefined) {
      const marker = normalizePurchaseExecutorHandover(rawItem.executorHandover);
      if (marker.recordId !== executionRecordId || marker.approvalBatchId !== registration.approvalBatchId || marker.choice !== choice ||
        marker.ready && marker.targetOpenId !== rawItem.purchaserOpenId || !marker.ready && marker.sourceOpenId !== rawItem.purchaserOpenId) throw new ServiceUnavailableException('采购原执行交接标记与明细不一致');
    }
    items.push({
      executionRecordId,
      ...(decisionSource === 'platform' ? { decisionSource: 'platform' as const } : {}),
      ...(rawItem.executorHandover === undefined ? {} : { executorHandover: normalizePurchaseExecutorHandover(rawItem.executorHandover) }),
      ...(rawItem.authorityTarget===undefined?{}:{authorityTarget:normalizePurchaseAuthorityTarget(rawItem.authorityTarget)}),
      status,
      choice,
      rejectionReason,
      actionEventId: boundedText(rawItem.actionEventId, MAX_EVENT_ID_LENGTH),
      actorOpenId: boundedText(rawItem.actorOpenId, MAX_OPEN_ID_LENGTH),
      processedAt: isoText(rawItem.processedAt),
      lastError: sanitizeError(rawItem.lastError),
      purchaserOpenId: boundedText(rawItem.purchaserOpenId, MAX_OPEN_ID_LENGTH),
      purchaserName: boundedText(rawItem.purchaserName, 200),
      paymentAttachmentTokens: sanitizeAttachmentTokens(
        rawItem.paymentAttachmentTokens,
      ),
      receiptPhotoTokens: sanitizeAttachmentTokens(rawItem.receiptPhotoTokens),
      invoiceTokens: sanitizeAttachmentTokens(rawItem.invoiceTokens),
    });
  }
  if (
    !sameStringArray(
      registration.recordIds,
      items.map((item) => item.executionRecordId),
    )
  ) {
    return null;
  }
  const state = value.state;
  if (!isManagerApprovalBatchState(state)) return null;
  const messageId = boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH);
  const cardContext = sanitizeManagerBatchCardContext(value.cardContext);
  const rawDeliveries = value.managerDeliveries === undefined ? [{
    recipientOpenId: registration.recipientOpenId, recipientName: '', messageId,
    sourceNotificationKey: value.sourceNotificationKey, selectedRejectRecordId: value.selectedRejectRecordId,
  }] : value.managerDeliveries;
  if (!Array.isArray(rawDeliveries) || !rawDeliveries.length || rawDeliveries.length > 100) return null;
  const managerDeliveries: PurchaseManagerApprovalDelivery[] = [];
  for (const raw of rawDeliveries) {
    if (!isRecord(raw)) return null;
    const recipientOpenId = boundedText(raw.recipientOpenId, MAX_OPEN_ID_LENGTH);
    const draft = clean(raw.selectedRejectRecordId);
    if (!OPEN_ID_PATTERN.test(recipientOpenId) || managerDeliveries.some(item => item.recipientOpenId === recipientOpenId || Boolean(raw.messageId) && item.messageId === raw.messageId) ||
      draft && !registration.recordIds.includes(draft)) return null;
    managerDeliveries.push({ recipientOpenId, recipientName: boundedText(raw.recipientName, 200),
      sourceNotificationKey: boundedText(raw.sourceNotificationKey, MAX_BUSINESS_EVENT_ID_LENGTH + 256),
      messageId: boundedText(raw.messageId, MAX_DELIVERY_ID_LENGTH), selectedRejectRecordId: draft });
  }
  if (managerDeliveries[0]!.recipientOpenId !== registration.recipientOpenId) return null;
  if (
    (state === 'awaiting_delivery' && (messageId || cardContext)) ||
    (state !== 'awaiting_delivery' && (!managerDeliveries.some(item => item.messageId) || !cardContext))
  ) {
    return null;
  }
  if (cardContext) {
    try {
      const context = parsePurchaseManagerBatchApprovalCardContext(cardContext);
      if (
        context.approvalBatchId !== registration.approvalBatchId ||
        context.requesterOpenId !== registration.requesterOpenId ||
        !sameStringArray(
          registration.recordIds,
          context.items.map((item) => item.executionRecordId),
        )
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  const selectedRejectRecordId = clean(value.selectedRejectRecordId);
  if (
    (state === 'reject_editing' &&
      !registration.recordIds.includes(selectedRejectRecordId)) ||
    (state !== 'reject_editing' && selectedRejectRecordId)
  ) {
    return null;
  }
  const pendingReceiptUpload = sanitizeReceiptUploadIntent(
    value.pendingReceiptUpload,
    registration,
  );
  if (value.pendingReceiptUpload && !pendingReceiptUpload) return null;
  let lifecycleInitialRecipients: Array<{ openId: string; fullView: boolean }> | undefined;
  let lifecycleAuthorityTargets: Array<{ recordId: string; target: PurchaseAuthorityTarget }> | undefined;
  if (registration.flowVersion === 'lifecycle_v1') {
    if (typeof value.lifecycleAppId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(value.lifecycleAppId) || !Array.isArray(value.lifecycleInitialRecipients) || !value.lifecycleInitialRecipients.length || value.lifecycleInitialRecipients.length > 200) return null;
    const recipients = value.lifecycleInitialRecipients;
    if (recipients.some(entry => !isRecord(entry) || typeof entry.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(entry.openId) || typeof entry.fullView !== 'boolean')) return null;
    lifecycleInitialRecipients = recipients.map(entry => ({ openId: (entry as { openId: string }).openId, fullView: (entry as { fullView: boolean }).fullView }));
    if (new Set(lifecycleInitialRecipients.map(entry => entry.openId)).size !== lifecycleInitialRecipients.length || JSON.stringify(lifecycleInitialRecipients) !== JSON.stringify([...lifecycleInitialRecipients].sort((a, b) => a.openId.localeCompare(b.openId)))) return null;
    if (!Array.isArray(value.lifecycleAuthorityTargets) || value.lifecycleAuthorityTargets.length !== registration.recordIds.length) return null;
    lifecycleAuthorityTargets = [];
    for (const [index, raw] of value.lifecycleAuthorityTargets.entries()) {
      if (!isRecord(raw) || raw.recordId !== registration.recordIds[index]) return null;
      const target = normalizePurchaseAuthorityTarget(raw.target);
      if (!target || JSON.stringify(target) !== JSON.stringify(items[index]?.authorityTarget)) return null;
      lifecycleAuthorityTargets.push({ recordId: raw.recordId as string, target });
    }
  } else if (value.lifecycleAppId !== undefined || value.lifecycleInitialRecipients !== undefined || value.lifecycleAuthorityTargets !== undefined) return null;
  return {
    ...registration,
    ...(lifecycleInitialRecipients ? { lifecycleAppId: value.lifecycleAppId as string, lifecycleInitialRecipients, lifecycleAuthorityTargets } : {}),
    ...(stageCardTransition ? { stageCardTransition } : {}),
    items,
    managerDeliveries,
    state,
    selectedRejectRecordId,
    sourceNotificationKey: boundedText(
      value.sourceNotificationKey,
      MAX_BUSINESS_EVENT_ID_LENGTH + 256,
    ),
    messageId,
    cardContext,
    revision: Math.max(1, safeAttempts(value.revision)),
    actorOpenId: boundedText(value.actorOpenId, MAX_OPEN_ID_LENGTH),
    processedAt: isoText(value.processedAt),
    createdAt: isoText(value.createdAt),
    updatedAt: isoText(value.updatedAt),
    resolvedAt: isoText(value.resolvedAt),
    ...(pendingReceiptUpload ? { pendingReceiptUpload } : {}),
  };
}

function parseStageCardTransition(
  value: unknown,
  registration: PurchaseManagerApprovalBatchRegistrationInput,
): PurchaseLifecycleStageCardTransitionReceipt {
  const invalid = () => new ConflictException('采购分阶段卡片转换回执损坏');
  if (!isRecord(value) || registration.flowVersion !== 'legacy' || value.version !== 1 ||
      typeof value.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/u.test(value.appId) ||
      !isoText(value.switchedAt) || !Number.isSafeInteger(value.originalRevision) || Number(value.originalRevision) < 1 ||
      !['active', 'resolved', 'manual_reconciliation'].includes(String(value.originalState)) ||
      !['originalBatchSha256', 'originalOutboxSha256', 'sourceReadbackSha256'].every(key =>
        typeof value[key] === 'string' && /^[a-f0-9]{64}$/u.test(value[key])) ||
      !Array.isArray(value.archivedMessageIds) || !value.archivedMessageIds.length ||
      value.archivedMessageIds.some(id => typeof id !== 'string' || !/^om_[A-Za-z0-9_-]+$/u.test(id)) ||
      new Set(value.archivedMessageIds).size !== value.archivedMessageIds.length ||
      !Array.isArray(value.retirementMessageIds) || !Array.isArray(value.retiredCards) ||
      !Array.isArray(value.initialRecipients) || !Array.isArray(value.authorityTargets) ||
      !Array.isArray(value.missingRecordIds) || !Array.isArray(value.reopenedItems)) throw invalid();
  const context = parsePurchaseManagerBatchApprovalCardContext(String(value.originalCardContext));
  const retirement = new Set(value.retirementMessageIds);
  const archived = new Set(value.archivedMessageIds);
  const missingRecordIds = value.missingRecordIds;
  const heldSourceItems = value.heldSourceItems;
  const heldTerminalOrders = value.heldTerminalOrders;
  if (context.approvalBatchId !== registration.approvalBatchId ||
      context.requesterOpenId !== registration.requesterOpenId ||
      !sameStringArray(context.items.map(item => item.executionRecordId), registration.recordIds) ||
      value.initialRecipients.some(person => !isRecord(person) || !OPEN_ID_PATTERN.test(String(person.openId)) || typeof person.fullView !== 'boolean') ||
      value.authorityTargets.length !== registration.recordIds.length ||
      value.authorityTargets.some((row, index) => !isRecord(row) || row.recordId !== registration.recordIds[index] || !normalizePurchaseAuthorityTarget(row.target)) ||
      new Set(missingRecordIds).size !== missingRecordIds.length ||
      missingRecordIds.some(id => !registration.recordIds.includes(id)) ||
      retirement.size !== value.retirementMessageIds.length || [...retirement].some(id => !archived.has(id)) ||
      new Set(value.retiredCards.map(row => isRecord(row) ? row.messageId : null)).size !== value.retiredCards.length ||
      value.retiredCards.some(row => !isRecord(row) || !retirement.has(row.messageId) ||
        typeof row.retiredAt !== 'string' || !isoText(row.retiredAt) || row.retiredAt < String(value.switchedAt)) ||
      (heldSourceItems !== undefined && (!Array.isArray(heldSourceItems) ||
        new Set(heldSourceItems.map(row => isRecord(row) ? row.recordId : null)).size !== heldSourceItems.length ||
        heldSourceItems.some(row => !isRecord(row) || !registration.recordIds.includes(String(row.recordId)) ||
          missingRecordIds.includes(row.recordId) || row.reason !== 'ordering_without_approval_receipt'))) ||
      (heldTerminalOrders !== undefined && (!Array.isArray(heldTerminalOrders) ||
        new Set(heldTerminalOrders.map(row => isRecord(row) ? row.recordId : null)).size !== heldTerminalOrders.length ||
        heldTerminalOrders.some(row => !isRecord(row) || !registration.recordIds.includes(String(row.recordId)) ||
          typeof row.claimSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.claimSha256)))) ||
      value.reopenedItems.some(row => !isRecord(row) || !registration.recordIds.includes(String(row.recordId)) ||
        missingRecordIds.includes(row.recordId) || !row.actionEventId ||
        row.lastError !== '采购明细授权范围已变化，需要重新核对')) throw invalid();
  return structuredClone(value) as unknown as PurchaseLifecycleStageCardTransitionReceipt;
}

function sanitizeReceiptUploadIntent(
  value: unknown,
  registration: PurchaseManagerApprovalBatchRegistrationInput,
): PurchaseBatchReceiptUploadIntent | null {
  if (!isRecord(value)) return null;
  const executionRecordId = clean(value.executionRecordId);
  const actorOpenId = boundedText(value.actorOpenId, MAX_OPEN_ID_LENGTH);
  const messageId = boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH);
  const materialType = value.materialType;
  const createdAt = isoText(value.createdAt);
  const expiresAt = isoText(value.expiresAt);
  if (
    !registration.recordIds.includes(executionRecordId) ||
    actorOpenId !== registration.requesterOpenId ||
    !messageId ||
    (materialType !== 'receipt_photo' && materialType !== 'invoice') ||
    !createdAt ||
    !expiresAt ||
    Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    return null;
  }
  let lifecycle: PurchaseManagerApprovalBatchCardIdentity['lifecycle'];
  try { lifecycle = normalizeLifecycleCallbackBinding(value.lifecycle as PurchaseManagerApprovalBatchCardIdentity['lifecycle']); }
  catch { return null; }
  if ((registration.flowVersion === 'lifecycle_v1') !== !!lifecycle) return null;
  return {
    executionRecordId,
    materialType,
    actorOpenId,
    messageId,
    createdAt,
    expiresAt,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function sanitizeManagerApprovalBatchAction(
  value: unknown,
): PurchaseManagerApprovalBatchActionEntry | null {
  if (!isRecord(value)) return null;
  const eventId = boundedText(value.eventId, MAX_EVENT_ID_LENGTH);
  let approvalBatchId: string;
  try {
    approvalBatchId = normalizeManagerApprovalBatchId(value.approvalBatchId);
  } catch {
    return null;
  }
  const recordIds = Array.isArray(value.recordIds)
    ? value.recordIds.map(clean).filter((item) => RECORD_ID_PATTERN.test(item))
    : [];
  const choice = value.choice;
  const rejectionReason = normalizeManagerRejectionReason(
    value.rejectionReason,
  );
  const messageId = boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH);
  const actorOpenId = boundedText(value.actorOpenId, MAX_OPEN_ID_LENGTH);
  const status = value.status;
  if (
    !eventId ||
    recordIds.length < 1 ||
    recordIds.length > 20 ||
    new Set(recordIds).size !== recordIds.length ||
    !isManagerBatchTerminalChoice(choice) ||
    (choice === 'reject' && (recordIds.length !== 1 || !rejectionReason)) ||
    (choice !== 'reject' && rejectionReason) ||
    !messageId ||
    !OPEN_ID_PATTERN.test(actorOpenId) ||
    !isManagerApprovalBatchActionStatus(status)
  ) {
    return null;
  }
  const claimToken = validClaimToken(value.claimToken);
  return {
    key: managerApprovalBatchActionKey(eventId),
    eventId,
    approvalBatchId,
    recordIds,
    choice,
    rejectionReason,
    messageId,
    actorOpenId,
    status,
    attempts: safeAttempts(value.attempts),
    createdAt: isoText(value.createdAt),
    updatedAt: isoText(value.updatedAt),
    nextAttemptAt: isoText(value.nextAttemptAt),
    leaseUntil:
      status === 'processing' && claimToken ? isoText(value.leaseUntil) : '',
    claimToken: status === 'processing' ? claimToken : '',
    completedAt: isoText(value.completedAt),
    lastError: sanitizeError(value.lastError),
  };
}

function sanitizeManagerApprovalAction(
  value: unknown,
): PurchaseManagerApprovalActionEntry | null {
  if (!isRecord(value)) return null;
  const eventId = boundedText(value.eventId, MAX_EVENT_ID_LENGTH);
  const recordId = clean(value.recordId);
  const choice = value.choice;
  const messageId = boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH);
  const actorOpenId = boundedText(value.actorOpenId, MAX_OPEN_ID_LENGTH);
  const status = value.status;
  if (
    !eventId ||
    !RECORD_ID_PATTERN.test(recordId) ||
    !isManagerApprovalChoice(choice) ||
    !messageId ||
    !OPEN_ID_PATTERN.test(actorOpenId) ||
    !isManagerApprovalActionStatus(status)
  ) {
    return null;
  }
  const rejectionReason = normalizeManagerRejectionReason(
    value.rejectionReason,
  );
  if (
    (choice === 'reject' && !rejectionReason) ||
    (choice !== 'reject' && rejectionReason)
  ) {
    return null;
  }
  const claimToken = validClaimToken(value.claimToken);
  return {
    key: managerApprovalActionKey(eventId),
    eventId,
    recordId,
    choice,
    rejectionReason,
    messageId,
    actorOpenId,
    status,
    attempts: safeAttempts(value.attempts),
    createdAt: isoText(value.createdAt),
    updatedAt: isoText(value.updatedAt),
    nextAttemptAt: isoText(value.nextAttemptAt),
    leaseUntil:
      status === 'processing' && claimToken ? isoText(value.leaseUntil) : '',
    claimToken: status === 'processing' ? claimToken : '',
    completedAt: isoText(value.completedAt),
    lastError: sanitizeError(value.lastError),
  };
}

function sanitizeManagerApprovalCard(
  value: unknown,
): PurchaseManagerApprovalCardEntry | null {
  if (!isRecord(value)) return null;
  if(value.personnelHandover!==undefined&&!validSingleManagerHandover(value.personnelHandover))throw new ServiceUnavailableException('采购原卡交接标记无效');
  const executionRecordId = clean(value.executionRecordId);
  const messageId = boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH);
  const recipientOpenId = boundedText(
    value.recipientOpenId,
    MAX_OPEN_ID_LENGTH,
  );
  const sourceNotificationKey = boundedText(
    value.sourceNotificationKey,
    MAX_BUSINESS_EVENT_ID_LENGTH + 256,
  );
  const cardContext = sanitizeManagerCardContext(value.cardContext);
  const state = value.state;
  const choice = value.choice;
  if (
    !RECORD_ID_PATTERN.test(executionRecordId) ||
    !messageId ||
    !OPEN_ID_PATTERN.test(recipientOpenId) ||
    !sourceNotificationKey ||
    value.sourceKind !== 'manager_approval_requested' ||
    value.sourceStatus !== 'completed' ||
    !cardContext ||
    !isManagerApprovalCardState(state) ||
    !(choice === '' || isManagerApprovalChoice(choice))
  ) {
    return null;
  }
  try {
    if (
      parsePurchaseManagerApprovalCardContext(cardContext).executionRecordId !==
      executionRecordId
    ) {
      return null;
    }
  } catch {
    return null;
  }
  if (
    (state === 'pending' || state === 'resolved') &&
    !isManagerApprovalChoice(choice)
  ) {
    return null;
  }
  const supersededMessageIds = Array.isArray(value.supersededMessageIds)
    ? [
        ...new Set(
          value.supersededMessageIds
            .map((item) => boundedText(item, MAX_DELIVERY_ID_LENGTH))
            .filter((item) => item && item !== messageId),
        ),
      ]
    : [];
  return {
    key: managerApprovalCardKey(executionRecordId, recipientOpenId),
    executionRecordId,
    messageId,
    supersededMessageIds,
    recipientOpenId,
    sourceNotificationKey,
    sourceKind: 'manager_approval_requested',
    sourceStatus: 'completed',
    ...(value.personnelHandover===undefined?{}:{personnelHandover:structuredClone(value.personnelHandover as PurchaseSingleManagerHandover)}),
    cardContext,
    state,
    choice,
    rejectionReasonDraft: normalizeManagerRejectionReason(
      value.rejectionReasonDraft,
    ),
    actionEventId: boundedText(value.actionEventId, MAX_EVENT_ID_LENGTH),
    actorOpenId: boundedText(value.actorOpenId, MAX_OPEN_ID_LENGTH),
    processedAt: isoText(value.processedAt),
    createdAt: isoText(value.createdAt),
    updatedAt: isoText(value.updatedAt),
    resolvedAt: isoText(value.resolvedAt),
  };
}

function normalizeNotificationInput(
  value: PurchaseWorkflowNotificationInput,
): PurchaseWorkflowNotificationInput {
  const businessEventId = boundedText(
    value?.businessEventId,
    MAX_BUSINESS_EVENT_ID_LENGTH,
  );
  const recordId = clean(value?.recordId);
  const recipientOpenId = boundedText(
    value?.recipientOpenId,
    MAX_OPEN_ID_LENGTH,
  );
  if (
    !businessEventId ||
    !RECORD_ID_PATTERN.test(recordId) ||
    !OPEN_ID_PATTERN.test(recipientOpenId) ||
    !isNotificationKind(value?.kind)
  ) {
    throw new Error('Invalid purchase workflow notification');
  }
  const cardContext = value.cardContext !== undefined && (
    value.kind === 'manager_batch_purchase_refresh' ||
    value.kind === 'manager_batch_receipt_requested' ||
    value.kind === 'manager_batch_receipt_refresh' ||
    value.kind === 'manager_batch_receipt_completed'
  )
    ? canonicalManagerBatchCardContext(value.cardContext)
    : normalizeOptionalCardContext(value.cardContext);
  return {
    businessEventId,
    recordId,
    recipientOpenId,
    kind: value.kind,
    ...(cardContext === undefined ? {} : { cardContext }),
  };
}

function notificationKey(input: {
  businessEventId: string;
  recordId: string;
  recipientOpenId: string;
}): string {
  return `${input.businessEventId}:${input.recordId}:${input.recipientOpenId}`;
}

function createNotificationEntry(
  input: PurchaseWorkflowNotificationInput,
  timestamp: string,
): PurchaseWorkflowNotificationEntry {
  const key = notificationKey(input);
  return {
    key,
    ...input,
    status: 'pending',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    leaseUntil: '',
    claimToken: '',
    completedAt: '',
    lastError: '',
    deliveryId: '',
    messageId: '',
    deliveryUuid: isIdempotentInventoryNotificationKind(input.kind) || input.kind === 'purchase_order_completed'
      ? stableInboundCompletedDeliveryUuid(key)
      : isManagerNotificationKind(input.kind)
        ? stableManagerDeliveryUuid(key, 1)
        : '',
    firstSendAttemptAt: '',
    sendOutcome: 'unattempted',
    deliveryGeneration: 1,
    cardContext: input.cardContext || '',
    deliveryAudit: [],
  };
}

function normalizeReceiptDeliveryEvidence(
  value: NonNullable<PurchaseManagerReceiptBatchRecoveryInput['delivered']>,
  fallbackNow: Date | number,
): {
  messageId: string;
  deliveryUuid: string;
  attempts: number;
  deliveredAt: string;
} {
  const messageId = boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH);
  const deliveryUuid = boundedText(value.deliveryUuid, 50);
  const attempts = safeAttempts(value.attempts);
  if (
    !FEISHU_MESSAGE_ID_PATTERN.test(messageId) ||
    (deliveryUuid && !INTERACTIVE_MESSAGE_UUID_PATTERN.test(deliveryUuid))
  ) {
    throw new BadRequestException('采购签收卡已送达证据无效');
  }
  return {
    messageId,
    deliveryUuid,
    attempts: Math.max(1, attempts),
    deliveredAt: resolveNow(value.deliveredAt || fallbackNow).toISOString(),
  };
}

function toDeliveredReceiptNotification(
  entry: PurchaseWorkflowNotificationEntry,
  evidence: ReturnType<typeof normalizeReceiptDeliveryEvidence>,
): PurchaseWorkflowNotificationEntry {
  if (
    evidence.deliveryUuid &&
    entry.firstSendAttemptAt &&
    entry.deliveryUuid &&
    entry.deliveryUuid !== evidence.deliveryUuid
  ) {
    throw new ConflictException('采购签收卡投递标识与本地台账冲突');
  }
  const deliveryUuid = evidence.deliveryUuid || entry.deliveryUuid;
  return {
    ...entry,
    status: 'completed',
    attempts: Math.max(entry.attempts, evidence.attempts),
    updatedAt: evidence.deliveredAt,
    nextAttemptAt: evidence.deliveredAt,
    leaseUntil: '',
    claimToken: '',
    completedAt: evidence.deliveredAt,
    lastError: '',
    messageId: evidence.messageId,
    deliveryUuid,
    firstSendAttemptAt: entry.firstSendAttemptAt || evidence.deliveredAt,
    sendOutcome: 'delivered',
    deliveryAudit: appendDeliveryAudit(entry.deliveryAudit, {
      action: 'operator_verified_delivered',
      at: evidence.deliveredAt,
      operatorOpenId: '',
      generation: entry.deliveryGeneration,
      deliveryUuid,
      messageId: evidence.messageId,
    }),
  };
}

function sameCardActionPayload(
  entry: PurchaseWorkflowCardActionEntry,
  input: Pick<
    PurchaseWorkflowCardActionEntry,
    'eventId' | 'recordId' | 'action' | 'actorOpenId'
  >,
): boolean {
  return (
    entry.eventId === input.eventId &&
    entry.recordId === input.recordId &&
    entry.action === input.action &&
    entry.actorOpenId === input.actorOpenId
  );
}

function sameManagerApprovalActionPayload(
  entry: PurchaseManagerApprovalActionEntry,
  input: Pick<
    PurchaseManagerApprovalActionEntry,
    | 'eventId'
    | 'recordId'
    | 'choice'
    | 'rejectionReason'
    | 'messageId'
    | 'actorOpenId'
  >,
): boolean {
  return (
    entry.eventId === input.eventId &&
    entry.recordId === input.recordId &&
    entry.choice === input.choice &&
    entry.rejectionReason === input.rejectionReason &&
    entry.messageId === input.messageId &&
    entry.actorOpenId === input.actorOpenId
  );
}

function sanitizeCardAction(
  value: unknown,
): PurchaseWorkflowCardActionEntry | null {
  if (!isRecord(value)) return null;
  const eventId = boundedText(value.eventId, MAX_EVENT_ID_LENGTH);
  const recordId = clean(value.recordId);
  const actorOpenId = boundedText(value.actorOpenId, MAX_OPEN_ID_LENGTH);
  const action = value.action;
  const status = value.status;
  if (
    !eventId ||
    !RECORD_ID_PATTERN.test(recordId) ||
    !actorOpenId ||
    (action !== 'approve' && action !== 'reject') ||
    !isQueueStatus(status)
  ) {
    return null;
  }
  const claimToken = validClaimToken(value.claimToken);
  if (value.plannedPurchaser !== undefined && action !== 'approve') throw new ServiceUnavailableException('采购原审批办理人快照与动作不一致');
  return {
    key: `approval:${recordId}`,
    ...(value.authority === undefined ? {} : { authority: normalizePurchaseCardActionAuthority(value.authority) }),
    ...(value.plannedPurchaser === undefined ? {} : { plannedPurchaser: normalizeCardActionPurchaser(value.plannedPurchaser) }),
    eventId,
    recordId,
    action,
    actorOpenId,
    status,
    attempts: safeAttempts(value.attempts),
    createdAt: isoText(value.createdAt),
    updatedAt: isoText(value.updatedAt),
    nextAttemptAt: isoText(value.nextAttemptAt),
    leaseUntil:
      status === 'processing' && claimToken ? isoText(value.leaseUntil) : '',
    claimToken: status === 'processing' ? claimToken : '',
    completedAt: isoText(value.completedAt),
    lastError: sanitizeError(value.lastError),
  };
}

function normalizeCardActionPurchaser(value: unknown): Pick<PurchaseWorkflowUser, 'openId' | 'name'> {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'name,openId' || typeof value.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(value.openId) ||
    typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(value.name)) throw new ServiceUnavailableException('原采购审批办理人快照无效');
  return { openId: value.openId, name: value.name };
}

function normalizePurchaseCardActionAuthority(value: unknown): PurchaseCardActionAuthority {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'appId,scope' || typeof value.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(value.appId)) throw new ServiceUnavailableException('原采购审批受理应用身份无效');
  const scope = normalizePurchaseAuthorityTarget(value.scope);
  if (!scope) throw new ServiceUnavailableException('原采购审批受理范围无效');
  return { appId: value.appId, scope };
}

function sanitizeNotification(
  value: unknown,
): PurchaseWorkflowNotificationEntry | null {
  if (!isRecord(value)) return null;
  const businessEventId = boundedText(
    value.businessEventId,
    MAX_BUSINESS_EVENT_ID_LENGTH,
  );
  const recordId = clean(value.recordId);
  const recipientOpenId = boundedText(
    value.recipientOpenId,
    MAX_OPEN_ID_LENGTH,
  );
  const kind = value.kind;
  const status = value.status;
  if (
    !businessEventId ||
    !RECORD_ID_PATTERN.test(recordId) ||
    (!OPEN_ID_PATTERN.test(recipientOpenId) && !(kind === 'web_receipt_command' && recipientOpenId === '')) ||
    !isNotificationKind(kind) ||
    !isNotificationStatus(status)
  ) {
    if (kind === 'web_receipt_command' || value.webReceipt !== undefined) throw new ServiceUnavailableException('网页签收任务账本损坏');
    return null;
  }
  const claimToken = validClaimToken(value.claimToken);
  if (kind === 'web_receipt_command' && value.webReceipt === undefined || value.webReceipt !== undefined && kind !== 'web_receipt_command') throw new ServiceUnavailableException('网页签收任务类型无效');
  if (kind === 'web_receipt_command') {
    const receipt = normalizeWebReceiptCommand(value.webReceipt);
    if (!recipientOpenId && !receipt.platformIdentity) throw new ServiceUnavailableException('网页签收任务的实名身份缺失');
    if (receipt.recordId !== recordId || receipt.taskId !== businessEventId || receipt.actor.openId !== recipientOpenId) throw new ServiceUnavailableException('网页签收任务与原记录不一致');
  }
  if (value.approvalHandover !== undefined && (kind !== 'approval_requested' || !validSingleManagerHandover(value.approvalHandover))) throw new ServiceUnavailableException('采购原审批交接标记无效');
  if (value.approvalAuthority !== undefined && kind !== 'approval_requested') throw new ServiceUnavailableException('采购原审批发卡身份类型无效');
  if(value.acceptedAppId!==undefined&&(!isPurchaseBatchFulfillmentCommandKind(kind)||typeof value.acceptedAppId!=='string'||!/^cli_[A-Za-z0-9_-]+$/.test(value.acceptedAppId)))throw new ServiceUnavailableException('原采购命令应用身份无效');
  let lifecycleBinding: PurchaseWorkflowNotificationEntry['lifecycleBinding'];
  if (value.lifecycleBinding !== undefined) {
    const binding = value.lifecycleBinding;
    if (!isRecord(binding) || typeof binding.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(binding.appId) ||
      typeof binding.deliveryUuid !== 'string' || !INTERACTIVE_MESSAGE_UUID_PATTERN.test(binding.deliveryUuid) ||
      !Number.isSafeInteger(binding.generation) || (binding.generation as number) < 1 || !Number.isSafeInteger(binding.revision) || (binding.revision as number) < 1 ||
      typeof binding.messageId !== 'string' || !FEISHU_MESSAGE_ID_PATTERN.test(binding.messageId) || binding.messageId !== value.messageId || status !== 'completed' || value.sendOutcome !== 'delivered') throw new ServiceUnavailableException('采购全流程通知投递映射损坏');
    lifecycleBinding = { appId: binding.appId, deliveryUuid: binding.deliveryUuid, generation: binding.generation as number, revision: binding.revision as number, messageId: binding.messageId };
  }
  const deliveryGeneration = Math.max(
    1,
    safeAttempts(value.deliveryGeneration),
  );
  const legacyWarehouseUnknown = kind === 'warehouse_inbound' && !boundedText(value.deliveryUuid, 50) &&
    !boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH) && safeAttempts(value.attempts) > 0;
  const effectiveStatus = legacyWarehouseUnknown ? 'manual_reconciliation' : status;
  return {
    key: notificationKey({ businessEventId, recordId, recipientOpenId }),
    businessEventId,
    recordId,
    recipientOpenId,
    kind,
    ...(value.webReceipt === undefined ? {} : { webReceipt: normalizeWebReceiptCommand(value.webReceipt) }),
    ...(value.approvalHandover === undefined ? {} : { approvalHandover: structuredClone(value.approvalHandover as PurchaseSingleManagerHandover) }),
    ...(value.approvalAuthority === undefined ? {} : { approvalAuthority: normalizePurchaseCardActionAuthority(value.approvalAuthority) }),
    status: effectiveStatus,
    ...(value.acceptedAppId===undefined?{}:{acceptedAppId:value.acceptedAppId as string}),
    ...(lifecycleBinding ? { lifecycleBinding } : {}),
    attempts: safeAttempts(value.attempts),
    createdAt: isoText(value.createdAt),
    updatedAt: isoText(value.updatedAt),
    nextAttemptAt: isoText(value.nextAttemptAt),
    leaseUntil:
      effectiveStatus === 'processing' && claimToken ? isoText(value.leaseUntil) : '',
    claimToken: effectiveStatus === 'processing' ? claimToken : '',
    completedAt: isoText(value.completedAt),
    lastError: legacyWarehouseUnknown ? '旧入库提醒未记录幂等投递凭据，请先核对发送结果' : sanitizeError(value.lastError),
    deliveryId: boundedText(value.deliveryId, MAX_DELIVERY_ID_LENGTH),
    messageId: boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH),
    deliveryUuid: legacyWarehouseUnknown ? '' :
      boundedText(value.deliveryUuid, 50) ||
      (isIdempotentInventoryNotificationKind(kind) || kind === 'purchase_order_completed'
        ? stableInboundCompletedDeliveryUuid(
            notificationKey({ businessEventId, recordId, recipientOpenId }),
          )
        : isManagerNotificationKind(kind)
          ? stableManagerDeliveryUuid(
              notificationKey({ businessEventId, recordId, recipientOpenId }),
              deliveryGeneration,
            )
          : ''),
    firstSendAttemptAt: isoText(value.firstSendAttemptAt),
    sendOutcome: legacyWarehouseUnknown ? 'manual_reconciliation' : isManagerApprovalSendOutcome(value.sendOutcome)
      ? value.sendOutcome
      : 'unattempted',
    deliveryGeneration,
    cardContext: isPurchaseBatchFulfillmentCommandKind(kind)
      ? sanitizePurchaseBatchFulfillmentCommandContext(value.cardContext)
      : kind === 'manager_batch_receipt_attachment'
        ? sanitizeOptionalCardContext(value.cardContext)
        : isManagerNotificationKind(kind)
          ? sanitizeManagerCardContext(value.cardContext)
          : sanitizeOptionalCardContext(value.cardContext),
    deliveryAudit: Array.isArray(value.deliveryAudit)
      ? value.deliveryAudit
          .map(audit => sanitizeDeliveryAudit(audit, kind === 'approval_requested' ? { openId: recipientOpenId, messageId: boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH) } : undefined))
          .filter(
            (entry): entry is PurchaseManagerApprovalDeliveryAuditEntry =>
              entry !== null,
          )
          .slice(-MAX_DELIVERY_AUDIT_ENTRIES)
      : [],
  };
}

function uniqueCardActions(
  entries: PurchaseWorkflowCardActionEntry[],
): PurchaseWorkflowCardActionEntry[] {
  const result: PurchaseWorkflowCardActionEntry[] = [];
  const byKey = new Map<string, PurchaseWorkflowCardActionEntry>();
  const byEventId = new Map<string, PurchaseWorkflowCardActionEntry>();
  for (const entry of entries) {
    const keyMatch = byKey.get(entry.key);
    const eventMatch = byEventId.get(entry.eventId);
    if (!keyMatch && !eventMatch) {
      result.push(entry);
      byKey.set(entry.key, entry);
      byEventId.set(entry.eventId, entry);
      continue;
    }
    if (
      keyMatch &&
      eventMatch &&
      keyMatch === eventMatch &&
      samePersistedEntry(keyMatch, entry)
    ) {
      continue;
    }
    throw new ConflictException('采购审批账本存在冲突任务');
  }
  return result;
}

function uniqueNotifications(
  entries: PurchaseWorkflowNotificationEntry[],
): PurchaseWorkflowNotificationEntry[] {
  const result: PurchaseWorkflowNotificationEntry[] = [];
  const seen = new Map<string, PurchaseWorkflowNotificationEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.key);
    if (!existing) {
      result.push(entry);
      seen.set(entry.key, entry);
      continue;
    }
    if (samePersistedEntry(existing, entry)) continue;
    throw new ConflictException('采购通知账本存在冲突任务');
  }
  return result;
}

function uniqueManagerApprovalActions(
  entries: PurchaseManagerApprovalActionEntry[],
): PurchaseManagerApprovalActionEntry[] {
  const result: PurchaseManagerApprovalActionEntry[] = [];
  const seen = new Map<string, PurchaseManagerApprovalActionEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.eventId);
    if (!existing) {
      result.push(entry);
      seen.set(entry.eventId, entry);
      continue;
    }
    if (samePersistedEntry(existing, entry)) continue;
    throw new ConflictException('经理审批动作账本存在冲突任务');
  }
  return result;
}

function uniqueManagerApprovalCards(
  entries: PurchaseManagerApprovalCardEntry[],
): PurchaseManagerApprovalCardEntry[] {
  const result: PurchaseManagerApprovalCardEntry[] = [];
  const byKey = new Map<string, PurchaseManagerApprovalCardEntry>();
  const messageOwners = new Map<string, PurchaseManagerApprovalCardEntry>();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    if (existing) {
      if (samePersistedEntry(existing, entry)) continue;
      throw new ConflictException('经理审批卡账本存在记录冲突');
    }
    for (const messageId of [entry.messageId, ...entry.supersededMessageIds]) {
      const owner = messageOwners.get(messageId);
      if (owner) {
        throw new ConflictException('经理审批卡消息映射存在冲突');
      }
      messageOwners.set(messageId, entry);
    }
    byKey.set(entry.key, entry);
    result.push(entry);
  }
  return result;
}

function uniqueManagerApprovalBatches(
  entries: PurchaseManagerApprovalBatchEntry[],
): PurchaseManagerApprovalBatchEntry[] {
  const result: PurchaseManagerApprovalBatchEntry[] = [];
  const byBatchId = new Map<string, PurchaseManagerApprovalBatchEntry>();
  const messageOwners = new Map<string, PurchaseManagerApprovalBatchEntry>();
  for (const entry of entries) {
    const existing = byBatchId.get(entry.approvalBatchId);
    if (existing) {
      if (samePersistedEntry(existing, entry)) continue;
      throw new ConflictException('采购批次审批账本存在记录冲突');
    }
    if (entry.messageId) {
      const owner = messageOwners.get(entry.messageId);
      if (owner) {
        throw new ConflictException('采购批次审批卡消息映射存在冲突');
      }
      messageOwners.set(entry.messageId, entry);
    }
    byBatchId.set(entry.approvalBatchId, entry);
    result.push(entry);
  }
  return result;
}

function uniqueManagerApprovalBatchActions(
  entries: PurchaseManagerApprovalBatchActionEntry[],
): PurchaseManagerApprovalBatchActionEntry[] {
  const result: PurchaseManagerApprovalBatchActionEntry[] = [];
  const seen = new Map<string, PurchaseManagerApprovalBatchActionEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.eventId);
    if (!existing) {
      seen.set(entry.eventId, entry);
      result.push(entry);
      continue;
    }
    if (samePersistedEntry(existing, entry)) continue;
    throw new ConflictException('采购批次审批动作账本存在记录冲突');
  }
  return result;
}

function requireActiveManagerApprovalCard(
  ledger: PurchaseWorkflowLedger,
  identity: PurchaseManagerApprovalCardIdentity,
): PurchaseManagerApprovalCardEntry {
  if (
    ledger.managerApprovalCards.some((card) =>
      card.supersededMessageIds.includes(identity.messageId),
    )
  ) {
    throw new ConflictException('经理审批卡消息已被替代');
  }
  const matches = ledger.managerApprovalCards.filter(
    (card) =>
      card.executionRecordId === identity.recordId &&
      card.messageId === identity.messageId &&
      card.recipientOpenId === identity.actorOpenId &&
      card.sourceKind === 'manager_approval_requested' &&
      card.sourceStatus === 'completed',
  );
  if (matches.length !== 1) {
    throw new ConflictException(
      matches.length > 1
        ? '经理审批卡消息映射不唯一'
        : '经理审批卡消息映射不存在',
    );
  }
  const card = matches[0];
  if (!card) throw new ConflictException('经理审批卡消息映射不存在');
  return card;
}

function requireClaimedManagerApprovalActionAndCard(
  ledger: PurchaseWorkflowLedger,
  key: string,
  claimToken: string,
): {
  actionIndex: number;
  action: PurchaseManagerApprovalActionEntry;
  card: PurchaseManagerApprovalCardEntry;
} {
  const normalizedKey = clean(key);
  const actionIndex = ledger.managerApprovalActions.findIndex(
    (entry) => entry.key === normalizedKey,
  );
  const action = ledger.managerApprovalActions[actionIndex];
  if (actionIndex < 0 || !action) {
    throw new ConflictException('经理审批动作不存在');
  }
  assertClaimOwnership(action, claimToken);
  const card = requireActiveManagerApprovalCard(ledger, {
    recordId: action.recordId,
    messageId: action.messageId,
    actorOpenId: action.actorOpenId,
  });
  if (
    card.state !== 'pending' ||
    card.choice !== action.choice ||
    card.rejectionReasonDraft !== action.rejectionReason ||
    card.actionEventId !== action.eventId ||
    card.actorOpenId !== action.actorOpenId
  ) {
    throw new ConflictException('经理审批动作与卡片状态不一致');
  }
  return { actionIndex, action, card };
}

function enqueueManagerApprovalStateNotification(
  ledger: PurchaseWorkflowLedger,
  action: PurchaseManagerApprovalActionEntry,
  card: PurchaseManagerApprovalCardEntry,
  kind:
    | 'manager_approval_resolved'
    | 'manager_approval_reopened'
    | 'manager_approval_attention_required',
  timestamp: string,
  deliveryGeneration?: number,
): PurchaseWorkflowNotificationEntry {
  const isDeliveryAttention =
    kind === 'manager_approval_attention_required' &&
    typeof deliveryGeneration === 'number' &&
    Number.isSafeInteger(deliveryGeneration) &&
    deliveryGeneration > 0;
  const attentionGeneration = isDeliveryAttention
    ? `:${deliveryGeneration}`
    : '';
  const input: PurchaseWorkflowNotificationInput = {
    businessEventId: `${kind}:${action.eventId}${attentionGeneration}`,
    recordId: action.recordId,
    recipientOpenId: card.recipientOpenId,
    kind,
  };
  const key = notificationKey(input);
  const existing = ledger.notifications.find((entry) => entry.key === key);
  if (existing) {
    if (existing.kind !== kind) {
      throw new ConflictException('经理审批状态通知与已有任务冲突');
    }
    return existing;
  }
  if (
    kind !== 'manager_approval_attention_required' &&
    ledger.notifications.filter((entry) => isActiveStatus(entry.status))
      .length >= MAX_NOTIFICATIONS
  ) {
    throw new ServiceUnavailableException('采购通知任务队列已满，请稍后重试');
  }
  const notification: PurchaseWorkflowNotificationEntry = {
    key,
    ...input,
    status: 'pending',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    leaseUntil: '',
    claimToken: '',
    completedAt: '',
    lastError: '',
    deliveryId: '',
    messageId: card.messageId,
    deliveryUuid: stableManagerDeliveryUuid(key, 1),
    firstSendAttemptAt: '',
    sendOutcome: 'unattempted',
    deliveryGeneration: isDeliveryAttention ? deliveryGeneration : 1,
    cardContext: card.cardContext,
    deliveryAudit: [],
  };
  ledger.notifications.push(notification);
  return notification;
}

function requireManualReopenedManagerApprovalRecovery(
  ledger: PurchaseWorkflowLedger,
  notification: PurchaseWorkflowNotificationEntry,
): {
  action: PurchaseManagerApprovalActionEntry;
  card: PurchaseManagerApprovalCardEntry;
} {
  if (
    notification.kind !== 'manager_approval_reopened' ||
    notification.status !== 'manual_reconciliation' ||
    notification.sendOutcome !== 'manual_reconciliation' ||
    !notification.messageId ||
    !notification.cardContext
  ) {
    throw new ConflictException('经理审批恢复卡送达状态不允许人工解除');
  }
  const actions = ledger.managerApprovalActions.filter(
    (candidate) =>
      candidate.recordId === notification.recordId &&
      candidate.messageId === notification.messageId &&
      candidate.actorOpenId === notification.recipientOpenId &&
      candidate.status === 'failed' &&
      notification.businessEventId ===
        `manager_approval_reopened:${candidate.eventId}`,
  );
  if (actions.length !== 1) {
    throw new ConflictException(
      actions.length > 1
        ? '经理审批恢复卡失败动作不唯一'
        : '经理审批恢复卡失败动作不存在',
    );
  }
  const action = actions[0];
  if (!action) {
    throw new ConflictException('经理审批恢复卡失败动作不存在');
  }
  const cards = ledger.managerApprovalCards.filter(
    (candidate) =>
      candidate.key ===
      managerApprovalCardKey(
        notification.recordId,
        notification.recipientOpenId,
      ),
  );
  if (cards.length !== 1) {
    throw new ConflictException(
      cards.length > 1
        ? '经理审批恢复卡记录不唯一'
        : '经理审批恢复卡记录不存在',
    );
  }
  const card = cards[0];
  if (
    !card ||
    card.messageId !== notification.messageId ||
    card.cardContext !== notification.cardContext ||
    card.state !== 'manual_reconciliation' ||
    card.choice !== action.choice ||
    card.rejectionReasonDraft !== action.rejectionReason ||
    card.actionEventId !== action.eventId ||
    card.actorOpenId !== action.actorOpenId
  ) {
    throw new ConflictException('经理审批恢复卡与失败动作不一致');
  }
  return { action, card };
}

function restoreReopenedManagerApprovalCard(
  card: PurchaseManagerApprovalCardEntry,
  action: PurchaseManagerApprovalActionEntry,
  timestamp: string,
): PurchaseManagerApprovalCardEntry {
  return {
    ...card,
    state: action.choice === 'reject' ? 'reject_editing' : 'initial',
    choice: '',
    rejectionReasonDraft:
      action.choice === 'reject' ? action.rejectionReason : '',
    actionEventId: '',
    actorOpenId: '',
    processedAt: '',
    updatedAt: timestamp,
    resolvedAt: '',
  };
}

function completeManagerApprovalAttentionNotification(
  ledger: PurchaseWorkflowLedger,
  action: PurchaseManagerApprovalActionEntry,
  deliveryGeneration: number,
  timestamp: string,
): void {
  const businessEventId = `manager_approval_attention_required:${action.eventId}:${deliveryGeneration}`;
  const matches = ledger.notifications
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.kind === 'manager_approval_attention_required' &&
        entry.recordId === action.recordId &&
        entry.businessEventId === businessEventId,
    );
  if (matches.length !== 1) {
    throw new ConflictException(
      matches.length > 1
        ? '经理审批人工提醒任务不唯一'
        : '经理审批人工提醒任务不存在',
    );
  }
  const match = matches[0];
  if (!match || match.entry.status === 'completed') return;
  ledger.notifications[match.index] = {
    ...match.entry,
    status: 'completed',
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    leaseUntil: '',
    claimToken: '',
    completedAt: timestamp,
    lastError: '',
  };
}

function completeManualReopenedManagerApprovalDelivery(
  ledger: PurchaseWorkflowLedger,
  current: PurchaseWorkflowNotificationEntry,
  messageId: string,
  operatorOpenId: string,
  auditAction: 'operator_verified_delivered' | 'callback_bound',
  timestamp: string,
): {
  notification: PurchaseWorkflowNotificationEntry;
  card: PurchaseManagerApprovalCardEntry;
} {
  const recovered = requireManualReopenedManagerApprovalRecovery(
    ledger,
    current,
  );
  if (messageId === recovered.card.messageId) {
    throw new ConflictException('经理审批恢复卡必须绑定新的消息');
  }
  if (
    ledger.managerApprovalCards.some(
      (entry) =>
        entry.messageId === messageId ||
        entry.supersededMessageIds.includes(messageId),
    )
  ) {
    throw new ConflictException('经理审批恢复卡新消息已绑定其他记录');
  }
  const notificationIndex = ledger.notifications.findIndex(
    (entry) => entry.key === current.key,
  );
  if (notificationIndex < 0) {
    throw new ConflictException('经理审批恢复卡未知送达任务不存在');
  }
  const notification: PurchaseWorkflowNotificationEntry = {
    ...current,
    status: 'completed',
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    leaseUntil: '',
    claimToken: '',
    completedAt: timestamp,
    lastError: '',
    messageId,
    sendOutcome: 'delivered',
    deliveryAudit: appendDeliveryAudit(current.deliveryAudit, {
      action: auditAction,
      at: timestamp,
      operatorOpenId,
      generation: current.deliveryGeneration,
      deliveryUuid: current.deliveryUuid,
      messageId,
    }),
  };
  const restored = restoreReopenedManagerApprovalCard(
    recovered.card,
    recovered.action,
    timestamp,
  );
  const card: PurchaseManagerApprovalCardEntry = {
    ...restored,
    messageId,
    supersededMessageIds: [
      ...new Set([
        ...recovered.card.supersededMessageIds,
        recovered.card.messageId,
      ]),
    ],
  };
  ledger.notifications[notificationIndex] = notification;
  replaceManagerApprovalCard(ledger, card);
  completeManagerApprovalAttentionNotification(
    ledger,
    recovered.action,
    current.deliveryGeneration,
    timestamp,
  );
  return { notification, card };
}

function replaceManagerApprovalCard(
  ledger: PurchaseWorkflowLedger,
  card: PurchaseManagerApprovalCardEntry,
): void {
  const index = ledger.managerApprovalCards.findIndex(
    (entry) => entry.key === card.key,
  );
  if (index < 0) {
    throw new ConflictException('经理审批卡记录不存在');
  }
  ledger.managerApprovalCards[index] = card;
}

function pruneResolvedManagerApprovalCards(
  entries: PurchaseManagerApprovalCardEntry[],
  now: Date,
  notifications: PurchaseWorkflowNotificationEntry[] = [],
): PurchaseManagerApprovalCardEntry[] {
  const threshold = now.getTime() - MANAGER_CARD_RESOLVED_RETENTION_MS;
  return entries.filter((entry) => {
    if (entry.state !== 'resolved') return true;
    if (notifications.some(task => task.recordId === entry.executionRecordId && isManagerNotificationKind(task.kind) && task.status !== 'completed')) return true;
    const resolvedAt = Date.parse(entry.resolvedAt || entry.updatedAt);
    return !Number.isFinite(resolvedAt) || resolvedAt >= threshold;
  });
}

function registerManagerApprovalCard(
  ledger: PurchaseWorkflowLedger,
  notification: PurchaseWorkflowNotificationEntry,
  messageId: string,
  timestamp: string,
): PurchaseManagerApprovalCardEntry {
  if (
    notification.kind !== 'manager_approval_requested' ||
    notification.status !== 'completed' ||
    notification.sendOutcome !== 'delivered' ||
    !notification.cardContext
  ) {
    throw new ConflictException('经理审批卡来源通知未完成');
  }
  const context = parsePurchaseManagerApprovalCardContext(
    notification.cardContext,
  );
  if (context.executionRecordId !== notification.recordId) {
    throw new ConflictException('经理审批卡上下文记录不匹配');
  }
  const key = managerApprovalCardKey(
    notification.recordId,
    notification.recipientOpenId,
  );
  const existing = ledger.managerApprovalCards.find(
    (entry) => entry.key === key,
  );
  if (existing && !existing.personnelHandover) {
    if (
      existing.messageId === messageId &&
      existing.sourceNotificationKey === notification.key &&
      existing.cardContext === notification.cardContext
    ) {
      return existing;
    }
    throw new ConflictException('经理审批卡记录已存在');
  }
  if (
    ledger.managerApprovalCards.some(
      (entry) =>
        entry.messageId === messageId ||
        entry.supersededMessageIds.includes(messageId),
    )
  ) {
    throw new ConflictException('经理审批卡消息已绑定其他记录');
  }
  const card: PurchaseManagerApprovalCardEntry = {
    key,
    executionRecordId: notification.recordId,
    messageId,
    supersededMessageIds: [],
    recipientOpenId: notification.recipientOpenId,
    sourceNotificationKey: notification.key,
    sourceKind: 'manager_approval_requested',
    sourceStatus: 'completed',
    cardContext: notification.cardContext,
    state: 'initial',
    choice: '',
    rejectionReasonDraft: '',
    actionEventId: '',
    actorOpenId: '',
    processedAt: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: '',
  };
  const decided = ledger.managerApprovalCards.find(candidate => candidate.executionRecordId === notification.recordId && !candidate.personnelHandover &&
    !['initial', 'reject_editing'].includes(candidate.state));
  if (decided) {
    Object.assign(card, { state: decided.state, choice: decided.choice, rejectionReasonDraft: decided.rejectionReasonDraft,
      actionEventId: decided.actionEventId, actorOpenId: decided.actorOpenId, processedAt: decided.processedAt, resolvedAt: decided.resolvedAt });
    const action = ledger.managerApprovalActions.find(entry => entry.eventId === decided.actionEventId);
    if (action && (decided.state === 'resolved' || decided.state === 'manual_reconciliation')) {
      enqueueManagerApprovalStateNotification(ledger, action, card,
        decided.state === 'resolved' ? 'manager_approval_resolved' : 'manager_approval_attention_required', timestamp);
    }
  }
  if(existing){card.supersededMessageIds=[...new Set([...existing.supersededMessageIds,existing.messageId])];ledger.managerApprovalCards=ledger.managerApprovalCards.map(value=>value===existing?card:value);}
  else ledger.managerApprovalCards.push(card);
  return card;
}

function samePersistedEntry(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNotificationKind(
  value: unknown,
): value is PurchaseWorkflowNotificationKind {
  return (
    value === 'approval_requested' ||
    value === 'approval_resolved' ||
    value === 'purchase_assigned' ||
    value === 'purchase_rejected' ||
    value === 'warehouse_inbound' ||
    value === 'inventory_inbound_completed_resolution' ||
    value === 'inventory_inbound_completed' ||
    value === 'manual_inventory_inbound_completed_resolution' ||
    value === 'manual_inventory_inbound_completed' ||
    value === 'purchase_completed' ||
    value === 'purchase_order_completed' ||
    value === 'web_receipt_command' ||
    value === 'approval_transferred' ||
    isManagerNotificationKind(value)
  );
}

function isManagerNotificationKind(
  value: unknown,
): value is PurchaseManagerApprovalNotificationKind {
  return (
    value === 'manager_approval_requested' ||
    value === 'manager_approval_transferred' ||
    value === 'manager_approval_resolved' ||
    value === 'manager_approval_reopened' ||
    value === 'manager_approval_attention_required' ||
    value === 'manager_batch_approval_requested' ||
    value === 'manager_batch_approval_refresh' ||
    value === 'manager_batch_approval_result' ||
    value === 'manager_batch_approval_attention_required' ||
    value === 'manager_batch_purchase_assigned' ||
    value === 'manager_batch_purchase_refresh' ||
    value === 'manager_batch_executor_transferred' ||
    value === 'manager_batch_receipt_requested' ||
    value === 'manager_batch_receipt_refresh' ||
    value === 'manager_batch_receipt_completed' ||
    value === 'manager_batch_receipt_attachment' ||
    value === 'manager_batch_order_command' ||
    value === 'manager_batch_receipt_command'
  );
}

function isProvenLegacyCardSchemaRejection(
  notification: PurchaseWorkflowNotificationEntry,
  evidence: PurchaseManagerLegacyCardRecoveryEvidence,
): boolean {
  if (
    clean(evidence?.approvalPolicyVersion) !==
    PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION
  ) {
    return false;
  }
  const hasRejectedAudit = notification.deliveryAudit.some(
    (entry) =>
      entry.action === 'send_rejected' &&
      entry.generation === notification.deliveryGeneration,
  );
  const failureDetail = `${clean(notification.lastError)} ${clean(
    evidence?.externalError,
  )}`;
  return (
    hasRejectedAudit ||
    /(?:status\s+code\s+400|http\s*400|230099|200861|unsupported\s+tag\s+note|schema\s+v2\s+no\s+longer\s+support)/i.test(
      failureDetail,
    )
  );
}

function isProvenReceiptFormNameSchemaRejection(
  notification: PurchaseWorkflowNotificationEntry,
): boolean {
  const hasRejectedAudit = notification.deliveryAudit.some(
    (entry) =>
      entry.action === 'send_rejected' &&
      entry.generation === notification.deliveryGeneration,
  );
  const failureDetail = clean(notification.lastError);
  return (
    hasRejectedAudit &&
    /(?:errcode:\s*11310|错误码\s*230099)/iu.test(failureDetail) &&
    /(?:tag:\s*form|root[^\r\n]*form)/iu.test(failureDetail) &&
    /name[^\r\n]{0,80}(?:maximum|max)[^\r\n]{0,20}100/iu.test(failureDetail)
  );
}

function isPurchaseBatchFulfillmentCommandKind(
  value: PurchaseWorkflowNotificationKind,
): value is 'manager_batch_order_command' | 'manager_batch_receipt_command' {
  return (
    value === 'manager_batch_order_command' ||
    value === 'manager_batch_receipt_command'
  );
}

function normalizePurchaserSnapshot(
  value: PurchaseManagerApprovalBatchPurchaserSnapshot | undefined,
): PurchaseManagerApprovalBatchPurchaserSnapshot {
  const purchaserOpenId = boundedText(
    value?.purchaserOpenId,
    MAX_OPEN_ID_LENGTH,
  );
  if (!OPEN_ID_PATTERN.test(purchaserOpenId)) {
    throw new ConflictException('采购批次通过项缺少有效采购人');
  }
  return {
    purchaserOpenId,
    purchaserName: boundedText(value?.purchaserName, 200),
    ...(value?.authorityTarget===undefined?{}:{authorityTarget:normalizePurchaseAuthorityTarget(value.authorityTarget)}),
  };
}

function isManualInboundNotificationKind(
  value: PurchaseWorkflowNotificationKind,
): boolean {
  return (
    value === 'manual_inventory_inbound_completed_resolution' ||
    value === 'manual_inventory_inbound_completed'
  );
}

function isInboundCompletedResolutionKind(
  value: PurchaseWorkflowNotificationKind,
): boolean {
  return (
    value === 'inventory_inbound_completed_resolution' ||
    value === 'manual_inventory_inbound_completed_resolution'
  );
}

function isInboundCompletedDeliveryKind(
  value: PurchaseWorkflowNotificationKind,
): boolean {
  return (
    value === 'inventory_inbound_completed' ||
    value === 'manual_inventory_inbound_completed'
  );
}

type InboundDeliveryKind = 'inventory_inbound_completed' | 'manual_inventory_inbound_completed';
export interface InboundCompletionSnapshot {
  sealed: boolean;
  waiting: boolean;
  sealedAt: string;
  notifications: PurchaseWorkflowNotificationEntry[];
}

/** Existing resolution + atomically-created children are the persisted recipient snapshot.
 * No current personnel configuration is consulted when recovering an accepted event.
 */
export function inboundCompletionSnapshot(
  entries: readonly PurchaseWorkflowNotificationEntry[],
  recordId: string,
  kind: InboundDeliveryKind,
): InboundCompletionSnapshot {
  const resolutionKind = kind === 'inventory_inbound_completed'
    ? 'inventory_inbound_completed_resolution' : 'manual_inventory_inbound_completed_resolution';
  const children = entries.filter(entry => entry.recordId === recordId && entry.kind === kind);
  const resolutions = entries.filter(entry => entry.recordId === recordId && entry.kind === resolutionKind);
  const receipts = entries.filter(entry => entry.recordId === recordId && entry.status === 'completed' &&
    (entry.kind === kind || kind === 'inventory_inbound_completed' && entry.kind === 'purchase_completed'));
  const receiptTimes = receipts.map(entry => Date.parse(entry.firstSendAttemptAt || entry.completedAt || entry.createdAt)).filter(Number.isFinite);
  const firstReceiptAt = receiptTimes.length ? Math.min(...receiptTimes) : Infinity;
  const originalResolutions = resolutions.filter(entry => entry.status === 'completed' &&
    Number.isFinite(Date.parse(entry.completedAt)) && Number.isFinite(Date.parse(entry.createdAt)) && Date.parse(entry.createdAt) <= firstReceiptAt);
  const sealedTimes = originalResolutions.map(entry => Date.parse(entry.completedAt));
  // A late resolver retry must not move the boundary past an earlier successful send.
  const sealedAt = Math.min(firstReceiptAt, ...sealedTimes);
  const sealed = Number.isFinite(sealedAt);
  return {
    sealed,
    waiting: !sealed && resolutions.some(entry => isActiveStatus(entry.status)),
    sealedAt: sealed ? new Date(sealedAt).toISOString() : '',
    notifications: sealed ? children.filter(entry => Number.isFinite(Date.parse(entry.createdAt)) && Date.parse(entry.createdAt) <= sealedAt) : [],
  };
}

function inboundDeliveryGate(
  entry: PurchaseWorkflowNotificationEntry,
  entries: PurchaseWorkflowNotificationEntry[],
  snapshots?: Map<string, InboundCompletionSnapshot>,
): 'allowed' | 'waiting' | 'unproven' {
  if (!isInboundCompletedDeliveryKind(entry.kind)) return 'allowed';
  const key = `${entry.kind}:${entry.recordId}`;
  let snapshot = snapshots?.get(key);
  if (!snapshot) {
    snapshot = inboundCompletionSnapshot(entries, entry.recordId, entry.kind as InboundDeliveryKind);
    snapshots?.set(key, snapshot);
  }
  if (snapshot.waiting) return 'waiting';
  return snapshot.sealed && snapshot.notifications.some(row => row.key === entry.key) ? 'allowed' : 'unproven';
}

function quarantineUnprovenInbound(entry: PurchaseWorkflowNotificationEntry, timestamp: string): PurchaseWorkflowNotificationEntry {
  return { ...entry, status: 'manual_reconciliation', sendOutcome: 'manual_reconciliation', updatedAt: timestamp,
    completedAt: timestamp, claimToken: '', leaseUntil: '',
    lastError: '历史入库通知缺少原事件收件人证据或晚于已完成事件，已停止自动推送，请核对原通知；业务入库结果未变更' };
}

function isIdempotentInventoryNotificationKind(value: PurchaseWorkflowNotificationKind): boolean {
  return value === 'warehouse_inbound' || isInboundCompletedDeliveryKind(value);
}

function isManagerApprovalSendOutcome(
  value: unknown,
): value is PurchaseManagerApprovalSendOutcome {
  return (
    value === 'unattempted' ||
    value === 'unknown' ||
    value === 'delivered' ||
    value === 'manual_reconciliation'
  );
}

function isQueueStatus(value: unknown): value is PurchaseWorkflowQueueStatus {
  return (
    value === 'pending' ||
    value === 'processing' ||
    value === 'completed' ||
    value === 'failed'
  );
}

function isNotificationStatus(
  value: unknown,
): value is PurchaseWorkflowNotificationStatus {
  return isQueueStatus(value) || value === 'manual_reconciliation';
}

function isActiveStatus(status: PurchaseWorkflowNotificationStatus): boolean {
  return status === 'pending' || status === 'processing';
}

function trimCommandHistory(
  entries: PurchaseWorkflowCommandEntry[],
): PurchaseWorkflowCommandEntry[] {
  const active = new Set(entries.filter((entry) => !entry.completedAt || entry.orderNotice?.deferUntilFulfillment));
  const completedSlots = Math.max(0, MAX_COMMANDS - active.size);
  const completedToKeep = new Set(
    completedSlots > 0
      ? entries
          .filter((entry) => Boolean(entry.completedAt) && !active.has(entry))
          .slice(-completedSlots)
      : [],
  );
  return entries.filter(
    (entry) => active.has(entry) || completedToKeep.has(entry),
  );
}

function trimTerminalHistory<
  T extends { status: PurchaseWorkflowNotificationStatus },
>(entries: T[], maxTerminalHistory: number): T[] {
  const terminalToKeep = new Set(
    entries
      .filter((entry) => !isActiveStatus(entry.status))
      .slice(-maxTerminalHistory),
  );
  return entries.filter(
    (entry) => isActiveStatus(entry.status) || terminalToKeep.has(entry),
  );
}

function trimNotificationHistory(
  entries: PurchaseWorkflowNotificationEntry[],
  maxTerminalHistory: number,
): PurchaseWorkflowNotificationEntry[] {
  const actionableReceiptBatches = actionableReceiptBatchIds(entries);
  const retainedReceiptBatches = receiptRequestedBatchIds(entries);
  const protectedEntries = new Set(
    entries.filter(
      (entry) =>
        isActiveStatus(entry.status) ||
        entry.status === 'manual_reconciliation' ||
        // These existing-format entries are durable event/recipient tombstones,
        // not disposable UI history. Losing them permits historical re-delivery.
        isInboundCompletedResolutionKind(entry.kind) ||
        isInboundCompletedDeliveryKind(entry.kind) ||
        (entry.kind === 'purchase_completed' && entry.status === 'completed') ||
        entry.kind === 'manager_approval_attention_required' ||
        !!entry.approvalHandover ||
        Boolean(entry.webReceipt && !entry.webReceipt.filesRemoved) ||
        notificationSupportsActionableReceiptBatch(
          entry,
          actionableReceiptBatches,
        ) ||
        notificationIsCompletedReceiptTombstone(
          entry,
          retainedReceiptBatches,
        ) ||
        (entry.deliveryAudit.length > 0 &&
          !isInboundCompletedDeliveryKind(entry.kind)),
    ),
  );
  const terminalToKeep = new Set(
    entries
      .filter(
        (entry) =>
          !protectedEntries.has(entry) &&
          !isInboundCompletedResolutionKind(entry.kind) &&
          !(
            isInboundCompletedDeliveryKind(entry.kind) &&
            entry.status === 'manual_reconciliation'
          ),
      )
      .slice(-maxTerminalHistory),
  );
  return entries.filter(
    (entry) => protectedEntries.has(entry) || terminalToKeep.has(entry),
  );
}

function trimManagerApprovalActionHistory(
  entries: PurchaseManagerApprovalActionEntry[],
  notifications: PurchaseWorkflowNotificationEntry[] = [],
): PurchaseManagerApprovalActionEntry[] {
  const recoveryActionEventIds = new Set(
    notifications
      .filter(
        (entry) =>
          entry.kind === 'manager_approval_reopened' &&
          (isActiveStatus(entry.status) ||
            entry.status === 'manual_reconciliation'),
      )
      .map((entry) =>
        entry.businessEventId.startsWith('manager_approval_reopened:')
          ? entry.businessEventId.slice('manager_approval_reopened:'.length)
          : '',
      )
      .filter(Boolean),
  );
  const protectedEntries = new Set(
    entries.filter(
      (entry) =>
        isActiveStatus(entry.status) ||
        entry.status === 'manual_reconciliation' ||
        (entry.status === 'failed' &&
          recoveryActionEventIds.has(entry.eventId)),
    ),
  );
  const terminalToKeep = new Set(
    entries
      .filter((entry) => !protectedEntries.has(entry))
      .slice(-MAX_MANAGER_APPROVAL_ACTIONS),
  );
  return entries.filter(
    (entry) => protectedEntries.has(entry) || terminalToKeep.has(entry),
  );
}

function trimManagerApprovalBatchHistory(
  entries: PurchaseManagerApprovalBatchEntry[],
  notifications: PurchaseWorkflowNotificationEntry[] = [],
): PurchaseManagerApprovalBatchEntry[] {
  const actionableReceiptBatches = actionableReceiptBatchIds(notifications);
  const pendingBatchIds = new Set<string>();
  const pendingSourceKeys = new Set<string>();
  for (const task of notifications) {
    if (task.status === 'completed' || !task.kind.startsWith('manager_batch_')) continue;
    pendingSourceKeys.add(task.key);
    if (task.cardContext) {
      try {
        const snapshot = JSON.parse(task.cardContext) as { approvalBatchId?: unknown };
        if (typeof snapshot.approvalBatchId === 'string') pendingBatchIds.add(snapshot.approvalBatchId);
      } catch { /* Invalid context is handled by the notification worker. */ }
    }
  }
  const protectedEntries = new Set(
    entries.filter(
      (entry) =>
        entry.flowVersion === 'lifecycle_v1' ||
        !!entry.stageCardTransition ||
        isActiveManagerApprovalBatch(entry) ||
        pendingBatchIds.has(entry.approvalBatchId) ||
        managerBatchDeliveries(entry).some(delivery => pendingSourceKeys.has(delivery.sourceNotificationKey)) ||
        actionableReceiptBatches.has(entry.approvalBatchId),
    ),
  );
  const terminalToKeep = new Set(
    entries
      .filter((entry) => !protectedEntries.has(entry))
      .slice(-MAX_MANAGER_APPROVAL_BATCHES),
  );
  return entries.filter(
    (entry) => protectedEntries.has(entry) || terminalToKeep.has(entry),
  );
}

function actionableReceiptBatchIds(
  entries: PurchaseWorkflowNotificationEntry[],
): Set<string> {
  const completedReceipts = new Set<string>();
  for (const entry of entries) {
    if (
      entry.kind !== 'manager_batch_receipt_command' ||
      entry.status !== 'completed'
    ) {
      continue;
    }
    try {
      const context = parsePurchaseBatchFulfillmentCommandContext(
        entry.cardContext,
      );
      if (context.action === 'receipt') {
        completedReceipts.add(
          `${context.approvalBatchId}\u0000${context.executionRecordId}`,
        );
      }
    } catch {
      continue;
    }
  }

  const result = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'manager_batch_receipt_requested') continue;
    try {
      const context = parsePurchaseManagerBatchApprovalCardContext(
        entry.cardContext,
      );
      const pendingApprovedItem = context.items.some(
        (item) =>
          item.status === 'approved' &&
          !completedReceipts.has(
            `${context.approvalBatchId}\u0000${item.executionRecordId}`,
          ),
      );
      if (pendingApprovedItem) result.add(context.approvalBatchId);
    } catch {
      continue;
    }
  }
  return result;
}

function receiptRequestedBatchIds(
  entries: PurchaseWorkflowNotificationEntry[],
): Set<string> {
  const result = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'manager_batch_receipt_requested') continue;
    try {
      result.add(
        parsePurchaseManagerBatchApprovalCardContext(entry.cardContext)
          .approvalBatchId,
      );
    } catch {
      continue;
    }
  }
  return result;
}

function notificationIsCompletedReceiptTombstone(
  entry: PurchaseWorkflowNotificationEntry,
  retainedBatchIds: Set<string>,
): boolean {
  if (
    entry.kind !== 'manager_batch_receipt_command' ||
    entry.status !== 'completed'
  ) {
    return false;
  }
  try {
    const context = parsePurchaseBatchFulfillmentCommandContext(
      entry.cardContext,
    );
    return (
      context.action === 'receipt' &&
      retainedBatchIds.has(context.approvalBatchId)
    );
  } catch {
    return false;
  }
}

function notificationSupportsActionableReceiptBatch(
  entry: PurchaseWorkflowNotificationEntry,
  actionableBatchIds: Set<string>,
): boolean {
  if (!actionableBatchIds.size) return false;
  try {
    if (
      entry.kind === 'manager_batch_receipt_requested' ||
      entry.kind === 'manager_batch_receipt_refresh'
    ) {
      return actionableBatchIds.has(
        parsePurchaseManagerBatchApprovalCardContext(entry.cardContext)
          .approvalBatchId,
      );
    }
    if (
      entry.kind === 'manager_batch_order_command' ||
      entry.kind === 'manager_batch_receipt_command'
    ) {
      return actionableBatchIds.has(
        parsePurchaseBatchFulfillmentCommandContext(entry.cardContext)
          .approvalBatchId,
      );
    }
  } catch {
    return false;
  }
  return false;
}

function trimManagerApprovalBatchActionHistory(
  entries: PurchaseManagerApprovalBatchActionEntry[],
): PurchaseManagerApprovalBatchActionEntry[] {
  return trimTerminalHistory(entries, MAX_MANAGER_APPROVAL_BATCH_ACTIONS);
}

function safeAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : 0;
}

function stableManagerDeliveryUuid(key: string, generation: number): string {
  const digest = createHash('sha256')
    .update(`purchase-manager-approval:${key}:${generation}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `pmgr-${generation}-${digest}`.slice(0, 50);
}

function stableInboundCompletedDeliveryUuid(key: string): string {
  const digest = createHash('sha256')
    .update(`inventory-inbound-completed:${key}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  digest[12] = '4';
  digest[16] = ['8', '9', 'a', 'b'][Number.parseInt(digest[16] || '0', 16) % 4];
  const value = digest.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function canonicalManagerCardContext(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Invalid manager approval card context');
  }
  try {
    return serializePurchaseManagerApprovalCardContext(
      parsePurchaseManagerApprovalCardContext(value),
    );
  } catch {
    return canonicalManagerBatchCardContext(value);
  }
}

function canonicalManagerBatchCardContext(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Invalid manager batch approval card context');
  }
  return serializePurchaseManagerBatchApprovalCardContext(
    parsePurchaseManagerBatchApprovalCardContext(value),
  );
}

function sanitizeManagerCardContext(value: unknown): string {
  try {
    return canonicalManagerCardContext(value);
  } catch {
    return '';
  }
}

function sanitizeManagerBatchCardContext(value: unknown): string {
  try {
    return canonicalManagerBatchCardContext(value);
  } catch {
    return '';
  }
}

function sanitizePurchaseBatchFulfillmentCommandContext(
  value: unknown,
): string {
  try {
    if (typeof value !== 'string') return '';
    return serializePurchaseBatchFulfillmentCommandContext(
      parsePurchaseBatchFulfillmentCommandContext(value),
    );
  } catch {
    return '';
  }
}

function normalizeOptionalCardContext(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('Invalid notification card context');
  }
  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (
    !normalized ||
    Array.from(normalized).length > MAX_CARD_CONTEXT_LENGTH ||
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    throw new Error('Invalid notification card context');
  }
  return normalized;
}

function sanitizeOptionalCardContext(value: unknown): string {
  try {
    return normalizeOptionalCardContext(value) || '';
  } catch {
    return '';
  }
}

function appendDeliveryAudit(
  entries: PurchaseManagerApprovalDeliveryAuditEntry[],
  entry: PurchaseManagerApprovalDeliveryAuditEntry,
): PurchaseManagerApprovalDeliveryAuditEntry[] {
  return [...entries, entry].slice(-MAX_DELIVERY_AUDIT_ENTRIES);
}

function sanitizeDeliveryAudit(
  value: unknown,
  legacySource?: { openId: string; messageId: string },
): PurchaseManagerApprovalDeliveryAuditEntry | null {
  if (!isRecord(value) || !isManagerDeliveryAuditAction(value.action)) {
    return null;
  }
  const at = isoText(value.at);
  const deliveryUuid = boundedText(value.deliveryUuid, 50);
  const boundLegacyMessage = value.action === 'callback_bound' && legacySource && legacySource.openId === value.operatorOpenId &&
    legacySource.messageId === value.messageId && FEISHU_MESSAGE_ID_PATTERN.test(legacySource.messageId) && /^ou_[A-Za-z0-9_-]+$/.test(legacySource.openId);
  if (!at || !deliveryUuid && !boundLegacyMessage) return null;
  return {
    action: value.action,
    at,
    operatorOpenId: boundedText(value.operatorOpenId, MAX_OPEN_ID_LENGTH),
    generation: Math.max(1, safeAttempts(value.generation)),
    deliveryUuid,
    messageId: boundedText(value.messageId, MAX_DELIVERY_ID_LENGTH),
  };
}

function isManagerDeliveryAuditAction(
  value: unknown,
): value is PurchaseManagerApprovalDeliveryAuditEntry['action'] {
  return (
    value === 'send_started' ||
    value === 'send_delivered' ||
    value === 'send_rejected' ||
    value === 'card_schema_v2_compatible' ||
    value === 'legacy_card_schema_requeued' ||
    value === 'receipt_delivery_requeued' ||
    value === 'receipt_card_schema_requeued' ||
    value === 'card_update_completed' ||
    value === 'delivery_unknown_timeout' ||
    value === 'operator_verified_delivered' ||
    value === 'operator_verified_absent' ||
    value === 'comparison_image_requeued' ||
    value === 'lifecycle_replica_bound' ||
    value === 'callback_bound' ||
    value === 'replacement_bound'
  );
}

function isManagerApprovalChoice(
  value: unknown,
): value is PurchaseManagerApprovalChoice {
  return (
    value === 'comprehensive' || value === 'building_self' || value === 'reject'
  );
}

function isManagerApprovalActionStatus(
  value: unknown,
): value is PurchaseManagerApprovalActionStatus {
  return isQueueStatus(value) || value === 'manual_reconciliation';
}

function isManagerApprovalCardState(
  value: unknown,
): value is PurchaseManagerApprovalCardState {
  return (
    value === 'initial' ||
    value === 'reject_editing' ||
    value === 'pending' ||
    value === 'resolved' ||
    value === 'manual_reconciliation'
  );
}

function isManagerBatchItemStatus(
  value: unknown,
): value is PurchaseManagerBatchItemStatus {
  return (
    value === 'pending' ||
    value === 'processing' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'manual_reconciliation'
  );
}

function isManagerBatchChoice(
  value: unknown,
): value is PurchaseManagerBatchApprovalChoice {
  return value === '' || isManagerBatchTerminalChoice(value);
}

function isManagerBatchTerminalChoice(
  value: unknown,
): value is Exclude<PurchaseManagerBatchApprovalChoice, ''> {
  return (
    value === 'comprehensive' || value === 'building_self' || value === 'reject'
  );
}

function isValidManagerBatchItemDecision(
  status: PurchaseManagerBatchItemStatus,
  choice: PurchaseManagerBatchApprovalChoice,
  rejectionReason: string,
  decisionSource?: unknown,
): boolean {
  if (decisionSource !== undefined && (decisionSource !== 'platform' || !['processing','rejected'].includes(status) || choice !== 'reject' || !!rejectionReason)) return false;
  if (status === 'pending') return choice === '' && !rejectionReason;
  if (status === 'approved') {
    return (
      (choice === 'comprehensive' || choice === 'building_self') &&
      !rejectionReason
    );
  }
  if (status === 'rejected') {
    return choice === 'reject' && (Boolean(rejectionReason) || decisionSource === 'platform');
  }
  if (status === 'processing') {
    return (
      choice === 'comprehensive' ||
      choice === 'building_self' ||
      (choice === 'reject' && (Boolean(rejectionReason) || decisionSource === 'platform'))
    );
  }
  return isManagerBatchTerminalChoice(choice);
}

function isManagerApprovalBatchState(
  value: unknown,
): value is PurchaseManagerApprovalBatchState {
  return (
    value === 'awaiting_delivery' ||
    value === 'active' ||
    value === 'reject_editing' ||
    value === 'processing' ||
    value === 'resolved' ||
    value === 'manual_reconciliation'
  );
}

function isManagerApprovalBatchActionStatus(
  value: unknown,
): value is PurchaseManagerApprovalBatchActionStatus {
  return isQueueStatus(value) || value === 'manual_reconciliation';
}

function managerApprovalActionKey(eventId: string): string {
  return `manager-approval-action:${eventId}`;
}

function managerApprovalCardKey(
  recordId: string,
  recipientOpenId: string,
): string {
  return `manager-card:${recordId}:${recipientOpenId}`;
}

function requiredDeliveryId(value: unknown): string {
  const normalized = boundedText(value, MAX_DELIVERY_ID_LENGTH);
  if (!normalized) {
    throw new Error('Invalid manager approval message id');
  }
  return normalized;
}

function normalizeManagerRejectionReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (
    !normalized ||
    Array.from(normalized).length > 500 ||
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    return '';
  }
  return normalized;
}

function isUnknownManagerDeliveryExpired(
  entry: PurchaseWorkflowNotificationEntry,
  now: Date,
): boolean {
  if (
    entry.sendOutcome !== 'unknown' ||
    (entry.kind !== 'manager_approval_requested' &&
      entry.kind !== 'manager_approval_reopened' &&
      entry.kind !== 'manager_batch_approval_requested' &&
      entry.kind !== 'manager_batch_approval_result' &&
      entry.kind !== 'manager_batch_purchase_assigned' &&
      entry.kind !== 'manager_batch_receipt_requested' &&
      entry.kind !== 'manager_batch_receipt_completed') ||
    !entry.firstSendAttemptAt
  ) {
    return false;
  }
  const startedAt = Date.parse(entry.firstSendAttemptAt);
  return (
    Number.isFinite(startedAt) &&
    now.getTime() - startedAt >= MANAGER_DELIVERY_UNKNOWN_WINDOW_MS
  );
}

function sanitizeAttachmentTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((token) => /^[A-Za-z0-9_-]{1,256}$/u.test(token)),
    ),
  ].slice(0, 5);
}

function mergeAttachmentTokens(
  existing: string[],
  added: string[] | undefined,
): string[] {
  const raw = [...(existing || []), ...(added || [])].map((token) =>
    typeof token === 'string' ? token.trim() : '',
  );
  if (raw.some((token) => !/^[A-Za-z0-9_-]{1,256}$/u.test(token))) {
    throw new BadRequestException('采购附件令牌无效');
  }
  const tokens = [...new Set(raw)];
  if (tokens.length > 5) {
    throw new BadRequestException('每类采购附件最多 5 个');
  }
  return tokens;
}

function isUnknownInboundCompletedDeliveryExpired(
  entry: PurchaseWorkflowNotificationEntry,
  now: Date,
): boolean {
  if (
    (!isIdempotentInventoryNotificationKind(entry.kind) && entry.kind !== 'purchase_order_completed') ||
    entry.sendOutcome !== 'unknown' ||
    !entry.firstSendAttemptAt
  ) {
    return false;
  }
  const startedAt = Date.parse(entry.firstSendAttemptAt);
  return (
    Number.isFinite(startedAt) &&
    now.getTime() - startedAt >= MANAGER_DELIVERY_UNKNOWN_WINDOW_MS
  );
}

function validClaimToken(value: unknown): string {
  const token = clean(value);
  return UUID_PATTERN.test(token) ? token : '';
}

function enqueueWebReceiptCardRefresh(ledger: PurchaseWorkflowLedger, task: PurchaseWorkflowNotificationEntry): void {
  for (const batch of ledger.managerApprovalBatches) {
    if (!batch.cardContext || !batch.items.some(item => item.executionRecordId === task.recordId && item.status === 'approved')) continue;
    const input: PurchaseWorkflowNotificationInput = { kind: 'manager_batch_receipt_refresh', businessEventId: `${task.webReceipt!.taskId}:${task.status}:a${task.attempts}:${batch.approvalBatchId}`, recordId: task.recordId, recipientOpenId: batch.requesterOpenId, cardContext: batch.cardContext };
    if (ledger.notifications.some(entry => entry.key === notificationKey(input))) continue;
    if (ledger.notifications.filter(entry => isActiveStatus(entry.status)).length >= MAX_NOTIFICATIONS) throw new ServiceUnavailableException('采购卡片同步队列已满，请先恢复积压任务');
    ledger.notifications.push(createNotificationEntry(input, new Date().toISOString()));
  }
}

function requireAcceptedFulfillment(ledger:PurchaseWorkflowLedger,proof:PurchaseFulfillmentClaimProof,expected:{recordId:string;action:PurchaseWorkflowAction;actorOpenId:string}):PurchaseAcceptedFulfillment{
  const notification=ledger.notifications.find(entry=>entry.key===proof.notificationKey);
  if (notification?.kind === 'web_receipt_command') {
    const payload = normalizeWebReceiptCommand(notification.webReceipt);
    assertClaimOwnership(notification, proof.claimToken);
    if (payload.appId !== process.env.FEISHU_APP_ID?.trim() || expected.action !== 'receive' || notification.recordId !== expected.recordId || notification.recipientOpenId !== expected.actorOpenId || payload.actor.openId !== expected.actorOpenId || payload.files.some(file => !file.token)) throw new ConflictException('原网页签收受理证明不一致');
    return { proof: { ...proof, appId: payload.appId, cardContext: JSON.stringify(payload) }, actor: structuredClone(payload.actor), ...payload.scope,
      ...(payload.platformIdentity ? { platformIdentity: structuredClone(payload.platformIdentity) } : {}) };
  }
  if(!notification||!isPurchaseBatchFulfillmentCommandKind(notification.kind)||!notification.acceptedAppId||notification.acceptedAppId!==process.env.FEISHU_APP_ID?.trim())throw new ConflictException('原采购受理命令或应用身份未核对');
  assertClaimOwnership(notification,proof.claimToken);
  const context=parsePurchaseBatchFulfillmentCommandContext(notification.cardContext);
  if(notification.recordId!==expected.recordId||context.executionRecordId!==expected.recordId||context.actorOpenId!==expected.actorOpenId||notification.recipientOpenId!==expected.actorOpenId||
    (context.action==='order'?'order':'receive')!==expected.action||notification.kind!==(context.action==='order'?'manager_batch_order_command':'manager_batch_receipt_command'))throw new ConflictException('原采购受理命令身份不一致');
  const batch=ledger.managerApprovalBatches.find(entry=>entry.approvalBatchId===context.approvalBatchId),item=batch?.items.find(entry=>entry.executionRecordId===context.executionRecordId);
  if(!batch||!item)throw new ConflictException('原采购受理批次不存在');
  const snapshot=parsePurchaseManagerBatchApprovalCardContext(batch.cardContext);
  const target=item.authorityTarget||{building:snapshot.building};
  let lifecycleAuthority: PurchaseAcceptedFulfillment['proof']['lifecycleAuthority'];
  if(batch.flowVersion==='lifecycle_v1'||batch.stageCardTransition){
    if(lifecycleReceiptOwner(batch)!==notification.acceptedAppId||!item.authorityTarget||item.status!=='approved'||(item.choice!=='comprehensive'&&item.choice!=='building_self')||
      (context.action==='order'?item.purchaserOpenId:batch.requesterOpenId)!==expected.actorOpenId||
      ledger.managerApprovalBatches.filter(candidate=>candidate.recordIds.includes(expected.recordId)).length!==1)throw new ConflictException('采购全流程受理职责不可核对');
    lifecycleAuthority={batchId:batch.approvalBatchId,recordId:item.executionRecordId,actorOpenId:expected.actorOpenId,choice:item.choice,...item.authorityTarget,
      ...(batch.stageCardTransition ? { stageCards: true } : {})};
  }
  return{proof:{notificationKey:notification.key,claimToken:proof.claimToken,appId:notification.acceptedAppId,cardContext:notification.cardContext,...(lifecycleAuthority?{lifecycleAuthority}:{})},...target,
    actor:{openId:expected.actorOpenId,name:context.action==='order'?item.purchaserName:snapshot.requesterName,positions:[],buildings:[target.building],accessRole:'admin'}};
}

function assertClaimOwnership(
  entry: {
    status: PurchaseWorkflowNotificationStatus;
    claimToken: string;
  },
  claimToken: string,
): void {
  const normalizedToken = validClaimToken(claimToken);
  if (
    entry.status !== 'processing' ||
    !normalizedToken ||
    entry.claimToken !== normalizedToken
  ) {
    throw new ConflictException('采购工作流任务领取凭证已失效');
  }
}

function isoText(value: unknown): string {
  const text = clean(value);
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function resolveNow(value: Date | number): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid workflow time');
  return date;
}

function isAvailable(
  entry:
    | PurchaseWorkflowCardActionEntry
    | PurchaseWorkflowNotificationEntry
    | PurchaseManagerApprovalActionEntry
    | PurchaseManagerApprovalBatchActionEntry,
  now: Date,
): boolean {
  if (entry.status === 'pending') {
    return (
      !entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now.getTime()
    );
  }
  if (entry.status === 'processing') {
    return !entry.leaseUntil || Date.parse(entry.leaseUntil) <= now.getTime();
  }
  return false;
}

function normalizeLeaseMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid workflow lease');
  }
  return Math.min(Math.floor(value), MAX_LEASE_MS);
}

function sanitizeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value || '');
  if (!message.trim()) return '';
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(
      QUOTED_SECRET_PATTERN,
      (_match, prefix: string, quote: string) =>
        `${prefix}${quote}[redacted]${quote}`,
    )
    .replace(PLAIN_SECRET_PATTERN, '$1[redacted]')
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

function boundedText(value: unknown, maxLength: number): string {
  const text = clean(value);
  return text.length <= maxLength && !/[\u0000-\u001f\u007f-\u009f]/.test(text)
    ? text
    : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function enqueuePurchaseOrderNotices(ledger: PurchaseWorkflowLedger, entry: PurchaseWorkflowCommandEntry): void {
  if (!entry.orderNotice) return;
  const businessEventId = `purchase-order:${createHash('sha256').update(entry.key).digest('hex')}`;
  for (const recipientOpenId of entry.orderNotice.recipientOpenIds) {
    const input = normalizeNotificationInput({ businessEventId, recordId: entry.recordId,
      recipientOpenId, kind: 'purchase_order_completed', cardContext: JSON.stringify({ version: 1, text: entry.orderNotice.text }) });
    if (ledger.notifications.some(task => task.key === notificationKey(input))) continue;
    if (ledger.notifications.filter(task => isActiveStatus(task.status)).length >= MAX_NOTIFICATIONS) {
      throw new ServiceUnavailableException('采购通知队列已满，请稍后恢复原下单结果');
    }
    ledger.notifications.push(createNotificationEntry(input, entry.completedAt));
  }
}

function sanitizeCommand(
  value: PurchaseWorkflowCommandRecordInput,
): PurchaseWorkflowCommandEntry {
  const orderNotice = value?.orderNotice;
  if (orderNotice && (value.action !== 'order' || !Array.isArray(orderNotice.recipientOpenIds) ||
    orderNotice.recipientOpenIds.length > 100 || !orderNotice.recipientOpenIds.every(id => OPEN_ID_PATTERN.test(id)) ||
    !clean(orderNotice.text) || orderNotice.text.length > 10000 ||
    (orderNotice.deferUntilFulfillment !== undefined && typeof orderNotice.deferUntilFulfillment !== 'boolean'))) {
    throw new BadRequestException('采购下单通知快照无效');
  }
  const platformIdentity = value?.platformIdentity === undefined ? undefined : sanitizePlatformCommandIdentity(value.platformIdentity);
  if (platformIdentity ? ((value.platformDispatch !== 'prepared' && value.platformDispatch !== 'dispatch_started') || typeof value.platformAttemptId !== 'string' || !UUID_PATTERN.test(value.platformAttemptId)) : (value.platformDispatch !== undefined || value.platformAttemptId !== undefined)) throw new ConflictException('采购平台命令发送状态损坏');
  return {
    key: clean(value?.key),
    recordId: clean(value?.recordId),
    action: value?.action,
    fingerprint: boundedText(value?.fingerprint, 128),
    expectedResultFingerprint: boundedText(
      value?.expectedResultFingerprint,
      128,
    ),
    actorOpenId: clean(value?.actorOpenId),
    ...(platformIdentity ? { platformIdentity } : {}),
    ...(platformIdentity ? { platformDispatch: value.platformDispatch!, platformAttemptId: value.platformAttemptId! } : {}),
    accessRole: isAccessRole(value?.accessRole) ? value.accessRole : 'unknown',
    authenticationMode: isAuthenticationMode(value?.authenticationMode)
      ? value.authenticationMode
      : 'unknown',
    startedAt: clean(value?.startedAt) || clean(value?.completedAt),
    completedAt: clean(value?.completedAt),
    ...(orderNotice ? { orderNotice: { recipientOpenIds: [...new Set(orderNotice.recipientOpenIds)], text: orderNotice.text,
      ...(orderNotice.deferUntilFulfillment === undefined ? {} : { deferUntilFulfillment: orderNotice.deferUntilFulfillment }) } } : {}),
    notificationWarnings: Array.isArray(value?.notificationWarnings)
      ? value.notificationWarnings
          .map(sanitizeError)
          .filter(Boolean)
          .slice(-MAX_COMMAND_WARNINGS)
      : [],
  };
}

function sanitizePlatformCommandIdentity(value: unknown): PurchasePlatformIdentityProof {
  if (!isRecord(value)) throw new ConflictException('采购命令平台身份账本损坏');
  const allowed = new Set(['source','actorAccountId','actorDisplayName','actorAuthorizationVersion','subjectAccountId','subjectDisplayName','subjectAuthorizationVersion','sessionFamilyFingerprint','expiresAt','actorFeishuOpenId']);
  if (Object.keys(value).some(key => !allowed.has(key)) || (value.source !== 'platform' && value.source !== 'impersonation') ||
      typeof value.actorAccountId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.actorAccountId) || typeof value.subjectAccountId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.subjectAccountId) ||
      typeof value.actorDisplayName !== 'string' || !value.actorDisplayName || value.actorDisplayName.length > 128 || normalizeAccessDisplayName(value.actorDisplayName) !== value.actorDisplayName || typeof value.subjectDisplayName !== 'string' || !value.subjectDisplayName || value.subjectDisplayName.length > 128 || normalizeAccessDisplayName(value.subjectDisplayName) !== value.subjectDisplayName ||
      !Number.isSafeInteger(value.actorAuthorizationVersion) || Number(value.actorAuthorizationVersion) < 1 || !Number.isSafeInteger(value.subjectAuthorizationVersion) || Number(value.subjectAuthorizationVersion) < 1 ||
      typeof value.sessionFamilyFingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.sessionFamilyFingerprint) || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0 ||
      (value.actorFeishuOpenId !== undefined && (typeof value.actorFeishuOpenId !== 'string' || !OPEN_ID_PATTERN.test(value.actorFeishuOpenId))) ||
      (value.source === 'platform' && (value.actorAccountId !== value.subjectAccountId || value.actorAuthorizationVersion !== value.subjectAuthorizationVersion || value.actorDisplayName !== value.subjectDisplayName)) ||
      (value.source === 'impersonation' && value.actorAccountId === value.subjectAccountId)) throw new ConflictException('采购命令平台身份账本损坏');
  return { source: value.source, actorAccountId: value.actorAccountId, actorDisplayName: value.actorDisplayName, actorAuthorizationVersion: Number(value.actorAuthorizationVersion), subjectAccountId: value.subjectAccountId, subjectDisplayName: value.subjectDisplayName,
    subjectAuthorizationVersion: Number(value.subjectAuthorizationVersion), sessionFamilyFingerprint: value.sessionFamilyFingerprint, expiresAt: Number(value.expiresAt),
    ...(value.actorFeishuOpenId === undefined ? {} : { actorFeishuOpenId: value.actorFeishuOpenId as string }) };
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isAccessRole(value: unknown): value is AccessRole {
  return (
    value === 'guest' ||
    value === 'editor' ||
    value === 'admin' ||
    value === 'purchase_admin' ||
    value === 'supply_chain_admin' ||
    value === 'purchase_applicant'
  );
}

function isAuthenticationMode(
  value: unknown,
): value is 'feishu-oauth' | 'delegated-app' {
  return value === 'feishu-oauth' || value === 'delegated-app';
}
