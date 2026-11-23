import type { PurchaseMethod } from '../../../shared/purchase-application.interface';

export function normalizeRequestedPurchaseMethod(value: unknown): PurchaseMethod | undefined {
  if (value === '综合采购') return value;
  if (value === '需求自采' || value === '需求自采（楼内）') return '需求自采（楼内）';
  return undefined;
}

export function isBuildingSelfPurchaseAllowed(building: string): boolean {
  return (
    building.normalize('NFKC').replace(/\s+/gu, '').toUpperCase() !== 'H楼'
  );
}

export function procurementMethodOptionsLabel(building: string): string {
  return isBuildingSelfPurchaseAllowed(building)
    ? '综合采购 / 楼内自采'
    : '综合采购';
}
