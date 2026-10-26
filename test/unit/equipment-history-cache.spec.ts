import {
  cachedHistory,
  historyCacheKey,
} from '../../client/src/pages/EquipmentLedgerManagement/history-cache';
import type { LedgerCache } from '../../client/src/pages/EquipmentLedgerManagement/use-ledger-query';

describe('device history cache isolation', () => {
  const value = {
    assetId: 'a',
    status: 'ready',
    refreshing: false,
    items: [],
    stale: false,
    updatedAt: null,
    error: '',
  };
  it('reuses a ready result only for the same device, ledger snapshot and principal cache', () => {
    const cache: LedgerCache = new Map([
      [historyCacheKey('a', 'v1'), { value, at: 1000 }],
    ]);
    expect(cachedHistory(cache, historyCacheKey('a', 'v1'), 'a', 1001)).toEqual(
      value,
    );
    expect(
      cachedHistory(cache, historyCacheKey('a', 'v2'), 'a', 1001),
    ).toBeNull();
    expect(
      cachedHistory(cache, historyCacheKey('a', 'v1'), 'b', 1001),
    ).toBeNull();
    expect(
      cachedHistory(new Map(), historyCacheKey('a', 'v1'), 'a', 1001),
    ).toBeNull();
  });
  it('does not reuse expired, in-flight or failed history as a ready result', () => {
    const key = historyCacheKey('a', 'v1');
    const cache: LedgerCache = new Map([[key, { value, at: 1000 }]]);
    expect(cachedHistory(cache, key, 'a', 301000)).toBeNull();
    for (const changes of [
      { refreshing: true },
      { status: 'error' },
      { status: 'loading' },
    ]) {
      cache.set(key, { value: { ...value, ...changes }, at: 1000 });
      expect(cachedHistory(cache, key, 'a', 1001)).toBeNull();
    }
  });
});
