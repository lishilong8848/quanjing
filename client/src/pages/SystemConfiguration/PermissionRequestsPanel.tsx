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
export function PermissionRequestsPanel({ revision, onEditAccount, onPendingCount, focusRequestId, focusNavigationKey, onGranted }: { revision: number; onEditAccount: (accountId: string, request?: PersonnelPermissionRequest) => boolean; onPendingCount?: (count: number) => void; focusRequestId?: string; focusNavigationKey?: string; onGranted?: (request: PersonnelPermissionRequest) => Promise<unknown> | void }) {
  const [requests, setRequests] = useState<PersonnelPermissionRequest[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [comments, setComments] = useState<Record<string, string>>({}), [pendingId, setPendingId] = useState(''), [filter, setFilter] = useState('pending');
  const [query, setQuery] = useState('');
  const [focusedId, setFocusedId] = useState(focusRequestId || ''), [notice, setNotice] = useState('');
  const [confirmedVersions, setConfirmedVersions] = useState<Record<string, number>>({});
  const focusAnchor = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false), pendingRef = useRef(false), alive = useRef(true);
  const readEpoch = useRef(0), loaded = useRef(false);
  const feedbackEpoch = useRef(0);
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
  useEffect(() => {
    feedbackEpoch.current++; setNotice(''); setError('');
    setFocusedId(focusRequestId || '');
    if (focusRequestId) { setFilter('all'); setQuery(''); void refresh(); }
  }, [focusRequestId, focusNavigationKey, refresh]);
  useEffect(() => { if (focusedId && requests.some(request => request.id === focusedId)) focusAnchor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [focusedId, requests]);
  useEffect(() => { if (loaded.current) onPendingCount?.(requests.filter(request => request.status === 'pending').length); }, [requests, onPendingCount]);
  async function review(request: PersonnelPermissionRequest, decision: 'approve' | 'reject') {
    if (pendingRef.current) return;
    if (decision === 'approve' && confirmedVersions[request.id] !== request.version) { setError('请先核对本次申请的页面、操作和范围，并勾选确认'); return; }
    const comment = (comments[request.id] || '').trim();
    if (decision === 'reject' && !comment) { setError('驳回申请时请填写审核说明'); return; }
    const body = { requestId: request.id, expectedRequestVersion: request.version, decision, ...(comment ? { comment } : {}) };
    const submittedFeedbackEpoch = feedbackEpoch.current;
    const identity = mutations.current.get(request.id) || createPersonalMutationIdentity(); mutations.current.set(request.id, identity);
    pendingRef.current = true; readEpoch.current++; setPendingId(request.id); setError(''); setNotice('');
    try {
      const result = await reviewPermissionRequest({ ...body, clientMutationId: identity.forPayload(body) });
      if (!alive.current) return;
      if (result.id !== request.id || !['approved', 'rejected'].includes(result.status)) throw new Error('申请处理结果待核对，请刷新后查看');
      setRequests(current => mergeVersionedRows(current, [result]));
      setComments(current => { const next = { ...current }; delete next[result.id]; return next; }); mutations.current.delete(result.id);
      setConfirmedVersions(current => { const next = { ...current }; delete next[result.id]; return next; });
      // A replay may discover an earlier completed grant even after a rejection click.
      if (submittedFeedbackEpoch === feedbackEpoch.current) setNotice(result.status === 'approved' ? '申请已授权。实际办理仍须符合审批职责和单据状态。' : '申请已驳回，未新增权限。');
      if (result.status === 'approved') {
        try { await onGranted?.(result); }
        catch { if (alive.current && submittedFeedbackEpoch === feedbackEpoch.current) setError('授权结果已保存，最新配置读取失败，请刷新配置后查看。'); }
      }
    } catch (failure) { if (alive.current && submittedFeedbackEpoch === feedbackEpoch.current) setError((failure as Error).message); }
    finally { pendingRef.current = false; if (alive.current) setPendingId(''); }
  }
  const visible = requests.filter(request => focusedId ? request.id === focusedId : (filter === 'all' || request.status === filter) && (!query.trim() || request.applicantName.includes(query.trim())));
  return <section className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">权限申请</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">核对申请后可直接同意并授权，只授予申请的页面、操作和范围，不变更角色。审批职责和单据状态要求保持不变。</p></div><Button variant="outline" disabled={loading || !!pendingId} onClick={() => void refresh()}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新申请</Button></header>
    {focusedId && <div ref={focusAnchor} className="scroll-mt-24 rounded-lg border bg-primary/5 p-3 text-sm" role="status"><div className="flex flex-wrap items-center justify-between gap-3"><p>{loaded.current && !visible.length ? '未找到卡片中的申请，请刷新列表核对。' : '正在查看卡片中的申请，待处理和已处理记录均可查看。'}</p><Button type="button" variant="outline" size="sm" onClick={() => { setFocusedId(''); setFilter('all'); setQuery(''); }}>查看全部申请</Button></div></div>}
    <label className="flex flex-wrap items-center gap-3 text-sm"><span>申请状态</span><select className="config-select" value={filter} onChange={event => { setFocusedId(''); setFilter(event.target.value); }}><option value="pending">待审核</option><option value="approved">已授权</option><option value="rejected">已驳回</option><option value="cancelled">已撤回</option><option value="all">全部</option></select></label>
    <Input aria-label="搜索申请人员" placeholder="搜索申请人员" className="sm:max-w-sm" value={query} onChange={event => { setFocusedId(''); setQuery(event.target.value); }} />
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">导出当前筛选记录，仅包含展示内容；不会删除或归档申请。</p><Button variant="outline" size="sm" disabled={!visible.length} onClick={() => downloadDisplayRecords('权限申请', permissionRequestExport(visible))}>导出记录 JSON</Button></div>
    {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-lg border bg-primary/5 p-3 text-sm text-primary">{notice}</p>}
    {loading && !requests.length ? <p role="status" className="rounded-lg border p-8 text-center text-sm text-muted-foreground">正在读取权限申请…</p> : <PermissionRequestList requests={visible} catalog={catalog} admin externallyFiltered filterKey={`${focusedId}:${filter}:${query}`} actions={request => request.status === 'pending' ? <div className="space-y-3 border-t pt-3">
      <label className="grid gap-2 text-sm"><span>审核说明（驳回必填）</span><textarea className="config-select min-h-20 w-full resize-y" maxLength={500} value={comments[request.id] || ''} disabled={!!pendingId} onChange={event => setComments(current => ({ ...current, [request.id]: event.target.value }))} /></label>
      <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1" checked={confirmedVersions[request.id] === request.version} disabled={!!pendingId} onChange={event => setConfirmedVersions(current => { const next = { ...current }; if (event.target.checked) next[request.id] = request.version; else delete next[request.id]; return next; })} />我已核对上方页面、操作及楼栋／专业范围，同意后直接授予这些权限。</label>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!!pendingId} onClick={() => { setError(''); if (!onEditAccount(request.accountId, request)) setError('当前配置中未找到该账号，请刷新人员配置后再审核'); }}>配置权限</Button><Button type="button" disabled={!!pendingId || confirmedVersions[request.id] !== request.version} aria-busy={pendingId === request.id} onClick={() => void review(request, 'approve')}>{pendingId === request.id && <Loader2 className="size-4 animate-spin" />}同意并授权</Button><Button type="button" variant="outline" disabled={!!pendingId} onClick={() => void review(request, 'reject')}>驳回</Button></div>
    </div> : null} />}
  </section>;
}
