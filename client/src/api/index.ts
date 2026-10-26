import { logger } from '@lark-apaas/client-toolkit/logger';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { dispatchAccessInvalidated } from '../access/access-events';
import { constructionFetch } from './construction-fetch';
import { applyCurrentCsrfToken, getCurrentCsrfToken } from './csrf-token';
import { retryPurchaseReceiptAcceptance } from './purchase-receipt-retry';
import type {
  NantongAssistantChatRequest,
  NantongAssistantChatResponse,
} from '@shared/nantong-assistant.interface';
import {
  isEmployeeOnboardingCreateResponse,
  type EmployeeOnboardingCreateRequest,
  type EmployeeOnboardingCreateResponse,
} from '@shared/employee-onboarding';
import {
  expandConstructionManagementResponse,
  type ConstructionManagementTransportResponse,
} from '@shared/construction-management-transport';
import type {
  AccessLoginRequest,
  AccessSessionResponse,
} from '@shared/access-control.interface';
import type {
  PurchaseInventoryResponse,
  PurchaseOnlineApprovalAcceptedResponse,
  PurchaseOnlineApprovalRequest,
  PurchaseOnlineApprovalTaskStatusResponse,
  PurchaseRecordBatchDeleteRequest,
  PurchaseRecordBatchDeleteResponse,
  PurchaseRecordUpdateRequest,
  PurchaseRecordUpdateResponse,
} from '@shared/purchase-inventory.interface';
import type { EquipmentPatrolExecutionResponse } from '@shared/equipment-patrol-execution.interface';
import type {
  AliMonthlyQualityDataset,
  AliRiskInspectionDashboard,
  CrossInspectionGuidePage,
  CrossInspectionGuideSource,
  CrossInspectionDashboard,
} from '@shared/risk-inspection.interface';
import type { EquipmentLifecycleDashboardResponse } from '@shared/equipment-lifecycle.interface';
import type { ChinaWorkCalendarResponse } from '@shared/china-work-calendar';
import type {
  TodayAttendanceCorrectionEvidenceManifest,
  TodayAttendanceCorrectionEvidenceQuery,
  TodayAttendanceManualSyncRequest,
  TodayAttendanceManualSyncResponse,
  TodayAttendanceSnapshot,
} from '@shared/today-attendance.interface';
import type {
  ContractManagementDashboard,
  ContractNoPaymentRequiredRequest,
  ContractNoPaymentRequiredResponse,
  ContractCreateKind,
  ContractCreateOptionsResponse,
  ContractCreateRequest,
  ContractCreateResponse,
  ContractExpiryDispositionRequest,
  ContractExpiryDispositionSubmissionResponse,
  ContractExpiryDispositionTaskStatusResponse,
  ContractEditOptionsResponse,
  ContractEditRequest,
  ContractEditResponse,
  ContractPaymentFollowUpActionResponse,
  ContractPaymentFollowUpOptionsResponse,
  ContractPaymentPlanAdjustRequest,
  ContractPaymentPlanConfirmRequest,
  ContractPaymentPlanCreateRequest,
  ContractWorkflowCode,
  ContractWorkflowRunResult,
  ContractWorkflowSelfTestResponse,
  ContractWorkflowStatusResponse,
} from '@shared/contract-management.interface';
import type {
  CreateInventoryMovementDeletionRequest,
  InventoryBatchAcceptanceResponse,
  InventoryItemsQuery,
  InventoryItemsResponse,
  InventoryManagementDashboard,
  InventoryInboundAcceptedResponse,
  InventoryInboundTaskKind,
  InventoryInboundTaskStatusResponse,
  InventoryMovementDeletionAcceptedResponse,
  InventoryMovementDeletionTaskStatusResponse,
  InventoryMovementCreateRequest,
  InventoryMovementCreateResponse,
  InventoryOutboundAcceptedResponse,
  InventoryOutboundConfirmRequest,
  InventoryOutboundConfirmResponse,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundTaskStatusResponse,
  InventoryMovementOptionItem,
  InventoryMovementOptionsQuery,
  InventoryMovementsQuery,
  InventoryMovementsResponse,
  InventoryWorkflowCode,
  InventoryWorkflowRunResult,
  InventoryWorkflowSelfTestResponse,
  InventoryWorkflowStatusResponse,
  PurchaseInboundConfirmRequest,
  PurchaseInboundConfirmResponse,
  PurchaseInboundCategoryAcceptedResponse,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundCategoryTaskStatusResponse,
  PurchasePendingInboundResponse,
  WarehouseBuilding,
  WarehouseStorageLocation,
  WarehouseStorageLocationCreateRequest,
  WarehouseStorageLocationCreateResponse,
  WarehouseStorageLocationQuery,
} from '@shared/inventory-management.interface';
import type {
  PurchaseApplicationApplicant,
  PurchaseApplicationApplicantSearchParams,
  PurchaseApplicationBatchRequest,
  PurchaseApplicationCatalogItem,
  PurchaseApplicationCatalogSearchParams,
  PurchaseApplicationOptionsResponse,
  PurchaseApplicationSubmissionResponse,
  PurchaseApplicationSubmissionTaskStatusResponse,
  PurchaseApplicationSubmitResponse,
} from '@shared/purchase-application.interface';
import type {
  PurchaseWorkflowApprovalInput,
  PurchaseWorkflowCommandResult,
  PurchaseWorkflowDetail,
  PurchaseWorkflowOperationalStatus,
  PurchaseWorkflowOrderInput,
  PurchaseWorkflowReceiptInput,
  PurchaseWorkflowReceiptAcceptedResponse,
  PurchaseWorkflowReceiptTaskStatusResponse,
} from '@shared/purchase-workflow.interface';
import type {
  AdditionalMatterCreateRequest,
  AdditionalMatterCreateResponse,
  ChangeScheduleAdjustmentRequest,
  ChangeScheduleAdjustmentResponse,
  ConstructionApplicationCreateResponse,
  ConstructionAttachmentDeleteRequest,
  ConstructionAttachmentDeleteResponse,
  ConstructionChangeOrderCandidatesResponse,
  ConstructionFollowupCreateResponse,
  ConstructionIsolationPhotoManualReviewUpdateRequest,
  ConstructionIsolationPhotoManualReviewUpdateResponse,
  ConstructionManagementResponse,
  ConstructionCrewRosterOutlookSyncRequest,
  ConstructionCrewRosterOutlookSyncResponse,
  ConstructionCrewRosterUploadSyncResponse,
  ConstructionPermitManualReviewRequest,
  ConstructionPermitManualReviewResponse,
  ConstructionPermitManualReviewUpdateRequest,
  ConstructionPermitManualReviewUpdateResponse,
  ConstructionProjectDeleteRequest,
  ConstructionProjectDeleteResponse,
  ConstructionProjectTerminateRequest,
  ConstructionProjectTerminateResponse,
  ConstructionStaffCandidatesResponse,
  Building,
  DutySchedule,
  BatchDutyScheduleRequest,
  BatchDutyScheduleResponse,
  DutyStaffActualRepairRequest,
  DutyStaffActualRepairResponse,
  DutyStaffActualRepairScanResponse,
  DutyStaffAdjustmentRequest,
  DutyStaffAdjustmentResponse,
  ExceptionFollowUpCreateRequest,
  ExceptionFollowUpCreateResponse,
  ExceptionFollowUpDeleteRequest,
  ExceptionFollowUpDeleteResponse,
  ExceptionFollowUpListResponse,
  ExceptionFollowUpUpdateRequest,
  ExceptionFollowUpUpdateResponse,
  LeaveRequestCreateRequest,
  LeaveRequestCreateResponse,
  OvertimeConfirmationAcceptedResponse,
  OvertimeConfirmationDetailResponse,
  OvertimeConfirmationSubmitPayload,
  OvertimeRequestCreateRequest,
  OvertimeRequestCreateResponse,
  SealingRegistrationCreateRequest,
  SealingRegistrationCreateResponse,
  LongWhiteDutyStaffResponse,
  PersonnelMovementCreateRequest,
  PersonnelMovementCreateResponse,
  TravelStaffAdjustRequest,
  TravelStaffDetailResponse,
  TravelStaffMutationResponse,
  TravelStaffRevokeRequest,
  TravelStaffUpdateRequest,
  TravelStaffUpdateResponse,
  SyncTaskStatusResponse,
  VacancySubstituteUpdateRequest,
  VacancySubstituteUpdateResponse,
  MonthlyScheduleResponse,
  ScheduleSnapshotRevisionResponse,
  MonthlyScheduleScreenshotAccessRequest,
  MonthlyScheduleScreenshotAccessResponse,
  LastSyncTimeResponse,
  BitableSyncResponse,
  BitableRecordsResponse,
  CampusOperationsDashboardResponse,
  CampusCertificateDashboardResponse,
  CampusCertificateExpiryNotificationPreview,
  CampusCertificateExpiryNotificationRequest,
  CampusCertificateExpiryNotificationResponse,
  YearlyChangeInfoResponse,
  YearlySealingInfoResponse,
  NantongOrganizationResponse,
  PersonProfileDetailResponse,
  PersonProfileResponse,
  DutyStaffResponse,
  NonDutyScheduleResponse,
  HolidayDutyScheduleResponse,
  FestivalScheduleResponse,
  TodayLeaveStaffResponse,
  DutyOverviewScreenshotResponse,
  TyphoonPathGroupScreenshotRequest,
  TyphoonPathGroupScreenshotResponse,
  TyphoonPathScreenshotPreviewResponse,
  WeatherGuardRegistrationOptions,
  WeatherGuardRegistrationResponse,
  WeatherWarningSnapshot,
  WeatherWarningTestPreviewResponse,
  WeatherWarningTestSendRequest,
  WeatherWarningTestSendResponse,
  TodayFocusChecklistResponse,
  OperationsKbSearchResponse,
  OperationsKbStatsResponse,
  OperationsKbDocumentDetail,
  AliMonthlyReportBundleRequest,
  AliMonthlyReportConfigResponse,
  AliMonthlyReportEmailRequest,
  AliMonthlyReportEmailResponse,
  AliMonthlyReportFileActionResponse,
  AliMonthlyReportGenerateRequest,
  AliMonthlyReportGenerateResponse,
} from '@shared/api.interface';
import type { CampusTrainingDashboardResponse } from '@shared/campus-training-dashboard.interface';
import type {
  OrganizationPersonProfileResponse,
  OrganizationPersonProfileSource,
} from '@shared/organization-person-profile';
import type {
  ChangeAttachmentDeleteResponse,
  ChangeAttachmentStageResponse,
  ChangeRequestCreateRequest,
  ChangeRequestCreateResponse,
} from '@shared/change-request';
import type {
  ChangeAdjustmentRequest,
  ChangeAdjustmentResponse,
} from '@shared/change-adjustment';
import type {
  ChangeDrillReportCreateRequest,
  ChangeDrillReportCreateResponse,
} from '@shared/change-drill-report';
import type {
  ChangeSummaryReportAbandonRequest,
  ChangeSummaryReportAbandonResponse,
  ChangeSummaryReportCreateRequest,
  ChangeSummaryReportCreateResponse,
  ChangeSummaryReportSyncTaskResponse,
} from '@shared/change-summary-report';
import type {
  TodayOperationsAlarmDashboardResponse,
  TodayOperationsAlarmHandlingStatus,
  TodayOperationsAlarmLevel,
  TodayOperationsAlarmMetric,
  TodayOperationsAlarmProcessingStatus,
  TodayOperationsAlarmRecoveryStatus,
} from '@shared/today-operations-alarm.interface';
import type { TodayOperationsKpiResponse } from '@shared/today-operations-kpi.interface';
import type { TodayOperationsOverviewResponse } from '@shared/today-operations-overview.interface';
import type {
  EmergencyDutyOptionsResponse,
  EmergencyDutyScheduleResponse,
  EmergencyDutyUpsertRequest,
  EmergencyDutyUpsertResponse,
} from '@shared/emergency-duty.interface';

const ACCESS_REQUEST_TIMEOUT_MS = 10_000;
const ACCESS_REQUEST_TIMEOUT_MESSAGE = '登录验证超时，请检查网络连接后重试。';

// Axios runs request interceptors in reverse order, before the SDK reads window.csrfToken.
if (typeof window !== 'undefined') axiosForBackend.interceptors.request.use(applyCurrentCsrfToken);

// 和风天气API响应类型
export interface QWeatherNow {
  code: string;
  updateTime: string;
  fxLink: string;
  now: {
    obsTime: string;
    temp: string;
    feelsLike: string;
    icon: string;
    text: string;
    wind360: string;
    windDir: string;
    windScale: string;
    windSpeed: string;
    humidity: string;
    precip: string;
    pressure: string;
    vis: string;
    cloud: string;
    dew: string;
  };
}

export interface QWeatherWarning {
  code: string;
  updateTime: string;
  fxLink: string;
  warning: Array<{
    id: string;
    sender: string;
    pubTime: string;
    title: string;
    startTime: string;
    endTime: string;
    status: string;
    level: string;
    type: string;
    text: string;
  }>;
}

export interface QWeatherHourly {
  code: string;
  updateTime: string;
  fxLink: string;
  hourly: Array<{
    fxTime: string;
    temp: string;
    icon: string;
    text: string;
    wind360: string;
    windDir: string;
    windScale: string;
    windSpeed: string;
    humidity: string;
    precip: string;
    pop: string;
    pressure: string;
    cloud: string;
    dew: string;
  }>;
}

/**
 * 带重试机制的请求封装
 */
async function requestWithRetry<T>(
  requestFn: () => Promise<T>,
  maxRetries = 3,
  retryDelay = 2000,
  shouldRetry?: (error: any) => boolean,
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error: any) {
      lastError = error;
      const isRetryable = shouldRetry
        ? shouldRetry(error)
        : error?.code === 'ECONNABORTED' ||
          error?.response?.status === 504 ||
          error?.response?.status === 502 ||
          error?.response?.status === 503;

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      logger.warn(
        `请求失败，第 ${attempt} 次重试 (${retryDelay}ms 后)...`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  throw lastError;
}

export async function getAccessSession(): Promise<AccessSessionResponse & { sessionCookieStatus?: string }> {
  const response = await axiosForBackend({
    url: '/api/access/session',
    method: 'GET',
    timeout: ACCESS_REQUEST_TIMEOUT_MS,
  });
  const status = response.headers['x-access-session-cookie'];
  return {
    ...(response.data as AccessSessionResponse),
    ...(typeof status === 'string' && ['absent', 'duplicate', 'malformed', 'rejected', 'valid', 'disabled'].includes(status)
      ? { sessionCookieStatus: status }
      : {}),
  };
}

export async function getTodayAttendanceSnapshot(
  forceRefresh = false,
): Promise<TodayAttendanceSnapshot> {
  const response = await axiosForBackend({
    url: '/api/attendance/today',
    method: 'GET',
    params: forceRefresh ? { refresh: '1' } : undefined,
    timeout: 15_000,
  });
  return response.data as TodayAttendanceSnapshot;
}

export async function getTodayAttendanceCorrectionEvidence(
  query: TodayAttendanceCorrectionEvidenceQuery,
  signal?: AbortSignal,
): Promise<TodayAttendanceCorrectionEvidenceManifest> {
  const response = await axiosForBackend({
    url: '/api/attendance/correction-evidence',
    method: 'GET',
    params: { date: query.businessDate, entryKey: query.entryKey },
    timeout: 15_000,
    signal,
  });
  return response.data as TodayAttendanceCorrectionEvidenceManifest;
}

export { getTodayAttendanceCorrectionEvidenceImage } from './attendance-evidence';

export async function retryTodayAttendance(
  request: TodayAttendanceManualSyncRequest,
): Promise<TodayAttendanceManualSyncResponse> {
  const response = await axiosForBackend({
    url: '/api/attendance/today/retry',
    method: 'POST',
    data: request,
    timeout: 15_000,
  });
  const result = response.data as TodayAttendanceManualSyncResponse;
  if (
    result?.success !== true ||
    result.clientMutationId !== request.clientMutationId
  ) {
    throw new Error('手动考勤同步受理结果无效');
  }
  return result;
}

export async function loginAccess(
  request: AccessLoginRequest,
): Promise<AccessSessionResponse> {
  return withAccessRequestTimeout(async (signal) => {
    const response = await postAccessLogin(request, signal);

    if (isAccessCsrfResponse(response)) {
      throw Object.assign(new Error('登录页面已过期，请刷新页面后重试。'), {
        response: { status: 403, data: { message: '登录页面已过期，请刷新页面后重试。' } },
      });
    }
    return accessSessionFromResponse(response);
  });
}

async function postAccessLogin(
  request: AccessLoginRequest,
  signal: AbortSignal,
): Promise<{
  status: number;
  data: unknown;
}> {
  const csrfToken = getCurrentCsrfToken();
  const response = await fetch(buildAccessApiUrl('/api/access/login'), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-Suda-Csrf-Token': csrfToken } : {}),
    },
    body: JSON.stringify(request),
  });
  const responseBody = await response.text();
  return {
    status: response.status,
    data: parseAccessResponseBody(responseBody),
  };
}

async function withAccessRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    ACCESS_REQUEST_TIMEOUT_MS,
  );
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error(ACCESS_REQUEST_TIMEOUT_MESSAGE), {
        response: {
          status: 408,
          data: { message: ACCESS_REQUEST_TIMEOUT_MESSAGE },
        },
      });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function buildAccessApiUrl(path: string): string {
  const basePath = normalizeAccessClientBasePath(process.env.CLIENT_BASE_PATH);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${basePath}${normalizedPath}`;
}

function normalizeAccessClientBasePath(value: unknown): string {
  const trimmed = String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function parseAccessResponseBody(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function accessSessionFromResponse(response: {
  status?: unknown;
  data?: unknown;
}): AccessSessionResponse {
  if (
    typeof response.status === 'number' &&
    (response.status < 200 || response.status >= 300)
  ) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { response });
  }
  return response.data as AccessSessionResponse;
}

function isAccessCsrfResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  if ((response as { status?: unknown }).status !== 403) return false;
  const data = (response as { data?: unknown }).data;
  const message =
    typeof data === 'string'
      ? data
      : data && typeof data === 'object'
        ? (data as { message?: unknown }).message
        : '';
  return typeof message === 'string' && /csrf token/i.test(message);
}

export async function logoutAccess(): Promise<AccessSessionResponse> {
  const response = await axiosForBackend({
    url: '/api/access/logout',
    method: 'POST',
    timeout: ACCESS_REQUEST_TIMEOUT_MS,
  });
  return response.data as AccessSessionResponse;
}

export async function getPurchaseInventoryDashboard(
  refresh: boolean | 'active' = false,
): Promise<PurchaseInventoryResponse> {
  const response = await axiosForBackend({
    url: '/api/purchase-inventory/dashboard',
    method: 'GET',
    params:
      refresh === 'active'
        ? { refresh: 'active' }
        : refresh
          ? { refresh: '1' }
          : undefined,
    timeout: 120_000,
  });
  return response.data;
}

export async function deletePurchaseInventoryRecords(
  request: PurchaseRecordBatchDeleteRequest,
): Promise<PurchaseRecordBatchDeleteResponse> {
  const response = await axiosForBackend({
    url: '/api/purchase-inventory/records/batch-delete',
    method: 'POST',
    data: request,
    timeout: 120_000,
  });
  const data = response.data as Partial<PurchaseRecordBatchDeleteResponse> & {
    success?: boolean;
    message?: unknown;
  };
  if (data?.success === false || typeof data?.deletedItems !== 'number') {
    const message =
      typeof data?.message === 'string' && data.message.trim()
        ? data.message
        : '删除失败，请稍后重试或联系管理员确认后端权限与多维表配置';
    throw new Error(message);
  }
  return data as PurchaseRecordBatchDeleteResponse;
}

export async function updatePurchaseInventoryRecord(
  recordId: string,
  request: PurchaseRecordUpdateRequest,
): Promise<PurchaseRecordUpdateResponse> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/records/${encodeURIComponent(recordId)}`,
    method: 'PATCH',
    data: request,
    timeout: 120_000,
  });
  return response.data;
}

export async function submitPurchaseOnlineApproval(
  recordId: string,
  input: PurchaseOnlineApprovalRequest,
): Promise<PurchaseOnlineApprovalAcceptedResponse> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/records/${encodeURIComponent(recordId)}/approval`,
    method: 'POST',
    data: input,
    timeout: 15_000,
  });
  return response.data as PurchaseOnlineApprovalAcceptedResponse;
}

export async function getPurchaseOnlineApprovalTaskStatus(
  taskId: string,
): Promise<PurchaseOnlineApprovalTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/approval/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 15_000,
  });
  return response.data as PurchaseOnlineApprovalTaskStatusResponse;
}

export async function getEquipmentPatrolExecutions(
  month: string,
  refresh = false,
): Promise<EquipmentPatrolExecutionResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/equipment-patrol/executions',
      method: 'GET',
      params: { month, refresh: refresh ? '1' : undefined },
      timeout: 120_000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取设备轮巡执行记录失败', error);
    throw error;
  }
}

export async function getEquipmentLifecycleDashboard(
  options: { month?: string; refresh?: boolean } = {},
): Promise<EquipmentLifecycleDashboardResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/equipment-lifecycle/dashboard',
      method: 'GET',
      params: {
        month: options.month,
        refresh: options.refresh ? '1' : undefined,
      },
      timeout: 120_000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取设备生命周期看板数据失败', error);
    throw error;
  }
}

export async function getRiskInspectionAliDashboard(
  options: { month?: string; refresh?: boolean } = {},
): Promise<AliRiskInspectionDashboard> {
  try {
    const response = await axiosForBackend({
      url: '/api/risk-inspection/ali',
      method: 'GET',
      params: {
        month: options.month,
        refresh: options.refresh ? '1' : undefined,
      },
      timeout: 120_000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取现场风险检查数据失败', error);
    throw error;
  }
}

export async function getAliMonthlyQualityDataset(
  options: { refresh?: boolean } = {},
): Promise<AliMonthlyQualityDataset> {
  try {
    const response = await axiosForBackend({
      url: '/api/risk-inspection/ali-monthly-quality',
      method: 'GET',
      params: {
        refresh: options.refresh ? '1' : undefined,
      },
      timeout: 120_000,
    });
    return normalizeAliMonthlyQualityDataset(response.data);
  } catch (error) {
    logger.error('获取阿里月度质量检查清单失败', error);
    throw error;
  }
}

export async function updateAliMonthlyQualitySupplemental(
  recordId: string,
  input: {
    supplemental: string;
    expectedSupplemental: string;
    clientMutationId: string;
  },
): Promise<AliMonthlyQualityFollowUpTask> {
  const response = await axiosForBackend({
    url: `/api/risk-inspection/ali-monthly-quality/issues/${encodeURIComponent(recordId)}/supplemental`,
    method: 'PATCH',
    data: input,
    timeout: 60_000,
  });
  return response.data;
}

export interface AliMonthlyQualityFollowUpTask {
  taskId: string;
  recordId: string;
  supplemental: string;
  clientMutationId: string;
  syncStatus: 'pending' | 'running' | 'success' | 'error';
  message: string;
}

export async function getAliMonthlyQualitySupplementalTask(
  taskId: string,
): Promise<AliMonthlyQualityFollowUpTask> {
  const response = await axiosForBackend({
    url: `/api/risk-inspection/ali-monthly-quality/supplemental-tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 15_000,
  });
  return response.data;
}

type AliMonthlyQualityTransportIssue = Omit<
  AliMonthlyQualityDataset['issues'][number],
  'responsiblePersons' | 'personMatchStatus'
> &
  Partial<
    Pick<
      AliMonthlyQualityDataset['issues'][number],
      'responsiblePersons' | 'personMatchStatus'
    >
  >;

type AliMonthlyQualityTransportDataset = Omit<
  AliMonthlyQualityDataset,
  'issues'
> & {
  issues?: AliMonthlyQualityTransportIssue[];
};

function normalizeAliMonthlyQualityDataset(
  dataset: AliMonthlyQualityTransportDataset,
): AliMonthlyQualityDataset {
  return {
    ...dataset,
    issues: Array.isArray(dataset.issues)
      ? dataset.issues.map((issue) => {
          const responsiblePersons = Array.isArray(issue.responsiblePersons)
            ? issue.responsiblePersons
            : [];
          const personMatchStatus =
            issue.personMatchStatus === 'matched' ||
            issue.personMatchStatus === 'none' ||
            issue.personMatchStatus === 'ambiguous'
              ? issue.personMatchStatus
              : responsiblePersons.length > 0
                ? 'matched'
                : 'none';
          return {
            ...issue,
            responsiblePersons,
            personMatchStatus,
          };
        })
      : [],
  };
}

export async function getRiskInspectionCrossDashboard(
  options: { month?: string; refresh?: boolean } = {},
): Promise<CrossInspectionDashboard> {
  try {
    const response = await axiosForBackend({
      url: '/api/risk-inspection/cross',
      method: 'GET',
      params: {
        month: options.month,
        refresh: options.refresh ? '1' : undefined,
      },
      timeout: 120_000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取交叉互查互纠数据失败', error);
    throw error;
  }
}

export async function getRiskInspectionCrossGuides(
  options: {
    source?: 'all' | CrossInspectionGuideSource;
    query?: string;
    page?: number;
    pageSize?: number;
    refresh?: boolean;
  } = {},
): Promise<CrossInspectionGuidePage> {
  try {
    const response = await axiosForBackend({
      url: '/api/risk-inspection/cross/guides',
      method: 'GET',
      params: {
        source: options.source,
        query: options.query,
        page: options.page,
        pageSize: options.pageSize,
        refresh: options.refresh ? '1' : undefined,
      },
      timeout: 120_000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取互查互纠标准与指引失败', error);
    throw error;
  }
}

export async function getContractManagementDashboard(
  forceRefresh = false,
): Promise<ContractManagementDashboard> {
  try {
    const response = await axiosForBackend({
      url: '/api/contract-management/dashboard',
      method: 'GET',
      params: forceRefresh ? { refresh: '1' } : undefined,
      timeout: 120_000,
    });
    if (response.status === 401 || response.status === 403) {
      dispatchAccessInvalidated();
      throw new Error('管理员会话已失效，请重新登录');
    }
    if (
      typeof response.status === 'number' &&
      (response.status < 200 || response.status >= 300)
    ) {
      throw new Error(`合同数据请求失败（HTTP ${response.status}）`);
    }
    if (!isContractManagementDashboard(response.data)) {
      throw new Error('合同数据响应格式无效，请刷新后重试');
    }
    return response.data;
  } catch (error) {
    logger.error('获取合同管理看板失败', error);
    throw error;
  }
}

function isContractManagementDashboard(
  value: unknown,
): value is ContractManagementDashboard {
  if (!value || typeof value !== 'object') return false;
  const dashboard = value as Partial<ContractManagementDashboard>;
  return (
    typeof dashboard.generatedAt === 'string' &&
    Boolean(dashboard.summary && typeof dashboard.summary === 'object') &&
    Boolean(
      dashboard.paymentProgress &&
      typeof dashboard.paymentProgress === 'object',
    ) &&
    Array.isArray(dashboard.contracts) &&
    Array.isArray(dashboard.payments) &&
    Boolean(
      dashboard.sectionStatus && typeof dashboard.sectionStatus === 'object',
    )
  );
}

export async function getContractCreateOptions(
  kind: ContractCreateKind,
): Promise<ContractCreateOptionsResponse> {
  const response = await axiosForBackend({
    url: '/api/contract-management/contracts/create-options',
    method: 'GET',
    params: { kind },
    timeout: 120_000,
  });
  return response.data;
}

export async function createContract(
  request: ContractCreateRequest,
  attachments: File[],
): Promise<ContractCreateResponse> {
  const form = new FormData();
  form.append('payload', JSON.stringify(request));
  for (const file of attachments) form.append('attachments', file);
  const response = await axiosForBackend({
    url: '/api/contract-management/contracts',
    method: 'POST',
    data: form,
    timeout: 300_000,
  });
  return response.data;
}

export async function getContractEditOptions(
  contractRecordId: string,
): Promise<ContractEditOptionsResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(contractRecordId)}/edit-options`,
    method: 'GET',
    timeout: 120_000,
  });
  return response.data;
}

export async function updateContractInformation(
  contractRecordId: string,
  request: ContractEditRequest,
): Promise<ContractEditResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(contractRecordId)}`,
    method: 'PATCH',
    data: request,
    timeout: 120_000,
  });
  return response.data;
}

export async function getContractPaymentFollowUpOptions(
  contractRecordId: string,
): Promise<ContractPaymentFollowUpOptionsResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(contractRecordId)}/payment-follow-up-options`,
    method: 'GET',
    timeout: 120_000,
  });
  return response.data;
}

export async function createContractPaymentPlan(
  contractRecordId: string,
  request: ContractPaymentPlanCreateRequest,
): Promise<ContractPaymentFollowUpActionResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(contractRecordId)}/payment-plans`,
    method: 'POST',
    data: request,
    timeout: 120_000,
  });
  return response.data;
}

export async function adjustContractPaymentPlan(
  contractRecordId: string,
  paymentRecordId: string,
  request: ContractPaymentPlanAdjustRequest,
): Promise<ContractPaymentFollowUpActionResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(contractRecordId)}/payment-plans/${encodeURIComponent(paymentRecordId)}`,
    method: 'PATCH',
    data: request,
    timeout: 120_000,
  });
  return response.data;
}

export async function confirmContractPaymentPlan(
  contractRecordId: string,
  paymentRecordId: string,
  request: ContractPaymentPlanConfirmRequest,
): Promise<ContractPaymentFollowUpActionResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(contractRecordId)}/payment-plans/${encodeURIComponent(paymentRecordId)}/confirm`,
    method: 'POST',
    data: request,
    timeout: 120_000,
  });
  return response.data;
}

export async function markContractNoPaymentRequired(
  contractRecordId: string,
  request: ContractNoPaymentRequiredRequest,
): Promise<ContractNoPaymentRequiredResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(contractRecordId)}/payment-follow-up-disposition`,
    method: 'PATCH',
    data: request,
    timeout: 120_000,
  });
  return response.data;
}

export async function getContractWorkflowStatus(): Promise<ContractWorkflowStatusResponse> {
  const response = await axiosForBackend({
    url: '/api/contract-management/workflows',
    method: 'GET',
    timeout: 120_000,
  });
  return response.data;
}

export async function runContractWorkflow(
  code: ContractWorkflowCode,
): Promise<ContractWorkflowRunResult> {
  const response = await axiosForBackend({
    url: `/api/contract-management/workflows/${encodeURIComponent(code)}/run`,
    method: 'POST',
    timeout: 180_000,
  });
  return response.data;
}

export async function runContractWorkflowSelfTest(): Promise<ContractWorkflowSelfTestResponse> {
  const response = await axiosForBackend({
    url: '/api/contract-management/workflows/self-test',
    method: 'POST',
    timeout: 180_000,
  });
  return response.data;
}

export async function updateContractExpiryDisposition(
  recordId: string,
  request: ContractExpiryDispositionRequest,
): Promise<ContractExpiryDispositionSubmissionResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/${encodeURIComponent(recordId)}/expiry-disposition`,
    method: 'PATCH',
    data: request,
    timeout: 15_000,
  });
  return response.data;
}

export async function getContractExpiryDispositionTaskStatus(
  taskId: string,
): Promise<ContractExpiryDispositionTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/contract-management/contracts/expiry-disposition-tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 15_000,
  });
  return response.data;
}

export function getContractAttachmentPageUrl(
  accessId: string,
  page: number,
): string {
  return `/api/contract-management/attachments/${encodeURIComponent(accessId)}/pages/${page}`;
}

export interface ContractAttachmentManifest {
  accessId: string;
  name: string;
  previewStatus: 'processing' | 'ready' | 'needs_review' | 'failed';
  pageCount: number;
  originalAvailable?: boolean;
  unavailableReason?: 'storage_not_configured';
}

export async function getContractAttachmentManifest(
  accessId: string,
): Promise<ContractAttachmentManifest> {
  const response = await axiosForBackend({
    url: `/api/contract-management/attachments/${encodeURIComponent(accessId)}/manifest`,
    method: 'GET',
    timeout: 30_000,
  });
  return response.data;
}

export function getContractAttachmentDownloadUrl(accessId: string): string {
  return `/api/contract-management/attachments/${encodeURIComponent(accessId)}/download`;
}

export function getContractAttachmentInlineUrl(accessId: string): string {
  return `${getContractAttachmentDownloadUrl(accessId)}?disposition=inline`;
}

export async function getInventoryManagementDashboard(
  forceRefresh = false,
): Promise<InventoryManagementDashboard> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/dashboard',
    method: 'GET',
    params: forceRefresh ? { refresh: '1' } : undefined,
    timeout: 120_000,
  });
  return response.data;
}

export async function getInventoryManagementItems(
  query: InventoryItemsQuery,
  forceRefresh = false,
): Promise<InventoryItemsResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/items',
    method: 'GET',
    params: forceRefresh ? { ...query, refresh: '1' } : query,
    timeout: 120_000,
  });
  return response.data;
}

export async function getInventoryManagementMovements(
  query: InventoryMovementsQuery,
  forceRefresh = false,
): Promise<InventoryMovementsResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/movements',
    method: 'GET',
    params: forceRefresh ? { ...query, refresh: '1' } : query,
    timeout: 120_000,
  });
  return response.data;
}

export async function createInventoryMovementDeletion(
  data: CreateInventoryMovementDeletionRequest,
): Promise<InventoryMovementDeletionAcceptedResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/movements/deletions',
    method: 'POST',
    data,
    timeout: 15_000,
  });
  return response.data as InventoryMovementDeletionAcceptedResponse;
}

export async function getInventoryMovementDeletionTaskStatus(
  taskId: string,
): Promise<InventoryMovementDeletionTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/inventory-management/movements/deletions/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 15_000,
  });
  return response.data as InventoryMovementDeletionTaskStatusResponse;
}

export async function getInventoryMovementOptions(
  query: InventoryMovementOptionsQuery,
): Promise<InventoryMovementOptionItem[]> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/movement-options',
    method: 'GET',
    params: query,
    timeout: 120_000,
  });
  return response.data;
}

export async function getWarehouseStorageLocations(
  query: WarehouseStorageLocationQuery,
): Promise<WarehouseStorageLocation[]> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/storage-locations',
    method: 'GET',
    params: query,
    timeout: 30_000,
  });
  return response.data;
}

export async function createWarehouseStorageLocation(
  data: WarehouseStorageLocationCreateRequest,
): Promise<WarehouseStorageLocationCreateResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/storage-locations',
    method: 'POST',
    data,
    timeout: 45_000,
  });
  return response.data;
}

export async function createInventoryMovement(
  data: InventoryMovementCreateRequest,
): Promise<InventoryMovementCreateResponse | InventoryInboundAcceptedResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/movements',
    method: 'POST',
    data,
    timeout: 15_000,
  });
  assertSuccessfulBackendResponse(response);
  if (isInventoryMovementCreateResponse(response.data)) {
    return response.data;
  }
  const accepted = response.data as InventoryInboundAcceptedResponse;
  assertInventoryInboundAccepted(accepted, 'manual');
  return accepted;
}

export async function getInventoryInboundTaskStatus(
  taskId: string,
): Promise<InventoryInboundTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/inventory-management/inbounds/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 15_000,
  });
  assertSuccessfulBackendResponse(response);
  return response.data as InventoryInboundTaskStatusResponse;
}

type InventoryInboundFinalResponse =
  | InventoryMovementCreateResponse
  | PurchaseInboundConfirmResponse;

export interface InventoryInboundTaskDeferredResult {
  deferred: true;
  taskId: string;
  kind: InventoryInboundTaskKind;
  status: 'pending' | 'running';
  message: string;
}

export type InventoryInboundTaskWaitResult<
  TResult extends InventoryInboundFinalResponse,
> = TResult | InventoryInboundTaskDeferredResult;

interface InventoryInboundTaskWaitOptions {
  maxWaitMs?: number;
}

const DEFAULT_INVENTORY_INBOUND_TASK_WAIT_MS = 30_000;

export function isInventoryInboundTaskDeferred(
  value: InventoryInboundFinalResponse | InventoryInboundTaskDeferredResult,
): value is InventoryInboundTaskDeferredResult {
  return 'deferred' in value && value.deferred === true;
}

async function queryInventoryInboundTaskResult<
  TResult extends InventoryInboundFinalResponse,
>(
  taskId: string,
  expectedKind: InventoryInboundTaskKind,
  isExpectedResult: (value: unknown) => value is TResult,
): Promise<InventoryInboundTaskWaitResult<TResult>> {
  const response = await getInventoryInboundTaskStatus(taskId);
  const task = response?.task;
  if (!task || task.id !== taskId || task.kind !== expectedKind) {
    throw new Error('入库后台任务响应与本次操作不一致');
  }
  if (task.status === 'completed') {
    if (!isExpectedResult(task.result)) {
      throw new Error('入库后台任务缺少有效完成结果');
    }
    return task.result;
  }
  if (task.status === 'failed') {
    throw inventoryInboundRejected(task.message);
  }
  return {
    deferred: true,
    taskId,
    kind: expectedKind,
    status: task.status,
    message: task.message,
  };
}

async function awaitInventoryInboundTaskResult<
  TResult extends InventoryInboundFinalResponse,
>(
  accepted: InventoryInboundAcceptedResponse,
  expectedKind: InventoryInboundTaskKind,
  isExpectedResult: (value: unknown) => value is TResult,
  options: InventoryInboundTaskWaitOptions = {},
): Promise<InventoryInboundTaskWaitResult<TResult>> {
  assertInventoryInboundAccepted(accepted, expectedKind);
  if (accepted.status === 'completed' && isExpectedResult(accepted.result)) {
    return accepted.result;
  }
  if (accepted.status === 'failed') {
    throw inventoryInboundRejected(accepted.message);
  }

  const requestedMaxWaitMs = Number(options.maxWaitMs);
  const maxWaitMs = Number.isFinite(requestedMaxWaitMs)
    ? Math.max(0, requestedMaxWaitMs)
    : DEFAULT_INVENTORY_INBOUND_TASK_WAIT_MS;
  const deadline = Date.now() + maxWaitMs;
  let pollDelayMs = 800;
  let deferred: InventoryInboundTaskDeferredResult = {
    deferred: true,
    taskId: accepted.taskId,
    kind: expectedKind,
    status: accepted.status === 'running' ? 'running' : 'pending',
    message: accepted.message,
  };
  while (Date.now() < deadline) {
    await delayInventoryInboundPoll(
      Math.min(pollDelayMs, Math.max(0, deadline - Date.now())),
    );
    if (Date.now() >= deadline) break;
    try {
      const resolution = await queryInventoryInboundTaskResult(
        accepted.taskId,
        expectedKind,
        isExpectedResult,
      );
      if (!isInventoryInboundTaskDeferred(resolution)) return resolution;
      deferred = resolution;
    } catch (error) {
      if (!isRetryableInventoryInboundPollError(error)) throw error;
      pollDelayMs = Math.min(5_000, Math.round(pollDelayMs * 1.5));
      continue;
    }
    pollDelayMs = deferred.status === 'running' ? 1_000 : 1_500;
  }
  return deferred;
}

export function waitForManualInventoryInboundTask(
  accepted: InventoryInboundAcceptedResponse,
  options: InventoryInboundTaskWaitOptions = {},
): Promise<InventoryInboundTaskWaitResult<InventoryMovementCreateResponse>> {
  return awaitInventoryInboundTaskResult(
    accepted,
    'manual',
    isInventoryMovementCreateResponse,
    options,
  );
}

export function waitForPurchaseInventoryInboundTask(
  accepted: InventoryInboundAcceptedResponse,
  options: InventoryInboundTaskWaitOptions = {},
): Promise<InventoryInboundTaskWaitResult<PurchaseInboundConfirmResponse>> {
  return awaitInventoryInboundTaskResult(
    accepted,
    'purchase',
    isPurchaseInboundConfirmResponse,
    options,
  );
}

export function queryManualInventoryInboundTask(
  taskId: string,
): Promise<InventoryInboundTaskWaitResult<InventoryMovementCreateResponse>> {
  return queryInventoryInboundTaskResult(
    taskId,
    'manual',
    isInventoryMovementCreateResponse,
  );
}

export function queryPurchaseInventoryInboundTask(
  taskId: string,
): Promise<InventoryInboundTaskWaitResult<PurchaseInboundConfirmResponse>> {
  return queryInventoryInboundTaskResult(
    taskId,
    'purchase',
    isPurchaseInboundConfirmResponse,
  );
}

function assertInventoryInboundAccepted(
  value: InventoryInboundAcceptedResponse,
  expectedKind: InventoryInboundTaskKind,
): void {
  if (
    value?.accepted !== true ||
    typeof value.taskId !== 'string' ||
    !value.taskId.trim() ||
    value.kind !== expectedKind
  ) {
    throw new Error('服务端未返回有效的入库受理任务');
  }
}

function isInventoryMovementCreateResponse(
  value: unknown,
): value is InventoryMovementCreateResponse {
  const response = value as Partial<InventoryMovementCreateResponse> | null;
  return (
    response?.success === true &&
    typeof response.recordId === 'string' &&
    typeof response.type === 'string'
  );
}

function isPurchaseInboundConfirmResponse(
  value: unknown,
): value is PurchaseInboundConfirmResponse {
  const response = value as Partial<PurchaseInboundConfirmResponse> | null;
  return (
    response?.success === true &&
    typeof response.executionRecordId === 'string' &&
    typeof response.inboundRecordId === 'string'
  );
}

function inventoryInboundRejected(message: string): Error {
  const error = new Error(message || '入库后台任务未写入');
  Object.assign(error, {
    response: {
      status: 422,
      data: { message: error.message, definitelyNotWritten: true },
    },
  });
  return error;
}

function delayInventoryInboundPoll(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isRetryableInventoryInboundPollError(error: any): boolean {
  const status = error?.response?.status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  return true;
}

export async function submitInventoryOutbound(
  data: InventoryOutboundMovementCreateRequest,
): Promise<InventoryOutboundAcceptedResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/outbounds',
    method: 'POST',
    data,
    timeout: 15_000,
  });
  return response.data as InventoryOutboundAcceptedResponse;
}

export async function submitInventoryOutboundsBatch(
  data: InventoryOutboundMovementCreateRequest[],
): Promise<InventoryBatchAcceptanceResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/outbounds/batch',
    method: 'POST',
    data,
    timeout: 30_000,
  });
  assertSuccessfulBackendResponse(response);
  return response.data as InventoryBatchAcceptanceResponse;
}

export async function getInventoryOutboundTaskStatus(
  taskId: string,
  building: WarehouseBuilding,
): Promise<InventoryOutboundTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/inventory-management/outbounds/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    params: { building },
    timeout: 15_000,
  });
  return response.data as InventoryOutboundTaskStatusResponse;
}

export async function confirmInventoryOutbound(
  recordId: string,
  data: InventoryOutboundConfirmRequest,
): Promise<InventoryOutboundConfirmResponse> {
  const response = await axiosForBackend({
    url: `/api/inventory-management/outbounds/${encodeURIComponent(recordId)}/confirm`,
    method: 'POST',
    data,
    timeout: 45_000,
  });
  return response.data;
}

export async function getPendingPurchaseInbounds(
  forceRefresh = false,
): Promise<PurchasePendingInboundResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/purchase-inbounds/pending',
    method: 'GET',
    params: { refresh: forceRefresh ? '1' : '0' },
    timeout: 120_000,
  });
  return response.data;
}

export async function confirmPurchaseInbound(
  data: PurchaseInboundConfirmRequest,
): Promise<PurchaseInboundConfirmResponse | InventoryInboundAcceptedResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/purchase-inbounds/confirm',
    method: 'POST',
    data,
    timeout: 15_000,
  });
  assertSuccessfulBackendResponse(response);
  if (isPurchaseInboundConfirmResponse(response.data)) {
    return response.data;
  }
  const accepted = response.data as InventoryInboundAcceptedResponse;
  assertInventoryInboundAccepted(accepted, 'purchase');
  return accepted;
}

export async function confirmPurchaseInboundsBatch(
  data: PurchaseInboundConfirmRequest[],
): Promise<InventoryBatchAcceptanceResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/purchase-inbounds/confirm-batch',
    method: 'POST',
    data,
    timeout: 30_000,
  });
  assertSuccessfulBackendResponse(response);
  return response.data as InventoryBatchAcceptanceResponse;
}

export async function preparePurchaseInboundCategory(
  data: PurchaseInboundCategoryPrepareRequest,
): Promise<PurchaseInboundCategoryAcceptedResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/purchase-inbounds/prepare-category',
    method: 'POST',
    data,
    timeout: 10_000,
  });
  assertSuccessfulBackendResponse(response);
  return response.data;
}

export async function getPurchaseInboundCategoryTaskStatus(
  taskId: string,
): Promise<PurchaseInboundCategoryTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/inventory-management/purchase-inbounds/category-tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 30_000,
  });
  assertSuccessfulBackendResponse(response);
  return response.data;
}

export async function getInventoryWorkflowStatus(): Promise<InventoryWorkflowStatusResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/workflows',
    method: 'GET',
    timeout: 120_000,
  });
  return response.data;
}

export async function runInventoryWorkflow(
  code: InventoryWorkflowCode,
): Promise<InventoryWorkflowRunResult> {
  const response = await axiosForBackend({
    url: `/api/inventory-management/workflows/${encodeURIComponent(code)}/run`,
    method: 'POST',
    timeout: 120_000,
  });
  return response.data;
}

export async function runInventoryWorkflowSelfTest(): Promise<InventoryWorkflowSelfTestResponse> {
  const response = await axiosForBackend({
    url: '/api/inventory-management/workflows/self-test',
    method: 'POST',
    timeout: 180_000,
  });
  return response.data;
}

export async function getPurchaseApplicationOptions(): Promise<PurchaseApplicationOptionsResponse> {
  const response = await axiosForBackend({
    url: '/api/purchase-inventory/application-options',
    method: 'GET',
    timeout: 120_000,
  });
  return response.data;
}

export async function searchPurchaseApplicationCatalog(
  params: PurchaseApplicationCatalogSearchParams,
): Promise<PurchaseApplicationCatalogItem[]> {
  const response = await axiosForBackend({
    url: '/api/purchase-inventory/catalog-search',
    method: 'GET',
    params,
    timeout: 120_000,
  });
  return response.data;
}

export async function searchPurchaseApplicationApplicants(
  params: PurchaseApplicationApplicantSearchParams,
): Promise<PurchaseApplicationApplicant[]> {
  const response = await axiosForBackend({
    url: '/api/purchase-inventory/applicant-search',
    method: 'GET',
    params,
    timeout: params.self ? 15_000 : 120_000,
  });
  if (!Array.isArray(response.data)) {
    throw new Error('申请人搜索返回格式无效');
  }
  return response.data;
}

export async function submitPurchaseApplications(
  payload: PurchaseApplicationBatchRequest,
  files: File[],
  idempotencyKey: string,
  idempotencyFingerprint: string,
): Promise<PurchaseApplicationSubmissionResponse> {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  files.forEach((file) => form.append('comparisonAttachments', file));
  const response = await axiosForBackend({
    url: '/api/purchase-inventory/applications',
    method: 'POST',
    data: form,
    headers: {
      'X-Idempotency-Key': idempotencyKey,
      'X-Idempotency-Fingerprint': idempotencyFingerprint,
    },
    timeout: 30_000,
  });
  return response.data;
}

export async function getPurchaseApplicationSubmissionTaskStatus(
  taskId: string,
): Promise<PurchaseApplicationSubmissionTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/applications/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 15_000,
  });
  return response.data;
}

export async function getPurchaseWorkflowDetail(
  recordId: string,
): Promise<PurchaseWorkflowDetail> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/workflows/${encodeURIComponent(recordId)}`,
    method: 'GET',
    timeout: 120_000,
  });
  return response.data;
}

export async function getPurchaseWorkflowOperationalStatus(): Promise<PurchaseWorkflowOperationalStatus> {
  const response = await axiosForBackend({
    url: '/api/purchase-inventory/workflows/status',
    method: 'GET',
    timeout: 120_000,
  });
  return response.data;
}

export async function approvePurchaseWorkflow(
  recordId: string,
  input: PurchaseWorkflowApprovalInput,
): Promise<PurchaseWorkflowCommandResult> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/workflows/${encodeURIComponent(recordId)}/approve`,
    method: 'POST',
    data: input,
    timeout: 120_000,
  });
  return response.data;
}

export async function startPurchaseWorkflow(
  recordId: string,
): Promise<PurchaseWorkflowCommandResult> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/workflows/${encodeURIComponent(recordId)}/start`,
    method: 'POST',
    timeout: 120_000,
  });
  return response.data;
}

export async function submitPurchaseWorkflowOrder(
  recordId: string,
  input: Omit<PurchaseWorkflowOrderInput, 'paymentAttachmentTokens'>,
  paymentAttachments: File[],
): Promise<PurchaseWorkflowCommandResult> {
  const form = new FormData();
  form.append('payload', JSON.stringify(input));
  paymentAttachments.forEach((file) => form.append('paymentAttachments', file));
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/workflows/${encodeURIComponent(recordId)}/order`,
    method: 'POST',
    data: form,
    timeout: 180_000,
  });
  return response.data;
}

export async function submitPurchaseWorkflowReceipt(
  recordId: string,
  input: Omit<
    PurchaseWorkflowReceiptInput,
    'receiptPhotoTokens' | 'invoiceTokens'
  >,
  receiptPhotos: File[],
  invoices: File[],
): Promise<PurchaseWorkflowReceiptAcceptedResponse> {
  const form = new FormData();
  form.append('payload', JSON.stringify({ ...input, clientMutationId: input.clientMutationId || crypto.randomUUID() }));
  receiptPhotos.forEach((file) => form.append('receiptPhotos', file));
  invoices.forEach((file) => form.append('invoices', file));
  const response = await retryPurchaseReceiptAcceptance(() =>
    axiosForBackend({
      url: `/api/purchase-inventory/workflows/${encodeURIComponent(recordId)}/receive`,
      method: 'POST',
      data: form,
      timeout: 45_000,
    }),
  );
  return response.data as PurchaseWorkflowReceiptAcceptedResponse;
}

export async function getPurchaseWorkflowReceiptTaskStatus(
  taskId: string,
): Promise<PurchaseWorkflowReceiptTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/purchase-inventory/workflows/receipt-tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 15_000,
  });
  return response.data as PurchaseWorkflowReceiptTaskStatusResponse;
}

/**
 * GET /api/buildings - 获取所有楼栋的基础信息
 */
export async function getBuildings(): Promise<Building[]> {
  try {
    const response = await axiosForBackend({
      url: '/api/buildings',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取楼栋信息失败', error);
    throw error;
  }
}

/**
 * GET /api/duty-schedules - 获取指定日期范围内的排班数据
 */
export async function getDutySchedules(
  startDate?: string,
  endDate?: string,
): Promise<DutySchedule[]> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules',
      method: 'GET',
      params: { startDate, endDate },
    });
    return response.data;
  } catch (error) {
    logger.error('获取排班数据失败', error);
    throw error;
  }
}

const DUTY_PAGE_READ_TIMEOUT_MS = 15_000;
const EMERGENCY_DUTY_READ_TIMEOUT_MS = DUTY_PAGE_READ_TIMEOUT_MS;
const EMERGENCY_DUTY_WRITE_TIMEOUT_MS = 60_000;

function assertSuccessfulBackendResponse(response: {
  status?: unknown;
  data?: unknown;
}): void {
  if (
    typeof response.status === 'number' &&
    (response.status < 200 || response.status >= 300)
  ) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { response });
  }
}

function isEmergencyDutyUpsertResponse(
  value: unknown,
  expectedRequest: EmergencyDutyUpsertRequest,
): value is EmergencyDutyUpsertResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  const record =
    response.record && typeof response.record === 'object'
      ? (response.record as Record<string, unknown>)
      : null;
  if (
    response.clientMutationId !== expectedRequest.clientMutationId ||
    (response.syncStatus !== 'synced' &&
      response.syncStatus !== 'cache_refresh_pending') ||
    !record ||
    typeof record.recordId !== 'string' ||
    record.recordId.trim().length === 0 ||
    record.date !== expectedRequest.date ||
    !Array.isArray(record.people) ||
    record.building !== null
  ) {
    return false;
  }
  const expectedPersonKeys = new Set(expectedRequest.personKeys);
  if (record.people.length !== expectedPersonKeys.size) return false;
  const responsePersonKeys = new Set<string>();
  const peopleAreCanonical = record.people.every((person) => {
    if (!person || typeof person !== 'object') return false;
    const candidate = person as Record<string, unknown>;
    if (
      typeof candidate.key !== 'string' ||
      candidate.key.trim().length === 0 ||
      responsePersonKeys.has(candidate.key) ||
      !expectedPersonKeys.has(candidate.key) ||
      typeof candidate.name !== 'string' ||
      candidate.name.trim().length === 0 ||
      typeof candidate.role !== 'string' ||
      candidate.role.trim().length === 0
    ) {
      return false;
    }
    responsePersonKeys.add(candidate.key);
    return true;
  });
  return (
    peopleAreCanonical && responsePersonKeys.size === expectedPersonKeys.size
  );
}

export async function getEmergencyDutySchedules(
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<EmergencyDutyScheduleResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/emergency-duty',
    method: 'GET',
    params: { startDate, endDate },
    signal,
    timeout: EMERGENCY_DUTY_READ_TIMEOUT_MS,
  });
  return response.data as EmergencyDutyScheduleResponse;
}

export async function getEmergencyDutyOptions(
  signal?: AbortSignal,
): Promise<EmergencyDutyOptionsResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/emergency-duty/options',
    method: 'GET',
    signal,
    timeout: EMERGENCY_DUTY_READ_TIMEOUT_MS,
  });
  return response.data as EmergencyDutyOptionsResponse;
}

export async function upsertEmergencyDutySchedule(
  payload: EmergencyDutyUpsertRequest,
  signal?: AbortSignal,
): Promise<EmergencyDutyUpsertResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/emergency-duty',
    method: 'POST',
    data: payload,
    signal,
    timeout: EMERGENCY_DUTY_WRITE_TIMEOUT_MS,
  });
  assertSuccessfulBackendResponse(response);
  if (!isEmergencyDutyUpsertResponse(response.data, payload)) {
    throw Object.assign(new Error('应急值班响应格式无效，写入结果待确认'), {
      response,
      writeDisposition: 'unknown-result' as const,
    });
  }
  return response.data;
}

/**
 * GET /api/duty-schedules/work-calendar - 获取服务端已校验的法定工作日历快照
 */
export async function getChinaWorkCalendar(): Promise<ChinaWorkCalendarResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/work-calendar',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取法定工作日历失败', error);
    throw error;
  }
}

/**
 * POST /api/duty-schedules/batch - 批量创建或更新排班数据
 */
export async function batchUpsertDutySchedules(
  schedules: BatchDutyScheduleRequest,
): Promise<BatchDutyScheduleResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/batch',
      method: 'POST',
      data: schedules,
    });
    return response.data;
  } catch (error) {
    logger.error('批量创建/更新排班数据失败', error);
    throw error;
  }
}

/**
 * GET /api/monthly-schedules/:year/:month - 获取指定年月的值班数据
 */
export async function getMonthlySchedules(
  year: number,
  month: number,
  forceRefresh = false,
): Promise<MonthlyScheduleResponse> {
  try {
    const response = await requestWithRetry(
      () =>
        axiosForBackend({
          url: `/api/monthly-schedules/${year}/${month}`,
          method: 'GET',
          ...(forceRefresh ? { params: { refresh: 'true' } } : {}),
        }),
      3,
      1000,
      isRetryableMonthlyScheduleReadError,
    );
    return response.data;
  } catch (error) {
    logger.error('获取月度值班数据失败', error);
    throw error;
  }
}

export async function getScheduleSnapshotRevision(
  signal?: AbortSignal,
): Promise<ScheduleSnapshotRevisionResponse> {
  const response = await axiosForBackend({
    url: '/api/bitable/schedule-snapshot-revision',
    method: 'GET',
    signal,
    timeout: 10_000,
  });
  return response.data as ScheduleSnapshotRevisionResponse;
}

function isRetryableMonthlyScheduleReadError(error: any): boolean {
  const status = error?.response?.status;
  const code = error?.code;
  return (
    [
      'ERR_NETWORK',
      'ECONNABORTED',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
    ].includes(code) ||
    (typeof status === 'number' && status >= 500)
  );
}

/**
 * GET /api/duty-program-modified/scan - 扫描程序修改字段异常
 */
export async function checkMonthlyScheduleScreenshotAccess(
  payload: MonthlyScheduleScreenshotAccessRequest,
): Promise<MonthlyScheduleScreenshotAccessResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/monthly-schedules/access/screenshot-check',
      method: 'POST',
      data: payload,
    });
    return response.data;
  } catch (error) {
    logger.error('排班一览截图模式校验失败', error);
    throw error;
  }
}

export async function scanDutyProgramModifiedIssues(
  limit = 200,
  refresh = false,
): Promise<DutyStaffActualRepairScanResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-program-modified/scan',
      method: 'GET',
      params: { limit, refresh: refresh ? '1' : undefined },
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('扫描值班人员（实际）程序修改字段异常失败', error);
    throw error;
  }
}

/**
 * POST /api/duty-program-modified/repair - 修正程序修改字段异常
 */
export async function repairDutyProgramModifiedIssues(
  payload: DutyStaffActualRepairRequest = {},
): Promise<DutyStaffActualRepairResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-program-modified/repair',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('修正值班人员（实际）程序修改字段异常失败', error);
    throw error;
  }
}

export async function updateVacancySubstitutes(
  payload: VacancySubstituteUpdateRequest,
): Promise<VacancySubstituteUpdateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/vacancy-substitute',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交缺岗替班人员失败', error);
    throw error;
  }
}

export async function updateDutyStaffAdjustment(
  payload: DutyStaffAdjustmentRequest,
): Promise<DutyStaffAdjustmentResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/staff-adjustment',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交值班人员修正失败', error);
    throw error;
  }
}

export async function updateTravelStaff(
  payload: TravelStaffUpdateRequest,
): Promise<TravelStaffUpdateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/travel-staff',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交差旅人员失败', error);
    throw error;
  }
}

export async function getTravelStaffDetails(
  params: {
    startDate?: string;
    endDate?: string;
    staffName?: string;
    refresh?: boolean;
  } = {},
): Promise<TravelStaffDetailResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/travel-staff',
      method: 'GET',
      params: {
        startDate: params.startDate,
        endDate: params.endDate,
        staffName: params.staffName,
        refresh: params.refresh ? '1' : undefined,
      },
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('加载差旅人员详情失败', error);
    throw error;
  }
}

export async function getLongWhiteDutyStaff(
  date: string,
  refresh = false,
): Promise<LongWhiteDutyStaffResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/long-white-duty-staff',
      method: 'GET',
      params: {
        date,
        refresh: refresh ? '1' : undefined,
      },
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('加载长白班在岗人员失败', error);
    throw error;
  }
}

export async function adjustTravelStaff(
  payload: TravelStaffAdjustRequest,
): Promise<TravelStaffMutationResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/travel-staff/adjust',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('调整差旅人员失败', error);
    throw error;
  }
}

export async function revokeTravelStaff(
  payload: TravelStaffRevokeRequest,
): Promise<TravelStaffMutationResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/travel-staff/revoke',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('撤回差旅人员失败', error);
    throw error;
  }
}

export async function createPersonnelMovement(
  payload: PersonnelMovementCreateRequest,
): Promise<PersonnelMovementCreateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/personnel-movement',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交人员异动失败', error);
    throw error;
  }
}

export async function createAdditionalMatter(
  payload: AdditionalMatterCreateRequest,
): Promise<AdditionalMatterCreateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/additional-matter',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交其他事宜补充失败', error);
    throw error;
  }
}

export async function createSealingRegistration(
  payload: SealingRegistrationCreateRequest,
): Promise<SealingRegistrationCreateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/sealing-registration',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交封网登记失败', error);
    throw error;
  }
}

export async function createLeaveRequest(
  payload: LeaveRequestCreateRequest,
  screenshot: File,
): Promise<LeaveRequestCreateResponse> {
  try {
    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));
    formData.append('screenshot', screenshot);
    const response = await axiosForBackend({
      url: '/api/duty-schedules/leave-request',
      method: 'POST',
      data: formData,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交请休假失败', error);
    throw error;
  }
}

export async function createOvertimeRequest(
  payload: OvertimeRequestCreateRequest,
  screenshot: File,
): Promise<OvertimeRequestCreateResponse> {
  try {
    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));
    formData.append('screenshot', screenshot);
    const response = await axiosForBackend({
      url: '/api/duty-schedules/overtime-request',
      method: 'POST',
      data: formData,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交加班失败', {
      code: 'OVERTIME_REQUEST_TRANSPORT_FAILED',
    });
    throw error;
  }
}

export async function getOvertimeConfirmationDetail(
  recordId: string,
  ticket: string,
  signal?: AbortSignal,
): Promise<OvertimeConfirmationDetailResponse> {
  const response = await axiosForBackend({
    url: `/api/overtime-workflow/confirm/${encodeURIComponent(recordId)}`,
    method: 'GET',
    headers: { 'X-Overtime-Confirmation-Ticket': ticket },
    signal,
    timeout: 15_000,
  });
  return response.data as OvertimeConfirmationDetailResponse;
}

export async function submitOvertimeConfirmation(
  recordId: string,
  ticket: string,
  idempotencyKey: string,
  payload: OvertimeConfirmationSubmitPayload,
): Promise<OvertimeConfirmationAcceptedResponse> {
  const response = await axiosForBackend({
    url: `/api/overtime-workflow/confirm/${encodeURIComponent(recordId)}`,
    method: 'POST',
    headers: {
      'X-Overtime-Confirmation-Ticket': ticket,
      'X-Idempotency-Key': idempotencyKey,
    },
    data: payload,
    timeout: 15_000,
  });
  return response.data as OvertimeConfirmationAcceptedResponse;
}

export async function createChangeRequest(
  payload: ChangeRequestCreateRequest,
  documents: File[] = [],
): Promise<ChangeRequestCreateResponse> {
  if (documents.length === 0) {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/change-request',
      method: 'POST',
      data: payload,
      timeout: 60000,
    });
    return response.data;
  }

  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  documents.forEach((document) => {
    formData.append('documents', document);
  });

  const response = await axiosForBackend({
    url: '/api/duty-schedules/change-request',
    method: 'POST',
    data: formData,
    timeout: 60000,
  });
  return response.data;
}

export async function getChangeRequestSyncTaskStatus(
  taskId: string,
): Promise<SyncTaskStatusResponse> {
  const response = await axiosForBackend({
    url: `/api/duty-schedules/change-request-sync/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 30000,
  });
  return response.data as SyncTaskStatusResponse;
}

export async function stageChangeAttachment(
  file: File,
  ownerMutationId: string,
  onProgress?: (progress: number) => void,
): Promise<ChangeAttachmentStageResponse['document']> {
  const formData = new FormData();
  formData.append('ownerMutationId', ownerMutationId);
  formData.append('file', file);
  const response = await axiosForBackend({
    url: '/api/duty-schedules/change-attachments/stage',
    method: 'POST',
    data: formData,
    timeout: 30 * 60 * 1000,
    onUploadProgress: (event: { loaded: number; total?: number }) => {
      if (!event.total || event.total <= 0) return;
      onProgress?.((event.loaded / event.total) * 100);
    },
  });
  return (response.data as ChangeAttachmentStageResponse).document;
}

export async function deleteChangeAttachment(
  id: string,
  ownerMutationId: string,
): Promise<void> {
  const response = await axiosForBackend({
    url: `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/delete`,
    method: 'POST',
    data: { ownerMutationId },
    timeout: 30_000,
  });
  void (response.data as ChangeAttachmentDeleteResponse);
}

export async function createChangeAdjustment(
  payload: ChangeAdjustmentRequest,
): Promise<ChangeAdjustmentResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/change-adjustment',
    method: 'POST',
    data: payload,
    timeout: 420000,
  });
  return response.data;
}

export async function createChangeDrillReport(
  payload: ChangeDrillReportCreateRequest,
): Promise<ChangeDrillReportCreateResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/change-drill-report',
    method: 'POST',
    data: payload,
    timeout: 420000,
  });
  return response.data;
}

export async function createChangeSummaryReport(
  payload: ChangeSummaryReportCreateRequest,
): Promise<ChangeSummaryReportCreateResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/change-summary-report',
    method: 'POST',
    data: payload,
    timeout: 30_000,
  });
  return response.data;
}

export async function abandonChangeSummaryReport(
  payload: ChangeSummaryReportAbandonRequest,
): Promise<ChangeSummaryReportAbandonResponse> {
  const response = await axiosForBackend({
    url: '/api/duty-schedules/change-summary-report/abandon',
    method: 'POST',
    data: payload,
    timeout: 30_000,
  });
  return response.data as ChangeSummaryReportAbandonResponse;
}

export async function getChangeSummaryReportSyncTaskStatus(
  taskId: string,
  signal?: AbortSignal,
): Promise<ChangeSummaryReportSyncTaskResponse> {
  const response = await axiosForBackend({
    url: `/api/duty-schedules/change-summary-report-sync/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 30_000,
    signal,
  });
  return response.data as ChangeSummaryReportSyncTaskResponse;
}

export async function getConstructionManagement(
  forceRefresh = false,
): Promise<ConstructionManagementResponse> {
  try {
    const response =
      await constructionFetch<ConstructionManagementTransportResponse>(
        '/api/duty-schedules/construction-management',
        {
          method: 'GET',
          params: {
            compact: '1',
            ...(forceRefresh ? { refresh: '1' } : {}),
          },
          timeout: 120000,
        },
      );
    return expandConstructionManagementResponse(response);
  } catch (error) {
    logger.error('获取施工管理数据失败', error);
    throw error;
  }
}

export async function searchConstructionOnsiteFollowers(
  query = '',
  signal?: AbortSignal,
): Promise<ConstructionStaffCandidatesResponse> {
  try {
    return await constructionFetch<ConstructionStaffCandidatesResponse>(
      '/api/duty-schedules/construction-management/onsite-followers',
      {
        method: 'GET',
        params: query ? { query } : undefined,
        timeout: 120000,
        signal,
      },
    );
  } catch (error) {
    logger.error('搜索在职人员失败', error);
    throw error;
  }
}

export async function searchConstructionChangeOrders(
  query = '',
  signal?: AbortSignal,
): Promise<ConstructionChangeOrderCandidatesResponse> {
  try {
    return await constructionFetch<ConstructionChangeOrderCandidatesResponse>(
      '/api/duty-schedules/construction-management/change-orders',
      {
        method: 'GET',
        params: query ? { query } : undefined,
        timeout: 120000,
        signal,
      },
    );
  } catch (error) {
    logger.error('搜索施工关联变更单失败', error);
    throw error;
  }
}

export async function createConstructionApplication(
  payload: FormData,
): Promise<ConstructionApplicationCreateResponse> {
  try {
    const response =
      await constructionFetch<ConstructionApplicationCreateResponse>(
        '/api/duty-schedules/construction-management/applications',
        {
          method: 'POST',
          body: payload,
          timeout: 180000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '施工申请提交失败');
    }
    return response;
  } catch (error) {
    logger.error('提交施工申请失败', error);
    throw error;
  }
}

export function getConstructionAttachmentDownloadUrl(
  fileToken: string,
  fileName?: string | null,
  options: { tmpUrl?: string | null } = {},
): string {
  const query = new URLSearchParams();
  if (fileName) {
    query.set('filename', fileName);
  }
  if (options.tmpUrl) {
    query.set('tmpUrl', options.tmpUrl);
  }
  const suffix = query.toString();
  return `/api/duty-schedules/construction-management/attachments/${encodeURIComponent(fileToken)}${suffix ? `?${suffix}` : ''}`;
}

export async function createConstructionFollowup(
  payload: FormData,
): Promise<ConstructionFollowupCreateResponse> {
  try {
    const response =
      await constructionFetch<ConstructionFollowupCreateResponse>(
        '/api/duty-schedules/construction-management/followups',
        {
          method: 'POST',
          body: payload,
          timeout: 180000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '施工跟进提交失败');
    }
    return response;
  } catch (error) {
    logger.error('提交施工跟进失败', error);
    throw error;
  }
}

export async function deleteConstructionAttachment(
  payload: ConstructionAttachmentDeleteRequest,
): Promise<ConstructionAttachmentDeleteResponse> {
  try {
    const response =
      await constructionFetch<ConstructionAttachmentDeleteResponse>(
        '/api/duty-schedules/construction-management/attachments/delete',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          timeout: 120000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '删除施工附件失败');
    }
    return response;
  } catch (error) {
    logger.error('删除施工附件失败', error);
    throw error;
  }
}

export async function requestConstructionPermitManualReview(
  payload: ConstructionPermitManualReviewRequest,
): Promise<ConstructionPermitManualReviewResponse> {
  try {
    const response =
      await constructionFetch<ConstructionPermitManualReviewResponse>(
        '/api/duty-schedules/construction-management/permit-manual-review',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          timeout: 120000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '作业票人工审核触发失败');
    }
    return response;
  } catch (error) {
    logger.error('触发作业票人工审核失败', error);
    throw error;
  }
}

export async function updateConstructionPermitManualReview(
  payload: ConstructionPermitManualReviewUpdateRequest,
): Promise<ConstructionPermitManualReviewUpdateResponse> {
  try {
    const response =
      await constructionFetch<ConstructionPermitManualReviewUpdateResponse>(
        '/api/duty-schedules/construction-management/permit-manual-review/result',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          timeout: 120000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '作业票人工审核结果更新失败');
    }
    return response;
  } catch (error) {
    logger.error('更新作业票人工审核结果失败', error);
    throw error;
  }
}

export async function updateConstructionIsolationPhotoManualReview(
  payload: ConstructionIsolationPhotoManualReviewUpdateRequest,
): Promise<ConstructionIsolationPhotoManualReviewUpdateResponse> {
  try {
    const response =
      await constructionFetch<ConstructionIsolationPhotoManualReviewUpdateResponse>(
        '/api/duty-schedules/construction-management/isolation-photo-manual-review/result',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          timeout: 120000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '挂牌隔离照片人工审核结果更新失败');
    }
    return response;
  } catch (error) {
    logger.error('更新挂牌隔离照片人工审核结果失败', error);
    throw error;
  }
}

export async function deleteConstructionProject(
  payload: ConstructionProjectDeleteRequest,
): Promise<ConstructionProjectDeleteResponse> {
  try {
    const response = await constructionFetch<ConstructionProjectDeleteResponse>(
      '/api/duty-schedules/construction-management/projects/delete',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      },
    );
    if (!response?.success) {
      throw new Error(response?.message || '施工项目删除失败');
    }
    return response;
  } catch (error) {
    logger.error('删除施工项目失败', error);
    throw error;
  }
}

export async function terminateConstructionProject(
  payload: ConstructionProjectTerminateRequest,
): Promise<ConstructionProjectTerminateResponse> {
  try {
    const response =
      await constructionFetch<ConstructionProjectTerminateResponse>(
        '/api/duty-schedules/construction-management/projects/terminate',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '施工项目终止失败');
    }
    return response;
  } catch (error) {
    logger.error('终止施工项目失败', error);
    throw error;
  }
}

export async function syncConstructionCrewRosterFromOutlook(
  payload: ConstructionCrewRosterOutlookSyncRequest,
): Promise<ConstructionCrewRosterOutlookSyncResponse> {
  try {
    const response =
      await constructionFetch<ConstructionCrewRosterOutlookSyncResponse>(
        '/api/duty-schedules/construction-management/projects/crew-roster/outlook-sync',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '施工人员名单更新失败');
    }
    return response;
  } catch (error) {
    logger.error('从 Outlook 更新施工人员名单失败', error);
    throw error;
  }
}

export async function syncConstructionCrewRosterFromUpload(
  payload: FormData,
): Promise<ConstructionCrewRosterUploadSyncResponse> {
  try {
    const response =
      await constructionFetch<ConstructionCrewRosterUploadSyncResponse>(
        '/api/duty-schedules/construction-management/projects/crew-roster/upload-sync',
        {
          method: 'POST',
          body: payload,
          timeout: 45000,
        },
      );
    if (!response?.success) {
      throw new Error(response?.message || '施工人员名单更新失败');
    }
    return response;
  } catch (error) {
    logger.error('手动上传施工人员名单更新失败', error);
    throw error;
  }
}

export async function getSyncTaskStatus(
  taskId: string,
): Promise<SyncTaskStatusResponse> {
  try {
    return await constructionFetch<SyncTaskStatusResponse>(
      `/api/sync-task/${encodeURIComponent(taskId)}`,
      {
        method: 'GET',
        timeout: 30000,
      },
    );
  } catch (error) {
    logger.error('查询后台任务状态失败', error);
    throw error;
  }
}

export async function createExceptionFollowUp(
  payload: ExceptionFollowUpCreateRequest,
): Promise<ExceptionFollowUpCreateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/exception-follow-up',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交异常跟进失败', error);
    throw error;
  }
}

export async function getExceptionFollowUps(
  date?: string,
  forceRefresh = false,
  endDate?: string,
): Promise<ExceptionFollowUpListResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/exception-follow-ups',
      method: 'GET',
      params: {
        ...(date ? { date } : {}),
        ...(endDate ? { endDate } : {}),
        ...(forceRefresh ? { refresh: '1' } : {}),
      },
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取异常跟进记录失败', error);
    throw error;
  }
}

export async function updateExceptionFollowUp(
  payload: ExceptionFollowUpUpdateRequest,
): Promise<ExceptionFollowUpUpdateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/exception-follow-up/update',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('更新异常跟进失败', error);
    throw error;
  }
}

export async function deleteExceptionFollowUp(
  payload: ExceptionFollowUpDeleteRequest,
): Promise<ExceptionFollowUpDeleteResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/exception-follow-up/delete',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('删除异常跟进失败', error);
    throw error;
  }
}

/**
 * POST /api/sync-from-feishu - 从飞书多维表格同步数据
 * 增加5分钟超时时间，防止504超时错误
 */
export async function syncFromFeishuBase(): Promise<{
  success: boolean;
  total: number;
  message: string;
}> {
  try {
    const response = await requestWithRetry(() =>
      axiosForBackend({
        url: '/api/sync-from-feishu',
        method: 'POST',
        timeout: 300000, // 5分钟超时
      }),
    );
    return response.data;
  } catch (error) {
    logger.error('从飞书同步数据失败', error);
    throw error;
  }
}

/**
 * GET /api/last-sync-time - 获取最后同步时间
 */
export async function syncAllFromFeishu(): Promise<{
  success: boolean;
  message: string;
  syncedAt?: string;
  failed?: Array<{ key: string; name: string; message: string }>;
  results?: Record<string, unknown>;
}> {
  try {
    const response = await axiosForBackend({
      url: '/api/sync-all-from-feishu',
      method: 'POST',
      timeout: 600000,
    });
    return response.data;
  } catch (error) {
    logger.error('手动同步飞书数据到本地库失败', error);
    throw error;
  }
}

export async function syncDutyScheduleToLocalFast(): Promise<{
  success: boolean;
  total: number;
  reset: number;
  ruleUpdated: number;
  localSynced: number;
  failed: number;
  failures?: Array<{ recordId: string; error: string }>;
  durationMs: number;
  message: string;
}> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-schedules/sync-local-fast',
      method: 'POST',
      timeout: 180000,
    });
    return response.data;
  } catch (error) {
    logger.error('同步排班数据到本地库失败', error);
    throw error;
  }
}

/**
 * POST /api/duty-overview-screenshot/send - 生成并发送值班概览截图到飞书群
 */
export async function sendDutyOverviewScreenshot(
  date?: string,
): Promise<DutyOverviewScreenshotResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/duty-overview-screenshot/send',
      method: 'POST',
      data: date ? { date } : {},
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('发送值班概览截图失败', error);
    throw error;
  }
}

/**
 * GET /api/typhoon-path-screenshot/preview - 新鲜检查台风预警和发送间隔
 */
export async function getTyphoonPathScreenshotPreview(): Promise<TyphoonPathScreenshotPreviewResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/typhoon-path-screenshot/preview',
      method: 'GET',
      params: { _t: Date.now() },
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      timeout: 15_000,
    });
    return response.data;
  } catch (error) {
    logger.error('检查台风路径图发送条件失败', error);
    throw error;
  }
}

/**
 * POST /api/typhoon-path-screenshot/send-group - 经服务端复核后发送台风路径图
 */
export async function sendTyphoonPathGroupScreenshot(
  request: TyphoonPathGroupScreenshotRequest,
): Promise<TyphoonPathGroupScreenshotResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/typhoon-path-screenshot/send-group',
      method: 'POST',
      data: request,
      timeout: 180000,
    });
    return response.data;
  } catch (error) {
    logger.error('发送台风路径截图失败', error);
    throw error;
  }
}

export async function getLastSyncTime(): Promise<LastSyncTimeResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/last-sync-time',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取最后同步时间失败', error);
    throw error;
  }
}

/**
 * POST /api/bitable/sync - 从飞书多维表格同步数据
 */
export async function syncFromBitable(): Promise<BitableSyncResponse> {
  try {
    const response = await requestWithRetry(() =>
      axiosForBackend({
        url: '/api/bitable/sync',
        method: 'POST',
        timeout: 300000, // 5分钟超时
      }),
    );
    return response.data;
  } catch (error) {
    logger.error('从飞书多维表同步数据失败', error);
    throw error;
  }
}

export async function getCampusOperationsDashboard(
  forceRefresh = false,
  screenshotAccess?: {
    screenshotDate: string | null;
    screenshotShift: 'white' | 'night' | null;
    screenshotToken: string | null;
  },
): Promise<CampusOperationsDashboardResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/campus-operations-dashboard',
      method: 'GET',
      params:
        forceRefresh || screenshotAccess
          ? {
              ...(forceRefresh ? { forceRefresh: '1' } : {}),
              ...(screenshotAccess?.screenshotDate
                ? { screenshotDate: screenshotAccess.screenshotDate }
                : {}),
              ...(screenshotAccess?.screenshotShift
                ? { screenshotShift: screenshotAccess.screenshotShift }
                : {}),
              ...(screenshotAccess?.screenshotToken
                ? { screenshotToken: screenshotAccess.screenshotToken }
                : {}),
            }
          : undefined,
      headers: forceRefresh ? { 'Cache-Control': 'no-cache' } : undefined,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取园区运行仪表盘数据失败', error);
    throw error;
  }
}

export async function getTodayOperationsAlarmDashboard(
  options: {
    date?: string;
    page?: number;
    pageSize?: number;
    metric?: TodayOperationsAlarmMetric;
    building?: string;
    level?: TodayOperationsAlarmLevel;
    status?: TodayOperationsAlarmHandlingStatus;
    processingStatus?: TodayOperationsAlarmProcessingStatus;
    recoveryStatus?: TodayOperationsAlarmRecoveryStatus;
    q?: string;
    tagIssueCode?: string;
    refresh?: boolean;
  } = {},
): Promise<TodayOperationsAlarmDashboardResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/today-operations-alarms',
      method: 'GET',
      params: {
        date: options.date,
        page: options.page,
        pageSize: options.pageSize,
        metric: options.metric,
        building: options.building,
        level: options.level,
        status: options.status,
        processingStatus: options.processingStatus,
        recoveryStatus: options.recoveryStatus,
        q: options.q,
        tagIssueCode: options.tagIssueCode,
        refresh: options.refresh ? '1' : undefined,
      },
      headers: options.refresh ? { 'Cache-Control': 'no-cache' } : undefined,
      timeout: 20000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取今日全景告警数据失败', error);
    throw error;
  }
}

export async function askNantongAssistant(
  request: NantongAssistantChatRequest,
  signal?: AbortSignal,
): Promise<NantongAssistantChatResponse> {
  const response = await axiosForBackend({
    url: '/api/bitable/nantong-assistant/chat',
    method: 'POST',
    data: request,
    signal,
    timeout: 95_000,
  });
  return response.data;
}

export async function getTodayOperationsOverview(
  forceRefresh = false,
): Promise<TodayOperationsOverviewResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/today-operations-overview',
      method: 'GET',
      params: forceRefresh ? { refresh: '1' } : undefined,
      headers: forceRefresh ? { 'Cache-Control': 'no-cache' } : undefined,
      timeout: forceRefresh ? 60_000 : 20_000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取今日全景运行概览失败', error);
    throw error;
  }
}

export async function getTodayOperationsKpis(
  options: { refresh?: boolean } = {},
): Promise<TodayOperationsKpiResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/today-operations-kpis',
      method: 'GET',
      params: {
        refresh: options.refresh ? '1' : undefined,
      },
      headers: options.refresh ? { 'Cache-Control': 'no-cache' } : undefined,
      timeout: 20000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取今日全景顶部指标失败', error);
    throw error;
  }
}

export async function getCampusTrainingDashboard(
  month?: string,
  forceRefresh = false,
): Promise<CampusTrainingDashboardResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/campus-training-dashboard',
      method: 'GET',
      params: {
        ...(month ? { month } : {}),
        ...(forceRefresh ? { forceRefresh: '1' } : {}),
      },
      headers: forceRefresh ? { 'Cache-Control': 'no-cache' } : undefined,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取园区培训看板数据失败', error);
    throw error;
  }
}

export async function getCampusCertificateDashboard(
  forceRefresh = false,
): Promise<CampusCertificateDashboardResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/campus-certificate-dashboard',
      method: 'GET',
      params: forceRefresh ? { forceRefresh: '1' } : undefined,
      headers: forceRefresh ? { 'Cache-Control': 'no-cache' } : undefined,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取园区持证看板数据失败', error);
    throw error;
  }
}

export async function getCampusCertificateExpiryNotificationPreview(): Promise<CampusCertificateExpiryNotificationPreview> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/campus-certificate-dashboard/expiry-notification-preview',
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取证件到期飞书通知预检结果失败', error);
    throw error;
  }
}

export async function sendCampusCertificateExpiryNotifications(
  request: CampusCertificateExpiryNotificationRequest,
): Promise<CampusCertificateExpiryNotificationResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/campus-certificate-dashboard/notify-expiring',
      method: 'POST',
      data: request,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('发送证件到期飞书通知失败', error);
    throw error;
  }
}

/**
 * POST /api/bitable/sync-non-duty - 同步非值班排班数据
 */
export async function syncNonDutySchedule(): Promise<{
  success: boolean;
  message: string;
  count?: number;
}> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/sync-non-duty',
      method: 'POST',
      timeout: 300000, // 5分钟超时
    });
    return response.data;
  } catch (error) {
    logger.error('同步非值班排班数据失败', error);
    throw error;
  }
}

/**
 * GET /api/sealing-info/:year - 获取指定年份的封网信息
 */
export async function getYearlySealingInfo(
  year: number,
  refresh = false,
): Promise<YearlySealingInfoResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/sealing-info/${year}`,
      method: 'GET',
      params: { refresh: refresh ? '1' : undefined },
      headers: { 'Cache-Control': 'no-cache' },
    });
    return response.data;
  } catch (error) {
    logger.error('获取年度封网信息失败', error);
    throw error;
  }
}

export async function getYearlyChangeInfo(
  year: number,
  forceRefresh = false,
  signal?: AbortSignal,
): Promise<YearlyChangeInfoResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/change-info/${year}`,
      method: 'GET',
      params: forceRefresh ? { refresh: '1' } : undefined,
      timeout: DUTY_PAGE_READ_TIMEOUT_MS,
      signal,
    });
    return response.data;
  } catch (error) {
    logger.error('获取年度计划变更信息失败', error);
    throw error;
  }
}

export async function updateChangeScheduleAdjustment(
  payload: ChangeScheduleAdjustmentRequest,
): Promise<ChangeScheduleAdjustmentResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/change-info/adjustment',
      method: 'POST',
      data: payload,
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    logger.error('提交变更计划调整失败', error);
    throw error;
  }
}

/**
 * GET /api/today-focus-checklist - 获取今日园区重点关注清单
 */
export async function getTodayFocusChecklist(
  date?: string,
  forceRefresh = false,
): Promise<TodayFocusChecklistResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/today-focus-checklist',
      method: 'GET',
      params: {
        ...(date ? { date } : {}),
        ...(forceRefresh ? { refresh: '1' } : {}),
      },
    });
    return response.data;
  } catch (error) {
    logger.error('获取今日园区重点关注清单失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/records - 获取已同步的多维表记录
 */
export async function getBitableRecords(
  page = 1,
  pageSize = 20,
): Promise<BitableRecordsResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/records',
      method: 'GET',
      params: { page, pageSize },
    });
    return response.data;
  } catch (error) {
    logger.error('获取多维表记录失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/last-sync-time - 获取多维表最后同步时间
 */
export async function getBitableLastSyncTime(): Promise<LastSyncTimeResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/last-sync-time',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取多维表最后同步时间失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/weather/now - 获取实时天气数据
 */
export async function getQWeatherNow(options?: {
  signal?: AbortSignal;
}): Promise<QWeatherNow> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/weather/now',
      method: 'GET',
      signal: options?.signal,
    });
    return response.data;
  } catch (error) {
    logger.error('获取天气数据失败', error);
    throw error;
  }
}

/**
 * GET /api/weather-warning/snapshot - 获取天气重保预警统一快照
 */
export async function getWeatherWarningSnapshot(options?: {
  signal?: AbortSignal;
}): Promise<WeatherWarningSnapshot> {
  try {
    const response = await axiosForBackend({
      url: '/api/weather-warning/snapshot',
      method: 'GET',
      params: { t: Date.now() },
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      timeout: 20_000,
      signal: options?.signal,
    });
    return response.data;
  } catch (error) {
    logger.error('获取天气重保预警快照失败', error);
    throw error;
  }
}

/**
 * GET /api/weather-warning/test-preview - 管理员测试卡片发送前预览
 */
export async function getWeatherWarningTestPreview(): Promise<WeatherWarningTestPreviewResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/weather-warning/test-preview',
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      timeout: 20_000,
    });
    return response.data;
  } catch (error) {
    logger.error('获取天气预警测试卡片预览失败', error);
    throw error;
  }
}

/**
 * POST /api/weather-warning/test-send - 经服务端复核后发送天气预警测试卡片
 */
export async function sendWeatherWarningTestCard(
  request: WeatherWarningTestSendRequest,
): Promise<WeatherWarningTestSendResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/weather-warning/test-send',
      method: 'POST',
      data: request,
      timeout: 30_000,
    });
    return response.data;
  } catch (error) {
    logger.error('发送天气预警测试卡片失败', error);
    throw error;
  }
}

/**
 * GET /api/weather-warning/registration/options - 获取天气重保登记选项
 */
export async function getWeatherGuardRegistrationOptions(
  warningId: string,
  signal?: AbortSignal,
): Promise<WeatherGuardRegistrationOptions> {
  try {
    const response = await axiosForBackend({
      url: '/api/weather-warning/registration/options',
      method: 'GET',
      params: { warningId },
      timeout: 20_000,
      signal,
    });
    return response.data;
  } catch (error) {
    if (!isAbortedWeatherGuardRegistrationRequest(error, signal)) {
      logger.error('获取天气重保登记选项失败', error);
    }
    throw error;
  }
}

/**
 * POST /api/weather-warning/registration - 提交天气重保登记
 */
export async function submitWeatherGuardRegistration(
  formData: FormData,
  signal?: AbortSignal,
): Promise<WeatherGuardRegistrationResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/weather-warning/registration',
      method: 'POST',
      data: formData,
      timeout: 60_000,
      signal,
    });
    assertSuccessfulBackendResponse(response);
    return response.data;
  } catch (error) {
    if (!isAbortedWeatherGuardRegistrationRequest(error, signal)) {
      logger.error('提交天气重保登记失败', error);
    }
    throw error;
  }
}

function isAbortedWeatherGuardRegistrationRequest(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (!signal?.aborted || !error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.code === 'ERR_CANCELED' ||
    candidate.code === 'ECANCELED' ||
    candidate.name === 'AbortError' ||
    candidate.name === 'CanceledError'
  );
}

/**
 * GET /api/bitable/weather/warning - 获取天气预警信息
 */
export async function getQWeatherWarning(): Promise<QWeatherWarning> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/weather/warning',
      method: 'GET',
      params: { t: Date.now() },
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    return response.data;
  } catch (error) {
    logger.error('获取天气预警失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/weather/hourly - 获取逐小时天气预报
 */
export async function getQWeatherHourly(options?: {
  signal?: AbortSignal;
}): Promise<QWeatherHourly> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/weather/hourly',
      method: 'GET',
      signal: options?.signal,
    });
    return response.data;
  } catch (error) {
    logger.error('获取逐小时天气预报失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/organizations - 获取组织架构列表
 */
export async function getOrganizations(): Promise<NantongOrganizationResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/organizations',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取组织架构列表失败', error);
    throw error;
  }
}

export async function getOrganizationPersonProfile(
  source: OrganizationPersonProfileSource,
  recordId: string,
  signal?: AbortSignal,
): Promise<OrganizationPersonProfileResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/bitable/organization-person-profile/${encodeURIComponent(source)}/${encodeURIComponent(recordId)}`,
      method: 'GET',
      signal,
    });
    return response.data;
  } catch (error) {
    logger.error('获取人员档案失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/person-profiles - 获取排班页人员资料
 */
export type PersonProfileScope = 'leave' | 'travel';

export async function getPersonProfiles(
  forceRefresh = false,
  scope: PersonProfileScope = 'leave',
  signal?: AbortSignal,
): Promise<NantongOrganizationResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/person-profiles',
      method: 'GET',
      params: {
        scope,
        ...(forceRefresh ? { forceRefresh: '1' } : {}),
      },
      timeout: DUTY_PAGE_READ_TIMEOUT_MS,
      signal,
    });
    const publicResponse = response.data as PersonProfileResponse;
    return {
      organizations: (publicResponse.organizations || []).map(
        (profile, index) => {
          const syntheticId = `person-profile-${scope}-${index + 1}`;
          return {
            id: syntheticId,
            recordId: syntheticId,
            code: null,
            position: profile.position,
            buildingsSpecialties: profile.buildingsSpecialties,
            supervisor: null,
            dutyAccount: [],
            supervisorText: profile.supervisorText,
            parentRecord: null,
            photoUrl: null,
            email: null,
            phone: null,
            shift: profile.shift,
            createdAt: '',
            updatedAt: '',
          };
        },
      ),
      changeRequestSubmitters: publicResponse.changeRequestSubmitters || [],
    };
  } catch (error) {
    logger.error('获取人员资料列表失败', error);
    throw error;
  }
}

export async function getPersonProfileDetails(
  forceRefresh = false,
  scope: PersonProfileScope = 'leave',
  signal?: AbortSignal,
): Promise<PersonProfileDetailResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/person-profile-details',
      method: 'GET',
      params: {
        scope,
        ...(forceRefresh ? { forceRefresh: '1' } : {}),
      },
      timeout: DUTY_PAGE_READ_TIMEOUT_MS,
      signal,
    });
    return response.data;
  } catch (error) {
    logger.error('获取人员详细资料失败', error);
    throw error;
  }
}

/**
 * POST /api/bitable/sync-organization - 同步组织架构数据
 */
export async function syncOrganization(): Promise<BitableSyncResponse> {
  try {
    const response = await requestWithRetry(() =>
      axiosForBackend({
        url: '/api/bitable/sync-organization',
        method: 'POST',
        timeout: 300000, // 5分钟超时
      }),
    );
    return response.data;
  } catch (error) {
    logger.error('同步组织架构数据失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/duty-staff - 获取值班人员列表
 */
export async function getDutyStaff(): Promise<DutyStaffResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/duty-staff',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取值班人员列表失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/non-duty-schedules - 获取非值班排班列表
 */
export async function getNonDutySchedules(
  startDate?: string,
  endDate?: string,
  building?: string,
  team?: string,
): Promise<NonDutyScheduleResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/non-duty-schedules',
      method: 'GET',
      params: { startDate, endDate, building, team },
    });
    return response.data;
  } catch (error) {
    logger.error('获取非值班排班列表失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/holiday-schedules - 获取节日&重保排班列表
 */
export async function getHolidayDutySchedules(
  startDate?: string,
  endDate?: string,
  dutyType?: string,
): Promise<HolidayDutyScheduleResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/holiday-schedules',
      method: 'GET',
      params: { startDate, endDate, dutyType },
    });
    return response.data;
  } catch (error) {
    logger.error('获取节日&重保排班列表失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/festival-schedules - 获取节日重要排班列表（从 app_festival_important_schedule 表）
 */
export async function getFestivalSchedules(
  startDate?: string,
  endDate?: string,
): Promise<FestivalScheduleResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/festival-schedules',
      method: 'GET',
      params: { startDate, endDate },
    });
    return response.data;
  } catch (error) {
    logger.error('获取节日重要排班列表失败', error);
    throw error;
  }
}

/**
 * GET /api/bitable/today-leave-staff - 获取今日请假人员列表
 */
export async function getTodayLeaveStaff(
  date?: string,
  refresh = false,
): Promise<TodayLeaveStaffResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/bitable/today-leave-staff',
      method: 'GET',
      params:
        date || refresh
          ? {
              ...(date ? { date } : {}),
              ...(refresh ? { refresh: '1' } : {}),
            }
          : undefined,
      headers: refresh ? { 'Cache-Control': 'no-cache' } : undefined,
    });
    return response.data;
  } catch (error) {
    logger.error('获取今日请假人员列表失败', error);
    throw error;
  }
}

export async function getOperationsKbStats(): Promise<OperationsKbStatsResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/operations-kb/stats',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取运维藏经阁统计失败', error);
    throw error;
  }
}

export async function searchOperationsKb(params: {
  q?: string;
  page?: number;
  pageSize?: number;
  module?: string;
  documentType?: string;
  specialty?: string;
  equipmentType?: string;
  scenario?: string;
  level?: string;
  sort?: 'relevance' | 'latest';
}): Promise<OperationsKbSearchResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/operations-kb/search',
      method: 'GET',
      params,
    });
    return response.data;
  } catch (error) {
    logger.error('检索运维藏经阁失败', error);
    throw error;
  }
}

export async function getOperationsKbDocument(
  id: string,
): Promise<OperationsKbDocumentDetail> {
  try {
    const response = await axiosForBackend({
      url: `/api/operations-kb/documents/${encodeURIComponent(id)}`,
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取运维藏经阁条目失败', error);
    throw error;
  }
}

export async function getAliMonthlyReportConfig(): Promise<AliMonthlyReportConfigResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/ali-monthly-report/config',
      method: 'GET',
    });
    return response.data;
  } catch (error) {
    logger.error('获取阿里月报配置失败', error);
    throw error;
  }
}

export async function generateAliMonthlyReport(
  payload: AliMonthlyReportGenerateRequest,
): Promise<AliMonthlyReportGenerateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/ali-monthly-report/generate',
      method: 'POST',
      data: payload,
      timeout: 600000,
    });
    return response.data;
  } catch (error) {
    logger.error('生成阿里月报失败', error);
    throw error;
  }
}

export async function bundleAliMonthlyReportFiles(
  payload: AliMonthlyReportBundleRequest,
): Promise<AliMonthlyReportGenerateResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/ali-monthly-report/bundle-four-items',
      method: 'POST',
      data: payload,
      timeout: 600000,
    });
    return response.data;
  } catch (error) {
    logger.error('打包阿里月报四项文件失败', error);
    throw error;
  }
}

export async function sendAliMonthlyReportEmail(
  payload: AliMonthlyReportEmailRequest,
): Promise<AliMonthlyReportEmailResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/ali-monthly-report/send-email',
      method: 'POST',
      data: payload,
      timeout: 900000,
    });
    return response.data;
  } catch (error) {
    logger.error('发送阿里月报邮件失败', error);
    throw error;
  }
}

export async function openAliMonthlyReportFile(
  fileId: string,
): Promise<AliMonthlyReportFileActionResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/ali-monthly-report/files/${encodeURIComponent(fileId)}/open`,
      method: 'POST',
      timeout: 15_000,
    });
    return response.data;
  } catch (error) {
    logger.error('打开阿里月报生成文件失败', error);
    throw error;
  }
}

export async function revealAliMonthlyReportFile(
  fileId: string,
): Promise<AliMonthlyReportFileActionResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/ali-monthly-report/files/${encodeURIComponent(fileId)}/reveal`,
      method: 'POST',
      timeout: 15_000,
    });
    return response.data;
  } catch (error) {
    logger.error('定位阿里月报生成文件失败', error);
    throw error;
  }
}

export class EmployeeOnboardingApiResponseError extends Error {
  readonly code = 'EMPLOYEE_ONBOARDING_RESULT_UNKNOWN';

  constructor() {
    super('新员工入职结果待确认');
    this.name = 'EmployeeOnboardingApiResponseError';
  }
}

class EmployeeOnboardingHttpError extends Error {
  readonly response: Readonly<{ status: number }>;

  constructor(status: number) {
    super('新员工入职提交未完成');
    this.name = 'EmployeeOnboardingHttpError';
    this.response = Object.freeze({ status });
  }
}

class EmployeeOnboardingTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor() {
    super('新员工入职提交超时');
    this.name = 'EmployeeOnboardingTimeoutError';
  }
}

class EmployeeOnboardingAbortError extends Error {
  constructor() {
    super('新员工入职提交已取消');
    this.name = 'AbortError';
  }
}

export async function createEmployeeOnboarding(
  request: EmployeeOnboardingCreateRequest,
  photo: File,
  signal?: AbortSignal,
): Promise<EmployeeOnboardingCreateResponse> {
  const form = new FormData();
  form.append('payload', JSON.stringify(request));
  form.append('photo', photo);
  const controller = new AbortController();
  let abortSource: 'external' | 'timeout' | null = null;
  const abortFromExternalSignal = () => {
    if (abortSource) return;
    abortSource = 'external';
    controller.abort();
  };
  let externalAbortListenerAttached = false;

  if (signal) {
    if (signal.aborted) {
      abortFromExternalSignal();
    } else {
      signal.addEventListener('abort', abortFromExternalSignal, { once: true });
      externalAbortListenerAttached = true;
    }
  }

  const timeoutId = globalThis.setTimeout(() => {
    if (abortSource) return;
    abortSource = 'timeout';
    controller.abort();
  }, 120_000);

  try {
    const csrfToken = getCurrentCsrfToken();
    const response = await globalThis.fetch(
      buildAccessApiUrl('/api/bitable/employee-onboarding'),
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(csrfToken ? { 'X-Suda-Csrf-Token': csrfToken } : {}),
        },
        body: form,
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new EmployeeOnboardingHttpError(response.status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new EmployeeOnboardingApiResponseError();
    }
    if (abortSource === 'timeout') throw new EmployeeOnboardingTimeoutError();
    if (abortSource === 'external') throw new EmployeeOnboardingAbortError();
    if (
      !isEmployeeOnboardingCreateResponse(data) ||
      data.clientMutationId !== request.clientMutationId
    ) {
      throw new EmployeeOnboardingApiResponseError();
    }
    return data;
  } catch (error) {
    if (abortSource === 'timeout') throw new EmployeeOnboardingTimeoutError();
    if (abortSource === 'external') throw new EmployeeOnboardingAbortError();
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    if (externalAbortListenerAttached && signal) {
      signal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}
