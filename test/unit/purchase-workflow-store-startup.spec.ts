import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const actualFsPromises =
  jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
let mockFailStaleLockCleanup = false;

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'),
  unlink: async (path: string) => {
    if (mockFailStaleLockCleanup && path.includes('.stale.')) {
      const error = new Error('simulated stale lock cleanup failure') as Error & {
        code: string;
      };
      error.code = 'EPERM';
      throw error;
    }
    return actualFsPromises.unlink(path);
  },
}));

import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';

describe('PurchaseWorkflowStore startup recovery', () => {
  it('continues startup after a stale lock is quarantined but cannot be deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'purchase-store-startup-'));
    const ledgerPath = join(directory, 'ledger.json');
    const lockPath = `${ledgerPath}.lock`;
    const store = new PurchaseWorkflowStore(ledgerPath);
    const warning = jest.spyOn(process, 'emitWarning').mockImplementation();

    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        instanceId: 'stale-production-owner',
      }),
      'utf8',
    );
    mockFailStaleLockCleanup = true;

    try {
      await expect(store.onModuleInit()).resolves.toBeUndefined();
      await expect(readFile(lockPath, 'utf8')).resolves.toContain(
        `"pid":${process.pid}`,
      );
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('startup will continue'),
        expect.objectContaining({
          code: 'PURCHASE_WORKFLOW_STALE_LOCK_CLEANUP_FAILED',
        }),
      );
    } finally {
      mockFailStaleLockCleanup = false;
      warning.mockRestore();
      await store.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
