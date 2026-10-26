import type {
  ContractManagementItem,
  ContractPaymentItem,
} from '../../shared/contract-management.interface';
import {
  buildPaymentPlanMonthlyTrend,
  buildPaymentTrendChartItems,
  buildPendingPaymentAnalytics,
  buildPaymentFollowUpTarget,
  countExpiredContractsInGeneratedMonth,
  filterContracts,
  findContractQuickSearchResults,
  findContractsWithoutPaymentPlans,
  findPendingPaymentItems,
  getTopActiveContractsByAmount,
  partitionPaymentAttentionItems,
  sumActiveContractValue,
} from '../../client/src/pages/ContractManagement/logic';
import * as contractLogic from '../../client/src/pages/ContractManagement/logic';

function contract(
  overrides: Partial<ContractManagementItem>,
): ContractManagementItem {
  return {
    recordId: 'contract-1',
    name: 'C楼水处理药剂及服务',
    code: 'V-001',
    amount: 180130,
    contractType: '维保合同',
    specialty: '暖通',
    supplier: '纳尔科（中国）环保技术服务有限公司',
    owner: '曹李培',
    startDate: '2025-09-01',
    endDate: '2026-08-31',
    status: 'active',
    daysRemaining: 51,
    expiryDisposition: '',
    paymentFollowUpDisposition: '',
    paymentCycle: '',
    paymentRequirement: '',
    paymentProgress: {
      plannedAmount: 0,
      paidAmount: 0,
      completionRate: 0,
    },
    attachments: [],
    ...overrides,
  };
}

function payment(overrides: Partial<ContractPaymentItem>): ContractPaymentItem {
  return {
    recordId: 'payment-1',
    contractRecordId: 'contract-1',
    contractName: 'C楼水处理药剂及服务',
    contractCode: 'V-001',
    label: '一期付款',
    cycle: '一期',
    dueDate: '2026-07-15',
    plannedAmount: 1000,
    actualAmount: 0,
    status: '未付款',
    risk: 'dueSoon',
    daysUntilDue: 0,
    owner: '曹李培',
    ...overrides,
  };
}

describe('contract management page logic', () => {
  const contracts = [
    contract({ recordId: 'active' }),
    contract({
      recordId: 'expiring',
      name: '宿舍租赁合同',
      status: 'expiring',
    }),
    contract({
      recordId: 'expired',
      supplier: '历史供应商',
      status: 'expired',
    }),
  ];

  it('paginates card items with a clamped one-based page', () => {
    const paginateItems = (
      contractLogic as typeof contractLogic & {
        paginateItems?: <T>(
          items: T[],
          page: number,
          pageSize: number,
        ) => {
          items: T[];
          page: number;
          pageSize: number;
          totalItems: number;
          totalPages: number;
        };
      }
    ).paginateItems;

    expect(typeof paginateItems).toBe('function');
    expect(paginateItems?.([1, 2, 3, 4, 5, 6, 7], 2, 3)).toEqual({
      items: [4, 5, 6],
      page: 2,
      pageSize: 3,
      totalItems: 7,
      totalPages: 3,
    });
    expect(paginateItems?.([1, 2, 3, 4], 99, 3)).toMatchObject({
      items: [4],
      page: 2,
      totalPages: 2,
    });
  });

  it('filters by lifecycle status', () => {
    expect(filterContracts(contracts, 'expiring', '')).toEqual([
      expect.objectContaining({ recordId: 'expiring' }),
    ]);
  });

  it('searches contract code, name, supplier, owner, type and specialty', () => {
    expect(filterContracts(contracts, 'all', 'V-001')).toHaveLength(3);
    expect(filterContracts(contracts, 'all', '宿舍')).toHaveLength(1);
    expect(filterContracts(contracts, 'all', '历史供应商')).toHaveLength(1);
    expect(filterContracts(contracts, 'all', '曹李培')).toHaveLength(3);
    expect(filterContracts(contracts, 'all', '维保合同')).toHaveLength(3);
    expect(filterContracts(contracts, 'all', '暖通')).toHaveLength(3);
  });

  it('normalizes separators and multiple keywords for fuzzy contract search', () => {
    const searchable = [
      contract({
        recordId: 'fire-maintenance',
        code: 'V4892112P0038R002',
        name: '南通机房-消防维保服务及年检合同',
        supplier: '恒吉消防',
      }),
      contract({
        recordId: 'other',
        code: 'V4202603P0259A002',
        name: '南通AB楼柴发大维保采购订单',
      }),
    ];

    expect(filterContracts(searchable, 'all', 'V4892 112-P0038')).toEqual([
      expect.objectContaining({ recordId: 'fire-maintenance' }),
    ]);
    expect(filterContracts(searchable, 'all', '消防 恒吉')).toEqual([
      expect.objectContaining({ recordId: 'fire-maintenance' }),
    ]);
  });

  it('ranks exact and prefix code matches before descriptive matches and caps results', () => {
    const searchable = [
      contract({ recordId: 'description', code: 'OTHER', name: 'V-001 服务' }),
      contract({ recordId: 'contains', code: 'AB-V-001-Z' }),
      contract({ recordId: 'prefix', code: 'V-001-2026' }),
      contract({ recordId: 'exact', code: 'V-001' }),
      ...Array.from({ length: 5 }, (_, index) =>
        contract({ recordId: `extra-${index}`, code: `V-001-X${index}` }),
      ),
    ];

    expect(
      findContractQuickSearchResults(searchable, 'v 001', 6).map(
        (item) => item.recordId,
      ),
    ).toEqual(['exact', 'prefix', 'extra-0', 'extra-1', 'extra-2', 'extra-3']);
  });

  it('counts expired contracts in the Shanghai calendar month of generatedAt', () => {
    const monthContracts = [
      contract({
        recordId: 'july-start',
        endDate: '2026-07-01',
        status: 'expired',
      }),
      contract({
        recordId: 'july-end',
        endDate: '2026-07-31',
        status: 'expired',
      }),
      contract({
        recordId: 'august-start',
        endDate: '2026-08-01',
        status: 'expired',
      }),
      contract({
        recordId: 'july-active',
        endDate: '2026-07-20',
        status: 'active',
      }),
      contract({ recordId: 'missing-end', endDate: null, status: 'expired' }),
    ];

    expect(
      countExpiredContractsInGeneratedMonth(
        monthContracts,
        '2026-07-01T00:30:00+08:00',
      ),
    ).toBe(2);
    expect(
      countExpiredContractsInGeneratedMonth(
        monthContracts,
        '2026-07-31T16:30:00.000Z',
      ),
    ).toBe(1);
  });

  it('只汇总有效及履约中合同金额', () => {
    expect(
      sumActiveContractValue([
        contract({ status: 'active', amount: 100 }),
        contract({ status: 'expiring', amount: 200 }),
        contract({ status: 'expired', amount: 300 }),
        contract({ status: 'pending', amount: 400 }),
        contract({ status: 'unknown', amount: 500 }),
      ]),
    ).toBe(300);
  });

  it('按金额稳定生成履约中合同 TOP5', () => {
    const items = getTopActiveContractsByAmount([
      contract({
        recordId: 'b',
        code: 'B',
        name: 'B 合同',
        status: 'active',
        amount: 500,
      }),
      contract({
        recordId: 'a',
        code: 'A',
        name: 'A 合同',
        status: 'expiring',
        amount: 500,
      }),
      contract({
        recordId: 'expired',
        code: 'C',
        name: '失效合同',
        status: 'expired',
        amount: 1000,
      }),
      contract({ recordId: 'd', code: 'D', amount: 400 }),
      contract({ recordId: 'e', code: 'E', amount: 300 }),
      contract({ recordId: 'f', code: 'F', amount: 200 }),
      contract({ recordId: 'g', code: 'G', amount: 100 }),
    ]);

    expect(items.map((item) => item.code)).toEqual(['A', 'B', 'D', 'E', 'F']);
  });

  it('生成历史实付、本月及未来计划的连续七个月合同付款趋势', () => {
    const items = buildPaymentPlanMonthlyTrend(
      [
        payment({
          recordId: 'april',
          dueDate: '2026-04-30',
          plannedAmount: 100,
          actualAmount: 40,
        }),
        payment({
          recordId: 'may',
          dueDate: '2026-05-15',
          plannedAmount: 500,
          actualAmount: 100,
        }),
        payment({
          recordId: 'june-1',
          dueDate: '2026-06-01',
          plannedAmount: 200,
          actualAmount: 80,
        }),
        payment({
          recordId: 'june-2',
          dueDate: '2026-06-30',
          plannedAmount: 300,
          actualAmount: 20,
        }),
        payment({
          recordId: 'july-1',
          dueDate: '2026-07-01',
          plannedAmount: 200,
          actualAmount: 50,
        }),
        payment({
          recordId: 'july-2',
          dueDate: '2026-07-31',
          plannedAmount: 300,
          actualAmount: 0,
        }),
        payment({
          recordId: 'august',
          dueDate: '2026-08-01',
          plannedAmount: 200,
          actualAmount: 0,
        }),
        payment({
          recordId: 'missing-date',
          dueDate: null,
          plannedAmount: 999,
          actualAmount: 999,
        }),
      ],
      '2026-07-20T01:00:00.000Z',
    );

    expect(items).toEqual([
      {
        month: '2026-04',
        label: '04月',
        amount: 40,
        basis: 'actual',
        isCurrent: false,
      },
      {
        month: '2026-05',
        label: '05月',
        amount: 100,
        basis: 'actual',
        isCurrent: false,
      },
      {
        month: '2026-06',
        label: '06月',
        amount: 100,
        basis: 'actual',
        isCurrent: false,
      },
      {
        month: '2026-07',
        label: '07月',
        amount: 500,
        basis: 'planned',
        isCurrent: true,
      },
      {
        month: '2026-08',
        label: '08月',
        amount: 200,
        basis: 'planned',
        isCurrent: false,
      },
      {
        month: '2026-09',
        label: '09月',
        amount: 0,
        basis: 'planned',
        isCurrent: false,
      },
      {
        month: '2026-10',
        label: '10月',
        amount: 0,
        basis: 'planned',
        isCurrent: false,
      },
    ]);
  });

  it('让本月金额同时作为历史实付与未来计划面积图的连续交界点', () => {
    const chartItems = buildPaymentTrendChartItems([
      {
        month: '2026-06',
        label: '06月',
        amount: 80,
        basis: 'actual',
        isCurrent: false,
      },
      {
        month: '2026-07',
        label: '07月',
        amount: 160,
        basis: 'planned',
        isCurrent: true,
      },
      {
        month: '2026-08',
        label: '08月',
        amount: 320,
        basis: 'planned',
        isCurrent: false,
      },
    ]);

    expect(chartItems).toEqual([
      expect.objectContaining({
        month: '2026-06',
        historyAmount: 80,
        futureAmount: null,
      }),
      expect.objectContaining({
        month: '2026-07',
        historyAmount: 160,
        futureAmount: 160,
      }),
      expect.objectContaining({
        month: '2026-08',
        historyAmount: null,
        futureAmount: 320,
      }),
    ]);
  });

  it('按计划年度和逾期状态汇总未结清付款计划', () => {
    const analytics = buildPendingPaymentAnalytics([
      payment({
        recordId: '2025-overdue',
        dueDate: '2025-12-31',
        plannedAmount: 100,
        actualAmount: 0,
        daysUntilDue: -201,
        risk: 'overdue',
      }),
      payment({
        recordId: '2026-overdue',
        dueDate: '2026-06-30',
        plannedAmount: 300,
        actualAmount: 100,
        daysUntilDue: -20,
        risk: 'overdue',
      }),
      payment({
        recordId: '2026-pending',
        dueDate: '2026-08-31',
        plannedAmount: 200,
        actualAmount: 0,
        daysUntilDue: 42,
        risk: 'normal',
      }),
      payment({
        recordId: 'missing-date',
        dueDate: null,
        plannedAmount: 100,
        actualAmount: 0,
        daysUntilDue: null,
        risk: 'normal',
      }),
    ]);

    expect(analytics.totalPendingAmount).toBe(600);
    expect(analytics.yearSummary).toEqual([
      { year: '2025', pendingAmount: 100, count: 1 },
      { year: '2026', pendingAmount: 400, count: 2 },
      { year: '日期待补充', pendingAmount: 100, count: 1 },
    ]);
    expect(analytics.statusSummary).toEqual([
      {
        status: 'overdue',
        label: '已逾期',
        pendingAmount: 300,
        count: 2,
      },
      {
        status: 'pending',
        label: '待付款',
        pendingAmount: 300,
        count: 2,
      },
    ]);
    expect(analytics.groups[0].sections[0]).toMatchObject({
      status: 'overdue',
      count: 1,
      pendingAmount: 100,
    });
    expect(analytics.groups.at(-1)?.year).toBe('日期待补充');
  });

  it('按计划付款日期将未付节点分为到期与未来 30 天', () => {
    const groups = partitionPaymentAttentionItems([
      payment({ recordId: 'overdue', daysUntilDue: -2, risk: 'overdue' }),
      payment({ recordId: 'today', daysUntilDue: 0 }),
      payment({ recordId: 'tomorrow', daysUntilDue: 1 }),
      payment({ recordId: 'day-30', daysUntilDue: 30 }),
      payment({ recordId: 'day-31', daysUntilDue: 31, risk: 'normal' }),
      payment({
        recordId: 'completed',
        daysUntilDue: -1,
        risk: 'completed',
        actualAmount: 1000,
        status: '已付款',
      }),
      payment({
        recordId: 'partial',
        daysUntilDue: -1,
        actualAmount: 400,
        status: '流程中',
        risk: 'overdue',
      }),
    ]);

    expect(groups.overdue.map((item) => item.recordId)).toEqual([
      'overdue',
      'partial',
      'today',
    ]);
    expect(groups.upcoming.map((item) => item.recordId)).toEqual([
      'tomorrow',
      'day-30',
    ]);
  });

  it('为待付款金额卡片列出全部未结清付款计划', () => {
    const items = findPendingPaymentItems([
      payment({
        recordId: 'future',
        dueDate: '2026-12-31',
        daysUntilDue: 168,
        risk: 'normal',
      }),
      payment({
        recordId: 'overdue',
        dueDate: '2026-06-30',
        daysUntilDue: -16,
        risk: 'overdue',
      }),
      payment({
        recordId: 'partial',
        dueDate: null,
        plannedAmount: 600,
        actualAmount: 200,
        risk: 'normal',
      }),
      payment({
        recordId: 'completed',
        dueDate: '2026-06-01',
        actualAmount: 1000,
        status: '已付款',
        risk: 'completed',
      }),
      payment({
        recordId: 'zero-plan',
        plannedAmount: 0,
        actualAmount: 0,
        risk: 'normal',
      }),
    ]);

    expect(items.map((item) => item.recordId)).toEqual([
      'overdue',
      'future',
      'partial',
    ]);
  });

  it('只把完全没有付款计划记录的合同列为无计划', () => {
    const candidates = [
      contract({ recordId: 'with-plan' }),
      contract({ recordId: 'without-plan' }),
      contract({ recordId: 'with-zero-plan' }),
    ];
    const payments = [
      payment({ contractRecordId: 'with-plan' }),
      payment({
        recordId: 'zero-plan',
        contractRecordId: 'with-zero-plan',
        plannedAmount: 0,
      }),
    ];

    expect(findContractsWithoutPaymentPlans(candidates, payments)).toEqual([
      expect.objectContaining({ recordId: 'without-plan' }),
    ]);
  });

  it('不再把已标记无需付款的合同列为无计划', () => {
    const candidates = [
      contract({ recordId: 'without-plan' }),
      contract({
        recordId: 'no-payment-required',
        paymentFollowUpDisposition: '无需付款',
      }),
    ];

    expect(findContractsWithoutPaymentPlans(candidates, [])).toEqual([
      expect.objectContaining({ recordId: 'without-plan' }),
    ]);
  });

  it('为付款节点和无计划合同生成可跟进的合同汇总', () => {
    const item = contract({
      recordId: 'contract-1',
      amount: 5000,
      endDate: '2026-08-31',
    });
    const related = [
      payment({ plannedAmount: 3000, actualAmount: 1000, risk: 'overdue' }),
      payment({
        recordId: 'payment-2',
        plannedAmount: 2000,
        actualAmount: 2000,
        status: '已付款',
        risk: 'completed',
      }),
      payment({ recordId: 'other', contractRecordId: 'other-contract' }),
    ];

    expect(buildPaymentFollowUpTarget(item, related)).toMatchObject({
      contractRecordId: 'contract-1',
      reason: 'unpaid_plan',
      planCount: 2,
      unpaidPlanCount: 1,
      plannedAmount: 5000,
      paidAmount: 3000,
      pendingAmount: 2000,
    });
    expect(buildPaymentFollowUpTarget(item, [])).toMatchObject({
      reason: 'missing_plan',
      planCount: 0,
      unpaidPlanCount: 0,
    });
  });
});
