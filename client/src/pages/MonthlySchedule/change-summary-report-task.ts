import type {
  ChangeSummaryReportAbandonRequest,
  ChangeSummaryReportAbandonResponse,
  ChangeSummaryReportCreateResponse,
  ChangeSummaryReportSyncTaskResponse,
} from '@shared/change-summary-report';
import type { ChangeSummaryReportRecoveryBinding } from './change-summary-report-recovery';

export type ChangeSummaryReportTaskStatusResponse =
  ChangeSummaryReportSyncTaskResponse;

export interface ChangeSummaryReportExpectedTaskIdentity {
  taskId: string;
  clientMutationId: string;
  changeRecordId: string;
}

export class ChangeSummaryReportTaskFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeSummaryReportTaskFailedError';
  }
}

export class ChangeSummaryReportTaskIdentityError extends Error {
  constructor(message = '服务端返回了不匹配的变更总结任务') {
    super(message);
    this.name = 'ChangeSummaryReportTaskIdentityError';
  }
}

interface PollChangeSummaryReportTaskOptions {
  intervalMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

interface CoordinateChangeSummaryReportAcceptancePorts {
  persist: (binding: ChangeSummaryReportRecoveryBinding) => boolean;
  onPrepared: () => void;
  create: (
    request: ChangeSummaryReportRecoveryBinding['request'],
  ) => Promise<ChangeSummaryReportCreateResponse>;
}

interface AbandonFailedChangeSummaryReportPorts {
  abandon: (
    request: ChangeSummaryReportAbandonRequest,
  ) => Promise<ChangeSummaryReportAbandonResponse>;
  removeRecovery: (clientMutationId: string) => boolean;
  createMutationId: () => string;
}

export interface ChangeSummaryReportTaskRuntime {
  controller: AbortController;
}

export interface ChangeSummaryReportAbandonOperation {
  fingerprint: string;
  mutationId: string;
  token: number;
}

export function isCurrentChangeSummaryReportTaskRuntime<
  Runtime extends ChangeSummaryReportTaskRuntime,
>(
  currentPrincipalFingerprint: string | null,
  taskPrincipalFingerprint: string,
  runtimes: ReadonlyMap<string, Runtime>,
  clientMutationId: string,
  runtime: Runtime,
): boolean {
  return (
    currentPrincipalFingerprint === taskPrincipalFingerprint &&
    runtimes.get(clientMutationId) === runtime
  );
}

export function isCurrentChangeSummaryReportAbandonOperation(
  currentPrincipalFingerprint: string | null,
  currentOperation: ChangeSummaryReportAbandonOperation | null,
  expectedOperation: ChangeSummaryReportAbandonOperation,
): boolean {
  return (
    currentPrincipalFingerprint === expectedOperation.fingerprint &&
    currentOperation?.fingerprint === expectedOperation.fingerprint &&
    currentOperation.mutationId === expectedOperation.mutationId &&
    currentOperation.token === expectedOperation.token
  );
}

export class ChangeSummaryReportCleanupPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeSummaryReportCleanupPendingError';
  }
}

export async function coordinateChangeSummaryReportAcceptance(
  binding: ChangeSummaryReportRecoveryBinding,
  ports: CoordinateChangeSummaryReportAcceptancePorts,
): Promise<{
  response: ChangeSummaryReportCreateResponse;
  binding: ChangeSummaryReportRecoveryBinding;
  recoveryPersisted: boolean;
}> {
  if (!ports.persist(binding)) {
    throw new Error('无法保存恢复草稿，本次未提交');
  }
  ports.onPrepared();
  const response = await ports.create(binding.request);
  if (!response.success) {
    throw new Error(response.message || '变更总结未能受理');
  }
  if (
    !response.taskId ||
    response.clientMutationId !== binding.request.clientMutationId ||
    response.changeRecordId !== binding.request.changeRecordId
  ) {
    throw new ChangeSummaryReportTaskIdentityError();
  }
  const acceptedBinding: ChangeSummaryReportRecoveryBinding = {
    ...binding,
    state: 'pending',
    taskId: response.taskId,
    error: undefined,
  };
  return {
    response,
    binding: acceptedBinding,
    recoveryPersisted: ports.persist(acceptedBinding),
  };
}

export async function pollChangeSummaryReportTask(
  expected: ChangeSummaryReportExpectedTaskIdentity,
  getStatus: (
    taskId: string,
    signal?: AbortSignal,
  ) => Promise<ChangeSummaryReportTaskStatusResponse>,
  options: PollChangeSummaryReportTaskOptions = {},
): Promise<ChangeSummaryReportTaskStatusResponse> {
  const intervalMs = Math.max(0, options.intervalMs ?? 1_500);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 80);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    const response = await getStatus(expected.taskId, options.signal);
    if (
      response.taskId !== expected.taskId ||
      response.clientMutationId !== expected.clientMutationId ||
      response.changeRecordId !== expected.changeRecordId
    ) {
      throw new ChangeSummaryReportTaskIdentityError();
    }
    if (response.status === 'completed') return response;
    if (response.status === 'failed') {
      throw new ChangeSummaryReportTaskFailedError(
        response.error || response.message || '变更总结同步失败',
      );
    }
    if (attempt + 1 < maxAttempts) {
      await wait(intervalMs, options.signal);
    }
  }

  throw new Error('变更总结后台同步超时，已恢复原填写内容');
}

export async function abandonFailedChangeSummaryReport(
  binding: ChangeSummaryReportRecoveryBinding,
  ports: AbandonFailedChangeSummaryReportPorts,
): Promise<string> {
  if (binding.state !== 'failed' && binding.state !== 'cleanup-required') {
    throw new Error('只能放弃已明确失败的变更总结');
  }
  const request = {
    clientMutationId: binding.request.clientMutationId,
    changeRecordId: binding.request.changeRecordId,
    submitterName: binding.request.submitterName,
  };
  const response = await ports.abandon(request);
  if (
    response.clientMutationId !== request.clientMutationId ||
    response.changeRecordId !== request.changeRecordId
  ) {
    throw new ChangeSummaryReportTaskIdentityError();
  }
  if (!response.abandoned) {
    throw new ChangeSummaryReportCleanupPendingError(
      response.message || '清理尚未完成，请继续处理',
    );
  }
  if (!ports.removeRecovery(request.clientMutationId)) {
    throw new ChangeSummaryReportCleanupPendingError(
      '清理已完成，但页面状态未能更新，请刷新后继续处理',
    );
  }
  return ports.createMutationId();
}

export function disposeChangeSummaryReportTaskRuntimes<
  Runtime extends ChangeSummaryReportTaskRuntime,
>(
  runtimes: Map<string, Runtime>,
  dismissToast: (clientMutationId: string) => void,
): void {
  runtimes.forEach((runtime, clientMutationId) => {
    runtime.controller.abort();
    dismissToast(clientMutationId);
  });
  runtimes.clear();
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs === 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error('变更总结后台同步已取消'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('变更总结后台同步已取消');
  }
}
