import { getContractSourceIssue } from '../../client/src/pages/ContractManagement/contract-source-health';
import type { ContractManagementDashboard } from '../../shared/contract-management.interface';

function healthySectionStatus(): ContractManagementDashboard['sectionStatus'] {
  return {
    framework: { configured: true, count: 2 },
    contracts: { configured: true, count: 3 },
    suppliers: { configured: true, count: 4 },
    payments: { configured: true, count: 5 },
  };
}

describe('contract source health', () => {
  it('returns no issue when every dependency loaded successfully', () => {
    expect(
      getContractSourceIssue(healthySectionStatus(), [
        'contracts',
        'payments',
      ]),
    ).toBeNull();
  });

  it('preserves read-failure messages for the requested dependencies', () => {
    const sectionStatus = healthySectionStatus();
    sectionStatus.payments = {
      configured: true,
      count: 0,
      message: '付款计划表读取失败',
    };

    expect(
      getContractSourceIssue(sectionStatus, ['contracts', 'payments']),
    ).toBe('付款计划表读取失败');
  });

  it('describes unconfigured sources instead of treating them as empty', () => {
    const sectionStatus = healthySectionStatus();
    sectionStatus.framework = { configured: false, count: 0 };

    expect(
      getContractSourceIssue(sectionStatus, ['framework', 'contracts']),
    ).toBe('框架合同数据源未配置');
  });
});
