import type { ReactElement } from 'react';

const mockSlots: unknown[] = [];
const mockEffects: Array<() => void | (() => void)> = [];
let mockCursor = 0;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const slot = mockCursor++;
    if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [mockSlots[slot], (next: unknown) => {
      mockSlots[slot] = typeof next === 'function' ? (next as (value: unknown) => unknown)(mockSlots[slot]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const slot = mockCursor++;
    if (!(slot in mockSlots)) mockSlots[slot] = { current: initial };
    return mockSlots[slot];
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { mockEffects.push(effect); },
}));
jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/monthly-schedule', search: '', hash: '', key: 'synthetic' }),
  useNavigate: () => jest.fn(),
}));
jest.mock('../../client/src/api', () => ({ getAccessSession: jest.fn(), loginAccess: jest.fn(), logoutAccess: jest.fn() }));
jest.mock('../../client/src/access/use-feishu-login', () => ({ useFeishuLogin: () => ({ start: jest.fn(), isPending: false, error: null }) }));
jest.mock('../../client/src/components/FeishuIcon', () => ({ FeishuIcon: 'i' }));
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: Object.assign(jest.fn(), { interceptors: {
    request: { use: jest.fn(() => 1), eject: jest.fn() },
    response: { use: jest.fn(() => 1), eject: jest.fn() },
  } }),
}), { virtual: true });
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn(), dismiss: jest.fn() } }));

import { getAccessSession, logoutAccess } from '../../client/src/api';
import { AccessProvider } from '../../client/src/access/AccessProvider';
import { UNIFIED_ACCESS_INVALIDATED_EVENT } from '../../client/src/access/access-events';
import { toast } from 'sonner';

const getSession = getAccessSession as jest.Mock;
const logout = logoutAccess as jest.Mock;
const warning = toast.warning as jest.Mock;
const dismissed = toast.dismiss as jest.Mock;
const guest = { role: 'guest', purchaseBuilding: null, expiresAt: null, principalFingerprint: null };
const timeout = { code: 'ECONNABORTED' };

function authenticated(expiresAt = Date.now() + 60_000) {
  return { role: 'site_member', purchaseBuilding: null, accountId: 'local-synthetic',
    authorizationVersion: 1, displayName: '测试人员', principalFingerprint: 'synthetic-session', expiresAt };
}

function render(): ReactElement<any> {
  mockCursor = 0;
  mockEffects.length = 0;
  return AccessProvider({ children: 'synthetic business' });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function openSession(expiresAt?: number): Promise<ReactElement<any>> {
  getSession.mockResolvedValueOnce(authenticated(expiresAt));
  await render().props.value.refreshSession();
  return render();
}

function attachSessionListeners(): () => void {
  const effect = mockEffects.find(candidate => String(candidate).includes('installUnifiedAccessResponseInterceptor'));
  if (!effect) throw new Error('session listener effect not found');
  const cleanup = effect();
  return typeof cleanup === 'function' ? cleanup : () => undefined;
}

describe('background identity refresh', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let win: EventTarget;
  let doc: EventTarget;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    getSession.mockReset();
    logout.mockReset();
    mockSlots.length = 0;
    mockEffects.length = 0;
    mockCursor = 0;
    win = Object.assign(new EventTarget(), {
      location: { origin: 'http://localhost' },
      setTimeout, clearTimeout, setInterval, clearInterval,
    });
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  });
  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    jest.useRealTimers();
  });

  it('retries one transient read without displaying a warning if it recovers', async () => {
    const tree = await openSession();
    getSession.mockRejectedValueOnce(timeout).mockResolvedValueOnce(authenticated());
    const pending = tree.props.value.refreshSession(true);
    await flush();
    expect(getSession).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(warning).not.toHaveBeenCalled();
    expect(render().props.value.sessionError).toBeNull();
  });

  it('shows one warning for an ongoing failure and clears it when the read succeeds', async () => {
    const tree = await openSession();
    getSession.mockRejectedValue(timeout);
    const fail = tree.props.value.refreshSession(true);
    await flush();
    await jest.advanceTimersByTimeAsync(1_500);
    await fail;
    expect(warning).toHaveBeenCalledTimes(1);
    expect(render().props.value.sessionError).toBeNull();
    const failAgain = render().props.value.refreshSession(true);
    await flush();
    await jest.advanceTimersByTimeAsync(1_500);
    await failAgain;
    expect(warning).toHaveBeenCalledTimes(1);
    getSession.mockResolvedValueOnce(authenticated());
    await render().props.value.refreshSession(true);
    expect(dismissed).toHaveBeenCalledWith('access-background-session-warning');
  });

  it.each([401, 403])('does not retry or accept an HTTP %s identity rejection', async status => {
    const tree = await openSession();
    getSession.mockRejectedValueOnce({ code: 'ERR_NETWORK', response: { status } });
    await tree.props.value.refreshSession(true);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
    expect(render().props.value.sessionError).toBeTruthy();
  });

  it('does not retry or restore a session after logout during the retry pause', async () => {
    const tree = await openSession();
    getSession.mockRejectedValueOnce(timeout);
    const pending = tree.props.value.refreshSession(true);
    await flush();
    logout.mockResolvedValueOnce(guest);
    expect(await tree.props.value.logout()).toBe(true);
    await jest.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(render().props.value.role).toBe('guest');
    expect(warning).not.toHaveBeenCalled();
  });

  it('does not restore an old successful read after logout', async () => {
    const tree = await openSession();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = tree.props.value.refreshSession(true);
    logout.mockResolvedValueOnce(guest);
    expect(await tree.props.value.logout()).toBe(true);
    finish(authenticated());
    await pending;
    expect(render().props.value.role).toBe('guest');
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('does not retry or preserve a session that expires during the retry pause', async () => {
    const tree = await openSession(Date.now() + 1_000);
    getSession.mockRejectedValueOnce(timeout);
    const pending = tree.props.value.refreshSession(true);
    await flush();
    await jest.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
    expect(render().props.value.sessionError).toBeTruthy();
  });

  it('rejects an expired successful response arriving after the expiry timer', async () => {
    const expiry = Date.now() + 1_000;
    const tree = await openSession(expiry);
    const expiryEffect = mockEffects.find(candidate => String(candidate).includes('markSessionExpired'));
    if (!expiryEffect) throw new Error('session expiration effect not found');
    const cleanup = expiryEffect();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = tree.props.value.refreshSession(true);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(render().props.value.role).toBe('guest');
    finish(authenticated(expiry));
    await pending;
    expect(render().props.value.role).toBe('guest');
    expect(render().props.value.sessionError).toContain('登录会话已失效');
    if (typeof cleanup === 'function') cleanup();
  });

  it('shares one in-flight read across concurrent refresh requests', async () => {
    const tree = await openSession();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = tree.props.value.refreshSession(true);
    const second = tree.props.value.refreshSession(true);
    expect(second).toBe(first);
    expect(getSession).toHaveBeenCalledTimes(2);
    finish(authenticated());
    await Promise.all([first, second]);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending retry and removes listeners and timers when unmounted', async () => {
    await openSession();
    getSession.mockResolvedValueOnce(authenticated());
    const cleanup = attachSessionListeners();
    await flush();
    const tree = render();
    getSession.mockRejectedValueOnce(timeout);
    const pending = tree.props.value.refreshSession(true);
    await flush();
    expect(jest.getTimerCount()).toBe(2);
    cleanup();
    await pending;
    expect(jest.getTimerCount()).toBe(0);
    const calls = getSession.mock.calls.length;
    win.dispatchEvent(new Event('online'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getSession).toHaveBeenCalledTimes(calls);
    expect(warning).not.toHaveBeenCalled();
  });

  it('ignores an in-flight response after unmount', async () => {
    await openSession();
    getSession.mockResolvedValueOnce(authenticated());
    const cleanup = attachSessionListeners();
    await flush();
    const tree = render();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = tree.props.value.refreshSession(true);
    cleanup();
    finish({ ...authenticated(), role: 'admin' });
    await pending;
    expect(render().props.value.role).toBe('site_member');
  });

  it('waits for a disposed read before checking the session after remount', async () => {
    await openSession();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const cleanup = attachSessionListeners();
    expect(getSession).toHaveBeenCalledTimes(2);
    cleanup();
    render();
    getSession.mockResolvedValueOnce(authenticated());
    const cleanupAfterRemount = attachSessionListeners();
    expect(getSession).toHaveBeenCalledTimes(2);
    finish({ ...authenticated(), role: 'admin' });
    await flush();
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(render().props.value.role).toBe('site_member');
    cleanupAfterRemount();
  });

  it('rechecks immediately when the browser comes back online', async () => {
    await openSession();
    getSession.mockResolvedValueOnce(authenticated());
    const cleanup = attachSessionListeners();
    await flush();
    const tree = render();
    getSession.mockRejectedValue(timeout);
    const pending = tree.props.value.refreshSession(true);
    await flush();
    await jest.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(warning).toHaveBeenCalledTimes(1);
    const calls = getSession.mock.calls.length;
    getSession.mockResolvedValueOnce(authenticated());
    win.dispatchEvent(new Event('online'));
    await flush();
    expect(getSession).toHaveBeenCalledTimes(calls + 1);
    expect(dismissed).toHaveBeenCalledWith('access-background-session-warning');
    cleanup();
  });

  it('ignores an older read and checks the server again after permissions were invalidated', async () => {
    await openSession();
    getSession.mockResolvedValueOnce(authenticated());
    const cleanup = attachSessionListeners();
    await flush();
    const tree = render();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(guest);
    const pending = tree.props.value.refreshSession(true);
    win.dispatchEvent(new Event(UNIFIED_ACCESS_INVALIDATED_EVENT));
    finish(authenticated());
    await pending;
    await flush();
    expect(getSession).toHaveBeenCalledTimes(4);
    expect(render().props.value.role).toBe('guest');
    cleanup();
  });

  it('does not retry an old read after permissions were invalidated during the retry pause', async () => {
    await openSession();
    getSession.mockResolvedValueOnce(authenticated());
    const cleanup = attachSessionListeners();
    await flush();
    const tree = render();
    getSession.mockRejectedValueOnce(timeout).mockResolvedValueOnce(guest);
    const pending = tree.props.value.refreshSession(true);
    await flush();
    win.dispatchEvent(new Event(UNIFIED_ACCESS_INVALIDATED_EVENT));
    await jest.advanceTimersByTimeAsync(1_500);
    await pending;
    await flush();
    expect(getSession).toHaveBeenCalledTimes(4);
    expect(render().props.value.role).toBe('guest');
    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining('暂时无法刷新登录状态'), expect.anything(),
    );
    cleanup();
  });
});
