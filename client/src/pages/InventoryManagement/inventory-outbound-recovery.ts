import type {
  InventoryMovementOptionItem,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';

export const INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY =
  'inventory-management:outbound-recovery';
export const INVENTORY_OUTBOUND_RECOVERY_EVENT =
  'inventory-management:outbound-recovery-change';

const INVENTORY_OUTBOUND_RECOVERY_VERSION = 1 as const;

export type InventoryOutboundRecoveryKind = 'create' | 'confirm';
export type InventoryOutboundRecoveryStatus = 'draft' | 'unknown';

export interface InventoryOutboundDraftSnapshot {
  clientMutationId: string;
  building: WarehouseBuilding;
  quantity: string;
  occurredAt: string;
  itemQuery: string;
  selectedItem: InventoryMovementOptionItem;
  applicant: PurchaseApplicationApplicant;
  reason: string;
}

export interface InventoryOutboundConfirmationRecoveryDraft {
  note: string;
}

export interface InventoryOutboundRecovery<
  TDraft extends object = Record<string, unknown>,
  TItemSnapshot extends object = Record<string, unknown>,
> {
  version: typeof INVENTORY_OUTBOUND_RECOVERY_VERSION;
  kind: InventoryOutboundRecoveryKind;
  status: InventoryOutboundRecoveryStatus;
  clientMutationId: string;
  recordId?: string;
  draft: TDraft;
  itemSnapshot: TItemSnapshot;
  updatedAt: number;
}

export type InventoryOutboundRecoveryInput<
  TDraft extends object = Record<string, unknown>,
  TItemSnapshot extends object = Record<string, unknown>,
> = Omit<InventoryOutboundRecovery<TDraft, TItemSnapshot>, 'version'>;

const STORED_KEYS = new Set([
  'version',
  'kind',
  'status',
  'clientMutationId',
  'recordId',
  'draft',
  'itemSnapshot',
  'updatedAt',
]);
const RECOVERY_INPUT_KEYS = new Set([
  'kind',
  'status',
  'clientMutationId',
  'recordId',
  'draft',
  'itemSnapshot',
  'updatedAt',
]);
const REQUIRED_STORED_KEYS = [
  'version',
  'kind',
  'status',
  'clientMutationId',
  'draft',
  'itemSnapshot',
  'updatedAt',
] as const;
const WAREHOUSE_BUILDINGS = new Set([
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
]);
const CREATE_DRAFT_KEYS = new Set([
  'clientMutationId',
  'building',
  'quantity',
  'occurredAt',
  'itemQuery',
  'selectedItem',
  'applicant',
  'reason',
]);
const SELECTED_ITEM_KEYS = new Set([
  'specialty',
  'catalogRecordId',
  'inventoryRecordId',
  'sku',
  'name',
  'specification',
  'brand',
  'primaryCategory',
  'secondaryCategory',
  'building',
  'location',
  'unit',
  'availableQuantity',
  'stockConsistencyError',
]);
const REQUIRED_SELECTED_ITEM_KEYS = [...SELECTED_ITEM_KEYS].filter(
  (key) => key !== 'stockConsistencyError' && key !== 'specialty',
);
const APPLICANT_KEYS = new Set([
  'recordId',
  'openId',
  'name',
  'employeeNo',
  'position',
  'building',
  'specialty',
]);
const ITEM_SNAPSHOT_KEYS = new Set([
  'specialty',
  'recordId',
  'clientMutationId',
  'pendingSync',
  'type',
  'sku',
  'name',
  'specification',
  'quantity',
  'unit',
  'building',
  'destinationBuilding',
  'location',
  'reason',
  'approvalRejectionReason',
  'operator',
  'applicant',
  'status',
  'occurredAt',
  'expectedReturnAt',
  'overdue',
]);
const REQUIRED_ITEM_SNAPSHOT_KEYS = [
  'recordId',
  'type',
  'sku',
  'name',
  'specification',
  'quantity',
  'unit',
  'building',
  'destinationBuilding',
  'location',
  'reason',
  'operator',
  'applicant',
  'status',
  'occurredAt',
  'expectedReturnAt',
  'overdue',
] as const;
const CONFIRM_DRAFT_KEYS = new Set(['note']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[] = [...allowedKeys],
): boolean {
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isDateString(value: unknown): value is string {
  return (
    isString(value) && value.length > 0 && Number.isFinite(Date.parse(value))
  );
}

function isWarehouseBuilding(value: unknown): value is string {
  return isString(value) && WAREHOUSE_BUILDINGS.has(value);
}

function isSelectedItem(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, SELECTED_ITEM_KEYS, REQUIRED_SELECTED_ITEM_KEYS) &&
    (value.specialty === undefined || isString(value.specialty)) &&
    isIdentifier(value.catalogRecordId) &&
    isIdentifier(value.inventoryRecordId) &&
    isIdentifier(value.sku) &&
    isString(value.name) &&
    isString(value.specification) &&
    isString(value.brand) &&
    isString(value.primaryCategory) &&
    isString(value.secondaryCategory) &&
    isWarehouseBuilding(value.building) &&
    isString(value.location) &&
    isString(value.unit) &&
    typeof value.availableQuantity === 'number' &&
    Number.isFinite(value.availableQuantity) &&
    value.availableQuantity >= 0 &&
    (value.stockConsistencyError === undefined ||
      isString(value.stockConsistencyError))
  );
}

function isApplicant(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, APPLICANT_KEYS) &&
    isIdentifier(value.recordId) &&
    isIdentifier(value.openId) &&
    isString(value.name) &&
    isString(value.employeeNo) &&
    isString(value.position) &&
    isString(value.building) &&
    isString(value.specialty)
  );
}

function isCreateDraft(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, CREATE_DRAFT_KEYS)) return false;
  const quantity = Number(value.quantity);
  return (
    isIdentifier(value.clientMutationId) &&
    isWarehouseBuilding(value.building) &&
    isString(value.quantity) &&
    Number.isSafeInteger(quantity) &&
    quantity > 0 &&
    isDateString(value.occurredAt) &&
    isString(value.itemQuery) &&
    isSelectedItem(value.selectedItem) &&
    isApplicant(value.applicant) &&
    isString(value.reason) &&
    value.selectedItem.building === value.building
  );
}

function isOutboundItemSnapshot(
  value: unknown,
  allowedStatuses: ReadonlySet<string>,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ITEM_SNAPSHOT_KEYS, REQUIRED_ITEM_SNAPSHOT_KEYS) &&
    (value.specialty === undefined || isString(value.specialty)) &&
    isIdentifier(value.recordId) &&
    (value.clientMutationId === undefined ||
      isIdentifier(value.clientMutationId)) &&
    (value.pendingSync === undefined ||
      typeof value.pendingSync === 'boolean') &&
    value.type === 'outbound' &&
    isIdentifier(value.sku) &&
    isString(value.name) &&
    isString(value.specification) &&
    Number.isSafeInteger(value.quantity) &&
    Number(value.quantity) > 0 &&
    isString(value.unit) &&
    isWarehouseBuilding(value.building) &&
    value.destinationBuilding === '' &&
    isString(value.location) &&
    isString(value.reason) &&
    (value.approvalRejectionReason === undefined ||
      isString(value.approvalRejectionReason)) &&
    isString(value.operator) &&
    isString(value.applicant) &&
    isString(value.status) &&
    allowedStatuses.has(value.status) &&
    (value.occurredAt === null || isDateString(value.occurredAt)) &&
    value.expectedReturnAt === null &&
    value.overdue === false
  );
}

function isConfirmDraft(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONFIRM_DRAFT_KEYS) &&
    isIdentifier(value.note)
  );
}

export function isInventoryOutboundDraftSnapshot(
  value: unknown,
): value is InventoryOutboundDraftSnapshot {
  return isCreateDraft(value);
}

export function isInventoryOutboundConfirmationDraft(
  value: unknown,
): value is InventoryOutboundConfirmationRecoveryDraft {
  return isConfirmDraft(value);
}

function isCreateRecovery(value: Record<string, unknown>): boolean {
  if (
    Object.prototype.hasOwnProperty.call(value, 'recordId') ||
    !isCreateDraft(value.draft) ||
    !isOutboundItemSnapshot(
      value.itemSnapshot,
      new Set(['待审批', '待库房确认']),
    )
  ) {
    return false;
  }
  const draft = value.draft;
  const snapshot = value.itemSnapshot;
  const selectedItem = draft.selectedItem;
  const applicant = draft.applicant;
  if (!isSelectedItem(selectedItem) || !isApplicant(applicant)) return false;
  return (
    draft.clientMutationId === value.clientMutationId &&
    snapshot.recordId === `pending:${value.clientMutationId}` &&
    snapshot.clientMutationId === value.clientMutationId &&
    snapshot.pendingSync === true &&
    snapshot.sku === selectedItem.sku &&
    snapshot.building === draft.building &&
    snapshot.quantity === Number(draft.quantity) &&
    snapshot.reason === String(draft.reason).trim() &&
    snapshot.applicant === applicant.name &&
    isDateString(snapshot.occurredAt) &&
    Date.parse(snapshot.occurredAt) === Date.parse(String(draft.occurredAt))
  );
}

function isConfirmRecovery(value: Record<string, unknown>): boolean {
  return (
    isIdentifier(value.recordId) &&
    isConfirmDraft(value.draft) &&
    isOutboundItemSnapshot(value.itemSnapshot, new Set(['待库房确认'])) &&
    value.itemSnapshot.recordId === value.recordId
  );
}

function isRecoveryKind(
  value: unknown,
): value is InventoryOutboundRecoveryKind {
  return value === 'create' || value === 'confirm';
}

function isRecoveryStatus(
  value: unknown,
): value is InventoryOutboundRecoveryStatus {
  return value === 'draft' || value === 'unknown';
}

function isStoredRecovery(
  value: unknown,
): value is InventoryOutboundRecovery<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !STORED_KEYS.has(key)) ||
    REQUIRED_STORED_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key),
    ) ||
    value.version !== INVENTORY_OUTBOUND_RECOVERY_VERSION ||
    !isRecoveryKind(value.kind) ||
    !isRecoveryStatus(value.status) ||
    !isIdentifier(value.clientMutationId) ||
    !Number.isSafeInteger(value.updatedAt) ||
    Number(value.updatedAt) < 0
  ) {
    return false;
  }
  return value.kind === 'create'
    ? isCreateRecovery(value)
    : isConfirmRecovery(value);
}

function toStoredRecovery<TDraft extends object, TItemSnapshot extends object>(
  recovery: InventoryOutboundRecoveryInput<TDraft, TItemSnapshot>,
): InventoryOutboundRecovery<Record<string, unknown>> | null {
  if (
    !isRecord(recovery) ||
    Object.keys(recovery).some((key) => !RECOVERY_INPUT_KEYS.has(key))
  ) {
    return null;
  }
  try {
    const candidate = {
      version: INVENTORY_OUTBOUND_RECOVERY_VERSION,
      kind: recovery.kind,
      status: recovery.status,
      clientMutationId: recovery.clientMutationId,
      ...(recovery.recordId === undefined
        ? {}
        : { recordId: recovery.recordId }),
      draft: recovery.draft,
      itemSnapshot: recovery.itemSnapshot,
      updatedAt: recovery.updatedAt,
    };
    const parsed: unknown = JSON.parse(JSON.stringify(candidate));
    return isStoredRecovery(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function dispatchRecoveryEvent(): void {
  if (typeof window === 'undefined') return;
  try {
    const event =
      typeof CustomEvent === 'function'
        ? new CustomEvent(INVENTORY_OUTBOUND_RECOVERY_EVENT)
        : new Event(INVENTORY_OUTBOUND_RECOVERY_EVENT);
    window.dispatchEvent(event);
  } catch {
    // Browser recovery events are best effort; storage remains authoritative.
  }
}

function parseStoredValue(value: string): InventoryOutboundRecovery | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isStoredRecovery(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveInventoryOutboundRecovery<
  TDraft extends object,
  TItemSnapshot extends object,
>(
  recovery: InventoryOutboundRecoveryInput<TDraft, TItemSnapshot>,
  expectedClientMutationId?: string,
): boolean {
  const stored = toStoredRecovery(recovery);
  const storage = getSessionStorage();
  if (!stored || storage === null) return false;

  try {
    const currentValue = storage.getItem(
      INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY,
    );
    const current = currentValue ? parseStoredValue(currentValue) : null;
    if (currentValue && !current) {
      storage.removeItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY);
    }
    if (current) {
      const expected = expectedClientMutationId ?? stored.clientMutationId;
      if (current.clientMutationId !== expected) return false;
      if (stored.updatedAt < current.updatedAt) return false;
    } else if (expectedClientMutationId !== undefined) {
      return false;
    }

    storage.setItem(
      INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY,
      JSON.stringify(stored),
    );
    dispatchRecoveryEvent();
    return true;
  } catch {
    return false;
  }
}

export function readInventoryOutboundRecovery<
  TDraft extends object = Record<string, unknown>,
  TItemSnapshot extends object = Record<string, unknown>,
>(): InventoryOutboundRecovery<TDraft, TItemSnapshot> | null {
  const storage = getSessionStorage();
  if (storage === null) return null;

  try {
    const value = storage.getItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY);
    if (!value) return null;
    const parsed = parseStoredValue(value);
    if (!parsed) {
      storage.removeItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY);
      dispatchRecoveryEvent();
      return null;
    }
    return parsed as InventoryOutboundRecovery<TDraft, TItemSnapshot>;
  } catch {
    try {
      storage.removeItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY);
      dispatchRecoveryEvent();
    } catch {
      // An unavailable storage backend cannot retain a usable recovery.
    }
    return null;
  }
}

export function clearInventoryOutboundRecovery(
  clientMutationId: string,
): boolean {
  const storage = getSessionStorage();
  if (storage === null || !isIdentifier(clientMutationId)) return false;

  try {
    const value = storage.getItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY);
    if (!value) return false;
    const parsed = parseStoredValue(value);
    if (!parsed) {
      storage.removeItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY);
      dispatchRecoveryEvent();
      return false;
    }
    if (parsed.clientMutationId !== clientMutationId) return false;
    storage.removeItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY);
    dispatchRecoveryEvent();
    return true;
  } catch {
    return false;
  }
}

export function subscribeInventoryOutboundRecovery(
  listener: () => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  try {
    window.addEventListener(INVENTORY_OUTBOUND_RECOVERY_EVENT, listener);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      window.removeEventListener(INVENTORY_OUTBOUND_RECOVERY_EVENT, listener);
    } catch {
      // The browser may disable its event target after subscription.
    }
  };
}
