import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { accessBuildings, canAccessBuilding } from '../../../shared/building-access';
import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  PURCHASE_ACCESS_BUILDINGS,
  BUILDING_ADMIN_BUILDINGS,
  type AccessPrincipal,
} from '../../../shared/access-control.interface';
import type { PurchaseBuilding } from '../../../shared/purchase-application.interface';
import type {
  PurchaseInventoryAlertItem,
  PurchaseInventoryMovementItem,
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
  PurchaseInventoryStage,
  PurchaseRecordBatchDeleteRequest,
  PurchaseRecordUpdateRequest,
} from '../../../shared/purchase-inventory.interface';
import { PurchaseInventoryService } from './purchase-inventory.service';
import { canManageProfessionalRecord } from '../../../shared/professional-access';
import { assertProfessionalRecordScope } from '../../common/access/professional-record-scope';

const FULL_DASHBOARD_ROLES = new Set([
  'admin',
  'editor',
  'purchase_admin',
  'supply_chain_admin',
]);
const FULL_UPDATE_ROLES = new Set([
  'admin',
  'editor',
  'purchase_admin',
  'supply_chain_admin',
]);
const FULL_DELETE_ROLES = new Set([
  'admin',
  'purchase_admin',
  'supply_chain_admin',
]);
const MAX_DELETE_ITEMS = 200;
const APPLICANT_EDITABLE_STAGES = new Set<PurchaseInventoryStage>([
  'application',
  'approval',
]);
const APPLICANT_FORBIDDEN_UPDATE_FIELDS = [
  'building',
  'requesterOpenId',
  'status',
] as const;
const PURCHASE_BUILDING_SET = new Set<string>([
  ...PURCHASE_ACCESS_BUILDINGS,
  ...BUILDING_ADMIN_BUILDINGS,
]);
const PURCHASE_STAGES: PurchaseInventoryStage[] = [
  'application',
  'approval',
  'rejected',
  'executing',
  'receiving',
  'inbound',
  'stocked',
];

@Injectable()
export class PurchaseAccessPolicyService {
  constructor(private readonly inventoryService: PurchaseInventoryService) {}

  scopeDashboard(
    principal: AccessPrincipal,
    dashboard: PurchaseInventoryResponse,
    pageRead = false,
  ): PurchaseInventoryResponse {
    if (isProfessionalBusinessPrincipal(principal)) {
      const requests = dashboard.requests.filter(item => canManageProfessionalRecord(principal, item.specialty, item.building, { module: 'purchase', action: 'read' }));
      return buildScopedDashboard(dashboard, requests, [], [], []);
    }
    if (FULL_DASHBOARD_ROLES.has(principal.role)) return dashboard;
    if (pageRead && principal.role !== 'purchase_applicant' && principal.role !== 'building_admin') {
      const scope = accessBuildings(principal);
      return scope ? buildScopedDashboard(dashboard, dashboard.requests.filter(item => canAccessBuilding(principal, item.building)), dashboard.inventory.alerts.filter(item => canAccessBuilding(principal, item.building)), dashboard.movements.recentInbound.filter(item => canAccessBuilding(principal, item.building)), dashboard.movements.recentOutbound.filter(item => canAccessBuilding(principal, item.building))) : dashboard;
    }
    if (principal.role !== 'purchase_applicant' && principal.role !== 'building_admin') denyAccess();

    const building = this.requireApplicantBuilding(principal);
    const requests = dashboard.requests.filter(
      (item) => canAccessBuilding(principal, item.building),
    );
    const alerts = dashboard.inventory.alerts.filter(
      (item) => canAccessBuilding(principal, item.building),
    );
    const inbound = dashboard.movements.recentInbound.filter(
      (item) => canAccessBuilding(principal, item.building),
    );
    const outbound = dashboard.movements.recentOutbound.filter(
      (item) => canAccessBuilding(principal, item.building),
    );

    return buildScopedDashboard(dashboard, requests, alerts, inbound, outbound);
  }

  private assertFreshProfessionalDashboard(principal: AccessPrincipal, dashboard: PurchaseInventoryResponse) {
    if (isProfessionalBusinessPrincipal(principal) && Object.values(dashboard.sectionStatus).some(status => !status.configured || status.message)) throw new ForbiddenException('采购数据刷新未完成，请重试后操作');
  }

  requireApplicantBuilding(principal: AccessPrincipal): PurchaseBuilding {
    if (principal.role !== 'purchase_applicant' && principal.role !== 'building_admin') denyAccess();
    const scope = accessBuildings(principal);
    const building = scope?.length ? normalizeBuilding(scope[0]) : null;
    if (!building) denyAccess();
    return building;
  }

  assertRequestedBuilding(
    principal: AccessPrincipal,
    requestedBuilding: unknown,
  ): PurchaseBuilding | string {
    if (principal.role === 'guest' && !isProfessionalBusinessPrincipal(principal)) denyAccess();
    const requested = normalizeBuilding(requestedBuilding);
    if (!requested) denyAccess();
    if (
      (principal.role === 'purchase_applicant' || principal.role === 'building_admin' || principal.role === 'inventory_admin') &&
      !canAccessBuilding(principal, requested)
    ) {
      denyAccess();
    }
    return requested;
  }

  async prepareUpdate(
    principal: AccessPrincipal,
    routeRecordId: string,
    request: PurchaseRecordUpdateRequest,
  ): Promise<PurchaseRecordUpdateRequest> {
    const fields = request?.fields as unknown;
    const includesStatus =
      isObjectLike(fields) &&
      Object.prototype.hasOwnProperty.call(fields, 'status');
    if (isProfessionalBusinessPrincipal(principal)) {
      const dashboard = await this.inventoryService.getDashboard(true);
      this.assertFreshProfessionalDashboard(principal, dashboard);
      const item = resolveUniqueRouteItem(dashboard.requests, clean(routeRecordId));
      if (!item) denyAccess();
      assertProfessionalRecordScope(principal, item.specialty, item.building);
      assertTypedUpdateIdsMatch(dashboard.requests, item, request);
      if (isObjectLike(fields)) assertProfessionalRecordScope(principal, Object.hasOwn(fields, 'specialty') ? (fields as Record<string, unknown>).specialty : item.specialty, Object.hasOwn(fields, 'building') ? (fields as Record<string, unknown>).building : item.building);
      return request;
    }
    if (principal.role === 'building_admin') {
      const building = this.requireApplicantBuilding(principal);
      const dashboard = await this.inventoryService.getDashboard(true);
      this.assertFreshProfessionalDashboard(principal, dashboard);
      const item = resolveUniqueRouteItem(dashboard.requests, clean(routeRecordId));
      if (!item || !canAccessBuilding(principal, item.building)) denyAccess();
      assertTypedUpdateIdsMatch(dashboard.requests, item, request);
      if (isObjectLike(fields) && Object.prototype.hasOwnProperty.call(fields, 'building')) {
        if (!canAccessBuilding(principal, (fields as Record<string, unknown>).building)) denyAccess();
      }
      return request;
    }
    if (FULL_UPDATE_ROLES.has(principal.role)) {
      if (!includesStatus) return request;
      if (principal.role !== 'admin') denyAccess();

      const routeId = clean(routeRecordId);
      if (!routeId) denyAccess();
      const dashboard = await this.inventoryService.getDashboard(true);
      this.assertFreshProfessionalDashboard(principal, dashboard);
      const item = resolveUniqueRouteItem(dashboard.requests, routeId);
      if (!item) denyAccess();
      assertTypedUpdateIdsMatch(dashboard.requests, item, request);
      return request;
    }
    if (principal.role !== 'purchase_applicant') denyAccess();

    if (isObjectLike(fields)) {
      for (const field of APPLICANT_FORBIDDEN_UPDATE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(fields, field)) denyAccess();
      }
    }

    const building = this.requireApplicantBuilding(principal);
    const routeId = clean(routeRecordId);
    if (!routeId) denyAccess();
    const dashboard = await this.inventoryService.getDashboard(true);
    const item = resolveUniqueRouteItem(dashboard.requests, routeId);
    if (!item || !canApplicantMutate(item, principal)) denyAccess();
    assertTypedUpdateIdsMatch(dashboard.requests, item, request);
    return request;
  }

  async authorizeDelete(
    principal: AccessPrincipal,
    request: PurchaseRecordBatchDeleteRequest,
  ): Promise<PurchaseRecordBatchDeleteRequest> {
    if (
      !Array.isArray(request?.records) ||
      request.records.length === 0 ||
      request.records.length > MAX_DELETE_ITEMS
    ) {
      denyAccess();
    }
    if (FULL_DELETE_ROLES.has(principal.role) && !isProfessionalBusinessPrincipal(principal)) return request;
    if (isProfessionalBusinessPrincipal(principal)) {
      const dashboard = await this.inventoryService.getDashboard(true);
      this.assertFreshProfessionalDashboard(principal, dashboard);
      const indexes = buildTypedItemIndexes(dashboard.requests);
      for (const target of request.records) {
        if (!target || typeof target !== 'object' || Array.isArray(target)) denyAccess();
        const item = resolveDeleteTarget(indexes, target.submissionRecordId, target.executionRecordId);
        if (!item) denyAccess();
        assertProfessionalRecordScope(principal, item.specialty, item.building);
      }
      return request;
    }
    if (principal.role === 'building_admin') {
      const building = this.requireApplicantBuilding(principal);
      const dashboard = await this.inventoryService.getDashboard(true);
      this.assertFreshProfessionalDashboard(principal, dashboard);
      const indexes = buildTypedItemIndexes(dashboard.requests);
      for (const target of request.records) {
        if (!target || typeof target !== 'object' || Array.isArray(target)) denyAccess();
        const item = resolveDeleteTarget(indexes, target.submissionRecordId, target.executionRecordId);
        if (!item || !canAccessBuilding(principal, item.building)) denyAccess();
      }
      return request;
    }
    if (
      principal.role !== 'editor' &&
      principal.role !== 'purchase_applicant'
    ) {
      denyAccess();
    }
    const dashboard = await this.inventoryService.getDashboard(true);
    const typedItemIndexes = buildTypedItemIndexes(dashboard.requests);
    if (principal.role === 'editor') {
      for (const target of request.records) {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
          denyAccess();
        }
        const item = resolveDeleteTarget(
          typedItemIndexes,
          target.submissionRecordId,
          target.executionRecordId,
        );
        if (!item || item.stage !== 'stocked') denyAccess();
      }
      return request;
    }
    if (principal.role !== 'purchase_applicant') denyAccess();

    const building = this.requireApplicantBuilding(principal);
    for (const target of request.records) {
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        denyAccess();
      }
      const item = resolveDeleteTarget(
        typedItemIndexes,
        target.submissionRecordId,
        target.executionRecordId,
      );
      if (!item || !canApplicantMutate(item, principal)) denyAccess();
    }
    return request;
  }
}

function buildScopedDashboard(
  dashboard: PurchaseInventoryResponse,
  requests: PurchaseInventoryRequestItem[],
  alerts: PurchaseInventoryAlertItem[],
  inbound: PurchaseInventoryMovementItem[],
  outbound: PurchaseInventoryMovementItem[],
): PurchaseInventoryResponse {
  const stageCounts = Object.fromEntries(
    PURCHASE_STAGES.map((stage) => [stage, 0]),
  ) as Record<PurchaseInventoryStage, number>;
  for (const request of requests) stageCounts[request.stage] += 1;

  const inventorySkus = new Set(
    alerts
      .map((item) => clean(item.sku) || clean(item.recordId))
      .filter(Boolean),
  ).size;

  return {
    generatedAt: dashboard.generatedAt,
    ...(dashboard.refreshState ? { refreshState: dashboard.refreshState } : {}),
    ...(dashboard.refreshError ? { refreshError: dashboard.refreshError } : {}),
    summary: {
      totalRequests: requests.length,
      pendingApprovals: stageCounts.approval,
      executingOrders: stageCounts.executing,
      awaitingReceipt: stageCounts.receiving,
      stockedRequests: stageCounts.stocked,
      estimatedAmount: roundMoney(
        requests.reduce((sum, item) => sum + item.estimatedAmount, 0),
      ),
      actualAmount: roundMoney(
        requests.reduce((sum, item) => sum + (item.actualAmount ?? 0), 0),
      ),
      catalogItems: 0,
      inventorySkus,
      availableQuantity: alerts.reduce(
        (sum, item) => sum + item.availableQuantity,
        0,
      ),
      inventoryValue: roundMoney(
        alerts.reduce((sum, item) => sum + item.value, 0),
      ),
      lowStockSkus: alerts.length,
      pendingInbound: inbound.filter((item) => item.status.includes('待入库'))
        .length,
      stageCounts,
    },
    requests,
    inventory: { categoryBreakdown: [], alerts },
    movements: { recentInbound: inbound, recentOutbound: outbound },
    sectionStatus: {
      submissions: withScopedCount(
        dashboard.sectionStatus.submissions,
        countUniqueIds(requests.map((item) => item.submissionRecordId)),
      ),
      executions: withScopedCount(
        dashboard.sectionStatus.executions,
        countUniqueIds(requests.map((item) => item.executionRecordId)),
      ),
      catalog: withScopedCount(dashboard.sectionStatus.catalog, 0),
      inventory: withScopedCount(
        dashboard.sectionStatus.inventory,
        alerts.length,
      ),
      inbound: withScopedCount(dashboard.sectionStatus.inbound, inbound.length),
      outbound: withScopedCount(
        dashboard.sectionStatus.outbound,
        outbound.length,
      ),
    },
  };
}

function withScopedCount<T extends { count: number }>(
  status: T,
  count: number,
): T {
  return { ...status, count };
}

function countUniqueIds(values: Array<string | null>): number {
  return new Set(values.map(clean).filter(Boolean)).size;
}

function resolveUniqueRouteItem(
  requests: PurchaseInventoryRequestItem[],
  routeRecordId: string,
): PurchaseInventoryRequestItem | null {
  const matches = requests.filter(
    (item) =>
      clean(item.recordId) === routeRecordId ||
      clean(item.submissionRecordId) === routeRecordId ||
      clean(item.executionRecordId) === routeRecordId,
  );
  return matches.length === 1 ? matches[0] : null;
}

function resolveUniqueTypedItem(
  requests: PurchaseInventoryRequestItem[],
  field: 'submissionRecordId' | 'executionRecordId',
  recordId: string,
): PurchaseInventoryRequestItem | null {
  const matches = requests.filter((item) => clean(item[field]) === recordId);
  return matches.length === 1 ? matches[0] : null;
}

function assertTypedUpdateIdsMatch(
  requests: PurchaseInventoryRequestItem[],
  item: PurchaseInventoryRequestItem,
  request: PurchaseRecordUpdateRequest,
): void {
  const submissionRecordId = clean(request?.submissionRecordId);
  const executionRecordId = clean(request?.executionRecordId);
  if (!submissionRecordId && !executionRecordId) denyAccess();
  if (
    submissionRecordId &&
    resolveUniqueTypedItem(
      requests,
      'submissionRecordId',
      submissionRecordId,
    ) !== item
  ) {
    denyAccess();
  }
  if (
    executionRecordId &&
    resolveUniqueTypedItem(requests, 'executionRecordId', executionRecordId) !==
      item
  ) {
    denyAccess();
  }
}

interface TypedItemIndexes {
  submissionRecordId: Map<string, PurchaseInventoryRequestItem | null>;
  executionRecordId: Map<string, PurchaseInventoryRequestItem | null>;
}

function buildTypedItemIndexes(
  requests: PurchaseInventoryRequestItem[],
): TypedItemIndexes {
  const indexes: TypedItemIndexes = {
    submissionRecordId: new Map(),
    executionRecordId: new Map(),
  };
  for (const item of requests) {
    addTypedItem(indexes.submissionRecordId, item.submissionRecordId, item);
    addTypedItem(indexes.executionRecordId, item.executionRecordId, item);
  }
  return indexes;
}

function addTypedItem(
  index: Map<string, PurchaseInventoryRequestItem | null>,
  recordIdValue: unknown,
  item: PurchaseInventoryRequestItem,
): void {
  const recordId = clean(recordIdValue);
  if (!recordId) return;
  const existing = index.get(recordId);
  if (existing === undefined) {
    index.set(recordId, item);
  } else if (existing !== item) {
    index.set(recordId, null);
  }
}

function resolveDeleteTarget(
  indexes: TypedItemIndexes,
  submissionRecordIdValue: unknown,
  executionRecordIdValue: unknown,
): PurchaseInventoryRequestItem | null {
  const submissionRecordId = clean(submissionRecordIdValue);
  const executionRecordId = clean(executionRecordIdValue);
  if (!submissionRecordId && !executionRecordId) return null;

  const submissionItem = submissionRecordId
    ? indexes.submissionRecordId.get(submissionRecordId) || null
    : null;
  const executionItem = executionRecordId
    ? indexes.executionRecordId.get(executionRecordId) || null
    : null;
  if (
    (submissionRecordId && !submissionItem) ||
    (executionRecordId && !executionItem) ||
    (submissionItem && executionItem && submissionItem !== executionItem)
  ) {
    return null;
  }
  return submissionItem || executionItem;
}

function canApplicantMutate(
  item: PurchaseInventoryRequestItem,
  principal: AccessPrincipal,
): boolean {
  return (
    canAccessBuilding(principal, item.building) &&
    APPLICANT_EDITABLE_STAGES.has(item.stage) &&
    item.purchaseCompleted === false
  );
}

function normalizeBuilding(value: unknown): PurchaseBuilding | null {
  const building = clean(value);
  if (!building) return null;
  const canonical = `${building.slice(0, 1).toUpperCase()}${building.slice(1)}`;
  return PURCHASE_BUILDING_SET.has(canonical)
    ? (canonical as PurchaseBuilding)
    : null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isObjectLike(value: unknown): value is object {
  return (
    value !== null && (typeof value === 'object' || typeof value === 'function')
  );
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function denyAccess(): never {
  throw new ForbiddenException('无权访问或操作该采购数据');
}
