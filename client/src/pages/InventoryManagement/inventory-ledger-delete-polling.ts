import type { InventoryLedgerDeletionRequest, InventoryLedgerDeletionTask } from '@shared/inventory-ledger-deletion.interface';

export interface LedgerDeleteJournal {
  request: InventoryLedgerDeletionRequest;
  status: InventoryLedgerDeletionTask['status'] | 'submitting';
  task?: InventoryLedgerDeletionTask;
}

const statuses = ['pending', 'running', 'completed', 'failed', 'uncertain'];
export function validLedgerDeleteTask(value: unknown, request: InventoryLedgerDeletionRequest): value is InventoryLedgerDeletionTask {
  const task = value as InventoryLedgerDeletionTask | null;
  return !!task && task.clientMutationId === request.clientMutationId && task.recordId === request.recordId &&
    statuses.includes(task.status) && typeof task.message === 'string';
}

/** A legacy failed journal cannot prove that starting a new operation is safe. */
export function ledgerDeleteRequestMode(journal: LedgerDeleteJournal | null): 'new' | 'retry' | 'inspect' | 'completed' {
  if (!journal) return 'new';
  if (journal.status === 'completed') return 'completed';
  if (journal.status === 'uncertain') return 'inspect';
  if (journal.status !== 'failed') return 'retry';
  if (!validLedgerDeleteTask(journal.task, journal.request) || journal.task.status !== 'failed' || journal.task.definitelyNotDeleted !== true) return 'inspect';
  if (journal.task.retryable === true) return 'retry';
  return journal.task.retryable === false ? 'new' : 'inspect';
}

const stageLabels: Record<string, string> = {
  'validating-source': '核对删除权限', 'reading-record': '读取库存台账', 'reading-catalog': '核对物品类别',
  'checking-latest': '核对最新库存', deleting: '正在删除', reconciling: '核对删除结果', completed: '删除完成',
};
export function ledgerDeleteTaskMessage(task: InventoryLedgerDeletionTask): string {
  const stage = task.stage && stageLabels[task.stage];
  const parts = [stage && !task.message.includes(stage) ? stage : '', task.message];
  if (task.nextAttemptAt && ['pending', 'running'].includes(task.status) && !task.message.includes('自动重试'))
    parts.push(`将自动重试（${task.retryCount || 0}/2）`);
  return parts.filter(Boolean).join(' · ');
}

/** A replacement read invalidates both the old response and its next timer. */
export function createLedgerDeletePolling(options: {
  read(request: InventoryLedgerDeletionRequest, signal: AbortSignal): Promise<InventoryLedgerDeletionTask>;
  task(request: InventoryLedgerDeletionRequest, task: InventoryLedgerDeletionTask): void;
  error(error: unknown): void;
  waiting?(request: InventoryLedgerDeletionRequest, task: InventoryLedgerDeletionTask): void;
}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const stop = () => {
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };
  const read = async (request: InventoryLedgerDeletionRequest, selected: number, attempt: number) => {
    if (selected !== generation) return;
    const pending = new AbortController(); controller = pending;
    try {
      const task = await options.read(request, pending.signal);
      if (selected !== generation || pending.signal.aborted) return;
      if (!validLedgerDeleteTask(task, request)) throw new Error('删除状态返回异常');
      options.task(request, task);
      if (selected === generation && ['pending', 'running', 'uncertain'].includes(task.status)) {
        if (attempt < 60)
          timer = setTimeout(() => { timer = undefined; void read(request, selected, attempt + 1); }, Math.min(1000 * (attempt + 1), 5000));
        else options.waiting?.(request, task);
      }
    } catch (error) {
      if (selected === generation && !pending.signal.aborted) options.error(error);
    } finally {
      if (controller === pending) controller = undefined;
    }
  };
  return { stop, start(request: InventoryLedgerDeletionRequest) { stop(); void read(request, generation, 0); } };
}
