import type { PurchaseInventoryRequestItem } from '@shared/purchase-inventory.interface';

export interface PurchaseCompletionDimension {
  label: string;
  count: number;
  amount: number;
  share: number;
}

export interface PurchaseCompletionAnalysis {
  year: number;
  completedCount: number;
  yearCompletedCount: number;
  yearAmount: number;
  averageAmount: number;
  completionRate: number;
  datedCount: number;
  undatedCount: number;
  monthly: Array<{
    month: number;
    label: string;
    count: number;
    amount: number;
  }>;
  categoryRanking: PurchaseCompletionDimension[];
  buildingRanking: PurchaseCompletionDimension[];
  supplierRanking: PurchaseCompletionDimension[];
  completedItems: PurchaseInventoryRequestItem[];
}

export type PurchaseCompletionDateRange = 'all' | '7d' | '30d' | 'year';

export interface PurchaseCompletionFilters {
  query: string;
  building: string;
  supplier: string;
  category: string;
  dateRange: PurchaseCompletionDateRange;
  now?: Date;
}

function completedDate(item: PurchaseInventoryRequestItem): Date | null {
  const value = item.receivedAt || item.createdAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function itemAmount(item: PurchaseInventoryRequestItem): number {
  return item.actualAmount ?? item.estimatedAmount;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

export function filterCompletedPurchaseItems(
  items: PurchaseInventoryRequestItem[],
  filters: PurchaseCompletionFilters,
): PurchaseInventoryRequestItem[] {
  const queryTokens = filters.query
    .trim()
    .split(/\s+/)
    .map(normalizeSearchText)
    .filter(Boolean);
  const now = filters.now ?? new Date();

  return items.filter((item) => {
    if (filters.building !== 'all' && item.building !== filters.building) {
      return false;
    }
    if (filters.supplier !== 'all' && item.supplier !== filters.supplier) {
      return false;
    }
    const category = item.primaryCategory || item.secondaryCategory || '未分类';
    if (filters.category !== 'all' && category !== filters.category) {
      return false;
    }
    if (!matchesCompletionDateRange(item, filters.dateRange, now)) return false;
    if (!queryTokens.length) return true;

    const searchable = [
      item.requestCode,
      item.title,
      item.requester,
      item.purchaser,
      item.supplier,
      item.building,
      item.specialty,
      item.primaryCategory,
      item.secondaryCategory,
      item.notes,
    ].map(normalizeSearchText);
    return queryTokens.every((token) =>
      searchable.some((value) => value.includes(token)),
    );
  });
}

function matchesCompletionDateRange(
  item: PurchaseInventoryRequestItem,
  range: PurchaseCompletionDateRange,
  now: Date,
): boolean {
  if (range === 'all') return true;
  const date = completedDate(item);
  if (!date) return false;
  if (range === 'year') return date.getFullYear() === now.getFullYear();
  const days = range === '7d' ? 7 : 30;
  return date.getTime() >= now.getTime() - days * 24 * 60 * 60 * 1000;
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN');
}

function buildDimension(
  items: PurchaseInventoryRequestItem[],
  getLabel: (item: PurchaseInventoryRequestItem) => string,
  sortBy: 'count' | 'amount',
): PurchaseCompletionDimension[] {
  const grouped = new Map<string, { count: number; amount: number }>();
  let totalAmount = 0;

  for (const item of items) {
    const label = getLabel(item);
    const amount = itemAmount(item);
    const current = grouped.get(label) ?? { count: 0, amount: 0 };
    current.count += 1;
    current.amount += amount;
    totalAmount += amount;
    grouped.set(label, current);
  }

  return Array.from(grouped.entries())
    .map(([label, value]) => ({
      label,
      count: value.count,
      amount: value.amount,
      share: totalAmount ? roundOne((value.amount / totalAmount) * 100) : 0,
    }))
    .sort((first, second) => {
      const primary = second[sortBy] - first[sortBy];
      if (primary) return primary;
      return second.amount - first.amount || first.label.localeCompare(second.label);
    });
}

export function buildPurchaseCompletionAnalysis(
  requests: PurchaseInventoryRequestItem[],
  totalRequests: number,
  year = new Date().getFullYear(),
): PurchaseCompletionAnalysis {
  const completedItems = requests
    .filter((item) => item.stage === 'stocked')
    .sort((first, second) => {
      const firstTime = completedDate(first)?.getTime() ?? -1;
      const secondTime = completedDate(second)?.getTime() ?? -1;
      return secondTime - firstTime;
    });
  const monthly = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    label: `${index + 1}月`,
    count: 0,
    amount: 0,
  }));

  let datedCount = 0;
  let yearCompletedCount = 0;
  let yearAmount = 0;

  for (const item of completedItems) {
    const date = completedDate(item);
    if (!date) continue;
    datedCount += 1;
    if (date.getUTCFullYear() !== year) continue;

    const bucket = monthly[date.getUTCMonth()];
    const amount = itemAmount(item);
    bucket.count += 1;
    bucket.amount += amount;
    yearCompletedCount += 1;
    yearAmount += amount;
  }

  return {
    year,
    completedCount: completedItems.length,
    yearCompletedCount,
    yearAmount,
    averageAmount: yearCompletedCount ? yearAmount / yearCompletedCount : 0,
    completionRate: totalRequests
      ? roundOne((completedItems.length / totalRequests) * 100)
      : 0,
    datedCount,
    undatedCount: completedItems.length - datedCount,
    monthly,
    categoryRanking: buildDimension(
      completedItems,
      (item) => item.primaryCategory || item.secondaryCategory || '未分类',
      'count',
    ),
    buildingRanking: buildDimension(
      completedItems,
      (item) => item.building || '楼栋未填写',
      'count',
    ),
    supplierRanking: buildDimension(
      completedItems,
      (item) => item.supplier || '供应商未填写',
      'amount',
    ),
    completedItems,
  };
}
