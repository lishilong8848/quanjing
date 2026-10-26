import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings, canAccessBuilding, buildingScopeKey } from '../../../shared/building-access';
import { HttpService } from '@nestjs/axios';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  LedgerAsset,
  LedgerDashboard,
  LedgerDashboardState,
  LedgerPage,
  LedgerQuery,
  LedgerLifecycle,
} from '../../../shared/equipment-ledger.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  type BitableRecordItem,
  createBitableBackgroundRefresh,
} from '../../common/feishu/bitable-direct-read';
import { EquipmentLifecycleService } from './equipment-lifecycle.service';
import {
  extractDisplayText,
  getRecordId,
} from '../../common/feishu/bitable-direct-read';
import type { HistoryLedgerAsset } from './equipment-history.model';
import {
  mapLedgerRecords,
  queryLedger,
  shanghaiDate,
  summarizeLedger,
  normalizeLedgerBuilding,
} from './equipment-ledger.model';

const SOURCE_URL =
  'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
const TTL = 4 * 60 * 60 * 1000;
export const EQUIPMENT_LEDGER_FIELDS = [
  '编号',
  '设备编号',
  '机楼',
  '楼栋标识',
  '设备名称',
  '大设备类型',
  '系统名称',
  '品牌',
  '型号',
  '数量',
  '安装位置',
  '安装日期',
  '维保截止日期',
  '质保期（年）',
  '质保年限来源',
  '条目性质',
  '序列号/出厂编号',
  '资产编号',
  '容量',
  '运行方式',
  '产品其它参数',
  '盘点差异',
  '集合条目核查',
] as const;
interface LedgerSnapshot {
  contentFingerprint?: string;
  records: BitableRecordItem[];
  assets: LedgerAsset[];
  dashboard: LedgerDashboard;
  fetchedAt: number;
}

@Injectable()
export class EquipmentLedgerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EquipmentLedgerService.name);
  private snapshot: LedgerSnapshot | null = null;
  private historySnapshot: {
    snapshotId: string;
    assets: HistoryLedgerAsset[];
    stale: boolean;
  } | null = null;
  private inFlight: Promise<LedgerSnapshot> | null = null;
  private lastFailureAt = 0;
  private warm: Promise<void> | null = null;
  private stateRequest: Promise<LedgerSnapshot> | null = null;
  private readonly backgroundRefresh = createBitableBackgroundRefresh({
    name: EquipmentLedgerService.name,
    warm: async () => {
      await this.getDashboard();
    },
    refresh: async () => {
      await this.getDashboard(true);
    },
  });
  constructor(
    private readonly httpService: HttpService,
    private readonly lifecycle: EquipmentLifecycleService,
  ) {}

  onModuleInit(): void {
    this.warm ??= this.warmSnapshot();
    this.backgroundRefresh.start();
  }
  onModuleDestroy(): void {
    this.backgroundRefresh.stop();
  }

  async getDashboardState(refresh = false, principal?: AccessPrincipal): Promise<LedgerDashboardState> {
    if (!this.snapshot) {
      this.warm ??= this.warmSnapshot();
      await this.warm;
    }
    if (this.snapshot && this.snapshot.dashboard.asOf !== shanghaiDate())
      this.snapshot = this.build(
        this.snapshot.records,
        this.snapshot.fetchedAt,
        this.snapshot.dashboard.stale,
      );
    const needsRead =
      refresh ||
      !this.snapshot ||
      this.snapshot.dashboard.stale ||
      Date.now() - this.snapshot.fetchedAt >= TTL;
    if (
      !this.stateRequest &&
      !this.inFlight &&
      needsRead &&
      (refresh || Date.now() - this.lastFailureAt >= 30000)
    ) {
      const request = this.load(refresh);
      this.stateRequest = request;
      void request
        .catch(() => this.logger.warn('设备台账后台读取失败'))
        .finally(() => {
          if (this.stateRequest === request) this.stateRequest = null;
        });
    }
    const refreshing = Boolean(this.stateRequest || this.inFlight);
    return {
      status: this.snapshot ? 'ready' : refreshing ? 'loading' : 'error',
      dashboard: this.snapshot ? this.scope(this.snapshot, principal).dashboard : null,
      refreshing,
      error:
        !refreshing && this.lastFailureAt ? '设备台账读取失败，请重试' : '',
    };
  }

  async getDashboard(refresh = false, principal?: AccessPrincipal): Promise<LedgerDashboard> {
    return this.scope(await this.load(refresh), principal).dashboard;
  }
  async getItems(query: LedgerQuery, principal?: AccessPrincipal): Promise<LedgerPage> {
    const snapshot = this.scope(await this.load(false), principal);
    const { snapshotId, updatedAt, stale, asOf } = snapshot.dashboard;
    return {
      ...queryLedger(snapshot.assets, query),
      snapshotId,
      updatedAt,
      stale,
      asOf,
    };
  }
  async getHistoryAssets(principal?: AccessPrincipal): Promise<{
    snapshotId: string;
    assets: HistoryLedgerAsset[];
    stale: boolean;
  }> {
    const snapshot = this.scope(await this.load(false), principal);
    if (this.historySnapshot?.snapshotId === snapshot.dashboard.snapshotId)
      return { ...this.historySnapshot, stale: snapshot.dashboard.stale };
    const aliases = new Map(
      snapshot.records.map((r) => [
        getRecordId(r),
        extractDisplayText(r.fields?.['楼栋标识']).trim(),
      ]),
    );
    this.historySnapshot = {
      snapshotId: snapshot.dashboard.snapshotId,
      assets: snapshot.assets.map((a) => ({
        ...a,
        buildingAlias: aliases.get(a.id) || '',
      })),
      stale: snapshot.dashboard.stale,
    };
    return this.historySnapshot;
  }
  async getLifecycle(principal?: AccessPrincipal): Promise<LedgerLifecycle> {
    const view = await this.lifecycle.getDashboard(false, undefined, principal);
    const normalize = <T extends { building: string }>(rows: T[]): T[] =>
      rows.map((row) => ({
        ...row,
        building: normalizeLedgerBuilding(row.building),
      }));
    return {
      status: view.sourceStatus,
      assets: view.assets.map((asset) => ({
        id: asset.id,
        building: normalizeLedgerBuilding(asset.building),
        name: asset.deviceName,
        status: asset.status,
        dueDate: asset.currentExpiryDate,
      })),
      longTermMaintenance: normalize(view.relatedRecords.longTermMaintenance),
      keyParts: normalize(view.relatedRecords.keyParts),
      maintenanceContracts: normalize(view.relatedRecords.maintenanceContracts),
    };
  }

  async getLifecycleDashboard(refresh = false, building?: string, principal?: AccessPrincipal) {
    return this.lifecycle.getDashboard(refresh, building, principal);
  }

  private scope(snapshot: LedgerSnapshot, principal?: AccessPrincipal): LedgerSnapshot {
    const scope = principal ? accessBuildings(principal) : null;
    if (!isProfessionalBusinessPrincipal(principal) && scope === null) return snapshot;
    const assets = filterProfessionalRecords(principal, snapshot.assets, asset => asset.specialty).filter(asset => !scope || (['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].includes(asset.building) && canAccessBuilding(principal!, asset.building)));
    const buildings = [...new Set(assets.map(asset => asset.building))];
    return {
      ...snapshot,
      assets,
      dashboard: {
        ...snapshot.dashboard,
        snapshotId: `${snapshot.dashboard.snapshotId}:${principal!.role}:${scope ? buildingScopeKey(principal!) : (principal!.specialties || []).join(',')}`,
        overview: summarizeLedger(assets),
        buildings: buildings.map(building => summarizeLedger(assets, building)),
      },
    };
  }

  private build(
    records: BitableRecordItem[],
    fetchedAt: number,
    stale: boolean,
    contentFingerprint?: string,
  ): LedgerSnapshot {
    const asOf = shanghaiDate();
    const assets = mapLedgerRecords(records, asOf);
    const snapshotId = createHash('sha256')
      .update(
        JSON.stringify(
          contentFingerprint ? { contentFingerprint, asOf } : { records, asOf },
        ),
      )
      .digest('hex');
    const buildings = [...new Set(assets.map((asset) => asset.building))].sort(
      (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }),
    );
    return {
      contentFingerprint,
      records,
      assets,
      fetchedAt,
      dashboard: {
        snapshotId,
        updatedAt: new Date(fetchedAt).toISOString(),
        asOf,
        stale,
        overview: summarizeLedger(assets),
        buildings: buildings.map((building) =>
          summarizeLedger(assets, building),
        ),
      },
    };
  }

  private async load(refresh: boolean): Promise<LedgerSnapshot> {
    if (this.snapshot && this.snapshot.dashboard.asOf !== shanghaiDate())
      this.snapshot = this.build(
        this.snapshot.records,
        this.snapshot.fetchedAt,
        this.snapshot.dashboard.stale,
        this.snapshot.contentFingerprint,
      );
    if (this.inFlight)
      return !refresh && this.snapshot ? this.snapshot : this.inFlight;
    if (!this.snapshot) {
      this.warm ??= this.warmSnapshot();
      await this.warm;
    }
    if (
      !refresh &&
      this.snapshot &&
      ((!this.snapshot.dashboard.stale &&
        Date.now() - this.snapshot.fetchedAt < TTL) ||
        Date.now() - this.lastFailureAt < 30000)
    ) {
      if (this.snapshot.dashboard.asOf !== shanghaiDate())
        this.snapshot = this.build(
          this.snapshot.records,
          this.snapshot.fetchedAt,
          this.snapshot.dashboard.stale,
          this.snapshot.contentFingerprint,
        );
      return this.snapshot;
    }
    if (this.inFlight)
      return !refresh && this.snapshot ? this.snapshot : this.inFlight;
    this.inFlight = this.readSource(refresh).finally(() => {
      this.inFlight = null;
    });
    if (!refresh && this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        dashboard: { ...this.snapshot.dashboard, stale: true },
      };
      void this.inFlight.catch(() => this.logger.warn('设备台账后台更新失败'));
      return this.snapshot;
    }
    return this.inFlight;
  }

  private async warmSnapshot(): Promise<void> {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_EQUIPMENT_LEDGER_SOURCE_URL') || SOURCE_URL,
    );
    const options = {
      tableId: source.tableId,
      tableName: '南通各机楼设备台账',
      appToken: source.appToken,
      fieldNames: EQUIPMENT_LEDGER_FIELDS,
      directOnly: true,
    };
    const current = await readLatestPersistedBitableRecordSnapshot(
      options,
    ).catch(() => {
      this.logger.warn('设备台账本地快照读取失败');
      return null;
    });
    const persisted =
      current ??
      (await readLatestPersistedBitableRecordSnapshot({
        ...options,
        fieldNames: EQUIPMENT_LEDGER_FIELDS.filter(
          (field) => field !== '楼栋标识',
        ),
      }).catch(() => {
        this.logger.warn('设备台账旧版快照读取失败');
        return null;
      }));
    if (persisted)
      this.restoreSnapshot(
        persisted,
        !current || Date.now() - persisted.fetchedAt >= TTL,
      );
  }

  private restoreSnapshot(
    persisted: {
      records: BitableRecordItem[];
      fetchedAt: number;
      contentFingerprint?: string;
    },
    stale: boolean,
  ): boolean {
    try {
      if (
        !Number.isFinite(persisted.fetchedAt) ||
        !Number.isFinite(new Date(persisted.fetchedAt).getTime()) ||
        !Array.isArray(persisted.records) ||
        persisted.records.some(
          (record) =>
            !record || typeof record !== 'object' || Array.isArray(record),
        ) ||
        (persisted.records.length > 0 &&
          !persisted.records.some((record) =>
            Object.prototype.hasOwnProperty.call(
              record.fields || {},
              '设备名称',
            ),
          ))
      )
        throw new Error('Invalid equipment snapshot');
      this.snapshot = this.build(
        persisted.records,
        persisted.fetchedAt,
        stale,
        persisted.contentFingerprint,
      );
      return true;
    } catch {
      this.logger.warn('设备台账本地快照无效，等待重新读取');
      return false;
    }
  }

  private async readSource(refresh: boolean): Promise<LedgerSnapshot> {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_EQUIPMENT_LEDGER_SOURCE_URL') || SOURCE_URL,
    );
    const tableId = source.tableId;
    const tableName = '南通各机楼设备台账';
    try {
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken: source.appToken,
        wikiToken: source.wikiToken,
        tableName,
      });
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        tableName,
        fieldNames: EQUIPMENT_LEDGER_FIELDS,
        cacheTtlMs: TTL,
        forceRefresh: refresh,
        allowStale: false,
        strict: true,
      });
      if (
        records.length &&
        !records.some((record) =>
          Object.prototype.hasOwnProperty.call(record.fields || {}, '设备名称'),
        )
      )
        throw new Error('设备台账字段结构不匹配');
      this.snapshot = this.build(records, Date.now(), false);
      this.lastFailureAt = 0;
      return this.snapshot;
    } catch {
      this.lastFailureAt = Date.now();
      this.logger.warn('设备台账读取失败，尝试保留最近成功快照');
      if (this.snapshot) {
        this.snapshot = this.build(
          this.snapshot.records,
          this.snapshot.fetchedAt,
          true,
          this.snapshot.contentFingerprint,
        );
        return this.snapshot;
      }
      const persisted = await readLatestPersistedBitableRecordSnapshot({
        tableId,
        tableName,
        appToken: source.appToken,
        fieldNames: EQUIPMENT_LEDGER_FIELDS,
      }).catch(() => null);
      if (persisted && this.restoreSnapshot(persisted, true) && this.snapshot)
        return this.snapshot;
      throw new ServiceUnavailableException('设备台账暂时不可用，请重试');
    }
  }
}
