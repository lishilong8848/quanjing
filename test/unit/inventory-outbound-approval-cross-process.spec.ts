import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryOutboundApprovalStore } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.store';
import type {
  InventoryOutboundApprovalDecisionInput,
  InventoryOutboundApprovalSnapshot,
} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.types';

const WORKER_PATH = join(
  __dirname,
  'inventory-outbound-approval-ledger.worker.cjs',
);
const WORKER_TIMEOUT_MS = 15_000;
jest.setTimeout(60_000);

type WorkerMessage =
  | { type: 'initialized' }
  | { type: 'result'; winner: boolean; eventId?: string; error?: string }
  | { type: 'error'; message: string };

interface WorkerHandle {
  child: ChildProcess;
  stderr: string;
  stdout: string;
}

describe('InventoryOutboundApprovalStore cross-process decision arbitration', () => {
  let directory: string;
  let ledgerPath: string;
  let workers: WorkerHandle[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'outbound-approval-process-'));
    ledgerPath = join(directory, 'approval-ledger.json');
    workers = [];
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await store.registerPending(snapshot());
    await store.confirmPendingRegistration('rec_outbound_process', 1);
    await deliver(store, 'ou_approver_a', 'om_approval_a');
    await deliver(store, 'ou_approver_b', 'om_approval_b');
  });

  afterEach(async () => {
    const errors: Error[] = [];
    for (const worker of workers.splice(0)) {
      try {
        await stopWorker(worker);
      } catch (error) {
        errors.push(asError(error));
      }
    }
    rmSync(directory, { recursive: true, force: true });
    if (errors.length > 0) throw errors[0];
  });

  it('allows exactly one first decision across two Node processes', async () => {
    const first = spawnWorker();
    const second = spawnWorker();
    workers.push(first, second);
    const approve = decision();
    const reject = decision({
      actorOpenId: 'ou_approver_b',
      messageId: 'om_approval_b',
      eventId: 'evt_process_reject',
      action: 'reject',
      reason: '申请用途信息不足',
    });

    await Promise.all([initialize(first, approve), initialize(second, reject)]);
    const firstResult = waitForMessage(first, isResult, 'first decision');
    const secondResult = waitForMessage(second, isResult, 'second decision');
    const notBeforeMs = Date.now() + 200;
    await Promise.all([
      send(first, { type: 'start', notBeforeMs }),
      send(second, { type: 'start', notBeforeMs }),
    ]);

    const results = await Promise.all([firstResult, secondResult]);
    expect(results.filter((result) => result.winner)).toHaveLength(1);
    expect(results.filter((result) => !result.winner)).toHaveLength(1);
    expect(results.find((result) => !result.winner)?.error).toContain(
      '已经完成审批',
    );

    const durable = await new InventoryOutboundApprovalStore(ledgerPath).find(
      'rec_outbound_process',
      1,
    );
    expect(['evt_process_approve', 'evt_process_reject']).toContain(
      durable?.decision?.eventId,
    );
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

  async function initialize(
    worker: WorkerHandle,
    input: InventoryOutboundApprovalDecisionInput,
  ): Promise<void> {
    const ready = waitForMessage(
      worker,
      isInitialized,
      'worker initialization',
    );
    await Promise.all([
      send(worker, { type: 'initialize', ledgerPath, decision: input }),
      ready,
    ]);
  }
});

async function deliver(
  store: InventoryOutboundApprovalStore,
  recipientOpenId: string,
  messageId: string,
): Promise<void> {
  const ref = {
    recordId: 'rec_outbound_process',
    version: 1,
    kind: 'approvalCardDelivery' as const,
    recipientOpenId,
  };
  const claim = await store.claimWork(ref);
  expect(claim.claimed).toBe(true);
  if (!claim.claimed) throw new Error('expected approval card claim');
  await store.completeWork({ ...ref, leaseToken: claim.leaseToken, messageId });
}

function snapshot(): InventoryOutboundApprovalSnapshot {
  return {
    recordId: 'rec_outbound_process',
    outboundNumber: 'outbound-process-client-mutation-001',
    version: 1,
    policyVersion: 'warehouse-manager-v1',
    applicantOpenId: 'ou_process_applicant',
    applicantName: '跨进程申请人',
    itemName: '地磅秤',
    sku: 'B1056',
    specification: '0.6×0.8米1吨',
    brand: '正峰',
    quantity: 1,
    unit: '台',
    availableStock: 1,
    building: 'H楼',
    location: 'H-2F-226储存间01-0F',
    reason: '跨进程审批测试',
    appliedAt: '2026-08-26T00:00:00.000Z',
    approvers: [
      { openId: 'ou_approver_a', name: '审批人甲' },
      { openId: 'ou_approver_b', name: '审批人乙' },
    ],
  };
}

function decision(
  overrides: Partial<InventoryOutboundApprovalDecisionInput> = {},
): InventoryOutboundApprovalDecisionInput {
  return {
    recordId: 'rec_outbound_process',
    version: 1,
    actorOpenId: 'ou_approver_a',
    messageId: 'om_approval_a',
    eventId: 'evt_process_approve',
    action: 'approve',
    ...overrides,
  };
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
      worker.child.off('exit', onExit);
    };
    worker.child.on('message', onMessage);
    worker.child.once('exit', onExit);
  });
}

function send(
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
    await send(worker, { type: 'release' }).catch(() => undefined);
  }
  if (await waitForExit(worker.child, 1_000)) return;
  worker.child.kill();
  if (!(await waitForExit(worker.child, 2_000))) {
    throw new Error(`Unable to stop worker pid=${String(worker.child.pid)}`);
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

function isInitialized(
  message: WorkerMessage,
): message is Extract<WorkerMessage, { type: 'initialized' }> {
  return message.type === 'initialized';
}

function isResult(
  message: WorkerMessage,
): message is Extract<WorkerMessage, { type: 'result' }> {
  return message.type === 'result';
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
