import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyThresholdOverlay,
  mergeThresholdReceipt,
  type ThresholdCommand,
  type ThresholdMutationResult,
  type ThresholdOverlay,
  type ThresholdRecord,
  type ThresholdSnapshot,
} from '@shared/threshold-management.interface';
import {
  getThresholds,
  isUncertainThresholdError,
  mutateThreshold,
  thresholdError,
  getThresholdSource,
  acceptThresholdCloud,
} from './api';
import { useThresholdSync } from './use-threshold-sync';

const cache = new Map<string, ThresholdSnapshot>();
export function useThresholds(identity: string) {
  const [snapshot, setSnapshot] = useState<ThresholdSnapshot | null>(
    () => cache.get(identity) || null,
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    snapshot ? 'ready' : 'loading',
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [overlay, setOverlay] = useState<ThresholdOverlay>({});
  const sync = useThresholdSync(snapshot?.syncResults);
  const busy = useRef(new Set<string>());
  const epoch = useRef(0);
  const query = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(
    async (force = false) => {
      if (busy.current.size) return;
      query.current?.abort();
      const controller = new AbortController();
      query.current = controller;
      const started = epoch.current;
      setRefreshing(true);
      setError('');
      try {
        const next = await getThresholds(controller.signal, force);
        if (
          controller.signal.aborted ||
          started !== epoch.current ||
          !mounted.current
        )
          return;
        cache.set(identity, next);
        setSnapshot(next);
        setStatus('ready');
        setSourceError(next.sourceSync?.error || '');
      } catch (cause) {
        if (!controller.signal.aborted && mounted.current) {
          setError(thresholdError(cause));
          setStatus('error');
        }
      } finally {
        if (query.current === controller && mounted.current)
          setRefreshing(false);
      }
    },
    [identity],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      query.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (!snapshot?.sourceSync) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await getThresholdSource(controller.signal);
        if (controller.signal.aborted) return;
        setSourceError(next.sourceSync.error || '');
        if (
          next.sourceSync.state === 'ready' &&
          !busy.current.size &&
          next.revision > (cache.get(identity)?.revision || 0)
        )
          await refresh();
        else if (next.sourceSync.state !== snapshot.sourceSync?.state) {
          const previous = cache.get(identity);
          if (previous) {
            const updated = { ...previous, sourceSync: next.sourceSync };
            cache.set(identity, updated);
            setSnapshot(updated);
          }
        }
        if (!controller.signal.aborted)
          timer = setTimeout(
            () => void check(),
            next.sourceSync.state === 'loading' ? 1000 : 60000,
          );
      } catch (cause) {
        if (!controller.signal.aborted) {
          setSourceError(thresholdError(cause));
          timer = setTimeout(() => void check(), 10000);
        }
      }
    };
    timer = setTimeout(
      () => void check(),
      snapshot.sourceSync.state === 'loading' ? 500 : 60000,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [identity, snapshot?.sourceSync?.state, refresh]);
  const submit = useCallback(
    async (
      command: ThresholdCommand,
      optimistic: ThresholdRecord | null,
      key: string,
    ): Promise<ThresholdMutationResult> => {
      if (busy.current.has(key)) throw new Error('该阈值正在同步');
      busy.current.add(key);
      epoch.current += 1;
      setOverlay((current) => ({
        ...current,
        [key]: { record: optimistic, mutationId: command.clientMutationId },
      }));
      try {
        const result = await mutateThreshold(command);
        const previous = cache.get(identity) || {
          records: [],
          revision: 0,
          updatedAt: '',
        };
        const next = mergeThresholdReceipt(
          previous,
          result,
          key,
          command.expectedVersion,
        );
        cache.set(identity, next);
        if (mounted.current) setSnapshot(next);
        sync.add(result);
        return result;
      } catch (cause) {
        throw {
          message: thresholdError(cause),
          uncertain: isUncertainThresholdError(cause),
        };
      } finally {
        busy.current.delete(key);
        if (mounted.current)
          setOverlay((current) => {
            if (current[key]?.mutationId !== command.clientMutationId)
              return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
      }
    },
    [identity, sync.add],
  );
  const records = useMemo(
    () => applyThresholdOverlay(snapshot?.records || [], overlay),
    [snapshot, overlay],
  );
  const acceptCloud = useCallback(
    async (job: ThresholdMutationResult) => {
      if (busy.current.has(job.id)) return;
      busy.current.add(job.id);
      epoch.current += 1;
      try {
        const result = await acceptThresholdCloud(job.clientMutationId);
        const previous = cache.get(identity);
        if (previous) {
          const records = previous.records.filter(
            (record) => record.id !== result.id,
          );
          if (result.record) records.unshift(result.record);
          const next = {
            ...previous,
            records,
            revision: Math.max(previous.revision, result.revision),
            updatedAt: result.updatedAt,
          };
          cache.set(identity, next);
          if (mounted.current) setSnapshot(next);
        }
        sync.remove(job.clientMutationId);
      } catch (cause) {
        if (mounted.current) setSourceError(thresholdError(cause));
      } finally {
        busy.current.delete(job.id);
      }
    },
    [identity, sync.remove],
  );
  const acceptAdjustment = useCallback(
    (record: ThresholdRecord) => {
      const previous = cache.get(identity);
      if (!previous) return;
      const current = previous.records.find((r) => r.id === record.id);
      if (current && current.version > record.version) return;
      epoch.current += 1;
      const next = {
        ...previous,
        records: previous.records.map((r) => (r.id === record.id ? record : r)),
        updatedAt:
          record.updatedAt > previous.updatedAt
            ? record.updatedAt
            : previous.updatedAt,
      };
      cache.set(identity, next);
      if (mounted.current) setSnapshot(next);
    },
    [identity],
  );
  return {
    records,
    status,
    refreshing,
    error,
    snapshot,
    overlay,
    submit,
    refresh,
    syncJobs: sync.jobs,
    syncError: sync.error,
    retrySync: sync.retry,
    sourceError,
    acceptCloud,
    acceptAdjustment,
  };
}
