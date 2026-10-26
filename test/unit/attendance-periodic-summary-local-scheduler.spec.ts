import { AttendancePeriodicSummaryLocalSchedulerService } from '../../server/modules/duty-schedule/attendance-periodic-summary-local-scheduler.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AttendancePeriodicSummaryLocalSchedulerService', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses a one-shot timer to run Monday weekly summary at 10:00 Shanghai', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T01:59:59.000Z'));
    process.env = {
      ...previousEnv,
      NODE_ENV: 'production',
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_ENABLED: '',
      ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS: '60000',
      NANTONG_HOTFIX_SMOKE_MODE: '',
    };
    const service = { run: jest.fn().mockResolvedValue({ sent: true }) };
    const scheduler = new AttendancePeriodicSummaryLocalSchedulerService(
      service as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.run).toHaveBeenCalledWith(
      expect.objectContaining({
        period: 'weekly',
        startDate: '2026-09-07',
        endDate: '2026-09-13',
      }),
    );
    scheduler.onModuleDestroy();
  });

  it('does not inherit the attendance master switch in development', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T01:59:59.000Z'));
    process.env = {
      ...previousEnv,
      NODE_ENV: 'development',
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_ENABLED: '',
      ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS: '60000',
      NANTONG_HOTFIX_SMOKE_MODE: '',
    };
    const service = { run: jest.fn().mockResolvedValue({ sent: true }) };
    const scheduler = new AttendancePeriodicSummaryLocalSchedulerService(
      service as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.run).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('never runs in a hotfix smoke instance', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T01:59:59.000Z'));
    process.env = {
      ...previousEnv,
      NODE_ENV: 'production',
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS: '60000',
      NANTONG_HOTFIX_SMOKE_MODE: 'true',
    };
    const service = { run: jest.fn().mockResolvedValue({ sent: true }) };
    const scheduler = new AttendancePeriodicSummaryLocalSchedulerService(
      service as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.run).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('does not recover a weekly summary on the following day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T23:45:00.000Z'));
    process.env = {
      ...previousEnv,
      NODE_ENV: 'production',
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_ENABLED: '',
      ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS: '1000',
      NANTONG_HOTFIX_SMOKE_MODE: '',
    };
    const service = { run: jest.fn().mockResolvedValue({ skipped: true }) };
    const scheduler = new AttendancePeriodicSummaryLocalSchedulerService(
      service as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.run).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('recovers the due weekly summary inside the startup window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T02:15:00.000Z'));
    process.env = {
      ...previousEnv,
      NODE_ENV: 'production',
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_ENABLED: '',
      ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS: '1000',
      NANTONG_HOTFIX_SMOKE_MODE: '',
    };
    const service = { run: jest.fn().mockResolvedValue({ skipped: true }) };
    const scheduler = new AttendancePeriodicSummaryLocalSchedulerService(
      service as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.run).toHaveBeenCalledTimes(1);
    expect(service.run).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'weekly' }),
    );
    scheduler.onModuleDestroy();
  });

  it('retries a failed summary with a one-shot timer instead of a polling loop', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T01:59:59.000Z'));
    process.env = {
      ...previousEnv,
      NODE_ENV: 'production',
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_ENABLED: '',
      ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS: '60000',
      ATTENDANCE_PERIODIC_SUMMARY_RETRY_DELAY_MS: '1000',
      NANTONG_HOTFIX_SMOKE_MODE: '',
    };
    const service = {
      run: jest
        .fn()
        .mockRejectedValueOnce(new Error('Feishu down'))
        .mockResolvedValueOnce({ sent: true }),
    };
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const scheduler = new AttendancePeriodicSummaryLocalSchedulerService(
      service as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.run).toHaveBeenCalledTimes(2);
    expect(intervalSpy).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('does not retry a startup recovery after the 10:30 cutoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T02:29:58.000Z'));
    process.env = {
      ...previousEnv,
      NODE_ENV: 'production',
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_PERIODIC_SUMMARY_ENABLED: '',
      ATTENDANCE_PERIODIC_SUMMARY_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_PERIODIC_SUMMARY_RETRY_DELAY_MS: '1000',
      NANTONG_HOTFIX_SMOKE_MODE: '',
    };
    const service = {
      run: jest.fn().mockRejectedValue(new Error('Feishu down')),
    };
    const scheduler = new AttendancePeriodicSummaryLocalSchedulerService(
      service as never,
    );

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(service.run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(service.run).toHaveBeenCalledTimes(1);
    scheduler.onModuleDestroy();
  });

  it('registers the periodic summary store, service and scheduler in the duty module', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.module.ts',
      ),
      'utf8',
    );

    expect(source).toContain('AttendancePeriodicSummaryStore');
    expect(source).toContain('AttendancePeriodicSummaryService');
    expect(source).toContain('AttendancePeriodicSummaryLocalSchedulerService');
  });
});
