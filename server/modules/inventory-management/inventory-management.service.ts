import { businessPermissionScopeKey, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings } from '../../../shared/building-access';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  InventoryItemsQuery,
  InventoryItemsResponse,
  InventoryManagementDashboard,
  InventoryManagementSourceStatus,
  InventoryMovementsQuery,
  InventoryMovementsResponse,
  InventorySourceKey,
} from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  createBitableBackgroundRefresh,
  fetchBitableRecords,
  getRecordId,
  getBitableRecordCacheGeneration,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  buildInventoryManagementSnapshot,
  projectInventoryItems,
  projectInventoryMovementRows,
  queryInventoryItems,
  queryInventoryMovements,
  scopedInventoryItem,
} from './inventory-management.mapper';
import { describeInventoryLedgerImages, findInventoryLedgerImage, INVENTORY_PHOTO_FIELD, InventoryInboundPhotoService } from './inventory-inbound-photo.service';
import { InventoryWorkflowGateway } from './inventory-workflow.gateway';
import { canPerformBusinessAction } from '../../../shared/business-permissions';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const SCOPED_DASHBOARD_TTL_MS = 30_000;
const SCOPED_DASHBOARD_CACHE_LIMIT = 64;
const PHOTO_METADATA_TTL_MS = 60_000;
const PHOTO_METADATA_FIRST_READ_WAIT_MS = 800;
const BITABLE_READ_CONFLICT = '数据在读取期间已变更，请重新读取';

const TABLES: Record<InventorySourceKey, { name: string; env: string }> = {
  inventory: {
    name: '库存台账',
    env: 'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
  },
  inbound: {
    name: '入库填写',
    env: 'FEISHU_WAREHOUSE_INBOUND_TABLE_ID',
  },
  outbound: {
    name: '出库填写',
    env: 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  },
  borrow: {
    name: '借调填写',
    env: 'FEISHU_WAREHOUSE_BORROW_TABLE_ID',
  },
  catalog: {
    name: '物品类别',
    env: 'FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
  },
  prices: {
    name: '库房物资价格',
    env: 'FEISHU_WAREHOUSE_PRICE_TABLE_ID',
  },
  stocktake: {
    name: '盘点记录表',
    env: 'FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID',
  },
  managers: {
    name: '配置楼栋负责人',
    env: 'FEISHU_WAREHOUSE_MANAGER_TABLE_ID',
  },
};

interface SectionReadResult {
  records: BitableRecordItem[];
  status: InventoryManagementSourceStatus;
}

interface DashboardCacheEntry {
  expiresAt: number;
  value?: InventoryManagementDashboard;
  request?: Promise<InventoryManagementDashboard>;
}

@Injectable()
export class InventoryManagementService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryManagementService.name);
  private readonly dashboards = new Map<string, DashboardCacheEntry>();
  private inventoryPhotoMetadata?: {
    key: string;
    expiresAt: number;
    photos: Map<string, NonNullable<InventoryItemsResponse['items'][number]['images']>>;
  };
  private inventoryPhotoRead?: { key: string; pending: Promise<void> };
  private inventoryPhotoRetryAfter?: { key: string; at: number };
  private attachmentField?: { key: string; expiresAt: number; pending: Promise<string> };
  private readonly backgroundRefresh = createBitableBackgroundRefresh({
    name: InventoryManagementService.name,
    warm: async () => {
      await this.getDashboard(false);
    },
    refresh: async () => {
      await this.getDashboard(true);
    },
  });

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly photoService?: InventoryInboundPhotoService,
    @Optional() private readonly inventoryGateway?: InventoryWorkflowGateway,
  ) {}

  onModuleInit(): void {
    this.backgroundRefresh.start();
  }

  onModuleDestroy(): void {
    this.backgroundRefresh.stop();
  }

  invalidateCache(): void {
    this.sourceReads.clear();
    this.dashboards.clear();
    this.inventoryPhotoMetadata = undefined;
    this.inventoryPhotoRead = undefined;
    this.inventoryPhotoRetryAfter = undefined;
  }

  async getDashboard(
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<InventoryManagementDashboard> {
    const scoped = principal && (isProfessionalBusinessPrincipal(principal) || accessBuildings(principal) !== null)
      ? principal
      : undefined;
    const key = scoped ? businessPermissionScopeKey(scoped) : '';
    let entry = this.dashboards.get(key);
    if (!forceRefresh && entry?.value && entry.expiresAt > Date.now()) return entry.value;
    if (entry?.request) {
      if (!forceRefresh) return entry.request;
      try {
        await entry.request;
      } catch {
        // A forced refresh still needs a fresh attempt after an older read fails.
      }
      return this.getDashboard(true, principal);
    }
    if (!entry) {
      entry = { expiresAt: 0 };
      if (scoped && this.dashboards.size >= SCOPED_DASHBOARD_CACHE_LIMIT) {
        const removable = [...this.dashboards].find(([scope, state]) => scope && !state.request);
        if (removable) this.dashboards.delete(removable[0]);
      }
      if (!scoped || this.dashboards.size < SCOPED_DASHBOARD_CACHE_LIMIT) this.dashboards.set(key, entry);
    }
    const state = entry;
    const request = this.buildDashboard(forceRefresh, scoped).then((dashboard) => {
      if (hasConfiguredSectionFailure(dashboard)) {
        if (state.value && !scoped) {
          this.logger.warn('库存数据刷新不完整，继续使用最近一次成功看板并等待下次刷新');
          return state.value;
        }
        return dashboard;
      }
      state.value = dashboard;
      state.expiresAt = Date.now() + (scoped ? SCOPED_DASHBOARD_TTL_MS : CACHE_TTL_MS);
      return dashboard;
    }).catch((error) => {
      if (!state.value || scoped) throw error;
      this.logger.warn(`库存数据刷新失败，继续使用最近一次成功看板：${safeErrorMessage(error)}`);
      return state.value;
    });
    state.request = request;
    try {
      return await request;
    } finally {
      if (state.request === request) state.request = undefined;
    }
  }

  private async buildDashboard(
    forceRefresh: boolean,
    principal?: AccessPrincipal,
  ): Promise<InventoryManagementDashboard> {
    const { appToken, sourceUrl } = await this.resolveSource();
    const entries = await Promise.all(
      (
        Object.entries(TABLES) as Array<
          [InventorySourceKey, (typeof TABLES)[InventorySourceKey]]
        >
      ).map(
        async ([key, table]) =>
          [key, await this.readSection(appToken, table, forceRefresh)] as const,
      ),
    );
    const sections = Object.fromEntries(entries) as Record<
      InventorySourceKey,
      SectionReadResult
    >;
    const sectionStatus = Object.fromEntries(
      (
        Object.entries(sections) as Array<
          [InventorySourceKey, SectionReadResult]
        >
      ).map(([key, section]) => [key, section.status]),
    ) as InventoryManagementDashboard['sectionStatus'];

    return buildInventoryManagementSnapshot({
      principal,
      generatedAt: new Date().toISOString(),
      sourceUrl,
      inventory: sections.inventory.records,
      catalog: sections.catalog.records,
      inbound: sections.inbound.records,
      outbound: sections.outbound.records,
      borrow: sections.borrow.records,
      prices: sections.prices.records,
      stocktakeSummaries: sections.stocktake.records,
      managers: sections.managers.records,
      sectionStatus,
    }).dashboard;
  }

  private readonly sourceReads = new Map<string, Promise<BitableRecordItem[]>>();

  private async readSharedRecords(
    options: Parameters<typeof fetchBitableRecords>[1],
  ): Promise<BitableRecordItem[]> {
    const generation = getBitableRecordCacheGeneration(options.appToken, options.tableId);
    // Raw records only: each caller still applies its own current permission and query filters.
    // Keep forced/normal/strict reads distinct and never join a read predating an invalidation.
    const key = JSON.stringify([options.appToken, options.tableId, options.forceRefresh === true,
      options.strict === true, options.cacheTtlMs, generation]);
    let request = this.sourceReads.get(key);
    if (!request) {
      request = fetchBitableRecords(this.httpService, options);
      this.sourceReads.set(key, request);
      const current = request;
      void request.finally(() => {
        if (this.sourceReads.get(key) === current) this.sourceReads.delete(key);
      }).catch(() => undefined);
    }
    const records = await request;
    if (generation !== getBitableRecordCacheGeneration(options.appToken, options.tableId)) {
      throw new Error(BITABLE_READ_CONFLICT);
    }
    return records;
  }

  async getItems(
    query: InventoryItemsQuery,
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<InventoryItemsResponse> {
    const { appToken } = await this.resolveSource();
    const inventoryTable = TABLES.inventory;
    const catalogTable = TABLES.catalog;
    const inventoryTableId = readEnv(inventoryTable.env);
    const catalogTableId = readEnv(catalogTable.env);
    if (!inventoryTableId) {
      throw new Error('库存台账未配置');
    }
    if (!catalogTableId) {
      throw new Error('物品类别主数据未配置');
    }
    const photosRead = this.readInventoryPhotoMetadata(appToken, inventoryTableId, forceRefresh);
    const [records, catalog] = await this.readDisplaySources([
      {
        appToken,
        tableId: inventoryTableId,
        tableName: inventoryTable.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      },
      {
        appToken,
        tableId: catalogTableId,
        tableName: catalogTable.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      },
    ]);
    const page = queryInventoryItems(projectInventoryItems(records, catalog, principal), query);
    const photos = await photosRead;
    if (!photos) return page;
    return {
      ...page,
      items: page.items.map((item) => {
        const images = photos.get(item.recordId);
        return images ? { ...item, images } : item.images ? { ...item, images: undefined } : item;
      }),
    };
  }

  private async readInventoryPhotoMetadata(appToken: string, tableId: string, forceRefresh: boolean) {
    if (!this.inventoryGateway) return undefined;
    const generation = getBitableRecordCacheGeneration(appToken, tableId);
    const key = JSON.stringify([appToken, tableId, generation]);
    const cached = this.inventoryPhotoMetadata?.key === key ? this.inventoryPhotoMetadata : undefined;
    const now = Date.now();
    if (!forceRefresh && cached && cached.expiresAt > now) return cached.photos;
    if (!forceRefresh && this.inventoryPhotoRetryAfter?.key === key && this.inventoryPhotoRetryAfter.at > now) {
      return cached?.photos;
    }
    if (this.inventoryPhotoRead?.key !== key) {
      const gateway = this.inventoryGateway;
      const pending = gateway.searchRecords({
        appToken,
        tableId,
        tableName: '库存台账物品图片',
        fieldNames: [INVENTORY_PHOTO_FIELD],
        filter: { conjunction: 'and', conditions: [{ field_name: INVENTORY_PHOTO_FIELD, operator: 'isNotEmpty', value: [] }] },
      }).then((rows) => {
        if (this.inventoryPhotoRead?.pending !== pending ||
            getBitableRecordCacheGeneration(appToken, tableId) !== generation) return;
        const photos = new Map(rows.flatMap((row) => {
          const id = getRecordId(row);
          const images = describeInventoryLedgerImages(id, row.fields?.[INVENTORY_PHOTO_FIELD]);
          return images.length ? [[id, images] as const] : [];
        }));
        this.inventoryPhotoMetadata = { key, photos, expiresAt: Date.now() + PHOTO_METADATA_TTL_MS };
      }).catch((error) => {
        if (this.inventoryPhotoRead?.pending === pending) {
          this.inventoryPhotoRetryAfter = { key, at: Date.now() + 15_000 };
        }
        this.logger.warn(`库存台账图片更新失败：${safeErrorMessage(error)}`);
      }).finally(() => {
        if (this.inventoryPhotoRead?.pending === pending) this.inventoryPhotoRead = undefined;
      });
      this.inventoryPhotoRead = { key, pending };
    }
    const { pending } = this.inventoryPhotoRead;
    if (forceRefresh) await pending;
    else if (!cached) {
      // Give the first sparse query a short head start without making a slow
      // Feishu response block the list.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pending, new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, PHOTO_METADATA_FIRST_READ_WAIT_MS);
        })]);
      } finally {
        clearTimeout(timeout);
      }
    }
    const latest = this.inventoryPhotoMetadata;
    return latest?.key === key ? latest.photos : undefined;
  }

  async readItemImage(principal: AccessPrincipal, recordId: string, imageIndex: string, thumbnail = false) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(recordId) || !/^\d{1,6}-[a-f0-9]{16}$/.test(imageIndex)) {
      throw new NotFoundException('物品图片不存在');
    }
    if (!this.photoService || !this.inventoryGateway) throw new ServiceUnavailableException('物品图片服务尚未就绪');
    const { appToken } = await this.resolveSource();
    const tableId = readEnv(TABLES.inventory.env);
    const catalogTableId = readEnv(TABLES.catalog.env);
    if (!tableId || !catalogTableId) throw new ServiceUnavailableException('库存台账未配置');
    const [record, catalog] = await Promise.all([
      this.inventoryGateway.tryGetRecord(appToken, tableId, recordId, TABLES.inventory.name),
      this.readSharedRecords({ appToken, tableId: catalogTableId, tableName: TABLES.catalog.name, cacheTtlMs: CACHE_TTL_MS }),
    ]);
    const item = record && scopedInventoryItem(record, catalog, principal);
    if (!record || !item || !canPerformBusinessAction(principal, {
      module: 'inventory', action: 'read', building: item.building, specialty: item.specialty,
    })) throw new NotFoundException('物品图片不存在');
    const fileToken = findInventoryLedgerImage(record.fields?.[INVENTORY_PHOTO_FIELD], imageIndex);
    const key = JSON.stringify([appToken, tableId]);
    if (this.attachmentField?.key !== key || this.attachmentField.expiresAt < Date.now()) {
      const pending = this.inventoryGateway.getAttachmentFieldId(appToken, tableId, INVENTORY_PHOTO_FIELD, TABLES.inventory.name);
      const field = { key, expiresAt: Date.now() + 10 * 60_000, pending };
      this.attachmentField = field;
      void pending.catch(() => {
        if (this.attachmentField === field) this.attachmentField = undefined;
      });
    }
    const fieldId = await this.attachmentField.pending;
    const context = { tableId, recordId, fieldId };
    return thumbnail
      ? this.photoService.downloadThumbnail(fileToken, context)
      : this.photoService.download(fileToken, context);
  }

  async getMovements(
    query: InventoryMovementsQuery,
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<InventoryMovementsResponse> {
    const { appToken } = await this.resolveSource();
    const selectedTable = TABLES[query.type];
    const inventoryTableId = readEnv(TABLES.inventory.env);
    const catalogTableId = readEnv(TABLES.catalog.env);
    const movementTableId = readEnv(selectedTable.env);
    if (!inventoryTableId) throw new Error('库存台账未配置');
    if (!catalogTableId) throw new Error('物品类别主数据未配置');
    if (!movementTableId) throw new Error(`${selectedTable.name}未配置`);

    const [inventory, catalog, movementRecords] = await this.readDisplaySources([
      {
        appToken,
        tableId: inventoryTableId,
        tableName: TABLES.inventory.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      },
      {
        appToken,
        tableId: catalogTableId,
        tableName: TABLES.catalog.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      },
      {
        appToken,
        tableId: movementTableId,
        tableName: selectedTable.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      },
    ]);

    const rows = projectInventoryMovementRows(movementRecords, query.type, inventory, catalog, principal);
    return queryInventoryMovements({ [query.type]: rows }, query);
  }

  private async readDisplaySources(options: Parameters<typeof fetchBitableRecords>[1][]): Promise<BitableRecordItem[][]> {
    const read = (sources: typeof options) => Promise.all(sources.map((source) => this.readSharedRecords(source)));
    try {
      return await read(options);
    } catch (error) {
      if (options.some((option) => option.forceRefresh) ||
          !(error instanceof Error) || error.message !== BITABLE_READ_CONFLICT) throw error;
      return read(options);
    }
  }

  private async resolveSource(): Promise<{
    appToken: string;
    sourceUrl: string;
  }> {
    const sourceUrl = readEnv('FEISHU_WAREHOUSE_SOURCE_URL');
    const parsedSource = parseFeishuBitableLink(sourceUrl);
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || parsedSource.appToken,
      wikiToken: parsedSource.wikiToken,
      tableName: '南通运维全景驾驶舱-库房管理',
    });
    return { appToken, sourceUrl };
  }

  private async readSection(
    appToken: string,
    table: (typeof TABLES)[InventorySourceKey],
    forceRefresh: boolean,
  ): Promise<SectionReadResult> {
    const tableId = readEnv(table.env);
    if (!tableId) {
      return {
        records: [],
        status: {
          configured: false,
          count: 0,
          message: `${table.name}待配置`,
        },
      };
    }

    try {
      const records = await this.readSharedRecords({
        appToken,
        tableId,
        tableName: table.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
        strict: forceRefresh,
      });
      return {
        records,
        status: { configured: true, count: records.length },
      };
    } catch (error) {
      this.logger.warn(`${table.name}读取失败：${safeErrorMessage(error)}`);
      return {
        records: [],
        status: {
          configured: true,
          count: 0,
          message: `${table.name}读取失败`,
        },
      };
    }
  }
}

function hasConfiguredSectionFailure(
  dashboard: InventoryManagementDashboard,
): boolean {
  return Object.values(dashboard.sectionStatus).some(
    (status) => status.configured && Boolean(status.message),
  );
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误';
  return error.message.replace(
    /(app_secret|tenant_access_token|token)=[^\s&]+/gi,
    '$1=***',
  );
}
