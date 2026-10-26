import { BadRequestException } from '@nestjs/common';

import type { PurchaseManagerBatchApprovalItemInput } from './purchase-manager-batch-approval-card';

export type PurchaseManagerApprovalBatchAggregateState =
  | 'active'
  | 'processing'
  | 'resolved'
  | 'manual_reconciliation';

export function selectPendingManagerApprovalRecordIds(
  items: readonly PurchaseManagerBatchApprovalItemInput[],
): string[] {
  return items
    .filter((item) => item.status === 'pending')
    .map((item) => item.executionRecordId);
}

export function aggregateManagerApprovalBatchState(
  items: readonly PurchaseManagerBatchApprovalItemInput[],
): PurchaseManagerApprovalBatchAggregateState {
  if (items.length === 0) {
    throw new BadRequestException('采购审批批次不能为空');
  }

  if (items.some((item) => item.status === 'manual_reconciliation')) {
    return 'manual_reconciliation';
  }
  if (items.some((item) => item.status === 'processing')) {
    return 'processing';
  }
  if (items.some((item) => item.status === 'pending')) {
    return 'active';
  }
  if (
    items.every(
      (item) => item.status === 'approved' || item.status === 'rejected',
    )
  ) {
    return 'resolved';
  }

  throw new BadRequestException('采购审批批次包含未知状态');
}
