import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import { MonthlyOperationsResourcesService } from '../../server/modules/bitable-sync/monthly-operations-resources.service';
import { TodayOperationsOverviewService } from '../../server/modules/bitable-sync/today-operations-overview.service';
import { InventoryOutboundWorkflowService } from '../../server/modules/inventory-management/inventory-outbound-workflow.service';

describe('hotfix smoke startup isolation', () => {
  const previous = process.env.NANTONG_HOTFIX_SMOKE_MODE;

  beforeEach(() => {
    process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true';
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    else process.env.NANTONG_HOTFIX_SMOKE_MODE = previous;
  });

  it('does not recover real outbound tasks', async () => {
    const service = Object.create(InventoryOutboundWorkflowService.prototype);
    service.scanPendingTasks = jest.fn();
    service.scheduleRecoveryScan = jest.fn();

    await service.onModuleInit();

    expect(service.scanPendingTasks).not.toHaveBeenCalled();
    expect(service.scheduleRecoveryScan).not.toHaveBeenCalled();
  });

  it('does not refresh Feishu schedule caches', async () => {
    const service = Object.create(BitableSyncService.prototype);
    service.warmLeaveFormLocalSnapshots = jest.fn();
    service.refreshFeishuLocalCache = jest.fn();

    await service.onModuleInit();

    expect(service.warmLeaveFormLocalSnapshots).not.toHaveBeenCalled();
    expect(service.refreshFeishuLocalCache).not.toHaveBeenCalled();
  });

  it('does not start overview sync', () => {
    const overview = Object.create(TodayOperationsOverviewService.prototype);
    overview.triggerEventAndChangeSync = jest.fn();
    overview.onModuleInit();
    expect(overview.triggerEventAndChangeSync).not.toHaveBeenCalled();
  });

  it('does not schedule resource warmup in production smoke mode', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const resources = Object.create(
      MonthlyOperationsResourcesService.prototype,
    );
    resources.getResources = jest.fn();
    try {
      resources.onModuleInit();
      expect(resources.warmupTimer).toBeUndefined();
      expect(resources.getResources).not.toHaveBeenCalled();
    } finally {
      if (resources.warmupTimer) clearTimeout(resources.warmupTimer);
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
