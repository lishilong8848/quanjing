import type { ReactElement, ReactNode } from 'react';
import type { AccessSessionResponse } from '../../shared/access-control.interface';

let mockLocation = { pathname: '/purchase-inventory-management', search: '', hash: '' };
let mockAccess: AccessSessionResponse & Record<string, any>;
const mockEffects: (() => void | (() => void))[] = [];
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (callback: () => void | (() => void)) => { mockEffects.push(callback); },
}));
jest.mock('react-router-dom', () => ({
  useLocation: () => mockLocation, Outlet: 'outlet', Navigate: 'navigate',
}));
jest.mock('../../client/src/access/AccessProvider', () => ({ useAccess: () => mockAccess }));
jest.mock('@/components/ui/button', () => ({ Button: 'button' }), { virtual: true });
jest.mock('@/navigation/purchase-application-route', () => jest.requireActual('../../client/src/navigation/purchase-application-route'), { virtual: true });
jest.mock('lucide-react', () => ({ LockKeyhole: 'i', ShieldCheck: 'i' }));

import { isValidElement } from 'react';
import RouteAccessGuard from '../../client/src/access/RouteAccessGuard';
import { getPostLoginPath } from '../../client/src/access/access-policy';

function nodes(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return isValidElement<any>(node) ? text(node.props.children) : '';
}
function render() { mockEffects.length = 0; return RouteAccessGuard(); }
function redirect(tree = render()) { return nodes(tree).find(node => node.type === 'navigate'); }
function outlet(tree = render()) { return nodes(tree).find(node => node.type === 'outlet'); }

describe('authenticated page access landing', () => {
  beforeEach(() => {
    mockLocation = { pathname: '/purchase-inventory-management', search: '', hash: '' };
    mockAccess = { role: 'inventory_admin', purchaseBuilding: 'H楼', expiresAt: Date.now() + 60_000,
      principalFingerprint: 'synthetic-person', pagePaths: ['/nantong-base', '/inventory-management'],
      capabilities: { canEdit: true, canDelete: false, canForceRefresh: true, canAccessContracts: false },
      isLoading: false, isConfirmingIdentity: false, dismissedLoginPath: null, sessionError: null,
      retrySession: jest.fn(), requestLogin: jest.fn(),
    };
  });

  it('replaces a forbidden route with the permitted home and exposes the granted page shell', () => {
    const navigation = redirect();
    expect(navigation?.props).toMatchObject({ to: '/nantong-base', replace: true });
    expect(outlet()).toBeUndefined();
    mockLocation.pathname = navigation!.props.to;
    expect(outlet()).toBeDefined();
    expect(redirect()).toBeUndefined();
    expect(mockAccess.requestLogin).not.toHaveBeenCalled();
  });
  it('uses the same home-first fallback after a confirmed password login', () => {
    expect(getPostLoginPath('inventory_admin', '/purchase-inventory-management', ['/nantong-base', '/inventory-management'])).toBe('/nantong-base');
    expect(getPostLoginPath('inventory_admin', '/purchase-inventory-management', ['/inventory-management'])).toBe('/inventory-management');
    expect(getPostLoginPath('inventory_admin', '/inventory-management', ['/nantong-base', '/inventory-management'])).toBe('/inventory-management');
  });
  it('uses an actually granted page when home itself is not permitted', () => {
    mockAccess.pagePaths = ['/inventory-management'];
    expect(redirect()?.props.to).toBe('/inventory-management');
    mockLocation.pathname = '/inventory-management';
    expect(outlet()).toBeDefined();
  });
  it('also handles a confirmed Feishu identity whose technical role is guest', () => {
    mockAccess.role = 'guest';
    expect(redirect()?.props.to).toBe('/nantong-base');
  });
  it('does not interrupt a permitted current deep link, query, or fragment', () => {
    mockAccess.pagePaths = ['/meeting-management'];
    mockLocation = { pathname: '/meeting-management/nantong-weekly', search: '?month=2026-10', hash: '#records' };
    expect(outlet()).toBeDefined();
    expect(redirect()).toBeUndefined();
    expect(mockLocation).toEqual({ pathname: '/meeting-management/nantong-weekly', search: '?month=2026-10', hash: '#records' });
    mockAccess.isLoading = true;
    expect(outlet()).toBeDefined();
  });
  it('redirects a revoked page using the newest permissions without reopening login', () => {
    mockLocation.pathname = '/inventory-management';
    expect(outlet()).toBeDefined();
    mockAccess.pagePaths = ['/nantong-base'];
    expect(redirect()?.props.to).toBe('/nantong-base');
    mockEffects.forEach(effect => effect());
    expect(mockAccess.requestLogin).not.toHaveBeenCalled();
  });
  it('keeps personal self-service reachable when no business pages or actions are granted', () => {
    mockAccess.pagePaths = [];
    const tree = render();
    expect(redirect(tree)?.props.to).toBe('/personal-center');
    expect(outlet(tree)).toBeUndefined();
    mockLocation.pathname = '/personal-center';
    expect(outlet()).toBeDefined(); expect(redirect()).toBeUndefined();
  });
  it('never redirects a non-admin into the protected configuration page', () => {
    mockAccess.pagePaths = ['/system-configuration'];
    const tree = render();
    expect(redirect(tree)?.props.to).toBe('/personal-center');
    expect(outlet(tree)).toBeUndefined();
  });
  it('preserves identity confirmation and source failure recovery before redirecting', () => {
    mockAccess.isConfirmingIdentity = true;
    expect(text(render())).toContain('正在确认登录身份');
    expect(redirect()).toBeUndefined();
    mockAccess.isConfirmingIdentity = false; mockAccess.sessionError = '合成会话读取失败';
    expect(text(render())).toContain('合成会话读取失败');
    expect(redirect()).toBeUndefined();
    mockAccess.sessionError = null; mockAccess.isLoading = true;
    expect(text(render())).toContain('正在确认登录身份');
    expect(redirect()).toBeUndefined();
  });
  it('does not treat an anonymous visitor as an authenticated account', () => {
    mockAccess.role = 'guest'; mockAccess.expiresAt = null; mockAccess.principalFingerprint = null;
    mockAccess.pagePaths = ['/nantong-base'];
    expect(redirect()).toBeUndefined();
    expect(text(render())).toContain('当前页面需要登录权限');
    mockLocation.pathname = '/nantong-base';
    expect(outlet()).toBeDefined();
    mockLocation.pathname = '/personal-center';
    expect(outlet()).toBeUndefined(); expect(redirect()).toBeUndefined();
  });
  it('does not open automatic login over an expired impersonation recovery context', () => {
    mockAccess.role = 'guest'; mockAccess.expiresAt = null; mockAccess.principalFingerprint = null;
    mockAccess.pagePaths = []; mockAccess.impersonation = { actorAccountId: 'synthetic-admin', actorName: '合成管理员', targetName: '合成人员', expiresAt: Date.now() - 1 };
    render(); mockEffects.forEach(effect => effect());
    expect(mockAccess.requestLogin).not.toHaveBeenCalled();
  });
  it('does not replace an explicit password-updated login dialog with the route prompt', () => {
    mockLocation.pathname = '/personal-center';
    mockAccess.role = 'guest'; mockAccess.expiresAt = null; mockAccess.principalFingerprint = null;
    mockAccess.pagePaths = []; mockAccess.isLoginDialogOpen = true;
    render(); mockEffects.forEach(effect => effect());
    expect(mockAccess.requestLogin).not.toHaveBeenCalled();
  });
  it('keeps administrators and controlled screenshot requests on their current route', () => {
    mockAccess.role = 'admin'; mockAccess.pagePaths = [];
    expect(outlet()).toBeDefined();
    mockAccess.role = 'guest'; mockAccess.expiresAt = null; mockAccess.principalFingerprint = null;
    mockLocation = { pathname: '/campus-operations-dashboard', search: '?screenshot=1&screenshotDate=2026-10-28&screenshotShift=white&screenshotToken=synthetic', hash: '' };
    expect(outlet()).toBeDefined();
  });
  it.each([
    ['leave_requests', '/monthly-schedule/apply/leave'],
    ['overtime_requests', '/monthly-schedule/apply/overtime'],
    ['purchase', '/purchase-inventory-management/apply/new'],
  ] as const)('retains a %s create-only direct entry without granting its list', (module, path) => {
    mockAccess.role = 'guest'; mockAccess.pagePaths = [];
    mockAccess.effectiveAuthorization = { mode: 'independent',
      baseline: { nativeRole: null, pages: [], rules: [{ id: 'synthetic-create-only', module, effect: 'allow', actions: ['create'], buildings: null, specialties: null }] },
      overrides: { rules: [], allowPages: [], denyPages: [] },
    };
    mockLocation.pathname = path;
    expect(outlet()).toBeDefined();
    mockLocation.pathname = '/contract-management';
    expect(redirect()?.props.to).toBe(path);
  });
});
