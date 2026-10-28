import type { AccessPrincipal } from '@shared/access-control.interface';
import { decideBusinessPermission, hasBusinessPermissionSomewhere, type BusinessAction } from '@shared/business-permissions';
import type { InventoryManagementItem } from '@shared/inventory-management.interface';
import type { StocktakeLine, StocktakeSheet } from '@shared/inventory-stocktake.interface';

export function canUseStocktakeAction(principal: AccessPrincipal, action: BusinessAction, inventory?: InventoryManagementItem): boolean {
  if (!principal.effectiveAuthorization) return true;
  return inventory
    ? decideBusinessPermission(principal, { module: 'stocktake', action, building: inventory.building, specialty: inventory.specialty }).allowed
    : hasBusinessPermissionSomewhere(principal, { module: 'stocktake', action });
}

export function canUseStocktakeLines(principal: AccessPrincipal, action: BusinessAction, lines: readonly StocktakeLine[]): boolean {
  return canUseStocktakeAction(principal, action) && lines.every(line => canUseStocktakeAction(principal, action, line.inventory));
}

export function canUndoStocktakeBatch(principal: AccessPrincipal, sheet: StocktakeSheet | null): boolean {
  if (!sheet?.latestBulk) return false;
  const ids = sheet.latestBulk.recordIds;
  if (!ids) return canUseStocktakeLines(principal, 'delete', sheet.lines);
  if (ids.length !== sheet.latestBulk.count || new Set(ids).size !== ids.length) return false;
  const lines = ids.map(id => sheet.lines.find(line => line.inventory.recordId === id));
  return lines.every((line): line is StocktakeLine => Boolean(line)) && canUseStocktakeLines(principal, 'delete', lines);
}
