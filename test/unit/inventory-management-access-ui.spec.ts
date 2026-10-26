import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('inventory management building access', () => {
  it('uses a server-side inventory access policy for every scoped read and write', () => {
    const policyPath = join(
      root,
      'server/modules/inventory-management/inventory-access-policy.ts',
    );

    expect(existsSync(policyPath)).toBe(true);
    if (!existsSync(policyPath)) return;

    const policy = readFileSync(policyPath, 'utf8');
    const controller = readFileSync(
      join(
        root,
        'server/modules/inventory-management/inventory-management.controller.ts',
      ),
      'utf8',
    );

    expect(policy).toContain('scopeInventoryDashboard');
    expect(policy).toContain('scopeInventoryItemsQuery');
    expect(policy).toContain('scopeInventoryMovementsQuery');
    expect(policy).toContain('assertInventoryMovementScope');
    expect(policy).toContain('assertPurchaseInboundScope');
    expect(controller).toContain('scopeInventoryDashboard');
    expect(controller).toContain('scopeInventoryItemsQuery');
    expect(controller).toContain('scopeInventoryMovementsQuery');
    expect(controller).toContain('assertInventoryMovementScope');
    expect(controller).toContain('assertPurchaseInboundScope');
  });

  it('exposes movement deletion only to system and scoped inventory administrators', () => {
    const page = readFileSync(
      join(root, 'client/src/pages/InventoryManagement/index.tsx'),
      'utf8',
    );
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(page).toContain('resolveInventoryMovementDeletionAccess');
    expect(page).toContain(
      'canDeleteMovements={movementDeletionAccess.canDelete}',
    );
    expect(page).toContain(
      'movementDeletionBuilding={movementDeletionAccess.building}',
    );
    expect(movementPage).toContain(
      'item.building === movementDeletionBuilding',
    );
    expect(movementPage).toContain('后台尚未确认的记录不能删除');
  });
});
