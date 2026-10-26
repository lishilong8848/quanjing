import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  GitCompareArrows,
  BellRing,
  Building2,
  ClipboardCheck,
  ChartNoAxesCombined,
  Compass,
  LayoutDashboard,
  Server,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BUILDINGS,
  buildPeriodView,
  type BuildingFilter,
  type DetailSelection,
  type Topic,
} from './model';
import { createPeriodDemo } from './mock-data';
import { DEMO_AS_OF, resolvePeriod, type PeriodSelection } from './period';
import { PeriodControl } from './PeriodControl';
import { AssessmentPanel } from './AssessmentPanel';
import { Overview } from './Overview';
import { CapacityPanel, EnergyPanel } from './ResourcePanels';
import { AlarmPanel } from './AlarmPanel';
import { prefetchAlarms } from './alarm-data';
import { EventPanel } from './EventPanel';
import { ChangePanel } from './ChangePanel';
import { prefetchEvents } from './event-data';
import { prefetchChanges, prefetchProgress } from './change-data';
import { prefetchAssessment } from './assessment-data';
import { prefetchMaintenance } from './maintenance-data';
import { MaintenancePanel } from './MaintenancePanel';
import { SourceStamp, SourceStampProvider } from './SourceStamp';
import { DetailSheet } from './DetailSheet';
import { ResourceProvider, prefetchResources } from './resource-data';
import { ResourceDetailSheet } from './ResourceDetailSheet';
import './styles.css';

const TOPICS = [
  { key: 'overview', label: '月度总览', icon: LayoutDashboard },
  { key: 'capacity', label: '容量资源', icon: Server },
  { key: 'energy', label: '能源水耗', icon: Zap },
  { key: 'events', label: '事件管理', icon: Activity },
  { key: 'changes', label: '变更管理', icon: GitCompareArrows },
  { key: 'assurance', label: '维护推进', icon: ShieldCheck },
  { key: 'alarms', label: '告警分析', icon: BellRing },
  { key: 'assessment', label: '智航考核', icon: ClipboardCheck },
] as const;

export default function MonthlyOperationsPage() {
  const [period, setPeriod] = useState<PeriodSelection>({
    mode: 'month',
    month: DEMO_AS_OF.slice(0, 7),
  });
  const [building, setBuilding] = useState<BuildingFilter>('all');
  const [topic, setTopic] = useState<Topic>('overview');
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const requestedPeriod = resolvePeriod(period);
  const data = useMemo(() => createPeriodDemo(period), [period]);
  const view = useMemo(
    () => buildPeriodView(data, period, building),
    [data, period, building],
  );
  useEffect(() => {
    const range = { start: requestedPeriod.start, end: requestedPeriod.end };
    const recent = resolvePeriod({ mode: 'last30' });
    const ranges = range.start === recent.start && range.end === recent.end
      ? [range]
      : [{ start: recent.start, end: recent.end }, range];
    const timers = [
      prefetchResources,
      prefetchEvents,
      prefetchChanges,
      prefetchProgress,
      prefetchAssessment,
      prefetchMaintenance,
      prefetchAlarms,
    ].flatMap((load, i) => ranges.map((target, j) =>
      window.setTimeout(
        () => {
          void load(target);
        },
        150 * i + 75 * j,
      ),
    ));
    return () => timers.forEach(window.clearTimeout);
  }, [requestedPeriod.start, requestedPeriod.end]);
  const changePeriod = (next: PeriodSelection) => {
    setSelection(null);
    setPeriod(next);
  };
  const openDetail = useCallback((next: DetailSelection) => {
    detailTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSelection(next);
  }, []);
  const panelContent = useMemo(() => {
    const panelProps = { view, openDetail };
    switch (topic) {
      case 'overview':
        return (
          <Overview key={view.building} {...panelProps} onTopic={setTopic} />
        );
      case 'capacity':
        return <CapacityPanel {...panelProps} />;
      case 'energy':
        return <EnergyPanel {...panelProps} />;
      case 'events':
        return (
          <EventPanel
            key={`${view.period.key}-${view.building}`}
            {...panelProps}
          />
        );
      case 'changes':
        return (
          <ChangePanel
            key={`${view.period.key}-${view.building}`}
            {...panelProps}
          />
        );
      case 'assurance':
        return <MaintenancePanel {...panelProps} />;
      case 'alarms':
        return <AlarmPanel {...panelProps} />;
      case 'assessment':
        return <AssessmentPanel {...panelProps} />;
    }
  }, [topic, view, openDetail]);
  return (
    <SourceStampProvider key={requestedPeriod.key}>
      <ResourceProvider period={requestedPeriod}>
        <main className="monthly-operations" aria-label="智舱月览">
          <div className="mo-content">
            <header className="mo-hero">
              <div className="mo-hero-title">
                <div className="mo-hero-icon">
                  <Compass aria-hidden="true" />
                </div>
                <div>
                  <h1>智舱月览</h1>
                  <p>MONTHLY OPERATIONS</p>
                </div>
                <span className="mo-hero-divider" />
                <span className="mo-hero-tagline">读懂趋势 · 把握全局</span>
              </div>
              <div className="mo-hero-month">
                <span>
                  {period.mode === 'range'
                    ? 'CUSTOM RANGE'
                    : requestedPeriod.start.slice(0, 4)}
                </span>
                <strong>
                  {period.mode === 'month' ? (
                    <>
                      {period.month.slice(5)}
                      <small>月</small>
                    </>
                  ) : period.mode === 'year' ? (
                    '全年'
                  ) : (
                    period.mode === 'last30' ? '过去30天' : '自定义'
                  )}
                </strong>
                <ChartNoAxesCombined aria-hidden="true" />
              </div>
            </header>
            <div className="mo-toolbar">
              <div className="mo-scope">
                <Building2 aria-hidden="true" />
                <span>南通基地</span>
                <span className="mo-toolbar-divider">/</span>
                <span>运营指挥</span>
                <SourceStamp topic={topic} />
              </div>
              <div className="mo-filters">
                <PeriodControl value={period} onChange={changePeriod} />
                <Select
                  value={building}
                  onValueChange={(value) => {
                    setSelection(null);
                    setBuilding(value as BuildingFilter);
                  }}
                >
                  <SelectTrigger
                    className="mo-building-filter"
                    aria-label="选择楼栋"
                  >
                    <Building2 />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部楼栋</SelectItem>
                    {BUILDINGS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Tabs
              value={topic}
              onValueChange={(value) => setTopic(value as Topic)}
              className="mo-topics"
            >
              <div className="mo-topic-bar">
                <TabsList aria-label="月览专题" className="mo-topic-tabs">
                  {TOPICS.map(({ key, label, icon: Icon }) => (
                    <TabsTrigger key={key} value={key}>
                      <Icon aria-hidden="true" />
                      <span>
                        {key === 'overview'
                          ? `${requestedPeriod.noun}总览`
                          : label}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
                <span className="mo-topic-count">
                  {String(
                    TOPICS.findIndex((item) => item.key === topic) + 1,
                  ).padStart(2, '0')}{' '}
                  / {String(TOPICS.length).padStart(2, '0')}
                </span>
              </div>
              <TabsContent value={topic}>{panelContent}</TabsContent>
            </Tabs>
            <footer className="mo-footer">
              <span>
                <span className="mo-dot" />
                智舱月览 · 南通基地
              </span>
            </footer>
            <span className="sr-only" role="status">
              当前范围：{requestedPeriod.rangeLabel}，
              {building === 'all' ? '全部楼栋' : building}
            </span>
          </div>
          {selection &&
          !selection.demo &&
          (selection.resource === 'capacity' ||
            selection.resource === 'energy' ||
            selection.resource === 'load' ||
            selection.resource === 'water') ? (
            <ResourceDetailSheet
              key={`${view.period.key}-${building}-${JSON.stringify(selection)}`}
              selection={selection}
              building={building}
              period={requestedPeriod}
              onClose={() => setSelection(null)}
              restoreFocus={() => detailTrigger.current?.focus()}
            />
          ) : (
            selection && (
              <DetailSheet
                key={`${view.period.key}-${building}-${JSON.stringify(selection)}`}
                selection={selection}
                view={view}
                onClose={() => setSelection(null)}
                restoreFocus={() => detailTrigger.current?.focus()}
              />
            )
          )}
        </main>
      </ResourceProvider>
    </SourceStampProvider>
  );
}
