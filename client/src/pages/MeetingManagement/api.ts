import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  MeetingDetailResponse,
  MeetingSnapshot,
} from '../../../../shared/meeting-management.interface';
import { sortMeetings } from './model';

export async function getMeetingSnapshot(
  signal: AbortSignal,
  refresh = false,
): Promise<MeetingSnapshot> {
  const { data } = await axiosForBackend({
    url: '/api/meeting-management/snapshot',
    method: 'GET',
    params: refresh ? { refresh: '1' } : undefined,
    signal,
    timeout: 20000,
  });
  if (
    !data ||
    typeof data.snapshotId !== 'string' ||
    !Array.isArray(data.records) ||
    !['ready', 'refreshing', 'error'].includes(data.syncState)
  )
    throw new Error('会议归档数据返回异常，请重试');
  return { ...data, records: sortMeetings(data.records) };
}

export async function getMeetingDetail(
  id: string,
  signal: AbortSignal,
): Promise<MeetingDetailResponse> {
  const { data } = await axiosForBackend({
    url: `/api/meeting-management/records/${encodeURIComponent(id)}`,
    method: 'GET',
    signal,
    timeout: 15000,
  });
  if (
    !data ||
    typeof data.snapshotId !== 'string' ||
    data.meeting?.id !== id ||
    !Array.isArray(data.meeting.sections)
  )
    throw new Error('会议内容返回异常，请重试');
  return data;
}

export function meetingError(error: unknown): string {
  const value = error as {
    code?: string;
    message?: string;
    response?: {
      status?: number;
      data?: { message?: string; error?: { message?: string } };
    };
  };
  if (value.response?.status === 403 || value.response?.status === 401)
    return '当前账号无会议归档访问权限，请重新登录有权限的账号';
  if (value.code === 'ECONNABORTED' || value.code === 'ERR_NETWORK')
    return '会议内容加载超时或连接断开，请重试';
  return (
    value.response?.data?.error?.message ||
    value.response?.data?.message ||
    value.message ||
    '会议内容加载失败，请重试'
  );
}
