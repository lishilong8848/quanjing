import type {
  ContractPaymentPlanAdjustRequest,
  ContractPaymentPlanConfirmRequest,
  ContractPaymentPlanCreateRequest,
} from '../../../shared/contract-management.interface';
import {
  buildPaymentAdjustFields,
  buildPaymentConfirmFields,
  buildPaymentCreateFields,
  buildPaymentFieldSchema,
} from './contract-payment-follow-up.rules';
import type { BitableFieldMeta } from './contract-creation.rules';

const fields: BitableFieldMeta[] = [
  field('formula-primary', '付款计划', 20, 'Formula'),
  field('period', '付款周期', 3, 'SingleSelect', ['一次性', '一期', '二期']),
  field('contract', '合同编号', 21, 'DuplexLink'),
  field('owner', '跟进人', 11, 'User'),
  field('planned', '计划付款金额', 2, 'Currency'),
  field('planned-date', '计划付款日期', 5, 'DateTime'),
  field('actual', '实际付款金额', 2, 'Currency'),
  field('actual-date', '付款日期', 5, 'DateTime'),
  field('status', '付款状态', 3, 'SingleSelect', [
    '未付款',
    '流程中',
    '已付款',
  ]),
  field('ratio', '付款总占比', 20, 'Formula'),
  field('parent', '父记录', 18, 'SingleLink'),
];

describe('contract payment follow-up rules', () => {
  it('derives selectable values from the live payment table metadata', () => {
    expect(buildPaymentFieldSchema(fields)).toEqual({
      periods: ['一次性', '一期', '二期'],
      statuses: ['未付款', '流程中', '已付款'],
    });
  });

  it('builds a new plan with a forced contract link and unpaid status', () => {
    const request = {
      idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
      period: '一期',
      plannedAmount: 1200,
      plannedPaymentDate: '2026-07-20',
      ownerOpenId: 'ou_owner123',
    } as unknown as ContractPaymentPlanCreateRequest;

    expect(buildPaymentCreateFields(fields, request, 'rec_contract')).toEqual({
      付款周期: '一期',
      合同编号: ['rec_contract'],
      跟进人: [{ id: 'ou_owner123' }],
      计划付款金额: 1200,
      计划付款日期: Date.parse('2026-07-20T00:00:00+08:00'),
      付款状态: '未付款',
    });
  });

  it('allows adjustment of plan fields without changing payment confirmation fields', () => {
    const request = {
      period: '二期',
      plannedAmount: 800,
      plannedPaymentDate: '2026-08-20',
      ownerOpenId: 'ou_owner123',
    } as unknown as ContractPaymentPlanAdjustRequest;

    expect(buildPaymentAdjustFields(fields, request)).toEqual({
      付款周期: '二期',
      跟进人: [{ id: 'ou_owner123' }],
      计划付款金额: 800,
      计划付款日期: Date.parse('2026-08-20T00:00:00+08:00'),
    });
  });

  it('confirms payment with an actual amount, date and forced paid status', () => {
    const request: ContractPaymentPlanConfirmRequest = {
      actualAmount: 800,
      paymentDate: '2026-08-21',
    };

    expect(buildPaymentConfirmFields(fields, request)).toEqual({
      实际付款金额: 800,
      付款日期: Date.parse('2026-08-21T00:00:00+08:00'),
      付款状态: '已付款',
    });
  });

  it('rejects unknown select values, invalid money, dates and user ids', () => {
    expect(() =>
      buildPaymentCreateFields(
        fields,
        {
          idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
          period: '五期',
          plannedAmount: 1200,
          plannedPaymentDate: '2026-07-20',
          ownerOpenId: 'ou_owner123',
        } as unknown as ContractPaymentPlanCreateRequest,
        'rec_contract',
      ),
    ).toThrow('付款周期');
    expect(() =>
      buildPaymentConfirmFields(fields, {
        actualAmount: -1,
        paymentDate: '2026-07-20',
      }),
    ).toThrow('实际付款金额');
    expect(() =>
      buildPaymentAdjustFields(fields, {
        period: '一期',
        plannedAmount: 1,
        plannedPaymentDate: '2026-02-31',
        ownerOpenId: 'owner',
      } as unknown as ContractPaymentPlanAdjustRequest),
    ).toThrow();
  });
});

function field(
  fieldId: string,
  name: string,
  type: number,
  uiType: string,
  options: string[] = [],
): BitableFieldMeta {
  return {
    field_id: fieldId,
    field_name: name,
    type,
    ui_type: uiType,
    property: { options: options.map((option) => ({ name: option })) },
  };
}
