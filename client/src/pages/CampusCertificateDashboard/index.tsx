import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  HardHat,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingUp,
  UserRound,
  Zap,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getGlobalNavigationViewportHeight } from '@/navigation/global-navigation-layout';
import {
  getCampusCertificateDashboard,
  getCampusCertificateExpiryNotificationPreview,
  sendCampusCertificateExpiryNotifications,
} from '@/api';
import type { CampusCertificateDashboardResponse } from '@shared/api.interface';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import {
  BuildingComplianceChart,
  ComplianceGauge,
  ExpiryHeatmap,
} from './charts';
import {
  CertificateMetricDetailDialog,
  type CertificateDetailKey,
  type CertificateNotificationState,
} from './CertificateMetricDetailDialog';
import { CertificateExpiryDayDetailDialog } from './CertificateExpiryDayDetailDialog';
import {
  CertificateBuildingDetailDialog,
  type CertificateBuildingSelection,
} from './CertificateBuildingDetailDialog';
import {
  buildCertificateCalendarMonths,
  selectCertificateMetricPeople,
} from './data';
import type { CertificateFilter, CertificateMonth } from './model';
import {
  calculateDashboardScale,
  filterNonCompliantPeople,
  formatDashboardTimestamp,
  getDashboardStatusPresentation,
  paginateNonCompliantPeople,
  type DashboardStatusKind,
} from './logic';
import type { TrainingCertificationHeaderStateChange } from '../TrainingCertificationManagement';

import './styles.css';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 600;

interface DashboardStatus {
  kind: DashboardStatusKind;
  message: string;
}

const METRIC_ICONS = {
  'high-voltage': Zap,
  'low-voltage': UserRound,
  'height-work': HardHat,
  expiring: AlarmClock,
} as const;

interface CampusCertificateDashboardProps {
  embedded?: boolean;
  onHeaderStateChange?: TrainingCertificationHeaderStateChange;
}

function useFixedStage(enabled = true) {
  const [scale, setScale] = useState(1);
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setScale(1);
      return undefined;
    }

    const updateScale = () => {
      if (resizeFrameRef.current !== null) {
        return;
      }

      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        setScale((previousScale) =>
          calculateDashboardScale(
            window.innerWidth,
            getGlobalNavigationViewportHeight(window.innerHeight),
            previousScale,
          ),
        );
      });
    };

    updateScale();
    window.addEventListener('resize', updateScale);

    return () => {
      window.removeEventListener('resize', updateScale);

      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [enabled]);

  return scale;
}

export default function CampusCertificateDashboard({
  embedded = false,
  onHeaderStateChange,
}: CampusCertificateDashboardProps) {
  const scale = useFixedStage(!embedded);
  const [certificateFilter, setCertificateFilter] =
    useState<CertificateFilter>('all');
  const [certificateMonth, setCertificateMonth] = useState<CertificateMonth>(
    () => new Date().toISOString().slice(0, 7),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [peoplePage, setPeoplePage] = useState(1);
  const [dashboardData, setDashboardData] =
    useState<CampusCertificateDashboardResponse | null>(null);
  const [activeDetailKey, setActiveDetailKey] =
    useState<CertificateDetailKey | null>(null);
  const [activeExpiryDate, setActiveExpiryDate] = useState<string | null>(null);
  const [activeBuilding, setActiveBuilding] = useState<CertificateBuildingSelection | null>(null);
  const [notificationState, setNotificationState] =
    useState<CertificateNotificationState>({ status: 'idle' });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [initialLoadError, setInitialLoadError] = useState('');
  const [dashboardStatus, setDashboardStatus] =
    useState<DashboardStatus | null>(null);
  const successTimerRef = useRef<number | null>(null);
  const notificationPreviewRequestRef = useRef(0);
  const hasDashboardDataRef = useRef(false);
  const currentSummary = dashboardData?.summary;
  const currentMetrics = useMemo(
    () =>
      dashboardData
        ? dashboardData.certificateMetrics.map((metric) => ({
            ...metric,
            value: selectCertificateMetricPeople(
              dashboardData.people,
              metric.id,
            ).length,
          }))
        : [],
    [dashboardData],
  );
  const currentBuildings = dashboardData?.buildingCompliance ?? [];
  const currentNonCompliantPeople = dashboardData?.nonCompliantPeople ?? [];
  const currentPeople = dashboardData?.people ?? [];
  const currentExpiryEvents = dashboardData?.expiryEvents ?? [];
  const certificateTotals = useMemo(() => {
    const metricValue = (id: string) =>
      currentMetrics.find((metric) => metric.id === id)?.value ?? 0;
    const highVoltage = metricValue('high-voltage');
    const lowVoltage = metricValue('low-voltage');
    const heightWork = metricValue('height-work');

    return {
      all: highVoltage + lowVoltage + heightWork,
      'high-voltage': highVoltage,
      'low-voltage': lowVoltage,
      'height-work': heightWork,
    };
  }, [currentMetrics]);
  const calendarMonths = useMemo(
    () =>
      dashboardData
        ? buildCertificateCalendarMonths(
            currentExpiryEvents,
            (dashboardData.sourceUpdatedAt || dashboardData.syncedAt).slice(
              0,
              7,
            ),
          )
        : [],
    [currentExpiryEvents, dashboardData],
  );
  const lastUpdated = useMemo(() => {
    const timestamp = dashboardData?.sourceUpdatedAt || dashboardData?.syncedAt;

    if (!timestamp) {
      return isRefreshing ? '同步中' : '--';
    }

    const parsed = new Date(timestamp);

    return Number.isNaN(parsed.getTime())
      ? timestamp.replace('T', ' ').slice(0, 16)
      : formatDashboardTimestamp(parsed);
  }, [dashboardData, isRefreshing]);

  const filteredPeople = useMemo(
    () => filterNonCompliantPeople(currentNonCompliantPeople, searchQuery),
    [currentNonCompliantPeople, searchQuery],
  );
  const peoplePagination = useMemo(
    () => paginateNonCompliantPeople(filteredPeople, peoplePage),
    [filteredPeople, peoplePage],
  );
  const currentPagePeople = peoplePagination.items;

  const showDashboardStatus = useCallback(
    (kind: DashboardStatusKind, message: string) => {
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }

      setDashboardStatus({ kind, message });
      const { autoDismissMs } = getDashboardStatusPresentation(kind);

      if (autoDismissMs !== null) {
        successTimerRef.current = window.setTimeout(() => {
          setDashboardStatus(null);
          successTimerRef.current = null;
        }, autoDismissMs);
      }
    },
    [],
  );

  const loadExpiryNotificationPreview = useCallback(async () => {
    const requestSequence = notificationPreviewRequestRef.current + 1;
    notificationPreviewRequestRef.current = requestSequence;
    setNotificationState({ status: 'loading' });
    try {
      const preview = await getCampusCertificateExpiryNotificationPreview();
      if (notificationPreviewRequestRef.current !== requestSequence) {
        return;
      }
      setNotificationState({ status: 'ready', preview });
    } catch {
      if (notificationPreviewRequestRef.current !== requestSequence) {
        return;
      }
      setNotificationState({
        status: 'error',
        message: '群成员预检失败，请检查飞书连接后重试',
      });
    }
  }, []);

  const loadDashboard = useCallback(
    async (forceRefresh: boolean) => {
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }

      setDashboardStatus(null);
      setInitialLoadError('');
      setIsRefreshing(true);
      try {
        const nextData = await getCampusCertificateDashboard(forceRefresh);
        setDashboardData(nextData);
        hasDashboardDataRef.current = true;
        const sourceMonth = (
          nextData.sourceUpdatedAt || nextData.syncedAt
        ).slice(0, 7);
        const nextMonths = buildCertificateCalendarMonths(
          nextData.expiryEvents,
          sourceMonth,
        );
        setCertificateMonth(
          nextMonths.includes(sourceMonth)
            ? sourceMonth
            : nextMonths[0] || sourceMonth,
        );
        setPeoplePage(1);

        if (nextData.sourceStatus === 'stale') {
          showDashboardStatus(
            'warning',
            `数据源暂不可用，当前展示最近一次成功同步数据${nextData.errorMessage ? `：${nextData.errorMessage}` : ''}`,
          );
        } else if (forceRefresh) {
          showDashboardStatus('success', '持证数据已从飞书多维表格更新');
        }
      } catch {
        if (hasDashboardDataRef.current) {
          showDashboardStatus(
            'error',
            '数据刷新失败，已保留最近一次成功同步数据',
          );
        } else {
          setInitialLoadError('持证数据加载失败，请检查网络后重试');
        }
      } finally {
        setIsRefreshing(false);
      }
    },
    [showDashboardStatus],
  );

  useEffect(() => {
    void loadDashboard(false);

    return () => {
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current);
      }
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (activeDetailKey === 'expiring') {
      void loadExpiryNotificationPreview();
    }
  }, [activeDetailKey, loadExpiryNotificationPreview]);

  const handleNotifyExpiring = useCallback(async () => {
    const preview =
      notificationState.status === 'ready' ||
      notificationState.status === 'sending'
        ? notificationState.preview
        : notificationState.status === 'error'
          ? notificationState.preview
          : undefined;
    if (
      !preview ||
      preview.blocked ||
      preview.matchedCount <= 0 ||
      notificationState.status === 'sending'
    ) {
      return;
    }

    setNotificationState({ status: 'sending', preview });
    try {
      const result = await sendCampusCertificateExpiryNotifications({
        requestId: preview.requestId,
      });
      setNotificationState({
        status: result.success ? 'success' : 'partial',
        preview,
        result,
      });
    } catch {
      setNotificationState({
        status: 'error',
        preview,
        message: '发送结果未确认，可使用同一请求号安全重试',
      });
    }
  }, [notificationState]);

  const handleRefresh = useCallback(() => {
    if (!isRefreshing) {
      void loadDashboard(true);
    }
  }, [isRefreshing, loadDashboard]);

  useEffect(() => {
    onHeaderStateChange?.({
      updatedAt: lastUpdated,
      refreshing: isRefreshing,
      refresh: handleRefresh,
    });
  }, [handleRefresh, isRefreshing, lastUpdated, onHeaderStateChange]);
  const statusPresentation = dashboardStatus
    ? getDashboardStatusPresentation(dashboardStatus.kind)
    : null;

  return (
    <main
      className={`certificate-dashboard certificate-dashboard-root${
        embedded ? ' certificate-dashboard-embedded' : ''
      }`}
    >
      <div
        className="certificate-dashboard-frame"
        style={
          embedded
            ? undefined
            : {
                width: STAGE_WIDTH * scale,
                height: STAGE_HEIGHT * scale,
              }
        }
      >
        <section
          className="certificate-dashboard-stage"
          data-screenshot-target="campus-certificate-dashboard"
          data-screenshot-ready={dashboardData !== null ? 'true' : 'false'}
          style={
            embedded
              ? undefined
              : {
                  width: STAGE_WIDTH,
                  height: STAGE_HEIGHT,
                  transform: `scale(${scale})`,
                }
          }
          aria-label="园区持证信息驾驶舱"
        >
          {!embedded ? (
            <header className="certificate-dashboard-header">
              <div className="certificate-dashboard-title-group">
                <span className="certificate-dashboard-brand-icon">
                  <ShieldCheck aria-hidden="true" />
                </span>
                <div>
                  <h1>持证信息</h1>
                </div>
              </div>

              <div className="certificate-dashboard-actions">
                <p className="certificate-dashboard-updated-at">
                  <CalendarDays aria-hidden="true" />
                  <span>数据更新：{lastUpdated}</span>
                </p>
                <Button
                  type="button"
                  className="certificate-refresh-button"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  aria-busy={isRefreshing}
                >
                  <RefreshCw
                    className={
                      isRefreshing
                        ? 'certificate-refresh-icon certificate-refresh-icon-spinning'
                        : 'certificate-refresh-icon'
                    }
                    aria-hidden="true"
                  />
                  {isRefreshing ? '刷新中' : '刷新'}
                </Button>
              </div>
            </header>
          ) : null}

          {dashboardData && currentSummary ? (
            <div className="certificate-dashboard-body">
              <aside
                className="certificate-left-column"
                aria-label="园区证书概览"
              >
                <Card
                  className="certificate-panel certificate-gauge-card certificate-clickable-card"
                  role="button"
                  tabIndex={0}
                  aria-label="查看园区整体持证合规差距清单"
                  onClick={() => setActiveDetailKey('non-compliant')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setActiveDetailKey('non-compliant');
                    }
                  }}
                >
                  <CardHeader className="certificate-card-header">
                    <div className="certificate-card-heading-row">
                      <h2>园区整体持证合规率</h2>
                      <Info aria-hidden="true" />
                    </div>
                  </CardHeader>
                  <CardContent className="certificate-gauge-content">
                    <ComplianceGauge
                      rate={currentSummary.complianceRate}
                      current={currentSummary.currentQualified}
                      target={currentSummary.targetQualified}
                    />
                  </CardContent>
                </Card>

                {currentMetrics.map((metric) => {
                  const MetricIcon = METRIC_ICONS[metric.id];

                  return (
                    <Card
                      key={metric.id}
                      className={`certificate-panel certificate-metric-card certificate-metric-card-${metric.tone} certificate-clickable-card`}
                      role="button"
                      tabIndex={0}
                      aria-label={`查看${metric.label}具体清单`}
                      onClick={() => setActiveDetailKey(metric.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setActiveDetailKey(metric.id);
                        }
                      }}
                    >
                      <CardContent className="certificate-metric-content">
                        <span className="certificate-metric-icon">
                          <MetricIcon aria-hidden="true" />
                        </span>
                        <div className="certificate-metric-copy">
                          <p>{metric.label}</p>
                          <strong>
                            {metric.value}
                            <small> 人</small>
                          </strong>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </aside>

              <Card className="certificate-panel certificate-heatmap-card">
                <CardContent className="certificate-heatmap-card-content">
                  <ExpiryHeatmap
                    month={certificateMonth}
                    onMonthChange={setCertificateMonth}
                    filter={certificateFilter}
                    onFilterChange={setCertificateFilter}
                    events={currentExpiryEvents}
                    availableMonths={calendarMonths}
                    totals={certificateTotals}
                    onDateSelect={setActiveExpiryDate}
                    onMonthSelect={setActiveExpiryDate}
                    onMetricSelect={setActiveDetailKey}
                  />
                </CardContent>
              </Card>

              <div className="certificate-right-column">
                <Card className="certificate-panel certificate-building-card">
                  <CardHeader className="certificate-card-header certificate-building-header">
                    <div className="certificate-card-heading-row">
                      <h2>各楼持证合规情况</h2>
                      <TrendingUp aria-hidden="true" />
                    </div>
                  </CardHeader>
                  <CardContent className="certificate-building-content">
                    <div
                      className="certificate-building-summaries"
                      aria-label="楼栋合规摘要"
                    >
                      <Card
                        className="certificate-summary-card certificate-summary-card-blue certificate-clickable-card"
                        role="button"
                        tabIndex={0}
                        aria-label="查看合规人员具体清单"
                        onClick={() => setActiveDetailKey('compliant')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setActiveDetailKey('compliant');
                          }
                        }}
                      >
                        <CardContent>
                          <span>合规总数</span>
                          <strong>{currentSummary.compliantPeople}</strong>
                        </CardContent>
                      </Card>
                      <Card
                        className="certificate-summary-card certificate-summary-card-orange certificate-clickable-card"
                        role="button"
                        tabIndex={0}
                        aria-label="查看不合规人员具体清单"
                        onClick={() => setActiveDetailKey('non-compliant')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setActiveDetailKey('non-compliant');
                          }
                        }}
                      >
                        <CardContent>
                          <span>不合规总数</span>
                          <strong>{currentSummary.nonCompliantPeople}</strong>
                        </CardContent>
                      </Card>
                      <Card
                        className="certificate-summary-card certificate-summary-card-green certificate-clickable-card"
                        role="button"
                        tabIndex={0}
                        aria-label="查看各楼合规率具体清单"
                        onClick={() => setActiveDetailKey('average-rate')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setActiveDetailKey('average-rate');
                          }
                        }}
                      >
                        <CardContent>
                          <span>平均合规率</span>
                          <strong>
                            {currentSummary.averageComplianceRate}%
                          </strong>
                        </CardContent>
                      </Card>
                    </div>
                    <BuildingComplianceChart
                      items={currentBuildings}
                      onSelect={(building, series) => setActiveBuilding({ building, series })}
                    />
                  </CardContent>
                </Card>

                <Card className="certificate-panel certificate-people-card">
                  <CardHeader className="certificate-card-header certificate-people-header">
                    <div className="certificate-card-heading-row">
                      <h2>持证不合规人员</h2>
                      <Badge className="certificate-people-count-badge">
                        {filteredPeople.length} 人
                      </Badge>
                    </div>
                    <div className="certificate-search-field">
                      <Search aria-hidden="true" />
                      <label
                        className="certificate-sr-only"
                        htmlFor="certificate-person-search"
                      >
                        搜索姓名、证书或岗位
                      </label>
                      <Input
                        id="certificate-person-search"
                        name="certificate-person-search"
                        autoComplete="off"
                        value={searchQuery}
                        onChange={(event) => {
                          setSearchQuery(event.target.value);
                          setPeoplePage(1);
                        }}
                        placeholder="搜索姓名、证书或岗位"
                        aria-label="搜索姓名、证书或岗位"
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="certificate-people-content">
                    <div className="certificate-people-table-region">
                      <Table
                        className="certificate-people-table"
                        aria-label="持证不合规人员列表"
                      >
                        <TableHeader>
                          <TableRow>
                            <TableHead>持证是否合规</TableHead>
                            <TableHead>楼栋/站点</TableHead>
                            <TableHead>姓名</TableHead>
                            <TableHead>岗位</TableHead>
                            <TableHead>缺少的证书</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {currentPagePeople.length > 0 ? (
                            currentPagePeople.map((person) => (
                              <TableRow key={person.id}>
                                <TableCell>
                                  <Badge className="certificate-badge-noncompliant">
                                    不合规
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge className="certificate-badge-building">
                                    {person.building}
                                  </Badge>
                                </TableCell>
                                <TableCell className="certificate-person-name">
                                  {person.name}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    className={`certificate-badge-position certificate-badge-position-${person.positionTone}`}
                                  >
                                    {person.position}
                                  </Badge>
                                </TableCell>
                                <TableCell className="certificate-missing-certificate">
                                  <span title={person.missingCertificate}>
                                    {person.missingCertificate}
                                  </span>
                                </TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <TableRow>
                              <TableCell
                                colSpan={5}
                                className="certificate-people-empty"
                              >
                                未找到匹配的不合规人员
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>

                    <footer className="certificate-table-footer">
                      <p>共 {peoplePagination.total} 条</p>
                      <nav
                        className="certificate-pagination"
                        aria-label="不合规人员分页"
                      >
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!peoplePagination.hasPrevious}
                          aria-label="上一页"
                          title="上一页"
                          onClick={() =>
                            setPeoplePage(peoplePagination.page - 1)
                          }
                        >
                          <ChevronLeft aria-hidden="true" />
                          上一页
                        </Button>
                        <span
                          className="certificate-page-current"
                          aria-current="page"
                        >
                          {peoplePagination.page} / {peoplePagination.pageCount}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!peoplePagination.hasNext}
                          aria-label="下一页"
                          title="下一页"
                          onClick={() =>
                            setPeoplePage(peoplePagination.page + 1)
                          }
                        >
                          下一页
                          <ChevronRight aria-hidden="true" />
                        </Button>
                      </nav>
                    </footer>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            <div
              className={`certificate-dashboard-data-state ${
                initialLoadError
                  ? 'certificate-dashboard-data-state-error'
                  : 'certificate-dashboard-data-state-loading'
              }`}
              role={initialLoadError ? 'alert' : 'status'}
              aria-live="polite"
            >
              <span className="certificate-dashboard-data-state-icon">
                {initialLoadError ? (
                  <Info aria-hidden="true" />
                ) : (
                  <RefreshCw
                    className="certificate-refresh-icon-spinning"
                    aria-hidden="true"
                  />
                )}
              </span>
              <strong>
                {initialLoadError ? '持证数据加载失败' : '正在同步飞书持证数据'}
              </strong>
              <p>
                {initialLoadError
                  ? initialLoadError
                  : '首次加载需要读取并汇总最新持证记录，请稍候。'}
              </p>
              {initialLoadError ? (
                <Button
                  type="button"
                  className="certificate-data-retry-button"
                  onClick={() => void loadDashboard(false)}
                  disabled={isRefreshing}
                >
                  <RefreshCw aria-hidden="true" />
                  重试
                </Button>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <CertificateMetricDetailDialog
        detailKey={activeDetailKey}
        onOpenChange={(open) => {
          if (!open) {
            notificationPreviewRequestRef.current += 1;
            setActiveDetailKey(null);
            setNotificationState({ status: 'idle' });
          }
        }}
        people={currentPeople}
        buildings={currentBuildings}
        expiryEvents={currentExpiryEvents}
        referenceDate={
          dashboardData?.sourceUpdatedAt || dashboardData?.syncedAt || ''
        }
        notificationState={notificationState}
        onNotifyExpiring={() => void handleNotifyExpiring()}
        onRetryNotificationPreview={() => void loadExpiryNotificationPreview()}
      />

      <CertificateExpiryDayDetailDialog
        date={activeExpiryDate}
        filter={certificateFilter}
        events={currentExpiryEvents}
        people={currentPeople}
        onOpenChange={(open) => {
          if (!open) {
            setActiveExpiryDate(null);
          }
        }}
      />

      <CertificateBuildingDetailDialog
        selection={activeBuilding}
        buildings={currentBuildings}
        people={currentPeople}
        onOpenChange={(open) => {
          if (!open) setActiveBuilding(null);
        }}
      />

      <div
        className={`certificate-refresh-status ${
          statusPresentation?.className ?? ''
        } ${
          dashboardStatus ? 'certificate-refresh-status-visible' : ''
        }`.trim()}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-status={dashboardStatus?.kind}
      >
        {dashboardStatus?.message}
      </div>
    </main>
  );
}
