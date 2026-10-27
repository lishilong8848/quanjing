import { HttpService } from '@nestjs/axios';
import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  ContractManagementDashboard,
  ContractSourceKey,
  ContractSourceStatus,
} from '../../../shared/contract-management.interface';
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
import { buildContractManagementDashboard } from './contract-management.mapper';
import { ContractAttachmentStorageService } from './contract-attachment-storage.service';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_CONTRACT_COS_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CONTRACT_COS_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/SiW9wuy9DiIsykkTkNUcM0HfnSb?table=tblQehMrGf4zIfnt&view=vewmu8EPpy';
const DEFAULT_WIKI_TOKEN = 'SiW9wuy9DiIsykkTkNUcM0HfnSb';

const TABLES: Record<
  ContractSourceKey,
  { name: string; env: string; defaultId: string }
> = {
  framework: {
    name: '00-框架合同信息',
    env: 'FEISHU_CONTRACT_FRAMEWORK_TABLE_ID',
    defaultId: 'tblQehMrGf4zIfnt',
  },
  contracts: {
    name: '01-执行合同信息',
    env: 'FEISHU_CONTRACT_EXECUTION_TABLE_ID',
    defaultId: 'tblWfHs0iwQh8lHj',
  },
  suppliers: {
    name: '02-供应商名录',
    env: 'FEISHU_CONTRACT_SUPPLIER_TABLE_ID',
    defaultId: 'tblPf6yV4cxsWZTl',
  },
  payments: {
    name: '03-付款计划',
    env: 'FEISHU_CONTRACT_PAYMENT_TABLE_ID',
    defaultId: 'tblYK1vdLAkpoaIC',
  },
};

interface SectionReadResult {
  records: BitableRecordItem[];
  status: ContractSourceStatus;
}

@Injectable()
export class ContractManagementService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ContractManagementService.name);
  private dashboardCache?: {
    expiresAt: number;
    value: ContractManagementDashboard;
  };
  private dashboardRequest?: Promise<ContractManagementDashboard>;
  private dashboardCacheGeneration = 0;
  private readonly backgroundRefresh = createBitableBackgroundRefresh({
    name: ContractManagementService.name,
    intervalMs: resolveContractCosSyncIntervalMs(),
    warm: async () => {
      await this.getDashboard(false);
    },
    refresh: async () => {
      await this.getDashboard(true);
    },
  });

  constructor(
    private readonly httpService: HttpService,
    private readonly attachmentStorage: ContractAttachmentStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, () => this.backgroundRefresh.start());
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.backgroundRefresh.stop();
  }

  async getDashboard(
    forceRefresh = false,
  ): Promise<ContractManagementDashboard> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.dashboardCache &&
      this.dashboardCache.expiresAt > now
    ) {
      const refreshed = this.attachmentStorage.refreshDashboardAttachmentStates(
        this.dashboardCache.value,
      );
      this.dashboardCache.value = refreshed;
      return refreshed;
    }
    if (this.dashboardRequest) {
      return this.dashboardRequest;
    }

    const generation = this.dashboardCacheGeneration;
    const request = this.buildDashboard(forceRefresh);
    this.dashboardRequest = request;
    try {
      const dashboard = await request;
      if (generation === this.dashboardCacheGeneration) {
        this.dashboardCache = {
          expiresAt: Date.now() + CACHE_TTL_MS,
          value: dashboard,
        };
      }
      return dashboard;
    } finally {
      if (this.dashboardRequest === request) {
        this.dashboardRequest = undefined;
      }
    }
  }

  invalidateDashboardCache(): void {
    this.dashboardCacheGeneration += 1;
    this.dashboardCache = undefined;
    this.dashboardRequest = undefined;
  }

  private async buildDashboard(
    forceRefresh: boolean,
  ): Promise<ContractManagementDashboard> {
    const sourceUrl =
      readEnv('FEISHU_CONTRACT_SOURCE_URL') || DEFAULT_SOURCE_URL;
    const parsedSource = parseFeishuBitableLink(sourceUrl);
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: readEnv('FEISHU_CONTRACT_APP_TOKEN') || parsedSource.appToken,
      wikiToken:
        readEnv('FEISHU_CONTRACT_WIKI_TOKEN') ||
        parsedSource.wikiToken ||
        DEFAULT_WIKI_TOKEN,
      tableName: '南通运维全景驾驶舱-合同&采购管理',
    });
    const entries = await Promise.all(
      (
        Object.entries(TABLES) as Array<
          [ContractSourceKey, (typeof TABLES)[ContractSourceKey]]
        >
      ).map(
        async ([key, table]) =>
          [key, await this.readSection(appToken, table, forceRefresh)] as const,
      ),
    );
    const sections = Object.fromEntries(entries) as Record<
      ContractSourceKey,
      SectionReadResult
    >;
    const sectionStatus = Object.fromEntries(
      (
        Object.entries(sections) as Array<
          [ContractSourceKey, SectionReadResult]
        >
      ).map(([key, section]) => [key, section.status]),
    ) as ContractManagementDashboard['sectionStatus'];

    const dashboard = buildContractManagementDashboard({
      generatedAt: new Date().toISOString(),
      sourceUrl,
      frameworkContracts: sections.framework.records,
      executionContracts: sections.contracts.records,
      suppliers: sections.suppliers.records,
      paymentPlans: sections.payments.records,
      sectionStatus,
    });
    return this.attachmentStorage.enrichAndSchedule(
      dashboard,
      sections.contracts.records,
    );
  }

  private async readSection(
    appToken: string,
    table: (typeof TABLES)[ContractSourceKey],
    forceRefresh: boolean,
  ): Promise<SectionReadResult> {
    const tableId = readEnv(table.env) || table.defaultId;
    try {
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        tableName: table.name,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh,
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

export function resolveContractCosSyncIntervalMs(
  rawValue = readEnv('FEISHU_CONTRACT_COS_SYNC_INTERVAL_MS'),
): number {
  const normalized = rawValue.trim();
  if (!/^\d+$/.test(normalized)) return DEFAULT_CONTRACT_COS_SYNC_INTERVAL_MS;
  const intervalMs = Number(normalized);
  return Number.isSafeInteger(intervalMs) &&
    intervalMs >= MIN_CONTRACT_COS_SYNC_INTERVAL_MS
    ? intervalMs
    : DEFAULT_CONTRACT_COS_SYNC_INTERVAL_MS;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误';
  return error.message.replace(
    /(app_secret|tenant_access_token|token)=[^\s&]+/gi,
    '$1=***',
  );
}
