import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AliMonthlyReportScheduler,
  resolveLatestDueAliMonthlyReportPeriod,
  resolveScheduledAliMonthlyReportPeriod,
} from '../../server/modules/ali-monthly-report/ali-monthly-report.scheduler';
import { AliMonthlyReportTaskCoordinatorService } from '../../server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service';
import {
  readAliMonthlyReportTaskStateFile,
  writeAliMonthlyReportTaskStateFile,
  type AliMonthlyReportAutomationType,
} from '../../server/modules/ali-monthly-report/ali-monthly-report-task-state';

describe('AliMonthlyReportScheduler', () => {
  const previousEnabled = process.env.ALI_MONTHLY_REPORT_SCHEDULER_ENABLED;

  afterEach(() => {
    if (previousEnabled === undefined) {
      delete process.env.ALI_MONTHLY_REPORT_SCHEDULER_ENABLED;
    } else {
      process.env.ALI_MONTHLY_REPORT_SCHEDULER_ENABLED = previousEnabled;
    }
    jest.useRealTimers();
  });

  it('uses the latest monthly due time at day 3 09:00 in Asia/Shanghai', () => {
    expect(
      resolveLatestDueAliMonthlyReportPeriod(
        new Date('2026-08-03T00:59:59.999Z'),
      ),
    ).toEqual({ year: 2026, month: 6 });
    expect(
      resolveLatestDueAliMonthlyReportPeriod(
        new Date('2026-08-03T01:00:00.000Z'),
      ),
    ).toEqual({ year: 2026, month: 7 });
    expect(
      resolveLatestDueAliMonthlyReportPeriod(
        new Date('2026-01-03T01:00:00.000Z'),
      ),
    ).toEqual({ year: 2025, month: 12 });
  });

  it('only resolves the primary and one catch-up window in Asia/Shanghai', () => {
    expect(
      resolveScheduledAliMonthlyReportPeriod(
        new Date('2026-08-03T01:00:00.000Z'),
      ),
    ).toEqual({ year: 2026, month: 7 });
    expect(
      resolveScheduledAliMonthlyReportPeriod(
        new Date('2026-08-05T01:00:59.999Z'),
      ),
    ).toEqual({ year: 2026, month: 7 });
    expect(
      resolveScheduledAliMonthlyReportPeriod(
        new Date('2026-08-03T01:01:00.000Z'),
      ),
    ).toBeNull();
    expect(
      resolveScheduledAliMonthlyReportPeriod(
        new Date('2026-08-17T05:25:00.000Z'),
      ),
    ).toBeNull();
  });

  it('does not run a startup catch-up outside the scheduled windows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-17T05:25:00.000Z'));
    const coordinator = {
      listExistingIncompletePeriods: jest
        .fn()
        .mockReturnValue([{ year: 2026, month: 7 }]),
      runDue: jest.fn().mockResolvedValue(null),
    };
    const scheduler = new AliMonthlyReportScheduler(coordinator as never);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(coordinator.runDue).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('runs once in the primary window and clears its timer', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T01:00:00.000Z'));
    const coordinator = {
      listExistingIncompletePeriods: jest.fn().mockReturnValue([]),
      runDue: jest.fn().mockResolvedValue(null),
    };
    const scheduler = new AliMonthlyReportScheduler(coordinator as never);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(coordinator.runDue).toHaveBeenCalledTimes(1);
    expect(coordinator.runDue).toHaveBeenLastCalledWith(
      { year: 2026, month: 7 },
      new Date('2026-08-03T01:00:00.000Z'),
    );

    await jest.advanceTimersByTimeAsync(60_000);
    expect(coordinator.runDue).toHaveBeenCalledTimes(1);

    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(coordinator.runDue).toHaveBeenCalledTimes(1);
  });

  it('does not traverse historical incomplete periods in the primary window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-03T01:00:00.000Z'));
    const coordinator = {
      listExistingIncompletePeriods: jest
        .fn()
        .mockReturnValue([{ year: 2026, month: 7 }]),
      runDue: jest.fn().mockResolvedValue(null),
    };
    const scheduler = new AliMonthlyReportScheduler(coordinator as never);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(coordinator.listExistingIncompletePeriods).not.toHaveBeenCalled();
    expect(coordinator.runDue.mock.calls).toEqual([
      [{ year: 2026, month: 8 }, new Date('2026-09-03T01:00:00.000Z')],
    ]);
    expect(coordinator.runDue).not.toHaveBeenCalledWith(
      { year: 2026, month: 6 },
      expect.any(Date),
    );

    scheduler.onModuleDestroy();
  });

  it('retries only the failed item in the single catch-up window', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-05T01:00:00.000Z');
    jest.setSystemTime(now);
    const root = mkdtempSync(join(tmpdir(), 'ali-monthly-scheduler-'));
    const statePath = join(root, 'state', 'automation.json');
    const julyAttempt = new Date('2026-08-03T01:00:00.000Z');
    writeAliMonthlyReportTaskStateFile(
      {
        version: 1,
        periods: {
          '2026-07': {
            year: 2026,
            month: 7,
            lastAttemptAt: julyAttempt.toISOString(),
            tasks: {
              alarm_analysis: {
                status: 'succeeded',
                attempts: 1,
                updatedAt: julyAttempt.toISOString(),
                fileName: 'alarm.xlsx',
                recordUrl:
                  'https://vnet.feishu.cn/base/app?recordId=july-alarm',
              },
              over_power: {
                status: 'failed',
                attempts: 1,
                updatedAt: julyAttempt.toISOString(),
                error: 'request timeout',
              },
              staff_roster: {
                status: 'succeeded',
                attempts: 1,
                updatedAt: julyAttempt.toISOString(),
                fileName: 'staff.xlsx',
                recordUrl:
                  'https://vnet.feishu.cn/base/app?recordId=july-staff',
              },
            },
          },
        },
      },
      { statePath },
    );
    const service = {
      generateForAutomation: jest.fn(
        async (
          reportType: AliMonthlyReportAutomationType,
          year: number,
          month: number,
        ) => ({
          success: true,
          reportType,
          year,
          month,
          message: 'ok',
          files: [
            {
              id: `${year}-${month}-${reportType}`,
              name: `${reportType}.xlsx`,
              size: '1KB',
              downloadUrl: `/files/${year}-${month}-${reportType}`,
            },
          ],
          logs: [],
          bitableRecordUrls: [
            `https://vnet.feishu.cn/base/app?recordId=${year}-${month}-${reportType}`,
          ],
        }),
      ),
      sendAutomationSummary: jest.fn().mockResolvedValue(undefined),
    };
    const coordinator = new AliMonthlyReportTaskCoordinatorService(
      service as never,
      { statePath, retryIntervalMs: 60 * 60 * 1_000 },
    );
    const scheduler = new AliMonthlyReportScheduler(coordinator);

    try {
      scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);

      expect(service.generateForAutomation.mock.calls).toEqual([
        ['over_power', 2026, 7],
      ]);
      const persisted = readAliMonthlyReportTaskStateFile({ statePath });
      expect(Object.keys(persisted.periods).sort()).toEqual(['2026-07']);
      expect(persisted.periods['2026-07'].tasks).toMatchObject({
        alarm_analysis: { status: 'succeeded', attempts: 1 },
        over_power: { status: 'succeeded', attempts: 2 },
        staff_roster: { status: 'succeeded', attempts: 1 },
      });
    } finally {
      scheduler.onModuleDestroy();
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not catch up or poll when the scheduler is explicitly disabled', async () => {
    jest.useFakeTimers();
    process.env.ALI_MONTHLY_REPORT_SCHEDULER_ENABLED = 'false';
    const coordinator = {
      runDue: jest.fn().mockResolvedValue(null),
    };
    const scheduler = new AliMonthlyReportScheduler(coordinator as never);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(coordinator.runDue).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });
});
