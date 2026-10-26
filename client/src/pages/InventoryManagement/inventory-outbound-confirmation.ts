import type {
  InventoryMovementType,
  InventoryMovementsResponse,
  InventoryOutboundConfirmRequest,
  InventoryOutboundMovementItem,
  InventoryOutboundStatus,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '@shared/inventory-management.interface';

export const INVENTORY_OUTBOUND_APPROVAL_REFRESH_MS = 5_000;

const UNSETTLED_OUTBOUND_APPROVAL_STATUSES = new Set<string>([
  '待路由',
  '待审批',
]);

export function shouldRefreshInventoryOutboundApprovals(
  type: InventoryMovementType,
  response: Pick<InventoryMovementsResponse, 'items' | 'summary'>,
): boolean {
  if (type !== 'outbound') return false;
  return (
    response.items.some(
      (item) =>
        item.type === 'outbound' &&
        UNSETTLED_OUTBOUND_APPROVAL_STATUSES.has(item.status),
    ) ||
    response.summary.statusCounts.some(
      ({ status, count }) =>
        count > 0 && UNSETTLED_OUTBOUND_APPROVAL_STATUSES.has(status),
    )
  );
}

export function formatInventoryOutboundStatusLabel(status: string): string {
  return status === '待库房确认' ? '审批已通过 · 待库房确认' : status;
}

export interface InventoryOutboundConfirmationDraft {
  note: string;
}

export interface InventoryOutboundConfirmationSubmission {
  clientMutationId: string;
  recordId: string;
  startedAt: number;
  request: InventoryOutboundConfirmRequest;
  draft: InventoryOutboundConfirmationDraft;
  optimisticMovement: InventoryOutboundMovementItem;
}

export interface InventoryOutboundConfirmationFailureResolution {
  retainRecovery: boolean;
  retryLocked: boolean;
  keepDialogOpen: boolean;
  refreshAuthority: boolean;
}

export function resolveInventoryOutboundConfirmationFailure(
  outcome: 'rejected' | 'unknown',
): InventoryOutboundConfirmationFailureResolution {
  if (outcome === 'unknown') {
    return {
      retainRecovery: true,
      retryLocked: true,
      keepDialogOpen: true,
      refreshAuthority: false,
    };
  }
  return {
    retainRecovery: false,
    retryLocked: false,
    keepDialogOpen: false,
    refreshAuthority: true,
  };
}

export function canConfirmInventoryOutboundForBuilding(
  canConfirmOutbound: boolean,
  itemBuilding: InventoryOutboundMovementItem['building'],
  confirmationBuilding?: WarehouseBuilding | null,
): boolean {
  if (!WAREHOUSE_BUILDINGS.includes(itemBuilding as WarehouseBuilding)) {
    return false;
  }
  return (
    canConfirmOutbound &&
    (!confirmationBuilding || confirmationBuilding === itemBuilding)
  );
}

export function canRestoreInventoryOutboundConfirmation(
  canConfirmOutbound: boolean,
  recoveryStatus: 'draft' | 'unknown',
  itemBuilding: InventoryOutboundMovementItem['building'],
  confirmationBuilding?: WarehouseBuilding | null,
): boolean {
  return (
    recoveryStatus === 'unknown' &&
    canConfirmInventoryOutboundForBuilding(
      canConfirmOutbound,
      itemBuilding,
      confirmationBuilding,
    )
  );
}

const OUTBOUND_CONFIRMATION_TIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatInventoryOutboundConfirmationTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '待补充';
  const parts = Object.fromEntries(
    OUTBOUND_CONFIRMATION_TIME_FORMATTER.formatToParts(date).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

interface CanonicalOutboundExpectation {
  recordId: string;
  status: InventoryOutboundStatus;
  sku: string;
  building: InventoryOutboundMovementItem['building'];
  quantity: number;
}

export function buildInventoryOutboundConfirmationSubmission(
  item: InventoryOutboundMovementItem,
  clientMutationId: string,
  startedAt: number,
): InventoryOutboundConfirmationSubmission {
  const mutationId = clientMutationId.trim();
  if (!mutationId) throw new Error('缺少出库确认编号');
  if (
    item.type !== 'outbound' ||
    item.status !== '待库房确认' ||
    !WAREHOUSE_BUILDINGS.includes(item.building as WarehouseBuilding)
  ) {
    throw new Error('该出库单据当前不可确认');
  }
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error('出库确认时间无效');
  }

  return {
    clientMutationId: mutationId,
    recordId: item.recordId,
    startedAt,
    request: { clientMutationId: mutationId },
    draft: { note: '确认出库' },
    optimisticMovement: {
      ...item,
      clientMutationId: mutationId,
      pendingSync: true,
      status: '已出库',
      occurredAt: new Date(startedAt).toISOString(),
    },
  };
}

export function requireCanonicalOutboundMovement(
  value: unknown,
  expectation: CanonicalOutboundExpectation,
): InventoryOutboundMovementItem {
  if (!value || typeof value !== 'object') {
    throw new Error('后端未返回完整的出库记录');
  }
  const movement = value as Partial<InventoryOutboundMovementItem>;
  const requiredText = [
    movement.recordId,
    movement.sku,
    movement.name,
    movement.specification,
    movement.unit,
    movement.location,
    movement.reason,
    movement.operator,
    movement.applicant,
    movement.destinationBuilding,
    movement.status,
    movement.occurredAt,
  ];
  if (
    movement.type !== 'outbound' ||
    !requiredText.every((item) => typeof item === 'string') ||
    !String(movement.recordId).trim() ||
    !String(movement.sku).trim() ||
    !String(movement.name).trim() ||
    !String(movement.unit).trim() ||
    !WAREHOUSE_BUILDINGS.includes(movement.building as WarehouseBuilding) ||
    !Number.isSafeInteger(movement.quantity) ||
    Number(movement.quantity) <= 0 ||
    !Number.isFinite(Date.parse(String(movement.occurredAt))) ||
    movement.expectedReturnAt !== null ||
    movement.overdue !== false ||
    movement.destinationBuilding !== ''
  ) {
    throw new Error('后端返回的出库记录不完整');
  }
  if (
    movement.recordId !== expectation.recordId ||
    movement.status !== expectation.status ||
    String(movement.sku).trim().toUpperCase() !==
      expectation.sku.trim().toUpperCase() ||
    movement.building !== expectation.building ||
    movement.quantity !== expectation.quantity
  ) {
    throw new Error('后端返回的出库记录与本次操作不一致');
  }
  return movement as InventoryOutboundMovementItem;
}
