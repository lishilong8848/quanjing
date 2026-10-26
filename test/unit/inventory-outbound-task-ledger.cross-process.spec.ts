import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InventoryOutboundMovementCreateRequest } from '../../shared/inventory-management.interface';
import {
  InventoryOutboundTaskLedgerStore,
  type InventoryOutboundTaskLedgerEntry,
} from '../../server/modules/inventory-management/inventory-outbound-task-ledger.store';
import { buildInventoryOutboundRequestFingerprint } from '../../server/modules/inventory-management/inventory-outbound-canonical';

const WORKER_PATH = join(
  __dirname,
  'inventory-outbound-task-ledger.worker.cjs',
);
const WORKER_TIMEOUT_MS = 15_000;
jest.setTimeout(60_000);

const REQUEST: InventoryOutboundMovementCreateRequest = {
  type: 'outbound',
  clientMutationId: 'outbound-process-ledger-1',
  catalogRecordId: 'catalog-a101',
  sku: 'A101',
  building: 'A楼',
  quantity: 2,
  occurredAt: '2026-08-12T01:00:00.000Z',
  applicantOpenId: 'ou_process_applicant',
  reason: '跨进程并发测试',
};

type WorkerMessage =
  | { type: 'initialized' }
  | { type: 'phase'; name: 'observed-absent' | 'observed-existing' }
  | { type: 'result'; winner: boolean; taskId: string }
  | { type: 'error'; message: string };

interface WorkerHandle {
  child: ChildProcess;
  stderr: string;
  stdout: string;
}

describe('InventoryOutboundTaskLedgerStore cross-process arbitration', () => {
  let directory: string;
  let workers: WorkerHandle[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'inventory-outbound-process-'));
    workers = [];
  });

  afterEach(async () => {
    const cleanupErrors: Error[] = [];
    for (const worker of workers.splice(0)) {
      try {
        await stopWorker(worker);
      } catch (error) {
        cleanupErrors.push(asError(error));
      }
    }
    rmSync(directory, { recursive: true, force: true });
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  });

  it('proves the IPC barrier exposes two winners for an intentionally lockless substitute', async () => {
    const probePath = join(directory, 'lockless-winners.txt');
    const first = spawnWorker();
    const second = spawnWorker();
    workers.push(first, second);

    await Promise.all([
      initializeWorker(first, {
        type: 'initialize',
        action: 'lockless-reserve-probe',
        probePath,
        taskId: 'lockless-task-1',
      }),
      initializeWorker(second, {
        type: 'initialize',
        action: 'lockless-reserve-probe',
        probePath,
        taskId: 'lockless-task-2',
      }),
    ]);

    const firstObserved = waitForMessage(
      first,
      isPhaseMessage,
      'first lockless read phase',
    );
    const secondObserved = waitForMessage(
      second,
      isPhaseMessage,
      'second lockless read phase',
    );
    await Promise.all([
      sendMessage(first, { type: 'start' }),
      sendMessage(second, { type: 'start' }),
    ]);

    expect(await Promise.all([firstObserved, secondObserved])).toEqual([
      { type: 'phase', name: 'observed-absent' },
      { type: 'phase', name: 'observed-absent' },
    ]);

    const firstResult = waitForMessage(
      first,
      isResultMessage,
      'first lockless result',
    );
    const secondResult = waitForMessage(
      second,
      isResultMessage,
      'second lockless result',
    );
    await Promise.all([
      sendMessage(first, { type: 'commit' }),
      sendMessage(second, { type: 'commit' }),
    ]);

    const results = await Promise.all([firstResult, secondResult]);
    expect(results.filter((result) => result.winner)).toHaveLength(2);
    expect(existsSync(probePath)).toBe(true);
    const winnerPids = readFileSync(probePath, 'utf8').trim().split(/\r?\n/u);
    expect(winnerPids).toHaveLength(2);
    expect(new Set(winnerPids).size).toBe(2);
  });

  it('globally reserves one client mutation across two Node processes', async () => {
    const ledgerPath = join(directory, 'outbound-ledger.json');
    const first = spawnWorker();
    const second = spawnWorker();
    workers.push(first, second);

    await Promise.all([
      initializeWorker(first, {
        type: 'initialize',
        action: 'production-reserve',
        ledgerPath,
        entry: pendingEntry('inventory-outbound-process-task-1'),
      }),
      initializeWorker(second, {
        type: 'initialize',
        action: 'production-reserve',
        ledgerPath,
        entry: pendingEntry('inventory-outbound-process-task-2'),
      }),
    ]);

    const results = await runWorkersTogether(first, second);
    const winners = results.filter((result) => result.winner);
    expect(winners).toHaveLength(1);
    expect(new Set(results.map((result) => result.taskId)).size).toBe(1);

    const durable = await new InventoryOutboundTaskLedgerStore(
      ledgerPath,
    ).findByTaskId(winners[0].taskId);
    expect(durable).toMatchObject({
      clientMutationId: REQUEST.clientMutationId,
      task: { id: winners[0].taskId, status: 'pending' },
    });
  });

  it('allows one external-write claim for a pending task across two Node processes', async () => {
    const ledgerPath = join(directory, 'outbound-ledger.json');
    const taskId = 'inventory-outbound-process-claim-task';
    await new InventoryOutboundTaskLedgerStore(ledgerPath).reserve(
      pendingEntry(taskId),
    );
    const first = spawnWorker();
    const second = spawnWorker();
    workers.push(first, second);

    await Promise.all([
      initializeWorker(first, {
        type: 'initialize',
        action: 'production-claim',
        ledgerPath,
        taskId,
      }),
      initializeWorker(second, {
        type: 'initialize',
        action: 'production-claim',
        ledgerPath,
        taskId,
      }),
    ]);

    const results = await runWorkersTogether(first, second);
    expect(results.filter((result) => result.winner)).toHaveLength(1);
    expect(results.map((result) => result.taskId)).toEqual([taskId, taskId]);
    expect(first.child.exitCode).toBeNull();
    expect(second.child.exitCode).toBeNull();

    expect(
      await new InventoryOutboundTaskLedgerStore(ledgerPath).findByTaskId(
        taskId,
      ),
    ).toMatchObject({ task: { id: taskId, status: 'pending' } });
  });

  it('allows one reconciliation claim for an uncertain task across two Node processes', async () => {
    const ledgerPath = join(directory, 'outbound-ledger.json');
    const taskId = 'inventory-outbound-process-uncertain-task';
    const seed = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await seed.reserve(pendingEntry(taskId));
    const pendingClaim = await seed.claimPending(taskId);
    await seed.updateTask(taskId, {
      ...pendingClaim.entry.task,
      status: 'uncertain',
      message: '外部创建结果暂不确定',
      completedAt: '2026-08-12T01:01:00.000Z',
      definitelyNotWritten: false,
    });
    const first = spawnWorker();
    const second = spawnWorker();
    workers.push(first, second);

    await Promise.all([
      initializeWorker(first, {
        type: 'initialize',
        action: 'production-claim-uncertain',
        ledgerPath,
        taskId,
      }),
      initializeWorker(second, {
        type: 'initialize',
        action: 'production-claim-uncertain',
        ledgerPath,
        taskId,
      }),
    ]);

    const results = await runWorkersTogether(first, second);
    expect(results.filter((result) => result.winner)).toHaveLength(1);
    expect(results.map((result) => result.taskId)).toEqual([taskId, taskId]);
    expect(first.child.exitCode).toBeNull();
    expect(second.child.exitCode).toBeNull();
  });

  function spawnWorker(): WorkerHandle {
    const child = fork(WORKER_PATH, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(process.cwd(), 'tsconfig.node.json'),
      },
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const handle: WorkerHandle = { child, stderr: '', stdout: '' };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      handle.stderr += chunk;
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      handle.stdout += chunk;
    });
    return handle;
  }
});

async function runWorkersTogether(
  first: WorkerHandle,
  second: WorkerHandle,
): Promise<Array<Extract<WorkerMessage, { type: 'result' }>>> {
  const firstResult = waitForMessage(
    first,
    isResultMessage,
    'first production result',
  );
  const secondResult = waitForMessage(
    second,
    isResultMessage,
    'second production result',
  );
  const notBeforeMs = Date.now() + 200;
  await Promise.all([
    sendMessage(first, { type: 'start', notBeforeMs }),
    sendMessage(second, { type: 'start', notBeforeMs }),
  ]);
  return Promise.all([firstResult, secondResult]);
}

async function initializeWorker(
  worker: WorkerHandle,
  command: Record<string, unknown>,
): Promise<void> {
  const initialized = waitForMessage(
    worker,
    isInitializedMessage,
    'worker initialization',
  );
  await Promise.all([sendMessage(worker, command), initialized]);
}

function waitForMessage<T extends WorkerMessage>(
  worker: WorkerHandle,
  predicate: (message: WorkerMessage) => message is T,
  label: string,
): Promise<T> {
  return new Promise<T>((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectMessage(
        new Error(
          `Timed out waiting for ${label}; stderr=${worker.stderr}; stdout=${worker.stdout}`,
        ),
      );
    }, WORKER_TIMEOUT_MS);

    const onMessage = (value: unknown) => {
      if (!isWorkerMessage(value)) return;
      if (value.type === 'error') {
        cleanup();
        rejectMessage(new Error(`Worker failed: ${value.message}`));
        return;
      }
      if (!predicate(value)) return;
      cleanup();
      resolveMessage(value);
    };
    const onError = (error: Error) => {
      cleanup();
      rejectMessage(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectMessage(
        new Error(
          `Worker exited before ${label}: code=${String(code)} signal=${String(signal)} stderr=${worker.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.child.off('message', onMessage);
      worker.child.off('error', onError);
      worker.child.off('exit', onExit);
    };

    worker.child.on('message', onMessage);
    worker.child.once('error', onError);
    worker.child.once('exit', onExit);
  });
}

function sendMessage(
  worker: WorkerHandle,
  message: Record<string, unknown>,
): Promise<void> {
  return new Promise<void>((resolveSend, rejectSend) => {
    if (!worker.child.connected) {
      rejectSend(new Error('Worker IPC channel is disconnected'));
      return;
    }
    worker.child.send(message, (error) => {
      if (error) rejectSend(error);
      else resolveSend();
    });
  });
}

async function stopWorker(worker: WorkerHandle): Promise<void> {
  if (hasExited(worker.child)) return;
  if (worker.child.connected) {
    await sendMessage(worker, { type: 'release' }).catch(() => undefined);
  }
  if (await waitForExit(worker.child, 1_000)) return;
  worker.child.kill();
  if (!(await waitForExit(worker.child, 2_000))) {
    throw new Error(
      `Unable to stop ledger worker pid=${String(worker.child.pid)}`,
    );
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      cleanup();
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolveExit(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onExit);
    };
    child.once('exit', onExit);
    child.once('error', onExit);
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

function isInitializedMessage(
  message: WorkerMessage,
): message is Extract<WorkerMessage, { type: 'initialized' }> {
  return message.type === 'initialized';
}

function isPhaseMessage(
  message: WorkerMessage,
): message is Extract<WorkerMessage, { type: 'phase' }> {
  return message.type === 'phase';
}

function isResultMessage(
  message: WorkerMessage,
): message is Extract<WorkerMessage, { type: 'result' }> {
  return message.type === 'result';
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function pendingEntry(taskId: string): InventoryOutboundTaskLedgerEntry {
  return {
    building: REQUEST.building,
    principalFingerprint: 'principal-process-fingerprint',
    clientMutationId: REQUEST.clientMutationId,
    requestFingerprint: buildInventoryOutboundRequestFingerprint(REQUEST),
    request: REQUEST,
    task: {
      id: taskId,
      status: 'pending',
      message: '出库申请已受理',
      createdAt: '2026-08-12T01:00:00.000Z',
    },
  };
}
