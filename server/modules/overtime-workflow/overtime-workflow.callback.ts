import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { readEnv } from '../../common/config/external-services.config';

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_CHALLENGE_LENGTH = 1_024;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type HeaderValue = string | string[] | undefined;
type Headers = Record<string, HeaderValue>;
type JsonObject = Record<string, unknown>;

type ParsedOvertimeAction =
  | { kind: 'not_overtime' }
  | {
      kind: 'overtime_action';
      actorOpenId: string;
      messageId: string;
      action: 'approve' | 'reject';
      recordId: string;
    };

export interface OvertimeCardCallbackInput {
  headers: Headers;
  rawBody: string | Buffer;
  now: Date | number;
}

export interface OvertimeCardCallbackConfig {
  verificationToken: string;
  encryptKey: string;
}

export type OvertimeCardCallbackResult =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'not_overtime' }
  | {
      kind: 'overtime_action';
      eventId: string;
      actorOpenId: string;
      messageId: string;
      action: 'approve' | 'reject';
      recordId: string;
    };

export function readOvertimeCardCallbackConfig(): OvertimeCardCallbackConfig {
  return {
    verificationToken: readEnv('FEISHU_CARD_VERIFICATION_TOKEN', [
      'FEISHU_OVERTIME_CARD_VERIFICATION_TOKEN',
      'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
    ]),
    encryptKey: readEnv('FEISHU_CARD_ENCRYPT_KEY', [
      'FEISHU_OVERTIME_CARD_ENCRYPT_KEY',
      'FEISHU_PURCHASE_CARD_ENCRYPT_KEY',
    ]),
  };
}

export function parseOvertimeLongConnectionCardAction(
  payload: unknown,
): Extract<OvertimeCardCallbackResult, { kind: 'overtime_action' }> {
  const flattened = requireObject(payload, '飞书卡片长连接回调数据无效');
  if (
    flattened.event_type !== undefined &&
    flattened.event_type !== 'card.action.trigger'
  ) {
    throw new BadRequestException('飞书卡片长连接回调事件类型无效');
  }

  const action = parseOvertimeActionEvent(flattened);
  if (action.kind !== 'overtime_action') {
    throw new BadRequestException('非加班审批卡片回调');
  }
  const eventId = `ws_${createHash('sha256')
    .update(
      JSON.stringify([
        action.actorOpenId,
        action.messageId,
        action.action,
        action.recordId,
      ]),
    )
    .digest('hex')}`;

  return { kind: 'overtime_action', eventId, ...action };
}

export function parseOvertimeCardCallback(
  input: OvertimeCardCallbackInput,
  config: OvertimeCardCallbackConfig,
): OvertimeCardCallbackResult {
  assertConfig(config);
  const now = resolveNow(input.now);
  let payload: JsonObject;
  let unsignedEncryptedChallengeOnly = false;

  if (config.encryptKey) {
    const timestamp = optionalHeader(input.headers, 'x-lark-request-timestamp');
    const nonce = optionalHeader(input.headers, 'x-lark-request-nonce');
    const signature = optionalHeader(input.headers, 'x-lark-signature');
    const present = [timestamp, nonce, signature].filter(
      (value) => value !== undefined,
    ).length;
    if (present === 3) {
      assertFreshTimestamp(timestamp as string, now);
      assertSignature({
        timestamp: timestamp as string,
        nonce: nonce as string,
        signature: signature as string,
        encryptKey: config.encryptKey,
        rawBody: input.rawBody,
      });
    } else if (present === 0) {
      unsignedEncryptedChallengeOnly = true;
    } else {
      throw new UnauthorizedException('飞书卡片回调认证请求头不完整');
    }
    payload = decryptPayload(parseRawBody(input.rawBody), config.encryptKey);
  } else {
    const timestamp = optionalHeader(input.headers, 'x-lark-request-timestamp');
    if (timestamp !== undefined) assertFreshTimestamp(timestamp, now);
    payload = parseRawBody(input.rawBody);
  }

  assertVerificationToken(payload, config.verificationToken);
  if (payload.type === 'url_verification') {
    return parseChallenge(payload);
  }
  if (unsignedEncryptedChallengeOnly) {
    throw new UnauthorizedException('未签名加密回调仅允许网址验证');
  }
  return parseAction(payload);
}

function parseAction(payload: JsonObject): OvertimeCardCallbackResult {
  if (payload.schema !== '2.0') {
    throw new BadRequestException('飞书卡片回调协议版本无效');
  }
  const header = requireObject(payload.header, '飞书卡片回调事件头无效');
  if (header.event_type !== 'card.action.trigger') {
    throw new BadRequestException('飞书卡片回调事件类型无效');
  }
  const eventId = protocolIdentifier(
    header.event_id,
    PROTOCOL_ID_PATTERN,
    '飞书卡片回调事件标识无效',
  );
  const event = requireObject(payload.event, '飞书卡片回调事件无效');
  const action = parseOvertimeActionEvent(event);
  if (action.kind === 'not_overtime') return action;
  return { kind: 'overtime_action', eventId, ...action };
}

function parseOvertimeActionEvent(event: JsonObject): ParsedOvertimeAction {
  const action = requireObject(event.action, '飞书卡片回调动作无效');
  if (
    action.name === 'purchase_reject_submit' ||
    Object.prototype.hasOwnProperty.call(action, 'form_value')
  ) {
    return { kind: 'not_overtime' };
  }
  if (!isObject(action.value)) return { kind: 'not_overtime' };
  const value = action.value;

  if (
    Object.prototype.hasOwnProperty.call(value, 'executionRecordId') &&
    !Object.prototype.hasOwnProperty.call(value, 'recordId')
  ) {
    return { kind: 'not_overtime' };
  }

  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'action' ||
    keys[1] !== 'recordId' ||
    keys[2] !== 'version' ||
    value.version !== 1 ||
    (value.action !== 'approve' && value.action !== 'reject') ||
    typeof value.recordId !== 'string' ||
    !RECORD_ID_PATTERN.test(value.recordId)
  ) {
    throw new BadRequestException('加班审批卡片动作值无效');
  }
  if (action.tag !== 'button') {
    throw new BadRequestException('飞书卡片回调动作标签无效');
  }
  const operator = requireObject(event.operator, '飞书卡片回调操作人无效');
  const actorOpenId = protocolIdentifier(
    operator.open_id,
    OPEN_ID_PATTERN,
    '飞书卡片回调操作人无效',
  );
  const context = requireObject(event.context, '飞书卡片回调消息上下文无效');
  const messageId = protocolIdentifier(
    context.open_message_id,
    MESSAGE_ID_PATTERN,
    '飞书卡片回调消息标识无效',
  );
  return {
    kind: 'overtime_action',
    actorOpenId,
    messageId,
    action: value.action,
    recordId: value.recordId,
  };
}

function parseChallenge(payload: JsonObject): OvertimeCardCallbackResult {
  const challenge = payload.challenge;
  if (
    typeof challenge !== 'string' ||
    !challenge ||
    challenge.length > MAX_CHALLENGE_LENGTH
  ) {
    throw new BadRequestException('飞书卡片回调网址验证格式无效');
  }
  return { kind: 'challenge', challenge };
}

function parseRawBody(rawBody: string | Buffer): JsonObject {
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
    throw new BadRequestException('飞书卡片回调原始请求体无效');
  }
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    return requireObject(JSON.parse(text), '飞书卡片回调请求格式无效');
  } catch {
    throw new BadRequestException('飞书卡片回调请求格式无效');
  }
}

function decryptPayload(body: JsonObject, encryptKey: string): JsonObject {
  const encrypted = body.encrypt;
  if (
    typeof encrypted !== 'string' ||
    !encrypted ||
    encrypted.length % 4 !== 0 ||
    !BASE64_PATTERN.test(encrypted)
  ) {
    throw new BadRequestException('飞书卡片加密回调格式无效');
  }
  try {
    const bytes = Buffer.from(encrypted, 'base64');
    if (bytes.length <= 16 || (bytes.length - 16) % 16 !== 0) {
      throw new Error('invalid encrypted length');
    }
    const iv = bytes.subarray(0, 16);
    const ciphertext = bytes.subarray(16);
    const key = createHash('sha256').update(encryptKey).digest();
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return requireObject(JSON.parse(plaintext), '飞书卡片加密回调内容无效');
  } catch {
    throw new BadRequestException('飞书卡片加密回调内容无效');
  }
}

function assertSignature(input: {
  timestamp: string;
  nonce: string;
  signature: string;
  encryptKey: string;
  rawBody: string | Buffer;
}): void {
  const expected = createHash('sha256')
    .update(input.timestamp)
    .update(input.nonce)
    .update(input.encryptKey)
    .update(input.rawBody)
    .digest('hex');
  if (!constantTimeEqual(input.signature.toLowerCase(), expected)) {
    throw new UnauthorizedException('飞书卡片回调签名验证失败');
  }
}

function assertVerificationToken(
  payload: JsonObject,
  expectedToken: string,
): void {
  const header = isObject(payload.header) ? payload.header : undefined;
  const candidates = [payload.token, header?.token].filter(
    (value): value is string => typeof value === 'string',
  );
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => !constantTimeEqual(candidate, expectedToken))
  ) {
    throw new UnauthorizedException('飞书卡片回调验证令牌无效');
  }
}

function assertFreshTimestamp(timestamp: string, now: number): void {
  if (!/^\d{1,13}$/u.test(timestamp)) {
    throw new UnauthorizedException('飞书卡片回调时间戳无效');
  }
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(Math.floor(now / 1_000) - seconds) > MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new UnauthorizedException('飞书卡片回调已过期');
  }
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  const entries = Object.entries(headers || {}).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (entries.length === 0) return undefined;
  if (entries.length !== 1) {
    throw new UnauthorizedException('飞书卡片回调认证请求头无效');
  }
  const value = entries[0]?.[1];
  if (Array.isArray(value)) {
    if (value.length !== 1 || !value[0]) {
      throw new UnauthorizedException('飞书卡片回调认证请求头无效');
    }
    return value[0];
  }
  if (typeof value !== 'string' || !value) {
    throw new UnauthorizedException('飞书卡片回调认证请求头无效');
  }
  return value;
}

function protocolIdentifier(
  value: unknown,
  pattern: RegExp,
  message: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new BadRequestException(message);
  }
  return value;
}

function requireObject(value: unknown, message: string): JsonObject {
  if (!isObject(value)) throw new BadRequestException(message);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertConfig(config: OvertimeCardCallbackConfig): void {
  if (
    !config ||
    typeof config.verificationToken !== 'string' ||
    !config.verificationToken ||
    typeof config.encryptKey !== 'string'
  ) {
    throw new BadRequestException('飞书卡片回调安全配置无效');
  }
}

function resolveNow(value: Date | number): number {
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(result)) {
    throw new BadRequestException('飞书卡片回调解析时间无效');
  }
  return result;
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}
