import {
  createInventoryInboundTaskReconciliationCoordinator,
  type InventoryInboundTaskReconciliationResult,
} from '../../client/src/pages/InventoryManagement/inventory-inbound-task-reconciliation-coordinator';

type Result = InventoryInboundTaskReconciliationResult<{ recordId: string }>;

describe('inventory inbound task reconciliation coordinator', () => {
  it('keeps polling with bounded backoff until a deferred task completes', async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const completed: Array<{ recordId: string }> = [];
    const query = jest
      .fn<Promise<Result>, []>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'completed',
        value: { recordId: 'inbound-record-1' },
      });
    const coordinator = createInventoryInboundTaskReconciliationCoordinator({
      query,
      onCompleted: async (value) => {
        completed.push(value);
      },
      onError: () => 'retry',
      setTimer: (callback, delay) => {
        scheduled.push({ callback, delay });
        return callback;
      },
      clearTimer: () => undefined,
    });

    await coordinator.start();
    expect(query).toHaveBeenCalledTimes(1);
    expect(scheduled.at(-1)?.delay).toBe(5_000);

    scheduled.at(-1)?.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(2);
    expect(scheduled.at(-1)?.delay).toBe(10_000);

    scheduled.at(-1)?.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(3);
    expect(completed).toEqual([{ recordId: 'inbound-record-1' }]);
    expect(coordinator.getPhase()).toBe('completed');
  });

  it('checks immediately on focus without starting a duplicate request', async () => {
    let resolveQuery!: (value: Result) => void;
    const query = jest.fn(
      () =>
        new Promise<Result>((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const coordinator = createInventoryInboundTaskReconciliationCoordinator({
      query,
      onCompleted: async () => undefined,
      onError: () => 'retry',
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    const initial = coordinator.start();
    const focused = coordinator.checkNow();
    expect(query).toHaveBeenCalledTimes(1);

    resolveQuery({ status: 'pending' });
    await Promise.all([initial, focused]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(coordinator.getPhase()).toBe('waiting');
  });

  it('retries transient failures but stops after a terminal failure', async () => {
    const scheduled: Array<() => void> = [];
    const errors: string[] = [];
    const query = jest
      .fn<Promise<Result>, []>()
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockRejectedValueOnce(new Error('task rejected'));
    const coordinator = createInventoryInboundTaskReconciliationCoordinator({
      query,
      onCompleted: async () => undefined,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        return message.includes('temporary') ? 'retry' : 'stop';
      },
      setTimer: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      clearTimer: () => undefined,
    });

    await coordinator.start();
    expect(coordinator.getPhase()).toBe('waiting');
    scheduled.at(-1)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(['temporary network error', 'task rejected']);
    expect(coordinator.getPhase()).toBe('failed');
  });
});
