import { BadRequestException } from '@nestjs/common';
import { createFixedContractOptions } from '../../../shared/contract-field-config';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
const principal: AccessPrincipal = { role: 'admin', purchaseBuilding: null, accountId: 'synthetic-admin', authorizationVersion: 1 };
const access = { currentPrincipal: jest.fn((id: string, version: number) => id === principal.accountId && version === 1 ? principal : undefined) };

type ContractEditServiceConstructor = new (
  gateway: Record<string, jest.Mock>,
  contractCreation: Record<string, jest.Mock>,
  configuration: typeof access,
) => {
  getOptions(recordId: string): Promise<Record<string, unknown>>;
  update(
    recordId: string,
    request: { fields: Record<string, unknown>; supplierRecordId?: string },
    principal?: AccessPrincipal,
  ): Promise<Record<string, unknown>>;
};

function loadService(): ContractEditServiceConstructor | undefined {
  try {
    return (
      require('./contract-edit.service') as {
        ContractEditService?: ContractEditServiceConstructor;
      }
    ).ContractEditService;
  } catch {
    return undefined;
  }
}

function fixedOptions() {
  return {
    ...createFixedContractOptions('execution'),
    suppliers: [{ recordId: 'rec-supplier', name: '测试供应商', contacts: [] }],
    people: [{ openId: 'ou_owner', name: '负责人' }],
  };
}

function fieldId(name: string): string {
  return (
    fixedOptions().fields.find((field) => field.name === name)?.fieldId || name
  );
}

function editValues(): Record<string, unknown> {
  return {
    [fieldId('合同编号')]: 'V-001',
    [fieldId('合同名称')]: '更新后的合同',
    [fieldId('跟进人')]: 'ou_owner',
    [fieldId('合同类型')]: '维保合同',
    [fieldId('合同金额')]: 1200,
    [fieldId('合同开始日期')]: '2026-01-01',
    [fieldId('合同结束日期')]: '2026-12-31',
    [fieldId('专业类别')]: '暖通',
    [fieldId('签报号')]: '',
    [fieldId('签报金额')]: null,
    [fieldId('对应楼栋设备')]: '',
  };
}

function currentRecordFields(): Record<string, unknown> {
  return {
    合同编号: 'V-001',
    合同名称: '测试合同',
    跟进人: [{ id: 'ou_owner', name: '负责人' }],
    合同类型: '维保合同',
    合同金额: 1000,
    合同开始日期: Date.parse('2026-01-01T00:00:00+08:00'),
    合同结束日期: Date.parse('2026-12-31T00:00:00+08:00'),
    专业类别: '暖通',
    供应商: { record_ids: ['rec-supplier'] },
  };
}

describe('ContractEditService', () => {
  it('hydrates editable field IDs and the current supplier from an execution record', async () => {
    const ContractEditService = loadService();
    expect(ContractEditService).toBeDefined();
    if (!ContractEditService) return;
    const gateway = {
      getRecord: jest.fn().mockResolvedValue({
        record_id: 'rec-contract',
        fields: {
          合同编号: 'V-001',
          合同名称: '测试合同',
          跟进人: [{ id: 'ou_owner', name: '负责人' }],
          合同类型: '维保合同',
          合同金额: 1000,
          合同开始日期: Date.parse('2026-01-01T00:00:00+08:00'),
          合同结束日期: Date.parse('2026-12-31T00:00:00+08:00'),
          专业类别: '暖通',
          供应商: { record_ids: ['rec-supplier'] },
          合同附件: [{ file_token: 'file-private' }],
        },
      }),
      updateRecord: jest.fn(),
    };
    const creation = {
      getOptions: jest.fn().mockResolvedValue(fixedOptions()),
    };
    const service = new ContractEditService(gateway, creation, access);

    const result = await service.getOptions('rec-contract');

    expect(result).toMatchObject({
      contract: { recordId: 'rec-contract', code: 'V-001', name: '测试合同' },
      supplierRecordId: 'rec-supplier',
      values: {
        [fieldId('合同编号')]: 'V-001',
        [fieldId('合同名称')]: '测试合同',
        [fieldId('跟进人')]: 'ou_owner',
        [fieldId('合同开始日期')]: '2026-01-01',
        [fieldId('合同结束日期')]: '2026-12-31',
      },
    });
    expect(result).not.toHaveProperty('values.合同附件');
  });

  it('validates then partially updates only business fields and supplier relation', async () => {
    const ContractEditService = loadService();
    expect(ContractEditService).toBeDefined();
    if (!ContractEditService) return;
    const gateway = {
      getRecord: jest.fn().mockResolvedValue({
        record_id: 'rec-contract',
        fields: currentRecordFields(),
      }),
      updateRecord: jest.fn().mockResolvedValue(undefined),
    };
    const creation = {
      getOptions: jest.fn().mockResolvedValue(fixedOptions()),
    };
    const service = new ContractEditService(gateway, creation, access);

    await expect(
      service.update('rec-contract', {
        fields: editValues(),
        supplierRecordId: 'rec-supplier',
      }, principal),
    ).resolves.toMatchObject({
      ok: true,
      recordId: 'rec-contract',
    });
    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'execution',
      'rec-contract',
      expect.objectContaining({
        合同编号: 'V-001',
        合同名称: '更新后的合同',
        合同金额: 1200,
        跟进人: [{ id: 'ou_owner' }],
        供应商: ['rec-supplier'],
        签报号: null,
        签报金额: null,
        对应楼栋设备: null,
      }),
    );
    const written = gateway.updateRecord.mock.calls[0][2];
    expect(written).not.toHaveProperty('合同附件');
    expect(written).not.toHaveProperty('付款计划');
    expect(written).not.toHaveProperty('框架引用');
  });

  it('merges against fresh Base values but writes only requested fields', async () => {
    const ContractEditService = loadService();
    expect(ContractEditService).toBeDefined();
    if (!ContractEditService) return;
    const gateway = {
      getRecord: jest.fn().mockResolvedValue({
        record_id: 'rec-contract',
        fields: currentRecordFields(),
      }),
      updateRecord: jest.fn().mockResolvedValue(undefined),
    };
    const creation = {
      getOptions: jest.fn().mockResolvedValue(fixedOptions()),
    };
    const service = new ContractEditService(gateway, creation, access);

    await service.update('rec-contract', {
      fields: { [fieldId('合同名称')]: '仅更新名称' },
    }, principal);

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'execution',
      'rec-contract',
      { 合同名称: '仅更新名称' },
    );
  });

  it('rejects an unknown supplier and reversed dates before writing', async () => {
    const ContractEditService = loadService();
    expect(ContractEditService).toBeDefined();
    if (!ContractEditService) return;
    const gateway = {
      getRecord: jest.fn(),
      updateRecord: jest.fn(),
    };
    const creation = {
      getOptions: jest.fn().mockResolvedValue(fixedOptions()),
    };
    const service = new ContractEditService(gateway, creation, access);
    const values = editValues();
    values[fieldId('合同开始日期')] = '2026-12-31';
    values[fieldId('合同结束日期')] = '2026-01-01';

    await expect(
      service.update('rec-contract', {
        fields: values,
        supplierRecordId: 'rec-unknown',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.getRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects an unknown contract owner before reading or writing the record', async () => {
    const ContractEditService = loadService();
    expect(ContractEditService).toBeDefined();
    if (!ContractEditService) return;
    const gateway = {
      getRecord: jest.fn(),
      updateRecord: jest.fn(),
    };
    const creation = {
      getOptions: jest.fn().mockResolvedValue(fixedOptions()),
    };
    const service = new ContractEditService(gateway, creation, access);

    await expect(
      service.update('rec-contract', {
        fields: { [fieldId('跟进人')]: 'ou_unknown' },
      }),
    ).rejects.toThrow('不在当前可选人员中');
    expect(gateway.getRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });
});
