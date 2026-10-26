import { HttpService } from '@nestjs/axios';
import { BadGatewayException, Injectable } from '@nestjs/common';
import {
  getFeishuAuthPayload,
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  invalidateBitableRecordCache,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

const DEFAULT_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const DEFAULT_WIKI_TOKEN = 'SiW9wuy9DiIsykkTkNUcM0HfnSb';
const DEFAULT_EXECUTION_TABLE_ID = 'tbl1171c5349e996';
const EXPIRY_DISPOSITION_FIELD = '合同到期处置';

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface ExecutionTableConfig {
  appToken: string;
  tableId: string;
}

interface BitableFieldMeta {
  field_id: string;
  field_name: string;
  type: number;
}

@Injectable()
export class ContractExpiryDispositionGateway {
  private tokenState: TenantTokenState | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async getContract(recordId: string): Promise<BitableRecordItem> {
    const config = await this.getConfig();
    const token = await this.getTenantAccessToken();
    const response = await requestFeishuWithRetry(
      () =>
        this.httpService.axiosRef.get(
          `${recordsUrl(config)}/${encodeURIComponent(recordId)}`,
          {
            ...requestConfig(token),
            params: { user_id_type: 'open_id' },
          },
        ),
      '读取合同记录',
    );
    assertFeishuSuccess(response.data, '读取合同记录失败');
    const record = response.data?.data?.record as BitableRecordItem | undefined;
    if (!record) {
      throw new BadGatewayException('读取合同记录失败：响应缺少 record');
    }
    return record;
  }

  async updateContract(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    return this.writeContract(
      recordId,
      fields,
      EXPIRY_DISPOSITION_FIELD in fields ? [EXPIRY_DISPOSITION_FIELD] : [],
    );
  }

  async updateTextField(
    recordId: string,
    fieldName: string,
    value: string,
  ): Promise<void> {
    return this.writeContract(recordId, { [fieldName]: value }, [fieldName]);
  }

  private async writeContract(
    recordId: string,
    fields: Record<string, unknown>,
    requiredTextFields: string[],
  ): Promise<void> {
    const config = await this.getConfig();
    const token = await this.getTenantAccessToken();
    const fieldMetas = await this.listFields(config, token);

    if ('合同结束日期' in fields) {
      const endDateField = fieldMetas.find(
        (field) => field.field_name === '合同结束日期',
      );
      if (!endDateField) {
        throw new BadGatewayException(
          '执行合同表缺少「合同结束日期」字段，无法续期',
        );
      }
      if (endDateField.type !== 5) {
        throw new BadGatewayException(
          '执行合同表「合同结束日期」不是日期字段，已拒绝写入',
        );
      }
    }

    for (const fieldName of requiredTextFields) {
      await this.ensureTextField(config, token, fieldMetas, fieldName);
    }

    const response = await requestFeishuWithRetry(
      () =>
        this.httpService.axiosRef.put(
          `${recordsUrl(config)}/${encodeURIComponent(recordId)}`,
          { fields },
          {
            ...requestConfig(token),
            params: {
              ignore_consistency_check: true,
              user_id_type: 'open_id',
            },
          },
        ),
      '更新合同',
    );
    assertFeishuSuccess(response.data, '更新合同字段失败');
    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.tableId,
    });
  }

  private async ensureTextField(
    config: ExecutionTableConfig,
    token: string,
    fieldMetas: BitableFieldMeta[],
    fieldName: string,
  ): Promise<void> {
    const existing = fieldMetas.find((field) => field.field_name === fieldName);
    if (existing) {
      if (existing.type !== 1) {
        throw new BadGatewayException(
          `执行合同表「${fieldName}」不是文本字段，已拒绝写入`,
        );
      }
      return;
    }

    const response = await this.httpService.axiosRef.post(
      fieldsUrl(config),
      {
        field_name: fieldName,
        type: 1,
      },
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, `创建「${fieldName}」字段失败`);
  }

  private async listFields(
    config: ExecutionTableConfig,
    token: string,
  ): Promise<BitableFieldMeta[]> {
    const fields: BitableFieldMeta[] = [];
    let pageToken: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const response = await requestFeishuWithRetry(
        () =>
          this.httpService.axiosRef.get(fieldsUrl(config), {
            ...requestConfig(token),
            params: { page_size: 200, page_token: pageToken },
          }),
        '读取合同表字段',
      );
      assertFeishuSuccess(response.data, '读取执行合同表字段失败');
      const data = response.data?.data || {};
      fields.push(...(Array.isArray(data.items) ? data.items : []));
      hasMore = Boolean(data.has_more);
      pageToken = clean(data.page_token) || undefined;
    }
    return fields;
  }

  private async getConfig(): Promise<ExecutionTableConfig> {
    const sourceUrl =
      readEnv('FEISHU_CONTRACT_SOURCE_URL') || DEFAULT_SOURCE_URL;
    const parsed = parseFeishuBitableLink(sourceUrl);
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: readEnv('FEISHU_CONTRACT_APP_TOKEN') || parsed.appToken,
      wikiToken:
        readEnv('FEISHU_CONTRACT_WIKI_TOKEN') ||
        parsed.wikiToken ||
        DEFAULT_WIKI_TOKEN,
      tableName: '南通运维全景驾驶舱-合同&采购管理',
    });
    return {
      appToken,
      tableId:
        readEnv('FEISHU_CONTRACT_EXECUTION_TABLE_ID') ||
        DEFAULT_EXECUTION_TABLE_ID,
    };
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
    const response = await requestFeishuWithRetry(
      () =>
        this.httpService.axiosRef.post(
          'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
          getFeishuAuthPayload(),
          { timeout: 30_000 },
        ),
      '获取飞书访问令牌',
    );
    assertFeishuSuccess(response.data, '获取飞书访问令牌失败');
    const token = clean(response.data?.tenant_access_token);
    if (!token) {
      throw new BadGatewayException('获取飞书访问令牌失败：响应缺少 token');
    }
    const expireSeconds = Number(response.data?.expire) || 7_200;
    this.tokenState = {
      value: token,
      expiresAt: Date.now() + expireSeconds * 1_000,
    };
    return token;
  }
}

function recordsUrl(config: ExecutionTableConfig): string {
  return `${fieldsUrl(config).replace(/\/fields$/, '')}/records`;
}

function fieldsUrl(config: ExecutionTableConfig): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/fields`;
}

function requestConfig(token: string): {
  headers: { Authorization: string };
  timeout: number;
} {
  return {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
  };
}

async function requestFeishuWithRetry<T>(
  request: () => Promise<T>,
  operation: string,
): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isRetryableFeishuError(error) || attempt === maxAttempts) break;
      await delay(attempt * 100);
    }
  }
  throw sanitizeFeishuRequestError(lastError, operation);
}

function isRetryableFeishuError(error: unknown): boolean {
  const value = error as
    | { code?: unknown; response?: { status?: unknown } }
    | undefined;
  const code = typeof value?.code === 'string' ? value.code : '';
  const status = Number(value?.response?.status) || 0;
  return (
    [
      'ECONNABORTED',
      'ECONNRESET',
      'EAI_AGAIN',
      'ERR_NETWORK',
      'ETIMEDOUT',
    ].includes(code) ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

function sanitizeFeishuRequestError(
  error: unknown,
  operation: string,
): BadGatewayException {
  if (error instanceof BadGatewayException) return error;
  const value = error as
    | { code?: unknown; response?: { status?: unknown } }
    | undefined;
  const code = typeof value?.code === 'string' ? value.code : '';
  const status = Number(value?.response?.status) || 0;
  if (status === 403 && operation === '更新合同') {
    return new BadGatewayException(
      '飞书多维表拒绝更新合同，请检查应用的记录编辑权限',
    );
  }
  if (
    ['ECONNABORTED', 'ECONNRESET', 'ERR_NETWORK', 'ETIMEDOUT'].includes(code) ||
    status === 408
  ) {
    return new BadGatewayException(
      `${operation}失败：飞书多维表暂时无响应，后台重试仍失败`,
    );
  }
  if (status) {
    return new BadGatewayException(
      `${operation}失败：飞书多维表返回 HTTP ${status}`,
    );
  }
  return new BadGatewayException(`${operation}失败：无法连接飞书多维表`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  const data = payload as { code?: number; msg?: string } | null;
  if (data?.code === undefined || data.code === 0) return;
  throw new BadGatewayException(
    `${prefix}：${clean(data.msg) || `错误码 ${data.code}`}`,
  );
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
