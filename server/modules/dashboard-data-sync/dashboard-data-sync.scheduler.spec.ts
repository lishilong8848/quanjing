import {
  DashboardDataSyncScheduler,
  nextDashboardDataSyncRunAt,
} from './dashboard-data-sync.scheduler';

describe('DashboardDataSyncScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('calculates the next fixed Shanghai 03:10 run', () => {
    expect(
      nextDashboardDataSyncRunAt(
        new Date('2026-07-18T19:09:00.000Z'),
      ).toISOString(),
    ).toBe('2026-07-18T19:10:00.000Z');
    expect(
      nextDashboardDataSyncRunAt(
        new Date('2026-07-18T19:10:00.000Z'),
      ).toISOString(),
    ).toBe('2026-07-19T19:10:00.000Z');
  });

  it('starts a non-blocking catch-up sync when the service starts after 03:10', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T19:11:00.000Z'));
    const training = { refresh: jest.fn().mockResolvedValue(undefined) };
    const risk = {
      getAliDashboard: jest.fn().mockResolvedValue(undefined),
      getCrossDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = {
      getDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const certificate = { refresh: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new DashboardDataSyncScheduler(
      training as never,
      risk as never,
      lifecycle as never,
      certificate as never,
    );

    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(training.refresh).toHaveBeenCalledTimes(1);
    expect(risk.getAliDashboard).toHaveBeenCalledTimes(1);
    expect(risk.getCrossDashboard).toHaveBeenCalledTimes(1);
    expect(lifecycle.getDashboard).toHaveBeenCalledTimes(1);
    expect(certificate.refresh).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    scheduler.onModuleDestroy();
  });

  it('refreshes all four dashboards at 03:10 and reschedules for the next day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T19:09:00.000Z'));
    const training = { refresh: jest.fn().mockResolvedValue(undefined) };
    const risk = {
      getAliDashboard: jest.fn().mockResolvedValue(undefined),
      getCrossDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = {
      getDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const certificate = { refresh: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new DashboardDataSyncScheduler(
      training as never,
      risk as never,
      lifecycle as never,
      certificate as never,
    );

    scheduler.onModuleInit();
    scheduler.onModuleInit();

    expect(training.refresh).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(60 * 1000);

    expect(training.refresh).toHaveBeenCalledTimes(1);
    expect(risk.getAliDashboard).toHaveBeenCalledWith({ refresh: '1' });
    expect(risk.getCrossDashboard).toHaveBeenCalledWith({ refresh: '1' });
    expect(lifecycle.getDashboard).toHaveBeenCalledWith(true);
    expect(certificate.refresh).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('isolates a failed dashboard refresh from the other dashboards', async () => {
    const training = {
      refresh: jest.fn().mockResolvedValue(undefined),
    };
    const risk = {
      getAliDashboard: jest
        .fn()
        .mockRejectedValue(new Error('Ali source unavailable')),
      getCrossDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = {
      getDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const certificate = { refresh: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new DashboardDataSyncScheduler(
      training as never,
      risk as never,
      lifecycle as never,
      certificate as never,
    );

    await expect(scheduler.syncNow()).resolves.toBeUndefined();

    expect(training.refresh).toHaveBeenCalledTimes(1);
    expect(risk.getAliDashboard).toHaveBeenCalledTimes(1);
    expect(risk.getCrossDashboard).toHaveBeenCalledTimes(1);
    expect(lifecycle.getDashboard).toHaveBeenCalledTimes(1);
    expect(certificate.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not reschedule after shutdown while an active synchronization finishes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T19:09:00.000Z'));
    let releaseTraining!: () => void;
    const trainingGate = new Promise<void>((resolve) => {
      releaseTraining = resolve;
    });
    const training = { refresh: jest.fn(() => trainingGate) };
    const risk = {
      getAliDashboard: jest.fn().mockResolvedValue(undefined),
      getCrossDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = {
      getDashboard: jest.fn().mockResolvedValue(undefined),
    };
    const certificate = { refresh: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new DashboardDataSyncScheduler(
      training as never,
      risk as never,
      lifecycle as never,
      certificate as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(training.refresh).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    scheduler.onModuleDestroy();
    releaseTraining();
    await Promise.resolve();
    await Promise.resolve();

    expect(jest.getTimerCount()).toBe(0);
  });
});
