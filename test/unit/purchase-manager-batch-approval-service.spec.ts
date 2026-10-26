jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: jest.fn((name: string) => process.env[name] || ''),
}));

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleLogger } from '@nestjs/common';
import { FeishuCardActionExecution } from '../../server/common/feishu-card-action-execution';

import { PurchaseManagerApprovalService as ActualPurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
const PurchaseManagerApprovalService = withSyntheticBusinessIdentity(ActualPurchaseManagerApprovalService, 5);
type PurchaseManagerApprovalService = ActualPurchaseManagerApprovalService;
import type { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const originalEnv = { ...process.env };

jest.setTimeout(60_000);

function record(recordId: string, itemName: string): PurchaseWorkflowRecord {
  return {
    recordId,
    requestCode: 'CG260908-001',
    status: '未开始（待审批）',
    itemName,
    specification: `${itemName}-SPEC`,
    building: 'H楼',
    specialty: '电气',
    requesterOpenId: 'ou_requester',
    requesterName: '申请人',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '',
    rejectionReason: '',
    requestedQuantity: 1,
    unit: '件',
    unitPrice: 10,
    createdAt: Date.parse('2026-09-08T02:00:00.000Z'),
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
    expectedDeliveryDate: Date.parse('2026-09-20T00:00:00.000Z'),
  };
}

describe('purchase manager batch approval service', () => {
  let directory = '';
  let store: PurchaseWorkflowStore;

  beforeEach(async () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_manager';
    process.env.PURCHASE_MANAGER_APPROVER_NAME = '经理';
    directory = await mkdtemp(
      join(tmpdir(), 'purchase-manager-batch-service-'),
    );
    store = new PurchaseWorkflowStore(
      join(directory, 'purchase-workflow-ledger.json'),
    );
    await store.onModuleInit();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects self-purchase receipt submission before durable acceptance when invoice is missing', async () => {
    const batch = {
      approvalBatchId: 'purchase-application-self-receipt',
      requesterOpenId: 'ou_requester',
      items: [
        {
          executionRecordId: 'rec-self-receipt',
          status: 'approved',
          choice: 'building_self',
          receiptPhotoTokens: ['file_photo'],
          invoiceTokens: [],
        },
      ],
    };
    const persisted = jest.fn();
    const isolatedStore = {
      getPurchaseBatchForFulfillmentCard: jest
        .fn()
        .mockResolvedValue({ batch }),
      claimPurchaseBatchFulfillmentCommand: jest.fn(async (_identity, createContext) => { createContext(batch); persisted(); throw new Error('Invalid material must not reach persistence'); }),
    };
    const service = new PurchaseManagerApprovalService(
      {} as never,
      isolatedStore as never,
    );

    await expect(
      service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action',
        eventId: 'evt-self-receipt',
        operatorOpenId: 'ou_requester',
        messageId: 'om_self_receipt',
        action: 'submit_receipt',
        approvalBatchId: batch.approvalBatchId,
        executionRecordId: 'rec-self-receipt',
        signerOpenId: 'ou_signer',
        receiptTime: Date.parse('2026-09-22T08:00:00+08:00'),
        note: '',
      }),
    ).rejects.toThrow('自采签收必须上传发票');
    expect(persisted).not.toHaveBeenCalled();
  });

  async function approvedReceiptBatch() {
    const approvalBatchId = 'receipt-recovery-batch';
    const executionRecordId = 'rec-receipt-recovery';
    let current = record(executionRecordId, '标签纸');
    const gateway = {
      getExecutionRecordAsApp: jest.fn(async () => ({ ...current })),
      listExecutionRecordsAsApp: jest.fn(
        async () => [] as PurchaseWorkflowRecord[],
      ),
      ensureManagerApprovalFieldsAsApp: jest.fn(async () => undefined),
      updateExecutionRecordAsApp: jest.fn(
        async (_recordId: string, patch: Record<string, unknown>) => {
          const purchaser = Array.isArray(patch['采购人'])
            ? (patch['采购人'][0] as { id?: string } | undefined)?.id || ''
            : '';
          current = {
            ...current,
            status: (patch['采购流程'] as string) || current.status,
            purchaseMethod:
              (patch[
                '1️⃣物品采购方式'
              ] as PurchaseWorkflowRecord['purchaseMethod']) ||
              current.purchaseMethod,
            purchaserOpenId: purchaser || current.purchaserOpenId,
            purchaserName: purchaser ? '采购管理员' : current.purchaserName,
            warehouseConfirmed:
              patch['库房确认'] === undefined
                ? current.warehouseConfirmed
                : patch['库房确认'] === true,
          };
        },
      ),
      resolvePurchaseAdminAsApp: jest.fn(async () => ({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: ['采购管理'],
        buildings: [],
      })),
      resolveBuildingSupervisorAsApp: jest.fn(),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValueOnce('om_recovery_manager')
        .mockResolvedValueOnce('om_recovery_result')
        .mockResolvedValueOnce('om_recovery_assignment')
        .mockResolvedValue('om_recovery_receipt'),
      updateInteractiveCard: jest.fn(async () => undefined),
    };
    const workflowService = {
      orderFromCard: jest.fn(async () => ({
        idempotent: true,
        notificationWarnings: [],
      })),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
      undefined,
      workflowService as never,
    );
    await service.enqueueApprovalBatch({
      approvalBatchId,
      requesterOpenId: 'ou_requester',
      recordIds: [executionRecordId],
    });
    await service.runPendingTasks(20, new Date('2099-09-08T02:00:01.000Z'));
    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-approve-receipt-recovery',
      operatorOpenId: 'ou_manager',
      messageId: 'om_recovery_manager',
      action: 'approve_pending_comprehensive',
      approvalBatchId,
    });
    await service.runPendingTasks(20, new Date('2099-09-08T02:00:02.000Z'));
    const batch = await store.findManagerApprovalBatch(approvalBatchId);
    if (!batch || batch.state !== 'resolved') {
      throw new Error('测试前置条件：采购批次未审批完成');
    }
    return {
      approvalBatchId,
      executionRecordId,
      batch,
      gateway,
      service,
      workflowService,
      markOrdered: () => {
        current = {
          ...current,
          status: '下单完成（待签收）',
          actualQuantity: 1,
          actualAmount: 10,
          purchaseCompleted: true,
        };
      },
    };
  }

  it('delivers an already queued receipt card before a slow Base approval scan', async () => {
    const fixture = await approvedReceiptBatch();
    fixture.markOrdered();
    await store.enqueueNotification({
      businessEventId: `manager_batch_receipt_requested:${fixture.approvalBatchId}`,
      recordId: fixture.executionRecordId,
      recipientOpenId: 'ou_requester',
      kind: 'manager_batch_receipt_requested',
      cardContext: fixture.batch.cardContext,
    });
    let releaseScan!: (records: PurchaseWorkflowRecord[]) => void;
    const blockedScan = new Promise<PurchaseWorkflowRecord[]>((resolve) => {
      releaseScan = resolve;
    });
    let scanStarted!: (value: string) => void;
    const scanStartedSignal = new Promise<string>((resolve) => {
      scanStarted = resolve;
    });
    let receiptSent!: (value: string) => void;
    const receiptSentSignal = new Promise<string>((resolve) => {
      receiptSent = resolve;
    });
    fixture.gateway.listExecutionRecordsAsApp.mockImplementation(() => {
      scanStarted('approval-scan-started');
      return blockedScan;
    });
    fixture.gateway.sendInteractiveCard.mockImplementation(async () => {
      receiptSent('receipt-card-sent');
      return 'om_recovery_receipt';
    });

    const run = fixture.service.runPendingTasks(
      20,
      new Date('2099-09-08T02:00:03.000Z'),
    );
    const firstEvent = await Promise.race([
      scanStartedSignal,
      receiptSentSignal,
    ]);
    releaseScan([]);
    await run;

    expect(firstEvent).toBe('receipt-card-sent');
  });

  it('writes an accepted decision before refreshing the syncing card', async () => {
    let current = record('rec-fast-approval', '标签纸');
    const events: string[] = [];
    const gateway = {
      getExecutionRecordAsApp: jest.fn(async () => ({ ...current })),
      updateExecutionRecordAsApp: jest.fn(async (_id: string, fields: Record<string, unknown>) => {
        if (fields['采购流程']) {
          events.push('decision-written');
          current = { ...current, status: String(fields['采购流程']), purchaseMethod: '综合采购' };
        }
      }),
      resolvePurchaseAdminAsApp: jest.fn(async () => ({ openId: 'ou_purchaser', name: '采购员' })),
      sendInteractiveCard: jest.fn(async () => 'om_fast_approval'),
      updateInteractiveCard: jest.fn(async () => { events.push('card-refreshed'); }),
    };
    const service = new PurchaseManagerApprovalService(gateway as never, store);
    await service.enqueueApprovalBatch({
      approvalBatchId: 'purchase-fast-approval',
      requesterOpenId: 'ou_requester',
      recordIds: [current.recordId],
    });
    await service.runAcceptedTasks(20, new Date('2099-09-08T02:00:01.000Z'));
    const batch = await store.findManagerApprovalBatch('purchase-fast-approval');
    await store.enqueueNotification({
      businessEventId: 'manager_batch_approval_refresh:purchase-fast-approval:queued',
      kind: 'manager_batch_approval_refresh',
      recordId: current.recordId,
      recipientOpenId: 'ou_manager',
      cardContext: batch!.cardContext,
    });
    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-fast-approval',
      operatorOpenId: 'ou_manager',
      messageId: 'om_fast_approval',
      action: 'approve_pending_comprehensive',
      approvalBatchId: 'purchase-fast-approval',
    });

    await service.runAcceptedTasks(1, new Date('2099-09-08T02:00:02.000Z'));

    expect(events).toEqual(['decision-written']);
    expect(await store.findManagerApprovalBatch('purchase-fast-approval')).toMatchObject({
      items: [expect.objectContaining({ status: 'approved' })],
    });
  });

  it('processes a newly accepted card task while a historical Base scan is blocked', async () => {
    const fixture = await approvedReceiptBatch();
    let releaseScan!: (records: PurchaseWorkflowRecord[]) => void;
    const blockedScan = new Promise<PurchaseWorkflowRecord[]>((resolve) => {
      releaseScan = resolve;
    });
    let scanStarted!: () => void;
    const scanStartedSignal = new Promise<void>((resolve) => {
      scanStarted = resolve;
    });
    fixture.gateway.listExecutionRecordsAsApp.mockImplementation(() => {
      scanStarted();
      return blockedScan;
    });

    const maintenanceRun = fixture.service.runPendingTasks(
      20,
      new Date('2099-09-08T02:00:03.000Z'),
    );
    await scanStartedSignal;
    fixture.markOrdered();
    await store.enqueueNotification({
      businessEventId: `manager_batch_receipt_requested:${fixture.approvalBatchId}`,
      recordId: fixture.executionRecordId,
      recipientOpenId: 'ou_requester',
      kind: 'manager_batch_receipt_requested',
      cardContext: fixture.batch.cardContext,
    });
    const sendsBeforeAcceptedRun =
      fixture.gateway.sendInteractiveCard.mock.calls.length;
    try {
      const acceptedRun = (
        fixture.service as PurchaseManagerApprovalService & {
          runAcceptedTasks(
            limit?: number,
            now?: Date,
          ): Promise<{ processed: number }>;
        }
      ).runAcceptedTasks(20, new Date('2099-09-08T02:00:04.000Z'));

      await expect(acceptedRun).resolves.toEqual(
        expect.objectContaining({ processed: 1 }),
      );
      expect(fixture.gateway.sendInteractiveCard.mock.calls.length).toBe(
        sendsBeforeAcceptedRun + 1,
      );
    } finally {
      releaseScan([]);
      await maintenanceRun;
    }
  });

  it('surfaces an unknown receipt delivery timeout without retrying a manual task', async () => {
    const fixture = await approvedReceiptBatch();
    fixture.markOrdered();
    const queued = await store.enqueueNotification({
      businessEventId: `manager_batch_receipt_requested:${fixture.approvalBatchId}`,
      recordId: fixture.executionRecordId,
      recipientOpenId: 'ou_requester',
      kind: 'manager_batch_receipt_requested',
      cardContext: fixture.batch.cardContext,
    });
    fixture.gateway.sendInteractiveCard.mockRejectedValueOnce(
      new Error('飞书发送结果未知'),
    );
    const sendResult = await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T02:00:03.000Z'),
    );
    expect(sendResult.failed).toBe(1);
    const sendsBeforeManual =
      fixture.gateway.sendInteractiveCard.mock.calls.length;

    const manualResult = await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T03:00:04.000Z'),
    );

    expect(manualResult).toMatchObject({
      failed: 0,
      manualReconciliation: 1,
      errors: [],
    });
    expect(fixture.gateway.sendInteractiveCard).toHaveBeenCalledTimes(
      sendsBeforeManual,
    );
    expect(await store.getNotification(queued.entry.key)).toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });
    await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T03:00:05.000Z'),
    );
    expect(fixture.gateway.sendInteractiveCard).toHaveBeenCalledTimes(
      sendsBeforeManual,
    );
  });

  it('automatically requeues a failed unattempted receipt delivery only once', async () => {
    const fixture = await approvedReceiptBatch();
    fixture.markOrdered();
    const queued = await store.enqueueNotification({
      businessEventId: `manager_batch_receipt_requested:${fixture.approvalBatchId}`,
      recordId: fixture.executionRecordId,
      recipientOpenId: 'ou_requester',
      kind: 'manager_batch_receipt_requested',
      cardContext: fixture.batch.cardContext,
    });
    const firstClaim = await store.takeNextManagerApprovalNotification(
      new Date('2099-09-08T02:00:03.000Z'),
    );
    expect(firstClaim?.key).toBe(queued.entry.key);
    await store.failNotification(
      firstClaim!.key,
      firstClaim!.claimToken,
      new Error('发送前卡片渲染失败'),
      new Date('2099-09-08T02:00:03.000Z'),
    );
    const definitiveRejection = Object.assign(new Error('飞书明确拒绝卡片'), {
      deliveryOutcome: 'rejected' as const,
    });
    fixture.gateway.sendInteractiveCard.mockRejectedValue(definitiveRejection);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fixture.service.runPendingTasks(
        1,
        new Date(Date.parse('2099-09-08T02:01:00.000Z') + attempt * 60_000),
      );
    }
    const sendsAfterExhaustion =
      fixture.gateway.sendInteractiveCard.mock.calls.length;
    await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T02:06:00.000Z'),
    );

    const receipt = await store.getNotification(queued.entry.key);
    expect(receipt).toMatchObject({
      status: 'failed',
      sendOutcome: 'unattempted',
    });
    expect(
      receipt?.deliveryAudit.filter(
        (entry) => entry.action === 'receipt_delivery_requeued',
      ),
    ).toHaveLength(1);
    expect(fixture.gateway.sendInteractiveCard).toHaveBeenCalledTimes(
      sendsAfterExhaustion,
    );
  });

  it('does not requeue a receipt after five definitive Feishu send rejections', async () => {
    const fixture = await approvedReceiptBatch();
    fixture.markOrdered();
    const queued = await store.enqueueNotification({
      businessEventId: `manager_batch_receipt_requested:${fixture.approvalBatchId}`,
      recordId: fixture.executionRecordId,
      recipientOpenId: 'ou_requester',
      kind: 'manager_batch_receipt_requested',
      cardContext: fixture.batch.cardContext,
    });
    const sendsBeforeReceipt =
      fixture.gateway.sendInteractiveCard.mock.calls.length;
    fixture.gateway.sendInteractiveCard.mockRejectedValue(
      Object.assign(new Error('飞书明确拒绝卡片'), {
        deliveryOutcome: 'rejected' as const,
      }),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fixture.service.runPendingTasks(
        1,
        new Date(Date.parse('2099-09-08T02:01:00.000Z') + attempt * 60_000),
      );
    }
    const receiptAfterExhaustion = await store.getNotification(
      queued.entry.key,
    );

    await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T02:06:00.000Z'),
    );

    expect(fixture.gateway.sendInteractiveCard).toHaveBeenCalledTimes(
      sendsBeforeReceipt + 5,
    );
    expect(receiptAfterExhaustion).toMatchObject({
      status: 'failed',
      sendOutcome: 'unattempted',
    });
    expect(await store.getNotification(queued.entry.key)).toMatchObject({
      status: 'failed',
      sendOutcome: 'unattempted',
    });
    expect(
      receiptAfterExhaustion?.deliveryAudit.filter(
        (entry) => entry.action === 'send_rejected',
      ),
    ).toHaveLength(5);
    expect(
      (await store.getNotification(queued.entry.key))?.deliveryAudit.filter(
        (entry) => entry.action === 'receipt_delivery_requeued',
      ),
    ).toHaveLength(0);
  });

  it('requeues the proven receipt form-name schema rejection exactly once after the fix', async () => {
    const fixture = await approvedReceiptBatch();
    fixture.markOrdered();
    const queued = await store.enqueueNotification({
      businessEventId: `manager_batch_receipt_requested:${fixture.approvalBatchId}`,
      recordId: fixture.executionRecordId,
      recipientOpenId: 'ou_requester',
      kind: 'manager_batch_receipt_requested',
      cardContext: fixture.batch.cardContext,
    });
    const rejectedDeliveryUuid = queued.entry.deliveryUuid;
    const sendsBeforeReceipt =
      fixture.gateway.sendInteractiveCard.mock.calls.length;
    fixture.gateway.sendInteractiveCard.mockRejectedValue(
      Object.assign(
        new Error(
          '发送采购审批互动卡失败：Failed to create card content, ext=ErrCode: 11310; ErrPath: ROOT -> body -> elements -> [5](tag: form); ErrMsg: name exceed the default maximum 100; ErrorValue: name;（错误码 230099）',
        ),
        { deliveryOutcome: 'rejected' as const },
      ),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fixture.service.runPendingTasks(
        1,
        new Date(Date.parse('2099-09-08T02:01:00.000Z') + attempt * 60_000),
      );
    }
    fixture.gateway.sendInteractiveCard.mockResolvedValue(
      'om_receipt_after_schema_fix',
    );

    await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T02:06:00.000Z'),
    );
    const recovered = await store.getNotification(queued.entry.key);
    expect(recovered).toMatchObject({
      status: 'completed',
      sendOutcome: 'delivered',
      messageId: 'om_receipt_after_schema_fix',
      deliveryGeneration: 2,
    });
    expect(recovered?.deliveryUuid).not.toBe(rejectedDeliveryUuid);
    expect(
      recovered?.deliveryAudit.filter(
        (entry) => entry.action === 'receipt_card_schema_requeued',
      ),
    ).toHaveLength(1);
    expect(fixture.gateway.sendInteractiveCard).toHaveBeenCalledTimes(
      sendsBeforeReceipt + 6,
    );

    await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T02:07:00.000Z'),
    );
    expect(fixture.gateway.sendInteractiveCard).toHaveBeenCalledTimes(
      sendsBeforeReceipt + 6,
    );
  });

  it('returns the persisted order command snapshot without re-reading notifications after acceptance', async () => {
    const fixture = await approvedReceiptBatch();
    const reads = jest.spyOn(store, 'listNotifications').mockRejectedValue(new Error('synthetic post-claim ledger queue is blocked'));
    try {
      const result = await fixture.service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action',
        eventId: 'evt-order-fast-ack',
        operatorOpenId: 'ou_purchase_admin',
        messageId: 'om_recovery_assignment',
        action: 'submit_order',
        approvalBatchId: fixture.approvalBatchId,
        executionRecordId: fixture.executionRecordId,
        actualQuantity: 3,
        actualAmount: 838.35,
        note: '测试下单',
      });
      expect(result.claimed).toBe(true);
      expect(JSON.stringify(result.card)).toContain('同步');
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
    const commands = await store.listNotifications({ kind: 'manager_batch_order_command' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ status: 'pending', recordId: fixture.executionRecordId });
  });

  it('accepts purchase submission with a single ledger read on a large notification history', async () => {
    const fixture = await approvedReceiptBatch();
    const file = join(directory, 'purchase-workflow-ledger.json');
    const ledger = JSON.parse(await readFile(file, 'utf8'));
    const timestamp = new Date().toISOString();
    ledger.notifications.push(...Array.from({ length: 866 - ledger.notifications.length }, (_, i) => ({
      businessEventId: `synthetic-history-${i}`, recordId: `rec_history_${i}`, recipientOpenId: 'ou_history',
      kind: 'purchase_completed', status: i < 360 ? 'pending' : 'completed', attempts: 1,
      createdAt: timestamp, updatedAt: timestamp, nextAttemptAt: timestamp, completedAt: i < 360 ? '' : timestamp,
      cardContext: JSON.stringify({ synthetic: 'x'.repeat(7600) }),
    })));
    const bytes = JSON.stringify(ledger, null, 2);
    await writeFile(file, bytes);
    const read = jest.spyOn(store as any, 'read');
    const samples: { ms: number; reads: number; claimed: boolean }[] = [];
    const execution = new FeishuCardActionExecution<{ claimed: boolean; card: Record<string, unknown> }>(() => {});
    try {
      for (let i = 0; i < 3; i += 1) {
        read.mockClear();
        const started = performance.now();
        const result = await execution.run({ syntheticSample: i }, () => fixture.service.handlePurchaseBatchFulfillmentCardAction({
          kind: 'purchase_batch_fulfillment_action', eventId: `evt-single-read-${i}`,
          operatorOpenId: 'ou_purchase_admin', messageId: 'om_recovery_assignment', action: 'submit_order',
          approvalBatchId: fixture.approvalBatchId, executionRecordId: fixture.executionRecordId,
          actualQuantity: 20, actualAmount: 1894.89, note: '',
        }));
        samples.push({ ms: performance.now() - started, reads: read.mock.calls.length, claimed: result.claimed });
      }
      const probe = process.env.NT_PURCHASE_SUBMIT_PROBE;
      if (probe && /^output\/approval-live-acceptance-20261022\/[a-z0-9-]+\.json$/.test(probe)) {
        await writeFile(probe, JSON.stringify({ syntheticOnly: true, bytes: Buffer.byteLength(bytes), notifications: 866, samples, cloudCallsDuringAcceptance: 0, limitations: 'Synthetic notification-dominant fixture, not production content/hardware or full callback P95.' }, null, 2), { flag: 'wx' });
      }
      expect(samples.map(sample => sample.reads)).toEqual([1, 1, 1]);
      expect(samples.map(sample => sample.claimed)).toEqual([true, false, false]);
    } finally { read.mockRestore(); }
  });

  it('exposes slow purchase ledger phases under production warn/error logging without payloads', async () => {
    const fixture = await approvedReceiptBatch();
    let clock = 1000;
    const originalRead = (store as any).read.bind(store);
    const read = jest.spyOn(store as any, 'read').mockImplementation(async () => { clock += 2800; return originalRead(); });
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const logger = new ConsoleLogger('TEST', { logLevels: ['warn', 'error'] });
    (fixture.service as any).logger = logger;
    const output = jest.spyOn(logger as any, 'printMessages').mockImplementation(() => {});
    try {
      await fixture.service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action', eventId: 'evt-slow-phases',
        operatorOpenId: 'ou_purchase_admin', messageId: 'om_recovery_assignment', action: 'submit_order',
        approvalBatchId: fixture.approvalBatchId, executionRecordId: fixture.executionRecordId,
        actualQuantity: 20, actualAmount: 1894.89, note: 'PRIVATE_DO_NOT_LOG',
      });
      const text = JSON.stringify(output.mock.calls);
      expect(text).toContain('readMs=2800');
      expect(text).toContain('writeMs=0');
      expect(text).toContain('totalMs=2800');
      expect(text).not.toContain('PRIVATE_DO_NOT_LOG');
      expect(text).not.toContain('1894.89');
      expect(text).not.toContain('ou_purchase_admin');
    } finally { now.mockRestore(); read.mockRestore(); output.mockRestore(); }
  });

  it('captures payment attachments from the same atomic read as the accepted order', async () => {
    const fixture = await approvedReceiptBatch();
    const file = join(directory, 'purchase-workflow-ledger.json');
    const originalClaim = store.claimPurchaseBatchFulfillmentCommand.bind(store);
    const claim = jest.spyOn(store, 'claimPurchaseBatchFulfillmentCommand').mockImplementation(async (...args) => {
      const ledger = JSON.parse(await readFile(file, 'utf8'));
      ledger.managerApprovalBatches.find((batch: any) => batch.approvalBatchId === fixture.approvalBatchId).items[0].paymentAttachmentTokens = ['file_latest_payment'];
      await writeFile(file, JSON.stringify(ledger));
      return originalClaim(...args);
    });
    try {
      await fixture.service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action', eventId: 'evt-atomic-attachment',
        operatorOpenId: 'ou_purchase_admin', messageId: 'om_recovery_assignment', action: 'submit_order',
        approvalBatchId: fixture.approvalBatchId, executionRecordId: fixture.executionRecordId,
        actualQuantity: 1, actualAmount: 10, note: '',
      });
    } finally { claim.mockRestore(); }
    const tasks = await store.listNotifications({ kind: 'manager_batch_order_command' });
    expect(tasks).toHaveLength(1);
    expect(JSON.parse(tasks[0].cardContext).paymentAttachmentTokens).toEqual(['file_latest_payment']);
  });

  it('returns a receipt acceptance snapshot without any post-claim notification reads', async () => {
    const fixture = await approvedReceiptBatch();
    await fixture.service.handlePurchaseBatchFulfillmentCardAction({
      kind: 'purchase_batch_fulfillment_action', eventId: 'evt-order-before-fast-receipt',
      operatorOpenId: 'ou_purchase_admin', messageId: 'om_recovery_assignment', action: 'submit_order',
      approvalBatchId: fixture.approvalBatchId, executionRecordId: fixture.executionRecordId,
      actualQuantity: 1, actualAmount: 10, note: '',
    });
    const order = await store.takeNextManagerApprovalNotification(new Date('2099-09-08T02:00:03.000Z'));
    await store.completePurchaseBatchFulfillmentCommandAndEnqueue(order!.key, order!.claimToken, [], new Date('2099-09-08T02:00:03.000Z'));
    fixture.markOrdered();
    await store.enqueueNotification({
      businessEventId: `manager_batch_receipt_requested:${fixture.approvalBatchId}`,
      recordId: fixture.executionRecordId,
      recipientOpenId: 'ou_requester',
      kind: 'manager_batch_receipt_requested',
      cardContext: fixture.batch.cardContext,
    });
    await fixture.service.runAcceptedTasks(20, new Date('2099-09-08T02:00:03.000Z'));
    await store.stagePurchaseBatchAttachments({
      approvalBatchId: fixture.approvalBatchId,
      executionRecordId: fixture.executionRecordId,
      actorOpenId: 'ou_requester', purpose: 'receipt',
      receiptPhotoTokens: ['file_test_receipt'],
    });
    const reads = jest.spyOn(store, 'listNotifications').mockRejectedValue(new Error('post-claim notification read must not run'));
    try {
      const result = await fixture.service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action', eventId: 'evt-receipt-fast-ack',
        operatorOpenId: 'ou_requester', messageId: 'om_recovery_receipt', action: 'submit_receipt',
        approvalBatchId: fixture.approvalBatchId, executionRecordId: fixture.executionRecordId,
        signerOpenId: 'ou_requester', receiptTime: Date.parse('2099-09-08T03:00:00Z'), note: '',
      });
      expect(result.claimed).toBe(true);
      expect(JSON.stringify(result.card)).toContain('同步');
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
    expect(await store.listNotifications({ kind: 'manager_batch_receipt_command' })).toHaveLength(1);
  });

  it('recovers one receipt card from an already ordered record with no follow-up task', async () => {
    const fixture = await approvedReceiptBatch();
    const requesterSendsBefore =
      fixture.gateway.sendInteractiveCard.mock.calls.filter(
        ([recipient]) => recipient === 'ou_requester',
      ).length;
    const action =
      await fixture.service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action',
        eventId: 'evt-order-before-receipt-recovery',
        operatorOpenId: 'ou_purchase_admin',
        messageId: 'om_recovery_assignment',
        action: 'submit_order',
        approvalBatchId: fixture.approvalBatchId,
        executionRecordId: fixture.executionRecordId,
        actualQuantity: 1,
        actualAmount: 10,
        note: '已下单',
      });
    expect(action.claimed).toBe(true);
    const command = await store.takeNextManagerApprovalNotification(
      new Date('2099-09-08T02:00:03.000Z'),
    );
    expect(command?.kind).toBe('manager_batch_order_command');
    await store.completePurchaseBatchFulfillmentCommandAndEnqueue(
      command!.key,
      command!.claimToken,
      [],
      new Date('2099-09-08T02:00:03.000Z'),
    );
    fixture.markOrdered();
    expect(
      await store.listNotifications({
        kind: 'manager_batch_receipt_requested',
      }),
    ).toEqual([]);

    await fixture.service.runPendingTasks(
      20,
      new Date('2099-09-08T02:00:04.000Z'),
    );
    await fixture.service.runPendingTasks(
      20,
      new Date('2099-09-08T02:00:05.000Z'),
    );

    const receipts = await store.listNotifications({
      kind: 'manager_batch_receipt_requested',
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: 'completed',
      sendOutcome: 'delivered',
      recipientOpenId: 'ou_requester',
      messageId: 'om_recovery_receipt',
    });
    expect(
      fixture.gateway.sendInteractiveCard.mock.calls.filter(
        ([recipient]) => recipient === 'ou_requester',
      ),
    ).toHaveLength(requesterSendsBefore + 1);
  });

  it('updates a fulfillment card view through the existing message patch channel', async () => {
    const gateway = {
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const card = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '采购到货待签收' } },
      body: { elements: [] },
    };

    await service.patchPurchaseBatchFulfillmentCardView(
      'om_purchase_receipt_01',
      card,
    );

    expect(gateway.updateInteractiveCard).toHaveBeenCalledWith(
      'om_purchase_receipt_01',
      card,
    );
  });

  it('uses the delayed callback update channel when Feishu supplies a token', async () => {
    const gateway = {
      updateInteractiveCard: jest.fn(),
      updateInteractiveCardAfterCallback: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const card = { schema: '2.0', config: { update_multi: true } };

    await service.patchPurchaseBatchFulfillmentCardView(
      'om_purchase_receipt_01',
      card,
      'c-receipt-01',
    );

    expect(gateway.updateInteractiveCardAfterCallback).toHaveBeenCalledWith(
      'c-receipt-01',
      card,
    );
    expect(gateway.updateInteractiveCard).not.toHaveBeenCalled();
  });

  it('falls back to the original message when a callback update token is rejected', async () => {
    const gateway = {
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
      updateInteractiveCardAfterCallback: jest
        .fn()
        .mockRejectedValue(new Error('callback update token rejected')),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const card = { schema: '2.0', config: { update_multi: true } };

    await service.patchPurchaseBatchFulfillmentCardView(
      'om_purchase_receipt_01',
      card,
      'c-receipt-01',
    );

    expect(gateway.updateInteractiveCard).toHaveBeenCalledWith(
      'om_purchase_receipt_01',
      card,
    );
  });

  it('continues other receipt copies and retries only the failed message update', async () => {
    const fixture = await approvedReceiptBatch();
    fixture.markOrdered();
    fixture.gateway.sendInteractiveCard
      .mockResolvedValueOnce('om_receipt_copy_1')
      .mockResolvedValueOnce('om_receipt_copy_2')
      .mockResolvedValueOnce('om_receipt_copy_3');
    await store.enqueueNotifications(
      ['primary', 'copy-2', 'copy-3'].map((suffix, index) => ({
        businessEventId:
          index === 0
            ? `manager_batch_receipt_requested:${fixture.approvalBatchId}`
            : `manager_batch_receipt_requested:${fixture.approvalBatchId}:${suffix}`,
        recordId: fixture.executionRecordId,
        recipientOpenId: 'ou_requester',
        kind: 'manager_batch_receipt_requested' as const,
        cardContext: fixture.batch.cardContext,
      })),
      new Date('2099-09-08T02:00:03.000Z'),
    );
    await fixture.service.runPendingTasks(
      3,
      new Date('2099-09-08T02:00:03.000Z'),
    );

    const updateCard = fixture.gateway.updateInteractiveCard as jest.Mock;
    updateCard.mockClear();
    updateCard.mockImplementation(async (messageId: string) => {
      if (messageId === 'om_receipt_copy_2') {
        throw new Error('copy 2 update failed');
      }
    });
    const refresh = await store.enqueueNotification(
      {
        businessEventId: `manager_batch_receipt_refresh:${fixture.approvalBatchId}:partial-failure`,
        recordId: fixture.executionRecordId,
        recipientOpenId: 'ou_requester',
        kind: 'manager_batch_receipt_refresh',
        cardContext: fixture.batch.cardContext,
      },
      new Date('2099-09-08T02:00:04.000Z'),
    );

    const firstRun = await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T02:00:04.000Z'),
    );

    expect(firstRun.failed).toBe(1);
    expect(updateCard.mock.calls.map(([messageId]) => messageId)).toEqual([
      'om_receipt_copy_1',
      'om_receipt_copy_2',
      'om_receipt_copy_3',
    ]);
    const pending = await store.getNotification(refresh.entry.key);
    expect(pending).toMatchObject({ status: 'pending' });
    expect(
      pending?.deliveryAudit
        .filter((entry) => (entry.action as string) === 'card_update_completed')
        .map((entry) => entry.messageId),
    ).toEqual(['om_receipt_copy_1', 'om_receipt_copy_3']);

    updateCard.mockClear();
    updateCard.mockResolvedValue(undefined);
    await fixture.service.runPendingTasks(
      1,
      new Date('2099-09-08T02:00:06.000Z'),
    );

    expect(updateCard.mock.calls.map(([messageId]) => messageId)).toEqual([
      'om_receipt_copy_2',
    ]);
    await expect(
      store.getNotification(refresh.entry.key),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('retries an unknown batch decision write without marking it manual or writing twice', async () => {
    const records = new Map<string, PurchaseWorkflowRecord>([
      ['rec-timeout-1', record('rec-timeout-1', '小米风扇')],
      ['rec-timeout-2', record('rec-timeout-2', '插线板')],
    ]);
    let rejectReconciliationRead = false;
    let firstDecisionWrite = true;
    const getExecutionRecordAsApp = jest.fn(async (recordId: string) => {
      if (rejectReconciliationRead) {
        rejectReconciliationRead = false;
        throw Object.assign(new Error('timeout of 8000ms exceeded'), {
          code: 'ECONNABORTED',
        });
      }
      return { ...records.get(recordId)! };
    });
    const updateDecision = jest.fn(
      async (recordId: string, patch: Record<string, unknown>) => {
        const current = records.get(recordId)!;
        const purchaser = Array.isArray(patch['采购人'])
          ? (patch['采购人'][0] as { id?: string } | undefined)?.id || ''
          : '';
        records.set(recordId, {
          ...current,
          status: (patch['采购流程'] as string) || current.status,
          purchaseMethod:
            (patch[
              '1️⃣物品采购方式'
            ] as PurchaseWorkflowRecord['purchaseMethod']) ||
            current.purchaseMethod,
          purchaserOpenId: purchaser || current.purchaserOpenId,
          purchaserName: purchaser ? '曹李培' : current.purchaserName,
          warehouseConfirmed:
            patch['库房确认'] === undefined
              ? current.warehouseConfirmed
              : patch['库房确认'] === true,
        });
        if (firstDecisionWrite) {
          firstDecisionWrite = false;
          rejectReconciliationRead = true;
          throw Object.assign(new Error('timeout of 8000ms exceeded'), {
            code: 'ECONNABORTED',
          });
        }
      },
    );
    const updateExecutionRecordAsApp = jest.fn(
      async (recordId: string, patch: Record<string, unknown>) => {
        if ('采购流程' in patch) {
          return updateDecision(recordId, patch);
        }
      },
    );
    const gateway = {
      getExecutionRecordAsApp,
      getManagerApprovalDecisionRecordAsApp: getExecutionRecordAsApp,
      updateExecutionRecordAsApp,
      updateManagerApprovalDecisionRecordAsApp: updateDecision,
      listExecutionRecordsAsApp: jest.fn(
        async () => [] as PurchaseWorkflowRecord[],
      ),
      ensureManagerApprovalFieldsAsApp: jest.fn(async () => undefined),
      resolvePurchaseAdminAsApp: jest.fn(async () => ({
        openId: 'ou_purchase_admin',
        name: '曹李培',
        positions: ['综合管理'],
        buildings: [],
      })),
      resolveBuildingSupervisorAsApp: jest.fn(),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_timeout_batch'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const approvalBatchId = 'purchase-application-timeout';
    await service.enqueueApprovalBatch({
      approvalBatchId,
      requesterOpenId: 'ou_requester',
      recordIds: [...records.keys()],
    });
    await service.runPendingTasks(20, new Date('2099-09-21T02:00:00.000Z'));
    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-timeout-comprehensive',
      operatorOpenId: 'ou_manager',
      messageId: 'om_timeout_batch',
      action: 'approve_pending_comprehensive',
      approvalBatchId,
    });

    const firstRun = await service.runPendingTasks(
      1,
      new Date('2099-09-21T02:00:01.000Z'),
    );

    expect(firstRun.manualReconciliation).toBe(0);
    expect(
      await store.listManagerApprovalBatchActions({ status: 'pending' }),
    ).toHaveLength(1);
    expect(await store.findManagerApprovalBatch(approvalBatchId)).toMatchObject(
      {
        state: 'processing',
        items: [
          expect.objectContaining({ status: 'processing' }),
          expect.objectContaining({ status: 'processing' }),
        ],
      },
    );

    await service.runPendingTasks(1, new Date('2099-09-21T02:00:03.000Z'));

    expect(await store.findManagerApprovalBatch(approvalBatchId)).toMatchObject(
      {
        state: 'resolved',
        items: [
          expect.objectContaining({ status: 'approved' }),
          expect.objectContaining({ status: 'approved' }),
        ],
      },
    );
    expect(updateDecision).toHaveBeenCalledTimes(2);
    expect(gateway.resolvePurchaseAdminAsApp).toHaveBeenCalledTimes(3);
    expect(
      updateExecutionRecordAsApp.mock.calls.filter(([, patch]) =>
        Object.prototype.hasOwnProperty.call(patch, '采购流程'),
      ),
    ).toHaveLength(0);
  });

  it('settles every remaining item in the same claim when one max-attempt write needs manual reconciliation', async () => {
    const records = new Map<string, PurchaseWorkflowRecord>([
      ['rec-manual-1', record('rec-manual-1', '小米风扇')],
      ['rec-manual-2', record('rec-manual-2', '插线板')],
    ]);
    let rejectReconciliationRead = false;
    const getDecision = jest.fn(async (recordId: string) => {
      if (rejectReconciliationRead) {
        rejectReconciliationRead = false;
        throw Object.assign(new Error('timeout of 8000ms exceeded'), {
          code: 'ECONNABORTED',
        });
      }
      return { ...records.get(recordId)! };
    });
    const updateDecision = jest.fn(
      async (recordId: string, patch: Record<string, unknown>) => {
        if (recordId === 'rec-manual-1') {
          rejectReconciliationRead = true;
          throw Object.assign(new Error('timeout of 8000ms exceeded'), {
            code: 'ECONNABORTED',
          });
        }
        const current = records.get(recordId)!;
        const purchaser = Array.isArray(patch['采购人'])
          ? (patch['采购人'][0] as { id?: string } | undefined)?.id || ''
          : '';
        records.set(recordId, {
          ...current,
          status: (patch['采购流程'] as string) || current.status,
          purchaseMethod:
            (patch[
              '1️⃣物品采购方式'
            ] as PurchaseWorkflowRecord['purchaseMethod']) ||
            current.purchaseMethod,
          purchaserOpenId: purchaser || current.purchaserOpenId,
          purchaserName: purchaser ? '曹李培' : current.purchaserName,
          warehouseConfirmed:
            patch['库房确认'] === undefined
              ? current.warehouseConfirmed
              : patch['库房确认'] === true,
        });
      },
    );
    const updateExecutionRecordAsApp = jest.fn(
      async (recordId: string, patch: Record<string, unknown>) => {
        if (Object.prototype.hasOwnProperty.call(patch, '采购流程')) {
          await updateDecision(recordId, patch);
        }
      },
    );
    const gateway = {
      getExecutionRecordAsApp: getDecision,
      getManagerApprovalDecisionRecordAsApp: getDecision,
      updateExecutionRecordAsApp,
      updateManagerApprovalDecisionRecordAsApp: updateDecision,
      listExecutionRecordsAsApp: jest.fn(
        async () => [] as PurchaseWorkflowRecord[],
      ),
      ensureManagerApprovalFieldsAsApp: jest.fn(async () => undefined),
      resolvePurchaseAdminAsApp: jest.fn(async () => ({
        openId: 'ou_purchase_admin',
        name: '曹李培',
        positions: ['综合管理'],
        buildings: [],
      })),
      resolveBuildingSupervisorAsApp: jest.fn(),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_manual_batch'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const approvalBatchId = 'purchase-application-manual';
    await service.enqueueApprovalBatch({
      approvalBatchId,
      requesterOpenId: 'ou_requester',
      recordIds: [...records.keys()],
    });
    await service.runPendingTasks(20, new Date('2099-09-21T03:00:00.000Z'));
    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-manual-comprehensive',
      operatorOpenId: 'ou_manager',
      messageId: 'om_manual_batch',
      action: 'approve_pending_comprehensive',
      approvalBatchId,
    });

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const claimed = await store.takeNextManagerApprovalBatchAction(
        new Date(`2099-09-21T03:00:0${attempt}.000Z`),
      );
      expect(claimed?.attempts).toBe(attempt);
      await store.rescheduleManagerApprovalBatchAction(
        claimed!.key,
        claimed!.claimToken,
        new Error('preparing max-attempt fixture'),
        new Date(`2099-09-21T03:00:0${attempt}.000Z`),
        new Date(`2099-09-21T03:00:0${attempt}.000Z`),
      );
    }

    const run = await service.runPendingTasks(
      1,
      new Date('2099-09-21T03:00:05.000Z'),
    );

    expect(run.manualReconciliation).toBe(1);
    expect(await store.findManagerApprovalBatch(approvalBatchId)).toMatchObject(
      {
        state: 'manual_reconciliation',
        items: [
          expect.objectContaining({ status: 'manual_reconciliation' }),
          expect.objectContaining({ status: 'approved' }),
        ],
      },
    );
    expect(
      await store.listManagerApprovalBatchActions({
        status: 'manual_reconciliation',
      }),
    ).toHaveLength(1);
    expect(updateDecision.mock.calls.map(([recordId]) => recordId)).toEqual([
      'rec-manual-1',
      'rec-manual-2',
    ]);
    expect(gateway.resolvePurchaseAdminAsApp).toHaveBeenCalledTimes(2);
  });

  it('recovers the known pre-write organization parsing failure after the resolver is fixed', async () => {
    const executionRecordId = 'rec-org-parser-recovery';
    let current = record(executionRecordId, '便签纸');
    const getDecision = jest.fn(async () => ({ ...current }));
    const updateDecision = jest.fn(
      async (_recordId: string, patch: Record<string, unknown>) => {
        const purchaser = Array.isArray(patch['采购人'])
          ? (patch['采购人'][0] as { id?: string } | undefined)?.id || ''
          : '';
        current = {
          ...current,
          status: (patch['采购流程'] as string) || current.status,
          purchaseMethod:
            (patch[
              '1️⃣物品采购方式'
            ] as PurchaseWorkflowRecord['purchaseMethod']) ||
            current.purchaseMethod,
          purchaserOpenId: purchaser || current.purchaserOpenId,
          purchaserName: purchaser ? '曹李培' : current.purchaserName,
          warehouseConfirmed:
            patch['库房确认'] === undefined
              ? current.warehouseConfirmed
              : patch['库房确认'] === true,
        };
      },
    );
    let resolverFixed = false;
    const resolvePurchaseAdminAsApp = jest.fn(async () => {
      if (!resolverFixed) {
        throw new Error('采购人员字段包含多个不同人员');
      }
      return {
        openId: 'ou_purchase_admin',
        name: '曹李培',
        positions: ['综合管理'],
        buildings: ['综合'],
      };
    });
    const gateway = {
      getExecutionRecordAsApp: getDecision,
      getManagerApprovalDecisionRecordAsApp: getDecision,
      updateExecutionRecordAsApp: updateDecision,
      updateManagerApprovalDecisionRecordAsApp: updateDecision,
      listExecutionRecordsAsApp: jest.fn(
        async () => [] as PurchaseWorkflowRecord[],
      ),
      ensureManagerApprovalFieldsAsApp: jest.fn(async () => undefined),
      resolvePurchaseAdminAsApp,
      resolveBuildingSupervisorAsApp: jest.fn(),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValue('om_org_parser_recovery'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const approvalBatchId = 'purchase-application-org-parser-recovery';
    await service.enqueueApprovalBatch({
      approvalBatchId,
      requesterOpenId: 'ou_requester',
      recordIds: [executionRecordId],
    });
    await service.runPendingTasks(20, new Date('2099-09-21T04:00:00.000Z'));
    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-org-parser-recovery',
      operatorOpenId: 'ou_manager',
      messageId: 'om_org_parser_recovery',
      action: 'approve_pending_comprehensive',
      approvalBatchId,
    });
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const claimed = await store.takeNextManagerApprovalBatchAction(
        new Date(`2099-09-21T04:00:0${attempt}.000Z`),
      );
      await store.rescheduleManagerApprovalBatchAction(
        claimed!.key,
        claimed!.claimToken,
        new Error('采购人员字段包含多个不同人员'),
        new Date(`2099-09-21T04:00:0${attempt}.000Z`),
        new Date(`2099-09-21T04:00:0${attempt}.000Z`),
      );
    }
    await service.runPendingTasks(1, new Date('2099-09-21T04:00:05.000Z'));
    expect(
      await store.listManagerApprovalBatchActions({
        status: 'manual_reconciliation',
      }),
    ).toHaveLength(1);

    resolverFixed = true;
    await service.runPendingTasks(20, new Date('2099-09-21T04:00:06.000Z'));

    expect(await store.findManagerApprovalBatch(approvalBatchId)).toMatchObject(
      {
        state: 'resolved',
        items: [
          expect.objectContaining({
            status: 'approved',
            purchaserOpenId: 'ou_purchase_admin',
            purchaserName: '曹李培',
          }),
        ],
      },
    );
    expect(current).toMatchObject({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_purchase_admin',
      purchaserName: '曹李培',
    });
  });

  it('sends one manager card, supports one item reject, then approves the remainder', async () => {
    const records = new Map<string, PurchaseWorkflowRecord>([
      [
        'rec-1',
        {
          ...record('rec-1', '门牌'),
          createdAt: null,
          procurementForm: '单一采购',
          singleReason: '原系统配件兼容，只能向原厂采购',
        },
      ],
      ['rec-2', { ...record('rec-2', '标签纸'), createdAt: null }],
    ]);
    records.set('rec-2', {
      ...records.get('rec-2')!,
      purchaseMethod: '需求自采',
      ...({
        purchaseLinks: ['https://item.jd.com/100000000001.html'],
      } as Record<string, unknown>),
    });
    const gateway = {
      getExecutionRecordAsApp: jest.fn(async (recordId: string) => ({
        ...records.get(recordId)!,
      })),
      updateExecutionRecordAsApp: jest.fn(
        async (recordId: string, patch: Record<string, unknown>) => {
          const current = records.get(recordId)!;
          const purchaser = Array.isArray(patch['采购人'])
            ? (patch['采购人'][0] as { id?: string } | undefined)?.id || ''
            : '';
          records.set(recordId, {
            ...current,
            purchaseMethod:
              (patch[
                '1️⃣物品采购方式'
              ] as PurchaseWorkflowRecord['purchaseMethod']) ||
              current.purchaseMethod,
            status: (patch['采购流程'] as string) || current.status,
            rejectionReason:
              patch['驳回原因'] === undefined
                ? current.rejectionReason
                : (patch['驳回原因'] as string),
            purchaserOpenId: purchaser || current.purchaserOpenId,
            purchaserName: purchaser ? '采购管理员' : current.purchaserName,
            warehouseConfirmed:
              patch['库房确认'] === undefined
                ? current.warehouseConfirmed
                : patch['库房确认'] === true,
          });
        },
      ),
      resolvePurchaseAdminAsApp: jest.fn(async () => ({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: ['采购管理'],
        buildings: [],
      })),
      resolveBuildingSupervisorAsApp: jest.fn(),
      resolveUserAsApp: jest.fn(async (openId: string) => ({
        openId,
        name: openId === 'ou_receipt_signer' ? '现场签收人' : '',
        positions: [],
        buildings: [],
      })),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValueOnce('om_batch_1')
        .mockResolvedValueOnce('om_result_1')
        .mockResolvedValueOnce('om_assignment_1')
        .mockResolvedValue('om_receipt_1'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
      downloadMessageImage: jest.fn(async () => ({
        originalname: 'receipt.jpg',
        mimetype: 'image/jpeg',
        size: 3,
        buffer: Buffer.from('img'),
      })),
      getTenantAccessTokenAsApp: jest.fn(async () => 'tenant-token'),
      uploadAttachment: jest.fn(async () => 'file_receipt_photo'),
    };
    const workflowService = {
      orderFromCard: jest.fn(
        async (
          recordId: string,
          _actorOpenId: string,
          input: {
            actualQuantity: number;
            actualAmount: number;
            note: string;
          },
        ) => {
          records.set(recordId, {
            ...records.get(recordId)!,
            status: '下单完成（待签收）',
            actualQuantity: input.actualQuantity,
            actualAmount: input.actualAmount,
            note: input.note,
            purchaseCompleted: true,
          });
          return { idempotent: false, notificationWarnings: [] };
        },
      ),
      receiveFromCard: jest.fn(
        async (
          recordId: string,
          _actorOpenId: string,
          input: { signer: string; signerOpenId: string; receiptTime: number },
        ) => {
          records.set(recordId, {
            ...records.get(recordId)!,
            status: '到货已签收（待入库）',
            receiptConfirmed: true,
            signer: input.signer,
            signerOpenId: input.signerOpenId,
            receiptTime: input.receiptTime,
          });
          return { idempotent: false, notificationWarnings: [] };
        },
      ),
    };
    const submissionTaskLedger = {
      findByTaskId: jest.fn(() => ({
        task: { createdAt: '2026-09-08T02:00:00.000Z' },
      })),
      listCompletedTasksWithCreatedRecords: jest.fn(() => []),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
      submissionTaskLedger as never,
      workflowService as never,
    );

    await service.enqueueApprovalBatch({
      approvalBatchId: 'purchase-application-task-1',
      requesterOpenId: 'ou_requester',
      recordIds: ['rec-1', 'rec-2'],
    });
    await service.runPendingTasks(20, new Date('2099-09-08T02:00:01.000Z'));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard.mock.calls[0]?.[0]).toBe('ou_manager');
    const approvalCard = JSON.stringify(
      gateway.sendInteractiveCard.mock.calls[0]?.[1],
    );
    expect(approvalCard).toContain('门牌&#45;SPEC');
    expect(approvalCard).toContain('单一采购原因');
    expect(approvalCard).toContain('原系统配件兼容，只能向原厂采购');
    expect(approvalCard).toContain('2026&#45;09&#45;08 10&#58;00');
    expect(approvalCard).toContain('2026&#45;09&#45;20');
    expect(approvalCard).not.toContain('T02&#58;00&#58;00.000Z');
    expect(approvalCard).not.toContain('T00&#58;00&#58;00.000Z');

    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-open-reject',
      operatorOpenId: 'ou_manager',
      messageId: 'om_batch_1',
      action: 'open_item_reject',
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-1',
    });
    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-reject',
      operatorOpenId: 'ou_manager',
      messageId: 'om_batch_1',
      action: 'submit_item_reject',
      rejectionReason: '规格不符',
    });
    await service.runPendingTasks(20, new Date('2099-09-08T02:00:02.000Z'));

    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-approve-rest',
      operatorOpenId: 'ou_manager',
      messageId: 'om_batch_1',
      action: 'approve_pending_comprehensive',
      approvalBatchId: 'purchase-application-task-1',
    });
    await service.runPendingTasks(20, new Date('2099-09-08T02:00:03.000Z'));

    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(4);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({
        采购工作流状态: '已驳回',
        采购当前审批人: [],
        采购实际审批人: [{ id: 'ou_manager' }],
        采购审批动作标识: 'evt-reject',
      }),
    );
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec-2',
      expect.objectContaining({
        采购工作流状态: '已通过',
        采购当前审批人: [],
        采购实际审批人: [{ id: 'ou_manager' }],
        采购审批动作标识: 'evt-approve-rest',
      }),
    );
    expect(records.get('rec-1')).toMatchObject({
      status: '驳回申请',
      rejectionReason: '规格不符',
    });
    expect(records.get('rec-2')).toMatchObject({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_purchase_admin',
      warehouseConfirmed: true,
    });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(3);
    expect(gateway.sendInteractiveCard.mock.calls[1]?.[0]).toBe('ou_requester');
    expect(gateway.sendInteractiveCard.mock.calls[2]?.[0]).toBe(
      'ou_purchase_admin',
    );
    const requesterResultCard = JSON.stringify(
      gateway.sendInteractiveCard.mock.calls[1]?.[1],
    );
    expect(requesterResultCard).toContain('门牌');
    expect(requesterResultCard).toContain('标签纸');
    expect(requesterResultCard).toContain('规格不符');
    const purchaserAssignmentCard = JSON.stringify(
      gateway.sendInteractiveCard.mock.calls[2]?.[1],
    );
    expect(purchaserAssignmentCard).toContain('标签纸');
    expect(purchaserAssignmentCard).not.toContain('门牌');
    expect(purchaserAssignmentCard).not.toContain('规格不符');
    expect(gateway.updateInteractiveCard).toHaveBeenCalledTimes(2);
    expect(
      await store.findManagerApprovalBatch('purchase-application-task-1'),
    ).toMatchObject({
      state: 'resolved',
      items: [
        expect.objectContaining({ purchaserOpenId: '' }),
        expect.objectContaining({
          purchaserOpenId: 'ou_purchase_admin',
          purchaserName: '采购管理员',
          authorityTarget: { building: 'H楼', specialty: '电气' },
        }),
      ],
    });

    const readsBeforeOpenOrder =
      gateway.getExecutionRecordAsApp.mock.calls.length;
    gateway.getExecutionRecordAsApp.mockImplementationOnce(async () => {
      throw new Error('open_order callback must not read Feishu Base');
    });
    const openOrder = await service.handlePurchaseBatchFulfillmentCardAction({
      kind: 'purchase_batch_fulfillment_action',
      eventId: 'evt-open-order-rec-2',
      operatorOpenId: 'ou_purchase_admin',
      messageId: 'om_assignment_1',
      action: 'open_order',
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-2',
    });
    expect(openOrder.claimed).toBe(false);
    expect(JSON.stringify(openOrder.card)).toContain(
      'purchase_batch_order_submit:purchase-application-task-1:rec-2',
    );
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(
      readsBeforeOpenOrder,
    );
    expect(purchaserAssignmentCard).toContain(
      'https://item.jd.com/100000000001.html',
    );

    await store.stagePurchaseBatchAttachments({
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-2',
      actorOpenId: 'ou_purchase_admin',
      purpose: 'payment',
      paymentAttachmentTokens: ['file_payment_attachment'],
    });
    const orderAction = await service.handlePurchaseBatchFulfillmentCardAction({
      kind: 'purchase_batch_fulfillment_action',
      eventId: 'evt-order-rec-2',
      operatorOpenId: 'ou_purchase_admin',
      messageId: 'om_assignment_1',
      action: 'submit_order',
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-2',
      actualQuantity: 2,
      actualAmount: 19.8,
      note: '已下单',
    });
    expect(orderAction.claimed).toBe(true);
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(
      readsBeforeOpenOrder,
    );
    gateway.getExecutionRecordAsApp
      .mockReset()
      .mockImplementation(async (recordId: string) => ({
        ...records.get(recordId)!,
      }));
    const orderRun = await service.runPendingTasks(
      20,
      new Date('2099-09-08T02:00:04.000Z'),
    );
    expect(orderRun.errors).toEqual([]);
    expect(workflowService.orderFromCard).toHaveBeenCalledWith(
      'rec-2',
      'ou_purchase_admin',
      expect.objectContaining({
        actualQuantity: 2,
        actualAmount: 19.8,
        paymentAttachmentTokens: ['file_payment_attachment'],
      }),
      { notificationKey: expect.stringContaining('manager_batch_order_command:'), claimToken: expect.any(String) },
    );
    expect(gateway.sendInteractiveCard.mock.calls[3]?.[0]).toBe('ou_requester');

    const readsBeforeOpenReceipt =
      gateway.getExecutionRecordAsApp.mock.calls.length;
    gateway.getExecutionRecordAsApp.mockImplementationOnce(async () => {
      throw new Error('open_receipt callback must not read Feishu Base');
    });
    const updatesBeforeOpenReceipt =
      gateway.updateInteractiveCard.mock.calls.length;
    const openReceipt = await service.handlePurchaseBatchFulfillmentCardAction({
      kind: 'purchase_batch_fulfillment_action',
      eventId: 'evt-open-receipt-rec-2',
      operatorOpenId: 'ou_requester',
      messageId: 'om_receipt_1',
      action: 'open_receipt',
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-2',
    });
    expect(openReceipt.claimed).toBe(false);
    expect(JSON.stringify(openReceipt.card)).toContain(
      'purchase_batch_receipt_submit:purchase-application-task-1:rec-2',
    );
    expect(JSON.stringify(openReceipt.card)).toContain('19.8');
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(
      readsBeforeOpenReceipt,
    );
    expect(gateway.updateInteractiveCard).toHaveBeenCalledTimes(
      updatesBeforeOpenReceipt,
    );

    await service.handlePurchaseBatchFulfillmentCardAction({
      kind: 'purchase_batch_fulfillment_action',
      eventId: 'evt-prepare-receipt-photo-rec-2',
      operatorOpenId: 'ou_requester',
      messageId: 'om_receipt_1',
      action: 'prepare_receipt_photo',
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-2',
    });
    await service.handlePurchaseReceiptImageMessage({
      schema: '2.0',
      event_type: 'im.message.receive_v1',
      event_id: 'evt-receipt-image-rec-2',
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_requester' },
      },
      message: {
        message_id: 'om_image_rec_2',
        chat_id: 'oc_requester_direct',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_receipt_rec_2' }),
      },
    });
    await service.runPendingTasks(20, new Date('2099-09-08T02:00:05.000Z'));
    expect(gateway.downloadMessageImage).toHaveBeenCalledWith(
      'om_image_rec_2',
      'img_v3_receipt_rec_2',
    );
    expect(gateway.uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ mimetype: 'image/jpeg' }),
      'tenant-token',
    );
    expect(
      await store.findManagerApprovalBatch('purchase-application-task-1'),
    ).toMatchObject({
      items: [
        expect.any(Object),
        expect.objectContaining({
          receiptPhotoTokens: ['file_receipt_photo'],
          invoiceTokens: [],
        }),
      ],
    });
    const readsBeforeReceiptSubmit =
      gateway.getExecutionRecordAsApp.mock.calls.length;
    const receiptAction =
      await service.handlePurchaseBatchFulfillmentCardAction({
        kind: 'purchase_batch_fulfillment_action',
        eventId: 'evt-receipt-rec-2',
        operatorOpenId: 'ou_requester',
        messageId: 'om_receipt_1',
        action: 'submit_receipt',
        approvalBatchId: 'purchase-application-task-1',
        executionRecordId: 'rec-2',
        signerOpenId: 'ou_receipt_signer',
        receiptTime: Date.parse('2099-09-08T03:00:00.000Z'),
        note: '数量无误',
      });
    expect(receiptAction.claimed).toBe(true);
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(
      readsBeforeReceiptSubmit,
    );
    gateway.getExecutionRecordAsApp
      .mockReset()
      .mockImplementation(async (recordId: string) => ({
        ...records.get(recordId)!,
      }));
    await service.runPendingTasks(20, new Date('2099-09-08T03:00:01.000Z'));
    expect(workflowService.receiveFromCard).toHaveBeenCalledWith(
      'rec-2',
      'ou_requester',
      expect.objectContaining({
        signer: '现场签收人',
        signerOpenId: 'ou_receipt_signer',
        receiptPhotoTokens: ['file_receipt_photo'],
      }),
      { notificationKey: expect.stringContaining('manager_batch_receipt_command:'), claimToken: expect.any(String) },
    );
    const purchaserNotices = await store.listNotifications({
      kind: 'manager_batch_receipt_completed',
      recipientOpenId: 'ou_purchase_admin',
    });
    expect(purchaserNotices).toHaveLength(1);
    expect(purchaserNotices[0]).toMatchObject({
      businessEventId:
        'manager_batch_receipt_completed:purchase-application-task-1:rec-2',
      recordId: 'rec-2',
      status: 'completed',
    });

    const purchaserReceiptCalls = gateway.sendInteractiveCard.mock.calls.filter(
      ([recipient]) => recipient === 'ou_purchase_admin',
    );
    expect(purchaserReceiptCalls).toHaveLength(2);
    const purchaserReceiptCard = JSON.stringify(purchaserReceiptCalls[1]?.[1]);
    expect(purchaserReceiptCard).toContain('采购签收完成');
    expect(purchaserReceiptCard).toContain('现场签收人');
    expect(purchaserReceiptCard).not.toContain('behaviors');

    await service.runPendingTasks(20, new Date('2099-09-08T03:00:02.000Z'));
    expect(
      gateway.sendInteractiveCard.mock.calls.filter(
        ([recipient]) => recipient === 'ou_purchase_admin',
      ),
    ).toHaveLength(2);
  }, 60_000);

  it('routes one building-self batch to the matching building supervisor and notifies the requester', async () => {
    let current = {
      ...record('rec-a', '应急灯'),
      building: 'A楼',
    };
    const gateway = {
      getExecutionRecordAsApp: jest.fn(async () => ({ ...current })),
      updateExecutionRecordAsApp: jest.fn(
        async (_recordId: string, patch: Record<string, unknown>) => {
          const purchaser = Array.isArray(patch['采购人'])
            ? (patch['采购人'][0] as { id?: string } | undefined)?.id || ''
            : '';
          current = {
            ...current,
            purchaseMethod:
              (patch[
                '1️⃣物品采购方式'
              ] as PurchaseWorkflowRecord['purchaseMethod']) ||
              current.purchaseMethod,
            status: (patch['采购流程'] as string) || current.status,
            purchaserOpenId: purchaser || current.purchaserOpenId,
            purchaserName: purchaser ? '示例人员009' : current.purchaserName,
            warehouseConfirmed:
              patch['库房确认'] === undefined
                ? current.warehouseConfirmed
                : patch['库房确认'] === true,
          };
        },
      ),
      resolvePurchaseAdminAsApp: jest.fn(),
      resolveBuildingSupervisorAsApp: jest.fn(async () => ({
        openId: 'ou_supervisor_a',
        name: '示例人员009',
        positions: ['设施运维示例人员001'],
        buildings: ['A楼'],
      })),
      resolveUserAsApp: jest.fn(),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValueOnce('om_building_batch')
        .mockResolvedValueOnce('om_building_result')
        .mockResolvedValueOnce('om_building_assignment'),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const submissionTaskLedger = {
      findByTaskId: jest.fn(() => ({
        task: { createdAt: '2026-09-08T02:00:00.000Z' },
      })),
      listCompletedTasksWithCreatedRecords: jest.fn(() => []),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
      submissionTaskLedger as never,
      {} as never,
    );

    await service.enqueueApprovalBatch({
      approvalBatchId: 'purchase-application-building-a',
      requesterOpenId: 'ou_requester',
      recordIds: ['rec-a'],
    });
    await service.runPendingTasks(20, new Date('2099-09-08T02:00:01.000Z'));
    await service.handleManagerBatchCardAction({
      kind: 'manager_batch_action',
      eventId: 'evt-approve-building-a',
      operatorOpenId: 'ou_manager',
      messageId: 'om_building_batch',
      action: 'approve_pending_building_self',
      approvalBatchId: 'purchase-application-building-a',
    });
    const run = await service.runPendingTasks(
      20,
      new Date('2099-09-08T02:00:02.000Z'),
    );

    expect(run.errors).toEqual([]);
    expect(gateway.resolveBuildingSupervisorAsApp).toHaveBeenCalledWith('A楼', '电气');
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(3);
    expect(gateway.sendInteractiveCard.mock.calls[1]?.[0]).toBe('ou_requester');
    expect(gateway.sendInteractiveCard.mock.calls[2]?.[0]).toBe(
      'ou_supervisor_a',
    );
    expect(
      JSON.stringify(gateway.sendInteractiveCard.mock.calls[2]?.[1]),
    ).toContain('应急灯');
    expect(current).toMatchObject({
      status: '审批通过（待下单）',
      purchaseMethod: '需求自采',
      purchaserOpenId: 'ou_supervisor_a',
      purchaserName: '示例人员009',
    });
  });
});
