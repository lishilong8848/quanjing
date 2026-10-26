import { useDeferredValue, useMemo, useState } from 'react';
import type { ConfigurationPerson } from '@shared/access-configuration.interface';
import { Input } from '@/components/ui/input';

export function PersonPicker({ people, name, locked, disabled, onSelect, onClear }: {
  people: ConfigurationPerson[]; name: string; locked: boolean; disabled: boolean;
  onSelect: (person: ConfigurationPerson) => void; onClear: () => void;
}) {
  const [query, setQuery] = useState(name), [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const deferred = useDeferredValue(query.trim().toLocaleLowerCase());
  const matches = useMemo(() => people.filter(person => `${person.name} ${person.openId}`.toLocaleLowerCase().includes(deferred)), [people, deferred]);
  const visible = matches.slice(0, 50);
  const select = (person: ConfigurationPerson) => { onSelect(person); setQuery(person.name); setOpen(false); };
  return <div className="space-y-2">
    <Input id="config-person" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open && !locked} aria-controls="config-people" aria-activedescendant={open && visible[active] ? `config-person-${active}` : undefined}
      value={locked ? name : query} disabled={disabled || locked} placeholder="输入姓名搜索并选择人员" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onChange={event => { setQuery(event.target.value); onClear(); setActive(0); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(value => Math.max(0, Math.min(visible.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))); }
        if (event.key === 'Enter' && open) { event.preventDefault(); if (visible[active]) select(visible[active]); }
      }} />
    {open && !locked && <div id="config-people" role="listbox" aria-label="匹配人员" className="max-h-52 overflow-y-auto rounded-lg border bg-card">
      {visible.map((person, index) => <button id={`config-person-${index}`} type="button" role="option" aria-selected={active === index} key={person.openId}
        className={`block w-full px-3 py-2 text-left text-sm hover:bg-muted ${active === index ? 'bg-muted' : ''}`}
        onMouseDown={event => event.preventDefault()} onClick={() => select(person)}><span className="font-medium">{person.name}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{person.openId}</span></button>)}
      {!visible.length && <p className="p-3 text-sm text-muted-foreground">{people.length ? '没有匹配人员' : '人员资料尚未加载，请关闭后重试人员加载'}</p>}
      {matches.length > 50 && <p className="p-3 text-xs text-muted-foreground">显示前50人，请补充姓名缩小范围</p>}
    </div>}
  </div>;
}
