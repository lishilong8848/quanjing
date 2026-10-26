import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  ThresholdCommand,
  ThresholdMutationResult,
  ThresholdSnapshot,
  ThresholdSourceSync,
} from '@shared/threshold-management.interface';

export async function getThresholds(
  signal: AbortSignal,
  force = false,
): Promise<ThresholdSnapshot> {
  const { data } = await axiosForBackend({
    url: '/api/threshold-management/records',
    method: 'GET',
    signal,
    timeout: 15000,
    params: { force },
  });
  if (
    !data ||
    !Array.isArray(data.records) ||
    !Number.isSafeInteger(data.revision)
  )
    throw new Error('阈值数据返回异常，请重试');
  return data;
}
export async function mutateThreshold(
  command: ThresholdCommand,
): Promise<ThresholdMutationResult> {
  const { data } = await axiosForBackend({
    url: '/api/threshold-management/mutations',
    method: 'POST',
    data: command,
    timeout: 15000,
  });
  if (
    !data ||
    data.clientMutationId !== command.clientMutationId ||
    data.operation !== command.operation ||
    !data.id ||
    !Number.isSafeInteger(data.revision) ||
    (command.operation !== 'delete' && !data.record?.id)
  )
    throw new Error('保存结果未确认，请重试');
  return data;
}
export function thresholdError(error: unknown): string {
  const value = error as {
    response?: { data?: { message?: string; error?: { message?: string } } };
    code?: string;
    message?: string;
  };
  if (value.code === 'ECONNABORTED' || value.code === 'ERR_NETWORK')
    return '连接超时或断开，保存结果未确认，请重试';
  return (
    value.response?.data?.error?.message ||
    value.response?.data?.message ||
    value.message ||
    '阈值同步失败，请重试'
  );
}
export function isUncertainThresholdError(error: unknown) {
  const value = error as { response?: { status?: number } };
  return !value.response?.status || value.response.status >= 500;
}
export async function getThresholdSync(
  ids: string[],
  signal: AbortSignal,
): Promise<ThresholdMutationResult[]> {
  const { data } = await axiosForBackend({
    url: '/api/threshold-management/sync',
    method: 'GET',
    params: { ids: ids.join(',') },
    signal,
    timeout: 10000,
  });
  if (
    !Array.isArray(data) ||
    data.length !== ids.length ||
    data.some(
      (result) =>
        !ids.includes(result.clientMutationId) ||
        !result.sync ||
        !['pending', 'success', 'error', 'cancelled'].includes(
          result.sync.state,
        ),
    )
  )
    throw new Error('同步状态返回异常，请重试');
  return data;
}
export async function retryThresholdSync(
  clientMutationId: string,
): Promise<ThresholdMutationResult> {
  const { data } = await axiosForBackend({
    url: '/api/threshold-management/sync/retry',
    method: 'POST',
    data: { clientMutationId },
    timeout: 10000,
  });
  if (data?.clientMutationId !== clientMutationId || !data.sync)
    throw new Error('同步任务未确认，请重试');
  return data;
}
export async function getThresholdSource(
  signal: AbortSignal,
): Promise<{ sourceSync: ThresholdSourceSync; revision: number }> {
  const { data } = await axiosForBackend({
    url: '/api/threshold-management/sync/source',
    method: 'GET',
    signal,
    timeout: 10000,
  });
  if (
    !data?.sourceSync ||
    !['loading', 'ready', 'error'].includes(data.sourceSync.state) ||
    !Number.isSafeInteger(data.revision)
  )
    throw new Error('数据状态返回异常，请重试');
  return data;
}
export async function acceptThresholdCloud(
  clientMutationId: string,
): Promise<ThresholdMutationResult> {
  const { data } = await axiosForBackend({
    url: '/api/threshold-management/sync/accept-cloud',
    method: 'POST',
    data: { clientMutationId },
    timeout: 15000,
  });
  if (
    data?.clientMutationId !== clientMutationId ||
    data.sync?.state !== 'cancelled' ||
    !Number.isSafeInteger(data.revision)
  )
    throw new Error('云端结果未确认，请重试');
  return data;
}
