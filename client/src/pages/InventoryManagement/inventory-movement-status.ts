type InventoryMovementStatusType = 'inbound' | 'outbound' | 'borrow';

const INBOUND_STATUS_LABELS: Readonly<Record<string, string>> = {
  添加: '新增物品入库',
  已有: '已有物品入库',
};

export function formatInventoryMovementStatusLabel(
  type: InventoryMovementStatusType,
  status: string,
): string {
  const normalized = status.trim();
  if (!normalized) return '状态未填写';
  if (type === 'inbound') {
    return INBOUND_STATUS_LABELS[normalized] ?? normalized;
  }
  return normalized;
}
