export type AlarmRequestLoadState = 'loading' | 'ready' | 'error';

export interface AlarmRequestState<T> {
  data: T | null;
  dataRequestKey: string | null;
  loadState: AlarmRequestLoadState;
}

export function createInitialAlarmRequestState<T>(): AlarmRequestState<T> {
  return {
    data: null,
    dataRequestKey: null,
    loadState: 'loading',
  };
}

export function beginAlarmRequest<T>(
  state: AlarmRequestState<T>,
): AlarmRequestState<T> {
  return {
    ...state,
    loadState: 'loading',
  };
}

export function completeAlarmRequest<T>(
  state: AlarmRequestState<T>,
  result: {
    isCurrent: boolean;
    requestKey: string;
    data: T;
  },
): AlarmRequestState<T> {
  if (!result.isCurrent) return state;

  return {
    data: result.data,
    dataRequestKey: result.requestKey,
    loadState: 'ready',
  };
}

export function failAlarmRequest<T>(
  state: AlarmRequestState<T>,
  result: { isCurrent: boolean },
): AlarmRequestState<T> {
  if (!result.isCurrent) return state;

  return {
    ...state,
    loadState: 'error',
  };
}

export function isAlarmListRequestPending<T>(
  state: AlarmRequestState<T>,
  requestKey: string,
): boolean {
  return (
    state.loadState === 'loading' && state.dataRequestKey !== requestKey
  );
}

export function getAlarmPaginationDisabledState({
  currentPage,
  totalPages,
  pending,
}: {
  currentPage: number;
  totalPages: number;
  pending: boolean;
}): { previous: boolean; next: boolean } {
  return {
    previous: pending || currentPage <= 1,
    next: pending || currentPage >= totalPages,
  };
}
