import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings, canAccessBuilding } from '../../../shared/building-access';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  PURCHASE_ACCESS_BUILDINGS,
  BUILDING_ADMIN_BUILDINGS,
  type AccessPrincipal,
} from '../../../shared/access-control.interface';
import type {
  InventoryManagementDashboard,
  InventoryItemsQuery,
  InventoryManagementItem,
  InventoryMovementCreateRequest,
  InventoryMovementItem,
  InventoryMovementOptionsQuery,
  InventoryMovementsQuery,
  InventoryStocktakeBuildingProgress,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundConfirmRequest,
  PurchasePendingInboundItem,
  PurchasePendingInboundResponse,
  WarehouseBuilding,
  WarehouseStorageLocationCreateRequest,
  WarehouseStorageLocationQuery,
} from '../../../shared/inventory-management.interface';

const INVENTORY_ADMIN_BUILDINGS = new Set<string>([
  ...PURCHASE_ACCESS_BUILDINGS,
  ...BUILDING_ADMIN_BUILDINGS,
]);

export function scopeInventoryDashboard(
  principal: AccessPrincipal,
  dashboard: InventoryManagementDashboard,
): InventoryManagementDashboard {
  const scope = inventoryAdministratorBuildings(principal);
  if (!scope) return dashboard;
  if (scope.length > 1) {
    if (dashboard.buildings.some(item => !scope.includes(item.building))) denyAccess();
    return { ...dashboard, stocktake: buildScopedStocktake(dashboard.stocktake, dashboard.stocktake.buildings.filter(item => scope.includes(item.building))),
      stocktakeHistory: dashboard.stocktakeHistory?.map(item => buildScopedStocktake(item, item.buildings.filter(row => scope.includes(row.building)))) };
  }
  const building = scope[0];

  const buildingSummary = dashboard.buildings.find(
    (item) => item.building === building,
  );
  const alerts = dashboard.alerts.filter((item) => item.building === building);
  const movements = {
    inbound: scopeMovements(dashboard.movements.inbound, building),
    outbound: scopeMovements(dashboard.movements.outbound, building),
    borrow: scopeMovements(dashboard.movements.borrow, building),
  };
  const stocktakeBuildings = dashboard.stocktake.buildings.filter(
    (item) => item.building === building,
  );
  const stocktake = buildScopedStocktake(
    dashboard.stocktake,
    stocktakeBuildings,
  );

  return {
    ...dashboard,
    summary: {
      inventoryLines: buildingSummary?.inventoryLines ?? 0,
      distinctSkus: buildingSummary?.distinctSkus ?? 0,
      totalQuantity: buildingSummary?.totalQuantity ?? 0,
      inventoryValue: buildingSummary?.inventoryValue ?? 0,
      lowStockItems: buildingSummary?.lowStockItems ?? 0,
      negativeStockItems: buildingSummary?.negativeStockItems ?? 0,
      idleItems: buildingSummary?.idleItems ?? 0,
      pendingConfirmationItems: alerts.filter(
        (item) => item.pendingConfirmation,
      ).length,
      unassignedInventoryLines: 0,
    },
    buildings: buildingSummary ? [buildingSummary] : [],
    categories: [],
    alerts,
    movements,
    stocktake,
    stocktakeHistory: dashboard.stocktakeHistory?.map((summary) =>
      buildScopedStocktake(
        summary,
        summary.buildings.filter((item) => item.building === building),
      ),
    ),
    sectionStatus: Object.fromEntries(
      Object.entries(dashboard.sectionStatus).map(([key, status]) => [
        key,
        { ...status, count: 0 },
      ]),
    ) as InventoryManagementDashboard['sectionStatus'],
  };
}

export function scopeInventoryItemsQuery(principal: AccessPrincipal, query: InventoryItemsQuery): InventoryItemsQuery {
  const scope = inventoryAdministratorBuildings(principal);
  if (!scope) return query;
  if (scope.length === 1) return { ...query, building: scope[0] };
  if (query.building && query.building !== 'all' && !scope.includes(query.building)) denyAccess();
  return { ...query, allowedBuildings: scope };
}

export function scopeInventoryMovementsQuery(principal: AccessPrincipal, query: InventoryMovementsQuery): InventoryMovementsQuery {
  const scope = inventoryAdministratorBuildings(principal);
  if (!scope) return query;
  if (scope.length === 1) return { ...query, building: scope[0] };
  if (query.building && query.building !== 'all' && !scope.includes(query.building)) denyAccess();
  return { ...query, allowedBuildings: scope };
}

export function scopeInventoryMovementOptionsQuery(principal: AccessPrincipal, query: InventoryMovementOptionsQuery): InventoryMovementOptionsQuery {
  const scope = inventoryAdministratorBuildings(principal);
  if (!scope) return query;
  if (scope.length === 1) return { ...query, building: scope[0] };
  if (query.building && !scope.includes(query.building)) denyAccess();
  return { ...query, building: query.building || scope[0] };
}

export function scopeStorageLocationQuery(principal: AccessPrincipal, query: WarehouseStorageLocationQuery): WarehouseStorageLocationQuery {
  const scope = inventoryAdministratorBuildings(principal);
  if (!scope) return query;
  if (scope.length === 1) return { ...query, building: scope[0] };
  if (query.building && !scope.includes(query.building)) denyAccess();
  return { ...query, building: query.building || scope[0] };
}

export function assertStorageLocationCreateScope(
  principal: AccessPrincipal,
  request: WarehouseStorageLocationCreateRequest,
): WarehouseStorageLocationCreateRequest {
  const building = inventoryAdministratorBuildings(principal);
  if (building && !canAccessBuilding(principal, request?.building)) denyAccess();
  return request;
}

export function assertInventoryMovementScope(
  principal: AccessPrincipal,
  request: InventoryMovementCreateRequest,
): InventoryMovementCreateRequest {
  const building = inventoryAdministratorBuildings(principal);
  if (!building) return request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('库存变动请求格式不正确');
  }
  const destinationBuilding =
    'destinationBuilding' in request ? request.destinationBuilding : undefined;
  if (
    !canAccessBuilding(principal, request?.building) ||
    (destinationBuilding !== undefined && !canAccessBuilding(principal, destinationBuilding))
  ) {
    denyAccess();
  }
  return request;
}

export function scopePendingPurchaseInbounds(
  principal: AccessPrincipal,
  response: PurchasePendingInboundResponse,
): PurchasePendingInboundResponse {
  if (isProfessionalBusinessPrincipal(principal)) return { ...response, items: filterProfessionalRecords(principal, response.items, item => item.specialty) };
  const building = inventoryAdministratorBuildings(principal);
  if (!building) return response;
  return {
    ...response,
    items: response.items.filter((item) => canAccessBuilding(principal, item.building)),
  };
}

export function assertPurchaseInboundScope<
  TRequest extends
    | PurchaseInboundConfirmRequest
    | PurchaseInboundCategoryPrepareRequest,
>(
  principal: AccessPrincipal,
  request: TRequest,
  pendingItems?: PurchasePendingInboundItem[],
): TRequest {
  const building = inventoryAdministratorBuildings(principal);
  if (!building) return request;
  if (!pendingItems) return request;
  const requestValue = request as unknown as Record<string, unknown>;
  const strictRequest =
    Object.prototype.hasOwnProperty.call(requestValue, 'building') ||
    Object.prototype.hasOwnProperty.call(requestValue, 'clientMutationId');
  if (strictRequest && !canAccessBuilding(principal, request.building)) denyAccess();
  const matches = pendingItems.filter(
    (item) => item.executionRecordId === request?.executionRecordId,
  );
  if (
    matches.length > 1 ||
    (matches.length === 1 && !canAccessBuilding(principal, matches[0].building))
  ) {
    denyAccess();
  }
  return request;
}

export function assertPurchaseInboundExecutionScope(
  principal: AccessPrincipal,
  executionBuilding: unknown,
): void {
  const building = inventoryAdministratorBuildings(principal);
  if (!building) return;
  if (!canAccessBuilding(principal, executionBuilding)) denyAccess();
}

export function assertInventoryMovementDeletionRole(
  principal: AccessPrincipal,
): void {
  if (
    principal?.role !== 'admin' &&
    !isProfessionalBusinessPrincipal(principal) &&
    principal?.role !== 'inventory_admin' &&
    principal?.role !== 'building_admin'
  ) {
    denyAccess();
  }
  if (
    principal.role === 'inventory_admin' ||
    principal.role === 'building_admin'
  ) {
    inventoryAdministratorBuildings(principal);
  }
}

export function assertInventoryMovementDeletionScope(
  principal: AccessPrincipal,
  actualBuilding: unknown,
): WarehouseBuilding {
  assertInventoryMovementDeletionRole(principal);
  const normalizedActualBuilding = normalizeBuilding(actualBuilding);
  if (!normalizedActualBuilding) {
    throw new BadRequestException('库存变动记录楼栋缺失或无效');
  }
  const administratorBuilding = inventoryAdministratorBuildings(principal);
  if (
    administratorBuilding &&
    !canAccessBuilding(principal, normalizedActualBuilding)
  ) {
    denyAccess();
  }
  return normalizedActualBuilding;
}

function inventoryAdministratorBuildings(principal: AccessPrincipal): readonly WarehouseBuilding[] | null {
  if (principal.role !== 'inventory_admin' && principal.role !== 'building_admin') return null;
  const scope = accessBuildings(principal);
  if (!scope?.length) denyAccess();
  return scope;
}

function normalizeBuilding(value: unknown): WarehouseBuilding | null {
  return typeof value === 'string' && INVENTORY_ADMIN_BUILDINGS.has(value)
    ? (value as WarehouseBuilding)
    : null;
}

function scopeMovements<TMovement extends InventoryMovementItem>(
  movements: TMovement[],
  building: WarehouseBuilding,
): TMovement[] {
  return movements.filter(
    (item) =>
      item.building === building &&
      (!item.destinationBuilding ||
        item.destinationBuilding === building ||
        item.destinationBuilding === '未配置'),
  );
}

function buildScopedStocktake(
  stocktake: InventoryManagementDashboard['stocktake'],
  buildings: InventoryStocktakeBuildingProgress[],
): InventoryManagementDashboard['stocktake'] {
  const total = buildings.reduce((sum, item) => sum + item.total, 0);
  const completed = buildings.reduce((sum, item) => sum + item.completed, 0);
  return {
    ...stocktake,
    total,
    completed,
    completionRate: total ? Math.round((completed / total) * 1000) / 10 : 0,
    buildings,
  };
}

function denyAccess(): never {
  throw new ForbiddenException('无权访问或操作该楼栋库存数据');
}
