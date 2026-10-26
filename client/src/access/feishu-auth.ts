import type { AccessSessionResponse } from '@shared/access-control.interface';
import { PAGE_ACCESS_ROLES } from '@shared/page-access';
import { hasAuthenticatedAccessIdentity, normalizeAccessSession } from './access-policy';
import type { SessionCommitCoordinator } from './session-commit-coordinator';

export const FEISHU_AUTH_QUERY_KEY = 'feishu_auth';

export type FeishuSessionConfirmation =
  | { status: 'confirmed'; token: number; session: AccessSessionResponse }
  | { status: 'unconfirmed' | 'request_error'; token: number; message: string }
  | { status: 'superseded' };

export function getIdentityRequestError(error: unknown): string {
  const failure = error as {
    code?: string;
    response?: { status?: number; data?: { message?: string | string[] } };
  } | null;
  if (failure?.code === 'ECONNABORTED' || failure?.code === 'ETIMEDOUT')
    return '身份确认超时，请检查网络后重试。';
  if (failure?.code === 'ERR_NETWORK')
    return '暂时无法连接身份服务，请检查网络后重试。';
  const status = failure?.response?.status;
  const message = failure?.response?.data?.message;
  const detail = Array.isArray(message) ? message.filter(value => typeof value === 'string').join('；') : typeof message === 'string' ? message.trim() : '';
  if (status === 401) return '登录会话已失效，请重新登录。';
  if (status === 403) return detail || '身份服务拒绝了确认请求，请重新登录或联系管理员。';
  if (status && status >= 500) return detail ? `身份服务暂不可用：${detail}` : '身份服务暂不可用，请稍后重试。';
  return detail || (error instanceof Error && error.message ? error.message : '登录身份确认失败，请重试。');
}

export function createFeishuSessionConfirmation(
  readSession: () => Promise<AccessSessionResponse & { sessionCookieStatus?: string }>,
  coordinator: SessionCommitCoordinator,
) {
  const consumedCallbacks = new Set<string>();
  let pending: { token: number; promise: Promise<FeishuSessionConfirmation> } | null = null;
  return {
    hasConsumedCallback: (location: string) => consumedCallbacks.has(location),
    consumeCallback(location: string): boolean {
      if (consumedCallbacks.has(location)) return false;
      consumedCallbacks.add(location);
      return true;
    },
    isPending: () => Boolean(pending && coordinator.canCommit(pending.token)),
    run(waitFor?: Promise<void> | null): Promise<FeishuSessionConfirmation> {
      if (pending && coordinator.canCommit(pending.token)) return pending.promise;
      const token = coordinator.beginMutation();
      const promise = (async (): Promise<FeishuSessionConfirmation> => {
        try {
          // A restored WebView can still have a pre-authorization read in flight.
          await waitFor;
          if (!coordinator.canCommit(token)) return { status: 'superseded' };
          let session = await readSession();
          for (const delay of [250, 750]) {
            if (!coordinator.canCommit(token)) return { status: 'superseded' };
            if (session?.role !== 'guest' || session.principalFingerprint || session.expiresAt !== null ||
              (session.sessionCookieStatus && session.sessionCookieStatus !== 'absent')) break;
            await new Promise(resolve => setTimeout(resolve, delay));
            if (!coordinator.canCommit(token)) return { status: 'superseded' };
            session = await readSession();
          }
          const committed = coordinator.commitMutation(token);
          if (committed === null) return { status: 'superseded' };
          if (!session || !(PAGE_ACCESS_ROLES as readonly string[]).includes(session.role) ||
            typeof session.principalFingerprint !== 'string' || !session.principalFingerprint ||
            !Number.isFinite(session.expiresAt) || !hasAuthenticatedAccessIdentity(session)) {
            const messages: Record<string, string> = {
              absent: '当前页面没有收到登录会话。请重新确认身份，仍失败时重新登录。',
              duplicate: '浏览器存在重复的登录会话。请清除本站登录状态后重新登录。',
              malformed: '登录会话格式异常，请重新登录。',
              rejected: '登录会话未通过服务器校验，请重新登录。',
              disabled: '身份服务未启用登录会话，请联系管理员核对访问设置。',
            };
            return { status: 'unconfirmed', token: committed, message: messages[session?.sessionCookieStatus || ''] || '飞书已返回，但当前页面未取得有效登录会话。请重新确认身份，仍失败时重新登录。' };
          }
          if (session.expiresAt! <= Date.now()) {
            return { status: 'unconfirmed', token: committed, message: '登录会话已过期，请重新登录。' };
          }
          return { status: 'confirmed', token: committed, session: normalizeAccessSession(session) };
        } catch (error) {
          const committed = coordinator.commitMutation(token);
          return committed === null ? { status: 'superseded' } : { status: 'request_error', token: committed, message: getIdentityRequestError(error) };
        }
      })().finally(() => {
        if (pending?.promise === promise) pending = null;
      });
      pending = { token, promise };
      return promise;
    },
  };
}

export function createFeishuLoginNavigation({
  navigate,
  setPending,
  onError,
  canNavigate = () => true,
}: {
  navigate: (url: string) => void;
  setPending: (pending: boolean) => void;
  onError: (message: string) => void;
  canNavigate?: () => boolean;
}) {
  let pending = false;
  let navigationTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    clearTimeout(navigationTimer);
    clearTimeout(timeoutTimer);
    pending = false;
    setPending(false);
  };
  return {
    reset,
    start(url: string): boolean {
      if (pending || !canNavigate()) return false;
      pending = true;
      setPending(true);
      timeoutTimer = setTimeout(() => {
        reset();
        onError('飞书登录页面未打开，请重试');
      }, 10_000);
      navigationTimer = setTimeout(() => {
        if (!canNavigate()) { reset(); return; }
        try {
          navigate(url);
        } catch {
          reset();
          onError('飞书登录跳转失败，请重试');
        }
      }, 0);
      return true;
    },
  };
}

export type FeishuAuthFeedback = {
  kind: 'success' | 'info' | 'error';
  message: string;
};

const FEISHU_AUTH_FEEDBACK = {
  success: {
    kind: 'success',
    message: '飞书授权成功。',
  },
  configuration_error: {
    kind: 'error',
    message: '飞书授权未配置，请联系管理员。',
  },
  unavailable: {
    kind: 'error',
    message: '飞书授权服务暂不可用，请稍后重试。',
  },
  state_invalid: {
    kind: 'error',
    message: '飞书授权校验失败，请重新授权。',
  },
  cancelled: {
    kind: 'info',
    message: '已取消飞书授权。',
  },
  code_invalid: {
    kind: 'error',
    message: '飞书授权凭证无效，请重新授权。',
  },
  rejected: {
    kind: 'error',
    message: '飞书授权请求被拒绝，请重试。',
  },
  invalid_response: {
    kind: 'error',
    message: '飞书授权响应异常，请重试。',
  },
  identity_not_allowed: {
    kind: 'error',
    message: '当前飞书账号未配置系统权限。',
  },
  identity_inactive: {
    kind: 'error',
    message: '当前账号暂不可登录，请联系管理员核对人员状态。',
  },
} as const satisfies Record<string, FeishuAuthFeedback>;

export function buildFeishuAuthorizationUrl(
  pathname: string,
  search: string,
  hash: string,
): string {
  const basePath = normalizeClientBasePath(process.env.CLIENT_BASE_PATH);
  const returnTo = `${pathname}${search}${hash}`;
  return `${basePath}/api/access/feishu/authorize?returnTo=${encodeURIComponent(returnTo)}`;
}

export function getFeishuAuthFeedback(
  status: string | null,
): FeishuAuthFeedback | null {
  if (
    !status ||
    !Object.prototype.hasOwnProperty.call(FEISHU_AUTH_FEEDBACK, status)
  ) {
    return null;
  }
  return FEISHU_AUTH_FEEDBACK[status as keyof typeof FEISHU_AUTH_FEEDBACK];
}

export function removeFeishuAuthStatus(search: string): string {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  params.delete(FEISHU_AUTH_QUERY_KEY);
  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}

function normalizeClientBasePath(value: unknown): string {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  if (
    trimmed.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(trimmed) ||
    /[?#\\\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return '';
  }

  const encodedSegments = trimmed.split('/').filter(Boolean);
  if (encodedSegments.length === 0) return '';

  const decodedSegments: string[] = [];
  for (const encodedSegment of encodedSegments) {
    const decodedSegment = decodeBasePathSegment(encodedSegment);
    if (decodedSegment === null) return '';
    decodedSegments.push(decodedSegment);
  }
  return `/${decodedSegments.join('/')}`;
}

function decodeBasePathSegment(encodedSegment: string): string | null {
  let decodedSegment = encodedSegment;
  for (let depth = 0; depth < 2 && decodedSegment.includes('%'); depth += 1) {
    try {
      decodedSegment = decodeURIComponent(decodedSegment);
    } catch {
      return null;
    }
  }

  if (
    !decodedSegment ||
    decodedSegment.includes('%') ||
    decodedSegment === '.' ||
    decodedSegment === '..' ||
    /[/?#\\\u0000-\u001f\u007f]/.test(decodedSegment)
  ) {
    return null;
  }
  return decodedSegment;
}
