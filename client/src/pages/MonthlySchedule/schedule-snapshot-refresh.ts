import type { ScheduleSnapshotRevisionResponse } from '@shared/api.interface';

export interface ScheduleSnapshotRevisionTransition {
  token: string | null;
  shouldRevalidate: boolean;
  ignored: boolean;
}

export function resolveScheduleSnapshotRevision({
  currentToken,
  revision,
  requestGeneration,
  currentGeneration,
}: {
  currentToken: string | null;
  revision: ScheduleSnapshotRevisionResponse;
  requestGeneration: number;
  currentGeneration: number;
}): ScheduleSnapshotRevisionTransition {
  if (requestGeneration !== currentGeneration) {
    return { token: currentToken, shouldRevalidate: false, ignored: true };
  }

  const nextToken =
    revision.available && typeof revision.token === 'string'
      ? revision.token.trim()
      : '';
  if (!nextToken) {
    return { token: currentToken, shouldRevalidate: false, ignored: false };
  }

  return {
    token: nextToken,
    shouldRevalidate: currentToken !== null && nextToken !== currentToken,
    ignored: false,
  };
}

export interface ScheduleSnapshotRefreshCoordinator {
  check: () => Promise<boolean>;
  recordApplied: (token: string) => void;
  stop: () => void;
}

export function shouldPreserveLocalSnapshotData(
  localSnapshotRefresh: boolean,
  manualForceRefresh: boolean,
): boolean {
  return localSnapshotRefresh && !manualForceRefresh;
}

export function getScheduleSnapshotRevalidationDateKeys(
  schedules: ReadonlyArray<{ scheduleDate?: string | null }>,
): string[] {
  const dateKeysByMonth = new Set<string>();
  schedules.forEach((schedule) => {
    const dateKey = schedule.scheduleDate?.trim() || '';
    const match = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}$/.exec(dateKey);
    if (match) {
      dateKeysByMonth.add(`${match[1]}-${match[2]}-01`);
    }
  });
  return Array.from(dateKeysByMonth).sort();
}

export function createScheduleSnapshotRefreshCoordinator({
  readRevision,
  revalidate,
  onError,
  initialToken = null,
  onTokenChange,
}: {
  readRevision: (
    signal: AbortSignal,
  ) => Promise<ScheduleSnapshotRevisionResponse>;
  revalidate: (signal: AbortSignal) => Promise<boolean>;
  onError: (error: unknown) => void;
  initialToken?: string | null;
  onTokenChange?: (token: string | null) => void;
}): ScheduleSnapshotRefreshCoordinator {
  let currentToken = initialToken;
  let currentGeneration = 0;
  let currentRequest: Promise<boolean> | null = null;
  let currentRevalidationController: AbortController | null = null;
  let stopped = false;
  let failureReported = false;

  const commit = (token: string | null) => {
    if (token !== currentToken) onTokenChange?.(token);
    currentToken = token;
    failureReported = false;
  };

  const reportFailure = (error: unknown) => {
    if (failureReported) return;
    failureReported = true;
    onError(error);
  };

  const check = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (currentRequest) return currentRequest;

    const requestGeneration = currentGeneration + 1;
    currentGeneration = requestGeneration;
    const revalidationController = new AbortController();
    currentRevalidationController = revalidationController;
    let trackedRequest: Promise<boolean>;
    let revisionRequest: Promise<ScheduleSnapshotRevisionResponse>;
    try {
      revisionRequest = readRevision(revalidationController.signal);
    } catch (error) {
      revisionRequest = Promise.reject(error);
    }
    const request = revisionRequest
      .then(async (revision) => {
        const transition = resolveScheduleSnapshotRevision({
          currentToken,
          revision,
          requestGeneration,
          currentGeneration,
        });
        if (stopped || transition.ignored) return false;

        if (!transition.shouldRevalidate) {
          commit(transition.token);
          return true;
        }

        const refreshed = await revalidate(revalidationController.signal);
        if (
          stopped ||
          revalidationController.signal.aborted ||
          requestGeneration !== currentGeneration
        ) {
          return false;
        }
        if (!refreshed) {
          reportFailure(new Error('本地排班快照刷新失败'));
          return false;
        }

        commit(transition.token);
        return true;
      })
      .catch((error) => {
        if (
          stopped ||
          revalidationController.signal.aborted ||
          requestGeneration !== currentGeneration
        ) {
          return false;
        }
        reportFailure(error);
        return false;
      });
    trackedRequest = request.finally(() => {
      if (currentRequest === trackedRequest) {
        currentRequest = null;
      }
      if (currentRevalidationController === revalidationController) {
        currentRevalidationController = null;
      }
    });
    currentRequest = trackedRequest;
    return trackedRequest;
  };

  return {
    check,
    recordApplied: (token) => {
      if (stopped || !token.trim()) return;
      currentGeneration += 1;
      currentRevalidationController?.abort();
      currentRequest = null;
      commit(token.trim());
    },
    stop: () => {
      stopped = true;
      currentGeneration += 1;
      currentRevalidationController?.abort();
    },
  };
}
