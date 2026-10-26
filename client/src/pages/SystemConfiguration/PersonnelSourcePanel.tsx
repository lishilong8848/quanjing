import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { AccessConfigurationResponse } from '@shared/access-configuration.interface';
import { AUTHORITY_DUTY_CATALOG } from '@shared/personnel-authority.interface';
import { PERSONNEL_SOURCE_MAX_AGE_MS, type PersonnelSourceMutation, type PersonnelSourcePreview } from '@shared/personnel-source.interface';
import { changePersonnelSource, previewPersonnelSource } from './api';
import { PersonnelBaselinePanel } from './PersonnelBaselinePanel';

const labels = { active: '正常', pending: '待确认交接', error: '核对异常', paused: '已暂停' } as const;
type Phase = 'idle' | 'loading' | 'ready' | 'submitting' | 'success' | 'error';
function storedRequest(key: string): PersonnelSourceMutation | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    const value = JSON.parse(raw);
    if (value && Object.keys(value).sort().join(',') === 'action,clientMutationId,expectedDirectoryVersion,expectedRevision' &&
      ['activate','pause'].includes(value.action) && /^[A-Za-z0-9_-]{12,160}$/.test(value.clientMutationId) && /^[a-f0-9]{64}$/.test(value.expectedDirectoryVersion) &&
      Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0) return value;
  } catch { /* An unreadable draft cannot authorize a new request. */ }
}

export function PersonnelSourcePanel({ data, accountId, onSaved }: { data: AccessConfigurationResponse; accountId: string; onSaved: (value: AccessConfigurationResponse) => void }) {
  const key = `vnet-personnel-source:${accountId}`;
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<PersonnelSourcePreview>();
  const [acknowledged, setAcknowledged] = useState(false), [query, setQuery] = useState(''), [visible, setVisible] = useState(50);
  const request = useRef<PersonnelSourceMutation | undefined>(storedRequest(key));
  const [unknownResult, setUnknownResult] = useState(!!request.current);
  const busy = useRef(false), sequence = useRef(0);
  const latestRevision = useRef(data.revision); latestRevision.current = data.revision;
  useEffect(() => {
    sequence.current++; request.current = storedRequest(key); busy.current = false;
    setUnknownResult(!!request.current); setPreview(undefined); setAcknowledged(false); setPhase('idle'); setError(''); setNotice('');
    return () => { sequence.current++; };
  }, [key]);
  const source = data.personnelSource;
  const outdated = !!source && Date.now() - source.lastSuccessAt > PERSONNEL_SOURCE_MAX_AGE_MS;
  const rows = useMemo<PersonnelSourcePreview['rows']>(() => preview?.rows || Object.entries(source?.routes || {}).map(([id, rule]) => {
    const pending = source?.pending.find(item => item.dutyRecordId === id);
    return { dutyRecordId: id, name: pending?.name || AUTHORITY_DUTY_CATALOG.find(item => item.id === rule.kind)!.label,
      kind: rule.kind, buildings: rule.buildings, specialties: rule.specialties, members: rule.members.map(person => person.name),
      status: pending ? 'unconfirmed' as const : 'aligned' as const, ...(pending ? { reason: pending.reason } : {}) };
  }), [preview, source]);
  const filtered = useMemo(() => rows.filter(row => !query || `${row.name} ${row.members.join(' ')} ${row.buildings?.join(' ')} ${row.specialties?.join(' ')}`.includes(query)), [rows, query]);
  const currentPreview = !!preview?.canActivate && preview.configurationRevision === data.revision && Date.now() - preview.checkedAt <= 5 * 60_000;

  async function check() {
    if (busy.current) return;
    busy.current = true; const token = ++sequence.current;
    setPhase('loading'); setError(''); setNotice(''); setAcknowledged(false);
    try { const result = await previewPersonnelSource(); if (token === sequence.current) { setPreview(result); setVisible(50); setPhase('ready'); } }
    catch (failure) { if (token === sequence.current) { setError((failure as Error).message); setPhase('error'); } }
    finally { if (token === sequence.current) busy.current = false; }
  }
  async function submit(action: 'activate' | 'pause') {
    if (busy.current) return;
    if (!request.current && action === 'activate' && (!acknowledged || !currentPreview)) return;
    if (!request.current && action === 'pause' && !source) return;
    const input = request.current || { action, clientMutationId: crypto.randomUUID(), expectedRevision: data.revision,
      expectedDirectoryVersion: action === 'pause' ? source!.directoryVersion : preview!.directoryVersion };
    busy.current = true; const token = ++sequence.current;
    setPhase('submitting'); setError(''); setNotice('');
    try {
      try { sessionStorage.setItem(key, JSON.stringify(input)); }
      catch { throw new Error('暂时无法保留操作草稿，请稍后重试'); }
      request.current = input;
      const result = await changePersonnelSource(input);
      if (token !== sequence.current) return;
      const newerConfiguration = result.revision < latestRevision.current;
      if (!newerConfiguration) onSaved(result);
      request.current = undefined; setUnknownResult(false); setPreview(undefined); setAcknowledged(false);
      try { sessionStorage.removeItem(key); } catch { /* The persisted server mutation makes an old browser draft safe to replay. */ }
      setNotice(newerConfiguration ? '配置已有后续更新，请核对当前状态' : result.personnelSource?.status === 'paused' ? '岗位来源已暂停，相关新办理暂缓' : '岗位来源配置已保存'); setPhase('success');
    } catch (failure) {
      if (token !== sequence.current) return;
      if ((failure as { status?: number }).status === 409) {
        request.current = undefined; setUnknownResult(false); setPreview(undefined); setAcknowledged(false);
        try { sessionStorage.removeItem(key); } catch { /* No operation is retried automatically. */ }
      } else setUnknownResult(!!request.current);
      setError((failure as Error).message); setPhase('error');
    } finally { if (token === sequence.current) busy.current = false; }
  }
  return <section className="space-y-4" aria-label="岗位来源管理">
    {!source&&<PersonnelBaselinePanel data={data} accountId={accountId} onSaved={onSaved}/>}
    <Card><CardContent className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><div className="flex flex-wrap items-center gap-2"><ShieldCheck className="size-5 text-primary" /><h2 className="font-semibold">统一岗位来源</h2><Badge variant="outline">{source ? source.status === 'paused' ? labels.paused : outdated ? '需重新核对' : labels[source.status] : '未启用'}</Badge></div>
        <p className="text-sm text-muted-foreground">{source ? `已接管 ${Object.keys(source.routes).length} 项职责` : '当前沿用现有岗位配置'}</p>
        {source && <p className="text-xs text-muted-foreground">上次核对：{new Date(source.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })} · 每日 02:00 同步</p>}
      </div><Button variant="outline" disabled={phase === 'loading' || phase === 'submitting'} onClick={() => void check()}>{phase === 'loading' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{phase === 'loading' ? '正在核对…' : '核对来源'}</Button></div>
      {(error || source?.error) && <p className="break-words text-sm text-destructive" role="alert">{error || source?.error}</p>}
      {notice && <p className="flex items-center gap-2 text-sm text-primary" role="status"><CheckCircle2 className="size-4" />{notice}</p>}
      {preview?.problems.length ? <div className="space-y-1 rounded-lg border border-destructive/30 p-3" role="alert">{preview.problems.map(problem => <p className="break-words text-sm text-destructive" key={problem}>{problem}</p>)}</div> : null}
      {!!preview?.unmanagedKinds?.length && <p className="break-words text-xs text-muted-foreground">以下职责尚未接管，继续使用现有配置：{preview.unmanagedKinds.map(kind=>AUTHORITY_DUTY_CATALOG.find(duty=>duty.id===kind)!.label).join('、')}。</p>}
      {preview && preview.configurationRevision !== data.revision && <p role="status" className="text-sm text-muted-foreground">配置已变化，请重新核对。</p>}
      {source?.pending.length ? <div className="space-y-1 rounded-lg border p-3">{source.pending.map(item => <p key={item.dutyRecordId} className="break-words text-sm">{item.name}：{item.reason}</p>)}</div> : null}
      {unknownResult ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><p className="text-sm">上次操作结果尚未确认，请使用原请求重试。</p><Button disabled={phase === 'submitting' || phase === 'loading'} onClick={() => void submit(request.current!.action)}>{phase === 'submitting' ? '正在确认…' : '重试确认结果'}</Button></div> : <div className="flex flex-wrap items-end justify-between gap-4 border-t pt-4"><div className="space-y-2"><label className="flex items-start gap-2 text-sm"><Checkbox checked={acknowledged} disabled={!currentPreview || phase === 'submitting'} onCheckedChange={value => setAcknowledged(value === true)} aria-label="已核对全部职责人员及授权" /><span>已核对全部 {preview?.rows.length || 0} 项职责人员及现有授权</span></label><p className="text-xs text-muted-foreground">岗位换人需先完成岗位交接，页面读取权限不代表审批权限。</p></div><div className="flex flex-wrap gap-2">
        {source && source.status !== 'paused' && <Button variant="outline" disabled={phase === 'submitting' || phase === 'loading'} onClick={() => void submit('pause')}>暂停新办理</Button>}
        <Button disabled={!currentPreview || !acknowledged || phase === 'submitting' || phase === 'loading'} onClick={() => void submit('activate')}>{phase === 'submitting' ? '正在保存…' : source?.status === 'paused' ? '恢复岗位来源' : source ? '应用核对结果' : '启用岗位来源'}</Button>
      </div></div>}
      {source && <p className="text-xs text-muted-foreground">暂停后，已接管岗位的新办理将等待恢复，已受理事项和历史结果保留。</p>}
    </CardContent></Card>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">职责核对 · {rows.length} 项</h3><input className="config-select w-full sm:max-w-sm" aria-label="搜索来源职责人员" placeholder="搜索职责、姓名、楼栋或专业" value={query} maxLength={128} onChange={event => { setQuery(event.target.value); setVisible(50); }} /></div>
    <div className="divide-y rounded-lg border bg-card">{filtered.slice(0, visible).map(row => <article key={row.dutyRecordId} className="grid gap-2 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"><p className="break-words text-sm font-medium">{row.name}</p><p className="break-words text-sm">{row.members.join('、') || '待核对人员'}</p><p className="break-words text-sm text-muted-foreground">{row.buildings?.join('、') || '全基地'} · {row.specialties?.join('、') || '全部专业'}</p><Badge variant="outline" className="h-fit w-fit">{row.status === 'aligned' ? '已对齐' : '待确认'}</Badge>{row.reason && <p className="break-words text-sm text-destructive md:col-span-4">{row.reason}</p>}</article>)}
      {!filtered.length && <p className="p-8 text-center text-sm text-muted-foreground" role="status">{query ? '没有匹配结果' : phase === 'loading' ? '正在核对岗位资料…' : preview ? '尚无可核对职责，请先补齐岗位关联' : '核对来源后查看职责清单'}</p>}
    </div>{filtered.length > visible && <Button variant="outline" onClick={() => setVisible(value => value + 50)}>显示更多（{filtered.length - visible}）</Button>}
  </section>;
}
