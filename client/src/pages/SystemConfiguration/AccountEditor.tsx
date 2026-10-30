import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { validPersonalRules } from '@shared/business-permissions';
import { effectivePagePaths, validPagePaths } from '@shared/page-access';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '@shared/site-member-backup';
import { detachAuthorization, type AuthorizationAccountChange, type AuthorizationAccountPreview, type AuthorizationRoleList, type EffectiveAuthorization } from '@shared/authorization-profile';
import type { AccessConfigurationResponse, AccountMutation, ConfigurationPerson, ManagedAccount, ManagedAccessRole } from '@shared/access-configuration.interface';
import { BUILDING_ADMIN_BUILDINGS, PURCHASE_ACCESS_BUILDINGS, type BuildingAdminBuilding } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from '@shared/professional-access';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ROLE_LABELS } from './model';
import { loadAccountAuthorization, previewAccountAuthorization, saveAccount } from './api';
import { PersonPicker } from './PersonPicker';
import { PermissionEditor } from './PermissionEditor';
import { emptyAuthorizationOverrides } from './authorization-editing';
import { accountRevisionError } from './account-mutation';
import { accountLoginLabel, followTemplate, synchronizedAccounts } from './configuration-helpers';
import type { PersonnelPermissionRequest } from '@shared/personnel-permission-request.interface';

export function AccountEditor({ account, data, people, roles, rolesLoading = false, rolesError = '', onRefreshRoles, external = false, requestContext, onClose, onSaved }: {
  account?: ManagedAccount; data: AccessConfigurationResponse; people: ConfigurationPerson[]; roles?: AuthorizationRoleList;
  rolesLoading?: boolean; rolesError?: string; onRefreshRoles?: () => void; external?: boolean;
  requestContext?: PersonnelPermissionRequest;
  onClose: () => void; onSaved: (result: AccessConfigurationResponse, id?: string) => void;
}) {
  const [name, setName] = useState(account?.name || ''), [openId, setOpenId] = useState(account?.openId || ''), [password, setPassword] = useState('');
  const [role, setRole] = useState<ManagedAccessRole>(account?.role || 'guest');
  const [selectedBuildings, setSelectedBuildings] = useState<BuildingAdminBuilding[]>(account?.buildings || (account?.building ? [account.building] : []));
  const [specialties, setSpecialties] = useState<ProfessionalSpecialty[]>(account?.specialties || []);
  const [enabled, setEnabled] = useState(account?.permissionsRevoked ? account.guestLoginAllowed === true : account?.enabled ?? true);
  const [authorization, setAuthorization] = useState<EffectiveAuthorization | undefined>(() => account?.effectiveAuthorization ? structuredClone(account.effectiveAuthorization) : undefined);
  const [authorizationLoading, setAuthorizationLoading] = useState(false), [authorizationError, setAuthorizationError] = useState(''), [authorizationRetry, setAuthorizationRetry] = useState(0);
  const [preview, setPreview] = useState<{ fingerprint: string; result?: AuthorizationAccountPreview }>(), [acknowledged, setAcknowledged] = useState(false);
  const [modeBefore, setModeBefore] = useState<{ value: EffectiveAuthorization; principal: import('@shared/access-control.interface').AccessPrincipal }>();
  const [confirmReactivation, setConfirmReactivation] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(''), [status, setStatus] = useState<'ready' | 'previewing' | 'submitting' | 'error'>('ready');
  const pending = useRef(false), request = useRef<{ signature: string; id: string } | undefined>(undefined);
  const latestRevision = useRef(data.revision); latestRevision.current = data.revision;
  const local = account?.kind === 'local', personnelPassword = account?.loginMethod === 'personnel-password';
  const sharedLogin = local && !personnelPassword, backup = account?.id === SITE_MEMBER_BACKUP_ACCOUNT_ID;
  const profileEditable = !backup;
  const professional = role === 'professional_admin' || role === 'professional_engineer';
  const scoped = ['inventory_admin', 'building_admin', 'purchase_applicant', 'professional_engineer'].includes(role);
  const buildings = ['building_admin', 'professional_engineer'].includes(role) ? BUILDING_ADMIN_BUILDINGS : PURCHASE_ACCESS_BUILDINGS;
  const personName = local || external ? name : people.find(person => person.openId === openId)?.name || name;
  const busy = status === 'submitting' || status === 'previewing';
  const currentTemplate = authorization?.mode === 'follow' ? roles?.roles.find(item => item.id === authorization.templateId) : undefined;
  const templateConflict = authorization?.mode === 'follow' && (!roles || roles.revision !== data.revision || !currentTemplate || currentTemplate.version !== authorization.templateVersion);
  const revisionError = accountRevisionError(data.revision, account, data.accounts);
  useEffect(() => {
    if (!account || !profileEditable || account.effectiveAuthorization) return;
    let active = true; setAuthorizationLoading(true); setAuthorizationError('');
    void loadAccountAuthorization(account.id).then(result => {
      if (!active) return;
      if (result.revision !== latestRevision.current) throw new Error('配置已变化，请刷新配置后重新读取权限');
      setAuthorization(current => current || structuredClone(result.after));
      setRole(result.after.baseline.nativeRole || 'guest');
    }).catch(failure => { if (active) setAuthorizationError((failure as Error).message); }).finally(() => { if (active) setAuthorizationLoading(false); });
    return () => { active = false; };
  }, [account?.id, account?.effectiveAuthorization, profileEditable, authorizationRetry]);
  const principal = useMemo(() => ({ role, purchaseBuilding: scoped ? selectedBuildings[0] || null : null, ...(scoped ? { buildings: selectedBuildings } : {}), ...(professional ? { specialties } : {}) }), [role, scoped, selectedBuildings, professional, specialties]);
  const linked = useMemo(() => account ? synchronizedAccounts(account, data.accounts, data.appId) : [], [account, data.accounts, data.appId]);
  const legacyPreview = useMemo<EffectiveAuthorization>(() => ({ mode: 'independent', baseline: { nativeRole: role, pages: effectivePagePaths(role, data.rolePageRules), rules: account?.personalRules || [] }, overrides: { ...emptyAuthorizationOverrides(), allowPages: account?.pagePaths || [] } }), [role, data.rolePageRules, account]);
  const binding = useMemo(() => authorization ? authorization.mode === 'follow' ? { mode: 'follow' as const, templateId: authorization.templateId! } : { mode: 'independent' as const, policy: authorization.baseline } : undefined, [authorization]);
  const fingerprint = useMemo(() => JSON.stringify([data.revision, personName, openId, role, selectedBuildings, specialties, enabled, binding, authorization?.overrides, confirmReactivation, password]), [data.revision, personName, openId, role, selectedBuildings, specialties, enabled, binding, authorization?.overrides, confirmReactivation, password]);
  const verified = preview?.fingerprint === fingerprint && !templateConflict && !revisionError;
  function changeRole(next: ManagedAccessRole) {
    setRole(next);
    const options = ['building_admin', 'professional_engineer'].includes(next) ? BUILDING_ADMIN_BUILDINGS : PURCHASE_ACCESS_BUILDINGS;
    setSelectedBuildings(previous => ['inventory_admin', 'building_admin', 'purchase_applicant', 'professional_engineer'].includes(next) ? previous.filter(item => (options as readonly string[]).includes(item)) : []);
  }
  function chooseTemplate(id: string) {
    const template = roles?.roles.find(item => item.id === id);
    if (!template || !template.enabled && id !== account?.effectiveAuthorization?.templateId) return;
    if (authorization && (authorization.mode !== 'follow' || authorization.templateId !== id)) setModeBefore({ value: structuredClone(authorization), principal: structuredClone(principal) });
    setAuthorization(followTemplate(authorization, template));
    changeRole(template.policy.nativeRole || 'guest');
  }
  function independent() {
    if (authorization?.mode === 'independent') return;
    if (authorization) setModeBefore({ value: structuredClone(authorization), principal: structuredClone(principal) });
    const detached = authorization ? detachAuthorization(authorization) : { authorizationBinding: { mode: 'independent' as const, policy: { nativeRole: null, pages: [], rules: [] } }, authorizationOverrides: emptyAuthorizationOverrides() };
    if (detached.authorizationBinding.mode !== 'independent') return;
    setAuthorization({ mode: 'independent', baseline: detached.authorizationBinding.policy, overrides: detached.authorizationOverrides });
    changeRole(detached.authorizationBinding.policy.nativeRole || 'guest');
  }
  function validate() {
    if (revisionError) return revisionError;
    if (templateConflict) return '角色模板已变化，请核对新权限后再保存';
    if (professional && (!specialties.length || sharedLogin)) return '请选择负责专业；该角色须使用人员账号';
    if (!personName.trim() || !account && !openId.trim() || scoped && !selectedBuildings.length) return '请选择人员及适用楼栋';
    if (external && !/^ou_[A-Za-z0-9_-]{1,124}$/.test(openId.trim())) return '请输入有效的飞书 Open ID';
    if (password && password.length < 8) return '新密码至少8个字符';
    if (account?.reactivationRequired && enabled && !confirmReactivation) return '复职账号须明确确认恢复登录';
    if (profileEditable && !authorization) return '请选择角色或独立配置，并等待权限读取完成';
    if (authorization && (!validPersonalRules(authorization.baseline.rules) || !validPersonalRules(authorization.overrides.rules) || !validPagePaths(authorization.baseline.pages) || !validPagePaths(authorization.overrides.allowPages) || !validPagePaths(authorization.overrides.denyPages))) return '请检查页面、操作和范围配置';
    return '';
  }
  async function check() {
    if (pending.current) return;
    const problem = validate(); if (problem) { setError(problem); setStatus('error'); return; }
    pending.current = true; setStatus('previewing'); setError(''); setAcknowledged(false); setPreview(undefined);
    try {
      let result: AuthorizationAccountPreview | undefined;
      if (account && profileEditable && authorization && binding) {
        const input: AuthorizationAccountChange = { accountId: account.id, expectedRevision: data.revision, binding, overrides: authorization.overrides, building: principal.purchaseBuilding, ...(scoped ? { buildings: selectedBuildings } : {}), ...(professional ? { specialties } : {}) };
        result = await previewAccountAuthorization(input);
        if (result.revision !== latestRevision.current) throw new Error('配置已变化，请重新核对');
      }
      setPreview({ fingerprint, result }); setStatus('ready');
    } catch (failure) { setError((failure as Error).message); setStatus('error'); }
    finally { pending.current = false; }
  }
  async function submit(deleted = false) {
    if (pending.current) return;
    const problem = validate(); if (problem) { setError(problem); setStatus('error'); return; }
    if (!deleted && (!verified || !acknowledged)) { setError('请先核对权限变化并确认'); return; }
    const body: Omit<AccountMutation, 'clientMutationId'> = { expectedRevision: data.revision, ...(account ? { id: account.id } : {}), kind: local ? 'local' : 'feishu', name: personName.trim(), role, building: scoped ? selectedBuildings[0] : null, ...(scoped ? { buildings: selectedBuildings } : {}), enabled: deleted ? false : enabled, deleted,
      ...(professional ? { specialties } : {}), ...(!local && openId ? { openId: openId.trim() } : {}), ...(local && password ? { password } : {}), ...(external ? { external: true } : {}),
      ...(profileEditable && authorization && binding ? { authorizationBinding: binding, authorizationOverrides: authorization.overrides } : {}), ...(confirmReactivation ? { confirmReactivation: true } : {}) };
    const signature = JSON.stringify(body); if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    pending.current = true; setStatus('submitting'); setError('');
    try { const result = await saveAccount({ ...body, clientMutationId: request.current.id }); setPassword(''); onSaved(result, account?.id); }
    catch (failure) { setError((failure as Error).message); setStatus('error'); }
    finally { pending.current = false; }
  }
  return <Sheet open onOpenChange={open => { if (!open && !pending.current) onClose(); }}><SheetContent showCloseButton={false} className="configuration-editor w-full gap-0 p-0 sm:max-w-3xl" aria-describedby="account-editor-description">
    <Button type="button" variant="ghost" size="icon" aria-label="关闭" className="absolute right-3 top-3" disabled={busy} onClick={onClose}><X className="size-4" /></Button>
    <SheetHeader className="border-b p-5"><SheetTitle>{account ? '编辑账号权限' : external ? '新增外部飞书授权' : '新增飞书授权'}</SheetTitle><SheetDescription id="account-editor-description" className="sr-only">维护账号身份、权限和适用范围；核对结果后保存。</SheetDescription></SheetHeader>
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); void submit(); }}><div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
      {requestContext && <section className="space-y-2 rounded-lg border bg-primary/5 p-3 text-sm" aria-label="正在处理的权限申请"><p className="font-medium">{requestContext.applicantName}的权限申请</p><p className="whitespace-pre-wrap break-words text-muted-foreground">{requestContext.reason}</p><p className="text-xs text-muted-foreground">保存后返回原申请列表，再确认已授权。</p></section>}
      {!local && <div className="space-y-2"><Label htmlFor="config-person">{external ? '飞书 Open ID' : '飞书人员'}</Label>{external ? <Input id="config-person" value={openId} disabled={!!account?.openId || busy} maxLength={127} placeholder="填写当前应用的 ou_ 开头 Open ID" onChange={event => setOpenId(event.target.value)} /> : <PersonPicker people={people} name={personName} locked={!!account?.openId} disabled={busy} onSelect={person => { setOpenId(person.openId); setName(person.name); }} onClear={() => { setOpenId(''); setName(''); }} />}{external && <p className="text-xs text-muted-foreground">Open ID 必须来自当前飞书应用。</p>}</div>}
      <div className="space-y-2"><Label htmlFor="config-account-name">{sharedLogin ? '密码登录名称' : '姓名'}</Label><Input id="config-account-name" value={personName} maxLength={128} readOnly={personnelPassword || !local && !external} disabled={busy} onChange={event => { if (local || external) setName(event.target.value); }} required /></div>
      {profileEditable ? <section className="space-y-3 rounded-lg border p-3"><p className="text-sm font-medium">授权方式</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant={authorization?.mode === 'follow' ? 'default' : 'outline'} disabled={busy || authorizationLoading} onClick={() => { if (authorization?.mode === 'follow') return; const matching = roles?.roles.find(item => item.enabled && item.policy.nativeRole === authorization?.baseline.nativeRole); if (matching) chooseTemplate(matching.id); else setError('请从下方选择角色模板'); }}>跟随角色</Button><Button type="button" size="sm" variant={authorization?.mode === 'independent' ? 'default' : 'outline'} disabled={busy || authorizationLoading || authorization?.baseline.nativeRole === 'admin'} onClick={independent}>{authorization?.mode === 'follow' ? '转为独立配置' : '独立配置'}</Button></div>
        <label className="block space-y-2 text-sm"><span>选择角色</span><select className="config-select w-full" aria-label="选择角色模板" value={authorization?.mode === 'follow' ? authorization.templateId : ''} disabled={busy || rolesLoading || authorizationLoading} onChange={event => chooseTemplate(event.target.value)}><option value="">{rolesLoading ? '正在读取角色…' : '选择角色模板'}</option>{roles?.roles.map(template => <option key={template.id} value={template.id} disabled={!template.enabled && template.id !== account?.effectiveAuthorization?.templateId}>{template.name}{!template.enabled ? '（停止新增分配）' : ''}</option>)}</select></label>
        {authorization?.mode === 'follow' && <p className="text-xs text-muted-foreground">跟随角色后续更新；个人例外保留。角色版本 {authorization.templateVersion}</p>}{authorization?.mode === 'independent' && <p className="text-xs text-muted-foreground">保存当前权限，不再跟随角色后续更新。</p>}
        {templateConflict && <p role="alert" className="text-sm text-destructive">模板已更新，草稿保留。<Button type="button" variant="link" disabled={busy || !currentTemplate} onClick={() => currentTemplate && chooseTemplate(currentTemplate.id)}>接纳当前模板并保留个人例外</Button></p>}
        {(rolesError || authorizationError) && <p role="alert" className="text-sm text-destructive">{rolesError || authorizationError}<Button type="button" variant="link" disabled={busy || authorizationLoading} onClick={() => { onRefreshRoles?.(); setAuthorizationRetry(value => value + 1); }}>重新读取</Button></p>}
        {authorizationLoading && <p role="status" className="text-sm text-muted-foreground">正在读取当前有效权限，已有身份资料保留…</p>}
      </section> : <div className="space-y-2"><Label htmlFor="config-role">权限角色</Label><select id="config-role" className="config-select w-full" value={role} disabled={backup || busy} onChange={event => changeRole(event.target.value as ManagedAccessRole)}>{Object.entries(ROLE_LABELS).filter(([key]) => !['guest', 'professional_admin', 'professional_engineer'].includes(key) && (key !== 'site_member' || account?.siteMember || backup)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><p className="text-xs text-muted-foreground">共享入口沿用固定角色，个人授权请使用本人账号。</p></div>}
      {modeBefore && authorization && <details className="space-y-3 rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">查看授权方式切换前后差异</summary><p className="text-xs text-muted-foreground">{modeBefore.value.mode === 'independent' && authorization.mode === 'follow' ? '原独立规则未带入新角色；如需额外授权，请在新角色下明确设置个人例外。' : '跟随角色切换保留个人例外，转为独立配置保留切换前完整权限。'}</p><PermissionEditor label="切换前权限" value={modeBefore.value} principal={modeBefore.principal} readOnly /><PermissionEditor label="当前草稿权限" value={authorization} principal={principal} readOnly /></details>}
      {scoped && <fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">任职楼栋</legend><div className="flex flex-wrap gap-3">{buildings.map(value => <label key={value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedBuildings.includes(value)} onChange={event => setSelectedBuildings(previous => buildings.filter(item => event.target.checked ? [...previous, value].includes(item) : previous.filter(item => item !== value).includes(item)))} />{value}</label>)}</div></fieldset>}
      {professional && <fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">任职专业</legend><div className="flex flex-wrap gap-3">{PROFESSIONAL_SPECIALTIES.map(value => <label key={value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={specialties.includes(value)} onChange={event => setSpecialties(previous => event.target.checked ? [...previous, value] : previous.filter(item => item !== value))} />{value}</label>)}</div></fieldset>}
      {(authorization || !profileEditable) && <PermissionEditor value={profileEditable ? authorization! : legacyPreview} principal={principal} requestedPermissions={requestContext?.permissions} onChange={setAuthorization} readOnly={!profileEditable || authorization?.baseline.nativeRole === 'admin'} disabled={busy || !!revisionError || !!templateConflict} />}
      <div className="space-y-2"><Label htmlFor="config-enabled">账号状态</Label><select id="config-enabled" className="config-select w-full" value={enabled ? 'enabled' : 'disabled'} disabled={busy} onChange={event => setEnabled(event.target.value === 'enabled')}><option value="enabled">启用</option><option value="disabled">停用</option></select></div>
      {(account?.permissionsRevoked || account?.reactivationRequired) && <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><input type="checkbox" checked={confirmReactivation} disabled={busy} onChange={event => setConfirmReactivation(event.target.checked)} /><span>确认恢复业务授权<span className="block text-xs text-muted-foreground">此账号须重新核对身份及当前权限后恢复。</span></span></label>}
      {personnelPassword && <p className="text-xs text-muted-foreground">姓名、密码和在职状态由人员表维护。</p>}
      {sharedLogin && <div className="space-y-2"><Label htmlFor="config-password">新访问密码</Label><Input id="config-password" type="password" autoComplete="new-password" value={password} maxLength={256} onChange={event => setPassword(event.target.value)} disabled={busy} placeholder={account?.passwordConfigured && account.enabled && !account.deleted ? '留空保持现有密码' : '启用时设置新密码，至少8个字符'} /><p className="text-xs text-muted-foreground">修改后，该入口已登录会话失效。</p></div>}
      {account && <section className="space-y-2 rounded-lg border p-3 text-sm" aria-label="关联登录影响"><p className="font-medium">本次保存影响</p><p>{account.name} · {accountLoginLabel(account)}：保存后该入口需重新登录。</p>{linked.map(item => <p key={item.id}>{item.name} · {accountLoginLabel(item)}：权限与范围同步，已登录会话失效。</p>)}{!!linked.length && <p className="text-xs text-muted-foreground">账号停用、删除仅作用于当前入口；确认复职会按已核验身份恢复关联入口。关联只按人员记录身份，不按姓名。</p>}{!linked.length && <p className="text-xs text-muted-foreground">没有符合同步条件的关联登录入口。</p>}</section>}
      {preview && <section className="space-y-3 rounded-lg border p-3" aria-label="账号权限变更预览"><h3 className="text-sm font-medium">变更核对</h3><p className="text-sm">{personName} · {enabled ? '启用' : '停用'}{preview.result?.sessionWillBeRevoked ? ' · 保存后需重新登录' : ''}</p>{preview.result && <details><summary className="cursor-pointer text-sm">查看保存后的权限</summary><div className="mt-3"><PermissionEditor label="保存后权限" value={preview.result.after} principal={principal} readOnly /></div></details>}{!verified && <p role="status" className="text-sm text-muted-foreground">草稿或配置已变化，请重新核对。</p>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={!verified || busy} onChange={event => setAcknowledged(event.target.checked)} />已核对身份、权限及生效范围</label></section>}
      {(error || revisionError) && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error || revisionError}<Button type="button" variant="link" disabled={busy} onClick={() => window.dispatchEvent(new Event('configuration-refresh-request'))}>刷新配置</Button></div>}
    </div><footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-card p-4"><div>{account && !account.deleted && <Button type="button" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>删除授权</Button>}</div><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="button" variant="outline" disabled={busy || authorizationLoading} onClick={() => void check()}>{status === 'previewing' ? '正在核对…' : '核对权限'}</Button><Button type="submit" disabled={busy || !verified || !acknowledged}>{status === 'submitting' && <Loader2 className="size-4 animate-spin" />}{status === 'submitting' ? '保存中…' : '保存'}</Button></div></footer></form>
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除授权</AlertDialogTitle><AlertDialogDescription>删除“{personName}”的授权后，旧登录失效，已有业务单据仍保留原处理记录。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void submit(true)}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </SheetContent></Sheet>;
}
