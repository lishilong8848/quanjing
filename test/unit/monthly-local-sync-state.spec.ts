import { createLocalScheduleSyncController, type LocalSyncPorts, type LocalSyncState } from '../../client/src/pages/MonthlySchedule/local-schedule-sync';
import type { DutyLocalSyncTaskResponse } from '../../shared/duty-local-sync.interface';

const requestId = '00000000-0000-4000-8000-000000000001', otherId = '00000000-0000-4000-8000-000000000002';
const clock = Date.parse('2026-10-30T03:00:00.000Z');
const notFound = { response: { status: 404 } };
function task(status: DutyLocalSyncTaskResponse['status'] = 'running', extra: Partial<DutyLocalSyncTaskResponse> = {}): DutyLocalSyncTaskResponse {
  return { taskId: 'task-synthetic', requestId, status, phase: status === 'running' ? 'fetching_sources' : 'completed', startedAt: new Date(clock).toISOString(),
    ...(status === 'succeeded' ? { result: { success: true, total: 3, reset: 0, ruleUpdated: 0, localSynced: 3, failed: 0, durationMs: 3000, message: 'ok', scope: 'three_months' as const } } : {}), ...extra };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('monthly local sync: recoverable single submission', () => {
  const instances: Array<ReturnType<typeof createLocalScheduleSyncController>> = [];
  const setup = (shared = new Map<string, string>(), principal = 'principal-a') => {
    const changes: LocalSyncState[] = [];
    const ports = { principal, storage: { getItem: (key: string) => shared.get(key) || null, setItem: (key: string, value: string) => { shared.set(key, value); } },
      createId: jest.fn(() => requestId), create: jest.fn(async () => task()), current: jest.fn(async () => { throw notFound; }), get: jest.fn(async () => task()),
      refresh: jest.fn(async () => ({ schedules: true, sealings: true })), changed: (state: LocalSyncState) => { changes.push(state); }, now: Date.now };
    const controller = createLocalScheduleSyncController(ports); instances.push(controller);
    return { controller, ports, changes, shared, state: () => changes[changes.length - 1] };
  };
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(clock); });
  afterEach(() => { for (const instance of instances.splice(0)) instance.dispose(); jest.clearAllTimers(); jest.useRealTimers(); });

  it('locks synchronously before two same-frame clicks and later clicks only query the running task', async () => {
    const x = setup(), pending = deferred<DutyLocalSyncTaskResponse>(); x.ports.create.mockReturnValue(pending.promise);
    const first = x.controller.trigger(); const second = x.controller.trigger();
    expect(x.state()).toMatchObject({ phase: 'starting', busy: true }); expect(x.ports.create).toHaveBeenCalledTimes(1);
    pending.resolve(task()); await Promise.all([first, second]); await x.controller.trigger();
    expect(x.ports.create).toHaveBeenCalledTimes(1); expect(x.ports.get).toHaveBeenCalledWith('task-synthetic', expect.any(AbortSignal));
  });
  it('keeps an acceptance timeout unknown and recovers the original request without another POST', async () => {
    const x = setup(); x.ports.create.mockRejectedValue({ code: 'ECONNABORTED' });
    await x.controller.trigger(); expect(x.state().phase).toBe('unknown');
    x.ports.current.mockResolvedValue(task() as never); await x.controller.trigger();
    expect(x.ports.current).toHaveBeenCalledWith(requestId, expect.any(AbortSignal)); expect(x.state().phase).toBe('running'); expect(x.ports.create).toHaveBeenCalledTimes(1);
  });
  it('reload recovers a saved task by GET and never submits automatically', async () => {
    const x = setup(); await x.controller.trigger(); x.controller.dispose();
    const reloaded = setup(x.shared); await reloaded.controller.resume();
    expect(reloaded.ports.get).toHaveBeenCalledWith('task-synthetic', expect.any(AbortSignal)); expect(reloaded.ports.create).not.toHaveBeenCalled(); expect(reloaded.state().phase).toBe('running');
  });
  it('a page without saved state discovers a current running task without posting', async () => {
    const x = setup(); x.ports.current.mockResolvedValue(task() as never); await x.controller.resume();
    expect(x.ports.current).toHaveBeenCalledWith(undefined, expect.any(AbortSignal)); expect(x.ports.create).not.toHaveBeenCalled(); expect(x.state().phase).toBe('running');
  });
  it('a current 404 with no recovery stays idle; a lost known task enables only explicit same-request retry', async () => {
    const x = setup(); await x.controller.resume(); expect(x.state().phase).toBe('idle');
    await x.controller.trigger(); x.ports.get.mockRejectedValueOnce(notFound); await x.controller.check();
    expect(x.state().phase).toBe('missing'); await jest.advanceTimersByTimeAsync(30_000); expect(x.ports.create).toHaveBeenCalledTimes(1);
    x.ports.create.mockResolvedValueOnce(task('running', { taskId: 'task-after-restart' })); await x.controller.trigger();
    expect(x.ports.create.mock.calls.map(call => call[0])).toEqual([requestId, requestId]); expect(x.state().task?.taskId).toBe('task-after-restart');
  });
  it('same-ID restart retry drops the old task ID so lost acceptance recovers the new task', async () => {
    const x = setup(); await x.controller.trigger(); x.ports.get.mockRejectedValueOnce(notFound); await x.controller.check();
    x.ports.create.mockRejectedValueOnce({ code: 'ERR_NETWORK' }); await x.controller.trigger();
    x.ports.current.mockResolvedValueOnce(task('running', { taskId: 'task-new' }) as never); await x.controller.check();
    expect(x.state().task?.taskId).toBe('task-new'); expect(x.ports.current).toHaveBeenLastCalledWith(requestId, expect.any(AbortSignal));
  });
  it('accepts task polling whose original request ID differs after server singleflight merging', async () => {
    const x = setup(); await x.controller.trigger(); x.ports.get.mockResolvedValueOnce(task('running', { requestId: otherId })); await x.controller.check();
    expect(x.state().phase).toBe('running'); expect(x.ports.create).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched acceptance request and never marks that response successful', async () => {
    const x = setup(); x.ports.create.mockResolvedValueOnce(task('succeeded', { requestId: otherId })); await x.controller.trigger();
    expect(x.state().phase).toBe('unknown'); expect(x.ports.refresh).not.toHaveBeenCalled();
  });
  it('serializes polling while a slow status GET is unresolved', async () => {
    const x = setup(); await x.controller.trigger(); const pending = deferred<DutyLocalSyncTaskResponse>(); x.ports.get.mockReturnValue(pending.promise);
    await jest.advanceTimersByTimeAsync(2_000); await jest.advanceTimersByTimeAsync(30_000); void x.controller.check();
    expect(x.ports.get).toHaveBeenCalledTimes(1); pending.resolve(task()); await Promise.resolve(); await Promise.resolve();
  });
  it('a genuine running job beyond 180 seconds stays running and never submits again', async () => {
    const x = setup(); await x.controller.trigger(); await jest.advanceTimersByTimeAsync(181_000);
    expect(x.state().phase).toBe('running'); expect(x.ports.create).toHaveBeenCalledTimes(1); expect(x.ports.get.mock.calls.length).toBeGreaterThan(1);
  });
  it('stops automatic polling after repeated read failures but retains recovery for manual checking', async () => {
    const x = setup(); await x.controller.trigger(); x.ports.get.mockRejectedValue({ code: 'ERR_NETWORK' });
    await jest.advanceTimersByTimeAsync(30_000); expect(x.ports.get).toHaveBeenCalledTimes(3); expect(x.state()).toMatchObject({ phase: 'unknown', busy: false });
    x.ports.get.mockResolvedValueOnce(task('succeeded')); await x.controller.check(); expect(x.state().phase).toBe('succeeded'); expect(x.ports.create).toHaveBeenCalledTimes(1);
  });
  it.each([{ schedules: false, sealings: true }, { schedules: true, sealings: false }])('does not report complete page refresh when a reader returns false: %j', async loaded => {
    const x = setup(); x.ports.create.mockResolvedValue(task('succeeded')); x.ports.get.mockResolvedValue(task('succeeded')); x.ports.refresh.mockResolvedValueOnce(loaded);
    await x.controller.trigger(); expect(x.state()).toMatchObject({ phase: 'succeeded', refreshWarning: true }); expect(x.state().message).not.toContain('页面数据已刷新');
    await x.controller.check(); expect(x.ports.refresh).toHaveBeenCalledTimes(1); expect(x.state().message).not.toContain('页面数据已刷新');
    await x.controller.refreshView(); expect(x.ports.refresh.mock.calls.map(call => call[0])).toEqual([true, false]); expect(x.state().refreshWarning).toBe(false); expect(x.ports.create).toHaveBeenCalledTimes(1);
  });
  it('does not refresh or clear page data for a confirmed failed task', async () => {
    const x = setup(); x.ports.create.mockResolvedValue(task('failed', { error: { code: 'LOCAL_SYNC_FAILED', message: '源数据未通过校验' } })); await x.controller.trigger();
    expect(x.state()).toMatchObject({ phase: 'failed', message: '源数据未通过校验' }); expect(x.ports.refresh).not.toHaveBeenCalled();
  });
  it('keeps the same task warning through repeated visibility-style reads until read-only refresh succeeds', async () => {
    const x = setup(); x.ports.create.mockResolvedValue(task('succeeded')); x.ports.get.mockResolvedValue(task('succeeded'));
    x.ports.refresh.mockResolvedValueOnce({ schedules: false, sealings: true }); await x.controller.trigger();
    const warning = x.state().message;
    for (let i = 0; i < 3; i++) { await x.controller.check(); expect(x.state()).toMatchObject({ phase: 'succeeded', refreshWarning: true, message: warning }); }
    expect(x.ports.refresh).toHaveBeenCalledTimes(1); expect(x.ports.create).toHaveBeenCalledTimes(1);
    await x.controller.refreshView(); expect(x.state()).toMatchObject({ refreshWarning: false, message: '近三个月排班已同步，页面数据已刷新。' });
    expect(x.ports.refresh.mock.calls.map(call => call[0])).toEqual([true, false]);
  });
  it('keeps an interrupted completion refresh recoverable instead of marking it already applied', async () => {
    const x = setup(), refresh = deferred<{ schedules: boolean; sealings: boolean }>(); x.ports.create.mockResolvedValue(task('succeeded')); x.ports.refresh.mockReturnValue(refresh.promise);
    const pending = x.controller.trigger(); await Promise.resolve(); await Promise.resolve(); x.controller.dispose(); refresh.resolve({ schedules: false, sealings: false }); await pending;
    const next = setup(x.shared); next.ports.get.mockResolvedValue(task('succeeded')); await next.controller.resume(); expect(next.ports.refresh).toHaveBeenCalledTimes(1);
  });
  it('isolates saved request state by principal and ignores completion after disposal', async () => {
    const x = setup(), pending = deferred<DutyLocalSyncTaskResponse>(); x.ports.create.mockReturnValue(pending.promise); const run = x.controller.trigger(); const count = x.changes.length; x.controller.dispose();
    const next = setup(x.shared, 'principal-b'); await next.controller.resume(); pending.resolve(task('succeeded')); await run;
    expect(x.changes).toHaveLength(count); expect(x.ports.refresh).not.toHaveBeenCalled(); expect(next.ports.get).not.toHaveBeenCalled(); expect(next.state().phase).toBe('idle');
  });
  it('does not issue a mutation if minimal recovery cannot be stored', async () => {
    const x = setup(); x.ports.storage.setItem = () => { throw new Error('storage disabled'); }; await x.controller.trigger();
    expect(x.state().phase).toBe('failed'); expect(x.ports.create).not.toHaveBeenCalled();
  });
  it.each([[401, undefined, '登录状态已过期'], [403, 'csrf token invalid', '页面安全状态已过期'], [403, undefined, '确认权限']] as const)('preserves recovery and stops polling for authorization rejection %s/%s', async (status, data, message) => {
    const x = setup(); await x.controller.trigger(); x.ports.get.mockRejectedValue({ response: { status, data } }); await x.controller.check();
    expect(x.state()).toMatchObject({ phase: 'unknown', message: expect.stringContaining(message) });
    await jest.advanceTimersByTimeAsync(30_000); expect(x.ports.get).toHaveBeenCalledTimes(1); expect(x.ports.create).toHaveBeenCalledTimes(1);
  });
});
