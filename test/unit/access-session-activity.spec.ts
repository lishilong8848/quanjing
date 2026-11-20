import {
  createSessionActivityController,
  isConfirmedActivityRenewal,
  mergeActivityRenewalSnapshot,
  SESSION_ACTIVITY_EVENTS,
  SESSION_ACTIVITY_INTERVAL_MS,
  withSessionCookieLock,
  type ActivitySessionSnapshot,
} from '../../client/src/access/session-activity';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

const DAY = 24 * 60 * 60 * 1000;
const input = (type = 'pointerdown', isTrusted = true) => ({ type, isTrusted });

describe('activity-based login renewal', () => {
  let snapshot: ActivitySessionSnapshot;
  let visible: boolean;
  let renew: jest.Mock;
  let controller: ReturnType<typeof createSessionActivityController>;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_800_000_000_000);
    snapshot = { fingerprint: 'family-a', expiresAt: Date.now() + DAY, enabled: true };
    visible = true;
    renew = jest.fn(async () => { snapshot = { ...snapshot, expiresAt: Date.now() + DAY }; });
    controller = createSessionActivityController({ snapshot: () => snapshot, visible: () => visible, renew });
  });
  afterEach(() => { controller.dispose(); jest.useRealTimers(); });

  it('renews once for trusted input and remains valid beyond the original deadline', async () => {
    await jest.advanceTimersByTimeAsync(DAY - 30_000);
    const oldExpiry = snapshot.expiresAt!;
    controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(snapshot.expiresAt).toBeGreaterThan(oldExpiry);
    await jest.advanceTimersByTimeAsync(31_000);
    expect(snapshot.expiresAt).toBeGreaterThan(Date.now());
  });

  it('does not keep an idle page alive for 24 hours', async () => {
    const expiry = snapshot.expiresAt;
    await jest.advanceTimersByTimeAsync(DAY + 1);
    expect(renew).not.toHaveBeenCalled();
    expect(snapshot.expiresAt).toBe(expiry);
    controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    expect(renew).not.toHaveBeenCalled();
  });

  it('ignores polling, focus, generated input and programmatic scroll events', async () => {
    controller.record(input('focus'));
    controller.record(input('visibilitychange'));
    controller.record(input('scroll'));
    controller.record(input('pointerdown', false));
    await jest.advanceTimersByTimeAsync(5 * SESSION_ACTIVITY_INTERVAL_MS);
    expect(renew).not.toHaveBeenCalled();
  });

  it.each(SESSION_ACTIVITY_EVENTS)('accepts real %s input', async type => {
    controller.record(input(type));
    await jest.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledWith('family-a');
  });

  it('coalesces duplicate clicks and preserves the final input within a throttle window', async () => {
    controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 20; i++) controller.record(input('keydown'));
    await jest.advanceTimersByTimeAsync(SESSION_ACTIVITY_INTERVAL_MS - 2);
    expect(renew).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2);
    expect(renew).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(DAY);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('does not debounce continuous operation indefinitely', async () => {
    for (let i = 0; i < 14; i++) {
      controller.record(input());
      await jest.advanceTimersByTimeAsync(10_000);
    }
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it('permits one in-flight renewal and one later input batch', async () => {
    let finish!: () => void;
    renew.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    controller.record(input());
    await jest.advanceTimersByTimeAsync(90_000);
    expect(renew).toHaveBeenCalledTimes(1);
    finish();
    await jest.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('does not auto-repeat a failed authentication mutation without more input', async () => {
    renew.mockRejectedValueOnce(new Error('offline'));
    controller.record(input());
    await jest.advanceTimersByTimeAsync(5 * SESSION_ACTIVITY_INTERVAL_MS);
    expect(renew).toHaveBeenCalledTimes(1);
    controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('bounds failed near-expiry retries rather than sending for every key', async () => {
    snapshot.expiresAt = Date.now() + 50_000;
    renew.mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 40; i++) {
      controller.record(input());
      await jest.advanceTimersByTimeAsync(100);
    }
    expect(renew).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1001);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('drops trailing work when logout or identity replacement occurs', async () => {
    controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    controller.record(input());
    snapshot = { ...snapshot, enabled: false };
    await jest.advanceTimersByTimeAsync(SESSION_ACTIVITY_INTERVAL_MS);
    expect(renew).toHaveBeenCalledTimes(1);
    snapshot = { ...snapshot, enabled: true, fingerprint: 'family-b' };
    await jest.advanceTimersByTimeAsync(SESSION_ACTIVITY_INTERVAL_MS);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('ignores hidden pages, guests and impersonation-disabled snapshots', async () => {
    visible = false; controller.record(input());
    visible = true; snapshot.enabled = false; controller.record(input());
    snapshot.enabled = true; snapshot.fingerprint = null; controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    expect(renew).not.toHaveBeenCalled();
  });

  it('cancels pending work when unmounted and ignores late completion', async () => {
    let finish!: () => void;
    renew.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    controller.record(input());
    await jest.advanceTimersByTimeAsync(1);
    controller.record(input()); controller.dispose(); finish();
    await jest.advanceTimersByTimeAsync(2 * SESSION_ACTIVITY_INTERVAL_MS);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});

describe('same-origin session cookie mutation lock', () => {
  it('uses the browser lock when available and supports a same-tab fallback', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      const operation = jest.fn(async () => 'confirmed');
      const request = jest.fn((_key: string, callback: () => Promise<string>) => callback());
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request } } });
      expect(await withSessionCookieLock(operation)).toBe('confirmed');
      expect(request).toHaveBeenCalledWith('vnet-access-session-cookie', operation);
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
      expect(await withSessionCookieLock(operation)).toBe('confirmed');
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});

describe('renewal response crossing the old deadline', () => {
  const identity = { role: 'admin', purchaseBuilding: null, principalFingerprint: 'family-a', accountId: 'local-admin-all', authorizationVersion: 1 };
  it('accepts a valid same-family response that finishes after the old expiry', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_800_000_000_000);
      const oldExpiry = Date.now() + 1000;
      const submitted = { ...identity, expiresAt: oldExpiry };
      const response = new Promise<{ expiresAt: number } & typeof identity>(resolve => {
        setTimeout(() => resolve({ ...identity, expiresAt: oldExpiry - 500 + DAY }), 2000);
      });
      await jest.advanceTimersByTimeAsync(2000);
      expect(Date.now()).toBeGreaterThan(oldExpiry);
      expect(isConfirmedActivityRenewal(submitted, await response)).toBe(true);
    } finally { jest.useRealTimers(); }
  });

  it('still rejects expired responses, changed accounts or impersonation', () => {
    const now = 1_800_000_000_000;
    expect(isConfirmedActivityRenewal(identity, { ...identity, expiresAt: now }, now)).toBe(false);
    expect(isConfirmedActivityRenewal(identity, { ...identity, accountId: 'local-other', expiresAt: now + DAY }, now)).toBe(false);
    expect(isConfirmedActivityRenewal(identity, { ...identity, authorizationVersion: 2, expiresAt: now + DAY }, now)).toBe(false);
    expect(isConfirmedActivityRenewal(identity, { ...identity, expiresAt: now + DAY, impersonation: {} }, now)).toBe(false);
  });

  it('retains a newer permission read while adopting the newly confirmed expiry', () => {
    const current = { ...identity, expiresAt: 1000, pagePermissionsRevision: 11, pagePaths: ['/current'] };
    const delayed = { ...identity, expiresAt: 1000 + DAY, pagePermissionsRevision: 10, pagePaths: ['/old'] };
    expect(mergeActivityRenewalSnapshot(current, delayed)).toEqual({ ...current, expiresAt: delayed.expiresAt });
    expect(mergeActivityRenewalSnapshot(delayed, current)).toEqual({ ...current, expiresAt: delayed.expiresAt });
  });

  it('does not merge renewed expiry into a different account or session family', () => {
    const current = { ...identity, expiresAt: 1000, pagePermissionsRevision: 11 };
    const other = { ...identity, principalFingerprint: 'family-b', expiresAt: 1000 + DAY, pagePermissionsRevision: 12 };
    expect(mergeActivityRenewalSnapshot(current, other)).toBe(current);
  });
});

describe('actual provider refresh guards while a cookie renewal is pending', () => {
  function fixture() {
    const source = readFileSync('client/src/access/AccessProvider.tsx', 'utf8');
    const file = ts.createSourceFile('AccessProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'refreshSession' &&
        node.initializer && ts.isCallExpression(node.initializer) && ts.isArrowFunction(node.initializer.arguments[0])) {
        callback = node.initializer.arguments[0];
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!callback || !ts.isBlock(callback.body)) throw new Error('Actual provider refresh callback was not found');
    const stop = callback.body.statements.findIndex(statement => ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(declaration => declaration.name.getText(file) === 'refreshToken'));
    if (stop < 0) throw new Error('Actual provider guard boundary was not found');
    // Execute the actual early guards from the provider, with a sentinel read
    // instead of the unrelated rendering/permission code below those guards.
    const prefix = callback.body.statements.slice(0, stop).map(statement => statement.getText(file)).join('\n');
    const code = ts.transpileModule(`function refreshSession(silent = false) { ${prefix}\nreturn getAccessSession(); }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const lifecycle = new AbortController();
    const refs = {
      refreshLifecycle: { current: lifecycle }, requiresFeishuIdentityRef: { current: false },
      feishuConfirmation: { isPending: () => false }, logoutPendingRef: { current: false },
      impersonationPendingRef: { current: false }, activityRenewalRef: { current: null as Promise<void> | null },
      refreshPromise: { current: null }, refreshRequestLifecycle: { current: null },
      getAccessSession: jest.fn(async () => 'confirmed-session'),
    };
    const refresh = new Function(...Object.keys(refs), `${code}\nreturn refreshSession;`)(...Object.values(refs)) as (silent?: boolean) => Promise<unknown>;
    return { refs, lifecycle, refresh };
  }
  function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it('waits for renewal Set-Cookie before starting the status GET', async () => {
    const { refs, refresh } = fixture(), pending = deferred();
    refs.activityRenewalRef.current = pending.promise.finally(() => { refs.activityRenewalRef.current = null; });
    const read = refresh(true);
    expect(refs.getAccessSession).not.toHaveBeenCalled();
    pending.resolve();
    expect(await read).toBe('confirmed-session');
    expect(refs.getAccessSession).toHaveBeenCalledTimes(1);
  });

  it('keeps logout and aborted providers ahead of the renewal wait', async () => {
    const { refs, refresh, lifecycle } = fixture();
    refs.activityRenewalRef.current = new Promise(() => undefined);
    refs.logoutPendingRef.current = true;
    await refresh(true);
    refs.logoutPendingRef.current = false; lifecycle.abort();
    await refresh(true);
    expect(refs.getAccessSession).not.toHaveBeenCalled();
  });

  it('does not deadlock a non-awaited refresh requested inside renewal failure handling', async () => {
    const { refs, refresh } = fixture(), pending = deferred();
    let requestedRead: Promise<unknown> | undefined;
    const renewal = pending.promise.catch(() => { requestedRead = refresh(true); })
      .finally(() => { refs.activityRenewalRef.current = null; });
    refs.activityRenewalRef.current = renewal;
    pending.reject(new Error('lost-response'));
    await renewal;
    expect(await requestedRead).toBe('confirmed-session');
    expect(refs.getAccessSession).toHaveBeenCalledTimes(1);
  });

  it('also resumes after a rejected renewal without reviving a logged-out identity', async () => {
    const { refs, refresh } = fixture(), pending = deferred();
    refs.activityRenewalRef.current = pending.promise.finally(() => { refs.activityRenewalRef.current = null; });
    const read = refresh(true);
    refs.logoutPendingRef.current = true;
    pending.reject(new Error('offline'));
    await read;
    expect(refs.getAccessSession).not.toHaveBeenCalled();
  });
});
