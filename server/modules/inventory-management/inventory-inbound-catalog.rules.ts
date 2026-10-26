import type {
  InventoryNewItemInput,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import { getWarehouseInventoryLocationFieldName } from '../../common/config/warehouse-inventory-location.config';

export interface InventoryCatalogSkuRecord {
  building?: string;
  secondaryCategory: string;
  sku: string;
}

export function generateInventorySku(input: {
  secondaryCategory: string;
  catalogRecords: readonly InventoryCatalogSkuRecord[];
}): string {
  const secondaryCategory = input.secondaryCategory.trim();
  const prefix = secondaryCategory.match(/([A-Z]\d)$/)?.[1];
  if (!prefix) {
    throw new Error(
      `二级分类“${secondaryCategory || '空值'}”末尾缺少类别代码（如 A2）`,
    );
  }

  const matcher = new RegExp(`^${escapeRegExp(prefix)}(\\d{3})$`);
  let maximumSerial = 0;
  for (const record of input.catalogRecords) {
    if (record.secondaryCategory.trim() !== secondaryCategory) continue;
    const match = matcher.exec(record.sku);
    if (!match) continue;
    maximumSerial = Math.max(maximumSerial, Number(match[1]));
  }

  const nextSerial = maximumSerial + 1;
  if (nextSerial > 999) {
    throw new Error(
      `物品类别号序号超过 999，二级分类“${secondaryCategory}”已无可用编号`,
    );
  }
  return `${prefix}${String(nextSerial).padStart(3, '0')}`;
}

export function buildInventoryCatalogFields(input: {
  building: WarehouseBuilding;
  sku: string;
  newItem: InventoryNewItemInput;
}): Record<string, string> {
  return {
    楼栋: input.building,
    物品类别号: input.sku,
    一级分类: input.newItem.primaryCategory,
    二级分类: input.newItem.secondaryCategory,
    名称: input.newItem.name,
    '规格型号、设备序列号': input.newItem.specification,
  };
}

export function buildInventoryLedgerFields(input: {
  building: WarehouseBuilding;
  sku: string;
  location: string;
}): Record<string, string | number> {
  const locationFieldName = getWarehouseInventoryLocationFieldName();
  return {
    楼栋: input.building,
    物品类别号: input.sku,
    初始化库存数量: 0,
    [locationFieldName]: input.location,
    入库存放位置: input.location,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
