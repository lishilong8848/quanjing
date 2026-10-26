import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type {
  ExceptionFollowUpListResponse,
  ExceptionFollowUpItem,
} from '@shared/api.interface';
import {
  indexExceptionFollowUpItems,
  type ExceptionFollowUpIndex,
} from '@shared/exception-follow-up-match';
type Range = { start: string; end: string };
type Fetch = (
  range: Range,
  force: boolean,
) => Promise<ExceptionFollowUpListResponse>;
type State = {
  index: ExceptionFollowUpIndex;
  loading: boolean;
  error: string;
  key: string;
};

export function calendarFollowUpRange(date: Date): Range {
  const start = new Date(date.getFullYear(), date.getMonth(), -6);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 7);
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: key(start), end: key(end) };
}

export function createCalendarFollowUpStore(fetch: Fetch) {
  let state: State = { index: {}, loading: false, error: '', key: '' },
    seq = 0,
    revision = 0;
  const listeners = new Set<() => void>(),
    fresh = new Map<string, number>(),
    pending = new Map<string, Promise<void>>();
  const publish = (next: State) => {
    state = next;
    listeners.forEach((fn) => fn());
  };
  const setIndex = (
    update: (current: ExceptionFollowUpIndex) => ExceptionFollowUpIndex,
  ) => {
    revision++;
    fresh.clear();
    publish({ ...state, index: update(state.index) });
  };
  const load = (range: Range, force = false): Promise<void> => {
    const key = `${range.start}:${range.end}`;
    if (pending.has(key)) return pending.get(key)!;
    if (!force && Date.now() - (fresh.get(key) || 0) < 300000) {
      publish({ ...state, key, loading: false, error: '' });
      return Promise.resolve();
    }
    const token = ++seq,
      version = revision;
    publish({ ...state, key, loading: true, error: '' });
    const task = (async () => {
      try {
        const result = await fetch(range, force);
        if (token !== seq) return;
        if (version !== revision) throw Error('local mutation');
        if (
          result.range?.start !== range.start ||
          result.range?.end !== range.end ||
          !Array.isArray(result.items) ||
          result.items.some((i) => i.date < range.start || i.date > range.end)
        )
          throw Error('invalid range');
        const byId = new Map<string, ExceptionFollowUpItem>();
        Object.values(state.index)
          .flat()
          .filter((i) => i.date < range.start || i.date > range.end)
          .forEach((i) => byId.set(i.recordId, i));
        result.items.forEach((i) => byId.set(i.recordId, i));
        fresh.set(key, Date.now());
        if (fresh.size > 4) fresh.delete(fresh.keys().next().value!);
        publish({
          key,
          index: indexExceptionFollowUpItems([...byId.values()]),
          loading: false,
          error: '',
        });
      } catch {
        if (token === seq)
          publish({
            ...state,
            loading: false,
            error:
              version !== revision
                ? '跟进记录已变化，请重新读取核对'
                : '跟进记录读取失败，保留当前提示，请重试',
          });
      }
    })().finally(() => {
      pending.delete(key);
    });
    pending.set(key, task);
    return task;
  };
  return {
    read: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    load,
    setIndex,
  };
}

export function useCalendarFollowUps(
  range: Range,
  fetch: Fetch,
  refreshToken = 0,
) {
  const store = useMemo(() => createCalendarFollowUpStore(fetch), [fetch]);
  const state = useSyncExternalStore(store.subscribe, store.read, store.read);
  useEffect(() => {
    void store.load({ start: range.start, end: range.end }, refreshToken > 0);
  }, [store, range.start, range.end, refreshToken]);
  const reload = useCallback(
    () => store.load({ start: range.start, end: range.end }, true),
    [store, range.start, range.end],
  );
  return { ...state, setIndex: store.setIndex, reload };
}
