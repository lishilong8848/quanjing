import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  CreateInventoryMovementDeletionRequest,
  InventoryMovementDeletionAcceptedResponse,
  InventoryMovementDeletionResult,
  InventoryMovementDeletionTask,
  InventoryMovementDeletionTaskStatusResponse,
  InventoryMovementDeletionType,
} from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  extractDisplayText,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { PurchaseInventoryService } from '../purchase-inventory/purchase-inventory.service';
import {
  assertInventoryMovementDeletionRole,
  assertInventoryMovementDeletionScope,
} from './inventory-access-policy';
import { InventoryManagementService } from './inventory-management.service';
import {
  buildInventoryMovementDeletionRequestFingerprint,
  InventoryMovementDeletionTaskLedgerStore,
  type InventoryMovementDeletionRecoveryState,
  type InventoryMovementDeletionTaskLedgerEntry,
} from './inventory-movement-deletion-task-ledger.store';
import { InventoryMovementOperationCoordinator } from './inventory-movement-operation-coordinator';
import { buildPendingPurchaseInbounds } from './purchase-inbound-confirmation.rules';
import {
  InventoryWorkflowGateway,
  InventoryWorkflowRecordDefinitelyNotDeletedError,
  InventoryWorkflowRecordDeleteUncertainError,
  type InventoryWorkflowFieldSchema,
} from './inventory-workflow.gateway';

const TABLES = {
  inbound: { name: '入库填写', env: 'FEISHU_WAREHOUSE_INBOUND_TABLE_ID' },
  outbound: { name: '出库填写', env: 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID' },
} as const;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{8,180}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const DEFINITE_PREFLIGHT_HTTP_STATUSES = new Set([
  400, 401, 403, 404, 409, 422,
]);
const TRANSIENT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
]);
const DEFAULT_MAX_PREFLIGHT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_RECOVERY_SCAN_DELAY_MS = 15_000;

export const INVENTORY_MOVEMENT_DELETION_SERVICE_OPTIONS =
  'INVENTORY_MOVEMENT_DELETION_SERVICE_OPTIONS';

export interface InventoryMovementDeletionServiceOptions {
  maxPreflightAttempts?: number;
  retryDelayMs?: number;
  recoveryScanDelayMs?: number;
  now?: () => Date;
}

interface WarehouseDeletionConfig {
  appToken: string;
  inboundTableId: string;
  outboundTableId: string;
}

interface PurchaseRollbackConfig {
  appToken: string;
  executionTableId: string;
}

interface PurchaseRollbackPlan {
  config: PurchaseRollbackConfig;
  executionRecordId: string;
  building: string;
  requestCode: string;
  sku: string;
  quantity: number;
  originalFields: Record<string, unknown>;
  rollbackFields: Record<string, unknown>;
}

@Injectable()
export class InventoryMovementDeletionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryMovementDeletionService.name);
  private readonly scheduledTaskIds = new Set<string>();
  private readonly pendingTaskImmediates = new Map<
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
  private readonly maxPreflightAttempts: number;
  private readonly retryDelayMs: number;
  private readonly recoveryScanDelayMs: number;
  private readonly now: () => Date;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly httpService: HttpService,
    private readonly gateway: InventoryWorkflowGateway,
    private readonly managementService: InventoryManagementService,
    private readonly taskLedger: InventoryMovementDeletionTaskLedgerStore,
    private readonly operationCoordinator: InventoryMovementOperationCoordinator,
    @Optional()
    @Inject(INVENTORY_MOVEMENT_DELETION_SERVICE_OPTIONS)
    options: InventoryMovementDeletionServiceOptions = {},
    @Optional()
    private readonly purchaseInventoryService?: PurchaseInventoryService,
  ) {
    this.maxPreflightAttempts = positiveInteger(
      options.maxPreflightAttempts,
      DEFAULT_MAX_PREFLIGHT_ATTEMPTS,
    );
    this.retryDelayMs = positiveInteger(
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS,
    );
    this.recoveryScanDelayMs = positiveInteger(
      options.recoveryScanDelayMs,
      DEFAULT_RECOVERY_SCAN_DELAY_MS,
    );
    this.now = options.now || (() => new Date());
  }

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.stopped = false;
      await this.scanPendingTasks();
      this.scheduleRecoveryScan();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    for (const immediate of this.pendingTaskImmediates.values()) {
      clearImmediate(immediate);
    }
    this.pendingTaskImmediates.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.heartbeatTimers.clear();
    this.scheduledTaskIds.clear();
    await Promise.allSettled([...this.inFlightTasks.values()]);
  }

  async accept(
    requestValue: CreateInventoryMovementDeletionRequest,
    principal: AccessPrincipal,
    principalFingerprintValue: string,
  ): Promise<InventoryMovementDeletionAcceptedResponse> {
    assertInventoryMovementDeletionRole(principal);
    const request = normalizeDeletionRequest(requestValue);
    const principalFingerprint = normalizePrincipalFingerprint(
      principalFingerprintValue,
    );
    const now = this.now().toISOString();
    const reservation = await this.taskLedger.reserve({
      principal: normalizePrincipal(principal),
      principalFingerprint,
      requestFingerprint:
        buildInventoryMovementDeletionRequestFingerprint(request),
      request,
      attemptCount: 0,
      task: {
        id: `inventory-movement-deletion-${randomUUID()}`,
        status: 'pending',
        message: '删除申请已受理，正在后台同步飞书多维表',
        createdAt: now,
        updatedAt: now,
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
    principalFingerprintValue: string,
  ): Promise<InventoryMovementDeletionTaskStatusResponse> {
    assertInventoryMovementDeletionRole(principal);
    const taskId = clean(taskIdValue);
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new ForbiddenException('删除后台任务不存在或无权访问');
    }
    const principalFingerprint = normalizePrincipalFingerprint(
      principalFingerprintValue,
    );
    const entry = await this.taskLedger.findByTaskId(taskId);
    if (!entry || entry.principalFingerprint !== principalFingerprint) {
      throw new ForbiddenException('删除后台任务不存在或无权访问');
    }
    if (entry.task.status === 'pending') this.scheduleTask(taskId);
    return { success: true, task: entry.task };
  }

  private async scanPendingTasks(): Promise<void> {
    try {
      const pending = await this.taskLedger.listPending();
      pending.forEach((entry) => this.scheduleTask(entry.task.id));
    } catch (error) {
      this.logger.error(`库存删除任务恢复扫描失败：${errorMessage(error)}`);
    }
  }

  private scheduleRecoveryScan(): void {
    if (this.stopped || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.stopped) return;
      void this.scanPendingTasks().finally(() => this.scheduleRecoveryScan());
    }, this.recoveryScanDelayMs);
    this.recoveryTimer.unref?.();
  }

  private scheduleTask(taskId: string): void {
    if (this.stopped || this.scheduledTaskIds.has(taskId)) return;
    this.scheduledTaskIds.add(taskId);
    const immediate = setImmediate(() => {
      this.pendingTaskImmediates.delete(taskId);
      if (this.stopped) {
        this.scheduledTaskIds.delete(taskId);
        return;
      }
      const execution = this.executeTask(taskId)
        .catch((error) => {
          this.logger.error(
            `库存删除后台任务执行失败：task=${taskId}, message=${errorMessage(error)}`,
          );
        })
        .finally(() => {
          this.inFlightTasks.delete(taskId);
          this.scheduledTaskIds.delete(taskId);
        });
      this.inFlightTasks.set(taskId, execution);
    });
    this.pendingTaskImmediates.set(taskId, immediate);
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

  private async executeTask(taskId: string): Promise<void> {
    const claim = await this.taskLedger.claimPending(taskId);
    if (!claim.claimed) return;
    if (this.stopped) {
      await this.taskLedger.abandonPendingClaim(taskId);
      return;
    }

    let leaseFailure: unknown;
    let renewal: Promise<void> | null = null;
    const renew = () => {
      if (renewal) return;
      renewal = this.taskLedger
        .renewClaim(taskId)
        .then(() => {
          leaseFailure = undefined;
        })
        .catch((error) => {
          leaseFailure = error;
        })
        .finally(() => {
          renewal = null;
        });
    };
    const heartbeat = setInterval(
      renew,
      this.taskLedger.getLeaseHeartbeatIntervalMs(),
    );
    heartbeat.unref?.();
    this.heartbeatTimers.set(taskId, heartbeat);
    try {
      await this.executeClaimedTask(claim.entry, async () => {
        if (renewal) await renewal;
        return leaseFailure;
      });
    } finally {
      clearInterval(heartbeat);
      this.heartbeatTimers.delete(taskId);
      if (renewal) await renewal;
    }
  }

  private async executeClaimedTask(
    entry: InventoryMovementDeletionTaskLedgerEntry,
    getLeaseFailure: () => Promise<unknown>,
  ): Promise<void> {
    const movementKey = `movement:${entry.request.movementType}:${entry.request.recordId}`;
    let externalMutationStarted = false;
    let definiteFailureMessage = '';
    let cacheTarget: { appToken: string; tableId: string } | undefined;
    try {
      const config = await this.resolveWarehouseConfig();
      await this.operationCoordinator.run([movementKey], async () => {
        const table = TABLES[entry.request.movementType];
        const tableId = movementTableId(config, entry.request.movementType);
        cacheTarget = { appToken: config.appToken, tableId };
        const movement = await this.gateway.tryGetRecord(
          config.appToken,
          tableId,
          entry.request.recordId,
          table.name,
        );
        const recovery =
          entry.task.status === 'running' ? entry.recovery : undefined;
        const purchaseExecutionRecordId =
          recovery?.movement.purchaseExecutionRecordId ||
          (movement && entry.request.movementType === 'inbound'
            ? purchaseExecutionId(movement)
            : '');
        const runDeletion = async () => {
          if (recovery) {
            externalMutationStarted = true;
            await this.reconcileRunningTask({
              entry,
              recovery,
              config,
              tableId,
              tableName: table.name,
              movement,
            });
            return;
          }
          if (!movement) {
            this.invalidateRelatedCaches(config.appToken, tableId);
            await this.persistCompleted(entry, {
              recordId: entry.request.recordId,
              type: entry.request.movementType,
              purchaseRolledBack: false,
              message: `${table.name}记录已不存在，无需重复删除`,
            });
            return;
          }
          await this.authorizeProfessionalMovement(entry.principal, config.appToken, normalizeSku(fieldText(movement, ['物品类别号'])), extractMovementBuilding(movement));
          const building = assertInventoryMovementDeletionScope(
            entry.principal,
            extractMovementBuilding(movement),
          );
          let rollbackPlan: PurchaseRollbackPlan | undefined;
          if (purchaseExecutionRecordId) {
            rollbackPlan = await this.preparePurchaseRollback(
              purchaseExecutionRecordId,
              movement,
              building,
              entry.principal,
            );
          }
          const leaseFailure = await getLeaseFailure();
          if (leaseFailure !== undefined) throw leaseFailure;
          entry = await this.taskLedger.updateRecoveryState(
            entry.task.id,
            buildRecoveryState(
              entry.request.movementType,
              movement,
              building,
              purchaseExecutionRecordId,
              rollbackPlan,
            ),
          );
          entry = await this.persistRunning(entry);
          externalMutationStarted = true;

          if (rollbackPlan) {
            try {
              await this.applyPurchaseRollback(rollbackPlan);
            } catch (error) {
              const compensationWarning =
                await this.compensatePurchaseRollback(rollbackPlan);
              definiteFailureMessage = [
                errorMessage(error),
                compensationWarning,
              ]
                .filter(Boolean)
                .join('；');
              throw new InventoryWorkflowRecordDefinitelyNotDeletedError(
                table.name,
                error,
              );
            }
            entry = await this.taskLedger.updateRecoveryState(entry.task.id, {
              ...entry.recovery!,
              phase: 'purchase_rolled_back',
            });
          }
          entry = await this.taskLedger.updateRecoveryState(entry.task.id, {
            ...entry.recovery!,
            phase: 'delete_started',
          });
          try {
            await this.gateway.deleteRecordAndConfirmAbsent(
              config.appToken,
              tableId,
              entry.request.recordId,
              table.name,
            );
          } catch (error) {
            if (
              rollbackPlan &&
              error instanceof InventoryWorkflowRecordDefinitelyNotDeletedError
            ) {
              const compensationWarning =
                await this.compensatePurchaseRollback(rollbackPlan);
              if (compensationWarning) {
                definiteFailureMessage = `${error.message}；${compensationWarning}`;
              }
            }
            throw error;
          }
          const result: InventoryMovementDeletionResult = {
            recordId: entry.request.recordId,
            type: entry.request.movementType,
            purchaseRolledBack: Boolean(rollbackPlan),
            message: rollbackPlan
              ? '采购关联入库已删除，采购已回退至待库房入库'
              : `${table.name}记录已删除`,
          };
          this.invalidateRelatedCaches(config.appToken, tableId);
          await this.persistCompleted(entry, result);
        };

        if (purchaseExecutionRecordId) {
          await this.operationCoordinator.run(
            [`purchase:${purchaseExecutionRecordId}`],
            runDeletion,
          );
        } else {
          await runDeletion();
        }
      });
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordDeleteUncertainError) {
        if (cacheTarget && externalMutationStarted) {
          this.invalidateRelatedCaches(
            cacheTarget.appToken,
            cacheTarget.tableId,
          );
        }
        await this.persistUncertain(entry, error.message);
        return;
      }
      if (error instanceof InventoryWorkflowRecordDefinitelyNotDeletedError) {
        if (cacheTarget && externalMutationStarted) {
          this.invalidateRelatedCaches(
            cacheTarget.appToken,
            cacheTarget.tableId,
          );
        }
        await this.persistFailed(
          entry,
          definiteFailureMessage || error.message,
        );
        return;
      }
      if (externalMutationStarted) {
        if (cacheTarget) {
          this.invalidateRelatedCaches(
            cacheTarget.appToken,
            cacheTarget.tableId,
          );
        }
        await this.persistUncertain(entry, errorMessage(error));
        return;
      }
      if (
        isTransientPreflightError(error) &&
        entry.attemptCount < this.maxPreflightAttempts
      ) {
        await this.taskLedger.abandonPendingClaim(entry.task.id);
        this.scheduleRetry(entry.task.id);
        return;
      }
      await this.persistFailed(entry, errorMessage(error));
    }
  }

  private async reconcileRunningTask(options: {
    entry: InventoryMovementDeletionTaskLedgerEntry;
    recovery: InventoryMovementDeletionRecoveryState;
    config: WarehouseDeletionConfig;
    tableId: string;
    tableName: string;
    movement: BitableRecordItem | undefined;
  }): Promise<void> {
    let { entry } = options;
    const { recovery, config, tableId, tableName, movement } = options;
    if (movement) {
      assertRecoveredMovementMatches(entry, recovery, movement);
      assertInventoryMovementDeletionScope(
        entry.principal,
        extractMovementBuilding(movement),
      );
    }

    await this.authorizeProfessionalMovement(entry.principal, config.appToken, recovery.movement.sku, recovery.movement.building);
    const purchaseState = recovery.purchase;
    let rollbackPlan: PurchaseRollbackPlan | undefined;
    let execution: BitableRecordItem | undefined;
    if (purchaseState) {
      const purchaseConfig = await this.resolvePurchaseConfig();
      execution = await this.gateway.tryGetRecord(
        purchaseConfig.appToken,
        purchaseConfig.executionTableId,
        purchaseState.executionRecordId,
        '采购执行',
      );
      if (!execution) {
        await this.persistUncertain(
          entry,
          '恢复删除时关联采购执行记录不存在，请人工核对',
        );
        return;
      }
      assertProfessionalBitableRecord(entry.principal, execution);
      assertRecoveredPurchaseMatches(
        entry.principal,
        recovery,
        purchaseState,
        execution,
      );
      rollbackPlan = {
        config: purchaseConfig,
        executionRecordId: purchaseState.executionRecordId,
        building: purchaseState.building,
        requestCode: purchaseState.requestCode,
        sku: purchaseState.sku,
        quantity: purchaseState.quantity,
        originalFields: purchaseState.originalFields,
        rollbackFields: purchaseState.rollbackFields,
      };
    }

    if (!movement) {
      if (execution && !isPendingPurchaseExecution(execution)) {
        await this.persistUncertain(
          entry,
          '入库记录已不存在，但采购权威状态不是待入库，请人工核对',
        );
        return;
      }
      this.invalidateRelatedCaches(config.appToken, tableId);
      await this.persistCompleted(entry, {
        recordId: entry.request.recordId,
        type: entry.request.movementType,
        purchaseRolledBack: Boolean(purchaseState),
        message: purchaseState
          ? '已对账确认采购关联入库删除完成，采购处于待入库'
          : `已对账确认${tableName}记录删除完成`,
      });
      return;
    }

    if (!rollbackPlan || !execution) {
      await this.persistFailed(
        entry,
        `${tableName}记录权威回读仍存在，确认未删除`,
      );
      return;
    }
    if (fieldsMatch(execution, rollbackPlan.originalFields)) {
      await this.persistFailed(
        entry,
        '采购回退尚未发生且入库记录仍存在，确认未删除',
      );
      return;
    }
    if (!isPendingPurchaseExecution(execution)) {
      await this.persistUncertain(
        entry,
        '采购回退处于部分写入状态且入库记录仍存在，请人工核对',
      );
      return;
    }

    entry = await this.taskLedger.updateRecoveryState(entry.task.id, {
      ...recovery,
      phase: 'delete_started',
    });
    try {
      await this.gateway.deleteRecordAndConfirmAbsent(
        config.appToken,
        tableId,
        entry.request.recordId,
        tableName,
      );
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordDefinitelyNotDeletedError) {
        const recoveryCompensationWarning =
          await this.compensatePurchaseRollback(rollbackPlan);
        if (recoveryCompensationWarning) {
          error.message = `${error.message}；${recoveryCompensationWarning}`;
        }
      }
      throw error;
    }
    this.invalidateRelatedCaches(config.appToken, tableId);
    await this.persistCompleted(entry, {
      recordId: entry.request.recordId,
      type: entry.request.movementType,
      purchaseRolledBack: true,
      message: '恢复任务已对账并完成采购关联入库删除',
    });
  }

  private async preparePurchaseRollback(
    executionRecordId: string,
    movement: BitableRecordItem,
    movementBuilding: string,
    principal: AccessPrincipal,
  ): Promise<PurchaseRollbackPlan> {
    const config = await this.resolvePurchaseConfig();
    const execution = await this.gateway.tryGetRecord(
      config.appToken,
      config.executionTableId,
      executionRecordId,
      '采购执行',
    );
    if (!execution) throw new BadRequestException('关联采购执行记录不存在');
    const identity = purchaseExecutionIdentity(execution);
    if (identity.building !== movementBuilding) {
      throw new BadRequestException('入库记录楼栋与关联采购执行楼栋不一致');
    }
    assertInventoryMovementDeletionScope(principal, identity.building);
    assertPurchaseMovementLink(movement, identity);
    const schemas = await this.gateway.getFieldSchemas(
      config.appToken,
      config.executionTableId,
      '采购执行',
    );
    const rollbackFields = buildPurchaseRollbackFields(schemas);
    const originalFields = Object.fromEntries(
      Object.keys(rollbackFields).map((fieldName) => [
        fieldName,
        cloneFieldValue(execution.fields?.[fieldName]),
      ]),
    );
    return {
      config,
      executionRecordId,
      ...identity,
      originalFields,
      rollbackFields,
    };
  }

  private async applyPurchaseRollback(
    plan: PurchaseRollbackPlan,
  ): Promise<void> {
    await this.gateway.updateRecord(
      plan.config.appToken,
      plan.config.executionTableId,
      plan.executionRecordId,
      plan.rollbackFields,
      '采购执行',
    );
    const verified = await this.gateway.tryGetRecord(
      plan.config.appToken,
      plan.config.executionTableId,
      plan.executionRecordId,
      '采购执行',
    );
    if (
      !verified ||
      !fieldsMatch(verified, plan.rollbackFields) ||
      !isPendingPurchaseExecution(verified)
    ) {
      throw new Error('采购状态回退后权威派生结果仍不是待入库');
    }
  }

  private async compensatePurchaseRollback(
    plan: PurchaseRollbackPlan,
  ): Promise<string> {
    try {
      const current = await this.gateway.tryGetRecord(
        plan.config.appToken,
        plan.config.executionTableId,
        plan.executionRecordId,
        '采购执行',
      );
      if (!current) return '采购执行记录已不存在，未执行自动补偿';
      if (!fieldsMatch(current, plan.rollbackFields)) {
        return '采购状态已被其他操作改变，未执行自动补偿';
      }
      await this.gateway.updateRecord(
        plan.config.appToken,
        plan.config.executionTableId,
        plan.executionRecordId,
        plan.originalFields,
        '采购执行',
      );
      const verified = await this.gateway.tryGetRecord(
        plan.config.appToken,
        plan.config.executionTableId,
        plan.executionRecordId,
        '采购执行',
      );
      if (!verified || !fieldsMatch(verified, plan.originalFields)) {
        return '采购状态自动补偿后的回读不一致，请人工核对';
      }
      return '';
    } catch (error) {
      return `采购状态自动补偿失败：${errorMessage(error)}`;
    }
  }

  private async persistRunning(
    entry: InventoryMovementDeletionTaskLedgerEntry,
  ): Promise<InventoryMovementDeletionTaskLedgerEntry> {
    const updatedAt = this.now().toISOString();
    return this.taskLedger.updateTask(entry.task.id, {
      ...entry.task,
      status: 'running',
      message: '正在同步飞书多维表并删除记录',
      updatedAt,
    });
  }

  private async persistCompleted(
    entry: InventoryMovementDeletionTaskLedgerEntry,
    result: InventoryMovementDeletionResult,
  ): Promise<void> {
    const completedAt = this.now().toISOString();
    await this.taskLedger.updateTask(entry.task.id, {
      ...entry.task,
      status: 'completed',
      message: result.message,
      updatedAt: completedAt,
      completedAt,
      result,
    });
  }

  private async persistFailed(
    entry: InventoryMovementDeletionTaskLedgerEntry,
    message: string,
  ): Promise<void> {
    const completedAt = this.now().toISOString();
    await this.taskLedger.updateTask(entry.task.id, {
      ...entry.task,
      status: 'failed',
      message: safeTaskMessage(message, '删除失败，已确认记录未删除'),
      updatedAt: completedAt,
      completedAt,
      definitelyNotDeleted: true,
    });
  }

  private async persistUncertain(
    entry: InventoryMovementDeletionTaskLedgerEntry,
    message: string,
  ): Promise<void> {
    const completedAt = this.now().toISOString();
    await this.taskLedger.updateTask(entry.task.id, {
      ...entry.task,
      status: 'uncertain',
      message: safeTaskMessage(message, '删除结果暂不确定，请保留原变更号核对'),
      updatedAt: completedAt,
      completedAt,
      definitelyNotDeleted: false,
    });
  }

  private async authorizeProfessionalMovement(principal: AccessPrincipal, appToken: string, sku: string, building: string): Promise<void> {
    if (!isProfessionalBusinessPrincipal(principal)) return;
    const tableId = readEnv('FEISHU_WAREHOUSE_CATALOG_TABLE_ID');
    if (!tableId || !sku || !building) assertProfessionalRecordScope(principal, undefined);
    const catalog = await this.gateway.listRecords({ appToken, tableId, tableName: '物品类别' });
    const matching = catalog.filter(record => normalizeSku(fieldText(record, ['物品类别号'])) === sku && fieldText(record, ['楼栋']).trim() === building);
    if (matching.length !== 1) assertProfessionalRecordScope(principal, undefined);
    assertProfessionalBitableRecord(principal, matching[0]);
  }

  private async resolveWarehouseConfig(): Promise<WarehouseDeletionConfig> {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_WAREHOUSE_SOURCE_URL'),
    );
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || source.appToken,
      wikiToken: source.wikiToken,
      tableName: '南通运维全景驾驶舱-库房管理',
    });
    const config = {
      appToken,
      inboundTableId: readEnv(TABLES.inbound.env),
      outboundTableId: readEnv(TABLES.outbound.env),
    };
    const missing = Object.entries(config)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length) {
      throw new Error(`库存删除配置缺失：${missing.join('、')}`);
    }
    return config;
  }

  private invalidateRelatedCaches(appToken: string, tableId: string): void {
    try {
      this.gateway.invalidateRecordsCache(appToken, tableId);
    } catch (error) {
      this.logger.warn(`库存删除后列表缓存失效失败：${errorMessage(error)}`);
    }
    try {
      this.managementService.invalidateCache();
    } catch (error) {
      this.logger.warn(
        `库存删除后库存看板缓存失效失败：${errorMessage(error)}`,
      );
    }
    try {
      this.purchaseInventoryService?.invalidateCache();
    } catch (error) {
      this.logger.warn(
        `库存删除后采购看板缓存失效失败：${errorMessage(error)}`,
      );
    }
  }

  private async resolvePurchaseConfig(): Promise<PurchaseRollbackConfig> {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'),
    );
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken:
        readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') || source.appToken,
      wikiToken: source.wikiToken,
      tableName: '采购与库房管理',
    });
    const config = {
      appToken,
      executionTableId: readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID'),
    };
    if (!config.appToken || !config.executionTableId) {
      throw new Error('采购回退配置缺失');
    }
    return config;
  }
}

function normalizeDeletionRequest(
  value: CreateInventoryMovementDeletionRequest,
): CreateInventoryMovementDeletionRequest {
  if (!isRecord(value)) throw new BadRequestException('删除请求格式无效');
  const clientMutationId = clean(value.clientMutationId);
  const movementType = clean(value.movementType);
  const recordId = clean(value.recordId);
  if (!MUTATION_ID_PATTERN.test(clientMutationId)) {
    throw new BadRequestException('删除请求标识格式无效');
  }
  if (movementType !== 'inbound' && movementType !== 'outbound') {
    throw new BadRequestException('只能删除入库或出库记录');
  }
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new BadRequestException('出入库记录标识格式无效');
  }
  return { clientMutationId, movementType, recordId };
}

function normalizePrincipal(principal: AccessPrincipal): AccessPrincipal {
  if (isProfessionalBusinessPrincipal(principal)) return { ...principal, specialties: [...(principal.specialties || [])] };
  return principal.role === 'admin'
    ? { role: 'admin', purchaseBuilding: null }
    : {
        role: principal.role,
        purchaseBuilding: principal.purchaseBuilding,
        ...(principal.buildings ? { buildings: [...principal.buildings] } : {}),
      };
}

function normalizePrincipalFingerprint(value: unknown): string {
  const fingerprint = clean(value);
  if (
    fingerprint.length < 8 ||
    fingerprint.length > 512 ||
    CONTROL_CHARACTER_PATTERN.test(fingerprint)
  ) {
    throw new ForbiddenException('当前提交会话无法验证，请重新登录');
  }
  return fingerprint;
}

function movementTableId(
  config: WarehouseDeletionConfig,
  type: InventoryMovementDeletionType,
): string {
  return type === 'inbound' ? config.inboundTableId : config.outboundTableId;
}

function extractMovementBuilding(record: BitableRecordItem): string {
  return extractDisplayText(record.fields?.['楼栋']).split('、')[0].trim();
}

function purchaseExecutionId(record: BitableRecordItem): string {
  const source = extractDisplayText(record.fields?.['入库来源']).trim();
  if (!source.startsWith('采购:')) return '';
  const executionRecordId = source.slice('采购:'.length).trim();
  if (!RECORD_ID_PATTERN.test(executionRecordId)) {
    throw new BadRequestException('入库记录的采购关联标识无效');
  }
  return executionRecordId;
}

function buildRecoveryState(
  movementType: InventoryMovementDeletionType,
  movement: BitableRecordItem,
  building: string,
  purchaseExecutionRecordId: string,
  rollbackPlan?: PurchaseRollbackPlan,
): InventoryMovementDeletionRecoveryState {
  return {
    version: 1,
    phase: rollbackPlan ? 'prepared' : 'delete_started',
    movement: {
      building,
      purchaseExecutionRecordId,
      sku: normalizeSku(fieldText(movement, ['物品类别号'])),
      quantity: movementQuantity(movementType, movement),
    },
    ...(rollbackPlan
      ? {
          purchase: {
            executionRecordId: rollbackPlan.executionRecordId,
            building: rollbackPlan.building,
            requestCode: rollbackPlan.requestCode,
            sku: rollbackPlan.sku,
            quantity: rollbackPlan.quantity,
            originalFields: rollbackPlan.originalFields,
            rollbackFields: rollbackPlan.rollbackFields,
          },
        }
      : {}),
  };
}

function purchaseExecutionIdentity(record: BitableRecordItem): {
  building: string;
  requestCode: string;
  sku: string;
  quantity: number;
} {
  const building = fieldText(record, [
    '申请楼栋',
    '申请楼栋（多楼请选E楼，备注里填写详情）',
    '申请楼栋（多楼请选H楼，备注里填写详情）',
  ]).split('、')[0];
  const requestCode = fieldText(record, ['采购编码']);
  const sku = normalizeSku(
    fieldText(record, ['物品类别码', '物品类别号', '物品类别号（单选）']),
  );
  const quantity = fieldNumber(record, ['实际采购数量', '采购申请数量']);
  if (!building || !requestCode || !sku || quantity <= 0) {
    throw new BadRequestException(
      '关联采购执行记录的楼栋、采购编码、类别号或数量无效',
    );
  }
  return { building, requestCode, sku, quantity };
}

function assertPurchaseMovementLink(
  movement: BitableRecordItem,
  purchase: ReturnType<typeof purchaseExecutionIdentity>,
): void {
  const movementSku = normalizeSku(fieldText(movement, ['物品类别号']));
  const quantity = movementQuantity('inbound', movement);
  const requestCode = fieldText(movement, ['采购编码']);
  if (
    !movementSku ||
    movementSku !== purchase.sku ||
    quantity !== purchase.quantity ||
    (requestCode && requestCode !== purchase.requestCode)
  ) {
    throw new BadRequestException(
      '入库记录与关联采购执行的类别号、数量或采购编码不一致',
    );
  }
}

function assertRecoveredMovementMatches(
  entry: InventoryMovementDeletionTaskLedgerEntry,
  recovery: InventoryMovementDeletionRecoveryState,
  movement: BitableRecordItem,
): void {
  const actual = {
    building: extractMovementBuilding(movement),
    purchaseExecutionRecordId:
      entry.request.movementType === 'inbound'
        ? purchaseExecutionId(movement)
        : '',
    sku: normalizeSku(fieldText(movement, ['物品类别号'])),
    quantity: movementQuantity(entry.request.movementType, movement),
  };
  if (JSON.stringify(actual) !== JSON.stringify(recovery.movement)) {
    throw new Error('恢复删除时库存变动权威记录已变化，请人工核对');
  }
}

function assertRecoveredPurchaseMatches(
  principal: AccessPrincipal,
  recovery: InventoryMovementDeletionRecoveryState,
  expected: NonNullable<InventoryMovementDeletionRecoveryState['purchase']>,
  execution: BitableRecordItem,
): void {
  const actual = purchaseExecutionIdentity(execution);
  assertInventoryMovementDeletionScope(principal, actual.building);
  if (
    actual.building !== recovery.movement.building ||
    actual.building !== expected.building ||
    actual.requestCode !== expected.requestCode ||
    actual.sku !== expected.sku ||
    actual.quantity !== expected.quantity
  ) {
    throw new Error('恢复删除时关联采购执行权威字段已变化，请人工核对');
  }
}

function isPendingPurchaseExecution(record: BitableRecordItem): boolean {
  return buildPendingPurchaseInbounds({
    submissions: [],
    executions: [record],
    catalog: [],
  }).some(
    (item) => item.executionRecordId === clean(record.record_id || record.id),
  );
}

function fieldText(record: BitableRecordItem, names: string[]): string {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record.fields || {}, name)) {
      return extractDisplayText(record.fields?.[name]).trim();
    }
  }
  return '';
}

function fieldNumber(record: BitableRecordItem, names: string[]): number {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(record.fields || {}, name)) {
      continue;
    }
    const raw = record.fields?.[name];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const parsed = Number(extractDisplayText(raw).replace(/,/gu, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function movementQuantity(
  movementType: InventoryMovementDeletionType,
  record: BitableRecordItem,
): number {
  return fieldNumber(record, [
    movementType === 'inbound' ? '入库数量' : '出库数量',
  ]);
}

function normalizeSku(value: unknown): string {
  return clean(value).toUpperCase();
}

function buildPurchaseRollbackFields(
  schemas: readonly InventoryWorkflowFieldSchema[],
): Record<string, unknown> {
  const byName = new Map(schemas.map((schema) => [schema.fieldName, schema]));
  const result: Record<string, unknown> = {};
  const checkbox = byName.get('是否已入库');
  if (checkbox?.writable && checkbox.type === 7) result.是否已入库 = false;
  const purchaseStage = byName.get('采购流程');
  if (
    purchaseStage?.writable &&
    purchaseStage.type !== null &&
    [1, 3].includes(purchaseStage.type)
  ) {
    result.采购流程 = '到货已签收（待入库）';
  }
  const programStatus = byName.get('程序采购状态');
  if (
    programStatus?.writable &&
    programStatus.type !== null &&
    [1, 3].includes(programStatus.type)
  ) {
    result.程序采购状态 = '物品签收（待入库）';
  }
  if (!('采购流程' in result) && !('程序采购状态' in result)) {
    throw new Error('采购执行表缺少可写的待入库状态字段');
  }
  return result;
}

function fieldsMatch(
  record: BitableRecordItem,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([fieldName, expectedValue]) => {
    const actual = record.fields?.[fieldName];
    if (typeof expectedValue === 'boolean') {
      return fieldChecked(actual) === expectedValue;
    }
    if (expectedValue === null || expectedValue === undefined) {
      return !extractDisplayText(actual).trim();
    }
    return extractDisplayText(actual).trim() === String(expectedValue).trim();
  });
}

function fieldChecked(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = extractDisplayText(value).trim().toLowerCase();
  return text === 'true' || text === '是' || text === '1';
}

function cloneFieldValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function acceptedTask(
  task: InventoryMovementDeletionTask,
): InventoryMovementDeletionAcceptedResponse {
  return {
    accepted: true,
    taskId: task.id,
    status: task.status,
    message: task.message,
    ...(task.status === 'completed' ? { result: task.result } : {}),
    ...(task.status === 'failed' || task.status === 'uncertain'
      ? { definitelyNotDeleted: task.definitelyNotDeleted }
      : {}),
  };
}

function isTransientPreflightError(error: unknown): boolean {
  const status = Number(
    (error as { response?: { status?: unknown }; status?: unknown } | null)
      ?.response?.status ?? (error as { status?: unknown } | null)?.status,
  );
  if (DEFINITE_PREFLIGHT_HTTP_STATUSES.has(status)) return false;
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return true;
  }
  const code = clean((error as { code?: unknown } | null)?.code).toUpperCase();
  return TRANSIENT_ERROR_CODES.has(code);
}

function safeTaskMessage(message: string, fallback: string): string {
  const normalized = clean(message);
  return normalized && !CONTROL_CHARACTER_PATTERN.test(normalized)
    ? normalized.slice(0, 2_000)
    : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
