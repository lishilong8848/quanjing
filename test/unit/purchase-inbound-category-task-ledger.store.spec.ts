import { ConflictException } from '@nestjs/common';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PURCHASE_ACCESS_BUILDINGS } from '../../shared/access-control.interface';
import type { PurchaseInboundCategoryPrepareRequest } from '../../shared/inventory-management.interface';
import {
  PurchaseInboundCategoryTaskLedgerStore,
  buildPurchaseInboundCategoryRequestFingerprint,
} from '../../server/modules/inventory-management/purchase-inbound-category-task-ledger.store';

const REQUEST: PurchaseInboundCategoryPrepareRequest = {
  executionRecordId: 'exec-category-1',
  clientMutationId: 'purchase-category-001',
  building: 'A楼',
  quantity: 1,
  occurredAt: '2026-08-20T01:00:00.000Z',
  newItem: {
    primaryCategory: 'A备品备件类',
    secondaryCategory: '常备件A2',
    name: '开利达单个执行器',
    specification: 'KLD400系列B3S',
    location: 'A-1F-126储藏室01-1F',
    locationRecordId: 'location-a-126',
    brand: '开利达',
    unit: '只',
    minimumQuantity: 0,
  },
};

describe('PurchaseInboundCategoryTaskLedgerStore', () => {
  let directory: string;
  let ledgerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'purchase-category-ledger-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('durably reserves one task for the same mutation across store instances', async () => {
    const first = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);
    const second = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);

    const reserved = await first.reserve(pendingEntry());
    const duplicate = await second.reserve({
      ...pendingEntry(),
      task: { ...pendingEntry().task, id: 'purchase-category-task-other' },
    });

    expect(reserved.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
    expect(existsSync(ledgerPath)).toBe(true);
  });

  it('reuses the same category task after re-login changes only the principal fingerprint', async () => {
    const store = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);
    const reserved = await store.reserve(pendingEntry());

    const duplicate = await store.reserve({
      ...pendingEntry(),
      principalFingerprint: 'principal-category-after-relogin',
      task: { ...pendingEntry().task, id: 'purchase-category-task-other' },
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
  });

  it('recovers an existing raw-JSON fingerprint from the legacy category ledger', async () => {
    const first = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);
    const reserved = await first.reserve(pendingEntry());
    const legacyFingerprint = createHash('sha256')
      .update(JSON.stringify(REQUEST))
      .digest('hex');
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{ requestFingerprint: string }>;
    };
    expect(legacyFingerprint).not.toBe(
      persisted.entries[0]?.requestFingerprint,
    );
    persisted.entries[0]!.requestFingerprint = legacyFingerprint;
    writeFileSync(ledgerPath, JSON.stringify(persisted), 'utf8');

    const duplicate = await new PurchaseInboundCategoryTaskLedgerStore(
      ledgerPath,
    ).reserve({
      ...pendingEntry(),
      task: { ...pendingEntry().task, id: 'purchase-category-task-other' },
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
  });

  it('migrates a legacy equivalent request and enriches it with the current location record', async () => {
    const {
      locationRecordId: _locationRecordId,
      brand: _brand,
      unit: _unit,
      minimumQuantity: _minimumQuantity,
      ...legacyNewItem
    } = REQUEST.newItem;
    const legacyRequest: PurchaseInboundCategoryPrepareRequest = {
      ...REQUEST,
      occurredAt: '2026-08-20T01:00:00Z',
      newItem: legacyNewItem,
    };
    const currentRequest: PurchaseInboundCategoryPrepareRequest = {
      ...REQUEST,
      newItem: {
        ...REQUEST.newItem,
        brand: '',
        unit: '',
        minimumQuantity: 0,
      },
    };
    const store = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);
    const reserved = await store.reserve(pendingEntry(legacyRequest));

    const duplicate = await store.reserve({
      ...pendingEntry(currentRequest),
      task: { ...pendingEntry().task, id: 'purchase-category-task-other' },
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
    expect(duplicate.entry.request).toEqual(currentRequest);
    expect(duplicate.entry.requestFingerprint).toBe(
      buildPurchaseInboundCategoryRequestFingerprint(currentRequest),
    );
  });

  it('rejects a different location record when both requests have stable record ids', async () => {
    const store = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());

    await expect(
      store.reserve(
        pendingEntry({
          ...REQUEST,
          newItem: {
            ...REQUEST.newItem,
            locationRecordId: 'location-a-126-other',
          },
        }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it.each([
    [
      'location text',
      {
        ...REQUEST,
        newItem: { ...REQUEST.newItem, location: 'A-1F-other-location' },
      },
    ],
    ['occurred timestamp', { ...REQUEST, occurredAt: '2026-08-20T01:00:01Z' }],
  ])('rejects a legacy retry with different %s', async (_label, changed) => {
    const store = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());

    await expect(store.reserve(pendingEntry(changed))).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects reusing one mutation id for different category data', async () => {
    const store = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());

    await expect(
      store.reserve(
        pendingEntry({
          ...REQUEST,
          newItem: { ...REQUEST.newItem, name: '不同物品' },
        }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('builds the same category fingerprint regardless of object property order', () => {
    const reordered: PurchaseInboundCategoryPrepareRequest = {
      newItem: {
        minimumQuantity: REQUEST.newItem.minimumQuantity,
        unit: REQUEST.newItem.unit,
        brand: REQUEST.newItem.brand,
        locationRecordId: REQUEST.newItem.locationRecordId,
        location: REQUEST.newItem.location,
        specification: REQUEST.newItem.specification,
        name: REQUEST.newItem.name,
        secondaryCategory: REQUEST.newItem.secondaryCategory,
        primaryCategory: REQUEST.newItem.primaryCategory,
      },
      occurredAt: REQUEST.occurredAt,
      quantity: REQUEST.quantity,
      building: REQUEST.building,
      clientMutationId: REQUEST.clientMutationId,
      executionRecordId: REQUEST.executionRecordId,
    };

    expect(buildPurchaseInboundCategoryRequestFingerprint(reordered)).toBe(
      buildPurchaseInboundCategoryRequestFingerprint(REQUEST),
    );
  });

  it('builds the same category fingerprint for missing and explicit undefined optional fields', () => {
    const {
      brand: _brand,
      minimumQuantity: _minimum,
      ...requiredNewItem
    } = REQUEST.newItem;
    const missing: PurchaseInboundCategoryPrepareRequest = {
      ...REQUEST,
      newItem: requiredNewItem,
    };
    const explicitUndefined: PurchaseInboundCategoryPrepareRequest = {
      ...missing,
      newItem: {
        ...missing.newItem,
        brand: undefined,
        minimumQuantity: undefined,
      },
    };

    expect(
      buildPurchaseInboundCategoryRequestFingerprint(explicitUndefined),
    ).toBe(buildPurchaseInboundCategoryRequestFingerprint(missing));
  });

  it('builds the same category fingerprint after trimming cleanable string fields', () => {
    const padded: PurchaseInboundCategoryPrepareRequest = {
      ...REQUEST,
      executionRecordId: `  ${REQUEST.executionRecordId}  `,
      clientMutationId: `  ${REQUEST.clientMutationId}  `,
      occurredAt: `  ${REQUEST.occurredAt}  `,
      newItem: Object.fromEntries(
        Object.entries(REQUEST.newItem).map(([key, value]) => [
          key,
          typeof value === 'string' ? `  ${value}  ` : value,
        ]),
      ) as unknown as PurchaseInboundCategoryPrepareRequest['newItem'],
    };

    expect(buildPurchaseInboundCategoryRequestFingerprint(padded)).toBe(
      buildPurchaseInboundCategoryRequestFingerprint(REQUEST),
    );
  });

  it.each([
    ['quantity', { ...REQUEST, quantity: REQUEST.quantity + 1 }],
    [
      'building',
      {
        ...REQUEST,
        building: PURCHASE_ACCESS_BUILDINGS.find(
          (building) => building !== REQUEST.building,
        )!,
      },
    ],
    [
      'secondary category',
      {
        ...REQUEST,
        newItem: {
          ...REQUEST.newItem,
          secondaryCategory: `${REQUEST.newItem.secondaryCategory}-changed`,
        },
      },
    ],
  ])('changes the category fingerprint when %s changes', (_label, changed) => {
    expect(buildPurchaseInboundCategoryRequestFingerprint(changed)).not.toBe(
      buildPurchaseInboundCategoryRequestFingerprint(REQUEST),
    );
  });

  it('recovers a claimed running task after its lease expires', async () => {
    let now = new Date('2026-08-20T01:00:00.000Z');
    const first = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    await first.reserve(pendingEntry());
    expect((await first.claimPending('purchase-category-task-1')).claimed).toBe(
      true,
    );

    now = new Date('2026-08-20T01:00:02.000Z');
    const restarted = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    const recovered = await restarted.claimPending('purchase-category-task-1');

    expect(recovered.claimed).toBe(true);
    expect(recovered.entry.attemptCount).toBe(2);
  });

  it.each([
    ['owner metadata', undefined],
    [
      'owner token',
      {
        token: '',
        acquiredAt: '2026-08-20T01:00:00.000Z',
        leaseExpiresAt: '2026-08-20T01:00:01.000Z',
      },
    ],
    [
      'lease expiry',
      {
        token: 'legacy-owner-token',
        acquiredAt: '2026-08-20T01:00:00.000Z',
      },
    ],
  ])(
    'recovers a running task when persisted %s is missing',
    async (_label, owner) => {
      const now = new Date('2026-08-20T01:00:00.000Z');
      const first = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
        now: () => now,
        taskLeaseMs: 1_000,
      });
      await first.reserve(pendingEntry());
      await first.claimPending('purchase-category-task-1');
      rewritePersistedOwner(ledgerPath, owner);

      const restarted = new PurchaseInboundCategoryTaskLedgerStore(
        ledgerPath,
        {
          now: () => now,
          taskLeaseMs: 1_000,
        },
      );
      const recovered = await restarted.claimPending(
        'purchase-category-task-1',
      );

      expect(recovered.claimed).toBe(true);
      expect(recovered.entry.attemptCount).toBe(2);
      expect(recovered.entry.owner?.token).toEqual(expect.any(String));
      expect(recovered.entry.owner?.leaseExpiresAt).toBe(
        '2026-08-20T01:00:01.000Z',
      );
    },
  );

  it('recovers a running task with an invalid persisted lease expiry', async () => {
    const now = new Date('2026-08-20T01:00:00.000Z');
    const first = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    await first.reserve(pendingEntry());
    await first.claimPending('purchase-category-task-1');
    rewritePersistedOwner(ledgerPath, {
      token: 'legacy-owner-token',
      acquiredAt: '2026-08-20T01:00:00.000Z',
      leaseExpiresAt: 'not-a-date',
    });

    const restarted = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    const recovered = await restarted.claimPending('purchase-category-task-1');

    expect(recovered.claimed).toBe(true);
    expect(recovered.entry.attemptCount).toBe(2);
    expect(recovered.entry.owner?.token).toEqual(expect.any(String));
  });

  it('does not take over a running task with a valid active lease', async () => {
    let now = new Date('2026-08-20T01:00:00.000Z');
    const first = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    await first.reserve(pendingEntry());
    const claimed = await first.claimPending('purchase-category-task-1');
    const ownerToken = claimed.entry.owner?.token;

    now = new Date('2026-08-20T01:00:00.500Z');
    const restarted = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    const rejected = await restarted.claimPending('purchase-category-task-1');

    expect(rejected.claimed).toBe(false);
    expect(rejected.entry.attemptCount).toBe(1);
    expect(rejected.entry.owner?.token).toBe(ownerToken);
    expect(rejected.entry.owner?.leaseExpiresAt).toBe(
      '2026-08-20T01:00:01.000Z',
    );
  });

  it('fences the old worker after another store takes over an expired lease', async () => {
    let now = new Date('2026-08-20T01:00:00.000Z');
    const first = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    await first.reserve(pendingEntry());
    const firstClaim = await first.claimPending('purchase-category-task-1');
    const firstToken = firstClaim.entry.owner?.token;

    now = new Date('2026-08-20T01:00:02.000Z');
    const second = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    const secondClaim = await second.claimPending('purchase-category-task-1');
    const secondToken = secondClaim.entry.owner?.token;

    expect(firstClaim.claimed).toBe(true);
    expect(firstToken).toEqual(expect.any(String));
    expect(secondClaim.claimed).toBe(true);
    expect(secondToken).toEqual(expect.any(String));
    expect(secondToken).not.toBe(firstToken);
    await expect(
      first.renewClaim('purchase-category-task-1', firstToken!),
    ).rejects.toThrow();
    await expect(
      first.updateTask(
        'purchase-category-task-1',
        {
          ...firstClaim.entry.task,
          status: 'completed',
          message: 'stale worker must not complete',
          updatedAt: now.toISOString(),
          completedAt: now.toISOString(),
        },
        firstToken!,
      ),
    ).rejects.toThrow();

    await expect(
      second.renewClaim('purchase-category-task-1', secondToken!),
    ).resolves.toBeUndefined();
    await expect(
      second.updateTask(
        'purchase-category-task-1',
        {
          ...secondClaim.entry.task,
          status: 'completed',
          message: 'current worker completed',
          updatedAt: now.toISOString(),
          completedAt: now.toISOString(),
        },
        secondToken!,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
  });

  it('does not permanently poison the ledger after a transient Windows rename failure', async () => {
    const originalRenameSync = fs.renameSync;
    let blockLedgerRename = true;
    const renameSpy = jest
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        if (
          blockLedgerRename &&
          String(source).endsWith('.tmp') &&
          String(destination) === ledgerPath
        ) {
          throw Object.assign(new Error('operation not permitted'), {
            code: 'EPERM',
          });
        }
        return originalRenameSync(source, destination);
      });
    const store = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      lockRetryDelayMs: 1,
    });

    try {
      await expect(store.reserve(pendingEntry())).rejects.toThrow('任务台账');
      blockLedgerRename = false;

      await expect(store.reserve(pendingEntry())).resolves.toMatchObject({
        created: true,
      });
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('releases the local claim when persisting the running state fails', async () => {
    const store = new PurchaseInboundCategoryTaskLedgerStore(ledgerPath, {
      lockRetryDelayMs: 1,
    });
    await store.reserve(pendingEntry());
    const originalRenameSync = fs.renameSync;
    let blockLedgerRename = true;
    const renameSpy = jest
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        if (
          blockLedgerRename &&
          String(source).endsWith('.tmp') &&
          String(destination) === ledgerPath
        ) {
          throw Object.assign(new Error('operation not permitted'), {
            code: 'EPERM',
          });
        }
        return originalRenameSync(source, destination);
      });

    try {
      await expect(
        store.claimPending('purchase-category-task-1'),
      ).rejects.toThrow();
      blockLedgerRename = false;

      await expect(
        store.claimPending('purchase-category-task-1'),
      ).resolves.toMatchObject({ claimed: true });
    } finally {
      renameSpy.mockRestore();
    }
  });
});

function pendingEntry(
  request: PurchaseInboundCategoryPrepareRequest = REQUEST,
) {
  const createdAt = '2026-08-20T01:00:00.000Z';
  return {
    principal: { role: 'admin' as const, purchaseBuilding: null },
    principalFingerprint: 'principal-category-a',
    requestFingerprint: buildPurchaseInboundCategoryRequestFingerprint(request),
    request,
    attemptCount: 0,
    task: {
      id: 'purchase-category-task-1',
      status: 'pending' as const,
      message: '类别号生成已受理',
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function rewritePersistedOwner(
  path: string,
  owner:
    | {
        token: string;
        acquiredAt: string;
        leaseExpiresAt?: string;
      }
    | undefined,
): void {
  const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: Array<{
      owner?: {
        token: string;
        acquiredAt: string;
        leaseExpiresAt?: string;
      };
    }>;
  };
  persisted.entries[0]!.owner = owner;
  writeFileSync(path, JSON.stringify(persisted), 'utf8');
}
