import { accessBuildings, canAccessBuilding } from '../../../shared/building-access';
import { normalizeLedgerBuilding } from './equipment-ledger.model';
import { HttpService } from '@nestjs/axios';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';
import { extractDisplayText } from '../../common/feishu/bitable-direct-read';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  EquipmentLifecycleDashboardResponse,
  EquipmentLifecycleSourceTableKey,
} from '../../../shared/equipment-lifecycle.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  fetchBitableRecords,
  readLatestPersistedBitableRecords,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  type EquipmentLifecycleSourceInput,
  type EquipmentLifecycleSources,
  mapEquipmentLifecycleDashboard,
} from './equipment-lifecycle.mapper';

const DEFAULT_SOURCE_URL =
  'https://vnet.feishu.cn/base/WMcQbPn71aXwoGsNv0vcnzz2n6c?table=tblOnpjrcp5xR6gn&view=vewiWIAXKq';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface EquipmentLifecycleTableConfig {
  key: EquipmentLifecycleSourceTableKey;
  tableName: string;
  tableIdEnv: string;
  viewIdEnv: string;
  defaultTableId: string;
  defaultViewId: string;
  fieldNames: readonly string[];
  requiredFieldGroups: ReadonlyArray<readonly string[]>;
}

const TABLE_CONFIGS: EquipmentLifecycleTableConfig[] = [
  {
    key: 'equipment',
    tableName: '设备生命周期管理表',
    tableIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_EQUIPMENT_TABLE_ID',
    viewIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_EQUIPMENT_VIEW_ID',
    defaultTableId: 'tblGFIJl9QQokCm0',
    defaultViewId: 'vewEnxNvZL',
    fieldNames: [
      '描述',
      '设备名称',
      '专业',
      '状态',
      '本次到期日期',
      '管理员',
      '楼栋',
      '运维服役年限',
      '上次更换日期',
      '预计下次更换日期',
    ],
    requiredFieldGroups: [['设备名称'], ['状态'], ['楼栋'], ['本次到期日期']],
  },
  {
    key: 'longTermMaintenance',
    tableName: '长周期维护项',
    tableIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_LONG_TERM_MAINTENANCE_TABLE_ID',
    viewIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_LONG_TERM_MAINTENANCE_VIEW_ID',
    defaultTableId: 'tblOnpjrcp5xR6gn',
    defaultViewId: 'vewiWIAXKq',
    fieldNames: [
      '描述',
      '维护名称',
      '专业',
      '楼栋',
      '责任人',
      '上次维护日期',
      '本次到期日期',
      '到期倒计时',
      '状态',
      '预计下次维护日期',
    ],
    requiredFieldGroups: [['楼栋'], ['状态']],
  },
  {
    key: 'keyParts',
    tableName: '关键器件更换预警',
    tableIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_KEY_PARTS_TABLE_ID',
    viewIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_KEY_PARTS_VIEW_ID',
    defaultTableId: 'tblDNgWg26vJlxHB',
    defaultViewId: 'vewMtCv73j',
    fieldNames: [
      '描述',
      '关键器件项目',
      '设备类型',
      '专业',
      '楼栋',
      '责任人',
      '上次更换时间',
      '下次更换时间',
      '状态',
    ],
    requiredFieldGroups: [['楼栋'], ['状态']],
  },
  {
    key: 'maintenanceContracts',
    tableName: '维护合同',
    tableIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_MAINTENANCE_CONTRACTS_TABLE_ID',
    viewIdEnv: 'FEISHU_EQUIPMENT_LIFECYCLE_MAINTENANCE_CONTRACTS_VIEW_ID',
    defaultTableId: 'tblOZ1iBgdEH4GDB',
    defaultViewId: 'vewwBIXJAu',
    fieldNames: [
      '描述',
      '楼栋',
      '园区楼栋',
      '设备名称',
      '设备类型',
      '专业',
      '责任人',
      '本轮截止日期',
      '合同当前状态',
    ],
    requiredFieldGroups: [['楼栋', '园区楼栋'], ['合同当前状态']],
  },
];

interface EquipmentLifecycleLastGoodSnapshot {
  records: BitableRecordItem[];
  fetchedAt: number;
  stale: boolean;
}

@Injectable()
export class EquipmentLifecycleService {
  private readonly logger = new Logger(EquipmentLifecycleService.name);
  private readonly lastGoodSnapshots = new Map<
    EquipmentLifecycleSourceTableKey,
    EquipmentLifecycleLastGoodSnapshot
  >();

  constructor(private readonly httpService: HttpService) {}

  async getDashboard(
    forceRefresh = false,
    building?: string,
    principal?: AccessPrincipal,
  ): Promise<EquipmentLifecycleDashboardResponse> {
    const syncedAt = new Date().toISOString();
    const entries = await Promise.all(
      TABLE_CONFIGS.map(
        async (config) =>
          [config.key, await this.loadTable(config, forceRefresh)] as const,
      ),
    );
    const sources = Object.fromEntries(entries.map(([key, source]) => [key, {
      ...source,
      records: source.records === null ? null : filterProfessionalRecords(principal, source.records, record => extractDisplayText(record.fields?.['专业'])).filter(record => !principal || accessBuildings(principal) === null || canAccessBuilding(principal, normalizeLedgerBuilding(extractDisplayText(record.fields?.['楼栋'] || record.fields?.['园区楼栋'])))),
    }])) as EquipmentLifecycleSources;

    if (Object.values(sources).every(({ records }) => records === null)) {
      throw new ServiceUnavailableException(
        '设备生命周期数据暂时不可用，请稍后重试。',
      );
    }

    return mapEquipmentLifecycleDashboard(sources, {
      month: currentShanghaiMonth(),
      syncedAt,
      building,
    });
  }

  private async loadTable(
    config: EquipmentLifecycleTableConfig,
    forceRefresh: boolean,
  ): Promise<EquipmentLifecycleSourceInput> {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_EQUIPMENT_LIFECYCLE_SOURCE_URL') || DEFAULT_SOURCE_URL,
    );
    const tableId =
      readEnv(config.tableIdEnv) ||
      (config.key === 'longTermMaintenance' ? source.tableId : '') ||
      config.defaultTableId;
    const viewId =
      readEnv(config.viewIdEnv) ||
      (config.key === 'longTermMaintenance' ? source.viewId : '') ||
      config.defaultViewId;
    const snapshot = this.lastGoodSnapshots.get(config.key);

    if (
      !forceRefresh &&
      snapshot &&
      !snapshot.stale &&
      Date.now() - snapshot.fetchedAt < CACHE_TTL_MS
    ) {
      return { records: snapshot.records, status: 'fresh' };
    }

    try {
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken:
          readEnv('FEISHU_EQUIPMENT_LIFECYCLE_APP_TOKEN') || source.appToken,
        wikiToken:
          readEnv('FEISHU_EQUIPMENT_LIFECYCLE_WIKI_TOKEN') || source.wikiToken,
        tableName: config.tableName,
      });
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        viewId,
        fieldNames: config.fieldNames,
        tableName: config.tableName,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh: true,
        strict: true,
        validateRecords: (candidateRecords) =>
          assertTableRecordsQuality(candidateRecords, config),
      });
      assertTableRecordsQuality(records, config);
      this.lastGoodSnapshots.set(config.key, {
        records,
        fetchedAt: Date.now(),
        stale: false,
      });
      return { records, status: 'fresh' };
    } catch {
      this.logger.warn(`设备生命周期数据源读取失败：${config.tableName}`);
      if (snapshot) {
        this.lastGoodSnapshots.set(config.key, {
          ...snapshot,
          stale: true,
        });
        return { records: snapshot.records, status: 'stale' };
      }

      try {
        const persistedRecords = await readLatestPersistedBitableRecords({
          tableId,
          tableName: config.tableName,
          viewId,
          fieldNames: config.fieldNames,
        });
        if (persistedRecords) {
          assertTableRecordsQuality(persistedRecords, config);
          this.lastGoodSnapshots.set(config.key, {
            records: persistedRecords,
            fetchedAt: 0,
            stale: true,
          });
          return { records: persistedRecords, status: 'stale' };
        }
      } catch {
        this.logger.warn(`设备生命周期持久快照不可用：${config.tableName}`);
      }

      return { records: null, status: 'failed' };
    }
  }
}

function assertTableRecordsQuality(
  records: BitableRecordItem[],
  config: EquipmentLifecycleTableConfig,
): void {
  if (records.length === 0) {
    throw new Error('设备生命周期数据源为空');
  }
  for (const alternatives of config.requiredFieldGroups) {
    const fieldExists = records.some((record) => {
      const fields = record.fields || {};
      return alternatives.some((fieldName) =>
        Object.prototype.hasOwnProperty.call(fields, fieldName),
      );
    });
    if (!fieldExists) {
      throw new Error('设备生命周期数据源字段结构不匹配');
    }
  }
}

function currentShanghaiMonth(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}`;
}
