import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleHelp, LockKeyhole, Search, ShieldCheck, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AccessConfigurationResponse, ManagedAccount } from '@shared/access-configuration.interface';
import type { AuthorizationTemplate } from '@shared/authorization-profile';
import { BUILDING_ADMIN_BUILDINGS } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { BUSINESS_ACTION_LABELS, businessModuleDefinition } from '@shared/business-permissions';
import { PAGE_ACCESS_CATALOG } from '@shared/page-access';
import { buildPermissionMatrix, matrixAccountSubject, matrixRoleSubject, type MatrixCell, type MatrixOptions, type MatrixState, type MatrixSubject } from '@shared/permission-matrix';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ROLE_LABELS, accountStatus, accountAuthorizationKey, accountAuthorizationLabel } from './model';
import './permission-matrix.css';

const GROUPS = { platform: '平台门户', operations: '运营指挥', people: '人员保障', safety: '运维质量', equipment: '设备运维', supply: '采·供·存', knowledge: '知识交付' };
const STATES: Record<MatrixState, string> = { all: '可用', partial: '部分范围', none: '无', conditional: '需满足业务条件', unknown: '来源未确认', disabled: '停用' };
type Column = { key: string; label: string; paths: readonly string[] };
type Row = { subject: MatrixSubject; cells: MatrixCell[] };
const EMPTY_TEMPLATES: readonly AuthorizationTemplate[] = [];
function aggregate(states: MatrixState[]): MatrixState {
  if (states.every(value => value === states[0])) return states[0] || 'none';
  if (states.some(value => value === 'unknown')) return 'unknown';
  if (states.some(value => value === 'conditional')) return 'conditional';
  return states.some(value => value === 'all' || value === 'partial') ? 'partial' : 'none';
}
export function matrixStateReason(state: MatrixState, reason?: string): string {
  if (!reason || !['unknown', 'conditional'].includes(state)) return STATES[state];
  if (/更新失败|读取失败|异常|失败/.test(reason)) return '岗位来源更新失败';
  if (/暂停/.test(reason)) return '岗位来源已暂停';
  if (/交接|待确认/.test(reason)) return '岗位交接待确认';
  if (/绑定|应用身份/.test(reason)) return '需绑定当前应用身份';
  if (/当前审批人/.test(reason)) return '需为当前审批人';
  if (/单据|阶段/.test(reason)) return '需满足单据状态';
  if (/任职|楼栋|专业/.test(reason)) return '需符合任职范围';
  if (/名单|人员|来源/.test(reason)) return '岗位名单未确认';
  return reason;
}
function StateMark({ state, reason, compact=false }: { state: MatrixState; reason?: string; compact?:boolean }) {
  const Icon = state === 'all' ? Check : state === 'none' || state === 'disabled' ? LockKeyhole : CircleHelp;
  const label=matrixStateReason(state,reason),short:Record<string,string>={'岗位来源更新失败':'来源读取失败','岗位来源已暂停':'来源暂停','岗位交接待确认':'交接未确认','需绑定当前应用身份':'未绑定身份','需满足单据状态':'需符合状态','岗位名单未确认':'名单未确认','需满足业务条件':'有业务条件'};
  return <span className={`matrix-state matrix-state-${state}`} style={{ whiteSpace: 'normal', textAlign: 'right' }} title={reason || label}><Icon className="size-3 shrink-0" aria-hidden="true" />{compact?short[label]||label:label}</span>;
}
const MatrixSummary = memo(function MatrixSummary({ cells }: { cells: MatrixCell[] }) {
  return <span className="matrix-summary">{(['read','operations','approval','notification'] as const).map((key, index) => {
    const state = aggregate(cells.map(item => item[key]));
    const reason = key === 'approval' ? cells.find(cell => cell.approval === state && cell.approvalNote)?.approvalNote : key === 'notification' ? cells.find(cell => cell.notification === state && cell.notificationNote)?.notificationNote : key === 'operations' ? cells.flatMap(cell => cell.actions).find(action => action.state === state && action.note)?.note : undefined;
    return <span key={key} className="matrix-summary-line"><span className="shrink-0 whitespace-nowrap">{['读取','操作','审批','通知'][index]}</span><StateMark state={state} reason={reason} compact /></span>;
  })}</span>;
});
export function PermissionMatrixPanel({ data, templates = EMPTY_TEMPLATES, onEditAccount }: { data: AccessConfigurationResponse; templates?: readonly AuthorizationTemplate[]; onEditAccount?: (account: ManagedAccount) => void }) {
  const [view, setView] = useState<'people'|'roles'>('people'), [query, setQuery] = useState(''), [group, setGroup] = useState('all');
  const [role, setRole] = useState('all'), [status, setStatus] = useState('enabled'), [building, setBuilding] = useState('all'), [specialty, setSpecialty] = useState('all');
  const [page, setPage] = useState(0), [mobilePerson, setMobilePerson] = useState('');
  const [detail, setDetail] = useState<{ id: string; column: Column }>();
  const trigger = useRef<HTMLButtonElement | null>(null), outside = useRef(false);
  const anchor = useRef<{ getBoundingClientRect: () => DOMRect; contextElement?: Element }>({ getBoundingClientRect: () => new DOMRect() });
  function openDetail(button: HTMLButtonElement, id: string, column: Column) {
    trigger.current = button; outside.current = false;
    anchor.current = { getBoundingClientRect: () => button.getBoundingClientRect(), contextElement: button };
    setDetail(current => current?.id === id && current.column.key === column.key ? undefined : { id, column });
  }
  const search = useDeferredValue(query.trim());
  const options = useMemo<MatrixOptions>(() => ({ pageRules: data.rolePageRules, cardRules: data.cardRules, effectiveCardDuties: data.effectiveCardDuties, appId: data.appId,
    ...(building !== 'all' ? { building: building as MatrixOptions['building'] } : {}), ...(specialty !== 'all' ? { specialty: specialty as MatrixOptions['specialty'] } : {}) }), [data.rolePageRules,data.cardRules,data.effectiveCardDuties,data.appId,building,specialty]);
  const subjects = useMemo(() => {
    const entries: MatrixSubject[] = view === 'people' ? data.accounts.map(matrixAccountSubject) : templates.length ? templates.map<MatrixSubject>(template => ({ id: `template:${template.id}`, name: template.name, roleOnly: true, enabled: true, principal: { role: template.policy.nativeRole || 'guest', purchaseBuilding: null, effectiveAuthorization: { mode: 'follow', templateId: template.id, templateVersion: template.version, baseline: template.policy, overrides: { rules: [], allowPages: [], denyPages: [] } } } })) : Object.entries(ROLE_LABELS).map(([value,name]) => ({ ...matrixRoleSubject(value as keyof typeof ROLE_LABELS,name), id: `native:${value}` }));
    return entries.filter(subject => (!search || `${subject.name} ${subject.account ? accountAuthorizationLabel(subject.account, templates) : ROLE_LABELS[subject.principal.role]}`.includes(search)) && (role === 'all' || (subject.account ? accountAuthorizationKey(subject.account) : subject.id) === role) && (view === 'roles' || status === 'all' || subject.enabled === (status === 'enabled')))
      .sort((a,b) => a.name.localeCompare(b.name,'zh-CN') || a.id.localeCompare(b.id));
  }, [data.accounts,templates,view,search,role,status]);
  const columns = useMemo<Column[]>(() => group === 'all' ? Object.entries(GROUPS).map(([key,label]) => ({ key,label,paths: PAGE_ACCESS_CATALOG.filter(item => item.group === key).map(item => item.path) })) : PAGE_ACCESS_CATALOG.filter(item => item.group === group).map(item => ({ key: item.path,label:item.label,paths:[item.path] })), [group]);
  const currentPage = Math.min(page, Math.max(0,Math.ceil(subjects.length / 20)-1));
  const chosenMobile = subjects.find(subject => subject.id === mobilePerson) || subjects[0];
  const rowSubjects = useMemo(() => {
    const visible = subjects.slice(currentPage*20,currentPage*20+20);
    const chosen = chosenMobile;
    return [...visible, ...(chosen && !visible.some(item => item.id === chosen.id) ? [chosen] : [])];
  }, [subjects,currentPage,chosenMobile]);
  const [retry, setRetry] = useState(0);
  const input = useMemo(() => ({ subjects: rowSubjects, options, revision: data.revision, retry, filterText: query, ready: search === query.trim() }), [rowSubjects, options, data.revision, retry, query, search]);
  const latestInput = useRef(input); latestInput.current = input;
  const [completed, setCompleted] = useState<{ input: typeof input; rows: Row[]; error?: string }>();
  const current = completed?.input === input ? completed : undefined;
  const computing = rowSubjects.length > 0 && !current;
  const rows = current?.rows || [];
  useEffect(() => {
    if (!input.ready) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const result: Row[] = [];
    setDetail(undefined);
    function step() {
      if (cancelled || latestInput.current !== input) return;
      try {
        const subject = input.subjects[result.length];
        if (subject) result.push({ subject, cells: buildPermissionMatrix(subject, input.options) });
        if (cancelled || latestInput.current !== input) return;
        if (result.length < input.subjects.length) timer = setTimeout(step, 0);
        else setCompleted({ input, rows: result });
      } catch {
        if (!cancelled && latestInput.current === input) setCompleted({ input, rows: [], error: '权限计算未完成，请重新计算。' });
      }
    }
    // Paint the pending state before the first row; yield between rows so filters stay responsive.
    const frame = requestAnimationFrame(() => { if (!cancelled && latestInput.current === input) timer = setTimeout(step, 0); });
    return () => { cancelled = true; cancelAnimationFrame(frame); if (timer !== undefined) clearTimeout(timer); };
  }, [input]);
  const selectedRow = rows.find(row => row.subject.id === detail?.id), mobileRow = rows.find(row => row.subject.id === chosenMobile?.id);
  function filter(set: (value: string) => void, value: string) { setDetail(undefined); set(value); setPage(0); }
  return <Popover open={!!detail && !!selectedRow} onOpenChange={open => { if (!open) setDetail(undefined); }}><PopoverAnchor virtualRef={anchor} /><section className="permission-matrix space-y-4" aria-label="权限矩阵" aria-busy={computing}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2" role="group" aria-label="矩阵视角"><Button variant={view === 'people' ? 'default' : 'outline'} aria-pressed={view === 'people'} onClick={() => { setDetail(undefined); setView('people'); setPage(0); }}>人员</Button><Button variant={view === 'roles' ? 'default' : 'outline'} aria-pressed={view === 'roles'} onClick={() => { setDetail(undefined); setView('roles'); setPage(0); }}>角色</Button></div><Badge variant="outline">配置版本 {data.revision}</Badge></div>
    <div className="flex flex-wrap gap-3"><div className="relative min-w-48 flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input aria-label="搜索矩阵人员或角色" placeholder="搜索姓名或角色" className="pl-9" value={query} onChange={event => filter(setQuery,event.target.value)} /></div>
      <select className="config-select" aria-label="矩阵业务分类" value={group} onChange={event => { setDetail(undefined); setGroup(event.target.value); }}><option value="all">全景</option>{Object.entries(GROUPS).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
      <select className="config-select" aria-label="矩阵角色筛选" value={role} onChange={event => filter(setRole,event.target.value)}><option value="all">全部角色</option>{view === 'people' && <option value="independent">独立配置</option>}{templates.map(template => <option key={template.id} value={`template:${template.id}`}>{template.name}</option>)}<optgroup label="共享及旧角色">{Object.entries(ROLE_LABELS).map(([key,label]) => <option key={key} value={`native:${key}`}>{label}</option>)}</optgroup></select>
      {view === 'people' && <select className="config-select" aria-label="矩阵账号状态" value={status} onChange={event => filter(setStatus,event.target.value)}><option value="enabled">启用人员</option><option value="disabled">停用人员</option><option value="all">全部状态</option></select>}
      <select className="config-select" aria-label="矩阵楼栋范围" value={building} onChange={event => { setDetail(undefined); setBuilding(event.target.value); }}><option value="all">全部楼栋</option>{BUILDING_ADMIN_BUILDINGS.map(value => <option key={value}>{value}</option>)}</select>
      <select className="config-select" aria-label="矩阵专业范围" value={specialty} onChange={event => { setDetail(undefined); setSpecialty(event.target.value); }}><option value="all">全部专业</option>{PROFESSIONAL_SPECIALTIES.map(value => <option key={value}>{value}</option>)}</select>
    </div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground" aria-label="矩阵图例"><span className="inline-flex items-center gap-1"><ShieldCheck className="size-4" />读取与操作、审批、通知分别判断</span><span>部分范围：仅部分页面、楼栋或专业可用</span><span>业务条件与岗位来源分别说明；点击单元格查看原因</span></div>
    {computing && <p role="status" className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">正在计算权限，可继续筛选…</p>}
    {current?.error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{current.error}<Button variant="link" onClick={() => setRetry(value => value + 1)}>重新计算</Button></p>}
    <Card className="matrix-desktop overflow-hidden rounded-lg"><CardContent className="p-0"><Table className="matrix-table"><TableHeader><TableRow><TableHead className="matrix-person">{view === 'people' ? '人员 / 角色' : '角色'}</TableHead>{columns.map(column => <TableHead key={column.key}>{column.label}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.filter(row => subjects.slice(currentPage*20,currentPage*20+20).some(subject => subject.id === row.subject.id)).map(row => <TableRow key={row.subject.id}><TableCell className="matrix-person"><p className="truncate font-medium" title={row.subject.name}>{row.subject.name}</p><p className="mt-1 text-xs text-muted-foreground">{row.subject.account ? accountAuthorizationLabel(row.subject.account, templates) : row.subject.name}</p>{row.subject.account && <p className="mt-1 text-xs text-muted-foreground">{row.subject.account.kind === 'feishu' ? '飞书' : row.subject.account.loginMethod ? '姓名登录' : '备用密码'} · {accountStatus(row.subject.account)}</p>}</TableCell>{columns.map(column => <TableCell key={column.key}><Button variant="ghost" className="matrix-cell h-auto w-full whitespace-normal px-2 py-3" aria-label={`${row.subject.name} · ${column.label}权限详情`} data-matrix-cell="true" aria-haspopup="dialog" aria-expanded={detail?.id === row.subject.id && detail.column.key === column.key} onClick={event => openDetail(event.currentTarget,row.subject.id,column)}><MatrixSummary cells={row.cells.filter(cell => column.paths.includes(cell.path))} /></Button></TableCell>)}</TableRow>)}{!subjects.length && <TableRow><TableCell colSpan={columns.length+1} className="p-8 text-center text-muted-foreground">没有匹配人员或角色</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
    <div className="matrix-mobile space-y-3">{subjects.length ? <><label className="block text-sm font-medium" htmlFor="matrix-mobile-person">{view === 'people' ? '查看人员' : '查看角色'}</label><select id="matrix-mobile-person" className="config-select w-full" value={chosenMobile?.id || ''} onChange={event => { setDetail(undefined); setMobilePerson(event.target.value); }}>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name} · {subject.account ? accountAuthorizationLabel(subject.account, templates) : '角色模板'}</option>)}</select>{mobileRow && columns.map(column => <Card key={column.key} className="rounded-lg"><CardContent className="p-0"><Button variant="ghost" className="h-auto w-full justify-between whitespace-normal p-4" data-matrix-cell="true" aria-haspopup="dialog" aria-expanded={detail?.id === mobileRow.subject.id && detail.column.key === column.key} onClick={event => openDetail(event.currentTarget,mobileRow.subject.id,column)} aria-label={`${mobileRow.subject.name} · ${column.label}权限详情`}><span className="text-left font-medium">{column.label}</span><span className="w-40"><MatrixSummary cells={mobileRow.cells.filter(cell => column.paths.includes(cell.path))} /></span></Button></CardContent></Card>)}</> : <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">没有匹配人员或角色</p>}</div>
    <div className="matrix-desktop flex items-center justify-between text-sm text-muted-foreground"><span>共 {subjects.length} 项</span><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="矩阵上一页" disabled={currentPage===0} onClick={() => { setDetail(undefined); setPage(currentPage-1); }}><ChevronLeft /></Button><span>{currentPage+1} / {Math.max(1,Math.ceil(subjects.length/20))}</span><Button variant="outline" size="icon" aria-label="矩阵下一页" disabled={(currentPage+1)*20>=subjects.length} onClick={() => { setDetail(undefined); setPage(currentPage+1); }}><ChevronRight /></Button></div></div>
    {detail && selectedRow && <MatrixDetail row={selectedRow} column={detail.column} templates={templates} onEditAccount={onEditAccount} onClose={() => { outside.current = false; setDetail(undefined); }} onOutside={event => { if (event.target instanceof Element && event.target.closest('[data-matrix-cell]')) event.preventDefault(); else outside.current = true; }} onCloseFocus={event => { event.preventDefault(); if (!outside.current && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }} />}
  </section></Popover>;
}
function MatrixDetail({ row,column,onClose,templates,onEditAccount,onOutside,onCloseFocus }: { row: Row; column: Column; onClose: () => void; templates: readonly AuthorizationTemplate[]; onEditAccount?: (account: ManagedAccount) => void; onOutside: (event: Event) => void; onCloseFocus: (event: Event) => void }) {
  const cells = row.cells.filter(cell => column.paths.includes(cell.path));
  const notes = cells.flatMap(cell => [...cell.notes, ...cell.actions.map(action => action.note), cell.approvalNote, cell.notificationNote]).filter((note): note is string => !!note);
  const commonConditions = [...new Set(notes.filter((note, index) => notes.indexOf(note) !== index))];
  return <PopoverContent align="start" side="bottom" sideOffset={6} collisionPadding={12} className="matrix-popover flex max-h-[min(70vh,var(--radix-popover-content-available-height))] w-[28rem] max-w-[calc(100vw-24px)] flex-col gap-0 overflow-hidden p-0" aria-labelledby="matrix-detail-title" onInteractOutside={onOutside} onCloseAutoFocus={onCloseFocus}>
    <header className="flex shrink-0 items-start justify-between gap-3 border-b p-4"><div className="min-w-0 space-y-1"><h3 id="matrix-detail-title" className="break-words text-sm font-semibold">{row.subject.name} · {column.label}</h3><p className="break-words text-xs text-muted-foreground">{row.subject.account ? accountAuthorizationLabel(row.subject.account, templates) : '角色模板'}{row.subject.principal.authorizationVersion ? ' · 授权版本 '+row.subject.principal.authorizationVersion : ''}</p></div><Button type="button" variant="ghost" size="icon" aria-label="关闭权限详情" className="size-7 shrink-0" onClick={onClose}><X className="size-4" /></Button></header>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4">{!!commonConditions.length && <section className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground" aria-label="共同办理条件"><h4 className="font-medium">共同办理条件</h4>{commonConditions.map(note => <p key={note}>{note}</p>)}</section>}{cells.map(cell => <section key={cell.path} className="space-y-3 rounded-lg border p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-medium">{cell.label}</h3><span className="inline-flex items-center gap-2 text-xs">读取<StateMark state={cell.read} /></span></div>{(cell.actions.length > 0 || cell.readDetails.length > 1) && <div className="divide-y">{[...(cell.readDetails.length > 1 ? cell.readDetails : []), ...cell.actions].map(action => <div key={`${action.module}:${action.action}`} className="space-y-1 py-2 text-sm"><div className="flex items-center justify-between gap-2"><span>{action.action === 'read' || cell.actions.some(item => item.module !== action.module) ? `${businessModuleDefinition(action.module).label} · ` : ''}{BUSINESS_ACTION_LABELS[action.action]}</span><StateMark state={action.state} reason={action.note} /></div>{action.sources.length > 0 && <p className="text-xs text-muted-foreground">{action.sources.join('、')}</p>}{action.action === 'read' && action.state === 'none' && <p className="text-xs text-muted-foreground">未授权查看</p>}{action.action === 'read' && action.state === 'all' && <p className="text-xs text-muted-foreground">{businessModuleDefinition(action.module).scoped ? '当前筛选范围内全部可查看' : '不按楼栋、专业划分范围'}</p>}{action.state === 'partial' && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">查看可用范围（{action.allowed.length}）</summary><div className="mt-2 flex flex-wrap gap-1">{action.allowed.map(target => <Badge variant="outline" key={`${target.building}:${target.specialty}`}>{target.building} · {target.specialty}</Badge>)}</div></details>}{action.note && !commonConditions.includes(action.note) && <p className="text-xs text-muted-foreground">{action.note}</p>}</div>)}</div>}<div className="grid grid-cols-2 gap-3 border-t pt-3 text-xs"><span className="inline-flex justify-between gap-2">卡片审批<StateMark state={cell.approval} reason={cell.approvalNote} /></span><span className="inline-flex justify-between gap-2">接收通知<StateMark state={cell.notification} reason={cell.notificationNote} /></span></div>{cell.approvalNote && !commonConditions.includes(cell.approvalNote) && <p className="text-xs leading-5 text-muted-foreground">审批：{cell.approvalNote}</p>}{cell.notificationNote && !commonConditions.includes(cell.notificationNote) && <p className="text-xs leading-5 text-muted-foreground">通知：{cell.notificationNote}</p>}{cell.cardDuties.map(duty => <p key={`${duty.name}:${duty.building}`} className="text-xs text-muted-foreground">{duty.name} · {duty.building || '全基地'} · {duty.source ? ({ personnel: '统一岗位来源', handover: '岗位交接', configuration: '系统配置', default: '默认来源' }[duty.source]) : '来源信息未取得'} · 任职版本 {duty.version}</p>)}{cell.notes.filter(note => !commonConditions.includes(note)).map(note => <p key={note} className="text-xs leading-5 text-muted-foreground">{note}</p>)}</section>)}</div>
    {row.subject.account && onEditAccount && <footer className="shrink-0 border-t p-3"><Button type="button" variant="outline" size="sm" onClick={() => { onClose(); onEditAccount(row.subject.account!); }}>编辑此人员权限</Button></footer>}
  </PopoverContent>;
}
