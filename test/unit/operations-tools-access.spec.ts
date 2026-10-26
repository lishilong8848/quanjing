import { canAccessPage } from '../../client/src/access/access-policy';
import { OperationsToolsController } from '../../server/modules/operations-tools/operations-tools.controller';
import { OperationsToolsService } from '../../server/modules/operations-tools/operations-tools.service';
import type { AccessRole } from '../../shared/access-control.interface';

describe('tools page permission parity with inventory', () => {
  it.each<AccessRole>([
    'admin',
    'editor',
    'inventory_admin',
    'building_admin',
    'guest',
    'purchase_admin',
    'purchase_applicant',
    'duty_editor',
    'supply_chain_admin',
    'construction_admin',
  ])('matches inventory access for %s', (role) => {
    expect(canAccessPage(role, '/operations-tools-management')).toBe(
      canAccessPage(role, '/inventory-management'),
    );
  });
  it('rejects missing or unprivileged identity before data access', async () => {
    const service = { getSnapshot: jest.fn() };
    const controller = new OperationsToolsController(
      service as unknown as OperationsToolsService,
    );
    await expect(controller.snapshot({} as never)).rejects.toThrow();
    await expect(
      controller.snapshot({
        accessPrincipal: { role: 'purchase_admin', purchaseBuilding: null },
      } as never),
    ).rejects.toThrow();
    expect(service.getSnapshot).not.toHaveBeenCalled();
  });
});
