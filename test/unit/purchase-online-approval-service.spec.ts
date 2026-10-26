import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  PurchaseWorkflowMethod,
  PurchaseWorkflowRecord,
} from '../../shared/purchase-workflow.interface';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';

const PURCHASE_METHOD_FIELD = '1️⃣物品采购方式';
const WORKFLOW_STATUS_FIELD = '采购流程';
const RETIRED_APPROVAL_FIELDS = [
  '2️⃣审批已完成（无需点击）',
  '2️⃣审批通过（无需点击）',
  '2️⃣审批驳回（无需点击）',
] as const;

describe('PurchaseOnlineApprovalService', () => {
  it.each([
    '综合采购',
    '需求自采',
    '需求自采（楼内）',
  ] as PurchaseWorkflowMethod[])(
    'approves a pending %s request through the existing Base trigger fields',
    async (purchaseMethod) => {
      const gateway = createGateway();
      gateway.getExecutionRecordAsApp.mockResolvedValue(
        workflowRecord({ purchaseMethod }),
      );
      const service = new PurchaseOnlineApprovalService(gateway as never);

      await expect(
        service.decide('  rec_execution_1  ', { decision: 'approved' }),
      ).resolves.toMatchObject({
        recordId: 'rec_execution_1',
        decision: 'approved',
        idempotent: false,
      });

      expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledWith(
        'rec_execution_1',
      );
      expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
      expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
        'rec_execution_1',
        {
          [PURCHASE_METHOD_FIELD]: purchaseMethod,
          [WORKFLOW_STATUS_FIELD]: '审批通过（待下单）',
        },
      );
      const fields = gateway.updateExecutionRecordAsApp.mock.calls[0][1];
      for (const field of RETIRED_APPROVAL_FIELDS) {
        expect(fields).not.toHaveProperty(field);
      }
      expect(gateway.sendTextNotification).not.toHaveBeenCalled();
      expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    },
  );

  it('rejects a pending request through the existing Base trigger fields', async () => {
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockResolvedValue(workflowRecord());
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(
      service.decide('rec_execution_1', { decision: 'rejected' }),
    ).resolves.toMatchObject({
      recordId: 'rec_execution_1',
      decision: 'rejected',
      idempotent: false,
    });

    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec_execution_1',
      {
        [PURCHASE_METHOD_FIELD]: '驳回',
        [WORKFLOW_STATUS_FIELD]: '驳回申请',
      },
    );
    const fields = gateway.updateExecutionRecordAsApp.mock.calls[0][1];
    for (const field of RETIRED_APPROVAL_FIELDS) {
      expect(fields).not.toHaveProperty(field);
    }
    expect(gateway.sendTextNotification).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('checks the building again before a scoped online approval writes', async () => {
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockResolvedValue(workflowRecord({ building: 'B楼' }));
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(service.decide('rec_execution_1', { decision: 'approved' }, 'A楼'))
      .rejects.toMatchObject({ status: 403 });
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it('finishes a partially applied rejection instead of treating it as complete', async () => {
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockResolvedValue(
      workflowRecord({
        purchaseMethod: '驳回',
        approvalCompleted: false,
      }),
    );
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(
      service.decide('rec_execution_1', { decision: 'rejected' }),
    ).resolves.toMatchObject({ idempotent: false });
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec_execution_1',
      {
        [PURCHASE_METHOD_FIELD]: '驳回',
        [WORKFLOW_STATUS_FIELD]: '驳回申请',
      },
    );
  });

  it('accepts a page decision immediately and completes it in the background', async () => {
    let releaseRead: ((record: PurchaseWorkflowRecord) => void) | undefined;
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockImplementation(
      () =>
        new Promise<PurchaseWorkflowRecord>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const service = new PurchaseOnlineApprovalService(gateway as never);

    const accepted = service.acceptDecision('rec_execution_1', {
      decision: 'rejected',
    });

    expect(accepted).toMatchObject({ pending: true });
    expect(accepted.taskId).toMatch(/^purchase-approval-/);
    expect(service.getDecisionTaskStatus(accepted.taskId)).toMatchObject({
      success: true,
      task: { status: 'pending', decision: 'rejected' },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(service.getDecisionTaskStatus(accepted.taskId)).toMatchObject({
      task: { status: 'running' },
    });

    releaseRead?.(workflowRecord());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.getDecisionTaskStatus(accepted.taskId)).toMatchObject({
      task: {
        status: 'completed',
        result: { decision: 'rejected', resultLabel: '已驳回' },
      },
    });
  });

  it('returns an approved retry as idempotent without writing Feishu again', async () => {
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockResolvedValue(
      workflowRecord({ approvalCompleted: true }),
    );
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(
      service.decide('rec_execution_1', { decision: 'approved' }),
    ).resolves.toMatchObject({
      recordId: 'rec_execution_1',
      decision: 'approved',
      idempotent: true,
    });
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it('returns a rejected retry as idempotent without writing Feishu again', async () => {
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockResolvedValue(
      workflowRecord({
        purchaseMethod: '驳回',
        approvalCompleted: true,
      }),
    );
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(
      service.decide('rec_execution_1', { decision: 'rejected' }),
    ).resolves.toMatchObject({
      recordId: 'rec_execution_1',
      decision: 'rejected',
      idempotent: true,
    });
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it.each([
    ['approved', 'rejected', '综合采购'],
    ['rejected', 'approved', '驳回'],
  ] as const)(
    'rejects changing an already %s decision to %s',
    async (_currentDecision, requestedDecision, purchaseMethod) => {
      const gateway = createGateway();
      gateway.getExecutionRecordAsApp.mockResolvedValue(
        workflowRecord({
          purchaseMethod,
          approvalCompleted: true,
        }),
      );
      const service = new PurchaseOnlineApprovalService(gateway as never);

      await expect(
        service.decide('rec_execution_1', { decision: requestedDecision }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    },
  );

  it('does not approve a record whose purchase method is already rejected', async () => {
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockResolvedValue(
      workflowRecord({
        purchaseMethod: '驳回',
        approvalCompleted: false,
      }),
    );
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(
      service.decide('rec_execution_1', { decision: 'approved' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it.each(['', '临时采购'])(
    'rejects an approval with unsupported purchase method %p before writing',
    async (purchaseMethod) => {
      const gateway = createGateway();
      gateway.getExecutionRecordAsApp.mockResolvedValue(
        workflowRecord({
          purchaseMethod: purchaseMethod as PurchaseWorkflowMethod,
        }),
      );
      const service = new PurchaseOnlineApprovalService(gateway as never);

      await expect(
        service.decide('rec_execution_1', { decision: 'approved' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['blank record id', '   ', { decision: 'approved' }],
    ['unknown decision', 'rec_execution_1', { decision: 'approve' }],
    ['missing decision', 'rec_execution_1', {}],
  ])(
    'rejects %s before reading or writing Feishu',
    async (_label, id, input) => {
      const gateway = createGateway();
      const service = new PurchaseOnlineApprovalService(gateway as never);

      await expect(service.decide(id, input as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
      expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    },
  );

  it('propagates a Feishu read failure without attempting a write', async () => {
    const upstreamError = new ServiceUnavailableException(
      '读取采购执行记录失败',
    );
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockRejectedValue(upstreamError);
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(
      service.decide('rec_execution_1', { decision: 'approved' }),
    ).rejects.toBe(upstreamError);
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it('serializes duplicate concurrent approvals and writes Feishu only once', async () => {
    let state = workflowRecord();
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockImplementation(async () => ({
      ...state,
    }));
    gateway.updateExecutionRecordAsApp.mockImplementation(
      async (_recordId: string, fields: Record<string, unknown>) => {
        state = {
          ...state,
          purchaseMethod: fields[
            PURCHASE_METHOD_FIELD
          ] as PurchaseWorkflowMethod,
          status: String(fields[WORKFLOW_STATUS_FIELD] ?? state.status),
        };
      },
    );
    const service = new PurchaseOnlineApprovalService(gateway as never);

    const results = await Promise.all([
      service.decide('rec_execution_1', { decision: 'approved' }),
      service.decide('rec_execution_1', { decision: 'approved' }),
    ]);

    expect(results.map((result) => result.idempotent)).toEqual([false, true]);
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(2);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
  });

  it('serializes opposite concurrent decisions so only the first can win', async () => {
    let state = workflowRecord();
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockImplementation(async () => ({
      ...state,
    }));
    gateway.updateExecutionRecordAsApp.mockImplementation(
      async (_recordId: string, fields: Record<string, unknown>) => {
        state = {
          ...state,
          purchaseMethod: fields[
            PURCHASE_METHOD_FIELD
          ] as PurchaseWorkflowMethod,
          status: String(fields[WORKFLOW_STATUS_FIELD] ?? state.status),
        };
      },
    );
    const service = new PurchaseOnlineApprovalService(gateway as never);

    const results = await Promise.allSettled([
      service.decide('rec_execution_1', { decision: 'approved' }),
      service.decide('rec_execution_1', { decision: 'rejected' }),
    ]);

    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.any(ConflictException),
    });
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(2);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
  });

  it('propagates a Feishu write failure instead of reporting success', async () => {
    const upstreamError = new ServiceUnavailableException(
      '更新采购执行记录失败',
    );
    const gateway = createGateway();
    gateway.getExecutionRecordAsApp.mockResolvedValue(workflowRecord());
    gateway.updateExecutionRecordAsApp.mockRejectedValue(upstreamError);
    const service = new PurchaseOnlineApprovalService(gateway as never);

    await expect(
      service.decide('rec_execution_1', { decision: 'approved' }),
    ).rejects.toBe(upstreamError);
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
  });
});

function createGateway() {
  return {
    getExecutionRecordAsApp: jest.fn(),
    updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    sendTextNotification: jest.fn(),
    sendInteractiveCard: jest.fn(),
  };
}

function workflowRecord(
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId: 'rec_execution_1',
    requestCode: '刘小杏-羊角锤-2026/07/21',
    status: '未开始（待审批）',
    itemName: '羊角锤',
    building: 'H楼',
    requesterOpenId: 'ou_requester',
    requesterName: '刘小杏',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '综合采购',
    requestedQuantity: 1,
    unit: '件',
    unitPrice: 10,
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
