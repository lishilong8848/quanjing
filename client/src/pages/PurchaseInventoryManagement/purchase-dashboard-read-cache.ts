import type { PurchaseInventoryResponse } from '@shared/purchase-inventory.interface';

export type DashboardRefreshMode = boolean | 'active';
type ReadDashboard = (mode: DashboardRefreshMode) => Promise<PurchaseInventoryResponse>;

const REVISIT_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

export function createPurchaseDashboardReadCache(readDashboard: ReadDashboard) {
  let active: {
    identity: string;
    scope: ReturnType<typeof createScope>;
  } | undefined;

  function createScope() {
    let latestRequestAt = -Infinity;
    let requestSequence = 0;
    let snapshot: { response: PurchaseInventoryResponse; receivedAt: number } | undefined;
    const requests = new Map<DashboardRefreshMode, Promise<PurchaseInventoryResponse>>();

    const scope = {
      recentSnapshot() {
        return snapshot && Date.now() - snapshot.receivedAt < REVISIT_SNAPSHOT_MAX_AGE_MS
          ? snapshot.response
          : null;
      },
      shouldRefresh(interval: number) {
        return requests.size === 0 && Date.now() - latestRequestAt >= interval;
      },
      invalidate() {
        snapshot = undefined;
        latestRequestAt = -Infinity;
        requestSequence += 1;
        requests.clear();
      },
      read(mode: DashboardRefreshMode) {
        const existing = requests.get(mode) ??
          (mode === false ? requests.get(true) ?? requests.get('active') : undefined);
        if (existing) return existing;

        const sequence = ++requestSequence;
        latestRequestAt = Date.now();
        const request = readDashboard(mode).then((response) => {
          if (sequence === requestSequence && active?.scope === scope &&
              response.refreshState !== 'partial' && response.refreshState !== 'stale') {
            snapshot = { response, receivedAt: Date.now() };
          }
          return response;
        }).finally(() => {
          if (requests.get(mode) === request) requests.delete(mode);
        });
        requests.set(mode, request);
        return request;
      },
    };
    return scope;
  }

  return {
    recentSnapshot(identity: string | null) {
      return identity && active?.identity === identity ? active.scope.recentSnapshot() : null;
    },
    activate(identity: string | null) {
      if (identity && active?.identity === identity) return active.scope;
      active?.scope.invalidate();
      active = identity ? { identity, scope: createScope() } : undefined;
      return active?.scope;
    },
  };
}
