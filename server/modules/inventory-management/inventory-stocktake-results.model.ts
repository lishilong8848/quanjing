import type {
  StocktakeLine,
  StocktakeScope,
} from '../../../shared/inventory-stocktake.interface';
import { stocktakeWarehouse } from '../../../shared/inventory-stocktake-warehouse';

export const STOCKTAKE_RESULTS_BASE = 'QmxAbhXNJaA9YKsbfZyclzhGnSd';
export const STOCKTAKE_RESULTS_TABLE = 'tbl83d66e680c2bd';
export const STOCKTAKE_RESULTS_START = '2026-10';
export const STOCKTAKE_RESULT_FIELDS: Record<string, number> = {
  物品名称: 1,
  库存条目ID: 1,
  物品类别号: 1,
  型号规格: 1,
  品牌: 1,
  一级分类: 1,
  二级分类: 1,
  楼栋: 1,
  库房: 1,
  库位: 1,
  单位: 1,
  盘点月份: 1,
  盘点类型: 3,
  盘点状态: 3,
  盘点结果: 3,
  台账数量: 2,
  实盘数量: 2,
  差异数量: 2,
  确认人: 11,
  确认人工号: 1,
  确认时间: 5,
  差异说明: 1,
  最近撤销时间: 5,
};
export function stocktakeMonthField(month: string) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('盘点月份无效');
  return `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
}
export function queueStocktakeResult(
  line: StocktakeLine,
  clientMutationId?: string,
) {
  line.sync = {
    clientMutationId:
      clientMutationId ||
      line.sync?.clientMutationId ||
      `stocktake-${line.inventory.recordId}-v${line.version}`,
    version: line.version,
    status: 'pending',
    attempts: 0,
    retryAt: null,
    error: '',
    syncedAt: null,
  };
}
function localTime(value: string | null | undefined) {
  return value
    ? new Date(Date.parse(value) + 8 * 3600000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ')
    : '—';
}
export function stocktakeResultFields(
  month: string,
  scope: StocktakeScope,
  line: StocktakeLine,
  latest = true,
): Record<string, unknown> {
  const item = line.inventory;
  const confirmed = line.status === 'confirmed';
  const delta =
    confirmed && line.actualQuantity !== null
      ? Math.round((line.actualQuantity - item.quantity) * 1000) / 1000
      : null;
  const result =
    delta === null
      ? '未确认'
      : delta > 0
        ? '盘盈'
        : delta < 0
          ? '盘亏'
          : '账实一致';
  const type = scope === 'review' ? '库存核盘' : '重点抽盘';
  const state = confirmed ? '已确认' : '待盘';
  const person = confirmed ? line.confirmer : null;
  if (confirmed && !person?.openId) throw new Error('确认人缺少有效 Open ID');
  const fields: Record<string, unknown> = {
    [stocktakeMonthField(month)]: [
      `${type} · ${state}${line.lastUndoneAt && !confirmed ? '（已撤销）' : ''}`,
      `台账：${item.quantity}${item.unit || ''}；实盘：${line.actualQuantity ?? '未填'}；差异：${delta ?? '—'}；${result}`,
      `确认人：${person ? `${person.name} / ${person.employeeNo}` : '—'}；确认时间：${localTime(line.confirmedAt)}`,
      ...(line.note ? [`说明：${line.note}`] : []),
      ...(line.lastUndoneAt
        ? [`最近撤销：${localTime(line.lastUndoneAt)}`]
        : []),
    ].join('\n'),
  };
  if (latest)
    Object.assign(fields, {
      物品名称: item.name || '',
      库存条目ID: item.recordId,
      物品类别号: item.sku || '',
      型号规格: item.specification || '',
      品牌: item.brand || '',
      一级分类: item.primaryCategory || '',
      二级分类: item.secondaryCategory || '',
      楼栋: item.building,
      库房: stocktakeWarehouse(item.location || ''),
      库位: item.location || '',
      单位: item.unit || '',
      盘点月份: month,
      盘点类型: type,
      盘点状态: state,
      盘点结果: result,
      台账数量: item.quantity,
      实盘数量: line.actualQuantity,
      差异数量: delta,
      确认人: person ? [{ id: person.openId }] : [],
      确认人工号: person?.employeeNo || '',
      确认时间:
        confirmed && line.confirmedAt ? Date.parse(line.confirmedAt) : null,
      差异说明: line.note,
      最近撤销时间: line.lastUndoneAt ? Date.parse(line.lastUndoneAt) : null,
    });
  return fields;
}
export function stocktakeCellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((entry) =>
        typeof entry === 'object' && entry
          ? String(entry.text ?? '')
          : String(entry),
      )
      .join('');
  return String(value);
}
export function verifyStocktakeResult(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
) {
  for (const [name, value] of Object.entries(expected)) {
    const received = actual[name];
    const type = STOCKTAKE_RESULT_FIELDS[name] || 1;
    let valid: boolean;
    if (type === 11) {
      const ids = (v: unknown) =>
        Array.isArray(v)
          ? v
              .map((p) => p?.id)
              .filter(Boolean)
              .sort()
              .join(',')
          : '';
      valid = ids(value) === ids(received);
    } else if (type === 2 || type === 5) {
      valid =
        value === null
          ? received == null || received === ''
          : typeof received === 'number' &&
            Math.abs(received - Number(value)) < 0.000001;
    } else valid = stocktakeCellText(value) === stocktakeCellText(received);
    if (!valid) throw new Error(`飞书字段“${name}”回读不一致`);
  }
}
