import type { AccessSessionResponse } from '../../shared/access-control.interface';
import {
  createInventoryReadCache,
  inventoryReadScope,
} from '../../client/src/pages/InventoryManagement/inventory-read-cache';

describe('warehouse page read cache', () => {
  afterEach(() => jest.useRealTimers());

  it('shares pending and recent reads, then refreshes while retaining a warm snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-13T10:00:00Z'));
    const cache = createInventoryReadCache<string>();
    const load = jest.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('updated');
    const first = cache.read('session-a', load);
    expect(cache.read('session-a', load)).toBe(first);
    await expect(first).resolves.toBe('first');
    await expect(cache.read('session-a', load)).resolves.toBe('first');
    expect(load).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(16_000);
    const refresh = cache.read('session-a', load);
    expect(cache.peek('session-a')).toBe('first');
    await expect(refresh).resolves.toBe('updated');
    jest.advanceTimersByTime(5 * 60_000);
    expect(cache.peek('session-a')).toBeUndefined();
  });

  it('lets force and mutation invalidation supersede older reads without caching their results', async () => {
    const cache = createInventoryReadCache<string>();
    let finish!: (value: string) => void;
    const old = cache.read('session-a', () => new Promise((resolve) => { finish = resolve; }));
    const forceLoad = jest.fn().mockResolvedValue('forced');
    const forced = cache.read('session-a', forceLoad, true, true);
    expect(cache.read('session-a', async () => 'duplicate', true, true)).toBe(forced);
    await Promise.resolve();
    expect(forceLoad).not.toHaveBeenCalled();
    finish('outdated');
    await old;
    await expect(forced).resolves.toBe('forced');
    expect(cache.peek('session-a')).toBe('forced');

    const reading = cache.read('session-a', async () => 'before-write', true);
    cache.invalidate();
    await reading;
    expect(cache.peek('session-a')).toBeUndefined();
  });

  it('does not replace a good dashboard snapshot with a partial read', async () => {
    const cache = createInventoryReadCache<{ partial: boolean }>((result) => !result.partial);
    await cache.read('session-a', async () => ({ partial: false }));
    await expect(cache.read('session-a', async () => ({ partial: true }), true)).resolves.toEqual({ partial: true });
    expect(cache.peek('session-a')).toEqual({ partial: false });
  });

  it('preserves last good data on temporary failures and drops it on access denial', async () => {
    const cache = createInventoryReadCache<string>();
    await cache.read('session-a', async () => 'good');
    await expect(cache.read('session-a', async () => { throw new Error('offline'); }, true)).rejects.toThrow('offline');
    expect(cache.peek('session-a')).toBe('good');
    const denied = { response: { status: 403 } };
    await expect(cache.read('session-a', async () => { throw denied; }, true)).rejects.toBe(denied);
    expect(cache.peek('session-a')).toBeUndefined();
  });

  it('does not share cached data across sessions, permission revisions or unbound access', async () => {
    const session = {
      role: 'admin', purchaseBuilding: null, principalFingerprint: 'session-a',
      authorizationVersion: 1, pagePermissionsRevision: 1,
    } as AccessSessionResponse;
    const cache = createInventoryReadCache<string>();
    await cache.read(inventoryReadScope(session), async () => 'session-a value');
    expect(cache.peek(inventoryReadScope({ ...session, principalFingerprint: 'session-b' }))).toBeUndefined();
    expect(cache.peek(inventoryReadScope({ ...session, authorizationVersion: 2 }))).toBeUndefined();
    expect(cache.peek(inventoryReadScope({ ...session, pagePermissionsRevision: 2 }))).toBeUndefined();
    const unbound = inventoryReadScope({ ...session, principalFingerprint: null });
    await cache.read(unbound, async () => 'unbound value');
    expect(cache.peek(unbound)).toBeUndefined();
  });
});
