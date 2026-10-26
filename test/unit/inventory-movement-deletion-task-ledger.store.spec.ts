import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateInventoryMovementDeletionRequest } from '../../shared/inventory-management.interface';
import {
  buildInventoryMovementDeletionRequestFingerprint,
  InventoryMovementDeletionTaskLedgerStore,
  type InventoryMovementDeletionTaskLedgerEntry,
} from '../../server/modules/inventory-management/inventory-movement-deletion-task-ledger.store';

const REQUEST: CreateInventoryMovementDeletionRequest = {
  clientMutationId: 'movement-delete-001',
  movementType: 'inbound',
  recordId: 'rec-inbound-001',
};

describe('InventoryMovementDeletionTaskLedgerStore', () => {
  let directory: string;
  let ledgerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'movement-delete-ledger-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reserves one durable idempotent task across store instances', async () => {
    const first = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);
    const second = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);

    const reserved = await first.reserve(pendingEntry());
    const duplicate = await second.reserve({
      ...pendingEntry(),
      task: {
        ...pendingEntry().task,
        id: 'inventory-movement-deletion-task-duplicate',
      },
    });

    expect(reserved.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry).toEqual(reserved.entry);
    expect(duplicate.entry.principal).toEqual({
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    });
  });

  it('rejects reusing a mutation id with a different payload', async () => {
    const store = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const changedRequest = { ...REQUEST, recordId: 'rec-inbound-other' };

    await expect(
      store.reserve(
        pendingEntry(changedRequest, 'inventory-movement-deletion-task-other'),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a second active task for the same movement target', async () => {
    const store = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const secondRequest = {
      ...REQUEST,
      clientMutationId: 'movement-delete-002',
    };

    await expect(
      store.reserve(
        pendingEntry(secondRequest, 'inventory-movement-deletion-task-2'),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('retries a transient Windows lock-release failure without poisoning the ledger', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const originalUnlinkSync = fs.unlinkSync;
    let lockReleaseAttempts = 0;
    const unlinkSpy = jest
      .spyOn(fs, 'unlinkSync')
      .mockImplementation((path) => {
        if (String(path) === lockPath && lockReleaseAttempts++ === 0) {
          throw Object.assign(new Error('resource busy or locked'), {
            code: 'EBUSY',
          });
        }
        return originalUnlinkSync(path);
      });
    const store = new InventoryMovementDeletionTaskLedgerStore(ledgerPath, {
      lockRetryDelayMs: 1,
    });

    try {
      const first = await store.reserve(pendingEntry());
      const duplicate = await store.reserve({
        ...pendingEntry(),
        task: {
          ...pendingEntry().task,
          id: 'inventory-movement-deletion-task-duplicate',
        },
      });

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(lockReleaseAttempts).toBeGreaterThan(1);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('persists attempts and lets an expired pending lease be claimed after restart', async () => {
    let now = new Date('2026-08-13T01:00:00.000Z');
    const first = new InventoryMovementDeletionTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    await first.reserve(pendingEntry());
    const firstClaim = await first.claimPending(
      'inventory-movement-deletion-task-1',
    );
    expect(firstClaim.claimed).toBe(true);
    expect(firstClaim.entry.attemptCount).toBe(1);

    now = new Date('2026-08-13T01:00:02.000Z');
    const restarted = new InventoryMovementDeletionTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    const secondClaim = await restarted.claimPending(
      'inventory-movement-deletion-task-1',
    );

    expect(secondClaim.claimed).toBe(true);
    expect(secondClaim.entry.attemptCount).toBe(2);
  });

  it('keeps an expired running task recoverable with its prewrite plan', async () => {
    let now = new Date('2026-08-13T01:00:00.000Z');
    const first = new InventoryMovementDeletionTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    await first.reserve(pendingEntry());
    const claimed = await first.claimPending(
      'inventory-movement-deletion-task-1',
    );
    await first.updateRecoveryState(claimed.entry.task.id, {
      version: 1,
      phase: 'delete_started',
      movement: {
        building: 'A楼',
        purchaseExecutionRecordId: '',
        sku: 'D1001',
        quantity: 2,
      },
    });
    await first.updateTask(claimed.entry.task.id, {
      ...claimed.entry.task,
      status: 'running',
      message: '正在删除飞书记录',
      updatedAt: now.toISOString(),
    });

    now = new Date('2026-08-13T01:00:02.000Z');
    const restarted = new InventoryMovementDeletionTaskLedgerStore(ledgerPath, {
      now: () => now,
      taskLeaseMs: 1_000,
    });
    const recovered = await restarted.claimPending(
      'inventory-movement-deletion-task-1',
    );

    expect(recovered.claimed).toBe(true);
    expect(recovered.entry.task.status).toBe('running');
    expect(recovered.entry.recovery).toMatchObject({
      phase: 'delete_started',
      movement: { building: 'A楼', sku: 'D1001', quantity: 2 },
    });
    expect(recovered.entry.attemptCount).toBe(2);
  });

  it('does not let a manual-review terminal task permanently block its target', async () => {
    const store = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const claimed = await store.claimPending(
      'inventory-movement-deletion-task-1',
    );
    await store.updateTask(claimed.entry.task.id, {
      ...claimed.entry.task,
      status: 'uncertain',
      message: '删除结果需人工核对',
      updatedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:01:00.000Z',
      definitelyNotDeleted: false,
    });

    const secondRequest = {
      ...REQUEST,
      clientMutationId: 'movement-delete-002',
    };
    await expect(
      store.reserve(
        pendingEntry(secondRequest, 'inventory-movement-deletion-task-2'),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it('recovers stale lock guards without leaving cross-process lock artifacts', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    writeFileSync(lockPath, 'orphaned-lock', 'utf8');
    writeFileSync(recoveryPath, 'orphaned-recovery-guard', 'utf8');
    const staleTimestamp = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTimestamp, staleTimestamp);
    utimesSync(recoveryPath, staleTimestamp, staleTimestamp);
    const store = new InventoryMovementDeletionTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 100,
      lockRetryDelayMs: 2,
      staleLockMs: 10,
    });

    expect((await store.reserve(pendingEntry())).created).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it('persists a completed terminal result across restart', async () => {
    const store = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const claimed = await store.claimPending(
      'inventory-movement-deletion-task-1',
    );
    await store.updateTask(claimed.entry.task.id, {
      ...claimed.entry.task,
      status: 'completed',
      message: '入库记录已删除',
      updatedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:01:00.000Z',
      result: {
        recordId: REQUEST.recordId,
        type: REQUEST.movementType,
        purchaseRolledBack: false,
        message: '入库记录已删除',
      },
    });

    const restarted = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);
    expect(
      (await restarted.findByTaskId('inventory-movement-deletion-task-1'))
        ?.task,
    ).toMatchObject({
      status: 'completed',
      result: {
        recordId: REQUEST.recordId,
        type: REQUEST.movementType,
        purchaseRolledBack: false,
      },
    });
  });

  it('fails closed without replacing a corrupted ledger', async () => {
    writeFileSync(ledgerPath, '{invalid-json', 'utf8');
    const store = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);

    await expect(store.reserve(pendingEntry())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe('{invalid-json');
  });
});

function pendingEntry(
  request: CreateInventoryMovementDeletionRequest = REQUEST,
  taskId = 'inventory-movement-deletion-task-1',
): InventoryMovementDeletionTaskLedgerEntry {
  return {
    principal: { role: 'inventory_admin', purchaseBuilding: 'A楼' },
    request,
    requestFingerprint:
      buildInventoryMovementDeletionRequestFingerprint(request),
    principalFingerprint: 'principal-fingerprint-a',
    attemptCount: 0,
    task: {
      id: taskId,
      status: 'pending',
      message: '删除申请已受理',
      createdAt: '2026-08-13T01:00:00.000Z',
      updatedAt: '2026-08-13T01:00:00.000Z',
    },
  };
}
