import type { ReactElement, ReactNode } from 'react';

// Same retained-hook harness as configuration-editor-safety: real component
// callbacks, with browser focus/portal behavior covered by browser acceptance.
const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockSession: Record<string, any>;
let mockPlatformUserId = '';
const mockLocation = { pathname: '/contract-management', search: '', hash: '', key: 'synthetic-location' };
const mockNavigate = jest.fn();
const mockReload = jest.fn();
const mockSignOut = jest.fn();
const mockProfile = jest.fn();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const slot = mockCursor++;
    if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }];
  },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
}));
jest.mock('../../client/src/access/AccessProvider', () => ({ useAccess: () => mockSession, getAccessRoleLabel: (role: string) => role === 'admin' ? '管理员' : '合成角色' }));
jest.mock('react-router-dom', () => ({ ...jest.requireActual('react-router-dom'), useLocation: () => mockLocation, useNavigate: () => mockNavigate }));
jest.mock('@lark-apaas/client-toolkit/hooks/useCurrentUserProfile', () => ({ useCurrentUserProfile: () => ({ user_id: mockPlatformUserId }) }));
jest.mock('@lark-apaas/client-toolkit/dataloom', () => ({ getDataloom: jest.fn() }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

import { isValidElement } from 'react';
import { toast } from 'sonner';
import { getDataloom } from '@lark-apaas/client-toolkit/dataloom';
import { GlobalUserControl } from '../../client/src/components/Layout';
import { GlobalNavigation } from '../../client/src/components/GlobalNavigation';
import { UserNameAvatar } from '../../client/src/components/UserNameAvatar';
import { DropdownMenu, DropdownMenuItem } from '../../client/src/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction } from '../../client/src/components/ui/alert-dialog';

function nodes(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];
}
function words(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return isValidElement<any>(node) ? words(node.props.children) : '';
}
const render = (factory = GlobalUserControl) => { mockCursor = 0; return factory(); };
const menu = (tree: ReactNode) => nodes(tree).find(node => node.type === DropdownMenu)!;
const dialog = (tree: ReactNode) => nodes(tree).find(node => node.type === AlertDialog)!;
const item = (tree: ReactNode, label: string) => nodes(tree).find(node => node.type === DropdownMenuItem && words(node.props.children) === label)!;
const labels = (tree: ReactNode) => nodes(tree).filter(node => node.type === DropdownMenuItem).map(node => words(node.props.children));
const event = () => ({ preventDefault: jest.fn() });
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function openMenu() { menu(render()).props.onOpenChange(true); return render(); }
function authenticate(extra: Record<string, unknown> = {}) {
  Object.assign(mockSession, { role: 'editor', displayName: '合成人员', expiresAt: Date.now() + 60_000, principalFingerprint: 'f'.repeat(43), ...extra });
}
function openPlatformConfirmation() { item(openMenu(), '退出平台账号').props.onSelect(); return render(); }

describe('one account menu uses the real callbacks and identity boundaries', () => {
  beforeEach(() => {
    mockSlots.length = 0; mockCursor = 0; jest.clearAllMocks(); mockPlatformUserId = '';
    mockLocation.pathname = '/contract-management';
    mockSession = { role: 'guest', purchaseBuilding: null, expiresAt: null, principalFingerprint: null, isLoading: false,
      isConfirmingIdentity: false, isChangingIdentity: false, sessionError: null, requestLogin: jest.fn(), retrySession: jest.fn().mockResolvedValue(undefined), logout: jest.fn() };
    (getDataloom as jest.Mock).mockReset().mockResolvedValue({ service: { session: { signOut: mockSignOut, navigateToUserProfile: mockProfile } } });
    mockSignOut.mockReset().mockResolvedValue(undefined); mockProfile.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { reload: mockReload } } });
  });
  afterEach(() => { jest.useRealTimers(); if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });

  it('mounts exactly one account entry in the real global navigation', () => {
    expect(nodes(render(GlobalNavigation)).filter(node => node.type === GlobalUserControl)).toHaveLength(1);
  });
  it('offers an anonymous visitor only login and opens the shared login flow', () => {
    const tree = openMenu(); expect(labels(tree)).toEqual(['登录']); expect(words(tree)).toContain('尚未登录');
    item(tree, '登录').props.onSelect();
    expect(mockSession.requestLogin).toHaveBeenCalledWith('请选择登录方式。', '/contract-management');
    expect(mockSession.logout).not.toHaveBeenCalled(); expect(getDataloom).not.toHaveBeenCalled();
    expect(menu(render()).props.open).toBe(false);
  });
  it('switches directly to login without first destroying the confirmed identity', () => {
    authenticate(); const original = { ...mockSession }; item(openMenu(), '切换账号').props.onSelect();
    expect(mockSession.requestLogin).toHaveBeenCalledTimes(1); expect(mockSession.logout).not.toHaveBeenCalled();
    expect(mockSession.displayName).toBe(original.displayName); expect(mockSession.principalFingerprint).toBe(original.principalFingerprint);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
  it.each(['independent', 'follow'] as const)('recognizes signed V2 guest transport identities in %s mode', mode => {
    authenticate({ role: 'guest', effectiveAuthorization: { mode, baseline: { nativeRole: null, pages: [], rules: [] }, overrides: { rules: [], allowPages: [], denyPages: [] } } });
    const tree = openMenu(); expect(labels(tree)).toEqual(['切换账号', '退出当前账号']);
    expect(words(tree)).toContain(mode === 'independent' ? '已登录 · 独立授权' : '已登录 · 跟随角色'); expect(words(tree)).not.toContain('尚未登录');
    expect(nodes(tree).filter(node => node.type === UserNameAvatar).every(node => node.props.isGuest === false && node.props.name === '合成人员')).toBe(true);
    expect(labels(tree)).not.toContain('系统配置');
  });
  it('shows system configuration only for the actual administrator', () => {
    authenticate({ role: 'admin' }); item(openMenu(), '系统配置').props.onSelect(); expect(mockNavigate).toHaveBeenCalledWith('/system-configuration');
    mockSession.role = 'professional_admin'; expect(labels(render())).not.toContain('系统配置');
  });
  it.each(['isLoading', 'isConfirmingIdentity', 'isChangingIdentity'])('disables account operations while %s', flag => {
    authenticate({ role: 'admin', [flag]: true, sessionError: '合成确认错误' }); mockPlatformUserId = 'synthetic-platform';
    const tree = openMenu(); expect(nodes(tree).filter(node => node.type === DropdownMenuItem || node.type === AlertDialogAction).every(node => node.props.disabled)).toBe(true);
    item(tree, '切换账号').props.onSelect(); item(tree, '退出当前账号').props.onSelect(event()); item(tree, '重新确认身份').props.onSelect(event());
    expect(mockSession.requestLogin).not.toHaveBeenCalled(); expect(mockSession.logout).not.toHaveBeenCalled(); expect(mockSession.retrySession).not.toHaveBeenCalled();
    expect(getDataloom).not.toHaveBeenCalled();
  });
  it('retries session confirmation without starting another login or closing the menu', async () => {
    authenticate({ sessionError: '合成暂时失败' }); const pending = deferred<void>(); mockSession.retrySession.mockReturnValue(pending.promise);
    const tree = openMenu(), action = item(tree, '重新确认身份'), selection = event(); action.props.onSelect(selection); action.props.onSelect(event());
    expect(selection.preventDefault).toHaveBeenCalled(); expect(mockSession.retrySession).toHaveBeenCalledTimes(1);
    expect(item(render(), '正在确认身份…').props.disabled).toBe(true); expect(menu(render()).props.open).toBe(true);
    pending.resolve(); await flush(); expect(menu(render()).props.open).toBe(true);
    expect(mockSession.requestLogin).not.toHaveBeenCalled(); expect(mockSession.logout).not.toHaveBeenCalled(); expect(getDataloom).not.toHaveBeenCalled();
  });
  it('coalesces same-turn logout clicks and closes only after the real logout completes', async () => {
    authenticate(); const pending = deferred<boolean>(); mockSession.logout.mockReturnValue(pending.promise);
    const action = item(openMenu(), '退出当前账号'), selection = event(); action.props.onSelect(selection); action.props.onSelect(event());
    expect(selection.preventDefault).toHaveBeenCalled(); expect(mockSession.logout).toHaveBeenCalledTimes(1);
    expect(menu(render()).props.open).toBe(true); expect(item(render(), '正在退出…').props.disabled).toBe(true); expect(toast.success).not.toHaveBeenCalled();
    pending.resolve(true); await flush();
    expect(menu(render()).props.open).toBe(false); expect(toast.success).toHaveBeenCalledWith('已退出当前账号');
    expect(mockNavigate).toHaveBeenCalledWith('/monthly-schedule', { replace: true }); expect(mockSignOut).not.toHaveBeenCalled();
  });
  it.each(['reject', 'cancel'] as const)('keeps the menu and confirmed identity when logout returns %s', async outcome => {
    authenticate(); const before = { ...mockSession };
    if (outcome === 'reject') mockSession.logout.mockRejectedValue(new Error('synthetic logout failure')); else mockSession.logout.mockResolvedValue(false);
    item(openMenu(), '退出当前账号').props.onSelect(event()); await flush();
    const tree = render(); expect(menu(tree).props.open).toBe(true); expect(item(tree, '退出当前账号').props.disabled).toBe(false);
    expect(mockSession.displayName).toBe(before.displayName); expect(mockSession.principalFingerprint).toBe(before.principalFingerprint);
    expect(mockNavigate).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled(); expect(mockSignOut).not.toHaveBeenCalled();
    if (outcome === 'reject') expect(toast.error).toHaveBeenCalledWith('退出失败，请重试');
  });
  it('platform sign-out remains separate, retains failed confirmation, then closes only on success', async () => {
    authenticate(); mockPlatformUserId = 'synthetic-platform'; const pending = deferred<void>(); mockSignOut.mockReturnValueOnce(pending.promise);
    let tree = openPlatformConfirmation(); expect(dialog(tree).props.open).toBe(true);
    const action = nodes(tree).find(node => node.type === AlertDialogAction)!, click = event(); action.props.onClick(click); action.props.onClick(event()); await flush();
    expect(click.preventDefault).toHaveBeenCalled(); expect(mockSignOut).toHaveBeenCalledTimes(1); expect(mockSession.logout).not.toHaveBeenCalled();
    tree = render(); dialog(tree).props.onOpenChange(false); expect(dialog(render()).props.open).toBe(true);
    pending.reject(new Error('synthetic platform failure')); await flush();
    tree = render(); expect(dialog(tree).props.open).toBe(true); expect(mockReload).not.toHaveBeenCalled(); expect(mockSession.displayName).toBe('合成人员');
    expect(toast.error).toHaveBeenCalledWith('退出平台账号失败，请重试');
    nodes(tree).find(node => node.type === AlertDialogAction)!.props.onClick(event()); await flush();
    expect(dialog(render()).props.open).toBe(false); expect(mockReload).toHaveBeenCalledTimes(1); expect(mockSession.logout).not.toHaveBeenCalled();
  });
  it('keeps platform confirmation if obtaining the platform SDK fails', async () => {
    authenticate(); mockPlatformUserId = 'synthetic-platform'; (getDataloom as jest.Mock).mockRejectedValueOnce(new Error('synthetic SDK failure'));
    const tree = openPlatformConfirmation(); nodes(tree).find(node => node.type === AlertDialogAction)!.props.onClick(event()); await flush();
    expect(dialog(render()).props.open).toBe(true); expect(mockSignOut).not.toHaveBeenCalled(); expect(mockSession.logout).not.toHaveBeenCalled(); expect(mockReload).not.toHaveBeenCalled();
  });
  it('retains the menu when opening the platform profile fails', async () => {
    authenticate(); mockPlatformUserId = 'synthetic-platform'; mockProfile.mockRejectedValueOnce(new Error('synthetic profile failure'));
    item(openMenu(), '个人主页').props.onSelect(event()); await flush();
    expect(menu(render()).props.open).toBe(true); expect(toast.error).toHaveBeenCalledWith('打开个人主页失败，请重试');
    expect(mockSession.logout).not.toHaveBeenCalled(); expect(mockSignOut).not.toHaveBeenCalled();
  });
  it('restores the platform confirmation controls after SDK acquisition never settles', async () => {
    jest.useFakeTimers(); authenticate(); mockPlatformUserId = 'synthetic-platform';
    (getDataloom as jest.Mock).mockReturnValueOnce(deferred<unknown>().promise);
    const tree = openPlatformConfirmation(); nodes(tree).find(node => node.type === AlertDialogAction)!.props.onClick(event());
    expect(nodes(render()).find(node => node.type === AlertDialogAction)!.props.disabled).toBe(true);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(toast.error).not.toHaveBeenCalled(); expect(dialog(render()).props.open).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    const settled = render(), action = nodes(settled).find(node => node.type === AlertDialogAction)!;
    expect(action.props.disabled).toBe(false); expect(words(action)).toBe('退出平台账号'); expect(dialog(settled).props.open).toBe(true);
    expect(toast.error).toHaveBeenCalledWith('平台响应超时，操作结果未确认，请刷新页面后检查');
    expect(mockSession.displayName).toBe('合成人员'); expect(mockSignOut).not.toHaveBeenCalled(); expect(mockReload).not.toHaveBeenCalled();
    expect(mockSession.logout).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
  it('does not start sign-out when the SDK arrives after the deadline', async () => {
    jest.useFakeTimers(); authenticate(); mockPlatformUserId = 'synthetic-platform'; const sdk = deferred<unknown>();
    (getDataloom as jest.Mock).mockReturnValueOnce(sdk.promise);
    nodes(openPlatformConfirmation()).find(node => node.type === AlertDialogAction)!.props.onClick(event());
    await jest.advanceTimersByTimeAsync(15_000);
    expect(dialog(render()).props.open).toBe(true);
    sdk.resolve({ service: { session: { signOut: mockSignOut } } }); await flush();
    expect(mockSignOut).not.toHaveBeenCalled(); expect(mockSession.logout).not.toHaveBeenCalled(); expect(mockReload).not.toHaveBeenCalled();
    expect(dialog(render()).props.open).toBe(true); expect(nodes(render()).find(node => node.type === AlertDialogAction)!.props.disabled).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1); expect(toast.success).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
  it('does not reload or close confirmation when an issued sign-out succeeds after timeout', async () => {
    jest.useFakeTimers(); authenticate(); mockPlatformUserId = 'synthetic-platform'; const issued = deferred<void>();
    mockSignOut.mockReturnValueOnce(issued.promise);
    nodes(openPlatformConfirmation()).find(node => node.type === AlertDialogAction)!.props.onClick(event()); await flush();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(dialog(render()).props.open).toBe(true); expect(nodes(render()).find(node => node.type === AlertDialogAction)!.props.disabled).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('平台响应超时，操作结果未确认，请刷新页面后检查');
    issued.resolve(); await flush();
    expect(dialog(render()).props.open).toBe(true); expect(mockReload).not.toHaveBeenCalled(); expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSession.logout).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).toHaveBeenCalledTimes(1);
    expect(mockSession.principalFingerprint).toBe('f'.repeat(43)); expect(jest.getTimerCount()).toBe(0);
  });
  it('keeps the profile menu usable and ignores a late SDK after the same timeout', async () => {
    jest.useFakeTimers(); authenticate(); mockPlatformUserId = 'synthetic-platform'; const sdk = deferred<unknown>();
    (getDataloom as jest.Mock).mockReturnValueOnce(sdk.promise);
    item(openMenu(), '个人主页').props.onSelect(event()); expect(item(render(), '正在打开…').props.disabled).toBe(true);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(menu(render()).props.open).toBe(true); expect(item(render(), '个人主页').props.disabled).toBe(false);
    sdk.resolve({ service: { session: { navigateToUserProfile: mockProfile } } }); await flush();
    expect(mockProfile).not.toHaveBeenCalled(); expect(menu(render()).props.open).toBe(true); expect(mockReload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('平台响应超时，操作结果未确认，请刷新页面后检查');
    expect(mockSession.logout).not.toHaveBeenCalled(); expect(mockSignOut).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
});
