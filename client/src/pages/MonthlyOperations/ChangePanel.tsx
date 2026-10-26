import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  GitCompareArrows,
  RefreshCw,
  Siren,
  Activity,
  ShieldAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TrendChart, Distribution, EmptyState, Panel } from './charts';
import { MetricCard } from './components';
import { WorkCalendar } from './WorkPanels';
import { ChangeList } from './ChangeList';
import { ZhihangProgressPanel } from './ZhihangProgressPanel';
import { eventTime as time } from './EventList';
import { useChanges } from './change-data';
import { useSourceStamp } from './SourceStamp';
import { FeishuSourceLinks } from './FeishuSourceLinks';
import {
  CHANGE_FILTERS,
  CHANGE_STATES,
  changeGroups,
  changeCohorts,
  changeScope,
  changeTrend,
  filterChanges,
  type ChangeFilters,
} from './change-model';
import type { PanelProps } from './Overview';
const StableChangeList = memo(ChangeList);
const StableProgressPanel = memo(ZhihangProgressPanel);

export function ChangePanel({ view }: PanelProps) {
  const { data, loading, error, retry } = useChanges(view.period);
  useSourceStamp('changes', data?.syncedAt);
  const ready = !!data && data.status !== 'error';
  const rows = useMemo(
    () =>
      changeScope(
        data?.records ?? [],
        view.period.start,
        view.period.end,
        view.building,
      ),
    [data, view.period.start, view.period.end, view.building],
  );
  const [dimension, setDimension] = useState<'state' | 'type' | 'specialty'>(
    'state',
  );
  const [selection, setSelection] = useState<{
    title: string;
    filter: Partial<ChangeFilters>;
    pending?: boolean;
  } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const cohorts = useMemo(() => changeCohorts(rows), [rows]);
  const selectedRows = useMemo(
    () =>
      !selection
        ? []
        : filterChanges(selection.pending ? cohorts.pending : rows, {
            ...CHANGE_FILTERS,
            ...selection.filter,
          }),
    [rows, cohorts, selection],
  );
  const open = useCallback(
    (title: string, filter: Partial<ChangeFilters> = {}, pending = false) => {
      trigger.current = document.activeElement as HTMLElement;
      setSelection({ title, filter, pending });
    },
    [],
  );
  const status = loading
    ? '正在读取变更…'
    : error ||
      data?.message ||
      (data?.syncedAt ? `更新于 ${time(data.syncedAt)}` : '暂无数据');
  const count = (value: number) => (ready ? String(value) : '—');
  const chartContent = useMemo(
    () =>
      ready ? (
        <div className="mo-three-columns mo-event-charts mo-change-charts">
          <Panel title="变更分布">
            <Tabs
              value={dimension}
              onValueChange={(v) => setDimension(v as typeof dimension)}
            >
              <TabsList>
                <TabsTrigger value="state">执行结果</TabsTrigger>
                <TabsTrigger value="type">变更类型</TabsTrigger>
                <TabsTrigger value="specialty">专业</TabsTrigger>
              </TabsList>
            </Tabs>
            <Distribution
              rows={changeGroups(rows, dimension)}
              label="周期变更"
              onSelect={(name) =>
                open(name + '变更清单', {
                  [dimension]:
                    dimension === 'state'
                      ? Object.keys(CHANGE_STATES).find(
                          (k) =>
                            CHANGE_STATES[k as keyof typeof CHANGE_STATES] ===
                            name,
                        )
                      : name,
                })
              }
            />
          </Panel>
          <Panel title="变更日历">
            <WorkCalendar
              records={rows}
              period={{ ...view.period, asOf: view.period.end }}
              onSelect={(date) => open(date + '变更清单', { date })}
            />
          </Panel>
          <Panel
            title={
              view.period.grain === 'month' ? '变更月度趋势' : '变更日趋势'
            }
          >
            <TrendChart
              rows={changeTrend(
                rows,
                view.period.start,
                view.period.end,
                view.period.grain,
              )}
              series={[
                { key: 'total', name: '计划变更' },
                { key: 'done', name: '已完成' },
              ]}
              unit="项"
              dateAxis={false}
              onSelect={(name) => {
                const date =
                  name.length === 5
                    ? `${view.period.start.slice(0, 4)}-${name.replace('/', '-')}`
                    : name.replace('/', '-');
                open(`${date}变更清单`, { date });
              }}
            />
          </Panel>
        </div>
      ) : (
        <EmptyState
          title={loading ? '正在读取变更' : '变更数据暂不可用'}
          description=""
        />
      ),
    [ready, rows, dimension, view.period, loading, open],
  );
  return (
    <div className="mo-topic-content mo-events mo-changes">
      <div className="mo-section-heading">
        <div>
          <span className="mo-eyebrow">CHANGE OPERATIONS</span>
          <h2>变更管理</h2>
        </div>
        <div className="mo-heading-actions">
          <FeishuSourceLinks source="changes" />
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
          {error ||
            (data?.status === 'stale'
              ? data.message
              : loading && !data
                ? '正在读取…'
                : '')}
        </span>
        <Button variant="ghost" disabled={loading} onClick={retry}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          刷新变更
        </Button>
      </div>
      <div className="mo-metrics mo-change-metrics">
        <MetricCard
          title={view.period.scope + '变更'}
          value={count(rows.length)}
          unit="项"
          note={`${view.period.start} 至 ${view.period.end}`}
          icon={GitCompareArrows}
          onClick={() => open('周期变更清单')}
        />
        <MetricCard
          title="进行中变更"
          value={count(cohorts.running.length)}
          unit="项"
          note=""
          icon={Activity}
          onClick={() => open('进行中变更清单', { state: 'running' })}
        />
        <MetricCard
          title="中风险及以上"
          value={count(cohorts.priority.length)}
          unit="项"
          note="重点关注"
          icon={ShieldAlert}
          tone="amber"
          onClick={() => open('中风险及以上变更清单', { risk: 'priority' })}
        />
        <MetricCard
          title="已完成变更"
          value={count(cohorts.done.length)}
          unit="项"
          note={
            ready && rows.length
              ? `完成占比 ${((cohorts.done.length / rows.length) * 100).toFixed(1)}%`
              : ''
          }
          icon={CheckCircle2}
          tone="teal"
          onClick={() => open('已完成变更清单', { state: 'done' })}
        />
        <MetricCard
          title="待跟进变更"
          value={count(cohorts.pending.length)}
          unit="项"
          note=""
          icon={Clock3}
          tone="amber"
          onClick={() => open('待跟进变更清单', {}, true)}
        />
        <MetricCard
          title="紧急变更"
          value={count(cohorts.emergency.length)}
          unit="项"
          note=""
          icon={Siren}
          tone="violet"
          onClick={() => open('紧急变更清单', { type: '紧急变更' })}
        />
      </div>
      <StableProgressPanel view={view} />
      {chartContent}
      <Panel title="变更清单">
        <StableChangeList
          records={rows}
          ready={ready}
          loading={loading}
          error={error || data?.message}
        />
      </Panel>
      <Sheet
        open={!!selection}
        onOpenChange={(isOpen) => {
          if (!isOpen) setSelection(null);
        }}
      >
        <SheetContent
          className="monthly-operations mo-detail-sheet mo-resource-sheet mo-event-metric-sheet mo-change-metric-sheet"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <SheetHeader className="mo-detail-header">
            <SheetTitle>{selection?.title}</SheetTitle>
            <SheetDescription className="sr-only">
              当前变更指标对应的清单
            </SheetDescription>
            <div className="mo-detail-meta">
              <span>
                {view.period.start} 至 {view.period.end}
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
                <span>{status}</span>
                <Button variant="ghost" disabled={loading} onClick={retry}>
                  重试
                </Button>
              </div>
            )}
            <ChangeList
              key={selection?.title}
              records={selectedRows}
              ready={ready}
              loading={loading}
              error={error || data?.message}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
