import { resolveWeatherWarningSourceStatus } from '../../server/modules/weather-warning/weather-warning-source-status';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';

const NOW = '2026-08-03T06:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const STALE_AFTER_MS = 20 * 60_000;
const ORIGINAL_QWEATHER_KEY = process.env.QWEATHER_KEY;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function createWeatherService(get: jest.Mock) {
  process.env.QWEATHER_KEY = 'weather-warning-test-key';
  return new BitableSyncService({} as never, { axiosRef: { get } } as never);
}

afterEach(() => {
  jest.useRealTimers();
  if (ORIGINAL_QWEATHER_KEY === undefined) {
    delete process.env.QWEATHER_KEY;
  } else {
    process.env.QWEATHER_KEY = ORIGINAL_QWEATHER_KEY;
  }
});

describe('weather warning source status', () => {
  it('marks a successful empty warning response as fresh', () => {
    const result = resolveWeatherWarningSourceStatus({
      nowMs: NOW_MS,
      staleAfterMs: STALE_AFTER_MS,
      latest: { warning: [] },
      latestFetchedAt: '2026-08-03T05:59:00.000Z',
    });

    expect(result).toEqual({
      state: 'fresh',
      data: { warning: [] },
      fetchedAt: '2026-08-03T05:59:00.000Z',
      lastSuccessAt: '2026-08-03T05:59:00.000Z',
      warningCount: 0,
      isStale: false,
    });
  });

  it('keeps a five-minute-old successful snapshot as degraded after an upstream failure', () => {
    const result = resolveWeatherWarningSourceStatus({
      nowMs: NOW_MS,
      staleAfterMs: STALE_AFTER_MS,
      lastSuccess: { warning: [{ id: 'high-temp-orange' }] },
      lastSuccessAt: '2026-08-03T05:55:00.000Z',
      errorMessage: '天气预警源不可用',
    });

    expect(result).toEqual({
      state: 'degraded',
      data: { warning: [{ id: 'high-temp-orange' }] },
      fetchedAt: NOW,
      lastSuccessAt: '2026-08-03T05:55:00.000Z',
      warningCount: 1,
      isStale: false,
      errorMessage: '天气预警源不可用',
    });
  });

  it('marks a snapshot older than the stale threshold as stale', () => {
    const result = resolveWeatherWarningSourceStatus({
      nowMs: NOW_MS,
      staleAfterMs: STALE_AFTER_MS,
      lastSuccess: { warning: [{ id: 'high-temp-orange' }] },
      lastSuccessAt: '2026-08-03T05:39:59.999Z',
      errorMessage: '天气预警源不可用',
    });

    expect(result).toEqual({
      state: 'stale',
      data: { warning: [{ id: 'high-temp-orange' }] },
      fetchedAt: NOW,
      lastSuccessAt: '2026-08-03T05:39:59.999Z',
      warningCount: 1,
      isStale: true,
      errorMessage: '天气预警源不可用',
    });
  });

  it('reports unavailable on a first failure without any valid snapshot', () => {
    const result = resolveWeatherWarningSourceStatus({
      nowMs: NOW_MS,
      staleAfterMs: STALE_AFTER_MS,
      errorMessage: '天气预警源不可用',
    });

    expect(result).toEqual({
      state: 'unavailable',
      data: null,
      fetchedAt: NOW,
      warningCount: 0,
      isStale: false,
      errorMessage: '天气预警源不可用',
    });
  });

  it('never exposes an invalid fetchedAt timestamp', () => {
    const result = resolveWeatherWarningSourceStatus({
      nowMs: Number.MAX_VALUE,
      staleAfterMs: STALE_AFTER_MS,
      latest: { warning: [] },
      latestFetchedAt: 'invalid-date',
    });

    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false);
  });

  it.each([undefined, 'invalid-date'])(
    'does not downgrade from a missing or invalid last-success timestamp: %s',
    (lastSuccessAt) => {
      const result = resolveWeatherWarningSourceStatus({
        nowMs: NOW_MS,
        staleAfterMs: STALE_AFTER_MS,
        lastSuccess: { warning: [{ id: 'high-temp-orange' }] },
        lastSuccessAt,
        errorMessage: '天气预警源不可用',
      });

      expect(result.state).toBe('unavailable');
      expect(result.data).toBeNull();
      expect(result.isStale).toBe(false);
    },
  );

  it('keeps a valid QWeather response fresh when warning status is absent', async () => {
    const warning = { title: '高温橙色预警' };
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        return { data: { code: '200', warning: [warning] } };
      }

      return { data: '<html>login gateway</html>' };
    });
    const service = createWeatherService(get);

    const detailed = await service.getWeatherWarningFetchResult(true);
    const legacy = await service.getWeatherWarning(true);

    expect(detailed.state).toBe('fresh');
    expect(detailed.data?.warning).toEqual([warning]);
    expect(legacy.warning).toEqual([warning]);
  });

  it('uses a ten-minute weather warning cache unless force refreshed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    const firstWarning = { title: 'first warning' };
    const secondWarning = { title: 'second warning' };
    const thirdWarning = { title: 'third warning' };
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { code: '200', warning: [firstWarning] } })
      .mockResolvedValueOnce({
        data: { code: '200', warning: [secondWarning] },
      })
      .mockResolvedValueOnce({
        data: { code: '200', warning: [thirdWarning] },
      });
    const service = createWeatherService(get);

    const first = await service.getWeatherWarningFetchResult();
    jest.setSystemTime(new Date(NOW_MS + 10 * 60_000 - 1));
    const cached = await service.getWeatherWarningFetchResult();

    expect(get).toHaveBeenCalledTimes(1);
    expect(first.data?.warning).toEqual([firstWarning]);
    expect(cached.data?.warning).toEqual([firstWarning]);

    jest.setSystemTime(new Date(NOW_MS + 10 * 60_000));
    const expired = await service.getWeatherWarningFetchResult();

    expect(get).toHaveBeenCalledTimes(2);
    expect(expired.data?.warning).toEqual([secondWarning]);

    const forced = await service.getWeatherWarningFetchResult(true);

    expect(get).toHaveBeenCalledTimes(3);
    expect(forced.data?.warning).toEqual([thirdWarning]);
  });

  it('coalesces concurrent refreshes after the weather warning cache expires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    const cachedWarning = { title: 'cached warning' };
    const refreshedWarning = { title: 'refreshed warning' };
    const refreshResponse = createDeferred<{
      data: { code: string; warning: (typeof refreshedWarning)[] };
    }>();
    const get = jest.fn().mockResolvedValueOnce({
      data: { code: '200', warning: [cachedWarning] },
    });
    const service = createWeatherService(get);

    await service.getWeatherWarningFetchResult();
    get.mockImplementation(() => refreshResponse.promise);
    jest.setSystemTime(new Date(NOW_MS + 10 * 60_000));

    const firstRefresh = service.getWeatherWarningFetchResult();
    const secondRefresh = service.getWeatherWarningFetchResult();

    expect(get).toHaveBeenCalledTimes(2);

    refreshResponse.resolve({
      data: { code: '200', warning: [refreshedWarning] },
    });

    const [firstResult, secondResult] = await Promise.all([
      firstRefresh,
      secondRefresh,
    ]);
    expect(firstResult.data?.warning).toEqual([refreshedWarning]);
    expect(secondResult.data?.warning).toEqual([refreshedWarning]);
  });

  it('clears a failed in-flight weather warning fetch before the next force refresh', async () => {
    let shouldFail = true;
    const recoveredWarning = { title: 'recovered warning' };
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        if (shouldFail) {
          throw new Error('QWeather unavailable');
        }
        return { data: { code: '200', warning: [recoveredWarning] } };
      }

      return { data: '<html>login gateway</html>' };
    });
    const service = createWeatherService(get);

    const failed = await service.getWeatherWarningFetchResult(true);
    shouldFail = false;
    const recovered = await service.getWeatherWarningFetchResult(true);

    expect(failed.state).toBe('unavailable');
    expect(recovered.state).toBe('fresh');
    expect(recovered.data?.warning).toEqual([recoveredWarning]);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent forced warning refreshes across detailed and legacy APIs', async () => {
    const firstWarning = { title: '高温橙色预警' };
    const firstResponse = createDeferred<{
      data: { code: string; warning: (typeof firstWarning)[] };
    }>();
    const get = jest.fn(() => firstResponse.promise);
    const service = createWeatherService(get);

    const firstDetailed = service.getWeatherWarningFetchResult(true);
    const secondDetailed = service.getWeatherWarningFetchResult(true);

    expect(get).toHaveBeenCalledTimes(1);

    firstResponse.resolve({ data: { code: '200', warning: [firstWarning] } });

    const [firstResult, secondResult] = await Promise.all([
      firstDetailed,
      secondDetailed,
    ]);
    expect(firstResult.state).toBe('fresh');
    expect(secondResult.state).toBe('fresh');
    expect(firstResult.data?.warning).toEqual([firstWarning]);
    expect(secondResult.data?.warning).toEqual([firstWarning]);

    const secondWarning = { title: '雷电黄色预警' };
    const secondResponse = createDeferred<{
      data: { code: string; warning: (typeof secondWarning)[] };
    }>();
    get.mockImplementation(() => secondResponse.promise);

    const detailed = service.getWeatherWarningFetchResult(true);
    const legacy = service.getWeatherWarning(true);

    expect(get).toHaveBeenCalledTimes(2);

    secondResponse.resolve({ data: { code: '200', warning: [secondWarning] } });

    const [detailedResult, legacyResult] = await Promise.all([
      detailed,
      legacy,
    ]);
    expect(detailedResult.state).toBe('fresh');
    expect(detailedResult.data?.warning).toEqual([secondWarning]);
    expect(legacyResult.warning).toEqual([secondWarning]);
  });

  it('accepts the trusted QWeather no-data page when an unrelated script contains Error', async () => {
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        throw new Error('QWeather unavailable');
      }

      return {
        data: [
          '<html><body>',
          '<main class="l-page-city-warning">',
          '<div class="c-city-warning-no-data">暂无预警</div>',
          '</main>',
          '<script>const NativeError = window.Error;</script>',
          '</body></html>',
        ].join(''),
      };
    });
    const service = createWeatherService(get);

    const result = await service.getWeatherWarningFetchResult(true);

    expect(
      get.mock.calls.filter(([url]) => String(url).includes('/warning/now')),
    ).toHaveLength(2);
    expect(result.state).toBe('fresh');
    expect(result.data?.code).toBe('200');
    expect(result.data?.warning).toEqual([]);
    expect(result.warningCount).toBe(0);
    expect(result.isStale).toBe(false);
  });

  it('does not treat an unrecognised fallback HTML response as clear weather', async () => {
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        throw new Error('QWeather unavailable');
      }

      return { data: '<html>login gateway</html>' };
    });
    const service = createWeatherService(get);

    const result = await service.getWeatherWarningFetchResult(true);

    expect(result.state).toBe('unavailable');
    expect(result.data).toBeNull();
    expect(result.warningCount).toBe(0);
  });

  it('rejects a login gateway page even when it contains a parseable warning fragment', async () => {
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        throw new Error('QWeather unavailable');
      }

      return {
        data: [
          '<html>login gateway',
          '<div class="c-city-warning-events warning--orange">',
          '<h3>高温橙色预警</h3>',
          '<p class="warning-events__txt">伪造预警内容</p>',
          '</div></html>',
        ].join(''),
      };
    });
    const service = createWeatherService(get);
    const parseSpy = jest.spyOn(
      service as unknown as {
        parseQWeatherPublicWarnings(html: string, cityId: string): unknown[];
      },
      'parseQWeatherPublicWarnings',
    );

    const result = await service.getWeatherWarningFetchResult(true);

    expect(result.state).toBe('unavailable');
    expect(result.data).toBeNull();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it.each([
    'aCcEsS \n DeNiEd',
    ' FoRbIdDeN ',
    'uNaUtHoRiZeD',
    '权限 \n 不足',
    'Internal Server Error',
    'InTeRnAl \n SeRvEr \n ErRoR',
    'Error',
  ])(
    'rejects denied fallback HTML before parsing warnings: %s',
    async (denialMarker) => {
      const get = jest.fn(async (url: string) => {
        if (url.includes('/warning/now')) {
          throw new Error('QWeather unavailable');
        }

        return {
          data: [
            '<html>',
            denialMarker,
            '<div class="c-city-warning-events warning--orange">',
            '<h3>Test warning</h3>',
            '<p class="warning-events__txt">Unexpected warning data</p>',
            '</div></html>',
          ].join(''),
        };
      });
      const service = createWeatherService(get);
      const parseSpy = jest.spyOn(
        service as unknown as {
          parseQWeatherPublicWarnings(html: string, cityId: string): unknown[];
        },
        'parseQWeatherPublicWarnings',
      );

      const result = await service.getWeatherWarningFetchResult(true);

      expect(result.state).toBe('unavailable');
      expect(result.data).toBeNull();
      expect(parseSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    '<html>QWeather login gateway weather warning</html>',
    '<html>QWeather 无权限 天气预警</html>',
    '<html>无预警</html>',
  ])('rejects an untrusted fallback HTML response: %s', async (html) => {
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        throw new Error('QWeather unavailable');
      }

      return { data: html };
    });
    const service = createWeatherService(get);

    const result = await service.getWeatherWarningFetchResult(true);

    expect(result.state).toBe('unavailable');
    expect(result.data).toBeNull();
  });

  it('returns degraded detailed data and an empty legacy response after a fresh snapshot fails', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    const warning = { title: '高温橙色预警' };
    let shouldFail = false;
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        if (shouldFail) {
          throw new Error('QWeather unavailable');
        }
        return { data: { code: '200', warning: [warning] } };
      }

      return { data: '<html>QWeather login gateway weather warning</html>' };
    });
    const service = createWeatherService(get);

    await service.getWeatherWarningFetchResult(true);
    shouldFail = true;

    const detailed = await service.getWeatherWarningFetchResult(true);
    const legacy = await service.getWeatherWarning(true);

    expect(detailed.state).toBe('degraded');
    expect(detailed.data?.warning).toEqual([warning]);
    expect(legacy).toEqual({ code: '200', warning: [] });
  });

  it('returns stale detailed data after the last success is older than twenty minutes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    const warning = { title: '高温橙色预警' };
    let shouldFail = false;
    const get = jest.fn(async (url: string) => {
      if (url.includes('/warning/now')) {
        if (shouldFail) {
          throw new Error('QWeather unavailable');
        }
        return { data: { code: '200', warning: [warning] } };
      }

      return { data: '<html>QWeather login gateway weather warning</html>' };
    });
    const service = createWeatherService(get);

    await service.getWeatherWarningFetchResult(true);
    shouldFail = true;
    jest.setSystemTime(new Date(NOW_MS + STALE_AFTER_MS + 1));

    const detailed = await service.getWeatherWarningFetchResult(true);
    const legacy = await service.getWeatherWarning(true);

    expect(detailed.state).toBe('stale');
    expect(detailed.data?.warning).toEqual([warning]);
    expect(detailed.isStale).toBe(true);
    expect(legacy).toEqual({ code: '200', warning: [] });
  });
});
