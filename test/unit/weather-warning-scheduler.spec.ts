import { WeatherWarningScheduler } from '../../server/modules/weather-warning/weather-warning.scheduler';

const ENVIRONMENT_NAMES = [
  'FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED',
  'FEISHU_WEATHER_WARNING_CHAT_IDS',
  'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS',
  'FEISHU_WEATHER_WARNING_OWNER_OPEN_ID',
  'FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS',
] as const;

describe('WeatherWarningScheduler', () => {
  const originalEnvironment = captureEnvironment();

  beforeEach(() => {
    jest.useFakeTimers();
    for (const name of ENVIRONMENT_NAMES) delete process.env[name];
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => restoreEnvironment(originalEnvironment));

  it('does not start when automatic delivery is disabled by default', async () => {
    const automationService = { runDue: jest.fn() };
    const scheduler = new WeatherWarningScheduler(automationService as never);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(automationService.runDue).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('runs immediately, polls every minute, and stops on destroy', async () => {
    enableAutomation();
    const automationService = {
      runDue: jest.fn().mockResolvedValue({
        status: 'processed',
        sentCount: 0,
        failedCount: 0,
      }),
    };
    const scheduler = new WeatherWarningScheduler(automationService as never);

    scheduler.onModuleInit();
    await Promise.resolve();
    expect(automationService.runDue).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60 * 1000 - 1);
    expect(automationService.runDue).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(automationService.runDue).toHaveBeenCalledTimes(2);

    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(automationService.runDue).toHaveBeenCalledTimes(2);
  });

  it('does not overlap executions when a previous poll is still running', async () => {
    enableAutomation();
    let resolveFirst!: () => void;
    const firstRun = new Promise<{
      status: 'processed';
      sentCount: number;
      failedCount: number;
    }>((resolve) => {
      resolveFirst = () =>
        resolve({ status: 'processed', sentCount: 0, failedCount: 0 });
    });
    const automationService = {
      runDue: jest
        .fn()
        .mockImplementationOnce(() => firstRun)
        .mockResolvedValue({
          status: 'processed',
          sentCount: 0,
          failedCount: 0,
        }),
    };
    const scheduler = new WeatherWarningScheduler(automationService as never);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(automationService.runDue).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(automationService.runDue).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });
});

function enableAutomation(): void {
  process.env.FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED = 'true';
  process.env.FEISHU_WEATHER_WARNING_CHAT_IDS = 'oc_weather_warning_group';
  process.env.FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS =
    'oc_important_event_group';
  process.env.FEISHU_WEATHER_WARNING_OWNER_OPEN_ID = 'ou_ma_jinyu';
  process.env.FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS = String(60 * 1000);
}

function captureEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]),
  );
}

function restoreEnvironment(values: Record<string, string | undefined>): void {
  for (const name of ENVIRONMENT_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
