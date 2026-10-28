import { assertProfessionalBitableRecord } from '../../common/access/professional-record-scope';
import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { canManageProfessionalRecord } from '../../../shared/professional-access';
import { scopeProfessionalBitableRecords, assertProfessionalRecordScope, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryMovementCreateLegacyRequest,
  InventoryMovementCreateRequest,
  InventoryMovementCreateResponse,
  InventoryMovementItem,
  InventoryMovementType,
  InventoryNewInboundMovementCreateRequest,
  InventoryMovementOptionItem,
  InventoryMovementOptionsQuery,
  InventoryOutboundMovementCreateRequest,
  PurchaseInboundNewItemInput,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  getWarehouseInventoryFormalLocationReadFieldNames,
  getWarehouseInventoryLocationFieldName,
  getWarehouseInventoryLocationReadFieldNames,
} from '../../common/config/warehouse-inventory-location.config';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
  type BitableRecordItem,
  type BitableRecordSearchFilter,
} from '../../common/feishu/bitable-direct-read';
import {
  buildInventoryCatalogFields,
  buildInventoryLedgerFields,
  generateInventorySku,
} from './inventory-inbound-catalog.rules';
import {
  buildMovementCreateFields,
  buildMovementOptions,
  validateMovementCreateRequest,
} from './inventory-movement-command.rules';
import { InventoryManagementService } from './inventory-management.service';
import { InventoryOutboundWorkflowService } from './inventory-outbound-workflow.service';
import {
  InventoryWorkflowGateway,
  type InventoryWorkflowFieldSchema,
} from './inventory-workflow.gateway';

const TABLES = {
  inventory: { name: '库存台账', env: 'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID' },
  catalog: { name: '物品类别', env: 'FEISHU_WAREHOUSE_CATALOG_TABLE_ID' },
  inbound: { name: '入库填写', env: 'FEISHU_WAREHOUSE_INBOUND_TABLE_ID' },
  outbound: { name: '出库填写', env: 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID' },
  borrow: { name: '借调填写', env: 'FEISHU_WAREHOUSE_BORROW_TABLE_ID' },
} as const;

const COMPLETED_STRICT_INBOUND_CACHE_TTL_MS = 2 * 60 * 1000;
const COMPLETED_STRICT_INBOUND_CACHE_MAX_ENTRIES = 500;
const STRICT_INBOUND_TRANSPORT_TIMEOUT_MS = 45_000;

interface StrictInboundConfig {
  appToken: string;
  catalogTableId: string;
  inventoryTableId: string;
  inboundTableId: string;
}

interface RequiredInboundField {
  fieldName: string;
  type: 1 | 2 | 3;
  autoCreateIfMissing?: boolean;
}

export interface TrustedInventoryNewInboundRequest extends Omit<
  InventoryNewInboundMovementCreateRequest,
  'newItem'
> {
  newItem: PurchaseInboundNewItemInput;
}

export type TrustedInventoryInboundRequest =
  | TrustedInventoryNewInboundRequest
  | InventoryExistingInboundMovementCreateRequest;

export interface TrustedInventoryInboundResult {
  response: InventoryMovementCreateResponse & {
    movement: InventoryMovementItem;
  };
  catalogRecordId: string;
  inventoryRecordId: string;
  inboundRecordId: string;
  alreadyProcessed: boolean;
}

export interface TrustedPreparedNewInboundCatalogResult {
  catalogRecordId: string;
  sku: string;
  alreadyPrepared: boolean;
  preparedAt: string;
}

export interface TrustedInventoryInboundOptions {
  recoverOnly?: boolean;
  requirePreparedCatalog?: boolean;
  expectedCatalogRecordId?: string;
  expectedSku?: string;
  assertOwnership?: InventoryWriteOwnershipGuard;
}

export type InventoryWriteOwnershipGuard = () => Promise<void>;

interface RunningStrictInbound {
  fingerprint: string;
  recoverOnly: boolean;
  requirePreparedCatalog: boolean;
  expectedCatalogRecordId: string;
  expectedSku: string;
  promise: Promise<TrustedInventoryInboundResult>;
}

interface CompletedStrictInbound {
  fingerprint: string;
  transportMutationId: string;
  completedAt: number;
  result: TrustedInventoryInboundResult;
}

interface StrictMarkerSnapshot {
  catalogMarker?: BitableRecordItem;
  inventoryMarker?: BitableRecordItem;
  inboundMarker?: BitableRecordItem;
  fingerprint: string;
}

interface StrictInboundFingerprints {
  current: string;
  accepted: ReadonlySet<string>;
}

interface PersistedCatalogItem {
  specialty?: string;
  recordId: string;
  sku: string;
  building: WarehouseBuilding;
  name: string;
  specification: string;
  brand: string;
  primaryCategory: string;
  secondaryCategory: string;
  unit: string;
  minimumQuantity: number | null;
}

interface PersistedInventoryItem {
  recordId: string;
  sku: string;
  building: WarehouseBuilding;
  location: string;
  storageLocation: string;
  initialQuantity: number | null;
}

interface PersistedInboundItem {
  recordId: string;
  sourceKey: string;
  fingerprint: string;
  sku: string;
  building: WarehouseBuilding;
  quantity: number;
  occurredAt: string;
  operator: string;
}

@Injectable()
export class InventoryMovementCommandService {
  private readonly runningBySourceKey = new Map<string, RunningStrictInbound>();
  private readonly completedBySourceKey = new Map<
    string,
    CompletedStrictInbound
  >();
  private readonly serialBySecondaryCategory = new Map<string, Promise<void>>();
  private readonly serialBySourceKey = new Map<string, Promise<void>>();

  constructor(
    private readonly httpService: HttpService,
    private readonly gateway: InventoryWorkflowGateway,
    private readonly managementService?: InventoryManagementService,
    private readonly outboundService?: InventoryOutboundWorkflowService,
  ) {}

  async getOptions(
    query: InventoryMovementOptionsQuery,
    principal?: AccessPrincipal,
  ): Promise<InventoryMovementOptionItem[]> {
    const type = parseType(query.type);
    const building = parseBuilding(query.building);
    const { appToken } = await this.resolveSource();
    const { catalogTableId, inventoryTableId } = this.resolveCoreTables();
    const [catalog, inventory] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: catalogTableId,
        tableName: TABLES.catalog.name,
        cacheTtlMs: 30 * 60 * 1000,
        forceRefresh: query.refresh === true,
        strict: query.refresh === true,
      }),
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: inventoryTableId,
        tableName: TABLES.inventory.name,
        cacheTtlMs: 2 * 60 * 1000,
        forceRefresh: query.refresh === true,
        strict: query.refresh === true,
      }),
    ]);
    return buildMovementOptions({
      catalog: isProfessionalBusinessPrincipal(principal) ? catalog.filter(record=>(['read','create','update','confirm'] as const).some(action=>canManageProfessionalRecord(principal,recordProfessionalSpecialty(record),building,{module:'inventory',action}))) : catalog,
      inventory,
      type,
      building,
      query: query.query,
      limit: query.limit,
    });
  }

  async assertProfessionalRequest(principal: AccessPrincipal | undefined, request: InventoryMovementCreateRequest): Promise<void> {
    if (!isProfessionalBusinessPrincipal(principal)) return;
    if ('mode' in request && request.mode === 'new') { assertProfessionalRecordScope(principal, request.newItem.specialty, request.building); return; }
    const { appToken } = await this.resolveSource();
    const { catalogTableId } = this.resolveCoreTables();
    const record = await this.gateway.getRecord(appToken, catalogTableId, clean(request.catalogRecordId), TABLES.catalog.name);
    assertProfessionalBitableRecord(principal, record);
    assertProfessionalRecordScope(principal, recordProfessionalSpecialty(record), request.building);
    if ('destinationBuilding' in request && request.destinationBuilding) assertProfessionalRecordScope(principal, recordProfessionalSpecialty(record), request.destinationBuilding);
  }

  async createMovement(
    request: InventoryMovementCreateRequest,
    principal?: AccessPrincipal,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<InventoryMovementCreateResponse> {
    if (!isRecord(request)) {
      throw new BadRequestException('库存业务请求参数格式无效');
    }
    if (
      Object.prototype.hasOwnProperty.call(
        request as unknown as Record<string, unknown>,
        'sourceKey',
      )
    ) {
      throw new BadRequestException('HTTP 请求不能指定入库来源标识');
    }
    await this.assertProfessionalRequest(principal, request);
    const type = parseType(request.type);
    const building = parseBuilding(request.building);
    if (type === 'outbound') {
      const outboundRequest = request as InventoryOutboundMovementCreateRequest;
      if (!clean(outboundRequest.clientMutationId)) {
        throw new BadRequestException('请求标识不能为空');
      }
      if (!this.outboundService) {
        throw new Error('出库工作流服务未配置');
      }
      return this.outboundService.createPending(
        { ...outboundRequest, building },
        principal,
      );
    }
    if (hasStrictInboundSignal(request)) {
      if (isStrictNewInboundRequest(request)) {
        const normalized = normalizeNewInboundRequest(request, building);
        return this.createTrustedInbound(
          `手工:${normalized.clientMutationId}`,
          normalized,
          principal,
          { assertOwnership },
        ).then((result) => result.response);
      }
      if (isStrictExistingInboundRequest(request)) {
        const normalized = normalizeExistingInboundRequest(request, building);
        return this.createTrustedInbound(
          `手工:${normalized.clientMutationId}`,
          normalized,
          principal,
          { assertOwnership },
        ).then((result) => result.response);
      }
      throw new BadRequestException('严格入库请求参数不完整');
    }
    if (!isLegacyMovementRequest(request)) {
      throw new BadRequestException('请选择有效入库物品模式');
    }
    return this.createLegacyMovement(
      normalizeLegacyMovementRequest(request, type, building),
    );
  }

  private async createLegacyMovement(
    normalizedRequest: InventoryMovementCreateLegacyRequest,
  ): Promise<InventoryMovementCreateResponse> {
    const type = normalizedRequest.type;
    const building = normalizedRequest.building;
    const { appToken } = await this.resolveSource();
    const { catalogTableId, inventoryTableId } = this.resolveCoreTables();
    const [catalog, inventory] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: catalogTableId,
        tableName: TABLES.catalog.name,
        cacheTtlMs: 0,
        forceRefresh: true,
      }),
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: inventoryTableId,
        tableName: TABLES.inventory.name,
        cacheTtlMs: 0,
        forceRefresh: true,
      }),
    ]);
    const option = buildMovementOptions({
      catalog,
      inventory,
      type,
      building,
      query: String(normalizedRequest.sku || '').trim(),
      limit: 100,
    }).find(
      (item) =>
        item.catalogRecordId === normalizedRequest.catalogRecordId &&
        item.sku.trim().toUpperCase() ===
          String(normalizedRequest.sku || '')
            .trim()
            .toUpperCase(),
    );
    validateMovementCreateRequest(normalizedRequest, option);
    if (!option) {
      throw new BadRequestException('请选择有效物品');
    }

    const table = TABLES[type];
    const tableId = readEnv(table.env);
    if (!tableId) throw new Error(`${table.name}未配置`);
    const recordId = await this.gateway.createRecord(
      appToken,
      tableId,
      buildMovementCreateFields(normalizedRequest, option),
      table.name,
    );
    this.managementService?.invalidateCache();
    return {
      success: true,
      recordId,
      type,
      message: type === 'inbound' ? '入库记录已提交' : '借调记录已提交',
    };
  }

  async prepareTrustedNewInboundCatalog(
    sourceKey: string,
    request: TrustedInventoryNewInboundRequest,
    principal?: AccessPrincipal,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<TrustedPreparedNewInboundCatalogResult> {
    await this.assertProfessionalRequest(principal, request);
    assertTrustedSourceKey(sourceKey, request);
    const building = parseBuilding(request.building);
    const normalizedRequest = normalizeNewInboundRequest(request, building);
    if (!normalizedRequest.clientMutationId) {
      throw new BadRequestException('请求标识不能为空');
    }
    validateMovementCreateRequest(normalizedRequest, undefined);
    const fingerprints = buildStrictInboundFingerprints(normalizedRequest);
    const fingerprint = fingerprints.current;

    return this.runSourceSerial(sourceKey, () =>
      this.runSerial(normalizedRequest.newItem.secondaryCategory, async () => {
        const config = await this.resolveStrictInboundConfig();
        await assertWriteOwnership(assertOwnership);
        const categoryRead = this.gateway
          .searchRecords({
            appToken: config.appToken,
            tableId: config.catalogTableId,
            tableName: TABLES.catalog.name,
            filter: buildExactTextSearchFilter(
              '二级分类',
              normalizedRequest.newItem.secondaryCategory,
            ),
          })
          .then(
            (records) => ({ records }),
            (error: unknown) => ({ error }),
          );
        await this.ensurePreparedCatalogFields(config);
        const [markerRecords, categoryResult] = await Promise.all([
          this.gateway.searchRecords({
            appToken: config.appToken,
            tableId: config.catalogTableId,
            tableName: TABLES.catalog.name,
            filter: buildExactTextSearchFilter('入库创建标识', sourceKey),
          }),
          categoryRead,
        ]);
        if ('error' in categoryResult) throw categoryResult.error;
        const categoryCatalogRecords = categoryResult.records;
        const existing = findUniqueMarker(
          markerRecords,
          '入库创建标识',
          sourceKey,
          TABLES.catalog.name,
        );
        if (existing) {
          assertPersistedMarkerFingerprint(
            existing,
            '入库创建标识',
            sourceKey,
            fingerprints,
            TABLES.catalog.name,
            normalizedRequest,
          );
          const catalogItem = parsePersistedCatalog(existing);
          assertNewCatalogMatchesRequest(catalogItem, normalizedRequest);
          return {
            catalogRecordId: catalogItem.recordId,
            sku: catalogItem.sku,
            alreadyPrepared: true,
            preparedAt: parsePreparedCatalogAt(existing),
          };
        }

        assertSecondaryCategoryPrimaryCategory(
          categoryCatalogRecords,
          normalizedRequest,
        );
        const sku = generateSkuForNewInbound(
          categoryCatalogRecords,
          normalizedRequest,
        );
        const preparedAt = new Date().toISOString();
        const fields = {
          ...buildInventoryCatalogFields({
            building: normalizedRequest.building,
            sku,
            newItem: normalizedRequest.newItem,
          }),
          ...buildOptionalCatalogFields(normalizedRequest.newItem),
          ...await this.professionalCatalogFields(config, normalizedRequest.newItem),
          入库创建标识: sourceKey,
          入库请求指纹: fingerprint,
          采购入库准备参数: JSON.stringify({
            version: 1,
            preparedAt,
            request: normalizedRequest,
          }),
        };
        await assertWriteOwnership(assertOwnership);
        const recordId = await this.gateway.createRecord(
          config.appToken,
          config.catalogTableId,
          fields,
          TABLES.catalog.name,
        );
        const created = await this.gateway.getRecord(
          config.appToken,
          config.catalogTableId,
          recordId,
          TABLES.catalog.name,
        );
        assertPersistedMarker(
          created,
          '入库创建标识',
          sourceKey,
          fingerprint,
          TABLES.catalog.name,
        );
        const catalogItem = parsePersistedCatalog(created);
        assertNewCatalogMatchesRequest(catalogItem, normalizedRequest);
        this.managementService?.invalidateCache();
        return {
          catalogRecordId: catalogItem.recordId,
          sku: catalogItem.sku,
          alreadyPrepared: false,
          preparedAt: parsePreparedCatalogAt(created),
        };
      }),
    );
  }

  async createTrustedInbound(
    sourceKey: string,
    request: TrustedInventoryInboundRequest,
    principal: AccessPrincipal | undefined,
    options: TrustedInventoryInboundOptions = {},
  ): Promise<TrustedInventoryInboundResult> {
    await this.assertProfessionalRequest(principal, request);
    assertTrustedSourceKey(sourceKey, request);
    const recoverOnly = options.recoverOnly === true;
    const requirePreparedCatalog = options.requirePreparedCatalog === true;
    const expectedCatalogRecordId = clean(options.expectedCatalogRecordId);
    const expectedSku = normalizeSku(options.expectedSku);
    const assertOwnership = options.assertOwnership;
    const building = parseBuilding(request.building);
    const normalizedRequest =
      request.mode === 'new'
        ? normalizeNewInboundRequest(request, building)
        : normalizeExistingInboundRequest(request, building);
    if (!request.clientMutationId) {
      return Promise.reject(new BadRequestException('请求标识不能为空'));
    }
    if (normalizedRequest.mode === 'new') {
      validateMovementCreateRequest(normalizedRequest, undefined);
    }

    const fingerprint = buildStrictInboundFingerprint(normalizedRequest);
    const fingerprints = buildStrictInboundFingerprints(normalizedRequest);
    const completed = this.completedBySourceKey.get(sourceKey);
    if (completed) {
      if (
        Date.now() - completed.completedAt >
        COMPLETED_STRICT_INBOUND_CACHE_TTL_MS
      ) {
        this.completedBySourceKey.delete(sourceKey);
      } else {
        if (completed.fingerprint !== fingerprint) {
          throw new ConflictException(
            'clientMutationId 已被不同的入库请求占用',
          );
        }
        if (
          completed.transportMutationId === normalizedRequest.clientMutationId
        ) {
          this.completedBySourceKey.delete(sourceKey);
          this.completedBySourceKey.set(sourceKey, completed);
          return withTransportMutation(
            { ...completed.result, alreadyProcessed: true },
            normalizedRequest.clientMutationId,
          );
        }
      }
    }
    const active = this.runningBySourceKey.get(sourceKey);
    if (active) {
      if (
        active.fingerprint !== fingerprint ||
        active.recoverOnly !== recoverOnly ||
        active.requirePreparedCatalog !== requirePreparedCatalog ||
        active.expectedCatalogRecordId !== expectedCatalogRecordId ||
        active.expectedSku !== expectedSku
      ) {
        throw new ConflictException('clientMutationId 已被不同的入库请求占用');
      }
      return active.promise.then((result) =>
        withTransportMutation(result, normalizedRequest.clientMutationId),
      );
    }

    let cacheInvalidated = false;
    const invalidateManagementCache = () => {
      if (cacheInvalidated) return;
      cacheInvalidated = true;
      this.managementService?.invalidateCache();
    };
    const operationStartedAt = Date.now();
    const operation = this.runSourceSerial(sourceKey, () =>
      normalizedRequest.mode === 'new'
        ? this.runSerial(normalizedRequest.newItem.secondaryCategory, () =>
            this.createStrictNewInboundOnce(
              normalizedRequest,
              sourceKey,
              fingerprints,
              recoverOnly,
              requirePreparedCatalog,
              expectedCatalogRecordId,
              expectedSku,
              invalidateManagementCache,
              assertOwnership,
            ),
          )
        : this.createStrictExistingInboundOnce(
            normalizedRequest,
            sourceKey,
            fingerprint,
            recoverOnly,
            invalidateManagementCache,
            assertOwnership,
          ),
    );
    const invalidatingOperation = operation.then((result) => {
      invalidateManagementCache();
      const completedAt = Date.now();
      if (
        completedAt - operationStartedAt >=
        STRICT_INBOUND_TRANSPORT_TIMEOUT_MS
      ) {
        this.rememberCompletedInbound(
          sourceKey,
          fingerprint,
          normalizedRequest.clientMutationId,
          completedAt,
          result,
        );
      }
      return result;
    });
    this.runningBySourceKey.set(sourceKey, {
      fingerprint,
      recoverOnly,
      requirePreparedCatalog,
      expectedCatalogRecordId,
      expectedSku,
      promise: invalidatingOperation,
    });
    const clearRunning = () => {
      if (
        this.runningBySourceKey.get(sourceKey)?.promise ===
        invalidatingOperation
      ) {
        this.runningBySourceKey.delete(sourceKey);
      }
    };
    void invalidatingOperation.then(clearRunning, clearRunning);
    return invalidatingOperation.then((result) =>
      withTransportMutation(result, normalizedRequest.clientMutationId),
    );
  }

  private rememberCompletedInbound(
    sourceKey: string,
    fingerprint: string,
    transportMutationId: string,
    completedAt: number,
    result: TrustedInventoryInboundResult,
  ): void {
    this.completedBySourceKey.delete(sourceKey);
    this.completedBySourceKey.set(sourceKey, {
      fingerprint,
      transportMutationId,
      completedAt,
      result,
    });
    while (
      this.completedBySourceKey.size >
      COMPLETED_STRICT_INBOUND_CACHE_MAX_ENTRIES
    ) {
      const oldestSourceKey = this.completedBySourceKey.keys().next().value;
      if (typeof oldestSourceKey !== 'string') break;
      this.completedBySourceKey.delete(oldestSourceKey);
    }
  }

  private async createStrictNewInboundOnce(
    request: TrustedInventoryNewInboundRequest,
    sourceKey: string,
    fingerprints: StrictInboundFingerprints,
    recoverOnly: boolean,
    requirePreparedCatalog: boolean,
    expectedCatalogRecordId: string,
    expectedSku: string,
    onPersistedStage: () => void,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<TrustedInventoryInboundResult> {
    const config = await this.resolveStrictInboundConfig();
    if (!recoverOnly) {
      await assertWriteOwnership(assertOwnership);
      await withInventoryStage('校验多维表入库字段', () =>
        this.ensureStrictInboundFields(config),
      );
    }
    const preflight = await withInventoryStage('核对多维表入库幂等记录', () =>
      this.loadStrictMarkerSnapshot(config, sourceKey, fingerprints, request),
    );
    const fingerprint = preflight.fingerprint;
    if (requirePreparedCatalog && !preflight.catalogMarker) {
      throw new BadRequestException('请先生成新的物品类别号');
    }
    if (
      recoverOnly &&
      (!preflight.catalogMarker ||
        !preflight.inventoryMarker ||
        !preflight.inboundMarker)
    ) {
      throw new BadRequestException('未找到可恢复的采购入库记录');
    }

    let catalogRecord = preflight.catalogMarker;
    if (!catalogRecord) {
      const categoryCatalogRecords = await this.gateway.searchRecords({
        appToken: config.appToken,
        tableId: config.catalogTableId,
        tableName: TABLES.catalog.name,
        filter: buildExactTextSearchFilter(
          '二级分类',
          request.newItem.secondaryCategory,
        ),
      });
      assertSecondaryCategoryPrimaryCategory(categoryCatalogRecords, request);
      const sku = generateSkuForNewInbound(categoryCatalogRecords, request);
      const fields = {
        ...buildInventoryCatalogFields({
          building: request.building,
          sku,
          newItem: request.newItem,
        }),
        ...buildOptionalCatalogFields(request.newItem),
        ...await this.professionalCatalogFields(config, request.newItem),
        入库创建标识: sourceKey,
        入库请求指纹: fingerprint,
      };
      await assertWriteOwnership(assertOwnership);
      const recordId = await this.gateway.createRecord(
        config.appToken,
        config.catalogTableId,
        fields,
        TABLES.catalog.name,
      );
      onPersistedStage();
      catalogRecord = await this.gateway.getRecord(
        config.appToken,
        config.catalogTableId,
        recordId,
        TABLES.catalog.name,
      );
    }
    assertPersistedMarker(
      catalogRecord,
      '入库创建标识',
      sourceKey,
      fingerprint,
      TABLES.catalog.name,
    );
    const catalogItem = parsePersistedCatalog(catalogRecord);
    if (requirePreparedCatalog) {
      parsePreparedCatalogAt(catalogRecord);
      if (!expectedCatalogRecordId || !expectedSku) {
        throw new BadRequestException('预备物品类别信息不完整');
      }
      assertPersistedEqual(
        catalogItem.recordId,
        expectedCatalogRecordId,
        '预备物品类别 record_id',
      );
      assertPersistedEqual(catalogItem.sku, expectedSku, '预备物品类别号');
    }
    assertNewCatalogMatchesRequest(catalogItem, request);

    let inventoryRecord = preflight.inventoryMarker;
    if (!inventoryRecord) {
      const fields = {
        ...buildInventoryLedgerFields({
          building: request.building,
          sku: catalogItem.sku,
          location: request.newItem.location,
        }),
        入库创建标识: sourceKey,
        入库请求指纹: fingerprint,
      };
      await assertWriteOwnership(assertOwnership);
      const recordId = await withInventoryStage('写入库存台账', () =>
        this.gateway.createRecord(
          config.appToken,
          config.inventoryTableId,
          fields,
          TABLES.inventory.name,
        ),
      );
      onPersistedStage();
      inventoryRecord = await withInventoryStage('回读库存台账', () =>
        this.gateway.getRecord(
          config.appToken,
          config.inventoryTableId,
          recordId,
          TABLES.inventory.name,
        ),
      );
    }
    assertPersistedMarker(
      inventoryRecord,
      '入库创建标识',
      sourceKey,
      fingerprint,
      TABLES.inventory.name,
    );
    const inventoryItem = parsePersistedInventory(inventoryRecord);
    assertNewInventoryMatchesRequest(inventoryItem, catalogItem, request);

    const inboundRecord = await this.createOrReuseInboundRecord(
      config,
      request,
      catalogItem.sku,
      sourceKey,
      fingerprint,
      recoverOnly,
      preflight.inboundMarker,
      onPersistedStage,
      assertOwnership,
    );
    const inboundItem = parsePersistedInbound(inboundRecord);
    assertInboundMatchesRequest(
      inboundItem,
      catalogItem,
      inventoryItem,
      request,
      sourceKey,
      fingerprint,
    );
    return buildPersistedInboundResult(
      catalogItem,
      inventoryItem,
      inboundItem,
      Boolean(preflight.inboundMarker),
    );
  }

  private async createStrictExistingInboundOnce(
    request: InventoryExistingInboundMovementCreateRequest,
    sourceKey: string,
    fingerprint: string,
    recoverOnly: boolean,
    onPersistedStage: () => void,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<TrustedInventoryInboundResult> {
    const config = await this.resolveStrictInboundConfig();
    if (!recoverOnly) {
      await assertWriteOwnership(assertOwnership);
      await withInventoryStage('校验多维表入库字段', () =>
        this.ensureStrictInboundFields(config),
      );
    }
    const preflight = await withInventoryStage('核对多维表入库幂等记录', () =>
      this.loadStrictMarkerSnapshot(
        config,
        sourceKey,
        singleStrictInboundFingerprint(fingerprint),
      ),
    );
    if (recoverOnly && !preflight.inboundMarker) {
      throw new BadRequestException('未找到可恢复的采购入库记录');
    }
    const catalogRecord = await this.gateway.getRecord(
      config.appToken,
      config.catalogTableId,
      request.catalogRecordId,
      TABLES.catalog.name,
    );
    const catalogItem = parsePersistedCatalog(catalogRecord);
    assertExistingCatalogMatchesRequest(catalogItem, request);
    const inventoryRecords = await this.gateway.searchRecords({
      appToken: config.appToken,
      tableId: config.inventoryTableId,
      tableName: TABLES.inventory.name,
      filter: buildExactTextSearchFilter('物品类别号', catalogItem.sku),
    });
    const inventoryRecord = findUniqueRecord(
      inventoryRecords.filter(
        (record) =>
          normalizeSku(fieldText(record.fields, ['物品类别号'])) ===
            catalogItem.sku &&
          fieldBuilding(record.fields, ['楼栋']) === catalogItem.building,
      ),
      '目标楼栋库存台账记录',
    );
    const inventoryItem = parsePersistedInventory(inventoryRecord);
    assertCatalogInventoryAssociation(catalogItem, inventoryItem);
    const option = toMovementOption(catalogItem, inventoryItem);
    validateMovementCreateRequest(request, option);

    const inboundRecord = await this.createOrReuseInboundRecord(
      config,
      request,
      catalogItem.sku,
      sourceKey,
      fingerprint,
      recoverOnly,
      preflight.inboundMarker,
      onPersistedStage,
      assertOwnership,
    );
    const inboundItem = parsePersistedInbound(inboundRecord);
    assertInboundMatchesRequest(
      inboundItem,
      catalogItem,
      inventoryItem,
      request,
      sourceKey,
      fingerprint,
    );
    return buildPersistedInboundResult(
      catalogItem,
      inventoryItem,
      inboundItem,
      Boolean(preflight.inboundMarker),
    );
  }

  private async createOrReuseInboundRecord(
    config: StrictInboundConfig,
    request:
      | TrustedInventoryNewInboundRequest
      | InventoryExistingInboundMovementCreateRequest,
    sku: string,
    sourceKey: string,
    fingerprint: string,
    recoverOnly: boolean,
    existing?: BitableRecordItem,
    onPersistedStage?: () => void,
    assertOwnership?: InventoryWriteOwnershipGuard,
  ): Promise<BitableRecordItem> {
    if (existing) {
      assertPersistedMarker(
        existing,
        '入库来源',
        sourceKey,
        fingerprint,
        TABLES.inbound.name,
      );
      return existing;
    }
    if (recoverOnly) {
      throw new BadRequestException('未找到可恢复的采购入库记录');
    }

    const fields = {
      物品类别号: sku,
      入库数量: request.quantity,
      楼栋: request.building,
      入库日期: Date.parse(request.occurredAt),
      入库来源: sourceKey,
      入库请求指纹: fingerprint,
    };
    await assertWriteOwnership(assertOwnership);
    const recordId = await withInventoryStage('写入入库记录', () =>
      this.gateway.createRecord(
        config.appToken,
        config.inboundTableId,
        fields,
        TABLES.inbound.name,
      ),
    );
    onPersistedStage?.();
    const created = await withInventoryStage('回读入库记录', () =>
      this.gateway.getRecord(
        config.appToken,
        config.inboundTableId,
        recordId,
        TABLES.inbound.name,
      ),
    );
    assertPersistedMarker(
      created,
      '入库来源',
      sourceKey,
      fingerprint,
      TABLES.inbound.name,
    );
    return created;
  }

  private async loadStrictMarkerSnapshot(
    config: StrictInboundConfig,
    sourceKey: string,
    fingerprints: StrictInboundFingerprints,
    request?: TrustedInventoryNewInboundRequest,
  ): Promise<StrictMarkerSnapshot> {
    const [catalog, inventory, inbound] = await Promise.all([
      withInventoryStage('核对物品类别入库标记', () =>
        this.gateway.searchRecords({
          appToken: config.appToken,
          tableId: config.catalogTableId,
          tableName: TABLES.catalog.name,
          filter: buildExactTextSearchFilter('入库创建标识', sourceKey),
        }),
      ),
      withInventoryStage('核对库存台账入库标记', () =>
        this.gateway.searchRecords({
          appToken: config.appToken,
          tableId: config.inventoryTableId,
          tableName: TABLES.inventory.name,
          filter: buildExactTextSearchFilter('入库创建标识', sourceKey),
        }),
      ),
      withInventoryStage('核对入库记录标记', () =>
        this.gateway.searchRecords({
          appToken: config.appToken,
          tableId: config.inboundTableId,
          tableName: TABLES.inbound.name,
          filter: buildExactTextSearchFilter('入库来源', sourceKey),
        }),
      ),
    ]);
    const catalogMarker = findUniqueMarker(
      catalog,
      '入库创建标识',
      sourceKey,
      TABLES.catalog.name,
    );
    const inventoryMarker = findUniqueMarker(
      inventory,
      '入库创建标识',
      sourceKey,
      TABLES.inventory.name,
    );
    const inboundMarker = findUniqueMarker(
      inbound,
      '入库来源',
      sourceKey,
      TABLES.inbound.name,
    );
    const authoritativeMarker =
      catalogMarker || inventoryMarker || inboundMarker;
    const fingerprint = authoritativeMarker
      ? assertPersistedMarkerFingerprint(
          authoritativeMarker,
          catalogMarker
            ? '入库创建标识'
            : inventoryMarker
              ? '入库创建标识'
              : '入库来源',
          sourceKey,
          fingerprints,
          catalogMarker
            ? TABLES.catalog.name
            : inventoryMarker
              ? TABLES.inventory.name
              : TABLES.inbound.name,
          catalogMarker ? request : undefined,
        )
      : fingerprints.current;
    for (const [record, markerField, tableName] of [
      [catalogMarker, '入库创建标识', TABLES.catalog.name],
      [inventoryMarker, '入库创建标识', TABLES.inventory.name],
      [inboundMarker, '入库来源', TABLES.inbound.name],
    ] as const) {
      if (record) {
        assertPersistedMarker(
          record,
          markerField,
          sourceKey,
          fingerprint,
          tableName,
        );
      }
    }
    return {
      catalogMarker,
      inventoryMarker,
      inboundMarker,
      fingerprint,
    };
  }

  private async resolveStrictInboundConfig(): Promise<StrictInboundConfig> {
    const { appToken } = await this.resolveSource();
    const { catalogTableId, inventoryTableId } = this.resolveCoreTables();
    const inboundTableId = readEnv(TABLES.inbound.env);
    if (!inboundTableId) throw new Error(`${TABLES.inbound.name}未配置`);
    return { appToken, catalogTableId, inventoryTableId, inboundTableId };
  }

  private async ensureStrictInboundFields(
    config: StrictInboundConfig,
  ): Promise<void> {
    const [inventorySchemas, catalogSchemas, inboundSchemas] =
      await Promise.all([
        this.gateway.getFieldSchemas(
          config.appToken,
          config.inventoryTableId,
          TABLES.inventory.name,
        ),
        this.gateway.getFieldSchemas(
          config.appToken,
          config.catalogTableId,
          TABLES.catalog.name,
        ),
        this.gateway.getFieldSchemas(
          config.appToken,
          config.inboundTableId,
          TABLES.inbound.name,
        ),
      ]);
    await this.ensureRequiredInboundFields(
      config.appToken,
      config.inventoryTableId,
      TABLES.inventory.name,
      [
        {
          fieldName: getWarehouseInventoryLocationFieldName(),
          type: 3,
          autoCreateIfMissing: false,
        },
        { fieldName: '入库创建标识', type: 1 },
        { fieldName: '入库存放位置', type: 1 },
        { fieldName: '初始化库存数量', type: 2 },
        { fieldName: '入库请求指纹', type: 1 },
      ],
      inventorySchemas,
    );
    await this.ensureRequiredInboundFields(
      config.appToken,
      config.catalogTableId,
      TABLES.catalog.name,
      [
        { fieldName: '入库创建标识', type: 1 },
        { fieldName: '入库请求指纹', type: 1 },
      ],
      catalogSchemas,
    );
    await this.ensureRequiredInboundFields(
      config.appToken,
      config.inboundTableId,
      TABLES.inbound.name,
      [
        { fieldName: '入库来源', type: 1 },
        { fieldName: '入库请求指纹', type: 1 },
      ],
      inboundSchemas,
    );
  }

  private async professionalCatalogFields(config: StrictInboundConfig, item: PurchaseInboundNewItemInput): Promise<Record<string, string | string[]>> {
    if (!item.specialty) return {};
    const schema = (await this.gateway.getFieldSchemas(config.appToken, config.catalogTableId, TABLES.catalog.name)).find(field => field.fieldName === '专业');
    if (!schema || !schema.writable || typeof schema.type !== 'number' || ![1, 3, 4].includes(schema.type)) throw new BadRequestException('物品类别专业字段未配置，请联系管理员');
    return { 专业: schema.type === 4 ? [item.specialty] : item.specialty };
  }

  private async ensurePreparedCatalogFields(
    config: StrictInboundConfig,
  ): Promise<void> {
    await this.ensureRequiredInboundFields(
      config.appToken,
      config.catalogTableId,
      TABLES.catalog.name,
      [
        { fieldName: '入库创建标识', type: 1 },
        { fieldName: '入库请求指纹', type: 1 },
        { fieldName: '采购入库准备参数', type: 1 },
      ],
    );
  }

  private async ensureRequiredInboundFields(
    appToken: string,
    tableId: string,
    tableName: string,
    requirements: readonly RequiredInboundField[],
    existingSchemas?: readonly InventoryWorkflowFieldSchema[],
  ): Promise<void> {
    const schemas =
      existingSchemas ??
      (await this.gateway.getFieldSchemas(appToken, tableId, tableName));
    const schemaByName = new Map(
      schemas.map((schema) => [schema.fieldName, schema] as const),
    );
    for (const requirement of requirements) {
      const schema = schemaByName.get(requirement.fieldName);
      if (schema) {
        if (schema.type !== requirement.type || !schema.writable) {
          const expectedType =
            requirement.type === 2
              ? '数字'
              : requirement.type === 3
                ? '单选'
                : '文本';
          throw new BadRequestException(
            `${tableName}字段“${requirement.fieldName}”必须是可写${expectedType}类型，请先修正多维表字段后重试`,
          );
        }
        continue;
      }
      if (requirement.autoCreateIfMissing === false) {
        const expectedType =
          requirement.type === 2
            ? '数字'
            : requirement.type === 3
              ? '单选'
              : '文本';
        throw new BadRequestException(
          `${tableName}缺少字段“${requirement.fieldName}”，请先在飞书多维表创建可写${expectedType}字段后重试`,
        );
      }
      if (requirement.type === 2) {
        await this.gateway.ensureNumberField(
          appToken,
          tableId,
          requirement.fieldName,
          tableName,
        );
      } else if (requirement.type === 1) {
        await this.gateway.ensureTextField(
          appToken,
          tableId,
          requirement.fieldName,
          tableName,
        );
      } else {
        throw new BadRequestException(
          `${tableName}缺少字段“${requirement.fieldName}”，请先在飞书多维表创建可写单选字段后重试`,
        );
      }
    }
  }

  private runSerial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.runSerialInMap(this.serialBySecondaryCategory, key, operation);
  }

  private runSourceSerial<T>(
    sourceKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runSerialInMap(this.serialBySourceKey, sourceKey, operation);
  }

  private runSerialInMap<T>(
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

  private resolveCoreTables(): {
    catalogTableId: string;
    inventoryTableId: string;
  } {
    const catalogTableId = readEnv(TABLES.catalog.env);
    const inventoryTableId = readEnv(TABLES.inventory.env);
    if (!catalogTableId) throw new Error('物品类别主数据未配置');
    if (!inventoryTableId) throw new Error('库存台账未配置');
    return { catalogTableId, inventoryTableId };
  }

  private async resolveSource(): Promise<{ appToken: string }> {
    const sourceUrl = readEnv('FEISHU_WAREHOUSE_SOURCE_URL');
    const parsed = parseFeishuBitableLink(sourceUrl);
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || parsed.appToken,
      wikiToken: parsed.wikiToken,
      tableName: '南通运维全景驾驶舱-库房管理',
    });
    return { appToken };
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

function hasStrictInboundSignal(
  request: InventoryMovementCreateRequest,
): boolean {
  const value = request as unknown as Record<string, unknown>;
  return ['mode', 'clientMutationId', 'newItem'].some((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
}

function isStrictNewInboundRequest(
  request: InventoryMovementCreateRequest,
): request is InventoryNewInboundMovementCreateRequest {
  const value = request as unknown as Record<string, unknown>;
  return (
    value.type === 'inbound' &&
    value.mode === 'new' &&
    typeof value.clientMutationId === 'string' &&
    isRecord(value.newItem)
  );
}

function isStrictExistingInboundRequest(
  request: InventoryMovementCreateRequest,
): request is InventoryExistingInboundMovementCreateRequest {
  const value = request as unknown as Record<string, unknown>;
  return (
    value.type === 'inbound' &&
    value.mode === 'existing' &&
    typeof value.clientMutationId === 'string' &&
    typeof value.catalogRecordId === 'string' &&
    typeof value.sku === 'string' &&
    !Object.prototype.hasOwnProperty.call(value, 'newItem')
  );
}

function isLegacyMovementRequest(
  request: InventoryMovementCreateRequest,
): request is InventoryMovementCreateLegacyRequest {
  const value = request as unknown as Record<string, unknown>;
  return !['mode', 'clientMutationId', 'newItem'].some((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
}

function normalizeNewInboundRequest(
  request: TrustedInventoryNewInboundRequest,
  building: WarehouseBuilding,
): TrustedInventoryNewInboundRequest {
  const item = request.newItem as
    | Partial<PurchaseInboundNewItemInput>
    | undefined;
  return {
    type: 'inbound',
    mode: 'new',
    clientMutationId: clean(request.clientMutationId),
    building,
    quantity: request.quantity,
    occurredAt: clean(request.occurredAt),
    applicantOpenId: clean(request.applicantOpenId) || undefined,
    operatorOpenId: clean(request.operatorOpenId) || undefined,
    reason: clean(request.reason) || undefined,
    destinationBuilding: request.destinationBuilding,
    expectedReturnAt: clean(request.expectedReturnAt) || undefined,
    newItem: {
      specialty: clean(item?.specialty) || undefined,
      primaryCategory: clean(item?.primaryCategory),
      secondaryCategory: clean(item?.secondaryCategory),
      name: clean(item?.name),
      specification: clean(item?.specification),
      location: clean(item?.location),
      ...(clean(item?.locationRecordId)
        ? { locationRecordId: clean(item?.locationRecordId) }
        : {}),
      brand: clean(item?.brand) || undefined,
      unit: clean(item?.unit) || undefined,
      minimumQuantity:
        item?.minimumQuantity === undefined ? undefined : item.minimumQuantity,
    },
  };
}

function normalizeExistingInboundRequest(
  request: InventoryExistingInboundMovementCreateRequest,
  building: WarehouseBuilding,
): InventoryExistingInboundMovementCreateRequest {
  return {
    type: 'inbound',
    mode: 'existing',
    clientMutationId: clean(request.clientMutationId),
    catalogRecordId: clean(request.catalogRecordId),
    sku: clean(request.sku).toUpperCase(),
    building,
    quantity: request.quantity,
    occurredAt: clean(request.occurredAt),
    applicantOpenId: clean(request.applicantOpenId) || undefined,
    operatorOpenId: clean(request.operatorOpenId) || undefined,
    reason: clean(request.reason) || undefined,
    destinationBuilding: request.destinationBuilding,
    expectedReturnAt: clean(request.expectedReturnAt) || undefined,
  };
}

function normalizeLegacyMovementRequest(
  request: InventoryMovementCreateLegacyRequest,
  type: InventoryMovementCreateLegacyRequest['type'],
  building: WarehouseBuilding,
): InventoryMovementCreateLegacyRequest {
  return {
    type,
    catalogRecordId: clean(request.catalogRecordId),
    sku: clean(request.sku).toUpperCase(),
    building,
    quantity: request.quantity,
    occurredAt: clean(request.occurredAt),
    applicantOpenId: clean(request.applicantOpenId) || undefined,
    operatorOpenId: clean(request.operatorOpenId) || undefined,
    reason: clean(request.reason) || undefined,
    destinationBuilding: request.destinationBuilding,
    expectedReturnAt: clean(request.expectedReturnAt) || undefined,
  };
}

function buildStrictInboundFingerprint(
  request:
    | TrustedInventoryNewInboundRequest
    | InventoryExistingInboundMovementCreateRequest,
): string {
  const common = {
    type: 'inbound',
    mode: request.mode,
    building: request.building,
    quantity: request.quantity,
    occurredAt: normalizeFingerprintDate(request.occurredAt, '入库日期', true),
    applicantOpenId: clean(request.applicantOpenId),
    operatorOpenId: clean(request.operatorOpenId),
    reason: clean(request.reason),
    destinationBuilding: clean(request.destinationBuilding),
    expectedReturnAt: normalizeFingerprintDate(
      request.expectedReturnAt,
      '预计归还日期',
      false,
    ),
  };
  const payload =
    request.mode === 'new'
      ? {
          ...common,
          newItem: {
            ...(request.newItem.specialty ? { specialty: clean(request.newItem.specialty) } : {}),
            primaryCategory: clean(request.newItem.primaryCategory),
            secondaryCategory: clean(request.newItem.secondaryCategory),
            name: clean(request.newItem.name),
            specification: clean(request.newItem.specification),
            location: clean(request.newItem.location),
            ...(clean(request.newItem.locationRecordId)
              ? {
                  locationRecordId: clean(request.newItem.locationRecordId),
                }
              : {}),
            brand: clean(request.newItem.brand),
            unit: clean(request.newItem.unit),
            minimumQuantity:
              request.newItem.minimumQuantity === undefined
                ? null
                : request.newItem.minimumQuantity,
          },
        }
      : {
          ...common,
          existingItem: {
            catalogRecordId: clean(request.catalogRecordId),
            sku: normalizeSku(request.sku),
          },
        };
  return createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
}

function singleStrictInboundFingerprint(
  fingerprint: string,
): StrictInboundFingerprints {
  return { current: fingerprint, accepted: new Set([fingerprint]) };
}

function buildStrictInboundFingerprints(
  request:
    | TrustedInventoryNewInboundRequest
    | InventoryExistingInboundMovementCreateRequest,
): StrictInboundFingerprints {
  const current = buildStrictInboundFingerprint(request);
  const accepted = new Set([current]);
  if (request.mode !== 'new') return { current, accepted };

  const hasLocationRecordId = Boolean(clean(request.newItem.locationRecordId));
  const minimumQuantity = request.newItem.minimumQuantity;
  const acceptsDefaultMinimum =
    minimumQuantity === undefined ||
    minimumQuantity === null ||
    minimumQuantity === 0;
  const addVariant = (
    omitLocationRecordId: boolean,
    defaultMinimum?: 0 | undefined,
  ) => {
    const newItem: PurchaseInboundNewItemInput = { ...request.newItem };
    if (omitLocationRecordId) delete newItem.locationRecordId;
    if (acceptsDefaultMinimum) newItem.minimumQuantity = defaultMinimum;
    accepted.add(buildStrictInboundFingerprint({ ...request, newItem }));
  };
  if (hasLocationRecordId)
    addVariant(true, minimumQuantity === 0 ? 0 : undefined);
  if (acceptsDefaultMinimum) {
    addVariant(false, undefined);
    addVariant(false, 0);
    if (hasLocationRecordId) {
      addVariant(true, undefined);
      addVariant(true, 0);
    }
  }
  return { current, accepted };
}

function normalizeFingerprintDate(
  value: unknown,
  fieldName: string,
  required: boolean,
): string {
  const text = clean(value);
  if (!text && !required) return '';
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new BadRequestException(`请输入有效${fieldName}`);
  }
  return new Date(timestamp).toISOString();
}

function findUniqueMarker(
  records: BitableRecordItem[],
  fieldName: string,
  sourceKey: string,
  tableName: string,
): BitableRecordItem | undefined {
  const matches = records.filter(
    (record) => fieldText(record.fields, [fieldName]) === sourceKey,
  );
  if (matches.length > 1) {
    throw consistencyConflict(
      `${tableName}存在重复的${fieldName} ${sourceKey}`,
    );
  }
  return matches[0];
}

function findUniqueRecord(
  records: BitableRecordItem[],
  label: string,
): BitableRecordItem {
  if (records.length === 0) {
    throw consistencyConflict(`${label}不存在`);
  }
  if (records.length > 1) {
    throw consistencyConflict(`${label}不唯一`);
  }
  return records[0];
}

function assertPersistedMarker(
  record: BitableRecordItem | undefined,
  markerField: string,
  sourceKey: string,
  fingerprint: string,
  tableName: string,
): asserts record is BitableRecordItem {
  if (!record) {
    throw consistencyConflict(`${tableName}标记记录不存在`);
  }
  if (fieldText(record.fields, [markerField]) !== sourceKey) {
    throw consistencyConflict(`${tableName}${markerField}不一致`);
  }
  if (fieldText(record.fields, ['入库请求指纹']) !== fingerprint) {
    throw consistencyConflict(`${tableName}入库请求指纹不一致`);
  }
}

function assertPersistedMarkerFingerprint(
  record: BitableRecordItem | undefined,
  markerField: string,
  sourceKey: string,
  fingerprints: StrictInboundFingerprints,
  tableName: string,
  request?: TrustedInventoryNewInboundRequest,
): string {
  if (!record) {
    throw consistencyConflict(`${tableName}标记记录不存在`);
  }
  if (fieldText(record.fields, [markerField]) !== sourceKey) {
    throw consistencyConflict(`${tableName}${markerField}不一致`);
  }
  const persisted = fieldText(record.fields, ['入库请求指纹']);
  if (!fingerprints.accepted.has(persisted)) {
    throw consistencyConflict(`${tableName}入库请求指纹不一致`);
  }
  if (request && persisted !== fingerprints.current) {
    assertPreparedCatalogLocationIdCompatible(record, request);
  }
  return persisted;
}

function assertPreparedCatalogLocationIdCompatible(
  record: BitableRecordItem,
  request: TrustedInventoryNewInboundRequest,
): void {
  const payload = parsePreparedCatalogPayload(record);
  if (!isRecord(payload.request) || !isRecord(payload.request.newItem)) {
    throw consistencyConflict('物品类别采购入库准备参数缺少请求内容');
  }
  const preparedLocationRecordId = clean(
    payload.request.newItem.locationRecordId,
  );
  const currentLocationRecordId = clean(request.newItem.locationRecordId);
  if (
    preparedLocationRecordId &&
    currentLocationRecordId &&
    preparedLocationRecordId !== currentLocationRecordId
  ) {
    throw consistencyConflict('物品类别存放位置记录不一致');
  }
}

function parsePersistedCatalog(
  record: BitableRecordItem,
): PersistedCatalogItem {
  const item: PersistedCatalogItem = {
    recordId: getRecordId(record),
    sku: normalizeSku(
      fieldText(record.fields, ['物品类别号', '物品类别号（单选）']),
    ),
    building: requireBuilding(record.fields, '物品类别'),
    name: fieldText(record.fields, ['名称']),
    specialty: fieldText(record.fields, ['专业']),
    specification: fieldText(record.fields, ['规格型号、设备序列号']),
    brand: fieldText(record.fields, ['品牌']),
    primaryCategory: fieldText(record.fields, ['一级分类']),
    secondaryCategory: fieldText(record.fields, ['二级分类']),
    unit: fieldText(record.fields, ['计数单位']),
    minimumQuantity: fieldOptionalNumber(record.fields, ['最小库存量']),
  };
  requirePersistedText(item.recordId, '物品类别 record_id');
  requirePersistedText(item.sku, '物品类别号');
  requirePersistedText(item.name, '物品类别名称');
  requirePersistedText(item.specification, '物品类别规格');
  requirePersistedText(item.primaryCategory, '物品类别一级分类');
  requirePersistedText(item.secondaryCategory, '物品类别二级分类');
  return item;
}

function parsePreparedCatalogPayload(
  record: BitableRecordItem,
): Record<string, unknown> {
  const raw = fieldText(record.fields, ['采购入库准备参数']);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw consistencyConflict('物品类别采购入库准备参数无效');
  }
  if (!isRecord(payload) || payload.version !== 1) {
    throw consistencyConflict('物品类别采购入库准备参数版本无效');
  }
  return payload;
}

function parsePreparedCatalogAt(record: BitableRecordItem): string {
  const payload = parsePreparedCatalogPayload(record);
  const preparedAt = clean(payload.preparedAt);
  const timestamp = Date.parse(preparedAt);
  if (!Number.isFinite(timestamp)) {
    throw consistencyConflict('物品类别采购入库准备时间无效');
  }
  return new Date(timestamp).toISOString();
}

function parsePersistedInventory(
  record: BitableRecordItem,
): PersistedInventoryItem {
  const storageLocation = firstNonEmptyFieldText(
    record.fields,
    getWarehouseInventoryFormalLocationReadFieldNames(),
  );
  const item: PersistedInventoryItem = {
    recordId: getRecordId(record),
    sku: normalizeSku(
      fieldText(record.fields, ['物品类别号', '物品类别号（单选）']),
    ),
    building: requireBuilding(record.fields, '库存台账'),
    location: firstNonEmptyFieldText(
      record.fields,
      getWarehouseInventoryLocationReadFieldNames(),
    ),
    storageLocation,
    initialQuantity: fieldOptionalNumber(record.fields, ['初始化库存数量']),
  };
  requirePersistedText(item.recordId, '库存台账 record_id');
  requirePersistedText(item.sku, '库存台账物品类别号');
  requirePersistedText(item.location, '库存台账存放位置');
  return item;
}

function parsePersistedInbound(
  record: BitableRecordItem,
): PersistedInboundItem {
  const quantity = fieldNumber(record.fields, ['入库数量']);
  const occurredAt = fieldDate(record.fields, ['入库日期']);
  const item: PersistedInboundItem = {
    recordId: getRecordId(record),
    sourceKey: fieldText(record.fields, ['入库来源']),
    fingerprint: fieldText(record.fields, ['入库请求指纹']),
    sku: normalizeSku(
      fieldText(record.fields, ['物品类别号', '物品类别号（单选）']),
    ),
    building: requireBuilding(record.fields, '入库填写'),
    quantity,
    occurredAt: occurredAt || '',
    operator: fieldText(record.fields, ['责任人', '入库责任人', '经办人']),
  };
  requirePersistedText(item.recordId, '入库填写 record_id');
  requirePersistedText(item.sourceKey, '入库来源');
  requirePersistedText(item.fingerprint, '入库请求指纹');
  requirePersistedText(item.sku, '入库填写物品类别号');
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw consistencyConflict('入库填写数量缺失或无效');
  }
  requirePersistedText(item.occurredAt, '入库填写日期');
  return item;
}

function assertNewCatalogMatchesRequest(
  catalog: PersistedCatalogItem,
  request: TrustedInventoryNewInboundRequest,
): void {
  const expected = request.newItem;
  if (expected.specialty) assertPersistedEqual(catalog.specialty || '', expected.specialty, '物品类别专业');
  assertPersistedEqual(catalog.building, request.building, '物品类别楼栋');
  assertPersistedEqual(
    catalog.primaryCategory,
    clean(expected.primaryCategory),
    '物品类别一级分类',
  );
  assertPersistedEqual(
    catalog.secondaryCategory,
    clean(expected.secondaryCategory),
    '物品类别二级分类',
  );
  assertPersistedEqual(catalog.name, clean(expected.name), '物品类别名称');
  assertPersistedEqual(
    catalog.specification,
    clean(expected.specification),
    '物品类别规格',
  );
  if (expected.brand !== undefined) {
    assertPersistedEqual(catalog.brand, clean(expected.brand), '物品类别品牌');
  }
  if (expected.unit !== undefined) {
    assertPersistedEqual(
      catalog.unit,
      clean(expected.unit),
      '物品类别计数单位',
    );
  }
  assertPersistedEqual(
    catalog.minimumQuantity ?? 0,
    expected.minimumQuantity ?? 0,
    '物品类别最小库存量',
  );
}

function assertExistingCatalogMatchesRequest(
  catalog: PersistedCatalogItem,
  request: InventoryExistingInboundMovementCreateRequest,
): void {
  assertPersistedEqual(
    catalog.recordId,
    clean(request.catalogRecordId),
    '物品类别 record_id',
  );
  assertPersistedEqual(catalog.sku, normalizeSku(request.sku), '物品类别号');
  assertPersistedEqual(catalog.building, request.building, '物品类别楼栋');
}

function assertNewInventoryMatchesRequest(
  inventory: PersistedInventoryItem,
  catalog: PersistedCatalogItem,
  request: TrustedInventoryNewInboundRequest,
): void {
  assertCatalogInventoryAssociation(catalog, inventory);
  assertPersistedEqual(
    inventory.location,
    clean(request.newItem.location),
    '库存台账存放位置',
  );
  assertPersistedEqual(
    inventory.storageLocation,
    clean(request.newItem.location),
    '库存台账存放位置字段',
  );
  assertPersistedEqual(inventory.initialQuantity, 0, '库存台账初始化库存数量');
}

function assertCatalogInventoryAssociation(
  catalog: PersistedCatalogItem,
  inventory: PersistedInventoryItem,
): void {
  assertPersistedEqual(inventory.sku, catalog.sku, '库存台账物品类别号');
  assertPersistedEqual(inventory.building, catalog.building, '库存台账楼栋');
}

function assertInboundMatchesRequest(
  inbound: PersistedInboundItem,
  catalog: PersistedCatalogItem,
  inventory: PersistedInventoryItem,
  request:
    | InventoryNewInboundMovementCreateRequest
    | TrustedInventoryNewInboundRequest
    | InventoryExistingInboundMovementCreateRequest,
  sourceKey: string,
  fingerprint: string,
): void {
  assertCatalogInventoryAssociation(catalog, inventory);
  assertPersistedEqual(inbound.sourceKey, sourceKey, '入库来源');
  assertPersistedEqual(inbound.fingerprint, fingerprint, '入库请求指纹');
  assertPersistedEqual(inbound.sku, catalog.sku, '入库填写物品类别号');
  assertPersistedEqual(inbound.sku, inventory.sku, '入库填写库存关联');
  assertPersistedEqual(inbound.building, catalog.building, '入库填写楼栋');
  assertPersistedEqual(inbound.building, request.building, '入库目标楼栋');
  assertPersistedEqual(inbound.quantity, request.quantity, '入库数量');
  assertPersistedEqual(
    inbound.occurredAt,
    normalizeFingerprintDate(request.occurredAt, '入库日期', true),
    '入库日期',
  );
}

function toMovementOption(
  catalog: PersistedCatalogItem,
  inventory: PersistedInventoryItem,
): InventoryMovementOptionItem {
  return {
    catalogRecordId: catalog.recordId,
    inventoryRecordId: inventory.recordId,
    sku: catalog.sku,
    name: catalog.name,
    specification: catalog.specification,
    brand: catalog.brand,
    primaryCategory: catalog.primaryCategory,
    secondaryCategory: catalog.secondaryCategory,
    building: catalog.building,
    location: inventory.location,
    unit: catalog.unit,
    availableQuantity: 0,
  };
}

function buildPersistedInboundResult(
  catalog: PersistedCatalogItem,
  inventory: PersistedInventoryItem,
  inbound: PersistedInboundItem,
  alreadyProcessed: boolean,
): TrustedInventoryInboundResult {
  const movement: InventoryMovementItem & {
    brand: string;
    primaryCategory: string;
    secondaryCategory: string;
    categories: string[];
  } = {
    recordId: inbound.recordId,
    pendingSync: false,
    type: 'inbound',
    sku: inbound.sku,
    name: catalog.name,
    specification: catalog.specification,
    brand: catalog.brand,
    primaryCategory: catalog.primaryCategory,
    secondaryCategory: catalog.secondaryCategory,
    categories: [catalog.primaryCategory, catalog.secondaryCategory],
    quantity: inbound.quantity,
    unit: catalog.unit,
    building: inbound.building,
    destinationBuilding: '',
    location: inventory.location,
    reason: '',
    operator: inbound.operator,
    applicant: '',
    status: '已入库',
    occurredAt: inbound.occurredAt,
    expectedReturnAt: null,
    overdue: false,
  };
  return {
    response: {
      success: true,
      recordId: inbound.recordId,
      type: 'inbound',
      message: '入库记录已提交',
      movement,
    },
    catalogRecordId: catalog.recordId,
    inventoryRecordId: inventory.recordId,
    inboundRecordId: inbound.recordId,
    alreadyProcessed,
  };
}

function withTransportMutation(
  result: TrustedInventoryInboundResult,
  clientMutationId: string,
): TrustedInventoryInboundResult {
  return {
    ...result,
    response: {
      ...result.response,
      movement: {
        ...result.response.movement,
        clientMutationId,
      },
    },
  };
}

function buildOptionalCatalogFields(
  item: PurchaseInboundNewItemInput,
): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  if (item.brand !== undefined) fields.品牌 = clean(item.brand);
  if (item.unit !== undefined) fields.计数单位 = clean(item.unit);
  if (item.minimumQuantity !== undefined) {
    fields.最小库存量 = item.minimumQuantity;
  }
  return fields;
}

function assertSecondaryCategoryPrimaryCategory(
  categoryCatalogRecords: BitableRecordItem[],
  request: TrustedInventoryNewInboundRequest,
): void {
  const conflictingPrimaryCategory = categoryCatalogRecords
    .map((record) => fieldText(record.fields, ['一级分类']))
    .find(
      (primaryCategory) =>
        primaryCategory && primaryCategory !== request.newItem.primaryCategory,
    );
  if (conflictingPrimaryCategory) {
    throw new BadRequestException(
      `二级分类“${request.newItem.secondaryCategory}”已归属一级分类“${conflictingPrimaryCategory}”`,
    );
  }
}

function generateSkuForNewInbound(
  categoryCatalogRecords: BitableRecordItem[],
  request: TrustedInventoryNewInboundRequest,
): string {
  try {
    return generateInventorySku({
      secondaryCategory: request.newItem.secondaryCategory,
      catalogRecords: categoryCatalogRecords.map((record) => ({
        building: fieldText(record.fields, ['楼栋']),
        secondaryCategory: fieldText(record.fields, ['二级分类']),
        sku: fieldText(record.fields, ['物品类别号', '物品类别号（单选）']),
      })),
    });
  } catch (error) {
    throw asBadRequest(error);
  }
}

function normalizeSku(value: unknown): string {
  return clean(value).toUpperCase();
}

function assertTrustedSourceKey(
  sourceKey: string,
  request: TrustedInventoryInboundRequest,
): void {
  if (!/^(手工|采购):[^\r\n]{1,128}$/u.test(sourceKey)) {
    throw new BadRequestException('入库来源标识格式无效');
  }
  if (
    sourceKey.startsWith('手工:') &&
    sourceKey !== `手工:${clean(request.clientMutationId)}`
  ) {
    throw new BadRequestException('手工入库来源标识与请求标识不一致');
  }
}

function requireBuilding(
  fields: Record<string, unknown> | undefined,
  tableName: string,
): WarehouseBuilding {
  const building = fieldBuilding(fields, ['楼栋']);
  if (!building) {
    throw consistencyConflict(`${tableName}楼栋缺失或无效`);
  }
  return building;
}

function requirePersistedText(value: string, label: string): void {
  if (!value) throw consistencyConflict(`${label}缺失`);
}

function assertPersistedEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (actual !== expected) {
    throw consistencyConflict(`${label}与请求或关联记录不一致`);
  }
}

function consistencyConflict(message: string): ConflictException {
  return new ConflictException(`入库数据一致性冲突：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecordId(record: BitableRecordItem | undefined): string {
  return clean(record?.record_id || record?.id);
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

function fieldNumber(
  fields: Record<string, unknown> | undefined,
  names: string[],
): number {
  const value = fieldValue(fields, names);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(displayValues(value).join(''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fieldOptionalNumber(
  fields: Record<string, unknown> | undefined,
  names: string[],
): number | null {
  const value = fieldValue(fields, names);
  if (
    value === null ||
    value === undefined ||
    displayValues(value).length === 0
  ) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(displayValues(value).join(''));
  return Number.isFinite(parsed) ? parsed : null;
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

function fieldDate(
  fields: Record<string, unknown> | undefined,
  names: string[],
): string | null {
  const value = fieldValue(fields, names);
  const timestamp =
    typeof value === 'number' ? value : Date.parse(fieldText(fields, names));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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

function asBadRequest(error: unknown): BadRequestException {
  if (error instanceof BadRequestException) return error;
  return new BadRequestException(
    error instanceof Error ? error.message : String(error),
  );
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

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseType(value: unknown): InventoryMovementType {
  if (value === 'inbound' || value === 'outbound' || value === 'borrow') {
    return value;
  }
  throw new BadRequestException('未知库存业务类型');
}

function parseBuilding(value: unknown): WarehouseBuilding {
  const building = String(value || '') as WarehouseBuilding;
  if (WAREHOUSE_BUILDINGS.includes(building)) return building;
  throw new BadRequestException('请选择有效楼栋');
}
