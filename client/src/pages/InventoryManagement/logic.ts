import type {
  PurchaseInventoryAlertItem,
  PurchaseInventoryMovementItem,
} from '@shared/purchase-inventory.interface';

function includesKeyword(values: Array<string | number>, keyword: string) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return true;

  return values
    .join(' ')
    .toLowerCase()
    .includes(normalizedKeyword);
}

export function filterInventoryAlerts(
  items: PurchaseInventoryAlertItem[],
  keyword: string,
): PurchaseInventoryAlertItem[] {
  return items.filter((item) =>
    includesKeyword(
      [
        item.name,
        item.sku,
        item.category,
        item.building,
        item.location,
        ...item.owners,
      ],
      keyword,
    ),
  );
}

export function filterInventoryMovements(
  items: PurchaseInventoryMovementItem[],
  keyword: string,
): PurchaseInventoryMovementItem[] {
  return items.filter((item) =>
    includesKeyword(
      [
        item.name,
        item.sku,
        item.building,
        item.location,
        item.sourceOrReason,
        item.operator,
        item.status,
      ],
      keyword,
    ),
  );
}

export type PendingPurchaseDeepLinkResolution<T> =
  | { status: 'found'; item: T }
  | { status: 'missing' }
  | { status: 'read_failed' };

export async function resolvePendingPurchaseDeepLink<
  T extends { executionRecordId: string },
>(
  executionRecordId: string,
  load: (forceRefresh: boolean) => Promise<T[] | null>,
): Promise<PendingPurchaseDeepLinkResolution<T>> {
  const cachedItems = await load(false);
  if (!cachedItems) return { status: 'read_failed' };

  const cachedTarget = cachedItems.find(
    (item) => item.executionRecordId === executionRecordId,
  );
  if (cachedTarget) return { status: 'found', item: cachedTarget };

  const refreshedItems = await load(true);
  if (!refreshedItems) return { status: 'read_failed' };

  const refreshedTarget = refreshedItems.find(
    (item) => item.executionRecordId === executionRecordId,
  );
  return refreshedTarget
    ? { status: 'found', item: refreshedTarget }
    : { status: 'missing' };
}
