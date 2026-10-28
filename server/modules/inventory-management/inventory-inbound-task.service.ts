import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { businessAuthorizationIdentityKey, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  InventoryInboundAcceptedResponse,
  InventoryInboundTask,
  InventoryInboundTaskStatusResponse,
  InventoryMovementCreateResponse,
  InventoryNewInboundMovementCreateRequest,
  PurchaseInboundConfirmRequest,
  PurchaseInboundConfirmResponse,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  assertInventoryMovementDeletionRole,
  assertInventoryMovementScope,
  assertPurchaseInboundScope,
} from './inventory-access-policy';
import {
  buildInventoryInboundTaskRequestFingerprint,
  InventoryInboundTaskLedgerStore,
  type InventoryInboundTaskLedgerEntry,
  type InventoryInboundTaskLedgerTask,
  type InventoryInboundTaskRequest,
  type ManualInventoryInboundTaskRequest,
} from './inventory-inbound-task-ledger.store';
import { InventoryMovementCommandService } from './inventory-movement-command.service';
import { InventoryStorageLocationService } from './inventory-storage-location.service';
import { PurchaseInboundConfirmationService } from './purchase-inbound-confirmation.service';
import { PurchaseWorkflowService } from '../purchase-inventory/purchase-workflow.service';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';

export const INVENTORY_INBOUND_TASK_SERVICE_OPTIONS =
  'INVENTORY_INBOUND_TASK_SERVICE_OPTIONS';

export interface InventoryInboundTaskServiceOptions {
  retryDelayMs?: number;
  recoveryScanDelayMs?: number;
  now?: () => Date;
}

const DEFAULT_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RECOVERY_SCAN_DELAY_MS = 15_000;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{8,180}$/u;

@Injectable()
export class InventoryInboundTaskService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryInboundTaskService.name);
  private readonly scheduledTaskIds = new Set<string>();
  private readonly pendingImmediates = new Map<
    string,
    ReturnType<typeof setImmediate>
  >();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly inFlightTasks = new Map<string, Promise<void>>();
  private readonly heartbeatTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly retryDelayMs: number;
  private readonly recoveryScanDelayMs: number;
  private readonly now: () => Date;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly taskLedger: InventoryInboundTaskLedgerStore,
    private readonly movementCommandService: InventoryMovementCommandService,
    private readonly purchaseInboundService: PurchaseInboundConfirmationService,
    private readonly purchaseWorkflowService: PurchaseWorkflowService,
    private readonly storageLocationService: InventoryStorageLocationService,
    @Optional()
    @Inject(INVENTORY_INBOUND_TASK_SERVICE_OPTIONS)
    options: InventoryInboundTaskServiceOptions = {},
    @Optional() private readonly accessConfiguration?: AccessConfigurationService,
  ) {
    this.retryDelayMs = positive(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    this.recoveryScanDelayMs = positive(
      options.recoveryScanDelayMs,
      DEFAULT_RECOVERY_SCAN_DELAY_MS,
    );
    this.now = options.now || (() => new Date());
  }

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.stopped = false;
      await this.scanRecoverableTasks();
      this.scheduleRecoveryScan();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    for (const immediate of this.pendingImmediates.values()) {
      clearImmediate(immediate);
    }
    this.pendingImmediates.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.heartbeatTimers.clear();
    this.scheduledTaskIds.clear();
    await Promise.allSettled([...this.inFlightTasks.values()]);
  }

  async acceptManual(
    requestValue: ManualInventoryInboundTaskRequest,
    principal: AccessPrincipal,
    principalFingerprint: string,
  ): Promise<InventoryInboundAcceptedResponse> {
    await this.movementCommandService.assertProfessionalRequest(principal, requestValue);
    const request = normalizeManualRequest(
      assertInventoryMovementScope(principal, requestValue),
    );
    return this.accept('manual', request, principal, principalFingerprint);
  }

  acceptPurchase(
    requestValue: PurchaseInboundConfirmRequest,
    principal: AccessPrincipal,
    principalFingerprint: string,
  ): Promise<InventoryInboundAcceptedResponse> {
    const request = normalizePurchaseRequest(
      assertPurchaseInboundScope(principal, requestValue, []),
    );
    return this.accept('purchase', request, principal, principalFingerprint);
  }

  async getTaskStatus(
    taskIdValue: string,
    principal: AccessPrincipal,
  ): Promise<InventoryInboundTaskStatusResponse> {
    const taskId = clean(taskIdValue);
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new ForbiddenException('入库后台任务不存在或无权访问');
    }
    const entry = await this.taskLedger.findInboundByTaskId(taskId);
    if (!entry) {
      throw new ForbiddenException('入库后台任务不存在或无权访问');
    }
    assertInventoryMovementDeletionRole(principal);
    // The accepted request already binds the exact operation and record scope. Querying
    // its result must keep that owner/version/policy, without requiring list-read grants.
    if ((principal.accountId || entry.principal.accountId || isProfessionalBusinessPrincipal(principal) || isProfessionalBusinessPrincipal(entry.principal)) &&
      businessAuthorizationIdentityKey(principal) !== businessAuthorizationIdentityKey(entry.principal)) throw new ForbiddenException('无权查看该入库任务');
    if (entry.kind === 'purchase') {
      assertPurchaseInboundScope(
        principal,
        entry.request as PurchaseInboundConfirmRequest,
        [],
      );
    } else {
      assertInventoryMovementScope(
        principal,
        entry.request as ManualInventoryInboundTaskRequest,
      );
    }
    if (entry.task.status === 'pending') this.scheduleTask(taskId);
    if (entry.task.status === 'completed') {
      this.scheduleCompletionNotificationRepair(entry, entry.task.result);
    }
    return { success: true, task: toPublicInventoryInboundTask(entry.task) };
  }

  private async accept(
    kind: 'manual' | 'purchase',
    request: InventoryInboundTaskRequest,
    principal: AccessPrincipal,
    principalFingerprintValue: string,
  ): Promise<InventoryInboundAcceptedResponse> {
    const principalFingerprint = clean(principalFingerprintValue);
    if (!principalFingerprint) throw new ForbiddenException('登录身份不可用');
    const timestamp = this.now().toISOString();
    const entry: InventoryInboundTaskLedgerEntry = {
      kind,
      principal: JSON.parse(JSON.stringify(principal)) as AccessPrincipal,
      principalFingerprint,
      requestFingerprint: buildInventoryInboundTaskRequestFingerprint(
        kind,
        request,
      ),
      request: JSON.parse(
        JSON.stringify(request),
      ) as InventoryInboundTaskRequest,
      attemptCount: 0,
      task: {
        id: `inventory-inbound-${kind}-${randomUUID()}`,
        kind,
        status: 'pending',
        message: '入库申请已受理，正在后台同步多维表',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
    const reservation = this.accessConfiguration ? await this.taskLedger.reserveInbound(entry, () => this.accessConfiguration!.validateSession(
      entry.principal.accountId, entry.principal.authorizationVersion, entry.principal.role, entry.principal.purchaseBuilding,
      entry.principal.specialties, entry.principal.buildings,
    )) : await this.taskLedger.reserveInbound(entry);
    if (reservation.entry.task.status === 'pending') {
      this.scheduleTask(reservation.entry.task.id);
    }
    if (reservation.entry.task.status === 'completed') {
      this.scheduleCompletionNotificationRepair(
        reservation.entry,
        reservation.entry.task.result,
      );
    }
    return acceptedTask(reservation.entry.task);
  }

  private scheduleCompletionNotificationRepair(
    entry: InventoryInboundTaskLedgerEntry,
    result: InventoryMovementCreateResponse | PurchaseInboundConfirmResponse,
  ): void {
    const repair =
      entry.kind === 'purchase'
        ? this.purchaseInboundService.ensureCompletionNotificationOutbox(
            (entry.request as PurchaseInboundConfirmRequest).executionRecordId,
            (result as PurchaseInboundConfirmResponse).movement,
          )
        : this.purchaseWorkflowService.ensureManualInboundCompletionNotification(
            result as InventoryMovementCreateResponse,
          );
    void repair.catch((error) =>
      this.logger.warn(
        `入库已完成，成功通知转后台补偿：task=${entry.task.id}, message=${errorMessage(error)}`,
      ),
    );
  }

  private async scanRecoverableTasks(): Promise<void> {
    try {
      const entries = await this.taskLedger.listRecoverableInbounds();
      entries.forEach((entry) => this.scheduleTask(entry.task.id));
    } catch (error) {
      this.logger.error(`入库任务恢复扫描失败：${errorMessage(error)}`);
    }
  }

  private scheduleRecoveryScan(): void {
    if (this.stopped || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.stopped) return;
      void this.scanRecoverableTasks().finally(() =>
        this.scheduleRecoveryScan(),
      );
    }, this.recoveryScanDelayMs);
    this.recoveryTimer.unref?.();
  }

  private scheduleTask(taskId: string): void {
    if (
      this.stopped ||
      this.scheduledTaskIds.has(taskId) ||
      this.retryTimers.has(taskId)
    ) {
      return;
    }
    this.scheduledTaskIds.add(taskId);
    const immediate = setImmediate(() => {
      this.pendingImmediates.delete(taskId);
      if (this.stopped) {
        this.scheduledTaskIds.delete(taskId);
        return;
      }
      const execution = this.executeTask(taskId)
        .then((retryAttempt) => {
          if (retryAttempt !== null) {
            this.scheduleRetry(taskId, retryAttempt);
          }
        })
        .catch((error) => {
          if (isRetryableTaskExecutionError(error)) {
            this.scheduleRetry(taskId, 1);
          }
          this.logger.error(
            `入库后台任务执行失败：task=${taskId}, message=${errorMessage(error)}`,
          );
        })
        .finally(() => {
          this.inFlightTasks.delete(taskId);
          this.scheduledTaskIds.delete(taskId);
        });
      this.inFlightTasks.set(taskId, execution);
    });
    this.pendingImmediates.set(taskId, immediate);
  }

  private scheduleRetry(taskId: string, attemptCount: number): void {
    if (this.stopped || this.retryTimers.has(taskId)) return;
    const delayMs = calculateInventoryInboundRetryDelay(
      this.retryDelayMs,
      attemptCount,
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      this.scheduleTask(taskId);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }

  private async executeTask(taskId: string): Promise<number | null> {
    const claim = await this.taskLedger.claimPendingInbound(taskId);
    if (!claim.claimed) return null;
    const ownerToken = clean(claim.entry.owner?.token);
    if (!ownerToken) {
      throw new ServiceUnavailableException('入库任务租约已丢失');
    }
    const heartbeat = setInterval(
      () =>
        void this.taskLedger
          .renewClaim(taskId, ownerToken)
          .catch((error) =>
            this.logger.warn(
              `入库任务续租失败：task=${taskId}, message=${errorMessage(error)}`,
            ),
          ),
      this.taskLedger.getLeaseHeartbeatIntervalMs(),
    );
    heartbeat.unref?.();
    this.heartbeatTimers.set(taskId, heartbeat);
    const assertOwnership = () =>
      this.taskLedger.renewClaim(taskId, ownerToken);
    let manualBusinessResult =
      claim.entry.kind === 'manual'
        ? claim.entry.task.businessResult
        : undefined;
    try {
      let result:
        | InventoryMovementCreateResponse
        | PurchaseInboundConfirmResponse;
      if (claim.entry.kind === 'manual') {
        if (!manualBusinessResult) {
          manualBusinessResult = (await this.executeInbound(
            claim.entry,
            assertOwnership,
          )) as InventoryMovementCreateResponse;
          await this.taskLedger.updateInboundTask(
            taskId,
            {
              ...claim.entry.task,
              status: 'running',
              businessResult: manualBusinessResult,
            },
            ownerToken,
          );
        }
        await this.purchaseWorkflowService.ensureManualInboundCompletionNotification(
          manualBusinessResult,
        );
        result = manualBusinessResult;
      } else {
        result = await this.executeInbound(claim.entry, assertOwnership);
      }
      const completedAt = this.now().toISOString();
      const { businessResult: _checkpoint, ...taskWithoutCheckpoint } =
        claim.entry.task;
      await this.taskLedger.updateInboundTask(
        taskId,
        {
          ...taskWithoutCheckpoint,
          status: 'completed',
          message: '入库已完成',
          updatedAt: completedAt,
          completedAt,
          result,
        },
        ownerToken,
      );
      return null;
    } catch (error) {
      const attemptCount = Math.max(1, Number(claim.entry.attemptCount) || 1);
      const failureDetail = errorMessage(error);
      if (isDefinitelyInvalid(error) && !manualBusinessResult) {
        const completedAt = this.now().toISOString();
        this.logger.warn(
          `入库后台任务已确认失败：task=${taskId}, attempt=${attemptCount}, message=${failureDetail}`,
        );
        await this.taskLedger.updateInboundTask(
          taskId,
          {
            ...claim.entry.task,
            status: 'failed',
            message: errorMessage(error),
            updatedAt: completedAt,
            completedAt,
            definitelyNotWritten: true,
          },
          ownerToken,
        );
        return null;
      }
      this.logger.warn(
        `入库后台任务暂未完成：task=${taskId}, attempt=${attemptCount}, message=${failureDetail}`,
      );
      await this.taskLedger.updateInboundTask(
        taskId,
        {
          ...claim.entry.task,
          ...(manualBusinessResult
            ? { businessResult: manualBusinessResult }
            : {}),
          status: 'pending',
          message: `第 ${attemptCount} 次后台同步暂未完成：${failureDetail}；系统将使用原编号继续核对`,
          updatedAt: this.now().toISOString(),
        },
        ownerToken,
      );
      return attemptCount;
    } finally {
      clearInterval(heartbeat);
      this.heartbeatTimers.delete(taskId);
    }
  }

  private async executeInbound(
    entry: InventoryInboundTaskLedgerEntry,
    assertOwnership: () => Promise<void>,
  ): Promise<InventoryMovementCreateResponse | PurchaseInboundConfirmResponse> {
    if (entry.kind === 'purchase') {
      return this.purchaseInboundService.confirm(
        entry.request as PurchaseInboundConfirmRequest,
        entry.principal,
        assertOwnership,
      );
    }
    let request = entry.request as ManualInventoryInboundTaskRequest;
    if (request.mode === 'new') {
      const newRequest = request as InventoryNewInboundMovementCreateRequest;
      const location =
        await this.storageLocationService.resolveSelectedLocation(
          newRequest.building,
          newRequest.newItem.locationRecordId,
          newRequest.newItem.location,
        );
      request = {
        ...newRequest,
        newItem: {
          ...newRequest.newItem,
          location: location.name,
          locationRecordId: location.recordId,
        },
      };
    }
    return this.movementCommandService.createMovement(
      request,
      entry.principal,
      assertOwnership,
    );
  }
}

function normalizeManualRequest(
  requestValue: unknown,
): ManualInventoryInboundTaskRequest {
  if (!isRecord(requestValue) || requestValue.type !== 'inbound') {
    throw new BadRequestException('入库请求格式无效');
  }
  if (requestValue.mode !== 'new' && requestValue.mode !== 'existing') {
    throw new BadRequestException('请选择有效入库物品模式');
  }
  assertCommonRequest(requestValue);
  if (requestValue.mode === 'new' && !isRecord(requestValue.newItem)) {
    throw new BadRequestException('新增物品信息无效');
  }
  if (
    requestValue.mode === 'existing' &&
    (!clean(requestValue.catalogRecordId) || !clean(requestValue.sku))
  ) {
    throw new BadRequestException('已有物品信息无效');
  }
  return JSON.parse(
    JSON.stringify(requestValue),
  ) as ManualInventoryInboundTaskRequest;
}

function normalizePurchaseRequest(
  requestValue: PurchaseInboundConfirmRequest,
): PurchaseInboundConfirmRequest {
  if (!isRecord(requestValue) || !clean(requestValue.executionRecordId)) {
    throw new BadRequestException('采购执行记录标识无效');
  }
  if (requestValue.mode !== 'new' && requestValue.mode !== 'existing') {
    throw new BadRequestException('请选择有效采购入库模式');
  }
  assertCommonRequest(requestValue);
  return JSON.parse(
    JSON.stringify(requestValue),
  ) as PurchaseInboundConfirmRequest;
}

function assertCommonRequest(request: Record<string, unknown>): void {
  if (request.responsibilityGeneration !== undefined && (!Number.isSafeInteger(request.responsibilityGeneration) || Number(request.responsibilityGeneration) < 1)) {
    throw new BadRequestException('入库责任版本无效，请刷新待入库清单');
  }
  if (!MUTATION_ID_PATTERN.test(clean(request.clientMutationId))) {
    throw new BadRequestException('请求标识无效');
  }
  if (!WAREHOUSE_BUILDINGS.includes(request.building as never)) {
    throw new BadRequestException('入库楼栋无效');
  }
  if (!Number.isInteger(request.quantity) || Number(request.quantity) <= 0) {
    throw new BadRequestException('入库数量无效');
  }
  if (!Number.isFinite(Date.parse(clean(request.occurredAt)))) {
    throw new BadRequestException('入库时间无效');
  }
}

function acceptedTask(
  task: InventoryInboundTaskLedgerTask,
): InventoryInboundAcceptedResponse {
  const publicTask = toPublicInventoryInboundTask(task);
  return {
    accepted: true,
    taskId: publicTask.id,
    kind: publicTask.kind,
    status: publicTask.status,
    message: publicTask.message,
    ...(publicTask.status === 'completed' ? { result: publicTask.result } : {}),
    ...(publicTask.status === 'failed'
      ? { definitelyNotWritten: publicTask.definitelyNotWritten }
      : {}),
  };
}

function toPublicInventoryInboundTask(
  task: InventoryInboundTaskLedgerTask,
): InventoryInboundTask {
  const base = {
    id: task.id,
    kind: task.kind,
    message: task.message,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  if (task.status === 'completed') {
    return {
      ...base,
      status: 'completed',
      completedAt: task.completedAt,
      result: task.result,
    };
  }
  if (task.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      completedAt: task.completedAt,
      definitelyNotWritten: task.definitelyNotWritten,
    };
  }
  return { ...base, status: task.status };
}

function isDefinitelyInvalid(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const status = error.getStatus();
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isRetryableTaskExecutionError(error: unknown): boolean {
  if (error instanceof ServiceUnavailableException) return true;
  return ['EBUSY', 'EACCES', 'EPERM'].includes(
    String((error as { code?: unknown } | null)?.code || ''),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

export function calculateInventoryInboundRetryDelay(
  baseDelayMs: number,
  attemptCount: number,
): number {
  const base = positive(baseDelayMs, DEFAULT_RETRY_DELAY_MS);
  const attempt = Math.max(1, Math.floor(Number(attemptCount) || 1));
  const exponent = Math.min(6, attempt - 1);
  return Math.min(MAX_RETRY_DELAY_MS, base * 2 ** exponent);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const stage = clean(
      (current as { inventoryStage?: unknown } | null)?.inventoryStage,
    );
    if (stage && !messages.includes(stage)) messages.push(stage);
    const message =
      current instanceof Error
        ? clean(current.message)
        : clean(String(current));
    if (message && !messages.includes(message)) messages.push(message);
    const response = (
      current as {
        response?: {
          status?: unknown;
          data?: { code?: unknown; msg?: unknown };
        };
      } | null
    )?.response;
    const responseDetail = [
      Number.isFinite(Number(response?.status))
        ? `HTTP ${String(response?.status)}`
        : '',
      Number.isFinite(Number(response?.data?.code))
        ? `飞书码 ${String(response?.data?.code)}`
        : '',
      clean(response?.data?.msg),
    ]
      .filter(Boolean)
      .join(' ');
    if (responseDetail && !messages.includes(responseDetail)) {
      messages.push(responseDetail);
    }
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return (messages.join('：') || '未知同步错误').slice(0, 300);
}
