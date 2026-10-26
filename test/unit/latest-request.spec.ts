import { createLatestRequestCoordinator } from '../../client/src/pages/ContractManagement/latest-request';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function handlers<T>() {
  return {
    onSuccess: jest.fn<void, [T]>(),
    onError: jest.fn<void, [unknown]>(),
    onSettled: jest.fn<void, []>(),
  };
}

describe('latest request coordinator', () => {
  it('ignores an older success after a later request succeeds', async () => {
    const coordinator = createLatestRequestCoordinator();
    const older = deferred<string>();
    const latest = deferred<string>();
    const olderHandlers = handlers<string>();
    const latestHandlers = handlers<string>();

    const olderRun = coordinator.run(older.promise, olderHandlers);
    const latestRun = coordinator.run(latest.promise, latestHandlers);

    latest.resolve('latest');
    await latestRun;
    older.resolve('older');
    await olderRun;

    expect(latestHandlers.onSuccess).toHaveBeenCalledWith('latest');
    expect(latestHandlers.onSettled).toHaveBeenCalledTimes(1);
    expect(olderHandlers.onSuccess).not.toHaveBeenCalled();
    expect(olderHandlers.onSettled).not.toHaveBeenCalled();
  });

  it('ignores an older rejection after a later request succeeds', async () => {
    const coordinator = createLatestRequestCoordinator();
    const older = deferred<string>();
    const latest = deferred<string>();
    const olderHandlers = handlers<string>();
    const latestHandlers = handlers<string>();

    const olderRun = coordinator.run(older.promise, olderHandlers);
    const latestRun = coordinator.run(latest.promise, latestHandlers);

    latest.resolve('latest');
    await latestRun;
    older.reject(new Error('stale failure'));
    await olderRun;

    expect(latestHandlers.onSuccess).toHaveBeenCalledWith('latest');
    expect(olderHandlers.onError).not.toHaveBeenCalled();
    expect(olderHandlers.onSettled).not.toHaveBeenCalled();
  });

  it('suppresses callbacks when invalidated before resolve or reject', async () => {
    const coordinator = createLatestRequestCoordinator();
    const resolving = deferred<string>();
    const resolvingHandlers = handlers<string>();
    const resolvingRun = coordinator.run(resolving.promise, resolvingHandlers);

    coordinator.invalidate();
    resolving.resolve('ignored');
    await resolvingRun;

    const rejecting = deferred<string>();
    const rejectingHandlers = handlers<string>();
    const rejectingRun = coordinator.run(rejecting.promise, rejectingHandlers);

    coordinator.invalidate();
    rejecting.reject(new Error('ignored'));
    await rejectingRun;

    for (const callback of [
      ...Object.values(resolvingHandlers),
      ...Object.values(rejectingHandlers),
    ]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it('calls onError and onSettled for the current rejected request', async () => {
    const coordinator = createLatestRequestCoordinator();
    const current = deferred<string>();
    const currentHandlers = handlers<string>();
    const error = new Error('current failure');

    const currentRun = coordinator.run(current.promise, currentHandlers);
    current.reject(error);
    await currentRun;

    expect(currentHandlers.onError).toHaveBeenCalledWith(error);
    expect(currentHandlers.onSuccess).not.toHaveBeenCalled();
    expect(currentHandlers.onSettled).toHaveBeenCalledTimes(1);
  });
});
