import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readEnv } from '@server/common/config/external-services.config';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';

const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const DEPARTMENT_URL = 'https://oapi.dingtalk.com/topapi/v2/department/listsub';
const USER_URL = 'https://oapi.dingtalk.com/topapi/v2/user/list';
const RESULT_URL = 'https://oapi.dingtalk.com/attendance/list';
const DETAIL_URL = 'https://oapi.dingtalk.com/attendance/listRecord';
const CORRECTION_INSTANCE_LIST_URL =
  'https://oapi.dingtalk.com/topapi/processinstance/listids';
const CORRECTION_INSTANCE_DETAIL_URL =
  'https://oapi.dingtalk.com/topapi/processinstance/get';
const DEFAULT_CORRECTION_PROCESS_CODE =
  'PROC-E6713FD4-865A-431F-9568-420C0633DDDC';
const REQUEST_TIMEOUT_MS = 30_000;
const USER_BATCH_SIZE = 50;
const APPROVAL_BATCH_SIZE = 20;
const MAX_CORRECTION_DETAILS_PER_DAY = 20;
const MAX_RESULT_PAGES_PER_BATCH = 4;
const DEFAULT_DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEPTEMBER_ATTENDANCE_API_DAILY_LIMIT = 70;
const OCTOBER_ATTENDANCE_API_DAILY_LIMIT = 150;
const PRE_SEPTEMBER_ATTENDANCE_API_DAILY_LIMIT = 40;
const EVENING_ATTENDANCE_API_RESERVE = 8;
const CORRECTION_CACHE_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const API_BUDGET_LOCK_STALE_MS = 60_000;

export interface DingTalkDirectoryUser {
  userId: string;
  name: string;
}

export interface DingTalkAttendanceQuery {
  start: string;
  end: string;
  userIds: readonly string[];
}

export interface DingTalkAttendanceRawResult {
  id: number | string | null;
  userId: string;
  checkType: 'OnDuty' | 'OffDuty' | string;
  baseCheckTime: number | string | null;
  userCheckTime: number | string | null;
  workDate: number | string | null;
  timeResult: string | null;
  locationResult: string | null;
  approveId: string | null;
  procInstId: string | null;
  sourceType: string | null;
  correctionEvidenceStatus?:
    | 'present'
    | 'missing'
    | 'pending'
    | 'rejected'
    | 'unavailable';
  original: Record<string, unknown>;
}

export interface DingTalkAttendanceRawDetail {
  id: number | string | null;
  userId: string;
  checkType: string | null;
  userCheckTime: number | string | null;
  baseCheckTime: number | string | null;
  workDate: number | string | null;
  timeResult: string | null;
  locationResult: string | null;
  userAddress: string | null;
  userLongitude: number | null;
  userLatitude: number | null;
  outsideRemark: string | null;
  invalidRecordMsg: string | null;
  deviceId: string | null;
  sourceType: string | null;
  original: Record<string, unknown>;
}

export interface DingTalkCorrectionApproval {
  processInstanceId: string;
  userId: string;
  status: string;
  result: string;
  correctionTime: number | null;
  workDate: number | null;
  planText: string;
  reason: string;
  photoUrls: string[];
  original: Record<string, unknown>;
}

export interface DingTalkCorrectionApprovalQuery {
  start: string;
  end: string;
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

interface DirectoryCacheFile {
  version: 1;
  appFingerprint: string;
  refreshedAt: string;
  users: DingTalkDirectoryUser[];
}

interface ApiBudgetFile {
  version: 1;
  date: string;
  attendanceCalls: number;
  correctionCalls: number;
  updatedAt: string;
}

interface CorrectionApprovalCacheFile {
  version: 1;
  entries: Record<
    string,
    { capturedAt: string; instance: Record<string, unknown> }
  >;
}

@Injectable()
export class DingTalkAttendanceClient {
  private tokenCache: TokenCache | null = null;
  private tokenRequest: Promise<string> | null = null;
  private directoryRequest: Promise<DingTalkDirectoryUser[]> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async listAllUsers(): Promise<DingTalkDirectoryUser[]> {
    const cached = this.readDirectoryCache();
    if (cached) return cached;
    if (this.directoryRequest) return this.directoryRequest;
    this.directoryRequest = this.fetchAllUsers();
    try {
      const users = await this.directoryRequest;
      this.writeDirectoryCache(users);
      return users;
    } finally {
      this.directoryRequest = null;
    }
  }

  private async fetchAllUsers(): Promise<DingTalkDirectoryUser[]> {
    const token = await this.getAccessToken();
    const departmentQueue = [1];
    const visitedDepartments = new Set<number>();
    const users = new Map<string, DingTalkDirectoryUser>();

    while (departmentQueue.length > 0) {
      const departmentId = departmentQueue.shift()!;
      if (departmentId <= 0 || visitedDepartments.has(departmentId)) continue;
      visitedDepartments.add(departmentId);
      const departmentResponse = await this.postOapi(DEPARTMENT_URL, token, {
        dept_id: departmentId,
        language: 'zh_CN',
      });
      const children = Array.isArray(departmentResponse.result)
        ? departmentResponse.result
        : [];
      children.forEach((item) => {
        const childId = Number(asObject(item).dept_id);
        if (childId > 0 && !visitedDepartments.has(childId)) {
          departmentQueue.push(childId);
        }
      });

      let cursor = 0;
      for (;;) {
        const userResponse = await this.postOapi(USER_URL, token, {
          dept_id: departmentId,
          cursor,
          size: 100,
          language: 'zh_CN',
          contain_access_limit: false,
        });
        const result = asObject(userResponse.result);
        const list = Array.isArray(result.list) ? result.list : [];
        list.forEach((item) => {
          const source = asObject(item);
          const userId = text(source.userid || source.userId);
          const name = text(source.name);
          if (userId && name) users.set(userId, { userId, name });
        });
        if (!(result.has_more ?? result.hasMore)) break;
        const nextCursor = Number(result.next_cursor ?? result.nextCursor);
        if (!Number.isFinite(nextCursor) || nextCursor === cursor) break;
        cursor = nextCursor;
      }
    }

    if (users.size === 0) {
      throw new Error('钉钉通讯录未返回可用人员，请检查应用通讯录权限');
    }
    return [...users.values()];
  }

  private readDirectoryCache(): DingTalkDirectoryUser[] | null {
    const cachePath = this.directoryCachePath();
    if (!existsSync(cachePath)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(cachePath, 'utf8'),
      ) as Partial<DirectoryCacheFile>;
      const refreshedAt = Date.parse(String(parsed.refreshedAt || ''));
      if (
        parsed.version !== 1 ||
        parsed.appFingerprint !== this.appFingerprint() ||
        !Number.isFinite(refreshedAt) ||
        Date.now() - refreshedAt >= this.directoryCacheTtlMs() ||
        !Array.isArray(parsed.users)
      ) {
        return null;
      }
      const users = parsed.users
        .map((item) => ({
          userId: text(item?.userId),
          name: text(item?.name),
        }))
        .filter((item) => item.userId && item.name);
      return users.length > 0 ? users : null;
    } catch {
      return null;
    }
  }

  private writeDirectoryCache(users: readonly DingTalkDirectoryUser[]): void {
    const cachePath = this.directoryCachePath();
    mkdirSync(dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    const payload: DirectoryCacheFile = {
      version: 1,
      appFingerprint: this.appFingerprint(),
      refreshedAt: new Date().toISOString(),
      users: [...users],
    };
    try {
      writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tempPath, cachePath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private directoryCachePath(): string {
    return resolveDutyDailyReportStateFilePath({
      fileName: 'dingtalk-attendance-directory-cache.json',
      explicitPath: process.env.DINGTALK_ATTENDANCE_DIRECTORY_CACHE_PATH,
      configuredDirectory:
        process.env.DINGTALK_ATTENDANCE_DIRECTORY_CACHE_DIR ||
        process.env.ATTENDANCE_AUTOMATION_STATE_DIR ||
        process.env.DUTY_DAILY_REPORT_STATE_DIR,
    });
  }

  private directoryCacheTtlMs(): number {
    const configured = Number.parseInt(
      process.env.DINGTALK_ATTENDANCE_DIRECTORY_CACHE_TTL_MS || '',
      10,
    );
    return Number.isFinite(configured) && configured >= 60_000
      ? configured
      : DEFAULT_DIRECTORY_CACHE_TTL_MS;
  }

  private appFingerprint(): string {
    const appKey = readEnv('DINGTALK_ATTENDANCE_CLIENT_ID', [
      'DINGTALK_ATTENDANCE_APP_KEY',
    ]);
    return createHash('sha256').update(appKey).digest('hex').slice(0, 16);
  }

  async listAttendanceResults(
    query: DingTalkAttendanceQuery,
  ): Promise<DingTalkAttendanceRawResult[]> {
    const token = await this.getAccessToken();
    const records: DingTalkAttendanceRawResult[] = [];
    for (const userIds of chunks(
      normalizeUserIds(query.userIds),
      USER_BATCH_SIZE,
    )) {
      let offset = 0;
      let pageCount = 0;
      const pageFingerprints = new Set<string>();
      for (;;) {
        pageCount += 1;
        if (pageCount > MAX_RESULT_PAGES_PER_BATCH) {
          throw new Error(
            `钉钉考勤结果分页超过安全上限：batchUsers=${userIds.length}, pages=${MAX_RESULT_PAGES_PER_BATCH}`,
          );
        }
        const response = await this.postOapi(RESULT_URL, token, {
          workDateFrom: query.start,
          workDateTo: query.end,
          userIdList: userIds,
          offset,
          limit: 50,
          isI18n: false,
        });
        const items = Array.isArray(response.recordresult)
          ? response.recordresult
          : Array.isArray(asObject(response.result).recordresult)
            ? (asObject(response.result).recordresult as unknown[])
            : [];
        const hasMore = Boolean(response.hasMore ?? response.has_more);
        if (hasMore && items.length === 0) {
          throw new Error('钉钉考勤结果分页异常：hasMore=true 但返回空页');
        }
        const fingerprint = createHash('sha256')
          .update(JSON.stringify(items))
          .digest('hex');
        if (hasMore && pageFingerprints.has(fingerprint)) {
          throw new Error('钉钉考勤结果分页异常：检测到重复页，已停止继续请求');
        }
        pageFingerprints.add(fingerprint);
        items.forEach((item) => records.push(mapAttendanceResult(item)));
        if (!hasMore) break;
        offset += 50;
      }
    }
    return records;
  }

  async listAttendanceDetails(
    query: DingTalkAttendanceQuery,
    options?: { budgetPriority?: 'evening-final' },
  ): Promise<DingTalkAttendanceRawDetail[]> {
    const token = await this.getAccessToken();
    const records: DingTalkAttendanceRawDetail[] = [];
    for (const userIds of chunks(
      normalizeUserIds(query.userIds),
      USER_BATCH_SIZE,
    )) {
      const response = await this.postOapi(
        DETAIL_URL,
        token,
        {
          checkDateFrom: query.start,
          checkDateTo: query.end,
          userIds,
          isI18n: false,
        },
        options?.budgetPriority,
      );
      const items = Array.isArray(response.recordresult)
        ? response.recordresult
        : Array.isArray(response.result)
          ? response.result
          : [];
      items.forEach((item) => records.push(mapAttendanceDetail(item)));
    }
    return records;
  }

  async listCorrectionApprovals(
    query: DingTalkCorrectionApprovalQuery,
  ): Promise<DingTalkCorrectionApproval[]> {
    const token = await this.getAccessToken();
    const processCode =
      readEnv('DINGTALK_ATTENDANCE_CORRECTION_PROCESS_CODE') ||
      DEFAULT_CORRECTION_PROCESS_CODE;
    const startTime = toEpochMillis(query.start);
    const endTime = toEpochMillis(query.end);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw new Error('钉钉补卡审批查询时间无效');
    }

    const instanceIds: string[] = [];
    let cursor = 0;
    for (;;) {
      const response = await this.postOapi(
        CORRECTION_INSTANCE_LIST_URL,
        token,
        {
          process_code: processCode,
          start_time: startTime,
          end_time: endTime,
          cursor,
          size: APPROVAL_BATCH_SIZE,
        },
      );
      const result = asObject(response.result);
      const list = Array.isArray(result.list)
        ? result.list
        : Array.isArray(result.process_instance_ids)
          ? result.process_instance_ids
          : [];
      list
        .map(text)
        .filter(Boolean)
        .forEach((id) => instanceIds.push(id));
      if (list.length < APPROVAL_BATCH_SIZE) break;
      const nextCursor = Number(result.next_cursor ?? result.nextCursor);
      if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) {
        throw new Error(
          '钉钉补卡审批列表已满页但分页游标无效，不能确认数据完整',
        );
      }
      cursor = nextCursor;
    }

    return this.getCorrectionApprovalsByInstanceIds(instanceIds);
  }

  async getCorrectionApprovalsByInstanceIds(
    processInstanceIds: readonly string[],
  ): Promise<DingTalkCorrectionApproval[]> {
    const uniqueIds = [
      ...new Set(processInstanceIds.map((id) => text(id)).filter(Boolean)),
    ];
    if (uniqueIds.length === 0) return [];

    const cache = readCorrectionApprovalCacheFile(this.correctionCachePath());
    const cachedApprovals = new Map<string, DingTalkCorrectionApproval>();
    for (const processInstanceId of uniqueIds) {
      const cached = cache.entries[processInstanceId];
      const cachedApproval = cached
        ? mapCorrectionApproval(cached.instance, processInstanceId)
        : null;
      if (
        cachedApproval &&
        isCacheableCorrection(cachedApproval) &&
        Date.now() - Date.parse(cached.capturedAt) < CORRECTION_CACHE_TTL_MS
      ) {
        cachedApprovals.set(processInstanceId, cachedApproval);
      }
    }
    let token: string | null = null;
    const approvals: DingTalkCorrectionApproval[] = [];
    let fetchedDetails = 0;
    let remainingDetails = 0;
    for (const processInstanceId of uniqueIds) {
      const cachedApproval = cachedApprovals.get(processInstanceId);
      if (cachedApproval) {
        approvals.push(cachedApproval);
        continue;
      }
      if (fetchedDetails >= MAX_CORRECTION_DETAILS_PER_DAY) {
        remainingDetails += 1;
        continue;
      }
      token ??= await this.getAccessToken();
      const response = await this.postOapi(
        CORRECTION_INSTANCE_DETAIL_URL,
        token,
        { process_instance_id: processInstanceId },
      );
      const instance = asObject(
        response.process_instance ??
          response.processInstance ??
          response.result,
      );
      const mapped = mapCorrectionApproval(instance, processInstanceId);
      if (
        !mapped ||
        !Number.isFinite(mapped.correctionTime) ||
        Number(mapped.correctionTime) <= 0 ||
        !Number.isFinite(mapped.workDate) ||
        Number(mapped.workDate) <= 0
      ) {
        throw new Error('钉钉补卡审批详情缺少员工或补卡时间，已停止同步');
      }
      approvals.push(mapped);
      fetchedDetails += 1;
      if (isCacheableCorrection(mapped)) {
        this.rememberCorrectionApproval(mapped);
      }
    }
    if (remainingDetails > 0) {
      throw new Error(
        `钉钉补卡审批详情未查询完整：本轮最多抓取 ${MAX_CORRECTION_DETAILS_PER_DAY} 条新详情，剩余 ${remainingDetails} 条待下次重试`,
      );
    }
    return approvals;
  }

  private correctionCachePath(): string {
    return join(
      dirname(this.apiBudgetPath()),
      'dingtalk-attendance-correction-approval-cache.json',
    );
  }

  private rememberCorrectionApproval(
    approval: DingTalkCorrectionApproval,
  ): void {
    const cachePath = this.correctionCachePath();
    const lockPath = `${cachePath}.lock`;
    mkdirSync(dirname(cachePath), { recursive: true });
    acquireBudgetLock(lockPath);
    try {
      const cache = readCorrectionApprovalCacheFile(cachePath);
      const now = Date.now();
      for (const [id, entry] of Object.entries(cache.entries)) {
        if (now - Date.parse(entry.capturedAt) >= CORRECTION_CACHE_TTL_MS) {
          delete cache.entries[id];
        }
      }
      cache.entries[approval.processInstanceId] = {
        capturedAt: new Date(now).toISOString(),
        instance: approval.original,
      };
      writeJsonAtomically(cachePath, cache);
    } finally {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.value;
    }
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.fetchAccessToken();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const appKey = readEnv('DINGTALK_ATTENDANCE_CLIENT_ID', [
      'DINGTALK_ATTENDANCE_APP_KEY',
    ]);
    const appSecret = readEnv('DINGTALK_ATTENDANCE_CLIENT_SECRET', [
      'DINGTALK_ATTENDANCE_APP_SECRET',
    ]);
    if (!appKey || !appSecret) {
      throw new Error(
        '缺少钉钉考勤配置：请设置 DINGTALK_ATTENDANCE_CLIENT_ID 和 DINGTALK_ATTENDANCE_CLIENT_SECRET',
      );
    }
    const response = await this.httpService.axiosRef.post(
      TOKEN_URL,
      { appKey, appSecret },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const value = text(response.data?.accessToken);
    if (!value)
      throw new Error('获取钉钉考勤访问令牌失败：响应缺少 accessToken');
    const expiresIn = Math.max(60, Number(response.data?.expireIn || 7200));
    this.tokenCache = {
      value,
      expiresAt: Date.now() + Math.max(30_000, expiresIn * 1000 - 60_000),
    };
    return value;
  }

  private async postOapi(
    url: string,
    token: string,
    body: Record<string, unknown>,
    budgetPriority?: 'evening-final',
  ): Promise<Record<string, unknown>> {
    this.reserveMeteredCall(url, budgetPriority);
    const response = await this.httpService.axiosRef.post(url, body, {
      params: { access_token: token },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const data = asObject(response.data);
    const errorCode = Number(data.errcode || 0);
    if (errorCode !== 0) {
      throw new Error(
        `钉钉接口调用失败（${errorCode}）：${text(data.errmsg) || '未知错误'}`,
      );
    }
    return data;
  }

  private reserveMeteredCall(
    url: string,
    budgetPriority?: 'evening-final',
  ): void {
    const category = meteredCategory(url);
    if (!category) return;
    const budgetPath = this.apiBudgetPath();
    const lockPath = `${budgetPath}.lock`;
    mkdirSync(dirname(budgetPath), { recursive: true });
    acquireBudgetLock(lockPath);
    try {
      const now = new Date();
      const date = shanghaiDateKey(now);
      const totalLimit =
        date >= '2026-10-01'
          ? OCTOBER_ATTENDANCE_API_DAILY_LIMIT
          : date >= '2026-09-01'
            ? SEPTEMBER_ATTENDANCE_API_DAILY_LIMIT
            : PRE_SEPTEMBER_ATTENDANCE_API_DAILY_LIMIT;
      const current = readApiBudgetFile(budgetPath, date);
      const limit =
        category === 'attendance'
          ? readPositiveLimit(
              process.env.DINGTALK_ATTENDANCE_API_DAILY_LIMIT,
              totalLimit,
            )
          : readPositiveLimit(
              process.env.DINGTALK_CORRECTION_API_DAILY_LIMIT,
              totalLimit,
            );
      const next =
        category === 'attendance'
          ? current.attendanceCalls + 1
          : current.correctionCalls + 1;
      if (
        current.attendanceCalls + current.correctionCalls + 1 >
        totalLimit
      ) {
        throw new Error(
          `钉钉考勤与补卡审批接口合计已达到当日调用上限 ${totalLimit}，已停止继续请求`,
        );
      }
      if (
        budgetPriority !== 'evening-final' &&
        new Date(now.getTime() + 8 * 60 * 60 * 1000)
          .toISOString()
          .slice(11, 16) < '18:35' &&
        current.attendanceCalls + current.correctionCalls + 1 >
          totalLimit - EVENING_ATTENDANCE_API_RESERVE
      ) {
        throw new Error(
          `钉钉考勤接口已为18:35核验预留 ${EVENING_ATTENDANCE_API_RESERVE} 次调用，已停止其他请求`,
        );
      }
      if (next > limit) {
        throw new Error(
          `钉钉${category === 'attendance' ? '考勤' : '补卡审批'}接口已达到当日调用上限 ${limit}，已停止继续请求`,
        );
      }
      const updated: ApiBudgetFile = {
        ...current,
        attendanceCalls:
          category === 'attendance' ? next : current.attendanceCalls,
        correctionCalls:
          category === 'correction' ? next : current.correctionCalls,
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomically(budgetPath, updated);
    } finally {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  }

  private apiBudgetPath(): string {
    return resolveDutyDailyReportStateFilePath({
      fileName: 'dingtalk-attendance-api-budget.json',
      explicitPath: process.env.DINGTALK_ATTENDANCE_API_BUDGET_PATH,
      configuredDirectory:
        process.env.DINGTALK_ATTENDANCE_API_BUDGET_DIR ||
        process.env.ATTENDANCE_AUTOMATION_STATE_DIR ||
        process.env.DUTY_DAILY_REPORT_STATE_DIR,
    });
  }
}

function meteredCategory(url: string): 'attendance' | 'correction' | null {
  if (url === RESULT_URL || url === DETAIL_URL) return 'attendance';
  if (
    url === CORRECTION_INSTANCE_LIST_URL ||
    url === CORRECTION_INSTANCE_DETAIL_URL
  ) {
    return 'correction';
  }
  return null;
}

function acquireBudgetLock(lockPath: string): void {
  const acquire = () =>
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  try {
    acquire();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let age: number;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw statError;
      }
      try {
        acquire();
        return;
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw retryError;
        }
        throw new Error('钉钉接口调用预算台账正在更新，已停止本次请求');
      }
    }
    if (age <= API_BUDGET_LOCK_STALE_MS) {
      throw new Error('钉钉接口调用预算台账正在更新，已停止本次请求');
    }
    try {
      unlinkSync(lockPath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unlinkError;
      }
    }
    try {
      acquire();
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw retryError;
      }
      throw new Error('钉钉接口调用预算台账正在更新，已停止本次请求');
    }
  }
}

function readApiBudgetFile(path: string, date: string): ApiBudgetFile {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as Partial<ApiBudgetFile>;
      const isValid =
        parsed.version === 1 &&
        typeof parsed.date === 'string' &&
        Number.isInteger(parsed.attendanceCalls) &&
        Number(parsed.attendanceCalls) >= 0 &&
        Number.isInteger(parsed.correctionCalls) &&
        Number(parsed.correctionCalls) >= 0 &&
        typeof parsed.updatedAt === 'string';
      if (!isValid) {
        throw new Error('invalid budget ledger');
      }
      if (parsed.date === date) {
        return parsed as ApiBudgetFile;
      }
    } catch {
      throw new Error('钉钉接口调用预算台账损坏，已停止请求以避免超额');
    }
  }
  return {
    version: 1,
    date,
    attendanceCalls: 0,
    correctionCalls: 0,
    updatedAt: new Date().toISOString(),
  };
}

function readCorrectionApprovalCacheFile(
  path: string,
): CorrectionApprovalCacheFile {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as Partial<CorrectionApprovalCacheFile>;
    if (
      parsed.version !== 1 ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries) ||
      Object.values(parsed.entries).some(
        (entry) =>
          !entry ||
          typeof entry.capturedAt !== 'string' ||
          !Number.isFinite(Date.parse(entry.capturedAt)) ||
          !entry.instance ||
          typeof entry.instance !== 'object' ||
          Array.isArray(entry.instance),
      )
    ) {
      throw new Error('invalid correction cache');
    }
    return parsed as CorrectionApprovalCacheFile;
  } catch {
    throw new Error('钉钉补卡审批缓存损坏，已停止详情查询');
  }
}

function isCacheableCorrection(approval: DingTalkCorrectionApproval): boolean {
  const approved = /^(agree|approved|pass)$/iu.test(approval.result);
  return (
    approval.status === 'COMPLETED' &&
    /^(agree|approved|pass|refuse|rejected|deny)$/iu.test(approval.result) &&
    (!approved || approval.photoUrls.length > 0) &&
    Number.isFinite(approval.correctionTime) &&
    Number(approval.correctionTime) > 0 &&
    Number.isFinite(approval.workDate) &&
    Number(approval.workDate) > 0
  );
}

function writeJsonAtomically(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function readPositiveLimit(
  value: string | undefined,
  hardMaximum: number,
  defaultLimit = hardMaximum,
): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, hardMaximum)
    : defaultLimit;
}

function shanghaiDateKey(value: Date): string {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function mapAttendanceResult(value: unknown): DingTalkAttendanceRawResult {
  const item = asObject(value);
  return {
    id: scalar(item.id ?? item.recordId),
    userId: text(item.userid ?? item.userId),
    checkType: text(item.checkType),
    baseCheckTime: scalar(item.baseCheckTime ?? item.planCheckTime),
    userCheckTime: scalar(item.userCheckTime),
    workDate: scalar(item.workDate),
    timeResult: nullableText(item.timeResult),
    locationResult: nullableText(item.locationResult),
    approveId: nullableText(item.approveId),
    procInstId: nullableText(item.procInstId),
    sourceType: nullableText(item.sourceType),
    original: item,
  };
}

function mapAttendanceDetail(value: unknown): DingTalkAttendanceRawDetail {
  const item = asObject(value);
  return {
    id: scalar(item.id ?? item.recordId),
    userId: text(item.userId ?? item.userid),
    checkType: nullableText(item.checkType),
    userCheckTime: scalar(item.userCheckTime),
    baseCheckTime: scalar(item.baseCheckTime ?? item.planCheckTime),
    workDate: scalar(item.workDate),
    timeResult: nullableText(item.timeResult),
    locationResult: nullableText(item.locationResult),
    userAddress: nullableText(item.userAddress),
    userLongitude: nullableNumber(item.userLongitude),
    userLatitude: nullableNumber(item.userLatitude),
    outsideRemark: nullableText(item.outsideRemark),
    invalidRecordMsg: nullableText(item.invalidRecordMsg),
    deviceId: nullableText(item.deviceId),
    sourceType: nullableText(item.sourceType),
    original: item,
  };
}

function mapCorrectionApproval(
  value: unknown,
  fallbackInstanceId: string,
): DingTalkCorrectionApproval | null {
  const item = asObject(value);
  const processInstanceId = text(
    item.process_instance_id ?? item.processInstanceId ?? fallbackInstanceId,
  );
  const userId = text(item.originator_userid ?? item.originatorUserid);
  if (!processInstanceId || !userId) return null;
  const components = Array.isArray(item.form_component_values)
    ? item.form_component_values
    : Array.isArray(item.formValueVOS)
      ? item.formValueVOS
      : [];
  let correctionTime: number | null = null;
  let workDate: number | null = null;
  let planText = '';
  let reason = '';
  const photoUrls: string[] = [];

  components.forEach((component) => {
    const field = asObject(component);
    const name = text(field.name);
    const componentType = text(field.component_type ?? field.componentType);
    const valueText = text(field.value);
    const extValueText = text(field.ext_value ?? field.extValue);
    if (
      componentType === 'DDDateField' ||
      name === '补卡时间' ||
      name === 'repairCheckTime'
    ) {
      const extValue = parseJsonObject(extValueText);
      correctionTime = nullableEpochMillis(
        extValue.userCheckTime ?? extValue.timeStamp ?? valueText,
      );
      workDate = nullableEpochMillis(extValue.workDate);
      planText = text(extValue.planText);
    }
    if (componentType === 'TextareaField' && name === '补卡理由') {
      reason = valueText;
    }
    if (componentType === 'DDPhotoField') {
      parsePhotoUrls(valueText).forEach((url) => photoUrls.push(url));
    }
  });

  return {
    processInstanceId,
    userId,
    status: text(item.status ?? item.process_instance_status),
    result: text(item.result ?? item.process_instance_result),
    correctionTime,
    workDate,
    planText,
    reason,
    photoUrls: [...new Set(photoUrls)],
    original: item,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  if (!value) return {};
  try {
    return asObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function parsePhotoUrls(value: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(text).filter((url) => /^https:\/\/[^\s]+$/iu.test(url));
  } catch {
    return [];
  }
}

function nullableEpochMillis(value: unknown): number | null {
  const parsed = toEpochMillis(scalar(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function scalar(value: unknown): number | string | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function toEpochMillis(value: number | string | null): number {
  if (typeof value === 'number') return value;
  const valueText = text(value);
  if (!valueText) return Number.NaN;
  if (/^\d+$/u.test(valueText)) return Number(valueText);
  const normalized = valueText.includes('T')
    ? valueText
    : valueText.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(normalized);
  return Date.parse(hasZone ? normalized : `${normalized}+08:00`);
}

function normalizeUserIds(userIds: readonly string[]): string[] {
  const normalized = [...new Set(userIds.map(text).filter(Boolean))];
  if (normalized.length === 0)
    throw new Error('钉钉考勤查询至少需要一个员工 ID');
  return normalized;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
