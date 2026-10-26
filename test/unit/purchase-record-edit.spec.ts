import { BadRequestException } from '@nestjs/common';
import { PurchaseRecordEditService } from '../../server/modules/purchase-inventory/purchase-record-edit.service';

describe('PurchaseRecordEditService', () => {
  it('maps one anomaly repair to the fixed submission and execution tables', async () => {
    const gateway = {
      updateSubmissionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseRecordEditService(gateway as never);

    await expect(
      service.updateRecord('rec_submission_1', {
        submissionRecordId: 'rec_submission_1',
        executionRecordId: 'rec_execution_1',
        fields: {
          itemName: '冷塔电加热温度传感器',
          quantity: 2,
          unit: '只',
          building: 'A楼',
          supplier: '暂无',
          expectedArrival: '2026-07-20',
          notes: '异常数据补录',
          requesterOpenId: 'ou_requester_1',
        },
      }),
    ).resolves.toMatchObject({
      updatedSubmissionRecord: true,
      updatedExecutionRecord: true,
    });

    expect(gateway.updateSubmissionRecordAsApp).toHaveBeenCalledWith(
      'rec_submission_1',
      {
        新增物品名称: '冷塔电加热温度传感器',
        采购数量: 2,
        单位: '只',
        '申请楼栋（多楼请选H楼，备注里填写详情）': 'A楼',
        供应商: '暂无',
        期望交付时间: new Date('2026-07-20T00:00:00+08:00').getTime(),
        其他备注: '异常数据补录',
        业务申请人: [{ id: 'ou_requester_1' }],
      },
    );
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec_execution_1',
      {
        物品名称: '冷塔电加热温度传感器',
        采购申请数量: 2,
        计数单位: '只',
        申请楼栋: ['A楼'],
        供应商: '暂无',
        期望交付时间: new Date('2026-07-20T00:00:00+08:00').getTime(),
        '需求备注（提交人)': '异常数据补录',
        需求人: [{ id: 'ou_requester_1' }],
      },
    );
  });

  it('rejects a route record id that does not belong to the payload', async () => {
    const gateway = {
      updateSubmissionRecord: jest.fn(),
      updateExecutionRecord: jest.fn(),
    };
    const service = new PurchaseRecordEditService(gateway as never);

    await expect(
      service.updateRecord('rec_other', {
        submissionRecordId: 'rec_submission_1',
        executionRecordId: null,
        fields: { quantity: 1 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.updateSubmissionRecord).not.toHaveBeenCalled();
  });

  it('rejects empty or invalid repair values before calling Feishu', async () => {
    const gateway = {
      updateSubmissionRecord: jest.fn(),
      updateExecutionRecord: jest.fn(),
    };
    const service = new PurchaseRecordEditService(gateway as never);

    await expect(
      service.updateRecord('rec_submission_1', {
        submissionRecordId: 'rec_submission_1',
        executionRecordId: null,
        fields: { itemName: ' ', quantity: 0, building: 'X楼' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.updateSubmissionRecord).not.toHaveBeenCalled();
  });

  it('allows a globally authorized editor to change status through app identity', async () => {
    const gateway = {
      updateSubmissionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseRecordEditService(gateway as never);

    await service.updateRecord('rec_execution_1', {
      submissionRecordId: 'rec_submission_1',
      executionRecordId: 'rec_execution_1',
      fields: { status: 'approval' },
    });

    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec_execution_1',
      expect.objectContaining({
        采购流程: '未开始（待审批）',
        '到货签收确认（签收内容填写完成后点击）': false,
        采购完成: false,
        库房确认: false,
        签收时间: null,
      }),
    );
    const fields = gateway.updateExecutionRecordAsApp.mock.calls[0][1];
    expect(fields).not.toHaveProperty('下单时间');
    expect(fields).not.toHaveProperty('2️⃣审批已完成（无需点击）');
    expect(fields).not.toHaveProperty('2️⃣审批通过（无需点击）');
    expect(fields).not.toHaveProperty('2️⃣审批驳回（无需点击）');
  });

  it('does not require a second password to advance a record to stocked', async () => {
    const gateway = {
      updateSubmissionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseRecordEditService(gateway as never);

    await service.updateRecord('rec_execution_1', {
      submissionRecordId: 'rec_submission_1',
      executionRecordId: 'rec_execution_1',
      fields: { status: 'stocked' },
    });

    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec_execution_1',
      expect.objectContaining({
        采购流程: '采购完成（已入库）',
        '到货签收确认（签收内容填写完成后点击）': true,
        采购完成: true,
        库房确认: true,
      }),
    );
    const fields = gateway.updateExecutionRecordAsApp.mock.calls[0][1];
    expect(fields).not.toHaveProperty('下单时间');
    expect(fields).not.toHaveProperty('2️⃣审批已完成（无需点击）');
    expect(fields).not.toHaveProperty('2️⃣审批通过（无需点击）');
    expect(fields).not.toHaveProperty('2️⃣审批驳回（无需点击）');
  });

  it('updates ordinary fields with app identity after global authorization', async () => {
    const gateway = {
      updateSubmissionRecordAsApp: jest.fn().mockResolvedValue(undefined),
      updateExecutionRecordAsApp: jest.fn(),
    };
    const service = new PurchaseRecordEditService(gateway as never);

    await service.updateRecord('rec_submission_1', {
      submissionRecordId: 'rec_submission_1',
      executionRecordId: null,
      fields: { itemName: '温度传感器' },
    });

    expect(gateway.updateSubmissionRecordAsApp).toHaveBeenCalledWith(
      'rec_submission_1',
      { 新增物品名称: '温度传感器' },
    );
  });

  it('rejects an execution-dependent status when no execution record exists', async () => {
    const gateway = {
      updateSubmissionRecord: jest.fn(),
      updateExecutionRecord: jest.fn(),
    };
    const service = new PurchaseRecordEditService(gateway as never);

    await expect(
      service.updateRecord('rec_submission_1', {
        submissionRecordId: 'rec_submission_1',
        executionRecordId: null,
        fields: { status: 'receiving' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.updateSubmissionRecord).not.toHaveBeenCalled();
  });
});
