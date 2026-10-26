import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LedgerDashboard,
  LedgerDashboardState,
} from '@shared/equipment-ledger.interface';
import { getLedgerDashboardState } from './api';
import { useLedgerQuery, type LedgerCache } from './use-ledger-query';

const POLL_MS = 2000;
const MAX_WAIT_MS = 180000;

export interface LedgerReadTiming {
  pollMs?: number;
  maxWaitMs?: number;
}
export function useLedgerDashboard(
  cache: LedgerCache,
  timing: LedgerReadTiming = {},
  enabled = true,
) {
  const pollMs = timing.pollMs ?? POLL_MS;
  const maxWaitMs = timing.maxWaitMs ?? MAX_WAIT_MS;
  const force = useRef(false);
  const startedAt = useRef<number | null>(null);
  const lastGood = useRef<LedgerDashboard | undefined>(undefined);
  const [waitError, setWaitError] = useState('');
  const query = useLedgerQuery<LedgerDashboardState>(
    cache,
    enabled ? 'dashboard-state' : null,
    (signal) => getLedgerDashboardState(force.current, signal),
  );
  const state = query.data;
  const data = state?.dashboard || lastGood.current;
  useEffect(() => {
    if (state?.dashboard) lastGood.current = state.dashboard;
    if (
      !state ||
      query.loading ||
      query.error ||
      state.status === 'error' ||
      waitError
    )
      return;
    force.current = false;
    if (!state.refreshing && state.status === 'ready') {
      startedAt.current = null;
      return;
    }
    startedAt.current ??= Date.now();
    if (Date.now() - startedAt.current >= maxWaitMs) {
      setWaitError('设备台账更新超时，请重试');
      return;
    }
    const timer = setTimeout(query.retry, pollMs);
    return () => clearTimeout(timer);
  }, [
    state,
    query.loading,
    query.error,
    query.retry,
    waitError,
    pollMs,
    maxWaitMs,
  ]);
  const restart = useCallback(
    (refresh: boolean) => {
      force.current = refresh;
      startedAt.current = Date.now();
      setWaitError('');
      query.retry();
    },
    [query.retry],
  );
  const retry = useCallback(() => restart(true), [restart]);
  const reconcile = useCallback(() => restart(false), [restart]);
  const error = waitError || query.error || state?.error || '';
  const refreshing = !error && (query.loading || Boolean(state?.refreshing));
  return {
    data,
    error,
    refreshing,
    loading: refreshing && !data,
    retry,
    reconcile,
  };
}
