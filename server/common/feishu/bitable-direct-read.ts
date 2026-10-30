import { ForbiddenException, Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertBitableTableConfig,
  getFeishuAuthPayload,
} from '@server/common/config/external-services.config';

export interface BitableRecordItem {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
  created_time?: number;
  last_modified_time?: number;
}

export interface FeishuBitableAuthConfig {
  appId: string;
  appSecret: string;
}

export interface BitableRecordSearchFilterCondition {
  field_name: string;
  operator: string;
  value?: readonly string[];
}

export interface BitableRecordSearchFilter {
  conjunction: 'and' | 'or';
  conditions: readonly BitableRecordSearchFilterCondition[];
}

export interface BitableRecordSearchSort {
  field_name: string;
  desc?: boolean;
}

export interface FetchBitableRecordsOptions {
  appToken: string;
  tableId: string;
  viewId?: string;
  automaticFields?: boolean;
  fieldNames?: readonly string[];
  filter?: BitableRecordSearchFilter;
  sort?: readonly BitableRecordSearchSort[];
  tableName: string;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  allowStale?: boolean;
  strict?: boolean;
  requirePersisted?: boolean;
  onPersisted?: (snapshot: { fetchedAt: number; sourceStartedAt: number; invalidationToken: string | null }) => void;
  validateRecords?: (records: BitableRecordItem[]) => void;
  auth?: FeishuBitableAuthConfig;
}

function normalizeBitableFieldNames(
  fieldNames: readonly string[] | undefined,
): string[] {
  return [
    ...new Set(
      (fieldNames ?? [])
        .map((fieldName) => fieldName.trim())
        .filter((fieldName) => fieldName.length > 0),
    ),
  ].sort();
}

function normalizeBitableViewId(
  viewId: string | undefined,
): string | undefined {
  return viewId?.trim() || undefined;
}

function normalizeBitableRecordSearchFilter(
  filter: BitableRecordSearchFilter | undefined,
): BitableRecordSearchFilter | undefined {
  if (!filter) {
    return undefined;
  }
  const conjunction = String(filter.conjunction).trim().toLowerCase();
  if (conjunction !== 'and' && conjunction !== 'or') {
    throw new TypeError(
      `Invalid Feishu Bitable filter conjunction: ${filter.conjunction}`,
    );
  }
  if (!Array.isArray(filter.conditions) || filter.conditions.length === 0) {
    throw new TypeError(
      'Feishu Bitable filter must contain at least one condition',
    );
  }
  const conditions = filter.conditions.map((condition) => {
    const fieldName = String(condition.field_name).trim();
    const operator = String(condition.operator).trim();
    if (!fieldName || !operator) {
      throw new TypeError(
        'Feishu Bitable filter conditions require field_name and operator',
      );
    }
    if (
      condition.value !== undefined &&
      (!Array.isArray(condition.value) ||
        condition.value.some((value) => typeof value !== 'string'))
    ) {
      throw new TypeError(
        'Feishu Bitable filter condition values must be strings',
      );
    }
    return {
      field_name: fieldName,
      operator,
      ...(condition.value !== undefined ? { value: [...condition.value] } : {}),
    };
  });
  return { conjunction, conditions };
}

function normalizeBitableRecordSearchSort(
  sort: readonly BitableRecordSearchSort[] | undefined,
): BitableRecordSearchSort[] {
  return (sort ?? []).map((item) => {
    const fieldName = String(item.field_name).trim();
    if (!fieldName) {
      throw new TypeError('Feishu Bitable sort entries require field_name');
    }
    return {
      field_name: fieldName,
      ...(item.desc !== undefined ? { desc: Boolean(item.desc) } : {}),
    };
  });
}

function serializeBitableRecordSearchQuery(options: {
  filter?: BitableRecordSearchFilter;
  sort?: readonly BitableRecordSearchSort[];
}): string {
  if (!options.filter && !options.sort?.length) {
    return '';
  }
  return JSON.stringify({
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.sort?.length ? { sort: options.sort } : {}),
  });
}

export interface ResolveBitableAppTokenOptions {
  appToken?: string;
  wikiToken?: string;
  tableName: string;
  auth?: FeishuBitableAuthConfig;
  requestTimeoutMs?: (stage: string) => number;
  waitFor?: <T>(promise: Promise<T>, stage: string) => Promise<T>;
  waitBeforeRetry?: (delayMs: number, stage: string) => Promise<void>;
}

export interface ResolveBitableTableIdByNameOptions {
  appToken: string;
  tableName: string;
  auth?: FeishuBitableAuthConfig;
}

const SPLIT_TEXT_PATTERN = /[,，、;；\n\r]+/;
const DEFAULT_CACHE_TTL_MS =
  getPositiveIntegerEnv('FEISHU_LOCAL_CACHE_TTL_MS') ?? 4 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 500;
const MIN_RETRY_PAGE_SIZE = 100;
const MAX_REQUEST_ATTEMPTS =
  getPositiveIntegerEnv('FEISHU_BITABLE_MAX_ATTEMPTS') ?? 3;
const RETRY_BASE_DELAY_MS =
  getPositiveIntegerEnv('FEISHU_BITABLE_RETRY_BASE_DELAY_MS') ?? 500;
const DEFAULT_TOKEN_TTL_SECONDS = 7200;
const TOKEN_EXPIRY_BUFFER_SECONDS = 300;
const SHANGHAI_LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const LOCAL_CACHE_DIR = resolve(
  process.env.FEISHU_LOCAL_CACHE_DIR?.trim() ||
    join(process.cwd(), 'data', 'feishu-bitable-cache'),
);
const localCacheLogger = new Logger('FeishuBitableLocalCache');
const wikiBitableAppTokenCache = new Map<string, string | Promise<string>>();
const bitableTableIdByNameCache = new Map<string, string>();
const bitableAppRequestTails = new Map<string, Promise<void>>();

interface TenantAccessTokenCacheEntry {
  expiresAt: number;
  promise?: Promise<string>;
  token?: string;
}

const tenantAccessTokenCache = new Map<string, TenantAccessTokenCacheEntry>();

interface BitableRecordCacheEntry {
  expiresAt: number;
  fetchedAt?: number;
  sourceStartedAt?: number;
  records?: BitableRecordItem[];
  promise?: Promise<BitableRecordItem[]>;
}

const bitableRecordCache = new Map<string, BitableRecordCacheEntry>();
const persistedBitableRecordWriteTails = new Map<string, Promise<void>>();

interface PersistedBitableRecordCache {
  contentFingerprint?: string;
  sourceStartedAt?: number;
  version: 1;
  appToken?: string;
  invalidationToken?: string;
  tableName: string;
  tableId: string;
  viewId?: string;
  automaticFields?: boolean;
  fieldNames?: string[];
  filter?: BitableRecordSearchFilter;
  sort?: BitableRecordSearchSort[];
  fetchedAt: number;
  expiresAt: number;
  recordCount: number;
  records: BitableRecordItem[];
}

interface LatestPersistedBitableRecordFileIndexEntry {
  appToken?: string;
  cachePath: string;
  expiresAt: number;
  fetchedAt: number;
  tableId: string;
}

interface LatestPersistedBitableRecordSnapshotIndexEntry {
  file: LatestPersistedBitableRecordFileIndexEntry;
  snapshot: PersistedBitableRecordSnapshot;
}

interface LatestPersistedBitableRecordReadInFlightEntry {
  generation: number;
  promise: Promise<PersistedBitableRecordSnapshot | null>;
  tableId: string;
}

const latestPersistedBitableRecordFileIndex = new Map<
  string,
  LatestPersistedBitableRecordFileIndexEntry
>();
const latestPersistedBitableRecordSnapshotIndex = new Map<
  string,
  LatestPersistedBitableRecordSnapshotIndexEntry
>();
const latestPersistedBitableRecordReadInFlight = new Map<
  string,
  LatestPersistedBitableRecordReadInFlightEntry
>();
const persistedBitableRecordScopeInvalidationTokens = new Map<
  string,
  string | null
>();
const persistedBitableRecordScopeInvalidationTokenReads = new Map<
  string,
  Promise<string | null>
>();
const persistedBitableRecordScopeInvalidationWriteTails = new Map<
  string,
  Promise<void>
>();
const activePersistedBitableRecordScopeInvalidations = new Map<
  string,
  string
>();
const persistedBitableRecordFileInvalidationTokens = new Map<
  string,
  string | null
>();
let persistedBitableRecordScopeInvalidationSequence = 0;
let latestPersistedBitableRecordFileIndexReady = false;
let latestPersistedBitableRecordFileIndexScan: Promise<boolean | null> | null =
  null;
let latestPersistedBitableRecordIndexGeneration = 0;

export interface BitableBackgroundRefreshOptions {
  intervalMs?: number;
  name: string;
  refresh: () => Promise<void>;
  warm: () => Promise<void>;
}

export interface BitableBackgroundRefreshController {
  start: () => void;
  stop: () => void;
}

export function createBitableBackgroundRefresh(
  options: BitableBackgroundRefreshOptions,
): BitableBackgroundRefreshController {
  const enabled =
    process.env.FEISHU_SUPPLY_CHAIN_BACKGROUND_SYNC_ENABLED?.trim().toLowerCase() !==
    'false';
  const intervalMs =
    options.intervalMs ??
    getPositiveIntegerEnv('FEISHU_SUPPLY_CHAIN_SYNC_INTERVAL_MS') ??
    4 * 60 * 60 * 1000;
  let activeJob: Promise<void> | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  let warmupTimer: NodeJS.Timeout | null = null;

  const run = (job: () => Promise<void>, phase: string): void => {
    if (activeJob) {
      return;
    }
    activeJob = job()
      .catch((error: unknown) => {
        localCacheLogger.warn(
          `${options.name} ${phase} failed: ${safeExternalErrorMessage(error)}`,
        );
      })
      .finally(() => {
        activeJob = null;
      });
  };

  return {
    start: () => {
      if (!enabled || warmupTimer || intervalTimer) {
        return;
      }
      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        run(options.warm, 'warmup');
      }, 0);
      warmupTimer.unref?.();
      intervalTimer = setInterval(
        () => run(options.refresh, 'refresh'),
        intervalMs,
      );
      intervalTimer.unref?.();
    },
    stop: () => {
      if (warmupTimer) {
        clearTimeout(warmupTimer);
        warmupTimer = null;
      }
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },
  };
}

export function invalidateFeishuTenantAccessTokenCache(): void {
  tenantAccessTokenCache.clear();
}

export function invalidateFeishuTenantAccessTokenCacheForApp(
  appId: string,
): void {
  const normalizedAppId = appId.trim();
  if (!normalizedAppId) return;
  tenantAccessTokenCache.delete(normalizedAppId);
}

export function invalidateBitableRecordCache(options?: {
  appToken?: string;
  tableId?: string;
  deletePersisted?: boolean;
}): void {
  const persistedCachePaths = new Set<string>();
  if (options?.deletePersisted && options.appToken && options.tableId) {
    for (const cacheKey of bitableRecordCache.keys()) {
      if (
        matchesBitableRecordCacheKeyScope(cacheKey, {
          appToken: options.appToken,
          tableId: options.tableId,
        })
      ) {
        persistedCachePaths.add(getPersistedCachePath(cacheKey));
      }
    }
    for (const entry of latestPersistedBitableRecordFileIndex.values()) {
      if (
        entry.appToken === options.appToken &&
        entry.tableId === options.tableId
      ) {
        persistedCachePaths.add(entry.cachePath);
      }
    }
    persistedCachePaths.add(
      getPersistedCachePath(`${options.appToken}:${options.tableId}:`),
    );

    const scopeKey = getPersistedBitableRecordScopeKey(
      options.appToken,
      options.tableId,
    );
    const invalidationToken = createPersistedBitableRecordInvalidationToken();
    persistedBitableRecordScopeInvalidationTokens.set(
      scopeKey,
      invalidationToken,
    );
    activePersistedBitableRecordScopeInvalidations.set(
      scopeKey,
      invalidationToken,
    );
    queuePersistedBitableRecordScopeInvalidationWrite(
      scopeKey,
      invalidationToken,
    );
  }

  if ((!options?.appToken && !options?.tableId) || options?.deletePersisted) {
    invalidateLatestPersistedBitableRecordIndex(options);
  }
  if (!options?.appToken && !options?.tableId) {
    bitableRecordCache.clear();
    return;
  }

  for (const key of bitableRecordCache.keys()) {
    const [appToken, tableId] = key.split(':');
    if (
      (!options.appToken || options.appToken === appToken) &&
      (!options.tableId || options.tableId === tableId)
    ) {
      bitableRecordCache.delete(key);
    }
  }

  for (const cachePath of persistedCachePaths) {
    persistedBitableRecordFileInvalidationTokens.delete(cachePath);
    queuePersistedBitableRecordCacheDeletion(cachePath);
  }
}

export async function fetchBitableRecords(
  httpService: HttpService,
  rawOptions: FetchBitableRecordsOptions,
): Promise<BitableRecordItem[]> {
  const options: FetchBitableRecordsOptions = {
    ...rawOptions,
    viewId: normalizeBitableViewId(rawOptions.viewId),
    automaticFields: rawOptions.automaticFields === true,
    fieldNames: normalizeBitableFieldNames(rawOptions.fieldNames),
    filter: normalizeBitableRecordSearchFilter(rawOptions.filter),
    sort: normalizeBitableRecordSearchSort(rawOptions.sort),
  };
  assertBitableTableConfig(
    options.tableName,
    options.appToken,
    options.tableId,
  );

  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const rawBaseCacheKey = `${options.appToken}:${options.tableId}:${options.viewId || ''}`;
  const baseCacheKey = options.automaticFields
    ? `${rawBaseCacheKey}:automatic-fields`
    : rawBaseCacheKey;
  const projectionCacheKey = options.fieldNames?.length
    ? `${baseCacheKey}:${options.fieldNames.join('\u001f')}`
    : baseCacheKey;
  const querySignature = serializeBitableRecordSearchQuery(options);
  const cacheKey = querySignature
    ? `${projectionCacheKey}:query:${querySignature}`
    : projectionCacheKey;
  const cached = bitableRecordCache.get(cacheKey);
  const now = Date.now();

  if (options.forceRefresh && cached?.promise) {
    const records = await resolveSharedBitableRecordRequest(
      cached.promise,
      options,
    );
    const fetchedAt = Date.now();
    const effectiveCacheTtlMs =
      cacheTtlMs > 0 ? cacheTtlMs : DEFAULT_CACHE_TTL_MS;
    await writePersistedBitableRecordCache(
      cacheKey,
      options,
      records,
      fetchedAt,
      fetchedAt + effectiveCacheTtlMs,
      cached.sourceStartedAt ?? fetchedAt,
    );
    const current = bitableRecordCache.get(cacheKey);
    if (
      (!current?.promise || current.promise === cached.promise) &&
      (!current?.fetchedAt || current.fetchedAt <= fetchedAt)
    ) {
      bitableRecordCache.set(cacheKey, {
        expiresAt: fetchedAt + effectiveCacheTtlMs,
        fetchedAt,
        sourceStartedAt: cached.sourceStartedAt ?? fetchedAt,
        records,
      });
    }
    return records;
  }

  if (!options.forceRefresh && cacheTtlMs > 0 && cached) {
    if (cached.records) {
      if (cached.expiresAt > now) {
        return cached.records;
      }
      if (options.allowStale !== false) {
        refreshBitableRecordsInBackground(
          httpService,
          options,
          cacheKey,
          cacheTtlMs,
        );
        return cached.records;
      }
    }
    if (cached.promise) {
      return resolveSharedBitableRecordRequest(cached.promise, options);
    }
  }

  if (!options.forceRefresh && cacheTtlMs > 0) {
    const persisted = await readPersistedBitableRecordCache(cacheKey, options);
    if (persisted) {
      const effectiveExpiresAt = Math.min(
        persisted.expiresAt,
        persisted.fetchedAt + cacheTtlMs,
      );
      bitableRecordCache.set(cacheKey, {
        expiresAt: effectiveExpiresAt,
        fetchedAt: persisted.fetchedAt,
        sourceStartedAt: persisted.sourceStartedAt,
        records: persisted.records,
      });

      if (effectiveExpiresAt > now) {
        return persisted.records;
      }
      if (options.allowStale !== false) {
        refreshBitableRecordsInBackground(
          httpService,
          options,
          cacheKey,
          cacheTtlMs,
        );
        return persisted.records;
      }
    }
  }

  let previousCache = bitableRecordCache.get(cacheKey);
  if (options.forceRefresh && !previousCache?.records) {
    const persisted = await readPersistedBitableRecordCache(cacheKey, options);
    if (persisted) {
      previousCache = {
        expiresAt: persisted.expiresAt,
        fetchedAt: persisted.fetchedAt,
        sourceStartedAt: persisted.sourceStartedAt,
        records: persisted.records,
      };
    }
  }

  const requestPromise = (async () => {
    const tenantAccessToken = await getTenantAccessToken(
      httpService,
      options.auth,
    );
    const records: BitableRecordItem[] = [];
    let pageToken: string | undefined;
    let hasMore = true;
    let pageSize = DEFAULT_PAGE_SIZE;
    const seenPageTokens = new Set<string>();

    while (hasMore) {
      let successfulPageSize = pageSize;
      const response = await withFeishuRequestRetry(async (attempt) => {
        successfulPageSize = Math.max(
          MIN_RETRY_PAGE_SIZE,
          Math.floor(pageSize / 2 ** attempt),
        );
        // Keep one request in flight per Base, without holding the slot for
        // an entire historical scan or while a failed page backs off.
        return runSerializedBitableAppRequest(
          options.appToken,
          () => requestBitableRecordPage(
            httpService,
            options,
            tenantAccessToken,
            pageToken,
            successfulPageSize,
          ),
        );
      }, options.tableName);
      pageSize = successfulPageSize;

      const data = response.data.data || {};
      if (options.requirePersisted && !Array.isArray(data.items)) throw new Error('同步来源分页记录格式无效');
      records.push(...(data.items || []));
      pageToken = data.page_token;
      hasMore = Boolean(data.has_more);
      if (options.requirePersisted && hasMore) {
        if (typeof pageToken !== 'string' || !pageToken || seenPageTokens.has(pageToken)) throw new Error('同步来源分页未完整返回');
        seenPageTokens.add(pageToken);
      }
    }

    options.validateRecords?.(records);
    return records;
  })();

  bitableRecordCache.set(cacheKey, {
    expiresAt: previousCache?.expiresAt ?? now + Math.max(cacheTtlMs, 0),
    fetchedAt: previousCache?.fetchedAt,
    records: previousCache?.records,
    promise: requestPromise,
    sourceStartedAt: now,
  });

  try {
    const records = await requestPromise;
    const shouldStoreFreshRecords = cacheTtlMs > 0 || options.forceRefresh;
    if (shouldStoreFreshRecords) {
      const fetchedAt = Date.now();
      const effectiveCacheTtlMs =
        cacheTtlMs > 0 ? cacheTtlMs : DEFAULT_CACHE_TTL_MS;
      await writePersistedBitableRecordCache(
        cacheKey,
        options,
        records,
        fetchedAt,
        fetchedAt + effectiveCacheTtlMs,
        now,
      );
      bitableRecordCache.set(cacheKey, {
        expiresAt: fetchedAt + effectiveCacheTtlMs,
        fetchedAt,
        sourceStartedAt: now,
        records,
      });
    } else if (bitableRecordCache.get(cacheKey)?.promise === requestPromise) {
      bitableRecordCache.delete(cacheKey);
    }
    return records;
  } catch (error) {
    if (bitableRecordCache.get(cacheKey)?.promise === requestPromise) {
      if (previousCache?.records) {
        bitableRecordCache.set(cacheKey, previousCache);
      } else {
        bitableRecordCache.delete(cacheKey);
      }
    }
    if (previousCache?.records && !options.strict) {
      localCacheLogger.warn(
        `Feishu refresh failed for ${options.tableName}; serving last successful snapshot (${previousCache.records.length} records): ${safeExternalErrorMessage(error)}`,
      );
      return previousCache.records;
    }
    throw error;
  }
}

async function resolveSharedBitableRecordRequest(
  request: Promise<BitableRecordItem[]>,
  options: FetchBitableRecordsOptions,
): Promise<BitableRecordItem[]> {
  const records = await request;
  options.validateRecords?.(records);
  return records;
}

async function requestBitableRecordPage(
  httpService: HttpService,
  options: FetchBitableRecordsOptions,
  tenantAccessToken: string,
  pageToken: string | undefined,
  pageSize: number,
) {
  let response;
  try {
    const requestBody = {
      ...(options.viewId ? { view_id: options.viewId } : {}),
      ...(options.automaticFields ? { automatic_fields: true } : {}),
      ...(options.fieldNames?.length
        ? { field_names: options.fieldNames }
        : {}),
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.sort?.length ? { sort: options.sort } : {}),
    };
    response = await httpService.axiosRef.post(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${options.appToken}/tables/${options.tableId}/records/search`,
      requestBody,
      {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        params: {
          page_size: pageSize,
          page_token: pageToken,
        },
        timeout: 30000,
      },
    );
  } catch (error: unknown) {
    const responseData = getAxiosErrorData(error);
    if (responseData.status === 403 || responseData.code === 91403) {
      throw new ForbiddenException(
        `飞书应用暂无「${options.tableName}」多维表记录读取权限：请在飞书开放平台开通 bitable/base 记录读取权限，并在该多维表中添加文档应用。`,
      );
    }
    throw error;
  }

  const responseCode = Number(response.data.code || 0);
  if (responseCode !== 0) {
    if (responseCode === 91403) {
      throw new ForbiddenException(
        `飞书应用暂无「${options.tableName}」多维表记录读取权限：请在飞书开放平台开通 bitable/base 记录读取权限，并在该多维表中添加文档应用。`,
      );
    }
    throw createFeishuApiError(
      'Bitable',
      responseCode,
      response.data.msg,
      response.status,
    );
  }

  return response;
}

export async function getTenantAccessToken(
  httpService: HttpService,
  auth?: FeishuBitableAuthConfig,
  controls?: Pick<
    ResolveBitableAppTokenOptions,
    'requestTimeoutMs' | 'waitFor' | 'waitBeforeRetry'
  >,
): Promise<string> {
  const authPayload = auth
    ? {
        app_id: auth.appId,
        app_secret: auth.appSecret,
      }
    : getFeishuAuthPayload();
  const cacheKey = authPayload.app_id;
  const now = Date.now();
  const cached = tenantAccessTokenCache.get(cacheKey);
  if (cached?.token && cached.expiresAt > now) {
    return cached.token;
  }
  if (cached?.promise) {
    return controls?.waitFor
      ? controls.waitFor(cached.promise, '等待 tenant access token')
      : cached.promise;
  }

  let tokenTtlSeconds = DEFAULT_TOKEN_TTL_SECONDS;
  const request = withFeishuRequestRetry(
    async () => {
      const response = await httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        authPayload,
        {
          timeout:
            controls?.requestTimeoutMs?.('获取 tenant access token') ?? 30000,
        },
      );
      const payload = asPlainObject(response.data);
      const responseCode = payload?.code;
      const tenantAccessToken = String(
        payload?.tenant_access_token || '',
      ).trim();
      if (responseCode !== 0 || !tenantAccessToken) {
        throw createFeishuApiError(
          'Auth',
          typeof responseCode === 'number' ? responseCode : -1,
          payload?.msg || 'tenant_access_token is missing',
          response.status,
        );
      }
      const responseExpireSeconds = Number(payload.expire);
      if (Number.isFinite(responseExpireSeconds) && responseExpireSeconds > 0) {
        tokenTtlSeconds = responseExpireSeconds;
      }
      return tenantAccessToken;
    },
    'tenant access token',
    controls,
  );

  tenantAccessTokenCache.set(cacheKey, {
    expiresAt: 0,
    promise: request,
  });

  try {
    const token = await request;
    tenantAccessTokenCache.set(cacheKey, {
      expiresAt:
        Date.now() +
        Math.max(60, tokenTtlSeconds - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000,
      token,
    });
    return token;
  } catch (error) {
    if (tenantAccessTokenCache.get(cacheKey)?.promise === request) {
      tenantAccessTokenCache.delete(cacheKey);
    }
    throw error;
  }
}

export async function resolveBitableTableIdByName(
  httpService: HttpService,
  options: ResolveBitableTableIdByNameOptions,
): Promise<string> {
  const appToken = String(options.appToken || '').trim();
  const tableName = String(options.tableName || '').trim();
  if (!appToken || !tableName) {
    throw new TypeError('Feishu Bitable app token and table name are required');
  }
  const cacheKey = `${appToken}:${tableName}`;
  const cached = bitableTableIdByNameCache.get(cacheKey);
  if (cached) return cached;

  const tenantAccessToken = await getTenantAccessToken(
    httpService,
    options.auth,
  );
  const matches = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const response = await httpService.axiosRef.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
        appToken,
      )}/tables`,
      {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        params: {
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
        timeout: 30000,
      },
    );
    const payload = asPlainObject(response.data);
    const responseCode = payload?.code;
    if (responseCode !== 0) {
      throw createFeishuApiError(
        'Bitable table list',
        typeof responseCode === 'number' ? responseCode : -1,
        payload?.msg,
        response.status,
      );
    }
    const data = asPlainObject(payload?.data);
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const rawItem of items) {
      const item = asPlainObject(rawItem);
      if (String(item?.name || '').trim() !== tableName) continue;
      const tableId = String(item?.table_id || '').trim();
      if (tableId) matches.add(tableId);
    }
    if (!data?.has_more) break;
    const next = String(data?.page_token || '').trim();
    if (!next || seenPageTokens.has(next)) {
      throw new Error(
        `Feishu Bitable table list pagination is invalid: ${tableName}`,
      );
    }
    seenPageTokens.add(next);
    pageToken = next;
  }

  if (matches.size !== 1) {
    throw new Error(
      matches.size === 0
        ? `Feishu Bitable table was not found: ${tableName}`
        : `Feishu Bitable table name is not unique: ${tableName}`,
    );
  }
  const tableId = [...matches][0];
  bitableTableIdByNameCache.set(cacheKey, tableId);
  return tableId;
}

async function runSerializedBitableAppRequest<T>(
  appToken: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = bitableAppRequestTails.get(appToken) ?? Promise.resolve();
  let release = () => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  bitableAppRequestTails.set(appToken, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (bitableAppRequestTails.get(appToken) === tail) {
      bitableAppRequestTails.delete(appToken);
    }
  }
}

async function withFeishuRequestRetry<T>(
  operation: (attempt: number) => Promise<T>,
  context: string,
  controls?: Pick<ResolveBitableAppTokenOptions, 'waitFor' | 'waitBeforeRetry'>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const request = operation(attempt);
      return controls?.waitFor
        ? await controls.waitFor(request, context)
        : await request;
    } catch (error: unknown) {
      lastError = error;
      if (
        attempt >= MAX_REQUEST_ATTEMPTS - 1 ||
        !isTransientFeishuError(error)
      ) {
        throw error;
      }
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
      localCacheLogger.warn(
        `Transient Feishu error while reading ${context}; retrying in ${delayMs}ms: ${safeExternalErrorMessage(error)}`,
      );
      if (controls?.waitBeforeRetry) {
        await controls.waitBeforeRetry(delayMs, `${context} 重试退避`);
      } else {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function createFeishuApiError(
  api: string,
  code: number,
  message: unknown,
  status?: number,
): Error {
  const error = new Error(
    `Feishu ${api} API error: ${String(message || code || 'unknown')}`,
  ) as Error & { feishuCode?: number; status?: number };
  error.feishuCode = code;
  error.status = status;
  return error;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function isTransientFeishuError(error: unknown): boolean {
  if (error instanceof ForbiddenException) {
    return false;
  }
  const responseData = getAxiosErrorData(error);
  const transientCodes = new Set([
    1254290, 1254607, 1255001, 1255002, 1255003, 1255004, 1255005, 1255040,
    99991400,
  ]);
  const networkCode = String(
    (error as { code?: string })?.code || '',
  ).toUpperCase();
  return (
    transientCodes.has(Number(responseData.code)) ||
    responseData.status === 429 ||
    Number(responseData.status) >= 500 ||
    ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT'].includes(networkCode)
  );
}

function safeExternalErrorMessage(error: unknown): string {
  const responseData = (
    error as {
      feishuCode?: number;
      response?: { data?: { code?: number; msg?: unknown } };
    }
  )?.response?.data;
  const code =
    responseData?.code ?? (error as { feishuCode?: number })?.feishuCode;
  const responseMessage = responseData?.msg;
  const errorMessage = (error as { message?: unknown })?.message;
  const message =
    responseMessage !== undefined
      ? `${code ? `code=${code} ` : ''}${String(responseMessage)}`
      : error instanceof Error
        ? error.message
        : errorMessage !== undefined
          ? String(errorMessage)
          : String(error);
  return message.replace(
    /(app_secret|tenant_access_token|token)=[^\s&]+/gi,
    '$1=***',
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

export async function resolveBitableAppToken(
  httpService: HttpService,
  options: ResolveBitableAppTokenOptions,
): Promise<string> {
  const appToken = options.appToken?.trim();
  const wikiToken = options.wikiToken?.trim();

  if (appToken) {
    return appToken;
  }
  if (!wikiToken) {
    return '';
  }

  const cached = wikiBitableAppTokenCache.get(wikiToken);
  if (cached) {
    if (typeof cached === 'string') return cached;
    return options.waitFor
      ? options.waitFor(cached, '等待多维表 app token')
      : await cached;
  }

  const request = resolveBitableAppTokenFromWiki(
    httpService,
    wikiToken,
    options.tableName,
    options.auth,
    options,
  );
  wikiBitableAppTokenCache.set(wikiToken, request);

  try {
    const resolvedAppToken = await request;
    wikiBitableAppTokenCache.set(wikiToken, resolvedAppToken);
    return resolvedAppToken;
  } catch (error) {
    wikiBitableAppTokenCache.delete(wikiToken);
    throw error;
  }
}

async function resolveBitableAppTokenFromWiki(
  httpService: HttpService,
  wikiToken: string,
  tableName: string,
  auth?: FeishuBitableAuthConfig,
  controls?: Pick<
    ResolveBitableAppTokenOptions,
    'requestTimeoutMs' | 'waitFor' | 'waitBeforeRetry'
  >,
): Promise<string> {
  const tenantAccessToken = await getTenantAccessToken(
    httpService,
    auth,
    controls,
  );
  const response = await withFeishuRequestRetry(
    async () => {
      try {
        const wikiResponse = await httpService.axiosRef.get(
          'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
          {
            headers: { Authorization: `Bearer ${tenantAccessToken}` },
            params: { token: wikiToken },
            timeout:
              controls?.requestTimeoutMs?.('解析 Wiki 多维表 app token') ??
              30000,
          },
        );
        const payload = asPlainObject(wikiResponse.data);
        const responseCode = payload?.code;
        if (responseCode === 91403) {
          throw new ForbiddenException(
            `飞书应用暂无「${tableName}」知识库节点读取权限：请开通 wiki 节点读取权限，并确认应用已加入该知识库/多维表。`,
          );
        }
        if (responseCode !== 0) {
          throw createFeishuApiError(
            'Wiki',
            typeof responseCode === 'number' ? responseCode : -1,
            payload?.msg,
            wikiResponse.status,
          );
        }
        return wikiResponse;
      } catch (error: unknown) {
        const responseData = getAxiosErrorData(error);
        if (responseData.status === 403 || responseData.code === 91403) {
          throw new ForbiddenException(
            `飞书应用暂无「${tableName}」知识库节点读取权限：请开通 wiki 节点读取权限，并确认应用已加入该知识库/多维表。`,
          );
        }
        throw error;
      }
    },
    tableName,
    controls,
  );

  const node = response.data.data?.node;
  if (node?.obj_type !== 'bitable') {
    throw new Error(
      `「${tableName}」链接不是多维表，当前类型：${node?.obj_type || 'unknown'}`,
    );
  }
  if (!node.obj_token) {
    throw new Error(`「${tableName}」知识库节点未返回多维表 app token`);
  }

  return node.obj_token;
}

function refreshBitableRecordsInBackground(
  httpService: HttpService,
  options: FetchBitableRecordsOptions,
  cacheKey: string,
  cacheTtlMs: number,
): void {
  if (bitableRecordCache.get(cacheKey)?.promise) {
    return;
  }

  void fetchBitableRecords(httpService, {
    ...options,
    cacheTtlMs,
    forceRefresh: true,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    localCacheLogger.warn(
      `Feishu local cache refresh failed for ${options.tableName}: ${message}`,
    );
  });
}

function getPersistedBitableRecordScopeKey(
  appToken: string,
  tableId: string,
): string {
  return `${appToken}\u001f${tableId}`;
}

export function readBitableCacheScopeRevision(appToken: string, tableId: string): Promise<string | null> {
  return readPersistedBitableRecordScopeInvalidationToken(getPersistedBitableRecordScopeKey(appToken, tableId));
}

function matchesBitableRecordCacheKeyScope(
  cacheKey: string,
  options: { appToken: string; tableId: string },
): boolean {
  return cacheKey.startsWith(`${options.appToken}:${options.tableId}:`);
}

function getPersistedBitableRecordScopeInvalidationPath(
  scopeKey: string,
): string {
  const fileName = createHash('sha1')
    .update(`scope-invalidation:${scopeKey}`)
    .digest('hex');
  return join(LOCAL_CACHE_DIR, `${fileName}.invalidation`);
}

function createPersistedBitableRecordInvalidationToken(): string {
  persistedBitableRecordScopeInvalidationSequence += 1;
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${persistedBitableRecordScopeInvalidationSequence.toString(36)}`;
}

async function readPersistedBitableRecordScopeInvalidationToken(
  scopeKey: string,
): Promise<string | null> {
  if (persistedBitableRecordScopeInvalidationTokens.has(scopeKey)) {
    return persistedBitableRecordScopeInvalidationTokens.get(scopeKey) ?? null;
  }

  const activeRead =
    persistedBitableRecordScopeInvalidationTokenReads.get(scopeKey);
  if (activeRead) return activeRead;

  let readRequest: Promise<string | null>;
  readRequest = (async () => {
    try {
      const token = (
        await readFile(
          getPersistedBitableRecordScopeInvalidationPath(scopeKey),
          'utf8',
        )
      ).trim();
      if (token) return token;
      localCacheLogger.warn(
        'Read empty Feishu local cache invalidation marker',
      );
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'ENOENT') return null;
      const message = error instanceof Error ? error.message : String(error);
      localCacheLogger.warn(
        `Read Feishu local cache invalidation marker failed: ${message}`,
      );
    }
    return `invalid-marker:${createHash('sha1').update(scopeKey).digest('hex')}`;
  })()
    .then((token) => {
      if (!persistedBitableRecordScopeInvalidationTokens.has(scopeKey)) {
        persistedBitableRecordScopeInvalidationTokens.set(scopeKey, token);
      }
      return (
        persistedBitableRecordScopeInvalidationTokens.get(scopeKey) ?? null
      );
    })
    .finally(() => {
      if (
        persistedBitableRecordScopeInvalidationTokenReads.get(scopeKey) ===
        readRequest
      ) {
        persistedBitableRecordScopeInvalidationTokenReads.delete(scopeKey);
      }
    });
  persistedBitableRecordScopeInvalidationTokenReads.set(scopeKey, readRequest);
  return readRequest;
}

function queuePersistedBitableRecordScopeInvalidationWrite(
  scopeKey: string,
  invalidationToken: string,
): void {
  const previousWrite =
    persistedBitableRecordScopeInvalidationWriteTails.get(scopeKey);
  let writeRequest: Promise<void>;
  writeRequest = (previousWrite ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await mkdir(LOCAL_CACHE_DIR, { recursive: true });
      await writeFile(
        getPersistedBitableRecordScopeInvalidationPath(scopeKey),
        invalidationToken,
        'utf8',
      );
    });
  persistedBitableRecordScopeInvalidationWriteTails.set(scopeKey, writeRequest);
  void writeRequest
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      localCacheLogger.warn(
        `Write Feishu local cache invalidation marker failed: ${message}`,
      );
    })
    .finally(() => {
      if (
        persistedBitableRecordScopeInvalidationWriteTails.get(scopeKey) ===
        writeRequest
      ) {
        persistedBitableRecordScopeInvalidationWriteTails.delete(scopeKey);
      }
    });
}

async function waitForPersistedBitableRecordScopeInvalidationWrite(
  scopeKey: string,
): Promise<void> {
  await persistedBitableRecordScopeInvalidationWriteTails
    .get(scopeKey)
    ?.catch(() => undefined);
}

function queuePersistedBitableRecordCacheDeletion(cachePath: string): void {
  const previousWrite = persistedBitableRecordWriteTails.get(cachePath);
  let deleteRequest: Promise<void>;
  deleteRequest = (previousWrite ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => rm(cachePath, { force: true }));
  persistedBitableRecordWriteTails.set(cachePath, deleteRequest);
  void deleteRequest
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      localCacheLogger.warn(`Delete Feishu local cache failed: ${message}`);
    })
    .finally(() => {
      if (persistedBitableRecordWriteTails.get(cachePath) === deleteRequest) {
        persistedBitableRecordWriteTails.delete(cachePath);
      }
    });
}

async function readPersistedBitableRecordCache(
  cacheKey: string,
  options: Pick<FetchBitableRecordsOptions, 'appToken' | 'tableId'>,
  fingerprint = false,
): Promise<PersistedBitableRecordCache | null> {
  const cachePath = getPersistedCachePath(cacheKey);
  const scopeKey = getPersistedBitableRecordScopeKey(
    options.appToken,
    options.tableId,
  );
  const activeInvalidationToken =
    activePersistedBitableRecordScopeInvalidations.get(scopeKey);
  if (
    activeInvalidationToken &&
    persistedBitableRecordFileInvalidationTokens.get(cachePath) !==
      activeInvalidationToken
  ) {
    queuePersistedBitableRecordCacheDeletion(cachePath);
    return null;
  }

  try {
    const expectedInvalidationToken =
      await readPersistedBitableRecordScopeInvalidationToken(scopeKey);
    const raw = await readFile(cachePath, 'utf8');
    const persisted = parsePersistedBitableRecordCache(raw);
    const currentInvalidationToken =
      persistedBitableRecordScopeInvalidationTokens.get(scopeKey) ??
      expectedInvalidationToken;
    if (
      persisted &&
      currentInvalidationToken &&
      persisted.invalidationToken !== currentInvalidationToken
    ) {
      queuePersistedBitableRecordCacheDeletion(cachePath);
      return null;
    }
    if (persisted && fingerprint)
      persisted.contentFingerprint = createHash('sha256').update(raw).digest('hex');
    return persisted;
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== 'ENOENT') {
      const message = error instanceof Error ? error.message : String(error);
      localCacheLogger.warn(`Read Feishu local cache failed: ${message}`);
    }
    return null;
  }
}

export interface ReadLatestPersistedBitableRecordsOptions {
  appToken?: string;
  tableId: string;
  tableName: string;
  automaticFields?: boolean;
  fieldNames?: readonly string[];
  viewId?: string;
  filter?: BitableRecordSearchFilter;
  sort?: readonly BitableRecordSearchSort[];
  directOnly?: boolean;
}

export interface PersistedBitableRecordSnapshot {
  contentFingerprint?: string;
  sourceStartedAt?: number;
  records: BitableRecordItem[];
  fetchedAt: number;
  expiresAt: number;
}

interface NormalizedLatestPersistedBitableRecordQuery {
  appToken?: string;
  automaticFields: boolean;
  fieldNames: string[];
  filter?: BitableRecordSearchFilter;
  key: string;
  querySignature: string;
  sort: BitableRecordSearchSort[];
  tableId: string;
  tableName: string;
  viewId?: string;
}

function normalizeLatestPersistedBitableRecordQuery(
  options: ReadLatestPersistedBitableRecordsOptions,
): NormalizedLatestPersistedBitableRecordQuery {
  const appToken = options.appToken?.trim() || undefined;
  const viewId = normalizeBitableViewId(options.viewId);
  const automaticFields = options.automaticFields === true;
  const fieldNames = normalizeBitableFieldNames(options.fieldNames);
  const filter = normalizeBitableRecordSearchFilter(options.filter);
  const sort = normalizeBitableRecordSearchSort(options.sort);
  const querySignature = serializeBitableRecordSearchQuery({ filter, sort });
  return {
    appToken,
    automaticFields,
    tableId: options.tableId,
    tableName: options.tableName,
    viewId,
    fieldNames,
    filter,
    sort,
    querySignature,
    key: JSON.stringify([
      appToken || '',
      options.tableId,
      options.tableName,
      viewId || '',
      automaticFields,
      fieldNames,
      querySignature,
    ]),
  };
}

function createLatestPersistedBitableRecordQueryVariants(
  options: ReadLatestPersistedBitableRecordsOptions,
): NormalizedLatestPersistedBitableRecordQuery[] {
  const scoped = normalizeLatestPersistedBitableRecordQuery(options);
  if (!scoped.appToken) return [scoped];
  return [
    scoped,
    normalizeLatestPersistedBitableRecordQuery({
      ...options,
      appToken: undefined,
    }),
  ];
}

function matchesLatestPersistedBitableRecordIndexEntry(
  entry: LatestPersistedBitableRecordFileIndexEntry,
  options: { appToken?: string; tableId?: string },
): boolean {
  return (
    (!options.tableId || entry.tableId === options.tableId) &&
    (!options.appToken ||
      !entry.appToken ||
      entry.appToken === options.appToken)
  );
}

function invalidateLatestPersistedBitableRecordIndex(options?: {
  appToken?: string;
  tableId?: string;
}): void {
  latestPersistedBitableRecordIndexGeneration += 1;
  latestPersistedBitableRecordReadInFlight.clear();

  if (!options?.appToken && !options?.tableId) {
    latestPersistedBitableRecordFileIndex.clear();
    latestPersistedBitableRecordSnapshotIndex.clear();
    latestPersistedBitableRecordFileIndexReady = false;
    return;
  }

  for (const [key, entry] of latestPersistedBitableRecordFileIndex) {
    if (matchesLatestPersistedBitableRecordIndexEntry(entry, options)) {
      latestPersistedBitableRecordFileIndex.delete(key);
    }
  }
  for (const [key, entry] of latestPersistedBitableRecordSnapshotIndex) {
    if (matchesLatestPersistedBitableRecordIndexEntry(entry.file, options)) {
      latestPersistedBitableRecordSnapshotIndex.delete(key);
    }
  }
}

function setLatestPersistedBitableRecordFileIndexEntry(
  key: string,
  entry: LatestPersistedBitableRecordFileIndexEntry,
): boolean {
  const current = latestPersistedBitableRecordFileIndex.get(key);
  if (current && current.fetchedAt > entry.fetchedAt) {
    return false;
  }
  latestPersistedBitableRecordFileIndex.set(key, entry);
  return true;
}

async function scanLatestPersistedBitableRecordFiles(): Promise<
  Map<string, LatestPersistedBitableRecordFileIndexEntry>
> {
  let fileNames: string[];
  try {
    fileNames = await readdir(LOCAL_CACHE_DIR);
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }

  const scanned = new Map<string, LatestPersistedBitableRecordFileIndexEntry>();
  for (const fileName of fileNames) {
    if (!fileName.endsWith('.json')) continue;
    const cachePath = join(LOCAL_CACHE_DIR, fileName);
    try {
      const raw = await readFile(cachePath, 'utf8');
      const candidate = parsePersistedBitableRecordCache(raw);
      if (!candidate) continue;
      const entry: LatestPersistedBitableRecordFileIndexEntry = {
        ...(candidate.appToken ? { appToken: candidate.appToken } : {}),
        cachePath,
        expiresAt: candidate.expiresAt,
        fetchedAt: candidate.fetchedAt,
        tableId: candidate.tableId,
      };
      for (const query of createLatestPersistedBitableRecordQueryVariants(
        candidate,
      )) {
        const current = scanned.get(query.key);
        if (!current || current.fetchedAt <= entry.fetchedAt) {
          scanned.set(query.key, entry);
        }
      }
    } catch {
      // Ignore unrelated or partially written cache files while scanning.
    }
  }
  return scanned;
}

async function ensureLatestPersistedBitableRecordFileIndex(): Promise<void> {
  if (latestPersistedBitableRecordFileIndexReady) return;

  let scan = latestPersistedBitableRecordFileIndexScan;
  if (!scan) {
    const generation = latestPersistedBitableRecordIndexGeneration;
    let createdScan: Promise<boolean | null>;
    createdScan = scanLatestPersistedBitableRecordFiles()
      .then((scanned) => {
        if (generation !== latestPersistedBitableRecordIndexGeneration) {
          return false;
        }
        for (const [key, entry] of scanned) {
          setLatestPersistedBitableRecordFileIndexEntry(key, entry);
        }
        latestPersistedBitableRecordFileIndexReady = true;
        return true;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        localCacheLogger.warn(`Scan Feishu local cache failed: ${message}`);
        return null;
      })
      .finally(() => {
        if (latestPersistedBitableRecordFileIndexScan === createdScan) {
          latestPersistedBitableRecordFileIndexScan = null;
        }
      });
    latestPersistedBitableRecordFileIndexScan = createdScan;
    scan = createdScan;
  }

  const result = await scan;
  if (result === false && !latestPersistedBitableRecordFileIndexReady) {
    await ensureLatestPersistedBitableRecordFileIndex();
  }
}

export async function warmLatestPersistedBitableRecordSnapshotIndex(): Promise<void> {
  await ensureLatestPersistedBitableRecordFileIndex();
}

async function readIndexedPersistedBitableRecordSnapshot(
  query: NormalizedLatestPersistedBitableRecordQuery,
): Promise<PersistedBitableRecordSnapshot | null> {
  const file = latestPersistedBitableRecordFileIndex.get(query.key);
  const cached = latestPersistedBitableRecordSnapshotIndex.get(query.key);
  if (
    cached &&
    (!file ||
      (cached.file.cachePath === file.cachePath &&
        cached.file.fetchedAt >= file.fetchedAt))
  ) {
    return cached.snapshot;
  }
  if (!file) return cached?.snapshot ?? null;

  const activeRead = latestPersistedBitableRecordReadInFlight.get(query.key);
  if (activeRead) return activeRead.promise;

  const generation = latestPersistedBitableRecordIndexGeneration;
  let readRequest: Promise<PersistedBitableRecordSnapshot | null>;
  readRequest = (async () => {
    try {
      const raw = await readFile(file.cachePath, 'utf8');
      const candidate = parsePersistedBitableRecordCache(raw);
      if (!candidate) return cached?.snapshot ?? null;
      if (
        !(await isPersistedBitableRecordCacheCurrent(file.cachePath, candidate))
      ) {
        return null;
      }
      if (query.appToken && candidate.appToken?.trim() !== query.appToken) {
        return cached?.snapshot ?? null;
      }
      const candidateQuery = normalizeLatestPersistedBitableRecordQuery({
        ...candidate,
        appToken: query.appToken ? candidate.appToken : undefined,
      });
      if (candidateQuery.key !== query.key) return cached?.snapshot ?? null;

      const snapshot: PersistedBitableRecordSnapshot = {
        records: candidate.records,
        sourceStartedAt: candidate.sourceStartedAt,
        fetchedAt: candidate.fetchedAt,
        expiresAt: candidate.expiresAt,
      };
      const currentFile = latestPersistedBitableRecordFileIndex.get(query.key);
      if (
        generation === latestPersistedBitableRecordIndexGeneration &&
        currentFile?.cachePath === file.cachePath &&
        currentFile.fetchedAt <= candidate.fetchedAt
      ) {
        latestPersistedBitableRecordSnapshotIndex.set(query.key, {
          file,
          snapshot,
        });
      }
      return snapshot;
    } catch (error: unknown) {
      if ((error as { code?: string })?.code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        localCacheLogger.warn(`Read Feishu local cache failed: ${message}`);
      }
      return cached?.snapshot ?? null;
    }
  })().finally(() => {
    if (
      latestPersistedBitableRecordReadInFlight.get(query.key)?.promise ===
      readRequest
    ) {
      latestPersistedBitableRecordReadInFlight.delete(query.key);
    }
  });
  latestPersistedBitableRecordReadInFlight.set(query.key, {
    generation,
    promise: readRequest,
    tableId: query.tableId,
  });
  return readRequest;
}

export async function readLatestPersistedBitableRecordSnapshot(
  options: ReadLatestPersistedBitableRecordsOptions,
): Promise<PersistedBitableRecordSnapshot | null> {
  const query = normalizeLatestPersistedBitableRecordQuery(options);
  if (options.directOnly) {
    if (!query.appToken) return null;
    const base = `${query.appToken}:${query.tableId}:${query.viewId || ''}${query.automaticFields ? ':automatic-fields' : ''}`;
    const projection = query.fieldNames.length
      ? `${base}:${query.fieldNames.join('\u001f')}`
      : base;
    const key = query.querySignature
      ? `${projection}:query:${query.querySignature}`
      : projection;
    const candidate = await readPersistedBitableRecordCache(key, {
      appToken: query.appToken,
      tableId: query.tableId,
    }, true);
    if (!candidate || normalizeLatestPersistedBitableRecordQuery(candidate).key !== query.key)
      return null;
    return {
      records: candidate.records,
      sourceStartedAt: candidate.sourceStartedAt,
      fetchedAt: candidate.fetchedAt,
      expiresAt: candidate.expiresAt,
      contentFingerprint: candidate.contentFingerprint,
    };
  }
  await ensureLatestPersistedBitableRecordFileIndex();
  return readIndexedPersistedBitableRecordSnapshot(query);
}

export async function readLatestPersistedBitableRecords(
  options: ReadLatestPersistedBitableRecordsOptions,
): Promise<BitableRecordItem[] | null> {
  const snapshot = await readLatestPersistedBitableRecordSnapshot(options);
  return snapshot?.records ?? null;
}

function parsePersistedBitableRecordCache(
  raw: string,
): PersistedBitableRecordCache | null {
  const parsed = JSON.parse(raw) as Partial<PersistedBitableRecordCache>;
  if (
    parsed.version !== 1 ||
    typeof parsed.tableName !== 'string' ||
    typeof parsed.tableId !== 'string' ||
    (parsed.appToken !== undefined && typeof parsed.appToken !== 'string') ||
    (parsed.invalidationToken !== undefined &&
      typeof parsed.invalidationToken !== 'string') ||
    (parsed.viewId !== undefined && typeof parsed.viewId !== 'string') ||
    (parsed.automaticFields !== undefined &&
      typeof parsed.automaticFields !== 'boolean') ||
    (parsed.fieldNames !== undefined &&
      (!Array.isArray(parsed.fieldNames) ||
        parsed.fieldNames.some(
          (fieldName) => typeof fieldName !== 'string',
        ))) ||
    !Array.isArray(parsed.records) ||
    typeof parsed.fetchedAt !== 'number' ||
    typeof parsed.expiresAt !== 'number'
  ) {
    return null;
  }
  const viewId = normalizeBitableViewId(parsed.viewId);
  const fieldNames = normalizeBitableFieldNames(parsed.fieldNames);
  let filter: BitableRecordSearchFilter | undefined;
  let sort: BitableRecordSearchSort[];
  try {
    filter = normalizeBitableRecordSearchFilter(parsed.filter);
    sort = normalizeBitableRecordSearchSort(parsed.sort);
  } catch {
    return null;
  }
  return {
    version: 1,
    ...(parsed.appToken !== undefined ? { appToken: parsed.appToken } : {}),
    ...(parsed.invalidationToken !== undefined
      ? { invalidationToken: parsed.invalidationToken }
      : {}),
    tableName: parsed.tableName,
    tableId: parsed.tableId,
    ...(viewId ? { viewId } : {}),
    ...(parsed.automaticFields === true ? { automaticFields: true } : {}),
    ...(fieldNames.length > 0 ? { fieldNames } : {}),
    ...(filter ? { filter } : {}),
    ...(sort.length > 0 ? { sort } : {}),
    fetchedAt: parsed.fetchedAt,
    ...(typeof parsed.sourceStartedAt === 'number' && Number.isFinite(parsed.sourceStartedAt) ? { sourceStartedAt: parsed.sourceStartedAt } : {}),
    expiresAt: parsed.expiresAt,
    recordCount:
      typeof parsed.recordCount === 'number'
        ? parsed.recordCount
        : parsed.records.length,
    records: parsed.records,
  };
}

async function isPersistedBitableRecordCacheCurrent(
  cachePath: string,
  persisted: PersistedBitableRecordCache,
): Promise<boolean> {
  if (!persisted.appToken) return true;
  const scopeKey = getPersistedBitableRecordScopeKey(
    persisted.appToken,
    persisted.tableId,
  );
  const expectedInvalidationToken =
    await readPersistedBitableRecordScopeInvalidationToken(scopeKey);
  if (
    expectedInvalidationToken &&
    persisted.invalidationToken !== expectedInvalidationToken
  ) {
    queuePersistedBitableRecordCacheDeletion(cachePath);
    return false;
  }
  return true;
}

function updateLatestPersistedBitableRecordIndexAfterWrite(
  cachePath: string,
  payload: PersistedBitableRecordCache,
): void {
  const file: LatestPersistedBitableRecordFileIndexEntry = {
    ...(payload.appToken ? { appToken: payload.appToken } : {}),
    cachePath,
    expiresAt: payload.expiresAt,
    fetchedAt: payload.fetchedAt,
    tableId: payload.tableId,
  };
  for (const query of createLatestPersistedBitableRecordQueryVariants(
    payload,
  )) {
    if (!setLatestPersistedBitableRecordFileIndexEntry(query.key, file)) {
      continue;
    }

    const cached = latestPersistedBitableRecordSnapshotIndex.get(query.key);
    if (cached && cached.snapshot.fetchedAt <= payload.fetchedAt) {
      latestPersistedBitableRecordSnapshotIndex.set(query.key, {
        file,
        snapshot: {
          records: payload.records,
          sourceStartedAt: payload.sourceStartedAt,
          fetchedAt: payload.fetchedAt,
          expiresAt: payload.expiresAt,
        },
      });
    }
  }
}

async function writePersistedBitableRecordCache(
  cacheKey: string,
  options: FetchBitableRecordsOptions,
  records: BitableRecordItem[],
  fetchedAt: number,
  expiresAt: number,
  sourceStartedAt = fetchedAt,
): Promise<void> {
  let cacheFile = '';
  let writeRequest: Promise<void> | null = null;
  try {
    const scopeKey = getPersistedBitableRecordScopeKey(
      options.appToken,
      options.tableId,
    );
    await waitForPersistedBitableRecordScopeInvalidationWrite(scopeKey);
    const invalidationToken =
      await readPersistedBitableRecordScopeInvalidationToken(scopeKey);
    cacheFile = getPersistedCachePath(cacheKey);
    const viewId = normalizeBitableViewId(options.viewId);
    const fieldNames = normalizeBitableFieldNames(options.fieldNames);
    const filter = normalizeBitableRecordSearchFilter(options.filter);
    const sort = normalizeBitableRecordSearchSort(options.sort);
    const payload: PersistedBitableRecordCache = {
      version: 1,
      appToken: options.appToken,
      ...(invalidationToken ? { invalidationToken } : {}),
      tableName: options.tableName,
      tableId: options.tableId,
      ...(viewId ? { viewId } : {}),
      ...(options.automaticFields ? { automaticFields: true } : {}),
      ...(fieldNames.length > 0 ? { fieldNames } : {}),
      ...(filter ? { filter } : {}),
      ...(sort.length > 0 ? { sort } : {}),
      fetchedAt,
      sourceStartedAt,
      expiresAt,
      recordCount: records.length,
      records,
    };
    const previousWrite = persistedBitableRecordWriteTails.get(cacheFile);
    writeRequest = (previousWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await mkdir(LOCAL_CACHE_DIR, { recursive: true });
        const tempFile = `${cacheFile}.${process.pid}.tmp`;
        const bytes = JSON.stringify(payload);
        await writeFile(tempFile, bytes, 'utf8');
        await rename(tempFile, cacheFile);
        if (options.requirePersisted && await readFile(cacheFile, 'utf8') !== bytes) throw new Error('LOCAL_SYNC_SNAPSHOT_NOT_PERSISTED');
        const currentInvalidationToken =
          persistedBitableRecordScopeInvalidationTokens.get(scopeKey) ?? null;
        if (currentInvalidationToken !== invalidationToken) {
          await rm(cacheFile, { force: true });
          if (options.requirePersisted) throw new Error('LOCAL_SYNC_SNAPSHOT_INVALIDATED');
          return;
        }
        persistedBitableRecordFileInvalidationTokens.set(
          cacheFile,
          invalidationToken,
        );
        updateLatestPersistedBitableRecordIndexAfterWrite(cacheFile, payload);
        options.onPersisted?.({ fetchedAt, sourceStartedAt, invalidationToken });
      });
    persistedBitableRecordWriteTails.set(cacheFile, writeRequest);
    await writeRequest;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    localCacheLogger.warn(
      `Write Feishu local cache failed for ${options.tableName}: ${message}`,
    );
    if (options.requirePersisted) throw new Error('本地数据缓存保存失败，请稍后重试');
  } finally {
    if (
      cacheFile &&
      writeRequest &&
      persistedBitableRecordWriteTails.get(cacheFile) === writeRequest
    ) {
      persistedBitableRecordWriteTails.delete(cacheFile);
    }
  }
}

function getPersistedCachePath(cacheKey: string): string {
  const fileName = createHash('sha1').update(cacheKey).digest('hex');
  return join(LOCAL_CACHE_DIR, `${fileName}.json`);
}

function getPositiveIntegerEnv(name: string): number | null {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getAxiosErrorData(error: unknown): { status?: number; code?: number } {
  const typedError = error as {
    feishuCode?: number;
    status?: number;
    response?: { status?: number; data?: { code?: number } };
  };
  const response = typedError?.response;
  return {
    status: response?.status ?? typedError?.status,
    code: response?.data?.code ?? typedError?.feishuCode,
  };
}

export function getRecordId(record: BitableRecordItem): string {
  return record.record_id || record.id || '';
}

export function pickField(
  fields: Record<string, unknown>,
  names: string[],
): unknown {
  for (const name of names) {
    const value = fields[name];
    if (isPresent(value)) {
      return value;
    }
  }
  return undefined;
}

export function extractDisplayText(field: unknown, separator = '、'): string {
  return extractDisplayValues(field).join(separator);
}

export function extractDisplayValues(field: unknown): string[] {
  return dedupe(extractDisplayValuesInner(field));
}

export function extractNumberValue(field: unknown): number | null {
  if (typeof field === 'number' && Number.isFinite(field)) {
    return field;
  }

  const text = extractDisplayText(field, '');
  if (!text) {
    return null;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractDateValue(field: unknown): string | null {
  if (!isPresent(field)) {
    return null;
  }

  if (Array.isArray(field)) {
    for (const item of field) {
      const parsed = extractDateValue(item);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  if (typeof field === 'number') {
    return formatLocalDate(new Date(field));
  }

  if (typeof field === 'string') {
    const text = field.trim();
    if (!text) {
      return null;
    }
    if (/^\d{13}$/.test(text)) {
      return formatLocalDate(new Date(Number(text)));
    }
    if (/^\d{10}$/.test(text)) {
      return formatLocalDate(new Date(Number(text) * 1000));
    }
    const normalizedText = text.replace(/\//g, '-');
    const date = new Date(normalizedText);
    if (!Number.isNaN(date.getTime())) {
      return formatLocalDate(date);
    }
    return /^\d{4}-\d{1,2}-\d{1,2}$/.test(normalizedText)
      ? normalizeDateParts(normalizedText)
      : null;
  }

  if (typeof field === 'object' && field !== null) {
    const obj = field as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'text', 'value']) {
      const parsed = extractDateValue(obj[key]);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

export function extractDateTimeIso(field: unknown): string | null {
  if (!isPresent(field)) {
    return null;
  }
  if (typeof field === 'number') {
    const timestamp = Math.abs(field) < 100_000_000_000 ? field * 1000 : field;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof field === 'string') {
    const text = field.trim();
    if (!text) {
      return null;
    }
    if (/^\d{13}$/.test(text)) {
      return new Date(Number(text)).toISOString();
    }
    if (/^\d{10}$/.test(text)) {
      return new Date(Number(text) * 1000).toISOString();
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof field === 'object' && field !== null) {
    const obj = field as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'text', 'value']) {
      const parsed = extractDateTimeIso(obj[key]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

export function normalizeBuildingForFrontend(
  value: string | null | undefined,
): string {
  const text = String(value || '')
    .trim()
    .toUpperCase();
  if (text.includes('110')) return 'station_110';
  if (
    text.includes('APP_A') ||
    text === 'A' ||
    text.includes('A楼') ||
    text.includes('A栋')
  )
    return 'building_a';
  if (
    text.includes('APP_B') ||
    text === 'B' ||
    text.includes('B楼') ||
    text.includes('B栋')
  )
    return 'building_b';
  if (
    text.includes('APP_C') ||
    text === 'C' ||
    text.includes('C楼') ||
    text.includes('C栋')
  )
    return 'building_c';
  if (
    text.includes('APP_D') ||
    text === 'D' ||
    text.includes('D楼') ||
    text.includes('D栋')
  )
    return 'building_d';
  if (
    text.includes('APP_E') ||
    text === 'E' ||
    text.includes('E楼') ||
    text.includes('E栋')
  )
    return 'building_e';
  if (
    text.includes('APP_H') ||
    text === 'H' ||
    text.includes('H楼') ||
    text.includes('H栋')
  )
    return 'building_h';
  if (text.includes('A_BUILDING') || text.includes('BUILDING_A'))
    return 'building_a';
  if (text.includes('B_BUILDING') || text.includes('BUILDING_B'))
    return 'building_b';
  if (text.includes('C_BUILDING') || text.includes('BUILDING_C'))
    return 'building_c';
  if (text.includes('D_BUILDING') || text.includes('BUILDING_D'))
    return 'building_d';
  if (text.includes('E_BUILDING') || text.includes('BUILDING_E'))
    return 'building_e';
  if (text.includes('H_BUILDING') || text.includes('BUILDING_H'))
    return 'building_h';
  return value || '';
}

export function normalizeBuildingLabel(
  value: string | null | undefined,
): string {
  const frontendKey = normalizeBuildingForFrontend(value);
  const labels: Record<string, string> = {
    building_a: 'A栋',
    building_b: 'B栋',
    building_c: 'C栋',
    building_d: 'D栋',
    building_e: 'E栋',
    building_h: 'H栋',
    station_110: '110站',
  };
  return labels[frontendKey] || String(value || '');
}

export function normalizeTeamForFrontend(
  value: string | null | undefined,
): string {
  const text = String(value || '')
    .trim()
    .toUpperCase();
  if (text.includes('LONG') || text.includes('长')) return 'long_white';
  if (text.includes('SHIFT_A') || text === 'A' || text.includes('A班'))
    return 'shift_a';
  if (text.includes('SHIFT_B') || text === 'B' || text.includes('B班'))
    return 'shift_b';
  if (text.includes('SHIFT_C') || text === 'C' || text.includes('C班'))
    return 'shift_c';
  if (text.includes('SHIFT_D') || text === 'D' || text.includes('D班'))
    return 'shift_d';
  return value || '';
}

export function normalizeShiftForFrontend(
  value: string | null | undefined,
): string {
  const text = String(value || '')
    .trim()
    .toUpperCase();
  if (text.includes('NIGHT') || text.includes('夜')) return 'night';
  if (text.includes('LONG') || text.includes('长')) return 'long_white';
  if (text.includes('WHITE') || text.includes('DAY') || text.includes('白'))
    return 'white';
  return value || '';
}

export function splitDisplayText(value: string): string[] {
  const cleaned = cleanDisplayString(value);
  if (!cleaned) {
    return [];
  }
  return cleaned
    .split(SPLIT_TEXT_PATTERN)
    .map(cleanDisplayString)
    .filter(Boolean);
}

function extractDisplayValuesInner(field: unknown): string[] {
  if (!isPresent(field)) {
    return [];
  }

  if (Array.isArray(field)) {
    return field.flatMap(extractDisplayValuesInner);
  }

  if (typeof field === 'string') {
    return splitDisplayText(field);
  }

  if (typeof field === 'number' || typeof field === 'boolean') {
    return [String(field)];
  }

  if (typeof field === 'object' && field !== null) {
    const obj = field as Record<string, unknown>;
    if (isPresent(obj.select)) {
      return extractDisplayValuesInner(obj.select);
    }
    if (Array.isArray(obj.users)) {
      return obj.users.flatMap(extractDisplayValuesInner);
    }
    for (const key of [
      'name',
      'text',
      'label',
      'user_name',
      'value',
      'title',
    ]) {
      if (isPresent(obj[key])) {
        return extractDisplayValuesInner(obj[key]);
      }
    }
  }

  return [];
}

function cleanDisplayString(value: string): string {
  return value
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .trim();
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function formatLocalDate(date: Date): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = SHANGHAI_LOCAL_DATE_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const year = values.year;
  const month = values.month;
  const day = values.day;
  if (!year || !month || !day) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

function normalizeDateParts(value: string): string {
  const [year, month, day] = value.split('-');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
