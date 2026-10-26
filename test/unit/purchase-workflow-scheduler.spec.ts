jest.mock(
  '@server/common/config/external-services.config',
  () => ({ readEnv: jest.fn((name: string) => process.env[name] || '') }),
  { virtual: true },
);

import {
  nextPurchaseReminderRun,
  PurchaseWorkflowScheduler,
} from '../../server/modules/purchase-inventory/purchase-workflow.scheduler';
import { Test } from '@nestjs/testing';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';

describe('purchase workflow reminder scheduler', () => {
  it('rejects a production scheduler graph missing the warehouse handover provider', async () => {
    let compiled: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>> | undefined;
    try {
      await expect((async () => {
        compiled = await Test.createTestingModule({ providers: [PurchaseWorkflowScheduler, { provide: PurchaseWorkflowService, useValue: {} }] }).compile();
      })()).rejects.toThrow('WarehouseInboundHandoverService');
    } finally { await compiled?.close(); }
  });
  it('finishes the durable warehouse handover pass before consuming target notifications', async () => {
    const order: string[] = [];
    const service = { runPendingTasks: jest.fn(async () => { order.push('notification'); }) };
    const handovers = { runPending: jest.fn(async () => { order.push('handover'); }) };
    const scheduler = new PurchaseWorkflowScheduler(service as never, handovers as never, { runPendingTasks: async () => { order.push('receipt'); } } as never);
    await (scheduler as unknown as { pollPendingTasks(): Promise<void> }).pollPendingTasks();
    expect(order).toEqual(['handover', 'receipt', 'notification']);
    await scheduler.onModuleDestroy();
  });
  it('computes the daily warehouse reminder in Asia/Shanghai', () => {
    expect(
      nextPurchaseReminderRun(
        'warehouse',
        new Date('2026-07-11T02:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-07-11T03:00:00.000Z');
    expect(
      nextPurchaseReminderRun(
        'warehouse',
        new Date('2026-07-11T04:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-07-12T03:00:00.000Z');
  });

  it('keeps order and receipt reminders on the same alternating-day cadence', () => {
    expect(
      nextPurchaseReminderRun(
        'order',
        new Date('2026-07-11T00:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-07-11T02:00:00.000Z');
    expect(
      nextPurchaseReminderRun(
        'receipt',
        new Date('2026-07-11T00:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-07-11T03:30:00.000Z');
  });

  it('prevents overlapping manual runs and exposes the last result', async () => {
    let resolveRun!: (value: unknown) => void;
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      runReminders: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
      ),
    };
    const scheduler = new PurchaseWorkflowScheduler(service as never, { runPending: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }) } as never, { runPendingTasks: jest.fn().mockResolvedValue(undefined) } as never);

    const first = scheduler.run('warehouse');
    await expect(scheduler.run('warehouse')).rejects.toThrow('正在运行');
    resolveRun({
      code: 'warehouse',
      startedAt: '2026-07-11T03:00:00.000Z',
      finishedAt: '2026-07-11T03:00:01.000Z',
      processed: 2,
      failed: 0,
    });
    await first;

    expect(scheduler.getStatus().recentRuns[0]).toMatchObject({
      code: 'warehouse',
      processed: 2,
    });
    await scheduler.onModuleDestroy();
  });

  it('polls pending workflow tasks every five seconds without overlap and clears the timer', async () => {
    jest.useFakeTimers();
    const previousInterval =
      process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS;
    delete process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS;
    let resolveFirst!: () => void;
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      runReminders: jest.fn(),
      runPendingTasks: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue({
          processed: 0,
          failed: 0,
          recoveredApprovalRequests: 0,
          errors: [],
        }),
    };
    const scheduler = new PurchaseWorkflowScheduler(service as never, { runPending: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }) } as never, { runPendingTasks: jest.fn().mockResolvedValue(undefined) } as never);

    try {
      await scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(service.runPendingTasks).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(service.runPendingTasks).toHaveBeenCalledTimes(1);

      resolveFirst();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(service.runPendingTasks).toHaveBeenCalledTimes(2);

      await scheduler.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(service.runPendingTasks).toHaveBeenCalledTimes(2);
    } finally {
      await scheduler.onModuleDestroy();
      if (previousInterval === undefined) {
        delete process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS;
      } else {
        process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS = previousInterval;
      }
      jest.useRealTimers();
    }
  });

  it('continues consuming accepted durable tasks when optional workflow reminders are disabled', async () => {
    jest.useFakeTimers();
    const previousInterval =
      process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS;
    delete process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS;
    const service = {
      isEnabled: jest.fn().mockReturnValue(false),
      runReminders: jest.fn(),
      runPendingTasks: jest.fn().mockResolvedValue({
        processed: 1,
        failed: 0,
        recoveredApprovalRequests: 0,
        recoveredWarehouseInboundNotifications: 0,
        recoveredCompletionNotifications: 0,
        errors: [],
      }),
    };
    const scheduler = new PurchaseWorkflowScheduler(service as never, { runPending: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }) } as never, { runPendingTasks: jest.fn().mockResolvedValue(undefined) } as never);

    try {
      await scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(service.runPendingTasks).toHaveBeenCalledTimes(2);
      expect(service.runReminders).not.toHaveBeenCalled();
    } finally {
      await scheduler.onModuleDestroy();
      if (previousInterval === undefined) {
        delete process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS;
      } else {
        process.env.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS = previousInterval;
      }
      jest.useRealTimers();
    }
  });
});
