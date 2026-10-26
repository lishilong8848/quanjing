import {
  useCallback,
  useEffect,
  useMemo,
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
  Loader2,
  PackageSearch,
  Warehouse,
  X,
  type LucideIcon,
} from 'lucide-react';

import { getInventoryManagementItems } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type {
  InventoryBuildingSummary,
  InventoryCategorySummary,
  InventoryItemsResponse,
  InventoryManagementDashboard,
  InventoryManagementItem,
  InventoryRiskFilter,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';

export type InventoryDetailMetric = 'categories' | 'quantity' | 'value' | 'risk';

export type InventoryDetailSelection =
  | { kind: 'metric'; metric: InventoryDetailMetric }
  | { kind: 'building'; building: WarehouseBuilding };

interface InventoryDetailDialogProps {
  dashboard: InventoryManagementDashboard;
  selection: InventoryDetailSelection | null;
  onOpenChange: (open: boolean) => void;
}

const PAGE_SIZE = 20;
const EMPTY_ITEMS: InventoryItemsResponse = {
  items: [],
  categories: [],
  total: 0,
  page: 1,
  pageSize: PAGE_SIZE,
  totalPages: 1,
};

const metricMeta: Record<
  InventoryDetailMetric,
  { title: string; description: string; icon: LucideIcon }
> = {
  categories: {
    title: '库存品类详情',
    description: '按一级分类查看 SKU、数量、价值和低库存分布',
    icon: Boxes,
  },
  quantity: {
    title: '库存总量详情',
    description: '查看七楼栋库存数量和配置情况',
    icon: Warehouse,
  },
  value: {
    title: '库存价值详情',
    description: '按一级分类查看库存价值构成',
    icon: CircleDollarSign,
  },
  risk: {
    title: '风险库存详情',
    description: '查看低库存、负库存和长期未用物品',
    icon: AlertTriangle,
  },
};

const riskTabs: Array<{ value: Exclude<InventoryRiskFilter, 'all'>; label: string }> = [
  { value: 'low', label: '低库存' },
  { value: 'negative', label: '负库存' },
  { value: 'idle', label: '长期未用' },
];

export function InventoryDetailDialog({
  dashboard,
  selection,
  onOpenChange,
}: InventoryDetailDialogProps) {
  const [riskTab, setRiskTab] =
    useState<Exclude<InventoryRiskFilter, 'all'>>('low');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<InventoryItemsResponse>(EMPTY_ITEMS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const selectionKey = selection
    ? selection.kind === 'metric'
      ? `metric:${selection.metric}`
      : `building:${selection.building}`
    : '';
  const needsItems =
    selection?.kind === 'building' ||
    (selection?.kind === 'metric' && selection.metric === 'risk');

  useEffect(() => {
    setRiskTab('low');
    setPage(1);
    setItems(EMPTY_ITEMS);
    setError('');
  }, [selectionKey]);

  useEffect(() => {
    if (!selection) requestRef.current += 1;
  }, [selection]);

  const loadItems = useCallback(
    async (forceRefresh = false) => {
      if (!selection || !needsItems) return;
      const requestId = ++requestRef.current;
      setLoading(true);
      try {
        const response = await getInventoryManagementItems(
          {
            page,
            pageSize: PAGE_SIZE,
            building: selection.kind === 'building' ? selection.building : 'all',
            risk: selection.kind === 'metric' ? riskTab : 'all',
            sort: 'risk',
          },
          forceRefresh,
        );
        if (requestRef.current !== requestId) return;
        setItems(response);
        setError('');
      } catch {
        if (requestRef.current !== requestId) return;
        setError('库存明细读取失败，请检查网络后重试。');
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    }, [needsItems, page, riskTab, selection],
  );

  useEffect(() => {
    if (needsItems) void loadItems();
  }, [loadItems, needsItems]);

  const meta = useMemo(() => {
    if (!selection) return metricMeta.categories;
    if (selection.kind === 'metric') return metricMeta[selection.metric];
    return {
      title: `${selection.building}库存详情`,
      description: '查看楼栋库存摘要、负责人和物品明细',
      icon: Warehouse,
    };
  }, [selection]);
  const Icon = meta.icon;

  return (
    <Dialog open={Boolean(selection)} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        style={{ transform: 'none', translate: 'none' }}
        className="fixed inset-0 !left-0 !top-0 flex h-[100dvh] w-screen max-w-none items-center justify-center border-0 bg-slate-950/45 p-2 shadow-none !animate-none sm:p-4"
      >
        <div className="grid max-h-[calc(100dvh-1rem)] w-[min(1180px,100%)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-slate-200 bg-[#f4f7fc] shadow-2xl sm:max-h-[calc(100dvh-2rem)]">
          <header className="flex items-center justify-between gap-4 bg-gradient-to-r from-[#064fc5] via-[#003f9f] to-[#012a7d] px-4 py-4 text-white sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/15">
                <Icon className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="truncate text-lg font-bold sm:text-xl">
                  {meta.title}
                </DialogTitle>
                <DialogDescription className="mt-1 truncate text-xs text-blue-100 sm:text-sm">
                  {meta.description}
                </DialogDescription>
              </div>
            </div>
            <button
              type="button"
              aria-label="关闭库存详情"
              title="关闭"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="min-w-0 overflow-y-auto p-3 sm:p-5">
            {selection ? (
              <DetailBody
                dashboard={dashboard}
                selection={selection}
                riskTab={riskTab}
                items={items}
                loading={loading}
                error={error}
                onRiskChange={(value) => {
                  setRiskTab(value);
                  setPage(1);
                }}
                onPageChange={setPage}
                onRetry={() => void loadItems(true)}
              />
            ) : null}
          </div>

          <footer className="flex items-center justify-end border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailBody(props: {
  dashboard: InventoryManagementDashboard;
  selection: InventoryDetailSelection;
  riskTab: Exclude<InventoryRiskFilter, 'all'>;
  items: InventoryItemsResponse;
  loading: boolean;
  error: string;
  onRiskChange: (value: Exclude<InventoryRiskFilter, 'all'>) => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}) {
  if (props.selection.kind === 'building') {
    const building = props.selection.building;
    const summary = props.dashboard.buildings.find(
      (item) => item.building === building,
    );
    return (
      <BuildingDetail
        summary={summary}
        items={props.items}
        loading={props.loading}
        error={props.error}
        onPageChange={props.onPageChange}
        onRetry={props.onRetry}
      />
    );
  }

  switch (props.selection.metric) {
    case 'categories':
      return <CategoryDetail dashboard={props.dashboard} />;
    case 'quantity':
      return <QuantityDetail dashboard={props.dashboard} />;
    case 'value':
      return <ValueDetail dashboard={props.dashboard} />;
    case 'risk':
      return (
        <RiskDetail
          dashboard={props.dashboard}
          riskTab={props.riskTab}
          items={props.items}
          loading={props.loading}
          error={props.error}
          onRiskChange={props.onRiskChange}
          onPageChange={props.onPageChange}
          onRetry={props.onRetry}
        />
      );
  }
}

function CategoryDetail({ dashboard }: { dashboard: InventoryManagementDashboard }) {
  return (
    <div className="space-y-4">
      <SummaryGrid>
        <SummaryCard label="库存记录" value={formatNumber(dashboard.summary.inventoryLines)} />
        <SummaryCard label="SKU 品类" value={formatNumber(dashboard.summary.distinctSkus)} />
        <SummaryCard label="一级分类" value={formatNumber(dashboard.categories.length)} />
        <SummaryCard label="低库存项" value={formatNumber(dashboard.summary.lowStockItems)} tone="danger" />
      </SummaryGrid>
      <CategoryTable categories={dashboard.categories} showValue />
    </div>
  );
}

function QuantityDetail({ dashboard }: { dashboard: InventoryManagementDashboard }) {
  const assignedLines = Math.max(
    0,
    dashboard.summary.inventoryLines - dashboard.summary.unassignedInventoryLines,
  );
  return (
    <div className="space-y-4">
      <SummaryGrid>
        <SummaryCard label="库存总量" value={formatNumber(dashboard.summary.totalQuantity)} />
        <SummaryCard label="库存记录" value={formatNumber(dashboard.summary.inventoryLines)} />
        <SummaryCard label="已配置楼栋" value={formatNumber(assignedLines)} tone="success" />
        <SummaryCard label="待配置楼栋" value={formatNumber(dashboard.summary.unassignedInventoryLines)} tone="warning" />
      </SummaryGrid>
      <BuildingTable buildings={dashboard.buildings} />
    </div>
  );
}

function ValueDetail({ dashboard }: { dashboard: InventoryManagementDashboard }) {
  const pricedCategories = [...dashboard.categories]
    .filter((item) => item.inventoryValue > 0)
    .sort((a, b) => b.inventoryValue - a.inventoryValue);
  return (
    <div className="space-y-4">
      <SummaryGrid>
        <SummaryCard label="库存总价值" value={formatCurrency(dashboard.summary.inventoryValue)} />
        <SummaryCard label="已计价分类" value={formatNumber(pricedCategories.length)} />
        <SummaryCard label="全部一级分类" value={formatNumber(dashboard.categories.length)} />
      </SummaryGrid>
      {pricedCategories.length ? (
        <CategoryTable categories={pricedCategories} showValue />
      ) : (
        <DetailEmpty title="暂无库存价值明细" detail="物资价格数据完善后将在这里展示分类价值构成。" />
      )}
    </div>
  );
}

function RiskDetail(props: {
  dashboard: InventoryManagementDashboard;
  riskTab: Exclude<InventoryRiskFilter, 'all'>;
  items: InventoryItemsResponse;
  loading: boolean;
  error: string;
  onRiskChange: (value: Exclude<InventoryRiskFilter, 'all'>) => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-4">
      <SummaryGrid>
        <SummaryCard label="低库存" value={formatNumber(props.dashboard.summary.lowStockItems)} tone="danger" />
        <SummaryCard label="负库存" value={formatNumber(props.dashboard.summary.negativeStockItems)} tone="danger" />
        <SummaryCard label="长期未用" value={formatNumber(props.dashboard.summary.idleItems)} tone="warning" />
        <SummaryCard label="待确认" value={formatNumber(props.dashboard.summary.pendingConfirmationItems)} />
      </SummaryGrid>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="风险类型">
        {riskTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={props.riskTab === tab.value}
            onClick={() => props.onRiskChange(tab.value)}
            className={cn(
              'rounded-lg border px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
              props.riskTab === tab.value
                ? 'border-blue-500 bg-blue-600 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <ItemsPanel {...props} />
    </div>
  );
}

function BuildingDetail(props: {
  summary?: InventoryBuildingSummary;
  items: InventoryItemsResponse;
  loading: boolean;
  error: string;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}) {
  const summary = props.summary;
  if (!summary) {
    return <DetailEmpty title="楼栋汇总暂不可用" detail="请刷新库存驾驶舱后重试。" />;
  }
  return (
    <div className="space-y-4">
      <SummaryGrid>
        <SummaryCard label="SKU 品类" value={formatNumber(summary.distinctSkus)} />
        <SummaryCard label="库存数量" value={formatNumber(summary.totalQuantity)} />
        <SummaryCard label="库存价值" value={formatCurrency(summary.inventoryValue)} />
        <SummaryCard label="低库存" value={formatNumber(summary.lowStockItems)} tone="danger" />
        <SummaryCard label="负库存" value={formatNumber(summary.negativeStockItems)} tone="danger" />
        <SummaryCard label="长期未用" value={formatNumber(summary.idleItems)} tone="warning" />
      </SummaryGrid>
      <div className="rounded-xl border border-[#d8e5f7] bg-white px-4 py-3 text-sm text-slate-600">
        <span className="font-semibold text-slate-900">楼栋负责人：</span>
        {summary.owners.join('、') || '待配置'}
      </div>
      <ItemsPanel {...props} />
    </div>
  );
}

function ItemsPanel(props: {
  items: InventoryItemsResponse;
  loading: boolean;
  error: string;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}) {
  if (props.error) {
    return <DetailError message={props.error} onRetry={props.onRetry} />;
  }
  if (props.loading) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-xl border border-[#d8e5f7] bg-white text-sm text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-600" />
        正在读取库存明细
      </div>
    );
  }
  if (!props.items.items.length) {
    return <DetailEmpty title="暂无匹配的库存明细" detail="当前条件下没有库存记录。" />;
  }
  return (
    <section className="overflow-hidden rounded-xl border border-[#d8e5f7] bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <PackageSearch className="h-4 w-4 text-blue-600" />
          库存明细
        </h3>
        <Badge className="border-blue-100 bg-blue-50 text-blue-700">
          {formatNumber(props.items.total)} 条
        </Badge>
      </div>
      <DetailItemsTable items={props.items.items} />
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
        <span>
          第 {props.items.page} / {props.items.totalPages} 页
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={props.items.page <= 1}
            onClick={() => props.onPageChange(props.items.page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={props.items.page >= props.items.totalPages}
            onClick={() => props.onPageChange(props.items.page + 1)}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function DetailItemsTable({ items }: { items: InventoryManagementItem[] }) {
  return (
    <>
      <div className="hidden max-w-full overflow-x-auto md:block">
        <table className="w-full min-w-[900px] border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
            <tr>
              <th className="px-4 py-3">物品 / SKU</th>
              <th className="px-4 py-3">分类</th>
              <th className="px-4 py-3">楼栋 / 库位</th>
              <th className="px-4 py-3 text-right">剩余 / 最小</th>
              <th className="px-4 py-3 text-right">价值</th>
              <th className="px-4 py-3">状态</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.recordId} className="border-t border-slate-100">
                <td className="max-w-60 px-4 py-3">
                  <strong className="block truncate text-slate-900" title={item.name}>
                    {item.name}
                  </strong>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.sku || '类别号待配置'} · {item.specification || '规格待补充'}
                  </span>
                </td>
                <td className="max-w-44 px-4 py-3 text-slate-600">
                  <span className="block truncate">{item.primaryCategory}</span>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.secondaryCategory || '未细分'}
                  </span>
                </td>
                <td className="max-w-44 px-4 py-3 text-slate-600">
                  <span className="block truncate">{item.building}</span>
                  <span className="mt-1 block truncate text-xs text-slate-400">
                    {item.location || '库位待配置'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <strong className={item.negativeStock ? 'text-rose-700' : 'text-slate-900'}>
                    {formatNumber(item.quantity)}
                  </strong>
                  <span className="block text-xs text-slate-400">
                    最小 {formatNumber(item.minimumQuantity)} {item.unit}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                  {formatCurrency(item.value)}
                </td>
                <td className="px-4 py-3">
                  <RiskBadges item={item} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 p-3 md:hidden">
        {items.map((item) => (
          <article key={item.recordId} className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-slate-900">{item.name}</h4>
                <p className="mt-1 truncate text-xs text-slate-400">
                  {item.sku || '类别号待配置'} · {item.building} · {item.location || '库位待配置'}
                </p>
              </div>
              <strong className={cn('shrink-0 tabular-nums', item.negativeStock ? 'text-rose-700' : 'text-slate-900')}>
                {formatNumber(item.quantity)} {item.unit}
              </strong>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <RiskBadges item={item} />
              <span className="text-xs tabular-nums text-slate-500">{formatCurrency(item.value)}</span>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function CategoryTable({
  categories,
  showValue,
}: {
  categories: InventoryCategorySummary[];
  showValue: boolean;
}) {
  if (!categories.length) {
    return <DetailEmpty title="暂无分类汇总" detail="库存分类数据同步后将在这里展示。" />;
  }
  return (
    <div className="max-w-full overflow-x-auto rounded-xl border border-[#d8e5f7] bg-white">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
          <tr>
            <th className="px-4 py-3">一级分类</th>
            <th className="px-4 py-3 text-right">SKU</th>
            <th className="px-4 py-3 text-right">库存记录</th>
            <th className="px-4 py-3 text-right">库存数量</th>
            {showValue && <th className="px-4 py-3 text-right">库存价值</th>}
            <th className="px-4 py-3 text-right">低库存</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((item) => (
            <tr key={item.category} className="border-t border-slate-100">
              <td className="px-4 py-3 font-semibold text-slate-900">{item.category}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(item.distinctSkus)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(item.inventoryLines)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(item.totalQuantity)}</td>
              {showValue && <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(item.inventoryValue)}</td>}
              <td className="px-4 py-3 text-right tabular-nums text-rose-700">{formatNumber(item.lowStockItems)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BuildingTable({ buildings }: { buildings: InventoryBuildingSummary[] }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-xl border border-[#d8e5f7] bg-white">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
          <tr>
            <th className="px-4 py-3">楼栋</th>
            <th className="px-4 py-3 text-right">SKU</th>
            <th className="px-4 py-3 text-right">库存记录</th>
            <th className="px-4 py-3 text-right">库存数量</th>
            <th className="px-4 py-3 text-right">库存价值</th>
            <th className="px-4 py-3 text-right">预警</th>
            <th className="px-4 py-3">负责人</th>
          </tr>
        </thead>
        <tbody>
          {buildings.map((item) => (
            <tr key={item.building} className="border-t border-slate-100">
              <td className="px-4 py-3 font-bold text-blue-700">{item.building}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(item.distinctSkus)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(item.inventoryLines)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatNumber(item.totalQuantity)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(item.inventoryValue)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-rose-700">{formatNumber(item.lowStockItems)}</td>
              <td className="max-w-56 px-4 py-3 text-slate-600">
                <span className="block truncate">{item.owners.join('、') || '待配置'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryGrid({ children }: { children: ReactNode }) {
  return <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</section>;
}

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className="rounded-xl border border-[#d8e5f7] bg-white p-4 shadow-[0_5px_16px_rgba(27,75,143,0.06)]">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <strong
        className={cn(
          'mt-1 block text-xl font-bold tabular-nums text-slate-950',
          tone === 'success' && 'text-emerald-700',
          tone === 'warning' && 'text-amber-700',
          tone === 'danger' && 'text-rose-700',
        )}
      >
        {value}
      </strong>
    </div>
  );
}

function RiskBadges({ item }: { item: InventoryManagementItem }) {
  const badges = [
    item.negativeStock ? '负库存' : '',
    item.lowStock ? '低库存' : '',
    item.idle ? '长期未用' : '',
    item.pendingConfirmation ? '待确认' : '',
  ].filter(Boolean);
  if (!badges.length) {
    return <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />正常</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((label) => (
        <Badge key={label} className={cn('text-[11px]', label === '长期未用' ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-rose-100 bg-rose-50 text-rose-700')}>
          {label}
        </Badge>
      ))}
    </span>
  );
}

function DetailError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-rose-200 bg-rose-50 p-6 text-center">
      <AlertCircle className="h-8 w-8 text-rose-500" />
      <p className="mt-3 text-sm text-rose-800">{message}</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        重新加载
      </Button>
    </div>
  );
}

function DetailEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-[#bdd2f4] bg-white/75 p-6 text-center">
      <PackageSearch className="h-9 w-9 text-blue-300" />
      <h3 className="mt-3 text-sm font-semibold text-slate-800">{title}</h3>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}
