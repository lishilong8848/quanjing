import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AccessSessionResponse } from '@shared/access-control.interface';
import { getAccessSession } from '@/api';
import { hasAuthenticatedAccessIdentity } from './access-policy';

export interface ImpersonationRequest {
  action: 'start' | 'stop';
  actorAccountId: string;
  accountId?: string;
  clientMutationId: string;
}

export type ImpersonationFailure = Error & { currentSession?: AccessSessionResponse; outcomeUnknown?: boolean };

function matches(request: ImpersonationRequest, session: AccessSessionResponse): boolean {
  if (!hasAuthenticatedAccessIdentity(session) || !session.principalFingerprint || session.expiresAt === null || session.expiresAt <= Date.now()) return false;
  return request.action === 'start'
    ? session.accountId === request.accountId && session.impersonation?.actorAccountId === request.actorAccountId
    : session.role === 'admin' && session.accountId === request.actorAccountId && !session.impersonation;
}

function failureMessage(error: unknown): string {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' && message.trim() ? message : '身份切换未完成，请确认后重试';
}

export async function requestImpersonation(request: ImpersonationRequest): Promise<AccessSessionResponse> {
  {
    let current: AccessSessionResponse;
    try { current = await getAccessSession(); }
    catch { throw Object.assign(new Error('身份切换结果尚未确认，请重新确认身份后重试'), { outcomeUnknown: true }); }
    if (matches(request, current)) return current;
    const expected = request.action === 'start'
      ? matches({ ...request, action: 'stop' }, current)
      : current.impersonation?.actorAccountId === request.actorAccountId;
    if (!expected) throw Object.assign(new Error('当前登录身份已变化，请刷新后重新操作'), { currentSession: current });
  }
  let mutationFailure: unknown;
  try {
    await axiosForBackend({ url: `/api/access/impersonation/${request.action}`, method: 'POST', timeout: 15_000,
      data: { ...(request.action === 'start' ? { accountId: request.accountId } : {}), clientMutationId: request.clientMutationId } });
  } catch (error) { mutationFailure = error; }
  let confirmed: AccessSessionResponse;
  try { confirmed = await getAccessSession(); }
  catch { throw Object.assign(new Error('身份切换结果尚未确认，请重新确认身份后重试'), { outcomeUnknown: true }); }
  if (matches(request, confirmed)) return confirmed;
  throw Object.assign(new Error(mutationFailure ? failureMessage(mutationFailure) : '身份切换未确认，请重试'), { currentSession: confirmed });
}

export function reloadImpersonationPage(session: AccessSessionResponse, ending: boolean): void {
  const base = (process.env.CLIENT_BASE_PATH || '').replace(/\/+$/, '');
  const target = ending && session.role === 'admin' ? '/system-configuration' : '/nantong-base';
  // A full reload prevents one account's business caches from following another identity.
  window.location.replace(`${base}${target}`);
}
