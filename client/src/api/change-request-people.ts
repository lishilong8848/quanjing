import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { ChangeRequestPeopleResponse } from '@shared/change-request';

export async function getChangeRequestPeople(
  query: string,
  signal: AbortSignal,
): Promise<ChangeRequestPeopleResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/change-request-people',
    method: 'GET',
    params: { query },
    timeout: 15000,
    signal,
  });
  return response.data;
}
