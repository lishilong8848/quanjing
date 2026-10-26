import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { ContractWorkflowStore } from './contract-workflow.store';

jest.mock('../../common/feishu/bitable-direct-read', () => ({
  extractDateValue: (value: unknown) =>
    typeof value === 'string' ? value : null,
  extractDisplayText: (value: unknown) =>
    typeof value === 'string' ? value : '',
}));

import { ContractExpiryDispositionService } from './contract-expiry-disposition.service';

describe('ContractExpiryDispositionService', () => {
  const gateway = {
    getContract: jest.fn(),
    updateContract: jest.fn(),
  };
  const creationGateway = {
    createRecord: jest.fn(),
    deleteRecord: jest.fn(),
    listRecords: jest.fn(),
  };
  const workflow = {
    notifyContractLifecycleChanged: jest.fn(),
    enqueueContractLifecycleChanged: jest.fn(),
  };
  let service: ContractExpiryDispositionService, folder:string, parent:string, owner:string;
  let savedApp:string|undefined;
  let releaseRead=()=>{};
  const principal={role:'admin' as const,purchaseBuilding:null,accountId:'synthetic-contract-admin',authorizationVersion:1};
  const renewalPaymentPlan = {
    period: '一期',
    plannedAmount: 1200,
    plannedPaymentDate: '2026-08-20',
    ownerOpenId: 'ou_owner123',
  };
  const idempotencyKey = '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70';

  beforeEach(() => {
    jest.clearAllMocks();
    savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_contract_service';
    releaseRead=()=>{};parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-contract-service-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});
    service=new (ContractExpiryDispositionService as unknown as new(...args:unknown[])=>ContractExpiryDispositionService)(gateway,creationGateway,workflow,new ContractWorkflowStore(join(folder,'ledger.json')),{currentPrincipal:()=>principal});
    gateway.updateContract.mockResolvedValue(undefined);
    workflow.notifyContractLifecycleChanged.mockResolvedValue({
      attempted: true,
      recipients: 1,
      sent: 1,
      failed: 0,
      message: '合同状态通知已发送给 1 人',
    });
    workflow.enqueueContractLifecycleChanged.mockImplementation(async(input:unknown)=>{
      void Promise.resolve(workflow.notifyContractLifecycleChanged(input)).catch(()=>undefined);
      return {attempted:true,recipients:0,sent:0,failed:0,message:'合同状态已更新，通知正在后台发送'};
    });
    creationGateway.createRecord.mockResolvedValue('rec-payment-1');
    creationGateway.deleteRecord.mockResolvedValue(undefined);
    creationGateway.listRecords.mockImplementation(async (kind: string) =>
      kind === 'organization'
        ? [
            {
              record_id: 'rec-org',
              fields: {
                成员: [{ id: 'ou_owner123', name: '合同负责人' }],
              },
            },
          ]
        : [],
    );
  });
  afterEach(async()=>{
    releaseRead();await service.onModuleDestroy();const canonical=(value:string)=>resolve(value).toLowerCase();if(canonical(dirname(folder))!==canonical(parent)||!/^nt-contract-service-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||canonical(realpathSync(folder))!==canonical(folder)||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});
    if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;
  });

  it('renews an actionable contract and writes a Base date timestamp', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-1',
      fields: {
        合同名称: '打印机租赁合同',
        合同编号: 'CODEX-RENEW-001',
        合同结束日期: '2026-07-31',
        跟进人: [{ id: 'ou_owner123', name: '合同负责人' }],
      },
    });

    await expect(
      service.execute(
        'rec-contract-1',
        {
          action: 'renew',
          renewalEndDate: '2027-07-31',
          idempotencyKey,
          paymentPlans: [renewalPaymentPlan],
        },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      recordId: 'rec-contract-1',
      action: 'renew',
      endDate: '2027-07-31',
      notification: {
        attempted: true,
        recipients: 0,
        sent: 0,
        failed: 0,
        message: '合同状态已更新，通知正在后台发送',
      },
    });

    expect(gateway.updateContract).toHaveBeenCalledWith('rec-contract-1', {
      合同结束日期: Date.parse('2027-07-31T00:00:00+08:00'),
      合同到期处置: '已续期至 2027-07-31',
    });
    expect(creationGateway.createRecord).toHaveBeenCalledWith(
      'payment',
      {
        付款周期: '一期',
        合同编号: ['rec-contract-1'],
        跟进人: [{ id: 'ou_owner123' }],
        计划付款金额: 1200,
        计划付款日期: Date.parse('2026-08-20T00:00:00+08:00'),
        付款状态: '未付款',
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(
      creationGateway.createRecord.mock.invocationCallOrder[0],
    ).toBeLessThan(gateway.updateContract.mock.invocationCallOrder[0]);
    expect(workflow.notifyContractLifecycleChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'renew',
        recordId: 'rec-contract-1',
        code: 'CODEX-RENEW-001',
      }),
    );
  });

  it('marks an actionable contract as voided', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-2',
      fields: {
        合同名称: '历史维保合同',
        合同编号: 'CODEX-VOID-001',
        合同结束日期: '2026-07-01',
        跟进人: [{ id: 'ou_owner123', name: '合同负责人' }],
      },
    });

    await expect(
      service.execute(
        'rec-contract-2',
        { action: 'void' },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      recordId: 'rec-contract-2',
      action: 'void',
      endDate: '2026-07-01',
      notification: {
        attempted: true,
        recipients: 0,
        sent: 0,
        failed: 0,
        message: '合同状态已更新，通知正在后台发送',
      },
    });

    expect(gateway.updateContract).toHaveBeenCalledWith('rec-contract-2', {
      合同到期处置: '到期作废',
    });
    expect(workflow.notifyContractLifecycleChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'void',
        recordId: 'rec-contract-2',
        code: 'CODEX-VOID-001',
      }),
    );
  });

  it('accepts a void request before the Base operation completes and exposes task status', async () => {
    let releaseContractRead = () => undefined;
    let beginRead=()=>{};
    const began=new Promise<void>(resolve=>{beginRead=resolve;});
    gateway.getContract.mockImplementation(
      () => {
        beginRead();
        return new Promise((resolve) => {
          releaseContractRead = () =>
            resolve({
              record_id: 'rec-contract-background',
              fields: {
                合同结束日期: '2026-07-01',
              },
            });
          releaseRead=releaseContractRead;
        });
      },
    );

    const submission = await service.submit(
      'rec-contract-background',
      { action: 'void' },
      new Date('2026-07-13T04:00:00.000Z'),
      principal,
    );

    expect(submission).toEqual(
      expect.objectContaining({
        recordId: 'rec-contract-background',
        action: 'void',
        pending: true,
        taskId: expect.stringMatching(/^contract-expiry-/),
      }),
    );
    expect(gateway.getContract).not.toHaveBeenCalled();
    expect(await service.getTaskStatus(submission.taskId)).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          status: expect.stringMatching(/^(pending|running)$/),
          recordId: 'rec-contract-background',
        }),
      }),
    );

    await began;
    expect(gateway.getContract).toHaveBeenCalledTimes(1);
    expect(await service.getTaskStatus(submission.taskId)).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'running' }),
      }),
    );

    releaseContractRead();
    await (service as unknown as {work:Promise<void>}).work;

    expect(await service.getTaskStatus(submission.taskId)).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(gateway.updateContract).toHaveBeenCalledWith(
      'rec-contract-background',
      { 合同到期处置: '到期作废' },
    );
  });

  it('records a safe task failure message when the Base operation fails', async () => {
    gateway.getContract.mockRejectedValue(new Error('upstream timeout'));
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const submission = await service.submit(
        'rec-contract-background-failure',
        { action: 'void' },
        new Date('2026-07-13T04:00:00.000Z'),
        principal,
      );
      await (service as unknown as {work:Promise<void>}).work;

      expect(await service.getTaskStatus(submission.taskId)).toEqual(
        expect.objectContaining({
          success: true,
          task: expect.objectContaining({
            status: 'failed',
            message: '合同到期处置后台同步失败，请稍后重试',
          }),
        }),
      );
    } finally {
      loggerError.mockRestore();
    }
  });

  it('returns the void result without waiting for the lifecycle notification', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-void-pending-notification',
      fields: {
        合同结束日期: '2026-07-01',
      },
    });
    let releaseNotification = () => undefined;
    workflow.notifyContractLifecycleChanged.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseNotification = () =>
            resolve({
              attempted: true,
              recipients: 1,
              sent: 1,
              failed: 0,
              message: 'notification released for test cleanup',
            });
        }),
    );

    let result: unknown;
    try {
      result = await Promise.race([
        service.execute(
          'rec-contract-void-pending-notification',
          { action: 'void' },
          new Date('2026-07-13T04:00:00.000Z'),
        ),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('lifecycle notification blocked voiding')),
            100,
          );
        }),
      ]);
    } finally {
      releaseNotification();
    }

    expect(result).toMatchObject({
      recordId: 'rec-contract-void-pending-notification',
      action: 'void',
      endDate: '2026-07-01',
      notification: {
        attempted: true,
        recipients: 0,
        sent: 0,
        failed: 0,
        message: '合同状态已更新，通知正在后台发送',
      },
    });
    expect(gateway.updateContract).toHaveBeenCalledWith(
      'rec-contract-void-pending-notification',
      { 合同到期处置: '到期作废' },
    );
    expect(workflow.notifyContractLifecycleChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'void',
        recordId: 'rec-contract-void-pending-notification',
      }),
    );
  });
  it('通知正式受理落盘之前不能把合同处置返回为完成',async()=>{
    gateway.getContract.mockResolvedValue({record_id:'rec-contract-persist-notice',fields:{合同结束日期:'2026-07-01'}});
    let release=()=>{},completed=false;
    workflow.enqueueContractLifecycleChanged.mockImplementation(()=>new Promise(resolve=>{release=()=>resolve({attempted:true,recipients:0,sent:0,failed:0,message:'合成通知已受理'});}));
    const pending=service.execute('rec-contract-persist-notice',{action:'void'},new Date('2026-07-13T04:00:00.000Z')).then(result=>{completed=true;return result;});
    try{await new Promise(resolve=>setImmediate(resolve));expect(completed).toBe(false);}finally{release();}
    expect((await pending).notification.message).toBe('合成通知已受理');
  });

  it('rejects contracts outside the past-30/future-60-day action window', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-old',
      fields: { 合同结束日期: '2026-06-01' },
    });

    await expect(
      service.execute(
        'rec-contract-old',
        { action: 'void' },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.updateContract).not.toHaveBeenCalled();
  });

  it('requires a renewal date later than the current contract end date', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-3',
      fields: { 合同结束日期: '2026-07-31' },
    });

    await expect(
      service.execute(
        'rec-contract-3',
        { action: 'renew', renewalEndDate: '2026-07-31' },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires at least one complete payment plan for renewal', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-4',
      fields: { 合同结束日期: '2026-07-31' },
    });

    await expect(
      service.execute(
        'rec-contract-4',
        { action: 'renew', renewalEndDate: '2027-07-31', idempotencyKey },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).rejects.toThrow('请至少录入一条付款计划');
    expect(creationGateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateContract).not.toHaveBeenCalled();
  });

  it('deletes newly-created payment plans when the contract update fails', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-5',
      fields: { 合同结束日期: '2026-07-31' },
    });
    gateway.updateContract.mockRejectedValue(new Error('update failed'));

    await expect(
      service.execute(
        'rec-contract-5',
        {
          action: 'renew',
          renewalEndDate: '2027-07-31',
          idempotencyKey,
          paymentPlans: [renewalPaymentPlan],
        },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).rejects.toThrow('update failed');
    expect(creationGateway.deleteRecord).toHaveBeenCalledWith(
      'payment',
      'rec-payment-1',
    );
  });

  it('deletes earlier payment plans when a later payment plan write fails', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-6',
      fields: { 合同结束日期: '2026-07-31' },
    });
    creationGateway.createRecord
      .mockResolvedValueOnce('rec-payment-first')
      .mockRejectedValueOnce(new Error('second payment failed'));

    await expect(
      service.execute(
        'rec-contract-6',
        {
          action: 'renew',
          renewalEndDate: '2027-07-31',
          idempotencyKey,
          paymentPlans: [
            renewalPaymentPlan,
            { ...renewalPaymentPlan, period: '二期', plannedAmount: 800 },
          ],
        },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).rejects.toThrow('second payment failed');
    expect(creationGateway.deleteRecord).toHaveBeenCalledWith(
      'payment',
      'rec-payment-first',
    );
    expect(gateway.updateContract).not.toHaveBeenCalled();
  });

  it('rejects renewal payment owners outside the current options before writing', async () => {
    gateway.getContract.mockResolvedValue({
      record_id: 'rec-contract-7',
      fields: {
        合同结束日期: '2026-07-31',
        跟进人: [{ id: 'ou_owner123', name: '合同负责人' }],
      },
    });

    await expect(
      service.execute(
        'rec-contract-7',
        {
          action: 'renew',
          renewalEndDate: '2027-07-31',
          idempotencyKey,
          paymentPlans: [{ ...renewalPaymentPlan, ownerOpenId: 'ou_unknown' }],
        },
        new Date('2026-07-13T04:00:00.000Z'),
      ),
    ).rejects.toThrow('不在当前可选人员中');
    expect(creationGateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateContract).not.toHaveBeenCalled();
  });
});
