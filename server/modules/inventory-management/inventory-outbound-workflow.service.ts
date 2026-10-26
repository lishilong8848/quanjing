import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { businessAuthorizationSnapshot, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { canAccessBuilding } from '../../../shared/building-access';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  InventoryOutboundConfirmRequest,
  InventoryOutboundConfirmResponse,
  InventoryOutboundAcceptedResponse,
  InventoryOutboundTask,
  InventoryOutboundTaskStatusResponse,
  InventoryOutboundMovementItem,
  InventoryOutboundStatus,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundMovementCreateResponse,
  InventoryMovementOptionItem,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import { getWarehouseInventoryLocationReadFieldNames } from '../../common/config/warehouse-inventory-location.config';
import {
  resolveBitableAppToken,
  type BitableRecordItem,
  type BitableRecordSearchFilter,
} from '../../common/feishu/bitable-direct-read';
import { InventoryManagementService } from './inventory-management.service';
import { InventoryOutboundApprovalGateway } from '../inventory-outbound-approval/inventory-outbound-approval.gateway';
import {
  InventoryOutboundApprovalFinalizerRegistry,
  type InventoryOutboundApprovalBusinessFinalizer,
} from '../inventory-outbound-approval/inventory-outbound-approval.finalizer';
import { InventoryOutboundApprovalService } from '../inventory-outbound-approval/inventory-outbound-approval.service';
import type {
  InventoryOutboundApprovalApprover,
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalSnapshot,
} from '../inventory-outbound-approval/inventory-outbound-approval.types';
import { InventoryWarehouseRoleDirectory } from '../inventory-outbound-approval/inventory-warehouse-role-directory';
import { InventoryMovementOperationCoordinator } from './inventory-movement-operation-coordinator';
import {
  assertInventoryOutboundCanonicalRequest,
  buildInventoryOutboundRequestFingerprint as buildOutboundFingerprint,
} from './inventory-outbound-canonical';
import {
  buildMovementCreateFields,
  buildMovementOptions,
  validateMovementCreateRequest,
} from './inventory-movement-command.rules';
import {
  InventoryWorkflowGateway,
  InventoryWorkflowRecordDefinitelyNotWrittenError,
  InventoryWorkflowRecordNotFoundError,
} from './inventory-workflow.gateway';
import {
  InventoryOutboundTaskLedgerStore,
  type InventoryOutboundLedgerTask,
  type InventoryOutboundTaskLedgerEntry,
} from './inventory-outbound-task-ledger.store';

const TABLES = {
  inventory: { name: '库存台账', env: 'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID' },
  catalog: { name: '物品类别', env: 'FEISHU_WAREHOUSE_CATALOG_TABLE_ID' },
  outbound: { name: '出库填写', env: 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID' },
} as const;

const ROUTING_STATUS = '待路由';
const APPROVAL_PENDING_STATUS = '待审批';
const PENDING_STATUS = '待库房确认';
const REJECTED_STATUS = '已驳回';
const CONFIRMED_STATUS = '已出库';
const APPROVED_WORKFLOW_STATUS = '已通过';
const REJECTED_WORKFLOW_STATUS = '已驳回';
const OUTBOUND_APPROVAL_POLICY_VERSION = 'inventory-outbound-v1';
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PROGRAM_OUTBOUND_APPLICATION_FIELDS = [
  '出库创建标识',
  '出库请求指纹',
  '程序出库申请数量',
  '程序出库申请时间',
] as const;
const DEFAULT_RECOVERY_SCAN_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECOVERY_SCAN_MAXIMUM_DELAY_MS = 30_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 90_000;
const DEFAULT_MAXIMUM_PREFLIGHT_ATTEMPTS = 5;
const DEFAULT_MAXIMUM_PREFLIGHT_AGE_MS = 5 * 60_000;
const MAXIMUM_PREFLIGHT_RETRY_BACKOFF_MS = 60_000;
const DEFAULT_WRITE_OPERATION_TIMEOUT_MS = 150_000;
const DEFAULT_PREFLIGHT_OPERATION_TIMEOUT_MS = 60_000;

export const INVENTORY_OUTBOUND_RECOVERY_OPTIONS =
  'INVENTORY_OUTBOUND_RECOVERY_OPTIONS';

export interface InventoryOutboundRecoveryOptions {
  initialScanDelayMs?: number;
  maximumScanDelayMs?: number;
  shutdownDrainTimeoutMs?: number;
  maximumPreflightAttempts?: number;
  maximumPreflightAgeMs?: number;
  /** Legacy shared timeout. Prefer the stage-specific values below. */
  externalOperationTimeoutMs?: number;
  preflightOperationTimeoutMs?: number;
  writeOperationTimeoutMs?: number;
}

interface OutboundConfig {
  appToken: string;
  inventoryTableId: string;
  catalogTableId: string;
  outboundTableId: string;
}

interface OutboundIdentity {
  building: WarehouseBuilding;
  catalogRecordId: string;
  sku: string;
  catalogRecord?: BitableRecordItem;
}

interface ApprovedDecisionContext {
  snapshot: InventoryOutboundApprovalSnapshot;
  decision: InventoryOutboundApprovalDecision;
}

interface CoreSnapshot {
  catalog: BitableRecordItem[];
  inventory: BitableRecordItem[];
}

type PreparedPendingCreate =
  | { response: InventoryOutboundMovementCreateResponse }
  | {
      config: OutboundConfig;
      fields: Record<string, unknown>;
      option: InventoryMovementOptionItem;
    };

class PendingCreateMarkerOutcomeUncertainError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly outboundRecordMayExist: boolean,
  ) {
    super(safeErrorMessage(originalError));
    this.name = 'PendingCreateMarkerOutcomeUncertainError';
  }
}

class InventoryOutboundExternalOperationTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(stage: string, timeoutMs: number) {
    super(`出库${stage}超过 ${timeoutMs}ms 未返回`);
    this.name = 'InventoryOutboundExternalOperationTimeoutError';
  }
}

const definitelyNotReservedAcceptanceErrors = new WeakSet<object>();

export function isInventoryOutboundAcceptanceDefinitelyNotWrittenError(
  error: unknown,
): boolean {
  return isObjectLike(error)
    ? definitelyNotReservedAcceptanceErrors.has(error)
    : false;
}

function markInventoryOutboundAcceptanceDefinitelyNotWritten<T>(error: T): T {
  if (isObjectLike(error)) {
    definitelyNotReservedAcceptanceErrors.add(error);
  }
  return error;
}

@Injectable()
export class InventoryOutboundWorkflowService
  implements
    OnModuleInit,
    OnModuleDestroy,
    InventoryOutboundApprovalBusinessFinalizer
{
  private readonly logger = new Logger(InventoryOutboundWorkflowService.name);
  private readonly serialByMutationId = new Map<string, Promise<void>>();
  private readonly serialByRecordId = new Map<string, Promise<void>>();
  private readonly serialByStockKey = new Map<string, Promise<void>>();
  private readonly scheduledTaskIds = new Set<string>();
  private readonly pendingTaskImmediates = new Map<
    string,
    ReturnType<typeof setImmediate>
  >();
  private readonly inFlightPendingTasks = new Map<string, Promise<void>>();
  private readonly inFlightUncertainTasks = new Map<string, Promise<void>>();
  private readonly inFlightUnregisteredRecoveries = new Map<
    string,
    Promise<void>
  >();
  private readonly activeTaskHeartbeatTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly recoveryScanInitialDelayMs: number;
  private readonly recoveryScanMaximumDelayMs: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly maximumPreflightAttempts: number;
  private readonly maximumPreflightAgeMs: number;
  private readonly preflightOperationTimeoutMs: number;
  private readonly writeOperationTimeoutMs: number;
  private recoveryScanDelayMs: number;
  private recoveryScanTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryScanExecution: Promise<void> | null = null;
  private recoveryStopped = false;
  private destroyPromise: Promise<void> | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly gateway: InventoryWorkflowGateway,
    private readonly approvalService: InventoryOutboundApprovalService,
    private readonly warehouseRoleDirectory: InventoryWarehouseRoleDirectory,
    private readonly approvalGateway: InventoryOutboundApprovalGateway,
    private readonly managementService?: InventoryManagementService,
    @Optional()
    private readonly taskLedger: InventoryOutboundTaskLedgerStore = new InventoryOutboundTaskLedgerStore(),
    @Optional()
    @Inject(INVENTORY_OUTBOUND_RECOVERY_OPTIONS)
    recoveryOptions: InventoryOutboundRecoveryOptions = {},
    @Optional()
    private readonly operationCoordinator?: InventoryMovementOperationCoordinator,
    @Optional()
    private readonly approvalFinalizerRegistry?: InventoryOutboundApprovalFinalizerRegistry,
  ) {
    this.approvalFinalizerRegistry?.register(this);
    this.recoveryScanInitialDelayMs = positiveInteger(
      recoveryOptions.initialScanDelayMs,
      DEFAULT_RECOVERY_SCAN_INITIAL_DELAY_MS,
    );
    this.recoveryScanMaximumDelayMs = Math.max(
      this.recoveryScanInitialDelayMs,
      positiveInteger(
        recoveryOptions.maximumScanDelayMs,
        DEFAULT_RECOVERY_SCAN_MAXIMUM_DELAY_MS,
      ),
    );
    this.shutdownDrainTimeoutMs = positiveInteger(
      recoveryOptions.shutdownDrainTimeoutMs,
      DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
    );
    this.maximumPreflightAttempts = positiveInteger(
      recoveryOptions.maximumPreflightAttempts,
      DEFAULT_MAXIMUM_PREFLIGHT_ATTEMPTS,
    );
    this.maximumPreflightAgeMs = positiveInteger(
      recoveryOptions.maximumPreflightAgeMs,
      DEFAULT_MAXIMUM_PREFLIGHT_AGE_MS,
    );
    this.preflightOperationTimeoutMs = positiveInteger(
      recoveryOptions.preflightOperationTimeoutMs ??
        recoveryOptions.externalOperationTimeoutMs,
      DEFAULT_PREFLIGHT_OPERATION_TIMEOUT_MS,
    );
    this.writeOperationTimeoutMs = positiveInteger(
      recoveryOptions.writeOperationTimeoutMs ??
        recoveryOptions.externalOperationTimeoutMs,
      DEFAULT_WRITE_OPERATION_TIMEOUT_MS,
    );
    this.recoveryScanDelayMs = this.recoveryScanInitialDelayMs;
  }

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (
        /^(?:1|true|on|yes)$/i.test(
          process.env.NANTONG_HOTFIX_SMOKE_MODE?.trim() || '',
        )
      ) {
        return;
      }
      this.recoveryStopped = false;
      await this.scanPendingTasks();
      this.recoveryScanDelayMs = this.recoveryScanInitialDelayMs;
      this.scheduleRecoveryScan();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    if (this.destroyPromise) return this.destroyPromise;
    this.recoveryStopped = true;
    if (this.recoveryScanTimer) clearTimeout(this.recoveryScanTimer);
    this.recoveryScanTimer = null;
    for (const [taskId, immediate] of this.pendingTaskImmediates) {
      clearImmediate(immediate);
      this.pendingTaskImmediates.delete(taskId);
      this.scheduledTaskIds.delete(taskId);
    }
    this.destroyPromise = this.drainPendingTasks();
    return this.destroyPromise;
  }

  private async drainPendingTasks(): Promise<void> {
    const executions = [
      ...this.inFlightPendingTasks.values(),
      ...this.inFlightUncertainTasks.values(),
      ...this.inFlightUnregisteredRecoveries.values(),
      ...(this.recoveryScanExecution ? [this.recoveryScanExecution] : []),
    ];
    if (executions.length === 0) return;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.allSettled(executions).then(
      () => 'drained' as const,
    );
    const timedOut = new Promise<'timed-out'>((resolveTimeout) => {
      timeoutTimer = setTimeout(
        () => resolveTimeout('timed-out'),
        this.shutdownDrainTimeoutMs,
      );
      timeoutTimer.unref?.();
    });
    const outcome = await Promise.race([drained, timedOut]);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (outcome === 'drained') return;

    this.logger.warn(
      `outbound task drain timed out after ${this.shutdownDrainTimeoutMs}ms; active writes will not be cancelled or replayed`,
    );
    for (const [taskId, heartbeatTimer] of this.activeTaskHeartbeatTimers) {
      clearInterval(heartbeatTimer);
      this.activeTaskHeartbeatTimers.delete(taskId);
    }
    await Promise.allSettled(
      [...this.inFlightPendingTasks.keys()].map((taskId) =>
        this.abandonPendingClaim(taskId),
      ),
    );
    await Promise.allSettled(
      [...this.inFlightUncertainTasks.keys()].map((taskId) =>
        this.abandonUncertainClaim(taskId),
      ),
    );
  }

  private async scanPendingTasks(): Promise<number | null> {
    let pendingTasks: InventoryOutboundTaskLedgerEntry[];
    let uncertainTasks: InventoryOutboundTaskLedgerEntry[];
    try {
      [pendingTasks, uncertainTasks] = await Promise.all([
        this.taskLedger.listPending(),
        this.taskLedger.listUncertain(),
      ]);
    } catch (error) {
      this.logger.error(
        `出库任务恢复扫描失败，将继续定时重试: ${safeErrorMessage(error)}`,
      );
      return null;
    }
    for (const entry of pendingTasks) {
      if (isPreflightRetryDue(entry.task)) {
        this.schedulePendingTask(entry.task.id);
      }
    }
    for (const entry of uncertainTasks) {
      this.scheduleUncertainTask(entry);
    }
    return pendingTasks.length + uncertainTasks.length;
  }

  private scheduleUncertainTask(entry: InventoryOutboundTaskLedgerEntry): void {
    const taskId = entry.task.id;
    if (this.recoveryStopped || this.inFlightUncertainTasks.has(taskId)) return;
    const execution = this.reconcileUncertainTask(entry)
      .then(() => undefined)
      .catch((error) => {
        this.logger.error(
          `出库不确定任务后台对账失败，将继续定时重试: task=${taskId}, message=${safeErrorMessage(error)}`,
        );
      })
      .finally(() => {
        this.inFlightUncertainTasks.delete(taskId);
      });
    this.inFlightUncertainTasks.set(taskId, execution);
  }

  private scheduleRecoveryScan(): void {
    if (this.recoveryStopped || this.recoveryScanTimer) return;
    this.recoveryScanTimer = setTimeout(() => {
      this.recoveryScanTimer = null;
      if (this.recoveryStopped) return;
      const execution = this.runRecoveryScan();
      this.recoveryScanExecution = execution;
      void execution.finally(() => {
        if (this.recoveryScanExecution === execution) {
          this.recoveryScanExecution = null;
        }
      });
    }, this.recoveryScanDelayMs);
    this.recoveryScanTimer.unref?.();
  }

  private async runRecoveryScan(): Promise<void> {
    const pendingCount = await this.scanPendingTasks();
    await this.scanUnregisteredOutbounds();
    if (this.recoveryStopped) return;
    this.recoveryScanDelayMs =
      pendingCount === null || pendingCount > 0
        ? this.recoveryScanInitialDelayMs
        : Math.min(
            this.recoveryScanDelayMs * 2,
            this.recoveryScanMaximumDelayMs,
          );
    this.scheduleRecoveryScan();
  }

  private async scanUnregisteredOutbounds(): Promise<void> {
    let records: BitableRecordItem[];
    try {
      const config = await this.resolveConfig();
      records = await this.gateway.searchRecords({
        appToken: config.appToken,
        tableId: config.outboundTableId,
        tableName: TABLES.outbound.name,
        filter: buildExactTextSearchFilter('出库工作流状态', ROUTING_STATUS),
      });
    } catch (error) {
      this.logger.error(
        `待路由出库记录恢复扫描失败，将继续定时重试: ${safeErrorMessage(error)}`,
      );
      return;
    }

    for (const record of records) {
      if (this.recoveryStopped) return;
      const clientMutationId = fieldText(record.fields, ['出库创建标识']);
      if (!clientMutationId) {
        this.logger.error('待路由出库记录缺少创建标识，已跳过后台恢复');
        continue;
      }
      try {
        if (await this.taskLedger.findByMutationId(clientMutationId)) continue;
      } catch (error) {
        this.logger.error(
          `待路由出库记录本地任务查重失败，已停止本轮扫描: ${safeErrorMessage(error)}`,
        );
        return;
      }
      if (this.recoveryStopped) return;
      let recordId: string;
      try {
        recordId = getRecordId(record);
      } catch (error) {
        this.logger.error(
          `待路由出库记录缺少有效标识，已跳过: ${safeErrorMessage(error)}`,
        );
        continue;
      }
      if (this.inFlightUnregisteredRecoveries.has(recordId)) continue;
      const execution = this.recoverUnregisteredOutbound(recordId)
        .catch((error) => {
          this.logger.error(
            `待路由出库记录后台恢复失败，将继续定时重试: record=${recordId}, message=${safeErrorMessage(error)}`,
          );
        })
        .finally(() => {
          this.inFlightUnregisteredRecoveries.delete(recordId);
        });
      this.inFlightUnregisteredRecoveries.set(recordId, execution);
    }
  }

  async acceptPending(
    request: InventoryOutboundMovementCreateRequest,
    principal: AccessPrincipal,
    principalFingerprintValue: string,
  ): Promise<InventoryOutboundAcceptedResponse> {
    let normalizedRequest: InventoryOutboundMovementCreateRequest;
    let principalFingerprint: string;
    let requestFingerprint: string;
    try {
      if (!isRecord(request)) {
        throw new BadRequestException('出库申请参数格式无效');
      }
      assertNoLegacyOutboundFields(request);
      normalizedRequest = normalizeOutboundRequest(request);
      await this.assertProfessionalCatalog(principal, normalizedRequest);
      authorizeBuildingScope(principal, normalizedRequest.building);
      principalFingerprint = normalizePrincipalFingerprint(
        principalFingerprintValue,
      );
      requestFingerprint = buildOutboundFingerprint(normalizedRequest);
    } catch (error) {
      throw markInventoryOutboundAcceptanceDefinitelyNotWritten(error);
    }
    const reservation = await this.taskLedger.reserve({
      ...(isProfessionalBusinessPrincipal(principal) ? { professionalPrincipal: businessAuthorizationSnapshot(principal) } : {}),
      building: normalizedRequest.building,
      principalFingerprint,
      clientMutationId: normalizedRequest.clientMutationId,
      requestFingerprint,
      request: normalizedRequest,
      task: {
        id: `inventory-outbound-${randomUUID()}`,
        status: 'pending',
        message: '出库申请已受理，正在后台同步飞书多维表',
        createdAt: new Date().toISOString(),
      },
    });
    assertMatchingTaskIdentity(reservation.entry, {
      building: normalizedRequest.building,
      principalFingerprint,
      requestFingerprint,
    });
    if (
      reservation.entry.clientMutationId !== normalizedRequest.clientMutationId
    ) {
      throw new ConflictException(
        '检测到相同出库申请已受理，已阻止重复写入；请刷新出库记录查看原任务状态',
      );
    }
    if (
      (reservation.created || reservation.entry.task.status === 'pending') &&
      isPreflightRetryDue(reservation.entry.task)
    ) {
      this.schedulePendingTask(reservation.entry.task.id);
    }
    return acceptedTask(reservation.entry.task);
  }

  async getTaskStatus(
    taskIdValue: string,
    buildingValue: string,
    principal: AccessPrincipal,
    principalFingerprintValue: string,
  ): Promise<InventoryOutboundTaskStatusResponse> {
    const taskId = clean(taskIdValue);
    const building = parseBuilding(buildingValue);
    const principalFingerprint = normalizePrincipalFingerprint(
      principalFingerprintValue,
    );
    authorizeBuildingScope(principal, building);
    let entry = taskId ? await this.taskLedger.findByTaskId(taskId) : undefined;
    if (
      !entry ||
      entry.building !== building ||
      entry.principalFingerprint !== principalFingerprint
    ) {
      throw new ForbiddenException('出库后台任务不存在或无权访问');
    }
    if (entry.task.status === 'uncertain') {
      entry = await this.reconcileUncertainTask(entry);
    }
    if (entry.task.status === 'pending' && isPreflightRetryDue(entry.task)) {
      this.schedulePendingTask(entry.task.id);
    }
    return { success: true, task: publicTask(entry.task) };
  }

  async createPending(
    request: InventoryOutboundMovementCreateRequest,
    principal?: AccessPrincipal,
  ): Promise<InventoryOutboundMovementCreateResponse> {
    if (!isRecord(request)) {
      throw new BadRequestException('出库申请参数格式无效');
    }
    assertNoLegacyOutboundFields(request);
    const normalizedRequest = normalizeOutboundRequest(request);
    authorizeBuildingScope(principal, normalizedRequest.building);
    await this.assertProfessionalCatalog(principal, normalizedRequest);
    const fingerprint = buildOutboundFingerprint(normalizedRequest);
    const stockKey = buildStockKey(
      normalizedRequest.building,
      normalizedRequest.sku,
    );

    return this.runSerial(
      this.serialByMutationId,
      normalizedRequest.clientMutationId,
      () =>
        this.runSerial(this.serialByStockKey, stockKey, () =>
          this.createPendingLocked(normalizedRequest, fingerprint, principal),
        ),
    );
  }

  async confirm(
    recordId: string,
    request: InventoryOutboundConfirmRequest,
    principal: AccessPrincipal,
  ): Promise<InventoryOutboundConfirmResponse> {
    const normalizedRecordId = clean(recordId);
    if (!normalizedRecordId) {
      throw new BadRequestException('出库记录标识不能为空');
    }
    const confirmationId = clean(request?.clientMutationId);
    if (!confirmationId) {
      throw new BadRequestException('出库确认标识不能为空');
    }
    authorizeConfirmRole(principal);
    return this.confirmRecord(normalizedRecordId, confirmationId, principal);
  }

  async finalizeApprovedOutbound(
    snapshot: InventoryOutboundApprovalSnapshot,
    decision: InventoryOutboundApprovalDecision,
  ): Promise<void> {
    if (decision.action !== 'approve') {
      throw new BadRequestException('出库正式确认仅接受审批通过决定');
    }
    await this.approvalService.assertAcceptedDecision(snapshot, decision);
    await this.confirmRecord(
      snapshot.recordId,
      decision.eventId,
      { role: 'admin', purchaseBuilding: null },
      { snapshot, decision },
    );
  }

  async recoverUnregisteredOutbound(recordId: string): Promise<void> {
    const normalizedRecordId = clean(recordId);
    if (!normalizedRecordId) {
      throw new BadRequestException('出库记录标识不能为空');
    }
    await this.runSerial(
      this.serialByRecordId,
      normalizedRecordId,
      async () => {
        const config = await this.resolveConfig();
        const record = await withOutboundRecoveryStage('读取出库记录', () =>
          this.getOutboundRecordOrThrow(config, normalizedRecordId),
        );
        if (fieldText(record.fields, ['出库工作流状态']) !== ROUTING_STATUS) {
          return;
        }
        const identity = await withOutboundRecoveryStage(
          '读取关联物品类别',
          () => this.resolveRecordIdentity(config, record),
        );
        const request = buildPendingRequest(record, identity);
        assertPendingApplicationFingerprint(record, request);
        const fingerprint = fieldText(record.fields, ['出库请求指纹']);
        const snapshot = await withOutboundRecoveryStage(
          '核对物品类别和库存',
          () => this.loadCoreSnapshot(config, identity),
        );
        const option = findOption(snapshot, request, true);
        if (!option) throw consistencyConflict('无法恢复出库物品信息');
        assertRoutingReadback(record, request, fingerprint, option);
        await withOutboundRecoveryStage('恢复审批路由', () =>
          this.recoverPendingApproval(record, request, fingerprint, option),
        );
      },
    );
  }

  private async confirmRecord(
    normalizedRecordId: string,
    confirmationId: string,
    principal: AccessPrincipal,
    approvedDecision?: ApprovedDecisionContext,
  ): Promise<InventoryOutboundConfirmResponse> {
    const confirmOperation = async () => {
      const config = await this.resolveConfig();

      return this.runSerial(
        this.serialByRecordId,
        normalizedRecordId,
        async () => {
          const initialRecord = await this.getOutboundRecordOrThrow(
            config,
            normalizedRecordId,
          );
          const initialBuilding = requireBuilding(initialRecord.fields);
          authorizeBuildingScope(principal, initialBuilding);
          const initialIdentity = await this.resolveRecordIdentity(
            config,
            initialRecord,
          );
          const stockKey = buildStockKey(
            initialIdentity.building,
            initialIdentity.sku,
          );

          return this.runSerial(this.serialByStockKey, stockKey, async () => {
            const authoritativeRecord = await this.getOutboundRecordOrThrow(
              config,
              normalizedRecordId,
            );
            const authoritativeBuilding = requireBuilding(
              authoritativeRecord.fields,
            );
            authorizeBuildingScope(principal, authoritativeBuilding);
            const identity = await this.resolveRecordIdentity(
              config,
              authoritativeRecord,
            );
            assertProfessionalBitableRecord(principal, identity.catalogRecord);
            if (!sameIdentity(initialIdentity, identity)) {
              throw consistencyConflict('出库记录的楼栋或物品已变化');
            }
            await this.ensureFields(config);
            return this.confirmLocked(
              config,
              authoritativeRecord,
              identity,
              confirmationId,
              approvedDecision,
            );
          });
        },
      );
    };

    return this.operationCoordinator
      ? this.operationCoordinator.run(
          [`movement:outbound:${normalizedRecordId}`],
          confirmOperation,
        )
      : confirmOperation();
  }

  private async createPendingLocked(
    request: InventoryOutboundMovementCreateRequest,
    fingerprint: string,
    principal?: AccessPrincipal,
  ): Promise<InventoryOutboundMovementCreateResponse> {
    let prepared: PreparedPendingCreate;
    try {
      prepared = await this.preparePendingCreate(request, fingerprint, principal);
    } catch (error) {
      if (error instanceof PendingCreateMarkerOutcomeUncertainError) {
        throw error.originalError;
      }
      throw error;
    }
    if ('response' in prepared) return prepared.response;
    return this.writePreparedPending(request, fingerprint, prepared);
  }

  private async preparePendingCreate(
    request: InventoryOutboundMovementCreateRequest,
    fingerprint: string,
    principal?: AccessPrincipal,
  ): Promise<PreparedPendingCreate> {
    await this.assertProfessionalCatalog(principal, request);
    let config: OutboundConfig;
    let markers: BitableRecordItem[];
    try {
      config = await this.resolveConfig();
      await this.ensureCreationMarkerField(config);
      markers = await this.gateway.listRecords({
        appToken: config.appToken,
        tableId: config.outboundTableId,
        tableName: TABLES.outbound.name,
        searchFilter: buildExactTextSearchFilter(
          '出库创建标识',
          request.clientMutationId,
        ),
      });
    } catch (error) {
      if (isPermanentPreflightError(error)) throw error;
      throw new PendingCreateMarkerOutcomeUncertainError(error, false);
    }
    if (markers.length !== 0) {
      try {
        if (markers.length > 1) {
          throw new ConflictException('检测到重复出库创建标识记录');
        }
        const markerFingerprint = fieldText(markers[0].fields, [
          '出库请求指纹',
        ]);
        if (markerFingerprint !== fingerprint) {
          throw new ConflictException('出库创建标识已被其它申请占用');
        }
        const persisted = await this.gateway.getRecord(
          config.appToken,
          config.outboundTableId,
          getRecordId(markers[0]),
          TABLES.outbound.name,
        );
        const option = buildReconciliationOption(persisted, request);
        const recovered = await this.recoverPendingApproval(
          persisted,
          request,
          fingerprint,
          option,
          true,
        );
        const response = buildCreateResponse(
          recovered,
          buildReconciliationOption(recovered, request),
          true,
          '出库申请已存在',
        );
        this.managementService?.invalidateCache();
        return { response };
      } catch (error) {
        throw new PendingCreateMarkerOutcomeUncertainError(error, true);
      }
    }

    try {
      await this.ensureFields(config, true);
      const snapshot = await this.loadCoreSnapshot(config, request);
      const option = findOption(snapshot, request, false);
      validateMovementCreateRequest(request, option);
      if (!option) {
        throw new BadRequestException('请选择有效物品');
      }
      const fields = buildMovementCreateFields(request, option, fingerprint);
      return { config, fields, option };
    } catch (error) {
      if (isRetryablePreflightError(error)) {
        throw new PendingCreateMarkerOutcomeUncertainError(error, false);
      }
      throw error;
    }
  }

  private async writePreparedPending(
    request: InventoryOutboundMovementCreateRequest,
    fingerprint: string,
    prepared: Exclude<PreparedPendingCreate, { response: unknown }>,
  ): Promise<InventoryOutboundMovementCreateResponse> {
    const recordId = await this.gateway.createRecord(
      prepared.config.appToken,
      prepared.config.outboundTableId,
      prepared.fields,
      TABLES.outbound.name,
    );
    this.managementService?.invalidateCache();
    const persisted = await this.gateway.getRecord(
      prepared.config.appToken,
      prepared.config.outboundTableId,
      recordId,
      TABLES.outbound.name,
    );
    assertRoutingReadback(persisted, request, fingerprint, prepared.option);
    const approval = await this.registerPendingApproval(
      persisted,
      request,
      prepared.option,
    );
    return buildCreateResponse(
      persisted,
      prepared.option,
      false,
      '出库申请已提交，待审批',
      approval.approvers,
    );
  }

  private async registerPendingApproval(
    record: BitableRecordItem,
    request: InventoryOutboundMovementCreateRequest,
    option?: InventoryMovementOptionItem,
  ): Promise<InventoryOutboundApprovalSnapshot> {
    const recordId = getRecordId(record);
    try {
      const entry = await this.approvalService.ensurePendingForRequest(
        { recordId, fields: record.fields },
        {
          recordId,
          outboundNumber: request.clientMutationId,
          applicantOpenId: request.applicantOpenId,
          sku: request.sku,
          quantity: request.quantity,
          building: request.building,
          reason: request.reason,
          appliedAt: new Date(request.occurredAt).toISOString(),
        },
        async () => {
          const [approvers, managerRecipients, snapshotOption] =
            await Promise.all([
              this.warehouseRoleDirectory.resolveApprovers(request.building),
              this.warehouseRoleDirectory.resolveNotificationRecipients(
                request.building,
              ),
              option
                ? Promise.resolve(option)
                : this.resolveConfig().then(async (config) =>
                    findOption(
                      await this.loadCoreSnapshot(config, request),
                      request,
                      true,
                    ),
                  ),
            ]);
          if (!approvers.length) {
            throw new Error(`${request.building}未配置有效的库房示例人员019员`);
          }
          if (!snapshotOption)
            throw consistencyConflict('无法恢复出库物品信息');
          return buildApprovalSnapshot(
            record,
            request,
            snapshotOption,
            approvers,
            managerRecipients,
          );
        },
      );
      return entry.snapshot;
    } catch (error) {
      const cause = safeErrorMessage(error);
      const guidance = cause.includes('存放位置无效')
        ? `请给对应物品的${request.building}库存台账配置有效存放位置，系统将按原编号 ${request.clientMutationId} 自动恢复，无需重新申请`
        : cause.includes('未配置') || cause.includes('配置缺失')
          ? `请检查库房示例人员019员及库房管理人配置后使用原编号 ${request.clientMutationId} 重试`
          : `系统将保留原编号 ${request.clientMutationId} 核对审批账本并恢复，请勿重复申请`;
      const message = `${request.building}出库审批路由失败：${cause}。${guidance}`;
      try {
        await this.approvalGateway.writeWorkflowError(recordId, message);
      } catch (writeError) {
        this.logger.error(
          `出库审批错误回写失败: record=${recordId}, message=${safeErrorMessage(writeError)}`,
        );
      }
      throw error;
    }
  }

  private async runExternalOperation<T>(
    stage: string,
    operation: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<T>((_resolve, reject) => {
          timeoutTimer = setTimeout(
            () =>
              reject(
                new InventoryOutboundExternalOperationTimeoutError(
                  stage,
                  timeoutMs,
                ),
              ),
            timeoutMs,
          );
          timeoutTimer.unref?.();
        }),
      ]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  private schedulePendingTask(taskId: string): void {
    if (this.recoveryStopped || this.scheduledTaskIds.has(taskId)) return;
    this.scheduledTaskIds.add(taskId);
    const immediate = setImmediate(() => {
      this.pendingTaskImmediates.delete(taskId);
      if (this.recoveryStopped) {
        this.scheduledTaskIds.delete(taskId);
        return;
      }
      const execution = this.executePendingTask(taskId)
        .catch((error) => {
          this.logger.error(
            `出库后台任务执行失败: task=${taskId}, message=${safeErrorMessage(error)}`,
          );
        })
        .finally(() => {
          this.inFlightPendingTasks.delete(taskId);
          this.scheduledTaskIds.delete(taskId);
        });
      this.inFlightPendingTasks.set(taskId, execution);
    });
    this.pendingTaskImmediates.set(taskId, immediate);
  }

  private async executePendingTask(taskId: string): Promise<void> {
    const claimed = await this.taskLedger.claimPending(taskId);
    if (!claimed.claimed) return;
    if (this.recoveryStopped) {
      await this.abandonPendingClaim(taskId);
      return;
    }
    let leaseFailure: unknown;
    let renewalInFlight: Promise<void> | null = null;
    const renewLease = () => {
      if (renewalInFlight) return;
      renewalInFlight = this.taskLedger
        .renewClaim(taskId)
        .then(() => {
          leaseFailure = undefined;
        })
        .catch((error) => {
          leaseFailure = error;
        })
        .finally(() => {
          renewalInFlight = null;
        });
    };
    const heartbeatTimer = setInterval(
      renewLease,
      this.taskLedger.getLeaseHeartbeatIntervalMs(),
    );
    this.activeTaskHeartbeatTimers.set(taskId, heartbeatTimer);
    heartbeatTimer.unref?.();
    try {
      await this.executeClaimedPendingTask(claimed.entry, async () => {
        if (renewalInFlight) await renewalInFlight;
        return leaseFailure;
      });
    } finally {
      clearInterval(heartbeatTimer);
      this.activeTaskHeartbeatTimers.delete(taskId);
      if (renewalInFlight) await renewalInFlight;
    }
  }

  private async executeClaimedPendingTask(
    entry: InventoryOutboundTaskLedgerEntry,
    getLeaseFailure: () => Promise<unknown>,
  ): Promise<void> {
    const { request, requestFingerprint } = entry;
    const taskId = entry.task.id;
    const attemptedTask: InventoryOutboundLedgerTask = {
      ...entry.task,
      preflightAttemptCount: (entry.task.preflightAttemptCount || 0) + 1,
      lastPreflightAttemptAt: new Date().toISOString(),
    };
    let prepared: PreparedPendingCreate;
    try {
      prepared = await this.runExternalOperation(
        '写入前校验',
        () => this.preparePendingCreate(request, requestFingerprint, entry.professionalPrincipal),
        this.preflightOperationTimeoutMs,
      );
    } catch (error) {
      if (this.recoveryStopped) {
        await this.abandonPendingClaim(taskId);
        return;
      }
      if (error instanceof PendingCreateMarkerOutcomeUncertainError) {
        if (error.outboundRecordMayExist) {
          await this.persistUncertainTask(attemptedTask);
          this.logger.error(
            `出库任务已发现原编号记录但对账未确认: task=${taskId}, message=${safeErrorMessage(error.originalError)}`,
          );
        } else {
          await this.handleRetryablePreflightFailure(
            attemptedTask,
            error.originalError,
          );
        }
        return;
      }
      await this.persistFailedTask(
        attemptedTask,
        outboundTaskFailureMessage('写入前校验', error),
      );
      return;
    }
    if (this.recoveryStopped) {
      await this.abandonPendingClaim(taskId);
      return;
    }
    if ('response' in prepared) {
      await this.persistCompletedTask(entry.task, prepared.response);
      return;
    }
    const leaseFailure = await getLeaseFailure();
    if (leaseFailure !== undefined) {
      this.logger.error(
        `出库任务 lease 续约失败，已禁止外部写入: task=${taskId}, message=${safeErrorMessage(leaseFailure)}`,
      );
      await this.abandonPendingClaim(taskId);
      return;
    }

    const runningTask: InventoryOutboundLedgerTask = {
      ...attemptedTask,
      status: 'running',
      message: '出库申请正在写入飞书多维表',
    };
    let persistedRunning: InventoryOutboundLedgerTask;
    try {
      persistedRunning = (await this.taskLedger.updateTask(taskId, runningTask))
        .task;
    } catch (error) {
      this.logger.error(
        `出库任务运行态持久化失败，已禁止外部写入: task=${taskId}, message=${safeErrorMessage(error)}`,
      );
      await this.abandonPendingClaim(taskId);
      return;
    }

    try {
      const result = await this.runExternalOperation(
        '多维表写入',
        () => this.writePreparedPending(request, requestFingerprint, prepared),
        this.writeOperationTimeoutMs,
      );
      await this.persistCompletedTask(persistedRunning, result);
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordDefinitelyNotWrittenError) {
        if (isFeishuRequestRateLimit(error)) {
          await this.taskLedger.requeueDefinitelyRejectedWrite(
            taskId,
            '飞书请求暂时限流，出库申请已保留原编号并将在后台重试',
          );
          this.logger.warn(
            `出库任务写入被飞书限流，已按原编号重新排队: task=${taskId}`,
          );
          return;
        }
        await this.persistFailedTask(
          persistedRunning,
          outboundTaskFailureMessage('多维表写入', error),
        );
        this.logger.error(
          `出库任务写入被明确拒绝: task=${taskId}, message=${safeErrorMessage(error)}`,
        );
        return;
      }
      await this.persistUncertainTask(persistedRunning);
      this.logger.error(
        `出库任务外部写入或回读未确认: task=${taskId}, message=${safeErrorMessage(error)}`,
      );
    }
  }

  private async handleRetryablePreflightFailure(
    current: InventoryOutboundLedgerTask,
    error: unknown,
  ): Promise<void> {
    const attemptCount = current.preflightAttemptCount || 1;
    const createdAt = Date.parse(current.createdAt);
    const ageMs = Number.isFinite(createdAt)
      ? Math.max(0, Date.now() - createdAt)
      : this.maximumPreflightAgeMs;
    const delayed =
      attemptCount >= this.maximumPreflightAttempts ||
      ageMs >= this.maximumPreflightAgeMs;
    await this.taskLedger.updateTask(current.id, {
      ...current,
      status: 'pending',
      lastPreflightAttemptAt: new Date().toISOString(),
      message: isFeishuRequestRateLimit(error)
        ? delayed
          ? '飞书请求持续限流，已保留原编号等待后台恢复；请勿重复提交'
          : `飞书请求限流，正在按原编号后台重试（${attemptCount}/${this.maximumPreflightAttempts}）`
        : delayed
          ? '出库申请外部查询持续超时，已保留原编号等待后台恢复；请勿重复提交'
          : `出库申请写入前同步暂不可用，正在后台重试（${attemptCount}/${this.maximumPreflightAttempts}）`,
    });
    await this.abandonPendingClaim(current.id);
    this.logger.error(
      `出库任务写入前查重暂不可用，保留原编号等待重试: task=${current.id}, attempts=${attemptCount}, ageMs=${ageMs}, message=${safeErrorMessage(error)}`,
    );
  }

  private async abandonPendingClaim(taskId: string): Promise<void> {
    try {
      await this.taskLedger.abandonPendingClaim(taskId);
    } catch (error) {
      this.logger.error(
        `出库 pending claim 释放失败: task=${taskId}, message=${safeErrorMessage(error)}`,
      );
    }
  }

  private async reconcileUncertainTask(
    entry: InventoryOutboundTaskLedgerEntry,
  ): Promise<InventoryOutboundTaskLedgerEntry> {
    const claimed = await this.taskLedger.claimUncertain(entry.task.id);
    if (!claimed.claimed) return claimed.entry;
    let leaseFailure: unknown;
    let renewalInFlight: Promise<void> | null = null;
    const renewLease = () => {
      if (renewalInFlight) return;
      renewalInFlight = this.taskLedger
        .renewClaim(entry.task.id)
        .then(() => {
          leaseFailure = undefined;
        })
        .catch((error) => {
          leaseFailure = error;
        })
        .finally(() => {
          renewalInFlight = null;
        });
    };
    let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(
      renewLease,
      this.taskLedger.getLeaseHeartbeatIntervalMs(),
    );
    this.activeTaskHeartbeatTimers.set(entry.task.id, heartbeatTimer);
    heartbeatTimer.unref?.();
    const stopHeartbeat = async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        this.activeTaskHeartbeatTimers.delete(entry.task.id);
        heartbeatTimer = null;
      }
      if (renewalInFlight) await renewalInFlight;
    };
    const assertLeaseOwnership = async () => {
      if (renewalInFlight) await renewalInFlight;
      if (leaseFailure !== undefined) throw leaseFailure;
      try {
        await this.taskLedger.renewClaim(entry.task.id);
        leaseFailure = undefined;
      } catch (error) {
        leaseFailure = error;
        throw error;
      }
    };
    const completeReconciliation = async (
      result: InventoryOutboundMovementCreateResponse,
    ) => {
      await stopHeartbeat();
      await assertLeaseOwnership();
      return this.taskLedger.reconcileUncertain(entry.task.id, result);
    };
    try {
      return await this.reconcileClaimedUncertainTask(
        claimed.entry,
        assertLeaseOwnership,
        completeReconciliation,
      );
    } finally {
      await stopHeartbeat();
      await this.abandonUncertainClaim(entry.task.id);
    }
  }

  private async reconcileClaimedUncertainTask(
    entry: InventoryOutboundTaskLedgerEntry,
    assertLeaseOwnership: () => Promise<void>,
    completeReconciliation: (
      result: InventoryOutboundMovementCreateResponse,
    ) => Promise<InventoryOutboundTaskLedgerEntry>,
  ): Promise<InventoryOutboundTaskLedgerEntry> {
    try {
      const config = await this.resolveConfig();
      const markers = await this.gateway.listRecords({
        appToken: config.appToken,
        tableId: config.outboundTableId,
        tableName: TABLES.outbound.name,
        searchFilter: buildExactTextSearchFilter(
          '出库创建标识',
          entry.clientMutationId,
        ),
      });
      if (markers.length === 0) return entry;
      if (markers.length !== 1) {
        throw new ConflictException('检测到重复出库创建标识记录');
      }
      if (
        fieldText(markers[0].fields, ['出库请求指纹']) !==
        entry.requestFingerprint
      ) {
        throw consistencyConflict('原编号对账记录的请求指纹不一致');
      }
      const recordId = getRecordId(markers[0]);
      const reconcileRecord = () =>
        this.runSerial(this.serialByRecordId, recordId, async () => {
          const persisted = await this.gateway.getRecord(
            config.appToken,
            config.outboundTableId,
            recordId,
            TABLES.outbound.name,
          );
          const option = buildReconciliationOption(persisted, entry.request);
          await assertLeaseOwnership();
          const recovered = await this.recoverPendingApproval(
            persisted,
            entry.request,
            entry.requestFingerprint,
            option,
            true,
          );
          this.managementService?.invalidateCache();
          const result = buildCreateResponse(
            recovered,
            buildReconciliationOption(recovered, entry.request),
            true,
            '出库申请已通过原编号对账确认',
          );
          return completeReconciliation(result);
        });
      return this.operationCoordinator
        ? await this.operationCoordinator.run(
            [`movement:outbound:${recordId}`],
            reconcileRecord,
          )
        : await reconcileRecord();
    } catch (error) {
      this.logger.error(
        `出库任务原编号对账暂未确认: task=${entry.task.id}, message=${safeErrorMessage(error)}`,
      );
      if (!isRetryableReconciliationReadError(error)) throw error;
      return (await this.taskLedger.findByTaskId(entry.task.id)) || entry;
    }
  }

  private async abandonUncertainClaim(taskId: string): Promise<void> {
    try {
      await this.taskLedger.abandonUncertainClaim(taskId);
    } catch (error) {
      this.logger.error(
        `出库 uncertain claim 释放失败: task=${taskId}, message=${safeErrorMessage(error)}`,
      );
    }
  }

  private async recoverPendingApproval(
    record: BitableRecordItem,
    request: InventoryOutboundMovementCreateRequest,
    fingerprint: string,
    option: InventoryMovementOptionItem | undefined,
    displayOnlyOption = false,
  ): Promise<BitableRecordItem> {
    assertCreateRecoveryReadback(record, request, fingerprint, option);
    if (!option) throw consistencyConflict('无法恢复出库物品信息');
    if (requiresPendingApprovalRegistration(record)) {
      const approval = await this.registerPendingApproval(
        record,
        request,
        displayOnlyOption ? undefined : option,
      );
      return {
        ...record,
        fields: {
          ...record.fields,
          出库当前审批人: approval.approvers.map(({ openId, name }) => ({
            id: openId,
            name,
          })),
          物品名称: approval.itemName,
          '规格型号、设备序列号': approval.specification,
          品牌: approval.brand,
          计数单位: approval.unit,
          入库存放位置: approval.location,
        },
      };
    }
    return record;
  }

  private async persistCompletedTask(
    current: InventoryOutboundLedgerTask,
    result: InventoryOutboundMovementCreateResponse,
  ): Promise<void> {
    await this.taskLedger.updateTask(current.id, {
      ...current,
      status: 'completed',
      message: result.message,
      result,
      completedAt: new Date().toISOString(),
    });
  }

  private async persistUncertainTask(
    current: InventoryOutboundLedgerTask,
  ): Promise<void> {
    await this.taskLedger.updateTask(current.id, {
      ...current,
      status: 'uncertain',
      message:
        '外部创建结果暂不确定；系统不会重复创建，将通过原编号对账并按需幂等补齐',
      definitelyNotWritten: false,
      completedAt: new Date().toISOString(),
    });
  }

  private async persistFailedTask(
    current: InventoryOutboundLedgerTask,
    detail: string,
  ): Promise<void> {
    await this.taskLedger.updateTask(current.id, {
      ...current,
      status: 'failed',
      message: detail || '出库申请写入前校验失败',
      definitelyNotWritten: true,
      completedAt: new Date().toISOString(),
    });
  }

  private async confirmLocked(
    config: OutboundConfig,
    record: BitableRecordItem,
    identity: OutboundIdentity,
    confirmationId: string,
    approvedDecision?: ApprovedDecisionContext,
  ): Promise<InventoryOutboundConfirmResponse> {
    const fields = record.fields || {};
    const programStatus = fieldText(fields, ['程序出库状态']);
    const workflowStatus = fieldText(fields, ['出库工作流状态']);
    const persistedConfirmationId = fieldText(fields, ['出库确认标识']);
    const approvalActionId = fieldText(fields, ['出库审批动作标识']);
    if (approvalActionId && approvalActionId !== confirmationId) {
      throw new ConflictException('该出库记录必须使用审批动作标识完成正式出库');
    }
    const legacyOutboundMarker = checked(
      fieldValue(fields, ['是否借出本楼栋']),
    );
    const hasProgramApplicationField = hasOwnField(
      fields,
      PROGRAM_OUTBOUND_APPLICATION_FIELDS,
    );
    if (!programStatus && legacyOutboundMarker && hasProgramApplicationField) {
      throw consistencyConflict('旧出库记录混入程序申请字段');
    }
    const legacyPending =
      !programStatus && legacyOutboundMarker && !hasProgramApplicationField;
    const legacyConfirmed =
      programStatus === CONFIRMED_STATUS &&
      legacyOutboundMarker &&
      !hasProgramApplicationField;

    if (programStatus === CONFIRMED_STATUS) {
      if (!legacyConfirmed && workflowStatus !== APPROVED_WORKFLOW_STATUS) {
        throw new ConflictException('该出库记录尚未通过审批');
      }
      if (persistedConfirmationId !== confirmationId) {
        throw new ConflictException('该出库记录已由其它确认请求处理');
      }
      assertConfirmedApplicationConsistency(record, identity);
      if (approvedDecision) {
        assertApprovedDecisionMatchesRecord(record, approvedDecision);
      }
      const snapshot = await this.loadCoreSnapshot(config, identity);
      const option = findIdentityOption(snapshot, identity, true);
      const response = buildConfirmResponse(
        record,
        option,
        true,
        '出库记录已确认',
      );
      this.managementService?.invalidateCache();
      return response;
    }
    const pendingCardApproval =
      Boolean(approvedDecision) &&
      programStatus === APPROVAL_PENDING_STATUS &&
      workflowStatus === APPROVAL_PENDING_STATUS;
    if (approvedDecision) {
      assertApprovedDecisionMatchesRecord(record, approvedDecision);
      if (!pendingCardApproval && programStatus !== PENDING_STATUS) {
        throw new ConflictException('该出库记录状态不允许审批并确认');
      }
    } else {
      if (programStatus && programStatus !== PENDING_STATUS) {
        throw new ConflictException('该出库记录状态不允许确认');
      }
      if (!programStatus && !legacyPending) {
        throw new ConflictException('该出库记录不是待确认申请');
      }
    }
    if (persistedConfirmationId) {
      throw new ConflictException('出库确认标识与记录状态不一致');
    }
    if (
      !legacyPending &&
      !pendingCardApproval &&
      workflowStatus !== APPROVED_WORKFLOW_STATUS
    ) {
      throw new ConflictException('该出库记录尚未通过审批');
    }

    let updateFields: Record<string, unknown>;
    let option: InventoryMovementOptionItem;
    let expectedQuantity: number | null = null;
    let expectedTime: number | null = null;
    if (legacyPending) {
      const snapshot = await this.loadCoreSnapshot(config, identity);
      option = findIdentityOption(snapshot, identity, true);
      updateFields = {
        程序出库状态: CONFIRMED_STATUS,
        出库确认标识: confirmationId,
      };
    } else {
      const pendingRequest = buildPendingRequest(record, identity);
      assertPendingApplicationFingerprint(record, pendingRequest);
      const snapshot = await this.loadCoreSnapshot(config, pendingRequest);
      const availableOption = findOption(snapshot, pendingRequest, true);
      if (!availableOption) {
        throw new BadRequestException('请选择有效物品');
      }
      if (availableOption.stockConsistencyError) {
        throw new ConflictException(availableOption.stockConsistencyError);
      }
      if (pendingRequest.quantity > availableOption.availableQuantity) {
        throw new ConflictException('实时库存已变化，当前库存不足以确认出库');
      }
      validateMovementCreateRequest(pendingRequest, availableOption);
      option = availableOption;
      expectedQuantity = pendingRequest.quantity;
      expectedTime = Date.parse(pendingRequest.occurredAt);
      updateFields = {
        出库数量: expectedQuantity,
        出库时间: expectedTime,
        程序出库状态: CONFIRMED_STATUS,
        出库确认标识: confirmationId,
      };
    }
    if (approvedDecision) {
      Object.assign(updateFields, approvedDecisionFields(approvedDecision));
    }

    await this.gateway.updateRecord(
      config.appToken,
      config.outboundTableId,
      getRecordId(record),
      updateFields,
      TABLES.outbound.name,
    );
    this.managementService?.invalidateCache();
    const persisted = await this.gateway.getRecord(
      config.appToken,
      config.outboundTableId,
      getRecordId(record),
      TABLES.outbound.name,
    );
    assertConfirmedReadback(
      persisted,
      confirmationId,
      expectedQuantity,
      expectedTime,
    );
    if (approvedDecision) {
      assertApprovedDecisionMatchesRecord(persisted, approvedDecision);
    }
    return buildConfirmResponse(persisted, option, false, '出库确认成功');
  }

  private async getOutboundRecordOrThrow(
    config: OutboundConfig,
    recordId: string,
  ): Promise<BitableRecordItem> {
    try {
      return await this.gateway.getRecord(
        config.appToken,
        config.outboundTableId,
        recordId,
        TABLES.outbound.name,
      );
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordNotFoundError) {
        throw new NotFoundException('出库记录不存在');
      }
      throw error;
    }
  }

  private async assertProfessionalCatalog(principal: AccessPrincipal | undefined, request: InventoryOutboundMovementCreateRequest): Promise<void> {
    if (!isProfessionalBusinessPrincipal(principal)) return;
    const config = await this.resolveConfig();
    const record = await this.gateway.getRecord(config.appToken, config.catalogTableId, clean(request.catalogRecordId), TABLES.catalog.name);
    assertProfessionalBitableRecord(principal, record);
  }

  private async resolveRecordIdentity(
    config: OutboundConfig,
    record: BitableRecordItem,
  ): Promise<OutboundIdentity> {
    const building = requireBuilding(record.fields);
    const catalogRecordId = linkedRecordId(
      fieldValue(record.fields, ['物品类别号']),
    );
    if (!catalogRecordId) {
      const sku = normalizeSku(fieldText(record.fields, ['物品类别号']));
      if (!sku) throw consistencyConflict('出库记录缺少物品类别号');
      return { building, catalogRecordId: '', sku };
    }
    let catalogRecord: BitableRecordItem;
    try {
      catalogRecord = await this.gateway.getRecord(
        config.appToken,
        config.catalogTableId,
        catalogRecordId,
        TABLES.catalog.name,
      );
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordNotFoundError) {
        throw consistencyConflict('关联物品类别不存在');
      }
      throw error;
    }
    const sku = normalizeSku(
      fieldText(catalogRecord.fields, ['物品类别号', '物品类别号（单选）']),
    );
    if (!sku) throw consistencyConflict('关联物品类别缺少类别号');
    const catalogBuilding = fieldBuilding(catalogRecord.fields, ['楼栋']);
    if (catalogBuilding && catalogBuilding !== building) {
      throw consistencyConflict('关联物品类别不属于出库楼栋');
    }
    return { building, catalogRecordId, sku, catalogRecord };
  }

  private async loadCoreSnapshot(
    config: OutboundConfig,
    identity: Pick<
      OutboundIdentity,
      'building' | 'catalogRecordId' | 'sku' | 'catalogRecord'
    >,
  ): Promise<CoreSnapshot> {
    const sku = normalizeSku(identity.sku);
    if (!sku) throw new BadRequestException('请选择有效物品');
    const cachedCatalogRecord =
      identity.catalogRecord &&
      (identity.catalogRecord.record_id || identity.catalogRecord.id) ===
        identity.catalogRecordId
        ? identity.catalogRecord
        : null;
    const catalogPromise = cachedCatalogRecord
      ? Promise.resolve([cachedCatalogRecord])
      : identity.catalogRecordId
        ? this.gateway
            .getRecord(
              config.appToken,
              config.catalogTableId,
              identity.catalogRecordId,
              TABLES.catalog.name,
            )
            .then((record) => [record])
            .catch((error) => {
              if (error instanceof InventoryWorkflowRecordNotFoundError)
                return [];
              throw error;
            })
        : this.gateway.listRecords({
            appToken: config.appToken,
            tableId: config.catalogTableId,
            tableName: TABLES.catalog.name,
            searchFilter: buildExactTextSearchFilter('物品类别号', sku),
          });
    const [catalog, inventory] = await Promise.all([
      catalogPromise,
      this.gateway.listRecords({
        appToken: config.appToken,
        tableId: config.inventoryTableId,
        tableName: TABLES.inventory.name,
        searchFilter: buildExactTextSearchFilter('楼栋', identity.building),
      }),
    ]);
    return { catalog, inventory };
  }

  private async ensureCreationMarkerField(
    config: OutboundConfig,
  ): Promise<void> {
    await this.gateway.ensureTextField(
      config.appToken,
      config.outboundTableId,
      '出库创建标识',
      TABLES.outbound.name,
    );
  }

  private async ensureFields(
    config: OutboundConfig,
    creationMarkerAlreadyEnsured = false,
  ): Promise<void> {
    const preparations = [
      this.gateway.ensureTextField(
        config.appToken,
        config.outboundTableId,
        '程序出库状态',
        TABLES.outbound.name,
      ),
      this.gateway.ensureTextField(
        config.appToken,
        config.outboundTableId,
        '程序出库申请时间',
        TABLES.outbound.name,
      ),
      this.gateway.ensureTextField(
        config.appToken,
        config.outboundTableId,
        '出库请求指纹',
        TABLES.outbound.name,
      ),
      this.gateway.ensureTextField(
        config.appToken,
        config.outboundTableId,
        '出库确认标识',
        TABLES.outbound.name,
      ),
      this.gateway.ensureNumberField(
        config.appToken,
        config.outboundTableId,
        '程序出库申请数量',
        TABLES.outbound.name,
      ),
    ];
    if (!creationMarkerAlreadyEnsured) {
      preparations.push(this.ensureCreationMarkerField(config));
    }
    await Promise.all(preparations);
  }

  private async resolveConfig(): Promise<OutboundConfig> {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_WAREHOUSE_SOURCE_URL'),
    );
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || source.appToken,
      wikiToken: source.wikiToken,
      tableName: '南通运维全景驾驶舱-库房管理',
    });
    const inventoryTableId = readEnv(TABLES.inventory.env);
    const catalogTableId = readEnv(TABLES.catalog.env);
    const outboundTableId = readEnv(TABLES.outbound.env);
    if (!inventoryTableId) throw new Error(`${TABLES.inventory.name}未配置`);
    if (!catalogTableId) throw new Error(`${TABLES.catalog.name}未配置`);
    if (!outboundTableId) throw new Error(`${TABLES.outbound.name}未配置`);
    return { appToken, inventoryTableId, catalogTableId, outboundTableId };
  }

  private runSerial<T>(
    serialMap: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const normalizedKey = key.trim().toUpperCase();
    const previous = serialMap.get(normalizedKey) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    serialMap.set(normalizedKey, tail);
    void tail.finally(() => {
      if (serialMap.get(normalizedKey) === tail) {
        serialMap.delete(normalizedKey);
      }
    });
    return current;
  }
}

function normalizeOutboundRequest(
  request: InventoryOutboundMovementCreateRequest,
): InventoryOutboundMovementCreateRequest {
  if (request?.type !== 'outbound') {
    throw new BadRequestException('未知库存业务类型');
  }
  try {
    assertInventoryOutboundCanonicalRequest(request);
  } catch {
    throw new BadRequestException('出库申请字段格式、长度或字节数无效');
  }
  const clientMutationId = clean(request.clientMutationId);
  if (!clientMutationId) {
    throw new BadRequestException('请求标识不能为空');
  }
  const building = parseBuilding(request.building);
  const occurredAtText = clean(request.occurredAt);
  if (!ISO_DATE_TIME_PATTERN.test(occurredAtText)) {
    throw new BadRequestException('请选择有效业务时间');
  }
  const occurredAt = Date.parse(occurredAtText);
  if (!Number.isFinite(occurredAt)) {
    throw new BadRequestException('请选择有效业务时间');
  }
  const normalizedRequest: InventoryOutboundMovementCreateRequest = {
    type: 'outbound',
    clientMutationId,
    catalogRecordId: clean(request.catalogRecordId),
    sku: normalizeSku(request.sku),
    building,
    quantity: request.quantity,
    occurredAt: new Date(occurredAt).toISOString(),
    applicantOpenId: clean(request.applicantOpenId),
    reason: clean(request.reason),
  };
  try {
    assertInventoryOutboundCanonicalRequest(normalizedRequest);
  } catch {
    throw new BadRequestException('出库申请字段格式、长度或字节数无效');
  }
  return normalizedRequest;
}

function assertNoLegacyOutboundFields(
  request: InventoryOutboundMovementCreateRequest,
): void {
  if (
    Object.prototype.hasOwnProperty.call(
      request as unknown as Record<string, unknown>,
      'destinationBuilding',
    )
  ) {
    throw new BadRequestException('出库申请不允许包含去向楼栋');
  }
}

function findOption(
  snapshot: CoreSnapshot,
  request: InventoryOutboundMovementCreateRequest,
  includeUnavailable: boolean,
): InventoryMovementOptionItem | undefined {
  return buildMovementOptions({
    catalog: snapshot.catalog,
    inventory: snapshot.inventory,
    type: includeUnavailable ? 'inbound' : 'outbound',
    building: request.building,
    query: request.sku,
    limit: 100,
  }).find(
    (item) =>
      item.catalogRecordId === request.catalogRecordId &&
      normalizeSku(item.sku) === normalizeSku(request.sku),
  );
}

function findIdentityOption(
  snapshot: CoreSnapshot,
  identity: OutboundIdentity,
  includeUnavailable: boolean,
): InventoryMovementOptionItem {
  const option = buildMovementOptions({
    catalog: snapshot.catalog,
    inventory: snapshot.inventory,
    type: includeUnavailable ? 'inbound' : 'outbound',
    building: identity.building,
    query: identity.sku,
    limit: 100,
  }).find(
    (item) =>
      (!identity.catalogRecordId ||
        item.catalogRecordId === identity.catalogRecordId) &&
      normalizeSku(item.sku) === identity.sku,
  );
  if (!option) throw new BadRequestException('请选择有效物品');
  return option;
}

function buildPendingRequest(
  record: BitableRecordItem,
  identity: OutboundIdentity,
): InventoryOutboundMovementCreateRequest {
  const fields = record.fields || {};
  const quantity = fieldOptionalNumber(fields, ['程序出库申请数量']);
  if (quantity === null) throw consistencyConflict('程序出库申请数量缺失');
  const occurredAt = fieldDateIso(fields, ['程序出库申请时间']);
  if (!occurredAt) throw consistencyConflict('程序出库申请时间缺失或无效');
  const clientMutationId = fieldText(fields, ['出库创建标识']);
  if (!clientMutationId) throw consistencyConflict('出库创建标识缺失');
  if (!fieldText(fields, ['出库请求指纹'])) {
    throw consistencyConflict('出库请求指纹缺失');
  }
  return normalizeOutboundRequest({
    type: 'outbound',
    clientMutationId,
    catalogRecordId: identity.catalogRecordId,
    sku: identity.sku,
    building: identity.building,
    quantity,
    occurredAt,
    applicantOpenId: fieldPersonOpenId(fields, ['物品申请人']),
    reason: fieldText(fields, ['出库原因/出库后使用地点']),
  });
}

function buildApprovalSnapshot(
  record: BitableRecordItem,
  request: InventoryOutboundMovementCreateRequest,
  option: InventoryMovementOptionItem,
  approvers: InventoryOutboundApprovalApprover[],
  managerRecipients: InventoryOutboundApprovalApprover[],
): InventoryOutboundApprovalSnapshot {
  return {
    recordId: getRecordId(record),
    outboundNumber: request.clientMutationId,
    version: 1,
    policyVersion: OUTBOUND_APPROVAL_POLICY_VERSION,
    applicantOpenId: request.applicantOpenId,
    applicantName: fieldPersonName(record.fields, ['物品申请人']),
    itemName: option.name,
    sku: option.sku,
    specification: option.specification,
    brand: option.brand,
    quantity: request.quantity,
    unit: option.unit,
    availableStock: option.availableQuantity,
    building: request.building,
    location: option.location,
    reason: request.reason,
    appliedAt: new Date(request.occurredAt).toISOString(),
    approvers: approvers.map((approver) => ({ ...approver })),
    managerRecipients: managerRecipients.map((manager) => ({ ...manager })),
  };
}

function buildCreateResponse(
  record: BitableRecordItem,
  option: InventoryMovementOptionItem | undefined,
  alreadyProcessed: boolean,
  message: string,
  approvers?: InventoryOutboundApprovalApprover[],
): InventoryOutboundMovementCreateResponse {
  if (!option) throw consistencyConflict('无法恢复出库物品信息');
  const movement = mapOutboundMovement(record, option);
  return {
    success: true,
    recordId: getRecordId(record),
    type: 'outbound',
    alreadyProcessed,
    message,
    movement: approvers?.length
      ? { ...movement, operator: approvers.map((item) => item.name).join('、') }
      : movement,
  };
}

function buildReconciliationOption(
  record: BitableRecordItem,
  request: InventoryOutboundMovementCreateRequest,
): InventoryMovementOptionItem {
  const fields = record.fields || {};
  return {
    catalogRecordId: request.catalogRecordId,
    inventoryRecordId: '',
    sku: request.sku,
    name: fieldText(fields, ['物品名称', '名称']) || request.sku,
    specification: fieldText(fields, ['规格型号、设备序列号', '规格型号']),
    brand: fieldText(fields, ['品牌']),
    primaryCategory: fieldText(fields, ['一级分类']),
    secondaryCategory: fieldText(fields, ['二级分类']),
    building: request.building,
    location: firstNonEmptyFieldText(
      fields,
      getWarehouseInventoryLocationReadFieldNames(),
    ),
    unit: fieldText(fields, ['计数单位', '单位']),
    availableQuantity: 0,
  };
}

function assertPendingApplicationFingerprint(
  record: BitableRecordItem,
  request: InventoryOutboundMovementCreateRequest,
): void {
  const persistedFingerprint = fieldText(record.fields, ['出库请求指纹']);
  if (
    !persistedFingerprint ||
    buildOutboundFingerprint(request) !== persistedFingerprint
  ) {
    throw consistencyConflict('出库请求指纹与持久申请字段不一致');
  }
}

function buildConfirmResponse(
  record: BitableRecordItem,
  option: InventoryMovementOptionItem,
  alreadyConfirmed: boolean,
  message: string,
): InventoryOutboundConfirmResponse {
  return {
    success: true,
    recordId: getRecordId(record),
    alreadyConfirmed,
    message,
    movement: mapOutboundMovement(record, option),
  };
}

function mapOutboundMovement(
  record: BitableRecordItem,
  option: InventoryMovementOptionItem,
): InventoryOutboundMovementItem {
  const fields = record.fields || {};
  const programStatus = fieldText(fields, ['程序出库状态']);
  const clientMutationId = fieldText(fields, ['出库创建标识']);
  const legacyRecord =
    !clientMutationId && checked(fieldValue(fields, ['是否借出本楼栋']));
  const status = isInventoryOutboundStatus(programStatus)
    ? programStatus
    : !programStatus && legacyRecord
      ? PENDING_STATUS
      : null;
  if (!status) throw consistencyConflict('程序出库状态缺失或无效');
  const pendingQuantity = fieldOptionalNumber(fields, ['程序出库申请数量']);
  const formalQuantity = fieldOptionalNumber(fields, ['出库数量']);
  const pendingTime = fieldDateIso(fields, ['程序出库申请时间']);
  const formalTime = fieldDateIso(fields, ['出库时间']);
  const quantity = legacyRecord
    ? requireMovementNumber(formalQuantity, '旧出库数量')
    : status !== CONFIRMED_STATUS
      ? requireMovementNumber(pendingQuantity, '程序出库申请数量')
      : requireMovementNumber(formalQuantity, '出库数量');
  const occurredAt = legacyRecord
    ? requireMovementDate(formalTime, '旧出库时间')
    : status !== CONFIRMED_STATUS
      ? requireMovementDate(pendingTime, '程序出库申请时间')
      : requireMovementDate(formalTime, '出库时间');
  return {
    recordId: getRecordId(record),
    ...(clientMutationId ? { clientMutationId } : {}),
    type: 'outbound',
    sku: option.sku,
    name: option.name,
    specification: option.specification,
    quantity,
    unit: option.unit,
    building: fieldBuilding(fields, ['楼栋']) || option.building,
    destinationBuilding: '',
    location: option.location,
    reason: fieldText(fields, ['出库原因/出库后使用地点']),
    approvalRejectionReason: fieldText(fields, ['出库驳回原因']),
    operator: fieldText(
      fields,
      status === APPROVAL_PENDING_STATUS
        ? ['出库当前审批人', '经办人']
        : ['经办人'],
    ),
    applicant: fieldText(fields, ['物品申请人']),
    status,
    occurredAt,
    expectedReturnAt: null,
    overdue: false,
  };
}

function isInventoryOutboundStatus(
  value: string,
): value is InventoryOutboundStatus {
  return [
    ROUTING_STATUS,
    APPROVAL_PENDING_STATUS,
    PENDING_STATUS,
    REJECTED_STATUS,
    CONFIRMED_STATUS,
  ].includes(value as InventoryOutboundStatus);
}

function requireMovementNumber(value: number | null, label: string): number {
  if (value === null) throw consistencyConflict(`${label}缺失或无效`);
  return value;
}

function requireMovementDate(value: string | null, label: string): string {
  if (!value) throw consistencyConflict(`${label}缺失或无效`);
  return value;
}

function assertRecoverableCreateRecord(
  record: BitableRecordItem,
  request: InventoryOutboundMovementCreateRequest,
  fingerprint: string,
  option: InventoryMovementOptionItem | undefined,
): void {
  const persistedMutationId = fieldText(record.fields, ['出库创建标识']);
  const persistedFingerprint = fieldText(record.fields, ['出库请求指纹']);
  const persistedQuantity = fieldOptionalNumber(record.fields, [
    '程序出库申请数量',
  ]);
  const persistedFormalQuantity = fieldOptionalNumber(record.fields, [
    '出库数量',
  ]);
  const persistedOccurredAt = fieldDateIso(record.fields, ['程序出库申请时间']);
  const persistedBuilding = requireBuilding(record.fields);
  const persistedCatalogRecordId = linkedRecordId(
    fieldValue(record.fields, ['物品类别号']),
  );
  const persistedApplicantOpenId = fieldPersonOpenId(record.fields, [
    '物品申请人',
  ]);
  const persistedReason = fieldText(record.fields, ['出库原因/出库后使用地点']);

  if (persistedMutationId !== request.clientMutationId) {
    throw consistencyConflict('出库创建标识与请求不一致');
  }
  if (persistedFingerprint !== fingerprint) {
    throw consistencyConflict('出库请求指纹与请求不一致');
  }
  const status = fieldText(record.fields, ['程序出库状态']);
  const workflowStatus = fieldText(record.fields, ['出库工作流状态']);
  if (!isInventoryOutboundStatus(status)) {
    throw consistencyConflict('程序出库状态缺失或无效');
  }
  const confirmationId = fieldText(record.fields, ['出库确认标识']);
  if (status !== CONFIRMED_STATUS) {
    if (confirmationId) {
      throw consistencyConflict('未出库申请不应包含出库确认标识');
    }
  } else {
    if (!confirmationId) {
      throw consistencyConflict('已出库记录缺少出库确认标识');
    }
  }
  if (persistedQuantity !== request.quantity) {
    throw consistencyConflict('程序出库申请数量与请求不一致');
  }
  if (status === CONFIRMED_STATUS) {
    if (persistedFormalQuantity !== request.quantity) {
      throw consistencyConflict('出库数量与程序申请数量不一致');
    }
  } else if (persistedFormalQuantity !== null) {
    throw consistencyConflict('审批完成前不应写入正式出库数量');
  }
  assertWorkflowStatusMatchesProgramStatus(status, workflowStatus);
  if (persistedOccurredAt !== new Date(request.occurredAt).toISOString()) {
    throw consistencyConflict('程序出库申请时间与请求不一致');
  }
  if (persistedBuilding !== request.building) {
    throw consistencyConflict('出库楼栋与请求不一致');
  }
  if (persistedCatalogRecordId !== request.catalogRecordId) {
    throw consistencyConflict('出库物品关联与请求不一致');
  }
  if (persistedApplicantOpenId !== request.applicantOpenId) {
    throw consistencyConflict('物品申请人与请求不一致');
  }
  if (persistedReason !== request.reason) {
    throw consistencyConflict('出库原因与请求不一致');
  }
  if (!option) throw consistencyConflict('无法恢复出库物品信息');
  const recalculatedFingerprint = buildOutboundFingerprint({
    type: 'outbound',
    clientMutationId: persistedMutationId,
    catalogRecordId: persistedCatalogRecordId,
    sku: option.sku,
    building: persistedBuilding,
    quantity: persistedQuantity,
    occurredAt: persistedOccurredAt,
    applicantOpenId: persistedApplicantOpenId,
    reason: persistedReason,
  });
  if (recalculatedFingerprint !== persistedFingerprint) {
    throw consistencyConflict('出库请求指纹与持久字段不一致');
  }
  if (status === CONFIRMED_STATUS) {
    assertConfirmedApplicationConsistency(record, {
      building: persistedBuilding,
      catalogRecordId: persistedCatalogRecordId,
      sku: normalizeSku(option.sku),
    });
  }
}

function assertCreateRecoveryReadback(
  record: BitableRecordItem,
  request: InventoryOutboundMovementCreateRequest,
  fingerprint: string,
  option: InventoryMovementOptionItem | undefined,
): void {
  assertRecoverableCreateRecord(record, request, fingerprint, option);
  if (
    fieldText(record.fields, ['程序出库状态']) === APPROVAL_PENDING_STATUS &&
    fieldText(record.fields, ['出库工作流状态']) === ROUTING_STATUS
  ) {
    if (!option) throw consistencyConflict('无法恢复出库物品信息');
    assertRoutingReadback(record, request, fingerprint, option);
  }
}

function assertRoutingReadback(
  record: BitableRecordItem,
  request: InventoryOutboundMovementCreateRequest,
  fingerprint: string,
  option: InventoryMovementOptionItem,
): void {
  assertRecoverableCreateRecord(record, request, fingerprint, option);
  if (fieldText(record.fields, ['程序出库状态']) !== APPROVAL_PENDING_STATUS) {
    throw consistencyConflict('程序待审批状态未持久化');
  }
  if (fieldText(record.fields, ['出库工作流状态']) !== ROUTING_STATUS) {
    throw consistencyConflict('出库待路由状态未持久化');
  }
  if (
    fieldOptionalNumber(record.fields, ['程序出库申请数量']) !==
    request.quantity
  ) {
    throw consistencyConflict('程序出库申请数量未持久化');
  }
  if (fieldOptionalNumber(record.fields, ['出库数量']) !== null) {
    throw consistencyConflict('审批前不应写入正式出库数量');
  }
  if (
    fieldDateIso(record.fields, ['程序出库申请时间']) !==
    new Date(request.occurredAt).toISOString()
  ) {
    throw consistencyConflict('程序出库申请时间未持久化');
  }
  if (requireBuilding(record.fields) !== request.building) {
    throw consistencyConflict('出库楼栋未持久化');
  }
  if (
    linkedRecordId(fieldValue(record.fields, ['物品类别号'])) !==
    request.catalogRecordId
  ) {
    throw consistencyConflict('出库物品关联未持久化');
  }
}

function assertWorkflowStatusMatchesProgramStatus(
  programStatus: InventoryOutboundStatus,
  workflowStatus: string,
): void {
  const valid =
    (programStatus === ROUTING_STATUS && workflowStatus === ROUTING_STATUS) ||
    (programStatus === APPROVAL_PENDING_STATUS &&
      (workflowStatus === ROUTING_STATUS ||
        workflowStatus === APPROVAL_PENDING_STATUS)) ||
    (programStatus === PENDING_STATUS &&
      workflowStatus === APPROVED_WORKFLOW_STATUS) ||
    (programStatus === REJECTED_STATUS &&
      workflowStatus === REJECTED_WORKFLOW_STATUS) ||
    (programStatus === CONFIRMED_STATUS &&
      workflowStatus === APPROVED_WORKFLOW_STATUS);
  if (!valid) {
    const detail = workflowStatus || '空';
    throw consistencyConflict(
      `程序出库状态与工作流状态不一致：${programStatus}/${detail}`,
    );
  }
}

function requiresPendingApprovalRegistration(
  record: BitableRecordItem,
): boolean {
  const programStatus = fieldText(record.fields, ['程序出库状态']);
  const workflowStatus = fieldText(record.fields, ['出库工作流状态']);
  return (
    (programStatus === ROUTING_STATUS && workflowStatus === ROUTING_STATUS) ||
    (programStatus === APPROVAL_PENDING_STATUS &&
      (workflowStatus === ROUTING_STATUS ||
        workflowStatus === APPROVAL_PENDING_STATUS))
  );
}

function assertConfirmedApplicationConsistency(
  record: BitableRecordItem,
  identity: OutboundIdentity,
): void {
  const fields = record.fields || {};
  const presentFields = PROGRAM_OUTBOUND_APPLICATION_FIELDS.filter(
    (fieldName) => Object.prototype.hasOwnProperty.call(fields, fieldName),
  );
  if (presentFields.length === 0) {
    if (!checked(fieldValue(fields, ['是否借出本楼栋']))) {
      throw consistencyConflict('已确认记录缺少程序申请字段且非旧跨楼记录');
    }
    return;
  }
  if (presentFields.length !== PROGRAM_OUTBOUND_APPLICATION_FIELDS.length) {
    throw consistencyConflict('程序出库申请字段不完整');
  }
  const applicationQuantity = fieldOptionalNumber(fields, ['程序出库申请数量']);
  const formalQuantity = fieldOptionalNumber(fields, ['出库数量']);
  if (
    applicationQuantity === null ||
    formalQuantity === null ||
    applicationQuantity !== formalQuantity
  ) {
    throw consistencyConflict('正式出库数量与程序申请数量不一致');
  }
  const applicationTime = fieldDateIso(fields, ['程序出库申请时间']);
  const formalTime = fieldDateIso(fields, ['出库时间']);
  if (!applicationTime || !formalTime || applicationTime !== formalTime) {
    throw consistencyConflict('正式出库时间与程序申请时间不一致');
  }
  const persistedMutationId = fieldText(fields, ['出库创建标识']);
  const persistedFingerprint = fieldText(fields, ['出库请求指纹']);
  const recalculatedFingerprint = buildOutboundFingerprint({
    type: 'outbound',
    clientMutationId: persistedMutationId,
    catalogRecordId: identity.catalogRecordId,
    sku: identity.sku,
    building: identity.building,
    quantity: applicationQuantity,
    occurredAt: applicationTime,
    applicantOpenId: fieldPersonOpenId(fields, ['物品申请人']),
    reason: fieldText(fields, ['出库原因/出库后使用地点']),
  });
  if (
    !persistedMutationId ||
    recalculatedFingerprint !== persistedFingerprint
  ) {
    throw consistencyConflict('出库请求指纹与持久申请字段不一致');
  }
}

function assertConfirmedReadback(
  record: BitableRecordItem,
  confirmationId: string,
  expectedQuantity: number | null,
  expectedTime: number | null,
): void {
  if (fieldText(record.fields, ['程序出库状态']) !== CONFIRMED_STATUS) {
    throw consistencyConflict('程序出库状态未确认');
  }
  if (fieldText(record.fields, ['出库确认标识']) !== confirmationId) {
    throw consistencyConflict('出库确认标识未持久化');
  }
  if (
    expectedQuantity !== null &&
    fieldOptionalNumber(record.fields, ['出库数量']) !== expectedQuantity
  ) {
    throw consistencyConflict('出库数量未持久化');
  }
  if (
    expectedTime !== null &&
    fieldOptionalNumber(record.fields, ['出库时间']) !== expectedTime
  ) {
    throw consistencyConflict('出库时间未持久化');
  }
}

function approvedDecisionFields(
  context: ApprovedDecisionContext,
): Record<string, unknown> {
  const decidedAt = Date.parse(context.decision.decidedAt);
  if (!Number.isFinite(decidedAt)) {
    throw consistencyConflict('出库审批时间无效');
  }
  return {
    出库工作流状态: APPROVED_WORKFLOW_STATUS,
    出库当前审批人: [],
    出库实际审批人: [
      {
        id: context.decision.actorOpenId,
        name: context.decision.actorName,
      },
    ],
    出库审批时间: decidedAt,
    出库审批策略版本: context.snapshot.policyVersion,
    出库审批动作标识: context.decision.eventId,
    出库驳回原因: '',
    出库工作流错误: '',
  };
}

function assertApprovedDecisionMatchesRecord(
  record: BitableRecordItem,
  context: ApprovedDecisionContext,
): void {
  const rawSnapshot = fieldText(record.fields, ['出库审批快照']);
  let persistedSnapshot: InventoryOutboundApprovalSnapshot | undefined;
  try {
    const parsed = JSON.parse(rawSnapshot) as {
      snapshot?: InventoryOutboundApprovalSnapshot;
    };
    persistedSnapshot = parsed.snapshot;
  } catch {
    throw consistencyConflict('出库审批快照无效');
  }
  if (
    !persistedSnapshot ||
    persistedSnapshot.recordId !== context.snapshot.recordId ||
    persistedSnapshot.version !== context.snapshot.version ||
    persistedSnapshot.policyVersion !== context.snapshot.policyVersion ||
    !persistedSnapshot.approvers.some(
      (approver) => approver.openId === context.decision.actorOpenId,
    )
  ) {
    throw consistencyConflict('出库审批决定与持久快照不一致');
  }
  if (fieldText(record.fields, ['程序出库状态']) !== CONFIRMED_STATUS) return;
  if (
    fieldText(record.fields, ['出库审批动作标识']) !==
      context.decision.eventId ||
    fieldPersonOpenId(record.fields, ['出库实际审批人']) !==
      context.decision.actorOpenId ||
    fieldText(record.fields, ['出库工作流状态']) !== APPROVED_WORKFLOW_STATUS
  ) {
    throw consistencyConflict('正式出库审批证据未持久化');
  }
}

function authorizeBuildingScope(
  principal: AccessPrincipal | undefined,
  building: WarehouseBuilding,
): void {
  if (principal?.role !== 'inventory_admin') return;
  if (!canAccessBuilding(principal, building)) {
    throw new ForbiddenException('无权访问或操作该楼栋库存数据');
  }
}

function authorizeConfirmRole(principal: AccessPrincipal | undefined): void {
  if (
    !principal ||
    (principal.role !== 'admin' && principal.role !== 'inventory_admin' && !isProfessionalBusinessPrincipal(principal))
  ) {
    throw new ForbiddenException('无权确认出库记录');
  }
}

function sameIdentity(
  initial: OutboundIdentity,
  authoritative: OutboundIdentity,
): boolean {
  return (
    initial.building === authoritative.building &&
    initial.sku === authoritative.sku &&
    initial.catalogRecordId === authoritative.catalogRecordId
  );
}

function buildStockKey(building: WarehouseBuilding, sku: string): string {
  return `${building}|${normalizeSku(sku)}`;
}

function buildExactTextSearchFilter(
  fieldName: string,
  value: string,
): BitableRecordSearchFilter {
  return {
    conjunction: 'and',
    conditions: [{ field_name: fieldName, operator: 'is', value: [value] }],
  };
}

function parseBuilding(value: unknown): WarehouseBuilding {
  const building = clean(value) as WarehouseBuilding;
  if (WAREHOUSE_BUILDINGS.includes(building)) return building;
  throw new BadRequestException('请选择有效楼栋');
}

function requireBuilding(
  fields: Record<string, unknown> | undefined,
): WarehouseBuilding {
  const building = fieldBuilding(fields, ['楼栋']);
  if (!building) throw consistencyConflict('出库记录楼栋缺失或无效');
  return building;
}

function fieldBuilding(
  fields: Record<string, unknown> | undefined,
  names: string[],
): WarehouseBuilding | null {
  const values = displayValues(fieldValue(fields, names));
  return (
    WAREHOUSE_BUILDINGS.find((building) => values.includes(building)) || null
  );
}

function fieldText(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string {
  return displayValues(fieldValue(fields, names)).join('、').trim();
}

function firstNonEmptyFieldText(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string {
  for (const name of names) {
    const value = fieldText(fields, [name]);
    if (value) return value;
  }
  return '';
}

function fieldPersonOpenId(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string {
  const ids = personOpenIds(fieldValue(fields, names));
  return ids.length === 1 ? ids[0] : '';
}

function fieldPersonName(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string {
  const value = fieldValue(fields, names);
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (!entry || typeof entry !== 'object') continue;
    const person = entry as Record<string, unknown>;
    const name = clean(person.name) || clean(person.text);
    if (name) return name;
  }
  return '';
}

function personOpenIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(personOpenIds);
  if (typeof value === 'string') {
    const id = clean(value);
    return id ? [id] : [];
  }
  if (value && typeof value === 'object') {
    const person = value as Record<string, unknown>;
    const id =
      clean(person.open_id) || clean(person.openId) || clean(person.id);
    return id ? [id] : [];
  }
  return [];
}

function fieldValue(
  fields: Record<string, unknown> | undefined,
  names: string[],
): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields || {}, name)) {
      return fields?.[name];
    }
  }
  return undefined;
}

function hasOwnField(
  fields: Record<string, unknown> | undefined,
  names: readonly string[],
): boolean {
  return names.some((name) =>
    Object.prototype.hasOwnProperty.call(fields || {}, name),
  );
}

function fieldOptionalNumber(
  fields: Record<string, unknown> | undefined,
  names: string[],
): number | null {
  const value = fieldValue(fields, names);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = displayValues(value).join('');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldDateIso(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string | null {
  const value = fieldValue(fields, names);
  const timestamp =
    typeof value === 'number' ? value : Date.parse(fieldText(fields, names));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function linkedRecordId(value: unknown): string {
  const recordIds = Array.from(new Set(collectLinkedRecordIds(value, false)));
  return recordIds.length === 1 ? recordIds[0] : '';
}

function collectLinkedRecordIds(
  value: unknown,
  allowDirectString: boolean,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectLinkedRecordIds(item, true));
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return [
      'link_record_ids',
      'record_ids',
      'record_id',
      'recordId',
      'id',
    ].flatMap((key) => collectLinkedRecordIds(object[key], true));
  }
  const recordId = allowDirectString ? clean(value) : '';
  return recordId ? [recordId] : [];
}

function displayValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(displayValues);
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text ? [text] : [];
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['text', 'name', 'value', 'id']) {
      const values = displayValues(object[key]);
      if (values.length) return values;
    }
  }
  return [];
}

function checked(value: unknown): boolean {
  const text = displayValues(value).join('').trim().toLowerCase();
  return value === true || ['是', 'true', '1', 'yes'].includes(text);
}

function getRecordId(record: BitableRecordItem): string {
  const recordId = clean(record.record_id || record.id);
  if (!recordId) throw consistencyConflict('出库记录标识缺失');
  return recordId;
}

function normalizeSku(value: unknown): string {
  return clean(value).toUpperCase();
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPreflightRetryDue(
  task: InventoryOutboundLedgerTask,
  now = Date.now(),
): boolean {
  if (!task.preflightAttemptCount || !task.lastPreflightAttemptAt) return true;
  const lastAttemptAt = Date.parse(task.lastPreflightAttemptAt);
  if (!Number.isFinite(lastAttemptAt)) return true;
  const delayMs = Math.min(
    MAXIMUM_PREFLIGHT_RETRY_BACKOFF_MS,
    1_000 * 2 ** Math.min(6, task.preflightAttemptCount - 1),
  );
  return now - lastAttemptAt >= delayMs;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function normalizePrincipalFingerprint(value: unknown): string {
  const fingerprint = clean(value);
  if (
    fingerprint.length < 8 ||
    fingerprint.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(fingerprint)
  ) {
    throw new ForbiddenException('当前提交会话无法验证，请重新登录');
  }
  return fingerprint;
}

function assertMatchingTaskIdentity(
  entry: InventoryOutboundTaskLedgerEntry,
  expected: {
    building: WarehouseBuilding;
    principalFingerprint: string;
    requestFingerprint: string;
  },
): void {
  if (
    entry.building !== expected.building ||
    entry.principalFingerprint !== expected.principalFingerprint ||
    entry.requestFingerprint !== expected.requestFingerprint
  ) {
    throw new ConflictException('同一出库创建标识不能用于不同申请或身份');
  }
}

function acceptedTask(
  task: InventoryOutboundLedgerTask,
): InventoryOutboundAcceptedResponse {
  return {
    accepted: true,
    taskId: task.id,
    status: task.status,
    message: task.message,
    ...(task.result ? { result: task.result } : {}),
    ...(task.definitelyNotWritten !== undefined
      ? { definitelyNotWritten: task.definitelyNotWritten }
      : {}),
  };
}

function publicTask(task: InventoryOutboundLedgerTask): InventoryOutboundTask {
  const base = {
    id: task.id,
    status: task.status,
    message: task.message,
    createdAt: task.createdAt,
  };
  if (task.status === 'pending') return { ...base, status: 'pending' };
  if (task.status === 'running') return { ...base, status: 'running' };
  if (task.status === 'completed') {
    if (!task.completedAt || !task.result) {
      throw consistencyConflict('已完成任务缺少规范结果');
    }
    return {
      ...base,
      status: 'completed',
      completedAt: task.completedAt,
      result: task.result,
    };
  }
  if (!task.completedAt) {
    throw consistencyConflict('终态任务缺少完成时间');
  }
  if (task.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      completedAt: task.completedAt,
      definitelyNotWritten: true,
    };
  }
  return {
    ...base,
    status: 'uncertain',
    completedAt: task.completedAt,
    definitelyNotWritten: false,
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && clean(error.message)
    ? clean(error.message)
    : '出库申请后台处理失败';
}

function outboundTaskFailureMessage(stage: string, error: unknown): string {
  const cause =
    error instanceof Error && error.cause !== undefined ? error.cause : error;
  const response = (
    cause as { response?: { data?: { code?: unknown; msg?: unknown } } } | null
  )?.response;
  const code = response?.data?.code;
  const detail =
    typeof response?.data?.msg === 'string'
      ? response.data.msg
          .replace(/[\u0000-\u001f\u007f]/gu, ' ')
          .trim()
          .slice(0, 180)
      : '';
  if (typeof code === 'number' && Number.isInteger(code) && code > 0) {
    return `${stage}失败：飞书错误码 ${code}${detail ? `，${detail}` : ''}`;
  }
  return `${stage}失败：${safeErrorMessage(error)}`;
}

async function withOutboundRecoveryStage<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryableReconciliationReadError(error)) throw error;
    const contextualError = new Error(
      `出库待路由恢复${stage}失败：${safeErrorMessage(error)}`,
      { cause: error },
    );
    const code = clean((error as { code?: unknown } | null)?.code);
    if (code) Object.assign(contextualError, { code });
    throw contextualError;
  }
}

function isRetryablePreflightError(error: unknown): boolean {
  if (isRetryableReconciliationReadError(error)) return true;
  const candidate = error as {
    feishuCode?: unknown;
    response?: { data?: { code?: unknown } };
  } | null;
  return (
    Number(candidate?.feishuCode ?? candidate?.response?.data?.code) === 1254045
  );
}

function isPermanentPreflightError(error: unknown): boolean {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof InventoryWorkflowRecordDefinitelyNotWrittenError
  ) {
    return true;
  }
  if (isRetryablePreflightError(error)) return false;
  const status = errorHttpStatus(error);
  if (Number.isInteger(status) && status >= 400 && status < 500) return true;
  const candidate = error as {
    feishuCode?: unknown;
    response?: { data?: { code?: unknown } };
  } | null;
  const feishuCode = Number(
    candidate?.feishuCode ?? candidate?.response?.data?.code,
  );
  if (Number.isFinite(feishuCode) && feishuCode !== 0) return true;
  return /(?:未配置|配置缺失|缺少.*配置|字段.*必须是)/u.test(
    safeErrorMessage(error),
  );
}

function errorHttpStatus(error: unknown): number {
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
    getStatus?: () => unknown;
  } | null;
  if (typeof candidate?.getStatus === 'function') {
    try {
      return Number(candidate.getStatus());
    } catch {
      return Number.NaN;
    }
  }
  return Number(candidate?.response?.status ?? candidate?.status);
}

function isRetryableReconciliationReadError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    feishuCode?: unknown;
    response?: { status?: unknown; data?: { code?: unknown } };
  } | null;
  const code = clean(candidate?.code).toUpperCase();
  if (['EAI_AGAIN', 'ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  const status = errorHttpStatus(error);
  if (
    Number.isInteger(status) &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  ) {
    return true;
  }
  return (
    Number(candidate?.feishuCode ?? candidate?.response?.data?.code) ===
      1254607 || isFeishuRequestRateLimit(error)
  );
}

function isFeishuRequestRateLimit(error: unknown): boolean {
  const cause =
    error instanceof Error && error.cause !== undefined ? error.cause : error;
  const candidate = cause as {
    feishuCode?: unknown;
    response?: { data?: { code?: unknown } };
  } | null;
  return [1254290, 99991400].includes(
    Number(candidate?.feishuCode ?? candidate?.response?.data?.code),
  );
}

function consistencyConflict(message: string): ConflictException {
  return new ConflictException(`出库数据一致性冲突：${message}`);
}
