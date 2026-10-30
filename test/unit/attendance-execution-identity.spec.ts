import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AttendanceAutomationCoordinatorService } from '../../server/modules/duty-schedule/attendance-automation-coordinator.service';
import { TodayAttendanceSnapshotService } from '../../server/modules/duty-schedule/today-attendance-snapshot.service';

describe('attendance execution identity without client clock matching', () => {
  const now = new Date('2026-10-30T02:00:10.123Z');
  const run = { task: 'morning-off-duty-check' as const, date: '2026-10-30', scheduledAt: new Date('2026-10-30T01:30:00.000Z') };
  let directory: string, stateFile: string, service: any, execute: jest.Mock;
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(now);
    directory = mkdtempSync(join(tmpdir(), 'attendance-execution-identity-'));
    stateFile = join(directory, 'state.json');
    service = new AttendanceAutomationCoordinatorService({} as never, {} as never, {} as never);
    jest.spyOn(service, 'statePath').mockReturnValue(stateFile);
    service.readAttendanceArchiveJob = jest.fn(() => undefined);
    service.readCorrectionJob = jest.fn(() => undefined);
    service.recoverPendingAttendanceArchives = jest.fn().mockResolvedValue([]);
    service.recoverPendingCorrections = jest.fn().mockResolvedValue([]);
    service.logger.error = jest.fn();
    execute = service.execute = jest.fn().mockResolvedValue({ success: true });
  });
  afterEach(() => {
    jest.useRealTimers(); jest.restoreAllMocks();
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(directory).toContain('attendance-execution-identity-');
    rmSync(directory, { recursive: true });
  });
  it('distinguishes same-millisecond fast runs and keeps a retried request bound to its original completed execution', async () => {
    const first = service.requestManualRetry(run, 'identity-fast-first-001');
    expect(first.executionId).toMatch(/^[a-f0-9-]{36}$/);
    await flush();
    const old = service.getRunStatus(run.task, run.date);
    let finish!: (value: unknown) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const second = service.requestManualRetry(run, 'identity-fast-second-002');
    expect(second.executionId).not.toBe(first.executionId);
    expect(service.getRunStatus(run.task, run.date).lastAttemptAt).toBe(old.lastAttemptAt);
    expect(service.requestManualRetry(run, 'identity-fast-first-001')).toMatchObject({
      duplicate: true, accepted: false, state: 'completed', inProgress: false, executionId: first.executionId,
    });
    finish({ success: true }); await flush();
    expect(service.getRunStatus(run.task, run.date)).toMatchObject({ state: 'completed', executionId: second.executionId });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('joins an existing execution and persists the alias so a retry after completion never starts another run', async () => {
    let finish!: (value: unknown) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = service.requestManualRetry(run, 'identity-join-first-001');
    const joined = service.requestManualRetry(run, 'identity-join-second-002');
    expect(joined).toMatchObject({ accepted: false, duplicate: false, inProgress: true, executionId: first.executionId });
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).manualRetries['identity-join-second-002'].executionId).toBe(first.executionId);
    finish({ success: true }); await flush();
    expect(service.requestManualRetry(run, 'identity-join-second-002')).toMatchObject({ duplicate: true, state: 'completed', executionId: first.executionId });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('preserves an automatic execution ID through failure and generates a new ID on the next real attempt', async () => {
    execute.mockRejectedValueOnce(new Error('synthetic failure'));
    const pending = service.run(run);
    const first = service.getRunStatus(run.task, run.date).executionId;
    await expect(pending).rejects.toThrow('synthetic failure');
    expect(service.getRunStatus(run.task, run.date)).toMatchObject({ state: 'failed', executionId: first });
    await service.run(run);
    const next = service.getRunStatus(run.task, run.date);
    expect(next.state).toBe('completed'); expect(next.executionId).not.toBe(first);
  });
  it('derives a stable identity for legacy running state without rewriting it and preserves that ID on completion', () => {
    const taskKey = service.taskKey(run.task, run.date);
    const legacy = { state: 'running', task: run.task, date: run.date, scheduledAt: run.scheduledAt.toISOString(), lastAttemptAt: now.toISOString() };
    writeFileSync(stateFile, JSON.stringify({ version: 1, completed: {}, runs: { [taskKey]: legacy } }));
    const original = readFileSync(stateFile, 'utf8');
    const first = service.getRunStatus(run.task, run.date).executionId;
    expect(first).toMatch(/^legacy-[a-f0-9]{64}$/);
    expect(service.getRunStatus(run.task, run.date).executionId).toBe(first);
    expect(readFileSync(stateFile, 'utf8')).toBe(original);
    service.markCompleted(taskKey, run, { success: true });
    expect(service.getRunStatus(run.task, run.date)).toMatchObject({ state: 'completed', executionId: first });
  });
  it('keeps a legacy request without a proven execution binding unknown instead of attaching it to the latest result', async () => {
    service.requestManualRetry(run, 'identity-current-run-001'); await flush();
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    state.manualRetries['identity-legacy-request-002'] = { taskKey: service.taskKey(run.task, run.date), task: run.task, date: run.date, requestedAt: now.toISOString() };
    writeFileSync(stateFile, JSON.stringify(state));
    const response = service.requestManualRetry(run, 'identity-legacy-request-002');
    expect(response).not.toHaveProperty('executionId');
    expect(response).toMatchObject({ duplicate: true, accepted: false, state: 'running' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('passes execution ID and task through snapshot formatting even when all display times share one minute', async () => {
    const response = service.requestManualRetry(run, 'identity-snapshot-fast-001'); await flush();
    const snapshotService = new TodayAttendanceSnapshotService({ readArchivedAttendanceSummary: jest.fn().mockResolvedValue({ checkedTasks: [run.task], normalByBuilding: {}, anomalies: [] }) } as never, { read: jest.fn().mockResolvedValue(null) } as never, service);
    const snapshot = await snapshotService.getSnapshot(now);
    expect(snapshot.runStatus).toMatchObject({ task: run.task, state: 'completed', executionId: response.executionId, lastAttemptAt: '2026-10-30 10:00', completedAt: '2026-10-30 10:00' });
  });
});
