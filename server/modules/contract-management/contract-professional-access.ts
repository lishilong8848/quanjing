import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { ContractManagementDashboard } from '../../../shared/contract-management.interface';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';

export function scopeProfessionalContracts(principal: AccessPrincipal | undefined, dashboard: ContractManagementDashboard): ContractManagementDashboard {
  if (!isProfessionalBusinessPrincipal(principal)) return dashboard;
  const contracts = filterProfessionalRecords(principal, dashboard.contracts, item => item.specialty);
  const unsignedContracts = filterProfessionalRecords(principal, dashboard.unsignedContracts, item => item.specialty);
  const ids = new Set([...contracts, ...unsignedContracts].map(item => item.recordId));
  const payments = dashboard.payments.filter(item => ids.has(item.contractRecordId));
  const paymentRisks = dashboard.paymentRisks.filter(item => ids.has(item.contractRecordId));
  const contractPaymentSummaries = dashboard.contractPaymentSummaries.filter(item => ids.has(item.contractRecordId));
  const sum = <T>(items: T[], value: (item: T) => number) => Math.round(items.reduce((total, item) => total + value(item), 0) * 100) / 100;
  const percentage = (value: number, total: number) => total > 0 ? Math.round(value / total * 1000) / 10 : 0;
  const plannedAmount = sum(payments, item => item.plannedAmount), paidAmount = sum(payments, item => item.actualAmount);
  const pendingAmount = sum(payments, item => Math.max(0, item.plannedAmount - item.actualAmount));
  const suppliers = dashboard.supplierDirectory.items.flatMap(item => {
    const relatedContracts = item.relatedContracts.filter(contract => ids.has(contract.recordId));
    return relatedContracts.length ? [{ ...item, relatedContracts, activeContractCount: relatedContracts.filter(contract => contract.status === 'active' || contract.status === 'expiring').length,
      linkedContractAmount: sum(relatedContracts, contract => contract.amount), cooperationDepth: (sum(relatedContracts, contract => contract.amount) > 100000 ? 'over_100k' : sum(relatedContracts, contract => contract.amount) >= 50000 ? '50k_to_100k' : 'under_50k') as typeof item.cooperationDepth }] : [];
  });
  const overviewContracts = contracts.filter(item => item.status === 'active' || item.status === 'expiring');
  const breakdown = (key: 'contractType' | 'specialty') => [...new Set(overviewContracts.map(item => item[key]))].map(label => {
    const items = overviewContracts.filter(item => item[key] === label);
    return { label, count: items.length, amount: sum(items, item => item.amount), percentage: percentage(items.length, overviewContracts.length), [key]: label };
  }).sort((left, right) => right.amount - left.amount || right.count - left.count);
  return { ...dashboard, contracts, unsignedContracts, payments, paymentRisks,
    contractRisks: dashboard.contractRisks.filter(item => ids.has(item.recordId)), contractPaymentSummaries,
    paymentFollowUps: dashboard.paymentFollowUps.filter(item => ids.has(item.contractRecordId)),
    summary: { totalContracts: contracts.length, activeContracts: contracts.filter(item => item.status === 'active').length,
      expiringContracts: contracts.filter(item => item.status === 'expiring').length, expiredContracts: contracts.filter(item => item.status === 'expired').length,
      pendingContracts: contracts.filter(item => item.status === 'pending').length, totalValue: sum(contracts, item => item.amount), frameworkContracts: 0, activeFrameworkContracts: 0,
      plannedPaymentAmount: plannedAmount, paidAmount, pendingPaymentAmount: pendingAmount, overduePayments: paymentRisks.filter(item => item.risk === 'overdue').length, supplierCount: suppliers.length },
    paymentProgress: { plannedAmount, paidAmount, pendingAmount, completionRate: percentage(paidAmount, plannedAmount),
      paidCount: payments.filter(item => item.risk === 'completed').length, pendingCount: payments.filter(item => item.risk !== 'completed').length },
    frameworkRelations: { summary: { totalFrameworks: 0, activeFrameworks: 0, linkedFrameworks: 0, unlinkedFrameworks: 0, linkedExecutionContracts: 0, linkedExecutionAmount: 0 }, items: [] },
    supplierDirectory: { ...dashboard.supplierDirectory, items: suppliers, summary: { totalSuppliers: suppliers.length, directoryEntries: sum(suppliers, item => item.directoryEntryCount), linkedContracts: new Set(suppliers.flatMap(item => item.relatedContracts.map(contract => contract.recordId))).size, contactsWithPhone: suppliers.flatMap(item => item.contacts).filter(contact => contact.phone).length, phoneCoverageRate: percentage(suppliers.flatMap(item => item.contacts).filter(contact => contact.phone).length, sum(suppliers, item => item.directoryEntryCount)) } },
    paymentDataQuality: { missingContract: 0, pendingMissingDate: payments.filter(item => item.plannedAmount > 0 && item.risk === 'undated').length, zeroAmount: payments.filter(item => item.plannedAmount <= 0).length },
    typeBreakdown: breakdown('contractType').map(item => ({ ...item, contractType: item.label })), specialtyBreakdown: breakdown('specialty').map(item => ({ ...item, specialty: item.label })),
    sectionStatus: Object.fromEntries(Object.entries(dashboard.sectionStatus).map(([key, status]) => [key, { ...status, count: key === 'contracts' ? contracts.length : key === 'payments' ? payments.length : key === 'suppliers' ? suppliers.length : 0 }])) as ContractManagementDashboard['sectionStatus'] };
}
