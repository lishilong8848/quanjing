jest.mock(
  '@server/common/config/external-services.config',
  () => ({ readEnv: jest.fn((name: string) => process.env[name] || '') }),
  { virtual: true },
);

import { ServiceUnavailableException } from '@nestjs/common';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';

const session = {
  accessToken: 'u-user-token',
  openId: 'ou_manager',
  userName: '测试经理',
};
const originalEnv = process.env;

describe('purchase workflow real Base self-test safety', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects the legacy self-test without touching Base when the program workflow is disabled', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const gateway = {
      probeDeleteCapability: jest.fn(),
      createExecutionRecord: jest.fn(),
      updateExecutionRecord: jest.fn(),
      deleteExecutionRecord: jest.fn(),
      uploadAttachment: jest.fn(),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    await expect(service.selfTest(session)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(gateway.probeDeleteCapability).not.toHaveBeenCalled();
    expect(gateway.createExecutionRecord).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
    expect(gateway.deleteExecutionRecord).not.toHaveBeenCalled();
    expect(gateway.uploadAttachment).not.toHaveBeenCalled();
  });

  it('reuses one isolated health-check sentinel when delete scope is unavailable', async () => {
    const pending = workflowRecord('rec-sentinel', '未开始（待审批）');
    const approved = workflowRecord('rec-sentinel', '审批通过（待库房确认）');
    const ordering = workflowRecord('rec-sentinel', '库房确认（待下单）', {
      purchaserOpenId: 'ou_buyer',
      purchaserName: '采购员',
    });
    const receipt = workflowRecord('rec-sentinel', '下单完成（待签收）', {
      purchaserOpenId: 'ou_buyer',
      purchaserName: '采购员',
      receiptPhotoTokens: ['file-sentinel-photo'],
    });
    const gateway = {
      probeDeleteCapability: jest.fn().mockResolvedValue({
        allowed: false,
        reason: '缺少 base:record:delete',
      }),
      createExecutionRecord: jest.fn(),
      searchSelfTestRecordIds: jest
        .fn()
        .mockResolvedValueOnce(['rec-sentinel'])
        .mockResolvedValueOnce(['rec-sentinel']),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      findComprehensivePurchaser: jest.fn().mockResolvedValue({
        openId: 'ou_buyer',
        name: '采购员',
        positions: ['综合管理'],
        buildings: [],
      }),
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(approved)
        .mockResolvedValueOnce(ordering)
        .mockResolvedValueOnce(receipt),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      uploadAttachment: jest.fn(),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    const result = await service.selfTest(session);

    expect(result.passed).toBe(true);
    expect(result.createdRecordIds).toEqual([]);
    expect(result.remainingRecordIds).toEqual([]);
    expect(result.checks[0]).toMatchObject({
      name: '清理策略',
      passed: true,
    });
    expect(gateway.createExecutionRecord).not.toHaveBeenCalled();
    expect(gateway.uploadAttachment).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledWith(
      'rec-sentinel',
      expect.objectContaining({ 采购流程: '驳回申请' }),
      'u-user-token',
    );
  });

  it('always deletes exact created IDs and verifies zero residue', async () => {
    const pending = workflowRecord('rec-selftest', '未开始（待审批）');
    const approved = workflowRecord('rec-selftest', '审批通过（待库房确认）');
    const ordering = workflowRecord('rec-selftest', '库房确认（待下单）', {
      purchaserOpenId: 'ou_buyer',
      purchaserName: '采购员',
    });
    const receipt = workflowRecord('rec-selftest', '下单完成（待签收）', {
      purchaserOpenId: 'ou_buyer',
      purchaserName: '采购员',
    });
    const gateway = {
      probeDeleteCapability: jest.fn().mockResolvedValue({ allowed: true, reason: '' }),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      findComprehensivePurchaser: jest.fn().mockResolvedValue({
        openId: 'ou_buyer',
        name: '采购员',
        positions: ['综合管理'],
        buildings: [],
      }),
      createExecutionRecord: jest.fn().mockResolvedValue('rec-selftest'),
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(approved)
        .mockResolvedValueOnce(ordering)
        .mockResolvedValueOnce(receipt),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      uploadAttachment: jest.fn().mockResolvedValue('file-selftest-photo'),
      deleteExecutionRecord: jest.fn().mockResolvedValue(undefined),
      searchSelfTestRecordIds: jest.fn().mockResolvedValue([]),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    const result = await service.selfTest(session);

    expect(result.passed).toBe(true);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(4);
    expect(gateway.deleteExecutionRecord).toHaveBeenCalledWith(
      'rec-selftest',
      'u-user-token',
    );
    expect(result.createdRecordIds).toEqual(['rec-selftest']);
    expect(result.deletedRecordIds).toEqual(['rec-selftest']);
    expect(result.remainingRecordIds).toEqual([]);
  });

  it('reports residue when cleanup fails instead of claiming success', async () => {
    const gateway = {
      probeDeleteCapability: jest.fn().mockResolvedValue({ allowed: true, reason: '' }),
      resolveUser: jest.fn().mockRejectedValue(new Error('自测中断')),
      createExecutionRecord: jest.fn().mockResolvedValue('rec-leftover'),
      deleteExecutionRecord: jest.fn().mockRejectedValue(new Error('删除失败')),
      searchSelfTestRecordIds: jest.fn().mockResolvedValue(['rec-leftover']),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    const result = await service.selfTest(session);

    expect(result.passed).toBe(false);
    expect(result.remainingRecordIds).toEqual(['rec-leftover']);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '清理测试记录', passed: false }),
      ]),
    );
  });
});

function workflowRecord(
  recordId: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    recordId,
    requestCode: 'CODEX-PURCHASE-WORKFLOW-SELFTEST-001',
    status,
    itemName: '采购流程自测物品',
    building: 'H楼',
    requesterOpenId: 'ou_manager',
    requesterName: '测试经理',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '综合采购',
    requestedQuantity: 1,
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
