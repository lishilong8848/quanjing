import type {
  ContractManagementDashboard,
  ContractManagementItem,
  ContractPaymentFollowUpItem,
  ContractPaymentItem,
} from '../../shared/contract-management.interface';
import {
  applyNoPaymentRequired,
  rollbackNoPaymentRequired,
} from '../../client/src/pages/ContractManagement/payment-follow-up-optimistic';

describe('no-payment-required optimistic dashboard update', () => {
  it('removes the contract from payment follow-up views immediately', () => {
    const dashboard = createDashboard();

    const result = applyNoPaymentRequired(dashboard, 'contract-1');

    expect(result.dashboard.contracts[0].paymentFollowUpDisposition).toBe(
      '无需付款',
    );
    expect(result.dashboard.paymentFollowUps).toEqual([]);
    expect(result.dashboard.paymentRisks).toEqual([]);
    expect(result.snapshot.contractRecordId).toBe('contract-1');
  });

  it('restores only the affected contract and cards after sync failure', () => {
    const original = createDashboard();
    const optimistic = applyNoPaymentRequired(original, 'contract-1');
    const concurrentlyUpdated = {
      ...optimistic.dashboard,
      generatedAt: 'newer-dashboard',
    };

    const rolledBack = rollbackNoPaymentRequired(
      concurrentlyUpdated,
      optimistic.snapshot,
    );

    expect(rolledBack.generatedAt).toBe('newer-dashboard');
    expect(rolledBack.contracts[0].paymentFollowUpDisposition).toBe('');
    expect(rolledBack.paymentFollowUps).toHaveLength(1);
    expect(rolledBack.paymentRisks).toHaveLength(1);
  });
});

function createDashboard(): ContractManagementDashboard {
  const contract: ContractManagementItem = {
    recordId: 'contract-1',
    name: '测试合同',
    code: 'HT-001',
    amount: 1000,
    contractType: '服务合同',
    specialty: '其他',
    supplier: '测试供应商',
    owner: '测试人员',
    startDate: '2026-01-01',
    endDate: '2026-07-01',
    status: 'expired',
    daysRemaining: -28,
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
  };
  const followUp: ContractPaymentFollowUpItem = {
    contractRecordId: 'contract-1',
    contractName: '测试合同',
    contractCode: 'HT-001',
    owner: '测试人员',
    contractAmount: 1000,
    contractEndDate: '2026-07-01',
    reason: 'missing_plan',
    planCount: 0,
    unpaidPlanCount: 0,
    plannedAmount: 0,
    paidAmount: 0,
    pendingAmount: 0,
    attachments: [],
  };
  const paymentRisk: ContractPaymentItem = {
    recordId: 'payment-1',
    contractRecordId: 'contract-1',
    contractName: '测试合同',
    contractCode: 'HT-001',
    label: '一期付款',
    cycle: '一期',
    dueDate: '2026-07-01',
    plannedAmount: 1000,
    actualAmount: 0,
    status: '未付款',
    risk: 'overdue',
    daysUntilDue: -28,
    owner: '测试人员',
  };
  return {
    generatedAt: 'initial-dashboard',
    sourceUrl: '',
    summary: {
      totalContracts: 1,
      activeContracts: 0,
      expiringContracts: 0,
      expiredContracts: 1,
      pendingContracts: 0,
      totalValue: 1000,
      frameworkContracts: 0,
      activeFrameworkContracts: 0,
      plannedPaymentAmount: 0,
      paidAmount: 0,
      pendingPaymentAmount: 0,
      overduePayments: 0,
      supplierCount: 1,
    },
    paymentProgress: {
      plannedAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
      completionRate: 0,
      paidCount: 0,
      pendingCount: 0,
    },
    contracts: [contract],
    unsignedContracts: [],
    payments: [],
    contractRisks: [],
    paymentRisks: [paymentRisk],
    frameworkRelations: {
      summary: {
        totalFrameworks: 0,
        activeFrameworks: 0,
        linkedFrameworks: 0,
        unlinkedFrameworks: 0,
        linkedExecutionContracts: 0,
        linkedExecutionAmount: 0,
      },
      items: [],
    },
    supplierDirectory: {
      summary: {
        totalSuppliers: 0,
        directoryEntries: 0,
        linkedContracts: 0,
        contactsWithPhone: 0,
        phoneCoverageRate: 0,
      },
      items: [],
    },
    contractPaymentSummaries: [],
    paymentFollowUps: [followUp],
    paymentDataQuality: {
      missingContract: 0,
      pendingMissingDate: 0,
      zeroAmount: 0,
    },
    typeBreakdown: [],
    specialtyBreakdown: [],
    sectionStatus: {
      framework: { configured: true, count: 0 },
      contracts: { configured: true, count: 1 },
      suppliers: { configured: true, count: 0 },
      payments: { configured: true, count: 0 },
    },
  };
}
