import { useCallback, useEffect, useRef, useState } from 'react';

export type LedgerCache = Map<string, { value: unknown; at: number }>;
export function useLedgerQuery<T>(
  cache: LedgerCache,
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const loader = useRef(load);
  loader.current = load;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error: string;
    loading: boolean;
  } | null>(null);
  const requestId = useRef(0);
  useEffect(() => {
    const id = ++requestId.current;
    if (!key) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
      setResult({ key, data: cached.value as T, error: '', loading: false });
      return;
    }
    const controller = new AbortController();
    setResult((previous) => ({
      key,
      data:
        (cached?.value as T | undefined) ??
        (previous?.key === key ? previous.data : undefined),
      error: '',
      loading: true,
    }));
    const timer = setTimeout(() => controller.abort(), 31000);
    loader
      .current(controller.signal)
      .then((data) => {
        if (requestId.current !== id || controller.signal.aborted) return;
        cache.set(key, { value: data, at: Date.now() });
        if (cache.size > 60) cache.delete(cache.keys().next().value!);
        setResult({ key, data, error: '', loading: false });
      })
      .catch((error: unknown) => {
        if (requestId.current !== id) return;
        const timeout =
          controller.signal.aborted ||
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            ['ECONNABORTED', 'ETIMEDOUT'].includes(String(error.code)));
        setResult((previous) => ({
          key,
          data:
            (cached?.value as T | undefined) ??
            (previous?.key === key ? previous.data : undefined),
          error: timeout ? '读取超时，请重试' : '数据读取失败，请重试',
          loading: false,
        }));
      })
      .finally(() => clearTimeout(timer));
    return () => {
      ++requestId.current;
      clearTimeout(timer);
      controller.abort();
    };
  }, [cache, key, revision]);
  const current = result?.key === key ? result : null;
  const cached = key ? cache.get(key) : null;
  const retry = useCallback(() => {
    if (key) cache.delete(key);
    setRevision((value) => value + 1);
  }, [cache, key]);
  return {
    data: current?.data ?? (cached?.value as T | undefined),
    error: current?.error || '',
    loading: Boolean(key) && (current?.loading ?? !cached),
    retry,
  };
}
