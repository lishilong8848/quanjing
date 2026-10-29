import { useState, type ReactNode } from 'react';
import type { PersonnelPermissionRequest } from '@shared/personnel-permission-request.interface';
import type { PersonalPermissionCatalog } from '@/api/personal-access';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { permissionRequestLabel } from './permission-request.logic';

export function PermissionRequestList({ requests, catalog, admin = false, actions }: { requests: PersonnelPermissionRequest[]; catalog: PersonalPermissionCatalog; admin?: boolean; actions?: (request: PersonnelPermissionRequest) => ReactNode }) {
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(requests.length / 20) - 1), safePage = Math.min(page, lastPage);
  return <div className="space-y-4">{requests.slice(safePage * 20, safePage * 20 + 20).map(request => <article key={request.id} className="space-y-3 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{admin ? request.applicantName : '权限申请'}<span className="ml-2 font-normal text-muted-foreground">{new Date(request.createdAt).toLocaleString('zh-CN', { hour12: false })}</span></h3><Badge variant={request.status === 'pending' ? 'secondary' : 'outline'}>{({ pending: '待审核', approved: '已授权', rejected: '已驳回' })[request.status]}</Badge></div>
    <ul className="space-y-2 text-sm">{request.permissions.map((permission, index) => <li key={index} className="break-words">{permissionRequestLabel(permission, catalog)}</li>)}</ul>
    <p className="whitespace-pre-wrap break-words text-sm leading-6"><span className="text-muted-foreground">申请理由：</span>{request.reason}</p>
    {request.comment && <p className="whitespace-pre-wrap break-words text-sm leading-6"><span className="text-muted-foreground">审核说明：</span>{request.comment}</p>}
    {request.reviewerName && <p className="text-xs text-muted-foreground">{request.reviewerName} · {new Date(request.updatedAt).toLocaleString('zh-CN', { hour12: false })}</p>}
    {actions?.(request)}
  </article>)}
    {!requests.length && <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">暂无权限申请</p>}
    {requests.length > 20 && <div className="flex items-center justify-end gap-3 text-sm"><Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</Button><span>{safePage + 1} / {lastPage + 1}</span><Button variant="outline" size="sm" disabled={safePage === lastPage} onClick={() => setPage(safePage + 1)}>下一页</Button></div>}
  </div>;
}
