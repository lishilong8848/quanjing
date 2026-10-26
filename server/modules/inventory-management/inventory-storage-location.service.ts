import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  WarehouseBuilding,
  WarehouseStorageLocation,
  WarehouseStorageLocationCreateRequest,
  WarehouseStorageLocationCreateResponse,
  WarehouseStorageLocationQuery,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  resolveBitableAppToken,
  type BitableRecordItem,
  type BitableRecordSearchFilter,
} from '../../common/feishu/bitable-direct-read';
import {
  filterStorageLocations,
  normalizeStorageLocationName,
  parseStorageLocationRecord,
  storageLocationKey,
  validateStorageLocationCreateRequest,
} from './inventory-storage-location.rules';
import {
  InventoryWorkflowGateway,
  InventoryWorkflowRecordNotFoundError,
} from './inventory-workflow.gateway';

const STORAGE_LOCATION_TABLE_NAME = '配置库房货架名称';
const STORAGE_LOCATION_TABLE_ID_FALLBACK = 'tbla1c285ee74476';
const STORAGE_LOCATION_COMPANY = '南通承宏';
const STORAGE_LOCATION_CACHE_TTL_MS = 30_000;
const COMPLETED_MUTATION_TTL_MS = 5 * 60_000;
const COMPLETED_MUTATION_MAX_ENTRIES = 500;
const UNCERTAIN_WRITE_TTL_MS = 2 * 60_000;

interface StorageLocationSource {
  appToken: string;
  tableId: string;
  cacheKey: string;
}

interface StorageLocationCache {
  sourceKey: string;
  expiresAt: number;
  items: WarehouseStorageLocation[];
}

interface ActiveStorageLocationRead {
  epoch: number;
  promise: Promise<WarehouseStorageLocation[]>;
}

interface RunningStorageLocationCreate {
  fingerprint: string;
  promise: Promise<WarehouseStorageLocationCreateResponse>;
}

interface CompletedStorageLocationCreate {
  fingerprint: string;
  completedAt: number;
  response: WarehouseStorageLocationCreateResponse;
}

interface UncertainStorageLocationCreate {
  mutationId: string;
  fingerprint: string;
  businessKey: string;
  recordId?: string;
  markedAt: number;
}

@Injectable()
export class InventoryStorageLocationService {
  private cache: StorageLocationCache | null = null;
  private readonly buildingCaches = new Map<
    WarehouseBuilding,
    StorageLocationCache
  >();
  private readonly reads = new Map<string, ActiveStorageLocationRead>();
  private readonly runningByMutationId = new Map<
    string,
    RunningStorageLocationCreate
  >();
  private readonly completedByMutationId = new Map<
    string,
    CompletedStorageLocationCreate
  >();
  private readonly serialByBusinessKey = new Map<string, Promise<void>>();
  private readonly cacheEpochBySource = new Map<string, number>();
  private readonly uncertainByMutationId = new Map<
    string,
    UncertainStorageLocationCreate
  >();
  private readonly uncertainByBusinessKey = new Map<
    string,
    UncertainStorageLocationCreate
  >();

  constructor(
    private readonly httpService: HttpService,
    private readonly gateway: InventoryWorkflowGateway,
  ) {}

  async list(
    query: WarehouseStorageLocationQuery,
  ): Promise<WarehouseStorageLocation[]> {
    const building = requireBuilding(query?.building);
    const source = await this.resolveSource();
    const items = await this.readBuildingItems(source, building);
    return filterStorageLocations(items, {
      building,
      query: typeof query?.query === 'string' ? query.query : '',
      limit: typeof query?.limit === 'number' ? query.limit : undefined,
    });
  }

  async create(
    request: WarehouseStorageLocationCreateRequest,
  ): Promise<WarehouseStorageLocationCreateResponse> {
    const normalized = validateStorageLocationCreateRequest(request);
    const fingerprint = createFingerprint(normalized);
    const businessKey = storageLocationKey(
      normalized.building,
      normalized.name,
    );
    const completed = this.completedByMutationId.get(
      normalized.clientMutationId,
    );
    if (completed) {
      if (Date.now() - completed.completedAt > COMPLETED_MUTATION_TTL_MS) {
        this.completedByMutationId.delete(normalized.clientMutationId);
      } else {
        if (completed.fingerprint !== fingerprint) {
          throw new ConflictException('请求标识已被另一份存放位置占用');
        }
        return cloneCreateResponse(completed.response);
      }
    }
    const active = this.runningByMutationId.get(normalized.clientMutationId);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        throw new ConflictException('请求标识已被另一份存放位置占用');
      }
      return active.promise.then(cloneCreateResponse);
    }
    const uncertain = this.findUncertainCreate(
      normalized.clientMutationId,
      fingerprint,
      businessKey,
    );
    const serialized = this.runBusinessSerial(businessKey, () =>
      uncertain
        ? this.reconcileUncertainCreate(normalized, uncertain)
        : this.createOnce(normalized),
    );
    const operation = serialized.then((response) => {
      if (uncertain) this.clearUncertainCreate(uncertain);
      this.rememberCompletedMutation(
        normalized.clientMutationId,
        fingerprint,
        response,
      );
      return cloneCreateResponse(response);
    });
    this.runningByMutationId.set(normalized.clientMutationId, {
      fingerprint,
      promise: operation,
    });
    const clear = () => {
      if (
        this.runningByMutationId.get(normalized.clientMutationId)?.promise ===
        operation
      ) {
        this.runningByMutationId.delete(normalized.clientMutationId);
      }
    };
    void operation.then(clear, clear);
    return operation.then(cloneCreateResponse);
  }

  async resolveSelectedLocation(
    buildingValue: WarehouseBuilding,
    recordIdValue: string,
    nameValue: string,
  ): Promise<WarehouseStorageLocation> {
    const building = requireBuilding(buildingValue);
    const recordId = clean(recordIdValue);
    const name = normalizeStorageLocationName(nameValue);
    if (!recordId || !name) {
      throw new BadRequestException('请选择底表中的存放位置');
    }
    const source = await this.resolveSource();
    let record: BitableRecordItem;
    try {
      record = await this.gateway.getRecord(
        source.appToken,
        source.tableId,
        recordId,
        STORAGE_LOCATION_TABLE_NAME,
      );
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordNotFoundError) {
        throw new BadRequestException('所选存放位置不存在，请重新选择');
      }
      throw error;
    }
    const item = parseStorageLocationRecord(record);
    if (
      !item ||
      item.recordId !== recordId ||
      item.company !== STORAGE_LOCATION_COMPANY ||
      item.building !== building ||
      storageLocationKey(item.building, item.name) !==
        storageLocationKey(building, name)
    ) {
      throw new BadRequestException('所选存放位置与当前楼栋不匹配');
    }
    return item;
  }

  private async createOnce(
    request: WarehouseStorageLocationCreateRequest,
  ): Promise<WarehouseStorageLocationCreateResponse> {
    const source = await this.resolveSource();
    const items = await this.readItems(source, true);
    const key = storageLocationKey(request.building, request.name);
    const existing = items.find(
      (item) =>
        item.company === STORAGE_LOCATION_COMPANY &&
        storageLocationKey(item.building, item.name) === key,
    );
    if (existing) {
      return {
        item: existing,
        alreadyExists: true,
        clientMutationId: request.clientMutationId,
      };
    }

    let recordId = '';
    let persistedRecord: BitableRecordItem;
    try {
      recordId = await this.gateway.createRecord(
        source.appToken,
        source.tableId,
        {
          楼栋: request.building,
          所属公司: STORAGE_LOCATION_COMPANY,
          存放位置分类: request.category,
          存放位置: request.name,
        },
        STORAGE_LOCATION_TABLE_NAME,
      );
      persistedRecord = await this.gateway.getRecord(
        source.appToken,
        source.tableId,
        recordId,
        STORAGE_LOCATION_TABLE_NAME,
      );
    } catch (error) {
      this.invalidateCache(source.cacheKey);
      if (recordId || isUncertainWriteFailure(error)) {
        this.rememberUncertainCreate(request, key, recordId || undefined);
      }
      throw error;
    }
    this.invalidateCache(source.cacheKey);
    const persisted = parseStorageLocationRecord(persistedRecord);
    if (!matchesCreatedLocation(persisted, request, recordId, key)) {
      this.rememberUncertainCreate(request, key, recordId);
      throw new ConflictException('新增存放位置回读校验失败，请稍后重试');
    }
    return {
      item: persisted,
      alreadyExists: false,
      clientMutationId: request.clientMutationId,
    };
  }

  private async reconcileUncertainCreate(
    request: WarehouseStorageLocationCreateRequest,
    uncertain: UncertainStorageLocationCreate,
  ): Promise<WarehouseStorageLocationCreateResponse> {
    const source = await this.resolveSource();
    const key = storageLocationKey(request.building, request.name);
    if (uncertain.recordId) {
      try {
        const record = await this.gateway.getRecord(
          source.appToken,
          source.tableId,
          uncertain.recordId,
          STORAGE_LOCATION_TABLE_NAME,
        );
        const item = parseStorageLocationRecord(record);
        if (matchesCreatedLocation(item, request, uncertain.recordId, key)) {
          return {
            item,
            alreadyExists: true,
            clientMutationId: request.clientMutationId,
          };
        }
        if (item) {
          throw new ConflictException('新增存放位置回读数据不一致');
        }
      } catch (error) {
        if (!(error instanceof InventoryWorkflowRecordNotFoundError)) {
          throw error;
        }
      }
    }

    const items = await this.readItems(source, true);
    const existing = items.find(
      (item) =>
        item.company === STORAGE_LOCATION_COMPANY &&
        storageLocationKey(item.building, item.name) === key,
    );
    if (existing) {
      return {
        item: existing,
        alreadyExists: true,
        clientMutationId: request.clientMutationId,
      };
    }
    throw new ServiceUnavailableException(
      '新增存放位置结果仍在确认中，请稍后使用原草稿重试',
    );
  }

  private async resolveSource(): Promise<StorageLocationSource> {
    const sourceUrl = readEnv('FEISHU_WAREHOUSE_SOURCE_URL');
    const parsed = parseFeishuBitableLink(sourceUrl);
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || parsed.appToken,
      wikiToken: parsed.wikiToken,
      tableName: '南通运维全景驾驶舱-库房管理',
    });
    if (!appToken) throw new Error('库房多维表 app token 未配置');
    const tableId =
      readEnv('FEISHU_WAREHOUSE_STORAGE_LOCATION_TABLE_ID') ||
      STORAGE_LOCATION_TABLE_ID_FALLBACK;
    return {
      appToken,
      tableId,
      cacheKey: `${appToken}:${tableId}`,
    };
  }

  private readItems(
    source: StorageLocationSource,
    forceRefresh: boolean,
  ): Promise<WarehouseStorageLocation[]> {
    if (
      !forceRefresh &&
      this.cache?.sourceKey === source.cacheKey &&
      this.cache.expiresAt > Date.now()
    ) {
      return Promise.resolve(this.cache.items);
    }
    const readEpoch = this.cacheEpochBySource.get(source.cacheKey) || 0;
    const active = this.reads.get(source.cacheKey);
    if (active?.epoch === readEpoch) return active.promise;

    const operation = this.gateway
      .searchRecords({
        appToken: source.appToken,
        tableId: source.tableId,
        tableName: STORAGE_LOCATION_TABLE_NAME,
      })
      .then((records) =>
        records
          .map(parseStorageLocationRecord)
          .filter(
            (item): item is WarehouseStorageLocation =>
              Boolean(item) && item?.company === STORAGE_LOCATION_COMPANY,
          ),
      )
      .then((items) => {
        if ((this.cacheEpochBySource.get(source.cacheKey) || 0) === readEpoch) {
          this.cache = {
            sourceKey: source.cacheKey,
            expiresAt: Date.now() + STORAGE_LOCATION_CACHE_TTL_MS,
            items,
          };
        }
        return items;
      });
    this.reads.set(source.cacheKey, { epoch: readEpoch, promise: operation });
    const clear = () => {
      if (this.reads.get(source.cacheKey)?.promise === operation) {
        this.reads.delete(source.cacheKey);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private readBuildingItems(
    source: StorageLocationSource,
    building: WarehouseBuilding,
  ): Promise<WarehouseStorageLocation[]> {
    if (
      this.cache?.sourceKey === source.cacheKey &&
      this.cache.expiresAt > Date.now()
    ) {
      return Promise.resolve(this.cache.items);
    }
    const cached = this.buildingCaches.get(building);
    if (
      cached?.sourceKey === source.cacheKey &&
      cached.expiresAt > Date.now()
    ) {
      return Promise.resolve(cached.items);
    }
    const readKey = JSON.stringify([source.cacheKey, building]);
    const readEpoch = this.cacheEpochBySource.get(source.cacheKey) || 0;
    const active = this.reads.get(readKey);
    if (active?.epoch === readEpoch) return active.promise;

    const filter: BitableRecordSearchFilter = {
      conjunction: 'and',
      conditions: [{ field_name: '楼栋', operator: 'is', value: [building] }],
    };
    const operation = this.gateway
      .searchRecords({
        appToken: source.appToken,
        tableId: source.tableId,
        tableName: STORAGE_LOCATION_TABLE_NAME,
        filter,
      })
      .then((records) =>
        records
          .map(parseStorageLocationRecord)
          .filter(
            (item): item is WarehouseStorageLocation =>
              Boolean(item) &&
              item?.company === STORAGE_LOCATION_COMPANY &&
              item?.building === building,
          ),
      )
      .catch((error: unknown) => {
        if (!isUnsupportedStorageLocationFilter(error)) throw error;
        return this.readItems(source, false).then((items) =>
          items.filter((item) => item.building === building),
        );
      })
      .then((items) => {
        if ((this.cacheEpochBySource.get(source.cacheKey) || 0) === readEpoch) {
          this.buildingCaches.set(building, {
            sourceKey: source.cacheKey,
            expiresAt: Date.now() + STORAGE_LOCATION_CACHE_TTL_MS,
            items,
          });
        }
        return items;
      });
    this.reads.set(readKey, { epoch: readEpoch, promise: operation });
    const clear = () => {
      if (this.reads.get(readKey)?.promise === operation) {
        this.reads.delete(readKey);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private runBusinessSerial<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.serialByBusinessKey.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.serialByBusinessKey.set(key, tail);
    void tail.then(() => {
      if (this.serialByBusinessKey.get(key) === tail) {
        this.serialByBusinessKey.delete(key);
      }
    });
    return current;
  }

  private rememberCompletedMutation(
    mutationId: string,
    fingerprint: string,
    response: WarehouseStorageLocationCreateResponse,
  ): void {
    this.completedByMutationId.delete(mutationId);
    this.completedByMutationId.set(mutationId, {
      fingerprint,
      completedAt: Date.now(),
      response: cloneCreateResponse(response),
    });
    while (this.completedByMutationId.size > COMPLETED_MUTATION_MAX_ENTRIES) {
      const oldest = this.completedByMutationId.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.completedByMutationId.delete(oldest);
    }
  }

  private findUncertainCreate(
    mutationId: string,
    fingerprint: string,
    businessKey: string,
  ): UncertainStorageLocationCreate | null {
    const byMutation = this.freshUncertain(
      this.uncertainByMutationId.get(mutationId),
    );
    if (byMutation && byMutation.fingerprint !== fingerprint) {
      throw new ConflictException('请求标识已被另一份存放位置占用');
    }
    return (
      byMutation ||
      this.freshUncertain(this.uncertainByBusinessKey.get(businessKey))
    );
  }

  private freshUncertain(
    entry: UncertainStorageLocationCreate | undefined,
  ): UncertainStorageLocationCreate | null {
    if (!entry) return null;
    if (Date.now() - entry.markedAt <= UNCERTAIN_WRITE_TTL_MS) return entry;
    this.clearUncertainCreate(entry);
    return null;
  }

  private rememberUncertainCreate(
    request: WarehouseStorageLocationCreateRequest,
    businessKey: string,
    recordId?: string,
  ): void {
    const entry: UncertainStorageLocationCreate = {
      mutationId: request.clientMutationId,
      fingerprint: createFingerprint(request),
      businessKey,
      ...(recordId ? { recordId } : {}),
      markedAt: Date.now(),
    };
    this.uncertainByMutationId.set(entry.mutationId, entry);
    this.uncertainByBusinessKey.set(entry.businessKey, entry);
  }

  private clearUncertainCreate(entry: UncertainStorageLocationCreate): void {
    if (this.uncertainByMutationId.get(entry.mutationId) === entry) {
      this.uncertainByMutationId.delete(entry.mutationId);
    }
    if (this.uncertainByBusinessKey.get(entry.businessKey) === entry) {
      this.uncertainByBusinessKey.delete(entry.businessKey);
    }
  }

  private invalidateCache(sourceKey: string): void {
    this.cacheEpochBySource.set(
      sourceKey,
      (this.cacheEpochBySource.get(sourceKey) || 0) + 1,
    );
    if (this.cache?.sourceKey === sourceKey) this.cache = null;
    for (const [building, cached] of this.buildingCaches) {
      if (cached.sourceKey === sourceKey) this.buildingCaches.delete(building);
    }
  }
}

function isUnsupportedStorageLocationFilter(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    feishuCode?: unknown;
    message?: unknown;
    response?: { data?: { code?: unknown; msg?: unknown } };
  };
  if (
    Number(candidate.feishuCode ?? candidate.response?.data?.code) === 1254018
  ) {
    return true;
  }
  const message =
    clean(candidate.response?.data?.msg) || clean(candidate.message);
  return /(?:filter|筛选|过滤).*(?:unsupported|not support(?:ed)?|不支持)|(?:unsupported|not support(?:ed)?|不支持).*(?:filter|筛选|过滤)/iu.test(
    message,
  );
}

function requireBuilding(value: unknown): WarehouseBuilding {
  const building =
    typeof value === 'string'
      ? WAREHOUSE_BUILDINGS.find((item) => item === value.trim())
      : undefined;
  if (!building) throw new BadRequestException('请选择有效楼栋');
  return building;
}

function createFingerprint(
  request: WarehouseStorageLocationCreateRequest,
): string {
  return JSON.stringify([
    request.building,
    request.category,
    normalizeStorageLocationName(request.name).toLocaleLowerCase('zh-CN'),
  ]);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneCreateResponse(
  response: WarehouseStorageLocationCreateResponse,
): WarehouseStorageLocationCreateResponse {
  return { ...response, item: { ...response.item } };
}

function isUncertainWriteFailure(error: unknown): boolean {
  const code =
    error && typeof error === 'object'
      ? clean((error as { code?: unknown }).code).toUpperCase()
      : '';
  if (
    [
      'EAI_AGAIN',
      'ECONNABORTED',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETDOWN',
      'ENETUNREACH',
      'ENOTFOUND',
      'EPIPE',
      'ERR_NETWORK',
      'ETIMEDOUT',
    ].includes(code)
  ) {
    return true;
  }
  const responseStatus =
    error && typeof error === 'object'
      ? Number(
          (error as { response?: { status?: unknown }; status?: unknown })
            .response?.status ||
            (error as { status?: unknown }).status ||
            0,
        )
      : 0;
  return [502, 503, 504].includes(responseStatus);
}

function matchesCreatedLocation(
  item: WarehouseStorageLocation | null,
  request: WarehouseStorageLocationCreateRequest,
  recordId: string,
  expectedKey: string,
): item is WarehouseStorageLocation {
  return Boolean(
    item &&
    item.recordId === recordId &&
    item.company === STORAGE_LOCATION_COMPANY &&
    item.building === request.building &&
    item.category === request.category &&
    storageLocationKey(item.building, item.name) === expectedKey,
  );
}
