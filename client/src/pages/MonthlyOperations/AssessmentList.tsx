import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SourceModal } from './SourceModal';
import type {
  AssessmentKind,
  AssessmentRow,
} from '@shared/monthly-operations-assessment.interface';
import { assessmentFilter } from './assessment-model';
import { EmptyState } from './charts';
function detailValue(value: string) {
  return /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : value;
}
export function AssessmentList({
  kind,
  records,
  defaultTag = 'all',
  compact = false,
}: {
  kind: AssessmentKind | 'maintenance';
  records: AssessmentRow[];
  defaultTag?: string;
  compact?: boolean;
}) {
  const [tag, setTag] = useState(defaultTag),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<AssessmentRow | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const openRecord = (row: AssessmentRow, element: HTMLElement) => {
    trigger.current = element;
    setSelected(row);
  };
  const tags = [...new Set(records.flatMap((r) => r.tags))];
  const filtered = useMemo(
    () =>
      assessmentFilter(
        tag === 'focus' ? records.filter((r) => r.tags.length) : records,
        tag === 'focus' ? 'all' : tag,
        search,
      ),
    [records, tag, search],
  );
  const size = compact ? 6 : 12,
    pages = Math.max(1, Math.ceil(filtered.length / size)),
    current = Math.min(page, pages);
  const apply = (v: string) => {
    setTag(v);
    setPage(1);
  };
  return (
    <div className="mo-assessment-list">
      <div className="mo-assessment-filters">
        <div className="mo-assessment-chips">
          {[
            ['all', '全部'],
            ['focus', '重点关注'],
            ...tags.map((t) => [t, t]),
          ].map(([v, label]) => (
            <Button
              key={v}
              size="sm"
              variant={tag === v ? 'default' : 'outline'}
              onClick={() => apply(v)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Input
          aria-label="搜索考核清单"
          placeholder="搜索名称、编号"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <div className="mo-assessment-count">{filtered.length} 条记录</div>
      {!filtered.length ? (
        <EmptyState title="暂无匹配记录" description="" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>状态 / 关注</TableHead>
              <TableHead>{kind === 'risk' ? '排查专项' : '事项'}</TableHead>
              <TableHead>楼栋</TableHead>
              <TableHead>
                {kind === 'risk' ? '应完成 / 已排查 / 已审核' : '日期'}
              </TableHead>
              <TableHead>
                {kind === 'inspection'
                  ? '巡检结果'
                  : kind === 'drill'
                    ? '执行 / 评估'
                    : '业务状态'}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.slice((current - 1) * size, current * size).map((r) => (
              <TableRow
                key={r.id}
                className={r.tags.length ? 'is-priority' : ''}
              >
                <TableCell className="mo-assessment-status-cell">
                  <div className="mo-assessment-status-tags">
                    <Badge variant="outline">{r.status}</Badge>
                    {r.tags
                      .filter((t) => kind !== 'event' || t !== '处理异常')
                      .map((t) =>
                        kind === 'inspection' &&
                        (t === '巡检异常' || t === '超期待提交') ? (
                          <button
                            key={t}
                            type="button"
                            className="mo-assessment-attention mo-assessment-detail-trigger"
                            aria-label={`查看${r.title}的${t}详情`}
                            onClick={(event) =>
                              openRecord(r, event.currentTarget)
                            }
                          >
                            {t}
                          </button>
                        ) : (
                          <Badge
                            key={t}
                            className="mo-assessment-attention"
                            variant="outline"
                          >
                            {t}
                          </Badge>
                        ),
                      )}
                  </div>
                </TableCell>
                <TableCell>
                  <button
                    className="mo-event-title"
                    onClick={(e) => openRecord(r, e.currentTarget)}
                  >
                    {r.title}
                    <small>
                      {r.code}
                      {r.groupedEvents &&
                        ` · 同段合并 ${r.groupedEvents.length} 条`}
                    </small>
                  </button>
                </TableCell>
                <TableCell className="mo-nowrap">{r.building}</TableCell>
                <TableCell className="mo-nowrap">
                  {kind === 'risk'
                    ? `${r.planned ?? '—'} / ${r.checked ?? '—'} / ${r.approved ?? '—'}`
                    : (r.date ?? '—')}
                </TableCell>
                <TableCell>
                  {kind === 'inspection'
                    ? (r.detail.find((d) => d.label === '巡检结果')?.value ??
                      '—')
                    : kind === 'drill'
                      ? (r.detail.find((d) => d.label === '执行状态')?.value ??
                        '—')
                      : r.done
                        ? '已完成'
                        : r.status}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="mo-pagination">
        <span>
          {current} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={current === 1}
          onClick={() => setPage(current - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={current === pages}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </Button>
      </div>
      {selected && (
        <SourceModal
          variant="record"
          title={selected.title}
          trigger={trigger.current}
          onClose={() => setSelected(null)}
        >
          <div className="mo-assessment-record-body">
            {kind === 'event' && selected.tags.includes('处理异常') && (
              <div className="mo-assessment-findings">
                {selected.detail
                  .filter(({ label }) =>
                    ['响应超时', '确认超时'].includes(label),
                  )
                  .map(({ label, value }) => (
                    <section className="mo-assessment-finding" key={label}>
                      <strong>{label}</strong>
                      <p>{value}</p>
                    </section>
                  ))}
              </div>
            )}
            {kind === 'event' && selected.groupedEvents && (
              <section className="mo-assessment-cluster" aria-label="同段事件明细">
                <h3>同段事件 · {selected.groupedEvents.length} 条</h3>
                <ol>
                  {selected.groupedEvents.map((item) => (
                    <li key={item.id}>
                      <strong>
                        {detailValue(item.occurredAt) || '时间未标注'} ·{' '}
                        {item.code || item.id}
                      </strong>
                      <span>
                        {item.status}
                        {item.tags.length > 0 && ` · ${item.tags.join('、')}`}
                      </span>
                      <small>{item.title}</small>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {kind === 'inspection' &&
              selected.tags.some((tag) =>
                ['巡检异常', '超期待提交'].includes(tag),
              ) && (
                <div className="mo-assessment-findings">
                  {selected.tags.includes('巡检异常') && (
                    <section
                      className="mo-assessment-finding"
                      aria-label="巡检异常原因"
                    >
                      <strong>巡检异常</strong>
                      <p>
                        {selected.detail.find((d) => d.label === '异常原因')
                          ?.value ?? '源表未填写具体异常原因'}
                      </p>
                    </section>
                  )}
                  {selected.tags.includes('超期待提交') && (
                    <section
                      className="mo-assessment-finding"
                      aria-label="超期待提交班次"
                    >
                      <strong>超期待提交</strong>
                      <p>
                        {selected.building} ·{' '}
                        {selected.detail.find((d) => d.label === '班次')
                          ?.value ?? '班次未标注'}
                        {' · '}
                        {selected.code || selected.title}
                      </p>
                      <p>
                        计划截止：
                        {detailValue(
                          selected.detail.find((d) => d.label === '计划截止')
                            ?.value ?? '',
                        ) || '未标注'}
                        ；尚未提交
                      </p>
                    </section>
                  )}
                </div>
              )}
            <div className="mo-assessment-record-status">
              <Badge>{selected.status}</Badge>
              {selected.tags
                .filter((t) => kind !== 'event' || t !== '处理异常')
                .map((t) => (
                  <Badge
                    key={t}
                    variant="outline"
                    className="mo-assessment-attention"
                  >
                    {t}
                  </Badge>
                ))}
              <span>
                {selected.building} · {selected.date}
              </span>
            </div>
            <dl>
              {selected.detail
                .filter(
                  (d) =>
                    kind !== 'event' ||
                    !['响应超时', '确认超时'].includes(d.label),
                )
                .map((d) => (
                  <div key={d.label}>
                    <dt>{d.label}</dt>
                    <dd>{detailValue(d.value)}</dd>
                  </div>
                ))}
            </dl>
          </div>
        </SourceModal>
      )}
    </div>
  );
}
