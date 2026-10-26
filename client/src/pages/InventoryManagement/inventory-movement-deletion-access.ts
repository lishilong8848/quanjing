import { accessBuildings } from '@shared/building-access';
import type {
  AccessRole,
  BuildingAdminBuilding,
  PurchaseAccessBuilding,
} from '@shared/access-control.interface';
import type { WarehouseBuilding } from '@shared/inventory-management.interface';

export type InventoryMovementDeletionAccess =
  | {
      canDelete: true;
      building: null;
      scope: 'unrestricted';
    }
  | {
      canDelete: true;
      building: WarehouseBuilding | null;
      scope: 'building';
    }
  | {
      canDelete: false;
      building: null;
      scope: 'denied';
    };

export function resolveInventoryMovementDeletionAccess(
  role: AccessRole,
  purchaseBuilding: PurchaseAccessBuilding | BuildingAdminBuilding | null,
  buildings?: readonly BuildingAdminBuilding[],
): InventoryMovementDeletionAccess {
  if (role === 'admin' || role === 'professional_admin' || role === 'professional_engineer') {
    return { canDelete: true, building: null, scope: 'unrestricted' };
  }
  const scope = accessBuildings({ role, purchaseBuilding, buildings });
  if ((role === 'inventory_admin' || role === 'building_admin') && scope?.length) {
    return {
      canDelete: true,
      building: scope.length === 1 ? scope[0] : null,
      scope: 'building',
    };
  }
  return { canDelete: false, building: null, scope: 'denied' };
}
