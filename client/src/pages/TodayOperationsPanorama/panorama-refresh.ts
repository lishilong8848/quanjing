/** Share only outstanding reads; settled responses are never cached here. */
export function createPanoramaReadCoalescer() {
  const pending = new Map<string, Promise<unknown>>();
  return function read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = pending.get(key);
    if (existing) return existing as Promise<T>;
    const task = Promise.resolve().then(load);
    pending.set(key, task);
    void task.finally(() => {
      if (pending.get(key) === task) pending.delete(key);
    }).catch(() => undefined);
    return task;
  };
}

export function createBusinessClockNotifier(keyFor: (date: Date) => string, initial: Date, notify: (date: Date) => void) {
  let key = keyFor(initial);
  return (date: Date) => {
    const next = keyFor(date);
    if (next === key) return;
    key = next;
    notify(date);
  };
}
