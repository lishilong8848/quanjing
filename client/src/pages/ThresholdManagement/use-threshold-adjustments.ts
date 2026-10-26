import { useCallback, useEffect, useRef, useState } from 'react';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  ThresholdAdjustment,
  ThresholdAdjustmentContext,
  ThresholdAdjustmentInput,
} from '@shared/threshold-adjustment.interface';
import type { ThresholdRecord } from '@shared/threshold-management.interface';
import { thresholdError } from './api';

export function useThresholdAdjustments(
  identity: string,
  onApplied: (record: ThresholdRecord) => void,
  enabled = true,
) {
  const [context, setContext] = useState<ThresholdAdjustmentContext>({
    engineers: [],
    roles: [],
  });
  const [records, setRecords] = useState<ThresholdAdjustment[]>([]);
  const [error, setError] = useState('');
  const applied = useRef(new Map<string, number>());
  const epoch = useRef(0);
  const mounted = useRef(true);
  const merge = useCallback(
    (values: ThresholdAdjustment[]) => {
      setRecords((previous) => {
        const next = new Map(previous.map((a) => [a.id, a]));
        for (const value of values)
          if (
            !next.has(value.id) ||
            next.get(value.id)!.revision <= value.revision
          )
            next.set(value.id, value);
        return [...next.values()].sort((a, b) =>
          b.submittedAt.localeCompare(a.submittedAt),
        );
      });
      for (const a of values)
        if (
          a.state === 'completed' &&
          a.appliedRecord &&
          (applied.current.get(a.id) || 0) < a.appliedRecord.version
        ) {
          applied.current.set(a.id, a.appliedRecord.version);
          onApplied(a.appliedRecord);
        }
    },
    [onApplied],
  );
  const refreshContext = useCallback(async () => {
    const started = epoch.current;
    try {
      const { data } = await axiosForBackend({
        url: '/api/threshold-management/adjustments/context',
        method: 'GET',
        timeout: 10000,
      });
      if (mounted.current && started === epoch.current) setContext(data);
    } catch (cause) {
      if (mounted.current && started === epoch.current)
        setContext({ engineers: [], roles: [], error: thresholdError(cause) });
    }
  }, []);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const started = epoch.current;
      try {
        const { data } = await axiosForBackend({
          url: '/api/threshold-management/adjustments',
          method: 'GET',
          signal,
          timeout: 10000,
        });
        if (!Array.isArray(data)) throw new Error('调整记录返回异常');
        if (!signal?.aborted && mounted.current && started === epoch.current) {
          merge(data);
          setError('');
        }
      } catch (cause) {
        if (!signal?.aborted && mounted.current && started === epoch.current)
          setError(thresholdError(cause));
      }
    },
    [merge],
  );
  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    epoch.current++;
    setRecords([]);
    setContext({ engineers: [], roles: [] });
    setError('');
    applied.current.clear();
    const controller = new AbortController();
    void refresh(controller.signal);
    void refreshContext();
    const timer = setInterval(() => {
      void refresh(controller.signal);
      void refreshContext();
    }, 30000);
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [identity, refresh, refreshContext, enabled]);
  useEffect(() => {
    if (
      !records.some(
        (a) =>
          a.syncState !== 'success' ||
          [
            'routing',
            'pending',
            'approved',
            'awaiting_completion',
            'confirmed',
            'applying',
          ].includes(a.state),
      )
    )
      return;
    const controller = new AbortController(),
      timer = setInterval(() => void refresh(controller.signal), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [records, refresh]);
  const submit = useCallback(
    async (input: ThresholdAdjustmentInput) => {
      const started = ++epoch.current;
      const { data } = await axiosForBackend({
        url: '/api/threshold-management/adjustments',
        method: 'POST',
        data: input,
        timeout: 10000,
      });
      if (
        !data?.id ||
        data.clientMutationId !== input.clientMutationId ||
        data.before?.id !== input.thresholdId ||
        data.value !== input.value
      )
        throw new Error('申请受理结果未确认，请核对后重试');
      if (mounted.current && started === epoch.current) merge([data]);
      return data as ThresholdAdjustment;
    },
    [merge],
  );
  const retry = useCallback(
    async (id: string) => {
      const started = ++epoch.current;
      try {
        const { data } = await axiosForBackend({
          url: '/api/threshold-management/adjustments/retry',
          method: 'POST',
          data: { id },
          timeout: 10000,
        });
        if (mounted.current && started === epoch.current) merge([data]);
      } catch (cause) {
        if (mounted.current && started === epoch.current)
          setError(thresholdError(cause));
      }
    },
    [merge],
  );
  return { context, records, error, submit, retry, refreshContext };
}
