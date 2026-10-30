import { observedCardPost } from '../../common/feishu-card-copy/transport';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { getFeishuAuthPayload } from '@server/common/config/external-services.config';
import {
  invalidateBitableRecordCache,
  type BitableRecordItem,
  type BitableRecordSearchFilter,
} from '../../common/feishu/bitable-direct-read';

interface RecordSourceOptions {
  appToken: string;
  tableId: string;
  tableName: string;
}

interface ListRecordsOptions extends RecordSourceOptions {
  filter?: string;
  searchFilter?: BitableRecordSearchFilter;
}

interface SearchRecordsOptions extends RecordSourceOptions {
  filter?: BitableRecordSearchFilter;
}

type ReadRecordsRequest =
  | { mode: 'list'; options: ListRecordsOptions }
  | { mode: 'search'; options: SearchRecordsOptions };

export interface InventoryWorkflowFieldSchema {
  fieldName: string;
  type: number | null;
  uiType: string;
  /** Field-type capability only; actual write permission is still enforced by Feishu. */
  writable: boolean;
}

interface InventoryWorkflowRawField {
  field_name?: unknown;
  type?: unknown;
  ui_type?: unknown;
}

interface RecordListResponse {
  data: {
    code: 0;
    data: {
      items: BitableRecordItem[];
      page_token?: unknown;
      has_more: boolean;
    };
  };
}

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

const TEXT_FIELD_FILTER_READY_TOTAL_TIMEOUT_MS = 10_000;
const TEXT_FIELD_FILTER_READY_PROBE_TIMEOUT_MS = 1_500;
const TEXT_FIELD_FILTER_READY_RETRY_DELAYS_MS = [250, 500, 1_000, 1_500, 2_000];
const RECORD_QUERY_TOTAL_TIMEOUT_MS = 30_000;
const RECORD_QUERY_ATTEMPT_TIMEOUT_MS = 10_000;
const RECORD_QUERY_RETRY_DELAYS_MS = [
  250, 500, 1_000, 1_500, 2_000, 3_000, 5_000,
];
const TEXT_FIELD_READY_PROBE_VALUE = '__CODEX_TEXT_FIELD_READY_PROBE__';
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
]);
const TRANSIENT_RECORD_QUERY_FEISHU_CODES = new Set([
  1254290, 1254607, 99991400,
]);
const TRANSIENT_TEXT_FIELD_PROBE_FEISHU_CODES = new Set([1254045, 1254607]);
const DEFINITELY_REJECTED_RECORD_POST_HTTP_STATUSES = new Set([
  400, 401, 403, 404, 409, 422,
]);
const DEFINITELY_REJECTED_RECORD_POST_FEISHU_CODES = new Set([
  1254062, 1254290, 99991400,
]);
const DEFINITELY_REJECTED_RECORD_DELETE_HTTP_STATUSES = new Set([
  400, 401, 403, 409, 422,
]);
const WRITABLE_RECORD_FIELD_TYPES = new Set([
  1, 2, 3, 4, 5, 7, 11, 13, 15, 17, 18, 21, 22, 23,
]);

export class InventoryWorkflowRecordNotFoundError extends Error {
  readonly tableName: string;
  readonly recordId: string;

  constructor(tableName: string, recordId: string) {
    super(`${tableName}记录不存在`);
    this.name = 'InventoryWorkflowRecordNotFoundError';
    this.tableName = tableName;
    this.recordId = recordId;
  }
}

export class InventoryWorkflowRecordWriteUncertainError extends Error {
  constructor(tableName: string, cause?: unknown) {
    super(`新增${tableName}记录的写入结果暂不确定`, { cause });
    this.name = 'InventoryWorkflowRecordWriteUncertainError';
  }
}

export class InventoryWorkflowRecordDefinitelyNotWrittenError extends Error {
  constructor(tableName: string, cause?: unknown) {
    super(`新增${tableName}记录失败，已确认未写入`, { cause });
    this.name = 'InventoryWorkflowRecordDefinitelyNotWrittenError';
  }
}

export class InventoryWorkflowRecordDeleteUncertainError extends Error {
  constructor(tableName: string, cause?: unknown) {
    super(`删除${tableName}记录的结果暂不确定`, { cause });
    this.name = 'InventoryWorkflowRecordDeleteUncertainError';
  }
}

export class InventoryWorkflowRecordDefinitelyNotDeletedError extends Error {
  constructor(tableName: string, cause?: unknown) {
    super(`删除${tableName}记录失败，已确认记录未删除`, { cause });
    this.name = 'InventoryWorkflowRecordDefinitelyNotDeletedError';
  }
}

@Injectable()
export class InventoryWorkflowGateway {
  private readonly logger = new Logger(InventoryWorkflowGateway.name);
  private tokenState: TenantTokenState | null = null;
  private tokenPromise: Promise<string> | null = null;
  private readonly ensuredTextFields = new Set<string>();
  private readonly ensuringTextFields = new Map<string, Promise<void>>();
  private readonly ensuredNumberFields = new Set<string>();
  private readonly ensuringNumberFields = new Map<string, Promise<void>>();
  private readonly fieldsPendingFilterReadiness = new Set<string>();

  constructor(private readonly httpService: HttpService) {}

  async listRecords(options: ListRecordsOptions): Promise<BitableRecordItem[]> {
    assertTableConfig(options.tableName, options.appToken, options.tableId);
    const token = await this.getTenantAccessToken();
    if (options.searchFilter) {
      return this.readRecordPages(
        {
          mode: 'search',
          options: {
            appToken: options.appToken,
            tableId: options.tableId,
            tableName: options.tableName,
            filter: options.searchFilter,
          },
        },
        token,
      );
    }
    return this.readRecordPages({ mode: 'list', options }, token);
  }

  async searchRecords(
    options: SearchRecordsOptions,
  ): Promise<BitableRecordItem[]> {
    assertTableConfig(options.tableName, options.appToken, options.tableId);
    const token = await this.getTenantAccessToken();
    return this.readRecordPages({ mode: 'search', options }, token);
  }

  private async readRecordPages(
    request: ReadRecordsRequest,
    token: string,
  ): Promise<BitableRecordItem[]> {
    const records: BitableRecordItem[] = [];
    const deadline = Date.now() + RECORD_QUERY_TOTAL_TIMEOUT_MS;
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await this.readRecordPage(
        request,
        token,
        pageToken,
        deadline,
      );
      const data = response.data.data;
      records.push(...data.items);
      pageToken = clean(data.page_token) || undefined;
      hasMore = Boolean(data.has_more);
    }

    return records;
  }

  private async readRecordPage(
    request: ReadRecordsRequest,
    token: string,
    pageToken: string | undefined,
    deadline: number,
  ): Promise<RecordListResponse> {
    const { options } = request;
    let retryIndex = 0;
    let lastError: unknown;
    while (true) {
      const requestRemainingTime = deadline - Date.now();
      if (requestRemainingTime <= 0) {
        throw (
          lastError ||
          Object.assign(new Error(`读取${options.tableName}超时`), {
            code: 'ETIMEDOUT',
          })
        );
      }
      try {
        const config = {
          headers: authorizationHeader(token),
          timeout: Math.max(
            1,
            Math.min(RECORD_QUERY_ATTEMPT_TIMEOUT_MS, requestRemainingTime),
          ),
        };
        const url = recordCollectionUrl(options.appToken, options.tableId);
        const response =
          request.mode === 'search'
            ? await this.httpService.axiosRef.post(
                `${url}/search`,
                request.options.filter
                  ? { filter: request.options.filter }
                  : {},
                {
                  ...config,
                  params: { page_size: 500, page_token: pageToken },
                },
              )
            : await this.httpService.axiosRef.get(url, {
                ...config,
                params: {
                  page_size: 500,
                  page_token: pageToken,
                  filter: request.options.filter || undefined,
                },
              });
        assertFeishuSuccess(response.data, `读取${options.tableName}失败`);
        assertListPagePayload<BitableRecordItem>(
          response.data,
          `读取${options.tableName}失败`,
        );
        return response as RecordListResponse;
      } catch (error) {
        if (!isTransientRecordQueryError(error)) {
          throw error;
        }
        lastError = error;
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) throw error;
        const retryDelay = Math.min(
          RECORD_QUERY_RETRY_DELAYS_MS[
            Math.min(retryIndex, RECORD_QUERY_RETRY_DELAYS_MS.length - 1)
          ],
          remainingTime,
        );
        retryIndex += 1;
        await delay(retryDelay);
      }
    }
  }

  async getRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    tableName: string,
  ): Promise<BitableRecordItem> {
    return (await this.getRecords(appToken, tableId, [recordId], tableName))[0];
  }

  async getRecords(
    appToken: string,
    tableId: string,
    recordIds: readonly string[],
    tableName: string,
  ): Promise<BitableRecordItem[]> {
    assertTableConfig(tableName, appToken, tableId);
    if (!Array.isArray(recordIds) || recordIds.some(id => !clean(id) || clean(id) !== id))
      throw new Error(`读取${tableName}记录失败：记录标识无效`);
    const ids = [...new Set(recordIds)];
    const records: BitableRecordItem[] = [];
    // Feishu batch_get accepts at most 100 IDs; each batch has its own retry budget.
    for (let index = 0; index < ids.length; index += 100)
      records.push(...await this.readRecordBatch(appToken, tableId, ids.slice(index, index + 100), tableName));
    return records;
  }

  private async readRecordBatch(
    appToken: string,
    tableId: string,
    recordIds: readonly string[],
    tableName: string,
  ): Promise<BitableRecordItem[]> {
    assertTableConfig(tableName, appToken, tableId);
    const token = await this.getTenantAccessToken();
    let response: { data?: unknown };
    const deadline = Date.now() + RECORD_QUERY_TOTAL_TIMEOUT_MS;
    let retryIndex = 0;
    let lastError: unknown;
    while (true) {
      const requestRemainingTime = deadline - Date.now();
      if (requestRemainingTime <= 0) {
        throw (
          lastError ||
          Object.assign(new Error(`读取${tableName}记录超时`), {
            code: 'ETIMEDOUT',
          })
        );
      }
      try {
        response = await this.httpService.axiosRef.post(
          `${recordCollectionUrl(appToken, tableId)}/batch_get`,
          { record_ids: recordIds },
          {
            headers: authorizationHeader(token),
            timeout: Math.max(
              1,
              Math.min(RECORD_QUERY_ATTEMPT_TIMEOUT_MS, requestRemainingTime),
            ),
          },
        );
        assertFeishuSuccess(response.data, `读取${tableName}记录失败`);
        break;
      } catch (error) {
        if (!isTransientRecordQueryError(error)) throw error;
        lastError = error;
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) throw error;
        const retryDelay = Math.min(
          RECORD_QUERY_RETRY_DELAYS_MS[
            Math.min(retryIndex, RECORD_QUERY_RETRY_DELAYS_MS.length - 1)
          ],
          remainingTime,
        );
        retryIndex += 1;
        await delay(retryDelay);
      }
    }
    const data = (
      response.data as
        | {
            data?: {
              records?: unknown;
              absent_record_ids?: unknown;
              forbidden_record_ids?: unknown;
            };
          }
        | undefined
    )?.data;
    if (
      Array.isArray(data?.absent_record_ids) &&
      data.absent_record_ids.some(id => recordIds.includes(id))
    ) {
      throw new InventoryWorkflowRecordNotFoundError(tableName, recordIds.find(id => (data.absent_record_ids as unknown[]).includes(id))!);
    }
    if (
      Array.isArray(data?.forbidden_record_ids) &&
      data.forbidden_record_ids.some(id => recordIds.includes(id))
    ) {
      throw new Error(`读取${tableName}记录失败：无权读取目标记录`);
    }
    if (!Array.isArray(data?.records)) {
      throw new Error(`读取${tableName}记录失败：响应缺少 records`);
    }
    const matchingRecords = data.records.filter(
      (candidate): candidate is BitableRecordItem =>
        isRecord(candidate) &&
        recordIds.includes(clean(candidate.record_id)) &&
        isRecord(candidate.fields),
    );
    if (new Set(matchingRecords.map(record => record.record_id)).size !== matchingRecords.length) {
      throw new Error(`读取${tableName}记录失败：返回重复 record_id`);
    }
    if (matchingRecords.length !== recordIds.length || matchingRecords.length !== data.records.length)
      throw new Error(`读取${tableName}记录失败：响应缺少目标记录或包含非目标记录`);
    const byId = new Map(matchingRecords.map(record => [record.record_id, record]));
    return recordIds.map(id => byId.get(id)!);
  }

  async tryGetRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    tableName: string,
  ): Promise<BitableRecordItem | undefined> {
    try {
      return await this.getRecord(appToken, tableId, recordId, tableName);
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  invalidateRecordsCache(appToken: string, tableId: string): void {
    assertTableConfig('飞书多维表', appToken, tableId);
    invalidateBitableRecordCache({ appToken, tableId, deletePersisted: true });
  }

  async createRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>,
    tableName: string,
  ): Promise<string> {
    let token: string;
    try {
      assertTableConfig(tableName, appToken, tableId);
      token = await this.getTenantAccessToken();
    } catch (error) {
      throw new InventoryWorkflowRecordDefinitelyNotWrittenError(
        tableName,
        error,
      );
    }

    let response: { data?: any };
    try {
      response = await this.httpService.axiosRef.post(
        recordCollectionUrl(appToken, tableId),
        { fields },
        {
          headers: authorizationHeader(token),
          timeout: 30_000,
        },
      );
    } catch (error) {
      if (recordPostWasDefinitelyRejected(error)) {
        throw new InventoryWorkflowRecordDefinitelyNotWrittenError(
          tableName,
          error,
        );
      }
      throw new InventoryWorkflowRecordWriteUncertainError(tableName, error);
    }

    try {
      assertFeishuSuccess(response.data, `新增${tableName}记录失败`);
    } catch (error) {
      if (recordPostWasDefinitelyRejected(error)) {
        throw new InventoryWorkflowRecordDefinitelyNotWrittenError(
          tableName,
          error,
        );
      }
      throw new InventoryWorkflowRecordWriteUncertainError(tableName, error);
    }
    const recordId = clean(
      response.data?.data?.record?.record_id || response.data?.data?.record_id,
    );
    if (!recordId) {
      const responseSummary = summarizeRecordCreateResponse(response);
      this.logger.warn(
        `新增${tableName}记录成功响应缺少 record_id：${responseSummary}`,
      );
      throw new InventoryWorkflowRecordWriteUncertainError(
        tableName,
        new Error(
          `新增${tableName}记录失败：响应缺少 record_id；${responseSummary}`,
        ),
      );
    }
    try {
      invalidateBitableRecordCache({
        appToken,
        tableId,
        deletePersisted: true,
      });
    } catch (error) {
      throw new InventoryWorkflowRecordWriteUncertainError(tableName, error);
    }
    return recordId;
  }

  async updateRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
    tableName: string,
  ): Promise<void> {
    assertTableConfig(tableName, appToken, tableId);
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.put(
      `${recordCollectionUrl(appToken, tableId)}/${encodeURIComponent(recordId)}`,
      { fields },
      {
        headers: authorizationHeader(token),
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, `更新${tableName}记录失败`);
    invalidateBitableRecordCache({ appToken, tableId, deletePersisted: true });
  }

  async deleteRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    tableName: string,
  ): Promise<void> {
    assertTableConfig(tableName, appToken, tableId);
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.delete(
      `${recordCollectionUrl(appToken, tableId)}/${encodeURIComponent(recordId)}`,
      {
        headers: authorizationHeader(token),
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, `删除${tableName}记录失败`);
    invalidateBitableRecordCache({ appToken, tableId, deletePersisted: true });
  }

  async deleteRecordAndConfirmAbsent(
    appToken: string,
    tableId: string,
    recordId: string,
    tableName: string,
  ): Promise<void> {
    let token: string;
    try {
      assertTableConfig(tableName, appToken, tableId);
      token = await this.getTenantAccessToken();
    } catch (error) {
      throw new InventoryWorkflowRecordDefinitelyNotDeletedError(
        tableName,
        error,
      );
    }

    try {
      const response = await this.httpService.axiosRef.delete(
        `${recordCollectionUrl(appToken, tableId)}/${encodeURIComponent(recordId)}`,
        {
          headers: authorizationHeader(token),
          timeout: 30_000,
        },
      );
      if (isRecordNotFoundPayload(response.data)) return;
      if (!isExplicitFeishuResponseCode(response.data, 0)) {
        const payloadError = new Error(
          `删除${tableName}记录失败：响应状态无效`,
        );
        if (!hasExplicitNonzeroFeishuResponseCode(response.data)) {
          throw new InventoryWorkflowRecordDeleteUncertainError(
            tableName,
            payloadError,
          );
        }
        throw new InventoryWorkflowRecordDefinitelyNotDeletedError(
          tableName,
          payloadError,
        );
      }
    } catch (error) {
      if (error instanceof InventoryWorkflowRecordDefinitelyNotDeletedError) {
        throw error;
      }
      const status = httpStatus(error);
      if (status === 404) return;
      if (DEFINITELY_REJECTED_RECORD_DELETE_HTTP_STATUSES.has(status)) {
        throw new InventoryWorkflowRecordDefinitelyNotDeletedError(
          tableName,
          error,
        );
      }
      throw new InventoryWorkflowRecordDeleteUncertainError(tableName, error);
    }

    let persisted: BitableRecordItem | undefined;
    try {
      persisted = await this.tryGetRecord(
        appToken,
        tableId,
        recordId,
        tableName,
      );
    } catch (error) {
      throw new InventoryWorkflowRecordDeleteUncertainError(tableName, error);
    }
    if (persisted) {
      throw new InventoryWorkflowRecordDefinitelyNotDeletedError(
        tableName,
        new Error('删除后回读仍存在'),
      );
    }
    try {
      invalidateBitableRecordCache({
        appToken,
        tableId,
        deletePersisted: true,
      });
    } catch (error) {
      this.logger.warn(
        `${tableName}记录已确认删除，但本地缓存失效失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async ensureTextField(
    appToken: string,
    tableId: string,
    fieldName: string,
    tableName: string,
  ): Promise<void> {
    assertTableConfig(tableName, appToken, tableId);
    const normalizedFieldName = fieldName.trim();
    if (!normalizedFieldName) throw new Error(`${tableName}字段名不能为空`);
    const cacheKey = `${appToken}:${tableId}:${normalizedFieldName}`;
    if (this.ensuredTextFields.has(cacheKey)) return;
    const active = this.ensuringTextFields.get(cacheKey);
    if (active) return active;

    const operation = (async () => {
      const token = await this.getTenantAccessToken();
      const fields = await this.listFields(appToken, tableId, token, tableName);
      const existing = fields.find(
        (field) => clean(field?.field_name) === normalizedFieldName,
      );
      if (existing) {
        if (Number(existing.type) !== 1) {
          throw new Error(
            `${tableName}字段“${normalizedFieldName}”必须是文本类型`,
          );
        }
        if (this.fieldsPendingFilterReadiness.has(cacheKey)) {
          await this.waitForTextFieldFilterAvailability(
            appToken,
            tableId,
            normalizedFieldName,
            token,
            tableName,
          );
          this.fieldsPendingFilterReadiness.delete(cacheKey);
        }
        this.ensuredTextFields.add(cacheKey);
        return;
      }

      const response = await this.httpService.axiosRef.post(
        fieldCollectionUrl(appToken, tableId),
        { field_name: normalizedFieldName, type: 1 },
        {
          headers: authorizationHeader(token),
          timeout: 30_000,
        },
      );
      assertFeishuSuccess(response.data, `新增${tableName}字段失败`);
      invalidateBitableRecordCache({ appToken, tableId });
      this.fieldsPendingFilterReadiness.add(cacheKey);
      await this.waitForTextFieldFilterAvailability(
        appToken,
        tableId,
        normalizedFieldName,
        token,
        tableName,
      );
      this.fieldsPendingFilterReadiness.delete(cacheKey);
      this.ensuredTextFields.add(cacheKey);
    })();
    this.ensuringTextFields.set(cacheKey, operation);
    try {
      await operation;
    } finally {
      if (this.ensuringTextFields.get(cacheKey) === operation) {
        this.ensuringTextFields.delete(cacheKey);
      }
    }
  }

  async ensureNumberField(
    appToken: string,
    tableId: string,
    fieldName: string,
    tableName: string,
  ): Promise<void> {
    assertTableConfig(tableName, appToken, tableId);
    const normalizedFieldName = fieldName.trim();
    if (!normalizedFieldName) throw new Error(`${tableName}字段名不能为空`);
    const cacheKey = `${appToken}:${tableId}:${normalizedFieldName}`;
    if (this.ensuredNumberFields.has(cacheKey)) return;
    const active = this.ensuringNumberFields.get(cacheKey);
    if (active) return active;

    const operation = (async () => {
      const token = await this.getTenantAccessToken();
      const fields = await this.listFields(appToken, tableId, token, tableName);
      const existing = fields.find(
        (field) => clean(field?.field_name) === normalizedFieldName,
      );
      if (existing) {
        if (Number(existing.type) !== 2) {
          throw new Error(
            `${tableName}字段“${normalizedFieldName}”必须是数字类型`,
          );
        }
        this.ensuredNumberFields.add(cacheKey);
        return;
      }

      const response = await this.httpService.axiosRef.post(
        fieldCollectionUrl(appToken, tableId),
        { field_name: normalizedFieldName, type: 2 },
        {
          headers: authorizationHeader(token),
          timeout: 30_000,
        },
      );
      assertFeishuSuccess(response.data, `新增${tableName}字段失败`);
      invalidateBitableRecordCache({ appToken, tableId });
      this.ensuredNumberFields.add(cacheKey);
    })();
    this.ensuringNumberFields.set(cacheKey, operation);
    try {
      await operation;
    } finally {
      if (this.ensuringNumberFields.get(cacheKey) === operation) {
        this.ensuringNumberFields.delete(cacheKey);
      }
    }
  }

  async getFieldNames(
    appToken: string,
    tableId: string,
    tableName: string,
  ): Promise<string[]> {
    const schemas = await this.getFieldSchemas(appToken, tableId, tableName);
    return schemas.map((field) => field.fieldName);
  }

  async getFieldSchemas(
    appToken: string,
    tableId: string,
    tableName: string,
  ): Promise<InventoryWorkflowFieldSchema[]> {
    assertTableConfig(tableName, appToken, tableId);
    const token = await this.getTenantAccessToken();
    const fields = await this.listFields(appToken, tableId, token, tableName);
    const schemas = new Map<string, InventoryWorkflowFieldSchema>();
    fields.forEach((field) => {
      const fieldName = clean(field.field_name);
      if (!fieldName || schemas.has(fieldName)) return;
      const parsedType = Number(field.type);
      const type = Number.isInteger(parsedType) ? parsedType : null;
      schemas.set(fieldName, {
        fieldName,
        type,
        uiType: clean(field.ui_type),
        writable: type !== null && WRITABLE_RECORD_FIELD_TYPES.has(type),
      });
    });
    return [...schemas.values()];
  }

  async sendInteractiveCard(
    receiverOpenId: string,
    card: Record<string, unknown>,
  ): Promise<string> {
    if (!/^ou_[A-Za-z0-9]+$/.test(receiverOpenId)) {
      throw new Error('发送飞书卡片失败：接收人 OpenID 无效');
    }
    const token = await this.getTenantAccessToken();
    const response = await observedCardPost(this.httpService.axiosRef, 'inventory',
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: receiverOpenId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      {
        headers: authorizationHeader(token),
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, '发送飞书卡片失败');
    const messageId = clean(response.data?.data?.message_id);
    if (!messageId) throw new Error('发送飞书卡片失败：响应缺少 message_id');
    return messageId;
  }

  recordLink(appToken: string, tableId: string, recordId: string): string {
    const query = new URLSearchParams({ table: tableId, record: recordId });
    return `https://vnet.feishu.cn/base/${appToken}?${query.toString()}`;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenState && this.tokenState.expiresAt > now) {
      return this.tokenState.value;
    }
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      const response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        { timeout: 30_000 },
      );
      assertFeishuSuccess(response.data, '获取飞书租户令牌失败');
      const value = clean(response.data?.tenant_access_token);
      if (!value) throw new Error('获取飞书租户令牌失败：响应缺少令牌');
      const expiresInSeconds = Number(response.data?.expire);
      const safeLifetimeMs = Number.isFinite(expiresInSeconds)
        ? Math.max(60, expiresInSeconds - 300) * 1000
        : 90 * 60 * 1000;
      this.tokenState = { value, expiresAt: Date.now() + safeLifetimeMs };
      return value;
    })();

    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async listFields(
    appToken: string,
    tableId: string,
    token: string,
    tableName: string,
  ): Promise<InventoryWorkflowRawField[]> {
    const fields: InventoryWorkflowRawField[] = [];
    const deadline = Date.now() + RECORD_QUERY_TOTAL_TIMEOUT_MS;
    let pageToken: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const data = await this.readFieldPage(
        appToken,
        tableId,
        token,
        tableName,
        pageToken,
        deadline,
      );
      fields.push(...data.items);
      pageToken = clean(data.page_token) || undefined;
      hasMore = Boolean(data.has_more);
    }
    return fields;
  }

  private async readFieldPage(
    appToken: string,
    tableId: string,
    token: string,
    tableName: string,
    pageToken: string | undefined,
    deadline: number,
  ): Promise<{
    items: InventoryWorkflowRawField[];
    page_token?: unknown;
    has_more: boolean;
  }> {
    let retryIndex = 0;
    let lastError: unknown;
    while (true) {
      const requestRemainingTime = deadline - Date.now();
      if (requestRemainingTime <= 0) {
        throw (
          lastError ||
          Object.assign(new Error(`读取${tableName}字段超时`), {
            code: 'ETIMEDOUT',
          })
        );
      }
      try {
        const response = await this.httpService.axiosRef.get(
          fieldCollectionUrl(appToken, tableId),
          {
            headers: authorizationHeader(token),
            params: { page_size: 100, page_token: pageToken },
            timeout: Math.max(
              1,
              Math.min(RECORD_QUERY_ATTEMPT_TIMEOUT_MS, requestRemainingTime),
            ),
          },
        );
        assertFeishuSuccess(response.data, `读取${tableName}字段失败`);
        assertListPagePayload<InventoryWorkflowRawField>(
          response.data,
          `读取${tableName}字段失败`,
        );
        return response.data.data;
      } catch (error) {
        if (!isTransientNetworkError(error)) throw error;
        lastError = error;
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) throw error;
        const retryDelay = Math.min(
          RECORD_QUERY_RETRY_DELAYS_MS[
            Math.min(retryIndex, RECORD_QUERY_RETRY_DELAYS_MS.length - 1)
          ],
          remainingTime,
        );
        retryIndex += 1;
        await delay(retryDelay);
      }
    }
  }

  private async waitForTextFieldFilterAvailability(
    appToken: string,
    tableId: string,
    fieldName: string,
    token: string,
    tableName: string,
  ): Promise<void> {
    const deadline = Date.now() + TEXT_FIELD_FILTER_READY_TOTAL_TIMEOUT_MS;
    let retryIndex = 0;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const remainingTime = Math.max(1, deadline - Date.now());
        const response = await this.httpService.axiosRef.get(
          recordCollectionUrl(appToken, tableId),
          {
            headers: authorizationHeader(token),
            params: {
              page_size: 1,
              filter: `CurrentValue.[${fieldName}]="${TEXT_FIELD_READY_PROBE_VALUE}"`,
            },
            timeout: Math.min(
              TEXT_FIELD_FILTER_READY_PROBE_TIMEOUT_MS,
              remainingTime,
            ),
          },
        );
        assertFeishuSuccess(response.data, `验证${tableName}字段筛选失败`);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientTextFieldProbeError(error)) {
          throw error;
        }
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) throw error;
        const retryDelay = Math.min(
          TEXT_FIELD_FILTER_READY_RETRY_DELAYS_MS[
            Math.min(
              retryIndex,
              TEXT_FIELD_FILTER_READY_RETRY_DELAYS_MS.length - 1,
            )
          ],
          remainingTime,
        );
        retryIndex += 1;
        await delay(retryDelay);
      }
    }
    throw lastError || new Error(`验证${tableName}字段筛选超时`);
  }
}

export function escapeBaseFilterText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function recordCollectionUrl(appToken: string, tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
}

function fieldCollectionUrl(appToken: string, tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
}

function authorizationHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function httpStatus(error: unknown): number {
  return Number(
    (error as { response?: { status?: unknown } } | null)?.response?.status,
  );
}

function recordPostWasDefinitelyRejected(error: unknown): boolean {
  return (
    DEFINITELY_REJECTED_RECORD_POST_HTTP_STATUSES.has(httpStatus(error)) ||
    DEFINITELY_REJECTED_RECORD_POST_FEISHU_CODES.has(feishuErrorCode(error))
  );
}

function isExplicitFeishuResponseCode(
  payload: unknown,
  expected: number,
): boolean {
  return (
    typeof (payload as { code?: unknown } | null)?.code === 'number' &&
    Number.isInteger((payload as { code: number }).code) &&
    (payload as { code: number }).code === expected
  );
}

function hasExplicitNonzeroFeishuResponseCode(payload: unknown): boolean {
  const code = (payload as { code?: unknown } | null)?.code;
  return typeof code === 'number' && Number.isInteger(code) && code !== 0;
}

function isTransientTextFieldProbeError(error: unknown): boolean {
  const feishuCode = feishuErrorCode(error);
  if (TRANSIENT_TEXT_FIELD_PROBE_FEISHU_CODES.has(feishuCode)) {
    return true;
  }
  return isTransientNetworkError(error);
}

function isTransientRecordQueryError(error: unknown): boolean {
  if (TRANSIENT_RECORD_QUERY_FEISHU_CODES.has(feishuErrorCode(error))) {
    return true;
  }
  return isTransientNetworkError(error);
}

function feishuErrorCode(error: unknown): number {
  return Number(
    (error as { feishuCode?: unknown } | null)?.feishuCode ??
      (
        error as {
          response?: { data?: { code?: unknown } };
        } | null
      )?.response?.data?.code,
  );
}

function isTransientNetworkError(error: unknown): boolean {
  const directCode = clean(
    (error as { code?: unknown } | null)?.code,
  ).toUpperCase();
  return TRANSIENT_NETWORK_ERROR_CODES.has(directCode);
}

function isRecordNotFoundPayload(payload: unknown): boolean {
  const data = payload as { code?: unknown; msg?: unknown } | null;
  if (!data || Number(data.code) === 0) return false;
  const message = clean(data.msg).toLowerCase();
  return (
    message.includes('recordidnotfound') ||
    (message.includes('record') && message.includes('not found')) ||
    message.includes('记录不存在')
  );
}

function assertTableConfig(
  tableName: string,
  appToken: string,
  tableId: string,
): void {
  if (!appToken || !tableId) {
    throw new Error(`${tableName}工作流配置缺失`);
  }
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  if (!isRecord(payload) || typeof payload.code !== 'number') {
    throw new Error(`${prefix}：响应结构无效`);
  }
  if (payload.code === 0) return;
  const feishuCode = payload.code;
  const error = new Error(
    `${prefix}：${clean(payload.msg) || `错误码 ${String(payload.code)}`}`,
  ) as Error & { feishuCode?: number };
  if (Number.isFinite(feishuCode)) {
    error.feishuCode = feishuCode;
  }
  throw error;
}

function summarizeRecordCreateResponse(response: unknown): string {
  const envelope = response as {
    status?: unknown;
    data?: {
      code?: unknown;
      msg?: unknown;
      data?: unknown;
    };
  } | null;
  const responseData = isRecord(envelope?.data?.data)
    ? envelope?.data?.data
    : undefined;
  const record = isRecord(responseData?.record)
    ? responseData.record
    : undefined;
  return [
    `http=${Number.isFinite(Number(envelope?.status)) ? String(envelope?.status) : 'unknown'}`,
    `code=${Number.isFinite(Number(envelope?.data?.code)) ? String(envelope?.data?.code) : 'unknown'}`,
    `msg=${clean(envelope?.data?.msg) || '-'}`,
    `dataKeys=${responseData ? Object.keys(responseData).sort().join(',') || '-' : '-'}`,
    `recordKeys=${record ? Object.keys(record).sort().join(',') || '-' : '-'}`,
  ].join(' ');
}

function assertListPagePayload<T>(
  payload: unknown,
  prefix: string,
): asserts payload is {
  code: 0;
  data: { items: T[]; has_more: boolean; page_token?: unknown };
} {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new Error(`${prefix}：响应结构无效`);
  }
  const data = payload.data;
  if (data.items === undefined && data.total === 0 && data.has_more === false) {
    data.items = [];
  }
  if (
    !Array.isArray(data.items) ||
    typeof data.has_more !== 'boolean' ||
    (data.has_more && !clean(data.page_token))
  ) {
    throw new Error(`${prefix}：响应结构无效`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
