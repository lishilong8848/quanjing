import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AlarmReviewPerson, AlarmReviewRequest, AlarmReviewTask } from '@shared/today-operations-alarm-review.interface';
const root = '/api/bitable/alarm-human-reviews';
export async function getAlarmReviewPeople(): Promise<AlarmReviewPerson[]> {
  return (await axiosForBackend({ url: `${root}/people`, method: 'GET', timeout: 8000 })).data;
}
export async function submitAlarmReview(data: AlarmReviewRequest): Promise<AlarmReviewTask> {
  return (await axiosForBackend({ url: root, method: 'POST', data, timeout: 10000 })).data;
}
export async function getAlarmReviewTask(id: string): Promise<AlarmReviewTask> {
  return (await axiosForBackend({ url: `${root}/${encodeURIComponent(id)}`, method: 'GET', timeout: 8000 })).data;
}
export async function recoverAlarmReviewTask(clientMutationId: string): Promise<AlarmReviewTask | null> {
  return (await axiosForBackend({ url: `${root}/mutation/${encodeURIComponent(clientMutationId)}`, method: 'GET', timeout: 8000 })).data;
}
export async function retryAlarmReviewTask(id: string): Promise<AlarmReviewTask> {
  return (await axiosForBackend({ url: `${root}/${encodeURIComponent(id)}/retry`, method: 'POST', timeout: 10000 })).data;
}
export function alarmReviewError(error: unknown): string {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' ? message : '复核请求未确认，请保留当前选择并重试';
}
