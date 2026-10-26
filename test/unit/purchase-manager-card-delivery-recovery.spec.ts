jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: jest.fn((name: string) => process.env[name] || ''),
}));

import { BadGatewayException } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  serializePurchaseManagerBatchApprovalCardContext,
  type PurchaseManagerBatchApprovalCardInput,
} from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { PurchaseManagerApprovalService as ActualPurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
const PurchaseManagerApprovalService = withSyntheticBusinessIdentity(ActualPurchaseManagerApprovalService, 5);
type PurchaseManagerApprovalService = ActualPurchaseManagerApprovalService;
import {
  PURCHASE_MANAGER_APPROVAL_POLICY_VERSION,
  PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION,
} from '../../server/modules/purchase-inventory/purchase-manager-approval.fields';
import type { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const originalEnv = { ...process.env };
const batchId = 'purchase-application-legacy-card-1';
const recordId = 'rec_legacy_card_1';
const baseTime = new Date('2026-09-11T01:00:00.000Z');

function record(
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId,
    requestCode: 'CG260911-001',
    status: '未开始（待审批）',
    itemName: '历史待审批物品',
    specification: '/',
    building: 'H楼',
    requesterOpenId: 'ou_requester',
    requesterName: '申请人',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '',
    requestedQuantity: 1,
    unit: '件',
    unitPrice: 10,
    createdAt: baseTime.getTime() - 60_000,
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
    approvalSource: '程序卡片',
    approvalWorkflowStatus: '同步异常',
    approvalBatchId: batchId,
    approvalCardDeliveryStatus: '送达待核对',
    approvalCardMessageId: '',
    approvalPolicyVersion: PURCHASE_MANAGER_APPROVAL_POLICY_VERSION,
    ...overrides,
  };
}

function cardContext(): string {
  const input: PurchaseManagerBatchApprovalCardInput = {
    version: 3,
    approvalBatchId: batchId,
    requesterName: '申请人',
    requesterOpenId: 'ou_requester',
    building: 'H楼',
    requestCode: 'CG260911-001',
    expectedDeliveryAt: null,
    createdAt: new Date(baseTime.getTime() - 60_000).toISOString(),
    items: [
      {
        executionRecordId: recordId,
        title: '历史待审批物品',
        specification: '/',
        quantity: '1',
        unit: '件',
        amount: '10.00',
        status: 'pending',
        choice: '',
        rejectionReason: '',
      },
    ],
  };
  return serializePurchaseManagerBatchApprovalCardContext(input);
}

function definitiveRejection(): BadGatewayException & {
  deliveryOutcome: 'rejected';
  feishuCode: number;
  httpStatus: number;
} {
  return Object.assign(
    new BadGatewayException(
      '发送采购审批互动卡失败：unsupported tag note（错误码 230099）',
    ),
    {
      deliveryOutcome: 'rejected' as const,
      feishuCode: 230099,
      httpStatus: 400,
    },
  );
}

describe('purchase manager card delivery recovery', () => {
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
    directory = await mkdtemp(join(tmpdir(), 'purchase-card-recovery-'));
    ledgerPath = join(directory, 'purchase-workflow-ledger.json');
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('caps definitive Feishu rejections without converting them to unknown delivery', async () => {
    const current = record();
    const gateway = {
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(current),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockRejectedValue(definitiveRejection()),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: batchId,
        requesterOpenId: current.requesterOpenId,
        recipientOpenId: 'ou_manager',
        recordIds: [recordId],
      },
      baseTime,
    );

    for (const seconds of [0, 1, 3, 7, 15]) {
      await service.runPendingTasks(
        20,
        new Date(baseTime.getTime() + seconds * 1000),
      );
    }

    const notification = (
      await store.listNotifications({
        kind: 'manager_batch_approval_requested',
      })
    )[0];
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(5);
    expect(notification).toMatchObject({
      status: 'failed',
      attempts: 5,
      sendOutcome: 'unattempted',
      firstSendAttemptAt: '',
      lastError: expect.stringContaining('230099'),
    });

    const later = await service.runPendingTasks(
      20,
      new Date(baseTime.getTime() + 3_600_000),
    );
    expect(later.manualReconciliation).toBe(0);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(5);
  });

  it('caps an HTTP 200 Feishu business rejection without entering unknown delivery', async () => {
    const current = record();
    const businessRejection = Object.assign(
      new BadGatewayException(
        '发送采购审批互动卡失败：business rejected（错误码 230099）',
      ),
      {
        deliveryOutcome: 'rejected' as const,
        feishuCode: 230099,
        httpStatus: 200,
      },
    );
    const gateway = {
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(current),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockRejectedValue(businessRejection),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: batchId,
        requesterOpenId: current.requesterOpenId,
        recipientOpenId: 'ou_manager',
        recordIds: [recordId],
      },
      baseTime,
    );

    for (const seconds of [0, 1, 3, 7, 15]) {
      await service.runPendingTasks(
        20,
        new Date(baseTime.getTime() + seconds * 1000),
      );
    }

    const notification = (
      await store.listNotifications({
        kind: 'manager_batch_approval_requested',
      })
    )[0];
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(5);
    expect(notification).toMatchObject({
      status: 'failed',
      attempts: 5,
      sendOutcome: 'unattempted',
      firstSendAttemptAt: '',
      lastError: expect.stringContaining('230099'),
    });
  });

  it('rebuilds edited card context while replaying one proven legacy invalid-card batch', async () => {
    const current = record({
      itemName: '历史待审批物品（已编辑）',
      specification: '新规格',
      unitPrice: 12,
      approvalPolicyVersion:
        PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION,
      approvalWorkflowError: 'Request failed with status code 400',
    });
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: batchId,
        requesterOpenId: current.requesterOpenId,
        recipientOpenId: 'ou_manager',
        recordIds: [recordId],
      },
      baseTime,
    );
    const claimed = await store.takeNextManagerApprovalNotification(baseTime);
    expect(claimed).not.toBeNull();
    const anchored = await store.markManagerApprovalBatchSendStarted(
      claimed!.key,
      claimed!.claimToken,
      cardContext(),
      baseTime,
    );
    const legacyDeliveryUuid = anchored!.deliveryUuid;
    await store.rescheduleNotification(
      claimed!.key,
      claimed!.claimToken,
      new Error('Request failed with status code 400'),
      new Date(baseTime.getTime() + 1000),
      baseTime,
    );
    await expect(
      store.takeNextManagerApprovalNotification(
        new Date(baseTime.getTime() + 3_600_001),
      ),
    ).resolves.toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });

    await store.onModuleDestroy();
    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      notifications: Array<{
        kind: string;
        deliveryAudit: Array<{ action: string }>;
      }>;
    };
    const legacy = persisted.notifications.find(
      (entry) => entry.kind === 'manager_batch_approval_requested',
    );
    expect(legacy).toBeDefined();
    legacy!.deliveryAudit = legacy!.deliveryAudit.filter(
      (entry) => entry.action !== 'card_schema_v2_compatible',
    );
    await writeFile(
      ledgerPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      'utf8',
    );
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();

    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([current]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(current),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_replayed_once'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    const replayAt = new Date(baseTime.getTime() + 3_600_002);

    await service.runPendingTasks(20, replayAt);

    const delivered = (
      await store.listNotifications({
        kind: 'manager_batch_approval_requested',
      })
    )[0];
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(delivered).toMatchObject({
      status: 'completed',
      sendOutcome: 'delivered',
      messageId: 'om_replayed_once',
      deliveryGeneration: 2,
    });
    expect(delivered?.deliveryUuid).not.toBe(legacyDeliveryUuid);
    const replayedCard = JSON.stringify(
      gateway.sendInteractiveCard.mock.calls[0]?.[1],
    );
    expect(replayedCard).toContain('历史待审批物品（已编辑）');
    expect(replayedCard).toContain('新规格');
    expect(delivered?.deliveryAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'legacy_card_schema_requeued' }),
        expect.objectContaining({ action: 'card_schema_v2_compatible' }),
      ]),
    );

    await service.runPendingTasks(20, new Date(replayAt.getTime() + 60_000));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
  });

  it('does not rotate or replay a response-lost delivery without proven legacy rejection evidence', async () => {
    const current = record({
      approvalPolicyVersion:
        PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION,
      approvalWorkflowError: 'read ECONNRESET',
    });
    await store.registerManagerApprovalBatch(
      {
        approvalBatchId: batchId,
        requesterOpenId: current.requesterOpenId,
        recipientOpenId: 'ou_manager',
        recordIds: [recordId],
      },
      baseTime,
    );
    const claimed = await store.takeNextManagerApprovalNotification(baseTime);
    const anchored = await store.markManagerApprovalBatchSendStarted(
      claimed!.key,
      claimed!.claimToken,
      cardContext(),
      baseTime,
    );
    await store.rescheduleNotification(
      claimed!.key,
      claimed!.claimToken,
      new Error('read ECONNRESET'),
      new Date(baseTime.getTime() + 1000),
      baseTime,
    );
    await store.onModuleDestroy();
    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      notifications: Array<{
        kind: string;
        deliveryAudit: Array<{ action: string }>;
      }>;
    };
    const responseLost = persisted.notifications.find(
      (entry) => entry.kind === 'manager_batch_approval_requested',
    );
    responseLost!.deliveryAudit = responseLost!.deliveryAudit.filter(
      (entry) => entry.action !== 'card_schema_v2_compatible',
    );
    await writeFile(
      ledgerPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      'utf8',
    );
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();

    await expect(
      store.takeNextManagerApprovalNotification(
        new Date(baseTime.getTime() + 3_600_001),
      ),
    ).resolves.toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
    });

    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([current]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(current),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_must_not_send'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date(baseTime.getTime() + 3_600_002));

    const notification = (
      await store.listNotifications({
        kind: 'manager_batch_approval_requested',
      })
    )[0];
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(notification).toMatchObject({
      status: 'manual_reconciliation',
      sendOutcome: 'manual_reconciliation',
      deliveryGeneration: 1,
      deliveryUuid: anchored!.deliveryUuid,
    });
  });
});
