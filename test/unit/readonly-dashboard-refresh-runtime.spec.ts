import { HotfixActivation } from '../../server/common/hotfix-activation';
import type { HotfixReleaseProof } from '../../server/common/hotfix-release-proof';
let mockGate: HotfixActivation;
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  runHotfixInitialization: (owner: object, initialize: () => Promise<void>) => mockGate.run(owner, initialize),
  cancelHotfixInitialization: (owner: object) => mockGate.cancel(owner),
}));
import { CertificateDashboardService } from '../../server/modules/bitable-sync/certificate-dashboard.service';
import { EquipmentLifecycleService } from '../../server/modules/equipment-lifecycle/equipment-lifecycle.service';

describe.each([
  ['certificate', () => new CertificateDashboardService({} as never), 15 * 60_000],
  ['equipment', () => new EquipmentLifecycleService({} as never), 5 * 60_000],
] as const)('%s read-only periodic refresh activation', (_name, create, interval) => {
  let ready: boolean;
  const oldEnabled = process.env.FEISHU_SUPPLY_CHAIN_BACKGROUND_SYNC_ENABLED;
  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.FEISHU_SUPPLY_CHAIN_BACKGROUND_SYNC_ENABLED;
    ready = false;
    mockGate = new HotfixActivation({ inspect: (): HotfixReleaseProof => ({ mode: ready ? 'installed' : 'candidate-held', canInitialize: ready, canAcceptNewWork: ready, maintenance: !ready, deploymentId: 'synthetic' }), hasMaintenance: () => !ready });
  });
  afterEach(async () => {
    await mockGate.close();
    jest.useRealTimers();
    if (oldEnabled === undefined) delete process.env.FEISHU_SUPPLY_CHAIN_BACKGROUND_SYNC_ENABLED;
    else process.env.FEISHU_SUPPLY_CHAIN_BACKGROUND_SYNC_ENABLED = oldEnabled;
  });
  it('does not scan before activation, refreshes after activation and stops on destroy', async () => {
    const service = create();
    const read = jest.spyOn(service, 'getDashboard').mockResolvedValue({} as never);
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(interval);
    expect(read).not.toHaveBeenCalled();
    ready = true;
    mockGate.completeBootstrap();
    await mockGate.refresh();
    await jest.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(interval);
    expect(read).toHaveBeenLastCalledWith(true);
    expect(read).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(interval * 2);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('cancels initialization when destroyed while the release is held', async () => {
    const service = create();
    const read = jest.spyOn(service, 'getDashboard').mockResolvedValue({} as never);
    await service.onModuleInit();
    await service.onModuleDestroy();
    ready = true;
    mockGate.completeBootstrap();
    await mockGate.refresh();
    await jest.advanceTimersByTimeAsync(interval * 2);
    expect(read).not.toHaveBeenCalled();
  });
});
