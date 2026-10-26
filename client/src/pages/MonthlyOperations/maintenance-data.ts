import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  MaintenanceResponse,
  MaintenanceType,
} from '@shared/monthly-operations-maintenance.interface';
import { createMonthlyQuery } from './query-cache';
import { useMonthlyQuery } from './use-monthly-query';
import type { ReportPeriod } from './period';
const query = (kind: MaintenanceType) =>
  createMonthlyQuery<MaintenanceResponse>({
    name: 'maintenance-' + kind,
    fetch: async (range, refresh) =>
      (
        await axiosForBackend({
          url: '/api/bitable/monthly-operations-maintenance',
          method: 'GET',
          params: { ...range, kind, ...(refresh ? { refresh: '1' } : {}) },
          timeout: 40000,
        })
      ).data,
    validate: (d, r) =>
      d?.kind === kind &&
      d.range?.start === r.start &&
      d.range?.end === r.end &&
      Array.isArray(d.records) &&
      ['ready', 'empty', 'stale'].includes(d.status),
    updating: (d) => d.status === 'stale' && d.message === '后台更新中',
  });
const queries = { planned: query('planned'), unplanned: query('unplanned') };
export const prefetchMaintenance = (range: { start: string; end: string }) =>
  Promise.all(Object.values(queries).map((q) => q.load(range)));
export function useMaintenance(kind: MaintenanceType, period: ReportPeriod) {
  return useMonthlyQuery(queries[kind], period);
}
