import { HttpService } from '@nestjs/axios';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  MonthlyOperationsResourcesResponse,
  MonthlySourceState,
} from '../../../shared/monthly-operations-resources.interface';
import {
  readEnv,
  parseFeishuBitableLink,
} from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
  readLatestPersistedBitableRecordSnapshot,
  type BitableRecordItem,
  type BitableRecordSearchFilter,
  type FetchBitableRecordsOptions,
} from '../../common/feishu/bitable-direct-read';
import {
  addDays,
  mapMonthlyEnergy,
  mapMonthlyRacks,
  mapMonthlyRackHistory,
  mapMonthlyRackMovements,
  mapMonthlyLoad,
  mapMonthlyTemperature,
  mapMonthlyWater,
  resourceRange,
  shanghaiDay,
} from './monthly-operations-resources.model';

const CACHE_MS = 5 * 60 * 1000;
export const MONTHLY_RESOURCE_SOURCES = {
  load: {
    tableId: 'tblBgaPzuVj7V9Q6',
    tableName: '月览IT负载率',
    fieldNames: ['日期', '楼栋', '园区IT负载率', 'IT负载率'],
  },
  racks: {
    tableId: 'tblDYQYihJ0CgepE',
    tableName: '月览机柜容量',
    fieldNames: [
      '楼栋名称',
      '年度',
      '月度',
      '当月最后日期',
      '机柜设计数量',
      '实际上电数量',
      '上电率',
    ],
  },
  energy: {
    tableId: 'tblqSskJvBnx9UJj',
    tableName: '月览电耗与PUE',
    fieldNames: [
      '日期',
      '楼栋',
      '汇总分类',
      'PUE（数值）',
      '数值（3位小数点）',
      '数值（3位小数点）-可编辑',
      '非IT用电量（万）',
      '非IT用电量（万）-可编辑',
    ],
  },
  weather: {
    tableId: 'tblz8rjxdtRRlYmS',
    viewId: 'vewX77mW48',
    tableName: '月览湿球温度',
    fieldNames: [
      '日期',
      '楼栋',
      '班次',
      '室外湿球温度（℃）',
      '本班组上电机柜数（个）',
      '本班组下电机柜数（个）',
    ],
  },
  water: {
    tableId: 'tblz4TkZqrUJB90y',
    tableName: '月览水耗',
    fieldNames: [
      '执行日期',
      '楼栋',
      '类型',
      '频次',
      '当日耗水总量',
      '东区耗水量',
      '西区耗水量',
      'WUE',
      '当日用电量',
    ],
  },
} as const;
export function monthlyDateFilter(
  field: string,
  start: string,
  end: string,
): BitableRecordSearchFilter {
  return {
    conjunction: 'and',
    conditions: [
      {
        field_name: field,
        operator: 'isGreater',
        value: [
          'ExactDate',
          String(Date.parse(`${addDays(start, -1)}T00:00:00+08:00`)),
        ],
      },
      {
        field_name: field,
        operator: 'isLess',
        value: [
          'ExactDate',
          String(Date.parse(`${addDays(end, 1)}T00:00:00+08:00`)),
        ],
      },
    ],
  };
}
function auth() {
  for (const prefix of [
    'TODAY_OPERATIONS_KPI_FEISHU',
    'FEISHU_RISK_INSPECTION',
    'ALI_MONTHLY_REPORT_FEISHU',
  ]) {
    const appId = readEnv(`${prefix}_APP_ID`),
      appSecret = readEnv(`${prefix}_APP_SECRET`);
    if (appId && appSecret) return { appId, appSecret };
  }
  return undefined;
}
interface ReadResult {
  records: BitableRecordItem[];
  state: MonthlySourceState;
}
const STANDARD_READ_TIMEOUT_MS = 35000;
const LONG_RANGE_READ_TIMEOUT_MS = 60000;
const LIVE_YEAR_FALLBACK_DAYS = 7;
const MAX_RESPONSE_CACHE_ENTRIES = 6;
function resourceReadTimeoutMs(start: string, asOf: string) {
  const days =
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86400000 +
    1;
  return days > 62 ? LONG_RANGE_READ_TIMEOUT_MS : STANDARD_READ_TIMEOUT_MS;
}
@Injectable()
export class MonthlyOperationsResourcesService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MonthlyOperationsResourcesService.name);
  private readonly responseCache = new Map<
    string,
    { expiresAt: number; value: MonthlyOperationsResourcesResponse }
  >();
  private readonly responsePending = new Map<
    string,
    Promise<MonthlyOperationsResourcesResponse>
  >();
  private warmupTimer?: ReturnType<typeof setTimeout>;
  constructor(@Inject(HttpService) private readonly http: HttpService) {}
  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      /^(?:1|true|on|yes)$/i.test(
        process.env.NANTONG_HOTFIX_SMOKE_MODE?.trim() || '',
      ) ||
      process.env.MONTHLY_OPERATIONS_RESOURCE_WARMUP_ENABLED?.trim().toLowerCase() ===
        'false'
    )
      return;
    this.warmupTimer = setTimeout(() => {
      const today = shanghaiDay();
      void this.getResources(
        `${today.slice(0, 4)}-01-01`,
        `${today.slice(0, 4)}-12-31`,
      ).catch(() => this.logger.warn('年度资源数据预热失败'));
    }, 1000);
    this.warmupTimer.unref?.();
  }
  onModuleDestroy(): void {
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
  }
  async getResources(
    start: unknown,
    end: unknown,
    refresh = false,
  ): Promise<MonthlyOperationsResourcesResponse> {
    const range = resourceRange(start, end);
    const cacheKey = `${range.start}:${range.end}:${range.asOf}`;
    if (!refresh) {
      const cached = this.responseCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
    }
    const pendingKey = `${cacheKey}:${refresh ? 'refresh' : 'read'}`;
    const pending = this.responsePending.get(pendingKey);
    if (pending) return pending;
    const request = this.readResources(range, refresh)
      .then((value) => {
        const now = Date.now();
        for (const [key, cached] of this.responseCache)
          if (cached.expiresAt <= now) this.responseCache.delete(key);
        this.responseCache.delete(cacheKey);
        while (this.responseCache.size >= MAX_RESPONSE_CACHE_ENTRIES) {
          const oldestKey = this.responseCache.keys().next().value;
          if (oldestKey === undefined) break;
          this.responseCache.delete(oldestKey);
        }
        this.responseCache.set(cacheKey, {
          expiresAt: now + CACHE_MS,
          value,
        });
        return value;
      })
      .finally(() => this.responsePending.delete(pendingKey));
    this.responsePending.set(pendingKey, request);
    return request;
  }
  private async readResources(
    range: ReturnType<typeof resourceRange>,
    refresh: boolean,
  ): Promise<MonthlyOperationsResourcesResponse> {
    const readStart =
      range.start < range.trendStart ? range.start : range.trendStart;
    const readTimeoutMs = resourceReadTimeoutMs(readStart, range.asOf);
    const useLiveYearFallback =
      range.asOf === shanghaiDay() &&
      (Date.parse(`${range.asOf}T00:00:00Z`) -
        Date.parse(`${readStart}T00:00:00Z`)) /
        86400000 >=
        62;
    const fallbackFilters = (field: string) =>
      useLiveYearFallback
        ? Array.from({ length: LIVE_YEAR_FALLBACK_DAYS }, (_, index) =>
            monthlyDateFilter(
              field,
              readStart,
              addDays(range.asOf, -(index + 1)),
            ),
          )
        : [];
    const [racks, energy, weather, water, load] = await Promise.all([
      this.read('racks', undefined, refresh, readTimeoutMs),
      this.read(
        'energy',
        monthlyDateFilter('日期', readStart, range.asOf),
        refresh,
        readTimeoutMs,
        fallbackFilters('日期'),
      ),
      this.read(
        'weather',
        monthlyDateFilter('日期', readStart, range.asOf),
        refresh,
        readTimeoutMs,
        fallbackFilters('日期'),
      ),
      this.read(
        'water',
        monthlyDateFilter('执行日期', readStart, range.asOf),
        refresh,
        readTimeoutMs,
        fallbackFilters('执行日期'),
      ),
      this.read(
        'load',
        monthlyDateFilter('日期', addDays(range.asOf, -30), range.asOf),
        refresh,
        readTimeoutMs,
      ),
    ]);
    const mappedRacks = mapMonthlyRacks(racks.records, range.asOf);
    const days = mapMonthlyEnergy(energy.records, readStart, range.asOf);
    const temperatures = mapMonthlyTemperature(
      weather.records,
      readStart,
      range.asOf,
    );
    const waterDays = mapMonthlyWater(water.records, readStart, range.asOf);
    const mappedLoad = mapMonthlyLoad(load.records, range.asOf);
    return {
      range,
      load: {
        ...load.state,
        ...mappedLoad,
        status:
          load.state.status === 'ready' && !mappedLoad.rows.length
            ? 'empty'
            : load.state.status,
      },
      racks: {
        history: mapMonthlyRackHistory(racks.records, range.asOf),
        ...racks.state,
        ...mappedRacks,
        status:
          racks.state.status === 'ready' && !mappedRacks.rows.length
            ? 'empty'
            : racks.state.status,
        ...(mappedRacks.rows.length > 0 && mappedRacks.rows.length < 5
          ? { message: '部分楼栋数据缺失，园区上架率暂不计算' }
          : {}),
      },
      rackMovements: {
        ...weather.state,
        rows: mapMonthlyRackMovements(weather.records, range.start, range.asOf),
      },
      energy: {
        ...energy.state,
        days,
        status:
          energy.state.status === 'ready' &&
          !days.some((day) => day.pue !== null || day.total !== null)
            ? 'empty'
            : energy.state.status,
      },
      weather: {
        ...weather.state,
        days: temperatures,
        status:
          weather.state.status === 'ready' &&
          !temperatures.some((day) => day.value !== null)
            ? 'empty'
            : weather.state.status,
      },
      water: {
        ...water.state,
        days: waterDays,
        status:
          water.state.status === 'ready' &&
          !waterDays.some((day) => day.water !== null || day.wue !== null)
            ? 'empty'
            : water.state.status,
      },
    };
  }
  private async read(
    key: keyof typeof MONTHLY_RESOURCE_SOURCES,
    filter: BitableRecordSearchFilter | undefined,
    refresh: boolean,
    timeoutMs: number,
    fallbackFilters: readonly BitableRecordSearchFilter[] = [],
  ): Promise<ReadResult> {
    const source = MONTHLY_RESOURCE_SOURCES[key];
    const options: FetchBitableRecordsOptions = {
      ...source,
      appToken: 'ASLxbfESPahdTKs0A9NccgbrnXc',
      filter,
      auth: auth(),
      cacheTtlMs: CACHE_MS,
      strict: true,
      allowStale: !refresh,
      forceRefresh: refresh,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sourceResolved = !(
      key === 'load' && readEnv('TODAY_OPERATIONS_KPI_IT_LOAD_URL')
    );
    const fetch = async () => {
      if (!sourceResolved) {
        const parsed = parseFeishuBitableLink(
          readEnv('TODAY_OPERATIONS_KPI_IT_LOAD_URL'),
        );
        if (!parsed.tableId) throw new Error('IT 负载数据源配置不完整');
        options.appToken = await resolveBitableAppToken(this.http, {
          appToken: parsed.appToken,
          wikiToken: parsed.wikiToken,
          tableName: source.tableName,
          auth: options.auth,
        });
        options.tableId = parsed.tableId;
        options.viewId = parsed.viewId || undefined;
        sourceResolved = true;
      }
      return fetchBitableRecords(this.http, options);
    };
    if (!refresh && sourceResolved && fallbackFilters.length) {
      const candidateFilters = filter
        ? [filter, ...fallbackFilters]
        : fallbackFilters;
      for (const [index, candidateFilter] of candidateFilters.entries()) {
        const snapshot = await readLatestPersistedBitableRecordSnapshot({
          appToken: options.appToken,
          tableId: options.tableId,
          tableName: source.tableName,
          fieldNames: source.fieldNames,
          viewId: options.viewId,
          filter: candidateFilter,
        });
        if (!snapshot) continue;
        const updating =
          index > 0 || Date.now() - snapshot.fetchedAt >= CACHE_MS;
        if (updating)
          void fetch().catch(() =>
            this.logger.warn(`${source.tableName} 后台更新失败`),
          );
        return {
          records: snapshot.records,
          state: {
            status: updating
              ? 'stale'
              : snapshot.records.length
                ? 'ready'
                : 'empty',
            ...(updating ? { message: '后台更新中' } : {}),
            syncedAt: new Date(snapshot.fetchedAt).toISOString(),
          },
        };
      }
    }
    try {
      const records = await Promise.race([
        fetch(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('读取超时')), timeoutMs);
        }),
      ]);
      const persisted = await readLatestPersistedBitableRecordSnapshot({
        tableId: options.tableId,
        tableName: source.tableName,
        fieldNames: source.fieldNames,
        viewId: options.viewId,
        filter,
      });
      const updating =
        !refresh && persisted && Date.now() - persisted.fetchedAt >= CACHE_MS;
      return {
        records,
        state: {
          status: updating ? 'stale' : records.length ? 'ready' : 'empty',
          ...(updating ? { message: '后台更新中' } : {}),
          syncedAt: new Date(persisted?.fetchedAt ?? Date.now()).toISOString(),
        },
      };
    } catch {
      const persisted = sourceResolved
        ? await readLatestPersistedBitableRecordSnapshot({
            tableId: options.tableId,
            tableName: source.tableName,
            fieldNames: source.fieldNames,
            viewId: options.viewId,
            filter,
          })
        : null;
      if (persisted)
        return {
          records: persisted.records,
          state: {
            status: 'stale',
            syncedAt: new Date(persisted.fetchedAt).toISOString(),
            message: '更新失败，显示上次成功数据，可重试刷新',
          },
        };
      return {
        records: [],
        state: {
          status: 'error',
          syncedAt: null,
          message: '数据暂时无法读取，请重试；持续失败请检查数据源读取权限',
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
