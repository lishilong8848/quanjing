import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  getFeishuAuthPayload,
  readEnv,
} from '@server/common/config/external-services.config';
import {
  extractDisplayText,
  fetchBitableRecords,
  getRecordId,
  invalidateBitableRecordCache,
  pickField,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '@server/common/feishu/bitable-direct-read';
import type { ActivePersonnelDirectoryEntry } from '@server/modules/bitable-sync/active-personnel-directory';
import { BitableSyncService } from '@server/modules/bitable-sync/bitable-sync.service';
import type {
  EmergencyDutyOptionsResponse,
  EmergencyDutyPerson,
  EmergencyDutySchedule,
  EmergencyDutyScheduleResponse,
  EmergencyDutySyncStatus,
  EmergencyDutyUpsertRequest,
  EmergencyDutyUpsertResponse,
} from '@shared/emergency-duty.interface';

export const DEFAULT_EMERGENCY_DUTY_WIKI_TOKEN = 'G7oUwGdwaiTmimk8i2ecGTWOn4d';
export const DEFAULT_EMERGENCY_DUTY_TABLE_ID = 'tbldaccbff3eb177';
export const DEFAULT_EMERGENCY_DUTY_VIEW_ID = 'vewgzik2Nv';
export const DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS = 15 * 60 * 1000;

const MIN_EMERGENCY_DUTY_CACHE_REFRESH_MS = 60_000;
const MAX_NODE_TIMER_MS = 2_147_483_647;
const EMERGENCY_DUTY_TABLE_NAME = '应急值班';
const EMERGENCY_DUTY_FIELD_NAMES = [
  '值守机楼',
  '值班人员',
  '排班日期',
] as const;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const PERSON_KEY_PREFIX = 'emergency_person_';
const UNKNOWN_PERSON_KEY_PREFIX = 'emergency_history_';
const MAX_MUTATION_ID_LENGTH = 200;
const MUTATION_RESULT_TTL_MS = 15 * 60 * 1000;

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface ResolvedUpsertRequest {
  date: string;
  personKeys: string[];
  clientMutationId: string;
}

interface ResolvedPersonSelection {
  people: EmergencyDutyPerson[];
  openIds: string[];
}

interface InFlightMutation {
  fingerprint: string;
  promise: Promise<EmergencyDutyUpsertResponse>;
}

interface CompletedMutation {
  expiresAt: number;
  fingerprint: string;
  response: EmergencyDutyUpsertResponse;
}

interface MappedScheduleCandidate {
  lastModifiedTime: number;
  schedule: EmergencyDutySchedule;
}

@Injectable()
export class EmergencyDutyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmergencyDutyService.name);
  private readonly configuredAppToken = readEnv(
    'FEISHU_EMERGENCY_DUTY_APP_TOKEN',
  );
  private readonly wikiToken =
    readEnv('FEISHU_EMERGENCY_DUTY_WIKI_TOKEN') ||
    DEFAULT_EMERGENCY_DUTY_WIKI_TOKEN;
  private readonly tableId =
    readEnv('FEISHU_EMERGENCY_DUTY_TABLE_ID') ||
    DEFAULT_EMERGENCY_DUTY_TABLE_ID;
  private readonly viewId =
    readEnv('FEISHU_EMERGENCY_DUTY_VIEW_ID') || DEFAULT_EMERGENCY_DUTY_VIEW_ID;
  private readonly cacheRefreshMs = readPositiveInteger(
    'FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS',
    DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS,
  );
  private readonly cacheTtlMs = this.cacheRefreshMs * 2;
  private readonly inFlightMutations = new Map<string, InFlightMutation>();
  private readonly completedMutations = new Map<string, CompletedMutation>();
  private tableMutationTail: Promise<void> = Promise.resolve();
  private appTokenPromise: Promise<string> | null = null;
  private tokenState: TenantTokenState | null = null;
  private tokenPromise: Promise<string> | null = null;
  private refreshPromise: Promise<BitableRecordItem[]> | null = null;
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly httpService: HttpService,
    private readonly bitableSyncService: BitableSyncService,
  ) {}

  onModuleInit(): void {
    if (this.refreshTimer) return;
    this.triggerCacheRefresh('应急值班本地快照启动刷新失败');
    this.refreshTimer = setInterval(() => {
      this.triggerCacheRefresh('应急值班本地快照周期刷新失败');
    }, this.cacheRefreshMs);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  async getSchedules(
    startDate?: unknown,
    endDate?: unknown,
  ): Promise<EmergencyDutyScheduleResponse> {
    const normalizedStartDate = normalizeOptionalDate(startDate, '开始日期');
    const normalizedEndDate = normalizeOptionalDate(endDate, '结束日期');
    if (
      normalizedStartDate &&
      normalizedEndDate &&
      normalizedStartDate > normalizedEndDate
    ) {
      throw new BadRequestException('开始日期不能晚于结束日期');
    }

    const snapshot = await readLatestPersistedBitableRecordSnapshot(
      this.localSnapshotOptions(),
    );
    if (!snapshot) {
      throw new ServiceUnavailableException(
        '应急值班本地快照暂不可用，请等待后台同步',
      );
    }

    let activePersonnel: ActivePersonnelDirectoryEntry[] = [];
    try {
      activePersonnel = (
        await this.bitableSyncService.getCachedActivePersonnelDirectory()
      ).personnel;
    } catch (error: unknown) {
      this.logger.warn(
        `应急值班人员目录快照不可用，使用历史人员匿名标识：${safeErrorSummary(error)}`,
      );
    }
    const schedules = this.mapSchedules(
      snapshot.records,
      activePersonnel,
      normalizedStartDate,
      normalizedEndDate,
    );
    const stale = snapshot.expiresAt <= Date.now();
    if (stale) {
      this.triggerCacheRefresh('应急值班过期快照后台刷新失败');
    }

    return {
      schedules,
      snapshot: {
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        expiresAt: new Date(snapshot.expiresAt).toISOString(),
        stale,
      },
    };
  }

  async getOptions(): Promise<EmergencyDutyOptionsResponse> {
    const directory =
      await this.bitableSyncService.getCachedActivePersonnelDirectory();
    const seenKeys = new Set<string>();
    const options = directory.personnel.flatMap((person) => {
      const name = person.name.trim();
      const openId = person.openId.trim();
      if (!name || !openId) return [];
      const key = opaquePersonKey(person);
      if (seenKeys.has(key)) return [];
      seenKeys.add(key);
      return [
        {
          key,
          name,
          role: activePersonnelRole(person),
        },
      ];
    });
    return { options };
  }

  async upsertSchedule(
    request: EmergencyDutyUpsertRequest,
  ): Promise<EmergencyDutyUpsertResponse> {
    const normalized = await emergencyDutyPreWriteStep(
      () => Promise.resolve(validateUpsertRequest(request)),
      '应急值班请求校验失败，本次未写入',
    );
    const fingerprint = mutationFingerprint(normalized);
    this.pruneCompletedMutations();

    const completed = this.completedMutations.get(normalized.clientMutationId);
    if (completed) {
      this.assertMatchingMutationFingerprint(
        normalized.clientMutationId,
        completed.fingerprint,
        fingerprint,
      );
      return completed.response;
    }
    const inFlight = this.inFlightMutations.get(normalized.clientMutationId);
    if (inFlight) {
      this.assertMatchingMutationFingerprint(
        normalized.clientMutationId,
        inFlight.fingerprint,
        fingerprint,
      );
      return inFlight.promise;
    }

    const promise = this.enqueueTableMutation(() =>
      this.performUpsert(normalized),
    );
    this.inFlightMutations.set(normalized.clientMutationId, {
      fingerprint,
      promise,
    });
    void promise
      .then((response) => {
        this.completedMutations.set(normalized.clientMutationId, {
          expiresAt: Date.now() + MUTATION_RESULT_TTL_MS,
          fingerprint,
          response,
        });
      })
      .finally(() => {
        if (
          this.inFlightMutations.get(normalized.clientMutationId)?.promise ===
          promise
        ) {
          this.inFlightMutations.delete(normalized.clientMutationId);
        }
      })
      .catch(() => undefined);
    return promise;
  }

  async refreshCache(): Promise<BitableRecordItem[]> {
    if (this.refreshPromise) return this.refreshPromise;
    const promise = this.fetchRemoteSnapshot().finally(() => {
      if (this.refreshPromise === promise) {
        this.refreshPromise = null;
      }
    });
    this.refreshPromise = promise;
    return promise;
  }

  private triggerCacheRefresh(failureMessage: string): void {
    if (this.refreshPromise) return;
    void this.refreshCache().catch((error: unknown) => {
      this.logger.warn(`${failureMessage}：${safeErrorSummary(error)}`);
    });
  }

  private async performUpsert(
    request: ResolvedUpsertRequest,
  ): Promise<EmergencyDutyUpsertResponse> {
    const personnel = await emergencyDutyPreWriteStep(
      () => this.resolveSelectedPersonnel(request.personKeys),
      '应急值班在职人员缓存暂不可用，本次未写入',
    );
    const appToken = await emergencyDutyPreWriteStep(
      () => this.getAppToken(),
      '应急值班多维表暂不可用，本次未写入',
    );
    const records = await emergencyDutyPreWriteStep(
      () => this.fetchRemoteSnapshot(appToken),
      '应急值班远端记录读取失败，本次未写入',
    );
    const matches = records.filter(
      (record) =>
        extractDateKey(pickField(record.fields ?? {}, ['排班日期'])) ===
        request.date,
    );
    if (matches.length > 1) {
      throw emergencyDutyConflict(
        `${request.date} 存在 ${matches.length} 条应急值班记录，请先清理重复数据`,
      );
    }

    const existingRecordId = matches[0] ? getRecordId(matches[0]) : '';
    const canonicalExistingRecord = existingRecordId
      ? findCanonicalScheduleRecord(
          records,
          existingRecordId,
          request.date,
          personnel.openIds,
        )
      : null;
    if (canonicalExistingRecord) {
      return this.buildUpsertResponse(
        request,
        personnel,
        existingRecordId,
        await this.confirmPersistedRecord(
          existingRecordId,
          request.date,
          personnel.openIds,
        ),
      );
    }

    const fields: Record<string, unknown> = {
      排班日期: shanghaiMidnightTimestamp(request.date),
      值班人员: personnel.openIds.map((id) => ({ id })),
    };
    if (existingRecordId) {
      fields.值守机楼 = null;
    }
    const tenantAccessToken = await emergencyDutyPreWriteStep(
      () => this.getTenantAccessToken(),
      '飞书访问令牌暂不可用，本次应急值班未写入',
    );
    const clientToken = toFeishuClientToken(request.clientMutationId);
    let response;
    try {
      response = existingRecordId
        ? await this.httpService.axiosRef.put(
            `${this.recordsUrl(appToken)}/${encodeURIComponent(existingRecordId)}`,
            { fields },
            this.writeRequestConfig(tenantAccessToken, clientToken),
          )
        : await this.httpService.axiosRef.post(
            this.recordsUrl(appToken),
            { fields },
            this.writeRequestConfig(tenantAccessToken, clientToken),
          );
    } catch (error: unknown) {
      if (
        !isBitableWriteAcceptedPending(error) &&
        !isAmbiguousBitableWriteFailure(error)
      ) {
        throw sanitizedBitableWriteException(error);
      }
      return this.reconcileAmbiguousWrite(
        request,
        personnel,
        appToken,
        existingRecordId,
      );
    }
    if (hasBitableCode(response.data, '1255006')) {
      return this.reconcileAmbiguousWrite(
        request,
        personnel,
        appToken,
        existingRecordId,
      );
    }
    assertFeishuSuccess(
      response.data,
      '写入应急值班记录',
      'definitely-not-written',
    );
    const returnedRecord = asRecord(response.data?.data)?.record;
    const returnedRecordId =
      existingRecordId || getRecordId(asBitableRecord(returnedRecord));
    if (!returnedRecordId) {
      return this.reconcileAmbiguousWrite(
        request,
        personnel,
        appToken,
        existingRecordId,
      );
    }

    invalidateBitableRecordCache({ appToken, tableId: this.tableId });
    return this.buildUpsertResponse(
      request,
      personnel,
      returnedRecordId,
      await this.confirmAcceptedWrite(
        appToken,
        returnedRecordId,
        request.date,
        personnel.openIds,
      ),
    );
  }

  private async reconcileAmbiguousWrite(
    request: ResolvedUpsertRequest,
    personnel: ResolvedPersonSelection,
    appToken: string,
    existingRecordId: string,
  ): Promise<EmergencyDutyUpsertResponse> {
    invalidateBitableRecordCache({ appToken, tableId: this.tableId });
    let refreshedRecords: BitableRecordItem[];
    try {
      refreshedRecords = await this.fetchRemoteSnapshot(appToken);
    } catch (error: unknown) {
      this.logger.warn(
        `应急值班模糊写入强制回读失败：${safeErrorSummary(error)}`,
      );
      throw emergencyDutyUnknownWriteResult();
    }
    const confirmedRecord = findCanonicalScheduleRecord(
      refreshedRecords,
      existingRecordId || undefined,
      request.date,
      personnel.openIds,
    );
    if (!confirmedRecord) {
      this.logger.warn('应急值班模糊写入强制回读未确认本次记录');
      throw emergencyDutyUnknownWriteResult();
    }
    const confirmedRecordId = getRecordId(confirmedRecord);
    if (!confirmedRecordId) {
      throw emergencyDutyUnknownWriteResult();
    }
    return this.buildUpsertResponse(
      request,
      personnel,
      confirmedRecordId,
      await this.confirmPersistedRecord(
        confirmedRecordId,
        request.date,
        personnel.openIds,
      ),
    );
  }

  private async confirmAcceptedWrite(
    appToken: string,
    recordId: string,
    date: string,
    openIds: string[],
  ): Promise<EmergencyDutySyncStatus> {
    try {
      const refreshedRecords = await this.fetchRemoteSnapshot(appToken);
      if (
        findCanonicalScheduleRecord(refreshedRecords, recordId, date, openIds)
      ) {
        return this.confirmPersistedRecord(recordId, date, openIds);
      }
      this.logger.warn('应急值班已写入飞书，但强刷结果未确认本次记录');
    } catch (error: unknown) {
      this.logger.warn(
        `应急值班已写入飞书，但本地快照强刷失败：${safeErrorSummary(error)}`,
      );
    }
    return 'cache_refresh_pending';
  }

  private async confirmPersistedRecord(
    recordId: string,
    date: string,
    openIds: string[],
  ): Promise<EmergencyDutySyncStatus> {
    try {
      const persistedSnapshot = await readLatestPersistedBitableRecordSnapshot(
        this.localSnapshotOptions(),
      );
      if (
        persistedSnapshot &&
        findCanonicalScheduleRecord(
          persistedSnapshot.records,
          recordId,
          date,
          openIds,
        )
      ) {
        return 'synced';
      }
      this.logger.warn('应急值班已写入飞书，但持久快照尚未确认本次记录');
    } catch (error: unknown) {
      this.logger.warn(`应急值班持久快照确认失败：${safeErrorSummary(error)}`);
    }
    return 'cache_refresh_pending';
  }

  private buildUpsertResponse(
    request: ResolvedUpsertRequest,
    personnel: ResolvedPersonSelection,
    recordId: string,
    syncStatus: EmergencyDutySyncStatus,
  ): EmergencyDutyUpsertResponse {
    return {
      record: {
        recordId,
        date: request.date,
        people: personnel.people,
        building: null,
      },
      syncStatus,
      clientMutationId: request.clientMutationId,
    };
  }

  private async resolveSelectedPersonnel(
    personKeys: string[],
  ): Promise<ResolvedPersonSelection> {
    const directory =
      await this.bitableSyncService.getCachedActivePersonnelDirectory();
    const activeByKey = new Map(
      directory.personnel.map((person) => [opaquePersonKey(person), person]),
    );
    const people: EmergencyDutyPerson[] = [];
    const openIds: string[] = [];
    for (const key of personKeys) {
      const person = activeByKey.get(key);
      if (!person?.openId.trim() || !person.name.trim()) {
        throw new BadRequestException(
          '所选值班人员已离职、已异动或不在当前在职目录中，请刷新后重选',
        );
      }
      people.push({
        key,
        name: person.name.trim(),
        role: activePersonnelRole(person),
      });
      openIds.push(person.openId.trim());
    }
    return { people, openIds };
  }

  private mapSchedules(
    records: BitableRecordItem[],
    activePersonnel: ActivePersonnelDirectoryEntry[],
    startDate?: string,
    endDate?: string,
  ): EmergencyDutySchedule[] {
    const activeByOpenId = new Map(
      activePersonnel.map((person) => [person.openId.trim(), person]),
    );
    const activeByName = new Map<string, ActivePersonnelDirectoryEntry>();
    for (const person of activePersonnel) {
      const name = person.name.trim();
      if (name && !activeByName.has(name)) activeByName.set(name, person);
    }
    const byDate = new Map<string, MappedScheduleCandidate>();

    for (const source of records) {
      const fields = source.fields ?? {};
      const date = extractDateKey(pickField(fields, ['排班日期']));
      if (
        !date ||
        (startDate && date < startDate) ||
        (endDate && date > endDate)
      ) {
        continue;
      }
      const recordId = getRecordId(source);
      if (!recordId) continue;
      const candidate: MappedScheduleCandidate = {
        lastModifiedTime: finiteTimestamp(source.last_modified_time),
        schedule: {
          recordId,
          date,
          people: mapSchedulePeople(
            pickField(fields, ['值班人员']),
            activeByOpenId,
            activeByName,
          ),
          building:
            extractDisplayText(pickField(fields, ['值守机楼']), ' ').trim() ||
            null,
        },
      };
      const current = byDate.get(date);
      if (
        !current ||
        candidate.lastModifiedTime > current.lastModifiedTime ||
        (candidate.lastModifiedTime === current.lastModifiedTime &&
          candidate.schedule.recordId > current.schedule.recordId)
      ) {
        byDate.set(date, candidate);
      }
    }
    return [...byDate.values()]
      .map((candidate) => candidate.schedule)
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.recordId.localeCompare(right.recordId),
      );
  }

  private localSnapshotOptions() {
    return {
      tableId: this.tableId,
      viewId: this.viewId,
      tableName: EMERGENCY_DUTY_TABLE_NAME,
      fieldNames: [...EMERGENCY_DUTY_FIELD_NAMES],
    };
  }

  private async fetchRemoteSnapshot(
    resolvedAppToken?: string,
  ): Promise<BitableRecordItem[]> {
    const appToken = resolvedAppToken || (await this.getAppToken());
    return fetchBitableRecords(this.httpService, {
      appToken,
      tableId: this.tableId,
      viewId: this.viewId,
      tableName: EMERGENCY_DUTY_TABLE_NAME,
      fieldNames: [...EMERGENCY_DUTY_FIELD_NAMES],
      cacheTtlMs: this.cacheTtlMs,
      forceRefresh: true,
      strict: true,
    });
  }

  private getAppToken(): Promise<string> {
    if (!this.appTokenPromise) {
      this.appTokenPromise = resolveBitableAppToken(this.httpService, {
        appToken: this.configuredAppToken || undefined,
        wikiToken: this.wikiToken,
        tableName: EMERGENCY_DUTY_TABLE_NAME,
      })
        .then((appToken) => {
          const normalized = appToken.trim();
          if (!normalized) {
            throw new ServiceUnavailableException(
              '应急值班多维表 app token 暂不可用',
            );
          }
          return normalized;
        })
        .catch((error) => {
          this.appTokenPromise = null;
          throw error;
        });
    }
    return this.appTokenPromise;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 60_000) {
      return this.tokenState.value;
    }
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.requestTenantAccessToken().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async requestTenantAccessToken(): Promise<string> {
    let response;
    try {
      response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        { timeout: 30_000 },
      );
    } catch {
      throw new ServiceUnavailableException('飞书访问令牌暂时不可用');
    }
    assertFeishuSuccess(response.data, '获取飞书访问令牌');
    const token = String(response.data?.tenant_access_token || '').trim();
    if (!token) {
      throw new BadGatewayException('获取飞书访问令牌失败：响应缺少 token');
    }
    const expireSeconds = Number(response.data?.expire) || 7200;
    this.tokenState = {
      value: token,
      expiresAt: Date.now() + expireSeconds * 1000,
    };
    return token;
  }

  private recordsUrl(appToken: string): string {
    return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(this.tableId)}/records`;
  }

  private writeRequestConfig(tenantAccessToken: string, clientToken?: string) {
    return {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      params: {
        ...(clientToken ? { client_token: clientToken } : {}),
        user_id_type: 'open_id',
      },
      timeout: 30_000,
    };
  }

  private enqueueTableMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tableMutationTail
      .catch(() => undefined)
      .then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tableMutationTail = tail;
    return result;
  }

  private assertMatchingMutationFingerprint(
    clientMutationId: string,
    previousFingerprint: string,
    currentFingerprint: string,
  ): void {
    if (previousFingerprint !== currentFingerprint) {
      throw emergencyDutyConflict(
        `clientMutationId ${clientMutationId} 已用于不同的应急值班请求`,
      );
    }
  }

  private pruneCompletedMutations(): void {
    const now = Date.now();
    for (const [mutationId, result] of this.completedMutations) {
      if (result.expiresAt <= now) this.completedMutations.delete(mutationId);
    }
  }
}

function validateUpsertRequest(
  request: EmergencyDutyUpsertRequest,
): ResolvedUpsertRequest {
  if (!request || typeof request !== 'object') {
    throw new BadRequestException('应急值班请求不能为空');
  }
  const date = normalizeRequiredDate(request.date, '排班日期');
  if (!Array.isArray(request.personKeys)) {
    throw new BadRequestException('值班人员必须为数组');
  }
  const personKeys = [
    ...new Set(
      request.personKeys.map((key) =>
        typeof key === 'string' ? key.trim() : '',
      ),
    ),
  ].filter(Boolean);
  if (personKeys.length === 0) {
    throw new BadRequestException('至少选择一名在职值班人员');
  }
  if (personKeys.length !== request.personKeys.length) {
    throw new BadRequestException('值班人员标识无效或重复');
  }
  const clientMutationId =
    typeof request.clientMutationId === 'string'
      ? request.clientMutationId.trim()
      : '';
  if (!clientMutationId || clientMutationId.length > MAX_MUTATION_ID_LENGTH) {
    throw new BadRequestException('clientMutationId 无效');
  }
  return { date, personKeys, clientMutationId };
}

function normalizeOptionalDate(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return normalizeRequiredDate(value, label);
}

function normalizeRequiredDate(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${label}必须使用 YYYY-MM-DD 格式`);
  }
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (
    !match ||
    !isValidDateParts(Number(match[1]), Number(match[2]), Number(match[3]))
  ) {
    throw new BadRequestException(`${label}必须使用有效的 YYYY-MM-DD 日期`);
  }
  return normalized;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function shanghaiMidnightTimestamp(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS;
}

function extractDateKey(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds =
      Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds + SHANGHAI_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    const dateMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(normalized);
    if (dateMatch) {
      const year = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const day = Number(dateMatch[3]);
      if (isValidDateParts(year, month, day)) {
        return `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
      }
    }
    const numeric = Number(normalized);
    if (Number.isFinite(numeric) && normalized) return extractDateKey(numeric);
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['value', 'timestamp', 'start_time']) {
      const nested = extractDateKey(record[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function mapSchedulePeople(
  field: unknown,
  activeByOpenId: Map<string, ActivePersonnelDirectoryEntry>,
  activeByName: Map<string, ActivePersonnelDirectoryEntry>,
): EmergencyDutyPerson[] {
  const rawUsers = extractUserValues(field);
  const seenKeys = new Set<string>();
  const people: EmergencyDutyPerson[] = [];
  for (const raw of rawUsers) {
    const active = raw.id
      ? activeByOpenId.get(raw.id)
      : raw.name
        ? activeByName.get(raw.name)
        : undefined;
    const name = active?.name.trim() || raw.name;
    if (!name) continue;
    const key = active
      ? opaquePersonKey(active)
      : `${UNKNOWN_PERSON_KEY_PREFIX}${hashOpaque(`${raw.id}\u0000${name}`)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    people.push({
      key,
      name,
      role: active ? activePersonnelRole(active) : '值班人员',
    });
  }
  return people;
}

function findCanonicalScheduleRecord(
  records: BitableRecordItem[],
  expectedRecordId: string | undefined,
  expectedDate: string,
  expectedOpenIds: string[],
): BitableRecordItem | null {
  const matchingDateRecords = records.filter(
    (record) =>
      extractDateKey(pickField(record.fields ?? {}, ['排班日期'])) ===
      expectedDate,
  );
  if (matchingDateRecords.length !== 1) return null;
  const record = matchingDateRecords[0];
  if (!getRecordId(record)) return null;
  if (expectedRecordId && getRecordId(record) !== expectedRecordId) {
    return null;
  }
  if (
    extractDisplayText(pickField(record.fields ?? {}, ['值守机楼']), ' ').trim()
  ) {
    return null;
  }
  const actualOpenIds = extractUserValues(
    pickField(record.fields ?? {}, ['值班人员']),
  )
    .map((person) => person.id)
    .filter(Boolean)
    .sort();
  const canonicalExpectedOpenIds = [...expectedOpenIds].sort();
  const matchesPeople =
    actualOpenIds.length === canonicalExpectedOpenIds.length &&
    actualOpenIds.every(
      (openId, index) => openId === canonicalExpectedOpenIds[index],
    );
  return matchesPeople ? record : null;
}

function extractUserValues(
  field: unknown,
): Array<{ id: string; name: string }> {
  const values: Array<{ id: string; name: string }> = [];
  collectUserValues(field, values);
  if (values.length === 0) {
    const text = extractDisplayText(field, ' ').trim();
    if (text) values.push({ id: '', name: text });
  }
  return values;
}

function collectUserValues(
  value: unknown,
  values: Array<{ id: string; name: string }>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUserValues(item, values));
    return;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized) {
      values.push(
        normalized.startsWith('ou_')
          ? { id: normalized, name: '' }
          : { id: '', name: normalized },
      );
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.users)) {
    record.users.forEach((item) => collectUserValues(item, values));
  }
  const id = ['id', 'open_id', 'openId', 'user_id']
    .map((key) => record[key])
    .find((candidate) => typeof candidate === 'string');
  const name = ['name', 'en_name', 'text']
    .map((key) => record[key])
    .find((candidate) => typeof candidate === 'string');
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (normalizedId || normalizedName) {
    values.push({ id: normalizedId, name: normalizedName });
  }
}

function opaquePersonKey(person: ActivePersonnelDirectoryEntry): string {
  return `${PERSON_KEY_PREFIX}${hashOpaque(`${person.recordId}\u0000${person.openId}`)}`;
}

function activePersonnelRole(person: ActivePersonnelDirectoryEntry): string {
  return person.position.trim() || person.systemPosition.trim() || '值班人员';
}

function hashOpaque(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function mutationFingerprint(request: ResolvedUpsertRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([request.date, request.personKeys]))
    .digest('hex');
}

function toFeishuClientToken(clientMutationId: string): string {
  const digest = createHash('sha256')
    .update(`emergency-duty-client-token:${clientMutationId}`)
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function finiteTimestamp(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readPositiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) &&
    parsed >= MIN_EMERGENCY_DUTY_CACHE_REFRESH_MS &&
    parsed <= MAX_NODE_TIMER_MS
    ? parsed
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function asBitableRecord(value: unknown): BitableRecordItem {
  return (asRecord(value) ?? {}) as BitableRecordItem;
}

function assertFeishuSuccess(
  data: unknown,
  stage: string,
  writeDisposition?: 'definitely-not-written',
): void {
  const payload = asRecord(data);
  if (payload?.code === 0) return;
  const code =
    typeof payload?.code === 'number' && Number.isFinite(payload.code)
      ? `（code: ${payload.code}）`
      : '';
  const message = `${stage}失败：飞书返回业务错误${code}`;
  throw writeDisposition
    ? emergencyDutyBadGateway(message)
    : new BadGatewayException(message);
}

function isBitableWriteAcceptedPending(error: unknown): boolean {
  return externalErrorRecords(error).some((record) => {
    const response = asRecord(record.response);
    return (
      hasBitableCode(record, '1255006') ||
      hasBitableCode(response?.data, '1255006') ||
      (typeof record.message === 'string' &&
        /(?:^|\D)1255006(?:\D|$)/u.test(record.message))
    );
  });
}

function hasBitableCode(value: unknown, expectedCode: string): boolean {
  return String(asRecord(value)?.code ?? '') === expectedCode;
}

function isAmbiguousBitableWriteFailure(error: unknown): boolean {
  const errorRecords = externalErrorRecords(error);
  const httpStatus = errorRecords
    .flatMap((record) => {
      const response = asRecord(record.response);
      return [response?.status, record.status, record.statusCode];
    })
    .find((value): value is number => typeof value === 'number');
  const ambiguousHttpStatuses = new Set([408, 409, 425, 429]);
  if (
    httpStatus !== undefined &&
    httpStatus >= 400 &&
    httpStatus <= 499 &&
    !ambiguousHttpStatuses.has(httpStatus)
  ) {
    return false;
  }
  if (
    httpStatus !== undefined &&
    (ambiguousHttpStatuses.has(httpStatus) || httpStatus >= 500)
  ) {
    return true;
  }
  const codes = errorRecords.flatMap((record) =>
    typeof record.code === 'string' ? [record.code] : [],
  );
  if (
    codes.some(
      (code) =>
        /^ECONN/i.test(code) ||
        /^(?:EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ERR_NETWORK|ENETDOWN|ENOTFOUND)$/i.test(
          code,
        ),
    )
  ) {
    return true;
  }
  return errorRecords.some(
    (record) =>
      typeof record.message === 'string' &&
      /(?:timeout|timed out|ECONN[A-Z0-9_]*|EAI_AGAIN|ENETUNREACH|socket|aborted|network)/i.test(
        record.message,
      ),
  );
}

function sanitizedBitableWriteException(error: unknown): BadGatewayException {
  const errorRecords = externalErrorRecords(error);
  const responseRecords = errorRecords.flatMap((record) => {
    const response = asRecord(record.response);
    return response ? [response] : [];
  });
  const businessCode = responseRecords
    .map((response) => asRecord(response.data)?.code)
    .find(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    );
  const httpStatus = responseRecords
    .map((response) => response.status)
    .find(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    );
  const suffix =
    businessCode !== undefined
      ? `（code: ${businessCode}）`
      : httpStatus !== undefined
        ? `（HTTP ${httpStatus}）`
        : '';
  return emergencyDutyBadGateway(
    `写入应急值班记录失败：飞书请求被拒绝${suffix}`,
  );
}

async function emergencyDutyPreWriteStep<T>(
  operation: () => Promise<T>,
  fallbackMessage: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (getEmergencyDutyWriteDisposition(error) === 'definitely-not-written') {
      throw error;
    }
    if (error instanceof BadRequestException) {
      throw emergencyDutyBadRequest(error.message);
    }
    if (error instanceof ConflictException) {
      throw emergencyDutyConflict(error.message);
    }
    if (error instanceof BadGatewayException) {
      throw emergencyDutyBadGateway(error.message);
    }
    throw emergencyDutyUnavailable(fallbackMessage);
  }
}

function getEmergencyDutyWriteDisposition(error: unknown): unknown {
  if (
    !error ||
    typeof error !== 'object' ||
    !('getResponse' in error) ||
    typeof error.getResponse !== 'function'
  ) {
    return undefined;
  }
  const response = error.getResponse();
  return response && typeof response === 'object'
    ? (response as { writeDisposition?: unknown }).writeDisposition
    : undefined;
}

function emergencyDutyBadRequest(message: string): BadRequestException {
  return new BadRequestException({
    message,
    writeDisposition: 'definitely-not-written',
  });
}

function emergencyDutyConflict(message: string): ConflictException {
  return new ConflictException({
    message,
    writeDisposition: 'definitely-not-written',
  });
}

function emergencyDutyBadGateway(message: string): BadGatewayException {
  return new BadGatewayException({
    message,
    writeDisposition: 'definitely-not-written',
  });
}

function emergencyDutyUnavailable(
  message: string,
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message,
    writeDisposition: 'definitely-not-written',
  });
}

function externalErrorRecords(error: unknown): Array<Record<string, unknown>> {
  const record = asRecord(error);
  const cause = asRecord(record?.cause);
  return [record, cause].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== null,
  );
}

function emergencyDutyUnknownWriteResult(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: '应急值班写入结果暂未确认，请使用原调整标识安全重试',
    writeDisposition: 'unknown-result',
  });
}

function safeErrorSummary(error: unknown): string {
  const name = error instanceof Error ? error.name.trim() : '';
  return /^[A-Za-z][A-Za-z0-9]*(?:Error|Exception)$/u.test(name)
    ? name
    : 'ExternalError';
}
