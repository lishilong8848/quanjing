import { GatewayTimeoutException } from '@nestjs/common';
import { withPersonnelDirectoryDeadline } from '../../server/common/access/personnel-directory-deadline';

describe('personnel display request deadline', () => {
  afterEach(() => jest.useRealTimers());
  it('limits one wait while the shared read can still complete for another caller', async () => {
    jest.useFakeTimers();
    let resolve!: (value: string) => void;
    const shared = new Promise<string>(done => { resolve = done; });
    const first = withPersonnelDirectoryDeadline(shared);
    const check = expect(first).rejects.toBeInstanceOf(GatewayTimeoutException);
    await jest.advanceTimersByTimeAsync(50_000);
    await check;
    const second = withPersonnelDirectoryDeadline(shared);
    resolve('fresh snapshot');
    await expect(second).resolves.toBe('fresh snapshot');
    expect(jest.getTimerCount()).toBe(0);
  });
  it('preserves source rejection and clears the display timer', async () => {
    jest.useFakeTimers();
    const failure = new Error('synthetic-source-failure');
    await expect(withPersonnelDirectoryDeadline(Promise.reject(failure))).rejects.toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
  });
});
