import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import FormData = require('form-data');
import {
  getFeishuAuthPayload,
  readEnv,
} from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  invalidateBitableRecordCache,
  type BitableRecordItem,
  type FetchBitableRecordsOptions,
} from '../../common/feishu/bitable-direct-read';
import { mapOrganizationRoutingRecords } from '../overtime-workflow/overtime-workflow.gateway';
import type { LeaveOrganizationRecord } from './leave-workflow.types';

export const LEAVE_ORGANIZATION_READER = Symbol('LEAVE_ORGANIZATION_READER');
export const LEAVE_WORKFLOW_CLOCK = Symbol('LEAVE_WORKFLOW_CLOCK');

const DEFAULT_ORGANIZATION_APP_TOKEN = 'PUBLIC_EXAMPLE_FEISHU_ORG_APP_TOKEN';
const DEFAULT_ORGANIZATION_TABLE_ID = 'tbl82d0b2f3ddc70';
const DEFAULT_ORGANIZATION_VIEW_ID = 'vewkJ9WMUS';
const DEFAULT_LEAVE_TABLE_ID = 'tblf1bbd02a2b049';
const ORGANIZATION_CACHE_TTL_MS = 4 * 60 * 60 * 1_000;
const FEISHU_REQUEST_TIMEOUT_MS = 15_000;
const CARD_MAX_BYTES = 30 * 1_024;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const ATTACHMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{3,300}$/u;
const IMAGE_KEY_PATTERN = /^img_[A-Za-z0-9_-]{1,300}$/u;
const MAX_LEAVE_SCREENSHOT_BYTES = 10 * 1_024 * 1_024;

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface OrganizationCacheState {
  records: LeaveOrganizationRecord[];
  expiresAt: number;
  promise: Promise<LeaveOrganizationRecord[]> | null;
}

interface LeaveScreenshotAttachment {
  fileToken: string;
  tmpUrl: string;
  directUrl: string;
}

export type LeaveOrganizationReader = (
  httpService: HttpService,
  options: FetchBitableRecordsOptions,
) => Promise<BitableRecordItem[]>;

export interface LeaveBitableRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

@Injectable()
export class LeaveWorkflowGateway {
  private tenantToken: TenantTokenState | null = null;
  private tenantTokenPromise: Promise<string> | null = null;
  private organizationCache: OrganizationCacheState = {
    records: [],
    expiresAt: 0,
    promise: null,
  };

  constructor(
    private readonly httpService: HttpService,
    @Optional()
    @Inject(LEAVE_ORGANIZATION_READER)
    private readonly organizationReader: LeaveOrganizationReader = fetchBitableRecords,
    @Optional()
    @Inject(LEAVE_WORKFLOW_CLOCK)
    private readonly now: () => number = Date.now,
  ) {}

  async fetchOrganizationRoutingRecords(
    forceRefresh = false,
  ): Promise<LeaveOrganizationRecord[]> {
    const current = this.now();
    if (
      !forceRefresh &&
      this.organizationCache.records.length > 0 &&
      this.organizationCache.expiresAt > current
    ) {
      return clone(this.organizationCache.records);
    }
    if (!forceRefresh && this.organizationCache.promise) {
      return clone(await this.organizationCache.promise);
    }
    const promise = this.organizationReader(this.httpService, {
      appToken:
        readEnv('FEISHU_LEAVE_ORGANIZATION_APP_TOKEN', [
          'FEISHU_OVERTIME_ORGANIZATION_APP_TOKEN',
        ]) || DEFAULT_ORGANIZATION_APP_TOKEN,
      tableId:
        readEnv('FEISHU_LEAVE_ORGANIZATION_TABLE_ID', [
          'FEISHU_OVERTIME_ORGANIZATION_TABLE_ID',
        ]) || DEFAULT_ORGANIZATION_TABLE_ID,
      viewId:
        readEnv('FEISHU_LEAVE_ORGANIZATION_VIEW_ID', [
          'FEISHU_OVERTIME_ORGANIZATION_VIEW_ID',
        ]) || DEFAULT_ORGANIZATION_VIEW_ID,
      tableName: '请休假审批组织架构',
      automaticFields: true,
      cacheTtlMs: ORGANIZATION_CACHE_TTL_MS,
      forceRefresh,
      allowStale: true,
      strict: false,
    }).then((records) => mapOrganizationRoutingRecords(records));
    this.organizationCache.promise = promise;
    try {
      const records = await promise;
      this.organizationCache = {
        records: clone(records),
        expiresAt: this.now() + ORGANIZATION_CACHE_TTL_MS,
        promise: null,
      };
      return clone(records);
    } catch (error) {
      this.organizationCache.promise = null;
      if (this.organizationCache.records.length > 0) {
        return clone(this.organizationCache.records);
      }
      throw error;
    }
  }

  async sendInteractiveCard(
    recipientOpenId: string,
    card: Record<string, unknown>,
    businessKey: string,
  ): Promise<string> {
    const recipient = requireOpenId(recipientOpenId);
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef
      .post(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        {
          receive_id: recipient,
          msg_type: 'interactive',
          content: serializeCard(card),
          uuid: stableLeaveMessageUuid(businessKey),
        },
        requestConfig(token),
      )
      .catch((error: unknown) =>
        throwFeishuHttpRequestError(error, '发送请休假审批卡片失败'),
      );
    assertFeishuSuccess(response.data, '发送请休假审批卡片失败');
    const messageId = clean(response.data?.data?.message_id);
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BadGatewayException(
        '发送请休假审批卡片失败：响应缺少 message_id',
      );
    }
    return messageId;
  }

  async patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const normalizedMessageId = requireMessageId(messageId);
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef
      .patch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(normalizedMessageId)}`,
        { content: serializeCard(card) },
        requestConfig(token),
      )
      .catch((error: unknown) =>
        throwFeishuHttpRequestError(error, '更新请休假审批卡片失败'),
      );
    assertFeishuSuccess(response.data, '更新请休假审批卡片失败');
  }

  async prepareLeaveApprovalScreenshotImages(
    fields: Record<string, unknown>,
  ): Promise<string[]> {
    const attachments = extractLeaveScreenshotAttachments(fields).slice(0, 1);
    if (attachments.length === 0) return [];
    const token = await this.getTenantAccessToken();
    const imageKeys: string[] = [];
    for (const attachment of attachments) {
      const image = await this.downloadLeaveScreenshot(attachment, token);
      imageKeys.push(await this.uploadLeaveScreenshot(image, token));
    }
    return imageKeys;
  }

  async readLeaveRecord(recordId: string): Promise<LeaveBitableRecord> {
    const normalizedRecordId = requireRecordId(recordId);
    const config = this.leaveConfig();
    const response = await this.httpService.axiosRef.get(
      `${recordsUrl(config.appToken, config.tableId)}/${encodeURIComponent(normalizedRecordId)}`,
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '读取请休假多维记录失败');
    const record = response.data?.data?.record as BitableRecordItem | undefined;
    const responseRecordId = clean(record?.record_id || normalizedRecordId);
    if (!record || !RECORD_ID_PATTERN.test(responseRecordId)) {
      throw new BadGatewayException('读取请休假多维记录失败：响应缺少记录');
    }
    return {
      recordId: responseRecordId,
      fields:
        record.fields && typeof record.fields === 'object'
          ? clone(record.fields)
          : {},
    };
  }

  async findLeaveRecordsByCodes(
    codes: string[],
  ): Promise<LeaveBitableRecord[]> {
    const normalizedCodes = [
      ...new Set(
        (codes || [])
          .map((code) => String(code || '').trim())
          .filter((code) => code.length > 0 && code.length <= 100),
      ),
    ].slice(0, 20);
    if (normalizedCodes.length === 0) return [];

    const config = this.leaveConfig();
    const records = await Promise.all(
      normalizedCodes.map((code) =>
        this.organizationReader(this.httpService, {
          appToken: config.appToken,
          tableId: config.tableId,
          tableName: '请休假多维表',
          automaticFields: true,
          fieldNames: [
            '休假编号',
            '请求唯一ID',
            '请假工作流状态',
            '休假人员',
            '休假人员姓名（程序）',
            '休假开始时间',
            '休假结束时间',
            '休假类型',
            '休假工时数（最低4h）',
            '休假工时数',
            '休假天数',
            '请假原因',
            '流程截图',
            '替班人员（填姓名）',
            '请假驳回原因',
          ],
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: '休假编号', operator: 'is', value: [code] },
            ],
          },
          cacheTtlMs: 0,
          forceRefresh: true,
          allowStale: false,
          strict: true,
        }),
      ),
    );

    return records.flatMap((items) =>
      items.flatMap((item) => {
        const recordId = clean(item.record_id || item.id);
        if (!RECORD_ID_PATTERN.test(recordId)) return [];
        return [
          {
            recordId,
            fields:
              item.fields && typeof item.fields === 'object'
                ? clone(item.fields)
                : {},
          },
        ];
      }),
    );
  }

  async updateLeaveRecord(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const normalizedRecordId = requireRecordId(recordId);
    const config = this.leaveConfig();
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(config.appToken, config.tableId)}/${encodeURIComponent(normalizedRecordId)}`,
      { fields: clone(fields) },
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '更新请休假多维记录失败');
    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.tableId,
    });
  }

  private leaveConfig(): { appToken: string; tableId: string } {
    const appToken = readEnv('FEISHU_LEAVE_REQUEST_APP_TOKEN', [
      'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
      'FEISHU_MAIN_APP_TOKEN',
      'FEISHU_BITABLE_APP_TOKEN',
    ]);
    const tableId =
      readEnv('FEISHU_LEAVE_REQUEST_TABLE_ID', [
        'FEISHU_LEAVE_SUBSTITUTE_TABLE_ID',
      ]) || DEFAULT_LEAVE_TABLE_ID;
    if (!appToken)
      throw new BadRequestException('请休假多维表 app token 未配置');
    return { appToken, tableId };
  }

  private async downloadLeaveScreenshot(
    attachment: LeaveScreenshotAttachment,
    tenantAccessToken: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const batchUrl =
      (isFeishuMediaUrl(attachment.tmpUrl) && attachment.tmpUrl) ||
      'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url' +
        `?file_tokens=${encodeURIComponent(attachment.fileToken)}`;
    let downloadUrl = '';
    try {
      const response = await this.httpService.axiosRef.get(
        batchUrl,
        requestConfig(tenantAccessToken),
      );
      assertFeishuSuccess(response.data, '读取请休假流程截图下载地址失败');
      downloadUrl = extractTmpDownloadUrl(response.data);
    } catch {
      downloadUrl = '';
    }
    const directDownload = !downloadUrl;
    if (directDownload) {
      downloadUrl =
        (isFeishuMediaUrl(attachment.directUrl) && attachment.directUrl) ||
        `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(attachment.fileToken)}/download`;
    }
    if (!isSafeHttpsUrl(downloadUrl)) {
      throw new BadGatewayException('读取请休假流程截图失败：下载地址无效');
    }
    const response = await this.httpService.axiosRef.get(downloadUrl, {
      ...(directDownload
        ? { headers: { Authorization: `Bearer ${tenantAccessToken}` } }
        : {}),
      responseType: 'arraybuffer',
      timeout: FEISHU_REQUEST_TIMEOUT_MS,
    });
    const buffer = Buffer.from(response.data || []);
    if (buffer.length === 0 || buffer.length > MAX_LEAVE_SCREENSHOT_BYTES) {
      throw new BadGatewayException(
        '读取请休假流程截图失败：图片为空或超过 10 MB',
      );
    }
    const headerContentType = clean(response.headers?.['content-type'])
      .split(';')[0]
      .toLowerCase();
    const contentType = /^image\/(png|jpeg|jpg|webp)$/u.test(headerContentType)
      ? headerContentType === 'image/jpg'
        ? 'image/jpeg'
        : headerContentType
      : 'image/png';
    return { buffer, contentType };
  }

  private async uploadLeaveScreenshot(
    image: { buffer: Buffer; contentType: string },
    tenantAccessToken: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', image.buffer, {
      filename: 'leave-approval-screenshot.png',
      contentType: image.contentType,
    });
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/im/v1/images',
      form,
      {
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        timeout: FEISHU_REQUEST_TIMEOUT_MS,
      },
    );
    assertFeishuSuccess(response.data, '上传请休假流程截图失败');
    const imageKey = clean(response.data?.data?.image_key);
    if (!IMAGE_KEY_PATTERN.test(imageKey)) {
      throw new BadGatewayException(
        '上传请休假流程截图失败：响应缺少 image_key',
      );
    }
    return imageKey;
  }

  private async getTenantAccessToken(): Promise<string> {
    const current = this.now();
    if (this.tenantToken && this.tenantToken.expiresAt > current) {
      return this.tenantToken.value;
    }
    if (this.tenantTokenPromise) return this.tenantTokenPromise;
    this.tenantTokenPromise = this.fetchTenantAccessToken();
    try {
      return await this.tenantTokenPromise;
    } finally {
      this.tenantTokenPromise = null;
    }
  }

  private async fetchTenantAccessToken(): Promise<string> {
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      getFeishuAuthPayload(),
      { timeout: 10_000 },
    );
    assertFeishuSuccess(response.data, '获取飞书应用访问令牌失败');
    const value = clean(
      response.data?.tenant_access_token ||
        response.data?.data?.tenant_access_token,
    );
    if (!value)
      throw new BadGatewayException('获取飞书应用访问令牌失败：响应缺少令牌');
    const expiresInSeconds = Math.max(
      60,
      Number(response.data?.expire || response.data?.data?.expire || 7200),
    );
    this.tenantToken = {
      value,
      expiresAt:
        this.now() + Math.max(30_000, expiresInSeconds * 1_000 - 60_000),
    };
    return value;
  }
}

export function stableLeaveMessageUuid(businessKey: string): string {
  const normalized = String(businessKey || '').trim();
  if (!normalized) throw new BadRequestException('请休假卡片业务键无效');
  return `leave_${createHash('sha256').update(normalized).digest('base64url').slice(0, 42)}`;
}

function recordsUrl(appToken: string, tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
}

function extractLeaveScreenshotAttachments(
  fields: Record<string, unknown>,
): LeaveScreenshotAttachment[] {
  const attachments: LeaveScreenshotAttachment[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined || seen.has(value))
      return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      seen.add(value);
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    const item = value as Record<string, unknown>;
    const token = clean(item.file_token || item.fileToken);
    if (ATTACHMENT_TOKEN_PATTERN.test(token)) {
      attachments.push({
        fileToken: token,
        tmpUrl: clean(item.tmp_url || item.tmpUrl),
        directUrl: clean(item.url || item.download_url || item.downloadUrl),
      });
    }
    Object.values(item).forEach((nested) => visit(nested, depth + 1));
  };
  visit(fields?.流程截图, 0);
  return attachments.filter(
    (attachment, index, list) =>
      list.findIndex((item) => item.fileToken === attachment.fileToken) ===
      index,
  );
}

function extractTmpDownloadUrl(payload: any): string {
  const data = payload?.data || {};
  const candidates = Array.isArray(data.tmp_download_urls)
    ? data.tmp_download_urls
    : [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isSafeHttpsUrl(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      const url = clean(
        candidate.tmp_download_url || candidate.tmpDownloadUrl || candidate.url,
      );
      if (isSafeHttpsUrl(url)) return url;
    }
  }
  const direct = clean(data.tmp_download_url);
  return isSafeHttpsUrl(direct) ? direct : '';
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isFeishuMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'open.feishu.cn' &&
      url.pathname.startsWith('/open-apis/drive/v1/medias/')
    );
  } catch {
    return false;
  }
}

function requestConfig(accessToken: string) {
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: FEISHU_REQUEST_TIMEOUT_MS,
  };
}

function serializeCard(card: Record<string, unknown>): string {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new BadRequestException('飞书互动卡内容无效');
  }
  const result = JSON.stringify(card);
  if (Buffer.byteLength(result, 'utf8') > CARD_MAX_BYTES) {
    throw new BadRequestException('飞书互动卡内容超过 30 KB');
  }
  return result;
}

function assertFeishuSuccess(payload: any, message: string): void {
  const code = Number(payload?.code || 0);
  if (code !== 0) {
    throw new BadGatewayException(
      `${message}：${clean(payload?.msg || payload?.message) || `飞书错误码 ${code}`}`,
    );
  }
}

function throwFeishuHttpRequestError(error: unknown, message: string): never {
  const candidate = error as {
    isAxiosError?: unknown;
    response?: {
      status?: unknown;
      data?: { code?: unknown; msg?: unknown; message?: unknown };
    };
  };
  if (candidate?.isAxiosError === true && candidate.response) {
    const status = Number(candidate.response.status || 0);
    const code = Number(candidate.response.data?.code || 0);
    const detail = clean(
      candidate.response.data?.msg || candidate.response.data?.message,
    )
      .replace(/\s+/gu, ' ')
      .slice(0, 500);
    const parts = [
      status > 0 ? `HTTP ${status}` : '',
      code !== 0 ? `飞书错误码 ${code}` : '',
      detail,
    ].filter(Boolean);
    throw new BadGatewayException(
      parts.length > 0 ? `${message}：${parts.join('；')}` : message,
    );
  }
  throw error;
}

function requireRecordId(value: unknown): string {
  const result = clean(value);
  if (!RECORD_ID_PATTERN.test(result))
    throw new BadRequestException('请休假记录标识无效');
  return result;
}

function requireOpenId(value: unknown): string {
  const result = clean(value);
  if (!OPEN_ID_PATTERN.test(result))
    throw new BadRequestException('飞书人员标识无效');
  return result;
}

function requireMessageId(value: unknown): string {
  const result = clean(value);
  if (!MESSAGE_ID_PATTERN.test(result))
    throw new BadRequestException('飞书卡片消息标识无效');
  return result;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
