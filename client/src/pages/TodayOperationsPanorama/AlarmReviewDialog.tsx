import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import './alarm-review.css';
import { ALARM_REVIEW_CUSTOM_OUTCOME, ALARM_REVIEW_REPLY_MAX_LENGTH, ALARM_REVIEW_OUTCOMES, type AlarmReviewOutcome, type AlarmReviewPerson, type AlarmReviewRequest, type AlarmReviewTask } from '@shared/today-operations-alarm-review.interface';
import type { TodayOperationsAlarmItem } from '@shared/today-operations-alarm.interface';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { alarmReviewError, getAlarmReviewPeople, getAlarmReviewTask, recoverAlarmReviewTask, retryAlarmReviewTask, submitAlarmReview } from './alarm-review-api';
import { AlarmReviewPersonPicker } from './AlarmReviewPersonPicker';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: TodayOperationsAlarmItem[];
  allowed: boolean;
  sessionReady: boolean;
  onTask: (task: AlarmReviewTask) => void;
}
const STORAGE_KEY = 'alarm-human-review-active-task';
const DRAFT_KEY = 'alarm-human-review-pending-request';
function saveDraft(request: AlarmReviewRequest | null): void {
  try { if (request) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(request)); else sessionStorage.removeItem(DRAFT_KEY); } catch { /* 保留当前会话内提交标识 */ }
}
function saveTaskId(id: string | null): void {
  try { if (id) sessionStorage.setItem(STORAGE_KEY, id); else sessionStorage.removeItem(STORAGE_KEY); } catch { /* 不影响服务端已持久化任务 */ }
}
export function AlarmReviewDialog({ open, onOpenChange, items, allowed, sessionReady, onTask }: Props) {
  const [people, setPeople] = useState<AlarmReviewPerson[]>([]);
  const [peopleState, setPeopleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [peopleError, setPeopleError] = useState('');
  const [peopleReload, setPeopleReload] = useState(0);
  const [outcome, setOutcome] = useState<AlarmReviewOutcome>(ALARM_REVIEW_OUTCOMES[0]);
  const [customReply, setCustomReply] = useState('');
  const [personId, setPersonId] = useState('');
  const [personSearchOpen, setPersonSearchOpen] = useState(false);
  const [task, setTask] = useState<AlarmReviewTask | null>(null);
  const [phase, setPhase] = useState<'idle' | 'submitting' | 'accepted' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  const [pollKey, setPollKey] = useState(0);
  const mutation = useRef<AlarmReviewRequest | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const callback = useRef(onTask); callback.current = onTask;
  const selectionKey = items.map((item) => item.id).sort().join(':');

  useEffect(() => {
    if (!sessionReady) return;
    if (!allowed) { generation.current++; mutation.current = null; setTask(null); setPeople([]); setPeopleState('idle'); saveTaskId(null); saveDraft(null); return; }
    let active = true;
    let saved = '';
    let draft: AlarmReviewRequest | null = null;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY) || '';
      const parsed = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null') as AlarmReviewRequest | null;
      if (parsed && /^alarm-review-[A-Za-z0-9_-]{8,100}$/.test(parsed.clientMutationId) && Array.isArray(parsed.recordIds)) draft = parsed;
    } catch { return; }
    if (draft) { mutation.current = draft; setOutcome(draft.outcome); setCustomReply(draft.customReply || ''); setPersonId(draft.responsibleRecordId); setPhase('error'); }
    const readTask = saved ? getAlarmReviewTask(saved) : draft ? recoverAlarmReviewTask(draft.clientMutationId) : null;
    if (readTask) void readTask.then((value) => {
      if (!active) return;
      if (!value) { setError('上次提交尚未受理，可使用同一选择重试'); return; }
      setTask(value); callback.current(value); setOutcome(value.outcome); setCustomReply(value.customReply || ''); setPersonId(value.responsibleRecordId);
      saveDraft(null); saveTaskId(value.id);
      setPhase(value.items.some((item) => item.state === 'pending' || item.state === 'syncing') ? 'accepted' : value.items.some((item) => item.state === 'error') ? 'error' : 'success');
    }).catch(() => { if (active) setError('上次复核任务暂时无法核对，请重试读取'); });
    return () => { active = false; };
  }, [allowed, sessionReady]);
  useEffect(() => {
    if (!open || !allowed) return;
    if (task?.items.some((item) => item.state === 'pending' || item.state === 'syncing') || (mutation.current && !task)) return;
    setTask(null); setPhase('idle'); setError(''); mutation.current = null; saveDraft(null); saveTaskId(null);
  }, [open, selectionKey, allowed]);
  useEffect(() => {
    if (!open || !allowed || peopleState === 'ready') return;
    let active = true;
    setPeopleState('loading'); setPeopleError('');
    void getAlarmReviewPeople().then((value) => { if (active) { setPeople(value); setPeopleState('ready'); } })
      .catch((reason) => { if (active) { setPeopleState('error'); setPeopleError(alarmReviewError(reason)); } });
    return () => { active = false; };
  }, [open, allowed, peopleReload]);
  useEffect(() => {
    if (!task || phase !== 'accepted' || !allowed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      try {
        const value = await getAlarmReviewTask(task.id);
        if (cancelled) return;
        setTask(value); callback.current(value);
        if (!value.items.some((item) => item.state === 'pending' || item.state === 'syncing')) {
          setPhase(value.items.some((item) => item.state === 'error') ? 'error' : 'success'); return;
        }
        if (Date.now() - started > 60000) { setError('后台仍在同步，可稍后重新核对；请勿重复提交'); return; }
        timer = setTimeout(poll, 2000);
      } catch (reason) { if (!cancelled) setError(alarmReviewError(reason)); }
    };
    timer = setTimeout(poll, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [task?.id, phase, allowed, pollKey]);

  async function submit() {
    if (inFlight.current || !allowed || (!items.length && !mutation.current) || !personId) return;
    if (!mutation.current && outcome === ALARM_REVIEW_CUSTOM_OUTCOME && (!customReply.trim() || customReply.trim().length > ALARM_REVIEW_REPLY_MAX_LENGTH)) {
      setError(`请输入 1–${ALARM_REVIEW_REPLY_MAX_LENGTH} 字的自定义回复`); return;
    }
    inFlight.current = true; setPhase('submitting'); setError('');
    const current = generation.current;
    if (!mutation.current) mutation.current = {
      recordIds: items.map((item) => item.id), outcome, responsibleRecordId: personId,
      ...(outcome === ALARM_REVIEW_CUSTOM_OUTCOME ? { customReply: customReply.trim() } : {}),
      clientMutationId: `alarm-review-${crypto.randomUUID()}`,
      expectedVersions: Object.fromEntries(items.map((item) => [item.id, item.humanReview?.version || 'unreviewed'])),
    };
    saveDraft(mutation.current);
    try {
      const value = await submitAlarmReview(mutation.current);
      if (current !== generation.current) return;
      setTask(value); callback.current(value); saveTaskId(value.id);
      saveDraft(null);
      setPhase(value.items.every((item) => item.state === 'success') ? 'success' : value.items.some((item) => item.state === 'error') ? 'error' : 'accepted');
    } catch (reason) { if (current === generation.current) { setPhase('error'); setError(alarmReviewError(reason)); } }
    finally { inFlight.current = false; }
  }
  async function retry() {
    if (!task || inFlight.current || !allowed) return;
    inFlight.current = true; setError(''); setPhase('submitting');
    try { const value = await retryAlarmReviewTask(task.id); setTask(value); callback.current(value); setPhase('accepted'); setPollKey((key) => key + 1); }
    catch (reason) { setPhase('error'); setError(alarmReviewError(reason)); } finally { inFlight.current = false; }
  }
  const busy = phase === 'submitting' || phase === 'accepted';
  const lockedDraft = Boolean(mutation.current) && !task;
  const mismatchedDraft = lockedDraft && [...mutation.current!.recordIds].sort().join(':') !== selectionKey;
  const formDisabled = busy || Boolean(task) || lockedDraft || !allowed;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} className="alarm-review-dialog" onEscapeKeyDown={event => { if (personSearchOpen) event.preventDefault(); }}>
      <Button variant="ghost" size="icon" aria-label="关闭异常跟进" className="absolute right-3 top-3" onClick={() => onOpenChange(false)}><X aria-hidden="true" /></Button>
      <DialogHeader className="alarm-review-header"><DialogTitle>异常跟进 · {task?.items.length || mutation.current?.recordIds.length || items.length} 条</DialogTitle>
        <DialogDescription className="sr-only">选择人工复核结果和示例人员019</DialogDescription></DialogHeader>
      <div className="alarm-review-body space-y-4">
        {!task ? <div className="alarm-review-context">{items.length === 1 ? items[0].description : `已选择 ${items.length} 条异常`}</div> : null}
        <fieldset className="alarm-review-results" disabled={formDisabled}>
          <legend className="mb-2 font-medium">复核结果</legend>
          <div className="alarm-review-result-options">{ALARM_REVIEW_OUTCOMES.map((value) => <label key={value} className="alarm-review-result-option" data-checked={outcome === value}>
            <input type="radio" name="alarm-review-outcome" checked={outcome === value} onChange={() => { setOutcome(value); setError(''); }} /><span>{value}</span>
          </label>)}</div>
        </fieldset>
        {outcome === ALARM_REVIEW_CUSTOM_OUTCOME ? <div className="alarm-review-custom-reply">
          <label htmlFor="alarm-review-reply" className="font-medium">回复内容 <span className="text-destructive">*</span></label>
          <Textarea id="alarm-review-reply" value={customReply} onChange={event => { setCustomReply(event.target.value); setError(''); }} disabled={formDisabled}
            placeholder="填写复核结论或后续处理安排" maxLength={ALARM_REVIEW_REPLY_MAX_LENGTH} rows={3} />
          <span className="alarm-review-reply-count">{customReply.length} / {ALARM_REVIEW_REPLY_MAX_LENGTH}</span>
        </div> : null}
        <div className="space-y-2"><label htmlFor="alarm-review-person" className="font-medium">示例人员019 <span className="text-destructive">*</span></label>
          <AlarmReviewPersonPicker people={people} value={personId} onChange={setPersonId} onExpandedChange={setPersonSearchOpen} disabled={formDisabled || peopleState !== 'ready'} loading={peopleState === 'loading'} fallbackName={task?.responsibleName} />
          {peopleState === 'error' ? <div role="alert" className="text-sm text-destructive">{peopleError} <Button variant="outline" size="sm" onClick={() => setPeopleReload((key) => key + 1)}>重试读取</Button></div> : null}
          {peopleState === 'ready' && !people.length ? <p role="status" className="text-sm text-muted-foreground">暂无可关联飞书身份的在职示例人员019</p> : null}
        </div>
        {task ? <div className="space-y-2" aria-live="polite">
          <div className="font-medium">已完成 {task.items.filter((item) => item.state === 'success').length} / {task.items.length}{phase === 'accepted' ? ' · 同步中' : phase === 'success' ? ' · 复核已保存' : ' · 有未完成条目'}</div>
          <ul className="max-h-56 overflow-y-auto divide-y rounded-lg border">
            {task.items.map((item) => <li key={item.recordId} className="p-3 text-sm space-y-1">
              <div className="flex items-start justify-between gap-3"><span className="min-w-0 break-words">{items.find((row) => row.id === item.recordId)?.description || item.recordId}</span><span className="shrink-0">{item.state === 'success' ? '已复核' : item.state === 'error' ? '同步失败' : '同步中'}</span></div>
              {item.message ? <p role="alert" className="text-destructive">{item.message}</p> : null}
            </li>)}
          </ul>
        </div> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {mismatchedDraft ? <p role="alert" className="text-sm text-destructive">上次提交尚未确认，重试仅处理原条目：{mutation.current!.recordIds.join('、')}。当前新选择尚未提交。</p> : null}
        {task && task.items.map((item) => item.recordId).sort().join(':') !== selectionKey ? <p role="status" className="text-sm text-muted-foreground">当前显示上次复核任务，新选择尚未提交。</p> : null}
        {!allowed ? <p role="alert">请使用管理员或子管理员身份进行复核</p> : null}
      </div>
      <DialogFooter className="alarm-review-footer gap-2">
        <Button variant="outline" onClick={() => { if (phase === 'success') saveTaskId(null); onOpenChange(false); }}>{phase === 'success' ? '完成' : '关闭'}</Button>
        {task ? task.items.some((item) => item.state === 'error') ? <Button onClick={retry} disabled={busy || !allowed}>重试失败项</Button> : phase === 'accepted' ? <Button variant="outline" onClick={() => { setError(''); setPollKey((key) => key + 1); }}>重新核对</Button> : null
          : <Button onClick={submit} disabled={busy || !personId || peopleState !== 'ready' || (!items.length && !mutation.current) || !allowed || (outcome === ALARM_REVIEW_CUSTOM_OUTCOME && !customReply.trim())}>{phase === 'submitting' ? '正在受理…' : mismatchedDraft ? '重试上次提交' : lockedDraft ? '重试本次提交' : '提交复核'}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
