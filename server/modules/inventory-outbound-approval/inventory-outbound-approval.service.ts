import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { isDeepStrictEqual } from 'node:util';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import {
  buildInventoryOutboundAcceptedCard,
  buildInventoryOutboundApprovalCard,
  buildInventoryOutboundRejectionPromptCard,
  buildInventoryOutboundSupersededCard,
  buildInventoryOutboundTerminalCard,
} from './inventory-outbound-approval.card';
import { parseInventoryOutboundCardAction } from './inventory-outbound-approval.callback';
import { InventoryOutboundApprovalGateway } from './inventory-outbound-approval.gateway';
import { InventoryOutboundApprovalFinalizerRegistry } from './inventory-outbound-approval.finalizer';
import { parseInventoryOutboundApprovalRecoveryRecord } from './inventory-outbound-approval.recovery';
import type { InventoryOutboundApprovalRecoveryRecord } from './inventory-outbound-approval.recovery';
import { assertSameOutboundApprovalRequest } from './inventory-outbound-approval.validation';
import { InventoryOutboundApprovalStore } from './inventory-outbound-approval.store';
import {inventoryManagerNotificationRecipients} from './inventory-manager-notification-route';
import { InventoryWarehouseRoleDirectory } from './inventory-warehouse-role-directory';
import { InventoryBatchCardService, type InventoryBatchCardItem } from './inventory-batch-card.service';
import { inventoryNotificationBatchId } from './inventory-batch-notification-id';
import type {
  InventoryOutboundApprovalEntry,
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalRequestIdentity,
  InventoryOutboundApprovalSnapshot,
  InventoryOutboundApprovalWork,
  InventoryOutboundApprovalWorkKind,
  InventoryOutboundApprovalWorkRef,
} from './inventory-outbound-approval.types';

export interface InventoryOutboundApprovalRunResult {
  processed: number;
  failed: number;
}

export interface InventoryOutboundApprovalRecoveryRunResult {
  scanned: number;
  restored: number;
  skipped: number;
  failed: number;
}

export interface InventoryOutboundApprovalCardActionResult {
  claimed: boolean;
  card: Record<string, unknown>;
  toast?: string;
}

const TERMINAL_WORK_STATUSES = new Set(['completed', 'cancelled']);
const WORK_PHASES: ReadonlyArray<{
  kind: InventoryOutboundApprovalWorkKind;
  eligible: (entry: InventoryOutboundApprovalEntry) => boolean;
}> = [
  { kind: 'approvalCardDelivery', eligible: () => true },
  { kind: 'baseSync', eligible: (entry) => Boolean(entry.decision) },
  {
    kind: 'cardPatch',
    eligible: (entry) =>
      entry.baseSync?.status === 'completed' ||
      replacementVersionOf(entry) !== null,
  },
  {
    kind: 'resultNotification',
    eligible: (entry) =>
      entry.baseSync?.status === 'completed' &&
      entry.approvalCards.every((work) =>
        TERMINAL_WORK_STATUSES.has(work.status),
      ) &&
      entry.cardPatches.every((work) =>
        TERMINAL_WORK_STATUSES.has(work.status),
      ),
  },
];

type WorkExecutionResult = 'completed' | 'failed' | 'skipped';

@Injectable()
export class InventoryOutboundApprovalService {
  private readonly logger = new Logger(InventoryOutboundApprovalService.name);
  private phaseCursor = 0;
  private readonly finalizedEntries = new Set<string>();

  constructor(
    private readonly store: InventoryOutboundApprovalStore,
    private readonly gateway: InventoryOutboundApprovalGateway,
    @Optional()
    private readonly finalizer?: InventoryOutboundApprovalFinalizerRegistry,
    @Optional()
    private readonly warehouseRoleDirectory?: InventoryWarehouseRoleDirectory,
    @Optional()
    private readonly batchCardService?: InventoryBatchCardService,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  isEnabled(): boolean {
    return Boolean(
      readEnv('FEISHU_APP_ID') &&
      readEnv('FEISHU_APP_SECRET') &&
      readEnv('FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID') &&
      (readEnv('FEISHU_WAREHOUSE_APP_TOKEN') ||
        readEnv('FEISHU_WAREHOUSE_SOURCE_URL')),
    );
  }

  async registerPending(snapshot: InventoryOutboundApprovalSnapshot) {
    const registered = await this.store.registerPending(snapshot);
    return this.completePendingRegistration(registered);
  }

  async ensurePendingForRequest(
    record: InventoryOutboundApprovalRecoveryRecord,
    request: InventoryOutboundApprovalRequestIdentity,
    createSnapshot: () => Promise<InventoryOutboundApprovalSnapshot>,
  ): Promise<InventoryOutboundApprovalEntry> {
    if (record.recordId !== request.recordId) {
      throw new ConflictException('出库记录与申请编号不一致');
    }
    if (hasSemanticContent(record.fields['出库审批快照'])) {
      const recovery = parseInventoryOutboundApprovalRecoveryRecord(record);
      if (recovery.kind === 'not_registered')
        throw new ConflictException('出库审批快照缺失');
      assertSameOutboundApprovalRequest(request, recovery.snapshot);
      const restored = await this.store.restoreFromBase(recovery);
      if (hasSemanticContent(record.fields['出库工作流错误'])) {
        await this.gateway.clearWorkflowError(record.recordId);
      }
      return restored.entry;
    }
    const existing = await this.store.find(request.recordId, 1);
    const snapshot = existing?.snapshot || (await createSnapshot());
    assertSameOutboundApprovalRequest(request, snapshot);
    // A concurrent route may have won while the directory/stock was loading.
    // Preserve that first durable snapshot; never replace its approval targets.
    const registered = await this.store.registerPending(snapshot, {
      reuseExistingRequest: true,
    });
    const result = await this.completePendingRegistration(registered);
    if (
      registered.entry.registration.status === 'ready' &&
      hasSemanticContent(record.fields['出库工作流错误'])
    ) {
      await this.gateway.clearWorkflowError(record.recordId);
    }
    return result.entry;
  }

  private async completePendingRegistration(registered: {
    created: boolean;
    entry: InventoryOutboundApprovalEntry;
  }) {
    if (
      registered.entry.decision ||
      registered.entry.registration.status === 'ready'
    ) {
      return registered;
    }
    try {
      await this.gateway.writePendingApproval(registered.entry.snapshot);
      const entry = await this.store.confirmPendingRegistration(
        registered.entry.snapshot.recordId,
        registered.entry.snapshot.version,
      );
      return { ...registered, entry };
    } catch (error) {
      await this.store.failPendingRegistration(
        registered.entry.snapshot.recordId,
        registered.entry.snapshot.version,
        safeErrorMessage(error),
      );
      throw error;
    }
  }

  async assertAcceptedDecision(
    snapshot: InventoryOutboundApprovalSnapshot,
    decision: InventoryOutboundApprovalDecision,
  ): Promise<void> {
    const entry = await this.store.find(snapshot.recordId, snapshot.version);
    if (!entry || entry.registration.status !== 'ready' ||
      replacementVersionOf(entry) !== null || decision.action !== 'approve' ||
      !entry.decision || !isDeepStrictEqual(entry.snapshot, snapshot) ||
      !isDeepStrictEqual(entry.decision, decision)) {
      throw new ForbiddenException('出库正式审批决定与持久账本不一致');
    }
  }

  async handleCardAction(
    payload: unknown,
  ): Promise<InventoryOutboundApprovalCardActionResult> {
    const action = parseInventoryOutboundCardAction(payload);
    assertFeishuBusinessIdentity(this.accessConfiguration, action.actorOpenId);
    const current = await this.requireBoundEntry(
      action.recordId,
      action.version,
      action.actorOpenId,
      action.messageId,
    );

    if (current.decision || current.personnelHandover) {
      return {
        claimed: false,
        card: await this.resultCard(current, action.actorOpenId),
      };
    }

    if (action.kind === 'open_rejection') {
      return {
        claimed: false,
        card: buildInventoryOutboundRejectionPromptCard(current.snapshot),
        toast: '请填写驳回原因',
      };
    }

    if (action.kind === 'return_to_approval') {
      const batchId = inventoryNotificationBatchId(current.snapshot.outboundNumber, 'outbound');
      return {
        claimed: false,
        card: batchId && this.batchCardService
          ? await this.batchCardService.render('outbound', batchId, action.actorOpenId)
          : buildInventoryOutboundApprovalCard(current.snapshot),
        toast: '已返回审批',
      };
    }

    try {
      const claim = await this.store.claimDecision({
        recordId: action.recordId,
        version: action.version,
        actorOpenId: action.actorOpenId,
        messageId: action.messageId,
        eventId: action.eventId,
        action: action.action,
        reason: action.reason,
      });
      return {
        claimed: claim.claimed,
        card: await this.resultCard(claim.entry, action.actorOpenId),
      };
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      const raced = await this.store.find(action.recordId, action.version);
      if (!raced?.decision && !raced?.personnelHandover) throw error;
      return {
        claimed: false,
        card: await this.resultCard(raced, action.actorOpenId),
      };
    }
  }

  async runPending(limit = 100): Promise<InventoryOutboundApprovalRunResult> {
    const normalizedLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), 500)
      : 100;
    const result: InventoryOutboundApprovalRunResult = {
      processed: 0,
      failed: 0,
    };
    let remaining = normalizedLimit;
    const phaseCount = WORK_PHASES.length;
    const usesRotatingStart = normalizedLimit < phaseCount;
    const start = usesRotatingStart ? this.phaseCursor % phaseCount : 0;
    let nextCursor = (start + 1) % phaseCount;
    for (let offset = 0; offset < phaseCount && remaining > 0; offset += 1) {
      const phaseIndex = (start + offset) % phaseCount;
      const phase = WORK_PHASES[phaseIndex];
      const phasesIncludingCurrent = phaseCount - offset;
      const phaseBudget = Math.max(
        1,
        Math.ceil(remaining / phasesIncludingCurrent),
      );
      const unused = await this.runPhase(
        phase.kind,
        phaseBudget,
        result,
        phase.eligible,
      );
      const used = phaseBudget - unused;
      remaining -= used;
      if (used > 0) nextCursor = (phaseIndex + 1) % phaseCount;
    }
    if (usesRotatingStart) this.phaseCursor = nextCursor;
    await this.resumePendingHandovers(result);
    await this.finalizeCompletedEntries(result);
    return result;
  }

  async recoverFromBase(): Promise<InventoryOutboundApprovalRecoveryRunResult> {
    const records = await this.gateway.listRecoveryRecords();
    const result: InventoryOutboundApprovalRecoveryRunResult = {
      scanned: records.length,
      restored: 0,
      skipped: 0,
      failed: 0,
    };
    for (const record of records) {
      try {
        const recovery = parseInventoryOutboundApprovalRecoveryRecord(record);
        if (recovery.kind === 'not_registered') {
          if (!this.finalizer) {
            throw new Error('出库申请恢复服务尚未就绪，请稍后重试');
          }
          await this.finalizer.recoverUnregisteredOutbound(record.recordId);
          if (hasSemanticContent(record.fields['出库工作流错误'])) {
            await this.gateway.clearWorkflowError(record.recordId);
          }
          result.restored += 1;
          continue;
        }
        if (
          recovery.kind === 'decided' &&
          recovery.requiresBusinessFinalization === true
        ) {
          if (!this.warehouseRoleDirectory) {
            throw new Error('库房示例人员019员目录尚未就绪，请稍后重试');
          }
          const [currentResponsibleUsers, currentManagerRecipients] =
            await Promise.all([
              this.warehouseRoleDirectory.resolveApprovers(
                recovery.snapshot.building,
                true,
              ),
              this.warehouseRoleDirectory.resolveNotificationRecipients(
                recovery.snapshot.building,
                true,
              ),
            ]);
          const actorStillResponsible = currentResponsibleUsers.some(
            (candidate) => candidate.openId === recovery.decision.actorOpenId,
          );
          if (!actorStillResponsible) {
            const oldEntry = await this.store.find(
              recovery.snapshot.recordId,
              recovery.snapshot.version,
            );
            if (!oldEntry || replacementVersionOf(oldEntry) === null) {
              await this.store.restoreFromBase(recovery);
            }
            await this.rerouteHistoricalApproval(
              recovery,
              currentResponsibleUsers,
              currentManagerRecipients,
            );
          } else {
            await this.store.restoreFromBase(recovery);
          }
        } else {
          await this.store.restoreFromBase(recovery);
        }
        if (hasSemanticContent(record.fields['出库工作流错误'])) {
          await this.gateway.clearWorkflowError(record.recordId);
        }
        result.restored += 1;
      } catch (error) {
        result.failed += 1;
        try {
          await this.gateway.writeWorkflowError(record.recordId, error);
        } catch (writeError) {
          this.logger.error(
            `出库审批恢复错误回写失败: record=${safeLogValue(record.recordId)}, message=${safeLogValue(safeErrorMessage(writeError))}`,
          );
        }
      }
    }
    return result;
  }

  private async runPhase(
    kind: InventoryOutboundApprovalWorkKind,
    limit: number,
    result: InventoryOutboundApprovalRunResult,
    eligible: (entry: InventoryOutboundApprovalEntry) => boolean,
  ): Promise<number> {
    if (limit <= 0) return 0;
    const entries = await this.store.listEntries();
    let remaining = limit;
    if (kind === 'approvalCardDelivery' || kind === 'resultNotification') {
      const groups: Array<{ entry: InventoryOutboundApprovalEntry; works: InventoryOutboundApprovalWork[] }> = [];
      let selected = 0;
      for (const entry of entries) {
        if (!eligible(entry) || selected >= limit) continue;
        const works = this.worksOfKind(entry, kind)
          .filter((work) => work.status === 'pending' || work.status === 'error')
          .slice(0, limit - selected);
        if (!works.length) continue;
        groups.push({ entry, works });
        selected += works.length;
      }
      for (let index = 0; index < groups.length; index += 4) {
        await Promise.all(groups.slice(index, index + 4).map(async ({ entry, works }) => {
          for (const work of works) {
            const execution = await this.processWork(entry, work);
            if (execution === 'skipped') continue;
            remaining -= 1;
            if (execution === 'completed') result.processed += 1;
            else result.failed += 1;
          }
        }));
      }
      return remaining;
    }
    for (const entry of entries) {
      if (remaining <= 0 || !eligible(entry)) continue;
      const works = this.worksOfKind(entry, kind);
      for (const work of works) {
        if (remaining <= 0) break;
        if (work.status !== 'pending' && work.status !== 'error') continue;
        const execution = await this.processWork(entry, work);
        if (execution === 'skipped') continue;
        remaining -= 1;
        if (execution === 'completed') result.processed += 1;
        else result.failed += 1;
      }
    }
    return remaining;
  }

  private async resumePendingHandovers(result: InventoryOutboundApprovalRunResult): Promise<void> {
    for (const entry of await this.store.listEntries()) {
      if (entry.personnelHandoverFromVersion === undefined || entry.registration.status === 'ready') continue;
      const previous = await this.store.find(entry.snapshot.recordId, entry.personnelHandoverFromVersion);
      if (!previous?.personnelHandover || previous.personnelHandover.targetVersion !== entry.snapshot.version ||
        previous.cardPatches.some(patch => patch.status !== 'completed')) continue;
      try {
        assertFeishuBusinessIdentity(this.accessConfiguration, previous.personnelHandover.target.openId);
        await this.gateway.writePendingHandover(previous.snapshot, entry.snapshot);
        await this.store.confirmPendingRegistration(entry.snapshot.recordId, entry.snapshot.version);
        result.processed += 1;
      } catch {
        await this.store.failPendingRegistration(entry.snapshot.recordId, entry.snapshot.version, '出库交接外部状态尚未确认，请恢复原任务');
        result.failed += 1;
      }
    }
  }

  private async rerouteHistoricalApproval(
    recovery: Extract<
      ReturnType<typeof parseInventoryOutboundApprovalRecoveryRecord>,
      { kind: 'decided' }
    >,
    currentResponsibleUsers: InventoryOutboundApprovalSnapshot['approvers'],
    currentManagerRecipients: InventoryOutboundApprovalSnapshot['approvers'],
  ): Promise<void> {
    if (recovery.snapshot.version >= Number.MAX_SAFE_INTEGER) {
      throw new Error('出库审批版本已达上限，无法安全重新路由');
    }
    const replacement: InventoryOutboundApprovalSnapshot = {
      ...recovery.snapshot,
      version: recovery.snapshot.version + 1,
      policyVersion: 'inventory-outbound-responsible-v2',
      approvers: currentResponsibleUsers,
      managerRecipients: currentManagerRecipients,
    };
    const superseded = await this.store.supersedeApprovedDecision(
      recovery.snapshot.recordId,
      recovery.snapshot.version,
      replacement,
    );
    if (superseded.entry.registration.status === 'ready') return;
    await this.gateway.writeReroutedPendingApproval(
      recovery.snapshot,
      recovery.decision,
      replacement,
    );
    await this.store.confirmPendingRegistration(
      replacement.recordId,
      replacement.version,
    );
  }

  private worksOfKind(
    entry: InventoryOutboundApprovalEntry,
    kind: InventoryOutboundApprovalWorkKind,
  ): InventoryOutboundApprovalWork[] {
    switch (kind) {
      case 'approvalCardDelivery':
        return entry.approvalCards;
      case 'baseSync':
        return entry.baseSync ? [entry.baseSync] : [];
      case 'cardPatch':
        return entry.cardPatches;
      case 'resultNotification':
        return entry.resultNotifications;
    }
  }

  private async processWork(
    entry: InventoryOutboundApprovalEntry,
    work: InventoryOutboundApprovalWork,
  ): Promise<WorkExecutionResult> {
    const ref: InventoryOutboundApprovalWorkRef = {
      recordId: entry.snapshot.recordId,
      version: entry.snapshot.version,
      kind: work.kind,
      ...('recipientOpenId' in work
        ? { recipientOpenId: work.recipientOpenId }
        : {}),
    };
    const claim = await this.store.claimWork(ref);
    if (!claim.claimed) return 'skipped';

    try {
      let messageId: string | undefined;
      await this.withWorkClaimHeartbeat(
        { ...ref, leaseToken: claim.leaseToken },
        async () => {
          switch (claim.work.kind) {
            case 'approvalCardDelivery':
              {
                if (claim.entry.personnelHandoverFromVersion !== undefined) {
                  assertFeishuBusinessIdentity(this.accessConfiguration, claim.work.recipientOpenId);
                }
                const batchId = inventoryNotificationBatchId(claim.entry.snapshot.outboundNumber, 'outbound');
                messageId = batchId
                  ? await (claim.entry.personnelHandoverFromVersion === undefined
                      ? this.requireBatchCardService().upsert('outbound', batchId, claim.work.recipientOpenId, toBatchCardItem(claim.entry.snapshot, '待审批'))
                      : this.requireBatchCardService().upsertConfirmed('outbound', batchId, claim.work.recipientOpenId, toBatchCardItem(claim.entry.snapshot, '待审批')))
                  : await this.gateway.sendInteractiveCard(
                      claim.work.recipientOpenId,
                      buildInventoryOutboundApprovalCard(claim.entry.snapshot),
                      claim.work.deliveryUuid,
                    );
              }
              await this.gateway.writeApprovalCardDeliveryLedger(
                claim.entry.snapshot,
                [
                  ...claim.entry.approvalCards
                    .filter(
                      (card) =>
                        card.status === 'completed' && Boolean(card.messageId),
                    )
                    .map((card) => ({
                      recipientOpenId: card.recipientOpenId,
                      recipientName: card.recipientName,
                      deliveryUuid: card.deliveryUuid,
                      messageId: card.messageId!,
                    })),
                  {
                    recipientOpenId: claim.work.recipientOpenId,
                    recipientName: claim.work.recipientName,
                    deliveryUuid: claim.work.deliveryUuid,
                    messageId,
                  },
                ].sort((left, right) =>
                  left.recipientOpenId.localeCompare(right.recipientOpenId),
                ),
              );
              break;
            case 'baseSync':
              if (!claim.entry.decision) {
                throw new Error('出库审批多维同步缺少审批决定');
              }
              if (claim.entry.decision.action === 'approve') {
                if (!this.finalizer) {
                  throw new Error('出库正式确认服务尚未就绪，请稍后重试');
                }
                await this.gateway.writeDecision(
                  claim.entry.snapshot,
                  claim.entry.decision,
                );
                await this.finalizer.finalizeApprovedOutbound(
                  claim.entry.snapshot,
                  claim.entry.decision,
                );
              } else {
                await this.gateway.writeDecision(
                  claim.entry.snapshot,
                  claim.entry.decision,
                );
              }
              break;
            case 'cardPatch':
              if (!claim.entry.decision && !claim.entry.personnelHandover) {
                throw new Error('出库审批卡片终态化缺少审批决定');
              }
              {
                const replacementVersion = replacementVersionOf(claim.entry);
                const batchId = inventoryNotificationBatchId(claim.entry.snapshot.outboundNumber, 'outbound');
                if (batchId) {
                  const item = toBatchCardItem(claim.entry.snapshot, replacementVersion === null
                    ? claim.entry.decision!.action === 'approve' ? '已出库' : '已驳回' : '审批失效');
                  if (claim.entry.personnelHandover) await this.requireBatchCardService().upsertConfirmed('outbound', batchId, claim.work.recipientOpenId, item);
                  else await this.requireBatchCardService().upsert('outbound', batchId, claim.work.recipientOpenId, item);
                } else {
                  await this.gateway.patchInteractiveCard(
                    claim.work.messageId,
                    replacementVersion === null
                      ? buildInventoryOutboundTerminalCard(claim.entry.snapshot, claim.entry.decision!)
                      : buildInventoryOutboundSupersededCard(claim.entry.snapshot, replacementVersion),
                  );
                }
              }
              break;
            case 'resultNotification':
              if (!claim.entry.decision) {
                throw new Error('出库审批结果通知缺少审批决定');
              }
              const resultRecipientOpenId=claim.work.recipientOpenId;
              if (inventoryManagerNotificationRecipients(claim.entry).some(person=>person.openId===resultRecipientOpenId) &&
                claim.entry.snapshot.applicantOpenId!==resultRecipientOpenId &&
                !claim.entry.snapshot.approvers.some(person=>person.openId===resultRecipientOpenId)) {
                assertFeishuBusinessIdentity(this.accessConfiguration,resultRecipientOpenId);
              }
              {
                const snapshot = claim.entry.snapshot;
                const batchId = inventoryNotificationBatchId(snapshot.outboundNumber, 'outbound');
                if (batchId) {
                  if (!this.batchCardService) throw new Error('批量出库通知服务未就绪');
                  messageId = await this.batchCardService.upsert('outbound', batchId, claim.work.recipientOpenId,
                    toBatchCardItem(snapshot, claim.entry.decision.action === 'approve' ? '已出库' : '已驳回'));
                } else {
                  messageId = await this.gateway.sendInteractiveCard(
                    claim.work.recipientOpenId,
                    buildInventoryOutboundTerminalCard(snapshot, claim.entry.decision),
                    claim.work.deliveryUuid,
                  );
                }
              }
              const resultDeliveries = [
                  ...claim.entry.resultNotifications
                    .filter(
                      (notification) =>
                        notification.status === 'completed' &&
                        Boolean(notification.messageId),
                    )
                    .map((notification) => ({
                      recipientOpenId: notification.recipientOpenId,
                      recipientName: notification.recipientName,
                      deliveryUuid: notification.deliveryUuid,
                      messageId: notification.messageId!,
                    })),
                  {
                    recipientOpenId: claim.work.recipientOpenId,
                    recipientName: claim.work.recipientName,
                    deliveryUuid: claim.work.deliveryUuid,
                    messageId,
                  },
                ].sort((left, right) =>
                  left.recipientOpenId.localeCompare(right.recipientOpenId),
                );
              if (claim.entry.managerNotificationHandovers?.length) {
                await this.gateway.writeApprovalResultDeliveryLedger(
                  claim.entry.snapshot, claim.entry.decision, resultDeliveries,
                  claim.entry.managerNotificationHandovers,
                );
              } else {
                await this.gateway.writeApprovalResultDeliveryLedger(
                  claim.entry.snapshot, claim.entry.decision, resultDeliveries,
                );
              }
              break;
          }
        },
      );
      await this.store.completeWork({
        ...ref,
        leaseToken: claim.leaseToken,
        ...(messageId ? { messageId } : {}),
      });
      return 'completed';
    } catch (error) {
      try {
        await this.store.failWork({
          ...ref,
          leaseToken: claim.leaseToken,
          error: safeErrorMessage(error),
        });
      } catch {
        // The original work error is the actionable failure. A lost lease is
        // safely recoverable because every external mutation is idempotent.
      }
      return 'failed';
    }
  }

  private async withWorkClaimHeartbeat<T>(
    ref: InventoryOutboundApprovalWorkRef & { leaseToken: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    const intervalMs = this.store.getLeaseHeartbeatIntervalMs();
    let stopped = false;
    let heartbeatError: unknown;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped || heartbeatError) return;
      renewal = renewal
        .then(async () => {
          if (stopped) return;
          await this.store.renewWorkClaim(ref);
        })
        .catch((error: unknown) => {
          heartbeatError = error;
          stopped = true;
          clearInterval(timer);
        });
    }, intervalMs);
    timer.unref?.();

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    } finally {
      stopped = true;
      clearInterval(timer);
      await renewal;
    }
    if (operationError) throw operationError;
    if (heartbeatError) throw heartbeatError;
    return result as T;
  }

  private async requireBoundEntry(
    recordId: string,
    version: number,
    actorOpenId: string,
    messageId: string,
  ): Promise<InventoryOutboundApprovalEntry> {
    let entry = await this.store.find(recordId, version);
    if (!entry) {
      const record = await this.gateway.readOutboundRecord(recordId);
      const recovery = parseInventoryOutboundApprovalRecoveryRecord(record, {
        allowFinalized: true,
      });
      if (
        recovery.kind === 'not_registered' ||
        recovery.snapshot.version !== version
      ) {
        throw new NotFoundException('出库审批记录不存在');
      }
      entry = (await this.store.restoreFromBase(recovery)).entry;
    }
    const card = entry.approvalCards.find(
      (candidate) =>
        candidate.recipientOpenId === actorOpenId &&
        candidate.status === 'completed' &&
        candidate.messageId === messageId,
    );
    if (!card) throw new ForbiddenException('审批消息不属于当前审批人');
    return entry;
  }

  private async finalizeCompletedEntries(
    result: InventoryOutboundApprovalRunResult,
  ): Promise<void> {
    const entries = await this.store.listEntries();
    for (const entry of entries) {
      if (!entry.completedAt) continue;
      if (replacementVersionOf(entry) !== null) continue;
      const key = `${entry.snapshot.recordId}:${entry.snapshot.version}`;
      if (this.finalizedEntries.has(key)) continue;
      try {
        await this.gateway.writeFinalizationCompleted(entry.snapshot);
        this.finalizedEntries.add(key);
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `出库审批收尾状态回写失败: record=${safeLogValue(entry.snapshot.recordId)}, version=${entry.snapshot.version}, message=${safeLogValue(safeErrorMessage(error))}`,
        );
      }
    }
  }

  private async resultCard(
    entry: InventoryOutboundApprovalEntry,
    recipientOpenId: string,
  ): Promise<Record<string, unknown>> {
    const replacementVersion = replacementVersionOf(entry);
    if (!entry.decision && replacementVersion === null) throw new Error('出库审批结果卡片缺少审批决定');
    const batchId = inventoryNotificationBatchId(entry.snapshot.outboundNumber, 'outbound');
    if (batchId) {
      const service = this.requireBatchCardService();
      await service.upsert('outbound', batchId, recipientOpenId, toBatchCardItem(entry.snapshot,
        replacementVersion !== null ? '审批失效' :
        entry.baseSync?.status === 'completed'
          ? entry.decision!.action === 'approve' ? '已出库' : '已驳回'
          : entry.decision!.action === 'approve' ? '同步中' : '已驳回'));
      return service.render('outbound', batchId, recipientOpenId);
    }
    if (replacementVersion !== null) {
      return buildInventoryOutboundSupersededCard(
        entry.snapshot,
        replacementVersion,
      );
    }
    return entry.baseSync?.status === 'completed'
      ? buildInventoryOutboundTerminalCard(entry.snapshot, entry.decision!)
      : buildInventoryOutboundAcceptedCard(entry.snapshot, entry.decision!);
  }

  private requireBatchCardService(): InventoryBatchCardService {
    return requireBatchCardService(this.batchCardService);
  }
}

function toBatchCardItem(snapshot: InventoryOutboundApprovalSnapshot, status: string): InventoryBatchCardItem {
  return {
    id: snapshot.recordId,
    name: snapshot.itemName,
    sku: snapshot.sku,
    specification: snapshot.specification,
    quantity: snapshot.quantity,
    unit: snapshot.unit,
    building: snapshot.building,
    location: snapshot.location,
    status,
    approvalVersion: snapshot.version,
  };
}

function requireBatchCardService(service?: InventoryBatchCardService): InventoryBatchCardService {
  if (!service) throw new Error('批量出库通知服务未就绪');
  return service;
}

function replacementVersionOf(
  entry: InventoryOutboundApprovalEntry,
): number | null {
  if (entry.personnelHandover) return entry.personnelHandover.targetVersion;
  const match = /审批版本已失效，已由版本 (\d+)$/u.exec(
    entry.baseSync?.lastError || '',
  );
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > entry.snapshot.version
    ? version
    : null;
}

function safeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || '未知错误');
  return message.replace(/\s+/gu, ' ').trim().slice(0, 800) || '未知错误';
}

function hasSemanticContent(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (depth >= 4 || !value) return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasSemanticContent(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((item) =>
    hasSemanticContent(item, depth + 1),
  );
}

function safeLogValue(value: unknown): string {
  return String(value || '')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b(secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 300);
}
