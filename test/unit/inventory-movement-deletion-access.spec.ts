import type {
  AccessRole,
  PurchaseAccessBuilding,
} from '../../shared/access-control.interface';

type Resolver = (
  role: AccessRole,
  building: PurchaseAccessBuilding | null,
) => {
  canDelete: boolean;
  building: PurchaseAccessBuilding | null;
  scope: 'unrestricted' | 'building' | 'denied';
};

function loadResolver(): Resolver | undefined {
  try {
    return (
      require('../../client/src/pages/InventoryManagement/inventory-movement-deletion-access') as {
        resolveInventoryMovementDeletionAccess?: Resolver;
      }
    ).resolveInventoryMovementDeletionAccess;
  } catch {
    return undefined;
  }
}

describe('inventory movement deletion frontend access', () => {
  it('distinguishes unrestricted admin, scoped inventory admin, and missing scope', () => {
    const resolveAccess = loadResolver();
    expect(resolveAccess).toBeInstanceOf(Function);
    if (!resolveAccess) return;

    expect(resolveAccess('admin', null)).toEqual({
      canDelete: true,
      building: null,
      scope: 'unrestricted',
    });
    expect(resolveAccess('inventory_admin', 'A楼')).toEqual({
      canDelete: true,
      building: 'A楼',
      scope: 'building',
    });
    expect(resolveAccess('inventory_admin', null)).toEqual({
      canDelete: false,
      building: null,
      scope: 'denied',
    });
    expect(resolveAccess('editor', 'A楼')).toEqual({
      canDelete: false,
      building: null,
      scope: 'denied',
    });
  });
});
