export type TyphoonPathConfirmationMode =
  | 'warning-send'
  | 'already-sent'
  | 'force-send';

export interface TyphoonPathPreviewLike {
  hasActiveWarning: boolean;
  canSend: boolean;
}

export interface TyphoonPathSubmissionGate {
  tryStart: () => boolean;
  finish: () => void;
}

export interface TyphoonPathMutationStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface PendingTyphoonPathRequest {
  clientMutationId: string;
  expectedWarningKey?: string;
  force?: boolean;
  confirmation?: 'FORCE_SEND_TYPHOON_PATH';
}

const PENDING_TYPHOON_PATH_MUTATION_KEY =
  'nantong:typhoon-path:pending-mutation-id';
const VALID_MUTATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function createTyphoonPathSubmissionGate():
TyphoonPathSubmissionGate {
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

export function getTyphoonPathConfirmationMode(
  preview: TyphoonPathPreviewLike,
): TyphoonPathConfirmationMode {
  if (!preview.hasActiveWarning) return 'force-send';
  return preview.canSend ? 'warning-send' : 'already-sent';
}

export function isTyphoonPathSendResultUncertain(error: unknown): boolean {
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
    uncertainCodes.has(code)
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('network')
    || message.includes('failed to fetch')
    || message.includes('fetch failed')
    || message.includes('socket hang up')
    || message.includes('connection reset')
    || message.includes('connection closed')
    || message.includes('disconnected')
    || message.includes('aborted')
    || message.includes('canceled')
    || message.includes('cancelled')
  );
}

export function readPendingTyphoonPathMutationId(
  storage?: TyphoonPathMutationStorage,
): string {
  return readPendingTyphoonPathRequest(storage)?.clientMutationId || '';
}

export function readPendingTyphoonPathRequest(
  storage?: TyphoonPathMutationStorage,
): PendingTyphoonPathRequest | null {
  const target = resolveMutationStorage(storage);
  if (!target) return null;
  try {
    const value = `${target.getItem(PENDING_TYPHOON_PATH_MUTATION_KEY) || ''}`
      .trim();
    if (!value) return null;
    if (VALID_MUTATION_ID.test(value)) {
      return { clientMutationId: value };
    }
    const parsed = JSON.parse(value) as Partial<PendingTyphoonPathRequest>;
    const clientMutationId = `${parsed.clientMutationId || ''}`.trim();
    if (!VALID_MUTATION_ID.test(clientMutationId)) return null;
    const expectedWarningKey = `${parsed.expectedWarningKey || ''}`.trim();
    const force = parsed.force === true;
    return {
      clientMutationId,
      ...(expectedWarningKey ? { expectedWarningKey } : {}),
      ...(force
        ? {
            force: true,
            confirmation: 'FORCE_SEND_TYPHOON_PATH' as const,
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export function savePendingTyphoonPathMutationId(
  mutationId: string,
  storage?: TyphoonPathMutationStorage,
): void {
  savePendingTyphoonPathRequest(
    { clientMutationId: mutationId },
    storage,
  );
}

export function savePendingTyphoonPathRequest(
  request: PendingTyphoonPathRequest,
  storage?: TyphoonPathMutationStorage,
): void {
  const clientMutationId = `${request.clientMutationId || ''}`.trim();
  if (!VALID_MUTATION_ID.test(clientMutationId)) {
    throw new Error('台风路径发送操作号格式无效');
  }
  const target = resolveMutationStorage(storage);
  if (!target) return;
  try {
    target.setItem(
      PENDING_TYPHOON_PATH_MUTATION_KEY,
      JSON.stringify({
        clientMutationId,
        ...(request.expectedWarningKey?.trim()
          ? { expectedWarningKey: request.expectedWarningKey.trim() }
          : {}),
        ...(request.force === true
          ? {
              force: true,
              confirmation: 'FORCE_SEND_TYPHOON_PATH',
            }
          : {}),
      }),
    );
  } catch {
    // 浏览器禁用本地存储时仍由当前页面内存中的操作号保证本次重试幂等。
  }
}

export function clearPendingTyphoonPathMutationId(
  storage?: TyphoonPathMutationStorage,
): void {
  const target = resolveMutationStorage(storage);
  if (!target) return;
  try {
    target.removeItem(PENDING_TYPHOON_PATH_MUTATION_KEY);
  } catch {
    // 浏览器禁用本地存储时无需额外处理。
  }
}

function resolveMutationStorage(
  storage?: TyphoonPathMutationStorage,
): TyphoonPathMutationStorage | undefined {
  if (storage) return storage;
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
