import { useEffect, useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { AlarmReviewPerson } from '@shared/today-operations-alarm-review.interface';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandItem, CommandList, CommandInput } from '@/components/ui/command';
import { alarmReviewBuildingLabel, filterAlarmReviewPeople } from './alarm-review-person-search';

interface Props {
  people: AlarmReviewPerson[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  loading: boolean;
  fallbackName?: string;
  onExpandedChange: (expanded: boolean) => void;
}
export function AlarmReviewPersonPicker({ people, value, onChange, disabled, loading, fallbackName, onExpandedChange }: Props) {
  const selected = people.find(person => person.recordId === value);
  const selectedName = value ? selected?.name || fallbackName || '' : '';
  const [query, setQuery] = useState(selectedName);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { onExpandedChange(expanded && !disabled); }, [expanded, disabled, onExpandedChange]);
  useEffect(() => { if (value) { setQuery(selectedName); setExpanded(false); } }, [value, selectedName]);
  const matches = useMemo(() => filterAlarmReviewPeople(people, query), [people, query]);
  return <div className="alarm-review-person-picker" onKeyDown={event => {
    if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); }
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}>
    <Command shouldFilter={false} className="alarm-review-person-command">
      <CommandInput id="alarm-review-person" aria-label="搜索示例人员019" aria-expanded={expanded && !disabled} placeholder={loading ? '正在读取示例人员019…' : '输入姓名、楼栋或岗位搜索'}
        disabled={disabled} value={query} onFocus={() => { if (!disabled) setExpanded(true); }} onValueChange={text => {
          setQuery(text); setExpanded(true); if (value) onChange('');
        }} />
      {expanded && !disabled ? <CommandList aria-label="匹配人员" className="alarm-review-person-options">
        <CommandEmpty>未找到匹配人员</CommandEmpty>
        {matches.map(person => <CommandItem key={person.recordId} value={person.recordId} className="alarm-review-person-option"
          onMouseDown={event => event.preventDefault()} onSelect={() => { onChange(person.recordId); setQuery(person.name); setExpanded(false); }}>
          <span><strong>{person.name}</strong><small>{[person.buildings.map(alarmReviewBuildingLabel).join(' / '), person.position].filter(Boolean).join(' · ') || '资料未维护'}</small></span>
          {person.recordId === value ? <Check aria-hidden="true" /> : null}
        </CommandItem>)}
      </CommandList> : null}
    </Command>
    {value ? <div className="alarm-review-person-selected" role="status">
      <Check aria-hidden="true" /><span>{selectedName || '已选示例人员019'}{selected ? <small>{[selected.buildings.map(alarmReviewBuildingLabel).join(' / '), selected.position].filter(Boolean).join(' · ')}</small> : null}</span>
      {!disabled ? <Button size="icon" variant="ghost" aria-label="清除示例人员019" onClick={() => { onChange(''); setQuery(''); setExpanded(true); }}><X aria-hidden="true" /></Button> : null}
    </div> : <p className="alarm-review-person-hint">{loading ? '正在加载人员' : '从匹配名单中选择示例人员019'}</p>}
  </div>;
}
