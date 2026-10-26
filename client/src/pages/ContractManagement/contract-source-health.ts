import type {
  ContractManagementDashboard,
  ContractSourceKey,
} from '@shared/contract-management.interface';

const sourceLabels: Record<ContractSourceKey, string> = {
  framework: '框架合同',
  contracts: '执行合同',
  suppliers: '供应商',
  payments: '付款计划',
};

export function getContractSourceIssue(
  sectionStatus: ContractManagementDashboard['sectionStatus'],
  dependencies: readonly ContractSourceKey[],
): string | null {
  const issues = dependencies.flatMap((key) => {
    const status = sectionStatus[key];
    if (!status.configured) {
      return [`${sourceLabels[key]}数据源未配置`];
    }
    const message = status.message?.trim();
    return message ? [message] : [];
  });

  const uniqueIssues = [...new Set(issues)];
  return uniqueIssues.length > 0 ? uniqueIssues.join('；') : null;
}
