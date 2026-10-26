import type {
  StocktakeLine,
  StocktakeOverview,
  StocktakeDraft,
  StocktakeBulkRequest,
  StocktakeSheet,
} from '@shared/inventory-stocktake.interface';
import type {
  InventoryStocktakeSummary,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';
import { stocktakeWarehouse as sharedStocktakeWarehouse } from '@shared/inventory-stocktake-warehouse';
export const stocktakeCurrentMonth = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
export function stocktakeGenerationErrors(
  failures: { building: WarehouseBuilding; error: string }[],
): string {
  const groups = new Map<string, WarehouseBuilding[]>();
  for (const failure of failures) {
    const buildings = groups.get(failure.error) || [];
    buildings.push(failure.building);
    groups.set(failure.error, buildings);
  }
  return [...groups]
    .map(([error, buildings]) => `${buildings.join('、')}：${error}`)
    .join('；');
}
export function shiftStocktakeMonth(month: string, offset: number): string {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1))
    .toISOString()
    .slice(0, 7);
}
export function resolveStocktakeMonth(
  value: string | null,
  current = stocktakeCurrentMonth(),
): string {
  return value && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value) && value <= current
    ? value
    : current;
}
export function monthlyStocktakeProgress(
  month: string,
  history: InventoryStocktakeSummary[],
  overview: StocktakeOverview | null,
  allowedBuildings: readonly WarehouseBuilding[],
): InventoryStocktakeSummary {
  const [year, monthNumber] = month.split('-').map(Number);
  const legacy = history.find(
    (summary) => summary.year === year && summary.month === monthNumber,
  );
  const buildings = allowedBuildings.map((building) => {
    const previous = legacy?.buildings.find(
      (item) => item.building === building,
    );
    const current =
      overview?.month === month
        ? overview.buildings.find((item) => item.building === building)
        : null;
    const total =
      current && current.status !== 'not_started'
        ? current.total + (current.review?.total || 0)
        : (previous?.total ?? 0);
    const completed =
      current && current.status !== 'not_started'
        ? current.confirmed + (current.review?.confirmed || 0)
        : (previous?.completed ?? 0);
    return {
      building,
      total,
      completed,
      completionRate: total ? Math.round((completed / total) * 100) : 0,
      responsible: previous?.responsible ?? '',
    };
  });
  const total = buildings.reduce((sum, item) => sum + item.total, 0),
    completed = buildings.reduce((sum, item) => sum + item.completed, 0);
  return {
    year,
    month: monthNumber,
    total,
    completed,
    completionRate: total ? Math.round((completed / total) * 100) : 0,
    buildings,
  };
}
export type StocktakeFilter =
  | 'all'
  | 'pending'
  | 'confirmed'
  | 'difference'
  | 'surplus'
  | 'shortage'
  | 'matched';
export function stocktakeWarehouse(location: string): string {
  return sharedStocktakeWarehouse(location);
}
export interface StocktakeWarehouseGroup {
  name: string;
  lines: StocktakeLine[];
  total: number;
  confirmed: number;
}
export function groupStocktakeLines(
  lines: StocktakeLine[],
): StocktakeWarehouseGroup[] {
  const groups = new Map<string, StocktakeLine[]>();
  for (const line of lines) {
    const name = stocktakeWarehouse(line.inventory.location);
    const items = groups.get(name) || [];
    items.push(line);
    groups.set(name, items);
  }
  const compare = new Intl.Collator('zh-CN', { numeric: true }).compare;
  return [...groups]
    .sort(([a], [b]) => compare(a, b))
    .map(([name, items]) => ({
      name,
      total: items.length,
      confirmed: items.filter((l) => l.status === 'confirmed').length,
      lines: items.sort(
        (a, b) =>
          compare(a.inventory.location, b.inventory.location) ||
          compare(a.inventory.sku, b.inventory.sku) ||
          compare(a.inventory.recordId, b.inventory.recordId),
      ),
    }));
}
export function stocktakeGroupPage(
  groups: StocktakeWarehouseGroup[],
  page: number,
  pageSize: number,
): StocktakeWarehouseGroup[] {
  let offset = 0;
  const start = (page - 1) * pageSize,
    end = start + pageSize;
  return groups.flatMap((group) => {
    const from = Math.max(0, start - offset),
      to = Math.min(group.lines.length, end - offset);
    offset += group.lines.length;
    return to > from ? [{ ...group, lines: group.lines.slice(from, to) }] : [];
  });
}
export function isStocktakeDraftDirty(
  line: StocktakeDraft,
  draft: {
    quantity: string;
    person: StocktakeDraft['confirmer'];
    note: string;
  },
): boolean {
  return (
    draft.quantity.trim() !==
      (line.actualQuantity === null ? '' : String(line.actualQuantity)) ||
    draft.person?.recordId !== line.confirmer?.recordId ||
    draft.person?.openId !== line.confirmer?.openId ||
    draft.note !== line.note
  );
}
export function buildStocktakeBulkLines(
  sheet: StocktakeSheet,
  drafts: Map<
    string,
    { quantity: string; person: StocktakeDraft['confirmer']; note: string }
  >,
): StocktakeBulkRequest['lines'] {
  return sheet.lines
    .filter((line) => line.status === 'draft')
    .map((line) => {
      const draft = drafts.get(
        `review:${sheet.month}:${sheet.building}:${line.inventory.recordId}`,
      );
      const actualQuantity = draft
        ? (parseStocktakeQuantity(draft.quantity) ?? line.actualQuantity)
        : line.actualQuantity;
      const note = draft?.note ?? line.note;
      if (
        actualQuantity !== null &&
        Math.abs(actualQuantity - line.inventory.quantity) > 0.000001 &&
        !note.trim()
      )
        throw new Error(`${line.inventory.name}：请填写差异说明`);
      return {
        recordId: line.inventory.recordId,
        expectedVersion: line.version,
        actualQuantity,
        confirmer: draft ? draft.person : line.confirmer,
        note,
      };
    });
}
export function parseStocktakeQuantity(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(value.trim()) || Number(value) > 1e12)
    throw new Error('实际数量须为非负数，最多三位小数');
  return Number(value);
}
export function filterStocktakeLines(
  lines: StocktakeLine[],
  filter: StocktakeFilter,
  search: string,
): StocktakeLine[] {
  const query = search.trim().toLocaleLowerCase();
  return lines.filter((line) => {
    if (filter === 'pending' && line.status !== 'draft') return false;
    if (filter === 'confirmed' && line.status !== 'confirmed') return false;
    if (['surplus', 'shortage', 'matched'].includes(filter)) {
      if (line.status !== 'confirmed' || line.actualQuantity === null)
        return false;
      const delta = line.actualQuantity - line.inventory.quantity;
      if (filter === 'surplus' && delta <= 0.000001) return false;
      if (filter === 'shortage' && delta >= -0.000001) return false;
      if (filter === 'matched' && Math.abs(delta) > 0.000001) return false;
    }
    if (
      filter === 'difference' &&
      (line.actualQuantity === null ||
        Math.abs(line.actualQuantity - line.inventory.quantity) < 0.000001)
    )
      return false;
    return (
      !query ||
      [
        line.inventory.name,
        line.inventory.sku,
        line.inventory.location,
        line.inventory.specification,
        line.confirmer?.name,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query)
    );
  });
}
export function stocktakeError(error: unknown): string {
  const value = (error || {}) as {
    response?: { data?: { message?: unknown } };
    message?: string;
    code?: string;
    name?: string;
  };
  const message = value.response?.data?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('；');
  if (
    ['ECONNABORTED', 'ETIMEDOUT'].includes(value.code || '') ||
    value.name === 'TimeoutError'
  )
    return '请求超时，保存结果待确认，请保留草稿并重试';
  return value.message || '未能确认保存结果，请保留草稿并重试';
}
