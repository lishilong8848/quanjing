import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAccess } from '@/access/AccessProvider';
import { createMonthlyQuery, type QueryRange } from './query-cache';

export function useMonthlyQuery<T>(
  query: ReturnType<typeof createMonthlyQuery<T>>,
  { start, end }: QueryRange,
) {
  const { role } = useAccess();
  const canForceRefresh = role !== 'guest';
  const read = useCallback(
    () => query.read({ start, end }),
    [query, start, end],
  );
  const subscribe = useCallback(
    (notify: () => void) => query.subscribe({ start, end }, notify),
    [query, start, end],
  );
  const state = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    void query.load({ start, end }, false, canForceRefresh);
  }, [query, start, end, canForceRefresh]);
  const retry = useCallback(() => {
    void query.load({ start, end }, true, canForceRefresh);
  }, [query, start, end, canForceRefresh]);
  return { ...state, retry };
}
