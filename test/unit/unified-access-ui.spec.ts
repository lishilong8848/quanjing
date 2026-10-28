import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(path: string): string {
  const absolutePath = resolve(path);
  expect(existsSync(absolutePath)).toBe(true);
  return readFileSync(absolutePath, 'utf8');
}

describe('unified access frontend integration', () => {
  it('provides one server-backed access session without browser storage', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const apiSource = readSource('client/src/api/index.ts');

    expect(providerSource).toContain('getAccessSession');
    expect(providerSource).toContain('loginAccess');
    expect(providerSource).toContain('logoutAccess');
    expect(providerSource).toContain('UNIFIED_ACCESS_INVALIDATED_EVENT');
    expect(providerSource).toContain('sessionMutationQueue');
    expect(providerSource).toContain('createSessionCommitCoordinator');
    expect(providerSource).toContain('sessionCommitCoordinator');
    expect(providerSource).not.toContain('sessionMutationVersion');
    expect(providerSource).toContain('enqueueSessionMutation(() =>');
    expect(providerSource).toContain('enqueueSessionMutation(logoutAccess)');
    expect(providerSource).not.toContain(
      'enqueueSessionMutation(getAccessSession)',
    );
    expect(providerSource).not.toContain(
      'enqueueSessionOperation(getAccessSession)',
    );
    expect(providerSource).not.toMatch(/localStorage|sessionStorage/);
    expect(apiSource).toContain("url: '/api/access/session'");
    expect(apiSource).toContain("fetch(buildAccessApiUrl('/api/access/login')");
    expect(apiSource).toContain("credentials: 'same-origin'");
    expect(apiSource).toContain("url: '/api/access/logout'");
  });

  it('confirms the server session before a protected direct login unlocks its route', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');

    const loginStart = providerSource.indexOf(
      'const login = React.useCallback(',
    );
    const logoutStart = providerSource.indexOf(
      'const logout = React.useCallback(',
      loginStart,
    );
    const loginSource = providerSource.slice(loginStart, logoutStart);

    expect(loginStart).toBeGreaterThan(-1);
    expect(logoutStart).toBeGreaterThan(loginStart);
    expect(loginSource).toContain(
      'const confirmedSession = await getAccessSession();',
    );
    expect(loginSource).toContain(
      'isConfirmedLoginSession(nextSession, confirmedSession)',
    );
    expect(loginSource.indexOf('const confirmedSession')).toBeLessThan(
      loginSource.indexOf('sessionCommitCoordinator.commitMutation('),
    );
  });

  it('guards every business route including pages outside Layout', () => {
    const appSource = readSource('client/src/app.tsx');
    const shellSource = readSource('client/src/components/GlobalAppShell.tsx');
    const guardSource = readSource('client/src/access/RouteAccessGuard.tsx');

    expect(appSource).toContain('<Route element={<RouteAccessGuard />}>');
    expect(appSource).toContain('<Route element={<GlobalAppShell />}>');
    expect(
      appSource.indexOf('<Route element={<RouteAccessGuard />}>'),
    ).toBeLessThan(appSource.indexOf('<Route element={<GlobalAppShell />}>'));
    expect(
      appSource.indexOf('<Route element={<GlobalAppShell />}>'),
    ).toBeLessThan(appSource.indexOf('<Route element={<Layout />}>'));
    expect(guardSource).toContain('canAccessPage(role, location.pathname, pagePaths)');
    expect(guardSource).toContain('requestLogin');
    expect(guardSource).toContain('window.setTimeout');
    expect(guardSource).toContain('window.clearTimeout');
    expect(guardSource).not.toContain('contract_admin');
    expect(guardSource).toContain('<Outlet key={JSON.stringify(pagePaths)} />');
    expect(appSource).toContain('function StandaloneAccessLayout()');
    expect(shellSource.match(/<GlobalNavigation \/>/g)).toHaveLength(1);
    expect(shellSource).toContain('<Outlet />');
    expect(shellSource).toContain("normalizedPath === '/calendar-embed'");
    expect(shellSource).toContain('isControlledScreenshotPageRequest(');
    expect(appSource).toContain('function RouteContentBoundary()');
    expect(appSource).toContain('function RouteContentErrorFallback(');
    expect(appSource).toContain(
      'FallbackComponent={RouteContentErrorFallback}',
    );
    expect(appSource).toContain('当前页面暂时不可用');
    expect(appSource).toContain('页面数据或组件加载异常，请稍后重试。');
    expect(appSource).toContain(
      'resetKeys={[location.pathname, location.search, location.hash]}',
    );
    const guardedRouteStart = appSource.indexOf(
      '<Route element={<RouteAccessGuard />}>',
    );
    const guardedShellStart = appSource.indexOf(
      '<Route element={<GlobalAppShell />}>',
      guardedRouteStart,
    );
    expect(guardedShellStart).toBeLessThan(
      appSource.indexOf(
        '<Route element={<RouteContentBoundary />}>',
        guardedShellStart,
      ),
    );
    expect(appSource).toContain('getNavigationBrowserTitle(location.pathname)');
    expect(appSource).not.toContain('ROUTE_BROWSER_TITLES');
  });

  it('keeps an authenticated route mounted during a background session refresh', () => {
    const guardSource = readSource('client/src/access/RouteAccessGuard.tsx');

    expect(guardSource).toContain(
      "const guestAllowed = canAccessPage('guest', location.pathname);",
    );
    expect(guardSource).toContain(
      "isLoading && !sessionError && role === 'guest' && !guestAllowed",
    );
    expect(guardSource).not.toContain('if (isLoading) {');
  });

  it('does not remount the same automatic login dialog after session refreshes', () => {
    const guardSource = readSource('client/src/access/RouteAccessGuard.tsx');

    expect(guardSource).toContain('lastAutomaticLoginRequestRef');
    expect(guardSource).toContain('automaticLoginRequestKey');
    expect(guardSource).toContain(
      'lastAutomaticLoginRequestRef.current === automaticLoginRequestKey',
    );
    expect(guardSource).toContain("lastAutomaticLoginRequestRef.current = '';");
  });

  it('coalesces repeated authorization failures while reauthentication is pending', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const invalidationStart = providerSource.indexOf(
      'const handleInvalidated = () => {',
    );
    const invalidationEnd = providerSource.indexOf(
      'window.addEventListener(',
      invalidationStart,
    );
    const invalidationSource = providerSource.slice(
      invalidationStart,
      invalidationEnd,
    );

    expect(invalidationStart).toBeGreaterThan(-1);
    expect(invalidationEnd).toBeGreaterThan(invalidationStart);
    expect(invalidationSource).toContain(
      'if (reauthenticationPendingRef.current) return;',
    );
    expect(
      invalidationSource.indexOf('if (reauthenticationPendingRef.current)'),
    ).toBeLessThan(invalidationSource.indexOf('void refreshSession();'));
  });

  it('preserves the last confirmed session when a refresh fails', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const refreshStart = providerSource.indexOf(
      'const refreshSession = React.useCallback(',
    );
    const requestLoginStart = providerSource.indexOf(
      'const confirmFeishuSession = React.useCallback(',
    );
    const refreshSource = providerSource.slice(refreshStart, requestLoginStart);

    expect(refreshSource).toContain(
      'setSessionError(getIdentityRequestError(error))',
    );
    expect(refreshSource).not.toContain('setSession(GUEST_SESSION)');
    expect(refreshSource).not.toContain('pagePaths: []');
  });

  it('describes denied routes using configurable page permissions', () => {
    const guardSource = readSource('client/src/access/RouteAccessGuard.tsx');

    expect(guardSource).toContain(
      '当前角色未开放此页面，请联系管理员配置页面权限。',
    );
    expect(guardSource).toContain(
      '当前页面不对游客开放，请登录后访问。',
    );
    expect(guardSource).toContain(
      '配置页面仅管理员可访问，请切换管理员身份。',
    );
    expect(guardSource).not.toContain(
      "role === 'purchase_admin' || role === 'purchase_applicant'",
    );
  });

  it('filters navigation by role and exposes a single shared account menu', () => {
    const layoutSource = readSource('client/src/components/Layout.tsx');
    const navigationSource = readSource(
      'client/src/components/GlobalNavigation.tsx',
    );
    const indexSource = readSource('client/src/app-entry.tsx');
    expect(readSource('client/src/index.tsx')).toContain("import('./app-entry')");

    expect(indexSource).toContain('<AccessProvider>');
    expect(layoutSource).toContain('useAccess');
    expect(navigationSource).toContain('useAccess');
    expect(navigationSource).toContain('getAccessibleNavigationDomains');
    expect(layoutSource).toContain(
      "import { switchAccessToGuest } from '@/access/identity-switch';",
    );
    expect(layoutSource).toContain('await switchAccessToGuest({');
    expect(layoutSource).not.toContain('UnifiedAccessControl');
    expect(layoutSource).toContain('const location = useLocation();');
    expect(layoutSource).toContain('const navigate = useNavigate();');
    expect(layoutSource).toContain('打开账户菜单');
    expect(layoutSource).not.toContain('accountTypes.map((accountType) =>');
    expect(layoutSource).toContain('切换账号');
    expect(layoutSource).toContain('退出当前账号');
    expect(layoutSource).toContain('hasAuthenticatedAccessIdentity');
    expect(layoutSource).toContain(
      "requestLogin('请选择登录方式。', location.pathname)",
    );
    expect(layoutSource).toContain(
      'getAccessRoleLabel(role, purchaseBuilding, buildings)',
    );
    expect(layoutSource).not.toContain('请输入管理员密码以提升权限。');
    expect(layoutSource).not.toContain('二级编辑权限');
    expect(layoutSource).not.toContain(
      "const MONTHLY_SCHEDULE_ACCESS_STATE_EVENT = 'monthly-schedule-access-state'",
    );
    expect(readSource('client/src/api/index.ts')).not.toContain(
      'loginContractAdmin',
    );
  });

  it('uses one role-filtered global navigation without duplicate page switchers', () => {
    const layoutSource = readSource('client/src/components/Layout.tsx');
    const appSource = readSource('client/src/app.tsx');
    const headerSource = readSource(
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    );
    const navigationSource = readSource(
      'client/src/components/GlobalNavigation.tsx',
    );

    expect(layoutSource).not.toContain('<PageSwitcher');
    expect(layoutSource).not.toContain('<DesktopUtilityNav');
    expect(layoutSource).not.toContain('<MobileBottomNav');
    expect(layoutSource).not.toContain('function DesktopUtilityNav');
    expect(layoutSource).not.toContain('function MobileBottomNav');
    expect(layoutSource).not.toContain("title: '人员修正'");
    expect(appSource.match(/<GlobalAppShell \/>/g)).toHaveLength(1);
    expect(appSource).not.toContain('<PageSwitcher');
    expect(appSource).toContain(
      '<Route index element={<Navigate to="/nantong-base" replace />} />',
    );
    expect(headerSource).not.toContain('<PageSwitcher');
    expect(headerSource).not.toContain('<UnifiedAccessControl');
    expect(navigationSource).toContain('getAccessibleNavigationDomains');
    expect(navigationSource).toContain('<GlobalUserControl');
    expect(navigationSource).toContain('全部应用');
    expect(navigationSource).toContain(
      "aria-current={active ? 'page' : undefined}",
    );
    expect(navigationSource).toContain('mobileApplicationsContentRef');
    expect(navigationSource).toContain("scrollIntoView({ block: 'start' })");
    expect(navigationSource).toContain('activeDomainKey === firstDomainKey');
    expect(navigationSource).toContain(
      "data-active-navigation-domain={activeDomain ? 'true' : undefined}",
    );
    expect(navigationSource.match(/aria-current=/g)).toHaveLength(2);
    expect(navigationSource).not.toContain('duty-staff-repair');
    expect(navigationSource).toContain('data-global-navigation="true"');
    expect(layoutSource).not.toContain('min-h-screen');
    expect(layoutSource).toContain(
      'min-h-[calc(100dvh-var(--global-navigation-height))]',
    );
    expect(layoutSource).toContain('个人主页');
  });

  it('does not offer an unconfigured contract administrator login identity', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const routeGuardSource = readSource(
      'client/src/access/RouteAccessGuard.tsx',
    );

    expect(providerSource).not.toContain("'contract_admin',");
    expect(providerSource).not.toContain('<select');
    expect(routeGuardSource).not.toContain('contract_admin');
  });

  it('recognizes building administrators without a role selector in the login card', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const policySource = readSource('client/src/access/access-policy.ts');

    expect(providerSource.slice(providerSource.indexOf('function AccessLoginDialog('))).not.toContain('登录身份');
    expect(policySource).toContain("'inventory_admin',");
    expect(policySource).toContain("role === 'inventory_admin'");
    expect(policySource).toContain("role === 'building_admin'");
  });

  it('accepts a password-only login while retaining the request race guard', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');

    expect(providerSource).toContain(
      'preferredAccountType?: AccessLoginAccountType',
    );
    expect(providerSource).toContain('void onSubmit({ password,');
    expect(providerSource).toContain('password,');
    expect(providerSource).not.toContain('accountTypes.map((accountType) =>');
    expect(providerSource).toContain(
      'const activeLoginRequestKey = React.useRef(0);',
    );
    expect(providerSource).toContain(
      'const requestKey = activeLoginRequestKey.current + 1;',
    );
    expect(providerSource).toContain(
      'activeLoginRequestKey.current = requestKey;',
    );
    expect(providerSource).toContain('const navigate = useNavigate();');
    expect(providerSource).toContain('getPostLoginPath(');
    expect(providerSource).toContain('navigate(targetPath, { replace: true })');
    expect(providerSource).not.toContain(
      '!canAccessPage(nextSession.role, dialog.requiredPath)',
    );
    expect(providerSource).toContain('resetKey={dialog.requestKey}');
    expect(providerSource).toContain('[open, resetKey]');
  });

  it('keeps a newer login dialog intact when an older login request settles', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const loginStart = providerSource.indexOf(
      'const login = React.useCallback(',
    );
    const loginEnd = providerSource.indexOf(
      'const logout = React.useCallback(',
      loginStart,
    );
    const loginSource = providerSource.slice(loginStart, loginEnd);
    const staleResultGuard =
      'activeLoginRequestKey.current !== submittedRequestKey';
    const mutationCommitPattern =
      /sessionCommitCoordinator\.commitMutation\(\s*submittedMutationToken,?\s*\)/;
    const mutationCommitIndex = loginSource.search(mutationCommitPattern);

    expect(loginSource).toContain(
      'const submittedRequestKey = dialog.requestKey;',
    );
    expect(loginSource).toContain(staleResultGuard);
    expect(mutationCommitIndex).toBeGreaterThan(-1);
    expect(loginSource.indexOf(staleResultGuard)).toBeLessThan(
      mutationCommitIndex,
    );
    expect(mutationCommitIndex).toBeLessThan(
      loginSource.indexOf('flushSync(() => {'),
    );
    expect(loginSource).toContain('current.requestKey === submittedRequestKey');
    expect(providerSource).toMatch(
      /\[\s*dialog\.requestKey,\s*clearBackgroundSessionWarning,\s*dialog\.requiredPath,\s*enqueueSessionMutation,\s*location\.pathname,\s*navigate,\s*rememberReauthenticationLogin,\s*sessionCommitCoordinator,?\s*\]/,
    );
    expect(providerSource).toContain('void onSubmit({ password,');
    expect(providerSource).not.toContain('void onSubmit(request).then');
  });

  it('commits a successful login session atomically with closing its dialog', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const loginStart = providerSource.indexOf(
      'const login = React.useCallback(',
    );
    const loginEnd = providerSource.indexOf(
      'const logout = React.useCallback(',
      loginStart,
    );
    const loginSource = providerSource.slice(loginStart, loginEnd);
    const flushIndex = loginSource.indexOf('flushSync(() => {');
    const paintIndex = loginSource.indexOf('await waitForBrowserPaint();');
    const synchronousCommit = loginSource.slice(flushIndex, paintIndex);

    expect(providerSource).toContain("import { flushSync } from 'react-dom';");
    expect(loginStart).toBeGreaterThan(-1);
    expect(loginEnd).toBeGreaterThan(loginStart);
    expect(flushIndex).toBeGreaterThan(-1);
    expect(paintIndex).toBeGreaterThan(flushIndex);
    expect(synchronousCommit).toContain('setSession((current) =>');
    expect(synchronousCommit).toContain(
      'normalizeAccessSession(confirmedSession)',
    );
    expect(synchronousCommit).toContain('setSessionError((current) =>');
    expect(synchronousCommit).toContain('setDialog((current) =>');
    expect(loginSource).not.toContain('React.startTransition(() => {');
  });

  it('does not commit or navigate with a stale login result', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const loginStart = providerSource.indexOf(
      'const login = React.useCallback(',
    );
    const loginEnd = providerSource.indexOf(
      'const logout = React.useCallback(',
      loginStart,
    );
    const loginSource = providerSource.slice(loginStart, loginEnd);
    const flushIndex = loginSource.indexOf('flushSync(() => {');
    const paintIndex = loginSource.indexOf('await waitForBrowserPaint();');
    const navigateIndex = loginSource.indexOf(
      'navigate(targetPath, { replace: true })',
    );

    expect(flushIndex).toBeGreaterThan(-1);
    expect(paintIndex).toBeGreaterThan(-1);
    expect(navigateIndex).toBeGreaterThan(paintIndex);
    expect(loginSource.slice(0, flushIndex)).toMatch(
      /if\s*\(\s*!sessionCommitCoordinator\.canCommit\(submittedMutationToken\)/,
    );
    expect(loginSource.slice(paintIndex, navigateIndex)).toMatch(
      /if\s*\(\s*!sessionCommitCoordinator\.canCommit\(committedMutationToken\)/,
    );
    expect(loginSource.slice(flushIndex, paintIndex)).toContain(
      'setSession((current) =>',
    );
    expect(loginSource.slice(flushIndex, paintIndex)).toContain(
      'sessionCommitCoordinator.canCommit(committedMutationToken)',
    );
    expect(loginSource.slice(flushIndex, paintIndex)).toContain(
      'setSessionError((current) =>',
    );
  });

  it('invalidates refreshes both before and during committed login and logout mutations', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const refreshStart = providerSource.indexOf(
      'const refreshSession = React.useCallback(',
    );
    const loginStart = providerSource.indexOf(
      'const login = React.useCallback(',
    );
    const logoutStart = providerSource.indexOf(
      'const logout = React.useCallback(',
    );
    const valueStart = providerSource.indexOf(
      'const value = React.useMemo<AccessContextValue>',
    );
    const refreshSource = providerSource.slice(refreshStart, loginStart);
    const loginSource = providerSource.slice(loginStart, logoutStart);
    const logoutSource = providerSource.slice(logoutStart, valueStart);

    expect(refreshSource).toContain(
      'const refreshToken = sessionCommitCoordinator.captureRefresh();',
    );
    expect(refreshSource).toMatch(
      /if \(!sessionCommitCoordinator\.canCommit\(refreshToken\)\) return;/,
    );
    for (const mutationSource of [loginSource, logoutSource]) {
      expect(mutationSource).toContain(
        'const submittedMutationToken = sessionCommitCoordinator.beginMutation();',
      );
      expect(mutationSource).toMatch(
        /sessionCommitCoordinator\.commitMutation\(\s*submittedMutationToken,?\s*\)/,
      );
      expect(mutationSource).toContain(
        'sessionCommitCoordinator.canCommit(committedMutationToken)',
      );
    }
  });

  it('keeps the submitted login draft stable throughout the close animation', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const dialogStart = providerSource.indexOf('function AccessLoginDialog(');
    const dialogEnd = providerSource.indexOf(
      'function waitForBrowserPaint()',
      dialogStart,
    );
    const dialogSource = providerSource.slice(dialogStart, dialogEnd);
    const resetEffect = dialogSource.match(
      /React\.useEffect\(\(\) => \{[\s\S]*?\}, \[open, resetKey\]\);/,
    )?.[0];

    expect(dialogStart).toBeGreaterThan(-1);
    expect(dialogEnd).toBeGreaterThan(dialogStart);
    expect(resetEffect).toBeDefined();
    expect(resetEffect).toContain('if (!open) return;');
    expect(resetEffect).toContain("setPassword('');");
    expect(providerSource).toContain('key={dialog.requestKey}');
    expect(dialogSource).toContain("React.useState('')");
    expect(dialogSource).toContain('if (!open) return null;');
  });

  it('invalidates the shared session after protected API authorization errors', () => {
    const eventSource = readSource('client/src/access/access-events.ts');
    const constructionFetchSource = readSource(
      'client/src/api/construction-fetch.ts',
    );

    expect(eventSource).toContain(
      'isAuthorizationFailure(accessResponse.status)',
    );
    expect(eventSource).toContain(
      'isAuthorizationFailure(error.response?.status)',
    );
    expect(eventSource).toContain('interceptors.response.use');
    expect(constructionFetchSource).toContain('dispatchAccessInvalidated');
    expect(constructionFetchSource).toContain(
      'response.status === 401 || response.status === 403',
    );
  });

  it('keeps guest-readable pages passive when a background request invalidates access', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const invalidationStart = providerSource.indexOf(
      'const handleInvalidated = () => {',
    );
    const invalidationEnd = providerSource.indexOf(
      'window.addEventListener(',
      invalidationStart,
    );
    const invalidationSource = providerSource.slice(
      invalidationStart,
      invalidationEnd,
    );

    expect(invalidationStart).toBeGreaterThan(-1);
    expect(invalidationEnd).toBeGreaterThan(invalidationStart);
    expect(invalidationSource).toContain('markReauthenticationPending();');
    expect(invalidationSource).toContain('void refreshSession();');
    expect(invalidationSource).not.toContain('requestLogin');
    expect(invalidationSource).not.toContain('setDialog');
    expect(providerSource).not.toContain('shouldRequestLoginAfterInvalidation');
    expect(providerSource).not.toContain('requestReauthentication');
  });

  it('leaves automatic login prompting for restricted pages to RouteAccessGuard', () => {
    const guardSource = readSource('client/src/access/RouteAccessGuard.tsx');

    expect(guardSource).toContain(
      'const allowed =\n    controlledScreenshotRequest || createOnlyAllowed || canAccessPage(role, location.pathname, pagePaths);',
    );
    expect(guardSource).toContain('const createOnlyAllowed = !!access.effectiveAuthorization && (');
    expect(guardSource).toContain('if (allowed) {');
    expect(guardSource).toContain('isLoading ||');
    expect(guardSource).toContain(
      'lastAutomaticLoginRequestRef.current === automaticLoginRequestKey',
    );
    expect(guardSource).toContain(
      'requestLogin(reason, location.pathname, preferredAccountType, undefined, true);',
    );
  });

  it('downgrades an expired authenticated session to guest without opening a dialog', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const expirationStart = providerSource.indexOf(
      'if (dialog.open || !session.expiresAt)',
    );
    const expirationEnd = providerSource.indexOf(
      'const login = React.useCallback(',
      expirationStart,
    );
    const expirationSource = providerSource.slice(
      expirationStart,
      expirationEnd,
    );

    expect(expirationStart).toBeGreaterThan(-1);
    expect(expirationEnd).toBeGreaterThan(expirationStart);
    expect(expirationSource).toContain('markSessionExpired();');
    expect(expirationSource).toContain('window.setTimeout');
    expect(expirationSource).not.toContain('requestLogin');
    expect(expirationSource).not.toContain('setDialog');
  });

  it('keeps an explicit requestLogin action opening the shared login dialog', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const requestStart = providerSource.indexOf(
      'const requestLogin = React.useCallback(',
    );
    const requestEnd = providerSource.indexOf(
      'const markSessionExpired = React.useCallback(',
      requestStart,
    );
    const requestSource = providerSource.slice(requestStart, requestEnd);

    expect(requestStart).toBeGreaterThan(-1);
    expect(requestEnd).toBeGreaterThan(requestStart);
    expect(requestSource).toContain('setDialog({');
    expect(requestSource).toContain('open: true');
  });

  it('keeps the account menu tied to the unified identity rather than the platform profile', () => {
    const layoutSource = readSource('client/src/components/Layout.tsx');
    const userControlStart = layoutSource.indexOf(
      'export function GlobalUserControl()',
    );
    const userControlEnd = layoutSource.indexOf(
      'function Layout2Desktop()',
      userControlStart,
    );
    const userControlSource = layoutSource.slice(
      userControlStart,
      userControlEnd,
    );

    expect(userControlStart).toBeGreaterThan(-1);
    expect(userControlEnd).toBeGreaterThan(userControlStart);
    expect(userControlSource).toContain('const location = useLocation();');
    expect(userControlSource).toContain(
      'getAccessRoleLabel(role, purchaseBuilding, buildings)',
    );
    expect(userControlSource).toContain('{identityLabel}');
    expect(userControlSource).not.toContain("{name || '游客'}");
    expect(userControlSource).toContain('hasAuthenticatedAccessIdentity');
    expect(userControlSource).toContain('isConfirmingIdentity');
    expect(userControlSource).toContain('isChangingIdentity');
    expect(readSource('client/src/access/AccessProvider.tsx')).toContain(
      'hasAuthenticatedAccessIdentity(normalizeAccessSession(nextSession))',
    );
  });

  it('uses accessible modal primitives and semantic controls on mobile', () => {
    const layoutSource = readSource('client/src/components/Layout.tsx');
    const navigationSource = readSource(
      'client/src/components/GlobalNavigation.tsx',
    );

    expect(layoutSource).toContain('export function GlobalUserControl()');
    expect(layoutSource).toContain('aria-label="打开账户菜单"');
    expect(layoutSource).toContain('<AlertDialog');
    expect(layoutSource).toContain('<DropdownMenuTrigger asChild>');
    expect(navigationSource).toContain('<Sheet');
    expect(navigationSource).toContain('<SheetTrigger asChild');
    expect(navigationSource).toContain('<SheetContent');
    expect(navigationSource).toContain('<SheetTitle');
    expect(navigationSource).toContain('<SheetDescription');
    expect(navigationSource).toContain('aria-label="打开全部应用"');
    expect(navigationSource).toContain('搜索应用入口');
    expect(layoutSource).not.toMatch(/<DropdownMenuTrigger asChild>\s*<div/);
  });

  it('keeps supply headers page-scoped and the shared access control in the global navigation', () => {
    const layoutSource = readSource('client/src/components/Layout.tsx');
    const appSource = readSource('client/src/app.tsx');
    const navigationSource = readSource(
      'client/src/components/GlobalNavigation.tsx',
    );
    const headerSource = readSource(
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    );
    expect(headerSource).not.toContain('PageSwitcher');
    expect(headerSource).not.toContain('UnifiedAccessControl');
    expect(layoutSource).not.toContain('hasEmbeddedAccessControl');
    expect(appSource).not.toContain('fixed top-4 right-4');
    expect(appSource).not.toContain('fixed bottom-4 left-4');
    expect(navigationSource.match(/<GlobalUserControl/g)).toHaveLength(1);
    expect(navigationSource).toContain(
      'hidden min-w-0 flex-1 items-center justify-center gap-0.5 xl:flex',
    );
    expect(navigationSource).toContain('xl:hidden');
  });

  it('builds a same-origin Feishu authorization URL and removes only its callback query', () => {
    const { buildFeishuAuthorizationUrl, removeFeishuAuthStatus } =
      require('../../client/src/access/feishu-auth') as {
        buildFeishuAuthorizationUrl: (
          pathname: string,
          search: string,
          hash: string,
        ) => string;
        removeFeishuAuthStatus: (search: string) => string;
      };
    const previousBasePath = process.env.CLIENT_BASE_PATH;

    try {
      for (const rootBasePath of [undefined, '', '/']) {
        if (rootBasePath === undefined) {
          delete process.env.CLIENT_BASE_PATH;
        } else {
          process.env.CLIENT_BASE_PATH = rootBasePath;
        }
        expect(
          buildFeishuAuthorizationUrl(
            '/monthly-schedule',
            '?view=week&name=%E9%A9%AC%E8%BF%9B%E5%AE%87',
            '#today',
          ),
        ).toBe(
          `/api/access/feishu/authorize?returnTo=${encodeURIComponent(
            '/monthly-schedule?view=week&name=%E9%A9%AC%E8%BF%9B%E5%AE%87#today',
          )}`,
        );
      }

      process.env.CLIENT_BASE_PATH = '/nantong/';
      expect(
        buildFeishuAuthorizationUrl('/monthly-schedule', '?view=week', ''),
      ).toBe(
        `/nantong/api/access/feishu/authorize?returnTo=${encodeURIComponent(
          '/monthly-schedule?view=week',
        )}`,
      );

      for (const [encodedBasePath, expectedPrefix] of [
        ['/nan%74ong/', '/nantong'],
        ['/nan%2574ong/', '/nantong'],
      ] as const) {
        process.env.CLIENT_BASE_PATH = encodedBasePath;
        expect(
          buildFeishuAuthorizationUrl('/monthly-schedule', '', ''),
        ).toMatch(
          new RegExp(`^${expectedPrefix}/api/access/feishu/authorize\\?`),
        );
      }

      for (const unsafeBasePath of [
        '//evil.example/nantong',
        'https://evil.example/nantong',
        '/./nantong',
        '/safe/../nantong',
        '/%2e%2e/nantong',
        '/%252e%252e/nantong',
        '/nantong%2Fadmin',
        '/nantong%252Fadmin',
        '/nantong%5Cadmin',
        '/nantong%255Cadmin',
        '/nantong\u0000',
        '/nantong%00',
        '/nantong%2500',
        '/nantong%',
        '/nantong%GG',
        '/nan%252574ong',
      ]) {
        process.env.CLIENT_BASE_PATH = unsafeBasePath;
        const authorizationUrl = buildFeishuAuthorizationUrl(
          '/monthly-schedule',
          '',
          '',
        );
        expect(authorizationUrl).toMatch(/^\/api\/access\/feishu\/authorize\?/);
        expect(authorizationUrl).not.toContain('evil.example');
      }
    } finally {
      if (previousBasePath === undefined) {
        delete process.env.CLIENT_BASE_PATH;
      } else {
        process.env.CLIENT_BASE_PATH = previousBasePath;
      }
    }

    expect(
      removeFeishuAuthStatus(
        '?view=week&feishu_auth=success&name=%E9%A9%AC%E8%BF%9B%E5%AE%87',
      ),
    ).toBe('?view=week&name=%E9%A9%AC%E8%BF%9B%E5%AE%87');
    expect(
      removeFeishuAuthStatus(
        '?feishu_auth=success&view=week&feishu_auth=stale',
      ),
    ).toBe('?view=week');
    expect(removeFeishuAuthStatus('?feishu_auth=success')).toBe('');
  });

  it('maps only the fixed backend Feishu callback statuses to trusted Chinese feedback', () => {
    const { getFeishuAuthFeedback } =
      require('../../client/src/access/feishu-auth') as {
        getFeishuAuthFeedback: (
          status: string | null,
        ) => { kind: 'success' | 'info' | 'error'; message: string } | null;
      };
    const expectedFeedback = {
      success: ['success', '飞书授权成功。'],
      configuration_error: ['error', '飞书授权未配置，请联系管理员。'],
      unavailable: ['error', '飞书授权服务暂不可用，请稍后重试。'],
      state_invalid: ['error', '飞书授权校验失败，请重新授权。'],
      cancelled: ['info', '已取消飞书授权。'],
      code_invalid: ['error', '飞书授权凭证无效，请重新授权。'],
      rejected: ['error', '飞书授权请求被拒绝，请重试。'],
      invalid_response: ['error', '飞书授权响应异常，请重试。'],
      identity_not_allowed: ['error', '当前飞书账号未配置系统权限。'],
    } as const;

    for (const [status, [kind, message]] of Object.entries(expectedFeedback)) {
      expect(getFeishuAuthFeedback(status)).toEqual({ kind, message });
    }
    expect(getFeishuAuthFeedback('server-secret')).toBeNull();
    expect(getFeishuAuthFeedback(null)).toBeNull();
  });

  it('keeps Feishu authorization inside the shared login dialog without a second header entry', () => {
    const layoutSource = readSource('client/src/components/Layout.tsx');
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    expect(layoutSource).not.toContain('useFeishuLogin');
    expect(layoutSource).not.toContain('<FeishuIcon');
    expect(providerSource).toContain('useFeishuLogin');
    expect(providerSource).toContain('<FeishuIcon');
  });

  it('confirms callback identity above route guards and consumes it once', () => {
    const providerSource = readSource('client/src/access/AccessProvider.tsx');
    const guardSource = readSource('client/src/access/RouteAccessGuard.tsx');
    const layoutSource = readSource('client/src/components/Layout.tsx');
    expect(layoutSource).not.toContain('confirmFeishuSession');
    expect(layoutSource).not.toContain('FEISHU_AUTH_QUERY_KEY');
    expect(providerSource).toContain('feishuConfirmation.consumeCallback(callbackLocation)');
    expect(providerSource).toContain('`${location.key}:${location.pathname}${location.search}${location.hash}`');
    expect(providerSource).toContain('isConfirmingIdentity: isConfirmingIdentity || callbackPending');
    expect(providerSource).toContain('search: removeFeishuAuthStatus(location.search)');
    expect(providerSource).toContain('pathname: location.pathname');
    expect(providerSource).toContain('hash: location.hash');
    expect(providerSource).toContain('{ replace: true }');
    expect(providerSource).toContain("result.status === 'confirmed' && sessionCommitCoordinator.canCommit(result.token)");
    expect(providerSource).toContain("window.addEventListener('pageshow', handlePageShow)");
    expect(providerSource).toContain('if (requiresFeishuIdentityRef.current) void retrySession();');
    expect(providerSource).toContain('else void refreshSession(true);');
    expect(guardSource.indexOf('if (isConfirmingIdentity || (')).toBeLessThan(guardSource.indexOf('if (allowed) return <Outlet'));
    expect(guardSource).toContain('if (isConfirmingIdentity || sessionError || authenticated || dismissedLoginPath === location.pathname) return;');
    const errorStart = guardSource.indexOf('if (sessionError) {');
    expect(errorStart).toBeGreaterThan(-1);
    expect(errorStart).toBeLessThan(guardSource.indexOf('if (allowed) return <Outlet'));
    expect(guardSource.slice(errorStart, guardSource.indexOf('if (allowed) return <Outlet'))).toContain('重新确认身份');
    expect(guardSource.slice(errorStart, guardSource.indexOf('if (allowed) return <Outlet'))).not.toContain('当前角色未开放');
  });
  it('declares the single-dialog login fix in the compiled runtime hotfix', () => {
    const packageSource = readSource(
      'scripts/create-construction-instant-submit-auto-review-hotfix-package.ps1',
    );
    const readmeSource = readSource(
      'deploy/README_CONSTRUCTION_INSTANT_SUBMIT_AUTO_REVIEW.md',
    );

    expect(packageSource).toContain("'unified-access-login-single-dialog'");
    expect(packageSource).toContain(
      "'unified-access-session-commit-before-route-guard'",
    );
    expect(readmeSource).toContain('统一权限登录成功后只显示一次授权窗口');
    expect(readmeSource).toContain('一次登录请求');
  });
});
