import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import type {
  CampusTrainingDashboardResponse,
  TrainingParticipation,
} from '../../../shared/campus-training-dashboard.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  DEFAULT_TRAINING_WIKI_TOKEN,
  TRAINING_DASHBOARD_TABLE_CONFIGS,
  getTrainingTableId,
  type TrainingSourceKey,
  type TrainingTableConfig,
} from './training-dashboard.fields';
import {
  mapCampusTrainingDashboard,
  type TrainingDashboardSources,
} from './training-dashboard.mapper';
import {
  readTrainingDashboardSourceSnapshot,
  writeTrainingDashboardSourceSnapshot,
} from './training-dashboard.snapshot-store';

const LATEST_KEY = 'latest';
const DASHBOARD_CACHE_TTL_MS = 60 * 1000;
const SOURCE_BUNDLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BITABLE_RECORD_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_SNAPSHOT_CACHE_KEYS = 24;
const SOURCE_NAME = '园区培训进展看板';
const STALE_ERROR_MESSAGE = '源数据同步失败，已展示上次成功结果';
const BACKGROUND_SYNC_MESSAGE = '培训数据正在后台同步，完成后将自动更新';
const DEFAULT_TRAINING_PASS_SCORE = 80;

interface CachedDashboardSnapshot {
  snapshot: CampusTrainingDashboardResponse;
  cachedAt: number;
}

interface CachedTrainingSources {
  sources: TrainingDashboardSources;
  cachedAt: number;
}

@Injectable()
export class TrainingDashboardService {
  private readonly logger = new Logger(TrainingDashboardService.name);
  private readonly lastGoodSnapshots = new Map<
    string,
    CachedDashboardSnapshot
  >();
  private readonly activeRefreshes = new Map<
    string,
    Promise<CampusTrainingDashboardResponse>
  >();
  private lastGoodSources: CachedTrainingSources | null = null;
  private activeSourceRefresh: Promise<TrainingDashboardSources> | null = null;
  private appTokenPromise: Promise<string> | null = null;

  constructor(private readonly httpService: HttpService) {}

  getDashboard(
    month?: string,
    forceRefresh = false,
  ): Promise<CampusTrainingDashboardResponse> {
    const requestKey = month || LATEST_KEY;
    const cached = this.lastGoodSnapshots.get(requestKey);
    if (
      !forceRefresh &&
      cached &&
      Date.now() - cached.cachedAt < DASHBOARD_CACHE_TTL_MS
    ) {
      return Promise.resolve(cached.snapshot);
    }
    const activeRefresh = this.activeRefreshes.get(requestKey);
    if (activeRefresh) {
      return activeRefresh;
    }

    let refresh!: Promise<CampusTrainingDashboardResponse>;
    refresh = this.loadDashboard(month, requestKey, forceRefresh).finally(
      () => {
        if (this.activeRefreshes.get(requestKey) === refresh) {
          this.activeRefreshes.delete(requestKey);
        }
      },
    );
    this.activeRefreshes.set(requestKey, refresh);
    return refresh;
  }

  refresh(month?: string): Promise<CampusTrainingDashboardResponse> {
    return this.getDashboard(month, true);
  }

  async getMonthlyPatrolParticipation(
    month: string,
  ): Promise<TrainingParticipation[]> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error('月度培训月份无效');
    }
    const config = TRAINING_DASHBOARD_TABLE_CONFIGS.find(
      (item) => item.key === 'activeStats',
    )!;
    const records = await fetchBitableRecords(this.httpService, {
      appToken: await this.resolveAppToken(),
      tableId: getTrainingTableId(config),
      tableName: config.tableName,
      fieldNames: [...config.fieldNames],
      cacheTtlMs: BITABLE_RECORD_CACHE_TTL_MS,
      forceRefresh: true,
      strict: true,
      validateRecords: (items) => assertTrainingTableQuality(config, items),
    });
    const dashboard = mapCampusTrainingDashboard(
      { ...emptyTrainingSources(), activeStats: records },
      month,
      new Date().toISOString(),
      readTrainingPassScore(),
    );
    const participation = dashboard.participation.filter(
      (item) => item.assessmentPassRate !== null,
    );
    if (participation.length === 0) {
      throw new Error(`月度培训统计缺少 ${month} 楼栋数据`);
    }
    return participation;
  }

  private async loadDashboard(
    requestedMonth: string | undefined,
    requestKey: string,
    forceRefresh: boolean,
  ): Promise<CampusTrainingDashboardResponse> {
    if (!forceRefresh) {
      return this.loadDashboardWithoutBlocking(requestedMonth, requestKey);
    }

    try {
      const sources = await this.getLiveSources(true);
      const dashboard = buildCheckedDashboard(sources, requestedMonth);
      this.cacheSnapshot(requestKey, dashboard);
      return dashboard;
    } catch {
      this.logger.warn('园区培训实时数据同步失败');
      const lastGood = this.lastGoodSnapshots.get(requestKey);
      if (lastGood) {
        const staleSnapshot = markSnapshotStale(lastGood.snapshot);
        this.cacheSnapshot(requestKey, staleSnapshot);
        return staleSnapshot;
      }
      if (this.lastGoodSources) {
        const staleSnapshot = markSnapshotStale(
          buildCheckedDashboard(this.lastGoodSources.sources, requestedMonth),
        );
        this.cacheSnapshot(requestKey, staleSnapshot);
        return staleSnapshot;
      }
    }

    try {
      const sources = await readTrainingDashboardSourceSnapshot();
      if (!sources) {
        throw new Error('training source snapshot missing');
      }
      assertAllSourcesQuality(sources);
      this.lastGoodSources = { sources, cachedAt: 0 };
      const dashboard = markSnapshotStale(
        buildCheckedDashboard(sources, requestedMonth),
      );
      this.cacheSnapshot(requestKey, dashboard);
      return dashboard;
    } catch {
      this.logger.warn('园区培训持久快照不可用');
      const dashboard = markSnapshotStale(
        buildCheckedDashboard(emptyTrainingSources(), requestedMonth),
        BACKGROUND_SYNC_MESSAGE,
      );
      this.cacheSnapshot(requestKey, dashboard);
      return dashboard;
    }
  }

  private async loadDashboardWithoutBlocking(
    requestedMonth: string | undefined,
    requestKey: string,
  ): Promise<CampusTrainingDashboardResponse> {
    if (this.lastGoodSources) {
      const dashboard =
        Date.now() - this.lastGoodSources.cachedAt < SOURCE_BUNDLE_CACHE_TTL_MS
          ? buildCheckedDashboard(this.lastGoodSources.sources, requestedMonth)
          : markSnapshotStale(
              buildCheckedDashboard(
                this.lastGoodSources.sources,
                requestedMonth,
              ),
            );
      this.cacheSnapshot(requestKey, dashboard);
      if (dashboard.sourceStatus === 'stale') {
        this.refreshSourcesInBackground();
      }
      return dashboard;
    }

    const storedSources = await readTrainingDashboardSourceSnapshot();
    if (storedSources) {
      try {
        assertAllSourcesQuality(storedSources);
        this.lastGoodSources = { sources: storedSources, cachedAt: 0 };
        const dashboard = markSnapshotStale(
          buildCheckedDashboard(storedSources, requestedMonth),
        );
        this.cacheSnapshot(requestKey, dashboard);
        this.refreshSourcesInBackground();
        return dashboard;
      } catch {
        this.logger.warn('园区培训持久快照不可用');
      }
    }

    const dashboard = markSnapshotStale(
      buildCheckedDashboard(emptyTrainingSources(), requestedMonth),
      BACKGROUND_SYNC_MESSAGE,
    );
    this.cacheSnapshot(requestKey, dashboard);
    this.refreshSourcesInBackground();
    return dashboard;
  }

  private refreshSourcesInBackground(): void {
    void this.getLiveSources(true)
      .then(() => {
        this.lastGoodSnapshots.clear();
      })
      .catch(() => {
        this.logger.warn('园区培训后台数据同步失败');
      });
  }

  private getLiveSources(
    forceRefresh: boolean,
  ): Promise<TrainingDashboardSources> {
    if (
      !forceRefresh &&
      this.lastGoodSources &&
      Date.now() - this.lastGoodSources.cachedAt < SOURCE_BUNDLE_CACHE_TTL_MS
    ) {
      return Promise.resolve(this.lastGoodSources.sources);
    }
    if (this.activeSourceRefresh) {
      return this.activeSourceRefresh;
    }

    let refresh!: Promise<TrainingDashboardSources>;
    refresh = this.loadLiveSources(forceRefresh)
      .then((sources) => {
        this.lastGoodSources = { sources, cachedAt: Date.now() };
        void writeTrainingDashboardSourceSnapshot(sources).catch(() => {
          this.logger.warn('园区培训完整源快照写入失败');
        });
        return sources;
      })
      .finally(() => {
        if (this.activeSourceRefresh === refresh) {
          this.activeSourceRefresh = null;
        }
      });
    this.activeSourceRefresh = refresh;
    return refresh;
  }

  private async loadLiveSources(
    forceRefresh: boolean,
  ): Promise<TrainingDashboardSources> {
    const appToken = await this.resolveAppToken();
    const entries = await Promise.all(
      TRAINING_DASHBOARD_TABLE_CONFIGS.map(async (config) => {
        const records = await fetchBitableRecords(this.httpService, {
          appToken,
          tableId: getTrainingTableId(config),
          tableName: config.tableName,
          fieldNames: [...config.fieldNames],
          cacheTtlMs: BITABLE_RECORD_CACHE_TTL_MS,
          forceRefresh,
          strict: true,
          validateRecords: (items) => assertTrainingTableQuality(config, items),
        });
        return [config.key, records] as const;
      }),
    );
    const sources = buildTrainingSources(entries);
    assertAllSourcesQuality(sources);
    return sources;
  }

  private resolveAppToken(): Promise<string> {
    const configuredAppToken = readEnv('FEISHU_TRAINING_APP_TOKEN');
    if (configuredAppToken) {
      return Promise.resolve(configuredAppToken);
    }
    if (!this.appTokenPromise) {
      const wikiToken =
        readEnv('FEISHU_TRAINING_WIKI_TOKEN') || DEFAULT_TRAINING_WIKI_TOKEN;
      this.appTokenPromise = resolveBitableAppToken(this.httpService, {
        wikiToken,
        tableName: SOURCE_NAME,
      }).catch((error: unknown) => {
        this.appTokenPromise = null;
        throw error;
      });
    }
    return this.appTokenPromise;
  }

  private cacheSnapshot(
    requestKey: string,
    snapshot: CampusTrainingDashboardResponse,
  ): void {
    const cacheEntry: CachedDashboardSnapshot = {
      snapshot,
      cachedAt: Date.now(),
    };
    this.setCacheEntry(requestKey, cacheEntry);
    this.setCacheEntry(snapshot.month, cacheEntry);
    while (this.lastGoodSnapshots.size > MAX_SNAPSHOT_CACHE_KEYS) {
      const oldestKey = this.lastGoodSnapshots.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      this.lastGoodSnapshots.delete(oldestKey);
    }
  }

  private setCacheEntry(key: string, entry: CachedDashboardSnapshot): void {
    this.lastGoodSnapshots.delete(key);
    this.lastGoodSnapshots.set(key, entry);
  }
}

function buildTrainingSources(
  entries: ReadonlyArray<readonly [TrainingSourceKey, BitableRecordItem[]]>,
): TrainingDashboardSources {
  const sources = emptyTrainingSources();
  for (const [key, records] of entries) {
    sources[key] = records;
  }
  return sources;
}

function emptyTrainingSources(): TrainingDashboardSources {
  return {
    activeStats: [],
    activeScores: [],
    activePlans: [],
    newHireScores: [],
    newHireCourses: [],
    newHirePlans: [],
    sharingSessions: [],
    sharingScores: [],
    sharingInterests: [],
  };
}

function assertAllSourcesQuality(sources: TrainingDashboardSources): void {
  for (const config of TRAINING_DASHBOARD_TABLE_CONFIGS) {
    assertTrainingTableQuality(config, sources[config.key]);
  }
}

function assertTrainingTableQuality(
  config: TrainingTableConfig,
  records: BitableRecordItem[],
): void {
  if (records.length === 0) {
    if (config.allowEmpty) return;
    throw new Error(`training source quality failed: ${config.tableName}`);
  }
  if (
    !records.some((record) =>
      config.qualityFieldGroups.some((fieldGroup) =>
        fieldGroup.every((fieldName) =>
          hasRealValue(record.fields?.[fieldName]),
        ),
      ),
    )
  ) {
    throw new Error(`training source quality failed: ${config.tableName}`);
  }
}

function hasRealValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasRealValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasRealValue);
  }
  return false;
}

function buildCheckedDashboard(
  sources: TrainingDashboardSources,
  requestedMonth: string | undefined,
): CampusTrainingDashboardResponse {
  const dashboard = mapCampusTrainingDashboard(
    sources,
    requestedMonth,
    new Date().toISOString(),
    readTrainingPassScore(),
  );
  assertDashboardQuality(dashboard);
  return dashboard;
}

function readTrainingPassScore(): number {
  const raw = readEnv('FEISHU_TRAINING_PASS_SCORE')?.trim();
  if (!raw) return DEFAULT_TRAINING_PASS_SCORE;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 && configured <= 100
    ? configured
    : DEFAULT_TRAINING_PASS_SCORE;
}

function assertDashboardQuality(
  dashboard: CampusTrainingDashboardResponse,
): void {
  if (!/^\d{4}-\d{2}$/.test(dashboard.month)) {
    throw new Error('training dashboard quality failed');
  }
  assertFiniteNumbers(dashboard);
}

function assertFiniteNumbers(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('training dashboard quality failed');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertFiniteNumbers);
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(
      assertFiniteNumbers,
    );
  }
}

function markSnapshotStale(
  snapshot: CampusTrainingDashboardResponse,
  errorMessage = STALE_ERROR_MESSAGE,
): CampusTrainingDashboardResponse {
  const copy = JSON.parse(
    JSON.stringify(snapshot),
  ) as CampusTrainingDashboardResponse;
  return {
    ...copy,
    sourceStatus: 'stale',
    errorMessage,
  };
}
