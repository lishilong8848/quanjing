import { ChevronLeft, ChevronRight, Database, Info } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

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

import {
  paginateTrainingDetailRows,
  type TrainingDetail,
  type TrainingDetailValue,
} from './training-detail-model';

const DETAIL_PAGE_SIZE = 20;

function statusClassName(value: TrainingDetailValue): string {
  const text = String(value);
  if (text === '通过' || text.includes('已完成') || text === '已结束') {
    return 'training-detail-status training-detail-status-success';
  }
  if (
    text === '未通过' ||
    text === '未签到' ||
    text.includes('终止') ||
    text.includes('取消')
  ) {
    return 'training-detail-status training-detail-status-danger';
  }
  if (text === '待考核' || text.includes('计划') || text.includes('待开展')) {
    return 'training-detail-status training-detail-status-pending';
  }
  return 'training-detail-status';
}

export function TrainingDetailDialog({
  detail,
  onOpenChange,
}: {
  detail: TrainingDetail | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  const [preparedDetail, setPreparedDetail] = useState<TrainingDetail | null>(
    null,
  );
  const tableDetail = preparedDetail === detail ? preparedDetail : null;

  useEffect(() => {
    setPage(1);
    setPreparedDetail(null);
    if (!detail) return undefined;
    const timer = window.setTimeout(() => setPreparedDetail(detail), 0);
    return () => window.clearTimeout(timer);
  }, [detail]);

  const pageData = useMemo(
    () =>
      paginateTrainingDetailRows(
        tableDetail ?? { title: '', description: '' },
        page,
        DETAIL_PAGE_SIZE,
      ),
    [page, tableDetail],
  );

  return (
    <Dialog open={detail !== null} onOpenChange={onOpenChange}>
      <DialogContent className="training-detail-dialog">
        {detail ? (
          <>
            <DialogHeader className="training-detail-header">
              <DialogTitle>{detail.title}</DialogTitle>
              <DialogDescription>{detail.description}</DialogDescription>
            </DialogHeader>
            <div className="training-detail-body">
              {tableDetail ? (
                <>
                  {detail.sourceNote ? (
                    <p className="training-detail-source-note">
                      <Database aria-hidden="true" />
                      <span>{detail.sourceNote}</span>
                    </p>
                  ) : null}
                  {detail.thresholdNote ? (
                    <p className="training-detail-threshold-note">
                      <Info aria-hidden="true" />
                      <span>{detail.thresholdNote}</span>
                    </p>
                  ) : null}
                  {detail.facts?.length ? (
                    <dl className="training-detail-facts">
                      {detail.facts.map((fact) => (
                        <div key={fact.label}>
                          <dt>{fact.label}</dt>
                          <dd>{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {detail.table ? (
                    <section
                      className="training-detail-list"
                      aria-label={`${detail.title}明细清单`}
                    >
                      <div className="training-detail-list-header">
                        <strong>明细清单</strong>
                        <span>共 {detail.table.rows.length} 条</span>
                      </div>
                      {pageData.totalRows > 0 ? (
                        <>
                          <Table
                            className="training-detail-table"
                            aria-label={`${tableDetail.title}数据明细`}
                          >
                            <TableHeader>
                              <TableRow>
                                {tableDetail.table.columns.map((column) => (
                                  <TableHead key={column}>{column}</TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {pageData.rows.map((row, rowIndex) => (
                                <TableRow
                                  key={`${tableDetail.title}-${pageData.page}-${rowIndex}`}
                                >
                                  {row.map((cell, cellIndex) => {
                                    const isStatusColumn =
                                      tableDetail.table.columns[
                                        cellIndex
                                      ]?.includes('状态') ?? false;
                                    return (
                                      <TableCell
                                        key={`${rowIndex}-${cellIndex}`}
                                      >
                                        {isStatusColumn ? (
                                          <span
                                            className={statusClassName(cell)}
                                          >
                                            {cell}
                                          </span>
                                        ) : (
                                          cell
                                        )}
                                      </TableCell>
                                    );
                                  })}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          {pageData.totalPages > 1 ? (
                            <nav
                              className="training-detail-pagination"
                              aria-label="明细分页"
                            >
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={pageData.page <= 1}
                                onClick={() =>
                                  setPage((current) => Math.max(1, current - 1))
                                }
                              >
                                <ChevronLeft aria-hidden="true" />
                                上一页
                              </Button>
                              <span>
                                第 {pageData.page} / {pageData.totalPages} 页
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={pageData.page >= pageData.totalPages}
                                onClick={() =>
                                  setPage((current) =>
                                    Math.min(pageData.totalPages, current + 1),
                                  )
                                }
                              >
                                下一页
                                <ChevronRight aria-hidden="true" />
                              </Button>
                            </nav>
                          ) : null}
                        </>
                      ) : (
                        <div className="training-detail-empty" role="status">
                          <Database aria-hidden="true" />
                          <strong>暂无明细</strong>
                          <span>
                            {tableDetail.emptyMessage ??
                              '暂无符合当前统计口径的可追溯明细'}
                          </span>
                        </div>
                      )}
                    </section>
                  ) : null}
                </>
              ) : (
                <div className="training-detail-preparing" role="status">
                  正在准备明细清单…
                </div>
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
