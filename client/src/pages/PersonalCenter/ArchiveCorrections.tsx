import { useEffect, useMemo, useRef, useState } from 'react';
import { PERSONNEL_ARCHIVE_CORRECTION_FIELDS, PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS, type PersonnelArchiveCorrection, type PersonnelArchiveCorrectionField } from '@shared/personnel-archive-correction.interface';
import { cancelArchiveCorrection, createArchiveCorrection } from '@/api/personal-access';
import { createPersonalMutationIdentity } from '@/access/personal-password.logic';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const labels = { pending: '待核对', resolved: '已核对反馈', rejected: '未采纳', cancelled: '已撤回' } as const;

export function ArchiveCorrectionForm({ onSubmitted }: { onSubmitted: (row: PersonnelArchiveCorrection) => void }) {
  const [fields, setFields] = useState<PersonnelArchiveCorrectionField[]>([]), [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const pending = useRef(false), alive = useRef(true), mutation = useRef(createPersonalMutationIdentity());
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutation.current.clear(); }; }, []);
  async function submit() {
    if (pending.current) return;
    if (!fields.length || !description.trim()) { setError('请选择待核对的资料并填写说明'); return; }
    if (/(?<!\d)\d{17}[\dXx](?!\d)/u.test(description)) { setError('请勿填写完整身份证号，请仅说明需要核对的资料'); return; }
    const body = { fields, description: description.trim() };
    pending.current = true; setBusy(true); setError(''); setSuccess('');
    try {
      const row = await createArchiveCorrection({ ...body, clientMutationId: mutation.current.forPayload(body) });
      onSubmitted(row);
      if (alive.current) { setFields([]); setDescription(''); mutation.current.clear(); setSuccess('已提交资料核对申请，可在下方查看反馈。'); }
    } catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <form className="space-y-4 rounded-lg border bg-card p-4 md:p-6" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div><h2 className="font-semibold">资料核对申请</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">提交后由管理员核对人员档案并反馈，不会直接修改源表。请勿填写密码、完整身份证号码或无关人员信息。</p></div>
    <fieldset disabled={busy}><legend className="mb-2 text-sm font-medium">需要核对的资料</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{PERSONNEL_ARCHIVE_CORRECTION_FIELDS.map(field => <label key={field} className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm"><input type="checkbox" checked={fields.includes(field)} onChange={event => setFields(PERSONNEL_ARCHIVE_CORRECTION_FIELDS.filter(value => value === field ? event.target.checked : fields.includes(value)))} />{PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS[field]}</label>)}</div></fieldset>
    <label className="grid gap-2 text-sm"><span>核对说明</span><textarea className="config-select min-h-24 w-full" disabled={busy} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} placeholder="说明哪个资料需要核对，以及可供核实的情况" /></label>
    {busy && <p role="status" className="text-sm text-muted-foreground">正在同步核对申请，请保留当前内容…</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{success && <p role="status" className="text-sm text-primary">{success}</p>}
    <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? '正在提交…' : '提交核对申请'}</Button>
  </form>;
}

export function ArchiveCorrectionList({ rows, onUpdated, readOnly }: { rows: PersonnelArchiveCorrection[]; onUpdated: (row: PersonnelArchiveCorrection) => void; readOnly: boolean }) {
  const [status, setStatus] = useState('all'), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const filtered = useMemo(() => rows.filter(row => (status === 'all' || row.status === status) && (!query.trim() || [row.description, row.comment, ...row.fields.map(field => PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS[field])].join(' ').includes(query.trim()))), [rows, status, query]);
  const last = Math.max(0, Math.ceil(filtered.length / 20) - 1), current = Math.min(page, last);
  return <section className="space-y-4"><h2 className="font-semibold">核对记录与反馈</h2><div className="flex flex-wrap gap-3"><input className="config-select min-w-0 flex-1" aria-label="搜索资料核对记录" placeholder="搜索资料、说明或反馈" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /><select className="config-select" aria-label="资料核对状态" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="all">全部状态</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {filtered.slice(current * 20, current * 20 + 20).map(row => <article key={row.id} className="space-y-3 rounded-lg border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{row.fields.map(field => PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS[field]).join('、')}</h3><Badge variant={row.status === 'pending' ? 'secondary' : 'outline'}>{labels[row.status]}</Badge></div><p className="whitespace-pre-wrap break-words text-sm leading-6">{row.description}</p><p className="text-xs text-muted-foreground">提交于 {new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</p>{row.comment && <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm leading-6">管理员反馈：{row.comment}</p>}{row.status === 'resolved' && <p className="text-xs text-muted-foreground">此状态表示管理员已完成核对反馈；人员资料以刷新后的源表结果为准。</p>}{!readOnly && row.status === 'pending' && <CancelCorrection row={row} onUpdated={onUpdated} />}</article>)}
    {!filtered.length && <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">{rows.length ? '没有符合条件的核对记录' : '暂无核对记录'}</p>}
    {filtered.length > 20 && <div className="flex items-center justify-end gap-3 text-sm"><Button size="sm" variant="outline" disabled={!current} onClick={() => setPage(current - 1)}>上一页</Button><span>{current + 1} / {last + 1}</span><Button size="sm" variant="outline" disabled={current === last} onClick={() => setPage(current + 1)}>下一页</Button></div>}
  </section>;
}

function CancelCorrection({ row, onUpdated }: { row: PersonnelArchiveCorrection; onUpdated: (row: PersonnelArchiveCorrection) => void }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), alive = useRef(true), mutation = useRef(createPersonalMutationIdentity());
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutation.current.clear(); }; }, []);
  async function cancel() {
    if (pending.current) return;
    const body = { requestId: row.id, expectedRequestVersion: row.version };
    pending.current = true; setBusy(true); setError('');
    try { const result = await cancelArchiveCorrection({ ...body, clientMutationId: mutation.current.forPayload(body) }); onUpdated(result); }
    catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="space-y-2">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{busy && <p role="status" className="text-sm text-muted-foreground">正在同步撤回…</p>}{confirm ? <div className="flex flex-wrap items-center gap-2"><span className="text-sm">确认撤回此核对申请？</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}>确认撤回</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>保留申请</Button></div> : <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>撤回核对申请</Button>}</div>;
}
