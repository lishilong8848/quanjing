import { useMonthlyOperationsExport } from './use-export-access';
import { startTransition, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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
import { EmptyState } from './charts';
import { StatusBadge, WorkTable } from './components';
import {
  filterRecords,
  KIND_LABELS,
  numberFormat,
  STATUS_LABELS,
  type DetailSelection,
  type MonthlyView,
  type WorkRecord,
  type WorkStatus,
} from './model';

function ResourceTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) {
  return (
    <div className="mo-resource-table">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header}>{header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row[0]}>
              {row.map((cell, index) => (
                <TableCell key={index}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
export function DetailSheet({
  selection,
  view,
  onClose,
  restoreFocus,
}: {
  selection: DetailSelection;
  view: MonthlyView;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { canExport, authorizeExport } = useMonthlyOperationsExport();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [activeRecord, setActiveRecord] = useState<WorkRecord | null>(() =>
    selection.id
      ? (view.records.find((item) => item.id === selection.id) ?? null)
      : null,
  );
  const [exportMessage, setExportMessage] = useState('');
  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    startTransition(() => setContentReady(true));
  }, []);
  const records = useMemo(
    () =>
      !contentReady || selection.resource
        ? []
        : filterRecords(
            view.records,
            {
              ...selection,
              status:
                status === 'all' ? selection.status : (status as WorkStatus),
            },
            search,
          ).sort((a, b) => b.date.localeCompare(a.date)),
    [contentReady, view.records, selection, search, status],
  );
  const resources = useMemo(
    () =>
      view.resources.filter(
        (item) => !selection.building || item.building === selection.building,
      ),
    [view.resources, selection.building],
  );
  const resourceTable = useMemo(() => {
    if (!contentReady || !selection.resource) return { headers: [], rows: [] };
    if (selection.resource === 'capacity')
      return {
        headers: [
          '楼栋',
          '设计容量',
          '已上电',
          '可用机柜',
          '上架率',
          '负载率',
          `${view.period.scope}上电`,
          `${view.period.scope}下电`,
        ],
        rows: resources.map((item) => [
          item.building,
          String(item.racks),
          String(item.online),
          String(item.racks - item.online),
          `${((item.online / item.racks) * 100).toFixed(1)}%`,
          `${item.load}%`,
          String(item.poweredOn),
          String(item.poweredOff),
        ]),
      };
    if (selection.resource === 'reserve')
      return {
        headers: ['楼栋', '储备用水 (m³)', '柴油储备 (m³)', '预计后备 (h)'],
        rows: resources.map((item) => [
          item.building,
          String(item.waterReserve),
          String(item.fuelReserve),
          String(item.backupHours),
        ]),
      };
    if (selection.resource === 'water')
      return {
        headers: ['日期', '用水 (m³)', '加药排水 (m³)', 'WUE (L/kWh)'],
        rows: view.daily.map((item) => [
          item.day,
          numberFormat(item.water),
          numberFormat(item.drainage),
          item.wue.toFixed(3),
        ]),
      };
    return {
      headers: [
        '日期',
        '总用电 (kWh)',
        'IT (kWh)',
        '冷源 (kWh)',
        '末端 (kWh)',
        '辅助 (kWh)',
        'PUE',
        '湿球温度 (℃)',
      ],
      rows: view.daily.map((item) => [
        item.day,
        numberFormat(item.total),
        numberFormat(item.it),
        numberFormat(item.cooling),
        numberFormat(item.terminal),
        numberFormat(item.auxiliary),
        item.pue.toFixed(3),
        item.wetBulb.toFixed(1),
      ]),
    };
  }, [
    contentReady,
    selection.resource,
    resources,
    view.daily,
    view.period.scope,
  ]);
  const count = selection.resource ? resourceTable.rows.length : records.length;
  const pageCount = Math.max(1, Math.ceil(count / 10));
  const currentPage = Math.min(page, pageCount);
  const exportRows = () => void authorizeExport(() => {
    const table = selection.resource
      ? resourceTable
      : {
          headers: [
            '编号',
            '事项',
            '楼栋',
            '类别',
            '日期',
            '状态',
            '专业',
            '来源',
          ],
          rows: records.map((item) => [
            item.id,
            item.title,
            item.building,
            KIND_LABELS[item.kind],
            item.date,
            STATUS_LABELS[item.status],
            item.specialty,
            item.source,
          ]),
        };
    const csv =
      '\uFEFF' +
      [table.headers, ...table.rows]
        .map((row) =>
          row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `智舱月览-演示数据-${view.period.start}_${view.period.end}-${selection.resource ?? selection.kind ?? '清单'}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportMessage(`已导出 ${count} 条演示数据`);
  }, setExportMessage);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        aria-busy={!contentReady}
        className="monthly-operations mo-detail-sheet"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader className="mo-detail-header">
          <span className="mo-eyebrow">MONTHLY OPERATIONS / 明细</span>
          <SheetTitle>{selection.title}</SheetTitle>
          <SheetDescription className="sr-only">
            所选周期和楼栋的演示明细，支持搜索、筛选及导出
          </SheetDescription>
          <div className="mo-detail-context">
            <Badge variant="outline">演示数据</Badge>
            <span>{view.period.rangeLabel}</span>
            <span>
              {selection.building ??
                (view.building === 'all' ? '全部楼栋' : view.building)}
            </span>
          </div>
        </SheetHeader>
        {!contentReady ? (
          <div className="mo-drawer-pending" role="status">
            正在准备明细…
          </div>
        ) : activeRecord ? (
          <div className="mo-record-detail">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setActiveRecord(null)}
            >
              <ArrowLeft />
              返回清单
            </Button>
            <StatusBadge status={activeRecord.status} />
            <h3>{activeRecord.title}</h3>
            <p>{activeRecord.id}</p>
            <dl>
              {[
                ['类型', KIND_LABELS[activeRecord.kind]],
                ['楼栋', activeRecord.building],
                ['日期', activeRecord.date],
                ['责任班组', activeRecord.owner],
                ['专业', activeRecord.specialty],
                ['来源', activeRecord.source],
                ['等级', activeRecord.level],
                ...(activeRecord.kind === 'alarm'
                  ? [['恢复状态', activeRecord.recovered ? '已恢复' : '未恢复']]
                  : []),
                ...(activeRecord.score !== null
                  ? [['演练得分', `${activeRecord.score} 分`]]
                  : []),
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mo-demo-note">此条为排版与交互演示记录</div>
          </div>
        ) : (
          <>
            <div className="mo-detail-toolbar">
              {!selection.resource && (
                <>
                  <div className="mo-search">
                    <Search aria-hidden="true" />
                    <Input
                      aria-label="搜索明细"
                      placeholder="搜索事项、编号或责任班组"
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setPage(1);
                        setExportMessage('');
                      }}
                    />
                  </div>
                  {!selection.status && (
                    <Select
                      value={status}
                      onValueChange={(value) => {
                        setStatus(value);
                        setPage(1);
                      }}
                    >
                      <SelectTrigger aria-label="筛选明细状态">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部状态</SelectItem>
                        {Object.entries(STATUS_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!canExport || !count}
                onClick={exportRows}
              >
                <Download />
                导出清单
              </Button>
            </div>
            <div className="mo-detail-count" role="status">
              {count} 条记录<span>{exportMessage}</span>
            </div>
            <div className="mo-detail-body">
              {count ? (
                selection.resource ? (
                  <ResourceTable
                    headers={resourceTable.headers}
                    rows={resourceTable.rows.slice(
                      (currentPage - 1) * 10,
                      currentPage * 10,
                    )}
                  />
                ) : (
                  <WorkTable
                    records={records.slice(
                      (currentPage - 1) * 10,
                      currentPage * 10,
                    )}
                    onSelect={setActiveRecord}
                  />
                )
              ) : (
                <EmptyState
                  onReset={
                    search || status !== 'all'
                      ? () => {
                          setSearch('');
                          setStatus('all');
                          setPage(1);
                        }
                      : undefined
                  }
                />
              )}
            </div>
            <div className="mo-pagination">
              <span>每页 10 条 · 共 {count} 条</span>
              <div>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="上一页"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <ChevronLeft />
                </Button>
                <span>
                  {currentPage} / {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="下一页"
                  disabled={currentPage >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
