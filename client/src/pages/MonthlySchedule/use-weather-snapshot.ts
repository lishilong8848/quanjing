import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getQWeatherHourly,
  getQWeatherNow,
  getWeatherWarningSnapshot,
  type QWeatherHourly,
  type QWeatherNow,
} from '../../api';
import type { WeatherWarningSnapshot } from '@shared/api.interface';
import {
  WEATHER_CURRENT_AND_HOURLY_REFRESH_MS,
  WEATHER_WARNING_REFRESH_MS,
} from './weather-snapshot';

export { WEATHER_CURRENT_AND_HOURLY_REFRESH_MS, WEATHER_WARNING_REFRESH_MS };

export type WeatherSnapshotResourceStatus =
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'error';

export type WeatherSnapshotScreenshotReadiness = 'loading' | 'ready' | 'error';

export type WeatherWarningFailureKind =
  | 'permission'
  | 'configuration'
  | 'timeout'
  | 'unavailable';

export interface WeatherWarningRefreshFailure {
  kind: WeatherWarningFailureKind;
  message: string;
}

export interface WeatherSnapshotRequestApi {
  getQWeatherNow: (signal?: AbortSignal) => Promise<QWeatherNow>;
  getQWeatherHourly: (signal?: AbortSignal) => Promise<QWeatherHourly>;
  getWeatherWarningSnapshot: (
    signal?: AbortSignal,
  ) => Promise<WeatherWarningSnapshot>;
}

export interface WeatherSnapshotRefreshState {
  weather: QWeatherNow | null;
  hourlyWeather: QWeatherHourly | null;
  warningSnapshot: WeatherWarningSnapshot | null;
  warningStatus: WeatherSnapshotResourceStatus;
  weatherStatus: WeatherSnapshotResourceStatus;
  warningError: string | null;
  warningFailureKind: WeatherWarningFailureKind | null;
  weatherError: string | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  screenshotReadiness: WeatherSnapshotScreenshotReadiness;
}

export interface WeatherSnapshotRefreshCoordinator {
  getState: () => WeatherSnapshotRefreshState;
  start: () => Promise<void>;
  stop: () => void;
  refreshWarning: () => Promise<void>;
  refreshCurrentAndHourly: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export interface CreateWeatherSnapshotRefreshCoordinatorOptions {
  requests: WeatherSnapshotRequestApi;
  onStateChange?: (state: WeatherSnapshotRefreshState) => void;
}

export interface UseWeatherSnapshotOptions {
  requests?: WeatherSnapshotRequestApi;
}

export interface UseWeatherSnapshotResult extends WeatherSnapshotRefreshState {
  refreshWarning: () => Promise<void>;
  refreshCurrentAndHourly: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

interface WeatherRequestRun {
  requestId: number;
  controller: AbortController;
  current: Promise<QWeatherNow>;
  hourly: Promise<QWeatherHourly>;
}

interface WarningRequestRun {
  requestId: number;
  controller: AbortController;
  request: Promise<WeatherWarningSnapshot>;
}

const defaultWeatherSnapshotRequestApi: WeatherSnapshotRequestApi = {
  getQWeatherNow: (signal) => getQWeatherNow({ signal }),
  getQWeatherHourly: (signal) => getQWeatherHourly({ signal }),
  getWeatherWarningSnapshot: (signal) => getWeatherWarningSnapshot({ signal }),
};

const WEATHER_REFRESH_ERROR_MESSAGE = '天气实况或逐小时预报暂时不可用';
const WARNING_REFRESH_ERROR_MESSAGE = '天气预警快照暂时不可用';

export function getWeatherWarningRefreshFailure(
  error: unknown,
): WeatherWarningRefreshFailure {
  const candidate = isRecord(error) ? error : null;
  const response = isRecord(candidate?.response) ? candidate.response : null;
  const status = Number(response?.status);

  if (status === 401 || status === 403) {
    return {
      kind: 'permission',
      message: '当前账号无权读取天气预警快照',
    };
  }
  if (status === 503) {
    return {
      kind: 'configuration',
      message: '天气预警服务配置暂不可用',
    };
  }

  const code =
    typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : '';
  if (
    status === 408 ||
    status === 504 ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT'
  ) {
    return { kind: 'timeout', message: '天气预警快照获取超时' };
  }

  return { kind: 'unavailable', message: WARNING_REFRESH_ERROR_MESSAGE };
}

export function getWeatherWarningRefreshErrorMessage(error: unknown): string {
  return getWeatherWarningRefreshFailure(error).message;
}

export function createWeatherSnapshotRefreshCoordinator(
  options: CreateWeatherSnapshotRefreshCoordinatorOptions,
): WeatherSnapshotRefreshCoordinator {
  let state = createInitialState();
  let warningRequestId = 0;
  let weatherRequestId = 0;
  let warningController: AbortController | null = null;
  let weatherController: AbortController | null = null;
  let warningTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let weatherTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let disposed = false;
  let started = false;
  let initialLoad: Promise<void> | null = null;

  const emit = (nextState: WeatherSnapshotRefreshState) => {
    state = nextState;
    options.onStateChange?.(state);
  };

  const update = (
    updater: (
      current: WeatherSnapshotRefreshState,
    ) => WeatherSnapshotRefreshState,
  ) => {
    if (disposed) return;
    emit(finalizeState(updater(state)));
  };

  const isCurrentWarningRun = (run: WarningRequestRun) =>
    !disposed && warningRequestId === run.requestId;
  const isCurrentWeatherRun = (run: WeatherRequestRun) =>
    !disposed && weatherRequestId === run.requestId;

  const beginWarningRequest = (): WarningRequestRun => {
    warningController?.abort();
    const controller = new AbortController();
    warningController = controller;
    const requestId = ++warningRequestId;
    update((current) => ({
      ...current,
      warningStatus: current.warningSnapshot ? 'refreshing' : 'loading',
      warningError: isDisplayableWarningSnapshot(current.warningSnapshot)
        ? null
        : current.warningError,
      warningFailureKind: isDisplayableWarningSnapshot(current.warningSnapshot)
        ? null
        : current.warningFailureKind,
    }));

    return {
      requestId,
      controller,
      request: invokeRequest(() =>
        options.requests.getWeatherWarningSnapshot(controller.signal),
      ),
    };
  };

  const beginWeatherRequest = (): WeatherRequestRun => {
    weatherController?.abort();
    const controller = new AbortController();
    weatherController = controller;
    const requestId = ++weatherRequestId;
    update((current) => ({
      ...current,
      weatherStatus:
        current.weather || current.hourlyWeather ? 'refreshing' : 'loading',
      weatherError: null,
    }));

    return {
      requestId,
      controller,
      current: invokeRequest(() =>
        options.requests.getQWeatherNow(controller.signal),
      ),
      hourly: invokeRequest(() =>
        options.requests.getQWeatherHourly(controller.signal),
      ),
    };
  };

  const applyWarningResult = (
    run: WarningRequestRun,
    result: PromiseSettledResult<WeatherWarningSnapshot>,
  ) => {
    if (!isCurrentWarningRun(run)) return;
    if (warningController === run.controller) warningController = null;

    if (result.status === 'fulfilled') {
      update((current) => ({
        ...current,
        warningSnapshot: result.value,
        warningStatus: 'ready',
        warningError: null,
        warningFailureKind: null,
      }));
      return;
    }

    const failure = getWeatherWarningRefreshFailure(result.reason);
    update((current) => ({
      ...current,
      warningStatus: 'error',
      warningError: failure.message,
      warningFailureKind: failure.kind,
    }));
  };

  const applyWeatherResults = (
    run: WeatherRequestRun,
    currentResult: PromiseSettledResult<QWeatherNow>,
    hourlyResult: PromiseSettledResult<QWeatherHourly>,
  ) => {
    if (!isCurrentWeatherRun(run)) return;
    if (weatherController === run.controller) weatherController = null;

    const hasUsableCurrentWeather =
      currentResult.status === 'fulfilled' &&
      isUsableCurrentWeather(currentResult.value);
    const hasUsableHourlyWeather =
      hourlyResult.status === 'fulfilled' &&
      isUsableHourlyWeather(hourlyResult.value);
    const hasFailure = !hasUsableCurrentWeather || !hasUsableHourlyWeather;
    update((current) => ({
      ...current,
      weather: hasUsableCurrentWeather ? currentResult.value : current.weather,
      hourlyWeather: hasUsableHourlyWeather
        ? hourlyResult.value
        : current.hourlyWeather,
      weatherStatus: hasFailure ? 'error' : 'ready',
      weatherError: hasFailure ? WEATHER_REFRESH_ERROR_MESSAGE : null,
    }));
  };

  const refreshWarning = async () => {
    if (disposed) return;
    const run = beginWarningRequest();
    const [result] = await Promise.allSettled([run.request]);
    applyWarningResult(run, result);
  };

  const refreshCurrentAndHourly = async () => {
    if (disposed) return;
    const run = beginWeatherRequest();
    const [currentResult, hourlyResult] = await Promise.allSettled([
      run.current,
      run.hourly,
    ]);
    applyWeatherResults(run, currentResult, hourlyResult);
  };

  const refreshAll = async () => {
    await Promise.allSettled([refreshWarning(), refreshCurrentAndHourly()]);
  };

  const start = (): Promise<void> => {
    if (disposed || started) return initialLoad || Promise.resolve();
    started = true;

    const warningRun = beginWarningRequest();
    const weatherRun = beginWeatherRequest();
    initialLoad = Promise.allSettled([
      warningRun.request,
      weatherRun.current,
      weatherRun.hourly,
    ]).then(([warningResult, currentResult, hourlyResult]) => {
      applyWarningResult(warningRun, warningResult);
      applyWeatherResults(weatherRun, currentResult, hourlyResult);
      if (!disposed) {
        update((current) => ({ ...current, isInitialLoading: false }));
      }
    });

    warningTimer = globalThis.setInterval(() => {
      void refreshWarning();
    }, WEATHER_WARNING_REFRESH_MS);
    weatherTimer = globalThis.setInterval(() => {
      void refreshCurrentAndHourly();
    }, WEATHER_CURRENT_AND_HOURLY_REFRESH_MS);

    return initialLoad;
  };

  const stop = () => {
    if (disposed) return;
    disposed = true;
    if (warningTimer !== null) globalThis.clearInterval(warningTimer);
    if (weatherTimer !== null) globalThis.clearInterval(weatherTimer);
    warningTimer = null;
    weatherTimer = null;
    warningController?.abort();
    weatherController?.abort();
    warningController = null;
    weatherController = null;
  };

  return {
    getState: () => state,
    start,
    stop,
    refreshWarning,
    refreshCurrentAndHourly,
    refreshAll,
  };
}

export function useWeatherSnapshot(
  options: UseWeatherSnapshotOptions = {},
): UseWeatherSnapshotResult {
  const requestsRef = useRef<WeatherSnapshotRequestApi>(
    options.requests || defaultWeatherSnapshotRequestApi,
  );
  const coordinatorRef = useRef<WeatherSnapshotRefreshCoordinator | null>(null);
  const [state, setState] =
    useState<WeatherSnapshotRefreshState>(createInitialState);

  useEffect(() => {
    const coordinator = createWeatherSnapshotRefreshCoordinator({
      requests: requestsRef.current,
      onStateChange: setState,
    });
    coordinatorRef.current = coordinator;
    void coordinator.start();

    return () => {
      coordinator.stop();
      if (coordinatorRef.current === coordinator) {
        coordinatorRef.current = null;
      }
    };
  }, []);

  const refreshWarning = useCallback(
    () => coordinatorRef.current?.refreshWarning() || Promise.resolve(),
    [],
  );
  const refreshCurrentAndHourly = useCallback(
    () =>
      coordinatorRef.current?.refreshCurrentAndHourly() || Promise.resolve(),
    [],
  );
  const refreshAll = useCallback(
    () => coordinatorRef.current?.refreshAll() || Promise.resolve(),
    [],
  );

  return {
    ...state,
    refreshWarning,
    refreshCurrentAndHourly,
    refreshAll,
  };
}

function createInitialState(): WeatherSnapshotRefreshState {
  return finalizeState({
    weather: null,
    hourlyWeather: null,
    warningSnapshot: null,
    warningStatus: 'loading',
    weatherStatus: 'loading',
    warningError: null,
    warningFailureKind: null,
    weatherError: null,
    isInitialLoading: true,
    isRefreshing: false,
    screenshotReadiness: 'loading',
  });
}

function finalizeState(
  state: WeatherSnapshotRefreshState,
): WeatherSnapshotRefreshState {
  const warningSnapshot = deriveDisplayWarningSnapshot(
    state.warningSnapshot,
    state.warningStatus,
  );
  const hasDisplayableWeather = isUsableCurrentWeather(state.weather);
  const hasDisplayableHourly = isUsableHourlyWeather(state.hourlyWeather);
  const hasDisplayableWarning = isDisplayableWarningSnapshot(warningSnapshot);
  const hasRenderedWarningFallback =
    state.warningStatus === 'error' &&
    state.warningSnapshot === null &&
    Boolean(state.warningError);

  return {
    ...state,
    warningSnapshot,
    isRefreshing:
      state.warningStatus === 'refreshing' ||
      state.weatherStatus === 'refreshing',
    screenshotReadiness:
      hasDisplayableWeather &&
      hasDisplayableHourly &&
      (hasDisplayableWarning || hasRenderedWarningFallback)
        ? 'ready'
        : state.isInitialLoading
          ? 'loading'
          : 'error',
  };
}

function isUsableCurrentWeather(
  weather: QWeatherNow | null | undefined,
): weather is QWeatherNow {
  return (
    weather?.code === '200' &&
    typeof weather.now?.temp === 'string' &&
    weather.now.temp.trim() !== '' &&
    weather.now.temp !== '--'
  );
}

function isUsableHourlyWeather(
  hourlyWeather: QWeatherHourly | null | undefined,
): hourlyWeather is QWeatherHourly {
  return (
    hourlyWeather?.code === '200' &&
    Array.isArray(hourlyWeather.hourly) &&
    hourlyWeather.hourly.length > 0
  );
}

function deriveDisplayWarningSnapshot(
  warningSnapshot: WeatherWarningSnapshot | null,
  warningStatus: WeatherSnapshotResourceStatus,
): WeatherWarningSnapshot | null {
  if (
    warningStatus !== 'error' ||
    warningSnapshot === null ||
    warningSnapshot.status === 'stale'
  ) {
    return warningSnapshot;
  }

  return {
    ...warningSnapshot,
    status: 'degraded',
    sourceState: 'degraded',
    guardDecisionState: 'stale',
  };
}

function isDisplayableWarningSnapshot(
  warningSnapshot: WeatherWarningSnapshot | null,
): boolean {
  return (
    warningSnapshot?.status === 'active' ||
    warningSnapshot?.status === 'clear' ||
    warningSnapshot?.status === 'degraded'
  );
}

function invokeRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(request());
  } catch (error) {
    return Promise.reject(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
