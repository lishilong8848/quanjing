import {
  TodayOperationsAnomalyScheduler,
  getDueTodayOperationsAnomalyRun,
  getNextTodayOperationsAnomalyRun,
} from './today-operations-anomaly.scheduler';
import type { TodayOperationsAnomalyService } from './today-operations-anomaly.service';

describe('today operations anomaly 08:30 scheduler', () => {
  it('schedules 08:30 Asia/Shanghai exactly', () => {
    expect(
      getNextTodayOperationsAnomalyRun(
        new Date('2026-08-20T00:00:00.000Z'),
      ).scheduledAt.toISOString(),
    ).toBe('2026-08-20T00:30:00.000Z');
    expect(
      getNextTodayOperationsAnomalyRun(
        new Date('2026-08-20T01:00:00.000Z'),
      ).scheduledAt.toISOString(),
    ).toBe('2026-08-21T00:30:00.000Z');
  });

  it('reconciles only today after 08:30 and never runs early', () => {
    expect(
      getDueTodayOperationsAnomalyRun(new Date('2026-08-20T00:29:59.000Z')),
    ).toBeNull();
    expect(
      getDueTodayOperationsAnomalyRun(new Date('2026-08-20T12:00:00.000Z')),
    ).toMatchObject({ businessDate: '2026-08-20' });
  });

  it('runs discovery once per business date while continuing pending-task retries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T01:00:00.000Z'));
    const completedDates = new Set<string>();
    const service = {
      isBusinessDateScanCompleted: jest.fn(async (date: string) =>
        completedDates.has(date),
      ),
      markBusinessDateScanCompleted: jest.fn(async (date: string) => {
        completedDates.add(date);
      }),
      runForBusinessDate: jest.fn(async () => ({
        detected: 0,
        provisioned: 0,
        failed: 0,
      })),
      reconcileScheduleConsistencyForBusinessDate: jest.fn(async () => ({
        detected: 0,
        changed: false,
        autoResolved: false,
      })),
      runPendingTasks: jest.fn(async () => ({ processed: 0, failed: 0 })),
    };
    const scheduler = new TodayOperationsAnomalyScheduler(
      service as unknown as TodayOperationsAnomalyService,
    );
    const reconcile = () =>
      (
        scheduler as unknown as {
          reconcile(): Promise<void>;
        }
      ).reconcile();

    await reconcile();
    await reconcile();

    expect(service.runForBusinessDate).toHaveBeenCalledTimes(1);
    expect(service.markBusinessDateScanCompleted).toHaveBeenCalledWith(
      '2026-08-30',
    );
    expect(
      service.reconcileScheduleConsistencyForBusinessDate,
    ).toHaveBeenCalledTimes(1);
    expect(
      service.reconcileScheduleConsistencyForBusinessDate,
    ).toHaveBeenCalledWith('2026-08-30');
    expect(service.runPendingTasks).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
