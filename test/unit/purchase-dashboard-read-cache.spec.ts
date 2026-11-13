import type { PurchaseInventoryResponse } from '../../shared/purchase-inventory.interface';
import { createPurchaseDashboardReadCache } from '../../client/src/pages/PurchaseInventoryManagement/purchase-dashboard-read-cache';

function dashboard(generatedAt: string, refreshState: PurchaseInventoryResponse['refreshState'] = 'fresh') {
  return { generatedAt, refreshState } as PurchaseInventoryResponse;
}

function pendingDashboard() {
  let resolve!: (value: PurchaseInventoryResponse) => void;
  const promise = new Promise<PurchaseInventoryResponse>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('purchase dashboard revisit cache', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(1_000); });
  afterEach(() => { jest.useRealTimers(); });

  it('reuses a prior response and in-flight read across route mounts in the same session', async () => {
    const pending = pendingDashboard();
    const read = jest.fn(() => pending.promise);
    const scopeFor = createPurchaseDashboardReadCache(read);
    const scope = scopeFor.activate('scope-a:session-1')!;
    const first = scope.read(false);
    expect(scopeFor.activate('scope-a:session-1')!.read(false)).toBe(first);
    jest.setSystemTime(16_000);
    expect(scope.shouldRefresh(15_000)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    const snapshot = dashboard('first');
    pending.resolve(snapshot);
    await first;
    expect(scopeFor.recentSnapshot('scope-a:session-1')).toBe(snapshot);
    expect(scope.shouldRefresh(15_000)).toBe(true);
    jest.setSystemTime(316_000);
    expect(scope.recentSnapshot()).toBeNull();
  });

  it('clears data across session boundaries and rejects late cache fills from the old identity', async () => {
    const pending = pendingDashboard();
    const read = jest.fn()
      .mockResolvedValueOnce(dashboard('original'))
      .mockReturnValueOnce(pending.promise);
    const scopeFor = createPurchaseDashboardReadCache(read);
    const first = scopeFor.activate('scope-a:session-1')!;
    await first.read(false);
    const late = first.read('active');
    expect(scopeFor.recentSnapshot('scope-a:session-2')).toBeNull();
    expect(scopeFor.recentSnapshot('scope-a:session-1')).toBeTruthy();
    expect(scopeFor.activate(null)).toBeUndefined();
    const next = scopeFor.activate('scope-a:session-2')!;
    pending.resolve(dashboard('late'));
    await late;
    expect(first.recentSnapshot()).toBeNull();
    expect(next.recentSnapshot()).toBeNull();
    expect(scopeFor.activate('scope-a:session-1')!.recentSnapshot()).toBeNull();
  });

  it('keeps the last successful response when the next synchronization is incomplete', async () => {
    const snapshot = dashboard('original');
    const incomplete = dashboard('incomplete', 'partial');
    const read = jest.fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(incomplete)
      .mockRejectedValueOnce(new Error('network unavailable'));
    const scope = createPurchaseDashboardReadCache(read).activate('scope-a:session-1')!;
    await scope.read(false);
    await expect(scope.read('active')).resolves.toBe(incomplete);
    await expect(scope.read('active')).rejects.toThrow('network unavailable');
    expect(scope.recentSnapshot()).toBe(snapshot);
  });

  it('starts a new mutation read and prevents a pre-write response from restoring the cache', async () => {
    const old = pendingDashboard();
    const updated = pendingDashboard();
    const read = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(updated.promise);
    const scope = createPurchaseDashboardReadCache(read).activate('scope-a:session-1')!;
    const inFlight = scope.read('active');
    scope.invalidate();
    const afterMutation = scope.read('active');
    expect(afterMutation).not.toBe(inFlight);
    const current = dashboard('after mutation');
    updated.resolve(current);
    await afterMutation;
    old.resolve(dashboard('before mutation'));
    await inFlight;
    expect(read).toHaveBeenCalledTimes(2);
    expect(scope.recentSnapshot()).toBe(current);
  });
});
