export type InventoryNotificationBatchKind = 'inbound' | 'outbound';

const BATCH_MUTATION_ID =
  /^inventory_batch_(inbound|outbound)_([a-f0-9]{32})_(\d{1,2})$/u;

export function inventoryNotificationBatchId(
  mutationId: unknown,
  kind: InventoryNotificationBatchKind,
): string | null {
  if (typeof mutationId !== 'string') return null;
  const match = BATCH_MUTATION_ID.exec(mutationId);
  return match?.[1] === kind ? match[2] : null;
}
