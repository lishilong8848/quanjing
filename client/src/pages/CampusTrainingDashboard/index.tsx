import {
  ArrowUp,
  BookOpenCheck,
  CalendarDays,
  Clock3,
  FileText,
  Flag,
  GraduationCap,
  MessageSquareText,
  Presentation,
  RefreshCw,
  ScrollText,
  Star,
  ThumbsUp,
  TriangleAlert,
  UserPlus,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

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
  chartMax,
  currentTrainingMonth,
  formatTrainingMonth,
  isCampusTrainingDashboardResponse,
  isTrainingMonth,
  type BuildingTrainingProgress,
  type CampusTrainingDashboardResponse,
  type NewHirePlan,
  type SharingOverview,
  type SharingTone,
  type SharingTrendPoint,
  type TrainingMetricComparison,
  type TrainingMetricKey,
  type TrainingParticipation,
} from './model';
import { getCampusTrainingDashboard } from '@/api';
import {
  buildSmoothAreaPath,
  buildSmoothLinePath,
  resolveRateLabelY,
} from './chart-geometry';
import { TrainingDetailDialog } from './TrainingDetailDialog';
import {
  buildMetricDetail,
  buildNewHireDetail,
  buildNewHirePlanListDetail,
  buildOverviewDetail,
  buildParticipationDetail,
  buildProgressDetail,
  buildSharingDetail,
  type TrainingDetail,
} from './training-detail-model';
import type { TrainingCertificationHeaderStateChange } from '../TrainingCertificationManagement';

import './styles.css';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 650;
const COMPACT_BREAKPOINT = 960;

interface CampusTrainingDashboardProps {
  embedded?: boolean;
  onHeaderStateChange?: TrainingCertificationHeaderStateChange;
}

type MetricVisualType =
  | 'courses'
  | 'plan'
  | 'people'
  | 'new-hire'
  | 'history'
  | 'sharing';

interface MetricDefinition {
  key: TrainingMetricKey;
  label: string;
  icon: LucideIcon;
  tone: 'blue' | 'red' | 'sky' | 'purple' | 'orange' | 'green';
  visual: MetricVisualType;
}

const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: 'annualCompletedCourses',
    label: '本年度已培训课程',
    icon: GraduationCap,
    tone: 'blue',
    visual: 'courses',
  },
  {
    key: 'monthlyPlannedCourses',
    label: '本月计划性培训课程',
    icon: TriangleAlert,
    tone: 'red',
    visual: 'plan',
  },
  {
    key: 'monthlyParticipants',
    label: '本月参与培训人员',
    icon: UsersRound,
    tone: 'sky',
    visual: 'people',
  },
  {
    key: 'monthlyNewHires',
    label: '本月新人培训',
    icon: UserPlus,
    tone: 'purple',
    visual: 'new-hire',
  },
  {
    key: 'historicalSharingSessions',
    label: '历史分享会',
    icon: Flag,
    tone: 'orange',
    visual: 'history',
  },
  {
    key: 'monthlyPlannedSharingSessions',
    label: '本月计划进行分享会',
    icon: Star,
    tone: 'green',
    visual: 'sharing',
  },
];

const SHARING_ICONS: Record<SharingTone, LucideIcon> = {
  blue: MessageSquareText,
  teal: UsersRound,
  orange: ScrollText,
  purple: Presentation,
};

const SHARING_COLORS: Record<SharingTone, string> = {
  blue: 'hsl(218 93% 53%)',
  teal: 'hsl(164 64% 56%)',
  orange: 'hsl(35 100% 62%)',
  purple: 'hsl(256 69% 63%)',
};

function sharingDonutBackground(
  categories: SharingOverview['categories'],
): string {
  const sessions = categories.map((item) =>
    Number.isFinite(item.sessions) ? Math.max(0, item.sessions) : 0,
  );
  const total = sessions.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return 'conic-gradient(var(--training-track) 0 100%)';
  }

  let offset = 0;
  const segments = categories.map((item, index) => {
    const start = offset;
    offset += (sessions[index] / total) * 100;
    return (
      SHARING_COLORS[item.tone] +
      ' ' +
      String(start) +
      '% ' +
      String(offset) +
      '%'
    );
  });
  return 'conic-gradient(from -90deg, ' + segments.join(', ') + ')';
}

function handleInteractiveKey(
  event: KeyboardEvent<HTMLElement>,
  onOpen: () => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onOpen();
}

function formatTrainingTimestamp(value: string | null | undefined): string {
  if (!value) return '--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.replace('T', ' ').slice(0, 16);
  }
  return parsed
    .toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '-');
}

function useResponsiveStage(enabled = true) {
  const [layout, setLayout] = useState({ scale: 1, compact: !enabled });
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLayout({ scale: 1, compact: true });
      return undefined;
    }

    const updateLayout = () => {
      if (resizeFrameRef.current !== null) return;

      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const compact = window.innerWidth <= COMPACT_BREAKPOINT;
        const scale = compact
          ? 1
          : Math.min(1, window.innerWidth / STAGE_WIDTH);

        setLayout((current) => {
          if (
            current.compact === compact &&
            Math.abs(current.scale - scale) < 0.001
          ) {
            return current;
          }
          return { compact, scale };
        });
      });
    };

    updateLayout();
    window.addEventListener('resize', updateLayout);

    return () => {
      window.removeEventListener('resize', updateLayout);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, [enabled]);

  return layout;
}

function MetricMiniVisual({
  type,
  values,
}: {
  type: MetricVisualType;
  values: readonly number[];
}) {
  const plottedValues = values
    .slice(-5)
    .map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const maximum = chartMax(plottedValues);
  const gradientId = 'training-metric-mini-' + type;
  const pointStep =
    plottedValues.length > 1 ? 55 / (plottedValues.length - 1) : 0;
  const xForIndex = (index: number) =>
    plottedValues.length === 1 ? 33 : 5 + index * pointStep;
  const yForValue = (value: number) => 40 - (value / maximum) * 34;
  const points = plottedValues
    .map(
      (value, index) =>
        String(xForIndex(index)) + ',' + String(yForValue(value)),
    )
    .join(' ');

  return (
    <svg
      className={'training-metric-mini training-metric-mini-' + type}
      viewBox="0 0 66 44"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.98" />
        </linearGradient>
      </defs>
      <path d="M2 40H64" className="training-metric-mini-axis" />
      {plottedValues.map((value, index) => {
        const y = yForValue(value);
        return (
          <rect
            key={type + '-bar-' + String(index)}
            x={xForIndex(index) - 3}
            y={y}
            width="6"
            height={Math.max(0, 40 - y)}
            rx="2"
            fill={'url(#' + gradientId + ')'}
          />
        );
      })}
      {plottedValues.length > 1 ? (
        <polyline points={points} className="training-metric-mini-line" />
      ) : null}
      {plottedValues.length > 0 ? (
        <circle
          cx={xForIndex(plottedValues.length - 1)}
          cy={yForValue(plottedValues[plottedValues.length - 1])}
          r="3"
          className="training-metric-mini-point"
        />
      ) : null}
    </svg>
  );
}

function MetricCard({
  definition,
  value,
  comparison,
  trend,
  onOpen,
}: {
  definition: MetricDefinition;
  value: number;
  comparison: TrainingMetricComparison;
  trend: readonly number[];
  onOpen: () => void;
}) {
  const Icon = definition.icon;
  const change = Number.isFinite(comparison.change) ? comparison.change : 0;

  return (
    <Card
      className={
        'training-dashboard-card training-metric-card training-clickable training-metric-' +
        definition.tone
      }
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`查看${definition.label}明细`}
      onClick={onOpen}
      onKeyDown={(event) => handleInteractiveKey(event, onOpen)}
    >
      <CardContent className="training-metric-card-content">
        <div className="training-metric-main">
          <span className="training-metric-icon" aria-hidden="true">
            <Icon />
          </span>
          <div className="training-metric-copy">
            <p>{definition.label}</p>
            <strong>{value}</strong>
          </div>
        </div>
        <div className="training-metric-footer">
          <span>较上月</span>
          <strong
            className={
              comparison.favorable
                ? 'training-change-success'
                : 'training-change-danger'
            }
          >
            <ArrowUp
              className={
                comparison.direction === 'down'
                  ? 'training-change-down'
                  : undefined
              }
              aria-hidden="true"
            />
            {change}%
          </strong>
          <MetricMiniVisual type={definition.visual} values={trend} />
        </div>
      </CardContent>
    </Card>
  );
}

function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="training-panel-header">
      <h2>{title}</h2>
      {action ? <div className="training-panel-action">{action}</div> : null}
    </div>
  );
}

function ProgressBar({
  value,
  label,
  tone = 'primary',
}: {
  value: number;
  label: string;
  tone?: 'primary' | 'success';
}) {
  const normalizedValue = Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;

  return (
    <div
      className="training-progress-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalizedValue}
    >
      <i
        className={
          tone === 'success'
            ? 'training-progress-fill training-progress-fill-success'
            : 'training-progress-fill'
        }
        style={{ width: String(normalizedValue) + '%' }}
      />
    </div>
  );
}

function TrainingProgressChart({
  data,
  onOpen,
}: {
  data: readonly BuildingTrainingProgress[];
  onOpen: () => void;
}) {
  const plot = { left: 24, right: 676, top: 26, bottom: 216 };
  const rateLabelMinY = 12;
  const rateLabelMaxY = plot.bottom - 8;
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const step = data.length > 0 ? plotWidth / data.length : plotWidth;
  const barWidth = Math.min(20, Math.max(10, step * 0.18));
  const barGap = Math.min(16, Math.max(12, step * 0.12));
  const groupWidth = barWidth * 2 + barGap;
  const xForIndex = (index: number) => plot.left + step * (index + 0.5);
  const yForCourses = (value: number) => {
    const normalized = Number.isFinite(value)
      ? Math.max(0, Math.min(40, value))
      : 0;
    return plot.bottom - (normalized / 40) * plotHeight;
  };
  const yForRate = (value: number) => {
    const normalized = Number.isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : 0;
    return plot.bottom - (normalized / 100) * plotHeight;
  };
  const rateCoordinates = data.map((item, index) => {
    const centerX = xForIndex(index);
    const plannedY = yForCourses(item.planned);
    const completedY = yForCourses(item.completed);
    const plannedX = centerX - groupWidth / 2;
    const completedX = plannedX + barWidth + barGap;

    return {
      x: centerX,
      y: yForRate(item.rate),
      building: item.building,
      planned: item.planned,
      completed: item.completed,
      rate: item.rate,
      plannedY,
      completedY,
      plannedX,
      completedX,
      plannedValueY: plannedY - 7,
      completedValueY: completedY - 7,
    };
  });
  const rateAreaPath = buildSmoothAreaPath(rateCoordinates, plot.bottom);
  const rateLinePath = buildSmoothLinePath(rateCoordinates);

  return (
    <Card
      className="training-dashboard-card training-panel training-progress-panel training-clickable"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label="查看本月在岗考核课程进展明细"
      aria-describedby="training-progress-chart-data"
      onClick={onOpen}
      onKeyDown={(event) => handleInteractiveKey(event, onOpen)}
    >
      <CardContent className="training-panel-content">
        <PanelHeader
          title="本月在岗考核课程进展"
          action={
            <div className="training-chart-legend" aria-label="图例">
              <span>
                <i className="training-legend-square training-legend-plan" />
                本月需考核课程数
              </span>
              <span>
                <i className="training-legend-square training-legend-completed" />
                已完成考核课程数
              </span>
              <span>
                <i className="training-legend-line" />
                考核课程完成率
              </span>
            </div>
          }
        />
        <ul id="training-progress-chart-data" className="sr-only">
          {data.map((item) => (
            <li key={item.building}>
              {item.building}：需考核 {item.planned} 门，已完成考核{' '}
              {item.completed} 门，考核课程完成率 {item.rate}%
            </li>
          ))}
        </ul>
        <svg
          className="training-progress-chart"
          viewBox="0 0 700 260"
          role="img"
          aria-label="本月考核课程进度组合图"
          aria-describedby="training-progress-chart-data"
        >
          <defs>
            <linearGradient
              id="training-planned-gradient"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#085af4" />
              <stop offset="100%" stopColor="#8ab8ff" />
            </linearGradient>
            <linearGradient
              id="training-completed-gradient"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#079a76" />
              <stop offset="100%" stopColor="#8ce8cf" />
            </linearGradient>
            <linearGradient
              id="training-rate-area-gradient"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#216fff" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#216fff" stopOpacity="0.025" />
            </linearGradient>
          </defs>

          <line
            x1={plot.left}
            x2={plot.right}
            y1={plot.bottom}
            y2={plot.bottom}
            className="training-chart-axis"
          />

          {rateAreaPath ? (
            <path
              d={rateAreaPath}
              className="training-rate-area"
              fill="url(#training-rate-area-gradient)"
            />
          ) : null}

          {rateLinePath ? (
            <path d={rateLinePath} className="training-rate-line" />
          ) : null}

          {rateCoordinates.map(
            ({ building, plannedY, completedY, plannedX, completedX }) => (
              <g key={'training-bars-' + building}>
                <rect
                  x={plannedX}
                  y={plannedY}
                  width={barWidth}
                  height={plot.bottom - plannedY}
                  rx="3"
                  fill="url(#training-planned-gradient)"
                />
                <rect
                  x={completedX}
                  y={completedY}
                  width={barWidth}
                  height={plot.bottom - completedY}
                  rx="3"
                  fill="url(#training-completed-gradient)"
                />
              </g>
            ),
          )}

          {rateCoordinates.map(
            ({
              building,
              planned,
              completed,
              x,
              plannedX,
              completedX,
              plannedValueY,
              completedValueY,
            }) => (
              <g key={'training-bar-labels-' + building}>
                <text
                  x={plannedX + barWidth / 2}
                  y={plannedValueY}
                  textAnchor="middle"
                  className="training-chart-value"
                >
                  {planned}
                </text>
                <text
                  x={completedX + barWidth / 2}
                  y={completedValueY}
                  textAnchor="middle"
                  className="training-chart-value"
                >
                  {completed}
                </text>
                <text
                  x={x}
                  y="242"
                  textAnchor="middle"
                  className="training-chart-building"
                >
                  {building}
                </text>
              </g>
            ),
          )}

          {rateCoordinates.map(({ building, x, y }) => (
            <circle
              key={'training-rate-point-' + building}
              cx={x}
              cy={y}
              r="4"
              className="training-rate-point"
            />
          ))}

          {rateCoordinates.map(
            ({ building, rate, x, y, plannedValueY, completedValueY }) => {
              const preferredRateLabelY = Math.max(plot.top + 12, y - 20);
              const rateLabelY = resolveRateLabelY(
                preferredRateLabelY,
                [plannedValueY, completedValueY],
                rateLabelMinY,
                rateLabelMaxY,
              );
              return (
                <text
                  key={'training-rate-label-' + building}
                  x={x}
                  y={rateLabelY}
                  textAnchor="middle"
                  className="training-rate-label"
                >
                  {rate}%
                </text>
              );
            },
          )}
        </svg>
      </CardContent>
    </Card>
  );
}

function ParticipationPanel({
  data,
  onRowOpen,
  onOpenAll,
}: {
  data: readonly TrainingParticipation[];
  onRowOpen: (item: TrainingParticipation) => void;
  onOpenAll: () => void;
}) {
  return (
    <Card className="training-dashboard-card training-panel training-participation-panel">
      <CardContent className="training-panel-content">
        <PanelHeader
          title="本月培训情况"
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="training-more-button"
              onClick={onOpenAll}
            >
              查看全部明细
            </Button>
          }
        />
        <Table
          className="training-data-table training-participation-table"
          aria-label="本月各楼栋培训完成与考核课程达标情况"
        >
          <TableHeader>
            <TableRow>
              <TableHead>楼栋</TableHead>
              <TableHead>本月参与培训人数</TableHead>
              <TableHead>培训完成率</TableHead>
              <TableHead>考核课程达标率</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => (
              <TableRow
                key={item.building}
                className="training-clickable"
                tabIndex={0}
                aria-haspopup="dialog"
                aria-label={`查看${item.building}培训情况明细`}
                onClick={() => onRowOpen(item)}
                onKeyDown={(event) =>
                  handleInteractiveKey(event, () => onRowOpen(item))
                }
              >
                <TableCell className="training-building-cell">
                  {item.building}
                </TableCell>
                <TableCell>{item.people}</TableCell>
                <TableCell>
                  <div className="training-inline-progress">
                    <ProgressBar
                      value={item.trainingCompletionRate}
                      label={item.building + '培训完成率'}
                    />
                    <strong>{item.trainingCompletionRate}%</strong>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="training-inline-progress">
                    {item.assessmentPassRate === null ? (
                      <span
                        className="training-rate-empty"
                        aria-label={item.building + '暂无考核课程达标率'}
                      >
                        —
                      </span>
                    ) : (
                      <>
                        <ProgressBar
                          value={item.assessmentPassRate}
                          label={item.building + '考核课程达标率'}
                          tone="success"
                        />
                        <strong>{item.assessmentPassRate}%</strong>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function NewHirePlanPanel({
  data,
  expanded,
  onToggle,
  onRowOpen,
  onOpenAll,
}: {
  data: readonly NewHirePlan[];
  expanded: boolean;
  onToggle: () => void;
  onRowOpen: (item: NewHirePlan) => void;
  onOpenAll: () => void;
}) {
  const rows = expanded ? data : data.slice(0, 5);

  return (
    <Card className="training-dashboard-card training-panel training-new-hire-panel">
      <CardContent className="training-panel-content">
        <PanelHeader
          title="新人培训计划"
          action={
            <div className="training-panel-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="training-more-button"
                onClick={onOpenAll}
              >
                查看全部明细
              </Button>
              {data.length > 5 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="training-more-button"
                  aria-expanded={expanded}
                  onClick={onToggle}
                >
                  {expanded ? '收起' : '展开'} &gt;
                </Button>
              ) : null}
            </div>
          }
        />
        <Table
          className="training-data-table training-new-hire-table"
          aria-label="新人培训计划"
        >
          <TableHeader>
            <TableRow>
              <TableHead>姓名</TableHead>
              <TableHead>入职日期</TableHead>
              <TableHead>计划考核截止日期</TableHead>
              <TableHead>需培训课程</TableHead>
              <TableHead>培训进度</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((item) => (
              <TableRow
                key={item.id}
                className="training-clickable"
                tabIndex={0}
                aria-haspopup="dialog"
                aria-label={`查看${item.name}新人培训明细`}
                onClick={() => onRowOpen(item)}
                onKeyDown={(event) =>
                  handleInteractiveKey(event, () => onRowOpen(item))
                }
              >
                <TableCell className="training-person-name">
                  {item.name}
                </TableCell>
                <TableCell>{item.joinedAt ?? '—'}</TableCell>
                <TableCell>{item.assessmentDueAt ?? '—'}</TableCell>
                <TableCell>{item.requiredCourses}</TableCell>
                <TableCell>
                  <div className="training-inline-progress training-compact-progress">
                    <ProgressBar
                      value={item.progress}
                      label={item.name + '培训进度'}
                    />
                    <strong>{item.progress}%</strong>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SharingTrendChart({ data }: { data: readonly SharingTrendPoint[] }) {
  const plot = { left: 28, right: 226, top: 22, bottom: 150 };
  const width = plot.right - plot.left;
  const height = plot.bottom - plot.top;
  const maximum = chartMax(data.map((item) => item.sessions));
  const xForIndex = (index: number) =>
    data.length <= 1
      ? plot.left + width / 2
      : plot.left + (width / (data.length - 1)) * index;
  const yForValue = (value: number) => {
    const normalized = Number.isFinite(value) ? Math.max(0, value) : 0;
    return plot.bottom - (normalized / maximum) * height;
  };
  const coordinates = data.map((item, index) => ({
    x: xForIndex(index),
    y: yForValue(item.sessions),
  }));
  const areaPath = buildSmoothAreaPath(coordinates, plot.bottom);
  const linePath = buildSmoothLinePath(coordinates);
  const ticks = Array.from({ length: 5 }, (_, index) => (maximum / 4) * index);

  return (
    <>
      <ul id="training-sharing-trend-data" className="sr-only">
        {data.map((item) => (
          <li key={item.month}>
            {item.month}：{item.sessions} 场
          </li>
        ))}
      </ul>
      <svg
        className="training-sharing-trend-chart"
        viewBox="0 0 246 178"
        role="img"
        aria-label="近六个月分享会趋势"
        aria-describedby="training-sharing-trend-data"
      >
        <defs>
          <linearGradient
            id="training-sharing-area"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor="#216fff" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#216fff" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line
          x1={plot.left}
          x2={plot.right}
          y1={plot.bottom}
          y2={plot.bottom}
          className="training-sharing-axis"
        />
        {ticks.map((tick, index) => {
          const y = yForValue(tick);
          return (
            <g key={'sharing-tick-' + String(index)}>
              <text
                x="20"
                y={y + 4}
                textAnchor="end"
                className="training-sharing-tick"
              >
                {Math.round(tick * 10) / 10}
              </text>
            </g>
          );
        })}
        {areaPath ? (
          <path d={areaPath} fill="url(#training-sharing-area)" />
        ) : null}
        {linePath ? (
          <path d={linePath} className="training-sharing-line" />
        ) : null}
        {data.map((item, index) => {
          const x = xForIndex(index);
          const y = yForValue(item.sessions);
          return (
            <g key={item.month}>
              <circle
                cx={x}
                cy={y}
                r="3.5"
                className="training-sharing-point"
              />
              <text
                x={x}
                y={y - 9}
                textAnchor="middle"
                className="training-sharing-value"
              >
                {item.sessions}
              </text>
              <text
                x={x}
                y="170"
                textAnchor="middle"
                className="training-sharing-month"
              >
                {item.month}
              </text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

function SharingPanel({
  sharing,
  onOpen,
}: {
  sharing: SharingOverview;
  onOpen: () => void;
}) {
  const donutBackground = sharingDonutBackground(sharing.categories);

  return (
    <Card
      className="training-dashboard-card training-panel training-sharing-panel training-clickable"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label="查看分享会开展情况明细"
      onClick={onOpen}
      onKeyDown={(event) => handleInteractiveKey(event, onOpen)}
    >
      <CardContent className="training-panel-content training-sharing-content">
        <PanelHeader title="分享会开展情况" />
        <div className="training-sharing-main">
          <div className="training-sharing-donut-area">
            {sharing.categories.map((item, index) => {
              const Icon = SHARING_ICONS[item.tone];
              return (
                <div
                  key={item.key}
                  className={
                    'training-sharing-category training-sharing-category-position-' +
                    String((index % 4) + 1)
                  }
                >
                  <span
                    className={
                      'training-sharing-category-icon training-sharing-tone-' +
                      item.tone
                    }
                    aria-hidden="true"
                  >
                    <Icon />
                  </span>
                  <span>{item.label}</span>
                  <strong>
                    {item.sessions}场 ({item.percentage}%)
                  </strong>
                </div>
              );
            })}
            <div
              className="training-sharing-donut"
              role="img"
              aria-label="分享会类型占比环形图"
              style={{ background: donutBackground }}
            >
              <div className="training-sharing-donut-center">
                <strong>
                  {sharing.categories.reduce(
                    (sum, item) => sum + item.sessions,
                    0,
                  )}
                </strong>
                <span>总场次</span>
              </div>
            </div>
          </div>
          <div className="training-sharing-trend">
            <h3>分享会趋势（近6个月）</h3>
            <SharingTrendChart data={sharing.trend} />
          </div>
        </div>
        <div className="training-sharing-stats" aria-label="分享会汇总指标">
          <div>
            <UsersRound className="training-stat-blue" aria-hidden="true" />
            <span>
              参与人数<strong>{sharing.participants}人</strong>
            </span>
          </div>
          <div>
            <Clock3 className="training-stat-green" aria-hidden="true" />
            <span>
              累计时长<strong>{sharing.totalHours}h</strong>
            </span>
          </div>
          <div>
            <ThumbsUp className="training-stat-orange" aria-hidden="true" />
            <span>
              满意度<strong>{sharing.satisfaction}%</strong>
            </span>
          </div>
          <div>
            <FileText className="training-stat-purple" aria-hidden="true" />
            <span>
              资料沉淀<strong>{sharing.materials}份</strong>
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CampusTrainingDashboard({
  embedded = false,
  onHeaderStateChange,
}: CampusTrainingDashboardProps) {
  const { scale, compact } = useResponsiveStage(!embedded);
  const defaultMonthRef = useRef(currentTrainingMonth());
  const [month, setMonth] = useState<string | undefined>(
    defaultMonthRef.current,
  );
  const [dashboard, setDashboard] =
    useState<CampusTrainingDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAllNewHires, setShowAllNewHires] = useState(false);
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<TrainingDetail | null>(null);
  const visibleRequestIdRef = useRef(0);
  const silentRequestIdRef = useRef(0);
  const displayedMonthRef = useRef<string | undefined>(undefined);
  const stalePollAttemptsRef = useRef(0);
  const stalePollMonthRef = useRef<string | undefined>(undefined);

  const loadDashboard = useCallback(
    async (
      target: string | undefined,
      forceRefresh = false,
      silent = false,
    ) => {
      const requestId = silent
        ? ++silentRequestIdRef.current
        : ++visibleRequestIdRef.current;
      const visibleRequestIdAtStart = visibleRequestIdRef.current;
      const previousMonth = displayedMonthRef.current;
      if (!silent) {
        silentRequestIdRef.current += 1;
        setLoading(true);
        setError('');
        setNotice('');
        setDetail(null);
      }
      const isCurrentRequest = () =>
        silent
          ? requestId === silentRequestIdRef.current &&
            visibleRequestIdAtStart === visibleRequestIdRef.current &&
            displayedMonthRef.current === target
          : requestId === visibleRequestIdRef.current;
      try {
        const data = await getCampusTrainingDashboard(target, forceRefresh);
        if (!isCurrentRequest()) return;
        if (!isCampusTrainingDashboardResponse(data)) {
          throw new Error('Invalid campus training dashboard response');
        }
        setDashboard(data);
        setMonth(data.month);
        displayedMonthRef.current = data.month;
        if (forceRefresh && data.sourceStatus === 'fresh') {
          setNotice('培训数据已重新加载');
        }
      } catch {
        if (!isCurrentRequest()) return;
        if (!silent) {
          setMonth(previousMonth);
          setError('培训数据加载失败，请稍后重试');
        }
      } finally {
        if (!silent && requestId === visibleRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadDashboard(defaultMonthRef.current, false);
    return () => {
      visibleRequestIdRef.current += 1;
      silentRequestIdRef.current += 1;
    };
  }, [loadDashboard]);

  const dashboardMonth = dashboard?.month;
  const dashboardSourceStatus = dashboard?.sourceStatus;
  useEffect(() => {
    if (!dashboardMonth || dashboardSourceStatus !== 'stale' || loading) {
      stalePollAttemptsRef.current = 0;
      stalePollMonthRef.current = dashboardMonth;
      return undefined;
    }
    if (stalePollMonthRef.current !== dashboardMonth) {
      stalePollAttemptsRef.current = 0;
      stalePollMonthRef.current = dashboardMonth;
    }

    const timer = window.setInterval(() => {
      if (stalePollAttemptsRef.current >= 20) {
        window.clearInterval(timer);
        return;
      }
      stalePollAttemptsRef.current += 1;
      void loadDashboard(dashboardMonth, false, true);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [dashboardMonth, dashboardSourceStatus, loadDashboard, loading]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const detailCache = useMemo(() => {
    const metricDetails = new Map<TrainingMetricKey, TrainingDetail>();
    const participationDetails = new Map<string, TrainingDetail>();
    const newHireDetails = new Map<string, TrainingDetail>();
    if (!dashboard) {
      return {
        metricDetails,
        participationDetails,
        newHireDetails,
        overviewDetail: null,
        progressDetail: null,
        newHirePlanListDetail: null,
        sharingDetail: null,
      };
    }

    METRIC_DEFINITIONS.forEach((definition) => {
      metricDetails.set(
        definition.key,
        buildMetricDetail(definition.key, dashboard),
      );
    });
    dashboard.participation.forEach((item) => {
      participationDetails.set(
        item.building,
        buildParticipationDetail(item.building, dashboard),
      );
    });
    dashboard.newHirePlans.forEach((item) => {
      newHireDetails.set(item.id, buildNewHireDetail(item));
    });

    return {
      metricDetails,
      participationDetails,
      newHireDetails,
      overviewDetail: buildOverviewDetail(dashboard),
      progressDetail: buildProgressDetail(dashboard),
      newHirePlanListDetail: buildNewHirePlanListDetail(
        dashboard.newHirePlans,
        dashboard,
      ),
      sharingDetail: buildSharingDetail(dashboard),
    };
  }, [dashboard]);

  const frameStyle = compact
    ? undefined
    : {
        width: STAGE_WIDTH * scale,
        height: STAGE_HEIGHT * scale,
      };
  const stageStyle = compact
    ? undefined
    : {
        width: STAGE_WIDTH,
        height: STAGE_HEIGHT,
        transform: 'scale(' + String(scale) + ')',
      };

  const handleMonthChange = (value: string) => {
    if (!isTrainingMonth(value)) return;
    setMonth(value);
    setShowAllNewHires(false);
    void loadDashboard(value, false);
  };
  const selectableMonths =
    dashboard?.availableMonths.filter(
      (availableMonth) => availableMonth <= currentTrainingMonth(),
    ) ?? [];
  const handleRefresh = useCallback(() => {
    void loadDashboard(month, true);
  }, [loadDashboard, month]);
  const headerUpdatedAt = useMemo(
    () =>
      formatTrainingTimestamp(
        dashboard ? dashboard.sourceUpdatedAt || dashboard.syncedAt : null,
      ),
    [dashboard],
  );

  useEffect(() => {
    onHeaderStateChange?.({
      updatedAt: headerUpdatedAt,
      refreshing: loading,
      refresh: handleRefresh,
    });
  }, [handleRefresh, headerUpdatedAt, loading, onHeaderStateChange]);

  return (
    <main
      className={`campus-training-dashboard${
        embedded ? ' campus-training-dashboard-embedded' : ''
      }`}
      aria-label="园区培训进展看板"
      aria-busy={loading}
    >
      <div className="training-dashboard-frame" style={frameStyle}>
        <section
          className="training-dashboard-stage"
          data-screenshot-target="campus-training-dashboard"
          data-screenshot-ready={dashboard && !loading ? 'true' : 'false'}
          style={stageStyle}
        >
          <header className="training-dashboard-header">
            {!embedded ? (
              <div className="training-dashboard-title-group">
                <span
                  className="training-dashboard-brand-icon"
                  aria-hidden="true"
                >
                  <GraduationCap />
                </span>
                <h1>培训进展看板</h1>
              </div>
            ) : null}
            <div className="training-header-actions">
              <nav className="training-view-tabs" aria-label="培训看板视图">
                <button
                  type="button"
                  className="training-view-tab training-view-tab-active"
                  aria-current="page"
                  aria-haspopup="dialog"
                  onClick={() => setDetail(detailCache.overviewDetail)}
                >
                  员工培训概览
                </button>
              </nav>
              <div className="training-dashboard-controls">
                {dashboard ? (
                  <Select
                    value={month}
                    onValueChange={handleMonthChange}
                    disabled={loading}
                  >
                    <SelectTrigger
                      className="training-month-trigger"
                      aria-label="统计月份"
                    >
                      <CalendarDays aria-hidden="true" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="training-month-content">
                      {selectableMonths.map((availableMonth) => (
                        <SelectItem key={availableMonth} value={availableMonth}>
                          {formatTrainingMonth(availableMonth)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {!embedded ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="training-refresh-button"
                    disabled={loading}
                    onClick={handleRefresh}
                  >
                    <RefreshCw
                      className={
                        loading ? 'training-refresh-icon-loading' : undefined
                      }
                      aria-hidden="true"
                    />
                    刷新
                  </Button>
                ) : null}
              </div>
            </div>
          </header>

          {!dashboard ? (
            error ? (
              <section
                className="training-dashboard-state training-dashboard-error"
                role="alert"
              >
                <TriangleAlert aria-hidden="true" />
                <h2>培训数据暂时无法加载</h2>
                <p>{error}</p>
                <Button
                  type="button"
                  onClick={() => void loadDashboard(month, true)}
                >
                  重新加载
                </Button>
              </section>
            ) : (
              <section
                className="training-dashboard-state training-dashboard-loading"
                role="status"
                aria-live="polite"
              >
                <RefreshCw
                  className="training-refresh-icon-loading"
                  aria-hidden="true"
                />
                <h2>正在加载培训数据</h2>
                <p>正在同步在岗员工、新员工与分享会数据…</p>
              </section>
            )
          ) : dashboard.dataStatus === 'empty' ? (
            <section
              className="training-dashboard-state training-dashboard-empty"
              role="status"
              aria-live="polite"
            >
              <BookOpenCheck aria-hidden="true" />
              <h2>{formatTrainingMonth(dashboard.month)} 暂无培训数据</h2>
              <p>该月份没有可展示的培训记录，可以切换月份或重新加载。</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadDashboard(month, true)}
              >
                重新加载
              </Button>
            </section>
          ) : (
            <>
              <section
                className="training-metric-grid"
                aria-label="培训摘要指标"
              >
                {METRIC_DEFINITIONS.map((definition) => (
                  <MetricCard
                    key={definition.key}
                    definition={definition}
                    value={dashboard.summary[definition.key]}
                    comparison={dashboard.metricComparisons[definition.key]}
                    trend={dashboard.metricTrends[definition.key]}
                    onOpen={() =>
                      setDetail(
                        detailCache.metricDetails.get(definition.key) ?? null,
                      )
                    }
                  />
                ))}
              </section>

              <section className="training-primary-grid">
                <TrainingProgressChart
                  data={dashboard.progress}
                  onOpen={() => setDetail(detailCache.progressDetail)}
                />
                <ParticipationPanel
                  data={dashboard.participation}
                  onRowOpen={(item) =>
                    setDetail(
                      detailCache.participationDetails.get(item.building) ??
                        null,
                    )
                  }
                  onOpenAll={() =>
                    setDetail(
                      detailCache.metricDetails.get('monthlyParticipants') ??
                        null,
                    )
                  }
                />
              </section>

              <section className="training-secondary-grid">
                <NewHirePlanPanel
                  data={dashboard.newHirePlans}
                  expanded={showAllNewHires}
                  onToggle={() => setShowAllNewHires((current) => !current)}
                  onRowOpen={(item) =>
                    setDetail(detailCache.newHireDetails.get(item.id) ?? null)
                  }
                  onOpenAll={() => setDetail(detailCache.newHirePlanListDetail)}
                />
                <SharingPanel
                  sharing={dashboard.sharing}
                  onOpen={() => setDetail(detailCache.sharingDetail)}
                />
              </section>
            </>
          )}

          {loading && dashboard ? (
            <div
              className="training-dashboard-loading training-dashboard-state-banner"
              role="status"
              aria-live="polite"
            >
              <RefreshCw
                className="training-refresh-icon-loading"
                aria-hidden="true"
              />
              正在加载 {formatTrainingMonth(month)}…
            </div>
          ) : null}

          {error && dashboard ? (
            <div
              className="training-dashboard-error training-dashboard-state-banner"
              role="alert"
            >
              <TriangleAlert aria-hidden="true" />
              <span>{error}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void loadDashboard(month, true)}
              >
                重新加载
              </Button>
            </div>
          ) : null}

          {dashboard?.sourceStatus === 'stale' ? (
            <div
              className="training-dashboard-stale training-dashboard-state-banner"
              role="status"
            >
              <TriangleAlert aria-hidden="true" />
              {dashboard.errorMessage || '源数据同步失败，已展示上次成功结果'}
            </div>
          ) : null}

          {notice ? (
            <div
              className="training-dashboard-notice"
              role="status"
              aria-live="polite"
            >
              <BookOpenCheck aria-hidden="true" />
              {notice}
            </div>
          ) : null}
        </section>
      </div>
      <TrainingDetailDialog
        detail={detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      />
    </main>
  );
}
