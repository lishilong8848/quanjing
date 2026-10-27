import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  getFeishuAuthPayload,
  readEnv,
} from '../../common/config/external-services.config';
import type { AttendancePeriodicSummaryRun } from './attendance-periodic-summary.scheduler';

const DEFAULT_CHAT_ID = 'oc_3bc648b9b761f24a65366a9b04b32eb2';
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]{3,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{3,252}$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const POLICY_VERSION = 'v1';

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

@Injectable()
export class DailyOperationsPatrolGateway {
  private tenantToken: TenantTokenState | null = null;
  private tenantTokenPromise: Promise<string> | null = null;

  constructor(private readonly httpService: HttpService) {}

  chatId(): string {
    const value = readEnv('NANTONG_DAILY_PATROL_CHAT_ID') || DEFAULT_CHAT_ID;
    if (!CHAT_ID_PATTERN.test(value)) {
      throw new BadRequestException(
        '南通每日运维巡视目标群 Chat ID 未配置或无效',
      );
    }
    return value;
  }

  async sendCard(
    card: object,
    businessDate: string,
    deliveryIdentity?: string,
  ): Promise<string> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) {
      throw new BadRequestException('南通每日运维巡视业务日期无效');
    }
    const chatId = this.chatId();
    return this.sendGroupCard(
      card,
      stableDailyOperationsPatrolMessageUuid(
        businessDate,
        chatId,
        deliveryIdentity,
      ),
      '发送南通每日运维巡视卡片失败',
    );
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BadRequestException('南通每日运维巡视消息 ID 无效');
    }
    const response = await this.httpService.axiosRef.patch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { content: serializeCard(card) },
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '更新南通每日运维巡视卡片失败');
  }

  async sendAttendancePeriodicSummaryCard(
    card: object,
    run: AttendancePeriodicSummaryRun,
  ): Promise<string> {
    assertPeriodicSummaryRun(run);
    const chatId = this.chatId();
    return this.sendGroupCard(
      card,
      stableAttendancePeriodicSummaryMessageUuid(run, chatId),
      '发送考勤通晒卡片失败',
    );
  }

  private async sendGroupCard(
    card: object,
    uuid: string,
    failureMessage: string,
  ): Promise<string> {
    const chatId = this.chatId();
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: chatId,
        msg_type: 'interactive',
        content: serializeCard(card),
        uuid,
      },
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, failureMessage);
    const messageId = clean(response.data?.data?.message_id);
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BadGatewayException(`${failureMessage}：响应缺少消息标识`);
    }
    return messageId;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now()) {
      return this.tenantToken.value;
    }
    if (this.tenantTokenPromise) return this.tenantTokenPromise;
    this.tenantTokenPromise = (async () => {
      const response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        { timeout: REQUEST_TIMEOUT_MS },
      );
      assertFeishuSuccess(response.data, '获取飞书应用访问令牌失败');
      const value = clean(response.data?.tenant_access_token);
      if (!value) throw new BadGatewayException('获取飞书应用访问令牌失败');
      const expires = Math.max(60, Number(response.data?.expire || 7_200));
      this.tenantToken = {
        value,
        expiresAt: Date.now() + Math.max(30_000, expires * 1_000 - 60_000),
      };
      return value;
    })().finally(() => {
      this.tenantTokenPromise = null;
    });
    return this.tenantTokenPromise;
  }
}

export function stableDailyOperationsPatrolMessageUuid(
  businessDate: string,
  chatId: string,
  deliveryIdentity?: string,
): string {
  const identitySuffix = deliveryIdentity ? `:${deliveryIdentity}` : '';
  return `dop_${createHash('sha256')
    .update(
      `daily-operations-patrol:${POLICY_VERSION}:${businessDate}:${chatId}${identitySuffix}`,
    )
    .digest('hex')
    .slice(0, 40)}`;
}

export function stableAttendancePeriodicSummaryMessageUuid(
  run: Pick<AttendancePeriodicSummaryRun, 'period' | 'startDate' | 'endDate'>,
  chatId: string,
): string {
  assertPeriodicSummaryRun(run);
  return `aps_${createHash('sha256')
    .update(
      `attendance-periodic-summary:v1:${run.period}:${run.startDate}:${run.endDate}:${chatId}`,
    )
    .digest('hex')
    .slice(0, 40)}`;
}

function assertPeriodicSummaryRun(
  run: Pick<AttendancePeriodicSummaryRun, 'period' | 'startDate' | 'endDate'>,
): void {
  if (!['weekly', 'monthly'].includes(run.period)) {
    throw new BadRequestException('考勤通晒周期无效');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(run.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(run.endDate) ||
    run.startDate > run.endDate
  ) {
    throw new BadRequestException('考勤通晒日期范围无效');
  }
}

function serializeCard(card: object): string {
  const content = JSON.stringify(card);
  if (Buffer.byteLength(content, 'utf8') > 30 * 1_024) {
    throw new BadRequestException('南通每日运维巡视卡片内容超过 30 KiB');
  }
  return content;
}

function requestConfig(token: string): Record<string, unknown> {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    timeout: REQUEST_TIMEOUT_MS,
  };
}

function assertFeishuSuccess(payload: any, message: string): void {
  if (payload?.code === 0) return;
  throw new BadGatewayException(
    `${message}：${clean(payload?.msg || payload?.message || payload?.code || '未知错误')}`,
  );
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 300);
}
