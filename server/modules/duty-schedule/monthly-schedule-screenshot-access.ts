import * as crypto from 'crypto';
import { readEnv } from '@server/common/config/external-services.config';

const SCREENSHOT_ACCESS_TOKEN_VERSION = 'v2';
const SCREENSHOT_ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
const SCREENSHOT_ACCESS_TOKEN_CLOCK_SKEW_MS = 30 * 1000;
const DEVELOPMENT_EPHEMERAL_SCREENSHOT_ACCESS_SECRET = crypto
  .randomBytes(32)
  .toString('base64url');

export const MONTHLY_SCHEDULE_SCREENSHOT_AUDIENCE =
  'monthly-schedule' as const;
export const CAMPUS_OPERATIONS_SCREENSHOT_AUDIENCE =
  'campus-operations' as const;

export type ScreenshotAccessAudience =
  | typeof MONTHLY_SCHEDULE_SCREENSHOT_AUDIENCE
  | typeof CAMPUS_OPERATIONS_SCREENSHOT_AUDIENCE;
export type ScreenshotAccessShift = 'white' | 'night';

export interface ScreenshotAccessVerificationRequest {
  audience?: ScreenshotAccessAudience | null;
  screenshotDate?: string | null;
  screenshotShift?: ScreenshotAccessShift | null;
  token?: string | null;
}

function getMonthlyScheduleScreenshotAccessSecret(): string {
  const configuredSecret =
    readEnv('MONTHLY_SCHEDULE_SCREENSHOT_ACCESS_SECRET', [
      'DUTY_SCREENSHOT_ACCESS_SECRET',
    ]) ||
    readEnv('FEISHU_APP_SECRET') ||
    readEnv('APP_SECRET');
  if (configuredSecret) return configuredSecret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '未配置截图访问签名密钥，请设置 MONTHLY_SCHEDULE_SCREENSHOT_ACCESS_SECRET 或 FEISHU_APP_SECRET',
    );
  }
  return DEVELOPMENT_EPHEMERAL_SCREENSHOT_ACCESS_SECRET;
}

function signMonthlyScheduleScreenshotAccess(
  audience: ScreenshotAccessAudience,
  screenshotDate: string,
  screenshotShift: ScreenshotAccessShift | '',
  expiresAt: number,
): string {
  return crypto
    .createHmac('sha256', getMonthlyScheduleScreenshotAccessSecret())
    .update(`${audience}:${screenshotDate}:${screenshotShift}:${expiresAt}`)
    .digest('base64url');
}

function safeEqualText(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function isScreenshotAccessExpiryValid(
  expiresAt: number,
  now: number,
): boolean {
  return (
    Number.isFinite(expiresAt) &&
    expiresAt + SCREENSHOT_ACCESS_TOKEN_CLOCK_SKEW_MS >= now &&
    expiresAt <=
      now +
        SCREENSHOT_ACCESS_TOKEN_TTL_MS +
        SCREENSHOT_ACCESS_TOKEN_CLOCK_SKEW_MS
  );
}

function verifyScreenshotAccessSignature(
  signature: string,
  audience: ScreenshotAccessAudience,
  screenshotDate: string,
  screenshotShift: ScreenshotAccessShift | '',
  expiresAt: number,
): boolean {
  try {
    return safeEqualText(
      signature,
      signMonthlyScheduleScreenshotAccess(
        audience,
        screenshotDate,
        screenshotShift,
        expiresAt,
      ),
    );
  } catch {
    return false;
  }
}

export function createMonthlyScheduleScreenshotAccessToken(
  screenshotDate: string,
  now = Date.now(),
): string {
  const expiresAt = now + SCREENSHOT_ACCESS_TOKEN_TTL_MS;
  const signature = signMonthlyScheduleScreenshotAccess(
    MONTHLY_SCHEDULE_SCREENSHOT_AUDIENCE,
    screenshotDate,
    '',
    expiresAt,
  );
  return `${SCREENSHOT_ACCESS_TOKEN_VERSION}.${expiresAt}.${signature}`;
}

export function createCampusOperationsScreenshotAccessToken(
  screenshotDate: string,
  screenshotShift: ScreenshotAccessShift,
  now = Date.now(),
): string {
  const expiresAt = now + SCREENSHOT_ACCESS_TOKEN_TTL_MS;
  const signature = signMonthlyScheduleScreenshotAccess(
    CAMPUS_OPERATIONS_SCREENSHOT_AUDIENCE,
    screenshotDate,
    screenshotShift,
    expiresAt,
  );
  return `${SCREENSHOT_ACCESS_TOKEN_VERSION}.${expiresAt}.${signature}`;
}

export function verifyMonthlyScheduleScreenshotAccessToken(
  screenshotDate: string,
  token: string,
  now = Date.now(),
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(screenshotDate)) return false;

  const tokenParts = String(token || '').split('.');
  if (tokenParts.length !== 3) return false;
  const [version, expiresAtText, signature] = tokenParts;
  if (version !== SCREENSHOT_ACCESS_TOKEN_VERSION || !signature) {
    return false;
  }

  const expiresAt = Number(expiresAtText);
  if (!isScreenshotAccessExpiryValid(expiresAt, now)) return false;

  return verifyScreenshotAccessSignature(
    signature,
    MONTHLY_SCHEDULE_SCREENSHOT_AUDIENCE,
    screenshotDate,
    '',
    expiresAt,
  );
}

export function verifyCampusOperationsScreenshotAccessToken(
  screenshotDate: string,
  screenshotShift: ScreenshotAccessShift,
  token: string,
  now = Date.now(),
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(screenshotDate)) return false;
  if (screenshotShift !== 'white' && screenshotShift !== 'night') {
    return false;
  }

  const tokenParts = String(token || '').split('.');
  if (tokenParts.length !== 3) return false;
  const [version, expiresAtText, signature] = tokenParts;
  if (version !== SCREENSHOT_ACCESS_TOKEN_VERSION || !signature) {
    return false;
  }

  const expiresAt = Number(expiresAtText);
  if (!isScreenshotAccessExpiryValid(expiresAt, now)) return false;

  return verifyScreenshotAccessSignature(
    signature,
    CAMPUS_OPERATIONS_SCREENSHOT_AUDIENCE,
    screenshotDate,
    screenshotShift,
    expiresAt,
  );
}

export function verifyScreenshotAccessRequest(
  request: ScreenshotAccessVerificationRequest = {},
  now = Date.now(),
): boolean {
  const screenshotDate = String(request.screenshotDate || '').trim();
  const token = String(request.token || '').trim();

  if (request.audience === MONTHLY_SCHEDULE_SCREENSHOT_AUDIENCE) {
    return verifyMonthlyScheduleScreenshotAccessToken(
      screenshotDate,
      token,
      now,
    );
  }

  if (request.audience === CAMPUS_OPERATIONS_SCREENSHOT_AUDIENCE) {
    const screenshotShift = request.screenshotShift;
    if (screenshotShift !== 'white' && screenshotShift !== 'night') {
      return false;
    }
    return verifyCampusOperationsScreenshotAccessToken(
      screenshotDate,
      screenshotShift,
      token,
      now,
    );
  }

  return false;
}
