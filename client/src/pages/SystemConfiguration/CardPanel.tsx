import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Loader2, RotateCcw, ArrowRight, Bell, CheckCheck, X } from 'lucide-react';
import type { AccessConfigurationResponse, CardRoleCode, ConfigurationPerson } from '@shared/access-configuration.interface';
import { PURCHASE_ACCESS_BUILDINGS, type BuildingAdminBuilding } from '@shared/access-control.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { PersonSelector } from './PersonSelector';
import { CARD_LABELS } from './model';
import { loadCardMembers, saveCardRole } from './api';
import { sourceOwnsCardRole } from '@shared/personnel-source.interface';

const GROUPS = { purchase: { name: '采购', codes: ['purchase_manager','purchase_approvers','purchase_executor','building_executor'] }, inventory: { name: '出入库', codes: ['warehouse_responsible','warehouse_notify'] }, contract: { name: '合同', codes: ['contract_notify'] } } as const;
const SINGLE: CardRoleCode[] = ['purchase_executor','building_executor'];
const SCOPED: CardRoleCode[] = ['building_executor','warehouse_responsible','warehouse_notify'];
const OPTIONAL: CardRoleCode[] = ['warehouse_notify','contract_notify'];
export const CardPanel = memo(function CardPanel({ data, people, onSaved, onAccounts, onSource }: { data: AccessConfigurationResponse; people: ConfigurationPerson[]; onSaved: (data: AccessConfigurationResponse) => void; onAccounts: () => void; onSource?: () => void }) {
  const [group, setGroup] = useState<keyof typeof GROUPS>('purchase'), [building, setBuilding] = useState<BuildingAdminBuilding>('A楼');
  const [editing, setEditing] = useState<CardRoleCode>();
  const [defaults, setDefaults] = useState<Record<string, { members?: ConfigurationPerson[] | null; description?: string; error?: string }>>({});
  const [previewRetry, setPreviewRetry] = useState(0);
  const cachedDefaults = useRef<Record<string, { members?: ConfigurationPerson[] | null; description?: string }>>({});
  const cacheIdentity = useRef('');
  useEffect(() => {
    let active = true;
    const identity = `${data.appId}:${data.revision}`;
    if (cacheIdentity.current !== identity) { cacheIdentity.current = identity; cachedDefaults.current = {}; setDefaults({}); }
    for (const code of GROUPS[group].codes) {
      const scope = SCOPED.includes(code) ? building : null;
      if (!sourceOwnsCardRole(data.personnelSource, code, scope) && data.cardRules.some(rule => rule.code === code && rule.building === scope)) continue;
      const key = `${code}:${scope || 'all'}`;
      const cached = cachedDefaults.current[key];
      if (cached) { setDefaults(current => ({ ...current, [key]: cached })); continue; }
      void loadCardMembers(code, scope).then(result => { if (active) { cachedDefaults.current[key] = result; setDefaults(current => ({ ...current, [key]: result })); } })
        .catch(failure => { if (active) setDefaults(current => ({ ...current, [key]: { error: (failure as Error).message } })); });
    }
    return () => { active = false; };
  }, [group, building, data.appId, data.revision, data.personnelSource, data.cardRules, previewRetry]);
  const choices = useMemo(() => Array.from(new Map([...people, ...data.accounts.filter(account => account.kind === 'feishu' && !!account.openId && account.appId === data.appId && !account.deleted).map(account => ({ openId: account.openId!, name: account.name }))].map(person => [person.openId, person])).values()), [people, data]);
  const managed = (code: CardRoleCode) => sourceOwnsCardRole(data.personnelSource, code, SCOPED.includes(code) ? building : null);
  const current = (code: CardRoleCode) => managed(code) ? undefined : data.cardRules.find(rule => rule.code === code && rule.building === (SCOPED.includes(code) ? building : null));
  useEffect(() => { if (editing && sourceOwnsCardRole(data.personnelSource, editing, SCOPED.includes(editing) ? building : null)) setEditing(undefined); }, [editing, data.personnelSource, building]);
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2" role="group" aria-label="卡片业务分类">{Object.entries(GROUPS).map(([key,value]) => <Button key={key} variant={group === key ? 'default' : 'outline'} aria-pressed={group === key} onClick={() => setGroup(key as keyof typeof GROUPS)}>{value.name}</Button>)}</div>{group !== 'contract' && <select aria-label="卡片楼栋" className="config-select" value={building} onChange={event => setBuilding(event.target.value as BuildingAdminBuilding)}>{PURCHASE_ACCESS_BUILDINGS.map(value => <option key={value}>{value}</option>)}</select>}</div>
    <div className="divide-y rounded-lg border bg-card">{GROUPS[group].codes.map(code => {
      const rule = current(code), notify = OPTIONAL.includes(code), preview = defaults[`${code}:${SCOPED.includes(code) ? building : 'all'}`];
      const members = rule?.members || preview?.members;
      return <div className="flex flex-wrap items-center gap-4 p-4 sm:p-5" key={code}><div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">{notify ? <Bell className="size-5" /> : <CheckCheck className="size-5" />}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{CARD_LABELS[code]}</h2><Badge variant="outline">{SCOPED.includes(code) ? building : '全基地'}</Badge><Badge variant="secondary">{notify ? '仅知会' : '业务处理'}</Badge></div><p className="mt-2 break-words text-sm text-muted-foreground">{members ? members.map(person => managed(code) ? person.name : choices.find(item => item.openId === person.openId)?.name || person.name).join('、') || '无人接收' : preview?.description || (preview?.error ? managed(code) ? preview.error : '默认人员读取失败' : '正在读取人员…')}</p>{!rule && preview?.error && <Button variant="link" size="sm" className="h-auto p-0 text-destructive" onClick={() => setPreviewRetry(value => value + 1)}>重试读取</Button>}<p className="mt-1 text-xs text-muted-foreground">{SINGLE.includes(code) ? '1人' : OPTIONAL.includes(code) ? '可多人或留空' : '至少1人'} · {managed(code) ? '统一岗位来源' : rule ? '系统配置' : '默认来源'}</p></div><Button variant="outline" size="sm" disabled={managed(code) && !onSource} onClick={() => managed(code) ? onSource?.() : setEditing(code)}><Pencil className="size-4" />{managed(code) ? '查看岗位来源' : '配置'}</Button></div>;
    })}</div>
    {group === 'contract' && <Button variant="outline" onClick={onAccounts}>维护合同系统权限<ArrowRight className="size-4" /></Button>}
    {editing && !managed(editing) && <CardEditor key={`${editing}:${building}`} code={editing} building={SCOPED.includes(editing) ? building : null} initialMembers={defaults[`${editing}:${SCOPED.includes(editing) ? building : 'all'}`]?.members || []} data={data} people={choices} onClose={() => setEditing(undefined)} onSaved={result => { onSaved(result); setEditing(undefined); }} />}
  </section>;
});
function CardEditor({ code, building, data, people, initialMembers, onClose, onSaved }: { code: CardRoleCode; building: BuildingAdminBuilding | null; data: AccessConfigurationResponse; people: ConfigurationPerson[]; initialMembers: ConfigurationPerson[]; onClose: () => void; onSaved: (data: AccessConfigurationResponse) => void }) {
  const previous = data.cardRules.find(rule => rule.code === code && rule.building === building);
  const [members, setMembers] = useState<ConfigurationPerson[]>(previous?.members || initialMembers), [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const pending = useRef(false), request = useRef<{ signature: string; id: string } | undefined>(undefined);
  async function save(restoreDefault = false) {
    if (pending.current) return;
    if (!restoreDefault && !OPTIONAL.includes(code) && !members.length) { setError('请选择至少一名业务处理人员'); return; }
    pending.current = true; setSubmitting(true); setError('');
    const body = { expectedRevision: data.revision, code, building, members: restoreDefault && previous ? previous.members : members, restoreDefault };
    const signature = JSON.stringify(body);
    if (!request.current || request.current.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    try { onSaved(await saveCardRole({ ...body, clientMutationId: request.current.id })); }
    catch (failure) { setError((failure as Error).message); }
    finally { pending.current = false; setSubmitting(false); }
  }
  return <Sheet open onOpenChange={open => { if (!open && !pending.current) onClose(); }}><SheetContent className="configuration-editor w-full gap-0 p-0 sm:max-w-lg" aria-describedby="card-editor-description"><Button variant="ghost" size="icon" aria-label="关闭" className="absolute right-3 top-3" disabled={submitting} onClick={onClose}><X className="size-4" /></Button><SheetHeader className="border-b p-6"><SheetTitle>{CARD_LABELS[code]}{building ? ` · ${building}` : ''}</SheetTitle><SheetDescription id="card-editor-description" className="sr-only">设置此流程的新单据处理人或知会人，已有单据保留人员快照。</SheetDescription></SheetHeader>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6"><PersonSelector selected={members} people={people} onChange={setMembers} single={SINGLE.includes(code)} disabled={submitting} /><p className="text-xs leading-5 text-muted-foreground">新建卡片和待分配环节采用新配置，已送达卡片保留原处理人。</p>{error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}<Button variant="link" className="h-auto px-2 text-destructive" onClick={() => window.dispatchEvent(new Event('configuration-refresh-request'))}>刷新配置</Button></p>}</div><div className="flex flex-wrap items-center justify-between gap-3 border-t bg-card p-4"><div>{previous && <Button variant="ghost" onClick={() => void save(true)} disabled={submitting}><RotateCcw className="size-4" />恢复默认</Button>}</div><div className="flex gap-2"><Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button><Button onClick={() => void save()} disabled={submitting}>{submitting && <Loader2 className="size-4 animate-spin" />}{submitting ? '处理中…' : '保存'}</Button></div></div>
  </SheetContent></Sheet>;
}
