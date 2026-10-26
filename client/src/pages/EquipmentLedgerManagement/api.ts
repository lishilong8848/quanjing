import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  EquipmentHistoryState,
  EquipmentHistoryDevicesState,
} from '@shared/equipment-history.interface';
import type { EquipmentLifecycleDashboardResponse } from '@shared/equipment-lifecycle.interface';
import type {
  LedgerDashboard,
  LedgerDashboardState,
  LedgerLifecycle,
  LedgerPage,
  LedgerQuery,
} from '@shared/equipment-ledger.interface';

async function get<T>(
  path: string,
  params: Record<string, unknown> | LedgerQuery,
  signal: AbortSignal,
): Promise<T> {
  const result = await axiosForBackend({
    url: `/api/equipment-ledger/${path}`,
    method: 'GET',
    params,
    timeout: 30000,
    signal,
  });
  if (!result.data || typeof result.data !== 'object')
    throw new Error('设备数据返回异常，请重试');
  return result.data as T;
}
export async function getLedgerDashboardState(
  refresh: boolean,
  signal: AbortSignal,
): Promise<LedgerDashboardState> {
  const value = await get<LedgerDashboardState>(
    'dashboard',
    { async: '1', ...(refresh ? { refresh: '1' } : {}) },
    signal,
  );
  if (
    !['loading', 'ready', 'error'].includes(value.status) ||
    typeof value.refreshing !== 'boolean' ||
    (value.status === 'ready' &&
      (!value.dashboard?.snapshotId ||
        !value.dashboard.overview?.metrics ||
        !Array.isArray(value.dashboard.buildings) ||
        ![value.dashboard.overview, ...value.dashboard.buildings].every(
          (summary) =>
            Array.isArray(summary.families) && Array.isArray(summary.systems),
        )))
  )
    throw new Error('设备读取状态返回异常');
  return value;
}
export async function getLedgerDashboard(
  refresh: boolean,
  signal: AbortSignal,
): Promise<LedgerDashboard> {
  const value = await get<LedgerDashboard>(
    'dashboard',
    refresh ? { refresh: '1' } : {},
    signal,
  );
  if (
    !value.snapshotId ||
    !value.overview?.metrics ||
    !Array.isArray(value.buildings) ||
    !Array.isArray(value.overview.categories) ||
    !Array.isArray(value.overview.models) ||
    ![value.overview, ...value.buildings].every(
      (summary) =>
        Array.isArray(summary.families) && Array.isArray(summary.systems),
    )
  )
    throw new Error('设备汇总数据返回异常');
  return value;
}
export async function getLedgerItems(
  query: LedgerQuery,
  signal: AbortSignal,
): Promise<LedgerPage> {
  const value = await get<LedgerPage>('items', query, signal);
  if (
    !value.snapshotId ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.total) ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.totalPages) ||
    value.page < 1 ||
    value.totalPages < 1
  )
    throw new Error('设备清单返回异常');
  return value;
}
export async function getLedgerLifecycle(
  signal: AbortSignal,
): Promise<LedgerLifecycle> {
  const value = await get<LedgerLifecycle>('lifecycle', {}, signal);
  if (
    !Array.isArray(value.assets) ||
    !Array.isArray(value.maintenanceContracts) ||
    !Array.isArray(value.longTermMaintenance) ||
    !Array.isArray(value.keyParts)
  )
    throw new Error('维护信息返回异常');
  return value;
}

export async function getLedgerLifecycleDashboard(
  options: { refresh?: boolean; building?: string } = {},
): Promise<EquipmentLifecycleDashboardResponse> {
  let value: EquipmentLifecycleDashboardResponse;
  try {
    value = await get<EquipmentLifecycleDashboardResponse>(
      'lifecycle-dashboard',
      {
        building: options.building,
        ...(options.refresh ? { refresh: '1' } : {}),
      },
      new AbortController().signal,
    );
  } catch (error: unknown) {
    const failure = error as { code?: string; response?: { status?: number } };
    const status = failure?.response?.status;
    throw new Error(
      status === 401
        ? '登录已失效，请重新登录'
        : status === 403
          ? '无生命周期查看权限'
          : ['ECONNABORTED', 'ETIMEDOUT'].includes(failure?.code || '')
            ? '生命周期读取超时，请重试'
            : '生命周期读取失败，请重试',
    );
  }
  if (!value.summary || !Array.isArray(value.assets) || !value.relatedRecords)
    throw new Error('生命周期数据返回异常，请重试');
  return value;
}

export async function getEquipmentHistoryState(
  assetId: string,
  refresh: boolean,
  signal: AbortSignal,
): Promise<EquipmentHistoryState> {
  const value = await get<EquipmentHistoryState>(
    'history',
    { assetId, ...(refresh ? { refresh: '1' } : {}) },
    signal,
  );
  if (
    value.assetId !== assetId ||
    !['loading', 'ready', 'error'].includes(value.status) ||
    typeof value.refreshing !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.some(
      (item) =>
        !item.id ||
        typeof item.status !== 'string' ||
        typeof item.fault !== 'string',
    )
  )
    throw new Error('机历信息返回异常，请重试');
  return value;
}

export async function getEquipmentHistoryDevices(
  refresh: boolean,
  signal: AbortSignal,
): Promise<EquipmentHistoryDevicesState> {
  const value = await get<EquipmentHistoryDevicesState>(
    'history-devices',
    refresh ? { refresh: '1' } : {},
    signal,
  );
  if (
    !['loading', 'ready', 'error'].includes(value.status) ||
    !Array.isArray(value.devices) ||
    typeof value.refreshing !== 'boolean'
  )
    throw new Error('维修设备读取失败，请重试');
  return value;
}
