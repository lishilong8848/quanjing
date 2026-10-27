import type { ContractFrameworkRelationItem } from '../../shared/contract-management.interface';
import {
  countEffectiveExecutionContracts,
  filterFrameworkContracts,
  selectInitialFrameworkId,
} from '../../client/src/pages/ContractManagement/framework-contracts.logic';

function frameworkContract(
  overrides: Partial<ContractFrameworkRelationItem>,
): ContractFrameworkRelationItem {
  return {
    frameworkRecordId: 'framework-1',
    frameworkName: '配电设备框架协议',
    frameworkCode: 'FW-001',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'active',
    daysRemaining: 171,
    executionAmount: 0,
    executionContracts: [],
    ...overrides,
  };
}

const executionContract = {
  recordId: 'execution-1',
  name: '配电设备执行合同',
  code: 'ZX-001',
  amount: 20_000,
  status: 'active' as const,
  supplier: '南通设备服务有限公司',
  owner: '张三',
  endDate: '2026-11-30',
};

describe('framework contract page logic', () => {
  const contracts = [
    frameworkContract({
      frameworkRecordId: 'unlinked-active',
      frameworkName: '暖通维护框架协议',
      frameworkCode: 'HVAC-001',
    }),
    frameworkContract({
      frameworkRecordId: 'linked-active',
      frameworkName: '配电设备框架协议',
      frameworkCode: 'POWER-AbC',
      executionAmount: executionContract.amount,
      executionContracts: [executionContract],
    }),
    frameworkContract({
      frameworkRecordId: 'linked-expiring',
      frameworkName: '消防系统框架协议',
      frameworkCode: 'FIRE-003',
      status: 'expiring',
      executionAmount: executionContract.amount,
      executionContracts: [
        {
          ...executionContract,
          recordId: 'execution-2',
          name: '消防系统执行合同',
          code: 'ZX-002',
        },
      ],
    }),
    frameworkContract({
      frameworkRecordId: 'unlinked-expiring',
      frameworkName: '执行合同同名但未真实关联',
      frameworkCode: 'UNLINKED-004',
      status: 'expiring',
    }),
  ];

  it('searches framework contracts by name', () => {
    expect(filterFrameworkContracts(contracts, '消防系统', 'all')).toEqual([
      expect.objectContaining({ frameworkRecordId: 'linked-expiring' }),
    ]);
  });

  it('searches framework codes case-insensitively after trimming whitespace', () => {
    expect(filterFrameworkContracts(contracts, '  power-abc  ', 'all')).toEqual(
      [expect.objectContaining({ frameworkRecordId: 'linked-active' })],
    );
  });

  it('returns every framework contract for the all filter', () => {
    expect(
      filterFrameworkContracts(contracts, '', 'all').map(
        (item) => item.frameworkRecordId,
      ),
    ).toEqual([
      'unlinked-active',
      'linked-active',
      'linked-expiring',
      'unlinked-expiring',
    ]);
  });

  it('uses actual execution contract links for the linked filter', () => {
    expect(
      filterFrameworkContracts(contracts, '', 'linked').map(
        (item) => item.frameworkRecordId,
      ),
    ).toEqual(['linked-active', 'linked-expiring']);
  });

  it('uses an empty execution contract list for the unlinked filter', () => {
    expect(
      filterFrameworkContracts(contracts, '', 'unlinked').map(
        (item) => item.frameworkRecordId,
      ),
    ).toEqual(['unlinked-active', 'unlinked-expiring']);
  });

  it('filters expiring framework contracts by status', () => {
    expect(
      filterFrameworkContracts(contracts, '', 'expiring').map(
        (item) => item.frameworkRecordId,
      ),
    ).toEqual(['linked-expiring', 'unlinked-expiring']);
  });

  it('combines search and relationship filters with AND semantics', () => {
    expect(filterFrameworkContracts(contracts, '消防', 'linked')).toEqual([
      expect.objectContaining({ frameworkRecordId: 'linked-expiring' }),
    ]);
    expect(filterFrameworkContracts(contracts, '暖通', 'linked')).toEqual([]);
  });

  it('does not search execution contract fields', () => {
    expect(filterFrameworkContracts(contracts, 'ZX-002', 'all')).toEqual([]);
  });

  it('returns an empty array when no framework contract matches', () => {
    expect(
      filterFrameworkContracts(contracts, '不存在的框架合同', 'all'),
    ).toEqual([]);
  });

  it('handles an empty input list', () => {
    expect(filterFrameworkContracts([], '', 'all')).toEqual([]);
    expect(selectInitialFrameworkId([])).toBeNull();
  });

  it('selects the first framework contract with a real execution contract link', () => {
    expect(selectInitialFrameworkId(contracts)).toBe('linked-active');
  });

  it('falls back to the first framework contract when none are linked', () => {
    const unlinkedContracts = [
      frameworkContract({ frameworkRecordId: 'first' }),
      frameworkContract({ frameworkRecordId: 'second' }),
    ];

    expect(selectInitialFrameworkId(unlinkedContracts)).toBe('first');
  });

  it('preserves the input array and item order', () => {
    const originalItems = [...contracts];
    const result = filterFrameworkContracts(contracts, '', 'all');

    expect(contracts).toEqual(originalItems);
    expect(
      contracts.every((item, index) => item === originalItems[index]),
    ).toBe(true);
    expect(result).not.toBe(contracts);
  });

  it('counts only active and expiring execution contracts as effective', () => {
    const item = frameworkContract({
      executionContracts: [
        executionContract,
        {
          ...executionContract,
          recordId: 'execution-expiring',
          status: 'expiring',
        },
        {
          ...executionContract,
          recordId: 'execution-expired',
          status: 'expired',
        },
        {
          ...executionContract,
          recordId: 'execution-pending',
          status: 'pending',
        },
        {
          ...executionContract,
          recordId: 'execution-unknown',
          status: 'unknown',
        },
      ],
    });

    expect(countEffectiveExecutionContracts(item)).toBe(2);
  });

  it('returns zero when every linked execution contract is ineffective', () => {
    const item = frameworkContract({
      executionContracts: [
        {
          ...executionContract,
          status: 'expired',
        },
      ],
    });

    expect(countEffectiveExecutionContracts(item)).toBe(0);
  });
});
