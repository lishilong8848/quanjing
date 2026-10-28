import { accessBuildings } from '@shared/building-access';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  ExternalLink,
  LayoutGrid,
  Search,
  ShieldAlert,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { canAccessPage } from '@/access/access-policy';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { businessBuildingsForAction } from '@shared/business-permissions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  TOOL_BUILDINGS,
  TOOL_FLOW_KINDS,
  TOOL_SOURCE_LABELS,
  type ToolFlowKind,
  type ToolSourceKey,
  type OperationsToolsSnapshot,
} from '@shared/operations-tools.interface';
import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import { getToolsSnapshot } from './api';
import {
  chinaToday,
  deriveTools,
  flowToolName,
  type ToolMetric,
} from './model';
import { ToolList } from './ToolList';
import { FlowList } from './FlowList';
import './styles.css';

type Section = 'overview' | ToolSourceKey;
type Selection =
  | { type: 'metric'; key: ToolMetric }
  | { type: 'building'; building: string; quality: boolean }
  | { type: 'problem'; check: string }
  | { type: 'tool'; id: string }
  | { type: 'flow'; id: string }
  | { type: 'repair' }
  | { type: 'apply' }
  | { type: 'guide' };
const SECTIONS = [
  ['overview', '总览', '工具态势', LayoutGrid],
  ['ledger', '工具台账', '台账明细', ClipboardList],
  ['quality', '不合格工具', '待处理', ShieldAlert],
  ['maintenance', '维护管理', '维护记录', Wrench],
  ['repair', '检修管理', '检修记录', Wrench],
  ['scrap', '报废管理', '报废记录', Trash2],
  ['borrow', '借用管理', '借用归还', ArrowLeftRight],
  ['inspection', '送检管理', '送检记录', ClipboardCheck],
] as const;
const METRICS: {
  key: ToolMetric;
  label: string;
  note: string;
  dependencies: ToolSourceKey[];
}[] = [
  {
    key: 'total',
    label: '工具台账',
    note: '台账条目 · 非实物件数',
    dependencies: ['ledger'],
  },
  {
    key: 'quality',
    label: '不合格工具',
    note: '当前未完成处置',
    dependencies: ['ledger', 'quality'],
  },
  {
    key: 'borrow',
    label: '借用未归还',
    note: '已出库工具条目',
    dependencies: ['ledger', 'borrow'],
  },
  {
    key: 'inspection',
    label: '送检临期 / 逾期',
    note: '已配置日期 · 不足 30 天',
    dependencies: ['ledger'],
  },
  {
    key: 'maintenance',
    label: '维护临期 / 逾期',
    note: '已配置日期 · 不足 30 天',
    dependencies: ['ledger'],
  },
];
const EMPTY: Pick<OperationsToolsSnapshot, 'tools' | 'flows'> = {
  tools: [],
  flows: [],
};
const readable = (state?: string) => state === 'ready' || state === 'stale';
// Bind the theme to both roots: the dialog is portalled outside the page.
const TOOLS_THEME = {
  '--tools-bg': 'hsl(218 38% 97%)',
  '--tools-surface': 'hsl(220 40% 99%)',
  '--tools-border': 'hsl(217 66% 91%)',
  '--tools-text': 'hsl(222 47% 16%)',
  '--tools-muted': 'hsl(218 15% 43%)',
  '--tools-blue': 'hsl(219 73% 53%)',
  '--tools-blue-soft': 'hsl(219 80% 96%)',
  '--tools-red': 'hsl(350 55% 44%)',
  '--tools-risk': 'hsl(350 64% 74%)',
  '--tools-radius': '0.5rem',
  color: 'var(--tools-text)',
  fontFamily: 'Inter, Arial, sans-serif',
  fontSize: '0.875rem',
} as CSSProperties;

export default function OperationsToolsManagementPage() {
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const access = useAccess(),
    queryClient = useQueryClient();
  const identity = `${access.principalFingerprint ?? 'none'}:${access.role}:${access.purchaseBuilding ?? ''}`;
  const queryKey = useMemo(() => ['operations-tools', identity], [identity]);
  const enabled =
    !access.isLoading &&
    canAccessPage(access.role, '/operations-tools-management', access.pagePaths);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getToolsSnapshot(false, signal),
    enabled,
    staleTime: 15000,
    gcTime: 60000,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => (q.state.data?.refreshing ? 2000 : 15000),
  });
  const snapshot = query.data;
  const [section, setSection] = useState<Section>('overview'),
    [building, setBuilding] = useState(''),
    [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null),
    [refreshError, setRefreshError] = useState(''),
    [manualRefresh, setManualRefresh] = useState(false);
  const [today, setToday] = useState(chinaToday);
  const externalOpened = useRef(false),
    lastRefresh = useRef(0),
    refreshInFlight = useRef(false);
  const scope = access.effectiveAuthorization ? businessBuildingsForAction(access, { module: 'tools', action: 'read' }) : accessBuildings(access);
  const locked = Boolean(scope && scope.length === 1);
  const effectiveBuilding = locked ? (access.purchaseBuilding ?? '') : building;
  const model = useMemo(
    () => deriveTools(snapshot ?? EMPTY, effectiveBuilding, search, today),
    [snapshot, effectiveBuilding, search, today],
  );
  const overviewTools = useMemo(() => model.concerns.slice(0, 5), [model]);
  const repairFlows = useMemo(
    () =>
      model.flows.filter((f) => f.kind === 'repair' && f.status === '检修中'),
    [model],
  );
  const sectionFlows = useMemo(
    () => model.flows.filter((f) => f.kind === section),
    [model, section],
  );
  const selectTool = useCallback(
    (id: string) => setSelection({ type: 'tool', id }),
    [],
  );
  const selectFlow = useCallback(
    (id: string) => setSelection({ type: 'flow', id }),
    [],
  );
  const refresh = useCallback(async () => {
    if (refreshInFlight.current || Date.now() - lastRefresh.current < 5000)
      return;
    refreshInFlight.current = true;
    lastRefresh.current = Date.now();
    setManualRefresh(true);
    setRefreshError('');
    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.fetchQuery({
        queryKey,
        queryFn: ({ signal }) => getToolsSnapshot(canUsePageAction(access, 'tools', 'refresh', access.capabilities.canForceRefresh), signal),
        staleTime: 0,
      });
    } catch {
      setRefreshError('同步请求失败，已保留当前数据，请重试');
    } finally {
      refreshInFlight.current = false;
      setManualRefresh(false);
    }
  }, [access, queryClient, queryKey]);
  useEffect(() => {
    setSelection(null);
    setBuilding('');
    setSearch('');
    return () => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.removeQueries({ queryKey, exact: true });
    };
  }, [identity, queryClient, queryKey]);
  useEffect(() => {
    const onReturn = () => {
      setToday(chinaToday());
      if (externalOpened.current && document.visibilityState === 'visible') {
        externalOpened.current = false;
        void refresh();
      }
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    const timer = window.setInterval(() => setToday(chinaToday()), 60000);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      window.clearInterval(timer);
    };
  }, [refresh]);
  const nativeLink = useCallback(
    (url: string, text: string) => (
      <Button asChild variant="outline" size="sm">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => {
            externalOpened.current = true;
          }}
        >
          {text}
          <ExternalLink className="size-3.5" />
        </a>
      </Button>
    ),
    [],
  );
  const available = useCallback(
    (keys: ToolSourceKey[]) =>
      keys.every((key) => readable(snapshot?.sources[key]?.state)),
    [snapshot],
  );
  const updated = snapshot
    ? Object.values(snapshot.sources)
        .map((s) => s.updatedAt)
        .filter((v): v is string => Boolean(v))
        .sort()[0]
    : null;
  const sourceFailures = useMemo(
    () =>
      snapshot
        ? Object.entries(snapshot.sources).filter(
            ([, s]) => s.state === 'error' || s.state === 'stale',
          )
        : [],
    [snapshot],
  );
  const source =
    section !== 'overview' ? snapshot?.sources[section] : undefined;
  const selectedTool =
    selection?.type === 'tool'
      ? model.tools.find((t) => t.id === selection.id)
      : undefined;
  const selectedFlow =
    selection?.type === 'flow'
      ? model.flows.find((f) => f.id === selection.id)
      : undefined;
  const drillTools =
    selection?.type === 'metric'
      ? model.groups[selection.key]
      : selection?.type === 'building'
        ? (model.buildings.find((b) => b.building === selection.building)?.[
            selection.quality ? 'quality' : 'tools'
          ] ?? [])
        : selection?.type === 'problem'
          ? (model.problems.find((p) => p.check === selection.check)?.tools ??
            [])
          : [];
  const dialogTitle =
    selection?.type === 'tool'
      ? (selectedTool?.name ?? '工具已不在当前筛选中')
      : selection?.type === 'flow'
        ? selectedFlow
          ? flowToolName(selectedFlow, snapshot?.tools ?? [])
          : '记录已不在当前筛选中'
        : selection?.type === 'apply'
          ? '新建申请'
          : selection?.type === 'guide'
            ? '流程说明'
            : selection?.type === 'repair'
              ? '检修中记录'
              : selection?.type === 'metric'
                ? METRICS.find((m) => m.key === selection.key)?.label
                : selection?.type === 'building'
                  ? `${selection.building} · ${selection.quality ? '不合格工具' : '工具台账'}`
                  : selection?.type === 'problem'
                    ? model.problems.find((p) => p.check === selection.check)
                        ?.label
                    : '';
  const DialogIcon =
    selection?.type === 'metric'
      ? {
          total: ClipboardList,
          quality: ShieldAlert,
          borrow: ArrowLeftRight,
          inspection: ClipboardCheck,
          maintenance: Wrench,
        }[selection.key]
      : selection?.type === 'repair' || selection?.type === 'flow'
        ? Wrench
        : ClipboardList;
  const dialogSummaries: {
    label: string;
    value: number | string;
    risk?: boolean;
    selection: Selection;
  }[] =
    selection?.type === 'building'
      ? [
          {
            label: '台账条目',
            value: available(['ledger'])
              ? (model.buildings.find((b) => b.building === selection.building)
                  ?.tools.length ?? 0)
              : '—',
            selection: { ...selection, quality: false },
          },
          {
            label: '不合格工具',
            value: available(['ledger', 'quality'])
              ? (model.buildings.find((b) => b.building === selection.building)
                  ?.quality.length ?? 0)
              : '—',
            risk: true,
            selection: { ...selection, quality: true },
          },
        ]
      : selection?.type === 'metric' && selection.key === 'total'
        ? METRICS.slice(0, 4).map((metric) => ({
            label: metric.label,
            value: available(metric.dependencies)
              ? model.groups[metric.key].length
              : '—',
            risk: metric.key === 'quality',
            selection: { type: 'metric', key: metric.key },
          }))
        : [];

  const pageContent = useMemo(
    () => (
      <main className="tools-content">
        <nav className="tools-nav" aria-label="运维工具管理视图">
          {SECTIONS.map(([key, label, description, Icon]) => (
            <button
              key={key}
              type="button"
              aria-current={section === key ? 'page' : undefined}
              onClick={() => setSection(key)}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="tools-filters">
          <label>
            楼栋
            <NativeSelect
              aria-label="筛选楼栋"
              value={effectiveBuilding}
              disabled={locked}
              onChange={(e) => setBuilding(e.target.value)}
            >
              <NativeSelectOption value="">全部楼栋</NativeSelectOption>
              {[
                ...TOOL_BUILDINGS.filter(value => !scope || scope.includes(value)),
                ...(locked &&
                effectiveBuilding &&
                !(TOOL_BUILDINGS as readonly string[]).includes(
                  effectiveBuilding,
                )
                  ? [effectiveBuilding]
                  : []),
              ].map((b) => (
                <NativeSelectOption key={b} value={b}>
                  {b}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="tools-search">
            <Search aria-hidden="true" />
            <Input
              aria-label="搜索工具、型号、位置"
              placeholder="搜索工具、型号、位置"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              if (!locked) setBuilding('');
            }}
          >
            重置
          </Button>
          <span className="tools-scope">
            {effectiveBuilding || '全园区'} · {today}
          </span>
        </div>
        <div role="status" aria-live="polite" className="tools-sync-state">
          {query.isPending && '正在加载工具数据…'}
          {(manualRefresh || snapshot?.refreshing) &&
            '正在后台同步，已有数据可继续查看'}
          {(query.isError || refreshError) && (
            <span className="tools-error">
              {refreshError || '读取失败，请重试；已有数据已保留'}{' '}
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                重试
              </Button>
            </span>
          )}
        </div>
        {sourceFailures.length > 0 && (
          <details className="tools-source-warning">
            <summary>
              {sourceFailures.length} 张表同步失败，正在显示最近一次成功数据
            </summary>
            <ul>
              {sourceFailures.map(([key, s]) => (
                <li key={key}>
                  {TOOL_SOURCE_LABELS[key as ToolSourceKey]}：{s.message}
                </li>
              ))}
            </ul>
          </details>
        )}
        {snapshot && (
          <>
            {section === 'overview' && (
              <>
                <section className="tools-metrics" aria-label="工具统计">
                  {METRICS.slice(0, 4).map((m) => {
                    const Icon =
                      m.key === 'total'
                        ? ClipboardList
                        : m.key === 'quality'
                          ? ShieldAlert
                          : m.key === 'borrow'
                            ? ArrowLeftRight
                            : ClipboardCheck;
                    return (
                      <button
                        className={`tools-metric tools-metric-${m.key}`}
                        key={m.key}
                        type="button"
                        disabled={!available(m.dependencies)}
                        onClick={() =>
                          setSelection({ type: 'metric', key: m.key })
                        }
                      >
                        <span className="tools-metric-icon">
                          <Icon aria-hidden="true" />
                        </span>
                        <span className="tools-metric-body">
                          <span>{m.label}</span>
                          <strong>
                            {available(m.dependencies)
                              ? model.groups[m.key].length
                              : '—'}
                            <small>条</small>
                          </strong>
                          <span className="tools-metric-note">{m.note}</span>
                          <span className="tools-metric-link">查看详情</span>
                        </span>
                      </button>
                    );
                  })}
                </section>
                <section
                  className="tools-building-section"
                  aria-label="各楼工具台账"
                >
                  <h2>
                    <ClipboardList aria-hidden="true" />
                    各楼工具台账
                  </h2>
                  <div className="tools-building-grid">
                    {model.buildings.map((item) => (
                      <button
                        key={item.building}
                        type="button"
                        className="tools-building-card"
                        disabled={!available(['ledger'])}
                        onClick={() =>
                          setSelection({
                            type: 'building',
                            building: item.building,
                            quality: false,
                          })
                        }
                      >
                        <span className="tools-building-top">
                          <strong>{item.building}</strong>
                          {item.quality.length > 0 ? (
                            <span className="tools-building-risk">
                              {item.quality.length} 不合格
                            </span>
                          ) : (
                            <CheckCircle2 aria-label="无不合格工具" />
                          )}
                        </span>
                        <span className="tools-building-count">
                          <span>
                            台账条目
                            <strong>
                              {available(['ledger']) ? item.tools.length : '—'}
                            </strong>
                          </span>
                          <span>
                            待处理
                            <strong>
                              {available(['quality'])
                                ? item.quality.length
                                : '—'}
                            </strong>
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
                <div className="tools-panels">
                  <Card data-slot="card">
                    <CardHeader data-slot="card-header">
                      <CardTitle data-slot="card-title">各楼工具分布</CardTitle>
                      <div className="tools-legend">
                        <span>台账条目</span>
                        <span>其中不合格</span>
                      </div>
                    </CardHeader>
                    <CardContent
                      data-slot="card-content"
                      className="tools-chart"
                    >
                      {available(['ledger']) ? (
                        model.buildings.map((b, i) => (
                          <div className="tools-chart-row" key={b.building}>
                            <strong>{b.building}</strong>
                            <button
                              className="tools-bar-button"
                              aria-label={`${b.building}工具台账${b.tools.length}条`}
                              onClick={() =>
                                setSelection({
                                  type: 'building',
                                  building: b.building,
                                  quality: false,
                                })
                              }
                            >
                              <span
                                className={`tools-bar ${i === 0 ? 'tools-bar-peak' : ''}`}
                                style={{
                                  width: `${(b.tools.length / Math.max(1, model.buildings[0]?.tools.length ?? 0)) * 100}%`,
                                }}
                              >
                                {available(['quality']) && (
                                  <span
                                    className="tools-bar-risk"
                                    style={{
                                      width: `${(b.quality.length / Math.max(1, b.tools.length)) * 100}%`,
                                    }}
                                  />
                                )}
                              </span>
                            </button>
                            <span className="tools-number">
                              {b.tools.length}
                              {i === 0 && b.tools.length > 0 && (
                                <small>最高</small>
                              )}
                            </span>
                            <button
                              disabled={!available(['quality'])}
                              className="tools-risk-link"
                              onClick={() =>
                                setSelection({
                                  type: 'building',
                                  building: b.building,
                                  quality: true,
                                })
                              }
                            >
                              不合格{' '}
                              {available(['quality']) ? b.quality.length : '—'}
                            </button>
                          </div>
                        ))
                      ) : (
                        <p className="tools-empty">台账暂不可用</p>
                      )}
                    </CardContent>
                  </Card>
                  <Card data-slot="card">
                    <CardHeader data-slot="card-header">
                      <CardTitle data-slot="card-title">当前待处理</CardTitle>
                    </CardHeader>
                    <CardContent
                      data-slot="card-content"
                      className="tools-tasks"
                    >
                      {METRICS.filter((m) => m.key !== 'total').map((m) => (
                        <button
                          key={m.key}
                          disabled={!available(m.dependencies)}
                          onClick={() =>
                            setSelection({ type: 'metric', key: m.key })
                          }
                        >
                          <span>
                            {m.label}
                            <small>
                              {m.key === 'quality' ? '登记与检查结论' : m.note}
                            </small>
                          </span>
                          <Badge variant="outline">
                            {available(m.dependencies)
                              ? model.groups[m.key].length
                              : '—'}{' '}
                            条
                          </Badge>
                          <span className="tools-link">查看</span>
                        </button>
                      ))}
                      <div className="tools-data-note">
                        {model.tools.filter((t) => t.issues.length > 0).length}{' '}
                        条台账信息待完善
                      </div>
                    </CardContent>
                  </Card>
                </div>
                <Card data-slot="card">
                  <CardHeader data-slot="card-header">
                    <CardTitle data-slot="card-title">需关注的工具</CardTitle>
                    <Button
                      variant="ghost"
                      onClick={() => setSection('ledger')}
                    >
                      全部台账
                    </Button>
                  </CardHeader>
                  <CardContent data-slot="card-content">
                    <ToolList
                      tools={overviewTools}
                      today={today}
                      onSelect={selectTool}
                    />
                  </CardContent>
                </Card>
              </>
            )}
            {section === 'quality' && (
              <div className="tools-panels">
                <Card data-slot="card">
                  <CardHeader data-slot="card-header">
                    <CardTitle data-slot="card-title">不合格问题分布</CardTitle>
                    <span className="tools-muted">同一工具可能有多项问题</span>
                  </CardHeader>
                  <CardContent
                    data-slot="card-content"
                    className="tools-chart tools-problems"
                  >
                    {available(['ledger', 'quality']) ? (
                      model.problems.map((p, i) => (
                        <div className="tools-chart-row" key={p.check}>
                          <strong>{p.label}</strong>
                          <button
                            className="tools-bar-button"
                            aria-label={`${p.label}${p.tools.length}条`}
                            onClick={() =>
                              setSelection({ type: 'problem', check: p.check })
                            }
                          >
                            <span
                              className={`tools-bar ${i === 0 ? 'tools-bar-peak' : ''}`}
                              style={{
                                width: `${(p.tools.length / Math.max(1, model.problems[0]?.tools.length ?? 0)) * 100}%`,
                              }}
                            />
                          </button>
                          <span className="tools-number">
                            {p.tools.length}
                            {i === 0 && p.tools.length > 0 && (
                              <small>最高</small>
                            )}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p>不合格数据暂不可用</p>
                    )}
                  </CardContent>
                </Card>
                <Card data-slot="card">
                  <CardHeader data-slot="card-header">
                    <CardTitle data-slot="card-title">待处置工具</CardTitle>
                  </CardHeader>
                  <CardContent data-slot="card-content">
                    <p className="tools-large-number">
                      {available(['ledger', 'quality'])
                        ? model.groups.quality.length
                        : '—'}{' '}
                      <small>条</small>
                    </p>
                    <p className="tools-muted">
                      当前未闭环的关联工具及底表不合格记录
                    </p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setSelection({ type: 'metric', key: 'quality' })
                      }
                      disabled={!available(['ledger', 'quality'])}
                    >
                      查看工具
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
            {section !== 'overview' && (
              <Card data-slot="card">
                <CardHeader data-slot="card-header">
                  <CardTitle data-slot="card-title">
                    {TOOL_SOURCE_LABELS[section]}
                  </CardTitle>
                  {source &&
                    nativeLink(
                      source.formUrl ?? source.sourceUrl,
                      source.formUrl
                        ? '填写申请'
                        : section === 'ledger'
                          ? '维护台账'
                          : '查看原表',
                    )}
                </CardHeader>
                <CardContent data-slot="card-content">
                  {!readable(source?.state) ? (
                    <p className="tools-empty">
                      {source?.state === 'loading'
                        ? '正在同步数据'
                        : '该表数据暂不可用，请重试'}
                    </p>
                  ) : section === 'ledger' ? (
                    <ToolList
                      tools={model.concerns}
                      today={today}
                      onSelect={selectTool}
                    />
                  ) : (
                    <FlowList
                      flows={sectionFlows}
                      tools={snapshot.tools}
                      onSelect={selectFlow}
                    />
                  )}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>
    ),
    [
      section,
      model,
      effectiveBuilding,
      locked,
      search,
      today,
      manualRefresh,
      snapshot,
      query.isPending,
      query.isError,
      refreshError,
      refresh,
      sourceFailures,
      available,
      repairFlows,
      overviewTools,
      selectTool,
      selectFlow,
      source,
      nativeLink,
      sectionFlows,
    ],
  );

  return (
    <div className="tools-page" style={TOOLS_THEME}>
      <ManagementHeader
        activePage="operations-tools"
        subtitle="运维工具管理"
        sourceLabel="工具台账与流转记录"
        updatedAt={
          updated
            ? new Date(updated).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              })
            : '尚未同步'
        }
        refreshing={manualRefresh || Boolean(snapshot?.refreshing)}
        onRefresh={() => void refresh()}
        showSearch={false}
        actions={
          <>
            <Button
              variant="outline"
              className="tools-header-button"
              onClick={() => setSelection({ type: 'guide' })}
            >
              流程说明
            </Button>
            <Button
              className="tools-apply-button"
              disabled={!snapshot}
              onClick={() => setSelection({ type: 'apply' })}
            >
              ＋ 新建申请
            </Button>
          </>
        }
      />
      {pageContent}
      <Dialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        <DialogContent
          className="tools-dialog max-w-none gap-0 p-0"
          style={TOOLS_THEME}
          showCloseButton={false}
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            if (
              active instanceof HTMLElement &&
              !active.closest('.tools-dialog')
            ) {
              dialogTrigger.current = active;
            }
          }}
          onCloseAutoFocus={(event) => {
            if (dialogTrigger.current?.isConnected) {
              event.preventDefault();
              dialogTrigger.current.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader className="tools-dialog-header flex-row text-left">
            <span className="tools-dialog-icon">
              <DialogIcon aria-hidden="true" />
            </span>
            <div>
              <DialogTitle>{dialogTitle}</DialogTitle>
              <DialogDescription className="sr-only">
                运维工具管理明细与操作
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon"
                className="tools-dialog-close"
                aria-label="关闭弹窗"
              >
                <X />
              </Button>
            </DialogClose>
          </DialogHeader>
          <div className="tools-dialog-body">
            {selection?.type !== 'guide' &&
              selection?.type !== 'apply' &&
              (query.isError || sourceFailures.length > 0) && (
                <p role="status" className="tools-source-warning">
                  部分数据尚未更新，当前显示最近一次成功数据。
                </p>
              )}
            {(selection?.type === 'metric' ||
              selection?.type === 'building' ||
              selection?.type === 'problem') && (
              <>
                {dialogSummaries.length > 0 && (
                  <div className="tools-dialog-summaries">
                    {dialogSummaries.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="tools-dialog-summary"
                        onClick={() => setSelection(item.selection)}
                      >
                        <span>{item.label}</span>
                        <strong
                          className={item.risk ? 'tools-error' : undefined}
                        >
                          {item.value}
                        </strong>
                      </button>
                    ))}
                  </div>
                )}
                <section className="tools-dialog-list" aria-label="工具明细">
                  <header>
                    <h3>
                      <ClipboardList aria-hidden="true" />
                      工具明细
                    </h3>
                    <Badge variant="outline">{drillTools.length} 条</Badge>
                  </header>
                  <ToolList
                    tools={drillTools}
                    pageSize={12}
                    today={today}
                    onSelect={selectTool}
                  />
                </section>
              </>
            )}
            {selection?.type === 'repair' && (
              <section className="tools-dialog-list" aria-label="检修记录">
                <header>
                  <h3>
                    <Wrench aria-hidden="true" />
                    检修记录
                  </h3>
                  <Badge variant="outline">{repairFlows.length} 单</Badge>
                </header>
                <div className="tools-dialog-flow-list">
                  <FlowList
                    flows={repairFlows}
                    tools={snapshot?.tools ?? []}
                    onSelect={selectFlow}
                  />
                </div>
              </section>
            )}
            {selectedTool && (
              <>
                <dl className="tools-detail">
                  {[
                    ['楼栋', selectedTool.building],
                    ['放置区域', selectedTool.place],
                    ['规格型号', selectedTool.model],
                    ['类别号', selectedTool.code],
                    [
                      '数量',
                      selectedTool.quantity === null
                        ? '未维护'
                        : `${selectedTool.quantity} ${selectedTool.unit}`,
                    ],
                    ['检查结论', selectedTool.conclusion],
                    ['维护日期', selectedTool.maintenanceDate],
                    ['维护周期', selectedTool.maintenanceCycle],
                    ['维护到期', selectedTool.maintenanceDue],
                    ['送检日期', selectedTool.inspectionDate],
                    ['送检周期', selectedTool.inspectionCycle],
                    ['送检到期', selectedTool.inspectionDue],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value || '未维护'}</dd>
                    </div>
                  ))}
                </dl>
                {selectedTool.issues.length > 0 && (
                  <p className="tools-source-warning">
                    {selectedTool.issues.join('；')}
                  </p>
                )}
                {snapshot &&
                  nativeLink(snapshot.sources.ledger.sourceUrl, '在飞书中维护')}
              </>
            )}
            {selectedFlow && (
              <>
                <dl className="tools-detail">
                  {[
                    ['编号', selectedFlow.code || selectedFlow.id],
                    ['楼栋', selectedFlow.building],
                    ['当前阶段', selectedFlow.status],
                    ['计划 / 申请日期', selectedFlow.date],
                    ['实际日期', selectedFlow.actualDate],
                    ['数量', selectedFlow.quantity?.toString()],
                    ['原因 / 处理方式', selectedFlow.reason],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value || '未填写'}</dd>
                    </div>
                  ))}
                </dl>
                {selectedFlow.attachments.length > 0 && (
                  <p>附件：{selectedFlow.attachments.join('、')}</p>
                )}
                {snapshot &&
                  nativeLink(
                    snapshot.sources[selectedFlow.kind].sourceUrl,
                    '查看与处理原记录',
                  )}
              </>
            )}
            {selection?.type === 'apply' && snapshot && (
              <div className="tools-application-list">
                {TOOL_FLOW_KINDS.filter((k) => snapshot.sources[k].formUrl).map(
                  (k) => (
                    <div key={k}>
                      <strong>{TOOL_SOURCE_LABELS[k]}</strong>
                      {nativeLink(snapshot.sources[k].formUrl!, '打开申请表')}
                    </div>
                  ),
                )}
                <p className="tools-muted">
                  申请在飞书中填写及审批。返回后自动同步结果。检修由不合格登记转入。
                </p>
              </div>
            )}
            {selection?.type === 'guide' && (
              <div className="tools-guide">
                <p>借用：申请 → 主管审批 → 仓管出库 → 归还确认</p>
                <p>维护：申请审批 → 维护检查 → 完成或登记不合格</p>
                <p>送检：申请审批 → 报告填写 → 完成</p>
                <p>不合格：登记 → 转检修 / 转报废 → 处置反馈</p>
                <p>报废：主管审批 → 经理审批 → 通过或终止</p>
                <p>
                  缺失数量不会按零统计；不同单位不合并求和。送检条件未明确的工具需在原表核实。
                </p>
              </div>
            )}
          </div>
          <footer className="tools-dialog-footer">
            <DialogClose asChild>
              <Button variant="outline">关闭</Button>
            </DialogClose>
          </footer>
        </DialogContent>
      </Dialog>
    </div>
  );
}
