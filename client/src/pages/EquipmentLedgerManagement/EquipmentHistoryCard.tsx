import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, History, RefreshCw, Search } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { EquipmentHistoryState } from '@shared/equipment-history.interface';
import { getEquipmentHistoryState } from './api';
import { cachedHistory, historyCacheKey } from './history-cache';
import type { LedgerCache } from './use-ledger-query';
import './history.css';

function time(value: string | null): string {
  if (!value) return '未填写';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function EquipmentHistoryCard({
  assetId,
  cache,
  snapshotId = '',
}: {
  assetId: string;
  cache?: LedgerCache;
  snapshotId?: string;
}) {
  const key = historyCacheKey(assetId, snapshotId);
  const [state, setState] = useState<EquipmentHistoryState | null>(() =>
    cachedHistory(cache, key, assetId),
  );
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const current = state?.assetId === assetId ? state : null;
  useEffect(() => {
    const cached = retry === 0 ? cachedHistory(cache, key, assetId) : null;
    if (cached) {
      setState(cached);
      setLoading(false);
      setError('');
      setSearch('');
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setLoading(true);
    setError('');
    setSearch('');
    async function read(refresh: boolean) {
      try {
        const next = await getEquipmentHistoryState(
          assetId,
          refresh,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setState(next);
        if (next.status === 'ready' && !next.refreshing) {
          cache?.set(key, { value: next, at: Date.now() });
          if (cache && cache.size > 60)
            cache.delete(cache.keys().next().value!);
        }
        setLoading(next.refreshing || next.status === 'loading');
        if (next.status === 'error') {
          setError(next.error || '机历信息读取失败，请重试');
          return;
        }
        if (next.refreshing || next.status === 'loading') {
          if (Date.now() - started >= 90000) {
            setLoading(false);
            setError('读取超时，请重试');
          } else
            timer = setTimeout(() => {
              void read(false);
            }, 1500);
        }
      } catch {
        if (!controller.signal.aborted) {
          const previous = cachedHistory(cache, key, assetId);
          const entry = cache?.get(key);
          if (previous && entry)
            cache?.set(key, {
              ...entry,
              value: {
                ...previous,
                stale: true,
                error: '机历信息读取失败，请重试',
              },
            });
          setLoading(false);
          setError('机历信息读取失败，请重试');
        }
      }
    }
    void read(retry > 0);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [assetId, retry, cache, key]);
  const items = useMemo(() => {
    const query = search.trim().normalize('NFKC').toLocaleLowerCase();
    return (current?.items || []).filter(
      (item) =>
        !query ||
        [
          item.repairNumber,
          item.fault,
          item.cause,
          item.result,
          item.status,
          item.parts,
          item.actions,
        ]
          .join(' ')
          .normalize('NFKC')
          .toLocaleLowerCase()
          .includes(query),
    );
  }, [current, search]);
  return (
    <Card
      className="equipment-history-card"
      aria-label="机历信息"
      aria-busy={loading}
    >
      <header className="equipment-history-heading">
        <h3>
          <History aria-hidden="true" />
          机历信息
          {current?.status === 'ready' ? (
            <span>{current.items.length}</span>
          ) : null}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          aria-label={error ? '重试读取机历信息' : '刷新机历信息'}
          disabled={loading}
          onClick={() => setRetry((n) => n + 1)}
        >
          <RefreshCw aria-hidden="true" />
          {error ? '重试' : '刷新'}
        </Button>
      </header>
      {error ? (
        <p className="equipment-history-message" role="alert">
          {error}
        </p>
      ) : null}
      {current?.stale ? (
        <p className="equipment-history-message" role="status">
          {current.error || '维修记录待更新'}
        </p>
      ) : null}
      {loading ? (
        <p className="equipment-history-message" role="status">
          正在读取机历信息…
        </p>
      ) : null}
      {current?.status === 'ready' ? (
        <>
          {current.items.length > 0 ? (
            <div className="equipment-history-search">
              <Search aria-hidden="true" />
              <Input
                aria-label="搜索机历信息"
                placeholder="搜索维修单、故障、原因"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          ) : null}
          {items.length ? (
            <ol className="equipment-history-list">
              {items.map((item) => (
                <li key={item.id}>
                  <details>
                    <summary>
                      <div className="equipment-history-row">
                        <span className="equipment-history-number">
                          {item.repairNumber || '维修记录'}
                        </span>
                        <span
                          className={`equipment-history-status ${item.status === '维修完成' ? 'is-completed' : ''}`}
                        >
                          {item.status}
                        </span>
                        <ChevronDown
                          className="equipment-history-toggle"
                          aria-hidden="true"
                        />
                      </div>
                      <p className="equipment-history-fault">
                        {item.fault || '故障现象未填写'}
                      </p>
                      <span className="equipment-history-date">
                        故障时间 {time(item.faultAt)}
                      </span>
                    </summary>
                    <dl>
                      {Object.entries({
                        故障现象: item.fault,
                        维修原因: item.cause,
                        处理记录: item.result,
                        更换备件: item.parts,
                        后续措施: item.actions,
                        维修开始: time(item.startedAt),
                        维修结束: time(item.endedAt),
                      }).map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value || '未填写'}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="equipment-history-message">
              {search ? '未找到匹配的维修记录' : '暂无已关联维修记录'}
            </p>
          )}
        </>
      ) : null}
    </Card>
  );
}
