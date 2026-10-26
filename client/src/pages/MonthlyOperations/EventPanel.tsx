import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CalendarDays,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { EventList, eventTime as time } from './EventList';
import {
  ColumnChart,
  Distribution,
  EmptyState,
  Panel,
  TrendChart,
  CHART_COLORS,
} from './charts';
import { MetricCard } from './components';
import { WorkCalendar } from './WorkPanels';
import type { PanelProps } from './Overview';
import { useEvents } from './event-data';
import { useSourceStamp } from './SourceStamp';
import { FeishuSourceLinks } from './FeishuSourceLinks';
import {
  DEFAULT_EVENT_FILTERS,
  filterEvents,
  eventMetricRecords,
  eventPrioritySummary,
  type EventMetric,
  eventGroups,
  eventMonthlyTrend,
  type EventFilters,
} from './event-model';
const repairLabels = {
  active: '检修中',
  done: '检修完成',
  none: '未转检修',
  unknown: '待确认',
};
const StableEventList = memo(EventList);
type PriorityCategory =
  | 'all'
  | 'repeated'
  | 'deviceRepeated'
  | 'review'
  | 'highLevel'
  | 'overdue';

function sourceSummary(total: number, rows: { name: string; value: number }[]) {
  if (!total || !rows.length) return '当前范围暂无事件。';
  const [first, second] = rows,
    ratio = (value: number) => `${Math.round((value / total) * 100)}%`,
    remainder = total - first.value - (second?.value ?? 0);
  return `${total} 项；${first.name} ${first.value} 项（${ratio(first.value)}）最多${
    second
      ? `，${second.name} ${second.value} 项（${ratio(second.value)}）次之`
      : ''
  }${remainder > 0 ? `，其余 ${remainder} 项` : ''}。`;
}

export function EventPanel({ view }: PanelProps) {
  const { data, loading, error, retry } = useEvents(view.period);
  useSourceStamp('events', data?.syncedAt);
  const [chartFilter, setChartFilter] = useState<EventFilters | null>(null);
  const [filters, setFilters] = useState<EventFilters>(DEFAULT_EVENT_FILTERS),
    [activeMetric, setActiveMetric] = useState<EventMetric | null>(null),
    [metricFilters, setMetricFilters] = useState<EventFilters>({
      ...DEFAULT_EVENT_FILTERS,
      state: 'all',
    }),
    [priorityCategory, setPriorityCategory] = useState<PriorityCategory>('all'),
    [calendar, setCalendar] = useState<'month' | 'heat'>('month');
  const tableRef = useRef<HTMLDivElement>(null),
    metricTrigger = useRef<HTMLElement | null>(null);
  const records = useMemo(
    () =>
      (data?.records ?? []).filter(
        (r) => view.building === 'all' || r.building === view.building,
      ),
    [data, view.building],
  );
  const prioritySummary = useMemo(
      () => eventPrioritySummary(records, view.period.asOf),
      [records, view.period.asOf],
    ),
    metricRecords = useMemo(
      () =>
        eventMetricRecords(
          records,
          view.period.start,
          view.period.asOf,
          prioritySummary.records,
        ),
      [records, view.period.start, view.period.asOf, prioritySummary.records],
    );
  const { period, year: annual } = metricRecords;
  const metricTitles = {
    year: '年度事件',
    period: view.period.scope + '事件',
    open: '未闭环事件',
    key: 'I2 及以上',
    active: '检修中事件',
    priority: '重点事件',
  };
  const openMetric = (key: EventMetric) => {
    setChartFilter(null);
    metricTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMetricFilters({ ...DEFAULT_EVENT_FILTERS, state: 'all' });
    setPriorityCategory('all');
    setActiveMetric(key);
  };
  const apply = useCallback((patch: Partial<EventFilters>, reset = false) => {
    setFilters((f) => ({
      ...(reset ? { ...DEFAULT_EVENT_FILTERS, state: 'all' as const } : f),
      ...patch,
    }));
    if (reset) {
      metricTrigger.current = document.activeElement as HTMLElement;
      setChartFilter({ ...DEFAULT_EVENT_FILTERS, state: 'all', ...patch });
      setMetricFilters({ ...DEFAULT_EVENT_FILTERS, state: 'all' });
      setPriorityCategory('all');
      setActiveMetric('period');
    }
  }, []);
  const unresolved = records.filter(
    (r) => r.closed === false || r.repair === 'active',
  );
  const specialties = [...new Set(unresolved.map((r) => r.specialty))];
  const unresolvedRows = [...new Set(unresolved.map((r) => r.building))]
    .sort()
    .map((name) =>
      Object.fromEntries([
        ['name', name],
        ...specialties.map((s, i) => [
          's' + i,
          unresolved.filter((r) => r.building === name && r.specialty === s)
            .length,
        ]),
      ]),
    );
  const counts = new Map<string, number>();
  annual.forEach((r) => counts.set(r.date, (counts.get(r.date) ?? 0) + 1));
  const yearStart = view.period.asOf.slice(0, 4) + '-01-01',
    heatDays =
      Math.round(
        (Date.parse(view.period.asOf) - Date.parse(yearStart)) / 86400000,
      ) + 1;
  const ready = !!data && data.status !== 'error';
  const metric = (n: number) => (ready ? String(n) : '—');
  const sourceRows = eventGroups(period, 'source'),
    repairRows = eventGroups(records, 'repair').map((r) => ({
      ...r,
      name: repairLabels[r.name as keyof typeof repairLabels],
    })),
    repairSummary = records.length
      ? `历史 ${records.length} 项；${repairRows
          .map(
            (row) =>
              `${row.name} ${row.value} 项（${Math.round(
                (row.value / records.length) * 100,
              )}%）`,
          )
          .join('，')}。`
      : '当前范围暂无事件。';
  const popupRecords = useMemo(() => {
      if (!activeMetric) return [];
      const base = chartFilter
        ? filterEvents(
            records,
            chartFilter,
            view.period.start,
            view.period.asOf,
          )
        : metricRecords[activeMetric];
      if (activeMetric !== 'priority' || priorityCategory === 'all')
        return base;
      if (priorityCategory === 'repeated') return prioritySummary.repeated;
      const selected = new Set(
        prioritySummary[priorityCategory].map((record) => record.id),
      );
      return base.filter((record) => selected.has(record.id));
    }, [
      activeMetric,
      chartFilter,
      metricRecords,
      priorityCategory,
      prioritySummary,
      records,
      view.period.start,
      view.period.asOf,
    ]),
    popupBuildingRows = useMemo(
      () =>
        eventGroups(popupRecords, 'building').map((row) => ({
          name: row.name,
          total: row.value,
        })),
      [popupRecords],
    ),
    popupSpecialtyRows = useMemo(
      () => eventGroups(popupRecords, 'specialty'),
      [popupRecords],
    );
  const chartContent = useMemo(
    () =>
      ready ? (
        <>
          <div className="mo-three-columns mo-event-charts">
            <Panel title="事件来源分布">
              <Distribution
                rows={sourceRows}
                label="周期事件"
                onSelect={(source) => apply({ scope: 'period', source }, true)}
              />
              <p className="mo-event-insight">
                {sourceSummary(period.length, sourceRows)}
              </p>
            </Panel>
            <Panel title="事件转检修">
              <Distribution
                rows={repairRows}
                label="历史累计"
                onSelect={(name) =>
                  apply(
                    {
                      state: (Object.keys(repairLabels).find(
                        (k) =>
                          repairLabels[k as keyof typeof repairLabels] === name,
                      ) ?? 'all') as EventFilters['state'],
                    },
                    true,
                  )
                }
              />
              <p className="mo-event-insight">{repairSummary}</p>
            </Panel>
            <Panel title="事件分布日历">
              <div
                className="mo-view-switch"
                role="group"
                aria-label="事件日历模式"
              >
                <Button
                  variant="ghost"
                  aria-pressed={calendar === 'month'}
                  onClick={() => setCalendar('month')}
                >
                  月日历
                </Button>
                <Button
                  variant="ghost"
                  aria-pressed={calendar === 'heat'}
                  onClick={() => setCalendar('heat')}
                >
                  年度热力
                </Button>
              </div>
              {calendar === 'month' ? (
                <WorkCalendar
                  records={period}
                  period={view.period}
                  onSelect={(date) => apply({ scope: 'period', date }, true)}
                />
              ) : (
                <div className="mo-event-heat-wrap">
                  <div className="mo-event-heat" aria-label="年度事件热力图">
                    {Array.from({ length: heatDays }, (_, i) => {
                      const date = new Date(
                          Date.parse(yearStart) + i * 86400000,
                        )
                          .toISOString()
                          .slice(0, 10),
                        n = counts.get(date) ?? 0;
                      return (
                        <button
                          key={date}
                          style={
                            {
                              '--heat': n ? Math.min(0.22 + n * 0.12, 1) : 0.06,
                            } as React.CSSProperties
                          }
                          aria-label={`${date} ${n} 条事件`}
                          title={`${date} · ${n} 条`}
                          onClick={() => apply({ scope: 'year', date }, true)}
                        />
                      );
                    })}
                  </div>
                  <div className="mo-summary-foot">
                    {yearStart} — {view.period.asOf}
                  </div>
                </div>
              )}
            </Panel>
          </div>
          <div className="mo-two-columns mo-event-charts">
            <Panel
              title="未解决事件 · 楼栋与专业"
              onAction={() => apply({ state: 'unresolved' }, true)}
            >
              <ColumnChart
                rows={unresolvedRows}
                series={specialties.map((name, i) => ({
                  key: 's' + i,
                  name,
                  color: CHART_COLORS[i % CHART_COLORS.length],
                }))}
                onSelect={(building, series) =>
                  apply(
                    {
                      state: 'unresolved',
                      building,
                      specialty: series
                        ? specialties[Number(series.slice(1))]
                        : '',
                    },
                    true,
                  )
                }
              />
            </Panel>
            <Panel
              title="近12个月事件趋势"
              action={`${Number(view.period.asOf.slice(5, 7))}月截至${Number(view.period.asOf.slice(8))}日`}
              onAction={() => apply({ scope: 'period' }, true)}
            >
              <TrendChart
                rows={eventMonthlyTrend(records, view.period.asOf)}
                series={[{ key: 'total', name: '事件数量' }]}
                unit="项"
                onSelect={(month) =>
                  apply({ scope: 'history', state: 'all', date: month }, true)
                }
              />
            </Panel>
          </div>
        </>
      ) : (
        <EmptyState
          title={
            loading ? '事件正在加载' : error || data?.message || '暂无事件数据'
          }
          description=""
        />
      ),
    [
      ready,
      calendar,
      records,
      period,
      annual,
      view.period,
      loading,
      error,
      data?.message,
      apply,
    ],
  );
  return (
    <div className="mo-topic-content mo-events">
      <div className="mo-section-heading">
        <div>
          <span className="mo-eyebrow">EVENT OPERATIONS</span>
          <h2>事件管理</h2>
        </div>
        <div className="mo-heading-actions">
          <FeishuSourceLinks source="events" />
          <Badge variant="outline">实际数据</Badge>
        </div>
      </div>
      <div className="mo-live-status" role="status">
        <span
          className={
            error || data?.status === 'error' || data?.status === 'stale'
              ? 'is-error'
              : ''
          }
        >
          {loading
            ? '正在读取事件…'
            : error || data?.message || (data ? '' : '暂无数据')}
        </span>
        <Button variant="ghost" size="sm" onClick={retry} disabled={loading}>
          <RefreshCw className={loading ? 'mo-spin' : ''} />
          刷新事件
        </Button>
      </div>
      <div className="mo-metrics mo-event-metrics">
        <MetricCard
          title="年度事件"
          value={metric(annual.length)}
          unit="项"
          note={view.period.asOf.slice(0, 4) + ' 年'}
          icon={CalendarDays}
          onClick={() => openMetric('year')}
        />
        <MetricCard
          title={view.period.scope + '事件'}
          value={metric(period.length)}
          unit="项"
          note={view.period.rangeLabel}
          icon={Activity}
          onClick={() => openMetric('period')}
        />
        <MetricCard
          title="未闭环事件"
          value={metric(metricRecords.open.length)}
          unit="项"
          note="历史存量 · 当前状态"
          tone="amber"
          icon={Activity}
          onClick={() => openMetric('open')}
        />
        <MetricCard
          title="I2 及以上"
          value={metric(metricRecords.key.length)}
          unit="项"
          note="历史累计 · I1 / I2 / E"
          icon={ShieldCheck}
          onClick={() => openMetric('key')}
        />
        <MetricCard
          title="检修中事件"
          value={metric(metricRecords.active.length)}
          unit="项"
          note="历史存量 · 当前状态"
          tone="amber"
          icon={Wrench}
          onClick={() => openMetric('active')}
        />
        <MetricCard
          title="重点事件"
          value={metric(metricRecords.priority.length)}
          unit="项"
          note="全量历史 · 去重"
          tone="amber"
          icon={ShieldAlert}
          onClick={() => openMetric('priority')}
        />
      </div>
      {chartContent}

      <div ref={tableRef} className="mo-event-list">
        <Panel title="事件清单">
          <StableEventList
            records={records}
            period={view.period}
            filters={filters}
            onChange={setFilters}
            loading={loading}
            ready={ready}
            error={error || data?.message}
          />
        </Panel>
      </div>
      {activeMetric && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setActiveMetric(null);
          }}
        >
          <SheetContent
            className="monthly-operations mo-detail-sheet mo-resource-sheet mo-event-metric-sheet"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              metricTrigger.current?.focus({ preventScroll: true });
            }}
          >
            <SheetHeader className="mo-detail-header">
              <SheetTitle>
                {chartFilter
                  ? [
                      chartFilter.date,
                      chartFilter.building,
                      chartFilter.specialty,
                      chartFilter.source,
                      '事件明细',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : metricTitles[activeMetric] + '清单'}
              </SheetTitle>
              <SheetDescription className="sr-only">
                当前指标对应的事件记录，支持筛选、导出及查看详情
              </SheetDescription>
              <div className="mo-detail-context">
                <span>
                  {activeMetric === 'year'
                    ? view.period.asOf.slice(0, 4) + ' 年'
                    : activeMetric === 'period'
                      ? view.period.rangeLabel
                      : activeMetric === 'priority'
                        ? '全量历史 · 截至 ' + view.period.asOf
                        : '截至 ' + view.period.asOf}
                </span>
                <span>
                  {view.building === 'all' ? '全部楼栋' : view.building}
                </span>
              </div>
            </SheetHeader>
            <div className="mo-resource-sheet-body">
              {(loading ||
                error ||
                data?.status === 'stale' ||
                data?.status === 'error') && (
                <div className="mo-live-status" role="status">
                  <span
                    className={
                      error ||
                      data?.status === 'stale' ||
                      data?.status === 'error'
                        ? 'is-error'
                        : ''
                    }
                  >
                    {loading
                      ? '正在读取事件…'
                      : ready
                        ? '当前展示最近一次成功同步的数据'
                        : error || data?.message || '事件读取失败'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={retry}
                    disabled={loading}
                  >
                    <RefreshCw className={loading ? 'mo-spin' : ''} />
                    重试
                  </Button>
                </div>
              )}
              {activeMetric === 'priority' && !chartFilter && (
                <div
                  className="mo-priority-breakdown"
                  role="group"
                  aria-label="重点事件分类"
                >
                  {[
                    {
                      key: 'all' as const,
                      label: '全部重点',
                      value: prioritySummary.records.length,
                      note: '去重后',
                    },
                    {
                      key: 'repeated' as const,
                      label: '高重复事件',
                      value: prioritySummary.repeated.length,
                      note: `${prioritySummary.rapidRepeatGroupCount} 组 3 个月内重复`,
                    },
                    {
                      key: 'deviceRepeated' as const,
                      label: '同设备多发',
                      value: prioritySummary.deviceRepeated.length,
                      note: '同设备编号至少 2 次',
                    },
                    {
                      key: 'review' as const,
                      label: '复盘事件',
                      value: prioritySummary.review.length,
                      note: '人工标记 / 已有报告',
                    },
                    {
                      key: 'highLevel' as const,
                      label: '高等级事件',
                      value: prioritySummary.highLevel.length,
                      note: 'I2 / I1 / E',
                    },
                    {
                      key: 'overdue' as const,
                      label: '长期未闭环',
                      value: prioritySummary.overdue.length,
                      note: '逾 7 天 / 检修中',
                    },
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      data-kind={
                        item.key === 'deviceRepeated' ? 'device' : undefined
                      }
                      aria-pressed={priorityCategory === item.key}
                      onClick={() => {
                        setPriorityCategory(item.key);
                        setMetricFilters({
                          ...DEFAULT_EVENT_FILTERS,
                          state: 'all',
                        });
                      }}
                    >
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                      <small>{item.note}</small>
                    </button>
                  ))}
                </div>
              )}
              <div className="mo-event-popup-charts">
                <Panel title="各楼事件分布">
                  <ColumnChart
                    rows={popupBuildingRows}
                    series={[
                      {
                        key: 'total',
                        name: '事件数量',
                        color: 'var(--mo-blue)',
                      },
                    ]}
                    unit="项"
                    onSelect={(building) =>
                      setMetricFilters((current) => ({
                        ...current,
                        building,
                      }))
                    }
                  />
                </Panel>
                <Panel title="专业分布">
                  <Distribution
                    rows={popupSpecialtyRows}
                    label="事件数量"
                    onSelect={(specialty) =>
                      setMetricFilters((current) => ({
                        ...current,
                        specialty,
                      }))
                    }
                  />
                </Panel>
              </div>
              <EventList
                records={popupRecords}
                timelineRecords={records}
                period={view.period}
                filters={metricFilters}
                onChange={setMetricFilters}
                loading={loading}
                ready={ready}
                error={error || data?.message}
                fixedScope
                priorityReasons={
                  activeMetric === 'priority'
                    ? prioritySummary.reasons
                    : undefined
                }
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
