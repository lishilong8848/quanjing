import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandItem, CommandList, CommandEmpty } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AuthorityPerson } from '@shared/personnel-authority.interface';

export function PersonnelRecordSelect({ label, people, value, onChange }: {label:string;people:AuthorityPerson[];value:string;onChange:(id:string)=>void}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState('');
  const selected=people.find(person=>person.id===value);
  const matching=useMemo(()=>people.filter(person=>`${person.name} ${person.position} ${person.systemPosition} ${person.buildings.join(' ')} ${person.specialties.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),[people,query]);
  return <div className="min-w-0 space-y-2"><p className="text-sm font-medium">{label}</p><Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline" role="combobox" aria-label={label} aria-expanded={open} className="w-full justify-between"><span className="truncate">{selected ? `${selected.name} · ${selected.position || selected.buildings.join('、') || '岗位未维护'}` : `选择${label}`}</span><ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" /></Button></PopoverTrigger><PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start"><Command shouldFilter={false}><CommandInput placeholder="搜索姓名、岗位或楼栋" value={query} onValueChange={setQuery} /><CommandList><CommandEmpty>没有匹配人员</CommandEmpty>{matching.slice(0,50).map(person=><CommandItem key={person.id} value={person.id} onSelect={()=>{onChange(person.id);setOpen(false);setQuery('');}}><Check className={`size-4 shrink-0 ${value===person.id?'opacity-100':'opacity-0'}`} /><span className="min-w-0"><span className="block truncate">{person.name}</span><span className="block truncate text-xs text-muted-foreground">{person.position || '岗位未维护'} · {person.buildings.join('、') || '范围未维护'}{!person.active?' · 权限已收回':''}</span></span></CommandItem>)}{matching.length>50 && <p className="px-3 py-2 text-xs text-muted-foreground">还有 {matching.length-50} 人，请输入姓名缩小范围</p>}</CommandList></Command></PopoverContent></Popover></div>;
}
