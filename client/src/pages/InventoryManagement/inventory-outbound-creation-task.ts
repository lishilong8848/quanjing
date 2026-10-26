import type {
  InventoryMovementItem,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundMovementCreateResponse,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';
import {
  clearInventoryOutboundRecovery,
  isInventoryOutboundDraftSnapshot,
  readInventoryOutboundRecovery,
  type InventoryOutboundDraftSnapshot,
} from './inventory-outbound-recovery';
import { runWithInventoryOutboundBrowserLock } from './inventory-outbound-browser-lock';

export const INVENTORY_OUTBOUND_CREATION_TASK_STORAGE_PREFIX =
  'inventory-management:outbound-creation-task:v1';
export const INVENTORY_OUTBOUND_CREATION_TASK_JOURNAL_LOCK_PREFIX =
  'inventory-management:outbound-creation-journal-lock:v1';
export const INVENTORY_OUTBOUND_CREATION_TASK_MAX_BYTES = 128 * 1024;
export const INVENTORY_OUTBOUND_CREATION_TASK_STORE_MAX_BYTES = 1024 * 1024;
export const INVENTORY_OUTBOUND_CREATION_TASK_STORE_MAX_ENTRIES = 64;
export const INVENTORY_OUTBOUND_CREATION_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX =
  'inventory-management:outbound-creation-terminal-receipts:v1';
export const INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_TTL_MS =
  7 * 24 * 60 * 60 * 1000;
export const INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES = 64;
export const INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_BYTES = 64 * 1024;
export const INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_MAX_BYTES =
  256 * 1024;

const INVENTORY_OUTBOUND_CREATION_TASK_VERSION = 1 as const;
const INVENTORY_OUTBOUND_CREATION_TASK_STORE_VERSION = 1 as const;
const INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_VERSION = 1 as const;
const INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORE_VERSION = 1 as const;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const PRINCIPAL_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDENTIFIER_PATTERN = /^\S(?:[\s\S]{0,254}\S)?$/;
const WAREHOUSE_BUILDINGS = new Set<WarehouseBuilding>([
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
]);

export type InventoryOutboundCreationTaskStatus =
  | 'submitting'
  | 'accepted'
  | 'uncertain'
  | 'conflict';

export interface InventoryOutboundCreationTaskJournal {
  version: typeof INVENTORY_OUTBOUND_CREATION_TASK_VERSION;
  clientMutationId: string;
  status: InventoryOutboundCreationTaskStatus;
  taskId: string | null;
  request: InventoryOutboundMovementCreateRequest;
  draft: InventoryOutboundDraftSnapshot;
  optimisticItem: InventoryMovementItem;
  createdAt: number;
  updatedAt: number;
  recoveredFromFailedReceipt?: InventoryOutboundCreationFailedReceiptIdentity;
  error?: string;
}

export type InventoryOutboundCreationTaskInput = Omit<
  InventoryOutboundCreationTaskJournal,
  'version'
>;

export interface InventoryOutboundCreationTaskExpectedVersion {
  clientMutationId: string;
  updatedAt: number;
}

export type InventoryOutboundCreationTerminalOutcome =
  | {
      kind: 'completed';
      result: InventoryOutboundMovementCreateResponse;
    }
  | {
      kind: 'failed';
      definitelyNotWritten: true;
      message: string;
    };

export interface InventoryOutboundCreationTerminalReceipt {
  version: typeof INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_VERSION;
  principalFingerprint: string;
  clientMutationId: string;
  request: InventoryOutboundMovementCreateRequest;
  journalCreatedAt: number;
  terminalFromUpdatedAt: number;
  taskId: string | null;
  terminalAt: number;
  expiresAt: number;
  outcome: InventoryOutboundCreationTerminalOutcome;
  recovery: InventoryOutboundCreationFailedRecoverySnapshot | null;
  recoveryConsumedAt: number | null;
}

export interface InventoryOutboundCreationFailedReceiptIdentity {
  clientMutationId: string;
  journalCreatedAt: number;
  terminalFromUpdatedAt: number;
  taskId: string | null;
  terminalAt: number;
}

export interface InventoryOutboundCreationFailedRecoverySnapshot {
  draft: InventoryOutboundDraftSnapshot;
  optimisticItem: InventoryMovementItem;
}

export type InventoryOutboundCreationFailedTerminalReceipt =
  InventoryOutboundCreationTerminalReceipt & {
    outcome: Extract<
      InventoryOutboundCreationTerminalOutcome,
      { kind: 'failed' }
    >;
    recovery: InventoryOutboundCreationFailedRecoverySnapshot;
  };

export type InventoryOutboundCreationFailedRecoveryResolution =
  | {
      kind: 'failed-recovery';
      receipt: InventoryOutboundCreationFailedTerminalReceipt;
    }
  | { kind: 'none' }
  | { kind: 'unavailable' };

export interface InventoryOutboundCreationTerminalExpectation {
  clientMutationId: string;
  request: InventoryOutboundMovementCreateRequest;
  journalCreatedAt: number;
  terminalFromUpdatedAt: number;
  taskId: string | null;
}

export type InventoryOutboundCreationTaskResolution =
  | { kind: 'active'; journal: InventoryOutboundCreationTaskJournal }
  | {
      kind: 'terminal';
      receipt: InventoryOutboundCreationTerminalReceipt;
    }
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

export type InventoryOutboundCreationTaskInspection =
  | { kind: 'active'; journal: InventoryOutboundCreationTaskJournal }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

export type InventoryOutboundCreationTasksInspection =
  | { kind: 'active'; journals: InventoryOutboundCreationTaskJournal[] }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

interface InventoryOutboundCreationTaskStore {
  version: typeof INVENTORY_OUTBOUND_CREATION_TASK_STORE_VERSION;
  entries: InventoryOutboundCreationTaskJournal[];
}

interface InventoryOutboundCreationTerminalReceiptStore {
  version: typeof INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORE_VERSION;
  receipts: InventoryOutboundCreationTerminalReceipt[];
}

const STORED_KEYS = new Set([
  'version',
  'clientMutationId',
  'status',
  'taskId',
  'request',
  'draft',
  'optimisticItem',
  'createdAt',
  'updatedAt',
  'recoveredFromFailedReceipt',
  'error',
]);
const INPUT_KEYS = new Set([...STORED_KEYS].filter((key) => key !== 'version'));
const REQUIRED_STORED_KEYS = [
  'version',
  'clientMutationId',
  'status',
  'taskId',
  'request',
  'draft',
  'optimisticItem',
  'createdAt',
  'updatedAt',
] as const;
const REQUEST_KEYS = new Set([
  'type',
  'clientMutationId',
  'catalogRecordId',
  'sku',
  'building',
  'quantity',
  'occurredAt',
  'applicantOpenId',
  'reason',
]);
const OPTIMISTIC_ITEM_KEYS = new Set([
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
  'operator',
  'applicant',
  'status',
  'occurredAt',
  'expectedReturnAt',
  'overdue',
]);
const REQUIRED_OPTIMISTIC_ITEM_KEYS = [
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
  'operator',
  'applicant',
  'status',
  'occurredAt',
  'expectedReturnAt',
  'overdue',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isText(value: unknown, maxLength = 2_000): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function isNullableText(value: unknown, maxLength = 2_000): boolean {
  return (
    value === null || (typeof value === 'string' && value.length <= maxLength)
  );
}

function isWarehouseBuilding(value: unknown): value is WarehouseBuilding {
  return (
    typeof value === 'string' &&
    WAREHOUSE_BUILDINGS.has(value as WarehouseBuilding)
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDateString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isStatus(
  value: unknown,
): value is InventoryOutboundCreationTaskStatus {
  return (
    value === 'submitting' ||
    value === 'accepted' ||
    value === 'uncertain' ||
    value === 'conflict'
  );
}

function isRequest(
  value: unknown,
): value is InventoryOutboundMovementCreateRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS)) return false;
  return (
    value.type === 'outbound' &&
    isIdentifier(value.clientMutationId) &&
    isIdentifier(value.catalogRecordId) &&
    isIdentifier(value.sku) &&
    isWarehouseBuilding(value.building) &&
    typeof value.quantity === 'number' &&
    Number.isFinite(value.quantity) &&
    value.quantity > 0 &&
    isDateString(value.occurredAt) &&
    isIdentifier(value.applicantOpenId) &&
    isText(value.reason)
  );
}

function isOptimisticItem(value: unknown): value is InventoryMovementItem {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, OPTIMISTIC_ITEM_KEYS) ||
    (value.specialty !== undefined && typeof value.specialty !== 'string') ||
    !hasRequiredKeys(value, REQUIRED_OPTIMISTIC_ITEM_KEYS)
  ) {
    return false;
  }
  return (
    isIdentifier(value.recordId) &&
    isIdentifier(value.clientMutationId) &&
    value.pendingSync === true &&
    value.type === 'outbound' &&
    isIdentifier(value.sku) &&
    isText(value.name, 500) &&
    typeof value.specification === 'string' &&
    value.specification.length <= 500 &&
    typeof value.quantity === 'number' &&
    Number.isFinite(value.quantity) &&
    value.quantity > 0 &&
    isText(value.unit, 100) &&
    isWarehouseBuilding(value.building) &&
    (value.destinationBuilding === '' ||
      value.destinationBuilding === '未配置' ||
      isWarehouseBuilding(value.destinationBuilding)) &&
    typeof value.location === 'string' &&
    value.location.length <= 500 &&
    isText(value.reason) &&
    typeof value.operator === 'string' &&
    value.operator.length <= 500 &&
    isText(value.applicant, 500) &&
    isText(value.status, 100) &&
    isDateString(value.occurredAt) &&
    isNullableText(value.expectedReturnAt, 100) &&
    (value.expectedReturnAt === null || isDateString(value.expectedReturnAt)) &&
    typeof value.overdue === 'boolean'
  );
}

function isTaskIdValidForStatus(
  status: InventoryOutboundCreationTaskStatus,
  taskId: unknown,
): taskId is string | null {
  if (status === 'submitting') return taskId === null;
  if (status === 'accepted') return isIdentifier(taskId);
  return taskId === null || isIdentifier(taskId);
}

function isFailedReceiptIdentity(
  value: unknown,
): value is InventoryOutboundCreationFailedReceiptIdentity {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set([
        'clientMutationId',
        'journalCreatedAt',
        'terminalFromUpdatedAt',
        'taskId',
        'terminalAt',
      ]),
    ) &&
    isIdentifier(value.clientMutationId) &&
    isTimestamp(value.journalCreatedAt) &&
    isTimestamp(value.terminalFromUpdatedAt) &&
    value.terminalFromUpdatedAt >= value.journalCreatedAt &&
    (value.taskId === null || isIdentifier(value.taskId)) &&
    isTimestamp(value.terminalAt) &&
    value.terminalAt >= value.terminalFromUpdatedAt
  );
}

function isEntryConsistent(
  value: InventoryOutboundCreationTaskJournal,
): boolean {
  const { request, draft, optimisticItem, clientMutationId } = value;
  return (
    request.clientMutationId === clientMutationId &&
    draft.clientMutationId === clientMutationId &&
    optimisticItem.clientMutationId === clientMutationId &&
    optimisticItem.recordId === `pending:${clientMutationId}` &&
    request.catalogRecordId === draft.selectedItem.catalogRecordId &&
    request.sku === draft.selectedItem.sku &&
    optimisticItem.sku === request.sku &&
    request.building === draft.building &&
    draft.selectedItem.building === request.building &&
    optimisticItem.building === request.building &&
    request.quantity === Number(draft.quantity) &&
    optimisticItem.quantity === request.quantity &&
    request.applicantOpenId === draft.applicant.openId &&
    optimisticItem.applicant === draft.applicant.name &&
    request.reason === draft.reason.trim() &&
    optimisticItem.reason === request.reason &&
    Date.parse(request.occurredAt) === Date.parse(draft.occurredAt) &&
    Date.parse(optimisticItem.occurredAt || '') ===
      Date.parse(request.occurredAt)
  );
}

function isStoredJournal(
  value: unknown,
): value is InventoryOutboundCreationTaskJournal {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, STORED_KEYS) ||
    !hasRequiredKeys(value, REQUIRED_STORED_KEYS) ||
    value.version !== INVENTORY_OUTBOUND_CREATION_TASK_VERSION ||
    !isIdentifier(value.clientMutationId) ||
    !isStatus(value.status) ||
    !isTaskIdValidForStatus(value.status, value.taskId) ||
    !isRequest(value.request) ||
    !isInventoryOutboundDraftSnapshot(value.draft) ||
    !isOptimisticItem(value.optimisticItem) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    (value.recoveredFromFailedReceipt !== undefined &&
      (!isFailedReceiptIdentity(value.recoveredFromFailedReceipt) ||
        value.recoveredFromFailedReceipt.clientMutationId ===
          value.clientMutationId ||
        value.recoveredFromFailedReceipt.terminalAt >
          value.createdAt + CLOCK_SKEW_TOLERANCE_MS)) ||
    (value.error !== undefined && !isText(value.error, 2_000))
  ) {
    return false;
  }
  return isEntryConsistent(
    value as unknown as InventoryOutboundCreationTaskJournal,
  );
}

function serializeInput(
  input: InventoryOutboundCreationTaskInput,
): { journal: InventoryOutboundCreationTaskJournal; raw: string } | null {
  if (!isRecord(input) || !hasOnlyKeys(input, INPUT_KEYS)) return null;
  try {
    const raw = JSON.stringify({
      version: INVENTORY_OUTBOUND_CREATION_TASK_VERSION,
      ...input,
    });
    if (utf8ByteLength(raw) > INVENTORY_OUTBOUND_CREATION_TASK_MAX_BYTES) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isStoredJournal(parsed) ? { journal: parsed, raw } : null;
  } catch {
    return null;
  }
}

function parseStoredJournal(
  raw: string,
): InventoryOutboundCreationTaskJournal | null {
  if (utf8ByteLength(raw) > INVENTORY_OUTBOUND_CREATION_TASK_MAX_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredJournal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStoredJournalListValid(
  entries: readonly InventoryOutboundCreationTaskJournal[],
): boolean {
  if (
    entries.length === 0 ||
    entries.length > INVENTORY_OUTBOUND_CREATION_TASK_STORE_MAX_ENTRIES ||
    entries.filter((entry) => entry.taskId === null).length > 1
  ) {
    return false;
  }
  const mutationIds = new Set<string>();
  for (const entry of entries) {
    if (!isStoredJournal(entry) || mutationIds.has(entry.clientMutationId)) {
      return false;
    }
    mutationIds.add(entry.clientMutationId);
  }
  return true;
}

function parseStoredJournals(
  raw: string,
): InventoryOutboundCreationTaskJournal[] | null {
  const legacyJournal = parseStoredJournal(raw);
  if (legacyJournal) return [legacyJournal];
  if (utf8ByteLength(raw) > INVENTORY_OUTBOUND_CREATION_TASK_STORE_MAX_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !hasOnlyKeys(parsed, new Set(['version', 'entries'])) ||
      parsed.version !== INVENTORY_OUTBOUND_CREATION_TASK_STORE_VERSION ||
      !Array.isArray(parsed.entries) ||
      !isStoredJournalListValid(
        parsed.entries as InventoryOutboundCreationTaskJournal[],
      )
    ) {
      return null;
    }
    return parsed.entries as InventoryOutboundCreationTaskJournal[];
  } catch {
    return null;
  }
}

function serializeStoredJournals(
  entries: readonly InventoryOutboundCreationTaskJournal[],
): string | null {
  if (!isStoredJournalListValid(entries)) return null;
  try {
    const raw =
      entries.length === 1
        ? JSON.stringify(entries[0])
        : JSON.stringify({
            version: INVENTORY_OUTBOUND_CREATION_TASK_STORE_VERSION,
            entries: [...entries],
          } satisfies InventoryOutboundCreationTaskStore);
    return utf8ByteLength(raw) <=
      (entries.length === 1
        ? INVENTORY_OUTBOUND_CREATION_TASK_MAX_BYTES
        : INVENTORY_OUTBOUND_CREATION_TASK_STORE_MAX_BYTES)
      ? raw
      : null;
  } catch {
    return null;
  }
}

function writeStoredJournalsUnlocked(
  storage: Storage,
  key: string,
  entries: readonly InventoryOutboundCreationTaskJournal[],
): boolean {
  if (entries.length === 0) {
    storage.removeItem(key);
    return storage.getItem(key) === null;
  }
  const raw = serializeStoredJournals(entries);
  if (!raw) return false;
  storage.setItem(key, raw);
  return storage.getItem(key) === raw;
}

const TERMINAL_RECEIPT_KEYS = new Set([
  'version',
  'principalFingerprint',
  'clientMutationId',
  'request',
  'journalCreatedAt',
  'terminalFromUpdatedAt',
  'taskId',
  'terminalAt',
  'expiresAt',
  'outcome',
  'recovery',
  'recoveryConsumedAt',
]);
const COMPLETED_OUTCOME_KEYS = new Set(['kind', 'result']);
const FAILED_OUTCOME_KEYS = new Set([
  'kind',
  'definitelyNotWritten',
  'message',
]);
const COMPLETED_RESULT_KEYS = new Set([
  'success',
  'recordId',
  'type',
  'alreadyProcessed',
  'message',
  'movement',
]);

function isCanonicalCompletedResult(
  value: unknown,
  request: InventoryOutboundMovementCreateRequest,
): value is InventoryOutboundMovementCreateResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, COMPLETED_RESULT_KEYS) ||
    value.success !== true ||
    value.type !== 'outbound' ||
    !isIdentifier(value.recordId) ||
    typeof value.alreadyProcessed !== 'boolean' ||
    typeof value.message !== 'string' ||
    value.message.length > 2_000 ||
    !isRecord(value.movement)
  ) {
    return false;
  }
  const movement = value.movement;
  return (
    movement.recordId === value.recordId &&
    isIdentifier(movement.recordId) &&
    movement.clientMutationId === request.clientMutationId &&
    movement.type === 'outbound' &&
    (movement.status === '待路由' ||
      movement.status === '待审批' ||
      movement.status === '待库房确认' ||
      movement.status === '已驳回' ||
      movement.status === '已出库') &&
    normalizeSku(movement.sku) === normalizeSku(request.sku) &&
    movement.building === request.building &&
    movement.quantity === request.quantity &&
    movement.reason === request.reason &&
    typeof movement.occurredAt === 'string' &&
    Date.parse(movement.occurredAt) === Date.parse(request.occurredAt)
  );
}

function isTerminalOutcome(
  value: unknown,
  request: InventoryOutboundMovementCreateRequest,
): value is InventoryOutboundCreationTerminalOutcome {
  if (!isRecord(value)) return false;
  if (value.kind === 'completed') {
    return (
      hasOnlyKeys(value, COMPLETED_OUTCOME_KEYS) &&
      isCanonicalCompletedResult(value.result, request)
    );
  }
  return (
    value.kind === 'failed' &&
    hasOnlyKeys(value, FAILED_OUTCOME_KEYS) &&
    value.definitelyNotWritten === true &&
    isText(value.message)
  );
}

function isFailedRecoverySnapshot(
  value: unknown,
  request: InventoryOutboundMovementCreateRequest,
): value is InventoryOutboundCreationFailedRecoverySnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['draft', 'optimisticItem'])) ||
    !isInventoryOutboundDraftSnapshot(value.draft) ||
    !isOptimisticItem(value.optimisticItem)
  ) {
    return false;
  }
  return isEntryConsistent({
    version: INVENTORY_OUTBOUND_CREATION_TASK_VERSION,
    clientMutationId: request.clientMutationId,
    status: 'submitting',
    taskId: null,
    request,
    draft: value.draft,
    optimisticItem: value.optimisticItem,
    createdAt: 0,
    updatedAt: 0,
  });
}

function isTerminalReceipt(
  value: unknown,
  principalFingerprint: string,
): value is InventoryOutboundCreationTerminalReceipt {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, TERMINAL_RECEIPT_KEYS) ||
    value.version !== INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_VERSION ||
    value.principalFingerprint !== principalFingerprint ||
    !isIdentifier(value.clientMutationId) ||
    !isRequest(value.request) ||
    value.request.clientMutationId !== value.clientMutationId ||
    !isTimestamp(value.journalCreatedAt) ||
    !isTimestamp(value.terminalFromUpdatedAt) ||
    value.terminalFromUpdatedAt < value.journalCreatedAt ||
    (value.taskId !== null && !isIdentifier(value.taskId)) ||
    !isTimestamp(value.terminalAt) ||
    value.terminalAt < value.terminalFromUpdatedAt ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt !==
      value.terminalAt + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_TTL_MS ||
    !isTerminalOutcome(value.outcome, value.request) ||
    (value.outcome.kind === 'completed'
      ? value.recovery !== null || value.recoveryConsumedAt !== null
      : !isFailedRecoverySnapshot(value.recovery, value.request) ||
        (value.recoveryConsumedAt !== null &&
          (!isTimestamp(value.recoveryConsumedAt) ||
            value.recoveryConsumedAt < value.terminalAt ||
            value.recoveryConsumedAt > value.expiresAt)))
  ) {
    return false;
  }
  try {
    return (
      utf8ByteLength(JSON.stringify(value)) <=
      INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function parseTerminalReceiptStore(
  raw: string,
  principalFingerprint: string,
): InventoryOutboundCreationTerminalReceiptStore | null {
  if (
    utf8ByteLength(raw) >
    INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_MAX_BYTES
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, new Set(['version', 'receipts'])) ||
      value.version !==
        INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORE_VERSION ||
      !Array.isArray(value.receipts) ||
      value.receipts.length >
        INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES ||
      !value.receipts.every((receipt) =>
        isTerminalReceipt(receipt, principalFingerprint),
      )
    ) {
      return null;
    }
    const mutationIds = new Set<string>();
    for (const receipt of value.receipts) {
      if (mutationIds.has(receipt.clientMutationId)) return null;
      mutationIds.add(receipt.clientMutationId);
    }
    return value as unknown as InventoryOutboundCreationTerminalReceiptStore;
  } catch {
    return null;
  }
}

function normalizeSku(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

function requestsEqual(
  left: InventoryOutboundMovementCreateRequest,
  right: InventoryOutboundMovementCreateRequest,
): boolean {
  return (
    left.type === right.type &&
    left.clientMutationId === right.clientMutationId &&
    left.catalogRecordId === right.catalogRecordId &&
    left.sku === right.sku &&
    left.building === right.building &&
    left.quantity === right.quantity &&
    left.occurredAt === right.occurredAt &&
    left.applicantOpenId === right.applicantOpenId &&
    left.reason === right.reason
  );
}

function isTerminalExpectation(
  value: unknown,
): value is InventoryOutboundCreationTerminalExpectation {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    isIdentifier(value.clientMutationId) &&
    isRequest(value.request) &&
    value.request.clientMutationId === value.clientMutationId &&
    isTimestamp(value.journalCreatedAt) &&
    isTimestamp(value.terminalFromUpdatedAt) &&
    value.terminalFromUpdatedAt >= value.journalCreatedAt &&
    (value.taskId === null || isIdentifier(value.taskId))
  );
}

function journalMatchesTerminalExpectation(
  journal: InventoryOutboundCreationTaskJournal,
  expectation: InventoryOutboundCreationTerminalExpectation,
): boolean {
  return (
    journal.clientMutationId === expectation.clientMutationId &&
    journal.createdAt === expectation.journalCreatedAt &&
    journal.updatedAt === expectation.terminalFromUpdatedAt &&
    journal.taskId === expectation.taskId &&
    requestsEqual(journal.request, expectation.request)
  );
}

function receiptMatchesTerminalExpectation(
  receipt: InventoryOutboundCreationTerminalReceipt,
  expectation: InventoryOutboundCreationTerminalExpectation,
): boolean {
  return (
    receipt.clientMutationId === expectation.clientMutationId &&
    receipt.journalCreatedAt === expectation.journalCreatedAt &&
    receipt.terminalFromUpdatedAt >= expectation.terminalFromUpdatedAt &&
    (expectation.taskId === null || receipt.taskId === expectation.taskId) &&
    requestsEqual(receipt.request, expectation.request)
  );
}

function activeMatchesFollowerExpectation(
  journal: InventoryOutboundCreationTaskJournal,
  expectation: InventoryOutboundCreationTerminalExpectation,
): boolean {
  return (
    journal.clientMutationId === expectation.clientMutationId &&
    journal.createdAt === expectation.journalCreatedAt &&
    journal.updatedAt >= expectation.terminalFromUpdatedAt &&
    (journal.updatedAt > expectation.terminalFromUpdatedAt ||
      expectation.taskId === null ||
      journal.taskId === expectation.taskId) &&
    requestsEqual(journal.request, expectation.request)
  );
}

function activeMatchesReceiptTerminal(
  journal: InventoryOutboundCreationTaskJournal,
  receipt: InventoryOutboundCreationTerminalReceipt,
): boolean {
  return (
    journal.clientMutationId === receipt.clientMutationId &&
    journal.createdAt === receipt.journalCreatedAt &&
    journal.updatedAt === receipt.terminalFromUpdatedAt &&
    journal.taskId === receipt.taskId &&
    requestsEqual(journal.request, receipt.request)
  );
}

function clearMatchingTerminalActiveUnlocked(
  storage: Storage,
  activeKey: string,
  receipt: InventoryOutboundCreationTerminalReceipt,
): 'cleared' | 'conflict' | 'unavailable' {
  let currentRaw: string | null;
  try {
    currentRaw = storage.getItem(activeKey);
  } catch {
    return 'unavailable';
  }
  if (currentRaw === null) return 'cleared';
  const entries = parseStoredJournals(currentRaw);
  if (!entries) return 'unavailable';
  const currentIndex = entries.findIndex(
    (entry) => entry.clientMutationId === receipt.clientMutationId,
  );
  if (currentIndex < 0) return 'cleared';
  if (!activeMatchesReceiptTerminal(entries[currentIndex], receipt)) {
    return 'conflict';
  }

  try {
    const remaining = entries.filter((_, index) => index !== currentIndex);
    if (!writeStoredJournalsUnlocked(storage, activeKey, remaining)) {
      return 'unavailable';
    }
    const afterWriteRaw = storage.getItem(activeKey);
    if (afterWriteRaw === null) return 'cleared';
    const afterWrite = parseStoredJournals(afterWriteRaw);
    if (!afterWrite) return 'unavailable';
    return afterWrite.some(
      (entry) => entry.clientMutationId === receipt.clientMutationId,
    )
      ? 'unavailable'
      : 'cleared';
  } catch {
    return 'unavailable';
  }
}

function terminalExpectationFromJournal(
  journal: InventoryOutboundCreationTaskJournal,
): InventoryOutboundCreationTerminalExpectation {
  return {
    clientMutationId: journal.clientMutationId,
    request: { ...journal.request },
    journalCreatedAt: journal.createdAt,
    terminalFromUpdatedAt: journal.updatedAt,
    taskId: journal.taskId,
  };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}

function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getInventoryOutboundCreationTaskStorageKey(
  principalFingerprint: string | null | undefined,
): string | null {
  if (
    typeof principalFingerprint !== 'string' ||
    !PRINCIPAL_FINGERPRINT_PATTERN.test(principalFingerprint)
  ) {
    return null;
  }
  return `${INVENTORY_OUTBOUND_CREATION_TASK_STORAGE_PREFIX}:${principalFingerprint}`;
}

export function getInventoryOutboundCreationTerminalReceiptStorageKey(
  principalFingerprint: string | null | undefined,
): string | null {
  if (!getInventoryOutboundCreationTaskStorageKey(principalFingerprint)) {
    return null;
  }
  return `${INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX}:${principalFingerprint}`;
}

export function getInventoryOutboundCreationTaskJournalLockName(
  principalFingerprint: string | null | undefined,
): string | null {
  if (!getInventoryOutboundCreationTaskStorageKey(principalFingerprint)) {
    return null;
  }
  return `${INVENTORY_OUTBOUND_CREATION_TASK_JOURNAL_LOCK_PREFIX}:${principalFingerprint}`;
}

function saveInventoryOutboundCreationTaskUnlocked(
  storage: Storage,
  key: string,
  serialized: {
    journal: InventoryOutboundCreationTaskJournal;
    raw: string;
  },
  expectedVersion?: InventoryOutboundCreationTaskExpectedVersion,
): boolean {
  const currentRaw = storage.getItem(key);
  const entries =
    currentRaw === null ? [] : parseStoredJournals(currentRaw) || null;
  if (!entries) return false;

  if (expectedVersion === undefined) {
    if (
      entries.some(
        (entry) =>
          entry.clientMutationId === serialized.journal.clientMutationId ||
          entry.taskId === null,
      )
    ) {
      return false;
    }
    return writeStoredJournalsUnlocked(storage, key, [
      ...entries,
      serialized.journal,
    ]);
  }
  if (!isExpectedVersion(expectedVersion)) return false;
  const currentIndex = entries.findIndex(
    (entry) => entry.clientMutationId === expectedVersion.clientMutationId,
  );
  if (currentIndex < 0) return false;
  const current = entries[currentIndex];
  if (
    current.updatedAt !== expectedVersion.updatedAt ||
    serialized.journal.clientMutationId !== expectedVersion.clientMutationId ||
    serialized.journal.updatedAt <= current.updatedAt
  ) {
    return false;
  }
  const next = [...entries];
  next[currentIndex] = serialized.journal;
  return writeStoredJournalsUnlocked(storage, key, next);
}

export async function saveInventoryOutboundCreationTask(
  principalFingerprint: string | null | undefined,
  input: InventoryOutboundCreationTaskInput,
  expectedVersion?: InventoryOutboundCreationTaskExpectedVersion,
): Promise<boolean> {
  const key = getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
  const receiptKey =
    getInventoryOutboundCreationTerminalReceiptStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  const serialized = serializeInput(input);
  if (
    !key ||
    !receiptKey ||
    !lockName ||
    !serialized ||
    typeof principalFingerprint !== 'string'
  ) {
    return false;
  }

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    () => {
      const storage = getLocalStorage();
      if (!storage) return false;
      const receiptRead = readTerminalReceiptStoreUnlocked(
        storage,
        receiptKey,
        principalFingerprint,
        serialized.journal.updatedAt,
      );
      if (
        receiptRead.kind === 'unavailable' ||
        receiptRead.store.receipts.some(
          (receipt) =>
            receipt.clientMutationId === serialized.journal.clientMutationId,
        )
      ) {
        return false;
      }
      const lineage = serialized.journal.recoveredFromFailedReceipt;
      if (!lineage || expectedVersion !== undefined) {
        return saveInventoryOutboundCreationTaskUnlocked(
          storage,
          key,
          serialized,
          expectedVersion,
        );
      }
      const beforeWrite = inspectFailedReceiptConsumption(
        receiptRead.store,
        lineage,
      );
      if (beforeWrite !== 'unconsumed') return false;
      if (
        !saveInventoryOutboundCreationTaskUnlocked(storage, key, serialized)
      ) {
        return false;
      }
      const consumed = consumeFailedReceiptUnlocked(
        storage,
        receiptKey,
        principalFingerprint,
        lineage,
        serialized.journal.updatedAt,
      );
      if (consumed === 'consumed') return true;
      if (consumed !== 'unconsumed') return false;
      try {
        const currentRaw = storage.getItem(key);
        const currentEntries = currentRaw
          ? parseStoredJournals(currentRaw)
          : null;
        if (!currentEntries) return false;
        const writtenIndex = currentEntries.findIndex(
          (entry) =>
            entry.clientMutationId === serialized.journal.clientMutationId &&
            entry.updatedAt === serialized.journal.updatedAt &&
            JSON.stringify(entry) === JSON.stringify(serialized.journal),
        );
        if (writtenIndex < 0) return false;
        if (
          !writeStoredJournalsUnlocked(
            storage,
            key,
            currentEntries.filter((_, index) => index !== writtenIndex),
          )
        ) {
          return false;
        }
        return false;
      } catch {
        return false;
      }
    },
  );
  return attempt.acquired ? attempt.value : false;
}

export async function inspectInventoryOutboundCreationTask(
  principalFingerprint: string | null | undefined,
  now = Date.now(),
): Promise<InventoryOutboundCreationTaskInspection> {
  const inspection = await inspectInventoryOutboundCreationTasks(
    principalFingerprint,
    now,
  );
  if (inspection.kind !== 'active') return inspection;
  const journal =
    inspection.journals.find((entry) => entry.taskId === null) ||
    inspection.journals[0];
  return { kind: 'active', journal };
}

export async function inspectInventoryOutboundCreationTasks(
  principalFingerprint: string | null | undefined,
  now = Date.now(),
): Promise<InventoryOutboundCreationTasksInspection> {
  const key = getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  if (!key || !lockName || !isTimestamp(now)) return { kind: 'unavailable' };

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    () => {
      const storage = getLocalStorage();
      if (!storage) return { kind: 'unavailable' } as const;
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        return { kind: 'unavailable' } as const;
      }
      if (raw === null) return { kind: 'missing' } as const;
      const journals = parseStoredJournals(raw);
      const invalidTime =
        !journals ||
        journals.some(
          (journal) =>
            journal.createdAt > now + CLOCK_SKEW_TOLERANCE_MS ||
            journal.updatedAt > now + CLOCK_SKEW_TOLERANCE_MS,
        );
      if (invalidTime) return { kind: 'unavailable' } as const;
      return { kind: 'active', journals } as const;
    },
  );
  return attempt.acquired ? attempt.value : { kind: 'unavailable' };
}

export async function readInventoryOutboundCreationTask(
  principalFingerprint: string | null | undefined,
  now = Date.now(),
): Promise<InventoryOutboundCreationTaskJournal | null> {
  const inspection = await inspectInventoryOutboundCreationTask(
    principalFingerprint,
    now,
  );
  return inspection.kind === 'active' ? inspection.journal : null;
}

export async function readInventoryOutboundCreationTasks(
  principalFingerprint: string | null | undefined,
  now = Date.now(),
): Promise<InventoryOutboundCreationTaskJournal[]> {
  const inspection = await inspectInventoryOutboundCreationTasks(
    principalFingerprint,
    now,
  );
  return inspection.kind === 'active' ? inspection.journals : [];
}

export async function clearInventoryOutboundCreationTask(
  principalFingerprint: string | null | undefined,
  expectedVersion: InventoryOutboundCreationTaskExpectedVersion,
): Promise<boolean> {
  const key = getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  if (!key || !lockName || !isExpectedVersion(expectedVersion)) return false;

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    () => {
      const storage = getLocalStorage();
      if (!storage) return false;
      const raw = storage.getItem(key);
      if (raw === null) return true;
      const journals = parseStoredJournals(raw);
      if (!journals) return false;
      const journalIndex = journals.findIndex(
        (entry) => entry.clientMutationId === expectedVersion.clientMutationId,
      );
      if (journalIndex < 0) return false;
      const journal = journals[journalIndex];
      if (journal.updatedAt !== expectedVersion.updatedAt) {
        return false;
      }
      return writeStoredJournalsUnlocked(
        storage,
        key,
        journals.filter((_, index) => index !== journalIndex),
      );
    },
  );
  return attempt.acquired ? attempt.value : false;
}

function writeTerminalReceiptStoreUnlocked(
  storage: Storage,
  key: string,
  store: InventoryOutboundCreationTerminalReceiptStore,
): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(store);
  } catch {
    return false;
  }
  if (
    utf8ByteLength(raw) >
    INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_MAX_BYTES
  ) {
    return false;
  }
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) return false;
    return (
      parseTerminalReceiptStore(
        raw,
        store.receipts[0]?.principalFingerprint ?? '',
      ) !== null
    );
  } catch {
    return false;
  }
}

function readTerminalReceiptStoreUnlocked(
  storage: Storage,
  key: string,
  principalFingerprint: string,
  now: number,
):
  | { kind: 'available'; store: InventoryOutboundCreationTerminalReceiptStore }
  | { kind: 'unavailable' } {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw === null) {
    return {
      kind: 'available',
      store: {
        version: INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORE_VERSION,
        receipts: [],
      },
    };
  }
  const parsed = parseTerminalReceiptStore(raw, principalFingerprint);
  if (!parsed) return { kind: 'unavailable' };
  if (
    parsed.receipts.some(
      (receipt) => receipt.terminalAt > now + CLOCK_SKEW_TOLERANCE_MS,
    )
  ) {
    return { kind: 'unavailable' };
  }
  const retained = parsed.receipts.filter((receipt) => receipt.expiresAt > now);
  if (retained.length === parsed.receipts.length) {
    return { kind: 'available', store: parsed };
  }
  const cleaned: InventoryOutboundCreationTerminalReceiptStore = {
    version: INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORE_VERSION,
    receipts: retained,
  };
  try {
    if (retained.length === 0) {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) return { kind: 'unavailable' };
    } else if (!writeTerminalReceiptStoreUnlocked(storage, key, cleaned)) {
      return { kind: 'unavailable' };
    }
  } catch {
    return { kind: 'unavailable' };
  }
  return { kind: 'available', store: cleaned };
}

function buildTerminalReceiptStore(
  current: InventoryOutboundCreationTerminalReceiptStore,
  receipt: InventoryOutboundCreationTerminalReceipt,
): InventoryOutboundCreationTerminalReceiptStore | null {
  let receiptRaw: string;
  try {
    receiptRaw = JSON.stringify(receipt);
  } catch {
    return null;
  }
  if (
    utf8ByteLength(receiptRaw) >
    INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_BYTES
  ) {
    return null;
  }
  const receipts = [...current.receipts, receipt].sort(
    (left, right) =>
      left.terminalAt - right.terminalAt ||
      left.clientMutationId.localeCompare(right.clientMutationId),
  );

  const evictOldestDiscardableReceipt = (): boolean => {
    const index = receipts.findIndex(
      (candidate) =>
        candidate !== receipt &&
        (!isFailedTerminalReceipt(candidate) ||
          candidate.recoveryConsumedAt !== null),
    );
    if (index < 0) return false;
    receipts.splice(index, 1);
    return true;
  };

  while (
    receipts.length > INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES
  ) {
    if (!evictOldestDiscardableReceipt()) return null;
  }
  while (receipts.length > 0) {
    const store: InventoryOutboundCreationTerminalReceiptStore = {
      version: INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORE_VERSION,
      receipts,
    };
    try {
      if (
        utf8ByteLength(JSON.stringify(store)) <=
        INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_MAX_BYTES
      ) {
        return receipts.includes(receipt) ? store : null;
      }
    } catch {
      return null;
    }
    if (!evictOldestDiscardableReceipt()) return null;
  }
  return null;
}

function isFailedTerminalReceipt(
  receipt: InventoryOutboundCreationTerminalReceipt,
): receipt is InventoryOutboundCreationFailedTerminalReceipt {
  return receipt.outcome.kind === 'failed' && receipt.recovery !== null;
}

export function getInventoryOutboundCreationFailedReceiptIdentity(
  receipt: InventoryOutboundCreationFailedTerminalReceipt,
): InventoryOutboundCreationFailedReceiptIdentity {
  return {
    clientMutationId: receipt.clientMutationId,
    journalCreatedAt: receipt.journalCreatedAt,
    terminalFromUpdatedAt: receipt.terminalFromUpdatedAt,
    taskId: receipt.taskId,
    terminalAt: receipt.terminalAt,
  };
}

function failedReceiptIdentityMatches(
  receipt: InventoryOutboundCreationTerminalReceipt,
  identity: InventoryOutboundCreationFailedReceiptIdentity,
): boolean {
  return (
    receipt.clientMutationId === identity.clientMutationId &&
    receipt.journalCreatedAt === identity.journalCreatedAt &&
    receipt.terminalFromUpdatedAt === identity.terminalFromUpdatedAt &&
    receipt.taskId === identity.taskId &&
    receipt.terminalAt === identity.terminalAt
  );
}

type FailedReceiptConsumptionResult =
  | 'consumed'
  | 'unconsumed'
  | 'missing'
  | 'conflict'
  | 'unavailable';

function inspectFailedReceiptConsumption(
  store: InventoryOutboundCreationTerminalReceiptStore,
  identity: InventoryOutboundCreationFailedReceiptIdentity,
): FailedReceiptConsumptionResult {
  const receipt = store.receipts.find(
    (candidate) => candidate.clientMutationId === identity.clientMutationId,
  );
  if (!receipt) return 'missing';
  if (
    !isFailedTerminalReceipt(receipt) ||
    !failedReceiptIdentityMatches(receipt, identity)
  ) {
    return 'conflict';
  }
  return receipt.recoveryConsumedAt === null ? 'unconsumed' : 'consumed';
}

function consumeFailedReceiptUnlocked(
  storage: Storage,
  receiptKey: string,
  principalFingerprint: string,
  identity: InventoryOutboundCreationFailedReceiptIdentity,
  now: number,
): FailedReceiptConsumptionResult {
  const receiptRead = readTerminalReceiptStoreUnlocked(
    storage,
    receiptKey,
    principalFingerprint,
    now,
  );
  if (receiptRead.kind === 'unavailable') return 'unavailable';
  const inspection = inspectFailedReceiptConsumption(
    receiptRead.store,
    identity,
  );
  if (inspection !== 'unconsumed') return inspection;
  const nextStore: InventoryOutboundCreationTerminalReceiptStore = {
    version: INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORE_VERSION,
    receipts: receiptRead.store.receipts.map((receipt) =>
      failedReceiptIdentityMatches(receipt, identity)
        ? { ...receipt, recoveryConsumedAt: Math.max(now, receipt.terminalAt) }
        : receipt,
    ),
  };
  if (writeTerminalReceiptStoreUnlocked(storage, receiptKey, nextStore)) {
    return 'consumed';
  }
  const afterWrite = readTerminalReceiptStoreUnlocked(
    storage,
    receiptKey,
    principalFingerprint,
    now,
  );
  return afterWrite.kind === 'unavailable'
    ? 'unavailable'
    : inspectFailedReceiptConsumption(afterWrite.store, identity);
}

export async function readUnconsumedInventoryOutboundCreationFailedReceipt(
  principalFingerprint: string | null | undefined,
  now = Date.now(),
): Promise<InventoryOutboundCreationFailedRecoveryResolution> {
  const receiptKey =
    getInventoryOutboundCreationTerminalReceiptStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  if (
    !receiptKey ||
    !lockName ||
    typeof principalFingerprint !== 'string' ||
    !isTimestamp(now)
  ) {
    return { kind: 'unavailable' };
  }

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    (): InventoryOutboundCreationFailedRecoveryResolution => {
      const localStorage = getLocalStorage();
      if (!localStorage) return { kind: 'unavailable' };
      const receiptRead = readTerminalReceiptStoreUnlocked(
        localStorage,
        receiptKey,
        principalFingerprint,
        now,
      );
      if (receiptRead.kind === 'unavailable') return receiptRead;
      const receipt = [...receiptRead.store.receipts]
        .reverse()
        .find(
          (
            candidate,
          ): candidate is InventoryOutboundCreationFailedTerminalReceipt =>
            isFailedTerminalReceipt(candidate) &&
            candidate.recoveryConsumedAt === null,
        );
      return receipt ? { kind: 'failed-recovery', receipt } : { kind: 'none' };
    },
  );
  return attempt.acquired ? attempt.value : { kind: 'unavailable' };
}

export async function markInventoryOutboundCreationFailedReceiptConsumed(
  principalFingerprint: string | null | undefined,
  receipt: InventoryOutboundCreationTerminalReceipt,
  now = Date.now(),
): Promise<boolean> {
  const receiptKey =
    getInventoryOutboundCreationTerminalReceiptStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  if (
    !receiptKey ||
    !lockName ||
    typeof principalFingerprint !== 'string' ||
    !isTimestamp(now) ||
    !isTerminalReceipt(receipt, principalFingerprint) ||
    !isFailedTerminalReceipt(receipt)
  ) {
    return false;
  }

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    (): boolean => {
      const localStorage = getLocalStorage();
      if (!localStorage) return false;
      return (
        consumeFailedReceiptUnlocked(
          localStorage,
          receiptKey,
          principalFingerprint,
          getInventoryOutboundCreationFailedReceiptIdentity(receipt),
          now,
        ) === 'consumed'
      );
    },
  );
  return attempt.acquired ? attempt.value : false;
}

export async function resolveInventoryOutboundCreationTask(
  principalFingerprint: string | null | undefined,
  expectation: InventoryOutboundCreationTerminalExpectation,
  now = Date.now(),
): Promise<InventoryOutboundCreationTaskResolution> {
  const activeKey =
    getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
  const receiptKey =
    getInventoryOutboundCreationTerminalReceiptStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  if (
    !activeKey ||
    !receiptKey ||
    !lockName ||
    typeof principalFingerprint !== 'string' ||
    !isTerminalExpectation(expectation) ||
    !isTimestamp(now)
  ) {
    return { kind: 'unavailable' };
  }

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    (): InventoryOutboundCreationTaskResolution => {
      const storage = getLocalStorage();
      if (!storage) return { kind: 'unavailable' };
      const receiptRead = readTerminalReceiptStoreUnlocked(
        storage,
        receiptKey,
        principalFingerprint,
        now,
      );
      if (receiptRead.kind === 'unavailable') return receiptRead;
      let receiptStore = receiptRead.store;

      let active: InventoryOutboundCreationTaskJournal | null = null;
      try {
        const raw = storage.getItem(activeKey);
        if (raw !== null) {
          const entries = parseStoredJournals(raw);
          if (!entries) return { kind: 'unavailable' };
          active =
            entries.find(
              (entry) =>
                entry.clientMutationId === expectation.clientMutationId,
            ) || null;
        }
      } catch {
        return { kind: 'unavailable' };
      }

      if (active?.recoveredFromFailedReceipt) {
        const lineageState = inspectFailedReceiptConsumption(
          receiptStore,
          active.recoveredFromFailedReceipt,
        );
        if (lineageState === 'unconsumed') {
          const repaired = consumeFailedReceiptUnlocked(
            storage,
            receiptKey,
            principalFingerprint,
            active.recoveredFromFailedReceipt,
            now,
          );
          if (repaired !== 'consumed') return { kind: 'unavailable' };
          const repairedRead = readTerminalReceiptStoreUnlocked(
            storage,
            receiptKey,
            principalFingerprint,
            now,
          );
          if (
            repairedRead.kind === 'unavailable' ||
            inspectFailedReceiptConsumption(
              repairedRead.store,
              active.recoveredFromFailedReceipt,
            ) !== 'consumed'
          ) {
            return { kind: 'unavailable' };
          }
          receiptStore = repairedRead.store;
        } else if (lineageState !== 'consumed' && lineageState !== 'missing') {
          return lineageState === 'conflict'
            ? { kind: 'conflict' }
            : { kind: 'unavailable' };
        }
      }

      const receipt = receiptStore.receipts.find(
        (candidate) =>
          candidate.clientMutationId === expectation.clientMutationId,
      );
      if (receipt) {
        if (
          isFailedTerminalReceipt(receipt) &&
          receipt.recoveryConsumedAt !== null
        ) {
          return { kind: 'conflict' };
        }
        if (!receiptMatchesTerminalExpectation(receipt, expectation)) {
          return { kind: 'conflict' };
        }
        if (
          active?.clientMutationId === expectation.clientMutationId &&
          !activeMatchesReceiptTerminal(active, receipt)
        ) {
          return { kind: 'conflict' };
        }
        if (active?.clientMutationId === expectation.clientMutationId) {
          const cleanup = clearMatchingTerminalActiveUnlocked(
            storage,
            activeKey,
            receipt,
          );
          if (cleanup !== 'cleared') return { kind: cleanup };
        }
        return { kind: 'terminal', receipt };
      }
      if (!active) return { kind: 'missing' };
      return activeMatchesFollowerExpectation(active, expectation)
        ? { kind: 'active', journal: active }
        : { kind: 'conflict' };
    },
  );
  return attempt.acquired ? attempt.value : { kind: 'unavailable' };
}

export async function finalizeInventoryOutboundCreationTask(
  principalFingerprint: string | null | undefined,
  journal: InventoryOutboundCreationTaskJournal,
  outcome: InventoryOutboundCreationTerminalOutcome,
  now = Date.now(),
): Promise<InventoryOutboundCreationTaskResolution> {
  const activeKey =
    getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
  const receiptKey =
    getInventoryOutboundCreationTerminalReceiptStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  if (
    !activeKey ||
    !receiptKey ||
    !lockName ||
    typeof principalFingerprint !== 'string' ||
    !isStoredJournal(journal) ||
    !isTimestamp(now) ||
    now < journal.updatedAt ||
    !isTerminalOutcome(outcome, journal.request)
  ) {
    return { kind: 'unavailable' };
  }
  const expectation = terminalExpectationFromJournal(journal);

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    (): InventoryOutboundCreationTaskResolution => {
      const storage = getLocalStorage();
      if (!storage) return { kind: 'unavailable' };
      const receiptRead = readTerminalReceiptStoreUnlocked(
        storage,
        receiptKey,
        principalFingerprint,
        now,
      );
      if (receiptRead.kind === 'unavailable') return receiptRead;

      let active: InventoryOutboundCreationTaskJournal | null;
      try {
        const raw = storage.getItem(activeKey);
        if (raw === null) {
          active = null;
        } else {
          const entries = parseStoredJournals(raw);
          if (!entries) return { kind: 'unavailable' };
          active =
            entries.find(
              (entry) => entry.clientMutationId === journal.clientMutationId,
            ) || null;
        }
      } catch {
        return { kind: 'unavailable' };
      }
      const existing = receiptRead.store.receipts.find(
        (candidate) => candidate.clientMutationId === journal.clientMutationId,
      );
      if (existing) {
        if (
          !receiptMatchesTerminalExpectation(existing, expectation) ||
          JSON.stringify(existing.outcome) !== JSON.stringify(outcome)
        ) {
          return { kind: 'conflict' };
        }
        if (
          active?.clientMutationId === journal.clientMutationId &&
          !activeMatchesReceiptTerminal(active, existing)
        ) {
          return { kind: 'conflict' };
        }
        if (active?.clientMutationId === journal.clientMutationId) {
          const cleanup = clearMatchingTerminalActiveUnlocked(
            storage,
            activeKey,
            existing,
          );
          if (cleanup !== 'cleared') return { kind: cleanup };
        }
        return { kind: 'terminal', receipt: existing };
      }
      if (!active || !journalMatchesTerminalExpectation(active, expectation)) {
        return { kind: 'conflict' };
      }

      const receipt: InventoryOutboundCreationTerminalReceipt = {
        version: INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_VERSION,
        principalFingerprint,
        clientMutationId: journal.clientMutationId,
        request: { ...journal.request },
        journalCreatedAt: journal.createdAt,
        terminalFromUpdatedAt: journal.updatedAt,
        taskId: journal.taskId,
        terminalAt: now,
        expiresAt: now + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_TTL_MS,
        outcome,
        recovery:
          outcome.kind === 'failed'
            ? {
                draft: {
                  ...journal.draft,
                  selectedItem: { ...journal.draft.selectedItem },
                  applicant: { ...journal.draft.applicant },
                },
                optimisticItem: { ...journal.optimisticItem },
              }
            : null,
        recoveryConsumedAt: null,
      };
      if (!isTerminalReceipt(receipt, principalFingerprint)) {
        return { kind: 'unavailable' };
      }
      const nextStore = buildTerminalReceiptStore(receiptRead.store, receipt);
      if (
        !nextStore ||
        !writeTerminalReceiptStoreUnlocked(storage, receiptKey, nextStore)
      ) {
        return { kind: 'unavailable' };
      }
      const verifiedRaw = storage.getItem(receiptKey);
      const verifiedStore = verifiedRaw
        ? parseTerminalReceiptStore(verifiedRaw, principalFingerprint)
        : null;
      const verifiedReceipt = verifiedStore?.receipts.find(
        (candidate) =>
          candidate.clientMutationId === journal.clientMutationId &&
          receiptMatchesTerminalExpectation(candidate, expectation),
      );
      if (!verifiedReceipt) return { kind: 'unavailable' };

      const cleanup = clearMatchingTerminalActiveUnlocked(
        storage,
        activeKey,
        verifiedReceipt,
      );
      return cleanup === 'cleared'
        ? { kind: 'terminal', receipt: verifiedReceipt }
        : { kind: cleanup };
    },
  );
  return attempt.acquired ? attempt.value : { kind: 'unavailable' };
}

function isExpectedVersion(
  value: unknown,
): value is InventoryOutboundCreationTaskExpectedVersion {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isIdentifier(value.clientMutationId) &&
    isTimestamp(value.updatedAt)
  );
}

export async function migrateLegacyInventoryOutboundCreateRecovery(
  principalFingerprint: string | null | undefined,
  request: InventoryOutboundMovementCreateRequest,
  now = Date.now(),
): Promise<boolean> {
  const key = getInventoryOutboundCreationTaskStorageKey(principalFingerprint);
  const lockName =
    getInventoryOutboundCreationTaskJournalLockName(principalFingerprint);
  if (!key || !lockName || !isRequest(request) || !isTimestamp(now)) {
    return false;
  }

  const attempt = await runWithInventoryOutboundBrowserLock(
    lockName,
    { mode: 'exclusive' },
    () => {
      const storage = getLocalStorage();
      if (!storage) return false;
      const legacy = readInventoryOutboundRecovery<
        InventoryOutboundDraftSnapshot,
        InventoryMovementItem
      >();
      if (
        !legacy ||
        legacy.kind !== 'create' ||
        legacy.status !== 'unknown' ||
        legacy.clientMutationId !== request.clientMutationId
      ) {
        return false;
      }
      const serialized = serializeInput({
        clientMutationId: legacy.clientMutationId,
        status: 'uncertain',
        taskId: null,
        request,
        draft: legacy.draft,
        optimisticItem: legacy.itemSnapshot,
        createdAt: legacy.updatedAt,
        updatedAt: Math.max(legacy.updatedAt, now),
        error: '已迁移旧版未确认出库请求，将使用原编号自动核对。',
      });
      if (
        !serialized ||
        !saveInventoryOutboundCreationTaskUnlocked(storage, key, serialized)
      ) {
        return false;
      }
      if (clearInventoryOutboundRecovery(legacy.clientMutationId)) return true;
      try {
        const currentRaw = storage.getItem(key);
        const currentEntries = currentRaw
          ? parseStoredJournals(currentRaw)
          : null;
        if (!currentEntries) return false;
        const migratedIndex = currentEntries.findIndex(
          (entry) =>
            entry.clientMutationId === serialized.journal.clientMutationId &&
            entry.updatedAt === serialized.journal.updatedAt,
        );
        if (migratedIndex >= 0) {
          writeStoredJournalsUnlocked(
            storage,
            key,
            currentEntries.filter((_, index) => index !== migratedIndex),
          );
        }
      } catch {
        // The caller remains fail-closed and will not resume this journal.
      }
      return false;
    },
  );
  return attempt.acquired ? attempt.value : false;
}
