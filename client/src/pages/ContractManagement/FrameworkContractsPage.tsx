import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Eye,
  FileText,
  GitBranch,
  RefreshCw,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { getContractManagementDashboard } from '@/api';
import { useAccess } from '@/access/AccessProvider';
import { businessPermissionScopeKey } from '@shared/business-permissions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type {
  ContractFrameworkRelationItem,
  ContractManagementDashboard,
  ContractStatus,
} from '@shared/contract-management.interface';

import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import {
  countEffectiveExecutionContracts,
  filterFrameworkContracts,
  selectInitialFrameworkId,
  type FrameworkContractFilter,
} from './framework-contracts.logic';
import { getContractSourceIssue } from './contract-source-health';
import { createLatestRequestCoordinator } from './latest-request';
import { canUseContractAction } from './contract-permissions';

const EMPTY_FRAMEWORKS: readonly ContractFrameworkRelationItem[] = [];
const frameworkFilters: Array<{
  key: FrameworkContractFilter;
  label: string;
}> = [
  { key: 'all', label: '全部' },
  { key: 'linked', label: '已关联' },
  { key: 'unlinked', label: '待关联' },
  { key: 'expiring', label: '即将到期' },
];

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
      label: '已到期',
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

const numberFormatter = new Intl.NumberFormat('zh-CN');
const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const updatedAtFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hour12: false,
});

export default function FrameworkContractsPage() {
  const principal = useAccess();
  const principalKey = businessPermissionScopeKey(principal);
  const canRefresh = canUseContractAction(principal, 'refresh');
  const [dashboard, setDashboard] =
    useState<ContractManagementDashboard | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FrameworkContractFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const dashboardRef = useRef<ContractManagementDashboard | null>(null);
  const [requestCoordinator] = useState(createLatestRequestCoordinator);
  const relationshipRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    requestCoordinator.invalidate();
    dashboardRef.current = null;
    setDashboard(null);
    setSelectedId(null);
  }, [principalKey, requestCoordinator]);

  const loadDashboard = useCallback(
    async (forceRefresh = false) => {
      if (forceRefresh) {
        setRefreshing(true);
        setRefreshError(null);
      } else if (!dashboardRef.current) {
        setLoading(true);
        setLoadError(null);
      }

      await requestCoordinator.run(
        getContractManagementDashboard(forceRefresh && canRefresh),
        {
          onSuccess: (response) => {
            dashboardRef.current = response;
            setDashboard(response);
            setLoadError(null);
            setRefreshError(null);
          },
          onError: () => {
            if (dashboardRef.current) {
              setRefreshError(
                '刷新失败，当前仍显示最近一次成功加载的框架合同数据。',
              );
            } else {
              setLoadError(
                '框架合同数据读取失败，请检查网络或多维表数据源后重试。',
              );
            }
          },
          onSettled: () => {
            setLoading(false);
            setRefreshing(false);
          },
        },
      );
    },
    [canRefresh, principalKey, requestCoordinator],
  );

  useEffect(() => {
    void loadDashboard(false);
    return () => {
      requestCoordinator.invalidate();
    };
  }, [loadDashboard, requestCoordinator]);

  const allItems = dashboard?.frameworkRelations.items ?? EMPTY_FRAMEWORKS;
  const filteredItems = useMemo(
    () => filterFrameworkContracts(allItems, query, filter),
    [allItems, filter, query],
  );

  const effectiveSelectedId =
    selectedId &&
    filteredItems.some((item) => item.frameworkRecordId === selectedId)
      ? selectedId
      : selectInitialFrameworkId(filteredItems);

  useEffect(() => {
    setSelectedId(effectiveSelectedId);
  }, [effectiveSelectedId]);

  const selected =
    filteredItems.find(
      (item) => item.frameworkRecordId === effectiveSelectedId,
    ) ?? null;

  const viewRelationship = useCallback(
    (frameworkRecordId: string, shouldScroll = false) => {
      setSelectedId(frameworkRecordId);
      if (!shouldScroll) return;
      window.requestAnimationFrame(() => {
        const reducedMotion =
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        relationshipRef.current?.scrollIntoView({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      });
    },
    [],
  );

  const emptyTitle =
    allItems.length === 0 ? '暂无框架合同' : '未找到匹配的框架合同';
  const relationshipSourceIssue = dashboard
    ? getContractSourceIssue(dashboard.sectionStatus, [
        'framework',
        'contracts',
      ])
    : null;

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900">
      <ManagementHeader
        activePage="contract"
        searchValue={query}
        searchPlaceholder="搜索框架合同名称或编号"
        sourceLabel="飞书多维表 · 框架合同与执行合同真实关联"
        updatedAt={formatUpdatedAt(dashboard?.generatedAt)}
        refreshing={loading || refreshing}
        filterLabel="定位框架合同筛选"
        onFilter={() =>
          document.getElementById('framework-list-title')?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          })
        }
        onSearchChange={setQuery}
        onRefresh={canRefresh ? () => void loadDashboard(true) : undefined}
      />
      <main className="mx-auto max-w-[1920px] space-y-5 px-4 py-5 sm:px-6 xl:px-8">
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-4 sm:p-5">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="-ml-2 text-slate-600"
            >
              <Link to="/contract-management">
                <ArrowLeft className="h-4 w-4" />
                返回合同总览
              </Link>
            </Button>
            <h1 className="mt-3 text-xl font-bold text-slate-950 sm:text-2xl">
              框架合同与执行合同关联
            </h1>
          </CardContent>
        </Card>

        {refreshing && dashboard && (
          <Notice tone="info">
            <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            正在刷新框架合同数据，当前内容可继续查看。
          </Notice>
        )}
        {refreshError && dashboard && (
          <Notice tone="warning">
            <AlertTriangle className="h-4 w-4" />
            {refreshError}
          </Notice>
        )}

        {loading && !dashboard ? (
          <LoadingState />
        ) : !dashboard ? (
          <LoadFailure
            detail={
              loadError ??
              '框架合同数据读取失败，请检查网络或多维表数据源后重试。'
            }
            busy={loading || refreshing}
            onRetry={() => void loadDashboard(true)}
          />
        ) : relationshipSourceIssue ? (
          <Card role="alert" className="border-amber-200 bg-amber-50">
            <CardContent className="flex flex-col items-start gap-4 p-5 sm:flex-row sm:justify-between">
              <div className="flex items-start gap-3 text-amber-900">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <h2 className="text-base font-bold">
                    框架合同关联数据暂不可用
                  </h2>
                  <p className="mt-1 text-sm">{relationshipSourceIssue}</p>
                  <p className="mt-1 text-xs leading-5 text-amber-800">
                    框架合同数据源未配置或读取失败时，不展示关联统计和待关联结论。
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={loading || refreshing}
                onClick={() => void loadDashboard(true)}
              >
                <RefreshCw className="h-4 w-4" />
                重新读取
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <SummaryCards summary={dashboard.frameworkRelations.summary} />
            <section
              ref={relationshipRef}
              className="scroll-mt-4"
              aria-labelledby="framework-relationship-title"
            >
              <h2
                id="framework-relationship-title"
                className="text-lg font-bold text-slate-950"
              >
                框架合同与执行合同关联
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                选择框架合同，查看真实关联的执行合同明细。
              </p>
              <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.28fr)]">
                <MasterList
                  items={filteredItems}
                  selectedId={effectiveSelectedId}
                  emptyTitle={emptyTitle}
                  onSelect={viewRelationship}
                />
                <RelationshipDetail item={selected} emptyTitle={emptyTitle} />
              </div>
            </section>
            <FrameworkList
              items={filteredItems}
              total={allItems.length}
              query={query}
              filter={filter}
              onFilter={setFilter}
              onView={(id) => viewRelationship(id, true)}
            />
          </>
        )}
      </main>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'warning';
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === 'warning' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-4 py-3 text-sm',
        tone === 'info'
          ? 'border-blue-200 bg-blue-50 text-blue-700'
          : 'border-amber-200 bg-amber-50 text-amber-800',
      )}
    >
      {children}
    </div>
  );
}

function LoadingState() {
  return (
    <div aria-busy="true" className="space-y-4">
      <p className="text-sm font-medium text-slate-600">
        正在加载框架合同数据…
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 motion-reduce:animate-none" />
        ))}
      </div>
      <Skeleton className="h-80 motion-reduce:animate-none" />
    </div>
  );
}

function LoadFailure({
  detail,
  busy,
  onRetry,
}: {
  detail: string;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <Card role="alert" className="border-rose-200 bg-white">
      <CardContent className="flex flex-col items-center px-5 py-10 text-center">
        <AlertCircle className="h-6 w-6 text-rose-600" />
        <h2 className="mt-3 text-lg font-bold">框架合同数据读取失败</h2>
        <p className="mt-2 text-sm text-slate-600">{detail}</p>
        <Button
          type="button"
          className="mt-5"
          disabled={busy}
          onClick={onRetry}
        >
          <RefreshCw className="h-4 w-4" />
          重新加载
        </Button>
      </CardContent>
    </Card>
  );
}

function formatUpdatedAt(value: string | undefined) {
  if (!value) return '等待首次同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return updatedAtFormatter.format(date);
}

function SummaryCards({
  summary,
}: {
  summary: ContractManagementDashboard['frameworkRelations']['summary'];
}) {
  const metrics = [
    {
      label: '框架合同总数',
      value: formatNumber(summary.totalFrameworks),
    },
    {
      label: '已关联框架合同',
      value: formatNumber(summary.linkedFrameworks),
    },
    {
      label: '已关联执行合同',
      value: formatNumber(summary.linkedExecutionContracts),
    },
    {
      label: '关联执行合同总金额',
      value: formatCurrency(summary.linkedExecutionAmount),
    },
  ];

  return (
    <section
      aria-label="框架合同关联摘要"
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      {metrics.map((metric) => (
        <Card key={metric.label} className="border-slate-200 bg-white">
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">{metric.label}</p>
            <strong className="mt-1 block truncate text-xl font-bold tabular-nums text-slate-950">
              {metric.value}
            </strong>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function MasterList({
  items,
  selectedId,
  emptyTitle,
  onSelect,
}: {
  items: readonly ContractFrameworkRelationItem[];
  selectedId: string | null;
  emptyTitle: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="min-w-0 border-slate-200 bg-white">
      <CardHeader className="border-b border-slate-100 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-950">框架合同</h3>
            <p className="mt-1 text-xs text-slate-500">
              当前筛选 {formatNumber(items.length)} 份
            </p>
          </div>
          <GitBranch className="h-5 w-5 text-blue-600" />
        </div>
      </CardHeader>
      <CardContent className="max-h-[560px] space-y-2 overflow-y-auto p-2">
        {items.length > 0 ? (
          items.map((item) => {
            const isSelected = item.frameworkRecordId === selectedId;
            const effectiveExecutionContractCount =
              countEffectiveExecutionContracts(item);
            return (
              <button
                key={item.frameworkRecordId}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(item.frameworkRecordId)}
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                  isSelected
                    ? 'border-blue-300 bg-blue-50'
                    : 'border-slate-200 bg-white hover:border-blue-200 hover:bg-slate-50',
                )}
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-bold text-slate-950">
                      {item.frameworkName}
                    </p>
                    <p className="mt-1 break-all text-xs text-slate-500">
                      {item.frameworkCode || '编号待补充'}
                    </p>
                  </div>
                  <StatusPill status={item.status} />
                </div>
                <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
                  <span>{formatPeriod(item.startDate, item.endDate)}</span>
                  <span className="font-semibold text-slate-700">
                    {formatNumber(effectiveExecutionContractCount)}{' '}
                    份有效执行合同
                  </span>
                </div>
              </button>
            );
          })
        ) : (
          <Empty
            title={emptyTitle}
            description="请调整页头搜索词或筛选条件。"
          />
        )}
      </CardContent>
    </Card>
  );
}

function RelationshipDetail({
  item,
  emptyTitle,
}: {
  item: ContractFrameworkRelationItem | null;
  emptyTitle: string;
}) {
  if (!item) {
    return (
      <Card className="min-w-0 border-slate-200 bg-white">
        <CardContent className="p-4">
          <Empty
            title={emptyTitle}
            description="请选择可见的框架合同后查看关联详情。"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 border-slate-200 bg-white">
      <CardHeader className="border-b border-slate-100 p-4 sm:p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-bold text-slate-950">
              {item.frameworkName}
            </h3>
            <p className="mt-1 break-all text-xs text-slate-500">
              {item.frameworkCode || '编号待补充'}
            </p>
          </div>
          <StatusPill status={item.status} />
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <Info label="框架状态" value={statusMeta[item.status].label} />
          <Info
            label="合同周期"
            value={formatPeriod(item.startDate, item.endDate)}
          />
          <Info label="执行金额" value={formatCurrency(item.executionAmount)} />
        </dl>
      </CardHeader>
      <CardContent className="p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-bold text-slate-950">执行合同清单</h3>
          <Badge variant="outline">
            {formatNumber(item.executionContracts.length)} 份
          </Badge>
        </div>
        {item.executionContracts.length > 0 ? (
          <div className="space-y-3">
            {item.executionContracts.map((contract) => (
              <article
                key={contract.recordId}
                className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-bold text-slate-950">
                      {contract.name}
                    </p>
                    <p className="mt-1 break-all text-xs text-slate-500">
                      {contract.code || '编号待补充'}
                    </p>
                  </div>
                  <StatusPill status={contract.status} />
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                  <Info label="供应商" value={contract.supplier || '待补充'} />
                  <Info label="负责人" value={contract.owner || '待补充'} />
                  <Info label="到期日" value={formatDate(contract.endDate)} />
                  <Info
                    label="合同金额"
                    value={formatCurrency(contract.amount)}
                  />
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="该框架合同尚未关联执行合同"
            description="请在多维表真实关联字段中维护执行合同关系。"
          />
        )}
      </CardContent>
    </Card>
  );
}

function FrameworkList({
  items,
  total,
  query,
  filter,
  onFilter,
  onView,
}: {
  items: readonly ContractFrameworkRelationItem[];
  total: number;
  query: string;
  filter: FrameworkContractFilter;
  onFilter: (filter: FrameworkContractFilter) => void;
  onView: (id: string) => void;
}) {
  const emptyTitle = total === 0 ? '暂无框架合同' : '未找到匹配的框架合同';

  return (
    <section aria-labelledby="framework-list-title">
      <Card className="min-w-0 border-slate-200 bg-white">
        <CardHeader className="gap-4 border-b border-slate-100 p-4 sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2
                id="framework-list-title"
                className="text-lg font-bold text-slate-950"
              >
                框架合同清单
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {query.trim()
                  ? '搜索“' +
                    query.trim() +
                    '”，显示 ' +
                    formatNumber(items.length) +
                    ' 份'
                  : '共 ' + formatNumber(total) + ' 份框架合同'}
              </p>
            </div>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="框架合同状态筛选"
            >
              {frameworkFilters.map((option) => (
                <Button
                  key={option.key}
                  type="button"
                  size="sm"
                  variant={filter === option.key ? 'default' : 'outline'}
                  aria-pressed={filter === option.key}
                  onClick={() => onFilter(option.key)}
                  className={cn(
                    'h-8',
                    filter !== option.key &&
                      'border-slate-200 bg-white text-slate-600',
                  )}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {items.length > 0 ? (
            <>
              <div className="hidden lg:block">
                <table
                  aria-labelledby="framework-list-title"
                  className="w-full table-fixed text-left text-sm"
                >
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="w-[26%] px-5 py-3 font-semibold">
                        名称编号
                      </th>
                      <th className="w-[18%] px-4 py-3 font-semibold">周期</th>
                      <th className="w-[12%] px-4 py-3 font-semibold">状态</th>
                      <th className="w-[17%] px-4 py-3 font-semibold">
                        有效执行合同
                      </th>
                      <th className="w-[15%] px-4 py-3 text-right font-semibold">
                        执行金额
                      </th>
                      <th className="w-[12%] px-5 py-3 text-right font-semibold">
                        查看关系
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((item) => (
                      <tr key={item.frameworkRecordId} className="align-top">
                        <td className="px-5 py-4">
                          <p className="break-words font-semibold text-slate-950">
                            {item.frameworkName}
                          </p>
                          <p className="mt-1 break-all text-xs text-slate-500">
                            {item.frameworkCode || '编号待补充'}
                          </p>
                        </td>
                        <td className="px-4 py-4 text-slate-600">
                          {formatPeriod(item.startDate, item.endDate)}
                        </td>
                        <td className="px-4 py-4">
                          <StatusPill status={item.status} />
                        </td>
                        <td className="px-4 py-4 text-slate-600">
                          {formatNumber(countEffectiveExecutionContracts(item))}{' '}
                          份有效执行合同
                        </td>
                        <td className="px-4 py-4 text-right font-semibold tabular-nums text-slate-950">
                          {formatCurrency(item.executionAmount)}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-blue-700"
                            onClick={() => onView(item.frameworkRecordId)}
                          >
                            <Eye className="h-4 w-4" />
                            查看关系
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid gap-3 p-3 lg:hidden">
                {items.map((item) => (
                  <Card
                    key={item.frameworkRecordId}
                    className="min-w-0 border-slate-200 shadow-none"
                  >
                    <CardContent className="p-4">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-bold text-slate-950">
                            {item.frameworkName}
                          </p>
                          <p className="mt-1 break-all text-xs text-slate-500">
                            {item.frameworkCode || '编号待补充'}
                          </p>
                        </div>
                        <StatusPill status={item.status} />
                      </div>
                      <dl className="mt-4 grid grid-cols-2 gap-3">
                        <Info
                          label="周期"
                          value={formatPeriod(item.startDate, item.endDate)}
                        />
                        <Info
                          label="有效执行合同"
                          value={
                            formatNumber(
                              countEffectiveExecutionContracts(item),
                            ) + ' 份'
                          }
                        />
                        <Info
                          label="执行金额"
                          value={formatCurrency(item.executionAmount)}
                        />
                      </dl>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-4 w-full border-blue-200 text-blue-700"
                        onClick={() => onView(item.frameworkRecordId)}
                      >
                        <Eye className="h-4 w-4" />
                        查看关系
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          ) : (
            <div className="p-5">
              <Empty
                title={emptyTitle}
                description={
                  total === 0
                    ? '多维表当前没有可展示的框架合同记录。'
                    : '请调整页头搜索词或筛选条件后重试。'
                }
              />
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function StatusPill({ status }: { status: ContractStatus }) {
  const meta = statusMeta[status];
  return (
    <Badge
      variant="outline"
      className={cn('shrink-0 font-semibold', meta.className)}
    >
      {meta.label}
    </Badge>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-slate-800">
        {value}
      </dd>
    </div>
  );
}

function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div
      role="status"
      className="flex min-h-36 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center"
    >
      <FileText className="h-6 w-6 text-slate-400" />
      <p className="mt-3 text-sm font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function formatCurrency(value: number) {
  return currencyFormatter.format(value);
}

function formatDate(value: string | null) {
  if (!value) return '待补充';
  const date = new Date(value + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.format(date);
}

function formatPeriod(startDate: string | null, endDate: string | null) {
  return formatDate(startDate) + ' 至 ' + formatDate(endDate);
}
