jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: jest.fn((name: string) => process.env[name] || ''),
}));

import { ConflictException, Logger } from '@nestjs/common';
import { PurchaseManagerApprovalScheduler } from '../../server/modules/purchase-inventory/purchase-manager-approval.scheduler';
import { PurchaseWorkflowScheduler } from '../../server/modules/purchase-inventory/purchase-workflow.scheduler';

const originalEnv = { ...process.env };

describe('PurchaseManagerApprovalScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env = {
      ...originalEnv,
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
    };
    delete process.env.PURCHASE_MANAGER_APPROVAL_TASK_POLL_INTERVAL_MS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env = { ...originalEnv };
  });

  it('keeps the durable purchase worker and manager approval worker independent', async () => {
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      runPendingTasks: jest.fn().mockResolvedValue({
        processed: 0,
        failed: 0,
        manualReconciliation: 0,
        alerts: [],
        errors: [],
      }),
    };
    const scheduler = new PurchaseManagerApprovalScheduler(service as never);
    const legacyService = {
      isEnabled: jest.fn().mockReturnValue(false),
      runReminders: jest.fn(),
      runPendingTasks: jest.fn(),
      refreshWarehouseRecipientCacheIfDue: jest.fn().mockResolvedValue(undefined),
    };
    const legacyScheduler = new PurchaseWorkflowScheduler(
      legacyService as never,
      { runPending: jest.fn().mockResolvedValue(undefined) } as never,
      { runPendingTasks: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await scheduler.onModuleInit();
    await legacyScheduler.onModuleInit();
    expect(jest.getTimerCount()).toBe(3);
    await Promise.resolve();
    expect(service.runPendingTasks).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(service.runPendingTasks).toHaveBeenCalledTimes(2);
    expect(legacyService.runPendingTasks).toHaveBeenCalledTimes(2);
    expect(legacyService.runReminders).not.toHaveBeenCalled();
    expect(process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED).toBe('false');
    await scheduler.onModuleDestroy();
    await legacyScheduler.onModuleDestroy();
  });

  it('does not start a timer when manager approval is disabled', async () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    const service = {
      isEnabled: jest.fn().mockReturnValue(false),
      runPendingTasks: jest.fn(),
    };
    const scheduler = new PurchaseManagerApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(jest.getTimerCount()).toBe(0);
    expect(service.runPendingTasks).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy();
  });

  it('suppresses overlapping runs without starting a second worker', async () => {
    let resolveFirst!: () => void;
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      runPendingTasks: jest.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
      ),
    };
    const scheduler = new PurchaseManagerApprovalScheduler(service as never);

    const first = scheduler.run();
    await expect(scheduler.run()).rejects.toBeInstanceOf(ConflictException);
    expect(service.runPendingTasks).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    await scheduler.onModuleDestroy();
  });

  it('suppresses overlapping timer ticks and clears the timer on destroy', async () => {
    const cleanResult = {
      processed: 0,
      failed: 0,
      manualReconciliation: 0,
      alerts: [],
      errors: [],
    };
    let resolveFirst!: (value: typeof cleanResult) => void;
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      runPendingTasks: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<typeof cleanResult>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(cleanResult),
    };
    const scheduler = new PurchaseManagerApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await Promise.resolve();
    expect(service.runPendingTasks).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(service.runPendingTasks).toHaveBeenCalledTimes(1);

    resolveFirst(cleanResult);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(service.runPendingTasks).toHaveBeenCalledTimes(2);

    await scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(service.runPendingTasks).toHaveBeenCalledTimes(2);
  });

  it('logs only aggregate attention counts and stays silent for a clean run', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      runPendingTasks: jest
        .fn()
        .mockResolvedValueOnce({
          processed: 0,
          failed: 1,
          manualReconciliation: 2,
          alerts: ['manager-card:rec_secret requires attention'],
          errors: ['token=super-secret'],
        })
        .mockResolvedValueOnce({
          processed: 1,
          failed: 0,
          manualReconciliation: 0,
          alerts: [],
          errors: [],
        }),
    };
    const scheduler = new PurchaseManagerApprovalScheduler(service as never);

    await scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '采购经理审批后台任务需要关注：失败 1，人工核对 2，告警 1',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('rec_secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret');

    await jest.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledTimes(1);
    await scheduler.onModuleDestroy();
    warn.mockRestore();
  });
});
