import type {
  CreateInventoryMovementDeletionRequest,
  InventoryMovementDeletionAcceptedResponse,
  InventoryMovementDeletionTask,
  InventoryMovementDeletionTaskStatusResponse,
  InventoryMovementItem,
} from '@shared/inventory-management.interface';

export const INVENTORY_MOVEMENT_DELETION_STORAGE_PREFIX =
  'inventory-management:movement-deletions:v1';
const STORAGE_VERSION = 1 as const;
const MAX_AUTOMATIC_POLLS = 8;
const POLL_DELAYS_MS = [
  500, 1_000, 2_000, 3_000, 5_000, 10_000, 20_000, 30_000,
] as const;

export type InventoryMovementDeletionJournalStatus =
  | 'submitting'
  | 'accepted'
  | 'uncertain'
  | 'completed';

export interface InventoryMovementDeletionJournal {
  version: typeof STORAGE_VERSION;
  clientMutationId: string;
  movement: InventoryMovementItem;
  originalIndex: number;
  requestWatermark: number;
  status: InventoryMovementDeletionJournalStatus;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
  pollAttempts: number;
  message?: string;
  purchaseRolledBack?: boolean;
}

interface InventoryMovementDeletionJournalStore {
  version: typeof STORAGE_VERSION;
  entries: InventoryMovementDeletionJournal[];
}

export interface StartInventoryMovementDeletionInput {
  clientMutationId: string;
  movement: InventoryMovementItem;
  originalIndex: number;
  requestWatermark: number;
}

export type InventoryMovementDeletionCoordinatorEvent =
  | {
      type: 'optimistic';
      journal: InventoryMovementDeletionJournal;
      restored: boolean;
    }
  | {
      type: 'accepted';
      journal: InventoryMovementDeletionJournal;
      message: string;
    }
  | {
      type: 'status';
      journal: InventoryMovementDeletionJournal;
      message: string;
    }
  | {
      type: 'completed';
      journal: InventoryMovementDeletionJournal;
      message: string;
      purchaseRolledBack: boolean;
    }
  | {
      type: 'failed';
      clientMutationId: string;
      movement: InventoryMovementItem;
      definitelyNotDeleted: true;
      message: string;
    }
  | {
      type: 'uncertain';
      journal: InventoryMovementDeletionJournal;
      clientMutationId: string;
      message: string;
    };

export interface InventoryMovementDeletionCoordinator {
  start(input: StartInventoryMovementDeletionInput): boolean;
  resume(): boolean;
  checkNow(clientMutationId?: string): Promise<void>;
  removeCompleted(clientMutationId: string): boolean;
  getJournals(): InventoryMovementDeletionJournal[];
  stop(): void;
}

interface InventoryMovementDeletionCoordinatorDependencies {
  principalFingerprint: string;
  storage: Storage;
  submitDeletion: (
    request: CreateInventoryMovementDeletionRequest,
  ) => Promise<InventoryMovementDeletionAcceptedResponse>;
  getTaskStatus: (
    taskId: string,
  ) => Promise<InventoryMovementDeletionTaskStatusResponse>;
  onEvent: (event: InventoryMovementDeletionCoordinatorEvent) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMovement(value: unknown): value is InventoryMovementItem {
  return (
    isRecord(value) &&
    typeof value.recordId === 'string' &&
    value.recordId.length > 0 &&
    (value.type === 'inbound' || value.type === 'outbound') &&
    typeof value.name === 'string' &&
    typeof value.quantity === 'number' &&
    Number.isFinite(value.quantity) &&
    typeof value.status === 'string'
  );
}

function parseStore(raw: string | null): InventoryMovementDeletionJournalStore {
  if (!raw) return { version: STORAGE_VERSION, entries: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== STORAGE_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      throw new Error('invalid movement deletion journal');
    }
    const entries: InventoryMovementDeletionJournal[] = [];
    const mutationIds = new Set<string>();
    const recordIds = new Set<string>();
    for (const candidate of parsed.entries) {
      if (
        !isRecord(candidate) ||
        candidate.version !== STORAGE_VERSION ||
        typeof candidate.clientMutationId !== 'string' ||
        !candidate.clientMutationId ||
        !isMovement(candidate.movement) ||
        !Number.isSafeInteger(candidate.originalIndex) ||
        !Number.isSafeInteger(candidate.requestWatermark) ||
        !['submitting', 'accepted', 'uncertain', 'completed'].includes(
          String(candidate.status),
        ) ||
        (candidate.taskId !== null && typeof candidate.taskId !== 'string') ||
        typeof candidate.createdAt !== 'number' ||
        !Number.isFinite(candidate.createdAt) ||
        typeof candidate.updatedAt !== 'number' ||
        !Number.isFinite(candidate.updatedAt) ||
        !Number.isSafeInteger(candidate.pollAttempts) ||
        Number(candidate.pollAttempts) < 0 ||
        (candidate.message !== undefined &&
          typeof candidate.message !== 'string') ||
        (candidate.purchaseRolledBack !== undefined &&
          typeof candidate.purchaseRolledBack !== 'boolean') ||
        mutationIds.has(candidate.clientMutationId) ||
        recordIds.has(candidate.movement.recordId)
      ) {
        throw new Error('invalid movement deletion journal entry');
      }
      mutationIds.add(candidate.clientMutationId);
      recordIds.add(candidate.movement.recordId);
      entries.push(candidate as unknown as InventoryMovementDeletionJournal);
    }
    return { version: STORAGE_VERSION, entries };
  } catch {
    throw new Error('本地删除任务日志无法安全读取');
  }
}

function cloneJournal(
  journal: InventoryMovementDeletionJournal,
): InventoryMovementDeletionJournal {
  return { ...journal, movement: { ...journal.movement } };
}

function errorMessage(error: unknown, fallback: string): string {
  const data = responseData(error);
  if (isRecord(data)) {
    const message = data.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
    if (Array.isArray(message)) {
      const joined = message
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .join('；');
      if (joined) return joined;
    }
  }
  if (error instanceof Error && error.message.trim())
    return error.message.trim();
  return fallback;
}

function responseData(error: unknown): unknown {
  if (!isRecord(error) || !isRecord(error.response)) return null;
  return error.response.data;
}

function isDefinitelyNotWrittenError(error: unknown): boolean {
  const data = responseData(error);
  return (
    isRecord(data) &&
    (data.definitelyNotWritten === true ||
      data.writeDisposition === 'definitely-not-written')
  );
}

export function getInventoryMovementDeletionStorageKey(
  principalFingerprint: string,
): string {
  return `${INVENTORY_MOVEMENT_DELETION_STORAGE_PREFIX}:${principalFingerprint}`;
}

export function createInventoryMovementDeletionCoordinator(
  dependencies: InventoryMovementDeletionCoordinatorDependencies,
): InventoryMovementDeletionCoordinator {
  const now = dependencies.now ?? Date.now;
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
  const storageKey = getInventoryMovementDeletionStorageKey(
    dependencies.principalFingerprint,
  );
  const journals = new Map<string, InventoryMovementDeletionJournal>();
  const timers = new Map<string, unknown>();
  const inFlight = new Set<string>();
  const emittedCompleted = new Set<string>();
  let stopped = false;

  function writeAll(): boolean {
    try {
      const store: InventoryMovementDeletionJournalStore = {
        version: STORAGE_VERSION,
        entries: [...journals.values()].map(cloneJournal),
      };
      dependencies.storage.setItem(storageKey, JSON.stringify(store));
      return true;
    } catch {
      return false;
    }
  }

  function replaceJournal(journal: InventoryMovementDeletionJournal): boolean {
    const previous = journals.get(journal.clientMutationId);
    journals.set(journal.clientMutationId, cloneJournal(journal));
    if (writeAll()) return true;
    if (previous) journals.set(previous.clientMutationId, previous);
    else journals.delete(journal.clientMutationId);
    return false;
  }

  function deleteJournal(clientMutationId: string): boolean {
    const previous = journals.get(clientMutationId);
    if (!previous) return true;
    journals.delete(clientMutationId);
    if (writeAll()) return true;
    journals.set(clientMutationId, previous);
    return false;
  }

  function clearScheduled(clientMutationId: string): void {
    const timer = timers.get(clientMutationId);
    if (timer !== undefined) clearTimer(timer);
    timers.delete(clientMutationId);
  }

  function schedule(journal: InventoryMovementDeletionJournal): void {
    clearScheduled(journal.clientMutationId);
    if (
      stopped ||
      journal.status === 'completed' ||
      journal.pollAttempts >= MAX_AUTOMATIC_POLLS
    ) {
      return;
    }
    const delay =
      POLL_DELAYS_MS[Math.min(journal.pollAttempts, POLL_DELAYS_MS.length - 1)];
    const handle = setTimer(() => {
      timers.delete(journal.clientMutationId);
      void checkOne(journal.clientMutationId);
    }, delay);
    timers.set(journal.clientMutationId, handle);
  }

  function emitUncertain(
    journal: InventoryMovementDeletionJournal,
    message: string,
  ): void {
    dependencies.onEvent({
      type: 'uncertain',
      journal: cloneJournal(journal),
      clientMutationId: journal.clientMutationId,
      message,
    });
  }

  function handleCompleted(
    journal: InventoryMovementDeletionJournal,
    task: Extract<InventoryMovementDeletionTask, { status: 'completed' }>,
  ): void {
    clearScheduled(journal.clientMutationId);
    const completed: InventoryMovementDeletionJournal = {
      ...journal,
      status: 'completed',
      taskId: task.id,
      message: task.result.message || task.message,
      purchaseRolledBack: task.result.purchaseRolledBack,
      updatedAt: now(),
    };
    if (!replaceJournal(completed)) {
      const uncertain = {
        ...journal,
        status: 'uncertain' as const,
        message: '删除已完成，但本地日志暂时无法更新。',
        updatedAt: now(),
      };
      emitUncertain(uncertain, uncertain.message);
      return;
    }
    if (emittedCompleted.has(journal.clientMutationId)) return;
    emittedCompleted.add(journal.clientMutationId);
    dependencies.onEvent({
      type: 'completed',
      journal: cloneJournal(completed),
      message: task.result.message || task.message,
      purchaseRolledBack: task.result.purchaseRolledBack,
    });
  }

  function handleFailed(
    journal: InventoryMovementDeletionJournal,
    task: Extract<InventoryMovementDeletionTask, { status: 'failed' }>,
  ): void {
    handleDefinitelyNotWritten(journal, task.message);
  }

  function handleDefinitelyNotWritten(
    journal: InventoryMovementDeletionJournal,
    message: string,
  ): void {
    clearScheduled(journal.clientMutationId);
    if (!deleteJournal(journal.clientMutationId)) {
      const uncertain = {
        ...journal,
        status: 'uncertain' as const,
        message: '删除确定失败，但本地回滚日志暂时无法更新。',
        updatedAt: now(),
      };
      replaceJournal(uncertain);
      emitUncertain(uncertain, uncertain.message);
      return;
    }
    dependencies.onEvent({
      type: 'failed',
      clientMutationId: journal.clientMutationId,
      movement: { ...journal.movement },
      definitelyNotDeleted: true,
      message,
    });
  }

  function handleUncertain(
    journal: InventoryMovementDeletionJournal,
    message: string,
    taskId = journal.taskId,
  ): void {
    const uncertain: InventoryMovementDeletionJournal = {
      ...journal,
      status: 'uncertain',
      taskId,
      message,
      updatedAt: now(),
      pollAttempts: journal.pollAttempts + 1,
    };
    if (replaceJournal(uncertain)) {
      emitUncertain(uncertain, message);
      schedule(uncertain);
    }
  }

  function handleTask(
    journal: InventoryMovementDeletionJournal,
    task: InventoryMovementDeletionTask,
  ): void {
    if (task.id !== journal.taskId) {
      handleUncertain(journal, '删除任务编号不一致，已停止使用该响应。');
      return;
    }
    if (task.status === 'completed') {
      handleCompleted(journal, task);
      return;
    }
    if (task.status === 'failed') {
      handleFailed(journal, task);
      return;
    }
    if (task.status === 'uncertain') {
      handleUncertain(journal, task.message, task.id);
      return;
    }
    const acceptedJournal: InventoryMovementDeletionJournal = {
      ...journal,
      status: 'accepted',
      message: task.message,
      updatedAt: now(),
      pollAttempts: journal.pollAttempts + 1,
    };
    if (replaceJournal(acceptedJournal)) {
      dependencies.onEvent({
        type: 'status',
        journal: cloneJournal(acceptedJournal),
        message: task.message,
      });
      schedule(acceptedJournal);
    }
  }

  async function submitOne(clientMutationId: string): Promise<void> {
    const journal = journals.get(clientMutationId);
    if (
      !journal ||
      stopped ||
      inFlight.has(clientMutationId) ||
      journal.status === 'completed'
    )
      return;
    inFlight.add(clientMutationId);
    try {
      const response = await dependencies.submitDeletion({
        clientMutationId: journal.clientMutationId,
        movementType: journal.movement.type as 'inbound' | 'outbound',
        recordId: journal.movement.recordId,
      });
      const current = journals.get(clientMutationId);
      if (!current || stopped || current.status === 'completed') return;
      if (response.status === 'completed' && response.result) {
        handleCompleted(current, {
          id: response.taskId,
          status: 'completed',
          message: response.message,
          createdAt: new Date(current.createdAt).toISOString(),
          updatedAt: new Date(now()).toISOString(),
          completedAt: new Date(now()).toISOString(),
          result: response.result,
        });
        return;
      }
      if (
        response.status === 'failed' &&
        response.definitelyNotDeleted === true
      ) {
        handleFailed(current, {
          id: response.taskId,
          status: 'failed',
          message: response.message,
          createdAt: new Date(current.createdAt).toISOString(),
          updatedAt: new Date(now()).toISOString(),
          completedAt: new Date(now()).toISOString(),
          definitelyNotDeleted: true,
        });
        return;
      }
      if (response.status === 'uncertain') {
        handleUncertain(current, response.message, response.taskId);
        return;
      }
      const acceptedJournal: InventoryMovementDeletionJournal = {
        ...current,
        status: 'accepted',
        taskId: response.taskId,
        message: response.message,
        updatedAt: now(),
        pollAttempts: 0,
      };
      if (replaceJournal(acceptedJournal)) {
        dependencies.onEvent({
          type: 'accepted',
          journal: cloneJournal(acceptedJournal),
          message: response.message,
        });
        schedule(acceptedJournal);
      }
    } catch (error) {
      const current = journals.get(clientMutationId);
      if (current && !stopped && current.status !== 'completed') {
        if (isDefinitelyNotWrittenError(error)) {
          handleDefinitelyNotWritten(
            current,
            errorMessage(error, '删除申请未受理。'),
          );
          return;
        }
        handleUncertain(
          current,
          errorMessage(error, '网络中断，删除结果待核对。'),
        );
      }
    } finally {
      inFlight.delete(clientMutationId);
    }
  }

  async function queryOne(clientMutationId: string): Promise<void> {
    const journal = journals.get(clientMutationId);
    if (
      !journal?.taskId ||
      stopped ||
      inFlight.has(clientMutationId) ||
      journal.status === 'completed'
    )
      return;
    inFlight.add(clientMutationId);
    try {
      const response = await dependencies.getTaskStatus(journal.taskId);
      const current = journals.get(clientMutationId);
      if (!current || stopped || current.status === 'completed') return;
      handleTask(current, response.task);
    } catch (error) {
      const current = journals.get(clientMutationId);
      if (current && !stopped && current.status !== 'completed') {
        handleUncertain(
          current,
          errorMessage(error, '任务查询中断，删除结果待核对。'),
          current.taskId,
        );
      }
    } finally {
      inFlight.delete(clientMutationId);
    }
  }

  async function checkOne(clientMutationId: string): Promise<void> {
    const journal = journals.get(clientMutationId);
    if (!journal || journal.status === 'completed') return;
    clearScheduled(clientMutationId);
    if (journal.taskId) await queryOne(clientMutationId);
    else await submitOne(clientMutationId);
  }

  return {
    start(input) {
      if (stopped || !input.clientMutationId.trim()) return false;
      const duplicate = journals.get(input.clientMutationId);
      if (duplicate)
        return duplicate.movement.recordId === input.movement.recordId;
      if (
        [...journals.values()].some(
          (journal) => journal.movement.recordId === input.movement.recordId,
        ) ||
        input.movement.pendingSync ||
        input.movement.recordId.startsWith('pending:') ||
        (input.movement.type !== 'inbound' &&
          input.movement.type !== 'outbound')
      ) {
        return false;
      }
      const timestamp = now();
      const journal: InventoryMovementDeletionJournal = {
        version: STORAGE_VERSION,
        clientMutationId: input.clientMutationId,
        movement: { ...input.movement },
        originalIndex: Math.max(0, input.originalIndex),
        requestWatermark: input.requestWatermark,
        status: 'submitting',
        taskId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        pollAttempts: 0,
      };
      if (!replaceJournal(journal)) return false;
      dependencies.onEvent({
        type: 'optimistic',
        journal: cloneJournal(journal),
        restored: false,
      });
      void submitOne(journal.clientMutationId);
      return true;
    },
    resume() {
      if (stopped) return false;
      let stored: InventoryMovementDeletionJournalStore;
      try {
        stored = parseStore(dependencies.storage.getItem(storageKey));
      } catch {
        return false;
      }
      for (const journal of stored.entries) {
        journals.set(journal.clientMutationId, cloneJournal(journal));
        dependencies.onEvent({
          type: 'optimistic',
          journal: cloneJournal(journal),
          restored: true,
        });
        if (journal.status === 'completed') {
          if (!emittedCompleted.has(journal.clientMutationId)) {
            emittedCompleted.add(journal.clientMutationId);
            dependencies.onEvent({
              type: 'completed',
              journal: cloneJournal(journal),
              message: journal.message || '出入库记录已删除',
              purchaseRolledBack: journal.purchaseRolledBack === true,
            });
          }
        } else {
          void checkOne(journal.clientMutationId);
        }
      }
      return stored.entries.length > 0;
    },
    async checkNow(clientMutationId) {
      if (clientMutationId) {
        await checkOne(clientMutationId);
        return;
      }
      await Promise.all([...journals.keys()].map(checkOne));
    },
    removeCompleted(clientMutationId) {
      const journal = journals.get(clientMutationId);
      if (!journal || journal.status !== 'completed') return false;
      clearScheduled(clientMutationId);
      emittedCompleted.delete(clientMutationId);
      return deleteJournal(clientMutationId);
    },
    getJournals() {
      return [...journals.values()].map(cloneJournal);
    },
    stop() {
      stopped = true;
      for (const clientMutationId of timers.keys())
        clearScheduled(clientMutationId);
    },
  };
}
