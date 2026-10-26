import { memo, useDeferredValue, useMemo, useState } from 'react';
import { Plus, Search, KeyRound, Pencil, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ManagedAccount } from '@shared/access-configuration.interface';
import { BUILDING_ADMIN_BUILDINGS } from '@shared/access-control.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FeishuIcon } from '@/components/FeishuIcon';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ROLE_LABELS, accountStatus } from './model';

export const AccountPanel = memo(function AccountPanel({ accounts, onEdit, external = false, personnelPassword = false }: { accounts: ManagedAccount[]; onEdit: (account?: ManagedAccount) => void; external?: boolean; personnelPassword?: boolean }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [role, setRole] = useState('all'), [building, setBuilding] = useState('all'), [status, setStatus] = useState('all'), [page, setPage] = useState(0);
  const deferred = useDeferredValue(query);
  const filtered = useMemo(() => accounts.filter(account => (!deferred || `${account.name} ${account.openId || ''}`.toLowerCase().includes(deferred.toLowerCase())) &&
    (kind === 'all' || account.kind === kind) && (role === 'all' || account.role === role) && (building === 'all' || (account.buildings || (account.building ? [account.building] : [])).some(value => value === building)) &&
    (status === 'all' || accountStatus(account) === status)).sort((a,b) => Number(b.enabled && !b.deleted) - Number(a.enabled && !a.deleted) || a.name.localeCompare(b.name, 'zh-CN')), [accounts, deferred, kind, role, building, status]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  const visible = filtered.slice(currentPage * 20, currentPage * 20 + 20);
  const change = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLSelectElement>) => { setter(event.target.value); setPage(0); };
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-48 flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input aria-label="搜索账号" placeholder="搜索姓名、密码登录名称或 Open ID" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} className="pl-9" /></div>
      <select className="config-select" aria-label="账号类型" value={kind} onChange={change(setKind)}><option value="all">全部账号</option><option value="feishu">飞书账号</option><option value="local">本地密码登录</option></select>
      <select className="config-select" aria-label="权限角色筛选" value={role} onChange={change(setRole)}><option value="all">全部角色</option>{Object.entries(ROLE_LABELS).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
      <select className="config-select" aria-label="楼栋筛选" value={building} onChange={change(setBuilding)}><option value="all">全部楼栋</option>{BUILDING_ADMIN_BUILDINGS.map(value => <option key={value}>{value}</option>)}</select>
      <select className="config-select" aria-label="账号状态" value={status} onChange={change(setStatus)}><option value="all">全部状态</option>{['启用','仅游客登录','权限已收回','停用','人员表停用','已删除'].map(value => <option key={value}>{value}</option>)}</select>
      {!personnelPassword && <Button onClick={() => onEdit()}><Plus className="size-4" />{external ? '新增外部飞书授权' : '新增飞书授权'}</Button>}
    </div>
    <p className="text-xs text-muted-foreground">{personnelPassword ? '使用姓名和密码登录；在此配置权限。' : external ? '员工及组织架构目录之外的飞书人员，由管理员填写姓名和当前应用 Open ID。' : '备用密码用于通用登录身份；个人可使用飞书或姓名登录。'}</p>
    <div className="rounded-lg border bg-card">
      <Table className="hidden md:table"><TableHeader><TableRow><TableHead>姓名 / 登录入口</TableHead><TableHead>账号类型</TableHead><TableHead>权限角色</TableHead><TableHead>生效范围</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>
        {visible.map(account => <TableRow key={account.id}><TableCell><div className="max-w-72 truncate font-medium" title={account.name}>{account.name}</div><div className="mt-1 text-xs text-muted-foreground">{account.permissionSource === 'personnel' ? '人员表同步' : account.permissionSource === 'manual' ? '手工维护' : account.source === 'default' ? '现有授权' : '系统配置'}</div></TableCell><TableCell><span className="inline-flex items-center gap-2">{account.kind === 'feishu' ? <FeishuIcon /> : <KeyRound className="size-4 text-muted-foreground" />}{account.kind === 'feishu' ? '飞书' : '本地'}</span></TableCell><TableCell>{ROLE_LABELS[account.role]}{!!account.personalRules?.length && <p className="mt-1 text-xs text-primary">个人规则 {account.personalRules.length} 条</p>}</TableCell><TableCell>{[account.buildings?.join('、') || account.building, account.specialties?.join('、')].filter(Boolean).join(' · ') || '全基地'}</TableCell><TableCell><Badge variant={account.enabled && !account.deleted ? 'secondary' : 'outline'}>{accountStatus(account)}</Badge></TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" aria-label={`编辑${account.name}`} onClick={() => onEdit(account)}><Pencil className="size-4" />编辑</Button></TableCell></TableRow>)}
      </TableBody></Table>
      <div className="divide-y md:hidden">{visible.map(account => <div key={account.id} className="flex gap-3 p-4"><div className="min-w-0 flex-1"><p className="truncate font-medium" title={account.name}>{account.name}</p><p className="mt-1 text-sm text-muted-foreground">{ROLE_LABELS[account.role]} · {[account.buildings?.join('、') || account.building, account.specialties?.join('、')].filter(Boolean).join(' · ') || '全基地'}</p><div className="mt-2 flex items-center gap-2 text-xs"><Badge variant="outline">{account.kind === 'feishu' ? '飞书' : '本地'}</Badge><Badge variant="secondary">{accountStatus(account)}</Badge></div></div><Button variant="outline" size="sm" aria-label={`编辑${account.name}`} onClick={() => onEdit(account)}>编辑</Button></div>)}</div>
      {!visible.length && <p className="p-8 text-center text-sm text-muted-foreground">没有符合条件的账号</p>}
    </div>
    <div className="flex items-center justify-between text-sm text-muted-foreground"><span>共 {filtered.length} 项</span><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="上一页" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="size-4" /></Button><span>{currentPage + 1} / {Math.max(1, Math.ceil(filtered.length / 20))}</span><Button variant="outline" size="icon" aria-label="下一页" disabled={(currentPage + 1) * 20 >= filtered.length} onClick={() => setPage(currentPage + 1)}><ChevronRight className="size-4" /></Button></div></div>
  </section>;
});
