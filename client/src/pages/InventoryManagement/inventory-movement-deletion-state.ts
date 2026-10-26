import type {
  InventoryMovementItem,
  InventoryMovementsResponse,
} from '@shared/inventory-management.interface';

export type InventoryMovementDeletionLocalStatus =
  | 'submitting'
  | 'accepted'
  | 'completed'
  | 'uncertain';

export interface InventoryMovementDeletionTombstone {
  clientMutationId: string;
  movement: InventoryMovementItem;
  originalIndex: number;
  requestWatermark: number;
  startedAt: number;
  updatedAt: number;
  status: InventoryMovementDeletionLocalStatus;
  taskId?: string;
  message?: string;
}

interface InventoryMovementDeletionRestoration {
  clientMutationId: string;
  movement: InventoryMovementItem;
  originalIndex: number;
}

export interface InventoryMovementDeletionState {
  tombstones: ReadonlyMap<string, InventoryMovementDeletionTombstone>;
  restorations: ReadonlyMap<string, InventoryMovementDeletionRestoration>;
}

export interface BeginInventoryMovementDeletionInput {
  clientMutationId: string;
  movement: InventoryMovementItem;
  originalIndex: number;
  requestWatermark: number;
  startedAt: number;
}

export function createInitialInventoryMovementDeletionState(): InventoryMovementDeletionState {
  return {
    tombstones: new Map(),
    restorations: new Map(),
  };
}

export function beginInventoryMovementDeletion(
  state: InventoryMovementDeletionState,
  input: BeginInventoryMovementDeletionInput,
): InventoryMovementDeletionState {
  const existingByMutation = [...state.tombstones.values()].find(
    (entry) => entry.clientMutationId === input.clientMutationId,
  );
  if (existingByMutation) {
    if (existingByMutation.movement.recordId !== input.movement.recordId) {
      throw new Error('删除变更号已被其他记录占用');
    }
    return state;
  }
  if (state.tombstones.has(input.movement.recordId)) {
    throw new Error('该出入库记录正在删除');
  }
  if (
    input.movement.pendingSync ||
    input.movement.recordId.startsWith('pending:')
  ) {
    throw new Error('后台尚未确认的记录不能删除');
  }

  const tombstones = new Map(state.tombstones);
  tombstones.set(input.movement.recordId, {
    clientMutationId: input.clientMutationId,
    movement: { ...input.movement },
    originalIndex: Math.max(0, input.originalIndex),
    requestWatermark: input.requestWatermark,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    status: 'submitting',
  });
  const restorations = new Map(state.restorations);
  restorations.delete(input.movement.recordId);
  return { tombstones, restorations };
}

function updateTombstone(
  state: InventoryMovementDeletionState,
  clientMutationId: string,
  update: (
    tombstone: InventoryMovementDeletionTombstone,
  ) => InventoryMovementDeletionTombstone,
): InventoryMovementDeletionState {
  const entry = [...state.tombstones.entries()].find(
    ([, tombstone]) => tombstone.clientMutationId === clientMutationId,
  );
  if (!entry) return state;
  const tombstones = new Map(state.tombstones);
  tombstones.set(entry[0], update(entry[1]));
  return { ...state, tombstones };
}

export function acceptInventoryMovementDeletion(
  state: InventoryMovementDeletionState,
  clientMutationId: string,
  taskId: string,
  updatedAt: number,
): InventoryMovementDeletionState {
  return updateTombstone(state, clientMutationId, (entry) => ({
    ...entry,
    taskId,
    status: 'accepted',
    updatedAt,
  }));
}

export function completeInventoryMovementDeletion(
  state: InventoryMovementDeletionState,
  clientMutationId: string,
  requestWatermark: number,
  updatedAt: number,
): InventoryMovementDeletionState {
  return updateTombstone(state, clientMutationId, (entry) => ({
    ...entry,
    status: 'completed',
    requestWatermark: Math.max(entry.requestWatermark, requestWatermark),
    updatedAt,
    message: undefined,
  }));
}

export function markInventoryMovementDeletionUncertain(
  state: InventoryMovementDeletionState,
  clientMutationId: string,
  message: string,
  updatedAt: number,
): InventoryMovementDeletionState {
  return updateTombstone(state, clientMutationId, (entry) => ({
    ...entry,
    status: 'uncertain',
    message,
    updatedAt,
  }));
}

export function failInventoryMovementDeletion(
  state: InventoryMovementDeletionState,
  clientMutationId: string,
  _message: string,
): InventoryMovementDeletionState {
  const entry = [...state.tombstones.entries()].find(
    ([, tombstone]) => tombstone.clientMutationId === clientMutationId,
  );
  if (!entry) return state;
  const [recordId, tombstone] = entry;
  const tombstones = new Map(state.tombstones);
  tombstones.delete(recordId);
  const restorations = new Map(state.restorations);
  restorations.set(recordId, {
    clientMutationId,
    movement: { ...tombstone.movement },
    originalIndex: tombstone.originalIndex,
  });
  return { tombstones, restorations };
}

export function mergeInventoryMovementDeletionQueryResult(
  state: InventoryMovementDeletionState,
  response: InventoryMovementsResponse,
  requestWatermark: number,
): InventoryMovementDeletionState {
  let changed = false;
  const responseRecordIds = new Set(
    response.items.map((item) => item.recordId),
  );
  const tombstones = new Map(state.tombstones);
  for (const [recordId, tombstone] of tombstones) {
    if (
      requestWatermark > tombstone.requestWatermark &&
      !responseRecordIds.has(recordId) &&
      tombstone.status === 'completed'
    ) {
      tombstones.delete(recordId);
      changed = true;
    }
  }

  const restorations = new Map(state.restorations);
  for (const recordId of restorations.keys()) {
    if (responseRecordIds.has(recordId)) {
      restorations.delete(recordId);
      changed = true;
    }
  }

  return changed ? { tombstones, restorations } : state;
}

function adjustStatusCounts(
  response: InventoryMovementsResponse,
  removedItems: readonly InventoryMovementItem[],
  restoredItems: readonly InventoryMovementItem[],
): Array<{ status: string; count: number }> {
  const counts = new Map(
    response.summary.statusCounts.map(({ status, count }) => [status, count]),
  );
  for (const item of removedItems) {
    counts.set(item.status, Math.max(0, (counts.get(item.status) ?? 0) - 1));
  }
  for (const item of restoredItems) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count }));
}

export function selectInventoryMovementsAfterDeletion(
  state: InventoryMovementDeletionState,
  response: InventoryMovementsResponse,
): InventoryMovementsResponse {
  const removedItems = response.items.filter((item) =>
    state.tombstones.has(item.recordId),
  );
  const items = response.items.filter(
    (item) => !state.tombstones.has(item.recordId),
  );
  const restoredItems: InventoryMovementItem[] = [];
  const orderedRestorations = [...state.restorations.values()].sort(
    (left, right) => left.originalIndex - right.originalIndex,
  );
  for (const restoration of orderedRestorations) {
    if (items.some((item) => item.recordId === restoration.movement.recordId)) {
      continue;
    }
    items.splice(
      Math.min(restoration.originalIndex, items.length),
      0,
      restoration.movement,
    );
    restoredItems.push(restoration.movement);
  }

  if (removedItems.length === 0 && restoredItems.length === 0) return response;
  const totalDelta = restoredItems.length - removedItems.length;
  const total = Math.max(0, response.total + totalDelta);
  const totalQuantity = Math.max(
    0,
    response.summary.totalQuantity -
      removedItems.reduce((sum, item) => sum + item.quantity, 0) +
      restoredItems.reduce((sum, item) => sum + item.quantity, 0),
  );
  const overdueItems = Math.max(
    0,
    response.summary.overdueItems -
      removedItems.filter((item) => item.overdue).length +
      restoredItems.filter((item) => item.overdue).length,
  );
  return {
    ...response,
    items,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, response.pageSize))),
    summary: {
      totalRecords: Math.max(0, response.summary.totalRecords + totalDelta),
      totalQuantity,
      overdueItems,
      statusCounts: adjustStatusCounts(response, removedItems, restoredItems),
    },
  };
}
