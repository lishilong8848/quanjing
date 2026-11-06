import { randomUUID } from 'node:crypto';
import type { DutyLocalSyncResult, DutyLocalSyncTaskResponse } from '../../../shared/duty-local-sync.interface';

type Run = (phase: (value: string) => void) => Promise<DutyLocalSyncResult>;
interface Task { value: DutyLocalSyncTaskResponse; requests: Set<string>; promise: Promise<DutyLocalSyncResult>; }
export const validDutyLocalSyncId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Classify only known errors; never expose upstream messages or credentials to the browser. */
export function describeDutyLocalSyncFailure(error: unknown): { kind: string; retryable: boolean; message: string } {
  const message = error instanceof Error ? error.message : '';
  if (message === '数据在读取期间已变更，请重新读取' || message === '排班来源已变化，请重新同步' || message === 'LOCAL_SYNC_SNAPSHOT_INVALIDATED') {
    return { kind: 'source_changed', retryable: true, message: '同步期间排班数据发生变化，未覆盖现有数据，请稍后重试。' };
  }
  if (message === '排班及审批快照尚未完整保存') {
    return { kind: 'approval_snapshot_unavailable', retryable: true, message: '排班或请休假数据尚未完整就绪，现有数据已保留，请稍后重试。' };
  }
  if (message === '本地数据缓存保存失败，请稍后重试' || message === '排班本地快照核对失败') {
    return { kind: 'snapshot_unavailable', retryable: true, message: '本地排班数据保存或核对未完成，现有数据已保留，请稍后重试。' };
  }
  return { kind: 'unknown', retryable: false, message: '数据同步未完成，现有数据已保留，请稍后重试。' };
}

/** Process-local tasks only. Expired/restarted task IDs must be reported as unknown. */
export class DutyLocalSyncTasks {
  private readonly tasks = new Map<string, Task>();
  private readonly requests = new Map<string, string>();
  private active?: Task;
  constructor(private readonly now = () => Date.now(), private readonly retentionMs = 30 * 60_000) {}

  start(requestId: string, run: Run): DutyLocalSyncTaskResponse {
    this.prune();
    const known = this.requests.get(requestId);
    if (known) return this.snapshot(this.tasks.get(known)!, requestId);
    if (this.requests.size >= 1_000) throw new Error('LOCAL_SYNC_TASK_CAPACITY');
    let task = this.active;
    if (!task) {
      if (this.tasks.size >= 100) {
        const oldest = this.tasks.values().next().value as Task | undefined;
        if (oldest && oldest !== this.active) this.remove(oldest);
      }
      const value: DutyLocalSyncTaskResponse = { taskId: randomUUID(), requestId, status: 'running', phase: 'fetching_sources', startedAt: new Date(this.now()).toISOString() };
      task = { value, requests: new Set(), promise: undefined! };
      const current = task;
      this.tasks.set(value.taskId, current);
      this.active = current;
      current.promise = Promise.resolve().then(() => run(phase => { if (current.value.status === 'running') current.value.phase = phase; })).then(result => {
        if (!result.success) throw new Error('LOCAL_SYNC_INCOMPLETE');
        current.value.result = result;
        current.value.status = 'succeeded';
        current.value.phase = 'completed';
        return result;
      }).catch(error => {
        current.value.status = 'failed';
        current.value.phase = 'failed';
        current.value.error = { code: 'LOCAL_SYNC_FAILED', message: describeDutyLocalSyncFailure(error).message };
        throw error;
      }).finally(() => {
        current.value.finishedAt = new Date(this.now()).toISOString();
        if (this.active === current) this.active = undefined;
      });
      void current.promise.catch(() => undefined);
    }
    task.requests.add(requestId);
    this.requests.set(requestId, task.value.taskId);
    return this.snapshot(task, requestId);
  }

  current(requestId?: string): DutyLocalSyncTaskResponse | undefined {
    this.prune();
    const task = requestId ? this.tasks.get(this.requests.get(requestId) || '') : this.active;
    return task && this.snapshot(task, requestId);
  }
  get(taskId: string): DutyLocalSyncTaskResponse | undefined {
    this.prune();
    const task = this.tasks.get(taskId);
    return task && this.snapshot(task);
  }
  private snapshot(task: Task, requestId = task.value.requestId): DutyLocalSyncTaskResponse { return structuredClone({ ...task.value, requestId }); }
  private remove(task: Task): void { this.tasks.delete(task.value.taskId); for (const id of task.requests) this.requests.delete(id); }
  private prune(): void { for (const task of this.tasks.values()) if (task !== this.active && task.value.finishedAt && this.now() - Date.parse(task.value.finishedAt) >= this.retentionMs) this.remove(task); }
}
