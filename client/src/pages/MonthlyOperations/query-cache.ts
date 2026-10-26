export type QueryRange = { start: string; end: string };
export type QueryState<T> = {
  key: string;
  data: T | null;
  loading: boolean;
  error: string;
};
type Entry<T> = { at: number; state: QueryState<T> };
const FRESH_MS = 5 * 60 * 1000;
const RETAIN_MS = 6 * 60 * 60 * 1000;

// Only the public, projected monthly read models are retained in this tab.
export function createMonthlyQuery<T>(options: {
  name: string;
  fetch: (range: QueryRange, refresh: boolean) => Promise<T>;
  validate: (data: T, range: QueryRange) => boolean;
  updating?: (data: T) => boolean;
  storage?: () => Storage | undefined;
}) {
  const entries = new Map<string, Entry<T>>();
  const pending = new Map<string, Promise<void>>();
  const listeners = new Map<string, Set<() => void>>();
  const prefix = `monthly-read:v1:${options.name}:`;
  const keyFor = (r: QueryRange) => `${r.start}:${r.end}`;
  const storage = () => {
    try {
      return options.storage
        ? options.storage()
        : typeof window === 'undefined'
          ? undefined
          : window.sessionStorage;
    } catch {
      return undefined;
    }
  };
  function entry(range: QueryRange) {
    const key = keyFor(range);
    let row = entries.get(key);
    if (!row) {
      row = { at: 0, state: { key, data: null, loading: true, error: '' } };
      try {
        const raw = storage()?.getItem(prefix + key);
        if (raw) {
          const saved = JSON.parse(raw) as { at: number; data: T };
          if (
            Number.isFinite(saved.at) &&
            Date.now() >= saved.at &&
            Date.now() - saved.at < RETAIN_MS &&
            options.validate(saved.data, range)
          ) {
            row = {
              at: saved.at,
              state: {
                key,
                data: saved.data,
                loading: Date.now() - saved.at >= FRESH_MS,
                error: '',
              },
            };
          } else storage()?.removeItem(prefix + key);
        }
      } catch {
        /* A corrupt or unavailable optional cache falls back to the API. */
      }
      entries.set(key, row);
      if (entries.size > 8) {
        const idleKey = [...entries.keys()].find(
          (k) => k !== key && !listeners.get(k)?.size && !pending.has(k),
        );
        if (idleKey) entries.delete(idleKey);
      }
    }
    return row;
  }
  function publish(key: string, state: QueryState<T>, at: number) {
    entries.set(key, { at, state });
    listeners.get(key)?.forEach((notify) => notify());
  }
  function persist(key: string, data: T, at: number) {
    setTimeout(() => {
      const target = storage();
      if (!target || entries.get(key)?.at !== at) return;
      try {
        const saved = JSON.stringify({ at, data });
        if (saved.length > 1500000) return;
        const keys = Array.from({ length: target.length }, (_, i) =>
          target.key(i),
        ).filter(
          (k): k is string => !!k?.startsWith(prefix) && k !== prefix + key,
        );
        while (keys.length >= 2) target.removeItem(keys.shift()!);
        target.setItem(prefix + key, saved);
      } catch {
        // Storage can be disabled or full; the live memory snapshot still works.
      }
    }, 0);
  }
  function load(
    range: QueryRange,
    force = false,
    canForceRefresh = true,
  ): Promise<void> {
    const key = keyFor(range),
      old = entry(range);
    const running = pending.get(key);
    if (running) return running;
    if (
      !force &&
      old.state.data &&
      Date.now() - old.at < FRESH_MS &&
      !options.updating?.(old.state.data)
    )
      return Promise.resolve();
    publish(key, { ...old.state, loading: true, error: '' }, old.at);
    const task = (async () => {
      try {
        const accept = (data: T, loading: boolean) => {
          if (!options.validate(data, range)) throw Error('读取结果无效');
          const at = Date.now();
          publish(key, { key, data, loading, error: '' }, at);
          persist(key, data, at);
        };
        const data = await options.fetch(range, force && canForceRefresh);
        const updating =
          !force && canForceRefresh && !!options.updating?.(data);
        // A valid snapshot is immediately usable. Joining the server refresh must
        // never blank the page or turn a transient refresh failure into a read
        // failure when usable data is already visible.
        accept(data, false);
        if (updating) {
          try {
            accept(await options.fetch(range, true), false);
          } catch {
            const current = entry(range);
            publish(
              key,
              { ...current.state, loading: false, error: '' },
              current.at,
            );
          }
        }
      } catch {
        const current = entry(range);
        publish(
          key,
          {
            ...current.state,
            loading: false,
            error:
              current.state.data && !force
                ? ''
                : '读取失败或超时，请重试',
          },
          current.at,
        );
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, task);
    return task;
  }
  return {
    read: (range: QueryRange) => entry(range).state,
    load,
    subscribe: (range: QueryRange, notify: () => void) => {
      const key = keyFor(range);
      let group = listeners.get(key);
      if (!group) listeners.set(key, (group = new Set()));
      group.add(notify);
      return () => {
        group.delete(notify);
        if (!group.size) listeners.delete(key);
      };
    },
  };
}
