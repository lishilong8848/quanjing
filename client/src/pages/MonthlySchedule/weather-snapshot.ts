import type { QWeatherWarning } from '../../api';

export const WEATHER_WARNING_REFRESH_MS = 10 * 60 * 1000;
export const WEATHER_CURRENT_AND_HOURLY_REFRESH_MS = 30 * 60 * 1000;

export type QWeatherWarningItem = QWeatherWarning['warning'][number];

export interface WeatherRefreshCallbacks {
  refreshSnapshot: () => void | Promise<void>;
  refreshCurrentAndHourly: () => void | Promise<void>;
}

const TERMINAL_STATUS_VALUES = new Set([
  '解除',
  '已解除',
  '失效',
  '已失效',
  '取消',
  '已取消',
  '撤销',
  '已撤销',
  '终止',
  '已终止',
  '结束',
  '已结束',
  '过期',
  '已过期',
  'cancelled',
  'canceled',
  'revoked',
  'terminated',
  'ended',
  'expired',
  'closed',
  'inactive',
]);

const ISO_WARNING_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u;

export function startWeatherRefreshSchedule(
  callbacks: WeatherRefreshCallbacks,
): () => void {
  void callbacks.refreshSnapshot();
  void callbacks.refreshCurrentAndHourly();

  const warningTimer = globalThis.setInterval(() => {
    void callbacks.refreshSnapshot();
  }, WEATHER_WARNING_REFRESH_MS);
  const weatherTimer = globalThis.setInterval(() => {
    void callbacks.refreshCurrentAndHourly();
  }, WEATHER_CURRENT_AND_HOURLY_REFRESH_MS);

  return () => {
    globalThis.clearInterval(warningTimer);
    globalThis.clearInterval(weatherTimer);
  };
}

export function isDisplayActiveWarning(
  warning: QWeatherWarningItem,
  nowMs: number,
): boolean {
  if (Object.prototype.toString.call(warning) !== '[object Object]') {
    return false;
  }

  const status = normalizeWarningStatus(warning?.status);
  if (TERMINAL_STATUS_VALUES.has(status)) return false;

  const endTime = normalizeText(warning?.endTime);
  if (!endTime) return true;

  const endTimeMs = parseWarningTime(endTime);
  return endTimeMs !== null && endTimeMs > nowMs;
}

export function shouldApplyWeatherResponse(input: {
  latestRequestId: number;
  responseRequestId: number;
}): boolean {
  return input.latestRequestId === input.responseRequestId;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWarningStatus(value: unknown): string {
  return normalizeText(value).replace(/\s+/gu, ' ').toLowerCase();
}

function parseWarningTime(value: string): number | null {
  if (!value) return null;

  if (/^[+-]?\d+(?:\.\d+)?$/u.test(value)) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return null;
    return Math.abs(numericValue) < 10_000_000_000
      ? numericValue * 1000
      : numericValue;
  }

  const match = ISO_WARNING_TIME_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  if (!isValidWarningDateTime(year, month, day, hour, minute, second)) {
    return null;
  }

  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isValidWarningDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDayOfMonth;
}
