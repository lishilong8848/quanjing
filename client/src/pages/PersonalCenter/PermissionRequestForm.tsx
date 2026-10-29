import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { BUILDING_ADMIN_BUILDINGS, type BuildingAdminBuilding } from '@shared/access-control.interface';
import { BUSINESS_ACTION_LABELS, type BusinessAction } from '@shared/business-permissions';
import { PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from '@shared/professional-access';
import type { PersonnelPermissionRequest, RequestedPermission } from '@shared/personnel-permission-request.interface';
import { createPermissionRequest, type PersonalPermissionCatalog } from '@/api/personal-access';
import { createPersonalMutationIdentity } from '@/access/personal-password.logic';
import { Button } from '@/components/ui/button';
import { addRequestedPermission, permissionRequestLabel } from './permission-request.logic';

export function PermissionRequestForm({ catalog, onSubmitted }: { catalog: PersonalPermissionCatalog; onSubmitted: (request: PersonnelPermissionRequest) => void }) {
  const pages = catalog.pages.filter(page => page.kind !== 'external');
  const [path, setPath] = useState(pages[0]?.path || ''), [kind, setKind] = useState('page'), [moduleId, setModuleId] = useState(''), [action, setAction] = useState<BusinessAction>('read');
  const [buildings, setBuildings] = useState<BuildingAdminBuilding[] | null>(null), [specialties, setSpecialties] = useState<ProfessionalSpecialty[] | null>(null);
  const [permissions, setPermissions] = useState<RequestedPermission[]>([]), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const pending = useRef(false), identity = useRef(createPersonalMutationIdentity()), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; identity.current.clear(); }; }, []);
  const selectedPage = pages.find(page => page.path === path) || pages[0];
  const selectedModule = selectedPage?.modules.find(module => module.id === moduleId) || selectedPage?.modules[0];
  const selectedAction = selectedModule?.actions.find(value => value === action) || selectedModule?.actions[0];
  function add() {
    setError(''); setSuccess('');
    if (!selectedPage) return;
    if (kind === 'action' && (!selectedModule || !selectedAction)) { setError('请选择一个实际功能'); return; }
    if (kind === 'action' && selectedModule?.scoped && (buildings?.length === 0 || specialties?.length === 0)) { setError('请至少选择一个楼栋和专业，或选择全部范围'); return; }
    const next: RequestedPermission = kind === 'page' ? { kind: 'page', path: selectedPage.path } : {
      kind: 'action', module: selectedModule!.id, action: selectedAction!,
      buildings: selectedModule!.scoped ? buildings : null, specialties: selectedModule!.scoped ? specialties : null,
    };
    try { const updated = addRequestedPermission(permissions, next); if (updated === permissions) setError('这项权限已添加'); else setPermissions(updated); }
    catch (failure) { setError((failure as Error).message); }
  }
  async function submit() {
    if (pending.current) return;
    if (!permissions.length || !reason.trim()) { setError(!permissions.length ? '请先添加需要申请的权限' : '请填写申请理由'); return; }
    const body = { permissions, reason: reason.trim() };
    pending.current = true; setBusy(true); setError(''); setSuccess('');
    try {
      const result = await createPermissionRequest({ ...body, clientMutationId: identity.current.forPayload(body) });
      if (!alive.current) return;
      onSubmitted(result); setPermissions([]); setReason(''); identity.current.clear(); setSuccess('申请已提交，等待管理员审核。授权完成前现有权限保持不变。');
    } catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="min-w-0 space-y-4">
    <div><h2 className="text-lg font-semibold">申请权限</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">选择需要的页面或操作，并说明用途。审批职责和单据状态仍须符合业务要求。</p></div>
    <fieldset disabled={busy} className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="grid gap-4 md:grid-cols-2"><label className="grid gap-2 text-sm"><span>页面</span><select className="config-select min-w-0 w-full" value={selectedPage?.path || ''} onChange={event => { setPath(event.target.value); setModuleId(''); setAction('read'); setBuildings(null); setSpecialties(null); }}>{pages.map(page => <option key={page.path} value={page.path}>{page.label}</option>)}</select></label>
        <label className="grid gap-2 text-sm"><span>申请内容</span><select className="config-select min-w-0 w-full" value={kind} onChange={event => setKind(event.target.value)}><option value="page">页面查看</option><option value="action" disabled={!selectedPage?.modules.length}>具体功能操作</option></select></label></div>
      {kind === 'action' && selectedModule && <><div className="grid gap-4 md:grid-cols-2"><label className="grid gap-2 text-sm"><span>功能</span><select className="config-select min-w-0 w-full" value={selectedModule.id} onChange={event => { setModuleId(event.target.value); setAction('read'); setBuildings(null); setSpecialties(null); }}>{selectedPage?.modules.map(module => <option key={module.id} value={module.id}>{module.label}</option>)}</select></label>
        <label className="grid gap-2 text-sm"><span>操作</span><select className="config-select min-w-0 w-full" value={selectedAction} onChange={event => setAction(event.target.value as BusinessAction)}>{selectedModule.actions.map(value => <option key={value} value={value}>{BUSINESS_ACTION_LABELS[value]}</option>)}</select></label></div>
        {selectedModule.scoped && <div className="grid gap-4 md:grid-cols-2"><ScopeSelection title="楼栋范围" options={BUILDING_ADMIN_BUILDINGS} value={buildings} onChange={setBuildings} /><ScopeSelection title="专业范围" options={PROFESSIONAL_SPECIALTIES} value={specialties} onChange={setSpecialties} /></div>}
      </>}
      <Button type="button" variant="outline" onClick={add} disabled={!selectedPage || permissions.length >= 20}><Plus className="size-4" />添加申请项</Button>
    </fieldset>
    {!!permissions.length && <ul className="divide-y rounded-lg border">{permissions.map((permission, index) => <li key={JSON.stringify(permission)} className="flex items-center justify-between gap-3 p-3 text-sm"><span className="min-w-0 break-words">{permissionRequestLabel(permission, catalog)}</span><Button type="button" variant="ghost" size="icon" disabled={busy} className="shrink-0" aria-label={`移除第 ${index + 1} 项权限`} onClick={() => setPermissions(current => current.filter((_, at) => at !== index))}><X className="size-4" /></Button></li>)}</ul>}
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="grid gap-2 text-sm"><span>申请理由 <span className="text-destructive">*</span></span><textarea className="config-select min-h-24 w-full resize-y" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} placeholder="说明需要这些权限的工作内容（最多 500 字）" /></label>
      {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {success && <p role="status" className="rounded-lg border bg-primary/5 p-3 text-sm text-primary">{success}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">已添加 {permissions.length} / 20 项</span><Button type="submit" disabled={busy} aria-busy={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? '正在提交…' : '提交申请'}</Button></div>
    </form>
  </section>;
}

function ScopeSelection<T extends string>({ title, options, value, onChange }: { title: string; options: readonly T[]; value: T[] | null; onChange: (value: T[] | null) => void }) {
  return <fieldset className="space-y-2 text-sm"><legend className="mb-2 font-medium">{title}</legend><label className="flex min-h-9 items-center gap-2"><input type="checkbox" checked={value === null} onChange={event => onChange(event.target.checked ? null : [])} />全部{title.slice(0, 2)}</label>
    {value !== null && <div className="flex flex-wrap gap-x-4 gap-y-2">{options.map(option => <label key={option} className="flex min-h-9 items-center gap-2"><input type="checkbox" checked={value.includes(option)} onChange={event => onChange(options.filter(item => item === option ? event.target.checked : value.includes(item)))} />{option}</label>)}</div>}</fieldset>;
}
