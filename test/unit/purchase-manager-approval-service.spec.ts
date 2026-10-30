jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: jest.fn((name: string) => process.env[name] || ''),
}));

import { ConflictException } from '@nestjs/common';
import {
  parsePurchaseManagerApprovalCardContext,
  serializePurchaseManagerApprovalCardContext,
} from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import { serializePurchaseBatchFulfillmentCommandContext } from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';
import { PurchaseManagerApprovalService as ActualPurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
const PurchaseManagerApprovalService = withSyntheticBusinessIdentity(ActualPurchaseManagerApprovalService, 5);
type PurchaseManagerApprovalService = ActualPurchaseManagerApprovalService;
import type { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import type {
  PurchaseManagerApprovalActionEntry,
  PurchaseManagerApprovalCardEntry,
  PurchaseWorkflowNotificationEntry,
  PurchaseWorkflowStore,
} from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const originalEnv = { ...process.env };

type GatewayMock = {
  getExecutionRecordAsApp: jest.Mock;
  updateExecutionRecordAsApp: jest.Mock;
  resolvePurchaseAdminAsApp: jest.Mock;
  resolveBuildingSupervisorAsApp: jest.Mock;
  sendInteractiveCard: jest.Mock;
  updateInteractiveCard: jest.Mock;
};

type StoreMock = {
  enqueueNotification: jest.Mock;
  enqueueNotifications: jest.Mock;
  getManagerApprovalRecordState: jest.Mock;
  listNotifications: jest.Mock;
  getPurchaseBatchForFulfillmentCard: jest.Mock;
  findManagerApprovalBatch: jest.Mock;
  takeNextManagerApprovalNotification: jest.Mock;
  takeNextManagerApprovalAction: jest.Mock;
  takeNextPersonnelHandover: jest.Mock;
  takeNextPersonnelHandoverDelivery: jest.Mock;
  markManagerApprovalSendStarted: jest.Mock;
  completeManagerApprovalRequestAndRegisterCard: jest.Mock;
  rescheduleNotification: jest.Mock;
  failNotification: jest.Mock;
  completeNotification: jest.Mock;
  openManagerApprovalRejectEditor: jest.Mock;
  claimManagerApprovalAction: jest.Mock;
  bindUnknownManagerApprovalDeliveryFromCallback: jest.Mock;
  findManagerApprovalCard: jest.Mock;
  listManagerApprovalActions: jest.Mock;
  listManagerApprovalBatchActions: jest.Mock;
  rescheduleManagerApprovalAction: jest.Mock;
  completeManagerApprovalActionAndEnqueueResolved: jest.Mock;
  failManagerApprovalActionAndEnqueueReopen: jest.Mock;
  markManagerApprovalManualReconciliation: jest.Mock;
  replaceManagerApprovalCardMessage: jest.Mock;
};

function harness(): {
  service: PurchaseManagerApprovalService;
  gateway: GatewayMock;
  store: StoreMock;
} {
  const gateway: GatewayMock = {
    getExecutionRecordAsApp: jest.fn(),
    updateExecutionRecordAsApp: jest.fn(),
    resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
      openId: 'ou_purchase_admin',
      name: '采购管理员',
      positions: ['综合管理'],
      buildings: [],
    }),
    resolveBuildingSupervisorAsApp: jest.fn().mockResolvedValue({
      openId: 'ou_building_supervisor',
      name: '楼栋主管',
      positions: [],
      buildings: ['D楼'],
    }),
    sendInteractiveCard: jest.fn(),
    updateInteractiveCard: jest.fn(),
  };
  const store: StoreMock = {
    enqueueNotification: jest.fn(),
    enqueueNotifications: jest.fn(),
    getManagerApprovalRecordState: jest.fn().mockResolvedValue(null),
    listNotifications: jest.fn().mockResolvedValue([]),
    getPurchaseBatchForFulfillmentCard: jest.fn(),
    findManagerApprovalBatch: jest.fn(),
    takeNextManagerApprovalNotification: jest.fn().mockResolvedValue(null),
    takeNextManagerApprovalAction: jest.fn().mockResolvedValue(null),
    takeNextPersonnelHandover: jest.fn().mockResolvedValue(null),
    takeNextPersonnelHandoverDelivery: jest.fn().mockResolvedValue(null),
    markManagerApprovalSendStarted: jest.fn(),
    completeManagerApprovalRequestAndRegisterCard: jest.fn(),
    rescheduleNotification: jest.fn(),
    failNotification: jest.fn(),
    completeNotification: jest.fn(),
    openManagerApprovalRejectEditor: jest.fn(),
    claimManagerApprovalAction: jest.fn(),
    bindUnknownManagerApprovalDeliveryFromCallback: jest.fn(),
    findManagerApprovalCard: jest.fn(async () => {
      const persisted = (await store.listManagerApprovalActions())[0] as PurchaseManagerApprovalActionEntry | undefined;
      if (!persisted) return null;
      return card({ state: persisted.status === 'completed' ? 'resolved' : persisted.status === 'manual_reconciliation' ? 'manual_reconciliation' : persisted.status === 'failed' ? persisted.choice === 'reject' ? 'reject_editing' : 'initial' : 'pending',
        choice: persisted.status === 'failed' ? '' : persisted.choice, rejectionReasonDraft: persisted.rejectionReason,
        actionEventId: persisted.eventId, actorOpenId: persisted.actorOpenId, processedAt: persisted.completedAt });
    }),
    listManagerApprovalActions: jest.fn().mockResolvedValue([]),
    listManagerApprovalBatchActions: jest.fn().mockResolvedValue([]),
    rescheduleManagerApprovalAction: jest.fn(),
    completeManagerApprovalActionAndEnqueueResolved: jest.fn(),
    failManagerApprovalActionAndEnqueueReopen: jest.fn(),
    markManagerApprovalManualReconciliation: jest.fn(),
    replaceManagerApprovalCardMessage: jest.fn(),
  };
  return {
    service: new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store as unknown as PurchaseWorkflowStore,
    ),
    gateway,
    store,
  };
}

function record(
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId: 'rec_manager_1',
    requestCode: 'CG-001',
    status: '未开始（待审批）',
    itemName: '温湿度传感器',
    building: 'D楼',
    requesterOpenId: 'ou_requester',
    requesterName: '申请人',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '综合采购',
    procurementForm: '单一采购',
    singleReason: '原设备停产，仅原厂替代件兼容',
    rejectionReason: '',
    requestedQuantity: 2,
    unit: '台',
    unitPrice: 50,
    createdAt: Date.parse('2026-07-31T01:00:00.000Z'),
    actualQuantity: null,
    actualAmount: null,
    approvalCompleted: false,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    receiptConfirmed: false,
    signer: '',
    receiptTime: null,
    receiptPhotoTokens: [],
    invoiceTokens: [],
    expectedDeliveryDate: Date.parse('2026-08-10T00:00:00.000Z'),
    ...overrides,
  };
}

function cardContext(recordId = 'rec_manager_1'): string {
  return serializePurchaseManagerApprovalCardContext({
    executionRecordId: recordId,
    requester: '申请人',
    building: 'D楼',
    title: '温湿度传感器',
    quantity: 2,
    unit: '台',
    amount: 100,
    procurementForm: '单一采购',
    singleReason: '原设备停产，仅原厂替代件兼容',
    expectedDeliveryAt: Date.parse('2026-08-10T00:00:00.000Z'),
    requestCode: 'CG-001',
    createdAt: Date.parse('2026-07-31T01:00:00.000Z'),
  });
}

function notification(
  overrides: Partial<PurchaseWorkflowNotificationEntry> = {},
): PurchaseWorkflowNotificationEntry {
  return {
    key: 'manager-notification-key',
    businessEventId: 'manager_approval_requested:rec_manager_1',
    recordId: 'rec_manager_1',
    recipientOpenId: 'ou_manager_01',
    kind: 'manager_approval_requested',
    status: 'processing',
    attempts: 1,
    createdAt: '2026-07-31T02:00:00.000Z',
    updatedAt: '2026-07-31T02:00:01.000Z',
    nextAttemptAt: '2026-07-31T02:00:00.000Z',
    leaseUntil: '2026-07-31T02:01:01.000Z',
    claimToken: '11111111-1111-4111-8111-111111111111',
    completedAt: '',
    lastError: '',
    deliveryId: '',
    messageId: '',
    deliveryUuid: 'pmgr-1-stable-manager-delivery',
    firstSendAttemptAt: '',
    sendOutcome: 'unattempted',
    deliveryGeneration: 1,
    cardContext: '',
    deliveryAudit: [],
    ...overrides,
  };
}

function action(
  overrides: Partial<PurchaseManagerApprovalActionEntry> = {},
): PurchaseManagerApprovalActionEntry {
  return {
    key: 'manager-approval-action:manager-event-1',
    eventId: 'manager-event-1',
    recordId: 'rec_manager_1',
    choice: 'comprehensive',
    rejectionReason: '',
    messageId: 'om_manager_1',
    actorOpenId: 'ou_manager_01',
    status: 'processing',
    attempts: 1,
    createdAt: '2026-07-31T02:00:00.000Z',
    updatedAt: '2026-07-31T02:00:01.000Z',
    nextAttemptAt: '2026-07-31T02:00:00.000Z',
    leaseUntil: '2026-07-31T02:01:01.000Z',
    claimToken: '22222222-2222-4222-8222-222222222222',
    completedAt: '',
    lastError: '',
    ...overrides,
  };
}

function card(
  overrides: Partial<PurchaseManagerApprovalCardEntry> = {},
): PurchaseManagerApprovalCardEntry {
  return {
    key: 'manager-card:rec_manager_1:ou_manager_01',
    executionRecordId: 'rec_manager_1',
    messageId: 'om_manager_1',
    supersededMessageIds: [],
    recipientOpenId: 'ou_manager_01',
    sourceNotificationKey: 'manager-request-key',
    sourceKind: 'manager_approval_requested',
    sourceStatus: 'completed',
    cardContext: cardContext(),
    state: 'initial',
    choice: '',
    rejectionReasonDraft: '',
    actionEventId: '',
    actorOpenId: '',
    processedAt: '',
    createdAt: '2026-07-31T02:00:00.000Z',
    updatedAt: '2026-07-31T02:00:01.000Z',
    resolvedAt: '',
    ...overrides,
  };
}

describe('PurchaseManagerApprovalService', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
      PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_manager_01',
      PURCHASE_MANAGER_APPROVER_NAME: '机房经理',
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns a receipt navigation card without patching before the callback is acknowledged', async () => {
    const { service, gateway, store } = harness();
    const card = { schema: '2.0', body: { elements: [] } };
    store.getPurchaseBatchForFulfillmentCard.mockResolvedValue({
      batch: { approvalBatchId: 'purchase-application-task-1' },
    });
    Reflect.set(
      service,
      'renderPurchaseBatchReceiptCard',
      jest.fn().mockResolvedValue(card),
    );

    await expect(
      service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action',
        eventId: 'event-receipt-navigation-1',
        operatorOpenId: 'ou_requester',
        messageId: 'om_receipt_navigation_1',
        action: 'open_receipt',
        approvalBatchId: 'purchase-application-task-1',
        executionRecordId: 'rec_receipt_1',
      }),
    ).resolves.toEqual({ claimed: false, card });
    expect(gateway.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it.each([
    { status: '下单完成（待签收）', shouldEnqueue: true },
    { status: '库房确认（待下单）', shouldEnqueue: false },
  ])(
    'recovers a missing requester receipt card only for receipt stage ($status)',
    async ({ status, shouldEnqueue }) => {
      const { service, gateway, store } = harness();
      const now = new Date('2026-09-18T03:00:00.000Z');
      const order = notification({
        kind: 'manager_batch_order_command',
        status: 'completed',
        cardContext: serializePurchaseBatchFulfillmentCommandContext({
          version: 4,
          workflowType: 'purchase_batch_fulfillment',
          action: 'order',
          approvalBatchId: 'purchase-application-task-1',
          executionRecordId: 'rec_receipt_1',
          actorOpenId: 'ou_purchase_admin',
          actualQuantity: 2,
          actualAmount: 19.8,
          note: '',
          paymentAttachmentTokens: [],
        }),
      });
      store.listNotifications.mockImplementation(async ({ kind }) =>
        kind === 'manager_batch_order_command' ? [order] : [],
      );
      store.findManagerApprovalBatch.mockResolvedValue({
        approvalBatchId: 'purchase-application-task-1',
        requesterOpenId: 'ou_requester',
        recordIds: ['rec_receipt_1'],
        cardContext: 'persisted-batch-context',
        items: [
          {
            executionRecordId: 'rec_receipt_1',
            status: 'approved',
            purchaserOpenId: 'ou_purchase_admin',
          },
        ],
      });
      gateway.getExecutionRecordAsApp.mockResolvedValue(
        record({
          recordId: 'rec_receipt_1',
          status,
          requesterOpenId: 'ou_requester',
          purchaserOpenId: 'ou_purchase_admin',
          actualQuantity: 2,
          actualAmount: 19.8,
        }),
      );

      await service.runPendingTasks(1, now);

      if (shouldEnqueue) {
        expect(store.enqueueNotification).toHaveBeenCalledWith(
          {
            businessEventId:
              'manager_batch_receipt_requested:purchase-application-task-1',
            recordId: 'rec_receipt_1',
            recipientOpenId: 'ou_requester',
            kind: 'manager_batch_receipt_requested',
            cardContext: 'persisted-batch-context',
          },
          now,
        );
      } else {
        expect(store.enqueueNotification).not.toHaveBeenCalled();
      }
    },
  );

  it('registers one idempotent manager request without enabling the legacy workflow', async () => {
    const enqueueNotifications = jest
      .fn()
      .mockResolvedValueOnce({ enqueued: true })
      .mockResolvedValueOnce({ enqueued: false });
    const service = new PurchaseManagerApprovalService(
      {} as PurchaseWorkflowGateway,
      { enqueueNotifications } as unknown as PurchaseWorkflowStore,
    );

    expect(service.isEnabled()).toBe(true);
    await service.enqueueApprovalRequest('rec_manager_1');
    await service.enqueueApprovalRequest('rec_manager_1');

    expect(enqueueNotifications).toHaveBeenCalledTimes(2);
    expect(enqueueNotifications).toHaveBeenNthCalledWith(1, [{
      businessEventId: 'manager_approval_requested:rec_manager_1',
      recordId: 'rec_manager_1',
      recipientOpenId: 'ou_manager_01',
      kind: 'manager_approval_requested',
    }]);
    expect(enqueueNotifications).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({
        businessEventId: 'manager_approval_requested:rec_manager_1',
      })],
    );
    expect(process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED).toBe('false');
  });

  it('is a no-op when only the legacy workflow flag is enabled', async () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    const enqueueNotification = jest.fn();
    const service = new PurchaseManagerApprovalService(
      {} as PurchaseWorkflowGateway,
      { enqueueNotification } as unknown as PurchaseWorkflowStore,
    );

    expect(service.isEnabled()).toBe(false);
    await expect(
      service.enqueueApprovalRequest('rec_manager_disabled'),
    ).resolves.toBeUndefined();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('anchors the initial send before I/O and atomically registers the returned message', async () => {
    let elapsedClock = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => elapsedClock);
    const { service, gateway, store } = harness();
    const task = notification();
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    gateway.getExecutionRecordAsApp.mockImplementation(async () => { elapsedClock += 20; return record(); });
    store.markManagerApprovalSendStarted.mockImplementation(
      async (_key, _token, context) => ({
        ...task,
        firstSendAttemptAt: '2026-07-31T02:00:02.000Z',
        sendOutcome: 'unknown',
        cardContext: context,
      }),
    );
    gateway.sendInteractiveCard.mockResolvedValue('om_manager_1');

    const result = await service.runPendingTasks(
      1,
      new Date('2026-07-31T02:00:02.000Z'),
    );

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(store.markManagerApprovalSendStarted).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      expect.any(String),
      new Date('2026-07-31T02:00:02.020Z'),
    );
    const context = store.markManagerApprovalSendStarted.mock.calls[0]?.[2];
    expect(parsePurchaseManagerApprovalCardContext(context)).toMatchObject({
      executionRecordId: 'rec_manager_1',
      procurementForm: '单一采购',
      singleReason: '原设备停产，仅原厂替代件兼容',
      amount: '100',
    });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_manager_01',
      expect.any(Object),
      task.deliveryUuid,
    );
    expect(
      store.markManagerApprovalSendStarted.mock.invocationCallOrder[0],
    ).toBeLessThan(
      gateway.sendInteractiveCard.mock.invocationCallOrder[0] || 0,
    );
    expect(
      gateway.sendInteractiveCard.mock.invocationCallOrder[0],
    ).toBeLessThan(
      store.completeManagerApprovalRequestAndRegisterCard.mock
        .invocationCallOrder[0] || 0,
    );
    expect(
      store.completeManagerApprovalRequestAndRegisterCard,
    ).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      { messageId: 'om_manager_1' },
      new Date('2026-07-31T02:00:02.000Z'),
    );
    expect(store.takeNextManagerApprovalAction).not.toHaveBeenCalled();
  });

  it('retries an accepted-but-uncommitted initial send with the same UUID', async () => {
    const { service, gateway, store } = harness();
    const first = notification();
    const retry = notification({
      attempts: 2,
      claimToken: '33333333-3333-4333-8333-333333333333',
      firstSendAttemptAt: '2026-07-31T03:00:00.000Z',
      sendOutcome: 'unknown',
      cardContext: cardContext(),
    });
    store.takeNextManagerApprovalNotification
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(retry);
    gateway.getExecutionRecordAsApp.mockResolvedValue(record());
    store.markManagerApprovalSendStarted
      .mockResolvedValueOnce({
        ...first,
        firstSendAttemptAt: '2026-07-31T03:00:00.000Z',
        sendOutcome: 'unknown',
        cardContext: cardContext(),
      })
      .mockResolvedValueOnce(retry);
    gateway.sendInteractiveCard.mockResolvedValue('om_manager_1');
    store.completeManagerApprovalRequestAndRegisterCard
      .mockRejectedValueOnce(new Error('crash after Feishu accepted'))
      .mockResolvedValueOnce({});

    await service.runPendingTasks(1, new Date('2026-07-31T03:00:00.000Z'));
    await service.runPendingTasks(1, new Date('2026-07-31T03:00:30.000Z'));

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(
      gateway.sendInteractiveCard.mock.calls.map((call) => call[2]),
    ).toEqual([first.deliveryUuid, first.deliveryUuid]);
    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      first.key,
      first.claimToken,
      expect.any(Error),
      expect.any(Date),
      new Date('2026-07-31T03:00:00.000Z'),
    );
    expect(
      store.completeManagerApprovalRequestAndRegisterCard,
    ).toHaveBeenLastCalledWith(
      retry.key,
      retry.claimToken,
      { messageId: 'om_manager_1' },
      new Date('2026-07-31T03:00:30.000Z'),
    );
  });

  it('counts every surfaced initial unknown timeout without retrying outbound delivery', async () => {
    const { service, gateway, store } = harness();
    const firstManual = notification({
      key: 'sensitive-initial-timeout-key-1',
      recordId: 'sensitive-initial-timeout-record-1',
      status: 'manual_reconciliation',
      claimToken: '',
      leaseUntil: '',
      completedAt: '2026-07-31T04:00:00.000Z',
      sendOutcome: 'manual_reconciliation',
    });
    const secondManual = notification({
      key: 'sensitive-initial-timeout-key-2',
      recordId: 'sensitive-initial-timeout-record-2',
      status: 'manual_reconciliation',
      claimToken: '',
      leaseUntil: '',
      completedAt: '2026-07-31T04:00:00.000Z',
      sendOutcome: 'manual_reconciliation',
    });
    store.takeNextManagerApprovalNotification
      .mockResolvedValueOnce(firstManual)
      .mockResolvedValueOnce(secondManual)
      .mockResolvedValueOnce(null);

    const result = await service.runPendingTasks(
      3,
      new Date('2026-07-31T04:00:00.000Z'),
    );

    expect(result).toMatchObject({
      processed: 0,
      failed: 0,
      manualReconciliation: 2,
      errors: [],
    });
    expect(result.alerts).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('sensitive-initial-timeout');
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(store.markManagerApprovalSendStarted).not.toHaveBeenCalled();
    expect(store.rescheduleNotification).not.toHaveBeenCalled();
    expect(store.failNotification).not.toHaveBeenCalled();
  });

  it('handles all manager callbacks through local CAS and returns the canonical card without I/O', async () => {
    const { service, gateway, store } = harness();
    const initialCard = card();
    const rejectEditor = card({
      state: 'reject_editing',
      actorOpenId: 'ou_manager_01',
    });
    const pendingComprehensive = card({
      state: 'pending',
      choice: 'comprehensive',
      actionEventId: 'event-comprehensive',
      actorOpenId: 'ou_manager_01',
    });
    const pendingBuilding = card({
      state: 'pending',
      choice: 'building_self',
      actionEventId: 'event-building',
      actorOpenId: 'ou_manager_01',
    });
    const pendingReject = card({
      state: 'pending',
      choice: 'reject',
      rejectionReasonDraft: '预算资料不足',
      actionEventId: 'event-reject',
      actorOpenId: 'ou_manager_01',
    });
    store.openManagerApprovalRejectEditor.mockResolvedValue({
      opened: true,
      card: rejectEditor,
    });
    store.claimManagerApprovalAction
      .mockResolvedValueOnce({
        claimed: true,
        entry: action({ eventId: 'event-comprehensive' }),
        card: pendingComprehensive,
      })
      .mockResolvedValueOnce({
        claimed: true,
        entry: action({
          eventId: 'event-building',
          choice: 'building_self',
        }),
        card: pendingBuilding,
      })
      .mockResolvedValueOnce({
        claimed: true,
        entry: action({
          eventId: 'event-reject',
          choice: 'reject',
          rejectionReason: '预算资料不足',
        }),
        card: pendingReject,
      });
    store.findManagerApprovalCard
      .mockResolvedValueOnce(initialCard)
      .mockResolvedValueOnce(initialCard)
      .mockResolvedValueOnce(initialCard)
      .mockResolvedValueOnce(rejectEditor);

    const rejectEditorResponse = await service.handleManagerCardAction({
      kind: 'manager_action',
      eventId: 'event-open-reject',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_1',
      action: 'open_reject',
      executionRecordId: 'rec_manager_1',
    });
    const comprehensiveResponse = await service.handleManagerCardAction({
      kind: 'manager_action',
      eventId: 'event-comprehensive',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_1',
      action: 'choose_comprehensive',
      executionRecordId: 'rec_manager_1',
    });
    const buildingResponse = await service.handleManagerCardAction({
      kind: 'manager_action',
      eventId: 'event-building',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_1',
      action: 'choose_building_self',
      executionRecordId: 'rec_manager_1',
    });
    const rejectResponse = await service.handleManagerCardAction({
      kind: 'manager_action',
      eventId: 'event-reject',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_1',
      action: 'submit_reject',
      rejectionReason: '预算资料不足',
    });

    expect(store.openManagerApprovalRejectEditor).toHaveBeenCalledWith({
      recordId: 'rec_manager_1',
      messageId: 'om_manager_1',
      actorOpenId: 'ou_manager_01',
    });
    expect(store.claimManagerApprovalAction.mock.calls).toEqual([
      [
        {
          eventId: 'event-comprehensive',
          recordId: 'rec_manager_1',
          choice: 'comprehensive',
          rejectionReason: '',
          messageId: 'om_manager_1',
          actorOpenId: 'ou_manager_01',
        },
        expect.any(Date),expect.any(Function),
      ],
      [
        {
          eventId: 'event-building',
          recordId: 'rec_manager_1',
          choice: 'building_self',
          rejectionReason: '',
          messageId: 'om_manager_1',
          actorOpenId: 'ou_manager_01',
        },
        expect.any(Date),expect.any(Function),
      ],
      [
        {
          eventId: 'event-reject',
          recordId: 'rec_manager_1',
          choice: 'reject',
          rejectionReason: '预算资料不足',
          messageId: 'om_manager_1',
          actorOpenId: 'ou_manager_01',
        },
        expect.any(Date),expect.any(Function),
      ],
    ]);
    expect(JSON.stringify(rejectEditorResponse)).toContain('rejection_reason');
    expect(JSON.stringify(comprehensiveResponse)).toContain('同步中');
    expect(JSON.stringify(buildingResponse)).toContain('同步中');
    expect(JSON.stringify(rejectResponse)).toContain('同步中');
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it('binds an unknown initial delivery before applying its first valid callback', async () => {
    const { service, store } = harness();
    const boundCard = card();
    store.findManagerApprovalCard.mockResolvedValue(null);
    store.bindUnknownManagerApprovalDeliveryFromCallback.mockResolvedValue({
      bound: true,
      notification: notification({ status: 'completed' }),
      card: boundCard,
    });
    store.claimManagerApprovalAction.mockResolvedValue({
      claimed: true,
      entry: action(),
      card: card({
        state: 'pending',
        choice: 'comprehensive',
        actionEventId: 'unknown-bind-event',
        actorOpenId: 'ou_manager_01',
      }),
    });

    await service.handleManagerCardAction({
      kind: 'manager_action',
      eventId: 'unknown-bind-event',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_manager_1',
      action: 'choose_comprehensive',
      executionRecordId: 'rec_manager_1',
    });

    expect(
      store.bindUnknownManagerApprovalDeliveryFromCallback,
    ).toHaveBeenCalledWith({
      recordId: 'rec_manager_1',
      messageId: 'om_manager_1',
      actorOpenId: 'ou_manager_01',
    });
    expect(
      store.bindUnknownManagerApprovalDeliveryFromCallback.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      store.claimManagerApprovalAction.mock.invocationCallOrder[0] || 0,
    );
  });

  it.each([
    [
      'comprehensive',
      '',
      {
        '1️⃣物品采购方式': '综合采购',
        采购人: [{ id: 'ou_purchase_admin' }],
        库房确认: true,
        采购流程: '审批通过（待下单）',
        驳回原因: '',
      },
    ],
    [
      'building_self',
      '',
      {
        '1️⃣物品采购方式': '需求自采',
        采购人: [{ id: 'ou_building_supervisor' }],
        库房确认: true,
        采购流程: '审批通过（待下单）',
        驳回原因: '',
      },
    ],
    [
      'reject',
      '预算资料不足',
      {
        '1️⃣物品采购方式': '驳回',
        采购流程: '驳回申请',
        驳回原因: '预算资料不足',
      },
    ],
  ] as const)(
    'writes the exact %s Base patch and atomically resolves the action',
    async (choice, rejectionReason, expectedPatch) => {
      const { service, gateway, store } = harness();
      const task = action({ choice, rejectionReason });
      store.takeNextManagerApprovalAction.mockResolvedValueOnce(task);
      gateway.getExecutionRecordAsApp.mockResolvedValue(record());

      const result = await service.runPendingTasks(
        1,
        new Date('2026-07-31T04:00:00.000Z'),
      );

      expect(result).toMatchObject({ processed: 1, failed: 0 });
      expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
        'rec_manager_1',
        expectedPatch,
      );
      expect(
        store.completeManagerApprovalActionAndEnqueueResolved,
      ).toHaveBeenCalledWith(
        task.key,
        task.claimToken,
        new Date('2026-07-31T04:00:00.000Z'),
      );
      expect(
        store.failManagerApprovalActionAndEnqueueReopen,
      ).not.toHaveBeenCalled();
      expect(
        store.markManagerApprovalManualReconciliation,
      ).not.toHaveBeenCalled();
    },
  );

  it('treats the exact purchaser and warehouse target as idempotent without rewriting Base', async () => {
    const { service, gateway, store } = harness();
    const task = action({ choice: 'building_self' });
    store.takeNextManagerApprovalAction.mockResolvedValueOnce(task);
    gateway.getExecutionRecordAsApp.mockResolvedValue(
      record({
        purchaseMethod: '需求自采',
        status: '审批通过（待下单）',
        rejectionReason: '',
        purchaserOpenId: 'ou_building_supervisor',
        warehouseConfirmed: true,
      }),
    );

    await service.runPendingTasks(1, new Date('2026-07-31T04:10:00.000Z'));

    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(
      store.completeManagerApprovalActionAndEnqueueResolved,
    ).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      new Date('2026-07-31T04:10:00.000Z'),
    );
  });

  it.each([
    [
      'conflicting later status',
      record({
        status: '下单完成（待签收）',
        purchaseMethod: '综合采购',
      }),
      action(),
    ],
    [
      'rejected target with absent reason',
      record({
        status: '驳回申请',
        purchaseMethod: '驳回',
        rejectionReason: undefined,
      }),
      action({ choice: 'reject', rejectionReason: '预算资料不足' }),
    ],
    [
      'rejected target with a different reason',
      record({
        status: '驳回申请',
        purchaseMethod: '驳回',
        rejectionReason: '另一个原因',
      }),
      action({ choice: 'reject', rejectionReason: '预算资料不足' }),
    ],
  ])(
    'locks %s in manual reconciliation before any write',
    async (_label, latest, task) => {
      const { service, gateway, store } = harness();
      store.takeNextManagerApprovalAction.mockResolvedValueOnce(task);
      gateway.getExecutionRecordAsApp.mockResolvedValue(latest);

      await service.runPendingTasks(1, new Date('2026-07-31T04:20:00.000Z'));

      expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
      expect(
        store.markManagerApprovalManualReconciliation,
      ).toHaveBeenCalledWith(
        task.key,
        task.claimToken,
        expect.any(ConflictException),
        new Date('2026-07-31T04:20:00.000Z'),
      );
      expect(
        store.failManagerApprovalActionAndEnqueueReopen,
      ).not.toHaveBeenCalled();
    },
  );

  it('retries a confirmed non-write and reopens only after the bounded final attempt', async () => {
    const transient = harness();
    const retryTask = action({ attempts: 1 });
    transient.store.takeNextManagerApprovalAction.mockResolvedValueOnce(
      retryTask,
    );
    transient.gateway.getExecutionRecordAsApp.mockResolvedValue(record());
    transient.gateway.updateExecutionRecordAsApp.mockRejectedValue(
      new Error('temporary timeout'),
    );
    await transient.service.runPendingTasks(
      1,
      new Date('2026-07-31T04:30:00.000Z'),
    );
    expect(transient.gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(2);
    expect(
      transient.store.rescheduleManagerApprovalAction,
    ).toHaveBeenCalledWith(
      retryTask.key,
      retryTask.claimToken,
      expect.any(Error),
      expect.any(Date),
      new Date('2026-07-31T04:30:00.000Z'),
    );
    expect(
      transient.store.failManagerApprovalActionAndEnqueueReopen,
    ).not.toHaveBeenCalled();

    const terminal = harness();
    const terminalTask = action({
      attempts: 5,
      choice: 'reject',
      rejectionReason: '预算资料不足',
    });
    terminal.store.takeNextManagerApprovalAction.mockResolvedValueOnce(
      terminalTask,
    );
    terminal.gateway.getExecutionRecordAsApp.mockResolvedValue(record());
    terminal.gateway.updateExecutionRecordAsApp.mockRejectedValue(
      new Error('persistent Base failure'),
    );
    await terminal.service.runPendingTasks(
      1,
      new Date('2026-07-31T04:31:00.000Z'),
    );
    expect(terminal.gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(2);
    expect(
      terminal.store.failManagerApprovalActionAndEnqueueReopen,
    ).toHaveBeenCalledWith(
      terminalTask.key,
      terminalTask.claimToken,
      expect.any(Error),
      new Date('2026-07-31T04:31:00.000Z'),
    );
  });

  it('reconciles an ambiguous write by completing an exact target, locking a conflict, or retrying an unreadable result', async () => {
    const applied = harness();
    const appliedTask = action();
    applied.store.takeNextManagerApprovalAction.mockResolvedValueOnce(
      appliedTask,
    );
    applied.gateway.getExecutionRecordAsApp
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(
        record({
          status: '审批通过（待下单）',
          purchaseMethod: '综合采购',
          rejectionReason: '',
          purchaserOpenId: 'ou_purchase_admin',
          warehouseConfirmed: true,
        }),
      );
    applied.gateway.updateExecutionRecordAsApp.mockRejectedValue(
      new Error('response lost'),
    );
    await applied.service.runPendingTasks(
      1,
      new Date('2026-07-31T04:40:00.000Z'),
    );
    expect(
      applied.store.completeManagerApprovalActionAndEnqueueResolved,
    ).toHaveBeenCalled();
    expect(
      applied.store.failManagerApprovalActionAndEnqueueReopen,
    ).not.toHaveBeenCalled();

    const conflicting = harness();
    const conflictTask = action();
    conflicting.store.takeNextManagerApprovalAction.mockResolvedValueOnce(
      conflictTask,
    );
    conflicting.gateway.getExecutionRecordAsApp
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(
        record({
          status: '下单完成（待签收）',
          purchaseMethod: '综合采购',
        }),
      );
    conflicting.gateway.updateExecutionRecordAsApp.mockRejectedValue(
      new Error('response lost'),
    );
    await conflicting.service.runPendingTasks(
      1,
      new Date('2026-07-31T04:41:00.000Z'),
    );
    expect(
      conflicting.store.markManagerApprovalManualReconciliation,
    ).toHaveBeenCalledWith(
      conflictTask.key,
      conflictTask.claimToken,
      expect.any(Error),
      new Date('2026-07-31T04:41:00.000Z'),
    );
    expect(
      conflicting.store.failManagerApprovalActionAndEnqueueReopen,
    ).not.toHaveBeenCalled();

    const unreadable = harness();
    const unreadableTask = action();
    unreadable.store.takeNextManagerApprovalAction.mockResolvedValueOnce(
      unreadableTask,
    );
    unreadable.gateway.getExecutionRecordAsApp
      .mockResolvedValueOnce(record())
      .mockRejectedValueOnce(new Error('fresh read unavailable'));
    unreadable.gateway.updateExecutionRecordAsApp.mockRejectedValue(
      new Error('write outcome unknown'),
    );
    await unreadable.service.runPendingTasks(
      1,
      new Date('2026-07-31T04:42:00.000Z'),
    );
    expect(
      unreadable.store.rescheduleManagerApprovalAction,
    ).toHaveBeenCalledWith(
      unreadableTask.key,
      unreadableTask.claimToken,
      expect.any(Error),
      expect.any(Date),
      new Date('2026-07-31T04:42:00.000Z'),
    );
    expect(
      unreadable.store.markManagerApprovalManualReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      unreadable.store.failManagerApprovalActionAndEnqueueReopen,
    ).not.toHaveBeenCalled();
  });

  it('never reopens a resolved business decision when its final card PATCH fails', async () => {
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_resolved:manager-event-1',
      kind: 'manager_approval_resolved',
      attempts: 5,
      messageId: 'om_manager_1',
      cardContext: cardContext(),
    });
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'completed',
        completedAt: '2026-07-31T05:00:00.000Z',
        claimToken: '',
        leaseUntil: '',
      }),
    ]);
    gateway.getExecutionRecordAsApp.mockResolvedValue(
      record({
        status: '审批通过（待下单）',
        purchaseMethod: '综合采购',
        rejectionReason: '',
      }),
    );
    gateway.updateInteractiveCard.mockRejectedValue(
      new Error('final PATCH timeout'),
    );

    await service.runPendingTasks(1, new Date('2026-07-31T05:00:01.000Z'));

    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      expect.any(Error),
      expect.any(Date),
      new Date('2026-07-31T05:00:01.000Z'),
    );
    expect(
      store.failManagerApprovalActionAndEnqueueReopen,
    ).not.toHaveBeenCalled();
    expect(
      store.markManagerApprovalManualReconciliation,
    ).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it('releases a malformed state notification through the normal retry path', async () => {
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_resolved:manager-event-1',
      kind: 'manager_approval_resolved',
      messageId: 'om_manager_1',
      cardContext: '{"broken":true}',
    });
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'completed',
        completedAt: '2026-07-31T05:05:00.000Z',
        claimToken: '',
        leaseUntil: '',
      }),
    ]);

    await expect(
      service.runPendingTasks(1, new Date('2026-07-31T05:05:01.000Z')),
    ).resolves.toMatchObject({ processed: 0, failed: 1 });

    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      expect.any(Error),
      expect.any(Date),
      new Date('2026-07-31T05:05:01.000Z'),
    );
    expect(gateway.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it('redacts quoted JSON credentials from task diagnostics', async () => {
    const { service, gateway, store } = harness();
    const task = notification();
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    gateway.getExecutionRecordAsApp.mockRejectedValue(
      new Error(
        'upstream rejected {"token":"abc-secret","password":"pw-secret"} Bearer bearer-secret',
      ),
    );

    const result = await service.runPendingTasks(
      1,
      new Date('2026-07-31T05:06:01.000Z'),
    );

    expect(result.errors.join(' ')).toContain('[redacted]');
    expect(result.errors.join(' ')).not.toContain('abc-secret');
    expect(result.errors.join(' ')).not.toContain('pw-secret');
    expect(result.errors.join(' ')).not.toContain('bearer-secret');
  });

  it('keeps transient reopened PATCH failures retryable even at the normal attempt cap', async () => {
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_reopened:manager-event-1',
      kind: 'manager_approval_reopened',
      attempts: 5,
      messageId: 'om_manager_1',
      cardContext: cardContext(),
    });
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'failed',
        completedAt: '2026-07-31T05:10:00.000Z',
        claimToken: '',
        leaseUntil: '',
        lastError: 'Base timeout',
      }),
    ]);
    gateway.updateInteractiveCard.mockRejectedValue(
      new Error('temporary rate limit'),
    );

    const result = await service.runPendingTasks(
      1,
      new Date('2026-07-31T05:10:01.000Z'),
    );

    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      expect.any(Error),
      expect.any(Date),
      new Date('2026-07-31T05:10:01.000Z'),
    );
    expect(store.failNotification).not.toHaveBeenCalled();
    expect(result.alerts).toEqual(
      expect.arrayContaining([expect.stringContaining(task.key)]),
    );
  });

  it('sends a stable-UUID replacement after a confirmed permanent reopened-card error and atomically rebinds it', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-31T05:20:01.000Z'));
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_reopened:manager-event-1',
      kind: 'manager_approval_reopened',
      messageId: 'om_manager_old',
      cardContext: cardContext(),
      deliveryUuid: 'pmgr-1-stable-replacement',
    });
    const anchored = {
      ...task,
      firstSendAttemptAt: '2026-07-31T05:20:01.000Z',
      sendOutcome: 'unknown' as const,
    };
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'failed',
        choice: 'reject',
        rejectionReason: '预算资料不足',
        completedAt: '2026-07-31T05:20:00.000Z',
        claimToken: '',
        leaseUntil: '',
      }),
    ]);
    gateway.updateInteractiveCard.mockRejectedValue(
      Object.assign(new Error('Feishu rejected the card update'), {
        feishuCode: 230110,
      }),
    );
    store.markManagerApprovalSendStarted.mockResolvedValue(anchored);
    gateway.sendInteractiveCard.mockResolvedValue('om_manager_replacement');

    await service.runPendingTasks(1, new Date('2026-07-31T05:20:01.000Z'));

    expect(store.markManagerApprovalSendStarted).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      task.cardContext,
      new Date('2026-07-31T05:20:01.000Z'),
    );
    expect(
      store.markManagerApprovalSendStarted.mock.invocationCallOrder[0],
    ).toBeLessThan(
      gateway.sendInteractiveCard.mock.invocationCallOrder[0] || 0,
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      task.recipientOpenId,
      expect.any(Object),
      task.deliveryUuid,
    );
    expect(store.replaceManagerApprovalCardMessage).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      {
        oldMessageId: 'om_manager_old',
        newMessageId: 'om_manager_replacement',
      },
      new Date('2026-07-31T05:20:01.000Z'),
    );
    expect(
      gateway.sendInteractiveCard.mock.invocationCallOrder[0],
    ).toBeLessThan(
      store.replaceManagerApprovalCardMessage.mock.invocationCallOrder[0] || 0,
    );
    expect(store.rescheduleNotification).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an ordinary business error containing message/not found',
      new Error('business message not found in local template'),
    ],
    [
      'a non-permanent Feishu application error',
      Object.assign(new Error('Feishu parameter rejected'), {
        feishuCode: 230001,
      }),
    ],
  ])('does not replace the card for %s', async (_label, updateError) => {
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_reopened:manager-event-1',
      kind: 'manager_approval_reopened',
      messageId: 'om_manager_old',
      cardContext: cardContext(),
    });
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'failed',
        completedAt: '2026-07-31T05:25:00.000Z',
        claimToken: '',
        leaseUntil: '',
      }),
    ]);
    gateway.updateInteractiveCard.mockRejectedValue(updateError);

    await service.runPendingTasks(1, new Date('2026-07-31T05:25:01.000Z'));

    expect(store.rescheduleNotification).toHaveBeenCalled();
    expect(store.markManagerApprovalSendStarted).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(store.replaceManagerApprovalCardMessage).not.toHaveBeenCalled();
  });

  it('replaces an unavailable card after an explicit HTTP 410 response', async () => {
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_reopened:manager-event-1',
      kind: 'manager_approval_reopened',
      messageId: 'om_manager_old',
      cardContext: cardContext(),
    });
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'failed',
        completedAt: '2026-07-31T05:26:00.000Z',
        claimToken: '',
        leaseUntil: '',
      }),
    ]);
    gateway.updateInteractiveCard.mockRejectedValue(
      Object.assign(new Error('HTTP request failed'), {
        response: { status: 410 },
      }),
    );
    store.markManagerApprovalSendStarted.mockResolvedValue({
      ...task,
      sendOutcome: 'unknown',
    });
    gateway.sendInteractiveCard.mockResolvedValue('om_manager_replacement');

    await service.runPendingTasks(1, new Date('2026-07-31T05:26:01.000Z'));

    expect(store.replaceManagerApprovalCardMessage).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      {
        oldMessageId: 'om_manager_old',
        newMessageId: 'om_manager_replacement',
      },
      new Date('2026-07-31T05:26:01.000Z'),
    );
  });

  it('updates a manual attention card without changing the locked business state', async () => {
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_attention_required:manager-event-1',
      kind: 'manager_approval_attention_required',
      messageId: 'om_manager_1',
      cardContext: cardContext(),
    });
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'manual_reconciliation',
        completedAt: '2026-07-31T05:30:00.000Z',
        claimToken: '',
        leaseUntil: '',
      }),
    ]);

    await service.runPendingTasks(1, new Date('2026-07-31T05:30:01.000Z'));

    expect(gateway.updateInteractiveCard).toHaveBeenCalledWith(
      'om_manager_1',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(store.completeNotification).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      { messageId: 'om_manager_1' },
      new Date('2026-07-31T05:30:01.000Z'),
    );
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(
      store.completeManagerApprovalActionAndEnqueueResolved,
    ).not.toHaveBeenCalled();
  });

  it('updates a delivery-generation attention card using its original failed action', async () => {
    const { service, gateway, store } = harness();
    const task = notification({
      businessEventId: 'manager_approval_attention_required:manager-event-1:2',
      kind: 'manager_approval_attention_required',
      messageId: 'om_manager_1',
      deliveryGeneration: 2,
      cardContext: cardContext(),
    });
    store.takeNextManagerApprovalNotification.mockResolvedValueOnce(task);
    store.listManagerApprovalActions.mockResolvedValue([
      action({
        status: 'failed',
        completedAt: '2026-07-31T05:31:00.000Z',
        claimToken: '',
        leaseUntil: '',
      }),
    ]);

    await service.runPendingTasks(1, new Date('2026-07-31T05:31:01.000Z'));

    expect(gateway.updateInteractiveCard).toHaveBeenCalledWith(
      'om_manager_1',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(store.completeNotification).toHaveBeenCalledWith(
      task.key,
      task.claimToken,
      { messageId: 'om_manager_1' },
      new Date('2026-07-31T05:31:01.000Z'),
    );
    expect(store.rescheduleNotification).not.toHaveBeenCalled();
  });
});
