import type {
  PurchaseInventoryAlertItem,
  PurchaseInventoryMovementItem,
} from '../../shared/purchase-inventory.interface';
import * as inventoryLogic from '../../client/src/pages/InventoryManagement/logic';

const { filterInventoryAlerts, filterInventoryMovements } = inventoryLogic;

interface PendingPurchaseTestItem {
  executionRecordId: string;
}

type PendingPurchaseDeepLinkResolution<T> =
  | { status: 'found'; item: T }
  | { status: 'missing' }
  | { status: 'read_failed' };

type PendingPurchaseDeepLinkResolver = <T extends PendingPurchaseTestItem>(
  executionRecordId: string,
  load: (forceRefresh: boolean) => Promise<T[] | null>,
) => Promise<PendingPurchaseDeepLinkResolution<T>>;

const resolvePendingPurchaseDeepLink = (
  inventoryLogic as unknown as {
    resolvePendingPurchaseDeepLink?: PendingPurchaseDeepLinkResolver;
  }
).resolvePendingPurchaseDeepLink;

describe('inventory management logic', () => {
  it('searches inventory alerts by item, category, warehouse, and location', () => {
    const alerts = [
      {
        recordId: 'alert-1',
        name: '接触器 CJX2-2510',
        sku: 'SKU-001',
        category: '电气设备',
        building: 'A楼库房',
        location: 'A-01-02',
        availableQuantity: 2,
        reorderPoint: 10,
        difference: -8,
        unit: '件',
        value: 1200,
        owners: ['张三'],
        riskTone: 'critical',
      },
    ] satisfies PurchaseInventoryAlertItem[];

    expect(filterInventoryAlerts(alerts, '电气')).toHaveLength(1);
    expect(filterInventoryAlerts(alerts, 'A-01-02')).toHaveLength(1);
    expect(filterInventoryAlerts(alerts, '消防')).toHaveLength(0);
  });

  it('searches inventory movements without hiding live movement types', () => {
    const movements = [
      {
        recordId: 'movement-1',
        type: 'inbound',
        name: '接触器 CJX2-2510',
        sku: 'SKU-001',
        building: 'A楼库房',
        location: 'A-01-02',
        quantity: 12,
        status: '已入库',
        sourceOrReason: '采购入库',
        operator: '张三',
        createdAt: '2026-07-10T02:00:00.000Z',
      },
    ] satisfies PurchaseInventoryMovementItem[];

    expect(filterInventoryMovements(movements, '张三')).toHaveLength(1);
    expect(filterInventoryMovements(movements, '采购入库')).toHaveLength(1);
    expect(filterInventoryMovements(movements, '出库')).toHaveLength(0);
  });

  it('opens a deep-linked pending purchase from the cache without forcing a second read', async () => {
    expect(typeof resolvePendingPurchaseDeepLink).toBe('function');
    if (!resolvePendingPurchaseDeepLink) return;
    const target = { executionRecordId: 'exec-target' };
    const load = jest.fn().mockResolvedValue([target]);

    await expect(
      resolvePendingPurchaseDeepLink(target.executionRecordId, load),
    ).resolves.toEqual({ status: 'found', item: target });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(false);
  });

  it('refreshes only after a cached deep-link result does not contain the target', async () => {
    expect(typeof resolvePendingPurchaseDeepLink).toBe('function');
    if (!resolvePendingPurchaseDeepLink) return;
    const target = { executionRecordId: 'exec-target' };
    const load = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([target]);

    await expect(
      resolvePendingPurchaseDeepLink(target.executionRecordId, load),
    ).resolves.toEqual({ status: 'found', item: target });
    expect(load.mock.calls).toEqual([[false], [true]]);
  });

  it('reports a single read failure when the cache-first deep-link request fails', async () => {
    expect(typeof resolvePendingPurchaseDeepLink).toBe('function');
    if (!resolvePendingPurchaseDeepLink) return;
    const load = jest.fn().mockResolvedValue(null);

    await expect(
      resolvePendingPurchaseDeepLink('exec-target', load),
    ).resolves.toEqual({ status: 'read_failed' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(false);
  });
});
