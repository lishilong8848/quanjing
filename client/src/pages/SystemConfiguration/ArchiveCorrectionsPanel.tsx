import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS, type PersonnelArchiveCorrection } from '@shared/personnel-archive-correction.interface';
import { listAdminArchiveCorrections, reviewArchiveCorrection } from '@/api/personal-access';
import { createPersonalMutationIdentity } from '@/access/personal-password.logic';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { mergeVersionedRows } from './configuration-helpers';
import { archiveCorrectionExport, downloadDisplayRecords } from './request-export';

const labels = { pending: '待处理', resolved: '已处理', rejected: '已驳回', cancelled: '已撤回' };
export function ArchiveCorrectionsPanel({ onPendingCount }: { onPendingCount?: (count: number) => void }) {
  const [rows, setRows] = useState<PersonnelArchiveCorrection[]>([]), [comments, setComments] = useState<Record<string, string>>({}), [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('pending'), [page, setPage] = useState(0);
  const alive = useRef(true), reading = useRef(false), writing = useRef(false), readEpoch = useRef(0), loaded = useRef(false);
  const mutations = useRef(new Map<string, ReturnType<typeof createPersonalMutationIdentity>>());
  const refresh = useCallback(async () => {
    if (reading.current) return; reading.current = true; setLoading(true); const epoch = readEpoch.current;
    try { const result = await listAdminArchiveCorrections(); if (alive.current && epoch === readEpoch.current) { loaded.current = true; setRows(current => mergeVersionedRows(current, result).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); setError(''); } }
    catch (failure) { if (alive.current && epoch === readEpoch.current) setError((failure as Error).message); }
    finally { reading.current = false; if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; mutations.current.clear(); }; }, [refresh]);
  useEffect(() => { if (loaded.current) onPendingCount?.(rows.filter(row => row.status === 'pending').length); }, [rows, onPendingCount]);
  async function review(row: PersonnelArchiveCorrection, decision: 'resolve' | 'reject') {
    if (writing.current) return;
    const comment = (comments[row.id] || '').trim();
    if (!comment) { setError('请填写处理说明，便于申请人核对结果'); return; }
    if (decision === 'resolve' && !acknowledged[row.id]) { setError('请先核对源人员资料并确认处理结果'); return; }
    const body = { requestId: row.id, expectedRequestVersion: row.version, decision, comment };
    const identity = mutations.current.get(row.id) || createPersonalMutationIdentity(); mutations.current.set(row.id, identity);
    writing.current = true; readEpoch.current++; setPending(row.id); setError('');
    try { const result = await reviewArchiveCorrection({ ...body, clientMutationId: identity.forPayload(body) }); if (!alive.current) return; setRows(current => mergeVersionedRows(current, [result])); setComments(current => { const next = { ...current }; delete next[row.id]; return next; }); setAcknowledged(current => ({ ...current, [row.id]: false })); mutations.current.delete(row.id); }
    catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { writing.current = false; if (alive.current) setPending(''); }
  }
  const filtered = rows.filter(row => (filter === 'all' || row.status === filter) && (!query.trim() || `${row.applicantName} ${row.description}`.includes(query.trim())));
  const safePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  return <section className="space-y-4" aria-label="资料纠错处理"><header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">资料纠错</h2><p className="mt-1 text-sm text-muted-foreground">先核对并维护源人员资料，再填写处理结果；此处不会自动修改人员表。</p></div><Button variant="outline" disabled={loading || !!pending} onClick={() => void refresh()}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新申请</Button></header>
    <div className="flex flex-wrap gap-3"><Input className="min-w-40 flex-1" aria-label="搜索资料纠错" placeholder="搜索姓名或纠错说明" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /><select aria-label="资料纠错状态" className="config-select" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}><option value="all">全部状态</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}，未提交的说明保留。</p>}
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">导出当前筛选展示记录，不会删除或归档申请。</p><Button variant="outline" size="sm" disabled={!filtered.length} onClick={() => downloadDisplayRecords('资料纠错', archiveCorrectionExport(filtered))}>导出记录 JSON</Button></div>
    {loading && !loaded.current ? <p role="status" className="p-8 text-center text-sm text-muted-foreground">正在读取纠错申请…</p> : <div className="space-y-3">{filtered.slice(safePage * 20, (safePage + 1) * 20).map(row => <article key={row.id} className="space-y-3 rounded-lg border bg-card p-4"><header className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{row.applicantName}</h3><Badge variant={row.status === 'pending' ? 'secondary' : 'outline'}>{labels[row.status]}</Badge></header><p className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })} · {row.fields.map(field => PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS[field]).join('、')}</p><p className="whitespace-pre-wrap break-words text-sm">{row.description}</p>{row.comment && <p className="whitespace-pre-wrap break-words text-sm">处理说明：{row.comment}</p>}{row.reviewerName && <p className="text-xs text-muted-foreground">{row.reviewerName} · {new Date(row.updatedAt).toLocaleString('zh-CN', { hour12: false })}</p>}{row.status === 'pending' && <div className="space-y-3 border-t pt-3"><label className="grid gap-2 text-sm"><span>处理说明</span><textarea className="config-select min-h-20 w-full resize-y" maxLength={1000} value={comments[row.id] || ''} disabled={!!pending} placeholder="说明已核对和修正的资料，或无法处理的原因；不要填写密码或完整身份证号" onChange={event => setComments(current => ({ ...current, [row.id]: event.target.value }))} /></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={!!pending} checked={!!acknowledged[row.id]} onChange={event => setAcknowledged(current => ({ ...current, [row.id]: event.target.checked }))} />已核对源资料与处理结果</label><div className="flex flex-wrap gap-2"><Button disabled={!!pending || !acknowledged[row.id]} onClick={() => void review(row, 'resolve')}>{pending === row.id && <Loader2 className="size-4 animate-spin" />}确认已处理</Button><Button variant="outline" disabled={!!pending} onClick={() => void review(row, 'reject')}>驳回</Button></div></div>}</article>)}{!filtered.length && <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">没有符合条件的纠错申请</p>}</div>}
    {filtered.length > 20 && <div className="flex items-center justify-end gap-3 text-sm"><Button variant="outline" size="sm" disabled={!safePage} onClick={() => setPage(safePage - 1)}>上一页</Button><span>{safePage + 1} / {Math.ceil(filtered.length / 20)}</span><Button variant="outline" size="sm" disabled={(safePage + 1) * 20 >= filtered.length} onClick={() => setPage(safePage + 1)}>下一页</Button></div>}
  </section>;
}
