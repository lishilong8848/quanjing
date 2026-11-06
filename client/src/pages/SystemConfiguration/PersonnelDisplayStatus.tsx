import { Button } from '@/components/ui/button';

export function PersonnelDisplayStatus({ cache, onRetry }: {
  cache?: { snapshotAt: number; stale: boolean; refreshing: boolean };
  onRetry: () => void;
}) {
  if (!cache) return null;
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status">
    <span>人员资料更新于 {new Date(cache.snapshotAt).toLocaleString('zh-CN', { hour12: false })}
      {cache.stale ? cache.refreshing ? ' · 正在后台更新，现有资料可继续查看' : ' · 已保留上次资料，可重试更新' : ''}</span>
    {cache.stale && !cache.refreshing && <Button variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>重试更新</Button>}
  </div>;
}
