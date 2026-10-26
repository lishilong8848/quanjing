import { useRef, useState } from 'react';
import { Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type Row = Record<string, string | number | null>;
type Series = { key: string; name: string; color?: string };
export function useChartDetails(
  rows: Row[],
  series: Series[],
  unit = '',
  title = '图表数据',
) {
  const [selected, setSelected] = useState<string | null | undefined>(
    undefined,
  );
  const [page, setPage] = useState(1);
  const fallback = useRef<HTMLButtonElement | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const open = (name: string | null = null) => {
    focus.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : fallback.current;
    setSelected(name);
    setPage(1);
  };
  const visible =
    selected === null
      ? rows
      : rows.filter((row) => String(row.name) === selected);
  const pages = Math.max(1, Math.ceil(visible.length / 12)),
    current = Math.min(page, pages);
  return {
    open,
    isOpen: selected !== undefined,
    button: (
      <Button
        ref={fallback}
        variant="ghost"
        size="sm"
        className="mo-chart-data-button"
        aria-label={`${title}：查看图表数据`}
        onClick={() => open()}
      >
        <Table2 aria-hidden="true" />
        <span>数据</span>
      </Button>
    ),
    dialog: selected !== undefined && (
      <Dialog
        open
        onOpenChange={(value) => {
          if (!value) setSelected(undefined);
        }}
      >
        <DialogContent
          className="monthly-operations mo-chart-data-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (focus.current?.isConnected
              ? focus.current
              : fallback.current
            )?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">
              所选图表对应的具体数据
            </DialogDescription>
          </DialogHeader>
          {selected !== null && (
            <strong className="mo-chart-data-period">{selected}</strong>
          )}
          <div className="mo-chart-data-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期 / 分类</TableHead>
                  {series.map((s) => (
                    <TableHead key={s.key}>
                      {s.name}
                      {unit ? `（${unit}）` : ''}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible
                  .slice((current - 1) * 12, current * 12)
                  .map((row, index) => (
                    <TableRow key={`${row.name}-${index}`}>
                      <TableCell>{row.name}</TableCell>
                      {series.map((s) => (
                        <TableCell key={s.key}>
                          {typeof row[s.key] === 'number'
                            ? (row[s.key] as number).toLocaleString('zh-CN', {
                                maximumFractionDigits: 3,
                              })
                            : (row[s.key] ?? '—')}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
            {!visible.length && <p role="status">当前筛选下暂无该数据</p>}
          </div>
          {pages > 1 && (
            <div className="mo-pagination">
              <Button
                variant="outline"
                disabled={current === 1}
                onClick={() => setPage(current - 1)}
              >
                上一页
              </Button>
              <span>
                {current} / {pages}
              </span>
              <Button
                variant="outline"
                disabled={current === pages}
                onClick={() => setPage(current + 1)}
              >
                下一页
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    ),
  };
}
