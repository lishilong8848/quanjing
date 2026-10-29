import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readEnv } from '../../common/config/external-services.config';
import { readPublicApplicationUrl } from '../../common/config/public-application-url';

const TICKET_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_RANGE_DAYS = 31;
const DEFAULT_MAX_AGE_MS = 35 * 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 30_000;

export interface TodayOperationsFollowUpTicketPayload {
  from: string;
  through: string;
  issuedAt: number;
  appId?: string;
}

@Injectable()
export class TodayOperationsFollowUpTicketService {
  issueUrl(
    input: Omit<TodayOperationsFollowUpTicketPayload, 'issuedAt'>,
  ): string {
    const ticket = issueTodayOperationsFollowUpTicket(
      { ...input, appId: readEnv('FEISHU_APP_ID'), issuedAt: Date.now() },
      ticketSecret(),
    );
    return buildTodayOperationsFollowUpUrl(publicBaseUrl(), ticket);
  }

  verify(ticket: string): TodayOperationsFollowUpTicketPayload {
    const scope = verifyTodayOperationsFollowUpTicket(ticket, ticketSecret(), {
      now: Date.now(),
    });
    if (scope.appId && scope.appId !== readEnv('FEISHU_APP_ID')) throw invalidTicket();
    return scope;
  }
}

export function issueTodayOperationsFollowUpTicket(
  input: TodayOperationsFollowUpTicketPayload,
  secretValue: string,
): string {
  const payload = normalize(input);
  const encoded = Buffer.from(
    JSON.stringify({
      f: payload.from,
      i: payload.issuedAt,
      t: payload.through,
      v: payload.appId === undefined ? 1 : 2,
      ...(payload.appId !== undefined ? { a: payload.appId } : {}),
    }),
    'utf8',
  ).toString('base64url');
  return `${encoded}.${sign(encoded, requireSecret(secretValue))}`;
}

export function verifyTodayOperationsFollowUpTicket(
  ticketValue: string,
  secretValue: string,
  options: { now: number; maxAgeMs?: number },
): TodayOperationsFollowUpTicketPayload {
  const ticket = clean(ticketValue);
  const secret = requireSecret(secretValue);
  if (!TICKET_PATTERN.test(ticket) || ticket.length > 2_048)
    throw invalidTicket();
  const [encoded = '', signature = ''] = ticket.split('.');
  if (!constantTimeEqual(signature, sign(encoded, secret)))
    throw invalidTicket();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalidTicket();
  }
  if (
    !isRecord(decoded) ||
    !((decoded.v === 1 && Object.keys(decoded).sort().join(',') === 'f,i,t,v') ||
      (decoded.v === 2 && Object.keys(decoded).sort().join(',') === 'a,f,i,t,v'))
  ) {
    throw invalidTicket();
  }
  let payload: TodayOperationsFollowUpTicketPayload;
  try {
    payload = normalize({
      from: decoded.f as string,
      through: decoded.t as string,
      issuedAt: decoded.i as number,
      ...(decoded.v === 2 ? { appId: decoded.a as string } : {}),
    });
  } catch {
    throw invalidTicket();
  }
  const now = Number(options.now);
  const maxAgeMs = Number(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    payload.issuedAt > now + CLOCK_SKEW_MS
  ) {
    throw invalidTicket();
  }
  if (now - payload.issuedAt > maxAgeMs) {
    throw new UnauthorizedException('异常跟进令牌已过期');
  }
  return payload;
}

export function buildTodayOperationsFollowUpUrl(
  publicBaseUrlValue: string,
  ticketValue: string,
): string {
  let url: URL;
  try {
    url = new URL(clean(publicBaseUrlValue));
  } catch {
    throw new BadRequestException('异常跟进公网地址无效');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    url.hostname.toLowerCase(),
  );
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password
  ) {
    throw new BadRequestException('异常跟进公网地址必须使用 HTTPS');
  }
  const ticket = clean(ticketValue);
  if (!TICKET_PATTERN.test(ticket))
    throw new BadRequestException('异常跟进令牌无效');
  const basePath = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${basePath}/attendance-anomaly-follow-up`.replace(
    /\/{2,}/gu,
    '/',
  );
  url.search = new URLSearchParams({ ticket }).toString();
  url.hash = '';
  return url.toString();
}

function normalize(input: TodayOperationsFollowUpTicketPayload) {
  const from = clean(input?.from);
  const through = clean(input?.through);
  const issuedAt = Number(input?.issuedAt);
  if (input.appId !== undefined && (typeof input.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,124}$/u.test(input.appId))) throw new BadRequestException('异常跟进应用身份无效');
  if (
    !DATE_PATTERN.test(from) ||
    !DATE_PATTERN.test(through) ||
    from > through ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt <= 0
  ) {
    throw new BadRequestException('异常跟进令牌内容无效');
  }
  const rangeDays = Math.round(
    (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
  if (rangeDays < 0 || rangeDays >= MAX_RANGE_DAYS) {
    throw new BadRequestException('异常跟进日期范围不能超过 31 天');
  }
  return { from, through, issuedAt, ...(input.appId !== undefined ? { appId: input.appId } : {}) };
}

function publicBaseUrl(): string {
  const value = readPublicApplicationUrl([
    'NANTONG_DAILY_PATROL_PUBLIC_BASE_URL',
    'FEISHU_PUBLIC_BASE_URL',
    'APP_PUBLIC_URL',
  ]);
  if (!value) throw new BadRequestException('异常跟进公网地址未配置');
  return value;
}

function ticketSecret(): string {
  return readEnv('DAILY_OPERATIONS_FOLLOW_UP_TICKET_SECRET', [
    'FEISHU_APP_SECRET',
  ]);
}

function requireSecret(value: unknown): string {
  const secret = clean(value);
  if (Buffer.byteLength(secret, 'utf8') < 16) {
    throw new BadRequestException('异常跟进签名密钥未配置或过短');
  }
  return secret;
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret)
    .update('today-operations-follow-up-v1\0')
    .update(encoded)
    .digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}

function invalidTicket(): UnauthorizedException {
  return new UnauthorizedException('异常跟进令牌无效');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
