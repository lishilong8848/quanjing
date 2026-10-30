import { useCallback, useEffect, useRef, useState } from 'react';
import { getTodayAttendanceSnapshot, retryTodayAttendance } from '@/api';
import type { TodayAttendanceSnapshot, TodayAttendanceFinalTask } from '@shared/today-attendance.interface';

export type TodayAttendanceLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'stale'
  | 'error';

const RECOVERY_REFRESH_INTERVAL_MS = 15_000;
const APPROVED_LEAVE_REFRESH_INTERVAL_MS = 60_000;
export const MANUAL_SYNC_POLL_INTERVAL_MS = 2_000;
const MANUAL_SYNC_TIMEOUT_MS = 2 * 60_000;
const RECOVERABLE_SOURCE_STATUSES = new Set([
  'not-run',
  'running',
  'failed',
  'stale',
]);

export interface UseTodayAttendanceSnapshotResult {
  snapshot: TodayAttendanceSnapshot | null;
  state: TodayAttendanceLoadState;
  retry: () => void;
  manualSync: () => void;
  manualSyncState: 'idle' | 'submitting' | 'accepted' | 'pending' | 'success' | 'error';
  manualSyncError: string | null;
}

export function isAttendanceCoreSyncComplete(
  snapshot: TodayAttendanceSnapshot | null,
): boolean {
  return Boolean(
    snapshot &&
    ((snapshot.runStatus?.state === 'completed' &&
      snapshot.sourceStatus === 'fresh') ||
      (snapshot.sourceStatus === 'failed' &&
        snapshot.runStatus?.failureScope === 'personal-delivery' &&
        snapshot.summary.expected > 0)),
  );
}

export function isCurrentManualAttendanceResult(snapshot: TodayAttendanceSnapshot | null, executionId: string | null, date?: string, task?: TodayAttendanceFinalTask): boolean {
  if (!snapshot || !executionId || date && snapshot.date !== date) return false;
  if (task && snapshot.runStatus?.task !== task) return false;
  // Display timestamps are minute-precision strings. Only the actual execution
  // identity can distinguish cached results and a joined or fast new run.
  return snapshot.runStatus?.executionId === executionId;
}

export function useTodayAttendanceSnapshot(enabled = true): UseTodayAttendanceSnapshotResult {
  const [snapshot, setSnapshot] = useState<TodayAttendanceSnapshot | null>(
    null,
  );
  const [state, setState] = useState<TodayAttendanceLoadState>('idle');
  const [requestToken, setRequestToken] = useState(0);
  const requestIdRef = useRef(0);
  const requestActiveRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const snapshotPhaseRef = useRef('');
  const lastRequestAtRef = useRef(0);
  const [refreshFailures, setRefreshFailures] = useState(0);
  const forceRefreshRequestRef = useRef(false);
  const phaseRefreshRequestRef = useRef(false);
  const manualMutationIdRef = useRef<string | null>(null);
  const manualExecutionIdRef = useRef<string | null>(null);
  const manualSyncStartedAtRef = useRef(0);
  const manualSyncDateRef = useRef<string | undefined>(undefined);
  const manualSyncTaskRef = useRef<TodayAttendanceFinalTask | undefined>(undefined);
  const [manualSyncState, setManualSyncState] =
    useState<UseTodayAttendanceSnapshotResult['manualSyncState']>('idle');
  const [manualSyncError, setManualSyncError] = useState<string | null>(null);

  const triggerRefresh = useCallback((forceRefresh: boolean) => {
    if (!enabled) return;
    if (forceRefresh) forceRefreshRequestRef.current = true;
    if (requestActiveRef.current) return;
    requestActiveRef.current = true;
    setSnapshot((current) => {
      if (
        current?.sourceStatus !== 'pending' ||
        Date.now() < Date.parse(`${current.date}T09:30:00+08:00`)
      )
        return current;
      return {
        ...current,
        sourceStatus: 'not-run',
        runStatus: { state: 'not-run', scheduledAt: `${current.date} 09:30` },
      };
    });
    setRequestToken((current) => current + 1);
  }, [enabled]);

  const retry = useCallback(() => {
    setRefreshFailures(0);
    triggerRefresh(false);
  }, [enabled, triggerRefresh]);

  const manualSync = useCallback(() => {
    if (!enabled || manualMutationIdRef.current) return;
    const clientMutationId = crypto.randomUUID();
    manualMutationIdRef.current = clientMutationId;
    manualExecutionIdRef.current = null;
    manualSyncStartedAtRef.current = Date.now();
    manualSyncDateRef.current = snapshotRef.current?.date;
    manualSyncTaskRef.current = snapshotRef.current?.runStatus?.scheduledAt.slice(-5) === '18:35' ? 'evening-off-duty-check' : 'morning-off-duty-check';
    setManualSyncError(null);
    setManualSyncState('submitting');
    void retryTodayAttendance({ clientMutationId })
      .then((response) => {
        if (manualMutationIdRef.current !== clientMutationId) return;
        manualSyncDateRef.current = response.date;
        manualSyncTaskRef.current = response.task;
        const executionId = typeof response.executionId === 'string' && response.executionId.trim() && response.executionId.length <= 200
          ? response.executionId : null;
        manualExecutionIdRef.current = executionId;
        setSnapshot((current) => {
          if (!current || response.state === 'completed') return current;
          return {
            ...current,
            sourceStatus: 'running',
            runStatus: {
              state: 'running',
              task: response.task,
              ...(executionId ? { executionId } : {}),
              scheduledAt: `${response.date} ${
                response.task === 'evening-off-duty-check' ? '18:35' : '09:30'
              }`,
              firstAttemptAt: current.runStatus?.firstAttemptAt,
              lastAttemptAt: current.runStatus?.lastAttemptAt,
              attemptCount: 1,
              maxAttempts: 1,
            },
          };
        });
        // A response can join an older active execution. Wait for a snapshot
        // carrying its returned identity, never compare browser/server clocks.
        setManualSyncState(executionId ? 'accepted' : 'pending');
        triggerRefresh(true);
      })
      .catch((error) => {
        if (manualMutationIdRef.current !== clientMutationId) return;
        manualMutationIdRef.current = null;
        manualExecutionIdRef.current = null;
        setManualSyncError(manualAttendanceSyncErrorMessage(error));
        setManualSyncState('error');
      });
  }, [enabled, triggerRefresh]);

  useEffect(() => {
    if (!enabled) { setSnapshot(null); setState('idle'); manualMutationIdRef.current = null; manualExecutionIdRef.current = null; setManualSyncState('idle'); setManualSyncError(null); return; }
    const requestId = ++requestIdRef.current;
    requestActiveRef.current = true;
    lastRequestAtRef.current = Date.now();
    const phase = attendanceRefreshPhase(new Date());
    const retained = snapshotRef.current && snapshotPhaseRef.current === phase;
    if (!retained) setSnapshot(null);
    const forceRefresh = forceRefreshRequestRef.current;
    forceRefreshRequestRef.current = false;
    setState(retained ? 'refreshing' : 'loading');
    void getTodayAttendanceSnapshot(forceRefresh)
      .then((nextSnapshot) => {
        if (requestId !== requestIdRef.current) return;
        if (phase !== attendanceRefreshPhase(new Date())) {
          phaseRefreshRequestRef.current = true;
          return;
        }
        snapshotPhaseRef.current = phase;
        setSnapshot(nextSnapshot);
        setRefreshFailures(0);
        setState('ready');
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        if (phase !== attendanceRefreshPhase(new Date())) {
          phaseRefreshRequestRef.current = true;
          return;
        }
        setRefreshFailures((count) => count + 1);
        setState(retained ? 'stale' : 'error');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        requestActiveRef.current = false;
        // A manual sync or a day/shift boundary may require one newer read.
        if (forceRefreshRequestRef.current || phaseRefreshRequestRef.current) {
          phaseRefreshRequestRef.current = false;
          triggerRefresh(forceRefreshRequestRef.current);
        }
      });
    return () => {
      requestIdRef.current += 1;
      requestActiveRef.current = false;
    };
  }, [enabled, requestToken, triggerRefresh]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const scheduleNextRefresh = () => {
      const delay = getNextFinalAttendanceRefreshDelay(new Date());
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') {
          setRefreshFailures(0);
          triggerRefresh(false);
        }
        scheduleNextRefresh();
      }, delay);
    };
    scheduleNextRefresh();
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      if (
        snapshotPhaseRef.current !== attendanceRefreshPhase(new Date()) ||
        Date.now() - lastRequestAtRef.current >=
          APPROVED_LEAVE_REFRESH_INTERVAL_MS
      )
        retry();
      scheduleNextRefresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, retry, triggerRefresh]);

  useEffect(() => {
    if (!enabled) return;
    const isTerminalFailure =
      snapshot?.sourceStatus === 'failed' &&
      snapshot.runStatus?.finalFailure === true;
    if (
      state === 'loading' ||
      state === 'refreshing' ||
      manualSyncState === 'accepted' || manualSyncState === 'pending'
    ) {
      return;
    }
    const delay =
      refreshFailures > 0
        ? Math.min(
            5 * 60_000,
            APPROVED_LEAVE_REFRESH_INTERVAL_MS * 2 ** (refreshFailures - 1),
          )
        : !isTerminalFailure &&
            snapshot &&
            RECOVERABLE_SOURCE_STATUSES.has(snapshot.sourceStatus)
          ? RECOVERY_REFRESH_INTERVAL_MS
          : snapshot?.sourceStatus === 'fresh' && snapshot.entries.length > 0
            ? APPROVED_LEAVE_REFRESH_INTERVAL_MS
            : null;
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible') triggerRefresh(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [enabled, snapshot, state, refreshFailures, manualSyncState, triggerRefresh]);

  useEffect(() => {
    if (!enabled || !['accepted', 'pending'].includes(manualSyncState)) return;
    const belongsToManualRun = isCurrentManualAttendanceResult(snapshot, manualExecutionIdRef.current, manualSyncDateRef.current, manualSyncTaskRef.current);
    if (belongsToManualRun && isAttendanceCoreSyncComplete(snapshot)) {
      manualMutationIdRef.current = null;
      setManualSyncError(null);
      setManualSyncState('success');
      return;
    }
    if (
      belongsToManualRun && snapshot?.sourceStatus === 'failed' &&
      snapshot.runStatus?.state === 'failed' &&
      snapshot.runStatus.failureScope !== 'personal-delivery'
    ) {
      manualMutationIdRef.current = null;
      setManualSyncError(
        snapshot.runStatus.failureReason || '手动同步失败，请稍后重试',
      );
      setManualSyncState('error');
      return;
    }
    const timer = window.setTimeout(
      () => triggerRefresh(manualSyncState === 'accepted'),
      manualSyncState === 'pending' ? RECOVERY_REFRESH_INTERVAL_MS : MANUAL_SYNC_POLL_INTERVAL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [enabled, manualSyncState, snapshot, state, refreshFailures, triggerRefresh]);

  useEffect(() => {
    if (!enabled || manualSyncState !== 'accepted') return;
    const timer = window.setTimeout(() => {
      // The waiting budget is independent of a slow GET. Keep the original
      // mutation locked and continue observing; this is not a failed sync.
      setManualSyncError(null);
      setManualSyncState('pending');
    }, Math.max(0, MANUAL_SYNC_TIMEOUT_MS - (Date.now() - manualSyncStartedAtRef.current)));
    return () => window.clearTimeout(timer);
  }, [enabled, manualSyncState]);

  return {
    snapshot: enabled ? snapshot : null,
    state: enabled ? state : 'idle',
    retry,
    manualSync,
    manualSyncState,
    manualSyncError,
  };
}

function attendanceRefreshPhase(now: Date): string {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const minute = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  return `${shanghai.toISOString().slice(0, 10)}:${minute < 570 ? 'previous-day' : minute < 1115 ? 'morning' : 'evening'}`;
}

export function getNextFinalAttendanceRefreshDelay(now: Date): number {
  const candidates = [
    shanghaiBoundary(now, 9, 30),
    shanghaiBoundary(now, 18, 35),
    shanghaiBoundary(new Date(now.getTime() + 24 * 60 * 60 * 1000), 0, 0),
  ];
  return Math.max(
    1_000,
    candidates
      .find((candidate) => candidate.getTime() > now.getTime())!
      .getTime() - now.getTime(),
  );
}

function shanghaiBoundary(source: Date, hour: number, minute: number): Date {
  const value = new Date(source.getTime() + 8 * 60 * 60 * 1000);
  value.setUTCHours(hour, minute, 0, 0);
  return new Date(value.getTime() - 8 * 60 * 60 * 1000);
}

function manualAttendanceSyncErrorMessage(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: unknown } })
    ?.response;
  if (response?.status === 401 || response?.status === 403) {
    return '请使用管理员账号登录后再手动同步';
  }
  const data = response?.data;
  const message =
    typeof data === 'string'
      ? data
      : data && typeof data === 'object'
        ? (data as { message?: unknown }).message
        : null;
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : '手动同步请求失败，请稍后重试';
}
