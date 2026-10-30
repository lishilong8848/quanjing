import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttendanceAutomationCoordinatorService } from './attendance-automation-coordinator.service';

describe('attendance interrupted run status', () => {
  let directory: string, service: any, status: any, claim: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'attendance-owner-status-'));
    claim = join(directory, 'claim.json');
    service = new AttendanceAutomationCoordinatorService(null as never, null as never, null as never);
    status = { state: 'running', task: 'morning-off-duty-check', date: '2026-10-30',
      scheduledAt: '2026-10-30T01:30:00Z', firstAttemptAt: '2026-10-30T01:30:00Z',
      lastAttemptAt: '2026-10-30T01:30:00Z', attemptCount: 1, maxAttempts: 6,
      retryCutoffAt: '2026-10-30T02:00:00Z' };
    service.readState = jest.fn(() => ({ completed: {}, runs: { [service.taskKey(status.task, status.date)]: status } }));
    service.claimPath = () => claim;
    service.readAttendanceArchiveJob = () => undefined;
    service.readCorrectionJob = () => undefined;
    service.writeState = jest.fn(() => { throw new Error('status reads must not write'); });
    service.execute = jest.fn(() => { throw new Error('status reads must not start jobs'); });
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T02:10:00Z'));
  });
  afterEach(() => { jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
  const deadOwner = () => jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const read = () => service.getRunStatus(status.task, status.date);
  it('reports a dead owner as interrupted without altering the persisted result or restarting work', () => {
    writeFileSync(claim, JSON.stringify({ pid: process.pid + 100000 }));
    deadOwner(); const before = readFileSync(claim, 'utf8');
    expect(read()).toMatchObject({ state: 'failed', finalFailure: true, failureScope: 'core' });
    expect(status.state).toBe('running');
    expect(readFileSync(claim, 'utf8')).toBe(before);
    expect(service.writeState).not.toHaveBeenCalled(); expect(service.execute).not.toHaveBeenCalled();
  });
  it('does not mistake a live long-running worker for an interrupted task', () => {
    writeFileSync(claim, JSON.stringify({ pid: process.pid + 100000 }));
    jest.spyOn(process, 'kill').mockReturnValue(true);
    expect(read().state).toBe('running');
  });
  it('keeps locally active work running even if the marker cannot be read', () => {
    service.activeTasks.set(service.taskKey(status.task, status.date), new Promise(() => {}));
    expect(read().state).toBe('running');
  });
  it('does not treat an unreadable process owner as dead', () => {
    writeFileSync(claim, JSON.stringify({ pid: process.pid + 100000 }));
    jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(read().state).toBe('running');
  });
  it('does not treat malformed ownership as permission to start another run', () => {
    writeFileSync(claim, '{broken');
    expect(read().state).toBe('running');
  });
  it.each([true, '123', null])('does not coerce malformed PID %p into a confirmed dead process', pid => {
    writeFileSync(claim, JSON.stringify({ pid })); const kill = deadOwner();
    expect(read().state).toBe('running'); expect(kill).not.toHaveBeenCalled();
  });
  it('stops displaying an old ownerless run forever but preserves the start grace period', () => {
    expect(read().state).toBe('failed');
    status.lastAttemptAt = new Date(Date.now() - 30_000).toISOString();
    expect(read().state).toBe('running');
  });
  it('keeps bounded automatic recovery available within its existing retry window', () => {
    writeFileSync(claim, JSON.stringify({ pid: process.pid + 100000 })); deadOwner();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T01:40:00Z'));
    expect(read()).toMatchObject({ state: 'failed', finalFailure: false, nextRetryAt: '2026-10-30T01:40:00.000Z' });
  });
  it('does not authorize automatic recovery of a missing owner even within the retry window', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T01:40:00Z'));
    expect(read()).toMatchObject({ state: 'failed', finalFailure: true, failureReason: expect.stringContaining('无法确认') });
    expect(read().nextRetryAt).toBeUndefined(); expect(service.execute).not.toHaveBeenCalled(); expect(service.writeState).not.toHaveBeenCalled();
  });
  it('never converts a one-attempt manual retry into automatic repeated work', () => {
    writeFileSync(claim, JSON.stringify({ pid: process.pid + 100000 })); deadOwner();
    status.maxAttempts = 1;
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T01:40:00Z'));
    expect(read()).toMatchObject({ state: 'failed', finalFailure: true });
    expect(read().nextRetryAt).toBeUndefined();
  });
  it('preserves completed core results while external archive work continues', () => {
    status.state = 'completed';
    service.readAttendanceArchiveJob = () => ({ stage: 'pending', failureReason: '飞书考勤多维表正在后台同步' });
    expect(read()).toMatchObject({ state: 'completed', archiveSyncState: 'syncing' });
  });
});

