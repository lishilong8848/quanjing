import { useDeferredValue, useMemo, useState } from 'react';
import { X, Search } from 'lucide-react';
import type { ConfigurationPerson } from '@shared/access-configuration.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

export function PersonSelector({ people, selected, onChange, single, disabled }: { people: ConfigurationPerson[]; selected: ConfigurationPerson[]; onChange: (people: ConfigurationPerson[]) => void; single?: boolean; disabled?: boolean }) {
  const [query, setQuery] = useState(''), [manualId, setManualId] = useState(''), [manualName, setManualName] = useState('');
  const deferred = useDeferredValue(query);
  const visible = useMemo(() => people.filter(person => !deferred || `${person.name} ${person.openId}`.includes(deferred)).slice(0, 50), [people, deferred]);
  const add = (person: ConfigurationPerson) => { if (!selected.some(item => item.openId === person.openId)) onChange(single ? [person] : [...selected, person]); };
  return <div className="space-y-3">
    <div className="flex min-h-10 flex-wrap gap-2">{selected.length ? selected.map(person => <span className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted px-2 py-1 text-sm" key={person.openId}><span className="truncate" title={person.name}>{person.name}</span><Button type="button" variant="ghost" size="icon" className="size-6" disabled={disabled} aria-label={`移除${person.name}`} onClick={() => onChange(selected.filter(item => item.openId !== person.openId))}><X className="size-3" /></Button></span>) : <p className="py-2 text-sm text-muted-foreground">尚未选择人员</p>}</div>
    <div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" aria-label="搜索飞书人员" placeholder="搜索姓名" value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} /></div>
    <div className="max-h-64 overflow-y-auto rounded-lg border">{visible.map(person => <label className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-0 hover:bg-muted/40" key={person.openId}><Checkbox disabled={disabled} checked={selected.some(item => item.openId === person.openId)} onCheckedChange={checked => checked ? add(person) : onChange(selected.filter(item => item.openId !== person.openId))} /><span className="min-w-0 flex-1 truncate" title={person.name}>{person.name}</span></label>)}{!visible.length && <p className="p-4 text-sm text-muted-foreground">没有匹配人员</p>}</div>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">按 Open ID 添加</summary><div className="mt-3 space-y-2"><Input aria-label="添加人员姓名" value={manualName} onChange={event => setManualName(event.target.value)} disabled={disabled} placeholder="姓名" maxLength={128} /><Input aria-label="添加人员 Open ID" value={manualId} onChange={event => setManualId(event.target.value)} disabled={disabled} placeholder="当前应用的 Open ID" /><Button type="button" variant="outline" disabled={disabled || !manualName.trim() || !/^ou_[A-Za-z0-9_-]+$/.test(manualId)} onClick={() => { add({ name: manualName.trim(), openId: manualId.trim() }); setManualId(''); setManualName(''); }}>加入名单</Button></div></details>
  </div>;
}
