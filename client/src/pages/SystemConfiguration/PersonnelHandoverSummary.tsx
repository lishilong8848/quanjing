import type { HandoverBatchItem, PendingDuty } from '@shared/personnel-handover.interface';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

const moduleNames = { leave: '请休假', overtime: '加班', inventory: '出入库', purchase: '采购', contracts: '合同' };
const statuses = { pending: '待办理', accepted: '已受理', syncing: '同步中', success: '已完成', error: '未完成', skipped: '保留原处理' };
const pageSize = 100;
export function PersonnelHandoverSummary({ pending, progress }: { pending?: readonly PendingDuty[]; progress?: readonly HandoverBatchItem[] }) {
  const [expanded, setExpanded] = useState<Partial<Record<PendingDuty['module'], boolean>>>({});
  const [limits, setLimits] = useState<Partial<Record<PendingDuty['module'], number>>>({});
  const groups = useMemo(() => {
    const result = new Map<PendingDuty['module'], { item: PendingDuty; status?: HandoverBatchItem['status']; error?: string }[]>();
    for (const row of progress || (pending || []).map(item => ({ item }))) {
      const entries = result.get(row.item.module) || []; entries.push(row); result.set(row.item.module, entries);
    }
    return [...result].map(([module, entries]) => ({ module, entries,
      complete: entries.filter(entry => entry.status === 'success' || entry.status === 'skipped').length,
      failed: entries.filter(entry => entry.status === 'error').length }));
  }, [pending, progress]);
  return <div className="space-y-3">{groups.map(group => {
    const name = moduleNames[group.module], open = expanded[group.module] === true, limit = limits[group.module] || pageSize;
    return <section key={group.module} className="space-y-2 border-t pt-3" aria-label={`${name}交接汇总`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm"><span className="font-medium">{name} · {group.entries.length} 项</span>
          {progress && <span className="ml-3 inline-flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>已完成 {group.complete} 项</span><span>处理中 {group.entries.length - group.complete - group.failed} 项</span>{group.failed > 0 && <span className="text-destructive">未完成 {group.failed} 项</span>}</span>}
        </div>
        <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-label={`${open ? '收起' : '查看'}${name}明细`} onClick={() => setExpanded(values => ({ ...values, [group.module]: !open }))}>{open ? '收起明细' : '查看明细'}</Button>
      </div>
      {open && <><ul className="space-y-2 text-sm">{group.entries.slice(0, limit).map(entry => <li key={entry.item.key} className="min-w-0 break-words"><span>{entry.item.title}{entry.status ? ` · ${statuses[entry.status]}` : ''}</span>{entry.error && <p className="mt-1 text-destructive">{entry.error}</p>}</li>)}</ul>
        {group.entries.length > limit && <Button type="button" variant="outline" size="sm" onClick={() => setLimits(values => ({ ...values, [group.module]: limit + pageSize }))}>显示更多（剩余 {group.entries.length - limit} 项）</Button>}
      </>}
    </section>;
  })}</div>;
}
