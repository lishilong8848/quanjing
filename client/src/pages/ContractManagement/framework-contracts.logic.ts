import type { ContractFrameworkRelationItem } from '@shared/contract-management.interface';

export type FrameworkContractFilter =
  | 'all'
  | 'linked'
  | 'unlinked'
  | 'expiring';

export function countEffectiveExecutionContracts(
  item: ContractFrameworkRelationItem,
): number {
  return item.executionContracts.filter(
    (contract) =>
      contract.status === 'active' || contract.status === 'expiring',
  ).length;
}

export function filterFrameworkContracts(
  items: readonly ContractFrameworkRelationItem[],
  query: string,
  filter: FrameworkContractFilter,
): ContractFrameworkRelationItem[] {
  const keyword = query.trim().toLocaleLowerCase('zh-CN');

  return items.filter((item) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'linked' && item.executionContracts.length > 0) ||
      (filter === 'unlinked' && item.executionContracts.length === 0) ||
      (filter === 'expiring' && item.status === 'expiring');

    if (!matchesFilter) return false;
    if (!keyword) return true;

    return [item.frameworkName, item.frameworkCode].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(keyword),
    );
  });
}

export function selectInitialFrameworkId(
  items: readonly ContractFrameworkRelationItem[],
): string | null {
  return (
    items.find((item) => item.executionContracts.length > 0)
      ?.frameworkRecordId ??
    items[0]?.frameworkRecordId ??
    null
  );
}
