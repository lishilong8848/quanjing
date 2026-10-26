import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import type {
  PurchaseWorkflowRecord,
  PurchaseWorkflowUser,
} from '../../../shared/purchase-workflow.interface';
import {
  buildPurchaseBatchPurchaserCard,
  buildPurchaseBatchTransferredCard,
  buildPurchaseBatchReceiptCompletedCard,
  buildPurchaseBatchReceiptCard,
  parsePurchaseBatchFulfillmentCommandContext,
  type PurchaseBatchFulfillmentCommandContext,
  type PurchaseBatchPurchaserCardInput,
  type PurchaseBatchReceiptCardInput,
} from './purchase-batch-fulfillment-card';
import { receiptMaterialRequirement } from './purchase-receipt-material-policy';
import { parsePurchaseReceiptImageMessage } from './purchase-receipt-image-message';
import { PurchaseBatchAttachmentTicketService } from './purchase-batch-attachment-ticket';
import {
  buildPurchaseManagerApprovalCard,
  buildPurchaseManagerTransferredCard,
  buildPurchaseManagerManualReconciliationCard,
  buildPurchaseManagerPendingCard,
  buildPurchaseManagerRejectEditorCard,
  buildResolvedPurchaseManagerApprovalCard,
  parsePurchaseManagerApprovalCardContext,
  serializePurchaseManagerApprovalCardContext,
  type PurchaseManagerApprovalCardInput,
} from './purchase-manager-approval-card';
import {
  buildPurchaseManagerBatchApprovalCard,
  buildPurchaseManagerBatchHandoverCard,
  buildPurchaseManagerBatchManualReconciliationCard,
  buildPurchaseManagerBatchPendingCard,
  buildPurchaseManagerBatchRejectEditorCard,
  buildResolvedPurchaseManagerBatchApprovalCard,
  formatPurchaseBatchCardDate,
  formatPurchaseBatchCardDateTime,
  parsePurchaseManagerBatchApprovalCardContext,
  serializePurchaseManagerBatchApprovalCardContext,
  type PurchaseManagerBatchApprovalCardInput,
} from './purchase-manager-batch-approval-card';
import {
  isPurchaseManagerApprovalEnabled,
  readPurchaseManagerApprover,
  readPurchaseManagerApprovers,
} from './purchase-manager-approval.config';
import {
  buildPurchaseManagerDeliveredFields,
  buildPurchaseManagerDeliveryErrorFields,
  buildPurchaseManagerDeliveryManualReviewFields,
  buildPurchaseManagerResolvedFields,
  buildPurchaseManagerRoutingFields,
  buildPurchaseReceiptCardDeliveredFields,
  buildPurchaseReceiptCardDeliveryErrorFields,
  buildPurchaseReceiptCardDeliveryManualReviewFields,
  buildPurchaseReceiptCardDeliveryStartedFields,
  buildPurchaseReceiptCardRoutingFields,
  PURCHASE_MANAGER_APPROVAL_FIELDS,
  PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION,
} from './purchase-manager-approval.fields';
import {
  buildPurchaseManagerApprovalPatch,
  isManagerApprovalTargetApplied,
  type PurchaseManagerApprovalDecision,
} from './purchase-manager-approval.rules';
import { resolvePurchaseStage } from './purchase-workflow.rules';
import type { PurchaseCardCallbackResult } from './purchase-workflow-callback';
import { PurchaseApplicationTaskLedgerStore } from './purchase-application-task-ledger.store';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import {
  PurchaseWorkflowStore,
  managerBatchDeliveries,
  managerBatchCardView,
  type PurchaseManagerApprovalActionEntry,
  type PurchaseManagerApprovalBatchActionEntry,
  type PurchaseManagerApprovalBatchEntry,
  type PurchaseManagerApprovalCardEntry,
  type PurchaseWorkflowNotificationInput,
  type PurchaseWorkflowNotificationEntry,
} from './purchase-workflow.store';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const TASK_MAX_ATTEMPTS = 5;
const TASK_BATCH_MAX = 100;
const RECEIPT_RECOVERY_BATCH_MAX = 1;
const MANAGER_APPROVAL_BATCH_MAX_RECORDS = 20;
const BASE_RECONCILE_MIN_AGE_MS = 30_000;
const DECISION_PRE_STATE = '未开始（待审批）';
const RECOVERABLE_ORGANIZATION_PARSE_ERROR = '采购人员字段包含多个不同人员';
const BASE_PENDING_APPROVAL_FILTER =
  'CurrentValue.[采购流程]="未开始（待审批）"';
const BASE_PENDING_RECEIPT_FILTER =
  'CurrentValue.[采购流程]="下单完成（待签收）"';
const BASE_RECEIPT_RECONCILE_INTERVAL_MS = 30_000;
const FEISHU_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const PERMANENT_MESSAGE_UPDATE_FEISHU_CODES = new Set([
  230011, 230072, 230075, 230110,
]);

type ManagerCallbackAction = Extract<
  PurchaseCardCallbackResult,
  { kind: 'manager_action' }
>;
type ManagerBatchCallbackAction = Extract<
  PurchaseCardCallbackResult,
  { kind: 'manager_batch_action' }
>;
type PurchaseBatchFulfillmentCallbackAction = Extract<
  PurchaseCardCallbackResult,
  { kind: 'purchase_batch_fulfillment_action' }
>;
type PurchaseBatchCommandSnapshot = {
  status: PurchaseWorkflowNotificationEntry['status'];
  context: PurchaseBatchFulfillmentCommandContext;
};

export interface PurchaseManagerApprovalTaskRunResult {
  processed: number;
  failed: number;
  manualReconciliation: number;
  alerts: string[];
  errors: string[];
}

@Injectable()
export class PurchaseManagerApprovalService {
  private readonly logger = new Logger(PurchaseManagerApprovalService.name);
  private taskRunInProgress = false;
  private acceptedTaskRunTail: Promise<void> = Promise.resolve();
  private receiptRecoveryCursor = 0;
  private nextBaseReceiptReconcileAt = 0;

  constructor(
    private readonly gateway: PurchaseWorkflowGateway,
    private readonly store: PurchaseWorkflowStore,
    @Optional()
    private readonly submissionTaskLedger?: PurchaseApplicationTaskLedgerStore,
    @Optional()
    private readonly workflowService?: PurchaseWorkflowService,
    @Optional()
    private readonly attachmentTicketService?: PurchaseBatchAttachmentTicketService,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  isEnabled(): boolean {
    return isPurchaseManagerApprovalEnabled();
  }

  async patchPurchaseBatchFulfillmentCardView(
    messageId: string,
    card: Record<string, unknown>,
    updateToken?: string,
  ): Promise<void> {
    if (updateToken) {
      try {
        await this.gateway.updateInteractiveCardAfterCallback(
          updateToken,
          card,
        );
        return;
      } catch (error) {
        this.logger.warn(
          `采购履约卡片延时更新失败，改用原消息更新：${safeErrorMessage(error)}`,
        );
      }
    }
    await this.gateway.updateInteractiveCard(requireMessageId(messageId), card);
  }

  async enqueueApprovalRequest(recordId: string): Promise<void> {
    if (!this.isEnabled()) return;
    const normalizedRecordId = requireRecordId(recordId);
    await this.store.enqueueNotifications(readPurchaseManagerApprovers().map(manager => ({
      businessEventId: `manager_approval_requested:${normalizedRecordId}`,
      recordId: normalizedRecordId,
      recipientOpenId: manager.openId,
      kind: 'manager_approval_requested',
    })));
  }

  async enqueueApprovalBatch(input: {
    approvalBatchId: string;
    requesterOpenId: string;
    recordIds: string[];
  }): Promise<void> {
    if (!this.isEnabled()) return;
    const managers = readPurchaseManagerApprovers();
    await this.store.registerManagerApprovalBatch({
      approvalBatchId: input.approvalBatchId,
      requesterOpenId: input.requesterOpenId,
      recipientOpenId: managers[0]!.openId,
      managers,
      recordIds: input.recordIds,
    });
  }

  async handleManagerCardAction(
    result: ManagerCallbackAction,
  ): Promise<Record<string, unknown>> {
    assertFeishuBusinessIdentity(this.accessConfiguration, result.operatorOpenId);
    if (!this.isEnabled()) {
      throw new ConflictException('经理审批卡功能未启用');
    }
    if (result.action === 'submit_reject') {
      const current = await this.store.findManagerApprovalCard(
        result.messageId,
        result.operatorOpenId,
      );
      if (!current) {
        throw new ConflictException('经理审批卡消息映射不存在');
      }
      const claimed = await this.store.claimManagerApprovalAction({
        eventId: result.eventId,
        recordId: current.executionRecordId,
        choice: 'reject',
        rejectionReason: result.rejectionReason,
        messageId: result.messageId,
        actorOpenId: result.operatorOpenId,
      },new Date(),card=>this.assertCurrentManagerActor(result.operatorOpenId,parsePurchaseManagerApprovalCardContext(card.cardContext).building));
      return renderManagerApprovalCard(claimed.card);
    }

    const recordId = requireRecordId(result.executionRecordId);
    await this.ensureInitialCallbackCard(
      recordId,
      result.messageId,
      result.operatorOpenId,
    );
    if (result.action === 'open_reject') {
      const opened = await this.store.openManagerApprovalRejectEditor({
        recordId,
        messageId: result.messageId,
        actorOpenId: result.operatorOpenId,
      });
      return renderManagerApprovalCard(opened.card);
    }
    const choice =
      result.action === 'choose_comprehensive'
        ? 'comprehensive'
        : 'building_self';
    const claimed = await this.store.claimManagerApprovalAction({
      eventId: result.eventId,
      recordId,
      choice,
      rejectionReason: '',
      messageId: result.messageId,
      actorOpenId: result.operatorOpenId,
    },new Date(),card=>this.assertCurrentManagerActor(result.operatorOpenId,parsePurchaseManagerApprovalCardContext(card.cardContext).building));
    return renderManagerApprovalCard(claimed.card);
  }

  async handleManagerBatchCardAction(
    result: ManagerBatchCallbackAction,
  ): Promise<Record<string, unknown>> {
    assertFeishuBusinessIdentity(this.accessConfiguration, result.operatorOpenId);
    if (!this.isEnabled()) {
      throw new ConflictException('采购批次审批卡功能未启用');
    }
    let current = await this.store.findManagerApprovalBatchCard(
      result.messageId,
      result.operatorOpenId,
    );
    if (!current) {
      if (!result.approvalBatchId) {
        throw new ConflictException('采购批次审批卡消息映射不存在');
      }
      current = (
        await this.store.bindUnknownManagerApprovalBatchDeliveryFromCallback({
          approvalBatchId: result.approvalBatchId,
          messageId: result.messageId,
          actorOpenId: result.operatorOpenId,
        })
      ).batch;
    }
    if (
      result.approvalBatchId &&
      result.approvalBatchId !== current.approvalBatchId
    ) {
      throw new ConflictException('采购批次审批卡批次不匹配');
    }
    if (result.action === 'open_item_reject') {
      const opened = await this.store.openManagerApprovalBatchRejectEditor({
        approvalBatchId: current.approvalBatchId,
        executionRecordId: result.executionRecordId,
        messageId: result.messageId,
        actorOpenId: result.operatorOpenId,
      });
      return renderManagerApprovalBatch(opened.batch);
    }
    if (result.action === 'cancel_item_reject') {
      const cancelled = await this.store.cancelManagerApprovalBatchRejectEditor(
        {
          approvalBatchId: current.approvalBatchId,
          messageId: result.messageId,
          actorOpenId: result.operatorOpenId,
        },
      );
      return renderManagerApprovalBatch(cancelled.batch);
    }
    if (result.action === 'submit_item_reject') {
      if (!current.selectedRejectRecordId) {
        throw new ConflictException('采购批次审批卡未选择驳回明细');
      }
      const claimed = await this.store.claimManagerApprovalBatchItemReject({
        eventId: result.eventId,
        approvalBatchId: current.approvalBatchId,
        executionRecordId: current.selectedRejectRecordId,
        rejectionReason: result.rejectionReason,
        messageId: result.messageId,
        actorOpenId: result.operatorOpenId,
      },new Date(),batch=>this.assertCurrentManagerActor(result.operatorOpenId,parsePurchaseManagerBatchApprovalCardContext(batch.cardContext).building));
      return renderManagerApprovalBatch(claimed.batch);
    }
    const claimed = await this.store.claimManagerApprovalBatchPendingApproval({
      eventId: result.eventId,
      approvalBatchId: current.approvalBatchId,
      choice:
        result.action === 'approve_pending_comprehensive'
          ? 'comprehensive'
          : 'building_self',
      messageId: result.messageId,
      actorOpenId: result.operatorOpenId,
    },new Date(),batch=>this.assertCurrentManagerActor(result.operatorOpenId,parsePurchaseManagerBatchApprovalCardContext(batch.cardContext).building));
    return renderManagerApprovalBatch(claimed.batch);
  }

  async patchManagerApprovalCardView(messageId: string, actorOpenId: string, batch = false): Promise<void> {
    const current = batch
      ? await this.store.findManagerApprovalBatchCard(messageId, actorOpenId)
      : await this.store.findManagerApprovalCard(messageId, actorOpenId);
    if (!current) throw new ConflictException('采购审批卡消息映射不存在');
    const card = batch ? renderManagerApprovalBatch(current as PurchaseManagerApprovalBatchEntry) : renderManagerApprovalCard(current as PurchaseManagerApprovalCardEntry);
    await this.gateway.updateInteractiveCard(requireMessageId(messageId), card);
  }

  private assertCurrentManagerActor(openId:string,building:string,kind:'purchase_manager'|'purchase_executor'|'building_executor'='purchase_manager',specialty?:string):void {
    assertFeishuBusinessIdentity(this.accessConfiguration,openId);
    const members=typeof this.accessConfiguration?.currentDutyRoutePeople==='function'?this.accessConfiguration.currentDutyRoutePeople(kind,{building,...(specialty?{specialty}:{})}):null;
    if(members!==null&&!members.some(person=>person.openId===openId))throw new ForbiddenException('当前采购岗位已变化，请使用现任人员的新卡片办理');
  }

  async handlePurchaseBatchFulfillmentCardAction(
    result: PurchaseBatchFulfillmentCallbackAction,
  ): Promise<{ claimed: boolean; card: Record<string, unknown> }> {
    const startedAt = Date.now();
    assertFeishuBusinessIdentity(this.accessConfiguration, result.operatorOpenId);
    if (!this.isEnabled()) {
      throw new ConflictException('采购批次履约卡功能未启用');
    }
    const role = isOrderFulfillmentAction(result.action) ? 'purchaser' : 'requester';
    const identity = {
      approvalBatchId: result.approvalBatchId,
      messageId: result.messageId,
      actorOpenId: result.operatorOpenId,
      role,
    } as const;
    if (result.action === 'submit_order') {
      const claim = await this.store.claimPurchaseBatchFulfillmentCommand(
        identity,
        (batch) => {
          const item = requireApprovedBatchItem(batch, result.executionRecordId);
          return {
            version: 4,
            workflowType: 'purchase_batch_fulfillment',
            action: 'order',
            approvalBatchId: batch.approvalBatchId,
            executionRecordId: result.executionRecordId,
            actorOpenId: result.operatorOpenId,
            actualQuantity: result.actualQuantity,
            actualAmount: result.actualAmount,
            note: result.note,
            paymentAttachmentTokens: [...item.paymentAttachmentTokens],
          };
        },
        result.eventId,
        new Date(),
        (current, currentItem) =>
          this.assertCurrentManagerActor(
            result.operatorOpenId,
            currentItem.authorityTarget?.building ||
              parsePurchaseManagerBatchApprovalCardContext(current.cardContext).building,
            currentItem.choice === 'building_self' ? 'building_executor' : 'purchase_executor',
            currentItem.authorityTarget?.specialty,
          ),
      );
      const renderStartedAt = Date.now();
      const card = await this.renderPurchaseBatchPurchaserCard(
        claim.batch,
        result.operatorOpenId,
        undefined,
        'ledger',
        result.messageId,
        undefined,
        claim.fulfillmentNotifications,
      );
      this.logSlowFulfillmentAcceptance(
        result.executionRecordId,
        result.action,
        startedAt,
        renderStartedAt,
        claim,
      );
      return { claimed: claim.claimed, card };
    }

    if (result.action === 'submit_receipt') {
      const claim = await this.store.claimPurchaseBatchFulfillmentCommand(
        identity,
        (batch) => {
          const item = requireApprovedBatchItem(batch, result.executionRecordId);
          if (!item.receiptPhotoTokens.length) {
            throw new BadRequestException('请先上传签收照片');
          }
          if (
            receiptMaterialRequirement(purchaseMethodForBatchItem(item.choice)).requiresInvoice &&
            !item.invoiceTokens.length
          ) {
            throw new BadRequestException('自采签收必须上传发票');
          }
          return {
            version: 4,
            workflowType: 'purchase_batch_fulfillment',
            action: 'receipt',
            approvalBatchId: batch.approvalBatchId,
            executionRecordId: result.executionRecordId,
            actorOpenId: result.operatorOpenId,
            signerOpenId: result.signerOpenId,
            receiptTime: result.receiptTime,
            note: result.note,
            receiptPhotoTokens: [...item.receiptPhotoTokens],
            invoiceTokens: [...item.invoiceTokens],
          };
        },
        result.eventId,
        new Date(),
        () => assertFeishuBusinessIdentity(this.accessConfiguration, result.operatorOpenId),
      );
      const renderStartedAt = Date.now();
      const card = await this.renderPurchaseBatchReceiptCard(
        claim.batch,
        undefined,
        'ledger',
        undefined,
        claim.fulfillmentNotifications,
      );
      this.logSlowFulfillmentAcceptance(
        result.executionRecordId,
        result.action,
        startedAt,
        renderStartedAt,
        claim,
      );
      return { claimed: claim.claimed, card };
    }

    const { batch } = await this.store.getPurchaseBatchForFulfillmentCard(identity);

    if (result.action === 'prepare_receipt_photo' || result.action === 'prepare_invoice') {
      const updated = await this.store.preparePurchaseBatchReceiptUpload(identity, {
        executionRecordId: result.executionRecordId,
        materialType: result.action === 'prepare_invoice' ? 'invoice' : 'receipt_photo',
      });
      return {
        claimed: false,
        card: await this.renderPurchaseBatchReceiptCard(
          updated,
          result.executionRecordId,
          'ledger',
        ),
      };
    }

    const selectedRecordId =
      result.action === 'open_order' || result.action === 'open_receipt'
        ? result.executionRecordId
        : undefined;
    const card =
      role === 'purchaser'
        ? await this.renderPurchaseBatchPurchaserCard(
            batch,
            result.operatorOpenId,
            selectedRecordId,
            'ledger',
            result.messageId,
          )
        : await this.renderPurchaseBatchReceiptCard(batch, selectedRecordId, 'ledger');
    return {
      claimed: false,
      card,
    };
  }

  private logSlowFulfillmentAcceptance(
    recordId: string,
    action: 'submit_order' | 'submit_receipt',
    startedAt: number,
    renderStartedAt: number,
    claim: { claimed: boolean; timing?: { queueMs: number; readMs: number; decisionMs: number; writeMs: number } },
  ): void {
    const finishedAt = Date.now();
    if (finishedAt - startedAt < 1000) return;
    const phases = claim.timing
      ? `queueMs=${claim.timing.queueMs} readMs=${claim.timing.readMs} decisionMs=${claim.timing.decisionMs} writeMs=${claim.timing.writeMs}`
      : 'ledgerTiming=unavailable';
    this.logger.warn(`采购履约受理耗时 record=${recordId} action=${action} ${phases} renderMs=${Math.max(0, finishedAt - renderStartedAt)} totalMs=${Math.max(0, finishedAt - startedAt)} claimed=${claim.claimed}`);
  }

  async handlePurchaseReceiptImageMessage(payload: unknown): Promise<{
    accepted: boolean;
    enqueued: boolean;
  }> {
    const message = parsePurchaseReceiptImageMessage(payload);
    if (!message) return { accepted: false, enqueued: false };
    assertFeishuBusinessIdentity(this.accessConfiguration, message.actorOpenId);
    const accepted =
      await this.store.acceptPurchaseReceiptImageMessage(message);
    return { accepted: accepted.accepted, enqueued: accepted.enqueued };
  }

  async runPersonnelHandovers(limit = 20, now = new Date()): Promise<{ processed: number; failed: number }> {
    const result = { processed: 0, failed: 0 }; if (!this.isEnabled()) return result;
    for (let count = 0; count < Math.min(Math.max(Math.floor(limit) || 1, 1), 20); count += 1) {
      const job = await this.store.takeNextPersonnelHandover(now); if (!job) break;
      const started = Date.now(), logicalNow = () => new Date(now.getTime() + Date.now() - started);
      let heartbeatError: unknown, heartbeatTail = Promise.resolve();
      const heartbeat = setInterval(() => {
        heartbeatTail = heartbeatTail.then(async () => { try { await this.store.updatePersonnelHandoverProgress(job.mutationId, job.claimToken, 'renew', undefined, logicalNow()); } catch (error) { heartbeatError = error; } });
      }, 15_000); heartbeat.unref?.();
      try {
        assertFeishuBusinessIdentity(this.accessConfiguration, job.target.openId);
        if (!job.oldCardPatchedAt) {
          await this.gateway.updateInteractiveCard(job.oldMessageId, buildPurchaseManagerBatchHandoverCard(parsePurchaseManagerBatchApprovalCardContext(job.oldCardContext)));
          await this.store.updatePersonnelHandoverProgress(job.mutationId, job.claimToken, 'patch', undefined, logicalNow());
        }
        for (const recordId of job.pendingRecordIds) {
          if (job.confirmedRecordIds.includes(recordId)) continue;
          if (heartbeatError) throw heartbeatError;
          assertFeishuBusinessIdentity(this.accessConfiguration, job.target.openId);
          await this.gateway.writeManagerPendingHandover({ recordId, sourceOpenId: job.sourceOpenId, targetOpenId: job.target.openId, approvalBatchId: job.approvalBatchId });
          await this.store.updatePersonnelHandoverProgress(job.mutationId, job.claimToken, 'record', recordId, logicalNow());
        }
        if (heartbeatError) throw heartbeatError;
        assertFeishuBusinessIdentity(this.accessConfiguration, job.target.openId);
        await this.store.completePersonnelHandover(job.mutationId, job.claimToken, logicalNow()); result.processed += 1;
      } catch {
        try { await this.store.failPersonnelHandover(job.mutationId, job.claimToken, logicalNow()); }
        catch { this.logger.warn('采购交接租约已变化，当前回执由持久任务恢复'); }
        result.failed += 1;
      } finally { clearInterval(heartbeat); await heartbeatTail; }
    }
    return result;
  }

  async runPersonnelHandoverDeliveries(limit = 20, now = new Date()): Promise<{ processed: number; failed: number }> {
    const result = { processed: 0, failed: 0 }; if (!this.isEnabled()) return result;
    for (let count = 0; count < Math.min(Math.max(Math.floor(limit) || 1, 1), 20); count += 1) {
      const claimed = await this.store.takeNextPersonnelHandoverDelivery(now); if (!claimed) break;
      const { job, notification } = claimed;
      try {
        for (const recordId of job.pendingRecordIds) {
          if (job.deliveryConfirmedRecordIds?.includes(recordId)) continue;
          await this.gateway.writeManagerHandoverDeliveryReceipt({ recordId,
            targetOpenId: job.target.openId, approvalBatchId: job.approvalBatchId, messageId: notification.messageId,
            deliveryUuid: notification.deliveryUuid, deliveredAt: notification.completedAt, deliveryAttempts: notification.attempts });
          await this.store.recordPersonnelHandoverDeliveryRecord(job.mutationId, job.deliveryClaimToken!, recordId, now);
        }
        await this.store.settlePersonnelHandoverDelivery(job.mutationId, job.deliveryClaimToken!, notification.messageId, now); result.processed += 1;
      } catch {
        try { await this.store.settlePersonnelHandoverDelivery(job.mutationId, job.deliveryClaimToken!, null, now); }
        catch { this.logger.warn('采购交接投递回执租约已变化，待原任务恢复'); }
        result.failed += 1;
      }
    }
    return result;
  }

  async runPendingTasks(
    limit = 20,
    now: Date = new Date(),
  ): Promise<PurchaseManagerApprovalTaskRunResult> {
    const result: PurchaseManagerApprovalTaskRunResult = {
      processed: 0,
      failed: 0,
      manualReconciliation: 0,
      alerts: [],
      errors: [],
    };
    if (!this.isEnabled()) return result;
    if (this.taskRunInProgress) {
      return this.runAcceptedTasks(limit, now);
    }
    const batchLimit = Math.max(
      1,
      Math.min(TASK_BATCH_MAX, Math.floor(limit) || 1),
    );
    const timestamp = resolveNow(now);
    this.taskRunInProgress = true;
    try {
      try {
        await this.gateway.ensureManagerApprovalFieldsAsApp?.();
      } catch (error) {
        recordTaskFailure(result, 'purchase-manager-field-schema', error);
      }
      await this.requeueKnownPrewriteManagerApprovalActions(result, timestamp);
      const handovers = await this.runPersonnelHandovers(batchLimit, timestamp);
      result.processed += handovers.processed; result.failed += handovers.failed;
      let handled = await this.processPendingTasks(
        batchLimit,
        timestamp,
        result,
      );
      await this.reconcileMissingReceiptCards(result, timestamp);
      if (handled < batchLimit) {
        handled += await this.processPendingTasks(
          batchLimit - handled,
          timestamp,
          result,
        );
      }
      await this.reconcileCompletedApplicationBatches(result);
      await this.reconcileBasePendingReceiptBatches(result, timestamp);
      if (handled < batchLimit) {
        handled += await this.processPendingTasks(
          batchLimit - handled,
          timestamp,
          result,
        );
      }
      await this.reconcileBasePendingApprovalBatches(result, timestamp);
      if (handled < batchLimit) {
        await this.processPendingTasks(batchLimit - handled, timestamp, result);
      }
      const deliveryReceipts = await this.runPersonnelHandoverDeliveries(batchLimit, timestamp);
      result.processed += deliveryReceipts.processed; result.failed += deliveryReceipts.failed;
      return result;
    } finally {
      this.taskRunInProgress = false;
    }
  }

  private async requeueKnownPrewriteManagerApprovalActions(
    result: PurchaseManagerApprovalTaskRunResult,
    now: Date,
  ): Promise<void> {
    const actions = await this.store.listManagerApprovalBatchActions({
      status: 'manual_reconciliation',
    });
    for (const action of actions) {
      try {
        const batch = await this.store.findManagerApprovalBatch(
          action.approvalBatchId,
        );
        if (!batch) continue;
        const recoverableItems = batch.items.filter(
          (item) =>
            item.status === 'manual_reconciliation' &&
            item.actionEventId === action.eventId &&
            item.lastError === RECOVERABLE_ORGANIZATION_PARSE_ERROR,
        );
        if (recoverableItems.length === 0) continue;
        const hasOtherManualItems = batch.items.some(
          (item) =>
            item.status === 'manual_reconciliation' &&
            item.actionEventId === action.eventId &&
            item.lastError !== RECOVERABLE_ORGANIZATION_PARSE_ERROR,
        );
        if (hasOtherManualItems) continue;
        const records = await Promise.all(
          recoverableItems.map((item) =>
            this.getManagerDecisionRecord(item.executionRecordId),
          ),
        );
        if (records.some((record) => record.status !== DECISION_PRE_STATE)) {
          continue;
        }
        await this.store.requeueKnownPrewriteManagerApprovalBatchAction(
          action.key,
          recoverableItems.map((item) => item.executionRecordId),
          now,
        );
      } catch (error) {
        recordTaskFailure(
          result,
          `manager-approval-recover:${action.key}`,
          error,
        );
      }
    }
  }

  async runAcceptedTasks(
    limit = 20,
    now: Date = new Date(),
  ): Promise<PurchaseManagerApprovalTaskRunResult> {
    const batchLimit = Math.max(
      1,
      Math.min(TASK_BATCH_MAX, Math.floor(limit) || 1),
    );
    const timestamp = resolveNow(now);
    const execute = async (): Promise<PurchaseManagerApprovalTaskRunResult> => {
      const result: PurchaseManagerApprovalTaskRunResult = {
        processed: 0,
        failed: 0,
        manualReconciliation: 0,
        alerts: [],
        errors: [],
      };
      if (!this.isEnabled()) return result;
      await this.processPendingTasks(batchLimit, timestamp, result);
      return result;
    };
    const run = this.acceptedTaskRunTail.then(execute, execute);
    this.acceptedTaskRunTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async processPendingTasks(
    limit: number,
    timestamp: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<number> {
    let handled = 0;
    for (; handled < limit; handled += 1) {
      // 已受理的批次决议优先写入，避免卡片展示更新积压阻塞审批。
      const batchAction =
        await this.store.takeNextManagerApprovalBatchAction?.(timestamp);
      if (batchAction) {
        if (await this.processBatchAction(batchAction, timestamp, result)) {
          result.processed += 1;
        }
        continue;
      }
      const notification =
        await this.store.takeNextManagerApprovalNotification(timestamp);
      if (notification) {
        if (isManualManagerDeliveryTransition(notification)) {
          await this.markManualManagerDeliveryBestEffort(
            notification,
            timestamp,
            result,
          );
          result.manualReconciliation += 1;
          result.alerts.push('经理审批卡投递结果需要人工核对');
          continue;
        }
        if (await this.processNotification(notification, timestamp, result)) {
          result.processed += 1;
        }
        continue;
      }
      const action = await this.store.takeNextManagerApprovalAction(timestamp);
      if (!action) break;
      if (await this.processAction(action, timestamp, result)) {
        result.processed += 1;
      }
    }
    return handled;
  }

  private async reconcileMissingReceiptCards(
    result: PurchaseManagerApprovalTaskRunResult,
    now: Date,
  ): Promise<void> {
    const receipts = await this.store.listNotifications({
      kind: 'manager_batch_receipt_requested',
    });
    const receiptBatchIds = new Set<string>();
    for (const receipt of receipts) {
      const approvalBatchId = receipt.businessEventId.replace(
        /^manager_batch_receipt_requested:/u,
        '',
      );
      receiptBatchIds.add(approvalBatchId);
      if (receipt.status === 'failed') {
        try {
          const recoveredKnownSchemaFailure =
            await this.store.requeueRejectedManagerBatchReceiptCardSchema(
              approvalBatchId,
              now,
            );
          if (!recoveredKnownSchemaFailure) {
            await this.store.requeueFailedUnattemptedManagerBatchReceipt(
              approvalBatchId,
              now,
            );
          }
        } catch (error) {
          recordTaskFailure(
            result,
            `receipt-recovery:${approvalBatchId}`,
            error,
          );
        }
      }
    }

    const commands = await this.store.listNotifications({
      kind: 'manager_batch_order_command',
    });
    const candidates: Array<
      Extract<PurchaseBatchFulfillmentCommandContext, { action: 'order' }>
    > = [];
    for (const command of [...commands].reverse()) {
      let context: PurchaseBatchFulfillmentCommandContext;
      try {
        context = parsePurchaseBatchFulfillmentCommandContext(
          command.cardContext,
        );
      } catch {
        continue;
      }
      if (
        context.action !== 'order' ||
        (command.status !== 'completed' && command.status !== 'failed') ||
        receiptBatchIds.has(context.approvalBatchId)
      ) {
        continue;
      }
      candidates.push(context);
    }
    if (!candidates.length) return;
    const start = this.receiptRecoveryCursor % candidates.length;
    const count = Math.min(RECEIPT_RECOVERY_BATCH_MAX, candidates.length);
    this.receiptRecoveryCursor = (start + count) % candidates.length;
    for (let offset = 0; offset < count; offset += 1) {
      const context = candidates[(start + offset) % candidates.length]!;
      if (receiptBatchIds.has(context.approvalBatchId)) continue;
      try {
        const batch = await this.store.findManagerApprovalBatch(
          context.approvalBatchId,
        );
        if (
          !batch ||
          !batch.items.some(
            (item) =>
              item.executionRecordId === context.executionRecordId &&
              item.status === 'approved' &&
              item.purchaserOpenId === context.actorOpenId,
          )
        ) {
          continue;
        }
        const record = await this.gateway.getExecutionRecordAsApp(
          context.executionRecordId,
        );
        if (
          resolvePurchaseStage(record.status) !== 'receipt' ||
          record.requesterOpenId !== batch.requesterOpenId ||
          record.purchaserOpenId !== context.actorOpenId ||
          record.actualQuantity !== context.actualQuantity ||
          record.actualAmount === null ||
          Math.round(record.actualAmount * 100) !==
            Math.round(context.actualAmount * 100)
        ) {
          continue;
        }
        await this.store.enqueueNotification(
          {
            businessEventId: `manager_batch_receipt_requested:${batch.approvalBatchId}`,
            recordId: batch.recordIds[0]!,
            recipientOpenId: batch.requesterOpenId,
            kind: 'manager_batch_receipt_requested',
            cardContext: batch.cardContext,
          },
          now,
        );
        receiptBatchIds.add(batch.approvalBatchId);
      } catch (error) {
        recordTaskFailure(
          result,
          `receipt-recovery:${context.approvalBatchId}`,
          error,
        );
      }
    }
  }

  private async reconcileCompletedApplicationBatches(
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<void> {
    if (!this.submissionTaskLedger) return;
    const registered = new Set(await this.store.listManagerApprovalBatchIds());
    const tasks =
      this.submissionTaskLedger.listCompletedTasksWithCreatedRecords(500);
    for (const entry of tasks) {
      if (registered.has(entry.task.id) || !entry.task.result?.created.length) {
        continue;
      }
      const recordIds = entry.task.result.created.map(
        (item) => item.executionRecordId || item.recordId,
      );
      try {
        const first = await this.gateway.getExecutionRecordAsApp(recordIds[0]!);
        await this.enqueueApprovalBatch({
          approvalBatchId: entry.task.id,
          requesterOpenId: first.requesterOpenId,
          recordIds,
        });
        registered.add(entry.task.id);
      } catch (error) {
        recordTaskFailure(
          result,
          `manager-batch-reconcile:${entry.task.id}`,
          error,
        );
      }
    }
  }

  private async reconcileBasePendingReceiptBatches(
    result: PurchaseManagerApprovalTaskRunResult,
    now: Date,
  ): Promise<void> {
    if (
      typeof this.gateway.listExecutionRecordsForRecoveryAsApp !== 'function' &&
      typeof this.gateway.listExecutionRecordsAsApp !== 'function'
    ) {
      return;
    }
    if (now.getTime() < this.nextBaseReceiptReconcileAt) return;
    this.nextBaseReceiptReconcileAt =
      now.getTime() + BASE_RECEIPT_RECONCILE_INTERVAL_MS;
    let records: PurchaseWorkflowRecord[];
    try {
      if (
        typeof this.gateway.listExecutionRecordsForRecoveryAsApp === 'function'
      ) {
        const listing = await this.gateway.listExecutionRecordsForRecoveryAsApp(
          BASE_PENDING_RECEIPT_FILTER,
        );
        records = listing.records;
        for (const error of listing.errors) {
          recordTaskFailure(
            result,
            `purchase-receipt-base-map:${error.recordId}`,
            new ConflictException(error.message),
          );
        }
      } else {
        records = await this.gateway.listExecutionRecordsAsApp(
          BASE_PENDING_RECEIPT_FILTER,
        );
      }
    } catch (error) {
      recordTaskFailure(result, 'purchase-receipt-base-scan', error);
      return;
    }

    const groups = new Map<string, PurchaseWorkflowRecord[]>();
    for (const record of records) {
      if (
        resolvePurchaseStage(record.status) !== 'receipt' ||
        record.receiptConfirmed
      ) {
        continue;
      }
      const requesterOpenId = record.requesterOpenId.trim();
      const purchaserOpenId = record.purchaserOpenId.trim();
      const requestCode = record.requestCode.trim();
      if (
        !FEISHU_OPEN_ID_PATTERN.test(requesterOpenId) ||
        !FEISHU_OPEN_ID_PATTERN.test(purchaserOpenId) ||
        !requestCode ||
        !purchaseMethodToRecoveredChoice(record.purchaseMethod) ||
        record.actualQuantity === null ||
        record.actualQuantity <= 0 ||
        record.actualAmount === null ||
        record.actualAmount < 0
      ) {
        recordTaskFailure(
          result,
          `purchase-receipt-base-invalid:${record.recordId}`,
          new ConflictException(
            '采购待签收记录缺少申请人、采购人、采购方式或有效下单结果',
          ),
        );
        continue;
      }
      const persistedBatchId = record.receiptCardBatchId?.trim() || '';
      const key = persistedBatchId
        ? `receipt:${persistedBatchId}`
        : `record:${record.recordId}`;
      const group = groups.get(key) || [];
      group.push(record);
      groups.set(key, group);
    }
    if (!groups.size) return;

    let manager: ReturnType<typeof readPurchaseManagerApprover>;
    try {
      manager = readPurchaseManagerApprover();
    } catch (error) {
      recordTaskFailure(result, 'purchase-receipt-route-config', error);
      return;
    }

    for (const [groupKey, groupValue] of [...groups.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const group = [...groupValue].sort((left, right) =>
        left.recordId.localeCompare(right.recordId),
      );
      const persistedBatchIds = [
        ...new Set(
          group
            .map((record) => record.receiptCardBatchId?.trim() || '')
            .filter(Boolean),
        ),
      ];
      const recoveryBatchId =
        persistedBatchIds[0] ||
        `purchase-receipt-record-v1-${shortStableId(group[0]!.recordId)}`;
      const recordIds = group.map((record) => record.recordId);
      try {
        if (
          persistedBatchIds.length > 1 ||
          group.length > MANAGER_APPROVAL_BATCH_MAX_RECORDS
        ) {
          throw new ConflictException('采购待签收卡片批次标识或明细数量异常');
        }
        const input = toRecoveredReceiptBatchCardInput(
          recoveryBatchId,
          group,
          now,
        );
        const messageIds = [
          ...new Set(
            group
              .map((record) => record.receiptCardMessageId?.trim() || '')
              .filter(Boolean),
          ),
        ];
        const deliveryUuids = [
          ...new Set(
            group
              .map((record) => record.receiptCardDeliveryUuid?.trim() || '')
              .filter(Boolean),
          ),
        ];
        const deliveryStates = group.map(
          (record) => record.receiptCardDeliveryStatus?.trim() || '',
        );
        const hasDelivered = deliveryStates.includes('已送达');
        const hasUnknownState = deliveryStates.some(
          (state) =>
            state &&
            !['待投递', '投递中', '已送达', '投递异常', '送达待核对'].includes(
              state,
            ),
        );
        const hasUncertainDelivery =
          hasUnknownState ||
          deliveryStates.some(
            (state) => state === '投递中' || state === '送达待核对',
          ) ||
          (!hasDelivered && messageIds.length > 0);
        if (
          (hasDelivered && messageIds.length !== 1) ||
          deliveryUuids.length > 1
        ) {
          throw new ConflictException('采购签收卡送达证据不完整或相互冲突');
        }
        const deliveredAtValues = group
          .map((record) => record.receiptCardDeliveredAt)
          .filter(
            (value): value is number =>
              typeof value === 'number' && Number.isFinite(value) && value > 0,
          );
        const recovered = await this.store.recoverManagerReceiptBatchAndEnqueue(
          {
            approvalBatchId: recoveryBatchId,
            recipientOpenId: (await this.store.findManagerApprovalBatch(recoveryBatchId))?.recipientOpenId || manager.openId,
            requesterOpenId: input.requesterOpenId,
            recordIds,
            cardContext:
              serializePurchaseManagerBatchApprovalCardContext(input),
            batchIdSource:
              persistedBatchIds.length === 1 ? 'persisted' : 'derived',
            createIfMissing: hasDelivered
              ? persistedBatchIds.length === 1
              : !hasUncertainDelivery,
            delivered: hasDelivered
              ? {
                  messageId: messageIds[0]!,
                  deliveryUuid: deliveryUuids[0] || '',
                  attempts: Math.max(
                    1,
                    ...group.map(
                      (record) => record.receiptCardDeliveryAttempts || 0,
                    ),
                  ),
                  deliveredAt: deliveredAtValues.length
                    ? Math.max(...deliveredAtValues)
                    : now,
                }
              : undefined,
            items: group.map((record) => ({
              executionRecordId: record.recordId,
              choice: purchaseMethodToRecoveredChoice(record.purchaseMethod)!,
              purchaserOpenId: record.purchaserOpenId,
              purchaserName: record.purchaserName || record.purchaserOpenId,
              actualQuantity: record.actualQuantity!,
              actualAmount: record.actualAmount!,
              note: record.note || '',
              paymentAttachmentTokens: [
                ...(record.paymentAttachmentTokens || []),
              ],
            })),
          },
          now,
        );
        if (recovered.outcome === 'missing' || !recovered.notification) {
          await this.markBaseReceiptDeliveryManualReview(
            recordIds,
            recoveryBatchId,
            group,
            hasDelivered
              ? '采购签收卡已显示送达，但本地台账缺失且无法安全重建回调关系'
              : '采购签收卡投递结果不明确且本地台账缺失，已停止重复发送',
            result,
          );
          result.alerts.push(
            `purchase-receipt-base:${groupKey}: 投递结果需人工核对`,
          );
          continue;
        }
        await this.updateProgramApprovalFieldsBestEffort(
          recordIds,
          buildReceiptDeliverySnapshotFields(recovered.notification, now),
          'purchase-receipt-recovery-mark',
          result,
        );
      } catch (error) {
        await this.markBaseReceiptDeliveryManualReview(
          recordIds,
          recoveryBatchId,
          group,
          safeErrorMessage(error),
          result,
        );
        recordTaskFailure(
          result,
          `purchase-receipt-base-register:${recoveryBatchId}`,
          error,
        );
      }
    }
  }

  private async reconcileBasePendingApprovalBatches(
    result: PurchaseManagerApprovalTaskRunResult,
    now: Date,
  ): Promise<void> {
    if (typeof this.gateway.listExecutionRecordsAsApp !== 'function') return;
    let records: PurchaseWorkflowRecord[];
    try {
      records = await this.gateway.listExecutionRecordsAsApp(
        BASE_PENDING_APPROVAL_FILTER,
      );
    } catch (error) {
      recordTaskFailure(result, 'manager-approval-base-scan', error);
      return;
    }

    const groups = new Map<string, PurchaseWorkflowRecord[]>();
    const inFlightSubmissionBatches = new Map<string, boolean>();
    for (const record of records) {
      if (!isBaseReconciliationCandidate(record, now)) continue;
      const approvalBatchId = record.approvalBatchId?.trim() || '';
      if (approvalBatchId && this.submissionTaskLedger) {
        let isInFlight = inFlightSubmissionBatches.get(approvalBatchId);
        if (isInFlight === undefined) {
          try {
            const submission =
              this.submissionTaskLedger.findByTaskId(approvalBatchId);
            isInFlight =
              submission?.task.status === 'pending' ||
              submission?.task.status === 'running';
            inFlightSubmissionBatches.set(approvalBatchId, isInFlight);
          } catch (error) {
            recordTaskFailure(
              result,
              `manager-approval-base-submission:${approvalBatchId}`,
              error,
            );
            continue;
          }
        }
        if (isInFlight) continue;
      }
      const requestCode = record.requestCode.trim();
      const requesterOpenId = record.requesterOpenId.trim();
      if (!requestCode || !requesterOpenId) {
        recordTaskFailure(
          result,
          `manager-approval-base-invalid:${record.recordId}`,
          new ConflictException('采购待审批记录缺少采购编码或需求人 Open ID'),
        );
        continue;
      }
      const key = `${requestCode}\u0000${requesterOpenId}`;
      const group = groups.get(key) || [];
      group.push(record);
      groups.set(key, group);
    }

    if (!groups.size) return;
    let managers: ReturnType<typeof readPurchaseManagerApprovers>;
    try {
      managers = readPurchaseManagerApprovers();
    } catch (error) {
      recordTaskFailure(result, 'manager-approval-route-config', error);
      return;
    }
    for (const [groupKey, groupValue] of [...groups.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const group = [...groupValue].sort((left, right) =>
        left.recordId.localeCompare(right.recordId),
      );
      for (
        let offset = 0;
        offset < group.length;
        offset += MANAGER_APPROVAL_BATCH_MAX_RECORDS
      ) {
        const chunk = group.slice(
          offset,
          offset + MANAGER_APPROVAL_BATCH_MAX_RECORDS,
        );
        const recordIds = chunk.map((record) => record.recordId);
        const existingBatchIds = [
          ...new Set(
            chunk
              .map((record) => record.approvalBatchId?.trim() || '')
              .filter(Boolean),
          ),
        ];
        const proposedBatchId =
          existingBatchIds.length === 1
            ? existingBatchIds[0]!
            : `purchase-base-${shortStableId(
                `${groupKey}\u0000${recordIds.join('\u0000')}`,
              )}`;
        try {
          if (existingBatchIds.length > 1) {
            throw new ConflictException('采购待审批记录存在多个批次号');
          }
          const previousBatch = await this.store.findManagerApprovalBatch(proposedBatchId);
          const registration = await this.store.registerManagerApprovalBatch(
            {
              approvalBatchId: proposedBatchId,
              requesterOpenId: chunk[0]!.requesterOpenId,
              recipientOpenId: previousBatch?.recipientOpenId || managers[0]!.openId,
              ...(previousBatch ? {} : { managers }),
              recordIds,
            },
            now,
          );
          const legacyRecovery = chunk.every(
            (record) =>
              record.approvalPolicyVersion ===
              PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION,
          )
            ? await this.store.requeueLegacyIncompatibleManagerApprovalBatchDelivery(
                registration.batch.approvalBatchId,
                {
                  approvalPolicyVersion:
                    PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION,
                  externalError: chunk
                    .map((record) => record.approvalWorkflowError || '')
                    .filter(Boolean)
                    .join('; '),
                },
                now,
              )
            : { requeued: false, notification: null };
          const notification =
            legacyRecovery.notification ||
            (await this.store.getNotification(
              registration.batch.sourceNotificationKey,
            ));
          const routingFields = buildManagerBatchDeliverySnapshotFields(
            registration.batch,
            notification,
            now,
          );
          if (shouldPersistManagerBatchDeliverySnapshot(notification)) {
            for (const record of chunk) {
              try {
                await this.gateway.updateExecutionRecordAsApp(
                  record.recordId,
                  routingFields,
                );
              } catch (error) {
                recordTaskFailure(
                  result,
                  `manager-approval-base-mark:${record.recordId}`,
                  error,
                );
              }
            }
          }
        } catch (error) {
          recordTaskFailure(
            result,
            `manager-approval-base-register:${proposedBatchId}`,
            error,
          );
        }
      }
    }
  }

  private async ensureInitialCallbackCard(
    recordId: string,
    messageId: string,
    actorOpenId: string,
  ): Promise<PurchaseManagerApprovalCardEntry> {
    const existing = await this.store.findManagerApprovalCard(
      messageId,
      actorOpenId,
    );
    if (existing) {
      if (existing.executionRecordId !== recordId) {
        throw new ConflictException('经理审批卡记录不匹配');
      }
      return existing;
    }
    const bound =
      await this.store.bindUnknownManagerApprovalDeliveryFromCallback({
        recordId,
        messageId,
        actorOpenId,
      });
    return bound.card;
  }

  private async processAction(
    action: PurchaseManagerApprovalActionEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let decision: PurchaseManagerApprovalDecision = {
      choice: action.choice,
      rejectionReason: action.rejectionReason,
    };
    let latest: PurchaseWorkflowRecord;
    try {
      latest = await this.getManagerDecisionRecord(action.recordId);
    } catch (error) {
      if (action.attempts < TASK_MAX_ATTEMPTS) {
        await this.store.rescheduleManagerApprovalAction(
          action.key,
          action.claimToken,
          error,
          nextTaskAttemptAt(action.attempts, now),
          now,
        );
      } else {
        await this.moveActionToManual(action, error, now, result);
      }
      recordTaskFailure(result, action.key, error);
      return false;
    }

    if (action.choice !== 'reject') {
      try {
        decision = {
          ...decision,
          purchaser: await this.resolveManagerDecisionPurchaser(
            latest,
            action.choice,
          ),
        };
      } catch (error) {
        if (action.attempts < TASK_MAX_ATTEMPTS) {
          await this.store.rescheduleManagerApprovalAction(
            action.key,
            action.claimToken,
            error,
            nextTaskAttemptAt(action.attempts, now),
            now,
          );
        } else {
          await this.moveActionToManual(action, error, now, result);
        }
        recordTaskFailure(result, action.key, error);
        return false;
      }
    }

    let patch: ReturnType<typeof buildPurchaseManagerApprovalPatch>;
    try {
      patch = buildPurchaseManagerApprovalPatch(latest, decision);
    } catch (error) {
      await this.moveActionToManual(action, error, now, result);
      recordTaskFailure(result, action.key, error);
      return false;
    }
    if (isManagerApprovalTargetApplied(latest, decision)) {
      await this.store.completeManagerApprovalActionAndEnqueueResolved(
        action.key,
        action.claimToken,
        now,
      );
      return true;
    }

    try {
      await this.updateManagerDecisionRecord(action.recordId, patch);
      await this.store.completeManagerApprovalActionAndEnqueueResolved(
        action.key,
        action.claimToken,
        now,
      );
      return true;
    } catch (writeError) {
      let observed: PurchaseWorkflowRecord;
      try {
        observed = await this.getManagerDecisionRecord(action.recordId);
      } catch (readError) {
        const ambiguous = new Error(
          `Base 写入结果未知，复核读取失败：${safeErrorMessage(readError)}`,
        );
        if (action.attempts < TASK_MAX_ATTEMPTS) {
          await this.store.rescheduleManagerApprovalAction(
            action.key,
            action.claimToken,
            ambiguous,
            nextTaskAttemptAt(action.attempts, now),
            now,
          );
        } else {
          await this.moveActionToManual(action, ambiguous, now, result);
        }
        recordTaskFailure(result, action.key, ambiguous);
        return false;
      }
      if (isManagerApprovalTargetApplied(observed, decision)) {
        await this.store.completeManagerApprovalActionAndEnqueueResolved(
          action.key,
          action.claimToken,
          now,
        );
        return true;
      }
      try {
        buildPurchaseManagerApprovalPatch(observed, decision);
      } catch {
        const ambiguous = new Error(
          `Base 写入结果与目标不一致：${safeErrorMessage(writeError)}`,
        );
        await this.moveActionToManual(action, ambiguous, now, result);
        recordTaskFailure(result, action.key, ambiguous);
        return false;
      }
      if (observed.status !== DECISION_PRE_STATE) {
        const ambiguous = new Error('Base 写入后记录已离开待审批状态');
        await this.moveActionToManual(action, ambiguous, now, result);
        recordTaskFailure(result, action.key, ambiguous);
        return false;
      }
      if (action.attempts >= TASK_MAX_ATTEMPTS) {
        await this.store.failManagerApprovalActionAndEnqueueReopen(
          action.key,
          action.claimToken,
          writeError,
          now,
        );
      } else {
        await this.store.rescheduleManagerApprovalAction(
          action.key,
          action.claimToken,
          writeError,
          nextTaskAttemptAt(action.attempts, now),
          now,
        );
      }
      recordTaskFailure(result, action.key, writeError);
      return false;
    }
  }

  private async processBatchAction(
    action: PurchaseManagerApprovalBatchActionEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let recordAttempts = action.attempts;
    for (const recordId of action.recordIds) {
      const batch = await this.store.findManagerApprovalBatch(
        action.approvalBatchId,
      );
      const item = batch?.items.find(
        (candidate) => candidate.executionRecordId === recordId,
      );
      if (!batch || !item) {
        const error = new ConflictException('采购批次审批明细不存在');
        await this.store.markManagerApprovalBatchActionRecordManual(
          action.key,
          action.claimToken,
          recordId,
          error,
          now,
        );
        recordAttempts = 0;
        recordTaskFailure(result, action.key, error);
        continue;
      }
      if (item.status !== 'processing') continue;

      let latest: PurchaseWorkflowRecord;
      try {
        latest = await this.getManagerDecisionRecord(recordId);
      } catch (error) {
        if (recordAttempts < TASK_MAX_ATTEMPTS) {
          await this.store.rescheduleManagerApprovalBatchAction(
            action.key,
            action.claimToken,
            error,
            nextTaskAttemptAt(recordAttempts, now),
            now,
          );
        } else {
          await this.store.markManagerApprovalBatchActionRecordManual(
            action.key,
            action.claimToken,
            recordId,
            error,
            now,
          );
          recordAttempts = 0;
          result.manualReconciliation += 1;
          result.alerts.push(`${action.key}:${recordId}: 需人工核对`);
          recordTaskFailure(result, action.key, error);
          continue;
        }
        recordTaskFailure(result, action.key, error);
        return false;
      }

      let purchaser: PurchaseWorkflowUser | undefined;
      try {
        purchaser = await this.resolveManagerDecisionPurchaser(
            latest,
            action.choice,
          );
      } catch (error) {
        if (recordAttempts < TASK_MAX_ATTEMPTS) {
          await this.store.rescheduleManagerApprovalBatchAction(
            action.key,
            action.claimToken,
            error,
            nextTaskAttemptAt(recordAttempts, now),
            now,
          );
        } else {
          await this.store.markManagerApprovalBatchActionRecordManual(
            action.key,
            action.claimToken,
            recordId,
            error,
            now,
          );
          recordAttempts = 0;
          result.manualReconciliation += 1;
          recordTaskFailure(result, action.key, error);
          continue;
        }
        recordTaskFailure(result, action.key, error);
        return false;
      }
      const decision = {
        choice: action.choice,
        rejectionReason: action.rejectionReason,
        purchaser,
      };
      let patch: Record<string, unknown>;
      try {
        patch = {
          ...buildPurchaseManagerApprovalPatch(latest, decision),
          ...buildPurchaseManagerResolvedFields({
            choice: action.choice,
            actorOpenId: action.actorOpenId,
            eventId: action.eventId,
            approvalTime: now,
          }),
        };
      } catch (error) {
        await this.store.markManagerApprovalBatchActionRecordManual(
          action.key,
          action.claimToken,
          recordId,
          error,
          now,
        );
        recordAttempts = 0;
        result.manualReconciliation += 1;
        result.alerts.push(`${action.key}:${recordId}: 需人工核对`);
        recordTaskFailure(result, action.key, error);
        continue;
      }
      if (isManagerApprovalTargetApplied(latest, decision)) {
        await this.store.completeManagerApprovalBatchActionRecord(
          action.key,
          action.claimToken,
          recordId,
          purchaser
            ? {
                purchaserOpenId: purchaser.openId,
                purchaserName: purchaser.name,
                authorityTarget: purchaseAuthorityTarget(latest),
              }
            : undefined,
          now,
        );
        recordAttempts = 0;
        continue;
      }

      try {
        await this.updateManagerDecisionRecord(recordId, patch);
        await this.store.completeManagerApprovalBatchActionRecord(
          action.key,
          action.claimToken,
          recordId,
          purchaser
            ? {
                purchaserOpenId: purchaser.openId,
                purchaserName: purchaser.name,
                authorityTarget: purchaseAuthorityTarget(latest),
              }
            : undefined,
          now,
        );
        recordAttempts = 0;
      } catch (writeError) {
        let observed: PurchaseWorkflowRecord;
        try {
          observed = await this.getManagerDecisionRecord(recordId);
        } catch (readError) {
          const ambiguous = new Error(
            `Base 写入结果未知，复核读取失败：${safeErrorMessage(readError)}`,
          );
          if (recordAttempts < TASK_MAX_ATTEMPTS) {
            await this.store.rescheduleManagerApprovalBatchAction(
              action.key,
              action.claimToken,
              ambiguous,
              nextTaskAttemptAt(recordAttempts, now),
              now,
            );
            recordTaskFailure(result, action.key, ambiguous);
            return false;
          }
          await this.store.markManagerApprovalBatchActionRecordManual(
            action.key,
            action.claimToken,
            recordId,
            ambiguous,
            now,
          );
          recordAttempts = 0;
          result.manualReconciliation += 1;
          result.alerts.push(`${action.key}:${recordId}: 需人工核对`);
          recordTaskFailure(result, action.key, ambiguous);
          continue;
        }
        if (isManagerApprovalTargetApplied(observed, decision)) {
          await this.store.completeManagerApprovalBatchActionRecord(
            action.key,
            action.claimToken,
            recordId,
            purchaser
              ? {
                  purchaserOpenId: purchaser.openId,
                  purchaserName: purchaser.name,
                  authorityTarget: purchaseAuthorityTarget(latest),
                }
              : undefined,
            now,
          );
          recordAttempts = 0;
          continue;
        }
        try {
          buildPurchaseManagerApprovalPatch(observed, decision);
        } catch {
          const ambiguous = new Error(
            `Base 写入结果与目标不一致：${safeErrorMessage(writeError)}`,
          );
          await this.store.markManagerApprovalBatchActionRecordManual(
            action.key,
            action.claimToken,
            recordId,
            ambiguous,
            now,
          );
          recordAttempts = 0;
          result.manualReconciliation += 1;
          result.alerts.push(`${action.key}:${recordId}: 需人工核对`);
          recordTaskFailure(result, action.key, ambiguous);
          continue;
        }
        if (observed.status !== DECISION_PRE_STATE) {
          const ambiguous = new Error('Base 写入后记录已离开待审批状态');
          await this.store.markManagerApprovalBatchActionRecordManual(
            action.key,
            action.claimToken,
            recordId,
            ambiguous,
            now,
          );
          recordAttempts = 0;
          result.manualReconciliation += 1;
          result.alerts.push(`${action.key}:${recordId}: 需人工核对`);
          recordTaskFailure(result, action.key, ambiguous);
          continue;
        }
        if (recordAttempts >= TASK_MAX_ATTEMPTS) {
          await this.store.failManagerApprovalBatchActionAndEnqueueRefresh(
            action.key,
            action.claimToken,
            writeError,
            now,
          );
        } else {
          await this.store.rescheduleManagerApprovalBatchAction(
            action.key,
            action.claimToken,
            writeError,
            nextTaskAttemptAt(recordAttempts, now),
            now,
          );
        }
        recordTaskFailure(result, action.key, writeError);
        return false;
      }
    }
    return true;
  }

  private async moveActionToManual(
    action: PurchaseManagerApprovalActionEntry,
    error: unknown,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<void> {
    await this.store.markManagerApprovalManualReconciliation(
      action.key,
      action.claimToken,
      error,
      now,
    );
    result.manualReconciliation += 1;
    result.alerts.push(`${action.key}: 需人工核对`);
  }

  private async processNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    if (notification.kind === 'manager_batch_executor_transferred') {
      try {
        const context = parsePurchaseManagerBatchApprovalCardContext(notification.cardContext);
        const batch = await this.store.findManagerApprovalBatch(context.approvalBatchId);
        const item = batch?.items.find(row => row.executionRecordId === notification.recordId), marker = item?.executorHandover;
        if (!marker || marker.notificationKey !== notification.key || marker.appId !== process.env.FEISHU_APP_ID?.trim() || marker.ready) throw new ConflictException('采购原执行交接任务身份已变化');
        this.assertCurrentManagerActor(marker.targetOpenId, marker.scope.building, item!.choice === 'building_self' ? 'building_executor' : 'purchase_executor', marker.scope.specialty);
        await this.gateway.writePurchaseExecutorHandover(marker);
        await this.store.completeExecutorHandover(notification.key, notification.claimToken, now);
        return true;
      } catch (error) { await this.retryOrFailNotification(notification, error, now); recordTaskFailure(result, notification.key, error); return false; }
    }
    if(notification.kind==='manager_approval_transferred'){
      try{
        const card=await this.store.findManagerApprovalCard(notification.messageId,notification.recipientOpenId);
        if(!card?.personnelHandover||card.personnelHandover.terminalNotificationKey!==notification.key||card.executionRecordId!==notification.recordId)throw new ConflictException('采购原卡交接标记不一致');
        await this.gateway.updateInteractiveCard(requireMessageId(card.messageId),buildPurchaseManagerTransferredCard(parsePurchaseManagerApprovalCardContext(card.cardContext)));
        await this.store.recordPurchaseBatchCardUpdateCompleted(notification.key,notification.claimToken,card.messageId,now);
        await this.store.completeNotification(notification.key,notification.claimToken,{messageId:card.messageId},now);return true;
      }catch(error){await this.retryOrFailNotification(notification,error,now);recordTaskFailure(result,notification.key,error);return false;}
    }
    if (notification.kind === 'manager_approval_requested') {
      return this.processRequestedNotification(notification, now, result);
    }
    if (notification.kind === 'manager_batch_approval_requested') {
      return this.processBatchRequestedNotification(notification, now, result);
    }
    if (notification.kind === 'manager_batch_receipt_attachment') {
      return this.processPurchaseReceiptAttachment(notification, now, result);
    }
    if (
      notification.kind === 'manager_batch_order_command' ||
      notification.kind === 'manager_batch_receipt_command'
    ) {
      return this.processPurchaseBatchFulfillmentCommand(
        notification,
        now,
        result,
      );
    }
    if (notification.kind === 'manager_batch_receipt_completed') {
      return this.processPurchaseBatchReceiptCompletedNotification(
        notification,
        now,
        result,
      );
    }
    if (
      notification.kind === 'manager_batch_purchase_assigned' ||
      notification.kind === 'manager_batch_purchase_refresh' ||
      notification.kind === 'manager_batch_receipt_requested' ||
      notification.kind === 'manager_batch_receipt_refresh'
    ) {
      return this.processPurchaseBatchFulfillmentNotification(
        notification,
        now,
        result,
      );
    }
    if (
      notification.kind === 'manager_batch_approval_refresh' ||
      notification.kind === 'manager_batch_approval_result' ||
      notification.kind === 'manager_batch_approval_attention_required'
    ) {
      return this.processBatchStateNotification(notification, now, result);
    }
    if (
      notification.kind === 'manager_approval_resolved' ||
      notification.kind === 'manager_approval_reopened' ||
      notification.kind === 'manager_approval_attention_required'
    ) {
      return this.processCardUpdateNotification(notification, now, result);
    }
    const error = new ConflictException('经理审批 worker 收到非经理通知');
    await this.retryOrFailNotification(notification, error, now);
    recordTaskFailure(result, notification.key, error);
    return false;
  }

  private async processPurchaseReceiptAttachment(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    try {
      const context = parsePurchaseReceiptAttachmentContext(
        notification.cardContext,
      );
      const file = await this.gateway.downloadMessageImage(
        context.imageMessageId,
        context.imageKey,
      );
      const token = await this.gateway.uploadAttachment(
        file,
        await this.gateway.getTenantAccessTokenAsApp(),
      );
      const batch = await this.store.stagePurchaseBatchAttachments({
        approvalBatchId: context.approvalBatchId,
        executionRecordId: context.executionRecordId,
        actorOpenId: context.actorOpenId,
        purpose: 'receipt',
        ...(context.materialType === 'invoice'
          ? { invoiceTokens: [token] }
          : { receiptPhotoTokens: [token] }),
      });
      await this.store.enqueueNotification({
        businessEventId: `manager_batch_receipt_refresh:${context.approvalBatchId}:${context.executionRecordId}:${notification.businessEventId}`,
        recordId: context.executionRecordId,
        recipientOpenId: context.actorOpenId,
        kind: 'manager_batch_receipt_refresh',
        cardContext: batch.cardContext,
      });
      await this.store.completeNotification(
        notification.key,
        notification.claimToken,
        now,
      );
      return true;
    } catch (error) {
      if (notification.attempts < TASK_MAX_ATTEMPTS) {
        await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
      } else {
        await this.store.failNotification(
          notification.key,
          notification.claimToken,
          error,
          now,
        );
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async processBatchRequestedNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let outboundAnchored = false;
    let routedBatch: PurchaseManagerApprovalBatchEntry | null = null;
    let records: PurchaseWorkflowRecord[] = [];
    let handoverRecordIds: string[] | null = null;
    try {
      const approvalBatchId = parseBatchIdFromNotification(
        notification,
        'manager_batch_approval_requested',
      );
      const canonical = await this.store.findManagerApprovalBatch(approvalBatchId);
      const batch = canonical && managerBatchCardView(canonical, notification.recipientOpenId);
      if (!batch || batch.messageId || batch.sourceNotificationKey !== notification.key) {
        throw new ConflictException('采购批次审批发卡台账状态异常');
      }
      routedBatch = batch;
      if (/:h-[a-f0-9]{32}$/u.test(notification.businessEventId)) {
        const receipt = (await this.store.listPersonnelHandovers()).find(job => job.status === 'completed' &&
          job.approvalBatchId === batch.approvalBatchId && notification.businessEventId.endsWith(`:h-${job.mutationId.slice(-32)}`) &&
          job.target.openId === batch.recipientOpenId && notification.key === batch.sourceNotificationKey);
        if (!receipt || !notification.cardContext) throw new ConflictException('采购交接投递缺少正式回执或原卡快照');
        handoverRecordIds = receipt.pendingRecordIds;
        assertFeishuBusinessIdentity(this.accessConfiguration, notification.recipientOpenId);
      }
      for (const recordId of batch.cardContext ? [] : batch.recordIds) {
        if (handoverRecordIds && !handoverRecordIds.includes(recordId)) continue;
        const latest = await this.gateway.getExecutionRecordAsApp(recordId);
        if (latest.status !== DECISION_PRE_STATE) {
          throw new ConflictException('采购申请已离开待审批状态');
        }
        records.push(latest);
      }
      const applicationCreatedAt =
        this.submissionTaskLedger?.findByTaskId(approvalBatchId)?.task
          .createdAt || batch.createdAt;
      const savedContext = batch.cardContext || notification.cardContext;
      const input = savedContext
        ? parsePurchaseManagerBatchApprovalCardContext(savedContext)
        : toManagerBatchApprovalCardInput(batch, records, applicationCreatedAt);
      const context = serializePurchaseManagerBatchApprovalCardContext(input);
      const anchored = await this.store.markManagerApprovalBatchSendStarted(
        notification.key,
        notification.claimToken,
        context,
        now,
      );
      if (!anchored) {
        throw new ConflictException('采购批次审批发卡任务不存在');
      }
      outboundAnchored = true;
      const messageId = await this.gateway.sendInteractiveCard(
        notification.recipientOpenId,
        batch.state === 'awaiting_delivery' ? buildPurchaseManagerBatchApprovalCard(input) : renderManagerApprovalBatch({ ...batch, cardContext: context }),
        anchored.deliveryUuid,
      );
      const completed =
        await this.store.completeManagerApprovalBatchRequestAndRegisterCard(
          notification.key,
          notification.claimToken,
          { messageId },
          now,
        );
      if (batch.recipientOpenId === managerBatchDeliveries(batch)[0]!.recipientOpenId &&
        ['active', 'reject_editing'].includes(completed.batch.state)) await this.updateProgramApprovalFieldsBestEffort(
        handoverRecordIds || batch.recordIds,
        (handoverRecordIds ? handoverDeliveryMetadata : (fields: Record<string, unknown>) => fields)(buildPurchaseManagerDeliveredFields({
          approvalBatchId: batch.approvalBatchId,
          managerOpenId: batch.recipientOpenId,
          managerOpenIds: managerBatchDeliveries(batch).map(delivery => delivery.recipientOpenId),
          deliveryUuid: completed.notification.deliveryUuid,
          deliveryAttempts: completed.notification.attempts,
          deliveredAt: now,
          messageId: completed.notification.messageId,
        })),
        'manager-approval-delivery-confirmed',
        result,
      );
      return true;
    } catch (error) {
      let failedNotification: PurchaseWorkflowNotificationEntry | null = null;
      if (outboundAnchored && isDefinitiveFeishuDeliveryRejection(error)) {
        failedNotification = await this.store.recordManagerCardRejectedSend(
          notification.key,
          notification.claimToken,
          error,
          notification.attempts < TASK_MAX_ATTEMPTS
            ? nextTaskAttemptAt(notification.attempts, now)
            : null,
          now,
        );
      } else if (
        outboundAnchored ||
        notification.attempts < TASK_MAX_ATTEMPTS
      ) {
        failedNotification = await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
      } else {
        failedNotification = await this.store.failNotification(
          notification.key,
          notification.claimToken,
          error,
          now,
        );
      }
      if (routedBatch && routedBatch.recipientOpenId === managerBatchDeliveries(routedBatch)[0]!.recipientOpenId &&
        ['awaiting_delivery', 'active', 'reject_editing'].includes(routedBatch.state)) {
        await this.updateProgramApprovalFieldsBestEffort(
          handoverRecordIds || routedBatch.recordIds,
          (handoverRecordIds ? handoverDeliveryMetadata : (fields: Record<string, unknown>) => fields)(buildManagerBatchDeliverySnapshotFields(
            routedBatch,
            failedNotification || notification,
            now,
            safeErrorMessage(error),
          )),
          'manager-approval-delivery-error',
          result,
        );
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async updateProgramApprovalFieldsBestEffort(
    recordIds: readonly string[],
    fields: Record<string, unknown>,
    operation: string,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<void> {
    for (const recordId of recordIds) {
      try {
        await this.gateway.updateExecutionRecordAsApp(recordId, fields);
      } catch (error) {
        recordTaskFailure(result, `${operation}:${recordId}`, error);
      }
    }
  }

  private async updateProgramApprovalFieldsStrict(
    recordIds: readonly string[],
    fields: Record<string, unknown>,
  ): Promise<void> {
    for (const recordId of recordIds) {
      await this.gateway.updateExecutionRecordAsApp(recordId, fields);
    }
  }

  private async markBaseReceiptDeliveryManualReview(
    recordIds: readonly string[],
    batchId: string,
    records: readonly PurchaseWorkflowRecord[],
    errorMessage: string,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<void> {
    const deliveryUuids = [
      ...new Set(
        records
          .map((record) => record.receiptCardDeliveryUuid?.trim() || '')
          .filter(Boolean),
      ),
    ];
    const lastAttemptValues = records
      .map((record) => record.receiptCardLastAttemptAt)
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value > 0,
      );
    const fields: Record<string, unknown> = {
      [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptBatchId]: batchId,
      [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState]: '送达待核对',
      [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryAttempts]: Math.max(
        0,
        ...records.map((record) => record.receiptCardDeliveryAttempts || 0),
      ),
      [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryError]:
        errorMessage.slice(0, 500),
    };
    if (deliveryUuids.length === 1) {
      fields[PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryUuid] =
        deliveryUuids[0];
    }
    if (lastAttemptValues.length) {
      fields[PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryLastAttemptAt] =
        Math.max(...lastAttemptValues);
    }
    await this.updateProgramApprovalFieldsBestEffort(
      recordIds,
      fields,
      'purchase-receipt-delivery-manual-review',
      result,
    );
  }

  private async markManualManagerDeliveryBestEffort(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<void> {
    try {
      if (notification.kind === 'manager_batch_receipt_requested') {
        const approvalBatchId = notification.businessEventId.replace(
          /^manager_batch_receipt_requested:/u,
          '',
        );
        const batch =
          await this.store.findManagerApprovalBatch(approvalBatchId);
        if (!batch) {
          throw new ConflictException('采购签收发卡台账不存在');
        }
        await this.updateProgramApprovalFieldsBestEffort(
          batch.items
            .filter((item) => item.status === 'approved')
            .map((item) => item.executionRecordId),
          buildReceiptDeliverySnapshotFields(notification, now),
          'purchase-receipt-delivery-manual-review',
          result,
        );
        return;
      }
      if (notification.kind !== 'manager_batch_approval_requested') return;
      const approvalBatchId = parseBatchIdFromNotification(
        notification,
        'manager_batch_approval_requested',
      );
      const batch = await this.store.findManagerApprovalBatch(approvalBatchId);
      if (!batch) {
        throw new ConflictException('采购批次审批发卡台账不存在');
      }
      if (notification.recipientOpenId !== managerBatchDeliveries(batch)[0]!.recipientOpenId ||
        !['awaiting_delivery', 'active', 'reject_editing'].includes(batch.state)) return;
      await this.updateProgramApprovalFieldsBestEffort(
        batch.recordIds,
        buildManagerBatchDeliverySnapshotFields(batch, notification, now),
        'manager-approval-delivery-manual-review',
        result,
      );
    } catch (error) {
      recordTaskFailure(
        result,
        `manager-approval-delivery-manual-review:${notification.key}`,
        error,
      );
    }
  }

  private async processBatchStateNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let outboundAnchored = false;
    try {
      const context = parsePurchaseManagerBatchApprovalCardContext(
        notification.cardContext,
      );
      const batch = await this.store.findManagerApprovalBatch(
        context.approvalBatchId,
      );
      if (!batch) throw new ConflictException('采购批次审批台账不存在');
      const view = notification.kind === 'manager_batch_approval_result' ? batch : managerBatchCardView(batch, notification.recipientOpenId);
      const card = renderManagerApprovalBatch(view);
      if (notification.kind === 'manager_batch_approval_result') {
        const anchored = await this.store.markManagerApprovalBatchSendStarted(
          notification.key,
          notification.claimToken,
          batch.cardContext,
          now,
        );
        if (!anchored) {
          throw new ConflictException('采购批次审批结果通知不存在');
        }
        outboundAnchored = true;
        const messageId = await this.gateway.sendInteractiveCard(
          notification.recipientOpenId,
          card,
          anchored.deliveryUuid,
        );
        await this.store.completeNotification(
          notification.key,
          notification.claimToken,
          { messageId },
          now,
        );
        return true;
      }
      await this.gateway.updateInteractiveCard(
        requireMessageId(view.messageId),
        card,
      );
      await this.store.completeNotification(
        notification.key,
        notification.claimToken,
        { messageId: view.messageId },
        now,
      );
      return true;
    } catch (error) {
      if (outboundAnchored && isDefinitiveFeishuDeliveryRejection(error)) {
        await this.store.recordManagerCardRejectedSend(
          notification.key,
          notification.claimToken,
          error,
          notification.attempts < TASK_MAX_ATTEMPTS
            ? nextTaskAttemptAt(notification.attempts, now)
            : null,
          now,
        );
      } else if (
        outboundAnchored || notification.kind !== 'manager_batch_approval_result' ||
        notification.attempts < TASK_MAX_ATTEMPTS
      ) {
        await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
      } else {
        await this.store.failNotification(
          notification.key,
          notification.claimToken,
          error,
          now,
        );
        result.alerts.push(`${notification.key}: 批次审批卡展示更新失败`);
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async processPurchaseBatchFulfillmentCommand(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let failureRefresh: PurchaseWorkflowNotificationInput | null = null;
    try {
      if (!this.workflowService) {
        throw new ConflictException('采购履约服务未装配');
      }
      const context = parsePurchaseBatchFulfillmentCommandContext(
        notification.cardContext,
      );
      let proof=notification.acceptedAppId?{notificationKey:notification.key,claimToken:notification.claimToken}:undefined;
      if(!proof&&typeof this.store.bindLegacyFulfillmentApplication==='function'){
        const appId=process.env.FEISHU_APP_ID?.trim()||'',record=await this.gateway.getExecutionRecordAsApp(context.executionRecordId);
        proof={notificationKey:notification.key,claimToken:notification.claimToken};await this.store.bindLegacyFulfillmentApplication(proof,record,appId);
      }
      const batch = await this.store.findManagerApprovalBatch(
        context.approvalBatchId,
      );
      if (!batch) throw new ConflictException('采购履约批次不存在');
      failureRefresh = {
        businessEventId: `${
          context.action === 'order'
            ? 'manager_batch_purchase_refresh'
            : 'manager_batch_receipt_refresh'
        }:failed:${shortStableId(notification.key)}`,
        recordId: context.executionRecordId,
        recipientOpenId:
          context.action === 'order'
            ? context.actorOpenId
            : batch.requesterOpenId,
        kind:
          context.action === 'order'
            ? 'manager_batch_purchase_refresh'
            : 'manager_batch_receipt_refresh',
        cardContext: batch.cardContext,
      };
      if (context.action === 'order') {
        await this.workflowService.orderFromCard(
          context.executionRecordId,
          context.actorOpenId,
          {
            actualQuantity: context.actualQuantity,
            actualAmount: context.actualAmount,
            paymentAttachmentTokens: [...context.paymentAttachmentTokens],
            note: context.note,
          },
          ...(proof?[proof] as const:[] as const),
        );
      } else {
        const signer = await this.gateway.resolveUserAsApp(
          context.signerOpenId,
        );
        if (!signer.name) {
          throw new ConflictException('签收人未在采购组织架构中找到');
        }
        await this.workflowService.receiveFromCard(
          context.executionRecordId,
          context.actorOpenId,
          {
            signer: signer.name,
            signerOpenId: signer.openId,
            receiptTime: context.receiptTime,
            receiptPhotoTokens: [...context.receiptPhotoTokens],
            invoiceTokens: [...context.invoiceTokens],
            note: context.note,
          },
          ...(proof?[proof] as const:[] as const),
        );
      }

      const followUps: Array<{
        businessEventId: string;
        recordId: string;
        recipientOpenId: string;
        kind:
          | 'manager_batch_purchase_refresh'
          | 'manager_batch_receipt_requested'
          | 'manager_batch_receipt_refresh'
          | 'manager_batch_receipt_completed';
        cardContext: string;
      }> = [];
      if (context.action === 'order') {
        followUps.push(
          {
            businessEventId: `manager_batch_purchase_refresh:${batch.approvalBatchId}:${context.executionRecordId}`,
            recordId: context.executionRecordId,
            recipientOpenId: context.actorOpenId,
            kind: 'manager_batch_purchase_refresh',
            cardContext: batch.cardContext,
          },
          {
            businessEventId: `manager_batch_receipt_requested:${batch.approvalBatchId}`,
            recordId: batch.recordIds[0]!,
            recipientOpenId: batch.requesterOpenId,
            kind: 'manager_batch_receipt_requested',
            cardContext: batch.cardContext,
          },
          {
            businessEventId: `manager_batch_receipt_refresh:${batch.approvalBatchId}:${context.executionRecordId}`,
            recordId: context.executionRecordId,
            recipientOpenId: batch.requesterOpenId,
            kind: 'manager_batch_receipt_refresh',
            cardContext: batch.cardContext,
          },
        );
      } else {
        followUps.push({
          businessEventId: `manager_batch_receipt_refresh:${batch.approvalBatchId}:${context.executionRecordId}:completed`,
          recordId: context.executionRecordId,
          recipientOpenId: batch.requesterOpenId,
          kind: 'manager_batch_receipt_refresh',
          cardContext: batch.cardContext,
        });
        const batchItem = batch.items.find(
          (item) =>
            item.executionRecordId === context.executionRecordId &&
            item.status === 'approved',
        );
        if (!batchItem?.purchaserOpenId) {
          throw new ConflictException('采购签收明细缺少采购人');
        }
        if (batchItem.purchaserOpenId !== batch.requesterOpenId) {
          followUps.push({
            businessEventId: `manager_batch_receipt_completed:${batch.approvalBatchId}:${context.executionRecordId}`,
            recordId: context.executionRecordId,
            recipientOpenId: batchItem.purchaserOpenId,
            kind: 'manager_batch_receipt_completed',
            cardContext: batch.cardContext,
          });
        }
      }
      await this.store.completePurchaseBatchFulfillmentCommandAndEnqueue(
        notification.key,
        notification.claimToken,
        followUps,
        now,
      );
      return true;
    } catch (error) {
      if (notification.attempts < TASK_MAX_ATTEMPTS) {
        await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
      } else {
        if (failureRefresh) {
          await this.store.failPurchaseBatchFulfillmentCommandAndEnqueueRefresh(
            notification.key,
            notification.claimToken,
            error,
            failureRefresh,
            now,
          );
        } else {
          await this.store.failNotification(
            notification.key,
            notification.claimToken,
            error,
            now,
          );
        }
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async processPurchaseBatchReceiptCompletedNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let outboundAnchored = false;
    try {
      const context = parsePurchaseManagerBatchApprovalCardContext(
        notification.cardContext,
      );
      const expectedBusinessEventId = `manager_batch_receipt_completed:${context.approvalBatchId}:${notification.recordId}`;
      if (notification.businessEventId !== expectedBusinessEventId) {
        throw new ConflictException('采购签收完成通知业务键无效');
      }
      const batch = await this.store.findManagerApprovalBatch(
        context.approvalBatchId,
      );
      if (!batch) throw new ConflictException('采购履约批次不存在');
      const batchItem = batch.items.find(
        (item) =>
          item.executionRecordId === notification.recordId &&
          item.status === 'approved',
      );
      if (
        !batchItem ||
        !batchItem.purchaserOpenId ||
        batchItem.purchaserOpenId !== notification.recipientOpenId
      ) {
        throw new ConflictException('采购签收完成通知采购人不匹配');
      }
      const cardItem = context.items.find(
        (item) => item.executionRecordId === notification.recordId,
      );
      if (!cardItem) {
        throw new ConflictException('采购签收完成通知明细不存在');
      }
      const record = await this.gateway.getExecutionRecordAsApp(
        notification.recordId,
      );
      if (
        !['inbound', 'completed'].includes(
          resolvePurchaseStage(record.status),
        ) ||
        !record.signer ||
        !record.receiptTime
      ) {
        throw new ConflictException('采购签收完成通知缺少有效签收结果');
      }
      const card = buildPurchaseBatchReceiptCompletedCard({
        requestCode: context.requestCode,
        requesterName: context.requesterName,
        building: context.building,
        itemTitle: cardItem.title,
        purchaseMethod:
          record.purchaseMethod || purchaseMethodForBatchItem(batchItem.choice),
        purchaserName:
          record.purchaserName ||
          batchItem.purchaserName ||
          notification.recipientOpenId,
        signerName: record.signer,
        receiptTime: formatPurchaseBatchCardDateTime(record.receiptTime) || '-',
      });
      const anchored = await this.store.markManagerApprovalBatchSendStarted(
        notification.key,
        notification.claimToken,
        batch.cardContext,
        now,
      );
      if (!anchored) {
        throw new ConflictException('采购签收完成通知任务不存在');
      }
      outboundAnchored = true;
      const messageId = await this.gateway.sendInteractiveCard(
        notification.recipientOpenId,
        card,
        anchored.deliveryUuid,
      );
      await this.store.completeNotification(
        notification.key,
        notification.claimToken,
        { messageId },
        now,
      );
      return true;
    } catch (error) {
      if (outboundAnchored && isDefinitiveFeishuDeliveryRejection(error)) {
        await this.store.recordManagerCardRejectedSend(
          notification.key,
          notification.claimToken,
          error,
          notification.attempts < TASK_MAX_ATTEMPTS
            ? nextTaskAttemptAt(notification.attempts, now)
            : null,
          now,
        );
      } else if (
        outboundAnchored ||
        notification.attempts < TASK_MAX_ATTEMPTS
      ) {
        await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
      } else {
        await this.store.failNotification(
          notification.key,
          notification.claimToken,
          error,
          now,
        );
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async processPurchaseBatchFulfillmentNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let outboundAnchored = false;
    let receiptDeliveryRecordIds: string[] = [];
    try {
      const context = parsePurchaseManagerBatchApprovalCardContext(
        notification.cardContext,
      );
      const batch = await this.store.findManagerApprovalBatch(
        context.approvalBatchId,
      );
      if (!batch) throw new ConflictException('采购履约批次不存在');
      const isPurchaseCard =
        notification.kind === 'manager_batch_purchase_assigned' ||
        notification.kind === 'manager_batch_purchase_refresh';
      const fulfillmentRecords = await this.loadPurchaseBatchRecords(batch);
      const receiptRecords = isPurchaseCard ? undefined : fulfillmentRecords;
      if (receiptRecords) {
        const approved = new Set(
          batch.items
            .filter((item) => item.status === 'approved')
            .map((item) => item.executionRecordId),
        );
        receiptDeliveryRecordIds = [...receiptRecords.values()]
          .filter(
            (record) =>
              approved.has(record.recordId) &&
              ['receipt', 'inbound', 'completed'].includes(
                resolvePurchaseStage(record.status),
              ),
          )
          .map((record) => record.recordId);
      }
      const card = isPurchaseCard
        ? await this.renderPurchaseBatchPurchaserCard(
            batch,
            notification.recipientOpenId,
            undefined,
            'base',
            undefined,
            fulfillmentRecords,
          )
        : await this.renderPurchaseBatchReceiptCard(
            batch,
            undefined,
            'base',
            receiptRecords,
          );
      const isInitialDelivery =
        notification.kind === 'manager_batch_purchase_assigned' ||
        notification.kind === 'manager_batch_receipt_requested';
      if (isInitialDelivery) {
        if (notification.kind === 'manager_batch_receipt_requested') {
          if (!receiptDeliveryRecordIds.length) {
            throw new ConflictException('采购签收卡没有可写入投递围栏的明细');
          }
          await this.updateProgramApprovalFieldsStrict(
            receiptDeliveryRecordIds,
            buildReceiptDeliverySnapshotFields(notification, now),
          );
        }
        const anchored = await this.store.markManagerApprovalBatchSendStarted(
          notification.key,
          notification.claimToken,
          batch.cardContext,
          now,
        );
        if (!anchored) throw new ConflictException('采购履约发卡任务不存在');
        outboundAnchored = true;
        const messageId = await this.gateway.sendInteractiveCard(
          notification.recipientOpenId,
          card,
          anchored.deliveryUuid,
        );
        const completed = await this.store.completeNotification(
          notification.key,
          notification.claimToken,
          { messageId },
          now,
        );
        if (
          notification.kind === 'manager_batch_receipt_requested' &&
          completed &&
          receiptDeliveryRecordIds.length
        ) {
          await this.updateProgramApprovalFieldsBestEffort(
            receiptDeliveryRecordIds,
            buildReceiptDeliverySnapshotFields(completed, now),
            'purchase-receipt-delivery-confirmed',
            result,
          );
        }
        return true;
      }

      const sourceKind = isPurchaseCard
        ? 'manager_batch_purchase_assigned'
        : 'manager_batch_receipt_requested';
      const messageIds = await this.findPurchaseBatchCardMessageIds(
        batch,
        sourceKind,
        notification.recipientOpenId,
      );
      const completedMessageIds = new Set(
        notification.deliveryAudit
          .filter((entry) => entry.action === 'card_update_completed')
          .map((entry) => entry.messageId),
      );
      const failures: Array<{ messageId: string; error: unknown }> = [];
      for (const messageId of messageIds) {
        if (completedMessageIds.has(messageId)) continue;
        try {
          const currentCard = isPurchaseCard ? await this.renderPurchaseBatchPurchaserCard(batch, notification.recipientOpenId, undefined, 'base', messageId, fulfillmentRecords) : card;
          await this.gateway.updateInteractiveCard(messageId, currentCard);
          const checkpoint =
            await this.store.recordPurchaseBatchCardUpdateCompleted(
              notification.key,
              notification.claimToken,
              messageId,
              now,
            );
          if (!checkpoint) {
            throw new ConflictException('采购履约卡更新任务不存在');
          }
          completedMessageIds.add(messageId);
        } catch (error) {
          failures.push({ messageId, error });
        }
      }
      if (failures.length) {
        throw new Error(
          `采购履约卡片副本更新失败：${failures
            .map(
              ({ messageId, error }) =>
                `${messageId} ${safeErrorMessage(error)}`,
            )
            .join('；')}`,
        );
      }
      await this.store.completeNotification(
        notification.key,
        notification.claimToken,
        { messageId: messageIds[0] },
        now,
      );
      if (
        notification.kind === 'manager_batch_receipt_refresh' &&
        receiptDeliveryRecordIds.length
      ) {
        const delivered = await this.findDeliveredPurchaseBatchCardNotification(
          batch,
          'manager_batch_receipt_requested',
          notification.recipientOpenId,
        );
        await this.updateProgramApprovalFieldsBestEffort(
          receiptDeliveryRecordIds,
          buildReceiptDeliverySnapshotFields(delivered, now),
          'purchase-receipt-refresh-delivery-confirmed',
          result,
        );
      }
      return true;
    } catch (error) {
      let failedNotification: PurchaseWorkflowNotificationEntry | null = null;
      if (outboundAnchored && isDefinitiveFeishuDeliveryRejection(error)) {
        failedNotification = await this.store.recordManagerCardRejectedSend(
          notification.key,
          notification.claimToken,
          error,
          notification.attempts < TASK_MAX_ATTEMPTS
            ? nextTaskAttemptAt(notification.attempts, now)
            : null,
          now,
        );
      } else if (
        outboundAnchored ||
        notification.attempts < TASK_MAX_ATTEMPTS
      ) {
        failedNotification = await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
      } else {
        failedNotification = await this.store.failNotification(
          notification.key,
          notification.claimToken,
          error,
          now,
        );
      }
      if (
        notification.kind === 'manager_batch_receipt_requested' &&
        failedNotification &&
        receiptDeliveryRecordIds.length
      ) {
        await this.updateProgramApprovalFieldsBestEffort(
          receiptDeliveryRecordIds,
          buildReceiptDeliverySnapshotFields(
            failedNotification,
            now,
            safeErrorMessage(error),
          ),
          'purchase-receipt-delivery-error',
          result,
        );
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async renderPurchaseBatchPurchaserCard(
    batch: PurchaseManagerApprovalBatchEntry,
    purchaserOpenId: string,
    selectedRecordId?: string,
    source: 'base' | 'ledger' = 'base',
    messageId?: string,
    preloadedRecords?: Map<string, PurchaseWorkflowRecord>,
    preloadedNotifications?: PurchaseWorkflowNotificationEntry[],
  ): Promise<Record<string, unknown>> {
    const visibleBatch = messageId ? { ...batch, items: batch.items.map(item => item.executorHandover?.supersededMessageIds.includes(messageId) ? { ...item, purchaserOpenId: '' } : item) } : batch;
    if (!visibleBatch.items.some(item => item.status === 'approved' && item.purchaserOpenId === purchaserOpenId) && batch.items.some(item => item.executorHandover && (item.executorHandover.sourceOpenId === purchaserOpenId || !!messageId && item.executorHandover.supersededMessageIds.includes(messageId)))) return buildPurchaseBatchTransferredCard(parsePurchaseManagerBatchApprovalCardContext(batch.cardContext));
    const records =
      source === 'base'
        ? preloadedRecords || await this.loadPurchaseBatchRecords(batch)
        : new Map<string, PurchaseWorkflowRecord>();
    const commandStates = await this.purchaseBatchCommandSnapshots(
      batch.approvalBatchId,
      'manager_batch_order_command',
      preloadedNotifications,
    );
    const input = toPurchaseBatchPurchaserCardInput(
      visibleBatch,
      parsePurchaseManagerBatchApprovalCardContext(batch.cardContext),
      purchaserOpenId,
      records,
      commandStates,
    );
    const paymentAttachmentUrl =
      selectedRecordId && this.attachmentTicketService
        ? this.attachmentTicketService.issueUrl({
            approvalBatchId: batch.approvalBatchId,
            executionRecordId: selectedRecordId,
            actorOpenId: purchaserOpenId,
            role: 'purchaser',
            purpose: 'payment',
          })
        : undefined;
    return buildPurchaseBatchPurchaserCard(input, {
      selectedRecordId,
      paymentAttachmentUrl,
    });
  }

  private async renderPurchaseBatchReceiptCard(
    batch: PurchaseManagerApprovalBatchEntry,
    selectedRecordId?: string,
    source: 'base' | 'ledger' = 'base',
    preloadedRecords?: Map<string, PurchaseWorkflowRecord>,
    preloadedNotifications?: PurchaseWorkflowNotificationEntry[],
  ): Promise<Record<string, unknown>> {
    const records =
      source === 'base'
        ? preloadedRecords || (await this.loadPurchaseBatchRecords(batch))
        : new Map<string, PurchaseWorkflowRecord>();
    const orderCommands = await this.purchaseBatchCommandSnapshots(
      batch.approvalBatchId,
      'manager_batch_order_command',
      preloadedNotifications,
    );
    const receiptCommands = await this.purchaseBatchCommandSnapshots(
      batch.approvalBatchId,
      'manager_batch_receipt_command',
      preloadedNotifications,
    );
    const input = toPurchaseBatchReceiptCardInput(
      batch,
      parsePurchaseManagerBatchApprovalCardContext(batch.cardContext),
      records,
      orderCommands,
      receiptCommands,
    );
    const webReceipts = preloadedNotifications
      ? preloadedNotifications.filter((entry) => entry.kind === 'web_receipt_command')
      : await this.store.listNotifications({ kind: 'web_receipt_command' });
    for (const item of input.items) {
      const task = webReceipts.find(entry => entry.recordId === item.executionRecordId && entry.webReceipt?.appId === process.env.FEISHU_APP_ID?.trim());
      if (!task?.webReceipt) continue;
      item.receiptState = task.status === 'completed' ? 'completed' : task.status === 'failed' || task.status === 'manual_reconciliation' ? 'manual_reconciliation' : 'processing';
      if (task.status === 'completed') {
        item.signerName = task.webReceipt.input.signer;
        item.receiptTime = formatPurchaseBatchCardDateTime(task.webReceipt.input.receiptTime);
        item.receiptPhotoCount = task.webReceipt.files.filter(file => file.group === 'receiptPhotos').length;
        item.invoiceCount = task.webReceipt.files.filter(file => file.group === 'invoices').length;
      }
    }
    return buildPurchaseBatchReceiptCard(input, {
      selectedRecordId,
    });
  }

  private async loadPurchaseBatchRecords(
    batch: PurchaseManagerApprovalBatchEntry,
  ): Promise<Map<string, PurchaseWorkflowRecord>> {
    const records = new Map<string, PurchaseWorkflowRecord>();
    for (const item of batch.items) {
      if (item.status !== 'approved') continue;
      records.set(
        item.executionRecordId,
        await this.gateway.getExecutionRecordAsApp(item.executionRecordId),
      );
    }
    return records;
  }

  private async purchaseBatchCommandSnapshots(
    approvalBatchId: string,
    kind: 'manager_batch_order_command' | 'manager_batch_receipt_command',
    preloadedNotifications?: PurchaseWorkflowNotificationEntry[],
  ): Promise<Map<string, PurchaseBatchCommandSnapshot>> {
    const result = new Map<string, PurchaseBatchCommandSnapshot>();
    const notifications = preloadedNotifications
      ? preloadedNotifications.filter((entry) => entry.kind === kind)
      : await this.store.listNotifications({ kind });
    for (const notification of notifications) {
      try {
        const context = parsePurchaseBatchFulfillmentCommandContext(
          notification.cardContext,
        );
        if (
          context.approvalBatchId === approvalBatchId &&
          ((kind === 'manager_batch_order_command' &&
            context.action === 'order') ||
            (kind === 'manager_batch_receipt_command' &&
              context.action === 'receipt'))
        ) {
          result.set(context.executionRecordId, {
            status: notification.status,
            context,
          });
        }
      } catch {
        continue;
      }
    }
    return result;
  }

  private async findPurchaseBatchCardMessageIds(
    batch: PurchaseManagerApprovalBatchEntry,
    kind: 'manager_batch_purchase_assigned' | 'manager_batch_receipt_requested',
    recipientOpenId: string,
  ): Promise<string[]> {
    const notifications = await this.store.listNotifications({
      kind,
      status: 'completed',
      recipientOpenId,
    });
    const messageIds = [
      ...new Set(
        notifications
          .filter(
            (entry) =>
              entry.sendOutcome === 'delivered' &&
              entry.cardContext === batch.cardContext,
          )
          .map((entry) => entry.messageId)
          .filter(Boolean),
      ),
    ];
    if (!messageIds.length) {
      throw new ConflictException('采购履约卡片消息映射不存在');
    }
    return messageIds;
  }

  private async findDeliveredPurchaseBatchCardNotification(
    batch: PurchaseManagerApprovalBatchEntry,
    kind: 'manager_batch_purchase_assigned' | 'manager_batch_receipt_requested',
    recipientOpenId: string,
  ): Promise<PurchaseWorkflowNotificationEntry> {
    const notifications = await this.store.listNotifications({
      kind,
      status: 'completed',
      recipientOpenId,
    });
    const delivered = notifications.find(
      (entry) =>
        entry.sendOutcome === 'delivered' &&
        Boolean(entry.messageId) &&
        entry.cardContext === batch.cardContext,
    );
    if (!delivered) {
      throw new ConflictException('采购履约卡片送达台账不存在');
    }
    return delivered;
  }

  private async resolveManagerDecisionPurchaser(
    record: PurchaseWorkflowRecord,
    choice: 'comprehensive' | 'building_self' | 'reject',
  ): Promise<PurchaseWorkflowUser | undefined> {
    if (choice === 'reject') return undefined;
    return choice === 'comprehensive'
      ? this.gateway.resolvePurchaseAdminAsApp({building:record.building,specialty:record.specialty})
      : this.gateway.resolveBuildingSupervisorAsApp(record.building,record.specialty);
  }

  private async getManagerDecisionRecord(
    recordId: string,
  ): Promise<PurchaseWorkflowRecord> {
    const fastRead = (
      this.gateway as unknown as {
        getManagerApprovalDecisionRecordAsApp?: (
          recordId: string,
        ) => Promise<PurchaseWorkflowRecord>;
      }
    ).getManagerApprovalDecisionRecordAsApp;
    return typeof fastRead === 'function'
      ? fastRead.call(this.gateway, recordId)
      : this.gateway.getExecutionRecordAsApp(recordId);
  }

  private async updateManagerDecisionRecord(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const fastWrite = (
      this.gateway as unknown as {
        updateManagerApprovalDecisionRecordAsApp?: (
          recordId: string,
          fields: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).updateManagerApprovalDecisionRecordAsApp;
    if (typeof fastWrite === 'function') {
      await fastWrite.call(this.gateway, recordId, fields);
      return;
    }
    await this.gateway.updateExecutionRecordAsApp(recordId, fields);
  }

  private async processRequestedNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    let outboundAnchored = false;
    try {
      const decided = await this.store.getManagerApprovalRecordState(notification.recordId);
      const latest = await this.gateway.getExecutionRecordAsApp(
        notification.recordId,
      );
      if (!decided && latest.status !== DECISION_PRE_STATE) {
        throw new ConflictException('采购申请已离开待审批状态');
      }
      const input = decided ? parsePurchaseManagerApprovalCardContext(decided.cardContext) : toManagerApprovalCardInput(latest);
      if(notification.businessEventId.startsWith('single-manager-handover:')&&parsePurchaseManagerApprovalCardContext(notification.cardContext).building!==input.building)throw new ConflictException('采购单条交接楼栋已变化，请核对原记录');
      this.assertCurrentManagerActor(notification.recipientOpenId,input.building);
      const context = serializePurchaseManagerApprovalCardContext(input);
      const anchored = await this.store.markManagerApprovalSendStarted(
        notification.key,
        notification.claimToken,
        context,
        now,
      );
      if (!anchored) {
        throw new ConflictException('经理审批发卡任务不存在');
      }
      outboundAnchored = true;
      const messageId = await this.gateway.sendInteractiveCard(
        notification.recipientOpenId,
        decided ? renderManagerApprovalCard(decided) : buildPurchaseManagerApprovalCard(input),
        anchored.deliveryUuid,
      );
      await this.store.completeManagerApprovalRequestAndRegisterCard(
        notification.key,
        notification.claimToken,
        { messageId },
        now,
      );
      return true;
    } catch (error) {
      if (outboundAnchored && isDefinitiveFeishuDeliveryRejection(error)) {
        await this.store.recordManagerCardRejectedSend(
          notification.key,
          notification.claimToken,
          error,
          notification.attempts < TASK_MAX_ATTEMPTS
            ? nextTaskAttemptAt(notification.attempts, now)
            : null,
          now,
        );
      } else if (
        outboundAnchored ||
        notification.attempts < TASK_MAX_ATTEMPTS
      ) {
        await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
      } else {
        await this.store.failNotification(
          notification.key,
          notification.claimToken,
          error,
          now,
        );
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async processCardUpdateNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    try {
      await this.findNotificationAction(notification);
      parsePurchaseManagerApprovalCardContext(notification.cardContext);
      const messageId = requireMessageId(notification.messageId);
      const current = await this.store.findManagerApprovalCard(messageId, notification.recipientOpenId);
      if (!current) throw new ConflictException('经理审批状态通知的原消息绑定不存在');
      const card = renderManagerApprovalCard(current);
      try {
        await this.gateway.updateInteractiveCard(messageId, card);
      } catch (error) {
        if (
          notification.kind === 'manager_approval_reopened' &&
          isPermanentMessageUpdateError(error)
        ) {
          return this.sendReplacementCard(
            notification,
            card,
            error,
            now,
            result,
          );
        }
        throw error;
      }
      await this.store.completeNotification(
        notification.key,
        notification.claimToken,
        { messageId },
        now,
      );
      return true;
    } catch (error) {
      if (
        notification.kind === 'manager_approval_resolved' || notification.kind === 'manager_approval_reopened' ||
        notification.kind === 'manager_approval_attention_required' ||
        notification.attempts < TASK_MAX_ATTEMPTS
      ) {
        await this.store.rescheduleNotification(
          notification.key,
          notification.claimToken,
          error,
          nextTaskAttemptAt(notification.attempts, now),
          now,
        );
        if (
          notification.kind === 'manager_approval_reopened' ||
          notification.kind === 'manager_approval_attention_required'
        ) {
          result.alerts.push(`${notification.key}: 卡片展示更新失败，等待重试`);
        }
      } else {
        await this.store.failNotification(
          notification.key,
          notification.claimToken,
          error,
          now,
        );
        result.alerts.push(`${notification.key}: 最终卡片展示更新失败`);
      }
      recordTaskFailure(result, notification.key, error);
      return false;
    }
  }

  private async sendReplacementCard(
    notification: PurchaseWorkflowNotificationEntry,
    card: Record<string, unknown>,
    patchError: unknown,
    now: Date,
    result: PurchaseManagerApprovalTaskRunResult,
  ): Promise<boolean> {
    try {
      const anchored = await this.store.markManagerApprovalSendStarted(
        notification.key,
        notification.claimToken,
        notification.cardContext,
        now,
      );
      if (!anchored) {
        throw new ConflictException('经理审批替代卡任务不存在');
      }
      const newMessageId = await this.gateway.sendInteractiveCard(
        notification.recipientOpenId,
        card,
        anchored.deliveryUuid,
      );
      await this.store.replaceManagerApprovalCardMessage(
        notification.key,
        notification.claimToken,
        {
          oldMessageId: notification.messageId,
          newMessageId,
        },
        now,
      );
      return true;
    } catch (replacementError) {
      await this.store.rescheduleNotification(
        notification.key,
        notification.claimToken,
        replacementError,
        nextTaskAttemptAt(notification.attempts, now),
        now,
      );
      result.alerts.push(
        `${notification.key}: 原卡不可更新且替代卡发送结果待确认`,
      );
      recordTaskFailure(
        result,
        notification.key,
        new Error(
          `${safeErrorMessage(patchError)}；${safeErrorMessage(
            replacementError,
          )}`,
        ),
      );
      return false;
    }
  }

  private async findNotificationAction(
    notification: PurchaseWorkflowNotificationEntry,
  ): Promise<PurchaseManagerApprovalActionEntry> {
    const prefix = `${notification.kind}:`;
    if (!notification.businessEventId.startsWith(prefix)) {
      throw new ConflictException('经理审批状态通知业务键无效');
    }
    const matches = (
      await this.store.listManagerApprovalActions({
        recordId: notification.recordId,
      })
    ).filter(
      (entry) =>
        notification.businessEventId === `${prefix}${entry.eventId}` ||
        (notification.kind === 'manager_approval_attention_required' &&
          notification.businessEventId ===
            `${prefix}${entry.eventId}:${notification.deliveryGeneration}`),
    );
    if (matches.length !== 1 || !matches[0]) {
      throw new ConflictException('经理审批状态通知缺少唯一动作');
    }
    return matches[0];
  }

  private async retryOrFailNotification(
    notification: PurchaseWorkflowNotificationEntry,
    error: unknown,
    now: Date,
  ): Promise<void> {
    if (notification.attempts >= TASK_MAX_ATTEMPTS) {
      await this.store.failNotification(
        notification.key,
        notification.claimToken,
        error,
        now,
      );
      return;
    }
    await this.store.rescheduleNotification(
      notification.key,
      notification.claimToken,
      error,
      nextTaskAttemptAt(notification.attempts, now),
      now,
    );
  }
}

function requireRecordId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!RECORD_ID_PATTERN.test(normalized)) {
    throw new BadRequestException('采购执行记录 ID 无效');
  }
  return normalized;
}

function requireMessageId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^om_[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new ConflictException('经理审批卡消息标识无效');
  }
  return normalized;
}

function renderManagerApprovalCard(
  card: PurchaseManagerApprovalCardEntry,
): Record<string, unknown> {
  const input = parsePurchaseManagerApprovalCardContext(card.cardContext);
  if(card.personnelHandover)return buildPurchaseManagerTransferredCard(input);
  if (card.state === 'initial') {
    return buildPurchaseManagerApprovalCard(input);
  }
  if (card.state === 'reject_editing') {
    return buildPurchaseManagerRejectEditorCard(input, {
      rejectionReason: card.rejectionReasonDraft,
    });
  }
  if (card.state === 'pending') {
    if (!card.choice) throw new ConflictException('经理审批卡选择缺失');
    return buildPurchaseManagerPendingCard(input, card.choice);
  }
  if (card.state === 'resolved') {
    if (!card.choice) throw new ConflictException('经理审批卡结果缺失');
    const approver = readPurchaseManagerApprovers().find(person => person.openId === card.actorOpenId);
    return buildResolvedPurchaseManagerApprovalCard(input, {
      choice: card.choice,
      actorName:
        approver?.name || card.actorOpenId,
      processedAt: card.processedAt || card.resolvedAt,
      rejectionReason: card.rejectionReasonDraft,
    });
  }
  return buildPurchaseManagerManualReconciliationCard(input, {
    choice: card.choice || undefined,
  });
}

function renderManagerApprovalBatch(
  batch: PurchaseManagerApprovalBatchEntry,
): Record<string, unknown> {
  const input = parsePurchaseManagerBatchApprovalCardContext(batch.cardContext);
  if (batch.state === 'active') {
    return buildPurchaseManagerBatchApprovalCard(input);
  }
  if (batch.state === 'reject_editing') {
    if (!batch.selectedRejectRecordId) {
      throw new ConflictException('采购批次审批驳回明细缺失');
    }
    return buildPurchaseManagerBatchRejectEditorCard(
      input,
      batch.selectedRejectRecordId,
    );
  }
  if (batch.state === 'processing' || batch.state === 'awaiting_delivery') {
    return buildPurchaseManagerBatchPendingCard(input);
  }
  if (batch.state === 'resolved') {
    const approver = managerBatchDeliveries(batch).find(person => person.recipientOpenId === batch.actorOpenId);
    return buildResolvedPurchaseManagerBatchApprovalCard(input, {
      actorName:
        approver?.recipientName || readPurchaseManagerApprovers().find(person => person.openId === batch.actorOpenId)?.name || batch.actorOpenId,
      processedAt: batch.processedAt || batch.resolvedAt,
    });
  }
  return buildPurchaseManagerBatchManualReconciliationCard(input);
}

function toManagerApprovalCardInput(
  latest: PurchaseWorkflowRecord,
): PurchaseManagerApprovalCardInput {
  const amount =
    latest.unitPrice !== null &&
    latest.unitPrice !== undefined &&
    Number.isFinite(latest.unitPrice)
      ? latest.requestedQuantity * latest.unitPrice
      : null;
  return {
    executionRecordId: latest.recordId,
    requester: latest.requesterName || latest.requesterOpenId,
    building: latest.building,
    title: latest.itemName,
    quantity: latest.requestedQuantity,
    unit: latest.unit || '',
    amount,
    procurementForm: latest.procurementForm || null,
    singleReason: latest.singleReason || null,
    expectedDeliveryAt: latest.expectedDeliveryDate,
    requestCode: latest.requestCode,
    createdAt: latest.createdAt,
  };
}

function toManagerBatchApprovalCardInput(
  batch: PurchaseManagerApprovalBatchEntry,
  records: PurchaseWorkflowRecord[],
  applicationCreatedAt: string,
): PurchaseManagerBatchApprovalCardInput {
  if (
    records.length !== batch.recordIds.length ||
    records.some((record, index) => record.recordId !== batch.recordIds[index])
  ) {
    throw new ConflictException('采购批次审批记录顺序不一致');
  }
  const first = records[0];
  if (!first) throw new ConflictException('采购批次审批没有明细');
  if (
    first.requesterOpenId !== batch.requesterOpenId ||
    records.some(
      (record) =>
        record.requesterOpenId !== first.requesterOpenId ||
        record.building !== first.building ||
        record.requestCode !== first.requestCode,
    )
  ) {
    throw new ConflictException('采购批次审批明细不属于同一申请');
  }
  return {
    version: 3,
    approvalBatchId: batch.approvalBatchId,
    requesterName: first.requesterName || first.requesterOpenId,
    requesterOpenId: first.requesterOpenId,
    building: first.building,
    requestCode: first.requestCode,
    expectedDeliveryAt: formatPurchaseBatchCardDate(first.expectedDeliveryDate),
    createdAt: formatPurchaseBatchCardDateTime(
      applicationCreatedAt || first.createdAt || batch.createdAt,
    ),
    items: records.map((record) => {
      const amount =
        record.unitPrice !== null &&
        record.unitPrice !== undefined &&
        Number.isFinite(record.unitPrice)
          ? (record.requestedQuantity * record.unitPrice).toFixed(2)
          : null;
      return {
        executionRecordId: record.recordId,
        title: record.itemName,
        specification: record.specification || '/',
        quantity: String(record.requestedQuantity),
        unit: record.unit || '件',
        amount,
        purchaseLinks: [...(record.purchaseLinks || [])],
        procurementForm: record.procurementForm || null,
        singleReason:
          record.procurementForm === '单一采购'
            ? record.singleReason || null
            : null,
        status: 'pending' as const,
        choice: '' as const,
        rejectionReason: '',
      };
    }),
  };
}

function toRecoveredReceiptBatchCardInput(
  approvalBatchId: string,
  records: PurchaseWorkflowRecord[],
  now: Date,
): PurchaseManagerBatchApprovalCardInput {
  const first = records[0];
  if (!first) throw new ConflictException('采购待签收恢复批次没有明细');
  if (
    records.some(
      (record) =>
        record.requesterOpenId !== first.requesterOpenId ||
        record.building !== first.building ||
        record.requestCode !== first.requestCode,
    )
  ) {
    throw new ConflictException('采购待签收恢复明细不属于同一申请');
  }
  return {
    version: 3,
    approvalBatchId,
    requesterName: first.requesterName || first.requesterOpenId,
    requesterOpenId: first.requesterOpenId,
    building: first.building,
    requestCode: first.requestCode,
    expectedDeliveryAt: formatPurchaseBatchCardDate(first.expectedDeliveryDate),
    createdAt: formatPurchaseBatchCardDateTime(first.createdAt || now),
    items: records.map((record) => {
      const choice = purchaseMethodToRecoveredChoice(record.purchaseMethod);
      if (!choice) {
        throw new ConflictException('采购待签收记录缺少有效采购方式');
      }
      const amount =
        record.unitPrice !== null &&
        record.unitPrice !== undefined &&
        Number.isFinite(record.unitPrice)
          ? (record.requestedQuantity * record.unitPrice).toFixed(2)
          : null;
      return {
        executionRecordId: record.recordId,
        title: record.itemName,
        specification: record.specification || '/',
        quantity: String(record.requestedQuantity),
        unit: record.unit || '件',
        amount,
        purchaseLinks: [...(record.purchaseLinks || [])],
        status: 'approved' as const,
        choice,
        rejectionReason: '',
      };
    }),
  };
}

function purchaseMethodToRecoveredChoice(
  value: PurchaseWorkflowRecord['purchaseMethod'],
): 'comprehensive' | 'building_self' | null {
  if (value === '综合采购') return 'comprehensive';
  if (value === '需求自采' || value === '需求自采（楼内）') {
    return 'building_self';
  }
  return null;
}

function toPurchaseBatchPurchaserCardInput(
  batch: PurchaseManagerApprovalBatchEntry,
  context: PurchaseManagerBatchApprovalCardInput,
  purchaserOpenId: string,
  records: Map<string, PurchaseWorkflowRecord>,
  commandStates: Map<string, PurchaseBatchCommandSnapshot>,
): PurchaseBatchPurchaserCardInput {
  const stateByRecordId = new Map(
    batch.items.map((item) => [item.executionRecordId, item]),
  );
  const items = context.items
    .filter(
      (item) =>
        stateByRecordId.get(item.executionRecordId)?.status === 'approved' &&
        stateByRecordId.get(item.executionRecordId)?.purchaserOpenId ===
          purchaserOpenId,
    )
    .map((item) => {
      const record = records.get(item.executionRecordId);
      const command = commandStates.get(item.executionRecordId);
      const commandStatus = command?.status;
      const orderCommand =
        command?.context.action === 'order' ? command.context : undefined;
      const stage = record ? resolvePurchaseStage(record.status) : null;
      const orderState =
        commandStatus === 'pending' || commandStatus === 'processing'
          ? ('processing' as const)
          : commandStatus === 'failed'
            ? ('waiting' as const)
            : commandStatus === 'manual_reconciliation'
              ? ('manual_reconciliation' as const)
              : commandStatus === 'completed'
                ? ('completed' as const)
                : stage === 'ordering' || stage === null
                  ? ('waiting' as const)
                  : stage === 'receipt' ||
                      stage === 'inbound' ||
                      stage === 'completed'
                    ? ('completed' as const)
                    : ('manual_reconciliation' as const);
      const restoreCommandValues =
        commandStatus === 'failed' || commandStatus === 'completed';
      return {
        executionRecordId: item.executionRecordId,
        title: item.title,
        specification: item.specification,
        quantity: item.quantity,
        unit: item.unit,
        amount: item.amount,
        purchaseLinks: [
          ...(item.purchaseLinks?.length
            ? item.purchaseLinks
            : record?.purchaseLinks || []),
        ],
        orderState,
        actualQuantity:
          orderState === 'completed'
            ? (record?.actualQuantity ?? orderCommand?.actualQuantity ?? null)
            : restoreCommandValues
              ? (orderCommand?.actualQuantity ?? null)
              : null,
        actualAmount:
          orderState === 'completed'
            ? (record?.actualAmount ?? orderCommand?.actualAmount ?? null)
            : restoreCommandValues
              ? (orderCommand?.actualAmount ?? null)
              : null,
        orderNote:
          orderState === 'completed'
            ? record?.note || orderCommand?.note || ''
            : commandStatus === 'failed'
              ? orderCommand?.note || ''
              : '',
        orderedAt: null,
      };
    });
  if (!items.length) {
    throw new ConflictException('采购批次没有分配给当前采购人的物品');
  }
  const purchaserName =
    batch.items.find(
      (item) =>
        item.status === 'approved' && item.purchaserOpenId === purchaserOpenId,
    )?.purchaserName || purchaserOpenId;
  return {
    approvalBatchId: batch.approvalBatchId,
    purchaserOpenId,
    purchaserName,
    requesterName: context.requesterName,
    building: context.building,
    requestCode: context.requestCode,
    expectedDeliveryAt: context.expectedDeliveryAt,
    items,
  };
}

function toPurchaseBatchReceiptCardInput(
  batch: PurchaseManagerApprovalBatchEntry,
  context: PurchaseManagerBatchApprovalCardInput,
  records: Map<string, PurchaseWorkflowRecord>,
  orderCommands: Map<string, PurchaseBatchCommandSnapshot>,
  receiptCommands: Map<string, PurchaseBatchCommandSnapshot>,
): PurchaseBatchReceiptCardInput {
  const batchItems = new Map(
    batch.items.map((item) => [item.executionRecordId, item]),
  );
  const items = context.items.flatMap((item) => {
    const batchItem = batchItems.get(item.executionRecordId);
    const record = records.get(item.executionRecordId);
    const orderCommand = orderCommands.get(item.executionRecordId);
    const orderContext =
      orderCommand?.context.action === 'order'
        ? orderCommand.context
        : undefined;
    if (!batchItem || batchItem.status !== 'approved') return [];
    const stage = record ? resolvePurchaseStage(record.status) : null;
    const orderCompleted = orderCommand?.status === 'completed';
    if (
      !orderCompleted &&
      stage !== 'receipt' &&
      stage !== 'inbound' &&
      stage !== 'completed'
    ) {
      return [];
    }
    const actualQuantity =
      record?.actualQuantity ?? orderContext?.actualQuantity ?? null;
    const actualAmount =
      record?.actualAmount ?? orderContext?.actualAmount ?? null;
    if (
      actualQuantity === null ||
      actualQuantity <= 0 ||
      actualAmount === null ||
      actualAmount < 0
    ) {
      throw new ConflictException('采购签收明细缺少有效下单结果');
    }
    const receiptCommand = receiptCommands.get(item.executionRecordId);
    const receiptContext =
      receiptCommand?.context.action === 'receipt'
        ? receiptCommand.context
        : undefined;
    const commandStatus = receiptCommand?.status;
    const receiptState =
      commandStatus === 'pending' || commandStatus === 'processing'
        ? ('processing' as const)
        : commandStatus === 'failed'
          ? ('waiting' as const)
          : commandStatus === 'manual_reconciliation'
            ? ('manual_reconciliation' as const)
            : commandStatus === 'completed'
              ? ('completed' as const)
              : stage === 'inbound' || stage === 'completed'
                ? ('completed' as const)
                : ('waiting' as const);
    return [
      {
        executionRecordId: item.executionRecordId,
        title: item.title,
        specification: item.specification,
        requestedQuantity: item.quantity,
        actualQuantity,
        unit: item.unit,
        requestedAmount: item.amount,
        actualAmount,
        purchaserName: record?.purchaserName || batchItem.purchaserName,
        purchaseMethod:
          record?.purchaseMethod ||
          purchaseMethodForBatchItem(batchItem.choice),
        receiptState,
        signerName: record?.signer || '',
        receiptTime:
          formatPurchaseBatchCardDateTime(record?.receiptTime ?? null) ||
          (receiptContext
            ? formatPurchaseBatchCardDateTime(receiptContext.receiptTime)
            : null),
        receiptPhotoCount: Math.max(
          batchItem.receiptPhotoTokens.length,
          record?.receiptPhotoTokens.length || 0,
          receiptContext?.receiptPhotoTokens.length || 0,
        ),
        invoiceCount: Math.max(
          batchItem.invoiceTokens.length,
          record?.invoiceTokens.length || 0,
          receiptContext?.invoiceTokens.length || 0,
        ),
      },
    ];
  });
  if (!items.length) {
    throw new ConflictException('采购批次暂无可签收物品');
  }
  return {
    approvalBatchId: batch.approvalBatchId,
    requesterOpenId: batch.requesterOpenId,
    requesterName: context.requesterName,
    building: context.building,
    requestCode: context.requestCode,
    items,
  };
}

function purchaseMethodForBatchItem(
  choice: PurchaseManagerApprovalBatchEntry['items'][number]['choice'],
): string {
  return choice === 'building_self'
    ? '需求自采'
    : choice === 'comprehensive'
      ? '综合采购'
      : '';
}

function requireApprovedBatchItem(
  batch: PurchaseManagerApprovalBatchEntry,
  executionRecordId: string,
) {
  const item = batch.items.find(
    (candidate) =>
      candidate.executionRecordId === executionRecordId &&
      candidate.status === 'approved',
  );
  if (!item) throw new ConflictException('采购履约明细不可处理');
  return item;
}

function isOrderFulfillmentAction(
  action: PurchaseBatchFulfillmentCallbackAction['action'],
): boolean {
  return (
    action === 'open_order' ||
    action === 'return_purchase_list' ||
    action === 'submit_order'
  );
}

function isBaseReconciliationCandidate(
  record: PurchaseWorkflowRecord,
  now: Date,
): boolean {
  if (record.status !== DECISION_PRE_STATE) return false;
  if (
    record.approvalWorkflowStatus &&
    !['待路由', '待经理审批', '同步异常'].includes(
      record.approvalWorkflowStatus,
    )
  ) {
    return false;
  }
  if (record.approvalCardMessageId) {
    return false;
  }
  const createdAt = Number(record.createdAt);
  return (
    !Number.isFinite(createdAt) ||
    now.getTime() - createdAt >= BASE_RECONCILE_MIN_AGE_MS
  );
}

function shouldPersistManagerBatchDeliverySnapshot(
  notification: PurchaseWorkflowNotificationEntry | null,
): boolean {
  return Boolean(
    notification &&
    (notification.sendOutcome !== 'unattempted' ||
      notification.status === 'failed' ||
      notification.status === 'completed' ||
      notification.status === 'manual_reconciliation' ||
      notification.lastError),
  );
}

function buildReceiptDeliverySnapshotFields(
  notification: PurchaseWorkflowNotificationEntry,
  now: Date,
  fallbackError = '',
): Record<string, unknown> {
  const common = {
    batchId: parseReceiptBatchIdFromNotification(notification),
    deliveryUuid: notification.deliveryUuid,
    deliveryAttempts: notification.attempts,
    deliveryLastAttemptAt:
      notification.attempts > 0
        ? parseOptionalDate(
            notification.updatedAt || notification.firstSendAttemptAt,
          )
        : null,
  };
  if (notification.sendOutcome === 'delivered' && notification.messageId) {
    return buildPurchaseReceiptCardDeliveredFields({
      ...common,
      deliveredAt:
        parseOptionalDate(notification.completedAt || notification.updatedAt) ||
        now,
      messageId: notification.messageId,
    });
  }
  if (
    notification.sendOutcome === 'manual_reconciliation' ||
    notification.sendOutcome === 'unknown'
  ) {
    return buildPurchaseReceiptCardDeliveryManualReviewFields({
      ...common,
      errorMessage:
        fallbackError ||
        notification.lastError ||
        '采购签收卡发送结果尚未确认，已停止无标识重复投递',
    });
  }
  if (notification.lastError || notification.status === 'failed') {
    return buildPurchaseReceiptCardDeliveryErrorFields({
      ...common,
      errorMessage:
        fallbackError || notification.lastError || '采购签收卡投递失败',
    });
  }
  if (notification.status === 'processing') {
    return buildPurchaseReceiptCardDeliveryStartedFields({
      ...common,
      deliveryLastAttemptAt: common.deliveryLastAttemptAt || now,
    });
  }
  return buildPurchaseReceiptCardRoutingFields(common);
}

function buildManagerBatchDeliverySnapshotFields(
  batch: PurchaseManagerApprovalBatchEntry,
  notification: PurchaseWorkflowNotificationEntry | null,
  now: Date,
  fallbackError = '',
): Record<string, unknown> {
  if (!notification) {
    return buildPurchaseManagerDeliveryErrorFields({
      approvalBatchId: batch.approvalBatchId,
      managerOpenId: batch.recipientOpenId,
      deliveryUuid: '',
      deliveryAttempts: 0,
      deliveryLastAttemptAt: null,
      errorMessage: fallbackError || '采购审批卡本地投递任务缺失',
    });
  }
  const common = {
    approvalBatchId: batch.approvalBatchId,
    managerOpenId: batch.recipientOpenId,
    managerOpenIds: managerBatchDeliveries(batch).map(delivery => delivery.recipientOpenId),
    deliveryUuid: notification.deliveryUuid,
    deliveryAttempts: notification.attempts,
    deliveryLastAttemptAt:
      notification.attempts > 0
        ? parseOptionalDate(
            notification.updatedAt || notification.firstSendAttemptAt,
          )
        : null,
  };
  if (notification.sendOutcome === 'delivered' && notification.messageId) {
    return buildPurchaseManagerDeliveredFields({
      ...common,
      deliveredAt:
        parseOptionalDate(notification.completedAt || notification.updatedAt) ||
        now,
      messageId: notification.messageId,
    });
  }
  if (
    notification.sendOutcome === 'manual_reconciliation' ||
    notification.sendOutcome === 'unknown'
  ) {
    return buildPurchaseManagerDeliveryManualReviewFields({
      ...common,
      errorMessage:
        fallbackError ||
        notification.lastError ||
        '采购审批卡发送结果尚未确认，已停止无标识重复投递',
    });
  }
  if (notification.lastError || notification.status === 'failed') {
    return buildPurchaseManagerDeliveryErrorFields({
      ...common,
      errorMessage:
        fallbackError || notification.lastError || '采购审批卡投递失败',
    });
  }
  return buildPurchaseManagerRoutingFields(common);
}

function parseOptionalDate(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface PurchaseReceiptAttachmentContext {
  version: 1;
  approvalBatchId: string;
  executionRecordId: string;
  materialType: 'receipt_photo' | 'invoice';
  actorOpenId: string;
  cardMessageId: string;
  imageMessageId: string;
  chatId: string;
  imageKey: string;
}

function parsePurchaseReceiptAttachmentContext(
  value: string,
): PurchaseReceiptAttachmentContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConflictException('采购签收图片任务上下文无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConflictException('采购签收图片任务上下文无效');
  }
  const context = parsed as Record<string, unknown>;
  const expectedKeys = [
    'actorOpenId',
    'approvalBatchId',
    'cardMessageId',
    'chatId',
    'executionRecordId',
    'imageKey',
    'imageMessageId',
    'materialType',
    'version',
  ].sort();
  if (
    JSON.stringify(Object.keys(context).sort()) !==
      JSON.stringify(expectedKeys) ||
    context.version !== 1 ||
    typeof context.approvalBatchId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,160}$/u.test(context.approvalBatchId) ||
    typeof context.executionRecordId !== 'string' ||
    !RECORD_ID_PATTERN.test(context.executionRecordId) ||
    (context.materialType !== 'receipt_photo' &&
      context.materialType !== 'invoice') ||
    typeof context.actorOpenId !== 'string' ||
    !FEISHU_OPEN_ID_PATTERN.test(context.actorOpenId) ||
    !validMessageResourceIdentifier(context.cardMessageId) ||
    !validMessageResourceIdentifier(context.imageMessageId) ||
    !validMessageResourceIdentifier(context.chatId) ||
    !validMessageResourceIdentifier(context.imageKey)
  ) {
    throw new ConflictException('采购签收图片任务上下文无效');
  }
  return context as unknown as PurchaseReceiptAttachmentContext;
}

function validMessageResourceIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,256}$/u.test(value);
}

function shortStableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function parseReceiptBatchIdFromNotification(
  notification: PurchaseWorkflowNotificationEntry,
): string {
  const context = parsePurchaseManagerBatchApprovalCardContext(
    notification.cardContext,
  );
  const prefix = `manager_batch_receipt_requested:${context.approvalBatchId}`;
  if (
    notification.businessEventId !== prefix &&
    !notification.businessEventId.startsWith(`${prefix}:`)
  ) {
    throw new ConflictException('采购签收通知业务键无效');
  }
  return context.approvalBatchId;
}

function parseBatchIdFromNotification(
  notification: PurchaseWorkflowNotificationEntry,
  kind: 'manager_batch_approval_requested',
): string {
  const prefix = `${kind}:`;
  if (!notification.businessEventId.startsWith(prefix)) {
    throw new ConflictException('采购批次审批通知业务键无效');
  }
  const approvalBatchId = notification.businessEventId.slice(prefix.length).replace(/:h-[a-f0-9]{32}$/u, '');
  if (!/^[A-Za-z0-9_-]{8,160}$/u.test(approvalBatchId)) {
    throw new ConflictException('采购批次审批通知批次标识无效');
  }
  return approvalBatchId;
}

function isPermanentMessageUpdateError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    feishuCode?: unknown;
    httpStatus?: unknown;
    response?: {
      status?: unknown;
      data?: { code?: unknown };
    };
  };
  const feishuCode = finiteNumber(
    candidate.feishuCode ?? candidate.response?.data?.code,
  );
  if (
    feishuCode !== null &&
    PERMANENT_MESSAGE_UPDATE_FEISHU_CODES.has(feishuCode)
  ) {
    return true;
  }
  const httpStatus = finiteNumber(
    candidate.httpStatus ?? candidate.response?.status,
  );
  return httpStatus === 404 || httpStatus === 410;
}

function isDefinitiveFeishuDeliveryRejection(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { deliveryOutcome?: unknown }).deliveryOutcome === 'rejected',
  );
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function nextTaskAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** exponent));
}

function resolveNow(value: Date): Date {
  const date = new Date(value.getTime());
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException('经理审批任务时间无效');
  }
  return date;
}

function isManualManagerDeliveryTransition(
  notification: PurchaseWorkflowNotificationEntry,
): boolean {
  return (
    (notification.kind === 'manager_approval_requested' ||
      notification.kind === 'manager_approval_reopened' ||
      notification.kind === 'manager_batch_approval_requested' ||
      notification.kind === 'manager_batch_approval_result' ||
      notification.kind === 'manager_batch_purchase_assigned' ||
      notification.kind === 'manager_batch_receipt_requested' ||
      notification.kind === 'manager_batch_receipt_completed') &&
    notification.status === 'manual_reconciliation' &&
    notification.sendOutcome === 'manual_reconciliation'
  );
}

function recordTaskFailure(
  result: PurchaseManagerApprovalTaskRunResult,
  key: string,
  error: unknown,
): void {
  result.failed += 1;
  result.errors.push(`${key}: ${safeErrorMessage(error)}`);
}

function handoverDeliveryMetadata(fields: Record<string, unknown>): Record<string, unknown> {
  const result = { ...fields };
  for (const field of [PURCHASE_MANAGER_APPROVAL_FIELDS.source, PURCHASE_MANAGER_APPROVAL_FIELDS.state,
    PURCHASE_MANAGER_APPROVAL_FIELDS.currentApprover, PURCHASE_MANAGER_APPROVAL_FIELDS.actualApprover,
    PURCHASE_MANAGER_APPROVAL_FIELDS.approvalTime, PURCHASE_MANAGER_APPROVAL_FIELDS.policyVersion,
    PURCHASE_MANAGER_APPROVAL_FIELDS.batchId, PURCHASE_MANAGER_APPROVAL_FIELDS.actionId]) delete result[field];
  return result;
}

function safeErrorMessage(error: unknown): string {
  const value =
    error instanceof Error
      ? error.message
      : String(error || '经理审批任务执行失败');
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(
      /("(?:tenant[_-]?access[_-]?token|access[_-]?token|verification[_-]?token|encrypt[_-]?key|app[_-]?secret|password|secret|token)"\s*:\s*")[^"\\]*(?:\\.[^"\\]*)*"/giu,
      '$1[redacted]"',
    )
    .replace(
      /('(?:tenant[_-]?access[_-]?token|access[_-]?token|verification[_-]?token|encrypt[_-]?key|app[_-]?secret|password|secret|token)'\s*:\s*')[^'\\]*(?:\\.[^'\\]*)*'/giu,
      "$1[redacted]'",
    )
    .replace(
      /\b((?:tenant[_-]?access[_-]?token|access[_-]?token|verification[_-]?token|encrypt[_-]?key|app[_-]?secret|password|secret|token)\s*[:=]\s*)([^\s,;}&]+)/giu,
      '$1[redacted]',
    )
    .trim()
    .slice(0, 500);
}
