import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScheduleSnapshotRevisionResponse } from '../../shared/api.interface';

jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';

type SnapshotRevisionTransition = {
  token: string | null;
  shouldRevalidate: boolean;
  ignored: boolean;
};

type ResolveSnapshotRevision = (input: {
  currentToken: string | null;
  revision: ScheduleSnapshotRevisionResponse;
  requestGeneration: number;
  currentGeneration: number;
}) => SnapshotRevisionTransition;

type SnapshotRefreshCoordinator = {
  check: () => Promise<boolean>;
  stop: () => void;
};

type CreateSnapshotRefreshCoordinator = (dependencies: {
  readRevision: (
    signal: AbortSignal,
  ) => Promise<ScheduleSnapshotRevisionResponse>;
  revalidate: (signal: AbortSignal) => Promise<boolean>;
  onError: (error: unknown) => void;
}) => SnapshotRefreshCoordinator;

function loadResolveSnapshotRevision(): ResolveSnapshotRevision {
  return (
    require('../../client/src/pages/MonthlySchedule/schedule-snapshot-refresh') as {
      resolveScheduleSnapshotRevision: ResolveSnapshotRevision;
    }
  ).resolveScheduleSnapshotRevision;
}

function createSnapshotRefreshCoordinator(dependencies: {
  readRevision: (
    signal: AbortSignal,
  ) => Promise<ScheduleSnapshotRevisionResponse>;
  revalidate: (signal: AbortSignal) => Promise<boolean>;
  onError: (error: unknown) => void;
}): SnapshotRefreshCoordinator {
  const factory = (
    require('../../client/src/pages/MonthlySchedule/schedule-snapshot-refresh') as {
      createScheduleSnapshotRefreshCoordinator?: CreateSnapshotRefreshCoordinator;
    }
  ).createScheduleSnapshotRefreshCoordinator;
  expect(typeof factory).toBe('function');
  return factory!(dependencies);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadShouldPreserveLocalSnapshotData(): (
  localSnapshotRefresh: boolean,
  manualForceRefresh: boolean,
) => boolean {
  const helper = (
    require('../../client/src/pages/MonthlySchedule/schedule-snapshot-refresh') as {
      shouldPreserveLocalSnapshotData?: (
        localSnapshotRefresh: boolean,
        manualForceRefresh: boolean,
      ) => boolean;
    }
  ).shouldPreserveLocalSnapshotData;
  expect(typeof helper).toBe('function');
  return helper!;
}

function loadScheduleSnapshotRevalidationDateKeys(): (
  schedules: ReadonlyArray<{ scheduleDate?: string | null }>,
) => string[] {
  const helper = (
    require('../../client/src/pages/MonthlySchedule/schedule-snapshot-refresh') as {
      getScheduleSnapshotRevalidationDateKeys?: (
        schedules: ReadonlyArray<{ scheduleDate?: string | null }>,
      ) => string[];
    }
  ).getScheduleSnapshotRevalidationDateKeys;
  expect(typeof helper).toBe('function');
  return helper!;
}

function revision(
  token: string | null,
  available = true,
): ScheduleSnapshotRevisionResponse {
  return {
    available,
    token,
    nonDutyFetchedAt: available ? 1 : null,
    scheduleFetchedAt: available ? 2 : null,
  };
}

describe('monthly schedule snapshot revision transition', () => {
  it('establishes the first available token as a revalidation baseline', () => {
    const resolveScheduleSnapshotRevision = loadResolveSnapshotRevision();

    expect(
      resolveScheduleSnapshotRevision({
        currentToken: null,
        revision: revision('snapshot-a'),
        requestGeneration: 1,
        currentGeneration: 1,
      }),
    ).toEqual({
      token: 'snapshot-a',
      shouldRevalidate: false,
      ignored: false,
    });
  });

  it('does not revalidate an unchanged token', () => {
    const resolveScheduleSnapshotRevision = loadResolveSnapshotRevision();

    expect(
      resolveScheduleSnapshotRevision({
        currentToken: 'snapshot-a',
        revision: revision('snapshot-a'),
        requestGeneration: 2,
        currentGeneration: 2,
      }),
    ).toEqual({
      token: 'snapshot-a',
      shouldRevalidate: false,
      ignored: false,
    });
  });

  it('revalidates when the available token changes', () => {
    const resolveScheduleSnapshotRevision = loadResolveSnapshotRevision();

    expect(
      resolveScheduleSnapshotRevision({
        currentToken: 'snapshot-a',
        revision: revision('snapshot-b'),
        requestGeneration: 3,
        currentGeneration: 3,
      }),
    ).toEqual({
      token: 'snapshot-b',
      shouldRevalidate: true,
      ignored: false,
    });
  });

  it.each([
    ['unavailable response', revision('snapshot-new', false)],
    ['empty token', revision('  ')],
    ['missing token', revision(null)],
  ])('keeps the previous token for an %s', (_label, response) => {
    const resolveScheduleSnapshotRevision = loadResolveSnapshotRevision();

    expect(
      resolveScheduleSnapshotRevision({
        currentToken: 'snapshot-a',
        revision: response,
        requestGeneration: 4,
        currentGeneration: 4,
      }),
    ).toEqual({
      token: 'snapshot-a',
      shouldRevalidate: false,
      ignored: false,
    });
  });

  it('ignores a response from an obsolete request generation', () => {
    const resolveScheduleSnapshotRevision = loadResolveSnapshotRevision();

    expect(
      resolveScheduleSnapshotRevision({
        currentToken: 'snapshot-newer',
        revision: revision('snapshot-old'),
        requestGeneration: 4,
        currentGeneration: 5,
      }),
    ).toEqual({
      token: 'snapshot-newer',
      shouldRevalidate: false,
      ignored: true,
    });
  });
});

describe('monthly schedule snapshot refresh coordinator', () => {
  it('deduplicates concurrent checks with the same promise and commits a baseline without revalidation', async () => {
    const pendingRevision = deferred<ScheduleSnapshotRevisionResponse>();
    const readRevision = jest
      .fn<Promise<ScheduleSnapshotRevisionResponse>, []>()
      .mockReturnValueOnce(pendingRevision.promise)
      .mockResolvedValue(revision('snapshot-a'));
    const revalidate = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
    const coordinator = createSnapshotRefreshCoordinator({
      readRevision,
      revalidate,
      onError: jest.fn(),
    });

    const first = coordinator.check();
    const duplicate = coordinator.check();
    expect(duplicate).toBe(first);
    expect(readRevision).toHaveBeenCalledTimes(1);

    pendingRevision.resolve(revision('snapshot-a'));
    await first;
    await coordinator.check();

    expect(readRevision).toHaveBeenCalledTimes(2);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('revalidates a changed token after the previous token was committed', async () => {
    const readRevision = jest
      .fn<Promise<ScheduleSnapshotRevisionResponse>, []>()
      .mockResolvedValueOnce(revision('snapshot-a'))
      .mockResolvedValueOnce(revision('snapshot-b'));
    const revalidate = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
    const coordinator = createSnapshotRefreshCoordinator({
      readRevision,
      revalidate,
      onError: jest.fn(),
    });

    await coordinator.check();
    await coordinator.check();

    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('does not commit a token when revalidation fails and retries the same token later', async () => {
    const readRevision = jest
      .fn<Promise<ScheduleSnapshotRevisionResponse>, []>()
      .mockResolvedValueOnce(revision('snapshot-a'))
      .mockResolvedValue(revision('snapshot-b'));
    const revalidate = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onError = jest.fn();
    const coordinator = createSnapshotRefreshCoordinator({
      readRevision,
      revalidate,
      onError,
    });

    await coordinator.check();
    await coordinator.check();
    await coordinator.check();
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);

    await coordinator.check();
    await coordinator.check();
    expect(revalidate).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports only the first consecutive read failure and resets after success', async () => {
    const firstFailure = new Error('offline-1');
    const secondFailure = new Error('offline-2');
    const thirdFailure = new Error('offline-3');
    const readRevision = jest
      .fn<Promise<ScheduleSnapshotRevisionResponse>, []>()
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(secondFailure)
      .mockResolvedValueOnce(revision('snapshot-a'))
      .mockRejectedValueOnce(thirdFailure);
    const onError = jest.fn();
    const coordinator = createSnapshotRefreshCoordinator({
      readRevision,
      revalidate: jest.fn().mockResolvedValue(true),
      onError,
    });

    await coordinator.check();
    await coordinator.check();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(firstFailure);

    await coordinator.check();
    await coordinator.check();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(thirdFailure);
  });

  it('aborts a hanging revision read and ignores its obsolete response after stop', async () => {
    const pendingRevision = deferred<ScheduleSnapshotRevisionResponse>();
    const revalidate = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
    const onError = jest.fn();
    let receivedSignal: AbortSignal | null = null;
    const coordinator = createSnapshotRefreshCoordinator({
      readRevision: (signal) => {
        receivedSignal = signal;
        return pendingRevision.promise;
      },
      revalidate,
      onError,
    });

    const request = coordinator.check();
    coordinator.stop();
    expect(receivedSignal?.aborted).toBe(true);
    pendingRevision.resolve(revision('snapshot-a'));
    await expect(request).resolves.toBe(false);

    expect(revalidate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('aborts an already-started revalidation and skips its application step after stop', async () => {
    const revalidationStarted = deferred<void>();
    const releaseRevalidation = deferred<void>();
    let receivedSignal: AbortSignal | null = null;
    let applied = 0;
    let baselineEstablished = false;
    const readRevision = jest
      .fn<Promise<ScheduleSnapshotRevisionResponse>, []>()
      .mockResolvedValueOnce(revision('snapshot-a'))
      .mockResolvedValueOnce(revision('snapshot-b'));
    const coordinator = createSnapshotRefreshCoordinator({
      readRevision,
      revalidate: async (signal) => {
        if (!baselineEstablished) return true;
        receivedSignal = signal;
        revalidationStarted.resolve();
        await releaseRevalidation.promise;
        if (signal.aborted) return false;
        applied += 1;
        return true;
      },
      onError: jest.fn(),
    });

    await coordinator.check();
    baselineEstablished = true;
    const request = coordinator.check();
    await revalidationStarted.promise;
    coordinator.stop();

    expect(receivedSignal?.aborted).toBe(true);
    releaseRevalidation.resolve();
    await expect(request).resolves.toBe(false);
    expect(applied).toBe(0);
  });
});

describe('local snapshot failure preservation decision', () => {
  it.each([
    ['local-only refresh', true, false, true],
    ['manual force refresh', true, true, false],
    ['ordinary initial load', false, false, false],
  ])('handles %s', (_label, localRefresh, manualForce, expected) => {
    expect(
      loadShouldPreserveLocalSnapshotData()(localRefresh, manualForce),
    ).toBe(expected);
  });
});

describe('local snapshot schedule-month preservation', () => {
  it('keeps one reload date for every valid month represented in current schedules', () => {
    expect(
      loadScheduleSnapshotRevalidationDateKeys()([
        { scheduleDate: '2026-10-31' },
        { scheduleDate: '2026-08-02' },
        { scheduleDate: '2026-08-19' },
        { scheduleDate: '2026-09-01' },
        { scheduleDate: 'invalid' },
        { scheduleDate: null },
      ]),
    ).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
  });
});

describe('monthly schedule snapshot revision client API', () => {
  beforeEach(() => {
    (axiosForBackend as jest.Mock).mockReset();
  });

  it('uses the local revision endpoint without a force-refresh query', async () => {
    const response = revision('snapshot-a');
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: response });
    const api = require('../../client/src/api') as {
      getScheduleSnapshotRevision?: (
        signal?: AbortSignal,
      ) => Promise<ScheduleSnapshotRevisionResponse>;
    };
    const controller = new AbortController();

    expect(typeof api.getScheduleSnapshotRevision).toBe('function');
    await expect(
      api.getScheduleSnapshotRevision?.(controller.signal),
    ).resolves.toEqual(response);
    expect(axiosForBackend).toHaveBeenCalledTimes(1);
    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/bitable/schedule-snapshot-revision',
      method: 'GET',
      signal: controller.signal,
      timeout: 10_000,
    });
  });
});

describe('MonthlySchedule local snapshot auto-refresh integration', () => {
  const pageSource = readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );

  it('checks immediately and while visible every 15 seconds, on focus, and on visibility restore', () => {
    expect(pageSource).toContain(
      'const SCHEDULE_SNAPSHOT_REVALIDATE_INTERVAL_MS = 15 * 1000;',
    );
    expect(pageSource).toContain('void checkScheduleSnapshotRevision();');
    expect(pageSource).toContain(
      "window.addEventListener('focus', checkScheduleSnapshotRevision)",
    );
    expect(pageSource).toMatch(
      /document\.addEventListener\(\s*'visibilitychange',\s*handleSnapshotVisibilityChange,?\s*\)/,
    );
    expect(pageSource).toContain("document.visibilityState !== 'visible'");
  });

  it('does not poll while hidden or in screenshot mode', () => {
    expect(pageSource).toContain('if (isScreenshotMode || access.isLoading) return undefined;');
    expect(pageSource).toContain(
      "if (document.visibilityState === 'hidden') return Promise.resolve();",
    );
  });

  it('invalidates all local schedule caches and starts a newer ordinary schedule load', () => {
    const start = pageSource.indexOf('const invalidateScheduleLoads');
    const end = pageSource.indexOf(
      'const checkScheduleSnapshotRevision',
      start,
    );
    const refreshSource = pageSource.slice(start, end);

    expect(refreshSource).toContain('monthlyScheduleCache.clear();');
    expect(refreshSource).toContain('longWhiteScheduleCache.clear();');
    expect(refreshSource).toContain('monthlyScheduleReadInFlight.clear();');
    expect(refreshSource).toContain('scheduleLoadSeqRef.current += 1;');
    expect(refreshSource).toContain(
      'scheduleMonthRequestGenerationRef.current.set(',
    );
    expect(refreshSource).toContain(
      'const loaded = await loadSchedulesRef.current({',
    );
    expect(refreshSource).toMatch(
      /getScheduleSnapshotRevalidationDateKeys\(\s*schedulesRef\.current,?\s*\)/,
    );
    expect(refreshSource).toContain(
      'additionalDateKeys: scheduleSnapshotDateKeys',
    );
    expect(refreshSource).toContain('signal,');
    expect(refreshSource).toContain(
      'if (signal.aborted || !loaded) return false;',
    );
    expect(refreshSource).toContain(
      'setLocalSnapshotRefreshToken((token) => token + 1);',
    );
    expect(refreshSource).toContain('return true;');
    expect(refreshSource).not.toContain('setDataRefreshToken');
    expect(refreshSource).not.toContain('syncDutyScheduleToLocalFast');
    expect(refreshSource).not.toContain('window.location.reload');
    expect(refreshSource).not.toContain('refresh: true');
  });

  it('adds retained schedule months to the same atomic page reload', () => {
    const loaderStart = pageSource.indexOf('const loadSchedules = useCallback');
    const loaderEnd = pageSource.indexOf(
      'const loadSchedulesForDate = useCallback',
      loaderStart,
    );
    const loaderSource = pageSource.slice(loaderStart, loaderEnd);

    expect(pageSource).toContain('additionalDateKeys?: readonly string[];');
    expect(loaderSource).toContain('options.additionalDateKeys');
    expect(loaderSource).toContain('monthMap.set(additionalMonthKey');
    expect(loaderSource).toContain(
      'if (!options.preserveExistingOnError || hasCompleteScheduleWindow)',
    );
    expect(loaderSource).not.toMatch(
      /additionalDateKeys[\s\S]{0,800}getMonthlySchedulesWithInFlightDeduplication\([^)]*true/,
    );
  });

  it('preserves existing page and today-card data when a local-only reload fails', () => {
    expect(pageSource).toContain('signal?: AbortSignal;');
    expect(pageSource).toContain('if (access.isLoading || options.signal?.aborted) return false;');
    expect(pageSource).toContain('preserveExistingOnError?: boolean;');
    expect(pageSource).toContain(
      'if (!options.preserveExistingOnError || hasCompleteScheduleWindow)',
    );
    expect(pageSource).toContain(
      "if (!options.silent) toast.error('加载排班数据失败，请稍后重试');",
    );
    expect(pageSource.match(/shouldPreserveLocalSnapshotData\(/g)).toHaveLength(
      2,
    );
    expect(pageSource).toContain('if (!preserveExistingOnError) {');
    expect(
      pageSource.match(
        /festivalScheduleLoadFailed && preserveExistingOnError/g,
      ),
    ).toHaveLength(2);
  });

  it('propagates a local-only token without turning local reloads into Feishu force refreshes', () => {
    const movementStart = pageSource.indexOf(
      'function TodayPersonnelMovementCard',
    );
    const engineersStart = pageSource.indexOf(
      'function TodayEngineersOnDuty',
      movementStart,
    );
    const mainStart = pageSource.indexOf(
      'const MonthlySchedulePage',
      engineersStart,
    );
    const movementSource = pageSource.slice(movementStart, engineersStart);
    const engineersSource = pageSource.slice(engineersStart, mainStart);

    expect(pageSource).toContain(
      'const [localSnapshotRefreshToken, setLocalSnapshotRefreshToken] = useState(0);',
    );
    expect(
      pageSource.match(
        /localSnapshotRefreshToken=\{localSnapshotRefreshToken\}/g,
      ),
    ).toHaveLength(3);
    expect(movementSource).toContain('localSnapshotRefreshToken: number;');
    expect(movementSource).toContain(
      '[localSnapshotRefreshToken, onLoadStateChange, refreshToken, todayStr]',
    );
    expect(engineersSource).toContain('localSnapshotRefreshToken,');
    expect(movementSource).toContain(
      'const forceRefresh = refreshToken > lastSuccessfulRefreshTokenRef.current;',
    );
    expect(engineersSource).toContain(
      'const forceRefresh = refreshToken > lastSuccessfulRefreshTokenRef.current;',
    );
    expect(movementSource).not.toContain(
      'const forceRefresh = localSnapshotRefreshToken',
    );
    expect(engineersSource).not.toContain(
      'const forceRefresh = localSnapshotRefreshToken',
    );
  });

  it('stops the coordinator so unmounted requests cannot refresh the page', () => {
    expect(pageSource).toContain(
      'readRevision: (signal) => getScheduleSnapshotRevision(signal)',
    );
    expect(pageSource).toContain('snapshotRefreshCoordinator.stop();');
    expect(pageSource).toContain('invalidateScheduleLoads();');
  });
});
