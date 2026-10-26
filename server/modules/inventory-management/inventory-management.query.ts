import type {
  InventoryItemsQuery,
  InventoryMovementsQuery,
  InventoryMovementType,
  InventoryRiskFilter,
  InventorySortOption,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';

const RISK_FILTERS = new Set<InventoryRiskFilter>([
  'all',
  'low',
  'negative',
  'idle',
]);
const SORT_OPTIONS = new Set<InventorySortOption>([
  'risk',
  'quantityAsc',
  'quantityDesc',
  'usageAsc',
  'valueDesc',
]);
const MOVEMENT_TYPES = new Set<InventoryMovementType>([
  'inbound',
  'outbound',
  'borrow',
]);

export interface InventoryItemsQueryParams {
  page?: string;
  pageSize?: string;
  search?: string;
  building?: string;
  category?: string;
  risk?: string;
  sort?: string;
  refresh?: string;
}

export interface InventoryMovementsQueryParams {
  type?: string;
  page?: string;
  pageSize?: string;
  search?: string;
  building?: string;
  status?: string;
  refresh?: string;
}

export function parseInventoryItemsQuery(
  params: InventoryItemsQueryParams,
): { query: InventoryItemsQuery; forceRefresh: boolean } {
  const risk = params.risk || 'all';
  const sort = params.sort || 'risk';
  return {
    query: {
      page: positiveInteger(params.page, 1),
      pageSize: positiveInteger(params.pageSize, 20, 100),
      search: String(params.search || '').trim(),
      building: normalizeBuilding(params.building || 'all'),
      category: String(params.category || '').trim() || 'all',
      risk: RISK_FILTERS.has(risk as InventoryRiskFilter)
        ? (risk as InventoryRiskFilter)
        : 'all',
      sort: SORT_OPTIONS.has(sort as InventorySortOption)
        ? (sort as InventorySortOption)
        : 'risk',
    },
    forceRefresh: isRefreshRequested(params.refresh),
  };
}

export function parseInventoryMovementsQuery(
  params: InventoryMovementsQueryParams,
): { query: InventoryMovementsQuery; forceRefresh: boolean } {
  const requestedType = params.type || 'inbound';
  return {
    query: {
      type: MOVEMENT_TYPES.has(requestedType as InventoryMovementType)
        ? (requestedType as InventoryMovementType)
        : 'inbound',
      page: positiveInteger(params.page, 1),
      pageSize: positiveInteger(params.pageSize, 20, 100),
      search: String(params.search || '').trim(),
      building: normalizeBuilding(params.building || 'all'),
      status: String(params.status || '').trim() || 'all',
    },
    forceRefresh: isRefreshRequested(params.refresh),
  };
}

export function isRefreshRequested(value?: string): boolean {
  return value === '1' || value === 'true';
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum?: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum ?? Number.MAX_SAFE_INTEGER, Math.trunc(parsed));
}

function normalizeBuilding(value: string): WarehouseBuilding | 'all' {
  return WAREHOUSE_BUILDINGS.includes(value as WarehouseBuilding)
    ? (value as WarehouseBuilding)
    : 'all';
}
