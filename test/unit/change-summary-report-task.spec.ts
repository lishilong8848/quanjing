import {
  abandonFailedChangeSummaryReport,
  ChangeSummaryReportCleanupPendingError,
  ChangeSummaryReportTaskIdentityError,
  ChangeSummaryReportTaskFailedError,
  coordinateChangeSummaryReportAcceptance,
  disposeChangeSummaryReportTaskRuntimes,
  isCurrentChangeSummaryReportAbandonOperation,
  isCurrentChangeSummaryReportTaskRuntime,
  pollChangeSummaryReportTask,
  type ChangeSummaryReportTaskStatusResponse,
} from '../../client/src/pages/MonthlySchedule/change-summary-report-task';

const response = (
  taskId: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
  message = '',
): ChangeSummaryReportTaskStatusResponse => ({
  success: status !== 'failed',
  taskId,
  clientMutationId: taskId,
  changeRecordId: 'recChange12345678',
  status,
  phase:
    status === 'pending'
      ? 'accepted'
      : status === 'running'
        ? 'uploading'
        : status,
  message,
  updatedAt: '2026-08-11T10:00:00.000Z',
});

describe('change summary report task polling', () => {
  const expected = {
    taskId: 'task-1',
    clientMutationId: 'task-1',
    changeRecordId: 'recChange12345678',
  };

  it('waits through pending states and returns only the expected completed task', async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce(response('task-1', 'pending'))
      .mockResolvedValueOnce(response('task-1', 'running'))
      .mockResolvedValueOnce(response('task-1', 'completed', '变更总结已同步'));

    await expect(
      pollChangeSummaryReportTask(expected, getStatus, {
        intervalMs: 0,
        maxAttempts: 4,
      }),
    ).resolves.toMatchObject({ taskId: 'task-1', status: 'completed' });
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it('passes the same abort signal into every status request', async () => {
    const controller = new AbortController();
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce(response('task-1', 'running'))
      .mockResolvedValueOnce(response('task-1', 'completed'));

    await pollChangeSummaryReportTask(expected, getStatus, {
      intervalMs: 0,
      maxAttempts: 2,
      signal: controller.signal,
    });

    expect(getStatus).toHaveBeenNthCalledWith(1, 'task-1', controller.signal);
    expect(getStatus).toHaveBeenNthCalledWith(2, 'task-1', controller.signal);
  });

  it.each(['success', 'error'])(
    'drops an A principal old %s settlement after switching to B',
    () => {
      const runtime = { controller: new AbortController() };
      const runtimes = new Map([['mutation-a', runtime]]);

      expect(
        isCurrentChangeSummaryReportTaskRuntime(
          'principal-b',
          'principal-a',
          runtimes,
          'mutation-a',
          runtime,
        ),
      ).toBe(false);
      expect(
        isCurrentChangeSummaryReportTaskRuntime(
          'principal-a',
          'principal-a',
          runtimes,
          'mutation-a',
          runtime,
        ),
      ).toBe(true);
    },
  );

  it('does not let an A cleanup finally release the active B cleanup lock', () => {
    const operationA = {
      fingerprint: 'principal-a',
      mutationId: 'mutation-a',
      token: 1,
    };
    const operationB = {
      fingerprint: 'principal-b',
      mutationId: 'mutation-b',
      token: 2,
    };

    expect(
      isCurrentChangeSummaryReportAbandonOperation(
        'principal-b',
        operationB,
        operationA,
      ),
    ).toBe(false);
    expect(
      isCurrentChangeSummaryReportAbandonOperation(
        'principal-b',
        operationB,
        operationB,
      ),
    ).toBe(true);
  });

  it('aborts every runtime and dismisses its persistent toast on teardown', () => {
    const first = new AbortController();
    const second = new AbortController();
    const runtimes = new Map([
      ['mutation-a', { seq: 1, controller: first }],
      ['mutation-b', { seq: 2, controller: second }],
    ]);
    const dismiss = jest.fn();

    disposeChangeSummaryReportTaskRuntimes(runtimes, dismiss);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(dismiss.mock.calls).toEqual([['mutation-a'], ['mutation-b']]);
    expect(runtimes.size).toBe(0);
  });

  it('rejects an old or mismatched task response instead of applying it', async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValue(response('old-task', 'completed'));

    const result = pollChangeSummaryReportTask(
      { ...expected, taskId: 'task-2', clientMutationId: 'task-2' },
      getStatus,
      {
        intervalMs: 0,
        maxAttempts: 1,
      },
    );
    await expect(result).rejects.toBeInstanceOf(
      ChangeSummaryReportTaskIdentityError,
    );
    await expect(result).rejects.toThrow('服务端返回了不匹配的变更总结任务');
  });

  it('surfaces the backend failure and stops polling', async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValue(response('task-1', 'failed', '附件同步失败'));

    const result = pollChangeSummaryReportTask(expected, getStatus, {
      intervalMs: 0,
      maxAttempts: 3,
    });
    await expect(result).rejects.toBeInstanceOf(
      ChangeSummaryReportTaskFailedError,
    );
    await expect(result).rejects.toThrow('附件同步失败');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('times out deterministically and allows the draft to be restored', async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValue(response('task-1', 'running'));

    await expect(
      pollChangeSummaryReportTask(expected, getStatus, {
        intervalMs: 0,
        maxAttempts: 2,
      }),
    ).rejects.toThrow('变更总结后台同步超时');
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['clientMutationId', 'old-mutation'],
    ['changeRecordId', 'recDifferent123456'],
  ] as const)(
    'rejects a completed response with mismatched %s',
    async (field, value) => {
      const getStatus = jest.fn().mockResolvedValue({
        ...response('task-1', 'completed'),
        [field]: value,
      });

      await expect(
        pollChangeSummaryReportTask(expected, getStatus, {
          intervalMs: 0,
          maxAttempts: 1,
        }),
      ).rejects.toThrow('不匹配的变更总结任务');
    },
  );

  it('does not close or POST when the initial recovery snapshot cannot persist', async () => {
    const create = jest.fn();
    const onPrepared = jest.fn();
    const binding = {
      request: {
        clientMutationId:
          'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
        submitterName: '马进宇',
        changeRecordId: 'recChange12345678',
        summaryDocuments: [],
      },
      original: {} as never,
      state: 'unknown' as const,
    };

    await expect(
      coordinateChangeSummaryReportAcceptance(binding, {
        persist: () => false,
        onPrepared,
        create,
      }),
    ).rejects.toThrow('无法保存恢复草稿');
    expect(onPrepared).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('closes before POST and reports accepted-task persistence failure explicitly', async () => {
    const operations: string[] = [];
    const binding = {
      request: {
        clientMutationId: 'task-1',
        submitterName: '马进宇',
        changeRecordId: 'recChange12345678',
        summaryDocuments: [],
      },
      original: {} as never,
      state: 'unknown' as const,
    };

    const result = await coordinateChangeSummaryReportAcceptance(binding, {
      persist: (next) => {
        operations.push(next.taskId ? 'persist-accepted' : 'persist-draft');
        return !next.taskId;
      },
      onPrepared: () => operations.push('close'),
      create: async () => {
        operations.push('post');
        return {
          success: true,
          taskId: 'task-1',
          clientMutationId: 'task-1',
          changeRecordId: 'recChange12345678',
          pendingSync: true,
          message: '已受理',
        };
      },
    });

    expect(operations).toEqual([
      'persist-draft',
      'close',
      'post',
      'persist-accepted',
    ]);
    expect(result.recoveryPersisted).toBe(false);
  });

  it('treats an accepted response identity mismatch as unknown rather than explicit failure', async () => {
    const binding = {
      request: {
        clientMutationId: 'task-1',
        submitterName: '马进宇',
        changeRecordId: 'recChange12345678',
        summaryDocuments: [],
      },
      original: {} as never,
      state: 'unknown' as const,
    };

    await expect(
      coordinateChangeSummaryReportAcceptance(binding, {
        persist: () => true,
        onPrepared: () => undefined,
        create: async () => ({
          success: true,
          taskId: 'task-1',
          clientMutationId: 'old-mutation',
          changeRecordId: 'recChange12345678',
          message: '已受理',
        }),
      }),
    ).rejects.toBeInstanceOf(ChangeSummaryReportTaskIdentityError);
  });

  it('abandons an explicit failure only after server-verified cleanup succeeds', async () => {
    const binding = {
      request: {
        clientMutationId: 'task-1',
        submitterName: '马进宇',
        changeRecordId: 'recChange12345678',
        summaryDocuments: [
          {
            name: '总结.pdf',
            size: 1,
            type: 'application/pdf',
            objectStorage: {
              id: 'object-1',
              filePath: 'summary/a.pdf',
              bucketId: 'bucket',
              url: 'https://storage.example.test/summary/a.pdf',
            },
          },
        ],
      },
      original: {} as never,
      state: 'failed' as const,
      error: '同步失败',
    };
    const abandon = jest.fn().mockResolvedValue({
      success: true,
      clientMutationId: 'task-1',
      changeRecordId: 'recChange12345678',
      canAbandon: true,
      abandoned: true,
      phase: 'abandoned',
      message: '已清理',
    });
    const removeRecovery = jest.fn(() => true);

    await expect(
      abandonFailedChangeSummaryReport(binding, {
        abandon,
        removeRecovery,
        createMutationId: () => 'change-summary-report-new',
      }),
    ).resolves.toBe('change-summary-report-new');
    expect(abandon).toHaveBeenCalledWith({
      clientMutationId: 'task-1',
      changeRecordId: 'recChange12345678',
      submitterName: '马进宇',
    });
    expect(removeRecovery).toHaveBeenCalledWith('task-1');
  });

  it('keeps recovery and blocks unsafe retry while server cleanup is partial', async () => {
    const binding = {
      request: {
        clientMutationId: 'task-1',
        submitterName: '马进宇',
        changeRecordId: 'recChange12345678',
        summaryDocuments: [
          {
            name: '总结.pdf',
            size: 1,
            type: 'application/pdf',
            objectStorage: {
              id: 'bound-object',
              filePath: 'summary/a.pdf',
              bucketId: 'bucket',
              url: 'https://storage.example.test/summary/a.pdf',
            },
          },
        ],
      },
      original: {} as never,
      state: 'failed' as const,
      error: '同步失败',
    };
    const removeRecovery = jest.fn(() => true);

    const result = abandonFailedChangeSummaryReport(binding, {
      abandon: async () => ({
        success: true,
        clientMutationId: 'task-1',
        changeRecordId: 'recChange12345678',
        canAbandon: true,
        abandoned: false,
        phase: 'cleanup-partial',
        message: '仍有一项待清理',
      }),
      removeRecovery,
      createMutationId: () => 'change-summary-report-new',
    });

    await expect(result).rejects.toBeInstanceOf(
      ChangeSummaryReportCleanupPendingError,
    );
    await expect(result).rejects.toThrow('仍有一项待清理');
    expect(removeRecovery).not.toHaveBeenCalled();
  });

  it('does not clear recovery for a mismatched server abandon response', async () => {
    const binding = {
      request: {
        clientMutationId: 'task-1',
        submitterName: '马进宇',
        changeRecordId: 'recChange12345678',
        summaryDocuments: [],
      },
      original: {} as never,
      state: 'failed' as const,
    };
    const removeRecovery = jest.fn(() => true);

    await expect(
      abandonFailedChangeSummaryReport(binding, {
        abandon: async () => ({
          success: true,
          clientMutationId: 'other-task',
          changeRecordId: 'recChange12345678',
          canAbandon: true,
          abandoned: true,
          phase: 'abandoned',
          message: '已清理',
        }),
        removeRecovery,
        createMutationId: () => 'change-summary-report-new',
      }),
    ).rejects.toBeInstanceOf(ChangeSummaryReportTaskIdentityError);
    expect(removeRecovery).not.toHaveBeenCalled();
  });

  it('blocks retry when server cleanup succeeded but local recovery removal failed', async () => {
    const binding = {
      request: {
        clientMutationId: 'task-1',
        submitterName: '马进宇',
        changeRecordId: 'recChange12345678',
        summaryDocuments: [],
      },
      original: {} as never,
      state: 'failed' as const,
    };
    const createMutationId = jest.fn(() => 'change-summary-report-new');

    await expect(
      abandonFailedChangeSummaryReport(binding, {
        abandon: async () => ({
          success: true,
          clientMutationId: 'task-1',
          changeRecordId: 'recChange12345678',
          canAbandon: true,
          abandoned: true,
          phase: 'abandoned',
          message: '已清理',
        }),
        removeRecovery: () => false,
        createMutationId,
      }),
    ).rejects.toBeInstanceOf(ChangeSummaryReportCleanupPendingError);
    expect(createMutationId).not.toHaveBeenCalled();
  });
});
