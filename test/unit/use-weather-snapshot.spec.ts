import type { QWeatherHourly, QWeatherNow } from '../../client/src/api';
import type { WeatherWarningSnapshot } from '../../shared/api.interface';

jest.mock('../../client/src/api', () => ({
  getQWeatherHourly: jest.fn(),
  getQWeatherNow: jest.fn(),
  getWeatherWarningSnapshot: jest.fn(),
}));

import {
  WEATHER_CURRENT_AND_HOURLY_REFRESH_MS,
  WEATHER_WARNING_REFRESH_MS,
  createWeatherSnapshotRefreshCoordinator,
  getWeatherWarningRefreshFailure,
  getWeatherWarningRefreshErrorMessage,
  type WeatherSnapshotRequestApi,
} from '../../client/src/pages/MonthlySchedule/use-weather-snapshot';

function createNow(): QWeatherNow {
  return {
    code: '200',
    updateTime: '2026-08-05T00:00:00+08:00',
    fxLink: '',
    now: {
      obsTime: '2026-08-05T00:00:00+08:00',
      temp: '31',
      feelsLike: '34',
      icon: '100',
      text: '晴',
      wind360: '90',
      windDir: '东风',
      windScale: '3',
      windSpeed: '12',
      humidity: '75',
      precip: '0',
      pressure: '1009',
      vis: '10',
      cloud: '10',
      dew: '25',
    },
  };
}

function createHourly(): QWeatherHourly {
  return {
    code: '200',
    updateTime: '2026-08-05T00:00:00+08:00',
    fxLink: '',
    hourly: [
      {
        fxTime: '2026-08-05T01:00:00+08:00',
        temp: '30',
        icon: '101',
        text: '多云',
        wind360: '90',
        windDir: '东风',
        windScale: '3',
        windSpeed: '12',
        humidity: '76',
        precip: '0',
        pop: '0',
        pressure: '1009',
        cloud: '15',
        dew: '25',
      },
    ],
  };
}

function createSnapshot(
  status: WeatherWarningSnapshot['status'] = 'active',
): WeatherWarningSnapshot {
  return {
    status,
    sourceState: status === 'stale' ? 'stale' : 'fresh',
    snapshotAt: '2026-08-05T00:00:00+08:00',
    guardLevel: null,
    matchedWarnings: [],
    unmatchedWarnings: [],
    actions: [],
    weather: null,
    checkSummary: {
      device: 'not_started',
      environment: 'not_started',
      disaster: 'not_started',
      materials: 'not_started',
      contacts: 'not_started',
      managerConfirmation: 'not_started',
      abnormalSummaries: [],
    },
    canSendTest: false,
  };
}

function createRequests(
  overrides: Partial<WeatherSnapshotRequestApi> = {},
): WeatherSnapshotRequestApi {
  return {
    getQWeatherNow: jest.fn().mockResolvedValue(createNow()),
    getQWeatherHourly: jest.fn().mockResolvedValue(createHourly()),
    getWeatherWarningSnapshot: jest.fn().mockResolvedValue(createSnapshot()),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const activeCoordinators: Array<
  ReturnType<typeof createWeatherSnapshotRefreshCoordinator>
> = [];

function createTrackedCoordinator(
  options: Parameters<typeof createWeatherSnapshotRefreshCoordinator>[0],
) {
  const coordinator = createWeatherSnapshotRefreshCoordinator(options);
  activeCoordinators.push(coordinator);
  return coordinator;
}

describe('getWeatherWarningRefreshErrorMessage', () => {
  it.each([
    [
      { response: { status: 403 }, message: 'provider permission detail' },
      'permission',
      '当前账号无权读取天气预警快照',
    ],
    [
      { response: { status: 503 }, message: 'provider configuration detail' },
      'configuration',
      '天气预警服务配置暂不可用',
    ],
    [
      Object.assign(new Error('provider timeout detail'), {
        code: 'ECONNABORTED',
      }),
      'timeout',
      '天气预警快照获取超时',
    ],
    [
      Object.assign(new Error('provider timeout detail'), {
        code: 'ETIMEDOUT',
      }),
      'timeout',
      '天气预警快照获取超时',
    ],
    [
      new Error('provider secret detail'),
      'unavailable',
      '天气预警快照暂时不可用',
    ],
  ] as const)(
    'maps a warning refresh failure to a typed safe result',
    (error, expectedKind, expectedMessage) => {
      const failure = getWeatherWarningRefreshFailure(error);
      const message = getWeatherWarningRefreshErrorMessage(error);

      expect(failure).toEqual({
        kind: expectedKind,
        message: expectedMessage,
      });
      expect(message).toBe(expectedMessage);
      expect(message).not.toContain('provider');
    },
  );
});

describe('useWeatherSnapshot refresh coordinator', () => {
  afterEach(() => {
    for (const coordinator of activeCoordinators.splice(0)) {
      coordinator.stop();
    }
    jest.useRealTimers();
  });

  it('uses one initial all-settled load, then refreshes the warning every 10 minutes and current weather plus hourly data every 30 minutes', async () => {
    jest.useFakeTimers();
    const requests = createRequests();
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();

    expect(requests.getQWeatherNow).toHaveBeenCalledTimes(1);
    expect(requests.getQWeatherHourly).toHaveBeenCalledTimes(1);
    expect(requests.getWeatherWarningSnapshot).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().screenshotReadiness).toBe('ready');

    await jest.advanceTimersByTimeAsync(WEATHER_WARNING_REFRESH_MS);
    expect(requests.getWeatherWarningSnapshot).toHaveBeenCalledTimes(2);
    expect(requests.getQWeatherNow).toHaveBeenCalledTimes(1);
    expect(requests.getQWeatherHourly).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(
      WEATHER_CURRENT_AND_HOURLY_REFRESH_MS - WEATHER_WARNING_REFRESH_MS,
    );
    expect(requests.getWeatherWarningSnapshot).toHaveBeenCalledTimes(4);
    expect(requests.getQWeatherNow).toHaveBeenCalledTimes(2);
    expect(requests.getQWeatherHourly).toHaveBeenCalledTimes(2);

    coordinator.stop();
    await jest.advanceTimersByTimeAsync(WEATHER_CURRENT_AND_HOURLY_REFRESH_MS);
    expect(requests.getWeatherWarningSnapshot).toHaveBeenCalledTimes(4);
    expect(requests.getQWeatherNow).toHaveBeenCalledTimes(2);
    expect(requests.getQWeatherHourly).toHaveBeenCalledTimes(2);
  });

  it('allows a stable screenshot when warning data is unavailable but weather content and the warning fallback are rendered', async () => {
    const requests = createRequests({
      getWeatherWarningSnapshot: jest
        .fn()
        .mockRejectedValue({ response: { status: 503 } }),
    });
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();

    expect(coordinator.getState().weatherStatus).toBe('ready');
    expect(coordinator.getState().warningStatus).toBe('error');
    expect(coordinator.getState().warningSnapshot).toBeNull();
    expect(coordinator.getState().warningError).toBe(
      '天气预警服务配置暂不可用',
    );
    expect(coordinator.getState().screenshotReadiness).toBe('ready');
  });

  it('keeps screenshot readiness loading until the initial weather requests settle', async () => {
    const currentWeather = createDeferred<QWeatherNow>();
    const requests = createRequests({
      getQWeatherNow: jest.fn().mockReturnValue(currentWeather.promise),
    });
    const coordinator = createTrackedCoordinator({ requests });

    const initialLoad = coordinator.start();

    expect(coordinator.getState().screenshotReadiness).toBe('loading');

    currentWeather.resolve(createNow());
    await initialLoad;
    expect(coordinator.getState().screenshotReadiness).toBe('ready');
  });

  it.each([
    [
      'current weather',
      { getQWeatherNow: jest.fn().mockRejectedValue(new Error('unavailable')) },
    ],
    [
      'hourly weather',
      {
        getQWeatherHourly: jest
          .fn()
          .mockRejectedValue(new Error('unavailable')),
      },
    ],
  ])(
    'does not allow a screenshot when %s is unavailable',
    async (_label, weatherOverride) => {
      const requests = createRequests({
        ...weatherOverride,
        getWeatherWarningSnapshot: jest
          .fn()
          .mockRejectedValue({ response: { status: 503 } }),
      });
      const coordinator = createTrackedCoordinator({ requests });

      await coordinator.start();

      expect(coordinator.getState().weatherStatus).toBe('error');
      expect(coordinator.getState().screenshotReadiness).toBe('error');
    },
  );

  it('retains a stale warning snapshot after a failed refresh instead of replacing it with a clear state', async () => {
    jest.useFakeTimers();
    const staleSnapshot = createSnapshot('stale');
    const requests = createRequests({
      getWeatherWarningSnapshot: jest
        .fn()
        .mockResolvedValueOnce(staleSnapshot)
        .mockRejectedValueOnce(new Error('network unavailable')),
    });
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();
    expect(coordinator.getState().warningSnapshot).toBe(staleSnapshot);
    expect(coordinator.getState().warningStatus).toBe('ready');

    await jest.advanceTimersByTimeAsync(WEATHER_WARNING_REFRESH_MS);

    expect(coordinator.getState().warningSnapshot).toBe(staleSnapshot);
    expect(coordinator.getState().warningSnapshot?.status).toBe('stale');
    expect(coordinator.getState().warningStatus).toBe('error');
    expect(coordinator.getState().warningError).toBeTruthy();
    expect(coordinator.getState().screenshotReadiness).toBe('error');
  });

  it('retains the last warning error while retrying when no warning snapshot is available', async () => {
    const retryWarning = createDeferred<WeatherWarningSnapshot>();
    const requests = createRequests({
      getWeatherWarningSnapshot: jest
        .fn()
        .mockRejectedValueOnce({ response: { status: 403 } })
        .mockReturnValueOnce(retryWarning.promise),
    });
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();
    expect(coordinator.getState().warningSnapshot).toBeNull();
    expect(coordinator.getState().warningError).toBe(
      '当前账号无权读取天气预警快照',
    );
    expect(coordinator.getState().warningFailureKind).toBe('permission');

    const refresh = coordinator.refreshWarning();

    expect(requests.getWeatherWarningSnapshot).toHaveBeenCalledTimes(2);
    expect(coordinator.getState().warningStatus).toBe('loading');
    expect(coordinator.getState().warningError).toBe(
      '当前账号无权读取天气预警快照',
    );

    retryWarning.resolve(createSnapshot('clear'));
    await refresh;

    expect(coordinator.getState().warningStatus).toBe('ready');
    expect(coordinator.getState().warningError).toBeNull();
    expect(coordinator.getState().warningFailureKind).toBeNull();
  });

  it('clears the last warning error while retrying when a displayable warning snapshot is available', async () => {
    const nextWarning = createDeferred<WeatherWarningSnapshot>();
    const requests = createRequests({
      getWeatherWarningSnapshot: jest
        .fn()
        .mockResolvedValueOnce(createSnapshot('active'))
        .mockRejectedValueOnce(new Error('provider refresh detail'))
        .mockReturnValueOnce(nextWarning.promise),
    });
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();
    await coordinator.refreshWarning();

    expect(coordinator.getState().warningSnapshot?.status).toBe('degraded');
    expect(coordinator.getState().warningStatus).toBe('error');
    expect(coordinator.getState().warningError).toBe('天气预警快照暂时不可用');

    const refresh = coordinator.refreshWarning();

    expect(requests.getWeatherWarningSnapshot).toHaveBeenCalledTimes(3);
    expect(coordinator.getState().warningStatus).toBe('refreshing');
    expect(coordinator.getState().warningError).toBeNull();

    nextWarning.resolve(createSnapshot('clear'));
    await refresh;

    expect(coordinator.getState().warningSnapshot?.status).toBe('clear');
    expect(coordinator.getState().warningStatus).toBe('ready');
    expect(coordinator.getState().warningError).toBeNull();
  });

  it('retains the last usable current weather when a successful placeholder response arrives', async () => {
    const lastUsableNow = createNow();
    const requests = createRequests({
      getQWeatherNow: jest
        .fn()
        .mockResolvedValueOnce(lastUsableNow)
        .mockResolvedValueOnce({
          ...createNow(),
          now: { ...createNow().now, temp: '--' },
        }),
    });
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();
    await coordinator.refreshCurrentAndHourly();

    expect(coordinator.getState().weather).toBe(lastUsableNow);
    expect(coordinator.getState().weatherStatus).toBe('error');
    expect(coordinator.getState().weatherError).toBeTruthy();
    expect(coordinator.getState().screenshotReadiness).toBe('ready');
    coordinator.stop();
  });

  it('retains the last usable hourly forecast when a successful empty response arrives', async () => {
    const lastUsableHourly = createHourly();
    const requests = createRequests({
      getQWeatherHourly: jest
        .fn()
        .mockResolvedValueOnce(lastUsableHourly)
        .mockResolvedValueOnce({ ...createHourly(), hourly: [] }),
    });
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();
    await coordinator.refreshCurrentAndHourly();

    expect(coordinator.getState().hourlyWeather).toBe(lastUsableHourly);
    expect(coordinator.getState().weatherStatus).toBe('error');
    expect(coordinator.getState().weatherError).toBeTruthy();
    expect(coordinator.getState().screenshotReadiness).toBe('ready');
    coordinator.stop();
  });

  it('renders a retained clear warning snapshot as degraded after its refresh fails', async () => {
    const clearSnapshot = createSnapshot('clear');
    const requests = createRequests({
      getWeatherWarningSnapshot: jest
        .fn()
        .mockResolvedValueOnce(clearSnapshot)
        .mockRejectedValueOnce(new Error('network unavailable')),
    });
    const coordinator = createTrackedCoordinator({ requests });

    await coordinator.start();
    await coordinator.refreshWarning();

    expect(coordinator.getState().warningStatus).toBe('error');
    expect(coordinator.getState().warningSnapshot).not.toBe(clearSnapshot);
    expect(coordinator.getState().warningSnapshot?.status).toBe('degraded');
    expect(coordinator.getState().warningSnapshot?.guardDecisionState).toBe(
      'stale',
    );
    expect(coordinator.getState().screenshotReadiness).toBe('ready');
    coordinator.stop();
  });

  it('abandons an older warning request and ignores its late result', async () => {
    const firstWarning = createDeferred<WeatherWarningSnapshot>();
    const secondWarning = createDeferred<WeatherWarningSnapshot>();
    const warningSignals: AbortSignal[] = [];
    const requests = createRequests({
      getWeatherWarningSnapshot: jest.fn((signal?: AbortSignal) => {
        if (signal) warningSignals.push(signal);
        return warningSignals.length === 1
          ? firstWarning.promise
          : secondWarning.promise;
      }),
    });
    const coordinator = createTrackedCoordinator({ requests });

    const initialLoad = coordinator.start();
    const refresh = coordinator.refreshWarning();

    expect(warningSignals).toHaveLength(2);
    expect(warningSignals[0].aborted).toBe(true);

    secondWarning.resolve(createSnapshot('active'));
    await refresh;
    firstWarning.resolve(createSnapshot('clear'));
    await initialLoad;

    expect(coordinator.getState().warningSnapshot?.status).toBe('active');
    coordinator.stop();
  });

  it('aborts both request groups and publishes no late result after it stops', async () => {
    const now = createDeferred<QWeatherNow>();
    const hourly = createDeferred<QWeatherHourly>();
    const warning = createDeferred<WeatherWarningSnapshot>();
    let nowSignal: AbortSignal | undefined;
    let hourlySignal: AbortSignal | undefined;
    let warningSignal: AbortSignal | undefined;
    const onStateChange = jest.fn();
    const coordinator = createTrackedCoordinator({
      onStateChange,
      requests: createRequests({
        getQWeatherNow: jest.fn((signal?: AbortSignal) => {
          nowSignal = signal;
          return now.promise;
        }),
        getQWeatherHourly: jest.fn((signal?: AbortSignal) => {
          hourlySignal = signal;
          return hourly.promise;
        }),
        getWeatherWarningSnapshot: jest.fn((signal?: AbortSignal) => {
          warningSignal = signal;
          return warning.promise;
        }),
      }),
    });

    const initialLoad = coordinator.start();
    coordinator.stop();
    const stateChangeCountAtStop = onStateChange.mock.calls.length;

    expect(nowSignal?.aborted).toBe(true);
    expect(hourlySignal?.aborted).toBe(true);
    expect(warningSignal?.aborted).toBe(true);

    now.resolve(createNow());
    hourly.resolve(createHourly());
    warning.resolve(createSnapshot());
    await initialLoad;

    expect(onStateChange).toHaveBeenCalledTimes(stateChangeCountAtStop);
    expect(coordinator.getState().weather).toBeNull();
    expect(coordinator.getState().warningSnapshot).toBeNull();
  });
});
