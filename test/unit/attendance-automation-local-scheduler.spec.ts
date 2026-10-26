import { AttendanceAutomationLocalSchedulerService } from '../../server/modules/duty-schedule/attendance-automation-local-scheduler.service';
import { getNextAttendanceAutomationRun } from '../../server/modules/duty-schedule/attendance-automation.scheduler';

describe('AttendanceAutomationLocalSchedulerService configuration', () => {
  const hostEnv = process.env;
  const originalEnv = {
    ...hostEnv,
    FEISHU_CARD_ACTION_CONSUMER_PROFILE: 'production',
  };

  afterEach(() => {
    process.env = hostEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['disabled', 'local-test', ''])(
    'does not start production attendance automation in the %s runtime profile',
    (profile) => {
      process.env = {
        ...originalEnv,
        FEISHU_CARD_ACTION_CONSUMER_PROFILE: profile,
        ATTENDANCE_AUTOMATION_ENABLED: 'true',
        DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
        DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
      };
      const scheduler = new AttendanceAutomationLocalSchedulerService(
        {} as never,
      );

      expect(
        (
          scheduler as unknown as {
            isEnabled(): boolean;
          }
        ).isEnabled(),
      ).toBe(false);
    },
  );

  it('starts attendance automation only in the production runtime profile', () => {
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const scheduler = new AttendanceAutomationLocalSchedulerService(
      {} as never,
    );

    expect(
      (
        scheduler as unknown as {
          isEnabled(): boolean;
        }
      ).isEnabled(),
    ).toBe(true);
  });

  it('fails closed when automation is enabled without DingTalk credentials', () => {
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      DINGTALK_ATTENDANCE_CLIENT_ID: '',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: '',
    };
    const scheduler = new AttendanceAutomationLocalSchedulerService(
      {} as never,
    );

    expect(
      (
        scheduler as unknown as {
          isEnabled(): boolean;
        }
      ).isEnabled(),
    ).toBe(false);
  });

  it('uses only the five fixed Asia/Shanghai task times', () => {
    const cases = [
      [
        '2026-08-30T16:29:59.000Z',
        'archive-yesterday',
        '2026-08-30T16:30:00.000Z',
      ],
      [
        '2026-08-30T16:30:00.000Z',
        'morning-on-duty-reminder',
        '2026-08-31T00:55:00.000Z',
      ],
      [
        '2026-08-31T00:55:00.000Z',
        'morning-off-duty-check',
        '2026-08-31T01:30:00.000Z',
      ],
      [
        '2026-08-31T01:30:00.000Z',
        'evening-on-duty-reminder',
        '2026-08-31T09:55:00.000Z',
      ],
      [
        '2026-08-31T09:55:00.000Z',
        'evening-off-duty-check',
        '2026-08-31T10:35:00.000Z',
      ],
      [
        '2026-08-31T10:35:00.000Z',
        'archive-yesterday',
        '2026-08-31T16:30:00.000Z',
      ],
    ] as const;

    for (const [now, task, scheduledAt] of cases) {
      expect(getNextAttendanceAutomationRun(new Date(now))).toMatchObject({
        task,
        scheduledAt: new Date(scheduledAt),
      });
    }
  });

  it('retries persisted external sync work even when the scheduled attendance task is already complete', async () => {
    const run = jest.fn().mockResolvedValue({ success: true, skipped: true });
    const recoverPendingCorrections = jest.fn().mockResolvedValue(undefined);
    const recoverPendingAttendanceArchives = jest
      .fn()
      .mockResolvedValue(undefined);
    const reconcileApprovedLeaveAnomalies = jest.fn().mockResolvedValue(1);
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
      recoverPendingCorrections,
      recoverPendingAttendanceArchives,
      reconcileApprovedLeaveAnomalies,
    } as any);
    const scheduled = {
      task: 'archive-yesterday' as const,
      date: '2026-09-16',
      scheduledAt: new Date('2026-09-16T16:30:00.000Z'),
    };
    const result = await (scheduler as any).runSafely(scheduled);
    expect(result).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(recoverPendingCorrections).toHaveBeenCalledTimes(1);
    expect(recoverPendingAttendanceArchives).toHaveBeenCalledTimes(1);
    expect(reconcileApprovedLeaveAnomalies).toHaveBeenCalledTimes(1);
  });

  it('uses one-shot timers and never calls a personal catch-up API', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:54:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '5000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '10',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockResolvedValue({ success: true });
    const runTodayPersonalCatchUp = jest
      .fn()
      .mockResolvedValue({ success: true });
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
      runTodayPersonalCatchUp,
    } as any);

    scheduler.onModuleInit();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(2);

    await jest.advanceTimersByTimeAsync(59_999);
    expect(run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      task: 'morning-on-duty-reminder',
      date: '2026-08-31',
      scheduledAt: new Date('2026-08-31T00:55:00.000Z'),
    });
    expect(runTodayPersonalCatchUp).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();

    scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('queues the 09:30 final check when the 08:55 task finishes after its due time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T00:54:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '86400000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    let finishMorningSync!: () => void;
    const run = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishMorningSync = resolve;
          }),
      )
      .mockResolvedValue({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(run.mock.calls[0][0].task).toBe('morning-on-duty-reminder');

    jest.setSystemTime(new Date('2026-09-09T01:31:00.000Z'));
    finishMorningSync();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toEqual({
      task: 'morning-off-duty-check',
      date: '2026-09-09',
      scheduledAt: new Date('2026-09-09T01:30:00.000Z'),
    });
    scheduler.onModuleDestroy();
  });

  it('starts the 18:35 final check while the 17:55 sync is still running', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T09:54:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '86400000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    let finishEveningSync!: () => void;
    const run = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishEveningSync = resolve;
          }),
      )
      .mockResolvedValue({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(run.mock.calls[0][0].task).toBe('evening-on-duty-reminder');

    await jest.advanceTimersByTimeAsync(40 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toEqual({
      task: 'evening-off-duty-check',
      date: '2026-09-09',
      scheduledAt: new Date('2026-09-09T10:35:00.000Z'),
    });

    scheduler.onModuleDestroy();
    finishEveningSync();
  });

  it('does not replay stale tasks when a scheduled run finishes on the next day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T00:54:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '86400000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    let finishMorningSync!: () => void;
    const run = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishMorningSync = resolve;
          }),
      )
      .mockResolvedValue({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(run.mock.calls[0][0].task).toBe('morning-on-duty-reminder');

    jest.setSystemTime(new Date('2026-09-09T16:01:00.000Z'));
    finishMorningSync();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(run).toHaveBeenCalledTimes(1);
    scheduler.onModuleDestroy();
  });

  it('catches up only same-day final checks after a long run', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T00:54:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '86400000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    let finishMorningSync!: () => void;
    const run = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishMorningSync = resolve;
          }),
      )
      .mockResolvedValue({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    jest.setSystemTime(new Date('2026-09-09T10:40:00.000Z'));
    finishMorningSync();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(run.mock.calls.map(([candidate]) => candidate.task)).toEqual([
      'morning-on-duty-reminder',
      'morning-off-duty-check',
      'evening-off-duty-check',
    ]);
    scheduler.onModuleDestroy();
  });

  it('does not start the 09:30 final check before it is due', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T01:29:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '5000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '0',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockResolvedValue({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(run).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('catches up the 09:30 final check after restart even outside the generic grace window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T07:53:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '5000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '10',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockResolvedValue({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      task: 'morning-off-duty-check',
      date: '2026-09-09',
      scheduledAt: new Date('2026-09-09T01:30:00.000Z'),
    });
    scheduler.onModuleDestroy();
  });

  it('catches up both final checks after an evening restart outside the generic grace window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T13:06:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '5000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '10',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockResolvedValue({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(run.mock.calls.map(([candidate]) => candidate)).toEqual([
      {
        task: 'morning-off-duty-check',
        date: '2026-09-11',
        scheduledAt: new Date('2026-09-11T01:30:00.000Z'),
      },
      {
        task: 'evening-off-duty-check',
        date: '2026-09-11',
        scheduledAt: new Date('2026-09-11T10:35:00.000Z'),
      },
    ]);
    scheduler.onModuleDestroy();
  });

  it('does not repeat an exhausted current-version evening final check after restart', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T13:06:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '5000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '10',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockResolvedValue({ success: true });
    const getRunStatus = jest.fn((task: string) =>
      task === 'evening-off-duty-check'
        ? {
            state: 'failed' as const,
            task: 'evening-off-duty-check' as const,
            date: '2026-09-11',
            scheduledAt: '2026-09-11T10:35:00.000Z',
            firstAttemptAt: '2026-09-11T10:35:00.000Z',
            lastAttemptAt: '2026-09-11T10:35:00.000Z',
            attemptCount: 1,
            maxAttempts: 1,
            finalFailure: true,
          }
        : null,
    );
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
      getRunStatus,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(run.mock.calls.map(([candidate]) => candidate.task)).not.toContain(
      'evening-off-duty-check',
    );
    scheduler.onModuleDestroy();
  });

  it('reopens one legacy terminal 18:35 personal-delivery failure after deployment restart', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T10:36:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '0',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockResolvedValue({ success: true });
    const getRunStatus = jest.fn((task: string) =>
      task === 'evening-off-duty-check'
        ? {
            state: 'failed' as const,
            task: 'evening-off-duty-check' as const,
            date: '2026-09-11',
            scheduledAt: '2026-09-11T10:35:00.000Z',
            firstAttemptAt: '2026-09-11T10:35:00.000Z',
            lastAttemptAt: '2026-09-11T10:35:00.000Z',
            attemptCount: 1,
            maxAttempts: 1,
            failureReason: '个人异常接收人读取失败',
            finalFailure: true,
          }
        : null,
    );
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
      getRunStatus,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(run.mock.calls.map(([candidate]) => candidate.task)).toContain(
      'evening-off-duty-check',
    );
    scheduler.onModuleDestroy();
  });

  it('reopens a legacy terminal 09:30 correction failure after deployment restart', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-17T01:36:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '0',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockResolvedValue({ success: true });
    const getRunStatus = jest.fn((task: string) =>
      task === 'morning-off-duty-check'
        ? {
            state: 'failed' as const,
            task: 'morning-off-duty-check' as const,
            date: '2026-09-17',
            scheduledAt: '2026-09-17T01:30:00.000Z',
            lastAttemptAt: '2026-09-17T01:35:00.000Z',
            attemptCount: 6,
            maxAttempts: 6,
            failureReason: '钉钉补卡审批查询失败',
            finalFailure: true,
          }
        : null,
    );
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
      getRunStatus,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(run.mock.calls.map(([candidate]) => candidate.task)).toContain(
      'morning-off-duty-check',
    );
    scheduler.onModuleDestroy();
  });

  it('retries a failed 09:30 catch-up on the same day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T01:31:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '0',
      ATTENDANCE_AUTOMATION_RETRY_DELAY_MS: '1000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ success: true });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toMatchObject({
      task: 'morning-off-duty-check',
      date: '2026-09-09',
    });
    scheduler.onModuleDestroy();
  });

  it('retries a failed 18:35 final check on the same day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T10:36:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '0',
      ATTENDANCE_AUTOMATION_RETRY_DELAY_MS: '1000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn(async (candidate: { task: string }) => {
      const eveningAttempts = run.mock.calls.filter(
        ([item]) => item.task === 'evening-off-duty-check',
      ).length;
      if (
        candidate.task === 'evening-off-duty-check' &&
        eveningAttempts === 1
      ) {
        throw new Error('temporary personal recipient failure');
      }
      return { success: true };
    });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls.map(([candidate]) => candidate.task)).toEqual([
      'morning-off-duty-check',
      'evening-off-duty-check',
    ]);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls.map(([candidate]) => candidate.task)).toEqual([
      'morning-off-duty-check',
      'evening-off-duty-check',
      'evening-off-duty-check',
    ]);
    scheduler.onModuleDestroy();
  });

  it('stops the 09:30 recovery after the persisted retry policy is exhausted', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T01:31:00.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '0',
      ATTENDANCE_AUTOMATION_RETRY_DELAY_MS: '1000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockRejectedValue(new Error('temporary failure'));
    const getRunStatus = jest.fn(() => {
      const attemptCount = run.mock.calls.length;
      if (attemptCount === 0) return null;
      return {
        state: 'failed' as const,
        task: 'morning-off-duty-check' as const,
        date: '2026-09-09',
        scheduledAt: '2026-09-09T01:30:00.000Z',
        firstAttemptAt: '2026-09-09T01:31:00.000Z',
        lastAttemptAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
        attemptCount,
        maxAttempts: 2,
        retryCutoffAt: '2026-09-09T02:01:00.000Z',
        ...(attemptCount >= 2
          ? { finalFailure: true }
          : { nextRetryAt: new Date(Date.now() + 1_000).toISOString() }),
      };
    });
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
      getRunStatus,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });

  it('does not carry failed final-check catch-ups into the next business day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T15:59:58.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '0',
      ATTENDANCE_AUTOMATION_RETRY_DELAY_MS: '1000',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    const run = jest.fn().mockRejectedValue(new Error('temporary failure'));
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls.map(([candidate]) => candidate.task)).toEqual([
      'morning-off-duty-check',
      'evening-off-duty-check',
    ]);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });

  it('drops the queued 09:30 catch-up if an earlier startup task finishes after midnight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T15:59:58.000Z'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_ENABLED: 'true',
      ATTENDANCE_AUTOMATION_EFFECTIVE_FROM: '2026-08-28',
      ATTENDANCE_AUTOMATION_STARTUP_DELAY_MS: '1000',
      ATTENDANCE_AUTOMATION_STARTUP_GRACE_MINUTES: '1440',
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
    };
    let finishArchive!: () => void;
    const run = jest
      .fn()
      .mockResolvedValue({ success: true })
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishArchive = resolve;
          }),
      );
    const scheduler = new AttendanceAutomationLocalSchedulerService({
      run,
    } as any);
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls[0][0].task).toBe('archive-yesterday');
    jest.setSystemTime(new Date('2026-09-09T16:00:01.000Z'));
    finishArchive();
    await jest.advanceTimersByTimeAsync(1);
    expect(run.mock.calls.map(([candidate]) => candidate.task)).not.toContain(
      'morning-off-duty-check',
    );
    scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
