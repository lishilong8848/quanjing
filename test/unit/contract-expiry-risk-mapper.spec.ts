import { buildContractManagementDashboard } from '../../server/modules/contract-management/contract-management.mapper';

describe('contract expiry risk mapping', () => {
  it('keeps only upcoming 60-day contracts and excludes expired or voided items', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-13T04:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [
        contract('expired-30', '2026-06-13'),
        contract('expired-31', '2026-06-12'),
        contract('upcoming-60', '2026-09-11'),
        contract('upcoming-61', '2026-09-12'),
        contract('voided', '2026-07-31', '到期作废'),
      ],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 5 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-13T04:00:00.000Z'),
    });

    expect(dashboard.contractRisks.map((item) => item.recordId)).toEqual([
      'upcoming-60',
    ]);
    expect(
      dashboard.contracts.find((item) => item.recordId === 'voided'),
    ).toMatchObject({ expiryDisposition: '到期作废' });
  });
});

function contract(recordId: string, endDate: string, disposition = '') {
  return {
    record_id: recordId,
    fields: {
      合同名称: `合同-${recordId}`,
      合同编号: recordId,
      合同开始日期: '2025-01-01',
      合同结束日期: endDate,
      合同到期处置: disposition,
    },
  };
}
