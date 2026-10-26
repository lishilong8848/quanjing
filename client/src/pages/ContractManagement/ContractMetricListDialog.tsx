import {
  AlertCircle,
  CalendarClock,
  CircleDollarSign,
  FileCheck2,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
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
import type {
  ContractManagementDashboard,
  ContractManagementItem,
  ContractPaymentItem,
  ContractStatus,
} from '@shared/contract-management.interface';

import {
  buildPendingPaymentAnalytics,
  filterContracts,
  type PendingPaymentAnalytics,
  type PendingPaymentAnalyticsSection,
} from './logic';

export type ContractMetricListKind =
  | 'execution'
  | 'expiring'
  | 'pendingPayment';

type MetricListMeta = {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  icon: LucideIcon;
  iconClass: string;
};

const metricListMeta: Record<ContractMetricListKind, MetricListMeta> = {
  execution: {
    title: '执行合同清单',
    description: '仅展示当前有效、正在执行及未来 60 天内到期的合同。',
    emptyTitle: '暂无执行合同',
    emptyDescription: '执行合同数据同步后将在此显示。',
    icon: FileCheck2,
    iconClass: 'bg-emerald-50 text-emerald-600',
  },
  expiring: {
    title: '即将到期合同清单',
    description: '展示未来 60 天内到期、需要跟进的执行合同。',
    emptyTitle: '暂无即将到期合同',
    emptyDescription: '当前没有需要在 60 天内跟进的执行合同。',
    icon: CalendarClock,
    iconClass: 'bg-amber-50 text-amber-600',
  },
  pendingPayment: {
    title: '付款执行分析',
    description: '按计划付款年度与是否逾期查看全部未结清付款计划。',
    emptyTitle: '暂无待付款计划',
    emptyDescription: '当前付款计划均已结清，或尚未同步付款数据。',
    icon: CircleDollarSign,
    iconClass: 'bg-rose-50 text-rose-600',
  },
};

export function ContractMetricListDialog({
  dashboard,
  kind,
  sourceIssue,
  onOpenChange,
}: {
  dashboard: ContractManagementDashboard;
  kind: ContractMetricListKind | null;
  sourceIssue: string | null;
  onOpenChange: (kind: ContractMetricListKind | null) => void;
}) {
  if (!kind) return null;

  const meta = metricListMeta[kind];
  const contracts =
    kind === 'execution'
      ? dashboard.contracts.filter(
          (item) =>
            item.status === 'active' || item.status === 'expiring',
        )
      : filterContracts(dashboard.contracts, 'expiring', '');
  const analytics = buildPendingPaymentAnalytics(dashboard.payments);
  const count =
    kind === 'pendingPayment'
      ? analytics.groups.reduce((total, group) => total + group.count, 0)
      : contracts.length;
  const Icon = meta.icon;

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(null)}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[92dvh] max-h-[92dvh] max-w-[1440px] flex-col gap-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 p-0"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${meta.iconClass}`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-bold text-slate-950 sm:text-lg">
                {meta.title}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5 text-slate-500 sm:text-sm">
                {meta.description}
              </DialogDescription>
            </div>
          </div>
          <DialogClose
            aria-label={`关闭${meta.title}`}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            <X className="h-4 w-4" />
          </DialogClose>
        </div>

        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3 sm:px-6">
          <p className="text-xs text-slate-500">
            当前显示{' '}
            <strong className="font-semibold text-slate-900">{count}</strong> 条
          </p>
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
            实时看板数据
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {sourceIssue ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">{meta.title}数据暂不可用</p>
                <p className="mt-1 text-xs leading-5">{sourceIssue}</p>
              </div>
            </div>
          ) : kind === 'pendingPayment' ? (
            <PaymentExecutionAnalysis analytics={analytics} meta={meta} />
          ) : (
            <ContractList items={contracts} meta={meta} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ContractList({
  items,
  meta,
}: {
  items: ContractManagementItem[];
  meta: MetricListMeta;
}) {
  if (!items.length) return <MetricListEmptyState meta={meta} />;

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[980px] table-fixed text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
          <tr>
            <th className="w-[26%] px-4 py-3">合同编号 / 名称</th>
            <th className="w-[18%] px-4 py-3">供应商 / 跟进人</th>
            <th className="w-[13%] px-4 py-3 text-right">合同金额</th>
            <th className="w-[18%] px-4 py-3">合同周期</th>
            <th className="w-[12%] px-4 py-3">付款性质</th>
            <th className="w-[13%] px-4 py-3">状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => (
            <tr key={item.recordId} className="align-top hover:bg-blue-50/30">
              <td className="px-4 py-3">
                <p className="font-semibold text-slate-900">
                  {item.code || '编号待补充'}
                </p>
                <p className="mt-1 break-words text-xs leading-5 text-slate-600">
                  {item.name || '未命名合同'}
                </p>
              </td>
              <td className="px-4 py-3 text-xs leading-5 text-slate-600">
                <p>{item.supplier || '供应商待补充'}</p>
                <p className="mt-1 text-slate-400">
                  {item.owner || '跟进人待分配'}
                </p>
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                {formatCurrency(item.amount)}
              </td>
              <td className="px-4 py-3 text-xs leading-5 text-slate-600">
                <p>{formatDate(item.startDate)}</p>
                <p className="text-slate-400">至 {formatDate(item.endDate)}</p>
              </td>
              <td className="px-4 py-3 text-xs text-slate-600">
                {item.paymentCycle || '待补充'}
              </td>
              <td className="px-4 py-3">
                <ContractStatusBadge status={item.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentExecutionAnalysis({
  analytics,
  meta,
}: {
  analytics: PendingPaymentAnalytics;
  meta: MetricListMeta;
}) {
  if (!analytics.groups.length) return <MetricListEmptyState meta={meta} />;

  const planCount = analytics.groups.reduce(
    (total, group) => total + group.count,
    0,
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <PaymentSummaryMetric
          label="未结清付款计划"
          value={`${formatNumber(planCount)} 笔`}
          tone="text-blue-700"
        />
        <PaymentSummaryMetric
          label="待付金额"
          value={formatCurrency(analytics.totalPendingAmount)}
          tone="text-rose-700"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <PaymentYearBarChart items={analytics.yearSummary} />
        <PaymentStatusDonut items={analytics.statusSummary} />
      </div>

      <div className="space-y-5">
        {analytics.groups.map((group) => (
          <section
            key={group.year}
            aria-labelledby={`payment-year-${group.year}`}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white"
          >
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <h3
                  id={`payment-year-${group.year}`}
                  className="font-bold text-slate-900"
                >
                  {group.year}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  按计划付款年度分组
                </p>
              </div>
              <span className="text-sm font-semibold tabular-nums text-slate-700">
                {formatNumber(group.count)} 笔 ·{' '}
                {formatCurrency(group.pendingAmount)}
              </span>
            </header>
            <div className="space-y-4 p-3 sm:p-4">
              {group.sections.map((section) => (
                <div key={section.status} className="space-y-2">
                  <PaymentGroupHeader section={section} />
                  <PaymentList items={section.items} meta={meta} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function PaymentSummaryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function PaymentYearBarChart({
  items,
}: {
  items: PendingPaymentAnalytics['yearSummary'];
}) {
  return (
    <section
      aria-label="按计划付款年度待付金额"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-bold text-slate-900">按计划付款年度</h3>
      <p className="mt-1 text-xs text-slate-500">未结清计划的待付金额</p>
      <div className="mt-3 h-56 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={items}
            margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              stroke="#e2e8f0"
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="year"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#64748b', fontSize: 11 }}
            />
            <YAxis
              width={64}
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#64748b', fontSize: 10 }}
              tickFormatter={formatCompactNumber}
            />
            <Tooltip content={<PaymentYearChartTooltip />} />
            <Bar
              dataKey="pendingAmount"
              name="待付金额"
              fill="#2563eb"
              radius={[6, 6, 0, 0]}
              maxBarSize={42}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PaymentYearChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    payload: PendingPaymentAnalytics['yearSummary'][number];
  }>;
}) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-slate-900">{item.year}</p>
      <p className="mt-1 text-slate-500">
        {formatNumber(item.count)} 笔 ·{' '}
        <strong className="tabular-nums text-blue-700">
          {formatCurrency(item.pendingAmount)}
        </strong>
      </p>
    </div>
  );
}

function PaymentStatusDonut({
  items,
}: {
  items: PendingPaymentAnalytics['statusSummary'];
}) {
  const totalCount = items.reduce((total, item) => total + item.count, 0);
  const colors = {
    overdue: '#e11d48',
    pending: '#2563eb',
  };
  return (
    <section
      aria-label="待付计划逾期结构"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-bold text-slate-900">逾期结构</h3>
      <p className="mt-1 text-xs text-slate-500">按已逾期与待付款拆分</p>
      <div className="mt-3 grid items-center gap-3 sm:grid-cols-[220px_1fr]">
        <div className="relative h-56 min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={items}
                dataKey="pendingAmount"
                nameKey="label"
                cx="50%"
                cy="50%"
                innerRadius={54}
                outerRadius={82}
                paddingAngle={2}
                stroke="none"
                isAnimationActive={false}
              >
                {items.map((item) => (
                  <Cell key={item.status} fill={colors[item.status]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <strong className="text-xl font-bold tabular-nums text-slate-950">
              {formatNumber(totalCount)}
            </strong>
            <span className="text-[11px] text-slate-500">未结清计划</span>
          </div>
        </div>
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.status}
              className="rounded-lg border border-slate-100 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: colors[item.status] }}
                  />
                  {item.label}
                </span>
                <span className="text-xs tabular-nums text-slate-500">
                  {formatNumber(item.count)} 笔
                </span>
              </div>
              <p className="mt-1 text-right text-sm font-bold tabular-nums text-slate-900">
                {formatCurrency(item.pendingAmount)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PaymentGroupHeader({
  section,
}: {
  section: PendingPaymentAnalyticsSection;
}) {
  const overdue = section.status === 'overdue';
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
        overdue
          ? 'border-rose-200 bg-rose-50 text-rose-700'
          : 'border-blue-200 bg-blue-50 text-blue-700'
      }`}
    >
      <strong>{section.label}</strong>
      <span className="tabular-nums">
        {formatNumber(section.count)} 笔 ·{' '}
        {formatCurrency(section.pendingAmount)}
      </span>
    </div>
  );
}

function PaymentList({
  items,
  meta,
}: {
  items: ContractPaymentItem[];
  meta: MetricListMeta;
}) {
  if (!items.length) return <MetricListEmptyState meta={meta} />;

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[920px] table-fixed text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
          <tr>
            <th className="w-[28%] px-4 py-3">合同编号 / 名称</th>
            <th className="w-[12%] px-4 py-3">付款期次</th>
            <th className="w-[16%] px-4 py-3">计划付款日期</th>
            <th className="w-[15%] px-4 py-3 text-right">计划金额</th>
            <th className="w-[15%] px-4 py-3 text-right">待付金额</th>
            <th className="w-[14%] px-4 py-3">付款状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => (
            <tr key={item.recordId} className="align-top hover:bg-blue-50/30">
              <td className="px-4 py-3">
                <p className="font-semibold text-slate-900">
                  {item.contractCode || '合同编号待补充'}
                </p>
                <p className="mt-1 break-words text-xs leading-5 text-slate-600">
                  {item.contractName || '未命名合同'}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {item.owner || '跟进人待分配'}
                </p>
              </td>
              <td className="px-4 py-3 text-xs text-slate-600">
                {item.cycle || item.label || '待补充'}
              </td>
              <td className="px-4 py-3 text-xs text-slate-600">
                {formatDate(item.dueDate)}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                {formatCurrency(item.plannedAmount)}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums text-rose-600">
                {formatCurrency(
                  Math.max(0, item.plannedAmount - item.actualAmount),
                )}
              </td>
              <td className="px-4 py-3 text-xs">
                <PaymentExecutionStatusBadge item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentExecutionStatusBadge({
  item,
}: {
  item: ContractPaymentItem;
}) {
  const overdue = item.daysUntilDue !== null && item.daysUntilDue < 0;
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 font-semibold ${
        overdue
          ? 'border-rose-200 bg-rose-50 text-rose-700'
          : 'border-blue-200 bg-blue-50 text-blue-700'
      }`}
    >
      {overdue ? '已逾期' : '待付款'}
    </span>
  );
}

function MetricListEmptyState({ meta }: { meta: MetricListMeta }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-blue-200 bg-white px-5 text-center">
      <p className="font-semibold text-slate-800">{meta.emptyTitle}</p>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
        {meta.emptyDescription}
      </p>
    </div>
  );
}

function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const statusMeta: Record<
    ContractStatus,
    { label: string; className: string }
  > = {
    active: {
      label: '履约中',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    },
    expiring: {
      label: '即将到期',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
    },
    expired: {
      label: '已失效',
      className: 'border-rose-200 bg-rose-50 text-rose-700',
    },
    pending: {
      label: '未生效',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
    },
    unknown: {
      label: '日期待补充',
      className: 'border-slate-200 bg-slate-50 text-slate-600',
    },
  };
  const item = statusMeta[status];

  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${item.className}`}
    >
      {item.label}
    </span>
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function formatDate(value: string | null): string {
  return value ? value.replace(/-/g, '/') : '待补充';
}
