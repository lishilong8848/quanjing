import { createFixedContractOptions } from '../../shared/contract-field-config';

type ContractEditLogicModule = {
  createContractEditDraft: (options: TestEditOptions) => TestEditDraft;
  validateContractEditDraft: (
    draft: TestEditDraft,
    options: TestEditOptions,
  ) => Array<{ path: string; message: string }>;
  buildContractEditRequest: (
    draft: TestEditDraft,
    options: TestEditOptions,
  ) => {
    fields: Record<string, unknown>;
    supplierRecordId?: string;
  };
};

interface TestEditOptions {
  contract: { recordId: string; code: string; name: string };
  fields: ReturnType<typeof createFixedContractOptions>['fields'];
  values: Record<string, unknown>;
  suppliers: Array<{ recordId: string; name: string; contacts: never[] }>;
  people: Array<{ openId: string; name: string }>;
  supplierRecordId: string;
}

interface TestEditDraft {
  fields: Record<string, unknown>;
  supplierRecordId: string;
}

function loadLogic(): Partial<ContractEditLogicModule> {
  try {
    return require('../../client/src/pages/ContractManagement/contract-edit.logic') as Partial<ContractEditLogicModule>;
  } catch {
    return {};
  }
}

function options(): TestEditOptions {
  const fixed = createFixedContractOptions('execution');
  const fieldId = (name: string) =>
    fixed.fields.find((field) => field.name === name)?.fieldId || name;
  return {
    contract: { recordId: 'rec-contract', code: 'V-001', name: '测试合同' },
    fields: fixed.fields.filter((field) => field.control !== 'attachment'),
    values: {
      [fieldId('合同编号')]: 'V-001',
      [fieldId('合同名称')]: '测试合同',
      [fieldId('跟进人')]: 'ou_owner',
      [fieldId('合同类型')]: '维保合同',
      [fieldId('合同金额')]: 1000,
      [fieldId('合同开始日期')]: '2026-01-01',
      [fieldId('合同结束日期')]: '2026-12-31',
      [fieldId('专业类别')]: '暖通',
    },
    suppliers: [{ recordId: 'rec-supplier', name: '测试供应商', contacts: [] }],
    people: [{ openId: 'ou_owner', name: '负责人' }],
    supplierRecordId: 'rec-supplier',
  };
}

describe('contract edit client logic', () => {
  it('creates an isolated draft from current Base values', () => {
    const module = loadLogic();
    expect(typeof module.createContractEditDraft).toBe('function');
    if (!module.createContractEditDraft) return;
    const source = options();

    const draft = module.createContractEditDraft(source);
    draft.fields[Object.keys(draft.fields)[0]] = 'changed';

    expect(draft.supplierRecordId).toBe('rec-supplier');
    expect(source.values[Object.keys(source.values)[0]]).toBe('V-001');
  });

  it('rejects missing required fields, invalid supplier and reversed dates', () => {
    const module = loadLogic();
    expect(typeof module.validateContractEditDraft).toBe('function');
    if (!module.validateContractEditDraft) return;
    const source = options();
    const draft = {
      fields: { ...source.values },
      supplierRecordId: 'missing-supplier',
    };
    const byName = (name: string) =>
      source.fields.find((field) => field.name === name)?.fieldId || '';
    draft.fields[byName('合同名称')] = '';
    draft.fields[byName('合同开始日期')] = '2026-12-31';
    draft.fields[byName('合同结束日期')] = '2026-01-01';

    const errors = module.validateContractEditDraft(draft, source);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `fields.${byName('合同名称')}` }),
        expect.objectContaining({ path: 'supplierRecordId' }),
        expect.objectContaining({ path: `fields.${byName('合同结束日期')}` }),
      ]),
    );
  });

  it('serializes only values changed from the loaded Base snapshot', () => {
    const module = loadLogic();
    expect(typeof module.buildContractEditRequest).toBe('function');
    if (!module.buildContractEditRequest) return;
    const source = options();
    const contractNameFieldId =
      source.fields.find((field) => field.name === '合同名称')?.fieldId || '';
    const draft = {
      fields: { ...source.values },
      supplierRecordId: source.supplierRecordId,
    };
    draft.fields[contractNameFieldId] = '仅更新合同名称';

    expect(module.buildContractEditRequest(draft, source)).toEqual({
      fields: { [contractNameFieldId]: '仅更新合同名称' },
    });
  });

  it('includes the supplier relation only when it changed', () => {
    const module = loadLogic();
    expect(typeof module.buildContractEditRequest).toBe('function');
    if (!module.buildContractEditRequest) return;
    const source = options();
    source.suppliers.push({
      recordId: 'rec-supplier-next',
      name: '新供应商',
      contacts: [],
    });
    const draft = {
      fields: { ...source.values },
      supplierRecordId: 'rec-supplier-next',
    };

    expect(module.buildContractEditRequest(draft, source)).toEqual({
      fields: {},
      supplierRecordId: 'rec-supplier-next',
    });
  });
});
