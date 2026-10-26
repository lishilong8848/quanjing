import { memo, useDeferredValue, useMemo, useState } from 'react';
import { Check, CircleHelp, LockKeyhole, Search, ShieldCheck, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AccessConfigurationResponse } from '@shared/access-configuration.interface';
import { BUILDING_ADMIN_BUILDINGS } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { BUSINESS_ACTION_LABELS, businessModuleDefinition } from '@shared/business-permissions';
import { PAGE_ACCESS_CATALOG } from '@shared/page-access';
import { buildPermissionMatrix, matrixAccountSubject, matrixRoleSubject, type MatrixCell, type MatrixOptions, type MatrixState, type MatrixSubject } from '@shared/permission-matrix';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ROLE_LABELS, accountStatus } from './model';
import './permission-matrix.css';

const GROUPS = { platform: '平台门户', operations: '运营指挥', people: '人员保障', safety: '运维质量', equipment: '设备运维', supply: '采·供·存', knowledge: '知识交付' };
const STATES: Record<MatrixState, string> = { all: '可用', partial: '部分范围', none: '无', conditional: '按条件', unknown: '待核对', disabled: '停用' };
type Column = { key: string; label: string; paths: readonly string[] };
type Row = { subject: MatrixSubject; cells: MatrixCell[] };
function aggregate(states: MatrixState[]): MatrixState {
  if (states.every(value => value === states[0])) return states[0] || 'none';
  if (states.some(value => value === 'unknown')) return 'unknown';
  if (states.some(value => value === 'conditional')) return 'conditional';
  return states.some(value => value === 'all' || value === 'partial') ? 'partial' : 'none';
}
function StateMark({ state }: { state: MatrixState }) {
  const Icon = state === 'all' ? Check : state === 'none' || state === 'disabled' ? LockKeyhole : CircleHelp;
  return <span className={`matrix-state matrix-state-${state}`}><Icon className="size-3" aria-hidden="true" />{STATES[state]}</span>;
}
const MatrixSummary = memo(function MatrixSummary({ cells }: { cells: MatrixCell[] }) {
  return <span className="matrix-summary">{(['read','operations','approval','notification'] as const).map((key, index) => <span key={key} className="matrix-summary-line"><span>{['读取','操作','审批','通知'][index]}</span><StateMark state={aggregate(cells.map(item => item[key]))} /></span>)}</span>;
});
export function PermissionMatrixPanel({ data }: { data: AccessConfigurationResponse }) {
  const [view, setView] = useState<'people'|'roles'>('people'), [query, setQuery] = useState(''), [group, setGroup] = useState('all');
  const [role, setRole] = useState('all'), [status, setStatus] = useState('enabled'), [building, setBuilding] = useState('all'), [specialty, setSpecialty] = useState('all');
  const [page, setPage] = useState(0), [mobilePerson, setMobilePerson] = useState('');
  const [detail, setDetail] = useState<{ id: string; column: Column }>();
  const search = useDeferredValue(query.trim());
  const options = useMemo<MatrixOptions>(() => ({ pageRules: data.rolePageRules, cardRules: data.cardRules, appId: data.appId,
    ...(building !== 'all' ? { building: building as MatrixOptions['building'] } : {}), ...(specialty !== 'all' ? { specialty: specialty as MatrixOptions['specialty'] } : {}) }), [data.rolePageRules,data.cardRules,data.appId,building,specialty]);
  const subjects = useMemo(() => {
    const entries = view === 'people' ? data.accounts.map(matrixAccountSubject) : Object.entries(ROLE_LABELS).map(([value,name]) => matrixRoleSubject(value as keyof typeof ROLE_LABELS,name));
    return entries.filter(subject => (!search || `${subject.name} ${ROLE_LABELS[subject.principal.role]}`.includes(search)) && (role === 'all' || subject.principal.role === role) && (view === 'roles' || status === 'all' || subject.enabled === (status === 'enabled')))
      .sort((a,b) => a.name.localeCompare(b.name,'zh-CN') || a.id.localeCompare(b.id));
  }, [data.accounts,view,search,role,status]);
  const columns = useMemo<Column[]>(() => group === 'all' ? Object.entries(GROUPS).map(([key,label]) => ({ key,label,paths: PAGE_ACCESS_CATALOG.filter(item => item.group === key).map(item => item.path) })) : PAGE_ACCESS_CATALOG.filter(item => item.group === group).map(item => ({ key: item.path,label:item.label,paths:[item.path] })), [group]);
  const currentPage = Math.min(page, Math.max(0,Math.ceil(subjects.length / 20)-1));
  const chosenMobile = subjects.find(subject => subject.id === mobilePerson) || subjects[0];
  const rows = useMemo<Row[]>(() => {
    const visible = subjects.slice(currentPage*20,currentPage*20+20);
    const chosen = subjects.find(subject => subject.id === detail?.id) || chosenMobile;
    return [...visible, ...(chosen && !visible.some(item => item.id === chosen.id) ? [chosen] : [])].map(subject => ({ subject,cells:buildPermissionMatrix(subject,options) }));
  }, [subjects,currentPage,chosenMobile,detail?.id,options]);
  const selectedRow = rows.find(row => row.subject.id === detail?.id), mobileRow = rows.find(row => row.subject.id === chosenMobile?.id);
  function filter(set: (value: string) => void, value: string) { set(value); setPage(0); }
  return <section className="permission-matrix space-y-4" aria-label="权限矩阵">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2" role="group" aria-label="矩阵视角"><Button variant={view === 'people' ? 'default' : 'outline'} aria-pressed={view === 'people'} onClick={() => { setView('people'); setPage(0); }}>人员</Button><Button variant={view === 'roles' ? 'default' : 'outline'} aria-pressed={view === 'roles'} onClick={() => { setView('roles'); setPage(0); }}>角色</Button></div><Badge variant="outline">配置版本 {data.revision}</Badge></div>
    <div className="flex flex-wrap gap-3"><div className="relative min-w-48 flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input aria-label="搜索矩阵人员或角色" placeholder="搜索姓名或角色" className="pl-9" value={query} onChange={event => filter(setQuery,event.target.value)} /></div>
      <select className="config-select" aria-label="矩阵业务分类" value={group} onChange={event => setGroup(event.target.value)}><option value="all">全景</option>{Object.entries(GROUPS).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
      <select className="config-select" aria-label="矩阵角色筛选" value={role} onChange={event => filter(setRole,event.target.value)}><option value="all">全部角色</option>{Object.entries(ROLE_LABELS).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
      {view === 'people' && <select className="config-select" aria-label="矩阵账号状态" value={status} onChange={event => filter(setStatus,event.target.value)}><option value="enabled">启用人员</option><option value="disabled">停用人员</option><option value="all">全部状态</option></select>}
      <select className="config-select" aria-label="矩阵楼栋范围" value={building} onChange={event => setBuilding(event.target.value)}><option value="all">全部楼栋</option>{BUILDING_ADMIN_BUILDINGS.map(value => <option key={value}>{value}</option>)}</select>
      <select className="config-select" aria-label="矩阵专业范围" value={specialty} onChange={event => setSpecialty(event.target.value)}><option value="all">全部专业</option>{PROFESSIONAL_SPECIALTIES.map(value => <option key={value}>{value}</option>)}</select>
    </div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground" aria-label="矩阵图例"><span className="inline-flex items-center gap-1"><ShieldCheck className="size-4" />读取与操作、审批、通知分别判断</span><span>部分范围：仅部分页面、楼栋或专业可用</span><span>按条件：需核对单据阶段或任职范围</span><span>待核对：尚未取得完整有效策略</span></div>
    <Card className="matrix-desktop overflow-hidden rounded-lg"><CardContent className="p-0"><Table className="matrix-table"><TableHeader><TableRow><TableHead className="matrix-person">{view === 'people' ? '人员 / 角色' : '角色'}</TableHead>{columns.map(column => <TableHead key={column.key}>{column.label}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.filter(row => subjects.slice(currentPage*20,currentPage*20+20).some(subject => subject.id === row.subject.id)).map(row => <TableRow key={row.subject.id}><TableCell className="matrix-person"><p className="truncate font-medium" title={row.subject.name}>{row.subject.name}</p><p className="mt-1 text-xs text-muted-foreground">{ROLE_LABELS[row.subject.principal.role]}</p>{row.subject.account && <p className="mt-1 text-xs text-muted-foreground">{row.subject.account.kind === 'feishu' ? '飞书' : row.subject.account.loginMethod ? '姓名登录' : '备用密码'} · {accountStatus(row.subject.account)}</p>}</TableCell>{columns.map(column => <TableCell key={column.key}><Button variant="ghost" className="matrix-cell h-auto w-full whitespace-normal px-2 py-3" aria-label={`${row.subject.name} · ${column.label}权限详情`} onClick={() => setDetail({ id:row.subject.id,column })}><MatrixSummary cells={row.cells.filter(cell => column.paths.includes(cell.path))} /></Button></TableCell>)}</TableRow>)}{!subjects.length && <TableRow><TableCell colSpan={columns.length+1} className="p-8 text-center text-muted-foreground">没有匹配人员或角色</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
    <div className="matrix-mobile space-y-3">{subjects.length ? <><label className="block text-sm font-medium" htmlFor="matrix-mobile-person">{view === 'people' ? '查看人员' : '查看角色'}</label><select id="matrix-mobile-person" className="config-select w-full" value={chosenMobile?.id || ''} onChange={event => setMobilePerson(event.target.value)}>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name} · {ROLE_LABELS[subject.principal.role]}</option>)}</select>{mobileRow && columns.map(column => <Card key={column.key} className="rounded-lg"><CardContent className="p-0"><Button variant="ghost" className="h-auto w-full justify-between whitespace-normal p-4" onClick={() => setDetail({ id:mobileRow.subject.id,column })} aria-label={`${mobileRow.subject.name} · ${column.label}权限详情`}><span className="text-left font-medium">{column.label}</span><span className="w-40"><MatrixSummary cells={mobileRow.cells.filter(cell => column.paths.includes(cell.path))} /></span></Button></CardContent></Card>)}</> : <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">没有匹配人员或角色</p>}</div>
    <div className="matrix-desktop flex items-center justify-between text-sm text-muted-foreground"><span>共 {subjects.length} 项</span><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="矩阵上一页" disabled={currentPage===0} onClick={() => setPage(currentPage-1)}><ChevronLeft /></Button><span>{currentPage+1} / {Math.max(1,Math.ceil(subjects.length/20))}</span><Button variant="outline" size="icon" aria-label="矩阵下一页" disabled={(currentPage+1)*20>=subjects.length} onClick={() => setPage(currentPage+1)}><ChevronRight /></Button></div></div>
    {detail && selectedRow && <MatrixDetail row={selectedRow} column={detail.column} onClose={() => setDetail(undefined)} />}
  </section>;
}
function MatrixDetail({ row,column,onClose }: { row: Row; column: Column; onClose: () => void }) {
  const cells = row.cells.filter(cell => column.paths.includes(cell.path));
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}><SheetContent className="configuration-editor matrix-detail w-full gap-0 p-0 sm:max-w-xl"><Button variant="ghost" size="icon" aria-label="关闭" className="absolute right-3 top-3" onClick={onClose}><X /></Button><SheetHeader className="border-b p-6 pr-14"><SheetTitle>{row.subject.name} · {column.label}</SheetTitle><SheetDescription className="sr-only">当前页面、业务动作与卡片职责分别显示；仅查看，不修改授权。</SheetDescription><p className="text-sm text-muted-foreground">{ROLE_LABELS[row.subject.principal.role]}{row.subject.principal.authorizationVersion ? ` · 授权版本 ${row.subject.principal.authorizationVersion}` : ''}</p></SheetHeader><div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">{cells.map(cell => <section key={cell.path} className="space-y-3 rounded-lg border p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-medium">{cell.label}</h3><span className="inline-flex items-center gap-2 text-xs">读取<StateMark state={cell.read} /></span></div>{cell.actions.length > 0 && <div className="divide-y">{cell.actions.map(action => <div key={`${action.module}:${action.action}`} className="space-y-1 py-2 text-sm"><div className="flex items-center justify-between gap-2"><span>{cell.path === '/inventory-management' ? `${businessModuleDefinition(action.module).label} · ` : ''}{BUSINESS_ACTION_LABELS[action.action]}</span><StateMark state={action.state} /></div>{action.sources.length > 0 && <p className="text-xs text-muted-foreground">{action.sources.join('、')}</p>}{action.state === 'partial' && <div className="flex flex-wrap gap-1">{action.allowed.map(target => <Badge variant="outline" key={`${target.building}:${target.specialty}`}>{target.building} · {target.specialty}</Badge>)}</div>}{action.note && <p className="text-xs text-muted-foreground">{action.note}</p>}</div>)}</div>}<div className="grid grid-cols-2 gap-3 border-t pt-3 text-xs"><span className="inline-flex justify-between gap-2">卡片审批<StateMark state={cell.approval} /></span><span className="inline-flex justify-between gap-2">接收通知<StateMark state={cell.notification} /></span></div>{cell.cardDuties.map(duty => <p key={`${duty.name}:${duty.building}`} className="text-xs text-muted-foreground">{duty.name} · {duty.building || '全基地'} · 任职版本 {duty.version}</p>)}{cell.notes.map(note => <p key={note} className="text-xs leading-5 text-muted-foreground">{note}</p>)}</section>)}</div></SheetContent></Sheet>;
}
