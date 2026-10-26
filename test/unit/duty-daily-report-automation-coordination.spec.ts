import { DutyScheduleAutomationService } from '../../server/modules/duty-schedule/duty-schedule.automation';

describe('DutyScheduleAutomationService daily report task coordination', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
  });

  it('does not refresh program-modified duty staff during hotfix smoke validation', async () => {
    jest.useFakeTimers();
    process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true';
    const dutyScheduleService = {
      refreshProgramModifiedDutyStaffFromRules: jest.fn().mockResolvedValue({
        success: true,
        message: 'should not run',
      }),
    };
    const Automation = DutyScheduleAutomationService as unknown as new (
      scheduleService: typeof dutyScheduleService,
      bitableSyncService: unknown,
      screenshotService: unknown,
      taskCoordinator: unknown,
    ) => DutyScheduleAutomationService;
    const service = new Automation(dutyScheduleService, {}, {}, {});

    service.onApplicationBootstrap();
    await jest.runAllTimersAsync();

    expect(
      dutyScheduleService.refreshProgramModifiedDutyStaffFromRules,
    ).not.toHaveBeenCalled();
  });

  it('routes screenshot triggers through the shared coordinator without creating records', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T02:00:00.000Z'));
    const screenshot = {
      captureAndSendDutyOverview: jest
        .fn()
        .mockResolvedValue({ success: true }),
    };
    const coordinator = {
      run: jest.fn().mockResolvedValue({ success: true }),
    };
    const Automation = DutyScheduleAutomationService as unknown as new (
      dutyScheduleService: unknown,
      bitableSyncService: unknown,
      screenshotService: typeof screenshot,
      taskCoordinator: typeof coordinator,
    ) => DutyScheduleAutomationService;
    const service = new Automation({}, {}, screenshot, coordinator);

    await service.autoSendDutyOverviewScreenshotAt0850();
    await service.autoSendDutyOverviewScreenshotAt1750();

    expect(coordinator.run).toHaveBeenNthCalledWith(
      1,
      'white-screenshot',
      '2026-07-20',
    );
    expect(coordinator.run).toHaveBeenNthCalledWith(
      2,
      'night-screenshot',
      '2026-07-20',
    );
    expect(screenshot.captureAndSendDutyOverview).not.toHaveBeenCalled();
  });
});
