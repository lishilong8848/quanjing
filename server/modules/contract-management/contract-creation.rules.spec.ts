import type {
  ContractCreateFieldDefinition,
  ContractCreateRequest,
} from '../../../shared/contract-management.interface';
import {
  buildContractCreateDefinition,
  buildContractPartialEditFields,
  buildContractRecordFields,
  buildSupplierCreateDefinition,
  buildSupplierRecordFields,
  type BitableFieldMeta,
} from './contract-creation.rules';

const frameworkFields: BitableFieldMeta[] = [
  field('fld-formula', '框架合同编码', 20, 'Formula'),
  field('fld-code', '合同编号', 1, 'Text'),
  field('fld-name', '合同名称', 1, 'Text'),
  field('fld-type', '合同类型', 3, 'SingleSelect', {
    options: [{ name: '总部集采' }, { name: '属地自采' }],
  }),
  field('fld-start', '合同开始日期', 5, 'DateTime'),
  field('fld-end', '合同结束日期', 5, 'DateTime'),
  field('fld-attachment', '合同附件', 17, 'Attachment'),
  field('fld-reverse', '01-执行合同信息', 21, 'DuplexLink', {
    table_id: 'tbl-execution',
    multiple: true,
  }),
];

const executionFields: BitableFieldMeta[] = [
  field('fld-code', '合同编号', 1, 'Text'),
  field('fld-name', '合同名称', 1, 'Text'),
  field('fld-owner', '跟进人', 11, 'User', { multiple: false }),
  field('fld-type', '合同类型', 3, 'SingleSelect', {
    options: [
      { name: '租赁合同' },
      { name: '维保合同' },
      { name: '维修合同' },
      { name: '其他合同' },
    ],
  }),
  field('fld-stage', '签订状态', 24, 'Stage'),
  field('fld-amount', '合同金额', 2, 'Currency'),
  field('fld-start', '合同开始日期', 5, 'DateTime'),
  field('fld-end', '合同结束日期', 5, 'DateTime'),
  field('fld-supplier', '供应商', 21, 'DuplexLink', {
    table_id: 'tbl-supplier',
    multiple: true,
  }),
  field('fld-company', '合同公司', 19, 'Lookup'),
  field('fld-payment', '付款计划', 21, 'DuplexLink', {
    table_id: 'tbl-payment',
    multiple: true,
  }),
  field('fld-report-code', '签报号', 1, 'Text'),
  field('fld-report-amount', '签报金额', 2, 'Currency'),
  field('fld-attachment', '合同附件', 17, 'Attachment'),
  field('fld-specialty', '专业类别', 3, 'SingleSelect', {
    options: [{ name: '电气' }, { name: '暖通' }, { name: '其他' }],
  }),
  field('fld-framework-text', '关联框架合同', 1, 'Text'),
  field('fld-building', '对应楼栋设备', 1, 'Text'),
  field('fld-framework', '框架引用', 21, 'DuplexLink', {
    table_id: 'tbl-framework',
    multiple: true,
  }),
  field('fld-review-time', '付款与合同差异核验时间', 5, 'DateTime'),
  field('fld-review', '付款与合同差异核验指纹', 1, 'Text'),
];

const supplierFields: BitableFieldMeta[] = [
  field('fld-contact', '联系人', 1, 'Text'),
  field('fld-company', '公司单位', 1, 'Text'),
  field('fld-phone', '联系电话', 13, 'Phone'),
  field('fld-email', '邮箱地址', 1, 'Text'),
  field('fld-contracts', '关联合同编号', 21, 'DuplexLink', {
    table_id: 'tbl-execution',
    multiple: true,
  }),
  field('fld-liaison', '园区对接人', 11, 'User', { multiple: false }),
];

describe('contract creation field rules', () => {
  it('builds different writable form definitions from the real table schemas', () => {
    const framework = buildContractCreateDefinition(
      'framework',
      frameworkFields,
    );
    const execution = buildContractCreateDefinition(
      'execution',
      executionFields,
    );

    expect(framework.map((item) => item.name)).toEqual([
      '合同编号',
      '合同名称',
      '合同类型',
      '合同开始日期',
      '合同结束日期',
      '合同附件',
    ]);
    expect(execution.map((item) => item.name)).toEqual([
      '合同编号',
      '合同名称',
      '跟进人',
      '合同类型',
      '合同金额',
      '合同开始日期',
      '合同结束日期',
      '签报号',
      '签报金额',
      '合同附件',
      '专业类别',
      '对应楼栋设备',
    ]);
    expect(execution).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '签订状态' }),
        expect.objectContaining({ name: '合同公司' }),
        expect.objectContaining({ name: '付款计划' }),
        expect.objectContaining({ name: '付款与合同差异核验时间' }),
        expect.objectContaining({ name: '付款与合同差异核验指纹' }),
      ]),
    );
    expect(execution.find((item) => item.name === '合同类型')?.options).toEqual(
      [
        { value: '租赁合同', label: '租赁合同' },
        { value: '维保合同', label: '维保合同' },
        { value: '维修合同', label: '维修合同' },
        { value: '其他合同', label: '其他合同' },
      ],
    );
  });

  it('converts user, date, links and attachment tokens to Bitable v1 values', () => {
    const definition = buildContractCreateDefinition(
      'execution',
      executionFields,
    );
    const values = valuesByName(definition, {
      合同编号: '  VNET-2026-001  ',
      合同名称: 'UPS 维保合同',
      跟进人: 'ou_owner',
      合同类型: '维保合同',
      合同金额: 128000,
      合同开始日期: '2026-07-13',
      合同结束日期: '2027-07-12',
      专业类别: '电气',
    });

    expect(
      buildContractRecordFields(
        {
          kind: 'execution',
          idempotencyKey: '6b8fbc5a-1047-4e40-b083-906960893894',
          fields: values,
          supplier: { mode: 'existing', recordId: 'rec-supplier' },
          linkFramework: true,
          frameworkRecordId: 'rec-framework',
        },
        definition,
        {
          supplierRecordId: 'rec-supplier',
          frameworkRecordId: 'rec-framework',
          frameworkLabel: '框架合同 A',
          attachmentTokens: ['box-pdf'],
        },
      ),
    ).toEqual({
      合同编号: 'VNET-2026-001',
      合同名称: 'UPS 维保合同',
      跟进人: [{ id: 'ou_owner' }],
      合同类型: '维保合同',
      合同金额: 128000,
      合同开始日期: Date.parse('2026-07-13T00:00:00+08:00'),
      合同结束日期: Date.parse('2027-07-12T00:00:00+08:00'),
      专业类别: '电气',
      供应商: ['rec-supplier'],
      框架引用: ['rec-framework'],
      关联框架合同: '框架合同 A',
      合同附件: [{ file_token: 'box-pdf' }],
    });
  });

  it('rejects a nonexistent calendar date when creating a contract', () => {
    const definition = buildContractCreateDefinition(
      'execution',
      executionFields,
    );
    const values = valuesByName(definition, {
      合同编号: 'VNET-2026-001',
      合同名称: 'UPS 维保合同',
      跟进人: 'ou_owner',
      合同类型: '维保合同',
      合同金额: 128000,
      合同开始日期: '2026-02-31',
      合同结束日期: '2027-07-12',
      专业类别: '电气',
    });

    expect(() =>
      buildContractRecordFields(
        {
          kind: 'execution',
          idempotencyKey: '6b8fbc5a-1047-4e40-b083-906960893894',
          fields: values,
          supplier: { mode: 'existing', recordId: 'rec-supplier' },
          linkFramework: false,
        },
        definition,
        {
          supplierRecordId: 'rec-supplier',
          attachmentTokens: ['box-pdf'],
        },
      ),
    ).toThrow('合同开始日期必须是有效日期');
  });

  it('rejects a nonexistent calendar date in a partial contract edit', () => {
    const definition = buildContractCreateDefinition(
      'execution',
      executionFields,
    );
    const values = valuesByName(definition, {
      合同结束日期: '2026-02-31',
    });

    expect(() => buildContractPartialEditFields(values, definition)).toThrow(
      '合同结束日期必须是有效日期',
    );
  });

  it('rejects values outside the real select options instead of creating options', () => {
    const definition = buildContractCreateDefinition(
      'execution',
      executionFields,
    );
    const values = valuesByName(definition, {
      合同编号: 'VNET-2026-001',
      合同名称: 'UPS 维保合同',
      跟进人: 'ou_owner',
      合同类型: '服务合同',
      合同金额: 128000,
      合同开始日期: '2026-07-13',
      合同结束日期: '2027-07-12',
      专业类别: '电气',
    });

    expect(() =>
      buildContractRecordFields(
        {
          kind: 'execution',
          idempotencyKey: '6b8fbc5a-1047-4e40-b083-906960893894',
          fields: values,
          supplier: { mode: 'existing', recordId: 'rec-supplier' },
          linkFramework: false,
        },
        definition,
        {
          supplierRecordId: 'rec-supplier',
          attachmentTokens: ['box-pdf'],
        },
      ),
    ).toThrow('合同类型不是多维表已有选项');
  });

  it('builds only writable supplier fields and requires the company name', () => {
    const definition = buildSupplierCreateDefinition(supplierFields);
    expect(definition.map((item) => item.name)).toEqual([
      '联系人',
      '公司单位',
      '联系电话',
      '邮箱地址',
      '园区对接人',
    ]);

    expect(
      buildSupplierRecordFields(
        valuesByName(definition, {
          联系人: '示例人员008',
          公司单位: '南通测试供应商',
          联系电话: '13800009626',
          邮箱地址: 'test@example.com',
          园区对接人: 'ou_liaison',
        }),
        definition,
      ),
    ).toEqual({
      联系人: '示例人员008',
      公司单位: '南通测试供应商',
      联系电话: '13800009626',
      邮箱地址: 'test@example.com',
      园区对接人: [{ id: 'ou_liaison' }],
    });

    expect(() =>
      buildSupplierRecordFields(
        valuesByName(definition, { 联系人: '示例人员008' }),
        definition,
      ),
    ).toThrow('公司单位不能为空');
  });
});

function field(
  fieldId: string,
  name: string,
  type: number,
  uiType: string,
  property: BitableFieldMeta['property'] = {},
): BitableFieldMeta {
  return {
    field_id: fieldId,
    field_name: name,
    type,
    ui_type: uiType,
    property,
  };
}

function valuesByName(
  definition: ContractCreateFieldDefinition[],
  values: Record<string, string | number | boolean | string[]>,
): ContractCreateRequest['fields'] {
  return Object.fromEntries(
    definition.flatMap((item) =>
      item.name in values ? [[item.fieldId, values[item.name]]] : [],
    ),
  );
}
