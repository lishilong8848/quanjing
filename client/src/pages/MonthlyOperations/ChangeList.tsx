import { useMonthlyOperationsExport } from './use-export-access';
import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { MonthlyChange } from '@shared/monthly-operations-changes.interface';
import { EmptyState } from './charts';
import { eventTime as time } from './EventList';
import {
  ChangeDetail,
  ChangeRiskBadge,
  ChangeStateBadge,
  changeTime,
} from './ChangePresentation';
import {
  CHANGE_FILTERS,
  CHANGE_STATES,
  filterChanges,
  isVisibleChange,
  isPriorityChange,
  sortChanges,
  type ChangeFilters,
} from './change-model';

export function ChangeList({
  records,
  loading,
  ready,
  error = '',
}: {
  records: MonthlyChange[];
  loading: boolean;
  ready: boolean;
  error?: string;
}) {
  const { canExport, authorizeExport } = useMonthlyOperationsExport();
  const [filters, setFilters] = useState<ChangeFilters>(CHANGE_FILTERS);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [openSelect, setOpenSelect] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const visible = useMemo(() => records.filter(isVisibleChange), [records]);
  const selected = visible.find((r) => r.id === selectedId);
  const filtered = useMemo(
    () => sortChanges(filterChanges(visible, filters)),
    [visible, filters],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages);
  const apply = (patch: Partial<ChangeFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
    setNotice('');
  };
  const exportCsv = () => void authorizeExport(() => {
    const rows = [
      [
        '编号',
        '变更描述',
        '楼栋',
        '类型',
        '专业',
        '等级',
        '计划开始',
        '计划结束',
        '实际开始',
        '实际结束',
        '状态',
        '结果',
      ],
      ...filtered.map((r) => [
        r.code,
        r.title,
        r.buildings.join('、'),
        r.type,
        r.specialty,
        r.level,
        time(r.plannedStart),
        time(r.plannedEnd),
        time(r.actualStart),
        time(r.actualEnd),
        CHANGE_STATES[r.state],
        r.result,
      ]),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map((row) =>
          row
            .map(
              (v) =>
                '"' +
                v.replace(/^[\s]*[=+@-]/, "'$&").replace(/"/g, '""') +
                '"',
            )
            .join(','),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = '变更清单.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`已导出 ${filtered.length} 条变更`);
  }, setNotice);
  if (!ready)
    return (
      <EmptyState
        title={loading ? '正在读取变更' : error || '变更数据暂不可用'}
        description=""
      />
    );
  return (
    <>
      <div className="mo-event-filters mo-change-filters">
        {(['state', 'type', 'specialty', 'level'] as const).map((key, i) => (
          <Select
            key={key}
            open={openSelect === key}
            onOpenChange={(open) => setOpenSelect(open ? key : null)}
            value={filters[key] || '__all'}
            onValueChange={(v) => apply({ [key]: v === '__all' ? '' : v })}
          >
            <SelectTrigger
              aria-label={['变更状态', '变更类型', '变更专业', '变更等级'][i]}
            >
              <SelectValue>
                {filters[key]
                  ? key === 'state'
                    ? CHANGE_STATES[filters.state as MonthlyChange['state']]
                    : filters[key]
                  : ['全部状态', '全部类型', '全部专业', '全部等级'][i]}
              </SelectValue>
            </SelectTrigger>
            {openSelect === key && (
              <SelectContent>
                <SelectItem value="__all">
                  {['全部状态', '全部类型', '全部专业', '全部等级'][i]}
                </SelectItem>
                {[...new Set(visible.map((r) => r[key]))]
                  .sort()
                  .map((value) => (
                    <SelectItem key={value} value={value}>
                      {key === 'state'
                        ? CHANGE_STATES[value as MonthlyChange['state']]
                        : value}
                    </SelectItem>
                  ))}
              </SelectContent>
            )}
          </Select>
        ))}
        <div className="mo-event-search">
          <Search />
          <Input
            aria-label="搜索变更"
            placeholder="搜索变更、编号…"
            value={filters.search}
            onChange={(e) => apply({ search: e.target.value })}
          />
        </div>
        <Button
          variant="outline"
          disabled={!canExport || !filtered.length}
          onClick={exportCsv}
        >
          <Download />
          导出
        </Button>
      </div>
      <div className="mo-event-scope">
        <span>{filtered.length} 条记录</span>
        <span role="status">{notice}</span>
        <Button variant="ghost" size="sm" onClick={() => apply(CHANGE_FILTERS)}>
          重置筛选
        </Button>
      </div>
      {filtered.length ? (
        <div className="mo-table-wrap mo-change-table">
          <Table>
            <colgroup>
              <col className="mo-change-col-state" />
              <col />
              <col className="mo-change-col-building" />
              <col className="mo-change-col-type" />
              <col className="mo-change-col-risk" />
              <col className="mo-change-col-time" />
            </colgroup>
            <TableHeader>
              <TableRow>
                {[
                  '状态',
                  '变更描述',
                  '楼栋',
                  '类型 / 专业',
                  '风险等级',
                  '计划时间',
                ].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.slice((current - 1) * size, current * size).map((r) => (
                <TableRow
                  key={r.id}
                  className={isPriorityChange(r) ? 'is-priority' : ''}
                >
                  <TableCell data-label="状态">
                    <ChangeStateBadge state={r.state} />
                  </TableCell>
                  <TableCell
                    data-label="变更"
                    className="mo-change-description"
                  >
                    <button
                      type="button"
                      className="mo-event-title"
                      onClick={(e) => {
                        trigger.current = e.currentTarget;
                        setSelectedId(r.id);
                      }}
                    >
                      {r.title}
                    </button>
                    <small className="mo-event-code">{r.code}</small>
                  </TableCell>
                  <TableCell data-label="楼栋" className="mo-change-buildings">
                    {r.buildings.length
                      ? r.buildings.map((b) => (
                          <span key={b} className="mo-building-word">
                            {b}
                          </span>
                        ))
                      : '未标注'}
                  </TableCell>
                  <TableCell data-label="类型 / 专业">
                    {r.type}
                    <small className="mo-event-code">{r.specialty}</small>
                  </TableCell>
                  <TableCell data-label="风险等级">
                    <ChangeRiskBadge level={r.level} />
                  </TableCell>
                  <TableCell data-label="计划时间" className="mo-change-plan">
                    <span>
                      <small>起</small>
                      {changeTime(r.plannedStart)}
                    </span>
                    <span>
                      <small>止</small>
                      {changeTime(r.plannedEnd)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title="暂无匹配变更" description="" />
      )}
      <div className="mo-pagination">
        <Select
          open={openSelect === 'size'}
          onOpenChange={(open) => setOpenSelect(open ? 'size' : null)}
          value={String(size)}
          onValueChange={(v) => {
            setSize(Number(v));
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="每页变更条数">
            <SelectValue>{size} 条 / 页</SelectValue>
          </SelectTrigger>
          {openSelect === 'size' && (
            <SelectContent>
              {[10, 20, 50].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 条 / 页
                </SelectItem>
              ))}
            </SelectContent>
          )}
        </Select>
        <Button
          variant="outline"
          size="icon"
          aria-label="变更上一页"
          disabled={current <= 1}
          onClick={() => setPage(current - 1)}
        >
          <ChevronLeft />
        </Button>
        <span>
          {current} / {pages}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="变更下一页"
          disabled={current >= pages}
          onClick={() => setPage(current + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
      <Sheet
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent
          className="monthly-operations mo-detail-sheet mo-resource-sheet mo-change-form-sheet"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <SheetHeader className="mo-detail-header">
            <SheetTitle>变更详情</SheetTitle>
            <SheetDescription className="sr-only">
              变更计划、执行结果与风险信息
            </SheetDescription>
          </SheetHeader>
          <div className="mo-resource-sheet-body">
            {selected ? (
              <ChangeDetail record={selected} />
            ) : (
              <EmptyState title="该变更已不在当前清单中" description="" />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
