import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePurchaseManagerApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';

type QueueEntry = {
  key: string;
  eventId: string;
  recordId: string;
  action: 'approve' | 'reject';
  actorOpenId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
};

type NotificationKind =
  | 'approval_requested'
  | 'approval_resolved'
  | 'purchase_assigned'
  | 'purchase_rejected'
  | 'warehouse_inbound'
  | 'inventory_inbound_completed_resolution'
  | 'inventory_inbound_completed'
  | 'manual_inventory_inbound_completed_resolution'
  | 'manual_inventory_inbound_completed'
  | 'purchase_completed'
  | 'manager_approval_requested'
  | 'manager_approval_resolved'
  | 'manager_approval_reopened'
  | 'manager_approval_attention_required';

type NotificationEntry = {
  key: string;
  businessEventId: string;
  recordId: string;
  recipientOpenId: string;
  kind: NotificationKind;
  status: QueueEntry['status'] | 'manual_reconciliation';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
  deliveryId: string;
  messageId: string;
  deliveryUuid: string;
  firstSendAttemptAt: string;
  sendOutcome:
    | 'unattempted'
    | 'unknown'
    | 'delivered'
    | 'manual_reconciliation';
  deliveryGeneration: number;
  cardContext: string;
  deliveryAudit: Array<{
    action: string;
    at: string;
    operatorOpenId: string;
    generation: number;
    deliveryUuid: string;
    messageId: string;
  }>;
};

type ManagerCardEntry = {
  key: string;
  executionRecordId: string;
  messageId: string;
  supersededMessageIds: string[];
  recipientOpenId: string;
  sourceNotificationKey: string;
  sourceKind: 'manager_approval_requested';
  sourceStatus: 'completed';
  cardContext: string;
  state:
    | 'initial'
    | 'reject_editing'
    | 'pending'
    | 'resolved'
    | 'manual_reconciliation';
  choice: '' | 'comprehensive' | 'building_self' | 'reject';
  rejectionReasonDraft: string;
  actionEventId: string;
  actorOpenId: string;
  processedAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string;
};

type ManagerActionEntry = {
  key: string;
  eventId: string;
  recordId: string;
  choice: 'comprehensive' | 'building_self' | 'reject';
  rejectionReason: string;
  messageId: string;
  actorOpenId: string;
  status: QueueEntry['status'] | 'manual_reconciliation';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
};

type StoreV2 = PurchaseWorkflowStore & {
  onModuleInit(): Promise<void>;
  onModuleDestroy(): Promise<void>;
  claimCardAction(
    input: Record<string, unknown>,
    now?: Date | number,
  ): Promise<{ claimed: boolean; entry: QueueEntry }>;
  takeNextCardAction(
    now?: Date | number,
    leaseMs?: number,
  ): Promise<QueueEntry | null>;
  completeCardAction(
    key: string,
    claimToken: string,
    now?: Date | number,
  ): Promise<QueueEntry | null>;
  rescheduleCardAction(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number,
    now?: Date | number,
  ): Promise<QueueEntry | null>;
  failCardAction(
    key: string,
    claimToken: string,
    error: unknown,
    now?: Date | number,
  ): Promise<QueueEntry | null>;
  getCardAction(key: string): Promise<QueueEntry | null>;
  listCardActions(filter?: {
    recordId?: string;
    status?: QueueEntry['status'];
  }): Promise<QueueEntry[]>;
  enqueueNotification(
    input: Record<string, unknown>,
    now?: Date | number,
  ): Promise<{ enqueued: boolean; entry: NotificationEntry }>;
  enqueueNotifications(
    inputs: Array<Record<string, unknown>>,
    now?: Date | number,
  ): Promise<Array<{ enqueued: boolean; entry: NotificationEntry }>>;
  takeNextNotification(
    now?: Date | number,
    leaseMs?: number,
    allowedKinds?: readonly NotificationKind[],
  ): Promise<NotificationEntry | null>;
  takeNextManagerApprovalNotification(
    now?: Date | number,
    leaseMs?: number,
  ): Promise<NotificationEntry | null>;
  markManagerApprovalSendStarted(
    key: string,
    claimToken: string,
    cardContext: string,
    now?: Date | number,
  ): Promise<NotificationEntry | null>;
  markInboundCompletedSendStarted(
    key: string,
    claimToken: string,
    now?: Date | number,
  ): Promise<NotificationEntry | null>;
  resolveUnknownManagerApprovalDelivery(
    key: string,
    input: {
      resolution: 'verified_delivered' | 'verified_absent';
      operatorOpenId: string;
      messageId?: string;
    },
    now?: Date | number,
  ): Promise<{
    notification: NotificationEntry;
    card: ManagerCardEntry | null;
  }>;
  completeManagerApprovalRequestAndRegisterCard(
    key: string,
    claimToken: string,
    delivery: { deliveryId?: string; messageId: string },
    now?: Date | number,
  ): Promise<{
    notification: NotificationEntry;
    card: ManagerCardEntry;
  }>;
  findManagerApprovalCard(
    messageId: string,
    recipientOpenId: string,
  ): Promise<ManagerCardEntry | null>;
  openManagerApprovalRejectEditor(
    input: {
      recordId: string;
      messageId: string;
      actorOpenId: string;
    },
    now?: Date | number,
  ): Promise<{ opened: boolean; card: ManagerCardEntry }>;
  claimManagerApprovalAction(
    input: {
      eventId: string;
      recordId: string;
      choice: 'comprehensive' | 'building_self' | 'reject';
      rejectionReason?: string;
      messageId: string;
      actorOpenId: string;
    },
    now?: Date | number,
  ): Promise<{
    claimed: boolean;
    entry: ManagerActionEntry | null;
    card: ManagerCardEntry;
  }>;
  takeNextManagerApprovalAction(
    now?: Date | number,
    leaseMs?: number,
  ): Promise<ManagerActionEntry | null>;
  rescheduleManagerApprovalAction(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number,
    now?: Date | number,
  ): Promise<ManagerActionEntry | null>;
  completeManagerApprovalActionAndEnqueueResolved(
    key: string,
    claimToken: string,
    now?: Date | number,
  ): Promise<{
    action: ManagerActionEntry;
    card: ManagerCardEntry;
    notification: NotificationEntry;
  }>;
  failManagerApprovalActionAndEnqueueReopen(
    key: string,
    claimToken: string,
    error: unknown,
    now?: Date | number,
  ): Promise<{
    action: ManagerActionEntry;
    card: ManagerCardEntry;
    notification: NotificationEntry;
  }>;
  markManagerApprovalManualReconciliation(
    key: string,
    claimToken: string,
    error: unknown,
    now?: Date | number,
  ): Promise<{
    action: ManagerActionEntry;
    card: ManagerCardEntry;
    notification: NotificationEntry;
  }>;
  bindUnknownManagerApprovalDeliveryFromCallback(
    input: {
      recordId: string;
      messageId: string;
      actorOpenId: string;
    },
    now?: Date | number,
  ): Promise<{
    bound: boolean;
    notification: NotificationEntry;
    card: ManagerCardEntry;
  }>;
  replaceManagerApprovalCardMessage(
    key: string,
    claimToken: string,
    input: {
      oldMessageId: string;
      newMessageId: string;
      deliveryId?: string;
    },
    now?: Date | number,
  ): Promise<{
    notification: NotificationEntry;
    card: ManagerCardEntry;
  }>;
  listManagerApprovalActions(filter?: {
    recordId?: string;
    status?: ManagerActionEntry['status'];
  }): Promise<ManagerActionEntry[]>;
  completeNotification(
    key: string,
    claimToken: string,
    delivery?: { deliveryId?: string; messageId?: string },
    now?: Date | number,
  ): Promise<NotificationEntry | null>;
  completeInboundCompletedResolutionAndEnqueueNotifications(
    key: string,
    claimToken: string,
    inputs: Array<{
      businessEventId: string;
      recordId: string;
      recipientOpenId: string;
      kind: NotificationKind;
      cardContext?: string;
    }>,
    now?: Date | number,
  ): Promise<{
    resolution: NotificationEntry;
    notifications: NotificationEntry[];
  }>;
  rescheduleNotification(
    key: string,
    claimToken: string,
    error: unknown,
    nextAttemptAt: Date | number,
    now?: Date | number,
  ): Promise<NotificationEntry | null>;
  failNotification(
    key: string,
    claimToken: string,
    error: unknown,
    now?: Date | number,
  ): Promise<NotificationEntry | null>;
  getNotification(key: string): Promise<NotificationEntry | null>;
  listNotifications(filter?: {
    recordId?: string;
    kind?: NotificationKind;
    status?: QueueEntry['status'];
    recipientOpenId?: string;
  }): Promise<NotificationEntry[]>;
};

function createV2Store(path: string): StoreV2 {
  return new PurchaseWorkflowStore(path) as StoreV2;
}

function managerCardContext(recordId: string, building = 'D楼'): string {
  return serializePurchaseManagerApprovalCardContext({
    executionRecordId: recordId,
    requester: '申请人',
    building,
    title: '温湿度传感器',
    quantity: 1,
    unit: '台',
    amount: 100,
    procurementForm: '三方比价',
    expectedDeliveryAt: '2026-08-10',
    requestCode: 'CG-TEST-001',
    createdAt: '2026-07-31 09:00',
  });
}

async function registerInitialManagerCard(
  store: StoreV2,
  input: {
    recordId: string;
    messageId: string;
    recipientOpenId?: string;
    businessEventId?: string;
    building?: string;
  },
  now = new Date('2026-07-31T08:00:00.000Z'),
): Promise<ManagerCardEntry> {
  const recipientOpenId = input.recipientOpenId || 'manager-one';
  const enqueued = await store.enqueueNotification(
    {
      businessEventId:
        input.businessEventId || `manager_approval_requested:${input.recordId}`,
      recordId: input.recordId,
      recipientOpenId,
      kind: 'manager_approval_requested',
    },
    now,
  );
  const claimed = await store.takeNextManagerApprovalNotification(
    new Date(now.getTime() + 1_000),
  );
  if (!claimed) throw new Error('Expected manager notification claim');
  await store.markManagerApprovalSendStarted(
    claimed.key,
    claimed.claimToken,
    managerCardContext(input.recordId, input.building),
    new Date(now.getTime() + 1_000),
  );
  const completed = await store.completeManagerApprovalRequestAndRegisterCard(
    enqueued.entry.key,
    claimed.claimToken,
    { messageId: input.messageId },
    new Date(now.getTime() + 2_000),
  );
  return completed.card;
}

async function createManualReopenedManagerDelivery(
  store: StoreV2,
  input: {
    recordId: string;
    oldMessageId: string;
    eventId: string;
    choice: 'comprehensive' | 'building_self' | 'reject';
    rejectionReason?: string;
    startedAt: Date;
  },
): Promise<{
  notification: NotificationEntry;
  action: ManagerActionEntry;
}> {
  await registerInitialManagerCard(
    store,
    {
      recordId: input.recordId,
      messageId: input.oldMessageId,
    },
    input.startedAt,
  );
  if (input.choice === 'reject') {
    await store.openManagerApprovalRejectEditor(
      {
        recordId: input.recordId,
        messageId: input.oldMessageId,
        actorOpenId: 'manager-one',
      },
      new Date(input.startedAt.getTime() + 3_000),
    );
  }
  const accepted = await store.claimManagerApprovalAction(
    {
      eventId: input.eventId,
      recordId: input.recordId,
      choice: input.choice,
      rejectionReason: input.rejectionReason,
      messageId: input.oldMessageId,
      actorOpenId: 'manager-one',
    },
    new Date(input.startedAt.getTime() + 4_000),
  );
  const claimed = await store.takeNextManagerApprovalAction(
    new Date(input.startedAt.getTime() + 5_000),
  );
  const reopened = await store.failManagerApprovalActionAndEnqueueReopen(
    accepted.entry?.key || '',
    claimed?.claimToken || '',
    new Error('confirmed no write'),
    new Date(input.startedAt.getTime() + 6_000),
  );
  const notification = await store.takeNextManagerApprovalNotification(
    new Date(input.startedAt.getTime() + 7_000),
    1_000,
  );
  if (!notification) throw new Error('Expected reopened notification claim');
  await store.markManagerApprovalSendStarted(
    notification.key,
    notification.claimToken,
    reopened.card.cardContext,
    new Date(input.startedAt.getTime() + 7_000),
  );
  await expect(
    store.takeNextManagerApprovalNotification(
      new Date(input.startedAt.getTime() + 60 * 60 * 1_000 + 8_000),
    ),
  ).resolves.toMatchObject({
    key: reopened.notification.key,
    status: 'manual_reconciliation',
    sendOutcome: 'manual_reconciliation',
  });
  const manual = await store.getNotification(reopened.notification.key);
  if (!manual) throw new Error('Expected manual reopened notification');
  return { notification: manual, action: reopened.action };
}

type StoreWorkerResult =
  | { type: 'acquired' }
  | { type: 'failed'; name: string; message: string };

const STORE_WORKER_SOURCE = String.raw`
const { existsSync, writeFileSync } = require('node:fs');
const { PurchaseWorkflowStore } = require(process.env.CODEX_STORE_MODULE);

const stalePid = Number(process.env.CODEX_STALE_PID || 0);
const pauseMarker = process.env.CODEX_PAUSE_MARKER || '';
const releaseMarker = process.env.CODEX_RELEASE_MARKER || '';
let paused = false;
if (stalePid && pauseMarker && releaseMarker) {
  const originalKill = process.kill;
  process.kill = function patchedKill(pid, signal) {
    try {
      return originalKill.call(process, pid, signal);
    } catch (error) {
      if (!paused && pid === stalePid && error && error.code === 'ESRCH') {
        paused = true;
        writeFileSync(pauseMarker, 'inspected', 'utf8');
        const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(releaseMarker)) {
          Atomics.wait(waitBuffer, 0, 0, 10);
        }
      }
      throw error;
    }
  };
}

const store = new PurchaseWorkflowStore(process.env.CODEX_LEDGER_PATH);
process.once('message', async (message) => {
  if (message !== 'start') return;
  try {
    await store.onModuleInit();
    if (process.send) process.send({ type: 'acquired' });
    setTimeout(async () => {
      await store.onModuleDestroy();
      process.exit(0);
    }, Number(process.env.CODEX_HOLD_MS || 5000));
  } catch (error) {
    if (process.send) {
      process.send({
        type: 'failed',
        name: error && error.constructor ? error.constructor.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await store.onModuleDestroy();
    process.exit(2);
  }
});
if (process.send) process.send({ type: 'ready' });
`;

function startStoreWorker(
  ledgerPath: string,
  options: {
    stalePid?: number;
    pauseMarker?: string;
    releaseMarker?: string;
  } = {},
): {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  result: Promise<StoreWorkerResult>;
  start(): void;
} {
  const child = spawn(
    process.execPath,
    [
      '-r',
      require.resolve('ts-node/register/transpile-only'),
      '-e',
      STORE_WORKER_SOURCE,
    ],
    {
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(process.cwd(), 'tsconfig.node.json'),
        CODEX_STORE_MODULE: join(
          process.cwd(),
          'server/modules/purchase-inventory/purchase-workflow.store.ts',
        ),
        CODEX_LEDGER_PATH: ledgerPath,
        CODEX_STALE_PID: String(options.stalePid || ''),
        CODEX_PAUSE_MARKER: options.pauseMarker || '',
        CODEX_RELEASE_MARKER: options.releaseMarker || '',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let readySettled = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: StoreWorkerResult) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const result = new Promise<StoreWorkerResult>(
    (resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    },
  );
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const event = message as { type?: unknown };
    if (event.type === 'ready' && !readySettled) {
      readySettled = true;
      resolveReady();
    }
    if (
      (event.type === 'acquired' || event.type === 'failed') &&
      !resultSettled
    ) {
      resultSettled = true;
      resolveResult(message as StoreWorkerResult);
    }
  });
  child.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  });
  child.once('exit', (code) => {
    const error = new Error(
      `Store worker exited before reporting (code ${String(code)}): ${stderr}`,
    );
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  });
  return {
    child,
    ready,
    result,
    start: () => child.send('start'),
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
  });
  child.kill();
  await exited;
}

describe('PurchaseWorkflowStore', () => {
  let directory = '';
  let ledgerPath = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'purchase-workflow-store-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  it('records command results and returns the existing idempotent result', async () => {
    const store = new PurchaseWorkflowStore(ledgerPath);
    await store.recordCommand({
      key: 'approve:rec_1:ou_manager',
      recordId: 'rec_1',
      action: 'approve',
      actorOpenId: 'ou_manager',
      accessRole: 'admin',
      authenticationMode: 'feishu-oauth',
      completedAt: '2026-07-11T10:00:00.000+08:00',
      notificationWarnings: [],
    });

    await expect(
      store.findCommand('approve:rec_1:ou_manager'),
    ).resolves.toMatchObject({
      recordId: 'rec_1',
      action: 'approve',
      actorOpenId: 'ou_manager',
      accessRole: 'admin',
      authenticationMode: 'feishu-oauth',
    });
    expect(await readFile(ledgerPath, 'utf8')).not.toContain('u-user-token');
  });

  it('atomically claims one durable command and releases only the matching pending claim', async () => {
    const store = new PurchaseWorkflowStore(ledgerPath);
    const input = {
      key: 'order:rec_claimed',
      recordId: 'rec_claimed',
      action: 'order' as const,
      fingerprint: 'a'.repeat(64),
      expectedResultFingerprint: 'b'.repeat(64),
      actorOpenId: 'ou_purchase_manager',
      accessRole: 'purchase_admin' as const,
      authenticationMode: 'delegated-app' as const,
      startedAt: '2026-07-31T05:00:00.000Z',
    };

    const claims = await Promise.all([
      store.claimCommand(input),
      store.claimCommand(input),
    ]);

    expect(claims.map((result) => result.claimed)).toEqual([true, false]);
    await expect(store.findCommand(input.key)).resolves.toMatchObject({
      fingerprint: input.fingerprint,
      expectedResultFingerprint: input.expectedResultFingerprint,
      startedAt: input.startedAt,
      completedAt: '',
    });
    await expect(
      store.releaseCommandClaim(input.key, 'different-fingerprint'),
    ).resolves.toBe(false);
    await expect(
      store.releaseCommandClaim(input.key, input.fingerprint),
    ).resolves.toBe(true);
    await expect(store.findCommand(input.key)).resolves.toBeNull();
  });

  it('never evicts an active command claim when the ledger reaches its limit', async () => {
    const commands = Array.from({ length: 500 }, (_, index) => ({
      key: `order:rec_active_${index}`,
      recordId: `rec_active_${index}`,
      action: 'order',
      fingerprint: index.toString(16).padStart(64, '0'),
      actorOpenId: 'ou_purchase_manager',
      accessRole: 'purchase_admin',
      authenticationMode: 'delegated-app',
      startedAt: '2026-07-31T05:00:00.000Z',
      completedAt: '',
      notificationWarnings: [],
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({ version: 2, commands }),
      'utf8',
    );
    const store = new PurchaseWorkflowStore(ledgerPath);

    await expect(
      store.claimCommand({
        key: 'order:rec_active_501',
        recordId: 'rec_active_501',
        action: 'order',
        fingerprint: 'f'.repeat(64),
        expectedResultFingerprint: 'e'.repeat(64),
        actorOpenId: 'ou_purchase_manager',
        accessRole: 'purchase_admin',
        authenticationMode: 'delegated-app',
        startedAt: '2026-07-31T05:01:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      store.findCommand('order:rec_active_0'),
    ).resolves.toMatchObject({
      completedAt: '',
    });
  });

  it('preserves the purchase administrator role for delegated-app audit records', async () => {
    const store = new PurchaseWorkflowStore(ledgerPath);
    await store.recordCommand({
      key: 'order:rec_2:ou_purchase_manager',
      recordId: 'rec_2',
      action: 'order',
      actorOpenId: 'ou_purchase_manager',
      accessRole: 'purchase_admin',
      authenticationMode: 'delegated-app',
      completedAt: '2026-07-15T10:00:00.000+08:00',
      notificationWarnings: [],
    });

    await expect(
      store.findCommand('order:rec_2:ou_purchase_manager'),
    ).resolves.toMatchObject({
      accessRole: 'purchase_admin',
      authenticationMode: 'delegated-app',
    });
  });

  it('preserves the Feishu supply-chain administrator role for delegated-app audit records', async () => {
    const store = new PurchaseWorkflowStore(ledgerPath);
    await store.recordCommand({
      key: 'order:rec_3:ou_supply_chain_manager',
      recordId: 'rec_3',
      action: 'order',
      actorOpenId: 'ou_supply_chain_manager',
      accessRole: 'supply_chain_admin',
      authenticationMode: 'delegated-app',
      completedAt: '2026-07-17T10:00:00.000+08:00',
      notificationWarnings: [],
    });

    await expect(
      store.findCommand('order:rec_3:ou_supply_chain_manager'),
    ).resolves.toMatchObject({
      accessRole: 'supply_chain_admin',
      authenticationMode: 'delegated-app',
    });
  });

  it('reads a legacy ledger without audit fields and fills safe unknown values', async () => {
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 1,
        commands: [
          {
            key: 'approve:rec_legacy',
            recordId: 'rec_legacy',
            action: 'approve',
            completedAt: '2026-07-10T10:00:00.000+08:00',
            notificationWarnings: [],
          },
        ],
        reminders: [],
      }),
      'utf8',
    );
    const store = new PurchaseWorkflowStore(ledgerPath);

    await expect(
      store.findCommand('approve:rec_legacy'),
    ).resolves.toMatchObject({
      actorOpenId: '',
      accessRole: 'unknown',
      authenticationMode: 'unknown',
    });
  });

  it('deduplicates reminder keys and keeps bounded recent history', async () => {
    const store = new PurchaseWorkflowStore(ledgerPath);
    const key = 'order:rec_1:2026-07-11';
    expect(await store.hasReminder(key)).toBe(false);
    await store.recordReminder(key);
    expect(await store.hasReminder(key)).toBe(true);

    await store.recordReminders(
      Array.from(
        { length: 520 },
        (_, index) => `receipt:rec_${index}:2026-07-11`,
      ),
    );
    const payload = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      reminders: string[];
    };
    expect(payload.reminders.length).toBeLessThanOrEqual(500);
  });

  it('atomically claims only one approval per record under concurrent callbacks', async () => {
    const store = createV2Store(ledgerPath);
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.claimCardAction(
          {
            eventId: `event-${index}`,
            recordId: 'rec-concurrent',
            action: index % 2 === 0 ? 'approve' : 'reject',
            actorOpenId: `manager-${index}`,
            token: 'test-access-token-must-not-persist',
            rawBody: 'test-raw-body-must-not-persist',
          },
          new Date('2026-07-17T01:00:00.000Z'),
        ),
      ),
    );

    expect(claims.filter((result) => result.claimed)).toHaveLength(1);
    expect(new Set(claims.map((result) => result.entry.key))).toEqual(
      new Set(['approval:rec-concurrent']),
    );
    expect(claims.every((result) => result.entry.status === 'pending')).toBe(
      true,
    );
    const persisted = await readFile(ledgerPath, 'utf8');
    expect(persisted).not.toContain('test-access-token-must-not-persist');
    expect(persisted).not.toContain('test-raw-body-must-not-persist');
    expect(JSON.parse(persisted)).toMatchObject({
      version: 2,
      cardActions: [
        {
          key: 'approval:rec-concurrent',
          recordId: 'rec-concurrent',
          status: 'pending',
          attempts: 0,
        },
      ],
      notifications: [],
    });
  });

  it('allows only exact event replay and rejects conflicting event payloads', async () => {
    const store = createV2Store(ledgerPath);
    const first = await store.claimCardAction({
      eventId: 'event-replayed',
      recordId: 'rec-original',
      action: 'approve',
      actorOpenId: 'manager-one',
    });
    expect(first.claimed).toBe(true);
    await expect(
      store.claimCardAction({
        eventId: 'event-replayed',
        recordId: 'rec-original',
        action: 'approve',
        actorOpenId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      claimed: false,
      entry: {
        key: 'approval:rec-original',
        recordId: 'rec-original',
        actorOpenId: 'manager-one',
      },
    });
    for (const conflict of [
      {
        eventId: 'event-replayed',
        recordId: 'rec-forged',
        action: 'approve',
        actorOpenId: 'manager-one',
      },
      {
        eventId: 'event-replayed',
        recordId: 'rec-original',
        action: 'reject',
        actorOpenId: 'manager-one',
      },
      {
        eventId: 'event-replayed',
        recordId: 'rec-original',
        action: 'approve',
        actorOpenId: 'manager-two',
      },
    ]) {
      await expect(store.claimCardAction(conflict)).rejects.toBeInstanceOf(
        ConflictException,
      );
    }
    await expect(
      store.claimCardAction({
        eventId: 'event-other-manager',
        recordId: 'rec-original',
        action: 'reject',
        actorOpenId: 'manager-two',
      }),
    ).resolves.toMatchObject({ claimed: false });
    expect(
      (
        JSON.parse(await readFile(ledgerPath, 'utf8')) as {
          cardActions: unknown[];
        }
      ).cardActions,
    ).toHaveLength(1);
  });

  it('recovers a persisted action after restart without stealing a live lease', async () => {
    const claimedAt = new Date('2026-07-17T02:00:00.000Z');
    await createV2Store(ledgerPath).claimCardAction(
      {
        eventId: 'event-lease',
        recordId: 'rec-lease',
        action: 'approve',
        actorOpenId: 'manager-one',
      },
      claimedAt,
    );

    const firstLease = await createV2Store(ledgerPath).takeNextCardAction(
      new Date('2026-07-17T02:00:01.000Z'),
      10_000,
    );
    expect(firstLease).toMatchObject({
      key: 'approval:rec-lease',
      status: 'processing',
      attempts: 1,
      leaseUntil: '2026-07-17T02:00:11.000Z',
    });
    await expect(
      createV2Store(ledgerPath).takeNextCardAction(
        new Date('2026-07-17T02:00:10.999Z'),
        10_000,
      ),
    ).resolves.toBeNull();

    await expect(
      createV2Store(ledgerPath).takeNextCardAction(
        new Date('2026-07-17T02:00:11.000Z'),
        10_000,
      ),
    ).resolves.toMatchObject({
      key: 'approval:rec-lease',
      status: 'processing',
      attempts: 2,
      leaseUntil: '2026-07-17T02:00:21.000Z',
    });
  });

  it('reschedules with bounded sanitized errors and completes after retry', async () => {
    const store = createV2Store(ledgerPath);
    await store.claimCardAction(
      {
        eventId: 'event-retry',
        recordId: 'rec-retry',
        action: 'reject',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-17T03:00:00.000Z'),
    );
    const leased = await store.takeNextCardAction(
      new Date('2026-07-17T03:00:01.000Z'),
      10_000,
    );
    const longError = `Bearer secret-retry-token\n${'failure '.repeat(100)}`;
    const rescheduled = await store.rescheduleCardAction(
      leased?.key || '',
      leased?.claimToken || '',
      new Error(longError),
      new Date('2026-07-17T03:05:00.000Z'),
      new Date('2026-07-17T03:00:02.000Z'),
    );

    expect(rescheduled).toMatchObject({
      status: 'pending',
      attempts: 1,
      leaseUntil: '',
      nextAttemptAt: '2026-07-17T03:05:00.000Z',
    });
    expect(rescheduled?.lastError.length).toBeLessThanOrEqual(500);
    expect(rescheduled?.lastError).not.toContain('secret-retry-token');
    await expect(
      store.takeNextCardAction(new Date('2026-07-17T03:04:59.999Z')),
    ).resolves.toBeNull();
    const retry = await store.takeNextCardAction(
      new Date('2026-07-17T03:05:00.000Z'),
      10_000,
    );
    expect(retry?.attempts).toBe(2);

    await expect(
      store.completeCardAction(
        retry?.key || '',
        retry?.claimToken || '',
        new Date('2026-07-17T03:05:01.000Z'),
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      leaseUntil: '',
      completedAt: '2026-07-17T03:05:01.000Z',
      lastError: '',
    });
    await expect(store.takeNextCardAction()).resolves.toBeNull();
  });

  it('fences expired card-action workers and supports an explicit failed terminal state', async () => {
    const store = createV2Store(ledgerPath);
    await store.claimCardAction(
      {
        eventId: 'event-fence-action',
        recordId: 'rec-fence-action',
        action: 'approve',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-17T03:10:00.000Z'),
    );
    const workerA = await store.takeNextCardAction(
      new Date('2026-07-17T03:10:01.000Z'),
      10_000,
    );
    expect(workerA?.claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const workerB = await store.takeNextCardAction(
      new Date('2026-07-17T03:10:11.000Z'),
      10_000,
    );
    expect(workerB?.claimToken).not.toBe(workerA?.claimToken);

    await expect(
      store.completeCardAction(
        workerA?.key || '',
        workerA?.claimToken || '',
        new Date('2026-07-17T03:10:12.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.rescheduleCardAction(
        workerA?.key || '',
        workerA?.claimToken || '',
        new Error('stale worker'),
        new Date('2026-07-17T03:20:00.000Z'),
        new Date('2026-07-17T03:10:12.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.getCardAction(workerB?.key || ''),
    ).resolves.toMatchObject({
      status: 'processing',
      attempts: 2,
      claimToken: workerB?.claimToken,
    });
    await store.completeCardAction(
      workerB?.key || '',
      workerB?.claimToken || '',
      new Date('2026-07-17T03:10:13.000Z'),
    );

    await store.claimCardAction({
      eventId: 'event-fail-action',
      recordId: 'rec-fail-action',
      action: 'reject',
      actorOpenId: 'manager-one',
    });
    const failedLease = await store.takeNextCardAction();
    await expect(
      store.failCardAction(
        failedLease?.key || '',
        failedLease?.claimToken || '',
        new Error('Bearer failed-action-secret'),
        new Date('2026-07-17T03:30:00.000Z'),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      claimToken: '',
      leaseUntil: '',
      completedAt: '2026-07-17T03:30:00.000Z',
      lastError: 'Bearer [redacted]',
    });
  });

  it('migrates v1 on write and sanitizes corrupted bounded action history', async () => {
    const validActions = Array.from({ length: 520 }, (_, index) => ({
      key: `untrusted:${index}`,
      eventId: `event-${index}`,
      recordId: `rec_${index}`,
      action: index % 2 === 0 ? 'approve' : 'reject',
      actorOpenId: `manager-${index}`,
      status: 'completed',
      attempts: index === 519 ? -10 : 0,
      createdAt: 'not-a-date',
      updatedAt: '2026-07-17T04:00:00.000Z',
      nextAttemptAt: '2026-07-17T04:00:00.000Z',
      leaseUntil: '',
      completedAt: '2026-07-17T04:00:00.000Z',
      lastError: 'Bearer corrupt-secret-token',
      accessToken: 'corrupt-access-token',
      rawBody: 'corrupt-raw-body',
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 1,
        commands: [],
        reminders: ['legacy-reminder'],
        cardActions: [{ recordId: 'invalid-entry' }, ...validActions],
      }),
      'utf8',
    );
    const store = createV2Store(ledgerPath);

    const actions = await store.listCardActions();
    expect(actions).toHaveLength(500);
    expect(actions.at(-1)).toMatchObject({
      key: 'approval:rec_519',
      attempts: 0,
      createdAt: '',
      lastError: expect.not.stringContaining('corrupt-secret-token'),
    });
    await store.recordReminder('migration-write');
    const persisted = await readFile(ledgerPath, 'utf8');
    expect(JSON.parse(persisted)).toMatchObject({
      version: 2,
      reminders: ['legacy-reminder', 'migration-write'],
    });
    expect(persisted).not.toContain('corrupt-access-token');
    expect(persisted).not.toContain('corrupt-raw-body');
    expect(persisted).not.toContain('corrupt-secret-token');
  });

  it('deduplicates notifications per event, record and recipient', async () => {
    const store = createV2Store(ledgerPath);
    const now = new Date('2026-07-17T05:00:00.000Z');
    const results = await store.enqueueNotifications(
      [
        {
          businessEventId: 'approval-requested:rec-outbox',
          recordId: 'rec-outbox',
          recipientOpenId: 'manager-one',
          kind: 'approval_requested',
          cardBody: 'full-card-content-must-not-persist',
          token: 'outbox-access-token-must-not-persist',
          rawBody: 'outbox-raw-body-must-not-persist',
        },
        {
          businessEventId: 'approval-requested:rec-outbox',
          recordId: 'rec-outbox',
          recipientOpenId: 'manager-two',
          kind: 'approval_requested',
        },
      ],
      now,
    );
    const exactDuplicate = await store.enqueueNotification(
      {
        businessEventId: 'approval-requested:rec-outbox',
        recordId: 'rec-outbox',
        recipientOpenId: 'manager-one',
        kind: 'approval_requested',
      },
      now,
    );
    const differentRecord = await store.enqueueNotification(
      {
        businessEventId: 'approval-requested:rec-outbox',
        recordId: 'different-record-is-a-new-task',
        recipientOpenId: 'manager-one',
        kind: 'purchase_rejected',
      },
      now,
    );

    expect(results.map((result) => result.enqueued)).toEqual([true, true]);
    expect(exactDuplicate).toMatchObject({
      enqueued: false,
      entry: {
        key: 'approval-requested:rec-outbox:rec-outbox:manager-one',
        recordId: 'rec-outbox',
        kind: 'approval_requested',
      },
    });
    expect(differentRecord).toMatchObject({
      enqueued: true,
      entry: {
        key: 'approval-requested:rec-outbox:different-record-is-a-new-task:manager-one',
        recordId: 'different-record-is-a-new-task',
        kind: 'purchase_rejected',
      },
    });
    await expect(
      store.enqueueNotification({
        businessEventId: 'approval-requested:rec-outbox',
        recordId: 'rec-outbox',
        recipientOpenId: 'manager-one',
        kind: 'purchase_rejected',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.listNotifications({
        recordId: 'rec-outbox',
        kind: 'approval_requested',
      }),
    ).resolves.toHaveLength(2);
    await expect(store.listNotifications()).resolves.toHaveLength(3);
    const persisted = await readFile(ledgerPath, 'utf8');
    expect(persisted).not.toContain('full-card-content-must-not-persist');
    expect(persisted).not.toContain('outbox-access-token-must-not-persist');
    expect(persisted).not.toContain('outbox-raw-body-must-not-persist');
  });

  it('normalizes notification card context and rejects reusing a key with different context', async () => {
    const store = createV2Store(ledgerPath);
    const input = {
      businessEventId:
        'manual-inventory-inbound-completed-resolution:rec-manual-context',
      recordId: 'rec-manual-context',
      recipientOpenId: 'system',
      kind: 'manual_inventory_inbound_completed_resolution',
      cardContext:
        '  {"version":1,"movement":{"recordId":"rec-manual-context"}}\r\n',
    };

    const first = await store.enqueueNotification(input);
    const duplicate = await store.enqueueNotification({
      ...input,
      cardContext: '{"version":1,"movement":{"recordId":"rec-manual-context"}}',
    });

    expect(first.entry.cardContext).toBe(
      '{"version":1,"movement":{"recordId":"rec-manual-context"}}',
    );
    expect(duplicate).toMatchObject({
      enqueued: false,
      entry: { key: first.entry.key, cardContext: first.entry.cardContext },
    });
    await expect(
      store.enqueueNotification({
        ...input,
        cardContext:
          '{"version":1,"movement":{"recordId":"rec-manual-context","quantity":2}}',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('enriches a pending purchase inbound notification with the persisted movement snapshot', async () => {
    const store = createV2Store(ledgerPath);
    const input = {
      businessEventId: 'inventory-inbound-completed-resolution:rec-enrich',
      recordId: 'rec-enrich',
      recipientOpenId: 'system',
      kind: 'inventory_inbound_completed_resolution',
    } as const;
    const context = JSON.stringify({
      version: 1,
      sku: 'D1373',
      location: 'H-2F-226',
    });

    await store.enqueueNotification(input);
    const enriched = await store.enqueueNotification({
      ...input,
      cardContext: context,
    });

    expect(enriched).toMatchObject({
      enqueued: false,
      entry: { cardContext: context },
    });
    expect(
      (await store.listNotifications({ recordId: 'rec-enrich' }))[0],
    ).toMatchObject({
      cardContext: context,
    });
    await expect(
      store.enqueueNotification({
        ...input,
        cardContext: JSON.stringify({ version: 1, sku: 'D1374' }),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('atomically closes a manual inbound resolution and creates stable per-recipient card tasks', async () => {
    const store = createV2Store(ledgerPath);
    const cardContext =
      '{"version":1,"movement":{"recordId":"rec-manual-resolution","sku":"B1056"}}';
    const resolution = await store.enqueueNotification(
      {
        businessEventId:
          'manual-inventory-inbound-completed-resolution:rec-manual-resolution',
        recordId: 'rec-manual-resolution',
        recipientOpenId: 'system',
        kind: 'manual_inventory_inbound_completed_resolution',
        cardContext,
      },
      new Date('2026-08-26T01:00:00.000Z'),
    );
    const claimed = await store.takeNextNotification(
      new Date('2026-08-26T01:00:01.000Z'),
    );

    const completed =
      await store.completeInboundCompletedResolutionAndEnqueueNotifications(
        resolution.entry.key,
        claimed?.claimToken || '',
        [
          {
            businessEventId:
              'manual-inventory-inbound-completed:rec-manual-resolution',
            recordId: 'rec-manual-resolution',
            recipientOpenId: 'ou_responsible',
            kind: 'manual_inventory_inbound_completed',
            cardContext,
          },
        ],
        new Date('2026-08-26T01:00:02.000Z'),
      );

    expect(completed).toMatchObject({
      resolution: {
        kind: 'manual_inventory_inbound_completed_resolution',
        status: 'completed',
        cardContext,
      },
      notifications: [
        {
          kind: 'manual_inventory_inbound_completed',
          recipientOpenId: 'ou_responsible',
          status: 'pending',
          cardContext,
          deliveryUuid: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        },
      ],
    });
  });

  it('atomically completes one inbound-completed resolution and enqueues its derived notifications', async () => {
    const store = createV2Store(ledgerPath);
    const resolutionInput = {
      businessEventId:
        'inventory-inbound-completed-resolution:rec-resolution-atomic',
      recordId: 'rec-resolution-atomic',
      recipientOpenId: 'system',
      kind: 'inventory_inbound_completed_resolution',
    } as const;
    const enqueued = await store.enqueueNotification(
      resolutionInput as never,
      new Date('2026-08-25T01:00:00.000Z'),
    );
    const claimed = await store.takeNextNotification(
      new Date('2026-08-25T01:00:01.000Z'),
    );
    const derived = [
      {
        businessEventId: 'inventory-inbound-completed:rec-resolution-atomic',
        recordId: 'rec-resolution-atomic',
        recipientOpenId: 'ou_responsible',
        kind: 'inventory_inbound_completed' as const,
      },
      {
        businessEventId: 'purchase-completed:rec-resolution-atomic',
        recordId: 'rec-resolution-atomic',
        recipientOpenId: 'ou_requester',
        kind: 'purchase_completed' as const,
      },
    ];

    const completed =
      await store.completeInboundCompletedResolutionAndEnqueueNotifications(
        enqueued.entry.key,
        claimed?.claimToken || '',
        derived,
        new Date('2026-08-25T01:00:02.000Z'),
      );

    expect(completed).toMatchObject({
      resolution: {
        key: enqueued.entry.key,
        kind: 'inventory_inbound_completed_resolution',
        status: 'completed',
        claimToken: '',
        completedAt: '2026-08-25T01:00:02.000Z',
      },
      notifications: [
        {
          kind: 'inventory_inbound_completed',
          recipientOpenId: 'ou_responsible',
          status: 'pending',
        },
        {
          kind: 'purchase_completed',
          recipientOpenId: 'ou_requester',
          status: 'pending',
        },
      ],
    });
    await expect(store.listNotifications()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: enqueued.entry.key,
          status: 'completed',
        }),
        expect.objectContaining({
          recipientOpenId: 'ou_responsible',
          status: 'pending',
        }),
        expect.objectContaining({
          recipientOpenId: 'ou_requester',
          status: 'pending',
        }),
      ]),
    );
  });

  it('claims only notification kinds allowed by the caller without consuming older optional work', async () => {
    const store = createV2Store(ledgerPath);
    const queuedAt = new Date('2026-08-25T01:10:00.000Z');
    await store.enqueueNotification(
      {
        businessEventId: 'approval-requested:rec-optional',
        recordId: 'rec-optional',
        recipientOpenId: 'ou_manager',
        kind: 'approval_requested',
      },
      queuedAt,
    );
    await store.enqueueNotification(
      {
        businessEventId: 'inventory-inbound-completed-resolution:rec-mandatory',
        recordId: 'rec-mandatory',
        recipientOpenId: 'system',
        kind: 'inventory_inbound_completed_resolution',
      },
      queuedAt,
    );

    await expect(
      store.takeNextNotification(new Date('2026-08-25T01:10:01.000Z'), 30_000, [
        'inventory_inbound_completed_resolution',
        'inventory_inbound_completed',
        'purchase_completed',
      ]),
    ).resolves.toMatchObject({
      recordId: 'rec-mandatory',
      kind: 'inventory_inbound_completed_resolution',
      status: 'processing',
    });
    await expect(
      store.takeNextNotification(new Date('2026-08-25T01:10:01.000Z')),
    ).resolves.toMatchObject({
      recordId: 'rec-optional',
      kind: 'approval_requested',
      status: 'processing',
    });
  });

  it('persists one stable Feishu UUID for duplicate inbound-completed card tasks', async () => {
    const store = createV2Store(ledgerPath);
    const input = {
      businessEventId: 'inventory-inbound-completed:rec-inbound-completed',
      recordId: 'rec-inbound-completed',
      recipientOpenId: 'ou_inbound_responsible',
      kind: 'inventory_inbound_completed',
    };

    const first = await store.enqueueNotification(input);
    const duplicate = await store.enqueueNotification(input);

    expect(first.enqueued).toBe(true);
    expect(first.entry.deliveryUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(duplicate).toMatchObject({
      enqueued: false,
      entry: {
        key: first.entry.key,
        deliveryUuid: first.entry.deliveryUuid,
      },
    });
  });

  it('does not reopen a successful completion even when its message ID matches the old reminder', async () => {
    const store = createV2Store(ledgerPath);
    const at = (second: number) =>
      new Date(`2026-09-24T04:00:${String(second).padStart(2, '0')}.000Z`);
    await store.enqueueNotification(
      {
        businessEventId: 'warehouse-inbound:rec-legacy-card',
        recordId: 'rec-legacy-card',
        recipientOpenId: 'ou_manager',
        kind: 'warehouse_inbound',
      },
      at(0),
    );
    const reminder = await store.takeNextNotification(at(1));
    await store.completeNotification(
      reminder!.key,
      reminder!.claimToken,
      { messageId: 'om_original_reminder' },
      at(2),
    );
    const queued = await store.enqueueNotification(
      {
        businessEventId: 'inventory-inbound-completed:rec-legacy-card',
        recordId: 'rec-legacy-card',
        recipientOpenId: 'ou_manager',
        kind: 'inventory_inbound_completed',
      },
      at(3),
    );
    // Synthetic accepted resolution proves the original recipient before a send can start.
    const resolver = await store.enqueueNotification({
      businessEventId: 'inventory-inbound-completed-resolution:rec-legacy-card',
      recordId: 'rec-legacy-card', recipientOpenId: 'system', kind: 'inventory_inbound_completed_resolution',
    }, at(3));
    const resolverClaim = await store.takeNextNotification(at(3), undefined, ['inventory_inbound_completed_resolution']);
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(resolver.entry.key, resolverClaim!.claimToken, [{
      businessEventId: 'inventory-inbound-completed:rec-legacy-card', recordId: 'rec-legacy-card', recipientOpenId: 'ou_manager', kind: 'inventory_inbound_completed',
    }], at(3));
    const oldCompletion = await store.takeNextNotification(at(4));
    await store.completeNotification(
      oldCompletion!.key,
      oldCompletion!.claimToken,
      { messageId: 'om_original_reminder' },
      at(5),
    );

    await expect(store.takeNextNotification(at(6))).resolves.toBeNull();
    expect(await store.getNotification(queued.entry.key)).toMatchObject({
      status: 'completed', messageId: 'om_original_reminder', deliveryUuid: queued.entry.deliveryUuid,
    });
  });

  it('anchors inbound-completed delivery only when the Feishu send starts and stops blind retries after one hour', async () => {
    const firstClaimAt = new Date('2026-08-24T01:00:01.000Z');
    const store = createV2Store(ledgerPath);
    const enqueued = await store.enqueueNotification(
      {
        businessEventId: 'inventory-inbound-completed:rec-unknown-delivery',
        recordId: 'rec-unknown-delivery',
        recipientOpenId: 'ou_inbound_responsible',
        kind: 'inventory_inbound_completed',
      },
      new Date('2026-08-24T01:00:00.000Z'),
    );

    // Synthetic accepted resolution proves the original recipient before a send can start.
    const resolver = await store.enqueueNotification({
      businessEventId: 'inventory-inbound-completed-resolution:rec-unknown-delivery',
      recordId: 'rec-unknown-delivery', recipientOpenId: 'system', kind: 'inventory_inbound_completed_resolution',
    }, new Date('2026-08-24T01:00:00.000Z'));
    const resolverClaim = await store.takeNextNotification(new Date('2026-08-24T01:00:00.000Z'), undefined, ['inventory_inbound_completed_resolution']);
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(resolver.entry.key, resolverClaim!.claimToken, [{
      businessEventId: 'inventory-inbound-completed:rec-unknown-delivery', recordId: 'rec-unknown-delivery', recipientOpenId: 'ou_inbound_responsible', kind: 'inventory_inbound_completed',
    }], new Date('2026-08-24T01:00:00.000Z'));
    const first = await store.takeNextNotification(firstClaimAt, 1_000);

    expect(first).toMatchObject({
      status: 'processing',
      attempts: 1,
      deliveryUuid: enqueued.entry.deliveryUuid,
      firstSendAttemptAt: '',
      sendOutcome: 'unattempted',
    });
    await expect(
      createV2Store(ledgerPath).getNotification(enqueued.entry.key),
    ).resolves.toMatchObject({
      firstSendAttemptAt: '',
      sendOutcome: 'unattempted',
      deliveryUuid: enqueued.entry.deliveryUuid,
    });

    const sendStartedAt = new Date('2026-08-24T01:00:01.100Z');
    await expect(
      store.markInboundCompletedSendStarted(
        first!.key,
        first!.claimToken,
        sendStartedAt,
      ),
    ).resolves.toMatchObject({
      firstSendAttemptAt: sendStartedAt.toISOString(),
      sendOutcome: 'unknown',
    });
    await expect(
      createV2Store(ledgerPath).takeNextNotification(
        new Date('2026-08-24T01:00:01.999Z'),
      ),
    ).resolves.toBeNull();

    const retry = await createV2Store(ledgerPath).takeNextNotification(
      new Date('2026-08-24T01:30:00.000Z'),
      1_000,
    );
    expect(retry).toMatchObject({
      status: 'processing',
      attempts: 2,
      deliveryUuid: enqueued.entry.deliveryUuid,
      firstSendAttemptAt: sendStartedAt.toISOString(),
      sendOutcome: 'unknown',
    });

    await expect(
      createV2Store(ledgerPath).takeNextNotification(
        new Date('2026-08-24T02:00:01.101Z'),
      ),
    ).resolves.toBeNull();
    await expect(
      createV2Store(ledgerPath).getNotification(enqueued.entry.key),
    ).resolves.toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
      claimToken: '',
      leaseUntil: '',
      deliveryUuid: enqueued.entry.deliveryUuid,
      lastError: expect.stringContaining('停止自动重发'),
    });
    await expect(
      createV2Store(ledgerPath).takeNextNotification(
        new Date('2026-08-24T03:00:00.000Z'),
      ),
    ).resolves.toBeNull();
  });

  it('retains all inbound-completed manual reconciliation evidence without trimming manager reconciliation', async () => {
    const timestamp = '2026-08-24T02:00:01.000Z';
    const inboundManualEntries = Array.from({ length: 500 }, (_, index) => {
      const deliveryUuid = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      return {
        key: `ignored-inbound-manual-${index}`,
        businessEventId: `inbound-manual-reconciliation:${index}`,
        recordId: `rec_inbound_manual_${index}`,
        recipientOpenId: `ou_responsible_${index}`,
        kind:
          index % 2 === 0
            ? ('inventory_inbound_completed' as const)
            : ('manual_inventory_inbound_completed' as const),
        status: 'manual_reconciliation' as const,
        attempts: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        completedAt: timestamp,
        lastError: `inbound delivery ${index} requires reconciliation`,
        deliveryId: '',
        messageId: '',
        deliveryUuid,
        firstSendAttemptAt: '2026-08-24T01:00:00.000Z',
        sendOutcome: 'manual_reconciliation' as const,
        deliveryGeneration: 1,
        cardContext: JSON.stringify({
          version: 1,
          index,
          detail: 'x'.repeat(7_900),
        }),
        deliveryAudit: [
          {
            action: 'send_started',
            at: '2026-08-24T01:00:00.000Z',
            operatorOpenId: '',
            generation: 1,
            deliveryUuid,
            messageId: '',
          },
        ],
      } satisfies NotificationEntry;
    });
    const managerManualEntry: NotificationEntry = {
      ...inboundManualEntries[0]!,
      key: 'ignored-manager-manual',
      businessEventId: 'manager_approval_requested:manager_manual_retain',
      recordId: 'manager_manual_retain',
      recipientOpenId: 'ou_manager_manual_retain',
      kind: 'manager_approval_requested',
      deliveryUuid: '00000000-0000-4000-8000-999999999999',
      cardContext: managerCardContext('manager_manual_retain'),
    };
    const expiringDeliveryUuid = '00000000-0000-4000-8000-000000000500';
    const expiringInboundEntry: NotificationEntry = {
      ...inboundManualEntries[0]!,
      key: 'ignored-expiring-inbound',
      businessEventId:
        'manual-inventory-inbound-completed:rec_inbound_manual_500',
      recordId: 'rec_inbound_manual_500',
      recipientOpenId: 'ou_responsible_500',
      kind: 'manual_inventory_inbound_completed',
      status: 'pending',
      attempts: 1,
      completedAt: '',
      lastError: 'temporary network failure',
      deliveryUuid: expiringDeliveryUuid,
      sendOutcome: 'unknown',
      cardContext: JSON.stringify({
        version: 1,
        index: 500,
        detail: 'x'.repeat(7_900),
      }),
      deliveryAudit: [
        {
          action: 'send_started',
          at: '2026-08-24T01:00:00.000Z',
          operatorOpenId: '',
          generation: 1,
          deliveryUuid: expiringDeliveryUuid,
          messageId: '',
        },
      ],
    };
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 2,
        commands: [],
        reminders: [],
        cardActions: [],
        notifications: [
          expiringInboundEntry,
          ...inboundManualEntries,
          managerManualEntry,
        ],
        managerApprovalActions: [],
        managerApprovalCards: [],
      }),
      'utf8',
    );
    const store = createV2Store(ledgerPath);

    await expect(
      store.takeNextNotification(new Date(timestamp)),
    ).resolves.toBeNull();

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      notifications: NotificationEntry[];
    };
    const retainedInbound = persisted.notifications.filter(
      (entry) =>
        entry.status === 'manual_reconciliation' &&
        (entry.kind === 'inventory_inbound_completed' ||
          entry.kind === 'manual_inventory_inbound_completed'),
    );
    expect(retainedInbound).toHaveLength(501);
    expect(
      retainedInbound.some(
        (entry) => entry.recordId === 'rec_inbound_manual_0',
      ),
    ).toBe(true);
    expect(retainedInbound.find(entry => entry.recordId === 'rec_inbound_manual_500')).toMatchObject({
      recordId: 'rec_inbound_manual_500',
      deliveryUuid: '00000000-0000-4000-8000-000000000500',
      lastError: expect.stringContaining('已停止自动推送'),
      cardContext: expiringInboundEntry.cardContext,
      deliveryAudit: [
        expect.objectContaining({
          action: 'send_started',
          deliveryUuid: '00000000-0000-4000-8000-000000000500',
        }),
      ],
    });
    expect(
      persisted.notifications.find(
        (entry) => entry.recordId === 'manager_manual_retain',
      ),
    ).toMatchObject({
      kind: 'manager_approval_requested',
      status: 'manual_reconciliation',
    });
  });

  it('recovers notification leases across restarts and persists delivery metadata', async () => {
    const store = createV2Store(ledgerPath);
    const enqueued = await store.enqueueNotification(
      {
        businessEventId: 'purchase-assigned:rec-delivery',
        recordId: 'rec-delivery',
        recipientOpenId: 'purchaser-one',
        kind: 'purchase_assigned',
      },
      new Date('2026-07-17T06:00:00.000Z'),
    );
    const first = await createV2Store(ledgerPath).takeNextNotification(
      new Date('2026-07-17T06:00:01.000Z'),
      10_000,
    );
    expect(first).toMatchObject({ status: 'processing', attempts: 1 });
    await expect(
      createV2Store(ledgerPath).takeNextNotification(
        new Date('2026-07-17T06:00:10.999Z'),
      ),
    ).resolves.toBeNull();
    const recovered = await createV2Store(ledgerPath).takeNextNotification(
      new Date('2026-07-17T06:00:11.000Z'),
      10_000,
    );
    expect(recovered).toMatchObject({ status: 'processing', attempts: 2 });
    await createV2Store(ledgerPath).rescheduleNotification(
      recovered?.key || '',
      recovered?.claimToken || '',
      new Error('token=notification-secret-token'),
      new Date('2026-07-17T06:05:00.000Z'),
      new Date('2026-07-17T06:00:12.000Z'),
    );
    await expect(
      createV2Store(ledgerPath).takeNextNotification(
        new Date('2026-07-17T06:04:59.999Z'),
      ),
    ).resolves.toBeNull();
    const retry = await createV2Store(ledgerPath).takeNextNotification(
      new Date('2026-07-17T06:05:00.000Z'),
      10_000,
    );
    expect(retry).toMatchObject({ attempts: 3, lastError: 'token=[redacted]' });

    await createV2Store(ledgerPath).completeNotification(
      enqueued.entry.key,
      retry?.claimToken || '',
      { deliveryId: 'delivery-safe-01', messageId: 'message-safe-01' },
      new Date('2026-07-17T06:05:01.000Z'),
    );
    await expect(
      createV2Store(ledgerPath).getNotification(enqueued.entry.key),
    ).resolves.toMatchObject({
      status: 'completed',
      attempts: 3,
      completedAt: '2026-07-17T06:05:01.000Z',
      leaseUntil: '',
      lastError: '',
      deliveryId: 'delivery-safe-01',
      messageId: 'message-safe-01',
    });
  });

  it('fences expired notification workers and supports an explicit failed terminal state', async () => {
    const store = createV2Store(ledgerPath);
    await store.enqueueNotification(
      {
        businessEventId: 'notification-fence-event',
        recordId: 'rec-notification-fence',
        recipientOpenId: 'recipient-fence',
        kind: 'warehouse_inbound',
      },
      new Date('2026-07-17T06:10:00.000Z'),
    );
    const workerA = await store.takeNextNotification(
      new Date('2026-07-17T06:10:01.000Z'),
      10_000,
    );
    const workerB = await store.takeNextNotification(
      new Date('2026-07-17T06:10:11.000Z'),
      10_000,
    );
    expect(workerA?.claimToken).toBeTruthy();
    expect(workerB?.claimToken).not.toBe(workerA?.claimToken);

    await expect(
      store.rescheduleNotification(
        workerA?.key || '',
        workerA?.claimToken || '',
        new Error('stale notification worker'),
        new Date('2026-07-17T06:20:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.completeNotification(workerA?.key || '', workerA?.claimToken || ''),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.getNotification(workerB?.key || ''),
    ).resolves.toMatchObject({
      status: 'processing',
      attempts: 2,
      claimToken: workerB?.claimToken,
    });
    await expect(
      store.failNotification(
        workerB?.key || '',
        workerB?.claimToken || '',
        new Error('Basic bm90aWZpY2F0aW9uLXNlY3JldA=='),
        new Date('2026-07-17T06:10:12.000Z'),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      claimToken: '',
      leaseUntil: '',
      lastError: 'Basic [redacted]',
    });
  });

  it('sanitizes notification history and bounds ordinary history while retaining legacy completion receipts', async () => {
    const notifications = Array.from({ length: 1040 }, (_, index) => ({
      key: `untrusted:${index}`,
      businessEventId: `completed:rec_${index}`,
      recordId: `rec_${index}`,
      recipientOpenId: `recipient-${index}`,
      kind: index % 2 === 0 ? 'purchase_completed' : 'warehouse_inbound',
      status: 'completed',
      attempts: index === 519 ? -1 : 1,
      createdAt: '2026-07-17T07:00:00.000Z',
      updatedAt: '2026-07-17T07:00:00.000Z',
      nextAttemptAt: '2026-07-17T07:00:00.000Z',
      leaseUntil: '',
      completedAt: '2026-07-17T07:00:00.000Z',
      lastError: 'Bearer notification-history-secret',
      deliveryId: `delivery-${index}`,
      messageId: `message-${index}`,
      cardBody: 'history-full-card-content',
      encryptKey: 'history-encrypt-key',
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 2,
        commands: [],
        reminders: [],
        cardActions: [],
        notifications: [{ kind: 'invalid' }, ...notifications],
      }),
      'utf8',
    );
    const store = createV2Store(ledgerPath);

    expect(await store.listNotifications()).toHaveLength(1020);
    expect(await store.listNotifications({ kind: 'purchase_completed' })).toHaveLength(520);
    expect(await store.listNotifications({ kind: 'warehouse_inbound' })).toHaveLength(500);
    await expect(
      store.listNotifications({
        recordId: 'rec_518',
        kind: 'purchase_completed',
        status: 'completed',
      }),
    ).resolves.toHaveLength(1);
    await store.recordReminder('sanitize-notifications');
    const persisted = await readFile(ledgerPath, 'utf8');
    expect(persisted).not.toContain('history-full-card-content');
    expect(persisted).not.toContain('history-encrypt-key');
    expect(persisted).not.toContain('notification-history-secret');
    expect(JSON.parse(persisted)).toMatchObject({ version: 2 });
  });

  it('retains a completed inbound-resolution marker beyond terminal notification trimming', async () => {
    const completedAt = '2026-08-25T02:00:00.000Z';
    const resolution: NotificationEntry = {
      key: 'inventory-inbound-completed-resolution:rec-resolution-retained:rec-resolution-retained:system',
      businessEventId:
        'inventory-inbound-completed-resolution:rec-resolution-retained',
      recordId: 'rec-resolution-retained',
      recipientOpenId: 'system',
      kind: 'inventory_inbound_completed_resolution',
      status: 'completed',
      attempts: 1,
      createdAt: completedAt,
      updatedAt: completedAt,
      nextAttemptAt: completedAt,
      leaseUntil: '',
      claimToken: '',
      completedAt,
      lastError: '',
      deliveryId: '',
      messageId: '',
      deliveryUuid: '',
      firstSendAttemptAt: '',
      sendOutcome: 'unattempted',
      deliveryGeneration: 1,
      cardContext: '',
      deliveryAudit: [],
    };
    const noise = Array.from({ length: 510 }, (_, index) => ({
      ...resolution,
      key: `terminal-noise:${index}`,
      businessEventId: `terminal-noise:${index}`,
      recordId: `terminal_noise_${index}`,
      recipientOpenId: `ou_noise_${index}`,
      kind: 'purchase_completed' as const,
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 2,
        commands: [],
        reminders: [],
        cardActions: [],
        notifications: [resolution, ...noise],
        managerApprovalActions: [],
        managerApprovalCards: [],
      }),
      'utf8',
    );

    const restarted = createV2Store(ledgerPath);

    await expect(
      restarted.listNotifications({
        recordId: resolution.recordId,
        kind: 'inventory_inbound_completed_resolution',
        status: 'completed',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        key: resolution.key,
        status: 'completed',
      }),
    ]);
    await expect(
      restarted.enqueueNotification({
        businessEventId: resolution.businessEventId,
        recordId: resolution.recordId,
        recipientOpenId: resolution.recipientOpenId,
        kind: resolution.kind,
      } as never),
    ).resolves.toMatchObject({
      enqueued: false,
      entry: { key: resolution.key, status: 'completed' },
    });
  });

  it('retains completed inbound-resolution markers permanently beyond five thousand events', async () => {
    const completedAt = '2026-08-25T02:10:00.000Z';
    const markers = Array.from({ length: 5_001 }, (_, index) => ({
      key: `inventory-inbound-completed-resolution:rec-resolution-${index}:rec-resolution-${index}:system`,
      businessEventId: `inventory-inbound-completed-resolution:rec-resolution-${index}`,
      recordId: `rec-resolution-${index}`,
      recipientOpenId: 'system',
      kind: 'inventory_inbound_completed_resolution' as const,
      status: 'completed' as const,
      attempts: 1,
      createdAt: completedAt,
      updatedAt: completedAt,
      nextAttemptAt: completedAt,
      leaseUntil: '',
      claimToken: '',
      completedAt,
      lastError: '',
      deliveryId: '',
      messageId: '',
      deliveryUuid: '',
      firstSendAttemptAt: '',
      sendOutcome: 'unattempted' as const,
      deliveryGeneration: 1,
      cardContext: '',
      deliveryAudit: [],
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 2,
        commands: [],
        reminders: [],
        cardActions: [],
        notifications: markers,
        managerApprovalActions: [],
        managerApprovalCards: [],
      }),
      'utf8',
    );

    const restarted = createV2Store(ledgerPath);
    await restarted.enqueueNotification({
      businessEventId: 'purchase-completed:rec-trim-trigger',
      recordId: 'rec-trim-trigger',
      recipientOpenId: 'ou_trim_trigger',
      kind: 'purchase_completed',
    });

    await expect(
      restarted.listNotifications({ recordId: 'rec-resolution-0' }),
    ).resolves.toHaveLength(1);
    await expect(
      restarted.listNotifications({ recordId: 'rec-resolution-5000' }),
    ).resolves.toHaveLength(1);
  });

  it('never evicts active card actions and rejects the 501st active claim', async () => {
    const active = Array.from({ length: 500 }, (_, index) => ({
      key: `approval:active_${index}`,
      eventId: `active-event-${index}`,
      recordId: `active_${index}`,
      action: 'approve',
      actorOpenId: 'manager-capacity',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-07-17T08:00:00.000Z',
      updatedAt: '2026-07-17T08:00:00.000Z',
      nextAttemptAt: '2026-07-17T08:00:00.000Z',
      leaseUntil: '',
      completedAt: '',
      lastError: '',
    }));
    const terminal = Array.from({ length: 520 }, (_, index) => ({
      ...active[0],
      key: `approval:done_${index}`,
      eventId: `done-event-${index}`,
      recordId: `done_${index}`,
      status: 'completed',
      completedAt: '2026-07-17T08:01:00.000Z',
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 2,
        commands: [],
        reminders: [],
        cardActions: [...active, ...terminal],
        notifications: [],
      }),
      'utf8',
    );
    const store = createV2Store(ledgerPath);

    const migrated = await store.listCardActions();
    expect(migrated.filter((entry) => entry.status === 'pending')).toHaveLength(
      500,
    );
    expect(
      migrated.filter((entry) => entry.status === 'completed'),
    ).toHaveLength(500);
    await expect(
      store.claimCardAction({
        eventId: 'active-event-new',
        recordId: 'active_new',
        action: 'reject',
        actorOpenId: 'manager-capacity',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      store.claimCardAction({
        eventId: 'active-event-0',
        recordId: 'active_0',
        action: 'approve',
        actorOpenId: 'manager-capacity',
      }),
    ).resolves.toMatchObject({ claimed: false });
  });

  it('never evicts active notifications and rejects the 501st active task', async () => {
    const active = Array.from({ length: 500 }, (_, index) => ({
      key: `ignored-active-${index}`,
      businessEventId: `active-notification-${index}`,
      recordId: `active_${index}`,
      recipientOpenId: 'recipient-capacity',
      kind: 'approval_requested',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-07-17T09:00:00.000Z',
      updatedAt: '2026-07-17T09:00:00.000Z',
      nextAttemptAt: '2026-07-17T09:00:00.000Z',
      leaseUntil: '',
      completedAt: '',
      lastError: '',
      deliveryId: '',
      messageId: '',
    }));
    const terminal = Array.from({ length: 520 }, (_, index) => ({
      ...active[0],
      key: `ignored-terminal-${index}`,
      businessEventId: `done-notification-${index}`,
      recordId: `done_${index}`,
      status: 'failed',
      completedAt: '2026-07-17T09:01:00.000Z',
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 2,
        commands: [],
        reminders: [],
        cardActions: [],
        notifications: [...active, ...terminal],
      }),
      'utf8',
    );
    const store = createV2Store(ledgerPath);

    const migrated = await store.listNotifications();
    expect(migrated.filter((entry) => entry.status === 'pending')).toHaveLength(
      500,
    );
    expect(migrated.filter((entry) => entry.status === 'failed')).toHaveLength(
      500,
    );
    await expect(
      store.enqueueNotification({
        businessEventId: 'active-notification-new',
        recordId: 'active_new',
        recipientOpenId: 'recipient-capacity',
        kind: 'approval_requested',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      store.enqueueNotification({
        businessEventId: 'active-notification-0',
        recordId: 'active_0',
        recipientOpenId: 'recipient-capacity',
        kind: 'approval_requested',
      }),
    ).resolves.toMatchObject({ enqueued: false });
  });

  it('serializes 32 store instances sharing one ledger path without lost writes', async () => {
    const stores = Array.from({ length: 32 }, () => createV2Store(ledgerPath));
    let verifier: StoreV2 | undefined;
    try {
      const settled = await Promise.allSettled(
        stores.map((store, index) =>
          store.claimCardAction({
            eventId: `shared-event-${index}`,
            recordId: `shared_${index}`,
            action: index % 2 === 0 ? 'approve' : 'reject',
            actorOpenId: `manager-${index}`,
          }),
        ),
      );

      expect(settled.map((result) => result.status)).toEqual(
        Array.from({ length: 32 }, () => 'fulfilled'),
      );
      verifier = createV2Store(ledgerPath);
      await expect(verifier.listCardActions()).resolves.toHaveLength(32);
      const files = await readdir(directory);
      expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(files).toContain('ledger.json.lock');
    } finally {
      await Promise.all(
        [...stores, ...(verifier ? [verifier] : [])].map((store) =>
          store.onModuleDestroy(),
        ),
      );
    }
    await expect(readFile(`${ledgerPath}.lock`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 30_000);

  it('fails fast on a live external lock and recovers one stale lock', async () => {
    const lockPath = `${ledgerPath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, instanceId: 'external-process' }),
      'utf8',
    );
    const blocked = createV2Store(ledgerPath);
    await expect(blocked.listCardActions()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await blocked.onModuleDestroy();

    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, instanceId: 'stale-process' }),
      'utf8',
    );
    const recovered = createV2Store(ledgerPath);
    await expect(
      recovered.claimCardAction({
        eventId: 'stale-lock-event',
        recordId: 'stale_lock_record',
        action: 'approve',
        actorOpenId: 'manager-stale-lock',
      }),
    ).resolves.toMatchObject({ claimed: true });
    await recovered.onModuleDestroy();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retries acquisition after the external lock owner exits', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const owner = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    const ownerExit = new Promise<void>((resolveExit, rejectExit) => {
      owner.once('error', rejectExit);
      owner.once('exit', () => resolveExit());
    });
    const ownerPid = owner.pid;
    if (!ownerPid) throw new Error('Failed to start external lock owner');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: ownerPid, instanceId: 'departing-process' }),
      'utf8',
    );
    const store = createV2Store(ledgerPath);

    try {
      await expect(store.listCardActions()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      owner.kill();
      await ownerExit;

      await expect(store.listCardActions()).resolves.toEqual([]);
    } finally {
      owner.kill();
      await store.onModuleDestroy();
    }
  });

  it('allows only one process to recover the same stale lock', async () => {
    const stalePid = 2_147_483_647;
    const lockPath = `${ledgerPath}.lock`;
    const pauseMarker = join(directory, 'stale-inspected');
    const releaseMarker = join(directory, 'release-recovery');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: stalePid, instanceId: 'shared-stale-owner' }),
      'utf8',
    );
    const delayed = startStoreWorker(ledgerPath, {
      stalePid,
      pauseMarker,
      releaseMarker,
    });
    let winner: ReturnType<typeof startStoreWorker> | undefined;

    try {
      await delayed.ready;
      delayed.start();
      await waitForFile(pauseMarker);

      winner = startStoreWorker(ledgerPath);
      await winner.ready;
      winner.start();
      await expect(winner.result).resolves.toEqual({ type: 'acquired' });

      await writeFile(releaseMarker, 'release', 'utf8');
      const results = [await winner.result, await delayed.result];
      expect(
        results.filter((result) => result.type === 'acquired'),
      ).toHaveLength(1);
    } finally {
      await writeFile(releaseMarker, 'release', 'utf8');
      await Promise.all([
        stopChild(delayed.child),
        ...(winner ? [stopChild(winner.child)] : []),
      ]);
    }
  }, 15_000);

  it('retries startup while a live external lock is shutting down', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const owner = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    const ownerExit = new Promise<void>((resolveExit, rejectExit) => {
      owner.once('error', rejectExit);
      owner.once('exit', () => resolveExit());
    });
    const ownerPid = owner.pid;
    if (!ownerPid) throw new Error('Failed to start external lock owner');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: ownerPid, instanceId: 'shutting-down-process' }),
      'utf8',
    );
    const store = createV2Store(ledgerPath);
    const stopOwner = setTimeout(() => owner.kill(), 150);

    try {
      await expect(store.onModuleInit()).resolves.toBeUndefined();
      await ownerExit;
    } finally {
      clearTimeout(stopOwner);
      owner.kill();
      await store.onModuleDestroy();
    }
  });

  it('does not retry or swallow non-lock startup errors', async () => {
    const blockedDirectory = join(directory, 'ledger-parent');
    await writeFile(blockedDirectory, 'not a directory', 'utf8');
    const store = createV2Store(join(blockedDirectory, 'ledger.json'));
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      await expect(store.onModuleInit()).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      await store.onModuleDestroy();
    }
  });

  it('merges exact migrated duplicates and fails closed on identity conflicts', async () => {
    const action = {
      key: 'untrusted-action-key',
      eventId: 'migration-event',
      recordId: 'migration_record',
      action: 'approve',
      actorOpenId: 'migration-manager',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T10:00:00.000Z',
      nextAttemptAt: '2026-07-17T10:00:00.000Z',
      leaseUntil: '',
      claimToken: '',
      completedAt: '',
      lastError: '',
    };
    const notification = {
      key: 'untrusted-notification-key',
      businessEventId: 'migration-notification',
      recordId: 'migration_record',
      recipientOpenId: 'migration-recipient',
      kind: 'approval_requested',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T10:00:00.000Z',
      nextAttemptAt: '2026-07-17T10:00:00.000Z',
      leaseUntil: '',
      claimToken: '',
      completedAt: '',
      lastError: '',
      deliveryId: '',
      messageId: '',
    };
    const writeLedger = (cardActions: unknown[], notifications: unknown[]) =>
      writeFile(
        ledgerPath,
        JSON.stringify({
          version: 2,
          commands: [],
          reminders: [],
          cardActions,
          notifications,
        }),
        'utf8',
      );
    const store = createV2Store(ledgerPath);

    await writeLedger(
      [action, { ...action }],
      [notification, { ...notification }],
    );
    await expect(store.listCardActions()).resolves.toHaveLength(1);
    await expect(store.listNotifications()).resolves.toHaveLength(1);

    await writeLedger(
      [action, { ...action, eventId: 'migration-other-event' }],
      [],
    );
    await expect(store.listCardActions()).rejects.toBeInstanceOf(
      ConflictException,
    );

    await writeLedger(
      [
        action,
        {
          ...action,
          key: 'approval:migration_other_record',
          recordId: 'migration_other_record',
        },
      ],
      [],
    );
    await expect(store.listCardActions()).rejects.toBeInstanceOf(
      ConflictException,
    );

    await writeLedger(
      [],
      [notification, { ...notification, kind: 'purchase_rejected' }],
    );
    await expect(store.listNotifications()).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('redacts every supported secret shape from persisted warnings', async () => {
    const store = createV2Store(ledgerPath);
    const secrets = [
      'bearer-value',
      'YmFzaWMtdmFsdWU=',
      'json-access',
      'json-tenant',
      'json-verification',
      'json-encrypt',
      'json-app-secret',
      'json-password',
      'json-secret',
      'kv-access',
      'kv-tenant',
      'kv-verification',
      'kv-encrypt',
      'kv-app-secret',
      'kv-password',
      'kv-secret',
    ];
    await store.recordCommand({
      key: 'warning-redaction',
      recordId: 'warning_record',
      action: 'approve',
      actorOpenId: 'warning-manager',
      accessRole: 'admin',
      authenticationMode: 'delegated-app',
      completedAt: '2026-07-17T11:00:00.000Z',
      notificationWarnings: [
        'Bearer bearer-value',
        'Basic YmFzaWMtdmFsdWU=',
        '{"access_token":"json-access","tenant_access_token":"json-tenant","verification_token":"json-verification","encrypt_key":"json-encrypt","app_secret":"json-app-secret","password":"json-password","secret":"json-secret"}',
        'access_token=kv-access tenant_access_token:kv-tenant verification_token = kv-verification encrypt_key=kv-encrypt app_secret:kv-app-secret password=kv-password secret=kv-secret',
        `password=${'x'.repeat(800)}`,
      ],
    });

    const command = await store.findCommand('warning-redaction');
    expect(command?.notificationWarnings).toHaveLength(5);
    expect(
      command?.notificationWarnings.every((warning) => warning.length <= 500),
    ).toBe(true);
    const persisted = await readFile(ledgerPath, 'utf8');
    for (const secret of secrets) expect(persisted).not.toContain(secret);
    expect(persisted).toContain('[redacted]');
  });

  it.each([
    ['empty', ''],
    ['partial JSON', '{"pid":'],
  ])('recovers an old %s lock through quarantine', async (_label, content) => {
    const lockPath = `${ledgerPath}.lock`;
    await writeFile(lockPath, content, 'utf8');
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const store = createV2Store(ledgerPath);
    try {
      await expect(store.listCardActions()).resolves.toEqual([]);
    } finally {
      await store.onModuleDestroy();
    }

    expect(
      (await readdir(directory)).filter((name) => name.includes('.stale.')),
    ).toEqual([]);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a fresh empty lock without deleting or quarantining it', async () => {
    const lockPath = `${ledgerPath}.lock`;
    await writeFile(lockPath, '', 'utf8');
    const store = createV2Store(ledgerPath);
    try {
      await expect(store.listCardActions()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(readFile(lockPath, 'utf8')).resolves.toBe('');
      expect(
        (await readdir(directory)).filter((name) => name.includes('.stale.')),
      ).toEqual([]);
    } finally {
      await store.onModuleDestroy();
    }
  });

  it('rereads an initially empty lock and honors a live owner written shortly after', async () => {
    const lockPath = `${ledgerPath}.lock`;
    await writeFile(lockPath, '', 'utf8');
    const store = createV2Store(ledgerPath);
    const outcome = store.listCardActions().then(
      () => 'resolved' as const,
      (error: unknown) => {
        if (!(error instanceof ServiceUnavailableException)) throw error;
        return 'rejected' as const;
      },
    );
    const writer = new Promise<'writer'>((resolveWriter, rejectWriter) => {
      setTimeout(() => {
        void writeFile(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            instanceId: 'delayed-live-owner',
          }),
          'utf8',
        ).then(() => resolveWriter('writer'), rejectWriter);
      }, 25);
    });

    try {
      expect(await Promise.race([outcome, writer])).toBe('writer');
      await expect(outcome).resolves.toBe('rejected');
      await expect(readFile(lockPath, 'utf8')).resolves.toContain(
        'delayed-live-owner',
      );
      expect(
        (await readdir(directory)).filter((name) => name.includes('.stale.')),
      ).toEqual([]);
    } finally {
      await writer;
      await store.onModuleDestroy();
    }
  });

  it('atomically isolates legacy and manager notification queues with stable UUIDs', async () => {
    const store = createV2Store(ledgerPath);
    const now = new Date('2026-07-31T01:00:00.000Z');
    const managerKinds = [
      'manager_approval_requested',
      'manager_approval_resolved',
      'manager_approval_reopened',
      'manager_approval_attention_required',
    ] as const;
    const managerEntries = [];
    for (const [index, kind] of managerKinds.entries()) {
      managerEntries.push(
        await store.enqueueNotification(
          {
            businessEventId: `${kind}:event-${index}`,
            recordId: `manager_${index}`,
            recipientOpenId: 'manager-one',
            kind,
          },
          now,
        ),
      );
    }
    const duplicate = await store.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:event-0',
        recordId: 'manager_0',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      now,
    );
    await store.enqueueNotification(
      {
        businessEventId: 'legacy:event',
        recordId: 'legacy_1',
        recipientOpenId: 'legacy-manager',
        kind: 'approval_requested',
      },
      now,
    );

    expect(duplicate.enqueued).toBe(false);
    expect(duplicate.entry.deliveryUuid).toBe(
      managerEntries[0]?.entry.deliveryUuid,
    );
    expect(duplicate.entry.deliveryUuid.length).toBeLessThanOrEqual(50);
    await expect(store.takeNextNotification(now)).resolves.toMatchObject({
      kind: 'approval_requested',
      recordId: 'legacy_1',
    });

    const claimedManagerKinds = [];
    for (let index = 0; index < managerKinds.length; index += 1) {
      claimedManagerKinds.push(
        (await store.takeNextManagerApprovalNotification(now))?.kind,
      );
    }
    expect(claimedManagerKinds).toEqual(managerKinds);
    await expect(
      store.takeNextManagerApprovalNotification(now),
    ).resolves.toBeNull();
  });

  it('anchors unknown delivery before I/O and requires controlled resolution after one hour', async () => {
    const store = createV2Store(ledgerPath);
    const enqueued = await store.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:unknown-1',
        recordId: 'unknown_1',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      new Date('2026-07-31T02:00:00.000Z'),
    );
    const first = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T02:00:01.000Z'),
      1_000,
    );
    const started = await store.markManagerApprovalSendStarted(
      first?.key || '',
      first?.claimToken || '',
      managerCardContext('unknown_1'),
      new Date('2026-07-31T02:00:01.000Z'),
    );

    expect(started).toMatchObject({
      status: 'processing',
      deliveryUuid: enqueued.entry.deliveryUuid,
      firstSendAttemptAt: '2026-07-31T02:00:01.000Z',
      sendOutcome: 'unknown',
      deliveryGeneration: 1,
      cardContext: managerCardContext('unknown_1'),
      deliveryAudit: [
        expect.objectContaining({
          action: 'send_started',
          generation: 1,
          deliveryUuid: enqueued.entry.deliveryUuid,
        }),
      ],
    });
    await store.rescheduleNotification(
      first?.key || '',
      first?.claimToken || '',
      new Error('Bearer should-be-redacted'),
      new Date('2026-07-31T02:30:00.000Z'),
      new Date('2026-07-31T02:00:02.000Z'),
    );
    const retry = await createV2Store(
      ledgerPath,
    ).takeNextManagerApprovalNotification(
      new Date('2026-07-31T02:30:00.000Z'),
      1_000,
    );
    expect(retry).toMatchObject({
      attempts: 2,
      deliveryUuid: enqueued.entry.deliveryUuid,
      firstSendAttemptAt: '2026-07-31T02:00:01.000Z',
      sendOutcome: 'unknown',
    });

    await expect(
      createV2Store(ledgerPath).takeNextManagerApprovalNotification(
        new Date('2026-07-31T03:00:02.000Z'),
      ),
    ).resolves.toMatchObject({
      key: enqueued.entry.key,
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
      claimToken: '',
      leaseUntil: '',
    });
    const manual = await createV2Store(ledgerPath).getNotification(
      enqueued.entry.key,
    );
    expect(manual).toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
      claimToken: '',
      leaseUntil: '',
      deliveryUuid: enqueued.entry.deliveryUuid,
      deliveryAudit: expect.arrayContaining([
        expect.objectContaining({ action: 'delivery_unknown_timeout' }),
      ]),
    });
    await expect(
      createV2Store(ledgerPath).takeNextManagerApprovalNotification(
        new Date('2026-07-31T04:00:00.000Z'),
      ),
    ).resolves.toBeNull();

    const resolved = await createV2Store(
      ledgerPath,
    ).resolveUnknownManagerApprovalDelivery(
      enqueued.entry.key,
      {
        resolution: 'verified_absent',
        operatorOpenId: 'operator-one',
      },
      new Date('2026-07-31T04:00:01.000Z'),
    );
    expect(resolved.notification).toMatchObject({
      status: 'pending',
      sendOutcome: 'unattempted',
      deliveryGeneration: 2,
      firstSendAttemptAt: '',
      attempts: 0,
      deliveryAudit: expect.arrayContaining([
        expect.objectContaining({
          action: 'operator_verified_absent',
          operatorOpenId: 'operator-one',
          generation: 1,
          deliveryUuid: enqueued.entry.deliveryUuid,
        }),
      ]),
    });
    expect(resolved.notification.deliveryUuid).not.toBe(
      enqueued.entry.deliveryUuid,
    );
    expect(resolved.notification.deliveryUuid.length).toBeLessThanOrEqual(50);
    await expect(
      createV2Store(ledgerPath).takeNextManagerApprovalNotification(
        new Date('2026-07-31T04:00:01.000Z'),
      ),
    ).resolves.toMatchObject({
      deliveryGeneration: 2,
      deliveryUuid: resolved.notification.deliveryUuid,
    });
  });

  it('surfaces multiple expired initial unknown deliveries one per take', async () => {
    const store = createV2Store(ledgerPath);
    const firstEnqueued = await store.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:unknown-batch-1',
        recordId: 'unknown_batch_1',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      new Date('2026-07-31T02:00:00.000Z'),
    );
    const secondEnqueued = await store.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:unknown-batch-2',
        recordId: 'unknown_batch_2',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      new Date('2026-07-31T02:00:00.000Z'),
    );
    const first = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T02:00:01.000Z'),
    );
    await store.markManagerApprovalSendStarted(
      first?.key || '',
      first?.claimToken || '',
      managerCardContext('unknown_batch_1'),
      new Date('2026-07-31T02:00:01.000Z'),
    );
    await store.rescheduleNotification(
      first?.key || '',
      first?.claimToken || '',
      new Error('first send outcome unknown'),
      new Date('2026-07-31T02:10:00.000Z'),
      new Date('2026-07-31T02:00:02.000Z'),
    );
    const second = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T02:00:03.000Z'),
    );
    await store.markManagerApprovalSendStarted(
      second?.key || '',
      second?.claimToken || '',
      managerCardContext('unknown_batch_2'),
      new Date('2026-07-31T02:00:03.000Z'),
    );
    await store.rescheduleNotification(
      second?.key || '',
      second?.claimToken || '',
      new Error('second send outcome unknown'),
      new Date('2026-07-31T02:10:00.000Z'),
      new Date('2026-07-31T02:00:04.000Z'),
    );

    const firstManual = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T03:00:05.000Z'),
    );
    const secondManual = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T03:00:05.000Z'),
    );

    expect([firstManual?.key, secondManual?.key]).toEqual([
      firstEnqueued.entry.key,
      secondEnqueued.entry.key,
    ]);
    expect(firstManual).toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    expect(secondManual).toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    await expect(
      store.takeNextManagerApprovalNotification(
        new Date('2026-07-31T03:00:05.000Z'),
      ),
    ).resolves.toBeNull();
  });

  it('atomically completes an initial send and registers a durable strict card mapping', async () => {
    const store = createV2Store(ledgerPath);
    const enqueued = await store.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:register-1',
        recordId: 'register_1',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      new Date('2026-07-31T05:00:00.000Z'),
    );
    const claimed = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T05:00:01.000Z'),
    );
    await store.markManagerApprovalSendStarted(
      claimed?.key || '',
      claimed?.claimToken || '',
      managerCardContext('register_1'),
      new Date('2026-07-31T05:00:01.000Z'),
    );
    const completed = await store.completeManagerApprovalRequestAndRegisterCard(
      claimed?.key || '',
      claimed?.claimToken || '',
      {
        deliveryId: 'delivery-register-1',
        messageId: 'om_register_1',
      },
      new Date('2026-07-31T05:00:02.000Z'),
    );

    expect(completed.notification).toMatchObject({
      key: enqueued.entry.key,
      kind: 'manager_approval_requested',
      status: 'completed',
      sendOutcome: 'delivered',
      deliveryId: 'delivery-register-1',
      messageId: 'om_register_1',
      completedAt: '2026-07-31T05:00:02.000Z',
    });
    expect(completed.card).toMatchObject({
      executionRecordId: 'register_1',
      messageId: 'om_register_1',
      recipientOpenId: 'manager-one',
      sourceNotificationKey: enqueued.entry.key,
      sourceKind: 'manager_approval_requested',
      sourceStatus: 'completed',
      cardContext: managerCardContext('register_1'),
      state: 'initial',
      supersededMessageIds: [],
    });
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_register_1',
        'manager-one',
      ),
    ).resolves.toMatchObject({ executionRecordId: 'register_1' });
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_register_1',
        'different-manager',
      ),
    ).resolves.toBeNull();

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      notifications: unknown[];
      managerApprovalCards: unknown[];
    };
    expect(persisted.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: enqueued.entry.key,
          status: 'completed',
        }),
      ]),
    );
    expect(persisted.managerApprovalCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: 'om_register_1',
          state: 'initial',
        }),
      ]),
    );

    persisted.notifications = [];
    await writeFile(ledgerPath, JSON.stringify(persisted), 'utf8');
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_register_1',
        'manager-one',
      ),
    ).resolves.toMatchObject({
      executionRecordId: 'register_1',
      sourceKind: 'manager_approval_requested',
      sourceStatus: 'completed',
    });
  });

  it('binds a verified delivered unknown send and retains resolved cards for at least 30 days', async () => {
    const store = createV2Store(ledgerPath);
    const enqueued = await store.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:verified-1',
        recordId: 'verified_1',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      new Date('2026-07-31T06:00:00.000Z'),
    );
    const claimed = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T06:00:01.000Z'),
      1_000,
    );
    await store.markManagerApprovalSendStarted(
      claimed?.key || '',
      claimed?.claimToken || '',
      managerCardContext('verified_1'),
      new Date('2026-07-31T06:00:01.000Z'),
    );
    await expect(
      store.takeNextManagerApprovalNotification(
        new Date('2026-07-31T07:00:02.000Z'),
      ),
    ).resolves.toMatchObject({
      key: enqueued.entry.key,
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });

    const resolved = await store.resolveUnknownManagerApprovalDelivery(
      enqueued.entry.key,
      {
        resolution: 'verified_delivered',
        operatorOpenId: 'operator-one',
        messageId: 'om_verified_1',
      },
      new Date('2026-07-31T07:00:03.000Z'),
    );
    expect(resolved.notification).toMatchObject({
      status: 'completed',
      sendOutcome: 'delivered',
      messageId: 'om_verified_1',
      deliveryAudit: expect.arrayContaining([
        expect.objectContaining({
          action: 'operator_verified_delivered',
          operatorOpenId: 'operator-one',
        }),
      ]),
    });
    expect(resolved.card).toMatchObject({
      executionRecordId: 'verified_1',
      messageId: 'om_verified_1',
      state: 'initial',
    });

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      managerApprovalCards: ManagerCardEntry[];
    };
    const baseCard = persisted.managerApprovalCards[0];
    expect(baseCard).toBeDefined();
    const retentionAnchor = Date.now();
    persisted.managerApprovalCards.push(
      {
        ...(baseCard as ManagerCardEntry),
        key: 'manager-card:recent_resolved:manager-one',
        executionRecordId: 'recent_resolved',
        messageId: 'om_recent_resolved',
        cardContext: managerCardContext('recent_resolved'),
        state: 'resolved',
        choice: 'comprehensive',
        actionEventId: 'event-recent-resolved',
        processedAt: new Date(retentionAnchor).toISOString(),
        updatedAt: new Date(
          retentionAnchor - 29 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        resolvedAt: new Date(
          retentionAnchor - 29 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      {
        ...(baseCard as ManagerCardEntry),
        key: 'manager-card:expired_resolved:manager-one',
        executionRecordId: 'expired_resolved',
        messageId: 'om_expired_resolved',
        cardContext: managerCardContext('expired_resolved'),
        state: 'resolved',
        choice: 'comprehensive',
        actionEventId: 'event-expired-resolved',
        processedAt: new Date(retentionAnchor).toISOString(),
        updatedAt: new Date(
          retentionAnchor - 31 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        resolvedAt: new Date(
          retentionAnchor - 31 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    );
    await writeFile(ledgerPath, JSON.stringify(persisted), 'utf8');
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_recent_resolved',
        'manager-one',
      ),
    ).resolves.toMatchObject({ state: 'resolved' });
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_expired_resolved',
        'manager-one',
      ),
    ).resolves.toBeNull();
  });

  it('uses reject-editor CAS and atomically accepts exactly one of 20 concurrent choices', async () => {
    const store = createV2Store(ledgerPath);
    await registerInitialManagerCard(store, {
      recordId: 'concurrent_reject_1',
      messageId: 'om_concurrent_reject_1',
    });

    const opened = await store.openManagerApprovalRejectEditor(
      {
        recordId: 'concurrent_reject_1',
        messageId: 'om_concurrent_reject_1',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T08:00:03.000Z'),
    );
    expect(opened).toMatchObject({
      opened: true,
      card: {
        state: 'reject_editing',
        choice: '',
        actionEventId: '',
      },
    });
    await expect(
      store.openManagerApprovalRejectEditor(
        {
          recordId: 'concurrent_reject_1',
          messageId: 'om_concurrent_reject_1',
          actorOpenId: 'manager-one',
        },
        new Date('2026-07-31T08:00:04.000Z'),
      ),
    ).resolves.toMatchObject({
      opened: false,
      card: { state: 'reject_editing' },
    });

    await expect(
      store.claimManagerApprovalAction(
        {
          eventId: 'stale-positive-event',
          recordId: 'concurrent_reject_1',
          choice: 'comprehensive',
          messageId: 'om_concurrent_reject_1',
          actorOpenId: 'manager-one',
        },
        new Date('2026-07-31T08:00:05.000Z'),
      ),
    ).resolves.toMatchObject({
      claimed: false,
      entry: null,
      card: { state: 'reject_editing' },
    });

    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.claimManagerApprovalAction(
          {
            eventId: `reject-event-${index}`,
            recordId: 'concurrent_reject_1',
            choice: 'reject',
            rejectionReason: '  预算依据不足，请补充。  ',
            messageId: 'om_concurrent_reject_1',
            actorOpenId: 'manager-one',
          },
          new Date('2026-07-31T08:00:06.000Z'),
        ),
      ),
    );
    const winners = attempts.filter((result) => result.claimed);
    expect(winners).toHaveLength(1);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimed: false,
          card: expect.objectContaining({
            state: 'pending',
            choice: 'reject',
            rejectionReasonDraft: '预算依据不足，请补充。',
          }),
        }),
      ]),
    );

    const winner = winners[0];
    expect(winner?.entry).toMatchObject({
      key: `manager-approval-action:${winner?.entry?.eventId}`,
      recordId: 'concurrent_reject_1',
      choice: 'reject',
      rejectionReason: '预算依据不足，请补充。',
      messageId: 'om_concurrent_reject_1',
      actorOpenId: 'manager-one',
      status: 'pending',
    });
    expect(
      await createV2Store(ledgerPath).listManagerApprovalActions({
        recordId: 'concurrent_reject_1',
      }),
    ).toHaveLength(1);
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_concurrent_reject_1',
        'manager-one',
      ),
    ).resolves.toMatchObject({
      state: 'pending',
      choice: 'reject',
      rejectionReasonDraft: '预算依据不足，请补充。',
      actionEventId: winner?.entry?.eventId,
    });

    const replayInput = {
      eventId: winner?.entry?.eventId || '',
      recordId: 'concurrent_reject_1',
      choice: 'reject' as const,
      rejectionReason: '预算依据不足，请补充。',
      messageId: 'om_concurrent_reject_1',
      actorOpenId: 'manager-one',
    };
    await expect(
      createV2Store(ledgerPath).claimManagerApprovalAction(replayInput),
    ).resolves.toMatchObject({
      claimed: false,
      entry: { eventId: replayInput.eventId },
      card: { state: 'pending' },
    });
    await expect(
      store.claimManagerApprovalAction({
        ...replayInput,
        rejectionReason: '另一个原因',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.claimManagerApprovalAction({
        ...replayInput,
        choice: 'comprehensive',
        rejectionReason: undefined,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a forged H-building self-purchase action before creating a task', async () => {
    const store = createV2Store(ledgerPath);
    await registerInitialManagerCard(store, {
      recordId: 'h_building_self_purchase_1',
      messageId: 'om_h_building_self_purchase_1',
      building: 'H楼',
    });

    await expect(
      store.claimManagerApprovalAction({
        eventId: 'event-h-building-self-purchase-1',
        recordId: 'h_building_self_purchase_1',
        choice: 'building_self',
        messageId: 'om_h_building_self_purchase_1',
        actorOpenId: 'manager-one',
      }),
    ).rejects.toThrow('H楼仅支持综合采购');
    await expect(
      store.listManagerApprovalActions({
        recordId: 'h_building_self_purchase_1',
      }),
    ).resolves.toHaveLength(0);
  });

  it('isolates manager actions and fences expired worker leases across restart', async () => {
    const store = createV2Store(ledgerPath);
    await registerInitialManagerCard(
      store,
      {
        recordId: 'manager_lease_1',
        messageId: 'om_manager_lease_1',
      },
      new Date('2026-07-31T09:00:00.000Z'),
    );
    const accepted = await store.claimManagerApprovalAction(
      {
        eventId: 'manager-lease-event-1',
        recordId: 'manager_lease_1',
        choice: 'comprehensive',
        messageId: 'om_manager_lease_1',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T09:00:03.000Z'),
    );
    expect(accepted).toMatchObject({
      claimed: true,
      entry: {
        status: 'pending',
        attempts: 0,
        rejectionReason: '',
      },
      card: { state: 'pending', choice: 'comprehensive' },
    });
    await expect(
      store.claimManagerApprovalAction({
        eventId: 'blocked-pending-event',
        recordId: 'manager_lease_1',
        choice: 'building_self',
        messageId: 'om_manager_lease_1',
        actorOpenId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      claimed: false,
      entry: { eventId: 'manager-lease-event-1', status: 'pending' },
      card: { state: 'pending', choice: 'comprehensive' },
    });

    await store.claimCardAction(
      {
        eventId: 'legacy-action-event',
        recordId: 'legacy_manager_isolation',
        action: 'approve',
        actorOpenId: 'legacy-approver',
      },
      new Date('2026-07-31T09:00:03.000Z'),
    );
    const first = await store.takeNextManagerApprovalAction(
      new Date('2026-07-31T09:00:04.000Z'),
      1_000,
    );
    expect(first).toMatchObject({
      eventId: 'manager-lease-event-1',
      status: 'processing',
      attempts: 1,
    });
    await expect(
      store.claimManagerApprovalAction({
        eventId: 'blocked-processing-event',
        recordId: 'manager_lease_1',
        choice: 'building_self',
        messageId: 'om_manager_lease_1',
        actorOpenId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      claimed: false,
      entry: { eventId: 'manager-lease-event-1', status: 'processing' },
      card: { state: 'pending', choice: 'comprehensive' },
    });
    await expect(
      store.takeNextManagerApprovalAction(new Date('2026-07-31T09:00:04.999Z')),
    ).resolves.toBeNull();
    await expect(
      store.takeNextCardAction(new Date('2026-07-31T09:00:04.000Z')),
    ).resolves.toMatchObject({ eventId: 'legacy-action-event' });

    const reclaimed = await createV2Store(
      ledgerPath,
    ).takeNextManagerApprovalAction(
      new Date('2026-07-31T09:00:05.000Z'),
      1_000,
    );
    expect(reclaimed).toMatchObject({
      eventId: 'manager-lease-event-1',
      status: 'processing',
      attempts: 2,
      messageId: 'om_manager_lease_1',
    });
    expect(reclaimed?.claimToken).not.toBe(first?.claimToken);
    await expect(
      store.completeManagerApprovalActionAndEnqueueResolved(
        first?.key || '',
        first?.claimToken || '',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.rescheduleManagerApprovalAction(
        first?.key || '',
        first?.claimToken || '',
        new Error('Bearer stale-secret'),
        new Date('2026-07-31T09:01:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const rescheduled = await createV2Store(
      ledgerPath,
    ).rescheduleManagerApprovalAction(
      reclaimed?.key || '',
      reclaimed?.claimToken || '',
      new Error(
        'temporary app_secret=do-not-persist Bearer should-not-persist',
      ),
      new Date('2026-07-31T09:01:00.000Z'),
      new Date('2026-07-31T09:00:06.000Z'),
    );
    expect(rescheduled).toMatchObject({
      status: 'pending',
      claimToken: '',
      leaseUntil: '',
      nextAttemptAt: '2026-07-31T09:01:00.000Z',
    });
    expect(rescheduled?.lastError).toContain('[redacted]');
    expect(rescheduled?.lastError).not.toContain('do-not-persist');
    expect(rescheduled?.lastError).not.toContain('should-not-persist');
    await expect(
      createV2Store(ledgerPath).takeNextManagerApprovalAction(
        new Date('2026-07-31T09:01:00.000Z'),
      ),
    ).resolves.toMatchObject({
      eventId: 'manager-lease-event-1',
      attempts: 3,
      rejectionReason: '',
      messageId: 'om_manager_lease_1',
    });
  });

  it('atomically resolves a manager action and enqueues an event-specific result update', async () => {
    const store = createV2Store(ledgerPath);
    const startedAt = new Date();
    startedAt.setMilliseconds(0);
    const at = (seconds: number) =>
      new Date(startedAt.getTime() + seconds * 1_000);
    await registerInitialManagerCard(
      store,
      {
        recordId: 'atomic_success_1',
        messageId: 'om_atomic_success_1',
      },
      at(0),
    );
    const accepted = await store.claimManagerApprovalAction(
      {
        eventId: 'atomic-success-event-1',
        recordId: 'atomic_success_1',
        choice: 'building_self',
        messageId: 'om_atomic_success_1',
        actorOpenId: 'manager-one',
      },
      at(3),
    );
    const claimed = await store.takeNextManagerApprovalAction(at(4));
    const completed =
      await store.completeManagerApprovalActionAndEnqueueResolved(
        accepted.entry?.key || '',
        claimed?.claimToken || '',
        at(5),
      );

    expect(completed).toMatchObject({
      action: {
        eventId: 'atomic-success-event-1',
        status: 'completed',
        completedAt: at(5).toISOString(),
        claimToken: '',
      },
      card: {
        state: 'resolved',
        choice: 'building_self',
        actionEventId: 'atomic-success-event-1',
        processedAt: at(5).toISOString(),
        resolvedAt: at(5).toISOString(),
      },
      notification: {
        businessEventId: 'manager_approval_resolved:atomic-success-event-1',
        kind: 'manager_approval_resolved',
        recordId: 'atomic_success_1',
        recipientOpenId: 'manager-one',
        status: 'pending',
        messageId: 'om_atomic_success_1',
      },
    });
    expect(completed.notification.key).toContain('atomic-success-event-1');

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      managerApprovalActions: ManagerActionEntry[];
      managerApprovalCards: ManagerCardEntry[];
      notifications: NotificationEntry[];
    };
    expect(persisted.managerApprovalActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: 'atomic-success-event-1',
          status: 'completed',
        }),
      ]),
    );
    expect(persisted.managerApprovalCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionRecordId: 'atomic_success_1',
          state: 'resolved',
        }),
      ]),
    );
    expect(persisted.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          businessEventId: 'manager_approval_resolved:atomic-success-event-1',
        }),
      ]),
    );

    await expect(
      store.completeManagerApprovalActionAndEnqueueResolved(
        accepted.entry?.key || '',
        claimed?.claimToken || '',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      createV2Store(ledgerPath).claimManagerApprovalAction({
        eventId: 'blocked-after-complete',
        recordId: 'atomic_success_1',
        choice: 'comprehensive',
        messageId: 'om_atomic_success_1',
        actorOpenId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      claimed: false,
      entry: { status: 'completed', eventId: 'atomic-success-event-1' },
      card: { state: 'resolved', choice: 'building_self' },
    });
  });

  it('atomically fails an action, restores its exact card state, and allows a new event', async () => {
    const cases = [
      {
        label: 'positive',
        choice: 'comprehensive' as const,
        rejectionReason: undefined,
        restoredState: 'initial',
        restoredDraft: '',
      },
      {
        label: 'reject',
        choice: 'reject' as const,
        rejectionReason: '供应依据不足',
        restoredState: 'reject_editing',
        restoredDraft: '供应依据不足',
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const casePath = join(
        directory,
        `manager-failure-${scenario.label}.json`,
      );
      const store = createV2Store(casePath);
      const recordId = `atomic_failure_${index}`;
      const messageId = `om_atomic_failure_${index}`;
      await registerInitialManagerCard(
        store,
        { recordId, messageId },
        new Date(`2026-07-31T11:0${index}:00.000Z`),
      );
      if (scenario.choice === 'reject') {
        await store.openManagerApprovalRejectEditor(
          { recordId, messageId, actorOpenId: 'manager-one' },
          new Date(`2026-07-31T11:0${index}:03.000Z`),
        );
      }
      const accepted = await store.claimManagerApprovalAction(
        {
          eventId: `atomic-failure-event-${index}`,
          recordId,
          choice: scenario.choice,
          rejectionReason: scenario.rejectionReason,
          messageId,
          actorOpenId: 'manager-one',
        },
        new Date(`2026-07-31T11:0${index}:04.000Z`),
      );
      const claimed = await store.takeNextManagerApprovalAction(
        new Date(`2026-07-31T11:0${index}:05.000Z`),
      );
      const failed = await store.failManagerApprovalActionAndEnqueueReopen(
        accepted.entry?.key || '',
        claimed?.claimToken || '',
        new Error('Base failed app_secret=must-not-leak'),
        new Date(`2026-07-31T11:0${index}:06.000Z`),
      );

      expect(failed.action).toMatchObject({
        status: 'failed',
        claimToken: '',
        completedAt: `2026-07-31T11:0${index}:06.000Z`,
      });
      expect(failed.action.lastError).toContain('[redacted]');
      expect(failed.action.lastError).not.toContain('must-not-leak');
      expect(failed.card).toMatchObject({
        state: scenario.restoredState,
        choice: '',
        rejectionReasonDraft: scenario.restoredDraft,
        actionEventId: '',
        processedAt: '',
      });
      expect(failed.notification).toMatchObject({
        businessEventId: `manager_approval_reopened:atomic-failure-event-${index}`,
        kind: 'manager_approval_reopened',
        status: 'pending',
        messageId,
        cardContext: managerCardContext(recordId),
      });

      await expect(
        createV2Store(casePath).claimManagerApprovalAction({
          eventId: `retry-after-failure-${index}`,
          recordId,
          choice: scenario.choice,
          rejectionReason: scenario.rejectionReason,
          messageId,
          actorOpenId: 'manager-one',
        }),
      ).resolves.toMatchObject({
        claimed: true,
        entry: { eventId: `retry-after-failure-${index}` },
        card: { state: 'pending', choice: scenario.choice },
      });
    }
  });

  it('locks ambiguous outcomes in durable manual reconciliation outside terminal trimming', async () => {
    const store = createV2Store(ledgerPath);
    await registerInitialManagerCard(
      store,
      {
        recordId: 'manual_result_1',
        messageId: 'om_manual_result_1',
      },
      new Date('2026-07-31T12:00:00.000Z'),
    );
    const accepted = await store.claimManagerApprovalAction(
      {
        eventId: 'manual-result-event-1',
        recordId: 'manual_result_1',
        choice: 'comprehensive',
        messageId: 'om_manual_result_1',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T12:00:03.000Z'),
    );
    const claimed = await store.takeNextManagerApprovalAction(
      new Date('2026-07-31T12:00:04.000Z'),
    );
    const manual = await store.markManagerApprovalManualReconciliation(
      accepted.entry?.key || '',
      claimed?.claimToken || '',
      new Error('ambiguous access_token=must-not-leak'),
      new Date('2026-07-31T12:00:05.000Z'),
    );

    expect(manual.action).toMatchObject({
      status: 'manual_reconciliation',
      completedAt: '2026-07-31T12:00:05.000Z',
      claimToken: '',
    });
    expect(manual.action.lastError).toContain('[redacted]');
    expect(manual.action.lastError).not.toContain('must-not-leak');
    expect(manual.card).toMatchObject({
      state: 'manual_reconciliation',
      choice: 'comprehensive',
      actionEventId: 'manual-result-event-1',
    });
    expect(manual.notification).toMatchObject({
      businessEventId:
        'manager_approval_attention_required:manual-result-event-1',
      kind: 'manager_approval_attention_required',
      status: 'pending',
      messageId: 'om_manual_result_1',
    });
    await expect(
      store.claimManagerApprovalAction({
        eventId: 'blocked-after-manual',
        recordId: 'manual_result_1',
        choice: 'building_self',
        messageId: 'om_manual_result_1',
        actorOpenId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      claimed: false,
      entry: { status: 'manual_reconciliation' },
      card: { state: 'manual_reconciliation' },
    });

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      managerApprovalActions: ManagerActionEntry[];
      notifications: NotificationEntry[];
    };
    const manualAction = persisted.managerApprovalActions.find(
      (entry) => entry.eventId === 'manual-result-event-1',
    );
    const deliveredRequest = persisted.notifications.find(
      (entry) => entry.kind === 'manager_approval_requested',
    );
    expect(manualAction).toBeDefined();
    expect(deliveredRequest?.deliveryAudit.length).toBeGreaterThan(0);
    persisted.managerApprovalActions.push(
      ...Array.from({ length: 510 }, (_, index) => ({
        ...(manualAction as ManagerActionEntry),
        key: `ignored-terminal-key-${index}`,
        eventId: `terminal-manager-event-${index}`,
        status: 'completed' as const,
        completedAt: '2026-07-31T12:01:00.000Z',
        claimToken: '',
        leaseUntil: '',
      })),
    );
    persisted.notifications.push(
      ...Array.from({ length: 510 }, (_, index) => ({
        ...(deliveredRequest as NotificationEntry),
        key: `ignored-terminal-notification-key-${index}`,
        businessEventId: `legacy-terminal-event-${index}`,
        recordId: `legacy_terminal_${index}`,
        kind: 'approval_resolved' as const,
        status: 'completed' as const,
        completedAt: '2026-07-31T12:01:00.000Z',
        deliveryUuid: '',
        firstSendAttemptAt: '',
        sendOutcome: 'unattempted' as const,
        cardContext: '',
        deliveryAudit: [],
      })),
    );
    await writeFile(ledgerPath, JSON.stringify(persisted), 'utf8');

    const restarted = createV2Store(ledgerPath);
    await expect(
      restarted.listManagerApprovalActions({
        status: 'manual_reconciliation',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ eventId: 'manual-result-event-1' }),
    ]);
    await expect(
      restarted.listManagerApprovalActions({ status: 'completed' }),
    ).resolves.toHaveLength(500);
    await expect(
      restarted.findManagerApprovalCard('om_manual_result_1', 'manager-one'),
    ).resolves.toMatchObject({ state: 'manual_reconciliation' });
    await expect(
      restarted.listNotifications({
        kind: 'manager_approval_attention_required',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        businessEventId:
          'manager_approval_attention_required:manual-result-event-1',
        status: 'pending',
      }),
    ]);
    await expect(
      restarted.listNotifications({
        kind: 'manager_approval_requested',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        businessEventId: 'manager_approval_requested:manual_result_1',
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({ action: 'send_started' }),
        ]),
      }),
    ]);
  });

  it('atomically binds exactly one manual initial delivery from its first valid callback', async () => {
    const store = createV2Store(ledgerPath);
    const enqueued = await store.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:callback-bind-1',
        recordId: 'callback_bind_1',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      new Date('2026-07-31T13:00:00.000Z'),
    );
    const claimed = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T13:00:01.000Z'),
      1_000,
    );
    await store.markManagerApprovalSendStarted(
      claimed?.key || '',
      claimed?.claimToken || '',
      managerCardContext('callback_bind_1'),
      new Date('2026-07-31T13:00:01.000Z'),
    );
    await expect(
      store.takeNextManagerApprovalNotification(
        new Date('2026-07-31T14:00:02.000Z'),
      ),
    ).resolves.toMatchObject({
      key: enqueued.entry.key,
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });

    const bound = await store.bindUnknownManagerApprovalDeliveryFromCallback(
      {
        recordId: 'callback_bind_1',
        messageId: 'om_callback_bind_1',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T14:00:03.000Z'),
    );
    expect(bound).toMatchObject({
      bound: true,
      notification: {
        key: enqueued.entry.key,
        status: 'completed',
        sendOutcome: 'delivered',
        messageId: 'om_callback_bind_1',
        completedAt: '2026-07-31T14:00:03.000Z',
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'callback_bound',
            operatorOpenId: 'manager-one',
            messageId: 'om_callback_bind_1',
          }),
        ]),
      },
      card: {
        executionRecordId: 'callback_bind_1',
        messageId: 'om_callback_bind_1',
        recipientOpenId: 'manager-one',
        state: 'initial',
      },
    });
    await expect(
      createV2Store(ledgerPath).bindUnknownManagerApprovalDeliveryFromCallback({
        recordId: 'callback_bind_1',
        messageId: 'om_callback_bind_1',
        actorOpenId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      bound: false,
      notification: { key: enqueued.entry.key, status: 'completed' },
      card: { messageId: 'om_callback_bind_1' },
    });
    await expect(
      store.bindUnknownManagerApprovalDeliveryFromCallback({
        recordId: 'callback_bind_missing',
        messageId: 'om_callback_bind_missing',
        actorOpenId: 'manager-one',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const multiplePath = join(directory, 'multiple-manual-deliveries.json');
    const multipleStore = createV2Store(multiplePath);
    const original = await multipleStore.enqueueNotification(
      {
        businessEventId: 'manager_approval_requested:multiple-a',
        recordId: 'callback_multiple_1',
        recipientOpenId: 'manager-one',
        kind: 'manager_approval_requested',
      },
      new Date('2026-07-31T15:00:00.000Z'),
    );
    const multipleClaim =
      await multipleStore.takeNextManagerApprovalNotification(
        new Date('2026-07-31T15:00:01.000Z'),
        1_000,
      );
    await multipleStore.markManagerApprovalSendStarted(
      multipleClaim?.key || '',
      multipleClaim?.claimToken || '',
      managerCardContext('callback_multiple_1'),
      new Date('2026-07-31T15:00:01.000Z'),
    );
    await multipleStore.takeNextManagerApprovalNotification(
      new Date('2026-07-31T16:00:02.000Z'),
    );
    const persisted = JSON.parse(await readFile(multiplePath, 'utf8')) as {
      notifications: NotificationEntry[];
    };
    const manualCandidate = persisted.notifications.find(
      (entry) => entry.key === original.entry.key,
    );
    expect(manualCandidate?.status).toBe('manual_reconciliation');
    persisted.notifications.push({
      ...(manualCandidate as NotificationEntry),
      key: 'ignored-duplicate-manual-key',
      businessEventId: 'manager_approval_requested:multiple-b',
      deliveryUuid: 'pmgr-1-another-stable-delivery-uuid',
    });
    await writeFile(multiplePath, JSON.stringify(persisted), 'utf8');
    await expect(
      createV2Store(
        multiplePath,
      ).bindUnknownManagerApprovalDeliveryFromCallback({
        recordId: 'callback_multiple_1',
        messageId: 'om_callback_multiple_1',
        actorOpenId: 'manager-one',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('atomically rebinds a replacement card and permanently supersedes the old message', async () => {
    const store = createV2Store(ledgerPath);
    await registerInitialManagerCard(
      store,
      {
        recordId: 'replacement_1',
        messageId: 'om_replacement_old',
      },
      new Date('2026-07-31T17:00:00.000Z'),
    );
    await store.openManagerApprovalRejectEditor(
      {
        recordId: 'replacement_1',
        messageId: 'om_replacement_old',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T17:00:03.000Z'),
    );
    const accepted = await store.claimManagerApprovalAction(
      {
        eventId: 'replacement-action-event-1',
        recordId: 'replacement_1',
        choice: 'reject',
        rejectionReason: '请补全比价依据',
        messageId: 'om_replacement_old',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T17:00:04.000Z'),
    );
    const action = await store.takeNextManagerApprovalAction(
      new Date('2026-07-31T17:00:05.000Z'),
    );
    const reopened = await store.failManagerApprovalActionAndEnqueueReopen(
      accepted.entry?.key || '',
      action?.claimToken || '',
      new Error('confirmed no write'),
      new Date('2026-07-31T17:00:06.000Z'),
    );
    const firstNotification = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T17:00:07.000Z'),
    );
    expect(firstNotification?.key).toBe(reopened.notification.key);
    const rescheduled = await store.rescheduleNotification(
      firstNotification?.key || '',
      firstNotification?.claimToken || '',
      new Error('transient Bearer must-not-leak'),
      new Date('2026-07-31T17:00:09.000Z'),
      new Date('2026-07-31T17:00:08.000Z'),
    );
    expect(rescheduled).toMatchObject({
      kind: 'manager_approval_reopened',
      status: 'pending',
      nextAttemptAt: '2026-07-31T17:00:09.000Z',
      deliveryUuid: reopened.notification.deliveryUuid,
    });
    expect(rescheduled?.lastError).toContain('[redacted]');
    expect(rescheduled?.lastError).not.toContain('must-not-leak');
    await expect(
      store.takeNextManagerApprovalNotification(
        new Date('2026-07-31T17:00:08.999Z'),
      ),
    ).resolves.toBeNull();
    const notification = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T17:00:09.000Z'),
    );
    expect(notification).toMatchObject({
      key: reopened.notification.key,
      attempts: 2,
      deliveryUuid: reopened.notification.deliveryUuid,
    });
    const started = await store.markManagerApprovalSendStarted(
      notification?.key || '',
      notification?.claimToken || '',
      reopened.card.cardContext,
      new Date('2026-07-31T17:00:09.000Z'),
    );

    const replaced = await store.replaceManagerApprovalCardMessage(
      notification?.key || '',
      notification?.claimToken || '',
      {
        oldMessageId: 'om_replacement_old',
        newMessageId: 'om_replacement_new',
        deliveryId: 'delivery-replacement-1',
      },
      new Date('2026-07-31T17:00:10.000Z'),
    );
    expect(replaced).toMatchObject({
      notification: {
        kind: 'manager_approval_reopened',
        status: 'completed',
        sendOutcome: 'delivered',
        deliveryUuid: started?.deliveryUuid,
        deliveryId: 'delivery-replacement-1',
        messageId: 'om_replacement_new',
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'replacement_bound',
            messageId: 'om_replacement_new',
          }),
        ]),
      },
      card: {
        executionRecordId: 'replacement_1',
        messageId: 'om_replacement_new',
        supersededMessageIds: ['om_replacement_old'],
        state: 'reject_editing',
        rejectionReasonDraft: '请补全比价依据',
      },
    });
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_replacement_old',
        'manager-one',
      ),
    ).resolves.toBeNull();
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_replacement_new',
        'manager-one',
      ),
    ).resolves.toMatchObject({
      state: 'reject_editing',
      supersededMessageIds: ['om_replacement_old'],
    });
    await expect(
      store.claimManagerApprovalAction({
        eventId: 'superseded-message-event',
        recordId: 'replacement_1',
        choice: 'reject',
        rejectionReason: '请补全比价依据',
        messageId: 'om_replacement_old',
        actorOpenId: 'manager-one',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.replaceManagerApprovalCardMessage(
        notification?.key || '',
        notification?.claimToken || '',
        {
          oldMessageId: 'om_replacement_old',
          newMessageId: 'om_replacement_other',
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('atomically locks a reopened card and enqueues attention when replacement delivery stays unknown', async () => {
    const store = createV2Store(ledgerPath);
    await registerInitialManagerCard(
      store,
      {
        recordId: 'replacement_unknown_1',
        messageId: 'om_replacement_unknown_old',
      },
      new Date('2026-07-31T18:00:00.000Z'),
    );
    await store.openManagerApprovalRejectEditor(
      {
        recordId: 'replacement_unknown_1',
        messageId: 'om_replacement_unknown_old',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T18:00:03.000Z'),
    );
    const accepted = await store.claimManagerApprovalAction(
      {
        eventId: 'replacement-unknown-event-1',
        recordId: 'replacement_unknown_1',
        choice: 'reject',
        rejectionReason: '缺少采购依据',
        messageId: 'om_replacement_unknown_old',
        actorOpenId: 'manager-one',
      },
      new Date('2026-07-31T18:00:04.000Z'),
    );
    const action = await store.takeNextManagerApprovalAction(
      new Date('2026-07-31T18:00:05.000Z'),
    );
    const reopened = await store.failManagerApprovalActionAndEnqueueReopen(
      accepted.entry?.key || '',
      action?.claimToken || '',
      new Error('confirmed no write'),
      new Date('2026-07-31T18:00:06.000Z'),
    );
    const notification = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T18:00:07.000Z'),
      1_000,
    );
    await store.markManagerApprovalSendStarted(
      notification?.key || '',
      notification?.claimToken || '',
      reopened.card.cardContext,
      new Date('2026-07-31T18:00:07.000Z'),
    );

    await expect(
      createV2Store(ledgerPath).takeNextManagerApprovalNotification(
        new Date('2026-07-31T19:00:08.000Z'),
      ),
    ).resolves.toMatchObject({
      key: reopened.notification.key,
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    await expect(
      createV2Store(ledgerPath).getNotification(reopened.notification.key),
    ).resolves.toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
      claimToken: '',
      deliveryAudit: expect.arrayContaining([
        expect.objectContaining({ action: 'delivery_unknown_timeout' }),
      ]),
    });
    await expect(
      createV2Store(ledgerPath).findManagerApprovalCard(
        'om_replacement_unknown_old',
        'manager-one',
      ),
    ).resolves.toMatchObject({
      state: 'manual_reconciliation',
      choice: 'reject',
      rejectionReasonDraft: '缺少采购依据',
      actionEventId: 'replacement-unknown-event-1',
    });
    await expect(
      createV2Store(ledgerPath).listNotifications({
        kind: 'manager_approval_attention_required',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        businessEventId:
          'manager_approval_attention_required:replacement-unknown-event-1:1',
        status: 'pending',
        messageId: 'om_replacement_unknown_old',
      }),
    ]);

    await expect(
      store.claimManagerApprovalAction({
        eventId: 'replacement-unknown-stale-choice',
        recordId: 'replacement_unknown_1',
        choice: 'reject',
        rejectionReason: '缺少采购依据',
        messageId: 'om_replacement_unknown_old',
        actorOpenId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      claimed: false,
      entry: null,
      card: { state: 'manual_reconciliation' },
    });
    await expect(
      store.listManagerApprovalActions({
        recordId: 'replacement_unknown_1',
      }),
    ).resolves.toHaveLength(1);
  });

  it('atomically binds a manually verified reopened replacement and restores reject editing', async () => {
    const store = createV2Store(ledgerPath);
    const fixture = await createManualReopenedManagerDelivery(store, {
      recordId: 'reopened_verified_delivered_1',
      oldMessageId: 'om_reopened_verified_delivered_old',
      eventId: 'reopened-verified-delivered-event-1',
      choice: 'reject',
      rejectionReason: '缺少采购依据',
      startedAt: new Date('2026-07-31T20:00:00.000Z'),
    });

    const resolved = await store.resolveUnknownManagerApprovalDelivery(
      fixture.notification.key,
      {
        resolution: 'verified_delivered',
        operatorOpenId: 'operator-one',
        messageId: 'om_reopened_verified_delivered_new',
      },
      new Date('2026-07-31T21:01:00.000Z'),
    );

    expect(resolved).toMatchObject({
      notification: {
        kind: 'manager_approval_reopened',
        status: 'completed',
        sendOutcome: 'delivered',
        messageId: 'om_reopened_verified_delivered_new',
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'operator_verified_delivered',
            operatorOpenId: 'operator-one',
          }),
        ]),
      },
      card: {
        executionRecordId: 'reopened_verified_delivered_1',
        messageId: 'om_reopened_verified_delivered_new',
        supersededMessageIds: ['om_reopened_verified_delivered_old'],
        state: 'reject_editing',
        choice: '',
        rejectionReasonDraft: '缺少采购依据',
        actionEventId: '',
        actorOpenId: '',
        processedAt: '',
      },
    });
    await expect(
      store.findManagerApprovalCard(
        'om_reopened_verified_delivered_old',
        'manager-one',
      ),
    ).resolves.toBeNull();
    await expect(
      store.findManagerApprovalCard(
        'om_reopened_verified_delivered_new',
        'manager-one',
      ),
    ).resolves.toMatchObject({ state: 'reject_editing' });
    await expect(
      store.listNotifications({
        kind: 'manager_approval_attention_required',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'completed',
        completedAt: '2026-07-31T21:01:00.000Z',
      }),
    ]);
    await expect(
      store.claimManagerApprovalAction(
        {
          eventId: 'reopened-verified-delivered-clickable-event',
          recordId: 'reopened_verified_delivered_1',
          choice: 'reject',
          rejectionReason: '缺少采购依据',
          messageId: 'om_reopened_verified_delivered_new',
          actorOpenId: 'manager-one',
        },
        new Date('2026-07-31T21:01:01.000Z'),
      ),
    ).resolves.toMatchObject({
      claimed: true,
      card: { state: 'pending' },
    });
  });

  it('retains the failed action required to recover a manual reopened delivery beyond terminal trimming', async () => {
    const store = createV2Store(ledgerPath);
    const fixture = await createManualReopenedManagerDelivery(store, {
      recordId: 'reopened_terminal_retention_1',
      oldMessageId: 'om_reopened_terminal_retention_old',
      eventId: 'reopened-terminal-retention-event-1',
      choice: 'building_self',
      startedAt: new Date('2026-07-31T21:10:00.000Z'),
    });
    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      managerApprovalActions: ManagerActionEntry[];
    };
    const requiredAction = persisted.managerApprovalActions.find(
      (entry) => entry.eventId === fixture.action.eventId,
    );
    if (!requiredAction) throw new Error('Expected failed recovery action');
    persisted.managerApprovalActions.push(
      ...Array.from({ length: 510 }, (_, index) => ({
        ...requiredAction,
        key: `terminal-retention-noise-key-${index}`,
        eventId: `terminal-retention-noise-event-${index}`,
        recordId: `terminal_retention_noise_${index}`,
        status: 'completed' as const,
        completedAt: '2026-07-31T21:11:00.000Z',
      })),
    );
    await writeFile(ledgerPath, JSON.stringify(persisted), 'utf8');

    const restarted = createV2Store(ledgerPath);
    await expect(
      restarted.resolveUnknownManagerApprovalDelivery(
        fixture.notification.key,
        {
          resolution: 'verified_delivered',
          operatorOpenId: 'operator-one',
          messageId: 'om_reopened_terminal_retention_new',
        },
        new Date('2026-07-31T22:11:00.000Z'),
      ),
    ).resolves.toMatchObject({
      notification: {
        status: 'completed',
        messageId: 'om_reopened_terminal_retention_new',
      },
      card: {
        state: 'initial',
        messageId: 'om_reopened_terminal_retention_new',
        supersededMessageIds: ['om_reopened_terminal_retention_old'],
      },
    });
  });

  it('creates a new reopened generation after verified absence and permits a clickable replacement', async () => {
    const store = createV2Store(ledgerPath);
    const fixture = await createManualReopenedManagerDelivery(store, {
      recordId: 'reopened_verified_absent_1',
      oldMessageId: 'om_reopened_verified_absent_old',
      eventId: 'reopened-verified-absent-event-1',
      choice: 'comprehensive',
      startedAt: new Date('2026-07-31T22:00:00.000Z'),
    });
    const oldDeliveryUuid = fixture.notification.deliveryUuid;

    const resolved = await store.resolveUnknownManagerApprovalDelivery(
      fixture.notification.key,
      {
        resolution: 'verified_absent',
        operatorOpenId: 'operator-one',
      },
      new Date('2026-07-31T23:01:00.000Z'),
    );

    expect(resolved).toMatchObject({
      notification: {
        kind: 'manager_approval_reopened',
        status: 'pending',
        sendOutcome: 'unattempted',
        attempts: 0,
        deliveryGeneration: 2,
        firstSendAttemptAt: '',
        messageId: 'om_reopened_verified_absent_old',
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'operator_verified_absent',
            operatorOpenId: 'operator-one',
            generation: 1,
            deliveryUuid: oldDeliveryUuid,
          }),
        ]),
      },
      card: {
        messageId: 'om_reopened_verified_absent_old',
        state: 'initial',
        choice: '',
        rejectionReasonDraft: '',
        actionEventId: '',
        actorOpenId: '',
        processedAt: '',
      },
    });
    expect(resolved.notification.deliveryUuid).not.toBe(oldDeliveryUuid);
    await expect(
      store.listNotifications({
        kind: 'manager_approval_attention_required',
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'completed' })]);

    const next = await store.takeNextManagerApprovalNotification(
      new Date('2026-07-31T23:01:00.000Z'),
    );
    expect(next).toMatchObject({
      key: fixture.notification.key,
      deliveryGeneration: 2,
      messageId: 'om_reopened_verified_absent_old',
    });
    await store.markManagerApprovalSendStarted(
      next?.key || '',
      next?.claimToken || '',
      next?.cardContext || '',
      new Date('2026-07-31T23:01:01.000Z'),
    );
    await store.replaceManagerApprovalCardMessage(
      next?.key || '',
      next?.claimToken || '',
      {
        oldMessageId: 'om_reopened_verified_absent_old',
        newMessageId: 'om_reopened_verified_absent_new',
      },
      new Date('2026-07-31T23:01:02.000Z'),
    );
    await expect(
      store.findManagerApprovalCard(
        'om_reopened_verified_absent_new',
        'manager-one',
      ),
    ).resolves.toMatchObject({
      state: 'initial',
      supersededMessageIds: ['om_reopened_verified_absent_old'],
    });
    await expect(
      store.claimManagerApprovalAction(
        {
          eventId: 'reopened-verified-absent-clickable-event',
          recordId: 'reopened_verified_absent_1',
          choice: 'comprehensive',
          messageId: 'om_reopened_verified_absent_new',
          actorOpenId: 'manager-one',
        },
        new Date('2026-07-31T23:01:03.000Z'),
      ),
    ).resolves.toMatchObject({
      claimed: true,
      card: { state: 'pending' },
    });
  });

  it('creates a new attention notification for every manual reopened delivery generation', async () => {
    const store = createV2Store(ledgerPath);
    const fixture = await createManualReopenedManagerDelivery(store, {
      recordId: 'reopened_attention_generation_1',
      oldMessageId: 'om_reopened_attention_generation_old',
      eventId: 'reopened-attention-generation-event-1',
      choice: 'comprehensive',
      startedAt: new Date('2026-08-01T02:00:00.000Z'),
    });
    await store.resolveUnknownManagerApprovalDelivery(
      fixture.notification.key,
      {
        resolution: 'verified_absent',
        operatorOpenId: 'operator-one',
      },
      new Date('2026-08-01T03:01:00.000Z'),
    );
    const secondGeneration = await store.takeNextManagerApprovalNotification(
      new Date('2026-08-01T03:01:00.000Z'),
      1_000,
    );
    await store.markManagerApprovalSendStarted(
      secondGeneration?.key || '',
      secondGeneration?.claimToken || '',
      secondGeneration?.cardContext || '',
      new Date('2026-08-01T03:01:00.500Z'),
    );

    await expect(
      store.takeNextManagerApprovalNotification(
        new Date('2026-08-01T04:01:02.000Z'),
      ),
    ).resolves.toMatchObject({
      deliveryGeneration: 2,
      status: 'manual_reconciliation',
    });
    await expect(
      store.listNotifications({
        kind: 'manager_approval_attention_required',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        businessEventId:
          'manager_approval_attention_required:reopened-attention-generation-event-1:1',
        status: 'completed',
      }),
      expect.objectContaining({
        businessEventId:
          'manager_approval_attention_required:reopened-attention-generation-event-1:2',
        status: 'pending',
      }),
    ]);
  });

  it('binds a unique manually reconciled reopened replacement from its first callback', async () => {
    const store = createV2Store(ledgerPath);
    const fixture = await createManualReopenedManagerDelivery(store, {
      recordId: 'reopened_callback_bound_1',
      oldMessageId: 'om_reopened_callback_bound_old',
      eventId: 'reopened-callback-bound-event-1',
      choice: 'building_self',
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const bound = await store.bindUnknownManagerApprovalDeliveryFromCallback(
      {
        recordId: 'reopened_callback_bound_1',
        messageId: 'om_reopened_callback_bound_new',
        actorOpenId: 'manager-one',
      },
      new Date('2026-08-01T01:01:00.000Z'),
    );

    expect(bound).toMatchObject({
      bound: true,
      notification: {
        key: fixture.notification.key,
        kind: 'manager_approval_reopened',
        status: 'completed',
        sendOutcome: 'delivered',
        messageId: 'om_reopened_callback_bound_new',
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'callback_bound',
            operatorOpenId: 'manager-one',
          }),
        ]),
      },
      card: {
        messageId: 'om_reopened_callback_bound_new',
        supersededMessageIds: ['om_reopened_callback_bound_old'],
        state: 'initial',
      },
    });
    await expect(
      store.findManagerApprovalCard(
        'om_reopened_callback_bound_old',
        'manager-one',
      ),
    ).resolves.toBeNull();
    await expect(
      store.findManagerApprovalCard(
        'om_reopened_callback_bound_new',
        'manager-one',
      ),
    ).resolves.toMatchObject({ state: 'initial' });
  });
});
