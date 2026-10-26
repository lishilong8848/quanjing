import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readEnv } from '../../common/config/external-services.config';

const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const TICKET_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const DEFAULT_MAX_AGE_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const MAX_TICKET_LENGTH = 2_048;

export interface PurchaseBatchAttachmentTicketPayload {
  approvalBatchId: string;
  executionRecordId: string;
  actorOpenId: string;
  role: 'purchaser' | 'requester';
  purpose: 'payment' | 'receipt';
  issuedAt: number;
}

@Injectable()
export class PurchaseBatchAttachmentTicketService {
  issueUrl(
    input: Omit<PurchaseBatchAttachmentTicketPayload, 'issuedAt'>,
  ): string {
    const ticket = issuePurchaseBatchAttachmentTicket(
      { ...input, issuedAt: Date.now() },
      attachmentTicketSecret(),
    );
    return buildPurchaseBatchAttachmentUrl(
      publicBaseUrl(),
      ticket,
      readEnv('CLIENT_BASE_PATH'),
    );
  }

  verify(ticket: string): PurchaseBatchAttachmentTicketPayload {
    return verifyPurchaseBatchAttachmentTicket(
      ticket,
      attachmentTicketSecret(),
      { now: Date.now() },
    );
  }
}

export function issuePurchaseBatchAttachmentTicket(
  input: PurchaseBatchAttachmentTicketPayload,
  secretValue: string,
): string {
  const payload = normalizePayload(input);
  const secret = requireSecret(secretValue);
  const encoded = Buffer.from(
    JSON.stringify({
      a: payload.approvalBatchId,
      i: payload.issuedAt,
      o: payload.actorOpenId,
      p: payload.purpose,
      r: payload.executionRecordId,
      x: payload.role,
      v: 1,
    }),
    'utf8',
  ).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyPurchaseBatchAttachmentTicket(
  ticketValue: string,
  secretValue: string,
  options: { now: number; maxAgeMs?: number },
): PurchaseBatchAttachmentTicketPayload {
  const ticket = clean(ticketValue);
  const secret = requireSecret(secretValue);
  if (
    !ticket ||
    ticket.length > MAX_TICKET_LENGTH ||
    !TICKET_PATTERN.test(ticket)
  ) {
    throw invalidTicket();
  }
  const [encoded = '', signature = ''] = ticket.split('.');
  if (!constantTimeEqual(signature, sign(encoded, secret))) {
    throw invalidTicket();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalidTicket();
  }
  if (
    !isRecord(decoded) ||
    JSON.stringify(Object.keys(decoded).sort()) !==
      JSON.stringify(['a', 'i', 'o', 'p', 'r', 'v', 'x']) ||
    decoded.v !== 1
  ) {
    throw invalidTicket();
  }
  let payload: PurchaseBatchAttachmentTicketPayload;
  try {
    payload = normalizePayload({
      approvalBatchId: decoded.a as string,
      executionRecordId: decoded.r as string,
      actorOpenId: decoded.o as string,
      role: decoded.x as 'purchaser' | 'requester',
      purpose: decoded.p as 'payment' | 'receipt',
      issuedAt: decoded.i as number,
    });
  } catch {
    throw invalidTicket();
  }
  const now = Number(options?.now);
  const maxAgeMs = Number(options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    payload.issuedAt > now + CLOCK_SKEW_MS ||
    now - payload.issuedAt > maxAgeMs
  ) {
    throw new UnauthorizedException('采购附件上传令牌已过期');
  }
  return payload;
}

export function buildPurchaseBatchAttachmentUrl(
  publicBaseUrlValue: string,
  ticketValue: string,
  clientBasePathValue = '',
): string {
  let url: URL;
  try {
    url = new URL(clean(publicBaseUrlValue));
  } catch {
    throw new BadRequestException('采购附件上传公网地址无效');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    url.hostname.toLowerCase(),
  );
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password
  ) {
    throw new BadRequestException('采购附件上传公网地址必须使用 HTTPS');
  }
  const ticket = clean(ticketValue);
  if (
    !ticket ||
    ticket.length > MAX_TICKET_LENGTH ||
    !TICKET_PATTERN.test(ticket)
  ) {
    throw new BadRequestException('采购附件上传令牌无效');
  }
  const publicBasePath = normalizeSafeBasePath(url.pathname);
  const clientBasePath = normalizeSafeBasePath(clientBasePathValue);
  const basePath =
    clientBasePath &&
    (publicBasePath === clientBasePath ||
      publicBasePath.endsWith(clientBasePath))
      ? publicBasePath
      : `${publicBasePath}${clientBasePath}`;
  url.pathname = `${basePath}/purchase-card-attachments`.replace(
    /\/{2,}/gu,
    '/',
  );
  url.search = new URLSearchParams({ ticket }).toString();
  url.hash = '';
  return url.toString();
}

function normalizeSafeBasePath(value: unknown): string {
  const path = clean(value);
  if (!path || path === '/') return '';
  if (
    path.includes('\\') ||
    /[\u0000-\u001f\u007f?#]/u.test(path) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(path) ||
    path.startsWith('//')
  ) {
    throw new BadRequestException('采购附件上传基础路径无效');
  }
  const segments = path.replace(/^\/+|\/+$/gu, '').split('/');
  if (segments.some((segment) => !isSafePathSegment(segment))) {
    throw new BadRequestException('采购附件上传基础路径无效');
  }
  return `/${segments.join('/')}`;
}

function isSafePathSegment(value: string): boolean {
  if (!value) return false;
  let decoded = value;
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(decoded)
    ) {
      return false;
    }
    if (!decoded.includes('%')) return true;
  }
  return false;
}

function normalizePayload(
  input: PurchaseBatchAttachmentTicketPayload,
): PurchaseBatchAttachmentTicketPayload {
  const approvalBatchId = clean(input?.approvalBatchId);
  const executionRecordId = clean(input?.executionRecordId);
  const actorOpenId = clean(input?.actorOpenId);
  const issuedAt = Number(input?.issuedAt);
  if (
    !BATCH_ID_PATTERN.test(approvalBatchId) ||
    !RECORD_ID_PATTERN.test(executionRecordId) ||
    !OPEN_ID_PATTERN.test(actorOpenId) ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt <= 0 ||
    !(
      (input.role === 'purchaser' && input.purpose === 'payment') ||
      (input.role === 'requester' && input.purpose === 'receipt')
    )
  ) {
    throw new BadRequestException('采购附件上传令牌内容无效');
  }
  return {
    approvalBatchId,
    executionRecordId,
    actorOpenId,
    role: input.role,
    purpose: input.purpose,
    issuedAt,
  };
}

function publicBaseUrl(): string {
  const value = readEnv('PUBLIC_BASE_URL', [
    'FEISHU_PUBLIC_BASE_URL',
    'APP_PUBLIC_URL',
  ]);
  if (!value) throw new BadRequestException('采购附件上传公网地址未配置');
  return value;
}

function attachmentTicketSecret(): string {
  return readEnv('FEISHU_PURCHASE_CARD_ATTACHMENT_SECRET', [
    'FEISHU_APP_SECRET',
  ]);
}

function requireSecret(value: unknown): string {
  const secret = clean(value);
  if (Buffer.byteLength(secret, 'utf8') < 16) {
    throw new BadRequestException('采购附件上传签名密钥未配置或过短');
  }
  return secret;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update('purchase-card-attachment-v1\0')
    .update(encodedPayload)
    .digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}

function invalidTicket(): UnauthorizedException {
  return new UnauthorizedException('采购附件上传令牌无效');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
