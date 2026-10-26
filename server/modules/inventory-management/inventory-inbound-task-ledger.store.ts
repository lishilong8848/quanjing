import { ConflictException, ForbiddenException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { join } from 'node:path';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryInboundTask,
  InventoryMovementCreateResponse,
  InventoryNewInboundMovementCreateRequest,
  PurchaseInboundConfirmRequest,
} from '../../../shared/inventory-management.interface';
import {
  PurchaseInboundCategoryTaskLedgerStore,
  type PurchaseInboundCategoryTaskLedgerEntry,
  type PurchaseInboundCategoryTaskLedgerStoreOptions,
} from './purchase-inbound-category-task-ledger.store';
import { buildStableInventoryMutationFingerprint } from './inventory-idempotency-fingerprint';
import { assertInboundResponsibilitySource, inboundResponsibilities, inboundResponsibilityFingerprint, normalizeInboundResponsibilityHandover,
  type InboundResponsibility, type InboundResponsibilityHandoverInput } from './inventory-inbound-responsibility';

export const INVENTORY_INBOUND_TASK_LEDGER_PATH =
  'INVENTORY_INBOUND_TASK_LEDGER_PATH';
export const INVENTORY_INBOUND_TASK_LEDGER_OPTIONS =
  'INVENTORY_INBOUND_TASK_LEDGER_OPTIONS';

export type ManualInventoryInboundTaskRequest =
  | InventoryNewInboundMovementCreateRequest
  | InventoryExistingInboundMovementCreateRequest;

export type InventoryInboundTaskRequest =
  | ManualInventoryInboundTaskRequest
  | PurchaseInboundConfirmRequest;

export type InventoryInboundTaskLedgerTask = InventoryInboundTask & {
  businessResult?: InventoryMovementCreateResponse;
};

export interface InventoryInboundTaskLedgerEntry {
  kind: 'manual' | 'purchase';
  principal: AccessPrincipal;
  principalFingerprint: string;
  requestFingerprint: string;
  request: InventoryInboundTaskRequest;
  attemptCount: number;
  task: InventoryInboundTaskLedgerTask;
  owner?: {
    token: string;
    acquiredAt: string;
    leaseExpiresAt: string;
  };
}

/**
 * Uses the already hardened, cross-process JSON ledger implementation with a
 * dedicated file. The typed facade prevents final inbound tasks from sharing
 * the category-generation ledger or being consumed by the wrong worker.
 */
@Injectable()
export class InventoryInboundTaskLedgerStore extends PurchaseInboundCategoryTaskLedgerStore {
  constructor(
    @Optional()
    @Inject(INVENTORY_INBOUND_TASK_LEDGER_PATH)
    ledgerPathValue?: string,
    @Optional()
    @Inject(INVENTORY_INBOUND_TASK_LEDGER_OPTIONS)
    options: PurchaseInboundCategoryTaskLedgerStoreOptions = {},
  ) {
    super(
      clean(ledgerPathValue) ||
        clean(process.env.INVENTORY_INBOUND_TASK_LEDGER_PATH) ||
        join(process.cwd(), '.runtime', 'inventory-inbound-task-ledger.json'),
      options,
    );
  }

  reserveInbound(entry: InventoryInboundTaskLedgerEntry, isCurrentlyAuthorized?: () => boolean): Promise<{
    created: boolean;
    entry: InventoryInboundTaskLedgerEntry;
  }> {
    if (entry.kind !== 'purchase') return super.reserve(asCategoryEntry(entry)) as unknown as Promise<{
      created: boolean;
      entry: InventoryInboundTaskLedgerEntry;
    }>;
    const candidate = JSON.parse(JSON.stringify(entry)) as InventoryInboundTaskLedgerEntry;
    return this.transactLedger(ledger => {
      const plans = inboundResponsibilities(ledger.extensions), request = candidate.request as PurchaseInboundConfirmRequest;
      const previous = ledger.entries.find(value => value.request.clientMutationId === request.clientMutationId);
      const plan = plans[request.executionRecordId];
      if (!previous && plan) {
        const generation = request.responsibilityGeneration;
        if (generation !== plan.generation || !Number.isSafeInteger(generation)) throw new ConflictException('入库责任已更新，请刷新待入库清单后重试');
        if (!isCurrentlyAuthorized) throw new ServiceUnavailableException('入库当前授权校验未就绪');
        if (!candidate.principal.accountId || isCurrentlyAuthorized() !== true) throw new ForbiddenException('入库办理权限已变化，请重新登录');
      }
      const result = this.reserveInLedger(ledger, asCategoryEntry(candidate));
      return { ...result, result: result.result as unknown as { created: boolean; entry: InventoryInboundTaskLedgerEntry } };
    });
  }

  purchaseResponsibility(recordId: string): Promise<InboundResponsibility | undefined> {
    return this.transactLedger(ledger => ({ result: inboundResponsibilities(ledger.extensions)[recordId], changed: false }));
  }

  purchaseResponsibilities(): Promise<Record<string, InboundResponsibility>> {
    return this.transactLedger(ledger => ({ result: inboundResponsibilities(ledger.extensions), changed: false }));
  }

  hasAcceptedPurchaseTask(recordId: string): Promise<boolean> {
    return this.transactLedger(ledger => ({ result: ledger.entries.some(value => {
      const entry = value as unknown as InventoryInboundTaskLedgerEntry;
      return entry.kind === 'purchase' && (entry.request as PurchaseInboundConfirmRequest).executionRecordId === recordId && blocksInboundResponsibilityHandover(entry);
    }), changed: false }));
  }

  acceptedPurchaseTaskRecordIds(): Promise<string[]> {
    return this.transactLedger(ledger => ({ result: [...new Set(ledger.entries.flatMap(value => {
      const entry = value as unknown as InventoryInboundTaskLedgerEntry;
      return entry.kind === 'purchase' && blocksInboundResponsibilityHandover(entry) ? [(entry.request as PurchaseInboundConfirmRequest).executionRecordId] : [];
    }))], changed: false }));
  }

  handoverPurchaseResponsibility(value: InboundResponsibilityHandoverInput): Promise<{ status: 'accepted' | 'already_completed'; generation: number }> {
    const input = normalizeInboundResponsibilityHandover(value), fingerprint = inboundResponsibilityFingerprint(input);
    return this.transactLedger<{ status: 'accepted' | 'already_completed'; generation: number }>(ledger => {
      const plans = inboundResponsibilities(ledger.extensions), plan = plans[input.recordId];
      const prior = plan?.handovers.find(row => row.mutationId === input.mutationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConflictException('入库交接重复请求身份或载荷不一致');
        return { result: { status: 'accepted' as const, generation: prior.expectedGeneration + 1 }, changed: false };
      }
      assertInboundResponsibilitySource(plan, input);
      if (ledger.entries.some(value => {
        const entry = value as unknown as InventoryInboundTaskLedgerEntry;
        return entry.kind === 'purchase' && (entry.request as PurchaseInboundConfirmRequest).executionRecordId === input.recordId && blocksInboundResponsibilityHandover(entry);
      })) return { result: { status: 'already_completed' as const, generation: input.expectedGeneration }, changed: false };
      if ((!plan && Object.keys(plans).length >= 5000) || (plan?.handovers.length || 0) >= 100) throw new ServiceUnavailableException('入库责任交接台账容量已满');
      plans[input.recordId] = { recordId: input.recordId, generation: input.expectedGeneration + 1, recordFingerprint: input.recordFingerprint,
        target: input.target, handovers: [...(plan?.handovers || []), { ...input, fingerprint, acceptedAt: new Date().toISOString() }] };
      ledger.extensions = { ...ledger.extensions, purchaseInboundResponsibilities: plans };
      return { result: { status: 'accepted' as const, generation: input.expectedGeneration + 1 }, changed: true };
    });
  }

  protected override mutationConflictMessage(): string {
    return 'clientMutationId 已被不同的入库请求占用';
  }

  protected override fingerprintPersistedRequest(
    entry: PurchaseInboundCategoryTaskLedgerEntry,
  ): string {
    const inboundEntry = entry as unknown as InventoryInboundTaskLedgerEntry;
    if (inboundEntry.kind !== 'manual' && inboundEntry.kind !== 'purchase') {
      return '';
    }
    return buildInventoryInboundTaskRequestFingerprint(
      inboundEntry.kind,
      inboundEntry.request,
    );
  }

  protected override sameBusinessRequest(
    existing: PurchaseInboundCategoryTaskLedgerEntry,
    candidate: PurchaseInboundCategoryTaskLedgerEntry,
  ): boolean {
    return sameInventoryInboundTaskBusinessRequest(
      existing as unknown as InventoryInboundTaskLedgerEntry,
      candidate as unknown as InventoryInboundTaskLedgerEntry,
    );
  }

  protected override runningTaskMessage(): string {
    return '正在后台同步入库数据';
  }

  findInboundByTaskId(
    taskId: string,
  ): Promise<InventoryInboundTaskLedgerEntry | null> {
    return super.findByTaskId(
      taskId,
    ) as unknown as Promise<InventoryInboundTaskLedgerEntry | null>;
  }

  listRecoverableInbounds(): Promise<InventoryInboundTaskLedgerEntry[]> {
    return super.listRecoverable() as unknown as Promise<
      InventoryInboundTaskLedgerEntry[]
    >;
  }

  claimPendingInbound(taskId: string): Promise<{
    claimed: boolean;
    entry: InventoryInboundTaskLedgerEntry;
  }> {
    return super.claimPending(taskId) as unknown as Promise<{
      claimed: boolean;
      entry: InventoryInboundTaskLedgerEntry;
    }>;
  }

  updateInboundTask(
    taskId: string,
    task: InventoryInboundTaskLedgerTask,
    ownerToken: string,
  ): Promise<InventoryInboundTaskLedgerEntry> {
    return super.updateTask(
      taskId,
      task as unknown as PurchaseInboundCategoryTaskLedgerEntry['task'],
      ownerToken,
    ) as unknown as Promise<InventoryInboundTaskLedgerEntry>;
  }
}

export function buildInventoryInboundTaskRequestFingerprint(
  kind: 'manual' | 'purchase',
  request: InventoryInboundTaskRequest,
): string {
  return buildStableInventoryMutationFingerprint({ kind, request });
}

function asCategoryEntry(
  entry: InventoryInboundTaskLedgerEntry,
): PurchaseInboundCategoryTaskLedgerEntry {
  return entry as unknown as PurchaseInboundCategoryTaskLedgerEntry;
}

function blocksInboundResponsibilityHandover(entry: InventoryInboundTaskLedgerEntry): boolean {
  return !(entry.task.status === 'failed' && entry.task.definitelyNotWritten === true &&
    !entry.task.businessResult && !('result' in entry.task));
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameInventoryInboundTaskBusinessRequest(
  existing: InventoryInboundTaskLedgerEntry,
  candidate: InventoryInboundTaskLedgerEntry,
): boolean {
  if (existing.kind !== candidate.kind) return false;
  const left = existing.request as unknown as Record<string, unknown>;
  const right = candidate.request as unknown as Record<string, unknown>;
  if (
    clean(left.clientMutationId) !== clean(right.clientMutationId) ||
    clean(left.mode) !== clean(right.mode) ||
    clean(left.building) !== clean(right.building) ||
    Number(left.quantity) !== Number(right.quantity) ||
    normalizeTimestamp(left.occurredAt) !== normalizeTimestamp(right.occurredAt)
  ) {
    return false;
  }

  if (existing.kind === 'purchase') {
    if (
      clean(left.executionRecordId) !== clean(right.executionRecordId) ||
      clean(left.preparedCatalogRecordId) !==
        clean(right.preparedCatalogRecordId) ||
      normalizeSku(left.generatedSku) !== normalizeSku(right.generatedSku)
    ) {
      return false;
    }
  } else if (
    clean(left.type) !== 'inbound' ||
    clean(right.type) !== 'inbound' ||
    !sameOptionalManualFields(left, right)
  ) {
    return false;
  }

  if (clean(left.mode) === 'existing') {
    return (
      clean(left.catalogRecordId) === clean(right.catalogRecordId) &&
      normalizeSku(left.sku) === normalizeSku(right.sku)
    );
  }
  if (clean(left.mode) !== 'new') return false;
  return sameNewItem(left.newItem, right.newItem);
}

function sameOptionalManualFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return [
    'applicantOpenId',
    'operatorOpenId',
    'reason',
    'destinationBuilding',
    'expectedReturnAt',
  ].every((key) => clean(left[key]) === clean(right[key]));
}

function sameNewItem(
  existingValue: unknown,
  candidateValue: unknown,
): boolean {
  if (!isRecord(existingValue) || !isRecord(candidateValue)) return false;
  for (const key of [
    'specialty',
    'primaryCategory',
    'secondaryCategory',
    'name',
    'specification',
    'location',
  ]) {
    if (clean(existingValue[key]) !== clean(candidateValue[key])) return false;
  }
  const existingLocationRecordId = clean(existingValue.locationRecordId);
  const candidateLocationRecordId = clean(candidateValue.locationRecordId);
  if (
    existingLocationRecordId &&
    existingLocationRecordId !== candidateLocationRecordId
  ) {
    return false;
  }
  return (
    clean(existingValue.brand) === clean(candidateValue.brand) &&
    clean(existingValue.unit) === clean(candidateValue.unit) &&
    normalizeMinimumQuantity(existingValue.minimumQuantity) ===
      normalizeMinimumQuantity(candidateValue.minimumQuantity)
  );
}

function normalizeTimestamp(value: unknown): string {
  const timestamp = Date.parse(clean(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function normalizeSku(value: unknown): string {
  return clean(value).toUpperCase();
}

function normalizeMinimumQuantity(value: unknown): number {
  return value === undefined || value === null || value === ''
    ? 0
    : Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
