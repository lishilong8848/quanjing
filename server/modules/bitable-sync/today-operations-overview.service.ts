import { HttpService } from '@nestjs/axios';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  TodayOperationsOverviewResponse,
  TodayOperationsFocusDetails,
  TodayOperationsRackBuildingLoad,
  TodayOperationsRackSummary,
  TodayOperationsWorkDetails,
  TodayOperationsWorkItem,
  TodayOperationsWorkKind,
  TodayOperationsWorkSourceState,
  TodayOperationsWorkSourceStates,
  TodayOperationsWorkSummary,
} from '../../../shared/today-operations-overview.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  type BitableRecordSearchFilter,
  type BitableRecordSearchSort,
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractNumberValue,
  fetchBitableRecords,
  getRecordId,
  pickField,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const WORK_SOURCE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 30 * 1000;
const SOURCE_READ_BUDGET_MS = 10_000;
const REQUIRED_BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const;

const DEFAULT_SOURCE_URLS = {
  rackLoad:
    'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  rackShift:
    'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  rackMonthly:
    'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  events:
    'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
  changes:
    'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
  maintenance:
    'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
  inspection:
    'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
} as const;

type SourceKey = keyof typeof DEFAULT_SOURCE_URLS;

const SOURCE_DEFINITIONS: Record<
  SourceKey,
  { envKey: string; tableName: string }
> = {
  rackLoad: {
    envKey: 'TODAY_OPERATIONS_OVERVIEW_RACK_LOAD_URL',
    tableName: '今日全景各楼IT负载率',
  },
  rackShift: {
    envKey: 'TODAY_OPERATIONS_OVERVIEW_RACK_SHIFT_URL',
    tableName: '今日全景机柜班次变动',
  },
  rackMonthly: {
    envKey: 'TODAY_OPERATIONS_OVERVIEW_RACK_MONTHLY_URL',
    tableName: '今日全景机柜月度汇总',
  },
  events: {
    envKey: 'TODAY_OPERATIONS_OVERVIEW_EVENTS_URL',
    tableName: '今日全景事件',
  },
  changes: {
    envKey: 'TODAY_OPERATIONS_OVERVIEW_CHANGES_URL',
    tableName: '今日全景变更',
  },
  maintenance: {
    envKey: 'TODAY_OPERATIONS_OVERVIEW_MAINTENANCE_URL',
    tableName: '今日全景维保',
  },
  inspection: {
    envKey: 'TODAY_OPERATIONS_OVERVIEW_INSPECTION_URL',
    tableName: '今日全景检修',
  },
};

const RACK_LOAD_FIELDS = ['楼栋', '日期', 'IT负载率'] as const;
const RACK_SHIFT_FIELDS = [
  '楼栋',
  '日期',
  '班次',
  '修改时间',
  '本班组上电机柜数（个）',
  '本班组下电机柜数（个）',
] as const;
const RACK_MONTHLY_FIELDS = [
  '楼栋名称',
  '年度',
  '月度',
  '当月最后日期',
  '机柜设计数量',
  '实际上电数量',
] as const;
const INSPECTION_TITLE_FIELDS = [
  '标题',
  '标题（名称）',
  '检修项目名称',
  '检修名称',
  '检修项目',
  '检修主题',
  '名称',
  '检修内容',
  '内容',
];
const INSPECTION_METHOD_FIELDS = ['维修方式', '检修方式'];
const INSPECTION_START_FIELDS = [
  '实际开始时间',
  '检修实际开始时间',
  '计划开始时间',
  '检修开始时间',
  '开始时间',
];
const INSPECTION_END_FIELDS = [
  '预期结束时间',
  '预计结束时间',
  '计划结束时间',
  '检修结束时间',
  '实际结束时间',
  '结束时间',
];
const CHANGE_ACTUAL_END_FIELDS = ['实际结束时间', '变更实际结束时间'];
const CHANGE_PLANNED_END_FIELDS = [
  '变更结束时间',
  '计划结束时间',
  '预计结束时间',
];
const INSPECTION_ACTUAL_END_FIELDS = ['实际结束时间', '检修实际结束时间'];
const BUILDING_FIELDS = ['楼栋', '机楼', '所在楼栋', '所属楼栋'];
const SPECIALTY_FIELDS = ['专业', '所属专业'];
const MAINTENANCE_TITLE_FIELDS = [
  '维保项目名称',
  '维保项目',
  '项目名称',
  '维保名称',
  '名称',
  '内容',
];
const WORK_SOURCE_LABELS: Record<TodayOperationsWorkKind, string> = {
  events: '今日事件',
  changes: '今日变更',
  inspections: '今日检修',
  maintenance: '今日维保',
};

interface SourceConfig {
  appToken: string;
  tableId: string;
  tableName: string;
  viewId?: string;
}

interface SourceReadState {
  stale: boolean;
  staleFetchedAt: number[];
  forceRefresh: boolean;
  businessDate: string;
  errors: unknown[];
}

interface SourceRecordsOptions {
  config: SourceConfig;
  fieldNames?: readonly string[];
  filter?: BitableRecordSearchFilter;
  sort?: readonly BitableRecordSearchSort[];
  state: SourceReadState;
  dailyScoped?: boolean;
}

interface SourceResolution {
  config: SourceConfig | null;
  fallbackConfig: SourceConfig;
  error: unknown | null;
}

interface WorkSourceResult {
  records: BitableRecordItem[];
  sourceState: TodayOperationsWorkSourceState;
}

interface WorkSourceSnapshot {
  businessDate: string;
  records: BitableRecordItem[];
  fetchedAt: number;
}

interface ShanghaiDay {
  date: string;
  startMs: number;
  year: string;
  month: string;
}

interface ShiftSnapshot {
  date: string | null;
  name: string;
  modifiedAt: number;
  poweredOn: number;
  poweredOff: number;
}

@Injectable()
export class TodayOperationsOverviewService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TodayOperationsOverviewService.name);
  private readonly workSourceSnapshots = new Map<
    TodayOperationsWorkKind,
    WorkSourceSnapshot
  >();
  private workSourceSyncTimer: NodeJS.Timeout | null = null;
  private workSourceSyncRequest: Promise<void> | null = null;
  private overviewRequest?: {
    businessDate: string;
    promise: Promise<TodayOperationsOverviewResponse>;
  };
  private rackSnapshot?: {
    businessDate: string;
    summary: TodayOperationsRackSummary;
    fetchedAt: number;
  };

  private snapshot:
    | {
        businessDate: string;
        expiresAt: number;
        retryAt: number;
        response: TodayOperationsOverviewResponse;
      }
    | undefined;

  constructor(
    @Inject(HttpService)
    private readonly httpService: HttpService,
  ) {}

  onModuleInit(): void {
    if (
      /^(?:1|true|on|yes)$/i.test(
        process.env.NANTONG_HOTFIX_SMOKE_MODE?.trim() || '',
      )
    ) {
      return;
    }
    this.triggerEventAndChangeSync();
    this.workSourceSyncTimer = setInterval(
      () => this.triggerEventAndChangeSync(),
      WORK_SOURCE_SYNC_INTERVAL_MS,
    );
    this.workSourceSyncTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.workSourceSyncTimer) {
      clearInterval(this.workSourceSyncTimer);
      this.workSourceSyncTimer = null;
    }
  }

  syncEventAndChangeSources(): Promise<void> {
    if (this.workSourceSyncRequest) {
      return this.workSourceSyncRequest;
    }

    let request!: Promise<void>;
    request = this.refreshEventAndChangeSources().finally(() => {
      if (this.workSourceSyncRequest === request) {
        this.workSourceSyncRequest = null;
      }
    });
    this.workSourceSyncRequest = request;
    return request;
  }

  private triggerEventAndChangeSync(): void {
    void this.syncEventAndChangeSources().catch(() => {
      this.logger.warn('今日全景事件、变更后台同步失败，继续保留最近有效数据');
    });
  }

  private async refreshEventAndChangeSources(): Promise<void> {
    const now = new Date();
    const day = createShanghaiDay(now);
    const state: SourceReadState = {
      stale: false,
      staleFetchedAt: [],
      forceRefresh: true,
      businessDate: day.date,
      errors: [],
    };
    const [eventResolution, changeResolution] = await Promise.all([
      this.resolveSource('events'),
      this.resolveSource('changes'),
    ]);
    const [eventSource, changeSource] = await Promise.all([
      this.loadWorkSource('events', eventResolution, undefined, day, state),
      this.loadWorkSource('changes', changeResolution, undefined, day, state),
    ]);

    if (this.snapshot?.businessDate === day.date) {
      const previous = this.snapshot.response;
      const mapped = mapWorkOverview(
        day,
        eventSource.records,
        changeSource.records,
        [],
        [],
      );
      const eventAvailable = eventSource.sourceState.status !== 'failed';
      const changeAvailable = changeSource.sourceState.status !== 'failed';
      const sourceStates: TodayOperationsWorkSourceStates = {
        ...previous.sourceStates,
        events: eventSource.sourceState,
        changes: changeSource.sourceState,
      };
      const previousCoreWasStale =
        previous.rackSourceState?.status !== undefined ||
        (previous.sourceStatus === 'stale' &&
          !Object.values(previous.sourceStates).some(
            (sourceState) => sourceState.status === 'stale',
          ));
      const mappedSourceStatus = resolveOverviewSourceStatus(
        sourceStates,
        false,
      );
      const sourceStatus =
        previous.rackSummary === null
          ? 'partial'
          : mappedSourceStatus === 'fresh' && previousCoreWasStale
            ? 'stale'
            : mappedSourceStatus;
      const response: TodayOperationsOverviewResponse = {
        ...previous,
        sourceStatus,
        syncedAt:
          eventAvailable &&
          changeAvailable &&
          eventSource.sourceState.status === 'fresh' &&
          changeSource.sourceState.status === 'fresh'
            ? now.toISOString()
            : previous.syncedAt,
        operations: {
          ...previous.operations,
          ...(eventAvailable
            ? {
                todayEvents: mapped.summary.todayEvents,
                pendingEvents: mapped.summary.pendingEvents,
                priorPendingEvents: mapped.summary.priorPendingEvents,
                closedTodayEvents: mapped.summary.closedTodayEvents,
                keyEvents: mapped.summary.keyEvents,
              }
            : {}),
          ...(changeAvailable
            ? {
                todayChanges: mapped.summary.todayChanges,
                activeChanges: mapped.summary.activeChanges,
                priorActiveChanges: mapped.summary.priorActiveChanges,
                keyChanges: mapped.summary.keyChanges,
              }
            : {}),
        },
        details: {
          ...previous.details,
          events: eventAvailable
            ? mapped.details.events
            : previous.details.events,
          changes: changeAvailable
            ? mapped.details.changes
            : previous.details.changes,
        },
        focusDetails: {
          pendingEvents: eventAvailable
            ? mapped.focusDetails.pendingEvents
            : previous.focusDetails.pendingEvents,
          activeChanges: changeAvailable
            ? mapped.focusDetails.activeChanges
            : previous.focusDetails.activeChanges,
        },
        sourceStates,
      };
      this.snapshot = {
        ...this.snapshot,
        ...(sourceStatus === 'fresh'
          ? {
              expiresAt: Date.now() + SOURCE_CACHE_TTL_MS,
              retryAt: 0,
            }
          : {
              expiresAt: 0,
              retryAt: Date.now() + RETRY_AFTER_ERROR_MS,
            }),
        response,
      };
    }

    if (
      eventSource.sourceState.status === 'failed' ||
      changeSource.sourceState.status === 'failed'
    ) {
      throw new Error('事件或变更数据源暂时不可用');
    }
  }

  async getOverview(
    forceRefresh = false,
  ): Promise<TodayOperationsOverviewResponse> {
    const now = Date.now();
    const businessDate = createShanghaiDay(new Date(now)).date;
    if (this.overviewRequest?.businessDate === businessDate) {
      return this.overviewRequest.promise;
    }
    if (
      !forceRefresh &&
      this.snapshot &&
      this.snapshot.businessDate === businessDate &&
      (this.snapshot.expiresAt > now || this.snapshot.retryAt > now)
    ) {
      return this.snapshot.response;
    }

    const promise = this.refreshOverview(now, businessDate, forceRefresh);
    this.overviewRequest = { businessDate, promise };
    try {
      return await promise;
    } finally {
      if (this.overviewRequest?.promise === promise)
        this.overviewRequest = undefined;
    }
  }

  private async refreshOverview(
    now: number,
    businessDate: string,
    forceRefresh: boolean,
  ): Promise<TodayOperationsOverviewResponse> {
    try {
      const response = await this.loadOverview(new Date(now), forceRefresh);
      const isFresh = response.sourceStatus === 'fresh';
      if (createShanghaiDay(new Date()).date === businessDate)
        this.snapshot = {
          businessDate: response.businessDate,
          expiresAt: isFresh ? now + SOURCE_CACHE_TTL_MS : 0,
          retryAt: isFresh ? 0 : now + RETRY_AFTER_ERROR_MS,
          response,
        };
      return response;
    } catch {
      if (this.snapshot?.businessDate === businessDate) {
        const staleResponse: TodayOperationsOverviewResponse = {
          ...this.snapshot.response,
          sourceStatus: 'stale',
        };
        this.snapshot = {
          businessDate,
          expiresAt: 0,
          retryAt: now + RETRY_AFTER_ERROR_MS,
          response: staleResponse,
        };
        return staleResponse;
      }
      throw new ServiceUnavailableException(
        '今日全景运行数据暂时不可用，请稍后重试。',
      );
    }
  }

  private async loadOverview(
    now: Date,
    forceRefresh: boolean,
  ): Promise<TodayOperationsOverviewResponse> {
    const day = createShanghaiDay(now);
    const state: SourceReadState = {
      stale: false,
      staleFetchedAt: [],
      forceRefresh,
      businessDate: day.date,
      errors: [],
    };
    const [
      rack,
      eventSource,
      changeSource,
      maintenanceSource,
      inspectionSource,
    ] = await Promise.all([
      this.loadRackWithDeadline(day, state),
      this.loadWorkWithDeadline('events', 'events', day, state),
      this.loadWorkWithDeadline('changes', 'changes', day, state),
      this.loadWorkWithDeadline('maintenance', 'maintenance', day, state),
      this.loadWorkWithDeadline('inspections', 'inspection', day, state),
    ]);

    const workOverview = mapWorkOverview(
      day,
      eventSource.records,
      changeSource.records,
      inspectionSource.records,
      maintenanceSource.records,
    );
    const sourceStates: TodayOperationsWorkSourceStates = {
      events: eventSource.sourceState,
      changes: changeSource.sourceState,
      inspections: inspectionSource.sourceState,
      maintenance: maintenanceSource.sourceState,
    };
    const response: TodayOperationsOverviewResponse = {
      businessDate: day.date,
      sourceStatus:
        rack.summary === null
          ? 'partial'
          : resolveOverviewSourceStatus(sourceStates, state.stale),
      syncedAt:
        state.stale && state.staleFetchedAt.length > 0
          ? new Date(Math.min(...state.staleFetchedAt)).toISOString()
          : now.toISOString(),
      rackSummary: rack.summary,
      ...(rack.sourceState ? { rackSourceState: rack.sourceState } : {}),
      operations: workOverview.summary,
      details: workOverview.details,
      focusDetails: workOverview.focusDetails,
      sourceStates,
    };
    return response;
  }

  private async loadRackWithDeadline(
    day: ShanghaiDay,
    parent: SourceReadState,
  ) {
    const state: SourceReadState = {
      ...parent,
      stale: false,
      staleFetchedAt: [],
      errors: [],
    };
    try {
      const summary = await withinSourceDeadline(
        (async () => {
          const [loads, monthly, shifts] = await Promise.all([
            this.resolveSource('rackLoad').then((source) =>
              this.loadLatestRackLoads(requireSourceConfig(source), day, state),
            ),
            this.resolveSource('rackMonthly').then((source) =>
              this.loadLatestRackMonthly(
                requireSourceConfig(source),
                day,
                state,
              ),
            ),
            this.resolveSource('rackShift').then((source) =>
              this.loadShiftSnapshots(requireSourceConfig(source), day, state),
            ),
          ]);
          const summary = mapRackSummary(loads, monthly, shifts, day);
          if (
            !this.rackSnapshot ||
            this.rackSnapshot.businessDate <= day.date
          ) {
            this.rackSnapshot = {
              businessDate: day.date,
              summary,
              fetchedAt: state.staleFetchedAt.length
                ? Math.min(...state.staleFetchedAt)
                : Date.now(),
            };
          }
          return summary;
        })(),
      );
      mergeSourceReadState(parent, state);
      return {
        summary,
        sourceState: state.stale
          ? {
              status: 'stale' as const,
              errorCode: safeSourceErrorCode(state.errors[0]),
              errorMessage:
                state.errors.length > 0
                  ? '机柜数据刷新失败，当前显示最近有效数据'
                  : '机柜数据正在刷新，当前显示最近有效数据',
            }
          : undefined,
      };
    } catch (error) {
      this.logger.warn(
        `source=rack errorCode=${safeSourceErrorCode(error) ?? 'unavailable'}`,
      );
      const cached =
        this.rackSnapshot?.businessDate === day.date ? this.rackSnapshot : null;
      if (cached) markStateStale(parent, cached.fetchedAt, error);
      return {
        summary: cached?.summary ?? null,
        sourceState: {
          status: cached ? ('stale' as const) : ('failed' as const),
          errorCode: safeSourceErrorCode(error),
          errorMessage: cached
            ? '机柜数据刷新失败，当前显示本日缓存'
            : '机柜数据暂时无法读取，请稍后重试',
        },
      };
    }
  }

  private async loadWorkWithDeadline(
    kind: TodayOperationsWorkKind,
    key: SourceKey,
    day: ShanghaiDay,
    parent: SourceReadState,
  ): Promise<WorkSourceResult> {
    const state: SourceReadState = {
      ...parent,
      stale: false,
      staleFetchedAt: [],
      errors: [],
    };
    try {
      const result = await withinSourceDeadline(
        this.resolveSource(key).then((source) =>
          this.loadWorkSource(kind, source, undefined, day, state),
        ),
      );
      mergeSourceReadState(parent, state);
      return result;
    } catch (error) {
      this.logger.warn(
        `source=${kind} errorCode=${safeSourceErrorCode(error) ?? 'unavailable'}`,
      );
      return this.loadWorkSourceFallback(
        kind,
        {
          appToken: '',
          tableId: '',
          tableName: SOURCE_DEFINITIONS[key].tableName,
        },
        undefined,
        day,
        parent,
        error,
      );
    }
  }

  private async resolveSource(key: SourceKey): Promise<SourceResolution> {
    const definition = SOURCE_DEFINITIONS[key];
    let fallbackConfig: SourceConfig = {
      appToken: '',
      tableId: '',
      tableName: definition.tableName,
    };
    try {
      const parsed = parseFeishuBitableLink(
        readEnv(definition.envKey) || DEFAULT_SOURCE_URLS[key],
      );
      fallbackConfig = {
        appToken: parsed.appToken,
        tableId: parsed.tableId,
        tableName: definition.tableName,
        viewId: parsed.viewId || undefined,
      };
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken: parsed.appToken,
        wikiToken: parsed.wikiToken,
        tableName: definition.tableName,
      });
      if (!appToken || !parsed.tableId) {
        throw new Error(`${definition.tableName}数据源配置不完整`);
      }
      return {
        config: {
          ...fallbackConfig,
          appToken,
        },
        fallbackConfig,
        error: null,
      };
    } catch (error) {
      return {
        config: null,
        fallbackConfig,
        error,
      };
    }
  }

  private async loadWorkSource(
    kind: TodayOperationsWorkKind,
    source: SourceResolution,
    filter: BitableRecordSearchFilter | undefined,
    day: ShanghaiDay,
    parentState: SourceReadState,
  ): Promise<WorkSourceResult> {
    const cached = this.workSourceSnapshots.get(kind);
    if (
      source.config &&
      !parentState.forceRefresh &&
      cached?.businessDate === day.date &&
      Date.now() - cached.fetchedAt < SOURCE_CACHE_TTL_MS
    ) {
      return {
        records: cached.records,
        sourceState: freshWorkSourceState(),
      };
    }

    if (!source.config) {
      return this.loadWorkSourceFallback(
        kind,
        source.fallbackConfig,
        filter,
        day,
        parentState,
        source.error,
      );
    }

    const sourceState: SourceReadState = {
      stale: false,
      staleFetchedAt: [],
      forceRefresh: parentState.forceRefresh,
      businessDate: day.date,
      errors: [],
    };
    try {
      const records = await this.readSourceRecords({
        config: source.config,
        fieldNames: undefined,
        filter,
        state: sourceState,
        dailyScoped: true,
      });
      const fetchedAt =
        sourceState.stale && sourceState.staleFetchedAt.length > 0
          ? Math.min(...sourceState.staleFetchedAt)
          : Date.now();
      if (
        !this.workSourceSnapshots.has(kind) ||
        this.workSourceSnapshots.get(kind)!.businessDate <= day.date
      )
        this.workSourceSnapshots.set(kind, {
          businessDate: day.date,
          records,
          fetchedAt,
        });
      mergeSourceReadState(parentState, sourceState);
      return {
        records,
        sourceState: sourceState.stale
          ? staleWorkSourceState(kind, sourceState.errors[0])
          : freshWorkSourceState(),
      };
    } catch (error) {
      return this.loadWorkSourceFallback(
        kind,
        source.fallbackConfig,
        filter,
        day,
        parentState,
        error,
      );
    }
  }

  private async loadWorkSourceFallback(
    kind: TodayOperationsWorkKind,
    config: SourceConfig,
    filter: BitableRecordSearchFilter | undefined,
    day: ShanghaiDay,
    parentState: SourceReadState,
    error: unknown,
  ): Promise<WorkSourceResult> {
    const cached = this.workSourceSnapshots.get(kind);
    if (cached?.businessDate === day.date) {
      markStateStale(parentState, cached.fetchedAt, error);
      return {
        records: cached.records,
        sourceState: staleWorkSourceState(kind, error),
      };
    }

    const persisted = await this.readCurrentBusinessSnapshot(
      config,
      undefined,
      filter,
      undefined,
      day.date,
    );
    if (persisted) {
      this.workSourceSnapshots.set(kind, {
        businessDate: day.date,
        records: persisted.records,
        fetchedAt: persisted.fetchedAt,
      });
      markStateStale(parentState, persisted.fetchedAt, error);
      return {
        records: persisted.records,
        sourceState: staleWorkSourceState(kind, error),
      };
    }

    return {
      records: [],
      sourceState: failedWorkSourceState(kind, error),
    };
  }

  private async loadLatestRackLoads(
    config: SourceConfig,
    day: ShanghaiDay,
    state: SourceReadState,
  ): Promise<BitableRecordItem[]> {
    for (let offset = 0; offset < 7; offset += 1) {
      const dateMs = day.startMs - offset * DAY_MS;
      const records = await this.readSourceRecords({
        config,
        fieldNames: RACK_LOAD_FIELDS,
        filter: exactDateFilter('日期', dateMs),
        state,
      });
      if (hasCompleteBuildingSet(records, '楼栋')) {
        return records;
      }
    }
    throw new Error('各楼IT负载率近7日均缺少完整的A至E楼数据');
  }

  private async loadLatestRackMonthly(
    config: SourceConfig,
    day: ShanghaiDay,
    state: SourceReadState,
  ): Promise<BitableRecordItem[]> {
    for (let offset = 0; offset < 3; offset += 1) {
      const period = previousMonth(day.year, day.month, offset);
      const records = await this.readSourceRecords({
        config,
        fieldNames: RACK_MONTHLY_FIELDS,
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '年度',
              operator: 'is',
              value: [period.year],
            },
            {
              field_name: '月度',
              operator: 'is',
              value: [period.month],
            },
          ],
        },
        state,
      });
      if (hasCompleteBuildingSet(records, '楼栋名称')) {
        return records;
      }
    }
    throw new Error('机柜月度汇总近3月均缺少完整的A至E楼数据');
  }

  private async loadShiftSnapshots(
    config: SourceConfig,
    day: ShanghaiDay,
    state: SourceReadState,
  ): Promise<ShiftSnapshot[]> {
    const week = createShanghaiWeek(day);
    const records = await this.readSourceRecords({
      config,
      fieldNames: RACK_SHIFT_FIELDS,
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: '日期',
            operator: 'isGreater',
            value: ['ExactDate', String(week.previousStartMs - DAY_MS)],
          },
          {
            field_name: '日期',
            operator: 'isLess',
            value: ['ExactDate', String(day.startMs + DAY_MS)],
          },
        ],
      },
      state,
      dailyScoped: true,
    });
    const snapshots = buildCompleteShiftSnapshots(records);
    if (snapshots.length === 0) {
      throw new Error('机柜班次变动没有完整的A至E楼数据');
    }
    return snapshots;
  }

  private async readSourceRecords(
    options: SourceRecordsOptions,
  ): Promise<BitableRecordItem[]> {
    const currentPersisted = options.dailyScoped
      ? await this.readCurrentBusinessSnapshot(
          options.config,
          options.fieldNames,
          options.filter,
          options.sort,
          options.state.businessDate,
        )
      : await readLatestPersistedBitableRecordSnapshot({
          tableId: options.config.tableId,
          tableName: options.config.tableName,
          viewId: options.config.viewId,
          fieldNames: options.fieldNames,
          filter: options.filter,
          sort: options.sort,
        });
    const readOptions = {
      appToken: options.config.appToken,
      tableId: options.config.tableId,
      viewId: options.config.viewId,
      fieldNames: options.fieldNames,
      filter: options.filter,
      sort: options.sort,
      tableName: options.config.tableName,
      cacheTtlMs: SOURCE_CACHE_TTL_MS,
      forceRefresh: options.state.forceRefresh || Boolean(options.dailyScoped),
      strict: true,
      allowStale: false,
    } as const;

    if (!options.state.forceRefresh && currentPersisted) {
      if (currentPersisted.expiresAt <= Date.now()) {
        markStateStale(options.state, currentPersisted.fetchedAt);
        void fetchBitableRecords(this.httpService, {
          ...readOptions,
          forceRefresh: true,
        }).catch((error: unknown) => {
          this.logger.warn(
            `tableName=${options.config.tableName} tableId=${options.config.tableId} errorCode=${safeSourceErrorCode(error) ?? 'unknown'}`,
          );
        });
      }
      return currentPersisted.records;
    }

    try {
      return await fetchBitableRecords(this.httpService, readOptions);
    } catch (error) {
      options.state.errors.push(error);
      const persisted =
        currentPersisted ||
        (!options.dailyScoped
          ? await readLatestPersistedBitableRecordSnapshot({
              tableId: readOptions.tableId,
              tableName: readOptions.tableName,
              viewId: readOptions.viewId,
              fieldNames: readOptions.fieldNames,
              filter: readOptions.filter,
              sort: readOptions.sort,
            })
          : null);
      if (!persisted) {
        throw error;
      }
      markStateStale(options.state, persisted.fetchedAt, error);
      return persisted.records;
    }
  }

  private async readCurrentBusinessSnapshot(
    config: SourceConfig,
    fieldNames: readonly string[] | undefined,
    filter: BitableRecordSearchFilter | undefined,
    sort: readonly BitableRecordSearchSort[] | undefined,
    businessDate: string,
  ): Promise<{
    records: BitableRecordItem[];
    fetchedAt: number;
    expiresAt: number;
  } | null> {
    if (!config.tableId) {
      return null;
    }
    try {
      const persisted = await readLatestPersistedBitableRecordSnapshot({
        tableId: config.tableId,
        tableName: config.tableName,
        viewId: config.viewId,
        fieldNames,
        filter,
        sort,
      });
      return persisted &&
        formatShanghaiDate(persisted.fetchedAt) === businessDate
        ? persisted
        : null;
    } catch {
      return null;
    }
  }
}

async function withinSourceDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Overview source deadline exceeded'), {
                code: 'SOURCE_TIMEOUT',
              }),
            ),
          SOURCE_READ_BUDGET_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireSourceConfig(source: SourceResolution): SourceConfig {
  if (source.config) {
    return source.config;
  }
  throw source.error instanceof Error
    ? source.error
    : new Error('今日全景核心数据源配置不完整');
}

function freshWorkSourceState(): TodayOperationsWorkSourceState {
  return {
    status: 'fresh',
    errorCode: null,
    errorMessage: null,
  };
}

function staleWorkSourceState(
  kind: TodayOperationsWorkKind,
  error: unknown,
): TodayOperationsWorkSourceState {
  return {
    status: 'stale',
    errorCode: safeSourceErrorCode(error),
    errorMessage: error
      ? `${WORK_SOURCE_LABELS[kind]}数据源刷新失败，已展示本日缓存`
      : `${WORK_SOURCE_LABELS[kind]}数据源已展示本日缓存`,
  };
}

function failedWorkSourceState(
  kind: TodayOperationsWorkKind,
  error: unknown,
): TodayOperationsWorkSourceState {
  return {
    status: 'failed',
    errorCode: safeSourceErrorCode(error),
    errorMessage: `${WORK_SOURCE_LABELS[kind]}数据源暂时不可用`,
  };
}

function resolveOverviewSourceStatus(
  sourceStates: TodayOperationsWorkSourceStates,
  coreSourceStale: boolean,
): TodayOperationsOverviewResponse['sourceStatus'] {
  const statuses = Object.values(sourceStates).map(
    (sourceState) => sourceState.status,
  );
  if (statuses.includes('failed')) {
    return 'partial';
  }
  if (coreSourceStale || statuses.includes('stale')) {
    return 'stale';
  }
  return 'fresh';
}

function safeSourceErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const typedError = error as {
    code?: unknown;
    feishuCode?: unknown;
    response?: { data?: { code?: unknown } };
  };
  const code =
    typedError.response?.data?.code ?? typedError.feishuCode ?? typedError.code;
  return typeof code === 'string' || typeof code === 'number'
    ? String(code)
    : null;
}

function markStateStale(
  state: SourceReadState,
  fetchedAt: number,
  error?: unknown,
): void {
  state.stale = true;
  state.staleFetchedAt.push(fetchedAt);
  if (error && !state.errors.includes(error)) {
    state.errors.push(error);
  }
}

function mergeSourceReadState(
  target: SourceReadState,
  source: SourceReadState,
): void {
  if (source.stale) {
    target.stale = true;
  }
  target.staleFetchedAt.push(...source.staleFetchedAt);
  target.errors.push(...source.errors);
}

function mapRackSummary(
  rackLoads: BitableRecordItem[],
  rackMonthly: BitableRecordItem[],
  shiftSnapshots: ShiftSnapshot[],
  day: ShanghaiDay,
): TodayOperationsRackSummary {
  const monthlyByBuilding = uniqueBuildingRecords(rackMonthly, '楼栋名称');
  const loadByBuilding = uniqueBuildingRecords(rackLoads, '楼栋');
  const buildingUsages = REQUIRED_BUILDINGS.map((building) => {
    const record = monthlyByBuilding.get(building);
    const total = extractNumberValue(record?.fields?.['机柜设计数量']);
    if (total === null || total <= 0) {
      throw new Error(`${building}机柜设计数量必须是大于0的有效数值`);
    }
    const online = extractNumberValue(record?.fields?.['实际上电数量']);
    if (online === null || online < 0) {
      throw new Error(`${building}实际上电数量必须是非负有效数值`);
    }
    return {
      building,
      online,
      total,
      usageRate: round((online / total) * 100, 1),
    };
  });
  const rackTotals = buildingUsages.reduce(
    (summary, buildingUsage) => ({
      online: summary.online + buildingUsage.online,
      total: summary.total + buildingUsage.total,
    }),
    { online: 0, total: 0 },
  );
  const online = round(rackTotals.online, 6);
  const total = round(rackTotals.total, 6);
  const usageRate = round((online / total) * 100, 1);

  const buildingLoads = REQUIRED_BUILDINGS.map((building) => {
    const record = loadByBuilding.get(building);
    const raw = extractNumberValue(record?.fields?.['IT负载率']);
    if (raw === null) {
      throw new Error(`${building}缺少IT负载率`);
    }
    const percent = Math.abs(raw) <= 1 ? raw * 100 : raw;
    return {
      building,
      value: round(percent, 1),
    };
  }) as TodayOperationsRackBuildingLoad[];

  const week = createShanghaiWeek(day);
  const currentWeekShifts = shiftSnapshots.filter((snapshot) =>
    isDateInRange(snapshot.date, week.currentStartMs, week.nextStartMs),
  );
  const previousWeekShifts = shiftSnapshots.filter((snapshot) =>
    isDateInRange(snapshot.date, week.previousStartMs, week.currentStartMs),
  );
  const poweredOnThisWeek = sumShiftValues(currentWeekShifts, 'poweredOn');
  const poweredOffThisWeek = sumShiftValues(currentWeekShifts, 'poweredOff');
  const poweredOnPreviousWeek = sumShiftValues(previousWeekShifts, 'poweredOn');
  const poweredOffPreviousWeek = sumShiftValues(
    previousWeekShifts,
    'poweredOff',
  );
  const loadDate = extractDateValue(
    loadByBuilding.get(REQUIRED_BUILDINGS[0])?.fields?.['日期'],
  );
  const capacityDate = extractFlexibleDateValue(
    monthlyByBuilding.get(REQUIRED_BUILDINGS[0])?.fields?.['当月最后日期'],
  );

  return {
    usageRate,
    online,
    total,
    buildingUsages,
    poweredOnThisWeek,
    poweredOffThisWeek,
    poweredOnWeekDelta:
      previousWeekShifts.length > 0
        ? poweredOnThisWeek - poweredOnPreviousWeek
        : null,
    poweredOffWeekDelta:
      previousWeekShifts.length > 0
        ? poweredOffThisWeek - poweredOffPreviousWeek
        : null,
    weekStartDate: formatShanghaiDate(week.currentStartMs),
    capacityDate,
    loadDate,
    buildingLoads,
  };
}

function mapWorkOverview(
  day: ShanghaiDay,
  rawEvents: BitableRecordItem[],
  rawChanges: BitableRecordItem[],
  rawInspections: BitableRecordItem[],
  rawMaintenance: BitableRecordItem[],
): {
  summary: TodayOperationsWorkSummary;
  details: TodayOperationsWorkDetails;
  focusDetails: TodayOperationsFocusDetails;
} {
  const events = uniqueRecords(rawEvents).filter(
    (record) => !isTruthyField(record.fields?.['不计入事件']),
  );
  const todayEvents = events.filter((record) =>
    isTimestampInDay(record.fields?.['事件发生时间'], day),
  );
  const openEvents = events.filter((record) =>
    ['响应跟进', '应急恢复'].includes(
      extractDisplayText(record.fields?.['最终状态']),
    ),
  );
  const todayEventIds = new Set(todayEvents.map(getRecordId));
  const openEventIds = new Set(openEvents.map(getRecordId));
  const pendingTodayEvents = [...todayEventIds].filter((id) =>
    openEventIds.has(id),
  ).length;

  const changes = uniqueRecords(rawChanges);
  const scheduledTodayChanges = changes.filter((record) =>
    isChangeScheduledForDay(record, day),
  );
  const scheduledTodayChangeIds = new Set(
    scheduledTodayChanges.map(getRecordId),
  );
  const activeChanges = changes.filter((record) =>
    isActiveChangeForDay(record, day),
  );
  const todayChangeIds = new Set([
    ...scheduledTodayChangeIds,
    ...activeChanges.map(getRecordId),
  ]);
  const todayChanges = changes.filter((record) =>
    todayChangeIds.has(getRecordId(record)),
  );

  const inspections = uniqueRecords(rawInspections);
  const maintenance = uniqueRecords(rawMaintenance);
  const eventDetails = sortWorkItems(todayEvents.map(mapEventDetail));
  const changeDetails = sortWorkItems(todayChanges.map(mapChangeDetail));
  const pendingEventDetails = sortWorkItems(openEvents.map(mapEventDetail));
  const activeChangeDetails = sortWorkItems(activeChanges.map(mapChangeDetail));
  const inspectionDetails = inspections.map((record, index) =>
    mapInspectionDetail(record, index),
  );
  const maintenanceDetails = maintenance.map((record, index) =>
    mapMaintenanceDetail(record, index),
  );

  return {
    summary: {
      todayEvents: todayEvents.length,
      pendingEvents: openEvents.length,
      priorPendingEvents: openEvents.filter(
        (record) => !todayEventIds.has(getRecordId(record)),
      ).length,
      closedTodayEvents: Math.max(0, todayEvents.length - pendingTodayEvents),
      keyEvents: eventDetails.filter((item) => item.isKey).length,
      todayChanges: todayChanges.length,
      activeChanges: activeChanges.length,
      priorActiveChanges: activeChanges.filter(
        (record) => !scheduledTodayChangeIds.has(getRecordId(record)),
      ).length,
      keyChanges: changeDetails.filter((item) => item.isKey).length,
      todayInspections: inspections.length,
      activeInspections: inspections.filter(
        (record) =>
          extractActualEndTime(
            record.fields ?? {},
            INSPECTION_ACTUAL_END_FIELDS,
          ) === null,
      ).length,
      todayMaintenance: maintenance.length,
      activeMaintenance: maintenance.filter(
        (record) =>
          extractDisplayText(record.fields?.['实际状态']) === '进行中',
      ).length,
    },
    details: {
      events: eventDetails,
      changes: changeDetails,
      inspections: inspectionDetails,
      maintenance: maintenanceDetails,
    },
    focusDetails: {
      pendingEvents: pendingEventDetails,
      activeChanges: activeChangeDetails,
    },
  };
}

function mapEventDetail(record: BitableRecordItem): TodayOperationsWorkItem {
  const fields = record.fields ?? {};
  const code = textOrNull(fields['事件编号']);
  const level = textOrNull(fields['事件等级']);
  return {
    id: getRecordId(record),
    code,
    title:
      workLabelOrNull(fields['事件简述']) ||
      code ||
      `事件记录 ${shortRecordId(record)}`,
    summary: textOrNull(fields['事件目前进展']),
    method: null,
    durationDays: null,
    level,
    riskLevel: null,
    status: textOrNull(fields['最终状态']),
    owner: textOrNull(fields['事件负责人']),
    startTime: extractDateTimeIso(fields['事件发生时间']),
    endTime: null,
    building: dimensionTextOrNull(fields['机楼']),
    specialty: dimensionTextOrNull(fields['专业']),
    isKey: isI1OrI2(level),
  };
}

function isActiveChangeForDay(
  record: BitableRecordItem,
  day: ShanghaiDay,
): boolean {
  const fields = record.fields ?? {};
  if (extractActualEndTime(fields, CHANGE_ACTUAL_END_FIELDS)) {
    return false;
  }
  const startAt = dateTimeMs(fields['变更开始时间']);
  if (startAt === null || startAt >= day.startMs + DAY_MS) {
    return false;
  }
  if (startAt >= day.startMs) {
    return true;
  }
  const plannedEndAt = dateTimeMs(pickField(fields, CHANGE_PLANNED_END_FIELDS));
  return plannedEndAt === null || plannedEndAt >= day.startMs;
}

function isChangeScheduledForDay(
  record: BitableRecordItem,
  day: ShanghaiDay,
): boolean {
  return (
    isTruthyField(record.fields?.['今日是否进行']) ||
    isTimestampInDay(record.fields?.['变更开始时间'], day)
  );
}

function mapChangeDetail(record: BitableRecordItem): TodayOperationsWorkItem {
  const fields = record.fields ?? {};
  const code = textOrNull(fields['变更编码']);
  const level = textOrNull(fields['智航-变更等级']);
  const riskLevel = textOrNull(fields['阿里-变更等级']);
  const actualEndTime = extractActualEndTime(fields, CHANGE_ACTUAL_END_FIELDS);
  return {
    id: getRecordId(record),
    code,
    title:
      workLabelOrNull(fields['变更简述']) ||
      code ||
      `变更记录 ${shortRecordId(record)}`,
    summary: textOrNull(fields['变更概述']) || textOrNull(fields['影响']),
    method: null,
    durationDays: null,
    level,
    riskLevel,
    status: actualEndTime ? '已结束' : '进行中',
    owner: textOrNull(fields['示例人员001']),
    startTime: extractDateTimeIso(fields['变更开始时间']),
    endTime:
      actualEndTime ||
      extractDateTimeIso(pickField(fields, CHANGE_PLANNED_END_FIELDS)),
    building: dimensionTextOrNull(fields['楼栋']),
    specialty: dimensionTextOrNull(fields['专业']),
    isKey: isI1OrI2(level) || isMediumOrHigherRisk(riskLevel),
  };
}

function mapInspectionDetail(
  record: BitableRecordItem,
  index: number,
): TodayOperationsWorkItem {
  const fields = record.fields ?? {};
  const startTime = extractDateTimeIso(
    pickField(fields, INSPECTION_START_FIELDS),
  );
  const endTime = extractDateTimeIso(pickField(fields, INSPECTION_END_FIELDS));
  const actualEndTime = extractActualEndTime(
    fields,
    INSPECTION_ACTUAL_END_FIELDS,
  );
  return {
    id: getRecordId(record),
    code: textFromAliases(fields, ['检修编号', '编号']),
    title:
      workLabelFromAliases(fields, INSPECTION_TITLE_FIELDS) ||
      `检修记录 ${index + 1}`,
    summary: textFromAliases(fields, [
      '检修内容',
      '维修内容',
      '工作内容',
      '备注',
    ]),
    method: textFromAliases(fields, INSPECTION_METHOD_FIELDS),
    durationDays: calendarDaySpanInclusive(startTime, endTime),
    level: null,
    riskLevel: null,
    status: actualEndTime ? '已结束' : '进行中',
    owner: textFromAliases(fields, ['检修负责人', '负责人']),
    startTime,
    endTime,
    building: dimensionTextFromAliases(fields, BUILDING_FIELDS),
    specialty: dimensionTextFromAliases(fields, SPECIALTY_FIELDS),
    isKey: false,
  };
}

function mapMaintenanceDetail(
  record: BitableRecordItem,
  index: number,
): TodayOperationsWorkItem {
  const fields = record.fields ?? {};
  return {
    id: getRecordId(record),
    code: textFromAliases(fields, ['维保编号', '项目编号', '编号']),
    title:
      workLabelFromAliases(fields, MAINTENANCE_TITLE_FIELDS) ||
      `维保记录 ${index + 1}`,
    summary: textFromAliases(fields, ['维保内容', '工作内容', '备注']),
    method: null,
    durationDays: null,
    level: null,
    riskLevel: null,
    status: textFromAliases(fields, ['实际状态', '维保状态']),
    owner: textFromAliases(fields, ['维保负责人', '负责人']),
    startTime: null,
    endTime: null,
    building: dimensionTextFromAliases(fields, BUILDING_FIELDS),
    specialty: dimensionTextFromAliases(fields, SPECIALTY_FIELDS),
    isKey: false,
  };
}

function sortWorkItems(
  items: TodayOperationsWorkItem[],
): TodayOperationsWorkItem[] {
  return [...items].sort(
    (left, right) => Number(right.isKey) - Number(left.isKey),
  );
}

function textOrNull(field: unknown): string | null {
  return extractDisplayText(field).trim() || null;
}

function textFromAliases(
  fields: Record<string, unknown>,
  aliases: string[],
): string | null {
  return textOrNull(pickField(fields, aliases));
}

function extractActualEndTime(
  fields: Record<string, unknown>,
  aliases: string[],
): string | null {
  return extractDateTimeIso(pickField(fields, aliases));
}

function dimensionTextOrNull(field: unknown): string | null {
  const value = textOrNull(field);
  if (!value) {
    return null;
  }
  const cleaned = value
    .replace(/\s+/gu, ' ')
    .replace(/(?:\s*[-—]\s*)+$/gu, '')
    .trim();
  return cleaned || null;
}

function workLabelOrNull(field: unknown): string | null {
  return dimensionTextOrNull(field);
}

function workLabelFromAliases(
  fields: Record<string, unknown>,
  aliases: string[],
): string | null {
  return workLabelOrNull(pickField(fields, aliases));
}

function dimensionTextFromAliases(
  fields: Record<string, unknown>,
  aliases: string[],
): string | null {
  return dimensionTextOrNull(pickField(fields, aliases));
}

function calendarDaySpanInclusive(
  startTime: string | null,
  endTime: string | null,
): number | null {
  if (!startTime || !endTime) {
    return null;
  }
  const startAt = Date.parse(startTime);
  const endAt = Date.parse(endTime);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) {
    return null;
  }
  const startDay = Math.floor((startAt + SHANGHAI_OFFSET_MS) / DAY_MS);
  const endDay = Math.floor((endAt + SHANGHAI_OFFSET_MS) / DAY_MS);
  return endDay - startDay + 1;
}

function shortRecordId(record: BitableRecordItem): string {
  const id = getRecordId(record);
  return id ? id.slice(-8) : '未编号';
}

function isI1OrI2(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toUpperCase().replace(/\s+/gu, '');
  return /I[12](?!\d)/u.test(normalized) || /[ⅠⅡ]/u.test(normalized);
}

function isMediumOrHigherRisk(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.replace(/\s+/gu, '').toLowerCase();
  return (
    [
      '中',
      '中风险',
      '中等',
      '中等风险',
      '较高',
      '较高风险',
      '高',
      '高风险',
      '重大',
      '重大风险',
      'medium',
      'high',
      'critical',
    ].includes(normalized) ||
    normalized.includes('较高') ||
    normalized.includes('高风险') ||
    normalized.includes('重大') ||
    normalized.includes('medium') ||
    normalized.includes('critical')
  );
}

function isTimestampInDay(field: unknown, day: ShanghaiDay): boolean {
  const timestamp = dateTimeMs(field);
  return (
    timestamp !== null &&
    timestamp >= day.startMs &&
    timestamp < day.startMs + DAY_MS
  );
}

function createShanghaiWeek(day: ShanghaiDay): {
  currentStartMs: number;
  previousStartMs: number;
  nextStartMs: number;
} {
  const weekday = new Date(day.startMs + SHANGHAI_OFFSET_MS).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const currentStartMs = day.startMs - daysSinceMonday * DAY_MS;
  return {
    currentStartMs,
    previousStartMs: currentStartMs - 7 * DAY_MS,
    nextStartMs: currentStartMs + 7 * DAY_MS,
  };
}

function isDateInRange(
  date: string | null,
  startMs: number,
  endMs: number,
): boolean {
  if (!date) return false;
  const timestamp = Date.parse(`${date}T00:00:00+08:00`);
  return (
    Number.isFinite(timestamp) && timestamp >= startMs && timestamp < endMs
  );
}

function sumShiftValues(
  snapshots: ShiftSnapshot[],
  field: 'poweredOn' | 'poweredOff',
): number {
  return round(
    snapshots.reduce((total, snapshot) => total + snapshot[field], 0),
    6,
  );
}

function exactDateFilter(
  fieldName: string,
  dateMs: number,
): BitableRecordSearchFilter {
  return {
    conjunction: 'and',
    conditions: [
      {
        field_name: fieldName,
        operator: 'is',
        value: ['ExactDate', String(dateMs)],
      },
    ],
  };
}

function createShanghaiDay(now: Date): ShanghaiDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const year = values.year;
  const month = values.month;
  const day = values.day;
  const startMs =
    Date.UTC(Number(year), Number(month) - 1, Number(day)) - SHANGHAI_OFFSET_MS;
  return {
    date: `${year}-${month}-${day}`,
    startMs,
    year,
    month,
  };
}

function formatShanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

function previousMonth(
  year: string,
  month: string,
  offset: number,
): { year: string; month: string } {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1 - offset, 1));
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
  };
}

function hasCompleteBuildingSet(
  records: BitableRecordItem[],
  fieldName: string,
): boolean {
  return REQUIRED_BUILDINGS.every((building) =>
    records.some(
      (record) =>
        normalizeBuilding(extractDisplayText(record.fields?.[fieldName])) ===
        building,
    ),
  );
}

function uniqueBuildingRecords(
  records: BitableRecordItem[],
  fieldName: string,
): Map<(typeof REQUIRED_BUILDINGS)[number], BitableRecordItem> {
  const result = new Map<
    (typeof REQUIRED_BUILDINGS)[number],
    BitableRecordItem
  >();
  for (const record of records) {
    const building = normalizeBuilding(
      extractDisplayText(record.fields?.[fieldName]),
    );
    if (!building) {
      continue;
    }
    const existing = result.get(building);
    if (
      !existing ||
      Number(record.last_modified_time ?? 0) >
        Number(existing.last_modified_time ?? 0)
    ) {
      result.set(building, record);
    }
  }
  if (result.size !== REQUIRED_BUILDINGS.length) {
    throw new Error('源数据缺少完整的A至E楼记录');
  }
  return result;
}

function buildCompleteShiftSnapshots(
  records: BitableRecordItem[],
): ShiftSnapshot[] {
  const groups = new Map<string, BitableRecordItem[]>();
  for (const record of records) {
    const date = extractDateValue(record.fields?.['日期']) || '';
    const shift = extractDisplayText(record.fields?.['班次']);
    if (!date || !shift) continue;
    const key = `${date}\u001f${shift}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const snapshots: ShiftSnapshot[] = [];
  for (const group of groups.values()) {
    if (!hasCompleteBuildingSet(group, '楼栋')) continue;
    const recordsByBuilding = uniqueBuildingRecords(group, '楼栋');
    const values = [...recordsByBuilding.values()];
    const poweredOn = sumRecordsIfComplete(values, '本班组上电机柜数（个）');
    const poweredOff = sumRecordsIfComplete(values, '本班组下电机柜数（个）');
    if (poweredOn === null || poweredOff === null) continue;
    snapshots.push({
      date: extractDateValue(values[0]?.fields?.['日期']),
      name: extractDisplayText(values[0]?.fields?.['班次']),
      modifiedAt: Math.max(
        ...values.map(
          (record) =>
            dateTimeMs(record.fields?.['修改时间']) ??
            record.last_modified_time ??
            0,
        ),
      ),
      poweredOn,
      poweredOff,
    });
  }
  return snapshots.sort(compareShiftSnapshots);
}

function compareShiftSnapshots(
  left: ShiftSnapshot,
  right: ShiftSnapshot,
): number {
  const dateOrder = (right.date ?? '').localeCompare(left.date ?? '');
  if (dateOrder !== 0) {
    return dateOrder;
  }
  const shiftOrder = shiftRank(right.name) - shiftRank(left.name);
  return shiftOrder !== 0 ? shiftOrder : right.modifiedAt - left.modifiedAt;
}

function shiftRank(value: string): number {
  if (value.includes('夜')) return 2;
  if (value.includes('白')) return 1;
  return 0;
}

function normalizeBuilding(
  value: string,
): (typeof REQUIRED_BUILDINGS)[number] | null {
  const match = value.toUpperCase().match(/[ABCDE]/);
  return match
    ? (`${match[0]}楼` as (typeof REQUIRED_BUILDINGS)[number])
    : null;
}

function sumRecordsIfComplete(
  records: Iterable<BitableRecordItem>,
  fieldName: string,
): number | null {
  let total = 0;
  for (const record of records) {
    const value = extractNumberValue(record.fields?.[fieldName]);
    if (value === null) {
      return null;
    }
    total += value;
  }
  return round(total, 6);
}

function uniqueRecords(records: BitableRecordItem[]): BitableRecordItem[] {
  const result = new Map<string, BitableRecordItem>();
  records.forEach((record, index) => {
    const key = getRecordId(record) || `anonymous-${index}`;
    if (!result.has(key)) result.set(key, record);
  });
  return [...result.values()];
}

function dateTimeMs(field: unknown): number | null {
  const iso = extractDateTimeIso(field);
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

function extractFlexibleDateValue(field: unknown): string | null {
  const numeric = extractNumberValue(field);
  if (numeric !== null && numeric >= 20_000 && numeric <= 100_000) {
    const date = new Date((numeric - 25_569) * DAY_MS);
    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 10);
  }
  return extractDateValue(field);
}

function isTruthyField(field: unknown): boolean {
  if (field === true || field === 1) return true;
  const value = extractDisplayText(field).trim().toLowerCase();
  return ['true', '1', '是', '√'].includes(value);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
