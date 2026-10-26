import { readFileSync } from 'fs';
import { join } from 'path';
import {
  clearPendingWeatherWarningTestRequest,
  createWeatherWarningTestSubmissionGate,
  getOrCreateWeatherWarningTestRequest,
  isWeatherWarningTestResultUncertain,
  readPendingWeatherWarningTestRequest,
  savePendingWeatherWarningTestRequest,
  type WeatherWarningTestMutationStorage,
} from '../../client/src/pages/MonthlySchedule/weather-warning-test-send';

function createStorage(): WeatherWarningTestMutationStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe('MonthlySchedule weather warning test-card submission state', () => {
  it('defines the weather-warning API calls using the shared request and response contracts', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(source).toContain('WeatherWarningSnapshot');
    expect(source).toContain('WeatherWarningTestPreviewResponse');
    expect(source).toContain('WeatherWarningTestSendRequest');
    expect(source).toContain('WeatherWarningTestSendResponse');
    expect(source).toContain('getWeatherWarningSnapshot');
    expect(source).toContain("url: '/api/weather-warning/snapshot'");
    expect(source).toContain('getWeatherWarningTestPreview');
    expect(source).toContain("url: '/api/weather-warning/test-preview'");
    expect(source).toContain('sendWeatherWarningTestCard');
    expect(source).toContain("url: '/api/weather-warning/test-send'");
  });

  it('locks synchronously before UI state commits and can be released after the request settles', () => {
    const gate = createWeatherWarningTestSubmissionGate();

    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it('keeps the same pending mutation id for safe retries and clears it only after confirmed success', () => {
    const storage = createStorage();

    savePendingWeatherWarningTestRequest(
      {
        clientMutationId: 'weather-warning-request-20260804',
      },
      storage,
    );
    expect(readPendingWeatherWarningTestRequest(storage)).toEqual({
      clientMutationId: 'weather-warning-request-20260804',
    });
    expect(getOrCreateWeatherWarningTestRequest(storage)).toEqual({
      clientMutationId: 'weather-warning-request-20260804',
    });

    clearPendingWeatherWarningTestRequest(storage);
    expect(readPendingWeatherWarningTestRequest(storage)).toBeNull();
  });

  it('falls back to page memory when storage is unavailable without generating a second request id', () => {
    const unavailableStorage: WeatherWarningTestMutationStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    };

    savePendingWeatherWarningTestRequest(
      {
        clientMutationId: 'weather-warning-fallback-20260804',
      },
      unavailableStorage,
    );
    expect(getOrCreateWeatherWarningTestRequest(unavailableStorage)).toEqual({
      clientMutationId: 'weather-warning-fallback-20260804',
    });

    clearPendingWeatherWarningTestRequest(unavailableStorage);
  });

  it('does not replay a confirmed request in the current page when storage rejects its removal', () => {
    const values = new Map<string, string>();
    const storage: WeatherWarningTestMutationStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: () => {
        throw new Error('storage removal disabled');
      },
    };
    const completedRequest = {
      clientMutationId: 'weather-warning-completed-20260805',
    };

    savePendingWeatherWarningTestRequest(completedRequest, storage);
    clearPendingWeatherWarningTestRequest(storage);

    expect(
      getOrCreateWeatherWarningTestRequest(storage).clientMutationId,
    ).not.toBe(completedRequest.clientMutationId);

    clearPendingWeatherWarningTestRequest(storage);
  });

  it('treats transport failures as uncertain but classifies all true 4xx rejections as determined failures', () => {
    expect(
      isWeatherWarningTestResultUncertain({
        code: 'ECONNABORTED',
        message: 'timeout of 30000ms exceeded',
      }),
    ).toBe(true);
    expect(
      isWeatherWarningTestResultUncertain({
        code: 'ERR_NETWORK',
        message: 'network unavailable',
      }),
    ).toBe(true);
    expect(
      isWeatherWarningTestResultUncertain({
        response: { status: 408 },
      }),
    ).toBe(true);
    expect(
      isWeatherWarningTestResultUncertain({
        response: { status: 504 },
      }),
    ).toBe(true);
    expect(
      isWeatherWarningTestResultUncertain({
        response: { status: 400 },
      }),
    ).toBe(false);
    expect(
      isWeatherWarningTestResultUncertain({
        response: { status: 429 },
      }),
    ).toBe(false);
  });
});
