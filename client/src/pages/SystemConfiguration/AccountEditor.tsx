import { validPersonalRules, type PersonalPermissionRule } from '@shared/business-permissions';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '@shared/site-member-backup';
import { PersonalPermissionEditor } from './PersonalPermissionEditor';
import { PersonalPagePermissionEditor } from './PersonalPagePermissionEditor';
import { validPersonalPagePaths } from '@shared/page-access';
import { useMemo, useRef, useState } from 'react';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import type { AccessConfigurationResponse, AccountMutation, ConfigurationPerson, ManagedAccount, ManagedAccessRole } from '@shared/access-configuration.interface';
import { BUILDING_ADMIN_BUILDINGS, PURCHASE_ACCESS_BUILDINGS, type BuildingAdminBuilding } from '@shared/access-control.interface';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { canAccessPage } from '@/access/access-policy';
import { ROLE_LABELS } from './model';
import { saveAccount } from './api';
import { PersonPicker } from './PersonPicker';
import { PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from '@shared/professional-access';
import { accountRevisionError, optionalAccountPermissions } from './account-mutation';

export function AccountEditor({ account, data, people, external = false, onClose, onSaved }: { account?: ManagedAccount; data: AccessConfigurationResponse; people: ConfigurationPerson[]; external?: boolean; onClose: () => void; onSaved: (result: AccessConfigurationResponse, id?: string) => void }) {
  const [name, setName] = useState(account?.name || ''), [openId, setOpenId] = useState(account?.openId || ''), [password, setPassword] = useState('');
  const [role, setRole] = useState<ManagedAccessRole>(account?.role || 'editor'), [selectedBuildings, setSelectedBuildings] = useState<BuildingAdminBuilding[]>(account?.buildings || (account?.building ? [account.building] : []));
  const [personalRules, setPersonalRules] = useState<PersonalPermissionRule[]>(structuredClone(account?.personalRules || []));
  const [pagePaths, setPagePaths] = useState<string[]>([...(account?.pagePaths || [])]);
  const professional = role === 'professional_admin' || role === 'professional_engineer';
  const [specialties, setSpecialties] = useState<ProfessionalSpecialty[]>(account?.specialties || []);
  const [enabled, setEnabled] = useState(account?.permissionsRevoked ? account.guestLoginAllowed === true : account?.enabled ?? true), [error, setError] = useState(''), [status, setStatus] = useState<'ready'|'submitting'|'error'>('ready');
  const pending = useRef(false), requestRef = useRef<{ signature: string; id: string } | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const local = account?.kind === 'local';
  const backup = account?.id === SITE_MEMBER_BACKUP_ACCOUNT_ID;
  const personnelPassword = account?.loginMethod === 'personnel-password';
  const personName = local || external ? name : people.find(person => person.openId === openId)?.name || name;
  const scoped = ['inventory_admin','building_admin','purchase_applicant','professional_engineer'].includes(role);
  const buildings = ['building_admin','professional_engineer'].includes(role) ? BUILDING_ADMIN_BUILDINGS : PURCHASE_ACCESS_BUILDINGS;
  const summary = useMemo(() => [['库房管理','/inventory-management'],['采购管理','/purchase-inventory-management'],['合同管理','/contract-management'],['施工管理','/construction-management']].filter(([,path]) => canAccessPage(role, path, data.rolePageRules?.[role])).map(([label]) => label), [role, data.rolePageRules]);
  async function submit(deleted = false) {
    if (pending.current) return;
    const revisionError = accountRevisionError(data.revision, account, data.accounts);
    if (revisionError) { setError(revisionError); setStatus('error'); return; }
    if (professional && (!specialties.length || (local && !personnelPassword))) { setError('请选择负责专业；该角色须使用人员账号'); return; }
    if (!validPersonalRules(personalRules)) { setError('请检查个人规则的操作、楼栋和专业选择'); return; }
    if (!validPersonalPagePaths(role,pagePaths)) { setError('请检查个人页面读取选择'); return; }
    if (!personName.trim() || (!account && !openId.trim()) || (scoped && !selectedBuildings.length)) { setError('请选择飞书人员及适用楼栋'); return; }
    if (external && !/^ou_[A-Za-z0-9_-]{1,124}$/.test(openId.trim())) { setError('请输入有效的飞书 Open ID'); return; }
    if (password && password.length < 8) { setError('新密码至少8个字符'); return; }
    pending.current = true; setStatus('submitting'); setError('');
    const body = { expectedRevision: data.revision, ...(account ? { id: account.id } : {}), kind: local ? 'local' as const : 'feishu' as const,
      name: personName.trim(), role, building: scoped ? selectedBuildings[0] : null, ...(scoped ? { buildings: selectedBuildings } : {}), enabled: deleted ? false : enabled, deleted,
      ...(professional ? { specialties } : {}), ...optionalAccountPermissions(account, personalRules, pagePaths),
      ...(!local && openId ? { openId: openId.trim() } : {}), ...(local && password ? { password } : {}) };
    if (external) Object.assign(body, { external: true });
    const signature = JSON.stringify(body);
    if (!requestRef.current || requestRef.current.signature !== signature) requestRef.current = { signature, id: crypto.randomUUID() };
    try { const result = await saveAccount({ ...body, clientMutationId: requestRef.current.id } as AccountMutation); setPassword(''); onSaved(result, account?.id); }
    catch (failure) { setError((failure as Error).message); setStatus('error'); }
    finally { pending.current = false; }
  }
  const changeRole = (next: ManagedAccessRole) => {
    setRole(next);
    setPagePaths(previous=>previous.filter(path=>validPersonalPagePaths(next,[path])));
    const options = ['building_admin','professional_engineer'].includes(next) ? BUILDING_ADMIN_BUILDINGS : PURCHASE_ACCESS_BUILDINGS;
    setSelectedBuildings(previous => ['inventory_admin','building_admin','purchase_applicant','professional_engineer'].includes(next) ? previous.filter(value => (options as readonly string[]).includes(value)) : []);
  };
  return <Sheet open onOpenChange={open => { if (!open && !pending.current) onClose(); }}><SheetContent showCloseButton={false} className="configuration-editor w-full gap-0 p-0 sm:max-w-2xl" aria-describedby="account-editor-description">
    <Button type="button" variant="ghost" size="icon" aria-label="关闭" className="absolute right-3 top-3" disabled={status === 'submitting'} onClick={onClose}><X className="size-4" /></Button>
    <SheetHeader className="border-b p-6"><SheetTitle>{account ? '编辑账号权限' : external ? '新增外部飞书授权' : '新增飞书授权'}</SheetTitle><SheetDescription id="account-editor-description" className="sr-only">维护账号状态、权限角色、楼栋范围和本地访问密码。</SheetDescription></SheetHeader>
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="flex-1 space-y-5 overflow-y-auto p-6">
        {!local && <div className="space-y-2"><Label htmlFor="config-person">{external ? '飞书 Open ID' : '飞书人员'}</Label>{external ? <Input id="config-person" value={openId} disabled={!!account?.openId || status === 'submitting'} maxLength={127} placeholder="填写当前应用的 ou_ 开头 Open ID" onChange={event => setOpenId(event.target.value)} /> : <PersonPicker people={people} name={personName} locked={!!account?.openId} disabled={status === 'submitting'} onSelect={person => { setOpenId(person.openId); setName(person.name); }} onClear={() => { setOpenId(''); setName(''); }} />}{external && <p className="text-xs text-muted-foreground">Open ID 必须来自本系统当前飞书应用。</p>}{account && !account.openId && <p className="text-xs text-muted-foreground">请匹配原授权人员；已有身份不能替换。</p>}</div>}
        <div className="space-y-2"><Label htmlFor="config-account-name">{local && !personnelPassword ? '密码登录名称' : '姓名'}</Label><Input id="config-account-name" value={personName} maxLength={128} onChange={event => { if (local || external) setName(event.target.value); }} readOnly={personnelPassword || (!local && !external)} placeholder={external ? '填写外部人员姓名' : local ? undefined : '选择人员后自动填入'} disabled={status === 'submitting'} required /></div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="config-role">权限角色</Label><select id="config-role" className="config-select w-full" value={role} disabled={backup || status === 'submitting'} onChange={event => changeRole(event.target.value as ManagedAccessRole)}>{Object.entries(ROLE_LABELS).filter(([key]) => (key !== 'site_member' || account?.siteMember === true || backup) && (key !== 'guest' || personnelPassword) && (!local || personnelPassword || !['professional_admin', 'professional_engineer'].includes(key))).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></div><div className="space-y-2"><Label id="config-building-label">生效范围</Label>{scoped ? <fieldset aria-labelledby="config-building-label" disabled={status === 'submitting'} className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">{buildings.map(value => <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${selectedBuildings.includes(value) ? 'border-primary bg-primary/5 text-primary' : 'border-border'}`}><input type="checkbox" checked={selectedBuildings.includes(value)} onChange={event => setSelectedBuildings(previous => buildings.filter(item => event.target.checked ? [...previous, value].includes(item) : previous.filter(item => item !== value).includes(item)))} />{value}</label>)}</fieldset> : <Input value="全基地" readOnly disabled aria-labelledby="config-building-label" />}</div></div>
        {professional && <fieldset className="space-y-2"><legend className="text-sm font-medium">负责专业</legend><div className="flex flex-wrap gap-2">{PROFESSIONAL_SPECIALTIES.map(value => <label key={value} className="flex cursor-pointer items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm"><input type="checkbox" checked={specialties.includes(value)} disabled={status === 'submitting'} onChange={event => setSpecialties(previous => event.target.checked ? [...previous, value] : previous.filter(item => item !== value))} />{value}</label>)}</div></fieldset>}
        <div className="rounded-lg border bg-muted/40 p-4"><p className="mb-2 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-primary" />业务访问范围</p><p className="text-sm leading-6 text-muted-foreground">{backup ? '基地成员默认页面只读；个人申请请使用本人账号' : role === 'site_member' ? '排班中心全部组件、本人申请；今日航图只读' : professional ? `知识交付全部业务；运维质量、设备运维、采供存：${specialties.join('、') || '请选择专业'}` : summary.join('、') || '公开页面'}{scoped ? `；受限业务按${selectedBuildings.join('、') || '所选楼栋'}鉴权` : ''}</p></div>
        {!backup && <PersonalPermissionEditor principal={{ role, purchaseBuilding: scoped ? selectedBuildings[0] || null : null, ...(scoped ? { buildings: selectedBuildings } : {}), ...(professional ? { specialties } : {}) }} rules={personalRules} onChange={setPersonalRules} disabled={status === 'submitting'} />}
        {!backup && <PersonalPagePermissionEditor role={role} roleRules={data.rolePageRules} pages={pagePaths} onChange={setPagePaths} disabled={status === 'submitting'} />}
        <div className="space-y-2"><Label htmlFor="config-enabled">账号状态</Label><select id="config-enabled" className="config-select w-full" value={enabled ? 'enabled' : 'disabled'} disabled={status === 'submitting'} onChange={event => setEnabled(event.target.value === 'enabled')}><option value="enabled">启用</option><option value="disabled">停用</option></select></div>
        {personnelPassword && <p className="text-xs text-muted-foreground">姓名、密码和在职状态由人员表维护。</p>}
        {local && !personnelPassword && <div className="space-y-2"><Label htmlFor="config-password">新访问密码</Label><Input id="config-password" type="password" autoComplete="new-password" value={password} maxLength={256} onChange={event => setPassword(event.target.value)} disabled={status === 'submitting'} placeholder={account?.passwordConfigured && account.enabled && !account.deleted ? '留空保持现有密码' : '启用时设置新密码，至少8个字符'} /><p className="text-xs text-muted-foreground">修改后，该入口已登录会话失效。</p></div>}
        {account && <p className="text-xs leading-5 text-muted-foreground">撤销授权会使旧登录失效。进行中的卡片单据保留已确定的处理人员。</p>}
        {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}<Button type="button" variant="link" className="h-auto px-2 text-destructive" onClick={() => window.dispatchEvent(new Event('configuration-refresh-request'))}>刷新配置</Button></div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-card p-4"><div>{account && !account.deleted && <Button type="button" variant="ghost" className="text-destructive" disabled={status === 'submitting'} onClick={() => setConfirmDelete(true)}>删除授权</Button>}</div><div className="flex gap-2"><Button type="button" variant="outline" disabled={status === 'submitting'} onClick={onClose}>取消</Button><Button type="submit" disabled={status === 'submitting'}>{status === 'submitting' && <Loader2 className="size-4 animate-spin" />}{status === 'submitting' ? '处理中…' : '保存'}</Button></div></div>
    </form><AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除授权</AlertDialogTitle><AlertDialogDescription>删除“{name}”的系统授权后，旧登录失效。此记录仍可重新启用。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void submit(true)}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </SheetContent></Sheet>;
}
