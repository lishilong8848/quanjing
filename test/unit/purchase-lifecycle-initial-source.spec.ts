import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PURCHASE_LEDGER_CAPABILITY } from '../../server/modules/purchase-inventory/purchase-ledger-capability';

describe('first lifecycle startup on an empty installation', () => {
  it('creates only a source-bound empty ledger once and preserves it on same-source restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lifecycle-first-source-'));
    const path = join(directory, 'ledger.json');
    let store = new PurchaseWorkflowStore(path);
    try {
      await store.onModuleInit();
      await store.bindLifecycleReceiptImageSource('cli_first_source', 'a'.repeat(64));
      const original = await readFile(path);
      const value = JSON.parse(original.toString('utf8'));
      expect(value.requiredRuntimeCapability).toBe(PURCHASE_LEDGER_CAPABILITY);
      expect(value.managerApprovalBatches).toEqual([]);
      expect(await store.hasExistingLifecycleWork()).toBe(false);
      await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
      await store.bindLifecycleReceiptImageSource('cli_first_source', 'a'.repeat(64));
      await store.verifyLifecycleReceiptImageSource('cli_first_source', 'a'.repeat(64));
      expect(await readFile(path)).toEqual(original);
      await expect(store.bindLifecycleReceiptImageSource('cli_first_source', 'b'.repeat(64))).rejects.toThrow();
      expect(await readFile(path)).toEqual(original);
    } finally { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); }
  });
});
