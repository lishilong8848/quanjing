jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: jest.fn((name: string) => process.env[name] || ''),
}));

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PurchaseManagerApprovalService as ActualPurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
const PurchaseManagerApprovalService = withSyntheticBusinessIdentity(ActualPurchaseManagerApprovalService, 5);
type PurchaseManagerApprovalService = ActualPurchaseManagerApprovalService;
import { serializePurchaseBatchFulfillmentCommandContext } from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import {
  PurchaseWorkflowStore,
  type PurchaseManagerReceiptBatchRecoveryInput,
} from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const originalEnv = { ...process.env };

function pendingReceiptRecord(
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId: 'rec_base_only_receipt_1',
    requestCode: 'CG260920-001',
    status: '下单完成（待签收）',
    itemName: '签收恢复测试物品',
    specification: 'TEST-SPEC',
    building: 'H楼',
    requesterOpenId: 'ou_requester',
    requesterName: '申请人',
    purchaserOpenId: 'ou_purchaser',
    purchaserName: '采购人',
    purchaseMethod: '综合采购',
    requestedQuantity: 2,
    unit: '个',
    unitPrice: 10,
    createdAt: Date.parse('2026-09-20T01:00:00.000Z'),
    actualQuantity: 2,
    actualAmount: 19.8,
    paymentAttachmentTokens: [],
    approvalCompleted: true,
    warehouseConfirmed: true,
    purchaseCompleted: true,
    receiptConfirmed: false,
    signer: '',
    receiptTime: null,
    receiptPhotoTokens: [],
    invoiceTokens: [],
    expectedDeliveryDate: Date.parse('2026-09-21T00:00:00.000Z'),
    approvalSource: '程序卡片',
    approvalWorkflowStatus: '已通过',
    approvalPolicyVersion: 'purchase-manager-card-v2',
    approvalBatchId: 'purchase-application-task-base-only',
    approvalCardMessageId: 'om_existing_manager_card',
    ...overrides,
  };
}

function recoveryInput(
  record: PurchaseWorkflowRecord,
  approvalBatchId: string,
): PurchaseManagerReceiptBatchRecoveryInput {
  return {
    approvalBatchId,
    recipientOpenId: 'ou_manager',
    requesterOpenId: record.requesterOpenId,
    recordIds: [record.recordId],
    cardContext: serializePurchaseManagerBatchApprovalCardContext({
      version: 3,
      approvalBatchId,
      requesterName: record.requesterName,
      requesterOpenId: record.requesterOpenId,
      building: record.building,
      requestCode: record.requestCode,
      expectedDeliveryAt: '2026-09-21',
      createdAt: '2026-09-20 09:00',
      items: [
        {
          executionRecordId: record.recordId,
          title: record.itemName,
          specification: record.specification,
          quantity: String(record.requestedQuantity),
          unit: record.unit,
          amount: String(record.unitPrice || 0),
          status: 'approved',
          choice: 'comprehensive',
          rejectionReason: '',
        },
      ],
    }),
    items: [
      {
        executionRecordId: record.recordId,
        choice: 'comprehensive',
        purchaserOpenId: record.purchaserOpenId,
        purchaserName: record.purchaserName,
        actualQuantity: record.actualQuantity!,
        actualAmount: record.actualAmount!,
        paymentAttachmentTokens: [],
      },
    ],
  };
}

describe('purchase requester receipt card Base recovery', () => {
  let directory = '';
  let ledgerPath = '';
  let store: PurchaseWorkflowStore;

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
      PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_manager',
      PURCHASE_MANAGER_APPROVER_NAME: '经理',
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
    };
    directory = await mkdtemp(join(tmpdir(), 'purchase-receipt-base-'));
    ledgerPath = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('recovers and sends a receipt card when Base is the only durable source', async () => {
    const record = pendingReceiptRecord();
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async (filter: string) =>
        filter.includes('下单完成（待签收）') ? [record] : [],
      ),
      getExecutionRecordAsApp: jest.fn(async () => ({ ...record })),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_receipt_recovered'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    let service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-20T02:00:00.000Z'));

    expect(gateway.listExecutionRecordsAsApp).toHaveBeenCalledWith(
      'CurrentValue.[采购流程]="下单完成（待签收）"',
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_requester',
      expect.any(Object),
      expect.any(String),
    );
    const receipts = await store.listNotifications({
      kind: 'manager_batch_receipt_requested',
    });
    expect(receipts).toEqual([
      expect.objectContaining({
        recipientOpenId: 'ou_requester',
        status: 'completed',
        sendOutcome: 'delivered',
        messageId: 'om_receipt_recovered',
      }),
    ]);
    const approvalBatchId = receipts[0]!.businessEventId.replace(
      /^manager_batch_receipt_requested:/u,
      '',
    );
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      record.recordId,
      expect.objectContaining({
        采购签收卡片投递状态: '已送达',
        采购签收卡片消息标识: 'om_receipt_recovered',
        采购签收卡片批次号: approvalBatchId,
      }),
    );
    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(join(directory, 'ledger.json'));
    await store.onModuleInit();
    service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const opened = await service.handlePurchaseBatchFulfillmentCardAction({
      kind: 'purchase_batch_fulfillment_action',
      eventId: 'evt_open_recovered_receipt',
      operatorOpenId: 'ou_requester',
      messageId: 'om_receipt_recovered',
      action: 'open_receipt',
      approvalBatchId,
      executionRecordId: record.recordId,
    });
    expect(JSON.stringify(opened.card)).toContain('签收人');
    expect(JSON.stringify(opened.card)).toContain('签收备注');

    await service.runPendingTasks(20, new Date('2026-09-20T02:10:00.000Z'));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
  });

  it('rehydrates an already delivered Base card after local ledger loss without resending it', async () => {
    const record = {
      ...pendingReceiptRecord(),
      receiptCardDeliveryStatus: '已送达',
      receiptCardBatchId: 'purchase-receipt-delivered-base-only',
      receiptCardMessageId: 'om_already_delivered',
      receiptCardDeliveryUuid: 'receipt-delivered-uuid',
      receiptCardDeliveryAttempts: 1,
      receiptCardDeliveredAt: Date.parse('2026-09-20T02:59:00.000Z'),
    };
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async (filter: string) =>
        filter.includes('下单完成（待签收）') ? [record] : [],
      ),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_duplicate'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-20T03:00:00.000Z'));

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    const receipts = await store.listNotifications({
      kind: 'manager_batch_receipt_requested',
    });
    expect(receipts).toEqual([
      expect.objectContaining({
        status: 'completed',
        sendOutcome: 'delivered',
        messageId: 'om_already_delivered',
      }),
    ]);
    const opened = await service.handlePurchaseBatchFulfillmentCardAction({
      kind: 'purchase_batch_fulfillment_action',
      eventId: 'evt_open_rehydrated_receipt',
      operatorOpenId: 'ou_requester',
      messageId: 'om_already_delivered',
      action: 'open_receipt',
      approvalBatchId: 'purchase-receipt-delivered-base-only',
      executionRecordId: record.recordId,
    });
    expect(JSON.stringify(opened.card)).toContain('签收备注');
  });

  it('does not invent a callback batch for delivered Base evidence without a durable batch id', async () => {
    const record = {
      ...pendingReceiptRecord(),
      receiptCardDeliveryStatus: '已送达',
      receiptCardMessageId: 'om_delivered_without_batch',
      receiptCardDeliveryAttempts: 1,
      receiptCardDeliveredAt: Date.parse('2026-09-20T03:09:00.000Z'),
    };
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async (filter: string) =>
        filter.includes('下单完成（待签收）') ? [record] : [],
      ),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_duplicate'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-20T03:10:00.000Z'));

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(await store.listManagerApprovalBatchIds()).toEqual([]);
    expect(
      await store.listNotifications({
        kind: 'manager_batch_receipt_requested',
      }),
    ).toEqual([]);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      record.recordId,
      expect.objectContaining({
        采购签收卡片投递状态: '送达待核对',
      }),
    );
  });

  it('treats a partially marked delivered batch as one delivered card', async () => {
    const batchId = 'purchase-receipt-shared-delivered';
    const records = [
      pendingReceiptRecord({
        recordId: 'rec_shared_delivered_1',
        receiptCardBatchId: batchId,
        receiptCardDeliveryStatus: '已送达',
        receiptCardMessageId: 'om_shared_delivered',
        receiptCardDeliveryUuid: 'receipt-shared-uuid',
        receiptCardDeliveryAttempts: 1,
        receiptCardDeliveredAt: Date.parse('2026-09-20T03:29:00.000Z'),
      }),
      pendingReceiptRecord({
        recordId: 'rec_shared_delivered_2',
        receiptCardBatchId: batchId,
        itemName: '同批次后续物品',
      }),
    ];
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async (filter: string) =>
        filter.includes('下单完成（待签收）') ? records : [],
      ),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_duplicate'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-20T03:30:00.000Z'));

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    const receipts = await store.listNotifications({
      kind: 'manager_batch_receipt_requested',
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      messageId: 'om_shared_delivered',
      sendOutcome: 'delivered',
    });
    for (const record of records) {
      expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
        record.recordId,
        expect.objectContaining({
          采购签收卡片批次号: batchId,
          采购签收卡片投递状态: '已送达',
          采购签收卡片消息标识: 'om_shared_delivered',
        }),
      );
    }
  });

  it('reuses an existing receipt owner instead of creating a second recovery batch', async () => {
    const record = pendingReceiptRecord();
    await store.recoverManagerReceiptBatchAndEnqueue(
      recoveryInput(record, 'purchase-existing-receipt-owner'),
      new Date('2026-09-20T03:40:00.000Z'),
    );
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async (filter: string) =>
        filter.includes('下单完成（待签收）') ? [record] : [],
      ),
      getExecutionRecordAsApp: jest.fn(async () => ({ ...record })),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_existing_owner'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-20T03:41:00.000Z'));

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    const receipts = await store.listNotifications({
      kind: 'manager_batch_receipt_requested',
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.businessEventId).toBe(
      'manager_batch_receipt_requested:purchase-existing-receipt-owner',
    );
  });

  it('rejects a persisted Base batch id that conflicts with the local record owner', async () => {
    const record = pendingReceiptRecord();
    await store.recoverManagerReceiptBatchAndEnqueue(
      recoveryInput(record, 'purchase-existing-receipt-owner'),
      new Date('2026-09-20T03:42:00.000Z'),
    );

    await expect(
      store.recoverManagerReceiptBatchAndEnqueue(
        {
          ...recoveryInput(record, 'purchase-base-authoritative-owner'),
          batchIdSource: 'persisted',
        },
        new Date('2026-09-20T03:43:00.000Z'),
      ),
    ).rejects.toThrow('采购签收恢复批次与已有台账冲突');
  });

  it('retains completed receipt tombstones beyond the terminal history limit', async () => {
    const record = pendingReceiptRecord();
    const batchId = 'purchase-receipt-retention-owner';
    const recovered = await store.recoverManagerReceiptBatchAndEnqueue(
      {
        ...recoveryInput(record, batchId),
        batchIdSource: 'persisted',
        delivered: {
          messageId: 'om_receipt_retention',
          deliveryUuid: 'receipt-retention-uuid',
          attempts: 1,
          deliveredAt: new Date('2026-09-20T03:44:00.000Z'),
        },
      },
      new Date('2026-09-20T03:44:00.000Z'),
    );
    expect(recovered.notification?.sendOutcome).toBe('delivered');
    const receiptContext = {
      version: 4 as const,
      workflowType: 'purchase_batch_fulfillment' as const,
      action: 'receipt' as const,
      approvalBatchId: batchId,
      executionRecordId: record.recordId,
      actorOpenId: record.requesterOpenId,
      signerOpenId: record.requesterOpenId,
      receiptTime: Date.parse('2026-09-20T03:45:00.000Z'),
      note: '',
      receiptPhotoTokens: ['file_receipt_retention'],
      invoiceTokens: [],
    };
    const claimed = await store.claimPurchaseBatchFulfillmentCommand(
      {
        approvalBatchId: batchId,
        messageId: 'om_receipt_retention',
        actorOpenId: record.requesterOpenId,
        role: 'requester',
      },
      receiptContext,
      'evt_receipt_retention',
      new Date('2026-09-20T03:45:00.000Z'),
    );
    expect(claimed.claimed).toBe(true);
    const command = await store.takeNextManagerApprovalNotification(
      new Date('2026-09-20T03:45:00.000Z'),
      30_000,
    );
    expect(command?.kind).toBe('manager_batch_receipt_command');
    await store.completePurchaseBatchFulfillmentCommandAndEnqueue(
      command!.key,
      command!.claimToken,
      [],
      new Date('2026-09-20T03:45:01.000Z'),
    );

    await store.onModuleDestroy();
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      notifications: Array<Record<string, unknown>>;
    };
    const orderTemplate = ledger.notifications.find(
      (entry) => entry.kind === 'manager_batch_order_command',
    );
    expect(orderTemplate).toBeDefined();
    for (let index = 0; index < 501; index += 1) {
      ledger.notifications.push({
        ...orderTemplate,
        businessEventId: `manager_batch_order_command:history-${index}`,
      });
    }
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();

    expect(
      await store.listNotifications({
        kind: 'manager_batch_receipt_command',
      }),
    ).toEqual([
      expect.objectContaining({
        recordId: record.recordId,
        status: 'completed',
        cardContext:
          serializePurchaseBatchFulfillmentCommandContext(receiptContext),
      }),
    ]);
    await expect(
      store.claimPurchaseBatchFulfillmentCommand(
        {
          approvalBatchId: batchId,
          messageId: 'om_receipt_retention',
          actorOpenId: record.requesterOpenId,
          role: 'requester',
        },
        receiptContext,
        'evt_receipt_retention_retry',
        new Date('2026-09-20T04:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ claimed: false });
  });

  it('does not send when the Base delivery fence cannot be persisted', async () => {
    const record = pendingReceiptRecord();
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async (filter: string) =>
        filter.includes('下单完成（待签收）') ? [record] : [],
      ),
      getExecutionRecordAsApp: jest.fn(async () => ({ ...record })),
      updateExecutionRecordAsApp: jest.fn(
        async (_recordId: string, fields: Record<string, unknown>) => {
          if ('采购签收卡片投递状态' in fields) {
            throw new Error('Base receipt delivery fields unavailable');
          }
        },
      ),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_must_not_send'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-20T03:50:00.000Z'));

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('sends every Base-only pending receipt record once and keeps requesters separate', async () => {
    const records = [
      pendingReceiptRecord({
        recordId: 'rec_group_a_1',
        itemName: '物品 A1',
      }),
      pendingReceiptRecord({
        recordId: 'rec_group_a_2',
        itemName: '物品 A2',
      }),
      pendingReceiptRecord({
        recordId: 'rec_group_b_1',
        requestCode: 'CG260920-002',
        approvalBatchId: 'purchase-application-task-base-other',
        requesterOpenId: 'ou_requester_b',
        requesterName: '申请人乙',
        itemName: '物品 B1',
      }),
    ];
    const byId = new Map(records.map((record) => [record.recordId, record]));
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async (filter: string) =>
        filter.includes('下单完成（待签收）') ? records : [],
      ),
      getExecutionRecordAsApp: jest.fn(async (recordId: string) => ({
        ...byId.get(recordId)!,
      })),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn(
        async (recipientOpenId: string) => `om_${recipientOpenId}`,
      ),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-20T04:00:00.000Z'));

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(3);
    expect(
      gateway.sendInteractiveCard.mock.calls.map(([recipient]) => recipient),
    ).toEqual(expect.arrayContaining(['ou_requester', 'ou_requester_b']));
    const receipts = await store.listNotifications({
      kind: 'manager_batch_receipt_requested',
    });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((entry) => entry.status === 'completed')).toBe(true);
    for (const record of records) {
      expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
        record.recordId,
        expect.objectContaining({ 采购签收卡片投递状态: '已送达' }),
      );
    }
  });
});
