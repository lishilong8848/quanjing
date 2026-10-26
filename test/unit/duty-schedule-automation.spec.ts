import { readFileSync } from 'fs';
import { join } from 'path';
import { DutyScheduleAutomationService } from '../../server/modules/duty-schedule/duty-schedule.automation';

function createAutomationService(
  refreshProgramModifiedDutyStaffFromRules = jest.fn(async () => ({
    success: true,
    source: 'startup',
  })),
) {
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  };
  const automation = new DutyScheduleAutomationService(
    { refreshProgramModifiedDutyStaffFromRules } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Object.defineProperty(automation, 'logger', { value: logger });

  return {
    automation,
    logger,
    refreshProgramModifiedDutyStaffFromRules,
  };
}

describe('DutyScheduleAutomationService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules one non-blocking program-modified refresh after application bootstrap', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T01:00:00.000Z'));
    const pendingRefresh = new Promise(() => undefined);
    const refreshProgramModifiedDutyStaffFromRules = jest.fn(
      () => pendingRefresh,
    );
    const { automation } = createAutomationService(
      refreshProgramModifiedDutyStaffFromRules,
    );
    const onApplicationBootstrap = (
      automation as unknown as { onApplicationBootstrap?: () => void }
    ).onApplicationBootstrap;

    expect(onApplicationBootstrap).toEqual(expect.any(Function));
    onApplicationBootstrap?.call(automation);
    onApplicationBootstrap?.call(automation);

    expect(refreshProgramModifiedDutyStaffFromRules).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();
    await Promise.resolve();

    expect(refreshProgramModifiedDutyStaffFromRules).toHaveBeenCalledTimes(1);
    expect(refreshProgramModifiedDutyStaffFromRules).toHaveBeenCalledWith({
      source: 'startup',
      startDate: '2026-07-21',
      endDate: '2026-08-05',
    });
  });

  it('reuses the in-flight startup refresh when the four-hour trigger overlaps', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T01:00:00.000Z'));
    const pendingRefresh = new Promise(() => undefined);
    const refreshProgramModifiedDutyStaffFromRules = jest.fn(
      () => pendingRefresh,
    );
    const { automation } = createAutomationService(
      refreshProgramModifiedDutyStaffFromRules,
    );

    automation.onApplicationBootstrap();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    void automation.autoRefreshProgramModifiedDutyStaffEvery4Hours();

    expect(refreshProgramModifiedDutyStaffFromRules).toHaveBeenCalledTimes(1);
  });

  it('logs a startup refresh failure without rejecting application bootstrap', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T01:00:00.000Z'));
    const refreshProgramModifiedDutyStaffFromRules = jest.fn(async () => {
      throw new Error('飞书暂不可用');
    });
    const { automation, logger } = createAutomationService(
      refreshProgramModifiedDutyStaffFromRules,
    );

    expect(() => automation.onApplicationBootstrap()).not.toThrow();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      '启动排班程序修改字段补偿失败：飞书暂不可用',
    );
  });

  it('refreshes only the program-modified field every 4 hours', () => {
    const source = readFileSync(
      join(process.cwd(), 'server/modules/duty-schedule/duty-schedule.automation.ts'),
      'utf8',
    );

    expect(source).toContain("@BindTrigger('cron1[10 */4 * * *]'");
    expect(source).toContain('autoRefreshProgramModifiedDutyStaffEvery4Hours');
    expect(source).toContain('getDutyProgramModifiedRefreshWindow()');
    expect(source).toContain("source: 'auto-4h'");
    expect(source).not.toContain('refreshDutyStaffActualFromRules');
    expect(source).not.toContain('getDutyStaffActualRefreshWindow');
    expect(source).not.toContain('getDutyStaffProgramModifiedSyncWindow');
    expect(
      source.match(/\.refreshProgramModifiedDutyStaffFromRules\(\{/g) || [],
    ).toHaveLength(1);
  });

  it('checks typhoon warnings hourly and delegates screenshot cadence to typhoon rules', () => {
    const source = readFileSync(
      join(process.cwd(), 'server/modules/duty-schedule/duty-schedule.automation.ts'),
      'utf8',
    );

    expect(source).toContain("@BindTrigger('cron1[17 * * * *]'");
    expect(source).toContain('autoCheckTyphoonWarningAndSendPathScreenshotHourly');
    expect(source).toContain('monitorTyphoonWarningAndSendPathScreenshot');
    expect(source).toContain('decideTyphoonPathScreenshotSend');
  });

  it('checks typhoon warnings on startup and every 30 minutes in the local server', () => {
    const automationSource = readFileSync(
      join(process.cwd(), 'server/modules/duty-schedule/duty-schedule.automation.ts'),
      'utf8',
    );
    const monitorSource = readFileSync(
      join(process.cwd(), 'server/modules/duty-schedule/typhoon-warning-monitor.service.ts'),
      'utf8',
    );
    const moduleSource = readFileSync(
      join(process.cwd(), 'server/modules/duty-schedule/duty-schedule.module.ts'),
      'utf8',
    );
    const controllerSource = readFileSync(
      join(process.cwd(), 'server/modules/duty-schedule/duty-schedule.controller.ts'),
      'utf8',
    );

    expect(monitorSource).toContain('OnModuleInit');
    expect(monitorSource).toContain('OnModuleDestroy');
    expect(monitorSource).toContain('implements OnModuleInit, OnModuleDestroy');
    expect(monitorSource).toContain('onModuleInit(): void');
    expect(monitorSource).toContain('onModuleDestroy(): void');
    expect(monitorSource).toContain('start(): void');
    expect(monitorSource).toContain('30 * 60 * 1000');
    expect(monitorSource).toContain('setInterval');
    expect(monitorSource).toContain('clearInterval');
    expect(monitorSource).toContain('runLocalTyphoonWarningMonitor');
    expect(automationSource).toContain('typhoonWarningMonitorInFlight');
    expect(automationSource).toContain("reason: 'monitor-in-flight'");
    expect(moduleSource).toContain('TyphoonWarningMonitorService');
    expect(controllerSource).toContain('TyphoonWarningMonitorService');
    expect(controllerSource).toContain('this.typhoonWarningMonitorService.start()');
  });
});
