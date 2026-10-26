import type {
  InventoryMovementItem,
  InventoryMovementsResponse,
  PurchasePendingInboundItem,
} from '../../shared/inventory-management.interface';
import {
  beginMutation,
  confirmMutation,
  createInitialInventoryInboundState,
  failMutation,
  mergeMovementQueryResult,
  mergePurchaseQueryResult,
  selectVisibleMovementResponse,
} from '../../client/src/pages/InventoryManagement/inventory-inbound-optimistic';

interface TestDraft {
  source: 'manual' | 'purchase';
  itemName: string;
  form: {
    quantity: number;
    building: string;
  };
}

function createMovement(
  overrides: Partial<InventoryMovementItem> = {},
): InventoryMovementItem {
  return {
    recordId: 'movement-1',
    type: 'inbound',
    sku: 'SKU-001',
    name: '测试物品',
    specification: '标准规格',
    quantity: 1,
    unit: '件',
    building: '1号楼',
    destinationBuilding: '',
    location: 'A-01',
    reason: '采购入库',
    operator: '测试管理员',
    applicant: '测试申请人',
    status: '已入库',
    occurredAt: '2026-07-30T08:00:00.000Z',
    expectedReturnAt: null,
    overdue: false,
    ...overrides,
  };
}

function createMovementResponse(
  items: InventoryMovementItem[] = [],
  overrides: Partial<InventoryMovementsResponse> = {},
): InventoryMovementsResponse {
  const totalQuantity = items.reduce(
    (total, movement) => total + movement.quantity,
    0,
  );
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    totalPages: Math.max(1, Math.ceil(items.length / 20)),
    summary: {
      totalRecords: items.length,
      totalQuantity,
      overdueItems: 0,
      statusCounts: [],
    },
    ...overrides,
  };
}

function createPurchase(
  executionRecordId: string,
  overrides: Partial<PurchasePendingInboundItem> = {},
): PurchasePendingInboundItem {
  return {
    executionRecordId,
    submissionRecordId: `submission-${executionRecordId}`,
    requestCode: `REQ-${executionRecordId}`,
    mode: 'existing',
    sku: `SKU-${executionRecordId}`,
    itemName: `采购物品-${executionRecordId}`,
    specification: '标准规格',
    brand: '测试品牌',
    primaryCategory: '工具',
    secondaryCategory: '手持工具',
    building: '1号楼',
    quantity: 2,
    unit: '件',
    signedAt: '2026-07-30T07:00:00.000Z',
    action: 'ready',
    catalogRecordId: `catalog-${executionRecordId}`,
    actionReason: '',
    ...overrides,
  };
}

function createDraft(
  itemName: string,
  source: TestDraft['source'] = 'manual',
): TestDraft {
  return {
    source,
    itemName,
    form: {
      quantity: 2,
      building: '1号楼',
    },
  };
}

describe('inventory inbound optimistic state', () => {
  it('inserts a pending movement synchronously and forces its mutation markers', () => {
    const optimisticMovement = createMovement({
      recordId: 'temp:manual-1',
      clientMutationId: 'wrong-id',
      pendingSync: false,
    });
    const initial = createInitialInventoryInboundState<TestDraft>({
      movementResponse: createMovementResponse([
        createMovement({ recordId: 'base-1' }),
      ]),
    });

    const result = beginMutation(initial, {
      clientMutationId: 'manual-1',
      draft: createDraft('手电筒'),
      optimisticMovement,
      startedAt: 100,
    });

    expect(result.pendingMutations.get('manual-1')).toMatchObject({
      startedAt: 100,
      optimisticMovement: {
        recordId: 'temp:manual-1',
        clientMutationId: 'manual-1',
        pendingSync: true,
      },
    });
    expect(selectVisibleMovementResponse(result)?.items).toEqual([
      expect.objectContaining({
        recordId: 'temp:manual-1',
        pendingSync: true,
      }),
      expect.objectContaining({ recordId: 'base-1' }),
    ]);
    expect(optimisticMovement).toMatchObject({
      clientMutationId: 'wrong-id',
      pendingSync: false,
    });
  });

  it('treats a duplicate in-flight mutation id as an idempotent no-op', () => {
    const initial = createInitialInventoryInboundState<TestDraft>();
    const first = beginMutation(initial, {
      clientMutationId: 'duplicate-1',
      draft: createDraft('第一次'),
      optimisticMovement: createMovement({ recordId: 'temp:first' }),
      startedAt: 100,
    });

    const duplicate = beginMutation(first, {
      clientMutationId: 'duplicate-1',
      draft: createDraft('第二次'),
      optimisticMovement: createMovement({ recordId: 'temp:second' }),
      startedAt: 200,
    });

    expect(duplicate).toBe(first);
    expect(duplicate.pendingMutations.size).toBe(1);
    expect(duplicate.pendingMutations.get('duplicate-1')?.draft.itemName).toBe(
      '第一次',
    );
  });

  it('rejects a different mutation id for the same in-flight purchase execution', () => {
    const purchase = createPurchase('exec-shared');
    const initial = createInitialInventoryInboundState<TestDraft>({
      pendingPurchases: [purchase],
    });
    const first = beginMutation(initial, {
      clientMutationId: 'purchase-shared-a',
      draft: createDraft('采购 A', 'purchase'),
      optimisticMovement: createMovement({
        recordId: 'temp:purchase-shared-a',
      }),
      startedAt: 100,
      purchaseExecutionRecordId: 'exec-shared',
    });

    const duplicateExecution = beginMutation(first, {
      clientMutationId: 'purchase-shared-b',
      draft: createDraft('采购 B', 'purchase'),
      optimisticMovement: createMovement({
        recordId: 'temp:purchase-shared-b',
      }),
      startedAt: 200,
      purchaseExecutionRecordId: 'exec-shared',
    });
    const failed = failMutation(
      duplicateExecution,
      'purchase-shared-a',
      new Error('第一个请求失败'),
    );

    expect(duplicateExecution).toBe(first);
    expect(duplicateExecution.pendingMutations.size).toBe(1);
    expect(
      failed.basePendingPurchases.map((item) => item.executionRecordId),
    ).toEqual(['exec-shared']);
  });

  it('keeps the canonical confirmed movement visible until a query catches up', () => {
    const base = createMovement({ recordId: 'base-1' });
    const initial = createInitialInventoryInboundState<TestDraft>({
      movementResponse: createMovementResponse([base]),
    });
    const pending = beginMutation(initial, {
      clientMutationId: 'manual-confirm-1',
      draft: createDraft('确认物品'),
      optimisticMovement: createMovement({
        recordId: 'temp:manual-confirm-1',
      }),
      startedAt: 100,
    });
    const canonicalInput = createMovement({
      recordId: 'real-confirm-1',
      clientMutationId: 'server-wrong-id',
      pendingSync: true,
      quantity: 3,
    });

    const confirmed = confirmMutation(
      pending,
      'manual-confirm-1',
      canonicalInput,
      1,
    );
    const laggingQuery = mergeMovementQueryResult(
      confirmed,
      createMovementResponse([base]),
      1,
    );

    expect(confirmed.pendingMutations.has('manual-confirm-1')).toBe(false);
    expect(
      confirmed.confirmedOverlays.get('manual-confirm-1')?.movement,
    ).toMatchObject({
      recordId: 'real-confirm-1',
      clientMutationId: 'manual-confirm-1',
      pendingSync: false,
    });
    expect(
      selectVisibleMovementResponse(laggingQuery)?.items.map(
        (movement) => movement.recordId,
      ),
    ).toEqual(['real-confirm-1', 'base-1']);
    expect(laggingQuery.confirmedOverlays.has('manual-confirm-1')).toBe(true);
    expect(canonicalInput).toMatchObject({
      clientMutationId: 'server-wrong-id',
      pendingSync: true,
    });
  });

  it('keeps a confirmed overlay until a newer query contains its mutation or record id', () => {
    const pageTwoItems = [
      createMovement({
        recordId: 'page-2-existing',
        quantity: 5,
      }),
    ];
    const pageTwoBeforeConfirmation = createMovementResponse(pageTwoItems, {
      total: 40,
      page: 2,
      pageSize: 20,
      totalPages: 2,
      summary: {
        totalRecords: 40,
        totalQuantity: 400,
        overdueItems: 0,
        statusCounts: [],
      },
    });
    const queried = mergeMovementQueryResult(
      createInitialInventoryInboundState<TestDraft>(),
      pageTwoBeforeConfirmation,
      5,
    );
    const pending = beginMutation(queried, {
      clientMutationId: 'watermark-confirmed',
      draft: createDraft('确认水位物品'),
      optimisticMovement: createMovement({
        recordId: 'temp:watermark-confirmed',
        quantity: 4,
      }),
      startedAt: 100,
    });
    const confirmed = confirmMutation(
      pending,
      'watermark-confirmed',
      createMovement({
        recordId: 'real:watermark-confirmed',
        quantity: 4,
      }),
      7,
    );

    const oldResponse = mergeMovementQueryResult(
      confirmed,
      pageTwoBeforeConfirmation,
      7,
    );

    expect(
      confirmed.confirmedOverlays.get('watermark-confirmed'),
    ).toMatchObject({
      movementQueryWatermark: 7,
    });
    expect(oldResponse.confirmedOverlays.has('watermark-confirmed')).toBe(true);
    expect(selectVisibleMovementResponse(oldResponse)).toMatchObject({
      items: [
        expect.objectContaining({ recordId: 'real:watermark-confirmed' }),
        expect.objectContaining({ recordId: 'page-2-existing' }),
      ],
      total: 41,
      summary: {
        totalRecords: 41,
        totalQuantity: 404,
      },
    });

    const pageTwoAfterConfirmation = createMovementResponse(pageTwoItems, {
      total: 41,
      page: 2,
      pageSize: 20,
      totalPages: 3,
      summary: {
        totalRecords: 41,
        totalQuantity: 404,
        overdueItems: 0,
        statusCounts: [],
      },
    });
    const newResponse = mergeMovementQueryResult(
      oldResponse,
      pageTwoAfterConfirmation,
      8,
    );

    expect(newResponse.confirmedOverlays.has('watermark-confirmed')).toBe(true);
    expect(selectVisibleMovementResponse(newResponse)).toMatchObject({
      items: [
        expect.objectContaining({ recordId: 'real:watermark-confirmed' }),
        expect.objectContaining({ recordId: 'page-2-existing' }),
      ],
      total: 42,
      summary: {
        totalRecords: 42,
        totalQuantity: 408,
      },
    });

    const caughtUp = mergeMovementQueryResult(
      newResponse,
      createMovementResponse([
        ...pageTwoItems,
        createMovement({
          recordId: 'real:watermark-confirmed',
          clientMutationId: 'watermark-confirmed',
          quantity: 4,
        }),
      ]),
      9,
    );
    expect(caughtUp.confirmedOverlays.has('watermark-confirmed')).toBe(false);
  });

  it('bounds confirmed overlays when many confirmations have not appeared in queries', () => {
    let state = createInitialInventoryInboundState<TestDraft>();
    for (let index = 0; index < 150; index += 1) {
      const clientMutationId = `bounded-confirmed-${index}`;
      state = beginMutation(state, {
        clientMutationId,
        draft: createDraft(`有界确认 ${index}`),
        optimisticMovement: createMovement({
          recordId: `pending:bounded-confirmed-${index}`,
        }),
        startedAt: index,
      });
      state = confirmMutation(
        state,
        clientMutationId,
        createMovement({ recordId: `real:bounded-confirmed-${index}` }),
      );
    }

    expect(state.confirmedOverlays.size).toBeLessThanOrEqual(100);
  });

  it.each([
    [
      'record id',
      createMovement({
        recordId: 'real-caught-up',
        clientMutationId: undefined,
      }),
    ],
    [
      'client mutation id',
      createMovement({
        recordId: 'different-record-id',
        clientMutationId: 'caught-up-1',
      }),
    ],
  ])(
    'removes a confirmed overlay when a query contains the same %s',
    (_label, queriedMovement) => {
      const pending = beginMutation(
        createInitialInventoryInboundState<TestDraft>(),
        {
          clientMutationId: 'caught-up-1',
          draft: createDraft('已追平物品'),
          optimisticMovement: createMovement({
            recordId: 'temp:caught-up-1',
          }),
          startedAt: 100,
        },
      );
      const confirmed = confirmMutation(
        pending,
        'caught-up-1',
        createMovement({ recordId: 'real-caught-up' }),
      );

      const result = mergeMovementQueryResult(
        confirmed,
        createMovementResponse([queriedMovement]),
        1,
      );

      expect(result.confirmedOverlays.has('caught-up-1')).toBe(false);
      expect(selectVisibleMovementResponse(result)?.items).toHaveLength(1);
    },
  );

  it('rejects a settled mutation id after its confirmed overlay is reconciled', () => {
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>(),
      {
        clientMutationId: 'settled-after-query',
        draft: createDraft('结算后幂等'),
        optimisticMovement: createMovement({
          recordId: 'temp:settled-after-query',
        }),
        startedAt: 100,
      },
    );
    const canonical = createMovement({
      recordId: 'real:settled-after-query',
    });
    const confirmed = confirmMutation(
      pending,
      'settled-after-query',
      canonical,
    );
    const reconciled = mergeMovementQueryResult(
      confirmed,
      createMovementResponse([
        {
          ...canonical,
          clientMutationId: 'settled-after-query',
        },
      ]),
      1,
    );

    const duplicate = beginMutation(reconciled, {
      clientMutationId: 'settled-after-query',
      draft: createDraft('不应再次提交'),
      optimisticMovement: createMovement({
        recordId: 'temp:settled-duplicate',
      }),
      startedAt: 200,
    });

    expect(reconciled.confirmedOverlays.size).toBe(0);
    expect(reconciled.settledMutationIds.has('settled-after-query')).toBe(true);
    expect(duplicate).toBe(reconciled);
  });

  it('ignores an unknown or already-settled confirmation', () => {
    const initial = createInitialInventoryInboundState<TestDraft>();
    const canonical = createMovement({ recordId: 'unknown-canonical' });

    expect(confirmMutation(initial, 'unknown-mutation', canonical)).toBe(
      initial,
    );

    const pending = beginMutation(initial, {
      clientMutationId: 'settled-confirmation',
      draft: createDraft('已确认物品'),
      optimisticMovement: createMovement({
        recordId: 'temp:settled-confirmation',
      }),
      startedAt: 100,
    });
    const confirmed = confirmMutation(
      pending,
      'settled-confirmation',
      canonical,
    );

    expect(confirmMutation(confirmed, 'settled-confirmation', canonical)).toBe(
      confirmed,
    );
    expect(
      beginMutation(confirmed, {
        clientMutationId: 'settled-confirmation',
        draft: createDraft('重复覆盖'),
        optimisticMovement: createMovement({ recordId: 'temp:duplicate' }),
        startedAt: 200,
      }),
    ).toBe(confirmed);
  });

  it('rolls back only the failed mutation and preserves its complete draft', () => {
    const firstDraft = createDraft('失败物品');
    const secondDraft = createDraft('保留物品');
    const first = beginMutation(
      createInitialInventoryInboundState<TestDraft>(),
      {
        clientMutationId: 'concurrent-1',
        draft: firstDraft,
        optimisticMovement: createMovement({
          recordId: 'temp:concurrent-1',
        }),
        startedAt: 100,
      },
    );
    const second = beginMutation(first, {
      clientMutationId: 'concurrent-2',
      draft: secondDraft,
      optimisticMovement: createMovement({
        recordId: 'temp:concurrent-2',
      }),
      startedAt: 200,
    });
    const error = new Error('外部数据源写入失败');

    const result = failMutation(second, 'concurrent-1', error);

    expect(result.pendingMutations.has('concurrent-1')).toBe(false);
    expect(result.pendingMutations.has('concurrent-2')).toBe(true);
    expect(result.lastFailed).toEqual({
      clientMutationId: 'concurrent-1',
      draft: firstDraft,
      error,
    });
    expect(
      selectVisibleMovementResponse(result)?.items.map(
        (movement) => movement.recordId,
      ),
    ).toEqual(['temp:concurrent-2']);
  });

  it('handles concurrent mutations that settle out of order', () => {
    const first = beginMutation(
      createInitialInventoryInboundState<TestDraft>(),
      {
        clientMutationId: 'order-1',
        draft: createDraft('先提交'),
        optimisticMovement: createMovement({ recordId: 'temp:order-1' }),
        startedAt: 100,
      },
    );
    const bothPending = beginMutation(first, {
      clientMutationId: 'order-2',
      draft: createDraft('后提交'),
      optimisticMovement: createMovement({ recordId: 'temp:order-2' }),
      startedAt: 200,
    });

    const secondConfirmed = confirmMutation(
      bothPending,
      'order-2',
      createMovement({ recordId: 'real:order-2' }),
    );
    const firstFailed = failMutation(
      secondConfirmed,
      'order-1',
      new Error('第一个请求失败'),
    );

    expect(firstFailed.pendingMutations.size).toBe(0);
    expect(firstFailed.confirmedOverlays.has('order-2')).toBe(true);
    expect(
      selectVisibleMovementResponse(firstFailed)?.items.map(
        (movement) => movement.recordId,
      ),
    ).toEqual(['real:order-2']);
  });

  it('ignores an older movement query response', () => {
    const initial = createInitialInventoryInboundState<TestDraft>();
    const latestResponse = createMovementResponse([
      createMovement({ recordId: 'latest-movement' }),
    ]);
    const latest = mergeMovementQueryResult(initial, latestResponse, 8);

    const result = mergeMovementQueryResult(
      latest,
      createMovementResponse([createMovement({ recordId: 'stale-movement' })]),
      7,
    );

    expect(result).toBe(latest);
    expect(result.latestMovementRequestId).toBe(8);
    expect(result.baseMovementResponse).toBe(latestResponse);
  });

  it('optimistically removes a purchase and restores its snapshot at the original index on failure', () => {
    const purchaseA = createPurchase('exec-a');
    const purchaseB = createPurchase('exec-b');
    const purchaseC = createPurchase('exec-c');
    const initial = createInitialInventoryInboundState<TestDraft>({
      pendingPurchases: [purchaseA, purchaseB, purchaseC],
    });
    const draft = createDraft('采购失败物品', 'purchase');
    const pending = beginMutation(initial, {
      clientMutationId: 'purchase-fail-1',
      draft,
      optimisticMovement: createMovement({
        recordId: 'temp:purchase-fail-1',
      }),
      startedAt: 100,
      purchaseExecutionRecordId: 'exec-b',
    });

    expect(
      pending.basePendingPurchases.map((item) => item.executionRecordId),
    ).toEqual(['exec-a', 'exec-c']);
    expect(pending.pendingMutations.get('purchase-fail-1')).toMatchObject({
      purchaseExecutionRecordId: 'exec-b',
      purchaseSnapshot: purchaseB,
      purchaseIndex: 1,
    });

    const refreshed = mergePurchaseQueryResult(
      pending,
      [purchaseA, purchaseB, purchaseC],
      1,
    );
    const error = new Error('采购入库失败');
    const failed = failMutation(refreshed, 'purchase-fail-1', error);
    const duplicateFailure = failMutation(failed, 'purchase-fail-1', error);
    const retried = beginMutation(failed, {
      clientMutationId: 'purchase-fail-1',
      draft,
      optimisticMovement: createMovement({
        recordId: 'temp:purchase-fail-retry',
      }),
      startedAt: 200,
      purchaseExecutionRecordId: 'exec-b',
    });

    expect(
      failed.basePendingPurchases.map((item) => item.executionRecordId),
    ).toEqual(['exec-a', 'exec-b', 'exec-c']);
    expect(failed.lastFailed).toEqual({
      clientMutationId: 'purchase-fail-1',
      draft,
      error,
      purchaseExecutionRecordId: 'exec-b',
      purchaseSnapshot: purchaseB,
      purchaseIndex: 1,
    });
    expect(duplicateFailure).toBe(failed);
    expect(retried.pendingMutations.has('purchase-fail-1')).toBe(true);
    expect(retried.settledMutationIds.has('purchase-fail-1')).toBe(false);
    expect(retried.lastFailed).toBeNull();
    expect(
      retried.basePendingPurchases.map((item) => item.executionRecordId),
    ).toEqual(['exec-a', 'exec-c']);
  });

  it('keeps confirmed purchase executions removed from refreshed pending purchases', () => {
    const purchase = createPurchase('exec-confirmed');
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>({
        pendingPurchases: [purchase],
      }),
      {
        clientMutationId: 'purchase-confirmed-1',
        draft: createDraft('采购成功物品', 'purchase'),
        optimisticMovement: createMovement({
          recordId: 'temp:purchase-confirmed-1',
        }),
        startedAt: 100,
        purchaseExecutionRecordId: 'exec-confirmed',
      },
    );
    const confirmed = confirmMutation(
      pending,
      'purchase-confirmed-1',
      createMovement({ recordId: 'real:purchase-confirmed-1' }),
    );

    const result = mergePurchaseQueryResult(confirmed, [purchase], 1);

    expect(result.basePendingPurchases).toEqual([]);
    expect(result.confirmedOverlays.get('purchase-confirmed-1')).toMatchObject({
      purchaseExecutionRecordId: 'exec-confirmed',
      purchaseSnapshot: purchase,
    });
  });

  it('keeps a settled purchase execution hidden and rejects a new mutation for it', () => {
    const purchase = createPurchase('exec-settled-purchase');
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>({
        pendingPurchases: [purchase],
      }),
      {
        clientMutationId: 'purchase-settled-a',
        draft: createDraft('采购已结算', 'purchase'),
        optimisticMovement: createMovement({
          recordId: 'temp:purchase-settled-a',
        }),
        startedAt: 100,
        purchaseExecutionRecordId: 'exec-settled-purchase',
      },
    );
    const canonical = createMovement({
      recordId: 'real:purchase-settled-a',
    });
    const confirmed = confirmMutation(pending, 'purchase-settled-a', canonical);
    const reconciled = mergeMovementQueryResult(
      confirmed,
      createMovementResponse([
        {
          ...canonical,
          clientMutationId: 'purchase-settled-a',
        },
      ]),
      1,
    );
    const stalePurchaseQuery = mergePurchaseQueryResult(
      reconciled,
      [purchase],
      1,
    );

    const duplicateExecution = beginMutation(stalePurchaseQuery, {
      clientMutationId: 'purchase-settled-b',
      draft: createDraft('采购重复提交', 'purchase'),
      optimisticMovement: createMovement({
        recordId: 'temp:purchase-settled-b',
      }),
      startedAt: 200,
      purchaseExecutionRecordId: 'exec-settled-purchase',
    });

    expect(reconciled.confirmedOverlays.size).toBe(0);
    expect(
      reconciled.settledPurchaseExecutionIds.has('exec-settled-purchase'),
    ).toBe(true);
    expect(stalePurchaseQuery.basePendingPurchases).toEqual([]);
    expect(duplicateExecution).toBe(stalePurchaseQuery);
  });

  it('ignores a late failure after a mutation is confirmed', () => {
    const purchase = createPurchase('exec-compensated');
    const draft = createDraft('采购补偿物品', 'purchase');
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>({
        pendingPurchases: [purchase],
      }),
      {
        clientMutationId: 'purchase-compensated-1',
        draft,
        optimisticMovement: createMovement({
          recordId: 'temp:purchase-compensated-1',
        }),
        startedAt: 100,
        purchaseExecutionRecordId: 'exec-compensated',
      },
    );
    const confirmed = confirmMutation(
      pending,
      'purchase-compensated-1',
      createMovement({ recordId: 'real:purchase-compensated-1' }),
    );
    const error = new Error('后端显式补偿');

    const lateFailure = failMutation(
      confirmed,
      'purchase-compensated-1',
      error,
    );

    expect(lateFailure).toBe(confirmed);
    expect(lateFailure.confirmedOverlays.has('purchase-compensated-1')).toBe(
      true,
    );
    expect(lateFailure.basePendingPurchases).toEqual([]);
    expect(lateFailure.lastFailed).toBeNull();
    expect(lateFailure.settledMutationIds.has('purchase-compensated-1')).toBe(
      true,
    );
    expect(
      lateFailure.settledPurchaseExecutionIds.has('exec-compensated'),
    ).toBe(true);
  });

  it('ignores a late failure after the confirmed overlay is reconciled', () => {
    const purchase = createPurchase('exec-reconciled-failure');
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>({
        pendingPurchases: [purchase],
      }),
      {
        clientMutationId: 'purchase-reconciled-failure',
        draft: createDraft('采购已追平', 'purchase'),
        optimisticMovement: createMovement({
          recordId: 'temp:purchase-reconciled-failure',
        }),
        startedAt: 100,
        purchaseExecutionRecordId: 'exec-reconciled-failure',
      },
    );
    const canonical = createMovement({
      recordId: 'real:purchase-reconciled-failure',
      clientMutationId: 'purchase-reconciled-failure',
    });
    const confirmed = confirmMutation(
      pending,
      'purchase-reconciled-failure',
      canonical,
    );
    const reconciled = mergeMovementQueryResult(
      confirmed,
      createMovementResponse([canonical]),
      1,
    );

    const lateFailure = failMutation(
      reconciled,
      'purchase-reconciled-failure',
      new Error('迟到失败'),
    );

    expect(reconciled.confirmedOverlays.size).toBe(0);
    expect(lateFailure).toBe(reconciled);
    expect(lateFailure.basePendingPurchases).toEqual([]);
    expect(lateFailure.lastFailed).toBeNull();
    expect(
      lateFailure.settledMutationIds.has('purchase-reconciled-failure'),
    ).toBe(true);
    expect(
      lateFailure.settledPurchaseExecutionIds.has('exec-reconciled-failure'),
    ).toBe(true);
  });

  it('does not fabricate a purchase snapshot when the execution is absent', () => {
    const existing = createPurchase('exec-existing');
    const initial = createInitialInventoryInboundState<TestDraft>({
      pendingPurchases: [existing],
    });

    const result = beginMutation(initial, {
      clientMutationId: 'purchase-missing-1',
      draft: createDraft('缺失采购', 'purchase'),
      optimisticMovement: createMovement({
        recordId: 'temp:purchase-missing-1',
      }),
      startedAt: 100,
      purchaseExecutionRecordId: 'exec-missing',
    });

    expect(result.basePendingPurchases).toEqual([existing]);
    expect(result.pendingMutations.get('purchase-missing-1')).toMatchObject({
      purchaseExecutionRecordId: 'exec-missing',
    });
    expect(
      result.pendingMutations.get('purchase-missing-1')?.purchaseSnapshot,
    ).toBeUndefined();
    expect(
      result.pendingMutations.get('purchase-missing-1')?.purchaseIndex,
    ).toBeUndefined();
  });

  it('restores concurrent purchase failures in original order regardless of response order', () => {
    const purchases = [
      createPurchase('exec-a'),
      createPurchase('exec-b'),
      createPurchase('exec-c'),
      createPurchase('exec-d'),
    ];
    const first = beginMutation(
      createInitialInventoryInboundState<TestDraft>({
        pendingPurchases: purchases,
      }),
      {
        clientMutationId: 'purchase-order-a',
        draft: createDraft('采购 A', 'purchase'),
        optimisticMovement: createMovement({
          recordId: 'temp:purchase-order-a',
        }),
        startedAt: 100,
        purchaseExecutionRecordId: 'exec-a',
      },
    );
    const second = beginMutation(first, {
      clientMutationId: 'purchase-order-b',
      draft: createDraft('采购 B', 'purchase'),
      optimisticMovement: createMovement({
        recordId: 'temp:purchase-order-b',
      }),
      startedAt: 200,
      purchaseExecutionRecordId: 'exec-b',
    });

    const secondFailed = failMutation(
      second,
      'purchase-order-b',
      new Error('B 失败'),
    );
    const bothFailed = failMutation(
      secondFailed,
      'purchase-order-a',
      new Error('A 失败'),
    );

    expect(
      bothFailed.basePendingPurchases.map(
        (purchase) => purchase.executionRecordId,
      ),
    ).toEqual(['exec-a', 'exec-b', 'exec-c', 'exec-d']);
  });

  it('ignores an older purchase query response independently of movement queries', () => {
    const initial = mergeMovementQueryResult(
      createInitialInventoryInboundState<TestDraft>(),
      createMovementResponse([createMovement({ recordId: 'latest-movement' })]),
      20,
    );
    const latestPurchases = [createPurchase('exec-latest')];
    const latest = mergePurchaseQueryResult(initial, latestPurchases, 5);

    const result = mergePurchaseQueryResult(
      latest,
      [createPurchase('exec-stale')],
      4,
    );

    expect(result).toBe(latest);
    expect(result.latestPurchaseRequestId).toBe(5);
    expect(result.latestMovementRequestId).toBe(20);
    expect(result.basePendingPurchases).toEqual(latestPurchases);
  });

  it('orders overlays, deduplicates query rows, and adjusts totals exactly once', () => {
    const baseMovement = createMovement({
      recordId: 'base-1',
      quantity: 10,
    });
    const initial = createInitialInventoryInboundState<TestDraft>({
      movementResponse: createMovementResponse([baseMovement]),
    });
    const firstPending = beginMutation(initial, {
      clientMutationId: 'summary-pending',
      draft: createDraft('后提交待同步'),
      optimisticMovement: createMovement({
        recordId: 'temp:summary-pending',
        quantity: 3,
      }),
      startedAt: 300,
    });
    const secondPending = beginMutation(firstPending, {
      clientMutationId: 'summary-confirmed',
      draft: createDraft('已确认未追平'),
      optimisticMovement: createMovement({
        recordId: 'temp:summary-confirmed',
        quantity: 4,
      }),
      startedAt: 200,
    });
    const confirmed = confirmMutation(
      secondPending,
      'summary-confirmed',
      createMovement({
        recordId: 'real:summary-confirmed',
        quantity: 4,
      }),
    );

    const beforeQuery = selectVisibleMovementResponse(confirmed);

    expect(beforeQuery?.items.map((movement) => movement.recordId)).toEqual([
      'temp:summary-pending',
      'real:summary-confirmed',
      'base-1',
    ]);
    expect(beforeQuery).toMatchObject({
      total: 3,
      summary: {
        totalRecords: 3,
        totalQuantity: 17,
      },
    });

    const caughtUp = mergeMovementQueryResult(
      confirmed,
      createMovementResponse([
        baseMovement,
        createMovement({
          recordId: 'real:summary-confirmed',
          clientMutationId: 'summary-confirmed',
          quantity: 4,
        }),
        createMovement({
          recordId: 'query-copy-of-pending',
          clientMutationId: 'summary-pending',
          quantity: 3,
        }),
      ]),
      1,
    );
    const afterQuery = selectVisibleMovementResponse(caughtUp);

    expect(afterQuery?.items.map((movement) => movement.recordId)).toEqual([
      'base-1',
      'real:summary-confirmed',
      'query-copy-of-pending',
    ]);
    expect(caughtUp.pendingMutations.has('summary-pending')).toBe(false);
    expect(caughtUp.settledMutationIds.has('summary-pending')).toBe(true);
    expect(afterQuery).toMatchObject({
      total: 3,
      summary: {
        totalRecords: 3,
        totalQuantity: 17,
      },
    });
  });

  it('hides out-of-scope overlays without discarding their reconciliation state', () => {
    const baseMovement = createMovement({
      recordId: 'base-a',
      building: 'A楼',
      quantity: 5,
    });
    const initial = createInitialInventoryInboundState<TestDraft>({
      movementResponse: createMovementResponse([baseMovement]),
    });
    const withPending = beginMutation(initial, {
      clientMutationId: 'pending-b',
      draft: createDraft('B楼待同步'),
      optimisticMovement: createMovement({
        recordId: 'temp:pending-b',
        building: 'B楼',
        quantity: 2,
      }),
      startedAt: 200,
    });
    const withSecondPending = beginMutation(withPending, {
      clientMutationId: 'confirmed-c',
      draft: createDraft('C楼已确认'),
      optimisticMovement: createMovement({
        recordId: 'temp:confirmed-c',
        building: 'C楼',
        quantity: 3,
      }),
      startedAt: 100,
    });
    const confirmed = confirmMutation(
      withSecondPending,
      'confirmed-c',
      createMovement({
        recordId: 'real:confirmed-c',
        building: 'C楼',
        quantity: 3,
      }),
    );

    const visible = selectVisibleMovementResponse(
      confirmed,
      (movement) => movement.building === 'A楼',
    );

    expect(visible?.items.map((movement) => movement.recordId)).toEqual([
      'base-a',
    ]);
    expect(visible).toMatchObject({
      total: 1,
      summary: {
        totalRecords: 1,
        totalQuantity: 5,
      },
    });
    expect(confirmed.pendingMutations.has('pending-b')).toBe(true);
    expect(confirmed.confirmedOverlays.has('confirmed-c')).toBe(true);
  });

  it('shadows a stale pending outbound row after an optimistic confirmation leaves the active filter', () => {
    const pendingOutbound = createMovement({
      recordId: 'outbound-pending-1',
      type: 'outbound',
      status: '待库房确认',
      clientMutationId: 'outbound-create-1',
      quantity: 2,
    });
    const initial = createInitialInventoryInboundState<TestDraft>({
      movementResponse: createMovementResponse([pendingOutbound], {
        summary: {
          totalRecords: 1,
          totalQuantity: 2,
          overdueItems: 0,
          statusCounts: [{ status: '待库房确认', count: 1 }],
        },
      }),
    });
    const confirming = beginMutation(initial, {
      clientMutationId: 'outbound-confirm-1',
      draft: createDraft('确认出库'),
      optimisticMovement: {
        ...pendingOutbound,
        status: '已出库',
      },
      startedAt: 100,
    });

    const pendingOnly = selectVisibleMovementResponse(
      confirming,
      (movement) => movement.status === '待库房确认',
    );
    const allStatuses = selectVisibleMovementResponse(confirming);

    expect(pendingOnly).toMatchObject({
      items: [],
      total: 0,
      summary: {
        totalRecords: 0,
        totalQuantity: 0,
      },
    });
    expect(allStatuses?.items).toHaveLength(1);
    expect(allStatuses?.items[0]).toMatchObject({
      recordId: 'outbound-pending-1',
      status: '已出库',
      pendingSync: true,
    });
  });

  it('does not mutate query responses, submissions, or purchase arrays', () => {
    const baseMovement = createMovement({ recordId: 'immutable-base' });
    const movementResponse = createMovementResponse([baseMovement]);
    const movementSnapshot = JSON.parse(
      JSON.stringify(movementResponse),
    ) as InventoryMovementsResponse;
    const optimisticMovement = createMovement({
      recordId: 'temp:immutable',
      clientMutationId: 'original-id',
      pendingSync: false,
    });
    const optimisticSnapshot = { ...optimisticMovement };
    const purchases = [
      createPurchase('immutable-a'),
      createPurchase('immutable-b'),
    ];
    const purchaseSnapshot = purchases.map((purchase) => ({ ...purchase }));
    const initial = createInitialInventoryInboundState<TestDraft>({
      movementResponse,
      pendingPurchases: purchases,
    });

    const pending = beginMutation(initial, {
      clientMutationId: 'immutable-mutation',
      draft: createDraft('不可变测试', 'purchase'),
      optimisticMovement,
      startedAt: 100,
      purchaseExecutionRecordId: 'immutable-a',
    });
    const merged = mergeMovementQueryResult(pending, movementResponse, 1);
    selectVisibleMovementResponse(merged);

    expect(movementResponse).toEqual(movementSnapshot);
    expect(optimisticMovement).toEqual(optimisticSnapshot);
    expect(purchases).toEqual(purchaseSnapshot);
  });

  it('merges a large base array without losing or double-counting overlays', () => {
    const baseItems = Array.from({ length: 2_000 }, (_value, index) =>
      createMovement({
        recordId: `large-base-${index}`,
        sku: `LARGE-${index}`,
        quantity: 1,
      }),
    );
    let state = createInitialInventoryInboundState<TestDraft>({
      movementResponse: createMovementResponse(baseItems, {
        pageSize: 2_000,
        totalPages: 1,
      }),
    });
    for (let index = 0; index < 100; index += 1) {
      state = beginMutation(state, {
        clientMutationId: `large-pending-${index}`,
        draft: createDraft(`大数组-${index}`),
        optimisticMovement: createMovement({
          recordId: `temp:large-${index}`,
          quantity: 2,
        }),
        startedAt: index,
      });
    }

    const visible = selectVisibleMovementResponse(state);

    expect(visible?.items).toHaveLength(2_100);
    expect(visible).toMatchObject({
      total: 2_100,
      summary: {
        totalRecords: 2_100,
        totalQuantity: 2_200,
      },
    });
    expect(visible?.items[0].clientMutationId).toBe('large-pending-99');
  });

  it('reconciles a pending overlay when an authoritative query returns the same mutation id', () => {
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>(),
      {
        clientMutationId: 'outbound-query-settled',
        draft: createDraft('出库权威命中'),
        optimisticMovement: createMovement({
          recordId: 'pending:outbound-query-settled',
          type: 'outbound',
          status: '同步中',
        }),
        startedAt: 100,
      },
    );
    const authoritative = createMovement({
      recordId: 'outbound-record-query-settled',
      clientMutationId: 'outbound-query-settled',
      type: 'outbound',
      status: '已出库',
      pendingSync: false,
    });

    const reconciled = mergeMovementQueryResult(
      pending,
      createMovementResponse([authoritative]),
      1,
    );
    const visible = selectVisibleMovementResponse(reconciled);

    expect(reconciled.pendingMutations.has('outbound-query-settled')).toBe(
      false,
    );
    expect(reconciled.settledMutationIds.has('outbound-query-settled')).toBe(
      true,
    );
    expect(visible?.items).toEqual([authoritative]);
  });

  it('keeps an unresolved pending overlay when an authoritative query does not contain it', () => {
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>(),
      {
        clientMutationId: 'outbound-query-missing',
        draft: createDraft('出库查询缺失'),
        optimisticMovement: createMovement({
          recordId: 'pending:outbound-query-missing',
          type: 'outbound',
          status: '同步中',
        }),
        startedAt: 100,
      },
    );

    const reconciled = mergeMovementQueryResult(
      pending,
      createMovementResponse([]),
      1,
    );

    expect(reconciled.pendingMutations.has('outbound-query-missing')).toBe(
      true,
    );
    expect(selectVisibleMovementResponse(reconciled)?.items[0]).toMatchObject({
      recordId: 'pending:outbound-query-missing',
      pendingSync: true,
    });
  });

  it('does not let repeated queries or a late failure remove a reconciled authoritative row', () => {
    const pending = beginMutation(
      createInitialInventoryInboundState<TestDraft>(),
      {
        clientMutationId: 'outbound-query-stable',
        draft: createDraft('出库迟到失败'),
        optimisticMovement: createMovement({
          recordId: 'pending:outbound-query-stable',
          type: 'outbound',
          status: '同步中',
        }),
        startedAt: 100,
      },
    );
    const authoritative = createMovement({
      recordId: 'outbound-record-query-stable',
      clientMutationId: 'outbound-query-stable',
      type: 'outbound',
      status: '待库房确认',
      pendingSync: false,
    });
    const first = mergeMovementQueryResult(
      pending,
      createMovementResponse([authoritative]),
      1,
    );
    const repeated = mergeMovementQueryResult(
      first,
      createMovementResponse([authoritative]),
      2,
    );
    const lateFailure = failMutation(
      repeated,
      'outbound-query-stable',
      new Error('迟到失败'),
    );

    expect(selectVisibleMovementResponse(lateFailure)?.items).toEqual([
      authoritative,
    ]);
    expect(lateFailure.lastFailed).toBeNull();
  });
});
