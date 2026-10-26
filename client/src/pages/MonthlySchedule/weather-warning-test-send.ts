export interface WeatherWarningTestSubmissionGate {
  tryStart: () => boolean;
  finish: () => void;
}

export interface WeatherWarningTestMutationStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface PendingWeatherWarningTestRequest {
  clientMutationId: string;
}

const PENDING_WEATHER_WARNING_TEST_REQUEST_KEY =
  'nantong:weather-warning:test:pending-request';
const VALID_MUTATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

let inMemoryPendingRequest: PendingWeatherWarningTestRequest | null = null;
let completedStorageMutationId = '';

export function createWeatherWarningTestSubmissionGate(): WeatherWarningTestSubmissionGate {
  let active = false;
  return {
    tryStart: () => {
      if (active) return false;
      active = true;
      return true;
    },
    finish: () => {
      active = false;
    },
  };
}

export function createWeatherWarningTestClientMutationId(): string {
  const randomId = getRandomId();
  return `weather-warning-${randomId}`;
}

export function getOrCreateWeatherWarningTestRequest(
  storage?: WeatherWarningTestMutationStorage,
): PendingWeatherWarningTestRequest {
  const pendingRequest = readPendingWeatherWarningTestRequest(storage);
  if (pendingRequest) return pendingRequest;

  const request = {
    clientMutationId: createWeatherWarningTestClientMutationId(),
  };
  savePendingWeatherWarningTestRequest(request, storage);
  return request;
}

export function readPendingWeatherWarningTestRequest(
  storage?: WeatherWarningTestMutationStorage,
): PendingWeatherWarningTestRequest | null {
  const target = resolveMutationStorage(storage);
  if (target) {
    try {
      const value =
        `${target.getItem(PENDING_WEATHER_WARNING_TEST_REQUEST_KEY) || ''}`.trim();
      const request = parsePendingRequest(value);
      if (request && request.clientMutationId !== completedStorageMutationId) {
        inMemoryPendingRequest = request;
        return request;
      }
    } catch {
      // Storage can be disabled by the browser; preserve this page's pending id.
    }
  }

  return inMemoryPendingRequest ? { ...inMemoryPendingRequest } : null;
}

export function savePendingWeatherWarningTestRequest(
  request: PendingWeatherWarningTestRequest,
  storage?: WeatherWarningTestMutationStorage,
): void {
  const normalizedRequest = normalizePendingRequest(request);
  if (!normalizedRequest) {
    throw new Error('天气预警测试发送操作号格式无效');
  }

  inMemoryPendingRequest = normalizedRequest;
  const target = resolveMutationStorage(storage);
  if (!target) return;

  try {
    target.setItem(
      PENDING_WEATHER_WARNING_TEST_REQUEST_KEY,
      JSON.stringify(normalizedRequest),
    );
  } catch {
    // Storage can be disabled by the browser; the page-memory fallback remains.
  }
}

export function clearPendingWeatherWarningTestRequest(
  storage?: WeatherWarningTestMutationStorage,
): void {
  const completedRequest = readPendingWeatherWarningTestRequest(storage);
  inMemoryPendingRequest = null;
  const target = resolveMutationStorage(storage);
  if (!target) return;

  try {
    target.removeItem(PENDING_WEATHER_WARNING_TEST_REQUEST_KEY);
    completedStorageMutationId = '';
  } catch {
    completedStorageMutationId = completedRequest?.clientMutationId || '';
  }
}

export function isWeatherWarningTestResultUncertain(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    response?: {
      status?: unknown;
    };
  };
  const status = Number(candidate.response?.status);
  if (Number.isFinite(status)) {
    if (status === 408 || status === 504 || status >= 500) return true;
    if (status >= 400) return false;
  }

  const code = `${candidate.code || ''}`.toUpperCase();
  const message = `${candidate.message || ''}`.toLowerCase();
  const uncertainCodes = new Set([
    'ECONNABORTED',
    'ETIMEDOUT',
    'ERR_NETWORK',
    'ERR_CANCELED',
    'ECONNRESET',
    'EPIPE',
  ]);
  return (
    uncertainCodes.has(code) ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('connection reset') ||
    message.includes('connection closed') ||
    message.includes('disconnected') ||
    message.includes('aborted') ||
    message.includes('canceled') ||
    message.includes('cancelled')
  );
}

function getRandomId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function parsePendingRequest(
  value: string,
): PendingWeatherWarningTestRequest | null {
  if (!value) return null;
  try {
    return normalizePendingRequest(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizePendingRequest(
  value: unknown,
): PendingWeatherWarningTestRequest | null {
  if (!value || typeof value !== 'object') return null;
  const clientMutationId = `${
    (value as { clientMutationId?: unknown }).clientMutationId || ''
  }`.trim();
  return VALID_MUTATION_ID.test(clientMutationId) ? { clientMutationId } : null;
}

function resolveMutationStorage(
  storage?: WeatherWarningTestMutationStorage,
): WeatherWarningTestMutationStorage | undefined {
  if (storage) return storage;
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
