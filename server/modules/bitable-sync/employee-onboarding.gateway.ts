import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import FormData = require('form-data');
import { getFeishuAuthPayload } from '@server/common/config/external-services.config';
import {
  extractDisplayText,
  getTenantAccessToken as getSharedTenantAccessToken,
  invalidateBitableRecordCache,
  invalidateFeishuTenantAccessTokenCacheForApp,
  resolveBitableAppToken,
} from '@server/common/feishu/bitable-direct-read';
import {
  EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX,
  isEmployeeOnboardingClientMutationId,
} from '../../../shared/employee-onboarding';
import {
  readEmployeeOnboardingConfig,
  type EmployeeOnboardingConfig,
} from './employee-onboarding.config';

export interface EmployeeOnboardingFieldMeta {
  field_id: string;
  field_name: string;
  type: number;
}

export interface EmployeeOnboardingUploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export class EmployeeOnboardingCreateIndeterminateError extends ServiceUnavailableException {
  constructor(public readonly clientMutationId: string) {
    super(
      '新员工入职提交状态暂时无法确认，请勿更换 clientMutationId，并使用同一值核对结果',
    );
    this.name = 'EmployeeOnboardingCreateIndeterminateError';
  }
}

export class EmployeeOnboardingClientTokenConflictError extends ConflictException {
  constructor() {
    super('新员工入职提交标识冲突，请先核对上次记录后再使用新的提交标识');
    this.name = 'EmployeeOnboardingClientTokenConflictError';
  }
}

class EmployeeOnboardingAuthenticationError extends Error {
  constructor() {
    super('飞书访问令牌暂时失效');
    this.name = 'EmployeeOnboardingAuthenticationError';
  }
}

interface ResolvedEmployeeOnboardingTarget {
  appToken: string;
  tableId: string;
}

interface ValidatedUploadFile {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  size: number;
}

const MEDIA_UPLOAD_URL =
  'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all';
const DEFAULT_HTTP_TIMEOUT_MS = 8_000;
const MEDIA_UPLOAD_HTTP_TIMEOUT_MS = 25_000;
const MAX_FIELD_PAGES = 20;
const FIELD_PAGE_SIZE = 100;
const CREATE_RETRY_DELAY_MS = 100;
const DELETE_CONFIRMATION_ATTEMPTS = 3;
const DELETE_CONFIRMATION_DELAY_MS = 100;
const MAX_UPLOAD_FILE_NAME_LENGTH = 180;
const MAX_UPLOAD_MIME_LENGTH = 100;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9]+$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,256}$/u;
const BITABLE_TOKEN_PATTERN = /^[A-Za-z0-9]{10,128}$/u;
const TABLE_ID_PATTERN = /^tbl[A-Za-z0-9]+$/u;
const RECORD_NOT_FOUND_CODE = 1254043;
const CREATE_CLIENT_TOKEN_CONFLICT_CODE = 1255006;
const RETRYABLE_CREATE_CODES = new Set([
  1254290, 1254291, 1254607, 1254608, 1255001, 1255002, 1255003, 1255004,
  1255005, 1255040, 99991400,
]);
const INVALID_TENANT_TOKEN_CODES = new Set([
  99991661, 99991662, 99991663, 99991664, 99991668,
]);
const REQUIRED_FIELDS = [
  { name: '姓名', type: 1 },
  { name: '用工性质', type: 3 },
  { name: '公司名称', type: 3 },
  { name: '岗位', type: 3 },
  { name: '身份证号', type: 1 },
  { name: '联系方式', type: 13 },
  { name: '入职日期', type: 5 },
  { name: '学历', type: 3 },
  { name: '毕业院校', type: 1 },
  { name: '所学专业', type: 1 },
  { name: '毕业时间', type: 1 },
  { name: '兴趣爱好', type: 4 },
  { name: '车牌号', type: 1 },
  { name: '照片', type: 17 },
  { name: 'MBTI', type: 3 },
] as const;

@Injectable()
export class EmployeeOnboardingGateway {
  private resolvedTarget: ResolvedEmployeeOnboardingTarget | null = null;
  private targetPromise: Promise<ResolvedEmployeeOnboardingTarget> | null =
    null;

  constructor(private readonly httpService: HttpService) {}

  async fetchFieldMetas(): Promise<EmployeeOnboardingFieldMeta[]> {
    const target = await this.getTarget();
    const fields: EmployeeOnboardingFieldMeta[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      if (pageCount >= MAX_FIELD_PAGES) {
        throw new BadGatewayException(
          '读取新员工入职字段失败：分页超过安全上限',
        );
      }
      pageCount += 1;

      let response: { data?: unknown };
      try {
        response = await this.requestWithAuthRetry((token) =>
          this.httpService.axiosRef.get(fieldsUrl(target), {
            ...requestConfig(token),
            params: { page_size: FIELD_PAGE_SIZE, page_token: pageToken },
          }),
        );
      } catch {
        throw new ServiceUnavailableException('读取新员工入职字段暂时失败');
      }

      assertFeishuSuccess(response.data, '读取新员工入职字段失败');
      const payload = asPlainRecord(response.data);
      const data = asPlainRecord(payload?.data);
      if (!Array.isArray(data?.items)) {
        throw new BadGatewayException('读取新员工入职字段失败：响应格式无效');
      }

      for (const item of data.items) {
        const meta = parseFieldMeta(item);
        if (!meta) {
          throw new BadGatewayException('读取新员工入职字段失败：响应格式无效');
        }
        fields.push(meta);
      }

      hasMore = data.has_more === true;
      pageToken = clean(data.page_token) || undefined;
      if (hasMore && !pageToken) {
        throw new BadGatewayException('读取新员工入职字段失败：分页响应无效');
      }
      if (hasMore && seenPageTokens.has(pageToken!)) {
        throw new BadGatewayException('读取新员工入职字段失败：分页响应无效');
      }
      if (hasMore) seenPageTokens.add(pageToken!);
    }

    assertRequiredFieldMetas(fields);
    return fields;
  }

  async uploadAttachment(file: EmployeeOnboardingUploadFile): Promise<string> {
    const validated = validateUploadFile(file);
    const target = await this.getTarget();

    return attachmentUploadSemaphore.run(async () => {
      let response: { data?: unknown };
      try {
        response = await this.requestWithAuthRetry((token) => {
          const form = new FormData();
          form.append('file_name', validated.fileName);
          form.append('parent_type', 'bitable_file');
          form.append('parent_node', target.appToken);
          form.append('size', String(validated.size));
          form.append('file', validated.buffer, {
            filename: validated.fileName,
            contentType: validated.mimeType,
          });
          return this.httpService.axiosRef.post(MEDIA_UPLOAD_URL, form, {
            ...requestConfig(token, MEDIA_UPLOAD_HTTP_TIMEOUT_MS),
            headers: {
              Authorization: `Bearer ${token}`,
              ...form.getHeaders(),
            },
            maxBodyLength: Infinity,
          });
        });
      } catch {
        throw new ServiceUnavailableException('上传新员工入职附件暂时失败');
      }

      assertFeishuSuccess(response.data, '上传新员工入职附件失败');
      const payload = asPlainRecord(response.data);
      const data = asPlainRecord(payload?.data);
      const fileToken = clean(data?.file_token);
      if (!SAFE_TOKEN_PATTERN.test(fileToken)) {
        throw new BadGatewayException('上传新员工入职附件失败：响应格式无效');
      }
      return fileToken;
    });
  }

  async createRecord(
    fields: Record<string, unknown>,
    clientMutationId: string,
  ): Promise<string> {
    if (!isEmployeeOnboardingClientMutationId(clientMutationId)) {
      throw new BadRequestException('clientMutationId 无效');
    }
    if (!isPlainRecord(fields)) {
      throw new BadRequestException('新员工入职字段无效');
    }

    const target = await this.getTarget();
    const feishuClientToken = clientMutationId.slice(
      EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX.length,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: { data?: unknown };
      try {
        response = await this.requestWithAuthRetry((token) =>
          this.httpService.axiosRef.post(
            recordsUrl(target),
            { fields },
            {
              ...requestConfig(token),
              params: {
                client_token: feishuClientToken,
                user_id_type: 'open_id',
              },
            },
          ),
        );
      } catch (error) {
        if (error instanceof EmployeeOnboardingAuthenticationError) {
          throw new ServiceUnavailableException('飞书访问令牌暂时失效');
        }
        const outcome = classifyCreateError(error);
        if (outcome === 'conflict') {
          throw new EmployeeOnboardingClientTokenConflictError();
        }
        if (outcome !== 'transient') {
          throw new BadGatewayException('新增新员工入职记录失败');
        }
        if (attempt === 1) {
          throw new EmployeeOnboardingCreateIndeterminateError(
            clientMutationId,
          );
        }
        await waitBeforeRetry(CREATE_RETRY_DELAY_MS);
        continue;
      }

      const outcome = classifyCreatePayload(response.data);
      if (outcome === 'conflict') {
        throw new EmployeeOnboardingClientTokenConflictError();
      }
      if (outcome === 'transient') {
        if (attempt === 1) {
          throw new EmployeeOnboardingCreateIndeterminateError(
            clientMutationId,
          );
        }
        await waitBeforeRetry(CREATE_RETRY_DELAY_MS);
        continue;
      }
      if (outcome === 'permanent') {
        throw new BadGatewayException('新增新员工入职记录失败');
      }

      const payload = asPlainRecord(response.data);
      const data = asPlainRecord(payload?.data);
      const record = asPlainRecord(data?.record);
      const recordId = clean(record?.record_id);
      if (!RECORD_ID_PATTERN.test(recordId)) {
        throw new BadGatewayException('新增新员工入职记录失败：响应格式无效');
      }

      return recordId;
    }

    throw new EmployeeOnboardingCreateIndeterminateError(clientMutationId);
  }

  async readRecord(recordId: string): Promise<Record<string, unknown> | null> {
    assertRecordId(recordId);
    const target = await this.getTarget();

    let response: { data?: unknown };
    try {
      response = await this.requestWithAuthRetry((token) =>
        this.httpService.axiosRef.get(
          `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
          {
            ...requestConfig(token),
            params: { user_id_type: 'open_id' },
          },
        ),
      );
    } catch (error) {
      if (isRecordNotFoundError(error)) return null;
      throw new ServiceUnavailableException('读取新员工入职记录暂时失败');
    }

    if (isRecordNotFoundPayload(response.data)) return null;
    assertFeishuSuccess(response.data, '读取新员工入职记录失败');
    const payload = asPlainRecord(response.data);
    const data = asPlainRecord(payload?.data);
    const record = asPlainRecord(data?.record);
    const fields = asPlainRecord(record?.fields);
    if (!fields) {
      throw new BadGatewayException('读取新员工入职记录失败：响应格式无效');
    }
    return { ...fields };
  }

  async updateMbti(recordId: string, type: string): Promise<void> {
    assertRecordId(recordId);
    if (!/^[IE][SN][TF][JP]$/u.test(type)) {
      throw new BadRequestException('MBTI 类型无效');
    }
    const matches = (await this.fetchFieldMetas()).filter((field) => field.field_name === 'MBTI');
    if (matches.length !== 1 || ![1, 3].includes(matches[0].type)) {
      throw new BadGatewayException('员工信息池 MBTI 字段不存在或类型不支持');
    }
    const target = await this.getTarget();
    try {
      const response = await this.requestWithAuthRetry((token) =>
        this.httpService.axiosRef.put(
          `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
          { fields: { MBTI: type } },
          { ...requestConfig(token), params: { user_id_type: 'open_id' } },
        ),
      );
      assertFeishuSuccess(response.data, '同步 MBTI 结果失败');
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new ServiceUnavailableException('同步 MBTI 结果暂时失败');
    }
    const fields = await this.readRecord(recordId);
    if (!fields || extractDisplayText(fields.MBTI, '').trim() !== type) {
      throw new BadGatewayException('MBTI 结果写入后回读不一致');
    }
    this.invalidateTargetCache();
  }

  async deleteRecordForSelfTest(recordId: string): Promise<void> {
    assertRecordId(recordId);
    const target = await this.getTarget();

    let response: { data?: unknown };
    try {
      response = await this.requestWithAuthRetry((token) =>
        this.httpService.axiosRef.delete(
          `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
          {
            ...requestConfig(token),
            params: { user_id_type: 'open_id' },
          },
        ),
      );
    } catch (error) {
      if (!isRecordNotFoundError(error)) {
        throw new ServiceUnavailableException('删除新员工入职测试记录暂时失败');
      }
      response = { data: { code: RECORD_NOT_FOUND_CODE } };
    }

    if (!isRecordNotFoundPayload(response.data)) {
      assertFeishuSuccess(response.data, '删除新员工入职测试记录失败');
    }
    await this.confirmRecordDeleted(recordId);
  }

  private async confirmRecordDeleted(recordId: string): Promise<void> {
    for (
      let attempt = 0;
      attempt < DELETE_CONFIRMATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        if ((await this.readRecord(recordId)) === null) {
          this.invalidateTargetCache();
          return;
        }
      } catch {
        // A failed confirmation is retried within the same strict bound.
      }

      if (attempt < DELETE_CONFIRMATION_ATTEMPTS - 1) {
        await waitBeforeRetry(DELETE_CONFIRMATION_DELAY_MS);
      }
    }

    throw new BadGatewayException('删除新员工入职测试记录未确认');
  }

  private async requestWithAuthRetry<T extends { data?: unknown }>(
    operation: (token: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getTenantAccessToken();
      try {
        const response = await operation(token);
        if (!isInvalidTenantTokenPayload(response.data)) return response;
      } catch (error) {
        if (!isInvalidTenantTokenError(error)) throw error;
      }

      if (attempt === 1) {
        throw new EmployeeOnboardingAuthenticationError();
      }
      this.invalidateTenantAccessToken();
    }

    throw new EmployeeOnboardingAuthenticationError();
  }

  private async getTenantAccessToken(): Promise<string> {
    let token: string;
    try {
      token = await getSharedTenantAccessToken(this.httpService, undefined, {
        requestTimeoutMs: () => DEFAULT_HTTP_TIMEOUT_MS,
      });
    } catch {
      throw new EmployeeOnboardingAuthenticationError();
    }
    if (!SAFE_TOKEN_PATTERN.test(clean(token))) {
      throw new EmployeeOnboardingAuthenticationError();
    }
    return token;
  }

  private invalidateTenantAccessToken(): void {
    try {
      const appId = clean(getFeishuAuthPayload().app_id);
      if (!appId) throw new Error('missing app id');
      invalidateFeishuTenantAccessTokenCacheForApp(appId);
    } catch {
      throw new EmployeeOnboardingAuthenticationError();
    }
  }

  invalidateTargetCache(): void {
    if (!this.resolvedTarget) return;
    invalidateBitableRecordCache({
      appToken: this.resolvedTarget.appToken,
      tableId: this.resolvedTarget.tableId,
    });
  }

  private getTarget(): Promise<ResolvedEmployeeOnboardingTarget> {
    if (this.resolvedTarget) return Promise.resolve(this.resolvedTarget);
    if (!this.targetPromise) {
      this.targetPromise = this.resolveTarget()
        .then((target) => {
          this.resolvedTarget = target;
          return target;
        })
        .finally(() => {
          this.targetPromise = null;
        });
    }
    return this.targetPromise;
  }

  private async resolveTarget(): Promise<ResolvedEmployeeOnboardingTarget> {
    try {
      const config = readEmployeeOnboardingConfig();
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken: config.appToken,
        wikiToken: config.wikiToken,
        tableName: config.tableName,
        requestTimeoutMs: () => DEFAULT_HTTP_TIMEOUT_MS,
      });
      assertResolvedTarget(appToken, config);
      return { appToken, tableId: config.tableId };
    } catch {
      throw new ServiceUnavailableException('新员工入职数据源暂时不可用');
    }
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const attachmentUploadSemaphore = new AsyncSemaphore(3);

function validateUploadFile(
  file: EmployeeOnboardingUploadFile,
): ValidatedUploadFile {
  if (
    !file ||
    !Buffer.isBuffer(file.buffer) ||
    file.buffer.length === 0 ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size !== file.buffer.length ||
    typeof file.originalname !== 'string' ||
    Array.from(file.originalname.trim()).length === 0 ||
    Array.from(file.originalname.trim()).length > MAX_UPLOAD_FILE_NAME_LENGTH ||
    typeof file.mimetype !== 'string' ||
    file.mimetype.trim().length === 0 ||
    file.mimetype.trim().length > MAX_UPLOAD_MIME_LENGTH ||
    /[\r\n]/u.test(file.mimetype)
  ) {
    throw new BadRequestException('附件文件无效');
  }

  const fileName = file.originalname
    .trim()
    .split(/[\\/]/u)
    .pop()!
    .replace(/[\x00-\x1f\x7f:*?"<>|]/gu, '_')
    .trim();
  if (!fileName || Array.from(fileName).length > MAX_UPLOAD_FILE_NAME_LENGTH) {
    throw new BadRequestException('附件文件无效');
  }

  return {
    buffer: file.buffer,
    fileName,
    mimeType: file.mimetype.trim().toLowerCase(),
    size: file.size,
  };
}

function assertResolvedTarget(
  appToken: string,
  config: EmployeeOnboardingConfig,
): void {
  if (
    !BITABLE_TOKEN_PATTERN.test(clean(appToken)) ||
    !TABLE_ID_PATTERN.test(clean(config.tableId))
  ) {
    throw new Error('invalid target');
  }
}

function parseFieldMeta(value: unknown): EmployeeOnboardingFieldMeta | null {
  const item = asPlainRecord(value);
  const fieldId = clean(item?.field_id);
  const fieldName = clean(item?.field_name);
  const type = Number(item?.type);
  if (!fieldId || !fieldName || !Number.isSafeInteger(type) || type < 0) {
    return null;
  }
  return { field_id: fieldId, field_name: fieldName, type };
}

function assertRequiredFieldMetas(
  fields: readonly EmployeeOnboardingFieldMeta[],
): void {
  for (const required of REQUIRED_FIELDS) {
    const matches = fields.filter(
      (field) => field.field_name === required.name,
    );
    if (matches.length !== 1 || matches[0].type !== required.type) {
      throw new BadGatewayException(
        `新员工入职字段配置异常：${required.name}（期望类型 ${required.type}）`,
      );
    }
  }
}

function assertRecordId(recordId: string): void {
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new BadRequestException('recordId 无效');
  }
}

function assertFeishuSuccess(payload: unknown, message: string): void {
  const response = asPlainRecord(payload);
  if (response?.code !== 0) {
    throw new BadGatewayException(message);
  }
}

type CreateOutcome = 'success' | 'transient' | 'conflict' | 'permanent';

function classifyCreatePayload(payload: unknown): CreateOutcome {
  const code = readFeishuCode(payload);
  if (code === 0) return 'success';
  if (code === CREATE_CLIENT_TOKEN_CONFLICT_CODE) return 'conflict';
  if (code !== null && RETRYABLE_CREATE_CODES.has(code)) return 'transient';
  return 'permanent';
}

function classifyCreateError(
  error: unknown,
): Exclude<CreateOutcome, 'success'> {
  const candidate = asObjectLike(error);
  const response = asObjectLike(candidate?.response);
  const code = readFeishuCode(response?.data);
  if (code === CREATE_CLIENT_TOKEN_CONFLICT_CODE) return 'conflict';
  if (code !== null && RETRYABLE_CREATE_CODES.has(code)) return 'transient';
  if (code !== null) return 'permanent';

  const status = Number(response?.status);
  if (Number.isFinite(status) && status > 0) {
    return status === 408 || status === 429 || status >= 500
      ? 'transient'
      : 'permanent';
  }
  return 'transient';
}

function isInvalidTenantTokenPayload(payload: unknown): boolean {
  const code = readFeishuCode(payload);
  return code !== null && INVALID_TENANT_TOKEN_CODES.has(code);
}

function isInvalidTenantTokenError(error: unknown): boolean {
  const candidate = asObjectLike(error);
  const response = asObjectLike(candidate?.response);
  return (
    Number(response?.status) === 401 ||
    isInvalidTenantTokenPayload(response?.data)
  );
}

function readFeishuCode(payload: unknown): number | null {
  const response = asPlainRecord(payload);
  const code = response?.code;
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
}

function isRecordNotFoundError(error: unknown): boolean {
  const candidate = asObjectLike(error);
  const response = asObjectLike(candidate?.response);
  return isRecordNotFoundPayload(response?.data);
}

function isRecordNotFoundPayload(payload: unknown): boolean {
  const response = asPlainRecord(payload);
  return Number(response?.code) === RECORD_NOT_FOUND_CODE;
}

function requestConfig(token: string, timeout = DEFAULT_HTTP_TIMEOUT_MS) {
  return {
    headers: { Authorization: `Bearer ${token}` },
    timeout,
  };
}

function recordsUrl(target: ResolvedEmployeeOnboardingTarget): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${target.appToken}/tables/${target.tableId}/records`;
}

function fieldsUrl(target: ResolvedEmployeeOnboardingTarget): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${target.appToken}/tables/${target.tableId}/fields`;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function asObjectLike(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return asPlainRecord(value) !== null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function waitBeforeRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
