import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import FormData = require('form-data');
import {
  getFeishuAuthPayload,
  parseFeishuBitableLink,
  readEnv,
} from '@server/common/config/external-services.config';
import {
  invalidateBitableRecordCache,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '@server/common/feishu/bitable-direct-read';
import {
  loadWeatherWarningRegistrationRuntimeConfig,
  type WeatherWarningRegistrationFields,
} from './weather-warning-registration.config';

export const WEATHER_WARNING_REGISTRATION_ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;
export const WEATHER_WARNING_REGISTRATION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface WeatherWarningRegistrationUploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface WeatherWarningRegistrationGatewayRequestOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface ResolvedRegistrationConfig {
  appToken: string;
  tableId: string;
  fields: WeatherWarningRegistrationFields;
}

interface ResolvedManagerSourceConfig {
  appToken: string;
  tableId: string;
}

const RETRY_DELAYS_MS = [250, 500, 1000] as const;
const MAX_HTTP_TIMEOUT_MS = 8_000;
const MEDIA_UPLOAD_HTTP_TIMEOUT_MS = 25_000;
const MEDIA_UPLOAD_RETRY_DELAY_MS = 250;
const MAX_CANDIDATE_PAGES = 20;
const MAX_CANDIDATE_RECORDS = 10_000;
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const IMAGE_EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
};
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_SIGNATURE = Buffer.from('ffd8ff', 'hex');
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii');
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');

@Injectable()
export class WeatherWarningRegistrationGateway {
  private tokenState: TenantTokenState | null = null;
  private tokenPromise: Promise<string> | null = null;
  private appTokenPromise: Promise<string> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async listCandidateRecords(
    options: WeatherWarningRegistrationGatewayRequestOptions = {},
  ): Promise<BitableRecordItem[]> {
    assertRequestActive(options);
    const config = await this.getConfig(options);
    const token = await this.getTenantAccessToken(options);
    const records: BitableRecordItem[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      if (pageCount >= MAX_CANDIDATE_PAGES) {
        throw new BadGatewayException('读取登记候选人员失败：分页超过安全上限');
      }
      pageCount += 1;
      let response;
      try {
        response = await waitForRequest(
          this.httpService.axiosRef.post(
            `${recordsUrl(config)}/search`,
            {
              field_names: [config.fields.checker, config.fields.manager],
            },
            {
              ...requestConfig(token, options),
              params: {
                page_size: 500,
                page_token: pageToken,
                user_id_type: 'open_id',
              },
            },
          ),
          options,
        );
      } catch (error) {
        throwExternalRequestError(
          error,
          '读取登记候选人员失败',
          '读取登记候选人员暂时失败',
        );
      }

      assertFeishuSuccess(response.data, '读取登记候选人员失败');
      const data = asPlainRecord(response.data.data);
      const items = data?.items;
      if (!Array.isArray(items)) {
        throw new BadGatewayException('读取登记候选人员失败：响应缺少 items');
      }
      if (records.length + items.length > MAX_CANDIDATE_RECORDS) {
        throw new BadGatewayException('读取登记候选人员失败：记录超过安全上限');
      }
      records.push(...(items as BitableRecordItem[]));
      hasMore = data?.has_more === true;
      pageToken = clean(data?.page_token) || undefined;
      if (hasMore && !pageToken) {
        throw new BadGatewayException(
          '读取登记候选人员失败：响应缺少 page_token',
        );
      }
      if (hasMore && seenPageTokens.has(pageToken!)) {
        throw new BadGatewayException('读取登记候选人员失败：分页标识重复');
      }
      if (hasMore) seenPageTokens.add(pageToken!);
    }

    return records;
  }

  async listManagerCandidateRecords(
    options: WeatherWarningRegistrationGatewayRequestOptions = {},
  ): Promise<BitableRecordItem[]> {
    assertRequestActive(options);
    const config = loadManagerSourceConfig();
    const token = await this.getTenantAccessToken(options);
    const records: BitableRecordItem[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      if (pageCount >= MAX_CANDIDATE_PAGES) {
        throw new BadGatewayException('读取机房经理候选失败：分页超过安全上限');
      }
      pageCount += 1;
      let response;
      try {
        response = await waitForRequest(
          this.httpService.axiosRef.get(recordsUrl(config), {
            ...requestConfig(token, options),
            params: {
              page_size: 500,
              page_token: pageToken,
              user_id_type: 'open_id',
            },
          }),
          options,
        );
      } catch (error) {
        throwExternalRequestError(
          error,
          '读取机房经理候选失败',
          '机房经理人员数据暂时不可用',
        );
      }

      assertFeishuSuccess(response.data, '读取机房经理候选失败');
      const data = asPlainRecord(response.data.data);
      const items = data?.items;
      if (!Array.isArray(items)) {
        throw new BadGatewayException('读取机房经理候选失败：响应缺少 items');
      }
      if (records.length + items.length > MAX_CANDIDATE_RECORDS) {
        throw new BadGatewayException('读取机房经理候选失败：记录超过安全上限');
      }
      records.push(...(items as BitableRecordItem[]));
      hasMore = data?.has_more === true;
      pageToken = clean(data?.page_token) || undefined;
      if (hasMore && !pageToken) {
        throw new BadGatewayException(
          '读取机房经理候选失败：响应缺少 page_token',
        );
      }
      if (hasMore && seenPageTokens.has(pageToken!)) {
        throw new BadGatewayException('读取机房经理候选失败：分页标识重复');
      }
      if (hasMore) seenPageTokens.add(pageToken!);
    }

    return records;
  }

  async uploadImage(
    file: WeatherWarningRegistrationUploadFile,
    options: WeatherWarningRegistrationGatewayRequestOptions = {},
  ): Promise<string> {
    assertRequestActive(options);
    const validated = validateWeatherWarningRegistrationUploadFile(file);
    const config = await this.getConfig(options);
    const token = await this.getTenantAccessToken(options);

    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertRequestActive(options);
      const form = new FormData();
      form.append('file_name', validated.fileName);
      form.append('parent_type', 'bitable_file');
      form.append('parent_node', config.appToken);
      form.append('size', String(file.size));
      form.append('file', file.buffer, {
        filename: validated.fileName,
        contentType: validated.mimeType,
      });

      try {
        response = await waitForRequest(
          this.httpService.axiosRef.post(
            'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
            form,
            {
              ...requestConfig(token, options, MEDIA_UPLOAD_HTTP_TIMEOUT_MS),
              headers: {
                Authorization: `Bearer ${token}`,
                ...form.getHeaders(),
              },
              maxBodyLength: Infinity,
            },
          ),
          options,
        );
        break;
      } catch (error) {
        if (attempt === 0 && isRetryableNetworkError(error)) {
          await waitBeforeRetryWithControls(
            defaultWait,
            MEDIA_UPLOAD_RETRY_DELAY_MS,
            options,
          );
          continue;
        }
        throwExternalRequestError(
          error,
          '上传登记附件失败',
          '上传登记附件暂时失败',
        );
      }
    }

    if (!response) {
      throw new ServiceUnavailableException('上传登记附件暂时失败');
    }

    assertFeishuSuccess(response.data, '上传登记附件失败');
    const fileToken = clean(response.data?.data?.file_token);
    if (!fileToken) {
      throw new BadGatewayException('上传登记附件失败：响应缺少 file_token');
    }
    return fileToken;
  }

  async createRecord(
    fields: Record<string, unknown>,
    clientToken: string,
    options: WeatherWarningRegistrationGatewayRequestOptions = {},
  ): Promise<string> {
    assertRequestActive(options);
    const config = await this.getConfig(options);
    const token = await this.getTenantAccessToken(options);
    const createRequest = () =>
      waitForRequest(
        this.httpService.axiosRef.post(
          recordsUrl(config),
          { fields },
          {
            ...requestConfig(token, options),
            params: {
              client_token: clientToken,
              ignore_consistency_check: true,
              user_id_type: 'open_id',
            },
          },
        ),
        options,
      );

    let response: Awaited<ReturnType<typeof createRequest>>;
    try {
      response = await createRequest();
    } catch (error) {
      throwUnlessRetryableNetworkError(error, '新增登记记录失败');
      assertRequestActive(options);
      try {
        response = await createRequest();
      } catch (retryError) {
        throwUnlessRetryableNetworkError(retryError, '新增登记记录失败');
        throw new ServiceUnavailableException(
          '登记记录提交结果暂时无法确认，请使用同一 mutation ID 重试',
        );
      }
    }

    assertFeishuSuccess(response.data, '新增登记记录失败');
    const recordId = clean(response.data?.data?.record?.record_id);
    if (!recordId) {
      throw new BadGatewayException('新增登记记录失败：响应缺少 record_id');
    }
    return recordId;
  }

  async getRecord(
    recordId: string,
    optionsOrWait:
      | WeatherWarningRegistrationGatewayRequestOptions
      | ((delayMs: number) => Promise<void>) = {},
    customWaitBeforeRetry: (delayMs: number) => Promise<void> = defaultWait,
  ): Promise<BitableRecordItem> {
    const options = typeof optionsOrWait === 'function' ? {} : optionsOrWait;
    const waitBeforeRetry =
      typeof optionsOrWait === 'function'
        ? optionsOrWait
        : customWaitBeforeRetry;
    assertRequestActive(options);
    const normalizedRecordId = clean(recordId);
    if (!normalizedRecordId) {
      throw new BadRequestException('登记记录 ID 不能为空');
    }
    const config = await this.getConfig(options);
    const token = await this.getTenantAccessToken(options);

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      let response;
      try {
        response = await waitForRequest(
          this.httpService.axiosRef.get(
            `${recordsUrl(config)}/${encodeURIComponent(normalizedRecordId)}`,
            {
              ...requestConfig(token, options),
              params: { user_id_type: 'open_id' },
            },
          ),
          options,
        );
      } catch (error) {
        const knownResponse = getHttpErrorResponse(error);
        if (knownResponse) {
          response = knownResponse;
        } else {
          if (
            !isRetryableNetworkError(error) ||
            attempt === RETRY_DELAYS_MS.length
          ) {
            throw new ServiceUnavailableException('登记记录读回确认暂时失败');
          }
          await waitBeforeRetryWithControls(
            waitBeforeRetry,
            RETRY_DELAYS_MS[attempt],
            options,
          );
          continue;
        }
      }

      if (Number(response.data?.code) === 1254043) {
        if (attempt === RETRY_DELAYS_MS.length) {
          throw new ServiceUnavailableException('登记记录尚未可供确认');
        }
        await waitBeforeRetryWithControls(
          waitBeforeRetry,
          RETRY_DELAYS_MS[attempt],
          options,
        );
        continue;
      }
      assertFeishuSuccess(response.data, '读取登记记录失败');
      const record = response.data?.data?.record as
        | BitableRecordItem
        | undefined;
      if (!record || !asPlainRecord(record)) {
        if (attempt === RETRY_DELAYS_MS.length) {
          throw new BadGatewayException('读取登记记录失败：响应缺少 record');
        }
        await waitBeforeRetryWithControls(
          waitBeforeRetry,
          RETRY_DELAYS_MS[attempt],
          options,
        );
        continue;
      }

      return record;
    }

    throw new ServiceUnavailableException('登记记录读回确认暂时失败');
  }

  async deleteRecordAndConfirmAbsent(
    recordId: string,
    optionsOrWait:
      | WeatherWarningRegistrationGatewayRequestOptions
      | ((delayMs: number) => Promise<void>) = {},
    customWaitBeforeRetry: (delayMs: number) => Promise<void> = defaultWait,
  ): Promise<void> {
    const options = typeof optionsOrWait === 'function' ? {} : optionsOrWait;
    const waitBeforeRetry =
      typeof optionsOrWait === 'function'
        ? optionsOrWait
        : customWaitBeforeRetry;
    assertRequestActive(options);
    const normalizedRecordId = clean(recordId);
    if (!normalizedRecordId) {
      throw new BadRequestException('登记记录 ID 不能为空');
    }
    const config = await this.getConfig(options);
    const token = await this.getTenantAccessToken(options);
    const recordUrl = `${recordsUrl(config)}/${encodeURIComponent(
      normalizedRecordId,
    )}`;

    let deleteResponse;
    try {
      deleteResponse = await waitForRequest(
        this.httpService.axiosRef.delete(recordUrl, {
          ...requestConfig(token, options),
          params: { user_id_type: 'open_id' },
        }),
        options,
      );
    } catch (error) {
      const knownResponse = getHttpErrorResponse(error);
      if (knownResponse) {
        deleteResponse = knownResponse;
      } else {
        throw new ServiceUnavailableException('测试登记记录精确清理暂时失败');
      }
    }

    if (Number(deleteResponse.data?.code) !== 1254043) {
      assertFeishuSuccess(deleteResponse.data, '删除测试登记记录失败');
    }

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      let response;
      try {
        response = await waitForRequest(
          this.httpService.axiosRef.get(recordUrl, {
            ...requestConfig(token, options),
            params: { user_id_type: 'open_id' },
          }),
          options,
        );
      } catch (error) {
        const knownResponse = getHttpErrorResponse(error);
        if (knownResponse) {
          response = knownResponse;
        } else {
          if (
            !isRetryableNetworkError(error) ||
            attempt === RETRY_DELAYS_MS.length
          ) {
            throw new ServiceUnavailableException(
              '测试登记记录清理结果暂时无法确认',
            );
          }
          await waitBeforeRetryWithControls(
            waitBeforeRetry,
            RETRY_DELAYS_MS[attempt],
            options,
          );
          continue;
        }
      }

      if (Number(response.data?.code) === 1254043) return;
      assertFeishuSuccess(response.data, '确认测试登记记录已删除失败');
      const record = response.data?.data?.record as
        | BitableRecordItem
        | undefined;
      const returnedRecordId =
        clean(record?.record_id) || clean((record as { id?: unknown })?.id);
      if (returnedRecordId && returnedRecordId !== normalizedRecordId) {
        throw new BadGatewayException(
          '确认测试登记记录已删除失败：响应记录 ID 不一致',
        );
      }
      if (attempt === RETRY_DELAYS_MS.length) {
        throw new BadGatewayException(
          returnedRecordId
            ? '测试登记记录清理失败：记录仍然存在'
            : '确认测试登记记录已删除失败：响应缺少 record',
        );
      }
      await waitBeforeRetryWithControls(
        waitBeforeRetry,
        RETRY_DELAYS_MS[attempt],
        options,
      );
    }

    throw new ServiceUnavailableException('测试登记记录清理结果暂时无法确认');
  }

  async invalidateRegistrationCache(
    options: WeatherWarningRegistrationGatewayRequestOptions = {},
  ): Promise<void> {
    this.invalidate(await this.getConfig(options));
  }

  private async getConfig(
    options: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<ResolvedRegistrationConfig> {
    assertRequestActive(options);
    const config = loadWeatherWarningRegistrationRuntimeConfig();
    return {
      appToken: await this.getAppToken(config, options),
      tableId: config.registrationTableId,
      fields: config.registrationFields,
    };
  }

  private getAppToken(
    config: ReturnType<typeof loadWeatherWarningRegistrationRuntimeConfig>,
    options: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<string> {
    if (!this.appTokenPromise) {
      this.appTokenPromise = resolveBitableAppToken(this.httpService, {
        appToken: config.appToken,
        wikiToken: config.wikiToken,
        tableName: '天气预警重保检查登记表',
        requestTimeoutMs: () => requestTimeoutMs(options),
        waitFor: (promise) => waitForRequest(promise, options),
        waitBeforeRetry: (delayMs) =>
          waitBeforeRetryWithControls(defaultWait, delayMs, options),
      })
        .then((appToken) => {
          const normalized = clean(appToken);
          if (!normalized) {
            throw new Error('missing app token');
          }
          return normalized;
        })
        .catch(() => {
          this.appTokenPromise = null;
          throw new ServiceUnavailableException('登记数据源暂时不可用');
        });
    }
    return waitForRequest(this.appTokenPromise, options);
  }

  private async getTenantAccessToken(
    options: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<string> {
    assertRequestActive(options);
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 60_000) {
      return this.tokenState.value;
    }
    if (this.tokenPromise) return waitForRequest(this.tokenPromise, options);
    this.tokenPromise = this.requestTenantAccessToken(options).finally(() => {
      this.tokenPromise = null;
    });
    return waitForRequest(this.tokenPromise, options);
  }

  private async requestTenantAccessToken(
    options: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<string> {
    let response;
    try {
      response = await waitForRequest(
        this.httpService.axiosRef.post(
          'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
          getFeishuAuthPayload(),
          requestConfigWithoutAuth(options),
        ),
        options,
      );
    } catch (error) {
      throwExternalRequestError(
        error,
        '获取飞书访问令牌失败',
        '飞书访问令牌暂时不可用',
      );
    }
    assertFeishuSuccess(response.data, '获取飞书访问令牌失败');
    const token = clean(response.data?.tenant_access_token);
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

  private invalidate(config: ResolvedRegistrationConfig): void {
    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.tableId,
    });
  }
}

function recordsUrl(config: { appToken: string; tableId: string }): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`;
}

function requestConfig(
  token: string,
  options: WeatherWarningRegistrationGatewayRequestOptions,
  maxTimeoutMs = MAX_HTTP_TIMEOUT_MS,
) {
  return {
    ...requestConfigWithoutAuth(options, maxTimeoutMs),
    headers: { Authorization: `Bearer ${token}` },
  };
}

function requestConfigWithoutAuth(
  options: WeatherWarningRegistrationGatewayRequestOptions,
  maxTimeoutMs = MAX_HTTP_TIMEOUT_MS,
) {
  return {
    signal: options.signal,
    timeout: requestTimeoutMs(options, maxTimeoutMs),
  };
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  const record = asPlainRecord(payload);
  if (!record) {
    throw new BadGatewayException(`${prefix}：响应格式无效`);
  }
  if (record.code === 0) return;
  const code =
    record.code === undefined || record.code === null
      ? '缺少有效 code'
      : `错误码 ${String(record.code)}`;
  throw new BadGatewayException(`${prefix}：${code}`);
}

function throwUnlessRetryableNetworkError(
  error: unknown,
  prefix: string,
): void {
  if (isRetryableNetworkError(error)) return;
  if (error instanceof ServiceUnavailableException) throw error;
  const response = getHttpErrorResponse(error);
  if (response) {
    assertFeishuSuccess(response.data, prefix);
    throw new BadGatewayException(`${prefix}：HTTP 请求失败`);
  }
  throw new ServiceUnavailableException(`${prefix}暂时失败`);
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || getHttpErrorResponse(error)) {
    return false;
  }
  const name = clean((error as { name?: unknown }).name);
  if (name === 'AbortError' || name === 'CanceledError') return false;
  const code = clean((error as { code?: unknown }).code).toUpperCase();
  return RETRYABLE_NETWORK_CODES.has(code);
}

function throwExternalRequestError(
  error: unknown,
  prefix: string,
  unavailableMessage: string,
): never {
  const response = getHttpErrorResponse(error);
  if (response) {
    assertFeishuSuccess(response.data, prefix);
    throw new BadGatewayException(`${prefix}：HTTP 请求失败`);
  }
  throw new ServiceUnavailableException(unavailableMessage);
}

function getHttpErrorResponse(
  error: unknown,
): { data?: unknown; status?: unknown } | null {
  if (!error || typeof error !== 'object') return null;
  const response = asPlainRecord((error as { response?: unknown }).response);
  return response;
}

function assertRequestActive(
  options: WeatherWarningRegistrationGatewayRequestOptions,
): void {
  if (options.signal?.aborted) throw requestUnavailable();
  if (
    options.deadlineAt !== undefined &&
    (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= Date.now())
  ) {
    throw requestUnavailable();
  }
}

function requestTimeoutMs(
  options: WeatherWarningRegistrationGatewayRequestOptions,
  maxTimeoutMs = MAX_HTTP_TIMEOUT_MS,
): number {
  assertRequestActive(options);
  if (options.deadlineAt === undefined) return maxTimeoutMs;
  return Math.max(
    1,
    Math.min(maxTimeoutMs, Math.ceil(options.deadlineAt - Date.now())),
  );
}

async function waitBeforeRetryWithControls(
  waitBeforeRetry: (delayMs: number) => Promise<void>,
  delayMs: number,
  options: WeatherWarningRegistrationGatewayRequestOptions,
): Promise<void> {
  assertRequestActive(options);
  await waitForRequest(waitBeforeRetry(delayMs), options);
  assertRequestActive(options);
}

async function waitForRequest<T>(
  promise: Promise<T>,
  options: WeatherWarningRegistrationGatewayRequestOptions,
): Promise<T> {
  assertRequestActive(options);
  if (!options.signal && options.deadlineAt === undefined) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(requestUnavailable()));

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.deadlineAt !== undefined) {
      const remainingMs = Math.max(1, options.deadlineAt - Date.now());
      timer = setTimeout(
        () => finish(() => reject(requestUnavailable())),
        remainingMs,
      );
      timer.unref?.();
    }
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function requestUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('登记请求已取消或超过处理时限');
}

export function validateWeatherWarningRegistrationUploadFile(
  file: WeatherWarningRegistrationUploadFile,
): {
  fileName: string;
  mimeType: string;
} {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new BadRequestException('登记附件内容不能为空');
  }
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size !== file.buffer.length
  ) {
    throw new BadRequestException('登记附件大小元数据无效');
  }
  if (file.size > WEATHER_WARNING_REGISTRATION_MAX_IMAGE_BYTES) {
    throw new BadRequestException('登记附件不能超过 10 MiB');
  }

  const mimeType = clean(file.mimetype).toLowerCase();
  const allowedExtensions = IMAGE_EXTENSIONS_BY_MIME[mimeType];
  if (!allowedExtensions) {
    throw new BadRequestException('登记附件仅支持 PNG、JPEG、WebP 或 PDF');
  }
  const originalName = clean(file.originalname);
  const extension = getFileExtension(originalName).toLowerCase();
  if (!originalName || !allowedExtensions.includes(extension)) {
    throw new BadRequestException('登记附件扩展名与 MIME 类型不一致');
  }
  if (!hasExpectedAttachmentSignature(file.buffer, mimeType)) {
    throw new BadRequestException('登记附件内容与 MIME 类型不一致');
  }

  return { fileName: safeFileName(originalName), mimeType };
}

function hasExpectedAttachmentSignature(
  buffer: Buffer,
  mimeType: string,
): boolean {
  if (mimeType === 'image/png') {
    return (
      buffer.length >= PNG_SIGNATURE.length &&
      buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    );
  }
  if (mimeType === 'image/jpeg') {
    return (
      buffer.length >= JPEG_SIGNATURE.length &&
      buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)
    );
  }
  if (mimeType === 'application/pdf') {
    return (
      buffer.length >= PDF_SIGNATURE.length &&
      buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)
    );
  }
  return (
    mimeType === 'image/webp' &&
    buffer.length >= 12 &&
    buffer.subarray(0, 4).equals(RIFF_SIGNATURE) &&
    buffer.subarray(8, 12).equals(WEBP_SIGNATURE)
  );
}

function loadManagerSourceConfig(): ResolvedManagerSourceConfig {
  const dedicatedSourceUrl = readEnv(
    'FEISHU_WEATHER_WARNING_MANAGER_SOURCE_URL',
  );
  const dedicatedAppToken = readEnv('FEISHU_WEATHER_WARNING_MANAGER_APP_TOKEN');
  const dedicatedTableId = readEnv('FEISHU_WEATHER_WARNING_MANAGER_TABLE_ID');
  const hasDedicatedSource = Boolean(
    dedicatedSourceUrl || dedicatedAppToken || dedicatedTableId,
  );
  if (hasDedicatedSource) {
    const source = parseFeishuBitableLink(dedicatedSourceUrl);
    const appToken = dedicatedAppToken || source.appToken;
    const tableId = dedicatedTableId || source.tableId;
    if (!appToken || !tableId) {
      throw new ServiceUnavailableException('机房经理人员数据源未配置');
    }
    return { appToken, tableId };
  }

  const purchaseSource = parseFeishuBitableLink(
    readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'),
  );
  const appToken =
    readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') || purchaseSource.appToken;
  const tableId = readEnv('FEISHU_PURCHASE_ORGANIZATION_TABLE_ID');
  if (!appToken || !tableId) {
    throw new ServiceUnavailableException('机房经理人员数据源未配置');
  }
  return { appToken, tableId };
}

function safeFileName(value: string): string {
  const extension = getFileExtension(value);
  const sanitized = value.replace(/[\r\n\\/:*?"<>|\x00-\x1f]/gu, '_').trim();
  if (sanitized.length <= 200) return sanitized;
  return `${sanitized.slice(0, Math.max(1, 200 - extension.length))}${extension}`;
}

function getFileExtension(value: string): string {
  const index = value.lastIndexOf('.');
  return index >= 0 ? value.slice(index) : '';
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (Object.prototype.toString.call(value) !== '[object Object]') return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function defaultWait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}
