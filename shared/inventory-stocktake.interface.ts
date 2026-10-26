import type {
  InventoryManagementItem,
  WarehouseBuilding,
} from './inventory-management.interface';
import type { PurchaseApplicationApplicant } from './purchase-application.interface';

export type StocktakeReason = 'random' | 'movement';
export type StocktakeScope = 'sample' | 'review';
export interface StocktakeSyncState {
  clientMutationId?: string;
  version: number;
  status: 'pending' | 'syncing' | 'success' | 'error';
  attempts: number;
  retryAt: string | null;
  error: string;
  syncedAt: string | null;
}
export interface StocktakeBulkSummary {
  id: string;
  count: number;
  confirmer: PurchaseApplicationApplicant;
  confirmedAt: string;
  status: 'confirmed' | 'undone';
  undoneAt: string | null;
}
export interface StocktakeSyncSummary {
  pending: number;
  syncing: number;
  success: number;
  error: number;
  message: string;
}
export interface StocktakeDraft {
  actualQuantity: number | null;
  confirmer: PurchaseApplicationApplicant | null;
  note: string;
}
export interface StocktakeLine extends StocktakeDraft {
  sync?: StocktakeSyncState;
  lastUndoneAt?: string | null;
  inventory: InventoryManagementItem;
  reasons: StocktakeReason[];
  movementIds: string[];
  stockFingerprint: string;
  version: number;
  status: 'draft' | 'confirmed';
  updatedAt: string;
  confirmedAt: string | null;
  operatorFingerprint: string | null;
}
export interface StocktakeSheet {
  bulkTask?: StocktakeBulkTask;
  latestBulk?: StocktakeBulkSummary;
  scope?: StocktakeScope;
  review?: StocktakeReview;
  month: string;
  building: WarehouseBuilding;
  status: 'open' | 'completed';
  version: number;
  createdAt: string;
  completedAt: string | null;
  historyStartedAt: string;
  seed: string;
  algorithm: 'sha256-rank-v1';
  inventoryCount: number;
  randomTarget: number;
  shortfall: number;
  excludedRecordIds: string[];
  lines: StocktakeLine[];
}
export interface StocktakeReview {
  latestBulk?: StocktakeBulkSummary;
  status: 'open' | 'completed';
  version: number;
  createdAt: string;
  completedAt: string | null;
  lines: StocktakeLine[];
}
export interface StocktakeProgress {
  total: number;
  confirmed: number;
  differences: number;
  surplus: number;
  shortage: number;
  matched: number;
  status: 'not_started' | 'open' | 'completed';
  shortfall: number;
}
export interface StocktakeOverview {
  month: string;
  historyStartedAt: string | null;
  generation?: StocktakeGeneration | null;
  buildings: Array<{
    building: WarehouseBuilding;
    total: number;
    confirmed: number;
    differences: number;
    status: 'not_started' | 'open' | 'completed';
    shortfall: number;
    surplus?: number;
    shortage?: number;
    matched?: number;
    review?: StocktakeProgress;
  }>;
}
export interface StocktakeGenerationRequest {
  month: string;
  clientMutationId: string;
}
export interface StocktakeGeneration {
  id: string;
  month: string;
  status: 'queued' | 'running' | 'success' | 'error';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  retryAt: string | null;
  buildings: Array<{
    building: WarehouseBuilding;
    status: 'pending' | 'done' | 'error';
    error: string;
  }>;
}
export interface StocktakeWriteRequest {
  scope?: StocktakeScope;
  month: string;
  building: WarehouseBuilding;
  clientMutationId: string;
}
export interface StocktakeBulkRequest extends StocktakeCompleteRequest {
  scope: 'review';
  confirmer: PurchaseApplicationApplicant | null;
  lines: Array<StocktakeDraft & { recordId: string; expectedVersion: number }>;
}
export interface StocktakeBulkTask {
  confirmer?: PurchaseApplicationApplicant | null;
  id: string;
  month: string;
  building: WarehouseBuilding;
  status: 'queued' | 'running' | 'success' | 'error';
  count: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error: string;
}
export interface StocktakeLineRequest
  extends StocktakeWriteRequest, StocktakeDraft {
  recordId: string;
  expectedVersion: number;
}
export interface StocktakeCompleteRequest extends StocktakeWriteRequest {
  expectedVersion: number;
}
export interface StocktakeUndoRequest extends StocktakeCompleteRequest {
  scope: 'review';
  batchId: string;
}
export interface StocktakeHistory {
  month: string;
  building: WarehouseBuilding;
  recordIds: string[];
}
