import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
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
import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryNewInboundMovementCreateRequest,
  PurchaseNewInboundConfirmRequest,
} from '../../shared/inventory-management.interface';
import {
  buildInventoryInboundTaskRequestFingerprint,
  InventoryInboundTaskLedgerStore,
} from '../../server/modules/inventory-management/inventory-inbound-task-ledger.store';

const REQUEST: InventoryExistingInboundMovementCreateRequest = {
  type: 'inbound',
  mode: 'existing',
  clientMutationId: 'manual-inbound-ledger-001',
  catalogRecordId: 'catalog-d1007',
  sku: 'D1007',
  building: 'H楼',
  quantity: 2,
  occurredAt: '2026-08-21T03:00:00.000Z',
};

describe('InventoryInboundTaskLedgerStore', () => {
  let directory: string;
  let ledgerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'inventory-inbound-ledger-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('durably returns the same task for a repeated client mutation', async () => {
    const first = new InventoryInboundTaskLedgerStore(ledgerPath);
    const restarted = new InventoryInboundTaskLedgerStore(ledgerPath);

    const reserved = await first.reserveInbound(pendingEntry());
    const duplicate = await restarted.reserveInbound({
      ...pendingEntry(),
      task: { ...pendingEntry().task, id: 'inventory-inbound-manual-other' },
    });

    expect(reserved.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
    expect(existsSync(ledgerPath)).toBe(true);
  });

  it('reuses the same inbound task after re-login changes only the principal fingerprint', async () => {
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    const reserved = await store.reserveInbound(pendingEntry());

    const duplicate = await store.reserveInbound({
      ...pendingEntry(),
      principalFingerprint: 'principal-inbound-admin-after-relogin',
      task: { ...pendingEntry().task, id: 'inventory-inbound-manual-other' },
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
  });

  it('recovers an existing raw-JSON fingerprint from the legacy inbound ledger', async () => {
    const first = new InventoryInboundTaskLedgerStore(ledgerPath);
    const reserved = await first.reserveInbound(pendingEntry());
    const legacyFingerprint = createHash('sha256')
      .update(JSON.stringify({ kind: 'manual', request: REQUEST }))
      .digest('hex');
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{ requestFingerprint: string }>;
    };
    expect(legacyFingerprint).not.toBe(
      persisted.entries[0]?.requestFingerprint,
    );
    persisted.entries[0]!.requestFingerprint = legacyFingerprint;
    writeFileSync(ledgerPath, JSON.stringify(persisted), 'utf8');

    const duplicate = await new InventoryInboundTaskLedgerStore(
      ledgerPath,
    ).reserveInbound({
      ...pendingEntry(),
      task: { ...pendingEntry().task, id: 'inventory-inbound-manual-other' },
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
  });

  it('migrates an equivalent legacy manual new inbound after the stable location id is backfilled', async () => {
    const legacyRequest: InventoryNewInboundMovementCreateRequest = {
      type: 'inbound',
      mode: 'new',
      clientMutationId: 'manual-new-ground-scale-001',
      building: 'H楼',
      quantity: 1,
      occurredAt: '2026-08-21T03:46:00Z',
      newItem: {
        primaryCategory: 'B工具类',
        secondaryCategory: '检测工具B1',
        name: '地磅秤',
        specification: '0.6*0.8米1吨',
        location: 'H-2F-226储存间01-0F',
      },
    };
    const currentRequest: InventoryNewInboundMovementCreateRequest = {
      ...legacyRequest,
      occurredAt: '2026-08-21T03:46:00.000Z',
      newItem: {
        ...legacyRequest.newItem,
        locationRecordId: 'location-h-226-01-0f',
      },
    };
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    const reserved = await store.reserveInbound(
      inboundEntry(
        'manual',
        legacyRequest,
        'inventory-inbound-manual-ground-scale',
      ),
    );

    const duplicate = await store.reserveInbound(
      inboundEntry('manual', currentRequest, 'inventory-inbound-manual-retry'),
    );

    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
    expect(duplicate.entry.request).toEqual(currentRequest);
  });

  it.each([
    ['brand', { brand: '其他品牌' }],
    ['unit', { unit: '套' }],
    ['minimum quantity', { minimumQuantity: 2 }],
  ])(
    'rejects a manual new inbound retry with a different %s',
    async (_label, changedFields) => {
      const originalRequest: InventoryNewInboundMovementCreateRequest = {
        type: 'inbound',
        mode: 'new',
        clientMutationId: 'manual-new-idempotency-optional-fields',
        building: 'H楼',
        quantity: 1,
        occurredAt: '2026-08-21T03:46:00.000Z',
        newItem: {
          primaryCategory: 'B工具类',
          secondaryCategory: '检测工具B1',
          name: '地磅秤',
          specification: '0.6*0.8米1吨',
          location: 'H-2F-226储存间01-0F',
          brand: '正峰',
          unit: '台',
          minimumQuantity: 0,
        },
      };
      const store = new InventoryInboundTaskLedgerStore(ledgerPath);
      await store.reserveInbound(
        inboundEntry('manual', originalRequest, 'inventory-inbound-manual-original'),
      );

      await expect(
        store.reserveInbound(
          inboundEntry(
            'manual',
            {
              ...originalRequest,
              newItem: { ...originalRequest.newItem, ...changedFields },
            },
            'inventory-inbound-manual-conflict',
          ),
        ),
      ).rejects.toThrow(ConflictException);
    },
  );

  it('migrates an equivalent legacy purchase new inbound after location and default minimum normalization', async () => {
    const legacyRequest = purchaseGroundScaleRequest();
    delete legacyRequest.newItem.locationRecordId;
    delete legacyRequest.newItem.minimumQuantity;
    legacyRequest.occurredAt = '2026-08-21T03:46:00Z';
    const currentRequest = purchaseGroundScaleRequest();
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    const reserved = await store.reserveInbound(
      inboundEntry(
        'purchase',
        legacyRequest,
        'inventory-inbound-purchase-ground-scale',
      ),
    );

    const duplicate = await store.reserveInbound(
      inboundEntry(
        'purchase',
        currentRequest,
        'inventory-inbound-purchase-retry',
      ),
    );

    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.task.id).toBe(reserved.entry.task.id);
    expect(duplicate.entry.request).toEqual(currentRequest);
  });

  it.each([
    [
      'mode',
      () => ({
        ...purchaseGroundScaleRequest(),
        mode: 'existing' as const,
        catalogRecordId: 'catalog-b1056-other',
        sku: 'B1056',
        preparedCatalogRecordId: undefined,
        generatedSku: undefined,
        newItem: undefined,
      }),
    ],
    [
      'prepared catalog',
      () => ({
        ...purchaseGroundScaleRequest(),
        preparedCatalogRecordId: 'catalog-b1056-other',
      }),
    ],
    [
      'generated sku',
      () => ({ ...purchaseGroundScaleRequest(), generatedSku: 'B1057' }),
    ],
    [
      'stable location id',
      () => ({
        ...purchaseGroundScaleRequest(),
        newItem: {
          ...purchaseGroundScaleRequest().newItem,
          locationRecordId: 'location-h-other',
        },
      }),
    ],
  ])(
    'rejects a legacy purchase retry with a different %s',
    async (_label, changed) => {
      const store = new InventoryInboundTaskLedgerStore(ledgerPath);
      await store.reserveInbound(
        inboundEntry(
          'purchase',
          purchaseGroundScaleRequest(),
          'inventory-inbound-purchase-ground-scale',
        ),
      );

      await expect(
        store.reserveInbound(
          inboundEntry(
            'purchase',
            changed() as PurchaseNewInboundConfirmRequest,
            'inventory-inbound-purchase-conflict',
          ),
        ),
      ).rejects.toThrow(ConflictException);
    },
  );

  it('rejects reusing one mutation id for different inbound data', async () => {
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    await store.reserveInbound(pendingEntry());
    const changedRequest = { ...REQUEST, quantity: 3 };

    await expect(
      store.reserveInbound(pendingEntry(changedRequest)),
    ).rejects.toThrow(ConflictException);
  });

  it('reports a final inbound conflict as an inbound request conflict', async () => {
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    await store.reserveInbound(pendingEntry());

    await expect(
      store.reserveInbound(pendingEntry({ ...REQUEST, quantity: 3 })),
    ).rejects.toThrow('clientMutationId 已被不同的入库请求占用');
  });

  it('builds the same inbound fingerprint regardless of object property order', () => {
    const reordered: InventoryExistingInboundMovementCreateRequest = {
      occurredAt: REQUEST.occurredAt,
      quantity: REQUEST.quantity,
      building: REQUEST.building,
      sku: REQUEST.sku,
      catalogRecordId: REQUEST.catalogRecordId,
      clientMutationId: REQUEST.clientMutationId,
      mode: REQUEST.mode,
      type: REQUEST.type,
    };

    expect(
      buildInventoryInboundTaskRequestFingerprint('manual', reordered),
    ).toBe(buildInventoryInboundTaskRequestFingerprint('manual', REQUEST));
  });

  it('builds the same inbound fingerprint for missing and explicit undefined optional fields', () => {
    expect(
      buildInventoryInboundTaskRequestFingerprint('manual', {
        ...REQUEST,
        applicantOpenId: undefined,
        operatorOpenId: undefined,
        reason: undefined,
      }),
    ).toBe(buildInventoryInboundTaskRequestFingerprint('manual', REQUEST));
  });

  it('builds the same inbound fingerprint after trimming cleanable string fields', () => {
    const padded = {
      ...REQUEST,
      clientMutationId: `  ${REQUEST.clientMutationId}  `,
      catalogRecordId: `  ${REQUEST.catalogRecordId}  `,
      sku: `  ${REQUEST.sku}  `,
      occurredAt: `  ${REQUEST.occurredAt}  `,
    };

    expect(buildInventoryInboundTaskRequestFingerprint('manual', padded)).toBe(
      buildInventoryInboundTaskRequestFingerprint('manual', REQUEST),
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
    ['sku', { ...REQUEST, sku: `${REQUEST.sku}-changed` }],
  ])('changes the inbound fingerprint when %s changes', (_label, changed) => {
    expect(
      buildInventoryInboundTaskRequestFingerprint('manual', changed),
    ).not.toBe(buildInventoryInboundTaskRequestFingerprint('manual', REQUEST));
  });

  it('claims a persisted task with the final inbound running state', async () => {
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    await store.reserveInbound(pendingEntry());

    const claim = await store.claimPendingInbound(
      'inventory-inbound-manual-task-1',
    );

    expect(claim).toMatchObject({
      claimed: true,
      entry: {
        owner: { token: expect.any(String) },
        attemptCount: 1,
        task: {
          kind: 'manual',
          status: 'running',
          message: '正在后台同步入库数据',
        },
      },
    });
  });

  it('persists the inbound running claim with one atomic ledger write', async () => {
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    await store.reserveInbound(pendingEntry());
    const originalRenameSync = fs.renameSync;
    let ledgerWrites = 0;
    const renameSpy = jest
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        if (
          String(source).endsWith('.tmp') &&
          String(destination) === ledgerPath
        ) {
          ledgerWrites += 1;
        }
        return originalRenameSync(source, destination);
      });

    try {
      await expect(
        store.claimPendingInbound('inventory-inbound-manual-task-1'),
      ).resolves.toMatchObject({
        claimed: true,
        entry: {
          task: {
            status: 'running',
            message: '正在后台同步入库数据',
          },
        },
      });
      expect(ledgerWrites).toBe(1);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('persists a manual business result checkpoint on a running task across restart', async () => {
    const store = new InventoryInboundTaskLedgerStore(ledgerPath);
    await store.reserveInbound(pendingEntry());
    const claimed = await store.claimPendingInbound(
      'inventory-inbound-manual-task-1',
    );
    const businessResult = manualCheckpointResult();

    await store.updateInboundTask(
      claimed.entry.task.id,
      {
        ...claimed.entry.task,
        status: 'running',
        businessResult,
      },
      claimed.entry.owner?.token || '',
    );

    await expect(
      new InventoryInboundTaskLedgerStore(ledgerPath).findInboundByTaskId(
        claimed.entry.task.id,
      ),
    ).resolves.toMatchObject({
      task: { status: 'running', businessResult },
    });
  });

  it('fences stale inbound writes after another store takes over the lease', async () => {
    let now = new Date('2026-08-21T03:00:00.000Z');
    const first = new InventoryInboundTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    await first.reserveInbound(pendingEntry());
    const firstClaim = await first.claimPendingInbound(
      'inventory-inbound-manual-task-1',
    );
    const firstToken = firstClaim.entry.owner?.token;

    now = new Date('2026-08-21T03:00:02.000Z');
    const second = new InventoryInboundTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    const secondClaim = await second.claimPendingInbound(
      'inventory-inbound-manual-task-1',
    );
    const secondToken = secondClaim.entry.owner?.token;

    expect(firstToken).toEqual(expect.any(String));
    expect(secondToken).toEqual(expect.any(String));
    expect(secondToken).not.toBe(firstToken);
    await expect(
      first.renewClaim('inventory-inbound-manual-task-1', firstToken!),
    ).rejects.toThrow();
    await expect(
      first.updateInboundTask(
        'inventory-inbound-manual-task-1',
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
      second.updateInboundTask(
        'inventory-inbound-manual-task-1',
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
});

function pendingEntry(
  request: InventoryExistingInboundMovementCreateRequest = REQUEST,
) {
  const createdAt = '2026-08-21T03:00:00.000Z';
  return {
    kind: 'manual' as const,
    principal: { role: 'admin' as const, purchaseBuilding: null },
    principalFingerprint: 'principal-inbound-admin',
    requestFingerprint: buildInventoryInboundTaskRequestFingerprint(
      'manual',
      request,
    ),
    request,
    attemptCount: 0,
    task: {
      id: 'inventory-inbound-manual-task-1',
      kind: 'manual' as const,
      status: 'pending' as const,
      message: '入库已受理',
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function purchaseGroundScaleRequest(): PurchaseNewInboundConfirmRequest {
  return {
    executionRecordId: 'purchase-execution-ground-scale',
    clientMutationId: 'purchase-inbound-ground-scale-001',
    mode: 'new',
    building: 'H楼',
    quantity: 1,
    occurredAt: '2026-08-21T03:46:00.000Z',
    preparedCatalogRecordId: 'catalog-b1056',
    generatedSku: 'B1056',
    newItem: {
      primaryCategory: 'B工具类',
      secondaryCategory: '检测工具B1',
      name: '地磅秤',
      specification: '0.6*0.8米1吨',
      location: 'H-2F-226储存间01-0F',
      locationRecordId: 'location-h-226-01-0f',
      brand: '正峰',
      unit: '台',
      minimumQuantity: 0,
    },
  };
}

function inboundEntry(
  kind: 'manual' | 'purchase',
  request:
    | InventoryNewInboundMovementCreateRequest
    | PurchaseNewInboundConfirmRequest,
  taskId: string,
) {
  const createdAt = '2026-08-21T03:46:00.000Z';
  return {
    kind,
    principal: { role: 'admin' as const, purchaseBuilding: null },
    principalFingerprint: 'principal-inbound-admin',
    requestFingerprint: buildInventoryInboundTaskRequestFingerprint(
      kind,
      request,
    ),
    request,
    attemptCount: 0,
    task: {
      id: taskId,
      kind,
      status: 'pending' as const,
      message: '入库已受理',
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function manualCheckpointResult() {
  return {
    success: true as const,
    recordId: 'inbound-record-checkpoint',
    type: 'inbound' as const,
    message: '入库记录已完成',
    movement: {
      recordId: 'inbound-record-checkpoint',
      clientMutationId: REQUEST.clientMutationId,
      type: 'inbound' as const,
      sku: REQUEST.sku,
      name: '测试物品',
      specification: '测试规格',
      quantity: REQUEST.quantity,
      unit: '个',
      building: REQUEST.building,
      destinationBuilding: '',
      location: 'H-2F-226储存间01-0F',
      reason: '入库登记',
      operator: '管理员',
      applicant: '',
      status: '新增',
      occurredAt: REQUEST.occurredAt,
      expectedReturnAt: null,
      overdue: false,
    },
  };
}
