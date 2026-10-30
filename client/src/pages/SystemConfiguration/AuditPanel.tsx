import { useMemo, useState } from 'react';
import type { ConfigurationAudit } from '@shared/access-configuration.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { auditExportRows, filterConfigurationAudit } from './configuration-helpers';

export function AuditPanel({ rows }: { rows: ConfigurationAudit[] }) {
  const [query, setQuery] = useState(''), [actor, setActor] = useState(''), [action, setAction] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [page, setPage] = useState(0);
  const actors = useMemo(() => [...new Map(rows.map(row => [row.actorId, row.actorName])).entries()], [rows]);
  const actions = useMemo(() => [...new Set(rows.map(row => row.action))], [rows]);
  const filtered = useMemo(() => filterConfigurationAudit(rows, query, actor, action, from, to), [rows, query, actor, action, from, to]);
  const safePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  const change = (setter: (value: string) => void, value: string) => { setter(value); setPage(0); };
  function exportSummary() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: auditExportRows(filtered) }, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `配置变更摘要-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="space-y-4" aria-label="变更记录">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">导出当前筛选摘要，不包含账号标识、配置原文或密码。</p><Button variant="outline" disabled={!filtered.length} onClick={exportSummary}>导出摘要 JSON</Button></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><label className="space-y-1 text-sm"><span>搜索</span><Input aria-label="搜索变更记录" placeholder="操作人、对象或类型" value={query} onChange={event => change(setQuery, event.target.value)} /></label><label className="space-y-1 text-sm"><span>操作人</span><select className="config-select w-full" value={actor} onChange={event => change(setActor, event.target.value)}><option value="">全部操作人</option>{actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label className="space-y-1 text-sm"><span>变更类型</span><select className="config-select w-full" value={action} onChange={event => change(setAction, event.target.value)}><option value="">全部类型</option>{actions.map(item => <option key={item}>{item}</option>)}</select></label><label className="space-y-1 text-sm"><span>开始日期</span><Input type="date" value={from} max={to || undefined} onChange={event => change(setFrom, event.target.value)} /></label><label className="space-y-1 text-sm"><span>结束日期</span><Input type="date" value={to} min={from || undefined} onChange={event => change(setTo, event.target.value)} /></label></div>
    {from && to && from > to && <p role="alert" className="text-sm text-destructive">结束日期不能早于开始日期。</p>}
    <div className="divide-y rounded-lg border bg-card">{filtered.slice(safePage * 20, (safePage + 1) * 20).map(item => <article className="space-y-2 p-4" key={item.id}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{item.actorName} · {item.action}</p><time className="text-xs text-muted-foreground">{new Date(item.at).toLocaleString('zh-CN', { hour12: false })}</time></div><p className="break-words text-sm">{item.target}</p><details><summary className="cursor-pointer text-xs text-muted-foreground">查看变更前后</summary><div className="mt-2 grid gap-3 sm:grid-cols-2"><p className="break-words text-xs leading-5"><span className="font-medium">变更前：</span>{item.before}</p><p className="break-words text-xs leading-5"><span className="font-medium">变更后：</span>{item.after}</p></div></details></article>)}{!filtered.length && <p className="p-8 text-center text-sm text-muted-foreground">没有符合条件的变更记录</p>}</div>
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><span>匹配 {filtered.length} 条 · 当前保存记录 {rows.length} 条</span><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={!safePage} onClick={() => setPage(safePage - 1)}>上一页</Button><span>{safePage + 1} / {Math.max(1, Math.ceil(filtered.length / 20))}</span><Button variant="outline" size="sm" disabled={(safePage + 1) * 20 >= filtered.length} onClick={() => setPage(safePage + 1)}>下一页</Button></div></div>
  </section>;
}
