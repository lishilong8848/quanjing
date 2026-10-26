import {
  beginAlarmRequest,
  completeAlarmRequest,
  createInitialAlarmRequestState,
  failAlarmRequest,
  getAlarmPaginationDisabledState,
  isAlarmListRequestPending,
  type AlarmRequestState,
} from '../../client/src/pages/TodayOperationsPanorama/alarm-request-state';

interface AlarmData {
  label: string;
}

const cachedData: AlarmData = { label: 'cached alarms' };
const cachedState: AlarmRequestState<AlarmData> = {
  data: cachedData,
  dataRequestKey: 'old-request',
  loadState: 'ready',
};

describe('today operations alarm request state', () => {
  it('begins a new request without discarding the cached response', () => {
    expect(createInitialAlarmRequestState<AlarmData>()).toEqual({
      data: null,
      dataRequestKey: null,
      loadState: 'loading',
    });

    const nextState = beginAlarmRequest(cachedState);

    expect(nextState).toEqual({
      data: cachedData,
      dataRequestKey: 'old-request',
      loadState: 'loading',
    });
    expect(nextState).not.toBe(cachedState);
    expect(cachedState.loadState).toBe('ready');
    expect(isAlarmListRequestPending(nextState, 'new-request')).toBe(true);
    expect(isAlarmListRequestPending(nextState, 'old-request')).toBe(false);
  });

  it('returns the current state object for a stale success', () => {
    const result = completeAlarmRequest(cachedState, {
      isCurrent: false,
      requestKey: 'new-request',
      data: { label: 'stale alarms' },
    });

    expect(result).toBe(cachedState);
  });

  it('keeps cached data on a current failure and ignores a stale failure', () => {
    const failedState = failAlarmRequest(cachedState, { isCurrent: true });

    expect(failedState).toEqual({
      data: cachedData,
      dataRequestKey: 'old-request',
      loadState: 'error',
    });
    expect(failedState).not.toBe(cachedState);
    expect(failAlarmRequest(cachedState, { isCurrent: false })).toBe(
      cachedState,
    );
  });

  it('replaces cached data only for the current success and clears pending', () => {
    const nextData: AlarmData = { label: 'current alarms' };
    const completedState = completeAlarmRequest(
      beginAlarmRequest(cachedState),
      {
        isCurrent: true,
        requestKey: 'new-request',
        data: nextData,
      },
    );

    expect(completedState).toEqual({
      data: nextData,
      dataRequestKey: 'new-request',
      loadState: 'ready',
    });
    expect(isAlarmListRequestPending(completedState, 'new-request')).toBe(
      false,
    );
  });

  it('disables both pagination directions while replacement data is pending', () => {
    expect(
      getAlarmPaginationDisabledState({
        currentPage: 4,
        totalPages: 10,
        pending: true,
      }),
    ).toEqual({ previous: true, next: true });
    expect(
      getAlarmPaginationDisabledState({
        currentPage: 4,
        totalPages: 10,
        pending: false,
      }),
    ).toEqual({ previous: false, next: false });
  });

  it('keeps the corresponding pagination direction disabled at each boundary', () => {
    expect(
      getAlarmPaginationDisabledState({
        currentPage: 1,
        totalPages: 10,
        pending: false,
      }),
    ).toEqual({ previous: true, next: false });
    expect(
      getAlarmPaginationDisabledState({
        currentPage: 10,
        totalPages: 10,
        pending: false,
      }),
    ).toEqual({ previous: false, next: true });
  });
});
