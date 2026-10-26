import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryNewInboundMovementCreateRequest,
  PurchaseExistingInboundConfirmRequest,
  PurchaseNewInboundConfirmRequest,
  PurchasePendingInboundItem,
} from '@shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '@shared/inventory-management.interface';

import type { InventoryInboundDraft } from './InventoryMovementCreateDialog';
import type { PurchaseInboundDraft } from './PurchaseInboundConfirmationDialog';

export const INVENTORY_INBOUND_RECOVERY_STORAGE_KEY =
  'inventory-management:inbound-recovery';
export const INVENTORY_INBOUND_RECOVERY_EVENT =
  'inventory-management:inbound-recovery-change';

const INVENTORY_INBOUND_RECOVERY_VERSION = 1;

export type InventoryInboundRecoveryKind = 'manual' | 'purchase';
export type InventoryInboundRecoveryStatus = 'pending' | 'accepted' | 'failed';
export type InventoryInboundRetryMode = 'locked' | 'editable';
export type InventoryInboundFailureDisposition = 'rejected' | 'unknown';

export type InventoryInboundRecoveryRequest =
  | InventoryExistingInboundMovementCreateRequest
  | InventoryNewInboundMovementCreateRequest
  | PurchaseExistingInboundConfirmRequest
  | PurchaseNewInboundConfirmRequest;

export interface InventoryInboundRecovery<TDraft = Record<string, unknown>> {
  kind: InventoryInboundRecoveryKind;
  status: InventoryInboundRecoveryStatus;
  retryMode?: InventoryInboundRetryMode;
  clientMutationId: string;
  draft: TDraft;
  purchaseExecutionRecordId?: string;
  taskId?: string;
  request?: InventoryInboundRecoveryRequest;
}

interface StoredInventoryInboundRecovery<
  TDraft,
> extends InventoryInboundRecovery<TDraft> {
  version: typeof INVENTORY_INBOUND_RECOVERY_VERSION;
}

const STORED_KEYS = new Set([
  'version',
  'kind',
  'status',
  'retryMode',
  'clientMutationId',
  'draft',
  'purchaseExecutionRecordId',
  'taskId',
  'request',
]);

const MANUAL_EXISTING_REQUEST_KEYS = new Set([
  'type',
  'clientMutationId',
  'mode',
  'catalogRecordId',
  'sku',
  'building',
  'quantity',
  'occurredAt',
]);
const MANUAL_NEW_REQUEST_KEYS = new Set([
  'type',
  'clientMutationId',
  'mode',
  'building',
  'quantity',
  'occurredAt',
  'newItem',
]);
const PURCHASE_EXISTING_REQUEST_KEYS = new Set([
  'executionRecordId',
  'building',
  'clientMutationId',
  'mode',
  'catalogRecordId',
  'sku',
  'quantity',
  'occurredAt',
]);
const PURCHASE_NEW_REQUEST_KEYS = new Set([
  'executionRecordId',
  'building',
  'clientMutationId',
  'mode',
  'preparedCatalogRecordId',
  'generatedSku',
  'quantity',
  'occurredAt',
  'newItem',
]);
const MANUAL_REQUEST_NEW_ITEM_KEYS = new Set([
  'specialty',
  'primaryCategory',
  'secondaryCategory',
  'name',
  'specification',
  'location',
  'locationRecordId',
]);
const PURCHASE_REQUEST_NEW_ITEM_KEYS = new Set([
  ...MANUAL_REQUEST_NEW_ITEM_KEYS,
  'brand',
  'unit',
  'minimumQuantity',
]);

const MANUAL_DRAFT_KEYS = new Set([
  'clientMutationId',
  'mode',
  'building',
  'quantity',
  'occurredAt',
  'itemQuery',
  'selectedItem',
  'newItem',
]);
const PURCHASE_FORM_KEYS = new Set([
  ...MANUAL_DRAFT_KEYS,
  'kind',
  'executionRecordId',
  'preparedCatalogRecordId',
  'generatedSku',
  'preparedAt',
]);
const PURCHASE_OPTIONAL_FORM_KEYS = new Set([
  'clientMutationId',
  'preparedCatalogRecordId',
  'generatedSku',
  'preparedAt',
]);
const MANUAL_NEW_ITEM_KEYS = new Set([
  'specialty',
  'primaryCategory',
  'secondaryCategory',
  'name',
  'specification',
  'location',
  'locationRecordId',
]);
const MANUAL_OPTIONAL_NEW_ITEM_KEYS = new Set([
  'locationRecordId',
  'specialty',
]);
const PURCHASE_NEW_ITEM_KEYS = new Set([
  ...MANUAL_NEW_ITEM_KEYS,
  'locationRecordId',
  'brand',
  'unit',
  'minimumQuantity',
]);
const PURCHASE_OPTIONAL_NEW_ITEM_KEYS = new Set([
  'locationRecordId',
  'specialty',
]);
const INVENTORY_OPTION_KEYS = new Set([
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
const INVENTORY_OPTION_OPTIONAL_KEYS = new Set([
  'stockConsistencyError',
  'specialty',
]);
const INVENTORY_OPTION_TEXT_KEYS = [
  'catalogRecordId',
  'inventoryRecordId',
  'sku',
  'name',
  'specification',
  'brand',
  'primaryCategory',
  'secondaryCategory',
  'location',
  'unit',
] as const;
const PURCHASE_RECOVERY_DRAFT_KEYS = new Set(['form', 'purchaseSnapshot']);
const PURCHASE_SNAPSHOT_KEYS = new Set([
  'specialty',
  'executionRecordId',
  'submissionRecordId',
  'requestCode',
  'mode',
  'sku',
  'itemName',
  'specification',
  'brand',
  'primaryCategory',
  'secondaryCategory',
  'building',
  'quantity',
  'unit',
  'signedAt',
  'action',
  'catalogRecordId',
  'actionReason',
  'preparedCategory',
]);
const PREPARED_CATEGORY_KEYS = new Set([
  'catalogRecordId',
  'sku',
  'preparedAt',
  'clientMutationId',
  'building',
  'quantity',
  'occurredAt',
  'newItem',
]);
const PREPARED_NEW_ITEM_KEYS = new Set([
  'specialty',
  'primaryCategory',
  'secondaryCategory',
  'name',
  'specification',
  'location',
  'locationRecordId',
  'brand',
  'unit',
  'minimumQuantity',
]);
const PREPARED_REQUIRED_NEW_ITEM_KEYS = new Set([
  'primaryCategory',
  'secondaryCategory',
  'name',
  'specification',
  'location',
]);
const PURCHASE_SNAPSHOT_TEXT_KEYS = [
  'executionRecordId',
  'submissionRecordId',
  'requestCode',
  'sku',
  'itemName',
  'specification',
  'brand',
  'primaryCategory',
  'secondaryCategory',
  'unit',
  'catalogRecordId',
  'actionReason',
] as const;

export interface PurchaseInboundRecoveryDraft {
  form: PurchaseInboundDraft;
  purchaseSnapshot: PurchasePendingInboundItem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isOptionalSpecialty(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRecoveryKind(value: unknown): value is InventoryInboundRecoveryKind {
  return value === 'manual' || value === 'purchase';
}

function isRecoveryStatus(
  value: unknown,
): value is InventoryInboundRecoveryStatus {
  return value === 'pending' || value === 'accepted' || value === 'failed';
}

function isRetryMode(value: unknown): value is InventoryInboundRetryMode {
  return value === 'locked' || value === 'editable';
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  optionalKeys: ReadonlySet<string> = new Set(),
): boolean {
  return [...allowedKeys].every(
    (key) =>
      optionalKeys.has(key) || Object.prototype.hasOwnProperty.call(value, key),
  );
}

function isOptionalMutationId(value: unknown): boolean {
  return value === undefined || isIdentifier(value);
}

function isStrictInboundRequestBase(
  value: Record<string, unknown>,
  clientMutationId: string,
): boolean {
  return (
    value.clientMutationId === clientMutationId &&
    WAREHOUSE_BUILDINGS.includes(
      value.building as (typeof WAREHOUSE_BUILDINGS)[number],
    ) &&
    typeof value.quantity === 'number' &&
    Number.isInteger(value.quantity) &&
    value.quantity > 0 &&
    typeof value.occurredAt === 'string' &&
    Number.isFinite(Date.parse(value.occurredAt))
  );
}

function isStrictInboundNewItem(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, allowedKeys) ||
    !isOptionalSpecialty(value.specialty) ||
    ![
      'primaryCategory',
      'secondaryCategory',
      'name',
      'specification',
      'location',
    ].every((key) => isIdentifier(value[key])) ||
    (value.locationRecordId !== undefined &&
      !isIdentifier(value.locationRecordId)) ||
    (value.brand !== undefined && typeof value.brand !== 'string') ||
    (value.unit !== undefined && typeof value.unit !== 'string') ||
    (value.minimumQuantity !== undefined &&
      (typeof value.minimumQuantity !== 'number' ||
        !Number.isFinite(value.minimumQuantity) ||
        value.minimumQuantity < 0))
  ) {
    return false;
  }
  return true;
}

function isAcceptedRecoveryRequest(
  value: unknown,
  kind: InventoryInboundRecoveryKind,
  clientMutationId: string,
  purchaseExecutionRecordId?: string,
): value is InventoryInboundRecoveryRequest {
  if (
    !isRecord(value) ||
    !isStrictInboundRequestBase(value, clientMutationId)
  ) {
    return false;
  }
  if (kind === 'manual') {
    if (value.type !== 'inbound') return false;
    if (value.mode === 'existing') {
      return (
        hasOnlyKeys(value, MANUAL_EXISTING_REQUEST_KEYS) &&
        hasRequiredKeys(value, MANUAL_EXISTING_REQUEST_KEYS) &&
        isIdentifier(value.catalogRecordId) &&
        isIdentifier(value.sku)
      );
    }
    return (
      value.mode === 'new' &&
      hasOnlyKeys(value, MANUAL_NEW_REQUEST_KEYS) &&
      hasRequiredKeys(value, MANUAL_NEW_REQUEST_KEYS) &&
      isStrictInboundNewItem(value.newItem, MANUAL_REQUEST_NEW_ITEM_KEYS)
    );
  }

  if (
    !purchaseExecutionRecordId ||
    value.executionRecordId !== purchaseExecutionRecordId
  ) {
    return false;
  }
  if (value.mode === 'existing') {
    return (
      hasOnlyKeys(value, PURCHASE_EXISTING_REQUEST_KEYS) &&
      hasRequiredKeys(value, PURCHASE_EXISTING_REQUEST_KEYS) &&
      isIdentifier(value.catalogRecordId) &&
      isIdentifier(value.sku)
    );
  }
  return (
    value.mode === 'new' &&
    hasOnlyKeys(value, PURCHASE_NEW_REQUEST_KEYS) &&
    hasRequiredKeys(value, PURCHASE_NEW_REQUEST_KEYS) &&
    isIdentifier(value.preparedCatalogRecordId) &&
    isIdentifier(value.generatedSku) &&
    isStrictInboundNewItem(value.newItem, PURCHASE_REQUEST_NEW_ITEM_KEYS)
  );
}

function isInventoryOption(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, INVENTORY_OPTION_KEYS) ||
    !isOptionalSpecialty(value.specialty) ||
    !hasRequiredKeys(
      value,
      INVENTORY_OPTION_KEYS,
      INVENTORY_OPTION_OPTIONAL_KEYS,
    ) ||
    !WAREHOUSE_BUILDINGS.includes(
      value.building as (typeof WAREHOUSE_BUILDINGS)[number],
    ) ||
    typeof value.availableQuantity !== 'number' ||
    !Number.isFinite(value.availableQuantity) ||
    (value.stockConsistencyError !== undefined &&
      typeof value.stockConsistencyError !== 'string')
  ) {
    return false;
  }
  return INVENTORY_OPTION_TEXT_KEYS.every(
    (key) => typeof value[key] === 'string',
  );
}

function hasDraftBaseShape(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  newItemKeys: ReadonlySet<string>,
  options: {
    allowUnselectedMode?: boolean;
    optionalKeys?: ReadonlySet<string>;
    optionalNewItemKeys?: ReadonlySet<string>;
  } = {},
): boolean {
  const optionalKeys = options.optionalKeys ?? new Set(['clientMutationId']);
  if (
    !hasOnlyKeys(value, allowedKeys) ||
    !hasRequiredKeys(value, allowedKeys, optionalKeys) ||
    (value.mode !== 'existing' &&
      value.mode !== 'new' &&
      !(options.allowUnselectedMode && value.mode === '')) ||
    !WAREHOUSE_BUILDINGS.includes(
      value.building as (typeof WAREHOUSE_BUILDINGS)[number],
    ) ||
    typeof value.quantity !== 'string' ||
    typeof value.occurredAt !== 'string' ||
    typeof value.itemQuery !== 'string' ||
    !isOptionalMutationId(value.clientMutationId) ||
    (value.selectedItem !== null && !isInventoryOption(value.selectedItem)) ||
    !isRecord(value.newItem) ||
    !hasOnlyKeys(value.newItem, newItemKeys) ||
    !hasRequiredKeys(value.newItem, newItemKeys, options.optionalNewItemKeys)
  ) {
    return false;
  }
  return Object.entries(value.newItem).every(([key, field]) =>
    key === 'specialty'
      ? isOptionalSpecialty(field)
      : typeof field === 'string',
  );
}

export function isInventoryInboundRecoveryDraft(
  value: unknown,
): value is InventoryInboundDraft {
  return (
    isRecord(value) &&
    hasDraftBaseShape(value, MANUAL_DRAFT_KEYS, MANUAL_NEW_ITEM_KEYS, {
      optionalNewItemKeys: MANUAL_OPTIONAL_NEW_ITEM_KEYS,
    })
  );
}

export function isPurchaseInboundDraft(
  value: unknown,
): value is PurchaseInboundDraft {
  return (
    isRecord(value) &&
    value.kind === 'purchase' &&
    isIdentifier(value.executionRecordId) &&
    hasDraftBaseShape(value, PURCHASE_FORM_KEYS, PURCHASE_NEW_ITEM_KEYS, {
      allowUnselectedMode: true,
      optionalKeys: PURCHASE_OPTIONAL_FORM_KEYS,
      optionalNewItemKeys: PURCHASE_OPTIONAL_NEW_ITEM_KEYS,
    }) &&
    [value.preparedCatalogRecordId, value.generatedSku, value.preparedAt].every(
      (field) => field === undefined || typeof field === 'string',
    )
  );
}

function isPreparedPurchaseCategory(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, PREPARED_CATEGORY_KEYS) ||
    !hasRequiredKeys(value, PREPARED_CATEGORY_KEYS) ||
    !isIdentifier(value.catalogRecordId) ||
    !isIdentifier(value.sku) ||
    !isIdentifier(value.clientMutationId) ||
    typeof value.preparedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.preparedAt)) ||
    typeof value.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    !WAREHOUSE_BUILDINGS.includes(
      value.building as (typeof WAREHOUSE_BUILDINGS)[number],
    ) ||
    !Number.isInteger(value.quantity) ||
    Number(value.quantity) <= 0 ||
    !isRecord(value.newItem) ||
    !hasOnlyKeys(value.newItem, PREPARED_NEW_ITEM_KEYS) ||
    !isOptionalSpecialty(value.newItem.specialty) ||
    !hasRequiredKeys(value.newItem, PREPARED_REQUIRED_NEW_ITEM_KEYS)
  ) {
    return false;
  }
  for (const key of PREPARED_REQUIRED_NEW_ITEM_KEYS) {
    if (typeof value.newItem[key] !== 'string') return false;
  }
  if (
    (value.newItem.brand !== undefined &&
      typeof value.newItem.brand !== 'string') ||
    (value.newItem.locationRecordId !== undefined &&
      !isIdentifier(value.newItem.locationRecordId)) ||
    (value.newItem.unit !== undefined &&
      typeof value.newItem.unit !== 'string') ||
    (value.newItem.minimumQuantity !== undefined &&
      (typeof value.newItem.minimumQuantity !== 'number' ||
        !Number.isFinite(value.newItem.minimumQuantity) ||
        value.newItem.minimumQuantity < 0))
  ) {
    return false;
  }
  return true;
}

function isRetryDraftMutationValid(
  draft: InventoryInboundDraft | PurchaseInboundDraft,
  recovery: StoredInventoryInboundRecovery<Record<string, unknown>>,
): boolean {
  if (recovery.retryMode === 'editable') {
    return recovery.status === 'failed' && draft.clientMutationId === undefined;
  }
  return (
    draft.clientMutationId === undefined ||
    draft.clientMutationId === recovery.clientMutationId
  );
}

function isStoredRecovery(
  value: unknown,
): value is StoredInventoryInboundRecovery<Record<string, unknown>> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) => !STORED_KEYS.has(key)) ||
    value.version !== INVENTORY_INBOUND_RECOVERY_VERSION ||
    !isRecoveryKind(value.kind) ||
    !isRecoveryStatus(value.status) ||
    (value.retryMode !== undefined && !isRetryMode(value.retryMode)) ||
    !isIdentifier(value.clientMutationId) ||
    !isRecord(value.draft)
  ) {
    return false;
  }
  if (
    !(
      value.purchaseExecutionRecordId === undefined ||
      isIdentifier(value.purchaseExecutionRecordId)
    )
  ) {
    return false;
  }

  const stored = value as unknown as StoredInventoryInboundRecovery<
    Record<string, unknown>
  >;
  if (stored.status === 'accepted') {
    if (
      !isIdentifier(stored.taskId) ||
      !isAcceptedRecoveryRequest(
        stored.request,
        stored.kind,
        stored.clientMutationId,
        stored.purchaseExecutionRecordId,
      ) ||
      stored.retryMode === 'editable'
    ) {
      return false;
    }
  } else if (stored.taskId !== undefined || stored.request !== undefined) {
    return false;
  }
  if (stored.kind === 'manual') {
    return (
      stored.purchaseExecutionRecordId === undefined &&
      isInventoryInboundRecoveryDraft(stored.draft) &&
      isRetryDraftMutationValid(stored.draft, stored)
    );
  }
  if (!stored.purchaseExecutionRecordId) {
    return false;
  }
  if (isPurchaseInboundRecoveryDraft(stored.draft)) {
    return (
      stored.draft.form.executionRecordId ===
        stored.purchaseExecutionRecordId &&
      isRetryDraftMutationValid(stored.draft.form, stored)
    );
  }
  return (
    isPurchaseInboundDraft(stored.draft) &&
    stored.draft.executionRecordId === stored.purchaseExecutionRecordId &&
    isRetryDraftMutationValid(stored.draft, stored)
  );
}

export function createPurchaseInboundRecoveryDraft(
  form: PurchaseInboundDraft,
  purchaseSnapshot: PurchasePendingInboundItem,
): PurchaseInboundRecoveryDraft {
  return {
    form: {
      ...form,
      selectedItem: form.selectedItem ? { ...form.selectedItem } : null,
      newItem: { ...form.newItem },
    },
    purchaseSnapshot: {
      ...purchaseSnapshot,
      ...(purchaseSnapshot.preparedCategory
        ? {
            preparedCategory: {
              ...purchaseSnapshot.preparedCategory,
              newItem: { ...purchaseSnapshot.preparedCategory.newItem },
            },
          }
        : {}),
    },
  };
}

export function isPurchaseInboundRecoveryDraft(
  value: unknown,
): value is PurchaseInboundRecoveryDraft {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !PURCHASE_RECOVERY_DRAFT_KEYS.has(key)) ||
    !isPurchaseInboundDraft(value.form) ||
    !isRecord(value.purchaseSnapshot)
  ) {
    return false;
  }
  const form = value.form;
  const snapshot = value.purchaseSnapshot;
  if (
    Object.keys(snapshot).some((key) => !PURCHASE_SNAPSHOT_KEYS.has(key)) ||
    !isOptionalSpecialty(snapshot.specialty) ||
    form.kind !== 'purchase' ||
    !isIdentifier(form.executionRecordId) ||
    form.executionRecordId !== snapshot.executionRecordId ||
    (snapshot.mode !== null &&
      snapshot.mode !== 'existing' &&
      snapshot.mode !== 'new') ||
    !WAREHOUSE_BUILDINGS.includes(
      snapshot.building as (typeof WAREHOUSE_BUILDINGS)[number],
    ) ||
    !Number.isInteger(snapshot.quantity) ||
    Number(snapshot.quantity) <= 0 ||
    (snapshot.signedAt !== null && typeof snapshot.signedAt !== 'string') ||
    !['needs_selection', 'ready', 'needs_mapping', 'needs_catalog'].includes(
      String(snapshot.action),
    ) ||
    (snapshot.preparedCategory !== undefined &&
      !isPreparedPurchaseCategory(snapshot.preparedCategory))
  ) {
    return false;
  }
  if (
    isRecord(snapshot.preparedCategory) &&
    (form.mode !== 'new' ||
      form.preparedCatalogRecordId !==
        snapshot.preparedCategory.catalogRecordId ||
      form.generatedSku !== snapshot.preparedCategory.sku)
  ) {
    return false;
  }
  return PURCHASE_SNAPSHOT_TEXT_KEYS.every(
    (key) => typeof snapshot[key] === 'string',
  );
}

export function classifyInventoryInboundFailure(
  error: unknown,
  responseReceived = false,
): InventoryInboundFailureDisposition {
  if (!isRecord(error)) {
    return 'unknown';
  }
  const response = isRecord(error.response) ? error.response : null;
  const status = response?.status;
  const responseData = isRecord(response?.data) ? response.data : null;
  if (responseData?.definitelyNotWritten === true) {
    return 'rejected';
  }
  if (responseReceived) {
    return 'unknown';
  }
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408
  ) {
    return 'rejected';
  }
  return 'unknown';
}

export function isInventoryInboundRetryLocked(
  recovery: InventoryInboundRecovery<unknown>,
): boolean {
  return recovery.retryMode !== 'editable';
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function dispatchRecoveryEvent(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const event =
      typeof CustomEvent === 'function'
        ? new CustomEvent(INVENTORY_INBOUND_RECOVERY_EVENT)
        : new Event(INVENTORY_INBOUND_RECOVERY_EVENT);
    window.dispatchEvent(event);
  } catch {
    // Storage recovery is optional when the browser blocks event APIs.
  }
}

export function saveInventoryInboundRecovery<TDraft>(
  recovery: InventoryInboundRecovery<TDraft>,
): boolean {
  let validRecovery = false;
  try {
    if (
      !isRecoveryKind(recovery.kind) ||
      !isRecoveryStatus(recovery.status) ||
      (recovery.retryMode !== undefined && !isRetryMode(recovery.retryMode)) ||
      !isIdentifier(recovery.clientMutationId) ||
      !isRecord(recovery.draft) ||
      (recovery.purchaseExecutionRecordId !== undefined &&
        !isIdentifier(recovery.purchaseExecutionRecordId)) ||
      (recovery.status === 'accepted' &&
        (!isIdentifier(recovery.taskId) ||
          !isAcceptedRecoveryRequest(
            recovery.request,
            recovery.kind,
            recovery.clientMutationId,
            recovery.purchaseExecutionRecordId,
          )))
    ) {
      return false;
    }
    const stored: StoredInventoryInboundRecovery<TDraft> = {
      version: INVENTORY_INBOUND_RECOVERY_VERSION,
      kind: recovery.kind,
      status: recovery.status,
      ...(recovery.retryMode === undefined
        ? {}
        : { retryMode: recovery.retryMode }),
      clientMutationId: recovery.clientMutationId,
      draft: recovery.draft,
      ...(recovery.purchaseExecutionRecordId === undefined
        ? {}
        : {
            purchaseExecutionRecordId: recovery.purchaseExecutionRecordId,
          }),
      ...(recovery.status === 'accepted'
        ? {
            taskId: recovery.taskId,
            request: recovery.request,
          }
        : {}),
    };
    if (!isStoredRecovery(stored)) {
      return false;
    }
    validRecovery = true;
    const storage = getSessionStorage();
    if (storage === null) {
      return false;
    }
    const currentValue = storage.getItem(
      INVENTORY_INBOUND_RECOVERY_STORAGE_KEY,
    );
    if (currentValue !== null) {
      try {
        const current: unknown = JSON.parse(currentValue);
        if (
          isStoredRecovery(current) &&
          current.clientMutationId !== recovery.clientMutationId &&
          current.retryMode !== 'editable'
        ) {
          return false;
        }
      } catch {
        // Malformed recovery data is safe to replace with a valid snapshot.
      }
    }
    storage.setItem(
      INVENTORY_INBOUND_RECOVERY_STORAGE_KEY,
      JSON.stringify(stored),
    );
    return true;
  } catch {
    return false;
  } finally {
    if (validRecovery) dispatchRecoveryEvent();
  }
}

export function readInventoryInboundRecovery<
  TDraft = Record<string, unknown>,
>(): InventoryInboundRecovery<TDraft> | null {
  const storage = getSessionStorage();
  if (storage === null) {
    return null;
  }
  try {
    const storedValue = storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY);
    if (storedValue === null || storedValue === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(storedValue);
    if (!isStoredRecovery(parsed)) {
      storage.removeItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY);
      dispatchRecoveryEvent();
      return null;
    }
    return {
      kind: parsed.kind,
      status: parsed.status,
      ...(parsed.retryMode === undefined
        ? {}
        : { retryMode: parsed.retryMode }),
      clientMutationId: parsed.clientMutationId,
      draft: parsed.draft as TDraft,
      ...(parsed.purchaseExecutionRecordId === undefined
        ? {}
        : {
            purchaseExecutionRecordId: parsed.purchaseExecutionRecordId,
          }),
      ...(parsed.status === 'accepted'
        ? {
            taskId: parsed.taskId,
            request: parsed.request,
          }
        : {}),
    };
  } catch {
    try {
      storage.removeItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY);
      dispatchRecoveryEvent();
    } catch {
      // An unreadable storage backend cannot retain a usable recovery.
    }
    return null;
  }
}

export function clearInventoryInboundRecovery(clientMutationId: string): void {
  try {
    const storage = getSessionStorage();
    const storedValue = storage?.getItem(
      INVENTORY_INBOUND_RECOVERY_STORAGE_KEY,
    );
    if (storage === null || storedValue === null || storedValue === undefined) {
      return;
    }
    const parsed: unknown = JSON.parse(storedValue);
    if (
      isStoredRecovery(parsed) &&
      parsed.clientMutationId === clientMutationId
    ) {
      storage.removeItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY);
    }
  } catch {
    // Recovery cleanup must never block the confirmed UI state.
  } finally {
    dispatchRecoveryEvent();
  }
}

export function acceptInventoryInboundRecovery(input: {
  clientMutationId: string;
  taskId: string;
  kind: InventoryInboundRecoveryKind;
  request: InventoryInboundRecoveryRequest;
}): boolean {
  const current = readInventoryInboundRecovery();
  if (
    !current ||
    current.clientMutationId !== input.clientMutationId ||
    current.kind !== input.kind ||
    !isIdentifier(input.taskId) ||
    !isAcceptedRecoveryRequest(
      input.request,
      input.kind,
      input.clientMutationId,
      current.purchaseExecutionRecordId,
    )
  ) {
    return false;
  }
  if (
    current.status === 'accepted' &&
    (current.taskId !== input.taskId ||
      JSON.stringify(current.request) !== JSON.stringify(input.request))
  ) {
    return false;
  }
  return saveInventoryInboundRecovery({
    ...current,
    status: 'accepted',
    retryMode: 'locked',
    taskId: input.taskId,
    request: input.request,
  });
}

export function finalizeInventoryInboundRecovery(
  clientMutationId: string,
  status: 'running' | 'completed' | 'failed',
): boolean {
  if (status === 'running') return false;
  const current = readInventoryInboundRecovery();
  if (
    !current ||
    current.status !== 'accepted' ||
    current.clientMutationId !== clientMutationId
  ) {
    return false;
  }
  clearInventoryInboundRecovery(clientMutationId);
  return readInventoryInboundRecovery()?.clientMutationId !== clientMutationId;
}

export function subscribeInventoryInboundRecovery(
  listener: () => void,
): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  try {
    window.addEventListener(INVENTORY_INBOUND_RECOVERY_EVENT, listener);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      window.removeEventListener(INVENTORY_INBOUND_RECOVERY_EVENT, listener);
    } catch {
      // The browser may disable its event target after subscription.
    }
  };
}
