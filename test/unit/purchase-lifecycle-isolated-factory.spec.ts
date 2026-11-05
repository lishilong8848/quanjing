// Business isolation tests run after release activation. Release gating is tested separately.
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
  runHotfixInitialization: (_owner: object, initialize: () => unknown) => initialize(),
  cancelHotfixInitialization: async () => {},
}));
import { PurchaseLifecycleIsolatedFactory, type LifecycleIsolatedFactoryOptions } from '../../server/modules/purchase-inventory/purchase-lifecycle-isolated-factory';
import { PurchaseLifecycleDeliveryService } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery.service';

function setup() {
  const calls = { pending: jest.fn(async () => []), expired: jest.fn(async () => []), prepared: jest.fn(async () => []), report: jest.fn() };
  const checks = {
    writerFence: jest.fn(async () => true), applicationRecovery: jest.fn(async () => true), callbacksAndMessages: jest.fn(async () => true),
    attachmentsAndPayments: jest.fn(async () => true), identityAndAuthorization: jest.fn(async () => true), rollbackProtection: jest.fn(async () => true),
    deliveryAndReconciliation: jest.fn(async () => true), hasExistingWork: jest.fn(async () => false),
  };
  const options = {
    store: { listExpiredPreparedLifecycleDeliveries: calls.prepared, listExpiredLifecycleContinuations: calls.expired, listPendingLifecycleDeliveries: calls.pending },
    gateway: {}, access: {}, currentAppId: () => 'cli_test', environment: () => ({}), attachmentBaseUrl: () => 'https://example.test', checks, reportFailure: calls.report, intervalMs: 1000,
  } as unknown as LifecycleIsolatedFactoryOptions;
  return { factory: new PurchaseLifecycleIsolatedFactory(options), calls, checks, options };
}

describe('isolated lifecycle runtime composition', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('passes the actual synchronous payment capability into the real delivery worker without enabling it by default', async () => {
    const {options}=setup(),ready=jest.fn(()=>false),original=PurchaseLifecycleDeliveryService.prototype.run;
    const seen:unknown[]=[];
    jest.spyOn(PurchaseLifecycleDeliveryService.prototype,'run').mockImplementation(function(this:PurchaseLifecycleDeliveryService,limit?:number){
      seen.push((this as unknown as {paymentUploadReady:()=>boolean}).paymentUploadReady);
      return original.call(this,limit);
    });
    const factory=new PurchaseLifecycleIsolatedFactory({...options,paymentUploadReady:ready});
    await factory.start('drain');await jest.advanceTimersByTimeAsync(1000);await factory.stop();
    expect(seen).toEqual([ready]);expect(ready).not.toHaveBeenCalled();
    const defaults=new PurchaseLifecycleIsolatedFactory(options);
    await defaults.start('drain');await jest.advanceTimersByTimeAsync(1000);await defaults.stop();
    expect(typeof seen[1]).toBe('function');expect((seen[1] as ()=>boolean)()).toBe(false);
  });

  it('does nothing on construction and refuses off when existing work cannot safely be abandoned', async () => {
    const { factory, calls, checks } = setup();
    expect(factory.isReady()).toBe(false);
    expect(calls.pending).not.toHaveBeenCalled();
    checks.hasExistingWork.mockResolvedValueOnce(true);
    await expect(factory.start('off')).rejects.toThrow('需要继续处理');
    checks.hasExistingWork.mockRejectedValueOnce(new Error('unavailable'));
    await expect(factory.start('off')).rejects.toThrow('无法核对');
    await expect(factory.start('off')).resolves.toBeUndefined();
    expect(calls.pending).not.toHaveBeenCalled();
  });

  it('drains existing work without admitting new applications', async () => {
    const { factory, calls, checks } = setup();
    checks.hasExistingWork.mockResolvedValue(true);
    await factory.start('drain');
    expect(factory.isReady()).toBe(false);
    expect(factory.isProcessing()).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(calls.pending).toHaveBeenCalledTimes(1);
    await expect(factory.stop()).resolves.toBe('pending');
    expect(calls.report).toHaveBeenCalledWith('PURCHASE_LIFECYCLE_WORK_PENDING');
    expect(factory.isProcessing()).toBe(false);
  });

  it.each(['writerFence', 'applicationRecovery', 'callbacksAndMessages', 'attachmentsAndPayments', 'identityAndAuthorization', 'rollbackProtection', 'deliveryAndReconciliation'] as const)('fails closed when %s is unproved', async key => {
    const { factory, checks, calls } = setup();
    checks[key].mockResolvedValue(false);
    await expect(factory.start('new')).rejects.toThrow('未就绪');
    expect(factory.isReady()).toBe(false);
    await jest.advanceTimersByTimeAsync(2000);
    expect(calls.pending).not.toHaveBeenCalled();
  });

  it('withdraws admission and pauses dispatch when a guard fails after startup', async () => {
    const { factory, checks, calls } = setup();
    await factory.start('new');
    expect(factory.isReady()).toBe(true);
    checks.writerFence.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(factory.isReady()).toBe(false);
    expect(calls.pending).not.toHaveBeenCalled();
    expect(calls.report).toHaveBeenCalledWith('PURCHASE_LIFECYCLE_NOT_READY');
    checks.writerFence.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(factory.isReady()).toBe(true);
    expect(calls.pending).toHaveBeenCalledTimes(1);
    await expect(factory.stop()).resolves.toBe('clear');
  });

  it('does not claim clean shutdown when the work inventory fails', async () => {
    const { factory, checks, calls } = setup();
    await factory.start('drain');
    checks.hasExistingWork.mockRejectedValue(new Error('unavailable'));
    await expect(factory.stop()).resolves.toBe('unknown');
    expect(calls.report).toHaveBeenCalledWith('PURCHASE_LIFECYCLE_WORK_UNKNOWN');
  });

  it('serializes concurrent starts and requires authoritative existing-work inspection', async () => {
    const { factory, checks, calls } = setup();
    const outcomes = await Promise.allSettled([factory.start('new'), factory.start('new')]);
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    await jest.advanceTimersByTimeAsync(1000);
    expect(calls.pending).toHaveBeenCalledTimes(1);
    await factory.stop();
    checks.hasExistingWork.mockRejectedValue(new Error('unavailable'));
    await expect(factory.start('new')).rejects.toThrow('未就绪');
  });
});
