import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Search,
  X,
} from 'lucide-react';
import type { AliMonthlyQualityIssue } from '@shared/risk-inspection.interface';

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 10;

export interface MonthlyQualityIssueListSelection {
  title: string;
  description: string;
  issues: AliMonthlyQualityIssue[];
}

export function AliMonthlyQualityListDialog({
  selection,
  onClose,
  onOpenIssue,
}: {
  selection: MonthlyQualityIssueListSelection | null;
  onClose: () => void;
  onOpenIssue: (issue: AliMonthlyQualityIssue) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const issues = selection?.issues || [];
  const filteredIssues = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return issues;
    return issues.filter((issue) =>
      [
        issue.month,
        issue.building,
        issue.item,
        issue.issue,
        issue.supplemental,
        issue.responsiblePersons.map(({ name }) => name).join(' '),
      ]
        .join(' ')
        .toLocaleLowerCase('zh-CN')
        .includes(normalized),
    );
  }, [issues, query]);
  const totalPages = Math.max(1, Math.ceil(filteredIssues.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleIssues = filteredIssues.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  useEffect(() => {
    if (!selection) return;
    setQuery('');
    setPage(1);
  }, [selection]);

  return (
    <Dialog
      open={Boolean(selection)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="quality-list-dialog" showCloseButton={false}>
        <DialogHeader className="quality-dialog-header">
          <span className="quality-dialog-icon" aria-hidden="true">
            <ClipboardList />
          </span>
          <div>
            <DialogTitle>
              {selection?.title || '阿里月度质量问题清单'}
            </DialogTitle>
            <DialogDescription>
              {selection?.description || '当前筛选口径的问题明细'} · 共{' '}
              {issues.length} 条
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="quality-dialog-close"
              aria-label="关闭阿里月度质量问题清单"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <label className="quality-dialog-search">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索月度质量问题</span>
          <Input
            type="search"
            value={query}
            placeholder="搜索月份、楼栋、检查项目或问题"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(1);
            }}
          />
        </label>

        <div className="quality-dialog-table-wrap">
          <Table className="quality-dialog-table">
            <TableHeader>
              <TableRow>
                <TableHead>月份</TableHead>
                <TableHead>楼栋</TableHead>
                <TableHead>检查项目</TableHead>
                <TableHead>问题</TableHead>
                <TableHead>问题补充描述</TableHead>
                <TableHead>涉及人员</TableHead>
                <TableHead>附件/图片</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleIssues.length > 0 ? (
                visibleIssues.map((issue) => (
                  <TableRow className="quality-dialog-row" key={issue.id}>
                    <TableCell>{issue.month}</TableCell>
                    <TableCell>
                      <span className="quality-building-pill">
                        {issue.building}
                      </span>
                    </TableCell>
                    <TableCell>{issue.item}</TableCell>
                    <TableCell
                      className="quality-dialog-issue"
                      title={issue.issue}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onOpenIssue(issue)}
                        aria-label={`查看详情：${issue.issue}`}
                      >
                        {issue.issue}
                      </Button>
                    </TableCell>
                    <TableCell title={issue.supplemental || '未填写'}>
                      {issue.supplemental || '未填写'}
                    </TableCell>
                    <TableCell>
                      {issue.responsiblePersons.length > 0
                        ? issue.responsiblePersons
                            .map(({ name }) => name)
                            .join('、')
                        : issue.personMatchStatus === 'ambiguous'
                          ? '待人工确认'
                          : '—'}
                    </TableCell>
                    <TableCell>
                      {issue.attachments.length} / {issue.images.length}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="quality-empty-cell">
                    当前筛选结果暂无问题
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="quality-dialog-pagination">
          <span>
            {filteredIssues.length} 条 · {currentPage}/{totalPages} 页
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={currentPage === 1}
            aria-label="上一页"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={currentPage === totalPages}
            aria-label="下一页"
            onClick={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
          >
            <ChevronRight />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
