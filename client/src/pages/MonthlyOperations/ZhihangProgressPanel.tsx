import { useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Headset,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ZhihangChangeProgress } from '@shared/monthly-operations-progress.interface';
import { Panel, EmptyState } from './charts';
import type { PanelProps } from './Overview';
import { eventTime as time } from './EventList';
import { useZhihangProgress } from './change-data';
import {
  delayLabel,
  filterProgress,
  progressAttention,
  progressScope,
  PROGRESS_FOCUS,
  type ProgressFocus,
} from './progress-model';

function Attention({ row }: { row: ZhihangChangeProgress }) {
  const flags = progressAttention(row);
  return (
    <span className="mo-progress-badges">
      {flags.customer && (
        <Badge className="mo-progress-alert" variant="outline">
          待客服审批
        </Badge>
      )}
      {flags.post && (
        <Badge className="mo-progress-alert is-post" variant="outline">
          待实施后审批
        </Badge>
      )}
      {flags.delayed && (
        <Badge className="mo-progress-alert is-delay" variant="outline">
          {delayLabel(row)}
        </Badge>
      )}
      {!flags.customer && !flags.post && !flags.delayed && <span>—</span>}
    </span>
  );
}

export function ZhihangProgressPanel({ view }: Pick<PanelProps, 'view'>) {
  const { data, loading, error, retry } = useZhihangProgress(view.period);
  const ready = !!data && data.status !== 'error';
  const [scope, setScope] = useState('period');
  const [focus, setFocus] = useState<ProgressFocus>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, select] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const rows = useMemo(
    () =>
      progressScope(
        data?.records ?? [],
        view.period.start,
        view.period.end,
        view.building,
        scope === 'history',
      ),
    [data, view.period.start, view.period.end, view.building, scope],
  );
  const filtered = useMemo(
    () => filterProgress(rows, focus, query),
    [rows, focus, query],
  );
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / 5)));
  const selected = data?.records.find((row) => row.id === selectedId);
  const notice = error || data?.message;
  const choose = (value: ProgressFocus) => {
    setFocus(value);
    setPage(1);
  };
  return (
    <Panel title="智航变更进展" className="mo-progress-panel">
      <div className="mo-progress-priorities">
        {(['customer', 'post', 'delayed'] as const).map((key, index) => {
          const Icon = [Headset, ClipboardCheck, CalendarClock][index];
          const count = filterProgress(rows, key, '').length;
          return (
            <button
              type="button"
              key={key}
              className={`mo-progress-priority ${focus === key ? 'is-selected' : ''}`}
              disabled={!ready}
              aria-pressed={focus === key}
              onClick={() => choose(focus === key ? 'all' : key)}
            >
              <Icon aria-hidden="true" />
              <span>{PROGRESS_FOCUS[key]}</span>
              <strong>{ready ? count : '—'}</strong>
              <span className="sr-only">项</span>
            </button>
          );
        })}
      </div>
      <div className="mo-progress-toolbar">
        <Button
          variant={focus === 'all' ? 'secondary' : 'ghost'}
          onClick={() => choose('all')}
        >
          全部 {ready ? rows.length : '—'} 项
        </Button>
        <Select
          value={scope}
          onValueChange={(value) => {
            setScope(value);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="智航进展范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="period">当前周期</SelectItem>
            <SelectItem value="history">全部历史</SelectItem>
          </SelectContent>
        </Select>
        <Input
          aria-label="搜索智航变更"
          placeholder="搜索标题、工单号"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <Button variant="ghost" disabled={loading} onClick={retry}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          刷新进展
        </Button>
      </div>
      {(loading || notice) && (
        <div
          className={`mo-live-status ${notice ? 'is-error' : ''}`}
          role="status"
        >
          {loading ? '正在读取智航进展…' : notice}
        </div>
      )}
      {!!data?.invalid && (
        <div className="mo-live-status">
          {data.invalid} 项缺少计划日期，可在全部历史查看
        </div>
      )}
      {!ready ? (
        <EmptyState
          title={loading ? '正在读取智航变更' : '智航进展暂不可用'}
          description=""
        />
      ) : (
        <>
          <div className="mo-progress-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>变更 / 工单</TableHead>
                  <TableHead>楼栋</TableHead>
                  <TableHead>当前节点</TableHead>
                  <TableHead>计划时段</TableHead>
                  <TableHead>重点关注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice((current - 1) * 5, current * 5).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="mo-progress-title"
                        onClick={(event) => {
                          trigger.current = event.currentTarget;
                          select(row.id);
                        }}
                        aria-label={`查看${row.code || row.title}进展`}
                      >
                        <strong>{row.title}</strong>
                        <span>
                          {row.code} · {row.workOrder || '工单号未填写'}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>{row.buildings.join('、') || '—'}</TableCell>
                    <TableCell>
                      <span
                        className={
                          progressAttention(row).customer ||
                          progressAttention(row).post
                            ? 'mo-progress-node'
                            : ''
                        }
                      >
                        {row.node || '未标注'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="mo-progress-time">
                        {time(row.deferredStart || row.plannedStart)}
                        <br />至 {time(row.deferredEnd || row.plannedEnd)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Attention row={row} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!filtered.length && (
            <EmptyState title="暂无符合条件的智航变更" description="" />
          )}
          <div className="mo-progress-pagination">
            <span>
              {filtered.length} 项
              {focus !== 'all' && ` · ${PROGRESS_FOCUS[focus]}`}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="智航进展上一页"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft />
            </Button>
            <span>
              {current} / {Math.max(1, Math.ceil(filtered.length / 5))}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="智航进展下一页"
              disabled={current * 5 >= filtered.length}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </>
      )}
      <Sheet
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
      >
        <SheetContent
          className="monthly-operations mo-detail-sheet mo-resource-sheet mo-progress-sheet"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <SheetHeader className="mo-detail-header">
            <SheetTitle>智航变更进展</SheetTitle>
            <SheetDescription className="sr-only">
              变更节点、原计划、延期计划和实际执行时间
            </SheetDescription>
          </SheetHeader>
          <div className="mo-resource-sheet-body">
            {(loading || notice) && (
              <div className="mo-live-status" role="status">
                {loading ? '正在更新进展…' : notice}
                <Button variant="ghost" disabled={loading} onClick={retry}>
                  重试
                </Button>
              </div>
            )}
            {selected ? (
              <>
                <h3>{selected.title}</h3>
                <p className="mo-progress-order">
                  {selected.code} · {selected.workOrder || '工单号未填写'}
                </p>
                <div className="mo-progress-current">
                  <span>当前节点</span>
                  <strong>{selected.node || '未标注'}</strong>
                  <Attention row={selected} />
                </div>
                <dl className="mo-progress-form">
                  {(
                    [
                      ['楼栋', selected.buildings.join('、')],
                      ['变更等级', selected.level],
                      ['变更类型', selected.type],
                      ['变更类别', selected.category],
                      ['实施状态', selected.executionStatus],
                      ['实施结果', selected.status],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value || '—'}</dd>
                    </div>
                  ))}
                </dl>
                <section className="mo-progress-schedule">
                  <h4>计划与执行</h4>
                  <div className="mo-progress-schedule-grid">
                    {(
                      [
                        ['原计划', selected.plannedStart, selected.plannedEnd],
                        [
                          '延期计划',
                          selected.deferredStart,
                          selected.deferredEnd,
                        ],
                        ['实际执行', selected.actualStart, selected.actualEnd],
                      ] as const
                    ).map(([label, start, end]) => (
                      <div
                        key={label}
                        className={
                          label === '延期计划' &&
                          progressAttention(selected).delayed
                            ? 'is-delay'
                            : ''
                        }
                      >
                        <strong>{label}</strong>
                        <dl>
                          <dt>开始</dt>
                          <dd>{time(start)}</dd>
                          <dt>结束</dt>
                          <dd>{time(end)}</dd>
                        </dl>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <EmptyState title="此变更已不在当前数据中" description="" />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Panel>
  );
}
