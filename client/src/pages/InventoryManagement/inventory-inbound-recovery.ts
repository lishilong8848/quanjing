import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryNewInboundMovementCreateRequest,
  PurchaseExistingInboundConfirmRequest,
  PurchaseNewInboundConfirmRequest,
  PurchasePendingInboundItem,
} from '@shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '@shared/inventory-management.interface';
import type { AccessPrincipal } from '@shared/access-control.interface';

import type { InventoryInboundDraft } from './InventoryMovementCreateDialog';
import type { PurchaseInboundDraft } from './PurchaseInboundConfirmationDialog';
import {
  isInventoryInboundPhotoForRequest,
  isInventoryInboundPhotoIds,
  isInventoryInboundStagedPhotos,
} from './inventory-inbound-photos';

export const INVENTORY_INBOUND_RECOVERY_STORAGE_KEY =
  'inventory-management:inbound-recovery';
export const INVENTORY_INBOUND_RECOVERY_EVENT =
  'inventory-management:inbound-recovery-change';

const INVENTORY_INBOUND_RECOVERY_VERSION = 1;
const ACCEPTED_INBOUND_PREFIX = 'inventory-management:inbound-accepted:';
const MAX_ACCEPTED_INBOUND_TASKS = 20;

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
  ownerKey?: string;
}

const STORED_KEYS = new Set([
  'version',
  'ownerKey',
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
  'photoIds',
]);
const MANUAL_NEW_REQUEST_KEYS = new Set([
  'type',
  'clientMutationId',
  'mode',
  'building',
  'quantity',
  'occurredAt',
  'newItem',
  'photoIds',
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
  'photoIds',
  'responsibilityGeneration',
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
  'photoIds',
  'responsibilityGeneration',
]);
const MANUAL_OPTIONAL_REQUEST_KEYS = new Set(['photoIds']);
const PURCHASE_OPTIONAL_REQUEST_KEYS = new Set(['photoIds', 'responsibilityGeneration']);
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
  'photos',
]);
const PURCHASE_FORM_KEYS = new Set([
  ...MANUAL_DRAFT_KEYS,
  'kind',
  'executionRecordId',
  'preparedCatalogRecordId',
  'generatedSku',
  'preparedAt',
  'responsibilityGeneration',
]);
const PURCHASE_OPTIONAL_FORM_KEYS = new Set([
  'clientMutationId',
  'photos',
  'preparedCatalogRecordId',
  'generatedSku',
  'preparedAt',
  'responsibilityGeneration',
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
  'responsibilityGeneration',
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
    (value.photoIds === undefined || isInventoryInboundPhotoIds(value.photoIds)) &&
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
        hasRequiredKeys(value, MANUAL_EXISTING_REQUEST_KEYS, MANUAL_OPTIONAL_REQUEST_KEYS) &&
        isIdentifier(value.catalogRecordId) &&
        isIdentifier(value.sku)
      );
    }
    return (
      value.mode === 'new' &&
      hasOnlyKeys(value, MANUAL_NEW_REQUEST_KEYS) &&
      hasRequiredKeys(value, MANUAL_NEW_REQUEST_KEYS, MANUAL_OPTIONAL_REQUEST_KEYS) &&
      isStrictInboundNewItem(value.newItem, MANUAL_REQUEST_NEW_ITEM_KEYS)
    );
  }

  if (
    !purchaseExecutionRecordId ||
    value.executionRecordId !== purchaseExecutionRecordId ||
    !isOptionalResponsibilityGeneration(value.responsibilityGeneration)
  ) {
    return false;
  }
  if (value.mode === 'existing') {
    return (
      hasOnlyKeys(value, PURCHASE_EXISTING_REQUEST_KEYS) &&
      hasRequiredKeys(value, PURCHASE_EXISTING_REQUEST_KEYS, PURCHASE_OPTIONAL_REQUEST_KEYS) &&
      isIdentifier(value.catalogRecordId) &&
      isIdentifier(value.sku)
    );
  }
  return (
    value.mode === 'new' &&
    hasOnlyKeys(value, PURCHASE_NEW_REQUEST_KEYS) &&
    hasRequiredKeys(value, PURCHASE_NEW_REQUEST_KEYS, PURCHASE_OPTIONAL_REQUEST_KEYS) &&
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
  const optionalKeys = options.optionalKeys ?? new Set(['clientMutationId', 'photos']);
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
    (value.photos !== undefined && !isInventoryInboundStagedPhotos(value.photos)) ||
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
    isOptionalResponsibilityGeneration(value.responsibilityGeneration) &&
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

function isOptionalResponsibilityGeneration(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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
  const photoIds = recovery.request?.photoIds;
  return (
    (draft.clientMutationId === undefined || draft.clientMutationId === recovery.clientMutationId) &&
    (!draft.photos || draft.photos.every((photo) =>
      isInventoryInboundPhotoForRequest(photo, draft.building, recovery.clientMutationId),
    )) &&
    (recovery.status !== 'accepted' ||
      ((photoIds?.length ?? 0) === (draft.photos?.length ?? 0) &&
        (photoIds?.every((id, index) => draft.photos?.[index]?.id === id) ?? true)))
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

  if (value.ownerKey !== undefined && (typeof value.ownerKey !== 'string' || !value.ownerKey || value.ownerKey.length > 1600)) return false;
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
    !isOptionalResponsibilityGeneration(snapshot.responsibilityGeneration) ||
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
  ownerKey?: string | null,
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
      ...(ownerKey ? { ownerKey } : {}),
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
      inboundDraftStorageKey(ownerKey),
    );
    if (currentValue !== null) {
      try {
        const current: unknown = JSON.parse(currentValue);
        if (ownerKey && isStoredRecovery(current) && (current.ownerKey !== ownerKey || (stored.status === 'failed' && current.clientMutationId !== stored.clientMutationId))) return false;
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
    const serialized = JSON.stringify(stored);
    storage.setItem(inboundDraftStorageKey(ownerKey), serialized);
    if (storage.getItem(inboundDraftStorageKey(ownerKey)) !== serialized) return false;
    if (ownerKey && stored.status === 'failed') {
      storage.removeItem(acceptedInboundPrefix(ownerKey) + stored.clientMutationId);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (validRecovery) dispatchRecoveryEvent();
  }
}

export function readInventoryInboundRecovery<
  TDraft = Record<string, unknown>,
>(ownerKey?: string | null): InventoryInboundRecovery<TDraft> | null {
  const storage = getSessionStorage();
  if (storage === null) {
    return null;
  }
  try {
    const storedValue = storage.getItem(inboundDraftStorageKey(ownerKey));
    if (storedValue === null || storedValue === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(storedValue);
    if (!isStoredRecovery(parsed)) {
      storage.removeItem(inboundDraftStorageKey(ownerKey));
      dispatchRecoveryEvent();
      return null;
    }
    if (ownerKey && parsed.ownerKey !== ownerKey) return null;
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
      storage.removeItem(inboundDraftStorageKey(ownerKey));
      dispatchRecoveryEvent();
    } catch {
      // An unreadable storage backend cannot retain a usable recovery.
    }
    return null;
  }
}

export function clearInventoryInboundRecovery(clientMutationId: string, ownerKey?: string | null): void {
  try {
    const storage = getSessionStorage();
    const storedValue = storage?.getItem(
      inboundDraftStorageKey(ownerKey),
    );
    if (storage === null || storedValue === null || storedValue === undefined) {
      return;
    }
    const parsed: unknown = JSON.parse(storedValue);
    if (
      isStoredRecovery(parsed) &&
      parsed.clientMutationId === clientMutationId
    ) {
      storage.removeItem(inboundDraftStorageKey(ownerKey));
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
  ownerKey?: string | null;
}): boolean {
  const current = readInventoryInboundRecovery(input.ownerKey);
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
  const accepted = {
    ...current,
    status: 'accepted' as const,
    retryMode: 'locked' as const,
    taskId: input.taskId,
    request: input.request,
  };
  if (input.ownerKey !== undefined) {
    if (!storeAcceptedInventoryInboundRecovery(accepted, input.ownerKey)) {
      return saveInventoryInboundRecovery(accepted, input.ownerKey);
    }
    clearInventoryInboundRecovery(input.clientMutationId, input.ownerKey);
    return true;
  }
  return saveInventoryInboundRecovery(accepted);
}

export function finalizeInventoryInboundRecovery(
  clientMutationId: string,
  status: 'running' | 'completed' | 'failed',
  ownerKey?: string | null,
): boolean {
  if (status === 'running') return false;
  if (ownerKey) {
    try {
      const task = readAcceptedInventoryInboundRecoveries(ownerKey)
        .find((entry) => entry.clientMutationId === clientMutationId);
      if (task) {
        // Keep the accepted snapshot until its editable failure draft is safely saved.
        if (status === 'failed') return false;
        const storage = getSessionStorage();
        if (!storage) return false;
        const key = acceptedInboundPrefix(ownerKey) + clientMutationId;
        storage.removeItem(key);
        const removed = storage.getItem(key) === null;
        if (removed) dispatchRecoveryEvent();
        return removed;
      }
    } catch { return false; }
  }
  const current = readInventoryInboundRecovery(ownerKey);
  if (
    !current ||
    current.status !== 'accepted' ||
    current.clientMutationId !== clientMutationId
  ) {
    return false;
  }
  clearInventoryInboundRecovery(clientMutationId, ownerKey);
  return readInventoryInboundRecovery(ownerKey)?.clientMutationId !== clientMutationId;
}

export function inventoryInboundRecoveryOwner(
  principal: Pick<AccessPrincipal, 'accountId' | 'impersonation'>,
): string | null {
  if (!principal.accountId || principal.accountId.length > 256) return null;
  return `${encodeURIComponent(principal.accountId)}:${encodeURIComponent(principal.impersonation?.actorAccountId || '')}`;
}

function acceptedInboundPrefix(ownerKey: string | null | undefined): string {
  if (!ownerKey || ownerKey.length > 1600 || !/^[A-Za-z0-9_%.-]+:[A-Za-z0-9_%.-]*$/.test(ownerKey)) {
    throw new Error('当前登录身份无法安全恢复入库任务，请重新登录');
  }
  return `${ACCEPTED_INBOUND_PREFIX}${ownerKey}:`;
}

export function readAcceptedInventoryInboundRecoveries<TDraft = Record<string, unknown>>(
  ownerKey: string | null | undefined,
): InventoryInboundRecovery<TDraft>[] {
  const prefix = acceptedInboundPrefix(ownerKey);
  const storage = getSessionStorage();
  if (!storage) throw new Error('入库任务记录无法读取，请保留当前页面后重试');
  const recoveries: InventoryInboundRecovery<TDraft>[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix) || key === inboundDraftStorageKey(ownerKey)) continue;
    const parsed: unknown = JSON.parse(storage.getItem(key) || 'null');
    if (!isStoredRecovery(parsed) || parsed.status !== 'accepted' ||
        key !== prefix + parsed.clientMutationId) {
      throw new Error('入库任务记录异常，已保留原记录，请联系管理员核对');
    }
    recoveries.push(parsed as InventoryInboundRecovery<TDraft>);
  }
  return recoveries;
}

function storeAcceptedInventoryInboundRecovery(
  recovery: InventoryInboundRecovery,
  ownerKey: string | null,
): boolean {
  try {
    const prefix = acceptedInboundPrefix(ownerKey);
    const storage = getSessionStorage();
    if (!storage) return false;
    const records = readAcceptedInventoryInboundRecoveries(ownerKey);
    const stored = { version: INVENTORY_INBOUND_RECOVERY_VERSION, ...recovery };
    if (!isStoredRecovery(stored) || stored.status !== 'accepted') return false;
    const existing = records.find((row) => row.clientMutationId === recovery.clientMutationId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(stored)) return false;
    if (!existing && records.length >= MAX_ACCEPTED_INBOUND_TASKS) return false;
    if (records.some((row) => row.clientMutationId !== recovery.clientMutationId &&
      recovery.purchaseExecutionRecordId && row.purchaseExecutionRecordId === recovery.purchaseExecutionRecordId)) return false;
    const key = prefix + recovery.clientMutationId;
    const value = JSON.stringify(stored);
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch { return false; }
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

function inboundDraftStorageKey(ownerKey?: string | null): string {
  if (ownerKey) acceptedInboundPrefix(ownerKey);
  return ownerKey ? INVENTORY_INBOUND_RECOVERY_STORAGE_KEY + ':' + ownerKey : INVENTORY_INBOUND_RECOVERY_STORAGE_KEY;
}

/** Only call after the server has authorized the legacy task for the current identity. */
export function adoptVerifiedLegacyInboundTask(clientMutationId: string, ownerKey: string): boolean {
  const legacy = readInventoryInboundRecovery();
  if (!legacy || legacy.status !== 'accepted' || legacy.clientMutationId !== clientMutationId) return false;
  if (!storeAcceptedInventoryInboundRecovery(legacy, ownerKey)) return false;
  clearInventoryInboundRecovery(clientMutationId);
  return true;
}

export function isVerifiedLegacyInboundTaskResult(response: unknown, recovery: InventoryInboundRecovery): boolean {
  if (!isRecord(response) || response.success !== true || !isRecord(response.task)) return false;
  const task = response.task;
  if (task.id !== recovery.taskId || task.kind !== recovery.kind || task.status !== 'completed' || !isRecord(task.result)) return false;
  const result = task.result;
  return result.success === true && isRecord(result.movement) &&
    result.movement.clientMutationId === recovery.clientMutationId &&
    (recovery.kind === 'manual' ? result.type === 'inbound' : result.executionRecordId === recovery.purchaseExecutionRecordId);
}
