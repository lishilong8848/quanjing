export const PURCHASE_INVENTORY_MANAGEMENT_PATH =
  '/purchase-inventory-management';

export const PURCHASE_APPLICATION_DIRECT_PATH =
  '/purchase-inventory-management/apply/new';

export function isPurchaseApplicationDirectPath(pathname: string): boolean {
  const normalizedPathname =
    String(pathname || '/')
      .toLowerCase()
      .replace(/\/+$/g, '') || '/';

  return normalizedPathname === PURCHASE_APPLICATION_DIRECT_PATH;
}
