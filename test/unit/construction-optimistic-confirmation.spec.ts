import { monitorOptimisticConfirmation } from '../../client/src/pages/ConstructionManagement/optimistic-confirmation';

describe('construction optimistic confirmation monitor', () => {
  it('waits for a background task and authoritative ordinary read before confirming', async () => {
    const taskStates = ['pending', 'running', 'completed'] as const;
    let taskIndex = 0;
    let pending = true;
    let refreshes = 0;

    const result = await monitorOptimisticConfirmation({
      taskId: 'construction-task-1',
      maxPolls: 5,
      readTask: async () => ({
        status: taskStates[Math.min(taskIndex++, taskStates.length - 1)],
      }),
      refresh: async () => {
        refreshes += 1;
        if (taskIndex >= taskStates.length) {
          pending = false;
        }
      },
      isPending: () => pending,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result).toEqual({ status: 'confirmed' });
    expect(refreshes).toBe(1);
  });

  it('returns an explicit failure without treating it as an unknown timeout', async () => {
    const result = await monitorOptimisticConfirmation({
      taskId: 'construction-task-2',
      maxPolls: 5,
      readTask: async () => ({
        status: 'failed',
        message: 'attachment upload failed',
      }),
      refresh: async () => undefined,
      isPending: () => true,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result).toEqual({
      status: 'failed',
      message: 'attachment upload failed',
    });
  });

  it('polls ordinary reads when no background task is required', async () => {
    let pending = true;
    let refreshes = 0;

    const result = await monitorOptimisticConfirmation({
      maxPolls: 4,
      refresh: async () => {
        refreshes += 1;
        if (refreshes === 2) {
          pending = false;
        }
      },
      isPending: () => pending,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result).toEqual({ status: 'confirmed' });
    expect(refreshes).toBe(2);
  });

  it('confirms an accepted mutation after two consecutive task-read errors once the authoritative overlay settles', async () => {
    let pending = true;
    let reads = 0;

    const result = await monitorOptimisticConfirmation({
      taskId: 'construction-task-read-error',
      maxPolls: 3,
      confirmAfterTaskReadErrors: 2,
      readTask: async () => {
        reads += 1;
        throw new Error(`task read failed ${reads}`);
      },
      refresh: async () => {
        pending = false;
      },
      isPending: () => pending,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result).toEqual({ status: 'confirmed' });
    expect(reads).toBe(2);
  });

  it('requires at least two consecutive task-read errors before fallback confirmation', async () => {
    const result = await monitorOptimisticConfirmation({
      taskId: 'construction-task-single-read-error',
      maxPolls: 1,
      confirmAfterTaskReadErrors: 1,
      readTask: async () => {
        throw new Error('single task read failure');
      },
      refresh: async () => undefined,
      isPending: () => false,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result).toEqual({
      status: 'unknown',
      message: 'single task read failure',
    });
  });

  it('resets consecutive task-read errors after a successful task read', async () => {
    const outcomes = ['error', 'pending', 'error'] as const;
    let index = 0;

    const result = await monitorOptimisticConfirmation({
      taskId: 'construction-task-reset-errors',
      maxPolls: outcomes.length,
      confirmAfterTaskReadErrors: 2,
      readTask: async () => {
        const outcome = outcomes[index++];
        if (outcome === 'error') {
          throw new Error('intermittent task read failure');
        }
        return { status: outcome };
      },
      refresh: async () => undefined,
      isPending: () => false,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result).toEqual({
      status: 'unknown',
      message: 'intermittent task read failure',
    });
  });

  it('does not confirm pending or running tasks only because the overlay is no longer pending', async () => {
    const taskStates = ['pending', 'running'] as const;
    let index = 0;
    const refresh = jest.fn(async () => undefined);

    const result = await monitorOptimisticConfirmation({
      taskId: 'construction-task-still-running',
      maxPolls: taskStates.length,
      confirmAfterTaskReadErrors: 2,
      readTask: async () => ({
        status: taskStates[index++],
      }),
      refresh,
      isPending: () => false,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result.status).toBe('unknown');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('cancels without refreshing when the page unmounts during a task read', async () => {
    let stopped = false;
    let resolveTaskRead!: (task: { status: 'completed' }) => void;
    let signalTaskReadStarted!: () => void;
    const taskReadStarted = new Promise<void>((resolve) => {
      signalTaskReadStarted = resolve;
    });
    const refresh = jest.fn(async () => undefined);

    const resultPromise = monitorOptimisticConfirmation({
      taskId: 'construction-task-unmounted-during-read',
      maxPolls: 2,
      readTask: () =>
        new Promise((resolve) => {
          resolveTaskRead = resolve;
          signalTaskReadStarted();
        }),
      refresh,
      isPending: () => false,
      wait: async () => undefined,
      shouldStop: () => stopped,
    });

    await taskReadStarted;
    stopped = true;
    resolveTaskRead({ status: 'completed' });

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps unknown confirmation separate from an explicit failure', async () => {
    const result = await monitorOptimisticConfirmation({
      maxPolls: 2,
      refresh: async () => undefined,
      isPending: () => true,
      wait: async () => undefined,
      shouldStop: () => false,
    });

    expect(result).toEqual({
      status: 'unknown',
      message: '后台同步状态暂未确认',
    });
  });
});
