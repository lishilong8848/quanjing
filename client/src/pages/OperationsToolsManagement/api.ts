import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { OperationsToolsSnapshot } from '@shared/operations-tools.interface';

export async function getToolsSnapshot(
  refresh = false,
  signal?: AbortSignal,
): Promise<OperationsToolsSnapshot> {
  const result = await axiosForBackend({
    url: '/api/operations-tools/snapshot',
    method: 'GET',
    params: refresh ? { refresh: '1' } : undefined,
    timeout: 15000,
    signal,
  });
  const data = result.data as OperationsToolsSnapshot;
  if (
    !data ||
    !Array.isArray(data.tools) ||
    !Array.isArray(data.flows) ||
    !data.sources
  )
    throw new Error('工具数据返回异常，请重试');
  return data;
}
