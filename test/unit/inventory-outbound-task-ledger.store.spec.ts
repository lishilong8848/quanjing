import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import type { InventoryOutboundMovementCreateRequest } from '../../shared/inventory-management.interface';
import { buildInventoryOutboundRequestFingerprint } from '../../server/modules/inventory-management/inventory-outbound-canonical';
import { InventoryOutboundTaskLedgerStore } from '../../server/modules/inventory-management/inventory-outbound-task-ledger.store';

const REQUEST: InventoryOutboundMovementCreateRequest = {
  type: 'outbound',
  clientMutationId: 'outbound-ledger-1',
  catalogRecordId: 'catalog-a101',
  sku: 'A101',
  building: 'A楼',
  quantity: 2,
  occurredAt: '2026-07-12T10:00:00.000Z',
  applicantOpenId: 'ou_applicant',
  reason: '现场更换',
};

const COMPLETED_RESULT_TAMPER_CASES: Array<
  [string, (result: ReturnType<typeof completedResult>) => void]
> = [
  [
    'movement reason',
    (result) => {
      result.movement.reason = '已被篡改';
    },
  ],
  [
    'movement status',
    (result) => {
      (result.movement as { status: string }).status = '非法状态';
    },
  ],
  [
    'response type',
    (result) => {
      (result as { type: string }).type = 'inbound';
    },
  ],
  [
    'boolean field type',
    (result) => {
      (
        result as unknown as {
          alreadyProcessed: unknown;
        }
      ).alreadyProcessed = 'false';
    },
  ],
  [
    'missing required movement field',
    (result) => {
      delete (result.movement as Partial<typeof result.movement>).unit;
    },
  ],
  [
    'forged pendingSync field',
    (result) => {
      (
        result.movement as typeof result.movement & { pendingSync: boolean }
      ).pendingSync = true;
    },
  ],
];

describe('InventoryOutboundTaskLedgerStore', () => {
  let directory: string;
  let ledgerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'inventory-outbound-ledger-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('atomically reserves one durable task across two store instances', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const secondStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const entry = pendingEntry();

    const first = await firstStore.reserve(entry);
    const duplicate = await secondStore.reserve({
      ...entry,
      task: { ...entry.task, id: 'inventory-outbound-task-2' },
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry).toEqual(first.entry);
    expect(duplicate.entry.request).toEqual(REQUEST);
  });

  it('coalesces a recent completed request but permits the same operation after the short retry window', async () => {
    let now = Date.parse('2026-08-11T00:00:00.000Z');
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      now: () => new Date(now),
      recentRequestDedupeMs: 1_000,
    });
    const first = await store.reserve(pendingEntry());
    const claimed = await store.claimPending(first.entry.task.id);
    expect(claimed.claimed).toBe(true);
    await store.updateTask(first.entry.task.id, {
      ...claimed.entry.task,
      status: 'completed',
      completedAt: new Date(now).toISOString(),
      result: completedResult(),
    });

    const duplicateRequest = {
      ...REQUEST,
      clientMutationId: 'outbound-ledger-retry-1',
    };
    const duplicate = await store.reserve(
      pendingEntryForRequest(
        duplicateRequest,
        'inventory-outbound-task-retry-1',
      ),
    );
    expect(duplicate).toMatchObject({
      created: false,
      entry: { task: { id: first.entry.task.id } },
    });

    now += 1_001;
    const nextRequest = {
      ...REQUEST,
      clientMutationId: 'outbound-ledger-retry-2',
    };
    await expect(
      store.reserve(
        pendingEntryForRequest(nextRequest, 'inventory-outbound-task-retry-2'),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it('retries a transient Windows lock-release failure without poisoning the ledger', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const originalUnlinkSync = fs.unlinkSync;
    let lockReleaseAttempts = 0;
    const unlinkSpy = jest
      .spyOn(fs, 'unlinkSync')
      .mockImplementation((path) => {
        if (String(path) === lockPath && lockReleaseAttempts++ === 0) {
          const error = Object.assign(new Error('resource busy or locked'), {
            code: 'EBUSY',
          });
          throw error;
        }
        return originalUnlinkSync(path);
      });
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      lockRetryDelayMs: 1,
    });

    try {
      const first = await store.reserve(pendingEntry());
      const duplicate = await store.reserve({
        ...pendingEntry(),
        task: { ...pendingEntry().task, id: 'inventory-outbound-task-2' },
      });

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(lockReleaseAttempts).toBeGreaterThan(1);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('retries a transient Windows atomic rename without poisoning the ledger', async () => {
    const originalRenameSync = fs.renameSync;
    let renameAttempts = 0;
    const renameSpy = jest
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        if (
          String(source).endsWith('.tmp') &&
          String(destination) === ledgerPath &&
          renameAttempts++ === 0
        ) {
          const error = Object.assign(new Error('operation not permitted'), {
            code: 'EPERM',
          });
          throw error;
        }
        return originalRenameSync(source, destination);
      });
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      lockRetryDelayMs: 1,
    });

    try {
      const first = await store.reserve(pendingEntry());
      const duplicate = await store.reserve({
        ...pendingEntry(),
        task: { ...pendingEntry().task, id: 'inventory-outbound-task-2' },
      });

      expect(first.created).toBe(true);
      expect(duplicate).toMatchObject({ created: false });
      expect(renameAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('persists optional preflight retry metadata while accepting legacy tasks without it', async () => {
    const legacy = pendingEntry();
    const base = pendingEntryFor(2);
    const withRetryMetadata = {
      ...base,
      task: {
        ...base.task,
        preflightAttemptCount: 2,
        lastPreflightAttemptAt: '2026-08-13T01:02:03.000Z',
      },
    };
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await store.reserve(legacy);
    await store.reserve(withRetryMetadata);

    const restarted = new InventoryOutboundTaskLedgerStore(ledgerPath);

    expect((await restarted.findByTaskId(legacy.task.id))?.task).toMatchObject({
      status: 'pending',
    });
    expect(
      (await restarted.findByTaskId(withRetryMetadata.task.id))?.task,
    ).toMatchObject({
      preflightAttemptCount: 2,
      lastPreflightAttemptAt: '2026-08-13T01:02:03.000Z',
    });
  });

  it.each([
    [{ preflightAttemptCount: -1 }, 'negative attempt count'],
    [
      {
        preflightAttemptCount: 1,
        lastPreflightAttemptAt: 'not-a-timestamp',
      },
      'invalid attempt timestamp',
    ],
  ])('rejects %s in durable preflight retry metadata', async (metadata) => {
    const entry = pendingEntry();
    Object.assign(entry.task, metadata);
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);

    await expect(store.reserve(entry)).rejects.toThrow(
      '出库任务预写入重试信息无效',
    );
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('releases a dead pending owner so a restarted worker can safely claim it', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve(pendingEntry());
    expect(
      (await firstStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(true);
    replaceOwnerWithDeadProcess(ledgerPath);

    const restartedStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const recovered = await restartedStore.findByTaskId(
      'inventory-outbound-task-1',
    );

    expect(recovered?.task.status).toBe('pending');
    expect(
      (await restartedStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(true);
  });

  it('turns a dead running task uncertain and never makes it claimable again', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve(pendingEntry());
    const claimed = await firstStore.claimPending('inventory-outbound-task-1');
    await firstStore.updateTask('inventory-outbound-task-1', {
      ...claimed.entry.task,
      status: 'running',
      message: '正在写入飞书多维表',
    });
    replaceOwnerWithDeadProcess(ledgerPath);

    const restartedStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const recovered = await restartedStore.findByTaskId(
      'inventory-outbound-task-1',
    );

    expect(recovered?.task.status).toBe('uncertain');
    expect(recovered?.task.message).toContain('不会重复创建');
    expect(
      (await restartedStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(false);
  });

  it('atomically requeues an owned running task only after its write was rejected', async () => {
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const claimed = await store.claimPending('inventory-outbound-task-1');
    await store.updateTask('inventory-outbound-task-1', {
      ...claimed.entry.task,
      status: 'running',
      message: '正在写入飞书多维表',
    });

    const requeued = await store.requeueDefinitelyRejectedWrite(
      'inventory-outbound-task-1',
      '飞书限流，按原编号后台重试',
    );
    expect(requeued.task).toMatchObject({
      status: 'pending',
      message: '飞书限流，按原编号后台重试',
      lastPreflightAttemptAt: expect.any(String),
    });
    expect((await store.claimPending('inventory-outbound-task-1')).claimed).toBe(
      true,
    );
  });

  it('allows only one store to claim an uncertain task and transfers after release', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const secondStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve(pendingEntry());
    const pendingClaim = await firstStore.claimPending(
      'inventory-outbound-task-1',
    );
    await firstStore.updateTask('inventory-outbound-task-1', {
      ...pendingClaim.entry.task,
      status: 'uncertain',
      message: '外部写入结果暂不确定',
      completedAt: '2026-08-11T00:01:00.000Z',
      definitelyNotWritten: false,
    });

    expect(
      (await firstStore.claimUncertain('inventory-outbound-task-1')).claimed,
    ).toBe(true);
    expect(
      (await secondStore.claimUncertain('inventory-outbound-task-1')).claimed,
    ).toBe(false);
    await expect(
      secondStore.abandonUncertainClaim('inventory-outbound-task-1'),
    ).resolves.toBe(false);
    await expect(
      firstStore.abandonUncertainClaim('inventory-outbound-task-1'),
    ).resolves.toBe(true);
    expect(
      (await secondStore.claimUncertain('inventory-outbound-task-1')).claimed,
    ).toBe(true);
  });

  it('reclaims an expired uncertain lease and rejects the stale owner', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const secondStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve(pendingEntry());
    const pendingClaim = await firstStore.claimPending(
      'inventory-outbound-task-1',
    );
    await firstStore.updateTask('inventory-outbound-task-1', {
      ...pendingClaim.entry.task,
      status: 'uncertain',
      message: '外部写入结果暂不确定',
      completedAt: '2026-08-11T00:01:00.000Z',
      definitelyNotWritten: false,
    });
    expect(
      (await firstStore.claimUncertain('inventory-outbound-task-1')).claimed,
    ).toBe(true);
    expireTaskLease(ledgerPath);

    expect(
      (await secondStore.claimUncertain('inventory-outbound-task-1')).claimed,
    ).toBe(true);
    await expect(
      firstStore.abandonUncertainClaim('inventory-outbound-task-1'),
    ).resolves.toBe(false);
    await expect(
      firstStore.renewClaim('inventory-outbound-task-1'),
    ).rejects.toThrow('lease 所有权已变更');
    await expect(
      firstStore.findByTaskId('inventory-outbound-task-1'),
    ).resolves.toMatchObject({ task: { status: 'uncertain' } });
  });

  it('clears a stale local uncertain claim after another instance releases the durable owner', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const secondStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve(pendingEntry());
    const pendingClaim = await firstStore.claimPending(
      'inventory-outbound-task-1',
    );
    await firstStore.updateTask('inventory-outbound-task-1', {
      ...pendingClaim.entry.task,
      status: 'uncertain',
      message: '外部写入结果暂不确定',
      completedAt: '2026-08-11T00:01:00.000Z',
      definitelyNotWritten: false,
    });
    await firstStore.claimUncertain('inventory-outbound-task-1');
    expireTaskLease(ledgerPath);
    expect(
      (await secondStore.claimUncertain('inventory-outbound-task-1')).claimed,
    ).toBe(true);
    await expect(
      secondStore.abandonUncertainClaim('inventory-outbound-task-1'),
    ).resolves.toBe(true);

    await expect(
      firstStore.abandonUncertainClaim('inventory-outbound-task-1'),
    ).resolves.toBe(false);
    expect(
      (await firstStore.claimUncertain('inventory-outbound-task-1')).claimed,
    ).toBe(true);
  });

  it('recovers stale lock guards without leaving cross-process lock artifacts', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    writeFileSync(lockPath, 'orphaned-lock', 'utf8');
    writeFileSync(recoveryPath, 'orphaned-recovery-guard', 'utf8');
    const staleTimestamp = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTimestamp, staleTimestamp);
    utimesSync(recoveryPath, staleTimestamp, staleTimestamp);
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 100,
      lockRetryDelayMs: 2,
      staleLockMs: 10,
    });

    expect((await store.reserve(pendingEntry())).created).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
    expect(existsSync(`${recoveryPath}.${process.pid}.stale`)).toBe(false);
  });

  it('fails closed instead of replacing a corrupted durable ledger', async () => {
    writeFileSync(ledgerPath, '{not-valid-json', 'utf8');
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);

    await expect(store.reserve(pendingEntry())).rejects.toThrow('账本不可用');
    expect(readFileSync(ledgerPath, 'utf8')).toBe('{not-valid-json');
  });

  it('fails closed when a valid JSON ledger request is changed without updating its fingerprint', async () => {
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    mutateLedger(ledgerPath, (state) => {
      state.entries[0].request.quantity = REQUEST.quantity + 1;
    });

    const restarted = new InventoryOutboundTaskLedgerStore(ledgerPath);

    await expect(
      restarted.findByTaskId('inventory-outbound-task-1'),
    ).rejects.toThrow('账本不可用');
  });

  it('fails closed when a completed result no longer matches its canonical request', async () => {
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const claimed = await store.claimPending('inventory-outbound-task-1');
    await store.updateTask('inventory-outbound-task-1', {
      ...claimed.entry.task,
      status: 'completed',
      message: '出库申请已提交，待库房确认',
      completedAt: '2026-08-11T00:01:00.000Z',
      result: completedResult(),
    });
    mutateLedger(ledgerPath, (state) => {
      state.entries[0].task.result!.movement.quantity = REQUEST.quantity + 1;
    });

    const restarted = new InventoryOutboundTaskLedgerStore(ledgerPath);

    await expect(
      restarted.findByTaskId('inventory-outbound-task-1'),
    ).rejects.toThrow('账本不可用');
  });

  it('persists multiline outbound reasons and reads the completed task after restart', async () => {
    const request: InventoryOutboundMovementCreateRequest = {
      ...REQUEST,
      clientMutationId: 'outbound-ledger-multiline',
      reason: '一层机房\r\n临时更换\t滤芯',
    };
    const entry = pendingEntryForRequest(
      request,
      'inventory-outbound-task-multiline',
    );
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await store.reserve(entry);
    const claimed = await store.claimPending(entry.task.id);

    await store.updateTask(entry.task.id, {
      ...claimed.entry.task,
      status: 'completed',
      message: '出库申请已提交，待库房确认',
      completedAt: '2026-08-11T00:01:00.000Z',
      result: completedResult(request),
    });

    expect(
      (await store.findByTaskId(entry.task.id))?.task.result?.movement.reason,
    ).toBe(request.reason);
    const restarted = new InventoryOutboundTaskLedgerStore(ledgerPath);
    expect(
      (await restarted.findByTaskId(entry.task.id))?.task.result?.movement
        .reason,
    ).toBe(request.reason);
  });

  it.each([
    ['NUL', '\u0000'],
    ['BEL', '\u0007'],
    ['VT', '\u000b'],
    ['FF', '\u000c'],
  ])(
    'rejects unsafe %s controls before persistence without poisoning the store',
    async (label, control) => {
      const request: InventoryOutboundMovementCreateRequest = {
        ...REQUEST,
        clientMutationId: `outbound-invalid-${label.toLowerCase()}`,
        reason: `${control}机房更换`,
      };
      const store = new InventoryOutboundTaskLedgerStore(ledgerPath);

      await expect(
        store.reserve(
          pendingEntryForRequest(
            request,
            `inventory-outbound-task-invalid-${label.toLowerCase()}`,
          ),
        ),
      ).rejects.toThrow('出库任务账本规范请求无效');
      expect(existsSync(ledgerPath)).toBe(false);
      await expect(store.reserve(pendingEntry())).resolves.toMatchObject({
        created: true,
      });
    },
  );

  it('rejects an invalid completed update before mutating the durable task', async () => {
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const claimed = await store.claimPending('inventory-outbound-task-1');
    const before = readFileSync(ledgerPath, 'utf8');
    const invalidResult = completedResult();
    invalidResult.movement.operator = '库管\u0007员';

    await expect(
      store.updateTask('inventory-outbound-task-1', {
        ...claimed.entry.task,
        status: 'completed',
        message: '出库申请已提交，待库房确认',
        completedAt: '2026-08-11T00:01:00.000Z',
        result: invalidResult,
      }),
    ).rejects.toThrow('已完成出库任务结果与规范请求不一致');

    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
    expect(
      (await store.findByTaskId('inventory-outbound-task-1'))?.task.status,
    ).toBe('pending');
  });

  it('rejects an invalid uncertain reconciliation before mutating the durable task', async () => {
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await store.reserve(pendingEntry());
    const claimed = await store.claimPending('inventory-outbound-task-1');
    await store.updateTask('inventory-outbound-task-1', {
      ...claimed.entry.task,
      status: 'uncertain',
      message: '外部写入结果暂不确定',
      completedAt: '2026-08-11T00:01:00.000Z',
      definitelyNotWritten: false,
    });
    await store.claimUncertain('inventory-outbound-task-1');
    const before = readFileSync(ledgerPath, 'utf8');
    const invalidResult = completedResult();
    invalidResult.movement.operator = '库管\u0007员';

    await expect(
      store.reconcileUncertain('inventory-outbound-task-1', invalidResult),
    ).rejects.toThrow('已完成出库任务结果与规范请求不一致');

    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
    expect(
      (await store.findByTaskId('inventory-outbound-task-1'))?.task.status,
    ).toBe('uncertain');
  });

  it.each(COMPLETED_RESULT_TAMPER_CASES)(
    'fails closed when completed result has a valid JSON %s tamper',
    async (_label, tamper) => {
      const store = new InventoryOutboundTaskLedgerStore(ledgerPath);
      await store.reserve(pendingEntry());
      const claimed = await store.claimPending('inventory-outbound-task-1');
      await store.updateTask('inventory-outbound-task-1', {
        ...claimed.entry.task,
        status: 'completed',
        message: '出库申请已提交，待库房确认',
        completedAt: '2026-08-11T00:01:00.000Z',
        result: completedResult(),
      });
      mutateLedger(ledgerPath, (state) => {
        const result = state.entries[0].task.result;
        if (!result) throw new Error('expected a completed result');
        tamper(result);
      });

      const restarted = new InventoryOutboundTaskLedgerStore(ledgerPath);

      await expect(
        restarted.findByTaskId('inventory-outbound-task-1'),
      ).rejects.toThrow('账本不可用');
    },
  );

  it('reclaims an expired pending lease even when the recorded PID is still alive', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve(pendingEntry());
    expect(
      (await firstStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(true);
    expireTaskLease(ledgerPath);

    const restartedStore = new InventoryOutboundTaskLedgerStore(ledgerPath);

    expect(
      (await restartedStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(true);
  });

  it('turns an expired running lease uncertain instead of replaying it for a live reused PID', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve(pendingEntry());
    const claimed = await firstStore.claimPending('inventory-outbound-task-1');
    await firstStore.updateTask('inventory-outbound-task-1', {
      ...claimed.entry.task,
      status: 'running',
      message: '正在写入飞书多维表',
    });
    expireTaskLease(ledgerPath);

    const restartedStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const recovered = await restartedStore.findByTaskId(
      'inventory-outbound-task-1',
    );

    expect(recovered?.task.status).toBe('uncertain');
    expect(
      (await restartedStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(false);
  });

  it('renews an owned task lease so another instance cannot reclaim it at the old deadline', async () => {
    let now = new Date('2026-08-12T00:00:00.000Z');
    const options = { now: () => now, taskLeaseMs: 300 };
    const firstStore = new InventoryOutboundTaskLedgerStore(
      ledgerPath,
      options,
    );
    await firstStore.reserve(pendingEntry());
    await firstStore.claimPending('inventory-outbound-task-1');
    const originalExpiry = readTaskLeaseExpiry(ledgerPath);
    now = new Date('2026-08-12T00:00:00.200Z');

    await firstStore.renewClaim('inventory-outbound-task-1');

    expect(Date.parse(readTaskLeaseExpiry(ledgerPath))).toBeGreaterThan(
      Date.parse(originalExpiry),
    );
    now = new Date('2026-08-12T00:00:00.350Z');
    const secondStore = new InventoryOutboundTaskLedgerStore(
      ledgerPath,
      options,
    );
    expect(
      (await secondStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(false);
  });

  it('abandons only the current instance pending claim and makes it immediately reclaimable', async () => {
    const ownerStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const otherStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await ownerStore.reserve(pendingEntry());
    await ownerStore.claimPending('inventory-outbound-task-1');

    expect(
      await otherStore.abandonPendingClaim('inventory-outbound-task-1'),
    ).toBe(false);
    expect(
      (await otherStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(false);
    expect(
      await ownerStore.abandonPendingClaim('inventory-outbound-task-1'),
    ).toBe(true);
    expect(
      (await otherStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(true);
  });

  it('never abandons a running claim for replay', async () => {
    const ownerStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const otherStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await ownerStore.reserve(pendingEntry());
    const claimed = await ownerStore.claimPending('inventory-outbound-task-1');
    await ownerStore.updateTask('inventory-outbound-task-1', {
      ...claimed.entry.task,
      status: 'running',
      message: '正在写入飞书多维表',
    });

    expect(
      await ownerStore.abandonPendingClaim('inventory-outbound-task-1'),
    ).toBe(false);
    expect(
      (await otherStore.claimPending('inventory-outbound-task-1')).claimed,
    ).toBe(false);
  });

  it('removes an expired failed task after the configured idempotency retention window', async () => {
    let now = new Date('2026-08-12T00:00:00.000Z');
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      now: () => now,
      retentionTtlMs: 1_000,
      maxEntries: 10,
    });
    const expired = pendingEntryFor(1);
    await store.reserve(expired);
    const claimed = await store.claimPending(expired.task.id);
    await store.updateTask(expired.task.id, {
      ...claimed.entry.task,
      status: 'failed',
      message: '写入前校验失败',
      completedAt: now.toISOString(),
      definitelyNotWritten: true,
    });
    now = new Date(now.getTime() + 1_001);

    await store.reserve(pendingEntryFor(2));

    expect(await store.findByTaskId(expired.task.id)).toBeUndefined();
  });

  it('evicts only completed or failed entries for capacity and preserves uncertain tasks', async () => {
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      maxEntries: 2,
    });
    const uncertain = pendingEntryFor(1);
    await store.reserve(uncertain);
    const uncertainClaim = await store.claimPending(uncertain.task.id);
    await store.updateTask(uncertain.task.id, {
      ...uncertainClaim.entry.task,
      status: 'uncertain',
      message: '外部写入结果暂不确定',
      completedAt: '2026-08-12T00:00:00.000Z',
      definitelyNotWritten: false,
    });
    const failed = pendingEntryFor(2);
    await store.reserve(failed);
    const failedClaim = await store.claimPending(failed.task.id);
    await store.updateTask(failed.task.id, {
      ...failedClaim.entry.task,
      status: 'failed',
      message: '写入前校验失败',
      completedAt: '2026-08-12T00:01:00.000Z',
      definitelyNotWritten: true,
    });

    await store.reserve(pendingEntryFor(3));

    expect((await store.findByTaskId(uncertain.task.id))?.task.status).toBe(
      'uncertain',
    );
    expect(await store.findByTaskId(failed.task.id)).toBeUndefined();
    expect(
      (await store.findByTaskId(pendingEntryFor(3).task.id))?.task.status,
    ).toBe('pending');
  });

  it.each(['pending', 'running', 'uncertain'] as const)(
    'rejects a new reservation when capacity contains only non-evictable %s work',
    async (status) => {
      const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
        maxEntries: 1,
      });
      const protectedEntry = pendingEntryFor(1);
      await store.reserve(protectedEntry);
      if (status !== 'pending') {
        const claimed = await store.claimPending(protectedEntry.task.id);
        await store.updateTask(protectedEntry.task.id, {
          ...claimed.entry.task,
          status,
          message:
            status === 'running'
              ? '正在写入飞书多维表'
              : '外部写入结果暂不确定',
          ...(status === 'uncertain'
            ? {
                completedAt: '2026-08-12T00:00:00.000Z',
                definitelyNotWritten: false,
              }
            : {}),
        });
      }

      await expect(store.reserve(pendingEntryFor(2))).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(
        (await store.findByTaskId(protectedEntry.task.id))?.task.status,
      ).toBe(status);
      expect(
        await store.findByTaskId(pendingEntryFor(2).task.id),
      ).toBeUndefined();
    },
  );

  it('rejects an oversized ledger before accepting its valid JSON contents', async () => {
    const writer = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await writer.reserve(pendingEntry());
    const constrained = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      maxFileBytes: 64,
    });

    await expect(
      constrained.findByTaskId('inventory-outbound-task-1'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('rejects a serialized write that exceeds the configured byte limit without leaving the entry', async () => {
    const constrained = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      maxFileBytes: 64,
    });

    await expect(constrained.reserve(pendingEntry())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('evicts the oldest completed task when a new reservation reaches the byte limit', async () => {
    const writer = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const oldEntry = pendingEntryFor(1);
    await writer.reserve(oldEntry);
    const claimed = await writer.claimPending(oldEntry.task.id);
    await writer.updateTask(oldEntry.task.id, {
      ...claimed.entry.task,
      status: 'completed',
      message: '出库申请已提交，待库房确认',
      completedAt: '2026-08-11T00:01:00.000Z',
      result: completedResult(oldEntry.request),
    });
    const completedLedgerBytes = Buffer.byteLength(
      readFileSync(ledgerPath, 'utf8'),
      'utf8',
    );
    const constrained = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      maxFileBytes: completedLedgerBytes + 64,
    });
    const newEntry = pendingEntryFor(2);

    await expect(constrained.reserve(newEntry)).resolves.toMatchObject({
      created: true,
    });
    expect(await constrained.findByTaskId(oldEntry.task.id)).toBeUndefined();
    expect(
      (await constrained.findByTaskId(newEntry.task.id))?.task.status,
    ).toBe('pending');
  });

  it('rejects temporary byte pressure without permanently poisoning the store', async () => {
    const probePath = join(directory, 'probe.json');
    const probe = new InventoryOutboundTaskLedgerStore(probePath);
    await probe.reserve(pendingEntryFor(1));
    const singlePendingBytes = Buffer.byteLength(
      readFileSync(probePath, 'utf8'),
      'utf8',
    );
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      maxFileBytes: singlePendingBytes + 512,
    });
    const protectedEntry = pendingEntryFor(1);
    await store.reserve(protectedEntry);
    const oversizedRequest: InventoryOutboundMovementCreateRequest = {
      ...REQUEST,
      clientMutationId: 'outbound-ledger-large',
      reason: '更'.repeat(2_000),
    };

    await expect(
      store.reserve(
        pendingEntryForRequest(
          oversizedRequest,
          'inventory-outbound-task-large',
        ),
      ),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(
      (await store.findByTaskId(protectedEntry.task.id))?.task.status,
    ).toBe('pending');

    const claimed = await store.claimPending(protectedEntry.task.id);
    await store.updateTask(protectedEntry.task.id, {
      ...claimed.entry.task,
      status: 'failed',
      message: '写入前校验失败',
      completedAt: '2026-08-11T00:01:00.000Z',
      definitelyNotWritten: true,
    });
    await expect(store.reserve(pendingEntryFor(2))).resolves.toMatchObject({
      created: true,
    });
    expect(await store.findByTaskId(protectedEntry.task.id)).toBeUndefined();
  });

  it('never accepts a pending task when the ledger cannot persist its claim owner', async () => {
    const probePath = join(directory, 'owner-probe.json');
    const probe = new InventoryOutboundTaskLedgerStore(probePath);
    await probe.reserve(pendingEntry());
    const pendingBytes = Buffer.byteLength(
      readFileSync(probePath, 'utf8'),
      'utf8',
    );
    await probe.claimPending('inventory-outbound-task-1');
    const claimedBytes = Buffer.byteLength(
      readFileSync(probePath, 'utf8'),
      'utf8',
    );
    expect(claimedBytes).toBeGreaterThan(pendingBytes);
    const constrained = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      maxFileBytes: claimedBytes - 1,
    });

    await expect(constrained.reserve(pendingEntry())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('does not evict the duplicate task being returned while persisting recovery changes', async () => {
    const writer = new InventoryOutboundTaskLedgerStore(ledgerPath);
    const duplicateEntry = pendingEntryFor(1);
    await writer.reserve(duplicateEntry);
    const duplicateClaim = await writer.claimPending(duplicateEntry.task.id);
    await writer.updateTask(duplicateEntry.task.id, {
      ...duplicateClaim.entry.task,
      status: 'failed',
      message: '写入前校验失败',
      completedAt: '2026-08-11T00:01:00.000Z',
      definitelyNotWritten: true,
    });
    const staleRunning = pendingEntryFor(2);
    await writer.reserve(staleRunning);
    const runningClaim = await writer.claimPending(staleRunning.task.id);
    await writer.updateTask(staleRunning.task.id, {
      ...runningClaim.entry.task,
      status: 'running',
      message: '正在写入飞书多维表',
    });
    mutateLedger(ledgerPath, (state) => {
      delete state.entries[1].owner;
    });
    const beforeRecovery = readFileSync(ledgerPath, 'utf8');
    const probePath = join(directory, 'recovery-probe.json');
    writeFileSync(probePath, beforeRecovery, 'utf8');
    const probe = new InventoryOutboundTaskLedgerStore(probePath);
    await probe.findByTaskId(staleRunning.task.id);
    const recoveredBytes = Buffer.byteLength(
      readFileSync(probePath, 'utf8'),
      'utf8',
    );
    const originalBytes = Buffer.byteLength(beforeRecovery, 'utf8');
    expect(recoveredBytes).toBeGreaterThan(originalBytes);
    const constrained = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      maxFileBytes: Math.floor((originalBytes + recoveredBytes) / 2),
    });

    await expect(constrained.reserve(duplicateEntry)).rejects.toThrow(
      ServiceUnavailableException,
    );
    const unchanged = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{ task: { id: string } }>;
    };
    expect(
      unchanged.entries.some(
        (entry) => entry.task.id === duplicateEntry.task.id,
      ),
    ).toBe(true);
  });

  it('does not freeze ordinary timers while asynchronously waiting for a busy file lock', async () => {
    const lockPath = `${ledgerPath}.lock`;
    writeFileSync(lockPath, 'lock-is-being-initialized', 'utf8');
    const store = new InventoryOutboundTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 300,
      lockRetryDelayMs: 20,
      staleLockMs: 60_000,
    });
    const startedAt = Date.now();
    const timerDelay = new Promise<number>((resolveDelay) => {
      setTimeout(() => resolveDelay(Date.now() - startedAt), 25);
    });

    const reservation = Promise.resolve().then(() =>
      store.reserve(pendingEntry()),
    );

    await expect(reservation).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(timerDelay).resolves.toBeLessThan(200);
    rmSync(lockPath, { force: true });
    await expect(store.reserve(pendingEntry())).resolves.toMatchObject({
      created: true,
    });
  });
});

function pendingEntry() {
  return pendingEntryForRequest(REQUEST, 'inventory-outbound-task-1');
}

function pendingEntryFor(index: number) {
  const request: InventoryOutboundMovementCreateRequest = {
    ...REQUEST,
    clientMutationId: `outbound-ledger-${index}`,
    reason: `现场更换-${index}`,
  };
  return pendingEntryForRequest(request, `inventory-outbound-task-${index}`);
}

function pendingEntryForRequest(
  request: InventoryOutboundMovementCreateRequest,
  taskId: string,
) {
  return {
    building: request.building,
    principalFingerprint: 'principal-fingerprint-a',
    clientMutationId: request.clientMutationId,
    requestFingerprint: buildInventoryOutboundRequestFingerprint(request),
    request,
    task: {
      id: taskId,
      status: 'pending' as const,
      message: '出库申请已受理',
      createdAt: '2026-08-11T00:00:00.000Z',
    },
  };
}

function replaceOwnerWithDeadProcess(ledgerPath: string): void {
  const state = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
    entries: Array<Record<string, unknown>>;
  };
  state.entries[0].owner = {
    version: 1,
    token: 'dead-owner-token',
    pid: 2_147_483_647,
    processStartedAtMs: 0,
    acquiredAt: '2026-08-11T00:00:00.000Z',
  };
  writeFileSync(ledgerPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function mutateLedger(
  path: string,
  mutate: (state: MutableLedgerState) => void,
): void {
  const state = JSON.parse(readFileSync(path, 'utf8')) as MutableLedgerState;
  mutate(state);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

interface MutableLedgerState {
  entries: Array<{
    request: { quantity: number };
    task: {
      status?: string;
      result?: ReturnType<typeof completedResult>;
    };
    owner?: { leaseExpiresAt?: string };
  }>;
}

function expireTaskLease(path: string): void {
  mutateLedger(path, (state) => {
    if (!state.entries[0].owner) throw new Error('expected a task owner');
    state.entries[0].owner.leaseExpiresAt = '2000-01-01T00:00:00.000Z';
  });
}

function readTaskLeaseExpiry(path: string): string {
  const state = JSON.parse(readFileSync(path, 'utf8')) as MutableLedgerState;
  const expiresAt = state.entries[0].owner?.leaseExpiresAt;
  if (!expiresAt) throw new Error('expected a task lease');
  return expiresAt;
}

function completedResult(request = REQUEST) {
  return {
    success: true as const,
    recordId: 'outbound-record-1',
    type: 'outbound' as const,
    alreadyProcessed: false,
    message: '出库申请已提交，待库房确认',
    movement: {
      recordId: 'outbound-record-1',
      clientMutationId: request.clientMutationId,
      type: 'outbound' as const,
      sku: request.sku,
      name: '测试滤芯',
      specification: 'MERV 8',
      quantity: request.quantity,
      unit: '个',
      building: request.building,
      destinationBuilding: '' as const,
      location: 'A-1F-001',
      reason: request.reason,
      operator: '',
      applicant: '测试申请人',
      status: '待库房确认' as const,
      occurredAt: request.occurredAt,
      expectedReturnAt: null,
      overdue: false,
    },
  };
}
