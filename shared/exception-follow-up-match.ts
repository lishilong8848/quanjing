import type { ExceptionFollowUpItem } from './api.interface';

export type ExceptionFollowUpIndex = Record<string, ExceptionFollowUpItem[]>;

export function normalizeExceptionFollowUpText(value?: string | null): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function buildExceptionFollowUpDetailedContent(
  abnormalLabel: string,
  detail: string,
): string {
  const label = normalizeExceptionFollowUpText(abnormalLabel);
  const normalizedDetail = normalizeExceptionFollowUpText(detail);
  return label ? `${label}：${normalizedDetail}` : normalizedDetail;
}

export function buildExceptionFollowUpMatchKey(
  date: string,
  abnormalLabel: string,
  detail: string,
): string {
  return `${date}|${buildExceptionFollowUpDetailedContent(abnormalLabel, detail)}`;
}

export function normalizeExceptionFollowUpComparable(value?: string | null): string {
  return normalizeExceptionFollowUpText(value)
    .replace(/[\s,，、;；:：.。!！?？"“”'‘’「」『』()（）\[\]【】<>《》\-—_·]/g, '')
    .toLowerCase();
}

export function buildExceptionFollowUpLooseMatchKey(
  date: string,
  abnormalLabel: string,
  detail: string,
): string {
  return `${date}|${normalizeExceptionFollowUpComparable(
    buildExceptionFollowUpDetailedContent(abnormalLabel, detail),
  )}`;
}

export function buildExceptionFollowUpTargetKeys(
  date: string,
  abnormalLabel: string,
  detail: string,
): string[] {
  return Array.from(new Set([
    buildExceptionFollowUpMatchKey(date, abnormalLabel, detail),
    buildExceptionFollowUpLooseMatchKey(date, abnormalLabel, detail),
  ].filter(Boolean)));
}

export function getExceptionFollowUpItemKeys(item: ExceptionFollowUpItem): string[] {
  return Array.from(new Set([
    item.matchKey,
    buildExceptionFollowUpMatchKey(item.date, item.abnormalLabel, item.detail),
    `${item.date}|${normalizeExceptionFollowUpText(item.detailedContent)}`,
    buildExceptionFollowUpLooseMatchKey(item.date, item.abnormalLabel, item.detail),
    `${item.date}|${normalizeExceptionFollowUpComparable(item.detailedContent)}`,
  ].filter(Boolean)));
}

export function getExceptionFollowUpTime(item: ExceptionFollowUpItem): number {
  const updatedAt = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : 0;
  return (
    (Number.isFinite(updatedAt) ? updatedAt : 0) ||
    (Number.isFinite(createdAt) ? createdAt : 0) ||
    0
  );
}

export function sortExceptionFollowUpItems(items: ExceptionFollowUpItem[]): ExceptionFollowUpItem[] {
  return [...items].sort((a, b) => (
    getExceptionFollowUpTime(b) - getExceptionFollowUpTime(a)
    || b.recordId.localeCompare(a.recordId)
  ));
}

function setItemOnIndex(
  index: ExceptionFollowUpIndex,
  key: string,
  item: ExceptionFollowUpItem,
): void {
  const existing = index[key] || [];
  index[key] = sortExceptionFollowUpItems([
    ...existing.filter((current) => current.recordId !== item.recordId),
    item,
  ]);
}

export function upsertExceptionFollowUpItemInIndex(
  current: ExceptionFollowUpIndex,
  item: ExceptionFollowUpItem,
): ExceptionFollowUpIndex {
  const next: ExceptionFollowUpIndex = {};
  Object.entries(current).forEach(([key, items]) => {
    next[key] = items.filter((currentItem) => currentItem.recordId !== item.recordId);
  });

  getExceptionFollowUpItemKeys(item).forEach((key) => {
    setItemOnIndex(next, key, item);
  });

  Object.keys(next).forEach((key) => {
    if (next[key].length === 0) {
      delete next[key];
    }
  });
  return next;
}

export function removeExceptionFollowUpItemFromIndex(
  current: ExceptionFollowUpIndex,
  item: ExceptionFollowUpItem,
): ExceptionFollowUpIndex {
  const next: ExceptionFollowUpIndex = {};
  Object.entries(current).forEach(([key, items]) => {
    const remaining = items.filter((currentItem) => currentItem.recordId !== item.recordId);
    if (remaining.length > 0) {
      next[key] = remaining;
    }
  });
  return next;
}

export function replaceExceptionFollowUpItemsForDateInIndex(
  current: ExceptionFollowUpIndex,
  date: string,
  items: ExceptionFollowUpItem[],
): ExceptionFollowUpIndex {
  let next: ExceptionFollowUpIndex = {};
  Object.entries(current).forEach(([key, currentItems]) => {
    const remaining = currentItems.filter((item) => item.date !== date);
    if (remaining.length > 0) {
      next[key] = remaining;
    }
  });

  items.forEach((item) => {
    next = upsertExceptionFollowUpItemInIndex(next, item);
  });
  return next;
}

export function indexExceptionFollowUpItems(items: ExceptionFollowUpItem[]): ExceptionFollowUpIndex {
  return items.reduce<ExceptionFollowUpIndex>(
    (index, item) => upsertExceptionFollowUpItemInIndex(index, item),
    {},
  );
}

export function selectExceptionFollowUpsByTarget(
  itemsByKey: ExceptionFollowUpIndex,
  date: string,
  abnormalLabel: string,
  detail: string,
): ExceptionFollowUpItem[] {
  const byRecordId = new Map<string, ExceptionFollowUpItem>();
  for (const key of buildExceptionFollowUpTargetKeys(date, abnormalLabel, detail)) {
    const items = itemsByKey[key] || [];
    items.forEach((item) => {
      byRecordId.set(item.recordId, item);
    });
  }
  return sortExceptionFollowUpItems([...byRecordId.values()]);
}

export function selectExceptionFollowUpByTarget(
  itemsByKey: ExceptionFollowUpIndex | Record<string, ExceptionFollowUpItem>,
  date: string,
  abnormalLabel: string,
  detail: string,
): ExceptionFollowUpItem | null {
  for (const key of buildExceptionFollowUpTargetKeys(date, abnormalLabel, detail)) {
    const value = itemsByKey[key];
    const item = Array.isArray(value) ? value[0] : value;
    if (item) {
      return item;
    }
  }
  return null;
}
