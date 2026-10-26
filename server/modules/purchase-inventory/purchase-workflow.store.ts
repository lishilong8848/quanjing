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
import { createHash, randomUUID } from 'node:crypto';
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
import type { PurchaseWorkflowAction, PurchaseWorkflowUser, PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
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
import { normalizePurchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';
import { normalizePurchaseExecutorHandover, purchaseExecutorVersion, purchaseExecutorReceiptVersion, type PurchaseExecutorHandover, type PurchaseExecutorHandoverInput } from './purchase-executor-handover';
import { legacyApprovalVersion, legacyApprovalReceiptVersion, legacyApprovalAcceptedVersion, type PurchaseLegacyApprovalHandoverInput } from './purchase-legacy-approval-handover';
import { normalizeWebReceiptCommand, webReceiptRecoveryVersion, type PurchaseWebReceiptCommand } from './purchase-web-receipt-command';
import type { PersonnelRecoveryActor, PersonnelRecoveryRequest } from '../../../shared/personnel-task-recovery.interface';
import { assertRecoveryRequest } from '../../common/access/personnel-task-recovery.validation';

export const PURCHASE_WORKFLOW_LEDGER_PATH = Symbol(
  'PURCHASE_WORKFLOW_LEDGER_PATH',
);
const MAX_COMMANDS = 500;
const MAX_REMINDERS = 500;
const MAX_CARD_ACTIONS = 500;
const MAX_NOTIFICATIONS = 500;
const MAX_INBOUND_COMPLETED_MANUAL_RECONCILIATIONS = 500;
const MAX_INBOUND_RESOLUTION_MARKERS = 5_000;
const MAX_MANAGER_APPROVAL_ACTIONS = 500;
const MAX_MANAGER_APPROVAL_BATCHES = 500;
const MAX_MANAGER_APPROVAL_BATCH_ACTIONS = 500;
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
const LEGACY_REUSED_INBOUND_CARD_REQUEUE_WINDOW_MS = 24 * 60 * 60 * 1000;
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
  operation: Promise<unknown>;
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
}

export interface PurchaseManagerApprovalBatchEntry {
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

export interface PurchaseWorkflowNotificationInput {
  businessEventId: string;
  recordId: string;
  recipientOpenId: string;
  kind: PurchaseWorkflowNotificationKind;
  cardContext?: string;
}

export interface PurchaseWorkflowNotificationEntry {
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
  proof: PurchaseFulfillmentClaimProof & { appId: string; cardContext: string };
  actor: PurchaseWorkflowUser;
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

interface PurchaseWorkflowLedger {
  version: 2;
  commands: PurchaseWorkflowCommandEntry[];
  reminders: string[];
  cardActions: PurchaseWorkflowCardActionEntry[];
  notifications: PurchaseWorkflowNotificationEntry[];
  managerApprovalActions: PurchaseManagerApprovalActionEntry[];
  managerApprovalCards: PurchaseManagerApprovalCardEntry[];
  managerApprovalBatches: PurchaseManagerApprovalBatchEntry[];
  managerApprovalBatchActions: PurchaseManagerApprovalBatchActionEntry[];
  personnelHandovers: PurchaseManagerBatchHandover[];
  warehouseInboundHandovers: WarehouseInboundHandover[];
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

    await this.sharedState.operation;
    if (this.sharedState.refCount > 0) return;
    await releaseLedgerLock(this.sharedState);
    if (sharedLedgerStates.get(this.ledgerPath) === this.sharedState) {
      sharedLedgerStates.delete(this.ledgerPath);
    }
  }

  async findCommand(key: string): Promise<PurchaseWorkflowCommandEntry | null> {
    return this.enqueue(async () => {
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
      if (input.action === 'receive' && ledger.notifications.some(task => task.kind === 'web_receipt_command' && task.recordId === input.recordId && task.key !== accepted?.notificationKey)) throw new ConflictException('该采购记录已有正式签收任务，请查看原任务');
      if(accepted){const original=requireAcceptedFulfillment(ledger,accepted,input);if(original.proof.cardContext!==accepted.cardContext||original.proof.appId!==accepted.appId)throw new ConflictException('原采购受理证明不一致');}
      else authorize?.();
      ledger.commands = trimCommandHistory([...ledger.commands, entry]);
      await this.write(ledger);
      return { claimed: true, entry };
    });
  }

  async releaseCommandClaim(
    key: string,
    fingerprint: string,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const index = ledger.commands.findIndex((entry) => entry.key === key);
      const existing = index >= 0 ? ledger.commands[index] : null;
      if (
        !existing ||
        existing.completedAt ||
        existing.fingerprint !== clean(fingerprint)
      ) {
        return false;
      }
      ledger.commands.splice(index, 1);
      await this.write(ledger);
      return true;
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
      const entry = sanitizeCommand({
        ...input,
        fingerprint: input.fingerprint || existing?.fingerprint || '',
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
      if (entry.action === 'order' && entry.completedAt && entry.orderNotice && !entry.orderNotice.deferUntilFulfillment) {
        enqueuePurchaseOrderNotices(ledger, entry);
        ledger.notifications = trimNotificationHistory(ledger.notifications, MAX_NOTIFICATIONS);
      }
      await this.write(ledger);
    });
  }

  async hasReminder(key: string): Promise<boolean> {
    return this.enqueue(async () =>
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
    return this.enqueue(async () =>
      (await this.read()).commands
        .slice(-Math.max(1, Math.min(limit, 100)))
        .reverse(),
    );
  }

  async listPendingOrderNoticeCommands(limit = 20, afterKey = ''): Promise<PurchaseWorkflowCommandEntry[]> {
    return this.enqueue(async () => {
      const pending = (await this.read()).commands
        .filter(entry => entry.action === 'order' && !entry.completedAt && entry.orderNotice && !entry.orderNotice.deferUntilFulfillment)
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
      if (!entry || entry.action !== 'order' || entry.completedAt || !entry.orderNotice || entry.orderNotice.deferUntilFulfillment ||
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
    return this.enqueue(async () => {
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
    return this.enqueue(
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
    return this.enqueue(async () =>
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

  async listPersonnelHandovers(): Promise<PurchaseManagerBatchHandover[]> {
    return this.enqueue(async () => (await this.read()).personnelHandovers.map(entry => structuredClone(entry)));
  }

  async executorHandoverSnapshot() {
    return this.enqueue(async () => {
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
    return this.enqueue(async () => (await this.read()).warehouseInboundHandovers.find(job => job.mutationId === mutationId));
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
  ): Promise<{
    created: boolean;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchRegistration(inputValue);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const existing = ledger.managerApprovalBatches.find(
        (entry) => entry.approvalBatchId === input.approvalBatchId,
      );
      if (existing) {
        if (!sameManagerApprovalBatchRegistration(existing, input)) {
          throw new ConflictException('采购审批批次内容冲突');
        }
        return { created: false, batch: existing };
      }
      const exactRecordSet = ledger.managerApprovalBatches.find((entry) =>
        sameRecordIdSet(entry.recordIds, input.recordIds),
      );
      if (exactRecordSet) {
        if (
          exactRecordSet.recipientOpenId !== input.recipientOpenId ||
          exactRecordSet.requesterOpenId !== input.requesterOpenId
        ) {
          throw new ConflictException('采购审批记录归属冲突');
        }
        return { created: false, batch: exactRecordSet };
      }
      const inputRecordIds = new Set(input.recordIds);
      if (
        ledger.managerApprovalBatches.some((entry) =>
          entry.recordIds.some((recordId) => inputRecordIds.has(recordId)),
        )
      ) {
        throw new ConflictException('采购审批记录已被其他批次占用');
      }
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
        managerDeliveries: (input.managers || [{ openId: input.recipientOpenId, name: '' }]).map(person => ({
          recipientOpenId: person.openId, recipientName: person.name,
          sourceNotificationKey: notificationKey({ ...notificationInput, recipientOpenId: person.openId }),
          messageId: '', selectedRejectRecordId: '',
        })),
        items: input.recordIds.map((executionRecordId) => ({
          executionRecordId,
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
    return this.enqueue(async () => {
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
    return this.enqueue(async () =>
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
          entry.kind === 'manager_batch_receipt_requested' &&
          entry.businessEventId ===
            `manager_batch_receipt_requested:${approvalBatchId}`,
      );
      const current = ledger.notifications[index];
      if (
        !batch ||
        !current ||
        current.status !== 'failed' ||
        current.recipientOpenId !== batch.requesterOpenId ||
        current.cardContext !== batch.cardContext ||
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
          entry.kind === 'manager_batch_receipt_requested' &&
          entry.businessEventId ===
            `manager_batch_receipt_requested:${approvalBatchId}`,
      );
      const current = ledger.notifications[index];
      if (
        !batch ||
        !current ||
        current.status !== 'failed' ||
        current.recipientOpenId !== batch.requesterOpenId ||
        current.cardContext !== batch.cardContext ||
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
    return this.updateNotification(key, claimToken, (entry) => {
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
    return this.enqueue(async () => {
      const matches = (await this.read()).managerApprovalBatches.filter(
        (entry) =>
          managerBatchDeliveries(entry).some(delivery => delivery.messageId === messageId && delivery.recipientOpenId === actorOpenId) &&
          entry.state !== 'awaiting_delivery',
      );
      if (matches.length > 1) {
        throw new ConflictException('采购批次审批卡消息映射不唯一');
      }
      return matches[0] ? managerBatchCardView(matches[0], actorOpenId) : null;
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
    return this.enqueue(async () => {
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
  ): Promise<{
    opened: boolean;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchCardIdentity(inputValue);
    const executionRecordId = normalizeRecordId(inputValue.executionRecordId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const batch = requireActiveManagerApprovalBatch(ledger, input);
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
  ): Promise<{
    cancelled: boolean;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    const input = normalizeManagerApprovalBatchCardIdentity(inputValue);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const batch = requireActiveManagerApprovalBatch(ledger, input);
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

  private async claimManagerApprovalBatchAction(
    input: NormalizedManagerApprovalBatchActionClaim,
    now: Date | number,
    authorize?: (batch: PurchaseManagerApprovalBatchEntry) => void,
  ): Promise<{
    claimed: boolean;
    entry: PurchaseManagerApprovalBatchActionEntry | null;
    batch: PurchaseManagerApprovalBatchEntry;
  }> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const replay = ledger.managerApprovalBatchActions.find(
        (entry) => entry.eventId === input.eventId,
      );
      if (replay && !sameManagerApprovalBatchActionPayload(replay, input)) {
        throw new ConflictException('采购批次审批回调事件与已有任务冲突');
      }
      const batch = requireActiveManagerApprovalBatch(ledger, input);
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
          ? batch.state === 'reject_editing' &&
            batch.selectedRejectRecordId === input.executionRecordId &&
            batch.items.some(
              (item) =>
                item.executionRecordId === input.executionRecordId &&
                item.status === 'pending',
            )
            ? [input.executionRecordId]
            : []
          : batch.state === 'active'
            ? batch.items
                .filter((item) => item.status === 'pending')
                .map((item) => item.executionRecordId)
            : [];
      if (recordIds.length === 0) return { claimed: false, entry: null, batch };
      if (
        ledger.managerApprovalBatchActions.filter((entry) =>
          isActiveStatus(entry.status),
        ).length >= MAX_MANAGER_APPROVAL_BATCH_ACTIONS
      ) {
        throw new ServiceUnavailableException(
          '采购批次审批动作队列已满，请稍后重试',
        );
      }
      authorize?.(structuredClone(batch));
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
    return this.enqueue(async () =>
      (await this.read()).managerApprovalBatchActions.filter(
        (entry) =>
          (!approvalBatchId || entry.approvalBatchId === approvalBatchId) &&
          (!filter.status || entry.status === filter.status),
      ),
    );
  }

  async getPurchaseBatchForFulfillmentCard(
    identityValue: PurchaseBatchFulfillmentCardIdentity,
  ): Promise<{
    batch: PurchaseManagerApprovalBatchEntry;
    source: PurchaseWorkflowNotificationEntry;
  }> {
    const identity = normalizePurchaseBatchFulfillmentIdentity(identityValue);
    return this.enqueue(async () =>
      requirePurchaseBatchFulfillmentSource(await this.read(), identity),
    );
  }

  async preparePurchaseBatchReceiptUpload(
    identityValue: PurchaseBatchFulfillmentCardIdentity,
    input: {
      executionRecordId: string;
      materialType: 'receipt_photo' | 'invoice';
    },
    now: Date | number = new Date(),
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
    return this.enqueue(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const { batch } = requirePurchaseBatchFulfillmentSource(ledger, identity);
      const item = batch.items.find(
        (candidate) => candidate.executionRecordId === executionRecordId,
      );
      if (!item || item.status !== 'approved') {
        throw new ConflictException('采购签收明细不可处理');
      }
      if (batch.requesterOpenId !== identity.actorOpenId) {
        throw new ConflictException('采购签收材料上传身份不匹配');
      }
      if (input.materialType === 'invoice' && item.choice !== 'building_self') {
        throw new ConflictException('综合采购无需上传发票');
      }
      const pendingReceiptUpload: PurchaseBatchReceiptUploadIntent = {
        executionRecordId,
        materialType: input.materialType,
        actorOpenId: identity.actorOpenId,
        messageId: identity.messageId,
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
    return this.enqueue(async () => {
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
      const batch = candidates[0];
      const intent = batch?.pendingReceiptUpload;
      if (!batch || !intent) {
        return { accepted: false, enqueued: false, notification: null };
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
    return this.enqueue(async () => {
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
      if (context.action === 'receipt' && ledger.notifications.some(task => task.kind === 'web_receipt_command' && task.recordId === context.executionRecordId)) throw new ConflictException('该采购记录已有网页签收任务，请查看原任务');
      if (
        ledger.notifications.filter((entry) => isActiveStatus(entry.status))
          .length >= MAX_NOTIFICATIONS
      ) {
        throw new ServiceUnavailableException(
          '采购通知任务队列已满，请稍后重试',
        );
      }
      authorize?.(structuredClone(batch),structuredClone(item));
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
    return this.enqueue(async()=>structuredClone(requireAcceptedFulfillment(await this.read(),proof,{recordId,action,actorOpenId})));
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
      for (const value of inputs.map(normalizeNotificationInput)) {
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
        if (input.kind === 'warehouse_inbound') input = { ...input, recipientOpenId: resolveWarehouseInboundRecipient(ledger.warehouseInboundHandovers, input.recordId, input.recipientOpenId) };
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
    return this.enqueue(async () => structuredClone((await this.read()).notifications.find(entry => entry.kind === 'web_receipt_command' && entry.webReceipt?.taskId === taskId) || null));
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
      authorize();
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
      for(const file of payload.files)if(!file.token)file.uploadStartedAt='';
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
      const reminderMessages = new Set(
        ledger.notifications
          .filter(
            (entry) =>
              entry.kind === 'warehouse_inbound' &&
              entry.status === 'completed' &&
              entry.messageId,
          )
          .map(
            (entry) =>
              `${entry.recordId}\u0000${entry.recipientOpenId}\u0000${entry.messageId}`,
          ),
      );
      const legacyIndex = ledger.notifications.findIndex((entry) => {
        if (
          entry.kind !== 'inventory_inbound_completed' ||
          entry.status !== 'completed' ||
          !entry.messageId ||
          entry.firstSendAttemptAt ||
          (allowedKindSet && !allowedKindSet.has(entry.kind))
        ) {
          return false;
        }
        const age = timestamp.getTime() - Date.parse(entry.completedAt);
        return (
          age >= 0 &&
          age <= LEGACY_REUSED_INBOUND_CARD_REQUEUE_WINDOW_MS &&
          reminderMessages.has(
            `${entry.recordId}\u0000${entry.recipientOpenId}\u0000${entry.messageId}`,
          )
        );
      });
      if (legacyIndex >= 0) {
        const legacy = ledger.notifications[legacyIndex];
        if (legacy) {
          ledger.notifications[legacyIndex] = {
            ...legacy,
            status: 'pending',
            attempts: 0,
            updatedAt: timestamp.toISOString(),
            nextAttemptAt: timestamp.toISOString(),
            leaseUntil: '',
            claimToken: '',
            completedAt: '',
            lastError: '',
            deliveryId: '',
            messageId: '',
            sendOutcome: 'unattempted',
          };
          await this.write(ledger);
        }
      }
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
          isAvailable(entry, timestamp),
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
      const index = ledger.notifications.findIndex(
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
    return this.updateNotification(key, claimToken, (entry) => {
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
    return this.enqueue(async () => {
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
    return this.enqueue(async()=>{const ledger=await this.read();return structuredClone({cards:ledger.managerApprovalCards,actions:ledger.managerApprovalActions,notifications:ledger.notifications});});
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
    return this.enqueue(async () => {
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
    return this.enqueue(async () => {
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
    return this.enqueue(async () => {
      const ledger = await this.read();
      const card = requireActiveManagerApprovalCard(ledger, identity);
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
    return this.enqueue(async () => {
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
    return this.enqueue(async () =>
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
      const normalizedInputs = inputs.map(normalizeNotificationInput);
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
    return this.enqueue(
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
    return this.enqueue(async () =>
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.ensureLock();
      return operation();
    };
    const result = this.sharedState.operation.then(run, run);
    this.sharedState.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      const parsed = JSON.parse(await readFile(this.ledgerPath, 'utf8')) as {
        commands?: unknown;
        reminders?: unknown;
        cardActions?: unknown;
        notifications?: unknown;
        managerApprovalActions?: unknown;
        managerApprovalCards?: unknown;
        managerApprovalBatches?: unknown;
        managerApprovalBatchActions?: unknown;
        personnelHandovers?: unknown;
        warehouseInboundHandovers?: unknown;
      };
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
      return {
        version: 2,
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
                  .map(sanitizeManagerApprovalBatch)
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyLedger();
      throw error;
    }
  }

  private async write(ledger: PurchaseWorkflowLedger): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(ledger, null, 2)}\n`,
        'utf8',
      );
      await rename(temporaryPath, this.ledgerPath);
    } finally {
      await removeFileIfExists(temporaryPath);
    }
  }
}

function getSharedLedgerState(ledgerPath: string): SharedLedgerState {
  const existing = sharedLedgerStates.get(ledgerPath);
  if (existing) return existing;
  const created: SharedLedgerState = {
    ledgerPath,
    lockPath: `${ledgerPath}.lock`,
    instanceId: randomUUID(),
    operation: Promise.resolve(),
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
  return { approvalBatchId, recipientOpenId, requesterOpenId, recordIds, ...(managers ? { managers } : {}) };
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
  return { approvalBatchId, messageId, actorOpenId };
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
  return { approvalBatchId, messageId, actorOpenId, role: value.role };
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
    (input.choice !== 'reject' ||
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
  if (
    batch.messageId !== identity.messageId ||
    batch.recipientOpenId !== identity.actorOpenId
  ) {
    throw new ConflictException('采购批次审批卡身份不匹配');
  }
  return batch;
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
  const expectedKind =
    identity.role === 'purchaser'
      ? 'manager_batch_purchase_assigned'
      : 'manager_batch_receipt_requested';
  const matches = ledger.notifications.filter(
    (entry) =>
      entry.kind === expectedKind &&
      entry.recipientOpenId === identity.actorOpenId &&
      entry.messageId === identity.messageId &&
      entry.status === 'completed' &&
      entry.sendOutcome === 'delivered' &&
      entry.cardContext === batch.cardContext,
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

function finalizeManagerApprovalBatchAction(
  ledger: PurchaseWorkflowLedger,
  batchValue: PurchaseManagerApprovalBatchEntry,
  action: PurchaseManagerApprovalBatchActionEntry,
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
      return {
        ...item,
        status: state.status,
        choice: state.choice,
        rejectionReason: state.rejectionReason,
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
      recordIds: Array.isArray(value.recordIds)
        ? value.recordIds.map((entry) => String(entry))
        : [],
    });
  } catch {
    return null;
  }
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
    const rejectionReason = normalizeManagerRejectionReason(
      rawItem.rejectionReason,
    );
    if (
      !RECORD_ID_PATTERN.test(executionRecordId) ||
      !isManagerBatchItemStatus(status) ||
      !isManagerBatchChoice(choice) ||
      !isValidManagerBatchItemDecision(status, choice, rejectionReason)
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
  return {
    ...registration,
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
  return {
    executionRecordId,
    materialType,
    actorOpenId,
    messageId,
    createdAt,
    expiresAt,
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
  const cardContext = normalizeOptionalCardContext(value?.cardContext);
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
    !OPEN_ID_PATTERN.test(recipientOpenId) ||
    !isNotificationKind(kind) ||
    !isNotificationStatus(status)
  ) {
    return null;
  }
  const claimToken = validClaimToken(value.claimToken);
  if (kind === 'web_receipt_command' && value.webReceipt === undefined || value.webReceipt !== undefined && kind !== 'web_receipt_command') throw new ServiceUnavailableException('网页签收任务类型无效');
  if (kind === 'web_receipt_command') {
    const receipt = normalizeWebReceiptCommand(value.webReceipt);
    if (receipt.recordId !== recordId || receipt.taskId !== businessEventId || receipt.actor.openId !== recipientOpenId) throw new ServiceUnavailableException('网页签收任务与原记录不一致');
  }
  if (value.approvalHandover !== undefined && (kind !== 'approval_requested' || !validSingleManagerHandover(value.approvalHandover))) throw new ServiceUnavailableException('采购原审批交接标记无效');
  if (value.approvalAuthority !== undefined && kind !== 'approval_requested') throw new ServiceUnavailableException('采购原审批发卡身份类型无效');
  if(value.acceptedAppId!==undefined&&(!isPurchaseBatchFulfillmentCommandKind(kind)||typeof value.acceptedAppId!=='string'||!/^cli_[A-Za-z0-9_-]+$/.test(value.acceptedAppId)))throw new ServiceUnavailableException('原采购命令应用身份无效');
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
  const inboundManualReconciliationsToKeep = new Set(
    entries
      .filter(
        (entry) =>
          isInboundCompletedDeliveryKind(entry.kind) &&
          entry.status === 'manual_reconciliation',
      )
      .slice(-MAX_INBOUND_COMPLETED_MANUAL_RECONCILIATIONS),
  );
  const inboundResolutionMarkersToKeep = new Set(
    entries
      .filter(
        (entry) =>
          isInboundCompletedResolutionKind(entry.kind) &&
          !isActiveStatus(entry.status),
      )
      .slice(-MAX_INBOUND_RESOLUTION_MARKERS),
  );
  const protectedEntries = new Set(
    entries.filter(
      (entry) =>
        isActiveStatus(entry.status) ||
        (entry.status === 'manual_reconciliation' &&
          (!isInboundCompletedDeliveryKind(entry.kind) ||
            inboundManualReconciliationsToKeep.has(entry))) ||
        inboundResolutionMarkersToKeep.has(entry) ||
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
): boolean {
  if (status === 'pending') return choice === '' && !rejectionReason;
  if (status === 'approved') {
    return (
      (choice === 'comprehensive' || choice === 'building_self') &&
      !rejectionReason
    );
  }
  if (status === 'rejected') {
    return choice === 'reject' && Boolean(rejectionReason);
  }
  if (status === 'processing') {
    return (
      choice === 'comprehensive' ||
      choice === 'building_self' ||
      (choice === 'reject' && Boolean(rejectionReason))
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
    return { proof: { ...proof, appId: payload.appId, cardContext: JSON.stringify(payload) }, actor: structuredClone(payload.actor), ...payload.scope };
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
  return{proof:{notificationKey:notification.key,claimToken:proof.claimToken,appId:notification.acceptedAppId,cardContext:notification.cardContext},...target,
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
