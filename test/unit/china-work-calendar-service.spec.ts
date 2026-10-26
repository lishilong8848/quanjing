import type { HttpService } from '@nestjs/axios';

import {
  ChinaWorkCalendarService,
  getChinaWorkCalendarNextScheduledCheckAt,
  getChinaWorkCalendarRefreshDelayMs,
  getChinaWorkCalendarTimerDelayMs,
} from '../../server/modules/duty-schedule/china-work-calendar.service';
import * as sourceModule from '../../server/modules/duty-schedule/china-work-calendar-source';
import * as stateStore from '../../server/modules/duty-schedule/china-work-calendar-state-store';
import { getChinaWorkCalendarSnapshot } from '../../shared/china-work-calendar';

jest.mock(
  '../../server/modules/duty-schedule/china-work-calendar-source',
  () => ({
    fetchOfficialChinaWorkCalendar: jest.fn(),
  }),
);

jest.mock(
  '../../server/modules/duty-schedule/china-work-calendar-state-store',
  () => ({
    readChinaWorkCalendarStateFile: jest.fn(),
    writeChinaWorkCalendarStateFile: jest.fn(),
  }),
);

const DAY_MS = 24 * 60 * 60 * 1000;

describe('ChinaWorkCalendarService cadence', () => {
  it('chunks long waits below the Node timer overflow limit', () => {
    expect(getChinaWorkCalendarTimerDelayMs(DAY_MS)).toBe(DAY_MS);
    expect(getChinaWorkCalendarTimerDelayMs(30 * DAY_MS)).toBe(2_147_000_000);
  });

  it.each([
    [
      'daily',
      '2026-12-15T19:21:00.000Z',
      DAY_MS,
      '2026-12-16T19:20:00.000Z',
    ],
    [
      'three-day',
      '2026-09-30T19:21:00.000Z',
      3 * DAY_MS,
      '2026-10-03T19:20:00.000Z',
    ],
    [
      'thirty-day',
      '2026-07-31T19:21:00.000Z',
      30 * DAY_MS,
      '2026-08-30T19:20:00.000Z',
    ],
  ])(
    'schedules an off-slot %s check by Shanghai calendar day',
    (_label, lastCheckedAt, delayMs, expected) => {
      expect(
        getChinaWorkCalendarNextScheduledCheckAt(
          new Date(lastCheckedAt),
          delayMs,
          3,
          20,
        ).toISOString(),
      ).toBe(expected);
    },
  );

  it('uses a low-frequency adaptive cadence for an unpublished next year', () => {
    expect(
      getChinaWorkCalendarRefreshDelayMs({
        now: new Date('2026-08-03T00:00:00.000Z'),
        targetYear: 2027,
        hasValidatedCalendar: false,
        consecutiveFailures: 0,
      }),
    ).toBe(30 * DAY_MS);
    expect(
      getChinaWorkCalendarRefreshDelayMs({
        now: new Date('2026-10-20T00:00:00.000Z'),
        targetYear: 2027,
        hasValidatedCalendar: false,
        consecutiveFailures: 0,
      }),
    ).toBe(3 * DAY_MS);
    expect(
      getChinaWorkCalendarRefreshDelayMs({
        now: new Date('2026-12-20T00:00:00.000Z'),
        targetYear: 2027,
        hasValidatedCalendar: false,
        consecutiveFailures: 0,
      }),
    ).toBe(DAY_MS);
  });

  it('drops back to a 30-day verification cadence after valid data exists', () => {
    expect(
      getChinaWorkCalendarRefreshDelayMs({
        now: new Date('2026-12-20T00:00:00.000Z'),
        targetYear: 2027,
        hasValidatedCalendar: true,
        consecutiveFailures: 0,
      }),
    ).toBe(30 * DAY_MS);
  });

  it('uses bounded exponential retry delays after transport failures', () => {
    expect(
      getChinaWorkCalendarRefreshDelayMs({
        now: new Date('2026-08-03T00:00:00.000Z'),
        targetYear: 2027,
        hasValidatedCalendar: false,
        consecutiveFailures: 1,
      }),
    ).toBe(DAY_MS);
    expect(
      getChinaWorkCalendarRefreshDelayMs({
        now: new Date('2026-08-03T00:00:00.000Z'),
        targetYear: 2027,
        hasValidatedCalendar: false,
        consecutiveFailures: 3,
      }),
    ).toBe(4 * DAY_MS);
  });
});

describe('ChinaWorkCalendarService lifecycle', () => {
  const originalEnv = { ...process.env };
  const fetchOfficialChinaWorkCalendar = jest.mocked(
    sourceModule.fetchOfficialChinaWorkCalendar,
  );
  const readState = jest.mocked(stateStore.readChinaWorkCalendarStateFile);
  const writeState = jest.mocked(stateStore.writeChinaWorkCalendarStateFile);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
    process.env.CHINA_WORK_CALENDAR_AUTO_REFRESH_ENABLED = 'true';
    process.env.CHINA_WORK_CALENDAR_STARTUP_DELAY_MS = '1000';
    readState.mockReturnValue(null);
    writeState.mockReturnValue(undefined);
    fetchOfficialChinaWorkCalendar.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  function createService(): ChinaWorkCalendarService {
    return new ChinaWorkCalendarService({ axiosRef: {} } as HttpService);
  }

  it('checks current and next year after a non-blocking startup delay', async () => {
    const service = createService();

    service.onModuleInit();
    expect(fetchOfficialChinaWorkCalendar).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);

    expect(
      fetchOfficialChinaWorkCalendar.mock.calls.map((call) => call[1]),
    ).toEqual([2026, 2027]);
    expect(service.getStatus().lastCheckedAt).toBeTruthy();
    expect(service.getStatus().lastError).toBeUndefined();
    expect(jest.getTimerCount()).toBe(1);

    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not re-fetch persisted years before their low-frequency due time', async () => {
    const snapshot = getChinaWorkCalendarSnapshot();
    readState.mockReturnValue({
      schemaVersion: 1,
      snapshot,
      lastCheckedAt: '2026-08-01T00:00:00.000Z',
      nextCheckAt: '2026-08-31T19:20:00.000Z',
      yearChecks: {
        '2026': {
          lastCheckedAt: '2026-08-01T00:00:00.000Z',
          lastSuccessAt: '2026-08-01T00:00:00.000Z',
          notPublished: false,
          consecutiveFailures: 0,
        },
        '2027': {
          lastCheckedAt: '2026-08-01T00:00:00.000Z',
          notPublished: true,
          consecutiveFailures: 0,
        },
      },
    });
    const service = createService();

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);

    expect(fetchOfficialChinaWorkCalendar).not.toHaveBeenCalled();
    expect(service.getStatus().nextCheckAt).toBeTruthy();
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();
  });

  it('wakes at cadence boundaries without fetching before the new interval is due', async () => {
    jest.setSystemTime(new Date('2026-09-29T19:20:00.000Z'));
    const snapshot = getChinaWorkCalendarSnapshot();
    readState.mockReturnValue({
      schemaVersion: 1,
      snapshot,
      lastCheckedAt: '2026-09-29T19:20:00.000Z',
      nextCheckAt: '2026-10-29T19:20:00.000Z',
      yearChecks: {
        '2026': {
          lastCheckedAt: '2026-09-29T19:20:00.000Z',
          lastSuccessAt: '2026-09-29T19:20:00.000Z',
          notPublished: false,
          consecutiveFailures: 0,
        },
        '2027': {
          lastCheckedAt: '2026-09-29T19:20:00.000Z',
          notPublished: true,
          consecutiveFailures: 0,
        },
      },
    });
    const service = createService();

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);

    expect(fetchOfficialChinaWorkCalendar).not.toHaveBeenCalled();
    expect(service.getStatus().nextCheckAt).toBe(
      '2026-09-30T19:20:00.000Z',
    );

    await jest.advanceTimersByTimeAsync(DAY_MS - 1000);

    expect(fetchOfficialChinaWorkCalendar).not.toHaveBeenCalled();
    expect(service.getStatus().nextCheckAt).toBe(
      '2026-10-02T19:20:00.000Z',
    );
    service.onModuleDestroy();
  });

  it('coalesces overlapping manual refreshes into one request set', async () => {
    let release!: () => void;
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    fetchOfficialChinaWorkCalendar.mockReturnValue(gate);
    const service = createService();

    const first = service.refreshNow({ force: true });
    const second = service.refreshNow({ force: true });

    expect(second).toBe(first);
    expect(fetchOfficialChinaWorkCalendar).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(fetchOfficialChinaWorkCalendar).toHaveBeenCalledTimes(2);
  });

  it('keeps the last-known-good snapshot when an official refresh fails', async () => {
    const before = getChinaWorkCalendarSnapshot();
    fetchOfficialChinaWorkCalendar.mockRejectedValue(
      new Error('official source timeout token=secret-value'),
    );
    const service = createService();

    await service.refreshNow({ force: true });

    expect(getChinaWorkCalendarSnapshot()).toEqual(before);
    expect(service.getStatus().lastError).toContain('official source timeout');
    expect(service.getStatus().lastError).not.toContain('secret-value');
    expect(writeState).toHaveBeenCalled();
  });
});
