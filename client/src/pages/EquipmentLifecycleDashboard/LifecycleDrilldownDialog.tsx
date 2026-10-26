import { ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogFooter,
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

import type { LifecycleDrilldownResult } from './model';

function getStatusTone(status: string): string {
  if (status === '过保' || status === '到期') return 'is-danger';
  if (status === '三月预警' || status === '待评估') return 'is-warning';
  if (status === '在保' || status === '未到期') return 'is-success';
  return 'is-muted';
}

export function LifecycleDrilldownDialog({
  result,
  onOpenChange,
}: {
  result: LifecycleDrilldownResult | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!result) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="lifecycle-drilldown-dialog" showCloseButton={false}>
        <DialogHeader>
          <div className="lifecycle-drilldown-heading">
            <span aria-hidden="true">
              <ListFilter />
            </span>
            <div>
              <DialogTitle>{result.title}</DialogTitle>
              <DialogDescription className="sr-only">{result.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="lifecycle-drilldown-summary" aria-live="polite">
          <span>清单结果</span>
          <strong>{result.rows.length.toLocaleString()} 条</strong>
        </div>

        <div className="lifecycle-drilldown-scroll">
          <Table
            className="lifecycle-drilldown-table"
            aria-label={`${result.title}清单`}
          >
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>描述</TableHead>
                <TableHead>楼栋</TableHead>
                <TableHead>专业</TableHead>
                <TableHead>负责人</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>关键日期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.length > 0 ? (
                result.rows.map((row) => (
                  <TableRow key={`${row.source}-${row.id}`}>
                    <TableCell className="lifecycle-drilldown-name">
                      {row.name || '—'}
                    </TableCell>
                    <TableCell title={row.description}>
                      {row.description || '—'}
                    </TableCell>
                    <TableCell>{row.building || '—'}</TableCell>
                    <TableCell>{row.specialty || '—'}</TableCell>
                    <TableCell>{row.owner || '—'}</TableCell>
                    <TableCell>
                      <span
                        className={`lifecycle-drilldown-status ${getStatusTone(row.status)}`}
                      >
                        {row.status || '未填写'}
                      </span>
                    </TableCell>
                    <TableCell>{row.dueDate || '—'}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="lifecycle-drilldown-empty"
                  >
                    暂无匹配清单
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
