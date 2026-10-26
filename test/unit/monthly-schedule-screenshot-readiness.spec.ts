import {
  beginLatestDutyOverviewRequest,
  createDutyOverviewScreenshotReadiness,
  isDutyOverviewScreenshotReady,
  resetDutyOverviewScreenshotReadinessForDate,
  type DutyOverviewScreenshotReadiness,
} from '../../client/src/pages/MonthlySchedule/screenshot-readiness';

describe('duty overview screenshot readiness', () => {
  const readyState: DutyOverviewScreenshotReadiness = {
    schedules: 'ready',
    sealings: 'ready',
    changes: 'ready',
    personProfiles: 'ready',
    weatherWidget: 'ready',
    weatherTrend: 'ready',
    personnelMovements: 'ready',
    emergencyDuty: 'ready',
  };

  it('aborts the previous replaceable read before starting the next one', () => {
    const first = new AbortController();
    const slot = { current: first };

    const second = beginLatestDutyOverviewRequest(slot);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(slot.current).toBe(second);
  });

  it('starts closed so the first render cannot be captured', () => {
    expect(
      isDutyOverviewScreenshotReady(createDutyOverviewScreenshotReadiness()),
    ).toBe(false);
  });

  it('keeps date-independent person cache usable when the selected date changes', () => {
    expect(
      resetDutyOverviewScreenshotReadinessForDate(readyState, 'error'),
    ).toEqual({
      ...createDutyOverviewScreenshotReadiness(),
      personProfiles: 'ready',
      weatherWidget: 'error',
      weatherTrend: 'error',
    });
  });

  it('opens only after every visible screenshot section is ready', () => {
    expect(isDutyOverviewScreenshotReady(readyState)).toBe(true);
  });

  it.each(['loading', 'error'] as const)(
    'stays closed when any visible section is %s',
    (state) => {
      expect(
        isDutyOverviewScreenshotReady({
          ...readyState,
          personnelMovements: state,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ['weatherWidget', 'loading'],
    ['weatherWidget', 'error'],
    ['weatherTrend', 'loading'],
    ['weatherTrend', 'error'],
  ] as const)(
    'stays closed when the shared weather snapshot reports %s through %s',
    (section, state) => {
      expect(
        isDutyOverviewScreenshotReady({
          ...readyState,
          [section]: state,
        }),
      ).toBe(false);
    },
  );

  it('waits while emergency duty is loading but settles on an explicit error state', () => {
    expect(
      isDutyOverviewScreenshotReady({
        ...readyState,
        emergencyDuty: 'loading',
      }),
    ).toBe(false);
    expect(
      isDutyOverviewScreenshotReady({
        ...readyState,
        emergencyDuty: 'error',
      }),
    ).toBe(true);
  });
});
