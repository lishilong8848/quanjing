import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
const Context = createContext<{
  stamps: Record<string, string>;
  record: (source: string, date?: string | null) => void;
}>({ stamps: {}, record: () => {} });
export function SourceStampProvider({ children }: { children: ReactNode }) {
  const [stamps, setStamps] = useState<Record<string, string>>({});
  const record = useCallback((source: string, date?: string | null) => {
    if (date)
      setStamps((old) =>
        old[source] === date ? old : { ...old, [source]: date },
      );
  }, []);
  return (
    <Context.Provider value={{ stamps, record }}>{children}</Context.Provider>
  );
}
export function useSourceStamp(source: string, date?: string | null) {
  const { record } = useContext(Context);
  useEffect(() => record(source, date), [source, date, record]);
}
export function SourceStamp({ topic }: { topic: string }) {
  const { stamps } = useContext(Context),
    key = ['overview', 'energy', 'capacity'].includes(topic)
      ? 'resources'
      : topic;
  const date = Object.entries(stamps)
    .filter(([k]) => k === key || k.startsWith(key + '-'))
    .map(([, v]) => v)
    .sort()
    .at(-1);
  return date ? (
    <time className="mo-source-stamp" dateTime={date}>
      更新{' '}
      {new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(date))}
    </time>
  ) : null;
}
