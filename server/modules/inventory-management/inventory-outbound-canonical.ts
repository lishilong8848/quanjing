import { createHash } from 'node:crypto';
import type {
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundMovementCreateResponse,
} from '../../../shared/inventory-management.interface';

export const INVENTORY_OUTBOUND_REQUEST_LIMITS = {
  clientMutationId: 128,
  catalogRecordId: 256,
  sku: 256,
  occurredAt: 64,
  applicantOpenId: 256,
  reason: 2_000,
  totalBytes: 16 * 1_024,
} as const;

const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const STRICT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const UNSAFE_DISPLAY_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function buildInventoryOutboundRequestFingerprint(
  request: InventoryOutboundMovementCreateRequest,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: request.type,
        catalogRecordId: request.catalogRecordId,
        sku: normalizeInventoryOutboundSku(request.sku),
        building: request.building,
        quantity: request.quantity,
        occurredAt: new Date(request.occurredAt).toISOString(),
        applicantOpenId: request.applicantOpenId,
        reason: request.reason,
      }),
    )
    .digest('hex');
}

export function assertInventoryOutboundCanonicalRequest(
  request: InventoryOutboundMovementCreateRequest,
): void {
  const limits = INVENTORY_OUTBOUND_REQUEST_LIMITS;
  if (
    request.type !== 'outbound' ||
    !validStrictIdentifier(
      request.clientMutationId,
      limits.clientMutationId,
      MUTATION_ID_PATTERN,
    ) ||
    !validStrictIdentifier(request.catalogRecordId, limits.catalogRecordId) ||
    !validStrictIdentifier(request.sku, limits.sku) ||
    typeof request.quantity !== 'number' ||
    !Number.isSafeInteger(request.quantity) ||
    request.quantity <= 0 ||
    !validStrictIdentifier(request.occurredAt, limits.occurredAt) ||
    !validStrictIdentifier(request.applicantOpenId, limits.applicantOpenId) ||
    !validNonEmptyString(request.reason, limits.reason) ||
    !Number.isFinite(Date.parse(request.occurredAt)) ||
    Buffer.byteLength(JSON.stringify(request), 'utf8') > limits.totalBytes
  ) {
    throw new Error('出库规范请求字段格式、长度或字节数无效');
  }
}

export function assertInventoryOutboundCompletedResultMatchesRequest(
  request: InventoryOutboundMovementCreateRequest,
  result: InventoryOutboundMovementCreateResponse,
): void {
  const response = result as unknown;
  if (
    !isRecord(response) ||
    !hasExactKeys(response, [
      'success',
      'recordId',
      'type',
      'alreadyProcessed',
      'message',
      'movement',
    ])
  ) {
    throw completedResultError();
  }
  const movement = response.movement;
  if (
    response.success !== true ||
    response.type !== 'outbound' ||
    typeof response.alreadyProcessed !== 'boolean' ||
    !validStrictIdentifier(response.recordId, 256) ||
    !validNonEmptyString(response.message, 2_048) ||
    !isRecord(movement) ||
    !hasExactKeys(
      movement,
      [
        'recordId',
        'clientMutationId',
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
      ],
      ['approvalRejectionReason'],
    ) ||
    movement.type !== 'outbound' ||
    !validStrictIdentifier(movement.recordId, 256) ||
    clean(movement.recordId) !== clean(response.recordId) ||
    !validStrictIdentifier(movement.clientMutationId, 128) ||
    clean(movement.clientMutationId) !== request.clientMutationId ||
    movement.building !== request.building ||
    !validStrictIdentifier(movement.sku, 256) ||
    normalizeInventoryOutboundSku(movement.sku) !==
      normalizeInventoryOutboundSku(request.sku) ||
    !validNonEmptyString(movement.name, 2_048) ||
    !validDisplayString(movement.specification, 4_096) ||
    !validDisplayString(movement.unit, 256) ||
    !validDisplayString(movement.location, 2_048) ||
    !validDisplayString(movement.operator, 2_048) ||
    !validNonEmptyString(movement.applicant, 2_048) ||
    typeof movement.quantity !== 'number' ||
    !Number.isFinite(movement.quantity) ||
    movement.quantity !== request.quantity ||
    movement.reason !== request.reason ||
    !validNonEmptyString(movement.reason, 4_096) ||
    (movement.approvalRejectionReason !== undefined &&
      !validDisplayString(movement.approvalRejectionReason, 4_096)) ||
    (movement.status !== '待审批' &&
      movement.status !== '待库房确认' &&
      movement.status !== '已出库') ||
    movement.occurredAt !== new Date(request.occurredAt).toISOString() ||
    movement.destinationBuilding !== '' ||
    movement.expectedReturnAt !== null ||
    movement.overdue !== false
  ) {
    throw completedResultError();
  }
}

export function normalizeInventoryOutboundSku(value: unknown): string {
  return clean(value).toUpperCase();
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const actualKeys = Object.keys(value);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return (
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) && actualKeys.every((key) => allowedKeys.has(key))
  );
}

function validNonEmptyString(value: unknown, maximumLength: number): boolean {
  return validDisplayString(value, maximumLength) && clean(value).length > 0;
}

function validDisplayString(value: unknown, maximumLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length <= maximumLength &&
    !UNSAFE_DISPLAY_CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function validStrictIdentifier(
  value: unknown,
  maximumLength: number,
  pattern?: RegExp,
): boolean {
  return (
    typeof value === 'string' &&
    value.length <= maximumLength &&
    clean(value).length > 0 &&
    !STRICT_CONTROL_CHARACTER_PATTERN.test(value) &&
    (pattern === undefined || pattern.test(value))
  );
}

function completedResultError(): Error {
  return new Error('已完成出库任务结果与规范请求不一致');
}
