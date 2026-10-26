import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { MonthlyAlarmsResponse } from '@shared/monthly-operations-alarms.interface';
import { createMonthlyQuery } from './query-cache';
import { useMonthlyQuery } from './use-monthly-query';
const query = createMonthlyQuery<MonthlyAlarmsResponse>({
  name: 'alarms',
  fetch: async (range, refresh) =>
    (
      await axiosForBackend({
        url: '/api/bitable/monthly-operations-alarms',
        method: 'GET',
        params: { ...range, ...(refresh ? { refresh: '1' } : {}) },
        timeout: 40000,
      })
    ).data,
  validate: (d, r) =>
    d?.range?.start === r.start &&
    d.range?.end === r.end &&
    Array.isArray(d.records) &&
    (d.records.length === 0 || Array.isArray(d.records[0]?.tagIssues)) &&
    !!d.tagReview?.state &&
    ['ready', 'empty', 'stale'].includes(d.status),
  updating: (d) => d.status === 'stale' && d.message === '后台更新中',
});
export const prefetchAlarms = (range: { start: string; end: string }) =>
  query.load(range);
export const useAlarms = (range: { start: string; end: string }) =>
  useMonthlyQuery(query, range);
export const refreshAlarmReview = (range: { start: string; end: string }) =>
  query.load(range, true, false);
