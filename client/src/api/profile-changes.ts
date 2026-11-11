import { getCurrentCsrfToken } from './csrf-token';
import type {
  ProfileChange,
  ReviewProfileChange,
  CancelProfileChange,
  RecoverProfileChange,
} from '@shared/personnel-profile-change.interface';
export class ProfileChangeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export const isProfileChangeRejected = (error: unknown) =>
  error instanceof ProfileChangeRequestError &&
  [400, 403, 409, 413].includes(error.status);
const routes = new Set([
  'personal/profile-changes',
  'personal/profile-changes/cancel',
  'personal/profile-changes/photo',
  'configuration/profile-changes',
  'configuration/profile-changes/review',
  'configuration/profile-changes/recover',
  'configuration/profile-changes/photo',
]);
export function profileChangesUrl(path: string): string {
  if (!routes.has(path)) throw new Error('个人服务地址配置无效');
  const raw = String(process.env.CLIENT_BASE_PATH || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (raw) {
    try {
      if (
        raw.split('/').some((segment) => {
          const decoded = decodeURIComponent(segment);
          return (
            !decoded ||
            decoded === '.' ||
            decoded === '..' ||
            /[\\/?:#\u0000-\u0020]/.test(decoded)
          );
        })
      )
        throw new Error();
    } catch {
      throw new Error('个人服务地址配置无效');
    }
  }
  return `${raw ? '/' + raw : ''}/api/access/${path}`;
}
export async function profileChangeRequest<T>(
  path: string,
  body?:
    | FormData
    | ReviewProfileChange
    | CancelProfileChange
    | RecoverProfileChange,
  signal?: AbortSignal,
): Promise<T> {
  const url = profileChangesUrl(path),
    form = body instanceof FormData,
    csrf = body ? getCurrentCsrfToken() : '';
  const controller = new AbortController();
  if (signal?.aborted) throw new Error('读取已取消');
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    body && path === 'personal/profile-changes' ? 60000 : 15000,
  );
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf ? { 'X-Suda-Csrf-Token': csrf } : {}),
      },
      body: body
        ? form
          ? (body as FormData)
          : JSON.stringify(body)
        : undefined,
    });
    let value: any;
    try {
      value = await response.json();
    } catch {
      if (!response.ok)
        throw new ProfileChangeRequestError(
          response.status === 403
            ? '安全校验未通过，请刷新页面后重试原申请'
            : response.status === 401
              ? '登录已失效，请重新登录后核对原申请'
              : '服务未能处理请求，请保留原申请重试',
          response.status,
        );
      throw new Error('读取结果失败，请保留原申请重试');
    }
    if (!response.ok)
      throw new ProfileChangeRequestError(
        typeof value?.message === 'string'
          ? value.message
          : '处理未完成，请保留原申请重试',
        response.status,
      );
    return value;
  } catch (error) {
    if (timedOut)
      throw new Error(
        body ? '请求超时，结果待确认，请保留原申请重试' : '读取超时，请重试',
      );
    if (signal?.aborted) throw new Error('读取已取消');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
export const listProfileChanges = (admin = false, signal?: AbortSignal) =>
  profileChangeRequest<ProfileChange[]>(
    (admin ? 'configuration' : 'personal') + '/profile-changes',
    undefined,
    signal,
  );
export const submitProfileChange = (body: FormData) =>
  profileChangeRequest<ProfileChange>('personal/profile-changes', body);
export const reviewProfileChange = (body: ReviewProfileChange) =>
  profileChangeRequest<ProfileChange>(
    'configuration/profile-changes/review',
    body,
  );

export const cancelProfileChange = (body: CancelProfileChange) =>
  profileChangeRequest<ProfileChange>('personal/profile-changes/cancel', body);
export const recoverProfileChange = (body: RecoverProfileChange) =>
  profileChangeRequest<ProfileChange>(
    'configuration/profile-changes/recover',
    body,
  );
