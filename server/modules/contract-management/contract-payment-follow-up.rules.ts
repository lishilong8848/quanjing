import type {
  ContractCreatePaymentPlanInput,
  ContractPaymentPlanAdjustRequest,
  ContractPaymentPlanConfirmRequest,
} from '../../../shared/contract-management.interface';
import {
  CONTRACT_PAYMENT_PERIODS,
  CONTRACT_PAYMENT_STATUSES,
} from '../../../shared/contract-field-config';
import type { BitableFieldMeta } from './contract-creation.rules';

export interface ContractPaymentFieldSchema {
  periods: string[];
  statuses: string[];
}

const FIELD_TYPES = {
  period: ['付款周期', 3],
  contract: ['合同编号', 21],
  owner: ['跟进人', 11],
  plannedAmount: ['计划付款金额', 2],
  plannedPaymentDate: ['计划付款日期', 5],
  actualAmount: ['实际付款金额', 2],
  paymentDate: ['付款日期', 5],
  status: ['付款状态', 3],
} as const;

export const FIXED_PAYMENT_FIELDS: BitableFieldMeta[] = [
  fieldMeta('payment-period', '付款周期', 3, [...CONTRACT_PAYMENT_PERIODS]),
  fieldMeta('contract-record', '合同编号', 21),
  fieldMeta('payment-owner', '跟进人', 11),
  fieldMeta('planned-amount', '计划付款金额', 2),
  fieldMeta('planned-payment-date', '计划付款日期', 5),
  fieldMeta('actual-amount', '实际付款金额', 2),
  fieldMeta('payment-date', '付款日期', 5),
  fieldMeta('payment-status', '付款状态', 3, [...CONTRACT_PAYMENT_STATUSES]),
];

export function buildPaymentFieldSchema(
  fields: BitableFieldMeta[],
): ContractPaymentFieldSchema {
  const period = requireField(fields, ...FIELD_TYPES.period);
  const status = requireField(fields, ...FIELD_TYPES.status);
  return {
    periods: selectOptions(period),
    statuses: selectOptions(status),
  };
}

export function buildPaymentCreateFields(
  fields: BitableFieldMeta[],
  request: ContractCreatePaymentPlanInput,
  contractRecordId: string,
): Record<string, unknown> {
  requireField(fields, ...FIELD_TYPES.contract);
  requireField(fields, ...FIELD_TYPES.owner);
  requireField(fields, ...FIELD_TYPES.plannedAmount);
  requireField(fields, ...FIELD_TYPES.plannedPaymentDate);
  const schema = buildPaymentFieldSchema(fields);
  assertOption('付款周期', request.period, schema.periods);
  assertOption('付款状态', '未付款', schema.statuses);
  return {
    付款周期: request.period.trim(),
    合同编号: [recordId(contractRecordId, '合同编号')],
    跟进人: [{ id: openId(request.ownerOpenId) }],
    计划付款金额: positiveMoney(request.plannedAmount, '计划付款金额'),
    计划付款日期: dateValue(request.plannedPaymentDate, '计划付款日期'),
    付款状态: '未付款',
  };
}

function fieldMeta(
  fieldId: string,
  name: string,
  type: number,
  options: string[] = [],
): BitableFieldMeta {
  return {
    field_id: fieldId,
    field_name: name,
    type,
    property: {
      options: options.map((option) => ({ name: option })),
    },
  };
}

export function buildPaymentAdjustFields(
  fields: BitableFieldMeta[],
  request: ContractPaymentPlanAdjustRequest,
): Record<string, unknown> {
  requireField(fields, ...FIELD_TYPES.owner);
  requireField(fields, ...FIELD_TYPES.plannedAmount);
  requireField(fields, ...FIELD_TYPES.plannedPaymentDate);
  const schema = buildPaymentFieldSchema(fields);
  assertOption('付款周期', request.period, schema.periods);
  return {
    付款周期: request.period.trim(),
    跟进人: [{ id: openId(request.ownerOpenId) }],
    计划付款金额: positiveMoney(request.plannedAmount, '计划付款金额'),
    计划付款日期: dateValue(request.plannedPaymentDate, '计划付款日期'),
  };
}

export function buildPaymentConfirmFields(
  fields: BitableFieldMeta[],
  request: ContractPaymentPlanConfirmRequest,
): Record<string, unknown> {
  requireField(fields, ...FIELD_TYPES.actualAmount);
  requireField(fields, ...FIELD_TYPES.paymentDate);
  const schema = buildPaymentFieldSchema(fields);
  assertOption('付款状态', '已付款', schema.statuses);
  return {
    实际付款金额: positiveMoney(request.actualAmount, '实际付款金额'),
    付款日期: dateValue(request.paymentDate, '付款日期'),
    付款状态: '已付款',
  };
}

function requireField(
  fields: BitableFieldMeta[],
  name: string,
  type: number,
): BitableFieldMeta {
  const field = fields.find((item) => item.field_name === name);
  if (!field || field.type !== type || field.is_hidden) {
    throw new Error(`付款计划多维表缺少可用字段：${name}`);
  }
  return field;
}

function selectOptions(field: BitableFieldMeta): string[] {
  return [
    ...new Set(
      (field.property?.options || [])
        .map((item) => clean(item.name))
        .filter(Boolean),
    ),
  ];
}

function assertOption(label: string, value: unknown, options: string[]): void {
  const selected = clean(value);
  if (!selected || !options.includes(selected)) {
    throw new Error(`${label}不是付款计划多维表已有选项`);
  }
}

function positiveMoney(value: unknown, label: string): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${label}必须大于 0`);
  }
  return amount;
}

function dateValue(value: unknown, label: string): number {
  const date = clean(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`${label}必须是有效日期`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`${label}必须是有效日期`);
  }
  return Date.parse(`${date}T00:00:00+08:00`);
}

function openId(value: unknown): string {
  const id = clean(value);
  if (!/^ou_[A-Za-z0-9]+$/.test(id)) {
    throw new Error('跟进人人员标识无效');
  }
  return id;
}

function recordId(value: unknown, label: string): string {
  const id = clean(value);
  if (!/^rec[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`${label}记录标识无效`);
  }
  return id;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
