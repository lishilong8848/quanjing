import { buildContractManagementDashboard } from '../../server/modules/contract-management/contract-management.mapper';
import { scopeProfessionalContracts } from '../../server/modules/contract-management/contract-professional-access';

describe('professional contract aggregation', () => {
  const principal = { role: 'professional_admin' as const, purchaseBuilding: null, specialties: ['暖通'] as const };
  const contract = (id: string, specialty: string, end: string) => ({ record_id: id, fields: {
    合同编号: id, 合同名称: id, 专业类别: specialty, 合同金额: 1000,
    合同开始日期: '2026-01-01', 合同结束日期: end,
  } });
  const payment = (id: string, parent: string, amount: number, status: string) => ({ record_id: id, fields: {
    合同编号: [{ record_ids: [parent] }], 付款计划: id, 计划付款金额: amount, 实际付款金额: 0, 付款状态: status,
  } });
  const contracts = [contract('own', '暖通', '2026-10-31'), contract('expired', '暖通', '2026-01-02'), contract('foreign', '电气', '2026-12-31')];
  const payments = [payment('paid', 'own', 100, '已付款'), payment('zero', 'own', 0, ''), payment('undated', 'own', 50, ''), payment('foreign-payment', 'foreign', 500, '')];
  const suppliers = [
    { record_id: 'own-supplier', fields: { 公司单位: '暖通供应商', 关联合同编号: [{ record_ids: ['own'] }] } },
    { record_id: 'foreign-supplier', fields: { 公司单位: '电气供应商', 关联合同编号: [{ record_ids: ['foreign'] }] } },
  ];
  const input = { generatedAt: '2026-10-10T00:00:00Z', sourceUrl: 'https://example.test', frameworkContracts: [], executionContracts: contracts,
    suppliers, paymentPlans: payments, now: new Date('2026-10-10T00:00:00Z'), sectionStatus: {
      framework: { configured: true, count: 0 }, contracts: { configured: true, count: 3 }, payments: { configured: true, count: 4 }, suppliers: { configured: true, count: 2 },
    } };
  it('matches the existing aggregation rules after filtering all parent and child data', () => {
    const all = buildContractManagementDashboard(input);
    const actual = scopeProfessionalContracts(principal, all);
    const expected = buildContractManagementDashboard({ ...input, executionContracts: contracts.slice(0, 2), paymentPlans: payments.slice(0, 3), suppliers: suppliers.slice(0, 1) });
    for (const key of ['summary', 'paymentProgress', 'paymentDataQuality', 'typeBreakdown', 'specialtyBreakdown', 'supplierDirectory'] as const) {
      expect(actual[key]).toEqual(expected[key]);
    }
    expect(actual.payments.map(item => item.recordId)).not.toContain('foreign-payment');
    expect(actual.contracts.map(item => item.recordId)).not.toContain('foreign');
    expect(scopeProfessionalContracts({ role: 'admin', purchaseBuilding: null }, all)).toBe(all);
  });
});
