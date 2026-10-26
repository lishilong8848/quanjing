import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  PurchaseInventoryResponse,
  PurchaseInventorySectionKey,
  PurchaseInventorySectionStatus,
} from '../../../shared/purchase-inventory.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  createBitableBackgroundRefresh,
  fetchBitableRecords,
  extractDisplayText,
  getRecordId,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { buildPurchaseInventoryView } from './purchase-inventory.mapper';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const RETRY_CACHE_TTL_MS = 45 * 1000;
const ACTIVE_SOURCE_CACHE_TTL_MS = 10 * 1000;
const COMPLETED_WORKFLOW_STATUS = '采购完成（已入库）';
const ACTIVE_EXECUTION_FILTER = {
  conjunction: 'and' as const,
  conditions: [
    {
      field_name: '采购流程',
      operator: 'isNot',
      value: [COMPLETED_WORKFLOW_STATUS],
    },
  ],
};

type PurchaseInventorySourceSectionKey = Exclude<
  PurchaseInventorySectionKey,
  'submissions'
>;

const TABLES: Record<
  PurchaseInventorySourceSectionKey,
  { name: string; env: string }
> = {
  executions: {
    name: '采购进行',
    env: 'FEISHU_PURCHASE_EXECUTION_TABLE_ID',
  },
  catalog: {
    name: '物品类别',
    env: 'FEISHU_ITEM_CATEGORY_TABLE_ID',
  },
  inventory: {
    name: '库存台账',
    env: 'FEISHU_INVENTORY_LEDGER_TABLE_ID',
  },
  inbound: {
    name: '物品入库表',
    env: 'FEISHU_INBOUND_TABLE_ID',
  },
  outbound: {
    name: '物品出库表',
    env: 'FEISHU_OUTBOUND_TABLE_ID',
  },
};

interface SectionReadResult {
  records: BitableRecordItem[];
  status: PurchaseInventorySectionStatus;
}

interface PurchaseInventorySourceSnapshot {
  appToken: string;
  sourceSections: Record<PurchaseInventorySourceSectionKey, SectionReadResult>;
  employees: BitableRecordItem[];
  employeeError?: string;
  globalRefreshError?: string;
}

interface EmployeeReadResult {
  records: BitableRecordItem[];
  message?: string;
}

interface PurchaseInventoryBuildResult {
  dashboard: PurchaseInventoryResponse;
  sourceSnapshot: PurchaseInventorySourceSnapshot;
}

@Injectable()
export class PurchaseInventoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PurchaseInventoryService.name);
  private dashboardCache?: {
    expiresAt: number;
    value: PurchaseInventoryResponse;
  };
  private dashboardRequest?: Promise<PurchaseInventoryBuildResult>;
  private dashboardRequestForceRefresh = false;
  private activeDashboardRequest?: Promise<PurchaseInventoryResponse>;
  private sourceSnapshot?: PurchaseInventorySourceSnapshot;
  private dashboardGeneration = 0;
  private readonly backgroundRefresh = createBitableBackgroundRefresh({
    name: PurchaseInventoryService.name,
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
    this.dashboardRequestForceRefresh = false;
    this.activeDashboardRequest = undefined;
    this.sourceSnapshot = undefined;
  }

  async getDashboard(
    refresh: boolean | 'active' = false,
  ): Promise<PurchaseInventoryResponse> {
    if (refresh === 'active') return this.refreshActiveDashboard();

    const now = Date.now();
    const explicitForceRefresh = refresh === true;
    const retryingIncompleteSnapshot = Boolean(
      !explicitForceRefresh &&
      this.dashboardCache &&
      this.dashboardCache.expiresAt <= now &&
      this.dashboardCache.value.refreshState !== 'fresh',
    );
    const forceRefresh = explicitForceRefresh || retryingIncompleteSnapshot;
    if (
      !forceRefresh &&
      this.dashboardCache &&
      this.dashboardCache.expiresAt > now
    ) {
      return this.dashboardCache.value;
    }
    if (this.dashboardRequest) {
      const activeRequest = this.dashboardRequest;
      if (!forceRefresh || this.dashboardRequestForceRefresh) {
        return (await activeRequest).dashboard;
      }
      try {
        await activeRequest;
      } catch {
        // A forced refresh must still get a fresh attempt after an older read fails.
      }
      return this.getDashboard(true);
    }

    if (this.activeDashboardRequest) {
      try {
        await this.activeDashboardRequest;
      } catch {
        // A full refresh starts only after the older active refresh settles.
      }
      return this.getDashboard(refresh);
    }

    const requestGeneration = this.dashboardGeneration;
    const request = this.buildDashboard(forceRefresh, this.sourceSnapshot);
    this.dashboardRequest = request;
    this.dashboardRequestForceRefresh = forceRefresh;
    try {
      const { dashboard, sourceSnapshot } = await request;
      const incomplete = dashboard.refreshState !== 'fresh';
      if (incomplete) {
        this.logger.warn(
          '采购数据刷新不完整，保留失败分区的最近数据并等待下次刷新',
        );
      }
      if (requestGeneration === this.dashboardGeneration) {
        this.sourceSnapshot = sourceSnapshot;
        this.dashboardCache = {
          expiresAt:
            Date.now() + (incomplete ? RETRY_CACHE_TTL_MS : CACHE_TTL_MS),
          value: dashboard,
        };
      }
      return dashboard;
    } catch (error) {
      if (requestGeneration !== this.dashboardGeneration) {
        if (this.dashboardCache) return this.dashboardCache.value;
        throw error;
      }
      if (this.dashboardCache) {
        const message = `采购数据刷新失败：${safeErrorMessage(error)}`;
        this.logger.warn(`${message}，继续使用最近一次成功看板`);
        if (this.sourceSnapshot) {
          this.sourceSnapshot = {
            ...this.sourceSnapshot,
            globalRefreshError: message,
          };
        }
        const staleDashboard = markDashboardStale(
          this.dashboardCache.value,
          message,
        );
        this.dashboardCache = {
          expiresAt: Date.now() + RETRY_CACHE_TTL_MS,
          value: staleDashboard,
        };
        return staleDashboard;
      }
      throw error;
    } finally {
      if (this.dashboardRequest === request) {
        this.dashboardRequest = undefined;
        this.dashboardRequestForceRefresh = false;
      }
    }
  }

  private async refreshActiveDashboard(): Promise<PurchaseInventoryResponse> {
    if (this.dashboardRequest) {
      try {
        await this.dashboardRequest;
      } catch {
        // The active refresh will use the last successful snapshot if available.
      }
      return this.refreshActiveDashboard();
    }
    if (this.activeDashboardRequest) return this.activeDashboardRequest;
    if (
      !this.dashboardCache ||
      !this.sourceSnapshot ||
      this.dashboardCache.expiresAt <= Date.now()
    ) {
      return this.getDashboard(false);
    }

    const fallbackCache = this.dashboardCache;
    const requestGeneration = this.dashboardGeneration;
    const request = this.buildActiveDashboard(this.sourceSnapshot);
    const activeRequest = request.then(({ dashboard, sourceSnapshot }) => {
      if (requestGeneration === this.dashboardGeneration) {
        this.sourceSnapshot = sourceSnapshot;
        this.dashboardCache = {
          expiresAt: fallbackCache.expiresAt,
          value: dashboard,
        };
      }
      return dashboard;
    });
    this.activeDashboardRequest = activeRequest;
    try {
      return await activeRequest;
    } catch (error) {
      if (requestGeneration !== this.dashboardGeneration) {
        if (this.dashboardCache) return this.dashboardCache.value;
        throw error;
      }
      const message = `采购进行中数据刷新失败：${safeErrorMessage(error)}`;
      this.logger.warn(`${message}，继续使用最近一次成功看板`);
      const staleDashboard = markDashboardStale(fallbackCache.value, message);
      this.dashboardCache = {
        expiresAt: fallbackCache.expiresAt,
        value: staleDashboard,
      };
      return staleDashboard;
    } finally {
      if (this.activeDashboardRequest === activeRequest) {
        this.activeDashboardRequest = undefined;
      }
    }
  }

  private async buildDashboard(
    forceRefresh: boolean,
    fallbackSnapshot?: PurchaseInventorySourceSnapshot,
  ): Promise<PurchaseInventoryBuildResult> {
    const sourceUrl = readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL');
    const parsedSource = parseFeishuBitableLink(sourceUrl);
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken:
        readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') || parsedSource.appToken,
      wikiToken:
        readEnv('FEISHU_PURCHASE_INVENTORY_WIKI_TOKEN') ||
        parsedSource.wikiToken,
      tableName: '采购与库存管理',
    });

    const [entries, employeeRead] = await Promise.all([
      Promise.all(
        (
          Object.entries(TABLES) as Array<
            [PurchaseInventorySourceSectionKey, { name: string; env: string }]
          >
        ).map(async ([key, table]) => {
          const tableId = readEnv(table.env);
          if (!tableId) {
            return [
              key,
              {
                records: [],
                status: {
                  configured: false,
                  count: 0,
                  message: `${table.name}待配置`,
                },
              },
            ] as const;
          }

          try {
            const records = await fetchBitableRecords(this.httpService, {
              appToken,
              tableId,
              tableName: table.name,
              cacheTtlMs: CACHE_TTL_MS,
              forceRefresh,
              allowStale: false,
              strict: true,
            });
            return [
              key,
              {
                records,
                status: { configured: true, count: records.length },
              },
            ] as const;
          } catch (error) {
            this.logger.warn(
              `${table.name}读取失败：${safeErrorMessage(error)}`,
            );
            return [
              key,
              {
                records: fallbackSnapshot?.sourceSections[key]?.records ?? [],
                status: {
                  configured: true,
                  count:
                    fallbackSnapshot?.sourceSections[key]?.records.length ?? 0,
                  message: `${table.name}读取失败`,
                },
              },
            ] as const;
          }
        }),
      ),
      this.readActiveEmployees(forceRefresh, fallbackSnapshot?.employees),
    ]);

    const sourceSections = Object.fromEntries(entries) as Record<
      PurchaseInventorySourceSectionKey,
      SectionReadResult
    >;
    const sourceSnapshot: PurchaseInventorySourceSnapshot = {
      appToken,
      sourceSections,
      employees: employeeRead.records,
      ...(employeeRead.message ? { employeeError: employeeRead.message } : {}),
    };

    return {
      dashboard: this.buildDashboardFromSnapshot(sourceSnapshot),
      sourceSnapshot,
    };
  }

  private async buildActiveDashboard(
    sourceSnapshot: PurchaseInventorySourceSnapshot,
  ): Promise<PurchaseInventoryBuildResult> {
    const tableId = readEnv(TABLES.executions.env);
    if (!tableId) {
      return {
        dashboard: this.buildDashboardFromSnapshot(sourceSnapshot),
        sourceSnapshot,
      };
    }

    const activeRecords = await fetchBitableRecords(this.httpService, {
      appToken: sourceSnapshot.appToken,
      tableId,
      tableName: TABLES.executions.name,
      cacheTtlMs: ACTIVE_SOURCE_CACHE_TTL_MS,
      forceRefresh: false,
      allowStale: false,
      strict: true,
      filter: ACTIVE_EXECUTION_FILTER,
    });
    const completedRecords =
      sourceSnapshot.sourceSections.executions.records.filter(
        isCompletedExecutionRecord,
      );
    const executionRecords = mergeBitableRecords(
      activeRecords,
      completedRecords,
    );
    const nextSnapshot: PurchaseInventorySourceSnapshot = {
      ...sourceSnapshot,
      sourceSections: {
        ...sourceSnapshot.sourceSections,
        executions: {
          records: executionRecords,
          status: { configured: true, count: executionRecords.length },
        },
      },
    };

    return {
      dashboard: this.buildDashboardFromSnapshot(nextSnapshot),
      sourceSnapshot: nextSnapshot,
    };
  }

  private buildDashboardFromSnapshot(
    sourceSnapshot: PurchaseInventorySourceSnapshot,
  ): PurchaseInventoryResponse {
    const { sourceSections, employees } = sourceSnapshot;
    const sections: Record<PurchaseInventorySectionKey, SectionReadResult> = {
      submissions: sourceSections.executions,
      ...sourceSections,
    };
    const sectionStatus = Object.fromEntries(
      (
        Object.entries(sections) as Array<
          [PurchaseInventorySectionKey, SectionReadResult]
        >
      ).map(([key, section]) => [key, section.status]),
    ) as PurchaseInventoryResponse['sectionStatus'];

    const dashboard = buildPurchaseInventoryView({
      generatedAt: new Date().toISOString(),
      submissions: [],
      executions: sections.executions.records,
      employees,
      catalog: sections.catalog.records,
      inventory: sections.inventory.records,
      inbound: sections.inbound.records,
      outbound: sections.outbound.records,
      sectionStatus,
    });
    const refreshErrors = [
      ...new Set(
        [
          ...Object.values(sectionStatus).map((status) => status.message),
          sourceSnapshot.employeeError,
        ]
          .map((message) => message?.trim())
          .filter((message): message is string => Boolean(message)),
      ),
    ];
    if (sourceSnapshot.globalRefreshError) {
      return {
        ...dashboard,
        refreshState: 'stale',
        refreshError: sourceSnapshot.globalRefreshError,
      };
    }
    return {
      ...dashboard,
      refreshState: refreshErrors.length ? 'partial' : 'fresh',
      ...(refreshErrors.length
        ? { refreshError: `部分采购数据刷新失败：${refreshErrors.join('；')}` }
        : {}),
    };
  }

  private async readActiveEmployees(
    forceRefresh: boolean,
    fallback: BitableRecordItem[] = [],
  ): Promise<EmployeeReadResult> {
    const tableId = readEnv('FEISHU_ACTIVE_EMPLOYEE_TABLE_ID');
    if (!tableId) return { records: [] };

    try {
      const source = parseFeishuBitableLink(
        readEnv('FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL'),
      );
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken:
          readEnv('FEISHU_ACTIVE_EMPLOYEE_APP_TOKEN') || source.appToken,
        wikiToken:
          readEnv('FEISHU_ACTIVE_EMPLOYEE_WIKI_TOKEN') || source.wikiToken,
        tableName: '在职人员',
      });
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        viewId: readEnv('FEISHU_ACTIVE_EMPLOYEE_VIEW_ID'),
        tableName: '在职人员',
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
        allowStale: false,
        strict: true,
      });
      return { records };
    } catch (error) {
      const message = `在职人员读取失败：${safeErrorMessage(error)}`;
      this.logger.warn(message);
      return { records: fallback, message };
    }
  }
}

function markDashboardStale(
  dashboard: PurchaseInventoryResponse,
  refreshError: string,
): PurchaseInventoryResponse {
  return {
    ...dashboard,
    refreshState: 'stale',
    refreshError,
  };
}

function isCompletedExecutionRecord(record: BitableRecordItem): boolean {
  return (
    extractDisplayText(record.fields?.['采购流程']).trim() ===
    COMPLETED_WORKFLOW_STATUS
  );
}

function mergeBitableRecords(
  current: BitableRecordItem[],
  retained: BitableRecordItem[],
): BitableRecordItem[] {
  const seen = new Set<string>();
  return [...current, ...retained].filter((record) => {
    const recordId = getRecordId(record);
    if (!recordId || seen.has(recordId)) return false;
    seen.add(recordId);
    return true;
  });
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误';
  return error.message.replace(
    /(app_secret|tenant_access_token|token)=[^\s&]+/gi,
    '$1=***',
  );
}
