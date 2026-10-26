import type {
  ContractManagementDashboard,
  ContractManagementItem,
  ContractPaymentFollowUpItem,
  ContractPaymentItem,
} from '@shared/contract-management.interface';

export interface NoPaymentRequiredSnapshot {
  contractRecordId: string;
  previousDisposition: string;
  followUps: Array<{
    index: number;
    item: ContractPaymentFollowUpItem;
  }>;
  paymentRisks: Array<{
    index: number;
    item: ContractPaymentItem;
  }>;
}

export function applyNoPaymentRequired(
  dashboard: ContractManagementDashboard,
  contractRecordId: string,
): {
  dashboard: ContractManagementDashboard;
  snapshot: NoPaymentRequiredSnapshot;
} {
  const contract = dashboard.contracts.find(
    (item) => item.recordId === contractRecordId,
  );
  const snapshot: NoPaymentRequiredSnapshot = {
    contractRecordId,
    previousDisposition: contract?.paymentFollowUpDisposition || '',
    followUps: indexedMatches(
      dashboard.paymentFollowUps,
      (item) => item.contractRecordId === contractRecordId,
    ),
    paymentRisks: indexedMatches(
      dashboard.paymentRisks,
      (item) => item.contractRecordId === contractRecordId,
    ),
  };

  return {
    dashboard: {
      ...dashboard,
      contracts: dashboard.contracts.map((item) =>
        item.recordId === contractRecordId
          ? { ...item, paymentFollowUpDisposition: '无需付款' }
          : item,
      ),
      paymentFollowUps: dashboard.paymentFollowUps.filter(
        (item) => item.contractRecordId !== contractRecordId,
      ),
      paymentRisks: dashboard.paymentRisks.filter(
        (item) => item.contractRecordId !== contractRecordId,
      ),
    },
    snapshot,
  };
}

export function rollbackNoPaymentRequired(
  dashboard: ContractManagementDashboard,
  snapshot: NoPaymentRequiredSnapshot,
): ContractManagementDashboard {
  return {
    ...dashboard,
    contracts: restoreContractDisposition(
      dashboard.contracts,
      snapshot.contractRecordId,
      snapshot.previousDisposition,
    ),
    paymentFollowUps: restoreIndexedItems(
      dashboard.paymentFollowUps.filter(
        (item) => item.contractRecordId !== snapshot.contractRecordId,
      ),
      snapshot.followUps,
    ),
    paymentRisks: restoreIndexedItems(
      dashboard.paymentRisks.filter(
        (item) => item.contractRecordId !== snapshot.contractRecordId,
      ),
      snapshot.paymentRisks,
    ),
  };
}

function restoreContractDisposition(
  contracts: ContractManagementItem[],
  contractRecordId: string,
  disposition: string,
): ContractManagementItem[] {
  return contracts.map((item) =>
    item.recordId === contractRecordId
      ? { ...item, paymentFollowUpDisposition: disposition }
      : item,
  );
}

function indexedMatches<T>(
  items: T[],
  matches: (item: T) => boolean,
): Array<{ index: number; item: T }> {
  return items.flatMap((item, index) =>
    matches(item) ? [{ index, item }] : [],
  );
}

function restoreIndexedItems<T>(
  current: T[],
  snapshots: Array<{ index: number; item: T }>,
): T[] {
  const restored = [...current];
  for (const snapshot of [...snapshots].sort(
    (left, right) => left.index - right.index,
  )) {
    restored.splice(
      Math.min(snapshot.index, restored.length),
      0,
      snapshot.item,
    );
  }
  return restored;
}
