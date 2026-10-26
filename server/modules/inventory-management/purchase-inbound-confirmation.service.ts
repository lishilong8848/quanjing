import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryMovementItem,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundCategoryPrepareResponse,
  PurchaseInboundConfirmRequest,
  PurchaseInboundConfirmResponse,
  PurchaseNewInboundConfirmRequest,
  PurchasePendingInboundItem,
  PurchasePendingInboundResponse,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { PurchaseWorkflowService } from '../purchase-inventory/purchase-workflow.service';
import {
  assertPurchaseInboundExecutionScope,
  assertPurchaseInboundScope,
} from './inventory-access-policy';
import {
  InventoryMovementCommandService,
  type InventoryWriteOwnershipGuard,
  type TrustedInventoryInboundRequest,
  type TrustedInventoryInboundResult,
  type TrustedInventoryNewInboundRequest,
} from './inventory-movement-command.service';
import { InventoryMovementOperationCoordinator } from './inventory-movement-operation-coordinator';
import { InventoryInboundTaskLedgerStore } from './inventory-inbound-task-ledger.store';
import {
  escapeBaseFilterText,
  InventoryWorkflowGateway,
  InventoryWorkflowRecordNotFoundError,
  type InventoryWorkflowFieldSchema,
} from './inventory-workflow.gateway';
import {
  buildPendingPurchaseInbounds,
  buildPurchaseInboundCompletionFields,
  validatePurchaseInboundCategoryPreparation,
  validatePurchaseInboundConfirmation,
} from './purchase-inbound-confirmation.rules';
import { InventoryStorageLocationService } from './inventory-storage-location.service';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

interface PurchaseInboundConfig {
  purchaseAppToken: string;
  submissionTableId: string;
  executionTableId: string;
  warehouseAppToken: string;
  catalogTableId: string;
}

interface PurchaseInboundSnapshot {
  submissions: BitableRecordItem[];
  executions: BitableRecordItem[];
  catalog: BitableRecordItem[];
}

interface RunningPurchaseInbound {
  fingerprint: string;
  promise: Promise<PurchaseInboundConfirmResponse>;
}

interface AuthorizedPurchaseInbound {
  config: PurchaseInboundConfig;
  execution: BitableRecordItem;
  executionBuilding: WarehouseBuilding;
}

type PurchaseInboundAuthorizedRequest =
  | PurchaseInboundConfirmRequest
  | PurchaseInboundCategoryPrepareRequest;

@Injectable()
export class PurchaseInboundConfirmationService {
  private readonly logger = new Logger(PurchaseInboundConfirmationService.name);

  private readonly running = new Map<string, RunningPurchaseInbound>();

  constructor(
    private readonly httpService: HttpService,
    private readonly gateway: InventoryWorkflowGateway,
    private readonly purchaseWorkflowService: PurchaseWorkflowService,
    private readonly movementCommandService: InventoryMovementCommandService,
    private readonly storageLocationService: InventoryStorageLocationService,
    @Optional()
    private readonly operationCoordinator?: InventoryMovementOperationCoordinator,
    @Optional() private readonly inboundTaskLedger?: InventoryInboundTaskLedgerStore,
  ) {}

  async listPending(
    forceRefresh = false,
  ): Promise<PurchasePendingInboundResponse> {
    const config = await this.resolveConfig();
    const [submissions, executions, catalog] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken: config.purchaseAppToken,
        tableId: config.submissionTableId,
        tableName: '采购提交',
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
      fetchBitableRecords(this.httpService, {
        appToken: config.purchaseAppToken,
        tableId: config.executionTableId,
        tableName: '采购执行',
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
      fetchBitableRecords(this.httpService, {
        appToken: config.warehouseAppToken,
        tableId: config.catalogTableId,
        tableName: '物品类别',
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
    ]);
    const responsibilities = this.inboundTaskLedger ? await this.inboundTaskLedger.purchaseResponsibilities() : {};
    return {
      generatedAt: new Date().toISOString(),
      items: buildPendingPurchaseInbounds({ submissions, executions, catalog }).map(item => {
        const plan = responsibilities[item.executionRecordId];
        return plan ? { ...item, responsibilityGeneration: plan.generation } : item;
      }),
    };
  }

  async confirm(
    request: PurchaseInboundConfirmRequest,
    principal: AccessPrincipal,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<PurchaseInboundConfirmResponse> {
    const executionRecordId = clean(request?.executionRecordId);
    if (!executionRecordId) {
      throw new BadRequestException('采购执行记录标识缺失');
    }
    if (!assertOwnership && await this.inboundTaskLedger?.purchaseResponsibility(executionRecordId)) {
      throw new ConflictException('该采购入库已启用交接，请从待入库清单重新提交');
    }
    const normalizedRequest = { ...request, executionRecordId };
    const fingerprint = buildPurchaseBusinessFingerprint(normalizedRequest);
    const active = this.running.get(executionRecordId);
    if (active) {
      await this.authorizeRequest(normalizedRequest, principal);
      if (active.fingerprint !== fingerprint) {
        throw new ConflictException('该采购执行正在处理另一份入库请求');
      }
      const response = await active.promise;
      return withPurchaseTransportMutation(response, normalizedRequest);
    }

    const confirmOperation = async () => {
      const authorization = await withInventoryStage(
        '读取并校验采购执行记录',
        () => this.authorizeRequest(normalizedRequest, principal),
      );
      return withInventoryStage('处理采购入库', () =>
        this.confirmOnce(
          normalizedRequest,
          principal,
          authorization,
          assertOwnership,
        ),
      );
    };
    const operation = this.operationCoordinator
      ? this.operationCoordinator.run(
          [`purchase:${executionRecordId}`],
          confirmOperation,
        )
      : confirmOperation();
    this.running.set(executionRecordId, { fingerprint, promise: operation });
    const clearRunning = () => {
      if (this.running.get(executionRecordId)?.promise === operation) {
        this.running.delete(executionRecordId);
      }
    };
    void operation.then(clearRunning, clearRunning);
    const response = await operation;
    return withPurchaseTransportMutation(response, normalizedRequest);
  }

  async prepareCategory(
    request: PurchaseInboundCategoryPrepareRequest,
    principal: AccessPrincipal,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<PurchaseInboundCategoryPrepareResponse> {
    const executionRecordId = clean(request?.executionRecordId);
    if (!executionRecordId) {
      throw new BadRequestException('采购执行记录标识缺失');
    }
    const normalizedRequest = { ...request, executionRecordId };
    const locationRecordId = clean(normalizedRequest.newItem?.locationRecordId);
    const locationName = clean(normalizedRequest.newItem?.location);
    const selectedLocationRead =
      locationRecordId && locationName
        ? this.storageLocationService.resolveSelectedLocation(
            normalizedRequest.building,
            locationRecordId,
            locationName,
          )
        : Promise.resolve(null);
    const [authorization, selectedLocation] = await Promise.all([
      this.authorizeRequest(normalizedRequest, principal),
      selectedLocationRead,
    ]);
    const pending = buildPendingPurchaseInbounds({
      submissions: [],
      executions: [authorization.execution],
    }).find((item) => item.executionRecordId === executionRecordId);
    assertPurchaseInboundScope(
      principal,
      normalizedRequest,
      pending ? [pending] : [],
    );
    validatePurchaseInboundCategoryPreparation(normalizedRequest, pending);
    if (!selectedLocation) {
      throw new BadRequestException('请选择底表中的存放位置');
    }
    const trustedRequest = buildTrustedCategoryPrepareRequest({
      ...normalizedRequest,
      newItem: {
        ...normalizedRequest.newItem,
        location: selectedLocation.name,
        locationRecordId: selectedLocation.recordId,
      },
    });
    return assertOwnership
      ? this.movementCommandService.prepareTrustedNewInboundCatalog(
          `采购:${executionRecordId}`,
          trustedRequest,
          principal,
          assertOwnership,
        )
      : this.movementCommandService.prepareTrustedNewInboundCatalog(
          `采购:${executionRecordId}`,
          trustedRequest,
          principal,
        );
  }

  private async confirmOnce(
    request: PurchaseInboundConfirmRequest,
    principal: AccessPrincipal,
    authorization: AuthorizedPurchaseInbound,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<PurchaseInboundConfirmResponse> {
    const {
      config,
      execution,
      executionBuilding: trustedExecutionBuilding,
    } = authorization;
    const snapshot = await withInventoryStage('核对采购入库状态', () =>
      this.loadConfirmationSnapshot(config, request, execution),
    );

    const pending = buildPendingPurchaseInbounds({
      submissions: snapshot.submissions,
      executions: snapshot.executions,
      catalog: snapshot.catalog,
    }).find((item) => item.executionRecordId === request.executionRecordId);
    assertPurchaseInboundScope(principal, request, pending ? [pending] : []);

    const recoverOnly = !pending;
    if (pending) {
      validatePurchaseInboundConfirmation(request, pending, snapshot.catalog);
    } else if (!hasCompletedExecutionSignal(execution)) {
      throw new BadRequestException('采购记录不存在或尚未完成签收');
    }

    const executionFieldSchemasRead = withInventoryStage(
      '校验采购执行回填字段',
      () =>
        this.gateway.getFieldSchemas(
          config.purchaseAppToken,
          config.executionTableId,
          '采购执行',
        ),
    ).then(
      (schemas) => ({ schemas }),
      (error: unknown) => ({ error }),
    );

    let validatedRequest = request;
    if (pending && isStrictPurchaseNewRequest(request)) {
      const preparedLocationRecordId = clean(
        pending.preparedCategory?.newItem.locationRecordId,
      );
      if (preparedLocationRecordId) {
        if (
          clean(request.newItem.locationRecordId) !== preparedLocationRecordId
        ) {
          throw new BadRequestException('存放位置已变化，请重新生成物品类别号');
        }
        const selectedLocation =
          await this.storageLocationService.resolveSelectedLocation(
            request.building,
            preparedLocationRecordId,
            pending.preparedCategory?.newItem.location || '',
          );
        validatedRequest = {
          ...request,
          newItem: {
            ...request.newItem,
            location: selectedLocation.name,
            locationRecordId: selectedLocation.recordId,
          },
        };
      }
    }

    const executionFieldSchemasResult = await executionFieldSchemasRead;
    if ('error' in executionFieldSchemasResult) {
      throw executionFieldSchemasResult.error;
    }
    const supportedCompletionFieldNames = buildPurchaseCompletionFieldPlan(
      executionFieldSchemasResult.schemas,
    );
    const trustedRequest = buildTrustedInboundRequest(
      validatedRequest,
      pending,
      trustedExecutionBuilding,
    );
    const strictNewRequest = isStrictPurchaseNewRequest(validatedRequest)
      ? validatedRequest
      : null;
    const trustedResult =
      await this.movementCommandService.createTrustedInbound(
        `采购:${request.executionRecordId}`,
        trustedRequest,
        principal,
        strictNewRequest
          ? {
              ...(recoverOnly ? { recoverOnly: true } : {}),
              requirePreparedCatalog: true,
              expectedCatalogRecordId: clean(
                strictNewRequest.preparedCatalogRecordId,
              ),
              expectedSku: normalizeSku(strictNewRequest.generatedSku),
              ...(assertOwnership ? { assertOwnership } : {}),
            }
          : recoverOnly
            ? {
                recoverOnly: true,
                ...(assertOwnership ? { assertOwnership } : {}),
              }
            : assertOwnership
              ? { assertOwnership }
              : undefined,
      );
    const movement = trustedResult.response.movement;

    const completionFields = buildPurchaseInboundCompletionFields({
      sku: movement.sku,
      quantity: movement.quantity,
    });
    const supportedCompletionFields = pickSupportedCompletionFields(
      completionFields,
      supportedCompletionFieldNames,
    );
    if (!hasPurchaseCompletionFields(execution, supportedCompletionFields)) {
      await assertWriteOwnership(assertOwnership);
      await withInventoryStage('回填采购入库完成状态', () =>
        this.gateway.updateRecord(
          config.purchaseAppToken,
          config.executionTableId,
          request.executionRecordId,
          supportedCompletionFields,
          '采购执行',
        ),
      );
    }
    this.scheduleCompletionNotificationOutbox(
      request.executionRecordId,
      movement,
    );
    return buildPurchaseResponse(request.executionRecordId, trustedResult, []);
  }

  private scheduleCompletionNotificationOutbox(
    executionRecordId: string,
    movement: InventoryMovementItem,
  ): void {
    void this.ensureCompletionNotificationOutbox(
      executionRecordId,
      movement,
    ).catch((error) =>
      this.logger.warn(
        `采购入库已完成，成功通知转后台补偿：record=${executionRecordId}, message=${errorMessage(error)}`,
      ),
    );
  }

  async ensureCompletionNotificationOutbox(
    executionRecordId: string,
    movement?: InventoryMovementItem,
  ): Promise<void> {
    await this.purchaseWorkflowService.enqueueCompletionNotifications(
      executionRecordId,
      movement,
    );
  }

  private async authorizeRequest(
    request: PurchaseInboundAuthorizedRequest,
    principal: AccessPrincipal,
  ): Promise<AuthorizedPurchaseInbound> {
    const config = await this.resolveConfig();
    let execution: BitableRecordItem;
    try {
      execution = await this.gateway.getRecord(
        config.purchaseAppToken,
        config.executionTableId,
        request.executionRecordId,
        '采购执行',
      );
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordNotFoundError) {
        throw new BadRequestException('采购执行记录不存在');
      }
      throw error;
    }
    assertProfessionalBitableRecord(principal, execution);
    const trustedExecutionBuilding = parseBuilding(
      executionBuilding(execution),
    );
    assertPurchaseInboundExecutionScope(principal, trustedExecutionBuilding);
    assertPurchaseInboundScope(principal, request, []);
    return {
      config,
      execution,
      executionBuilding: trustedExecutionBuilding,
    };
  }

  private async loadConfirmationSnapshot(
    config: PurchaseInboundConfig,
    request: PurchaseInboundAuthorizedRequest,
    execution: BitableRecordItem,
  ): Promise<PurchaseInboundSnapshot> {
    if (hasCompletedExecutionSignal(execution)) {
      return { submissions: [], executions: [execution], catalog: [] };
    }

    const requestCode = fieldText(execution.fields, ['采购编码']);
    const submissionRead = requestCode
      ? this.gateway.listRecords({
          appToken: config.purchaseAppToken,
          tableId: config.submissionTableId,
          tableName: '采购提交',
          filter: buildExactTextFilter('采购编码', requestCode),
        })
      : Promise.resolve([]);
    const catalogRecordId =
      'mode' in request
        ? request.mode === 'existing'
          ? clean(request.catalogRecordId)
          : 'preparedCatalogRecordId' in request
            ? clean(request.preparedCatalogRecordId)
            : ''
        : '';
    const catalogRead = catalogRecordId
      ? this.gateway
          .getRecord(
            config.warehouseAppToken,
            config.catalogTableId,
            catalogRecordId,
            '物品类别',
          )
          .catch((error: unknown) => {
            if (error instanceof InventoryWorkflowRecordNotFoundError) {
              throw new BadRequestException(
                'mode' in request && request.mode === 'new'
                  ? '预备物品类别不存在，请重新生成'
                  : '所选库存物品类别不存在',
              );
            }
            throw error;
          })
          .then((record) => [record])
      : Promise.resolve([]);
    const [submissions, catalog] = await Promise.all([
      submissionRead,
      catalogRead,
    ]);
    return { submissions, executions: [execution], catalog };
  }

  private async resolveConfig(): Promise<PurchaseInboundConfig> {
    const purchaseSource = parseFeishuBitableLink(
      readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'),
    );
    const warehouseSource = parseFeishuBitableLink(
      readEnv('FEISHU_WAREHOUSE_SOURCE_URL'),
    );
    const [purchaseAppToken, warehouseAppToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, {
        appToken:
          readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') ||
          purchaseSource.appToken,
        wikiToken:
          readEnv('FEISHU_PURCHASE_INVENTORY_WIKI_TOKEN') ||
          purchaseSource.wikiToken,
        tableName: '采购与库房管理',
      }),
      resolveBitableAppToken(this.httpService, {
        appToken:
          readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || warehouseSource.appToken,
        wikiToken: warehouseSource.wikiToken,
        tableName: '南通运维全景驾驶舱-库房管理',
      }),
    ]);
    const config = {
      purchaseAppToken,
      submissionTableId: readEnv('FEISHU_PURCHASE_SUBMISSION_TABLE_ID'),
      executionTableId: readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID'),
      warehouseAppToken,
      catalogTableId: readEnv('FEISHU_WAREHOUSE_CATALOG_TABLE_ID'),
    };
    const missing = Object.entries(config)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length) {
      throw new Error(`采购人工入库配置缺失：${missing.join('、')}`);
    }
    return config;
  }
}

async function assertWriteOwnership(
  guard?: InventoryWriteOwnershipGuard,
): Promise<void> {
  if (guard) await guard();
}

async function withInventoryStage<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === 'object' && !('inventoryStage' in error)) {
      Object.defineProperty(error, 'inventoryStage', {
        configurable: true,
        enumerable: false,
        value: stage,
      });
    }
    throw error;
  }
}

function buildTrustedInboundRequest(
  request: PurchaseInboundConfirmRequest,
  pending: PurchasePendingInboundItem | undefined,
  legacyRecoveryBuilding: WarehouseBuilding,
): TrustedInventoryInboundRequest {
  const strict = hasStrictPurchaseSignal(request);
  const building = strict
    ? parseBuilding(request.building)
    : (pending?.building ?? legacyRecoveryBuilding);
  if (!building) {
    throw new BadRequestException('已完成采购重试必须提供目标楼栋');
  }
  const clientMutationId = strict
    ? clean(request.clientMutationId)
    : `purchase-legacy:${clean(request.executionRecordId)}`;
  if (!clientMutationId) {
    throw new BadRequestException('请求标识不能为空');
  }
  const common = {
    type: 'inbound' as const,
    clientMutationId,
    building,
    quantity: request.quantity,
    occurredAt: clean(request.occurredAt),
  };
  if (request.mode === 'new') {
    if (!strict) {
      throw new BadRequestException(
        '旧版新增物品请求不再支持，请刷新页面后填写目标楼栋和库位',
      );
    }
    if (Object.prototype.hasOwnProperty.call(request, 'sku')) {
      throw new BadRequestException('新增物品类别号由服务端生成，请勿手工填写');
    }
    if (!request.newItem) {
      throw new BadRequestException('请补全库存新品类别信息');
    }
    const trustedRequest: TrustedInventoryNewInboundRequest = {
      ...common,
      mode: 'new',
      newItem: request.newItem,
    };
    return trustedRequest;
  }
  const trustedRequest: InventoryExistingInboundMovementCreateRequest = {
    ...common,
    mode: 'existing',
    catalogRecordId: clean(request.catalogRecordId),
    sku: clean(request.sku).toUpperCase(),
  };
  return trustedRequest;
}

function buildTrustedCategoryPrepareRequest(
  request: PurchaseInboundCategoryPrepareRequest,
): TrustedInventoryNewInboundRequest {
  return {
    type: 'inbound',
    mode: 'new',
    clientMutationId: clean(request.clientMutationId),
    building: parseBuilding(request.building),
    quantity: request.quantity,
    occurredAt: clean(request.occurredAt),
    newItem: request.newItem,
  };
}

function buildPurchaseResponse(
  executionRecordId: string,
  result: TrustedInventoryInboundResult,
  notificationWarnings: string[],
): PurchaseInboundConfirmResponse {
  return {
    success: true,
    executionRecordId,
    catalogRecordId: result.catalogRecordId,
    inboundRecordId: result.inboundRecordId,
    alreadyProcessed: result.alreadyProcessed,
    message: result.alreadyProcessed
      ? '该采购物品已完成入库'
      : '采购物品已确认入库',
    notificationWarnings,
    movement: result.response.movement,
  };
}

function withPurchaseTransportMutation(
  response: PurchaseInboundConfirmResponse,
  request: PurchaseInboundConfirmRequest,
): PurchaseInboundConfirmResponse {
  if (!response.movement) return response;
  return {
    ...response,
    movement: {
      ...response.movement,
      clientMutationId: transportMutationId(request),
    },
  };
}

function transportMutationId(request: PurchaseInboundConfirmRequest): string {
  return hasStrictPurchaseSignal(request)
    ? clean(request.clientMutationId)
    : `purchase-legacy:${clean(request.executionRecordId)}`;
}

function buildPurchaseBusinessFingerprint(
  request: PurchaseInboundConfirmRequest,
): string {
  const strictNewRequest = isStrictPurchaseNewRequest(request) ? request : null;
  const payload = {
    executionRecordId: clean(request.executionRecordId),
    mode: request.mode,
    building: clean(request.building),
    quantity: request.quantity,
    occurredAt: clean(request.occurredAt),
    catalogRecordId: clean(request.catalogRecordId),
    sku: clean(request.sku).toUpperCase(),
    preparedCatalogRecordId: strictNewRequest
      ? clean(strictNewRequest.preparedCatalogRecordId)
      : '',
    generatedSku: strictNewRequest
      ? normalizeSku(strictNewRequest.generatedSku)
      : '',
    newItem:
      request.mode === 'new'
        ? {
            primaryCategory: clean(request.newItem?.primaryCategory),
            secondaryCategory: clean(request.newItem?.secondaryCategory),
            name: clean(request.newItem?.name),
            specification: clean(request.newItem?.specification),
            location: clean(request.newItem?.location),
            ...(clean(strictNewRequest?.newItem.locationRecordId)
              ? {
                  locationRecordId: clean(
                    strictNewRequest?.newItem.locationRecordId,
                  ),
                }
              : {}),
            brand: clean(request.newItem?.brand),
            unit: clean(request.newItem?.unit),
            minimumQuantity: request.newItem?.minimumQuantity ?? null,
          }
        : null,
  };
  return createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
}

function hasStrictPurchaseSignal(
  request: PurchaseInboundConfirmRequest,
): request is Exclude<
  PurchaseInboundConfirmRequest,
  { building?: never; clientMutationId?: never }
> {
  return (
    Object.prototype.hasOwnProperty.call(request, 'building') ||
    Object.prototype.hasOwnProperty.call(request, 'clientMutationId')
  );
}

function isStrictPurchaseNewRequest(
  request: PurchaseInboundConfirmRequest,
): request is PurchaseNewInboundConfirmRequest {
  return request.mode === 'new' && hasStrictPurchaseSignal(request);
}

function executionBuilding(record: BitableRecordItem): string {
  return (
    fieldText(record.fields, [
      '申请楼栋',
      '申请楼栋（多楼请选E楼，备注里填写详情）',
      '申请楼栋（多楼请选H楼，备注里填写详情）',
    ]).split('、')[0] || ''
  );
}

function hasCompletedExecutionSignal(record: BitableRecordItem): boolean {
  const statuses = [
    fieldText(record.fields, ['采购流程']),
    fieldText(record.fields, ['程序采购状态']),
  ].filter(Boolean);
  return (
    fieldChecked(record.fields?.['是否已入库']) ||
    statuses.some((status) =>
      ['采购完成（已入库）', '物品签收已入库'].includes(status),
    )
  );
}

function pickSupportedCompletionFields(
  completionFields: Record<string, unknown>,
  fieldNames: readonly string[],
): Record<string, unknown> {
  const supported = new Set(fieldNames);
  return Object.fromEntries(
    Object.entries(completionFields).filter(([fieldName]) =>
      supported.has(fieldName),
    ),
  );
}

const PURCHASE_COMPLETION_FIELD_TYPES: Readonly<
  Record<string, readonly number[]>
> = {
  物品类别码: [1],
  实际采购数量: [2],
  是否已入库: [7],
  采购流程: [1, 3],
  程序采购状态: [1, 3],
};
const PURCHASE_COMPLETION_STATUS_FIELDS = [
  '是否已入库',
  '采购流程',
  '程序采购状态',
] as const;

function buildPurchaseCompletionFieldPlan(
  schemas: readonly InventoryWorkflowFieldSchema[],
): string[] {
  const schemasByName = new Map(
    schemas.map((schema) => [schema.fieldName, schema]),
  );
  const supportedFieldNames: string[] = [];
  const incompatibleStatusFields: string[] = [];

  Object.entries(PURCHASE_COMPLETION_FIELD_TYPES).forEach(
    ([fieldName, allowedTypes]) => {
      const schema = schemasByName.get(fieldName);
      if (!schema) return;
      const typeMatches =
        schema.type !== null && allowedTypes.includes(schema.type);
      if (!schema.writable || !typeMatches) {
        if (fieldName === '实际采购数量') {
          throw new BadRequestException(
            schema.writable
              ? '采购执行表“实际采购数量”字段类型不匹配'
              : '采购执行表“实际采购数量”字段不可写，无法确认入库数量',
          );
        }
        if (
          PURCHASE_COMPLETION_STATUS_FIELDS.includes(
            fieldName as (typeof PURCHASE_COMPLETION_STATUS_FIELDS)[number],
          )
        ) {
          incompatibleStatusFields.push(fieldName);
        }
        return;
      }
      supportedFieldNames.push(fieldName);
    },
  );

  if (!supportedFieldNames.includes('实际采购数量')) {
    throw new BadRequestException(
      '采购执行表缺少“实际采购数量”字段，无法确认入库数量',
    );
  }
  if (
    !PURCHASE_COMPLETION_STATUS_FIELDS.some((fieldName) =>
      supportedFieldNames.includes(fieldName),
    )
  ) {
    const incompatibleHint = incompatibleStatusFields.length
      ? `（${incompatibleStatusFields.join('、')}不可写或类型不匹配）`
      : '';
    throw new BadRequestException(
      `采购执行表缺少可写且类型匹配的入库完成状态字段${incompatibleHint}`,
    );
  }
  return supportedFieldNames;
}

function hasPurchaseCompletionFields(
  record: BitableRecordItem,
  expectedFields: Record<string, unknown>,
): boolean {
  return Object.entries(expectedFields).every(([fieldName, expected]) => {
    const actual = record.fields?.[fieldName];
    if (fieldName === '实际采购数量') {
      return fieldNumber(actual) === Number(expected);
    }
    if (fieldName === '是否已入库') {
      return fieldChecked(actual) === Boolean(expected);
    }
    if (fieldName === '物品类别码') {
      return (
        normalizeSku(fieldText(record.fields, [fieldName])) ===
        normalizeSku(expected)
      );
    }
    return fieldText(record.fields, [fieldName]) === String(expected);
  });
}

function fieldText(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string {
  for (const name of names) {
    const values = displayValues(fields?.[name]);
    if (values.length) return values.join('、');
  }
  return '';
}

function fieldChecked(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = displayValues(value).join('').toLowerCase();
  return text === 'true' || text === '是' || text === '1';
}

function fieldNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(displayValues(value).join(''));
  return Number.isFinite(parsed) ? parsed : 0;
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
    for (const key of ['text', 'name', 'value']) {
      const values = displayValues(object[key]);
      if (values.length) return values;
    }
  }
  return [];
}

function buildExactTextFilter(fieldName: string, value: string): string {
  return `CurrentValue.[${fieldName}]="${escapeBaseFilterText(value)}"`;
}

function parseBuilding(value: unknown): WarehouseBuilding {
  if (
    typeof value === 'string' &&
    WAREHOUSE_BUILDINGS.includes(value as WarehouseBuilding)
  ) {
    return value as WarehouseBuilding;
  }
  throw new BadRequestException('请选择目标楼栋');
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSku(value: unknown): string {
  return clean(value).toUpperCase();
}
