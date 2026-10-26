import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  SystemMonthlyReportAcceptedResponse,
  SystemMonthlyReportArchiveRetryResponse,
  SystemMonthlyReportArchivePreview,
  SystemMonthlyReportDashboard,
  SystemMonthlyReportIdentityDirectoryResponse,
  SystemMonthlyReportIdentitySessionResponse,
  SystemMonthlyReportModuleKey,
  SystemMonthlyReportPackageRequest,
  SystemMonthlyReportPackageTask,
  SystemMonthlyReportReviewRequest,
  SystemMonthlyReportSubmissionRequest,
  SystemMonthlyReportSubmissionDeletionRequest,
  SystemMonthlyReportTask,
} from '@shared/system-monthly-report.interface';

export async function getSystemMonthlyReportIdentityDirectory(): Promise<SystemMonthlyReportIdentityDirectoryResponse> {
  const response =
    await axiosForBackend.get<SystemMonthlyReportIdentityDirectoryResponse>(
      '/api/system-monthly-report/identity-directory',
    );
  return response.data;
}

export async function getSystemMonthlyReportIdentitySession(): Promise<SystemMonthlyReportIdentitySessionResponse> {
  const response =
    await axiosForBackend.get<SystemMonthlyReportIdentitySessionResponse>(
      '/api/system-monthly-report/identity-session',
      { timeout: 15_000 },
    );
  return response.data;
}

export async function selectSystemMonthlyReportIdentity(
  personId: string,
): Promise<SystemMonthlyReportIdentitySessionResponse> {
  const response =
    await axiosForBackend.post<SystemMonthlyReportIdentitySessionResponse>(
      '/api/system-monthly-report/identity-session',
      { personId },
    );
  return response.data;
}

export async function logoutSystemMonthlyReportIdentity(): Promise<SystemMonthlyReportIdentitySessionResponse> {
  const response =
    await axiosForBackend.post<SystemMonthlyReportIdentitySessionResponse>(
      '/api/system-monthly-report/identity-session/logout',
    );
  return response.data;
}

export async function getSystemMonthlyReportDashboard(
  forceRefresh = false,
): Promise<SystemMonthlyReportDashboard> {
  const response = await axiosForBackend.get<SystemMonthlyReportDashboard>(
    '/api/system-monthly-report/dashboard',
    { params: forceRefresh ? { refresh: '1' } : undefined },
  );
  return response.data;
}

export async function submitSystemMonthlyReportStage(
  request: SystemMonthlyReportSubmissionRequest,
  file: File,
): Promise<SystemMonthlyReportAcceptedResponse> {
  const form = new FormData();
  form.append('payload', JSON.stringify(request));
  form.append('file', file, file.name);
  const response =
    await axiosForBackend.post<SystemMonthlyReportAcceptedResponse>(
      '/api/system-monthly-report/submissions',
      form,
    );
  return response.data;
}

export async function deleteSystemMonthlyReportStage(
  request: SystemMonthlyReportSubmissionDeletionRequest,
): Promise<SystemMonthlyReportAcceptedResponse> {
  const response =
    await axiosForBackend.post<SystemMonthlyReportAcceptedResponse>(
      '/api/system-monthly-report/submissions/delete',
      request,
    );
  return response.data;
}

export async function submitSystemMonthlyReportReview(
  request: SystemMonthlyReportReviewRequest,
  screenshots: Partial<Record<SystemMonthlyReportModuleKey, File>>,
): Promise<SystemMonthlyReportAcceptedResponse> {
  const form = new FormData();
  form.append('payload', JSON.stringify(request));
  for (const [key, file] of Object.entries(screenshots)) {
    if (file) form.append(`${key}Screenshot`, file, file.name);
  }
  const response =
    await axiosForBackend.post<SystemMonthlyReportAcceptedResponse>(
      '/api/system-monthly-report/reviews',
      form,
    );
  return response.data;
}

export async function getSystemMonthlyReportTask(
  taskId: string,
): Promise<SystemMonthlyReportTask> {
  const response = await axiosForBackend.get<SystemMonthlyReportTask>(
    `/api/system-monthly-report/tasks/${encodeURIComponent(taskId)}`,
  );
  return response.data;
}

export async function retrySystemMonthlyReportTask(
  taskId: string,
): Promise<SystemMonthlyReportTask> {
  const response = await axiosForBackend.post<SystemMonthlyReportTask>(
    `/api/system-monthly-report/tasks/${encodeURIComponent(taskId)}/retry`,
  );
  return response.data;
}

export async function getSystemMonthlyReportArchiveDownloadUrl(
  archiveId: string,
): Promise<{ url: string; name: string; expiresInSeconds: number }> {
  const response = await axiosForBackend.get<{
    url: string;
    name: string;
    expiresInSeconds: number;
  }>(
    `/api/system-monthly-report/archives/${encodeURIComponent(archiveId)}/download-url`,
  );
  return response.data;
}

export async function getSystemMonthlyReportArchivePreview(
  archiveId: string,
): Promise<SystemMonthlyReportArchivePreview> {
  const response = await axiosForBackend.get<SystemMonthlyReportArchivePreview>(
    `/api/system-monthly-report/archives/${encodeURIComponent(archiveId)}/preview`,
  );
  return response.data;
}

export async function retrySystemMonthlyReportArchive(
  archiveId: string,
): Promise<SystemMonthlyReportArchiveRetryResponse> {
  const response =
    await axiosForBackend.post<SystemMonthlyReportArchiveRetryResponse>(
      `/api/system-monthly-report/archives/${encodeURIComponent(archiveId)}/retry`,
    );
  return response.data;
}

export async function createSystemMonthlyReportPackage(
  request: SystemMonthlyReportPackageRequest,
): Promise<SystemMonthlyReportPackageTask> {
  const response = await axiosForBackend.post<SystemMonthlyReportPackageTask>(
    '/api/system-monthly-report/packages',
    request,
  );
  return response.data;
}

export async function getSystemMonthlyReportPackageTask(
  taskId: string,
): Promise<SystemMonthlyReportPackageTask> {
  const response = await axiosForBackend.get<SystemMonthlyReportPackageTask>(
    `/api/system-monthly-report/packages/${encodeURIComponent(taskId)}`,
  );
  return response.data;
}

export async function retrySystemMonthlyReportPackage(
  taskId: string,
): Promise<SystemMonthlyReportPackageTask> {
  const response = await axiosForBackend.post<SystemMonthlyReportPackageTask>(
    `/api/system-monthly-report/packages/${encodeURIComponent(taskId)}/retry`,
  );
  return response.data;
}

export async function getSystemMonthlyReportPackageDownloadUrl(
  taskId: string,
): Promise<{ url: string; name: string; expiresInSeconds: number }> {
  const response = await axiosForBackend.get<{
    url: string;
    name: string;
    expiresInSeconds: number;
  }>(
    `/api/system-monthly-report/packages/${encodeURIComponent(taskId)}/download-url`,
  );
  return response.data;
}
