import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Search,
  X,
} from 'lucide-react';
import type {
  CrossInspectionDashboard,
  CrossInspectionIssue,
  CrossRectificationStatus,
} from '@shared/risk-inspection.interface';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

import { getPaginationWindow } from './dashboard-model';
import {
  filterCrossMetricIssues,
  selectCrossMetricIssues,
  type CrossMetricListKey,
} from './model';

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

const STATUS_LABELS: Record<CrossRectificationStatus, string> = {
  closed: '已整改',
  pending: '待整改',
  unresolved: '未解决',
  verification: '待验收',
};

export interface CrossIssueListSelection {
  title: string;
  description: string;
  issues: CrossInspectionIssue[];
}

interface CrossIssueListDialogProps {
  dashboard: CrossInspectionDashboard | null;
  metricKey: CrossMetricListKey | null;
  selection: CrossIssueListSelection | null;
  title: string;
  description: string;
  onClose: () => void;
  onOpenIssue: (issue: CrossInspectionIssue) => void;
}

export function CrossIssueListDialog({
  dashboard,
  metricKey,
  selection,
  title,
  description,
  onClose,
  onOpenIssue,
}: CrossIssueListDialogProps) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] =
    useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [pendingIssue, setPendingIssue] = useState<CrossInspectionIssue | null>(
    null,
  );
  const openIssueFrameRef = useRef<number | null>(null);

  const metricIssues = useMemo(
    () =>
      selection?.issues ||
      (dashboard && metricKey
        ? selectCrossMetricIssues(dashboard, metricKey)
        : []),
    [dashboard, metricKey, selection],
  );
  const filteredIssues = useMemo(
    () => filterCrossMetricIssues(metricIssues, query),
    [metricIssues, query],
  );
  const totalPages = Math.max(1, Math.ceil(filteredIssues.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageNumbers = getPaginationWindow(currentPage, totalPages);
  const visibleIssues = filteredIssues.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const dialogTitle = selection?.title || title;
  const dialogDescription = selection?.description || description;
  const metricScope =
    metricKey === 'monthlyTotal'
      ? dashboard?.selectedMonth
      : metricKey === 'legacyTotal'
        ? `${dashboard?.selectedMonth || '当前月份'}之前`
        : metricKey
          ? '全部月份'
          : dashboard?.selectedMonth || '全部月份';
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (!metricKey && !selection) return;

    setQuery('');
    setPage(1);
    setPendingIssue(null);
    if (openIssueFrameRef.current !== null) {
      window.cancelAnimationFrame(openIssueFrameRef.current);
      openIssueFrameRef.current = null;
    }
  }, [metricKey, selection]);

  useEffect(
    () => () => {
      if (openIssueFrameRef.current !== null) {
        window.cancelAnimationFrame(openIssueFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const selectIssue = (issue: CrossInspectionIssue) => {
    setPendingIssue(issue);
    onClose();
  };

  const handleExitAnimationEnd = (
    event: ReactAnimationEvent<HTMLDivElement>,
  ) => {
    if (
      event.target !== event.currentTarget ||
      event.currentTarget.dataset.state !== 'closed' ||
      !pendingIssue
    ) {
      return;
    }

    const issue = pendingIssue;
    setPendingIssue(null);
    if (openIssueFrameRef.current !== null) {
      window.cancelAnimationFrame(openIssueFrameRef.current);
    }
    openIssueFrameRef.current = window.requestAnimationFrame(() => {
      openIssueFrameRef.current = null;
      onOpenIssue(issue);
    });
  };

  const emptyState =
    metricIssues.length === 0
      ? {
          title: `暂无符合“${dialogTitle}”口径的问题`,
          description: '数据同步后，符合当前统计口径的问题将在此显示。',
        }
      : {
          title: '未找到匹配的问题',
          description: '请调整关键词，或清空搜索条件后重试。',
        };

  return (
    <Dialog
      open={Boolean(dashboard && (metricKey || selection))}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="risk-metric-list-dialog risk-cross-list-dialog"
        showCloseButton={false}
        onAnimationEnd={handleExitAnimationEnd}
      >
        <DialogHeader className="risk-metric-list-header">
          <span className="risk-metric-list-icon" aria-hidden="true">
            <ClipboardList />
          </span>
          <div>
            <DialogTitle>{dialogTitle || '交叉互查问题清单'}</DialogTitle>
            <DialogDescription>
              共 {metricIssues.length} 条 · {metricScope} · {dialogDescription}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`关闭${dialogTitle || '交叉互查问题清单'}`}
              className="risk-metric-list-close"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="risk-metric-list-toolbar">
          <label className="risk-metric-list-search">
            <Search aria-hidden="true" />
            <span className="sr-only">搜索交叉互查问题</span>
            <Input
              type="search"
              value={query}
              placeholder="搜索楼栋、月份、标签、类型、问题、提出人或整改情况"
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setPage(1);
              }}
            />
          </label>
          <span>
            {normalizedQuery
              ? `找到 ${filteredIssues.length} 条`
              : `当前清单 ${metricIssues.length} 条`}
          </span>
        </div>

        <div className="risk-metric-list-table-wrap">
          <Table className="risk-metric-list-table risk-cross-list-table">
            <TableHeader>
              <TableRow>
                <TableHead>楼栋</TableHead>
                <TableHead>月份</TableHead>
                <TableHead>检查范围</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>问题描述</TableHead>
                <TableHead>问题提出人</TableHead>
                <TableHead>整改情况</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleIssues.length ? (
                visibleIssues.map((issue) => (
                  <TableRow
                    className="risk-metric-list-row"
                    key={issue.id}
                    onClick={() => selectIssue(issue)}
                  >
                    <TableCell>{`南通${issue.building}`}</TableCell>
                    <TableCell>{issue.month || '—'}</TableCell>
                    <TableCell>
                      <Badge className="risk-cross-badge risk-cross-badge-blue">
                        {issue.tag || '其他'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className="risk-cross-badge risk-cross-badge-cyan">
                        {issue.type || '其他'}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="risk-metric-list-description"
                      title={issue.description}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        className="risk-metric-list-description-button"
                        aria-label={`查看详情：${issue.description}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectIssue(issue);
                        }}
                      >
                        <span>{issue.description || '—'}</span>
                      </Button>
                    </TableCell>
                    <TableCell>{issue.owner || '—'}</TableCell>
                    <TableCell>
                      <Badge
                        className={`risk-cross-badge risk-cross-badge-${issue.status}`}
                      >
                        {issue.rectification || STATUS_LABELS[issue.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="risk-metric-list-empty">
                    <strong>{emptyState.title}</strong>
                    <span>{emptyState.description}</span>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="risk-metric-list-pagination">
          <span>
            共 {filteredIssues.length} 条 · 第 {currentPage} / {totalPages} 页
          </span>
          <div>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="上一页"
              disabled={currentPage === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            {pageNumbers.map((pageNumber) => (
              <Button
                type="button"
                key={pageNumber}
                variant={pageNumber === currentPage ? 'default' : 'ghost'}
                size="icon-xs"
                aria-label={`第 ${pageNumber} 页`}
                aria-current={pageNumber === currentPage ? 'page' : undefined}
                onClick={() => setPage(pageNumber)}
              >
                {pageNumber}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="下一页"
              disabled={currentPage === totalPages}
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              <ChevronRight aria-hidden="true" />
            </Button>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(
                  Number(value) as (typeof PAGE_SIZE_OPTIONS)[number],
                );
                setPage(1);
              }}
            >
              <SelectTrigger
                className="risk-metric-list-page-size"
                aria-label="每页显示条数"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <SelectItem value={String(option)} key={option}>
                    {option} 条/页
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
