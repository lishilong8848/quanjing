import { useCallback, useEffect, useRef, useState } from 'react';
import { startDutyLocalSyncTask, getCurrentDutyLocalSyncTask, getDutyLocalSyncTask } from '@/api';
import { createLocalScheduleSyncController, EMPTY_LOCAL_SYNC_STATE, type LocalSyncPorts, type LocalSyncState } from './local-schedule-sync';

export function useLocalScheduleSync(principal: string | null, enabled: boolean, refresh: LocalSyncPorts['refresh']) {
  const latestRefresh = useRef(refresh); latestRefresh.current = refresh;
  const identity = useRef({ principal, enabled }); identity.current = { principal, enabled };
  const runtime = useRef<ReturnType<typeof createLocalScheduleSyncController> | null>(null);
  const [view, setView] = useState<{ principal: string | null; state: LocalSyncState }>({ principal, state: EMPTY_LOCAL_SYNC_STATE });
  useEffect(() => {
    setView({ principal, state: EMPTY_LOCAL_SYNC_STATE });
    if (!principal || !enabled) return;
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch { /* The action explains unavailable recovery storage before submitting. */ }
    const controller = createLocalScheduleSyncController({ principal, storage, createId: () => crypto.randomUUID(),
      create: startDutyLocalSyncTask, current: getCurrentDutyLocalSyncTask, get: getDutyLocalSyncTask,
      refresh: (invalidate, signal) => identity.current.principal === principal && identity.current.enabled && !signal.aborted
        ? latestRefresh.current(invalidate, signal) : Promise.resolve({ schedules: false, sealings: false, cancelled: true }),
      hidden: () => document.visibilityState === 'hidden', changed: state => { if (identity.current.principal === principal && identity.current.enabled) setView({ principal, state }); } });
    runtime.current = controller;
    void controller.resume();
    const visible = () => { if (document.visibilityState === 'visible') void controller.check(); };
    document.addEventListener('visibilitychange', visible);
    return () => { document.removeEventListener('visibilitychange', visible); controller.dispose(); if (runtime.current === controller) runtime.current = null; };
  }, [principal, enabled]);
  return {
    state: enabled && view.principal === principal ? view.state : EMPTY_LOCAL_SYNC_STATE,
    trigger: useCallback(() => runtime.current?.trigger(), []),
    check: useCallback(() => runtime.current?.check(), []),
    refreshView: useCallback(() => runtime.current?.refreshView(), []),
  };
}
