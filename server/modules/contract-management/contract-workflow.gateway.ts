import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  getFeishuAuthPayload,
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

const DEFAULT_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/SiW9wuy9DiIsykkTkNUcM0HfnSb?table=tblQehMrGf4zIfnt&view=vewmu8EPpy';
const DEFAULT_WIKI_TOKEN = 'SiW9wuy9DiIsykkTkNUcM0HfnSb';

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

export interface ContractWorkflowSource {
  sourceUrl: string;
  contracts: BitableRecordItem[];
  payments: BitableRecordItem[];
  organization: BitableRecordItem[];
}

@Injectable()
export class ContractWorkflowGateway {
  private tokenState: TenantTokenState | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async readSource(): Promise<ContractWorkflowSource> {
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
    const [contracts, payments, organization] = await Promise.all([
      this.readTable(
        appToken,
        readEnv('FEISHU_CONTRACT_EXECUTION_TABLE_ID') || 'tblWfHs0iwQh8lHj',
        '01-执行合同信息',
      ),
      this.readTable(
        appToken,
        readEnv('FEISHU_CONTRACT_PAYMENT_TABLE_ID') || 'tblYK1vdLAkpoaIC',
        '03-付款计划',
      ),
      this.readTable(
        appToken,
        readEnv('FEISHU_CONTRACT_ORGANIZATION_TABLE_ID') || 'tblRtv0XGQVTihw7',
        '组织架构',
      ),
    ]);
    return { sourceUrl, contracts, payments, organization };
  }

  async sendText(receiverOpenId: string, text: string, uuid: string = randomUUID()): Promise<string> {
    if (!/^ou_[A-Za-z0-9]+$/.test(receiverOpenId)) {
      throw new Error('发送飞书消息失败：接收人 OpenID 无效');
    }
    assertMessageUuid(uuid);
    const token = await this.getTenantAccessToken();
    const response = await this.sendMessage(token, {
      receive_id: receiverOpenId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
      uuid,
    });
    assertFeishuSuccess(response.data, '发送飞书消息失败');
    const messageId = clean(messageResponseId(response.data));
    if (!messageId) throw new Error('发送飞书消息失败：响应缺少 message_id');
    return messageId;
  }

  async sendInteractiveCard(
    receiverOpenId: string,
    card: Record<string, unknown>,
    uuid: string = randomUUID(),
  ): Promise<string> {
    if (!/^ou_[A-Za-z0-9]+$/.test(receiverOpenId)) {
      throw new Error('发送飞书卡片失败：接收人 OpenID 无效');
    }
    assertMessageUuid(uuid);
    const token = await this.getTenantAccessToken();
    const response = await this.sendMessage(token, {
      receive_id: receiverOpenId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
      uuid,
    });
    assertFeishuSuccess(response.data, '发送飞书卡片失败');
    const messageId = clean(messageResponseId(response.data));
    if (!messageId) throw new Error('发送飞书卡片失败：响应缺少 message_id');
    return messageId;
  }

  private readTable(
    appToken: string,
    tableId: string,
    tableName: string,
  ): Promise<BitableRecordItem[]> {
    return fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName,
      cacheTtlMs: 0,
      forceRefresh: true,
    });
  }

  private async sendMessage(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<{ data?: unknown }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.httpService.axiosRef.post(
          'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
          payload,
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30_000,
          },
        );
      } catch (error) {
        lastError = error;
        if (!isRetryableFeishuMessageError(error) || attempt === 2) throw error;
        await delay((attempt + 1) * 300);
      }
    }
    throw lastError;
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
    if (!token) throw new Error('获取飞书访问令牌失败：响应缺少 token');
    const expireSeconds = Number(response.data?.expire) || 7_200;
    this.tokenState = {
      value: token,
      expiresAt: Date.now() + expireSeconds * 1_000,
    };
    return token;
  }
}

function assertFeishuSuccess(data: unknown, message: string): void {
  const payload = (data || {}) as { code?: number; msg?: string };
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(`${message}：${payload.msg || payload.code}`);
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function messageResponseId(payload: unknown): unknown {
  return (payload as { data?: { message_id?: unknown } } | undefined)?.data
    ?.message_id;
}

function isRetryableFeishuMessageError(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } })?.response
    ?.status;
  if (typeof status === 'number') {
    return (
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    );
  }
  const code = (error as { code?: unknown; cause?: { code?: unknown } })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  if (
    [code, causeCode].some(
      (value) =>
        typeof value === 'string' &&
        [
          'ECONNABORTED',
          'ECONNRESET',
          'ETIMEDOUT',
          'EAI_AGAIN',
          'ENOTFOUND',
          'ECONNREFUSED',
        ].includes(value),
    )
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:ECONNABORTED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)\b|socket hang up|network error|timeout of \d+ms exceeded|connect timed out/i.test(
    message,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertMessageUuid(uuid: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uuid)) throw new Error('合同通知UUID无效');
}
