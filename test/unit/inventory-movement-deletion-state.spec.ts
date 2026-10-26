import type {
  InventoryMovementItem,
  InventoryMovementsResponse,
} from '../../shared/inventory-management.interface';
import {
  acceptInventoryMovementDeletion,
  beginInventoryMovementDeletion,
  completeInventoryMovementDeletion,
  createInitialInventoryMovementDeletionState,
  failInventoryMovementDeletion,
  markInventoryMovementDeletionUncertain,
  mergeInventoryMovementDeletionQueryResult,
  selectInventoryMovementsAfterDeletion,
} from '../../client/src/pages/InventoryManagement/inventory-movement-deletion-state';

function movement(
  recordId: string,
  overrides: Partial<InventoryMovementItem> = {},
): InventoryMovementItem {
  return {
    recordId,
    type: 'outbound',
    sku: `SKU-${recordId}`,
    name: `物品-${recordId}`,
    specification: '标准规格',
    quantity: 2,
    unit: '箱',
    building: 'H楼',
    destinationBuilding: '',
    location: 'H-2F-226储存间01-0F',
    reason: '办公使用',
    operator: '库房管理员',
    applicant: '申请人',
    status: '已出库',
    occurredAt: '2026-08-13T01:47:00.000Z',
    expectedReturnAt: null,
    overdue: false,
    ...overrides,
  };
}

function response(items: InventoryMovementItem[]): InventoryMovementsResponse {
  const statusCounts = new Map<string, number>();
  for (const item of items) {
    statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
  }
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    summary: {
      totalRecords: items.length,
      totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
      overdueItems: items.filter((item) => item.overdue).length,
      statusCounts: [...statusCounts].map(([status, count]) => ({
        status,
        count,
      })),
    },
  };
}

describe('inventory movement deletion optimistic state', () => {
  it('hides the row and updates page totals synchronously without mutating the base response', () => {
    const target = movement('outbound-1', {
      quantity: 10,
      status: '待库房确认',
      overdue: true,
    });
    const other = movement('outbound-2', { quantity: 3 });
    const base = response([target, other]);
    const initial = createInitialInventoryMovementDeletionState();

    const deleting = beginInventoryMovementDeletion(initial, {
      clientMutationId: 'delete-1',
      movement: target,
      originalIndex: 0,
      requestWatermark: 7,
      startedAt: 100,
    });
    const visible = selectInventoryMovementsAfterDeletion(deleting, base);

    expect(visible.items.map((item) => item.recordId)).toEqual(['outbound-2']);
    expect(visible.total).toBe(1);
    expect(visible.totalPages).toBe(1);
    expect(visible.summary).toEqual({
      totalRecords: 1,
      totalQuantity: 3,
      overdueItems: 0,
      statusCounts: [{ status: '已出库', count: 1 }],
    });
    expect(base.items.map((item) => item.recordId)).toEqual([
      'outbound-1',
      'outbound-2',
    ]);
    expect(base.summary.totalQuantity).toBe(13);
  });

  it('is idempotent for the same mutation and rejects a second active deletion of the same record', () => {
    const target = movement('outbound-1');
    const first = beginInventoryMovementDeletion(
      createInitialInventoryMovementDeletionState(),
      {
        clientMutationId: 'delete-1',
        movement: target,
        originalIndex: 0,
        requestWatermark: 1,
        startedAt: 100,
      },
    );

    expect(
      beginInventoryMovementDeletion(first, {
        clientMutationId: 'delete-1',
        movement: target,
        originalIndex: 0,
        requestWatermark: 1,
        startedAt: 100,
      }),
    ).toBe(first);
    expect(() =>
      beginInventoryMovementDeletion(first, {
        clientMutationId: 'delete-2',
        movement: target,
        originalIndex: 0,
        requestWatermark: 2,
        startedAt: 200,
      }),
    ).toThrow('该出入库记录正在删除');
  });

  it('restores the exact base row and summary after a definitely-not-deleted failure', () => {
    const target = movement('inbound-1', {
      type: 'inbound',
      quantity: 5,
      status: '已入库',
    });
    const base = response([movement('other'), target]);
    const deleting = beginInventoryMovementDeletion(
      createInitialInventoryMovementDeletionState(),
      {
        clientMutationId: 'delete-inbound-1',
        movement: target,
        originalIndex: 1,
        requestWatermark: 4,
        startedAt: 100,
      },
    );

    const restored = failInventoryMovementDeletion(
      deleting,
      'delete-inbound-1',
      '权限不足',
    );

    expect(selectInventoryMovementsAfterDeletion(restored, base)).toEqual(base);
    expect(restored.tombstones.size).toBe(0);
  });

  it('keeps an outcome-unknown deletion hidden with the original mutation id', () => {
    const target = movement('outbound-1');
    const base = response([target]);
    const deleting = beginInventoryMovementDeletion(
      createInitialInventoryMovementDeletionState(),
      {
        clientMutationId: 'delete-unknown-1',
        movement: target,
        originalIndex: 0,
        requestWatermark: 2,
        startedAt: 100,
      },
    );
    const accepted = acceptInventoryMovementDeletion(
      deleting,
      'delete-unknown-1',
      'task-1',
      110,
    );
    const uncertain = markInventoryMovementDeletionUncertain(
      accepted,
      'delete-unknown-1',
      '外部结果待核对',
      120,
    );

    expect(uncertain.tombstones.get('outbound-1')).toMatchObject({
      clientMutationId: 'delete-unknown-1',
      taskId: 'task-1',
      status: 'uncertain',
    });
    expect(
      selectInventoryMovementsAfterDeletion(uncertain, base).items,
    ).toEqual([]);
  });

  it('blocks stale and eventually-consistent responses until a newer authoritative query proves absence', () => {
    const target = movement('outbound-1');
    const staleBase = response([target]);
    const deleting = beginInventoryMovementDeletion(
      createInitialInventoryMovementDeletionState(),
      {
        clientMutationId: 'delete-completed-1',
        movement: target,
        originalIndex: 0,
        requestWatermark: 8,
        startedAt: 100,
      },
    );
    const completed = completeInventoryMovementDeletion(
      deleting,
      'delete-completed-1',
      8,
      130,
    );

    const stale = mergeInventoryMovementDeletionQueryResult(
      completed,
      staleBase,
      8,
    );
    const lagging = mergeInventoryMovementDeletionQueryResult(
      stale,
      staleBase,
      9,
    );
    const authoritative = mergeInventoryMovementDeletionQueryResult(
      lagging,
      response([]),
      10,
    );

    expect(stale.tombstones.has('outbound-1')).toBe(true);
    expect(lagging.tombstones.has('outbound-1')).toBe(true);
    expect(
      selectInventoryMovementsAfterDeletion(lagging, staleBase).items,
    ).toEqual([]);
    expect(authoritative.tombstones.has('outbound-1')).toBe(false);
  });
});
