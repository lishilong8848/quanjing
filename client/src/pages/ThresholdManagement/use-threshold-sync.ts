import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ThresholdMutationResult } from '@shared/threshold-management.interface';
import { getThresholdSync, retryThresholdSync, thresholdError } from './api';

export function useThresholdSync(initial?: ThresholdMutationResult[]) {
  const [jobs, setJobs] = useState<Record<string, ThresholdMutationResult>>({});
  const [error, setError] = useState('');
  const announced = useRef(new Set<string>());
  const retries = useRef(new Set<string>());
  const generation = useRef(0);
  const add = useCallback((result: ThresholdMutationResult) => {
    if (!result.sync || ['success', 'cancelled'].includes(result.sync.state))
      return;
    setJobs((current) => ({ ...current, [result.clientMutationId]: result }));
  }, []);
  useEffect(() => {
    if (initial?.length)
      setJobs((current) => {
        const next = { ...current };
        for (const job of initial)
          if (
            !next[job.clientMutationId] &&
            !announced.current.has(job.clientMutationId)
          )
            next[job.clientMutationId] = job;
        return next;
      });
  }, [initial]);
  const ids = Object.values(jobs)
    .filter((job) => job.sync && ['pending', 'error'].includes(job.sync.state))
    .sort(
      (a, b) =>
        Number(b.sync?.state === 'pending') -
        Number(a.sync?.state === 'pending'),
    )
    .map((job) => job.clientMutationId)
    .slice(0, 100)
    .sort()
    .join(',');
  useEffect(() => {
    if (!ids) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let interval = 1000;
    const poll = async () => {
      const started = generation.current;
      try {
        const results = await getThresholdSync(
          ids.split(','),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (started !== generation.current) return;
        failures = 0;
        interval = results.some((result) => result.sync?.state === 'pending')
          ? 1000
          : 5000;
        setError('');
        setJobs((current) => {
          const next = { ...current };
          for (const result of results) {
            if (
              !next[result.clientMutationId] ||
              (next[result.clientMutationId].sync?.attempts || 0) >
                (result.sync?.attempts || 0)
            )
              continue;
            if (
              result.sync &&
              ['success', 'cancelled'].includes(result.sync.state)
            )
              delete next[result.clientMutationId];
            else next[result.clientMutationId] = result;
          }
          return next;
        });
        for (const result of results)
          if (
            result.sync?.state !== 'pending' &&
            !announced.current.has(result.clientMutationId)
          ) {
            announced.current.add(result.clientMutationId);
            if (result.sync?.state === 'success')
              toast.success(
                result.operation === 'delete'
                  ? '阈值已删除并同步'
                  : '阈值已同步',
              );
            else if (result.sync?.state === 'cancelled')
              toast.message('已采用云端数据');
            else toast.error(result.sync?.error || '同步失败，请重试');
          }
      } catch (cause) {
        if (!controller.signal.aborted) {
          failures += 1;
          setError(thresholdError(cause));
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(
            () => void poll(),
            Math.min(interval * 2 ** failures, 10000),
          );
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [ids]);
  const retry = useCallback(
    async (id: string) => {
      if (retries.current.has(id)) return;
      retries.current.add(id);
      generation.current += 1;
      try {
        const result = await retryThresholdSync(id);
        announced.current.delete(id);
        add(result);
        setError('');
      } catch (cause) {
        setError(thresholdError(cause));
      } finally {
        retries.current.delete(id);
      }
    },
    [add],
  );
  const remove = useCallback((id: string) => {
    generation.current += 1;
    announced.current.add(id);
    setJobs((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  return { jobs: Object.values(jobs), error, add, retry, remove };
}
