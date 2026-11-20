import type { InventoryManagementItem, WarehouseBuilding } from './inventory-management.interface';

export interface InventoryLedgerDeletionRequest {
  clientMutationId: string;
  recordId: string;
  building: WarehouseBuilding;
  expected: Pick<InventoryManagementItem, 'sku' | 'quantity' | 'location'>;
}
export interface InventoryLedgerDeletionTask {
  clientMutationId: string;
  recordId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';
  message: string;
  updatedAt: string;
  stage?: 'validating-source' | 'reading-record' | 'reading-catalog' | 'checking-latest' | 'deleting' | 'reconciling' | 'completed';
  /** Automatic retries already consumed. A failed task is never resumed by a scan. */
  retryCount?: number;
  nextAttemptAt?: string;
  /** Explicit retry may reuse the original request because DELETE was not issued. */
  retryable?: boolean;
  definitelyNotDeleted?: boolean;
}
