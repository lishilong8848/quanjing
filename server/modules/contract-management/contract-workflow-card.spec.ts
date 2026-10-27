jest.mock('../../common/feishu/bitable-direct-read', () => ({
  extractDisplayText: (value: unknown) =>
    typeof value === 'string' ? value : '',
  extractNumberValue: (value: unknown) => Number(value) || 0,
  getRecordId: (record: { record_id?: string; id?: string }) =>
    record.record_id || record.id || '',
}));

import { ContractWorkflowService } from './contract-workflow.service';

describe('ContractWorkflowService interactive contract notifications', () => {
  const testReceiver = 'ou_a6644e62a43b916c6bc26148cf74f208';

  const createStore = () => ({
    recentLogs: jest.fn().mockResolvedValue([]),
    appendRun: jest.fn().mockResolvedValue(undefined),
    processedKeys: jest.fn().mockResolvedValue(new Set()),
    markProcessed: jest.fn().mockResolvedValue(undefined),
  });

  const createSource = () => ({
    sourceUrl: 'https://vnet.feishu.cn/wiki/wiki-token',
    contracts: [],
    payments: [],
    organization: [
      {
        record_id: 'org-manager',
        fields: {
          职位: '机房经理',
          主管: [{ id: 'ou_manager', name: '合同经理' }],
        },
      },
    ],
  });

  const withConfiguredReceiver = async (run: () => Promise<void>) => {
    const previous = process.env.FEISHU_CONTRACT_NOTIFICATION_RECEIVER_OPEN_IDS;
    process.env.FEISHU_CONTRACT_NOTIFICATION_RECEIVER_OPEN_IDS = testReceiver;
    try {
      await run();
    } finally {
      if (previous === undefined) {
        delete process.env.FEISHU_CONTRACT_NOTIFICATION_RECEIVER_OPEN_IDS;
      } else {
        process.env.FEISHU_CONTRACT_NOTIFICATION_RECEIVER_OPEN_IDS = previous;
      }
    }
  };

  it('sends a new-contract interactive card only to the configured test recipient', async () => {
    const gateway = {
      readSource: jest.fn().mockResolvedValue(createSource()),
      sendInteractiveCard: jest.fn().mockResolvedValue('om-created'),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      createStore() as never,
    );

    await withConfiguredReceiver(async () => {
      const result = await service.notifyContractCreated({
        kind: 'execution',
        recordId: 'rec-contract',
        name: '自测合同',
        code: 'CODEX-SELFTEST-001',
        supplier: '自测供应商',
        ownerNames: ['合同负责人'],
        ownerOpenIds: ['ou_owner'],
        specialty: '电气',
        amount: 0.01,
        startDate: '2026-07-16',
        endDate: '2026-08-15',
        selfTest: true,
      });

      expect(result).toMatchObject({
        attempted: true,
        recipients: 1,
        sent: 1,
        failed: 0,
      });
    });

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      testReceiver,
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: '新建执行合同已完成' }),
        }),
      }),
    );
  });

  it('sends an interactive card after a contract is renewed or voided', async () => {
    const gateway = {
      readSource: jest.fn().mockResolvedValue(createSource()),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValueOnce('om-renew')
        .mockResolvedValueOnce('om-void'),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      createStore() as never,
    );
    const notifyLifecycle = (
      service as unknown as {
        notifyContractLifecycleChanged: (input: unknown) => Promise<unknown>;
      }
    ).notifyContractLifecycleChanged;

    await withConfiguredReceiver(async () => {
      await expect(
        notifyLifecycle.call(service, {
          action: 'renew',
          recordId: 'rec-contract',
          name: '自测合同',
          code: 'CODEX-SELFTEST-001',
          endDate: '2026-08-30',
          ownerNames: ['合同负责人'],
          ownerOpenIds: ['ou_owner'],
        }),
      ).resolves.toMatchObject({ sent: 1, failed: 0 });
      await expect(
        notifyLifecycle.call(service, {
          action: 'void',
          recordId: 'rec-contract',
          name: '自测合同',
          code: 'CODEX-SELFTEST-001',
          endDate: '2026-08-30',
          ownerNames: ['合同负责人'],
          ownerOpenIds: ['ou_owner'],
        }),
      ).resolves.toMatchObject({ sent: 1, failed: 0 });
    });

    expect(
      gateway.sendInteractiveCard.mock.calls.map(([, card]) => card),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({ content: '合同续期已完成' }),
          }),
        }),
        expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({ content: '合同已作废' }),
          }),
        }),
      ]),
    );
  });

  it('sends the weekly expiry reminder as an interactive card', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T01:00:00.000Z'));
    const gateway = {
      readSource: jest.fn().mockResolvedValue({
        ...createSource(),
        contracts: [
          {
            record_id: 'rec-expiring-contract',
            fields: {
              合同编号: 'CODEX-EXPIRY-001',
              合同名称: '即将到期自测合同',
              合同开始日期: '2026-06-16',
              合同结束日期: '2026-07-16',
              合同金额: 0.01,
              专业类别: '电气',
              付款计划: [{ record_ids: ['rec-payment'] }],
              跟进人: [{ id: 'ou_owner', name: '合同负责人' }],
            },
          },
        ],
      }),
      sendInteractiveCard: jest.fn().mockResolvedValue('om-expiry'),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      createStore() as never,
    );

    await withConfiguredReceiver(async () => {
      await expect(
        service.run('contract_expiry_reminder', { trigger: 'manual' }),
      ).resolves.toMatchObject({ matched: 1, sent: 1, failed: 0 });
    });

    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      testReceiver,
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: '合同即将到期提醒' }),
        }),
      }),
    );
    jest.useRealTimers();
  });

  it('retries a transient Feishu data-not-ready response before sending a contract card', async () => {
    const dataNotReady = Object.assign(
      new Error('Request failed with status code 400'),
      {
        response: {
          data: {
            code: 1254607,
            msg: 'Data not ready, please try again later',
          },
        },
      },
    );
    const gateway = {
      readSource: jest
        .fn()
        .mockRejectedValueOnce(dataNotReady)
        .mockResolvedValue(createSource()),
      sendInteractiveCard: jest.fn().mockResolvedValue('om-created'),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      createStore() as never,
    );

    await expect(
      service.notifyContractCreated({
        kind: 'execution',
        recordId: 'rec-contract',
        name: '延迟可读合同',
        code: 'CODEX-RETRY-001',
        supplier: '自测供应商',
        ownerNames: ['合同负责人'],
        ownerOpenIds: ['ou_owner'],
        specialty: '电气',
        amount: 0.01,
        startDate: '2026-07-16',
        endDate: '2026-07-17',
        selfTest: true,
      }),
    ).resolves.toMatchObject({ sent: 2, failed: 0 });

    expect(gateway.readSource).toHaveBeenCalledTimes(2);
  });
});
