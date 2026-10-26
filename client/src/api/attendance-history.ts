import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AttendanceHistoryResponse } from '@shared/attendance-history.interface';

export async function getAttendanceHistory(
  from: string,
  through: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<AttendanceHistoryResponse> {
  const response = await axiosForBackend({
    url: '/api/attendance/history',
    method: 'GET',
    params: {
      from,
      through,
      ...(options.refresh ? { refresh: '1' } : {}),
    },
    timeout: 30_000,
    signal: options.signal,
  });
  return response.data;
}
