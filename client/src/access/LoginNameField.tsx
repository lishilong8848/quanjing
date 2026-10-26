import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { loginNameDirectory, matchLoginNames } from './login-name-directory';

export function LoginNameField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const [names, setNames] = React.useState<string[]>([]);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [focused, setFocused] = React.useState(false);
  const [selected, setSelected] = React.useState(-1);
  const [attempt, setAttempt] = React.useState(0);
  const id = React.useId();
  const choices = matchLoginNames(names, value);
  const expanded = focused && !disabled && choices.length > 0;
  React.useEffect(() => {
    let current = true;
    setState('loading');
    void loginNameDirectory.load().then(result => {
      if (current) { setNames(result.names); setState('ready'); }
    }).catch(() => { if (current) setState('error'); });
    return () => { current = false; };
  }, [attempt]);
  React.useEffect(() => { setSelected(-1); }, [value]);
  const choose = (name: string) => { onChange(name); setFocused(false); setSelected(-1); };
  return <div className="space-y-2">
    <label htmlFor={id} className="text-sm font-medium">姓名</label>
    <div className="relative">
      <Input id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-list`} aria-activedescendant={expanded && selected >= 0 ? `${id}-option-${selected}` : undefined} value={value} placeholder="输入姓名搜索或直接填写" onChange={event => { onChange(event.target.value); setFocused(true); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFocused(false); }
        else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && choices.length) { event.preventDefault(); setFocused(true); setSelected(index => event.key === 'ArrowDown' ? (index + 1) % choices.length : index < 0 ? choices.length - 1 : (index + choices.length - 1) % choices.length); }
        else if (event.key === 'Enter' && expanded && choices[selected]) { event.preventDefault(); choose(choices[selected]); }
      }} autoComplete="username" maxLength={128} disabled={disabled} required />
      {expanded && <ul id={`${id}-list`} role="listbox" aria-label="匹配姓名" className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
        {choices.map((name, index) => <li key={name} id={`${id}-option-${index}`} role="option" aria-selected={index === selected} className={`cursor-pointer rounded-md px-3 py-2 text-sm hover:bg-accent ${index === selected ? 'bg-accent' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => choose(name)}>{name}</li>)}
      </ul>}
    </div>
    {state === 'loading' ? <p role="status" className="text-xs text-muted-foreground">姓名列表加载中，可直接输入</p> : state === 'error' ? <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">姓名列表暂不可用，可直接输入<Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>重试</Button></div> : focused && value.trim() && !choices.length ? <p role="status" className="text-xs text-muted-foreground">未找到匹配姓名，可直接输入</p> : null}
  </div>;
}
