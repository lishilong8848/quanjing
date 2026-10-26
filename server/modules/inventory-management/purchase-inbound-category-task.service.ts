import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
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
  PurchaseInboundCategoryAcceptedResponse,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundCategoryTask,
  PurchaseInboundCategoryTaskStatusResponse,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  assertInventoryMovementDeletionRole,
  assertPurchaseInboundScope,
} from './inventory-access-policy';
import {
  buildPurchaseInboundCategoryRequestFingerprint,
  PurchaseInboundCategoryTaskLedgerStore,
  type PurchaseInboundCategoryTaskLedgerEntry,
} from './purchase-inbound-category-task-ledger.store';
import { PurchaseInboundConfirmationService } from './purchase-inbound-confirmation.service';

export const PURCHASE_INBOUND_CATEGORY_TASK_SERVICE_OPTIONS =
  'PURCHASE_INBOUND_CATEGORY_TASK_SERVICE_OPTIONS';

export interface PurchaseInboundCategoryTaskServiceOptions {
  retryDelayMs?: number;
  recoveryScanDelayMs?: number;
  now?: () => Date;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_RECOVERY_SCAN_DELAY_MS = 15_000;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{8,180}$/u;

@Injectable()
export class PurchaseInboundCategoryTaskService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PurchaseInboundCategoryTaskService.name);
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
    private readonly taskLedger: PurchaseInboundCategoryTaskLedgerStore,
    private readonly preparationService: PurchaseInboundConfirmationService,
    @Optional()
    @Inject(PURCHASE_INBOUND_CATEGORY_TASK_SERVICE_OPTIONS)
    options: PurchaseInboundCategoryTaskServiceOptions = {},
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

  async accept(
    requestValue: PurchaseInboundCategoryPrepareRequest,
    principal: AccessPrincipal,
    principalFingerprintValue: string,
  ): Promise<PurchaseInboundCategoryAcceptedResponse> {
    assertInventoryMovementDeletionRole(principal);
    const request = normalizeRequest(requestValue);
    assertPurchaseInboundScope(principal, request, []);
    const principalFingerprint = clean(principalFingerprintValue);
    if (!principalFingerprint) throw new ForbiddenException('登录身份不可用');
    const timestamp = this.now().toISOString();
    const reservation = await this.taskLedger.reserve({
      principal: JSON.parse(JSON.stringify(principal)) as AccessPrincipal,
      principalFingerprint,
      requestFingerprint:
        buildPurchaseInboundCategoryRequestFingerprint(request),
      request,
      attemptCount: 0,
      task: {
        id: `purchase-inbound-category-${randomUUID()}`,
        status: 'pending',
        message: '物品类别号生成已受理，正在后台同步多维表',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    if (reservation.entry.task.status === 'pending') {
      this.scheduleTask(reservation.entry.task.id);
    }
    return acceptedTask(reservation.entry.task);
  }

  async getTaskStatus(
    taskIdValue: string,
    principal: AccessPrincipal,
  ): Promise<PurchaseInboundCategoryTaskStatusResponse> {
    const taskId = clean(taskIdValue);
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new ForbiddenException('物品类别号后台任务不存在或无权访问');
    }
    const entry = await this.taskLedger.findByTaskId(taskId);
    if (!entry) {
      throw new ForbiddenException('物品类别号后台任务不存在或无权访问');
    }
    assertInventoryMovementDeletionRole(principal);
    assertPurchaseInboundScope(principal, entry.request, []);
    if (entry.task.status === 'pending') this.scheduleTask(taskId);
    return { success: true, task: entry.task };
  }

  private async scanRecoverableTasks(): Promise<void> {
    try {
      const entries = await this.taskLedger.listRecoverable();
      entries.forEach((entry) => this.scheduleTask(entry.task.id));
    } catch (error) {
      this.logger.error(`物品类别号任务恢复扫描失败：${errorMessage(error)}`);
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
    if (this.stopped || this.scheduledTaskIds.has(taskId)) return;
    this.scheduledTaskIds.add(taskId);
    const immediate = setImmediate(() => {
      this.pendingImmediates.delete(taskId);
      if (this.stopped) {
        this.scheduledTaskIds.delete(taskId);
        return;
      }
      const execution = this.executeTask(taskId)
        .then((retry) => {
          if (retry) this.scheduleRetry(taskId);
        })
        .catch((error) => {
          if (isRetryableTaskExecutionError(error)) {
            this.scheduleRetry(taskId);
          }
          this.logger.error(
            `物品类别号后台任务执行失败：task=${taskId}, message=${errorMessage(error)}`,
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

  private scheduleRetry(taskId: string): void {
    if (this.stopped || this.retryTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      this.scheduleTask(taskId);
    }, this.retryDelayMs);
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }

  private async executeTask(taskId: string): Promise<boolean> {
    const claim = await this.taskLedger.claimPending(taskId);
    if (!claim.claimed) return false;
    const ownerToken = clean(claim.entry.owner?.token);
    if (!ownerToken) {
      throw new ServiceUnavailableException('物品类别号任务租约已丢失');
    }
    const heartbeat = setInterval(
      () =>
        void this.taskLedger
          .renewClaim(taskId, ownerToken)
          .catch((error) =>
            this.logger.warn(
              `物品类别号任务续租失败：task=${taskId}, message=${errorMessage(error)}`,
            ),
          ),
      this.taskLedger.getLeaseHeartbeatIntervalMs(),
    );
    heartbeat.unref?.();
    this.heartbeatTimers.set(taskId, heartbeat);
    try {
      const result = await this.preparationService.prepareCategory(
        claim.entry.request,
        claim.entry.principal,
        () => this.taskLedger.renewClaim(taskId, ownerToken),
      );
      const completedAt = this.now().toISOString();
      await this.taskLedger.updateTask(
        taskId,
        {
          ...claim.entry.task,
          status: 'completed',
          message: result.alreadyPrepared
            ? '已使用原变更号恢复物品类别号'
            : '物品类别号已生成',
          updatedAt: completedAt,
          completedAt,
          result,
        },
        ownerToken,
      );
      return false;
    } catch (error) {
      if (isDefinitelyInvalid(error)) {
        const completedAt = this.now().toISOString();
        await this.taskLedger.updateTask(
          taskId,
          {
            ...claim.entry.task,
            status: 'failed',
            message: errorMessage(error),
            updatedAt: completedAt,
            completedAt,
            definitelyNotPrepared: true,
          },
          ownerToken,
        );
        return false;
      }
      await this.taskLedger.updateTask(
        taskId,
        {
          ...claim.entry.task,
          status: 'pending',
          message: '服务器响应较慢，正在使用原变更号后台核对',
          updatedAt: this.now().toISOString(),
        },
        ownerToken,
      );
      return true;
    } finally {
      clearInterval(heartbeat);
      this.heartbeatTimers.delete(taskId);
    }
  }
}

function normalizeRequest(
  request: PurchaseInboundCategoryPrepareRequest,
): PurchaseInboundCategoryPrepareRequest {
  const executionRecordId = clean(request?.executionRecordId);
  const clientMutationId = clean(request?.clientMutationId);
  if (!RECORD_ID_PATTERN.test(executionRecordId)) {
    throw new BadRequestException('采购执行记录标识无效');
  }
  if (!MUTATION_ID_PATTERN.test(clientMutationId)) {
    throw new BadRequestException('请求标识无效');
  }
  if (!WAREHOUSE_BUILDINGS.includes(request?.building)) {
    throw new BadRequestException('入库楼栋无效');
  }
  if (!Number.isInteger(request?.quantity) || request.quantity <= 0) {
    throw new BadRequestException('入库数量无效');
  }
  if (!Number.isFinite(Date.parse(request?.occurredAt || ''))) {
    throw new BadRequestException('入库时间无效');
  }
  if (!request?.newItem || typeof request.newItem !== 'object') {
    throw new BadRequestException('新增物品信息无效');
  }
  return JSON.parse(
    JSON.stringify({ ...request, executionRecordId, clientMutationId }),
  ) as PurchaseInboundCategoryPrepareRequest;
}

function acceptedTask(
  task: PurchaseInboundCategoryTask,
): PurchaseInboundCategoryAcceptedResponse {
  return {
    accepted: true,
    taskId: task.id,
    status: task.status,
    message: task.message,
    ...(task.status === 'completed' ? { result: task.result } : {}),
    ...(task.status === 'failed'
      ? { definitelyNotPrepared: task.definitelyNotPrepared }
      : {}),
  };
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

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
