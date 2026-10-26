import { BadRequestException } from '@nestjs/common';
import { ContractPaymentFollowUpService } from './contract-payment-follow-up.service';

const paymentFields = [
  meta('formula-primary', '付款计划', 20),
  meta('period', '付款周期', 3, ['一次性', '一期', '二期', '三期', '四期']),
  meta('contract', '合同编号', 21),
  meta('owner', '跟进人', 11),
  meta('planned', '计划付款金额', 2),
  meta('planned-date', '计划付款日期', 5),
  meta('actual', '实际付款金额', 2),
  meta('actual-date', '付款日期', 5),
  meta('status', '付款状态', 3, ['未付款', '流程中', '已付款']),
];

const contract = {
  record_id: 'rec_contract',
  fields: {
    合同编号: [{ text: 'HT-001' }],
    合同名称: [{ text: '测试合同' }],
    跟进人: [{ id: 'ou_owner123', name: '合同负责人' }],
  },
};

const linkedPayment = {
  record_id: 'rec_payment',
  fields: {
    付款计划: [{ text: 'HT-001 一期' }],
    付款周期: '一期',
    合同编号: [{ record_ids: ['rec_contract'], text: 'HT-001' }],
    跟进人: [{ id: 'ou_owner123', name: '合同负责人' }],
    计划付款金额: '1000',
    实际付款金额: '200',
    计划付款日期: Date.parse('2026-07-20T00:00:00+08:00'),
    付款日期: Date.parse('2026-07-10T00:00:00+08:00'),
    付款状态: '未付款',
  },
};

describe('ContractPaymentFollowUpService', () => {
  const principal = { role: 'admin' as const, purchaseBuilding: null, accountId: 'synthetic-admin', authorizationVersion: 1 };
  let gateway: any;
  let workflow: any;
  let dispositionGateway: any;
  let dashboardService: any;
  let service: ContractPaymentFollowUpService;

  beforeEach(() => {
    gateway = {
      listFields: jest.fn().mockResolvedValue(paymentFields),
      listRecords: jest.fn(async (kind: string) =>
        kind === 'payment'
          ? [linkedPayment]
          : [
              {
                record_id: 'rec_org',
                fields: {
                  成员: [{ id: 'ou_owner123', name: '合同负责人' }],
                },
              },
            ],
      ),
      getRecord: jest.fn(async (kind: string, recordId: string) => {
        if (kind === 'execution') return contract;
        if (recordId === 'rec_payment') return linkedPayment;
        return {
          record_id: recordId,
          fields: {
            ...linkedPayment.fields,
            合同编号: [{ record_ids: ['rec_other'] }],
          },
        };
      }),
      createRecord: jest.fn().mockResolvedValue('rec_created'),
      updateRecord: jest.fn().mockResolvedValue(undefined),
    };
    workflow = {
      notifyPaymentFollowUpChanged: jest.fn().mockResolvedValue({
        attempted: true,
        recipients: 2,
        sent: 2,
        failed: 0,
        message: '通知已发送',
      }),
    };
    dispositionGateway = {
      updateTextField: jest.fn().mockResolvedValue(undefined),
    };
    dashboardService = {
      invalidateDashboardCache: jest.fn(),
    };
    service = new ContractPaymentFollowUpService(
      gateway,
      workflow,
      dispositionGateway,
      dashboardService,
      { currentPrincipal: jest.fn((id: string, version: number) => id === principal.accountId && version === 1 ? principal : undefined) } as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns only plans linked to the requested contract and real Base options', async () => {
    const options = await service.getOptions('rec_contract');

    expect(options.contract).toEqual({
      recordId: 'rec_contract',
      code: 'HT-001',
      name: '测试合同',
      ownerOpenId: 'ou_owner123',
      ownerName: '合同负责人',
    });
    expect(options.periods).toEqual(['一次性', '一期', '二期', '三期', '四期']);
    expect(options.statuses).toEqual(['未付款', '流程中', '已付款']);
    expect(options.people).toContainEqual({
      openId: 'ou_owner123',
      name: '合同负责人',
    });
    expect(options.plans).toHaveLength(1);
    expect(options.plans[0]).toEqual(
      expect.objectContaining({
        recordId: 'rec_payment',
        plannedAmount: 1000,
        actualAmount: 200,
        plannedPaymentDate: '2026-07-20',
        paymentDate: '2026-07-10',
        status: '未付款',
      }),
    );
    expect(gateway.listFields).not.toHaveBeenCalled();
  });

  it('reuses concurrent display options without requesting remote field metadata', async () => {
    await Promise.all([
      service.getOptions('rec_contract'),
      service.getOptions('rec_contract'),
    ]);

    expect(gateway.listFields).not.toHaveBeenCalled();
    expect(gateway.getRecord).toHaveBeenCalledTimes(1);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);
  });

  it('shares the payment and organization snapshot across contract displays', async () => {
    gateway.getRecord.mockImplementation(
      async (_kind: string, recordId: string) => ({
        ...contract,
        record_id: recordId,
      }),
    );

    await Promise.all([
      service.getOptions('rec_contract_a'),
      service.getOptions('rec_contract_b'),
    ]);

    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledWith('payment');
    expect(gateway.listRecords).toHaveBeenCalledWith('organization');
  });

  it('expires display options and the shared snapshot after five minutes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));

    await service.getOptions('rec_contract');
    jest.advanceTimersByTime(5 * 60 * 1000 - 1);
    await service.getOptions('rec_contract');

    expect(gateway.getRecord).toHaveBeenCalledTimes(1);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(1);
    await service.getOptions('rec_contract');

    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);
  });

  it('does not cache failed display loads', async () => {
    gateway.listRecords.mockRejectedValueOnce(
      new Error('snapshot unavailable'),
    );

    await expect(service.getOptions('rec_contract')).rejects.toThrow(
      'snapshot unavailable',
    );
    await expect(service.getOptions('rec_contract')).resolves.toBeDefined();

    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);
  });

  it('keeps display options for at most one hundred contracts', async () => {
    gateway.getRecord.mockImplementation(
      async (_kind: string, recordId: string) => ({
        ...contract,
        record_id: recordId,
      }),
    );

    for (let index = 0; index < 101; index += 1) {
      await service.getOptions(`rec_contract_${index}`);
    }
    await service.getOptions('rec_contract_0');

    expect(gateway.getRecord).toHaveBeenCalledTimes(102);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);
  });

  it('creates a plan with the contract link and notifies after persistence', async () => {
    const request = {
      idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
      period: '一期',
      plannedAmount: 1200,
      plannedPaymentDate: '2026-07-20',
      ownerOpenId: 'ou_owner123',
    };

    await service.getOptions('rec_contract');
    jest.clearAllMocks();

    const response = await service.createPlan('rec_contract', request, principal);

    expect(gateway.createRecord).toHaveBeenCalledWith(
      'payment',
      expect.objectContaining({
        合同编号: ['rec_contract'],
        计划付款日期: Date.parse('2026-07-20T00:00:00+08:00'),
        付款状态: '未付款',
      }),
      request.idempotencyKey,
    );
    expect(
      workflow.notifyPaymentFollowUpChanged.mock.invocationCallOrder[0],
    ).toBeGreaterThan(gateway.createRecord.mock.invocationCallOrder[0]);
    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'create',
        paymentRecordId: 'rec_created',
      }),
    );
    expect(gateway.listFields).not.toHaveBeenCalled();
    expect(gateway.getRecord).toHaveBeenCalledTimes(1);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);

    await service.getOptions('rec_contract');

    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);
  });

  it('rejects an owner outside the current options before creating or adjusting', async () => {
    const unknownOwner = 'ou_unknown';

    await expect(
      service.createPlan('rec_contract', {
        idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
        period: '一期',
        plannedAmount: 1200,
        plannedPaymentDate: '2026-07-20',
        ownerOpenId: unknownOwner,
      }),
    ).rejects.toThrow('不在当前可选人员中');
    await expect(
      service.adjustPlan('rec_contract', 'rec_payment', {
        period: '二期',
        plannedAmount: 500,
        plannedPaymentDate: '2026-08-20',
        ownerOpenId: unknownOwner,
      }),
    ).rejects.toThrow('不在当前可选人员中');

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('adjusts with fresh records and clears display caches after persistence', async () => {
    await service.getOptions('rec_contract');
    jest.clearAllMocks();

    await service.adjustPlan('rec_contract', 'rec_payment', {
      period: '二期',
      plannedAmount: 500,
      plannedPaymentDate: '2026-08-20',
      ownerOpenId: 'ou_owner123',
    }, principal);

    expect(gateway.listFields).not.toHaveBeenCalled();
    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);

    await service.getOptions('rec_contract');

    expect(gateway.getRecord).toHaveBeenCalledTimes(3);
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);
  });

  it('rejects adjustment of a payment record linked to another contract', async () => {
    await service.getOptions('rec_contract');
    jest.clearAllMocks();

    await expect(
      service.adjustPlan('rec_contract', 'rec_foreign', {
        period: '二期',
        plannedAmount: 500,
        plannedPaymentDate: '2026-08-20',
        ownerOpenId: 'ou_owner123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.listFields).not.toHaveBeenCalled();
    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);
  });

  it('confirms a linked plan with paid status and notifies afterwards', async () => {
    await service.getOptions('rec_contract');
    jest.clearAllMocks();

    const response = await service.confirmPlan('rec_contract', 'rec_payment', {
      actualAmount: 1000,
      paymentDate: '2026-07-21',
    }, principal);

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'payment',
      'rec_payment',
      {
        实际付款金额: 1000,
        付款日期: Date.parse('2026-07-21T00:00:00+08:00'),
        付款状态: '已付款',
      },
    );
    expect(
      workflow.notifyPaymentFollowUpChanged.mock.invocationCallOrder[0],
    ).toBeGreaterThan(gateway.updateRecord.mock.invocationCallOrder[0]);
    expect(response.action).toBe('confirm');
    expect(gateway.listFields).not.toHaveBeenCalled();
    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);

    await service.getOptions('rec_contract');

    expect(gateway.getRecord).toHaveBeenCalledTimes(3);
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);
  });

  it('marks a contract as no-payment-required and invalidates dashboard caches', async () => {
    const request = {
      idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
    };
    gateway.listRecords.mockResolvedValueOnce([]);

    const response = await service.markNoPaymentRequired(
      'rec_contract',
      request,
      principal,
    );

    expect(dispositionGateway.updateTextField).toHaveBeenCalledWith(
      'rec_contract',
      '付款跟进处置',
      '无需付款',
    );
    expect(dashboardService.invalidateDashboardCache).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      action: 'no_payment_required',
      contractRecordId: 'rec_contract',
      disposition: '无需付款',
      message: '已标记为无需付款',
    });
  });

  it('treats an existing no-payment-required disposition as an idempotent success', async () => {
    gateway.getRecord.mockResolvedValueOnce({
      ...contract,
      fields: {
        ...contract.fields,
        付款跟进处置: '无需付款',
      },
    });

    await expect(
      service.markNoPaymentRequired('rec_contract', {
        idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'no_payment_required',
      disposition: '无需付款',
    });

    expect(dispositionGateway.updateTextField).not.toHaveBeenCalled();
    expect(dashboardService.invalidateDashboardCache).toHaveBeenCalledTimes(1);
  });

  it('rejects no-payment-required when a payment plan is already linked', async () => {
    await expect(
      service.markNoPaymentRequired('rec_contract', {
        idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
      }),
    ).rejects.toThrow('该合同已存在付款计划，不能标记为无需付款');

    expect(dispositionGateway.updateTextField).not.toHaveBeenCalled();
    expect(dashboardService.invalidateDashboardCache).not.toHaveBeenCalled();
  });
});

function meta(
  fieldId: string,
  name: string,
  type: number,
  options: string[] = [],
) {
  return {
    field_id: fieldId,
    field_name: name,
    type,
    property: { options: options.map((option) => ({ name: option })) },
  };
}
