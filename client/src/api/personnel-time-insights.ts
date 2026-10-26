import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { PersonnelTimeInsightsResponse } from '@shared/personnel-time-insights.interface';

export async function getPersonnelTimeInsights(
  from: string,
  through: string,
  signal?: AbortSignal,
): Promise<PersonnelTimeInsightsResponse> {
  const response = await axiosForBackend({
    url: '/api/personnel-time-insights',
    method: 'GET',
    params: { from, through },
    timeout: 15_000,
    signal,
  });
  return response.data;
}
