jest.mock('../../common/feishu/bitable-direct-read', () => ({
  extractDisplayText: (value: unknown) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map((item) =>
          typeof item === 'object' && item
            ? String((item as { name?: unknown }).name || '')
            : String(item || ''),
        )
        .filter(Boolean)
        .join('、');
    }
    return '';
  },
  extractNumberValue: (value: unknown) => Number(value) || 0,
  getRecordId: (record: { record_id?: string; id?: string }) =>
    record.record_id || record.id || '',
}));

import { ContractWorkflowService } from './contract-workflow.service';
import { ContractWorkflowStore } from './contract-workflow.store';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('ContractWorkflowService contract-created notification', () => {
  let folder:string,parent:string,owner:string,savedApp:string|undefined;
  beforeEach(()=>{savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_contract_workflow';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-contract-workflow-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});});
  afterEach(()=>{if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;});
  afterEach(()=>{const canonical=(value:string)=>resolve(value).toLowerCase();if(canonical(dirname(folder))!==canonical(parent)||!/^nt-contract-workflow-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||canonical(realpathSync(folder))!==canonical(folder)||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  function notificationStore(base:Record<string,unknown>){
    const native=new ContractWorkflowStore(join(folder,`notification-${randomUUID()}.json`));
    return {...base,enqueueRoleNotification:native.enqueueRoleNotification.bind(native),getRoleNotification:native.getRoleNotification.bind(native),claimRoleNotification:native.claimRoleNotification.bind(native),settleRoleNotification:native.settleRoleNotification.bind(native),enqueuePaymentDigest:native.enqueuePaymentDigest.bind(native),claimPaymentDigest:native.claimPaymentDigest.bind(native),settlePaymentDigest:native.settlePaymentDigest.bind(native),processedKeys:native.processedKeys.bind(native),deliveredKeys:native.deliveredKeys.bind(native),markDelivered:native.markDelivered.bind(native),markProcessed:native.markProcessed.bind(native),appendRun:native.appendRun.bind(native)};
  }
  it('uses the planned payment date for due reminders', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T01:00:00.000Z'));
    const gateway = {
      readSource: jest.fn().mockResolvedValue({
        sourceUrl: 'https://vnet.feishu.cn/wiki/wiki-token',
        contracts: [
          {
            record_id: 'rec_contract',
            fields: {
              合同编号: 'HT-001',
              合同名称: '测试合同',
              跟进人: [{ id: 'ou_owner', name: '合同负责人' }],
            },
          },
        ],
        payments: [
          {
            record_id: 'rec_payment',
            fields: {
              合同编号: { link_record_ids: ['rec_contract'] },
              付款计划: 'HT-001 一期',
              计划付款金额: 1000,
              计划付款日期: '2026-07-16',
              付款日期: '2026-07-10',
              付款状态: '未付款',
            },
          },
        ],
        organization: [],
      }),
      sendText: jest.fn().mockResolvedValue('om-payment'),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_payment_digest'),
    };
    const store = {
      recentLogs: jest.fn(),
      appendRun: jest.fn(),
      processedKeys: jest.fn().mockResolvedValue(new Set()),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      notificationStore(store) as never,
    );

    const result = await service.run('payment_due_reminder', {
      trigger: 'manual',
    });

    expect(result).toMatchObject({ scanned: 1, matched: 1, sent: 1 });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_owner',
      expect.objectContaining({
        body: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('2026-07-16'),
            }),
          ]),
        }),
      }),
      expect.any(String),
    );
    expect(gateway.sendText).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('sends one payment digest card per recipient instead of one message per plan', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T01:00:00.000Z'));
    const payments = ['一期', '二期', '三期'].map((period, index) => ({
      record_id: `rec_payment_${index + 1}`,
      fields: {
        合同编号: { link_record_ids: ['rec_contract'] },
        付款计划: `HT-001 ${period}`,
        付款周期: period,
        计划付款金额: (index + 1) * 1000,
        计划付款日期: '2026-08-31',
        付款状态: '未付款',
      },
    }));
    const gateway = {
      readSource: jest.fn().mockResolvedValue({
        sourceUrl: 'https://vnet.feishu.cn/wiki/wiki-token',
        contracts: [
          {
            record_id: 'rec_contract',
            fields: {
              合同编号: 'HT-001',
              合同名称: '暖通维保合同',
              跟进人: [{ id: 'ou_owner', name: '曹李培' }],
              专业类别: '暖通',
            },
          },
        ],
        payments,
        organization: [],
      }),
      sendText: jest.fn().mockResolvedValue('om-text'),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_digest'),
    };
    const store = {
      recentLogs: jest.fn(),
      appendRun: jest.fn(),
      processedKeys: jest.fn().mockResolvedValue(new Set()),
      deliveredKeys: jest.fn().mockResolvedValue(new Set()),
      markDelivered: jest.fn().mockResolvedValue(undefined),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      notificationStore(store) as never,
    );

    const result = await service.run('payment_due_reminder', {
      trigger: 'manual',
    });

    expect(gateway.sendText).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_owner',
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: '明日付款提醒 · 3项' }),
        }),
      }),
      expect.any(String),
    );
    const serialized = JSON.stringify(
      gateway.sendInteractiveCard.mock.calls[0][1],
    );
    expect(serialized).toContain('HT-001 一期');
    expect(serialized).toContain('HT-001 二期');
    expect(serialized).toContain('HT-001 三期');
    expect(result).toMatchObject({ matched: 3, sent: 1, failed: 0 });
    jest.useRealTimers();
  });

  it('retries only the failed digest recipient without resending successful recipients', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T01:00:00.000Z'));
    const delivered = new Set<string>();
    const processed = new Set<string>();
    const gateway = {
      readSource: jest.fn().mockResolvedValue({
        sourceUrl: 'https://vnet.feishu.cn/wiki/wiki-token',
        contracts: [
          {
            record_id: 'rec_contract',
            fields: {
              合同编号: 'HT-002',
              合同名称: '双接收人合同',
              跟进人: [{ id: 'ou_owner', name: '合同跟进人' }],
            },
          },
        ],
        payments: [
          {
            record_id: 'rec_payment',
            fields: {
              合同编号: { link_record_ids: ['rec_contract'] },
              付款计划: 'HT-002 一期',
              计划付款金额: 1000,
              计划付款日期: '2026-08-31',
              付款状态: '未付款',
            },
          },
        ],
        organization: [
          {
            fields: {
              职位: '机房经理',
              主管: [{ id: 'ou_manager', name: '机房经理' }],
            },
          },
        ],
      }),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValueOnce('om_manager')
        .mockRejectedValueOnce(new Error('owner timeout'))
        .mockResolvedValueOnce('om_owner_retry'),
    };
    const store = {
      recentLogs: jest.fn(),
      appendRun: jest.fn(),
      processedKeys: jest.fn(async () => new Set(processed)),
      deliveredKeys: jest.fn(async () => new Set(delivered)),
      markDelivered: jest.fn(async (key: string) => delivered.add(key)),
      markProcessed: jest.fn(async (key: string) => processed.add(key)),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      notificationStore(store) as never,
    );

    await service.run('payment_due_reminder', { trigger: 'manual' });
    await service.run('payment_due_reminder', { trigger: 'manual' });

    const receivers = gateway.sendInteractiveCard.mock.calls.map(
      ([receiver]) => receiver,
    );
    expect(
      receivers.filter((receiver) => receiver === 'ou_manager'),
    ).toHaveLength(1);
    expect(
      receivers.filter((receiver) => receiver === 'ou_owner'),
    ).toHaveLength(2);
    jest.useRealTimers();
  });

  it('notifies managers and the execution owner after durable creation', async () => {
    const gateway = {
      readSource: jest.fn().mockResolvedValue({
        sourceUrl: 'https://vnet.feishu.cn/wiki/wiki-token?table=tbl-framework',
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
      }),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValueOnce('om_manager')
        .mockResolvedValueOnce('om_owner'),
    };
    const store = {
      recentLogs: jest.fn(),
      appendRun: jest.fn(),
      processedKeys: jest.fn(),
      markProcessed: jest.fn(),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      notificationStore(store) as never,
    );

    const result = await service.notifyContractCreated({
      kind: 'execution',
      recordId: 'rec-contract',
      name: 'UPS 维保合同',
      code: 'VNET-2026-001',
      supplier: '测试供应商',
      ownerNames: ['张三'],
      ownerOpenIds: ['ou_owner', 'ou_manager'],
      specialty: '电气',
      amount: 128000,
      startDate: '2026-07-13',
      endDate: '2027-07-12',
      selfTest: false,
    });

    expect(
      gateway.sendInteractiveCard.mock.calls.map(([receiver]) => receiver),
    ).toEqual(['ou_manager', 'ou_owner']);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_manager',
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: '新建执行合同已完成' }),
        }),
      }),
      expect.any(String),
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_owner',
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({ tag: 'div' }),
        ]),
      }),
      expect.any(String),
    );
    expect(result).toEqual({
      attempted: true,
      recipients: 2,
      sent: 2,
      failed: 0,
      message: '合同通知已发送给 2 人',
    });
  });

  it('returns an explicit partial result when one recipient fails', async () => {
    const gateway = {
      readSource: jest.fn().mockResolvedValue({
        sourceUrl: 'https://vnet.feishu.cn/wiki/wiki-token',
        contracts: [],
        payments: [],
        organization: [
          {
            fields: {
              职位: '机房经理',
              主管: [{ id: 'ou_manager', name: '合同经理' }],
            },
          },
        ],
      }),
      sendInteractiveCard: jest
        .fn()
        .mockRejectedValue(new Error('消息接口超时')),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      notificationStore({
        recentLogs: jest.fn(),
      }) as never,
    );

    await expect(
      service.notifyContractCreated({
        kind: 'framework',
        recordId: 'rec-framework',
        name: '年度维保框架',
        code: 'FRAME-001',
        supplier: '',
        ownerNames: [],
        ownerOpenIds: [],
        specialty: '',
        amount: 0,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        selfTest: true,
      }),
    ).resolves.toEqual({
      attempted: true,
      recipients: 1,
      sent: 0,
      failed: 1,
      message: '合同已创建，但 1 位接收人的通知发送失败',
    });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_manager',
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({ tag: 'note' }),
        ]),
      }),
      expect.any(String),
    );
  });

  it('notifies managers and the payment owner after a follow-up action', async () => {
    const gateway = {
      readSource: jest.fn().mockResolvedValue({
        sourceUrl: 'https://vnet.feishu.cn/wiki/wiki-token',
        contracts: [],
        payments: [],
        organization: [
          {
            fields: {
              职位: '机房经理',
              主管: [{ id: 'ou_manager', name: '合同经理' }],
            },
          },
        ],
      }),
      sendText: jest.fn().mockResolvedValue('om_message'),
    };
    const service = new ContractWorkflowService(
      gateway as never,
      notificationStore({
        recentLogs: jest.fn(),
      }) as never,
    );

    const result = await service.notifyPaymentFollowUpChanged({
      action: 'confirm',
      contractRecordId: 'rec_contract',
      contractCode: 'HT-001',
      contractName: '测试合同',
      paymentRecordId: 'rec_payment',
      paymentLabel: 'HT-001 一期',
      period: '一期',
      plannedAmount: 1000,
      actualAmount: 1000,
      plannedPaymentDate: '2026-07-20',
      paymentDate: '2026-07-21',
      ownerOpenIds: ['ou_owner', 'ou_manager'],
      ownerNames: ['合同负责人'],
    });

    expect(gateway.sendText.mock.calls.map(([receiver]) => receiver)).toEqual([
      'ou_manager',
      'ou_owner',
    ]);
    expect(gateway.sendText).toHaveBeenCalledWith(
      'ou_owner',
      expect.stringMatching(/付款跟进[\s\S]*HT-001[\s\S]*已付款/),
      expect.any(String),
    );
    expect(result).toEqual({
      attempted: true,
      recipients: 2,
      sent: 2,
      failed: 0,
      message: '付款跟进通知已发送给 2 人',
    });
  });
});
