import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { BUSINESS_ACTION_LABELS } from '@shared/business-permissions';
import type { RequestedPermission } from '@shared/personnel-permission-request.interface';
import type { PersonalProfile } from '@/api/personal-access';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ROLE_LABELS } from '../SystemConfiguration/model';
import { personalActionCoverage, personalReadablePages, type PersonalPermissionPrincipal } from './permission-request.logic';

export function PermissionOverview({ profile, principal, readOnly, onRequest }: { profile: PersonalProfile; principal: PersonalPermissionPrincipal; readOnly: boolean; onRequest: (permission: RequestedPermission) => void }) {
  const [query, setQuery] = useState(''), [path, setPath] = useState('');
  const readable = useMemo(() => personalReadablePages(principal), [principal]);
  const visible = useMemo(() => profile.catalog.pages.filter(page => page.kind !== 'external' && (!query.trim() || `${page.label} ${page.modules.map(module => module.label).join(' ')}`.includes(query.trim()))), [profile.catalog, query]);
  const selected = visible.find(page => page.path === path) || visible[0];
  const modules = useMemo(() => selected?.modules.map(module => ({ ...module, states: module.actions.map(action => ({ action, ...personalActionCoverage(principal, module.id, action, module.scoped) })) })) || [], [selected, principal]);
  const summary = profile.authorizationSummary;
  const nativeRole = summary ? summary.nativeRole : profile.effectiveAuthorization ? profile.effectiveAuthorization.baseline.nativeRole : principal.role;
  return <section className="space-y-4 rounded-lg border bg-card p-4 md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-5 text-primary" />我的有效权限</h2><Badge variant="outline">可查看 {readable.filter(path => profile.catalog.pages.some(page => page.path === path && page.kind !== 'external')).length} 页</Badge></div>
    <dl className="grid gap-3 rounded-lg bg-muted/30 p-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">授权方式</dt><dd className="mt-1">{(summary?.mode || profile.effectiveAuthorization?.mode) === 'independent' ? '独立配置' : (summary?.mode || profile.effectiveAuthorization?.mode) === 'follow' ? '跟随角色模板' : '账号固定角色'}</dd></div><div><dt className="text-xs text-muted-foreground">角色来源</dt><dd className="mt-1 break-words">{summary?.templateName || (nativeRole ? ROLE_LABELS[nativeRole] : '独立权限基线')}{summary?.templateName && nativeRole ? ` · ${ROLE_LABELS[nativeRole]}` : ''}</dd></div><div><dt className="text-xs text-muted-foreground">任职建议范围</dt><dd className="mt-1 break-words">{[profile.suggestedScopes?.buildings.join('、'), profile.suggestedScopes?.specialties.join('、')].filter(Boolean).join(' · ') || '账号未明确，请按功能核对'}</dd></div></dl>
    <p className="text-xs leading-5 text-muted-foreground">任职范围来自当前账号；实际允许范围由角色、独立配置和个人例外共同决定，以下逐项展示。权限不等同于审批职责。</p>
    <div className="grid gap-3 sm:grid-cols-2"><input className="config-select min-w-0 w-full" aria-label="搜索我的权限" placeholder="搜索页面或功能" value={query} onChange={event => setQuery(event.target.value)} /><select className="config-select min-w-0 w-full" aria-label="查看页面权限" value={selected?.path || ''} onChange={event => setPath(event.target.value)}>{visible.map(page => <option key={page.path} value={page.path}>{page.label}</option>)}</select></div>
    {selected ? <><div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div className="text-sm"><span className="font-medium">{selected.label}</span><span className="ml-2 text-muted-foreground">{readable.includes(selected.path) ? '页面可查看' : '页面尚未开放'}</span></div>{readable.includes(selected.path) ? <Button variant="outline" size="sm" asChild><Link to={selected.path}>前往页面<ArrowUpRight className="size-4" /></Link></Button> : !readOnly && <Button variant="outline" size="sm" onClick={() => onRequest({ kind: 'page', path: selected.path })}>申请查看</Button>}</div>
      {modules.map(module => <section key={module.id} className="space-y-3 rounded-lg border p-3"><h3 className="text-sm font-medium">{module.label}</h3>{!!module.conditions?.length && <p className="text-xs leading-5 text-muted-foreground">{module.conditions.join('；')}</p>}
        <div className="divide-y">{module.states.map(state => <div className="space-y-2 py-3 first:pt-0 last:pb-0" key={state.action}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm"><span className="font-medium">{BUSINESS_ACTION_LABELS[state.action]}</span><span className="ml-2 text-muted-foreground">{!state.allowed ? '未授权' : state.allowed === state.total ? '允许' : '部分范围允许'}</span></p>{!readOnly && state.allowed < state.total && <Button variant="ghost" size="sm" onClick={() => onRequest({ kind: 'action', module: module.id, action: state.action, buildings: null, specialties: null })}>申请{state.allowed ? '其他范围' : '此权限'}</Button>}</div>
          {!!state.allowed && <div className="space-y-1 text-xs leading-5 text-muted-foreground"><p>来源：{state.sources.join('、')}</p>{state.ranges.map(range => <p key={range}>{range}</p>)}</div>}
        </div>)}</div>
      </section>)}
    </> : <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的页面或功能</p>}
  </section>;
}
