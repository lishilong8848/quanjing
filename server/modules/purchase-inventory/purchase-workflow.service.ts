import { businessAuthorizationSnapshot, businessPermissionScopeKey, canPerformBusinessAction, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { canAccessBuilding } from '../../../shared/building-access';
import { assertProfessionalRecordScope } from '../../common/access/professional-record-scope';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import type { ProfessionalSpecialty } from '../../../shared/professional-access';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal, AccessRole } from '../../../shared/access-control.interface';
import type {
  InventoryMovementCreateResponse,
  InventoryMovementItem,
} from '../../../shared/inventory-management.interface';
import type {
  PurchaseWorkflowAction,
  PurchaseWorkflowApprovalInput,
  PurchaseWorkflowCommandResult,
  PurchaseWorkflowDetail,
  PurchaseWorkflowOrderInput,
  PurchaseWorkflowRecord,
  PurchaseWorkflowReceiptInput,
  PurchaseWorkflowReminderCode,
  PurchaseWorkflowReminderRunResult,
  PurchaseWorkflowStage,
  PurchaseWorkflowTimelineItem,
  PurchaseWorkflowUser,
  PurchaseWorkflowSelfTestResponse,
} from '../../../shared/purchase-workflow.interface';
import { readEnv } from '../../common/config/external-services.config';
import { readConfiguredCardMembers, useConfiguredCardAuthorizationSnapshots } from '../../common/access/access-configuration.service';
import {
  buildInventoryInboundCompletedCard,
  buildManualInventoryInboundCompletedCard,
  buildPurchaseApprovalCard,
  buildTransferredPurchaseApprovalCard,
  buildResolvedPurchaseApprovalCard,
  buildWarehouseInboundCard,
  type PurchaseApprovalCardInput,
} from './purchase-workflow-card';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import {
  buildApprovalPatch,
  buildCardApprovalRoutingPatch,
  buildOrderPatch,
  buildReceiptPatch,
  buildStartPatch,
  normalizeMethod,
  resolveAllowedActions,
  resolvePurchaseStage,
  type PurchaseWorkflowFieldPatch,
  type PurchaseWorkflowDutyActor,
} from './purchase-workflow.rules';
import { mergeReceiptAttachmentTokens } from './purchase-receipt-material-policy';
import {
  PurchaseWorkflowStore,
  type PurchaseWorkflowCardActionEntry,
  type PurchaseWorkflowCommandEntry,
  type PurchaseWorkflowNotificationEntry,
  type PurchaseWorkflowNotificationInput,
  type PurchaseWorkflowNotificationKind,
  type PurchaseFulfillmentClaimProof,
  type PurchaseAcceptedFulfillment,
  type PurchaseWorkflowCardActionClaimInput,
} from './purchase-workflow.store';
import { parsePurchaseBatchFulfillmentCommandContext } from './purchase-batch-fulfillment-card';
import { purchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';
import { isPurchaseManagerApprovalEnabled, readPurchaseManagerApprovers } from './purchase-manager-approval.config';
import { InventoryBatchCardService } from '../inventory-outbound-approval/inventory-batch-card.service';
import { inventoryNotificationBatchId } from '../inventory-outbound-approval/inventory-batch-notification-id';
import { webReceiptInput, type WebReceiptInput } from './purchase-web-receipt-command';

export interface PurchaseWorkflowSession {
  acceptedFulfillment?: PurchaseAcceptedFulfillment;
  accessToken: string;
  openId: string;
  userName: string;
  permissionPrincipal?: import('../../../shared/access-control.interface').AccessPrincipal;
  accessRole?: AccessRole;
  purchaseBuilding?: string | null;
  purchaseBuildings?: import('../../../shared/access-control.interface').BuildingAdminBuilding[];
  specialties?: ProfessionalSpecialty[];
  authenticationMode?: 'delegated-app';
}

export interface PurchaseWebApprovalAuthority {
  recordId: string;
  scope: PurchaseAuthorityTarget;
  principal: AccessPrincipal;
  actorOpenId: string;
  approvalDutyKind?: 'purchase_manager' | 'purchase_approver';
}

const DISABLED_REASON = '程序工作流尚未接管，原飞书工作流仍在运行';
const HEALTHCHECK_MARKER = 'CODEX-PURCHASE-WORKFLOW-HEALTHCHECK';
const TASK_MAX_ATTEMPTS = 5;
const TASK_BATCH_MAX = 100;
const MANDATORY_INBOUND_NOTIFICATION_KINDS = [
  'inventory_inbound_completed_resolution',
  'inventory_inbound_completed',
  'manual_inventory_inbound_completed_resolution',
  'manual_inventory_inbound_completed',
  'purchase_completed',
  'purchase_order_completed',
] as const satisfies readonly PurchaseWorkflowNotificationKind[];
const DETAIL_CACHE_TTL_MS = 30_000;
const DETAIL_CACHE_MAX = 200;
const COMMAND_CLAIM_LEASE_MS = 60_000;
const ORDER_NOTICE_RECOVERY_BATCH_MAX = 5;
const WAREHOUSE_INBOUND_RECOVERY_SCAN_INTERVAL_MS = 60_000;
const COMPLETION_RECOVERY_SCAN_INTERVAL_MS = 60_000;
// Keep the first confirmed production activation as a stable replay boundary.
// Moving this on every restart would suppress legitimate pending work.
const DEFAULT_REMINDER_CUTOVER_AT_MS = Date.parse(
  '2026-09-28T20:56:27+08:00',
);
const UNKNOWN_UPDATE_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

export interface PurchaseWorkflowTaskRunResult {
  processed: number;
  failed: number;
  recoveredApprovalRequests: number;
  recoveredWarehouseInboundNotifications: number;
  recoveredCompletionNotifications: number;
  errors: string[];
}

interface ManualInventoryInboundCompletedContext {
  version: 1;
  movement: {
    recordId: string;
    sku: string;
    name: string;
    specification: string;
    quantity: number;
    unit: string;
    building: string;
    location: string;
    occurredAt: string | null;
  };
}

@Injectable()
export class PurchaseWorkflowService implements OnModuleDestroy {
  private readonly logger = new Logger(PurchaseWorkflowService.name);
  private taskRunInProgress = false;
  private orderNoticeRecovery: Promise<void> | null = null;
  private orderNoticeRecoveryCursor = '';
  private stopping = false;
  private nextWarehouseInboundRecoveryScanAt = 0;
  private nextCompletionRecoveryScanAt = 0;
  private readonly detailCache = new Map<
    string,
    { expiresAt: number; detail: PurchaseWorkflowDetail }
  >();
  private readonly detailRequests = new Map<
    string,
    Promise<PurchaseWorkflowDetail>
  >();
  private readonly runningCommands = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<PurchaseWorkflowCommandResult>;
    }
  >();

  constructor(
    private readonly gateway: PurchaseWorkflowGateway,
    private readonly store: PurchaseWorkflowStore,
    @Optional() private readonly batchCardService?: InventoryBatchCardService,
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  onModuleDestroy(): void {
    this.stopping = true;
  }

  async getDetail(
    recordId: string,
    session: PurchaseWorkflowSession,
  ): Promise<PurchaseWorkflowDetail> {
    const normalizedRecordId = requireText(recordId, '采购执行记录 ID 缺失');
    const cacheKey = this.detailCacheKey(normalizedRecordId, session);
    const cached = this.detailCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneWorkflowDetail(cached.detail);
    }
    if (cached) this.detailCache.delete(cacheKey);

    const existingRequest = this.detailRequests.get(cacheKey);
    if (existingRequest) return cloneWorkflowDetail(await existingRequest);

    const request = this.loadDetail(normalizedRecordId, session);
    this.detailRequests.set(cacheKey, request);
    try {
      const detail = await request;
      this.detailCache.set(cacheKey, {
        expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
        detail: cloneWorkflowDetail(detail),
      });
      this.pruneDetailCache();
      return cloneWorkflowDetail(detail);
    } finally {
      if (this.detailRequests.get(cacheKey) === request) {
        this.detailRequests.delete(cacheKey);
      }
    }
  }

  private async loadDetail(
    recordId: string,
    session: PurchaseWorkflowSession,
  ): Promise<PurchaseWorkflowDetail> {
    const record = await this.gateway.getExecutionRecord(recordId, session.accessToken);
    const actor = session.openId ? await this.resolveActor(session, record) : null;
    assertBuildingAdministratorWorkflowScope(record, session);
    const enabled = this.isEnabled();
    const adminOverride = session.accessRole === 'admin';
    const stage = resolvePurchaseStage(record.status);
    const resolvedActions = actor ? resolveAllowedActions(record, actor) : [];
    const pageWritebackEnabled = stage === 'ordering' || stage === 'receipt';
    return {
      record,
      stage,
      allowedActions:
        enabled || adminOverride
          ? resolvedActions
          : resolvedActions.filter(
              (action) => action === 'order' || action === 'receive',
            ),
      timeline: buildTimeline(stage),
      programEnabled: enabled || pageWritebackEnabled || adminOverride,
      disabledReason:
        enabled || pageWritebackEnabled || adminOverride ? '' : DISABLED_REASON,
    };
  }

  private detailCacheKey(
    recordId: string,
    session: PurchaseWorkflowSession,
  ): string {
    return [
      recordId,
      session.openId,
      session.accessRole || '',
      session.purchaseBuilding || '', JSON.stringify(session.purchaseBuildings || []),
      (session.specialties || []).join(','),
      session.permissionPrincipal ? businessPermissionScopeKey(session.permissionPrincipal) : '',
      session.authenticationMode || '',
    ].join(':');
  }

  private invalidateDetailCache(recordId: string): void {
    for (const key of this.detailCache.keys()) {
      if (key.startsWith(`${recordId}:`)) this.detailCache.delete(key);
    }
  }

  private pruneDetailCache(): void {
    const now = Date.now();
    for (const [key, value] of this.detailCache) {
      if (value.expiresAt <= now) this.detailCache.delete(key);
    }
    while (this.detailCache.size > DETAIL_CACHE_MAX) {
      const oldestKey = this.detailCache.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      this.detailCache.delete(oldestKey);
    }
  }

  async approve(
    recordId: string,
    session: PurchaseWorkflowSession,
    input: PurchaseWorkflowApprovalInput,
  ): Promise<PurchaseWorkflowCommandResult> {
    return this.execute(
      'approve',
      recordId,
      session,
      async (record, actor) => ({
        patch: buildApprovalPatch(record, actor, input),
        recipients: [record.requesterOpenId],
        message:
          input.decision === 'rejected' || input.purchaseMethod === '驳回'
            ? `采购申请 ${record.requestCode || record.itemName} 已驳回`
            : `采购申请 ${record.requestCode || record.itemName} 已审批通过`,
      }),
      input,
    );
  }

  async prepareWebApprovalAuthority(recordId: string, session: PurchaseWorkflowSession): Promise<PurchaseWebApprovalAuthority> {
    if (!this.accessConfiguration) throw new ServiceUnavailableException('采购审批当前授权端口未配置');
    if (!session.permissionPrincipal?.accountId) throw new ForbiddenException('需要有效的采购审批登录身份');
    const record = await this.gateway.getExecutionRecord(recordId, session.accessToken);
    const scope = purchaseAuthorityTarget(record);
    if (record.recordId !== recordId || !scope) throw new ConflictException('采购审批记录或授权范围不明确');
    const actor = await this.resolveActor(session, record);
    this.assertCurrentCommandAuthority('approve', record, session, actor);
    if (!resolveAllowedActions(record, actor).includes('approve')) throw new ForbiddenException('当前人员或阶段无权审批该采购申请');
    return { recordId, scope, principal: businessAuthorizationSnapshot(session.permissionPrincipal), actorOpenId: session.openId,
      ...(actor.approvalDutyKind ? { approvalDutyKind: actor.approvalDutyKind } : {}) };
  }

  assertWebApprovalAuthority(authority: PurchaseWebApprovalAuthority, record: PurchaseWorkflowRecord): void {
    const scope = purchaseAuthorityTarget(record);
    if (record.recordId !== authority.recordId || !scope || scope.building !== authority.scope.building || scope.specialty !== authority.scope.specialty) throw new ConflictException('采购审批记录范围已变化，请重新核对');
    const session: PurchaseWorkflowSession = { accessToken: '', openId: authority.actorOpenId, userName: '', accessRole: authority.principal.role, permissionPrincipal: authority.principal };
    this.assertCurrentCommandAuthority('approve', record, session, { openId: authority.actorOpenId, name: '', positions: [], buildings: [], approvalDutyKind: authority.approvalDutyKind });
    if (resolvePurchaseStage(record.status) !== 'application') throw new ConflictException('采购申请已处于其他流程阶段');
  }

  async start(
    recordId: string,
    session: PurchaseWorkflowSession,
  ): Promise<PurchaseWorkflowCommandResult> {
    return this.execute('start', recordId, session, async (record, actor) => {
      const comprehensivePurchaser =
        record.purchaseMethod === '综合采购'
          ? await this.gateway.findComprehensivePurchaser(session.accessToken,{building:record.building,specialty:record.specialty})
          : actor;
      const patch = buildStartPatch(record, actor, comprehensivePurchaser);
      const purchaser = firstUserOpenId(patch['采购人']);
      return {
        patch,
        recipients: [record.requesterOpenId, purchaser],
        message: `采购任务 ${record.requestCode || record.itemName} 已启动，请采购人跟进下单`,
      };
    });
  }

  async order(
    recordId: string,
    session: PurchaseWorkflowSession,
    input: PurchaseWorkflowOrderInput,
  ): Promise<PurchaseWorkflowCommandResult> {
    return this.execute(
      'order',
      recordId,
      session,
      async (record, actor) => ({
        patch: buildOrderPatch(record, actor, input),
        recipients: [record.requesterOpenId, record.purchaserOpenId],
        message: `采购任务 ${record.requestCode || record.itemName} 已下单，等待到货签收`,
      }),
      input,
    );
  }

  async orderFromCard(
    recordId: string,
    actorOpenId: string,
    input: PurchaseWorkflowOrderInput,
    proof?: PurchaseFulfillmentClaimProof,
  ): Promise<PurchaseWorkflowCommandResult> {
    const session = await this.acceptedCardSession(await this.appCardSession(actorOpenId),recordId,'order',input,proof);
    return this.execute(
      'order',
      recordId,
      session,
      async (record, actor) => ({
        patch: buildOrderPatch(record, actor, input),
        recipients: [],
        message: '',
      }),
      input,
    );
  }

  async prepareReceiptSubmission(recordId: string, session: PurchaseWorkflowSession, input: WebReceiptInput, hasInvoice: boolean) {
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    if (!/^cli_[A-Za-z0-9_-]+$/.test(appId)) throw new ServiceUnavailableException('采购应用身份尚未配置');
    const record = await this.gateway.getExecutionRecord(recordId, session.accessToken);
    const actor = await this.resolveActor(session, record), scope = purchaseAuthorityTarget(record);
    if (record.recordId !== recordId || !scope) throw new ConflictException('采购记录范围尚未明确');
    assertBuildingAdministratorWorkflowScope(record, session);
    if (this.accessConfiguration) this.assertCurrentCommandAuthority('receive', record, session);
    try { buildReceiptPatch(record, actor, { ...input, receiptPhotoTokens: ['validation-only'], invoiceTokens: hasInvoice ? ['validation-only'] : [] }); }
    catch (error) { throw mapRuleError(error); }
    return { appId, record, actor, scope };
  }

  assertReceiptSubmissionCurrent(prepared: Awaited<ReturnType<PurchaseWorkflowService['prepareReceiptSubmission']>>, session: PurchaseWorkflowSession): void {
    if (prepared.appId !== process.env.FEISHU_APP_ID?.trim()) throw new ConflictException('采购应用身份已变化，请重新提交');
    if (this.accessConfiguration) this.assertCurrentCommandAuthority('receive', prepared.record, session);
  }

  assertReceiptTaskReadable(scope: { building: string; specialty?: string }, session: PurchaseWorkflowSession): void {
    if (!this.accessConfiguration) throw new ForbiddenException('采购人员权限尚未就绪');
    const principal = session.permissionPrincipal;
    if (principal) {
      const current = this.accessConfiguration.currentPrincipal(principal.accountId, principal.authorizationVersion);
      if (current && current.role === session.accessRole && canPerformBusinessAction(current, { module: 'purchase', action: 'read', ...scope })) return;
    } else if (!session.accessRole) { assertFeishuBusinessIdentity(this.accessConfiguration, session.openId); return; }
    throw new ForbiddenException('当前无权查看此签收任务');
  }

  async receiveAcceptedReceipt(proof: PurchaseFulfillmentClaimProof): Promise<PurchaseWorkflowCommandResult> {
    const task = await this.store.getNotification(proof.notificationKey), payload = task?.webReceipt;
    if (!task || task.kind !== 'web_receipt_command' || !payload) throw new ConflictException('原网页签收任务不存在');
    const accepted = await this.store.readAcceptedFulfillmentCommand(proof, task.recordId, 'receive', payload.actor.openId);
    const session = { ...await this.appCardSession(payload.actor.openId), acceptedFulfillment: accepted };
    return this.receive(task.recordId, session, webReceiptInput(payload));
  }

  async receive(
    recordId: string,
    session: PurchaseWorkflowSession,
    input: PurchaseWorkflowReceiptInput,
  ): Promise<PurchaseWorkflowCommandResult> {
    const result = await this.execute(
      'receive',
      recordId,
      session,
      async (record, actor) => ({
        patch: buildReceiptPatch(record, actor, input),
        recipients: [record.requesterOpenId, record.purchaserOpenId],
        message: `采购任务 ${record.requestCode || record.itemName} 已完成签收并进入库存交接`,
      }),
      input,
    );
    try {
      await this.enqueueWarehouseInboundNotifications(recordId);
    } catch (error) {
      return {
        ...result,
        notificationWarnings: [
          ...result.notificationWarnings,
          errorMessage(error),
        ],
      };
    }
    return result;
  }

  async receiveFromCard(
    recordId: string,
    actorOpenId: string,
    input: PurchaseWorkflowReceiptInput,
    proof?: PurchaseFulfillmentClaimProof,
  ): Promise<PurchaseWorkflowCommandResult> {
    const session = await this.acceptedCardSession(await this.appCardSession(actorOpenId),recordId,'receive',input,proof);
    const result = await this.execute(
      'receive',
      recordId,
      session,
      async (record, actor) => ({
        patch: buildReceiptPatch(record, actor, input),
        recipients: [],
        message: '',
      }),
      input,
    );
    try {
      await this.enqueueWarehouseInboundNotifications(recordId);
    } catch (error) {
      return {
        ...result,
        notificationWarnings: [
          ...result.notificationWarnings,
          errorMessage(error),
        ],
      };
    }
    return result;
  }

  async acceptApprovalCardAction(input: PurchaseWorkflowCardActionClaimInput) {
    if (!this.accessConfiguration) throw new ServiceUnavailableException('采购审批鉴权端口未配置');
    const appId = process.env.FEISHU_APP_ID?.trim();
    if (!appId || !/^cli_[A-Za-z0-9_-]+$/.test(appId)) throw new ServiceUnavailableException('采购审批应用身份未配置');
    const record = await this.gateway.getExecutionRecordAsApp(input.recordId), scope = purchaseAuthorityTarget(record);
    if (record.recordId !== input.recordId || !scope) throw new ConflictException('采购审批记录或授权范围不明确');
    const configured = this.accessConfiguration.currentDutyRoutePeople('purchase_approver', scope);
    const fallback = configured === null ? await this.gateway.resolveConfiguredApproversAsApp(scope) : configured;
    return this.store.claimCardAction(input, new Date(), () => {
      if (!input.deliveryMessageId) throw new ForbiddenException('采购审批原消息凭据缺失，请使用新审批卡办理');
      assertFeishuBusinessIdentity(this.accessConfiguration, input.actorOpenId);
      if (appId !== process.env.FEISHU_APP_ID?.trim()) throw new ConflictException('采购审批应用身份已变化');
      const current = this.accessConfiguration!.currentDutyRoutePeople('purchase_approver', scope) ?? fallback;
      if (!current.some(person => person.openId === input.actorOpenId)) throw new ForbiddenException('当前采购审批岗位已变化，请使用现任人员的新卡片');
      if (resolvePurchaseStage(record.status) !== 'application') throw new ConflictException('采购申请已处于其他流程阶段');
      return { appId, scope };
    });
  }

  async enqueueApprovalRequests(recordId: string): Promise<void> {
    if (!this.isEnabled() || isPurchaseManagerApprovalEnabled()) return;
    const normalizedRecordId = requireText(recordId, '采购执行记录 ID 缺失');
    const record = await this.gateway.getExecutionRecordAsApp(normalizedRecordId);
    const approvers = await this.gateway.resolveConfiguredApproversAsApp({ building: record.building, specialty: record.specialty });
    await this.store.enqueueNotifications(
      approvers.map((approver) => ({
        businessEventId: `approval-requested:${normalizedRecordId}`,
        recordId: normalizedRecordId,
        recipientOpenId: approver.openId,
        kind: 'approval_requested' as const,
      })),
    );
  }

  async enqueueWarehouseInboundNotifications(
    recordId: string,
  ): Promise<number> {
    if (!this.isEnabled()) return 0;
    const normalizedRecordId = requireText(recordId, '采购执行记录 ID 缺失');
    const record =
      await this.gateway.getExecutionRecordAsApp(normalizedRecordId);
    if (resolvePurchaseStage(record.status) !== 'inbound') return 0;
    const managers = await this.gateway.resolveInboundResponsibleUsersAsApp(
      record.building,
    );
    const recipients = [
      ...new Map(managers.map((manager) => [manager.openId, manager])).values(),
    ];
    const results = await this.store.enqueueNotifications(
      recipients.map((manager) => ({
        businessEventId: `warehouse-inbound:${normalizedRecordId}`,
        recordId: normalizedRecordId,
        recipientOpenId: manager.openId,
        kind: 'warehouse_inbound' as const,
      })),
    );
    return results.filter((result) => result.enqueued).length;
  }

  async enqueueCompletionNotifications(
    recordId: string,
    movement?: InventoryMovementItem,
  ): Promise<number> {
    const normalizedRecordId = requireText(recordId, '采购执行记录 ID 缺失');
    const cardContext = movement
      ? JSON.stringify({
          version: 1,
          sku: movement.sku,
          specification: movement.specification,
          location: movement.location,
          batchId: inventoryNotificationBatchId(movement.clientMutationId, 'inbound'),
        })
      : '';
    const results = await this.store.enqueueNotifications([
      {
        businessEventId: `inventory-inbound-completed-resolution:${normalizedRecordId}`,
        recordId: normalizedRecordId,
        recipientOpenId: 'system',
        kind: 'inventory_inbound_completed_resolution' as const,
        ...(cardContext ? { cardContext } : {}),
      },
    ]);
    let enqueued = results.filter((result) => result.enqueued).length;
    if (movement) {
      const recipients =
        await this.gateway.getCachedInboundCompletionRecipients(
          movement.building,
        );
      if (recipients?.length) {
        const cards = await this.store.enqueueNotifications(
          recipients.map((recipientOpenId) => ({
            businessEventId: `inventory-inbound-completed:${normalizedRecordId}`,
            recordId: normalizedRecordId,
            recipientOpenId,
            kind: 'inventory_inbound_completed' as const,
            cardContext,
          })),
        );
        enqueued += cards.filter((result) => result.enqueued).length;
      }
    }
    return enqueued;
  }

  async refreshWarehouseRecipientCacheIfDue(): Promise<void> {
    await this.gateway.refreshWarehouseRecipientCacheIfDue();
  }

  async ensureManualInboundCompletionNotification(
    result: InventoryMovementCreateResponse,
  ): Promise<void> {
    const context = normalizeManualInboundCompletedContext(result);
    await this.store.enqueueNotifications([
      {
        businessEventId: `manual-inventory-inbound-completed-resolution:${context.movement.recordId}`,
        recordId: context.movement.recordId,
        recipientOpenId: 'system',
        kind: 'manual_inventory_inbound_completed_resolution',
        cardContext: JSON.stringify(context),
      },
    ]);
  }

  async runPendingTasks(
    limit = 20,
    now = new Date(),
  ): Promise<PurchaseWorkflowTaskRunResult> {
    const result: PurchaseWorkflowTaskRunResult = {
      processed: 0,
      failed: 0,
      recoveredApprovalRequests: 0,
      recoveredWarehouseInboundNotifications: 0,
      recoveredCompletionNotifications: 0,
      errors: [],
    };
    if (this.stopping) return result;
    if (this.taskRunInProgress) {
      throw new ConflictException('采购工作流后台任务正在运行');
    }
    this.taskRunInProgress = true;
    const batchLimit = Math.max(1, Math.min(TASK_BATCH_MAX, Math.floor(limit) || 1));
    try {
      const workflowEnabled = this.isEnabled();
      const handledBeforeRecovery = await this.processAvailableTasks(
        batchLimit,
        now,
        result,
        workflowEnabled,
      );
      if (handledBeforeRecovery >= batchLimit) return result;

      let remainingRecoveryCapacity = batchLimit - handledBeforeRecovery;
      if (workflowEnabled) {
        try {
          result.recoveredApprovalRequests = isPurchaseManagerApprovalEnabled()
            ? 0
            : await this.recoverMissingApprovalRequests(
                remainingRecoveryCapacity,
              );
          remainingRecoveryCapacity = Math.max(
            0,
            remainingRecoveryCapacity - result.recoveredApprovalRequests,
          );
        } catch (error) {
          result.failed += 1;
          result.errors.push(`审批通知补偿扫描失败: ${errorMessage(error)}`);
        }
        if (remainingRecoveryCapacity > 0) {
          try {
            result.recoveredWarehouseInboundNotifications =
              await this.recoverMissingWarehouseInboundNotifications(
                remainingRecoveryCapacity,
                result,
                now,
              );
            remainingRecoveryCapacity = Math.max(
              0,
              remainingRecoveryCapacity -
                result.recoveredWarehouseInboundNotifications,
            );
          } catch (error) {
            result.failed += 1;
            result.errors.push(`入库通知补偿扫描失败: ${errorMessage(error)}`);
          }
        }
        try {
          result.recoveredCompletionNotifications =
            await this.recoverMissingCompletionNotifications(
              remainingRecoveryCapacity,
              result,
              now,
              true,
            );
        } catch (error) {
          result.failed += 1;
          result.errors.push(
            `采购完成通知补偿扫描失败: ${errorMessage(error)}`,
          );
        }
      } else {
        try {
          result.recoveredCompletionNotifications =
            await this.recoverMissingCompletionNotifications(
              remainingRecoveryCapacity,
              result,
              now,
              false,
            );
        } catch (error) {
          result.failed += 1;
          result.errors.push(
            `采购完成通知补偿扫描失败: ${errorMessage(error)}`,
          );
        }
      }

      await this.processAvailableTasks(
        batchLimit - handledBeforeRecovery,
        now,
        result,
        workflowEnabled,
      );
      return result;
    } finally {
      this.taskRunInProgress = false;
      this.startOrderNoticeRecovery(batchLimit, now);
    }
  }

  private startOrderNoticeRecovery(limit: number, now: Date): void {
    if (this.stopping || this.orderNoticeRecovery) return;
    // Slow reconciliation must not hold the scheduler that also runs receipt and inbound work.
    const recovery = this.recoverPendingOrderNotices(Math.min(limit, ORDER_NOTICE_RECOVERY_BATCH_MAX), now)
      .catch(error => {
        if (!this.stopping) this.logger.warn(`下单通知恢复失败：${errorMessage(error).slice(0, 300)}`);
      })
      .finally(() => {
        if (this.orderNoticeRecovery === recovery) this.orderNoticeRecovery = null;
      });
    this.orderNoticeRecovery = recovery;
  }

  private async recoverPendingOrderNotices(
    limit: number,
    now: Date,
  ): Promise<void> {
    const commands = await this.store.listPendingOrderNoticeCommands(limit, this.orderNoticeRecoveryCursor);
    for (const command of commands) {
      if (this.stopping) return;
      this.orderNoticeRecoveryCursor = command.key;
      if (!isExpiredCommandClaim(command.startedAt, now.getTime())) continue;
      try {
        const record = await this.gateway.getExecutionRecordAsApp(command.recordId);
        if (this.stopping) return;
        if (record.recordId !== command.recordId || !hasActionReachedPostState('order', record.status)) continue;
        if (!doesCommandResultMatchExpected('order', record, command.expectedResultFingerprint)) {
          throw new ConflictException('采购执行结果与原下单通知意图不一致，请核对');
        }
        await this.store.completePendingOrderNoticeCommand(command, now);
      } catch (error) {
        if (!this.stopping) this.logger.warn(`下单通知恢复 ${command.recordId}: ${errorMessage(error).slice(0, 300)}`);
      }
    }
  }

  private async processAvailableTasks(
    limit: number,
    now: Date,
    result: PurchaseWorkflowTaskRunResult,
    workflowEnabled: boolean,
  ): Promise<number> {
    let handled = 0;
    while (handled < limit) {
      const notification = await this.store.takeNextNotification(
        now,
        undefined,
        workflowEnabled ? undefined : MANDATORY_INBOUND_NOTIFICATION_KINDS,
      );
      if (notification) {
        const notifications = [notification];
        while (notifications.length < 4 && handled + notifications.length < limit) {
          const next = await this.store.takeNextNotification(
            now,
            undefined,
            workflowEnabled ? undefined : MANDATORY_INBOUND_NOTIFICATION_KINDS,
          );
          if (!next) break;
          notifications.push(next);
        }
        handled += notifications.length;
        const outcomes = await Promise.all(
          notifications.map((entry) => this.processNotification(entry, now, result)),
        );
        result.processed += outcomes.filter(Boolean).length;
        continue;
      }
      if (!workflowEnabled) break;
      const action = await this.store.takeNextCardAction(now);
      if (!action) break;
      handled += 1;
      const succeeded = await this.processCardAction(action, now, result);
      if (succeeded) result.processed += 1;
    }
    return handled;
  }

  async runReminders(
    code: PurchaseWorkflowReminderCode,
    now = new Date(),
  ): Promise<PurchaseWorkflowReminderRunResult> {
    const startedAt = now.toISOString();
    const result: PurchaseWorkflowReminderRunResult = {
      code,
      startedAt,
      finishedAt: startedAt,
      processed: 0,
      failed: 0,
      errors: [],
    };
    if (!this.isEnabled())
      return { ...result, finishedAt: new Date().toISOString() };

    const candidates = (await this.gateway.listExecutionRecordsAsApp()).filter(
      (record) =>
        !isHealthcheckRecord(record.requestCode) &&
        reminderRecordCreatedAtMs(record) >= DEFAULT_REMINDER_CUTOVER_AT_MS &&
        reminderMatches(code, record.status, record.purchaseCompleted),
    );
    const date = shanghaiDate(now);
    for (const record of candidates) {
      const key = `${code}:${record.recordId}:${date}`;
      if (await this.store.hasReminder(key)) continue;
      try {
        const recipient =
          code === 'receipt' ? record.requesterOpenId : record.purchaserOpenId;
        await this.gateway.sendTextNotification(
          [recipient],
          reminderMessage(code, record.requestCode || record.itemName),
        );
        await this.store.recordReminder(key);
        result.processed += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push(`${record.recordId}: ${errorMessage(error)}`);
      }
    }
    result.finishedAt = new Date().toISOString();
    return result;
  }

  async selfTest(
    session: PurchaseWorkflowSession,
  ): Promise<PurchaseWorkflowSelfTestResponse> {
    this.assertEnabled(session.accessRole);
    const deleteCapability = await this.gateway.probeDeleteCapability(
      session.accessToken,
    );
    const reusableSentinel = !deleteCapability.allowed;
    const marker = reusableSentinel
      ? HEALTHCHECK_MARKER
      : `CODEX-PURCHASE-WORKFLOW-SELFTEST-${Date.now()}`;
    const checks: PurchaseWorkflowSelfTestResponse['checks'] = [];
    const createdRecordIds: string[] = [];
    const deletedRecordIds: string[] = [];
    let remainingRecordIds: string[] = [];
    let activeRecordId = '';
    checks.push({
      name: '清理策略',
      passed: true,
      message: reusableSentinel
        ? `删除权限不可用，复用隔离健康检查哨兵：${deleteCapability.reason}`
        : '删除权限可用，使用临时记录并在结束后精确删除',
    });

    try {
      if (reusableSentinel) {
        const existing = await this.gateway.searchSelfTestRecordIds(
          marker,
          session.accessToken,
        );
        if (existing.length > 1) {
          throw new Error(`健康检查哨兵重复：${existing.join(', ')}`);
        }
        activeRecordId = existing[0] || '';
      }
      if (!activeRecordId) {
        activeRecordId = await this.gateway.createExecutionRecord(
          selfTestExecutionFields(marker, session.openId),
          session.accessToken,
        );
        createdRecordIds.push(activeRecordId);
      }
      if (reusableSentinel) {
        await this.gateway.updateExecutionRecord(
          activeRecordId,
          sentinelResetFields('未开始（待审批）'),
          session.accessToken,
        );
      }
      const actor = await this.resolveActor(session);

      let record = await this.gateway.getExecutionRecord(
        activeRecordId,
        session.accessToken,
      );
      await this.gateway.updateExecutionRecord(
        activeRecordId,
        buildApprovalPatch(record, actor, {
          decision: 'approved',
          purchaseMethod: '综合采购',
          comment: '程序闭环自测',
        }),
        session.accessToken,
      );
      record = await this.gateway.getExecutionRecord(
        activeRecordId,
        session.accessToken,
      );
      const purchaser = await this.gateway.findComprehensivePurchaser(
        session.accessToken,
      );
      await this.gateway.updateExecutionRecord(
        activeRecordId,
        buildStartPatch(record, actor, purchaser),
        session.accessToken,
      );
      record = await this.gateway.getExecutionRecord(
        activeRecordId,
        session.accessToken,
      );
      await this.gateway.updateExecutionRecord(
        activeRecordId,
        buildOrderPatch(record, purchaser, {
          actualQuantity: 1,
          actualAmount: 1,
          paymentAttachmentTokens: [],
          note: '程序闭环自测',
        }),
        session.accessToken,
      );
      record = await this.gateway.getExecutionRecord(
        activeRecordId,
        session.accessToken,
      );
      const receiptPhotoToken =
        record.receiptPhotoTokens[0] ||
        (await this.gateway.uploadAttachment(
          selfTestReceiptPhoto(),
          session.accessToken,
        ));
      await this.gateway.updateExecutionRecord(
        activeRecordId,
        buildReceiptPatch(record, actor, {
          signer: actor.name || session.userName,
          signerOpenId: actor.openId,
          receiptTime: Date.now(),
          receiptPhotoTokens: [receiptPhotoToken],
          invoiceTokens: [],
          note: '程序闭环自测',
        }),
        session.accessToken,
      );
      checks.push({
        name: '采购闭环',
        passed: true,
        message: '审批、启动、下单、签收均写入成功',
      });
    } catch (error) {
      checks.push({
        name: '采购闭环',
        passed: false,
        message: errorMessage(error),
      });
    } finally {
      let cleanupPassed = true;
      const cleanupErrors: string[] = [];
      if (reusableSentinel && activeRecordId) {
        try {
          await this.gateway.updateExecutionRecord(
            activeRecordId,
            sentinelResetFields('驳回申请'),
            session.accessToken,
          );
        } catch (error) {
          cleanupPassed = false;
          cleanupErrors.push(`哨兵重置失败: ${errorMessage(error)}`);
        }
      } else {
        for (const recordId of createdRecordIds) {
          try {
            await deleteWithRetry(() =>
              this.gateway.deleteExecutionRecord(recordId, session.accessToken),
            );
            deletedRecordIds.push(recordId);
          } catch (error) {
            cleanupPassed = false;
            cleanupErrors.push(`${recordId}: ${errorMessage(error)}`);
          }
        }
      }
      try {
        const found = await this.gateway.searchSelfTestRecordIds(
          marker,
          session.accessToken,
        );
        if (reusableSentinel) {
          cleanupPassed =
            cleanupPassed && found.length === 1 && found[0] === activeRecordId;
          if (!cleanupPassed && !cleanupErrors.length) {
            cleanupErrors.push(
              `健康检查哨兵数量异常：${found.join(', ') || '0 条'}`,
            );
          }
          remainingRecordIds = [];
        } else {
          remainingRecordIds = found;
        }
      } catch (error) {
        cleanupPassed = false;
        cleanupErrors.push(`残留查询失败: ${errorMessage(error)}`);
      }
      if (remainingRecordIds.length) cleanupPassed = false;
      checks.push({
        name: '清理测试记录',
        passed: cleanupPassed,
        message: cleanupPassed
          ? reusableSentinel
            ? '唯一健康检查哨兵已重置，不产生累计测试数据'
            : '测试记录已精确删除且残留为 0'
          : cleanupErrors.join('；') || `残留 ${remainingRecordIds.join(', ')}`,
      });
    }

    return {
      passed:
        checks.every((check) => check.passed) &&
        remainingRecordIds.length === 0,
      marker,
      checks,
      createdRecordIds,
      deletedRecordIds,
      remainingRecordIds,
    };
  }

  isEnabled(): boolean {
    return /^(1|true|yes|on)$/i.test(
      readEnv('PURCHASE_WORKFLOW_PROGRAM_ENABLED'),
    );
  }

  assertEnabled(accessRole?: AccessRole): void {
    if (!this.isEnabled() && accessRole !== 'admin') {
      throw new ServiceUnavailableException(DISABLED_REASON);
    }
  }

  private async recoverMissingApprovalRequests(limit: number): Promise<number> {
    const candidates = (await this.gateway.listExecutionRecordsAsApp()).filter(
      (record) =>
        !isHealthcheckRecord(record.requestCode) &&
        resolvePurchaseStage(record.status) === 'application',
    );
    let recovered = 0;
    for (const record of candidates) {
      const existing = await this.store.listNotifications({
        recordId: record.recordId,
        kind: 'approval_requested',
      });
      const knownRecipients = new Set(
        existing.map((notification) => notification.recipientOpenId),
      );
      if (existing.length && useConfiguredCardAuthorizationSnapshots()) continue;
      const approvers = await this.gateway.resolveConfiguredApproversAsApp({ building: record.building, specialty: record.specialty });
      const remainingCapacity = limit - recovered;
      const missing = approvers
        .filter((approver) => !knownRecipients.has(approver.openId))
        .slice(0, remainingCapacity);
      if (!missing.length) continue;
      const results = await this.store.enqueueNotifications(
        missing.map((approver) => ({
          businessEventId: `approval-requested:${record.recordId}`,
          recordId: record.recordId,
          recipientOpenId: approver.openId,
          kind: 'approval_requested' as const,
        })),
      );
      recovered += results.filter((result) => result.enqueued).length;
      if (recovered >= limit) break;
    }
    return recovered;
  }

  private async recoverMissingWarehouseInboundNotifications(
    limit: number,
    result: PurchaseWorkflowTaskRunResult,
    now: Date,
  ): Promise<number> {
    if (limit <= 0) return 0;
    if (now.getTime() < this.nextWarehouseInboundRecoveryScanAt) return 0;
    this.nextWarehouseInboundRecoveryScanAt =
      now.getTime() + WAREHOUSE_INBOUND_RECOVERY_SCAN_INTERVAL_MS;
    const candidates = (await this.gateway.listExecutionRecordsAsApp()).filter(
      (record) =>
        !isHealthcheckRecord(record.requestCode) &&
        resolvePurchaseStage(record.status) === 'inbound',
    );
    let recovered = 0;
    for (const record of candidates) {
      if (recovered >= limit) break;
      try {
        const managers = await this.gateway.resolveInboundResponsibleUsersAsApp(
          record.building,
        );
        const existing = await this.store.listNotifications({
          recordId: record.recordId,
          kind: 'warehouse_inbound',
        });
        const knownRecipients = new Set(
          existing.map((notification) => notification.recipientOpenId),
        );
        const remainingCapacity = limit - recovered;
        const missing = [
          ...new Map(
            managers.map((manager) => [manager.openId, manager]),
          ).values(),
        ]
          .filter((manager) => !knownRecipients.has(manager.openId))
          .slice(0, remainingCapacity);
        if (!missing.length) continue;
        const results = await this.store.enqueueNotifications(
          missing.map((manager) => ({
            businessEventId: `warehouse-inbound:${record.recordId}`,
            recordId: record.recordId,
            recipientOpenId: manager.openId,
            kind: 'warehouse_inbound' as const,
          })),
        );
        recovered += results.filter(
          (enqueueResult) => enqueueResult.enqueued,
        ).length;
      } catch (error) {
        result.failed += 1;
        result.errors.push(
          `${record.recordId}: 入库通知补偿失败: ${errorMessage(error)}`,
        );
      }
    }
    return recovered;
  }

  private async recoverMissingCompletionNotifications(
    limit: number,
    result: PurchaseWorkflowTaskRunResult,
    now: Date,
    includePurchaseRecipients: boolean,
  ): Promise<number> {
    if (limit <= 0) return 0;
    if (now.getTime() < this.nextCompletionRecoveryScanAt) return 0;
    this.nextCompletionRecoveryScanAt =
      now.getTime() + COMPLETION_RECOVERY_SCAN_INTERVAL_MS;
    const candidates = (await this.gateway.listExecutionRecordsAsApp()).filter(
      (record) =>
        !isHealthcheckRecord(record.requestCode) &&
        resolvePurchaseStage(record.status) === 'completed',
    );
    let recovered = 0;
    for (const record of candidates) {
      if (recovered >= limit) break;
      try {
        const warehouseNotifications = await this.store.listNotifications({
          recordId: record.recordId,
          kind: 'warehouse_inbound',
        });
        const receiveCommand = warehouseNotifications.length
          ? null
          : await this.store.findCommand(`receive:${record.recordId}`);
        if (!warehouseNotifications.length && !receiveCommand) continue;

        const completionRecipientsRead = includePurchaseRecipients
          ? this.resolveCompletionRecipients(record.requesterOpenId,record).catch(
              (error) => {
                this.logger.warn(
                  `采购完成补偿收件人解析失败：${errorMessage(error)}`,
                );
                return [] as string[];
              },
            )
          : Promise.resolve([] as string[]);
        const [
          inboundRecipients,
          completionRecipients,
          existingInbound,
          existingPurchase,
        ] = await Promise.all([
          this.resolveInboundCompletionRecipients(record.building),
          completionRecipientsRead,
          this.store.listNotifications({
            recordId: record.recordId,
            kind: 'inventory_inbound_completed',
          }),
          this.store.listNotifications({
            recordId: record.recordId,
            kind: 'purchase_completed',
          }),
        ]);
        const knownInboundRecipients = new Set(
          existingInbound.map((notification) => notification.recipientOpenId),
        );
        const legacyPurchaseRecipients = new Set(
          existingPurchase.map((notification) => notification.recipientOpenId),
        );
        const inputs: PurchaseWorkflowNotificationInput[] = [
          ...new Set([
            ...inboundRecipients.recipientOpenIds,
            ...completionRecipients.filter(
              (recipientOpenId) =>
                !legacyPurchaseRecipients.has(recipientOpenId),
            ),
          ]),
        ]
          .filter(
            (recipientOpenId) => !knownInboundRecipients.has(recipientOpenId),
          )
          .slice(0, limit - recovered)
          .map((recipientOpenId) => ({
            businessEventId: `inventory-inbound-completed:${record.recordId}`,
            recordId: record.recordId,
            recipientOpenId,
            kind: 'inventory_inbound_completed',
          }));

        if (!inputs.length) continue;
        const results = await this.store.enqueueNotifications(inputs);
        recovered += results.filter(
          (enqueueResult) => enqueueResult.enqueued,
        ).length;
      } catch (error) {
        result.failed += 1;
        result.errors.push(
          `${record.recordId}: 采购完成通知补偿失败: ${errorMessage(error)}`,
        );
      }
    }
    return recovered;
  }

  private async resolveCompletionRecipients(
    requesterOpenId: string,
    scope?:Pick<PurchaseWorkflowRecord,'building'|'specialty'>,
  ): Promise<string[]> {
    const [purchaseAdmin, approvers] = await Promise.all([
      this.gateway.resolvePurchaseAdminAsApp(scope),
      this.gateway.resolveConfiguredApproversAsApp(scope),
    ]);
    return [
      ...new Set([
        requesterOpenId,
        purchaseAdmin.openId,
        ...approvers.map((approver) => approver.openId),
      ]),
    ].filter(isValidUserOpenId);
  }

  private async resolveInboundCompletionRecipients(building: string): Promise<{
    responsibleOpenIds: string[];
    recipientOpenIds: string[];
  }> {
    const [responsibleUsers, managerUsers] = await Promise.all([
      this.gateway.resolveInboundResponsibleUsersAsApp(building),
      this.gateway.resolveInboundManagerNotificationUsersAsApp(building),
    ]);
    const responsibleOpenIds = [
      ...new Set(
        responsibleUsers
          .map((responsible) => responsible.openId)
          .filter(isValidUserOpenId),
      ),
    ];
    return {
      responsibleOpenIds,
      recipientOpenIds: [
        ...new Set([
          ...responsibleOpenIds,
          ...managerUsers
            .map((manager) => manager.openId)
            .filter(isValidUserOpenId),
        ]),
      ],
    };
  }

  private async processCardAction(
    action: PurchaseWorkflowCardActionEntry,
    now: Date,
    result: PurchaseWorkflowTaskRunResult,
  ): Promise<boolean> {
    try {
      if (action.authority && action.authority.appId !== process.env.FEISHU_APP_ID?.trim()) throw new ConflictException('原采购审批受理属于其他应用');
      const approvers = await this.approverSnapshot(action.recordId, action.authority?.scope);
      if (
        !approvers.some((approver) => approver.openId === action.actorOpenId)
      ) {
        throw new ForbiddenException('卡片操作者不在采购审批人配置中');
      }
      if (!(await this.ensureApprovalCardsReady(action.recordId, approvers))) {
        const error = new Error('审批卡未全部送达');
        await this.retryOrFailCardAction(action, error, now);
        result.failed += 1;
        result.errors.push(`${action.key}: ${error.message}`);
        return false;
      }

      let record = await this.gateway.getExecutionRecordAsApp(action.recordId);
      if (action.authority && JSON.stringify(purchaseAuthorityTarget(record)) !== JSON.stringify(action.authority.scope)) throw new ConflictException('原采购审批受理楼栋或专业已变化');
      let expectedPurchaser: PurchaseWorkflowUser | undefined =
        action.action === 'approve'
          ? action.plannedPurchaser ? { ...action.plannedPurchaser, positions: [], buildings: [] } : await this.resolveCardApprovalPurchaser(record)
          : undefined;
      if (expectedPurchaser && typeof this.store.planCardActionPurchaser === 'function') {
        const planned = await this.store.planCardActionPurchaser(action.key, action.claimToken, { openId: expectedPurchaser.openId, name: expectedPurchaser.name || expectedPurchaser.openId });
        expectedPurchaser = { ...expectedPurchaser, ...planned };
      }
      const rejectedApplied =
        action.action === 'reject' &&
        record.purchaseMethod === '驳回' &&
        resolvePurchaseStage(record.status) === 'terminated';
      const approvedApplied =
        action.action === 'approve' &&
        record.warehouseConfirmed &&
        record.purchaserOpenId === expectedPurchaser?.openId &&
        resolvePurchaseStage(record.status) === 'ordering';

      let assigneeOpenId = record.purchaserOpenId;
      if (!rejectedApplied && !approvedApplied) {
        if (resolvePurchaseStage(record.status) !== 'application') {
          throw new ConflictException('采购申请已处于其他流程状态');
        }
        const patch = buildCardApprovalRoutingPatch(
          record,
          action.action === 'approve' ? 'approved' : 'rejected',
          expectedPurchaser,
        );
        await this.gateway.updateExecutionRecordAsApp(action.recordId, patch);
        assigneeOpenId = expectedPurchaser?.openId || '';
        record = {
          ...record,
          purchaseMethod:
            action.action === 'reject' ? '驳回' : record.purchaseMethod,
          status:
            action.action === 'reject' ? '驳回申请' : '审批通过（待下单）',
          approvalCompleted: true,
          warehouseConfirmed: action.action === 'approve',
          purchaserOpenId: assigneeOpenId,
          purchaserName: expectedPurchaser?.name || record.purchaserName,
        };
      }

      await this.enqueueCardActionNotifications(
        action,
        record,
        approvers,
        assigneeOpenId,
      );
      await this.store.completeCardAction(action.key, action.claimToken, now);
      return true;
    } catch (error) {
      await this.retryOrFailCardAction(action, error, now);
      result.failed += 1;
      result.errors.push(`${action.key}: ${errorMessage(error)}`);
      return false;
    }
  }

  private async approverSnapshot(recordId: string, scope?: Pick<PurchaseWorkflowRecord, 'building' | 'specialty'>): Promise<PurchaseWorkflowUser[]> {
    const resolve = () => scope ? this.gateway.resolveConfiguredApproversAsApp(scope) : this.gateway.resolveConfiguredApproversAsApp();
    if (!useConfiguredCardAuthorizationSnapshots()) return resolve();
    const notifications = await this.store.listNotifications({ recordId, kind: 'approval_requested' });
    if (!notifications.length) return resolve();
    return [...new Set(notifications.map(notification => notification.recipientOpenId))].map(openId => ({ openId, name: openId, positions: [], buildings: [] }));
  }

  private async ensureApprovalCardsReady(
    recordId: string,
    approvers: PurchaseWorkflowUser[],
  ): Promise<boolean> {
    let notifications = await this.store.listNotifications({
      recordId,
      kind: 'approval_requested',
    });
    const knownRecipients = new Set(
      notifications.map((notification) => notification.recipientOpenId),
    );
    const missing = approvers.filter(
      (approver) => !knownRecipients.has(approver.openId),
    );
    if (missing.length) {
      await this.store.enqueueNotifications(
        missing.map((approver) => ({
          businessEventId: `approval-requested:${recordId}`,
          recordId,
          recipientOpenId: approver.openId,
          kind: 'approval_requested' as const,
        })),
      );
      notifications = await this.store.listNotifications({
        recordId,
        kind: 'approval_requested',
      });
    }
    const byRecipient = new Map(
      notifications.map((notification) => [
        notification.recipientOpenId,
        notification,
      ]),
    );
    return approvers.every((approver) => {
      const notification = byRecipient.get(approver.openId);
      return (
        notification?.status === 'completed' && Boolean(notification.messageId)
      );
    });
  }

  private async resolveCardApprovalPurchaser(
    record: Awaited<
      ReturnType<PurchaseWorkflowGateway['getExecutionRecordAsApp']>
    >,
  ): Promise<PurchaseWorkflowUser> {
    const method =
      record.purchaseMethod === '需求自采（楼内）'
        ? '需求自采'
        : record.purchaseMethod;
    if (method === '综合采购') {
      return this.gateway.resolvePurchaseAdminAsApp({building:record.building,specialty:record.specialty});
    }
    if (method === '需求自采') {
      return this.gateway.resolveBuildingSupervisorAsApp(record.building,record.specialty);
    }
    throw new BadRequestException('采购申请未填写有效的采购方式');
  }

  private async enqueueCardActionNotifications(
    action: PurchaseWorkflowCardActionEntry,
    record: Awaited<
      ReturnType<PurchaseWorkflowGateway['getExecutionRecordAsApp']>
    >,
    approvers: PurchaseWorkflowUser[],
    assigneeOpenId: string,
  ): Promise<void> {
    const inputs: PurchaseWorkflowNotificationInput[] = approvers.map(
      (approver) => ({
        businessEventId: `approval-resolved:${action.recordId}`,
        recordId: action.recordId,
        recipientOpenId: approver.openId,
        kind: 'approval_resolved',
      }),
    );
    if (action.action === 'reject') {
      inputs.push({
        businessEventId: `purchase-rejected:${action.recordId}`,
        recordId: action.recordId,
        recipientOpenId: record.requesterOpenId,
        kind: 'purchase_rejected',
      });
    } else {
      inputs.push({
        businessEventId: `purchase-assigned:${action.recordId}`,
        recordId: action.recordId,
        recipientOpenId: requireText(
          assigneeOpenId,
          '采购审批已通过但采购人缺失',
        ),
        kind: 'purchase_assigned',
      });
    }
    await this.store.enqueueNotifications(inputs);
  }

  private async processNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    result: PurchaseWorkflowTaskRunResult,
  ): Promise<boolean> {
    let activeNotification = notification;
    try {
      if (notification.kind === 'inventory_inbound_completed_resolution') {
        await this.resolveInboundCompletedNotification(notification, now);
        return true;
      }
      if (
        notification.kind === 'manual_inventory_inbound_completed_resolution'
      ) {
        await this.resolveManualInboundCompletedNotification(notification, now);
        return true;
      }
      const delivery = await this.deliverNotification(
        notification,
        now,
        (updated) => {
          activeNotification = updated;
        },
      );
      await this.store.completeNotification(
        notification.key,
        notification.claimToken,
        delivery,
        now,
      );
      return true;
    } catch (error) {
      await this.retryOrFailNotification(activeNotification, error, now);
      result.failed += 1;
      result.errors.push(`${notification.key}: ${errorMessage(error)}`);
      return false;
    }
  }

  private async resolveInboundCompletedNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
  ): Promise<void> {
    const record = await this.gateway.getExecutionRecordAsApp(
      notification.recordId,
    );
    const stage = resolvePurchaseStage(record.status);
    if (stage === 'terminated') {
      await this.store.completeInboundCompletedResolutionAndEnqueueNotifications(
        notification.key,
        notification.claimToken,
        [],
        now,
      );
      return;
    }
    if (stage !== 'completed') {
      throw new ConflictException('采购记录尚未完成入库');
    }

    const completionRecipientsRead = this.isEnabled()
      ? this.resolveCompletionRecipients(record.requesterOpenId,record).catch(
          (error) => {
            this.logger.warn(
              `采购完成通知收件人解析失败：${errorMessage(error)}`,
            );
            return [] as string[];
          },
        )
      : Promise.resolve([] as string[]);
    const [inboundRecipients, completionRecipients] = await Promise.all([
      this.resolveInboundCompletionRecipients(record.building),
      completionRecipientsRead,
    ]);
    const legacyPurchaseNotifications = await this.store.listNotifications({
      recordId: record.recordId,
      kind: 'purchase_completed',
    });
    const legacyRecipients = new Set(
      legacyPurchaseNotifications.map((entry) => entry.recipientOpenId),
    );
    const inputs: PurchaseWorkflowNotificationInput[] = [
      ...new Set([
        ...inboundRecipients.recipientOpenIds,
        ...completionRecipients.filter(
          (recipientOpenId) => !legacyRecipients.has(recipientOpenId),
        ),
      ]),
    ].map((recipientOpenId) => ({
      businessEventId: `inventory-inbound-completed:${record.recordId}`,
      recordId: record.recordId,
      recipientOpenId,
      kind: 'inventory_inbound_completed' as const,
      ...(notification.cardContext
        ? { cardContext: notification.cardContext }
        : {}),
    }));
    const completed =
      await this.store.completeInboundCompletedResolutionAndEnqueueNotifications(
        notification.key,
        notification.claimToken,
        inputs,
        now,
      );
    if (!completed) {
      throw new ConflictException('入库完成通知解析任务不存在');
    }
  }

  private async resolveManualInboundCompletedNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
  ): Promise<void> {
    const context = parseManualInboundCompletedContext(
      notification.cardContext,
    );
    if (context.movement.recordId !== notification.recordId) {
      throw new ConflictException('手工入库通知快照与入库记录不匹配');
    }
    const inboundRecipients = await this.resolveInboundCompletionRecipients(
      context.movement.building,
    );
    if (!inboundRecipients.responsibleOpenIds.length) {
      throw new ServiceUnavailableException(
        '目标楼栋未解析到有效的库房责任人员',
      );
    }
    const completed =
      await this.store.completeInboundCompletedResolutionAndEnqueueNotifications(
        notification.key,
        notification.claimToken,
        inboundRecipients.recipientOpenIds.map((recipientOpenId) => ({
          businessEventId: `manual-inventory-inbound-completed:${notification.recordId}`,
          recordId: notification.recordId,
          recipientOpenId,
          kind: 'manual_inventory_inbound_completed' as const,
          cardContext: notification.cardContext,
        })),
        now,
      );
    if (!completed) {
      throw new ConflictException('手工入库完成通知解析任务不存在');
    }
  }

  private async deliverNotification(
    notification: PurchaseWorkflowNotificationEntry,
    now: Date,
    onNotificationUpdated?: (
      notification: PurchaseWorkflowNotificationEntry,
    ) => void,
  ): Promise<{ messageId?: string; deliveryId?: string; businessStage?: 'completed' | 'terminated' }> {
    if (notification.kind === 'purchase_order_completed') {
      const context = JSON.parse(notification.cardContext) as { version?: unknown; text?: unknown };
      if (context?.version !== 1 || typeof context.text !== 'string' || !context.text.trim() || context.text.length > 10000) {
        throw new ConflictException('采购下单通知快照无效');
      }
      const sending = await this.store.markPurchaseOrderNoticeSendStarted(notification.key, notification.claimToken, now);
      if (!sending) throw new ConflictException('采购下单通知任务不存在');
      onNotificationUpdated?.(sending);
      const messageId = await this.gateway.sendIdempotentTextNotification(notification.recipientOpenId, context.text, sending.deliveryUuid);
      return { messageId };
    }
    if (notification.kind === 'manual_inventory_inbound_completed') {
      const context = parseManualInboundCompletedContext(
        notification.cardContext,
      );
      if (context.movement.recordId !== notification.recordId) {
        throw new ConflictException('手工入库通知快照与入库记录不匹配');
      }
      const sending = await this.store.markInboundCompletedSendStarted(
        notification.key,
        notification.claimToken,
        now,
      );
      if (!sending) {
        throw new ConflictException('手工入库完成通知任务不存在');
      }
      onNotificationUpdated?.(sending);
      const messageId = await this.gateway.sendInteractiveCard(
        notification.recipientOpenId,
        buildManualInventoryInboundCompletedCard(context.movement),
        sending.deliveryUuid,
      );
      return { messageId };
    }
    const readAppId = process.env.FEISHU_APP_ID?.trim();
    const record = await this.gateway.getExecutionRecordAsApp(
      notification.recordId,
    );
    if (notification.kind === 'approval_transferred') {
      const sources = (await this.store.listNotifications({ recordId: notification.recordId, kind: 'approval_requested', recipientOpenId: notification.recipientOpenId })).filter(row => row.approvalHandover?.terminalNotificationKey === notification.key);
      if (sources.length !== 1 || !sources[0].messageId) throw new ConflictException('采购原审批交接卡片不一致');
      await this.gateway.updateInteractiveCard(sources[0].messageId, buildTransferredPurchaseApprovalCard(toApprovalCardInput(record)));
      await this.store.recordPurchaseBatchCardUpdateCompleted(notification.key, notification.claimToken, sources[0].messageId, now);
      return { messageId: sources[0].messageId };
    }
    if (notification.kind === 'approval_requested') {
      if (resolvePurchaseStage(record.status) !== 'application') return {};
      if (this.accessConfiguration) {
        const scope = purchaseAuthorityTarget(record), appId = readAppId;
        if (!scope || !appId || appId !== process.env.FEISHU_APP_ID?.trim()) throw new ConflictException('采购审批投递应用或范围不明确');
        const payload = notification.firstSendAttemptAt ? notification.cardContext : JSON.stringify(toApprovalCardInput(record));
        const cardInput = JSON.parse(payload) as PurchaseApprovalCardInput;
        if (cardInput.executionRecordId !== notification.recordId || cardInput.building !== record.building) throw new ConflictException('采购审批冻结载荷与原记录不一致');
        const started = await this.store.markLegacyApprovalSendStarted(notification.key, notification.claimToken, { appId, scope }, payload, () => {
          assertFeishuBusinessIdentity(this.accessConfiguration, notification.recipientOpenId);
          const members = this.accessConfiguration!.currentDutyRoutePeople('purchase_approver', scope);
          if (members !== null && !members.some(person => person.openId === notification.recipientOpenId)) throw new ForbiddenException('当前采购审批岗位已变化');
        }, now);
        if (!started) throw new ConflictException('采购审批原投递领取权已变化');
        onNotificationUpdated?.(started);
        return { messageId: await this.gateway.sendInteractiveCard(notification.recipientOpenId, buildPurchaseApprovalCard(cardInput), started.deliveryUuid) };
      }
      const messageId = await this.gateway.sendInteractiveCard(
        notification.recipientOpenId,
        buildPurchaseApprovalCard(toApprovalCardInput(record)),
      );
      return { messageId };
    }
    if (notification.kind === 'warehouse_inbound') {
      const stage = resolvePurchaseStage(record.status);
      if (stage === 'completed' || stage === 'terminated') {
        if (notification.sendOutcome === 'unknown') throw new ConflictException('原待入库提醒发送结果仍需核对');
        return { businessStage: stage };
      }
      if (stage !== 'inbound') {
        throw new ConflictException('采购记录尚未进入待入库阶段');
      }
      const card = buildWarehouseInboundCard(record, readEnv('PUBLIC_BASE_URL'));
      const sending = this.accessConfiguration
        ? await this.store.markInboundCompletedSendStarted(notification.key, notification.claimToken, now, () => {
          assertFeishuBusinessIdentity(this.accessConfiguration, notification.recipientOpenId);
          return true;
        })
        : await this.store.markInboundCompletedSendStarted(notification.key, notification.claimToken, now);
      if (!sending) throw new ConflictException('待入库提醒投递任务不存在');
      onNotificationUpdated?.(sending);
      const messageId = await this.gateway.sendInteractiveCard(
        notification.recipientOpenId,
        card,
        sending.deliveryUuid,
      );
      return { messageId };
    }
    if (notification.kind === 'approval_resolved') {
      const requested = (
        await this.store.listNotifications({
          recordId: notification.recordId,
          recipientOpenId: notification.recipientOpenId,
          kind: 'approval_requested',
          status: 'completed',
        })
      )[0];
      if (!requested?.messageId) return {};
      const action = (
        await this.store.listCardActions({
          recordId: notification.recordId,
          status: 'completed',
        })
      )[0];
      if (!action) {
        throw new ConflictException('采购审批结果任务尚未完成');
      }
      const actor = (await this.approverSnapshot(action.recordId)).find(person => person.openId === action.actorOpenId);
      await this.gateway.updateInteractiveCard(
        requested.messageId,
        buildResolvedPurchaseApprovalCard(toApprovalCardInput(record), {
          decision: action.action,
          actorName: actor?.name || action.actorOpenId,
          processedAt: action.completedAt || now,
        }),
      );
      return { messageId: requested.messageId };
    }
    if (notification.kind === 'purchase_assigned') {
      const messageIds = await this.gateway.sendTextNotification(
        [notification.recipientOpenId],
        `采购任务 ${record.requestCode || record.itemName} 已审批通过，请跟进采购下单`,
      );
      return { messageId: messageIds[0] };
    }
    if (notification.kind === 'purchase_rejected') {
      const messageIds = await this.gateway.sendTextNotification(
        [notification.recipientOpenId],
        `采购申请 ${record.requestCode || record.itemName} 已驳回`,
      );
      return { messageId: messageIds[0] };
    }
    if (notification.kind === 'purchase_completed') {
      const stage = resolvePurchaseStage(record.status);
      if (stage === 'terminated') return {};
      if (stage !== 'completed') {
        throw new ConflictException('采购记录尚未完成入库');
      }
      return {};
    }
    if (notification.kind === 'inventory_inbound_completed') {
      const stage = resolvePurchaseStage(record.status);
      if (stage === 'terminated') return {};
      if (stage !== 'completed') {
        throw new ConflictException('采购记录尚未完成入库');
      }
      const context = parseInboundCompletedCardContext(notification.cardContext);
      const card = buildInventoryInboundCompletedCard(record, context);
      const sending = await this.store.markInboundCompletedSendStarted(
        notification.key,
        notification.claimToken,
        now,
      );
      if (!sending) {
        throw new ConflictException('入库完成通知任务不存在');
      }
      onNotificationUpdated?.(sending);
      const messageId = context?.batchId
        ? await this.requireBatchCardService().upsert('inbound', context.batchId, notification.recipientOpenId, {
            id: record.recordId,
            name: record.itemName,
            sku: context.sku || record.sku || '',
            specification: context.specification || record.specification || '',
            quantity: record.actualQuantity || record.requestedQuantity,
            unit: record.unit || '',
            building: record.building,
            location: context.location || record.location || '',
            status: '已入库',
          })
        : await this.gateway.sendInteractiveCard(
            notification.recipientOpenId,
            card,
            sending.deliveryUuid,
          );
      return { messageId };
    }
    throw new Error(`暂不支持的采购通知类型: ${notification.kind}`);
  }

  private requireBatchCardService(): InventoryBatchCardService {
    if (!this.batchCardService) throw new ServiceUnavailableException('批量入库通知服务未就绪');
    return this.batchCardService;
  }

  private async retryOrFailCardAction(
    action: PurchaseWorkflowCardActionEntry,
    error: unknown,
    now: Date,
  ): Promise<void> {
    if (action.attempts >= TASK_MAX_ATTEMPTS) {
      await this.store.failCardAction(
        action.key,
        action.claimToken,
        error,
        now,
      );
      return;
    }
    await this.store.rescheduleCardAction(
      action.key,
      action.claimToken,
      error,
      nextTaskAttemptAt(action.attempts, now),
      now,
    );
  }

  private async retryOrFailNotification(
    notification: PurchaseWorkflowNotificationEntry,
    error: unknown,
    now: Date,
  ): Promise<void> {
    if (notification.kind === 'warehouse_inbound' && notification.sendOutcome === 'unattempted' && error instanceof ForbiddenException) {
      await this.store.failNotification(notification.key, notification.claimToken, error, now);
      return;
    }
    if (
      notification.kind === 'inventory_inbound_completed_resolution' ||
      notification.kind === 'manual_inventory_inbound_completed_resolution'
    ) {
      await this.store.rescheduleNotification(
        notification.key,
        notification.claimToken,
        error,
        nextTaskAttemptAt(notification.attempts, now),
        now,
      );
      return;
    }
    if (
      (notification.kind === 'inventory_inbound_completed' ||
        notification.kind === 'manual_inventory_inbound_completed' ||
        notification.kind === 'purchase_order_completed' ||
        notification.kind === 'warehouse_inbound') &&
      (notification.sendOutcome === 'unattempted' ||
        notification.sendOutcome === 'unknown')
    ) {
      await this.store.rescheduleNotification(
        notification.key,
        notification.claimToken,
        error,
        nextTaskAttemptAt(notification.attempts, now),
        now,
      );
      return;
    }
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

  private async execute(
    action: PurchaseWorkflowAction,
    recordId: string,
    session: PurchaseWorkflowSession,
    prepare: (
      record: Awaited<
        ReturnType<PurchaseWorkflowGateway['getExecutionRecord']>
      >,
      actor: PurchaseWorkflowUser,
    ) => Promise<{
      patch: PurchaseWorkflowFieldPatch;
      recipients: string[];
      message: string;
    }>,
    requestPayload: unknown = null,
  ): Promise<PurchaseWorkflowCommandResult> {
    if (action !== 'order' && action !== 'receive') {
      this.assertEnabled(session.accessRole);
    }
    const normalizedRecordId = requireText(recordId, '采购执行记录 ID 缺失');
    const key = `${action}:${normalizedRecordId}`;
    const fingerprint = commandFingerprint(action, session, requestPayload);
    const running = this.runningCommands.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) {
        throw new ConflictException('该采购执行正在处理另一份操作数据');
      }
      const result = await running.promise;
      return {
        ...result,
        idempotent: true,
      };
    }

    const promise = this.executeOnce(
      action,
      normalizedRecordId,
      key,
      fingerprint,
      session,
      prepare,
    );
    this.runningCommands.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.runningCommands.get(key)?.promise === promise) {
        this.runningCommands.delete(key);
      }
    }
  }

  private async executeOnce(
    action: PurchaseWorkflowAction,
    normalizedRecordId: string,
    key: string,
    fingerprint: string,
    session: PurchaseWorkflowSession,
    prepare: (
      record: Awaited<
        ReturnType<PurchaseWorkflowGateway['getExecutionRecord']>
      >,
      actor: PurchaseWorkflowUser,
    ) => Promise<{
      patch: PurchaseWorkflowFieldPatch;
      recipients: string[];
      message: string;
    }>,
  ): Promise<PurchaseWorkflowCommandResult> {
    const existing = await this.store.findCommand(key);
    if (existing) {
      const result = await this.resolveExistingCommand(
        existing,
        fingerprint,
        action,
        normalizedRecordId,
        session,
      );
      if (result) return result;
    }

    const record = await this.gateway.getExecutionRecord(
      normalizedRecordId,
      session.accessToken,
    );
    if(session.acceptedFulfillment){const current=purchaseAuthorityTarget(record);if(session.acceptedFulfillment.building!==(current?.building||record.building)||session.acceptedFulfillment.specialty&&session.acceptedFulfillment.specialty!==current?.specialty)throw new ConflictException('原受理采购范围已变化，请核对原命令');}
    assertBuildingAdministratorWorkflowScope(record, session);
    const actor = await this.resolveActor(session, record);
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(record, actor);
    } catch (error) {
      throw mapRuleError(error);
    }
    const expectedResultFingerprint = commandResultFingerprintFromPatch(
      action,
      prepared.patch,
    );

    const startedAt = new Date().toISOString();
    const managerApprovalEnabled = action === 'order' && isPurchaseManagerApprovalEnabled();
    const orderNotice = action === 'order' && (this.isEnabled() || managerApprovalEnabled) ? {
      recipientOpenIds: [...new Set([
        ...prepared.recipients,
        ...(managerApprovalEnabled ? readPurchaseManagerApprovers().map(person => person.openId) : []),
      ].filter(Boolean))],
      text: prepared.message || `采购任务 ${record.requestCode || record.itemName} 已下单，等待到货签收`,
      ...(session.acceptedFulfillment ? { deferUntilFulfillment: true } : {}),
    } : undefined;
    const claim = await this.store.claimCommand({
      key,
      recordId: normalizedRecordId,
      action,
      fingerprint,
      expectedResultFingerprint,
      actorOpenId: session.openId,
      accessRole: session.accessRole || 'unknown',
      authenticationMode: session.authenticationMode || 'unknown',
      startedAt,
      ...(orderNotice ? { orderNotice } : {}),
    }, this.accessConfiguration ? () => this.assertCurrentCommandAuthority(action, record, session, actor) : undefined,session.acceptedFulfillment?.proof);
    if (!claim.claimed) {
      const result = await this.resolveExistingCommand(
        claim.entry,
        fingerprint,
        action,
        normalizedRecordId,
        session,
      );
      if (result) return result;
      throw new ConflictException('该采购执行正在同步中，请稍后刷新');
    }

    try {
      await this.gateway.updateExecutionRecord(
        normalizedRecordId,
        prepared.patch,
        session.accessToken,
      );
    } catch (error) {
      if (!isDefiniteCommandUpdateRejection(error)) {
        const networkCode = commandUpdateNetworkCode(error);
        if (networkCode) {
          throw new ServiceUnavailableException(
            `采购状态写入结果暂不明确（${networkCode}），请稍后刷新确认`,
          );
        }
        throw error;
      }
      try {
        await this.store.releaseCommandClaim(key, fingerprint);
      } catch (releaseError) {
        throw new ServiceUnavailableException(
          `${errorMessage(error)}；采购命令认领释放失败：${errorMessage(releaseError)}`,
        );
      }
      throw error;
    }
    this.invalidateDetailCache(normalizedRecordId);

    const completedCommand: PurchaseWorkflowCommandEntry = {
      ...claim.entry,
      completedAt: new Date().toISOString(),
      notificationWarnings: [],
    };
    await this.store.recordCommand(completedCommand);

    const notificationWarnings: string[] = [];
    if (action !== 'order' && this.isEnabled()) {
      try {
        await this.gateway.sendTextNotification(
          prepared.recipients,
          prepared.message,
        );
      } catch (error) {
        notificationWarnings.push(errorMessage(error));
      }
    }
    if (notificationWarnings.length) {
      try {
        await this.store.recordCommand({
          ...completedCommand,
          notificationWarnings,
        });
      } catch (error) {
        notificationWarnings.push(
          `采购命令告警记录失败：${errorMessage(error)}`,
        );
      }
    }

    return {
      detail: await this.getDetail(normalizedRecordId, session),
      idempotent: false,
      notificationWarnings,
    };
  }

  private async resolveExistingCommand(
    existing: PurchaseWorkflowCommandEntry,
    fingerprint: string,
    action: PurchaseWorkflowAction,
    normalizedRecordId: string,
    session: PurchaseWorkflowSession,
  ): Promise<PurchaseWorkflowCommandResult | null> {
    const fingerprintConflicts =
      Boolean(existing.fingerprint) && existing.fingerprint !== fingerprint;
    if (existing.completedAt) {
      if (fingerprintConflicts) {
        throw new ConflictException('该采购执行已使用另一份操作数据处理');
      }
      this.invalidateDetailCache(normalizedRecordId);
      return {
        detail: await this.getDetail(normalizedRecordId, session),
        idempotent: true,
        notificationWarnings: [...existing.notificationWarnings],
      };
    }

    const record = await this.gateway.getExecutionRecord(
      normalizedRecordId,
      session.accessToken,
    );
    assertBuildingAdministratorWorkflowScope(record, session);
    if (hasActionReachedPostState(action, record.status)) {
      if (fingerprintConflicts) {
        throw new ConflictException('该采购执行已使用另一份操作数据处理');
      }
      if (
        !doesCommandResultMatchExpected(
          action,
          record,
          existing.expectedResultFingerprint,
        )
      ) {
        throw new ConflictException(
          '采购执行已推进，但结果与本次提交不一致，请刷新核对',
        );
      }
      const completed: PurchaseWorkflowCommandEntry = {
        ...existing,
        fingerprint: existing.fingerprint || fingerprint,
        startedAt: existing.startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        notificationWarnings: [...existing.notificationWarnings],
      };
      await this.store.recordCommand(completed);
      this.invalidateDetailCache(normalizedRecordId);
      return {
        detail: await this.getDetail(normalizedRecordId, session),
        idempotent: true,
        notificationWarnings: [...completed.notificationWarnings],
      };
    }

    if (isExpiredCommandClaim(existing.startedAt)) {
      const released = await this.store.releaseCommandClaim(
        existing.key,
        existing.fingerprint,
      );
      if (released) return null;
    }
    if (fingerprintConflicts) {
      throw new ConflictException('该采购执行正在处理另一份操作数据');
    }
    throw new ConflictException('该采购执行正在同步中，请稍后刷新');
  }

  private assertCurrentCommandAuthority(action: PurchaseWorkflowAction, record: PurchaseWorkflowRecord, session: PurchaseWorkflowSession, actor?: PurchaseWorkflowDutyActor): void {
    const configuration=this.accessConfiguration!;
    const principal=session.permissionPrincipal;
    if (!principal) {
      if (session.accessRole) throw new ForbiddenException('当前采购操作权限已变化，请重新核对登录和授权');
      assertFeishuBusinessIdentity(configuration,session.openId);
      return;
    }
    const current=configuration.currentPrincipal(principal.accountId,principal.authorizationVersion);
    if (!current || current.role!==principal.role || current.role!==session.accessRole || !canPerformBusinessAction(current,{module:'purchase',action:action==='start'?'create':action,building:record.building,specialty:record.specialty})) throw new ForbiddenException('当前采购操作权限已变化，请重新核对登录和授权');
    if (action === 'approve' && current.role !== 'admin') {
      const roster = this.webApprovalRoster(record);
      if (actor?.approvalDutyKind !== roster.kind || !roster.openIds.includes(session.openId)) throw new ForbiddenException('当前采购审批岗位已变化，请使用现任人员办理');
    }
  }

  private webApprovalRoster(record: PurchaseWorkflowRecord) {
    const scope = purchaseAuthorityTarget(record);
    if (!scope) throw new ForbiddenException('采购审批记录范围不明确');
    const kind = isPurchaseManagerApprovalEnabled() ? 'purchase_manager' as const : 'purchase_approver' as const;
    const routed = this.accessConfiguration?.currentDutyRoutePeople(kind, scope);
    const configured = routed ?? (kind === 'purchase_manager' ? readPurchaseManagerApprovers() : readConfiguredCardMembers('purchase_approvers', scope.building, scope.specialty) ??
      readEnv('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS').split(',').map(openId => ({ openId: openId.trim() })));
    return { kind, openIds: configured.map(person => person.openId).filter(openId => /^ou_[A-Za-z0-9_-]+$/.test(openId)) };
  }

  private withWebApprovalDuty(actor: PurchaseWorkflowDutyActor, record: PurchaseWorkflowRecord): PurchaseWorkflowDutyActor {
    if (actor.accessRole === 'admin' || resolvePurchaseStage(record.status) !== 'application') return actor;
    const roster = this.webApprovalRoster(record);
    return { ...actor, approvalDuty: roster.openIds.includes(actor.openId), approvalDutyKind: roster.kind };
  }

  private async acceptedCardSession(session:PurchaseWorkflowSession,recordId:string,action:'order'|'receive',input:PurchaseWorkflowOrderInput|PurchaseWorkflowReceiptInput,proof:PurchaseFulfillmentClaimProof|undefined):Promise<PurchaseWorkflowSession>{
    if(!proof)return session;
    const accepted=await this.store.readAcceptedFulfillmentCommand(proof,recordId,action,session.openId),context=parsePurchaseBatchFulfillmentCommandContext(accepted.proof.cardContext);
    const order=input as PurchaseWorkflowOrderInput,receipt=input as PurchaseWorkflowReceiptInput;
    const original=context.action==='order'?[context.actualQuantity,context.actualAmount,context.paymentAttachmentTokens,context.note]:[context.signerOpenId,context.receiptTime,context.receiptPhotoTokens,context.invoiceTokens,context.note];
    const submitted=action==='order'?[order.actualQuantity,order.actualAmount,order.paymentAttachmentTokens,order.note||'']:[receipt.signerOpenId,receipt.receiptTime,receipt.receiptPhotoTokens,receipt.invoiceTokens,receipt.note||''];
    if(JSON.stringify(stableCommandValue(original))!==JSON.stringify(stableCommandValue(submitted)))throw new ConflictException('原采购受理内容已变化，不能替换原命令');
    return{...session,acceptedFulfillment:accepted};
  }

  private async resolveActor(
    session: PurchaseWorkflowSession,
    record?: PurchaseWorkflowRecord,
  ): Promise<PurchaseWorkflowDutyActor> {
    if(session.acceptedFulfillment)return structuredClone(session.acceptedFulfillment.actor);
    const actor = await this.gateway.resolveUser(
      requireText(session.openId, '当前飞书用户标识缺失'),
      session.accessToken,
    );
    const resolved = {
      ...actor,
      name: actor.name || session.userName,
      buildings:
        session.accessRole === 'purchase_applicant' &&
        session.purchaseBuilding
          ? (session.purchaseBuildings || [session.purchaseBuilding])
          : actor.buildings,
      accessRole: session.accessRole,
      ...(session.permissionPrincipal ? { permissionPrincipal: session.permissionPrincipal } : {}),
    };
    const current: PurchaseWorkflowDutyActor = record ? this.withWebApprovalDuty(resolved, record) : resolved;
    if (session.authenticationMode === 'delegated-app' && !actor.name && !actor.positions.length && !actor.buildings.length && !current.approvalDuty) {
      throw new ServiceUnavailableException('配置的采购工作流操作人未在组织架构表中找到');
    }
    return current;
  }

  private async appCardSession(
    actorOpenId: string,
  ): Promise<PurchaseWorkflowSession> {
    return {
      accessToken: await this.gateway.getTenantAccessTokenAsApp(),
      openId: requireText(actorOpenId, '采购卡片操作人标识缺失'),
      userName: '',
      authenticationMode: 'delegated-app',
    };
  }
}

function commandFingerprint(
  action: PurchaseWorkflowAction,
  session: PurchaseWorkflowSession,
  payload: unknown,
): string {
  const normalized = stableCommandValue({
    action,
    actorOpenId: session.openId,
    accessRole: session.accessRole || '',
    permissionScope: session.permissionPrincipal ? businessPermissionScopeKey(session.permissionPrincipal) : '',
    authenticationMode: session.authenticationMode || '',
    purchaseBuilding: session.purchaseBuilding || '', purchaseBuildings: session.purchaseBuildings || [],
    payload,
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function stableCommandValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCommandValue);
  if (!value || typeof value !== 'object') return value ?? null;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableCommandValue(entry)]),
  );
}

function hasActionReachedPostState(
  action: PurchaseWorkflowAction,
  status: string,
): boolean {
  const stage = resolvePurchaseStage(status);
  if (action === 'approve') {
    return !['application', 'unknown'].includes(stage);
  }
  if (action === 'start') {
    return ['ordering', 'receipt', 'inbound', 'completed'].includes(stage);
  }
  if (action === 'order') {
    return ['receipt', 'inbound', 'completed'].includes(stage);
  }
  return ['inbound', 'completed'].includes(stage);
}

function doesCommandResultMatchExpected(
  action: PurchaseWorkflowAction,
  record: PurchaseWorkflowRecord,
  expectedResultFingerprint: string,
): boolean {
  return (
    Boolean(expectedResultFingerprint) &&
    commandResultFingerprintFromRecord(action, record) ===
      expectedResultFingerprint
  );
}

function commandResultFingerprintFromPatch(
  action: PurchaseWorkflowAction,
  patch: PurchaseWorkflowFieldPatch,
): string {
  let result: Record<string, unknown>;
  if (action === 'approve') {
    result = {
      purchaseMethod: requireOptionalText(patch['1️⃣物品采购方式']),
      terminated:
        resolvePurchaseStage(requireOptionalText(patch['采购流程'])) ===
        'terminated',
    };
  } else if (action === 'start') {
    result = {
      purchaserOpenId: firstUserOpenId(patch['采购人']),
      warehouseConfirmed: patch['库房确认'] === true,
    };
  } else if (action === 'order') {
    result = {
      actualQuantity: optionalFiniteNumber(patch['实际采购数量']),
      actualAmount: optionalFiniteNumber(patch['实际付款金额']),
      paymentAttachmentTokens: attachmentTokensFromPatch(
        patch['付款截屏（显示付款金额）'],
      ),
      note: requireOptionalText(patch['采购备注']),
      purchaseCompleted: patch['采购完成'] === true,
    };
  } else {
    result = {
      signerOpenId: firstUserOpenId(patch['签收人']),
      receiptTime: optionalFiniteNumber(patch['签收时间']),
      receiptAttachmentTokens: attachmentTokensFromPatch(patch['签收附件']),
      note: requireOptionalText(patch['采购备注']),
      receiptConfirmed:
        patch['到货签收确认（签收内容填写完成后点击）'] === true,
      purchaseCompleted: patch['采购完成'] === true,
    };
  }
  return hashStableCommandValue(result);
}

function commandResultFingerprintFromRecord(
  action: PurchaseWorkflowAction,
  record: PurchaseWorkflowRecord,
): string {
  let result: Record<string, unknown>;
  if (action === 'approve') {
    result = {
      purchaseMethod: normalizeMethod(record.purchaseMethod),
      terminated: resolvePurchaseStage(record.status) === 'terminated',
    };
  } else if (action === 'start') {
    result = {
      purchaserOpenId: record.purchaserOpenId,
      warehouseConfirmed: record.warehouseConfirmed,
    };
  } else if (action === 'order') {
    result = {
      actualQuantity: record.actualQuantity,
      actualAmount: record.actualAmount,
      paymentAttachmentTokens: normalizeStringValues(
        record.paymentAttachmentTokens,
      ),
      note: requireOptionalText(record.note),
      purchaseCompleted: record.purchaseCompleted,
    };
  } else {
    result = {
      signerOpenId: requireOptionalText(record.signerOpenId),
      receiptTime: record.receiptTime,
      receiptAttachmentTokens: normalizeStringValues(
        mergeReceiptAttachmentTokens(
          record.receiptPhotoTokens,
          record.invoiceTokens,
        ),
      ),
      note: requireOptionalText(record.note),
      receiptConfirmed: record.receiptConfirmed,
      purchaseCompleted: record.purchaseCompleted,
    };
  }
  return hashStableCommandValue(result);
}

function hashStableCommandValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableCommandValue(value)))
    .digest('hex');
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function attachmentTokensFromPatch(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeStringValues(
    value.map((entry) =>
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>).file_token
        : '',
    ),
  );
}

function normalizeStringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((entry) => requireOptionalText(entry)).filter(Boolean),
    ),
  ].sort();
}

function isExpiredCommandClaim(startedAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(startedAt);
  return (
    !Number.isFinite(timestamp) ||
    now - timestamp >= COMMAND_CLAIM_LEASE_MS
  );
}

function isDefiniteCommandUpdateRejection(error: unknown): boolean {
  const feishuCode = Number(
    (error as { feishuCode?: unknown } | null)?.feishuCode,
  );
  if (Number.isSafeInteger(feishuCode) && feishuCode !== 0) return true;
  const responseStatus = Number(
    (error as { response?: { status?: unknown } } | null)?.response?.status,
  );
  return responseStatus >= 400 && responseStatus < 500;
}

function commandUpdateNetworkCode(error: unknown): string {
  const code = requireOptionalText(
    (error as { code?: unknown } | null)?.code,
  ).toUpperCase();
  return UNKNOWN_UPDATE_NETWORK_CODES.has(code) ? code : '';
}

function cloneWorkflowDetail(
  detail: PurchaseWorkflowDetail,
): PurchaseWorkflowDetail {
  return {
    ...detail,
    record: {
      ...detail.record,
      receiptPhotoTokens: [...detail.record.receiptPhotoTokens],
      invoiceTokens: [...detail.record.invoiceTokens],
    },
    allowedActions: [...detail.allowedActions],
    timeline: detail.timeline.map((item) => ({ ...item })),
  };
}

function normalizeManualInboundCompletedContext(
  result: InventoryMovementCreateResponse,
): ManualInventoryInboundCompletedContext {
  if (!result?.movement || result.type !== 'inbound') {
    throw new ConflictException('手工入库结果缺少规范入库记录');
  }
  const movement = normalizeManualInboundMovementSnapshot(result.movement);
  if (
    movement.recordId !== requireText(result.recordId, '手工入库记录 ID 缺失')
  ) {
    throw new ConflictException('手工入库结果记录 ID 不一致');
  }
  return { version: 1, movement };
}

function parseManualInboundCompletedContext(
  value: string,
): ManualInventoryInboundCompletedContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConflictException('手工入库通知快照无效');
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.version !== 1 ||
    !isPlainRecord(parsed.movement)
  ) {
    throw new ConflictException('手工入库通知快照无效');
  }
  return {
    version: 1,
    movement: normalizeManualInboundMovementSnapshot(parsed.movement),
  };
}

function parseInboundCompletedCardContext(
  value: string,
): { sku: string; specification: string; location: string; batchId: string | null } | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConflictException('采购入库通知快照无效');
  }
  if (!isPlainRecord(parsed) || parsed.version !== 1) {
    throw new ConflictException('采购入库通知快照无效');
  }
  return {
    sku: snapshotDisplayText(parsed.sku, 100),
    specification: snapshotDisplayText(parsed.specification, 200),
    location: snapshotDisplayText(parsed.location, 500),
    batchId: typeof parsed.batchId === 'string' && /^[a-f0-9]{32}$/u.test(parsed.batchId) ? parsed.batchId : null,
  };
}

function normalizeManualInboundMovementSnapshot(
  value: unknown,
): ManualInventoryInboundCompletedContext['movement'] {
  if (!isPlainRecord(value)) {
    throw new ConflictException('手工入库通知快照无效');
  }
  const quantity = Number(value.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ConflictException('手工入库通知快照数量无效');
  }
  const occurredAtText = snapshotDisplayText(value.occurredAt, 80);
  const occurredAt = new Date(occurredAtText);
  return {
    recordId: snapshotText(value.recordId, '入库记录 ID', 100),
    sku: snapshotDisplayText(value.sku, 100),
    name: snapshotDisplayText(value.name, 200),
    specification: snapshotDisplayText(value.specification, 200),
    quantity,
    unit: snapshotDisplayText(value.unit, 40),
    building: snapshotText(value.building, '楼栋', 40),
    location: snapshotDisplayText(value.location, 500),
    occurredAt: Number.isFinite(occurredAt.getTime())
      ? occurredAt.toISOString()
      : null,
  };
}

function snapshotText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string') {
    throw new ConflictException(`手工入库通知快照${label}无效`);
  }
  const normalized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized || Array.from(normalized).length > limit) {
    throw new ConflictException(`手工入库通知快照${label}无效`);
  }
  return normalized;
}

function snapshotDisplayText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(normalized).slice(0, limit).join('');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidUserOpenId(value: string): boolean {
  return /^ou_[A-Za-z0-9_-]{1,125}$/.test(value.trim());
}

export function buildTimeline(
  stage: PurchaseWorkflowStage,
): PurchaseWorkflowTimelineItem[] {
  const nodes: Array<{
    key: PurchaseWorkflowTimelineItem['key'];
    label: string;
  }> = [
    { key: 'application', label: '申请审批' },
    { key: 'approval', label: '库房确认' },
    { key: 'ordering', label: '采购下单' },
    { key: 'receipt', label: '收货签收' },
    { key: 'inbound', label: '等待入库' },
    { key: 'completed', label: '采购完成' },
  ];
  const order = new Map(nodes.map((node, index) => [node.key, index]));
  const current = order.get(stage as PurchaseWorkflowTimelineItem['key']);
  return nodes.map((node, index) => ({
    ...node,
    state:
      stage === 'terminated'
        ? index === 0
          ? 'terminated'
          : 'pending'
        : current === undefined
          ? 'pending'
          : index < current
            ? 'completed'
            : index === current
              ? 'current'
              : 'pending',
  }));
}

function mapRuleError(error: unknown): Error {
  const message = errorMessage(error);
  if (message.startsWith('无权')) return new ForbiddenException(message);
  if (message.startsWith('当前状态')) return new ConflictException(message);
  return new BadRequestException(message);
}

function firstUserOpenId(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const first = value[0];
  if (!first || typeof first !== 'object') return '';
  return requireOptionalText((first as Record<string, unknown>).id);
}

function requireText(value: unknown, message: string): string {
  const normalized = requireOptionalText(value);
  if (!normalized) throw new BadRequestException(message);
  return normalized;
}

function assertBuildingAdministratorWorkflowScope(
  record: PurchaseWorkflowRecord,
  session: PurchaseWorkflowSession,
): void {
  if (isProfessionalBusinessPrincipal(session.permissionPrincipal)) {
    assertProfessionalRecordScope(session.permissionPrincipal, record.specialty, record.building);
    return;
  }
  if (session.accessRole === 'professional_engineer') throw new ForbiddenException('工程师授权范围缺失');
  if (session.accessRole === 'professional_admin') {
    assertProfessionalRecordScope({ role: 'professional_admin', purchaseBuilding: null, specialties: session.specialties }, record.specialty, record.building);
    return;
  }
  if (session.accessRole !== 'building_admin') return;
  if (
    !session.purchaseBuilding ||
    !canAccessBuilding({ role: 'building_admin', purchaseBuilding: session.purchaseBuilding as never, buildings: session.purchaseBuildings }, requireOptionalText(record.building))
  ) {
    throw new ForbiddenException('无权访问其他楼栋采购记录');
  }
}

function requireOptionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error || '采购工作流执行失败');
}

function reminderMatches(
  code: PurchaseWorkflowReminderCode,
  status: string,
  purchaseCompleted: boolean,
): boolean {
  if (code === 'warehouse') {
    return status === '审批通过（待下单）' && !purchaseCompleted;
  }
  if (code === 'order') {
    return !purchaseCompleted && resolvePurchaseStage(status) === 'ordering';
  }
  return status === '下单完成（待签收）';
}

function reminderRecordCreatedAtMs(record: PurchaseWorkflowRecord): number {
  const createdAt = Number(record.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0;
}

function reminderMessage(
  code: PurchaseWorkflowReminderCode,
  subject: string,
): string {
  if (code === 'warehouse')
    return `采购任务 ${subject} 已完成库房确认，请尽快下单`;
  if (code === 'order')
    return `采购任务 ${subject} 尚未完成下单，请跟进采购进度`;
  return `采购任务 ${subject} 已下单，请在到货后完成签收`;
}

function shanghaiDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function selfTestExecutionFields(
  marker: string,
  requesterOpenId: string,
): Record<string, unknown> {
  return {
    采购编码: marker,
    需求人: [{ id: requesterOpenId }],
    申请楼栋: ['H楼'],
    专业: '其他',
    一级分类: 'D消耗类',
    二级分类: '办公耗材D2',
    '1️⃣物品采购方式': '综合采购',
    采购渠道: '线上',
    供应商: 'CODEX SELFTEST',
    '线上链接（仅线上需填写）': {
      link: 'https://example.invalid/codex-selftest',
      text: 'https://example.invalid/codex-selftest',
    },
    采购申请数量: 1,
    计数单位: '件',
    单价: 1,
    物品名称: marker,
    '物品规格型号、设备序列号': 'SELFTEST',
    物品品牌: 'SELFTEST',
    '是否满足三家比价（线下）': '是',
    '需求简述（采购原因、目的等）': '采购管理程序闭环自测',
    期望交付时间: Date.now() + 7 * 24 * 60 * 60 * 1000,
    采购到货入库后是否需要立即领用出库: false,
    采购流程: '未开始（待审批）',
    库房确认: false,
    采购完成: false,
  };
}

function sentinelResetFields(
  status: '未开始（待审批）' | '驳回申请',
): Record<string, unknown> {
  return {
    采购流程: status,
    库房确认: false,
    采购完成: false,
    '到货签收确认（签收内容填写完成后点击）': false,
    实际采购数量: 0,
    实际付款金额: 0,
    采购人: null,
    签收人: null,
    签收时间: null,
    '付款截屏（显示付款金额）': [],
    签收附件: [],
    采购备注: '系统健康检查哨兵记录，不参与业务统计',
  };
}

function isHealthcheckRecord(requestCode: string): boolean {
  return requestCode.startsWith('CODEX-PURCHASE-WORKFLOW-');
}

function toApprovalCardInput(
  record: Awaited<
    ReturnType<PurchaseWorkflowGateway['getExecutionRecordAsApp']>
  >,
): PurchaseApprovalCardInput {
  const amount =
    record.unitPrice !== null &&
    record.unitPrice !== undefined &&
    Number.isFinite(record.unitPrice)
      ? record.requestedQuantity * record.unitPrice
      : null;
  return {
    executionRecordId: record.recordId,
    requester: record.requesterName || record.requesterOpenId,
    building: record.building,
    title: record.itemName,
    quantity: record.requestedQuantity,
    unit: record.unit || '',
    amount,
    purchaseMethod: record.purchaseMethod,
    expectedDeliveryAt: record.expectedDeliveryDate,
    requestCode: record.requestCode,
    createdAt: record.createdAt || null,
    statusLabel: record.status,
  };
}

function nextTaskAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** exponent));
}

function selfTestReceiptPhoto() {
  const buffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nCEAAAAASUVORK5CYII=',
    'base64',
  );
  return {
    originalname: 'codex-purchase-workflow-selftest.png',
    mimetype: 'image/png',
    size: buffer.byteLength,
    buffer,
  };
}

async function deleteWithRetry(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3)
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}
