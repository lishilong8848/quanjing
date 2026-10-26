import { useEffect, useMemo, useState } from 'react';
import {
  BookOpenCheck,
  ChevronLeft,
  ChevronRight,
  Search,
  UserRound,
} from 'lucide-react';
import {
  Area,
  Bar,
  ComposedChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  CrossBuildingRectification,
  CrossInspectionDashboard,
  CrossRectificationStatus,
} from '@shared/risk-inspection.interface';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

import { createCrossIssueDetail, type RiskDetailPayload } from './detail-model';
import { CrossInspectionGuideDialog } from './CrossInspectionGuideDialog';
import type { CrossIssueListSelection } from './CrossIssueListDialog';
import {
  buildCrossBuildingRectification,
  filterCrossLedgerIssues,
  getDefaultCrossOverviewMonth,
  getPaginationWindow,
} from './dashboard-model';

interface CrossInspectionViewProps {
  data: CrossInspectionDashboard;
  onOpenDetail: (detail: RiskDetailPayload) => void;
  onOpenIssueList: (selection: CrossIssueListSelection) => void;
}

type BadgeTone = 'blue' | 'cyan' | 'danger' | 'indigo' | 'success' | 'warning';

const STATUS_LABELS: Record<CrossRectificationStatus, string> = {
  closed: '已整改',
  pending: '待整改',
  unresolved: '未解决',
  verification: '待验收',
};

function toneForTag(tag: string): BadgeTone {
  if (/(消防|火灾|疏散)/u.test(tag)) return 'danger';
  if (/(电|用电|配电)/u.test(tag)) return 'warning';
  if (/(设备|运行|接地)/u.test(tag)) return 'success';
  if (/(环境|卫生)/u.test(tag)) return 'cyan';
  if (/(标识|编号)/u.test(tag)) return 'indigo';
  return 'blue';
}

function CrossBadge({
  children,
  tone,
  className,
  title,
}: {
  children: string;
  tone: BadgeTone | CrossRectificationStatus;
  className?: string;
  title?: string;
}) {
  return (
    <Badge
      className={`risk-cross-badge risk-cross-badge-${tone}${
        className ? ` ${className}` : ''
      }`}
      title={title}
    >
      {children}
    </Badge>
  );
}

function CrossPanelHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="risk-cross-panel-header">
      <div className="risk-panel-title-row">
        <div className="risk-panel-title-mark" aria-hidden="true" />
        <div>
          <h2>{title}</h2>
          {description ? <span>{description}</span> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

function CrossSearch({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="risk-cross-search" role="search">
      <Search aria-hidden="true" />
      <Input
        value={value}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function CrossRectificationChart({
  data,
  onOpenIssueList,
}: Pick<CrossInspectionViewProps, 'data' | 'onOpenIssueList'>) {
  const [overviewMonth, setOverviewMonth] = useState(() =>
    getDefaultCrossOverviewMonth(data.options.months, data.selectedMonth),
  );
  const [guideOpen, setGuideOpen] = useState(false);
  const chartData = useMemo(
    () => buildCrossBuildingRectification(data.issues, overviewMonth),
    [data.issues, overviewMonth],
  );

  useEffect(() => {
    setOverviewMonth((current) =>
      data.options.months.includes(current)
        ? current
        : getDefaultCrossOverviewMonth(data.options.months, data.selectedMonth),
    );
  }, [data.options.months, data.selectedMonth]);

  const openBuildingIssueList = (item: CrossBuildingRectification) => {
    const issues = data.issues.filter(
      (issue) =>
        issue.month === overviewMonth && issue.building === item.building,
    );
    onOpenIssueList({
      title: `${item.building} · 问题清单`,
      description: `${overviewMonth}楼栋问题与销项情况`,
      issues,
    });
  };
  return (
    <>
      <Card className="risk-panel risk-cross-chart-panel">
        <CardContent>
          <CrossPanelHeader
            title="互查问题一览"
            description={`按${overviewMonth}楼栋统计`}
            action={
              <div className="risk-cross-overview-actions">
                <Select value={overviewMonth} onValueChange={setOverviewMonth}>
                  <SelectTrigger aria-label="互查问题月份">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.options.months.map((option) => (
                      <SelectItem value={option} key={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="risk-cross-guide-button"
                  aria-label="查看互查互纠标准与指引"
                  onClick={() => setGuideOpen(true)}
                >
                  <BookOpenCheck aria-hidden="true" />
                  标准指引
                </Button>
                <div className="risk-cross-chart-legend" aria-label="图例">
                  <span>
                    <i className="risk-cross-legend-bar" />
                    问题数量
                  </span>
                  <span>
                    <i className="risk-cross-legend-line" />
                    销项率
                  </span>
                </div>
              </div>
            }
          />
          <div
            className="risk-cross-chart"
            role="img"
            aria-label="各楼栋问题数量与销项率组合图"
          >
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 28, right: 28, bottom: 0, left: 28 }}
                >
                  <defs>
                    <linearGradient
                      id="risk-cross-bar-fill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#2f7cf5" />
                      <stop offset="100%" stopColor="#9fc9ff" />
                    </linearGradient>
                    <linearGradient
                      id="risk-cross-rate-area-fill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor="#fb923c"
                        stopOpacity={0.28}
                      />
                      <stop
                        offset="100%"
                        stopColor="#fed7aa"
                        stopOpacity={0.04}
                      />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="building"
                    axisLine={{ stroke: '#d7e2ef' }}
                    tickLine={false}
                    tick={{ fill: '#274467', fontSize: 12, fontWeight: 650 }}
                  />
                  <YAxis yAxisId="count" domain={[0, 20]} hide />
                  <YAxis yAxisId="rate" domain={[-50, 112]} hide />
                  <Tooltip
                    formatter={(value, name) => [
                      name === '销项率' ? `${value}%` : `${value} 个`,
                      name,
                    ]}
                    contentStyle={{
                      border: '1px solid #d7e2ef',
                      borderRadius: 8,
                      boxShadow: '0 8px 22px rgba(40, 68, 110, 0.12)',
                      fontSize: 12,
                    }}
                  />
                  <Area
                    yAxisId="rate"
                    type="monotone"
                    dataKey="rate"
                    name="销项率"
                    baseValue={54}
                    stroke="#f97316"
                    strokeWidth={2.5}
                    fill="url(#risk-cross-rate-area-fill)"
                    fillOpacity={1}
                    dot={{ r: 4, fill: '#ffffff', strokeWidth: 2.5 }}
                    activeDot={{ r: 5 }}
                    onClick={(entry) => {
                      const item = (
                        entry as { payload?: CrossBuildingRectification }
                      ).payload;
                      if (item) {
                        openBuildingIssueList(item);
                      }
                    }}
                  >
                    <LabelList
                      dataKey="rate"
                      position="top"
                      formatter={(value) => `${value}%`}
                      fill="#ea580c"
                      fontSize={11}
                      fontWeight={700}
                    />
                  </Area>
                  <Bar
                    yAxisId="count"
                    dataKey="issueCount"
                    name="问题数量"
                    fill="url(#risk-cross-bar-fill)"
                    radius={[5, 5, 0, 0]}
                    maxBarSize={42}
                    onClick={(entry) => {
                      const item = (
                        entry as { payload?: CrossBuildingRectification }
                      ).payload;
                      if (item) {
                        openBuildingIssueList(item);
                      }
                    }}
                  >
                    <LabelList
                      dataKey="issueCount"
                      position="top"
                      fill="#18345c"
                      fontSize={12}
                      fontWeight={700}
                    />
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="risk-cross-empty">
                {overviewMonth}暂无楼栋互查问题
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      <CrossInspectionGuideDialog
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
      />
    </>
  );
}

function LegacyIssuePanel({ data, onOpenDetail }: CrossInspectionViewProps) {
  const [query, setQuery] = useState('');
  const issues = useMemo(
    () =>
      data.legacyIssues
        .filter((issue) => issue.description.includes(query.trim()))
        .slice(0, 4),
    [data.legacyIssues, query],
  );

  return (
    <Card className="risk-panel risk-cross-legacy-panel">
      <CardContent>
        <CrossPanelHeader
          title="历史遗留问题"
          action={
            <CrossSearch
              value={query}
              placeholder="搜索问题描述"
              onChange={setQuery}
            />
          }
        />
        <div className="risk-cross-table-wrap risk-cross-legacy-table-wrap">
          <Table className="risk-cross-table risk-cross-legacy-table">
            <TableHeader>
              <TableRow>
                <TableHead>楼栋</TableHead>
                <TableHead>月份</TableHead>
                <TableHead>标签</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>问题描述</TableHead>
                <TableHead>整改情况</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.length > 0 ? (
                issues.map((issue) => (
                  <TableRow
                    className="risk-clickable risk-data-row"
                    key={issue.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看交叉互查问题：${issue.description}`}
                    onClick={() => onOpenDetail(createCrossIssueDetail(issue))}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onOpenDetail(createCrossIssueDetail(issue));
                    }}
                  >
                    <TableCell>{`南通${issue.building}`}</TableCell>
                    <TableCell>{issue.month}</TableCell>
                    <TableCell>
                      <CrossBadge
                        tone={toneForTag(issue.tag)}
                        className="risk-cross-tag-badge"
                        title={issue.tag}
                      >
                        {issue.tag}
                      </CrossBadge>
                    </TableCell>
                    <TableCell>
                      <CrossBadge tone="blue">{issue.type}</CrossBadge>
                    </TableCell>
                    <TableCell className="risk-cross-description">
                      {issue.description}
                    </TableCell>
                    <TableCell>
                      <CrossBadge tone={issue.status}>
                        {STATUS_LABELS[issue.status]}
                      </CrossBadge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="risk-cross-empty">
                    <div className="risk-cross-empty-state">
                      <strong>
                        {query.trim()
                          ? '未找到匹配的历史遗留问题'
                          : '暂无历史遗留未解决问题'}
                      </strong>
                      <span>
                        {query.trim()
                          ? '请尝试调整搜索关键词'
                          : '历史问题均已完成整改闭环'}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function RiskLedgerPanel({ data, onOpenDetail }: CrossInspectionViewProps) {
  const [building, setBuilding] = useState('all');
  const [month, setMonth] = useState('all');
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 8;
  const issues = useMemo(
    () =>
      filterCrossLedgerIssues(data.issues, {
        building,
        month,
        type,
        query,
      }),
    [building, data.issues, month, query, type],
  );
  const totalPages = Math.max(1, Math.ceil(issues.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageNumbers = getPaginationWindow(currentPage, totalPages);
  const visibleIssues = issues.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  useEffect(() => {
    setPage(1);
  }, [building, month, query, type]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  return (
    <Card className="risk-panel risk-cross-ledger-panel">
      <CardContent>
        <CrossPanelHeader
          title="风险台账"
          action={
            <div
              className="risk-cross-ledger-filters"
              role="group"
              aria-label="风险台账筛选条件"
            >
              <Select value={building} onValueChange={setBuilding}>
                <SelectTrigger aria-label="楼栋筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部楼栋</SelectItem>
                  {data.options.buildings.map((option) => (
                    <SelectItem value={option} key={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger aria-label="月份筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部月份</SelectItem>
                  {data.options.months.map((option) => (
                    <SelectItem value={option} key={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger aria-label="类型筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  {data.options.types.map((option) => (
                    <SelectItem value={option} key={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <CrossSearch
                value={query}
                placeholder="搜索问题或提出人"
                onChange={setQuery}
              />
            </div>
          }
        />
        <div className="risk-cross-table-wrap risk-cross-ledger-table-wrap">
          <Table className="risk-cross-table risk-cross-ledger-table">
            <TableHeader>
              <TableRow>
                <TableHead>楼栋</TableHead>
                <TableHead>月份</TableHead>
                <TableHead>标签</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>问题</TableHead>
                <TableHead>问题提出人</TableHead>
                <TableHead>整改情况</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleIssues.length > 0 ? (
                visibleIssues.map((issue) => (
                  <TableRow
                    className="risk-clickable risk-data-row"
                    key={issue.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看交叉互查问题：${issue.description}`}
                    onClick={() => onOpenDetail(createCrossIssueDetail(issue))}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onOpenDetail(createCrossIssueDetail(issue));
                    }}
                  >
                    <TableCell>{`南通${issue.building}`}</TableCell>
                    <TableCell>{issue.month}</TableCell>
                    <TableCell>
                      <CrossBadge
                        tone={toneForTag(issue.tag)}
                        className="risk-cross-tag-badge"
                        title={issue.tag}
                      >
                        {issue.tag}
                      </CrossBadge>
                    </TableCell>
                    <TableCell>
                      <CrossBadge tone="blue">{issue.type}</CrossBadge>
                    </TableCell>
                    <TableCell className="risk-cross-description">
                      {issue.description}
                    </TableCell>
                    <TableCell>
                      <span className="risk-cross-owner">
                        <UserRound aria-hidden="true" />
                        {issue.owner}
                      </span>
                    </TableCell>
                    <TableCell>
                      <CrossBadge tone={issue.status}>
                        {STATUS_LABELS[issue.status]}
                      </CrossBadge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="risk-cross-empty">
                    当前筛选条件下暂无风险台账记录
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="risk-cross-ledger-pagination">
          <span>共 {issues.length} 条</span>
          <div>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="上一页"
              disabled={currentPage === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft />
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
              <ChevronRight />
            </Button>
            <span className="risk-page-size-static">8 条/页</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CrossInspectionView(props: CrossInspectionViewProps) {
  return (
    <section
      className="risk-cross-dashboard-body"
      aria-label="现场交叉互查互纠"
    >
      <CrossRectificationChart
        data={props.data}
        onOpenIssueList={props.onOpenIssueList}
      />
      <LegacyIssuePanel {...props} />
      <RiskLedgerPanel {...props} />
    </section>
  );
}
