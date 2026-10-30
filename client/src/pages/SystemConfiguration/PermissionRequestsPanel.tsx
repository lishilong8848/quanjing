import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { createPermissionCatalog } from '@shared/permission-catalog';
import type { PersonnelPermissionRequest } from '@shared/personnel-permission-request.interface';
import { listPermissionRequests, reviewPermissionRequest } from '@/api/personal-access';
import { createPersonalMutationIdentity } from '@/access/personal-password.logic';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PermissionRequestList } from '../PersonalCenter/PermissionRequestList';
import { mergeVersionedRows } from './configuration-helpers';
import { downloadDisplayRecords, permissionRequestExport } from './request-export';

const catalog = createPermissionCatalog();
export function PermissionRequestsPanel({ revision, onEditAccount, onPendingCount }: { revision: number; onEditAccount: (accountId: string, request?: PersonnelPermissionRequest) => boolean; onPendingCount?: (count: number) => void }) {
  const [requests, setRequests] = useState<PersonnelPermissionRequest[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [comments, setComments] = useState<Record<string, string>>({}), [pendingId, setPendingId] = useState(''), [filter, setFilter] = useState('pending');
  const [query, setQuery] = useState('');
  const loadingRef = useRef(false), pendingRef = useRef(false), alive = useRef(true);
  const readEpoch = useRef(0), loaded = useRef(false);
  const mutations = useRef(new Map<string, ReturnType<typeof createPersonalMutationIdentity>>());
  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true; setLoading(true);
    const epoch = readEpoch.current;
    try { const result = await listPermissionRequests(); if (alive.current && epoch === readEpoch.current) { loaded.current = true; setRequests(current => mergeVersionedRows(current, result).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); setError(''); } }
    catch (failure) { if (alive.current && epoch === readEpoch.current) setError((failure as Error).message); }
    finally { loadingRef.current = false; if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutations.current.clear(); }; }, []);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  useEffect(() => { if (loaded.current) onPendingCount?.(requests.filter(request => request.status === 'pending').length); }, [requests, onPendingCount]);
  async function review(request: PersonnelPermissionRequest, decision: 'approve' | 'reject') {
    if (pendingRef.current) return;
    const comment = (comments[request.id] || '').trim();
    if (decision === 'reject' && !comment) { setError('驳回申请时请填写审核说明'); return; }
    const body = { requestId: request.id, expectedRequestVersion: request.version, decision, ...(comment ? { comment } : {}) };
    const identity = mutations.current.get(request.id) || createPersonalMutationIdentity(); mutations.current.set(request.id, identity);
    pendingRef.current = true; readEpoch.current++; setPendingId(request.id); setError('');
    try {
      const result = await reviewPermissionRequest({ ...body, clientMutationId: identity.forPayload(body) });
      if (!alive.current) return;
      setRequests(current => mergeVersionedRows(current, [result]));
      setComments(current => { const next = { ...current }; delete next[result.id]; return next; }); mutations.current.delete(result.id);
    } catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pendingRef.current = false; if (alive.current) setPendingId(''); }
  }
  const visible = requests.filter(request => (filter === 'all' || request.status === filter) && (!query.trim() || request.applicantName.includes(query.trim())));
  return <section className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">权限申请</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">先在账号权限中配置并保存，再确认授权。系统会核验所申请权限已实际生效。</p></div><Button variant="outline" disabled={loading || !!pendingId} onClick={() => void refresh()}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新申请</Button></header>
    <label className="flex flex-wrap items-center gap-3 text-sm"><span>申请状态</span><select className="config-select" value={filter} onChange={event => setFilter(event.target.value)}><option value="pending">待审核</option><option value="approved">已授权</option><option value="rejected">已驳回</option><option value="cancelled">已撤回</option><option value="all">全部</option></select></label>
    <Input aria-label="搜索申请人员" placeholder="搜索申请人员" className="sm:max-w-sm" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">导出当前筛选记录，仅包含展示内容；不会删除或归档申请。</p><Button variant="outline" size="sm" disabled={!visible.length} onClick={() => downloadDisplayRecords('权限申请', permissionRequestExport(visible))}>导出记录 JSON</Button></div>
    {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {loading && !requests.length ? <p role="status" className="rounded-lg border p-8 text-center text-sm text-muted-foreground">正在读取权限申请…</p> : <PermissionRequestList requests={visible} catalog={catalog} admin externallyFiltered filterKey={`${filter}:${query}`} actions={request => request.status === 'pending' ? <div className="space-y-3 border-t pt-3">
      <label className="grid gap-2 text-sm"><span>审核说明（驳回必填）</span><textarea className="config-select min-h-20 w-full resize-y" maxLength={500} value={comments[request.id] || ''} disabled={!!pendingId} onChange={event => setComments(current => ({ ...current, [request.id]: event.target.value }))} /></label>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!!pendingId} onClick={() => { setError(''); if (!onEditAccount(request.accountId, request)) setError('当前配置中未找到该账号，请刷新人员配置后再审核'); }}>配置权限</Button><Button type="button" disabled={!!pendingId} aria-busy={pendingId === request.id} onClick={() => void review(request, 'approve')}>{pendingId === request.id && <Loader2 className="size-4 animate-spin" />}确认授权</Button><Button type="button" variant="outline" disabled={!!pendingId} onClick={() => void review(request, 'reject')}>驳回</Button></div>
    </div> : null} />}
  </section>;
}
