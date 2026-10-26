import {
  Activity,
  AlarmClock,
  BellRing,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  Clock3,
  Droplets,
  Gauge,
  History,
  LockKeyhole,
  Megaphone,
  Minus,
  PanelsTopLeft,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Siren,
  Star,
  Tag,
  TrendingDown,
  TrendingUp,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import {
  getYearlySealingInfo,
  getTodayOperationsAlarmDashboard,
  getTodayOperationsKpis,
  getTodayOperationsOverview,
} from '@/api';
import { useAccess } from '@/access/AccessProvider';
import { AlarmAiConnectionBadge } from '@/components/AlarmAiConnectionBadge';
import { useNantongAssistantPageSummary } from '@/components/NantongAssistantHost';
import { Button } from '@/components/ui/button';
import { useTodayAttendanceSnapshot } from '@/components/attendance/use-today-attendance';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type {
  TodayOperationsAlarmDashboardResponse,
  TodayOperationsAlarmItem,
  TodayOperationsAlarmLevel,
  TodayOperationsAlarmMetric,
  TodayOperationsAlarmProcessingStatus,
  TodayOperationsAlarmRecoveryStatus,
} from '@shared/today-operations-alarm.interface';
import type {
  TodayOperationsOverviewResponse,
  TodayOperationsWorkDetails,
  TodayOperationsWorkKind,
} from '@shared/today-operations-overview.interface';
import type { TodayOperationsKpiResponse } from '@shared/today-operations-kpi.interface';
import type { SealingInfo } from '@shared/api.interface';
import type { NantongAssistantContext } from '@shared/nantong-assistant.interface';

import { buildAlarmKpis, formatAlarmDateTime } from './alarm-model';
import type { AlarmChartSelection } from './alarm-chart-model';
import { AlarmDetailDialog } from './AlarmDetailDialog';
import { AlarmTagAnomalyDialog } from './AlarmTagAnomalyDialog';
import {
  BuildingMetricDetailDialog,
  type BuildingMetricKey,
} from './BuildingMetricDetailDialog';
import {
  beginAlarmRequest,
  completeAlarmRequest,
  createInitialAlarmRequestState,
  failAlarmRequest,
  getAlarmPaginationDisabledState,
  isAlarmListRequestPending,
} from './alarm-request-state';
import { formatShanghaiBusinessDateKey } from './business-date';
import {
  RackLoadChart,
  RackUsageGauge,
  SevenDayAlarmChart,
  YesterdayAlarmChart,
} from './charts';
import { KpiComparisonMarquee } from './KpiComparisonMarquee';
import { RackUsageDetailDialog } from './RackUsageDetailDialog';
import {
  PANORAMA_MAINTENANCE_CARDS,
  type MaintenanceCard,
  type PanoramaKpi,
  type PanoramaRackSummary,
} from './data';
import {
  buildMaintenanceCards,
  buildNetworkFreezeDetailModel,
  buildOperationsTickerItems,
  buildRackSummary,
  getNetworkFreezeQueryYears,
  reconcileOverviewChangeSnapshot,
  type NetworkFreezeDetailModel,
  type NetworkFreezeSummary,
  type OperationsTickerItem,
} from './overview-model';
import { buildOverviewSourceNotice } from './overview-source-status';
import { OnDutyPeopleDialog } from './OnDutyPeopleDialog';
import { OperationsDetailDialog } from './OperationsDetailDialog';
import { OperationsPanels } from './OperationsPanels';
import { SealingDetailDialog } from './SealingDetailDialog';
import {
  buildOnDutyDialogModel,
  buildTopKpiPlaceholders,
  buildTopKpis,
  resolveShanghaiOnDutyLeadShift,
} from './top-kpi-model';

import './styles.css';

const KPI_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  alarm: AlarmClock,
  bell: BellRing,
  calendar: CalendarDays,
  gauge: Gauge,
  history: History,
  lock: LockKeyhole,
  panels: PanelsTopLeft,
  refresh: RefreshCw,
  server: Server,
  shield: ShieldCheck,
  siren: Siren,
  star: Star,
  tag: Tag,
  users: Users,
  wrench: Wrench,
  zap: Zap,
  water: Droplets,
};

const PAGE_SIZE = 5;
const OPERATIONS_TICK_INTERVAL_MS = 7000;
const TOP_KPI_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const OVERVIEW_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SEALING_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const ALARM_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const ALARM_DETAIL_CONFIG: Record<
  string,
  { metric: TodayOperationsAlarmMetric; title: string }
> = {
  'alarms-seven-days': { metric: 'all', title: '近7天告警清单' },
  'alarms-expected': { metric: 'expected', title: '预期内告警清单' },
  'alarms-unexpected': { metric: 'unexpected', title: '预期外告警清单' },
  'alarms-yesterday': { metric: 'yesterday', title: '昨日告警清单' },
  'alarms-double-unhandled': {
    metric: 'doubleUnhandled',
    title: '双未告警清单',
  },
  'alarms-pending': { metric: 'pending', title: '待处理告警清单' },
};

function formatShanghaiClock(date: Date) {
  const dateText = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-');
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(date);
  return { dateText, weekday };
}

function resolveIcon(icon: string): LucideIcon {
  return KPI_ICONS[icon] || Activity;
}

function directionIcon(direction: 'up' | 'down' | 'neutral'): LucideIcon {
  if (direction === 'up') return TrendingUp;
  if (direction === 'down') return TrendingDown;
  return Minus;
}

function KpiSignal({
  direction,
  label,
}: {
  direction: 'up' | 'down' | 'neutral';
  label: string;
}) {
  const SignalIcon = directionIcon(direction);
  const statusLabel =
    direction === 'up' ? '上升' : direction === 'down' ? '下降' : '稳定';

  return (
    <span
      className="today-panorama-kpi-signal"
      data-direction={direction}
      role="img"
      aria-label={`${label}${statusLabel}`}
    >
      <SignalIcon aria-hidden="true" />
    </span>
  );
}

function KpiCard({
  item,
  onClick,
}: {
  item: PanoramaKpi;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const comparisonId = useId();
  const Icon = resolveIcon(item.icon);
  const DirectionIcon = directionIcon(item.direction);
  const compactValue = item.value.replace(/[^\d]/g, '').length >= 7;
  const className = `today-panorama-card today-panorama-kpi-card today-panorama-tone-${item.tone}${compactValue ? ' is-compact-value' : ''}${onClick ? ' is-interactive' : ''}`;
  const content = (
    <>
      <span className="today-panorama-kpi-icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="today-panorama-kpi-copy">
        <p className="today-panorama-kpi-title">
          <span>{item.title}</span>
          {item.helpText ? (
            <span className="today-panorama-kpi-help" aria-hidden="true">
              ?
            </span>
          ) : null}
        </p>
        <div className="today-panorama-kpi-value">
          <strong>{item.value}</strong>
          {item.unit ? <span>{item.unit}</span> : null}
        </div>
        <p
          className="today-panorama-kpi-comparison"
          data-direction={item.direction}
        >
          {item.key === 'on-duty' ? null : <DirectionIcon aria-hidden="true" />}
          <KpiComparisonMarquee
            id={comparisonId}
            text={item.comparison}
            focusable={!onClick && !item.helpText}
          />
        </p>
      </div>
      <KpiSignal direction={item.direction} label={item.title} />
    </>
  );
  const card = onClick ? (
    <button
      type="button"
      className={className}
      aria-label={`查看${item.title}具体清单`}
      aria-describedby={comparisonId}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <article className={className} tabIndex={item.helpText ? 0 : undefined}>
      {content}
    </article>
  );

  return item.helpText ? (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      <TooltipContent sideOffset={8} className="max-w-72">
        {item.helpText}
      </TooltipContent>
    </Tooltip>
  ) : (
    card
  );
}

type OverviewLoadState = 'loading' | 'ready' | 'error';

function OperationsTicker({
  items,
  loadState,
}: {
  items: readonly OperationsTickerItem[];
  loadState: OverviewLoadState;
}) {
  const visibleItems = useMemo<OperationsTickerItem[]>(
    () =>
      items.length > 0
        ? [...items]
        : [
            {
              key: loadState,
              label:
                loadState === 'loading'
                  ? '正在读取运维概况'
                  : '运维概况暂时无法读取',
              detail:
                loadState === 'loading'
                  ? '数据加载完成后将自动轮播重点事项'
                  : '请稍后重新读取',
              tone: 'info',
            },
          ],
    [items, loadState],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [manualPaused, setManualPaused] = useState(false);
  const [hoverPaused, setHoverPaused] = useState(false);
  const [focusPaused, setFocusPaused] = useState(false);
  const isPaused = manualPaused || hoverPaused || focusPaused;
  const activeItem = visibleItems[activeIndex % visibleItems.length];

  useEffect(() => {
    setActiveIndex(0);
  }, [visibleItems]);

  useEffect(() => {
    if (isPaused || visibleItems.length <= 1) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setActiveIndex((index) => (index + 1) % visibleItems.length);
    }, OPERATIONS_TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isPaused, visibleItems.length]);

  return (
    <section
      className="today-panorama-operations-ticker"
      data-tone={activeItem.tone}
      data-emphasis={activeItem.isKey ? 'key' : undefined}
      aria-label="运维重点事项轮播"
      onMouseEnter={() => setHoverPaused(true)}
      onMouseLeave={() => setHoverPaused(false)}
      onFocusCapture={() => setFocusPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusPaused(false);
        }
      }}
    >
      <span className="today-panorama-ticker-icon" aria-hidden="true">
        <Megaphone />
      </span>
      <p
        className="today-panorama-ticker-copy"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="today-panorama-ticker-content" key={activeItem.key}>
          <span className="today-panorama-ticker-heading">
            {activeItem.isKey ? (
              <b className="today-panorama-ticker-key-badge">重点</b>
            ) : null}
            <strong>{activeItem.label}</strong>
          </span>
          <span className="today-panorama-ticker-detail">
            {activeItem.detail}
          </span>
        </span>
      </p>
      <span className="today-panorama-ticker-progress" aria-hidden="true">
        {(activeIndex % visibleItems.length) + 1} / {visibleItems.length}
      </span>
      <button
        type="button"
        className="today-panorama-ticker-control"
        aria-label={manualPaused ? '继续轮播重点事项' : '暂停轮播重点事项'}
        aria-pressed={manualPaused}
        onClick={() => setManualPaused((paused) => !paused)}
      >
        {manualPaused ? (
          <Play aria-hidden="true" />
        ) : (
          <Pause aria-hidden="true" />
        )}
      </button>
    </section>
  );
}

function SectionHeading({ index, title }: { index: string; title: string }) {
  return (
    <div className="today-panorama-section-heading">
      <b>{index}</b>
      <h2>{title}</h2>
    </div>
  );
}

function MaintenanceOverview({
  cards,
  details,
  networkFreezeDetails,
  sealingLoadState,
}: {
  cards: readonly MaintenanceCard[];
  details: TodayOperationsWorkDetails;
  networkFreezeDetails: NetworkFreezeDetailModel | null;
  sealingLoadState: OverviewLoadState;
}) {
  const [detailKind, setDetailKind] = useState<TodayOperationsWorkKind | null>(
    null,
  );
  const [sealingDialogOpen, setSealingDialogOpen] = useState(false);
  const operationsDetailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sealingDetailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const onOpenDetails = (
    event: ReactMouseEvent<HTMLButtonElement>,
    kind: TodayOperationsWorkKind,
  ) => {
    operationsDetailTriggerRef.current = event.currentTarget;
    setDetailKind(kind);
  };

  return (
    <section className="today-panorama-card today-panorama-section-card">
      <SectionHeading index="02" title="运维概况一览" />
      <div className="today-panorama-maintenance-grid">
        {cards.map((item) => {
          const Icon = resolveIcon(item.icon);
          const isNetworkFreeze = item.key === 'network-freeze';
          const isInteractive =
            !item.sourceUnavailable &&
            ((isNetworkFreeze && networkFreezeDetails?.status === 'ready') ||
              item.key in details);
          const content = (
            <>
              <span className="today-panorama-maintenance-head">
                <span className="today-panorama-maintenance-icon" aria-hidden>
                  <Icon />
                </span>
                <span
                  className="today-panorama-maintenance-title"
                  role="heading"
                  aria-level={3}
                >
                  {item.title}
                </span>
                <span className="today-panorama-maintenance-count">
                  {item.sourceUnavailable ? '--' : item.count}
                </span>
              </span>
              <span className="today-panorama-maintenance-body">
                {item.rows.map((row) => (
                  <span
                    className="today-panorama-maintenance-row"
                    key={row.label}
                  >
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </span>
                ))}
              </span>
              <span className="today-panorama-maintenance-footer">
                {item.footer}
              </span>
            </>
          );
          const className = `today-panorama-maintenance-card${item.featured ? ' is-featured' : ''}${isInteractive ? ' is-interactive' : ''}${item.sourceUnavailable ? ' is-unavailable' : ''}`;
          return isInteractive ? (
            <button
              type="button"
              className={className}
              data-tone={item.tone}
              key={item.key}
              aria-label={`查看${item.title}具体清单`}
              onClick={(event) => {
                if (isNetworkFreeze) {
                  sealingDetailTriggerRef.current = event.currentTarget;
                  setSealingDialogOpen(true);
                  return;
                }
                onOpenDetails(event, item.key as TodayOperationsWorkKind);
              }}
            >
              {content}
            </button>
          ) : (
            <article className={className} data-tone={item.tone} key={item.key}>
              {content}
            </article>
          );
        })}
      </div>
      <OperationsDetailDialog
        open={detailKind !== null}
        onOpenChange={(open) => {
          if (!open) setDetailKind(null);
        }}
        kind={detailKind ?? 'events'}
        items={detailKind ? details[detailKind] : []}
        restoreFocusTo={operationsDetailTriggerRef.current}
      />
      {networkFreezeDetails ? (
        <SealingDetailDialog
          open={sealingDialogOpen}
          onOpenChange={setSealingDialogOpen}
          model={networkFreezeDetails}
          loadState={sealingLoadState}
          restoreFocusTo={sealingDetailTriggerRef.current}
        />
      ) : null}
    </section>
  );
}

function RackOverview({
  summary,
  stale,
  retrying,
  onRetry,
}: {
  summary: PanoramaRackSummary;
  stale: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [rackUsageDialogOpen, setRackUsageDialogOpen] = useState(false);
  const rackUsageTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section className="today-panorama-card today-panorama-section-card">
      <SectionHeading index="01" title="机柜使用概览" />
      <div className="today-panorama-rack-top">
        <button
          type="button"
          ref={rackUsageTriggerRef}
          className="today-panorama-rack-gauge"
          aria-label="查看各楼机柜上架率明细"
          aria-haspopup="dialog"
          aria-expanded={rackUsageDialogOpen}
          onClick={() => setRackUsageDialogOpen(true)}
        >
          <span className="today-panorama-rack-gauge-chart">
            <RackUsageGauge value={summary.usageRate} />
          </span>
          <span className="today-panorama-rack-gauge-caption">
            上线 <strong>{summary.online.toLocaleString()}</strong>
            {' / '}总计 {summary.total.toLocaleString()}
          </span>
          <span className="today-panorama-rack-gauge-hint">
            点击查看各楼明细
          </span>
        </button>
        <div className="today-panorama-rack-stats">
          <article className="today-panorama-rack-stat">
            <Server aria-hidden />
            <div>
              <p>机柜上电数量（本周）</p>
              <strong>{summary.onlineThisPeriod}</strong>
            </div>
            <span>环比 {summary.onlineDelta}</span>
          </article>
          <article className="today-panorama-rack-stat is-offline">
            <CircleGauge aria-hidden />
            <div>
              <p>机柜下电数量（本周）</p>
              <strong>{summary.offlineThisPeriod}</strong>
            </div>
            <span>环比 {summary.offlineDelta}</span>
          </article>
        </div>
      </div>
      <div className="today-panorama-rack-chart-block">
        <p className="today-panorama-chart-subtitle">各楼IT负载率</p>
        <div className="today-panorama-rack-chart">
          <RackLoadChart data={summary.buildingLoads} />
        </div>
      </div>
      <RackUsageDetailDialog
        summary={summary}
        open={rackUsageDialogOpen}
        onOpenChange={setRackUsageDialogOpen}
        stale={stale}
        retrying={retrying}
        onRetry={onRetry}
        restoreFocusTo={rackUsageTriggerRef.current}
      />
    </section>
  );
}

function OverviewDataStateCard({
  index,
  title,
  loadState,
  onRetry,
}: {
  index: string;
  title: string;
  loadState: OverviewLoadState;
  onRetry: () => void;
}) {
  const loading = loadState === 'loading';
  return (
    <section className="today-panorama-card today-panorama-section-card">
      <SectionHeading index={index} title={title} />
      <div
        className={`today-panorama-source-state ${
          loading ? 'is-loading' : 'is-error'
        }`}
        role="status"
      >
        <span>
          {loading
            ? '正在读取飞书运行概览数据'
            : '飞书运行概览数据暂时无法读取，请稍后重试'}
        </span>
        {!loading ? (
          <Button type="button" variant="outline" onClick={onRetry}>
            <RefreshCw aria-hidden />
            重新读取
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function AlarmCharts({
  data,
  onSelect,
}: {
  data: TodayOperationsAlarmDashboardResponse;
  onSelect: (selection: AlarmChartSelection) => void;
}) {
  const {
    yesterdayExpectedTotal,
    yesterdayUnexpectedTotal,
    yesterdayUnclassifiedTotal,
    yesterdayTotal,
  } = data.summary;

  return (
    <section className="today-panorama-alarm-charts">
      <article className="today-panorama-card today-panorama-chart-card">
        <header className="today-panorama-panel-header">
          <div className="today-panorama-panel-title">
            <Activity aria-hidden />
            <h2>近7天告警一览</h2>
          </div>
          <div className="today-panorama-chart-legend" aria-label="图例">
            <span>
              <i />
              预期内
            </span>
            <span>
              <i className="is-orange" />
              预期外
            </span>
            <span>
              <i className="is-muted" />
              未分类
            </span>
            <span>单位：条</span>
          </div>
        </header>
        <div className="today-panorama-alarm-chart">
          <SevenDayAlarmChart
            data={data.sevenDayByBuilding}
            onSelect={onSelect}
          />
        </div>
      </article>

      <article className="today-panorama-card today-panorama-chart-card">
        <header className="today-panorama-panel-header">
          <div className="today-panorama-panel-title">
            <Activity aria-hidden />
            <h2>昨日告警一览</h2>
          </div>
          <div className="today-panorama-chart-legend" aria-label="图例">
            <span>
              <i />
              预期内
            </span>
            <span>
              <i className="is-orange" />
              预期外
            </span>
            <span>
              <i className="is-muted" />
              未分类
            </span>
            <span>单位：条</span>
          </div>
        </header>
        <div className="today-panorama-yesterday-layout">
          <div className="today-panorama-alarm-chart">
            <YesterdayAlarmChart
              data={data.yesterdayByBuilding}
              onSelect={onSelect}
            />
          </div>
          <aside className="today-panorama-yesterday-summary">
            <h3>昨日告警汇总</h3>
            <div className="today-panorama-summary-list">
              <div className="today-panorama-summary-row">
                <span>预期内</span>
                <strong>{yesterdayExpectedTotal}</strong>
              </div>
              <div className="today-panorama-summary-row">
                <span>预期外</span>
                <strong>{yesterdayUnexpectedTotal}</strong>
              </div>
              <div className="today-panorama-summary-row">
                <span>未分类</span>
                <strong>{yesterdayUnclassifiedTotal}</strong>
              </div>
            </div>
            <div className="today-panorama-summary-total">
              <span>合计</span>
              <strong>{yesterdayTotal}</strong>
            </div>
          </aside>
        </div>
      </article>
    </section>
  );
}

function levelClass(level: TodayOperationsAlarmItem['level']) {
  const normalizedLevel = level.trim();
  if (['紧急', '严重', '高危'].includes(normalizedLevel)) {
    return 'today-panorama-level-high';
  }
  if (['重要', '中危'].includes(normalizedLevel)) {
    return 'today-panorama-level-medium';
  }
  if (['次要', '预警', '低危'].includes(normalizedLevel)) {
    return 'today-panorama-level-low';
  }
  return 'today-panorama-level-unknown';
}

function statusClass(value: string) {
  const normalizedStatus = value.trim();
  if (['已确认', '已处理', '已恢复', '已关闭'].includes(normalizedStatus)) {
    return 'today-panorama-status-confirmed';
  }
  if (normalizedStatus === '处理中') {
    return 'today-panorama-status-processing';
  }
  if (['未处理', '未恢复'].includes(normalizedStatus)) {
    return 'today-panorama-status-unrecovered';
  }
  return 'today-panorama-status-pending';
}

function AlarmTable({
  data,
  loading,
  building,
  level,
  processingStatus,
  recoveryStatus,
  queryDraft,
  onBuildingChange,
  onLevelChange,
  onProcessingStatusChange,
  onRecoveryStatusChange,
  onQueryDraftChange,
  onSearch,
  onReset,
  onPageChange,
}: {
  data: TodayOperationsAlarmDashboardResponse;
  loading: boolean;
  building: string;
  level: 'all' | TodayOperationsAlarmLevel;
  processingStatus: 'all' | TodayOperationsAlarmProcessingStatus;
  recoveryStatus: 'all' | TodayOperationsAlarmRecoveryStatus;
  queryDraft: string;
  onBuildingChange: (value: string) => void;
  onLevelChange: (value: 'all' | TodayOperationsAlarmLevel) => void;
  onProcessingStatusChange: (
    value: 'all' | TodayOperationsAlarmProcessingStatus,
  ) => void;
  onRecoveryStatusChange: (
    value: 'all' | TodayOperationsAlarmRecoveryStatus,
  ) => void;
  onQueryDraftChange: (value: string) => void;
  onSearch: () => void;
  onReset: () => void;
  onPageChange: (page: number) => void;
}) {
  const visibleRows = data.page.items;
  const totalPages = Math.max(1, data.page.totalPages);
  const currentPage = Math.min(data.page.page, totalPages);
  const paginationDisabled = getAlarmPaginationDisabledState({
    currentPage,
    totalPages,
    pending: loading,
  });

  return (
    <section className="today-panorama-card today-panorama-table-card">
      <div className="today-panorama-table-toolbar">
        <div className="today-panorama-panel-title">
          <BellRing aria-hidden />
          <h2>近期告警信息清单</h2>
        </div>
        <Select value={building} onValueChange={onBuildingChange}>
          <SelectTrigger aria-label="楼栋筛选">
            <SelectValue placeholder="楼栋：全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">楼栋：全部</SelectItem>
            {data.options.buildings.map((item) => (
              <SelectItem value={item} key={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={level}
          onValueChange={(value) =>
            onLevelChange(value as 'all' | TodayOperationsAlarmLevel)
          }
        >
          <SelectTrigger aria-label="等级筛选">
            <SelectValue placeholder="等级：全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">等级：全部</SelectItem>
            {data.options.levels.map((item) => (
              <SelectItem value={item} key={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={processingStatus}
          onValueChange={(value) =>
            onProcessingStatusChange(
              value as 'all' | TodayOperationsAlarmProcessingStatus,
            )
          }
        >
          <SelectTrigger aria-label="处理状态筛选">
            <SelectValue placeholder="处理：全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">处理：全部</SelectItem>
            {data.options.processingStatuses.map((item) => (
              <SelectItem value={item} key={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={recoveryStatus}
          onValueChange={(value) =>
            onRecoveryStatusChange(
              value as 'all' | TodayOperationsAlarmRecoveryStatus,
            )
          }
        >
          <SelectTrigger aria-label="恢复状态筛选">
            <SelectValue placeholder="恢复：全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">恢复：全部</SelectItem>
            {data.options.recoveryStatuses.map((item) => (
              <SelectItem value={item} key={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="ghost" onClick={onReset}>
          <RefreshCw aria-hidden />
          重置
        </Button>
        <div className="today-panorama-search-wrap">
          <Input
            value={queryDraft}
            onChange={(event) => {
              onQueryDraftChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch();
            }}
            name="alarm-search"
            autoComplete="off"
            placeholder="请输入异常描述、设备或受理人…"
            aria-label="搜索近期告警"
          />
          <Search aria-hidden />
        </div>
        <Button type="button" onClick={onSearch}>
          <Search aria-hidden />
          筛选
        </Button>
      </div>

      <div
        className={`today-panorama-table-scroll${loading ? ' today-panorama-loading' : ''}`}
        aria-busy={loading}
      >
        {visibleRows.length === 0 ? (
          <div className="today-panorama-empty">当前筛选条件下暂无告警记录</div>
        ) : (
          <table className="today-panorama-table">
            <caption className="sr-only">近期告警信息清单</caption>
            <colgroup>
              <col style={{ width: '17%' }} />
              <col style={{ width: '6%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '10%' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">异常描述</th>
                <th scope="col">等级</th>
                <th scope="col">产生时间</th>
                <th scope="col">受理时间</th>
                <th scope="col">受理描述</th>
                <th scope="col">确认人</th>
                <th scope="col">确认状态</th>
                <th scope="col">处理状态</th>
                <th scope="col">恢复状态</th>
                <th scope="col">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id}>
                  <td title={row.description}>{row.description}</td>
                  <td>
                    <span
                      className={`today-panorama-status-badge ${levelClass(row.level)}`}
                    >
                      {row.level}
                    </span>
                  </td>
                  <td>{formatAlarmDateTime(row.occurredAt)}</td>
                  <td>{formatAlarmDateTime(row.acceptedAt)}</td>
                  <td title={row.handlingDescription}>
                    {row.handlingDescription}
                  </td>
                  <td>{row.owner}</td>
                  <td>
                    <span
                      className={`today-panorama-status-badge ${statusClass(row.confirmationStatus)}`}
                    >
                      {row.confirmationStatus}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`today-panorama-status-badge ${statusClass(row.processingStatus)}`}
                    >
                      {row.processingStatus}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`today-panorama-status-badge ${statusClass(row.recoveryStatus)}`}
                    >
                      {row.recoveryStatus}
                    </span>
                  </td>
                  <td>{formatAlarmDateTime(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="today-panorama-table-footer">
        <span>共 {data.page.total} 条</span>
        <button
          className="today-panorama-page-button"
          type="button"
          aria-label="上一页"
          disabled={paginationDisabled.previous}
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        >
          <ChevronLeft aria-hidden />
        </button>
        <span className="today-panorama-page-number">{currentPage}</span>
        <span>/ {totalPages}</span>
        <button
          className="today-panorama-page-button"
          type="button"
          aria-label="下一页"
          disabled={paginationDisabled.next}
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        >
          <ChevronRight aria-hidden />
        </button>
        <span>{data.page.pageSize} 条/页</span>
      </footer>
    </section>
  );
}

function AlarmOverview({
  allowForceRefresh,
  manualRefreshToken,
  onReadyChange,
}: {
  allowForceRefresh: boolean;
  manualRefreshToken: number;
  onReadyChange: (ready: boolean) => void;
}) {
  const [alarmRequestState, setAlarmRequestState] = useState(() =>
    createInitialAlarmRequestState<TodayOperationsAlarmDashboardResponse>(),
  );
  const loadState = alarmRequestState.loadState;
  const [building, setBuilding] = useState('all');
  const [level, setLevel] = useState<'all' | TodayOperationsAlarmLevel>('all');
  const [processingStatus, setProcessingStatus] = useState<
    'all' | TodayOperationsAlarmProcessingStatus
  >('all');
  const [recoveryStatus, setRecoveryStatus] = useState<
    'all' | TodayOperationsAlarmRecoveryStatus
  >('all');
  const [query, setQuery] = useState('');
  const [queryDraft, setQueryDraft] = useState('');
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);
  const [tagReviewPollToken, setTagReviewPollToken] = useState(0);
  const [alarmDetail, setAlarmDetail] = useState<{
    metric: TodayOperationsAlarmMetric;
    title: string;
    building?: string;
  } | null>(null);
  const [tagAnomalyDialogOpen, setTagAnomalyDialogOpen] = useState(false);
  const handledRefreshToken = useRef(0);
  const handledManualRefreshToken = useRef(manualRefreshToken);
  const alarmRequestIdRef = useRef(0);
  const requestKey = JSON.stringify({
    building,
    level,
    page,
    processingStatus,
    query,
    recoveryStatus,
  });

  useEffect(() => {
    const timer = window.setInterval(
      () => setRefreshToken((value) => value + 1),
      ALARM_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const review = alarmRequestState.data?.tagReview;
    if (
      !review ||
      (review.state !== 'processing' &&
        !['connecting', 'error', 'unverified'].includes(
          review.connection ?? 'unverified',
        ))
    )
      return;
    const timer = window.setInterval(
      () => setTagReviewPollToken((value) => value + 1),
      review.connection === 'error' ? 60_000 : 15_000,
    );
    return () => window.clearInterval(timer);
  }, [
    alarmRequestState.data?.tagReview.state,
    alarmRequestState.data?.tagReview.connection,
  ]);

  useEffect(() => {
    const requestId = alarmRequestIdRef.current + 1;
    alarmRequestIdRef.current = requestId;
    const forceRefresh =
      allowForceRefresh &&
      (refreshToken > handledRefreshToken.current ||
        manualRefreshToken > handledManualRefreshToken.current);
    handledRefreshToken.current = refreshToken;
    handledManualRefreshToken.current = manualRefreshToken;
    setAlarmRequestState((current) => beginAlarmRequest(current));
    onReadyChange(false);

    void getTodayOperationsAlarmDashboard({
      page,
      pageSize: PAGE_SIZE,
      building: building === 'all' ? undefined : building,
      level: level === 'all' ? undefined : level,
      processingStatus:
        processingStatus === 'all' ? undefined : processingStatus,
      recoveryStatus: recoveryStatus === 'all' ? undefined : recoveryStatus,
      q: query || undefined,
      refresh: forceRefresh,
    })
      .then((nextData) => {
        if (alarmRequestIdRef.current !== requestId) return;
        setAlarmRequestState((current) =>
          completeAlarmRequest(current, {
            isCurrent: alarmRequestIdRef.current === requestId,
            requestKey,
            data: nextData,
          }),
        );
      })
      .catch(() => {
        if (alarmRequestIdRef.current !== requestId) return;
        setAlarmRequestState((current) =>
          failAlarmRequest(current, {
            isCurrent: alarmRequestIdRef.current === requestId,
          }),
        );
      })
      .finally(() => {
        if (alarmRequestIdRef.current === requestId) onReadyChange(true);
      });

    return () => {
      if (alarmRequestIdRef.current === requestId) {
        alarmRequestIdRef.current += 1;
      }
    };
  }, [
    allowForceRefresh,
    building,
    level,
    manualRefreshToken,
    onReadyChange,
    page,
    processingStatus,
    query,
    recoveryStatus,
    refreshToken,
    requestKey,
    tagReviewPollToken,
  ]);

  const visibleData = alarmRequestState.data;
  const listRequestPending = isAlarmListRequestPending(
    alarmRequestState,
    requestKey,
  );
  const alarmKpis = useMemo(
    () =>
      visibleData
        ? buildAlarmKpis(visibleData.summary, visibleData.tagReview)
        : [],
    [visibleData],
  );
  const assistantContext = useMemo<NantongAssistantContext | undefined>(() => {
    if (!visibleData) return undefined;
    const anomalies = new Map(
      visibleData.summary.tagAnomalyByBuilding.map((row) => [
        row.building,
        row.total,
      ]),
    );
    return {
      scope: 'today',
      start: visibleData.window.startDate,
      end: visibleData.window.yesterdayDate,
      total: visibleData.summary.sevenDayTotal,
      pending: visibleData.summary.pendingTotal,
      tagAnomalies: visibleData.summary.tagAnomalyTotal,
      buildings: visibleData.sevenDayByBuilding.map((row) => ({
        name: row.building,
        total: row.total,
        anomalies: anomalies.get(row.building) || 0,
      })),
      review: {
        state: visibleData.tagReview.state,
        reviewed: visibleData.tagReview.reviewed,
        total: visibleData.tagReview.total,
      },
    };
  }, [visibleData]);
  useNantongAssistantPageSummary(assistantContext, '近7天告警');

  const resetFilters = () => {
    setBuilding('all');
    setLevel('all');
    setProcessingStatus('all');
    setRecoveryStatus('all');
    setQuery('');
    setQueryDraft('');
    setPage(1);
  };

  const retry = () => {
    setRefreshToken((value) => value + 1);
  };
  const onKpiClick = (key: string) => {
    if (key === 'alarms-tag-anomaly') {
      setTagAnomalyDialogOpen(true);
      return;
    }
    const detail = ALARM_DETAIL_CONFIG[key];
    if (detail) setAlarmDetail(detail);
  };

  return (
    <section
      className="today-panorama-alarm-overview"
      aria-label="园区近日告警信息总览"
    >
      <div className="today-panorama-alarm-heading">
        <SectionHeading index="03" title="园区近日告警信息总览" />
        {visibleData && (
          <AlarmAiConnectionBadge review={visibleData.tagReview} />
        )}
      </div>

      {loadState === 'loading' && !visibleData ? (
        <div className="today-panorama-source-state is-loading" role="status">
          正在读取飞书近7天告警数据…
        </div>
      ) : null}

      {loadState === 'error' ? (
        <div className="today-panorama-source-state is-error" role="alert">
          <span>
            {visibleData
              ? '飞书连接暂时不可用，当前保留上次已加载数据'
              : '飞书告警数据暂时无法读取，请稍后重试'}
          </span>
          <Button type="button" variant="outline" onClick={retry}>
            <RefreshCw aria-hidden />
            重新读取
          </Button>
        </div>
      ) : null}

      {visibleData?.sourceStatus === 'stale' ? (
        <div className="today-panorama-source-state is-stale" role="status">
          飞书连接暂时不可用，当前显示最近一次成功数据
        </div>
      ) : null}

      {visibleData && visibleData.summary.excludedBuildingTotal > 0 ? (
        <div className="today-panorama-source-state is-info" role="status">
          另有非 A–E 楼栋 {visibleData.summary.excludedBuildingTotal}{' '}
          条；总数已计入，楼栋图表仅展示 A–E 楼
        </div>
      ) : null}

      {visibleData ? (
        <>
          <section
            className="today-panorama-alarm-kpi-grid"
            aria-label="告警摘要"
          >
            {alarmKpis.map((item) => (
              <KpiCard
                item={item}
                key={item.key}
                onClick={() => onKpiClick(item.key)}
              />
            ))}
          </section>
          <AlarmCharts
            data={visibleData}
            onSelect={(selection) =>
              setAlarmDetail({
                metric: selection.metric,
                title: selection.title,
                building: selection.building,
              })
            }
          />
          <AlarmTable
            data={visibleData}
            loading={listRequestPending}
            building={building}
            level={level}
            processingStatus={processingStatus}
            recoveryStatus={recoveryStatus}
            queryDraft={queryDraft}
            onBuildingChange={(value) => {
              setBuilding(value);
              setPage(1);
            }}
            onLevelChange={(value) => {
              setLevel(value);
              setPage(1);
            }}
            onProcessingStatusChange={(value) => {
              setProcessingStatus(value);
              setPage(1);
            }}
            onRecoveryStatusChange={(value) => {
              setRecoveryStatus(value);
              setPage(1);
            }}
            onQueryDraftChange={setQueryDraft}
            onSearch={() => {
              setQuery(queryDraft.trim());
              setPage(1);
            }}
            onReset={resetFilters}
            onPageChange={setPage}
          />
        </>
      ) : loadState === 'error' ? (
        <div className="today-panorama-card today-panorama-empty">
          暂无可展示的告警数据
        </div>
      ) : (
        <div
          className="today-panorama-card today-panorama-alarm-loading"
          aria-hidden="true"
        />
      )}
      <AlarmDetailDialog
        open={alarmDetail !== null}
        onOpenChange={(open) => {
          if (!open) setAlarmDetail(null);
        }}
        metric={alarmDetail?.metric ?? 'all'}
        title={alarmDetail?.title ?? '告警清单'}
        building={alarmDetail?.building}
      />
      {visibleData ? (
        <AlarmTagAnomalyDialog
          open={tagAnomalyDialogOpen}
          onOpenChange={setTagAnomalyDialogOpen}
          snapshot={visibleData}
        />
      ) : null}
    </section>
  );
}

export default function TodayOperationsPanoramaPage() {
  const {
    role,
    capabilities: { canForceRefresh },
  } = useAccess();
  const todayAttendance = useTodayAttendanceSnapshot(role !== 'guest');
  const [now, setNow] = useState(() => new Date());
  const businessDateKey = formatShanghaiBusinessDateKey(now);
  const [operationsReady, setOperationsReady] = useState(false);
  const [onDutyDialogOpen, setOnDutyDialogOpen] = useState(false);
  const [buildingMetricKey, setBuildingMetricKey] =
    useState<BuildingMetricKey | null>(null);
  const [topKpiData, setTopKpiData] =
    useState<TodayOperationsKpiResponse | null>(null);
  const [topKpiLoadState, setTopKpiLoadState] =
    useState<OverviewLoadState>('loading');
  const [overviewData, setOverviewData] =
    useState<TodayOperationsOverviewResponse | null>(null);
  const [overviewLoadState, setOverviewLoadState] =
    useState<OverviewLoadState>('loading');
  const [sealingInfo, setSealingInfo] = useState<SealingInfo[] | null>(null);
  const [sealingLoadState, setSealingLoadState] =
    useState<OverviewLoadState>('loading');
  const [alarmReady, setAlarmReady] = useState(false);
  const [manualRefreshToken, setManualRefreshToken] = useState(0);
  const buildingMetricTriggerRef = useRef<HTMLButtonElement | null>(null);
  const topKpiRequestIdRef = useRef(0);
  const overviewRequestIdRef = useRef(0);
  const sealingRequestIdRef = useRef(0);
  const topKpiBusinessDateRef = useRef(businessDateKey);
  const overviewBusinessDateRef = useRef(businessDateKey);
  const sealingBusinessDateRef = useRef(businessDateKey);

  const loadTopKpis = useCallback(
    async (forceRefresh = false) => {
      const requestId = ++topKpiRequestIdRef.current;
      setTopKpiLoadState('loading');
      try {
        const response = await getTodayOperationsKpis({
          refresh: canForceRefresh && forceRefresh,
        });
        if (requestId !== topKpiRequestIdRef.current) return;
        setTopKpiData(response);
        setTopKpiLoadState('ready');
      } catch {
        if (requestId !== topKpiRequestIdRef.current) return;
        setTopKpiLoadState('error');
      }
    },
    [canForceRefresh],
  );

  const loadOverviewData = useCallback(
    async (
      forceRefresh = false,
      background = false,
      expectedBusinessDate = overviewBusinessDateRef.current,
    ) => {
      const requestId = ++overviewRequestIdRef.current;
      if (!background) {
        setOverviewLoadState('loading');
      }
      try {
        const response = await getTodayOperationsOverview(
          canForceRefresh && forceRefresh,
        );
        if (requestId !== overviewRequestIdRef.current) return;
        if (response.businessDate !== expectedBusinessDate) {
          if (!background) setOverviewData(null);
          setOverviewLoadState('error');
          return;
        }
        setOverviewData(reconcileOverviewChangeSnapshot(response));
        setOverviewLoadState('ready');
      } catch {
        if (requestId !== overviewRequestIdRef.current) return;
        setOverviewLoadState('error');
      }
    },
    [canForceRefresh],
  );

  const loadSealingInfo = useCallback(
    async (
      forceRefresh = false,
      background = false,
      expectedBusinessDate = sealingBusinessDateRef.current,
    ) => {
      const requestId = ++sealingRequestIdRef.current;
      if (!background) {
        setSealingLoadState('loading');
      }
      try {
        const responses = await Promise.all(
          getNetworkFreezeQueryYears(expectedBusinessDate).map((year) =>
            getYearlySealingInfo(year, canForceRefresh && forceRefresh),
          ),
        );
        if (
          requestId !== sealingRequestIdRef.current ||
          sealingBusinessDateRef.current !== expectedBusinessDate
        ) {
          return;
        }
        setSealingInfo(responses.flatMap((response) => response.sealings));
        setSealingLoadState(
          responses.some((response) => response.sourceStatus === 'stale')
            ? 'error'
            : 'ready',
        );
      } catch {
        if (requestId !== sealingRequestIdRef.current) return;
        setSealingLoadState('error');
      }
    },
    [canForceRefresh],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const businessDateChanged =
      topKpiBusinessDateRef.current !== businessDateKey;
    topKpiBusinessDateRef.current = businessDateKey;
    void loadTopKpis(businessDateChanged);
    const timer = window.setInterval(() => {
      void loadTopKpis(false);
    }, TOP_KPI_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      topKpiRequestIdRef.current += 1;
    };
  }, [businessDateKey, loadTopKpis]);

  useEffect(() => {
    const businessDateChanged =
      overviewBusinessDateRef.current !== businessDateKey;
    overviewBusinessDateRef.current = businessDateKey;
    if (businessDateChanged) setOverviewData(null);
    void loadOverviewData(businessDateChanged, false, businessDateKey);
    const timer = window.setInterval(() => {
      void loadOverviewData(false, true, businessDateKey);
    }, OVERVIEW_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      overviewRequestIdRef.current += 1;
    };
  }, [businessDateKey, loadOverviewData]);

  useEffect(() => {
    const businessDateChanged =
      sealingBusinessDateRef.current !== businessDateKey;
    sealingBusinessDateRef.current = businessDateKey;
    if (businessDateChanged) setSealingInfo(null);
    void loadSealingInfo(businessDateChanged, false, businessDateKey);
    const timer = window.setInterval(() => {
      void loadSealingInfo(false, true, businessDateKey);
    }, SEALING_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      sealingRequestIdRef.current += 1;
    };
  }, [businessDateKey, loadSealingInfo]);

  const clock = formatShanghaiClock(now);
  const onDutyLeadShift = resolveShanghaiOnDutyLeadShift(now);
  const topKpis = useMemo(
    () =>
      topKpiData
        ? buildTopKpis(topKpiData.metrics, topKpiData.details, onDutyLeadShift)
        : buildTopKpiPlaceholders(
            topKpiLoadState === 'error' ? 'error' : 'loading',
          ),
    [onDutyLeadShift, topKpiData, topKpiLoadState],
  );
  const onDutyDialogModel = useMemo(
    () =>
      topKpiData ? buildOnDutyDialogModel(topKpiData, onDutyLeadShift) : null,
    [onDutyLeadShift, topKpiData],
  );
  const overviewReady = overviewLoadState !== 'loading';
  const sealingReady = sealingLoadState !== 'loading';
  const overviewSourceNotice = useMemo(
    () => buildOverviewSourceNotice(overviewData),
    [overviewData],
  );
  const rackSummary = useMemo(
    () =>
      overviewData?.rackSummary
        ? buildRackSummary(overviewData.rackSummary)
        : null,
    [overviewData],
  );
  const networkFreezeDetailModel = useMemo(
    () =>
      sealingInfo
        ? buildNetworkFreezeDetailModel(sealingInfo, businessDateKey)
        : null,
    [businessDateKey, sealingInfo],
  );
  const networkFreezeSummary = useMemo<NetworkFreezeSummary>(() => {
    if (!networkFreezeDetailModel) {
      return {
        status: sealingLoadState === 'loading' ? 'loading' : 'error',
      };
    }
    if (networkFreezeDetailModel.status === 'error') {
      return { status: 'error' };
    }
    return {
      status: 'ready',
      todayCount: networkFreezeDetailModel.todayItems.length,
      nextSevenDaysCount: networkFreezeDetailModel.nextSevenDaysItems.length,
    };
  }, [networkFreezeDetailModel, sealingLoadState]);
  const maintenanceCards = useMemo(
    () =>
      overviewData
        ? buildMaintenanceCards(
            overviewData.operations,
            PANORAMA_MAINTENANCE_CARDS,
            overviewData.sourceStates,
            networkFreezeSummary,
          )
        : [],
    [networkFreezeSummary, overviewData],
  );
  const tickerItems = useMemo(
    () =>
      overviewData
        ? buildOperationsTickerItems(
            overviewData,
            maintenanceCards,
            networkFreezeDetailModel ?? undefined,
          )
        : [],
    [maintenanceCards, networkFreezeDetailModel, overviewData],
  );
  const refreshAllData = useCallback(() => {
    void loadTopKpis(true);
    void loadOverviewData(true);
    void loadSealingInfo(true);
    setManualRefreshToken((current) => current + 1);
  }, [loadOverviewData, loadSealingInfo, loadTopKpis]);

  return (
    <main
      className="today-operations-panorama"
      aria-label="智舱今日全景"
      data-screenshot-target="today-operations-panorama"
      data-screenshot-ready={
        operationsReady && overviewReady && sealingReady && alarmReady
          ? 'true'
          : 'false'
      }
    >
      <div className="today-panorama-content">
        <header className="today-panorama-hero">
          <div className="today-panorama-title-group">
            <div className="today-panorama-title-copy">
              <h1>智舱 · 今日全景</h1>
              <p>Daily Operations Panorama</p>
            </div>
            <span className="today-panorama-hero-divider" aria-hidden />
          </div>
          <p className="today-panorama-tagline">
            全维度运行透视，让数据、安全与效能尽收眼底
          </p>
          <div className="today-panorama-time">
            <Clock3 aria-hidden />
            <div>
              <strong>{clock.dateText}</strong>
              <span>{clock.weekday}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={`today-panorama-refresh-all${
                topKpiLoadState === 'loading' ? ' is-loading' : ''
              }`}
              aria-label="刷新今日全景全部数据"
              title="刷新今日全景全部数据"
              onClick={refreshAllData}
            >
              <RefreshCw aria-hidden />
            </Button>
          </div>
        </header>

        <OperationsTicker items={tickerItems} loadState={overviewLoadState} />

        <div className="today-panorama-section-stack">
          <section className="today-panorama-kpi-grid" aria-label="运行摘要">
            {topKpis.map((item) => {
              const selectedMetricKey: BuildingMetricKey | null =
                item.key === 'average-pue'
                  ? 'averagePue'
                  : item.key === 'electricity'
                    ? 'electricityKwh'
                    : item.key === 'water'
                      ? 'waterTons'
                      : null;
              const onClick:
                | ((event: ReactMouseEvent<HTMLButtonElement>) => void)
                | undefined =
                item.key === 'on-duty' && topKpiData
                  ? () => setOnDutyDialogOpen(true)
                  : selectedMetricKey && topKpiData
                    ? (event) => {
                        buildingMetricTriggerRef.current = event.currentTarget;
                        setBuildingMetricKey(selectedMetricKey);
                      }
                    : undefined;
              return <KpiCard item={item} key={item.key} onClick={onClick} />;
            })}
          </section>
          {onDutyDialogModel ? (
            <OnDutyPeopleDialog
              open={onDutyDialogOpen}
              onOpenChange={setOnDutyDialogOpen}
              model={onDutyDialogModel}
              attendance={todayAttendance}
              canViewAttendance={role !== 'guest'}
              canManualSync={role === 'admin'}
              canViewCorrectionEvidence={role === 'admin'}
            />
          ) : null}
          <BuildingMetricDetailDialog
            open={buildingMetricKey !== null}
            onOpenChange={(open) => {
              if (!open) setBuildingMetricKey(null);
            }}
            metricKey={buildingMetricKey ?? 'averagePue'}
            restoreFocusTo={buildingMetricTriggerRef.current}
            details={
              buildingMetricKey
                ? (topKpiData?.details.buildingMetrics?.[buildingMetricKey] ??
                  null)
                : null
            }
          />

          {overviewLoadState === 'error' && overviewData ? (
            <div className="today-panorama-source-state is-error" role="status">
              <span>飞书连接暂时不可用，当前保留上次已加载的运行概览</span>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadOverviewData(true)}
              >
                <RefreshCw aria-hidden />
                重新读取
              </Button>
            </div>
          ) : null}

          {overviewSourceNotice ? (
            <div
              className={`today-panorama-source-state is-${overviewSourceNotice.tone}`}
              role={overviewSourceNotice.tone === 'error' ? 'alert' : 'status'}
            >
              {overviewSourceNotice.message}
            </div>
          ) : null}

          <section className="today-panorama-overview-grid">
            {rackSummary ? (
              <RackOverview
                summary={rackSummary}
                stale={
                  overviewLoadState === 'error' ||
                  overviewLoadState === 'loading' ||
                  overviewData?.rackSourceState?.status === 'stale' ||
                  overviewData?.sourceStatus === 'stale'
                }
                retrying={overviewLoadState === 'loading'}
                onRetry={() => void loadOverviewData(true)}
              />
            ) : (
              <OverviewDataStateCard
                index="01"
                title="机柜使用概览"
                loadState={
                  overviewLoadState === 'loading' ? 'loading' : 'error'
                }
                onRetry={() => void loadOverviewData(true)}
              />
            )}
            {overviewData && maintenanceCards.length > 0 ? (
              <MaintenanceOverview
                cards={maintenanceCards}
                details={overviewData.details}
                networkFreezeDetails={networkFreezeDetailModel}
                sealingLoadState={sealingLoadState}
              />
            ) : (
              <OverviewDataStateCard
                index="02"
                title="运维概况一览"
                loadState={overviewLoadState}
                onRetry={() => void loadOverviewData(false)}
              />
            )}
          </section>

          <AlarmOverview
            allowForceRefresh={canForceRefresh}
            manualRefreshToken={manualRefreshToken}
            onReadyChange={setAlarmReady}
          />

          <OperationsPanels
            allowForceRefresh={canForceRefresh}
            manualRefreshToken={manualRefreshToken}
            onReadyChange={setOperationsReady}
          />
        </div>
      </div>
    </main>
  );
}
