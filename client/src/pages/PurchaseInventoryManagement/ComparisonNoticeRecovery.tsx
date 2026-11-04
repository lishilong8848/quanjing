import { useState } from 'react';
import { getCurrentCsrfToken } from '@/api/csrf-token';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Preview = { requeued: number; alreadyRequeued: number; candidates: Array<{ batchId: string; recipientName: string }> };

export function ComparisonNoticeRecovery() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewedDraft, setReviewedDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const keys = draft.split(/\r?\n/).map(value => value.trim()).filter(Boolean);

  async function submit(action: 'preview' | 'retry') {
    if (pending || !keys.length || keys.length > 20 || (action === 'retry' && (!preview || reviewedDraft !== draft))) return;
    setPending(true);
    setMessage('');
    try {
      const csrf = getCurrentCsrfToken();
      const response = await fetch(`/api/purchase-inventory/workflows/${action === 'preview' ? 'preview' : 'retry'}-comparison-image-notifications`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(csrf ? { 'X-Suda-Csrf-Token': csrf } : {}) },
        body: JSON.stringify({ keys }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof data?.message === 'string' ? data.message : '操作失败，请重新核对后重试');
      if (!data || !Array.isArray(data.candidates) || typeof data.requeued !== 'number' || typeof data.alreadyRequeued !== 'number') throw new Error('结果无法核对，请重新预览');
      if (action === 'preview') {
        setPreview(data);
        setReviewedDraft(draft);
      } else {
        setPreview(null);
        setMessage(`已恢复 ${data.requeued} 条通知，已处理 ${data.alreadyRequeued} 条。请查看审批卡片投递结果。`);
      }
    } catch (error) {
      setPreview(null);
      setMessage(error instanceof Error ? error.message : '操作失败，请重新核对后重试');
    } finally {
      setPending(false);
    }
  }

  return <>
    <Button type="button" variant="outline" onClick={() => setOpen(true)}>恢复比价审批通知</Button>
    <Dialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>恢复比价审批通知</DialogTitle>
          <DialogDescription>输入需恢复的原通知编号，每行一条。预览后核对批次和接收人。</DialogDescription>
        </DialogHeader>
        <label htmlFor="comparison-notice-keys" className="text-sm font-medium">原通知编号</label>
        <textarea id="comparison-notice-keys" value={draft} disabled={pending} rows={5} className="w-full rounded-md border border-slate-300 p-2 text-sm" onChange={event => { setDraft(event.target.value); setPreview(null); setMessage(''); }} />
        {preview && <div className="rounded-md border p-3 text-sm" aria-live="polite">
          <p>待恢复 {preview.requeued} 条，已处理 {preview.alreadyRequeued} 条</p>
          <ul className="mt-2 space-y-1">{preview.candidates.map((item, index) => <li key={`${item.batchId}-${index}`} className="break-all">{item.batchId} · {item.recipientName}</li>)}</ul>
        </div>}
        {message && <p role="status" className="break-words text-sm">{message}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending || keys.length === 0 || keys.length > 20} onClick={() => void submit('preview')}>核对通知</Button>
          <Button type="button" disabled={pending || !preview || reviewedDraft !== draft || preview.requeued === 0} onClick={() => void submit('retry')}>{pending ? '处理中…' : '确认恢复'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
