import type { AccessPrincipal } from './access-control.interface';

export type SelfServiceApplicant =
  | { mode: 'login'; message: string }
  | { mode: 'error'; message: string }
  | { mode: 'manual' }
  | { mode: 'automatic'; name: string };

export function isPersonalAccessAccount(principal: AccessPrincipal | undefined): boolean {
  return /^(?:feishu-|local-external-)/.test(principal?.accountId || '');
}

export function resolveSelfServiceApplicant(
  principal: AccessPrincipal | undefined,
  authenticated: boolean,
  action = '提交申请',
): SelfServiceApplicant {
  if (!principal || (principal.role === 'guest' && !authenticated)) {
    return { mode: 'login', message: `请先登录后${action}` };
  }
  if ((principal.role === 'guest' || principal.role === 'site_member') && !isPersonalAccessAccount(principal)) {
    return { mode: 'error', message: '登录账号未匹配到人员，请联系管理员核对' };
  }
  if (!isPersonalAccessAccount(principal)) return { mode: 'manual' };
  const name = principal.displayName?.trim();
  return name
    ? { mode: 'automatic', name }
    : { mode: 'error', message: '登录姓名缺失，请重新登录后申请' };
}
