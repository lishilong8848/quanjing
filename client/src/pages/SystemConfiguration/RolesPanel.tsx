import { useMemo, useRef, useState } from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import type { AccessConfigurationResponse, ManagedAccount } from '@shared/access-configuration.interface';
import type { AuthorizationRoleList, AuthorizationRoleMutation, AuthorizationRolePreview, EffectiveAuthorization } from '@shared/authorization-profile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { previewAuthorizationRole, saveAuthorizationRole } from './api';
import { PermissionEditor } from './PermissionEditor';
import { emptyAuthorizationOverrides } from './authorization-editing';

type RoleRow = AuthorizationRoleList['roles'][number];
export function RolesPanel({ roles, accounts, revision, loading, error, onRefresh, onSaved }: {
  roles?: AuthorizationRoleList; accounts: ManagedAccount[]; revision: number; loading: boolean; error: string;
  onRefresh: () => void; onSaved: (value: AccessConfigurationResponse) => void;
}) {
  const [query, setQuery] = useState(''), [editing, setEditing] = useState<{ role?: RoleRow }>();
  const visible = useMemo(() => roles?.roles.filter(role => !query.trim() || `${role.name} ${role.description}`.includes(query.trim())) || [], [roles, query]);
  return <section className="space-y-4" aria-label="角色模板">
    <div className="flex flex-wrap items-center gap-3"><Input className="min-w-40 flex-1" placeholder="搜索角色" aria-label="搜索角色" value={query} onChange={event => setQuery(event.target.value)} /><Button variant="outline" disabled={loading} onClick={onRefresh}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新角色</Button><Button disabled={!roles} onClick={() => setEditing({})}><Plus className="size-4" />新增角色</Button></div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}，已有角色保留。</p>}
    <div className="divide-y rounded-lg border bg-card">{visible.map(role => <article key={role.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0 space-y-1"><p className="break-words font-medium">{role.name} <Badge variant="outline">{role.builtin ? '系统角色' : '自定义角色'}</Badge></p>{role.description && <p className="break-words text-sm text-muted-foreground">{role.description}</p>}<p className="text-xs text-muted-foreground">{role.followerCount} 人跟随 · 版本 {role.version}{!role.enabled ? ' · 已停止新增分配，现有人员继续生效' : ''}</p></div><Button variant="outline" onClick={() => setEditing({ role })}>{role.policy.nativeRole === 'admin' ? '查看' : '编辑'}</Button></article>)}{!visible.length && <p role="status" className="p-8 text-center text-sm text-muted-foreground">{loading && !roles ? '正在读取角色…' : query ? '没有匹配角色' : '暂无角色'}</p>}</div>
    {editing && roles && <RoleEditor key={editing.role?.id || 'new'} original={editing.role} current={editing.role ? roles.roles.find(role => role.id === editing.role!.id) : undefined} accounts={accounts} revision={revision} directoryRevision={roles.revision} onClose={() => setEditing(undefined)} onRefresh={onRefresh} onSaved={value => { onSaved(value); setEditing(undefined); }} />}
  </section>;
}

function RoleEditor({ original, current, accounts, revision, directoryRevision, onClose, onRefresh, onSaved }: {
  original?: RoleRow; current?: RoleRow; accounts: ManagedAccount[]; revision: number; directoryRevision: number; onClose: () => void; onRefresh: () => void; onSaved: (value: AccessConfigurationResponse) => void;
}) {
  const [name, setName] = useState(original?.name || ''), [description, setDescription] = useState(original?.description || '');
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [authorization, setAuthorization] = useState<EffectiveAuthorization>(() => ({ mode: 'independent', baseline: structuredClone(original?.policy || { nativeRole: null, pages: [], rules: [] }), overrides: emptyAuthorizationOverrides() }));
  const [status, setStatus] = useState<'ready' | 'previewing' | 'saving' | 'error'>('ready'), [error, setError] = useState('');
  const [preview, setPreview] = useState<{ value: AuthorizationRolePreview; input: AuthorizationRoleMutation; fingerprint: string }>(), [acknowledged, setAcknowledged] = useState(false);
  const pending = useRef(false), request = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const latestRevision = useRef(revision); latestRevision.current = revision;
  const [impactLimit, setImpactLimit] = useState(20);
  const [followerLimit, setFollowerLimit] = useState(20);
  const followers = useMemo(() => original ? accounts.filter(account => account.authorizationBinding?.mode === 'follow' && account.authorizationBinding.templateId === original.id) : [], [accounts, original]);
  const fixed = original?.policy.nativeRole === 'admin', busy = status === 'previewing' || status === 'saving';
  const conflict = directoryRevision !== revision || !!original && (!current || current.version !== original.version);
  const draft = useMemo(() => ({ expectedRevision: revision, ...(original ? { id: original.id } : {}), name: name.trim(), description: description.trim(), enabled, policy: authorization.baseline }), [revision, original, name, description, enabled, authorization.baseline]);
  const fingerprint = useMemo(() => JSON.stringify(draft), [draft]);
  const verified = preview?.fingerprint === fingerprint && preview.value.revision === revision && !conflict;
  async function check(deleted = false) {
    if (pending.current || fixed || conflict) return;
    if (!draft.name) { setError('请填写角色名称'); return; }
    if (deleted && (!original || original.builtin || (current?.followerCount || 0) > 0)) { setError('系统角色或仍有人跟随的角色不能删除'); return; }
    const signature = JSON.stringify([draft, deleted]);
    if (request.current?.fingerprint !== signature) request.current = { fingerprint: signature, id: crypto.randomUUID() };
    const input: AuthorizationRoleMutation = { ...draft, clientMutationId: request.current.id, ...(deleted ? { deleted: true } : {}) };
    pending.current = true; setStatus('previewing'); setError(''); setPreview(undefined); setAcknowledged(false);
    try { const value = await previewAuthorizationRole(input); if (value.revision !== latestRevision.current) throw new Error('配置版本已变化，请重新核对影响'); setPreview({ value, input, fingerprint }); setImpactLimit(20); setStatus('ready'); }
    catch (failure) { setError((failure as Error).message); setStatus('error'); }
    finally { pending.current = false; }
  }
  async function save() {
    if (pending.current || !preview || !verified || !acknowledged || fixed) return;
    pending.current = true; setStatus('saving'); setError('');
    try { onSaved(await saveAuthorizationRole(preview.input)); }
    catch (failure) { setError((failure as Error).message); setStatus('error'); }
    finally { pending.current = false; }
  }
  const actor = useMemo(() => ({ role: authorization.baseline.nativeRole || 'guest' as const, purchaseBuilding: null }), [authorization.baseline.nativeRole]);
  return <Sheet open onOpenChange={open => { if (!open && !pending.current) onClose(); }}><SheetContent className="configuration-editor w-full gap-0 p-0 sm:max-w-3xl"><SheetHeader className="border-b p-5"><SheetTitle>{original ? `${fixed ? '查看' : '编辑'}角色 · ${original.name}` : '新增角色'}</SheetTitle><SheetDescription className="sr-only">角色权限与跟随人员影响，核对后保存。</SheetDescription></SheetHeader>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
      {conflict && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">角色或配置版本已更新，草稿保留。<Button variant="link" disabled={busy} onClick={onRefresh}>重新读取角色</Button>如角色本身已改变，请关闭后重新打开核对。</p>}
      <div className="space-y-2"><Label htmlFor="authorization-role-name">角色名称</Label><Input id="authorization-role-name" value={name} disabled={busy || fixed || conflict} maxLength={80} onChange={event => setName(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="authorization-role-description">说明</Label><Input id="authorization-role-description" value={description} disabled={busy || fixed || conflict} maxLength={500} onChange={event => setDescription(event.target.value)} /></div>
      {!fixed && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={!enabled} disabled={busy || conflict} onChange={event => setEnabled(!event.target.checked)} /><span>停止新增分配<span className="block text-xs text-muted-foreground">现有跟随者继续使用此角色权限。</span></span></label>}
      {original && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">跟随人员 · {current?.followerCount ?? original.followerCount} 人</summary><div className="mt-3 space-y-2">{followers.slice(0, followerLimit).map(account => <p key={account.id} className="break-words text-sm">{account.name}</p>)}{followers.length > followerLimit && <Button variant="outline" size="sm" onClick={() => setFollowerLimit(value => value + 20)}>显示更多</Button>}{!followers.length && <p className="text-sm text-muted-foreground">当前账号清单中没有跟随人员。</p>}</div></details>}
      <PermissionEditor label="角色权限" value={authorization} principal={actor} template readOnly={fixed} disabled={busy || conflict} onChange={setAuthorization} />
      {preview && <section className="space-y-3 rounded-lg border p-3" aria-label="角色影响预览"><h3 className="font-medium">{preview.input.deleted ? '删除角色' : '保存角色'} · 影响 {preview.value.affectedAccounts.length} 人</h3>{preview.value.affectedAccounts.slice(0, impactLimit).map(impact => <RoleImpact key={impact.accountId} impact={impact} account={accounts.find(account => account.id === impact.accountId)} />)}{preview.value.affectedAccounts.length > impactLimit && <Button variant="outline" onClick={() => setImpactLimit(value => value + 20)}>显示更多受影响人员</Button>}{!verified && <p role="status" className="text-sm text-muted-foreground">草稿或配置已变化，请重新核对影响。</p>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={!verified || busy} onChange={event => setAcknowledged(event.target.checked)} />已核对人员及权限变化</label></section>}
      {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}，草稿保留。<Button variant="link" disabled={busy} onClick={onRefresh}>刷新角色</Button></p>}
    </div><footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-card p-4"><div>{original && !original.builtin && <Button variant="ghost" className="text-destructive" disabled={busy || conflict || !!current?.followerCount} onClick={() => void check(true)}>预览删除</Button>}</div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>{fixed ? '关闭' : '取消'}</Button>{!fixed && <><Button variant="outline" disabled={busy || conflict} onClick={() => void check()}>{status === 'previewing' ? '正在核对…' : '核对影响'}</Button><Button disabled={busy || !verified || !acknowledged} onClick={() => void save()}>{status === 'saving' && <Loader2 className="size-4 animate-spin" />}{status === 'saving' ? '保存中…' : preview?.input.deleted ? '确认删除角色' : '保存角色'}</Button></>}</div></footer>
  </SheetContent></Sheet>;
}

function RoleImpact({ impact, account }: { impact: AuthorizationRolePreview['affectedAccounts'][number]; account?: ManagedAccount }) {
  const [open, setOpen] = useState(false);
  const principal = useMemo(() => ({ role: account?.role || 'guest' as const, purchaseBuilding: account?.building || null, buildings: account?.buildings, specialties: account?.specialties }), [account]);
  return <details className="rounded-md border p-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm">{impact.name}{impact.sessionWillBeRevoked ? ' · 需重新登录' : ' · 登录保持'}</summary>{open && <div className="mt-3 space-y-4">{account ? <><PermissionEditor label={`${impact.name}变更前`} principal={principal} value={impact.before} readOnly /><PermissionEditor label={`${impact.name}变更后`} principal={principal} value={impact.after} readOnly /></> : <p role="status" className="text-sm text-muted-foreground">人员范围尚未取得，请刷新配置后核对。</p>}</div>}</details>;
}
