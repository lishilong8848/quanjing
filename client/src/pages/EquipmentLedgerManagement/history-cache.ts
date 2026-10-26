import type { EquipmentHistoryState } from '@shared/equipment-history.interface';
import type { LedgerCache } from './use-ledger-query';

export function historyCacheKey(assetId: string, snapshotId: string): string {
  return `history:${snapshotId}:${assetId}`;
}

export function cachedHistory(
  cache: LedgerCache | undefined,
  key: string,
  assetId: string,
  now = Date.now(),
): EquipmentHistoryState | null {
  const entry = cache?.get(key);
  if (!entry || now - entry.at >= 5 * 60 * 1000 || now < entry.at) return null;
  const value = entry.value as EquipmentHistoryState;
  return value?.assetId === assetId &&
    value.status === 'ready' &&
    !value.refreshing &&
    Array.isArray(value.items)
    ? value
    : null;
}
