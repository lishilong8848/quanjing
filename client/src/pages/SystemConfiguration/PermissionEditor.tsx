import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { BUILDING_ADMIN_BUILDINGS } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { BUSINESS_ACTION_LABELS, personalPermissionPagePaths, type BusinessAction, type BusinessModule } from '@shared/business-permissions';
import type { EffectiveAuthorization } from '@shared/authorization-profile';
import { createPermissionCatalog } from '@shared/permission-catalog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authorizationModuleState, authorizationPageMode, editAuthorizationAction, editAuthorizationPage, editAuthorizationScope } from './authorization-editing';
import { personalPermissionMode, type PersonalPermissionMode } from './personal-permission-editing';

type CatalogModule = { id: BusinessModule; label: string; scoped: boolean; actions: readonly BusinessAction[]; conditions?: readonly string[] };
export interface PermissionEditorProps {
  value: EffectiveAuthorization;
  principal: AccessPrincipal;
  onChange?: (value: EffectiveAuthorization) => void;
  template?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  label?: string;
  catalog?: ReturnType<typeof createPermissionCatalog>;
}
const defaultCatalog = createPermissionCatalog();

export function PermissionEditor({ value, principal, onChange, template = false, readOnly = false, disabled = false, label = '权限配置', catalog = defaultCatalog }: PermissionEditorProps) {
  const [query, setQuery] = useState(''), [path, setPath] = useState(catalog.pages[0]?.path || '');
  const [error, setError] = useState('');
  const actor = useMemo(() => ({ ...principal, effectiveAuthorization: value }), [principal, value]);
  const pages = useMemo(() => personalPermissionPagePaths(actor, value.baseline.pages), [actor, value.baseline.pages]);
  const visible = useMemo(() => catalog.pages.filter(page => !query.trim() || `${page.label} ${page.modules.map(module => module.label).join(' ')}`.includes(query.trim())), [query, catalog]);
  const selected = visible.find(page => page.path === path) || visible[0];
  const inherited = !template && value.mode === 'follow';
  const locked = disabled || readOnly || !onChange;
  const change = (next: EffectiveAuthorization) => { setError(''); onChange?.(next); };
  return <section className="min-w-0 space-y-4" aria-label={label}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 font-medium"><ShieldCheck className="size-4 text-primary" />{label}</h3><Badge variant="outline">可查看 {pages.length} 页</Badge></div>
    <Input aria-label={`${label}搜索`} placeholder="搜索页面或功能" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    {selected ? <>
      <label className="block space-y-2 text-sm"><span>页面 / 功能</span><select className="config-select w-full" aria-label={`${label}页面`} value={selected.path} onChange={event => setPath(event.target.value)}>{visible.map(page => <option key={page.path} value={page.path}>{page.label}</option>)}</select></label>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 p-3 text-sm"><span>{selected.label} · 页面入口</span><Badge variant={pages.includes(selected.path) ? 'secondary' : 'outline'}>{pages.includes(selected.path) ? '可见' : '不可见'}</Badge></div>
      {selected.kind === 'business' && value.overrides.denyPages.includes(selected.path) && <div className="rounded-lg border border-destructive/30 p-3 text-sm"><p>此页面存在整页限制，功能允许不会解除该限制。</p>{!readOnly && <Button type="button" variant="link" disabled={locked} onClick={() => change({ ...value, overrides: { ...value.overrides, denyPages: value.overrides.denyPages.filter(item => item !== selected.path) } })}>改为按功能配置</Button>}</div>}
      {selected.kind === 'business' && value.overrides.allowPages.includes(selected.path) && <p className="text-xs text-muted-foreground">此页面保留原有读取增补，当前可在下面逐项调整查看权限。</p>}
      {selected.kind === 'business' && selected.modules.length ? selected.modules.map(module => <ModulePermissions key={`${selected.path}:${module.id}`} module={module} value={value} principal={actor} template={template} inherited={inherited} locked={locked} readOnly={readOnly} onChange={change} onError={setError} />) : <div className="space-y-2 rounded-lg border p-3">
        <p className="text-sm font-medium">页面读取</p>
        {readOnly ? <p className="text-sm text-muted-foreground">{pages.includes(selected.path) ? '允许' : '限制'}</p> : <ModeSelect label={`${selected.label}读取权限`} inherited={inherited} disabled={locked} value={inherited ? authorizationPageMode(value, selected.path) : pages.includes(selected.path) ? 'allow' : 'deny'} onChange={mode => change(editAuthorizationPage(value, template, selected.path, mode))} />}
      </div>}
      <p className="text-xs leading-5 text-muted-foreground">{readOnly ? '此处展示当前配置结果。' : template ? '角色权限影响其跟随人员，核对后保存。' : inherited ? '继承角色；个人限制优先于允许。修改在保存后生效。' : '独立配置不跟随角色后续变更。修改在保存后生效。'}</p>
    </> : <p className="rounded-lg border p-5 text-sm text-muted-foreground">没有匹配的页面或功能</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}

function ModeSelect({ label, value, onChange, disabled, inherited }: { label: string; value: PersonalPermissionMode | 'mixed'; onChange: (mode: PersonalPermissionMode) => void; disabled: boolean; inherited: boolean }) {
  return <select aria-label={label} className="config-select min-w-0 w-full" value={value} disabled={disabled} onChange={event => onChange(event.target.value as PersonalPermissionMode)}>{inherited && <option value="inherit">继承角色</option>}<option value="allow">允许</option><option value="deny">限制</option><option value="mixed" disabled>所选范围配置不同</option></select>;
}

function ModulePermissions({ module, value, principal, template, inherited, locked, readOnly, onChange, onError }: {
  module: CatalogModule; value: EffectiveAuthorization; principal: AccessPrincipal; template: boolean; inherited: boolean; locked: boolean; readOnly: boolean;
  onChange: (value: EffectiveAuthorization) => void; onError: (message: string) => void;
}) {
  const state = useMemo(() => authorizationModuleState(value, principal, module.id, template), [value, principal, module.id, template]);
  const { buildings, specialties } = state.scope;
  const scope = { module: module.id, buildings: module.scoped ? buildings : null, specialties: module.scoped ? specialties : null };
  const validScope = !module.scoped || buildings?.length !== 0 && specialties?.length !== 0;
  const actions = useMemo(() => state.actions.map(({ action, points }) => {
    const decisions = points.filter(point => readOnly || !module.scoped ||
      (!buildings || !!point.building && buildings.includes(point.building)) && (!specialties || !!point.specialty && specialties.includes(point.specialty)));
    const allowed = decisions.filter(decision => decision.allowed).length;
    const state: 'none' | 'allow' | 'mixed' | 'deny' = !decisions.length ? 'none' : allowed === decisions.length ? 'allow' : allowed ? 'mixed' : 'deny';
    const sources = [...new Set(decisions.map(decision => decision.source))].map(source => ({ role: '角色或独立基线', allow: '明确允许', deny: '明确限制', none: '未授权' }[source])).join('、');
    const groups = new Map<string, { buildings: string[]; specialties: string[] }>();
    for (const building of BUILDING_ADMIN_BUILDINGS) {
      const permitted = PROFESSIONAL_SPECIALTIES.filter(specialty => decisions.some(point => point.allowed && point.building === building && point.specialty === specialty));
      if (!permitted.length) continue;
      const key = permitted.join('、'), group = groups.get(key) || { buildings: [], specialties: permitted };
      group.buildings.push(building); groups.set(key, group);
    }
    const ranges = [...groups.values()].map(group => `${group.buildings.length === BUILDING_ADMIN_BUILDINGS.length ? '全部楼栋' : group.buildings.join('、')} · ${group.specialties.length === PROFESSIONAL_SPECIALTIES.length ? '全部专业' : group.specialties.join('、')}`);
    return { action, state, sources, ranges };
  }), [state.actions, module.scoped, buildings, specialties, readOnly]);
  function changeScope(next: typeof scope) {
    try { onChange(editAuthorizationScope(value, template, next)); }
    catch (failure) { onError((failure as Error).message); }
  }
  return <fieldset className="min-w-0 space-y-3 rounded-lg border bg-card p-3">
    <legend className="px-1 text-sm font-medium">{module.label}</legend>
    {module.conditions?.map(condition => <p key={condition} className="text-xs text-muted-foreground">{condition}</p>)}
    {module.scoped && !readOnly && <div className="grid gap-3 sm:grid-cols-2"><Scope label={`${module.label}楼栋范围`} options={BUILDING_ADMIN_BUILDINGS} selected={buildings} onChange={buildings => changeScope({ ...scope, buildings })} disabled={locked} /><Scope label={`${module.label}专业范围`} options={PROFESSIONAL_SPECIALTIES} selected={specialties} onChange={specialties => changeScope({ ...scope, specialties })} disabled={locked} /></div>}
    {module.scoped && !readOnly && <p className="text-xs text-muted-foreground">所选范围是此功能所有操作的上限，保存后生效；“全部”不代表全部已授权，各操作的实际范围如下。</p>}
    {module.scoped && template && <p className="text-xs text-muted-foreground">系统角色按所选任职范围预览，具体人员仍受其任职范围约束。</p>}
    {actions.map(({ action, state, sources, ranges }) => <div key={action} className={`grid min-w-0 gap-2 border-t pt-3${readOnly ? '' : ' sm:grid-cols-[minmax(0,1fr)_11rem]'}`}>
      <div className="min-w-0 space-y-1 text-sm"><p className="font-medium">{BUSINESS_ACTION_LABELS[action]} <span className="font-normal text-muted-foreground">· {!validScope && !readOnly ? '请选择范围' : state === 'allow' ? '允许' : state === 'mixed' ? '部分允许' : '限制'}</span></p><p className="break-words text-xs text-muted-foreground">{sources}</p>
        {module.scoped && <div className="space-y-1 text-xs text-muted-foreground" aria-label={`${module.label}${BUSINESS_ACTION_LABELS[action]}生效范围`}>{ranges.length ? ranges.map(range => <p key={range} className="break-words">{range}</p>) : <p>无可用楼栋及专业</p>}</div>}
      </div>
      {!readOnly && <ModeSelect label={`${module.label}${BUSINESS_ACTION_LABELS[action]}权限`} inherited={inherited} disabled={locked || !validScope} value={inherited ? personalPermissionMode(value.overrides.rules, scope, action) : state === 'none' ? 'deny' : state} onChange={mode => { try { onChange(editAuthorizationAction(value, template, scope, action, mode, () => crypto.randomUUID())); } catch (failure) { onError((failure as Error).message); } }} />}
    </div>)}
  </fieldset>;
}

function Scope<T extends string>({ label, options, selected, onChange, disabled }: { label: string; options: readonly T[]; selected: T[] | null; onChange: (value: T[] | null) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className="min-w-0 space-y-2"><legend className="text-xs font-medium">{label}</legend><div className="flex flex-wrap gap-x-3 gap-y-2 text-xs"><label className="flex items-center gap-1.5"><input type="checkbox" checked={selected === null} onChange={event => onChange(event.target.checked ? null : [])} />全部</label>{options.map(option => <label className="flex items-center gap-1.5" key={option}><input type="checkbox" checked={selected === null || selected.includes(option)} onChange={event => onChange(event.target.checked ? options.filter(item => item === option || selected?.includes(item)) : (selected || [...options]).filter(item => item !== option))} />{option}</label>)}</div></fieldset>;
}
