import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileCheck2,
  Package,
  RefreshCw,
  Settings,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { getEquipmentLifecycleDashboard } from '@/api';
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

import {
  ExpiryHeatmap,
  GradientBarChart,
  MetricStatusLamp,
  TopDevicesList,
  UsageRingGroup,
} from './charts';
import { LifecycleDrilldownDialog } from './LifecycleDrilldownDialog';
import {
  DEFAULT_LIFECYCLE_FILTERS,
  buildLifecycleDrilldown,
  filterLifecycleAssets,
  formatUpdatedAt,
  getLifecycleFilterOptions,
  paginateLifecycleAssets,
  type EquipmentLifecycleView,
  type LifecycleDrilldownTarget,
  type LifecycleAsset,
  type LifecycleFilters,
  type LifecycleMonth,
  type LifecycleSummary,
} from './model';

import './styles.css';

type MetricTone = 'blue' | 'green' | 'red' | 'purple' | 'indigo' | 'orange';

interface MetricDefinition {
  key: keyof LifecycleSummary;
  label: string;
  icon: LucideIcon;
  tone: MetricTone;
  drilldown: Omit<LifecycleDrilldownTarget, 'title'>;
}

const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: 'equipmentTotal',
    label: '设备总数',
    icon: Database,
    tone: 'blue',
    drilldown: {
      source: 'equipment',
      description: '全部设备生命周期台账',
    },
  },
  {
    key: 'keyPartTotal',
    label: '关键零件总数',
    icon: Settings,
    tone: 'green',
    drilldown: {
      source: 'keyParts',
      description: '全部关键器件更换项目',
    },
  },
  {
    key: 'expiringEquipment',
    label: '设备到期数',
    icon: Clock3,
    tone: 'red',
    drilldown: {
      source: 'equipment',
      status: '待评估',
      description: '设备状态为“待评估”的台账记录',
    },
  },
  {
    key: 'expiredContracts',
    label: '过保合同数',
    icon: ShieldCheck,
    tone: 'purple',
    drilldown: {
      source: 'maintenanceContracts',
      status: '过保',
      description: '合同当前状态为“过保”的维护合同',
    },
  },
  {
    key: 'maintenanceContracts',
    label: '维护合同总数',
    icon: FileCheck2,
    tone: 'indigo',
    drilldown: {
      source: 'maintenanceContracts',
      description: '全部维护合同记录',
    },
  },
  {
    key: 'longTermMaintenance',
    label: '长期维护总数',
    icon: Wrench,
    tone: 'orange',
    drilldown: {
      source: 'longTermMaintenance',
      description: '已排除主变条目的长期维护清单',
    },
  },
];

const LONG_TERM_SERIES = [
  {
    dataKey: 'inWarranty',
    label: '在保',
    startColor: 'var(--lifecycle-chart-blue-start)',
    endColor: 'var(--lifecycle-chart-blue-end)',
  },
  {
    dataKey: 'expired',
    label: '到期',
    startColor: 'var(--lifecycle-chart-red-start)',
    endColor: 'var(--lifecycle-chart-red-end)',
  },
] as const;

const CONTRACT_SERIES = [
  {
    dataKey: 'inWarranty',
    label: '在保',
    startColor: 'var(--lifecycle-chart-blue-start)',
    endColor: 'var(--lifecycle-chart-blue-end)',
  },
  {
    dataKey: 'warning',
    label: '三月预警',
    startColor: 'var(--lifecycle-chart-orange-start)',
    endColor: 'var(--lifecycle-chart-orange-end)',
  },
  {
    dataKey: 'expired',
    label: '过保',
    startColor: 'var(--lifecycle-chart-red-start)',
    endColor: 'var(--lifecycle-chart-red-end)',
  },
] as const;

const KEY_PART_SERIES = [
  {
    dataKey: 'inWarranty',
    label: '在保',
    startColor: 'var(--lifecycle-chart-blue-start)',
    endColor: 'var(--lifecycle-chart-blue-end)',
  },
  {
    dataKey: 'warning',
    label: '三月预警',
    startColor: 'var(--lifecycle-chart-orange-start)',
    endColor: 'var(--lifecycle-chart-orange-end)',
  },
  {
    dataKey: 'expired',
    label: '过保',
    startColor: 'var(--lifecycle-chart-red-start)',
    endColor: 'var(--lifecycle-chart-red-end)',
  },
] as const;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '无法读取设备生命周期数据，请稍后重试';
}

function getChartMax<T extends object>(
  data: readonly T[],
  keys: readonly (keyof T)[],
): number {
  const maximum = Math.max(
    0,
    ...data.flatMap((item) =>
      keys.map((key) => {
        const value = Number(item[key]);
        return Number.isFinite(value) ? value : 0;
      }),
    ),
  );
  if (maximum <= 6) return 6;
  if (maximum <= 15) return 15;
  return Math.ceil(maximum / 10) * 10;
}

function Panel({
  title,
  legend,
  className = '',
  onTitleClick,
  children,
}: {
  title: string;
  legend?: ReactNode;
  className?: string;
  onTitleClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Card className={`lifecycle-panel ${className}`}>
      <CardContent className="lifecycle-panel-content">
        <div className="lifecycle-panel-header">
          <h2>
            {onTitleClick ? (
              <button
                type="button"
                className="lifecycle-panel-title-trigger"
                aria-haspopup="dialog"
                onClick={onTitleClick}
              >
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          {legend ? (
            <div className="lifecycle-panel-legend" aria-label={`${title}图例`}>
              {legend}
            </div>
          ) : null}
        </div>
        <div className="lifecycle-panel-body">{children}</div>
      </CardContent>
    </Card>
  );
}

function LegendItem({
  label,
  tone,
  onClick,
}: {
  label: string;
  tone: 'blue' | 'red' | 'orange' | 'green';
  onClick?: () => void;
}) {
  const content = (
    <>
      <i className={`lifecycle-legend-dot lifecycle-legend-${tone}`} />
      {label}
    </>
  );

  return onClick ? (
    <button
      type="button"
      className="lifecycle-legend-trigger"
      aria-haspopup="dialog"
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <span>{content}</span>
  );
}

function MetricCard({
  definition,
  value,
  rate,
  onClick,
}: {
  definition: MetricDefinition;
  value: number | null;
  rate?: number | null;
  onClick: () => void;
}) {
  const Icon = definition.icon;

  return (
    <Card
      className={`lifecycle-metric-card lifecycle-metric-${definition.tone}`}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`查看${definition.label}清单`}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <CardContent className="lifecycle-metric-content">
        <span className="lifecycle-metric-icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="lifecycle-metric-copy">
          <p>{definition.label}</p>
          <strong>{value === null ? '—' : value.toLocaleString()}</strong>
          {rate !== undefined ? (
            <small>在保率 {rate === null ? '—' : `${rate.toFixed(1)}%`}</small>
          ) : null}
        </div>
        <MetricStatusLamp />
      </CardContent>
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="lifecycle-filter-control">
      <span>{label}</span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">请选择</SelectItem>
          {options.map((option) => (
            <SelectItem value={option} key={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function getStatusTone(status: string): string {
  if (status.includes('未到期') || status.includes('在保')) return 'success';
  if (status.includes('即将') || status.includes('预警')) return 'orange';
  if (status.includes('过保') || status.includes('到期')) return 'danger';
  if (status.includes('评估')) return 'warning';
  return 'neutral';
}

function getSpecialtyTone(specialty: string): string {
  if (specialty.includes('暖通')) return 'amber';
  if (specialty.includes('消防')) return 'orange';
  if (specialty.includes('弱电')) return 'sky';
  if (specialty.includes('电气') || specialty.includes('强电')) return 'blue';
  return 'neutral';
}

function AssetLedger({
  items,
  filteredTotal,
  catalogTotal,
  page,
  pageSize,
  totalPages,
  updatedAt,
  jumpPage,
  onJumpPageChange,
  onJump,
  onPageChange,
  onPageSizeChange,
  onClearFilters,
}: {
  items: readonly LifecycleAsset[];
  filteredTotal: number;
  catalogTotal: number;
  page: number;
  pageSize: number;
  totalPages: number;
  updatedAt: string;
  jumpPage: string;
  onJumpPageChange: (value: string) => void;
  onJump: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onClearFilters: () => void;
}) {
  const pageButtons =
    totalPages <= 5
      ? Array.from({ length: totalPages }, (_, index) => index + 1)
      : page <= 3
        ? [1, 2, 3, -1, totalPages]
        : page >= totalPages - 2
          ? [1, -1, totalPages - 2, totalPages - 1, totalPages]
          : [1, -1, page, -1, totalPages];

  return (
    <Card className="lifecycle-ledger-card">
      <CardContent className="lifecycle-ledger-content">
        <div className="lifecycle-ledger-header">
          <div>
            <h2>设备台账清单</h2>
            <span>描述</span>
          </div>
          <span className="lifecycle-updated-at">更新于 {updatedAt}</span>
        </div>

        <div
          className="lifecycle-ledger-scroll"
          tabIndex={0}
          aria-label="设备台账横向滚动区域"
        >
          <Table className="lifecycle-ledger-table">
            <TableHeader>
              <TableRow>
                <TableHead>描述</TableHead>
                <TableHead>楼栋</TableHead>
                <TableHead>设备名称</TableHead>
                <TableHead>专业</TableHead>
                <TableHead>管理员</TableHead>
                <TableHead>运维服务年限</TableHead>
                <TableHead>上次更换日期</TableHead>
                <TableHead>本次到期日期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>预计下次更换日期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length > 0 ? (
                items.map((asset) => (
                  <TableRow key={asset.id}>
                    <TableCell className="lifecycle-description-cell">
                      {asset.description}
                    </TableCell>
                    <TableCell>
                      <Badge className="lifecycle-building-badge">
                        {asset.building}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className="lifecycle-device-badge">
                        {asset.deviceName}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`lifecycle-specialty-badge lifecycle-specialty-${getSpecialtyTone(asset.specialty)}`}
                      >
                        {asset.specialty}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="lifecycle-manager">
                        <i aria-hidden="true">{asset.managerInitial}</i>
                        {asset.manager}
                      </span>
                    </TableCell>
                    <TableCell className="lifecycle-number-cell">
                      {asset.serviceYears ?? '—'}
                    </TableCell>
                    <TableCell>{asset.lastReplacementDate ?? '—'}</TableCell>
                    <TableCell>{asset.currentExpiryDate ?? '—'}</TableCell>
                    <TableCell>
                      <Badge
                        className={`lifecycle-status-badge lifecycle-status-${getStatusTone(asset.status)}`}
                      >
                        {asset.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{asset.nextReplacementDate ?? '—'}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={10} className="lifecycle-ledger-empty">
                    <CircleAlert aria-hidden="true" />
                    <strong>未找到匹配的设备台账</strong>
                    <span>请调整查询条件，或清除全部筛选后重试。</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onClearFilters}
                    >
                      清除筛选
                    </Button>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="lifecycle-pagination">
          <span>
            共 {filteredTotal === catalogTotal ? catalogTotal : filteredTotal}{' '}
            条
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <div className="lifecycle-page-buttons">
            {pageButtons.map((pageButton, index) =>
              pageButton === -1 ? (
                <span key={`ellipsis-${index}`}>…</span>
              ) : (
                <button
                  type="button"
                  key={pageButton}
                  className={pageButton === page ? 'is-active' : undefined}
                  aria-current={pageButton === page ? 'page' : undefined}
                  onClick={() => onPageChange(pageButton)}
                >
                  {pageButton}
                </button>
              ),
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="下一页"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger
              className="lifecycle-page-size"
              aria-label="每页显示条数"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10条/页</SelectItem>
              <SelectItem value="20">20条/页</SelectItem>
            </SelectContent>
          </Select>
          <label className="lifecycle-page-jump">
            跳至
            <Input
              value={jumpPage}
              inputMode="numeric"
              aria-label="跳转页码"
              onChange={(event) =>
                onJumpPageChange(event.currentTarget.value.replace(/\D/g, ''))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') onJump();
              }}
            />
            页
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

export default function EquipmentLifecycleDashboard({
  embedded = false,
  loader = getEquipmentLifecycleDashboard,
}: {
  embedded?: boolean;
  loader?: typeof getEquipmentLifecycleDashboard;
} = {}) {
  const canRefresh = canUsePageAction(useAccess(), 'equipment_lifecycle', 'refresh', true);
  const Container = embedded ? 'section' : 'main';
  const [month, setMonth] = useState<LifecycleMonth | null>(null);
  const [view, setView] = useState<EquipmentLifecycleView | null>(null);
  const [filters, setFilters] = useState<LifecycleFilters>(
    DEFAULT_LIFECYCLE_FILTERS,
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [jumpPage, setJumpPage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drilldownTarget, setDrilldownTarget] =
    useState<LifecycleDrilldownTarget | null>(null);
  const [announcement, setAnnouncement] = useState('设备生命周期看板加载中');
  const viewRef = useRef<EquipmentLifecycleView | null>(null);
  const requestSequenceRef = useRef(0);

  const loadDashboard = useCallback(
    async (
      options: { month?: LifecycleMonth; refresh?: boolean } = {},
    ): Promise<void> => {
      const requestSequence = ++requestSequenceRef.current;
      const hasExistingView = viewRef.current !== null;

      setError(null);
      if (hasExistingView) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }

      try {
        const response = await loader({ ...options, refresh: Boolean(options.refresh) && canRefresh });
        if (requestSequence !== requestSequenceRef.current) return;

        viewRef.current = response;
        setView(response);
        setMonth(response.month);
        setIsLoading(false);
        setAnnouncement(`${response.month} 设备生命周期数据已加载`);
      } catch (loadError) {
        if (requestSequence !== requestSequenceRef.current) return;

        const message = getErrorMessage(loadError);
        setError(message);
        setIsLoading(false);
        setAnnouncement(`设备生命周期数据加载失败：${message}`);
      } finally {
        if (requestSequence === requestSequenceRef.current) {
          setIsRefreshing(false);
        }
      }
    },
    [loader, canRefresh],
  );

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const filterOptions = useMemo(
    () =>
      view ? getLifecycleFilterOptions(view.assets, view.filterOptions) : null,
    [view],
  );
  const filteredAssets = useMemo(
    () => (view ? filterLifecycleAssets(view.assets, filters) : []),
    [filters, view],
  );
  const pagination = useMemo(
    () => paginateLifecycleAssets(filteredAssets, page, pageSize),
    [filteredAssets, page, pageSize],
  );
  const drilldownResult = useMemo(
    () =>
      view && drilldownTarget
        ? buildLifecycleDrilldown(view, drilldownTarget)
        : null,
    [drilldownTarget, view],
  );

  useEffect(() => {
    if (page !== pagination.page) setPage(pagination.page);
  }, [page, pagination.page]);

  const updateFilter = <K extends keyof LifecycleFilters>(
    key: K,
    value: LifecycleFilters[K],
    label: string,
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
    setAnnouncement(
      value === 'all' ? `${label}已清除` : `${label}已更新为 ${value}`,
    );
  };

  const clearFilters = () => {
    setFilters(DEFAULT_LIFECYCLE_FILTERS);
    setPage(1);
    setAnnouncement('已清除全部设备台账筛选条件');
  };

  const openDrilldown = (target: LifecycleDrilldownTarget) => {
    setDrilldownTarget(target);
    setAnnouncement(`${target.title}已打开`);
  };

  const handleJump = () => {
    if (!jumpPage) return;
    const target = Math.min(
      pagination.totalPages,
      Math.max(1, Number(jumpPage)),
    );
    setPage(target);
    setJumpPage('');
    setAnnouncement(`已跳转到第 ${target} 页`);
  };

  const availableMonths = view
    ? view.availableMonths.length > 0
      ? view.availableMonths
      : [view.month]
    : [];
  const sourceHasWarning =
    Boolean(error) ||
    view?.sourceStatus === 'stale' ||
    view?.sourceStatus === 'partial' ||
    Boolean(view?.warnings.length);
  const hasMissingStatusWarning = Boolean(
    view?.warnings.some((warning) => warning.includes('状态未填写')),
  );
  const sourceWarningTitle = error
    ? '本次刷新失败，继续显示上次成功数据'
    : view?.sourceStatus === 'stale'
      ? '当前显示最近一次成功缓存'
      : view?.sourceStatus === 'partial'
        ? '部分数据源读取失败'
        : '数据质量提示';
  const sourceWarningDetail =
    error || view?.warnings.join('；') || '请稍后刷新重试';

  if (!view) {
    return (
      <Container
        className={`equipment-lifecycle-dashboard lifecycle-error-page ${embedded ? 'lifecycle-embedded' : ''}`}
        aria-label="设备生命周期看板"
        aria-busy={isLoading}
      >
        <section
          role={isLoading ? 'status' : 'alert'}
          className="lifecycle-error-panel"
          data-screenshot-target="equipment-lifecycle-dashboard"
          data-screenshot-ready="false"
        >
          {isLoading ? (
            <RefreshCw className="lifecycle-loading-icon" aria-hidden="true" />
          ) : (
            <CircleAlert aria-hidden="true" />
          )}
          <h1>
            {isLoading
              ? '正在连接设备生命周期数据'
              : '设备生命周期看板暂时无法加载'}
          </h1>
          <p>
            {isLoading
              ? '正在加载…'
              : error || '未获取到设备生命周期数据，请稍后重试。'}
          </p>
          {!isLoading ? (
            <Button
              type="button"
              onClick={() =>
                void loadDashboard({
                  month: month ?? undefined,
                  refresh: true,
                })
              }
            >
              重新加载
            </Button>
          ) : null}
        </section>
      </Container>
    );
  }

  return (
    <Container
      className={`equipment-lifecycle-dashboard ${embedded ? 'lifecycle-embedded' : ''}`}
      aria-label="设备生命周期看板"
      aria-busy={isLoading || isRefreshing}
    >
      <div className="lifecycle-dashboard-frame">
        <section
          className="lifecycle-dashboard-stage"
          data-screenshot-target="equipment-lifecycle-dashboard"
          data-screenshot-ready={view !== null ? 'true' : 'false'}
          data-dashboard-month={view.month}
        >
          {isRefreshing ? (
            <div className="lifecycle-loading-bar" role="status">
              <i />
              <span>正在刷新 {month || view.month} 数据</span>
            </div>
          ) : null}

          <header className="lifecycle-dashboard-header">
            <div className="lifecycle-title">
              <span aria-hidden="true">
                <Package />
              </span>
              <h1>设备全生命周期</h1>
            </div>
            <div className="lifecycle-header-actions">
              {sourceHasWarning ? (
                <button
                  type="button"
                  className="lifecycle-source-warning"
                  role="status"
                  title={sourceWarningDetail}
                  aria-haspopup={hasMissingStatusWarning ? 'dialog' : undefined}
                  disabled={!hasMissingStatusWarning}
                  onClick={() =>
                    openDrilldown({
                      source: 'equipment',
                      title: '状态未填写设备清单',
                      description: '设备状态字段尚未填写的台账记录',
                      status: '未填写',
                    })
                  }
                >
                  <CircleAlert aria-hidden="true" />
                  <span>
                    <strong>{sourceWarningTitle}</strong>
                    {sourceWarningDetail}
                  </span>
                </button>
              ) : null}
              <div className="lifecycle-month-picker">
                <CalendarDays aria-hidden="true" />
                <Select
                  value={month || view.month}
                  disabled={isRefreshing}
                  onValueChange={(value) => {
                    setMonth(value);
                    setFilters(DEFAULT_LIFECYCLE_FILTERS);
                    setPage(1);
                    void loadDashboard({ month: value });
                  }}
                >
                  <SelectTrigger aria-label="统计月份">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableMonths.map((option) => (
                      <SelectItem value={option} key={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="lifecycle-refresh-button"
                aria-label="刷新设备生命周期数据"
                disabled={isRefreshing}
                onClick={() =>
                  void loadDashboard({
                    month: month || view.month,
                    refresh: true,
                  })
                }
              >
                <RefreshCw
                  className={isRefreshing ? 'is-spinning' : undefined}
                  aria-hidden="true"
                />
              </Button>
            </div>
          </header>

          <section className="lifecycle-metric-grid" aria-label="生命周期摘要">
            {METRIC_DEFINITIONS.map((definition) => (
              <MetricCard
                definition={definition}
                value={view.summary[definition.key]}
                rate={
                  definition.key === 'maintenanceContracts'
                    ? view.maintenanceContractInWarrantyRate
                    : undefined
                }
                onClick={() =>
                  openDrilldown({
                    ...definition.drilldown,
                    title: `${definition.label}清单`,
                  })
                }
                key={definition.key}
              />
            ))}
          </section>

          <section className="lifecycle-analytics-row lifecycle-analytics-primary">
            <Panel
              title="设备使用状态"
              className="lifecycle-usage-panel"
              onTitleClick={() =>
                openDrilldown({
                  source: 'equipment',
                  title: '设备使用状态清单',
                  description: '全部设备使用状态台账',
                })
              }
              legend={
                <>
                  <LegendItem
                    label="未到期"
                    tone="blue"
                    onClick={() =>
                      openDrilldown({
                        source: 'equipment',
                        title: '未到期设备清单',
                        status: '未到期',
                      })
                    }
                  />
                  <LegendItem
                    label="需评估"
                    tone="orange"
                    onClick={() =>
                      openDrilldown({
                        source: 'equipment',
                        title: '需评估设备清单',
                        status: '待评估',
                      })
                    }
                  />
                </>
              }
            >
              <UsageRingGroup
                data={view.buildingUsage}
                onSelect={({ building, status }) =>
                  openDrilldown({
                    source: 'equipment',
                    title: `${building}${status ? ` · ${status}` : ''}设备清单`,
                    description: status
                      ? `${building}状态为“${status}”的设备`
                      : `${building}全部设备台账`,
                    building,
                    status,
                  })
                }
              />
            </Panel>
            <Panel
              title="长期维护项情况"
              className="lifecycle-bar-panel"
              onTitleClick={() =>
                openDrilldown({
                  source: 'longTermMaintenance',
                  title: '长期维护项清单',
                  description: '已排除主变条目的长期维护清单',
                })
              }
              legend={
                <>
                  <LegendItem
                    label="在保"
                    tone="blue"
                    onClick={() =>
                      openDrilldown({
                        source: 'longTermMaintenance',
                        title: '在保长期维护清单',
                        status: '在保',
                      })
                    }
                  />
                  <LegendItem
                    label="到期"
                    tone="red"
                    onClick={() =>
                      openDrilldown({
                        source: 'longTermMaintenance',
                        title: '到期长期维护清单',
                        status: '到期',
                      })
                    }
                  />
                </>
              }
            >
              <GradientBarChart
                data={view.longTermMaintenance}
                series={LONG_TERM_SERIES}
                gradientPrefix="lifecycle-long-term"
                ariaLabel="各楼栋长期维护在保与到期数量"
                maxValue={getChartMax(view.longTermMaintenance, [
                  'inWarranty',
                  'expired',
                ])}
                onSelect={({ datum, series }) =>
                  openDrilldown({
                    source: 'longTermMaintenance',
                    title: `${datum.building} · ${series.label}长期维护清单`,
                    building: datum.building,
                    status: series.label,
                  })
                }
              />
            </Panel>
            <Panel
              title="维护合同情况"
              className="lifecycle-bar-panel"
              onTitleClick={() =>
                openDrilldown({
                  source: 'maintenanceContracts',
                  title: '维护合同清单',
                })
              }
              legend={
                <>
                  <LegendItem
                    label="在保"
                    tone="blue"
                    onClick={() =>
                      openDrilldown({
                        source: 'maintenanceContracts',
                        title: '在保维护合同清单',
                        status: '在保',
                      })
                    }
                  />
                  <LegendItem
                    label="三月预警"
                    tone="orange"
                    onClick={() =>
                      openDrilldown({
                        source: 'maintenanceContracts',
                        title: '三月预警维护合同清单',
                        status: '三月预警',
                      })
                    }
                  />
                  <LegendItem
                    label="过保"
                    tone="red"
                    onClick={() =>
                      openDrilldown({
                        source: 'maintenanceContracts',
                        title: '过保维护合同清单',
                        status: '过保',
                      })
                    }
                  />
                </>
              }
            >
              <GradientBarChart
                data={view.maintenanceContracts}
                series={CONTRACT_SERIES}
                gradientPrefix="lifecycle-contract"
                ariaLabel="各楼栋维护合同状态数量"
                maxValue={getChartMax(view.maintenanceContracts, [
                  'inWarranty',
                  'warning',
                  'expired',
                ])}
                onSelect={({ datum, series }) =>
                  openDrilldown({
                    source: 'maintenanceContracts',
                    title: `${datum.building} · ${series.label}维护合同清单`,
                    building: datum.building,
                    status: series.label,
                  })
                }
              />
            </Panel>
          </section>

          <section className="lifecycle-analytics-row lifecycle-analytics-secondary">
            <Panel
              title="关键器件预警情况"
              className="lifecycle-bar-panel"
              onTitleClick={() =>
                openDrilldown({
                  source: 'keyParts',
                  title: '关键器件清单',
                })
              }
              legend={
                <>
                  <LegendItem
                    label="在保"
                    tone="blue"
                    onClick={() =>
                      openDrilldown({
                        source: 'keyParts',
                        title: '在保关键器件清单',
                        status: '在保',
                      })
                    }
                  />
                  <LegendItem
                    label="三月预警"
                    tone="orange"
                    onClick={() =>
                      openDrilldown({
                        source: 'keyParts',
                        title: '三月预警关键器件清单',
                        status: '三月预警',
                      })
                    }
                  />
                  <LegendItem
                    label="过保"
                    tone="red"
                    onClick={() =>
                      openDrilldown({
                        source: 'keyParts',
                        title: '过保关键器件清单',
                        status: '过保',
                      })
                    }
                  />
                </>
              }
            >
              <GradientBarChart
                data={view.keyPartWarnings}
                series={KEY_PART_SERIES}
                gradientPrefix="lifecycle-key-parts"
                ariaLabel="各楼栋关键器件在保、三月预警与过保数量"
                maxValue={getChartMax(view.keyPartWarnings, [
                  'inWarranty',
                  'warning',
                  'expired',
                ])}
                onSelect={({ datum, series }) =>
                  openDrilldown({
                    source: 'keyParts',
                    title: `${datum.building} · ${series.label}关键器件清单`,
                    building: datum.building,
                    status: series.label,
                  })
                }
              />
            </Panel>
            <Panel
              title="设备到期情况"
              className="lifecycle-heatmap-panel"
              onTitleClick={() =>
                openDrilldown({
                  source: 'equipment',
                  title: '设备到期日期清单',
                })
              }
            >
              <ExpiryHeatmap
                data={view.expiryHeatmap}
                onSelect={({ building, monthIndex, monthLabel }) =>
                  openDrilldown({
                    source: 'equipment',
                    title: `${building} · ${monthLabel}到期设备清单`,
                    description: `${building}历年${monthLabel}到期设备`,
                    building,
                    expiryMonth: monthIndex + 1,
                  })
                }
              />
            </Panel>
            <Panel
              title="设备数量 TOP5"
              className="lifecycle-top-panel"
              onTitleClick={() =>
                openDrilldown({
                  source: 'equipment',
                  title: '全部设备清单',
                })
              }
            >
              <TopDevicesList
                data={view.topDevices}
                onSelect={(item) =>
                  openDrilldown({
                    source: 'equipment',
                    title: `${item.name}设备清单`,
                    description: `设备名称为“${item.name}”的台账记录`,
                    deviceName: item.name,
                  })
                }
              />
            </Panel>
          </section>

          <section className="lifecycle-filter-grid" aria-label="设备台账筛选">
            <FilterSelect
              label="按楼栋查询"
              value={filters.building}
              options={filterOptions?.buildings || []}
              onValueChange={(value) =>
                updateFilter(
                  'building',
                  value as LifecycleFilters['building'],
                  '楼栋筛选',
                )
              }
            />
            <FilterSelect
              label="按专业查询"
              value={filters.specialty}
              options={filterOptions?.specialties || []}
              onValueChange={(value) =>
                updateFilter(
                  'specialty',
                  value as LifecycleFilters['specialty'],
                  '专业筛选',
                )
              }
            />
            <FilterSelect
              label="按管理员查询"
              value={filters.manager}
              options={filterOptions?.managers || []}
              onValueChange={(value) =>
                updateFilter('manager', value, '管理员筛选')
              }
            />
            <FilterSelect
              label="按状态查询"
              value={filters.status}
              options={filterOptions?.statuses || []}
              onValueChange={(value) =>
                updateFilter(
                  'status',
                  value as LifecycleFilters['status'],
                  '状态筛选',
                )
              }
            />
          </section>

          <AssetLedger
            items={pagination.items}
            filteredTotal={pagination.total}
            catalogTotal={view.summary.equipmentTotal ?? view.assets.length}
            page={pagination.page}
            pageSize={pagination.pageSize}
            totalPages={pagination.totalPages}
            updatedAt={formatUpdatedAt(view.updatedAt)}
            jumpPage={jumpPage}
            onJumpPageChange={setJumpPage}
            onJump={handleJump}
            onPageChange={(nextPage) => {
              setPage(nextPage);
              setAnnouncement(`已切换到第 ${nextPage} 页`);
            }}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
              setAnnouncement(`已切换为每页 ${nextPageSize} 条`);
            }}
            onClearFilters={clearFilters}
          />

          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
        </section>
      </div>
      <LifecycleDrilldownDialog
        result={drilldownResult}
        onOpenChange={(open) => {
          if (!open) setDrilldownTarget(null);
        }}
      />
    </Container>
  );
}
