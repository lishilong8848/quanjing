import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import FormData = require('form-data');
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
import type { BitableFieldMeta } from './contract-creation.rules';

const DEFAULT_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/SiW9wuy9DiIsykkTkNUcM0HfnSb?table=tblQehMrGf4zIfnt&view=vewmu8EPpy';
const DEFAULT_WIKI_TOKEN = 'SiW9wuy9DiIsykkTkNUcM0HfnSb';

export type ContractCreateTableKind =
  | 'framework'
  | 'execution'
  | 'supplier'
  | 'payment'
  | 'organization';

export interface ContractCreateUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export class ContractCreateIndeterminateError extends Error {
  readonly cause: unknown;

  constructor(
    readonly kind: ContractCreateTableKind,
    readonly clientToken: string,
    cause: unknown,
  ) {
    super(`新增${kind}记录的提交状态无法确认`);
    this.name = 'ContractCreateIndeterminateError';
    this.cause = cause;
  }
}

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface ContractCreateTableConfig {
  appToken: string;
  tableId: string;
  tableName: string;
}

const TABLES: Record<
  ContractCreateTableKind,
  { env: string; defaultId: string; tableName: string }
> = {
  framework: {
    env: 'FEISHU_CONTRACT_FRAMEWORK_TABLE_ID',
    defaultId: 'tblQehMrGf4zIfnt',
    tableName: '00-框架合同信息',
  },
  execution: {
    env: 'FEISHU_CONTRACT_EXECUTION_TABLE_ID',
    defaultId: 'tblWfHs0iwQh8lHj',
    tableName: '01-执行合同信息',
  },
  supplier: {
    env: 'FEISHU_CONTRACT_SUPPLIER_TABLE_ID',
    defaultId: 'tblPf6yV4cxsWZTl',
    tableName: '02-供应商名录',
  },
  payment: {
    env: 'FEISHU_CONTRACT_PAYMENT_TABLE_ID',
    defaultId: 'tblYK1vdLAkpoaIC',
    tableName: '03-付款计划',
  },
  organization: {
    env: 'FEISHU_CONTRACT_ORGANIZATION_TABLE_ID',
    defaultId: 'tblRtv0XGQVTihw7',
    tableName: '组织架构',
  },
};

@Injectable()
export class ContractCreationGateway {
  private tokenState: TenantTokenState | null = null;
  private tokenPromise: Promise<string> | null = null;
  private appTokenPromise: Promise<string> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async listFields(kind: ContractCreateTableKind): Promise<BitableFieldMeta[]> {
    const config = await this.getConfig(kind);
    const token = await this.getTenantAccessToken();
    const fields: BitableFieldMeta[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await this.httpService.axiosRef.get(fieldsUrl(config), {
        ...requestConfig(token),
        params: { page_size: 200, page_token: pageToken },
      });
      assertFeishuSuccess(response.data, `读取${config.tableName}字段失败`);
      const data = response.data?.data || {};
      fields.push(...(Array.isArray(data.items) ? data.items : []));
      hasMore = Boolean(data.has_more);
      pageToken = clean(data.page_token) || undefined;
    }
    return fields;
  }

  async listRecords(
    kind: ContractCreateTableKind,
  ): Promise<BitableRecordItem[]> {
    const config = await this.getConfig(kind);
    const token = await this.getTenantAccessToken();
    const records: BitableRecordItem[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await this.httpService.axiosRef.get(recordsUrl(config), {
        ...requestConfig(token),
        params: {
          page_size: 500,
          page_token: pageToken,
          user_id_type: 'open_id',
        },
      });
      assertFeishuSuccess(response.data, `读取${config.tableName}记录失败`);
      const data = response.data?.data || {};
      records.push(...(Array.isArray(data.items) ? data.items : []));
      hasMore = Boolean(data.has_more);
      pageToken = clean(data.page_token) || undefined;
    }
    return records;
  }

  async createRecord(
    kind: ContractCreateTableKind,
    fields: Record<string, unknown>,
    clientToken: string,
  ): Promise<string> {
    const config = await this.getConfig(kind);
    const token = await this.getTenantAccessToken();
    const createRequest = () =>
      this.httpService.axiosRef.post(
        recordsUrl(config),
        { fields },
        {
          ...requestConfig(token),
          params: {
            client_token: clientToken,
            ignore_consistency_check: true,
            user_id_type: 'open_id',
          },
        },
      );
    let response: Awaited<ReturnType<typeof createRequest>>;
    try {
      response = await createRequest();
    } catch {
      try {
        response = await createRequest();
      } catch (error) {
        throw new ContractCreateIndeterminateError(kind, clientToken, error);
      }
    }
    assertFeishuSuccess(response.data, `新增${config.tableName}记录失败`);
    const recordId = clean(response.data?.data?.record?.record_id);
    if (!recordId) {
      throw new BadGatewayException(
        `新增${config.tableName}记录失败：响应缺少 record_id`,
      );
    }
    this.invalidate(config);
    return recordId;
  }

  async getRecord(
    kind: ContractCreateTableKind,
    recordId: string,
  ): Promise<BitableRecordItem> {
    const config = await this.getConfig(kind);
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.get(
      `${recordsUrl(config)}/${encodeURIComponent(recordId)}`,
      {
        ...requestConfig(token),
        params: { user_id_type: 'open_id' },
      },
    );
    if (Number(response.data?.code) === 1254043) {
      throw new NotFoundException(`${config.tableName}记录不存在`);
    }
    assertFeishuSuccess(response.data, `读取${config.tableName}记录失败`);
    const record = response.data?.data?.record as BitableRecordItem | undefined;
    if (!record) {
      throw new BadGatewayException(
        `读取${config.tableName}记录失败：响应缺少 record`,
      );
    }
    return record;
  }

  async updateRecord(
    kind: ContractCreateTableKind,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const config = await this.getConfig(kind);
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(config)}/${encodeURIComponent(recordId)}`,
      { fields },
      {
        ...requestConfig(token),
        params: {
          ignore_consistency_check: true,
          user_id_type: 'open_id',
        },
      },
    );
    assertFeishuSuccess(response.data, `更新${config.tableName}记录失败`);
    this.invalidate(config);
  }

  async deleteRecord(
    kind: ContractCreateTableKind,
    recordId: string,
  ): Promise<void> {
    const config = await this.getConfig(kind);
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.delete(
      `${recordsUrl(config)}/${encodeURIComponent(recordId)}`,
      {
        ...requestConfig(token),
        params: { ignore_consistency_check: true },
      },
    );
    assertFeishuSuccess(response.data, `删除${config.tableName}记录失败`);
    this.invalidate(config);
  }

  async uploadPdf(file: ContractCreateUploadFile): Promise<string> {
    if (
      !file?.buffer?.length ||
      !Number.isFinite(file.size) ||
      file.size <= 0
    ) {
      throw new Error('合同附件内容为空');
    }
    const appToken = await this.getAppToken();
    const token = await this.getTenantAccessToken();
    const fileName = safeFileName(file.originalname);
    const form = new FormData();
    form.append('file_name', fileName);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', appToken);
    form.append('size', String(file.size));
    form.append('file', file.buffer, {
      filename: fileName,
      contentType: file.mimetype || 'application/pdf',
    });
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        timeout: 60_000,
      },
    );
    assertFeishuSuccess(response.data, '上传合同附件失败');
    const fileToken = clean(
      response.data?.data?.file_token || response.data?.data?.media_token,
    );
    if (!fileToken) {
      throw new BadGatewayException('上传合同附件失败：响应缺少 file_token');
    }
    return fileToken;
  }

  private async getConfig(
    kind: ContractCreateTableKind,
  ): Promise<ContractCreateTableConfig> {
    const table = TABLES[kind];
    return {
      appToken: await this.getAppToken(),
      tableId: readEnv(table.env) || table.defaultId,
      tableName: table.tableName,
    };
  }

  private getAppToken(): Promise<string> {
    if (!this.appTokenPromise) {
      const sourceUrl =
        readEnv('FEISHU_CONTRACT_SOURCE_URL') || DEFAULT_SOURCE_URL;
      const parsed = parseFeishuBitableLink(sourceUrl);
      this.appTokenPromise = resolveBitableAppToken(this.httpService, {
        appToken: readEnv('FEISHU_CONTRACT_APP_TOKEN') || parsed.appToken,
        wikiToken:
          readEnv('FEISHU_CONTRACT_WIKI_TOKEN') ||
          parsed.wikiToken ||
          DEFAULT_WIKI_TOKEN,
        tableName: '南通运维全景驾驶舱-合同&采购管理',
      }).catch((error) => {
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
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      getFeishuAuthPayload(),
      { timeout: 30_000 },
    );
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

  private invalidate(config: ContractCreateTableConfig): void {
    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.tableId,
    });
  }
}

function recordsUrl(config: ContractCreateTableConfig): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`;
}

function fieldsUrl(config: ContractCreateTableConfig): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/fields`;
}

function requestConfig(token: string) {
  return {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
  };
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new BadGatewayException(`${prefix}：响应格式无效`);
  }
  const data = payload as { code?: unknown; msg?: unknown };
  if (data.code === 0) return;
  const detail =
    clean(data.msg) ||
    (data.code === undefined || data.code === null
      ? '响应缺少有效 code'
      : `错误码 ${String(data.code)}`);
  throw new BadGatewayException(`${prefix}：${detail}`);
}

function safeFileName(value: string): string {
  const normalized = value
    .replace(/[\r\n\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 200);
  return normalized.toLowerCase().endsWith('.pdf')
    ? normalized || '合同原件.pdf'
    : `${normalized || '合同原件'}.pdf`;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
