import type {
  LeaveRequestAffectedSchedule,
  LeaveRequestExcludedSchedule,
  LeaveRequestImpact,
  LeaveRequestShiftGroup,
} from './leave-request-impact';
import type { OvertimeRequestImpact } from './overtime-request-impact';

/**
 * 楼栋基础信息
 */
export interface Building {
  id: string;
  name: string;
}
/**
 * 排班记录
 */
export interface DutySchedule {
  id: string;
  buildingId: string;
  dutyDate: string;
  staffId: string;
}
/**
 * 批量创建/更新排班请求参数
 */
export interface CreateDutyScheduleRequest {
  buildingId: string;
  dutyDate: string;
  staffId: string;
}
/**
 * 批量创建/更新排班请求体
 */
export interface BatchDutyScheduleRequest {
  schedules: CreateDutyScheduleRequest[];
}
/**
 * 批量创建/更新排班响应
 */
export interface BatchDutyScheduleResponse {
  success: boolean;
  message?: string;
}
export interface MonthlyScheduleLeaveAssignment {
  requestRecordId: string;
  leaveStaffName: string;
  substituteStaff: string[];
  startAt: string | null;
  endAt: string | null;
  leaveHours: number | null;
}
/**
 * 月度值班记录
 */
export interface MonthlySchedule {
  id: string;
  recordId: string;
  dutyCode: string | null;
  scheduleDate: string | null;
  code: number | null;
  building: string;
  team: string;
  shift: string;
  personText: string;
  dutyStaffReference: string[];
  dutyStaffActual: string[];
  remark: string;
  emergencyDuty: string;
  emergencyDutySchedule: string;
  leaveStaff: string[];
  substituteStaff: string[];
  leaveAssignments?: MonthlyScheduleLeaveAssignment[];
  travelStaff?: string[];
  actualDutyStaff: string;
  buildingText: string;
  teamText: string;
  shiftText: string;
  createdAt: string;
  updatedAt: string;
}
/**
 * 月度值班一览响应
 */
export interface MonthlyScheduleResponse {
  schedules: MonthlySchedule[];
}
export interface MonthlyScheduleScreenshotAccessRequest {
  audience?: 'monthly-schedule' | 'campus-operations' | null;
  screenshotDate?: string | null;
  screenshotShift?: 'white' | 'night' | null;
  token?: string | null;
}
export interface MonthlyScheduleScreenshotAccessResponse {
  success: boolean;
  authorized: boolean;
  message: string;
}
/**
 * 值班人员（实际）AI 字段异常修正候选记录
 */
export interface DutyStaffActualRepairCandidate {
  recordId: string;
  dutyCode: string | null;
  scheduleDate: string | null;
  building: string | null;
  team: string | null;
  sourceField: string;
  targetField: string;
  personText: string;
  currentValue: string;
  suggestedValue: string;
  reason: string;
  canRepair: boolean;
  updatedAt: string | null;
}
/**
 * 值班人员（实际）AI 字段异常扫描响应
 */
export interface DutyStaffActualRepairScanResponse {
  checkedAt: string;
  sourceField: string;
  sourceFieldId?: string;
  targetField: string;
  targetFieldId?: string;
  totalScanned: number;
  totalCandidates: number;
  returnedCandidates: number;
  candidates: DutyStaffActualRepairCandidate[];
}
/**
 * 值班人员（实际）AI 字段修正请求
 */
export interface DutyStaffActualRepairRequest {
  recordIds?: string[];
  recordId?: string;
  replacementValue?: string;
}
/**
 * 值班人员（实际）AI 字段修正响应
 */
export interface DutyStaffActualRepairResponse {
  success: boolean;
  total: number;
  repaired: number;
  skipped: number;
  failed: number;
  message: string;
  failures: Array<{
    recordId: string;
    error: string;
  }>;
}
export interface DutyStaffActualRefreshRequest {
  startDate?: string;
  endDate?: string;
}
export interface DutyStaffActualRefreshResponse {
  success: boolean;
  source: string;
  startDate?: string;
  endDate?: string;
  scanned: number;
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  failures: Array<{
    recordId: string;
    error: string;
  }>;
}
export interface VacancySubstituteUpdateItem {
  recordId: string;
  substituteName: string;
}
export interface VacancySubstituteUpdateRequest {
  updates: VacancySubstituteUpdateItem[];
}
export interface VacancySubstituteUpdateResult {
  recordId: string;
  substituteName: string;
  dutyStaffActual: string[];
  dutyStaffActualText: string;
  vacancySubstitute: string;
}
export interface VacancySubstituteUpdateResponse {
  success: boolean;
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  results: VacancySubstituteUpdateResult[];
  failures: Array<{
    recordId: string;
    error: string;
  }>;
}
export interface DutyStaffAdjustmentRequest {
  recordId: string;
  targetName: string;
  replacementName: string;
}
export interface DutyStaffAdjustmentResponse {
  success: boolean;
  recordId: string;
  targetName: string;
  replacementName: string;
  dutyStaffActual: string[];
  dutyStaffActualText: string;
  message: string;
}
export interface TravelStaffUpdateRequest {
  staffName: string;
  startDate: string;
  endDate: string;
}
export interface TravelStaffUpdateResult {
  recordId: string;
  scheduleDate: string;
  staffName: string;
  dutyStaffActual: string[];
  dutyStaffActualText: string;
  travelStaff: string;
}
export interface TravelStaffUpdateResponse {
  success: boolean;
  staffName: string;
  startDate: string;
  endDate: string;
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  results: TravelStaffUpdateResult[];
  failures: Array<{
    recordId: string;
    error: string;
  }>;
}
export interface TravelStaffScheduleRecord {
  recordId: string;
  scheduleDate: string;
  building: string;
  buildingText: string;
  team: string;
  teamText: string;
  shift: string;
  shiftText: string;
  dutyStaffActual: string[];
  dutyStaffActualText: string;
  travelStaff: string[];
  travelStaffText: string;
}
export interface TravelStaffDetail {
  id: string;
  staffName: string;
  startDate: string;
  endDate: string;
  dates: string[];
  recordCount: number;
  records: TravelStaffScheduleRecord[];
}
export interface TravelStaffDetailResponse {
  success: boolean;
  total: number;
  details: TravelStaffDetail[];
}
export interface TravelStaffAdjustRequest {
  staffName: string;
  originalStartDate: string;
  originalEndDate: string;
  startDate: string;
  endDate: string;
  recordIds?: string[];
}
export interface TravelStaffRevokeRequest {
  staffName: string;
  startDate: string;
  endDate: string;
  recordIds?: string[];
}
export interface TravelStaffMutationResponse extends TravelStaffUpdateResponse {
  details: TravelStaffDetail[];
}
export type PersonnelMovementType = '差旅' | '异动' | '离职';
export interface PersonnelMovementCreateRequest {
  staffName: string;
  movementType: PersonnelMovementType;
  movementDate: string;
}
export interface PersonnelMovementUpdateResult {
  recordId: string;
  scheduleDate: string;
  staffName: string;
  previousValue: string;
  nextValue: string;
}
export interface PersonnelMovementCreateResponse {
  success: boolean;
  staffName: string;
  movementType: PersonnelMovementType;
  movementDate: string;
  personnelUpdated: boolean;
  personnelRecordId?: string;
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  results: PersonnelMovementUpdateResult[];
  failures: Array<{
    recordId: string;
    error: string;
  }>;
}
export interface LongWhiteDutyStaffByBuilding {
  building: string;
  buildingName: string;
  staff: string[];
  substituteStaff?: string[];
}
export interface LongWhiteDutyStaffResponse {
  date: string;
  buildings: LongWhiteDutyStaffByBuilding[];
  total: number;
  source: {
    tableId: string;
    viewId: string;
    staffField: string;
  };
}
export type AdditionalMatterType = 'focus' | 'customer';
export interface AdditionalMatterCreateRequest {
  type: AdditionalMatterType;
  content: string;
  date?: string;
}
export interface AdditionalMatterCreateResponse {
  success: boolean;
  type: AdditionalMatterType;
  recordId: string;
  content: string;
  date: string;
  message: string;
}
export interface SealingRegistrationCreateRequest {
  sealingInfo: string;
  startTime: string;
  endTime: string;
}
export interface SealingRegistrationCreateResponse {
  success: boolean;
  recordId: string;
  recordUrl: string | null;
  sealingInfo: string;
  startTime: string;
  endTime: string;
  message: string;
}
export type LeaveRequestType =
  | '年假'
  | '病假'
  | '育儿假'
  | '调休'
  | '复审'
  | '事假'
  | '丧假'
  | '婚假'
  | '差旅';
export const LEAVE_REQUEST_REASON_MAX_LENGTH = 2000;
export interface LeaveRequestCreateRequest {
  clientMutationId: string;
  leaveStaffName: string;
  startAt: string;
  endAt: string;
  expectedImpact: LeaveRequestImpact;
  leaveType: LeaveRequestType;
  leaveReason: string;
  needSubstitute?: boolean | null;
  substituteStaffName?: string | null;
}
export interface LeaveRequestCreateResponse {
  success: boolean;
  total: number;
  created: number;
  recordIds: string[];
  startAt: string;
  endAt: string;
  leaveStaffName: string;
  clientMutationId: string;
  affectedSchedules: LeaveRequestAffectedSchedule[];
  shiftGroups: LeaveRequestShiftGroup[];
  excludedSchedules: LeaveRequestExcludedSchedule[];
  rawHours: number;
  minimumHours: number;
  unrecognizedShifts: string[];
  missingCalendarYears: string[];
  approvalWorkflow?: {
    mode: 'program_card';
    accepted: true;
    pending: true;
    recordIds: string[];
  };
  message: string;
}
export interface OvertimeRequestCreateRequest {
  clientMutationId: string;
  staffName: string;
  startAt: string;
  endAt: string;
  reason: string;
  expectedImpact: OvertimeRequestImpact;
}
export interface OvertimeRequestCreateResponse {
  success: true;
  created: number;
  recordId: string;
  clientMutationId: string;
  requestFingerprint: string;
  impact: OvertimeRequestImpact;
  message: string;
}
export type OvertimeConfirmationDisposition =
  | 'compensatory_leave'
  | 'overtime_pay';
export interface OvertimeConfirmationDetailResponse {
  recordId: string;
  staffName: string;
  building: string | null;
  position: string | null;
  plannedStartAt: string;
  plannedEndAt: string;
  plannedHours: number;
  actualStartAt: string | null;
  actualEndAt?: string | null;
  actualHours: number | null;
  disposition: OvertimeConfirmationDisposition | null;
}
export interface OvertimeConfirmationSubmitPayload {
  actualStartAt: string;
  actualEndAt?: string;
  actualHours: number;
  disposition: OvertimeConfirmationDisposition | null;
}
export interface OvertimeConfirmationAcceptedResponse {
  accepted: true;
  recordId: string;
  mutationId: string;
  syncStatus: 'pending';
  actualStartAt: string;
  actualEndAt: string;
  actualHours: number;
  disposition: OvertimeConfirmationDisposition | null;
}
export type ExceptionFollowUpType = 'sealing_change' | 'schedule';
export interface ExceptionFollowUpCreateRequest {
  type: ExceptionFollowUpType;
  abnormalLabel: string;
  detail: string;
  handling: string;
  date?: string;
}
export interface ExceptionFollowUpItem {
  recordId: string;
  type: ExceptionFollowUpType;
  typeLabel: string;
  abnormalLabel: string;
  date: string;
  detail: string;
  detailedContent: string;
  handling: string;
  matchKey: string;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface ExceptionFollowUpCreateResponse {
  success: boolean;
  type: ExceptionFollowUpType;
  typeLabel: string;
  abnormalLabel: string;
  recordId: string;
  detail: string;
  detailedContent: string;
  handling: string;
  date: string;
  matchKey: string;
  notified: boolean;
  notificationError?: string;
  message: string;
  item: ExceptionFollowUpItem;
}
export interface ExceptionFollowUpListResponse {
  date: string;
  range?: { start: string; end: string };
  items: ExceptionFollowUpItem[];
  total: number;
}
export interface ExceptionFollowUpUpdateRequest extends ExceptionFollowUpCreateRequest {
  recordId: string;
  previousHandling?: string;
}
export interface ExceptionFollowUpUpdateResponse {
  success: boolean;
  recordId: string;
  handling: string;
  notified: boolean;
  notificationError?: string;
  message: string;
  item: ExceptionFollowUpItem;
}
export interface ExceptionFollowUpDeleteRequest {
  recordId: string;
  type?: ExceptionFollowUpType;
  abnormalLabel?: string;
  detail?: string;
  handling?: string;
  date?: string;
}
export interface ExceptionFollowUpDeleteResponse {
  success: boolean;
  recordId: string;
  notified: boolean;
  notificationError?: string;
  message: string;
}
/**
 * 最后同步时间响应
 */
export interface LastSyncTimeResponse {
  lastSyncTime: string | null;
}

export interface ScheduleSnapshotRevisionResponse {
  available: boolean;
  token: string | null;
  nonDutyFetchedAt: number | null;
  scheduleFetchedAt: number | null;
}
/**
 * 值班概览截图发送响应
 */
export interface DutyOverviewScreenshotResponse {
  success: boolean;
  source: 'manual' | 'auto-08:50' | 'auto-17:50';
  message: string;
  screenshotDate: string;
  sentAt: string;
  chatId: string;
  chatIds?: string[];
  imageKey?: string;
  screenshotPath?: string;
  dailyReport?: {
    date: string;
    shift: 'white' | 'night';
    shiftLabel: string;
    recordId: string;
    created: boolean;
    fileToken: string;
    attachmentCount: number;
  };
  campusOperationsScreenshotPath?: string;
  campusOperationsDailyReport?: {
    date: string;
    shift: 'white' | 'night';
    shiftLabel: string;
    recordId: string;
    created: boolean;
    fileToken: string;
    attachmentCount: number;
  };
}
/**
 * 飞书多维表同步记录
 */
export interface TyphoonPathScreenshotResponse {
  success: boolean;
  source: 'manual-test' | 'manual-group' | 'auto-typhoon-warning';
  message: string;
  sentAt: string;
  chatId: string;
  chatIds?: string[];
  receiveId: string;
  receiveIdType: 'chat_id' | 'user_id' | 'open_id' | 'email';
  imageKey?: string;
  screenshotPath?: string;
  warningTitle?: string;
  warningLevel?: string;
  alreadySent?: boolean;
}

export interface TyphoonPathWarningSummary {
  id: string;
  warningKey: string;
  title: string;
  level: 'blue' | 'yellow' | 'orange' | 'red';
  levelText: string;
  pubTime?: string;
}

export interface TyphoonPathScreenshotPreviewResponse {
  success: true;
  checkedAt: string;
  hasActiveWarning: boolean;
  canSend: boolean;
  reason: string;
  cadenceHours?: number;
  nextSendAt?: string;
  warning: TyphoonPathWarningSummary | null;
  message: string;
}

export interface TyphoonPathGroupScreenshotRequest {
  clientMutationId: string;
  expectedWarningKey?: string;
  force?: boolean;
  confirmation?: 'FORCE_SEND_TYPHOON_PATH';
}

export interface TyphoonPathGroupScreenshotResponse {
  success: boolean;
  sent: boolean;
  source: 'manual' | 'manual-group';
  forced: boolean;
  reason: string;
  message: string;
  checkedAt?: string;
  cadenceHours?: number;
  nextSendAt?: string;
  warning?: TyphoonPathWarningSummary | null;
  screenshot?: TyphoonPathScreenshotResponse;
}

export type WeatherWarningSnapshotStatus =
  | 'active'
  | 'clear'
  | 'degraded'
  | 'stale';

export type WeatherWarningSourceState =
  | 'fresh'
  | 'degraded'
  | 'stale'
  | 'unavailable';

export type WeatherWarningGuardDecisionState = 'fresh' | 'pending' | 'stale';

export type WeatherWarningCheckSyncState =
  | 'fresh'
  | 'unavailable'
  | 'not_applicable';

export type WeatherWarningCheckState =
  | 'completed'
  | 'pending'
  | 'abnormal'
  | 'not_started'
  | 'not_required';

export type WeatherWarningColor = 'red' | 'orange' | 'yellow' | 'blue';

export type WeatherWarningGuardLevel = '一级戒备' | '二级戒备' | '三级戒备';

export interface WeatherWarningMetricSnapshot {
  temperature?: string;
  feelsLike?: string;
  humidity?: string;
  windDirection?: string;
  windScale?: string;
  observedAt?: string;
}

export interface WeatherWarningDisplayWarning {
  id: string;
  title: string;
  type: string | null;
  color: WeatherWarningColor | null;
  guardLevel: WeatherWarningGuardLevel | null;
  startTime?: string;
  endTime?: string;
  pubTime?: string;
  status?: string;
}

export type WeatherWarningMatchedWarning = WeatherWarningDisplayWarning;

export type WeatherGuardRegistrationStatus = '正常' | '异常';

export interface WeatherGuardRegistrationPersonOption {
  key: string;
  name: string;
  position: string;
  buildings: WeatherWarningBuilding[];
}

export interface WeatherGuardRegistrationOptions {
  warning: WeatherWarningMatchedWarning;
  dataUpdatedAt: string;
  guardLevel: WeatherWarningGuardLevel;
  environmentRequired: boolean;
  buildings: WeatherWarningBuilding[];
  checkers: WeatherGuardRegistrationPersonOption[];
  personnelSyncedAt: string;
  personnelStale: boolean;
  acceptedImageTypes: string[];
  maxImageBytes: number;
}

export interface WeatherGuardRegistrationRequest {
  clientMutationId: string;
  warningId: string;
  building: WeatherWarningBuilding;
  checkerKeys: string[];
  deviceStatus: WeatherGuardRegistrationStatus;
  deviceAbnormalDescription?: string;
  disasterStatus: WeatherGuardRegistrationStatus;
  disasterAbnormalDescription?: string;
  environmentStatus?: WeatherGuardRegistrationStatus;
  environmentAbnormalDescription?: string;
  materialsStatus: WeatherGuardRegistrationStatus;
  materialsAbnormalDescription?: string;
  contactsStatus: WeatherGuardRegistrationStatus;
  contactsAbnormalDescription?: string;
}

export interface WeatherGuardRegistrationResponse {
  success: true;
  clientMutationId: string;
  syncStatus: 'confirmed';
  recordId: string;
  createdAt: string;
  building: WeatherWarningBuilding;
  guardLevel: WeatherWarningGuardLevel;
}

export interface WeatherWarningCheckSummary {
  device: WeatherWarningCheckState;
  environment: WeatherWarningCheckState;
  disaster: WeatherWarningCheckState;
  materials: WeatherWarningCheckState;
  contacts: WeatherWarningCheckState;
  managerConfirmation: WeatherWarningCheckState;
  abnormalSummaries: string[];
}

export type WeatherWarningBuilding =
  | 'A楼'
  | 'B楼'
  | 'C楼'
  | 'D楼'
  | 'E楼'
  | 'H楼'
  | '110站';

export type WeatherWarningCheckKey = Exclude<
  keyof WeatherWarningCheckSummary,
  'abnormalSummaries'
>;

export interface WeatherWarningBuildingProgress {
  building: WeatherWarningBuilding;
  recordAt: string;
  checks: Record<WeatherWarningCheckKey, WeatherWarningCheckState>;
  abnormalSummaries: string[];
}

export type WeatherWarningIncompleteState =
  | Exclude<WeatherWarningCheckState, 'completed' | 'not_required'>
  | 'missing_registration';

export interface WeatherWarningIncompleteItem {
  building: WeatherWarningBuilding;
  key: WeatherWarningCheckKey | 'registration';
  label: string;
  state: WeatherWarningIncompleteState;
  detail?: string;
}

export interface WeatherWarningBuildingProgressSummary {
  available: boolean;
  buildings: WeatherWarningBuildingProgress[];
  missingRegistrationBuildings: WeatherWarningBuilding[];
  unassignedRecordCount: number;
  incompleteItems: WeatherWarningIncompleteItem[];
}

export type WeatherWarningGuardCompletionState =
  | 'completed'
  | 'incomplete'
  | 'unavailable'
  | 'not_applicable';

export interface WeatherWarningGuardCompletionSummary {
  state: WeatherWarningGuardCompletionState;
  completedBuildingCount: number;
  totalBuildingCount: number;
}

export interface WeatherWarningFeatureFlags {
  registrationEnabled: boolean;
  progressNotificationsEnabled: boolean;
}

export interface WeatherWarningSnapshot {
  status: WeatherWarningSnapshotStatus;
  sourceState: WeatherWarningSourceState;
  guardDecisionState?: WeatherWarningGuardDecisionState;
  checkSyncState?: WeatherWarningCheckSyncState;
  snapshotAt: string;
  lastSuccessAt?: string;
  guardLevel: WeatherWarningGuardLevel | null;
  matchedWarnings: WeatherWarningDisplayWarning[];
  unmatchedWarnings: WeatherWarningDisplayWarning[];
  actions: string[];
  weather: WeatherWarningMetricSnapshot | null;
  weatherSourceError?: string;
  checkSummary: WeatherWarningCheckSummary;
  requiredCheckKeys?: WeatherWarningCheckKey[];
  buildingProgress?: WeatherWarningBuildingProgressSummary;
  guardCompletion?: WeatherWarningGuardCompletionSummary;
  sourceError?: string;
  canSendTest: boolean;
  features?: WeatherWarningFeatureFlags;
}

export interface WeatherWarningTestPreviewResponse {
  success: true;
  recipientName: string;
  senderName: '系统机器人';
  canSend: boolean;
  snapshot: WeatherWarningSnapshot;
}

export interface WeatherWarningTestSendRequest {
  clientMutationId: string;
}

export interface WeatherWarningFullFlowProgressSendRequest {
  runClientMutationId: string;
  clientMutationId: string;
  cardType: 'progress' | 'reminder';
}

export interface WeatherWarningTestSendResponse {
  success: boolean;
  sent: boolean;
  clientMutationId: string;
  messageId?: string;
  sentAt?: string;
  message: string;
}

export interface BitableSyncRecord {
  id: string;
  bitableRecordId: string;
  recordContent: Record<string, unknown>;
  syncTime: string;
  status: string;
}
/**
 * 多维表同步响应
 */
export interface BitableSyncResponse {
  success: boolean;
  total: number;
  inserted?: number;
  updated?: number;
  failed?: number;
  failedRecords?: Array<{
    recordId: string;
    error: string;
  }>;
  message: string;
}

export interface CampusOperationsTransformerRow {
  name: string;
  line: string;
  oilTemp: number;
  gear: number;
  load: number;
  current: string;
  loadRate: string;
  status: string;
}

export interface CampusOperationsBuildingMetric {
  building: string;
  totalPower: number;
  pue: number;
  itPower: number;
  itDesignPower: number;
  itLoad: number;
}

export interface CampusOperationsShiftTarget {
  requestedDate: string;
  requestedShift: string;
  transformerDate: string | null;
  transformerShift: string | null;
  machineDate: string | null;
  machineShift: string | null;
  rule: string;
}

export interface CampusOperationsDashboardResponse {
  transformerRows: CampusOperationsTransformerRow[];
  buildingMetrics: CampusOperationsBuildingMetric[];
  target: CampusOperationsShiftTarget;
  fetchedAt: string;
}

export type CampusCertificateComplianceStatus =
  | '合规'
  | '不合规'
  | '不涉及'
  | '未知';

export type CampusCertificateMetricId =
  | 'high-voltage'
  | 'low-voltage'
  | 'height-work'
  | 'expiring';

export type CampusCertificateMetricTone = 'blue' | 'green' | 'red' | 'orange';

export interface CampusCertificateMetric {
  id: CampusCertificateMetricId;
  label: string;
  value: number;
  tone: CampusCertificateMetricTone;
}

export interface CampusCertificatePerson {
  id: string;
  name: string;
  building: string;
  position: string;
  team: string;
  complianceStatus: CampusCertificateComplianceStatus;
  missingCertificate: string;
  highVoltageValid: boolean;
  lowVoltageValid: boolean;
  heightWorkValid: boolean;
  highVoltageExpiryDate: string | null;
  lowVoltageExpiryDate: string | null;
  heightWorkExpiryDate: string | null;
  expiryReminder: string;
}

export interface CampusCertificateNonCompliantPerson {
  id: string;
  building: string;
  name: string;
  position: string;
  missingCertificate: string;
  positionTone: 'green' | 'red';
}

export type CampusCertificateExpiryCategory =
  | 'high-voltage'
  | 'low-voltage'
  | 'height-work';

export interface CampusCertificateExpiryEvent {
  id: string;
  date: string;
  category: CampusCertificateExpiryCategory;
  personId: string;
  personName: string;
  building: string;
  certificateName: string;
}

export interface CampusCertificateBuildingCompliance {
  building: string;
  compliant: number;
  nonCompliant: number;
  rate: number;
}

export interface CampusCertificateSummary {
  totalPeople: number;
  compliantPeople: number;
  nonCompliantPeople: number;
  notApplicablePeople: number;
  currentQualified: number;
  targetQualified: number;
  complianceRate: number;
  totalCertificates: number;
  averageComplianceRate: number;
}

export interface CampusCertificateDashboardResponse {
  summary: CampusCertificateSummary;
  certificateMetrics: CampusCertificateMetric[];
  buildingCompliance: CampusCertificateBuildingCompliance[];
  nonCompliantPeople: CampusCertificateNonCompliantPerson[];
  people: CampusCertificatePerson[];
  expiryEvents: CampusCertificateExpiryEvent[];
  sourceUpdatedAt: string | null;
  syncedAt: string;
  sourceStatus: 'fresh' | 'stale';
  errorMessage?: string;
}

export interface CampusCertificateExpiryNotificationCertificate {
  certificateName: string;
  expiryDate: string;
}

export interface CampusCertificateExpiryNotificationPerson {
  id: string;
  name: string;
  building: string;
  position: string;
  certificates: CampusCertificateExpiryNotificationCertificate[];
  matchStatus: 'matched' | 'unmatched' | 'ambiguous';
}

export interface CampusCertificateExpiryNotificationPreview {
  requestId: string;
  totalPeople: number;
  matchedCount: number;
  unmatchedNames: string[];
  ambiguousNames: string[];
  blocked: boolean;
  blockedReason?: string;
  people: CampusCertificateExpiryNotificationPerson[];
  sourceUpdatedAt: string | null;
  syncedAt: string;
}

export interface CampusCertificateExpiryNotificationRequest {
  requestId: string;
}

export interface CampusCertificateExpiryNotificationFailure {
  name: string;
  message: string;
}

export interface CampusCertificateExpiryNotificationResponse {
  success: boolean;
  requestId: string;
  attemptedCount: number;
  sentCount: number;
  failedCount: number;
  unmatchedNames: string[];
  ambiguousNames: string[];
  failures: CampusCertificateExpiryNotificationFailure[];
  sentAt: string;
}
/**
 * 多维表记录列表响应
 */
export interface BitableRecordsResponse {
  records: BitableSyncRecord[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}
/**
 * 封网信息
 */
export interface SealingInfo {
  id: string;
  bitableRecordId: string;
  sealingCode: string;
  sealingName: string;
  startDate: string;
  endDate: string;
  sealingType: string | null;
  autoNumber: string | null;
  isToday: boolean;
  createdAt: string;
  updatedAt: string;
}
/**
 * 今年封网信息响应
 */
export interface YearlySealingInfoResponse {
  sealings: SealingInfo[];
  total: number;
  sourceStatus?: 'fresh' | 'stale';
  syncedAt?: string;
}
/**
 * 计划变更信息
 */
export interface ChangeInfo {
  id: string;
  bitableRecordId: string;
  title: string;
  startDate: string;
  endDate: string;
  actualStartDate: string | null;
  actualEndDate: string | null;
  plannedDelayStartDate: string | null;
  plannedDelayEndDate: string | null;
  level: string | null;
  type: string | null;
  progress: string | null;
  executor: string | null;
  /** Writable submitter selected in the application; system creator stays separate. */
  submitterName?: string | null;
  workflowStatus?: string | null;
  hasSummaryReport?: boolean;
  /** Server-derived lifecycle used to decide which schedule fields are editable. */
  scheduleStatus?: 'not-started' | 'in-progress' | 'finished' | null;
  planDocuments?: ChangeInfoDocument[];
  delayReason?: string | null;
  delayEvidence?: ChangeInfoDocument[];
  buildings: string[];
  riskSummary: string | null;
  isKey: boolean;
  recordUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Stable Base automatic timestamp used only for optimistic adjustment writes. */
  adjustmentUpdatedAt?: string | null;
}
export interface ChangeInfoDocument {
  fileToken: string;
  name: string;
  size?: number | null;
  mimeType?: string | null;
  url?: string | null;
  objectStorage?: {
    id: string;
    filePath: string;
    bucketId: string;
    url: string;
  } | null;
}
/**
 * 年度计划变更信息响应
 */
export interface YearlyChangeInfoResponse {
  changes: ChangeInfo[];
  total: number;
  keyTotal: number;
}
export interface ChangeScheduleAdjustmentRequest {
  recordId: string;
  plannedDelayStartDate?: string | null;
  plannedDelayEndDate?: string | null;
  clearAdjustment?: boolean;
}
export interface ChangeScheduleAdjustmentResponse {
  success: boolean;
  recordId: string;
  plannedDelayStartDate: string | null;
  plannedDelayEndDate: string | null;
  message: string;
}
/**
 * 今日园区重点关注清单中的封网项
 */
export interface TodayFocusSealingItem {
  id: string;
  name: string;
  type: string | null;
  code: string | null;
  autoNumber: string | null;
  startDate: string;
  endDate: string;
  recordUrl?: string | null;
}
/**
 * 今日园区重点关注清单通用事项
 */
export interface TodayFocusListItem {
  id: string;
  title: string;
  summary: string | null;
  level: string | null;
  riskLevel: string | null;
  status: string | null;
  owner: string | null;
  startTime: string | null;
  endTime: string | null;
  todayFlag?: string | null;
  updatedAt: string | null;
  source: string | null;
  recordUrl?: string | null;
  tags: string[];
}
export interface TodayFocusSectionStatus {
  configured: boolean;
  message?: string;
}
/**
 * 今日园区重点关注清单响应
 */
export interface TodayFocusChecklistResponse {
  date: string;
  generatedAt: string;
  sealings: TodayFocusSealingItem[];
  keyChanges: TodayFocusListItem[];
  majorIncidents: TodayFocusListItem[];
  others: TodayFocusListItem[];
  sectionStatus: {
    sealings: TodayFocusSectionStatus;
    keyChanges: TodayFocusSectionStatus;
    majorIncidents: TodayFocusSectionStatus;
    others: TodayFocusSectionStatus;
  };
}
export interface ConstructionAttachmentFile {
  fileToken: string;
  name: string;
  size: number | null;
  tmpUrl?: string | null;
  downloadUrl?: string | null;
  mimeType?: string | null;
}
export interface ConstructionAttachmentGroup {
  field: string;
  label: string;
  count: number;
  files: ConstructionAttachmentFile[];
  status: 'empty' | 'complete' | 'issue';
  feedback: string | null;
  manualReview?: ConstructionAttachmentManualReview | null;
}
export interface ConstructionAttachmentManualReview {
  field: string;
  fingerprintField: string;
  reviewed: boolean;
  value: string | null;
  fingerprint: string | null;
  expectedFingerprint: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}
export interface ConstructionFollowupItem {
  recordId: string;
  title: string;
  constructionCode: string | null;
  workContent: string | null;
  workTypes: string[];
  dailyWorkTypesConfirmed?: boolean;
  overviewRecordIds: string[];
  constructionDay: number | null;
  isLatest: boolean;
  followupStaff: string | null;
  followupStaffMembers: ConstructionFollowupStaffMember[];
  completed: string | null;
  dailyPersonnelCheck: string | null;
  isolationCompliant: string | null;
  isolationFeedback: string | null;
  processFeedback: string | null;
  closingFeedback: string | null;
  closingApproval: string | null;
  depositPaid?: string | null;
  roomManagerSync?: string | null;
  completionChecklist: ConstructionCompletionChecklistAnswer[];
  followupDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  recordUrl: string | null;
  attachments: ConstructionAttachmentGroup[];
  aiIssues: string[];
}
export interface ConstructionFollowupStaffMember {
  id: string;
  name: string;
}
export interface ConstructionDailyPersonnelCheckParticipant {
  recordId: string;
  name: string;
  certificateSummary: string | null;
  complianceStatus: string | null;
  issueSummary: string | null;
}
export interface ConstructionCrewMemberItem {
  recordId: string;
  name: string;
  company: string | null;
  constructionCode: string | null;
  overviewRecordIds: string[];
  phone: string | null;
  certificateNo?: string | null;
  authorizationStartDate: string | null;
  authorizationEndDate: string | null;
  authorizationStatus: '已过期' | '授权有效' | '未开始' | string | null;
  certificateSummary: string | null;
  complianceStatus: string | null;
  issueSummary: string | null;
}
export interface ConstructionOverviewItem {
  recordId: string;
  constructionCode: string | null;
  workContent: string;
  building: string | null;
  specialty: string | null;
  contractorType: string | null;
  workTypes: string[];
  relatedWorkType: string | null;
  workflow: string | null;
  planStartTime: string | null;
  planEndTime: string | null;
  remainingDays: number | null;
  approval: {
    supervisor: string | null;
    ehsNotified: string | null;
    ehs: string | null;
    credential: string | null;
    depositConfirmation: string | null;
    parkSync: string | null;
    depositPaid: string | null;
  };
  deposit: {
    amount: number | null;
    deducted: number | null;
    balance: number | null;
  };
  managers: {
    supervisor: string | null;
    safety: string | null;
    park: string | null;
    applicant: string | null;
    engineer: string | null;
  };
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  recordUrl: string | null;
  applicationAttachments: ConstructionAttachmentGroup[];
  constructionIssues: ConstructionAttachmentFile[];
  completionChecklistArchive: ConstructionAttachmentFile[];
  depositAgreementFiles: ConstructionAttachmentFile[];
  depositTransferFiles: ConstructionAttachmentFile[];
  crewMembers: ConstructionCrewMemberItem[];
  followups: ConstructionFollowupItem[];
  latestFollowup: ConstructionFollowupItem | null;
}
export interface ConstructionManagementSummary {
  total: number;
  active: number;
  pendingApproval: number;
  endingSoon: number;
  attachmentIssues: number;
  completedFollowups: number;
  latestUpdatedAt: string | null;
}
export interface ConstructionImageAuditStatus {
  enabled?: boolean;
  configured: boolean;
  provider: string;
  model: string | null;
  baseUrl: string | null;
  supportsImageInput: boolean;
  message: string;
}
export interface ConstructionManagementResponse {
  generatedAt: string;
  summary: ConstructionManagementSummary;
  items: ConstructionOverviewItem[];
  followups: ConstructionFollowupItem[];
  imageAuditStatus: ConstructionImageAuditStatus;
  sectionStatus: {
    overview: TodayFocusSectionStatus;
    followups: TodayFocusSectionStatus;
  };
}
export interface ConstructionApplicationCreateRequest {
  clientMutationId?: string | null;
  workContent: string;
  building: string;
  specialty: string;
  workTypes: string[];
  contractorType: string;
  relatedWorkType?: string | null;
  planStartTime: string;
  planEndTime: string;
  authorizationStartDate?: string | null;
  authorizationEndDate?: string | null;
  depositPaid?: string | null;
  depositAmount?: number | string | null;
  depositDeducted?: number | string | null;
  constructionApplicantId?: string | null;
  changeOrderRecordId?: string | null;
}
export interface ConstructionApplicationCreateResponse {
  success: boolean;
  recordId: string;
  recordUrl: string | null;
  initialFollowupRecordId?: string;
  initialFollowupRecordUrl?: string | null;
  message: string;
}
export interface ConstructionFollowupCreateRequest {
  clientMutationId?: string | null;
  backgroundSync?: boolean | string | null;
  constructionRecordId: string;
  followupRecordId?: string | null;
  followupMode?: 'daily' | 'supplemental' | null;
  dailyFollowupStage?: 'prepare' | 'process' | 'close' | null;
  dailyChecklistFocus?:
    | 'workType'
    | 'personnel'
    | 'permit'
    | 'isolation'
    | 'processPhoto'
    | 'closeChecklist'
    | 'closePhoto'
    | string
    | null;
  followupDate?: string | null;
  permitOnlyUpload?: boolean | string | null;
  permitValidFromByFileKey?: Record<string, string> | string | null;
  permitValidUntilByFileKey?: Record<string, string> | string | null;
  partialDailySubmit?: boolean | string | null;
  workTypes?: string[] | string | null;
  followupStaffIds?: string[] | string | null;
  retainedAttachmentTokens?: Record<string, string[]> | string | null;
  dailyPersonnelCheck?: string | null;
  dailyCrewMembers?:
    | ConstructionDailyPersonnelCheckParticipant[]
    | string
    | null;
  isolationCompliant?: string | null;
  isolationFeedback?: string | null;
  processFeedback?: string | null;
  closingFeedback?: string | null;
  completed?: string | null;
  completionChecklist?: ConstructionCompletionChecklistAnswer[] | string | null;
  depositPaid?: string | null;
  depositAmount?: number | string | null;
  depositDeducted?: number | string | null;
  checklistWorkContent?: string | null;
  checklistConstructionCode?: string | null;
  checklistBuilding?: string | null;
  checklistContractor?: string | null;
  checklistPlanStartTime?: string | null;
  checklistPlanEndTime?: string | null;
}
export interface ConstructionPermitManualReviewRequest {
  followupRecordId: string;
  fileKey: string;
}
export interface ConstructionPermitManualReviewResponse {
  success: boolean;
  recordId: string;
  fileKey: string;
  field: string;
  reviewField: string;
  workflowTriggered: boolean;
  message: string;
}
export type ConstructionPermitManualReviewDecision = 'passed' | 'rejected';
export interface ConstructionPermitManualReviewUpdateRequest {
  followupRecordId: string;
  fileKey: string;
  decision: ConstructionPermitManualReviewDecision;
  validFrom?: string | null;
  validUntil?: string | null;
  permitFileTokens?: string[] | null;
  permitFingerprint?: string | null;
  sourceFeedback?: string | null;
}
export interface ConstructionPermitManualReviewUpdateResponse {
  success: boolean;
  recordId: string;
  fileKey: string;
  field: string;
  reviewField: string;
  decision: ConstructionPermitManualReviewDecision;
  validFrom: string | null;
  validUntil: string | null;
  message: string;
}
export interface ConstructionIsolationPhotoManualReviewUpdateRequest {
  followupRecordId: string;
  decision: ConstructionPermitManualReviewDecision;
}
export interface ConstructionIsolationPhotoManualReviewUpdateResponse {
  success: boolean;
  recordId: string;
  field: string;
  reviewField: string;
  decision: ConstructionPermitManualReviewDecision;
  message: string;
}
export interface ConstructionCompletionChecklistAnswer {
  key: string;
  result: '√' | '×' | 'N/A';
  remark?: string | null;
}
export interface ConstructionCompletionChecklistTemplateItem {
  key: string;
  no: string;
  category: string;
  content: string;
}
export const CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS: readonly ConstructionCompletionChecklistTemplateItem[] =
  [
    {
      key: 'compliance-1-1',
      no: '1.1',
      category: '合规性',
      content: '施工流程符合数据中心运维安全规范，未违规操作',
    },
    {
      key: 'compliance-1-2',
      no: '1.2',
      category: '合规性',
      content: '施工过程未对周边设备、系统造成影响',
    },
    {
      key: 'compliance-1-3',
      no: '1.3',
      category: '合规性',
      content: '施工记录内容完整、格式规范、可追溯',
    },
    {
      key: 'temporary-power-2-1',
      no: '2.1',
      category: '临时用电',
      content: '已全部拆除，现场无残留临时配电设施',
    },
    {
      key: 'temporary-power-2-2',
      no: '2.2',
      category: '临时用电',
      content: '所有临时电线已收回，线径、护套完整，无残余',
    },
    {
      key: 'temporary-power-2-3',
      no: '2.3',
      category: '临时用电',
      content: '正式供电恢复，所有临时开关、保险已复位',
    },
    {
      key: 'tools-3-1',
      no: '3.1',
      category: '物品工具收回',
      content: '所有电动工具、测量仪表、焊接设备等已归还/搬离现场',
    },
    {
      key: 'tools-3-2',
      no: '3.2',
      category: '物品工具收回',
      content: '安全帽、防护手套、防护眼镜、防护服等已全部收回',
    },
    {
      key: 'tools-3-3',
      no: '3.3',
      category: '物品工具收回',
      content: '螺栓、螺母、垫片、标签、胶带、扎带等小件无遗留',
    },
    {
      key: 'cleaning-4-1',
      no: '4.1',
      category: '环境与清洁',
      content: '施工垃圾全部清理完毕，现场环境整洁',
    },
    {
      key: 'cleaning-4-2',
      no: '4.2',
      category: '环境与清洁',
      content: '现场无明显灰尘、异味，空气质量符合机房要求',
    },
    {
      key: 'cleaning-4-3',
      no: '4.3',
      category: '环境与清洁',
      content: '地面、墙面、门窗、扶手、设备外壳清洁无尘',
    },
    {
      key: 'cleaning-4-4',
      no: '4.4',
      category: '环境与清洁',
      content: '高架地板板块完整、平整、无晃动、无破损',
    },
    {
      key: 'firestop-5-1',
      no: '5.1',
      category: '防火封堵',
      content:
        '防火墙、楼板、屋顶的穿孔已使用合格防火封堵材料填塞（膨胀型防火泥、防火板等）',
    },
    {
      key: 'firestop-5-2',
      no: '5.2',
      category: '防火封堵',
      content: '电缆桥架、管道、线槽的贯穿处防火封堵完整，无空隙',
    },
    {
      key: 'firestop-5-3',
      no: '5.3',
      category: '防火封堵',
      content:
        '管井（管道井，冷媒井，电缆井）穿越机房区域，且与机房之间有完整的水平分隔',
    },
    {
      key: 'safety-6-1',
      no: '6.1',
      category: '安全防护',
      content: '施工后设备、线路防护到位，强弱电物理分离且无飞线',
    },
    {
      key: 'safety-6-2',
      no: '6.2',
      category: '安全防护',
      content: '接地、防雷、防静电符合规范',
    },
    {
      key: 'safety-6-3',
      no: '6.3',
      category: '安全防护',
      content: '消防、应急设施完好，不影响原有安全防护功能',
    },
    {
      key: 'signage-7-1',
      no: '7.1',
      category: '标识标牌',
      content: '标识标牌齐全、规范（如设备标识、警示标识等）',
    },
    {
      key: 'signage-7-2',
      no: '7.2',
      category: '标识标牌',
      content: '安全出口标识清晰、通道畅通，门锁可快速开启',
    },
    {
      key: 'signage-7-3',
      no: '7.3',
      category: '标识标牌',
      content: '高压、危险、禁止等警示标识完整、清晰',
    },
    {
      key: 'overall-8-1',
      no: '8.1',
      category: '现场总体检查',
      content: '无异常噪音、异常气味、泄漏、发热、闪光等现象',
    },
    {
      key: 'overall-8-2',
      no: '8.2',
      category: '现场总体检查',
      content: '施工围挡、警示线已撤除，现场恢复使用状态',
    },
  ] as const;
export const CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS: readonly ConstructionCompletionChecklistTemplateItem[] =
  [
    {
      key: 'compliance-1-1',
      no: '1.1',
      category: '合规性',
      content: '施工流程符合数据中心运维安全规范，未违规操作',
    },
    {
      key: 'compliance-1-2',
      no: '1.2',
      category: '合规性',
      content: '施工过程未对周边设备、系统造成影响',
    },
    {
      key: 'compliance-1-3',
      no: '1.3',
      category: '合规性',
      content: '施工记录内容完整、格式规范、可追溯',
    },
    {
      key: 'temporary-power-2-1',
      no: '2.1',
      category: '临时用电',
      content: '已全部拆除，现场无残留临时配电设施',
    },
    {
      key: 'temporary-power-2-2',
      no: '2.2',
      category: '临时用电',
      content: '所有临时电线已收回，线径、护套完整，无残余',
    },
    {
      key: 'temporary-power-2-3',
      no: '2.3',
      category: '临时用电',
      content: '正式供电恢复，所有临时开关、保险已复位',
    },
    {
      key: 'tools-3-1',
      no: '3.1',
      category: '物品工具收回',
      content: '所有电动工具、测量仪表、焊接设备等已归位/搬离现场',
    },
    {
      key: 'tools-3-2',
      no: '3.2',
      category: '物品工具收回',
      content: '安全帽、防护手套、防护眼镜、防护服等已全部收回',
    },
    {
      key: 'cleaning-4-1',
      no: '4.1',
      category: '环境与清洁',
      content: '施工垃圾全部清理完毕，现场环境整洁',
    },
    {
      key: 'signage-5-1',
      no: '5.1',
      category: '标识标牌',
      content: '安全出口标识清晰、通道畅通，门锁可快速开启',
    },
    {
      key: 'signage-5-2',
      no: '5.2',
      category: '标识标牌',
      content: '高压、危险、禁止等警示标识完整、清晰',
    },
    {
      key: 'overall-6-1',
      no: '6.1',
      category: '现场总体检查',
      content: '无异常噪音、异常气味、泄漏、发热、闪光等现象',
    },
  ] as const;
export const CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS =
  CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS;
export interface ConstructionFollowupCreateResponse {
  success: boolean;
  recordId: string;
  recordUrl: string | null;
  constructionRecordId: string;
  updated?: boolean;
  attachmentSyncPending?: boolean;
  pendingSync?: boolean;
  taskId?: string;
  retryTaskId?: string;
  message: string;
}
export interface ConstructionAttachmentDeleteRequest {
  source: 'followup' | 'overview';
  recordId: string;
  fieldKey: string;
  fileToken: string;
}
export interface ConstructionAttachmentDeleteResponse {
  success: boolean;
  source: 'followup' | 'overview';
  recordId: string;
  fieldKey: string;
  field: string;
  fileToken: string;
  remaining: number;
  message: string;
}
export interface ConstructionProjectDeleteRequest {
  recordId: string;
  constructionCode?: string | null;
}
export interface ConstructionProjectDeleteResponse {
  success: boolean;
  recordId: string;
  constructionCode: string;
  pending?: boolean;
  taskId?: string;
  deleted: {
    overview: number;
    followups: number;
    crewLedger: number;
    crewLedgerViews?: number;
  };
  message: string;
}
export interface ConstructionProjectTerminateRequest {
  recordId: string;
  constructionCode?: string | null;
}
export interface ConstructionProjectTerminateResponse {
  success: boolean;
  recordId: string;
  constructionCode: string;
  workflow: string;
  message: string;
}
export interface ConstructionCrewRosterOutlookSyncRequest {
  recordId: string;
  constructionCode?: string | null;
}
export interface ConstructionCrewRosterOutlookSyncResponse {
  success: boolean;
  recordId: string;
  constructionCode: string;
  source: {
    messageSubject: string;
    receivedDateTime: string | null;
    attachmentName: string;
  };
  synced: {
    parsed: number;
    created: number;
    updated: number;
  };
  message: string;
}
export interface ConstructionCrewRosterUploadSyncRequest {
  recordId: string;
  constructionCode?: string | null;
  authorizationStartDate: string;
  authorizationEndDate: string;
}
export interface ConstructionCrewRosterUploadSyncResponse {
  success: boolean;
  pending?: boolean;
  taskId?: string;
  recordId: string;
  constructionCode: string;
  authorizationStartDate: string;
  authorizationEndDate: string;
  synced?: {
    parsed: number;
    created: number;
    updated: number;
  };
  certificateCheck?: {
    queried: number;
    compliant: number;
    issue: number;
    pending: number;
    summary: string;
    issues?: string[];
  };
  message: string;
}
export interface SyncTaskStatusResponse {
  success: boolean;
  message?: string;
  task?: {
    id: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    startTime?: string | Date;
    endTime?: string | Date;
    message?: string;
    total?: number;
    inserted?: number;
    failed?: number;
    result?: unknown;
  };
}
export interface ConstructionStaffCandidate {
  id: string;
  name: string;
  recordId: string;
  employeeNo: string | null;
  phone?: string | null;
  position: string | null;
  buildingSpecialties: string[];
  team: string | null;
  shift: string | null;
  onDutyToday: string | null;
}
export interface ConstructionStaffCandidatesResponse {
  configured: boolean;
  items: ConstructionStaffCandidate[];
  total: number;
  message?: string;
}
export interface ConstructionChangeOrderCandidate {
  id: string;
  title: string;
  description: string | null;
  workType: string | null;
  progress: string | null;
  status: string | null;
  buildings: string[];
  specialties: string[];
  level: string | null;
  planStartTime: string | null;
  planEndTime: string | null;
  submitter: string | null;
  risk: string | null;
}
export interface ConstructionChangeOrderCandidatesResponse {
  configured: boolean;
  items: ConstructionChangeOrderCandidate[];
  total: number;
  message?: string;
}
/**
 * 组织架构记录
 */
export interface NantongOrganization {
  id: string;
  recordId: string;
  code: string | null;
  position: string;
  buildingsSpecialties: string[];
  supervisor: string | null;
  dutyAccount: string[];
  supervisorText: string | null;
  parentRecord: string | null;
  photoUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  /** 受保护的本地飞书会话跳转地址，不包含飞书账号标识。 */
  feishuChatUrl?: string | null;
  shift?: string | null;
  createdAt: string;
  updatedAt: string;
}
/**
 * 组织架构列表响应
 */
export interface NantongOrganizationResponse {
  organizations: NantongOrganization[];
  /** Names that can be written to the change-request Feishu user field. */
  changeRequestSubmitters?: string[];
}
/**
 * 排班页公开人员资料。仅包含页面计算和展示必需字段。
 */
export interface PersonProfile {
  supervisorText: string;
  position: string;
  buildingsSpecialties: string[];
  shift: string | null;
}
export interface PersonProfileResponse {
  organizations: PersonProfile[];
  /** Public names only; account identifiers never leave the server. */
  changeRequestSubmitters?: string[];
}
export interface PersonProfileDetail extends PersonProfile {
  recordId: string;
  photoUrl: string | null;
  phone: string | null;
  /** 受保护的本地飞书会话跳转地址，不包含飞书账号标识。 */
  feishuChatUrl: string | null;
}
export interface PersonProfileDetailResponse {
  organizations: PersonProfileDetail[];
}
/**
 * 值班人员
 */
export interface DutyStaff {
  id: string;
  /** Stable source used by the restricted organization profile endpoint. */
  profileSource?: import('./organization-person-profile').OrganizationPersonProfileSource;
  appName: string | null;
  position: string | null;
  buildingProfessional: string[];
  shift: string | null;
  photoUrl?: string | null;
  email?: string | null;
  phone?: string | null;
}
/**
 * 按楼栋和班次分组的值班人员
 */
export interface DutyStaffByBuilding {
  building: string;
  shifts: {
    shift: string;
    leader: DutyStaff | null;
    staff: DutyStaff | null;
  }[];
}
/**
 * 值班人员列表响应
 */
export interface DutyStaffResponse {
  staff: DutyStaffByBuilding[];
}
/**
 * 非值班排班记录
 */
export interface NonDutySchedule {
  id: string;
  recordId: string;
  dutyCode: string | null;
  code: number | null;
  scheduleDate: string | null;
  building: string | null;
  team: string | null;
  personText: string | null;
  dutyStaffActual: string | null;
  leaveStaff: string | null;
  leaveStaffBitable: string[];
  substituteStaffBitable: string[];
  lastModifiedTime: string | null;
}
/**
 * 非值班排班列表响应
 */
export interface NonDutyScheduleResponse {
  schedules: NonDutySchedule[];
}
/**
 * 节日&重保排班记录
 */
export interface HolidayDutySchedule {
  id: string;
  recordId: string;
  dutyCode: string | null;
  code: number | null;
  scheduleDate: string | null;
  dutyType: string | null;
  scheduleWeekday: string | null;
  weekNumber: number | null;
  building: string | null;
  dutyStaff: string | null;
  dutyStaffText: string | null;
}
/**
 * 节日&重保排班列表响应
 */
export interface HolidayDutyScheduleResponse {
  schedules: HolidayDutySchedule[];
}
/**
 * 节日重要排班记录（从 app_festival_important_schedule 表）
 */
export interface FestivalSchedule {
  id: string;
  recordId: string | null;
  appShiftId: string | null;
  appCode: number | null;
  appScheduleDate: string | null;
  appHeavyType: string | null;
  appScheduleDateWeek: string | null;
  appYearWeek: string | null;
  appDutyBuilding: string | null;
  appDutyStaff: string[] | null;
  appStaffText: string | null;
}
/**
 * 节日重要排班列表响应
 */
export interface FestivalScheduleResponse {
  schedules: FestivalSchedule[];
}
/**
 * 今日请假人员信息（按楼栋分组）
 */
export interface TodayLeaveStaffByBuilding {
  building: string;
  buildingName: string;
  leaveStaff: string[];
  substituteStaff: string[];
  temporarySubstituteStaff?: string[];
  temporarySubstitutes?: {
    shift: string;
    shiftLabel: string;
    staff: string[];
  }[];
}
/**
 * 今日请假人员响应
 */
export interface TodayLeaveStaffResponse {
  date: string;
  buildings: TodayLeaveStaffByBuilding[];
  totalLeaveCount: number;
}
export interface OperationsKbAttachment {
  name: string;
  url: string;
  type: string;
  isLocal: boolean;
}
export interface OperationsKbMetaTag {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'muted';
}
export interface OperationsKbDocument {
  id: string;
  title: string;
  recordUrl: string;
  module: string;
  documentType: string;
  specialty: string;
  equipmentType: string;
  scenario: string;
  level: string;
  tags: string[];
  owner: string;
  updatedAt: string;
  sourceUrl: string;
  rawTable: string;
  rawRecordId: string;
  summary: string;
  excerpt: string;
  metaTags: OperationsKbMetaTag[];
  attachments: OperationsKbAttachment[];
}
export interface OperationsKbDocumentDetail extends OperationsKbDocument {
  rawFields: Record<string, string>;
  content: string;
}
export interface OperationsKbFacetItem {
  value: string;
  count: number;
}
export interface OperationsKbSearchResponse {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  facets: Record<string, OperationsKbFacetItem[]>;
  results: OperationsKbDocument[];
}
export interface OperationsKbStatsResponse {
  total: number;
  modules: number;
  attachments: number;
  latestUpdatedAt: string | null;
}

export type AliMonthlyReportType =
  | 'alarm_analysis'
  | 'four_item_bundle'
  | 'high_power_top5'
  | 'over_power'
  | 'staff_roster';

export interface AliMonthlyReportTypeOption {
  key: AliMonthlyReportType;
  name: string;
  description: string;
}

export interface AliMonthlyReportConfigResponse {
  reportTypes: AliMonthlyReportTypeOption[];
  defaultYear: number;
  defaultMonth: number;
  outputDir: string;
  outputDirLabel?: string;
  defaultFeishuChatId?: string;
  defaultEmailRecipient?: string;
  emailReady?: boolean;
  emailAppDirLabel?: string;
  toolReady: boolean;
  templateReady: boolean;
  pythonCommand: string;
  configPathReady: boolean;
  missingConfigKeys: string[];
  missingAttachmentConfigKeys?: string[];
  missingEmailConfigKeys?: string[];
}

export interface AliMonthlyReportGenerateRequest {
  reportType: AliMonthlyReportType;
  year: number;
  month: number;
}

export interface AliMonthlyReportBundleRequest {
  year: number;
  month: number;
  sendFeishu?: boolean;
  clientMutationId: string;
}

export interface AliMonthlyReportEmailRequest {
  year: number;
  month: number;
  subject: string;
  recipient: string;
}

export interface AliMonthlyReportFile {
  id: string;
  name: string;
  size: string;
  downloadUrl: string;
  category?: string;
}

export type AliMonthlyReportFileAction = 'open' | 'reveal';

export interface AliMonthlyReportFileActionResponse {
  success: boolean;
  action: AliMonthlyReportFileAction;
  fileId: string;
  fileName: string;
  message: string;
}

export interface AliMonthlyReportGenerateResponse {
  success: boolean;
  reportType: AliMonthlyReportType;
  year: number;
  month: number;
  action?: string;
  message: string;
  files: AliMonthlyReportFile[];
  bundleItems?: AliMonthlyReportFile[];
  logs: string[];
  bitableRecordUrls?: string[];
  feishuMessage?: {
    sent: boolean;
    chatId: string;
    chatIds?: string[];
    messageId?: string;
    error?: string;
    deliveries?: Array<{
      chatId: string;
      recipientType?: 'chat' | 'user';
      recipientName?: string;
      sent: boolean;
      messageId?: string;
      error?: string;
    }>;
  };
}

export interface AliMonthlyReportEmailResponse {
  success: boolean;
  year: number;
  month: number;
  subject: string;
  recipient: string;
  message: string;
  logs: string[];
}
