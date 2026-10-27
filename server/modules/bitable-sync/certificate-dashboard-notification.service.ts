import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CampusCertificateDashboardResponse,
  CampusCertificateExpiryEvent,
  CampusCertificateExpiryNotificationCertificate,
  CampusCertificateExpiryNotificationPerson,
  CampusCertificateExpiryNotificationPreview,
  CampusCertificateExpiryNotificationRequest,
  CampusCertificateExpiryNotificationResponse,
  CampusCertificatePerson,
} from '../../../shared/api.interface';
import { CertificateDashboardService } from './certificate-dashboard.service';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const DEFAULT_REMINDER_CHAT_ID = 'oc_8402dd5799db4fba085334749bfbb635';
const TOKEN_EXPIRY_BUFFER_SECONDS = 300;
const MEMBER_CACHE_TTL_MS = 2 * 60 * 1000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

interface FeishuGroupMember {
  openId: string;
  name: string;
}

interface MatchedReminderRecipient {
  person: CampusCertificatePerson;
  openId: string;
  certificates: CampusCertificateExpiryNotificationCertificate[];
}

interface ReminderRecipientMatch {
  matched: MatchedReminderRecipient[];
  unmatchedNames: string[];
  ambiguousNames: string[];
  publicPeople: CampusCertificateExpiryNotificationPerson[];
}

interface PreviewBatch {
  createdAt: number;
  dashboardFingerprint: string;
  preview: CampusCertificateExpiryNotificationPreview;
  matched: MatchedReminderRecipient[];
}

interface CachedResult {
  createdAt: number;
  result: CampusCertificateExpiryNotificationResponse;
}

interface SelfTestSuccessResponse {
  success: true;
  name: string;
  sentAt: string;
}

export function matchCertificateReminderRecipients(
  people: CampusCertificatePerson[],
  groupMembers: FeishuGroupMember[],
  expiryEvents: CampusCertificateExpiryEvent[],
): ReminderRecipientMatch {
  const peopleByName = groupByNormalizedName(people, (person) => person.name);
  const membersByName = groupByNormalizedName(
    groupMembers.filter((member) => member.openId && member.name),
    (member) => member.name,
  );
  const statusByPersonId = new Map<
    string,
    CampusCertificateExpiryNotificationPerson['matchStatus']
  >();
  const matched: MatchedReminderRecipient[] = [];
  const unmatchedNames: string[] = [];
  const ambiguousNames: string[] = [];

  for (const [normalizedName, sourcePeople] of peopleByName) {
    const groupMatches = membersByName.get(normalizedName) ?? [];
    const displayName = compactDisplayName(sourcePeople[0]?.name);
    if (sourcePeople.length !== 1 || groupMatches.length > 1) {
      for (const person of sourcePeople) {
        statusByPersonId.set(person.id, 'ambiguous');
      }
      ambiguousNames.push(displayName);
      continue;
    }

    const person = sourcePeople[0];
    const member = groupMatches[0];
    if (!member) {
      statusByPersonId.set(person.id, 'unmatched');
      unmatchedNames.push(displayName);
      continue;
    }

    const certificates = certificatesForPerson(person.id, expiryEvents);
    statusByPersonId.set(person.id, 'matched');
    matched.push({
      person,
      openId: member.openId,
      certificates,
    });
  }

  const publicPeople = people.map((person) => ({
    id: person.id,
    name: person.name,
    building: person.building,
    position: person.position,
    certificates: certificatesForPerson(person.id, expiryEvents),
    matchStatus: statusByPersonId.get(person.id) ?? 'unmatched',
  }));

  return {
    matched,
    unmatchedNames: uniqueSortedNames(unmatchedNames),
    ambiguousNames: uniqueSortedNames(ambiguousNames),
    publicPeople,
  };
}

@Injectable()
export class CertificateDashboardNotificationService {
  private readonly logger = new Logger(
    CertificateDashboardNotificationService.name,
  );
  private tenantToken:
    | {
        value: string;
        expiresAt: number;
      }
    | undefined;
  private tenantTokenRequest: Promise<string> | undefined;
  private memberCache:
    | {
        chatId: string;
        expiresAt: number;
        members: FeishuGroupMember[];
      }
    | undefined;
  private memberRequest: Promise<FeishuGroupMember[]> | undefined;
  private readonly previews = new Map<string, PreviewBatch>();
  private readonly activeBatches = new Map<
    string,
    Promise<CampusCertificateExpiryNotificationResponse>
  >();
  private readonly completedBatches = new Map<string, CachedResult>();

  constructor(
    private readonly httpService: HttpService,
    private readonly certificateDashboardService: CertificateDashboardService,
  ) {}

  async previewExpiryNotifications(): Promise<CampusCertificateExpiryNotificationPreview> {
    this.purgeExpiredBatches();
    const dashboard = await this.certificateDashboardService.getDashboard();
    const requestId = randomUUID();
    const expiringPeople = dashboard.people.filter((person) =>
      Boolean(person.expiryReminder.trim()),
    );

    if (dashboard.sourceStatus !== 'fresh') {
      const preview = this.buildBlockedPreview(
        requestId,
        dashboard,
        expiringPeople,
      );
      this.previews.set(requestId, {
        createdAt: Date.now(),
        dashboardFingerprint: fingerprintDashboard(dashboard),
        preview,
        matched: [],
      });
      return preview;
    }

    const relevantEvents = selectUpcomingExpiryEvents(dashboard);
    const match =
      expiringPeople.length === 0
        ? {
            matched: [],
            unmatchedNames: [],
            ambiguousNames: [],
            publicPeople: [],
          }
        : matchCertificateReminderRecipients(
            expiringPeople,
            await this.getGroupMembers(),
            relevantEvents,
          );
    const preview: CampusCertificateExpiryNotificationPreview = {
      requestId,
      totalPeople: expiringPeople.length,
      matchedCount: match.matched.length,
      unmatchedNames: match.unmatchedNames,
      ambiguousNames: match.ambiguousNames,
      blocked: false,
      people: match.publicPeople,
      sourceUpdatedAt: dashboard.sourceUpdatedAt,
      syncedAt: dashboard.syncedAt,
    };
    this.previews.set(requestId, {
      createdAt: Date.now(),
      dashboardFingerprint: fingerprintDashboard(dashboard),
      preview,
      matched: match.matched,
    });
    return preview;
  }

  async sendExpiryNotifications(
    request: CampusCertificateExpiryNotificationRequest,
  ): Promise<CampusCertificateExpiryNotificationResponse> {
    const requestId = validateRequestId(request?.requestId);
    this.purgeExpiredBatches();

    const completed = this.completedBatches.get(requestId);
    if (completed) {
      return completed.result;
    }
    const active = this.activeBatches.get(requestId);
    if (active) {
      return active;
    }

    const operation = this.executeExpiryNotificationBatch(requestId).finally(
      () => {
        this.activeBatches.delete(requestId);
      },
    );
    this.activeBatches.set(requestId, operation);
    return operation;
  }

  async sendSelfTestSuccess(
    personName: string,
    idempotencyKey: string,
  ): Promise<SelfTestSuccessResponse> {
    const targetName = compactDisplayName(personName);
    if (!targetName || !idempotencyKey.trim()) {
      throw new BadRequestException('自测接收人和幂等键不能为空');
    }
    const normalizedTarget = normalizePersonName(targetName);
    const matches = (await this.getGroupMembers()).filter(
      (member) => normalizePersonName(member.name) === normalizedTarget,
    );
    if (matches.length !== 1) {
      throw new ServiceUnavailableException(
        matches.length === 0
          ? '群成员中未找到唯一的自测接收人'
          : '群成员中存在同名自测接收人，已阻止发送',
      );
    }

    await this.sendDirectTextMessage(
      matches[0].openId,
      [
        '【园区持证看板】',
        '园区持证看板飞书通知功能自测成功。',
        `自测时间：${formatShanghaiDateTime(new Date())}`,
      ].join('\n'),
      stableMessageUuid(idempotencyKey, matches[0].openId),
    );
    return {
      success: true,
      name: targetName,
      sentAt: new Date().toISOString(),
    };
  }

  private async executeExpiryNotificationBatch(
    requestId: string,
  ): Promise<CampusCertificateExpiryNotificationResponse> {
    const batch = this.previews.get(requestId);
    if (!batch || Date.now() - batch.createdAt > PREVIEW_TTL_MS) {
      throw new BadRequestException('通知预览已失效，请重新加载预览');
    }
    if (batch.preview.blocked) {
      throw new ServiceUnavailableException(
        batch.preview.blockedReason || '源数据不是最新状态，已阻止发送',
      );
    }

    const dashboard = await this.certificateDashboardService.getDashboard();
    if (dashboard.sourceStatus !== 'fresh') {
      throw new ServiceUnavailableException('源数据不是最新状态，已阻止发送');
    }
    if (fingerprintDashboard(dashboard) !== batch.dashboardFingerprint) {
      throw new ServiceUnavailableException('源数据已更新，请重新加载通知预览');
    }

    const outcomes = await Promise.all(
      batch.matched.map(async (recipient) => {
        try {
          await this.sendDirectTextMessage(
            recipient.openId,
            buildExpiryReminderMessage(
              recipient,
              batch.preview.sourceUpdatedAt,
            ),
            stableMessageUuid(requestId, recipient.person.id),
          );
          return { success: true as const, name: recipient.person.name };
        } catch (error: unknown) {
          this.logger.warn('园区持证到期提醒存在单人发送失败');
          return {
            success: false as const,
            name: recipient.person.name,
            message: safePublicFailureMessage(error),
          };
        }
      }),
    );
    const failures = outcomes
      .filter(
        (
          outcome,
        ): outcome is {
          success: false;
          name: string;
          message: string;
        } => !outcome.success,
      )
      .map(({ name, message }) => ({ name, message }));
    const sentCount = outcomes.length - failures.length;
    const result: CampusCertificateExpiryNotificationResponse = {
      success:
        failures.length === 0 &&
        batch.preview.unmatchedNames.length === 0 &&
        batch.preview.ambiguousNames.length === 0,
      requestId,
      attemptedCount: outcomes.length,
      sentCount,
      failedCount: failures.length,
      unmatchedNames: batch.preview.unmatchedNames,
      ambiguousNames: batch.preview.ambiguousNames,
      failures,
      sentAt: new Date().toISOString(),
    };
    this.completedBatches.set(requestId, {
      createdAt: Date.now(),
      result,
    });
    return result;
  }

  private buildBlockedPreview(
    requestId: string,
    dashboard: CampusCertificateDashboardResponse,
    people: CampusCertificatePerson[],
  ): CampusCertificateExpiryNotificationPreview {
    const relevantEvents = selectUpcomingExpiryEvents(dashboard);
    return {
      requestId,
      totalPeople: people.length,
      matchedCount: 0,
      unmatchedNames: [],
      ambiguousNames: [],
      blocked: true,
      blockedReason: '源数据不是最新状态，已阻止飞书通知',
      people: people.map((person) => ({
        id: person.id,
        name: person.name,
        building: person.building,
        position: person.position,
        certificates: certificatesForPerson(person.id, relevantEvents),
        matchStatus: 'unmatched',
      })),
      sourceUpdatedAt: dashboard.sourceUpdatedAt,
      syncedAt: dashboard.syncedAt,
    };
  }

  private async getGroupMembers(): Promise<FeishuGroupMember[]> {
    const chatId =
      String(process.env.FEISHU_CERTIFICATE_REMINDER_CHAT_ID || '').trim() ||
      DEFAULT_REMINDER_CHAT_ID;
    if (
      this.memberCache &&
      this.memberCache.chatId === chatId &&
      this.memberCache.expiresAt > Date.now()
    ) {
      return this.memberCache.members;
    }
    if (this.memberRequest) {
      return this.memberRequest;
    }

    this.memberRequest = this.fetchAllGroupMembers(chatId)
      .then((members) => {
        this.memberCache = {
          chatId,
          expiresAt: Date.now() + MEMBER_CACHE_TTL_MS,
          members,
        };
        return members;
      })
      .finally(() => {
        this.memberRequest = undefined;
      });
    return this.memberRequest;
  }

  private async fetchAllGroupMembers(
    chatId: string,
  ): Promise<FeishuGroupMember[]> {
    const tenantAccessToken = await this.getTenantAccessToken();
    const members: FeishuGroupMember[] = [];
    let declaredUserTotal = 0;
    let pageToken: string | undefined;
    const visitedPageTokens = new Set<string>();

    do {
      const response = await this.httpService.axiosRef.get(
        `${FEISHU_API_BASE}/im/v1/chats/${encodeURIComponent(chatId)}/members/list`,
        {
          headers: { Authorization: `Bearer ${tenantAccessToken}` },
          params: {
            member_id_type: 'open_id',
            member_types: 'user',
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );
      const payload = asObject(response.data);
      if (Number(payload?.code) !== 0) {
        throw feishuOperationError('读取提醒群成员', payload?.code);
      }
      const data = asObject(payload?.data);
      if (
        data?.trigger_security_conf_limit === true ||
        payload?.trigger_security_conf_limit === true
      ) {
        throw new ServiceUnavailableException(
          '飞书群成员目录受安全限制未完整返回，已阻止通知',
        );
      }
      const truncations = Array.isArray(data?.truncations)
        ? data.truncations
        : [];
      if (truncations.length > 0) {
        throw new ServiceUnavailableException(
          '飞书群成员目录存在截断，已阻止通知',
        );
      }
      const currentUserTotal = Number(data?.user_total);
      if (Number.isFinite(currentUserTotal) && currentUserTotal > 0) {
        declaredUserTotal = Math.max(declaredUserTotal, currentUserTotal);
      }
      const items = Array.isArray(data?.users)
        ? data.users
        : Array.isArray(data?.items)
          ? data.items
          : [];
      for (const item of items) {
        const member = asObject(item);
        const openId = String(member?.member_id || '').trim();
        const name = String(member?.name || '').trim();
        if (
          openId &&
          name &&
          (!member?.member_id_type || member.member_id_type === 'open_id')
        ) {
          members.push({ openId, name });
        }
      }

      const hasMore = data?.has_more === true;
      const nextPageToken = String(data?.page_token || '').trim();
      if (!hasMore) {
        pageToken = undefined;
      } else if (!nextPageToken || visitedPageTokens.has(nextPageToken)) {
        throw new ServiceUnavailableException(
          '飞书群成员目录分页异常，已阻止通知',
        );
      } else {
        visitedPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
    } while (pageToken);

    if (declaredUserTotal > members.length) {
      throw new ServiceUnavailableException(
        '飞书群成员目录返回不完整，已阻止通知',
      );
    }

    return members;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now()) {
      return this.tenantToken.value;
    }
    if (this.tenantTokenRequest) {
      return this.tenantTokenRequest;
    }

    this.tenantTokenRequest = this.fetchTenantAccessToken().finally(() => {
      this.tenantTokenRequest = undefined;
    });
    return this.tenantTokenRequest;
  }

  private async fetchTenantAccessToken(): Promise<string> {
    const appId = getRequiredEnv('FEISHU_APP_ID', '飞书应用配置缺失');
    const appSecret = getRequiredEnv('FEISHU_APP_SECRET', '飞书应用配置缺失');
    const response = await this.httpService.axiosRef.post(
      `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
      {
        app_id: appId,
        app_secret: appSecret,
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const payload = asObject(response.data);
    const token = String(payload?.tenant_access_token || '').trim();
    if (Number(payload?.code) !== 0 || !token) {
      throw feishuOperationError('获取应用访问令牌', payload?.code);
    }
    const expiresInSeconds = Math.max(60, Number(payload?.expire) || 7200);
    this.tenantToken = {
      value: token,
      expiresAt:
        Date.now() +
        Math.max(60, expiresInSeconds - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000,
    };
    return token;
  }

  private async sendDirectTextMessage(
    openId: string,
    text: string,
    uuid: string,
  ): Promise<void> {
    const tenantAccessToken = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.post(
      `${FEISHU_API_BASE}/im/v1/messages`,
      {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        uuid,
      },
      {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        params: { receive_id_type: 'open_id' },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    const payload = asObject(response.data);
    if (Number(payload?.code) !== 0) {
      throw feishuOperationError('发送飞书消息', payload?.code);
    }
    const data = asObject(payload?.data);
    const messageId = String(data?.message_id || '').trim();
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) {
      throw feishuOperationError('发送飞书消息响应缺少 message_id', 'missing');
    }
  }

  private purgeExpiredBatches(): void {
    const now = Date.now();
    for (const [requestId, batch] of this.previews) {
      if (now - batch.createdAt > PREVIEW_TTL_MS) {
        this.previews.delete(requestId);
      }
    }
    for (const [requestId, cached] of this.completedBatches) {
      if (now - cached.createdAt > RESULT_TTL_MS) {
        this.completedBatches.delete(requestId);
      }
    }
  }
}

function groupByNormalizedName<T>(
  values: T[],
  getName: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const name = normalizePersonName(getName(value));
    if (!name) continue;
    const group = groups.get(name) ?? [];
    group.push(value);
    groups.set(name, group);
  }
  return groups;
}

function normalizePersonName(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function compactDisplayName(value: string | undefined): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .trim();
}

function certificatesForPerson(
  personId: string,
  expiryEvents: CampusCertificateExpiryEvent[],
): CampusCertificateExpiryNotificationCertificate[] {
  const seen = new Set<string>();
  return expiryEvents
    .filter((event) => event.personId === personId)
    .sort((left, right) => left.date.localeCompare(right.date))
    .flatMap((event) => {
      const key = `${event.certificateName}\u0000${event.date}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          certificateName: event.certificateName,
          expiryDate: event.date,
        },
      ];
    });
}

function selectUpcomingExpiryEvents(
  dashboard: CampusCertificateDashboardResponse,
): CampusCertificateExpiryEvent[] {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const start = Date.parse(`${today}T00:00:00.000Z`);
  const end = start + 90 * 24 * 60 * 60 * 1000;
  return dashboard.expiryEvents.filter((event) => {
    const timestamp = Date.parse(`${event.date}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}

function buildExpiryReminderMessage(
  recipient: MatchedReminderRecipient,
  sourceUpdatedAt: string | null,
): string {
  const certificateLines =
    recipient.certificates.length > 0
      ? recipient.certificates.map(
          (certificate) =>
            `- ${certificate.certificateName}：${certificate.expiryDate}（${formatRemainingDays(certificate.expiryDate)}）`,
        )
      : [`- ${recipient.person.expiryReminder}`];
  return [
    '【证件到期提醒】',
    `${recipient.person.name}，您好：`,
    '您的以下证件将在90天内到期，请及时安排复审或换证：',
    ...certificateLines,
    `楼栋/岗位：${recipient.person.building} / ${recipient.person.position}`,
    sourceUpdatedAt
      ? `数据更新时间：${formatShanghaiDateTime(new Date(sourceUpdatedAt))}`
      : '',
    '请及时完成复审或换证；如已处理，请忽略本消息。',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatRemainingDays(expiryDate: string): string {
  const today = shanghaiDateKey(new Date());
  const start = Date.parse(`${today}T00:00:00.000Z`);
  const expiry = Date.parse(`${expiryDate}T00:00:00.000Z`);
  if (!Number.isFinite(expiry)) return '到期日待核对';
  const days = Math.round((expiry - start) / (24 * 60 * 60 * 1000));
  if (days === 0) return '今天到期';
  if (days > 0) return `剩余${days}天`;
  return `已过期${Math.abs(days)}天`;
}

function shanghaiDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function stableMessageUuid(batchKey: string, recipientKey: string): string {
  return createHash('sha256')
    .update(`campus-certificate:${batchKey}:${recipientKey}`)
    .digest('hex')
    .slice(0, 32);
}

function fingerprintDashboard(
  dashboard: CampusCertificateDashboardResponse,
): string {
  const people = dashboard.people
    .filter((person) => Boolean(person.expiryReminder.trim()))
    .map((person) => [
      person.id,
      person.name,
      person.expiryReminder,
      person.highVoltageExpiryDate,
      person.lowVoltageExpiryDate,
      person.heightWorkExpiryDate,
    ]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        sourceUpdatedAt: dashboard.sourceUpdatedAt,
        people,
      }),
    )
    .digest('hex');
}

function validateRequestId(value: unknown): string {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (!requestId || requestId.length > 100) {
    throw new BadRequestException('通知请求标识无效，请重新加载预览');
  }
  return requestId;
}

function getRequiredEnv(name: string, message: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new ServiceUnavailableException(message);
  }
  return value;
}

function uniqueSortedNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN'),
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function feishuOperationError(operation: string, code: unknown): Error {
  const normalizedCode =
    typeof code === 'number' || typeof code === 'string'
      ? String(code)
      : 'unknown';
  const error = new Error(
    `${operation}失败（code=${normalizedCode}）`,
  ) as Error & {
    feishuCode?: string;
  };
  error.feishuCode = normalizedCode;
  return error;
}

function safePublicFailureMessage(error: unknown): string {
  const code = (error as { feishuCode?: unknown })?.feishuCode;
  if (typeof code === 'string' && /^[0-9-]+$/.test(code)) {
    return `飞书消息发送失败（code=${code}）`;
  }
  return error instanceof ServiceUnavailableException
    ? error.message
    : '飞书消息发送失败';
}

function formatShanghaiDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return '未知';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
