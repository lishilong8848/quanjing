import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PersonnelRecoveryPreview, PersonnelRecoveryRequest, PersonnelRecoveryTask } from '@shared/personnel-task-recovery.interface';
import { loadRecoveryPreview, loadRecoveryTasks, recoverOriginalTask } from './api';

type Phase = 'idle' | 'loading' | 'ready' | 'submitting' | 'accepted' | 'success' | 'error';
const labels: Record<PersonnelRecoveryTask['status'], string> = { pending: '等待处理', running: '处理中', failed: '待核对', completed: '业务已完成' };
const taskKey = (task: PersonnelRecoveryTask) => `${task.module}:${task.id}`;

export function PersonnelTaskRecoveryPanel({ accountId }: { accountId: string }) {
  const [tasks, setTasks] = useState<PersonnelRecoveryTask[]>([]);
  const [listPhase, setListPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState(''), [visibleCount, setVisibleCount] = useState(50);
  const [selected, setSelected] = useState<PersonnelRecoveryTask>();
  const [preview, setPreview] = useState<PersonnelRecoveryPreview>();
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [acknowledged, setAcknowledged] = useState(false), [selections, setSelections] = useState<string[]>([]);
  const [needsRecheck, setNeedsRecheck] = useState(false), [waiting, setWaiting] = useState<string>();
  const [notice, setNotice] = useState(''), [unknownResult, setUnknownResult] = useState(false);
  const listSequence = useRef(0), formSequence = useRef(0), submitting = useRef(false);
  const request = useRef<PersonnelRecoveryRequest | undefined>(undefined);
  const submittedInput = useRef<PersonnelRecoveryRequest | undefined>(undefined);
  const selectedKey = useRef<string | undefined>(undefined);
  selectedKey.current = selected ? taskKey(selected) : undefined;

  const refreshList = useCallback(async () => {
    const token = ++listSequence.current;
    setListPhase('loading'); setListError('');
    try {
      const values = await loadRecoveryTasks();
      if (!Array.isArray(values)) throw new Error('恢复任务清单格式异常，请重试');
      if (token !== listSequence.current) return;
      setTasks(values); setListPhase('ready'); return values;
    } catch (failure) {
      if (token === listSequence.current) { setListError((failure as Error).message); setListPhase('error'); }
      return undefined;
    }
  }, [accountId]);
  useEffect(() => {
    void refreshList();
    return () => { listSequence.current++; formSequence.current++; };
  }, [refreshList]);

  useEffect(() => {
    if (!waiting) return;
    let stopped = false, count = 0, timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const values = await refreshList();
      if (stopped) return;
      if (!values) { setWaiting(undefined); setNotice('进度读取未完成，可稍后更新任务'); return; }
      const task = values.find(task => taskKey(task) === waiting);
      if (!task) { setWaiting(undefined); setNotice('任务不在当前清单，请核对原业务进度'); return; }
      if (task.status === 'completed' || task.status === 'failed') {
        setWaiting(undefined); setNotice(task.message);
        if (selectedKey.current === waiting) { setMessage(task.message); setPhase(task.status === 'completed' ? 'success' : 'error'); }
        return;
      }
      if (++count >= 20) { setWaiting(undefined); setNotice('后台仍在处理，可稍后更新任务'); return; }
      timer = setTimeout(() => void check(), 3000);
    };
    timer = setTimeout(() => void check(), 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [refreshList, waiting]);

  async function readPreview(task: PersonnelRecoveryTask, newRequest = false) {
    if (submitting.current) return;
    if (newRequest || !request.current || request.current.taskId !== task.id || request.current.module !== task.module) {
      request.current = { module: task.module, taskId: task.id, expectedVersion: task.version, clientMutationId: crypto.randomUUID() };
      submittedInput.current = undefined; setUnknownResult(false);
    }
    const token = ++formSequence.current;
    setSelected(task); setPhase('loading'); setError(''); setMessage(''); setAcknowledged(false);
    try {
      const previewRequest = { ...request.current, ...(submittedInput.current ? { clientMutationId: crypto.randomUUID() } : {}) };
      const result = await loadRecoveryPreview(previewRequest);
      if (token !== formSequence.current) return;
      if (!result?.task || !Array.isArray(result.facts) || !Array.isArray(result.choices) || typeof result.version !== 'string') throw new Error('任务核对内容异常，请重试');
      request.current = { ...previewRequest, expectedVersion: result.version };
      submittedInput.current = undefined; setUnknownResult(false);
      setPreview(result); setSelections(result.choices.map(() => '')); setNeedsRecheck(false); setPhase('ready');
    } catch (failure) {
      if (token === formSequence.current) { setError((failure as Error).message); setNeedsRecheck(true); setPhase('error'); }
    }
  }
  function close() {
    if (submitting.current) return;
    formSequence.current++; setSelected(undefined); setPreview(undefined); setPhase('idle'); setError('');
  }
  async function submit() {
    if (!selected || !preview || !request.current || submitting.current || !canConfirm) return;
    submitting.current = true; const token = formSequence.current;
    const input = submittedInput.current || { ...request.current, selections: [...selections] };
    submittedInput.current = input;
    setPhase('submitting'); setError('');
    try {
      const result = await recoverOriginalTask(input);
      if (token !== formSequence.current) return;
      if (!result || !['completed','pending'].includes(result.status) || typeof result.message !== 'string') throw new Error('保存结果未确认，请使用原请求重试');
      setMessage(result.message); setNotice(result.message); setPhase(result.status === 'completed' ? 'success' : 'accepted');
      if (result.status === 'pending') setWaiting(taskKey(selected));
      void refreshList();
    } catch (failure) {
      if (token === formSequence.current) {
        setError((failure as Error).message); setPhase('error');
        const status = (failure as { status?: number }).status;
        if (status && [400,401,403,409].includes(status)) setNeedsRecheck(true);
        else setUnknownResult(true);
      }
    } finally { submitting.current = false; }
  }
  const uniqueSelections = new Set(selections.filter(Boolean)).size === selections.filter(Boolean).length;
  const canConfirm = !!preview?.canConfirm && acknowledged && uniqueSelections && !needsRecheck &&
    preview.choices.every((choice, index) => choice.options.some(option => option.value === selections[index])) &&
    (phase === 'ready' || phase === 'error');

  return <Card><CardContent className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">任务恢复</h3>
      <Button type="button" variant="outline" disabled={listPhase === 'loading'} onClick={() => void refreshList()}>更新任务</Button></div>
    {listPhase === 'loading' && <p role="status" className="text-sm text-muted-foreground">正在读取恢复任务…</p>}
    {listError && <p role="alert" className="break-words text-sm text-destructive">{listError}</p>}
    {notice && <p role="status" className="break-words text-sm">{notice}</p>}
    {listPhase === 'ready' && !tasks.length && <p className="text-sm text-muted-foreground">暂无需要恢复的任务</p>}
    <div className="space-y-2">{tasks.slice(0, visibleCount).map(task => <div key={taskKey(task)} role="group" aria-label={`${task.title} · ${task.actorName}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 96px' }}>
      <div className="min-w-0 flex-1 basis-48 space-y-1"><p className="break-words text-sm font-medium">{task.title} · {task.actorName}</p>
        <p className="break-words text-xs text-muted-foreground">{task.message}</p><p className="text-xs text-muted-foreground">{new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}</p></div>
      <span className="text-xs">{labels[task.status]}</span><Button type="button" size="sm" variant="outline" disabled={!task.available || submitting.current} onClick={() => { setPreview(undefined); void readPreview(task, true); }}>{task.status === 'completed' ? '查看结果' : task.actionLabel}</Button>
    </div>)}</div>
    {tasks.length > visibleCount && <Button variant="outline" onClick={() => setVisibleCount(count => count + 50)}>显示更多（剩余 {tasks.length - visibleCount} 项）</Button>}
    {tasks.length > 0 && <p className="text-xs text-muted-foreground">未完成任务全部保留，已完成恢复记录最多显示最近100项。</p>}
    <Dialog open={!!selected} onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl" onEscapeKeyDown={event => { if (submitting.current) event.preventDefault(); }} onInteractOutside={event => { if (submitting.current) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{selected?.title || '恢复任务'}</DialogTitle></DialogHeader>
        {phase === 'loading' && <p role="status">正在核对任务…</p>}
        {preview && <div className="min-w-0 space-y-4">
          <dl className="space-y-2 text-sm">{preview.facts.map((fact, index) => <div key={index} className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-2"><dt className="text-muted-foreground">{fact.label}</dt><dd className="break-words">{fact.value}</dd></div>)}</dl>
          {preview.choices.map((choice, index) => <label key={index} className="block min-w-0 space-y-2 text-sm"><span className="break-words">{choice.label}</span>
            <select aria-label={`核对付款计划${index + 1}`} className="h-10 w-full min-w-0 rounded-lg border bg-background px-3" disabled={unknownResult || phase === 'submitting' || phase === 'accepted' || phase === 'success'} value={selections[index] || ''} onChange={event => { const value = event.target.value; setSelections(previous => previous.map((selection, position) => position === index ? value : selection)); }}>
              <option value="">请选择对应付款计划</option>{choice.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>)}
          {!uniqueSelections && <p role="alert" className="text-sm text-destructive">请选择不同的付款计划</p>}
          {preview.task.hint && <p className="break-words text-xs text-muted-foreground">{preview.task.hint}</p>}
          {!preview.canConfirm && <p role="status" className="break-words text-sm">{preview.message || '当前任务无需恢复'}</p>}
          {preview.canConfirm && phase !== 'success' && phase !== 'accepted' && <label className="flex items-start gap-2 text-sm"><Checkbox checked={acknowledged} disabled={phase === 'submitting'} onCheckedChange={checked => setAcknowledged(checked === true)} /><span className="break-words">{preview.acknowledgement}</span></label>}
        </div>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {needsRecheck && <p className="text-sm text-muted-foreground">请重新核对当前任务后确认。</p>}
        {unknownResult && <p className="text-sm text-muted-foreground">提交结果尚未确认，可保留原请求重试或重新核对进度。</p>}
        {message && <p role="status" className="break-words text-sm">{message}</p>}
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={phase === 'submitting'} onClick={close}>{phase === 'success' || phase === 'accepted' ? '完成' : '关闭'}</Button>
          {(phase === 'error' || needsRecheck) && <Button variant="outline" disabled={phase === 'submitting'} onClick={() => selected && void readPreview(selected)}>重新核对</Button>}
          {preview?.canConfirm && phase !== 'accepted' && phase !== 'success' && <Button disabled={!canConfirm} onClick={() => void submit()}>{phase === 'submitting' ? '正在提交…' : '确认恢复'}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </CardContent></Card>;
}
