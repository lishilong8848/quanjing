import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PersonnelPermissionRequest } from '@shared/personnel-permission-request.interface';
import { cancelPermissionRequest, updatePermissionRequest, type PersonalPermissionCatalog } from '@/api/personal-access';
import { createPersonalMutationIdentity } from '@/access/personal-password.logic';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { permissionRequestLabel } from './permission-request.logic';

export const PERMISSION_REQUEST_STATUS_LABELS = { pending: '待审核', approved: '审核通过', rejected: '已驳回', cancelled: '已撤回' } as const;
export function PermissionRequestList({ requests, catalog, admin = false, actions, onUpdated, readOnly = false, externallyFiltered = false, filterKey }: { requests: PersonnelPermissionRequest[]; catalog: PersonalPermissionCatalog; admin?: boolean; actions?: (request: PersonnelPermissionRequest) => ReactNode; onUpdated?: (request: PersonnelPermissionRequest) => void; readOnly?: boolean; externallyFiltered?: boolean; filterKey?: string }) {
  const [page, setPage] = useState(0), [status, setStatus] = useState('all'), [query, setQuery] = useState('');
  const filtered = useMemo(() => externallyFiltered ? requests : requests.filter(request => (status === 'all' || request.status === status) && (!query.trim() || [request.applicantName, request.reason, request.comment, ...request.permissions.map(permission => permissionRequestLabel(permission, catalog))].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [requests, status, query, catalog, externallyFiltered]);
  useEffect(() => { if (externallyFiltered) setPage(0); }, [filterKey, externallyFiltered]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / 20) - 1), safePage = Math.min(page, lastPage);
  return <div className="space-y-4">{!externallyFiltered && <div className="flex flex-wrap gap-3"><input className="config-select min-w-0 flex-1" aria-label="搜索权限申请" placeholder="搜索功能、理由或审核说明" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /><select className="config-select" aria-label="权限申请状态" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="all">全部状态</option>{Object.entries(PERMISSION_REQUEST_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}
    <p className="text-xs text-muted-foreground">共 {filtered.length} 条。审核通过是历史处理结果，当前权限以“我的权限”及下方生效状态为准。</p>
    {filtered.slice(safePage * 20, safePage * 20 + 20).map(request => <article key={request.id} className="space-y-3 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{admin ? request.applicantName : '权限申请'}<span className="ml-2 font-normal text-muted-foreground">{new Date(request.createdAt).toLocaleString('zh-CN', { hour12: false })}</span></h3><Badge variant={request.status === 'pending' ? 'secondary' : 'outline'}>{PERMISSION_REQUEST_STATUS_LABELS[request.status]}</Badge></div>
    <ul className="space-y-2 text-sm">{request.permissions.map((permission, index) => <li key={index} className="break-words">{permissionRequestLabel(permission, catalog)}</li>)}</ul>
    <p className="whitespace-pre-wrap break-words text-sm leading-6"><span className="text-muted-foreground">申请理由：</span>{request.reason}</p>
    {request.comment && <p className="whitespace-pre-wrap break-words text-sm leading-6"><span className="text-muted-foreground">审核说明：</span>{request.comment}</p>}
    {request.reviewerName && <p className="text-xs text-muted-foreground">{request.reviewerName} · {new Date(request.updatedAt).toLocaleString('zh-CN', { hour12: false })}</p>}
    {request.status === 'approved' && <p className="rounded-md bg-muted/40 p-2 text-xs leading-5">当前生效：{({ current: '申请范围现已具备；实际办理仍须满足职责和单据状态。', partial: '当前仅部分范围生效，请查看我的权限。', none: '当前已不具备此申请权限。', unavailable: '暂未核对，请刷新后查看。' })[request.currentEffect || 'unavailable']}</p>}
    {actions?.(request)}
    {!admin && !readOnly && onUpdated && request.status === 'pending' && <OwnRequestActions request={request} onUpdated={onUpdated} />}
  </article>)}
    {!filtered.length && <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">{requests.length ? '没有符合筛选条件的申请' : '暂无权限申请'}</p>}
    {filtered.length > 20 && <div className="flex items-center justify-end gap-3 text-sm"><Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</Button><span>{safePage + 1} / {lastPage + 1}</span><Button variant="outline" size="sm" disabled={safePage === lastPage} onClick={() => setPage(safePage + 1)}>下一页</Button></div>}
  </div>;
}

function OwnRequestActions({ request, onUpdated }: { request: PersonnelPermissionRequest; onUpdated: (request: PersonnelPermissionRequest) => void }) {
  const [editing, setEditing] = useState(false), [reason, setReason] = useState(request.reason), [version, setVersion] = useState(request.version);
  const [confirmCancel, setConfirmCancel] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const pending = useRef(false), alive = useRef(true), mutation = useRef(createPersonalMutationIdentity());
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutation.current.clear(); }; }, []);
  async function save(cancel = false) {
    if (pending.current) return;
    if (!cancel && !reason.trim()) { setError('请填写申请理由'); return; }
    const body = { requestId: request.id, expectedRequestVersion: cancel ? request.version : version, ...(!cancel ? { reason: reason.trim() } : {}) };
    pending.current = true; setBusy(cancel ? '正在撤回申请…' : '正在同步补充说明…'); setError('');
    try {
      const clientMutationId = mutation.current.forPayload({ operation: cancel ? 'cancel' : 'update', ...body });
      const result = cancel ? await cancelPermissionRequest({ ...body, clientMutationId }) : await updatePermissionRequest({ ...body, reason: reason.trim(), clientMutationId });
      onUpdated(result);
      if (alive.current) { setEditing(false); setConfirmCancel(false); mutation.current.clear(); }
    } catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(''); }
  }
  return <div className="space-y-3 border-t pt-3">
    {editing && <label className="grid gap-2 text-sm">补充申请理由<textarea className="config-select min-h-24 w-full" value={reason} maxLength={500} disabled={!!busy} onChange={event => setReason(event.target.value)} />{version !== request.version && <span className="text-amber-700">申请记录已有更新，草稿已保留。请核对新记录后重新打开编辑。</span>}</label>}
    {confirmCancel && <p className="text-sm">撤回后管理员将不再处理此申请，现有权限不变。确认撤回？</p>}
    {busy && <p role="status" className="text-sm text-muted-foreground">{busy}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">{editing ? <><Button size="sm" disabled={!!busy || version !== request.version} onClick={() => void save()}>保存说明</Button><Button size="sm" variant="outline" disabled={!!busy} onClick={() => setEditing(false)}>取消编辑</Button></> : !confirmCancel && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { setReason(request.reason); setVersion(request.version); setEditing(true); setError(''); }}>补充理由</Button>}
      {!editing && (confirmCancel ? <><Button size="sm" variant="outline" disabled={!!busy} onClick={() => void save(true)}>确认撤回</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmCancel(false)}>保留申请</Button></> : <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setConfirmCancel(true); setError(''); }}>撤回申请</Button>)}</div>
  </div>;
}
