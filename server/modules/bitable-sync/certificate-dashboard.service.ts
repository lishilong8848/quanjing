import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { CampusCertificateDashboardResponse } from '../../../shared/api.interface';
import { readEnv } from '../../common/config/external-services.config';
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
import { mapCampusCertificateDashboard } from './certificate-dashboard.mapper';

const DEFAULT_WIKI_TOKEN = 'Rz4GwoB8Fi4WyokVcCPcmWJMnle';
const DEFAULT_TABLE_ID = 'tbl9NBxImAt3kzx2';
const SOURCE_NAME = '园区持证正式表';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_ERROR_MESSAGE = '源数据同步失败，已展示上次成功结果';
const MIN_LAST_GOOD_RATIO = 0.7;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const FAILURE_RETRY_MS = 30 * 1000;

interface CertificateReadState {
  source: DashboardSourceBinding;
  key: string;
  appToken?: string;
  generation?: number;
  snapshot?: CampusCertificateDashboardResponse;
  fetchedAt: number;
  lastFailureAt: number;
  warm?: Promise<void>;
  refresh?: Promise<CampusCertificateDashboardResponse>;
}

@Injectable()
export class CertificateDashboardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CertificateDashboardService.name);
  private state?: CertificateReadState;
  private destroyed = false;
  private readonly background = createBitableBackgroundRefresh({
    name: CertificateDashboardService.name,
    intervalMs: REFRESH_INTERVAL_MS,
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
  ): Promise<CampusCertificateDashboardResponse> {
    const state = this.currentState();
    state.warm ??= this.warmSnapshot(state);
    await state.warm;
    this.assertCurrent(state);
    if (forceRefresh || !state.snapshot) return this.refreshState(state);
    const stale = Date.now() - state.fetchedAt >= REFRESH_INTERVAL_MS || state.lastFailureAt > 0;
    if (stale && !state.refresh && (!state.lastFailureAt || Date.now() - state.lastFailureAt >= FAILURE_RETRY_MS)) {
      void this.refreshState(state).catch(() => this.logger.warn('园区持证后台更新暂不可用'));
    }
    return stale ? markSnapshotStale(state.snapshot, state.lastFailureAt > 0) : state.snapshot;
  }

  refresh(): Promise<CampusCertificateDashboardResponse> {
    return this.getDashboard(true);
  }

  private source(): DashboardSourceBinding {
    return {
      namespace: 'certificate-dashboard', appId: readEnv('FEISHU_APP_ID'),
      appToken: readEnv('FEISHU_CERTIFICATE_APP_TOKEN'),
      wikiToken: readEnv('FEISHU_CERTIFICATE_WIKI_TOKEN') || DEFAULT_WIKI_TOKEN,
      tableId: readEnv('FEISHU_CERTIFICATE_TABLE_ID') || DEFAULT_TABLE_ID,
    };
  }

  private currentState(): CertificateReadState {
    const source = this.source(), key = dashboardSourceBindingKey(source);
    if (!this.state || this.state.key !== key || (this.state.appToken && this.state.generation !== getBitableRecordCacheGeneration(this.state.appToken, this.state.source.tableId))) {
      this.state = { source, key, fetchedAt: 0, lastFailureAt: 0 };
    }
    return this.state;
  }

  private assertCurrent(state: CertificateReadState): void {
    if (this.destroyed || this.state !== state || dashboardSourceBindingKey(this.source()) !== state.key ||
      (state.appToken && state.generation !== getBitableRecordCacheGeneration(state.appToken, state.source.tableId))) {
      throw new ServiceUnavailableException('持证数据源已变化，请重新读取');
    }
  }

  private async warmSnapshot(state: CertificateReadState): Promise<void> {
    try {
      const appToken = await readDashboardSourceBinding(state.source);
      this.assertCurrent(state);
      if (!appToken) return;
      state.appToken = appToken;
      state.generation = getBitableRecordCacheGeneration(appToken, state.source.tableId);
      const persisted = await readLatestPersistedBitableRecordSnapshot({ appToken, tableId: state.source.tableId, tableName: SOURCE_NAME, directOnly: true });
      this.assertCurrent(state);
      if (!persisted || !Number.isFinite(persisted.fetchedAt)) return;
      state.snapshot = buildCheckedDashboard(persisted.records, undefined, persisted.fetchedAt);
      state.fetchedAt = persisted.fetchedAt;
    } catch { this.logger.warn('园区持证本地快照暂不可用'); }
  }

  private refreshState(state: CertificateReadState): Promise<CampusCertificateDashboardResponse> {
    if (state.refresh) return state.refresh;
    const request = this.loadDashboard(state);
    state.refresh = request;
    void request.then(() => { if (state.refresh === request) state.refresh = undefined; }, () => { if (state.refresh === request) state.refresh = undefined; });
    return request;
  }

  private async loadDashboard(state: CertificateReadState): Promise<CampusCertificateDashboardResponse> {
    try {
      const appToken = state.source.appToken || await resolveBitableAppToken(this.httpService, { wikiToken: state.source.wikiToken, tableName: SOURCE_NAME });
      this.assertCurrent(state);
      if (state.appToken && state.appToken !== appToken) { state.snapshot = undefined; state.fetchedAt = 0; }
      state.appToken = appToken;
      state.generation = getBitableRecordCacheGeneration(appToken, state.source.tableId);
      const previousPeopleCount = state.snapshot?.people.length;
      let fetchedAt = 0;
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: state.source.tableId,
        tableName: SOURCE_NAME,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh: true,
        strict: true,
        allowStale: false,
        validateRecords: candidate => assertCertificateRecordsQuality(candidate, previousPeopleCount),
        onPersisted: snapshot => { fetchedAt = snapshot.fetchedAt; },
      });
      this.assertCurrent(state);
      fetchedAt ||= Date.now();
      const dashboard = buildCheckedDashboard(records, previousPeopleCount, fetchedAt);
      await writeDashboardSourceBinding(state.source, appToken).catch(() => this.logger.warn('园区持证来源绑定保存失败'));
      this.assertCurrent(state);
      state.snapshot = dashboard;
      state.fetchedAt = fetchedAt;
      state.lastFailureAt = 0;
      return dashboard;
    } catch {
      this.assertCurrent(state);
      this.logger.warn('园区持证数据同步失败');
      state.lastFailureAt = Date.now();
      if (state.snapshot) return markSnapshotStale(state.snapshot);
      throw new ServiceUnavailableException('园区持证数据同步失败，请稍后重试');
    }
  }
}

function buildCheckedDashboard(
  records: BitableRecordItem[],
  previousPeopleCount?: number,
  fetchedAt = Date.now(),
): CampusCertificateDashboardResponse {
  const dashboard = mapCampusCertificateDashboard(
    records,
    new Date(fetchedAt).toISOString(),
  );
  assertDashboardQuality(dashboard, previousPeopleCount);
  return dashboard;
}

function assertCertificateRecordsQuality(
  records: BitableRecordItem[],
  previousPeopleCount?: number,
): void {
  assertDashboardQuality(
    mapCampusCertificateDashboard(records, '1970-01-01T00:00:00.000Z'),
    previousPeopleCount,
  );
}

function assertDashboardQuality(
  dashboard: CampusCertificateDashboardResponse,
  previousPeopleCount?: number,
): void {
  const total = dashboard.people.length;
  const unknownCount = dashboard.people.filter(
    (person) => person.complianceStatus === '未知',
  ).length;
  const isObviouslyTruncated =
    typeof previousPeopleCount === 'number' &&
    previousPeopleCount > 0 &&
    total < Math.ceil(previousPeopleCount * MIN_LAST_GOOD_RATIO);
  if (total === 0 || unknownCount > total / 2 || isObviouslyTruncated) {
    throw new Error('园区持证数据质量校验失败');
  }
}

function markSnapshotStale(
  snapshot: CampusCertificateDashboardResponse,
  failed = true,
): CampusCertificateDashboardResponse {
  return {
    ...snapshot,
    sourceStatus: 'stale',
    errorMessage: failed ? STALE_ERROR_MESSAGE : undefined,
  };
}
