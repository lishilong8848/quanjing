import { Loader2, RefreshCw } from 'lucide-react';
import type { LocalSyncState } from './local-schedule-sync';

export function LocalScheduleSyncStatus({ state, onCheck, onRetry, onReload }: {
  state: LocalSyncState; onCheck: () => void; onRetry: () => void; onReload: () => void;
}) {
  if (state.phase === 'idle') return null;
  const tone = state.phase === 'failed' ? 'border-red-100 bg-red-50 text-red-700'
    : state.refreshWarning || ['unknown', 'missing'].includes(state.phase) ? 'border-amber-200 bg-amber-50 text-amber-800'
      : state.phase === 'succeeded' ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-blue-100 bg-blue-50 text-blue-700';
  return <div role="status" aria-live="polite" className={`mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${tone}`}>
    {state.busy || state.phase === 'running' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 shrink-0" />}
    <span className="min-w-0 flex-1">{state.message}</span>
    {['running', 'unknown'].includes(state.phase) && <button type="button" disabled={state.busy} className="shrink-0 underline disabled:opacity-50" onClick={onCheck}>继续查询</button>}
    {['missing', 'failed'].includes(state.phase) && <button type="button" disabled={state.busy} className="shrink-0 underline disabled:opacity-50" onClick={onRetry}>{state.phase === 'missing' ? '使用原请求重新同步' : '重新同步'}</button>}
    {state.refreshWarning && <button type="button" disabled={state.busy} className="shrink-0 underline disabled:opacity-50" onClick={onReload}>重新读取页面</button>}
  </div>;
}
