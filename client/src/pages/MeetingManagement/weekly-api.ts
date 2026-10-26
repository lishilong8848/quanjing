import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  GenerateWeeklyReport,
  SaveWeeklyMeeting,
  WeeklyJob,
  WeeklyWorkspace,
  EditMeetingAction,
  WeeklyAttachmentCommand,
} from '../../../../shared/weekly-workspace.interface';
import type { MeetingDetailResponse } from '../../../../shared/meeting-management.interface';
const root = '/api/meeting-management/weekly';
let peopleCache: WeeklyWorkspace['people'] = [];
export function cachedWeeklyPeople() {
  return peopleCache;
}
const formRecords = new Map<
  string,
  { data: MeetingDetailResponse; expiresAt: number }
>();
const formVersions = new Map<string, number>();
export function invalidateWeeklyFormRecord(id: string) {
  formRecords.delete(id);
  formVersions.set(id, (formVersions.get(id) || 0) + 1);
}
export function seedWeeklyFormRecord(data: MeetingDetailResponse) {
  invalidateWeeklyFormRecord(data.meeting.id);
  if (formRecords.size >= 100) formRecords.clear();
  const formData = {
    ...data,
    meeting: {
      ...data.meeting,
      sections: data.meeting.sections.filter(
        (section) => section.origin !== 'document',
      ),
    },
  };
  formRecords.set(data.meeting.id, {
    data: formData,
    expiresAt: Date.now() + 30000,
  });
}
export async function weeklyFormRecord(
  id: string,
  signal: AbortSignal,
): Promise<MeetingDetailResponse> {
  const cached = formRecords.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const version = formVersions.get(id) || 0;
  const data: MeetingDetailResponse = (
    await axiosForBackend({
      url: `${root}/records/${encodeURIComponent(id)}`,
      method: 'GET',
      signal,
      timeout: 15000,
    })
  ).data;
  if (!signal.aborted && (formVersions.get(id) || 0) === version)
    seedWeeklyFormRecord(data);
  return data;
}
export async function weeklyWorkspace(
  signal: AbortSignal,
  recheck = false,
): Promise<WeeklyWorkspace> {
  const { data } = await axiosForBackend({
    url: `${root}/workspace`,
    method: 'GET',
    signal,
    ...(recheck ? { params: { recheck: '1' } } : {}),
    timeout: 15000,
  });
  if (
    !Array.isArray(data?.meetings) ||
    !Array.isArray(data.jobs) ||
    !Array.isArray(data.people)
  )
    throw new Error('周会工作台返回异常');
  peopleCache = data.people;
  return data;
}
export async function weeklyMutation(
  kind: 'meetings' | 'generate' | 'actions',
  data: SaveWeeklyMeeting | GenerateWeeklyReport | EditMeetingAction,
): Promise<WeeklyJob> {
  return (
    await axiosForBackend({
      url: `${root}/${kind}`,
      method: 'POST',
      data,
      timeout: 15000,
    })
  ).data;
}
export async function weeklyAttachImages(
  command: Omit<WeeklyAttachmentCommand, 'files'>,
  files: File[],
): Promise<WeeklyJob> {
  const data = new FormData();
  data.append('payload', JSON.stringify(command));
  for (const file of files) data.append('images', file, file.name);
  return (
    await axiosForBackend({
      url: `${root}/attachments`,
      method: 'POST',
      data,
      timeout: 30000,
    })
  ).data;
}
export async function weeklyJob(
  id: string,
  signal: AbortSignal,
): Promise<WeeklyJob> {
  return (
    await axiosForBackend({
      url: `${root}/jobs/${encodeURIComponent(id)}`,
      method: 'GET',
      signal,
      timeout: 10000,
    })
  ).data;
}
export async function retryWeeklyJob(
  id: string,
  documentUrl?: string,
  row = false,
  image = false,
): Promise<WeeklyJob> {
  return (
    await axiosForBackend({
      url: `${root}/jobs/${encodeURIComponent(id)}/${documentUrl ? (image ? 'recover-image' : row ? 'recover-row' : 'recover') : 'retry'}`,
      method: 'POST',
      data: documentUrl
        ? image
          ? { fileToken: documentUrl }
          : row
            ? { targetRecordId: documentUrl }
            : { documentUrl }
        : {},
      timeout: 15000,
    })
  ).data;
}
export async function retryWeeklyNotification(id: string): Promise<WeeklyJob> {
  return (
    await axiosForBackend({
      url: `${root}/jobs/${encodeURIComponent(id)}/retry-notification`,
      method: 'POST',
      data: {},
      timeout: 10000,
    })
  ).data;
}
export async function changeWeeklyTask(
  id: string,
  action: 'delete' | 'restore',
  clientMutationId: string,
): Promise<WeeklyJob> {
  return (
    await axiosForBackend({
      url: `${root}/jobs/${encodeURIComponent(id)}/${action}`,
      method: 'POST',
      data: { clientMutationId },
      timeout: 15000,
    })
  ).data;
}
