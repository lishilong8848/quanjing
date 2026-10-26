import { InventoryOutboundApprovalScheduler } from './inventory-outbound-approval.scheduler';

describe('InventoryOutboundApprovalScheduler', () => {
  const originalInterval =
    process.env.INVENTORY_OUTBOUND_APPROVAL_TASK_POLL_INTERVAL_MS;
  const originalRecoveryInterval =
    process.env.INVENTORY_OUTBOUND_APPROVAL_RECOVERY_INTERVAL_MS;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.INVENTORY_OUTBOUND_APPROVAL_TASK_POLL_INTERVAL_MS = '1000';
    process.env.INVENTORY_OUTBOUND_APPROVAL_RECOVERY_INTERVAL_MS = '3000';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalInterval === undefined) {
      delete process.env.INVENTORY_OUTBOUND_APPROVAL_TASK_POLL_INTERVAL_MS;
    } else {
      process.env.INVENTORY_OUTBOUND_APPROVAL_TASK_POLL_INTERVAL_MS =
        originalInterval;
    }
    if (originalRecoveryInterval === undefined) {
      delete process.env.INVENTORY_OUTBOUND_APPROVAL_RECOVERY_INTERVAL_MS;
    } else {
      process.env.INVENTORY_OUTBOUND_APPROVAL_RECOVERY_INTERVAL_MS =
        originalRecoveryInterval;
    }
  });

  it('does not start when the approval workflow is not configured', async () => {
    const service = createService(false);
    const scheduler = new InventoryOutboundApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await flushPromises();
    jest.advanceTimersByTime(5_000);
    await flushPromises();

    expect(service.runPending).not.toHaveBeenCalled();
    expect(service.recoverFromBase).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy();
  });

  it('runs immediately, polls periodically and stops cleanly', async () => {
    const service = createService(true);
    const scheduler = new InventoryOutboundApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await flushPromises();
    expect(service.runPending).toHaveBeenCalledTimes(1);
    expect(service.recoverFromBase).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_000);
    await flushPromises();
    expect(service.runPending).toHaveBeenCalledTimes(2);
    expect(service.recoverFromBase).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_000);
    await flushPromises();
    jest.advanceTimersByTime(1_000);
    await flushPromises();
    expect(service.runPending).toHaveBeenCalledTimes(4);
    expect(service.recoverFromBase).toHaveBeenCalledTimes(2);

    await scheduler.onModuleDestroy();
    jest.advanceTimersByTime(2_000);
    await flushPromises();
    expect(service.runPending).toHaveBeenCalledTimes(4);
  });

  it('prevents overlapping polls while a previous run is still active', async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createService(true);
    service.runPending.mockImplementationOnce(async () => {
      await firstRun;
      return { processed: 0, failed: 0 };
    });
    const scheduler = new InventoryOutboundApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await flushPromises();
    jest.advanceTimersByTime(3_000);
    await flushPromises();
    expect(service.runPending).toHaveBeenCalledTimes(1);

    release();
    await flushPromises();
    jest.advanceTimersByTime(1_000);
    await flushPromises();
    expect(service.runPending).toHaveBeenCalledTimes(2);
    await scheduler.onModuleDestroy();
  });

  it('continues polling after a failed run', async () => {
    const service = createService(true);
    service.runPending.mockRejectedValueOnce(new Error('temporary failure'));
    const scheduler = new InventoryOutboundApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await flushPromises();
    jest.advanceTimersByTime(1_000);
    await flushPromises();

    expect(service.runPending).toHaveBeenCalledTimes(2);
    await scheduler.onModuleDestroy();
  });

  it('continues local work when a periodic Base recovery scan fails', async () => {
    const service = createService(true);
    service.recoverFromBase.mockRejectedValueOnce(
      new Error('temporary Base recovery failure'),
    );
    const scheduler = new InventoryOutboundApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await flushPromises();

    expect(service.recoverFromBase).toHaveBeenCalledTimes(1);
    expect(service.runPending).toHaveBeenCalledTimes(1);
    await scheduler.onModuleDestroy();
  });

  it('supports an explicit run without starting a timer', async () => {
    const service = createService(true);
    const scheduler = new InventoryOutboundApprovalScheduler(service as never);

    await expect(scheduler.runNow()).resolves.toEqual({
      processed: 0,
      failed: 0,
    });
    expect(service.runPending).toHaveBeenCalledTimes(1);
    expect(service.recoverFromBase).toHaveBeenCalledTimes(1);
  });
});

function createService(enabled: boolean) {
  return {
    isEnabled: jest.fn(() => enabled),
    recoverFromBase: jest.fn(async () => ({
      scanned: 0,
      restored: 0,
      skipped: 0,
      failed: 0,
    })),
    runPending: jest.fn(async () => ({ processed: 0, failed: 0 })),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
