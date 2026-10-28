import type { HandoverGrantChoice, HandoverPermissionOwnership, PersonnelHandoverPreview } from '@shared/personnel-handover.interface';
import { BUSINESS_ACTION_LABELS, BUSINESS_PERMISSION_CATALOG } from '@shared/business-permissions';
import { PAGE_ACCESS_CATALOG } from '@shared/page-access';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ROLE_LABELS } from './model';

const semantic = (source: NonNullable<PersonnelHandoverPreview['permissionOwnership']>[number]['source']) => JSON.stringify({ ...source, sourceVersion: 1 });
export function describeHandoverGrant(row: NonNullable<PersonnelHandoverPreview['permissionOwnership']>[number], key: string): { title: string; scope: string } {
  const source = row.source, effective = source.effectiveAuthorization;
  const rule = key.startsWith('v2:base-rule:') ? effective?.baseline.rules.find(item => item.id === key.slice('v2:base-rule:'.length)) : key.startsWith('v2:personal-rule:') ? effective?.overrides.rules.find(item => item.id === key.slice('v2:personal-rule:'.length)) : key.startsWith('rule:') ? source.personalRules?.find(item => item.id === key.slice(5)) : undefined;
  if (rule) return { title: `${BUSINESS_PERMISSION_CATALOG.find(item => item.id === rule.module)?.label || '业务功能'} · ${rule.actions.map(action => BUSINESS_ACTION_LABELS[action]).join('、')}`, scope: `${rule.buildings?.join('、') || '全部楼栋'} · ${rule.specialties?.join('、') || '全部专业'}` };
  if (key.startsWith('v2:grant:')) {
    const metadata = row.grantMetadata?.[key];
    return metadata ? { title: metadata.title, scope: `来源任职范围：${metadata.scope.buildings?.join('、') || metadata.scope.building || '全基地'}${metadata.scope.specialties?.length ? ` · ${metadata.scope.specialties.join('、')}` : ''}；各项规则范围保持` } : { title: '既有交接授权', scope: '原授权范围与限制完整保留，具体来源范围尚未取得' };
  }
  if (key === 'role' || key === 'v2:role') {
    const role = key === 'v2:role' ? effective?.baseline.nativeRole : source.role;
    return { title: role ? `岗位默认权限 · ${ROLE_LABELS[role]}` : '独立基础权限（无默认角色）', scope: `${source.buildings?.join('、') || source.building || '全基地'}${source.specialties?.length ? ` · ${source.specialties.join('、')}` : ''}` };
  }
  const page = key.startsWith('v2:base-page:') ? key.slice('v2:base-page:'.length) : key.startsWith('v2:personal-page:') ? key.slice('v2:personal-page:'.length) : key.startsWith('page:') ? key.slice(5) : '';
  return { title: page ? `页面读取 · ${PAGE_ACCESS_CATALOG.find(item => item.path === page)?.label || page}` : '业务授权', scope: '' };
}
export function updateHandoverGrantChoice(preview: PersonnelHandoverPreview, value: readonly HandoverPermissionOwnership[], sourceAccountId: string, key: string, choice: Omit<HandoverGrantChoice, 'key'> | undefined): HandoverPermissionOwnership[] {
  const source = preview.permissionOwnership?.find(row => row.sourceAccountId === sourceAccountId);
  if (!source) return [...value];
  const result = new Map(value.map(row => [row.sourceAccountId, { ...row, grants: [...row.grants] }]));
  for (const row of preview.permissionOwnership || []) {
    if (semantic(row.source) !== semantic(source.source) || !row.grantKeys.includes(key)) continue;
    const grants = (result.get(row.sourceAccountId)?.grants || []).filter(grant => grant.key !== key);
    if (choice) grants.push({ key, ...choice });
    result.set(row.sourceAccountId, { sourceAccountId: row.sourceAccountId, grants });
  }
  return [...result.values()];
}
export function completeHandoverOwnership(preview: PersonnelHandoverPreview | undefined, value: readonly HandoverPermissionOwnership[]): boolean {
  const sources = preview?.permissionOwnership || [];
  if (!value.length && !sources.some(row => row.required)) return true;
  if (sources.length !== value.length) return false;
  return sources.every(source => {
    const grants = value.find(row => row.sourceAccountId === source.sourceAccountId)?.grants || [];
    return grants.length === source.grantKeys.length && new Set(grants.map(grant => grant.key)).size === grants.length && source.grantKeys.every(key => {
      const grant = grants.find(row => row.key === key);
      return !!grant && (grant.disposition === 'retain' || ['transfer', 'shared'].includes(grant.disposition) && preview!.requested.dutyRecordIds.includes(grant.dutyRecordId || ''));
    });
  });
}

export function PersonnelHandoverOwnership({ preview, value, onChange, onReload, disabled, dutyNames }: {
  preview: PersonnelHandoverPreview; value: HandoverPermissionOwnership[]; onChange: (value: HandoverPermissionOwnership[]) => void;
  onReload: () => void; disabled: boolean; dutyNames: ReadonlyMap<string, string>;
}) {
  const sources = preview.permissionOwnership || [];
  if (!sources.some(row => row.required)) return null;
  const groups = new Map<string, typeof sources>();
  for (const source of sources) { const key = semantic(source.source); groups.set(key, [...(groups.get(key) || []), source]); }
  return <Card><CardContent className="space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">确认权限归属</h3><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onReload}>重新读取并清空选择</Button></div>
    <p className="text-xs text-muted-foreground">其他任职仍需要的权限选择保留；双方都需要时选择双方保留。基地员工基础权限与限制规则保持。</p>
    {[...groups.values()].map(group => {
      const source = group[0], draft = value.find(row => row.sourceAccountId === source.sourceAccountId);
      return <fieldset key={source.sourceAccountId} disabled={disabled} className="min-w-0 space-y-3">
        <legend className="mb-2 text-sm font-medium">{preview.from.name} · {group.length > 1 ? '两种登录方式同步调整' : source.kind === 'feishu' ? '飞书登录' : '姓名登录'}</legend>
        {source.grantKeys.map((key, index) => {
          const grant = draft?.grants.find(row => row.key === key);
          const { title, scope } = describeHandoverGrant(source, key);
          const change = (disposition: HandoverGrantChoice['disposition'] | '') => onChange(updateHandoverGrantChoice(preview, value, source.sourceAccountId, key, disposition ? { disposition, ...(disposition === 'retain' ? {} : { dutyRecordId: grant?.dutyRecordId || (preview.requested.dutyRecordIds.length === 1 ? preview.requested.dutyRecordIds[0] : '') }) } : undefined));
          return <div key={key} className="grid min-w-0 gap-2 border-t pt-3 md:grid-cols-[minmax(0,1fr)_10rem_12rem]">
            <div className="min-w-0"><p className="break-words text-sm">{title}</p>{scope && <p className="break-words text-xs text-muted-foreground">{scope}</p>}</div>
            <select className="config-select w-full min-w-0" aria-label={`权限${index + 1}归属`} value={grant?.disposition || ''} onChange={event => change(event.target.value as HandoverGrantChoice['disposition'] | '')}><option value="">请选择归属</option><option value="transfer">转交接任者</option><option value="retain">前任保留</option><option value="shared">双方保留</option></select>
            {grant && grant.disposition !== 'retain' && <select className="config-select w-full min-w-0" aria-label={`权限${index + 1}对应岗位`} value={grant.dutyRecordId || ''} onChange={event => onChange(updateHandoverGrantChoice(preview, value, source.sourceAccountId, key, { disposition: grant.disposition, dutyRecordId: event.target.value }))}><option value="">选择归属岗位</option>{preview.requested.dutyRecordIds.map(id => <option key={id} value={id}>{dutyNames.get(id) || '所选岗位'}</option>)}</select>}
          </div>;
        })}
      </fieldset>;
    })}
  </CardContent></Card>;
}
