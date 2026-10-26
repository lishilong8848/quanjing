import type {
  InventoryMovementItem,
  InventoryMovementsResponse,
  PurchasePendingInboundItem,
} from '@shared/inventory-management.interface';

const MAX_CONFIRMED_INBOUND_OVERLAYS = 100;
const MAX_SETTLED_INBOUND_MUTATIONS = 500;
const MAX_SETTLED_PURCHASE_EXECUTIONS = 500;

export interface InventoryInboundMutationSubmission<TDraft> {
  clientMutationId: string;
  draft: TDraft;
  optimisticMovement: InventoryMovementItem;
  startedAt: number;
  purchaseExecutionRecordId?: string;
}

export interface InventoryInboundMutationContext<TDraft> {
  clientMutationId: string;
  draft: TDraft;
  startedAt: number;
  purchaseExecutionRecordId?: string;
  purchaseSnapshot?: PurchasePendingInboundItem;
  purchaseIndex?: number;
}

export interface PendingInventoryInboundMutation<
  TDraft,
> extends InventoryInboundMutationContext<TDraft> {
  optimisticMovement: InventoryMovementItem;
}

export interface ConfirmedInventoryInboundOverlay<
  TDraft,
> extends InventoryInboundMutationContext<TDraft> {
  movement: InventoryMovementItem;
  movementQueryWatermark: number;
}

export interface FailedInventoryInboundMutation<TDraft> {
  clientMutationId: string;
  draft: TDraft;
  error: unknown;
  purchaseExecutionRecordId?: string;
  purchaseSnapshot?: PurchasePendingInboundItem;
  purchaseIndex?: number;
}

export interface InventoryInboundOptimisticState<TDraft> {
  baseMovementResponse: InventoryMovementsResponse | null;
  pendingMutations: ReadonlyMap<
    string,
    PendingInventoryInboundMutation<TDraft>
  >;
  confirmedOverlays: ReadonlyMap<
    string,
    ConfirmedInventoryInboundOverlay<TDraft>
  >;
  settledMutationIds: ReadonlySet<string>;
  settledPurchaseExecutionIds: ReadonlySet<string>;
  basePendingPurchases: readonly PurchasePendingInboundItem[];
  latestMovementRequestId: number;
  latestPurchaseRequestId: number;
  lastFailed: FailedInventoryInboundMutation<TDraft> | null;
}

export interface InitialInventoryInboundStateOptions {
  movementResponse?: InventoryMovementsResponse | null;
  pendingPurchases?: readonly PurchasePendingInboundItem[];
}

export function createInitialInventoryInboundState<TDraft>(
  options: InitialInventoryInboundStateOptions = {},
): InventoryInboundOptimisticState<TDraft> {
  return {
    baseMovementResponse: options.movementResponse ?? null,
    pendingMutations: new Map(),
    confirmedOverlays: new Map(),
    settledMutationIds: new Set(),
    settledPurchaseExecutionIds: new Set(),
    basePendingPurchases: [...(options.pendingPurchases ?? [])],
    latestMovementRequestId: 0,
    latestPurchaseRequestId: 0,
    lastFailed: null,
  };
}

function copyMutationContext<TDraft>(
  mutation: InventoryInboundMutationContext<TDraft>,
): InventoryInboundMutationContext<TDraft> {
  return {
    clientMutationId: mutation.clientMutationId,
    draft: mutation.draft,
    startedAt: mutation.startedAt,
    ...(mutation.purchaseExecutionRecordId === undefined
      ? {}
      : {
          purchaseExecutionRecordId: mutation.purchaseExecutionRecordId,
        }),
    ...(mutation.purchaseSnapshot === undefined
      ? {}
      : { purchaseSnapshot: mutation.purchaseSnapshot }),
    ...(mutation.purchaseIndex === undefined
      ? {}
      : { purchaseIndex: mutation.purchaseIndex }),
  };
}

function addBoundedValue<T>(
  values: ReadonlySet<T>,
  value: T,
  limit: number,
): ReadonlySet<T> {
  const next = new Set(values);
  next.delete(value);
  next.add(value);
  while (next.size > limit) {
    const oldest = next.values().next().value as T | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function collectHiddenPurchaseIndexes<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
): number[] {
  const indexes: number[] = [];
  for (const mutation of state.pendingMutations.values()) {
    if (mutation.purchaseIndex !== undefined) {
      indexes.push(mutation.purchaseIndex);
    }
  }
  for (const mutation of state.confirmedOverlays.values()) {
    if (mutation.purchaseIndex !== undefined) {
      indexes.push(mutation.purchaseIndex);
    }
  }
  return indexes.sort((left, right) => left - right);
}

function resolveOriginalPurchaseIndex<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  visibleIndex: number,
): number {
  let originalIndex = visibleIndex;
  for (const hiddenIndex of collectHiddenPurchaseIndexes(state)) {
    if (hiddenIndex > originalIndex) {
      break;
    }
    originalIndex += 1;
  }
  return originalIndex;
}

function hasPurchaseExecutionMutation<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  purchaseExecutionRecordId: string,
): boolean {
  if (state.settledPurchaseExecutionIds.has(purchaseExecutionRecordId)) {
    return true;
  }
  for (const mutation of state.pendingMutations.values()) {
    if (mutation.purchaseExecutionRecordId === purchaseExecutionRecordId) {
      return true;
    }
  }
  for (const mutation of state.confirmedOverlays.values()) {
    if (mutation.purchaseExecutionRecordId === purchaseExecutionRecordId) {
      return true;
    }
  }
  return false;
}

export function beginMutation<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  submission: InventoryInboundMutationSubmission<TDraft>,
): InventoryInboundOptimisticState<TDraft> {
  if (
    state.pendingMutations.has(submission.clientMutationId) ||
    state.confirmedOverlays.has(submission.clientMutationId) ||
    state.settledMutationIds.has(submission.clientMutationId) ||
    (submission.purchaseExecutionRecordId !== undefined &&
      hasPurchaseExecutionMutation(state, submission.purchaseExecutionRecordId))
  ) {
    return state;
  }

  const purchaseIndex =
    submission.purchaseExecutionRecordId === undefined
      ? -1
      : state.basePendingPurchases.findIndex(
          (purchase) =>
            purchase.executionRecordId === submission.purchaseExecutionRecordId,
        );
  const purchaseSnapshot =
    purchaseIndex < 0 ? undefined : state.basePendingPurchases[purchaseIndex];
  const originalPurchaseIndex =
    purchaseIndex < 0
      ? undefined
      : resolveOriginalPurchaseIndex(state, purchaseIndex);
  const optimisticMovement: InventoryMovementItem = {
    ...submission.optimisticMovement,
    clientMutationId: submission.clientMutationId,
    pendingSync: true,
  };
  const pendingMutation: PendingInventoryInboundMutation<TDraft> = {
    clientMutationId: submission.clientMutationId,
    draft: submission.draft,
    optimisticMovement,
    startedAt: submission.startedAt,
    ...(submission.purchaseExecutionRecordId === undefined
      ? {}
      : {
          purchaseExecutionRecordId: submission.purchaseExecutionRecordId,
        }),
    ...(purchaseSnapshot === undefined
      ? {}
      : {
          purchaseSnapshot,
          purchaseIndex: originalPurchaseIndex,
        }),
  };
  const pendingMutations = new Map(state.pendingMutations);
  pendingMutations.set(submission.clientMutationId, pendingMutation);

  return {
    ...state,
    pendingMutations,
    basePendingPurchases:
      purchaseIndex < 0
        ? state.basePendingPurchases
        : [
            ...state.basePendingPurchases.slice(0, purchaseIndex),
            ...state.basePendingPurchases.slice(purchaseIndex + 1),
          ],
    lastFailed:
      state.lastFailed?.clientMutationId === submission.clientMutationId
        ? null
        : state.lastFailed,
  };
}

export function confirmMutation<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  clientMutationId: string,
  canonicalMovement: InventoryMovementItem,
  movementQueryWatermark = state.latestMovementRequestId,
): InventoryInboundOptimisticState<TDraft> {
  const pendingMutation = state.pendingMutations.get(clientMutationId);
  if (!pendingMutation) {
    return state;
  }

  const pendingMutations = new Map(state.pendingMutations);
  pendingMutations.delete(clientMutationId);
  const confirmedOverlays = new Map(state.confirmedOverlays);
  confirmedOverlays.set(clientMutationId, {
    ...copyMutationContext(pendingMutation),
    movementQueryWatermark: Math.max(
      state.latestMovementRequestId,
      movementQueryWatermark,
    ),
    movement: {
      ...canonicalMovement,
      clientMutationId,
      pendingSync: false,
    },
  });
  while (confirmedOverlays.size > MAX_CONFIRMED_INBOUND_OVERLAYS) {
    const oldestMutationId = confirmedOverlays.keys().next().value as
      | string
      | undefined;
    if (oldestMutationId === undefined) break;
    confirmedOverlays.delete(oldestMutationId);
  }
  const settledMutationIds = addBoundedValue(
    state.settledMutationIds,
    clientMutationId,
    MAX_SETTLED_INBOUND_MUTATIONS,
  );
  let settledPurchaseExecutionIds: ReadonlySet<string> =
    state.settledPurchaseExecutionIds;
  if (pendingMutation.purchaseExecutionRecordId !== undefined) {
    settledPurchaseExecutionIds = addBoundedValue(
      state.settledPurchaseExecutionIds,
      pendingMutation.purchaseExecutionRecordId,
      MAX_SETTLED_PURCHASE_EXECUTIONS,
    );
  }

  return {
    ...state,
    pendingMutations,
    confirmedOverlays,
    settledMutationIds,
    settledPurchaseExecutionIds,
  };
}

function restorePurchaseSnapshot<TDraft>(
  purchases: readonly PurchasePendingInboundItem[],
  mutation: InventoryInboundMutationContext<TDraft>,
  remainingMutations: readonly InventoryInboundMutationContext<TDraft>[],
): readonly PurchasePendingInboundItem[] {
  if (
    mutation.purchaseSnapshot === undefined ||
    mutation.purchaseIndex === undefined
  ) {
    return purchases;
  }
  if (
    purchases.some(
      (purchase) =>
        purchase.executionRecordId ===
        mutation.purchaseSnapshot?.executionRecordId,
    )
  ) {
    return purchases;
  }

  const hiddenItemsBeforeSnapshot = remainingMutations.reduce(
    (count, remaining) =>
      remaining.purchaseIndex !== undefined &&
      remaining.purchaseIndex < mutation.purchaseIndex!
        ? count + 1
        : count,
    0,
  );
  const insertionIndex = Math.max(
    0,
    Math.min(
      purchases.length,
      mutation.purchaseIndex - hiddenItemsBeforeSnapshot,
    ),
  );
  return [
    ...purchases.slice(0, insertionIndex),
    mutation.purchaseSnapshot,
    ...purchases.slice(insertionIndex),
  ];
}

export function failMutation<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  clientMutationId: string,
  error: unknown,
): InventoryInboundOptimisticState<TDraft> {
  const failedMutation = state.pendingMutations.get(clientMutationId);
  if (!failedMutation) {
    return state;
  }

  const pendingMutations = new Map(state.pendingMutations);
  pendingMutations.delete(clientMutationId);
  const remainingMutations: InventoryInboundMutationContext<TDraft>[] = [
    ...pendingMutations.values(),
    ...state.confirmedOverlays.values(),
  ];
  const basePendingPurchases = restorePurchaseSnapshot(
    state.basePendingPurchases,
    failedMutation,
    remainingMutations,
  );

  return {
    ...state,
    pendingMutations,
    basePendingPurchases,
    lastFailed: {
      clientMutationId,
      draft: failedMutation.draft,
      error,
      ...(failedMutation.purchaseExecutionRecordId === undefined
        ? {}
        : {
            purchaseExecutionRecordId: failedMutation.purchaseExecutionRecordId,
          }),
      ...(failedMutation.purchaseSnapshot === undefined
        ? {}
        : { purchaseSnapshot: failedMutation.purchaseSnapshot }),
      ...(failedMutation.purchaseIndex === undefined
        ? {}
        : { purchaseIndex: failedMutation.purchaseIndex }),
    },
  };
}

export function mergeMovementQueryResult<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  response: InventoryMovementsResponse,
  requestId: number,
): InventoryInboundOptimisticState<TDraft> {
  if (requestId < state.latestMovementRequestId) {
    return state;
  }

  const authoritativeMutationIds = new Set(
    response.items.flatMap((movement) =>
      movement.clientMutationId ? [movement.clientMutationId] : [],
    ),
  );
  let pendingMutations = state.pendingMutations;
  let settledMutationIds = state.settledMutationIds;
  let settledPurchaseExecutionIds = state.settledPurchaseExecutionIds;
  for (const [clientMutationId, mutation] of state.pendingMutations) {
    if (!authoritativeMutationIds.has(clientMutationId)) continue;
    if (pendingMutations === state.pendingMutations) {
      pendingMutations = new Map(state.pendingMutations);
    }
    (
      pendingMutations as Map<string, PendingInventoryInboundMutation<TDraft>>
    ).delete(clientMutationId);
    settledMutationIds = addBoundedValue(
      settledMutationIds,
      clientMutationId,
      MAX_SETTLED_INBOUND_MUTATIONS,
    );
    if (mutation.purchaseExecutionRecordId !== undefined) {
      settledPurchaseExecutionIds = addBoundedValue(
        settledPurchaseExecutionIds,
        mutation.purchaseExecutionRecordId,
        MAX_SETTLED_PURCHASE_EXECUTIONS,
      );
    }
  }

  let confirmedOverlays = state.confirmedOverlays;
  for (const [clientMutationId, overlay] of state.confirmedOverlays) {
    if (
      requestId <= overlay.movementQueryWatermark ||
      (!authoritativeMutationIds.has(clientMutationId) &&
        !response.items.some(
          (movement) => movement.recordId === overlay.movement.recordId,
        ))
    ) {
      continue;
    }
    if (confirmedOverlays === state.confirmedOverlays) {
      confirmedOverlays = new Map(state.confirmedOverlays);
    }
    (
      confirmedOverlays as Map<string, ConfirmedInventoryInboundOverlay<TDraft>>
    ).delete(clientMutationId);
  }

  return {
    ...state,
    baseMovementResponse: response,
    pendingMutations,
    confirmedOverlays,
    settledMutationIds,
    settledPurchaseExecutionIds,
    latestMovementRequestId: requestId,
  };
}

function collectHiddenPurchaseExecutionIds<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
): Set<string> {
  const hiddenExecutionIds = new Set(state.settledPurchaseExecutionIds);
  for (const mutation of state.pendingMutations.values()) {
    if (mutation.purchaseExecutionRecordId !== undefined) {
      hiddenExecutionIds.add(mutation.purchaseExecutionRecordId);
    }
  }
  for (const mutation of state.confirmedOverlays.values()) {
    if (mutation.purchaseExecutionRecordId !== undefined) {
      hiddenExecutionIds.add(mutation.purchaseExecutionRecordId);
    }
  }
  return hiddenExecutionIds;
}

export function mergePurchaseQueryResult<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  purchases: readonly PurchasePendingInboundItem[],
  requestId: number,
): InventoryInboundOptimisticState<TDraft> {
  if (requestId < state.latestPurchaseRequestId) {
    return state;
  }

  const hiddenExecutionIds = collectHiddenPurchaseExecutionIds(state);
  return {
    ...state,
    basePendingPurchases: purchases.filter(
      (purchase) => !hiddenExecutionIds.has(purchase.executionRecordId),
    ),
    latestPurchaseRequestId: requestId,
  };
}

function compareMutationStart<TDraft>(
  left: InventoryInboundMutationContext<TDraft>,
  right: InventoryInboundMutationContext<TDraft>,
): number {
  const startedAtDifference = right.startedAt - left.startedAt;
  if (startedAtDifference !== 0) {
    return startedAtDifference;
  }
  return left.clientMutationId.localeCompare(right.clientMutationId);
}

function hasSeenMovement(
  movement: InventoryMovementItem,
  seenRecordIds: ReadonlySet<string>,
  seenClientMutationIds: ReadonlySet<string>,
): boolean {
  return (
    seenRecordIds.has(movement.recordId) ||
    (movement.clientMutationId !== undefined &&
      seenClientMutationIds.has(movement.clientMutationId))
  );
}

function rememberMovement(
  movement: InventoryMovementItem,
  seenRecordIds: Set<string>,
  seenClientMutationIds: Set<string>,
): void {
  seenRecordIds.add(movement.recordId);
  if (movement.clientMutationId !== undefined) {
    seenClientMutationIds.add(movement.clientMutationId);
  }
}

export function selectVisibleMovementResponse<TDraft>(
  state: InventoryInboundOptimisticState<TDraft>,
  overlayFilter: (movement: InventoryMovementItem) => boolean = () => true,
): InventoryMovementsResponse | null {
  const baseResponse = state.baseMovementResponse;
  if (
    baseResponse === null &&
    state.pendingMutations.size === 0 &&
    state.confirmedOverlays.size === 0
  ) {
    return null;
  }

  const allPendingMutations = [...state.pendingMutations.values()].sort(
    compareMutationStart,
  );
  const allConfirmedOverlays = [...state.confirmedOverlays.values()].sort(
    compareMutationStart,
  );
  const pendingMutations = allPendingMutations.filter((mutation) =>
    overlayFilter(mutation.optimisticMovement),
  );
  const confirmedOverlays = allConfirmedOverlays.filter((mutation) =>
    overlayFilter(mutation.movement),
  );
  const shadowedRecordIds = new Set<string>();
  const shadowedClientMutationIds = new Set<string>();
  for (const mutation of allPendingMutations) {
    rememberMovement(
      mutation.optimisticMovement,
      shadowedRecordIds,
      shadowedClientMutationIds,
    );
  }
  for (const overlay of allConfirmedOverlays) {
    rememberMovement(
      overlay.movement,
      shadowedRecordIds,
      shadowedClientMutationIds,
    );
  }
  const seenRecordIds = new Set<string>();
  const seenClientMutationIds = new Set<string>();
  const visibleItems: InventoryMovementItem[] = [];
  let overlayQuantity = 0;
  let overlayCount = 0;

  for (const pendingMutation of pendingMutations) {
    const movement = pendingMutation.optimisticMovement;
    if (hasSeenMovement(movement, seenRecordIds, seenClientMutationIds)) {
      continue;
    }
    rememberMovement(movement, seenRecordIds, seenClientMutationIds);
    visibleItems.push(movement);
    overlayCount += 1;
    overlayQuantity += movement.quantity;
  }
  for (const confirmedOverlay of confirmedOverlays) {
    const movement = confirmedOverlay.movement;
    if (hasSeenMovement(movement, seenRecordIds, seenClientMutationIds)) {
      continue;
    }
    rememberMovement(movement, seenRecordIds, seenClientMutationIds);
    visibleItems.push(movement);
    overlayCount += 1;
    overlayQuantity += movement.quantity;
  }

  const baseItems = baseResponse?.items ?? [];
  const baseItemsQuantity = baseItems.reduce(
    (total, movement) => total + movement.quantity,
    0,
  );
  let visibleBaseCount = 0;
  let visibleBaseQuantity = 0;
  for (const movement of baseItems) {
    if (
      hasSeenMovement(movement, shadowedRecordIds, shadowedClientMutationIds) ||
      hasSeenMovement(movement, seenRecordIds, seenClientMutationIds)
    ) {
      continue;
    }
    rememberMovement(movement, seenRecordIds, seenClientMutationIds);
    visibleItems.push(movement);
    visibleBaseCount += 1;
    visibleBaseQuantity += movement.quantity;
  }

  const recordDelta = overlayCount + visibleBaseCount - baseItems.length;
  const quantityDelta =
    overlayQuantity + visibleBaseQuantity - baseItemsQuantity;
  const total = Math.max(0, (baseResponse?.total ?? 0) + recordDelta);
  const totalRecords = Math.max(
    0,
    (baseResponse?.summary.totalRecords ?? 0) + recordDelta,
  );
  const totalQuantity = Math.max(
    0,
    (baseResponse?.summary.totalQuantity ?? 0) + quantityDelta,
  );
  const pageSize = baseResponse?.pageSize ?? Math.max(visibleItems.length, 1);
  const totalPages =
    baseResponse !== null && recordDelta === 0
      ? baseResponse.totalPages
      : pageSize > 0
        ? Math.max(1, Math.ceil(total / pageSize))
        : (baseResponse?.totalPages ?? 1);

  return {
    items: visibleItems,
    total,
    page: baseResponse?.page ?? 1,
    pageSize,
    totalPages,
    summary: {
      totalRecords,
      totalQuantity,
      overdueItems: baseResponse?.summary.overdueItems ?? 0,
      statusCounts: baseResponse?.summary.statusCounts ?? [],
    },
  };
}
