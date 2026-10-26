import { createContext, useContext, type ReactNode } from 'react';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { MonthlyOperationsResourcesResponse } from '@shared/monthly-operations-resources.interface';
import type { ReportPeriod } from './period';
import { createMonthlyQuery } from './query-cache';
import { useMonthlyQuery } from './use-monthly-query';

type ResourceState = {
  key: string;
  data: MonthlyOperationsResourcesResponse | null;
  status: 'loading' | 'ready' | 'error';
  error?: string;
};
function resourceRequestTimeoutMs(range: { start: string; end: string }) {
  const days =
    (Date.parse(`${range.end}T00:00:00Z`) -
      Date.parse(`${range.start}T00:00:00Z`)) /
      86400000 +
    1;
  return days > 62 ? 70000 : 40000;
}
const sources = [
  'racks',
  'rackMovements',
  'energy',
  'weather',
  'water',
  'load',
] as const;
const resourcesQuery = createMonthlyQuery<MonthlyOperationsResourcesResponse>({
  name: 'resources-pue-fields-v4',
  fetch: async (range, refresh) =>
    (
      await axiosForBackend({
        url: '/api/bitable/monthly-operations-resources',
        method: 'GET',
        params: { ...range, ...(refresh ? { refresh: '1' } : {}) },
        timeout: resourceRequestTimeoutMs(range),
      })
    ).data,
  validate: (data, range) =>
    data?.range?.start === range.start &&
    data?.range?.end === range.end &&
    Array.isArray(data.racks?.rows) &&
    Array.isArray(data.rackMovements?.rows) &&
    Array.isArray(data.energy?.days) &&
    Array.isArray(data.weather?.days) &&
    Array.isArray(data.water?.days) &&
    Array.isArray(data.load?.rows) &&
    sources.some((s) => data[s].status !== 'error'),
  updating: (data) =>
    sources.some(
      (s) => data[s].status === 'stale' && data[s].message === '后台更新中',
    ),
});
const ResourceContext = createContext<
  (ResourceState & { retry: () => void }) | null
>(null);
export const prefetchResources = (range: { start: string; end: string }) =>
  resourcesQuery.load(range);
export function ResourceProvider({
  period,
  children,
}: {
  period: ReportPeriod;
  children: ReactNode;
}) {
  const query = useMonthlyQuery(resourcesQuery, period);
  return (
    <ResourceContext.Provider
      value={{
        ...query,
        status: query.loading ? 'loading' : query.error ? 'error' : 'ready',
      }}
    >
      {children}
    </ResourceContext.Provider>
  );
}
export function useResourceData() {
  const context = useContext(ResourceContext);
  if (!context) throw new Error('月览数据区域缺少 Provider');
  return context;
}
