import { isProfessionalBusinessPrincipal, businessBuildingsForAction } from '../../../shared/business-permissions';
import { accessBuildings } from '../../../shared/building-access';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import {
  WAREHOUSE_BUILDINGS,
  type InventoryManagementItem,
  type InventoryMovementItem,
  type WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import type {
  StocktakeDraft,
  StocktakeHistory,
  StocktakeReason,
} from '../../../shared/inventory-stocktake.interface';

export function stocktakeMonth(date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 7);
}
export function stocktakeGenerationDueAt(month: string): Date {
  validateStocktakeMonth(month);
  return new Date(`${month}-01T02:30:00+08:00`);
}
export function nextStocktakeGenerationAt(now = new Date()): Date {
  const month = stocktakeMonth(now);
  const due = stocktakeGenerationDueAt(month);
  return due.getTime() > now.getTime()
    ? due
    : stocktakeGenerationDueAt(offsetStocktakeMonth(month, 1));
}
export function validateStocktakeMonth(
  month: unknown,
): asserts month is string {
  if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))
    throw new BadRequestException('盘点月份无效');
}
export function offsetStocktakeMonth(month: string, offset: number): string {
  validateStocktakeMonth(month);
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1 + offset, 1)).toISOString().slice(0, 7);
}
export function stocktakeBuildings(
  principal: AccessPrincipal,
): WarehouseBuilding[] {
  if (isProfessionalBusinessPrincipal(principal)) return businessBuildingsForAction(principal, { module: 'stocktake', action: principal.permissionContext?.action || 'read' }).filter(value => (WAREHOUSE_BUILDINGS as readonly string[]).includes(value)) as WarehouseBuilding[];
  if (principal.role === 'admin') return [...WAREHOUSE_BUILDINGS];
  if (principal.role === 'inventory_admin' || principal.role === 'building_admin') {
    const scope = accessBuildings(principal);
    if (scope?.length) return WAREHOUSE_BUILDINGS.filter(value => scope.includes(value));
  }
  throw new ForbiddenException('无库存盘点权限');
}
export function assertStocktakeScope(
  principal: AccessPrincipal,
  building: unknown,
): asserts building is WarehouseBuilding {
  if (!stocktakeBuildings(principal).some((b) => b === building))
    throw new ForbiddenException('无该楼栋盘点权限');
}
export function stocktakeFingerprint(item: InventoryManagementItem): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        item.recordId,
        item.sku,
        item.building,
        item.location,
        item.quantity,
        item.unit,
      ]),
    )
    .digest('hex');
}
export function validateStocktakeDraft(
  input: StocktakeDraft & { bookQuantity: number },
): void {
  if (
    typeof input.actualQuantity !== 'number' ||
    !Number.isFinite(input.actualQuantity) ||
    input.actualQuantity < 0 ||
    input.actualQuantity > 1e12 ||
    Math.abs(
      input.actualQuantity * 1000 - Math.round(input.actualQuantity * 1000),
    ) > 0.00001
  )
    throw new BadRequestException('实际数量须为非负数，最多三位小数');
  if (!input.confirmer?.recordId || !input.confirmer?.openId)
    throw new BadRequestException('请从在职员工中选择确认人');
  if (typeof input.note !== 'string' || input.note.length > 1000)
    throw new BadRequestException('差异说明最多1000字');
  if (
    Math.abs(input.actualQuantity - input.bookQuantity) > 0.000001 &&
    !input.note.trim()
  )
    throw new BadRequestException('请填写差异说明');
}

export function selectStocktakeItems(input: {
  month: string;
  building: WarehouseBuilding;
  items: InventoryManagementItem[];
  movements: InventoryMovementItem[];
  history: StocktakeHistory[];
  seed: string;
}) {
  validateStocktakeMonth(input.month);
  const items = input.items.filter((i) => i.building === input.building);
  const identity = new Set<string>();
  for (const i of items) {
    if (
      !i.recordId ||
      identity.has(i.recordId) ||
      !i.sku ||
      !Number.isFinite(i.quantity)
    )
      throw new BadRequestException('库存条目身份或数量不完整');
    identity.add(i.recordId);
  }
  const excluded = new Set(
    input.history
      .filter(
        (h) =>
          h.building === input.building &&
          h.month >= offsetStocktakeMonth(input.month, -3) &&
          h.month < input.month,
      )
      .flatMap((h) => h.recordIds),
  );
  const selected = new Map<
    string,
    {
      item: InventoryManagementItem;
      reasons: StocktakeReason[];
      movementIds: string[];
    }
  >();
  const previous = offsetStocktakeMonth(input.month, -1);
  for (const m of input.movements) {
    if (
      m.building !== input.building ||
      !['inbound', 'outbound'].includes(m.type)
    )
      continue;
    if (m.type === 'outbound' && m.status !== '已出库') continue;
    if (
      m.type === 'inbound' &&
      !['已入库', '已添加', '是', 'true'].includes(m.status)
    )
      continue;
    if (!m.occurredAt || !Number.isFinite(Date.parse(m.occurredAt)))
      throw new BadRequestException(
        `出入库记录 ${m.recordId} 缺少有效发生时间`,
      );
    if (stocktakeMonth(new Date(m.occurredAt)) !== previous) continue;
    const candidates = items.filter(
      (i) => i.sku === m.sku && (!m.location || i.location === m.location),
    );
    if (candidates.length !== 1)
      throw new BadRequestException(
        `出入库记录 ${m.recordId} 无法唯一匹配库存条目`,
      );
    const item = candidates[0];
    const entry = selected.get(item.recordId) || {
      item,
      reasons: ['movement'] as StocktakeReason[],
      movementIds: [],
    };
    if (!entry.movementIds.includes(m.recordId))
      entry.movementIds.push(m.recordId);
    selected.set(item.recordId, entry);
  }
  const randomTarget = Math.ceil(items.length / 10);
  const rank = (i: InventoryManagementItem) =>
    createHash('sha256').update(`${input.seed}:${i.recordId}`).digest('hex');
  const pool = items
    .filter((i) => !excluded.has(i.recordId))
    .map((i) => ({ i, rank: rank(i) }))
    .sort(
      (a, b) =>
        a.rank.localeCompare(b.rank) ||
        a.i.recordId.localeCompare(b.i.recordId),
    );
  for (const { i } of pool.slice(0, randomTarget)) {
    const entry = selected.get(i.recordId) || {
      item: i,
      reasons: [],
      movementIds: [],
    };
    entry.reasons.push('random');
    selected.set(i.recordId, entry);
  }
  return {
    selected: [...selected.values()],
    randomTarget,
    shortfall: Math.max(0, randomTarget - pool.length),
    excludedRecordIds: items
      .filter((i) => excluded.has(i.recordId))
      .map((i) => i.recordId),
  };
}
