import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type {
  InventoryManagementDashboard,
  PurchasePendingInboundResponse,
  WarehouseStorageLocationCreateRequest,
} from '../../shared/inventory-management.interface';
import {
  assertInventoryMovementDeletionRole,
  assertInventoryMovementDeletionScope,
  assertInventoryMovementScope,
  assertPurchaseInboundScope,
  assertStorageLocationCreateScope,
  scopeInventoryDashboard,
  scopeInventoryItemsQuery,
  scopeInventoryMovementsQuery,
  scopePendingPurchaseInbounds,
  scopeStorageLocationQuery,
} from '../../server/modules/inventory-management/inventory-access-policy';
import * as inventoryAccessPolicy from '../../server/modules/inventory-management/inventory-access-policy';

const inventoryAdministratorA: AccessPrincipal = {
  role: 'inventory_admin',
  purchaseBuilding: 'A楼',
};

describe('inventory administrator building access policy', () => {
  it('scopes every historical month and recomputes its totals', () => {
    const dashboard = dashboardForBuildings();
    const input = {
      ...dashboard,
      stocktakeHistory: [{ ...dashboard.stocktake, year: 2026, month: 9 }],
    };
    const result = scopeInventoryDashboard(inventoryAdministratorA, input);
    const history = Reflect.get(
      result,
      'stocktakeHistory',
    ) as InventoryManagementDashboard['stocktake'][];
    expect(history[0].buildings.map((b) => b.building)).toEqual(['A楼']);
    expect(history[0].total).toBe(history[0].buildings[0].total);
    expect(input.stocktakeHistory[0].buildings).toHaveLength(2);
  });
  it('overrides arbitrary list filters with the logged-in building', () => {
    expect(
      scopeInventoryItemsQuery(inventoryAdministratorA, {
        building: 'B楼',
        search: 'UPS',
      }),
    ).toEqual({ building: 'A楼', search: 'UPS' });
    expect(
      scopeInventoryMovementsQuery(inventoryAdministratorA, {
        type: 'outbound',
        building: 'B楼',
      }),
    ).toEqual({ type: 'outbound', building: 'A楼' });
    expect(
      scopeStorageLocationQuery(inventoryAdministratorA, {
        building: 'B楼',
        query: '货架',
        limit: 20,
      }),
    ).toEqual({ building: 'A楼', query: '货架', limit: 20 });
  });

  it('rejects storage location creation outside the logged-in building', () => {
    const crossBuildingRequest: WarehouseStorageLocationCreateRequest = {
      building: 'B楼',
      category: '库内',
      name: 'B-1F-001',
      clientMutationId: 'storage-location-b-1',
    };

    expect(() =>
      assertStorageLocationCreateScope(
        inventoryAdministratorA,
        crossBuildingRequest,
      ),
    ).toThrow(ForbiddenException);
    expect(
      assertStorageLocationCreateScope(
        { role: 'admin', purchaseBuilding: null },
        crossBuildingRequest,
      ),
    ).toBe(crossBuildingRequest);
  });

  it('returns only the logged-in building in dashboard and pending inbound data', () => {
    const result = scopeInventoryDashboard(
      inventoryAdministratorA,
      dashboardForBuildings(),
    );
    const pending = scopePendingPurchaseInbounds(
      inventoryAdministratorA,
      pendingInbounds(),
    );

    expect(result.buildings.map((item) => item.building)).toEqual(['A楼']);
    expect(result.categories).toEqual([]);
    expect(result.alerts.map((item) => item.building)).toEqual(['A楼']);
    expect(result.movements.inbound.map((item) => item.building)).toEqual([
      'A楼',
    ]);
    expect(result.stocktake.buildings.map((item) => item.building)).toEqual([
      'A楼',
    ]);
    expect(pending.items.map((item) => item.building)).toEqual(['A楼']);
  });

  it('rejects inventory movements and purchase inbound confirmations for another building', () => {
    expect(() =>
      assertInventoryMovementScope(inventoryAdministratorA, {
        type: 'outbound',
        clientMutationId: 'outbound-cross-building-1',
        catalogRecordId: 'catalog-b',
        sku: 'B-01',
        building: 'B楼',
        quantity: 1,
        occurredAt: '2026-07-16T10:00:00.000Z',
        applicantOpenId: 'ou_applicant',
        reason: '现场使用',
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertPurchaseInboundScope(
        inventoryAdministratorA,
        {
          executionRecordId: 'execution-b',
          mode: 'existing',
          sku: 'B-01',
          quantity: 1,
          occurredAt: '2026-07-16T10:00:00.000Z',
        },
        pendingInbounds().items,
      ),
    ).toThrow(ForbiddenException);
  });

  it.each([null, 1, 'invalid', []])(
    'rejects malformed inventory movement body %p with a controlled bad request',
    (request) => {
      expect(() =>
        assertInventoryMovementScope(inventoryAdministratorA, request as never),
      ).toThrow(BadRequestException);
    },
  );

  it('requires both the original purchase building and target building to be authorized', () => {
    const strictRequest = {
      executionRecordId: 'execution-a',
      mode: 'existing' as const,
      building: 'B楼' as const,
      clientMutationId: 'purchase-target-b',
      catalogRecordId: 'catalog-b',
      sku: 'B-01',
      quantity: 1,
      occurredAt: '2026-07-16T10:00:00.000Z',
    };

    expect(() =>
      assertPurchaseInboundScope(
        inventoryAdministratorA,
        strictRequest,
        pendingInbounds().items,
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertPurchaseInboundScope(
        { role: 'admin', purchaseBuilding: null },
        strictRequest,
        pendingInbounds().items,
      ),
    ).not.toThrow();
  });

  it('allows a completed retry through target preflight when pending data disappeared', () => {
    expect(() =>
      assertPurchaseInboundScope(
        inventoryAdministratorA,
        {
          executionRecordId: 'execution-a',
          mode: 'existing',
          building: 'A楼',
          clientMutationId: 'purchase-completed-retry',
          catalogRecordId: 'catalog-a',
          sku: 'A-01',
          quantity: 1,
          occurredAt: '2026-07-16T10:00:00.000Z',
        },
        [],
      ),
    ).not.toThrow();
  });

  it('exposes an explicit service-side check for the execution original building', () => {
    const policy = inventoryAccessPolicy as unknown as {
      assertPurchaseInboundExecutionScope(
        principal: AccessPrincipal,
        building: unknown,
      ): void;
    };

    expect(() =>
      policy.assertPurchaseInboundExecutionScope(
        inventoryAdministratorA,
        'B楼',
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      policy.assertPurchaseInboundExecutionScope(
        { role: 'admin', purchaseBuilding: null },
        'B楼',
      ),
    ).not.toThrow();
  });

  it('allows only system and inventory administrators to request movement deletion', () => {
    expect(() =>
      assertInventoryMovementDeletionRole({
        role: 'admin',
        purchaseBuilding: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertInventoryMovementDeletionRole(inventoryAdministratorA),
    ).not.toThrow();
    expect(() =>
      assertInventoryMovementDeletionRole({
        role: 'editor',
        purchaseBuilding: null,
      }),
    ).toThrow(ForbiddenException);
  });

  it('authorizes deletion from the server-read movement building', () => {
    expect(() =>
      assertInventoryMovementDeletionScope(inventoryAdministratorA, 'A楼'),
    ).not.toThrow();
    expect(() =>
      assertInventoryMovementDeletionScope(inventoryAdministratorA, 'B楼'),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertInventoryMovementDeletionScope(
        { role: 'admin', purchaseBuilding: null },
        'B楼',
      ),
    ).not.toThrow();
  });

  it('rejects a missing or invalid server-read movement building', () => {
    expect(() =>
      assertInventoryMovementDeletionScope(inventoryAdministratorA, ''),
    ).toThrow(BadRequestException);
    expect(() =>
      assertInventoryMovementDeletionScope(inventoryAdministratorA, '未配置'),
    ).toThrow(BadRequestException);
  });
});

function dashboardForBuildings(): InventoryManagementDashboard {
  return {
    generatedAt: '2026-07-16T10:00:00.000Z',
    sourceUrl: '',
    summary: {
      inventoryLines: 2,
      distinctSkus: 2,
      totalQuantity: 5,
      inventoryValue: 50,
      lowStockItems: 1,
      negativeStockItems: 0,
      idleItems: 0,
      pendingConfirmationItems: 1,
      unassignedInventoryLines: 0,
    },
    buildings: [
      {
        building: 'A楼',
        inventoryLines: 1,
        distinctSkus: 1,
        totalQuantity: 2,
        inventoryValue: 20,
        lowStockItems: 1,
        negativeStockItems: 0,
        idleItems: 0,
        owners: [],
      },
      {
        building: 'B楼',
        inventoryLines: 1,
        distinctSkus: 1,
        totalQuantity: 3,
        inventoryValue: 30,
        lowStockItems: 0,
        negativeStockItems: 0,
        idleItems: 0,
        owners: [],
      },
    ],
    categories: [],
    alerts: [
      { building: 'A楼', pendingConfirmation: true },
      { building: 'B楼', pendingConfirmation: false },
    ] as InventoryManagementDashboard['alerts'],
    movements: {
      inbound: [
        { building: 'A楼', destinationBuilding: '' },
        { building: 'B楼', destinationBuilding: '' },
      ] as InventoryManagementDashboard['movements']['inbound'],
      outbound: [],
      borrow: [],
    },
    stocktake: {
      year: 2026,
      month: 7,
      total: 2,
      completed: 1,
      completionRate: 50,
      buildings: [
        {
          building: 'A楼',
          total: 1,
          completed: 1,
          completionRate: 100,
          responsible: '',
        },
        {
          building: 'B楼',
          total: 1,
          completed: 0,
          completionRate: 0,
          responsible: '',
        },
      ],
    },
    sectionStatus: {
      inventory: { configured: true, count: 2 },
    } as InventoryManagementDashboard['sectionStatus'],
  };
}

function pendingInbounds(): PurchasePendingInboundResponse {
  return {
    generatedAt: '2026-07-16T10:00:00.000Z',
    items: [
      { executionRecordId: 'execution-a', building: 'A楼' },
      { executionRecordId: 'execution-b', building: 'B楼' },
    ] as PurchasePendingInboundResponse['items'],
  };
}
