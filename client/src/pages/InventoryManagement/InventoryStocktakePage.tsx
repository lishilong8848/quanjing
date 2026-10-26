import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Loader2,
  RefreshCw,
  ListRestart,
  Search,
} from 'lucide-react';
import { searchPurchaseApplicationApplicants } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import {
  WAREHOUSE_BUILDINGS,
  type WarehouseBuilding,
} from '@shared/inventory-management.interface';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';
import type {
  StocktakeLine,
  StocktakeOverview,
  StocktakeSheet,
  StocktakeGeneration,
  StocktakeScope,
  StocktakeSyncSummary,
} from '@shared/inventory-stocktake.interface';
import {
  completeStocktake,
  getStocktakeOverview,
  getStocktakeSheet,
  generateStocktake,
  getStocktakeSync,
  retryStocktakeSync,
} from './inventory-stocktake.api';
import {
  filterStocktakeLines,
  stocktakeError,
  stocktakeCurrentMonth,
  stocktakeGenerationErrors,
  groupStocktakeLines,
  stocktakeGroupPage,
  type StocktakeFilter,
} from './inventory-stocktake.logic';
import {
  InventoryStocktakeRow,
  type StocktakeLocalDraft,
} from './InventoryStocktakeRow';
import './inventory-stocktake.css';
import { StocktakeMonthPicker } from './StocktakeMonthPicker';
import { StocktakeBulkDialog } from './StocktakeBulkDialog';
import { StocktakeUndoDialog } from './StocktakeUndoDialog';

const PAGE_SIZE = 50;
const currentMonth = stocktakeCurrentMonth;
export default function InventoryStocktakePage({
  onBack,
  allowedBuildings = WAREHOUSE_BUILDINGS,
  month,
  onMonthChange,
  scope,
  onScopeChange,
  initialBuilding,
  initialFilter,
  drafts,
}: {
  onBack: () => void;
  allowedBuildings: readonly WarehouseBuilding[];
  month: string;
  onMonthChange: (month: string) => void;
  scope: StocktakeScope;
  onScopeChange: (scope: StocktakeScope) => void;
  initialBuilding: WarehouseBuilding | null;
  initialFilter: StocktakeFilter | null;
  drafts: Map<string, StocktakeLocalDraft>;
}) {
  const [building, setBuilding] = useState<WarehouseBuilding>(
    initialBuilding && allowedBuildings.includes(initialBuilding)
      ? initialBuilding
      : allowedBuildings[0],
  );
  const [overview, setOverview] = useState<StocktakeOverview | null>(null);
  const [sheet, setSheet] = useState<StocktakeSheet | null>(null);
  const [phase, setPhase] = useState<
    'loading' | 'ready' | 'submitting' | 'error'
  >('loading');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState<StocktakeGeneration | null>(
    null,
  );
  const [generationRequest, setGenerationRequest] = useState<
    'idle' | 'submitting' | 'error'
  >('idle');
  const [generationError, setGenerationError] = useState('');
  const [generationPaused, setGenerationPaused] = useState(false);
  const [generationPollEpoch, setGenerationPollEpoch] = useState(0);
  const [filter, setFilter] = useState<StocktakeFilter>(
    initialFilter &&
      [
        'all',
        'pending',
        'confirmed',
        'difference',
        'surplus',
        'shortage',
        'matched',
      ].includes(initialFilter)
      ? initialFilter
      : 'all',
  );
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const requestSequence = useRef(0),
    actionLock = useRef(false);
  const sheets = useRef(new Map<string, StocktakeSheet | null>());
  const overviews = useRef(new Map<string, StocktakeOverview>());
  const people = useRef(
    new Map<string, Promise<PurchaseApplicationApplicant[]>>(),
  );
  const requestIds = useRef(new Map<string, string>());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<StocktakeSyncSummary | null>(
    null,
  );
  const [syncError, setSyncError] = useState('');
  const [syncRetrying, setSyncRetrying] = useState(false);
  const [syncEpoch, setSyncEpoch] = useState(0);
  const syncRetryLock = useRef(false);
  const syncRetryId = useRef<{ key: string; id: string } | null>(null);
  const syncSelection = useRef('');
  const cacheKey = `${scope}:${month}:${building}`;
  syncSelection.current = cacheKey;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 120000;
    setSyncStatus(null);
    setSyncError('');
    if (
      !sheet ||
      sheet.month !== month ||
      sheet.building !== building ||
      sheet.scope !== scope ||
      month < '2026-10'
    )
      return;
    async function poll() {
      try {
        const value = await getStocktakeSync(month, building, scope);
        if (cancelled) return;
        setSyncStatus(value);
        setSyncError('');
        if (
          (value.pending + value.syncing > 0 || value.error > 0) &&
          Date.now() < deadline
        )
          timer = setTimeout(() => void poll(), 5000);
      } catch (caught) {
        if (!cancelled) setSyncError(stocktakeError(caught));
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [month, building, scope, sheet?.version, syncEpoch]);
  async function retrySync() {
    if (syncRetryLock.current) return;
    syncRetryLock.current = true;
    const selectedKey = cacheKey;
    if (syncRetryId.current?.key !== selectedKey)
      syncRetryId.current = { key: selectedKey, id: crypto.randomUUID() };
    setSyncRetrying(true);
    setSyncError('');
    try {
      const result = await retryStocktakeSync({
        month,
        building,
        scope,
        clientMutationId: syncRetryId.current.id,
      });
      syncRetryId.current = null;
      if (syncSelection.current === selectedKey) {
        setSyncStatus(result);
        setSyncEpoch((v) => v + 1);
      }
    } catch (caught) {
      if (syncSelection.current === selectedKey)
        setSyncError(stocktakeError(caught));
    } finally {
      setSyncRetrying(false);
      syncRetryLock.current = false;
    }
  }
  const scopeLabel = scope === 'review' ? '库存核盘' : '重点抽盘';
  const editable = month === currentMonth();
  const refresh = useCallback(
    async (force = false) => {
      const sequence = ++requestSequence.current;
      if (force) setGenerationPollEpoch((value) => value + 1);
      setError('');
      const key = `${scope}:${month}:${building}`;
      if (!force && sheets.current.has(key)) {
        setSheet(sheets.current.get(key)!);
        setOverview(overviews.current.get(month) || null);
        setGeneration(overviews.current.get(month)?.generation || null);
        setPhase('ready');
        return;
      }
      if (!sheets.current.get(key)) {
        setSheet(null);
        setPhase('loading');
      }
      try {
        const [loaded, summary] = await Promise.all([
          getStocktakeSheet(month, building, scope),
          getStocktakeOverview(month),
        ]);
        if (sequence !== requestSequence.current) return;
        const cached = sheets.current.get(key);
        const canonical =
          cached && loaded && cached.version > loaded.version ? cached : loaded;
        sheets.current.set(key, canonical);
        overviews.current.set(month, summary);
        setSheet(canonical);
        setOverview(summary);
        setGeneration(summary.generation || null);
        setGenerationPaused(false);
        setPhase('ready');
      } catch (caught) {
        if (sequence === requestSequence.current) {
          setError(stocktakeError(caught));
          setPhase('error');
        }
      }
    },
    [month, building, scope],
  );
  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current++;
    };
  }, [refresh]);
  useEffect(() => {
    setPage(1);
    setSearch('');
    setFilter(
      initialFilter &&
        [
          'all',
          'pending',
          'confirmed',
          'difference',
          'surplus',
          'shortage',
          'matched',
        ].includes(initialFilter)
        ? initialFilter
        : 'all',
    );
    setBulkOpen(false);
  }, [scope, month]);
  useEffect(() => {
    setGenerationError('');
    setGenerationRequest('idle');
    setGenerationPaused(false);
  }, [month]);
  useEffect(() => {
    if (
      !generation ||
      generation.month !== month ||
      generationPaused ||
      !(
        generation.status === 'queued' ||
        generation.status === 'running' ||
        (generation.status === 'error' && generation.retryAt)
      )
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sequence = requestSequence.current;
    const deadline = Date.now() + 120_000;
    const poll = async () => {
      try {
        const summary = await getStocktakeOverview(month);
        if (cancelled || sequence !== requestSequence.current) return;
        overviews.current.set(month, summary);
        setOverview(summary);
        setGenerationError('');
        if (
          !sheets.current.get(cacheKey) &&
          summary.buildings.some(
            (b) =>
              b.building === building &&
              (scope === 'review' ? b.review?.status : b.status) !==
                'not_started',
          )
        ) {
          const loaded = await getStocktakeSheet(month, building, scope);
          if (cancelled || sequence !== requestSequence.current) return;
          sheets.current.set(cacheKey, loaded);
          setSheet(loaded);
          setPhase('ready');
        }
        setGeneration(summary.generation || null);
        const job = summary.generation;
        if (
          !job ||
          !(
            job.status === 'queued' ||
            job.status === 'running' ||
            (job.status === 'error' && job.retryAt)
          )
        )
          return;
        if (Date.now() >= deadline) {
          setGenerationPaused(true);
          return;
        }
        timer = setTimeout(() => void poll(), 2000);
      } catch (caught) {
        if (!cancelled && sequence === requestSequence.current) {
          setGenerationError(`生成状态读取失败：${stocktakeError(caught)}`);
          setGenerationPaused(true);
        }
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    generation?.id,
    generation?.status,
    generation?.retryAt,
    month,
    building,
    cacheKey,
    scope,
    generationPaused,
    generationPollEpoch,
  ]);
  const searchPeople = useCallback((query: string) => {
    const key = query.toLocaleLowerCase();
    let cached = people.current.get(key);
    if (!cached) {
      cached = searchPurchaseApplicationApplicants({ query, limit: 30 });
      people.current.set(key, cached);
      cached.catch(() => people.current.delete(key));
      if (people.current.size > 100)
        people.current.delete(people.current.keys().next().value!);
    }
    return cached;
  }, []);
  const onSaved = useCallback((line: StocktakeLine, sheetVersion: number) => {
    setError((previous) => (previous === '仍有未确认条目' ? '' : previous));
    setSheet((current) => {
      if (!current) return current;
      const next = {
        ...current,
        version: Math.max(current.version, sheetVersion),
        lines: current.lines.map((l) =>
          l.inventory.recordId === line.inventory.recordId &&
          l.version <= line.version
            ? line
            : l,
        ),
      };
      sheets.current.set(
        `${current.scope || 'sample'}:${current.month}:${current.building}`,
        next,
      );
      return next;
    });
  }, []);
  const onBusy = useCallback(
    (id: string, value: boolean) =>
      setBusy((previous) => {
        const next = new Set(previous);
        if (value) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const requestedFilter = useMemo(() => ({ filter, search }), [filter, search]);
  const appliedFilter = useDeferredValue(requestedFilter);
  const filtering = appliedFilter !== requestedFilter;
  const visible = useMemo(
    () =>
      filterStocktakeLines(
        sheet?.lines || [],
        appliedFilter.filter,
        appliedFilter.search,
      ),
    [sheet, appliedFilter],
  );
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE)),
    activePage = Math.min(page, totalPages);
  const groups = useMemo(() => groupStocktakeLines(visible), [visible]);
  const pageGroups = useMemo(
    () => stocktakeGroupPage(groups, activePage, PAGE_SIZE),
    [groups, activePage],
  );
  const confirmed =
    sheet?.lines.filter((l) => l.status === 'confirmed').length || 0;
  const getMutationId = (key: string) => {
    let value = requestIds.current.get(key);
    if (!value) {
      value = crypto.randomUUID();
      requestIds.current.set(key, value);
    }
    return value;
  };
  async function start() {
    if (actionLock.current || !editable) return;
    actionLock.current = true;
    setGenerationRequest('submitting');
    setGenerationError('');
    try {
      const value = await generateStocktake({
        month,
        clientMutationId: getMutationId(`generate:${month}`),
      });
      requestIds.current.delete(`generate:${month}`);
      setGeneration(value);
      setGenerationPaused(false);
      setGenerationRequest('idle');
    } catch (caught) {
      setGenerationError(
        `生成请求未确认，请刷新状态或重试：${stocktakeError(caught)}`,
      );
      setGenerationRequest('error');
    } finally {
      actionLock.current = false;
    }
  }
  async function finish() {
    if (!sheet || actionLock.current || busy.size) return;
    if (confirmed !== sheet.lines.length) {
      setFilter('pending');
      setPage(1);
      setError('仍有未确认条目');
      return;
    }
    actionLock.current = true;
    setPhase('submitting');
    setError('');
    try {
      const result = await completeStocktake({
        scope,
        month,
        building,
        expectedVersion: sheet.version,
        clientMutationId: getMutationId(`finish:${cacheKey}:${sheet.version}`),
      });
      const next = { ...sheet, ...result };
      sheets.current.set(cacheKey, next);
      setSheet(next);
      setPhase('ready');
    } catch (caught) {
      setError(stocktakeError(caught));
      setPhase('error');
    } finally {
      actionLock.current = false;
    }
  }
  const navigationDisabled =
    busy.size > 0 ||
    phase === 'submitting' ||
    generationRequest === 'submitting';
  const generating =
    generation?.month === month &&
    (generation.status === 'queued' || generation.status === 'running');
  const generationFailures =
    generation?.month === month
      ? generation.buildings.filter((b) => b.status === 'error') || []
      : [];
  const differences =
    sheet?.lines.filter(
      (l) =>
        l.actualQuantity !== null && l.actualQuantity !== l.inventory.quantity,
    ).length || 0;
  const updatedAt = sheet
    ? [
        sheet.createdAt,
        sheet.completedAt || '',
        ...sheet.lines.map((line) => line.updatedAt),
      ]
        .sort()
        .at(-1)
    : null;
  return (
    <div className="stocktake-page min-h-screen bg-gradient-to-b from-[#eef4ff] via-[#f8fbff] to-[#eef5ff] text-slate-900">
      <ManagementHeader
        activePage="inventory"
        title={`南通全景运维平台 · ${scopeLabel}`}
        subtitle=""
        showSearch={false}
        updatedAt={
          updatedAt
            ? new Date(updatedAt).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              })
            : '—'
        }
        refreshing={phase === 'loading'}
        actions={
          <Button
            aria-label="返回库存预警与盘点"
            variant="outline"
            disabled={navigationDisabled}
            className="h-11 border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
            返回库存管理
          </Button>
        }
      />
      <main className="inventory-stocktake mx-auto w-full max-w-[1800px] px-4 py-6 md:px-8 [--stocktake-gap:0.75rem] [--stocktake-border:var(--color-blue-100)] [--stocktake-divider:var(--color-slate-100)]">
        <Card className="stocktake-workspace rounded-lg border-blue-100 bg-white/95 shadow-sm">
          <CardHeader className="stocktake-command border-b border-blue-100">
            <nav className="stocktake-scope-nav" aria-label="盘点页面">
              {(['sample', 'review'] as const).map((value) => (
                <Button
                  key={value}
                  variant={scope === value ? 'secondary' : 'ghost'}
                  aria-current={scope === value ? 'page' : undefined}
                  disabled={navigationDisabled}
                  onClick={() => {
                    if (value !== scope) {
                      setSheet(null);
                      setPhase('loading');
                      onScopeChange(value);
                    }
                  }}
                >
                  {value === 'sample' ? '重点抽盘' : '库存核盘'}
                </Button>
              ))}
            </nav>
            <div className="stocktake-title">
              <div className="stocktake-title-left">
                <h2 className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-blue-600" />
                  {scopeLabel}清单
                </h2>
                {sheet?.status === 'completed' && (
                  <Badge variant="secondary">已完成</Badge>
                )}
              </div>
              <div className="stocktake-command-actions">
                <StocktakeMonthPicker
                  label="盘点月份"
                  month={month}
                  disabled={navigationDisabled}
                  onChange={(value) => {
                    onMonthChange(value);
                    setPage(1);
                    setFilter('all');
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={navigationDisabled || phase === 'loading'}
                  onClick={() => {
                    setSyncEpoch((v) => v + 1);
                    void refresh(true);
                  }}
                  aria-label="刷新盘点状态"
                >
                  <RefreshCw className="h-4 w-4" />
                  刷新
                </Button>
                {editable && (
                  <Button
                    size="sm"
                    disabled={
                      navigationDisabled || generating || phase === 'loading'
                    }
                    onClick={() => void start()}
                  >
                    <ListRestart className="h-4 w-4" />
                    {generationRequest === 'submitting'
                      ? '提交中…'
                      : generating
                        ? '生成中'
                        : '生成本月清单'}
                  </Button>
                )}
              </div>
            </div>
            <nav className="stocktake-building-nav" aria-label="盘点楼栋">
              {allowedBuildings.map((b) => {
                const cached = sheets.current.get(`${scope}:${month}:${b}`),
                  summary =
                    overview?.month === month
                      ? overview.buildings.find((s) => s.building === b)
                      : null;
                const progress = scope === 'review' ? summary?.review : summary;
                const total = cached?.lines.length ?? progress?.total ?? 0,
                  done =
                    cached?.lines.filter((l) => l.status === 'confirmed')
                      .length ??
                    progress?.confirmed ??
                    0;
                return (
                  <Button
                    key={b}
                    disabled={navigationDisabled}
                    aria-pressed={b === building}
                    variant="ghost"
                    onClick={() => {
                      setBuilding(b);
                      setPage(1);
                      setFilter('all');
                    }}
                  >
                    {b}
                    <span>
                      {progress?.status === 'not_started' && !cached
                        ? '未生成'
                        : `${done}/${total}`}
                    </span>
                  </Button>
                );
              })}
            </nav>
          </CardHeader>
          {(generationRequest === 'submitting' ||
            generating ||
            generationFailures.length > 0 ||
            generationError ||
            (generation?.month === month &&
              generation.status === 'success')) && (
            <div
              className={`stocktake-generation ${generationFailures.length || generationError ? 'stocktake-generation-error' : ''}`}
              role={
                generationFailures.length || generationError
                  ? 'alert'
                  : 'status'
              }
            >
              {generationRequest === 'submitting' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在提交生成任务…
                </>
              ) : generationError ? (
                <span>{generationError}</span>
              ) : generating ? (
                <>
                  <Loader2
                    className={`h-4 w-4 ${generationPaused ? '' : 'animate-spin'}`}
                  />
                  <span>
                    {generationPaused
                      ? '后台仍在生成，可离开页面'
                      : `正在生成 · ${generation?.buildings.filter((b) => b.status === 'done').length || 0}/${generation?.buildings.length || 0} 栋`}
                  </span>
                </>
              ) : generationFailures.length ? (
                <span>
                  {stocktakeGenerationErrors(generationFailures)}
                  {generation?.retryAt ? ' · 将自动重试' : ''}
                </span>
              ) : (
                <span>本月清单已生成</span>
              )}
              {generationPaused && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void refresh(true)}
                >
                  查看进度
                </Button>
              )}
            </div>
          )}
          {error && (
            <div className="stocktake-error" role="alert">
              <span>{error}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={navigationDisabled}
                onClick={() => void refresh(true)}
              >
                重新加载
              </Button>
            </div>
          )}
          {phase === 'loading' && (
            <div className="stocktake-empty" role="status">
              <Loader2 className="animate-spin" />
              加载中
            </div>
          )}
          {phase !== 'loading' && !sheet && phase !== 'error' && (
            <div className="stocktake-empty">
              <ClipboardCheck className="h-7 w-7 text-slate-300" />
              <span>
                {building} ·{' '}
                {generating
                  ? '清单生成中'
                  : editable
                    ? '尚未生成盘点清单'
                    : '本月暂无盘点明细'}
              </span>
            </div>
          )}
          {sheet &&
            sheet.scope === scope &&
            sheet.month === month &&
            sheet.building === building && (
              <section aria-busy={filtering} className="stocktake-list">
                {sheet.bulkTask && (
                  <div
                    className="stocktake-generation"
                    role={
                      sheet.bulkTask.status === 'error' ? 'alert' : 'status'
                    }
                  >
                    {sheet.bulkTask.status === 'error'
                      ? sheet.bulkTask.error
                      : '批量确认处理中，草稿已保留'}
                  </div>
                )}
                {(syncStatus || syncError) && (
                  <div
                    className="stocktake-generation"
                    role={syncError || syncStatus?.error ? 'alert' : 'status'}
                  >
                    <span>
                      {syncError ||
                        (syncStatus?.error
                          ? `飞书同步失败 ${syncStatus.error} 项 · ${syncStatus.message}`
                          : syncStatus &&
                              syncStatus.pending + syncStatus.syncing > 0
                            ? `飞书同步中 · 已同步 ${syncStatus.success}/${sheet.lines.length}`
                            : '飞书已同步')}
                    </span>
                    {(syncError || !!syncStatus?.error) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={syncRetrying}
                        onClick={() => void retrySync()}
                      >
                        {syncRetrying ? '提交中…' : '重试同步'}
                      </Button>
                    )}
                  </div>
                )}
                <div className="stocktake-list-header border-b border-blue-100 bg-slate-50/50">
                  <div className="stocktake-list-title">
                    {building}
                    {scopeLabel}清单
                    <span className="stocktake-progress">
                      已盘 <b>{confirmed}</b> / {sheet.lines.length}
                    </span>
                    <span className="stocktake-progress">
                      待盘 <b>{sheet.lines.length - confirmed}</b>
                    </span>
                    <span
                      className={`stocktake-progress ${differences ? 'stocktake-difference' : ''}`}
                    >
                      差异 <b>{differences}</b>
                    </span>
                    {filtering && (
                      <Loader2
                        aria-label="筛选中"
                        className="h-4 w-4 animate-spin text-blue-600"
                      />
                    )}
                  </div>
                  <div className="stocktake-toolbar">
                    <div className="stocktake-filter" aria-label="盘点状态">
                      {(
                        [
                          ['all', '全部'],
                          ['pending', '待盘'],
                          ['confirmed', '已盘'],
                          ['difference', '差异'],
                          ['surplus', '盘盈'],
                          ['shortage', '盘亏'],
                          ['matched', '一致'],
                        ] as const
                      ).map(([key, label]) => (
                        <Button
                          size="sm"
                          variant={filter === key ? 'secondary' : 'ghost'}
                          key={key}
                          aria-pressed={filter === key}
                          onClick={() => {
                            setFilter(key);
                            setPage(1);
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    {scope === 'review' &&
                      editable &&
                      sheet.status === 'open' && (
                        <Button
                          size="sm"
                          disabled={
                            navigationDisabled ||
                            confirmed === sheet.lines.length
                          }
                          onClick={() => setBulkOpen(true)}
                        >
                          {sheet.bulkTask &&
                          ['queued', 'running'].includes(sheet.bulkTask.status)
                            ? '查看处理结果'
                            : '一键确认'}
                        </Button>
                      )}
                    {scope === 'review' &&
                      editable &&
                      sheet.latestBulk?.status === 'confirmed' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={navigationDisabled}
                          onClick={() => setUndoOpen(true)}
                        >
                          一键撤销
                        </Button>
                      )}
                    <div className="stocktake-search">
                      <Search aria-hidden="true" />
                      <Input
                        aria-label="查找盘点条目"
                        placeholder="名称、类别号、库位"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(1);
                        }}
                      />
                    </div>
                  </div>
                </div>
                {sheet.shortfall > 0 && (
                  <p className="stocktake-shortfall" role="status">
                    随机候选不足 {sheet.shortfall} 项，近期已盘条目未重复抽取。
                  </p>
                )}
                <div
                  className="stocktake-row stocktake-column-head"
                  aria-hidden="true"
                >
                  <span>物品 / 类别号</span>
                  <span className="stocktake-location">库位</span>
                  <span>来源</span>
                  <span className="stocktake-number">台账数量</span>
                  <span>实盘数量</span>
                  <span className="stocktake-number">差异</span>
                  <span>确认人</span>
                  <span className="stocktake-action-head">操作</span>
                </div>
                {pageGroups.map((group) => (
                  <section
                    key={group.name}
                    aria-label={`${group.name}盘点分组`}
                  >
                    <h3 className="stocktake-warehouse-head">
                      <span>{group.name}</span>
                      <small>
                        已盘 {group.confirmed} / {group.total}
                      </small>
                    </h3>
                    {group.lines.map((line) => (
                      <InventoryStocktakeRow
                        key={`${scope}:${sheet.month}:${sheet.building}:${line.inventory.recordId}:${line.lastUndoneAt || ''}`}
                        line={line}
                        scope={scope}
                        month={month}
                        readOnly={
                          !editable ||
                          sheet.status === 'completed' ||
                          !!(
                            sheet.bulkTask &&
                            ['queued', 'running'].includes(
                              sheet.bulkTask.status,
                            )
                          ) ||
                          phase === 'submitting'
                        }
                        searchPeople={searchPeople}
                        onSaved={onSaved}
                        onBusy={onBusy}
                        drafts={drafts}
                      />
                    ))}
                  </section>
                ))}
                {!visible.length && (
                  <div className="stocktake-empty">
                    {sheet.lines.length ? '暂无匹配条目' : '本楼本月无待盘条目'}
                  </div>
                )}
                <div className="stocktake-footer">
                  <span>
                    第 {activePage} / {totalPages} 页 · 共 {visible.length} 项
                  </span>
                  <div>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      className="border-blue-100"
                      aria-label="上一页"
                      disabled={activePage <= 1 || navigationDisabled}
                      onClick={() => setPage(activePage - 1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      className="border-blue-100"
                      aria-label="下一页"
                      disabled={activePage >= totalPages || navigationDisabled}
                      onClick={() => setPage(activePage + 1)}
                    >
                      <ChevronRight />
                    </Button>
                    <Button
                      disabled={
                        !editable ||
                        navigationDisabled ||
                        sheet.status === 'completed'
                      }
                      onClick={() => void finish()}
                    >
                      {sheet.status === 'completed'
                        ? '已完成'
                        : phase === 'submitting'
                          ? '保存中…'
                          : '完成本楼盘点'}
                    </Button>
                  </div>
                </div>
              </section>
            )}
        </Card>
      </main>
      {scope === 'review' &&
        sheet?.scope === scope &&
        sheet.month === month && (
          <StocktakeBulkDialog
            key={cacheKey}
            open={bulkOpen}
            onOpenChange={setBulkOpen}
            sheet={sheet}
            drafts={drafts}
            searchPeople={searchPeople}
            onSubmitting={(value) => setPhase(value ? 'submitting' : 'ready')}
            onAccepted={(bulkTask) => {
              const next = { ...sheet, bulkTask };
              sheets.current.set(cacheKey, next);
              setSheet(next);
            }}
            onSaved={(next) => {
              sheets.current.set(cacheKey, next);
              setSheet(next);
              setError('');
            }}
          />
        )}
      {scope === 'review' &&
        sheet?.scope === scope &&
        sheet.month === month && (
          <StocktakeUndoDialog
            key={`undo:${cacheKey}`}
            open={undoOpen}
            onOpenChange={setUndoOpen}
            sheet={sheet}
            onSubmitting={(value) => setPhase(value ? 'submitting' : 'ready')}
            onSaved={(next) => {
              next.lines
                .filter((l) => l.status === 'draft')
                .forEach((l) =>
                  drafts.delete(
                    `review:${month}:${building}:${l.inventory.recordId}`,
                  ),
                );
              sheets.current.set(cacheKey, next);
              setSheet(next);
              setError('');
            }}
          />
        )}
    </div>
  );
}
