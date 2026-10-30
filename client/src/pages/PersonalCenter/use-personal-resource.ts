import { useCallback, useEffect, useRef, useState } from 'react';

export interface VersionedPersonalRecord { id: string; version: number; createdAt: string }

/** Keep confirmed mutations newer than an in-flight snapshot; never resurrect a withdrawn version. */
export function mergePersonalRecords<T extends VersionedPersonalRecord>(current: T[], incoming: T[], protectedIds: ReadonlySet<string>): T[] {
  const previous = new Map(current.map(item => [item.id, item]));
  const merged = incoming.map(item => {
    const old = previous.get(item.id);
    return old && old.version > item.version ? old : item;
  });
  const present = new Set(merged.map(item => item.id));
  for (const item of current) if (protectedIds.has(item.id) && !present.has(item.id)) merged.push(item);
  return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function usePersonalCollection<T extends VersionedPersonalRecord>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const alive = useRef(true), requestSequence = useRef(0), mutationSequence = useRef(0);
  const changed = useRef(new Map<string, number>()), pending = useRef<Promise<void> | null>(null);
  const upsert = useCallback((item: T) => {
    changed.current.set(item.id, ++mutationSequence.current);
    if (!alive.current) return;
    setItems(previous => mergePersonalRecords(previous, [item, ...previous.filter(row => row.id !== item.id)], new Set()));
    setError('');
  }, []);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const sequence = ++requestSequence.current, mutationAtStart = mutationSequence.current;
    setLoading(true);
    const promise = load().then(incoming => {
      if (!alive.current || sequence !== requestSequence.current) return;
      const protectedIds = new Set([...changed.current].filter(([, at]) => at > mutationAtStart).map(([id]) => id));
      setItems(previous => mergePersonalRecords(previous, incoming, protectedIds));
      setError('');
    }).catch(failure => {
      if (alive.current && sequence === requestSequence.current && mutationAtStart === mutationSequence.current) setError(failure instanceof Error ? failure.message : '读取失败，请重试');
    }).finally(() => {
      if (sequence === requestSequence.current) { pending.current = null; if (alive.current) setLoading(false); }
    });
    pending.current = promise;
    return promise;
  }, [load]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; requestSequence.current++; pending.current = null; }; }, [refresh]);
  return { items, loading, error, refresh, upsert };
}

export function usePersonalProfileResource<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const alive = useRef(true), sequence = useRef(0), pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const request = ++sequence.current;
    setLoading(true);
    const promise = load().then(result => {
      if (alive.current && request === sequence.current) { setValue(result); setError(''); }
    }).catch(failure => {
      if (alive.current && request === sequence.current) setError(failure instanceof Error ? failure.message : '读取失败，请重试');
    }).finally(() => {
      if (request === sequence.current) { pending.current = null; if (alive.current) setLoading(false); }
    });
    pending.current = promise;
    return promise;
  }, [load]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; sequence.current++; pending.current = null; }; }, [refresh]);
  return { value, loading, error, refresh };
}
