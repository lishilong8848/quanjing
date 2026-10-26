import { useCallback, useEffect, useRef, useState } from 'react';
import { getPersonnelTimeInsights } from '@/api/personnel-time-insights';
import type { PersonnelTimeInsightsResponse } from '@shared/personnel-time-insights.interface';
import type { PersonnelTimeInsightsRange } from './personnel-time-insights-presentation';

export type PersonnelTimeInsightsLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

interface CacheEntry {
  expiresAt: number;
  value: PersonnelTimeInsightsResponse;
}

const CACHE_TTL_MS = 5 * 60 * 1_000;
const cache = new Map<string, CacheEntry>();
const active = new Map<string, Promise<PersonnelTimeInsightsResponse>>();

function rangeKey(range: PersonnelTimeInsightsRange): string {
  return `${range.from}:${range.through}`;
}

function loadPersonnelTimeInsights(
  range: PersonnelTimeInsightsRange,
): Promise<PersonnelTimeInsightsResponse> {
  const key = rangeKey(range);
  const current = active.get(key);
  if (current) return current;
  let request!: Promise<PersonnelTimeInsightsResponse>;
  request = getPersonnelTimeInsights(range.from, range.through)
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    })
    .finally(() => {
      if (active.get(key) === request) active.delete(key);
    });
  active.set(key, request);
  return request;
}

export function prefetchPersonnelTimeInsights(
  range: PersonnelTimeInsightsRange,
) {
  const cached = cache.get(rangeKey(range));
  if (cached && cached.expiresAt > Date.now())
    return Promise.resolve(cached.value);
  return loadPersonnelTimeInsights(range);
}

export function usePersonnelTimeInsights() {
  const [data, setData] = useState<PersonnelTimeInsightsResponse | null>(null);
  const [state, setState] = useState<PersonnelTimeInsightsLoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const query = useCallback(
    async (range: PersonnelTimeInsightsRange, forceRefresh = false) => {
      const requestId = ++requestIdRef.current;
      const key = rangeKey(range);
      const cached = cache.get(key);
      setData(cached?.value ?? null);
      if (cached) {
        setData(cached.value);
        setError(null);
      }
      if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
        setState('ready');
        return;
      }
      setState('loading');
      setError(null);
      try {
        const value = await loadPersonnelTimeInsights(range);
        if (requestId !== requestIdRef.current) return;
        setData(value);
        setState('ready');
      } catch (caught) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setError(getErrorMessage(caught));
        setState('error');
      }
    },
    [],
  );

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  return { data, state, error, query };
}

function getErrorMessage(error: unknown): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  const message =
    typeof data === 'string'
      ? data
      : data && typeof data === 'object'
        ? (data as { message?: unknown }).message
        : null;
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : '人员工时与休假统计加载失败，请稍后重试';
}
