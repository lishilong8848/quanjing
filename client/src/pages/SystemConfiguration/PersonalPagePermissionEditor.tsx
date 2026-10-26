import { useMemo, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import type { AccessRole } from '@shared/access-control.interface';
import { PAGE_ACCESS_CATALOG, effectivePagePaths, type RolePageRules } from '@shared/page-access';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

const GROUPS = { platform:'平台门户',operations:'运营指挥',people:'人员保障',safety:'运维质量',equipment:'设备运维',supply:'采·供·存',knowledge:'知识交付' };
export function PersonalPagePermissionEditor({ role, roleRules, pages, onChange, disabled }: {
  role: AccessRole; roleRules?: RolePageRules; pages: string[]; onChange: (pages: string[]) => void; disabled: boolean;
}) {
  const [open,setOpen]=useState(pages.length > 0),[search,setSearch]=useState('');
  const inherited=useMemo(()=>effectivePagePaths(role,roleRules),[role,roleRules]);
  const groups=useMemo(()=>Object.entries(GROUPS).map(([key,label])=>({key,label,pages:PAGE_ACCESS_CATALOG.filter(page=>page.group === key && (!search.trim() || page.label.includes(search.trim())))})).filter(group=>group.pages.length),[search]);
  const additions=pages.filter(path=>!inherited.includes(path));
  return <section className="space-y-3 border-t pt-5" aria-labelledby="personal-page-heading">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button type="button" variant="ghost" className="h-auto gap-2 px-0 text-foreground" aria-expanded={open} aria-controls="personal-page-options" onClick={()=>setOpen(value=>!value)}>
        <ChevronDown className={`size-4 transition-transform ${open ? '' : '-rotate-90'}`} /><span id="personal-page-heading">个人页面读取</span>
        {!!additions.length && <Badge variant="secondary">增补 {additions.length} 页</Badge>}
      </Button>
      {!!pages.length && role !== 'admin' && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={()=>onChange([])}><RotateCcw className="size-4" />清除增补</Button>}
    </div>
    {open && <div id="personal-page-options" className="space-y-3">
      <p className="text-sm text-muted-foreground">{role === 'admin' ? '管理员可读取全部页面。' : '只增加页面读取；业务操作仍按角色、楼栋和专业权限。'}</p>
      <Input value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索页面" aria-label="搜索个人读取页面" />
      <div className="grid gap-3 sm:grid-cols-2">{groups.map(group=><fieldset key={group.key} className="min-w-0 space-y-2 rounded-lg border bg-card p-3">
        <legend className="px-1 text-sm font-medium">{group.label}</legend>
        {group.pages.map(page=>{
          const fixed=inherited.includes(page.path);
          return <label key={page.path} className="flex min-w-0 items-center gap-2 rounded-md p-2 hover:bg-muted">
            <Checkbox aria-label={`读取${page.label}`} checked={fixed || pages.includes(page.path)} disabled={disabled || fixed || role === 'admin'} onCheckedChange={checked=>onChange(checked === true ? [...new Set([...pages,page.path])] : pages.filter(path=>path !== page.path))} />
            <span className="min-w-0 flex-1 text-sm">{page.label}</span>{fixed && <span className="shrink-0 text-xs text-muted-foreground">角色默认</span>}
          </label>;
        })}
      </fieldset>)}</div>
      {!groups.length && <p className="py-4 text-center text-sm text-muted-foreground">没有匹配页面</p>}
    </div>}
  </section>;
}
