import { useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { BUSINESS_ACTION_LABELS, BUSINESS_PERMISSION_CATALOG, decideBusinessPermission, type BusinessModule, type PersonalPermissionRule } from '@shared/business-permissions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { editPersonalPermission, personalPermissionMode, type PersonalPermissionMode } from './personal-permission-editing';

export function PersonalPermissionEditor({ principal, rules, onChange, disabled }: {
  principal: AccessPrincipal; rules: PersonalPermissionRule[]; onChange: (rules: PersonalPermissionRule[]) => void; disabled: boolean;
}) {
  const [preview, setPreview] = useState<BusinessModule>('inventory');
  const [buildings, setBuildings] = useState<PersonalPermissionRule['buildings']>(principal.buildings?.length ? [...principal.buildings] : ['A楼']);
  const [specialties, setSpecialties] = useState<PersonalPermissionRule['specialties']>(principal.specialties?.length ? [...principal.specialties] : ['电气']);
  const [error, setError] = useState('');
  const definition = BUSINESS_PERMISSION_CATALOG.find(item => item.id === preview)!;
  const scope = { module: preview, buildings, specialties };
  const selectionValid = !definition.scoped || (buildings?.length !== 0 && specialties?.length !== 0);
  const update = (id: string, change: Partial<PersonalPermissionRule>) => onChange(rules.map(rule => rule.id === id ? { ...rule, ...change } : rule));
  return <section aria-labelledby="personal-permission-heading" className="space-y-4 border-t pt-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="personal-permission-heading" className="font-medium">个人精细规则</h3>
      {!!rules.length && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange([])}><RotateCcw className="size-4" />恢复角色默认</Button>}
    </div>
    {!rules.length && <p className="text-sm text-muted-foreground">当前继承角色默认权限。</p>}
    {rules.map((rule, index) => {
      const module = BUSINESS_PERMISSION_CATALOG.find(item => item.id === rule.module)!;
      return <fieldset key={rule.id} disabled={disabled} className="min-w-0 space-y-3 rounded-lg border bg-card p-3">
        <legend className="px-1 text-sm font-medium">规则 {index + 1}</legend>
        <div className="flex items-center gap-2">
          <select className="config-select min-w-0 flex-1" aria-label={`规则${index + 1}业务`} value={rule.module} onChange={event => {
            const next = BUSINESS_PERMISSION_CATALOG.find(item => item.id === event.target.value)!;
            const actions = rule.actions.filter(action => (next.actions as readonly string[]).includes(action));
            update(rule.id, { module: next.id, actions: actions.length ? actions : ['read'], ...(next.scoped ? {} : { buildings: null, specialties: null }) });
          }}>{BUSINESS_PERMISSION_CATALOG.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
          <select className="config-select" aria-label={`规则${index + 1}效果`} value={rule.effect} onChange={event => update(rule.id, { effect: event.target.value as 'allow' | 'deny' })}><option value="allow">允许</option><option value="deny">限制</option></select>
          <Button type="button" size="icon" variant="ghost" aria-label={`删除规则${index + 1}`} onClick={() => onChange(rules.filter(item => item.id !== rule.id))}><Trash2 className="size-4" /></Button>
        </div>
        <fieldset className="space-y-2"><legend className="text-sm">操作</legend><div className="flex flex-wrap gap-x-4 gap-y-2">
          {module.actions.map(action => <label key={action} className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={rule.actions.includes(action)} onChange={event => update(rule.id, { actions: event.target.checked ? [...rule.actions, action] : rule.actions.filter(value => value !== action) })} />{BUSINESS_ACTION_LABELS[action]}</label>)}
        </div>{!rule.actions.length && <p role="alert" className="text-sm text-destructive">至少选择一项操作</p>}</fieldset>
        {module.scoped && <>
          <ScopeSelection label="楼栋" allLabel="全部楼栋" options={BUILDING_ADMIN_BUILDINGS} selected={rule.buildings} onChange={buildings => update(rule.id, { buildings })} />
          <ScopeSelection label="专业" allLabel="全部专业" options={PROFESSIONAL_SPECIALTIES} selected={rule.specialties} onChange={specialties => update(rule.id, { specialties })} />
        </>}
      </fieldset>;
    })}
    <Button type="button" variant="outline" size="sm" disabled={disabled || rules.length >= 100} onClick={() => onChange([...rules, { id: crypto.randomUUID(), effect: 'allow', module: 'inventory', actions: ['read'], buildings: principal.buildings?.length ? [...principal.buildings] : null, specialties: principal.specialties?.length ? [...principal.specialties] : null }])}><Plus className="size-4" />增加规则</Button>
    {!!rules.length && <p className="text-xs leading-5 text-muted-foreground">限制优先。各条规则独立生效，保存后应用。</p>}
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <h4 className="text-sm font-medium">配置与生效预览</h4>
      <fieldset disabled={disabled} className="min-w-0 space-y-3">
        <legend className="sr-only">配置范围</legend>
        <select className="config-select min-w-0 w-full" aria-label="预览业务" value={preview} onChange={event => setPreview(event.target.value as BusinessModule)}>{BUSINESS_PERMISSION_CATALOG.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        {definition.scoped && <>
          <ScopeSelection label="预览楼栋" allLabel="全部楼栋" options={BUILDING_ADMIN_BUILDINGS} selected={buildings} onChange={setBuildings} />
          <ScopeSelection label="预览专业" allLabel="全部专业" options={PROFESSIONAL_SPECIALTIES} selected={specialties} onChange={setSpecialties} />
        </>}
      </fieldset>
      <ul className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2" aria-live="polite">
        {definition.actions.map(action => {
          const points = definition.scoped ? (buildings || BUILDING_ADMIN_BUILDINGS).flatMap(building => (specialties || PROFESSIONAL_SPECIALTIES).map(specialty => ({ building, specialty }))) : [{}];
          const decisions = points.map(point => decideBusinessPermission({ ...principal, personalRules: rules }, { module: preview, action, ...point }));
          const allAllowed = decisions.length > 0 && decisions.every(decision => decision.allowed);
          const source = new Set(decisions.map(decision => decision.source));
          const label = !selectionValid ? '请选择范围' : allAllowed ? source.has('allow') ? '个人允许' : '角色允许' : decisions.some(decision => decision.allowed) ? '部分允许' : source.has('deny') ? '个人限制' : '未授权';
          return <li key={action} className="min-w-0 space-y-2 rounded-md border bg-card p-3">
            <div className="flex items-center justify-between gap-2"><span>{BUSINESS_ACTION_LABELS[action]}</span><Badge variant={allAllowed ? 'secondary' : 'outline'}>{label}</Badge></div>
            <select className="config-select min-w-0 w-full" aria-label={`${BUSINESS_ACTION_LABELS[action]}权限配置`} disabled={disabled || !selectionValid} value={personalPermissionMode(rules, scope, action)} onChange={event => {
              try { onChange(editPersonalPermission(rules, scope, action, event.target.value as PersonalPermissionMode, () => crypto.randomUUID())); setError(''); }
              catch (failure) { setError((failure as Error).message); }
            }}><option value="inherit">继承角色</option><option value="allow">个人允许</option><option value="deny">个人限制</option><option value="mixed" disabled>所选范围配置不同</option></select>
          </li>;
        })}
      </ul>
      <p className="text-xs text-muted-foreground">操作配置仅应用于所选范围，保存后生效。</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </section>;
}

function ScopeSelection<T extends string>({ label, allLabel, options, selected, onChange }: { label: string; allLabel: string; options: readonly T[]; selected: T[] | null; onChange: (value: T[] | null) => void }) {
  return <fieldset aria-label={label} className="min-w-0 space-y-2"><legend className="text-sm">{label}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">
    <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={selected === null} onChange={event => onChange(event.target.checked ? null : [])} />{allLabel}</label>
    {options.map(value => <label key={value} className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={selected === null || selected.includes(value)} onChange={event => onChange(event.target.checked ? options.filter(item => item === value || selected?.includes(item)) : (selected || [...options]).filter(item => item !== value))} />{value}</label>)}
  </div>{selected?.length === 0 && <p role="alert" className="text-sm text-destructive">请选择{label}</p>}</fieldset>;
}
