import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Database,
  PackageCheck,
  RotateCcw,
  Search,
  Store,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type {
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
} from '@shared/purchase-inventory.interface';

import {
  buildPurchaseCompletionAnalysis,
  filterCompletedPurchaseItems,
  type PurchaseCompletionDimension,
  type PurchaseCompletionDateRange,
} from './completion-analysis.logic';
import {
  groupPurchaseOrderItems,
  prunePurchaseSelection,
  toggleVisiblePurchaseSelection,
} from './logic';

interface PurchaseCompletionAnalysisDialogProps {
  open: boolean;
  dashboard: PurchaseInventoryResponse | null;
  canDelete: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleteSelected: (items: PurchaseInventoryRequestItem[]) => void;
}

const EMPTY_REQUESTS: PurchaseInventoryRequestItem[] = [];
const COMPLETED_GROUPS_PAGE_SIZE = 10;

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactCurrency(value: number): string {
  if (Math.abs(value) >= 10_000) return `¥${(value / 10_000).toFixed(1)}万`;
  return `¥${Math.round(value).toLocaleString('zh-CN')}`;
}

function formatDate(value: string | null): string {
  if (!value) return '日期未填写';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未填写';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatUpdatedAt(value: string | undefined): string {
  if (!value) return '数据时间待同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '数据时间待同步';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatQuantity(item: PurchaseInventoryRequestItem): string {
  const quantity = item.actualQuantity ?? item.quantity;
  return `${quantity.toLocaleString('zh-CN')} ${item.unit || '件'}`;
}

function uniqueCompletedValues(
  items: PurchaseInventoryRequestItem[],
  getValue: (item: PurchaseInventoryRequestItem) => string,
): string[] {
  return Array.from(
    new Set(items.map(getValue).map((value) => value.trim()).filter(Boolean)),
  ).sort((first, second) => first.localeCompare(second, 'zh-CN'));
}

export function PurchaseCompletionAnalysisDialog({
  open,
  dashboard,
  canDelete,
  onOpenChange,
  onDeleteSelected,
}: PurchaseCompletionAnalysisDialogProps) {
  const year = new Date().getFullYear();
  const analysis = useMemo(
    () =>
      buildPurchaseCompletionAnalysis(
        dashboard?.requests ?? EMPTY_REQUESTS,
        dashboard?.summary.totalRequests ?? 0,
        year,
      ),
    [dashboard, year],
  );

  const kpis: Array<{
    label: string;
    value: string;
    detail: string;
    icon: LucideIcon;
    tone: string;
  }> = [
    {
      label: '累计完成',
      value: analysis.completedCount.toLocaleString('zh-CN'),
      detail: `流程完成率 ${analysis.completionRate}%`,
      icon: PackageCheck,
      tone: 'bg-emerald-500 text-white shadow-emerald-200',
    },
    {
      label: `${year} 年完成`,
      value: analysis.yearCompletedCount.toLocaleString('zh-CN'),
      detail: `已归集 ${analysis.datedCount} 条有效日期`,
      icon: ClipboardCheck,
      tone: 'bg-blue-500 text-white shadow-blue-200',
    },
    {
      label: '本年采购金额',
      value: formatCurrency(analysis.yearAmount),
      detail: '实际金额优先，预计金额补充',
      icon: CircleDollarSign,
      tone: 'bg-orange-500 text-white shadow-orange-200',
    },
    {
      label: '单均采购额',
      value: formatCurrency(analysis.averageAmount),
      detail: `${year} 年完成采购均值`,
      icon: BarChart3,
      tone: 'bg-cyan-500 text-white shadow-cyan-200',
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        style={{ transform: 'translate(-50%, -50%)', translate: 'none' }}
        className="h-[94vh] w-[min(97vw,1680px)] max-w-none min-w-0 !animate-none grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-slate-200 bg-[#f4f7fc] p-0 max-sm:!h-screen max-sm:w-screen max-sm:max-w-none max-sm:rounded-none"
      >
        <header className="flex items-center justify-between gap-4 bg-[#0c49b8] px-5 py-4 text-white sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/15">
              <CheckCircle2 className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg font-bold sm:text-xl">
                采购完成分析
              </DialogTitle>
              <DialogDescription className="mt-1 truncate text-xs text-blue-100">
                {year} 年采购完成情况 · 数据更新时间{' '}
                {formatUpdatedAt(dashboard?.generatedAt)}
              </DialogDescription>
            </div>
          </div>
          <DialogClose asChild>
            <button
              type="button"
              title="关闭分析"
              aria-label="关闭分析"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              <X className="h-4 w-4" />
            </button>
          </DialogClose>
        </header>

        <div className="min-w-0 w-full overflow-y-auto">
          {analysis.completedCount ? (
            <main className="space-y-5 p-4 sm:p-5 lg:p-6">
              <section
                aria-label="采购完成核心指标"
                className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
              >
                {kpis.map((kpi) => {
                  const Icon = kpi.icon;
                  return (
                    <article
                      key={kpi.label}
                      className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 shadow-[0_4px_16px_rgba(42,68,112,0.06)]"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={cn(
                            'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-md',
                            kpi.tone,
                          )}
                        >
                          <Icon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-500">
                            {kpi.label}
                          </p>
                          <p
                            className="mt-1 truncate text-2xl font-bold tabular-nums text-slate-950"
                            title={kpi.value}
                          >
                            {kpi.value}
                          </p>
                          <p className="mt-1 truncate text-xs text-slate-400">
                            {kpi.detail}
                          </p>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </section>

              <AnalysisPanel
                title="本年月度采购趋势"
                subtitle={`${year} 年 1-12 月完成数量与采购金额`}
                action={
                  <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-600">
                    月度归集 {analysis.yearCompletedCount} 条
                  </span>
                }
              >
                <div className="mt-4 h-[320px] w-full sm:h-[360px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={analysis.monthly}
                      margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid stroke="#e7edf6" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: '#64748b', fontSize: 12 }}
                      />
                      <YAxis
                        yAxisId="count"
                        allowDecimals={false}
                        tick={{ fill: '#64748b', fontSize: 12 }}
                      />
                      <YAxis
                        yAxisId="amount"
                        orientation="right"
                        tickFormatter={formatCompactCurrency}
                        tick={{ fill: '#64748b', fontSize: 12 }}
                      />
                      <Tooltip
                        formatter={(value, name) => [
                          name === '采购金额'
                            ? formatCurrency(Number(value))
                            : `${Number(value)} 项`,
                          name,
                        ]}
                        contentStyle={{
                          borderRadius: 8,
                          borderColor: '#dbe5f2',
                          boxShadow: '0 8px 24px rgba(42,68,112,0.12)',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar
                        yAxisId="count"
                        dataKey="count"
                        name="完成数量"
                        fill="#2F6BFF"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={30}
                      />
                      <Line
                        yAxisId="amount"
                        type="monotone"
                        dataKey="amount"
                        name="采购金额"
                        stroke="#F97316"
                        strokeWidth={2.5}
                        dot={{ r: 3, fill: '#ffffff', strokeWidth: 2 }}
                        activeDot={{ r: 5 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>有效日期 {analysis.datedCount} 条</span>
                  <span>日期缺失 {analysis.undatedCount} 条</span>
                  <span>无日期记录不进入月度趋势</span>
                </div>
              </AnalysisPanel>

              <section className="grid gap-5 xl:grid-cols-2">
                <RankingChart
                  title="完成采购分类分析"
                  subtitle="按累计完成数量排序 · Top 6"
                  icon={Database}
                  data={analysis.categoryRanking.slice(0, 6)}
                  color="#2F6BFF"
                />
                <RankingChart
                  title="楼栋采购分布"
                  subtitle="按累计完成数量排序 · Top 6"
                  icon={Building2}
                  data={analysis.buildingRanking.slice(0, 6)}
                  color="#06B6D4"
                />
              </section>

              <AnalysisPanel
                title="供应商采购排行"
                subtitle="按累计采购金额排序 · Top 8"
                action={<Store className="h-4 w-4 text-orange-500" />}
              >
                <div className="mt-3 divide-y divide-slate-100">
                  {analysis.supplierRanking.slice(0, 8).map((item, index) => (
                    <div
                      key={item.label}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3"
                    >
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-orange-50 text-xs font-bold text-orange-600">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">
                          {item.label}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-xs text-slate-400">
                            {item.count} 次 · {item.share}%
                          </span>
                          <span className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <span
                              className="block h-full rounded-full bg-orange-400"
                              style={{ width: `${Math.min(100, item.share)}%` }}
                            />
                          </span>
                        </div>
                      </div>
                      <strong className="whitespace-nowrap text-sm tabular-nums text-slate-800">
                        {formatCurrency(item.amount)}
                      </strong>
                    </div>
                  ))}
                </div>
              </AnalysisPanel>

              <CompletedPurchaseDetails
                items={analysis.completedItems}
                canDelete={canDelete}
                onDeleteSelected={onDeleteSelected}
              />
            </main>
          ) : (
            <div className="flex h-full min-h-[460px] flex-col items-center justify-center px-6 text-center">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-lg bg-emerald-50 text-emerald-500">
                <PackageCheck className="h-7 w-7" />
              </span>
              <h2 className="mt-4 text-base font-bold text-slate-800">
                暂无完成采购记录
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                完成采购数据同步后将在此展示年度分析
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AnalysisPanel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(42,68,112,0.05)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RankingChart({
  title,
  subtitle,
  icon: Icon,
  data,
  color,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  data: PurchaseCompletionDimension[];
  color: string;
}) {
  const chartHeight = Math.max(230, data.length * 42 + 50);
  return (
    <AnalysisPanel
      title={title}
      subtitle={subtitle}
      action={<Icon className="h-4 w-4" style={{ color }} />}
    >
      {data.length ? (
        <div className="mt-4 w-full" style={{ height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 20, bottom: 4, left: 16 }}
            >
              <CartesianGrid
                stroke="#e7edf6"
                strokeDasharray="3 3"
                horizontal={false}
              />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fill: '#64748b', fontSize: 11 }}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={112}
                tick={{ fill: '#475569', fontSize: 11 }}
              />
              <Tooltip
                formatter={(value) => [`${Number(value)} 项`, '完成数量']}
                contentStyle={{
                  borderRadius: 8,
                  borderColor: '#dbe5f2',
                  boxShadow: '0 8px 24px rgba(42,68,112,0.12)',
                }}
              />
              <Bar
                dataKey="count"
                fill={color}
                radius={[0, 4, 4, 0]}
                maxBarSize={20}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-4 flex min-h-52 items-center justify-center text-sm text-slate-400">
          暂无可分析数据
        </div>
      )}
    </AnalysisPanel>
  );
}

function CompletedPurchaseDetails({
  items,
  canDelete,
  onDeleteSelected,
}: {
  items: PurchaseInventoryRequestItem[];
  canDelete: boolean;
  onDeleteSelected: (items: PurchaseInventoryRequestItem[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [building, setBuilding] = useState('all');
  const [supplier, setSupplier] = useState('all');
  const [category, setCategory] = useState('all');
  const [dateRange, setDateRange] =
    useState<PurchaseCompletionDateRange>('all');
  const [page, setPage] = useState(1);
  const filterOptions = useMemo(
    () => ({
      buildings: uniqueCompletedValues(items, (item) => item.building),
      suppliers: uniqueCompletedValues(items, (item) => item.supplier),
      categories: uniqueCompletedValues(
        items,
        (item) => item.primaryCategory || item.secondaryCategory || '未分类',
      ),
    }),
    [items],
  );
  const filteredItems = useMemo(
    () =>
      filterCompletedPurchaseItems(items, {
        query,
        building,
        supplier,
        category,
        dateRange,
      }),
    [building, category, dateRange, items, query, supplier],
  );
  const filteredGroups = useMemo(
    () => groupPurchaseOrderItems(filteredItems),
    [filteredItems],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(filteredGroups.length / COMPLETED_GROUPS_PAGE_SIZE),
  );
  const visibleGroups = filteredGroups.slice(
    (page - 1) * COMPLETED_GROUPS_PAGE_SIZE,
    page * COMPLETED_GROUPS_PAGE_SIZE,
  );
  const visibleItems = visibleGroups.flatMap((group) => group.items);
  const selectedItems = filteredItems.filter((item) =>
    selectedIds.has(item.recordId),
  );
  const allSelected =
    visibleItems.length > 0 &&
    visibleItems.every((item) => selectedIds.has(item.recordId));
  const someSelected =
    visibleItems.some((item) => selectedIds.has(item.recordId)) && !allSelected;
  const hasFilters =
    Boolean(query.trim()) ||
    building !== 'all' ||
    supplier !== 'all' ||
    category !== 'all' ||
    dateRange !== 'all';

  useEffect(() => {
    setSelectedIds((current) =>
      prunePurchaseSelection(
        current,
        filteredItems.map((item) => item.recordId),
      ),
    );
  }, [filteredItems]);

  useEffect(() => {
    setPage(1);
  }, [building, category, dateRange, query, supplier]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    if (!canDelete) setSelectedIds(new Set());
  }, [canDelete]);

  function toggleItem(recordId: string, checked: boolean) {
    setSelectedIds((current) =>
      toggleVisiblePurchaseSelection(current, [recordId], checked),
    );
  }

  function toggleAll(checked: boolean) {
    setSelectedIds((current) =>
      toggleVisiblePurchaseSelection(
        current,
        visibleItems.map((item) => item.recordId),
        checked,
      ),
    );
  }

  function resetFilters() {
    setQuery('');
    setBuilding('all');
    setSupplier('all');
    setCategory('all');
    setDateRange('all');
  }

  return (
    <AnalysisPanel
      title="完成采购明细"
      subtitle="支持模糊搜索与多条件组合筛选 · 每页 10 单"
      action={
        <span className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-600">
          {filteredGroups.length} 单 · {filteredItems.length} 条
        </span>
      }
    >
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/80 p-3">
        <div className="grid gap-2 lg:grid-cols-[minmax(260px,1.7fr)_repeat(4,minmax(130px,1fr))_auto]">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              aria-label="模糊搜索完成采购明细"
              placeholder="模糊搜索采购单号、物资、人员或供应商"
              className="h-9 bg-white pl-9 text-sm"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <CompletionFilterSelect
            label="筛选楼栋"
            value={building}
            allLabel="全部楼栋"
            options={filterOptions.buildings}
            onChange={setBuilding}
          />
          <CompletionFilterSelect
            label="筛选供应商"
            value={supplier}
            allLabel="全部供应商"
            options={filterOptions.suppliers}
            onChange={setSupplier}
          />
          <CompletionFilterSelect
            label="筛选分类"
            value={category}
            allLabel="全部分类"
            options={filterOptions.categories}
            onChange={setCategory}
          />
          <Select
            value={dateRange}
            onValueChange={(value) =>
              setDateRange(value as PurchaseCompletionDateRange)
            }
          >
            <SelectTrigger
              aria-label="筛选完成日期"
              className="h-9 w-full bg-white text-xs"
            >
              <SelectValue placeholder="全部日期" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部日期</SelectItem>
              <SelectItem value="7d">近 7 天</SelectItem>
              <SelectItem value="30d">近 30 天</SelectItem>
              <SelectItem value="year">本年度</SelectItem>
            </SelectContent>
          </Select>
          <button
            type="button"
            disabled={!hasFilters}
            onClick={resetFilters}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:border-emerald-200 hover:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置
          </button>
        </div>
      </div>
      {canDelete && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            <Checkbox
                aria-label="选择本页完成采购记录"
              checked={
                allSelected ? true : someSelected ? 'indeterminate' : false
              }
              onCheckedChange={(checked) => toggleAll(checked === true)}
            />
            选择本页结果
          </label>
          {selectedItems.length > 0 ? (
            <button
              type="button"
              onClick={() => onDeleteSelected(selectedItems)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-rose-500 px-3 text-xs font-semibold text-white transition hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除所选（{selectedItems.length}）
            </button>
          ) : (
            <span className="text-xs text-slate-400">可单选或批量删除</span>
          )}
        </div>
      )}
      <div className="mt-4 hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1220px] border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
            <tr>
              {canDelete && (
                <th className="w-12 px-4 py-3 text-center">
                  <Checkbox
                    aria-label="选择全部完成采购记录"
                    checked={
                      allSelected
                        ? true
                        : someSelected
                          ? 'indeterminate'
                          : false
                    }
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                  />
                </th>
              )}
              <th className="px-4 py-3">采购单号</th>
              <th className="px-4 py-3">物资名称 / 分类</th>
              <th className="px-4 py-3">规格型号</th>
              <th className="px-4 py-3">楼栋</th>
              <th className="px-4 py-3">供应商</th>
              <th className="px-4 py-3 text-right">数量</th>
              <th className="px-4 py-3 text-right">采购金额</th>
              <th className="px-4 py-3">完成日期</th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.flatMap((group) =>
              group.items.map((item, itemIndex) => {
                const isFirstItem = itemIndex === 0;
                const rowSpan = group.items.length;

                return (
                  <tr
                    key={item.recordId}
                    className={cn(
                      'border-b border-slate-100 last:border-b-0 hover:bg-emerald-50/35',
                      canDelete &&
                        selectedIds.has(item.recordId) &&
                        'bg-rose-50/40',
                    )}
                  >
                    {canDelete && (
                      <td className="w-12 px-4 py-3.5 text-center">
                        <Checkbox
                          aria-label={`选择 ${item.requestCode || item.title}`}
                          checked={selectedIds.has(item.recordId)}
                          onCheckedChange={(checked) =>
                            toggleItem(item.recordId, checked === true)
                          }
                        />
                      </td>
                    )}
                    {isFirstItem && (
                      <td
                        rowSpan={rowSpan}
                        className="max-w-52 align-middle px-4 py-3.5 text-center"
                      >
                        <span className="block truncate font-semibold text-slate-800">
                          {group.requestCode || '待生成'}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {rowSpan} 项
                        </span>
                      </td>
                    )}
                    <td className="max-w-64 px-4 py-3.5">
                      <span className="block truncate font-medium text-slate-800">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-400">
                        {item.primaryCategory ||
                          item.secondaryCategory ||
                          '未分类'}
                      </span>
                    </td>
                    <td className="max-w-52 px-4 py-3.5 text-slate-600">
                      <span
                        className="block truncate"
                        title={item.specification || '未填写'}
                      >
                        {item.specification || '未填写'}
                      </span>
                    </td>
                    <td className="max-w-32 px-4 py-3.5 text-slate-600">
                      <span className="block truncate">
                        {item.building || '未填写'}
                      </span>
                    </td>
                    <td className="max-w-40 px-4 py-3.5 text-slate-600">
                      <span className="block truncate">
                        {item.supplier || '未填写'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-right font-semibold tabular-nums text-slate-700">
                      {formatQuantity(item)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                      {formatCurrency(
                        item.actualAmount ?? item.estimatedAmount,
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-slate-500">
                      {formatDate(item.receivedAt || item.createdAt)}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 md:hidden">
        {visibleGroups.map((group) => (
          <section
            key={group.requestCode || group.items[0]?.recordId}
            className="overflow-hidden rounded-lg border border-emerald-100 bg-emerald-50/35"
          >
            <div className="flex items-center justify-between gap-3 border-b border-emerald-100 bg-white px-4 py-3">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-slate-400">
                  采购单号
                </p>
                <p className="mt-0.5 truncate text-sm font-semibold text-slate-800">
                  {group.requestCode || '待生成'}
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-600">
                {group.items.length} 项
              </span>
            </div>
            <div className="grid gap-3 p-3">
              {group.items.map((item) => (
                <article
                  key={item.recordId}
                  className={cn(
                    'rounded-lg border bg-white p-4',
                    canDelete && selectedIds.has(item.recordId)
                      ? 'border-rose-200 ring-1 ring-rose-100'
                      : 'border-emerald-100',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      {canDelete && (
                        <Checkbox
                          className="mt-0.5"
                          aria-label={`选择 ${item.requestCode || item.title}`}
                          checked={selectedIds.has(item.recordId)}
                          onCheckedChange={(checked) =>
                            toggleItem(item.recordId, checked === true)
                          }
                        />
                      )}
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-slate-900">
                          {item.title}
                        </h3>
                      </div>
                    </div>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <DetailMeta
                      label="分类"
                      value={
                        item.primaryCategory ||
                        item.secondaryCategory ||
                        '未分类'
                      }
                    />
                    <DetailMeta
                      label="规格型号"
                      value={item.specification || '未填写'}
                    />
                    <DetailMeta
                      label="楼栋"
                      value={item.building || '未填写'}
                    />
                    <DetailMeta
                      label="供应商"
                      value={item.supplier || '未填写'}
                    />
                    <DetailMeta label="数量" value={formatQuantity(item)} />
                    <DetailMeta
                      label="采购金额"
                      value={formatCurrency(
                        item.actualAmount ?? item.estimatedAmount,
                      )}
                    />
                    <DetailMeta
                      label="完成日期"
                      value={formatDate(item.receivedAt || item.createdAt)}
                    />
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      {filteredGroups.length === 0 ? (
        <div className="mt-4 flex min-h-32 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 text-sm text-slate-400">
          没有符合当前搜索和筛选条件的采购记录
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <span className="text-xs text-slate-400">
            共 {filteredGroups.length} 单 · {filteredItems.length} 条
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="上一页完成采购明细"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-emerald-200 hover:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-14 text-center text-xs font-semibold text-slate-600">
              {page} / {pageCount}
            </span>
            <button
              type="button"
              aria-label="下一页完成采购明细"
              disabled={page >= pageCount}
              onClick={() =>
                setPage((current) => Math.min(pageCount, current + 1))
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-emerald-200 hover:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </AnalysisPanel>
  );
}

function CompletionFilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string;
  allLabel: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        className="h-9 w-full bg-white text-xs"
      >
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DetailMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="block text-slate-400">{label}</span>
      <span className="mt-1 block truncate font-medium text-slate-700">
        {value}
      </span>
    </div>
  );
}
