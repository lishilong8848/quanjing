import type {
  ContractCreateFieldDefinition,
  ContractCreateKind,
  ContractCreateOptionsResponse,
  ContractPaymentFollowUpItem,
  ContractPaymentFollowUpOptionsResponse,
} from './contract-management.interface';

const FRAMEWORK_FIELDS: readonly ContractCreateFieldDefinition[] = [
  field('fldmtS2Wz0', '合同编号', 'text', true, 'basic'),
  field('fldevaGzNk', '合同名称', 'text', true, 'basic'),
  field('fldoVeQfJE', '合同类型', 'select', true, 'basic', [
    '总部集采',
    '属地自采',
  ]),
  field('fldFBG4U1E', '合同开始日期', 'date', true, 'commercial'),
  field('fld0kRBf1A', '合同结束日期', 'date', true, 'commercial'),
  field('flduOOnUpH', '合同附件', 'attachment', true, 'attachment'),
];

const EXECUTION_FIELDS: readonly ContractCreateFieldDefinition[] = [
  field('fldbOaLbUD', '合同编号', 'text', true, 'basic'),
  field('fldl8lAeAw', '合同名称', 'text', true, 'basic'),
  field('fldxPuYT19', '跟进人', 'user', true, 'basic'),
  field('fldlu37YRh', '合同类型', 'select', true, 'basic', [
    '租赁合同',
    '维保合同',
    '维修合同',
    '其他合同',
  ]),
  field('flda4ARUY9', '合同金额', 'number', true, 'commercial'),
  field('fldTKcyksD', '合同开始日期', 'date', true, 'commercial'),
  field('fldEcltbl1', '合同结束日期', 'date', true, 'commercial'),
  field('fldz3qDuIY', '签报号', 'text', false, 'commercial'),
  field('fldlY2WnNz', '签报金额', 'number', false, 'commercial'),
  field('fldc862dck', '合同附件', 'attachment', true, 'attachment'),
  field('fldGqKUOPN', '专业类别', 'select', true, 'basic', [
    '电气',
    '暖通',
    '弱电',
    '消防',
    '土建',
    '其他',
  ]),
  field('fldvkLAuxc', '对应楼栋设备', 'text', false, 'other'),
];

const SUPPLIER_FIELDS: readonly ContractCreateFieldDefinition[] = [
  field('fld7XJlAfD', '联系人', 'text', false, 'other'),
  field('fld7wwRKhu', '公司单位', 'text', true, 'other'),
  field('fldH9YKIX8', '联系电话', 'text', false, 'other', [], 'tel'),
  field('fldSE2n6Pv', '邮箱地址', 'text', false, 'other', [], 'email'),
  field('fldOSoZVHD', '园区对接人', 'user', false, 'relationship'),
];

export const CONTRACT_PAYMENT_PERIODS = [
  '一次性',
  '一期',
  '二期',
  '三期',
  '四期',
] as const;

export const CONTRACT_PAYMENT_STATUSES = [
  '未付款',
  '流程中',
  '已付款',
] as const;

const UPLOAD_OPTIONS: ContractCreateOptionsResponse['upload'] = {
  accept: 'application/pdf',
  required: true,
  maxFiles: 5,
  maxFileSize: 20 * 1024 * 1024,
};

export function createFixedContractOptions(
  kind: ContractCreateKind,
): ContractCreateOptionsResponse {
  return {
    kind,
    fields: cloneFields(
      kind === 'framework' ? FRAMEWORK_FIELDS : EXECUTION_FIELDS,
    ),
    supplierFields: cloneFields(SUPPLIER_FIELDS),
    frameworks: [],
    suppliers: [],
    people: [],
    upload: { ...UPLOAD_OPTIONS },
  };
}

export function createFixedPaymentFollowUpOptions(
  item: ContractPaymentFollowUpItem,
): ContractPaymentFollowUpOptionsResponse {
  return {
    contract: {
      recordId: item.contractRecordId,
      code: item.contractCode,
      name: item.contractName,
      ownerOpenId: '',
      ownerName: item.owner,
    },
    periods: [...CONTRACT_PAYMENT_PERIODS],
    statuses: [...CONTRACT_PAYMENT_STATUSES],
    people: [],
    plans: [],
  };
}

function field(
  fieldId: string,
  name: string,
  control: ContractCreateFieldDefinition['control'],
  required: boolean,
  group: ContractCreateFieldDefinition['group'],
  options: readonly string[] = [],
  inputType: ContractCreateFieldDefinition['inputType'] = 'text',
): ContractCreateFieldDefinition {
  return {
    fieldId,
    name,
    control,
    required,
    multiple: false,
    group,
    inputType,
    options: options.map((value) => ({ value, label: value })),
  };
}

function cloneFields(
  fields: readonly ContractCreateFieldDefinition[],
): ContractCreateFieldDefinition[] {
  return fields.map((item) => ({
    ...item,
    options: item.options.map((option) => ({ ...option })),
  }));
}
