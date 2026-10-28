import { useMonthlyOperationsExport } from './use-export-access';
import { startTransition, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import type { MonthlyEnergyBuilding } from '@shared/monthly-operations-resources.interface';
import { EnergyExplorer, RackCharts } from './ResourceCharts';
import { RackHistoryChart } from './RackHistoryChart';
import { LoadCharts } from './LoadCharts';
import { useResourceData } from './resource-data';
import {
  RESOURCE_METRICS,
  rackSummary,
  type ResourceMetric,
  type ResourceTrendRow,
} from './resource-model';
import {
  numberFormat,
  type BuildingFilter,
  type DetailSelection,
} from './model';
import type { ReportPeriod } from './period';

export function ResourceDetailSheet({
  selection,
  building,
  period,
  onClose,
  restoreFocus,
}: {
  selection: DetailSelection;
  building: BuildingFilter;
  period: ReportPeriod;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { canExport, authorizeExport } = useMonthlyOperationsExport();
  const { data } = useResourceData();
  const selected = selection.building ?? building;
  const racks = selection.resource === 'capacity';
  const load = selection.resource === 'load';
  const water = selection.resource === 'water';
  const [ready, setReady] = useState(false);
  const [table, setTable] = useState<{
    headers: string[];
    rows: string[][];
  } | null>(null);
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  useEffect(() => {
    startTransition(() => setReady(true));
  }, []);
  const rackTable = useMemo(
    () => ({
      headers: [
        '楼栋',
        '快照日期',
        '设计容量（柜）',
        '已上电（柜）',
        '可用（柜）',
        '上架率',
      ],
      rows: rackSummary(data, selected).rows.map((row) => [
        row.building,
        row.date,
        String(row.capacity),
        String(row.online),
        String(row.capacity - row.online),
        `${row.rate.toFixed(1)}%`,
      ]),
    }),
    [data, selected],
  );
  const loadTable = {
    headers: ['楼栋', '数据日期', 'IT负载率'],
    rows: (data?.load?.rows ?? [])
      .filter((row) => selected === 'all' || selected === row.building)
      .map((row) => [
        row.building,
        data?.load.date ?? '—',
        `${row.value.toFixed(1)}%`,
      ]),
  };
  const currentTable = racks ? rackTable : load ? loadTable : table;
  const exportTable = () => void authorizeExport(() => {
    if (!currentTable) return;
    const csv =
      '\uFEFF' +
      [currentTable.headers, ...currentTable.rows]
        .map((row) =>
          row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `智舱月览-${racks ? '机柜快照' : load ? 'IT负载率' : '趋势数据'}-${period.start}_${period.end}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(`已导出 ${currentTable.rows.length} 条数据`);
  }, setMessage);
  const showRows = (
    rows: ResourceTrendRow[],
    metric: ResourceMetric,
    visible: MonthlyEnergyBuilding[],
  ) => {
    setPage(1);
    setTable({
      headers: [
        '日期',
        ...visible.map(
          (building) => `${building} ${RESOURCE_METRICS[metric].unit}`,
        ),
      ],
      rows: rows.map((row) => [
        row.name,
        ...visible.map((building) =>
          typeof row[building] === 'number'
            ? numberFormat(
                row[building] as number,
                RESOURCE_METRICS[metric].precision,
              )
            : '—',
        ),
      ]),
    });
  };
  const pages = Math.max(1, Math.ceil((currentTable?.rows.length ?? 0) / 10));
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="monthly-operations mo-detail-sheet mo-resource-sheet"
        aria-busy={!ready}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader className="mo-detail-header">
          <SheetTitle>
            {load
              ? '各楼 IT 负载率'
              : racks
                ? '机柜容量与上架率'
                : water
                  ? '用水与水效趋势'
                  : '电耗与能效趋势'}
          </SheetTitle>
          <SheetDescription className="sr-only">
            查看真实数据图表、楼栋趋势和明细
          </SheetDescription>
          <div className="mo-detail-context">
            <Badge variant="outline">实际数据</Badge>
            <span>{period.rangeLabel}</span>
            <span>{selected === 'all' ? '全部楼栋' : selected}</span>
          </div>
        </SheetHeader>
        {!ready ? (
          <div className="mo-drawer-pending" role="status">
            正在准备图表…
          </div>
        ) : (
          <div className="mo-resource-sheet-body">
            {!racks && table ? (
              <Button variant="ghost" onClick={() => setTable(null)}>
                <ChevronLeft />
                返回趋势图
              </Button>
            ) : racks ? (
              <>
                <RackCharts building={selected} />
                <RackHistoryChart building={selected} />
              </>
            ) : load ? (
              <LoadCharts building={selected} />
            ) : (
              <EnergyExplorer
                period={period}
                building={selected}
                initialMetric={selection.metric ?? (water ? 'water' : 'pue')}
                onRows={showRows}
              />
            )}
            {currentTable && (
              <div className="mo-real-detail-table">
                <div className="mo-real-table-heading">
                  <h3>
                    {racks
                      ? '各楼机柜明细'
                      : load
                        ? '各楼负载明细'
                        : '当前趋势明细'}
                  </h3>
                  <Button
                    variant="outline"
                    onClick={exportTable}
                    disabled={!canExport || !currentTable.rows.length}
                  >
                    <Download />
                    导出清单
                  </Button>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {currentTable.headers.map((header) => (
                        <TableHead key={header}>{header}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentTable.rows
                      .slice((page - 1) * 10, page * 10)
                      .map((row) => (
                        <TableRow key={row[0]}>
                          {row.map((cell, index) => (
                            <TableCell key={index}>{cell}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
                <div className="mo-pagination">
                  <span>{currentTable.rows.length} 条记录</span>
                  <span role="status">{message}</span>
                  <div>
                    <Button
                      variant="outline"
                      disabled={page <= 1}
                      aria-label="上一页"
                      onClick={() => setPage((value) => value - 1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <span>
                      {page} / {pages}
                    </span>
                    <Button
                      variant="outline"
                      disabled={page >= pages}
                      aria-label="下一页"
                      onClick={() => setPage((value) => value + 1)}
                    >
                      <ChevronRight />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
