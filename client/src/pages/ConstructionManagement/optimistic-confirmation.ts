export type OptimisticConfirmationTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface OptimisticConfirmationTaskState {
  status: OptimisticConfirmationTaskStatus;
  message?: string;
}

export type OptimisticConfirmationResult =
  | { status: 'confirmed' }
  | { status: 'failed'; message: string }
  | { status: 'unknown'; message: string }
  | { status: 'cancelled' };

export interface OptimisticConfirmationMonitorOptions {
  taskId?: string | null;
  maxPolls: number;
  confirmAfterTaskReadErrors?: number;
  readTask?: (
    taskId: string,
  ) => Promise<OptimisticConfirmationTaskState>;
  refresh: () => Promise<unknown>;
  isPending: () => boolean;
  wait: () => Promise<unknown>;
  shouldStop: () => boolean;
}

export async function monitorOptimisticConfirmation(
  options: OptimisticConfirmationMonitorOptions,
): Promise<OptimisticConfirmationResult> {
  const taskId = options.taskId?.trim() || '';
  let taskCompleted = !taskId;
  let lastMessage = '';
  let consecutiveTaskReadErrors = 0;
  const taskReadErrorConfirmationThreshold =
    typeof options.confirmAfterTaskReadErrors === 'number' &&
    Number.isFinite(options.confirmAfterTaskReadErrors) &&
    options.confirmAfterTaskReadErrors > 0
      ? Math.max(2, Math.floor(options.confirmAfterTaskReadErrors))
      : null;

  for (let attempt = 0; attempt < options.maxPolls; attempt += 1) {
    if (options.shouldStop()) {
      return { status: 'cancelled' };
    }

    if (taskId && !taskCompleted) {
      try {
        if (!options.readTask) {
          throw new Error('后台任务状态读取器未配置');
        }
        const task = await options.readTask(taskId);
        if (options.shouldStop()) {
          return { status: 'cancelled' };
        }
        consecutiveTaskReadErrors = 0;
        lastMessage = task.message?.trim() || lastMessage;
        if (task.status === 'failed') {
          return {
            status: 'failed',
            message: lastMessage || '后台同步失败',
          };
        }
        taskCompleted = task.status === 'completed';
      } catch (error) {
        consecutiveTaskReadErrors += 1;
        lastMessage =
          error instanceof Error ? error.message : '后台任务状态读取失败';
      }
    }

    if (options.shouldStop()) {
      return { status: 'cancelled' };
    }

    const taskReadErrorFallbackConfirmed =
      Boolean(taskId) &&
      !taskCompleted &&
      taskReadErrorConfirmationThreshold !== null &&
      consecutiveTaskReadErrors >= taskReadErrorConfirmationThreshold;
    const shouldRefreshAuthoritativeData =
      !taskId || taskCompleted || taskReadErrorFallbackConfirmed;
    if (shouldRefreshAuthoritativeData) {
      try {
        await options.refresh();
      } catch (error) {
        lastMessage =
          error instanceof Error ? error.message : '页面数据刷新失败';
      }
    }

    if (options.shouldStop()) {
      return { status: 'cancelled' };
    }

    if (
      (taskCompleted || taskReadErrorFallbackConfirmed) &&
      !options.isPending()
    ) {
      return { status: 'confirmed' };
    }
    if (attempt < options.maxPolls - 1) {
      await options.wait();
      if (options.shouldStop()) {
        return { status: 'cancelled' };
      }
    }
  }

  if (options.shouldStop()) {
    return { status: 'cancelled' };
  }

  return {
    status: 'unknown',
    message: lastMessage || '后台同步状态暂未确认',
  };
}
