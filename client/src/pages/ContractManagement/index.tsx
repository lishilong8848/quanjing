import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ChartPie,
  CircleDollarSign,
  CreditCard,
  Clock3,
  Eye,
  FileCheck2,
  FilePlus2,
  FileText,
  GitBranch,
  Loader2,
  PencilLine,
  ShieldAlert,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { useAccess } from '@/access/AccessProvider';
import {
  getContractCreateOptions,
  getContractManagementDashboard,
  getContractPaymentFollowUpOptions,
  markContractNoPaymentRequired,
} from '@/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  ContractManagementDashboard,
  ContractManagementItem,
  ContractPaymentFollowUpItem,
  ContractPaymentItem,
  ContractStatus,
} from '@shared/contract-management.interface';

import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import { ContractAttachmentViewer } from './ContractAttachmentViewer';
import { ContractQuickSearchResults } from './ContractQuickSearchResults';
import { ContractExpiryDispositionDialog } from './ContractExpiryDispositionDialog';
import { ContractCreationDialog } from './ContractCreationDialog';
import { ContractEditDialog } from './ContractEditDialog';
import {
  ContractMetricListDialog,
  type ContractMetricListKind,
} from './ContractMetricListDialog';
import { ContractPaymentFollowUpDialog } from './ContractPaymentFollowUpDialog';
import { getContractSourceIssue } from './contract-source-health';
import { SupplierDirectoryDialog } from './SupplierDirectoryDialog';
import {
  buildPaymentPlanMonthlyTrend,
  buildPaymentTrendChartItems,
  buildPaymentFollowUpTarget,
  filterContracts,
  findContractQuickSearchResults,
  findContractsWithoutPaymentPlans,
  getTopActiveContractsByAmount,
  paginateItems,
  partitionPaymentAttentionItems,
  sumActiveContractValue,
  type PaymentMonthlyTrendItem,
  type PaymentAttentionTab,
  type ContractStatusFilter,
} from './logic';
import {
  summarizeContractPaymentPeriods,
  type ContractPaymentPeriodSummary,
} from './payment-periods';
import { createLatestRequestCoordinator } from './latest-request';
import {
  applyNoPaymentRequired,
  rollbackNoPaymentRequired,
} from './payment-follow-up-optimistic';

const AUTO_REFRESH_MS = 4 * 60 * 60 * 1000;
const MISSING_PAYMENT_PLAN_PAGE_SIZE = 6;
const CHART_COLORS = [
  '#2563eb',
  '#06b6d4',
  '#f59e0b',
  '#10b981',
  '#f43f5e',
  '#8b5cf6',
];
const dialogOptionPrefetches = new Map<string, Promise<unknown>>();

function prefetchContractDialogOptions(
  dashboard: ContractManagementDashboard,
): void {
  const dialogContractIds = [
    ...new Set(
      [
        ...dashboard.contractRisks.map((item) => item.recordId),
        ...(dashboard.paymentFollowUps || []).map(
          (item) => item.contractRecordId,
        ),
      ]
        .map((recordId) => recordId.trim())
        .filter(Boolean),
    ),
  ].slice(0, 12);
  const requests = [
    prefetchDialogOption('create:framework', () =>
      getContractCreateOptions('framework'),
    ),
    prefetchDialogOption('create:execution', () =>
      getContractCreateOptions('execution'),
    ),
    ...dialogContractIds.map((recordId) =>
      prefetchDialogOption(`payment:${recordId}`, () =>
        getContractPaymentFollowUpOptions(recordId),
      ),
    ),
  ];
  void Promise.allSettled(requests);
}

function prefetchDialogOption(
  key: string,
  load: () => Promise<unknown>,
): Promise<unknown> {
  const existing = dialogOptionPrefetches.get(key);
  if (existing) return existing;
  const request = load().catch((error) => {
    dialogOptionPrefetches.delete(key);
    throw error;
  });
  dialogOptionPrefetches.set(key, request);
  return request;
}

const statusMeta: Record<ContractStatus, { label: string; className: string }> =
  {
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

const statusFilters: Array<{ key: ContractStatusFilter; label: string }> = [
  { key: 'all', label: '全部合同' },
  { key: 'active', label: '履约中' },
  { key: 'expiring', label: '即将到期' },
  { key: 'expired', label: '已失效' },
];

export function buildContractListDisplay(
  contracts: ContractManagementItem[],
  unsignedContracts: ContractManagementItem[],
  unsignedExpanded: boolean,
): {
  visibleContracts: ContractManagementItem[];
  hiddenUnsignedCount: number;
} {
  return {
    visibleContracts: unsignedExpanded
      ? [...contracts, ...unsignedContracts]
      : contracts,
    hiddenUnsignedCount: unsignedExpanded ? 0 : unsignedContracts.length,
  };
}

export default function ContractManagementPage() {
  const { capabilities } = useAccess();
  const canManageContracts = capabilities.canAccessContracts;
  const [dashboard, setDashboard] =
    useState<ContractManagementDashboard | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ContractStatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creationOpen, setCreationOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickViewerRequest, setQuickViewerRequest] = useState<{
    contract: ContractManagementItem;
  } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    recordId: string;
    requestId: number;
  } | null>(null);
  const dashboardRef = useRef<ContractManagementDashboard | null>(null);
  const hiddenNoPaymentRequiredRef = useRef(new Set<string>());
  const pendingNoPaymentRequiredRef = useRef(new Map<string, string>());
  const [requestCoordinator] = useState(createLatestRequestCoordinator);

  const loadDashboard = useCallback(
    async (forceRefresh = false) => {
      let refreshed = false;
      if (forceRefresh) setRefreshing(true);
      else if (!dashboardRef.current) setLoading(true);

      await requestCoordinator.run(
        getContractManagementDashboard(forceRefresh && capabilities.canForceRefresh),
        {
          onSuccess: (response) => {
            refreshed = true;
            let visibleResponse = response;
            for (const recordId of hiddenNoPaymentRequiredRef.current) {
              visibleResponse = applyNoPaymentRequired(
                visibleResponse,
                recordId,
              ).dashboard;
            }
            dashboardRef.current = visibleResponse;
            setDashboard(visibleResponse);
            setLoadError(null);
            if (canManageContracts) prefetchContractDialogOptions(response);
          },
          onError: () => {
            setLoadError('合同数据读取失败，请检查网络或飞书数据源后重试。');
          },
          onSettled: () => {
            setLoading(false);
            setRefreshing(false);
          },
        },
      );
      return refreshed;
    },
    [capabilities.canForceRefresh, canManageContracts, requestCoordinator],
  );

  const refreshDashboardAfterMutation = useCallback(() => {
    void loadDashboard(true).then(
      (refreshed) => {
        if (!refreshed) {
          toast.warning('操作已同步，但合同看板刷新失败，请手动刷新');
        }
      },
      () => {
        toast.warning('操作已同步，但合同看板刷新失败，请手动刷新');
      },
    );
  }, [loadDashboard]);

  const hideSubmittedContractRisk = useCallback((recordId: string) => {
    const current = dashboardRef.current;
    if (!current) return;
    const contractRisks = current.contractRisks.filter(
      (item) => item.recordId !== recordId,
    );
    if (contractRisks.length === current.contractRisks.length) return;
    const next = { ...current, contractRisks };
    dashboardRef.current = next;
    setDashboard(next);
  }, []);

  const handleNoPaymentRequired = useCallback(
    async (item: ContractPaymentFollowUpItem) => {
      const recordId = item.contractRecordId;
      if (pendingNoPaymentRequiredRef.current.has(recordId)) return;
      const current = dashboardRef.current;
      if (!current) return;

      const mutationId = createPaymentDispositionRequestId();
      const optimistic = applyNoPaymentRequired(current, recordId);
      hiddenNoPaymentRequiredRef.current.add(recordId);
      pendingNoPaymentRequiredRef.current.set(recordId, mutationId);
      dashboardRef.current = optimistic.dashboard;
      setDashboard(optimistic.dashboard);

      try {
        const response = await markContractNoPaymentRequired(recordId, {
          idempotencyKey: mutationId,
        });
        if (pendingNoPaymentRequiredRef.current.get(recordId) === mutationId) {
          toast.success(response.message);
        }
      } catch {
        if (pendingNoPaymentRequiredRef.current.get(recordId) === mutationId) {
          hiddenNoPaymentRequiredRef.current.delete(recordId);
          const latest = dashboardRef.current;
          if (latest) {
            const rolledBack = rollbackNoPaymentRequired(
              latest,
              optimistic.snapshot,
            );
            dashboardRef.current = rolledBack;
            setDashboard(rolledBack);
          }
          toast.error('无需付款同步失败，已恢复该合同卡片，请重试');
        }
      } finally {
        if (pendingNoPaymentRequiredRef.current.get(recordId) === mutationId) {
          pendingNoPaymentRequiredRef.current.delete(recordId);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadDashboard(false);
    const timer = window.setInterval(
      () => void loadDashboard(false),
      AUTO_REFRESH_MS,
    );
    return () => {
      window.clearInterval(timer);
      requestCoordinator.invalidate();
    };
  }, [loadDashboard, requestCoordinator]);

  const filteredContracts = useMemo(
    () =>
      filterContracts(dashboard?.contracts ?? [], statusFilter, searchQuery),
    [dashboard?.contracts, searchQuery, statusFilter],
  );
  const filteredUnsignedContracts = useMemo(
    () =>
      filterContracts(
        dashboard?.unsignedContracts ?? [],
        statusFilter,
        searchQuery,
      ),
    [dashboard?.unsignedContracts, searchQuery, statusFilter],
  );
  const quickSearchResults = useMemo(() => {
    const byRecordId = new Map<string, ContractManagementItem>();
    for (const contract of [
      ...(dashboard?.contracts ?? []),
      ...(dashboard?.unsignedContracts ?? []),
    ]) {
      byRecordId.set(contract.recordId, contract);
    }
    return findContractQuickSearchResults(
      [...byRecordId.values()],
      searchQuery,
    );
  }, [dashboard?.contracts, dashboard?.unsignedContracts, searchQuery]);
  const handleLocateContract = useCallback(
    (contract: ContractManagementItem) => {
      setStatusFilter('all');
      setSearchQuery(contract.code || contract.name);
      setSearchOpen(false);
      setFocusRequest({
        recordId: contract.recordId,
        requestId: Date.now(),
      });
    },
    [],
  );
  const sourceWarnings = Object.values(dashboard?.sectionStatus ?? {}).filter(
    (item) => item.message,
  );
  const paymentSourceIssue = dashboard
    ? getContractSourceIssue(dashboard.sectionStatus, ['payments'])
    : null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <ManagementHeader
        activePage="contract"
        searchValue={searchQuery}
        searchPlaceholder="搜索合同编号、名称、供应商、跟进人"
        showSearch
        searchResults={
          searchOpen && searchQuery.trim() ? (
            <ContractQuickSearchResults
              query={searchQuery}
              results={quickSearchResults}
              onLocate={handleLocateContract}
              onPreview={(request) => {
                setSearchOpen(false);
                setQuickViewerRequest(request);
              }}
            />
          ) : undefined
        }
        updatedAt={formatUpdatedAt(dashboard?.generatedAt)}
        refreshing={refreshing}
        filterLabel="定位合同筛选"
        onFilter={() => {
          setSearchOpen(false);
          document.getElementById('contract-list')?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          });
        }}
        onSearchChange={(value) => {
          setSearchQuery(value);
          setSearchOpen(Boolean(value.trim()));
        }}
        onSearchFocus={() => setSearchOpen(Boolean(searchQuery.trim()))}
        onSearchKeyDown={(event) => {
          if (event.key === 'Escape') setSearchOpen(false);
        }}
        onRefresh={() => void loadDashboard(true)}
        actions={
          canManageContracts ? (
            <Button
              type="button"
              onClick={() => setCreationOpen(true)}
              className="h-11 rounded-lg bg-white px-4 font-semibold text-blue-700 shadow-sm hover:bg-blue-50 hover:text-blue-800"
            >
              <FilePlus2 className="h-4 w-4" />
              新增合同
            </Button>
          ) : undefined
        }
      />

      <ContractCreationDialog
        open={creationOpen}
        onOpenChange={setCreationOpen}
        onCreated={refreshDashboardAfterMutation}
      />
      <ContractAttachmentViewer
        contract={quickViewerRequest?.contract || null}
        open={Boolean(quickViewerRequest)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setQuickViewerRequest(null);
        }}
      />

      <main className="mx-auto max-w-[1920px] space-y-5 px-4 py-5 sm:px-6 xl:px-8">
        {loadError && (
          <div
            role="alert"
            className="flex items-start justify-between gap-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {loadError}
            </span>
            <button
              type="button"
              onClick={() => void loadDashboard(true)}
              className="shrink-0 font-semibold underline underline-offset-2"
            >
              重新加载
            </button>
          </div>
        )}

        {sourceWarnings.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {sourceWarnings.map((item) => item.message).join('；')}
              ，其余合同数据仍可正常查看。
            </span>
          </div>
        )}

        {loading ? (
          <ContractDashboardSkeleton />
        ) : dashboard ? (
          <>
            <ContractMetrics dashboard={dashboard} />

            <section className="grid items-stretch gap-5 xl:grid-cols-2">
              <ContractAmountTop5Panel
                contracts={dashboard.contracts}
                typeBreakdown={dashboard.typeBreakdown}
              />
              <ContractRiskPanel
                items={dashboard.contractRisks}
                onSubmitted={hideSubmittedContractRisk}
                onUpdated={refreshDashboardAfterMutation}
              />
            </section>

            <PaymentAttentionPanel
              dashboard={dashboard}
              onUpdated={refreshDashboardAfterMutation}
              onNoPaymentRequired={handleNoPaymentRequired}
            />

            <section className="grid items-stretch gap-5 xl:grid-cols-2">
              <PaymentProgress
                dashboard={dashboard}
                sourceIssue={paymentSourceIssue}
              />
              <MissingPaymentPlanPanel
                dashboard={dashboard}
                onUpdated={refreshDashboardAfterMutation}
                onNoPaymentRequired={handleNoPaymentRequired}
                canManageContracts={canManageContracts}
              />
            </section>

            <ContractList
              contracts={filteredContracts}
              unsignedContracts={filteredUnsignedContracts}
              total={
                dashboard.contracts.length + dashboard.unsignedContracts.length
              }
              statusFilter={statusFilter}
              onStatusFilter={setStatusFilter}
              focusRequest={focusRequest}
              paymentSourceIssue={paymentSourceIssue}
              canManageContracts={canManageContracts}
              onUpdated={refreshDashboardAfterMutation}
            />
          </>
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

function ContractMetrics({
  dashboard,
}: {
  dashboard: ContractManagementDashboard;
}) {
  const [metricListKind, setMetricListKind] =
    useState<ContractMetricListKind | null>(null);
  const { summary } = dashboard;
  const relationshipSourceIssue = getContractSourceIssue(
    dashboard.sectionStatus,
    ['framework', 'contracts'],
  );
  const contractSourceIssue = getContractSourceIssue(dashboard.sectionStatus, [
    'contracts',
  ]);
  const paymentSourceIssue = getContractSourceIssue(dashboard.sectionStatus, [
    'payments',
  ]);
  const supplierSourceIssue = getContractSourceIssue(dashboard.sectionStatus, [
    'suppliers',
  ]);
  const activeContractValue = sumActiveContractValue(dashboard.contracts);
  type MetricCard = {
    key: ContractMetricListKind;
    label: string;
    value: string;
    detail: string;
    icon: LucideIcon;
    iconClass: string;
  };
  type FrameworkMetricCard = Omit<MetricCard, 'key'> & {
    key: 'framework';
  };
  const frameworkCard: FrameworkMetricCard = {
    key: 'framework',
    label: '框架合同',
    value: relationshipSourceIssue
      ? '--'
      : `${formatNumber(summary.activeFrameworkContracts)} 份`,
    detail: relationshipSourceIssue
      ? '框架与执行合同数据暂不可用'
      : '仅统计有效框架合同',
    icon: GitBranch,
    iconClass: 'bg-blue-600 text-white shadow-blue-200',
  };
  const cards: MetricCard[] = [
    {
      key: 'execution',
      label: '执行合同',
      value: contractSourceIssue
        ? '--'
        : `${formatNumber(summary.activeContracts + summary.expiringContracts)} 份`,
      detail: contractSourceIssue
        ? '执行合同数据暂不可用'
        : '仅统计有效及执行中合同',
      icon: FileCheck2,
      iconClass: 'bg-emerald-500 text-white shadow-emerald-200',
    },
    {
      key: 'expiring',
      label: '即将到期',
      value: contractSourceIssue
        ? '--'
        : `${formatNumber(summary.expiringContracts)} 份`,
      detail: contractSourceIssue ? '执行合同数据暂不可用' : '未来 60 天内到期',
      icon: CalendarClock,
      iconClass: 'bg-amber-500 text-white shadow-amber-200',
    },
    {
      key: 'pendingPayment',
      label: '履约中合同总金额',
      value: contractSourceIssue ? '--' : formatCurrency(activeContractValue),
      detail: paymentSourceIssue
        ? '付款计划数据暂不可用'
        : `${formatNumber(summary.overduePayments)} 笔逾期 · ${formatNumber(dashboard.paymentProgress.pendingCount)} 笔待付`,
      icon: ShieldAlert,
      iconClass: 'bg-rose-500 text-white shadow-rose-200',
    },
  ];
  const metricSourceIssues: Record<ContractMetricListKind, string | null> = {
    execution: contractSourceIssue,
    expiring: contractSourceIssue,
    pendingPayment: paymentSourceIssue,
  };

  return (
    <section
      aria-label="合同经营概览"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
    >
      <Link
        to="/contract-management/frameworks"
        aria-label="查看框架合同关联详情"
        className="group rounded-lg border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-blue-300 hover:bg-blue-50/30 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      >
        <div className="flex items-start gap-4">
          <span
            className={cn(
              'flex h-12 w-12 shrink-0 items-center justify-center rounded-lg shadow-md',
              frameworkCard.iconClass,
            )}
          >
            <frameworkCard.icon className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-600">
                {frameworkCard.label}
              </p>
              <ArrowRight className="h-4 w-4 shrink-0 text-blue-500 transition-transform group-hover:translate-x-0.5" />
            </div>
            <p className="mt-1 truncate text-2xl font-bold tabular-nums text-slate-950">
              {frameworkCard.value}
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {frameworkCard.detail}
            </p>
          </div>
        </div>
      </Link>
      {cards.map(({ key, label, value, detail, icon: Icon, iconClass }) => (
        <button
          key={key}
          type="button"
          aria-label={`查看${label}清单`}
          onClick={() => setMetricListKind(key)}
          className="rounded-lg border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-blue-300 hover:bg-blue-50/30 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          <div className="flex h-full items-start gap-4">
            <span
              className={cn(
                'flex h-12 w-12 shrink-0 items-center justify-center rounded-lg shadow-md',
                iconClass,
              )}
            >
              <Icon className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p
                id={`contract-metric-${key}`}
                className="text-sm font-semibold text-slate-600"
              >
                {label}
              </p>
              <p className="mt-1 truncate text-2xl font-bold tabular-nums text-slate-950">
                {value}
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>
            </div>
          </div>
        </button>
      ))}
      <ContractMetricListDialog
        dashboard={dashboard}
        kind={metricListKind}
        sourceIssue={metricListKind ? metricSourceIssues[metricListKind] : null}
        onOpenChange={setMetricListKind}
      />
      <SupplierDirectoryDialog
        directory={dashboard.supplierDirectory}
        sourceIssue={supplierSourceIssue}
      />
    </section>
  );
}

function ContractAmountTop5Panel({
  contracts,
  typeBreakdown,
}: {
  contracts: ContractManagementItem[];
  typeBreakdown: ContractManagementDashboard['typeBreakdown'];
}) {
  const items = getTopActiveContractsByAmount(contracts);

  return (
    <Panel
      title="合同金额与类型概览"
      subtitle="仅统计有效及执行中合同"
      icon={FileText}
    >
      <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1.35fr)_minmax(220px,0.9fr)]">
        <ContractAmountRanking items={items} />
        <ContractTypeDonut items={typeBreakdown} />
      </div>
    </Panel>
  );
}

function ContractAmountRanking({ items }: { items: ContractManagementItem[] }) {
  const maxAmount = Math.max(...items.map((item) => item.amount), 1);

  return (
    <section className="min-w-0" aria-label="履约中合同金额前五排名">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Trophy className="h-4 w-4 text-amber-500" />
          合同金额 TOP5
        </h3>
        <span className="text-[11px] text-slate-400">单位：人民币</span>
      </div>
      {items.length ? (
        <ol className="mt-4 space-y-3">
          {items.map((item, index) => (
            <li key={item.recordId} className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-bold',
                    index === 0
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-500',
                  )}
                >
                  {index + 1}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800"
                  title={item.name || item.code}
                >
                  {item.name || item.code || '未命名合同'}
                </span>
                <strong className="shrink-0 text-xs tabular-nums text-slate-900">
                  {formatCurrency(item.amount)}
                </strong>
              </div>
              <div className="ml-7 mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-blue-600"
                  style={{ width: `${(item.amount / maxAmount) * 100}%` }}
                />
              </div>
              <div className="ml-7 mt-1 flex min-w-0 items-center justify-between gap-3 text-[10px] text-slate-400">
                <span className="min-w-0 truncate" title={item.code}>
                  {item.code || '编号待补充'}
                </span>
                <span
                  className={cn(
                    'shrink-0 font-medium',
                    item.status === 'expiring'
                      ? 'text-amber-600'
                      : 'text-emerald-600',
                  )}
                >
                  {statusMeta[item.status].label}
                </span>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <InlineEmpty label="暂无履约中合同金额数据" />
      )}
    </section>
  );
}

function ContractTypeDonut({
  items,
}: {
  items: ContractManagementDashboard['typeBreakdown'];
}) {
  const chartItems = items.filter((item) => item.amount > 0);
  const totalCount = items.reduce((sum, item) => sum + item.count, 0);
  const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);

  return (
    <section
      className="min-w-0 border-t border-slate-100 pt-5 md:border-l md:border-t-0 md:pl-5 md:pt-0"
      aria-label="合同类型分布"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <ChartPie className="h-4 w-4 text-blue-600" />
          合同类型分布
        </h3>
        <span className="text-[11px] text-slate-400">按合同金额</span>
      </div>
      {chartItems.length ? (
        <>
          <div className="relative mx-auto mt-2 h-40 max-w-52">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartItems}
                  dataKey="amount"
                  nameKey="contractType"
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={68}
                  paddingAngle={2}
                  stroke="#ffffff"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {chartItems.map((item, index) => (
                    <Cell
                      key={item.contractType}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <strong className="text-xl tabular-nums text-slate-950">
                {formatNumber(totalCount)}
              </strong>
              <span className="mt-0.5 text-[10px] text-slate-400">份合同</span>
            </div>
          </div>
          <ul className="space-y-2 border-t border-slate-100 pt-3">
            {items.map((item, index) => (
              <li
                key={item.contractType}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[11px]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{
                      backgroundColor:
                        CHART_COLORS[index % CHART_COLORS.length],
                    }}
                  />
                  <span
                    className="min-w-0 truncate text-slate-600"
                    title={item.contractType}
                  >
                    {item.contractType}
                  </span>
                  <span className="shrink-0 text-slate-400">
                    {item.count} 份
                  </span>
                </span>
                <strong className="tabular-nums text-slate-700">
                  {formatCompactCurrency(item.amount)}
                </strong>
              </li>
            ))}
          </ul>
          <p className="sr-only">合同总金额 {formatCurrency(totalAmount)}</p>
        </>
      ) : (
        <InlineEmpty label="暂无合同类型数据" />
      )}
    </section>
  );
}

function PaymentProgress({
  dashboard,
  sourceIssue,
}: {
  dashboard: ContractManagementDashboard;
  sourceIssue: string | null;
}) {
  const periods = summarizeContractPaymentPeriods(
    dashboard.payments,
    dashboard.generatedAt,
  );
  const trend = buildPaymentPlanMonthlyTrend(
    dashboard.payments,
    dashboard.generatedAt,
  );
  return (
    <Panel
      title="合同付款情况"
      subtitle="按计划付款日期查看本年度、本季度与本月完成情况"
      icon={CircleDollarSign}
    >
      {sourceIssue ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-5 text-sm text-amber-800"
        >
          <p className="font-semibold">付款统计数据暂不可用</p>
          <p className="mt-1 text-xs leading-5">{sourceIssue}</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            {periods.map((item) => (
              <PaymentPeriodRing key={item.key} item={item} />
            ))}
          </div>
          <PaymentMonthlyAreaTrend items={trend} />
        </div>
      )}
    </Panel>
  );
}

function PaymentMonthlyAreaTrend({
  items,
}: {
  items: PaymentMonthlyTrendItem[];
}) {
  const currentMonth = items.find((item) => item.isCurrent)?.label;
  const chartItems = buildPaymentTrendChartItems(items);
  return (
    <section
      aria-label="合同付款月度趋势"
      className="border-t border-slate-200 pt-4"
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-900">合同付款趋势</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            近 3 个月按实际已付款 · 本月及未来 3 个月按计划付款
          </p>
        </div>
        <span className="text-[11px] text-slate-400">单位：人民币</span>
      </div>
      <div className="h-44 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartItems}
            margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient
                id="contractPaymentTrendHistoryFill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#2563eb" stopOpacity={0.03} />
              </linearGradient>
              <linearGradient
                id="contractPaymentTrendFutureFill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#64748b', fontSize: 11 }}
            />
            <YAxis
              width={58}
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#64748b', fontSize: 10 }}
              tickFormatter={formatCompactCurrency}
            />
            <Tooltip content={<PaymentTrendTooltip />} />
            {currentMonth && (
              <ReferenceLine
                x={currentMonth}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                label={{
                  value: '本月',
                  position: 'insideTopRight',
                  fill: '#64748b',
                  fontSize: 10,
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="historyAmount"
              name="历史实际付款金额"
              stroke="#2563eb"
              strokeWidth={2}
              fill="url(#contractPaymentTrendHistoryFill)"
              activeDot={{ r: 4, fill: '#2563eb', stroke: '#ffffff' }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="futureAmount"
              name="本月及未来计划金额"
              stroke="#f59e0b"
              strokeWidth={2}
              fill="url(#contractPaymentTrendFutureFill)"
              activeDot={{ r: 4, fill: '#f59e0b', stroke: '#ffffff' }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PaymentTrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PaymentMonthlyTrendItem }>;
}) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-slate-900">{item.month}</p>
      <p className="mt-1 text-slate-500">
        {item.basis === 'actual' ? '实际付款' : '计划付款'}{' '}
        <strong className="tabular-nums text-blue-700">
          {formatCurrency(item.amount)}
        </strong>
      </p>
    </div>
  );
}

function PaymentPeriodRing({ item }: { item: ContractPaymentPeriodSummary }) {
  const completed = Math.min(100, item.completionRate);
  return (
    <article className="flex min-w-0 flex-col items-center rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex w-full items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-900">{item.label}</h3>
          <p className="mt-0.5 text-[11px] text-slate-400">{item.rangeLabel}</p>
        </div>
        <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold text-slate-500 shadow-sm">
          {item.itemCount} 笔
        </span>
      </div>
      <div
        className="relative my-3 flex h-28 w-28 items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(rgb(37 99 235) ${completed}%, rgb(226 232 240) ${completed}% 100%)`,
        }}
        aria-label={`${item.label}付款完成率 ${completed}%`}
      >
        <div className="flex h-20 w-20 flex-col items-center justify-center rounded-full bg-white shadow-inner">
          <strong className="text-xl font-bold tabular-nums text-slate-950">
            {completed}%
          </strong>
          <span className="text-[10px] text-slate-500">完成率</span>
        </div>
      </div>
      <dl className="w-full space-y-1.5 border-t border-slate-200 pt-2 text-[11px]">
        <PaymentPeriodMetric
          label="计划"
          value={formatCurrency(item.plannedAmount)}
        />
        <PaymentPeriodMetric
          label="已付"
          value={formatCurrency(item.paidAmount)}
          tone="text-emerald-700"
        />
        <PaymentPeriodMetric
          label="待付"
          value={formatCurrency(item.pendingAmount)}
          tone="text-amber-700"
        />
      </dl>
    </article>
  );
}

function PaymentPeriodMetric({
  label,
  value,
  tone = 'text-slate-800',
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={cn('truncate font-semibold tabular-nums', tone)}>
        {value}
      </dd>
    </div>
  );
}

function ContractRiskPanel({
  items,
  onSubmitted,
  onUpdated,
}: {
  items: ContractManagementItem[];
  onSubmitted: (recordId: string) => void;
  onUpdated: () => void | Promise<void>;
}) {
  const [selectedContract, setSelectedContract] =
    useState<ContractManagementItem | null>(null);
  return (
    <>
      <Panel
        title="合同到期风险"
        subtitle="未来 60 天内即将到期"
        icon={AlertTriangle}
        badge={`${items.length} 项`}
      >
        {items.length ? (
          <div className="max-h-[330px] space-y-2 overflow-y-auto pr-1">
            {items.map((item) => (
              <div
                key={item.recordId}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={item.status} />
                    <p className="truncate text-sm font-semibold text-slate-900">
                      {item.name}
                    </p>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {item.code || '编号待补充'} · {item.owner} · {item.supplier}
                  </p>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    履约周期：{formatDate(item.startDate)} 至{' '}
                    {formatDate(item.endDate)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums text-slate-900">
                      {formatDate(item.endDate)}
                    </p>
                    <p
                      className={cn(
                        'mt-1 text-xs font-semibold',
                        item.status === 'expired'
                          ? 'text-rose-600'
                          : 'text-amber-600',
                      )}
                    >
                      {item.daysRemaining === null
                        ? '日期待补充'
                        : item.daysRemaining < 0
                          ? `已过期 ${Math.abs(item.daysRemaining)} 天`
                          : `剩余 ${item.daysRemaining} 天`}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="人工确认合同到期处置"
                    title="人工确认合同到期处置"
                    onClick={() => setSelectedContract(item)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-blue-200 bg-white text-blue-600 shadow-sm transition hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  >
                    <ClipboardCheck className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <InlineEmpty label="当前没有临期或到期合同" success />
        )}
      </Panel>
      <ContractExpiryDispositionDialog
        contract={selectedContract}
        open={Boolean(selectedContract)}
        onOpenChange={(open) => {
          if (!open) setSelectedContract(null);
        }}
        onSubmitted={onSubmitted}
        onUpdated={onUpdated}
      />
    </>
  );
}

function PaymentAttentionPanel({
  dashboard,
  onUpdated,
  onNoPaymentRequired,
}: {
  dashboard: ContractManagementDashboard;
  onUpdated: () => void | Promise<void>;
  onNoPaymentRequired: (
    item: ContractPaymentFollowUpItem,
  ) => void | Promise<void>;
}) {
  const dataSourceIssue = getContractSourceIssue(dashboard.sectionStatus, [
    'contracts',
    'payments',
  ]);
  const groups = partitionPaymentAttentionItems(dashboard.paymentRisks);
  const [activeTab, setActiveTab] = useState<PaymentAttentionTab>('overdue');
  const [viewerTarget, setViewerTarget] =
    useState<ContractPaymentFollowUpItem | null>(null);
  const [paymentTarget, setPaymentTarget] =
    useState<ContractPaymentFollowUpItem | null>(null);
  const paymentTargets = useMemo(() => {
    const targets = new Map<string, ContractPaymentFollowUpItem>();
    for (const item of dashboard.paymentFollowUps || []) {
      targets.set(item.contractRecordId, item);
    }
    for (const contract of dashboard.contracts) {
      if (!targets.has(contract.recordId)) {
        targets.set(
          contract.recordId,
          buildPaymentFollowUpTarget(contract, dashboard.payments),
        );
      }
    }
    return targets;
  }, [dashboard.contracts, dashboard.paymentFollowUps, dashboard.payments]);
  const items = groups[activeTab];
  const tabs: Array<{ key: PaymentAttentionTab; label: string }> = [
    { key: 'overdue', label: '到期未付款' },
    { key: 'upcoming', label: '30 天内需付款' },
  ];
  const viewerContract = viewerTarget
    ? {
        code: viewerTarget.contractCode,
        name: viewerTarget.contractName,
        attachments: viewerTarget.attachments,
      }
    : null;
  return (
    <>
      <Panel
        title="付款计划重点跟进"
        subtitle="按计划付款日期聚合到期未付与未来 30 天付款任务"
        icon={Clock3}
        badge={dataSourceIssue ? '数据异常' : `${items.length} 项`}
      >
        {dataSourceIssue ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-5 text-sm text-amber-800"
          >
            <p className="font-semibold">付款计划跟进数据暂不可用</p>
            <p className="mt-1 text-xs leading-5">{dataSourceIssue}</p>
          </div>
        ) : (
          <>
            <div
              aria-label="付款计划跟进筛选"
              className="mb-4 flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  aria-pressed={activeTab === tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    'flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    activeTab === tab.key
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  {tab.label}
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 tabular-nums text-slate-500">
                    {groups[tab.key].length}
                  </span>
                </button>
              ))}
            </div>
            {items.length ? (
              <div className="max-h-[330px] space-y-2 overflow-y-auto pr-1">
                {items.map((item) => {
                  const target = paymentTargets.get(item.contractRecordId);
                  return (
                    <div
                      key={item.recordId}
                      className="rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-3"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <PaymentAttentionBadge item={item} />
                            <p className="truncate text-sm font-semibold text-slate-900">
                              {item.contractName}
                            </p>
                          </div>
                          <p className="mt-1 truncate text-xs text-slate-500">
                            {item.contractCode || item.label} ·{' '}
                            {item.cycle || '按约定日期付款'} · {item.owner}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold tabular-nums text-slate-900">
                            待付{' '}
                            {formatCurrency(
                              item.plannedAmount - item.actualAmount,
                            )}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            计划付款日期 {formatDate(item.dueDate)}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-400">
                            计划 {formatCurrency(item.plannedAmount)} · 已付{' '}
                            {formatCurrency(item.actualAmount)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 border-t border-slate-200 pt-2 text-[11px] leading-5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p>
                            <span className="font-semibold text-slate-600">
                              付款状态：
                            </span>
                            <span className="text-slate-500">
                              {item.status || '待确认'}
                            </span>
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={!target}
                              onClick={() => target && setPaymentTarget(target)}
                              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            >
                              <CreditCard className="h-3.5 w-3.5" />
                              付款跟进
                            </button>
                            {target?.attachments.length ? (
                              <button
                                type="button"
                                onClick={() => setViewerTarget(target)}
                                className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-700 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                在线预览合同
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div>
                <InlineEmpty
                  label={
                    activeTab === 'overdue'
                      ? '当前没有到期未付款计划'
                      : '未来 30 天暂无需付款计划'
                  }
                  success
                />
                {(dashboard.paymentDataQuality.pendingMissingDate > 0 ||
                  dashboard.paymentDataQuality.missingContract > 0) && (
                  <div className="flex flex-wrap justify-center gap-2 border-t border-slate-100 pt-3 text-[11px]">
                    {dashboard.paymentDataQuality.pendingMissingDate > 0 && (
                      <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700">
                        {dashboard.paymentDataQuality.pendingMissingDate}{' '}
                        条未付款计划待补日期
                      </span>
                    )}
                    {dashboard.paymentDataQuality.missingContract > 0 && (
                      <span className="rounded-full bg-rose-50 px-2.5 py-1 font-semibold text-rose-700">
                        {dashboard.paymentDataQuality.missingContract}{' '}
                        条待关联合同
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Panel>
      <ContractAttachmentViewer
        contract={viewerContract}
        open={Boolean(viewerTarget)}
        onOpenChange={(open) => {
          if (!open) setViewerTarget(null);
        }}
      />
      <ContractPaymentFollowUpDialog
        item={paymentTarget}
        open={Boolean(paymentTarget)}
        onOpenChange={(open) => {
          if (!open) setPaymentTarget(null);
        }}
        onCompleted={onUpdated}
        onNoPaymentRequired={onNoPaymentRequired}
      />
    </>
  );
}

function PaymentAttentionBadge({ item }: { item: ContractPaymentItem }) {
  const overdue = (item.daysUntilDue ?? 1) <= 0;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-md border px-2 py-1 text-[11px] font-semibold',
        overdue
          ? 'border-rose-200 bg-rose-50 text-rose-700'
          : 'border-amber-200 bg-amber-50 text-amber-700',
      )}
    >
      {overdue
        ? item.daysUntilDue === 0
          ? '今日到期'
          : `已逾期 ${Math.abs(item.daysUntilDue || 0)} 天`
        : `${item.daysUntilDue} 天后付款`}
    </span>
  );
}

function MissingPaymentPlanPanel({
  dashboard,
  onUpdated,
  onNoPaymentRequired,
  canManageContracts,
}: {
  dashboard: ContractManagementDashboard;
  onUpdated: () => void | Promise<void>;
  onNoPaymentRequired: (
    item: ContractPaymentFollowUpItem,
  ) => void | Promise<void>;
  canManageContracts: boolean;
}) {
  const dataSourceIssue = getContractSourceIssue(dashboard.sectionStatus, [
    'contracts',
    'payments',
  ]);
  const currentMissingItems = findContractsWithoutPaymentPlans(
    dashboard.contracts,
    dashboard.payments,
  ).map((contract) => buildPaymentFollowUpTarget(contract, dashboard.payments));
  const missingItemsByContract = new Map<string, ContractPaymentFollowUpItem>();
  for (const item of dashboard.paymentFollowUps || []) {
    if (item.reason === 'missing_plan') {
      missingItemsByContract.set(item.contractRecordId, item);
    }
  }
  for (const item of currentMissingItems) {
    missingItemsByContract.set(item.contractRecordId, item);
  }
  const items = [...missingItemsByContract.values()];
  const [page, setPage] = useState(1);
  const pagination = paginateItems(items, page, MISSING_PAYMENT_PLAN_PAGE_SIZE);
  useEffect(() => {
    if (page !== pagination.page) setPage(pagination.page);
  }, [page, pagination.page]);
  const [viewerTarget, setViewerTarget] =
    useState<ContractPaymentFollowUpItem | null>(null);
  const [paymentTarget, setPaymentTarget] =
    useState<ContractPaymentFollowUpItem | null>(null);
  const viewerContract = viewerTarget
    ? {
        code: viewerTarget.contractCode,
        name: viewerTarget.contractName,
        attachments: viewerTarget.attachments,
      }
    : null;

  return (
    <Panel
      title="待补付款计划"
      subtitle="付款计划表已配置合同编号关联；以下合同暂无对应付款计划记录"
      icon={AlertTriangle}
      badge={
        dataSourceIssue
          ? '数据异常'
          : items.length
            ? `${items.length} 份待跟进`
            : '暂无'
      }
    >
      {dataSourceIssue ? (
        <div
          role="alert"
          className="flex min-h-32 items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-5 text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-bold">付款计划关联数据暂不可用</p>
            <p className="mt-1 text-xs leading-5">{dataSourceIssue}</p>
            <p className="mt-1 text-xs leading-5 text-amber-800">
              数据恢复前不展示“已清理”或生成待跟进结论。
            </p>
          </div>
        </div>
      ) : items.length ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="hidden border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-500 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(120px,0.7fr)_minmax(144px,0.78fr)_36px] lg:gap-3">
            <span>合同名称</span>
            <span>合同结束日期</span>
            <span>新增付款计划</span>
            <span className="sr-only">合同预览</span>
          </div>
          <ul
            aria-label="待补付款计划合同清单"
            className="divide-y divide-slate-200"
          >
            {pagination.items.map((item) => (
              <li
                key={item.contractRecordId}
                className={cn(
                  'grid gap-3 border-l-4 bg-white px-4 py-2 transition-colors hover:bg-slate-50 focus-within:bg-blue-50/40 focus-within:outline-none focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 lg:h-[72px] lg:grid-cols-[minmax(0,1.35fr)_minmax(120px,0.7fr)_minmax(144px,0.78fr)_36px] lg:items-center lg:gap-3',
                  item.reason === 'missing_plan'
                    ? 'border-l-amber-400'
                    : 'border-l-rose-400',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'shrink-0 rounded-md border bg-white px-2 py-1 text-[11px] font-semibold',
                      item.reason === 'missing_plan'
                        ? 'border-amber-200 text-amber-700'
                        : 'border-rose-200 text-rose-700',
                    )}
                  >
                    {item.reason === 'missing_plan'
                      ? '暂无付款计划'
                      : '存在未付款计划'}
                  </span>
                  <h3
                    title={item.contractName}
                    className="min-w-0 truncate text-sm font-bold text-slate-900"
                  >
                    {item.contractName}
                  </h3>
                </div>

                <div className="min-w-0 text-xs leading-5 text-slate-600">
                  <p className="mb-1 font-semibold text-slate-500 lg:hidden">
                    合同结束日期
                  </p>
                  <p className="flex items-start gap-1.5">
                    <CalendarClock
                      className={cn(
                        'mt-0.5 h-3.5 w-3.5 shrink-0',
                        item.reason === 'missing_plan'
                          ? 'text-amber-600'
                          : 'text-rose-600',
                      )}
                    />
                    <span>{formatDate(item.contractEndDate)}</span>
                  </p>
                </div>

                <div className="min-w-0">
                  {canManageContracts ? (
                    <button
                      type="button"
                      onClick={() => setPaymentTarget(item)}
                      className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                    >
                      <CreditCard className="h-3.5 w-3.5" />
                      新增付款计划
                    </button>
                  ) : (
                    <span className="text-xs font-medium text-slate-400">
                      无合同维护权限
                    </span>
                  )}
                </div>

                <div className="flex min-w-0 items-center justify-end">
                  {item.attachments.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setViewerTarget(item)}
                      aria-label={`在线预览合同：${item.contractName}`}
                      title="在线预览合同"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200 bg-white text-blue-700 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/70 px-4 py-2.5">
              <span className="text-xs text-slate-500">
                第 {pagination.page} / {pagination.totalPages} 页，共{' '}
                {pagination.totalItems} 份
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((current) => current - 1)}
                  disabled={pagination.page <= 1}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={pagination.page >= pagination.totalPages}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  下一页
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <InlineEmpty label="暂无待补付款计划" success />
      )}
      <ContractAttachmentViewer
        contract={viewerContract}
        open={Boolean(viewerTarget)}
        onOpenChange={(open) => {
          if (!open) setViewerTarget(null);
        }}
      />
      <ContractPaymentFollowUpDialog
        item={paymentTarget}
        open={Boolean(paymentTarget)}
        onOpenChange={(open) => {
          if (!open) setPaymentTarget(null);
        }}
        onCompleted={onUpdated}
        onNoPaymentRequired={onNoPaymentRequired}
      />
    </Panel>
  );
}

function ContractList({
  contracts,
  unsignedContracts,
  total,
  statusFilter,
  onStatusFilter,
  focusRequest,
  paymentSourceIssue,
  canManageContracts,
  onUpdated,
}: {
  contracts: ContractManagementItem[];
  unsignedContracts: ContractManagementItem[];
  total: number;
  statusFilter: ContractStatusFilter;
  onStatusFilter: (status: ContractStatusFilter) => void;
  focusRequest: { recordId: string; requestId: number } | null;
  paymentSourceIssue: string | null;
  canManageContracts: boolean;
  onUpdated: () => void | Promise<void>;
}) {
  const [viewerRequest, setViewerRequest] = useState<{
    contract: ContractManagementItem;
    accessId?: string;
    page?: number;
  } | null>(null);
  const [editTarget, setEditTarget] = useState<ContractManagementItem | null>(
    null,
  );
  const [unsignedExpanded, setUnsignedExpanded] = useState(false);
  const [highlightedRecordId, setHighlightedRecordId] = useState<string | null>(
    null,
  );
  const { visibleContracts, hiddenUnsignedCount } = buildContractListDisplay(
    contracts,
    unsignedContracts,
    unsignedExpanded,
  );
  useEffect(() => {
    if (!focusRequest) return undefined;
    if (
      unsignedContracts.some(
        (contract) => contract.recordId === focusRequest.recordId,
      )
    ) {
      setUnsignedExpanded(true);
    }
    setHighlightedRecordId(focusRequest.recordId);
    const scrollTimer = window.setTimeout(() => {
      const targets = Array.from(
        document.querySelectorAll<HTMLElement>('[data-contract-record-id]'),
      );
      const exactTargets = targets.filter(
        (target) => target.dataset.contractRecordId === focusRequest.recordId,
      );
      const target =
        exactTargets.find((candidate) => candidate.offsetParent !== null) ||
        exactTargets[0];
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
    const highlightTimer = window.setTimeout(
      () => setHighlightedRecordId(null),
      2_400,
    );
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(highlightTimer);
    };
  }, [focusRequest, unsignedContracts]);
  const renderUnsignedContractsToggle = () => (
    <button
      type="button"
      aria-expanded={unsignedExpanded}
      onClick={() => setUnsignedExpanded((expanded) => !expanded)}
      className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-left text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
    >
      <span>未签订合同（{unsignedContracts.length}）</span>
      <ChevronDown
        className={cn(
          'h-4 w-4 transition-transform',
          unsignedExpanded && 'rotate-180',
        )}
      />
    </button>
  );
  return (
    <>
      <section
        id="contract-list"
        className="scroll-mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex flex-col gap-4 border-b border-slate-200 px-4 py-4 lg:flex-row lg:items-center lg:justify-between sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-md shadow-blue-200">
              <FileText className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-950">
                合同执行清单
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                当前显示 {visibleContracts.length} / {total} 份合同
                {hiddenUnsignedCount > 0
                  ? ` · ${hiddenUnsignedCount} 份未签订合同已收起`
                  : ''}
              </p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center">
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
              {statusFilters.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  aria-pressed={statusFilter === filter.key}
                  onClick={() => onStatusFilter(filter.key)}
                  className={cn(
                    'h-8 shrink-0 rounded-md px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    statusFilter === filter.key
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {contracts.length || unsignedContracts.length ? (
          <>
            <div className="hidden xl:block">
              <table className="w-full table-fixed text-left text-[13px]">
                <colgroup>
                  <col className="w-[19%]" />
                  <col className="w-[9%]" />
                  <col className="w-[14%]" />
                  <col className="w-[10%]" />
                  <col className="w-[13%]" />
                  <col className="w-[9%]" />
                  <col className="w-[12%]" />
                  <col className="w-[7%]" />
                  <col className="w-[7%]" />
                </colgroup>
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
                  <tr>
                    <th className="px-3 py-3">合同编号 / 名称</th>
                    <th className="px-2 py-3">分类</th>
                    <th className="px-2 py-3">供应商 / 跟进人</th>
                    <th className="px-2 py-3 text-right">合同金额</th>
                    <th className="px-2 py-3">合同周期</th>
                    <th className="px-2 py-3">付款性质</th>
                    <th className="px-2 py-3">付款进度</th>
                    <th className="px-2 py-3 text-center">信息迭代</th>
                    <th className="px-2 py-3">当前状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleContracts.map((item, index) => (
                    <Fragment key={item.recordId}>
                      {unsignedExpanded && index === contracts.length && (
                        <tr>
                          <td colSpan={9} className="bg-slate-50 px-3 py-3">
                            {renderUnsignedContractsToggle()}
                          </td>
                        </tr>
                      )}
                      <tr
                        data-contract-record-id={item.recordId}
                        className={cn(
                          'transition-colors hover:bg-blue-50/35',
                          highlightedRecordId === item.recordId &&
                            'bg-blue-100 ring-2 ring-inset ring-blue-400',
                        )}
                      >
                        <td className="px-3 py-3">
                          <p
                            className="truncate font-semibold text-slate-900"
                            title={item.code || '编号待补充'}
                          >
                            {item.code || '编号待补充'}
                          </p>
                          <p
                            className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500"
                            title={item.name}
                          >
                            {item.name}
                          </p>
                          {item.attachments.length > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setViewerRequest({ contract: item })
                              }
                              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              在线阅读 {item.attachments.length} 份
                            </button>
                          )}
                        </td>
                        <td className="px-2 py-3">
                          <p
                            className="truncate text-slate-700"
                            title={item.contractType}
                          >
                            {item.contractType}
                          </p>
                          <p
                            className="mt-1 truncate text-xs text-slate-500"
                            title={item.specialty}
                          >
                            {item.specialty}
                          </p>
                        </td>
                        <td className="px-2 py-3">
                          <p
                            className="truncate text-slate-700"
                            title={item.supplier}
                          >
                            {item.supplier}
                          </p>
                          <p
                            className="mt-1 truncate text-xs text-slate-500"
                            title={item.owner}
                          >
                            {item.owner}
                          </p>
                        </td>
                        <td className="px-2 py-3 text-right font-bold tabular-nums text-slate-900">
                          {formatCurrency(item.amount)}
                        </td>
                        <td className="px-2 py-3 text-xs text-slate-600">
                          <p>{formatDate(item.startDate)}</p>
                          <p className="mt-1">至 {formatDate(item.endDate)}</p>
                        </td>
                        <td className="px-2 py-3 text-xs leading-5 text-slate-600">
                          <p className="line-clamp-2" title={item.paymentCycle}>
                            {item.paymentCycle || '待补充'}
                          </p>
                        </td>
                        <td className="px-2 py-3">
                          <ContractPaymentProgress
                            item={item}
                            sourceIssue={paymentSourceIssue}
                          />
                        </td>
                        <td className="px-2 py-3 text-center">
                          {canManageContracts ? (
                            <button
                              type="button"
                              onClick={() => setEditTarget(item)}
                              aria-label={`迭代合同信息：${item.name}`}
                              title="迭代合同信息"
                              className="inline-flex h-8 items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 text-[11px] font-semibold text-blue-700 transition hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            >
                              <PencilLine className="h-3.5 w-3.5" />
                              迭代
                            </button>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-2 py-3">
                          <StatusBadge status={item.status} />
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                  {!unsignedExpanded && unsignedContracts.length > 0 && (
                    <tr>
                      <td colSpan={9} className="bg-slate-50 px-3 py-3">
                        {renderUnsignedContractsToggle()}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-slate-100 xl:hidden">
              {visibleContracts.map((item, index) => (
                <Fragment key={item.recordId}>
                  {unsignedExpanded && index === contracts.length && (
                    <div className="bg-slate-50 px-4 py-3">
                      {renderUnsignedContractsToggle()}
                    </div>
                  )}
                  <article
                    data-contract-record-id={item.recordId}
                    className={cn(
                      'space-y-3 px-4 py-4 transition-colors',
                      highlightedRecordId === item.recordId &&
                        'bg-blue-100 ring-2 ring-inset ring-blue-400',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900">
                          {item.name}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {item.code || '编号待补充'}
                        </p>
                        {item.attachments.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setViewerRequest({ contract: item })}
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            在线阅读 {item.attachments.length} 份
                          </button>
                        )}
                      </div>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <MobileField
                        label="合同金额"
                        value={formatCurrency(item.amount)}
                      />
                      <MobileField
                        label="分类"
                        value={`${item.contractType} · ${item.specialty}`}
                      />
                      <MobileField label="供应商" value={item.supplier} />
                      <MobileField label="跟进人" value={item.owner} />
                      <MobileField
                        label="合同周期"
                        value={`${formatDate(item.startDate)} 至 ${formatDate(item.endDate)}`}
                        wide
                      />
                      <MobileField
                        label="付款性质"
                        value={item.paymentCycle || '待补充'}
                        wide
                      />
                      <div className="col-span-2">
                        <p className="text-slate-400">付款进度</p>
                        <div className="mt-1">
                          <ContractPaymentProgress
                            item={item}
                            sourceIssue={paymentSourceIssue}
                          />
                        </div>
                      </div>
                    </div>
                    {canManageContracts && (
                      <button
                        type="button"
                        onClick={() => setEditTarget(item)}
                        className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-700"
                      >
                        <PencilLine className="h-3.5 w-3.5" />
                        迭代合同信息
                      </button>
                    )}
                  </article>
                </Fragment>
              ))}
              {!unsignedExpanded && unsignedContracts.length > 0 && (
                <div className="bg-slate-50 px-4 py-3">
                  {renderUnsignedContractsToggle()}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="px-4 py-14">
            <InlineEmpty label="暂无合同数据，请调整搜索或状态筛选" />
          </div>
        )}
      </section>
      <ContractAttachmentViewer
        contract={viewerRequest?.contract || null}
        initialAccessId={viewerRequest?.accessId}
        initialPage={viewerRequest?.page}
        open={Boolean(viewerRequest)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setViewerRequest(null);
        }}
      />
      <ContractEditDialog
        contract={editTarget}
        open={Boolean(editTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setEditTarget(null);
        }}
        onCompleted={onUpdated}
      />
    </>
  );
}

function ContractPaymentProgress({
  item,
  sourceIssue,
}: {
  item: ContractManagementItem;
  sourceIssue: string | null;
}) {
  if (sourceIssue) {
    return (
      <p className="text-xs font-semibold text-amber-700" title={sourceIssue}>
        付款进度数据暂不可用
      </p>
    );
  }
  const progress = Math.min(100, item.paymentProgress.completionRate);
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold tabular-nums text-slate-800">
          {progress}%
        </span>
        <span className="min-w-0 truncate text-[11px] tabular-nums text-slate-500">
          {formatCurrency(item.paymentProgress.paidAmount)} /{' '}
          {formatCurrency(item.paymentProgress.plannedAmount)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-emerald-500"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  icon: Icon,
  badge,
  children,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex h-full min-w-0 flex-col rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-bold text-slate-950">{title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        {badge && (
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
            {badge}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function StatusBadge({ status }: { status: ContractStatus }) {
  const meta = statusMeta[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-[11px] font-semibold',
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

function MobileField({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <p className="text-slate-400">{label}</p>
      <p className="mt-1 truncate font-medium text-slate-700">{value}</p>
    </div>
  );
}

function InlineEmpty({
  label,
  success = false,
}: {
  label: string;
  success?: boolean;
}) {
  const Icon = success ? CheckCircle2 : FileText;
  return (
    <div className="flex min-h-32 flex-col items-center justify-center text-center">
      <span
        className={cn(
          'mb-3 flex h-10 w-10 items-center justify-center rounded-full',
          success
            ? 'bg-emerald-50 text-emerald-600'
            : 'bg-slate-100 text-slate-400',
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="rounded-lg border border-dashed border-blue-200 bg-white px-6 py-20 text-center shadow-sm">
      <FileText className="mx-auto h-10 w-10 text-blue-400" />
      <h2 className="mt-4 text-base font-bold text-slate-900">暂无合同数据</h2>
      <p className="mt-2 text-sm text-slate-500">
        请刷新页面，或检查飞书合同数据源访问权限。
      </p>
    </section>
  );
}

function ContractDashboardSkeleton() {
  return (
    <div aria-label="合同数据加载中" className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="h-36 animate-pulse rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="h-10 w-10 rounded-lg bg-slate-100" />
            <div className="mt-3 h-5 w-2/3 rounded bg-slate-100" />
            <div className="mt-2 h-3 w-1/2 rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={index}
            className="flex h-72 animate-pulse items-center justify-center rounded-lg border border-slate-200 bg-white shadow-sm"
          >
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          </div>
        ))}
      </div>
    </div>
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatCompactCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function formatDate(value: string | null): string {
  if (!value) return '待补充';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '待补充';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatUpdatedAt(value?: string): string {
  if (!value) return '等待同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '等待同步';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function createPaymentDispositionRequestId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    return (value === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}
