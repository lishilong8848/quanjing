import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  MonthlyEventReviewReportContent,
  MonthlyEventsResponse,
} from '@shared/monthly-operations-events.interface';
import type { ReportPeriod } from './period';
import { createMonthlyQuery } from './query-cache';
import { useMonthlyQuery } from './use-monthly-query';

const eventsQuery = createMonthlyQuery<MonthlyEventsResponse>({
  name: 'events',
  fetch: async (range, refresh) =>
    (
      await axiosForBackend({
        url: '/api/bitable/monthly-operations-events',
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
  updating: (data) => data.status === 'stale' && data.message === '后台更新中',
});
export const prefetchEvents = eventsQuery.load;
export function useEvents(period: ReportPeriod) {
  return useMonthlyQuery(eventsQuery, period);
}

export async function fetchEventReviewReport(
  eventId: string,
  reportIndex: number,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/bitable/monthly-operations-event-report?eventId=${encodeURIComponent(eventId)}&reportIndex=${reportIndex}`,
    { signal },
  );
  const data = (await response.json().catch(() => null)) as
    | MonthlyEventReviewReportContent
    | { message?: string }
    | null;
  if (!response.ok)
    throw new Error(data?.message || '复盘报告读取失败，请重试');
  return data as MonthlyEventReviewReportContent;
}
