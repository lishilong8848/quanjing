import type { DutyLocalSyncTaskResponse } from '@shared/duty-local-sync.interface';

export type LocalSyncPhase = 'idle' | 'starting' | 'running' | 'unknown' | 'missing' | 'succeeded' | 'failed';
export interface LocalSyncState {
  phase: LocalSyncPhase; busy: boolean; message: string;
  task?: DutyLocalSyncTaskResponse; refreshWarning?: boolean;
}
interface Recovery { version: 1; requestId: string; taskId?: string; startedAt?: string; appliedTaskId?: string }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export interface LocalSyncPorts {
  principal: string;
  storage?: StoragePort;
  createId: () => string;
  create: (requestId: string, signal: AbortSignal) => Promise<DutyLocalSyncTaskResponse>;
  current: (requestId: string | undefined, signal: AbortSignal) => Promise<DutyLocalSyncTaskResponse>;
  get: (taskId: string, signal: AbortSignal) => Promise<DutyLocalSyncTaskResponse>;
  refresh: (invalidate: boolean, signal: AbortSignal) => Promise<{ schedules: boolean; sealings: boolean; cancelled?: boolean }>;
  changed: (state: LocalSyncState) => void;
  now?: () => number;
  hidden?: () => boolean;
}
export const EMPTY_LOCAL_SYNC_STATE: LocalSyncState = { phase: 'idle', busy: false, message: '' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const phaseLabels: Record<string, string> = { fetching_sources: '读取排班数据', validating_snapshot: '核对近三个月数据', writing_local_database: '更新本地排班', publishing_snapshot: '更新页面快照', completed: '已完成', failed: '未完成' };
const statusOf = (error: unknown) => Number((error as { response?: { status?: number } })?.response?.status);

/** A synchronous action gate plus recoverable observation; browser cancellation never cancels the server task. */
export function createLocalScheduleSyncController(ports: LocalSyncPorts) {
  const key = `nantong:local-schedule-sync:v1:${encodeURIComponent(ports.principal)}`;
  const now = ports.now || Date.now;
  let state = { ...EMPTY_LOCAL_SYNC_STATE }, recovery: Recovery | undefined;
  let disposed = false, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
  const controller = new AbortController();
  try {
    const value = JSON.parse(ports.storage?.getItem(key) || 'null') as Recovery | null;
    if (value?.version === 1 && UUID.test(value.requestId) && (!value.taskId || typeof value.taskId === 'string' && value.taskId.length <= 200)) recovery = value;
  } catch { /* A missing or invalid recovery item is never a reason to submit automatically. */ }
  const update = (patch: Partial<LocalSyncState>) => { if (!disposed) { state = { ...state, ...patch }; ports.changed(state); } };
  const persist = () => {
    try { if (!ports.storage || !recovery) return false; ports.storage.setItem(key, JSON.stringify(recovery)); return true; }
    catch { return false; }
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (disposed || failures >= 3 || !['running', 'unknown'].includes(state.phase)) return;
    const age = now() - Date.parse(recovery?.startedAt || '');
    const delay = ports.hidden?.() ? 15_000 : failures || age > 60_000 ? 5_000 : 2_000;
    timer = setTimeout(() => { timer = undefined; void checkStatus(); }, delay);
  };
  const refreshPage = async (invalidate: boolean) => {
    try {
      const loaded = await ports.refresh(invalidate, controller.signal);
      if (disposed || controller.signal.aborted || loaded.cancelled) return false;
      const warning = !loaded.schedules || !loaded.sealings;
      const partial = state.task?.result && !state.task.result.success;
      update({ refreshWarning: warning, message: warning ? partial ? '部分排班未同步，页面数据也未全部刷新，请核对结果后重新读取。' : '近三个月排班已同步，页面部分数据未刷新，请重新读取。'
        : partial ? state.task?.result?.message || '部分排班同步未完成，请核对同步结果。' : '近三个月排班已同步，页面数据已刷新。' });
      return true;
    } catch {
      if (disposed || controller.signal.aborted) return false;
      update({ refreshWarning: true, message: '近三个月排班已同步，页面读取暂时失败，请重新读取。' });
      return true;
    }
  };
  const accept = async (task: DutyLocalSyncTaskResponse, expected: { requestId?: string; taskId?: string }) => {
    if (disposed) return;
    if (!task || typeof task.taskId !== 'string' || !task.taskId || !UUID.test(task.requestId) ||
      !['running', 'succeeded', 'failed'].includes(task.status) || !Number.isFinite(Date.parse(task.startedAt)) ||
      task.status === 'succeeded' && (!task.result || typeof task.result.success !== 'boolean') ||
      expected.requestId && task.requestId !== expected.requestId || expected.taskId && task.taskId !== expected.taskId) throw new Error('TASK_IDENTITY_MISMATCH');
    recovery = { version: 1, requestId: recovery?.requestId || task.requestId, taskId: task.taskId,
      startedAt: task.startedAt, ...(recovery?.appliedTaskId ? { appliedTaskId: recovery.appliedTaskId } : {}) };
    persist(); failures = 0;
    if (task.status === 'running') {
      update({ phase: 'running', task, refreshWarning: false, message: `后台同步中：${phaseLabels[task.phase] || '处理中'}。历史排班保留，可继续使用页面。` });
      return;
    }
    clearTimer();
    if (task.status === 'failed') {
      update({ phase: 'failed', task, refreshWarning: false, message: task.error?.message || '本次同步未完成，现有页面数据已保留，可重试。' });
      return;
    }
    if (recovery.appliedTaskId !== task.taskId) {
      update({ phase: 'succeeded', task, message: '近三个月排班已同步，正在刷新页面数据…' });
      if (await refreshPage(true)) { recovery.appliedTaskId = task.taskId; persist(); }
    } else update({ phase: 'succeeded', task, message: state.refreshWarning ? state.message : task.result?.success === false ? task.result.message || '部分排班同步未完成，请核对结果。' : '近三个月排班同步已完成。' });
  };
  const fail = (error: unknown, discovering = false) => {
    if (disposed) return;
    const status = statusOf(error);
    if (status === 404) {
      clearTimer();
      update(discovering && !recovery ? { ...EMPTY_LOCAL_SYNC_STATE, busy: true } : { phase: 'missing', message: '原同步任务已无法查询，可能已过期或服务已重启。可使用原请求重新同步近三个月，历史数据保留。' });
    } else {
      failures++;
      if (status === 401 || status === 403) failures = 3;
      const response = (error as { response?: { data?: { message?: unknown } | string } })?.response?.data;
      const csrf = status === 403 && /csrf/i.test(typeof response === 'string' ? response : String(response?.message || ''));
      update({ phase: 'unknown', message: status === 401 ? '登录状态已过期，请重新登录后查询同步进度。'
        : csrf ? '页面安全状态已过期，请刷新页面后查询同步进度。'
        : status === 403 ? '当前账号无法查询或发起同步，请确认权限。'
          : '暂时无法确认同步进度，任务可能仍在后台执行。请继续查询，不会重复发起同步。' });
    }
  };
  const exclusive = async (operation: () => Promise<void>) => {
    if (disposed || inFlight) return;
    inFlight = true; clearTimer(); update({ busy: true });
    try { await operation(); }
    finally { inFlight = false; update({ busy: false }); schedule(); }
  };
  async function checkStatus() {
    return exclusive(async () => {
      try {
        const task = recovery?.taskId ? await ports.get(recovery.taskId, controller.signal) : await ports.current(recovery?.requestId, controller.signal);
        await accept(task, recovery?.taskId ? { taskId: recovery.taskId } : { requestId: recovery?.requestId });
      } catch (error) { fail(error, !recovery); }
    });
  }
  async function trigger() {
    if (disposed || inFlight) return;
    if (['running', 'unknown', 'starting'].includes(state.phase)) return checkStatus();
    return exclusive(async () => {
      recovery = { version: 1, requestId: state.phase === 'missing' && recovery ? recovery.requestId : ports.createId() };
      if (!UUID.test(recovery.requestId) || !persist()) { update({ phase: 'failed', message: '无法保存同步进度，本次未提交。请允许浏览器存储后重试。' }); return; }
      update({ phase: 'starting', task: undefined, refreshWarning: false, message: '正在提交近三个月排班同步…' });
      try { await accept(await ports.create(recovery.requestId, controller.signal), { requestId: recovery.requestId }); }
      catch (error) { fail(error); }
    });
  }
  return {
    trigger, check: checkStatus, resume: checkStatus,
    refreshView: () => exclusive(async () => { if (state.phase === 'succeeded') await refreshPage(false); }),
    dispose: () => { disposed = true; clearTimer(); controller.abort(); },
  };
}
