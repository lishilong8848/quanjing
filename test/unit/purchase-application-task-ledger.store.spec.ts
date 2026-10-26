import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  PurchaseApplicationTaskLedgerStore,
  type PurchaseApplicationTaskLedgerEntry,
} from '../../server/modules/purchase-inventory/purchase-application-task-ledger.store';

describe('PurchaseApplicationTaskLedgerStore', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically persists an idempotency reservation across store instances', () => {
    const ledgerPath = temporaryLedgerPath();
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    const entry = ledgerEntry();

    expect(store.reserve(entry)).toMatchObject({ created: true });

    const restarted = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    expect(
      restarted.findByIdentity(
        'H楼',
        'principal-session-a',
        'purchase-mutation-001',
      ),
    ).toEqual(
      expect.objectContaining({
        building: 'H楼',
        principalFingerprint: 'principal-session-a',
        idempotencyKey: 'purchase-mutation-001',
        requestFingerprint: '1'.repeat(64),
        submissionFingerprint: '2'.repeat(64),
        task: expect.objectContaining({ id: 'purchase-application-task-1' }),
      }),
    );
    expect(readdirSync(join(ledgerPath, '..'))).toEqual([
      'purchase-application-ledger.json',
    ]);
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({
      version: 2,
    });
  });

  it('lists completed tasks with created records for approval-batch recovery', () => {
    const ledgerPath = temporaryLedgerPath();
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    store.reserve(
      ledgerEntry({
        task: {
          ...ledgerEntry().task,
          result: {
            success: true,
            created: [
              {
                lineId: 'line-1',
                recordId: 'rec-1',
                executionRecordId: 'rec-1',
                requestCode: 'CG260908-001',
              },
            ],
            failed: [],
            warnings: [],
            message: '已完成',
          },
        },
      }),
    );

    expect(store.listCompletedTasksWithCreatedRecords(10)).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: 'purchase-application-task-1' }),
      }),
    ]);
  });

  it('allows only one reservation when two loaded stores share one identity', () => {
    const ledgerPath = temporaryLedgerPath();
    const firstStore = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    const secondStore = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    expect(firstStore.findByTaskId('missing-task')).toBeUndefined();
    expect(secondStore.findByTaskId('missing-task')).toBeUndefined();

    const first = firstStore.reserve(ledgerEntry());
    const second = secondStore.reserve(
      ledgerEntry({
        task: {
          ...ledgerEntry().task,
          id: 'purchase-application-task-2',
        },
      }),
    );

    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      created: false,
      entry: {
        task: { id: 'purchase-application-task-1' },
      },
    });
  });

  it('allows only one reservation across concurrent Node processes', async () => {
    const ledgerPath = temporaryLedgerPath();
    const directory = join(ledgerPath, '..');
    const gatePath = join(directory, 'reservation-gate');
    const children = [1, 2].map((index) => {
      const readyPath = join(directory, `reservation-ready-${index}`);
      const entry = ledgerEntry({
        task: {
          ...ledgerEntry().task,
          id: `purchase-application-task-${index}`,
        },
      });
      const child = spawnReservationChild(
        ledgerPath,
        readyPath,
        gatePath,
        entry,
      );
      return {
        child,
        readyPath,
        outcome: collectChildOutcome(child),
      };
    });
    await Promise.all(
      children.map(({ readyPath }) => waitForPath(readyPath, 15_000)),
    );
    writeFileSync(gatePath, 'go', 'utf8');

    const results = await Promise.all(children.map(({ outcome }) => outcome));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
  }, 30_000);

  it('keeps a child-owned pending task pending while that process is alive', async () => {
    const ledgerPath = temporaryLedgerPath();
    const directory = join(ledgerPath, '..');
    const readyPath = join(directory, 'owner-ready');
    const exitGatePath = join(directory, 'owner-exit');
    const child = spawnInFlightOwnerChild(
      ledgerPath,
      readyPath,
      exitGatePath,
      inFlightLedgerEntry('pending'),
    );
    const outcome = collectChildOutcome(child);
    await waitForPath(readyPath, 15_000);

    const observerStore = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    let observedStatus: string | undefined;
    try {
      observedStatus = observerStore.findByTaskId('purchase-application-task-1')
        ?.task.status;
    } finally {
      writeFileSync(exitGatePath, 'exit', 'utf8');
      await outcome;
    }
    expect(observedStatus).toBe('pending');
    expect(
      observerStore.findByTaskId('purchase-application-task-1')?.task.status,
    ).toBe('uncertain');
  }, 30_000);

  it('recovers an in-flight task as uncertain after its owner process exits', async () => {
    const ledgerPath = temporaryLedgerPath();
    const readyPath = join(ledgerPath, '..', 'orphan-owner-ready');
    const child = spawnInFlightOwnerChild(
      ledgerPath,
      readyPath,
      null,
      inFlightLedgerEntry('running'),
    );
    await collectChildOutcome(child);

    expect(
      new PurchaseApplicationTaskLedgerStore(ledgerPath).findByTaskId(
        'purchase-application-task-1',
      ),
    ).toEqual(
      expect.objectContaining({
        task: expect.objectContaining({
          status: 'uncertain',
          message: expect.stringContaining('结果暂不确定'),
        }),
      }),
    );
  }, 30_000);

  it('recovers an in-flight task with invalid owner metadata as uncertain', () => {
    const ledgerPath = temporaryLedgerPath();
    new PurchaseApplicationTaskLedgerStore(ledgerPath).reserve(
      inFlightLedgerEntry('pending'),
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{ owner?: unknown }>;
    };
    ledger.entries[0].owner = { pid: 'invalid-owner' };
    writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf8');

    expect(
      new PurchaseApplicationTaskLedgerStore(ledgerPath).findByTaskId(
        'purchase-application-task-1',
      )?.task.status,
    ).toBe('uncertain');
  });

  it('isolates the same building and key by principal fingerprint', () => {
    const ledgerPath = temporaryLedgerPath();
    const firstStore = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    const secondStore = new PurchaseApplicationTaskLedgerStore(ledgerPath);

    const first = firstStore.reserve(ledgerEntry());
    const second = secondStore.reserve(
      ledgerEntry({
        principalFingerprint: 'principal-session-b',
        task: {
          ...ledgerEntry().task,
          id: 'purchase-application-task-2',
        },
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(
      firstStore.findByIdentity(
        'H楼',
        'principal-session-a',
        'purchase-mutation-001',
      )?.task.id,
    ).toBe('purchase-application-task-1');
    expect(
      secondStore.findByIdentity(
        'H楼',
        'principal-session-b',
        'purchase-mutation-001',
      )?.task.id,
    ).toBe('purchase-application-task-2');
  });

  it.each(['pending', 'running'] as const)(
    'keeps a same-process %s task active when a second store first reads it',
    (status) => {
      const ledgerPath = temporaryLedgerPath();
      const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);
      store.reserve(inFlightLedgerEntry(status));

      expect(
        new PurchaseApplicationTaskLedgerStore(ledgerPath).findByTaskId(
          'purchase-application-task-1',
        )?.task.status,
      ).toBe(status);
    },
  );

  it('publishes owner task progress to an already-loaded second store and clears owner at terminal', () => {
    const ledgerPath = temporaryLedgerPath();
    const ownerStore = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    const observerStore = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    const pendingEntry = inFlightLedgerEntry('pending');
    ownerStore.reserve(pendingEntry);
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({
      entries: [
        {
          owner: {
            pid: process.pid,
            processStartedAtMs: expect.any(Number),
            token: expect.any(String),
            acquiredAt: expect.any(String),
          },
        },
      ],
    });
    expect(
      observerStore.findByTaskId('purchase-application-task-1')?.task.status,
    ).toBe('pending');

    ownerStore.updateTask('purchase-application-task-1', {
      ...pendingEntry.task,
      status: 'running',
    });
    expect(
      observerStore.findByTaskId('purchase-application-task-1')?.task.status,
    ).toBe('running');

    ownerStore.updateTask('purchase-application-task-1', ledgerEntry().task);
    expect(
      observerStore.findByTaskId('purchase-application-task-1')?.task.status,
    ).toBe('completed');
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{ owner?: unknown }>;
    };
    expect(persisted.entries[0].owner).toBeUndefined();
  });

  it('fails closed without replacing a corrupted ledger', () => {
    const ledgerPath = temporaryLedgerPath();
    writeFileSync(ledgerPath, '{broken-json', 'utf8');
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);

    expect(() => store.findByTaskId('task-1')).toThrow(
      ServiceUnavailableException,
    );
    expect(() => store.reserve(ledgerEntry())).toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe('{broken-json');
  });

  it('preserves the primary persist error when temp cleanup also fails', () => {
    const ledgerPath = temporaryLedgerPath();
    const fixedUuid = '11111111-1111-4111-8111-111111111111';
    const randomUuid = jest
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue(fixedUuid);
    const temporaryPath = `${ledgerPath}.${process.pid}.${fixedUuid}.tmp`;
    mkdirSync(temporaryPath);
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);

    let thrown: unknown;
    try {
      store.reserve(ledgerEntry());
    } catch (error) {
      thrown = error;
    } finally {
      randomUuid.mockRestore();
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as Error).message).toContain('EEXIST');
    expect(
      (thrown as Error & { cleanupError?: NodeJS.ErrnoException }).cleanupError
        ?.code,
    ).toMatch(/^(?:EISDIR|EPERM)$/u);
  });

  it('fails closed on a v1 ledger instead of silently migrating it', () => {
    const ledgerPath = temporaryLedgerPath();
    const legacyLedger = JSON.stringify({
      version: 1,
      updatedAt: '2026-08-11T00:00:00.000Z',
      entries: [],
    });
    writeFileSync(ledgerPath, legacyLedger, 'utf8');
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);

    expect(() => store.findByTaskId('task-1')).toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(legacyLedger);
  });

  it.each([
    ['missing result arrays', { success: true, message: '已完成' }],
    [
      'invalid created item',
      {
        success: true,
        message: '已完成',
        created: [{}],
        failed: [],
        warnings: [],
      },
    ],
    [
      'invalid failed item',
      {
        success: false,
        message: '已完成',
        created: [],
        failed: [{ lineId: 'line-1' }],
        warnings: [],
      },
    ],
    [
      'invalid warning item',
      {
        success: true,
        message: '已完成',
        created: [],
        failed: [],
        warnings: [{ lineId: 'line-1', message: '警告' }],
      },
    ],
  ])('fails closed on %s in a persisted terminal result', (_label, result) => {
    const ledgerPath = temporaryLedgerPath();
    new PurchaseApplicationTaskLedgerStore(ledgerPath).reserve(ledgerEntry());
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{ task: { result: unknown } }>;
    };
    ledger.entries[0].task.result = result;
    const corruptedLedger = JSON.stringify(ledger);
    writeFileSync(ledgerPath, corruptedLedger, 'utf8');

    expect(() =>
      new PurchaseApplicationTaskLedgerStore(ledgerPath).findByTaskId(
        'purchase-application-task-1',
      ),
    ).toThrow(ServiceUnavailableException);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(corruptedLedger);
  });

  it('times out without deleting a fresh lock and retries after it becomes stale', () => {
    const ledgerPath = temporaryLedgerPath();
    const lockPath = `${ledgerPath}.lock`;
    writeFileSync(lockPath, 'lock-is-being-initialized', 'utf8');
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 20,
      lockRetryDelayMs: 2,
      staleLockMs: 60_000,
    });

    expect(() => store.findByTaskId('task-1')).toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(lockPath, 'utf8')).toBe('lock-is-being-initialized');

    const staleTimestamp = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTimestamp, staleTimestamp);
    expect(store.reserve(ledgerEntry())).toMatchObject({ created: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('immediately recovers a fresh valid lock after its owner process exits', async () => {
    const ledgerPath = temporaryLedgerPath();
    const lockPath = `${ledgerPath}.lock`;
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
    });
    const deadPid = child.pid;
    expect(deadPid).toBeDefined();
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', () => resolveExit());
    });
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        token: 'dead-owner',
        pid: deadPid,
        processStartedAtMs: Date.now() - 1_000,
        acquiredAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 30,
      lockRetryDelayMs: 2,
      staleLockMs: 60_000,
    });

    expect(store.reserve(ledgerEntry())).toMatchObject({ created: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not steal an old lock while its owning process is alive', () => {
    const ledgerPath = temporaryLedgerPath();
    const lockPath = `${ledgerPath}.lock`;
    const liveOwner = {
      version: 1,
      token: 'live-owner',
      pid: process.pid,
      processStartedAtMs: Math.round(Date.now() - process.uptime() * 1_000),
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(liveOwner), 'utf8');
    const staleTimestamp = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTimestamp, staleTimestamp);
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 20,
      lockRetryDelayMs: 2,
      staleLockMs: 10,
    });

    expect(() => store.findByTaskId('task-1')).toThrow(
      ServiceUnavailableException,
    );
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(liveOwner);
  });

  it('quarantines an old invalid lock before reserving', () => {
    const ledgerPath = temporaryLedgerPath();
    const lockPath = `${ledgerPath}.lock`;
    writeFileSync(lockPath, 'orphaned-lock', 'utf8');
    const staleTimestamp = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTimestamp, staleTimestamp);
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 100,
      lockRetryDelayMs: 2,
      staleLockMs: 10,
    });

    expect(store.reserve(ledgerEntry())).toMatchObject({ created: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(
      readdirSync(join(ledgerPath, '..')).filter((name) =>
        name.includes('.stale'),
      ),
    ).toEqual([]);
  });

  it('recovers an old invalid recovery guard without leaving lock artifacts', () => {
    const ledgerPath = temporaryLedgerPath();
    const lockPath = `${ledgerPath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    writeFileSync(lockPath, 'orphaned-lock', 'utf8');
    writeFileSync(recoveryPath, 'orphaned-recovery-guard', 'utf8');
    const staleTimestamp = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTimestamp, staleTimestamp);
    utimesSync(recoveryPath, staleTimestamp, staleTimestamp);
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath, {
      lockTimeoutMs: 100,
      lockRetryDelayMs: 2,
      staleLockMs: 10,
    });

    expect(store.reserve(ledgerEntry())).toMatchObject({ created: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it('retains terminal entries independently of memory pruning, then applies its own cap', () => {
    const ledgerPath = temporaryLedgerPath();
    let now = Date.parse('2026-08-11T00:00:00.000Z');
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath, {
      maxEntries: 2,
      retentionTtlMs: 24 * 60 * 60 * 1000,
      now: () => new Date(now),
    });

    for (let index = 1; index <= 3; index += 1) {
      const taskId = `purchase-application-task-${index}`;
      store.reserve(
        ledgerEntry({
          idempotencyKey: `purchase-mutation-00${index}`,
          task: {
            ...ledgerEntry().task,
            id: taskId,
            status: 'completed',
            completedAt: new Date(now).toISOString(),
          },
        }),
      );
      now += 1_000;
    }

    expect(store.findByTaskId('purchase-application-task-1')).toBeUndefined();
    expect(store.findByTaskId('purchase-application-task-2')).toBeDefined();
    expect(store.findByTaskId('purchase-application-task-3')).toBeDefined();
  });

  function temporaryLedgerPath(): string {
    const directory = mkdtempSync(
      join(tmpdir(), 'purchase-application-ledger-'),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, 'purchase-application-ledger.json');
    expect(existsSync(path)).toBe(false);
    return path;
  }
});

function spawnReservationChild(
  ledgerPath: string,
  readyPath: string,
  gatePath: string,
  entry: PurchaseApplicationTaskLedgerEntry,
): ChildProcessWithoutNullStreams {
  const source = `
    require('reflect-metadata');
    const fs = require('node:fs');
    const { PurchaseApplicationTaskLedgerStore } = require('./server/modules/purchase-inventory/purchase-application-task-ledger.store.ts');
    const store = new PurchaseApplicationTaskLedgerStore(${JSON.stringify(ledgerPath)}, {
      lockTimeoutMs: 5000,
      lockRetryDelayMs: 2,
      staleLockMs: 30000,
    });
    store.findByTaskId('preloaded-missing-task');
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready', 'utf8');
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${JSON.stringify(gatePath)})) {
      Atomics.wait(waitBuffer, 0, 0, 5);
    }
    const reservation = store.reserve(${JSON.stringify(entry)});
    process.stdout.write(JSON.stringify({
      created: reservation.created,
      taskId: reservation.entry.task.id,
    }));
  `;
  return spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(process.cwd(), 'tsconfig.node.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}

function spawnInFlightOwnerChild(
  ledgerPath: string,
  readyPath: string,
  exitGatePath: string | null,
  entry: PurchaseApplicationTaskLedgerEntry,
): ChildProcessWithoutNullStreams {
  const source = `
    require('reflect-metadata');
    const fs = require('node:fs');
    const { PurchaseApplicationTaskLedgerStore } = require('./server/modules/purchase-inventory/purchase-application-task-ledger.store.ts');
    const store = new PurchaseApplicationTaskLedgerStore(${JSON.stringify(ledgerPath)}, {
      lockTimeoutMs: 5000,
      lockRetryDelayMs: 2,
      staleLockMs: 30000,
    });
    const reservation = store.reserve(${JSON.stringify(entry)});
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready', 'utf8');
    const exitGatePath = ${JSON.stringify(exitGatePath)};
    if (exitGatePath) {
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(exitGatePath)) {
        Atomics.wait(waitBuffer, 0, 0, 5);
      }
    }
    process.stdout.write(JSON.stringify({
      created: reservation.created,
      taskId: reservation.entry.task.id,
    }));
  `;
  return spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(process.cwd(), 'tsconfig.node.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}

function collectChildOutcome(
  child: ChildProcessWithoutNullStreams,
): Promise<{ created: boolean; taskId: string }> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectOutcome);
    child.on('exit', (code) => {
      if (code !== 0) {
        rejectOutcome(new Error(`reservation child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolveOutcome(
          JSON.parse(stdout) as { created: boolean; taskId: string },
        );
      } catch (error) {
        rejectOutcome(error);
      }
    });
  });
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function ledgerEntry(
  overrides: Partial<PurchaseApplicationTaskLedgerEntry> = {},
): PurchaseApplicationTaskLedgerEntry {
  const task = {
    id: 'purchase-application-task-1',
    status: 'completed' as const,
    message: '已完成',
    createdAt: '2026-08-11T00:00:00.000Z',
    completedAt: '2026-08-11T00:00:01.000Z',
    result: {
      success: true,
      created: [],
      failed: [],
      warnings: [],
      message: '已完成',
    },
  };
  return {
    building: 'H楼',
    principalFingerprint: 'principal-session-a',
    idempotencyKey: 'purchase-mutation-001',
    requestFingerprint: '1'.repeat(64),
    submissionFingerprint: '2'.repeat(64),
    task,
    ...overrides,
  };
}

function inFlightLedgerEntry(
  status: 'pending' | 'running',
): PurchaseApplicationTaskLedgerEntry {
  return {
    ...ledgerEntry(),
    task: {
      id: 'purchase-application-task-1',
      status,
      message: '后台同步中',
      createdAt: '2026-08-11T00:00:00.000Z',
    },
  };
}
