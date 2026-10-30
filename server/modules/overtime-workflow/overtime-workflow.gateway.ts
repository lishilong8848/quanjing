import { observedCardPost, observedCardPatch } from '../../common/feishu-card-copy/transport';
import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import {
  getFeishuAuthPayload,
  readEnv,
} from '../../common/config/external-services.config';
import {
  extractDisplayText,
  extractDisplayValues,
  fetchBitableRecords,
  invalidateBitableRecordCache,
  type BitableRecordItem,
  type FetchBitableRecordsOptions,
} from '../../common/feishu/bitable-direct-read';
import type { OvertimeOrganizationRecord } from './overtime-workflow.types';
import { stableOvertimeMessageUuid } from './overtime-workflow.store';

export { stableOvertimeMessageUuid } from './overtime-workflow.store';

export const OVERTIME_ORGANIZATION_READER = Symbol(
  'OVERTIME_ORGANIZATION_READER',
);
export const OVERTIME_WORKFLOW_CLOCK = Symbol('OVERTIME_WORKFLOW_CLOCK');

const DEFAULT_ORGANIZATION_APP_TOKEN = 'F9lDbA5XKaLmyasoARRcZFpKnZd';
const DEFAULT_ORGANIZATION_TABLE_ID = 'tblZipVFGY4D65tw';
const DEFAULT_ORGANIZATION_VIEW_ID = 'vewkJ9WMUS';
const DEFAULT_OVERTIME_TABLE_ID = 'tblpCzmTT3EapaUY';
const ORGANIZATION_CACHE_TTL_MS = 4 * 60 * 60 * 1_000;
const CARD_MAX_BYTES = 30 * 1_024;
const FEISHU_REQUEST_TIMEOUT_MS = 15_000;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const TICKET_MAX_LENGTH = 2_048;
const DEFAULT_TICKET_MAX_AGE_MS = 370 * 24 * 60 * 60 * 1_000;
const TICKET_CLOCK_SKEW_MS = 5 * 60 * 1_000;

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface OrganizationCacheState {
  records: OvertimeOrganizationRecord[];
  expiresAt: number;
  promise: Promise<OvertimeOrganizationRecord[]> | null;
}

export type OvertimeOrganizationReader = (
  httpService: HttpService,
  options: FetchBitableRecordsOptions,
) => Promise<BitableRecordItem[]>;

export interface OvertimeBitableRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface OvertimeConfirmationTicketPayload {
  recordId: string;
  approverOpenId: string;
  issuedAt: number;
  confirmationGeneration?: number;
}

@Injectable()
export class OvertimeWorkflowGateway {
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
    @Inject(OVERTIME_ORGANIZATION_READER)
    private readonly organizationReader: OvertimeOrganizationReader = fetchBitableRecords,
    @Optional()
    @Inject(OVERTIME_WORKFLOW_CLOCK)
    private readonly now: () => number = Date.now,
  ) {}

  async fetchOrganizationRoutingRecords(
    forceRefresh = false,
  ): Promise<OvertimeOrganizationRecord[]> {
    const now = this.now();
    if (
      !forceRefresh &&
      this.organizationCache.records.length &&
      this.organizationCache.expiresAt > now
    ) {
      return clone(this.organizationCache.records);
    }
    if (!forceRefresh && this.organizationCache.promise) {
      return clone(await this.organizationCache.promise);
    }

    const promise = this.organizationReader(this.httpService, {
      appToken:
        readEnv('FEISHU_OVERTIME_ORGANIZATION_APP_TOKEN') ||
        DEFAULT_ORGANIZATION_APP_TOKEN,
      tableId:
        readEnv('FEISHU_OVERTIME_ORGANIZATION_TABLE_ID') ||
        DEFAULT_ORGANIZATION_TABLE_ID,
      viewId:
        readEnv('FEISHU_OVERTIME_ORGANIZATION_VIEW_ID') ||
        DEFAULT_ORGANIZATION_VIEW_ID,
      tableName: '加班审批组织架构',
      automaticFields: true,
      cacheTtlMs: ORGANIZATION_CACHE_TTL_MS,
      forceRefresh,
      allowStale: true,
      strict: false,
    }).then(mapOrganizationRoutingRecords);
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
      if (this.organizationCache.records.length) {
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
    const content = serializeCard(card);
    const token = await this.getTenantAccessToken();
    const response = await observedCardPost(this.httpService.axiosRef, 'overtime',
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: recipient,
        msg_type: 'interactive',
        content,
        uuid: stableOvertimeMessageUuid(businessKey),
      },
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, '发送加班工作流卡片失败');
    const messageId = clean(response.data?.data?.message_id);
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BadGatewayException(
        '发送加班工作流卡片失败：响应缺少 message_id',
      );
    }
    return messageId;
  }

  async patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const normalizedMessageId = clean(messageId);
    if (!MESSAGE_ID_PATTERN.test(normalizedMessageId)) {
      throw new BadRequestException('飞书互动卡消息标识无效');
    }
    const token = await this.getTenantAccessToken();
    const response = await observedCardPatch(this.httpService.axiosRef, 'overtime',
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(normalizedMessageId)}`,
      { content: serializeCard(card) },
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, '更新加班工作流卡片失败');
  }

  async readOvertimeRecord(recordId: string): Promise<OvertimeBitableRecord> {
    const normalizedRecordId = requireRecordId(recordId);
    const config = this.overtimeConfig();
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.get(
      `${recordsUrl(config.appToken, config.tableId)}/${encodeURIComponent(normalizedRecordId)}`,
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, '读取加班多维记录失败');
    const record = response.data?.data?.record as BitableRecordItem | undefined;
    const responseRecordId = clean(record?.record_id || normalizedRecordId);
    if (!record || !RECORD_ID_PATTERN.test(responseRecordId)) {
      throw new BadGatewayException('读取加班多维记录失败：响应缺少 record');
    }
    return {
      recordId: responseRecordId,
      fields:
        record.fields && typeof record.fields === 'object'
          ? clone(record.fields)
          : {},
    };
  }

  async readOvertimeRecordIfExists(
    recordId: string,
  ): Promise<OvertimeBitableRecord | null> {
    const normalizedRecordId = requireRecordId(recordId);
    const config = this.overtimeConfig();
    const token = await this.getTenantAccessToken();
    try {
      const response = await this.httpService.axiosRef.get(
        `${recordsUrl(config.appToken, config.tableId)}/${encodeURIComponent(normalizedRecordId)}`,
        requestConfig(token),
      );
      if (isMissingBitableRecordResponse(response.data)) return null;
      assertFeishuSuccess(response.data, '读取加班多维记录失败');
      const record = response.data?.data?.record as
        | BitableRecordItem
        | undefined;
      const responseRecordId = clean(record?.record_id || normalizedRecordId);
      if (!record || !RECORD_ID_PATTERN.test(responseRecordId)) {
        throw new BadGatewayException('读取加班多维记录失败：响应缺少 record');
      }
      return {
        recordId: responseRecordId,
        fields:
          record.fields && typeof record.fields === 'object'
            ? clone(record.fields)
            : {},
      };
    } catch (error) {
      if (isMissingBitableRecordError(error)) return null;
      throw error;
    }
  }

  async updateOvertimeRecord(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedFields = cloneJsonObject(fields);
    const config = this.overtimeConfig();
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(config.appToken, config.tableId)}/${encodeURIComponent(normalizedRecordId)}`,
      { fields: normalizedFields },
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, '更新加班多维记录失败');
    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.tableId,
    });
  }

  issueConfirmationTicket(input: {
    recordId: string;
    approverOpenId: string;
    issuedAt?: number;
    confirmationGeneration?: number;
  }): string {
    return issueOvertimeConfirmationTicket(
      {
        ...input,
        issuedAt: input.issuedAt ?? this.now(),
      },
      confirmationSecret(),
    );
  }

  verifyConfirmationTicket(
    ticket: string,
    expectedRecordId: string,
  ): OvertimeConfirmationTicketPayload {
    return verifyOvertimeConfirmationTicket(ticket, confirmationSecret(), {
      expectedRecordId,
      now: this.now(),
    });
  }

  buildConfirmationUrl(recordId: string, ticket: string): string {
    const publicBaseUrl = readEnv('PUBLIC_BASE_URL', [
      'FEISHU_PUBLIC_BASE_URL',
      'APP_PUBLIC_URL',
    ]);
    if (!publicBaseUrl) {
      throw new BadRequestException('加班确认页面公网地址未配置');
    }
    return buildOvertimeConfirmationUrl(publicBaseUrl, recordId, ticket);
  }

  private overtimeConfig(): { appToken: string; tableId: string } {
    const appToken = readEnv('FEISHU_OVERTIME_APP_TOKEN', [
      'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
      'FEISHU_LEAVE_REQUEST_APP_TOKEN',
      'FEISHU_MAIN_APP_TOKEN',
      'FEISHU_BITABLE_APP_TOKEN',
    ]);
    const tableId =
      readEnv('FEISHU_OVERTIME_TABLE_ID', [
        'FEISHU_LEAVE_SUBSTITUTE_TABLE_ID',
        'FEISHU_LEAVE_REQUEST_TABLE_ID',
      ]) || DEFAULT_OVERTIME_TABLE_ID;
    if (!appToken) throw new BadRequestException('加班多维表 app token 未配置');
    return { appToken, tableId };
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = this.now();
    if (this.tenantToken && this.tenantToken.expiresAt > now) {
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
    const token = clean(
      response.data?.tenant_access_token ||
        response.data?.data?.tenant_access_token,
    );
    if (!token) {
      throw new BadGatewayException('获取飞书应用访问令牌失败：响应缺少令牌');
    }
    const expiresInSeconds = Math.max(
      60,
      Number(response.data?.expire || response.data?.data?.expire || 7_200),
    );
    this.tenantToken = {
      value: token,
      expiresAt:
        this.now() + Math.max(30_000, expiresInSeconds * 1_000 - 60_000),
    };
    return token;
  }
}

export function mapOrganizationRoutingRecords(
  source: BitableRecordItem[],
): OvertimeOrganizationRecord[] {
  const result = new Map<string, OvertimeOrganizationRecord>();
  for (const record of source) {
    const fields = record?.fields || {};
    const position = firstText(fields, ['职位', '岗位', '所属岗位']);
    const buildings = unique(
      ['楼栋/专业', '楼栋', '所属楼栋']
        .flatMap((fieldName) => extractDisplayValues(fields[fieldName]))
        .map(normalizeBusinessText)
        .filter(Boolean),
    );
    const supervisorUsers = extractUsers(fields['主管']);
    const supervisorNames = unique(
      [
        ...supervisorUsers.map((entry) => entry.name),
        ...extractDisplayValues(fields['主管（文本）']).map(
          normalizeBusinessText,
        ),
      ].filter(Boolean),
    );
    const directUsers = uniqueUsers([
      ...extractUsers(fields['值班账号']),
      ...extractUsers(fields['人员']),
      ...extractUsers(fields['姓名']),
      ...supervisorUsers,
    ]);
    if (!directUsers.length) {
      const name = firstText(fields, ['姓名', '主管（文本）', '值班账号']);
      if (name) {
        const key = `name:${name}:${position}:${buildings.join(',')}`;
        result.set(key, {
          name,
          openId: '',
          position,
          buildings,
          supervisorNames,
        });
      }
      continue;
    }
    for (const user of directUsers) {
      const existing = result.get(user.openId);
      result.set(user.openId, {
        name: existing?.name || user.name,
        openId: user.openId,
        position: existing?.position || position,
        buildings: unique([...(existing?.buildings || []), ...buildings]),
        supervisorNames: unique([
          ...(existing?.supervisorNames || []),
          ...supervisorNames,
        ]),
      });
    }
  }
  return [...result.values()];
}

export function issueOvertimeConfirmationTicket(
  input: OvertimeConfirmationTicketPayload,
  secret: string,
): string {
  const normalizedSecret = requireTicketSecret(secret);
  if (input.confirmationGeneration !== undefined && (!Number.isSafeInteger(input.confirmationGeneration) || input.confirmationGeneration < 2)) throw new BadRequestException('加班确认代际无效');
  const payload = {
    v: input.confirmationGeneration === undefined ? 1 : 2,
    r: requireRecordId(input.recordId),
    o: requireOpenId(input.approverOpenId),
    i: normalizeIssuedAt(input.issuedAt),
    ...(input.confirmationGeneration !== undefined ? { g: input.confirmationGeneration } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return `${encoded}.${signTicket(encoded, normalizedSecret)}`;
}

export function verifyOvertimeConfirmationTicket(
  ticket: string,
  secret: string,
  options: {
    expectedRecordId: string;
    now: number;
    maxAgeMs?: number;
  },
): OvertimeConfirmationTicketPayload {
  const normalizedTicket = clean(ticket);
  const normalizedSecret = requireTicketSecret(secret);
  if (
    !normalizedTicket ||
    normalizedTicket.length > TICKET_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(normalizedTicket)
  ) {
    throw new UnauthorizedException('加班确认令牌无效');
  }
  const [encoded, signature] = normalizedTicket.split('.');
  const expectedSignature = signTicket(encoded, normalizedSecret);
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw new UnauthorizedException('加班确认令牌无效');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedException('加班确认令牌无效');
  }
  if (!isPlainObject(raw) || !['i,o,r,v', 'g,i,o,r,v'].includes(Object.keys(raw).sort().join(','))) {
    throw new UnauthorizedException('加班确认令牌无效');
  }
  const payload = raw as { v: unknown; r: unknown; o: unknown; i: unknown; g?: unknown };
  if ((payload.v === 1 && Object.hasOwn(payload, 'g')) || (payload.v === 2 && (typeof payload.g !== 'number' || !Number.isSafeInteger(payload.g) || payload.g < 2)) || ![1, 2].includes(Number(payload.v)) || typeof payload.v !== 'number') throw new UnauthorizedException('加班确认令牌无效');
  let recordId: string;
  let approverOpenId: string;
  let issuedAt: number;
  try {
    recordId = requireRecordId(payload.r);
    approverOpenId = requireOpenId(payload.o);
    issuedAt = normalizeIssuedAt(payload.i);
  } catch {
    throw new UnauthorizedException('加班确认令牌无效');
  }
  const expectedRecordId = requireRecordId(options.expectedRecordId);
  if (!constantTimeEqual(recordId, expectedRecordId)) {
    throw new UnauthorizedException('加班确认令牌与记录不匹配');
  }
  const now = Number(options.now);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TICKET_MAX_AGE_MS;
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    issuedAt > now + TICKET_CLOCK_SKEW_MS ||
    now - issuedAt > maxAgeMs
  ) {
    throw new UnauthorizedException('加班确认令牌已过期');
  }
  return { recordId, approverOpenId, issuedAt, ...(payload.v === 2 ? { confirmationGeneration: payload.g as number } : {}) };
}

export function buildOvertimeConfirmationUrl(
  publicBaseUrl: string,
  recordId: string,
  ticket: string,
): string {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    throw new BadRequestException('加班确认页面公网地址无效');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    url.hostname.toLowerCase(),
  );
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password
  ) {
    throw new BadRequestException('加班确认页面公网地址必须使用 HTTPS');
  }
  const normalizedTicket = clean(ticket);
  if (!normalizedTicket || normalizedTicket.length > TICKET_MAX_LENGTH) {
    throw new BadRequestException('加班确认令牌无效');
  }
  const basePath = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${basePath}/overtime-confirmation`.replace(/\/{2,}/gu, '/');
  url.search = new URLSearchParams({
    overtimeConfirmation: '1',
    recordId: requireRecordId(recordId),
    ticket: normalizedTicket,
  }).toString();
  url.hash = '';
  return url.toString();
}

function recordsUrl(appToken: string, tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
}

function requestConfig(accessToken: string) {
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: FEISHU_REQUEST_TIMEOUT_MS,
  };
}

function serializeCard(card: Record<string, unknown>): string {
  if (!isPlainObject(card)) throw new BadRequestException('飞书互动卡内容无效');
  const content = JSON.stringify(card);
  if (Buffer.byteLength(content, 'utf8') > CARD_MAX_BYTES) {
    throw new BadRequestException('飞书互动卡内容超过 30 KB');
  }
  return content;
}

function assertFeishuSuccess(payload: any, message: string): void {
  const code = Number(payload?.code || 0);
  if (code !== 0) {
    throw new BadGatewayException(
      `${message}：${clean(payload?.msg || payload?.message) || `飞书错误码 ${code}`}`,
    );
  }
}

function isMissingBitableRecordResponse(payload: unknown): boolean {
  return Number((payload as { code?: unknown } | null)?.code) === 1254043;
}

function isMissingBitableRecordError(error: unknown): boolean {
  const response = (
    error as {
      response?: { status?: unknown; data?: unknown };
    } | null
  )?.response;
  return (
    Number(response?.status) === 404 ||
    isMissingBitableRecordResponse(response?.data)
  );
}

function confirmationSecret(): string {
  return readEnv('FEISHU_OVERTIME_CONFIRMATION_SECRET', ['FEISHU_APP_SECRET']);
}

function signTicket(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update('overtime-confirmation-v1\0')
    .update(encodedPayload)
    .digest('base64url');
}

function requireTicketSecret(value: unknown): string {
  const secret = clean(value);
  if (Buffer.byteLength(secret, 'utf8') < 16) {
    throw new BadRequestException('加班确认签名密钥未配置或过短');
  }
  return secret;
}

function normalizeIssuedAt(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new BadRequestException('加班确认令牌签发时间无效');
  }
  return result;
}

function firstText(fields: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = normalizeBusinessText(extractDisplayText(fields[name]));
    if (value) return value;
  }
  return '';
}

function extractUsers(value: unknown): Array<{ openId: string; name: string }> {
  const result: Array<{ openId: string; name: string }> = [];
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 5 || candidate == null) return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (!isPlainObject(candidate)) return;
    const openId = clean(
      candidate.open_id ||
        candidate.openId ||
        candidate.id ||
        candidate.user_id,
    );
    const name = normalizeBusinessText(
      candidate.name || candidate.en_name || candidate.text,
    );
    if (OPEN_ID_PATTERN.test(openId)) result.push({ openId, name });
    Object.values(candidate).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return uniqueUsers(result);
}

function uniqueUsers(
  source: Array<{ openId: string; name: string }>,
): Array<{ openId: string; name: string }> {
  const result = new Map<string, { openId: string; name: string }>();
  source.forEach((entry) => {
    if (!OPEN_ID_PATTERN.test(entry.openId)) return;
    const previous = result.get(entry.openId);
    result.set(entry.openId, {
      openId: entry.openId,
      name: previous?.name || entry.name,
    });
  });
  return [...result.values()];
}

function normalizeBusinessText(value: unknown): string {
  return (
    typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  )
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function requireRecordId(value: unknown): string {
  const result = clean(value);
  if (!RECORD_ID_PATTERN.test(result)) {
    throw new BadRequestException('加班记录标识无效');
  }
  return result;
}

function requireOpenId(value: unknown): string {
  const result = clean(value);
  if (!OPEN_ID_PATTERN.test(result)) {
    throw new BadRequestException('飞书人员 open_id 无效');
  }
  return result;
}

function cloneJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new BadRequestException('加班多维字段无效');
  try {
    return clone(value);
  } catch {
    throw new BadRequestException('加班多维字段必须可序列化');
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}
