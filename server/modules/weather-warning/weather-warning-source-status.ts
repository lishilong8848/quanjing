export type WeatherWarningSourceState =
  | 'fresh'
  | 'degraded'
  | 'stale'
  | 'unavailable';

export interface WeatherWarningFetchResult<T> {
  state: WeatherWarningSourceState;
  data: T | null;
  fetchedAt: string;
  lastSuccessAt?: string;
  warningCount: number;
  isStale: boolean;
  errorMessage?: string;
}

export interface WeatherWarningSourceStatusInput<
  T extends { warning?: unknown[] },
> {
  nowMs: number;
  staleAfterMs: number;
  latest?: T;
  latestFetchedAt?: string;
  lastSuccess?: T;
  lastSuccessAt?: string;
  errorMessage?: string;
}

export function resolveWeatherWarningSourceStatus<
  T extends { warning?: unknown[] },
>(input: WeatherWarningSourceStatusInput<T>): WeatherWarningFetchResult<T> {
  const nowMs = getValidNowMs(input.nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const latestFetchedAt = getValidDateTime(input.latestFetchedAt);

  if (input.latest) {
    const fetchedAt = latestFetchedAt || nowIso;
    return {
      state: 'fresh',
      data: input.latest,
      fetchedAt,
      ...(latestFetchedAt ? { lastSuccessAt: latestFetchedAt } : {}),
      warningCount: getWarningCount(input.latest),
      isStale: false,
    };
  }

  const lastSuccessAt = getValidDateTime(input.lastSuccessAt);
  if (input.lastSuccess && lastSuccessAt) {
    const ageMs = Math.max(0, nowMs - Date.parse(lastSuccessAt));
    const isStale = ageMs > Math.max(0, input.staleAfterMs);
    return {
      state: isStale ? 'stale' : 'degraded',
      data: input.lastSuccess,
      fetchedAt: nowIso,
      lastSuccessAt,
      warningCount: getWarningCount(input.lastSuccess),
      isStale,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    };
  }

  return {
    state: 'unavailable',
    data: null,
    fetchedAt: nowIso,
    warningCount: 0,
    isStale: false,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

function getWarningCount(data: { warning?: unknown[] }): number {
  return Array.isArray(data.warning) ? data.warning.length : 0;
}

function getValidDateTime(value?: string): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }

  return value;
}

function getValidNowMs(value: number): number {
  const timestamp = Number.isFinite(value)
    ? new Date(value).getTime()
    : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}
