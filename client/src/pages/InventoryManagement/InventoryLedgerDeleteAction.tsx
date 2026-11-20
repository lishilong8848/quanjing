import { useEffect, useRef, useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import type { InventoryManagementItem, WarehouseBuilding } from '@shared/inventory-management.interface';
import type { InventoryLedgerDeletionRequest, InventoryLedgerDeletionTask } from '@shared/inventory-ledger-deletion.interface';
import { canPerformBusinessAction } from '@shared/business-permissions';
import { stocktakeDraftJournalIdentity } from './stocktake-draft-journal';
import { stocktakeError } from './inventory-stocktake.logic';
import { createLedgerDeletePolling, ledgerDeleteRequestMode, ledgerDeleteTaskMessage, validLedgerDeleteTask, type LedgerDeleteJournal } from './inventory-ledger-delete-polling';

const endpoint = '/api/inventory-management/ledger-deletions';
function journalKey(identity: string, record: string) {
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  return `inventory-ledger-delete:v1:${(hash >>> 0).toString(16)}:${record}`;
}
function stored(key: string, recordId: string): LedgerDeleteJournal | null {
  try {
    const row = JSON.parse(localStorage.getItem(key) || 'null') as LedgerDeleteJournal | null;
    return row?.request?.recordId === recordId && /^[A-Za-z0-9_-]{8,128}$/.test(row.request.clientMutationId) &&
      ['submitting', 'pending', 'running', 'completed', 'failed', 'uncertain'].includes(row.status) ? row : null;
  } catch { return null; }
}

export function InventoryLedgerDeleteAction({ item, onDeleted }: { item: InventoryManagementItem; onDeleted: (id: string) => void }) {
  const principal = useAccess();
  const key = journalKey(stocktakeDraftJournalIdentity(principal), item.recordId);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [journal, setJournal] = useState<LedgerDeleteJournal | null>(() => stored(key, item.recordId));
  const locked = useRef(false), selection = useRef(key), generation = useRef(0), submitting = useRef<AbortController | null>(null);
  const canDelete = canPerformBusinessAction(principal, { module: 'inventory', action: 'delete', building: item.building, specialty: item.specialty });
  const callback = useRef(onDeleted); callback.current = onDeleted;
  function remember(value: LedgerDeleteJournal, required = false) {
    if (required) localStorage.setItem(key, JSON.stringify(value));
    else { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The original request is already durable. */ } }
    setJournal(value);
  }
  const handlers = useRef({ key, task: (_request: InventoryLedgerDeletionRequest, _task: InventoryLedgerDeletionTask) => {}, error: (_error: unknown) => {}, waiting: () => {} });
  handlers.current = {
    key,
    task(request, task) {
      if (selection.current !== key) return;
      remember({ request, status: task.status, task }); setMessage(ledgerDeleteTaskMessage(task));
      if (task.status === 'completed') { setOpen(false); callback.current(item.recordId); }
    },
    error(error) { if (selection.current === key) setMessage(`暂时无法核对删除结果，原申请已保留：${stocktakeError(error)}`); },
    waiting() { if (selection.current === key) setMessage('后台仍在核对，原申请已保留，可稍后核对结果'); },
  };
  const polling = useRef<ReturnType<typeof createLedgerDeletePolling> | null>(null);
  if (!polling.current) polling.current = createLedgerDeletePolling({
    async read(request, signal) {
      const response = await axiosForBackend({ url: `${endpoint}/${encodeURIComponent(request.clientMutationId)}`, method: 'GET', timeout: 15000, signal });
      return response.data as InventoryLedgerDeletionTask;
    },
    task: (request, task) => handlers.current.task(request, task), error: error => handlers.current.error(error), waiting: () => handlers.current.waiting(),
  });
  function cancelCurrent() {
    generation.current += 1;
    polling.current?.stop();
    submitting.current?.abort(); submitting.current = null;
  }
  function changeOpen(value: boolean) {
    if (!value) { cancelCurrent(); locked.current = false; setBusy(false); }
    setOpen(value);
  }
  useEffect(() => {
    selection.current = key;
    cancelCurrent(); locked.current = false; setBusy(false);
    const previous = stored(key, item.recordId); setJournal(previous); setMessage(previous?.task ? ledgerDeleteTaskMessage(previous.task) : '');
    if (previous?.status === 'completed') callback.current(item.recordId);
    else if (open && canDelete && previous) polling.current?.start(previous.request);
    return () => { selection.current = ''; cancelCurrent(); };
  }, [key, open, canDelete]);

  function inspect() {
    const existing = stored(key, item.recordId) || journal;
    if (!existing) return;
    cancelCurrent(); polling.current?.start(existing.request);
  }
  async function remove() {
    if (locked.current || !canDelete) return;
    const existing = stored(key, item.recordId) || journal;
    const mode = ledgerDeleteRequestMode(existing);
    if (mode === 'completed') { setOpen(false); callback.current(item.recordId); return; }
    if (mode === 'inspect') { inspect(); return; }
    cancelCurrent();
    const selected = generation.current;
    locked.current = true; setBusy(true); setMessage('删除申请正在受理…');
    const request = mode === 'retry' && existing ? existing.request : {
      clientMutationId: crypto.randomUUID(), recordId: item.recordId, building: item.building as WarehouseBuilding,
      expected: { sku: item.sku, quantity: item.quantity, location: item.location },
    };
    try { remember({ request, status: 'submitting' }, true); }
    catch {
      setMessage('无法保存删除申请，尚未发送删除请求；请检查浏览器存储后重试');
      locked.current = false; setBusy(false); return;
    }
    const controller = new AbortController(); submitting.current = controller;
    const current = () => generation.current === selected && selection.current === key && handlers.current.key === key && !controller.signal.aborted;
    try {
      const response = await axiosForBackend({ url: endpoint, method: 'POST', data: request, timeout: 15000, signal: controller.signal });
      if (!current()) return;
      const task = response.data as InventoryLedgerDeletionTask;
      if (!validLedgerDeleteTask(task, request)) throw new Error('删除申请结果待核对');
      handlers.current.task(request, task);
      if (['pending', 'running', 'uncertain'].includes(task.status)) polling.current?.start(request);
    } catch (error) {
      if (current()) { setMessage(`删除受理结果待核对，原申请已保留：${stocktakeError(error)}`); polling.current?.start(request); }
    } finally {
      if (current()) { submitting.current = null; locked.current = false; setBusy(false); }
    }
  }
  if (!canDelete) return <span className="text-slate-400">—</span>;
  const mode = ledgerDeleteRequestMode(journal);
  const pending = !!journal && !['failed', 'completed'].includes(journal.status);
  const retryLabel = mode === 'inspect' ? '核对原申请结果' : mode === 'retry' ? journal?.task?.retryable ? '安全重试删除' : '使用原申请重试' : journal?.status === 'failed' ? '重新确认删除' : '确认删除';
  return <>
    <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={() => changeOpen(true)} aria-label={`删除台账 ${item.name}`}>
      <Trash2 className="h-4 w-4" />{pending || mode === 'inspect' ? '核对删除' : '删除'}
    </Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>删除库存台账</DialogTitle><DialogDescription>确认后同步删除平台和多维表中的这条台账，保留原有出入库历史。此操作无法撤销。</DialogDescription></DialogHeader>
        <div className="space-y-2 text-sm text-slate-700"><p className="font-semibold">{item.name}</p><p>{item.building} · {item.sku} · {item.location || '未配置库位'}</p><p>当前库存：<strong>{item.quantity} {item.unit}</strong></p></div>
        {message && <p role="status" className="break-words text-sm text-slate-600">{message}</p>}
        <DialogFooter><Button variant="outline" onClick={() => changeOpen(false)}>关闭</Button>
          {pending && <Button variant="outline" disabled={busy} onClick={inspect}>核对结果</Button>}
          <Button variant={mode === 'inspect' ? 'outline' : 'destructive'} disabled={busy} onClick={() => void remove()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? '受理中…' : retryLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
