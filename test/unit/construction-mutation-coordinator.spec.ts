import {
  createConstructionMutationCoordinator,
  createConstructionRecordAliasRegistry,
  createLatestConstructionRequestCoordinator,
} from '../../client/src/pages/ConstructionManagement/mutation-coordinator';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function latestHandlers<T>() {
  return {
    onSuccess: jest.fn<void, [T]>(),
    onError: jest.fn<void, [unknown]>(),
    onSettled: jest.fn<void, []>(),
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('construction mutation coordinator', () => {
  it('rejects duplicate keys without replacing them and allows different keys', () => {
    const coordinator = createConstructionMutationCoordinator<number>();

    expect(
      coordinator.begin({
        key: 'p1:day:personnel',
        apply: (value) => value + 1,
        matches: () => false,
      }),
    ).toBe(true);
    expect(
      coordinator.begin({
        key: 'p1:day:personnel',
        apply: (value) => value + 100,
        matches: () => false,
      }),
    ).toBe(false);
    expect(
      coordinator.begin({
        key: 'p2:day:personnel',
        apply: (value) => value + 10,
        matches: () => false,
      }),
    ).toBe(true);

    expect(coordinator.has('p1:day:personnel')).toBe(true);
    expect(coordinator.has('p2:day:personnel')).toBe(true);
    expect(coordinator.applyPending(0)).toBe(11);
  });

  it('finishes a pending layer by key', () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    coordinator.begin({
      key: 'p1',
      apply: (value) => value + 1,
      matches: () => false,
    });

    coordinator.finish('p1');

    expect(coordinator.has('p1')).toBe(false);
    expect(coordinator.applyPending(0)).toBe(0);
  });

  it('applies pending layers in insertion order', () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    coordinator.begin({
      key: 'add',
      apply: (value) => value + 2,
      matches: () => false,
    });
    coordinator.begin({
      key: 'multiply',
      apply: (value) => value * 3,
      matches: () => false,
    });

    expect(coordinator.applyPending(1)).toBe(9);
  });

  it('reconciles against authoritative data and replays only unmatched layers', () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    const observedValues: number[] = [];
    coordinator.begin({
      key: 'add',
      apply: (value) => value + 1,
      matches: (value) => {
        observedValues.push(value);
        return false;
      },
    });
    coordinator.begin({
      key: 'confirmed',
      apply: (value) => value + 100,
      matches: (value) => {
        observedValues.push(value);
        return value === 10;
      },
    });
    coordinator.begin({
      key: 'multiply',
      apply: (value) => value * 2,
      matches: (value) => {
        observedValues.push(value);
        return false;
      },
    });

    const result = coordinator.reconcile(10);

    expect(observedValues).toEqual([10, 10, 10]);
    expect(result).toEqual({
      value: 22,
      confirmedKeys: ['confirmed'],
    });
    expect(coordinator.has('add')).toBe(true);
    expect(coordinator.has('confirmed')).toBe(false);
    expect(coordinator.has('multiply')).toBe(true);
    expect(coordinator.applyPending(10)).toBe(22);
  });

  it('runs operations in the same scope strictly in enqueue order', async () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = coordinator.enqueue('p1:2026-07-24', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 'first';
    });
    const second = coordinator.enqueue('p1:2026-07-24', async () => {
      events.push('second');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    firstGate.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('resolves an optimistic follow-up id to the real id before a queued dependant runs', async () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    const aliases = createConstructionRecordAliasRegistry();
    const firstGate = deferred<void>();
    const scope = 'project-1:2026-07-24';
    const optimisticRecordId =
      'optimistic:project-1:2026-07-24:workType';

    const first = coordinator.enqueue(scope, async () => {
      await firstGate.promise;
      return { recordId: 'real-followup-1' };
    });
    const registeredFirst = first.then((result) => {
      aliases.remember(scope, result.recordId);
      return result;
    });
    const resolvedIds: Array<string | null> = [];
    const second = coordinator.enqueue(scope, async () => {
      const resolved = aliases.resolve(scope, optimisticRecordId);
      resolvedIds.push(resolved);
      return resolved;
    });

    firstGate.resolve();
    await expect(registeredFirst).resolves.toEqual({
      recordId: 'real-followup-1',
    });
    await expect(second).resolves.toBe('real-followup-1');
    expect(resolvedIds).toEqual(['real-followup-1']);
    expect(resolvedIds).not.toContain(optimisticRecordId);
    expect(aliases.resolve('existing-scope', 'real-existing')).toBe(
      'real-existing',
    );
    aliases.remember('ignored-scope', 'optimistic:never-register');
    expect(
      aliases.resolve('ignored-scope', 'optimistic:never-register'),
    ).toBeNull();
  });

  it('prefers and remembers a new real candidate and supports scoped or full cleanup', () => {
    const aliases = createConstructionRecordAliasRegistry();
    aliases.remember('scope-a', 'real-old');

    expect(aliases.resolve('scope-a', 'real-new')).toBe('real-new');
    expect(aliases.resolve('scope-a', 'optimistic:later')).toBe('real-new');

    aliases.remember('scope-b', 'real-b');
    aliases.clear('scope-a');
    expect(aliases.resolve('scope-a', 'optimistic:none')).toBeNull();
    expect(aliases.resolve('scope-b', 'optimistic:keep')).toBe('real-b');

    aliases.clear();
    expect(aliases.resolve('scope-b', 'optimistic:none')).toBeNull();
  });

  it('runs queued dependants after a predecessor fails without reusing its error', async () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    const error = new Error('work type failed');
    const first = coordinator.enqueue('p1:2026-07-24', async () => {
      throw error;
    });
    const secondAction = jest.fn(async () => 'personnel');
    const thirdAction = jest.fn(async () => 'isolation');
    const second = coordinator.enqueue('p1:2026-07-24', secondAction);
    const third = coordinator.enqueue('p1:2026-07-24', thirdAction);

    await expect(first).rejects.toBe(error);
    await expect(second).resolves.toBe('personnel');
    await expect(third).resolves.toBe('isolation');
    expect(secondAction).toHaveBeenCalledTimes(1);
    expect(thirdAction).toHaveBeenCalledTimes(1);
  });

  it('keeps the scope queue healthy after a failed operation', async () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    const error = new Error('failed chain');
    const failed = coordinator.enqueue('p1', async () => {
      throw error;
    });
    const queuedAction = jest.fn(async () => 'queued');
    const queued = coordinator.enqueue('p1', queuedAction);

    await expect(failed).rejects.toBe(error);
    await expect(queued).resolves.toBe('queued');

    const recoveredAction = jest.fn(async () => 'recovered');
    await expect(coordinator.enqueue('p1', recoveredAction)).resolves.toBe(
      'recovered',
    );
    expect(queuedAction).toHaveBeenCalledTimes(1);
    expect(recoveredAction).toHaveBeenCalledTimes(1);
  });

  it('runs operations in different scopes independently', async () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    const firstGate = deferred<void>();
    const events: string[] = [];

    const firstScope = coordinator.enqueue('p1', async () => {
      events.push('p1:start');
      await firstGate.promise;
      events.push('p1:end');
      return 'p1';
    });
    const secondScope = coordinator.enqueue('p2', async () => {
      events.push('p2');
      return 'p2';
    });

    await expect(secondScope).resolves.toBe('p2');
    expect(events).toEqual(['p1:start', 'p2']);

    firstGate.resolve();
    await expect(firstScope).resolves.toBe('p1');
    expect(events).toEqual(['p1:start', 'p2', 'p1:end']);
  });

  it('does not emit an unhandled rejection for an ignored failed operation', async () => {
    const coordinator = createConstructionMutationCoordinator<number>();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);

    try {
      void coordinator.enqueue('ignored', async () => {
        throw new Error('ignored failure');
      });
      await nextTurn();
      await nextTurn();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('latest construction request coordinator', () => {
  it('allows only the latest success and settled callbacks', async () => {
    const coordinator = createLatestConstructionRequestCoordinator();
    const older = deferred<string>();
    const latest = deferred<string>();
    const olderHandlers = latestHandlers<string>();
    const latestRequestHandlers = latestHandlers<string>();

    const olderRun = coordinator.run(older.promise, olderHandlers);
    const latestRun = coordinator.run(
      latest.promise,
      latestRequestHandlers,
    );

    older.resolve('older');
    await olderRun;
    expect(olderHandlers.onSuccess).not.toHaveBeenCalled();
    expect(olderHandlers.onError).not.toHaveBeenCalled();
    expect(olderHandlers.onSettled).not.toHaveBeenCalled();

    latest.resolve('latest');
    await latestRun;
    expect(latestRequestHandlers.onSuccess).toHaveBeenCalledWith('latest');
    expect(latestRequestHandlers.onError).not.toHaveBeenCalled();
    expect(latestRequestHandlers.onSettled).toHaveBeenCalledTimes(1);
  });

  it('ignores an older error and its settled callback', async () => {
    const coordinator = createLatestConstructionRequestCoordinator();
    const older = deferred<string>();
    const latest = deferred<string>();
    const olderHandlers = latestHandlers<string>();
    const latestRequestHandlers = latestHandlers<string>();
    const error = new Error('stale failure');

    const olderRun = coordinator.run(older.promise, olderHandlers);
    const latestRun = coordinator.run(
      latest.promise,
      latestRequestHandlers,
    );

    older.reject(error);
    await olderRun;
    expect(olderHandlers.onSuccess).not.toHaveBeenCalled();
    expect(olderHandlers.onError).not.toHaveBeenCalled();
    expect(olderHandlers.onSettled).not.toHaveBeenCalled();

    latest.resolve('latest');
    await latestRun;
  });

  it('calls only current error and settled callbacks for a rejection', async () => {
    const coordinator = createLatestConstructionRequestCoordinator();
    const request = deferred<string>();
    const requestHandlers = latestHandlers<string>();
    const error = new Error('current failure');

    const run = coordinator.run(request.promise, requestHandlers);
    request.reject(error);
    await run;

    expect(requestHandlers.onSuccess).not.toHaveBeenCalled();
    expect(requestHandlers.onError).toHaveBeenCalledWith(error);
    expect(requestHandlers.onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not misclassify a success handler error as a request error', async () => {
    const coordinator = createLatestConstructionRequestCoordinator();
    const requestHandlers = latestHandlers<string>();
    const handlerError = new Error('success handler failed');
    requestHandlers.onSuccess.mockImplementation(() => {
      throw handlerError;
    });

    await expect(
      coordinator.run(Promise.resolve('value'), requestHandlers),
    ).rejects.toBe(handlerError);

    expect(requestHandlers.onSuccess).toHaveBeenCalledWith('value');
    expect(requestHandlers.onError).not.toHaveBeenCalled();
    expect(requestHandlers.onSettled).toHaveBeenCalledTimes(1);
  });

  it('invalidates callbacks from in-flight resolved and rejected requests', async () => {
    const coordinator = createLatestConstructionRequestCoordinator();
    const resolving = deferred<string>();
    const resolvingHandlers = latestHandlers<string>();
    const resolvingRun = coordinator.run(
      resolving.promise,
      resolvingHandlers,
    );

    coordinator.invalidate();
    resolving.resolve('ignored');
    await resolvingRun;

    const rejecting = deferred<string>();
    const rejectingHandlers = latestHandlers<string>();
    const rejectingRun = coordinator.run(
      rejecting.promise,
      rejectingHandlers,
    );

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
});
