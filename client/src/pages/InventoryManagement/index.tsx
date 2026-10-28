import { businessBuildingsForAction, hasBusinessPermissionSomewhere, isProfessionalBusinessPrincipal } from '@shared/business-permissions';
import { accessBuildings } from '@shared/building-access';
import { canUsePageAction } from '../business-action-access';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  Loader2,
  MapPin,
  PackageCheck,
  PackagePlus,
  PackageSearch,
  RotateCcw,
  Search,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { useAccess } from '@/access/AccessProvider';
import {
  getInventoryManagementDashboard,
  getInventoryManagementItems,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type {
  InventoryItemsResponse,
  InventoryManagementDashboard,
  InventoryManagementItem,
  InventoryRiskFilter,
  InventorySortOption,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '@shared/inventory-management.interface';

import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import { getStocktakeOverview } from './inventory-stocktake.api';
import { StocktakeMonthPicker } from './StocktakeMonthPicker';
import type { StocktakeOverview } from '@shared/inventory-stocktake.interface';
import type { StocktakeScope } from '@shared/inventory-stocktake.interface';
import type { StocktakeLocalDraft } from './InventoryStocktakeRow';
import type { StocktakeFilter } from './inventory-stocktake.logic';
import { StocktakeOutcomeSummary } from './StocktakeOutcomeSummary';
import {
  monthlyStocktakeProgress,
  resolveStocktakeMonth,
} from './inventory-stocktake.logic';
const InventoryStocktakePage = lazy(() => import('./InventoryStocktakePage'));
import {
  InventoryDetailDialog,
  type InventoryDetailMetric,
  type InventoryDetailSelection,
} from './InventoryDetailDialog';
import { InventoryMovementPage } from './InventoryMovementPage';
import { resolveInventoryMovementDeletionAccess } from './inventory-movement-deletion-access';
import {
  INVENTORY_SECTIONS,
  InventorySectionNav,
  type InventorySection,
} from './InventorySectionNav';

const AUTO_REFRESH_MS = 4 * 60 * 60 * 1000;
const PAGE_SIZE = 20;
const EMPTY_ITEMS: InventoryItemsResponse = {
  items: [],
  categories: [],
  total: 0,
  page: 1,
  pageSize: PAGE_SIZE,
  totalPages: 1,
};

const sourceLabels: Record<
  keyof InventoryManagementDashboard['sectionStatus'],
  string
> = {
  inventory: '库存台账',
  inbound: '入库填写',
  outbound: '出库填写',
  borrow: '借调填写',
  catalog: '物品类别',
  prices: '库房物资价格',
  stocktake: '盘点记录表',
  managers: '楼栋负责人',
};

const metricStyles = [
  'bg-blue-500 shadow-blue-200',
  'bg-cyan-500 shadow-cyan-200',
  'bg-emerald-500 shadow-emerald-200',
  'bg-rose-500 shadow-rose-200',
];

export default function InventoryManagementPage() {
  const principal = useAccess();
  const scope = accessBuildings(principal);
  const {
    role,
    purchaseBuilding, buildings,
    principalFingerprint,
    isLoading: accessLoading,
    capabilities,
  } = principal;
  const canEdit = canUsePageAction(principal, 'inventory', 'create', capabilities.canEdit);
  const canForceRefresh = canUsePageAction(principal, 'inventory', 'refresh', capabilities.canForceRefresh);
  const canReadInventory = canUsePageAction(principal, 'inventory', 'read', true);
  const canReadStocktake = canUsePageAction(principal, 'stocktake', 'read', true);
  const allowedSections = INVENTORY_SECTIONS.filter(section => section.key === 'stocktake' ? canReadStocktake : canReadInventory).map(section => section.key);
  const movementDeletionAccess = resolveInventoryMovementDeletionAccess(
    role,
    purchaseBuilding, buildings,
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get('view');
  const activeSection: InventorySection = allowedSections.includes(requestedSection as InventorySection)
    ? (requestedSection as InventorySection)
    : allowedSections[0] || 'overview';
  const executingStocktake =
    activeSection === 'stocktake' && (searchParams.get('action') === 'execute' || !canReadInventory);
  const stocktakeMonth = resolveStocktakeMonth(searchParams.get('month'));
  const stocktakeScope: StocktakeScope = searchParams.get('scope') === 'review' ? 'review' : 'sample';
  const draftIdentity = `${principalFingerprint}:${role}:${purchaseBuilding}`;
  const stocktakeDrafts = useRef({ identity: draftIdentity, values: new Map<string, StocktakeLocalDraft>() });
  if (stocktakeDrafts.current.identity !== draftIdentity)
    stocktakeDrafts.current = { identity: draftIdentity, values: new Map() };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if ([...stocktakeDrafts.current.values.values()].some(draft => draft.dirty)) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const openStocktake = (scope: StocktakeScope, building?: WarehouseBuilding, filter?: StocktakeFilter) => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('view', 'stocktake'); next.set('action', 'execute'); next.set('scope', scope);
      if (building) next.set('building', building); else next.delete('building');
      if (filter) next.set('filter', filter); else next.delete('filter');
      return next;
    });
  };
  const changeStocktakeMonth = (month: string) => {
    if (resolveStocktakeMonth(month) !== month) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('month', month);
        return next;
      },
      { replace: true },
    );
  };
  const canExecuteStocktake = principal.effectiveAuthorization ? canReadStocktake :
    (isProfessionalBusinessPrincipal(principal) ? hasBusinessPermissionSomewhere(principal, { module: 'stocktake', action: 'read' }) : role === 'admin') ||
    ((role === 'inventory_admin' || role === 'building_admin') &&
      WAREHOUSE_BUILDINGS.some((value) => value === purchaseBuilding));
  const needsDashboard = canReadInventory && (
    activeSection === 'overview' ||
    (activeSection === 'stocktake' && !executingStocktake));
  const showHeaderRefresh = needsDashboard || activeSection === 'ledger';
  const [dashboard, setDashboard] =
    useState<InventoryManagementDashboard | null>(null);
  const [progressResult, setProgressResult] = useState<{
    key: string;
    value: StocktakeOverview;
  } | null>(null);
  const progressCache = useRef(new Map<string, StocktakeOverview>());
  const progressKey = `${principalFingerprint}:${role}:${purchaseBuilding}:${stocktakeMonth}`;
  const executionProgress =
    progressResult?.key === progressKey ? progressResult.value : null;
  const [progressRevision, setProgressRevision] = useState(0);
  const [executionProgressLoading, setExecutionProgressLoading] =
    useState(false);
  const [executionProgressError, setExecutionProgressError] = useState('');
  const reloadStocktakeProgress = useCallback(() => {
    progressCache.current.delete(progressKey);
    setProgressRevision((value) => value + 1);
  }, [progressKey]);
  useEffect(() => {
    if (!canReadStocktake || activeSection !== 'stocktake') return;
    if (executingStocktake) {
      progressCache.current.delete(progressKey);
      return;
    }
    if (!canExecuteStocktake) {
      setExecutionProgressLoading(false);
      setExecutionProgressError('');
      return;
    }
    let cancelled = false;
    setExecutionProgressError('');
    const cached = progressCache.current.get(progressKey);
    if (cached) {
      setProgressResult({ key: progressKey, value: cached });
      setExecutionProgressLoading(false);
      return;
    }
    setExecutionProgressLoading(true);
    getStocktakeOverview(stocktakeMonth)
      .then((result) => {
        if (cancelled) return;
        progressCache.current.set(progressKey, result);
        if (progressCache.current.size > 24)
          progressCache.current.delete(
            progressCache.current.keys().next().value!,
          );
        setProgressResult({ key: progressKey, value: result });
      })
      .catch(() => {
        if (!cancelled)
          setExecutionProgressError('该月盘点进度读取失败，请重试。');
      })
      .finally(() => {
        if (!cancelled) setExecutionProgressLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeSection,
    executingStocktake,
    canExecuteStocktake,
    progressKey,
    stocktakeMonth,
    canReadStocktake,
    progressRevision,
  ]);
  const [items, setItems] = useState<InventoryItemsResponse>(EMPTY_ITEMS);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearch = useDeferredValue(searchQuery);
  const [building, setBuilding] = useState<WarehouseBuilding | 'all'>('all');
  const [category, setCategory] = useState('all');
  const [risk, setRisk] = useState<InventoryRiskFilter>('all');
  const [sort, setSort] = useState<InventorySortOption>('risk');
  const [page, setPage] = useState(1);
  const [detailSelection, setDetailSelection] =
    useState<InventoryDetailSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsRefreshing, setItemsRefreshing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardError, setDashboardError] = useState('');
  const [itemsError, setItemsError] = useState('');
  const dashboardRef = useRef<InventoryManagementDashboard | null>(null);
  const itemsRef = useRef<InventoryItemsResponse | null>(null);
  const itemsRequestRef = useRef(0);

  const loadDashboard = useCallback(async (forceRefresh = false) => {
    if (!dashboardRef.current) setLoading(true);
    try {
      const response = await getInventoryManagementDashboard(forceRefresh);
      dashboardRef.current = response;
      setDashboard(response);
      setDashboardError('');
    } catch {
      setDashboardError('库存驾驶舱读取失败，请检查网络或飞书数据源后重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadItems = useCallback(
    async (forceRefresh = false) => {
      const requestId = ++itemsRequestRef.current;
      if (itemsRef.current) {
        setItemsRefreshing(true);
      } else {
        setItemsLoading(true);
      }
      try {
        const response = await getInventoryManagementItems(
          {
            page,
            pageSize: PAGE_SIZE,
            search: deferredSearch.trim(),
            building,
            category,
            risk,
            sort,
          },
          forceRefresh,
        );
        if (itemsRequestRef.current !== requestId) return;
        if (
          !response ||
          !Array.isArray(response.items) ||
          !Array.isArray(response.categories) ||
          !Number.isFinite(response.total) ||
          !Number.isFinite(response.page) ||
          !Number.isFinite(response.totalPages)
        ) {
          throw new Error('Invalid inventory items response');
        }
        itemsRef.current = response;
        setItems(response);
        setItemsError('');
      } catch {
        if (itemsRequestRef.current !== requestId) return;
        setItemsError('库存台账读取失败，请稍后重试。');
      } finally {
        if (itemsRequestRef.current === requestId) {
          setItemsLoading(false);
          setItemsRefreshing(false);
        }
      }
    },
    [building, category, deferredSearch, page, risk, sort],
  );

  useEffect(() => {
    if (needsDashboard) void loadDashboard();
  }, [loadDashboard, needsDashboard]);

  useEffect(() => {
    if (activeSection === 'ledger') void loadItems();
  }, [activeSection, loadItems]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (needsDashboard) {
        if (activeSection === 'stocktake') reloadStocktakeProgress();
        void loadDashboard();
      }
      if (activeSection === 'ledger') void loadItems();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [activeSection, loadDashboard, loadItems, needsDashboard, reloadStocktakeProgress]);

  const refreshAll = useCallback(async () => {
    if (!canForceRefresh) return;
    setRefreshing(true);
    try {
      if (needsDashboard) {
        if(activeSection === 'stocktake') reloadStocktakeProgress();
        await loadDashboard(true);
      } else if (activeSection === 'ledger') {
        await loadItems(true);
      }
    } finally {
      setRefreshing(false);
    }
  }, [
    reloadStocktakeProgress,
    activeSection,
    canForceRefresh,
    loadDashboard,
    loadItems,
    needsDashboard,
  ]);

  const resetFilters = useCallback(() => {
    setSearchQuery('');
    setBuilding('all');
    setCategory('all');
    setRisk('all');
    setSort('risk');
    setPage(1);
  }, []);

  const handleOpenInboundCreate = useCallback(() => {
    if (!canEdit) return;
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set('view', 'inbound');
    nextSearchParams.set('action', 'create');
    setSearchParams(nextSearchParams);
  }, [canEdit, searchParams, setSearchParams]);

  const handleCreateRequestHandled = useCallback(() => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('action');
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const sourceIssues = dashboard
    ? Object.entries(dashboard.sectionStatus).filter(
        ([, status]) => !status.configured || Boolean(status.message),
      )
    : [];
  const hasFilters =
    Boolean(searchQuery) ||
    building !== 'all' ||
    category !== 'all' ||
    risk !== 'all' ||
    sort !== 'risk';

  if (executingStocktake) {
    return canExecuteStocktake ? (
      <Suspense fallback={<div className="p-6" role="status">加载盘点页面…</div>}>
        <InventoryStocktakePage
          month={stocktakeMonth}
          onMonthChange={changeStocktakeMonth}
          scope={stocktakeScope}
          onScopeChange={scope => openStocktake(scope)}
          initialBuilding={searchParams.get('building') as WarehouseBuilding | null}
          initialFilter={searchParams.get('filter') as StocktakeFilter | null}
          drafts={stocktakeDrafts.current.values}
          key={principalFingerprint || `${role}:${purchaseBuilding}`}
          allowedBuildings={principal.effectiveAuthorization || isProfessionalBusinessPrincipal(principal) ? WAREHOUSE_BUILDINGS.filter(value => businessBuildingsForAction(principal, { module: 'stocktake', action: 'read' }).includes(value as never)) : role === 'admin' ? WAREHOUSE_BUILDINGS : WAREHOUSE_BUILDINGS.filter(value => scope?.includes(value))}
          onBack={() => setSearchParams(current => { const next = new URLSearchParams(current); next.delete('action'); next.delete('filter'); next.delete('building'); return next; })}
        />
      </Suspense>
    ) : <div className="p-6" role="alert">当前账号无库存盘点权限</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#eef4ff] via-[#f8fbff] to-[#eef5ff] text-slate-900">
      <ManagementHeader
        activePage="inventory"
        showSearch={false}
        searchValue={searchQuery}
        searchPlaceholder="搜索物品、SKU、楼栋、库位或负责人"
        sourceLabel="南通运维全景驾驶舱-库房管理 · 8 张业务表"
        updatedAt={
          needsDashboard
            ? dashboard
              ? formatUpdatedAt(dashboard.generatedAt)
              : '同步中'
            : '按需加载'
        }
        refreshing={refreshing}
        onSearchChange={(value) => {
          setSearchQuery(value);
          setPage(1);
        }}
        onRefresh={showHeaderRefresh && canForceRefresh ? () => void refreshAll() : undefined}
        actions={
          canEdit ? (
            <Button
              type="button"
              onClick={handleOpenInboundCreate}
              className="h-11 rounded-lg bg-white px-4 font-semibold text-blue-700 shadow-sm hover:bg-blue-50 hover:text-blue-800"
            >
              <PackagePlus className="h-4 w-4" />
              新增入库
            </Button>
          ) : null
        }
      />

      <main className="mx-auto max-w-[1920px] space-y-5 px-4 py-5 sm:px-6 xl:px-8">
        {needsDashboard && dashboardError && (
          <FeedbackBanner
            tone="error"
            message={dashboardError}
            action="重新加载"
            onAction={() => void refreshAll()}
          />
        )}
        {needsDashboard && sourceIssues.length > 0 && (
          <FeedbackBanner
            tone="warning"
            message={sourceIssues
              .map(
                ([key, status]) =>
                  `${sourceLabels[key as keyof typeof sourceLabels]}：${status.message || '待配置'}`,
              )
              .join('；')}
          />
        )}

        <InventorySectionNav activeSection={activeSection} allowedSections={allowedSections} />
        {activeSection === 'stocktake' && canExecuteStocktake && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => openStocktake('sample')}><ClipboardCheck className="h-4 w-4" />重点抽盘</Button>
            <Button onClick={() => openStocktake('review')}><ClipboardCheck className="h-4 w-4" />库存核盘</Button>
          </div>
        )}

        {activeSection === 'overview' && loading && !dashboard ? (
          <InventorySkeleton />
        ) : activeSection === 'overview' && dashboard ? (
          <>
            <InventoryMetrics
              dashboard={dashboard}
              onMetricClick={(metric) =>
                setDetailSelection({ kind: 'metric', metric })
              }
            />
            <BuildingOverview
              dashboard={dashboard}
              selectedBuilding={building}
              onSelect={(value) => {
                setBuilding(value);
                setPage(1);
              }}
              onOpenDetail={(buildingValue) =>
                setDetailSelection({
                  kind: 'building',
                  building: buildingValue,
                })
              }
            />
          </>
        ) : activeSection === 'overview' ? (
          <EmptyState
            title="库存驾驶舱暂不可用"
            detail="台账仍可单独查询；可点击重新加载恢复汇总数据。"
          />
        ) : null}

        {activeSection === 'ledger' && (
          <InventoryLedger
            items={items}
            loading={itemsLoading}
            refreshing={itemsRefreshing}
            error={itemsError}
            searchValue={searchQuery}
            building={building}
            category={category}
            risk={risk}
            sort={sort}
            categories={items.categories}
            hasFilters={hasFilters}
            onSearchChange={(value) => {
              setSearchQuery(value);
              setPage(1);
            }}
            onBuildingChange={(value) => {
              setBuilding(value);
              setPage(1);
            }}
            onCategoryChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
            onRiskChange={(value) => {
              setRisk(value);
              setPage(1);
            }}
            onSortChange={(value) => {
              setSort(value);
              setPage(1);
            }}
            onReset={resetFilters}
            onPageChange={setPage}
            onRetry={() => void loadItems(canForceRefresh)}
          />
        )}

        {(activeSection === 'inbound' ||
          activeSection === 'outbound' ||
          activeSection === 'borrow') && (
          <InventoryMovementPage
            key={activeSection}
            type={activeSection}
            searchQuery=""
            canConfirmOutbound={
              canUsePageAction(principal, 'inventory', 'confirm', (isProfessionalBusinessPrincipal(principal) ? hasBusinessPermissionSomewhere(principal, { module: 'inventory', action: 'confirm' }) : role === 'admin') ||
              ((role === 'inventory_admin' || role === 'building_admin') && Boolean(purchaseBuilding)))
            }
            canDeleteMovements={canUsePageAction(principal, 'inventory', 'delete', movementDeletionAccess.canDelete && (!isProfessionalBusinessPrincipal(principal) || hasBusinessPermissionSomewhere(principal, { module: 'inventory', action: 'delete' })))}
            movementDeletionBuilding={movementDeletionAccess.building}
            outboundConfirmationAccessReady={!accessLoading}
            outboundConfirmationBuilding={
              scope?.length === 1 ? scope[0] : null
            }
            purchaseExecutionRecordId={
              searchParams.get('purchase') ?? undefined
            }
            createRequested={
              activeSection === 'inbound' &&
              searchParams.get('action') === 'create'
            }
            onCreateRequestHandled={handleCreateRequestHandled}
          />
        )}

        {activeSection === 'stocktake' && dashboard && (
          <AlertAndStocktake
            dashboard={{
              ...dashboard,
              stocktake: monthlyStocktakeProgress(
                stocktakeMonth,
                dashboard.stocktakeHistory ?? [dashboard.stocktake],
                executionProgress,
                dashboard.stocktake.buildings.map(item => item.building),
              ),
            }}
            month={stocktakeMonth}
            onMonthChange={changeStocktakeMonth}
            loading={executionProgressLoading}
            error={executionProgressError}
            onRetry={reloadStocktakeProgress}
            overview={executionProgress}
            onOpen={canExecuteStocktake ? openStocktake : undefined}
          />
        )}
        {activeSection === 'stocktake' && loading && !dashboard && (
          <InventorySkeleton />
        )}
        {activeSection === 'stocktake' && !loading && !dashboard && (
          <EmptyState
            title="盘点与预警暂不可用"
            detail="请重新加载仪表盘数据，恢复库存风险和盘点进度。"
          />
        )}
      </main>
      {dashboard && (
        <InventoryDetailDialog
          dashboard={dashboard}
          selection={detailSelection}
          onOpenChange={(open) => {
            if (!open) setDetailSelection(null);
          }}
        />
      )}
    </div>
  );
}

function InventoryMetrics({
  dashboard,
  onMetricClick,
}: {
  dashboard: InventoryManagementDashboard;
  onMetricClick: (metric: InventoryDetailMetric) => void;
}) {
  const { summary } = dashboard;
  const metrics: Array<{
    label: string;
    value: string;
    detail: string;
    icon: LucideIcon;
    detailMetric: InventoryDetailMetric;
  }> = [
    {
      label: '库存品类',
      value: formatNumber(summary.distinctSkus),
      detail: `${formatNumber(summary.inventoryLines)} 条库存记录`,
      icon: Boxes,
      detailMetric: 'categories',
    },
    {
      label: '库存总量',
      value: formatNumber(summary.totalQuantity),
      detail: `${formatNumber(summary.unassignedInventoryLines)} 条楼栋待配置`,
      icon: Warehouse,
      detailMetric: 'quantity',
    },
    {
      label: '库存价值',
      value: formatCurrency(summary.inventoryValue),
      detail:
        summary.inventoryValue > 0
          ? `${dashboard.categories.length} 个一级分类`
          : '价格数据待完善',
      icon: CircleDollarSign,
      detailMetric: 'value',
    },
    {
      label: '风险库存',
      value: formatNumber(summary.lowStockItems),
      detail: `${summary.negativeStockItems} 项负库存 · ${summary.idleItems} 项长期未用`,
      icon: AlertTriangle,
      detailMetric: 'risk',
    },
  ];

  return (
    <section
      aria-label="库存核心指标"
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      {metrics.map((metric, index) => {
        const Icon = metric.icon;
        return (
          <Card
            key={metric.label}
            role="button"
            tabIndex={0}
            aria-label={`查看${metric.label}详情`}
            onClick={() => onMetricClick(metric.detailMetric)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onMetricClick(metric.detailMetric);
              }
            }}
            className="min-h-36 cursor-pointer border-[#d8e5f7] bg-white/90 shadow-[0_8px_24px_rgba(27,75,143,0.08)] transition duration-200 hover:-translate-y-0.5 hover:border-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
          >
            <CardContent className="flex h-full items-start gap-4 p-5">
              <span
                className={cn(
                  'inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-white shadow-lg',
                  metricStyles[index],
                )}
              >
                <Icon className="h-7 w-7" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-600">
                  {metric.label}
                </span>
                <strong
                  className="mt-1 block truncate text-2xl font-bold tabular-nums text-slate-950 sm:text-3xl"
                  title={metric.value}
                >
                  {metric.value}
                </strong>
                <span className="mt-2 block text-xs leading-5 text-slate-500">
                  {metric.detail}
                </span>
                <span className="mt-2 block text-[11px] font-semibold text-blue-600">
                  查看详情
                </span>
              </span>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}

function BuildingOverview({
  dashboard,
  selectedBuilding,
  onSelect,
  onOpenDetail,
}: {
  dashboard: InventoryManagementDashboard;
  selectedBuilding: WarehouseBuilding | 'all';
  onSelect: (value: WarehouseBuilding | 'all') => void;
  onOpenDetail: (value: WarehouseBuilding) => void;
}) {
  return (
    <section aria-labelledby="building-overview-title">
      <SectionHeading
        id="building-overview-title"
        icon={Warehouse}
        title="七楼栋库存态势"
        detail="点击楼栋查看详细库存"
        action={
          selectedBuilding !== 'all' ? (
            <Button variant="outline" size="sm" onClick={() => onSelect('all')}>
              查看全部楼栋
            </Button>
          ) : null
        }
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
        {dashboard.buildings.map((item) => {
          const active = selectedBuilding === item.building;
          return (
            <button
              key={item.building}
              type="button"
              aria-label={`查看${item.building}库存详情`}
              onClick={() => onOpenDetail(item.building)}
              className={cn(
                'min-h-44 rounded-xl border bg-white/90 p-4 text-left shadow-[0_6px_18px_rgba(27,75,143,0.07)] transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
                active
                  ? 'border-blue-500 ring-2 ring-blue-100'
                  : 'border-[#d8e5f7] hover:-translate-y-0.5 hover:border-blue-300',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <strong className="text-xl font-bold text-blue-700">
                  {item.building}
                </strong>
                {item.lowStockItems > 0 ? (
                  <Badge className="border-rose-100 bg-rose-50 text-rose-700">
                    {item.lowStockItems} 预警
                  </Badge>
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                )}
              </span>
              <span className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-500">
                <span>
                  品类
                  <strong className="mt-1 block text-base tabular-nums text-slate-900">
                    {formatNumber(item.distinctSkus)}
                  </strong>
                </span>
                <span>
                  数量
                  <strong className="mt-1 block text-base tabular-nums text-slate-900">
                    {formatNumber(item.totalQuantity)}
                  </strong>
                </span>
              </span>
              <span className="mt-4 flex min-w-0 items-center gap-1 text-xs text-slate-500">
                <Users className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {item.owners.join('、') || '负责人待配置'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface InventoryLedgerProps {
  items: InventoryItemsResponse;
  loading: boolean;
  refreshing: boolean;
  error: string;
  searchValue: string;
  building: WarehouseBuilding | 'all';
  category: string;
  risk: InventoryRiskFilter;
  sort: InventorySortOption;
  categories: string[];
  hasFilters: boolean;
  onSearchChange: (value: string) => void;
  onBuildingChange: (value: WarehouseBuilding | 'all') => void;
  onCategoryChange: (value: string) => void;
  onRiskChange: (value: InventoryRiskFilter) => void;
  onSortChange: (value: InventorySortOption) => void;
  onReset: () => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}

function InventoryLedger(props: InventoryLedgerProps) {
  return (
    <Card
      id="inventory-ledger"
      className="scroll-mt-4 overflow-hidden border-[#d8e5f7] bg-white/95 shadow-[0_8px_26px_rgba(27,75,143,0.08)]"
    >
      <CardHeader className="border-b border-blue-100 bg-blue-50/40 p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-bold text-slate-900">
              <PackageSearch className="h-5 w-5 text-blue-600" />
              库存台账
              <Badge className="border-blue-100 bg-blue-50 text-blue-700">
                {formatNumber(props.items.total)} 条
              </Badge>
              {props.refreshing && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-600">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  更新中
                </span>
              )}
            </CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              按库存风险优先排序，数据由服务端筛选和分页
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72 xl:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                aria-label="搜索库存台账"
                placeholder="搜索物品、SKU、楼栋、库位或负责人"
                value={props.searchValue}
                onChange={(event) => props.onSearchChange(event.target.value)}
                className="border-[#cfe0ff] bg-white pl-9 focus-visible:border-blue-500 focus-visible:ring-blue-500/20"
              />
            </div>
            <NativeSelect
              aria-label="楼栋筛选"
              value={props.building}
              onChange={(event) =>
                props.onBuildingChange(
                  event.target.value as WarehouseBuilding | 'all',
                )
              }
              className="w-32 border-[#cfe0ff] bg-white"
            >
              <NativeSelectOption value="all">全部楼栋</NativeSelectOption>
              {WAREHOUSE_BUILDINGS.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="分类筛选"
              value={props.category}
              onChange={(event) => props.onCategoryChange(event.target.value)}
              className="w-36 border-[#cfe0ff] bg-white"
            >
              <NativeSelectOption value="all">全部分类</NativeSelectOption>
              {props.categories.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="风险筛选"
              value={props.risk}
              onChange={(event) =>
                props.onRiskChange(event.target.value as InventoryRiskFilter)
              }
              className="w-32 border-[#cfe0ff] bg-white"
            >
              <NativeSelectOption value="all">全部状态</NativeSelectOption>
              <NativeSelectOption value="low">低库存</NativeSelectOption>
              <NativeSelectOption value="negative">负库存</NativeSelectOption>
              <NativeSelectOption value="idle">长期未用</NativeSelectOption>
            </NativeSelect>
            <NativeSelect
              aria-label="台账排序"
              value={props.sort}
              onChange={(event) =>
                props.onSortChange(event.target.value as InventorySortOption)
              }
              className="w-36 border-[#cfe0ff] bg-white"
            >
              <NativeSelectOption value="risk">风险优先</NativeSelectOption>
              <NativeSelectOption value="quantityAsc">
                库存从少到多
              </NativeSelectOption>
              <NativeSelectOption value="quantityDesc">
                库存从多到少
              </NativeSelectOption>
              <NativeSelectOption value="usageAsc">
                使用频次从低到高
              </NativeSelectOption>
              <NativeSelectOption value="valueDesc">
                库存价值从高到低
              </NativeSelectOption>
            </NativeSelect>
            {props.hasFilters && (
              <Button variant="outline" size="sm" onClick={props.onReset}>
                <RotateCcw className="h-4 w-4" />
                重置
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {props.error && (
          <div className="m-4">
            <FeedbackBanner
              tone="error"
              message={props.error}
              action="重试"
              onAction={props.onRetry}
            />
          </div>
        )}
        {props.loading && !props.items.items.length ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-slate-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-600" />
            正在查询库存台账
          </div>
        ) : props.items.items.length ? (
          <InventoryTable items={props.items.items} />
        ) : (
          <EmptyState
            title="暂无匹配的库存记录"
            detail={
              props.hasFilters ? '调整筛选条件后再试。' : '库存台账当前为空。'
            }
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          <span>
            第 {props.items.page} / {props.items.totalPages} 页 · 共{' '}
            {formatNumber(props.items.total)} 条
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一页"
              disabled={props.loading || props.items.page <= 1}
              onClick={() => props.onPageChange(props.items.page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一页"
              disabled={
                props.loading || props.items.page >= props.items.totalPages
              }
              onClick={() => props.onPageChange(props.items.page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function InventoryTable({ items }: { items: InventoryManagementItem[] }) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
          <thead className="bg-slate-50/80 text-xs font-semibold text-slate-500">
            <tr>
              <th className="px-5 py-3">物品 / SKU</th>
              <th className="px-4 py-3">分类</th>
              <th className="px-4 py-3">楼栋 / 库位</th>
              <th className="px-4 py-3 text-right">剩余库存</th>
              <th className="px-4 py-3 text-right">最小库存</th>
              <th className="px-4 py-3 text-right">年度频次</th>
              <th className="px-4 py-3 text-right">库存价值</th>
              <th className="px-5 py-3">状态</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.recordId}
                className="border-t border-slate-100 transition hover:bg-blue-50/40"
              >
                <td className="max-w-64 px-5 py-3.5">
                  <strong
                    className="block truncate text-slate-900"
                    title={item.name}
                  >
                    {item.name}
                  </strong>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.sku || '类别号待配置'} ·{' '}
                    {item.specification || '规格待补充'}
                  </span>
                </td>
                <td className="max-w-40 px-4 py-3.5 text-slate-600">
                  <span className="block truncate">{item.primaryCategory}</span>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.secondaryCategory || '未细分'}
                  </span>
                </td>
                <td className="max-w-44 px-4 py-3.5 text-slate-600">
                  <span className="block truncate">{item.building}</span>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.location || '库位待配置'}
                  </span>
                </td>
                <td
                  className={cn(
                    'px-4 py-3.5 text-right font-bold tabular-nums',
                    item.negativeStock ? 'text-rose-700' : 'text-slate-900',
                  )}
                >
                  {formatNumber(item.quantity)} {item.unit}
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-600">
                  {formatNumber(item.minimumQuantity)} {item.unit}
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-600">
                  {formatNumber(item.annualUsage)}
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-700">
                  {formatCurrency(item.value)}
                </td>
                <td className="px-5 py-3.5">
                  <InventoryRiskBadges item={item} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 p-4 md:hidden">
        {items.map((item) => (
          <article
            key={item.recordId}
            className="rounded-xl border border-[#d8e5f7] bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-900">
                  {item.name}
                </h3>
                <p className="mt-1 truncate text-xs text-slate-400">
                  {item.sku || '类别号待配置'} · {item.primaryCategory}
                </p>
              </div>
              <strong
                className={cn(
                  'shrink-0 text-base tabular-nums',
                  item.negativeStock ? 'text-rose-700' : 'text-slate-900',
                )}
              >
                {formatNumber(item.quantity)} {item.unit}
              </strong>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
              <span className="min-w-0 truncate">
                {item.building} · {item.location || '库位待配置'}
              </span>
              <InventoryRiskBadges item={item} />
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function InventoryRiskBadges({ item }: { item: InventoryManagementItem }) {
  if (!item.lowStock && !item.idle && !item.pendingConfirmation) {
    return (
      <Badge className="border-emerald-100 bg-emerald-50 text-emerald-700">
        正常
      </Badge>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {item.negativeStock && (
        <Badge className="border-rose-200 bg-rose-100 text-rose-800">
          负库存
        </Badge>
      )}
      {item.lowStock && !item.negativeStock && (
        <Badge className="border-amber-200 bg-amber-50 text-amber-800">
          低库存
        </Badge>
      )}
      {item.idle && (
        <Badge className="border-slate-200 bg-slate-100 text-slate-700">
          长期未用
        </Badge>
      )}
      {item.pendingConfirmation && (
        <Badge className="border-blue-200 bg-blue-50 text-blue-700">
          待确认
        </Badge>
      )}
    </span>
  );
}

function AlertAndStocktake({
  dashboard,
  month,
  onMonthChange,
  loading,
  error,
  onRetry,
  overview,
  onOpen,
}: {
  dashboard: InventoryManagementDashboard;
  month: string;
  onMonthChange: (month: string) => void;
  loading: boolean;
  error: string;
  onRetry: () => void;
  overview: StocktakeOverview | null;
  onOpen?: (scope: StocktakeScope, building?: WarehouseBuilding, filter?: StocktakeFilter) => void;
}) {
  return (
    <section aria-labelledby="alert-stocktake-title">
      <SectionHeading
        id="alert-stocktake-title"
        icon={AlertTriangle}
        title="库存预警与盘点"
        detail="库存风险和月度盘点进度"
      />
      <div className="mt-3 grid gap-5 xl:grid-cols-2">
        <Panel
          title="库存预警"
          icon={AlertTriangle}
          action={
            <Badge className="border-rose-100 bg-rose-50 text-rose-700">
              {dashboard.alerts.length} 项
            </Badge>
          }
        >
          {dashboard.alerts.length ? (
            <div className="max-h-[460px] divide-y divide-slate-100 overflow-y-auto pr-1">
              {dashboard.alerts.slice(0, 30).map((item) => (
                <div
                  key={item.recordId}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3"
                >
                  <span
                    className={cn(
                      'inline-flex h-9 w-9 items-center justify-center rounded-lg border',
                      item.negativeStock
                        ? 'border-rose-200 bg-rose-50 text-rose-700'
                        : 'border-amber-200 bg-amber-50 text-amber-700',
                    )}
                  >
                    <AlertTriangle className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm text-slate-900">
                      {item.name}
                    </strong>
                    <span className="mt-1 flex items-center gap-1 truncate text-xs text-slate-400">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {item.building} · {item.location || '库位待配置'} ·{' '}
                      {item.sku || '类别号待配置'}
                    </span>
                  </span>
                  <span className="text-right text-xs">
                    <strong
                      className={
                        item.negativeStock ? 'text-rose-700' : 'text-amber-700'
                      }
                    >
                      {formatNumber(item.quantity)} /{' '}
                      {formatNumber(item.minimumQuantity)}
                    </strong>
                    <span className="mt-1 block text-slate-400">
                      {item.unit || '单位待补充'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="当前无库存预警"
              detail="所有库存均达到最小库存量。"
              success
            />
          )}
        </Panel>

        <Panel
          title="月度盘点进度"
          icon={ClipboardCheck}
          action={
            <StocktakeMonthPicker
              label="进度月份"
              month={month}
              onChange={onMonthChange}
            />
          }
        >
          {loading ? (
            <div
              className="flex min-h-44 items-center justify-center gap-2 text-sm text-slate-500"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              加载中
            </div>
          ) : error ? (
            <FeedbackBanner
              tone="error"
              message={error}
              action="重试"
              onAction={onRetry}
            />
          ) : dashboard.stocktake.total === 0 ? (
            <div className="flex min-h-44 items-center justify-center text-sm text-slate-500">
              该月暂无盘点记录
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-blue-100 bg-blue-50/45 p-4">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold text-slate-500">
                      总体完成率
                    </p>
                    <strong className="mt-1 block text-3xl font-bold tabular-nums text-blue-700">
                      {dashboard.stocktake.completionRate}%
                    </strong>
                  </div>
                  <p className="text-right text-xs text-slate-500">
                    已盘点 {formatNumber(dashboard.stocktake.completed)} /{' '}
                    {formatNumber(dashboard.stocktake.total)}
                  </p>
                </div>
                <Progress
                  value={dashboard.stocktake.completionRate}
                  className="mt-3 bg-blue-100"
                />
              </div>
              <StocktakeOutcomeSummary overview={overview} onOpen={onOpen} />
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {dashboard.stocktake.buildings.map((item) => (
                  <div
                    key={item.building}
                    className="rounded-lg border border-slate-100 px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <strong className="text-slate-800">
                        {item.building}
                      </strong>
                      <span className="font-semibold tabular-nums text-blue-700">
                        {item.completionRate}%
                      </span>
                    </div>
                    <Progress
                      value={item.completionRate}
                      className="mt-2 h-1.5 bg-slate-100"
                    />
                    <p className="mt-2 truncate text-[11px] text-slate-400">
                      {item.responsible || '责任人待配置'}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>
      </div>
    </section>
  );
}

function Panel({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="border-[#d8e5f7] bg-white/95 shadow-[0_8px_26px_rgba(27,75,143,0.08)]">
      <CardHeader className="p-5 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base font-bold text-slate-900">
            <Icon className="h-5 w-5 text-blue-600" />
            {title}
          </CardTitle>
          {action}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">{children}</CardContent>
    </Card>
  );
}

function SectionHeading({
  id,
  icon: Icon,
  title,
  detail,
  action,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2
          id={id}
          className="flex items-center gap-2 text-base font-bold text-slate-900"
        >
          <Icon className="h-5 w-5 text-blue-600" />
          {title}
        </h2>
        <p className="mt-1 text-xs text-slate-500">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function FeedbackBanner({
  tone,
  message,
  action,
  onAction,
}: {
  tone: 'warning' | 'error';
  message: string;
  action?: string;
  onAction?: () => void;
}) {
  const Icon = tone === 'error' ? AlertCircle : AlertTriangle;
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 rounded-xl border px-4 py-3 text-sm',
        tone === 'error'
          ? 'border-rose-200 bg-rose-50 text-rose-800'
          : 'border-amber-200 bg-amber-50 text-amber-800',
      )}
    >
      <span className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="leading-5">{message}</span>
      </span>
      {action && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 font-semibold underline-offset-4 hover:underline"
        >
          {action}
        </button>
      )}
    </div>
  );
}

function EmptyState({
  title,
  detail,
  success = false,
}: {
  title: string;
  detail: string;
  success?: boolean;
}) {
  const Icon = success ? PackageCheck : Search;
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center">
      <span
        className={cn(
          'inline-flex h-12 w-12 items-center justify-center rounded-xl',
          success
            ? 'bg-emerald-50 text-emerald-500'
            : 'bg-blue-50 text-blue-400',
        )}
      >
        <Icon className="h-6 w-6" />
      </span>
      <p className="mt-3 text-sm font-semibold text-slate-700">{title}</p>
      <p className="mt-1 text-xs text-slate-400">{detail}</p>
    </div>
  );
}

function InventorySkeleton() {
  return (
    <div className="space-y-5" aria-label="库存数据加载中">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-36 animate-pulse rounded-xl border border-[#d8e5f7] bg-white"
          />
        ))}
      </div>
      <div className="flex h-64 items-center justify-center rounded-xl border border-[#d8e5f7] bg-white text-sm text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-600" />
        正在同步库存驾驶舱
      </div>
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(
    value,
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string | null): string {
  if (!value) return '时间待补充';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待补充';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待同步';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
