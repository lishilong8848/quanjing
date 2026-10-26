import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('purchase completion module wiring', () => {
  it('exports the workflow service and imports the purchase module in one direction', () => {
    const purchaseModuleSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/purchase-inventory/purchase-inventory.module.ts',
      ),
      'utf8',
    );
    const inventoryModuleSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/inventory-management/inventory-management.module.ts',
      ),
      'utf8',
    );

    expect(purchaseModuleSource).toMatch(
      /exports:\s*\[[\s\S]*PurchaseWorkflowService[\s\S]*\]/,
    );
    expect(purchaseModuleSource).not.toContain('InventoryManagementModule');
    expect(inventoryModuleSource).toContain(
      "import { PurchaseInventoryModule } from '../purchase-inventory/purchase-inventory.module';",
    );
    expect(inventoryModuleSource).toMatch(
      /imports:\s*\[[\s\S]*PurchaseInventoryModule[\s\S]*\]/,
    );
  });

  it('registers the independent manager worker without replacing the legacy scheduler', () => {
    const purchaseModuleSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/purchase-inventory/purchase-inventory.module.ts',
      ),
      'utf8',
    );
    const legacySchedulerSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/purchase-inventory/purchase-workflow.scheduler.ts',
      ),
      'utf8',
    );

    expect(purchaseModuleSource).toContain(
      "import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';",
    );
    expect(purchaseModuleSource).toContain(
      "import { PurchaseManagerApprovalScheduler } from './purchase-manager-approval.scheduler';",
    );
    expect(purchaseModuleSource).toMatch(
      /providers:\s*\[[\s\S]*PurchaseWorkflowScheduler[\s\S]*PurchaseManagerApprovalService[\s\S]*PurchaseManagerApprovalScheduler[\s\S]*\]/,
    );
    expect(legacySchedulerSource).toContain(
      'if (!this.service.isEnabled()) return;',
    );
    expect(legacySchedulerSource).not.toContain(
      'PurchaseManagerApprovalScheduler',
    );
  });
});
