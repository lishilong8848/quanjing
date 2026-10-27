import {
  startTrainingRefreshPolling,
  TRAINING_REFRESH_WAIT_LIMIT_MS,
} from '../../client/src/pages/CampusTrainingDashboard/refresh-polling';

describe('training background refresh polling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('continues beyond sixty seconds and stops once fresh data arrives', async () => {
    const read = jest.fn().mockResolvedValue('refreshing');
    const stopped = jest.fn();
    startTrainingRefreshPolling(read, stopped);
    await jest.advanceTimersByTimeAsync(63_000);
    expect(read).toHaveBeenCalledTimes(21);
    read.mockResolvedValue('fresh');
    await jest.advanceTimersByTimeAsync(3_000);
    expect(read).toHaveBeenCalledTimes(22);
    await jest.advanceTimersByTimeAsync(TRAINING_REFRESH_WAIT_LIMIT_MS);
    expect(read).toHaveBeenCalledTimes(22);
    expect(stopped).not.toHaveBeenCalled();
  });

  it('keeps one poll in flight and waits after its completion', async () => {
    let release!: (value: 'refreshing') => void;
    const read = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue('fresh');
    startTrainingRefreshPolling(read, jest.fn());
    await jest.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(1);
    release('refreshing');
    await jest.advanceTimersByTimeAsync(2_999);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives a timeout action even when a read is still pending, without scheduling another', async () => {
    let release!: (value: 'refreshing') => void;
    const read = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const stopped = jest.fn();
    startTrainingRefreshPolling(read, stopped);
    await jest.advanceTimersByTimeAsync(TRAINING_REFRESH_WAIT_LIMIT_MS);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith('timeout');
    release('refreshing');
    await jest.advanceTimersByTimeAsync(TRAINING_REFRESH_WAIT_LIMIT_MS);
    expect(read).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it.each(['stale', undefined])(
    'stops when the response is %s',
    async (value) => {
      const read = jest.fn().mockResolvedValue(value);
      const stopped = jest.fn();
      startTrainingRefreshPolling(read, stopped);
      await jest.advanceTimersByTimeAsync(TRAINING_REFRESH_WAIT_LIMIT_MS);
      expect(read).toHaveBeenCalledTimes(1);
      expect(stopped).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not automatically retry a transport failure (reject=%s)',
    async (rejects) => {
      const read = rejects
        ? jest.fn().mockRejectedValue(new Error('synthetic unavailable'))
        : jest.fn().mockResolvedValue('error');
      const stopped = jest.fn();
      startTrainingRefreshPolling(read, stopped);
      await jest.advanceTimersByTimeAsync(TRAINING_REFRESH_WAIT_LIMIT_MS);
      expect(read).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveBeenCalledWith('error');
    },
  );

  it('cancels pending retries and ignores failure callbacks after a month change/unmount', async () => {
    let reject!: (error: Error) => void;
    const read = jest.fn().mockImplementation(
      () =>
        new Promise((_, failure) => {
          reject = failure;
        }),
    );
    const stopped = jest.fn();
    const cancel = startTrainingRefreshPolling(read, stopped);
    await jest.advanceTimersByTimeAsync(3_000);
    cancel();
    reject(new Error('old request'));
    await jest.advanceTimersByTimeAsync(TRAINING_REFRESH_WAIT_LIMIT_MS);
    expect(read).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();
  });
});
