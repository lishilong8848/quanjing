import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { TodayAttendanceCorrectionEvidenceQuery } from '@shared/today-attendance.interface';

export async function getTodayAttendanceCorrectionEvidenceImage(
  query: TodayAttendanceCorrectionEvidenceQuery,
  index: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await axiosForBackend({
    url: '/api/attendance/correction-evidence/image',
    method: 'GET',
    params: { date: query.businessDate, entryKey: query.entryKey, index },
    responseType: 'blob',
    timeout: 30_000,
    signal,
  });
  const blob = response.data;
  if (
    !(blob instanceof Blob) ||
    !blob.type.startsWith('image/') ||
    blob.size === 0 ||
    blob.size > 10 * 1024 * 1024
  ) {
    throw new Error('补卡举证图片内容无效');
  }
  return blob;
}
