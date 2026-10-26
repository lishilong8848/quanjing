import { useCallback, useEffect, useRef, useState } from 'react';
import { getAttendanceHistory } from '@/api/attendance-history';
import type { AttendanceHistoryResponse } from '@shared/attendance-history.interface';

export type AttendanceHistoryLoadState = 'idle' | 'loading' | 'ready' | 'error';

interface AttendanceHistoryRange {
  from: string;
  through: string;
}

interface AttendanceHistoryCacheEntry {
  expiresAt: number;
  value: AttendanceHistoryResponse;
}

const CACHE_TTL_MS = 2 * 60 * 1_000;
const cache = new Map<string, AttendanceHistoryCacheEntry>();
const active = new Map<string, Promise<AttendanceHistoryResponse>>();

function rangeKey(range: AttendanceHistoryRange): string {
  return `${range.from}:${range.through}`;
}

function loadAttendanceHistory(
  range: AttendanceHistoryRange,
  forceRefresh: boolean,
): Promise<AttendanceHistoryResponse> {
  const key = rangeKey(range);
  const activeKey = `${key}:${forceRefresh ? 'refresh' : 'cached'}`;
  const current = active.get(activeKey);
  if (current) return current;
  let request!: Promise<AttendanceHistoryResponse>;
  request = getAttendanceHistory(range.from, range.through, {
    refresh: forceRefresh,
  })
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    })
    .finally(() => {
      if (active.get(activeKey) === request) active.delete(activeKey);
    });
  active.set(activeKey, request);
  return request;
}

export function prefetchAttendanceHistory(
  range: AttendanceHistoryRange,
): Promise<AttendanceHistoryResponse> {
  const cached = cache.get(rangeKey(range));
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.value);
  }
  return loadAttendanceHistory(range, false);
}

export function useAttendanceHistory() {
  const [data, setData] = useState<AttendanceHistoryResponse | null>(null);
  const [state, setState] = useState<AttendanceHistoryLoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const query = useCallback(
    async (range: AttendanceHistoryRange, forceRefresh = false) => {
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
        // Shared prefetches survive closing a consumer; version checks isolate results.
        const value = await loadAttendanceHistory(range, forceRefresh);
        if (requestId !== requestIdRef.current) return;
        setData(value);
        setState('ready');
      } catch (caught) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setError(attendanceHistoryErrorMessage(caught));
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

function attendanceHistoryErrorMessage(error: unknown): string {
  const response = (error as { response?: { data?: unknown } })?.response;
  const data = response?.data;
  const message =
    typeof data === 'string'
      ? data
      : data && typeof data === 'object'
        ? (data as { message?: unknown }).message
        : null;
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : '考勤异常查询失败，请稍后重试';
}
