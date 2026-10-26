import { accessBuildings } from '@shared/building-access';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LayoutDashboard, PanelsTopLeft, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { canAccessPage } from '@/access/access-policy';
import { useAccess } from '@/access/AccessProvider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type {
  LedgerAsset,
  LedgerLifecycle,
  LedgerQuery,
  LedgerPage as LedgerPageData,
} from '@shared/equipment-ledger.interface';
import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import { formatUpdatedAt } from '../EquipmentLifecycleDashboard/model';
import {
  getLedgerItems,
  getLedgerLifecycle,
  getLedgerLifecycleDashboard,
} from './api';
import { useLedgerQuery, type LedgerCache } from './use-ledger-query';
import {
  useLedgerDashboard,
  type LedgerReadTiming,
} from './use-ledger-dashboard';
import { LedgerMetrics, type LedgerSelection } from './LedgerPanels';
import { LedgerCharts } from './LedgerCharts';
import { LedgerList } from './LedgerList';
import { AssetDetail, LedgerDrilldown } from './LedgerDialogs';
import { RepairDevicesCard } from './RepairDevicesCard';
import './styles.css';
import './charts.css';

const LifecycleDashboard = lazy(() => import('../EquipmentLifecycleDashboard'));

const BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
export default function EquipmentLedgerManagement() {
  const {
    role, pagePaths,
    purchaseBuilding, buildings,
    principalFingerprint,
    capabilities: { canForceRefresh },
  } = useAccess();
  const scope = accessBuildings({ role, purchaseBuilding, buildings });
  const allowedBuildings = BUILDINGS.filter(value => !scope || scope.includes(value as never));
  const scopedBuilding = role === 'building_admin' && allowedBuildings.length === 1 ? allowedBuildings[0] : null;
  if (
    !canAccessPage(role, '/equipment-ledger-management', pagePaths) ||
    (role === 'building_admin' &&
      !allowedBuildings.length)
  )
    return (
      <p role="alert" className="equipment-ledger-empty">
        无设备台账访问权限
      </p>
    );
  return (
    <LedgerPage
      key={`${principalFingerprint || 'guest'}:${role}:${scopedBuilding || 'global'}`}
      canForceRefresh={canForceRefresh}
      allowedBuildings={allowedBuildings}
      scopedBuilding={scopedBuilding || undefined}
    />
  );
}

export function LedgerPage({
  canForceRefresh,
  readTiming,
  scopedBuilding, allowedBuildings = BUILDINGS,
}: {
  canForceRefresh: boolean;
  readTiming?: LedgerReadTiming;
  scopedBuilding?: string;
  allowedBuildings?: string[];
}) {
  const [params, setParams] = useSearchParams();
  const requestedBuilding = params.get('building') || '';
  const building =
    scopedBuilding ||
    (allowedBuildings.includes(requestedBuilding) ? requestedBuilding : '');
  const lifecycleActive = params.get('view') === 'lifecycle';
  const [lifecycleUpdated, setLifecycleUpdated] = useState<{
    building: string;
    updatedAt: string;
  } | null>(null);
  const lifecycleLoader = useCallback(
    async (options: { month?: string; refresh?: boolean } = {}) => {
      const view = await getLedgerLifecycleDashboard({
        ...options,
        building: building || undefined,
      });
      setLifecycleUpdated({ building, updatedAt: view.updatedAt });
      return view;
    },
    [building],
  );
  const cache = useRef<LedgerCache>(new Map()).current;
  const dashboard = useLedgerDashboard(cache, readTiming, !lifecycleActive);
  const data = dashboard.data;
  const summary = building
    ? data?.buildings.find((item) => item.building === building)
    : data?.overview;
  const [filters, setFilters] = useState<LedgerQuery>({});
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [selection, setSelection] = useState<LedgerSelection | null>(null);
  const [asset, setAsset] = useState<LedgerAsset | null>(null);
  const assetSnapshot = useRef('');
  const selectionFocus = useRef<HTMLElement | SVGElement | null>(null);
  const assetFocus = useRef<HTMLElement | null>(null);
  const refreshedAsset = useLedgerQuery<LedgerPageData>(
    cache,
    asset && data && assetSnapshot.current !== data.snapshotId
      ? `asset:${data.snapshotId}:${asset.id}`
      : null,
    (signal) => getLedgerItems({ id: asset!.id, kind: asset!.kind }, signal),
  );
  const lifecycle = useLedgerQuery<LedgerLifecycle>(
    cache,
    asset ? 'lifecycle' : null,
    getLedgerLifecycle,
  );
  const query = useMemo(
    () => ({
      ...filters,
      ...(building ? { building } : {}),
      search: deferredSearch,
    }),
    [filters, building, deferredSearch],
  );
  const selectBuilding = (value: string) => {
    if (scopedBuilding && value !== scopedBuilding) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('view');
      if (value) next.set('building', value);
      else next.delete('building');
      return next;
    });
    setFilters({});
    setSelection(null);
  };
  const openSelection = (next: LedgerSelection) => {
    selectionFocus.current =
      document.activeElement instanceof HTMLElement ||
      document.activeElement instanceof SVGElement
        ? document.activeElement
        : null;
    const scope = scopedBuilding || next.query.building || building;
    setSelection({
      ...next,
      title:
        scope && !next.title.includes(scope)
          ? `${scope} · ${next.title}`
          : next.title,
      query: { ...next.query, ...(scope ? { building: scope } : {}) },
    });
  };
  const openAsset = (next: LedgerAsset) => {
    assetFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    assetSnapshot.current = data?.snapshotId || '';
    setAsset(next);
  };
  const drillSummary = selection?.query.building
    ? data?.buildings.find((item) => item.building === selection.query.building)
    : data?.overview;
  const changeFilter = (key: keyof LedgerQuery, value: string) =>
    setFilters((current) => ({
      ...current,
      [key]: value || undefined,
      page: 1,
    }));

  return (
    <main className="equipment-ledger-page min-h-screen bg-slate-50 font-sans text-slate-800 [--el-bg:hsl(216_45%_97%)] [--el-surface:hsl(216_38%_99%)] [--el-text:hsl(222_47%_15%)] [--el-muted:hsl(220_12%_43%)] [--el-border:hsl(214_25%_88%)] [--el-blue:hsl(211_52%_48%)] [--el-success:hsl(162_43%_42%)] [--el-warning:hsl(35_65%_35%)] [--el-error:hsl(354_50%_43%)] [--el-radius:0.5rem] [--el-space:1rem]">
      <ManagementHeader
        activePage="inventory"
        title="设备台账管理"
        subtitle=""
        toolbarLabel="设备台账工具栏"
        showSearch={!lifecycleActive}
        searchValue={search}
        searchPlaceholder="搜索设备、编号、品牌、型号或位置"
        onSearchChange={(value) => {
          setSearch(value.slice(0, 200));
          setFilters((current) => ({ ...current, page: 1 }));
        }}
        updatedAt={
          lifecycleActive
            ? lifecycleUpdated?.building === building
              ? formatUpdatedAt(lifecycleUpdated.updatedAt)
              : '—'
            : data
              ? formatUpdatedAt(data.updatedAt)
              : '—'
        }
        refreshing={!lifecycleActive && dashboard.refreshing}
        onRefresh={
          !lifecycleActive && canForceRefresh ? dashboard.retry : undefined
        }
      />
      <div className="equipment-ledger-content mx-auto grid w-full max-w-[100rem] gap-4 px-3 py-4 md:px-6">
        <nav className="equipment-module-nav" aria-label="设备资产页面">
          {[
            { value: '', label: '设备台账', icon: PanelsTopLeft },
            { value: 'lifecycle', label: '生命周期', icon: RefreshCw },
          ].map((tab) => (
            <Button
              key={tab.value}
              variant="ghost"
              aria-current={
                lifecycleActive === Boolean(tab.value) ? 'page' : undefined
              }
              onClick={() =>
                setParams((current) => {
                  const next = new URLSearchParams(current);
                  if (tab.value) next.set('view', tab.value);
                  else next.delete('view');
                  return next;
                })
              }
            >
              <tab.icon aria-hidden="true" />
              {tab.label}
            </Button>
          ))}
        </nav>
        {!lifecycleActive ? (
          <>
            <nav className="equipment-ledger-nav" aria-label="设备台账楼栋">
              {!scopedBuilding ? (
                <Button
                  variant={!building ? 'default' : 'ghost'}
                  aria-current={!building ? 'page' : undefined}
                  onClick={() => selectBuilding('')}
                >
                  <LayoutDashboard aria-hidden="true" />
                  总览
                </Button>
              ) : null}
              {[
                { name: '自建楼', values: BUILDINGS.slice(0, 3) },
                { name: '代维楼', values: BUILDINGS.slice(3) },
              ]
                .map((group) => ({
                  ...group,
                  values: group.values.filter(
                    (value) => allowedBuildings.includes(value) && (!scopedBuilding || value === scopedBuilding),
                  ),
                }))
                .filter((group) => group.values.length)
                .map((group) => (
                  <div className="equipment-ledger-nav-group" key={group.name}>
                    <span>{group.name}</span>
                    {group.values.map((value) => (
                      <Button
                        key={value || 'overview'}
                        variant={building === value ? 'default' : 'ghost'}
                        aria-current={building === value ? 'page' : undefined}
                        onClick={() => selectBuilding(value)}
                      >
                        <span
                          className="equipment-building-letter"
                          aria-hidden="true"
                        >
                          {value.slice(0, 1)}
                        </span>
                        {value || '总览'}
                      </Button>
                    ))}
                  </div>
                ))}
            </nav>
            {dashboard.error ? (
              <div role="alert" className="equipment-ledger-alert">
                {dashboard.error}
                {data ? '；当前展示最近成功读取的数据' : ''}
                <Button variant="outline" size="sm" onClick={dashboard.retry}>
                  重试
                </Button>
              </div>
            ) : null}
            {data?.stale && !dashboard.refreshing ? (
              <p role="status" className="equipment-ledger-notice">
                当前展示最近一次成功同步的数据 ·{' '}
                {formatUpdatedAt(data.updatedAt)}
              </p>
            ) : null}
            {dashboard.refreshing ? (
              <p role="status" className="equipment-ledger-loading">
                正在更新设备台账…
              </p>
            ) : null}
            {!data && dashboard.loading ? (
              <section
                className="equipment-ledger-skeleton"
                aria-label="设备台账加载中"
              >
                <div className="equipment-ledger-metrics">
                  {Array.from({ length: 4 }, (_, index) => (
                    <Card
                      key={index}
                      className="equipment-ledger-skeleton-card"
                    >
                      <span />
                      <strong />
                    </Card>
                  ))}
                </div>
                <Card className="equipment-ledger-skeleton-list">
                  {Array.from({ length: 5 }, (_, index) => (
                    <span key={index} />
                  ))}
                </Card>
              </section>
            ) : null}
            {data && !summary ? (
              <p className="equipment-ledger-empty">该楼栋暂无设备</p>
            ) : null}
            {summary && data ? (
              <>
                {!search.trim() ? (
                  <>
                    <LedgerMetrics summary={summary} onSelect={openSelection} />
                    <RepairDevicesCard
                      cache={cache}
                      building={building}
                      onAsset={openAsset}
                    />
                    <LedgerCharts
                      summary={summary}
                      buildings={data.buildings}
                      overview={!building}
                      onBuilding={selectBuilding}
                      onSelect={openSelection}
                    />
                  </>
                ) : null}
                <Card data-slot="card" className="equipment-ledger-ledger">
                  <CardHeader data-slot="card-header">
                    <CardTitle data-slot="card-title">
                      {building ? `${building} · 设备清单` : '设备清单'}
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        openSelection({
                          title: '集合记录',
                          query: { kind: 'collection' },
                        })
                      }
                    >
                      集合记录 {summary.metrics.collections}
                    </Button>
                  </CardHeader>
                  <CardContent data-slot="card-content">
                    <div className="equipment-ledger-filters">
                      <label>
                        <span className="sr-only">设备种类</span>
                        <NativeSelect
                          aria-label="设备种类"
                          value={filters.family || ''}
                          onChange={(event) =>
                            changeFilter('family', event.target.value)
                          }
                        >
                          <NativeSelectOption value="">
                            全部种类
                          </NativeSelectOption>
                          {summary.families.map((item) => (
                            <NativeSelectOption
                              key={item.name}
                              value={item.name}
                            >
                              {item.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </label>
                      <label>
                        <span className="sr-only">维保状态</span>
                        <NativeSelect
                          aria-label="维保状态"
                          value={filters.warranty || ''}
                          onChange={(event) =>
                            changeFilter('warranty', event.target.value)
                          }
                        >
                          <NativeSelectOption value="">
                            全部状态
                          </NativeSelectOption>
                          {['在保', '过保', '待确认'].map((value) => (
                            <NativeSelectOption key={value} value={value}>
                              {value}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </label>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setFilters({});
                          setSearch('');
                        }}
                      >
                        重置
                      </Button>
                    </div>
                    <LedgerList
                      cache={cache}
                      snapshotId={data.snapshotId}
                      query={query}
                      onQueryChange={(next) =>
                        setFilters((current) => ({
                          ...current,
                          page: next.page,
                        }))
                      }
                      onAsset={openAsset}
                      onSnapshotChange={dashboard.reconcile}
                    />
                  </CardContent>
                </Card>
                <LedgerDrilldown
                  selection={selection}
                  summary={drillSummary || summary}
                  cache={cache}
                  snapshotId={data.snapshotId}
                  onChange={setSelection}
                  onAsset={openAsset}
                  onSnapshotChange={dashboard.reconcile}
                  onRestoreFocus={() =>
                    selectionFocus.current?.focus({ preventScroll: true })
                  }
                />
              </>
            ) : null}
          </>
        ) : (
          <Suspense
            fallback={
              <p role="status" className="equipment-ledger-loading">
                正在加载生命周期…
              </p>
            }
          >
            <LifecycleDashboard
              key={building || 'global'}
              embedded
              loader={lifecycleLoader}
            />
          </Suspense>
        )}
      </div>
      <AssetDetail
        historyCache={cache}
        historySnapshotId={
          data ? `${data.snapshotId}:${data.stale ? 'stale' : 'fresh'}` : ''
        }
        asset={refreshedAsset.data?.items[0] || asset}
        detailLoading={refreshedAsset.loading}
        detailError={
          refreshedAsset.error ||
          (refreshedAsset.data && !refreshedAsset.data.items.length
            ? '该设备已不在当前台账中'
            : '')
        }
        onDetailRetry={refreshedAsset.retry}
        lifecycle={lifecycle.data}
        lifecycleLoading={lifecycle.loading}
        lifecycleError={lifecycle.error}
        onRetry={lifecycle.retry}
        onClose={() => setAsset(null)}
        onRestoreFocus={() =>
          assetFocus.current?.focus({ preventScroll: true })
        }
      />
    </main>
  );
}
