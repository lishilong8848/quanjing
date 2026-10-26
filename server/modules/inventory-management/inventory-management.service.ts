import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings } from '../../../shared/building-access';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
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
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  buildInventoryManagementSnapshot,
  queryInventoryItems,
  queryInventoryMovements,
} from './inventory-management.mapper';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

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

@Injectable()
export class InventoryManagementService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryManagementService.name);
  private dashboardCache?: {
    expiresAt: number;
    value: InventoryManagementDashboard;
  };
  private dashboardRequest?: Promise<InventoryManagementDashboard>;
  private dashboardGeneration = 0;
  private readonly backgroundRefresh = createBitableBackgroundRefresh({
    name: InventoryManagementService.name,
    warm: async () => {
      await this.getDashboard(false);
    },
    refresh: async () => {
      await this.getDashboard(true);
    },
  });

  constructor(private readonly httpService: HttpService) {}

  onModuleInit(): void {
    this.backgroundRefresh.start();
  }

  onModuleDestroy(): void {
    this.backgroundRefresh.stop();
  }

  invalidateCache(): void {
    this.dashboardGeneration += 1;
    this.dashboardCache = undefined;
    this.dashboardRequest = undefined;
  }

  async getDashboard(
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<InventoryManagementDashboard> {
    if (principal && (isProfessionalBusinessPrincipal(principal) || accessBuildings(principal) !== null)) return this.buildDashboard(forceRefresh, principal);
    const now = Date.now();
    if (
      !forceRefresh &&
      this.dashboardCache &&
      this.dashboardCache.expiresAt > now
    ) {
      return this.dashboardCache.value;
    }
    if (this.dashboardRequest) {
      const activeRequest = this.dashboardRequest;
      if (!forceRefresh) {
        return activeRequest;
      }
      try {
        await activeRequest;
      } catch {
        // A forced refresh still needs a fresh attempt after an older read fails.
      }
      return this.getDashboard(true);
    }

    const requestGeneration = this.dashboardGeneration;
    const request = this.buildDashboard(forceRefresh);
    this.dashboardRequest = request;
    try {
      const dashboard = await request;
      if (requestGeneration !== this.dashboardGeneration) {
        return dashboard;
      }
      if (this.dashboardCache && hasConfiguredSectionFailure(dashboard)) {
        this.logger.warn(
          '库存数据刷新不完整，继续使用最近一次成功看板并等待下次刷新',
        );
        return this.dashboardCache.value;
      }
      this.dashboardCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: dashboard,
      };
      return dashboard;
    } catch (error) {
      if (this.dashboardCache) {
        this.logger.warn(
          `库存数据刷新失败，继续使用最近一次成功看板：${safeErrorMessage(error)}`,
        );
        return this.dashboardCache.value;
      }
      throw error;
    } finally {
      if (this.dashboardRequest === request) {
        this.dashboardRequest = undefined;
      }
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

  async getItems(
    query: InventoryItemsQuery,
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<InventoryItemsResponse> {
    const { appToken, sourceUrl } = await this.resolveSource();
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
    const [records, catalog] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: inventoryTableId,
        tableName: inventoryTable.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: catalogTableId,
        tableName: catalogTable.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
    ]);
    const emptyStatus = createEmptySectionStatus();
    emptyStatus.inventory = { configured: true, count: records.length };
    const snapshot = buildInventoryManagementSnapshot({
      principal,
      generatedAt: new Date().toISOString(),
      sourceUrl,
      inventory: records,
      catalog,
      inbound: [],
      outbound: [],
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus: emptyStatus,
    });

    return queryInventoryItems(snapshot.items, query);
  }

  async getMovements(
    query: InventoryMovementsQuery,
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<InventoryMovementsResponse> {
    const { appToken, sourceUrl } = await this.resolveSource();
    const selectedTable = TABLES[query.type];
    const inventoryTableId = readEnv(TABLES.inventory.env);
    const catalogTableId = readEnv(TABLES.catalog.env);
    const movementTableId = readEnv(selectedTable.env);
    if (!inventoryTableId) throw new Error('库存台账未配置');
    if (!catalogTableId) throw new Error('物品类别主数据未配置');
    if (!movementTableId) throw new Error(`${selectedTable.name}未配置`);

    const [inventory, catalog, movementRecords] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: inventoryTableId,
        tableName: TABLES.inventory.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: catalogTableId,
        tableName: TABLES.catalog.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: movementTableId,
        tableName: selectedTable.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
      }),
    ]);

    const emptyStatus = createEmptySectionStatus();
    emptyStatus.inventory = { configured: true, count: inventory.length };
    emptyStatus.catalog = { configured: true, count: catalog.length };
    emptyStatus[query.type] = {
      configured: true,
      count: movementRecords.length,
    };
    const snapshot = buildInventoryManagementSnapshot({
      principal,
      generatedAt: new Date().toISOString(),
      sourceUrl,
      inventory,
      catalog,
      inbound: query.type === 'inbound' ? movementRecords : [],
      outbound: query.type === 'outbound' ? movementRecords : [],
      borrow: query.type === 'borrow' ? movementRecords : [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sectionStatus: emptyStatus,
    });

    return queryInventoryMovements(snapshot.movements, query);
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
      const records = await fetchBitableRecords(this.httpService, {
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

function createEmptySectionStatus(): Record<
  InventorySourceKey,
  InventoryManagementSourceStatus
> {
  return Object.fromEntries(
    (Object.keys(TABLES) as InventorySourceKey[]).map((key) => [
      key,
      { configured: false, count: 0 },
    ]),
  ) as Record<InventorySourceKey, InventoryManagementSourceStatus>;
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
