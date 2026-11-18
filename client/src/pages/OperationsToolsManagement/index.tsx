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
  TOOL_SOURCE_LABELS,
  type OperationsToolsSnapshot,
} from '@shared/operations-tools.interface';
import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import { getToolsSnapshot } from './api';
import {
  chinaToday,
  deriveTools,
  flowToolName,
  deriveToolsMonth,
} from './model';
import { ToolList } from './ToolList';
import { FlowList } from './FlowList';
import './styles.css';

type Section = 'overview' | 'ledger';
type Metric = 'total' | 'maintenance' | 'inspection';
type Selection =
  | { type: 'metric'; key: Metric }
  | { type: 'tool' | 'flow'; id: string };

const SECTIONS = [
  ['overview', '总览', '工具态势', LayoutGrid],
  ['ledger', '工具台账', '台账明细', ClipboardList],
  ['quality', '不合格工具', '暂不可用', ShieldAlert],
  ['maintenance', '维护管理', '暂不可用', Wrench],
  ['repair', '检修管理', '暂不可用', Wrench],
  ['scrap', '报废管理', '暂不可用', Trash2],
  ['borrow', '借用管理', '暂不可用', ArrowLeftRight],
  ['inspection', '送检管理', '暂不可用', ClipboardCheck],
] as const;

const METRICS = [
  {
    key: 'total',
    label: '涉及工具',
    note: '办理或到期的台账条目',
    icon: ClipboardList,
  },
  {
    key: 'maintenance',
    label: '维护到期',
    note: '按维护到期日统计',
    icon: Wrench,
  },
  {
    key: 'inspection',
    label: '送检到期',
    note: '按送检到期日统计',
    icon: ClipboardCheck,
  },
] as const;
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
    canAccessPage(
      access.role,
      '/operations-tools-management',
      access.pagePaths,
    );
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
  const [selectedMonth, setSelectedMonth] = useState('');
  const month = selectedMonth || today.slice(0, 7);
  const scope = access.effectiveAuthorization
    ? businessBuildingsForAction(access, { module: 'tools', action: 'read' })
    : accessBuildings(access);
  const locked = scope?.length === 1;
  const effectiveBuilding = locked ? scope[0] : building;
  const ledgerTools = useMemo(
    () =>
      section === 'ledger'
        ? deriveTools(snapshot ?? EMPTY, effectiveBuilding, search, today)
            .concerns
        : [],
    [snapshot, effectiveBuilding, search, today, section],
  );
  const overview = useMemo(
    () =>
      section === 'overview'
        ? deriveToolsMonth(
            snapshot ?? EMPTY,
            effectiveBuilding,
            search,
            today,
            month,
          )
        : null,
    [snapshot, effectiveBuilding, search, today, section, month],
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
        queryFn: ({ signal }) =>
          getToolsSnapshot(
            canUsePageAction(
              access,
              'tools',
              'refresh',
              access.capabilities.canForceRefresh,
            ),
            signal,
          ),
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
    setSelectedMonth('');
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
  const ledger = snapshot?.sources.ledger;
  const records = snapshot?.sources.maintenance;
  const updated = [ledger?.updatedAt, records?.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const sourceFailures = (['ledger', 'maintenance'] as const).flatMap((key) => {
    const source = snapshot?.sources[key];
    return source?.state === 'error' || source?.state === 'stale'
      ? [{ key, source }]
      : [];
  });
  const selectedTool =
    selection?.type === 'tool'
      ? snapshot?.tools.find((tool) => tool.id === selection.id)
      : undefined;
  const selectedFlow =
    selection?.type === 'flow'
      ? overview?.flows.find((flow) => flow.id === selection.id)
      : undefined;
  const selectedMetric =
    selection?.type === 'metric'
      ? METRICS.find((item) => item.key === selection.key)
      : undefined;
  const dialogTitle =
    selectedTool?.name ||
    (selectedFlow
      ? flowToolName(selectedFlow, snapshot?.tools ?? [])
      : selectedMetric?.label) ||
    '记录已不在当前筛选中';
  const DialogIcon =
    selectedMetric?.icon ?? (selectedFlow ? Wrench : ClipboardList);
  const filterKey = JSON.stringify([effectiveBuilding, search.trim()]);
  const unavailable = (state?: string) => (
    <p className="tools-empty">
      {state === 'loading' ? '正在同步数据' : '该表数据暂不可用，请重试'}
    </p>
  );

  return (
    <div className="tools-page" style={TOOLS_THEME}>
      <ManagementHeader
        activePage="operations-tools"
        subtitle="运维工具管理"
        sourceLabel="工具底表与送检维护记录"
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
            <Button variant="outline" className="tools-header-button" disabled>
              流程说明
            </Button>
            <Button className="tools-apply-button" disabled>
              ＋ 新建申请
            </Button>
          </>
        }
      />
      <main className="tools-content">
        <nav className="tools-nav" aria-label="运维工具管理视图">
          {SECTIONS.map(([key, label, description, Icon]) => {
            const active = key === 'overview' || key === 'ledger';
            return (
              <button
                key={key}
                type="button"
                disabled={!active}
                aria-current={section === key ? 'page' : undefined}
                onClick={active ? () => setSection(key) : undefined}
              >
                <Icon aria-hidden="true" />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="tools-filters">
          {section === 'overview' && (
            <label className="tools-month">
              月份
              <Input
                type="month"
                aria-label="总览月份"
                value={month}
                onChange={(event) => setSelectedMonth(event.target.value)}
              />
            </label>
          )}
          <label>
            楼栋
            <NativeSelect
              aria-label="筛选楼栋"
              value={effectiveBuilding}
              disabled={locked}
              onChange={(event) => setBuilding(event.target.value)}
            >
              <NativeSelectOption value="">全部楼栋</NativeSelectOption>
              {(locked
                ? scope
                : TOOL_BUILDINGS.filter(
                    (value) => !scope || scope.includes(value),
                  )
              ).map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {value}
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
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              if (!locked) setBuilding('');
              if (section === 'overview') setSelectedMonth('');
            }}
          >
            重置
          </Button>
        </div>
        <div role="status" aria-live="polite" className="tools-sync-state">
          {query.isPending && '正在加载工具数据…'}
          {(manualRefresh || snapshot?.refreshing) &&
            '正在后台同步，已有数据可继续查看'}
          {(query.isError || refreshError) && (
            <span className="tools-error">
              {refreshError || '读取失败，请重试'}{' '}
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                重试
              </Button>
            </span>
          )}
        </div>
        {sourceFailures.length > 0 && (
          <details className="tools-source-warning">
            <summary>部分数据尚未更新</summary>
            <ul>
              {sourceFailures.map(({ key, source }) => (
                <li key={key}>
                  {TOOL_SOURCE_LABELS[key]}：{source.message}
                </li>
              ))}
            </ul>
          </details>
        )}
        {snapshot && overview && (
          <>
            <section className="tools-metrics" aria-label="当月工具统计">
              {METRICS.map(({ key, label, note, icon: Icon }) => {
                const ready =
                  readable(ledger?.state) &&
                  (key !== 'total' || readable(records?.state));
                return (
                  <button
                    className="tools-metric"
                    key={key}
                    type="button"
                    disabled={!ready}
                    onClick={() => setSelection({ type: 'metric', key })}
                  >
                    <span className="tools-metric-icon">
                      <Icon aria-hidden="true" />
                    </span>
                    <span className="tools-metric-body">
                      <span>{label}</span>
                      <strong>
                        {ready ? overview.groups[key].length : '—'}
                        <small>条</small>
                      </strong>
                      <span className="tools-metric-note">{note}</span>
                      {ready && (
                        <span className="tools-metric-link">查看详情</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
            <Card data-slot="card">
              <CardHeader data-slot="card-header">
                <CardTitle data-slot="card-title">{TOOL_SOURCE_LABELS.maintenance}</CardTitle>
                {records && nativeLink(records.sourceUrl, '查看记录表')}
              </CardHeader>
              <CardContent data-slot="card-content">
                {readable(records?.state) ? (
                  <FlowList
                    key={month + filterKey}
                    flows={overview.flows}
                    tools={snapshot.tools}
                    onSelect={selectFlow}
                  />
                ) : (
                  unavailable(records?.state)
                )}
              </CardContent>
            </Card>
          </>
        )}
        {snapshot && section === 'ledger' && (
          <Card data-slot="card">
            <CardHeader data-slot="card-header">
              <CardTitle data-slot="card-title">{TOOL_SOURCE_LABELS.ledger}</CardTitle>
              {ledger && nativeLink(ledger.sourceUrl, '查看工具底表')}
            </CardHeader>
            <CardContent data-slot="card-content">
              {readable(ledger?.state) ? (
                <ToolList
                  key={filterKey}
                  tools={ledgerTools}
                  today={today}
                  onSelect={selectTool}
                />
              ) : (
                unavailable(ledger?.state)
              )}
            </CardContent>
          </Card>
        )}
      </main>
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
                运维工具管理明细
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
            {(query.isError || sourceFailures.length > 0) && (
              <p role="status" className="tools-source-warning">
                部分数据尚未更新。
              </p>
            )}
            {selectedMetric && overview && (
              <section className="tools-dialog-list" aria-label="工具明细">
                <ToolList
                  key={selectedMetric.key}
                  tools={overview.groups[selectedMetric.key]}
                  pageSize={12}
                  today={today}
                  onSelect={selectTool}
                />
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
                  nativeLink(snapshot.sources.ledger.sourceUrl, '查看工具底表')}
              </>
            )}
            {selectedFlow && (
              <>
                <dl className="tools-detail">
                  {[
                    ['编号', selectedFlow.code || selectedFlow.id],
                    ['楼栋', selectedFlow.building],
                    ['办理类型', selectedFlow.recordType],
                    ['当前阶段', selectedFlow.status],
                    ['计划办理日期', selectedFlow.date],
                    ['实际日期', selectedFlow.actualDate],
                    ['检测结论', selectedFlow.reason],
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
                    snapshot.sources.maintenance.sourceUrl,
                    '查看记录表',
                  )}
              </>
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
