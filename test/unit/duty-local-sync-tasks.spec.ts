import { randomUUID } from 'node:crypto';
import { DutyLocalSyncTasks } from '../../server/modules/duty-schedule/duty-local-sync.task';
import type { DutyLocalSyncResult } from '../../shared/duty-local-sync.interface';

const result: DutyLocalSyncResult = { success: true, total: 3, reset: 0, ruleUpdated: 0, localSynced: 3, failed: 0, durationMs: 183000, message: 'synthetic', scope: 'three_months' };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
describe('process-local schedule sync task recovery', () => {
  it('returns immediately and remains observable beyond the old 180 second browser deadline', async () => {
    let now = 1000, finish!: (value: DutyLocalSyncResult) => void;
    const tasks = new DutyLocalSyncTasks(() => now), run = jest.fn(() => new Promise<DutyLocalSyncResult>(resolve => { finish = resolve; }));
    const requestId = randomUUID(), started = tasks.start(requestId, run);
    expect(started.status).toBe('running'); await settle(); now += 183000;
    expect(tasks.current(requestId)?.status).toBe('running');
    const alias = randomUUID(), second = tasks.start(alias, run);
    expect(second).toMatchObject({ taskId: started.taskId, requestId: alias, status: 'running' });
    expect(run).toHaveBeenCalledTimes(1);
    finish(result); await settle();
    expect(tasks.current(requestId)).toMatchObject({ status: 'succeeded', result });
    expect(tasks.current(alias)).toMatchObject({ taskId: started.taskId, requestId: alias, status: 'succeeded' });
    expect(tasks.current()).toBeUndefined();
    expect(tasks.start(requestId, run).status).toBe('succeeded'); expect(run).toHaveBeenCalledTimes(1);
  });
  it('does not leak source errors and keeps failed request identities idempotent', async () => {
    const tasks = new DutyLocalSyncTasks(), id = randomUUID(), run = jest.fn(async () => { throw Error('Bearer synthetic-private-value'); });
    tasks.start(id, run); await settle();
    expect(tasks.current(id)).toMatchObject({ status: 'failed', phase: 'failed', error: { code: 'LOCAL_SYNC_FAILED' } });
    expect(JSON.stringify(tasks.current(id))).not.toContain('synthetic-private-value');
    tasks.start(id, run); expect(run).toHaveBeenCalledTimes(1);
  });
  it('shows a safe explanation for a known source conflict', async () => {
    const tasks = new DutyLocalSyncTasks(), id = randomUUID();
    tasks.start(id, async phase => { phase('publishing_snapshot'); throw Error('数据在读取期间已变更，请重新读取'); });
    await settle();
    expect(tasks.current(id)?.error?.message).toContain('同步期间排班数据发生变化');
    expect(tasks.current(id)?.error).toMatchObject({ kind: 'source_changed', failedPhase: 'publishing_snapshot' });
  });
  it.each<[Error, string, string]>([
    [Object.assign(new Error('Bearer synthetic-credential'), { code: 'ETIMEDOUT' }), 'source_unavailable', '读取飞书数据超时'],
    [Object.assign(new Error('Bear er synthetic-credential'), { response: { status: 403 } }), 'source_access_denied', '读取权限暂不可用'],
    [new Error('同步来源分页未完整返回'), 'source_incomplete', '排班数据不完整'],
    [Object.assign(new Error('synthetic-credential'), { code: 'ENOSPC' }), 'snapshot_unavailable', '本地排班数据保存或核对未完成'],
  ])('distinguishes a failed source or persistence response without exposing upstream error text', async (cause, kind, message) => {
    const tasks = new DutyLocalSyncTasks(), id = randomUUID();
    tasks.start(id, async () => { throw cause; });
    await settle();
    expect(tasks.current(id)?.error).toMatchObject({ kind, failedPhase: 'fetching_sources', message: expect.stringContaining(message) });
    expect(JSON.stringify(tasks.current(id))).not.toContain('synthetic-credential');
  });
  it('expires only terminal tasks and reports restarted or missing tasks as unknown', async () => {
    let now = 1_000; const tasks = new DutyLocalSyncTasks(() => now, 100), id = randomUUID();
    const task = tasks.start(id, async () => result); await settle(); now += 101;
    expect(tasks.current(id)).toBeUndefined(); expect(tasks.get(task.taskId)).toBeUndefined();
    expect(new DutyLocalSyncTasks().current(id)).toBeUndefined();
    expect(tasks.start(id, async () => result).taskId).not.toBe(task.taskId); await settle();
  });
});
