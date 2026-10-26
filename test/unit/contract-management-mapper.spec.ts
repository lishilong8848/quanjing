import { buildContractManagementDashboard } from '../../server/modules/contract-management/contract-management.mapper';

describe('contract management mapper', () => {
  it('builds lifecycle, value, payment and risk summaries from linked contract tables', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T06:00:00.000Z',
      sourceUrl: 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
      now: new Date('2026-07-11T06:00:00.000Z'),
      frameworkContracts: [
        {
          record_id: 'framework-1',
          fields: {
            合同名称: '冷却塔维保框架',
            合同编号: 'FW-001',
            合同类型: '总部集采',
            合同开始日期: 1767225600000,
            合同结束日期: 1804003200000,
          },
        },
      ],
      executionContracts: [
        {
          record_id: 'contract-active',
          fields: {
            合同名称: 'C楼水处理药剂及服务',
            合同编号: 'V-001',
            合同金额: 180130,
            合同类型: '维保合同',
            专业类别: '暖通',
            合同开始日期: 1756684800000,
            合同结束日期: '2026-10-31',
            合同公司: '纳尔科（中国）环保技术服务有限公司、,',
            跟进人: [{ name: '曹李培' }],
          },
        },
        {
          record_id: 'contract-expiring',
          fields: {
            合同名称: '宿舍租赁合同',
            合同编号: 'V-002',
            合同金额: 72000,
            合同类型: '租赁合同',
            专业类别: '其他',
            合同开始日期: 1754006400000,
            合同结束日期: 1785427200000,
            合同公司: '南通开发区控股集团',
            跟进人: [{ name: '曹李培' }],
          },
        },
        {
          record_id: 'contract-expired',
          fields: {
            合同名称: '历史维修合同',
            合同编号: 'V-003',
            合同金额: 13150,
            合同类型: '维修合同',
            专业类别: '电气',
            合同开始日期: 1721433600000,
            合同结束日期: 1755648000000,
            合同公司: '维修供应商',
          },
        },
      ],
      suppliers: [
        {
          record_id: 'supplier-1',
          fields: { 公司单位: '纳尔科（中国）环保技术服务有限公司' },
        },
        { record_id: 'supplier-2', fields: { 公司单位: '南通开发区控股集团' } },
      ],
      paymentPlans: [
        {
          record_id: 'payment-paid',
          fields: {
            合同编号: [{ record_ids: ['contract-active'] }],
            付款计划: 'V-001 一期',
            计划付款日期: 1783785600000,
            计划付款金额: 100000,
            实际付款金额: 100000,
            付款状态: '已付款',
            付款周期: '一期',
          },
        },
        {
          record_id: 'payment-overdue',
          fields: {
            合同编号: [{ record_ids: ['contract-expiring'] }],
            付款计划: 'V-002 一次性',
            计划付款日期: 1783612800000,
            计划付款金额: 72000,
            实际付款金额: 0,
            付款状态: '未付款',
            付款周期: '一次性',
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 1 },
        contracts: { configured: true, count: 3 },
        suppliers: { configured: true, count: 2 },
        payments: { configured: true, count: 2 },
      },
    });

    expect(dashboard.summary).toMatchObject({
      totalContracts: 3,
      activeContracts: 1,
      expiringContracts: 1,
      expiredContracts: 1,
      totalValue: 265280,
      plannedPaymentAmount: 172000,
      paidAmount: 100000,
      pendingPaymentAmount: 72000,
      overduePayments: 1,
      supplierCount: 2,
    });
    expect(
      dashboard.contracts.find((item) => item.recordId === 'contract-expiring'),
    ).toMatchObject({
      status: 'expiring',
      daysRemaining: 20,
    });
    expect(
      dashboard.contracts.find((item) => item.recordId === 'contract-active'),
    ).toMatchObject({
      supplier: '纳尔科（中国）环保技术服务有限公司',
      paymentCycle: '一次性',
    });
    expect(
      dashboard.contracts.find((item) => item.recordId === 'contract-expired'),
    ).toMatchObject({ status: 'expired' });
    expect(dashboard.typeBreakdown[0]).toMatchObject({
      contractType: '维保合同',
      count: 1,
      amount: 180130,
    });
    expect(dashboard.paymentProgress).toMatchObject({ completionRate: 58.1 });
    expect(dashboard.paymentRisks[0]).toMatchObject({
      recordId: 'payment-overdue',
      contractRecordId: 'contract-expiring',
      contractName: '宿舍租赁合同',
      risk: 'overdue',
    });
    expect(dashboard.contractRisks[0]).toMatchObject({
      recordId: 'contract-expiring',
      status: 'expiring',
    });
    expect(
      dashboard.contractRisks.find(
        (item) => item.recordId === 'contract-expired',
      ),
    ).toBeUndefined();
  });

  it('builds expired-contract payment follow-ups from payment-plan records', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-13T06:00:00.000Z',
      sourceUrl: 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
      now: new Date('2026-07-13T06:00:00.000Z'),
      frameworkContracts: [],
      suppliers: [],
      executionContracts: [
        contractRecord('contract-missing-plan', '无付款条目合同', '2026-01-01'),
        contractRecord('contract-unpaid-high', '高额未付款合同', '2026-02-01'),
        contractRecord('contract-unpaid-low', '低额未付款合同', '2026-03-01'),
        contractRecord('contract-paid', '已完成付款合同', '2026-04-01'),
        {
          ...contractRecord(
            'contract-no-payment-required',
            '无需付款合同',
            '2026-05-01',
          ),
          fields: {
            ...contractRecord(
              'contract-no-payment-required',
              '无需付款合同',
              '2026-05-01',
            ).fields,
            付款跟进处置: '无需付款',
          },
        },
        contractRecord('contract-active', '未到期合同', '2026-12-31'),
      ],
      paymentPlans: [
        paymentRecord(
          'payment-high-paid',
          'contract-unpaid-high',
          70,
          70,
          '已付款',
        ),
        paymentRecord(
          'payment-high-pending',
          'contract-unpaid-high',
          100,
          20,
          '部分付款',
        ),
        paymentRecord(
          'payment-low-pending',
          'contract-unpaid-low',
          50,
          0,
          '未付款',
        ),
        paymentRecord('payment-paid', 'contract-paid', 80, 80, '已付款'),
        paymentRecord('payment-active', 'contract-active', 500, 0, '未付款'),
      ],
      sectionStatus: emptySectionStatus(),
    });

    const followUps = (dashboard as any).paymentFollowUps;
    expect(followUps.map((item: any) => item.contractRecordId)).toEqual([
      'contract-missing-plan',
      'contract-unpaid-high',
      'contract-unpaid-low',
    ]);
    expect(followUps[0]).toMatchObject({
      reason: 'missing_plan',
      planCount: 0,
      unpaidPlanCount: 0,
      pendingAmount: 0,
    });
    expect(followUps[1]).toMatchObject({
      reason: 'unpaid_plan',
      planCount: 2,
      unpaidPlanCount: 1,
      plannedAmount: 170,
      paidAmount: 90,
      pendingAmount: 80,
    });
    expect(followUps).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contractRecordId: 'contract-paid' }),
        expect.objectContaining({
          contractRecordId: 'contract-no-payment-required',
        }),
        expect.objectContaining({ contractRecordId: 'contract-active' }),
      ]),
    );
    expect(
      dashboard.contracts.find(
        (item) => item.recordId === 'contract-no-payment-required',
      ),
    ).toMatchObject({ paymentFollowUpDisposition: '无需付款' });
  });

  it('derives payment nature from the number of plans linked to each contract', () => {
    const executionContracts = [1, 2, 3, 4].map((count) =>
      contractRecord(
        `contract-${count}`,
        `${count}条付款计划合同`,
        '2026-12-31',
      ),
    );
    const paymentPlans = executionContracts.flatMap((contract, contractIndex) =>
      Array.from({ length: contractIndex + 1 }, (_, paymentIndex) =>
        paymentRecord(
          `payment-${contractIndex + 1}-${paymentIndex + 1}`,
          contract.record_id,
          100,
          0,
          '未付款',
        ),
      ),
    );
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-15T01:00:00.000Z',
      sourceUrl: 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
      now: new Date('2026-07-15T01:00:00.000Z'),
      frameworkContracts: [],
      suppliers: [],
      executionContracts,
      paymentPlans,
      sectionStatus: emptySectionStatus(),
    });

    expect(
      Object.fromEntries(
        dashboard.contracts.map((item) => [item.recordId, item.paymentCycle]),
      ),
    ).toEqual({
      'contract-1': '一次性',
      'contract-2': '二期',
      'contract-3': '三期',
      'contract-4': '四期',
    });
  });

  it('classifies supplier cooperation depth with inclusive 5万 and 10万 boundaries', () => {
    const amounts = [49999, 50000, 100000, 100001];
    const executionContracts = amounts.map((amount, index) => ({
      ...contractRecord(
        `contract-depth-${index}`,
        `合作合同-${index}`,
        '2026-12-31',
      ),
      fields: {
        ...contractRecord(
          `contract-depth-${index}`,
          `合作合同-${index}`,
          '2026-12-31',
        ).fields,
        合同金额: amount,
      },
    }));
    const suppliers = amounts.map((_, index) => ({
      record_id: `supplier-depth-${index}`,
      fields: {
        公司单位: `供应商-${index}`,
        关联合同编号: [{ record_ids: [`contract-depth-${index}`] }],
      },
    }));
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-15T01:00:00.000Z',
      sourceUrl: 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
      now: new Date('2026-07-15T01:00:00.000Z'),
      frameworkContracts: [],
      suppliers,
      executionContracts,
      paymentPlans: [],
      sectionStatus: emptySectionStatus(),
    });

    expect(
      dashboard.supplierDirectory.items.map((item) => ({
        amount: item.linkedContractAmount,
        depth: item.cooperationDepth,
      })),
    ).toEqual([
      { amount: 49999, depth: 'under_50k' },
      { amount: 50000, depth: '50k_to_100k' },
      { amount: 100000, depth: '50k_to_100k' },
      { amount: 100001, depth: 'over_100k' },
    ]);
  });
});

function contractRecord(recordId: string, name: string, endDate: string) {
  return {
    record_id: recordId,
    fields: {
      合同名称: name,
      合同编号: `HT-${recordId}`,
      合同金额: 1000,
      合同开始日期: '2025-01-01',
      合同结束日期: endDate,
      跟进人: [{ name: '合同负责人' }],
    },
  };
}

function paymentRecord(
  recordId: string,
  contractRecordId: string,
  plannedAmount: number,
  actualAmount: number,
  status: string,
) {
  return {
    record_id: recordId,
    fields: {
      合同编号: [{ record_ids: [contractRecordId] }],
      付款计划: recordId,
      计划付款日期: '2026-01-15',
      计划付款金额: plannedAmount,
      实际付款金额: actualAmount,
      付款状态: status,
    },
  };
}

function emptySectionStatus() {
  return {
    framework: { configured: true, count: 0 },
    contracts: { configured: true, count: 0 },
    suppliers: { configured: true, count: 0 },
    payments: { configured: true, count: 0 },
  };
}
