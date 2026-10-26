import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  serializePurchaseManagerBatchApprovalCardContext,
  type PurchaseManagerBatchApprovalCardInput,
} from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';

const cardInput: PurchaseManagerBatchApprovalCardInput = {
  version: 3,
  approvalBatchId: 'purchase-application-task-1',
  requesterName: '申请人',
  requesterOpenId: 'ou_requester',
  building: 'H楼',
  requestCode: 'CG260908-001',
  expectedDeliveryAt: '2026-09-20',
  createdAt: '2026-09-08 10:00',
  items: [
    {
      executionRecordId: 'rec-1',
      title: '门牌',
      specification: '/',
      quantity: '1',
      unit: '套',
      amount: '10',
      status: 'pending',
      choice: '',
      rejectionReason: '',
    },
    {
      executionRecordId: 'rec-2',
      title: '标签纸',
      specification: 'A4',
      quantity: '2',
      unit: '包',
      amount: '20',
      status: 'pending',
      choice: '',
      rejectionReason: '',
    },
  ],
};

describe('purchase manager batch approval store', () => {
  const now = new Date('2026-09-08T02:00:00.000Z');
  let directory = '';
  let ledgerPath = '';
  let store: PurchaseWorkflowStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'purchase-manager-batch-'));
    ledgerPath = join(directory, 'purchase-workflow-ledger.json');
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists one idempotent batch and rejects conflicting reuse', async () => {
    const input = {
      approvalBatchId: cardInput.approvalBatchId,
      recipientOpenId: 'ou_manager',
      requesterOpenId: cardInput.requesterOpenId,
      recordIds: cardInput.items.map((item) => item.executionRecordId),
    };

    expect((await store.registerManagerApprovalBatch(input, now)).created).toBe(
      true,
    );
    expect((await store.registerManagerApprovalBatch(input, now)).created).toBe(
      false,
    );
    await expect(
      store.registerManagerApprovalBatch(
        { ...input, recordIds: ['rec-3'] },
        now,
      ),
    ).rejects.toThrow('采购审批批次内容冲突');

    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();
    expect(
      await store.findManagerApprovalBatch(cardInput.approvalBatchId),
    ).toMatchObject({
      approvalBatchId: cardInput.approvalBatchId,
      recordIds: ['rec-1', 'rec-2'],
      state: 'awaiting_delivery',
    });
  });

  it('reuses an exact record set across batch ids and rejects partial overlap', async () => {
    const first = await store.registerManagerApprovalBatch(
      {
        approvalBatchId: 'purchase-application-task-1',
        recipientOpenId: 'ou_manager',
        requesterOpenId: 'ou_requester',
        recordIds: ['rec-1', 'rec-2'],
      },
      now,
    );

    const exactRetry = await store.registerManagerApprovalBatch(
      {
        approvalBatchId: 'purchase-base-different-id',
        recipientOpenId: 'ou_manager',
        requesterOpenId: 'ou_requester',
        recordIds: ['rec-2', 'rec-1'],
      },
      now,
    );
    expect(exactRetry).toEqual({ created: false, batch: first.batch });

    await expect(
      store.registerManagerApprovalBatch(
        {
          approvalBatchId: 'purchase-base-overlap',
          recipientOpenId: 'ou_manager',
          requesterOpenId: 'ou_requester',
          recordIds: ['rec-2', 'rec-3'],
        },
        now,
      ),
    ).rejects.toThrow();
    expect(await store.listManagerApprovalBatchIds()).toEqual([
      'purchase-application-task-1',
    ]);
  });

  it('binds one delivered card and atomically claims pending items once', async () => {
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: cardInput.approvalBatchId,
        recipientOpenId: 'ou_manager',
        requesterOpenId: cardInput.requesterOpenId,
        recordIds: cardInput.items.map((item) => item.executionRecordId),
      },
      now,
    );
    const notification = await store.takeNextManagerApprovalNotification(
      new Date('2026-09-08T02:00:00.000Z'),
    );
    expect(notification?.kind).toBe('manager_batch_approval_requested');
    const context = serializePurchaseManagerBatchApprovalCardContext(cardInput);
    await store.markManagerApprovalBatchSendStarted(
      notification!.key,
      notification!.claimToken,
      context,
      new Date('2026-09-08T02:00:00.000Z'),
    );
    await store.completeManagerApprovalBatchRequestAndRegisterCard(
      notification!.key,
      notification!.claimToken,
      { messageId: 'om_batch_1' },
      new Date('2026-09-08T02:00:01.000Z'),
    );

    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.claimManagerApprovalBatchPendingApproval({
          eventId: `event-${index}`,
          approvalBatchId: cardInput.approvalBatchId,
          choice: 'comprehensive',
          messageId: 'om_batch_1',
          actorOpenId: 'ou_manager',
        }),
      ),
    );

    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.find((claim) => claim.claimed)?.entry?.recordIds).toEqual([
      'rec-1',
      'rec-2',
    ]);
    const persisted = await store.findManagerApprovalBatch(
      cardInput.approvalBatchId,
    );
    expect(persisted?.items.map((item) => item.status)).toEqual([
      'processing',
      'processing',
    ]);
  });

  it('rejects a forged H-building self-purchase approval before creating an action', async () => {
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: cardInput.approvalBatchId,
        recipientOpenId: 'ou_manager',
        requesterOpenId: cardInput.requesterOpenId,
        recordIds: cardInput.items.map((item) => item.executionRecordId),
      },
      now,
    );
    const notification = await store.takeNextManagerApprovalNotification(now);
    const context = serializePurchaseManagerBatchApprovalCardContext(cardInput);
    await store.markManagerApprovalBatchSendStarted(
      notification!.key,
      notification!.claimToken,
      context,
      now,
    );
    await store.completeManagerApprovalBatchRequestAndRegisterCard(
      notification!.key,
      notification!.claimToken,
      { messageId: 'om_batch_h_building' },
      now,
    );

    await expect(
      store.claimManagerApprovalBatchPendingApproval({
        eventId: 'event-h-building-self-purchase',
        approvalBatchId: cardInput.approvalBatchId,
        choice: 'building_self',
        messageId: 'om_batch_h_building',
        actorOpenId: 'ou_manager',
      }),
    ).rejects.toThrow('H楼仅支持综合采购');
    expect(await store.takeNextManagerApprovalBatchAction(now)).toBeNull();
  });

  it('binds an initially delivered batch card after the send result became unknown', async () => {
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: cardInput.approvalBatchId,
        recipientOpenId: 'ou_manager',
        requesterOpenId: cardInput.requesterOpenId,
        recordIds: cardInput.items.map((item) => item.executionRecordId),
      },
      now,
    );
    const notification = await store.takeNextManagerApprovalNotification(now);
    const context = serializePurchaseManagerBatchApprovalCardContext(cardInput);
    await store.markManagerApprovalBatchSendStarted(
      notification!.key,
      notification!.claimToken,
      context,
      now,
    );

    expect(
      await store.takeNextManagerApprovalNotification(
        new Date('2026-09-08T03:01:00.000Z'),
      ),
    ).toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });

    const bound =
      await store.bindUnknownManagerApprovalBatchDeliveryFromCallback(
        {
          approvalBatchId: cardInput.approvalBatchId,
          messageId: 'om_batch_recovered',
          actorOpenId: 'ou_manager',
        },
        new Date('2026-09-08T03:02:00.000Z'),
      );

    expect(bound.bound).toBe(true);
    expect(bound.batch).toMatchObject({
      state: 'active',
      messageId: 'om_batch_recovered',
      cardContext: context,
    });
    expect(bound.notification).toMatchObject({
      status: 'completed',
      sendOutcome: 'delivered',
      messageId: 'om_batch_recovered',
    });
  });

  it('persists purchaser snapshots and enqueues one grouped purchaser notification', async () => {
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: cardInput.approvalBatchId,
        recipientOpenId: 'ou_manager',
        requesterOpenId: cardInput.requesterOpenId,
        recordIds: cardInput.items.map((item) => item.executionRecordId),
      },
      now,
    );
    const notification = await store.takeNextManagerApprovalNotification(now);
    const context = serializePurchaseManagerBatchApprovalCardContext(cardInput);
    await store.markManagerApprovalBatchSendStarted(
      notification!.key,
      notification!.claimToken,
      context,
      now,
    );
    await store.completeManagerApprovalBatchRequestAndRegisterCard(
      notification!.key,
      notification!.claimToken,
      { messageId: 'om_batch_1' },
      now,
    );
    const claim = await store.claimManagerApprovalBatchPendingApproval(
      {
        eventId: 'event-approve-all',
        approvalBatchId: cardInput.approvalBatchId,
        choice: 'comprehensive',
        messageId: 'om_batch_1',
        actorOpenId: 'ou_manager',
      },
      now,
    );
    const action = await store.takeNextManagerApprovalBatchAction(now);
    for (const [index, recordId] of action!.recordIds.entries()) {
      const settled = await store.completeManagerApprovalBatchActionRecord(
        action!.key,
        action!.claimToken,
        recordId,
        {
          purchaserOpenId: 'ou_purchase_admin',
          purchaserName: '采购管理员',
        },
        now,
      );
      if (index === 0) {
        expect(settled.action).toMatchObject({
          status: 'processing',
          attempts: 0,
          claimToken: action!.claimToken,
        });
      }
    }

    expect(claim.claimed).toBe(true);
    const batch = await store.findManagerApprovalBatch(
      cardInput.approvalBatchId,
    );
    expect(batch?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purchaserOpenId: 'ou_purchase_admin',
          purchaserName: '采购管理员',
        }),
      ]),
    );
    const grouped = await store.listNotifications({
      kind: 'manager_batch_purchase_assigned',
    });
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      recipientOpenId: 'ou_purchase_admin',
      recordId: 'rec-1',
    });
  });

  it('binds fulfillment actions to the delivered card and claims a repeated command once', async () => {
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: cardInput.approvalBatchId,
        recipientOpenId: 'ou_manager',
        requesterOpenId: cardInput.requesterOpenId,
        recordIds: cardInput.items.map((item) => item.executionRecordId),
      },
      now,
    );
    let notification = await store.takeNextManagerApprovalNotification(now);
    const context = serializePurchaseManagerBatchApprovalCardContext(cardInput);
    await store.markManagerApprovalBatchSendStarted(
      notification!.key,
      notification!.claimToken,
      context,
      now,
    );
    await store.completeManagerApprovalBatchRequestAndRegisterCard(
      notification!.key,
      notification!.claimToken,
      { messageId: 'om_batch_1' },
      now,
    );
    await store.claimManagerApprovalBatchPendingApproval(
      {
        eventId: 'event-approve-all',
        approvalBatchId: cardInput.approvalBatchId,
        choice: 'comprehensive',
        messageId: 'om_batch_1',
        actorOpenId: 'ou_manager',
      },
      now,
    );
    const action = await store.takeNextManagerApprovalBatchAction(now);
    for (const recordId of action!.recordIds) {
      await store.completeManagerApprovalBatchActionRecord(
        action!.key,
        action!.claimToken,
        recordId,
        {
          purchaserOpenId: 'ou_purchase_admin',
          purchaserName: '采购管理员',
        },
        now,
      );
    }

    for (;;) {
      notification = await store.takeNextManagerApprovalNotification(now);
      expect(notification).not.toBeNull();
      if (notification!.kind === 'manager_batch_purchase_assigned') break;
      await store.completeNotification(
        notification!.key,
        notification!.claimToken,
        { messageId: notification!.messageId || 'om_result_1' },
        now,
      );
    }
    const resolvedContext = (await store.findManagerApprovalBatch(
      cardInput.approvalBatchId,
    ))!.cardContext;
    await store.markManagerApprovalBatchSendStarted(
      notification!.key,
      notification!.claimToken,
      resolvedContext,
      now,
    );
    await store.completeNotification(
      notification!.key,
      notification!.claimToken,
      { messageId: 'om_assignment_1' },
      now,
    );
    const identity = {
      approvalBatchId: cardInput.approvalBatchId,
      messageId: 'om_assignment_1',
      actorOpenId: 'ou_purchase_admin',
      role: 'purchaser' as const,
    };
    const command = {
      version: 4 as const,
      workflowType: 'purchase_batch_fulfillment' as const,
      action: 'order' as const,
      approvalBatchId: cardInput.approvalBatchId,
      executionRecordId: 'rec-1',
      actorOpenId: 'ou_purchase_admin',
      actualQuantity: 1,
      actualAmount: 9.9,
      note: '',
      paymentAttachmentTokens: [],
    };

    await expect(
      store.claimPurchaseBatchFulfillmentCommand(
        identity,
        command,
        'fulfillment-event-1',
        now,
      ),
    ).resolves.toMatchObject({ claimed: true, fulfillmentNotifications: expect.arrayContaining([expect.objectContaining({ kind: 'manager_batch_order_command', status: 'pending' })]) });
    await expect(
      store.claimPurchaseBatchFulfillmentCommand(
        identity,
        command,
        'fulfillment-event-1',
        now,
      ),
    ).resolves.toMatchObject({ claimed: false });
    const claimedCommand = await store.takeNextManagerApprovalNotification(now);
    expect(claimedCommand).toMatchObject({
      kind: 'manager_batch_order_command',
      status: 'processing',
    });
    await store.failPurchaseBatchFulfillmentCommandAndEnqueueRefresh(
      claimedCommand!.key,
      claimedCommand!.claimToken,
      new Error('external write failed'),
      {
        businessEventId: 'manager_batch_purchase_refresh:failed:1',
        recordId: 'rec-1',
        recipientOpenId: 'ou_purchase_admin',
        kind: 'manager_batch_purchase_refresh',
        cardContext: resolvedContext,
      },
      now,
    );
    await expect(
      store.claimPurchaseBatchFulfillmentCommand(
        identity,
        command,
        'fulfillment-event-2',
        now,
      ),
    ).resolves.toMatchObject({ claimed: true });
    await expect(
      store.getPurchaseBatchForFulfillmentCard({
        ...identity,
        actorOpenId: 'ou_other',
      }),
    ).rejects.toThrow('采购履约卡片消息映射不存在');
  });

  it('persists a receipt upload intent and consumes one requester image idempotently', async () => {
    const approvalBatchId = 'purchase-application-image-1';
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId,
        recipientOpenId: 'ou_manager',
        requesterOpenId: 'ou_requester',
        recordIds: ['rec-image-1'],
      },
      now,
    );
    let notification = await store.takeNextManagerApprovalNotification(now);
    const context = serializePurchaseManagerBatchApprovalCardContext({
      ...cardInput,
      approvalBatchId,
      items: [{ ...cardInput.items[0]!, executionRecordId: 'rec-image-1' }],
    });
    await store.markManagerApprovalBatchSendStarted(
      notification!.key,
      notification!.claimToken,
      context,
      now,
    );
    await store.completeManagerApprovalBatchRequestAndRegisterCard(
      notification!.key,
      notification!.claimToken,
      { messageId: 'om_manager_image_1' },
      now,
    );
    await store.claimManagerApprovalBatchPendingApproval(
      {
        eventId: 'evt-approve-image-1',
        approvalBatchId,
        choice: 'comprehensive',
        messageId: 'om_manager_image_1',
        actorOpenId: 'ou_manager',
      },
      now,
    );
    const action = await store.takeNextManagerApprovalBatchAction(now);
    await store.completeManagerApprovalBatchActionRecord(
      action!.key,
      action!.claimToken,
      'rec-image-1',
      { purchaserOpenId: 'ou_purchaser', purchaserName: '采购人' },
      now,
    );
    const resolved = (await store.findManagerApprovalBatch(approvalBatchId))!;
    await store.enqueueNotification(
      {
        businessEventId: `manager_batch_receipt_requested:${approvalBatchId}`,
        recordId: 'rec-image-1',
        recipientOpenId: 'ou_requester',
        kind: 'manager_batch_receipt_requested',
        cardContext: resolved.cardContext,
      },
      now,
    );
    for (;;) {
      notification = await store.takeNextManagerApprovalNotification(now);
      expect(notification).not.toBeNull();
      await store.completeNotification(
        notification!.key,
        notification!.claimToken,
        {
          messageId:
            notification!.kind === 'manager_batch_receipt_requested'
              ? 'om_receipt_image_1'
              : `om_${notification!.kind}`,
        },
        now,
      );
      if (notification!.kind === 'manager_batch_receipt_requested') break;
    }

    await store.preparePurchaseBatchReceiptUpload(
      {
        approvalBatchId,
        messageId: 'om_receipt_image_1',
        actorOpenId: 'ou_requester',
        role: 'requester',
      },
      { executionRecordId: 'rec-image-1', materialType: 'receipt_photo' },
      now,
    );
    expect(await store.findManagerApprovalBatch(approvalBatchId)).toMatchObject(
      {
        pendingReceiptUpload: {
          executionRecordId: 'rec-image-1',
          materialType: 'receipt_photo',
        },
      },
    );

    const first = await store.acceptPurchaseReceiptImageMessage(
      {
        eventId: 'evt-image-1',
        actorOpenId: 'ou_requester',
        messageId: 'om_image_1',
        chatId: 'oc_direct_1',
        imageKey: 'img_v3_image_1',
      },
      now,
    );
    const replay = await store.acceptPurchaseReceiptImageMessage(
      {
        eventId: 'evt-image-1',
        actorOpenId: 'ou_requester',
        messageId: 'om_image_1',
        chatId: 'oc_direct_1',
        imageKey: 'img_v3_image_1',
      },
      now,
    );
    expect(first).toMatchObject({ accepted: true, enqueued: true });
    expect(replay).toMatchObject({ accepted: true, enqueued: false });
    expect(first.notification).toMatchObject({
      kind: 'manager_batch_receipt_attachment',
      recordId: 'rec-image-1',
    });
    expect(
      (await store.findManagerApprovalBatch(approvalBatchId))
        ?.pendingReceiptUpload,
    ).toBeUndefined();
  });
});
