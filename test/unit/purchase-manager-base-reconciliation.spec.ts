jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: jest.fn((name: string) => process.env[name] || ''),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PurchaseManagerApprovalService as ActualPurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
const PurchaseManagerApprovalService = withSyntheticBusinessIdentity(ActualPurchaseManagerApprovalService, 5);
type PurchaseManagerApprovalService = ActualPurchaseManagerApprovalService;
import type { PurchaseApplicationTaskLedgerStore } from '../../server/modules/purchase-inventory/purchase-application-task-ledger.store';
import type { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const originalEnv = { ...process.env };

function pendingRecord(
  recordId: string,
  itemName: string,
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId,
    requestCode: 'CG260910-001',
    status: '未开始（待审批）',
    itemName,
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
    createdAt: Date.parse('2026-09-10T02:00:00.000Z'),
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
    ...overrides,
  };
}

describe('purchase manager approval Base reconciliation', () => {
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
    directory = await mkdtemp(join(tmpdir(), 'purchase-base-reconcile-'));
    ledgerPath = join(directory, 'purchase-workflow-ledger.json');
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('discovers pending Base rows, groups one request into one card, and records program approval fields', async () => {
    const records = [
      pendingRecord('rec-1', '便条纸'),
      pendingRecord('rec-2', '尖嘴钳'),
      pendingRecord('rec-3', '防臭排水管'),
      pendingRecord('rec-finished', '已处理', {
        status: '审批通过（待下单）',
      }),
    ];
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      getExecutionRecordAsApp: jest.fn(async (recordId: string) =>
        records.find((item) => item.recordId === recordId),
      ),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_manager_batch'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-10T02:01:00.000Z'));

    expect(gateway.ensureManagerApprovalFieldsAsApp).toHaveBeenCalledTimes(1);
    expect(gateway.listExecutionRecordsAsApp).toHaveBeenCalledWith(
      'CurrentValue.[采购流程]="未开始（待审批）"',
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_manager',
      expect.any(Object),
      expect.any(String),
    );
    expect(
      gateway.sendInteractiveCard.mock.invocationCallOrder[0],
    ).toBeLessThan(
      gateway.updateExecutionRecordAsApp.mock.invocationCallOrder[0]!,
    );
    expect(await store.listManagerApprovalBatchIds()).toHaveLength(1);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(3);
    for (const recordId of ['rec-1', 'rec-2', 'rec-3']) {
      expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
        recordId,
        expect.objectContaining({
          采购审批来源: '程序卡片',
          采购工作流状态: '待经理审批',
          采购当前审批人: [{ id: 'ou_manager' }],
          采购审批策略版本: 'purchase-manager-card-v2',
          采购审批批次号: expect.stringMatching(/^purchase-base-/u),
          采购工作流错误: '',
          采购卡片投递状态: '已送达',
          采购卡片消息标识: 'om_manager_batch',
          采购卡片投递标识: expect.any(String),
          采购卡片投递次数: 1,
        }),
      );
    }
  });

  it('waits for an accepted application batch to finish before routing all of its rows in one card', async () => {
    const approvalBatchId = 'purchase-application-task-aggregate-1';
    const records = [pendingRecord('rec-1', '便条纸', { approvalBatchId })];
    let taskStatus: 'running' | 'completed' = 'running';
    const submissionTaskLedger = {
      listCompletedTasksWithCreatedRecords: jest.fn(() => []),
      findByTaskId: jest.fn(() => ({
        task: {
          id: approvalBatchId,
          status: taskStatus,
          message: '采购申请后台同步中',
          createdAt: '2026-09-10T02:00:00.000Z',
        },
      })),
    };
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn(async () => [...records]),
      getExecutionRecordAsApp: jest.fn(async (recordId: string) =>
        records.find((item) => item.recordId === recordId),
      ),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_manager_batch'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
      submissionTaskLedger as unknown as PurchaseApplicationTaskLedgerStore,
    );

    await service.runPendingTasks(20, new Date('2026-09-10T02:01:00.000Z'));

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(await store.listManagerApprovalBatchIds()).toEqual([]);

    records.push(pendingRecord('rec-2', '尖嘴钳', { approvalBatchId }));
    taskStatus = 'completed';
    await service.runPendingTasks(20, new Date('2026-09-10T02:02:00.000Z'));

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(await store.listManagerApprovalBatchIds()).toEqual([
      approvalBatchId,
    ]);
    const cardText = JSON.stringify(
      gateway.sendInteractiveCard.mock.calls[0]?.[1],
    );
    expect(cardText).toContain('便条纸');
    expect(cardText).toContain('尖嘴钳');
  });

  it('does not send a duplicate card after repeated polling or worker restart', async () => {
    const records = [pendingRecord('rec-1', '便条纸')];
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      getExecutionRecordAsApp: jest.fn(async () => records[0]),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_manager_batch'),
    };
    let service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-10T02:01:00.000Z'));
    await service.runPendingTasks(20, new Date('2026-09-10T02:02:00.000Z'));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);

    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(ledgerPath);
    await store.onModuleInit();
    service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );
    await service.runPendingTasks(20, new Date('2026-09-10T02:03:00.000Z'));

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(await store.listManagerApprovalBatchIds()).toHaveLength(1);
  });

  it('does not recreate a local delivery when Base already holds a delivered message receipt', async () => {
    const records = [
      pendingRecord('rec-delivered', '已送达物品', {
        approvalSource: '程序卡片',
        approvalWorkflowStatus: '待经理审批',
        approvalBatchId: 'purchase-base-delivered',
        approvalCardDeliveryStatus: '已送达',
        approvalCardMessageId: 'om_existing_delivery',
      }),
    ];
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      getExecutionRecordAsApp: jest.fn(),
      updateExecutionRecordAsApp: jest.fn(),
      sendInteractiveCard: jest.fn(),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-10T02:01:00.000Z'));

    expect(await store.listManagerApprovalBatchIds()).toEqual([]);
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('rebuilds a missing local delivery outbox for a Base row already marked as routed', async () => {
    const records = [
      pendingRecord('rec-routed', '已路由物品', {
        approvalSource: '程序卡片',
        approvalWorkflowStatus: '待经理审批',
        approvalBatchId: 'purchase-base-existing',
      }),
    ];
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(records[0]),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_recovered_batch'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-10T02:01:00.000Z'));

    expect(await store.listManagerApprovalBatchIds()).toEqual([
      'purchase-base-existing',
    ]);
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledWith('rec-routed');
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec-routed',
      expect.objectContaining({
        采购审批批次号: 'purchase-base-existing',
        采购卡片投递状态: '已送达',
        采购卡片消息标识: 'om_recovered_batch',
      }),
    );
  });

  it('keeps an unknown card delivery visible instead of resetting it to pending approval', async () => {
    const records = [pendingRecord('rec-unknown', '未知送达物品')];
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(records[0]),
      updateExecutionRecordAsApp: jest.fn(
        async (_recordId: string, fields: Record<string, unknown>) => {
          records[0] = {
            ...records[0]!,
            approvalWorkflowStatus: String(fields['采购工作流状态'] || ''),
          };
        },
      ),
      sendInteractiveCard: jest
        .fn()
        .mockRejectedValue(new Error('network result unknown')),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    await service.runPendingTasks(20, new Date('2026-09-10T02:01:00.000Z'));
    await service.runPendingTasks(20, new Date('2026-09-10T03:01:01.000Z'));

    expect(records[0]?.approvalWorkflowStatus).toBe('同步异常');
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenLastCalledWith(
      'rec-unknown',
      expect.objectContaining({
        采购工作流状态: '同步异常',
        采购卡片投递状态: '送达待核对',
      }),
    );
  });

  it('shows a card delivery error in Base and clears it before a safe retry', async () => {
    const records = [pendingRecord('rec-1', '便条纸')];
    const gateway = {
      ensureManagerApprovalFieldsAsApp: jest.fn().mockResolvedValue(undefined),
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      getExecutionRecordAsApp: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary read failure'))
        .mockImplementation(async () => ({ ...records[0] })),
      updateExecutionRecordAsApp: jest.fn(
        async (_recordId: string, fields: Record<string, unknown>) => {
          records[0] = {
            ...records[0]!,
            approvalWorkflowStatus: String(fields['采购工作流状态'] || ''),
          };
        },
      ),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_manager_batch'),
    };
    const service = new PurchaseManagerApprovalService(
      gateway as unknown as PurchaseWorkflowGateway,
      store,
    );

    const first = await service.runPendingTasks(
      20,
      new Date('2026-09-10T02:01:00.000Z'),
    );
    expect(first.failed).toBeGreaterThan(0);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({
        采购工作流状态: '同步异常',
        采购工作流错误: 'temporary read failure',
      }),
    );

    await service.runPendingTasks(20, new Date('2099-09-10T02:02:00.000Z'));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(records[0]?.approvalWorkflowStatus).toBe('待经理审批');
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({
        采购工作流状态: '待经理审批',
        采购工作流错误: '',
      }),
    );
  });
});
