import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { WarehouseBuilding } from '@shared/inventory-management.interface';
import type {
  StocktakeCompleteRequest,
  StocktakeGeneration,
  StocktakeGenerationRequest,
  StocktakeLine,
  StocktakeLineRequest,
  StocktakeOverview,
  StocktakeSheet,
  StocktakeWriteRequest,
  StocktakeScope,
  StocktakeBulkRequest,
  StocktakeUndoRequest,
  StocktakeSyncSummary,
  StocktakeBulkTask,
} from '@shared/inventory-stocktake.interface';
const base = '/api/inventory-management/stocktake';
async function read<T>(path: string, params: unknown): Promise<T> {
  const response = await axiosForBackend({
    url: `${base}/${path}`,
    method: 'GET',
    params,
    timeout: 20_000,
  });
  return response.data;
}
async function write<T>(path: string, data: unknown): Promise<T> {
  const response = await axiosForBackend({
    url: `${base}/${path}`,
    method: 'POST',
    data,
    timeout: 20_000,
  });
  return response.data;
}
export const getStocktakeOverview = (month: string) =>
  read<StocktakeOverview>('overview', { month });
export async function getStocktakeSheet(
  month: string,
  building: WarehouseBuilding,
  scope: StocktakeScope = 'sample',
): Promise<StocktakeSheet | null> {
  const sheet = await read<StocktakeSheet | null | ''>('sheet', {
    month,
    building,
    scope,
  });
  // Nest sends an empty HTTP body for null; Axios exposes that body as ''.
  if (sheet === '' || sheet === null) return null;
  if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.lines)) {
    throw new Error('盘点清单返回格式异常，请重试');
  }
  return sheet;
}
export const startStocktake = (request: StocktakeWriteRequest) =>
  write<StocktakeSheet>('start', request);
export const generateStocktake = (request: StocktakeGenerationRequest) =>
  write<StocktakeGeneration>('generate', request);
export const getStocktakeBulkTask = (
  task: Pick<StocktakeBulkTask, 'id' | 'month' | 'building'>,
) =>
  read<StocktakeBulkTask>('bulk-status', {
    id: task.id,
    month: task.month,
    building: task.building,
  });
export async function waitStocktakeBulkTask(
  task: StocktakeBulkTask,
  onProgress?: (task: StocktakeBulkTask) => void,
): Promise<StocktakeSheet> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    onProgress?.(task);
    if (task.status === 'error')
      throw new Error(task.error || '批量确认失败，请保留草稿并重试');
    if (task.status === 'success') {
      const sheet = await getStocktakeSheet(
        task.month,
        task.building,
        'review',
      );
      if (!sheet) throw new Error('批量确认结果读取失败，请重新查询');
      return sheet;
    }
    if (!['queued', 'running'].includes(task.status))
      throw new Error('批量确认任务返回格式异常');
    if (Date.now() >= deadline)
      throw new Error('任务仍在后台处理，请保留草稿并查询原任务结果');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      task = await getStocktakeBulkTask(task);
    } catch {
      throw new Error('任务结果查询失败，原任务继续处理，请保留草稿并重新查询');
    }
  }
}
export async function bulkConfirmStocktake(
  request: StocktakeBulkRequest,
  onProgress?: (task: StocktakeBulkTask) => void,
) {
  let task: StocktakeBulkTask | StocktakeSheet;
  try {
    task = await write<StocktakeBulkTask | StocktakeSheet>(
      'bulk-confirm',
      request,
    );
  } catch (error) {
    // An acceptance response can be lost after the task was durably written.
    try {
      task = await getStocktakeBulkTask({
        ...request,
        id: request.clientMutationId,
      });
    } catch {
      throw error;
    }
  }
  if ('lines' in task && Array.isArray(task.lines))
    return task as StocktakeSheet;
  return waitStocktakeBulkTask(task as StocktakeBulkTask, onProgress);
}
export const undoBulkStocktake = (request: StocktakeUndoRequest) =>
  write<StocktakeSheet>('bulk-undo', request);
export const getStocktakeSync = (
  month: string,
  building: WarehouseBuilding,
  scope: StocktakeScope,
) => read<StocktakeSyncSummary>('sync-status', { month, building, scope });
export const retryStocktakeSync = (request: StocktakeWriteRequest) =>
  write<StocktakeSyncSummary>('retry-sync', request);
export const writeStocktakeLine = (
  mode: 'draft' | 'confirm' | 'refresh-line',
  request: StocktakeLineRequest,
) => write<{ line: StocktakeLine; sheetVersion: number }>(mode, request);
export const completeStocktake = (request: StocktakeCompleteRequest) =>
  write<{ status: 'completed'; version: number; completedAt: string }>(
    'complete',
    request,
  );
