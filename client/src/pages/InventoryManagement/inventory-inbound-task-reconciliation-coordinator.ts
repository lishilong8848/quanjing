const RECHECK_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

export type InventoryInboundTaskReconciliationResult<TResult> =
  | { status: 'pending' }
  | { status: 'completed'; value: TResult };

export type InventoryInboundTaskReconciliationPhase =
  | 'idle'
  | 'checking'
  | 'waiting'
  | 'completed'
  | 'failed';

interface InventoryInboundTaskReconciliationDependencies<TResult> {
  query: () => Promise<InventoryInboundTaskReconciliationResult<TResult>>;
  onCompleted: (value: TResult) => Promise<void> | void;
  onError: (error: unknown) => 'retry' | 'stop';
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface InventoryInboundTaskReconciliationCoordinator {
  start(): Promise<void>;
  checkNow(): Promise<void>;
  stop(): void;
  getPhase(): InventoryInboundTaskReconciliationPhase;
}

export function createInventoryInboundTaskReconciliationCoordinator<TResult>(
  dependencies: InventoryInboundTaskReconciliationDependencies<TResult>,
): InventoryInboundTaskReconciliationCoordinator {
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

  let phase: InventoryInboundTaskReconciliationPhase = 'idle';
  let retryAttempt = 0;
  let timerHandle: unknown | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  function cancelTimer(): void {
    if (timerHandle === null) return;
    clearTimer(timerHandle);
    timerHandle = null;
  }

  function scheduleNext(): void {
    if (stopped || timerHandle !== null) return;
    phase = 'waiting';
    const delay =
      RECHECK_DELAYS_MS[Math.min(retryAttempt, RECHECK_DELAYS_MS.length - 1)];
    retryAttempt += 1;
    timerHandle = setTimer(() => {
      timerHandle = null;
      void checkNow();
    }, delay);
  }

  function checkNow(): Promise<void> {
    if (stopped || phase === 'completed' || phase === 'failed') {
      return Promise.resolve();
    }
    cancelTimer();
    if (inFlight) return inFlight;

    const operation = (async () => {
      phase = 'checking';
      try {
        const result = await dependencies.query();
        if (stopped) return;
        if (result.status === 'pending') {
          scheduleNext();
          return;
        }
        phase = 'completed';
        await dependencies.onCompleted(result.value);
      } catch (error) {
        if (stopped) return;
        if (dependencies.onError(error) === 'retry') {
          scheduleNext();
          return;
        }
        phase = 'failed';
      }
    })();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  }

  return {
    start: checkNow,
    checkNow,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelTimer();
      phase = 'idle';
    },
    getPhase() {
      return phase;
    },
  };
}
