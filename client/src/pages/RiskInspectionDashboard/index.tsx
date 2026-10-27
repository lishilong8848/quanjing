import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  ClipboardCheck,
  Clock3,
  LayoutDashboard,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Shuffle,
} from 'lucide-react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  type PieLabelRenderProps,
} from 'recharts';
import { getGlobalNavigationViewportHeight } from '@/navigation/global-navigation-layout';
import type {
  AliMonthlyQualityDataset,
  AliRiskInspectionDashboard,
  AliRiskIssue,
  AliRiskLevel,
  AliRiskStatus,
  CrossInspectionDashboard,
  RiskDistributionItem,
} from '@shared/risk-inspection.interface';

import {
  getAliMonthlyQualityDataset,
  getRiskInspectionAliDashboard,
  getRiskInspectionCrossDashboard,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  DEFAULT_RISK_FILTERS,
  getAliRectificationStats,
  getRiskDashboardView,
  paginateRiskIssues,
  selectAliChartIssues,
  selectAliMetricIssues,
  type AliMetricListKey,
  type CrossMetricListKey,
  type RiskDashboardFilters,
} from './model';
import { CrossInspectionView } from './CrossInspectionView';
import { AliMonthlyQualityView } from './AliMonthlyQualityView';
import {
  CrossIssueListDialog,
  type CrossIssueListSelection,
} from './CrossIssueListDialog';
import {
  formatRiskTrendPeriod,
  getInnerDonutLabelLayout,
  getOuterDonutLabelLayout,
  getSeverityColor,
  getSeverityLabelColor,
  getStableDonutLabelIndex,
  getStatusColor,
  getTrendPointLabelLayout,
  RISK_DONUT_GEOMETRY,
} from './chart-layout';
import {
  createAliIssueDetail,
  createCrossIssueDetail,
  type RiskDetailPayload,
} from './detail-model';
import { RiskDetailDialog } from './RiskDetailDialog';
import {
  RiskMetricListDialog,
  type AliIssueListSelection,
} from './RiskMetricListDialog';

import './styles.css';

const STAGE_WIDTH = 1600;
const STAGE_HEIGHT = 900;
const QUALITY_COMPACT_BREAKPOINT = 720;

type DashboardView = 'inspection' | 'cross-inspection' | 'monthly-quality';
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface RiskInspectionDashboardProps {
  standaloneQuality?: boolean;
}

const METRICS = [
  {
    key: 'historyTotal',
    label: '历史问题总计',
    icon: ShieldCheck,
    tone: 'blue',
    description: '累计纳入现场风险检查台账的问题总数',
  },
  {
    key: 'unclosed',
    label: '未闭环问题',
    icon: Clock3,
    tone: 'warning',
    description: '当前筛选范围内尚未完成闭环的问题',
  },
  {
    key: 'overdueUnclosed',
    label: '延期未闭环',
    icon: AlertTriangle,
    tone: 'danger',
    description: '已超过计划截止日期且尚未完成闭环的问题数量',
  },
  {
    key: 'monthlyAdded',
    label: '本月新增问题',
    icon: ClipboardList,
    tone: 'cyan',
    description: '统计月份内新发现并录入台账的问题数量',
  },
  {
    key: 'rectificationRate',
    label: '整改完成率',
    icon: CheckCircle2,
    tone: 'success',
    description: '已完成问题占已完成与整改中问题的比例',
  },
  {
    key: 'monthlyClosed',
    label: '本月闭环数',
    icon: RefreshCw,
    tone: 'indigo',
    description: '统计月份内完成闭环的问题数量',
  },
] as const;

const CROSS_METRIC_DEFINITIONS = [
  {
    key: 'historyTotal',
    label: '历史问题统计',
    icon: ShieldCheck,
    tone: 'blue',
    description: '交叉互查台账累计问题数量',
  },
  {
    key: 'monthlyTotal',
    label: '本月问题统计',
    icon: ClipboardList,
    tone: 'success',
    description: '当前统计月份的交叉互查问题数量',
  },
  {
    key: 'legacyTotal',
    label: '历史遗留未解决问题',
    icon: AlertTriangle,
    tone: 'danger',
    description: '历史月份中整改情况仍为空的问题数量',
  },
  {
    key: 'closureRate',
    label: '问题销项率',
    icon: CheckCircle2,
    tone: 'indigo',
    description: '全台账已填写整改情况的问题占历史问题总数的比例',
  },
] as const;

const LEVEL_LABELS: Record<AliRiskLevel, string> = {
  'ultra-low': '超低',
  low: '低',
  medium: '中',
  high: '高',
  unknown: '未分级',
};

const STATUS_LABELS: Record<AliRiskStatus, string> = {
  suspended: '已挂起',
  rectifying: '整改中',
  completed: '已完成',
  unknown: '状态未知',
};

function useFixedStage() {
  const [layout, setLayout] = useState({
    scale: 1,
    viewportWidth: STAGE_WIDTH,
    viewportHeight: STAGE_HEIGHT,
  });
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const updateScale = () => {
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const viewportWidth =
          document.querySelector<HTMLElement>('.risk-inspection-dashboard')
            ?.clientWidth ?? window.innerWidth;
        const viewportHeight = getGlobalNavigationViewportHeight(
          window.innerHeight,
        );
        const nextScale = Math.min(
          1,
          viewportWidth / STAGE_WIDTH,
          viewportHeight / STAGE_HEIGHT,
        );
        setLayout({
          scale: Math.max(0.48, nextScale),
          viewportWidth,
          viewportHeight,
        });
      });
    };

    updateScale();
    window.addEventListener('resize', updateScale);
    return () => {
      window.removeEventListener('resize', updateScale);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, []);

  return layout;
}

function currentShanghaiMonth(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}`;
}

function RiskLevelBadge({
  level,
  label,
}: {
  level: AliRiskLevel;
  label: string;
}) {
  return (
    <Badge className={`risk-level-badge risk-level-${level}`}>{label}</Badge>
  );
}

function RiskStatusBadge({
  status,
  label,
}: {
  status: AliRiskStatus;
  label: string;
}) {
  return (
    <Badge className={`risk-status-badge risk-status-${status}`}>{label}</Badge>
  );
}

function PanelTitle({
  children,
  description,
}: {
  children: string;
  description?: string;
}) {
  return (
    <div className="risk-panel-title-row">
      <div className="risk-panel-title-mark" aria-hidden="true" />
      <div>
        <h2>{children}</h2>
        {description ? <span>{description}</span> : null}
      </div>
    </div>
  );
}

function openOnKeyboard(event: ReactKeyboardEvent, action: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
}

function DistributionLegend({
  title,
  items,
  getColor,
  onOpenIssueList,
}: {
  title: string;
  items: RiskDistributionItem[];
  getColor: (item: RiskDistributionItem, index: number) => string;
  onOpenIssueList: (item: RiskDistributionItem) => void;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="risk-distribution-legend">
      <p>{title}</p>
      {items.map((item, index) => (
        <button
          type="button"
          className="risk-legend-row risk-clickable"
          key={item.key}
          aria-label={`查看${item.label}问题清单`}
          onClick={() => onOpenIssueList(item)}
        >
          <i
            style={{ backgroundColor: getColor(item, index) }}
            aria-hidden="true"
          />
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <em>
            ({total === 0 ? '0.0' : ((item.value / total) * 100).toFixed(1)}%)
          </em>
        </button>
      ))}
      <div className="risk-legend-total">
        <span>合计</span>
        <strong>{total}</strong>
        <em>({total > 0 ? '100' : '0'}%)</em>
      </div>
    </div>
  );
}

function renderOuterDonutLabel({
  cx,
  cy,
  midAngle = 0,
  outerRadius = 0,
  percent = 0,
  payload,
  index = 0,
}: PieLabelRenderProps) {
  const item = payload as RiskDistributionItem | undefined;
  if (!item || item.value <= 0) return null;
  const stableIndex = getStableDonutLabelIndex(item.key || item.label, index);
  const color = getSeverityColor(item, index);
  const labelColor = getSeverityLabelColor(item, index);
  const labelText = `${item.label} ${item.value} · ${(percent * 100).toFixed(
    1,
  )}%`;

  const {
    direction,
    startX,
    startY,
    bendX,
    bendY,
    middleX,
    middleY,
    endX,
    endY,
    labelY,
    textX,
    labelWidth,
  } = getOuterDonutLabelLayout({
    cx: Number(cx),
    cy: Number(cy),
    midAngle,
    outerRadius: Number(outerRadius),
    index: stableIndex,
    labelText,
  });

  return (
    <g className="risk-donut-outer-label" aria-hidden="true">
      <path
        className="risk-donut-leader-line"
        d={`M${startX},${startY}L${bendX},${bendY}L${middleX},${middleY}L${endX},${endY}`}
        stroke={color}
      />
      <circle
        className="risk-donut-leader-dot"
        cx={startX}
        cy={startY}
        r="2.5"
        stroke={color}
      />
      <text
        x={textX}
        y={labelY}
        fill={labelColor}
        dominantBaseline="central"
        textAnchor={direction > 0 ? 'start' : 'end'}
        textLength={labelWidth}
        lengthAdjust="spacingAndGlyphs"
      >
        {labelText}
      </text>
    </g>
  );
}

function renderInnerDonutLabel({
  cx,
  cy,
  midAngle = 0,
  innerRadius = 0,
  outerRadius = 0,
  percent = 0,
  payload,
}: PieLabelRenderProps) {
  const item = payload as RiskDistributionItem | undefined;
  if (!item || item.value <= 0) return null;

  const layout = getInnerDonutLabelLayout({
    cx: Number(cx),
    cy: Number(cy),
    midAngle,
    percent,
    innerRadius: Number(innerRadius),
    outerRadius: Number(outerRadius),
    valueText: String(item.value),
  });
  if (layout.mode === 'hidden') return null;

  return (
    <g
      className={`risk-donut-inner-label risk-donut-inner-label-${layout.mode}`}
      aria-hidden="true"
    >
      <rect
        className="risk-donut-inner-pill"
        x={layout.x - layout.width / 2}
        y={layout.y - layout.height / 2}
        width={layout.width}
        height={layout.height}
        rx={layout.mode === 'full' ? 8 : 10}
      />
      {layout.mode === 'full' ? (
        <text x={layout.x} y={layout.y} textAnchor="middle">
          <tspan x={layout.x} y={layout.y - 4.5}>
            {item.label}
          </tspan>
          <tspan
            className="risk-donut-inner-value"
            x={layout.x}
            y={layout.y + 6.5}
            textLength={layout.valueTextLength}
            lengthAdjust={
              layout.valueTextLength ? 'spacingAndGlyphs' : undefined
            }
          >
            {item.value}
          </tspan>
        </text>
      ) : (
        <text
          className="risk-donut-inner-value"
          x={layout.x}
          y={layout.y}
          textAnchor="middle"
          dominantBaseline="central"
          textLength={layout.valueTextLength}
          lengthAdjust={layout.valueTextLength ? 'spacingAndGlyphs' : undefined}
        >
          {item.value}
        </text>
      )}
    </g>
  );
}

function RiskPanorama({
  dashboard,
  onOpenIssueList,
}: {
  dashboard: AliRiskInspectionDashboard;
  onOpenIssueList: (selection: AliIssueListSelection) => void;
}) {
  const { severityDistribution, statusDistribution } = dashboard;
  const visibleSeverity = severityDistribution.filter((item) => item.value > 0);
  const visibleStatuses = statusDistribution.filter((item) => item.value > 0);
  const openSeverityIssueList = (item: RiskDistributionItem) =>
    onOpenIssueList({
      title: `${item.label} · 风险问题清单`,
      description: '问题全景分布 · 风险等级筛选结果',
      issues: selectAliChartIssues(dashboard, {
        kind: 'severity',
        level: item.key as AliRiskLevel,
      }),
    });
  const openStatusIssueList = (item: RiskDistributionItem) =>
    onOpenIssueList({
      title: `${item.label} · 本月问题清单`,
      description: '问题全景分布 · 问题状态筛选结果',
      issues: selectAliChartIssues(dashboard, {
        kind: 'status',
        status: item.key as AliRiskStatus,
      }),
    });
  const donutAriaLabel = [
    `风险等级：${severityDistribution
      .map((item) => `${item.label} ${item.value}`)
      .join('，')}`,
    `问题状态：${statusDistribution
      .map((item) => `${item.label} ${item.value}`)
      .join('，')}`,
  ].join('；');

  return (
    <Card className="risk-panel risk-panorama-panel">
      <CardContent>
        <PanelTitle>问题全景分布（风险等级 × 问题状态）</PanelTitle>
        <div className="risk-panorama-body">
          <DistributionLegend
            title="风险等级分布（外圈）"
            items={severityDistribution}
            getColor={getSeverityColor}
            onOpenIssueList={openSeverityIssueList}
          />
          <div
            className="risk-donut-wrap"
            role="img"
            aria-label={donutAriaLabel}
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={visibleSeverity}
                  dataKey="value"
                  nameKey="label"
                  cx={RISK_DONUT_GEOMETRY.centerX}
                  cy={RISK_DONUT_GEOMETRY.centerY}
                  innerRadius={RISK_DONUT_GEOMETRY.outerInnerRadius}
                  outerRadius={RISK_DONUT_GEOMETRY.outerRadius}
                  startAngle={90}
                  endAngle={-270}
                  paddingAngle={0.6}
                  stroke="#ffffff"
                  strokeWidth={3}
                  labelLine={false}
                  label={renderOuterDonutLabel}
                  isAnimationActive={false}
                  rootTabIndex={-1}
                  onClick={(entry) => {
                    const item = entry as RiskDistributionItem;
                    openSeverityIssueList(item);
                  }}
                >
                  {visibleSeverity.map((item, index) => (
                    <Cell
                      key={item.key}
                      fill={getSeverityColor(item, index)}
                      className="risk-donut-sector"
                    />
                  ))}
                </Pie>
                <Pie
                  data={visibleStatuses}
                  dataKey="value"
                  nameKey="label"
                  cx={RISK_DONUT_GEOMETRY.centerX}
                  cy={RISK_DONUT_GEOMETRY.centerY}
                  innerRadius={RISK_DONUT_GEOMETRY.innerRadius}
                  outerRadius={RISK_DONUT_GEOMETRY.innerOuterRadius}
                  startAngle={90}
                  endAngle={-270}
                  paddingAngle={0.8}
                  stroke="#ffffff"
                  strokeWidth={3}
                  labelLine={false}
                  label={renderInnerDonutLabel}
                  isAnimationActive={false}
                  rootTabIndex={-1}
                  onClick={(entry) => {
                    const item = entry as RiskDistributionItem;
                    openStatusIssueList(item);
                  }}
                >
                  {visibleStatuses.map((item, index) => (
                    <Cell
                      key={item.key}
                      fill={getStatusColor(item, index)}
                      className="risk-donut-sector"
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <DistributionLegend
            title="问题状态分布（内圈）"
            items={statusDistribution}
            getColor={getStatusColor}
            onOpenIssueList={openStatusIssueList}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function CompletionTrend({
  dashboard,
  onOpenIssueList,
}: {
  dashboard: AliRiskInspectionDashboard;
  onOpenIssueList: (selection: AliIssueListSelection) => void;
}) {
  const { completionTrend: data, month } = dashboard;
  const visibleData = data.slice(-5).map((item) => ({
    ...item,
    period: formatRiskTrendPeriod(item.label, month),
  }));
  const points = visibleData.map((item, index) => {
    const x =
      visibleData.length <= 1
        ? 220
        : 44 + index * (352 / (visibleData.length - 1));
    const y = 142 - Math.max(0, Math.min(100, item.value)) * 0.98;
    return { ...item, x, y };
  });
  const pointString = points.map(({ x, y }) => `${x},${y}`).join(' ');
  const areaString =
    points.length > 0
      ? `${pointString} ${points.at(-1)?.x},152 ${points[0].x},152`
      : '';

  return (
    <Card className="risk-panel risk-chart-panel">
      <CardContent>
        <PanelTitle description="按周统计">整改完成率趋势</PanelTitle>
        <div
          className="risk-line-chart"
          role="img"
          aria-label="近五周整改完成率趋势图"
        >
          <svg viewBox="0 0 420 180" preserveAspectRatio="none" aria-hidden>
            <defs>
              <linearGradient id="risk-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1677ff" stopOpacity="0.26" />
                <stop offset="100%" stopColor="#1677ff" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <line
              x1="34"
              y1="152"
              x2="402"
              y2="152"
              className="risk-chart-axis"
            />
            {points.length > 0 ? (
              <>
                <polygon points={areaString} fill="url(#risk-trend-fill)" />
                <polyline points={pointString} className="risk-chart-line" />
                {points.map(({ label, x, y }) => (
                  <circle
                    key={label}
                    cx={x}
                    cy={y}
                    r="4"
                    className="risk-chart-dot"
                  />
                ))}
              </>
            ) : null}
          </svg>
          <div className="risk-line-chart-values">
            {points.map((item) => {
              const { leftPercent, topPercent } = getTrendPointLabelLayout(
                item.x,
                item.y,
              );
              return (
                <button
                  type="button"
                  className="risk-trend-value risk-clickable"
                  key={item.label}
                  style={{
                    left: `${leftPercent}%`,
                    top: `${topPercent}%`,
                  }}
                  aria-label={`查看${item.period.yearLabel}${item.period.weekLabel}问题清单`}
                  onClick={() =>
                    onOpenIssueList({
                      title: `${item.period.yearLabel}${item.period.weekLabel} · 问题清单`,
                      description: `${item.period.rangeLabel}新发现问题 · 整改完成率 ${item.value}%`,
                      issues: selectAliChartIssues(dashboard, {
                        kind: 'trend',
                        periodStart: item.label,
                      }),
                    })
                  }
                >
                  {item.value}%
                </button>
              );
            })}
          </div>
          <div
            className="risk-line-chart-labels"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, visibleData.length)}, 1fr)`,
            }}
          >
            {visibleData.map(({ label, period }) => (
              <span key={label}>
                <strong>{period.yearLabel}</strong>
                <span className="risk-line-chart-week">{period.weekLabel}</span>
                <small>{period.rangeLabel}</small>
              </span>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CategoryDistribution({
  dashboard,
  onOpenIssueList,
}: {
  dashboard: AliRiskInspectionDashboard;
  onOpenIssueList: (selection: AliIssueListSelection) => void;
}) {
  const { categoryDistribution: data } = dashboard;
  const maximum = Math.max(
    1,
    ...data.map(({ normal, overdue }) => Math.max(normal, overdue)),
  );

  return (
    <Card className="risk-panel risk-chart-panel">
      <CardContent>
        <PanelTitle description="按专业">问题类型分布</PanelTitle>
        <div className="risk-bar-legend" aria-label="图例">
          <span>
            <i className="risk-bar-normal" />
            普通问题
          </span>
          <span>
            <i className="risk-bar-overdue" />
            超期问题
          </span>
        </div>
        <div
          className="risk-bar-chart"
          role="img"
          aria-label="问题类型分布柱状图"
        >
          {data.map((item) => {
            const normalHeight = (item.normal / maximum) * 132;
            const overdueHeight =
              item.overdue === 0
                ? 0
                : Math.max(8, (item.overdue / maximum) * 132);
            return (
              <button
                type="button"
                className="risk-bar-group risk-clickable"
                key={item.label}
                aria-label={`查看${item.label}问题清单`}
                onClick={() =>
                  onOpenIssueList({
                    title: `${item.label} · 问题清单`,
                    description: '问题类型分布 · 专业筛选结果',
                    issues: selectAliChartIssues(dashboard, {
                      kind: 'specialty',
                      specialty: item.label,
                    }),
                  })
                }
              >
                <div className="risk-bar-stack">
                  <div className="risk-bar-column">
                    <span className="risk-bar-value">{item.normal}</span>
                    <i
                      className="risk-bar risk-bar-normal"
                      style={{ height: normalHeight }}
                    />
                  </div>
                  <div className="risk-bar-column">
                    <span className="risk-bar-value">{item.overdue}</span>
                    <i
                      className="risk-bar risk-bar-overdue"
                      style={{ height: overdueHeight }}
                    />
                  </div>
                </div>
                <span title={item.label}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function RiskTable({
  title,
  issues,
  overdue = false,
  onOpenDetail,
}: {
  title: string;
  issues: readonly AliRiskIssue[];
  overdue?: boolean;
  onOpenDetail: (detail: RiskDetailPayload) => void;
}) {
  return (
    <Card className="risk-panel risk-table-panel">
      <CardContent>
        <PanelTitle>{title}</PanelTitle>
        <div className="risk-table-wrap">
          <Table className="risk-data-table">
            <TableHeader>
              <TableRow>
                <TableHead>风险等级</TableHead>
                <TableHead>专业</TableHead>
                <TableHead className="risk-description-head">
                  问题描述
                </TableHead>
                <TableHead>发现时间</TableHead>
                <TableHead>截止日期</TableHead>
                <TableHead>责任人</TableHead>
                <TableHead>{overdue ? '逾期天数' : '处置状态'}</TableHead>
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
                    aria-label={`查看风险问题：${issue.description}`}
                    onClick={() => onOpenDetail(createAliIssueDetail(issue))}
                    onKeyDown={(event) =>
                      openOnKeyboard(event, () =>
                        onOpenDetail(createAliIssueDetail(issue)),
                      )
                    }
                  >
                    <TableCell>
                      <RiskLevelBadge
                        level={issue.level}
                        label={issue.levelLabel}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="risk-specialty">{issue.specialty}</span>
                    </TableCell>
                    <TableCell
                      className="risk-description-cell"
                      title={issue.description}
                    >
                      {issue.description}
                    </TableCell>
                    <TableCell>{issue.discoveredAt || '—'}</TableCell>
                    <TableCell>{issue.dueAt || '—'}</TableCell>
                    <TableCell>{issue.owner}</TableCell>
                    <TableCell>
                      {overdue ? (
                        <Badge className="risk-overdue-badge">
                          已逾期 {issue.overdueDays} 天
                        </Badge>
                      ) : (
                        <RiskStatusBadge
                          status={issue.status}
                          label={issue.statusLabel}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="risk-table-empty">
                    当前筛选条件下暂无风险问题
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

function SourceState({
  status,
  message,
  onRetry,
}: {
  status: LoadStatus;
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className={`risk-source-state risk-source-state-${status}`}>
      {status === 'loading' ? (
        <LoaderCircle className="risk-source-spinner" aria-hidden="true" />
      ) : (
        <AlertTriangle aria-hidden="true" />
      )}
      <strong>
        {status === 'loading' ? '正在同步飞书数据' : '数据加载失败'}
      </strong>
      <span>{message}</span>
      {status === 'error' ? (
        <Button type="button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          重新加载
        </Button>
      ) : null}
    </section>
  );
}

function formatSourceTime(data: {
  sourceUpdatedAt: string | null;
  syncedAt: string;
}): string {
  const raw = data.sourceUpdatedAt || data.syncedAt;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export default function RiskInspectionDashboard({
  standaloneQuality = false,
}: RiskInspectionDashboardProps) {
  const { scale, viewportWidth, viewportHeight } = useFixedStage();
  const [activeView, setActiveView] = useState<DashboardView>(
    standaloneQuality ? 'monthly-quality' : 'inspection',
  );
  const [filters, setFilters] =
    useState<RiskDashboardFilters>(DEFAULT_RISK_FILTERS);
  const [aliData, setAliData] = useState<AliRiskInspectionDashboard | null>(
    null,
  );
  const [crossData, setCrossData] = useState<CrossInspectionDashboard | null>(
    null,
  );
  const [qualityData, setQualityData] =
    useState<AliMonthlyQualityDataset | null>(null);
  const qualityMutationRevisionRef = useRef(0);
  const [aliStatus, setAliStatus] = useState<LoadStatus>('idle');
  const [crossStatus, setCrossStatus] = useState<LoadStatus>('idle');
  const [qualityStatus, setQualityStatus] = useState<LoadStatus>('idle');
  const [aliError, setAliError] = useState('');
  const [crossError, setCrossError] = useState('');
  const [qualityError, setQualityError] = useState('');
  const [qualityRefreshing, setQualityRefreshing] = useState(false);
  const [qualityYear, setQualityYear] = useState('');
  const [qualityMonth, setQualityMonth] = useState('');
  const [qualityItem, setQualityItem] = useState('all');
  const [detail, setDetail] = useState<RiskDetailPayload | null>(null);
  const [metricListKey, setMetricListKey] = useState<AliMetricListKey | null>(
    null,
  );
  const [aliIssueListSelection, setAliIssueListSelection] =
    useState<AliIssueListSelection | null>(null);
  const [crossMetricListKey, setCrossMetricListKey] =
    useState<CrossMetricListKey | null>(null);
  const [crossIssueListSelection, setCrossIssueListSelection] =
    useState<CrossIssueListSelection | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const [overduePage, setOverduePage] = useState(1);
  const aliMonth = aliData?.month || currentShanghaiMonth();
  const isCrossInspection = activeView === 'cross-inspection';
  const isMonthlyQuality = activeView === 'monthly-quality';
  const isCompactQualityStage =
    isMonthlyQuality && viewportWidth <= QUALITY_COMPACT_BREAKPOINT;
  const stageWidth = isMonthlyQuality
    ? Math.min(viewportWidth, STAGE_WIDTH)
    : STAGE_WIDTH;
  const stageHeight = isMonthlyQuality
    ? viewportHeight
    : Math.max(viewportHeight, STAGE_HEIGHT);
  const stageScale = isMonthlyQuality
    ? 1
    : viewportWidth >= 1180
      ? Math.min(1, viewportWidth / STAGE_WIDTH)
      : scale;

  const loadAli = useCallback(
    async (options: { refresh?: boolean } = {}) => {
      setAliStatus((current) => (aliData ? current : 'loading'));
      setAliError('');
      try {
        const nextData = await getRiskInspectionAliDashboard({
          month: aliMonth,
          refresh: options.refresh,
        });
        setAliData(nextData);
        setAliStatus('ready');
        setPage(1);
        setOverduePage(1);
      } catch {
        setAliError('无法读取现场风险检查多维表，请检查网络或飞书应用权限。');
        setAliStatus(aliData ? 'ready' : 'error');
      }
    },
    [aliData, aliMonth],
  );

  const loadCross = useCallback(
    async (options: { refresh?: boolean } = {}) => {
      setCrossStatus((current) => (crossData ? current : 'loading'));
      setCrossError('');
      try {
        const nextData = await getRiskInspectionCrossDashboard({
          refresh: options.refresh,
        });
        setCrossData(nextData);
        setCrossStatus('ready');
      } catch {
        setCrossError('无法读取交叉互查互纠多维表，请检查网络或飞书应用权限。');
        setCrossStatus(crossData ? 'ready' : 'error');
      }
    },
    [crossData],
  );

  const loadQuality = useCallback(
    async (options: { refresh?: boolean } = {}) => {
      const requestRevision = qualityMutationRevisionRef.current;
      if (qualityData) {
        setQualityRefreshing(true);
      } else {
        setQualityStatus('loading');
      }
      setQualityError('');
      try {
        const nextData = await getAliMonthlyQualityDataset({
          refresh: options.refresh,
        });
        if (requestRevision !== qualityMutationRevisionRef.current) return;
        setQualityData(nextData);
        setQualityStatus('ready');
        setQualityYear((current) =>
          current && nextData.options.years.includes(current)
            ? current
            : nextData.options.years[0] || '',
        );
        setQualityMonth((current) =>
          current && nextData.options.months.includes(current)
            ? current
            : nextData.options.months[0] || '',
        );
        setQualityItem((current) =>
          current === 'all' || nextData.options.items.includes(current)
            ? current
            : 'all',
        );
      } catch {
        if (requestRevision !== qualityMutationRevisionRef.current) return;
        setQualityError(
          '无法读取阿里月度质量评级与问题清单，请检查网络或飞书应用权限。',
        );
        setQualityStatus(qualityData ? 'ready' : 'error');
      } finally {
        setQualityRefreshing(false);
      }
    },
    [qualityData],
  );

  useEffect(() => {
    if (!standaloneQuality && aliStatus === 'idle') {
      void loadAli();
    }
  }, [aliStatus, loadAli, standaloneQuality]);

  useEffect(() => {
    if (isCrossInspection && crossStatus === 'idle') {
      void loadCross();
    }
  }, [crossStatus, isCrossInspection, loadCross]);

  useEffect(() => {
    if (isMonthlyQuality && qualityStatus === 'idle') {
      void loadQuality();
    }
  }, [isMonthlyQuality, loadQuality, qualityStatus]);

  const dashboard = useMemo(
    () => (aliData ? getRiskDashboardView(aliData, filters) : null),
    [aliData, filters],
  );
  const unresolvedTotalPages = Math.max(
    1,
    Math.ceil((dashboard?.unresolvedIssues.length || 0) / pageSize),
  );
  const currentPage = Math.min(page, unresolvedTotalPages);
  const visibleIssues = paginateRiskIssues(
    dashboard?.unresolvedIssues || [],
    currentPage,
    pageSize,
  );
  const overdueTotalPages = Math.max(
    1,
    Math.ceil((aliData ? aliData.overdueIssues.length : 0) / 5),
  );
  const currentOverduePage = Math.min(overduePage, overdueTotalPages);
  const visibleOverdueIssues = paginateRiskIssues(
    dashboard?.overdueIssues || [],
    currentOverduePage,
    5,
  );

  const updateFilter = <K extends keyof RiskDashboardFilters>(
    key: K,
    value: RiskDashboardFilters[K],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };

  const activeData = isMonthlyQuality
    ? qualityData
    : isCrossInspection
      ? crossData
      : aliData;
  const activeStatus = isMonthlyQuality
    ? qualityStatus
    : isCrossInspection
      ? crossStatus
      : aliStatus;
  const activeError = isMonthlyQuality
    ? qualityError
    : isCrossInspection
      ? crossError
      : aliError;
  const activeMetricDefinition = METRICS.find(
    ({ key }) => key === metricListKey,
  );
  const activeCrossMetricDefinition = CROSS_METRIC_DEFINITIONS.find(
    ({ key }) => key === crossMetricListKey,
  );

  return (
    <main
      className="risk-inspection-dashboard"
      aria-label={standaloneQuality ? '质量评估看板' : '风险排查看板'}
    >
      <div
        className="risk-inspection-frame"
        style={{
          width: stageWidth * stageScale,
          height: stageHeight * stageScale,
        }}
      >
        <section
          className={`risk-inspection-stage${
            isMonthlyQuality ? ' quality-stage' : ''
          }`}
          data-screenshot-target="risk-inspection-dashboard"
          data-screenshot-ready={activeStatus !== 'loading'}
          data-dashboard-view={activeView}
          style={{
            width: stageWidth,
            height: stageHeight,
            gridTemplateRows: isMonthlyQuality
              ? isCompactQualityStage
                ? 'auto minmax(0, 1fr) 24px'
                : '60px minmax(0, 1fr) 20px'
              : undefined,
            transform: `scale(${stageScale})`,
          }}
        >
          <header className="risk-dashboard-header">
            <div className="risk-title-group">
              <span className="risk-title-icon" aria-hidden="true">
                {isMonthlyQuality ? (
                  <ClipboardCheck />
                ) : isCrossInspection ? (
                  <Shuffle />
                ) : (
                  <ShieldCheck />
                )}
              </span>
              <div>
                <p>
                  {standaloneQuality
                    ? '南通机房 · 运维质量中心'
                    : '南通机房 · 安全管理中心'}
                </p>
                <h1>
                  {standaloneQuality
                    ? '质量评估'
                    : isMonthlyQuality
                      ? '阿里月度质量评级'
                      : isCrossInspection
                        ? '现场交叉互查互纠'
                        : '现场风险检查-Ali'}
                </h1>
              </div>
            </div>

            {!standaloneQuality ? (
              <div
                className="risk-view-switch"
                role="tablist"
                aria-label="切换风险排查看板"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeView === 'inspection'}
                  className={
                    activeView === 'inspection' ? 'is-active' : undefined
                  }
                  onClick={() => setActiveView('inspection')}
                >
                  <LayoutDashboard aria-hidden="true" />
                  现场风险检查
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeView === 'cross-inspection'}
                  className={
                    activeView === 'cross-inspection' ? 'is-active' : undefined
                  }
                  onClick={() => setActiveView('cross-inspection')}
                >
                  <Shuffle aria-hidden="true" />
                  交叉互查互纠
                </button>
              </div>
            ) : null}

            {isCrossInspection ? (
              <div
                className="risk-dashboard-filters"
                aria-label="交叉互查全局操作"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="risk-refresh-button"
                  aria-label="刷新交叉互查数据"
                  onClick={() => void loadCross({ refresh: true })}
                >
                  <RefreshCw aria-hidden="true" />
                </Button>
              </div>
            ) : isMonthlyQuality ? (
              <div
                className="risk-dashboard-filters quality-header-filters"
                aria-label="阿里月度质量筛选条件"
              >
                {qualityData && qualityData.options.years.length > 1 ? (
                  <Select value={qualityYear} onValueChange={setQualityYear}>
                    <SelectTrigger aria-label="质量评级年份筛选">
                      <span className="risk-filter-label">年份</span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {qualityData.options.years.map((yearOption) => (
                        <SelectItem value={yearOption} key={yearOption}>
                          {yearOption}年
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <Select
                  value={qualityMonth || 'none'}
                  onValueChange={(value) => {
                    if (value !== 'none') setQualityMonth(value);
                  }}
                  disabled={!qualityData}
                >
                  <SelectTrigger aria-label="质量检查月份筛选">
                    <span className="risk-filter-label">月份</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!qualityData ? (
                      <SelectItem value="none" disabled>
                        暂无月份
                      </SelectItem>
                    ) : null}
                    {qualityData?.options.months.map((monthOption) => (
                      <SelectItem value={monthOption} key={monthOption}>
                        {monthOption}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={qualityItem}
                  onValueChange={setQualityItem}
                  disabled={!qualityData}
                >
                  <SelectTrigger aria-label="质量检查项目筛选">
                    <span className="risk-filter-label">检查项目</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部项目</SelectItem>
                    {qualityData?.options.items.map((itemOption) => (
                      <SelectItem value={itemOption} key={itemOption}>
                        {itemOption}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="risk-refresh-button"
                  aria-label="刷新阿里月度质量数据"
                  disabled={qualityStatus === 'loading' || qualityRefreshing}
                  onClick={() => void loadQuality({ refresh: true })}
                >
                  {qualityRefreshing ? (
                    <LoaderCircle className="risk-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                </Button>
              </div>
            ) : (
              <div className="risk-dashboard-filters" aria-label="风险筛选条件">
                <Select
                  value={filters.specialty}
                  onValueChange={(value) => updateFilter('specialty', value)}
                >
                  <SelectTrigger aria-label="专业筛选">
                    <span className="risk-filter-label">专业筛选</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部专业</SelectItem>
                    {aliData?.options.specialties.map((specialty) => (
                      <SelectItem value={specialty} key={specialty}>
                        {specialty}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filters.level}
                  onValueChange={(value) =>
                    updateFilter(
                      'level',
                      value as RiskDashboardFilters['level'],
                    )
                  }
                >
                  <SelectTrigger aria-label="风险等级筛选">
                    <span className="risk-filter-label">风险筛选</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部等级</SelectItem>
                    {aliData?.options.levels.map((level) => (
                      <SelectItem value={level} key={level}>
                        {LEVEL_LABELS[level]}风险
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filters.status}
                  onValueChange={(value) =>
                    updateFilter(
                      'status',
                      value as RiskDashboardFilters['status'],
                    )
                  }
                >
                  <SelectTrigger aria-label="处置状态筛选">
                    <span className="risk-filter-label">状态筛选</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    {aliData?.options.statuses.map((status) => (
                      <SelectItem value={status} key={status}>
                        {STATUS_LABELS[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  className="risk-date-filter"
                  aria-label="统计月份"
                >
                  <CalendarDays aria-hidden="true" />
                  {aliMonth}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="risk-refresh-button"
                  aria-label="刷新风险检查数据"
                  onClick={() => void loadAli({ refresh: true })}
                >
                  <RefreshCw aria-hidden="true" />
                </Button>
              </div>
            )}
          </header>

          {!isMonthlyQuality ? (
            <section
              className={`risk-metric-grid${
                isCrossInspection ? ' risk-metric-grid-cross' : ''
              }`}
              aria-label={isCrossInspection ? '交叉互查摘要' : '风险摘要'}
            >
              {isCrossInspection
                ? CROSS_METRIC_DEFINITIONS.map(
                    ({ key, label, icon: Icon, tone }) => {
                      const rawValue = crossData?.summary[key] || 0;
                      const value =
                        key === 'closureRate'
                          ? `${rawValue.toFixed(1).replace(/\.0$/u, '')}%`
                          : rawValue.toLocaleString();
                      const openDetail = () => {
                        setCrossIssueListSelection(null);
                        setCrossMetricListKey(key);
                      };
                      return (
                        <Card
                          className={`risk-metric-card risk-metric-${tone} risk-clickable`}
                          key={key}
                          role="button"
                          tabIndex={0}
                          aria-label={`查看${label}详情`}
                          onClick={openDetail}
                          onKeyDown={(event) =>
                            openOnKeyboard(event, openDetail)
                          }
                        >
                          <CardContent>
                            <span
                              className="risk-metric-icon"
                              aria-hidden="true"
                            >
                              <Icon />
                            </span>
                            <div className="risk-metric-copy">
                              <p>{label}</p>
                              <strong>{value}</strong>
                            </div>
                            <span
                              className="risk-metric-beacon"
                              aria-hidden="true"
                            />
                          </CardContent>
                        </Card>
                      );
                    },
                  )
                : METRICS.map(({ key, label, icon: Icon, tone }) => {
                    const value = dashboard
                      ? key === 'rectificationRate'
                        ? `${getAliRectificationStats(dashboard.issues).rate}%`
                        : selectAliMetricIssues(
                            dashboard,
                            key,
                          ).length.toLocaleString()
                      : '—';
                    const openDetail = () => {
                      setAliIssueListSelection(null);
                      setMetricListKey(key);
                    };
                    return (
                      <Card
                        className={`risk-metric-card risk-metric-${tone} risk-clickable`}
                        key={key}
                        role="button"
                        tabIndex={0}
                        aria-label={`查看${label}详情`}
                        onClick={openDetail}
                        onKeyDown={(event) => openOnKeyboard(event, openDetail)}
                      >
                        <CardContent>
                          <span className="risk-metric-icon" aria-hidden="true">
                            <Icon />
                          </span>
                          <div className="risk-metric-copy">
                            <p>{label}</p>
                            <strong>{value}</strong>
                          </div>
                          <span
                            className="risk-metric-beacon"
                            aria-hidden="true"
                          />
                        </CardContent>
                      </Card>
                    );
                  })}
            </section>
          ) : null}

          {!activeData ? (
            <SourceState
              status={activeStatus}
              message={
                activeStatus === 'loading'
                  ? '正在读取指定多维表视图，请稍候。'
                  : activeError
              }
              onRetry={() => {
                if (isMonthlyQuality) {
                  void loadQuality({ refresh: true });
                } else if (isCrossInspection) {
                  void loadCross({ refresh: true });
                } else {
                  void loadAli({ refresh: true });
                }
              }}
            />
          ) : isCrossInspection && crossData ? (
            <CrossInspectionView
              data={crossData}
              onOpenDetail={setDetail}
              onOpenIssueList={(selection) => {
                setCrossMetricListKey(null);
                setCrossIssueListSelection(selection);
              }}
            />
          ) : isMonthlyQuality && qualityData ? (
            <AliMonthlyQualityView
              dataset={qualityData}
              year={qualityYear}
              month={qualityMonth}
              item={qualityItem}
              isRefreshing={qualityRefreshing}
              onMonthChange={setQualityMonth}
              onSupplementalUpdated={(recordId, supplemental) => {
                qualityMutationRevisionRef.current += 1;
                setQualityData((current) => current ? {
                  ...current,
                  issues: current.issues.map((issue) =>
                    issue.id === recordId ? { ...issue, supplemental } : issue,
                  ),
                } : current);
              }}
            />
          ) : dashboard ? (
            <section className="risk-dashboard-body">
              <RiskPanorama
                dashboard={dashboard}
                onOpenIssueList={(selection) => {
                  setMetricListKey(null);
                  setAliIssueListSelection(selection);
                }}
              />
              <div className="risk-right-column">
                <RiskTable
                  title="未解决风险问题"
                  issues={visibleIssues}
                  onOpenDetail={setDetail}
                />
                <div className="risk-pagination-row">
                  <span>共 {dashboard.unresolvedIssues.length} 条</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="上一页"
                    disabled={currentPage === 1}
                    onClick={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                  >
                    <ChevronLeft />
                  </Button>
                  <strong>{currentPage}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="下一页"
                    disabled={currentPage === unresolvedTotalPages}
                    onClick={() =>
                      setPage((current) =>
                        Math.min(unresolvedTotalPages, current + 1),
                      )
                    }
                  >
                    <ChevronRight />
                  </Button>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(value) => {
                      setPageSize(Number(value));
                      setPage(1);
                    }}
                  >
                    <SelectTrigger
                      aria-label="每页显示条数"
                      className="risk-page-size"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5 条/页</SelectItem>
                      <SelectItem value="3">3 条/页</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="risk-bottom-charts">
                <CompletionTrend
                  dashboard={dashboard}
                  onOpenIssueList={(selection) => {
                    setMetricListKey(null);
                    setAliIssueListSelection(selection);
                  }}
                />
                <CategoryDistribution
                  dashboard={dashboard}
                  onOpenIssueList={(selection) => {
                    setMetricListKey(null);
                    setAliIssueListSelection(selection);
                  }}
                />
              </div>
              <div className="risk-right-column risk-overdue-column">
                <RiskTable
                  title="逾期风险问题"
                  issues={visibleOverdueIssues}
                  overdue
                  onOpenDetail={setDetail}
                />
                <div className="risk-pagination-row">
                  <span>共 {dashboard.overdueIssues.length} 条</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="上一页"
                    disabled={currentOverduePage === 1}
                    onClick={() =>
                      setOverduePage((current) => Math.max(1, current - 1))
                    }
                  >
                    <ChevronLeft />
                  </Button>
                  <strong>{currentOverduePage}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="下一页"
                    disabled={currentOverduePage === overdueTotalPages}
                    onClick={() =>
                      setOverduePage((current) =>
                        Math.min(overdueTotalPages, current + 1),
                      )
                    }
                  >
                    <ChevronRight />
                  </Button>
                  <span className="risk-page-size-static">5 条/页</span>
                </div>
              </div>
            </section>
          ) : null}

          <div
            className={`risk-dashboard-footer${
              activeData?.sourceStatus === 'stale' ? ' risk-source-warning' : ''
            }`}
            aria-live="polite"
          >
            <Clock3 aria-hidden="true" />
            {activeData ? (
              <>
                {activeData.sourceStatus === 'stale'
                  ? '缓存数据 · '
                  : '飞书数据 · '}
                更新于 {formatSourceTime(activeData)} ·
                {isMonthlyQuality && qualityRefreshing
                  ? '正在同步最新数据'
                  : isMonthlyQuality && qualityError
                    ? qualityError
                    : activeData.sourceStatus === 'stale'
                      ? activeData.warnings[0]
                      : '筛选同步影响图表与问题清单'}
              </>
            ) : (
              activeError || '正在连接飞书多维表'
            )}
          </div>
        </section>
      </div>
      <RiskMetricListDialog
        dashboard={dashboard}
        metricKey={metricListKey}
        selection={aliIssueListSelection}
        title={activeMetricDefinition?.label || ''}
        description={activeMetricDefinition?.description || ''}
        onClose={() => {
          setMetricListKey(null);
          setAliIssueListSelection(null);
        }}
        onOpenIssue={(issue) => setDetail(createAliIssueDetail(issue))}
      />
      <CrossIssueListDialog
        dashboard={crossData}
        metricKey={crossMetricListKey}
        selection={crossIssueListSelection}
        title={activeCrossMetricDefinition?.label || ''}
        description={activeCrossMetricDefinition?.description || ''}
        onClose={() => {
          setCrossMetricListKey(null);
          setCrossIssueListSelection(null);
        }}
        onOpenIssue={(issue) => setDetail(createCrossIssueDetail(issue))}
      />
      <RiskDetailDialog detail={detail} onClose={() => setDetail(null)} />
    </main>
  );
}
