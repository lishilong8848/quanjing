import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parsePurchaseManagerApprovalReconciliationArgs,
  runPurchaseManagerApprovalDeliveryReconciliation,
} from '../../server/scripts/reconcile-purchase-manager-approval-delivery';
import { serializePurchaseManagerApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';

interface ManualDeliveryFixture {
  directory: string;
  ledgerPath: string;
  notificationKey: string;
  recordId: string;
  recipientOpenId: string;
}

interface ManualReopenedDeliveryFixture extends ManualDeliveryFixture {
  oldMessageId: string;
  actionEventId: string;
  choice: 'comprehensive' | 'reject';
  rejectionReason: string;
}

describe('purchase manager approval delivery reconciliation CLI', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts only the two explicit reconciliation modes', () => {
    expect(
      parsePurchaseManagerApprovalReconciliationArgs([
        'verified-delivered',
        '--notification-key',
        'manager-approval-requested:rec_1:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--message-id',
        'om_manager_message_1',
      ]),
    ).toEqual({
      mode: 'verified-delivered',
      notificationKey: 'manager-approval-requested:rec_1:rec_1:ou_operator_1',
      operatorOpenId: 'ou_operator_1',
      messageId: 'om_manager_message_1',
    });

    expect(
      parsePurchaseManagerApprovalReconciliationArgs([
        'verified-absent',
        '--notification-key',
        'manager-approval-requested:rec_1:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--confirm-new-generation',
      ]),
    ).toEqual({
      mode: 'verified-absent',
      notificationKey: 'manager-approval-requested:rec_1:rec_1:ou_operator_1',
      operatorOpenId: 'ou_operator_1',
    });
  });

  it.each([
    [
      'unknown mode',
      [
        'resend',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
      ],
    ],
    [
      'missing notification key',
      ['verified-absent', '--operator-open-id', 'ou_operator_1'],
    ],
    [
      'invalid operator',
      [
        'verified-absent',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'operator_1',
        '--confirm-new-generation',
      ],
    ],
    [
      'delivered without message id',
      [
        'verified-delivered',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
      ],
    ],
    [
      'delivered with an invalid message id',
      [
        'verified-delivered',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--message-id',
        '../message',
      ],
    ],
    [
      'absent without explicit generation confirmation',
      [
        'verified-absent',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
      ],
    ],
    [
      'absent with a message id',
      [
        'verified-absent',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--message-id',
        'om_message_1',
        '--confirm-new-generation',
      ],
    ],
    [
      'unknown option',
      [
        'verified-absent',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--confirm-new-generation',
        '--force',
      ],
    ],
    [
      'repeated notification key',
      [
        'verified-absent',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--notification-key',
        'manager:rec_2:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--confirm-new-generation',
      ],
    ],
    [
      'flag used as another option value',
      [
        'verified-absent',
        '--notification-key',
        '--operator-open-id',
        'ou_operator_1',
        '--confirm-new-generation',
      ],
    ],
    [
      'trailing positional argument',
      [
        'verified-absent',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--confirm-new-generation',
        'unexpected',
      ],
    ],
  ])('rejects %s', (_label, argv) => {
    expect(() =>
      parsePurchaseManagerApprovalReconciliationArgs(argv),
    ).toThrow();
  });

  it('atomically binds a verified delivered message through the normal store', async () => {
    const fixture = await createManualDeliveryFixture(directories);
    const output: string[] = [];

    await expect(
      runPurchaseManagerApprovalDeliveryReconciliation(
        [
          'verified-delivered',
          '--notification-key',
          fixture.notificationKey,
          '--operator-open-id',
          fixture.recipientOpenId,
          '--message-id',
          'om_verified_manager_card_1',
        ],
        {
          ledgerPath: fixture.ledgerPath,
          writeLine: (line) => output.push(line),
        },
      ),
    ).resolves.toEqual({
      mode: 'verified-delivered',
      status: 'completed',
      deliveryGeneration: 1,
    });

    const store = new PurchaseWorkflowStore(fixture.ledgerPath);
    await store.onModuleInit();
    try {
      await expect(
        store.getNotification(fixture.notificationKey),
      ).resolves.toMatchObject({
        status: 'completed',
        sendOutcome: 'delivered',
        messageId: 'om_verified_manager_card_1',
        deliveryGeneration: 1,
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'operator_verified_delivered',
            operatorOpenId: fixture.recipientOpenId,
          }),
        ]),
      });
      await expect(
        store.findManagerApprovalCard(
          'om_verified_manager_card_1',
          fixture.recipientOpenId,
        ),
      ).resolves.toMatchObject({
        executionRecordId: fixture.recordId,
        state: 'initial',
      });
    } finally {
      await store.onModuleDestroy();
    }

    expect(output.join('\n')).not.toContain('om_verified_manager_card_1');
    expect(output.join('\n')).not.toContain('只用于确认不会泄露的卡片上下文');
    expect(output.join('\n')).not.toContain(fixture.notificationKey);
  });

  it('creates a controlled new delivery generation only after verified absence', async () => {
    const fixture = await createManualDeliveryFixture(directories);
    const output: string[] = [];
    const beforeStore = new PurchaseWorkflowStore(fixture.ledgerPath);
    await beforeStore.onModuleInit();
    const before = await beforeStore.getNotification(fixture.notificationKey);
    await beforeStore.onModuleDestroy();

    await expect(
      runPurchaseManagerApprovalDeliveryReconciliation(
        [
          'verified-absent',
          '--notification-key',
          fixture.notificationKey,
          '--operator-open-id',
          fixture.recipientOpenId,
          '--confirm-new-generation',
        ],
        {
          ledgerPath: fixture.ledgerPath,
          writeLine: (line) => output.push(line),
        },
      ),
    ).resolves.toEqual({
      mode: 'verified-absent',
      status: 'pending',
      deliveryGeneration: 2,
    });

    const afterStore = new PurchaseWorkflowStore(fixture.ledgerPath);
    await afterStore.onModuleInit();
    try {
      await expect(
        afterStore.getNotification(fixture.notificationKey),
      ).resolves.toMatchObject({
        status: 'pending',
        sendOutcome: 'unattempted',
        messageId: '',
        attempts: 0,
        deliveryGeneration: 2,
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'operator_verified_absent',
            operatorOpenId: fixture.recipientOpenId,
          }),
        ]),
      });
      const after = await afterStore.getNotification(fixture.notificationKey);
      expect(after?.deliveryUuid).not.toBe(before?.deliveryUuid);
      expect(after?.deliveryAudit).toEqual(
        expect.arrayContaining(before?.deliveryAudit || []),
      );
    } finally {
      await afterStore.onModuleDestroy();
    }
    expect(output.join('\n')).not.toContain(fixture.notificationKey);
    expect(output.join('\n')).not.toContain('只用于确认不会泄露的卡片上下文');
  });

  it('closes a reopened replacement reconciliation as delivered and leaves the new reject card clickable', async () => {
    const fixture = await createManualReopenedDeliveryFixture(
      directories,
      'reject',
    );

    await expect(
      runPurchaseManagerApprovalDeliveryReconciliation(
        [
          'verified-delivered',
          '--notification-key',
          fixture.notificationKey,
          '--operator-open-id',
          fixture.recipientOpenId,
          '--message-id',
          'om_cli_reopened_delivered_new',
        ],
        { ledgerPath: fixture.ledgerPath, writeLine: jest.fn() },
      ),
    ).resolves.toEqual({
      mode: 'verified-delivered',
      status: 'completed',
      deliveryGeneration: 1,
    });

    const store = new PurchaseWorkflowStore(fixture.ledgerPath);
    await store.onModuleInit();
    try {
      await expect(
        store.getNotification(fixture.notificationKey),
      ).resolves.toMatchObject({
        kind: 'manager_approval_reopened',
        status: 'completed',
        sendOutcome: 'delivered',
        messageId: 'om_cli_reopened_delivered_new',
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'operator_verified_delivered',
            operatorOpenId: fixture.recipientOpenId,
          }),
        ]),
      });
      await expect(
        store.findManagerApprovalCard(
          fixture.oldMessageId,
          fixture.recipientOpenId,
        ),
      ).resolves.toBeNull();
      await expect(
        store.findManagerApprovalCard(
          'om_cli_reopened_delivered_new',
          fixture.recipientOpenId,
        ),
      ).resolves.toMatchObject({
        state: 'reject_editing',
        rejectionReasonDraft: fixture.rejectionReason,
        supersededMessageIds: [fixture.oldMessageId],
      });
      await expect(
        store.listNotifications({
          kind: 'manager_approval_attention_required',
        }),
      ).resolves.toEqual([expect.objectContaining({ status: 'completed' })]);
      await expect(
        store.claimManagerApprovalAction({
          eventId: 'cli-reopened-delivered-clickable-event',
          recordId: fixture.recordId,
          choice: 'reject',
          rejectionReason: fixture.rejectionReason,
          messageId: 'om_cli_reopened_delivered_new',
          actorOpenId: fixture.recipientOpenId,
        }),
      ).resolves.toMatchObject({
        claimed: true,
        card: { state: 'pending' },
      });
    } finally {
      await store.onModuleDestroy();
    }
  });

  it('closes a reopened replacement reconciliation as absent and allows the next generation to bind a clickable card', async () => {
    const fixture = await createManualReopenedDeliveryFixture(
      directories,
      'comprehensive',
    );

    await expect(
      runPurchaseManagerApprovalDeliveryReconciliation(
        [
          'verified-absent',
          '--notification-key',
          fixture.notificationKey,
          '--operator-open-id',
          fixture.recipientOpenId,
          '--confirm-new-generation',
        ],
        { ledgerPath: fixture.ledgerPath, writeLine: jest.fn() },
      ),
    ).resolves.toEqual({
      mode: 'verified-absent',
      status: 'pending',
      deliveryGeneration: 2,
    });

    const store = new PurchaseWorkflowStore(fixture.ledgerPath);
    await store.onModuleInit();
    try {
      await expect(
        store.getNotification(fixture.notificationKey),
      ).resolves.toMatchObject({
        kind: 'manager_approval_reopened',
        status: 'pending',
        attempts: 0,
        sendOutcome: 'unattempted',
        deliveryGeneration: 2,
        messageId: fixture.oldMessageId,
        deliveryAudit: expect.arrayContaining([
          expect.objectContaining({
            action: 'operator_verified_absent',
            operatorOpenId: fixture.recipientOpenId,
          }),
        ]),
      });
      await expect(
        store.findManagerApprovalCard(
          fixture.oldMessageId,
          fixture.recipientOpenId,
        ),
      ).resolves.toMatchObject({
        state: 'initial',
        choice: '',
        actionEventId: '',
      });
      const notification = await store.takeNextManagerApprovalNotification(
        new Date('2030-01-01T00:00:00.000Z'),
      );
      await store.markManagerApprovalSendStarted(
        notification?.key || '',
        notification?.claimToken || '',
        notification?.cardContext || '',
        new Date('2030-01-01T00:00:01.000Z'),
      );
      await store.replaceManagerApprovalCardMessage(
        notification?.key || '',
        notification?.claimToken || '',
        {
          oldMessageId: fixture.oldMessageId,
          newMessageId: 'om_cli_reopened_absent_new',
        },
        new Date('2030-01-01T00:00:02.000Z'),
      );
      await expect(
        store.findManagerApprovalCard(
          'om_cli_reopened_absent_new',
          fixture.recipientOpenId,
        ),
      ).resolves.toMatchObject({
        state: 'initial',
        supersededMessageIds: [fixture.oldMessageId],
      });
      await expect(
        store.claimManagerApprovalAction({
          eventId: 'cli-reopened-absent-clickable-event',
          recordId: fixture.recordId,
          choice: 'comprehensive',
          messageId: 'om_cli_reopened_absent_new',
          actorOpenId: fixture.recipientOpenId,
        }),
      ).resolves.toMatchObject({
        claimed: true,
        card: { state: 'pending' },
      });
    } finally {
      await store.onModuleDestroy();
    }
  });

  it('refuses to edit a ledger held by a live process', async () => {
    const directory = join(
      tmpdir(),
      `purchase-manager-reconcile-lock-${process.pid}-${Date.now()}`,
    );
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const ledgerPath = join(directory, 'ledger.json');
    writeFileSync(
      `${ledgerPath}.lock`,
      `${JSON.stringify({
        pid: process.pid,
        instanceId: 'another-live-service-instance',
      })}\n`,
      'utf8',
    );
    const lockBefore = readFileSync(`${ledgerPath}.lock`);

    await expect(
      runPurchaseManagerApprovalDeliveryReconciliation(
        [
          'verified-absent',
          '--notification-key',
          'manager:rec_1:ou_operator_1',
          '--operator-open-id',
          'ou_operator_1',
          '--confirm-new-generation',
        ],
        { ledgerPath, writeLine: jest.fn() },
      ),
    ).rejects.toThrow();
    expect(readFileSync(`${ledgerPath}.lock`)).toEqual(lockBefore);
    expect(existsSync(ledgerPath)).toBe(false);
  }, 10_000);

  it('runs the real main entrypoint with a zero exit code and redacted output', async () => {
    const fixture = await createManualDeliveryFixture(directories);
    const workspace = resolve(__dirname, '../..');
    const script = resolve(
      workspace,
      'server/scripts/reconcile-purchase-manager-approval-delivery.ts',
    );
    const child = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        script,
        'verified-delivered',
        '--notification-key',
        fixture.notificationKey,
        '--operator-open-id',
        fixture.recipientOpenId,
        '--message-id',
        'om_real_entrypoint_message_1',
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          TS_NODE_PROJECT: resolve(workspace, 'tsconfig.node.json'),
          PURCHASE_WORKFLOW_LEDGER_PATH: fixture.ledgerPath,
        },
        timeout: 30_000,
      },
    );

    expect({
      status: child.status,
      signal: child.signal,
      stderr: child.stderr,
    }).toEqual({ status: 0, signal: null, stderr: '' });
    expect(child.stdout).toContain('代际 1');
    expect(child.stdout).not.toContain(fixture.notificationKey);
    expect(child.stdout).not.toContain('om_real_entrypoint_message_1');
    expect(child.stdout).not.toContain('只用于确认不会泄露的卡片上下文');
  }, 35_000);

  it('returns a nonzero exit code with generic stderr from the real main entrypoint', () => {
    const workspace = resolve(__dirname, '../..');
    const script = resolve(
      workspace,
      'server/scripts/reconcile-purchase-manager-approval-delivery.ts',
    );
    const child = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        script,
        'verified-delivered',
        '--notification-key',
        'manager:rec_1:ou_operator_1',
        '--operator-open-id',
        'ou_operator_1',
        '--message-id',
        'private-token-must-not-be-echoed',
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          TS_NODE_PROJECT: resolve(workspace, 'tsconfig.node.json'),
        },
        timeout: 30_000,
      },
    );

    expect(child.status).toBe(1);
    expect(child.signal).toBeNull();
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain('采购经理审批卡送达对账失败');
    expect(child.stderr).not.toContain('private-token-must-not-be-echoed');
  }, 35_000);
});

async function createManualDeliveryFixture(
  directories: string[],
): Promise<ManualDeliveryFixture> {
  const directory = join(
    tmpdir(),
    `purchase-manager-reconcile-${process.pid}-${Date.now()}-${directories.length}`,
  );
  directories.push(directory);
  const ledgerPath = join(directory, 'ledger.json');
  const recordId = 'rec_manager_reconcile_1';
  const recipientOpenId = 'ou_manager_reconcile_1';
  const startedAt = new Date('2026-07-31T00:00:00.000Z');
  const store = new PurchaseWorkflowStore(ledgerPath);
  await store.onModuleInit();
  try {
    const queued = await store.enqueueNotification(
      {
        businessEventId: `manager-approval-requested:${recordId}`,
        recordId,
        recipientOpenId,
        kind: 'manager_approval_requested',
      },
      startedAt,
    );
    const claimed = await store.takeNextManagerApprovalNotification(startedAt);
    if (!claimed) throw new Error('manager notification was not claimed');
    const cardContext = serializePurchaseManagerApprovalCardContext({
      executionRecordId: recordId,
      requester: '只用于确认不会泄露的卡片上下文',
      building: 'H楼',
      title: '测试物品',
      quantity: 1,
      procurementForm: '三方比价',
    });
    await store.markManagerApprovalSendStarted(
      claimed.key,
      claimed.claimToken,
      cardContext,
      startedAt,
    );
    await store.rescheduleNotification(
      claimed.key,
      claimed.claimToken,
      new Error('send result unknown'),
      startedAt,
      startedAt,
    );
    await expect(
      store.takeNextManagerApprovalNotification(
        new Date(startedAt.getTime() + 60 * 60 * 1000 + 1),
      ),
    ).resolves.toMatchObject({
      key: queued.entry.key,
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    await expect(
      store.getNotification(queued.entry.key),
    ).resolves.toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    return {
      directory,
      ledgerPath,
      notificationKey: queued.entry.key,
      recordId,
      recipientOpenId,
    };
  } finally {
    await store.onModuleDestroy();
  }
}

async function createManualReopenedDeliveryFixture(
  directories: string[],
  choice: 'comprehensive' | 'reject',
): Promise<ManualReopenedDeliveryFixture> {
  const directory = join(
    tmpdir(),
    `purchase-manager-reopened-reconcile-${process.pid}-${Date.now()}-${directories.length}`,
  );
  directories.push(directory);
  const ledgerPath = join(directory, 'ledger.json');
  const recordId = `rec_manager_reopened_${choice}`;
  const recipientOpenId = 'ou_manager_reopened_1';
  const oldMessageId = `om_manager_reopened_${choice}_old`;
  const actionEventId = `manager-reopened-${choice}-event`;
  const rejectionReason = choice === 'reject' ? '缺少采购依据' : '';
  const startedAt = new Date('2026-07-31T02:00:00.000Z');
  const store = new PurchaseWorkflowStore(ledgerPath);
  await store.onModuleInit();
  try {
    const requested = await store.enqueueNotification(
      {
        businessEventId: `manager-approval-requested:${recordId}`,
        recordId,
        recipientOpenId,
        kind: 'manager_approval_requested',
      },
      startedAt,
    );
    const requestedClaim = await store.takeNextManagerApprovalNotification(
      new Date(startedAt.getTime() + 1_000),
    );
    if (!requestedClaim) {
      throw new Error('manager requested notification was not claimed');
    }
    const cardContext = serializePurchaseManagerApprovalCardContext({
      executionRecordId: recordId,
      requester: '仅用于核对不会泄露的卡片上下文',
      building: 'H楼',
      title: '测试物品',
      quantity: 1,
      procurementForm: '三方比价',
    });
    await store.markManagerApprovalSendStarted(
      requested.entry.key,
      requestedClaim.claimToken,
      cardContext,
      new Date(startedAt.getTime() + 1_000),
    );
    await store.completeManagerApprovalRequestAndRegisterCard(
      requested.entry.key,
      requestedClaim.claimToken,
      { messageId: oldMessageId },
      new Date(startedAt.getTime() + 2_000),
    );
    if (choice === 'reject') {
      await store.openManagerApprovalRejectEditor(
        {
          recordId,
          messageId: oldMessageId,
          actorOpenId: recipientOpenId,
        },
        new Date(startedAt.getTime() + 3_000),
      );
    }
    const accepted = await store.claimManagerApprovalAction(
      {
        eventId: actionEventId,
        recordId,
        choice,
        rejectionReason,
        messageId: oldMessageId,
        actorOpenId: recipientOpenId,
      },
      new Date(startedAt.getTime() + 4_000),
    );
    const action = await store.takeNextManagerApprovalAction(
      new Date(startedAt.getTime() + 5_000),
    );
    if (!accepted.entry || !action) {
      throw new Error('manager action was not claimed');
    }
    const reopened = await store.failManagerApprovalActionAndEnqueueReopen(
      accepted.entry.key,
      action.claimToken,
      new Error('confirmed no write'),
      new Date(startedAt.getTime() + 6_000),
    );
    const reopenedClaim = await store.takeNextManagerApprovalNotification(
      new Date(startedAt.getTime() + 7_000),
      1_000,
    );
    if (!reopenedClaim) {
      throw new Error('manager reopened notification was not claimed');
    }
    await store.markManagerApprovalSendStarted(
      reopenedClaim.key,
      reopenedClaim.claimToken,
      reopened.card.cardContext,
      new Date(startedAt.getTime() + 7_000),
    );
    await expect(
      store.takeNextManagerApprovalNotification(
        new Date(startedAt.getTime() + 60 * 60 * 1_000 + 8_000),
      ),
    ).resolves.toMatchObject({
      key: reopened.notification.key,
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    await expect(
      store.getNotification(reopened.notification.key),
    ).resolves.toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    return {
      directory,
      ledgerPath,
      notificationKey: reopened.notification.key,
      recordId,
      recipientOpenId,
      oldMessageId,
      actionEventId,
      choice,
      rejectionReason,
    };
  } finally {
    await store.onModuleDestroy();
  }
}
