import { useMemo } from 'react';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { BUILDING_ADMIN_BUILDINGS } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { BUSINESS_ACTION_LABELS, businessModuleDefinition, createBusinessPermissionEvaluator, personalPermissionPagePaths } from '@shared/business-permissions';
import { PAGE_ACCESS_CATALOG } from '@shared/page-access';
import type { RequestedPermission } from '@shared/personnel-permission-request.interface';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function requestedPermissionState(principal: AccessPrincipal, permission: RequestedPermission) {
  if (permission.kind === 'page') return { label: PAGE_ACCESS_CATALOG.find(page => page.path === permission.path)?.label || permission.path,
    missing: personalPermissionPagePaths(principal, principal.effectiveAuthorization?.baseline.pages || []).includes(permission.path) ? [] : ['页面读取未授权'], path: permission.path };
  const definition = businessModuleDefinition(permission.module), evaluate = createBusinessPermissionEvaluator(principal);
  const points: Array<{ building?: typeof BUILDING_ADMIN_BUILDINGS[number]; specialty?: typeof PROFESSIONAL_SPECIALTIES[number] }> = definition.scoped ? (permission.buildings || BUILDING_ADMIN_BUILDINGS).flatMap(building => (permission.specialties || PROFESSIONAL_SPECIALTIES).map(specialty => ({ building, specialty }))) : [{}];
  const missing = points.filter(point => !evaluate({ module: permission.module, action: permission.action, ...point }).allowed)
    .map(point => point.building ? `${point.building} · ${point.specialty}` : '该操作未授权');
  return { label: `${definition.label} · ${BUSINESS_ACTION_LABELS[permission.action]}`, path: definition.page, missing };
}
export function RequestedPermissionSummary({ permissions, principal, onLocate }: { permissions: RequestedPermission[]; principal: AccessPrincipal; onLocate?: (permission: RequestedPermission) => void }) {
  const rows = useMemo(() => permissions.map(permission => ({ permission, ...requestedPermissionState(principal, permission) })), [permissions, principal]);
  return <section className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3" aria-label="申请权限核对"><h3 className="text-sm font-medium">本次申请 · {rows.filter(row => row.missing.length).length} 项待补齐</h3>
    {rows.map((row, index) => <div key={index} className="space-y-1 border-t pt-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>{row.label}</span><div className="flex items-center gap-2"><Badge variant={row.missing.length ? 'outline' : 'secondary'}>{row.missing.length ? '待补齐' : '已满足'}</Badge>{onLocate && <Button type="button" variant="link" size="sm" onClick={() => onLocate(row.permission)}>定位</Button>}</div></div>{row.permission.kind === 'action' && <p className="text-xs text-muted-foreground">申请范围：{row.permission.buildings?.join('、') || '全部楼栋'} · {row.permission.specialties?.join('、') || '全部专业'}</p>}{!!row.missing.length && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看缺少的权限或范围（{row.missing.length}）</summary><p className="mt-1 break-words">{row.missing.join('；')}</p></details>}</div>)}
    <p className="text-xs text-muted-foreground">按当前草稿核对。保存后才能确认授权，实际办理仍须满足单据及岗位条件。</p>
  </section>;
}
