import { ContractManagementService } from '../../server/modules/contract-management/contract-management.service';
import { InventoryManagementService } from '../../server/modules/inventory-management/inventory-management.service';
import { PurchaseInventoryService } from '../../server/modules/purchase-inventory/purchase-inventory.service';

interface RefreshLifecycle {
  onModuleDestroy?: () => void;
  onModuleInit?: () => void;
}

describe('supply chain dashboard background sync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    ['purchase', () => new PurchaseInventoryService({ axiosRef: {} } as never)],
    [
      'inventory',
      () => new InventoryManagementService({ axiosRef: {} } as never),
    ],
    [
      'contract',
      () =>
        new ContractManagementService(
          { axiosRef: {} } as never,
          { enrichAndSchedule: jest.fn() } as never,
        ),
    ],
  ])('warms the %s dashboard after module startup', async (_name, create) => {
    const service = create();
    const lifecycle = service as unknown as RefreshLifecycle;
    expect(lifecycle.onModuleInit).toBeDefined();
    expect(lifecycle.onModuleDestroy).toBeDefined();
    const getDashboard = jest
      .spyOn(service, 'getDashboard')
      .mockResolvedValue({} as never);

    try {
      lifecycle.onModuleInit!();
      await jest.advanceTimersByTimeAsync(0);

      expect(getDashboard).toHaveBeenCalledTimes(1);
      expect(getDashboard).toHaveBeenCalledWith(false);
    } finally {
      lifecycle.onModuleDestroy?.();
    }
  });
});
