import type {
  PurchaseInboundCategoryAcceptedResponse,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundCategoryPrepareResponse,
  PurchaseInboundCategoryTaskStatusResponse,
} from '@shared/inventory-management.interface';
import { classifyInventoryInboundFailure } from './inventory-inbound-recovery';

const TASK_JOURNAL_VERSION = 1 as const;
const TASK_STORAGE_PREFIX =
  'inventory-management:purchase-inbound-category-task:v1';
const FAST_POLL_ATTEMPTS = 30;
const SLOW_POLL_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

export type PurchaseInboundCategoryTaskCoordinatorPhase =
  | 'idle'
  | 'submitting'
  | 'accepted'
  | 'syncing'
  | 'uncertain'
  | 'completed'
  | 'error';

export interface PurchaseInboundCategoryTaskStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PurchaseInboundCategoryTaskJournal {
  version: typeof TASK_JOURNAL_VERSION;
  taskId: string;
  request: PurchaseInboundCategoryPrepareRequest;
  message: string;
  createdAt: number;
  updatedAt: number;
}

export type PurchaseInboundCategoryTaskCoordinatorEvent =
  | {
      type: 'submitting';
      phase: 'submitting';
      message: string;
      journal: PurchaseInboundCategoryTaskJournal;
    }
  | {
      type: 'accepted' | 'syncing';
      phase: 'accepted' | 'syncing';
      message: string;
      journal: PurchaseInboundCategoryTaskJournal;
    }
  | {
      type: 'completed';
      phase: 'completed';
      message: string;
      journal: PurchaseInboundCategoryTaskJournal;
      result: PurchaseInboundCategoryPrepareResponse;
    }
  | {
      type: 'failed';
      phase: 'error';
      message: string;
      journal: PurchaseInboundCategoryTaskJournal;
      error: unknown;
      definitelyNotPrepared: boolean;
    }
  | {
      type: 'uncertain';
      phase: 'uncertain';
      message: string;
      journal: PurchaseInboundCategoryTaskJournal;
      error: unknown;
    };

export interface PurchaseInboundCategoryTaskCoordinatorDependencies {
  prepareCategory: (
    request: PurchaseInboundCategoryPrepareRequest,
  ) => Promise<PurchaseInboundCategoryAcceptedResponse>;
  getTaskStatus: (
    taskId: string,
  ) => Promise<PurchaseInboundCategoryTaskStatusResponse>;
  storage?: PurchaseInboundCategoryTaskStorage | null;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  isTransientError?: (error: unknown) => boolean;
  onEvent: (event: PurchaseInboundCategoryTaskCoordinatorEvent) => void;
}

export interface PurchaseInboundCategoryTaskCoordinator {
  start(request: PurchaseInboundCategoryPrepareRequest): Promise<boolean>;
  resume(executionRecordId: string): boolean;
  checkNow(): Promise<boolean>;
  stop(): void;
  getPhase(): PurchaseInboundCategoryTaskCoordinatorPhase;
}

export function getPurchaseInboundCategoryPollDelay(attempt: number): number {
  const normalizedAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.floor(attempt))
    : 0;
  if (normalizedAttempt < FAST_POLL_ATTEMPTS) return 1_000;
  return SLOW_POLL_DELAYS_MS[
    Math.min(
      normalizedAttempt - FAST_POLL_ATTEMPTS,
      SLOW_POLL_DELAYS_MS.length - 1,
    )
  ];
}

export function isRetryablePurchaseInboundCategoryTaskQueryError(
  error: unknown,
): boolean {
  const status = Number(
    isRecord(error) && isRecord(error.response)
      ? error.response.status
      : isRecord(error)
        ? error.status
        : Number.NaN,
  );
  if (status === 408 || status === 429 || status >= 500) return true;
  const code = isRecord(error) ? String(error.code || '') : '';
  if (/ECONN|ETIMEDOUT|EAI_AGAIN/i.test(code)) return true;
  return (
    error instanceof Error &&
    /timeout|network|ECONN|temporar|查询暂时失败/i.test(error.message)
  );
}

export function createPurchaseInboundCategoryTaskCoordinator(
  dependencies: PurchaseInboundCategoryTaskCoordinatorDependencies,
): PurchaseInboundCategoryTaskCoordinator {
  const storage =
    dependencies.storage === undefined
      ? readDefaultSessionStorage()
      : dependencies.storage;
  const setTimer =
    dependencies.setTimer ??
    ((callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay));
  const clearTimer =
    dependencies.clearTimer ??
    ((handle: unknown) =>
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      ));
  const now = dependencies.now ?? Date.now;
  const isTransientError =
    dependencies.isTransientError ??
    isRetryablePurchaseInboundCategoryTaskQueryError;

  let active: PurchaseInboundCategoryTaskJournal | null = null;
  let phase: PurchaseInboundCategoryTaskCoordinatorPhase = 'idle';
  let pollAttempt = 0;
  let timerHandle: unknown | null = null;
  let inFlight: Promise<boolean> | null = null;
  let acceptInFlight: Promise<boolean> | null = null;
  let generation = 0;
  let stopped = false;

  function publish(event: PurchaseInboundCategoryTaskCoordinatorEvent): void {
    dependencies.onEvent(event);
  }

  function scheduleNext(): void {
    if (stopped || !active || timerHandle !== null) return;
    timerHandle = setTimer(() => {
      timerHandle = null;
      void checkNow();
    }, getPurchaseInboundCategoryPollDelay(pollAttempt));
  }

  function cancelTimer(): void {
    if (timerHandle === null) return;
    clearTimer(timerHandle);
    timerHandle = null;
  }

  function saveActive(): boolean {
    if (!active || !storage) return false;
    try {
      storage.setItem(
        taskStorageKey(active.request.executionRecordId),
        JSON.stringify(active),
      );
      return true;
    } catch {
      return false;
    }
  }

  function clearActiveStorage(
    journal: PurchaseInboundCategoryTaskJournal,
  ): void {
    if (!storage) return;
    try {
      storage.removeItem(taskStorageKey(journal.request.executionRecordId));
    } catch {
      // A stale journal is harmless: a completed task is idempotent on resume.
    }
  }

  function finishCompleted(
    journal: PurchaseInboundCategoryTaskJournal,
    result: PurchaseInboundCategoryPrepareResponse,
    message: string,
  ): void {
    if (!active || active.taskId !== journal.taskId) return;
    cancelTimer();
    generation += 1;
    active = null;
    phase = 'completed';
    clearActiveStorage(journal);
    publish({
      type: 'completed',
      phase,
      message,
      journal: cloneJournal(journal),
      result: { ...result },
    });
  }

  function finishFailed(
    journal: PurchaseInboundCategoryTaskJournal,
    error: unknown,
    message: string,
    definitelyNotPrepared: boolean,
  ): void {
    if (!active || active.taskId !== journal.taskId) return;
    if (!definitelyNotPrepared) {
      finishUncertain(journal, error, message);
      return;
    }
    cancelTimer();
    generation += 1;
    active = null;
    phase = 'error';
    clearActiveStorage(journal);
    publish({
      type: 'failed',
      phase,
      message,
      journal: cloneJournal(journal),
      error,
      definitelyNotPrepared,
    });
  }

  function finishUncertain(
    journal: PurchaseInboundCategoryTaskJournal,
    error: unknown,
    message: string,
  ): void {
    if (!active || active.taskId !== journal.taskId) return;
    cancelTimer();
    generation += 1;
    active = null;
    phase = 'uncertain';
    publish({
      type: 'uncertain',
      phase,
      message,
      journal: cloneJournal(journal),
      error,
    });
  }

  function acceptJournal(
    journal: PurchaseInboundCategoryTaskJournal,
  ): Promise<boolean> {
    const operation = (async () => {
      try {
        const accepted = await dependencies.prepareCategory(journal.request);
        if (
          stopped ||
          active?.request.clientMutationId !== journal.request.clientMutationId
        ) {
          return false;
        }
        const acceptedJournal = {
          ...journal,
          taskId: accepted.taskId,
          message: accepted.message,
          updatedAt: now(),
        };
        active = acceptedJournal;
        pollAttempt = 0;
        if (accepted.result) {
          finishCompleted(acceptedJournal, accepted.result, accepted.message);
          return true;
        }
        if (accepted.status === 'failed' || accepted.definitelyNotPrepared) {
          const error = Object.assign(new Error(accepted.message), {
            definitelyNotPrepared: true,
          });
          finishFailed(acceptedJournal, error, accepted.message, true);
          return true;
        }
        if (!saveActive()) {
          const message =
            '类别号任务已受理，但浏览器无法保存任务号；请使用原编号安全重试';
          finishUncertain(acceptedJournal, new Error(message), message);
          return false;
        }
        phase = 'accepted';
        publish({
          type: 'accepted',
          phase,
          message: accepted.message,
          journal: cloneJournal(acceptedJournal),
        });
        scheduleNext();
        return true;
      } catch (error) {
        if (
          stopped ||
          active?.request.clientMutationId !== journal.request.clientMutationId
        ) {
          return false;
        }
        const message =
          error instanceof Error ? error.message : '类别号任务受理失败';
        if (classifyInventoryInboundFailure(error) === 'rejected') {
          finishFailed(journal, error, message, true);
        } else {
          finishUncertain(
            journal,
            error,
            '类别号受理结果待核对，请使用原编号安全重试',
          );
        }
        return false;
      }
    })();
    acceptInFlight = operation;
    void operation.finally(() => {
      if (acceptInFlight === operation) acceptInFlight = null;
    });
    return operation;
  }

  async function poll(expectedGeneration: number): Promise<boolean> {
    const journal = active;
    if (!journal || stopped || expectedGeneration !== generation) return false;
    try {
      const response = await dependencies.getTaskStatus(journal.taskId);
      if (
        stopped ||
        expectedGeneration !== generation ||
        active?.taskId !== journal.taskId
      ) {
        return false;
      }
      const task = response.task;
      if (task.status === 'completed') {
        finishCompleted(journal, task.result, task.message);
        return true;
      }
      if (task.status === 'failed') {
        const error = Object.assign(new Error(task.message), {
          definitelyNotPrepared: true,
        });
        finishFailed(journal, error, task.message, true);
        return true;
      }

      pollAttempt += 1;
      const background = pollAttempt >= FAST_POLL_ATTEMPTS;
      phase = background ? 'accepted' : 'syncing';
      active = {
        ...journal,
        message: background
          ? '类别号仍在后台生成，可安全关闭窗口'
          : task.message,
        updatedAt: now(),
      };
      if (!saveActive()) {
        const message =
          '类别号任务已受理，但浏览器无法保存任务状态；请使用原编号安全重试';
        finishUncertain(active, new Error(message), message);
        return false;
      }
      publish({
        type: background ? 'accepted' : 'syncing',
        phase,
        message: active.message,
        journal: cloneJournal(active),
      });
      scheduleNext();
      return true;
    } catch (error) {
      if (
        stopped ||
        expectedGeneration !== generation ||
        active?.taskId !== journal.taskId
      ) {
        return false;
      }
      if (!isTransientError(error)) {
        finishFailed(
          journal,
          error,
          error instanceof Error ? error.message : '后台任务查询失败',
          false,
        );
        return true;
      }
      pollAttempt += 1;
      const background = pollAttempt >= FAST_POLL_ATTEMPTS;
      phase = background ? 'accepted' : 'syncing';
      active = {
        ...journal,
        message: background
          ? '类别号仍在后台生成，可安全关闭窗口'
          : '后台查询暂时中断，将自动继续查询',
        updatedAt: now(),
      };
      if (!saveActive()) {
        const message =
          '类别号任务已受理，但浏览器无法保存任务状态；请使用原编号安全重试';
        finishUncertain(active, new Error(message), message);
        return false;
      }
      publish({
        type: background ? 'accepted' : 'syncing',
        phase,
        message: active.message,
        journal: cloneJournal(active),
      });
      scheduleNext();
      return true;
    }
  }

  function checkNow(): Promise<boolean> {
    if (stopped || !active) return Promise.resolve(false);
    if (!active.taskId) return acceptInFlight ?? Promise.resolve(false);
    cancelTimer();
    if (inFlight) return inFlight;
    const expectedGeneration = generation;
    const operation = poll(expectedGeneration);
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  }

  return {
    start(requestValue) {
      if (stopped || active || phase === 'submitting')
        return Promise.resolve(false);
      const request = cloneRequest(requestValue);
      const saved = readJournal(storage, request.executionRecordId);
      if (
        saved &&
        saved.request.clientMutationId !== request.clientMutationId
      ) {
        phase = 'uncertain';
        publish({
          type: 'uncertain',
          phase,
          message: '原类别号受理结果尚未确认，请使用原编号继续核对',
          journal: cloneJournal(saved),
          error: new Error('原类别号受理结果尚未确认'),
        });
        return Promise.resolve(false);
      }
      if (saved?.taskId) {
        active = saved;
        pollAttempt = FAST_POLL_ATTEMPTS;
        phase = 'accepted';
        publish({
          type: 'accepted',
          phase,
          message: saved.message,
          journal: cloneJournal(saved),
        });
        return checkNow();
      }
      const timestamp = now();
      const journal = saved ?? {
        version: TASK_JOURNAL_VERSION,
        taskId: '',
        request,
        message: '正在受理类别号生成任务…',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      active = journal;
      phase = 'submitting';
      if (!saveActive()) {
        const message =
          '浏览器无法安全保存类别号恢复任务，本次请求未发送；请保留当前内容后重试';
        finishFailed(journal, new Error(message), message, true);
        return Promise.resolve(false);
      }
      publish({
        type: 'submitting',
        phase,
        message: journal.message,
        journal: cloneJournal(journal),
      });
      return acceptJournal(journal);
    },
    resume(executionRecordId) {
      if (stopped || active || phase === 'submitting') return false;
      const journal = readJournal(storage, executionRecordId);
      if (!journal) return false;
      active = journal;
      if (!journal.taskId) {
        phase = 'submitting';
        publish({
          type: 'submitting',
          phase,
          message: '正在使用原编号恢复类别号受理请求…',
          journal: cloneJournal(journal),
        });
        void acceptJournal(journal);
        return true;
      }
      pollAttempt = FAST_POLL_ATTEMPTS;
      phase = 'accepted';
      publish({
        type: 'accepted',
        phase,
        message: journal.message || '类别号仍在后台生成，正在恢复查询',
        journal: cloneJournal(journal),
      });
      scheduleNext();
      return true;
    },
    checkNow,
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      cancelTimer();
      active = null;
      phase = 'idle';
    },
    getPhase() {
      return phase;
    },
  };
}

function taskStorageKey(executionRecordId: string): string {
  return `${TASK_STORAGE_PREFIX}:${encodeURIComponent(executionRecordId)}`;
}

function readDefaultSessionStorage(): PurchaseInboundCategoryTaskStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readJournal(
  storage: PurchaseInboundCategoryTaskStorage | null,
  executionRecordId: string,
): PurchaseInboundCategoryTaskJournal | null {
  if (!storage || !executionRecordId.trim()) return null;
  try {
    const raw = storage.getItem(taskStorageKey(executionRecordId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isTaskJournal(parsed, executionRecordId)
      ? cloneJournal(parsed)
      : null;
  } catch {
    return null;
  }
}

function isTaskJournal(
  value: unknown,
  executionRecordId: string,
): value is PurchaseInboundCategoryTaskJournal {
  if (!isRecord(value) || value.version !== TASK_JOURNAL_VERSION) return false;
  if (
    typeof value.taskId !== 'string' ||
    !isNonEmptyString(value.message) ||
    !isFiniteTimestamp(value.createdAt) ||
    !isFiniteTimestamp(value.updatedAt) ||
    !isRecord(value.request)
  ) {
    return false;
  }
  const request = value.request;
  return (
    request.executionRecordId === executionRecordId &&
    isNonEmptyString(request.clientMutationId) &&
    isNonEmptyString(request.building) &&
    typeof request.quantity === 'number' &&
    Number.isFinite(request.quantity) &&
    request.quantity > 0 &&
    isNonEmptyString(request.occurredAt) &&
    isRecord(request.newItem) &&
    isNonEmptyString(request.newItem.primaryCategory) &&
    isNonEmptyString(request.newItem.secondaryCategory) &&
    isNonEmptyString(request.newItem.name) &&
    isNonEmptyString(request.newItem.specification) &&
    isNonEmptyString(request.newItem.location) &&
    (request.newItem.locationRecordId === undefined ||
      isNonEmptyString(request.newItem.locationRecordId)) &&
    (request.newItem.brand === undefined ||
      typeof request.newItem.brand === 'string') &&
    (request.newItem.unit === undefined ||
      typeof request.newItem.unit === 'string') &&
    (request.newItem.minimumQuantity === undefined ||
      (typeof request.newItem.minimumQuantity === 'number' &&
        Number.isFinite(request.newItem.minimumQuantity) &&
        request.newItem.minimumQuantity >= 0))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function cloneRequest(
  request: PurchaseInboundCategoryPrepareRequest,
): PurchaseInboundCategoryPrepareRequest {
  return {
    ...request,
    newItem: { ...request.newItem },
  };
}

function cloneJournal(
  journal: PurchaseInboundCategoryTaskJournal,
): PurchaseInboundCategoryTaskJournal {
  return {
    ...journal,
    request: cloneRequest(journal.request),
  };
}
