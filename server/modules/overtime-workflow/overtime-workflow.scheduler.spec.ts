import {
  nextOvertimeConfirmationReminderRun,
  OvertimeWorkflowScheduler,
} from './overtime-workflow.scheduler';

describe('OvertimeWorkflowScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('calculates the next Shanghai 09:00 reminder run', () => {
    expect(
      nextOvertimeConfirmationReminderRun(
        new Date('2026-08-12T00:59:59.000Z'),
      ).toISOString(),
    ).toBe('2026-08-12T01:00:00.000Z');
    expect(
      nextOvertimeConfirmationReminderRun(
        new Date('2026-08-12T01:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-08-13T01:00:00.000Z');
  });

  it('polls durable tasks without overlapping and schedules daily reminders', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:59:59.000Z'));
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      refreshPendingConfirmationCards: jest
        .fn()
        .mockResolvedValue({ refreshed: 0, failed: 0 }),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }),
      enqueueDueConfirmationReminders: jest.fn().mockResolvedValue(0),
    };
    const scheduler = new OvertimeWorkflowScheduler(service as never);
    await scheduler.onModuleInit();
    expect(jest.getTimerCount()).toBe(2);
    await Promise.resolve();
    expect(service.refreshPendingConfirmationCards).toHaveBeenCalledTimes(1);
    expect(service.enqueueDueConfirmationReminders).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(1);
    await scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries a failed 09:00 reminder scan shortly and stops retrying after success', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:59:59.000Z'));
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      refreshPendingConfirmationCards: jest
        .fn()
        .mockResolvedValue({ refreshed: 0, failed: 0 }),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }),
      enqueueDueConfirmationReminders: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValue(0),
    };
    const scheduler = new OvertimeWorkflowScheduler(service as never);

    await scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(59_999);
    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(2);

    await scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('limits same-day reminder scan retries when failures continue', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:59:59.000Z'));
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      refreshPendingConfirmationCards: jest
        .fn()
        .mockResolvedValue({ refreshed: 0, failed: 0 }),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }),
      enqueueDueConfirmationReminders: jest
        .fn()
        .mockRejectedValue(new Error('persistent failure')),
    };
    const scheduler = new OvertimeWorkflowScheduler(service as never);

    await scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(4);

    await scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('catches up today reminder once when started after Shanghai 09:00', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T02:00:00.000Z'));
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      refreshPendingConfirmationCards: jest
        .fn()
        .mockResolvedValue({ refreshed: 0, failed: 0 }),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }),
      enqueueDueConfirmationReminders: jest.fn().mockResolvedValue(0),
    };
    const scheduler = new OvertimeWorkflowScheduler(service as never);

    await scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(service.enqueueDueConfirmationReminders).toHaveBeenCalledTimes(1);

    await scheduler.onModuleDestroy();
  });

  it('does not start timers when the program workflow is disabled', async () => {
    jest.useFakeTimers();
    const service = { isEnabled: jest.fn().mockReturnValue(false) };
    const scheduler = new OvertimeWorkflowScheduler(service as never);
    await scheduler.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
  });
});
