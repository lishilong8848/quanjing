import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { SelfServiceScheduleResponse } from '@shared/self-service-schedule.interface';

export async function readSelfServiceSchedules(year: number, month: number): Promise<SelfServiceScheduleResponse> {
  if (!Number.isInteger(year) || year < 2000 || year > 2099 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('申请班次月份无效');
  const { data } = await axiosForBackend<SelfServiceScheduleResponse>({ url: `/api/self-service-schedules/${year}/${month}`, method: 'GET', timeout: 15000 });
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
  if (data?.scope !== 'self' || data.complete !== true || !data.applicantName?.trim() || !Array.isArray(data.schedules) || data.range?.startDate !== startDate || data.range?.endDate !== endDate) throw new Error('本人班次读取结果不完整，请重试');
  return data;
}
