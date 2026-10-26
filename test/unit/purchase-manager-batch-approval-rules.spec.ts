import {
  aggregateManagerApprovalBatchState,
  selectPendingManagerApprovalRecordIds,
} from '../../server/modules/purchase-inventory/purchase-manager-batch-approval.rules';
import type { PurchaseManagerBatchApprovalItemInput } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

const pending: PurchaseManagerBatchApprovalItemInput = {
  executionRecordId: 'rec-1',
  title: '门牌',
  specification: '/',
  quantity: '1',
  unit: '套',
  amount: '10',
  status: 'pending',
  choice: '',
  rejectionReason: '',
};

describe('purchase manager batch approval rules', () => {
  it('selects only pending record ids without changing their order', () => {
    const items: PurchaseManagerBatchApprovalItemInput[] = [
      pending,
      {
        ...pending,
        executionRecordId: 'rec-2',
        status: 'rejected',
        choice: 'reject',
        rejectionReason: '规格不符',
      },
      { ...pending, executionRecordId: 'rec-3' },
    ];

    expect(selectPendingManagerApprovalRecordIds(items)).toEqual([
      'rec-1',
      'rec-3',
    ]);
  });

  it.each([
    [[pending], 'active'],
    [[{ ...pending, status: 'processing', choice: 'comprehensive' }], 'processing'],
    [
      [
        { ...pending, status: 'approved', choice: 'comprehensive' },
        {
          ...pending,
          executionRecordId: 'rec-2',
          status: 'rejected',
          choice: 'reject',
          rejectionReason: '规格不符',
        },
      ],
      'resolved',
    ],
    [
      [
        {
          ...pending,
          status: 'manual_reconciliation',
          choice: 'building_self',
        },
      ],
      'manual_reconciliation',
    ],
  ] as const)('aggregates item states to %s', (items, expected) => {
    expect(
      aggregateManagerApprovalBatchState(
        items as unknown as PurchaseManagerBatchApprovalItemInput[],
      ),
    ).toBe(expected);
  });

  it('rejects an empty batch rather than declaring it resolved', () => {
    expect(() => aggregateManagerApprovalBatchState([])).toThrow(
      '采购审批批次不能为空',
    );
  });
});
