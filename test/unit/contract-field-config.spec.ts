import {
  CONTRACT_PAYMENT_PERIODS,
  CONTRACT_PAYMENT_STATUSES,
  createFixedContractOptions,
  createFixedPaymentFollowUpOptions,
} from '../../shared/contract-field-config';

describe('fixed contract field configuration', () => {
  it('keeps framework, execution and supplier fields available without remote schema reads', () => {
    const framework = createFixedContractOptions('framework');
    const execution = createFixedContractOptions('execution');

    expect(framework.fields.map((field) => field.name)).toEqual([
      '合同编号',
      '合同名称',
      '合同类型',
      '合同开始日期',
      '合同结束日期',
      '合同附件',
    ]);
    expect(execution.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '跟进人', control: 'user' }),
        expect.objectContaining({ name: '合同金额', control: 'number' }),
        expect.objectContaining({ name: '专业类别', control: 'select' }),
        expect.objectContaining({ name: '合同附件', control: 'attachment' }),
      ]),
    );
    expect(execution.fields.map((field) => field.name)).not.toContain(
      '付款与合同差异核验时间',
    );
    expect(execution.supplierFields.map((field) => field.name)).toEqual([
      '联系人',
      '公司单位',
      '联系电话',
      '邮箱地址',
      '园区对接人',
    ]);
  });

  it('provides fixed payment choices while leaving record options for background sync', () => {
    const options = createFixedPaymentFollowUpOptions({
      contractRecordId: 'rec_contract',
      contractName: '测试合同',
      contractCode: 'HT-001',
      owner: '合同负责人',
      contractAmount: 100,
      contractEndDate: '2026-12-31',
      reason: 'missing_plan',
      planCount: 0,
      unpaidPlanCount: 0,
      plannedAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
      attachments: [],
    });

    expect(options.periods).toEqual([...CONTRACT_PAYMENT_PERIODS]);
    expect(options.statuses).toEqual([...CONTRACT_PAYMENT_STATUSES]);
    expect(options.people).toEqual([]);
    expect(options.plans).toEqual([]);
  });
});
