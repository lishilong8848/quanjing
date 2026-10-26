import { AccessConfigurationService, useConfiguredCardAuthorizationSnapshots } from '../../common/access/access-configuration.service';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import {
  HttpException,
  Injectable,
  Inject,
  Logger,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { parseLeaveLongConnectionCardAction } from '../leave-workflow/leave-workflow.callback';
import { LeaveWorkflowService } from '../leave-workflow/leave-workflow.service';
import { parseOvertimeLongConnectionCardAction } from '../overtime-workflow/overtime-workflow.callback';
import {
  toFeishuRawCardUpdate,
  type FeishuCardActionResponse,
} from '../overtime-workflow/overtime-workflow.card-action.consumer';
import { OvertimeWorkflowService } from '../overtime-workflow/overtime-workflow.service';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { readPurchaseManagerApprover, readPurchaseManagerApprovers } from './purchase-manager-approval.config';
import {
  parsePurchaseLongConnectionCardAction,
  type PurchaseCardCallbackConfig,
  type PurchaseCardCallbackResult,
} from './purchase-workflow-callback';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { parseTodayOperationsAnomalyCardAction } from '../bitable-sync/today-operations-anomaly.callback';
import { TodayOperationsAnomalyService } from '../bitable-sync/today-operations-anomaly.service';
import { InventoryOutboundApprovalService } from '../inventory-outbound-approval/inventory-outbound-approval.service';
import { ThresholdAdjustmentService } from '../threshold-management/threshold-adjustment.service';
import { FeishuCardActionExecution, FeishuCardActionDeadlineError, CARD_ACTION_PROCESSING_RESPONSE } from '../../common/feishu-card-action-execution';

const ACCEPTED_RESPONSE: FeishuCardActionResponse = {
  toast: { type: 'info', content: '审批操作已受理' },
};
const REPLAY_RESPONSE: FeishuCardActionResponse = {
  toast: { type: 'warning', content: '该申请已处理或正在处理' },
};
const ERROR_RESPONSE: FeishuCardActionResponse = {
  toast: { type: 'error', content: '审批处理失败，请稍后重试' },
};

type CardActionKind =
  | 'leave'
  | 'overtime'
  | 'purchase'
  | 'inventory_outbound'
  | 'threshold_adjustment'
  | 'today_operations_anomaly';
type PurchaseAction = Exclude<
  PurchaseCardCallbackResult,
  { kind: 'challenge' }
>;

@Injectable()
export class FeishuCardActionRouter {
  private readonly logger = new Logger(FeishuCardActionRouter.name);
  private readonly execution = new FeishuCardActionExecution<FeishuCardActionResponse>((error) => {
    this.logger.error(`卡片延后处理失败，可安全重试：${safeErrorMessage(error)}`);
  });

  constructor(
    private readonly overtimeWorkflowService: OvertimeWorkflowService,
    private readonly leaveWorkflowService: LeaveWorkflowService,
    private readonly purchaseWorkflowService: PurchaseWorkflowService,
    private readonly purchaseWorkflowStore: PurchaseWorkflowStore,
    private readonly purchaseManagerApprovalService: PurchaseManagerApprovalService,
    private readonly todayOperationsAnomalyService: TodayOperationsAnomalyService,
    private readonly inventoryOutboundApprovalService: InventoryOutboundApprovalService,
    @Optional() private readonly thresholdAdjustments?: ThresholdAdjustmentService,
    @Inject(AccessConfigurationService) private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  isAnyEnabled(): boolean {
    return (
      this.overtimeWorkflowService.isEnabled() ||
      this.leaveWorkflowService.isEnabled() ||
      this.purchaseWorkflowService.isEnabled() ||
      this.purchaseManagerApprovalService.isEnabled() ||
      this.todayOperationsAnomalyService.isEnabled() ||
      this.inventoryOutboundApprovalService.isEnabled() ||
      Boolean(this.thresholdAdjustments?.isEnabled())
    );
  }

  async handle(payload: unknown): Promise<FeishuCardActionResponse> {
    if (!currentHotfixActivation().isAcceptingNewWork()) {
      return { toast: { type: 'error', content: '系统更新中，本次操作未受理，请稍后重试' } };
    }
    try {
      const kind = classifyCardAction(payload);
      return await this.execution.run(requireObject(payload), () => this.dispatch(payload, kind));
    } catch (error) {
      this.logger.warn(`Feishu card action rejected: ${safeErrorMessage(error)}`);
      return cardActionErrorResponse(error);
    }
  }

  private async dispatch(payload: unknown, kind: CardActionKind): Promise<FeishuCardActionResponse> {
      if (kind === 'threshold_adjustment') {
        if (!this.thresholdAdjustments?.isEnabled()) {
          throw new ServiceUnavailableException('阈值审批服务未启用');
        }
        const result = await (this.thresholdAdjustments.handleCardAction(payload));
        return {
          toast: {
            type: 'info',
            content:
              result.toast ||
              (result.claimed ? '审批已受理' : '该审批已处理'),
          },
          ...(result.card ? { card: toFeishuRawCardUpdate(result.card) } : {}),
        };
      }
      if (kind === 'leave') return await this.handleLeave(payload);
      if (kind === 'today_operations_anomaly') {
        return await this.handleTodayOperationsAnomaly(payload);
      }
      if (kind === 'inventory_outbound') {
        return await this.handleInventoryOutbound(payload);
      }
      return kind === 'overtime'
        ? await this.handleOvertime(payload)
        : await this.handlePurchase(payload);
  }

  async handleMessage(payload: unknown): Promise<void> {
    if (!currentHotfixActivation().isAcceptingNewWork()) {
      throw new ServiceUnavailableException('系统更新中，本次消息未受理，请稍后重试');
    }
    if (!this.purchaseManagerApprovalService.isEnabled()) return;
    try {
      const result =
        await this.purchaseManagerApprovalService.handlePurchaseReceiptImageMessage(
          payload,
        );
      if (result.enqueued) {
        void this.purchaseManagerApprovalService
          .runPendingTasks()
          .catch((error) => {
            this.logger.error(
              `采购签收图片已受理，但立即入库失败，将由后台重试：${safeErrorMessage(error)}`,
            );
          });
      }
    } catch (error) {
      this.logger.warn(`飞书签收图片消息处理失败：${safeErrorMessage(error)}`);
      throw error;
    }
  }

  private async handleLeave(
    payload: unknown,
  ): Promise<FeishuCardActionResponse> {
    if (!this.leaveWorkflowService.isEnabled()) {
      throw new ServiceUnavailableException('请休假审批卡片未启用');
    }
    const result = parseLeaveLongConnectionCardAction(payload);
    if (result.kind === 'adjustment_no_change') {
      await this.leaveWorkflowService.assertSubstituteAdjustmentNoChange(result);
      return { toast: { type: 'info', content: '未选择调整人员，未提交变更' } };
    }
    if (result.kind === 'adjustment_view') {
      const card = await (this.leaveWorkflowService.renderSubstituteAdjustmentCardView(result));
      void this.leaveWorkflowService.patchSubstituteAdjustmentCardView(result, card).catch((error) => this.logger.error(`替班调整视图更新失败，可从原卡片重试：${safeErrorMessage(error)}`));
      return { toast: { type: 'info', content: '正在更新替班安排' } };
    }
    if (result.kind === 'view') {
      const viewInput = {
        recordId: result.recordId, stageKey: result.stageKey, stageVersion: result.stageVersion, actorOpenId: result.actorOpenId,
        messageId: result.messageId, view: result.view,
        ...(result.shiftSelections ? { shiftSelections: result.shiftSelections } : {}),
        ...(result.substituteRequired !== undefined ? { substituteRequired: result.substituteRequired } : {}),
      };
      const card = await (this.leaveWorkflowService.renderApprovalCardView(viewInput));
      void this.leaveWorkflowService.patchApprovalCardView(viewInput, card).catch((error) => this.logger.error(`请休假审批视图更新失败，可从原卡片重试：${safeErrorMessage(error)}`));
      return {
        toast: {
          type: 'info',
          content:
            result.view === 'rejection'
              ? '请填写驳回原因'
              : result.view === 'substitute_required'
                ? '请完成替班安排'
                : result.view === 'substitute_not_required'
                  ? '已选择无需替班'
                  : result.view === 'substitute_review'
                    ? '正在更新替班核对结果'
                    : '已返回审批',
        },
      };
    }
    if (result.kind === 'substitute_update') {
      const claim = await (this.leaveWorkflowService.acceptSubstituteUpdateAction({
          eventId: result.eventId,
          recordId: result.recordId,
          expectedRevision: result.expectedRevision,
          actorOpenId: result.actorOpenId,
          messageId: result.messageId,
          substitutePersonRecordId: result.substitutePersonRecordId,
          shiftSelections: result.shiftSelections,
        }));
      if (claim.claimed) {
        void this.leaveWorkflowService.runPendingTasks().catch((error) => {
          this.logger.error(
            `请休假替班调整已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
          );
        });
      }
      return {
        ...(claim.claimed ? ACCEPTED_RESPONSE : REPLAY_RESPONSE),
        card: toFeishuRawCardUpdate(claim.card),
      };
    }
    const claim = await (this.leaveWorkflowService.acceptApprovalAction({
        eventId: result.eventId,
        recordId: result.recordId,
        stageKey: result.stageKey,
        stageVersion: result.stageVersion,
        action: result.action,
        actorOpenId: result.actorOpenId,
        messageId: result.messageId,
        substituteRequired: result.substituteRequired,
        substitutePersonRecordId: result.substitutePersonRecordId,
        shiftSelections: result.shiftSelections,
        rejectionReason: result.rejectionReason,
      }));
    if (claim.claimed) {
      void this.leaveWorkflowService.runPendingTasks().catch((error) => {
        this.logger.error(
          `请休假审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
        );
      });
    }
    return {
      ...(claim.claimed ? ACCEPTED_RESPONSE : REPLAY_RESPONSE),
      card: toFeishuRawCardUpdate(claim.card),
    };
  }

  private async handleOvertime(
    payload: unknown,
  ): Promise<FeishuCardActionResponse> {
    if (!this.overtimeWorkflowService.isEnabled()) {
      throw new ServiceUnavailableException('加班审批卡片未启用');
    }
    const result = parseOvertimeLongConnectionCardAction(payload);
    const claim = await (this.overtimeWorkflowService.acceptApprovalAction({
        eventId: result.eventId,
        recordId: result.recordId,
        action: result.action,
        actorOpenId: result.actorOpenId,
        messageId: result.messageId,
      }));
    if (claim.claimed) {
      void this.overtimeWorkflowService.runPendingTasks().catch((error) => {
        this.logger.error(`加班审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`);
      });
    }
    return {
      ...(claim.claimed ? ACCEPTED_RESPONSE : REPLAY_RESPONSE),
      card: toFeishuRawCardUpdate(claim.card),
    };
  }

  private async handleInventoryOutbound(
    payload: unknown,
  ): Promise<FeishuCardActionResponse> {
    if (!this.inventoryOutboundApprovalService.isEnabled()) {
      throw new ServiceUnavailableException('出库审批卡片未启用');
    }
    const result = await (this.inventoryOutboundApprovalService.handleCardAction(payload));
    if (result.claimed) {
      void this.inventoryOutboundApprovalService.runPending().catch((error) => {
        this.logger.error(
          `出库审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
        );
      });
    }
    return {
      ...(result.toast
        ? { toast: { type: 'info' as const, content: result.toast } }
        : result.claimed
          ? ACCEPTED_RESPONSE
          : REPLAY_RESPONSE),
      card: toFeishuRawCardUpdate(result.card),
    };
  }

  private async handlePurchase(
    payload: unknown,
  ): Promise<FeishuCardActionResponse> {
    const result = parsePurchaseLongConnectionCardAction(
      payload,
      readPurchaseLongConnectionConfig(
        this.purchaseManagerApprovalService.isEnabled(),
      ),
    );
    if (result.kind === 'legacy_action') {
      assertFeishuBusinessIdentity(this.accessConfiguration, result.operatorOpenId);
      if (!this.purchaseWorkflowService.isEnabled()) {
        throw new ServiceUnavailableException('采购审批卡片未启用');
      }
      const claim = await (this.purchaseWorkflowService.acceptApprovalCardAction({
          eventId: result.eventId,
          recordId: result.executionRecordId,
          action: result.action,
          actorOpenId: result.operatorOpenId,
          ...(result.messageId ? { deliveryMessageId: result.messageId } : {}),
        }));
      return claim.claimed ? ACCEPTED_RESPONSE : REPLAY_RESPONSE;
    }

    if (result.kind === 'manager_batch_action') {
      return this.handlePurchaseManagerBatch(result);
    }

    if (result.kind === 'purchase_batch_fulfillment_action') {
      return this.handlePurchaseBatchFulfillment(result);
    }

    return this.handlePurchaseManager(result);
  }

  private async handleTodayOperationsAnomaly(
    payload: unknown,
  ): Promise<FeishuCardActionResponse> {
    if (!this.todayOperationsAnomalyService.isEnabled()) {
      throw new ServiceUnavailableException('今日航图异常提醒未启用');
    }
    const result = parseTodayOperationsAnomalyCardAction(payload);
    if (result.kind === 'view') {
      const card = await (this.todayOperationsAnomalyService.renderCardView({
          anomalyEventId: result.anomalyEventId,
          recordId: result.recordId,
          actorOpenId: result.actorOpenId,
          messageId: result.messageId,
          view: result.view,
        }));
      void this.todayOperationsAnomalyService
        .patchCardView(result.messageId, card)
        .catch((error) => {
          this.logger.warn(
            `今日航图异常卡片视图主动更新失败，已保留回调响应兜底：${safeErrorMessage(error)}`,
          );
        });
      return {
        toast: {
          type: 'info',
          content:
            result.view === 'resolution' ? '请填写处理措施' : '已返回异常详情',
        },
        card: toFeishuRawCardUpdate(card),
      };
    }
    const claim = await (this.todayOperationsAnomalyService.acceptTerminalAction({
        anomalyEventId: result.anomalyEventId,
        recordId: result.recordId,
        eventId: result.eventId,
        actorOpenId: result.actorOpenId,
        messageId: result.messageId,
        terminal: result.action,
        treatmentMeasure: result.treatmentMeasure,
      }));
    if (claim.claimed) {
      void this.todayOperationsAnomalyService
        .runPendingTasks()
        .catch((error) => {
          this.logger.error(
            `今日航图异常状态已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
          );
        });
    }
    return {
      ...(claim.claimed
        ? {
            toast: {
              type: 'info' as const,
              content:
                result.action === 'resolved' ? '处理结果已受理' : '已知悉',
            },
          }
        : REPLAY_RESPONSE),
      card: toFeishuRawCardUpdate(claim.card),
    };
  }

  private async handlePurchaseManager(
    result: Extract<PurchaseAction, { kind: 'manager_action' }>,
  ): Promise<FeishuCardActionResponse> {
    if (!this.purchaseManagerApprovalService.isEnabled()) {
      throw new ServiceUnavailableException('采购经理审批卡片未启用');
    }
    const card = await (this.purchaseManagerApprovalService.handleManagerCardAction(result));
    if (result.action === 'open_reject') {
      this.schedulePurchaseManagerViewPatch(result.messageId, result.operatorOpenId, false);
      return { toast: { type: 'info', content: '请填写驳回原因' } };
    }
    void this.purchaseManagerApprovalService.runAcceptedTasks().catch((error) => {
      this.logger.error(`采购审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`);
    });
    return { ...ACCEPTED_RESPONSE, card: toFeishuRawCardUpdate(card) };
  }

  private async handlePurchaseManagerBatch(
    result: Extract<PurchaseAction, { kind: 'manager_batch_action' }>,
  ): Promise<FeishuCardActionResponse> {
    if (!this.purchaseManagerApprovalService.isEnabled()) {
      throw new ServiceUnavailableException('采购批次审批卡片未启用');
    }
    const card = await (this.purchaseManagerApprovalService.handleManagerBatchCardAction(result));
    if (result.action === 'open_item_reject' || result.action === 'cancel_item_reject') {
      this.schedulePurchaseManagerViewPatch(result.messageId, result.operatorOpenId, true);
      return { toast: { type: 'info', content: result.action === 'open_item_reject' ? '请填写驳回原因' : '已返回审批列表' } };
    }
    if (
      result.action === 'approve_pending_comprehensive' ||
      result.action === 'approve_pending_building_self' ||
      result.action === 'submit_item_reject'
    ) {
      void this.purchaseManagerApprovalService
        .runAcceptedTasks()
        .catch((error) => {
          this.logger.error(
            `采购批次审批已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
          );
        });
    }
    return { ...ACCEPTED_RESPONSE, card: toFeishuRawCardUpdate(card) };
  }

  private schedulePurchaseManagerViewPatch(messageId: string, actorOpenId: string, batch: boolean): void {
    setImmediate(() => {
      void this.purchaseManagerApprovalService.patchManagerApprovalCardView(messageId, actorOpenId, batch)
        .catch(error => this.logger.error(`采购审批卡片视图切换失败，可由用户重试：${safeErrorMessage(error)}`));
    });
  }

  private async handlePurchaseBatchFulfillment(
    result: Extract<
      PurchaseAction,
      { kind: 'purchase_batch_fulfillment_action' }
    >,
  ): Promise<FeishuCardActionResponse> {
    if (!this.purchaseManagerApprovalService.isEnabled()) {
      throw new ServiceUnavailableException('采购批次履约卡片未启用');
    }
    const response = await (this.purchaseManagerApprovalService.handlePurchaseBatchFulfillmentCardAction(
        result,
      ));
    if (response.claimed) {
      void this.purchaseManagerApprovalService
        .runAcceptedTasks()
        .catch((error) => {
          this.logger.error(
            `采购履约操作已受理，但立即同步失败，将由后台重试：${safeErrorMessage(error)}`,
          );
        });
    }
    const isNavigation =
      result.action === 'open_order' ||
      result.action === 'return_purchase_list' ||
      result.action === 'open_receipt' ||
      result.action === 'return_receipt_list' ||
      result.action === 'prepare_receipt_photo' ||
      result.action === 'prepare_invoice';
    if (isNavigation) {
      setImmediate(() => {
        void this.purchaseManagerApprovalService
          .patchPurchaseBatchFulfillmentCardView(
            result.messageId,
            response.card,
            result.updateToken,
          )
          .catch((error) => {
            this.logger.error(
              `采购履约卡片视图切换失败，可由用户重试：${safeErrorMessage(error)}`,
            );
          });
      });
    }
    const callbackResponse: FeishuCardActionResponse = {
      toast: isNavigation
        ? {
            type: 'info',
            content:
              result.action === 'open_order'
                ? '请填写下单结果'
                : result.action === 'open_receipt'
                  ? '请填写签收信息'
                  : result.action === 'prepare_receipt_photo'
                    ? '请直接在当前会话发送签收照片'
                    : result.action === 'prepare_invoice'
                      ? '请直接在当前会话发送发票图片'
                      : '已返回任务列表',
          }
        : response.claimed
          ? { type: 'info', content: '操作已受理，正在后台同步' }
          : REPLAY_RESPONSE.toast,
    };
    return isNavigation
      ? callbackResponse
      : { ...callbackResponse, card: toFeishuRawCardUpdate(response.card) };
  }
}

function classifyCardAction(payload: unknown): CardActionKind {
  const event = requireObject(payload);
  if (
    event.event_type !== undefined &&
    event.event_type !== 'card.action.trigger'
  ) {
    throw new Error('飞书卡片回调事件类型无效');
  }
  const action = requireObject(event.action);
  if (
    typeof action.name === 'string' &&
    action.name.startsWith('threshold_reject_submit:')
  ) {
    return 'threshold_adjustment';
  }
  if (
    typeof action.name === 'string' &&
    action.name.startsWith('today_operations_resolve_submit:')
  ) {
    return 'today_operations_anomaly';
  }
  if (
    typeof action.name === 'string' &&
    action.name.startsWith('inventory_outbound_reject_submit:')
  ) {
    return 'inventory_outbound';
  }
  if (
    typeof action.name === 'string' &&
    (action.name.startsWith('leave_substitute_decision_submit:') ||
      action.name.startsWith('leave_substitute_review_submit:') ||
      action.name.startsWith('leave_substitute_review_update_submit:') ||
      action.name.startsWith('leave_approve_submit:') ||
      action.name.startsWith('leave_reject_submit:') ||
      action.name.startsWith('leave_substitute_update_submit:'))
  ) {
    return 'leave';
  }
  if (
    action.name === 'purchase_reject_submit' ||
    Object.prototype.hasOwnProperty.call(action, 'form_value')
  ) {
    return 'purchase';
  }
  const actionValue = requireObject(action.value);
  if (actionValue.workflowType === 'threshold_adjustment') {
    return 'threshold_adjustment';
  }
  if (actionValue.workflowType === 'today_operations_anomaly') {
    return 'today_operations_anomaly';
  }
  if (actionValue.workflowType === 'inventory_outbound') {
    return 'inventory_outbound';
  }
  if (actionValue.workflowType === 'leave') return 'leave';
  if (
    actionValue.version === 3 &&
    Object.prototype.hasOwnProperty.call(actionValue, 'approvalBatchId')
  ) {
    return 'purchase';
  }
  if (
    actionValue.version === 4 &&
    actionValue.workflowType === 'purchase_batch_fulfillment'
  ) {
    return 'purchase';
  }
  const value = actionValue;
  const hasOvertimeId = Object.prototype.hasOwnProperty.call(value, 'recordId');
  const hasPurchaseId = Object.prototype.hasOwnProperty.call(
    value,
    'executionRecordId',
  );
  if (hasOvertimeId === hasPurchaseId) {
    throw new Error('飞书卡片回调业务标识无效');
  }
  return hasOvertimeId ? 'overtime' : 'purchase';
}

function readPurchaseLongConnectionConfig(
  managerApprovalEnabled: boolean,
): PurchaseCardCallbackConfig {
  const legacyApproverOpenIds = Array.from(
    new Set(
      readEnv('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  return {
    // The long connection is authenticated by app credentials. This non-empty
    // sentinel only satisfies the shared HTTP/WS parser configuration contract.
    verificationToken: 'feishu_long_connection',
    ...(useConfiguredCardAuthorizationSnapshots() ? { authorizeFromDeliverySnapshot: true } : {}),
    encryptKey: '',
    legacyApproverOpenIds,
    managerApproverOpenId: !useConfiguredCardAuthorizationSnapshots() && managerApprovalEnabled ? readPurchaseManagerApprover().openId : '',
    managerApproverOpenIds: !useConfiguredCardAuthorizationSnapshots() && managerApprovalEnabled ? readPurchaseManagerApprovers().map(person => person.openId) : undefined,
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('飞书卡片回调格式无效');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('飞书卡片回调格式无效');
  }
  return value as Record<string, unknown>;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return 'unknown error';
  return error.message
    .replace(/\bc-[A-Za-z0-9_-]+\b/gu, '[redacted callback token]')
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 300);
}

function cardActionErrorResponse(error: unknown): FeishuCardActionResponse {
  if (error instanceof FeishuCardActionDeadlineError) {
    return { toast: { type: 'warning', content: '处理时间较长，请勿重复点击，稍后查看卡片状态' } };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status >= 400 && status < 500) {
      return {
        toast: {
          type: 'error',
          content: safeErrorMessage(error).slice(0, 100),
        },
      };
    }
  }
  return ERROR_RESPONSE;
}
