import {
  Fragment,
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
  AliRiskInspectionDashboard,
  AliRiskIssue,
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
  getAliRectificationStats,
  paginateRiskIssues,
  selectAliMetricIssues,
  type AliMetricListKey,
} from './model';
import { filterIssueList, groupIssueList, issueOwners, type IssueListFilters, type IssueListGroup } from './issue-list-model';
import './issue-list-filters.css';

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export interface AliIssueListSelection {
  title: string;
  description: string;
  issues: AliRiskIssue[];
}

interface RiskMetricListDialogProps {
  dashboard: AliRiskInspectionDashboard | null;
  metricKey: AliMetricListKey | null;
  selection: AliIssueListSelection | null;
  title: string;
  description: string;
  onClose: () => void;
  onOpenIssue: (issue: AliRiskIssue) => void;
}

export function RiskMetricListDialog({
  dashboard,
  metricKey,
  selection,
  title,
  description,
  onClose,
  onOpenIssue,
}: RiskMetricListDialogProps) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<IssueListFilters>({});
  const [groupBy, setGroupBy] = useState<IssueListGroup>('none');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] =
    useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [pendingIssue, setPendingIssue] = useState<AliRiskIssue | null>(null);
  const openIssueFrameRef = useRef<number | null>(null);

  const metricIssues = useMemo(
    () =>
      selection?.issues ||
      (dashboard && metricKey
        ? selectAliMetricIssues(dashboard, metricKey)
        : []),
    [dashboard, metricKey, selection],
  );
  const filteredIssues = useMemo(
    () => filterIssueList(metricIssues, filters, query),
    [metricIssues, filters, query],
  );
  const groups = useMemo(() => groupIssueList(filteredIssues, groupBy), [filteredIssues, groupBy]);
  const sortedIssues = useMemo(() => groups.flatMap(group => group.issues), [groups]);
  const filterOptions = useMemo(() => ({
    building: [...new Set(metricIssues.map(issue => issue.building).filter(Boolean))].sort(),
    owner: [...new Set(metricIssues.flatMap(issue => issueOwners(issue.owner)).filter(name => name !== '—'))].sort(),
    specialty: [...new Set(metricIssues.map(issue => issue.specialty).filter(Boolean))].sort(),
    status: [...new Set(metricIssues.map(issue => issue.status))],
  }), [metricIssues]);
  const rectificationStats = useMemo(
    () => getAliRectificationStats(dashboard?.issues || []),
    [dashboard],
  );
  const totalPages = Math.max(1, Math.ceil(filteredIssues.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageNumbers = getPaginationWindow(currentPage, totalPages);
  const visibleIssues = paginateRiskIssues(
    sortedIssues,
    currentPage,
    pageSize,
  );
  const visibleIds = new Set(visibleIssues.map(issue => issue.id));
  const visibleGroups = groups.map(group => ({...group, issues: group.issues.filter(issue => visibleIds.has(issue.id))})).filter(group => group.issues.length);
  const normalizedQuery = query.trim();
  const dialogTitle = selection?.title || title;
  const dialogDescription = selection?.description || description;
  const isRectificationMetric = !selection && metricKey === 'rectificationRate';

  useEffect(() => {
    if (!metricKey && !selection) return;

    setQuery('');
    setFilters({});
    setGroupBy('none');
    setCollapsed(new Set());
    setPage(1);
  }, [metricKey, selection]);

  useEffect(() => {
    if (!metricKey && !selection) return;

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

  const handleSearch = (value: string) => {
    setQuery(value);
    setPage(1);
  };

  const selectIssue = (issue: AliRiskIssue) => {
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
      ? isRectificationMetric && rectificationStats.eligible === 0
        ? {
            title: '本期无纳入整改完成率计算的问题',
            description: '当前没有“整改中”或“已完成”的问题记录。',
          }
        : {
            title: `暂无符合“${dialogTitle}”口径的问题`,
            description: '数据同步后，符合当前统计口径的问题将在此显示。',
          }
      : metricIssues.length > 0 && filteredIssues.length === 0
        ? {
            title: '未找到匹配的问题',
            description: '请调整关键词，或清空搜索条件后重试。',
          }
        : {
            title: `暂无符合“${dialogTitle}”口径的问题`,
            description: '数据同步后，符合当前统计口径的问题将在此显示。',
          };

  return (
    <Dialog
      open={Boolean(dashboard && (metricKey || selection))}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="risk-metric-list-dialog risk-ali-list-dialog"
        showCloseButton={false}
        onAnimationEnd={handleExitAnimationEnd}
      >
        <DialogHeader className="risk-metric-list-header">
          <span className="risk-metric-list-icon" aria-hidden="true">
            <ClipboardList />
          </span>
          <div>
            <DialogTitle>{dialogTitle || '风险问题清单'}</DialogTitle>
            <DialogDescription>
              {isRectificationMetric
                ? `已完成 ${rectificationStats.completed} / 纳入口径 ${rectificationStats.eligible} · 完成率 ${rectificationStats.rate}%`
                : `共 ${metricIssues.length} 条 · ${dashboard?.month || '—'} · ${dialogDescription}`}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`关闭${dialogTitle || '风险问题清单'}`}
              className="risk-metric-list-close"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="risk-metric-list-toolbar">
          <label className="risk-metric-list-search">
            <Search aria-hidden="true" />
            <span className="sr-only">搜索风险问题</span>
            <Input
              type="search"
              value={query}
              placeholder="搜索描述、楼栋、专业、责任人、日期或状态"
              onChange={(event) => handleSearch(event.currentTarget.value)}
            />
          </label>
          <span>
            {normalizedQuery
              ? `找到 ${filteredIssues.length} 条`
              : `当前清单 ${metricIssues.length} 条`}
          </span>
        </div>

        <div className="risk-issue-filterbar">
          {(['building', 'owner', 'specialty', 'status'] as const).map(key => {
            const label = {building:'楼栋', owner:'现场跟进人', specialty:'专业', status:'处置状态'}[key];
            return <Select key={key} value={filters[key] || '__all__'} onValueChange={value => {
              setFilters(current => ({...current, [key]:value === '__all__' ? '' : value}));
              setPage(1); setCollapsed(new Set());
            }}>
              <SelectTrigger aria-label={`筛选${label}`}><SelectValue placeholder={label} /></SelectTrigger>
              <SelectContent><SelectItem value="__all__">全部{label}</SelectItem>
                {filterOptions[key].map(value => <SelectItem key={value} value={value}>{key === 'status' ? metricIssues.find(issue => issue.status === value)?.statusLabel || value : value}</SelectItem>)}
              </SelectContent>
            </Select>;
          })}
          <Select value={groupBy} onValueChange={value => {setGroupBy(value as IssueListGroup); setPage(1); setCollapsed(new Set());}}>
            <SelectTrigger aria-label="问题分组"><SelectValue /></SelectTrigger>
            <SelectContent>{(['none','building','owner','specialty','status'] as const).map(value =>
              <SelectItem key={value} value={value}>{{none:'不分组',building:'按楼栋分组',owner:'按现场跟进人分组',specialty:'按专业分组',status:'按状态分组'}[value]}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" onClick={() => {setFilters({});setQuery('');setGroupBy('none');setPage(1);setCollapsed(new Set());}}>重置</Button>
          <span className="risk-issue-filter-count">筛选后 {filteredIssues.length} 条</span>
        </div>

        <div className="risk-metric-list-table-wrap">
          <Table className="risk-metric-list-table risk-ali-grouped-table">
            <TableHeader>
              <TableRow>
                <TableHead>风险等级</TableHead>
                <TableHead>专业</TableHead>
                <TableHead>楼栋</TableHead>
                <TableHead>问题描述</TableHead>
                <TableHead>发现日期</TableHead>
                <TableHead>截止日期</TableHead>
                <TableHead>闭环日期</TableHead>
                <TableHead>现场跟进人</TableHead>
                <TableHead>处置状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleIssues.length ? (
                visibleGroups.map(group => <Fragment key={group.label}>
                  {groupBy !== 'none' && <TableRow className="risk-issue-group-row"><TableCell colSpan={9}>
                    <Button variant="ghost" aria-expanded={!collapsed.has(group.label)} onClick={() => setCollapsed(current => {
                      const next = new Set(current); if(next.has(group.label)) next.delete(group.label); else next.add(group.label); return next;
                    })}>{collapsed.has(group.label) ? '展开' : '收起'} · {group.label} <Badge variant="secondary">{groups.find(item => item.label === group.label)?.issues.length || 0} 条</Badge></Button>
                  </TableCell></TableRow>}
                  {!collapsed.has(group.label) && group.issues.map((issue) => (
                  <TableRow
                    className="risk-metric-list-row"
                    key={issue.id}
                    onClick={() => selectIssue(issue)}
                  >
                    <TableCell>
                      <Badge
                        className={`risk-level-badge risk-level-${issue.level}`}
                      >
                        {issue.levelLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="risk-specialty">
                      {issue.specialty || '—'}
                    </TableCell>
                    <TableCell>{issue.building || '—'}</TableCell>
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
                    <TableCell>{issue.discoveredAt || '—'}</TableCell>
                    <TableCell>{issue.dueAt || '—'}</TableCell>
                    <TableCell>{issue.closedAt || '—'}</TableCell>
                    <TableCell>{issue.owner || '—'}</TableCell>
                    <TableCell>
                      <div className="risk-metric-list-status">
                        <Badge
                          className={`risk-status-badge risk-status-${issue.status}`}
                        >
                          {issue.statusLabel}
                        </Badge>
                        {issue.overdueDays > 0 ? (
                          <Badge className="risk-overdue-badge">
                            已逾期 {issue.overdueDays} 天
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}</Fragment>)
              ) : (
                <TableRow>
                  <TableCell colSpan={9} className="risk-metric-list-empty">
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
