import { useMemo, useRef, useState } from 'react';
import { Loader2, Save, ShieldCheck } from 'lucide-react';
import type { AccessRole } from '@shared/access-control.interface';
import type { AccessConfigurationResponse } from '@shared/access-configuration.interface';
import { PAGE_ACCESS_CATALOG, effectivePagePaths } from '@shared/page-access';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ROLE_LABELS } from './model';
import { savePageRole } from './api';

const GROUPS = { platform: '平台门户', operations: '运营指挥', people: '人员保障', safety: '运维质量', equipment: '设备运维', supply: '采·供·存', knowledge: '知识交付' };
export function PagePermissionPanel({ data, onSaved }: { data: AccessConfigurationResponse; onSaved: (value: AccessConfigurationResponse) => void }) {
  const [role, setRole] = useState<AccessRole>('guest');
  const [drafts, setDrafts] = useState<Partial<Record<AccessRole, string[]>>>({});
  const [search, setSearch] = useState(''), [error, setError] = useState('');
  const [status, setStatus] = useState<'ready'|'submitting'|'success'|'error'>('ready');
  const pending = useRef(false), mutation = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const [restoring, setRestoring] = useState<Partial<Record<AccessRole, boolean>>>({});
  const selected = drafts[role] ?? effectivePagePaths(role, data.rolePageRules);
  const fixed = role === 'admin', busy = status === 'submitting';
  const groups = useMemo(() => Object.entries(GROUPS).map(([key, label]) => ({ key, label, pages: PAGE_ACCESS_CATALOG.filter(page => page.group === key && (!search || page.label.includes(search.trim()))) })).filter(group => group.pages.length), [search]);
  const dirty = Boolean(restoring[role] && data.rolePageRules?.[role]) || JSON.stringify([...selected].sort()) !== JSON.stringify(effectivePagePaths(role, data.rolePageRules).sort());
  function change(paths: string[], restore = false) { setDrafts(current => ({ ...current, [role]: paths })); setRestoring(current => ({ ...current, [role]: restore })); setStatus('ready'); setError(''); }
  async function save() {
    if (pending.current || fixed || !dirty) return;
    pending.current = true; setStatus('submitting'); setError('');
    const savedRole = role, pages = [...selected].sort(), fingerprint = JSON.stringify([role, pages, data.revision, restoring[role]]);
    if (mutation.current?.fingerprint !== fingerprint) mutation.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const result = await savePageRole({ clientMutationId: mutation.current.id, expectedRevision: data.revision, role, pages, ...(restoring[role] ? { restoreDefault: true } : {}) });
      onSaved(result); setDrafts(current => { const next = { ...current }; delete next[savedRole]; return next; }); setRestoring(current => ({ ...current, [savedRole]: false })); setStatus('success');
    } catch (failure) { setError((failure as Error).message); setStatus('error'); }
    finally { pending.current = false; }
  }
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3"><label htmlFor="page-permission-role" className="text-sm font-medium">权限角色</label><select id="page-permission-role" className="config-select" disabled={busy} value={role} onChange={event => { setRole(event.target.value as AccessRole); setError(''); setStatus('ready'); }}>{Object.entries(ROLE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select><span className="text-sm text-muted-foreground">已开放 {selected.length} / {PAGE_ACCESS_CATALOG.length} 页</span></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={fixed || busy} onClick={() => change(effectivePagePaths(role), true)}>恢复默认</Button><Button disabled={fixed || busy || !dirty} onClick={() => void save()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{busy ? '保存中…' : '保存页面权限'}</Button></div>
    </div>
    <p className="flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheck className="size-4 shrink-0" />{fixed ? '管理员始终可访问全部页面及配置。' : '勾选开放页面读取；编辑、删除及楼栋、专业权限保持原规则。'}</p>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error} 草稿已保留，可重试。</p>}
    {status === 'success' && <p role="status" className="text-sm text-primary">页面权限已保存</p>}
    <input className="config-select w-full sm:max-w-sm" placeholder="搜索页面" aria-label="搜索页面" value={search} onChange={event => setSearch(event.target.value)} />
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{groups.map(group => <Card key={group.key} className="gap-0"><CardHeader className="pb-3"><CardTitle className="flex items-center justify-between text-base">{group.label}<Button size="sm" variant="ghost" disabled={fixed || busy} onClick={() => { const paths = group.pages.map(page => page.path); change(paths.every(path => selected.includes(path)) ? selected.filter(path => !paths.includes(path as never)) : [...new Set([...selected, ...paths])]); }}>{group.pages.every(page => selected.includes(page.path)) ? '取消全选' : '全选'}</Button></CardTitle></CardHeader><CardContent className="space-y-2">{group.pages.map(page => <label key={page.path} className="flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-2 py-3 hover:bg-muted"><Checkbox aria-label={page.label} checked={selected.includes(page.path)} disabled={fixed || busy} onCheckedChange={checked => change(checked === true ? [...selected, page.path] : selected.filter(path => path !== page.path))} /><span className="text-sm">{page.label}</span></label>)}</CardContent></Card>)}</div>
    {!groups.length && <p className="p-8 text-center text-muted-foreground">没有匹配页面</p>}
  </section>;
}
