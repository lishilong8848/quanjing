import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { MonthlyChangesResponse } from '@shared/monthly-operations-changes.interface';
import type { ZhihangProgressResponse } from '@shared/monthly-operations-progress.interface';
import type { ReportPeriod } from './period';
import { createMonthlyQuery } from './query-cache';
import { useMonthlyQuery } from './use-monthly-query';

function sourceQuery<
  T extends MonthlyChangesResponse | ZhihangProgressResponse,
>(source: 'changes' | 'progress') {
  return createMonthlyQuery<T>({
    name: source,
    fetch: async (range, refresh) =>
      (
        await axiosForBackend({
          url: '/api/bitable/monthly-operations-' + source,
          method: 'GET',
          params: { ...range, ...(refresh ? { refresh: '1' } : {}) },
          timeout: 40000,
        })
      ).data,
    validate: (data, range) =>
      data?.range?.start === range.start &&
      data?.range?.end === range.end &&
      Array.isArray(data.records) &&
      ['ready', 'empty', 'stale'].includes(data.status),
    updating: (data) =>
      data.status === 'stale' && data.message === '后台更新中',
  });
}
const changesQuery = sourceQuery<MonthlyChangesResponse>('changes');
const progressQuery = sourceQuery<ZhihangProgressResponse>('progress');
export const prefetchChanges = changesQuery.load;
export const prefetchProgress = progressQuery.load;
export function useChanges(period: ReportPeriod) {
  return useMonthlyQuery(changesQuery, period);
}
export function useZhihangProgress(period: ReportPeriod) {
  return useMonthlyQuery(progressQuery, period);
}
