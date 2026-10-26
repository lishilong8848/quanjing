import { LeaveWorkflowScheduler } from './leave-workflow.scheduler';

describe('LeaveWorkflowScheduler', () => {
  it('drains already accepted tasks during a slow startup recovery', async () => {
    let recover!: (value: unknown) => void;
    const service = {
      isEnabled: () => true, setTaskWakeHandler: jest.fn(),
      recoverConfiguredApplications: jest.fn(() => new Promise(resolve => { recover = resolve; })),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
    const scheduler = new LeaveWorkflowScheduler(service as never);
    try {
      await scheduler.onModuleInit();
      await new Promise(resolve => setImmediate(resolve));
      expect(service.runPendingTasks).toHaveBeenCalledTimes(1);
    } finally {
      recover?.({ requestedCodes: [], matchedCodes: [], missingCodes: [], created: 0, existing: 0 });
      await scheduler.onModuleDestroy();
    }
  });
  it('registers an immediate task wake-up that is not blocked by startup recovery', async () => {
    let wake: (() => void) | null = null;
    let recover!: (value: unknown) => void;
    const service = {
      isEnabled: () => true,
      setTaskWakeHandler: jest.fn((handler: (() => void) | null) => { wake = handler; }),
      recoverConfiguredApplications: jest.fn(() => new Promise(resolve => { recover = resolve; })),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
    const scheduler = new LeaveWorkflowScheduler(service as never);
    try {
      await scheduler.onModuleInit();
      expect(service.setTaskWakeHandler).toHaveBeenCalledTimes(1);
      expect(typeof wake).toBe('function');
      wake!();
      await new Promise(resolve => setImmediate(resolve));
      expect(service.runPendingTasks).toHaveBeenCalledTimes(1);
    } finally {
      recover?.({ requestedCodes: [], matchedCodes: [], missingCodes: [], created: 0, existing: 0 });
      await scheduler.onModuleDestroy();
    }
  });
  it('recovers configured orphan records once before draining workflow tasks', async () => {
    const order: string[] = [];
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      recoverConfiguredApplications: jest.fn().mockImplementation(async () => {
        order.push('recover');
        return {
          requestedCodes: ['XJ-920-刘小杏', 'XJ-921-刘小杏'],
          matchedCodes: ['XJ-920-刘小杏', 'XJ-921-刘小杏'],
          missingCodes: [],
          created: 2,
          existing: 0,
        };
      }),
      runPendingTasks: jest.fn().mockImplementation(async () => {
        order.push('tasks');
        return { processed: 2, failed: 0 };
      }),
    };
    const scheduler = new LeaveWorkflowScheduler(service as never);

    await (scheduler as unknown as { poll(): Promise<void> }).poll();
    await (scheduler as unknown as { poll(): Promise<void> }).poll();

    expect(order).toEqual(['recover', 'tasks', 'tasks']);
    expect(service.recoverConfiguredApplications).toHaveBeenCalledTimes(1);
  });

  it('still drains accepted workflow tasks when startup recovery fails', async () => {
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      recoverConfiguredApplications: jest
        .fn()
        .mockRejectedValue(new Error('recovery temporarily unavailable')),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
    const scheduler = new LeaveWorkflowScheduler(service as never);

    await (scheduler as unknown as { poll(): Promise<void> }).poll();

    expect(service.runPendingTasks).toHaveBeenCalledTimes(1);
  });
});
