import { accessBuildings, canAccessBuilding } from '../../../shared/building-access';
import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { normalizeLedgerBuilding } from './equipment-ledger.model';
import { HttpService } from '@nestjs/axios';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';
import { extractDisplayText } from '../../common/feishu/bitable-direct-read';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
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
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  createBitableBackgroundRefresh,
  getBitableRecordCacheGeneration,
} from '../../common/feishu/bitable-direct-read';
import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { dashboardSourceBindingKey, readDashboardSourceBinding, writeDashboardSourceBinding, type DashboardSourceBinding } from '../../common/feishu/dashboard-source-binding-cache';
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

interface EquipmentLifecycleReadState {
  source: DashboardSourceBinding;
  key: string;
  appToken?: string;
  generation?: number;
  snapshot?: EquipmentLifecycleLastGoodSnapshot;
  warm?: Promise<void>;
  refresh?: Promise<EquipmentLifecycleSourceInput>;
  lastFailureAt: number;
}

@Injectable()
export class EquipmentLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EquipmentLifecycleService.name);
  private readonly states = new Map<EquipmentLifecycleSourceTableKey, EquipmentLifecycleReadState>();
  private destroyed = false;
  private readonly background = createBitableBackgroundRefresh({
    name: EquipmentLifecycleService.name, intervalMs: CACHE_TTL_MS,
    warm: async () => { await this.getDashboard(); },
    refresh: async () => { await this.getDashboard(true); },
  });

  constructor(private readonly httpService: HttpService) {}

  async onModuleInit(): Promise<void> {
    await runHotfixInitialization(this, () => { if (!this.destroyed) this.background.start(); });
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.background.stop();
    await cancelHotfixInitialization(this);
  }

  async getDashboard(
    forceRefresh = false,
    building?: string,
    principal?: AccessPrincipal,
  ): Promise<EquipmentLifecycleDashboardResponse> {
    const scopedPrincipal = principal && { ...principal, permissionContext: { module: principal.permissionContext?.module || 'equipment_lifecycle' as const, action: 'read' as const } };
    const entries = await Promise.all(
      TABLE_CONFIGS.map(
        async (config) =>
          [config.key, await this.loadTable(config, forceRefresh)] as const,
      ),
    );
    // A table may finish before another table. Recheck its captured source and
    // generation before combining the results, not just when each read ends.
    for (const [, source] of entries) source.assertCurrent();
    const loaded = new Map(entries);
    const scopedSource = (key: EquipmentLifecycleSourceTableKey): EquipmentLifecycleSourceInput => {
      const source = loaded.get(key);
      if (!source) throw new ServiceUnavailableException('设备生命周期来源未完整返回，请重新读取');
      return {
        ...source,
        records: source.records === null ? null : filterProfessionalRecords(scopedPrincipal, source.records, record => extractDisplayText(record.fields?.['专业'])).filter(record => !scopedPrincipal || isProfessionalBusinessPrincipal(scopedPrincipal) || accessBuildings(scopedPrincipal) === null || canAccessBuilding(scopedPrincipal, normalizeLedgerBuilding(extractDisplayText(record.fields?.['楼栋'] || record.fields?.['园区楼栋'])))),
      };
    };
    const sources: EquipmentLifecycleSources = {
      equipment: scopedSource('equipment'),
      longTermMaintenance: scopedSource('longTermMaintenance'),
      keyParts: scopedSource('keyParts'),
      maintenanceContracts: scopedSource('maintenanceContracts'),
    };

    if (Object.values(sources).every(({ records }) => records === null)) {
      throw new ServiceUnavailableException(
        '设备生命周期数据暂时不可用，请稍后重试。',
      );
    }

    return mapEquipmentLifecycleDashboard(sources, {
      month: currentShanghaiMonth(),
      // A cached response must not pretend it was synchronized at page-open time.
      syncedAt: new Date(Math.min(...entries.flatMap(([, source]) => source.fetchedAt === undefined ? [] : [source.fetchedAt]))).toISOString(),
      building,
    });
  }

  private sourceFor(config: EquipmentLifecycleTableConfig): DashboardSourceBinding {
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
    return {
      namespace: `equipment-lifecycle-${config.key}`, appId: readEnv('FEISHU_APP_ID'),
      appToken: readEnv('FEISHU_EQUIPMENT_LIFECYCLE_APP_TOKEN') || source.appToken,
      wikiToken: readEnv('FEISHU_EQUIPMENT_LIFECYCLE_WIKI_TOKEN') || source.wikiToken,
      tableId, viewId, fieldNames: config.fieldNames,
    };
  }

  private assertCurrent(config: EquipmentLifecycleTableConfig, state: EquipmentLifecycleReadState): void {
    if (this.destroyed || this.states.get(config.key) !== state || dashboardSourceBindingKey(this.sourceFor(config)) !== state.key ||
      (state.appToken && state.generation !== getBitableRecordCacheGeneration(state.appToken, state.source.tableId))) {
      throw new ServiceUnavailableException('设备生命周期数据源已变化，请重新读取');
    }
  }

  private async loadTable(config: EquipmentLifecycleTableConfig, forceRefresh: boolean): Promise<EquipmentLifecycleSourceInput & { assertCurrent: () => void }> {
    const source = this.sourceFor(config), key = dashboardSourceBindingKey(source);
    let state = this.states.get(config.key);
    if (!state || state.key !== key || (state.appToken && state.generation !== getBitableRecordCacheGeneration(state.appToken, state.source.tableId))) {
      state = { source, key, lastFailureAt: 0 };
      this.states.set(config.key, state);
    }
    state.warm ??= this.warmSnapshot(config, state);
    await state.warm;
    this.assertCurrent(config, state);
    if (forceRefresh || !state.snapshot) {
      const result = await this.refreshTable(config, state);
      return this.bindResult(config, state, result);
    }
    const snapshot = state.snapshot;
    const stale = snapshot.stale || Date.now() - snapshot.fetchedAt >= CACHE_TTL_MS;
    if (stale && !state.refresh && (!state.lastFailureAt || Date.now() - state.lastFailureAt >= 30_000)) {
      void this.refreshTable(config, state).catch(() => this.logger.warn(`设备生命周期后台读取暂不可用：${config.tableName}`));
    }
    return this.bindResult(config, state, { records: snapshot.records, status: stale ? 'stale' : 'fresh', fetchedAt: snapshot.fetchedAt });
  }

  private bindResult(config: EquipmentLifecycleTableConfig, state: EquipmentLifecycleReadState, result: EquipmentLifecycleSourceInput): EquipmentLifecycleSourceInput & { assertCurrent: () => void } {
    const appToken = state.appToken, generation = state.generation;
    const assertCurrent = () => {
      this.assertCurrent(config, state);
      if (state.appToken !== appToken || state.generation !== generation) {
        throw new ServiceUnavailableException('设备生命周期数据源已变化，请重新读取');
      }
    };
    assertCurrent();
    return { ...result, assertCurrent };
  }

  private async warmSnapshot(config: EquipmentLifecycleTableConfig, state: EquipmentLifecycleReadState): Promise<void> {
    try {
      const appToken = await readDashboardSourceBinding(state.source);
      this.assertCurrent(config, state);
      if (!appToken) return;
      state.appToken = appToken;
      state.generation = getBitableRecordCacheGeneration(appToken, state.source.tableId);
      const persisted = await readLatestPersistedBitableRecordSnapshot({
        appToken, tableId: state.source.tableId, viewId: state.source.viewId,
        fieldNames: state.source.fieldNames, tableName: config.tableName, directOnly: true,
      });
      this.assertCurrent(config, state);
      if (!persisted || !Number.isFinite(persisted.fetchedAt)) return;
      assertTableRecordsQuality(persisted.records, config);
      state.snapshot = { records: persisted.records, fetchedAt: persisted.fetchedAt, stale: false };
    } catch { this.logger.warn(`设备生命周期本地快照暂不可用：${config.tableName}`); }
  }

  private refreshTable(config: EquipmentLifecycleTableConfig, state: EquipmentLifecycleReadState): Promise<EquipmentLifecycleSourceInput> {
    if (state.refresh) return state.refresh;
    const request = this.readTable(config, state);
    state.refresh = request;
    void request.then(() => { if (state.refresh === request) state.refresh = undefined; }, () => { if (state.refresh === request) state.refresh = undefined; });
    return request;
  }

  private async readTable(config: EquipmentLifecycleTableConfig, state: EquipmentLifecycleReadState): Promise<EquipmentLifecycleSourceInput> {
    try {
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken: state.source.appToken,
        wikiToken: state.source.wikiToken,
        tableName: config.tableName,
      });
      this.assertCurrent(config, state);
      if (state.appToken && state.appToken !== appToken) state.snapshot = undefined;
      state.appToken = appToken;
      state.generation = getBitableRecordCacheGeneration(appToken, state.source.tableId);
      let fetchedAt = 0;
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: state.source.tableId,
        viewId: state.source.viewId,
        fieldNames: config.fieldNames,
        tableName: config.tableName,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh: true,
        strict: true,
        allowStale: false,
        onPersisted: snapshot => { fetchedAt = snapshot.fetchedAt; },
        validateRecords: (candidateRecords) =>
          assertTableRecordsQuality(candidateRecords, config),
      });
      this.assertCurrent(config, state);
      assertTableRecordsQuality(records, config);
      fetchedAt ||= Date.now();
      await writeDashboardSourceBinding(state.source, appToken).catch(() => this.logger.warn(`设备生命周期来源绑定保存失败：${config.tableName}`));
      this.assertCurrent(config, state);
      state.snapshot = {
        records,
        fetchedAt,
        stale: false,
      };
      state.lastFailureAt = 0;
      return { records, status: 'fresh', fetchedAt };
    } catch {
      this.assertCurrent(config, state);
      this.logger.warn(`设备生命周期数据源读取失败：${config.tableName}`);
      state.lastFailureAt = Date.now();
      const snapshot = state.snapshot;
      if (snapshot) {
        state.snapshot = {
          ...snapshot,
          stale: true,
        };
        return { records: snapshot.records, status: 'stale', fetchedAt: snapshot.fetchedAt };
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
