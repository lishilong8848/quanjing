import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  AssessmentKind,
  AssessmentResponse,
} from '@shared/monthly-operations-assessment.interface';
import { createMonthlyQuery } from './query-cache';
import { useMonthlyQuery } from './use-monthly-query';
import type { ReportPeriod } from './period';
export const ASSESSMENT_KINDS: AssessmentKind[] = [
  'risk',
  'drill',
  'event',
  'inspection',
];
const queries = Object.fromEntries(
  ASSESSMENT_KINDS.map((kind) => [
    kind,
    createMonthlyQuery<AssessmentResponse>({
      name: 'assessment-' + kind,
      fetch: async (range, refresh) =>
        (
          await axiosForBackend({
            url: '/api/bitable/monthly-operations-assessment',
            method: 'GET',
            params: { ...range, kind, ...(refresh ? { refresh: '1' } : {}) },
            timeout: 40000,
          })
        ).data,
      validate: (data, range) =>
        data?.kind === kind &&
        data?.range?.start === range.start &&
        data?.range?.end === range.end &&
        Array.isArray(data.records) &&
        ['ready', 'empty', 'stale'].includes(data.status),
      updating: (data) =>
        data.status === 'stale' && data.message === '后台更新中',
    }),
  ]),
) as Record<
  AssessmentKind,
  ReturnType<typeof createMonthlyQuery<AssessmentResponse>>
>;
export const prefetchAssessment = (range: { start: string; end: string }) =>
  Promise.all(ASSESSMENT_KINDS.map((kind) => queries[kind].load(range)));
export function useAssessment(kind: AssessmentKind, period: ReportPeriod) {
  return useMonthlyQuery(queries[kind], period);
}
