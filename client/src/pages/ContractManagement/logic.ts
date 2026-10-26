import type {
  ContractManagementItem,
  ContractPaymentFollowUpItem,
  ContractPaymentItem,
  ContractStatus,
} from '@shared/contract-management.interface';

export type ContractStatusFilter = ContractStatus | 'all';
export type PaymentAttentionTab = 'overdue' | 'upcoming';

export interface PaginatedItems<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number,
): PaginatedItems<T> {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / normalizedPageSize));
  const normalizedPage = Math.min(
    totalPages,
    Math.max(1, Math.floor(page) || 1),
  );
  const start = (normalizedPage - 1) * normalizedPageSize;
  return {
    items: items.slice(start, start + normalizedPageSize),
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalItems: items.length,
    totalPages,
  };
}

const SHANGHAI_MONTH_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
});

export interface PaymentMonthlyTrendItem {
  month: string;
  label: string;
  amount: number;
  basis: 'actual' | 'planned';
  isCurrent: boolean;
}

export interface PaymentMonthlyTrendChartItem extends PaymentMonthlyTrendItem {
  historyAmount: number | null;
  futureAmount: number | null;
}

export type PendingPaymentStatus = 'overdue' | 'pending';

export interface PendingPaymentAnalyticsSection {
  status: PendingPaymentStatus;
  label: string;
  pendingAmount: number;
  count: number;
  items: ContractPaymentItem[];
}

export interface PendingPaymentAnalyticsGroup {
  year: string;
  pendingAmount: number;
  count: number;
  sections: PendingPaymentAnalyticsSection[];
}

export interface PendingPaymentAnalytics {
  totalPendingAmount: number;
  yearSummary: Array<{
    year: string;
    pendingAmount: number;
    count: number;
  }>;
  statusSummary: Array<{
    status: PendingPaymentStatus;
    label: string;
    pendingAmount: number;
    count: number;
  }>;
  groups: PendingPaymentAnalyticsGroup[];
}

export function sumActiveContractValue(
  contracts: ContractManagementItem[],
): number {
  return roundMoney(
    contracts
      .filter(isActiveContract)
      .reduce((total, item) => total + finiteAmount(item.amount), 0),
  );
}

export function getTopActiveContractsByAmount(
  contracts: ContractManagementItem[],
  limit = 5,
): ContractManagementItem[] {
  const normalizedLimit = Math.max(0, Math.floor(limit) || 0);
  return contracts
    .filter(isActiveContract)
    .sort(
      (left, right) =>
        finiteAmount(right.amount) - finiteAmount(left.amount) ||
        left.code.localeCompare(right.code, 'zh-CN') ||
        left.recordId.localeCompare(right.recordId),
    )
    .slice(0, normalizedLimit);
}

export function buildPaymentPlanMonthlyTrend(
  payments: ContractPaymentItem[],
  generatedAt: string,
): PaymentMonthlyTrendItem[] {
  const reference = new Date(generatedAt);
  if (Number.isNaN(reference.getTime())) return [];

  const current = getShanghaiYearMonth(reference);
  if (!current) return [];

  const actualAmountByMonth = new Map<string, number>();
  const plannedAmountByMonth = new Map<string, number>();
  for (const item of payments) {
    const month = item.dueDate?.match(/^\d{4}-\d{2}/)?.[0];
    if (!month) continue;
    actualAmountByMonth.set(
      month,
      (actualAmountByMonth.get(month) ?? 0) + finiteAmount(item.actualAmount),
    );
    plannedAmountByMonth.set(
      month,
      (plannedAmountByMonth.get(month) ?? 0) + finiteAmount(item.plannedAmount),
    );
  }

  return Array.from({ length: 7 }, (_, index) => {
    const offset = index - 3;
    const date = new Date(
      Date.UTC(current.year, current.month - 1 + offset, 1),
    );
    const year = date.getUTCFullYear();
    const monthNumber = date.getUTCMonth() + 1;
    const monthPart = String(monthNumber).padStart(2, '0');
    const month = `${year}-${monthPart}`;
    const basis = offset < 0 ? 'actual' : 'planned';
    return {
      month,
      label: `${monthPart}月`,
      amount: roundMoney(
        (basis === 'actual' ? actualAmountByMonth : plannedAmountByMonth).get(
          month,
        ) ?? 0,
      ),
      basis,
      isCurrent: offset === 0,
    };
  });
}

export function buildPaymentTrendChartItems(
  items: PaymentMonthlyTrendItem[],
): PaymentMonthlyTrendChartItem[] {
  return items.map((item) => ({
    ...item,
    historyAmount:
      item.basis === 'actual' || item.isCurrent ? item.amount : null,
    futureAmount: item.basis === 'planned' ? item.amount : null,
  }));
}

export function buildPendingPaymentAnalytics(
  payments: ContractPaymentItem[],
): PendingPaymentAnalytics {
  const pending = findPendingPaymentItems(payments);
  const statusOrder: PendingPaymentStatus[] = ['overdue', 'pending'];
  const statusLabels: Record<PendingPaymentStatus, string> = {
    overdue: '已逾期',
    pending: '待付款',
  };
  const itemsByYear = new Map<
    string,
    Map<PendingPaymentStatus, ContractPaymentItem[]>
  >();

  for (const item of pending) {
    const year = item.dueDate?.match(/^\d{4}/)?.[0] ?? '日期待补充';
    const status: PendingPaymentStatus =
      item.daysUntilDue !== null && item.daysUntilDue < 0
        ? 'overdue'
        : 'pending';
    const statusGroups =
      itemsByYear.get(year) ??
      new Map<PendingPaymentStatus, ContractPaymentItem[]>();
    const items = statusGroups.get(status) ?? [];
    items.push(item);
    statusGroups.set(status, items);
    itemsByYear.set(year, statusGroups);
  }

  const years = [...itemsByYear.keys()].sort((left, right) => {
    if (left === '日期待补充') return 1;
    if (right === '日期待补充') return -1;
    return left.localeCompare(right);
  });
  const groups = years.map((year): PendingPaymentAnalyticsGroup => {
    const statusGroups = itemsByYear.get(year);
    const sections = statusOrder.flatMap(
      (status): PendingPaymentAnalyticsSection[] => {
        const items = statusGroups?.get(status) ?? [];
        if (!items.length) return [];
        return [
          {
            status,
            label: statusLabels[status],
            pendingAmount: sumPendingAmount(items),
            count: items.length,
            items,
          },
        ];
      },
    );
    return {
      year,
      pendingAmount: roundMoney(
        sections.reduce((total, section) => total + section.pendingAmount, 0),
      ),
      count: sections.reduce((total, section) => total + section.count, 0),
      sections,
    };
  });
  const statusSummary = statusOrder.map((status) => {
    const items = pending.filter((item) =>
      status === 'overdue'
        ? item.daysUntilDue !== null && item.daysUntilDue < 0
        : item.daysUntilDue === null || item.daysUntilDue >= 0,
    );
    return {
      status,
      label: statusLabels[status],
      pendingAmount: sumPendingAmount(items),
      count: items.length,
    };
  });

  return {
    totalPendingAmount: sumPendingAmount(pending),
    yearSummary: groups.map(({ year, pendingAmount, count }) => ({
      year,
      pendingAmount,
      count,
    })),
    statusSummary,
    groups,
  };
}

export function filterContracts(
  contracts: ContractManagementItem[],
  status: ContractStatusFilter,
  query: string,
): ContractManagementItem[] {
  return contracts.filter((contract) => {
    if (status !== 'all' && contract.status !== status) return false;
    return contractMatchesQuery(contract, query);
  });
}

export function findContractQuickSearchResults(
  contracts: ContractManagementItem[],
  query: string,
  limit = 6,
): ContractManagementItem[] {
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  if (!normalizedLimit) return [];
  const queryTokens = normalizeSearchTokens(query);
  if (!queryTokens.length) return [];
  const compactQuery = compactSearchValue(query);

  return contracts
    .flatMap((contract, index) => {
      if (!contractMatchesTokens(contract, queryTokens)) return [];
      return [
        {
          contract,
          index,
          score: scoreContractSearchMatch(contract, compactQuery),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.contract.code.localeCompare(right.contract.code, 'zh-CN') ||
        left.index - right.index,
    )
    .slice(0, normalizedLimit)
    .map(({ contract }) => contract);
}

function contractMatchesQuery(
  contract: ContractManagementItem,
  query: string,
): boolean {
  const tokens = normalizeSearchTokens(query);
  return !tokens.length || contractMatchesTokens(contract, tokens);
}

function contractMatchesTokens(
  contract: ContractManagementItem,
  tokens: string[],
): boolean {
  const searchable = compactSearchValue(
    [
      contract.code,
      contract.name,
      contract.supplier,
      contract.owner,
      contract.contractType,
      contract.specialty,
    ].join(' '),
  );
  return tokens.every((token) => searchable.includes(token));
}

function normalizeSearchTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/)
    .map(compactSearchValue)
    .filter(Boolean);
}

function compactSearchValue(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\-_/·.,，。:：;；()（）\[\]【】]+/g, '');
}

function scoreContractSearchMatch(
  contract: ContractManagementItem,
  compactQuery: string,
): number {
  const code = compactSearchValue(contract.code);
  const name = compactSearchValue(contract.name);
  if (code === compactQuery) return 0;
  if (code.startsWith(compactQuery)) return 1;
  if (code.includes(compactQuery)) return 2;
  if (name.startsWith(compactQuery)) return 3;
  if (name.includes(compactQuery)) return 4;
  return 5;
}

export function countExpiredContractsInGeneratedMonth(
  contracts: ContractManagementItem[],
  generatedAt: string,
): number {
  const reference = new Date(generatedAt);
  if (Number.isNaN(reference.getTime())) return 0;

  const parts = SHANGHAI_MONTH_FORMATTER.formatToParts(reference);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) return 0;

  const monthPrefix = `${year}-${month}-`;
  return contracts.filter(
    (contract) =>
      contract.status === 'expired' &&
      contract.endDate?.startsWith(monthPrefix),
  ).length;
}

export function partitionPaymentAttentionItems(
  payments: ContractPaymentItem[],
): Record<PaymentAttentionTab, ContractPaymentItem[]> {
  const pending = findPendingPaymentItems(payments);
  const byPlanDate = (left: ContractPaymentItem, right: ContractPaymentItem) =>
    (left.daysUntilDue ?? Number.MAX_SAFE_INTEGER) -
      (right.daysUntilDue ?? Number.MAX_SAFE_INTEGER) ||
    left.recordId.localeCompare(right.recordId);

  return {
    overdue: pending
      .filter((item) => item.daysUntilDue !== null && item.daysUntilDue <= 0)
      .sort(byPlanDate),
    upcoming: pending
      .filter(
        (item) =>
          item.daysUntilDue !== null &&
          item.daysUntilDue > 0 &&
          item.daysUntilDue <= 30,
      )
      .sort(byPlanDate),
  };
}

export function findPendingPaymentItems(
  payments: ContractPaymentItem[],
): ContractPaymentItem[] {
  return payments
    .filter(
      (item) =>
        item.plannedAmount > 0 &&
        item.actualAmount < item.plannedAmount &&
        !isPaymentCompleted(item),
    )
    .sort(
      (left, right) =>
        (left.dueDate ?? '9999-12-31').localeCompare(
          right.dueDate ?? '9999-12-31',
        ) || left.recordId.localeCompare(right.recordId),
    );
}

export function findContractsWithoutPaymentPlans(
  contracts: ContractManagementItem[],
  payments: ContractPaymentItem[],
): ContractManagementItem[] {
  const linkedContractIds = new Set(
    payments.map((item) => item.contractRecordId).filter(Boolean),
  );
  return contracts.filter(
    (item) =>
      !item.paymentFollowUpDisposition?.includes('无需付款') &&
      !linkedContractIds.has(item.recordId),
  );
}

export function buildPaymentFollowUpTarget(
  contract: ContractManagementItem,
  payments: ContractPaymentItem[],
): ContractPaymentFollowUpItem {
  const related = payments.filter(
    (item) => item.contractRecordId === contract.recordId,
  );
  const unpaid = related.filter((item) => !isPaymentCompleted(item));
  return {
    contractRecordId: contract.recordId,
    contractName: contract.name,
    contractCode: contract.code,
    owner: contract.owner,
    contractAmount: contract.amount,
    contractEndDate: contract.endDate || '',
    reason: related.length ? 'unpaid_plan' : 'missing_plan',
    planCount: related.length,
    unpaidPlanCount: unpaid.length,
    plannedAmount: related.reduce(
      (total, item) => total + item.plannedAmount,
      0,
    ),
    paidAmount: related.reduce((total, item) => total + item.actualAmount, 0),
    pendingAmount: related.reduce(
      (total, item) =>
        total + Math.max(0, item.plannedAmount - item.actualAmount),
      0,
    ),
    attachments: contract.attachments,
  };
}

function isPaymentCompleted(item: ContractPaymentItem): boolean {
  return (
    item.risk === 'completed' ||
    item.status.includes('已付款') ||
    (item.plannedAmount > 0 && item.actualAmount >= item.plannedAmount)
  );
}

function isActiveContract(item: ContractManagementItem): boolean {
  return item.status === 'active' || item.status === 'expiring';
}

function finiteAmount(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sumPendingAmount(items: ContractPaymentItem[]): number {
  return roundMoney(
    items.reduce(
      (total, item) =>
        total +
        Math.max(
          0,
          finiteAmount(item.plannedAmount) - finiteAmount(item.actualAmount),
        ),
      0,
    ),
  );
}

function getShanghaiYearMonth(
  value: Date,
): { year: number; month: number } | null {
  const parts = SHANGHAI_MONTH_FORMATTER.formatToParts(value);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  return Number.isInteger(year) && Number.isInteger(month)
    ? { year, month }
    : null;
}
