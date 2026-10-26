export const WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME_ENV =
  'FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME';
export const LEGACY_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME = '存放位置';
export const FORMAL_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME = '存放位置（程序）';
export const INBOUND_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME = '入库存放位置';

export function getWarehouseInventoryLocationFieldName(): string {
  return (
    process.env[WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME_ENV]?.trim() ||
    FORMAL_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME
  );
}

export function getWarehouseInventoryFormalLocationReadFieldNames(): string[] {
  return uniqueFieldNames([
    getWarehouseInventoryLocationFieldName(),
    LEGACY_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME,
  ]);
}

export function getWarehouseInventoryLocationReadFieldNames(): string[] {
  return uniqueFieldNames([
    getWarehouseInventoryLocationFieldName(),
    INBOUND_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME,
    LEGACY_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME,
  ]);
}

function uniqueFieldNames(names: string[]): string[] {
  return [...new Set(names)];
}
