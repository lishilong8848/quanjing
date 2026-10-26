import type {
  InventoryMovementItem,
  InventoryOutboundAcceptedResponse,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundMovementCreateResponse,
  InventoryOutboundMovementItem,
  InventoryOutboundTaskStatusResponse,
  WarehouseBuilding,
} from '@shared/inventory-management.interface';
import type {
  InventoryOutboundCreationTaskInput,
  InventoryOutboundCreationTaskExpectedVersion,
  InventoryOutboundCreationTaskJournal,
  InventoryOutboundCreationTaskResolution,
  InventoryOutboundCreationFailedTerminalReceipt,
  InventoryOutboundCreationTerminalExpectation,
  InventoryOutboundCreationTerminalOutcome,
  InventoryOutboundCreationTerminalReceipt,
} from './inventory-outbound-creation-task';
import { runWithInventoryOutboundBrowserLock } from './inventory-outbound-browser-lock';

const MAX_ACCEPT_RECONNECT_ATTEMPTS = 6;
const ACCEPT_RECONNECT_DELAYS_MS = [
  1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
] as const;
const POLL_DELAYS_MS = [
  500, 750, 1_000, 2_000, 3_000, 5_000, 7_500, 10_000,
] as const;
const NETWORK_LOCK_RETRY_DELAY_MS = 500;
const TERMINAL_HOUSEKEEPING_RETRY_DELAY_MS = 10_000;
const MAX_TERMINAL_HOUSEKEEPING_ATTEMPTS = 6;
export const INVENTORY_OUTBOUND_CREATION_NETWORK_STEP_LOCK_PREFIX =
  'inventory-management:outbound-creation-network-step:v1';

type PendingTerminal =
  | {
      kind: 'completed';
      result: InventoryOutboundMovementCreateResponse;
    }
  | {
      kind: 'failed';
      message: string;
    };

interface CompletedTerminalHousekeeping {
  journal: InventoryOutboundCreationTaskJournal;
  result: InventoryOutboundMovementCreateResponse;
  attempts: number;
  inFlight: boolean;
  timerHandle: unknown | null;
}

export type InventoryOutboundCreationCoordinatorEvent =
  | {
      type: 'optimistic';
      journal: InventoryOutboundCreationTaskJournal;
    }
  | {
      type: 'status';
      journal: InventoryOutboundCreationTaskJournal;
      message: string;
    }
  | {
      type: 'authoritative-refresh-required';
      journal: InventoryOutboundCreationTaskJournal;
      message: string;
    }
  | {
      type: 'completed';
      journal: InventoryOutboundCreationTaskJournal;
      result: InventoryOutboundMovementCreateResponse;
    }
  | {
      type: 'failed';
      journal: InventoryOutboundCreationTaskJournal;
      receipt: InventoryOutboundCreationFailedTerminalReceipt;
      definitelyNotWritten: true;
      message: string;
    };

export interface InventoryOutboundCreationCoordinator {
  start(input: InventoryOutboundCreationTaskInput): Promise<boolean>;
  resume(journal: InventoryOutboundCreationTaskJournal): Promise<boolean>;
  checkNow(): Promise<boolean>;
  reconcileAuthoritativeMovement(
    movement: InventoryMovementItem,
  ): Promise<boolean>;
  stop(): void;
  getCurrentJournal(): InventoryOutboundCreationTaskJournal | null;
}

export interface InventoryOutboundCreationCoordinatorDependencies {
  principalFingerprint: string;
  submitOutbound: (
    request: InventoryOutboundMovementCreateRequest,
  ) => Promise<InventoryOutboundAcceptedResponse>;
  getTaskStatus: (
    taskId: string,
    building: WarehouseBuilding,
  ) => Promise<InventoryOutboundTaskStatusResponse>;
  saveJournal: (
    principalFingerprint: string,
    input: InventoryOutboundCreationTaskInput,
    expectedVersion?: InventoryOutboundCreationTaskExpectedVersion,
  ) => Promise<boolean>;
  finalizeJournal: (
    principalFingerprint: string,
    journal: InventoryOutboundCreationTaskJournal,
    outcome: InventoryOutboundCreationTerminalOutcome,
    now?: number,
  ) => Promise<InventoryOutboundCreationTaskResolution>;
  resolveJournal: (
    principalFingerprint: string,
    expectation: InventoryOutboundCreationTerminalExpectation,
    now?: number,
  ) => Promise<InventoryOutboundCreationTaskResolution>;
  readJournal: (
    principalFingerprint: string,
  ) => Promise<InventoryOutboundCreationTaskJournal | null>;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onEvent: (event: InventoryOutboundCreationCoordinatorEvent) => void;
}

export function getInventoryOutboundCreationPollDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.floor(attempt))
    : 0;
  return POLL_DELAYS_MS[Math.min(safeAttempt, POLL_DELAYS_MS.length - 1)];
}

export function createInventoryOutboundCreationCoordinator(
  dependencies: InventoryOutboundCreationCoordinatorDependencies,
): InventoryOutboundCreationCoordinator {
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

  let active: InventoryOutboundCreationTaskJournal | null = null;
  let activationPending = false;
  let stopped = false;
  let generation = 0;
  let inFlight: 'lock' | 'post' | 'get' | null = null;
  let timerHandle: unknown = null;
  let pollAttempt = 0;
  let acceptReconnectFailures = 0;
  let storageBlocked = false;
  let routeAfterFlight = false;
  let pendingTerminal: PendingTerminal | null = null;
  const completedTerminalHousekeeping = new Map<
    string,
    CompletedTerminalHousekeeping
  >();

  async function start(
    input: InventoryOutboundCreationTaskInput,
  ): Promise<boolean> {
    if (stopped || active || activationPending) return false;
    activationPending = true;
    try {
      const requested = { version: 1 as const, ...input };
      const saved = await dependencies.saveJournal(
        dependencies.principalFingerprint,
        input,
      );
      if (saved) {
        if (stopped || active) return false;
        publishOptimistic(requested, false);
        void runNetworkStep(generation);
        return true;
      }

      const resolution = await safeResolveJournal(requested);
      if (resolution.kind === 'terminal') {
        if (stopped || active) return false;
        publishOptimistic(requested, false);
        consumeTerminalReceipt(resolution.receipt, requested);
        return true;
      }
      if (resolution.kind === 'active') {
        if (
          stopped ||
          active ||
          resolution.journal.clientMutationId !== input.clientMutationId
        ) {
          return false;
        }
        publishOptimistic(resolution.journal, true);
        void runNetworkStep(generation);
        return true;
      }
      return false;
    } finally {
      activationPending = false;
    }
  }

  async function resume(
    journal: InventoryOutboundCreationTaskJournal,
  ): Promise<boolean> {
    if (stopped || active || activationPending) return false;
    activationPending = true;
    try {
      const resolution = await safeResolveJournal(journal);
      if (stopped || active) return false;
      if (resolution.kind === 'terminal') {
        publishOptimistic(journal, false);
        consumeTerminalReceipt(resolution.receipt, journal);
        return true;
      }
      if (resolution.kind !== 'active') {
        publishOptimistic(journal, false);
        blockForStorage(journal);
        return true;
      }
      const latest = resolution.journal;
      publishOptimistic(latest, latest.updatedAt !== journal.updatedAt);
      void runNetworkStep(generation);
      return true;
    } finally {
      activationPending = false;
    }
  }

  function publishOptimistic(
    journal: InventoryOutboundCreationTaskJournal,
    adoptedExisting: boolean,
  ): void {
    active = cloneJournal(journal);
    generation += 1;
    pollAttempt = 0;
    acceptReconnectFailures = 0;
    storageBlocked = false;
    dependencies.onEvent({ type: 'optimistic', journal: cloneJournal(active) });
    if (adoptedExisting) {
      dependencies.onEvent({
        type: 'status',
        journal: cloneJournal(active),
        message: '检测到其他页面更新，已接续原任务。',
      });
    }
  }

  async function runNetworkStep(token: number): Promise<void> {
    if (
      !isCurrent(token) ||
      inFlight ||
      !active ||
      storageBlocked ||
      pendingTerminal
    ) {
      return;
    }
    const mutationId = active.clientMutationId;
    const lockName = `${INVENTORY_OUTBOUND_CREATION_NETWORK_STEP_LOCK_PREFIX}:${dependencies.principalFingerprint}:${mutationId}`;
    inFlight = 'lock';
    const attempt = await runWithInventoryOutboundBrowserLock(
      lockName,
      { mode: 'exclusive', ifAvailable: true },
      async () => {
        if (!isCurrent(token) || !active || pendingTerminal) return;
        const previousUpdatedAt = active.updatedAt;
        const resolution = await safeResolveJournal(active);
        if (!isCurrent(token) || !active) return;
        if (resolution.kind === 'terminal') {
          consumeTerminalReceipt(resolution.receipt, active);
          return;
        }
        if (resolution.kind === 'missing') {
          if (active.taskId) {
            dependencies.onEvent({
              type: 'status',
              journal: cloneJournal(active),
              message:
                '检测到其他页面已处理本地任务，正在通过原任务编号收敛状态。',
            });
            inFlight = 'get';
            await queryTaskUnderLock(token);
          } else {
            requestAuthoritativeRefresh(token);
          }
          return;
        }
        if (resolution.kind !== 'active') {
          blockForStorage(active);
          return;
        }
        const latest = resolution.journal;
        if (latest.clientMutationId !== mutationId) {
          blockForStorage(active);
          return;
        }
        active = cloneJournal(latest);
        if (latest.updatedAt !== previousUpdatedAt) {
          dependencies.onEvent({
            type: 'status',
            journal: cloneJournal(active),
            message: '检测到其他页面更新，已接续原任务。',
          });
        }
        if (active.taskId) {
          inFlight = 'get';
          await queryTaskUnderLock(token);
        } else {
          inFlight = 'post';
          await reconnectAcceptanceUnderLock(token);
        }
      },
    );

    inFlight = null;
    if (!isCurrent(token)) return;
    if (attempt.acquired === false) {
      if (attempt.reason === 'contended') {
        schedule(token, NETWORK_LOCK_RETRY_DELAY_MS, () => {
          void runNetworkStep(token);
        });
      } else if (active) {
        blockForStorage(active);
      }
      return;
    }
    if (routeAfterFlight && !storageBlocked && !pendingTerminal) {
      routeAfterFlight = false;
      void runNetworkStep(token);
    }
  }

  async function reconnectAcceptanceUnderLock(token: number): Promise<void> {
    if (!isCurrent(token) || !active || active.taskId || pendingTerminal)
      return;
    const request = active.request;
    try {
      const response = await dependencies.submitOutbound(request);
      if (!canHandleNetworkResult(token, request.clientMutationId)) return;
      acceptReconnectFailures = 0;
      await handleAcceptanceResponse(response, token);
    } catch (error) {
      if (!canHandleNetworkResult(token, request.clientMutationId)) return;
      await handleAcceptanceError(error, token);
    }
  }

  async function handleAcceptanceResponse(
    response: InventoryOutboundAcceptedResponse,
    token: number,
  ): Promise<void> {
    if (
      !isRecord(response) ||
      response.accepted !== true ||
      !isIdentifier(response.taskId)
    ) {
      await markAcceptanceUncertain(
        '出库受理响应不完整，系统将使用原编号重新连接。',
        token,
      );
      return;
    }
    if (
      response.status === 'failed' &&
      response.definitelyNotWritten === true
    ) {
      await failDefinitelyNotWritten(response.message, token);
      return;
    }
    if (response.status === 'completed' && response.result) {
      const result = canonicalCompletedResult(response.result, active?.request);
      if (result) {
        await complete(result, token);
        return;
      }
    }

    const uncertain =
      response.status === 'uncertain' ||
      response.status === 'failed' ||
      response.status === 'completed';
    const journal = await persistState(
      {
        status: uncertain ? 'uncertain' : 'accepted',
        taskId: response.taskId,
        ...(uncertain
          ? { error: response.message || '出库结果待后端任务进一步核对。' }
          : { error: undefined }),
      },
      token,
    );
    if (!journal || pendingTerminal) return;
    dependencies.onEvent({
      type: 'status',
      journal: cloneJournal(journal),
      message:
        journal.status === 'accepted'
          ? response.message || '出库任务已受理，正在自动核对。'
          : journal.error || '出库结果待确认。',
    });
    pollAttempt =
      journal.status === 'uncertain' ? POLL_DELAYS_MS.length - 1 : 0;
    schedule(token, getInventoryOutboundCreationPollDelay(pollAttempt), () => {
      void runNetworkStep(token);
    });
  }

  async function handleAcceptanceError(
    error: unknown,
    token: number,
  ): Promise<void> {
    const status = responseStatus(error);
    const message = errorMessage(
      error,
      '出库受理响应未确认，系统会使用原编号重新连接。',
    );
    if (isDefinitelyNotWrittenError(error)) {
      await failDefinitelyNotWritten(message, token);
      return;
    }
    if (status === 409) {
      const journal = await persistState(
        { status: 'conflict', taskId: null, error: message },
        token,
      );
      if (journal && !pendingTerminal) {
        dependencies.onEvent({
          type: 'status',
          journal: cloneJournal(journal),
          message,
        });
      }
      return;
    }
    await markAcceptanceUncertain(message, token);
  }

  async function markAcceptanceUncertain(
    message: string,
    token: number,
  ): Promise<void> {
    const journal = await persistState(
      { status: 'uncertain', taskId: null, error: message },
      token,
    );
    if (!journal || pendingTerminal) return;
    dependencies.onEvent({
      type: 'status',
      journal: cloneJournal(journal),
      message,
    });
    acceptReconnectFailures += 1;
    if (acceptReconnectFailures > MAX_ACCEPT_RECONNECT_ATTEMPTS) return;
    const delay =
      ACCEPT_RECONNECT_DELAYS_MS[
        Math.min(
          acceptReconnectFailures - 1,
          ACCEPT_RECONNECT_DELAYS_MS.length - 1,
        )
      ];
    schedule(token, delay, () => {
      void runNetworkStep(token);
    });
  }

  async function queryTaskUnderLock(token: number): Promise<void> {
    if (!isCurrent(token) || !active?.taskId || pendingTerminal) return;
    const taskId = active.taskId;
    try {
      const response = await dependencies.getTaskStatus(
        taskId,
        active.request.building,
      );
      if (!canHandleNetworkResult(token, active.clientMutationId, taskId)) {
        return;
      }
      await handleTaskResponse(response, token, taskId);
    } catch (error) {
      if (
        !active ||
        !canHandleNetworkResult(token, active.clientMutationId, taskId)
      ) {
        return;
      }
      await handleTaskError(error, token, taskId);
    }
  }

  async function handleTaskResponse(
    response: InventoryOutboundTaskStatusResponse,
    token: number,
    taskId: string,
  ): Promise<void> {
    if (
      !isRecord(response) ||
      response.success !== true ||
      !isRecord(response.task) ||
      response.task.id !== taskId
    ) {
      await markTaskUncertain(
        taskId,
        '任务查询响应与本次出库不一致，已保留原编号继续核对。',
        token,
      );
      return;
    }
    const task = response.task;
    if (task.status === 'completed') {
      const result = canonicalCompletedResult(task.result, active?.request);
      if (result) await complete(result, token);
      else {
        await markTaskUncertain(
          taskId,
          '任务已返回完成，但出库记录与原请求不一致，正在继续核对。',
          token,
        );
      }
      return;
    }
    if (task.status === 'failed') {
      const failedTask = task as {
        message: string;
        definitelyNotWritten?: boolean;
      };
      if (failedTask.definitelyNotWritten === true) {
        await failDefinitelyNotWritten(failedTask.message, token);
      } else {
        await markTaskUncertain(taskId, failedTask.message, token);
      }
      return;
    }
    if (task.status === 'uncertain') {
      await markTaskUncertain(taskId, task.message, token);
      return;
    }
    if (task.status !== 'pending' && task.status !== 'running') {
      await markTaskUncertain(
        taskId,
        '任务状态无法识别，已保留原编号继续核对。',
        token,
      );
      return;
    }
    const journal = await persistState(
      { status: 'accepted', taskId, error: undefined },
      token,
    );
    if (!journal || pendingTerminal) return;
    dependencies.onEvent({
      type: 'status',
      journal: cloneJournal(journal),
      message: task.message || '出库任务正在同步。',
    });
    const delay = getInventoryOutboundCreationPollDelay(pollAttempt);
    pollAttempt += 1;
    schedule(token, delay, () => {
      void runNetworkStep(token);
    });
  }

  async function handleTaskError(
    error: unknown,
    token: number,
    taskId: string,
  ): Promise<void> {
    const message = errorMessage(
      error,
      '暂时无法查询出库任务，系统会保留原编号继续核对。',
    );
    if (responseStatus(error) === 409) {
      const journal = await persistState(
        { status: 'conflict', taskId, error: message },
        token,
      );
      if (journal && !pendingTerminal) {
        dependencies.onEvent({
          type: 'status',
          journal: cloneJournal(journal),
          message,
        });
      }
      return;
    }
    await markTaskUncertain(taskId, message, token);
  }

  async function markTaskUncertain(
    taskId: string,
    message: string,
    token: number,
  ): Promise<void> {
    const journal = await persistState(
      { status: 'uncertain', taskId, error: message || '出库结果待确认。' },
      token,
    );
    if (!journal || pendingTerminal) return;
    dependencies.onEvent({
      type: 'status',
      journal: cloneJournal(journal),
      message: journal.error || '出库结果待确认。',
    });
    pollAttempt = Math.max(pollAttempt + 1, POLL_DELAYS_MS.length - 1);
    schedule(token, getInventoryOutboundCreationPollDelay(pollAttempt), () => {
      void runNetworkStep(token);
    });
  }

  async function persistState(
    patch: Partial<InventoryOutboundCreationTaskInput>,
    token: number,
  ): Promise<InventoryOutboundCreationTaskJournal | null> {
    if (!isCurrent(token) || !active || pendingTerminal) return null;
    const current = cloneJournal(active);
    const next: InventoryOutboundCreationTaskJournal = {
      ...current,
      ...patch,
      version: 1,
      updatedAt: Math.max(now(), current.updatedAt + 1),
    };
    const saved = await dependencies.saveJournal(
      dependencies.principalFingerprint,
      withoutVersion(next),
      expectedVersion(current),
    );
    if (!isCurrent(token) || pendingTerminal) return null;
    if (!saved) {
      await recoverFromPersistenceConflict(current, token);
      return null;
    }
    active = next;
    return next;
  }

  async function recoverFromPersistenceConflict(
    current: InventoryOutboundCreationTaskJournal,
    token: number,
  ): Promise<void> {
    if (!isCurrent(token)) return;
    cancelTimer();
    const latest = await safeReadJournal();
    if (
      !latest ||
      latest.clientMutationId !== current.clientMutationId ||
      latest.updatedAt <= current.updatedAt
    ) {
      blockForStorage(current);
      return;
    }
    active = cloneJournal(latest);
    storageBlocked = false;
    pendingTerminal = null;
    dependencies.onEvent({
      type: 'status',
      journal: cloneJournal(active),
      message: '检测到其他页面更新，已接续原任务。',
    });
    if (active.taskId) routeAfterFlight = true;
    else {
      schedule(token, ACCEPT_RECONNECT_DELAYS_MS[0], () => {
        void runNetworkStep(token);
      });
    }
  }

  async function safeReadJournal(): Promise<InventoryOutboundCreationTaskJournal | null> {
    try {
      return await dependencies.readJournal(dependencies.principalFingerprint);
    } catch {
      return null;
    }
  }

  async function safeResolveJournal(
    journal: InventoryOutboundCreationTaskJournal,
  ): Promise<InventoryOutboundCreationTaskResolution> {
    try {
      return await dependencies.resolveJournal(
        dependencies.principalFingerprint,
        terminalExpectation(journal),
        now(),
      );
    } catch {
      return { kind: 'unavailable' };
    }
  }

  function blockForStorage(
    journal: InventoryOutboundCreationTaskJournal,
  ): void {
    storageBlocked = true;
    routeAfterFlight = false;
    cancelTimer();
    dependencies.onEvent({
      type: 'status',
      journal: cloneJournal(journal),
      message:
        '本地出库任务日志发生冲突，已停止网络推进；请保留本页面并检查浏览器存储。',
    });
  }

  function requestAuthoritativeRefresh(token: number): void {
    if (!isCurrent(token) || !active) return;
    storageBlocked = false;
    dependencies.onEvent({
      type: 'authoritative-refresh-required',
      journal: cloneJournal(active),
      message:
        '另一页面可能已处理原出库任务，正在刷新权威出库记录；在确认前不会重复发送。',
    });
    acceptReconnectFailures += 1;
    if (acceptReconnectFailures > MAX_ACCEPT_RECONNECT_ATTEMPTS) return;
    schedule(
      token,
      ACCEPT_RECONNECT_DELAYS_MS[acceptReconnectFailures - 1],
      () => {
        void runNetworkStep(token);
      },
    );
  }

  function canHandleNetworkResult(
    token: number,
    mutationId: string,
    taskId?: string,
  ): boolean {
    return (
      isCurrent(token) &&
      !pendingTerminal &&
      active?.clientMutationId === mutationId &&
      (taskId === undefined || active.taskId === taskId)
    );
  }

  async function complete(
    result: InventoryOutboundMovementCreateResponse,
    token: number,
  ): Promise<void> {
    await attemptTerminalCleanup({ kind: 'completed', result }, token);
  }

  async function failDefinitelyNotWritten(
    message: string,
    token: number,
  ): Promise<void> {
    await attemptTerminalCleanup({ kind: 'failed', message }, token);
  }

  async function attemptTerminalCleanup(
    terminal: PendingTerminal,
    token: number,
  ): Promise<void> {
    if (!isCurrent(token) || !active) return;
    const journal = cloneJournal(active);
    pendingTerminal = terminal;
    cancelTimer();
    const resolution = await safeFinalizeJournal(journal, terminal);
    if (!isCurrent(token)) return;
    if (resolution.kind !== 'terminal') {
      await recoverFromTerminalClearFailure(terminal, journal, token);
      return;
    }
    consumeTerminalReceipt(resolution.receipt, journal);
  }

  async function recoverFromTerminalClearFailure(
    terminal: PendingTerminal,
    current: InventoryOutboundCreationTaskJournal,
    token: number,
  ): Promise<void> {
    const resolution = await safeResolveJournal(current);
    if (!isCurrent(token)) return;
    if (resolution.kind === 'terminal') {
      consumeTerminalReceipt(resolution.receipt, current);
      return;
    }
    if (terminal.kind === 'completed') {
      if (resolution.kind === 'active') {
        const latest = resolution.journal;
        if (latest.updatedAt !== current.updatedAt) {
          active = cloneJournal(latest);
          pendingTerminal = null;
          storageBlocked = false;
          dependencies.onEvent({
            type: 'status',
            journal: cloneJournal(active),
            message: '检测到其他页面更新，已接续原任务。',
          });
          if (active.taskId) routeAfterFlight = true;
          else {
            schedule(token, ACCEPT_RECONNECT_DELAYS_MS[0], () => {
              void runNetworkStep(token);
            });
          }
          return;
        }
        settleCompletedBeforeHousekeeping(terminal.result, current, token);
        return;
      }
      if (resolution.kind === 'missing' || resolution.kind === 'unavailable') {
        settleCompletedBeforeHousekeeping(terminal.result, current, token);
        return;
      }
    }
    if (resolution.kind !== 'active') {
      storageBlocked = true;
      pendingTerminal = terminal;
      dependencies.onEvent({
        type: 'status',
        journal: cloneJournal(current),
        message:
          terminal.kind === 'completed'
            ? '后端已完成，但本地任务日志暂时无法安全清理；已停止网络推进。'
            : '后端已确认未写入，但本地任务日志暂时无法安全清理；已停止网络推进。',
      });
      return;
    }
    const latest = resolution.journal;
    if (latest.updatedAt !== current.updatedAt) {
      active = cloneJournal(latest);
      pendingTerminal = null;
      storageBlocked = false;
      dependencies.onEvent({
        type: 'status',
        journal: cloneJournal(active),
        message: '检测到其他页面更新，已接续原任务。',
      });
      if (active.taskId) routeAfterFlight = true;
      else {
        schedule(token, ACCEPT_RECONNECT_DELAYS_MS[0], () => {
          void runNetworkStep(token);
        });
      }
      return;
    }
    active = cloneJournal(latest);
    pendingTerminal = terminal;
    storageBlocked = false;
    dependencies.onEvent({
      type: 'status',
      journal: cloneJournal(active),
      message:
        terminal.kind === 'completed'
          ? '后端已完成，正在完成本地安全清理。'
          : '后端已确认未写入，正在完成本地安全清理。',
    });
    schedule(token, POLL_DELAYS_MS[POLL_DELAYS_MS.length - 1], () => {
      if (pendingTerminal) void attemptTerminalCleanup(pendingTerminal, token);
    });
  }

  function settleCompletedBeforeHousekeeping(
    result: InventoryOutboundMovementCreateResponse,
    journal: InventoryOutboundCreationTaskJournal,
    token: number,
  ): void {
    if (
      !isCurrent(token) ||
      active?.clientMutationId !== journal.clientMutationId
    ) {
      return;
    }
    pendingTerminal = null;
    storageBlocked = false;
    routeAfterFlight = false;
    cancelTimer();
    active = null;
    generation += 1;
    dependencies.onEvent({
      type: 'completed',
      journal: cloneJournal(journal),
      result,
    });
    enqueueCompletedTerminalHousekeeping(journal, result);
  }

  function enqueueCompletedTerminalHousekeeping(
    journal: InventoryOutboundCreationTaskJournal,
    result: InventoryOutboundMovementCreateResponse,
  ): void {
    const existing = completedTerminalHousekeeping.get(
      journal.clientMutationId,
    );
    if (existing?.timerHandle !== null && existing?.timerHandle !== undefined) {
      clearTimer(existing.timerHandle);
    }
    const entry: CompletedTerminalHousekeeping = {
      journal: cloneJournal(journal),
      result,
      attempts: 1,
      inFlight: false,
      timerHandle: null,
    };
    completedTerminalHousekeeping.set(journal.clientMutationId, entry);
    scheduleCompletedTerminalHousekeeping(entry);
  }

  function scheduleCompletedTerminalHousekeeping(
    entry: CompletedTerminalHousekeeping,
  ): void {
    if (
      stopped ||
      entry.inFlight ||
      entry.timerHandle !== null ||
      entry.attempts >= MAX_TERMINAL_HOUSEKEEPING_ATTEMPTS
    ) {
      return;
    }
    entry.timerHandle = setTimer(() => {
      entry.timerHandle = null;
      void runCompletedTerminalHousekeeping(entry);
    }, TERMINAL_HOUSEKEEPING_RETRY_DELAY_MS);
  }

  async function runCompletedTerminalHousekeeping(
    entry: CompletedTerminalHousekeeping,
  ): Promise<void> {
    if (stopped || entry.inFlight) return;
    const current = completedTerminalHousekeeping.get(
      entry.journal.clientMutationId,
    );
    if (current !== entry) return;
    entry.inFlight = true;
    entry.attempts += 1;
    const resolution = await safeFinalizeJournal(entry.journal, {
      kind: 'completed',
      result: entry.result,
    });
    entry.inFlight = false;
    if (
      stopped ||
      completedTerminalHousekeeping.get(entry.journal.clientMutationId) !==
        entry
    ) {
      return;
    }
    if (
      resolution.kind === 'terminal' ||
      resolution.kind === 'missing' ||
      resolution.kind === 'conflict'
    ) {
      completedTerminalHousekeeping.delete(entry.journal.clientMutationId);
      return;
    }
    scheduleCompletedTerminalHousekeeping(entry);
  }

  async function safeFinalizeJournal(
    journal: InventoryOutboundCreationTaskJournal,
    terminal: PendingTerminal,
  ): Promise<InventoryOutboundCreationTaskResolution> {
    try {
      return await dependencies.finalizeJournal(
        dependencies.principalFingerprint,
        journal,
        terminalOutcome(terminal),
        now(),
      );
    } catch {
      return { kind: 'unavailable' };
    }
  }

  function consumeTerminalReceipt(
    receipt: InventoryOutboundCreationTerminalReceipt,
    journal: InventoryOutboundCreationTaskJournal,
  ): void {
    if (!active || active.clientMutationId !== receipt.clientMutationId) return;
    if (receipt.outcome.kind === 'failed' && receipt.recovery === null) {
      blockForStorage(journal);
      return;
    }
    pendingTerminal = null;
    storageBlocked = false;
    routeAfterFlight = false;
    cancelTimer();
    active = null;
    generation += 1;
    if (receipt.outcome.kind === 'completed') {
      dependencies.onEvent({
        type: 'completed',
        journal: cloneJournal(journal),
        result: receipt.outcome.result,
      });
      return;
    }
    dependencies.onEvent({
      type: 'failed',
      journal: cloneJournal(journal),
      receipt: receipt as InventoryOutboundCreationFailedTerminalReceipt,
      definitelyNotWritten: true,
      message: receipt.outcome.message || '出库请求未写入，已恢复草稿。',
    });
  }

  function schedule(token: number, delay: number, callback: () => void): void {
    if (!isCurrent(token)) return;
    cancelTimer();
    timerHandle = setTimer(() => {
      timerHandle = null;
      if (!isCurrent(token)) return;
      callback();
    }, delay);
  }

  function cancelTimer(): void {
    if (timerHandle === null) return;
    clearTimer(timerHandle);
    timerHandle = null;
  }

  function isCurrent(token: number): boolean {
    return !stopped && token === generation && active !== null;
  }

  return {
    start,
    resume,
    async checkNow() {
      if (stopped) return false;
      let handled = false;
      for (const entry of completedTerminalHousekeeping.values()) {
        if (entry.inFlight) continue;
        if (entry.timerHandle !== null) {
          clearTimer(entry.timerHandle);
          entry.timerHandle = null;
        }
        void runCompletedTerminalHousekeeping(entry);
        handled = true;
      }
      if (!active || inFlight || storageBlocked) return handled;
      cancelTimer();
      if (pendingTerminal) {
        await attemptTerminalCleanup(pendingTerminal, generation);
        return true;
      }
      if (!active.taskId) acceptReconnectFailures = 0;
      void runNetworkStep(generation);
      return true;
    },
    async reconcileAuthoritativeMovement(movement) {
      if (!active) return false;
      const result = canonicalMovementResult(movement, active.request);
      if (!result) return false;
      await complete(result, generation);
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      cancelTimer();
      for (const entry of completedTerminalHousekeeping.values()) {
        if (entry.timerHandle !== null) clearTimer(entry.timerHandle);
      }
      completedTerminalHousekeeping.clear();
    },
    getCurrentJournal() {
      return active ? cloneJournal(active) : null;
    },
  };
}

function expectedVersion(
  journal: InventoryOutboundCreationTaskJournal,
): InventoryOutboundCreationTaskExpectedVersion {
  return {
    clientMutationId: journal.clientMutationId,
    updatedAt: journal.updatedAt,
  };
}

function terminalExpectation(
  journal: InventoryOutboundCreationTaskJournal,
): InventoryOutboundCreationTerminalExpectation {
  return {
    clientMutationId: journal.clientMutationId,
    request: { ...journal.request },
    journalCreatedAt: journal.createdAt,
    terminalFromUpdatedAt: journal.updatedAt,
    taskId: journal.taskId,
  };
}

function terminalOutcome(
  terminal: PendingTerminal,
): InventoryOutboundCreationTerminalOutcome {
  return terminal.kind === 'completed'
    ? { kind: 'completed', result: terminal.result }
    : {
        kind: 'failed',
        definitelyNotWritten: true,
        message: terminal.message || '出库请求未写入，已恢复草稿。',
      };
}

function withoutVersion(
  journal: InventoryOutboundCreationTaskJournal,
): InventoryOutboundCreationTaskInput {
  const { version: _version, ...input } = journal;
  return input;
}

function cloneJournal(
  journal: InventoryOutboundCreationTaskJournal,
): InventoryOutboundCreationTaskJournal {
  return {
    ...journal,
    ...(journal.recoveredFromFailedReceipt
      ? {
          recoveredFromFailedReceipt: {
            ...journal.recoveredFromFailedReceipt,
          },
        }
      : {}),
    request: { ...journal.request },
    draft: {
      ...journal.draft,
      selectedItem: { ...journal.draft.selectedItem },
      applicant: { ...journal.draft.applicant },
    },
    optimisticItem: { ...journal.optimisticItem },
  };
}

function canonicalCompletedResult(
  value: unknown,
  request: InventoryOutboundMovementCreateRequest | undefined,
): InventoryOutboundMovementCreateResponse | null {
  if (!request || !isRecord(value)) return null;
  if (
    value.success !== true ||
    value.type !== 'outbound' ||
    !isIdentifier(value.recordId) ||
    typeof value.alreadyProcessed !== 'boolean' ||
    typeof value.message !== 'string'
  ) {
    return null;
  }
  const movement = canonicalMovement(value.movement, request);
  if (!movement || movement.recordId !== value.recordId) return null;
  return value as unknown as InventoryOutboundMovementCreateResponse;
}

function canonicalMovementResult(
  movement: InventoryMovementItem,
  request: InventoryOutboundMovementCreateRequest,
): InventoryOutboundMovementCreateResponse | null {
  const canonical = canonicalMovement(movement, request);
  if (!canonical) return null;
  return {
    success: true,
    recordId: canonical.recordId,
    type: 'outbound',
    alreadyProcessed: true,
    message: '已通过权威出库记录完成对账',
    movement: canonical,
  };
}

function canonicalMovement(
  value: unknown,
  request: InventoryOutboundMovementCreateRequest,
): InventoryOutboundMovementItem | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.recordId) ||
    value.clientMutationId !== request.clientMutationId ||
    value.type !== 'outbound' ||
    (value.status !== '待路由' &&
      value.status !== '待审批' &&
      value.status !== '待库房确认' &&
      value.status !== '已驳回' &&
      value.status !== '已出库') ||
    normalizeInventorySku(value.sku) !== normalizeInventorySku(request.sku) ||
    value.building !== request.building ||
    value.quantity !== request.quantity ||
    value.reason !== request.reason ||
    !isDateEquivalent(value.occurredAt, request.occurredAt)
  ) {
    return null;
  }
  return value as unknown as InventoryOutboundMovementItem;
}

function isDateEquivalent(value: unknown, expected: string): boolean {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) === Date.parse(expected)
  );
}

function isDefinitelyNotWrittenError(error: unknown): boolean {
  const data = responseData(error);
  return (
    isRecord(data) &&
    (data.definitelyNotWritten === true ||
      data.writeDisposition === 'definitely-not-written')
  );
}

function normalizeInventorySku(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

function responseStatus(error: unknown): number | null {
  if (!isRecord(error) || !isRecord(error.response)) return null;
  return typeof error.response.status === 'number'
    ? error.response.status
    : null;
}

function responseData(error: unknown): unknown {
  if (!isRecord(error) || !isRecord(error.response)) return null;
  return error.response.data;
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

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 256
  );
}
