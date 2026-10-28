import { LockKeyhole, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { hasBusinessPermissionSomewhere } from '@shared/business-permissions';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { isPurchaseApplicationDirectPath } from '@/navigation/purchase-application-route';
import { useAccess } from './AccessProvider';
import {
  canAccessPage,
  getPostLoginPath,
  hasAuthenticatedAccessIdentity,
  isControlledScreenshotPageRequest,
} from './access-policy';

const CREATE_ONLY_APPLICATIONS = [
  { path: '/monthly-schedule/apply/leave', module: 'leave_requests' },
  { path: '/monthly-schedule/apply/overtime', module: 'overtime_requests' },
  { path: '/purchase-inventory-management/apply/new', module: 'purchase' },
] as const;

function canAccessCreateOnlyPage(access: AccessPrincipal, pathname: string): boolean {
  const entry = CREATE_ONLY_APPLICATIONS.find(item => item.path === pathname.toLowerCase().replace(/\/+$/, ''));
  return !!access.effectiveAuthorization && !!entry &&
    hasBusinessPermissionSomewhere(access, { module: entry.module, action: 'create' });
}

export default function RouteAccessGuard() {
  const location = useLocation();
  const access = useAccess();
  const { role, pagePaths, isLoading, isConfirmingIdentity, dismissedLoginPath, sessionError, retrySession, requestLogin } = access;
  const authenticated = hasAuthenticatedAccessIdentity(access);
  const lastAutomaticLoginRequestRef = React.useRef('');
  const controlledScreenshotRequest = isControlledScreenshotPageRequest(
    location.pathname,
    location.search,
  );
  const guestAllowed = canAccessPage('guest', location.pathname);
  const createOnlyAllowed = canAccessCreateOnlyPage(access, location.pathname);
  const allowed =
    controlledScreenshotRequest || createOnlyAllowed || canAccessPage(role, location.pathname, pagePaths);
  const preferredLanding = getPostLoginPath(role, '/nantong-base', pagePaths);
  const landingPath = !allowed && authenticated
    ? canAccessPage(role, preferredLanding, pagePaths)
      ? preferredLanding
      : CREATE_ONLY_APPLICATIONS.find(entry => canAccessCreateOnlyPage(access, entry.path))?.path
    : undefined;
  const reason = getRouteAccessReason(role, location.pathname);
  const preferredAccountType = isPurchaseApplicationDirectPath(
    location.pathname,
  )
    ? 'purchase_applicant'
    : undefined;
  const automaticLoginRequestKey = `${location.pathname}\n${reason}\n${preferredAccountType || ''}`;

  React.useEffect(() => {
    if (access.impersonation || isConfirmingIdentity || sessionError || authenticated || dismissedLoginPath === location.pathname) return;
    if (allowed) {
      lastAutomaticLoginRequestRef.current = '';
      return;
    }
    if (
      isLoading ||
      lastAutomaticLoginRequestRef.current === automaticLoginRequestKey
    ) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      lastAutomaticLoginRequestRef.current = automaticLoginRequestKey;
      requestLogin(reason, location.pathname, preferredAccountType, undefined, true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [
    allowed,
    authenticated,
    access.impersonation,
    automaticLoginRequestKey,
    isLoading,
    isConfirmingIdentity,
    dismissedLoginPath,
    sessionError,
    location.pathname,
    preferredAccountType,
    reason,
    requestLogin,
  ]);

  if (isConfirmingIdentity || (isLoading && !sessionError &&
    (role === 'guest' && !guestAllowed || authenticated && !allowed))) {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-slate-50 px-4"
        aria-busy="true"
      >
        <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm text-slate-600 shadow-sm">
          正在确认登录身份…
        </div>
      </main>
    );
  }

  if (sessionError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
        <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900">暂时无法确认登录身份</h1>
          <p className="mt-3 break-words text-sm leading-6 text-slate-600" role="alert">{sessionError}</p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Button type="button" disabled={isLoading} aria-busy={isLoading} onClick={() => void retrySession()}>
              {isLoading ? '正在确认…' : '重新确认身份'}
            </Button>
            <Button type="button" variant="outline" disabled={isLoading} onClick={() => requestLogin('请重新登录以确认身份。', location.pathname, preferredAccountType)}>
              重新登录
            </Button>
          </div>
        </section>
      </main>
    );
  }

  if (allowed) return <Outlet key={JSON.stringify(pagePaths)} />;

  if (authenticated && !isLoading && landingPath && landingPath !== location.pathname) {
    return <Navigate to={landingPath} replace />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <LockKeyhole className="size-6" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-xl font-semibold text-slate-900">
          {authenticated ? '当前账号暂无可访问页面' : '当前页面需要登录权限'}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">{authenticated ? '请联系管理员调整页面权限，或切换有权限的账号。' : reason}</p>
        <Button
          type="button"
          className="mt-5"
          onClick={() =>
            requestLogin(reason, location.pathname, preferredAccountType)
          }
        >
          <ShieldCheck className="size-4" aria-hidden="true" />
          {authenticated ? '切换账号' : '登录权限'}
        </Button>
      </section>
    </main>
  );
}

function getRouteAccessReason(role: string, pathname: string): string {
  if (pathname.replace(/\/+$/, '') === '/system-configuration') return '配置页面仅管理员可访问，请切换管理员身份。';
  if (isPurchaseApplicationDirectPath(pathname)) {
    return '请使用采购申请人身份，选择所属楼栋并输入访问密码。';
  }
  return role === 'guest' ? '当前页面不对游客开放，请登录后访问。' : '当前角色未开放此页面，请联系管理员配置页面权限。';

}
