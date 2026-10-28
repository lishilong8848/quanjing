import { businessAuthorizationSnapshot, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { assertBusinessOperation } from '../../common/access/assert-business-operation';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { HttpService } from '@nestjs/axios';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import { join } from 'path';
// form-data uses `export =`; this import keeps the Nest/Jest CommonJS runtime constructable.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import FormData = require('form-data');
import {
  appRoomScheduleEnhanced,
  appSyncConfig,
  appSealingInfo,
} from '@server/database/schema';
import {
  assertBitableTableConfig,
  getFeishuAuthPayload,
  maskSecret,
  parseFeishuBitableLink,
  readEnv,
} from '@server/common/config/external-services.config';
import { isDatabaseDisabled } from '@server/common/database/unavailable-database';
import {
  type BitableRecordItem,
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue,
  fetchBitableRecords,
  getRecordId,
  invalidateBitableRecordCache,
  normalizeBuildingForFrontend,
  normalizeBuildingLabel,
  normalizeShiftForFrontend,
  normalizeTeamForFrontend,
  pickField,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '@server/common/feishu/bitable-direct-read';
import {
  enrichScheduleRecordsWithLeaveApproval,
  fetchLeaveApprovalSnapshot,
  readApprovedLeaveAssignmentsFromFields,
  readCachedLeaveApprovalSnapshot,
  type LeaveApprovalSnapshot,
} from '@server/common/feishu/leave-approval-source';
import { ResponseCode } from '@server/common/constants/api_response_code';
import { BusinessException } from '@server/common/interfaces/exception.interface';
import {
  DEFAULT_LEAVE_PERSON_PROFILE_TABLE_ID,
  DEFAULT_LEAVE_PERSON_PROFILE_WIKI_TOKEN,
  resolvePersonProfileDetailReadPlan,
  resolvePersonProfileReadPlan,
} from '@server/modules/bitable-sync/person-profile-source';
import { listChangeRequestSubmitters, publicSubmitterId, resolveChangeRequestSubmitterCandidate } from '@server/modules/bitable-sync/change-request-submitter-directory';
import { buildActivePersonnelDirectory, DEFAULT_ACTIVE_PERSONNEL_TABLE_ID, DEFAULT_ACTIVE_PERSONNEL_VIEW_ID } from '@server/modules/bitable-sync/active-personnel-directory';
import { readEmployeeOnboardingConfig } from '@server/modules/bitable-sync/employee-onboarding.config';
import { eq, and, desc, gt, gte, lt, lte, inArray, sql } from 'drizzle-orm';
import type {
  AdditionalMatterCreateRequest,
  AdditionalMatterCreateResponse,
  AdditionalMatterType,
  ChangeScheduleAdjustmentRequest,
  ChangeScheduleAdjustmentResponse,
  ConstructionApplicationCreateRequest,
  ConstructionApplicationCreateResponse,
  ConstructionAttachmentDeleteRequest,
  ConstructionAttachmentDeleteResponse,
  ConstructionAttachmentFile,
  ConstructionChangeOrderCandidate,
  ConstructionChangeOrderCandidatesResponse,
  ConstructionCrewRosterOutlookSyncRequest,
  ConstructionCrewRosterOutlookSyncResponse,
  ConstructionCrewRosterUploadSyncRequest,
  ConstructionCrewRosterUploadSyncResponse,
  ConstructionFollowupCreateRequest,
  ConstructionFollowupCreateResponse,
  ConstructionIsolationPhotoManualReviewUpdateRequest,
  ConstructionIsolationPhotoManualReviewUpdateResponse,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
  ConstructionPermitManualReviewDecision,
  ConstructionPermitManualReviewRequest,
  ConstructionPermitManualReviewResponse,
  ConstructionPermitManualReviewUpdateRequest,
  ConstructionPermitManualReviewUpdateResponse,
  ConstructionProjectDeleteResponse,
  ConstructionProjectTerminateResponse,
  ConstructionStaffCandidate,
  ConstructionStaffCandidatesResponse,
  DutyStaffActualRepairCandidate,
  DutyStaffActualRefreshRequest,
  DutyStaffActualRefreshResponse,
  DutyStaffActualRepairRequest,
  DutyStaffActualRepairResponse,
  DutyStaffActualRepairScanResponse,
  DutyStaffAdjustmentRequest,
  DutyStaffAdjustmentResponse,
  ExceptionFollowUpCreateRequest,
  ExceptionFollowUpCreateResponse,
  ExceptionFollowUpDeleteRequest,
  ExceptionFollowUpDeleteResponse,
  ExceptionFollowUpItem,
  ExceptionFollowUpListResponse,
  ExceptionFollowUpUpdateRequest,
  ExceptionFollowUpUpdateResponse,
  LeaveRequestCreateRequest,
  LeaveRequestCreateResponse,
  LeaveRequestType,
  OvertimeRequestCreateRequest,
  OvertimeRequestCreateResponse,
  SealingRegistrationCreateRequest,
  SealingRegistrationCreateResponse,
  LongWhiteDutyStaffResponse,
  MonthlySchedule,
  MonthlyScheduleScreenshotAccessRequest,
  MonthlyScheduleScreenshotAccessResponse,
  PersonnelMovementCreateRequest,
  PersonnelMovementCreateResponse,
  PersonnelMovementType,
  TodayFocusChecklistResponse,
  TodayFocusListItem,
  TodayFocusSectionStatus,
  TravelStaffAdjustRequest,
  TravelStaffDetailResponse,
  TravelStaffMutationResponse,
  TravelStaffRevokeRequest,
  TravelStaffScheduleRecord,
  TravelStaffUpdateRequest,
  TravelStaffUpdateResponse,
  VacancySubstituteUpdateRequest,
  VacancySubstituteUpdateResponse,
  YearlyChangeInfoResponse,
  YearlySealingInfoResponse,
} from '@shared/api.interface';
import { LEAVE_REQUEST_REASON_MAX_LENGTH } from '@shared/api.interface';
import {
  calculateLeaveRequestImpact,
  createLeaveRequestImpactComparisonKey,
  createLeaveRequestShiftGroups,
  createLeaveRequestTimeCandidates,
  parseShanghaiLocalDateTime,
  type ParsedShanghaiLocalDateTime,
} from '@shared/leave-request-impact';
import {
  calculateOvertimeRequestImpact,
  createOvertimeRequestImpactComparisonKey,
  type OvertimeRequestImpact,
} from '@shared/overtime-request-impact';
import { isOvertimeHistoryDateAllowed } from '@shared/overtime-request-date-window';
import {
  CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE_CODE,
  validateChangeRequest,
  type ChangeRequestAttachmentPartialFailure,
  type ChangeRequestCreateRequest,
  type ChangeRequestCreateResponse,
  type ChangeRequestDocumentSyncResult,
  type ChangeRequestRecordState,
  type ChangeRequestRetryAction,
} from '@shared/change-request';
import type {
  ChangeAdjustmentRequest,
  ChangeAdjustmentResponse,
} from '@shared/change-adjustment';
import type { AccessRole, AccessPrincipal } from '@shared/access-control.interface';
import { assertLeaveRequestPersonnelIdentity } from './leave-request-applicant';
import { bindSelfServiceApplicant } from '@server/common/access/self-service-applicant';
import { isPersonalAccessAccount } from '@shared/self-service-applicant';
import { isStation110DutyApplicant } from '@shared/workforce-request-applicant';
import { assertStation110WorkforceIdentity, bindWorkforceRequestApplicant } from '@server/common/access/workforce-request-applicant';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty, scopeProfessionalBitableRecords } from '@server/common/access/professional-record-scope';
import { isConstructionAttachmentReplacementAllowed, isConstructionManualReviewAutoApprovalRole } from '@shared/construction-manual-review-policy';
import { normalizeExceptionFollowUpComparable } from '@shared/exception-follow-up-match';
import {
  buildLongWhiteDutyStaffByBuilding,
  hasMissingLongWhiteDutyBuildings,
  preferMoreCompleteLongWhiteDutyRows,
  type LongWhiteDutyStaffSourceRow,
} from './long-white-duty-staff';
import {
  buildLeaveSubstituteRepairPlan,
  getShanghaiWeekRange,
  type LeaveSubstituteManualReviewItem,
  type LeaveSubstituteRepairItem,
} from './leave-substitute-audit';
import {
  DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES,
  findWritableDutyProgramModifiedBitableField,
  inferWritableDutyProgramModifiedFieldMetaFromRecordFieldNames,
  pickDutyStaffActualField,
} from './duty-staff-actual-field';
import {
  chunkBitableRecordUpdates,
  dropMissingOptionalBitableField,
  getBitableApiErrorMessage,
  getBitableAxiosErrorMessage,
  getMissingBitableFieldName,
  isSameFieldPayload,
  shouldRetryBitableWriteResponse,
  shouldRetryBitableUpdateWithFieldNames,
  toBitableFieldNamePayload,
  type BitableRecordUpdate,
} from './bitable-record-update';
import { buildDutyProgramModifiedRefreshItem } from './duty-program-modified-refresh';
import {
  isLeaveRequestApprovalComplete,
  resolveApprovalAwareDutyStaffFromFields,
  resolveApprovedLeaveVisibilityFromFields,
} from './approved-leave-visibility';
import { isValidOoxmlDocument } from './change-request-document-validator';
import {
  getDutyProgramModifiedRefreshWindow,
  type DutyStaffActualRefreshWindow,
} from './duty-staff-actual-refresh-window';
import {
  buildFeishuDirectDownloadUrl,
  buildFeishuTmpDownloadUrl,
  extractFeishuTmpDownloadUrl,
  normalizeFeishuTmpDownloadApiUrl,
} from './construction-attachment-download';
import {
  buildExceptionFollowUpItem,
  buildExceptionFollowUpDetailedContent,
  buildExceptionFollowUpFields,
  buildExceptionFollowUpUpdateFields,
  splitExceptionFollowUpDetailedContent,
} from './exception-follow-up';
import {
  CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS,
  CONSTRUCTION_DAILY_PERSONNEL_CHECK_AUDIT_FIELD,
  CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
  CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS,
  CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
  CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS,
  buildConstructionApplicationFields,
  buildConstructionCompletionChecklistFile,
  buildConstructionCrewLedgerViewFilterPayload,
  buildConstructionCrewLedgerViewName,
  buildConstructionFollowupFields,
  buildConstructionFollowupOverviewFields,
  buildConstructionImageAuditStatus,
  buildConstructionManagementView,
  buildConstructionPermitAuditFeedback,
  buildConstructionPermitAuditRequirementLines,
  buildConstructionTrainingAssessmentAuditFeedback,
  buildConstructionTrainingSignInCountVisionPayload,
  buildDailyPersonnelCertificateAuditResult,
  buildConstructionPermitManualReviewFingerprint,
  buildConstructionPermitManualReviewAutoApprovalFields,
  buildConstructionPermitManualReviewWorkflowFields,
  buildConstructionPermitVisionAuditPayload,
  buildConstructionPermitManualReviewResetFields,
  buildDailyPermitAuditFeedbackWithDate,
  buildDailyPersonnelChecklistFile,
  buildIsolationPhotoAuditFeedback,
  buildIsolationPhotoVisionAuditPayload,
  extractConstructionPermitFeedbackExpiryDate,
  extractConstructionPermitManualReviewValidityDate,
  extractConstructionPermitManualReviewValidityRange,
  formatConstructionPermitDailyValidityFeedback,
  formatConstructionPermitVisionAuditFeedback,
  formatIsolationPhotoVisionAuditFeedback,
  filterChangedConstructionUploadFilesByContent,
  hasConstructionApprovalMaterialUpload,
  getConstructionCompletionChecklistItems,
  isConstructionImageUploadFile,
  isConstructionPermitManualReviewWorkflowFileKey,
  mergeConstructionAttachmentFieldValues,
  normalizeConstructionAttachmentFieldValue,
  normalizeConstructionUploadFileName,
  omitUnchangedConstructionFieldValues,
  parseConstructionCrewRosterFiles,
  parseConstructionPermitVisionAuditResponse,
  parseConstructionTrainingSignInCountVisionResponse,
  parseIsolationPhotoVisionAuditResponse,
  shouldRefreshDailyPermitAuditFeedback,
  validateConstructionApplicationSubmission,
  validateConstructionFollowupSubmission,
  CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_END_FIELD_NAMES,
  CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_START_FIELD_NAMES,
  CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_STATUS_FIELD_NAMES,
  CONSTRUCTION_CREW_LEDGER_CONSTRUCTION_CODE_FIELD_NAMES,
  CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD,
  getConstructionCrewAuthorizationStatus,
  inferConstructionTrainingSignInPersonCountFromFiles,
  type ConstructionCrewRosterEntry,
  type ConstructionPermitAuditRequirementRecord,
  type ConstructionPermitVisionAuditContext,
  type IsolationPhotoVisionAuditContext,
  type ConstructionUploadFile,
  extractLinkRecordIds,
} from './construction-management';
import { verifyScreenshotAccessRequest } from './monthly-schedule-screenshot-access';
import {
  ChangeAttachmentStorageService,
  type ChangeAttachmentMetadata,
} from './change-attachment-storage.service';
import {
  BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES,
  uploadStagedBitableAttachment,
  type BitableMultipartPreparePayload,
  type BitableMultipartPart,
  type BitableMultipartFinishPayload,
} from './change-attachment-upload';
import { extendChangeInfoWithAdjustmentRecord } from './change-adjustment-record';
import { mapChangeAdjustmentRecordSnapshot } from './change-adjustment-record';
import {
  ChangeAdjustmentService,
  type ChangeAdjustmentRecordSnapshot,
} from './change-adjustment.service';
import {
  ChangeDrillReportService,
  type PersistedChangeDrillReportSnapshot,
} from './change-drill-report.service';
import type {
  ChangeDrillReportCreateRequest,
  ChangeDrillReportCreateResponse,
} from '../../../shared/change-drill-report';
import {
  ChangeSummaryReportService,
  scrubChangeRequestSelfTestLedgerDirectory,
  type ChangeSummaryReportAbandonPorts,
  type ChangeSummaryReportCleanupPorts,
  type ChangeSummaryReportExecutionPorts,
  type ChangeSummaryReportSelfTestCleanupRequest,
  type ChangeSummaryReportSelfTestCleanupResponse,
  type PersistedChangeSummaryReportSnapshot,
} from './change-summary-report.service';
import { finalizeFailedChangeSummarySelfTestLedgers } from './change-summary-report-failed-self-test-cleanup';
import {
  finalizeFailedChangeSummarySelfTestCleanup as finalizeFailedChangeSummarySelfTestCleanupAfterProof,
  type FailedChangeSummarySelfTestCleanupRequest,
} from './change-summary-report-failed-self-test-finalizer';
import type {
  ChangeSummaryReportAbandonRequest,
  ChangeSummaryReportAbandonResponse,
  ChangeSummaryReportCreateRequest,
  ChangeSummaryReportCreateResponse,
  ChangeSummaryReportSyncTaskResponse,
} from '../../../shared/change-summary-report';

export interface SyncTask {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime: Date;
  endTime?: Date;
  message?: string;
  total?: number;
  inserted?: number;
  failed?: number;
  result?: unknown;
}

type SyncTaskKind = 'general' | 'construction';

function hasOwnRuntimeProperty(
  value: unknown,
  property: string,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, property)
  );
}

function isLeaveProgramWorkflowEnabled(): boolean {
  const value = String(process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED || '').trim();
  if (!value) return true;
  return !/^(?:0|false|no|off)$/iu.test(value);
}

interface BitableFieldMeta {
  field_id: string;
  field_name: string;
  type?: number;
}

interface LeaveRequestFieldConfig {
  startDate: BitableFieldMeta;
  endDate: BitableFieldMeta;
  leaveType: BitableFieldMeta;
  leaveReason: BitableFieldMeta;
  leaveStaffUser: BitableFieldMeta;
  leaveStaffProgramName: BitableFieldMeta;
  legacyLeaveStaffUser?: BitableFieldMeta;
  needSubstitute: BitableFieldMeta;
  substituteStaff: BitableFieldMeta;
  workHours: BitableFieldMeta;
  minimumHours: BitableFieldMeta;
  requestUniqueId: BitableFieldMeta;
  requestFingerprint: BitableFieldMeta;
  impactScheduleRecordIds: BitableFieldMeta;
  screenshot: BitableFieldMeta;
}

interface LeaveProgramWorkflowInitialFieldConfig {
  approvalSource: BitableFieldMeta;
  workflowStatus: BitableFieldMeta;
}

interface OvertimeRequestFieldConfig {
  staffUser: BitableFieldMeta;
  staffName: BitableFieldMeta;
  startAt: BitableFieldMeta;
  endAt: BitableFieldMeta;
  hours: BitableFieldMeta;
  screenshot: BitableFieldMeta;
  reason: BitableFieldMeta;
  requestUniqueId: BitableFieldMeta;
  requestFingerprint: BitableFieldMeta;
}

interface ChangeRequestFieldConfig {
  submitter: BitableFieldMeta;
  nature: BitableFieldMeta;
  meetingStartAt: BitableFieldMeta;
  meetingEndAt: BitableFieldMeta;
  summary: BitableFieldMeta;
  changeType: BitableFieldMeta;
  workType: BitableFieldMeta;
  buildings: BitableFieldMeta;
  plannedStartAt: BitableFieldMeta;
  plannedEndAt: BitableFieldMeta;
  discipline: BitableFieldMeta;
  level: BitableFieldMeta;
  riskSummary: BitableFieldMeta;
  documents: BitableFieldMeta;
}

interface SealingRegistrationFieldConfig {
  sealingInfo: BitableFieldMeta;
  startTime: BitableFieldMeta;
  endTime: BitableFieldMeta;
}

interface QueuedConstructionUploadFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  bufferBase64: string;
}

interface QueuedConstructionFollowupSubmitTask {
  id: string;
  status: 'pending' | 'running' | 'failed';
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  attempts: number;
  request: ConstructionFollowupCreateRequest;
  files: QueuedConstructionUploadFile[];
  accessRole?: AccessRole;
  professionalPrincipal?: AccessPrincipal;
  lastError?: string;
}

class ConstructionFollowupChildTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstructionFollowupChildTaskError';
  }
}

class LeaveRequestAmbiguousWriteError extends ServiceUnavailableException {
  readonly originalError: unknown;

  constructor(message: string, originalError: unknown) {
    super(message);
    this.name = 'LeaveRequestAmbiguousWriteError';
    this.originalError = originalError;
    Object.setPrototypeOf(this, LeaveRequestAmbiguousWriteError.prototype);
  }
}

class OvertimeRequestAmbiguousWriteError extends ServiceUnavailableException {
  readonly originalError: unknown;

  constructor(message: string, originalError: unknown) {
    super({ message, writeDisposition: 'unknown-result' });
    this.name = 'OvertimeRequestAmbiguousWriteError';
    this.originalError = originalError;
    Object.setPrototypeOf(this, OvertimeRequestAmbiguousWriteError.prototype);
  }
}

class ChangeRequestDeadlineExceededError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`变更申请同步时间已用尽：${stage}`);
    this.name = 'ChangeRequestDeadlineExceededError';
    this.stage = stage;
    Object.setPrototypeOf(this, ChangeRequestDeadlineExceededError.prototype);
  }
}

interface ConstructionCrewLedgerRosterFieldNames {
  name: string;
  phone?: string;
  certificateNo?: string;
  certificateType?: string;
  gender?: string;
  carLicenseNo?: string;
  company?: string;
  constructionUnit?: string;
  hasOperateAuthority?: string;
  authorizationScope?: string;
  roleType?: string;
  authorizationStartDate?: string;
  authorizationEndDate?: string;
  authorizationStatus?: string;
  overviewLink?: string;
  constructionCode?: string;
}

interface ConstructionCrewRosterSyncResult {
  parsed: number;
  created: number;
  updated: number;
  members: Array<{
    name: string;
    certificateNo: string | null;
  }>;
  records: ConstructionCrewRosterSyncedRecord[];
}

interface ConstructionCrewRosterSyncedRecord {
  recordId: string;
  name: string;
  certificateNo: string | null;
}

interface ConstructionCrewRosterCertificateCheckSummary {
  queried: number;
  compliant: number;
  issue: number;
  pending: number;
  summary: string;
  issues?: string[];
}

interface ConstructionCertificateFieldMappingEntry {
  expire_field: string;
  review_due_field: string;
  review_actual_field: string;
  attachment_field: string;
}

interface ConstructionCrewRosterOutlookConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  userId: string;
  folderId: string;
  graphBaseUrl: string;
  loginBaseUrl: string;
  scope: string;
  messageLimit: number;
  requireConstructionCodeMatch: boolean;
  subjectKeywords: string[];
  attachmentKeywords: string[];
}

interface OutlookGraphMessage {
  id?: string;
  subject?: string | null;
  receivedDateTime?: string | null;
  hasAttachments?: boolean | null;
}

interface OutlookGraphAttachment {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  contentBytes?: string | null;
  '@odata.type'?: string | null;
}

interface ConstructionCrewRosterOutlookAttachment {
  file: ConstructionUploadFile;
  messageSubject: string;
  receivedDateTime: string | null;
  attachmentName: string;
}

interface ConstructionFollowupPostSaveSyncInput {
  normalized: ReturnType<typeof buildConstructionFollowupFields>['normalized'];
  followupAppToken: string;
  followupRecordId: string;
  tenantAccessToken: string;
  savedFields: Record<string, unknown>;
  existingFields: Record<string, unknown>;
  existingFollowupRecord: BitableRecordItem | null;
  existingFieldsForAttachments: Record<string, unknown>;
  relatedProjectFollowupRecords: BitableRecordItem[];
  retainedFollowupAttachmentFields: Record<string, unknown>;
  hasRetainedFollowupAttachmentFields: boolean;
  normalizedFiles: ConstructionUploadFile[];
  changedNormalizedFiles: ConstructionUploadFile[];
  changedPermitFileKeys: readonly string[];
  inheritanceBlockedPermitFileKeys: readonly string[];
  generatedChecklistFile: ConstructionUploadFile | null;
  hasCrewRosterUpload: boolean;
  shouldEnsureCrewLedgerProjectView: boolean;
  attachmentSyncPending: boolean;
  updatingRecordId: string;
  referenceDate: Date;
  request: ConstructionFollowupCreateRequest;
  accessRole: AccessRole;
  professionalPrincipal?: AccessPrincipal;
}

interface ConstructionMutationCompletedEntry {
  expiresAt: number;
  fingerprint: string;
  response: unknown;
}

interface ConstructionMutationInFlightEntry {
  fingerprint: string;
  promise: Promise<unknown>;
}

interface LeaveRequestMutationCompletedEntry {
  expiresAt: number;
  fingerprint: string;
  response: LeaveRequestCreateResponse;
}

interface LeaveRequestMutationInFlightEntry {
  fingerprint: string;
  promise: Promise<LeaveRequestCreateResponse>;
}

interface LeaveRequestMutationPreparedWrite {
  appToken: string;
  tableId: string;
  tableName: string;
  fields: Record<string, unknown>;
  requestFingerprint: string;
  reconcileOnly: boolean;
}

interface LeaveRequestMutationReplayState {
  preparedWrite?: LeaveRequestMutationPreparedWrite;
  reconcileOnly?: boolean;
}

interface LeaveRequestMutationUnknownEntry {
  fingerprint: string;
  replayState: LeaveRequestMutationReplayState;
  preparedWriteExpiresAt: number | null;
}

interface LeaveRequestMutationUnknownLedgerEntry {
  version: 1;
  state: 'unknown';
  clientMutationHash: string;
  fingerprint: string;
  reconcileOnly: true;
  firstSeenAt: number;
}

interface OvertimeRequestMutationCompletedEntry {
  expiresAt: number;
  fingerprint: string;
  response: OvertimeRequestCreateResponse;
}

interface OvertimeRequestMutationInFlightEntry {
  fingerprint: string;
  promise: Promise<OvertimeRequestCreateResponse>;
}

interface OvertimeRequestMutationPreparedWrite {
  appToken: string;
  tableId: string;
  tableName: string;
  fields: Record<string, unknown>;
  requestFingerprint: string;
  impact: OvertimeRequestImpact;
  reconcileOnly: boolean;
}

interface OvertimeRequestMutationReplayState {
  preparedWrite?: OvertimeRequestMutationPreparedWrite;
  reconcileOnly?: boolean;
}

interface OvertimeRequestMutationUnknownEntry {
  fingerprint: string;
  replayState: OvertimeRequestMutationReplayState;
}

interface OvertimeRequestMutationUnknownLedgerEntry {
  version: 1;
  namespace: 'overtime-request';
  state: 'unknown';
  clientMutationHash: string;
  fingerprint: string;
  reconcileOnly: true;
  firstSeenAt: number;
}

interface ChangeRequestMutationCompletedEntry {
  expiresAt: number;
  fingerprint: string;
  response: ChangeRequestCreateResponse;
}

interface ChangeRequestMutationInFlightEntry {
  fingerprint: string;
  promise: Promise<ChangeRequestCreateResponse>;
}

interface ChangeRequestUploadedDocument {
  fileToken: string;
  name: string;
  size: number;
  storageId?: string;
}

interface ChangeRequestUploadFile {
  fieldname: string;
  originalname: string;
  mimetype?: string;
  size: number;
  buffer?: Buffer;
  storageId?: string;
  sha256?: string;
  signatureValidated?: boolean;
}

interface ChangeRequestMutationPartialEntry {
  expiresAt: number;
  fingerprint: string;
  uploadedByIndex: Map<number, ChangeRequestUploadedDocument>;
  recordState: ChangeRequestRecordState;
  retryAction: ChangeRequestRetryAction;
  recordId?: string;
}

interface ChangeRequestMutationDurableState {
  fingerprint: string;
  uploadedByIndex: Map<number, ChangeRequestUploadedDocument>;
  recordState: ChangeRequestRecordState;
  retryAction: ChangeRequestRetryAction;
  recordId?: string;
  response?: ChangeRequestCreateResponse;
}

interface ChangeRequestMutationUploadLedgerEntry {
  version: 1;
  state: 'uploaded';
  clientMutationId: string;
  fingerprint: string;
  index: number;
  document: ChangeRequestUploadedDocument;
}

interface ChangeRequestMutationRecordLedgerEntry {
  version: 1;
  state: 'record-created';
  clientMutationId: string;
  fingerprint: string;
  recordId: string;
}

interface ChangeRequestMutationRecordUnknownLedgerEntry {
  version: 1;
  state: 'record-unknown';
  clientMutationId: string;
  fingerprint: string;
  clientToken: string;
  retryAction: 'retry-same-mutation';
}

interface ChangeRequestMutationManualReconcileLedgerEntry {
  version: 1;
  state: 'manual-reconcile';
  clientMutationId: string;
  fingerprint: string;
  clientToken: string;
}

interface ChangeRequestMutationCompletedLedgerEntry {
  version: 1;
  state: 'completed';
  clientMutationId: string;
  fingerprint: string;
  recordId: string;
  response: ChangeRequestCreateResponse;
}

interface ChangeRequestDocumentUploadOutcome {
  fileToken?: string;
  error?: string;
  retryable?: boolean;
}

interface BitableViewMeta {
  view_id: string;
  view_name: string;
}

interface DutyStaffActualRepairFieldConfig {
  source: BitableFieldMeta;
  target: BitableFieldMeta;
}

interface VacancySubstituteFieldConfig {
  dutyStaffActual: BitableFieldMeta;
  vacancySubstitute: BitableFieldMeta;
}

interface TravelStaffFieldConfig {
  dutyStaffActual: BitableFieldMeta;
  travelStaff: BitableFieldMeta;
}

interface PersonnelMovementFieldConfig {
  dutyStaffActual: BitableFieldMeta;
  programModified: BitableFieldMeta;
}

interface DutyProgramModifiedRefreshRecordsResult {
  total: number;
  reset: number;
  ruleUpdated: number;
  failed: number;
  failures: Array<{ recordId: string; error: string }>;
  finalValues: Map<string, string>;
}

const CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES = [
  '是否完成',
  '是否缴纳保证金',
  '质保金是否确认',
  '缴纳保证金（元）',
  '被扣款保证金',
  '材料是否上传完成',
  '同步机房经理',
  'AI审核结果-挂牌&隔离照片',
  'AI审核结果-挂牌与隔离照片',
  'AI审核结果-挂牌&隔离合规反馈',
  '挂牌&隔离合规反馈',
  '挂牌与隔离是否合规',
  '挂牌&隔离是否合规',
  '每日收尾检查清单',
  'EHS施工收尾审批',
  'AI审核结果-每日人员核查',
  'AI审核结果-施工申请单',
  'AI审核结果-安全告知书',
  'AI审核结果-安全告知书照片',
  'AI审核结果-风险交底单',
  CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD,
  'AI审核结果-受限空间作业许可证',
  'AI审核结果-临时用电作业许可证',
  'AI审核结果-临时用电许可证',
  'AI审核结果-动火许可证',
  'AI审核结果-高处作业许可证',
  'AI识别反馈（过程）',
  'AI识别反馈（收尾）',
  ...Object.values(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).flatMap(
    (config) => [config.reviewField, config.fingerprintField],
  ),
];
const CONSTRUCTION_OVERVIEW_OPTIONAL_MISSING_FIELD_NAMES = [
  '流程',
  '新建施工单提交',
  '信息及证件查验触发（不用）',
  '是否缴纳保证金',
  '缴纳保证金（元）',
  '被扣款保证金',
  '质保金协议',
  '质保金到账/返还',
  '施工完工检查清单',
];
const CONSTRUCTION_CREW_LEDGER_OPTIONAL_MISSING_FIELD_NAMES = [
  '授权开始日期',
  '授权结束日期',
  '授权状态',
  '关联施工单',
  '施工总览',
  '关联施工项目',
  '施工项目总览',
  '施工项目',
  '施工编码',
  '施工编号',
  '手机号',
  '手机号码',
  '联系电话',
  '联系方式',
  '证件号码',
  '身份证号',
  '身份证号码',
  '证件类型',
  '性别',
  '车牌号',
  '公司',
  '单位',
  '施工单位',
  '是否有操作权限',
  '授权范围',
  '人员角色',
];
const DEFAULT_CONSTRUCTION_CREW_ROSTER_OUTLOOK_KEYWORDS = [
  '施工人员名单',
  '施工人员信息表',
  '施工人员名册',
  '施工人员增删名单',
  'crew roster',
  'roster',
];
const DEFAULT_CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL =
  'http://127.0.0.1:58000';
const DEFAULT_CONSTRUCTION_CERTIFICATE_SERVICE_START_SCRIPT = join(
  process.cwd(),
  'scripts',
  'start-construction-certificate-service.ps1',
);
const CONSTRUCTION_CERTIFICATE_SERVICE_STARTUP_TIMEOUT_MS = 45_000;
const CONSTRUCTION_CERTIFICATE_SERVICE_HEALTH_POLL_MS = 1_000;
const CONSTRUCTION_CERTIFICATE_BATCH_SIZE = 20;
const CONSTRUCTION_CERTIFICATE_FIELD_MAPPING_ALIASES = {
  high_voltage: {
    attachment_field: ['高压证', '高压电工证', '高压电工作业证'],
    expire_field: ['高压证-到期日期', '高压证到期日期', '高压证有效期结束日期'],
    review_due_field: ['高压证-应复审日期', '高压证应复审日期'],
    review_actual_field: ['高压证-实际复审日期', '高压证实际复审日期'],
  },
  low_voltage: {
    attachment_field: ['低压证', '低压电工证', '低压电工作业证'],
    expire_field: ['低压证-到期日期', '低压证到期日期', '低压证有效期结束日期'],
    review_due_field: ['低压证-应复审日期', '低压证应复审日期'],
    review_actual_field: ['低压证-实际复审日期', '低压证实际复审日期'],
  },
  refrigeration: {
    attachment_field: ['制冷证', '制冷与空调证', '制冷与空调作业证'],
    expire_field: ['制冷证-到期日期', '制冷证到期日期', '制冷证有效期结束日期'],
    review_due_field: ['制冷证-应复审日期', '制冷证应复审日期'],
    review_actual_field: ['制冷证-实际复审日期', '制冷证实际复审日期'],
  },
  working_at_height: {
    attachment_field: ['登高证', '高处作业证', '高处安装维护拆除证'],
    expire_field: ['登高证-到期日期', '登高证到期日期', '登高证有效期结束日期'],
    review_due_field: ['登高证-应复审日期', '登高证应复审日期'],
    review_actual_field: ['登高证-实际复审日期', '登高证实际复审日期'],
  },
  working_at_height_erection: {
    attachment_field: ['登高架设证', '高处架设证'],
    expire_field: ['登高架设证-到期日期', '登高架设证到期日期'],
    review_due_field: ['登高架设证-应复审日期', '登高架设证应复审日期'],
    review_actual_field: ['登高架设证-实际复审日期', '登高架设证实际复审日期'],
  },
  welding: {
    attachment_field: ['焊接证', '焊接与热切割证', '焊工证'],
    expire_field: [
      '焊接证-到期日期',
      '焊接与热切割证-到期日期',
      '焊接证有效期结束日期',
    ],
    review_due_field: ['焊接证-应复审日期', '焊接与热切割证-应复审日期'],
    review_actual_field: ['焊接证-实际复审日期', '焊接与热切割证-实际复审日期'],
  },
} as const;
const CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES = {
  name: ['姓名', '人员姓名', '施工人员'],
  phone: ['手机号', '手机号码', '联系电话', '联系方式'],
  certificateNo: ['证件号码', '身份证号', '身份证号码', '证件号'],
  certificateType: ['证件类型', '证件类别'],
  gender: ['性别'],
  carLicenseNo: ['车牌号', '车牌'],
  company: [
    '公司',
    '单位',
    '所属公司',
    '所属单位',
    '施工公司',
    '单位名称',
    '公司名称',
    '乙方公司名称',
    '外包单位',
    '承包单位',
  ],
  constructionUnit: ['施工单位'],
  hasOperateAuthority: ['是否有操作权限', '操作权限'],
  authorizationScope: ['授权范围', '授权区域', '授权区域/范围'],
  roleType: ['人员角色', '角色'],
  overviewLink: [
    '关联施工单',
    '施工总览',
    '关联施工项目',
    '施工项目总览',
    '施工项目',
  ],
} as const;
const NON_WRITABLE_BITABLE_FIELD_TYPES = new Set([
  19, 20, 1001, 1002, 1003, 1004, 1005,
]);
const CONSTRUCTION_ROOM_MANAGER_SYNC_FIELD_NAMES = [
  '同步机房经理',
  '同步机房经理状态',
  '同步机房经理结果',
  '是否同步机房经理',
  '是否同步机房机房经理',
];
const CONSTRUCTION_FOLLOWUP_DEPOSIT_CONFIRMATION_FIELD_NAMES = [
  '是否缴纳保证金',
  '质保金是否确认',
  '保证金是否确认',
  '施工保证金是否确认',
];
const CONSTRUCTION_PERMIT_UPLOAD_FIELD_NAMES = new Set(
  Object.keys(CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS),
);
const CONSTRUCTION_REPLACEABLE_PERMIT_ATTACHMENT_FIELDS: Record<
  string,
  string
> = Object.fromEntries(
  Object.keys(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS)
    .map((fieldKey) => [
      fieldKey,
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fieldKey],
    ])
    .filter((entry): entry is [string, string] => Boolean(entry[1])),
);
const CONSTRUCTION_ATTACHMENT_UPLOAD_CONCURRENCY = 2;
const CONSTRUCTION_ATTACHMENT_UPLOAD_MAX_ATTEMPTS = 4;
const CONSTRUCTION_ATTACHMENT_UPLOAD_RETRY_BASE_DELAY_MS = 1000;
const BITABLE_ATTACHMENT_UPLOAD_MIN_INTERVAL_MS = 220;
const CONSTRUCTION_BITABLE_WRITE_MAX_ATTEMPTS = 3;
const CONSTRUCTION_BITABLE_WRITE_RETRY_BASE_DELAY_MS = 800;
const CONSTRUCTION_FOLLOWUP_AUDIT_DEADLINE_MS = 45 * 1000;
const CONSTRUCTION_MUTATION_ID_MAX_LENGTH = 128;
const CONSTRUCTION_MUTATION_COMPLETED_TTL_MS = 5 * 60 * 1000;
const CONSTRUCTION_MUTATION_COMPLETED_MAX_ENTRIES = 500;
const LEAVE_REQUEST_MUTATION_ID_MAX_LENGTH = 128;
const LEAVE_REQUEST_MUTATION_COMPLETED_TTL_MS = 10 * 60 * 1000;
const LEAVE_REQUEST_MUTATION_COMPLETED_MAX_ENTRIES = 500;
const LEAVE_REQUEST_MUTATION_UNKNOWN_MAX_ENTRIES = 500;
const LEAVE_REQUEST_MUTATION_PREPARED_WRITE_TTL_MS = 24 * 60 * 60 * 1000;
const LEAVE_REQUEST_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
const OVERTIME_REQUEST_TABLE_ID = 'tblpCzmTT3EapaUY';
const OVERTIME_REQUEST_MUTATION_ID_PREFIX = 'overtime-request-';
const OVERTIME_REQUEST_MUTATION_ID_MAX_LENGTH = 128;
const OVERTIME_REQUEST_STAFF_NAME_MAX_LENGTH = 2000;
const OVERTIME_REQUEST_REASON_MAX_LENGTH = 2000;
const OVERTIME_REQUEST_MUTATION_COMPLETED_TTL_MS = 10 * 60 * 1000;
const OVERTIME_REQUEST_MUTATION_COMPLETED_MAX_ENTRIES = 500;
const OVERTIME_REQUEST_MUTATION_UNKNOWN_MAX_ENTRIES = 500;
const CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS = 10 * 60 * 1000;
const CHANGE_REQUEST_MUTATION_COMPLETED_MAX_ENTRIES = 500;
const CHANGE_REQUEST_SYNC_DEADLINE_MS = 360 * 1000;
const CHANGE_REQUEST_ATTACHMENT_UPLOAD_CONCURRENCY = 1;
const CHANGE_REQUEST_ATTACHMENT_UPLOAD_MAX_ATTEMPTS = 5;
const CHANGE_REQUEST_ATTACHMENT_REQUEST_TIMEOUT_MS = 60 * 1000;
const CHANGE_DRILL_REPORT_ATTACHMENT_FIELD_NAME =
  '变更演练报告（风险中及以上）';
const CHANGE_SELF_TEST_CLEANUP_PROOF_TTL_MS = 2 * 60 * 1000;
const CHANGE_SELF_TEST_SUMMARY_PATTERN =
  /^CODEX-SELFTEST-CHANGE-(?:SUMMARY-)?\d{13}-[0-9a-f]{8}$/;
const CHANGE_SELF_TEST_ADJUSTMENT_REASON_PATTERN =
  /^CODEX-SELFTEST-CHANGE-ADJUST-\d{13}-[0-9a-f]{8}$/;
const CHANGE_SELF_TEST_RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/;
const CHANGE_SELF_TEST_OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;
const CHANGE_SELF_TEST_CREATE_OWNER_PATTERN =
  /^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANGE_SELF_TEST_ADJUSTMENT_OWNER_PATTERN =
  /^change-adjustment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEAVE_REQUEST_TYPES = new Set<LeaveRequestType>([
  '年假',
  '病假',
  '育儿假',
  '调休',
  '复审',
  '事假',
  '丧假',
  '婚假',
  '差旅',
]);

export interface ChangeSelfTestBoundAttachmentCleanupRequest {
  recordId: string;
  summaryMarker: string;
  adjustmentMutationId: string;
  adjustmentReasonMarker: string;
  adjustmentConfirmed: boolean;
  objectId: string;
  ownerMutationId: string;
  expiresAt: number;
}

export interface ChangeSelfTestBoundAttachmentCleanupResponse {
  success: true;
  objectId: string;
  missing: boolean;
}

export function createChangeSelfTestCleanupProof(
  request: ChangeSelfTestBoundAttachmentCleanupRequest,
  encodedSecret: string,
): string {
  const normalized = normalizeChangeSelfTestCleanupRequest(request);
  const secret = decodeChangeSelfTestCleanupSecret(encodedSecret);
  if (!secret) throw new Error('变更自测清理签名密钥无效');
  return crypto
    .createHmac('sha256', secret)
    .update(changeSelfTestCleanupProofPayload(normalized))
    .digest('base64url');
}
const CONSTRUCTION_FOLLOWUP_SUBMIT_QUEUE_DIR = join(
  process.cwd(),
  'data',
  'construction-followup-submit-queue',
);
const CONSTRUCTION_FOLLOWUP_SUBMIT_RETRY_INITIAL_DELAY_MS = 5000;
const CONSTRUCTION_FOLLOWUP_SUBMIT_RETRY_BASE_DELAY_MS = 30000;
const CONSTRUCTION_FOLLOWUP_SUBMIT_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
const CONSTRUCTION_FOLLOWUP_CHILD_TASK_POLL_INTERVAL_MS = 100;
const CONSTRUCTION_FOLLOWUP_CHILD_TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeChangeSelfTestCleanupRequest(
  value: ChangeSelfTestBoundAttachmentCleanupRequest,
): ChangeSelfTestBoundAttachmentCleanupRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('变更自测清理请求无效');
  }
  const recordId = String(value.recordId || '').trim();
  const summaryMarker = String(value.summaryMarker || '').trim();
  const adjustmentMutationId = String(value.adjustmentMutationId || '').trim();
  const adjustmentReasonMarker = String(
    value.adjustmentReasonMarker || '',
  ).trim();
  const objectId = String(value.objectId || '').trim();
  const ownerMutationId = String(value.ownerMutationId || '').trim();
  const expiresAt = value.expiresAt;
  if (
    !CHANGE_SELF_TEST_RECORD_ID_PATTERN.test(recordId) ||
    !CHANGE_SELF_TEST_SUMMARY_PATTERN.test(summaryMarker) ||
    !CHANGE_SELF_TEST_ADJUSTMENT_OWNER_PATTERN.test(adjustmentMutationId) ||
    !CHANGE_SELF_TEST_ADJUSTMENT_REASON_PATTERN.test(adjustmentReasonMarker) ||
    !CHANGE_SELF_TEST_OBJECT_ID_PATTERN.test(objectId) ||
    (!CHANGE_SELF_TEST_CREATE_OWNER_PATTERN.test(ownerMutationId) &&
      !CHANGE_SELF_TEST_ADJUSTMENT_OWNER_PATTERN.test(ownerMutationId)) ||
    typeof value.adjustmentConfirmed !== 'boolean' ||
    !Number.isSafeInteger(expiresAt)
  ) {
    throw new BadRequestException('变更自测清理请求无效');
  }
  if (
    ownerMutationId.startsWith('change-adjustment-') &&
    (ownerMutationId !== adjustmentMutationId || !value.adjustmentConfirmed)
  ) {
    throw new BadRequestException('变更自测清理请求归属无效');
  }
  return {
    recordId,
    summaryMarker,
    adjustmentMutationId,
    adjustmentReasonMarker,
    adjustmentConfirmed: value.adjustmentConfirmed,
    objectId,
    ownerMutationId,
    expiresAt,
  };
}

function changeSelfTestCleanupProofPayload(
  value: ChangeSelfTestBoundAttachmentCleanupRequest,
): string {
  return [
    'vnet-change-self-test-cleanup-v1',
    value.recordId,
    value.summaryMarker,
    value.adjustmentMutationId,
    value.adjustmentReasonMarker,
    value.adjustmentConfirmed ? '1' : '0',
    value.objectId,
    value.ownerMutationId,
    String(value.expiresAt),
  ].join('\n');
}

function decodeChangeSelfTestCleanupSecret(value: string): Buffer | null {
  const encoded = String(value || '').trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return null;
  }
  try {
    const secret = Buffer.from(encoded, 'base64');
    return secret.length === 32 && secret.toString('base64') === encoded
      ? secret
      : null;
  } catch {
    return null;
  }
}

function verifyChangeSelfTestCleanupProof(
  request: ChangeSelfTestBoundAttachmentCleanupRequest,
  proof: string,
  now = Date.now(),
): ChangeSelfTestBoundAttachmentCleanupRequest {
  const normalized = normalizeChangeSelfTestCleanupRequest(request);
  if (
    normalized.expiresAt < now ||
    normalized.expiresAt > now + CHANGE_SELF_TEST_CLEANUP_PROOF_TTL_MS
  ) {
    throw new ForbiddenException('变更自测清理签名已失效');
  }
  const configuredSecret = String(
    process.env.LOCAL_ACCESS_SESSION_SECRET ||
      process.env.LOCAL_ADMIN_SESSION_SECRET ||
      '',
  ).trim();
  const secret = decodeChangeSelfTestCleanupSecret(configuredSecret);
  const supplied = String(proof || '').trim();
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) {
    throw new ForbiddenException('变更自测清理签名无效');
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(changeSelfTestCleanupProofPayload(normalized))
    .digest();
  const actual = Buffer.from(supplied, 'base64url');
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    throw new ForbiddenException('变更自测清理签名无效');
  }
  return normalized;
}

interface ConstructionImageAuditConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
}

function shouldInferConstructionPermitOnlyUpload(
  request: ConstructionFollowupCreateRequest,
  files: ConstructionUploadFile[],
): boolean {
  const followupMode =
    String(request?.followupMode || 'daily').trim() || 'daily';
  if (followupMode !== 'daily') {
    return false;
  }
  if (
    !files.some((file) =>
      CONSTRUCTION_PERMIT_UPLOAD_FIELD_NAMES.has(file.fieldname),
    )
  ) {
    return false;
  }

  return ![
    request?.dailyPersonnelCheck,
    request?.isolationFeedback,
    request?.processFeedback,
    request?.closingFeedback,
    request?.completed,
    request?.completionChecklist,
  ].some(hasNonEmptyConstructionFormValue);
}

function hasNonEmptyConstructionFormValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return String(value || '').trim().length > 0;
}

function omitUnchangedConstructionPersonFields(
  fields: Record<string, unknown>,
  existingFields: Record<string, unknown> = {},
): Record<string, unknown> {
  const nextFields = { ...fields };
  (['跟进人员'] as const).forEach((fieldName) => {
    if (!(fieldName in nextFields)) {
      return;
    }
    if (
      areSameConstructionUserFieldValues(
        nextFields[fieldName],
        existingFields[fieldName],
      )
    ) {
      delete nextFields[fieldName];
    }
  });
  return nextFields;
}

function areSameConstructionUserFieldValues(
  nextValue: unknown,
  existingValue: unknown,
): boolean {
  const nextIds = normalizeConstructionUserFieldIds(nextValue);
  const existingIds = normalizeConstructionUserFieldIds(existingValue);
  return (
    nextIds.length > 0 &&
    nextIds.length === existingIds.length &&
    nextIds.every((id, index) => id === existingIds[index])
  );
}

function normalizeConstructionUserFieldIds(value: unknown): string[] {
  return Array.from(
    new Set(
      flattenConstructionUserFieldItems(value)
        .map((item) => {
          if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            return extractDisplayText(
              pickField(record, ['id', 'open_id', 'user_id', 'union_id']),
              '',
            );
          }
          return extractDisplayText(item, '');
        })
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function flattenConstructionUserFieldItems(value: unknown): unknown[] {
  if (!hasNonEmptyConstructionFormValue(value)) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenConstructionUserFieldItems);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.users)) {
      return record.users.flatMap(flattenConstructionUserFieldItems);
    }
  }
  return [value];
}

const DEFAULT_QWEN_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_QWEN_VISION_MODEL = 'qwen-vl-max-latest';
const DEFAULT_IMAGE_AUDIT_RETRY_ATTEMPTS = 3;
const DEFAULT_IMAGE_AUDIT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_CONSTRUCTION_CART_SERVICE_ENV_PATH =
  'D:\\ai\\codex\\施工管理\\cart_service\\.env';

interface ConstructionProjectMutationRequest {
  recordId: string;
  constructionCode?: string | null;
}

type FeishuMessageReceiveIdType = 'chat_id' | 'user_id' | 'open_id' | 'email';

interface TravelStaffMutationTarget {
  recordId: string;
  scheduleDate: string;
  staffName: string;
  currentActualText: string;
  currentTravelText: string;
  nextActualText: string;
  nextTravelText: string;
}

interface PersonnelMovementMutationTarget {
  recordId: string;
  scheduleDate: string;
  staffName: string;
  currentText: string;
  nextText: string;
}

interface LeaveSubstituteRepairRunOptions {
  referenceDate?: string | Date;
  forceRefresh?: boolean;
  notify?: boolean;
  source?: string;
}

export interface LeaveSubstituteRepairRunResult {
  success: boolean;
  source: string;
  scanStartDate: string;
  scanEndDate: string;
  year: number;
  checkedSchedules: number;
  mismatches: number;
  plannedRepairs: number;
  updated: number;
  failed: number;
  manualReview: number;
  results: Array<LeaveSubstituteRepairItem & { updated: boolean }>;
  failures: Array<LeaveSubstituteRepairItem & { error: string }>;
  manualReviews: LeaveSubstituteManualReviewItem[];
  notified: boolean;
  notificationError?: string;
  message: string;
}

interface FocusBitableConfig {
  appToken: string;
  wikiToken: string;
  tableId: string;
  viewId: string;
  tableName: string;
  sourceUrl: string;
}

interface BitableSourceConfigOptions {
  tableName: string;
  sourceUrlEnv: string;
  sourceUrlAliases?: string[];
  defaultSourceUrl?: string;
  appTokenEnv: string;
  appTokenAliases?: string[];
  wikiTokenEnv: string;
  wikiTokenAliases?: string[];
  tableIdEnv: string;
  tableIdAliases?: string[];
  viewIdEnv: string;
  viewIdAliases?: string[];
}

function readBitableSourceConfig(
  options: BitableSourceConfigOptions,
): FocusBitableConfig {
  const sourceUrl =
    readEnv(options.sourceUrlEnv, options.sourceUrlAliases || []) ||
    options.defaultSourceUrl ||
    '';
  const link = parseFeishuBitableLink(sourceUrl);
  const wikiToken =
    readEnv(options.wikiTokenEnv, options.wikiTokenAliases || []) ||
    link.wikiToken;
  const explicitAppToken = readEnv(
    options.appTokenEnv,
    options.appTokenAliases || [],
  );
  const fallbackAppToken = wikiToken
    ? ''
    : readEnv('FEISHU_MAIN_APP_TOKEN', ['FEISHU_BITABLE_APP_TOKEN']);

  return {
    appToken: explicitAppToken || link.appToken || fallbackAppToken,
    wikiToken,
    tableId:
      link.tableId || readEnv(options.tableIdEnv, options.tableIdAliases || []),
    viewId:
      link.viewId || readEnv(options.viewIdEnv, options.viewIdAliases || []),
    tableName: options.tableName,
    sourceUrl,
  };
}

function isDateTimeRangeActiveInWindow(
  startValue: string | Date,
  endValue: string | Date,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  const start = new Date(startValue);
  const end = new Date(endValue);

  return (
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start < windowEnd &&
    end > windowStart
  );
}

const CONSTRUCTION_PERMIT_WORK_TYPE_KEYWORDS: Record<string, string[]> = {
  applicationFiles: [],
  safetyNoticePhotoFiles: [],
  hotWorkRiskDisclosureFiles: ['动火作业'],
  confinedSpacePermitFiles: ['受限空间作业'],
  temporaryPowerPermitFiles: ['临时用电作业'],
  hotWorkPermitFiles: ['动火作业'],
  heightWorkPermitFiles: ['高处作业'],
};

const CONSTRUCTION_RECENT_OVERVIEW_RECORD_TTL_MS = 10 * 60 * 1000;
const SEALING_SOURCE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SEALING_SOURCE_RETRY_INTERVAL_MS = 30 * 1000;
const SEALING_SOURCE_READ_TIMEOUT_MS = 8000;

@Injectable()
export class DutyScheduleService {
  private readonly logger = new Logger(DutyScheduleService.name);
  private isSyncing = false;
  private syncTasks = new Map<string, SyncTask>();
  private currentTaskId: string | null = null; // 同步锁，防止并发同步
  private sealingSourceSnapshot:
    | {
        records: BitableRecordItem[];
        expiresAt: number;
        fetchedAt: number;
        stale: boolean;
      }
    | undefined;
  private sealingSourceRefreshRequest: Promise<BitableRecordItem[]> | null =
    null;
  private readonly queuedConstructionFollowupSubmitTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly constructionAttachmentWriteTails = new Map<
    string,
    Promise<void>
  >();
  private readonly constructionMutationInFlight = new Map<
    string,
    ConstructionMutationInFlightEntry
  >();
  private readonly constructionMutationCompleted = new Map<
    string,
    ConstructionMutationCompletedEntry
  >();
  private readonly leaveRequestMutationInFlight = new Map<
    string,
    LeaveRequestMutationInFlightEntry
  >();
  private readonly leaveRequestMutationCompleted = new Map<
    string,
    LeaveRequestMutationCompletedEntry
  >();
  private readonly leaveRequestMutationUnknown = new Map<
    string,
    LeaveRequestMutationUnknownEntry
  >();
  private readonly leaveRequestPreparedWriteExpiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private leaveRequestMutationLedgerDir =
    process.env.NODE_ENV === 'test'
      ? ''
      : readEnv('LEAVE_REQUEST_MUTATION_LEDGER_DIR') ||
        join(process.cwd(), 'data', 'leave-request-mutations');
  private readonly overtimeRequestMutationInFlight = new Map<
    string,
    OvertimeRequestMutationInFlightEntry
  >();
  private readonly overtimeRequestMutationCompleted = new Map<
    string,
    OvertimeRequestMutationCompletedEntry
  >();
  private readonly overtimeRequestMutationUnknown = new Map<
    string,
    OvertimeRequestMutationUnknownEntry
  >();
  private overtimeRequestMutationLedgerDir =
    process.env.NODE_ENV === 'test'
      ? ''
      : readEnv('OVERTIME_REQUEST_MUTATION_LEDGER_DIR') ||
        join(process.cwd(), 'data', 'overtime-request-mutations');
  private readonly changeRequestMutationInFlight = new Map<
    string,
    ChangeRequestMutationInFlightEntry
  >();
  private readonly changeRequestMutationCompleted = new Map<
    string,
    ChangeRequestMutationCompletedEntry
  >();
  private readonly changeRequestMutationPartial = new Map<
    string,
    ChangeRequestMutationPartialEntry
  >();
  private changeRequestSubmitterFieldMigrationInFlight: Promise<
    BitableFieldMeta[]
  > | null = null;
  private changeRequestMutationLedgerDir =
    process.env.NODE_ENV === 'test'
      ? ''
      : readEnv('CHANGE_REQUEST_MUTATION_LEDGER_DIR') ||
        join(process.cwd(), 'data', 'change-request-mutations');
  private readonly bitableAttachmentUploadTails = new Map<
    string,
    Promise<void>
  >();
  private readonly bitableAttachmentUploadLastStartedAt = new Map<
    string,
    number
  >();
  private readonly recentConstructionOverviewRecords = new Map<
    string,
    { record: BitableRecordItem; expiresAt: number }
  >();
  private readonly scheduleAppToken = readEnv('FEISHU_SCHEDULE_APP_TOKEN', [
    'FEISHU_DUTY_APP_TOKEN',
    'FEISHU_MAIN_APP_TOKEN',
    'FEISHU_BITABLE_APP_TOKEN',
  ]);
  private readonly scheduleTableId = readEnv('FEISHU_SCHEDULE_TABLE_ID', [
    'FEISHU_DUTY_TABLE_ID',
  ]);
  private readonly sealingConfig = readBitableSourceConfig({
    tableName: '封网信息',
    sourceUrlEnv: 'FEISHU_SEALING_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_SEALING_URL'],
    appTokenEnv: 'FEISHU_SEALING_APP_TOKEN',
    wikiTokenEnv: 'FEISHU_SEALING_WIKI_TOKEN',
    tableIdEnv: 'FEISHU_SEALING_TABLE_ID',
    viewIdEnv: 'FEISHU_SEALING_VIEW_ID',
  });
  private readonly focusChangeConfig = readBitableSourceConfig({
    tableName: '今日重点变更',
    sourceUrlEnv: 'FEISHU_FOCUS_CHANGE_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_CHANGE_SOURCE_URL', 'FEISHU_CHANGE_URL'],
    appTokenEnv: 'FEISHU_FOCUS_CHANGE_APP_TOKEN',
    appTokenAliases: ['FEISHU_CHANGE_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_FOCUS_CHANGE_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_CHANGE_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_FOCUS_CHANGE_TABLE_ID',
    tableIdAliases: ['FEISHU_CHANGE_TABLE_ID'],
    viewIdEnv: 'FEISHU_FOCUS_CHANGE_VIEW_ID',
    viewIdAliases: ['FEISHU_CHANGE_VIEW_ID'],
  });
  private readonly calendarChangeConfig = readBitableSourceConfig({
    tableName: '计划变更日历',
    sourceUrlEnv: 'FEISHU_CALENDAR_CHANGE_SOURCE_URL',
    sourceUrlAliases: [
      'FEISHU_CHANGE_CALENDAR_SOURCE_URL',
      'FEISHU_CHANGE_MANAGEMENT_SOURCE_URL',
    ],
    defaultSourceUrl:
      'https://vnet.feishu.cn/wiki/JhiVwgfoIimAqEk8YwEc09sknGd?table=tblBvg6wCYSX3hcg&view=vewew3vfZT',
    appTokenEnv: 'FEISHU_CALENDAR_CHANGE_APP_TOKEN',
    appTokenAliases: [
      'FEISHU_CHANGE_CALENDAR_APP_TOKEN',
      'FEISHU_CHANGE_MANAGEMENT_APP_TOKEN',
    ],
    wikiTokenEnv: 'FEISHU_CALENDAR_CHANGE_WIKI_TOKEN',
    wikiTokenAliases: [
      'FEISHU_CHANGE_CALENDAR_WIKI_TOKEN',
      'FEISHU_CHANGE_MANAGEMENT_WIKI_TOKEN',
    ],
    tableIdEnv: 'FEISHU_CALENDAR_CHANGE_TABLE_ID',
    tableIdAliases: [
      'FEISHU_CHANGE_CALENDAR_TABLE_ID',
      'FEISHU_CHANGE_MANAGEMENT_TABLE_ID',
    ],
    viewIdEnv: 'FEISHU_CALENDAR_CHANGE_VIEW_ID',
    viewIdAliases: [
      'FEISHU_CHANGE_CALENDAR_VIEW_ID',
      'FEISHU_CHANGE_MANAGEMENT_VIEW_ID',
    ],
  });
  private readonly changeDrillReportTableId =
    readEnv('FEISHU_CHANGE_DRILL_REPORT_TABLE_ID') || 'tblZZHIJCY3f551K';
  private readonly changeDrillReportTableName =
    readEnv('FEISHU_CHANGE_DRILL_REPORT_TABLE_NAME') || '变更关单需提交附件';
  private readonly focusIncidentConfig = readBitableSourceConfig({
    tableName: '今日重大事件',
    sourceUrlEnv: 'FEISHU_FOCUS_INCIDENT_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_INCIDENT_SOURCE_URL', 'FEISHU_INCIDENT_URL'],
    appTokenEnv: 'FEISHU_FOCUS_INCIDENT_APP_TOKEN',
    appTokenAliases: ['FEISHU_INCIDENT_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_FOCUS_INCIDENT_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_INCIDENT_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_FOCUS_INCIDENT_TABLE_ID',
    tableIdAliases: ['FEISHU_INCIDENT_TABLE_ID'],
    viewIdEnv: 'FEISHU_FOCUS_INCIDENT_VIEW_ID',
    viewIdAliases: ['FEISHU_INCIDENT_VIEW_ID'],
  });
  private readonly focusOtherConfig = readBitableSourceConfig({
    tableName: '今日其他关注',
    sourceUrlEnv: 'FEISHU_FOCUS_OTHER_SOURCE_URL',
    sourceUrlAliases: [
      'FEISHU_OTHER_FOCUS_SOURCE_URL',
      'FEISHU_OTHER_FOCUS_URL',
    ],
    appTokenEnv: 'FEISHU_FOCUS_OTHER_APP_TOKEN',
    appTokenAliases: ['FEISHU_OTHER_FOCUS_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_FOCUS_OTHER_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_OTHER_FOCUS_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_FOCUS_OTHER_TABLE_ID',
    tableIdAliases: ['FEISHU_OTHER_FOCUS_TABLE_ID'],
    viewIdEnv: 'FEISHU_FOCUS_OTHER_VIEW_ID',
    viewIdAliases: ['FEISHU_OTHER_FOCUS_VIEW_ID'],
  });
  private readonly customerMatterConfig = readBitableSourceConfig({
    tableName: '客户相关',
    sourceUrlEnv: 'FEISHU_CUSTOMER_MATTER_SOURCE_URL',
    sourceUrlAliases: [
      'FEISHU_CUSTOMER_RELATED_SOURCE_URL',
      'FEISHU_CUSTOMER_RELATED_URL',
    ],
    defaultSourceUrl:
      'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblEBCFp7UuUFkFv&view=vew8yvnP9V',
    appTokenEnv: 'FEISHU_CUSTOMER_MATTER_APP_TOKEN',
    appTokenAliases: ['FEISHU_CUSTOMER_RELATED_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_CUSTOMER_MATTER_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_CUSTOMER_RELATED_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_CUSTOMER_MATTER_TABLE_ID',
    tableIdAliases: ['FEISHU_CUSTOMER_RELATED_TABLE_ID'],
    viewIdEnv: 'FEISHU_CUSTOMER_MATTER_VIEW_ID',
    viewIdAliases: ['FEISHU_CUSTOMER_RELATED_VIEW_ID'],
  });
  private readonly constructionOverviewConfig = readBitableSourceConfig({
    tableName: '施工总览',
    sourceUrlEnv: 'FEISHU_CONSTRUCTION_OVERVIEW_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_CONSTRUCTION_SOURCE_URL'],
    appTokenEnv: 'FEISHU_CONSTRUCTION_OVERVIEW_APP_TOKEN',
    appTokenAliases: ['FEISHU_CONSTRUCTION_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_CONSTRUCTION_OVERVIEW_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_CONSTRUCTION_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_CONSTRUCTION_OVERVIEW_TABLE_ID',
    tableIdAliases: ['FEISHU_CONSTRUCTION_TABLE_ID'],
    viewIdEnv: 'FEISHU_CONSTRUCTION_OVERVIEW_VIEW_ID',
    viewIdAliases: ['FEISHU_CONSTRUCTION_VIEW_ID'],
  });
  private readonly constructionFollowupConfig = readBitableSourceConfig({
    tableName: '施工跟进',
    sourceUrlEnv: 'FEISHU_CONSTRUCTION_FOLLOWUP_SOURCE_URL',
    appTokenEnv: 'FEISHU_CONSTRUCTION_FOLLOWUP_APP_TOKEN',
    wikiTokenEnv: 'FEISHU_CONSTRUCTION_FOLLOWUP_WIKI_TOKEN',
    tableIdEnv: 'FEISHU_CONSTRUCTION_FOLLOWUP_TABLE_ID',
    viewIdEnv: 'FEISHU_CONSTRUCTION_FOLLOWUP_VIEW_ID',
  });
  private readonly constructionCrewLedgerConfig = readBitableSourceConfig({
    tableName: '施工人员台账',
    sourceUrlEnv: 'FEISHU_CONSTRUCTION_CREW_LEDGER_SOURCE_URL',
    appTokenEnv: 'FEISHU_CONSTRUCTION_CREW_LEDGER_APP_TOKEN',
    wikiTokenEnv: 'FEISHU_CONSTRUCTION_CREW_LEDGER_WIKI_TOKEN',
    tableIdEnv: 'FEISHU_CONSTRUCTION_CREW_LEDGER_TABLE_ID',
    viewIdEnv: 'FEISHU_CONSTRUCTION_CREW_LEDGER_VIEW_ID',
  });
  private readonly constructionStaffConfig = readBitableSourceConfig({
    tableName: '在职人员名单',
    sourceUrlEnv: 'FEISHU_CONSTRUCTION_STAFF_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_CONSTRUCTION_ONSITE_FOLLOWER_SOURCE_URL'],
    appTokenEnv: 'FEISHU_CONSTRUCTION_STAFF_APP_TOKEN',
    appTokenAliases: ['FEISHU_CONSTRUCTION_ONSITE_FOLLOWER_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_CONSTRUCTION_STAFF_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_CONSTRUCTION_ONSITE_FOLLOWER_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_CONSTRUCTION_STAFF_TABLE_ID',
    tableIdAliases: ['FEISHU_CONSTRUCTION_ONSITE_FOLLOWER_TABLE_ID'],
    viewIdEnv: 'FEISHU_CONSTRUCTION_STAFF_VIEW_ID',
    viewIdAliases: ['FEISHU_CONSTRUCTION_ONSITE_FOLLOWER_VIEW_ID'],
  });
  private readonly constructionChangeOrderConfig = readBitableSourceConfig({
    tableName: '施工关联变更单',
    sourceUrlEnv: 'FEISHU_CONSTRUCTION_CHANGE_ORDER_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_CONSTRUCTION_RELATED_CHANGE_SOURCE_URL'],
    appTokenEnv: 'FEISHU_CONSTRUCTION_CHANGE_ORDER_APP_TOKEN',
    appTokenAliases: ['FEISHU_CONSTRUCTION_RELATED_CHANGE_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_CONSTRUCTION_CHANGE_ORDER_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_CONSTRUCTION_RELATED_CHANGE_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_CONSTRUCTION_CHANGE_ORDER_TABLE_ID',
    tableIdAliases: ['FEISHU_CONSTRUCTION_RELATED_CHANGE_TABLE_ID'],
    viewIdEnv: 'FEISHU_CONSTRUCTION_CHANGE_ORDER_VIEW_ID',
    viewIdAliases: ['FEISHU_CONSTRUCTION_RELATED_CHANGE_VIEW_ID'],
  });
  private readonly constructionPermitAuditRequirementConfig =
    readBitableSourceConfig({
      tableName: '施工表单审核要求',
      sourceUrlEnv: 'FEISHU_CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_SOURCE_URL',
      sourceUrlAliases: [
        'FEISHU_CONSTRUCTION_FORM_AUDIT_REQUIREMENT_SOURCE_URL',
      ],
      defaultSourceUrl:
        'https://vnet.feishu.cn/base/X9CwbB3zhaLK7JsQZVZcFR9fnTf?table=tblSoK80m57QrVLj&view=vewf08XZPM',
      appTokenEnv: 'FEISHU_CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_APP_TOKEN',
      appTokenAliases: ['FEISHU_CONSTRUCTION_FORM_AUDIT_REQUIREMENT_APP_TOKEN'],
      wikiTokenEnv: 'FEISHU_CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_WIKI_TOKEN',
      wikiTokenAliases: [
        'FEISHU_CONSTRUCTION_FORM_AUDIT_REQUIREMENT_WIKI_TOKEN',
      ],
      tableIdEnv: 'FEISHU_CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_TABLE_ID',
      tableIdAliases: ['FEISHU_CONSTRUCTION_FORM_AUDIT_REQUIREMENT_TABLE_ID'],
      viewIdEnv: 'FEISHU_CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_VIEW_ID',
      viewIdAliases: ['FEISHU_CONSTRUCTION_FORM_AUDIT_REQUIREMENT_VIEW_ID'],
    });
  private readonly constructionChangeLinkTableId =
    readEnv('FEISHU_CONSTRUCTION_CHANGE_LINK_TABLE_ID') || 'tbl37f82JHmHkvJ3';
  private readonly constructionChangeLinkTableName =
    readEnv('FEISHU_CONSTRUCTION_CHANGE_LINK_TABLE_NAME') || '施工变更关联底表';
  private readonly longWhiteDutyConfig = readBitableSourceConfig({
    tableName: '今日长白班在岗',
    sourceUrlEnv: 'FEISHU_LONG_WHITE_DUTY_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_LONG_WHITE_ON_DUTY_SOURCE_URL'],
    defaultSourceUrl:
      'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblRV9KeWFh9xCkm&view=vewl3Fg9vD',
    appTokenEnv: 'FEISHU_LONG_WHITE_DUTY_APP_TOKEN',
    appTokenAliases: ['FEISHU_LONG_WHITE_ON_DUTY_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_LONG_WHITE_DUTY_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_LONG_WHITE_ON_DUTY_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_LONG_WHITE_DUTY_TABLE_ID',
    tableIdAliases: ['FEISHU_LONG_WHITE_ON_DUTY_TABLE_ID'],
    viewIdEnv: 'FEISHU_LONG_WHITE_DUTY_VIEW_ID',
    viewIdAliases: ['FEISHU_LONG_WHITE_ON_DUTY_VIEW_ID'],
  });
  private readonly personnelMovementConfig = readBitableSourceConfig({
    tableName: '在职人员',
    sourceUrlEnv: 'FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL',
    sourceUrlAliases: [
      'FEISHU_ORG_SOURCE_URL',
      'FEISHU_ORGANIZATION_SOURCE_URL',
    ],
    defaultSourceUrl:
      'https://vnet.feishu.cn/wiki/AdQmwOqwei6Xr4kag3pcp1Flnmg?table=tblOu75UtJTDNHIM&view=vewrQcypV4',
    appTokenEnv: 'FEISHU_PERSONNEL_MOVEMENT_APP_TOKEN',
    appTokenAliases: ['FEISHU_ORG_APP_TOKEN', 'FEISHU_ORGANIZATION_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_PERSONNEL_MOVEMENT_WIKI_TOKEN',
    wikiTokenAliases: [
      'FEISHU_ORG_WIKI_TOKEN',
      'FEISHU_ORGANIZATION_WIKI_TOKEN',
    ],
    tableIdEnv: 'FEISHU_PERSONNEL_MOVEMENT_TABLE_ID',
    tableIdAliases: ['FEISHU_ORG_TABLE_ID', 'FEISHU_ORGANIZATION_TABLE_ID'],
    viewIdEnv: 'FEISHU_PERSONNEL_MOVEMENT_VIEW_ID',
    viewIdAliases: [
      'FEISHU_ORG_PROFILE_VIEW_ID',
      'FEISHU_ORG_VIEW_ID',
      'FEISHU_ORGANIZATION_PROFILE_VIEW_ID',
      'FEISHU_ORGANIZATION_VIEW_ID',
    ],
  });
  private readonly leavePersonProfileConfig = (() => {
    const config = readBitableSourceConfig({
      tableName: '请休假人员资料',
      sourceUrlEnv: 'FEISHU_LEAVE_PERSON_PROFILE_SOURCE_URL',
      defaultSourceUrl: `https://vnet.feishu.cn/wiki/${DEFAULT_LEAVE_PERSON_PROFILE_WIKI_TOKEN}?table=${DEFAULT_LEAVE_PERSON_PROFILE_TABLE_ID}`,
      appTokenEnv: 'FEISHU_LEAVE_PERSON_PROFILE_APP_TOKEN',
      appTokenAliases: [
        'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
        'FEISHU_LEAVE_REQUEST_APP_TOKEN',
      ],
      wikiTokenEnv: 'FEISHU_LEAVE_PERSON_PROFILE_WIKI_TOKEN',
      wikiTokenAliases: [
        'FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN',
        'FEISHU_LEAVE_REQUEST_WIKI_TOKEN',
      ],
      tableIdEnv: 'FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID',
      viewIdEnv: 'FEISHU_LEAVE_PERSON_PROFILE_VIEW_ID',
    });
    return {
      ...config,
      tableId:
        readEnv('FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID') || config.tableId,
      viewId: '',
    };
  })();
  private readonly leaveSubstituteConfig = readBitableSourceConfig({
    tableName: '请休假替班修正',
    sourceUrlEnv: 'FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL',
    sourceUrlAliases: ['FEISHU_LEAVE_REQUEST_SOURCE_URL'],
    defaultSourceUrl:
      'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblpCzmTT3EapaUY&view=vewHyBE14E',
    appTokenEnv: 'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
    appTokenAliases: ['FEISHU_LEAVE_REQUEST_APP_TOKEN'],
    wikiTokenEnv: 'FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN',
    wikiTokenAliases: ['FEISHU_LEAVE_REQUEST_WIKI_TOKEN'],
    tableIdEnv: 'FEISHU_LEAVE_SUBSTITUTE_TABLE_ID',
    tableIdAliases: ['FEISHU_LEAVE_REQUEST_TABLE_ID'],
    viewIdEnv: 'FEISHU_LEAVE_SUBSTITUTE_VIEW_ID',
    viewIdAliases: ['FEISHU_LEAVE_REQUEST_VIEW_ID'],
  });
  private readonly exceptionFollowUpConfig = (() => {
    const configured = readBitableSourceConfig({
      tableName: '异常项处理跟进',
      sourceUrlEnv: 'FEISHU_EXCEPTION_FOLLOW_UP_SOURCE_URL',
      sourceUrlAliases: [
        'FEISHU_EXCEPTION_FOLLOWUP_SOURCE_URL',
        'FEISHU_EXCEPTION_TRACKING_SOURCE_URL',
      ],
      defaultSourceUrl:
        'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblCGU1ry3tanQ20&view=vewX0MdewN',
      appTokenEnv: 'FEISHU_EXCEPTION_FOLLOW_UP_APP_TOKEN',
      appTokenAliases: [
        'FEISHU_EXCEPTION_FOLLOWUP_APP_TOKEN',
        'FEISHU_EXCEPTION_TRACKING_APP_TOKEN',
      ],
      wikiTokenEnv: 'FEISHU_EXCEPTION_FOLLOW_UP_WIKI_TOKEN',
      wikiTokenAliases: [
        'FEISHU_EXCEPTION_FOLLOWUP_WIKI_TOKEN',
        'FEISHU_EXCEPTION_TRACKING_WIKI_TOKEN',
      ],
      tableIdEnv: 'FEISHU_EXCEPTION_FOLLOW_UP_TABLE_ID',
      tableIdAliases: [
        'FEISHU_EXCEPTION_FOLLOWUP_TABLE_ID',
        'FEISHU_EXCEPTION_TRACKING_TABLE_ID',
      ],
      viewIdEnv: 'FEISHU_EXCEPTION_FOLLOW_UP_VIEW_ID',
      viewIdAliases: [
        'FEISHU_EXCEPTION_FOLLOWUP_VIEW_ID',
        'FEISHU_EXCEPTION_TRACKING_VIEW_ID',
      ],
    });
    if (configured.tableId !== 'tblMK8wzLlFKbTlP') {
      return configured;
    }
    const unifiedSourceUrl =
      'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblCGU1ry3tanQ20&view=vewX0MdewN';
    const unifiedLink = parseFeishuBitableLink(unifiedSourceUrl);
    return {
      ...configured,
      sourceUrl: unifiedSourceUrl,
      wikiToken: unifiedLink.wikiToken,
      tableId: unifiedLink.tableId,
      viewId: unifiedLink.viewId,
    };
  })();
  private readonly leaveSubstituteRepairChatId =
    readEnv('FEISHU_LEAVE_SUBSTITUTE_REPAIR_CHAT_ID', [
      'FEISHU_SUBSTITUTE_REPAIR_CHAT_ID',
    ]) || 'oc_9961bb057de8bd715447559c5e63c4f2';
  private readonly constructionCrewRosterNotificationChatId =
    readEnv('FEISHU_CONSTRUCTION_MANAGEMENT_LISTEN_CHAT_ID', [
      'FEISHU_CONSTRUCTION_LISTEN_CHAT_ID',
      'FEISHU_CONSTRUCTION_MANAGEMENT_CHAT_ID',
      'FEISHU_CONSTRUCTION_CREW_ROSTER_CHAT_ID',
      'FEISHU_CONSTRUCTION_NOTIFY_CHAT_ID',
      'FEISHU_CONSTRUCTION_CREW_ROSTER_NOTIFY_CHAT_ID',
    ]) || '';
  private readonly constructionCrewRosterOutlookConfig =
    this.readConstructionCrewRosterOutlookConfig();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
    @Optional()
    private readonly changeAttachmentStorage?: ChangeAttachmentStorageService,
    @Optional()
    private readonly changeAdjustmentService?: ChangeAdjustmentService,
    @Optional()
    private readonly changeDrillReportService?: ChangeDrillReportService,
    @Optional()
    private readonly changeSummaryReportService?: ChangeSummaryReportService,
  ) {
    if (process.env.NODE_ENV !== 'test') {
      this.scheduleExistingConstructionFollowupSubmitRetries();
    }
  }

  private readConstructionCrewRosterOutlookConfig(): ConstructionCrewRosterOutlookConfig {
    const graphBaseUrl =
      readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_GRAPH_BASE_URL', [
        'OUTLOOK_GRAPH_BASE_URL',
      ]) || 'https://graph.microsoft.com/v1.0';
    const graphOrigin = (() => {
      try {
        return new URL(graphBaseUrl).origin;
      } catch {
        return 'https://graph.microsoft.com';
      }
    })();

    return {
      tenantId:
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_TENANT_ID', [
          'OUTLOOK_TENANT_ID',
          'MICROSOFT_TENANT_ID',
        ]) || '',
      clientId:
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_CLIENT_ID', [
          'OUTLOOK_CLIENT_ID',
          'MICROSOFT_CLIENT_ID',
        ]) || '',
      clientSecret:
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_CLIENT_SECRET', [
          'OUTLOOK_CLIENT_SECRET',
          'MICROSOFT_CLIENT_SECRET',
        ]) || '',
      userId:
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_USER_ID', [
          'OUTLOOK_USER_ID',
          'OUTLOOK_MAILBOX',
          'MICROSOFT_USER_ID',
        ]) || '',
      folderId:
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_FOLDER_ID', [
          'OUTLOOK_FOLDER_ID',
        ]) || 'inbox',
      graphBaseUrl: graphBaseUrl.replace(/\/+$/, ''),
      loginBaseUrl: (
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_LOGIN_BASE_URL', [
          'OUTLOOK_LOGIN_BASE_URL',
        ]) || 'https://login.microsoftonline.com'
      ).replace(/\/+$/, ''),
      scope:
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_SCOPE', [
          'OUTLOOK_GRAPH_SCOPE',
        ]) || `${graphOrigin}/.default`,
      messageLimit: Math.max(
        1,
        Number(
          readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_MESSAGE_LIMIT') || 30,
        ) || 30,
      ),
      requireConstructionCodeMatch: !/^false$/i.test(
        readEnv('CONSTRUCTION_CREW_ROSTER_OUTLOOK_REQUIRE_CODE_MATCH') ||
          'true',
      ),
      subjectKeywords: this.readDelimitedEnvList(
        'CONSTRUCTION_CREW_ROSTER_OUTLOOK_SUBJECT_KEYWORDS',
        DEFAULT_CONSTRUCTION_CREW_ROSTER_OUTLOOK_KEYWORDS,
      ),
      attachmentKeywords: this.readDelimitedEnvList(
        'CONSTRUCTION_CREW_ROSTER_OUTLOOK_ATTACHMENT_KEYWORDS',
        DEFAULT_CONSTRUCTION_CREW_ROSTER_OUTLOOK_KEYWORDS,
      ),
    };
  }

  private readDelimitedEnvList(
    name: string,
    fallback: readonly string[],
  ): string[] {
    const raw = readEnv(name) || '';
    const values = raw
      .split(/[;,，、\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length > 0 ? values : [...fallback];
  }

  private async fetchFeishuScheduleRecords(
    forceRefresh = false,
    strict = false,
    verifiedApprovalSnapshot?: LeaveApprovalSnapshot,
    dateRange?: { startDate: string; endDate: string },
  ): Promise<BitableRecordItem[]> {
    const bounds = dateRange && {
      start: Date.parse(`${dateRange.startDate}T00:00:00+08:00`),
      end: Date.parse(`${dateRange.endDate}T00:00:00+08:00`),
    };
    if (bounds && (
      !/^\d{4}-\d{2}-\d{2}$/u.test(dateRange!.startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(dateRange!.endDate) ||
      !Number.isFinite(bounds.start) || !Number.isFinite(bounds.end) ||
      bounds.end < bounds.start ||
      new Date(bounds.start + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== dateRange!.startDate ||
      new Date(bounds.end + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== dateRange!.endDate
    )) throw new BadRequestException('排班查询日期范围无效');
    const [records, approvalSnapshot] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
        tableName: '值班排班',
        ...(bounds ? {
          filter: {
            conjunction: 'and' as const,
            conditions: [
              { field_name: '排班日期', operator: 'isGreater', value: ['ExactDate', String(bounds.start - 86_400_000)] },
              { field_name: '排班日期', operator: 'isLess', value: ['ExactDate', String(bounds.end + 86_400_000)] },
            ],
          },
        } : {}),
        forceRefresh,
        strict,
        ...(strict ? { allowStale: false } : {}),
      }),
      verifiedApprovalSnapshot ||
        fetchLeaveApprovalSnapshot(this.httpService, {
          forceRefresh,
          strict,
        }),
    ]);
    return enrichScheduleRecordsWithLeaveApproval(records, approvalSnapshot);
  }

  private async fetchLongWhiteDutyRecords(
    forceRefresh = false,
    useConfiguredView = true,
    verifiedApprovalSnapshot?: LeaveApprovalSnapshot,
  ): Promise<BitableRecordItem[]> {
    const appToken = await resolveBitableAppToken(
      this.httpService,
      this.longWhiteDutyConfig,
    );
    const [records, approvalSnapshot] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken,
        tableId: this.longWhiteDutyConfig.tableId,
        viewId: useConfiguredView
          ? this.longWhiteDutyConfig.viewId || undefined
          : undefined,
        tableName: this.longWhiteDutyConfig.tableName,
        forceRefresh,
        ...(verifiedApprovalSnapshot
          ? { strict: true, allowStale: false }
          : {}),
      }),
      verifiedApprovalSnapshot ||
        fetchLeaveApprovalSnapshot(this.httpService, { forceRefresh }),
    ]);
    return enrichScheduleRecordsWithLeaveApproval(records, approvalSnapshot);
  }

  private async fetchLeaveSubstituteRecords(
    forceRefresh = false,
  ): Promise<{ appToken: string; records: BitableRecordItem[] }> {
    if (!this.hasBitableSourceConfig(this.leaveSubstituteConfig)) {
      throw new Error('请休假替班修正多维表待配置');
    }

    const appToken = await resolveBitableAppToken(
      this.httpService,
      this.leaveSubstituteConfig,
    );
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: this.leaveSubstituteConfig.tableId,
      viewId: this.leaveSubstituteConfig.viewId || undefined,
      tableName: this.leaveSubstituteConfig.tableName,
      forceRefresh,
    });

    if (records.length === 0 && this.leaveSubstituteConfig.viewId) {
      return {
        appToken,
        records: await fetchBitableRecords(this.httpService, {
          appToken,
          tableId: this.leaveSubstituteConfig.tableId,
          tableName: this.leaveSubstituteConfig.tableName,
          forceRefresh,
        }),
      };
    }

    return { appToken, records };
  }

  private async fetchFeishuSealingRecords(
    forceRefresh = false,
  ): Promise<BitableRecordItem[]> {
    if (!this.sealingSourceSnapshot) {
      try {
        const persisted = await readLatestPersistedBitableRecordSnapshot({
          appToken: this.sealingConfig.appToken || undefined,
          tableId: this.sealingConfig.tableId,
          viewId: this.sealingConfig.viewId || undefined,
          tableName: this.sealingConfig.tableName,
        });
        if (persisted && !this.sealingSourceSnapshot) {
          const expiresAt = Math.min(
            persisted.expiresAt,
            persisted.fetchedAt + SEALING_SOURCE_SYNC_INTERVAL_MS,
          );
          this.sealingSourceSnapshot = {
            ...persisted,
            expiresAt,
            stale: expiresAt <= Date.now(),
          };
        }
      } catch {
        this.logger.warn('封网本地缓存读取失败，将尝试读取源表');
      }
    }
    const now = Date.now();
    if (
      !forceRefresh &&
      this.sealingSourceSnapshot &&
      this.sealingSourceSnapshot.expiresAt > now
    ) {
      return this.sealingSourceSnapshot.records;
    }
    if (this.sealingSourceRefreshRequest) {
      return this.waitForSealingSourceRefresh(this.sealingSourceRefreshRequest);
    }

    let request!: Promise<BitableRecordItem[]>;
    request = (async () => {
      try {
        const appToken = await resolveBitableAppToken(
          this.httpService,
          this.sealingConfig,
        );
        const records = await fetchBitableRecords(this.httpService, {
          appToken,
          tableId: this.sealingConfig.tableId,
          viewId: this.sealingConfig.viewId || undefined,
          tableName: this.sealingConfig.tableName,
          cacheTtlMs: SEALING_SOURCE_SYNC_INTERVAL_MS,
          forceRefresh: true,
          strict: true,
          allowStale: false,
        });
        this.sealingSourceSnapshot = {
          records,
          expiresAt: Date.now() + SEALING_SOURCE_SYNC_INTERVAL_MS,
          fetchedAt: Date.now(),
          stale: false,
        };
        return records;
      } catch (error) {
        if (this.sealingSourceSnapshot) {
          this.logger.warn('封网信息刷新失败，继续保留最近有效数据');
          this.sealingSourceSnapshot = {
            ...this.sealingSourceSnapshot,
            expiresAt: Date.now() + SEALING_SOURCE_RETRY_INTERVAL_MS,
            stale: true,
          };
          return this.sealingSourceSnapshot.records;
        }
        throw error;
      }
    })().finally(() => {
      if (this.sealingSourceRefreshRequest === request) {
        this.sealingSourceRefreshRequest = null;
      }
    });
    this.sealingSourceRefreshRequest = request;
    return this.waitForSealingSourceRefresh(request);
  }

  private async waitForSealingSourceRefresh(
    request: Promise<BitableRecordItem[]>,
  ): Promise<BitableRecordItem[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(
              new Error('封网数据读取超时，请稍后重试'),
              { code: 'SOURCE_TIMEOUT' },
            )),
            SEALING_SOURCE_READ_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      if (!this.sealingSourceSnapshot) throw error;
      this.sealingSourceSnapshot = {
        ...this.sealingSourceSnapshot,
        stale: true,
        expiresAt: Date.now() + SEALING_SOURCE_RETRY_INTERVAL_MS,
      };
      return this.sealingSourceSnapshot.records;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchFeishuCalendarChangeRecords(
    forceRefresh = false,
  ): Promise<BitableRecordItem[]> {
    const appToken = await resolveBitableAppToken(
      this.httpService,
      this.calendarChangeConfig,
    );
    return fetchBitableRecords(this.httpService, {
      appToken,
      tableId: this.calendarChangeConfig.tableId,
      viewId: this.calendarChangeConfig.viewId || undefined,
      tableName: this.calendarChangeConfig.tableName,
      automaticFields: true,
      forceRefresh,
    });
  }

  private async getFeishuTenantAccessToken(
    deadlineAt?: number,
  ): Promise<string> {
    const tokenResponse = await this.waitWithinChangeRequestDeadline(
      this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        {
          timeout: this.getChangeRequestBoundedAxiosTimeout(
            deadlineAt,
            '获取飞书访问令牌',
          ),
        },
      ),
      deadlineAt,
      '获取飞书访问令牌',
    );
    const token = tokenResponse.data?.tenant_access_token;
    if (!token) {
      throw new Error('获取飞书 tenant_access_token 失败');
    }
    return token;
  }

  verifyMonthlyScheduleScreenshotAccess(
    request: MonthlyScheduleScreenshotAccessRequest = {},
  ): MonthlyScheduleScreenshotAccessResponse {
    const authorized = verifyScreenshotAccessRequest(request);

    return {
      success: true,
      authorized,
      message: authorized ? '截图模式校验通过' : '截图模式校验失败',
    };
  }

  private async fetchScheduleFieldMetas(
    tenantAccessToken: string,
  ): Promise<BitableFieldMeta[]> {
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.scheduleAppToken}/tables/${this.scheduleTableId}/fields`;
    const response = await this.httpService.axiosRef.get(apiUrl, {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      timeout: 30000,
    });

    if (response.data.code !== 0) {
      throw new Error(
        `飞书字段列表 API 错误: ${response.data.msg || response.data.code}`,
      );
    }

    return (response.data.data?.items || []).map((field: BitableFieldMeta) => ({
      field_id: field.field_id,
      field_name: field.field_name,
      type: field.type,
    }));
  }

  private async fetchBitableFieldMetas(
    appToken: string,
    tableId: string,
    tableName: string,
    tenantAccessToken: string,
    deadlineAt?: number,
  ): Promise<BitableFieldMeta[]> {
    assertBitableTableConfig(tableName, appToken, tableId);

    const fields: BitableFieldMeta[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      this.assertChangeRequestDeadline(deadlineAt, `${tableName}字段分页`);
      const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
      const response = await this.waitWithinChangeRequestDeadline(
        this.httpService.axiosRef.get(apiUrl, {
          headers: { Authorization: `Bearer ${tenantAccessToken}` },
          params: {
            page_size: 200,
            page_token: pageToken,
          },
          timeout: this.getChangeRequestBoundedAxiosTimeout(
            deadlineAt,
            `${tableName}字段分页`,
          ),
        }),
        deadlineAt,
        `${tableName}字段分页`,
      );
      this.assertChangeRequestDeadline(deadlineAt, `${tableName}字段分页`);

      if (response.data.code !== 0) {
        throw new Error(
          `${tableName}字段列表读取失败: ${response.data.msg || response.data.code}`,
        );
      }

      fields.push(
        ...(response.data.data?.items || []).map((field: BitableFieldMeta) => ({
          field_id: field.field_id,
          field_name: field.field_name,
          type: field.type,
        })),
      );

      hasMore = Boolean(response.data.data?.has_more);
      pageToken = response.data.data?.page_token;
    }

    return fields;
  }

  private resolveDutyStaffActualRepairFieldConfig(
    fields: BitableFieldMeta[],
  ): DutyStaffActualRepairFieldConfig {
    const source = this.findBitableField(
      fields,
      ['人员（文本）'],
      ['fldJi5bxBG'],
    );
    const target = findWritableDutyProgramModifiedBitableField(fields);

    if (!source) {
      throw new Error('未找到「人员（文本）」字段，无法确定修正来源');
    }
    if (!target) {
      throw new Error('未找到「值班人员（实际）程序修改」字段，无法执行修正');
    }

    return { source, target };
  }

  private resolveVacancySubstituteFieldConfig(
    fields: BitableFieldMeta[],
  ): VacancySubstituteFieldConfig {
    const dutyStaffActual = this.resolveDutyStaffActualField(fields);
    const vacancySubstitute = this.findBitableField(fields, [
      '缺岗替班',
      '缺岗替班人员',
      '缺岗替代',
      '缺岗人员替班',
    ]);

    if (!vacancySubstitute) {
      throw new Error('未找到“缺岗替班”字段，请先确认排班多维表字段配置');
    }

    return { dutyStaffActual, vacancySubstitute };
  }

  private resolveTravelStaffFieldConfig(
    fields: BitableFieldMeta[],
  ): TravelStaffFieldConfig {
    const dutyStaffActual = this.resolveDutyStaffActualField(fields);
    const travelStaff = this.findBitableField(fields, [
      '差旅人员',
      '出差人员',
      '差旅',
      '差旅人员信息',
    ]);

    if (!travelStaff) {
      throw new Error('未找到“差旅人员”字段，请先确认排班多维表字段配置');
    }

    return { dutyStaffActual, travelStaff };
  }

  private resolvePersonnelMovementFieldConfig(
    fields: BitableFieldMeta[],
  ): PersonnelMovementFieldConfig {
    const programModified = this.resolveDutyStaffActualField(fields);

    return { dutyStaffActual: programModified, programModified };
  }

  private resolveDutyStaffActualField(
    fields: BitableFieldMeta[],
  ): BitableFieldMeta {
    const dutyStaffActual = findWritableDutyProgramModifiedBitableField(fields);

    if (!dutyStaffActual) {
      throw new Error(
        '未找到“值班人员（实际）程序修改”字段，无法写入值班人员调整',
      );
    }

    return dutyStaffActual;
  }

  private findBitableField(
    fields: BitableFieldMeta[],
    names: string[],
    ids: string[] = [],
  ): BitableFieldMeta | undefined {
    return fields.find(
      (field) =>
        names.includes(field.field_name) || ids.includes(field.field_id),
    );
  }

  private resolveLeaveRequestFieldConfig(
    fields: BitableFieldMeta[],
  ): LeaveRequestFieldConfig {
    const findRequired = (
      label: string,
      names: string[],
      ids: string[],
    ): BitableFieldMeta => {
      const field = this.findBitableField(fields, names, ids);
      if (!field) {
        throw new BadRequestException(`请休假多维表未找到“${label}”字段`);
      }
      return field;
    };
    const findRequiredText = (
      label: string,
      names: string[],
      ids: string[] = [],
    ): BitableFieldMeta => {
      const field = findRequired(label, names, ids);
      if (field.type !== 1) {
        throw new BadRequestException(
          `请休假多维表“${label}”字段必须是文本类型`,
        );
      }
      return field;
    };
    const findRequiredAttachment = (
      label: string,
      names: string[],
      ids: string[] = [],
    ): BitableFieldMeta => {
      const field = findRequired(label, names, ids);
      if (field.type !== 17) {
        throw new BadRequestException(
          `请休假多维表“${label}”字段必须是附件类型`,
        );
      }
      return field;
    };
    const findRequiredUser = (
      label: string,
      names: string[],
      ids: string[] = [],
    ): BitableFieldMeta => {
      const field = findRequired(label, names, ids);
      if (field.type !== 11) {
        throw new BadRequestException(
          `请休假多维表“${label}”字段必须是人员类型`,
        );
      }
      return field;
    };
    const findOptionalUser = (
      label: string,
      names: string[],
      ids: string[] = [],
    ): BitableFieldMeta | undefined => {
      const field = this.findBitableField(fields, names, ids);
      if (field && field.type !== 11) {
        throw new BadRequestException(
          `请休假多维表“${label}”字段必须是人员类型`,
        );
      }
      return field;
    };

    return {
      startDate: findRequired('休假开始时间', ['休假开始时间'], ['fldjXCAzJk']),
      endDate: findRequired('休假结束时间', ['休假结束时间'], ['fld9LND1ZA']),
      leaveType: findRequired('休假类型', ['休假类型'], ['fldRJkgamA']),
      leaveReason: findRequired('请假原因', ['请假原因'], ['fldAtshsb9']),
      leaveStaffUser: findRequiredUser(
        '休假人员',
        ['休假人员'],
        ['fldxEKxxQR'],
      ),
      leaveStaffProgramName: findRequiredText('休假人员姓名（程序）', [
        '休假人员姓名（程序）',
      ]),
      legacyLeaveStaffUser: findOptionalUser(
        '需替班人员',
        ['需替班人员'],
        ['fldlUOzqnH'],
      ),
      needSubstitute: findRequired(
        '是否需要替班（替班打√）',
        ['是否需要替班（替班打√）'],
        ['fld7noByKE'],
      ),
      substituteStaff: findRequired(
        '替班人员（填姓名）',
        ['替班人员（填姓名）'],
        ['fldpUkeEzS'],
      ),
      workHours: findRequired('休假工时数', ['休假工时数'], ['fldHWdPR5B']),
      minimumHours: findRequired(
        '休假工时数（最低4h）',
        ['休假工时数（最低4h）'],
        ['fldNDGYPnW'],
      ),
      requestUniqueId: findRequiredText('请求唯一ID', ['请求唯一ID']),
      requestFingerprint: findRequiredText('请求指纹', ['请求指纹']),
      impactScheduleRecordIds: findRequiredText('系统影响排班记录ID', [
        '系统影响排班记录ID',
      ]),
      screenshot: findRequiredAttachment(
        '流程截图',
        ['流程截图'],
        ['fldCP3Q5uM'],
      ),
    };
  }

  private resolveLeaveProgramWorkflowInitialFieldConfig(
    fields: BitableFieldMeta[],
  ): LeaveProgramWorkflowInitialFieldConfig {
    const findRequiredSelect = (
      label: string,
      names: string[],
    ): BitableFieldMeta => {
      const field = this.findBitableField(fields, names);
      if (!field || field.type !== 3) {
        throw new BadRequestException(
          `请休假程序审批字段“${label}”缺失或类型不正确，请先完成字段迁移`,
        );
      }
      return field;
    };
    return {
      approvalSource: findRequiredSelect('审批来源', ['审批来源']),
      workflowStatus: findRequiredSelect('请假工作流状态', ['请假工作流状态']),
    };
  }

  private resolveOvertimeRequestFieldConfig(
    fields: BitableFieldMeta[],
  ): OvertimeRequestFieldConfig {
    const findFixed = (
      label: string,
      fieldId: string,
      expectedType: number,
      expectedTypeLabel: string,
    ): BitableFieldMeta => {
      const field = fields.find(
        (candidate) =>
          candidate.field_id === fieldId && candidate.field_name === label,
      );
      if (!field) {
        throw new BadRequestException(
          `加班多维表未找到固定字段“${label}”（${fieldId}）`,
        );
      }
      if (field.type !== expectedType) {
        throw new BadRequestException(
          `加班多维表“${label}”字段必须是${expectedTypeLabel}类型`,
        );
      }
      return field;
    };

    return {
      staffUser: findFixed('加班人员', 'fldAkMDN4j', 11, '人员'),
      staffName: findFixed('加班人员姓名', 'fld6i1nnqj', 1, '文本'),
      startAt: findFixed('加班开始时间', 'fldLDUzzkk', 5, '日期时间'),
      endAt: findFixed('加班结束时间', 'fld1WAlola', 5, '日期时间'),
      hours: findFixed('加班时长', 'fldiT8jZJM', 2, '数字'),
      screenshot: findFixed('加班举证', 'fldNBsiD6p', 17, '附件'),
      reason: findFixed('加班原因', 'fldryGT7Gy', 1, '文本'),
      requestUniqueId: findFixed('请求唯一ID', 'flddA6fBNh', 1, '文本'),
      requestFingerprint: findFixed('请求指纹', 'fldsR7gdBZ', 1, '文本'),
    };
  }

  private resolveChangeRequestFieldConfig(
    fields: BitableFieldMeta[],
  ): ChangeRequestFieldConfig {
    const findRequired = (
      label: string,
      names: string[],
      ids: string[],
      expectedType: number,
      expectedTypeLabel: string,
    ): BitableFieldMeta => {
      const field = this.findBitableField(fields, names, ids);
      if (!field) {
        throw new BadRequestException(`计划变更日历未找到“${label}”字段`);
      }
      if (field.type !== expectedType) {
        throw new BadRequestException(
          `计划变更日历“${label}”字段必须是${expectedTypeLabel}类型`,
        );
      }
      return field;
    };

    const writablePersonFields = fields.filter((field) => field.type === 11);
    const submitter =
      this.findBitableField(writablePersonFields, ['变更提交人'], []) ||
      this.findBitableField(writablePersonFields, ['申请提交人'], []);
    if (!submitter) {
      throw new BadRequestException(
        '计划变更日历未找到可写的人员字段“变更提交人”',
      );
    }

    return {
      submitter,
      nature: findRequired(
        '变更性质判断',
        ['变更性质判断'],
        ['fldX1uU37v'],
        3,
        '单选',
      ),
      meetingStartAt: findRequired(
        '会议开始时间',
        ['会议开始时间'],
        ['fldhApsYlj'],
        5,
        '日期时间',
      ),
      meetingEndAt: findRequired(
        '会议结束时间',
        ['会议结束时间'],
        ['fldSecHYBr'],
        5,
        '日期时间',
      ),
      summary: findRequired(
        '变更简述',
        ['变更简述'],
        ['fld4Mb34MM'],
        1,
        '文本',
      ),
      changeType: findRequired(
        '变更类型',
        ['变更类型'],
        ['fldMCGLrqs'],
        3,
        '单选',
      ),
      workType: findRequired(
        '作业类型',
        ['作业类型'],
        ['fld5C1kiE6'],
        3,
        '单选',
      ),
      buildings: findRequired(
        '变更楼栋',
        ['变更楼栋'],
        ['fldpvaNYeb'],
        4,
        '多选',
      ),
      plannedStartAt: findRequired(
        '计划开始日期（阿里）',
        ['计划开始日期（阿里）'],
        ['fldVD5BNEQ'],
        5,
        '日期时间',
      ),
      plannedEndAt: findRequired(
        '计划结束日期（阿里）',
        ['计划结束日期（阿里）'],
        ['fldrl38KPS'],
        5,
        '日期时间',
      ),
      discipline: findRequired('专业', ['专业'], ['fldQNjGs78'], 3, '单选'),
      level: findRequired(
        '变更等级（阿里）',
        ['变更等级（阿里）'],
        ['fldyx0s7Ra'],
        3,
        '单选',
      ),
      riskSummary: findRequired(
        '变更重要风险点（简述）',
        ['变更重要风险点（简述）'],
        ['fldx4xtjHB'],
        1,
        '文本',
      ),
      documents: findRequired(
        '变更文档',
        ['变更文档'],
        ['fld0qzcXDh'],
        17,
        '附件',
      ),
    };
  }

  private resolveSealingRegistrationFieldConfig(
    fields: BitableFieldMeta[],
  ): SealingRegistrationFieldConfig {
    const sealingInfo = this.findBitableField(
      fields,
      ['封网信息', '名称', '封网名称'],
      ['fldyloi3Wd'],
    );
    const startTime = this.findBitableField(
      fields,
      ['封网开始时间', '开始日期', '开始时间', '开始'],
      ['fldY3ITpTr'],
    );
    const endTime = this.findBitableField(
      fields,
      ['封网结束时间', '结束日期', '结束时间', '结束'],
      ['fldHGRu3v7'],
    );

    if (!sealingInfo) {
      throw new Error('封网信息多维表未找到“封网信息”字段');
    }
    if (!startTime) {
      throw new Error('封网信息多维表未找到“封网开始时间”字段');
    }
    if (!endTime) {
      throw new Error('封网信息多维表未找到“封网结束时间”字段');
    }

    return {
      sealingInfo,
      startTime,
      endTime,
    };
  }

  private setBitableFieldValue(
    fields: Record<string, unknown>,
    field: BitableFieldMeta | undefined,
    value: unknown,
  ): void {
    if (!field) {
      return;
    }
    if (typeof value === 'string' && !value.trim()) {
      return;
    }
    if (value === undefined || value === null) {
      return;
    }
    fields[field.field_name] = value;
  }

  private buildDateKeysInRange(startDate: string, endDate: string): string[] {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      endDate < startDate
    ) {
      return [];
    }

    const dates: string[] = [];
    let cursor = startDate;
    while (cursor <= endDate) {
      dates.push(cursor);
      const [year, month, day] = cursor.split('-').map(Number);
      cursor = this.formatDateKey(new Date(year, month - 1, day + 1));
    }
    return dates;
  }

  private async fetchBitableViews(
    appToken: string,
    tableId: string,
    tableName: string,
    tenantAccessToken: string,
  ): Promise<BitableViewMeta[]> {
    assertBitableTableConfig(tableName, appToken, tableId);

    const views: BitableViewMeta[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/views`;
      const response = await this.httpService.axiosRef.get(apiUrl, {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        params: {
          page_size: 200,
          page_token: pageToken,
        },
        timeout: 30000,
      });

      if (response.data.code !== 0) {
        throw new Error(
          `${tableName}视图列表读取失败: ${getBitableApiErrorMessage(response.data)}`,
        );
      }

      const rawItems =
        response.data.data?.items || response.data.data?.views || [];
      rawItems.forEach((item: Record<string, unknown>) => {
        const viewId = String(item.view_id || item.id || '').trim();
        const viewName = String(item.view_name || item.name || '').trim();
        if (viewId && viewName) {
          views.push({ view_id: viewId, view_name: viewName });
        }
      });

      hasMore = Boolean(response.data.data?.has_more);
      pageToken =
        response.data.data?.page_token || response.data.data?.next_page_token;
    }

    return views;
  }

  private async createBitableGridView(
    appToken: string,
    tableId: string,
    tableName: string,
    viewName: string,
    tenantAccessToken: string,
  ): Promise<string> {
    assertBitableTableConfig(tableName, appToken, tableId);

    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/views`;
    const response = await this.httpService.axiosRef.post(
      apiUrl,
      { view_name: viewName, view_type: 'grid' },
      {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        timeout: 30000,
      },
    );

    if (response.data.code !== 0) {
      throw new Error(
        `${tableName}视图创建失败: ${getBitableApiErrorMessage(response.data)}`,
      );
    }

    const view = response.data.data?.view || response.data.data || {};
    const viewId = String(view.view_id || view.id || '').trim();
    if (!viewId) {
      throw new Error(`${tableName}视图创建成功但未返回视图 ID`);
    }
    return viewId;
  }

  private async updateBitableViewFilter(
    appToken: string,
    tableId: string,
    tableName: string,
    viewId: string,
    payload: Record<string, unknown>,
    tenantAccessToken: string,
  ): Promise<void> {
    assertBitableTableConfig(tableName, appToken, tableId);

    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/views/${viewId}`;
    const response = await this.httpService.axiosRef.patch(apiUrl, payload, {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      timeout: 30000,
    });

    if (response.data.code !== 0) {
      throw new Error(
        `${tableName}视图筛选更新失败: ${getBitableApiErrorMessage(response.data)}`,
      );
    }
  }

  private async deleteBitableView(
    appToken: string,
    tableId: string,
    tableName: string,
    viewId: string,
    tenantAccessToken: string,
  ): Promise<void> {
    assertBitableTableConfig(tableName, appToken, tableId);
    const normalizedViewId = String(viewId || '').trim();
    if (!normalizedViewId) {
      throw new Error(`${tableName}待删除视图缺少 viewId`);
    }

    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/views/${normalizedViewId}`;
    const response = await this.httpService.axiosRef
      .delete(apiUrl, {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        timeout: 30000,
      })
      .catch((error: unknown) => {
        throw new Error(
          `${tableName}视图删除失败: ${getBitableAxiosErrorMessage(error)}`,
        );
      });

    if (response.data.code !== 0) {
      throw new Error(
        `${tableName}视图删除失败: ${getBitableApiErrorMessage(response.data)}`,
      );
    }
  }

  private async deleteConstructionCrewLedgerProjectViews(
    appToken: string,
    config: FocusBitableConfig,
    constructionCode: string,
    tenantAccessToken: string,
  ): Promise<number> {
    const viewName = buildConstructionCrewLedgerViewName(constructionCode);
    if (!viewName) {
      return 0;
    }

    const views = await this.fetchBitableViews(
      appToken,
      config.tableId,
      config.tableName,
      tenantAccessToken,
    );
    const targetViews = views.filter((view) => view.view_name === viewName);
    for (const view of targetViews) {
      await this.deleteBitableView(
        appToken,
        config.tableId,
        config.tableName,
        view.view_id,
        tenantAccessToken,
      );
    }
    return targetViews.length;
  }

  private async ensureConstructionCrewLedgerProjectView(
    constructionCode: string | null | undefined,
    tenantAccessToken: string,
  ): Promise<void> {
    const viewName = buildConstructionCrewLedgerViewName(constructionCode);
    if (!viewName) {
      return;
    }

    const config = this.getConstructionCrewLedgerConfig();
    if (!this.hasBitableSourceConfig(config)) {
      return;
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      config.tableId,
      config.tableName,
      tenantAccessToken,
    );
    const constructionCodeField = this.findBitableField(fieldMetas, [
      ...CONSTRUCTION_CREW_LEDGER_CONSTRUCTION_CODE_FIELD_NAMES,
    ]);
    if (!constructionCodeField?.field_id) {
      throw new Error(
        `${config.tableName}未找到“施工编码/施工编号”字段，无法创建项目视图`,
      );
    }

    const views = await this.fetchBitableViews(
      appToken,
      config.tableId,
      config.tableName,
      tenantAccessToken,
    );
    const existingView = views.find((view) => view.view_name === viewName);
    const viewId =
      existingView?.view_id ||
      (await this.createBitableGridView(
        appToken,
        config.tableId,
        config.tableName,
        viewName,
        tenantAccessToken,
      ));

    await this.updateBitableViewFilter(
      appToken,
      config.tableId,
      config.tableName,
      viewId,
      buildConstructionCrewLedgerViewFilterPayload(
        constructionCodeField.field_id,
        viewName,
      ),
      tenantAccessToken,
    );
  }

  private async ensureConstructionCrewLedgerProjectViewFromOverviewRecord(
    overviewAppToken: string,
    overviewRecordId: string,
    overviewFields: Record<string, unknown>,
    tenantAccessToken: string,
  ): Promise<string | null> {
    const config = this.getConstructionCrewLedgerConfig();
    if (!this.hasBitableSourceConfig(config)) {
      return null;
    }

    let constructionCode = this.extractConstructionCodeValue(overviewFields);
    if (!constructionCode) {
      const overviewRecord = await this.fetchBitableRecordById(
        overviewAppToken,
        this.constructionOverviewConfig.tableId,
        this.constructionOverviewConfig.tableName,
        overviewRecordId,
        tenantAccessToken,
      );
      constructionCode = this.extractConstructionCodeValue(
        overviewRecord?.fields || {},
      );
    }

    if (!constructionCode) {
      throw new Error('未读取到施工编码，无法创建施工人员台账项目视图');
    }

    try {
      await this.ensureConstructionCrewLedgerProjectView(
        constructionCode,
        tenantAccessToken,
      );
    } catch (error) {
      this.logger.warn(
        `施工人员台账项目视图同步失败，已继续处理人员名单: ${getBitableAxiosErrorMessage(error)}`,
      );
    }
    return constructionCode;
  }

  private async syncConstructionCrewRosterFilesToLedger(input: {
    files: ConstructionUploadFile[];
    overviewRecordId: string;
    constructionCode?: string | null;
    overviewAppToken?: string | null;
    tenantAccessToken: string;
    referenceDate?: Date;
    authorizationStartDate?: string | null;
    authorizationEndDate?: string | null;
  }): Promise<ConstructionCrewRosterSyncResult> {
    const referenceDate = input.referenceDate || new Date();
    const authorizationOverride =
      this.normalizeConstructionCrewRosterAuthorizationOverride({
        startDate: input.authorizationStartDate,
        endDate: input.authorizationEndDate,
      });
    const rosterEntries = parseConstructionCrewRosterFiles(
      input.files,
      referenceDate,
    ).map((entry) =>
      this.applyConstructionCrewRosterAuthorizationOverride(
        entry,
        authorizationOverride,
        referenceDate,
      ),
    );
    const rosterMembers = rosterEntries.map((entry) => ({
      name: entry.name,
      certificateNo: entry.certificateNo || null,
    }));
    if (rosterEntries.length === 0) {
      return { parsed: 0, created: 0, updated: 0, members: [], records: [] };
    }

    const config = this.getConstructionCrewLedgerConfig();
    if (!this.hasBitableSourceConfig(config)) {
      return {
        parsed: rosterEntries.length,
        created: 0,
        updated: 0,
        members: rosterMembers,
        records: [],
      };
    }

    const constructionCode =
      buildConstructionCrewLedgerViewName(input.constructionCode) ||
      (await this.resolveConstructionCodeForCrewRosterSync(
        input.overviewRecordId,
        input.tenantAccessToken,
        input.overviewAppToken,
      ));
    if (!constructionCode) {
      throw new Error('未读取到施工编码，无法写入施工人员台账');
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      config.tableId,
      config.tableName,
      input.tenantAccessToken,
    );
    const fieldNames =
      this.resolveConstructionCrewLedgerRosterFieldNames(fieldMetas);
    const existingRecords = await this.fetchAllBitableRecordsForMutation(
      appToken,
      config,
    );
    const projectRecords = existingRecords.filter((record) =>
      this.isConstructionCrewLedgerRecordForProject(
        record,
        input.overviewRecordId,
        constructionCode,
      ),
    );
    const recordsByKey =
      this.indexConstructionCrewLedgerRecordsByRosterKey(projectRecords);

    let created = 0;
    let updated = 0;
    const syncedRecords: ConstructionCrewRosterSyncedRecord[] = [];
    for (const entry of rosterEntries) {
      const fields = this.buildConstructionCrewLedgerRosterFields({
        entry,
        fieldNames,
        overviewRecordId: input.overviewRecordId,
        constructionCode,
      });
      const matchKeys = this.buildConstructionCrewRosterMatchKeys(
        entry.name,
        entry.phone,
        entry.certificateNo,
      );
      const existingRecord = matchKeys
        .map((key) => recordsByKey.get(key))
        .find((record): record is BitableRecordItem => Boolean(record));

      if (existingRecord) {
        const recordId = getRecordId(existingRecord);
        if (!recordId) {
          continue;
        }
        await this.updateBitableRecordFields(
          appToken,
          config.tableId,
          config.tableName,
          recordId,
          fields,
          input.tenantAccessToken,
          {
            optionalMissingFieldNames:
              CONSTRUCTION_CREW_LEDGER_OPTIONAL_MISSING_FIELD_NAMES,
          },
        );
        updated += 1;
        syncedRecords.push({
          recordId,
          name: entry.name,
          certificateNo: entry.certificateNo || null,
        });
        existingRecord.fields = {
          ...((existingRecord.fields || {}) as Record<string, unknown>),
          ...fields,
        };
        matchKeys.forEach((key) => recordsByKey.set(key, existingRecord));
      } else {
        const recordId = await this.createBitableRecord(
          appToken,
          config.tableId,
          config.tableName,
          fields,
          input.tenantAccessToken,
          {
            optionalMissingFieldNames:
              CONSTRUCTION_CREW_LEDGER_OPTIONAL_MISSING_FIELD_NAMES,
          },
        );
        created += 1;
        const createdRecord = {
          record_id: recordId,
          fields,
        };
        syncedRecords.push({
          recordId,
          name: entry.name,
          certificateNo: entry.certificateNo || null,
        });
        matchKeys.forEach((key) => recordsByKey.set(key, createdRecord));
      }
    }

    if (created > 0 || updated > 0) {
      invalidateBitableRecordCache({
        appToken,
        tableId: config.tableId,
        deletePersisted: true,
      });
      try {
        await this.ensureConstructionCrewLedgerProjectView(
          constructionCode,
          input.tenantAccessToken,
        );
      } catch (error) {
        this.logger.warn(
          `施工人员台账项目视图同步失败，已完成名单写入: ${getBitableAxiosErrorMessage(error)}`,
        );
      }
      this.logger.log(
        `施工人员名单已同步至台账：${constructionCode}，解析 ${rosterEntries.length} 人，新增 ${created} 人，更新 ${updated} 人`,
      );
    }

    return {
      parsed: rosterEntries.length,
      created,
      updated,
      members: rosterMembers,
      records: syncedRecords,
    };
  }

  private normalizeConstructionCrewRosterAuthorizationOverride(input: {
    startDate?: string | null;
    endDate?: string | null;
  }): {
    startDate: string | null;
    endDate: string | null;
  } | null {
    if (!input.startDate && !input.endDate) {
      return null;
    }
    return {
      startDate: input.startDate || null,
      endDate: input.endDate || null,
    };
  }

  private applyConstructionCrewRosterAuthorizationOverride(
    entry: ConstructionCrewRosterEntry,
    override: { startDate: string | null; endDate: string | null } | null,
    referenceDate: Date,
  ): ConstructionCrewRosterEntry {
    if (!override) {
      return entry;
    }
    const authorizationStartDate =
      override.startDate || entry.authorizationStartDate;
    const authorizationEndDate = override.endDate || entry.authorizationEndDate;
    return {
      ...entry,
      authorizationStartDate,
      authorizationEndDate,
      authorizationStatus: getConstructionCrewAuthorizationStatus(
        authorizationStartDate,
        authorizationEndDate,
        referenceDate,
      ),
    };
  }

  private normalizeConstructionCrewRosterAuthorizationDate(
    value: unknown,
    label: string,
  ): string {
    const text = String(value || '')
      .trim()
      .replace(/[/.]/g, '-');
    if (!text) {
      throw new Error(`请选择${label}`);
    }
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (!match) {
      throw new Error(`${label}格式不正确`);
    }
    const dateKey = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    const parsed = new Date(`${dateKey}T00:00:00+08:00`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      this.formatShanghaiDateKey(parsed) !== dateKey
    ) {
      throw new Error(`${label}不是有效日期`);
    }
    return dateKey;
  }

  async syncConstructionCrewRosterFromUpload(
    request: ConstructionCrewRosterUploadSyncRequest,
    files: ConstructionUploadFile[] = [],
  ): Promise<ConstructionCrewRosterUploadSyncResponse> {
    const recordId = String(request?.recordId || '').trim();
    if (!recordId) {
      throw new Error('缺少施工总览记录 ID，无法更新施工人员名单');
    }
    if (!this.hasBitableSourceConfig(this.constructionOverviewConfig)) {
      throw new Error(
        `${this.constructionOverviewConfig.tableName}多维表待配置`,
      );
    }

    const authorizationStartDate =
      this.normalizeConstructionCrewRosterAuthorizationDate(
        request?.authorizationStartDate,
        '授权开始日期',
      );
    const authorizationEndDate =
      this.normalizeConstructionCrewRosterAuthorizationDate(
        request?.authorizationEndDate,
        '授权结束日期',
      );
    if (authorizationStartDate > authorizationEndDate) {
      throw new Error('授权开始日期不能晚于授权结束日期');
    }

    const rosterFiles = files
      .filter((file) => file?.buffer?.length)
      .map((file) => ({
        ...file,
        fieldname: 'crewRosterFiles',
      }));
    if (rosterFiles.length === 0) {
      throw new Error('请上传施工人员名单文件');
    }

    const task = this.createSyncTask('construction');
    task.message = `施工人员名单后台更新已受理，授权有效期${authorizationStartDate}至${authorizationEndDate}`;
    const constructionCode = buildConstructionCrewLedgerViewName(
      request?.constructionCode,
    );
    this.syncConstructionCrewRosterFromUploadAsync(task.id, {
      request: {
        recordId,
        constructionCode,
        authorizationStartDate,
        authorizationEndDate,
      },
      files: rosterFiles,
    }).catch((error) => {
      this.logger.error(
        `施工人员名单后台更新任务启动失败: task=${task.id}`,
        error,
      );
    });

    return {
      success: true,
      pending: true,
      taskId: task.id,
      recordId,
      constructionCode: constructionCode || '',
      authorizationStartDate,
      authorizationEndDate,
      message: `施工人员名单已提交后台更新，授权有效期${authorizationStartDate}至${authorizationEndDate}`,
    };
  }

  private async syncConstructionCrewRosterFromUploadAsync(
    taskId: string,
    input: {
      request: ConstructionCrewRosterUploadSyncRequest;
      files: ConstructionUploadFile[];
    },
  ): Promise<void> {
    const task = this.syncTasks.get(taskId);
    if (!task) {
      return;
    }
    task.status = 'running';
    try {
      const result = await this.syncConstructionCrewRosterFromUploadNow(
        input.request,
        input.files,
      );
      task.status = 'completed';
      task.endTime = new Date();
      task.total = result.synced.parsed;
      task.inserted = result.synced.created;
      task.failed = 0;
      task.result = result;
      task.message = result.message;
      await this.notifyConstructionCrewRosterUploadSuccess(result.message);
    } catch (error) {
      task.status = 'failed';
      task.endTime = new Date();
      task.message =
        error instanceof Error ? error.message : '施工人员名单后台更新失败';
      this.logger.error(`施工人员名单后台更新失败: task=${taskId}`, error);
    }
  }

  private async syncConstructionCrewRosterFromUploadNow(
    request: ConstructionCrewRosterUploadSyncRequest,
    rosterFiles: ConstructionUploadFile[],
  ): Promise<ConstructionCrewRosterUploadSyncResponse> {
    const recordId = String(request?.recordId || '').trim();
    const authorizationStartDate =
      this.normalizeConstructionCrewRosterAuthorizationDate(
        request?.authorizationStartDate,
        '授权开始日期',
      );
    const authorizationEndDate =
      this.normalizeConstructionCrewRosterAuthorizationDate(
        request?.authorizationEndDate,
        '授权结束日期',
      );
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const overviewAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionOverviewConfig,
    );
    const overviewRecord = await this.fetchBitableRecordById(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      recordId,
      tenantAccessToken,
    );
    if (!overviewRecord) {
      throw new Error('未找到施工总览记录，无法更新施工人员名单');
    }

    const constructionCode = this.extractConstructionCodeValue(
      overviewRecord.fields || {},
    );
    const inputConstructionCode = buildConstructionCrewLedgerViewName(
      request?.constructionCode,
    );
    if (!constructionCode) {
      throw new Error('施工总览记录缺少施工编码，无法更新施工人员名单');
    }
    if (inputConstructionCode && inputConstructionCode !== constructionCode) {
      throw new Error(
        `施工编码不匹配，禁止更新人员名单：页面为 ${inputConstructionCode}，多维表为 ${constructionCode}`,
      );
    }

    const referenceDate = new Date();
    const synced = await this.syncConstructionCrewRosterFilesToLedger({
      files: rosterFiles,
      overviewRecordId: recordId,
      constructionCode,
      overviewAppToken,
      tenantAccessToken,
      referenceDate,
      authorizationStartDate,
      authorizationEndDate,
    });
    const certificateCheck =
      await this.runConstructionCrewRosterCertificateBatchCheck({
        records: synced.records,
        overviewRecordId: recordId,
        constructionCode,
        tenantAccessToken,
        members: synced.members,
      });
    const message = [
      `更新${synced.updated}人、新增${synced.created}人，授权有效期${authorizationStartDate}至${authorizationEndDate}`,
      certificateCheck.summary,
    ]
      .filter(Boolean)
      .join('；');

    return {
      success: true,
      recordId,
      constructionCode,
      authorizationStartDate,
      authorizationEndDate,
      synced,
      certificateCheck,
      message,
    };
  }

  async syncConstructionCrewRosterFromOutlook(
    request: ConstructionCrewRosterOutlookSyncRequest,
  ): Promise<ConstructionCrewRosterOutlookSyncResponse> {
    const recordId = String(request?.recordId || '').trim();
    if (!recordId) {
      throw new Error('缺少施工总览记录 ID，无法更新施工人员名单');
    }
    if (!this.hasBitableSourceConfig(this.constructionOverviewConfig)) {
      throw new Error(
        `${this.constructionOverviewConfig.tableName}多维表待配置`,
      );
    }

    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const overviewAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionOverviewConfig,
    );
    const overviewRecord = await this.fetchBitableRecordById(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      recordId,
      tenantAccessToken,
    );
    if (!overviewRecord) {
      throw new Error('未找到施工总览记录，无法更新施工人员名单');
    }

    const constructionCode = this.extractConstructionCodeValue(
      overviewRecord.fields || {},
    );
    const inputConstructionCode = buildConstructionCrewLedgerViewName(
      request?.constructionCode,
    );
    if (!constructionCode) {
      throw new Error('施工总览记录缺少施工编码，无法匹配 Outlook 人员名单');
    }
    if (inputConstructionCode && inputConstructionCode !== constructionCode) {
      throw new Error(
        `施工编码不匹配，禁止更新人员名单：页面为 ${inputConstructionCode}，多维表为 ${constructionCode}`,
      );
    }

    const source =
      await this.fetchLatestConstructionCrewRosterFromOutlook(constructionCode);
    const synced = await this.syncConstructionCrewRosterFilesToLedger({
      files: [source.file],
      overviewRecordId: recordId,
      constructionCode,
      overviewAppToken,
      tenantAccessToken,
      referenceDate: source.receivedDateTime
        ? new Date(source.receivedDateTime)
        : new Date(),
    });
    const certificateCheck =
      await this.runConstructionCrewRosterCertificateBatchCheck({
        records: synced.records,
        overviewRecordId: recordId,
        constructionCode,
        tenantAccessToken,
        members: synced.members,
      });

    return {
      success: true,
      recordId,
      constructionCode,
      source: {
        messageSubject: source.messageSubject,
        receivedDateTime: source.receivedDateTime,
        attachmentName: source.attachmentName,
      },
      synced,
      message: `施工人员名单已更新：解析 ${synced.parsed} 人，新增 ${synced.created} 人，更新 ${synced.updated} 人；${certificateCheck.summary}`,
    };
  }

  private async fetchLatestConstructionCrewRosterFromOutlook(
    constructionCode: string,
  ): Promise<ConstructionCrewRosterOutlookAttachment> {
    const config = this.constructionCrewRosterOutlookConfig;
    this.assertConstructionCrewRosterOutlookConfigured(config);
    const accessToken =
      await this.getConstructionCrewRosterOutlookAccessToken(config);
    const messages = await this.fetchConstructionCrewRosterOutlookMessages(
      config,
      accessToken,
    );

    for (const message of messages) {
      if (!message.id || !message.hasAttachments) {
        continue;
      }
      const attachments = await this.fetchOutlookMessageAttachments(
        config,
        accessToken,
        message.id,
      );
      for (const attachment of attachments) {
        if (
          !this.isConstructionCrewRosterOutlookAttachmentMatch({
            attachmentName: attachment.name || '',
            subject: message.subject || '',
            constructionCode,
            config,
          })
        ) {
          continue;
        }
        const buffer = await this.getOutlookFileAttachmentBuffer({
          config,
          accessToken,
          messageId: message.id,
          attachment,
        });
        return {
          file: {
            fieldname: 'crewRosterFiles',
            originalname: attachment.name || '施工人员名单.xlsx',
            mimetype:
              attachment.contentType ||
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: buffer.length,
            buffer,
          },
          messageSubject: message.subject || '',
          receivedDateTime: message.receivedDateTime || null,
          attachmentName: attachment.name || '施工人员名单.xlsx',
        };
      }
    }

    throw new Error(
      `未在 Outlook 最新邮件中找到施工编码 ${constructionCode} 的施工人员名单附件`,
    );
  }

  private assertConstructionCrewRosterOutlookConfigured(
    config: ConstructionCrewRosterOutlookConfig,
  ): void {
    const missing = [
      ['CONSTRUCTION_CREW_ROSTER_OUTLOOK_TENANT_ID', config.tenantId],
      ['CONSTRUCTION_CREW_ROSTER_OUTLOOK_CLIENT_ID', config.clientId],
      ['CONSTRUCTION_CREW_ROSTER_OUTLOOK_CLIENT_SECRET', config.clientSecret],
      ['CONSTRUCTION_CREW_ROSTER_OUTLOOK_USER_ID', config.userId],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Outlook施工人员名单邮箱未配置：${missing.join('、')}`);
    }
  }

  private async getConstructionCrewRosterOutlookAccessToken(
    config: ConstructionCrewRosterOutlookConfig,
  ): Promise<string> {
    const tokenUrl = `${config.loginBaseUrl}/${encodeURIComponent(
      config.tenantId,
    )}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: config.scope,
      grant_type: 'client_credentials',
    });
    const response = await this.httpService.axiosRef
      .post(tokenUrl, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
      })
      .catch((error: unknown) => {
        throw new Error(
          `Outlook邮箱授权失败：${getBitableAxiosErrorMessage(error)}`,
        );
      });
    const accessToken = String(response.data?.access_token || '').trim();
    if (!accessToken) {
      throw new Error('Outlook邮箱授权失败：响应中缺少 access_token');
    }
    return accessToken;
  }

  private async fetchConstructionCrewRosterOutlookMessages(
    config: ConstructionCrewRosterOutlookConfig,
    accessToken: string,
  ): Promise<OutlookGraphMessage[]> {
    const userPath = this.buildOutlookGraphUserPath(config.userId);
    const folderPath = config.folderId
      ? `/mailFolders/${this.encodeGraphPathSegment(config.folderId)}`
      : '';
    const apiUrl = `${config.graphBaseUrl}${userPath}${folderPath}/messages`;
    const response = await this.httpService.axiosRef
      .get(apiUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          $top: config.messageLimit,
          $select: 'id,subject,receivedDateTime,hasAttachments',
          $orderby: 'receivedDateTime desc',
          $filter: 'hasAttachments eq true',
        },
        timeout: 30000,
      })
      .catch((error: unknown) => {
        throw new Error(
          `Outlook邮件列表读取失败：${getBitableAxiosErrorMessage(error)}`,
        );
      });
    return Array.isArray(response.data?.value) ? response.data.value : [];
  }

  private async fetchOutlookMessageAttachments(
    config: ConstructionCrewRosterOutlookConfig,
    accessToken: string,
    messageId: string,
  ): Promise<OutlookGraphAttachment[]> {
    const apiUrl = `${config.graphBaseUrl}${this.buildOutlookGraphUserPath(
      config.userId,
    )}/messages/${this.encodeGraphPathSegment(messageId)}/attachments`;
    const response = await this.httpService.axiosRef
      .get(apiUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          $top: 50,
          $select: 'id,name,contentType,size,contentBytes',
        },
        timeout: 30000,
      })
      .catch((error: unknown) => {
        throw new Error(
          `Outlook邮件附件读取失败：${getBitableAxiosErrorMessage(error)}`,
        );
      });
    return Array.isArray(response.data?.value) ? response.data.value : [];
  }

  private async getOutlookFileAttachmentBuffer(input: {
    config: ConstructionCrewRosterOutlookConfig;
    accessToken: string;
    messageId: string;
    attachment: OutlookGraphAttachment;
  }): Promise<Buffer> {
    const { attachment } = input;
    if (attachment.contentBytes) {
      return Buffer.from(attachment.contentBytes, 'base64');
    }
    if (!attachment.id) {
      throw new Error(`Outlook附件缺少 ID：${attachment.name || '未命名附件'}`);
    }
    const apiUrl = `${input.config.graphBaseUrl}${this.buildOutlookGraphUserPath(
      input.config.userId,
    )}/messages/${this.encodeGraphPathSegment(
      input.messageId,
    )}/attachments/${this.encodeGraphPathSegment(attachment.id)}/$value`;
    const response = await this.httpService.axiosRef
      .get<ArrayBuffer>(apiUrl, {
        headers: { Authorization: `Bearer ${input.accessToken}` },
        responseType: 'arraybuffer',
        timeout: 30000,
      })
      .catch((error: unknown) => {
        throw new Error(
          `Outlook附件下载失败：${getBitableAxiosErrorMessage(error)}`,
        );
      });
    return Buffer.from(response.data);
  }

  private isConstructionCrewRosterOutlookAttachmentMatch(input: {
    attachmentName: string;
    subject: string;
    constructionCode: string;
    config: ConstructionCrewRosterOutlookConfig;
  }): boolean {
    const attachmentName = input.attachmentName || '';
    if (!/\.(xlsx|xls|xlsm|csv)$/i.test(attachmentName)) {
      return false;
    }
    const combinedText = `${input.subject} ${attachmentName}`;
    const codeMatches = this.includesNormalizedText(
      combinedText,
      input.constructionCode,
    );
    if (input.config.requireConstructionCodeMatch && !codeMatches) {
      return false;
    }
    return (
      this.includesAnyKeyword(input.subject, input.config.subjectKeywords) ||
      this.includesAnyKeyword(attachmentName, input.config.attachmentKeywords)
    );
  }

  private includesAnyKeyword(
    value: string,
    keywords: readonly string[],
  ): boolean {
    return keywords.some((keyword) =>
      this.includesNormalizedText(value, keyword),
    );
  }

  private includesNormalizedText(value: string, expected: string): boolean {
    const source = this.normalizeOutlookSearchText(value);
    const target = this.normalizeOutlookSearchText(expected);
    return Boolean(source && target && source.includes(target));
  }

  private normalizeOutlookSearchText(value: string): string {
    return String(value || '')
      .toUpperCase()
      .replace(/\s+/g, '')
      .replace(/[^A-Z0-9\u3400-\u9fff\uf900-\ufaff]/g, '');
  }

  private buildOutlookGraphUserPath(userId: string): string {
    return `/users/${this.encodeGraphPathSegment(userId)}`;
  }

  private encodeGraphPathSegment(value: string): string {
    return encodeURIComponent(value).replace(/%2F/gi, '%252F');
  }

  private async resolveConstructionCodeForCrewRosterSync(
    overviewRecordId: string,
    tenantAccessToken: string,
    overviewAppToken?: string | null,
  ): Promise<string | null> {
    if (
      !overviewRecordId ||
      !this.hasBitableSourceConfig(this.constructionOverviewConfig)
    ) {
      return null;
    }
    const appToken =
      overviewAppToken ||
      (await resolveBitableAppToken(
        this.httpService,
        this.constructionOverviewConfig,
      ));
    const overviewRecord = await this.fetchBitableRecordById(
      appToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      overviewRecordId,
      tenantAccessToken,
    );
    return this.extractConstructionCodeValue(overviewRecord?.fields || {});
  }

  private async triggerConstructionCredentialCheckFromOverview(input: {
    overviewRecordId: string;
    tenantAccessToken: string;
    overviewAppToken?: string | null;
  }): Promise<void> {
    if (
      !input.overviewRecordId ||
      !this.hasBitableSourceConfig(this.constructionOverviewConfig)
    ) {
      return;
    }
    const appToken =
      input.overviewAppToken ||
      (await resolveBitableAppToken(
        this.httpService,
        this.constructionOverviewConfig,
      ));
    const fieldName = '信息及证件查验触发（不用）';

    try {
      await this.updateBitableRecordFields(
        appToken,
        this.constructionOverviewConfig.tableId,
        this.constructionOverviewConfig.tableName,
        input.overviewRecordId,
        { [fieldName]: false },
        input.tenantAccessToken,
        {
          optionalMissingFieldNames:
            CONSTRUCTION_OVERVIEW_OPTIONAL_MISSING_FIELD_NAMES,
        },
      );
      await this.updateBitableRecordFields(
        appToken,
        this.constructionOverviewConfig.tableId,
        this.constructionOverviewConfig.tableName,
        input.overviewRecordId,
        { [fieldName]: true },
        input.tenantAccessToken,
        {
          optionalMissingFieldNames:
            CONSTRUCTION_OVERVIEW_OPTIONAL_MISSING_FIELD_NAMES,
        },
      );
      invalidateBitableRecordCache({
        appToken,
        tableId: this.constructionOverviewConfig.tableId,
        deletePersisted: true,
      });
    } catch (error) {
      this.logger.warn(
        `施工人员证件查验触发失败，已保留名单入库结果: ${getBitableAxiosErrorMessage(error)}`,
      );
    }
  }

  private async runConstructionCrewRosterCertificateBatchCheck(input: {
    records: ConstructionCrewRosterSyncedRecord[];
    overviewRecordId: string;
    constructionCode: string;
    tenantAccessToken: string;
    members: Array<{ name: string; certificateNo: string | null }>;
  }): Promise<ConstructionCrewRosterCertificateCheckSummary> {
    const queryPeople = input.records
      .map((record) => ({
        recordId: record.recordId.trim(),
        name: record.name.trim(),
        certificateNo: String(record.certificateNo || '')
          .trim()
          .toUpperCase(),
      }))
      .filter(
        (record) => record.recordId && record.name && record.certificateNo,
      );

    if (queryPeople.length === 0) {
      return {
        queried: 0,
        compliant: 0,
        issue: 0,
        pending: 0,
        summary: '持证查询0人',
      };
    }

    try {
      const config = this.getConstructionCrewLedgerConfig();
      if (!this.hasBitableSourceConfig(config)) {
        return {
          queried: 0,
          compliant: 0,
          issue: 0,
          pending: 0,
          summary: '持证查询：施工人员台账未配置',
        };
      }

      const tenantAccessToken = input.tenantAccessToken;
      const appToken = await resolveBitableAppToken(this.httpService, config);
      const fieldMetas = await this.fetchBitableFieldMetas(
        appToken,
        config.tableId,
        config.tableName,
        tenantAccessToken,
      );
      const fieldMapping =
        this.buildConstructionCertificateFieldMapping(fieldMetas);
      if (Object.keys(fieldMapping).length === 0) {
        return {
          queried: 0,
          compliant: 0,
          issue: 0,
          pending: 0,
          summary: '持证查询：施工人员台账缺少证书回填字段',
        };
      }

      const baseUrl =
        readEnv('CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL', [
          'FEISHU_CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL',
        ]) || DEFAULT_CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL;
      const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
      const feishuAuth = getFeishuAuthPayload();
      let total = 0;
      let success = 0;
      let failed = 0;

      for (
        let index = 0;
        index < queryPeople.length;
        index += CONSTRUCTION_CERTIFICATE_BATCH_SIZE
      ) {
        const chunk = queryPeople.slice(
          index,
          index + CONSTRUCTION_CERTIFICATE_BATCH_SIZE,
        );
        const response = await this.postConstructionCertificateBatchQuery(
          normalizedBaseUrl,
          {
            feishu: {
              ...feishuAuth,
              app_token: appToken,
              table_id: config.tableId,
            },
            lookup: null,
            field_mapping: fieldMapping,
            people: chunk.map((person) => ({
              record_id: person.recordId,
              name: person.name,
              id_number: person.certificateNo,
            })),
          },
        );
        total += Number(response.total || chunk.length);
        success += Number(response.success || 0);
        failed += Number(response.failed || 0);
      }

      invalidateBitableRecordCache({
        appToken,
        tableId: config.tableId,
        deletePersisted: true,
      });

      const summary =
        await this.waitForConstructionCrewRosterCertificateCheckSummary({
          overviewRecordId: input.overviewRecordId,
          constructionCode: input.constructionCode,
          tenantAccessToken,
          expectedCount: input.members.length,
          members: input.members,
        });

      return {
        ...summary,
        queried: Math.max(summary.queried, total),
        summary:
          summary.queried > 0
            ? summary.summary
            : `持证查询${total}人，成功${success}人，失败${failed}人`,
      };
    } catch (error) {
      this.logger.warn(
        `施工人员持证查询触发失败，已保留人员台账写入结果: ${getBitableAxiosErrorMessage(error)}`,
      );
      return {
        queried: queryPeople.length,
        compliant: 0,
        issue: 0,
        pending: queryPeople.length,
        summary: `持证查询已触发${queryPeople.length}人，查询服务异常`,
      };
    }
  }

  private buildConstructionCertificateFieldMapping(
    fieldMetas: BitableFieldMeta[],
  ): Record<string, ConstructionCertificateFieldMappingEntry> {
    const writableFields = fieldMetas.filter(
      (field) => !NON_WRITABLE_BITABLE_FIELD_TYPES.has(field.type || 0),
    );
    const findName = (names: readonly string[]) =>
      this.findBitableField(writableFields, [...names])?.field_name || '';
    const result: Record<string, ConstructionCertificateFieldMappingEntry> = {};

    for (const [certType, aliases] of Object.entries(
      CONSTRUCTION_CERTIFICATE_FIELD_MAPPING_ALIASES,
    )) {
      const mapping = {
        expire_field: findName(aliases.expire_field),
        review_due_field: findName(aliases.review_due_field),
        review_actual_field: findName(aliases.review_actual_field),
        attachment_field: findName(aliases.attachment_field),
      };
      if (
        mapping.expire_field &&
        mapping.review_due_field &&
        mapping.review_actual_field &&
        mapping.attachment_field
      ) {
        result[certType] = mapping;
      }
    }

    return result;
  }

  private async postConstructionCertificateBatchQuery(
    baseUrl: string,
    payload: Record<string, unknown>,
  ): Promise<{ total?: number; success?: number; failed?: number }> {
    const url = `${baseUrl}/api/v1/query/batch`;
    try {
      const response = await this.httpService.axiosRef.post(url, payload, {
        timeout: Number(
          readEnv('CONSTRUCTION_CERTIFICATE_SERVICE_TIMEOUT_MS') || 900000,
        ),
      });
      return response.data || {};
    } catch (error) {
      if (
        this.isConstructionCertificateServiceConnectionError(error) &&
        (await this.startConstructionCertificateService(baseUrl))
      ) {
        const response = await this.httpService.axiosRef.post(url, payload, {
          timeout: Number(
            readEnv('CONSTRUCTION_CERTIFICATE_SERVICE_TIMEOUT_MS') || 900000,
          ),
        });
        return response.data || {};
      }
      throw error;
    }
  }

  private async waitForConstructionCrewRosterCertificateCheckSummary(input: {
    overviewRecordId: string;
    constructionCode: string;
    tenantAccessToken: string;
    expectedCount: number;
    members: Array<{ name: string; certificateNo: string | null }>;
  }): Promise<ConstructionCrewRosterCertificateCheckSummary> {
    const maxAttempts = 6;
    let latest =
      await this.fetchConstructionCrewRosterCertificateCheckSummary(input);

    for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
      const hasExpectedRows =
        input.expectedCount <= 0 || latest.queried >= input.expectedCount;
      const hasSettledResult =
        latest.queried > 0 && latest.pending === 0 && hasExpectedRows;
      if (hasSettledResult) {
        return latest;
      }

      await this.sleep(2000);
      latest =
        await this.fetchConstructionCrewRosterCertificateCheckSummary(input);
    }

    return latest;
  }

  private async fetchConstructionCrewRosterCertificateCheckSummary(input: {
    overviewRecordId: string;
    constructionCode: string;
    tenantAccessToken: string;
    members: Array<{ name: string; certificateNo: string | null }>;
  }): Promise<ConstructionCrewRosterCertificateCheckSummary> {
    const config = this.getConstructionCrewLedgerConfig();
    if (!this.hasBitableSourceConfig(config)) {
      return this.buildConstructionCrewRosterCertificateCheckSummary([]);
    }

    try {
      const appToken = await resolveBitableAppToken(this.httpService, config);
      const records = await this.fetchAllBitableRecordsForMutation(
        appToken,
        config,
      );
      const projectRecords = records.filter((record) =>
        this.isConstructionCrewLedgerRecordForProject(
          record,
          input.overviewRecordId,
          input.constructionCode,
        ),
      );
      const targetRecords = this.filterConstructionCrewLedgerRecordsByMembers(
        projectRecords,
        input.members,
      );
      return this.buildConstructionCrewRosterCertificateCheckSummary(
        targetRecords,
      );
    } catch (error) {
      this.logger.warn(
        `施工人员持证查询结果读取失败: ${getBitableAxiosErrorMessage(error)}`,
      );
      return {
        queried: 0,
        compliant: 0,
        issue: 0,
        pending: 0,
        summary: '持证查询：结果读取失败',
      };
    }
  }

  private filterConstructionCrewLedgerRecordsByMembers(
    records: BitableRecordItem[],
    members: Array<{ name: string; certificateNo: string | null }>,
  ): BitableRecordItem[] {
    if (members.length === 0) {
      return records;
    }

    const memberKeys = new Set(
      members.flatMap((member) =>
        this.buildConstructionCrewRosterMatchKeys(
          member.name,
          null,
          member.certificateNo,
        ),
      ),
    );
    return records.filter((record) => {
      const fields = record.fields || {};
      const name = extractDisplayText(
        pickField(fields, ['姓名', '人员姓名', '员工姓名', '人员']),
      );
      const certificateNo = extractDisplayText(
        pickField(fields, ['证件号码', '身份证号', '身份证号码', '证件号']),
      );
      return this.buildConstructionCrewRosterMatchKeys(
        name,
        null,
        certificateNo,
      ).some((key) => memberKeys.has(key));
    });
  }

  private buildConstructionCrewRosterCertificateCheckSummary(
    records: BitableRecordItem[],
  ): ConstructionCrewRosterCertificateCheckSummary {
    let compliant = 0;
    let issue = 0;
    let pending = 0;
    const issues: string[] = [];

    for (const record of records) {
      const status =
        this.getConstructionCrewRosterCertificateRecordStatus(record);
      if (status.status === 'compliant') {
        compliant += 1;
      } else if (status.status === 'issue') {
        issue += 1;
        if (issues.length < 3) {
          issues.push(`${status.name}：${status.detail || '持证异常'}`);
        }
      } else {
        pending += 1;
      }
    }

    const parts = [
      `持证查询${records.length}人`,
      `达标${compliant}人`,
      `异常${issue}人`,
      `待查询${pending}人`,
    ];
    if (issues.length > 0) {
      parts.push(`异常：${issues.join('；')}`);
    }

    return {
      queried: records.length,
      compliant,
      issue,
      pending,
      summary: parts.join('，'),
      issues,
    };
  }

  private getConstructionCrewRosterCertificateRecordStatus(
    record: BitableRecordItem,
  ): {
    name: string;
    status: 'compliant' | 'issue' | 'pending';
    detail: string | null;
  } {
    const fields = record.fields || {};
    const name =
      extractDisplayText(
        pickField(fields, ['姓名', '人员姓名', '员工姓名', '人员']),
      ) || '未命名人员';
    const certificateSummary = extractDisplayText(
      pickField(fields, [
        '持证统计',
        '持证情况',
        '作业证书',
        '持有作业证书',
        '特种作业证书',
        '证书类别',
        '证书类型',
        '证件类别',
        '作业类别',
        '准操项目',
        '操作项目',
        '作业项目',
      ]),
    );
    const complianceStatus = extractDisplayText(
      pickField(fields, [
        '人员持证是否达标',
        '持证是否达标',
        '是否达标',
        '合规状态',
        '持证合规',
      ]),
    );
    const issueSummary = extractDisplayText(
      pickField(fields, [
        '总结',
        '问题说明',
        '缺失证书',
        '缺少证书',
        '未达标原因',
      ]),
    );
    const combined = [certificateSummary, complianceStatus, issueSummary]
      .filter(Boolean)
      .join('；');
    if (
      !combined ||
      /查询中|计算中|同步中|待查询|待核|未查询|暂无结果/i.test(combined)
    ) {
      return { name, status: 'pending', detail: combined || null };
    }
    if (
      /^(否|false|no)$/i.test(complianceStatus) ||
      /不达标|未达标|不合格|异常|缺|过期|无证|未持证|未查询到/i.test(combined)
    ) {
      return {
        name,
        status: 'issue',
        detail: issueSummary || complianceStatus || certificateSummary || null,
      };
    }
    if (
      /^(是|true|yes)$/i.test(complianceStatus) ||
      /达标|合格|正常|通过|有效|齐全|持证/i.test(combined)
    ) {
      return {
        name,
        status: 'compliant',
        detail: certificateSummary || complianceStatus || null,
      };
    }
    return {
      name,
      status: certificateSummary ? 'compliant' : 'pending',
      detail: certificateSummary || complianceStatus || issueSummary || null,
    };
  }

  private async triggerConstructionCertificateQueryFromFollowup(input: {
    followupRecordId: string;
  }): Promise<void> {
    const followupRecordId = input.followupRecordId?.trim();
    if (!followupRecordId) {
      return;
    }

    const baseUrl =
      readEnv('CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL', [
        'FEISHU_CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL',
      ]) || DEFAULT_CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL;
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const url = `${normalizedBaseUrl}/api/ui/certificate/trigger`;

    try {
      await this.postConstructionCertificateTrigger(url, followupRecordId);
    } catch (error) {
      if (
        this.isConstructionCertificateServiceConnectionError(error) &&
        (await this.startConstructionCertificateService(normalizedBaseUrl))
      ) {
        try {
          await this.postConstructionCertificateTrigger(url, followupRecordId);
          return;
        } catch (retryError) {
          this.logger.warn(
            `施工人员证件查询服务重试触发失败，已保留名单入库结果: ${getBitableAxiosErrorMessage(retryError)}`,
          );
          return;
        }
      }
      this.logger.warn(
        `施工人员证件查询服务触发失败，已保留名单入库结果: ${getBitableAxiosErrorMessage(error)}`,
      );
    }
  }

  private async postConstructionCertificateTrigger(
    url: string,
    followupRecordId: string,
  ): Promise<void> {
    const response = await this.httpService.axiosRef.post(
      url,
      { record_id: followupRecordId },
      { timeout: 10000 },
    );
    const status = response.data?.status || 'accepted';
    const taskId = response.data?.task_id;
    this.logger.log(
      `施工人员证件查询已触发：followup=${followupRecordId}，status=${status}${taskId ? `，task=${taskId}` : ''}`,
    );
  }

  private isConstructionCertificateServiceConnectionError(
    error: unknown,
  ): boolean {
    const maybeError = error as {
      code?: string;
      response?: unknown;
      cause?: { code?: string };
    };
    if (maybeError.response) {
      return false;
    }
    return new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
    ]).has(maybeError.code || maybeError.cause?.code || '');
  }

  private async startConstructionCertificateService(
    baseUrl: string,
  ): Promise<boolean> {
    if (await this.isConstructionCertificateServiceHealthy(baseUrl)) {
      return true;
    }

    const startScript =
      readEnv('CONSTRUCTION_CERTIFICATE_SERVICE_START_SCRIPT', [
        'FEISHU_CONSTRUCTION_CERTIFICATE_SERVICE_START_SCRIPT',
      ]) || DEFAULT_CONSTRUCTION_CERTIFICATE_SERVICE_START_SCRIPT;
    if (!existsSync(startScript)) {
      this.logger.warn(
        `施工人员证件查询服务未启动，且启动脚本不存在: ${startScript}`,
      );
      return false;
    }

    try {
      const servicePort = (() => {
        try {
          return new URL(baseUrl).port || '58000';
        } catch {
          return '58000';
        }
      })();
      const isPowerShellScript = /\.ps1$/i.test(startScript);
      const isCmdScript = /\.(bat|cmd)$/i.test(startScript);
      const child = isPowerShellScript
        ? spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              startScript,
              '-Port',
              servicePort,
            ],
            {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            },
          )
        : isCmdScript
          ? spawn(
              'cmd.exe',
              ['/d', '/c', `start "" /min "${startScript}" runserver`],
              {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              },
            )
          : spawn(startScript, [], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
      child.unref();
      this.logger.warn(
        `施工人员证件查询服务未响应，已尝试启动: ${startScript}`,
      );
    } catch (startError) {
      this.logger.warn(
        `施工人员证件查询服务启动失败: ${getBitableAxiosErrorMessage(startError)}`,
      );
      return false;
    }

    return this.waitForConstructionCertificateServiceHealthy(baseUrl);
  }

  private async waitForConstructionCertificateServiceHealthy(
    baseUrl: string,
  ): Promise<boolean> {
    const deadline =
      Date.now() + CONSTRUCTION_CERTIFICATE_SERVICE_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isConstructionCertificateServiceHealthy(baseUrl)) {
        return true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CONSTRUCTION_CERTIFICATE_SERVICE_HEALTH_POLL_MS),
      );
    }
    return false;
  }

  private async isConstructionCertificateServiceHealthy(
    baseUrl: string,
  ): Promise<boolean> {
    try {
      const response = await this.httpService.axiosRef.get(
        `${baseUrl}/healthz`,
        {
          timeout: 2000,
        },
      );
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  private resolveConstructionCrewLedgerRosterFieldNames(
    fieldMetas: BitableFieldMeta[],
  ): ConstructionCrewLedgerRosterFieldNames {
    const writableFields = fieldMetas.filter(
      (field) => !NON_WRITABLE_BITABLE_FIELD_TYPES.has(field.type || 0),
    );
    const findName = (names: readonly string[]) =>
      this.findBitableField(writableFields, [...names])?.field_name;
    const name = findName(CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.name);
    if (!name) {
      throw new Error('施工人员台账未找到“姓名”字段，无法写入人员名单');
    }

    return {
      name,
      phone: findName(CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.phone),
      certificateNo: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.certificateNo,
      ),
      certificateType: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.certificateType,
      ),
      gender: findName(CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.gender),
      carLicenseNo: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.carLicenseNo,
      ),
      company: findName(CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.company),
      constructionUnit: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.constructionUnit,
      ),
      hasOperateAuthority: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.hasOperateAuthority,
      ),
      authorizationScope: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.authorizationScope,
      ),
      roleType: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.roleType,
      ),
      authorizationStartDate: findName([
        ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_START_FIELD_NAMES,
      ]),
      authorizationEndDate: findName([
        ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_END_FIELD_NAMES,
      ]),
      authorizationStatus: findName([
        ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_STATUS_FIELD_NAMES,
      ]),
      overviewLink: findName(
        CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.overviewLink,
      ),
      constructionCode: findName([
        ...CONSTRUCTION_CREW_LEDGER_CONSTRUCTION_CODE_FIELD_NAMES,
      ]),
    };
  }

  private buildConstructionCrewLedgerRosterFields(input: {
    entry: ConstructionCrewRosterEntry;
    fieldNames: ConstructionCrewLedgerRosterFieldNames;
    overviewRecordId: string;
    constructionCode: string;
  }): Record<string, unknown> {
    const { entry, fieldNames } = input;
    const fields: Record<string, unknown> = {
      [fieldNames.name]: entry.name,
    };
    this.assignOptionalBitableField(fields, fieldNames.phone, entry.phone);
    this.assignOptionalBitableField(
      fields,
      fieldNames.certificateNo,
      entry.certificateNo,
    );
    this.assignOptionalBitableField(
      fields,
      fieldNames.certificateType,
      entry.certificateType,
    );
    this.assignOptionalBitableField(fields, fieldNames.gender, entry.gender);
    this.assignOptionalBitableField(
      fields,
      fieldNames.carLicenseNo,
      entry.carLicenseNo,
    );
    this.assignOptionalBitableField(fields, fieldNames.company, entry.company);
    this.assignOptionalBitableField(
      fields,
      fieldNames.constructionUnit,
      entry.company,
    );
    this.assignOptionalBitableField(
      fields,
      fieldNames.hasOperateAuthority,
      entry.hasOperateAuthority,
    );
    this.assignOptionalBitableField(
      fields,
      fieldNames.authorizationScope,
      entry.authorizationScope,
    );
    this.assignOptionalBitableField(
      fields,
      fieldNames.roleType,
      entry.roleType,
    );
    if (fieldNames.authorizationStartDate && entry.authorizationStartDate) {
      fields[fieldNames.authorizationStartDate] = this.getShanghaiDateStartMs(
        entry.authorizationStartDate,
      );
    }
    if (fieldNames.authorizationEndDate && entry.authorizationEndDate) {
      fields[fieldNames.authorizationEndDate] = this.getShanghaiDateStartMs(
        entry.authorizationEndDate,
      );
    }
    this.assignOptionalBitableField(
      fields,
      fieldNames.authorizationStatus,
      entry.authorizationStatus,
    );
    if (fieldNames.overviewLink && input.overviewRecordId) {
      fields[fieldNames.overviewLink] = [input.overviewRecordId];
    }
    this.assignOptionalBitableField(
      fields,
      fieldNames.constructionCode,
      input.constructionCode,
    );
    return fields;
  }

  private assignOptionalBitableField(
    fields: Record<string, unknown>,
    fieldName: string | undefined,
    value: unknown,
  ): void {
    if (!fieldName || value === null || value === undefined || value === '') {
      return;
    }
    fields[fieldName] = value;
  }

  private indexConstructionCrewLedgerRecordsByRosterKey(
    records: BitableRecordItem[],
  ): Map<string, BitableRecordItem> {
    const recordsByKey = new Map<string, BitableRecordItem>();
    for (const record of records) {
      const fields = record.fields || {};
      const keys = this.buildConstructionCrewRosterMatchKeys(
        extractDisplayText(fields.姓名),
        extractDisplayText(
          pickField(fields, [
            ...CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.phone,
          ]),
        ) || null,
        extractDisplayText(
          pickField(fields, [
            ...CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.certificateNo,
          ]),
        ) || null,
      );
      keys.forEach((key) => {
        if (key && !recordsByKey.has(key)) {
          recordsByKey.set(key, record);
        }
      });
    }
    return recordsByKey;
  }

  private buildConstructionCrewRosterMatchKeys(
    name: string | null | undefined,
    phone: string | null | undefined,
    certificateNo: string | null | undefined,
  ): string[] {
    return Array.from(
      new Set(
        [
          this.buildConstructionCrewRosterMatchKey(name, phone, certificateNo),
          this.buildConstructionCrewRosterNameMatchKey(name),
        ].filter(Boolean),
      ),
    );
  }

  private buildConstructionCrewRosterMatchKey(
    name: string | null | undefined,
    phone: string | null | undefined,
    certificateNo: string | null | undefined,
  ): string {
    const normalizedName = String(name || '')
      .trim()
      .replace(/\s+/g, '');
    if (!normalizedName) {
      return '';
    }
    const normalizedPhone = String(phone || '').replace(/[^\d+]/g, '');
    if (normalizedPhone) {
      return `name-phone:${normalizedName}:${normalizedPhone}`;
    }
    const normalizedCertificateNo = String(certificateNo || '')
      .trim()
      .replace(/\s+/g, '')
      .toUpperCase();
    if (normalizedCertificateNo) {
      return `name-cert:${normalizedName}:${normalizedCertificateNo}`;
    }
    return `name:${normalizedName}`;
  }

  private buildConstructionCrewRosterNameMatchKey(
    name: string | null | undefined,
  ): string {
    const normalizedName = String(name || '')
      .trim()
      .replace(/\s+/g, '');
    return normalizedName ? `name:${normalizedName}` : '';
  }

  private isConstructionCrewLedgerRecordForProject(
    record: BitableRecordItem,
    overviewRecordId: string,
    constructionCode: string,
  ): boolean {
    const fields = record.fields || {};
    const recordConstructionCode = this.extractConstructionCodeValue(fields);
    if (recordConstructionCode && recordConstructionCode === constructionCode) {
      return true;
    }
    return this.extractConstructionLinkedRecordIds(fields).includes(
      overviewRecordId,
    );
  }

  private async syncConstructionCrewLedgerAuthorizationFields(
    crewRecords: BitableRecordItem[],
    referenceDate: Date = new Date(),
  ): Promise<boolean> {
    const config = this.getConstructionCrewLedgerConfig();
    if (!this.hasBitableSourceConfig(config) || crewRecords.length === 0) {
      return false;
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    let changed = false;

    for (const record of crewRecords) {
      const recordId = getRecordId(record);
      if (!recordId) {
        continue;
      }
      const fields = record.fields || {};
      const startDateIso = this.extractCrewLedgerAuthorizationDateIso(fields, [
        ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_START_FIELD_NAMES,
      ]);
      const endDateIso = this.extractCrewLedgerAuthorizationDateIso(fields, [
        ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_END_FIELD_NAMES,
      ]);
      const authorizationStatus = getConstructionCrewAuthorizationStatus(
        startDateIso,
        endDateIso,
        referenceDate,
      );
      const updateFields: Record<string, unknown> = {};

      this.assignCrewLedgerAuthorizationDateUpdate(
        updateFields,
        fields,
        '授权开始日期',
        startDateIso,
      );
      this.assignCrewLedgerAuthorizationDateUpdate(
        updateFields,
        fields,
        '授权结束日期',
        endDateIso,
      );

      const currentStatus = extractDisplayText(
        pickField(fields, [
          ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_STATUS_FIELD_NAMES,
        ]),
      );
      if (authorizationStatus && currentStatus !== authorizationStatus) {
        updateFields.授权状态 = authorizationStatus;
      }
      const existingConstructionUnit = extractDisplayText(
        pickField(fields, [
          ...CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.constructionUnit,
        ]),
      ).trim();
      const existingCompany = extractDisplayText(
        pickField(fields, [
          ...CONSTRUCTION_CREW_LEDGER_ROSTER_FIELD_ALIASES.company,
        ]),
      ).trim();
      if (!existingConstructionUnit && existingCompany) {
        updateFields.施工单位 = existingCompany;
      }

      if (Object.keys(updateFields).length === 0) {
        continue;
      }

      await this.updateBitableRecordFields(
        appToken,
        config.tableId,
        config.tableName,
        recordId,
        updateFields,
        tenantAccessToken,
        {
          optionalMissingFieldNames:
            CONSTRUCTION_CREW_LEDGER_OPTIONAL_MISSING_FIELD_NAMES,
        },
      );
      changed = true;
    }

    if (changed) {
      invalidateBitableRecordCache({
        appToken,
        tableId: config.tableId,
        deletePersisted: true,
      });
    }
    return changed;
  }

  private extractCrewLedgerAuthorizationDateIso(
    fields: Record<string, unknown>,
    fieldNames: string[],
  ): string | null {
    return extractDateTimeIso(pickField(fields, fieldNames));
  }

  private assignCrewLedgerAuthorizationDateUpdate(
    updateFields: Record<string, unknown>,
    currentFields: Record<string, unknown>,
    targetFieldName: '授权开始日期' | '授权结束日期',
    sourceDateIso: string | null,
  ): void {
    if (!sourceDateIso) {
      return;
    }
    const sourceDateKey = this.formatShanghaiDateKey(new Date(sourceDateIso));
    const currentDateIso = extractDateTimeIso(currentFields[targetFieldName]);
    const currentDateKey = currentDateIso
      ? this.formatShanghaiDateKey(new Date(currentDateIso))
      : null;
    if (currentDateKey === sourceDateKey) {
      return;
    }
    updateFields[targetFieldName] = this.getShanghaiDateStartMs(sourceDateKey);
  }

  private extractConstructionCodeValue(
    fields: Record<string, unknown>,
  ): string | null {
    return buildConstructionCrewLedgerViewName(
      extractDisplayText(
        pickField(fields, [
          ...CONSTRUCTION_CREW_LEDGER_CONSTRUCTION_CODE_FIELD_NAMES,
        ]),
      ),
    );
  }

  async deleteConstructionProject(
    request: ConstructionProjectMutationRequest,
    principal?: AccessPrincipal,
  ): Promise<ConstructionProjectDeleteResponse> {
    await this.authorizeProfessionalConstruction(principal, request.recordId);
    const recordId = String(request?.recordId || '').trim();
    if (!recordId) {
      throw new Error('缺少施工总览记录 ID，无法删除项目');
    }
    const constructionCode =
      buildConstructionCrewLedgerViewName(request?.constructionCode) || '';
    const task = this.createSyncTask('construction');
    task.message = `项目删除已受理，后台处理中：${constructionCode || recordId}`;
    if (isProfessionalBusinessPrincipal(principal)) this.professionalConstructionTasks.set(task.id, principal);
    setImmediate(() => {
      void this.runConstructionProjectDeleteTask(task.id, request, principal);
    });

    return {
      success: true,
      recordId,
      constructionCode,
      pending: true,
      taskId: task.id,
      deleted: {
        overview: 0,
        followups: 0,
        crewLedger: 0,
        crewLedgerViews: 0,
      },
      message: task.message,
    };
  }

  private async runConstructionProjectDeleteTask(
    taskId: string,
    request: ConstructionProjectMutationRequest,
    principal?: AccessPrincipal,
  ): Promise<void> {
    const task = this.syncTasks.get(taskId);
    if (!task) {
      return;
    }
    task.status = 'running';
    try {
      await this.authorizeProfessionalConstruction(principal, request.recordId);
      const prepared = await this.prepareConstructionProjectDelete(request);
      const result = await this.deleteConstructionProjectNow(prepared);
      this.recentConstructionOverviewRecords.delete(result.recordId);
      task.status = 'completed';
      task.endTime = new Date();
      task.total =
        result.deleted.overview +
        result.deleted.followups +
        result.deleted.crewLedger +
        (result.deleted.crewLedgerViews || 0);
      task.failed = 0;
      task.result = result;
      task.message = result.message;
      this.logger.log(
        `施工项目后台删除完成: task=${taskId}, code=${result.constructionCode}, overview=${result.deleted.overview}, followups=${result.deleted.followups}, crewLedger=${result.deleted.crewLedger}, views=${result.deleted.crewLedgerViews || 0}`,
      );
    } catch (error) {
      const message = getBitableAxiosErrorMessage(error);
      task.status = 'failed';
      task.endTime = new Date();
      task.failed = 1;
      task.message = `项目删除失败：${message}`;
      this.logger.error(
        `施工项目后台删除失败: task=${taskId}, code=${String(request?.constructionCode || '').trim()}: ${message}`,
      );
    }
  }

  async terminateConstructionProject(
    request: ConstructionProjectMutationRequest,
  ): Promise<ConstructionProjectTerminateResponse> {
    const { recordId, constructionCode, tenantAccessToken, overviewAppToken } =
      await this.prepareConstructionProjectMutation(request, '终止');

    const workflow = '已终止';
    await this.updateBitableRecordFields(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      recordId,
      { 流程: workflow },
      tenantAccessToken,
      {
        optionalMissingFieldNames:
          CONSTRUCTION_OVERVIEW_OPTIONAL_MISSING_FIELD_NAMES,
      },
    );

    invalidateBitableRecordCache({
      appToken: overviewAppToken,
      tableId: this.constructionOverviewConfig.tableId,
      deletePersisted: true,
    });

    return {
      success: true,
      recordId,
      constructionCode,
      workflow,
      message: `项目已终止：${constructionCode}`,
    };
  }

  private async prepareConstructionProjectDelete(
    request: ConstructionProjectMutationRequest,
  ): Promise<{
    recordId: string;
    constructionCode: string;
    tenantAccessToken: string;
    overviewAppToken: string;
    followupAppToken: string;
    crewLedgerAppToken: string;
    crewLedgerConfig: FocusBitableConfig;
  }> {
    const mutation = await this.prepareConstructionProjectMutation(
      request,
      '删除',
    );
    if (!this.hasBitableSourceConfig(this.constructionFollowupConfig)) {
      throw new Error(
        `${this.constructionFollowupConfig.tableName}多维表待配置`,
      );
    }
    const crewLedgerConfig = this.getConstructionCrewLedgerConfig();
    if (!this.hasBitableSourceConfig(crewLedgerConfig)) {
      throw new Error(`${crewLedgerConfig.tableName}多维表待配置`);
    }

    return {
      ...mutation,
      followupAppToken: await resolveBitableAppToken(
        this.httpService,
        this.constructionFollowupConfig,
      ),
      crewLedgerAppToken: await resolveBitableAppToken(
        this.httpService,
        crewLedgerConfig,
      ),
      crewLedgerConfig,
    };
  }

  private async prepareConstructionProjectMutation(
    request: ConstructionProjectMutationRequest,
    actionLabel: string,
  ): Promise<{
    recordId: string;
    constructionCode: string;
    tenantAccessToken: string;
    overviewAppToken: string;
  }> {
    const recordId = String(request?.recordId || '').trim();
    const inputConstructionCode = buildConstructionCrewLedgerViewName(
      request?.constructionCode,
    );
    if (!recordId) {
      throw new Error(`缺少施工总览记录 ID，无法${actionLabel}项目`);
    }
    if (!this.hasBitableSourceConfig(this.constructionOverviewConfig)) {
      throw new Error(
        `${this.constructionOverviewConfig.tableName}多维表待配置`,
      );
    }

    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const overviewAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionOverviewConfig,
    );
    const overviewRecord = await this.fetchBitableRecordById(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      recordId,
      tenantAccessToken,
    );
    if (!overviewRecord) {
      throw new Error(`未找到要${actionLabel}的施工总览记录`);
    }

    const constructionCode = this.extractConstructionCodeValue(
      overviewRecord.fields || {},
    );
    if (!constructionCode) {
      throw new Error(`施工总览记录缺少施工编码，无法安全${actionLabel}项目`);
    }
    if (inputConstructionCode && inputConstructionCode !== constructionCode) {
      throw new Error(
        `施工编码不匹配，禁止${actionLabel}：页面为 ${inputConstructionCode}，多维表为 ${constructionCode}`,
      );
    }

    await this.assertUniqueConstructionOverviewCodeForDeletion(
      overviewAppToken,
      recordId,
      constructionCode,
      actionLabel,
    );

    return {
      recordId,
      constructionCode,
      tenantAccessToken,
      overviewAppToken,
    };
  }

  private async deleteConstructionProjectNow({
    recordId,
    constructionCode,
    tenantAccessToken,
    overviewAppToken,
    followupAppToken,
    crewLedgerAppToken,
    crewLedgerConfig,
  }: {
    recordId: string;
    constructionCode: string;
    tenantAccessToken: string;
    overviewAppToken: string;
    followupAppToken: string;
    crewLedgerAppToken: string;
    crewLedgerConfig: FocusBitableConfig;
  }): Promise<ConstructionProjectDeleteResponse> {
    const followupRecords = (
      await this.fetchAllBitableRecordsForMutation(
        followupAppToken,
        this.constructionFollowupConfig,
      )
    ).filter((record) =>
      this.isConstructionRelatedRecordForDeletion(
        record,
        recordId,
        constructionCode,
      ),
    );
    const crewLedgerRecords = (
      await this.fetchAllBitableRecordsForMutation(
        crewLedgerAppToken,
        crewLedgerConfig,
      )
    ).filter((record) =>
      this.isConstructionRelatedRecordForDeletion(
        record,
        recordId,
        constructionCode,
      ),
    );
    const crewLedgerViews = await this.deleteConstructionCrewLedgerProjectViews(
      crewLedgerAppToken,
      crewLedgerConfig,
      constructionCode,
      tenantAccessToken,
    );

    for (const relatedRecord of followupRecords) {
      await this.deleteBitableRecord(
        followupAppToken,
        this.constructionFollowupConfig.tableId,
        this.constructionFollowupConfig.tableName,
        getRecordId(relatedRecord),
        tenantAccessToken,
      );
    }
    for (const relatedRecord of crewLedgerRecords) {
      await this.deleteBitableRecord(
        crewLedgerAppToken,
        crewLedgerConfig.tableId,
        crewLedgerConfig.tableName,
        getRecordId(relatedRecord),
        tenantAccessToken,
      );
    }
    await this.deleteBitableRecord(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      recordId,
      tenantAccessToken,
    );

    invalidateBitableRecordCache({
      appToken: overviewAppToken,
      tableId: this.constructionOverviewConfig.tableId,
      deletePersisted: true,
    });
    invalidateBitableRecordCache({
      appToken: followupAppToken,
      tableId: this.constructionFollowupConfig.tableId,
      deletePersisted: true,
    });
    invalidateBitableRecordCache({
      appToken: crewLedgerAppToken,
      tableId: crewLedgerConfig.tableId,
      deletePersisted: true,
    });

    return {
      success: true,
      recordId,
      constructionCode,
      deleted: {
        overview: 1,
        followups: followupRecords.length,
        crewLedger: crewLedgerRecords.length,
        crewLedgerViews,
      },
      message: `项目已删除：${constructionCode}`,
    };
  }

  private async assertUniqueConstructionOverviewCodeForDeletion(
    overviewAppToken: string,
    overviewRecordId: string,
    constructionCode: string,
    actionLabel = '删除',
  ): Promise<void> {
    const overviewRecords = await this.fetchAllBitableRecordsForMutation(
      overviewAppToken,
      this.constructionOverviewConfig,
    );
    const duplicateIds = overviewRecords
      .filter((record) => getRecordId(record) !== overviewRecordId)
      .filter(
        (record) =>
          this.extractConstructionCodeValue(record.fields || {}) ===
          constructionCode,
      )
      .map(getRecordId)
      .filter(Boolean);

    if (duplicateIds.length > 0) {
      throw new Error(
        `施工编码重复，禁止${actionLabel}，避免误操作项目：${constructionCode}`,
      );
    }
  }

  private async fetchAllBitableRecordsForMutation(
    appToken: string,
    config: FocusBitableConfig,
  ): Promise<BitableRecordItem[]> {
    return fetchBitableRecords(this.httpService, {
      appToken,
      tableId: config.tableId,
      tableName: config.tableName,
      cacheTtlMs: 0,
      forceRefresh: true,
    });
  }

  private isConstructionRelatedRecordForDeletion(
    record: BitableRecordItem,
    overviewRecordId: string,
    constructionCode: string,
  ): boolean {
    const fields = record.fields || {};
    const recordConstructionCode = this.extractConstructionCodeValue(fields);
    if (recordConstructionCode && recordConstructionCode === constructionCode) {
      return true;
    }

    const linkedRecordIds = this.extractConstructionLinkedRecordIds(fields);
    return linkedRecordIds.includes(overviewRecordId);
  }

  private extractConstructionLinkedRecordIds(
    fields: Record<string, unknown>,
  ): string[] {
    const value = pickField(fields, [
      '施工总览',
      '关联施工单',
      '关联施工项目',
      '施工项目总览',
      '施工项目',
    ]);
    return this.extractBitableLinkedRecordIds(value);
  }

  private extractBitableLinkedRecordIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value.flatMap((item) => {
          if (typeof item === 'string') {
            return [item];
          }
          if (!item || typeof item !== 'object') {
            return [];
          }
          const record = item as Record<string, unknown>;
          const direct = [
            record.record_id,
            record.recordId,
            record.link_record_id,
            record.linkRecordId,
            record.id,
          ].filter((entry): entry is string => typeof entry === 'string');
          const nested = Array.isArray(record.record_ids)
            ? record.record_ids.filter(
                (entry): entry is string => typeof entry === 'string',
              )
            : [];
          return [...direct, ...nested];
        }),
      ),
    );
  }

  private async deleteBitableRecord(
    appToken: string,
    tableId: string,
    tableName: string,
    recordId: string,
    tenantAccessToken: string,
  ): Promise<void> {
    const normalizedRecordId = String(recordId || '').trim();
    if (!normalizedRecordId) {
      throw new Error(`${tableName}待删除记录缺少 recordId`);
    }

    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${normalizedRecordId}`;
    const response = await this.httpService.axiosRef
      .delete(apiUrl, {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        timeout: 30000,
      })
      .catch((error: unknown) => {
        throw new Error(
          `${tableName}记录删除失败: ${getBitableAxiosErrorMessage(error)}`,
        );
      });

    if (response.data.code !== 0) {
      throw new Error(
        `${tableName}记录删除失败: ${getBitableApiErrorMessage(response.data)}`,
      );
    }
  }

  private async collectDutyStaffActualRepairCandidates(
    useRemoteFields = false,
    forceRefresh = false,
  ): Promise<{
    fieldConfig: DutyStaffActualRepairFieldConfig;
    records: BitableRecordItem[];
    candidates: DutyStaffActualRepairCandidate[];
  }> {
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );
    const records = await this.fetchFeishuScheduleRecords(forceRefresh);
    const fieldMetas = useRemoteFields
      ? await this.fetchScheduleFieldMetasWithFallback(records)
      : this.inferScheduleRepairFieldsFromRecords(records);
    const fieldConfig =
      this.resolveDutyStaffActualRepairFieldConfig(fieldMetas);
    const candidates = records
      .map((record) =>
        this.buildDutyStaffActualRepairCandidate(record, fieldConfig),
      )
      .filter((candidate): candidate is DutyStaffActualRepairCandidate =>
        Boolean(candidate),
      );

    return { fieldConfig, records, candidates };
  }

  private async fetchScheduleFieldMetasWithFallback(
    records: BitableRecordItem[],
  ): Promise<BitableFieldMeta[]> {
    try {
      const tenantAccessToken = await this.getFeishuTenantAccessToken();
      return await this.fetchScheduleFieldMetas(tenantAccessToken);
    } catch (error) {
      this.logger.warn(
        `获取值班排班字段列表失败，使用记录字段回退: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.inferScheduleRepairFieldsFromRecords(records);
    }
  }

  private inferScheduleRepairFieldsFromRecords(
    records: BitableRecordItem[],
  ): BitableFieldMeta[] {
    const fieldNames = new Set<string>();
    records.forEach((record) => {
      Object.keys(record.fields || {}).forEach((name) => fieldNames.add(name));
    });

    const target =
      inferWritableDutyProgramModifiedFieldMetaFromRecordFieldNames(fieldNames);
    const sourceFieldId = fieldNames.has('fldJi5bxBG')
      ? 'fldJi5bxBG'
      : '人员（文本）';
    const inferredRecordFields = Array.from(fieldNames)
      .filter(
        (fieldName) =>
          fieldName !== sourceFieldId &&
          fieldName !== '人员（文本）' &&
          !DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES.includes(fieldName),
      )
      .map((fieldName) => ({
        field_id: fieldName,
        field_name: fieldName,
      }));

    return [
      {
        field_id: sourceFieldId,
        field_name: '人员（文本）',
      },
      ...inferredRecordFields,
      ...(target ? [target] : []),
    ];
  }

  async scanDutyProgramModifiedIssues(
    limit = 200,
    forceRefresh = false,
  ): Promise<DutyStaffActualRepairScanResponse> {
    const { fieldConfig, records, candidates } =
      await this.collectDutyStaffActualRepairCandidates(false, forceRefresh);
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
    const returnedCandidates = candidates.slice(0, safeLimit);

    return {
      checkedAt: new Date().toISOString(),
      sourceField: fieldConfig.source.field_name,
      sourceFieldId: fieldConfig.source.field_id,
      targetField: fieldConfig.target.field_name,
      targetFieldId: fieldConfig.target.field_id,
      totalScanned: records.length,
      totalCandidates: candidates.length,
      returnedCandidates: returnedCandidates.length,
      candidates: returnedCandidates,
    };
  }

  async repairDutyProgramModifiedIssues(
    request: DutyStaffActualRepairRequest = {},
  ): Promise<DutyStaffActualRepairResponse> {
    const { fieldConfig, records, candidates } =
      await this.collectDutyStaffActualRepairCandidates(true);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const requestedIds = new Set(
      [...(request.recordIds || []), request.recordId]
        .filter((recordId): recordId is string => Boolean(recordId?.trim()))
        .map((recordId) => recordId.trim()),
    );
    const isManualSingleRepair =
      Boolean(request.recordId) && request.replacementValue !== undefined;

    let repairTargets: Array<{
      recordId: string;
      replacementValue: string;
      canRepair: boolean;
    }> = [];

    if (isManualSingleRepair && request.recordId) {
      const record = records.find(
        (item) => getRecordId(item) === request.recordId,
      );
      if (!record) {
        return {
          success: false,
          total: 1,
          repaired: 0,
          skipped: 0,
          failed: 1,
          message: `未找到记录 ${request.recordId}`,
          failures: [{ recordId: request.recordId, error: '记录不存在' }],
        };
      }
      repairTargets = [
        {
          recordId: request.recordId,
          replacementValue: this.normalizeDutyStaffRepairValue(
            request.replacementValue || '',
          ),
          canRepair: true,
        },
      ];
    } else if (requestedIds.size > 0) {
      repairTargets = candidates
        .filter((candidate) => requestedIds.has(candidate.recordId))
        .map((candidate) => ({
          recordId: candidate.recordId,
          replacementValue: candidate.suggestedValue,
          canRepair: candidate.canRepair,
        }));
    } else {
      repairTargets = candidates.map((candidate) => ({
        recordId: candidate.recordId,
        replacementValue: candidate.suggestedValue,
        canRepair: candidate.canRepair,
      }));
    }

    let repaired = 0;
    let skipped = 0;
    let failed = 0;
    const failures: Array<{ recordId: string; error: string }> = [];

    for (const target of repairTargets) {
      if (!target.canRepair) {
        skipped++;
        continue;
      }

      try {
        await this.updateScheduleTextField(
          target.recordId,
          fieldConfig.target,
          target.replacementValue,
          tenantAccessToken,
        );
        await this.syncLocalDutyStaffActual(
          target.recordId,
          target.replacementValue,
        );
        repaired++;
      } catch (error) {
        failed++;
        failures.push({
          recordId: target.recordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (repaired > 0) {
      invalidateBitableRecordCache({
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
      });
    }

    const total = repairTargets.length;
    return {
      success: failed === 0,
      total,
      repaired,
      skipped,
      failed,
      message: `修正完成：成功 ${repaired} 条，跳过 ${skipped} 条，失败 ${failed} 条`,
      failures,
    };
  }

  async refreshProgramModifiedDutyStaffFromRules(
    options: DutyStaffActualRefreshRequest & { source?: string } = {},
  ): Promise<DutyStaffActualRefreshResponse> {
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );

    const source = options.source || 'manual';
    const defaultWindow = getDutyProgramModifiedRefreshWindow();
    const startDate = options.startDate?.trim() || defaultWindow.startDate;
    const endDate = options.endDate?.trim() || defaultWindow.endDate;
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new Error('startDate 必须是 YYYY-MM-DD 格式');
    }
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw new Error('endDate 必须是 YYYY-MM-DD 格式');
    }
    if (startDate && endDate && endDate < startDate) {
      throw new Error('endDate 不能早于 startDate');
    }

    const records = await this.fetchFeishuScheduleRecords(true, true);
    const result = await this.refreshProgramModifiedDutyStaffRecords(records, {
      startDate,
      endDate,
    });
    if (!isDatabaseDisabled()) {
      await this.replaceLocalScheduleRecords(records, result.finalValues);
    }

    return {
      success: result.failed === 0,
      source,
      startDate,
      endDate,
      scanned: records.length,
      total: result.total,
      updated: result.finalValues.size,
      skipped: Math.max(0, result.total - result.finalValues.size),
      failed: result.failed,
      message: `值班人员（实际）程序修改规则刷新完成（${startDate}至${endDate}）：重置 ${result.reset} 条，规则调整 ${result.ruleUpdated} 条，失败 ${result.failed} 条`,
      failures: result.failures,
    };
  }

  private async refreshProgramModifiedDutyStaffRecords(
    records: BitableRecordItem[],
    window: DutyStaffActualRefreshWindow,
  ): Promise<DutyProgramModifiedRefreshRecordsResult> {
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback(records);
    const sourceField = this.findBitableField(
      fieldMetas,
      ['人员（文本）'],
      ['fldJi5bxBG'],
    );
    if (!sourceField) {
      throw new Error('未找到「人员（文本）」字段，无法重置程序修改人员');
    }
    const programField = this.resolveDutyStaffActualField(fieldMetas);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const plan = this.buildProgramModifiedDutyStaffPlan(records, window, [
      sourceField.field_id,
      sourceField.field_name,
      'fldJi5bxBG',
      '人员（文本）',
      '人员文本',
      '人员',
    ]);
    const fieldKey = programField.field_name || programField.field_id;
    const resetResult = await this.batchUpdateScheduleTextField(
      plan.map((item) => ({
        record_id: item.recordId,
        fields: { [fieldKey]: item.resetText },
      })),
      this.scheduleAppToken,
      this.scheduleTableId,
      tenantAccessToken,
    );
    const resetIds = new Set(resetResult.updatedIds);
    const finalValues = new Map<string, string>();
    plan.forEach((item) => {
      if (resetIds.has(item.recordId)) {
        finalValues.set(item.recordId, item.resetText);
      }
    });

    const finalPlan = plan.filter(
      (item) =>
        resetIds.has(item.recordId) && item.finalText !== item.resetText,
    );
    const ruleResult = await this.batchUpdateScheduleTextField(
      finalPlan.map((item) => ({
        record_id: item.recordId,
        fields: { [fieldKey]: item.finalText },
      })),
      this.scheduleAppToken,
      this.scheduleTableId,
      tenantAccessToken,
    );
    const ruleUpdatedIds = new Set(ruleResult.updatedIds);
    finalPlan.forEach((item) => {
      if (ruleUpdatedIds.has(item.recordId)) {
        finalValues.set(item.recordId, item.finalText);
      }
    });

    if (resetResult.updatedIds.length > 0 || ruleResult.updatedIds.length > 0) {
      invalidateBitableRecordCache({
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
      });
    }

    const failuresByRecordId = new Map<string, string>();
    [...resetResult.failures, ...ruleResult.failures].forEach((failure) => {
      failuresByRecordId.set(failure.recordId, failure.error);
    });
    const failures = Array.from(failuresByRecordId, ([recordId, error]) => ({
      recordId,
      error,
    }));

    return {
      total: plan.length,
      reset: resetResult.updatedIds.length,
      ruleUpdated: ruleResult.updatedIds.length,
      failed: failures.length,
      failures,
      finalValues,
    };
  }

  private buildProgramModifiedDutyStaffPlan(
    records: BitableRecordItem[],
    window: DutyStaffActualRefreshWindow,
    plannedStaffFieldCandidates: string[] = [
      'fldJi5bxBG',
      '人员（文本）',
      '人员文本',
      '人员',
    ],
  ) {
    const plan = records
      .map((record) => {
        const fields = record.fields || {};
        const recordId = getRecordId(record);
        const scheduleDate = this.extractScheduleDateFromFields(fields);
        if (
          !recordId ||
          !scheduleDate ||
          scheduleDate < window.startDate ||
          scheduleDate > window.endDate
        ) {
          return null;
        }

        const approvedLeave = resolveApprovedLeaveVisibilityFromFields(fields);

        return buildDutyProgramModifiedRefreshItem({
          recordId,
          plannedStaff: this.getSchedulePersonNamesFromCandidates(
            fields,
            plannedStaffFieldCandidates,
          ),
          leaveStaff: approvedLeave.leaveStaff,
          substituteStaff: approvedLeave.substituteStaff,
          vacancySubstituteStaff: this.getSchedulePersonNamesFromCandidates(
            fields,
            ['缺岗替班', '缺岗替班人员', '缺岗替代', '缺岗人员替班'],
          ),
          travelStaff: this.getSchedulePersonNamesFromCandidates(fields, [
            '差旅人员',
            '出差人员',
            '差旅',
            '差旅人员信息',
          ]),
        });
      })
      .filter(
        (
          item,
        ): item is ReturnType<typeof buildDutyProgramModifiedRefreshItem> =>
          Boolean(item),
      );
    return plan;
  }

  private async batchUpdateScheduleTextField(
    updates: BitableRecordUpdate[],
    appToken: string,
    tableId: string,
    tenantAccessToken: string,
  ): Promise<{
    updatedIds: string[];
    failures: Array<{ recordId: string; error: string }>;
  }> {
    const updatedIds: string[] = [];
    const failures: Array<{ recordId: string; error: string }> = [];
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`;

    for (const batch of chunkBitableRecordUpdates(updates)) {
      try {
        const response = await this.httpService.axiosRef.post(
          apiUrl,
          { records: batch },
          {
            headers: { Authorization: `Bearer ${tenantAccessToken}` },
            timeout: 30000,
          },
        );
        if (response.data.code !== 0) {
          throw new Error(getBitableApiErrorMessage(response.data));
        }
        updatedIds.push(...batch.map((item) => item.record_id));
      } catch (error) {
        const errorMessage = getBitableAxiosErrorMessage(error);
        batch.forEach((item) => {
          failures.push({ recordId: item.record_id, error: errorMessage });
        });
      }
    }

    return { updatedIds, failures };
  }

  private async replaceLocalScheduleRecords(
    records: BitableRecordItem[],
    refreshedValues: Map<string, string>,
  ): Promise<number> {
    if (isDatabaseDisabled()) {
      return 0;
    }

    const buildingMap: Record<string, string> = {
      building_a: 'app_a_building',
      building_b: 'app_b_building',
      building_c: 'app_c_building',
      building_d: 'app_d_building',
      building_e: 'app_e_building',
      building_h: 'app_h_building',
      station_110: 'station_110',
    };
    const teamMap: Record<string, string> = {
      long_white: 'long_white_shift',
    };
    const shiftMap: Record<string, string> = {
      white: 'white_shift',
      night: 'night_shift',
      long_white: 'long_white_shift',
    };
    const localRows = records
      .map((record) => {
        const schedule = this.mapFeishuScheduleRecord(record);
        const recordId = getRecordId(record);
        if (!schedule || !recordId) {
          return null;
        }
        const refreshedText = refreshedValues.get(recordId);
        return {
          recordId,
          dutyCode: schedule.dutyCode || recordId,
          scheduleDate: schedule.scheduleDate,
          code: schedule.code ?? null,
          building: buildingMap[schedule.building] || schedule.building || null,
          team: teamMap[schedule.team] || schedule.team || null,
          shift: shiftMap[schedule.shift] || schedule.shift || null,
          dutyStaffReference: schedule.dutyStaffReference || [],
          dutyStaffActual:
            refreshedText !== undefined
              ? this.splitDutyPersonText(refreshedText)
              : schedule.dutyStaffActual || [],
          remark: schedule.remark || '',
          emergencyDuty: schedule.emergencyDuty || '',
          emergencyDutySchedule: schedule.emergencyDutySchedule || '',
          leaveStaff: schedule.leaveStaff || [],
          substituteStaff: schedule.substituteStaff || [],
          actualDutyStaff: schedule.actualDutyStaff || '',
          buildingText: schedule.buildingText || '',
          teamText: schedule.teamText || '',
          shiftText: schedule.shiftText || '',
          personText: schedule.personText || '',
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    await this.db.transaction(async (transaction) => {
      await transaction.delete(appRoomScheduleEnhanced);
      for (let index = 0; index < localRows.length; index += 500) {
        await transaction
          .insert(appRoomScheduleEnhanced)
          .values(localRows.slice(index, index + 500));
      }
    });
    await this.updateLastSyncTime();
    return localRows.length;
  }

  async syncDutyScheduleToLocalFast(now = new Date()) {
    const startedAt = Date.now();
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );
    const records = await this.fetchFeishuScheduleRecords(true, true);
    const localValues = new Map(
      this.buildProgramModifiedDutyStaffPlan(
        records,
        getDutyProgramModifiedRefreshWindow(now),
      ).map((item) => [item.recordId, item.finalText]),
    );
    const localSynced = await this.replaceLocalScheduleRecords(
      records,
      localValues,
    );
    const durationMs = Date.now() - startedAt;

    return {
      success: true,
      total: records.length,
      reset: 0,
      ruleUpdated: 0,
      localSynced,
      failed: 0,
      failures: [],
      durationMs,
      message: `排班本地同步完成：本地 ${localSynced} 条`,
    };
  }

  async updateVacancySubstitutes(
    request: VacancySubstituteUpdateRequest = { updates: [] },
  ): Promise<VacancySubstituteUpdateResponse> {
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );
    const updates = (request.updates || [])
      .map((item) => ({
        recordId: item.recordId?.trim(),
        substituteName: this.normalizeDutyStaffRepairValue(
          item.substituteName || '',
        ),
      }))
      .filter((item) => Boolean(item.recordId && item.substituteName))
      .slice(0, 30);

    if (updates.length === 0) {
      return {
        success: false,
        total: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        message: '没有可提交的缺岗替班人员',
        results: [],
        failures: [],
      };
    }

    const records = await this.fetchFeishuScheduleRecords(true);
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback(records);
    const fieldConfig = this.resolveVacancySubstituteFieldConfig(fieldMetas);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const recordMap = new Map(
      records.map((record) => [getRecordId(record), record]),
    );

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const results: VacancySubstituteUpdateResponse['results'] = [];
    const failures: VacancySubstituteUpdateResponse['failures'] = [];

    for (const item of updates) {
      const record = recordMap.get(item.recordId);
      if (!record) {
        failed++;
        failures.push({
          recordId: item.recordId,
          error: '记录不存在或无读取权限',
        });
        continue;
      }

      try {
        const fields = record.fields || {};
        const currentActualText = this.normalizeDutyStaffRepairValue(
          extractDisplayText(
            pickField(fields, [
              fieldConfig.dutyStaffActual.field_id,
              fieldConfig.dutyStaffActual.field_name,
            ]),
            ' ',
          ),
        );
        const currentVacancyText = this.normalizeDutyStaffRepairValue(
          extractDisplayText(
            pickField(fields, [
              fieldConfig.vacancySubstitute.field_id,
              fieldConfig.vacancySubstitute.field_name,
            ]),
            ' ',
          ),
        );
        const nextActualText = this.appendDutyPersonName(
          currentActualText,
          item.substituteName,
        );
        const nextVacancyText = this.appendDutyPersonName(
          currentVacancyText,
          item.substituteName,
        );

        if (
          nextActualText === currentActualText &&
          nextVacancyText === currentVacancyText
        ) {
          skipped++;
          results.push({
            recordId: item.recordId,
            substituteName: item.substituteName,
            dutyStaffActual: this.splitDutyPersonText(nextActualText),
            dutyStaffActualText: nextActualText,
            vacancySubstitute: nextVacancyText,
          });
          continue;
        }

        await this.updateScheduleTextFields(
          item.recordId,
          [
            { field: fieldConfig.vacancySubstitute, value: nextVacancyText },
            { field: fieldConfig.dutyStaffActual, value: nextActualText },
          ],
          tenantAccessToken,
        );
        await this.syncLocalDutyStaffActual(item.recordId, nextActualText);
        updated++;
        results.push({
          recordId: item.recordId,
          substituteName: item.substituteName,
          dutyStaffActual: this.splitDutyPersonText(nextActualText),
          dutyStaffActualText: nextActualText,
          vacancySubstitute: nextVacancyText,
        });
      } catch (error) {
        failed++;
        failures.push({
          recordId: item.recordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (updated > 0) {
      invalidateBitableRecordCache({
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
      });
    }

    const total = updates.length;
    return {
      success: failed === 0,
      total,
      updated,
      skipped,
      failed,
      message: `缺岗替班处理完成：成功 ${updated} 条，跳过 ${skipped} 条，失败 ${failed} 条`,
      results,
      failures,
    };
  }

  async updateDutyStaffAdjustment(
    request: DutyStaffAdjustmentRequest,
  ): Promise<DutyStaffAdjustmentResponse> {
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );
    const recordId = request?.recordId?.trim();
    const targetName = this.normalizeDutyStaffRepairValue(
      request?.targetName || '',
    );
    const replacementName = this.normalizeDutyStaffRepairValue(
      request?.replacementName || '',
    );

    if (!recordId) {
      throw new Error('缺少需要修正的排班记录');
    }
    if (!targetName) {
      throw new Error('请选择需要修正的人员');
    }
    if (!replacementName) {
      throw new Error('请填写修正后的人员姓名');
    }

    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const record = await this.fetchBitableRecordById(
      this.scheduleAppToken,
      this.scheduleTableId,
      '值班排班',
      recordId,
      tenantAccessToken,
    );
    if (!record) {
      throw new Error('记录不存在或无读取权限');
    }
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback([record]);
    const dutyStaffActualField = this.resolveDutyStaffActualField(fieldMetas);

    const fields = record.fields || {};
    const currentActualText = this.normalizeDutyStaffRepairValue(
      extractDisplayText(
        pickField(fields, [
          dutyStaffActualField.field_id,
          dutyStaffActualField.field_name,
        ]),
        ' ',
      ),
    );
    const sourceText =
      currentActualText ||
      this.normalizeDutyStaffRepairValue(
        extractDisplayText(
          pickField(fields, ['人员（文本）', '人员', '人员文本', '值班人员']),
          ' ',
        ),
      );
    const nextActualText = this.replaceDutyPersonName(
      sourceText,
      targetName,
      replacementName,
    );

    if (nextActualText !== currentActualText) {
      await this.updateScheduleTextField(
        recordId,
        dutyStaffActualField,
        nextActualText,
        tenantAccessToken,
      );
      await this.syncLocalDutyStaffActual(recordId, nextActualText);
      invalidateBitableRecordCache({
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
      });
    }

    return {
      success: true,
      recordId,
      targetName,
      replacementName,
      dutyStaffActual: this.splitDutyPersonText(nextActualText),
      dutyStaffActualText: nextActualText,
      message:
        nextActualText === currentActualText
          ? '人员无需修改，本地库已保持最新'
          : `已将 ${targetName} 修正为 ${replacementName}`,
    };
  }

  async updateTravelStaff(
    request: TravelStaffUpdateRequest,
  ): Promise<TravelStaffUpdateResponse> {
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );
    const staffName = this.normalizeDutyStaffRepairValue(
      request?.staffName || '',
    );
    const { startDate, endDate } = this.normalizeTravelStaffDateRange(
      request?.startDate,
      request?.endDate,
    );

    if (!staffName) {
      throw new Error('请选择差旅人员');
    }

    const records = await this.fetchFeishuScheduleRecords();
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback(records);
    const fieldConfig = this.resolveTravelStaffFieldConfig(fieldMetas);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const targets = records
      .map((record) =>
        this.buildTravelStaffMutationTarget(
          record,
          fieldConfig,
          staffName,
          'add',
        ),
      )
      .filter(
        (target): target is TravelStaffMutationTarget =>
          Boolean(target) &&
          target!.scheduleDate >= startDate &&
          target!.scheduleDate <= endDate,
      );

    const { updated, skipped, failed, results, failures } =
      await this.applyTravelStaffMutationTargets(
        targets,
        fieldConfig,
        tenantAccessToken,
      );
    const total = targets.length;

    return {
      success: failed === 0,
      staffName,
      startDate,
      endDate,
      total,
      updated,
      skipped,
      failed,
      message:
        total === 0
          ? `所选日期内未找到 ${staffName} 的值班记录`
          : `差旅人员处理完成：成功 ${updated} 条，跳过 ${skipped} 条，失败 ${failed} 条`,
      results,
      failures,
    };
  }

  async createPersonnelMovement(
    request: PersonnelMovementCreateRequest,
  ): Promise<PersonnelMovementCreateResponse> {
    assertBitableTableConfig(
      '值班排班',
      this.scheduleAppToken,
      this.scheduleTableId,
    );
    const staffName = this.normalizeDutyStaffRepairValue(
      request?.staffName || '',
    );
    const movementType = this.normalizePersonnelMovementType(
      request?.movementType,
    );
    const movementDate = this.normalizePersonnelMovementDate(
      request?.movementDate,
    );

    if (!staffName) {
      throw new Error('请选择人员');
    }

    const records = await this.fetchFeishuScheduleRecords();
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback(records);
    const fieldConfig = this.resolvePersonnelMovementFieldConfig(fieldMetas);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const personnelUpdate = await this.updatePersonnelMovementStatusIfNeeded(
      staffName,
      movementType,
      tenantAccessToken,
    );
    const targets = records
      .map((record) =>
        this.buildPersonnelMovementMutationTarget(
          record,
          fieldConfig,
          staffName,
        ),
      )
      .filter(
        (target): target is PersonnelMovementMutationTarget =>
          Boolean(target) && target!.scheduleDate >= movementDate,
      );
    const { updated, skipped, failed, results, failures } =
      await this.applyPersonnelMovementMutationTargets(
        targets,
        fieldConfig,
        tenantAccessToken,
      );
    const total = targets.length;

    return {
      success: failed === 0,
      staffName,
      movementType,
      movementDate,
      personnelUpdated: personnelUpdate.updated,
      personnelRecordId: personnelUpdate.recordId,
      total,
      updated,
      skipped,
      failed,
      message:
        total === 0
          ? `从 ${movementDate} 起未找到 ${staffName} 的排班记录`
          : `人员异动处理完成：成功 ${updated} 条，跳过 ${skipped} 条，失败 ${failed} 条`,
      results,
      failures,
    };
  }

  async getTravelStaffDetails(
    options: {
      startDate?: string;
      endDate?: string;
      staffName?: string;
      forceRefresh?: boolean;
    } = {},
  ): Promise<TravelStaffDetailResponse> {
    const today = new Date();
    const defaultStartDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const defaultEndDate = this.formatDateKey(
      new Date(today.getFullYear(), today.getMonth() + 1, 0),
    );
    const { startDate, endDate } = this.normalizeTravelStaffDateRange(
      options.startDate || defaultStartDate,
      options.endDate || defaultEndDate,
    );

    const records = await this.fetchFeishuScheduleRecords(
      Boolean(options.forceRefresh),
    );
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback(records);
    const fieldConfig = this.resolveTravelStaffFieldConfig(fieldMetas);
    const details = this.buildTravelStaffDetailsFromRecords(
      records,
      fieldConfig,
      startDate,
      endDate,
      options.staffName,
    );

    return {
      success: true,
      total: details.length,
      details,
    };
  }

  async getLongWhiteDutyStaff(
    date?: string,
    forceRefresh = false,
    verifiedApprovalSnapshot?: LeaveApprovalSnapshot,
  ): Promise<LongWhiteDutyStaffResponse> {
    const targetDate = this.normalizeFocusDate(date);
    const vacancySubstituteFieldCandidates = [
      '缺岗替班',
      '缺岗替班人员',
      '缺岗替代',
      '缺岗人员替班',
    ];
    const travelFieldCandidates = [
      '差旅人员',
      '出差人员',
      '差旅',
      '差旅人员信息',
    ];
    const buildingOrder = [
      'building_h',
      'building_a',
      'building_b',
      'building_c',
      'building_d',
      'building_e',
      'station_110',
    ];
    const expectedLongWhiteBuildings = buildingOrder.filter(
      (building) => building !== 'station_110',
    );
    const buildRows = (
      records: BitableRecordItem[],
    ): LongWhiteDutyStaffSourceRow[] => {
      const rows: LongWhiteDutyStaffSourceRow[] = [];
      records.forEach((record) => {
        const fields = record.fields || {};
        const scheduleDate = extractDateValue(
          pickField(fields, [
            'fldZSaDbGf',
            '排班日期',
            '日期',
            'schedule_date',
            '排班日期（日期）',
          ]),
        );
        if (scheduleDate !== targetDate) {
          return;
        }

        const teamText = extractDisplayText(
          pickField(fields, ['fldE9Gwnk7', '班组', '班别']),
        );
        const shiftText = extractDisplayText(
          pickField(fields, ['fldqPpOgW5', '班次', '值班班次']),
        );
        if (normalizeTeamForFrontend(teamText) !== 'long_white') {
          return;
        }
        const normalizedShift = normalizeShiftForFrontend(shiftText);
        if (normalizedShift && normalizedShift !== 'white') {
          return;
        }

        const buildingText = extractDisplayText(
          pickField(fields, [
            'fldnP4gXMn',
            'fldUHstSKX',
            '机楼',
            '楼栋',
            '值守机楼',
          ]),
        );
        const building = normalizeBuildingForFrontend(buildingText);
        if (!building) {
          return;
        }

        const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);
        const staff = approvedLeave.dutyStaff;
        const leaveStaff = approvedLeave.leaveStaff;
        const substituteStaff = approvedLeave.substituteStaff;
        const vacancySubstituteStaff = extractDisplayValues(
          pickField(fields, vacancySubstituteFieldCandidates),
        ).flatMap((value) => this.splitDutyPersonText(value));
        const travelStaff = extractDisplayValues(
          pickField(fields, travelFieldCandidates),
        ).flatMap((value) => this.splitDutyPersonText(value));
        if (
          staff.length === 0 &&
          leaveStaff.length === 0 &&
          substituteStaff.length === 0 &&
          vacancySubstituteStaff.length === 0 &&
          travelStaff.length === 0
        ) {
          return;
        }

        rows.push({
          building,
          buildingName: normalizeBuildingLabel(buildingText),
          staff: verifiedApprovalSnapshot ? [...staff, ...leaveStaff] : staff,
          leaveStaff: verifiedApprovalSnapshot ? [] : leaveStaff,
          substituteStaff,
          vacancySubstituteStaff,
          travelStaff,
        });
      });
      return rows;
    };

    const records = await this.fetchLongWhiteDutyRecords(
      forceRefresh,
      true,
      verifiedApprovalSnapshot,
    );
    let rows = buildRows(records);
    if (
      this.longWhiteDutyConfig.viewId &&
      hasMissingLongWhiteDutyBuildings(rows, expectedLongWhiteBuildings)
    ) {
      const allTableRows = buildRows(
        await this.fetchLongWhiteDutyRecords(
          forceRefresh,
          false,
          verifiedApprovalSnapshot,
        ),
      );
      rows = preferMoreCompleteLongWhiteDutyRows(
        rows,
        allTableRows,
        expectedLongWhiteBuildings,
      );
    }
    const buildings = buildLongWhiteDutyStaffByBuilding(rows, buildingOrder);
    if (verifiedApprovalSnapshot) {
      for (const building of buildings) {
        building.substituteStaff = [
          ...new Set(
            rows
              .filter((row) => row.building === building.building)
              .flatMap((row) => row.substituteStaff),
          ),
        ];
      }
    }
    return {
      date: targetDate,
      buildings,
      total: buildings.reduce(
        (total, building) => total + building.staff.length,
        0,
      ),
      source: {
        tableId: this.longWhiteDutyConfig.tableId,
        viewId: this.longWhiteDutyConfig.viewId,
        staffField: '值班人员（实际）程序修改 / 值班人员（实际）',
      },
    };
  }

  async repairWeeklyLeaveSubstituteMismatches(
    options: LeaveSubstituteRepairRunOptions = {},
  ): Promise<LeaveSubstituteRepairRunResult> {
    const source = options.source || 'manual';
    const referenceDate = this.parseLeaveSubstituteReferenceDate(
      options.referenceDate,
    );
    const { startDate, endDate } = getShanghaiWeekRange(referenceDate);
    const year = 2026;
    const forceRefresh = options.forceRefresh !== false;
    const [scheduleRecords, leaveRecordsResult] = await Promise.all([
      this.fetchFeishuScheduleRecords(forceRefresh, true),
      this.fetchLeaveSubstituteRecords(forceRefresh),
    ]);

    const approvedScheduleRecords = scheduleRecords.map((record) => {
      const fields = record.fields || {};
      const approvedLeave = resolveApprovedLeaveVisibilityFromFields(fields);
      return {
        ...record,
        fields: {
          ...fields,
          fld4xMPICY: approvedLeave.leaveStaff,
          fldZnstUS3: approvedLeave.substituteStaff,
        },
      };
    });
    const approvedLeaveRecords = leaveRecordsResult.records.filter((record) =>
      isLeaveRequestApprovalComplete(record.fields || {}),
    );

    const plan = buildLeaveSubstituteRepairPlan({
      scheduleRecords: approvedScheduleRecords,
      leaveRecords: approvedLeaveRecords,
      scanStartDate: startDate,
      scanEndDate: endDate,
      year,
    });

    const results: LeaveSubstituteRepairRunResult['results'] = [];
    const failures: LeaveSubstituteRepairRunResult['failures'] = [];
    let updated = 0;
    let failed = 0;
    const tenantAccessToken =
      plan.repairs.length > 0 || plan.manualReviews.length > 0
        ? await this.getFeishuTenantAccessToken()
        : '';

    for (const repair of plan.repairs) {
      try {
        await this.updateBitableRecordFields(
          leaveRecordsResult.appToken,
          this.leaveSubstituteConfig.tableId,
          this.leaveSubstituteConfig.tableName,
          repair.leaveRecordId,
          repair.patch,
          tenantAccessToken,
        );
        updated += 1;
        results.push({ ...repair, updated: true });
      } catch (error) {
        failed += 1;
        failures.push({
          ...repair,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (updated > 0) {
      invalidateBitableRecordCache({
        appToken: leaveRecordsResult.appToken,
        tableId: this.leaveSubstituteConfig.tableId,
      });
      invalidateBitableRecordCache({
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
      });
    }

    let notified = false;
    let notificationError: string | undefined;
    const shouldNotify =
      options.notify !== false &&
      (updated > 0 || failed > 0 || plan.manualReviews.length > 0);
    if (shouldNotify) {
      try {
        await this.sendFeishuTextMessage(
          tenantAccessToken || (await this.getFeishuTenantAccessToken()),
          this.leaveSubstituteRepairChatId,
          this.buildLeaveSubstituteRepairNotification({
            source,
            scanStartDate: startDate,
            scanEndDate: endDate,
            updated,
            failed,
            manualReview: plan.manualReviews.length,
            results,
            failures,
            manualReviews: plan.manualReviews,
          }),
        );
        notified = true;
      } catch (error) {
        notificationError =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(`请休假替班修正结果群通知失败: ${notificationError}`);
      }
    }

    const response: LeaveSubstituteRepairRunResult = {
      success: failed === 0,
      source,
      scanStartDate: startDate,
      scanEndDate: endDate,
      year,
      checkedSchedules: plan.checkedSchedules,
      mismatches: plan.mismatches.length,
      plannedRepairs: plan.repairs.length,
      updated,
      failed,
      manualReview: plan.manualReviews.length,
      results,
      failures,
      manualReviews: plan.manualReviews,
      notified,
      notificationError,
      message:
        updated > 0
          ? `请休假替班修正完成：成功 ${updated} 条，失败 ${failed} 条，待人工 ${plan.manualReviews.length} 条`
          : plan.manualReviews.length > 0
            ? `发现请休假替班差异 ${plan.manualReviews.length} 条，需人工确认`
            : '本周请休假替班记录无差异',
    };

    if (updated === 0 && failed === 0 && plan.manualReviews.length === 0) {
      this.logger.log(`请休假替班修正扫描无差异: ${startDate} ~ ${endDate}`);
    } else {
      this.logger.log(response.message);
    }

    return response;
  }

  async adjustTravelStaff(
    request: TravelStaffAdjustRequest,
  ): Promise<TravelStaffMutationResponse> {
    const staffName = this.normalizeDutyStaffRepairValue(
      request?.staffName || '',
    );
    const selectedRecordIds = new Set(
      (request?.recordIds || [])
        .map((recordId) => String(recordId).trim())
        .filter(Boolean),
    );
    const originalRange = this.normalizeTravelStaffDateRange(
      request?.originalStartDate,
      request?.originalEndDate,
    );
    const nextRange = this.normalizeTravelStaffDateRange(
      request?.startDate,
      request?.endDate,
    );

    if (!staffName) {
      throw new Error('请选择差旅人员');
    }

    const records = await this.fetchFeishuScheduleRecords();
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback(records);
    const fieldConfig = this.resolveTravelStaffFieldConfig(fieldMetas);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const targetMap = new Map<string, TravelStaffMutationTarget>();
    const selectedScheduleKeys = new Set<string>();

    if (selectedRecordIds.size > 0) {
      for (const record of records) {
        const recordId = getRecordId(record);
        if (!recordId || !selectedRecordIds.has(recordId)) {
          continue;
        }

        const scheduleRecord = this.buildTravelScheduleRecord(
          record,
          fieldConfig,
        );
        if (
          scheduleRecord &&
          this.isDateKeyInRange(
            scheduleRecord.scheduleDate,
            originalRange.startDate,
            originalRange.endDate,
          ) &&
          scheduleRecord.travelStaff.some(
            (name) =>
              this.normalizeDutyPersonNameForCompare(name) ===
              this.normalizeDutyPersonNameForCompare(staffName),
          )
        ) {
          selectedScheduleKeys.add(
            this.getTravelScheduleRecordScopeKey(scheduleRecord),
          );
        }
      }
    }

    for (const record of records) {
      const fields = record.fields || {};
      const recordId = getRecordId(record);
      const scheduleDate = this.extractScheduleDateFromFields(fields);
      if (!recordId || !scheduleDate) {
        continue;
      }

      const inOriginalRange = this.isDateKeyInRange(
        scheduleDate,
        originalRange.startDate,
        originalRange.endDate,
      );
      const inNextRange = this.isDateKeyInRange(
        scheduleDate,
        nextRange.startDate,
        nextRange.endDate,
      );
      if (!inOriginalRange && !inNextRange) {
        continue;
      }

      const currentActualText = this.getScheduleTextField(
        fields,
        fieldConfig.dutyStaffActual,
      );
      const currentTravelText = this.getScheduleTextField(
        fields,
        fieldConfig.travelStaff,
      );
      const hasActualStaff = this.hasDutyPersonName(
        currentActualText,
        staffName,
      );
      const hasTravelStaff = this.hasDutyPersonName(
        currentTravelText,
        staffName,
      );
      const scheduleRecord =
        selectedRecordIds.size > 0
          ? this.buildTravelScheduleRecord(record, fieldConfig)
          : null;
      const isSelectedOriginalRecord =
        selectedRecordIds.size === 0 || selectedRecordIds.has(recordId);
      const matchesSelectedScope =
        selectedRecordIds.size === 0 ||
        (scheduleRecord
          ? selectedScheduleKeys.has(
              this.getTravelScheduleRecordScopeKey(scheduleRecord),
            )
          : false);

      if (
        inOriginalRange &&
        isSelectedOriginalRecord &&
        hasTravelStaff &&
        !inNextRange
      ) {
        targetMap.set(recordId, {
          recordId,
          scheduleDate,
          staffName,
          currentActualText,
          currentTravelText,
          nextActualText: this.appendDutyPersonName(
            currentActualText,
            staffName,
          ),
          nextTravelText: this.removeDutyPersonName(
            currentTravelText,
            staffName,
          ),
        });
      }

      if (
        inNextRange &&
        matchesSelectedScope &&
        (hasActualStaff || hasTravelStaff)
      ) {
        targetMap.set(recordId, {
          recordId,
          scheduleDate,
          staffName,
          currentActualText,
          currentTravelText,
          nextActualText: this.removeDutyPersonName(
            currentActualText,
            staffName,
          ),
          nextTravelText: this.appendDutyPersonName(
            currentTravelText,
            staffName,
          ),
        });
      }
    }

    const targets = [...targetMap.values()];
    const { updated, skipped, failed, results, failures } =
      await this.applyTravelStaffMutationTargets(
        targets,
        fieldConfig,
        tenantAccessToken,
      );
    const details = this.buildTravelStaffDetailsFromRecords(
      await this.fetchFeishuScheduleRecords(true),
      fieldConfig,
      nextRange.startDate,
      nextRange.endDate,
      staffName,
    );

    return {
      success: failed === 0,
      staffName,
      startDate: nextRange.startDate,
      endDate: nextRange.endDate,
      total: targets.length,
      updated,
      skipped,
      failed,
      message:
        targets.length === 0
          ? `未找到可调整的 ${staffName} 差旅记录`
          : `差旅人员调整完成：成功 ${updated} 条，跳过 ${skipped} 条，失败 ${failed} 条`,
      results,
      failures,
      details,
    };
  }

  async revokeTravelStaff(
    request: TravelStaffRevokeRequest,
  ): Promise<TravelStaffMutationResponse> {
    const staffName = this.normalizeDutyStaffRepairValue(
      request?.staffName || '',
    );
    const selectedRecordIds = new Set(
      (request?.recordIds || [])
        .map((recordId) => String(recordId).trim())
        .filter(Boolean),
    );
    const { startDate, endDate } = this.normalizeTravelStaffDateRange(
      request?.startDate,
      request?.endDate,
    );

    if (!staffName) {
      throw new Error('请选择差旅人员');
    }

    const records = await this.fetchFeishuScheduleRecords();
    const fieldMetas = await this.fetchScheduleFieldMetasWithFallback(records);
    const fieldConfig = this.resolveTravelStaffFieldConfig(fieldMetas);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const targets = records
      .map((record) =>
        this.buildTravelStaffMutationTarget(
          record,
          fieldConfig,
          staffName,
          'revoke',
        ),
      )
      .filter((target): target is TravelStaffMutationTarget => {
        if (!target) {
          return false;
        }
        if (
          selectedRecordIds.size > 0 &&
          !selectedRecordIds.has(target.recordId)
        ) {
          return false;
        }
        return (
          target.scheduleDate >= startDate && target.scheduleDate <= endDate
        );
      });

    const { updated, skipped, failed, results, failures } =
      await this.applyTravelStaffMutationTargets(
        targets,
        fieldConfig,
        tenantAccessToken,
      );
    const details = this.buildTravelStaffDetailsFromRecords(
      await this.fetchFeishuScheduleRecords(true),
      fieldConfig,
      startDate,
      endDate,
      staffName,
    );

    return {
      success: failed === 0,
      staffName,
      startDate,
      endDate,
      total: targets.length,
      updated,
      skipped,
      failed,
      message:
        targets.length === 0
          ? `未找到可撤回的 ${staffName} 差旅记录`
          : `差旅人员撤回完成：成功 ${updated} 条，跳过 ${skipped} 条，失败 ${failed} 条`,
      results,
      failures,
      details,
    };
  }

  async createAdditionalMatter(
    request: AdditionalMatterCreateRequest,
  ): Promise<AdditionalMatterCreateResponse> {
    const type: AdditionalMatterType =
      request?.type === 'customer' ? 'customer' : 'focus';
    const content = this.normalizeDutyStaffRepairValue(request?.content || '');
    const date = this.normalizeFocusDate(request?.date);
    const config =
      type === 'customer' ? this.customerMatterConfig : this.focusOtherConfig;

    if (!content) {
      throw new Error('请填写需要补充的事项内容');
    }
    if (!this.hasBitableSourceConfig(config)) {
      throw new Error(`${config.tableName}多维表待配置`);
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const recordId = await this.createBitableRecord(
      appToken,
      config.tableId,
      config.tableName,
      {
        内容: content,
        时间: this.getShanghaiDateStartMs(date),
      },
      tenantAccessToken,
    );
    invalidateBitableRecordCache({
      appToken,
      tableId: config.tableId,
    });

    return {
      success: true,
      type,
      recordId,
      content,
      date,
      message: type === 'customer' ? '客户相关事项已登记' : '重点事宜已登记',
    };
  }

  async createSealingRegistration(
    request: SealingRegistrationCreateRequest,
  ): Promise<SealingRegistrationCreateResponse> {
    const sealingInfo = this.normalizeDutyStaffRepairValue(
      request?.sealingInfo || '',
    );

    if (!sealingInfo) {
      throw new Error('请填写封网信息');
    }
    if (!this.hasBitableSourceConfig(this.sealingConfig)) {
      throw new Error(`${this.sealingConfig.tableName}多维表待配置`);
    }

    const startTimeMs = this.parseShanghaiDateTimeMs(
      request?.startTime || '',
      '封网开始时间',
    );
    const endTimeMs = this.parseShanghaiDateTimeMs(
      request?.endTime || '',
      '封网结束时间',
    );
    if (endTimeMs < startTimeMs) {
      throw new Error('封网结束时间不能早于开始时间');
    }

    const appToken = await resolveBitableAppToken(
      this.httpService,
      this.sealingConfig,
    );
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      this.sealingConfig.tableId,
      this.sealingConfig.tableName,
      tenantAccessToken,
    );
    const fieldConfig = this.resolveSealingRegistrationFieldConfig(fieldMetas);
    const fields: Record<string, unknown> = {};
    this.setBitableFieldValue(fields, fieldConfig.sealingInfo, sealingInfo);
    this.setBitableFieldValue(fields, fieldConfig.startTime, startTimeMs);
    this.setBitableFieldValue(fields, fieldConfig.endTime, endTimeMs);

    const recordId = await this.createBitableRecord(
      appToken,
      this.sealingConfig.tableId,
      this.sealingConfig.tableName,
      fields,
      tenantAccessToken,
    );
    invalidateBitableRecordCache({
      appToken,
      tableId: this.sealingConfig.tableId,
    });

    return {
      success: true,
      recordId,
      recordUrl: this.buildBitableRecordUrl(this.sealingConfig, recordId),
      sealingInfo,
      startTime: new Date(startTimeMs).toISOString(),
      endTime: new Date(endTimeMs).toISOString(),
      message: `封网已登记：${sealingInfo}`,
    };
  }

  private async resolveLeaveRequestStaff(
    leaveStaffName: string,
    substituteStaffName?: string,
    principal?: AccessPrincipal,
  ): Promise<{ userId?: string; personRecordId: string }> {
    // Name-login IDs are bound to the canonical employee source, not its legacy leave-profile copy.
    const personnelConfig = principal?.accountId?.startsWith('local-external-')
      ? { ...this.leavePersonProfileConfig, ...readEmployeeOnboardingConfig(), viewId: '', sourceUrl: '' }
      : this.leavePersonProfileConfig;
    if (!this.hasBitableSourceConfig(personnelConfig)) {
      throw new BadRequestException(
        `${personnelConfig.tableName}多维表待配置`,
      );
    }

    const plan = resolvePersonProfileReadPlan('leave', {
      leaveTableId: personnelConfig.tableId,
    });
    let records: BitableRecordItem[];
    let personnelAppToken: string;
    try {
      const appToken = await resolveBitableAppToken(
        this.httpService,
        personnelConfig,
      );
      personnelAppToken = appToken;
      assertBitableTableConfig(personnelConfig.tableName, appToken, plan.tableId);
      records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: plan.tableId,
        viewId: plan.viewId,
        fieldNames: plan.fieldNames,
        tableName: personnelConfig.tableName,
        cacheTtlMs: plan.cacheTtlMs,
        forceRefresh: true,
        strict: plan.strict,
        allowStale: plan.allowStale,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw this.createLeaveRequestDefinitelyNotWrittenException(
        '请休假人员资料加载失败，尚未建立请休假记录',
        error,
      );
    }
    const findMatches = (staffName: string): BitableRecordItem[] => {
      const normalizedStaffName =
        this.normalizeDutyPersonNameForCompare(staffName);
      return records.filter((record) => {
        const fields = record.fields || {};
        const userField = pickField(fields, ['员工姓名', '人员']);
        const names = [
          extractDisplayText(
            pickField(fields, ['姓名', '员工姓名', '人员', '人员（文本）']),
            ' ',
          ),
          this.extractFirstUserNameFromBitableField(userField) || '',
        ]
          .map((name) => this.normalizeDutyPersonNameForCompare(name))
          .filter(Boolean);
        return names.includes(normalizedStaffName);
      });
    };
    const matches = findMatches(leaveStaffName);

    if (matches.length === 0) {
      throw new BadRequestException(
        `请休假人员资料中未找到“${leaveStaffName}”`,
      );
    }
    if (matches.length > 1) {
      throw new BadRequestException(
        `请休假人员资料中存在多个“${leaveStaffName}”，请先在人员表中完成去重`,
      );
    }

    const matchedFields = matches[0].fields || {};
    const userField = pickField(matchedFields, ['员工姓名', '人员']);
    const hasNoPersonalFeishuAccount =
      normalizeBuildingForFrontend(
        extractDisplayText(
          pickField(matchedFields, ['机楼/专业', '所属楼栋', '楼栋']),
          ' ',
        ),
      ) === 'station_110';
    if (
      !hasNoPersonalFeishuAccount &&
      Array.isArray(userField) &&
      userField.length > 1
    ) {
      throw new BadRequestException(
        `请休假人员“${leaveStaffName}”的飞书账号必须唯一`,
      );
    }
    const userName = this.extractFirstUserNameFromBitableField(userField);
    if (
      !hasNoPersonalFeishuAccount &&
      userName &&
      this.normalizeDutyPersonNameForCompare(userName) !==
        this.normalizeDutyPersonNameForCompare(leaveStaffName)
    ) {
      throw new BadRequestException(
        `请休假人员“${leaveStaffName}”的飞书账号与姓名不一致`,
      );
    }
    const userId = hasNoPersonalFeishuAccount
      ? undefined
      : this.extractFirstUserIdFromBitableField(userField) || undefined;

    if (principal && isStation110DutyApplicant(principal)) {
      assertStation110WorkforceIdentity(principal, readEnv('FEISHU_APP_ID'), records, matches[0]);
    } else assertLeaveRequestPersonnelIdentity(principal, {
      appId: readEnv('FEISHU_APP_ID'),
      appToken: personnelAppToken,
      tableId: plan.tableId,
      recordId: matches[0].record_id || matches[0].id || '',
      openId: userId,
    });

    if (substituteStaffName) {
      const substituteMatches = findMatches(substituteStaffName);
      if (substituteMatches.length === 0) {
        throw new BadRequestException(
          `请休假人员资料中未找到替班人员“${substituteStaffName}”`,
        );
      }
      if (substituteMatches.length > 1) {
        throw new BadRequestException(
          `请休假人员资料中存在多个替班人员“${substituteStaffName}”，请先在人员表中完成去重`,
        );
      }
    }

    return {
      userId,
      personRecordId: getRecordId(matches[0]),
    };
  }

  private buildLeaveRequestMutationFingerprint(
    request: LeaveRequestCreateRequest,
    screenshot?: ConstructionUploadFile,
  ): string {
    const payload = {
      leaveStaffName: this.normalizeDutyStaffRepairValue(
        request?.leaveStaffName || '',
      ),
      startAt: request?.startAt || '',
      endAt: request?.endAt || '',
      leaveType: this.normalizeDutyStaffRepairValue(request?.leaveType || ''),
      leaveReason: this.normalizeDutyStaffRepairValue(
        request?.leaveReason || '',
      ),
      expectedImpact: createLeaveRequestImpactComparisonKey(
        request?.expectedImpact,
      ),
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload));
    if (screenshot) {
      hash.update('\0');
      hash.update(screenshot.originalname || '');
      hash.update('\0');
      hash.update(screenshot.mimetype || '');
      hash.update('\0');
      hash.update(String(screenshot.size));
      hash.update('\0');
      if (screenshot.buffer) {
        hash.update(screenshot.buffer);
      }
    }
    return hash.digest('hex');
  }

  private validateLeaveRequestScreenshot(
    screenshot?: ConstructionUploadFile,
  ): ConstructionUploadFile {
    if (!screenshot) {
      throw new BadRequestException('请上传流程截图');
    }
    const fileName = String(screenshot.originalname || '').trim();
    if (
      !fileName ||
      fileName.length > 180 ||
      /[\u0000-\u001f\u007f/\\]/.test(fileName)
    ) {
      throw new BadRequestException('流程截图文件名无效');
    }
    if (screenshot.fieldname && screenshot.fieldname !== 'screenshot') {
      throw new BadRequestException('请通过流程截图字段上传附件');
    }
    if (
      !screenshot.buffer ||
      screenshot.buffer.length === 0 ||
      screenshot.size <= 0
    ) {
      throw new BadRequestException('流程截图不能为空');
    }
    if (
      screenshot.size > LEAVE_REQUEST_SCREENSHOT_MAX_BYTES ||
      screenshot.buffer.length > LEAVE_REQUEST_SCREENSHOT_MAX_BYTES
    ) {
      throw new BadRequestException('流程截图不能超过 10MB');
    }
    if (screenshot.size !== screenshot.buffer.length) {
      throw new BadRequestException('流程截图大小校验失败');
    }

    const extension = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0] || '';
    const expectedMimeByExtension: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    const expectedMime = expectedMimeByExtension[extension];
    if (!expectedMime || screenshot.mimetype !== expectedMime) {
      throw new BadRequestException('流程截图仅支持 PNG、JPG、JPEG、WebP 图片');
    }
    const matchesSignature =
      extension === '.webp'
        ? screenshot.buffer.length >= 12 &&
          screenshot.buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
          screenshot.buffer.subarray(8, 12).toString('ascii') === 'WEBP'
        : this.matchesDocumentSignature(extension, screenshot.buffer);
    if (!matchesSignature) {
      throw new BadRequestException('截图文件内容与格式不匹配');
    }
    return screenshot;
  }

  private toLeaveRequestBitableClientToken(clientMutationId: string): string {
    const normalizedMutationId =
      this.normalizeDutyStaffRepairValue(clientMutationId);
    const embeddedUuid = normalizedMutationId.match(
      /^leave-request-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    )?.[1];
    if (embeddedUuid) {
      return embeddedUuid.toLowerCase();
    }

    const digest = crypto
      .createHash('sha256')
      .update(`leave-request-client-token:${normalizedMutationId}`)
      .digest();
    digest[6] = (digest[6] & 0x0f) | 0x40;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  }

  private async findPersistedLeaveRequest(
    appToken: string,
    clientMutationId: string,
    fingerprint: string,
  ): Promise<{ recordId: string } | null> {
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: this.leaveSubstituteConfig.tableId,
      tableName: this.leaveSubstituteConfig.tableName,
      fieldNames: ['请求唯一ID', '请求指纹'],
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: '请求唯一ID',
            operator: 'is',
            value: [clientMutationId],
          },
        ],
      },
      cacheTtlMs: 0,
      forceRefresh: true,
      strict: true,
    });
    if (records.length === 0) {
      return null;
    }
    if (records.length > 1) {
      throw new BadRequestException(
        `请休假多维表存在多个相同请求唯一ID“${clientMutationId}”，已停止写入`,
      );
    }

    const record = records[0];
    const storedFingerprint = this.normalizeDutyStaffRepairValue(
      extractDisplayText(pickField(record.fields || {}, ['请求指纹']), ''),
    );
    if (!storedFingerprint || storedFingerprint !== fingerprint) {
      throw new BadRequestException(
        'clientMutationId 重复但请休假内容不同，请重新打开申请后提交',
      );
    }
    const recordId = getRecordId(record);
    if (!recordId) {
      throw new BadRequestException(
        `请休假多维表请求唯一ID“${clientMutationId}”命中记录但缺少记录 ID`,
      );
    }
    return { recordId };
  }

  private buildPersistedLeaveRequestResponse(
    request: LeaveRequestCreateRequest,
    clientMutationId: string,
    recordId: string,
  ): LeaveRequestCreateResponse {
    const expectedImpactKey = createLeaveRequestImpactComparisonKey(
      request?.expectedImpact,
    );
    if (!expectedImpactKey) {
      throw new BadRequestException('请休假请求缺少有效的排班工时预览');
    }
    const leaveStaffName = this.normalizeDutyStaffRepairValue(
      request?.leaveStaffName || '',
    );
    const { startAt, endAt } = this.normalizeLeaveRequestDateRange(
      request?.startAt,
      request?.endAt,
    );
    const persistedImpact = request.expectedImpact;
    return {
      success: true,
      total: 1,
      created: 0,
      recordIds: [recordId],
      startAt,
      endAt,
      leaveStaffName,
      clientMutationId,
      affectedSchedules: persistedImpact.affectedSchedules,
      shiftGroups: createLeaveRequestShiftGroups(
        persistedImpact.affectedSchedules,
      ),
      excludedSchedules: persistedImpact.excludedSchedules,
      rawHours: persistedImpact.rawHours,
      minimumHours: persistedImpact.minimumHours,
      unrecognizedShifts: persistedImpact.unrecognizedShifts,
      missingCalendarYears: persistedImpact.missingCalendarYears,
      message: `请休假已提交：${leaveStaffName}，${startAt} 至 ${endAt}（已返回原记录）`,
    };
  }

  private async reconcilePersistedLeaveRequest(
    request: LeaveRequestCreateRequest,
    clientMutationId: string,
    screenshot: ConstructionUploadFile,
  ): Promise<LeaveRequestCreateResponse | null> {
    if (!this.hasBitableSourceConfig(this.leaveSubstituteConfig)) {
      throw new BadRequestException(
        `${this.leaveSubstituteConfig.tableName}多维表待配置`,
      );
    }
    const fingerprint = this.buildLeaveRequestMutationFingerprint(
      request,
      screenshot,
    );
    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, this.leaveSubstituteConfig),
      this.getFeishuTenantAccessToken(),
    ]);
    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      this.leaveSubstituteConfig.tableId,
      this.leaveSubstituteConfig.tableName,
      tenantAccessToken,
    );
    this.resolveLeaveRequestFieldConfig(fieldMetas);
    const persistedRequest = await this.findPersistedLeaveRequest(
      appToken,
      clientMutationId,
      fingerprint,
    );
    if (!persistedRequest) {
      return null;
    }
    invalidateBitableRecordCache({
      appToken,
      tableId: this.leaveSubstituteConfig.tableId,
    });
    return this.buildPersistedLeaveRequestResponse(
      request,
      clientMutationId,
      persistedRequest.recordId,
    );
  }

  private isLeaveRequestBitableClientTokenConflict(error: unknown): boolean {
    type ClientTokenConflictErrorRecord = {
      cause?: unknown;
      data?: unknown;
      message?: unknown;
      response?: { data?: unknown };
    };
    const errorRecords: ClientTokenConflictErrorRecord[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 3; depth += 1) {
      if (typeof current !== 'object' || current === null) {
        break;
      }
      const record = current as ClientTokenConflictErrorRecord;
      errorRecords.push(record);
      current = record.cause;
    }
    const hasConflictCode = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null) {
        return false;
      }
      const code = (value as { code?: unknown }).code;
      return String(code ?? '') === '1255006';
    };

    return errorRecords.some(
      (record) =>
        hasConflictCode(record.data) ||
        hasConflictCode(record.response?.data) ||
        (typeof record.message === 'string' &&
          /(?:^|\D)1255006(?:\D|$)/.test(record.message)),
    );
  }

  private toLeaveRequestAmbiguousWriteError(
    error: unknown,
  ): LeaveRequestAmbiguousWriteError | null {
    if (error instanceof LeaveRequestAmbiguousWriteError) {
      return error;
    }

    type WriteErrorRecord = {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      response?: { status?: unknown };
      status?: unknown;
      statusCode?: unknown;
    };
    const toErrorRecord = (value: unknown): WriteErrorRecord | null =>
      typeof value === 'object' && value !== null
        ? (value as WriteErrorRecord)
        : null;
    const errorRecord = toErrorRecord(error);
    const causeRecord = toErrorRecord(errorRecord?.cause);
    const errorRecords = [errorRecord, causeRecord].filter(
      (value): value is WriteErrorRecord => value !== null,
    );
    const statusCandidates = errorRecords.flatMap((record) => [
      record.response?.status,
      record.status,
      record.statusCode,
    ]);
    const httpStatus = statusCandidates.find(
      (value): value is number => typeof value === 'number',
    );
    const ambiguousHttpStatuses = new Set([408, 409, 425, 429]);
    if (
      httpStatus !== undefined &&
      httpStatus >= 400 &&
      httpStatus <= 499 &&
      !ambiguousHttpStatuses.has(httpStatus)
    ) {
      return null;
    }
    const errorCodes = errorRecords
      .map((record) => (typeof record.code === 'string' ? record.code : ''))
      .filter(Boolean);
    const messages = errorRecords
      .map((record) =>
        typeof record.message === 'string' ? record.message : '',
      )
      .filter(Boolean);
    const message = messages[0] || getBitableAxiosErrorMessage(error);
    const isAmbiguous =
      (httpStatus !== undefined &&
        (ambiguousHttpStatuses.has(httpStatus) ||
          (httpStatus >= 500 && httpStatus <= 599))) ||
      errorCodes.some(
        (code) =>
          /^ECONN/i.test(code) ||
          /^(?:EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ERR_NETWORK|ENETDOWN|ENOTFOUND)$/i.test(
            code,
          ),
      ) ||
      messages.some(
        (candidate) =>
          /(?:timeout|timed out|ECONN[A-Z0-9_]*|EAI_AGAIN|ENETUNREACH|socket|aborted|network)/i.test(
            candidate,
          ) ||
          /(?:HTTP(?:\s+status)?|status(?:\s+code)?)\D{0,12}5\d{2}\b/i.test(
            candidate,
          ) ||
          /写入成功但未返回记录\s*ID/i.test(candidate),
      ) ||
      /写入成功但未返回记录\s*ID/i.test(message);

    return isAmbiguous
      ? new LeaveRequestAmbiguousWriteError(message, error)
      : null;
  }

  private getLeaveRequestWriteErrorDetails(error: unknown): {
    upstreamStatus: number | null;
    bitableCode: string | null;
  } {
    type ErrorRecord = {
      bitableCode?: unknown;
      cause?: unknown;
      data?: unknown;
      message?: unknown;
      originalError?: unknown;
      response?: { data?: unknown; status?: unknown };
      responseData?: unknown;
      status?: unknown;
      statusCode?: unknown;
      upstreamStatus?: unknown;
    };
    const records: ErrorRecord[] = [];
    const queue: unknown[] = [error];
    const visited = new Set<unknown>();
    while (queue.length > 0 && records.length < 5) {
      const current = queue.shift();
      if (
        typeof current !== 'object' ||
        current === null ||
        visited.has(current)
      ) {
        continue;
      }
      visited.add(current);
      const record = current as ErrorRecord;
      records.push(record);
      queue.push(record.cause, record.originalError);
    }

    const upstreamStatus = records
      .flatMap((record) => [
        record.upstreamStatus,
        record.response?.status,
        record.status,
        record.statusCode,
      ])
      .find((value): value is number => typeof value === 'number');
    const dataRecords = records.flatMap((record) =>
      [record.response?.data, record.responseData, record.data].filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      ),
    );
    const explicitCode = [...records.map((record) => record.bitableCode)]
      .concat(dataRecords.map((record) => record.code))
      .find(
        (value) =>
          (typeof value === 'string' || typeof value === 'number') &&
          /^\d{5,10}$/.test(String(value)),
      );
    const messageCode = records
      .map((record) =>
        typeof record.message === 'string'
          ? /(?:^|\D)(\d{5,10})(?:\D|$)/.exec(record.message)?.[1]
          : undefined,
      )
      .find(Boolean);

    return {
      upstreamStatus: upstreamStatus ?? null,
      bitableCode:
        explicitCode === undefined ? messageCode || null : String(explicitCode),
    };
  }

  private getLeaveRequestWriteFailureLabel(bitableCode: string | null): string {
    switch (bitableCode) {
      case '91403':
        return '应用缺少请休假表写入权限';
      case '1254061':
        return '休假工时字段格式不兼容';
      case '1254062':
        return '休假类型选项无效';
      case '1254064':
        return '休假时间字段格式不兼容';
      case '1254065':
        return '替班勾选字段格式不兼容';
      case '1254066':
        return '请休假人员关联无效，请重新选择人员';
      default:
        return '飞书拒绝了本次记录写入';
    }
  }

  private logChangeSummaryReportWriteFailure(
    error: unknown,
    clientMutationId: string,
  ): void {
    type StructuredWriteError = {
      bitableCode?: unknown;
      cause?: unknown;
      originalError?: unknown;
      response?: { data?: unknown; status?: unknown };
      responseData?: unknown;
      status?: unknown;
      statusCode?: unknown;
      upstreamStatus?: unknown;
    };
    const records: StructuredWriteError[] = [];
    const queue: unknown[] = [error];
    const visited = new Set<unknown>();
    while (queue.length > 0 && records.length < 5) {
      const current = queue.shift();
      if (
        typeof current !== 'object' ||
        current === null ||
        visited.has(current)
      ) {
        continue;
      }
      visited.add(current);
      const record = current as StructuredWriteError;
      records.push(record);
      queue.push(record.cause, record.originalError);
    }

    const upstreamStatus = records
      .flatMap((record) => [
        record.upstreamStatus,
        record.response?.status,
        record.status,
        record.statusCode,
      ])
      .find(
        (value): value is number =>
          Number.isInteger(value) &&
          Number(value) >= 100 &&
          Number(value) <= 599,
      );
    const dataRecords = records.flatMap((record) =>
      [record.response?.data, record.responseData].filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      ),
    );
    const bitableCode = [...records.map((record) => record.bitableCode)]
      .concat(dataRecords.map((record) => record.code))
      .find(
        (value) =>
          (typeof value === 'string' || typeof value === 'number') &&
          /^\d{5,10}$/.test(String(value)),
      );
    const requestRef = crypto
      .createHash('sha256')
      .update(clientMutationId)
      .digest('hex')
      .slice(0, 12);
    this.logger.error(
      `变更总结记录创建被飞书拒绝：requestRef=${requestRef}, upstreamStatus=${upstreamStatus ?? 'unknown'}, bitableCode=${bitableCode === undefined ? 'unknown' : String(bitableCode)}`,
    );
  }

  private createLeaveRequestDefinitelyNotWrittenException(
    message: string,
    cause?: unknown,
  ): BadGatewayException {
    return Object.assign(
      new BadGatewayException({
        message,
        writeDisposition: 'definitely-not-written',
      }),
      cause === undefined ? {} : { cause },
    );
  }

  private toLeaveRequestRejectedWriteException(
    error: unknown,
    clientMutationId: string,
  ): BadGatewayException {
    const details = this.getLeaveRequestWriteErrorDetails(error);
    const requestRef = crypto
      .createHash('sha256')
      .update(clientMutationId)
      .digest('hex')
      .slice(0, 12);
    this.logger.error(
      `请休假记录创建被飞书拒绝：requestRef=${requestRef}, upstreamStatus=${details.upstreamStatus ?? 'unknown'}, bitableCode=${details.bitableCode ?? 'unknown'}`,
    );
    const codeSuffix = details.bitableCode
      ? `（飞书错误码 ${details.bitableCode}）`
      : '';
    return Object.assign(
      this.createLeaveRequestDefinitelyNotWrittenException(
        `请休假提交失败，飞书未建立记录：${this.getLeaveRequestWriteFailureLabel(details.bitableCode)}${codeSuffix}`,
        error,
      ),
      {
        upstreamStatus: details.upstreamStatus,
        bitableCode: details.bitableCode,
      },
    );
  }

  private withLeaveRequestMutationIdempotency(
    clientMutationId: string,
    request: LeaveRequestCreateRequest,
    screenshot: ConstructionUploadFile,
    operation: (
      replayState: LeaveRequestMutationReplayState,
    ) => Promise<LeaveRequestCreateResponse>,
    reconcile: () => Promise<LeaveRequestCreateResponse | null>,
  ): Promise<LeaveRequestCreateResponse> {
    const now = Date.now();
    for (const [key, entry] of this.leaveRequestMutationCompleted) {
      if (entry.expiresAt <= now) {
        this.leaveRequestMutationCompleted.delete(key);
      }
    }
    const fingerprint = this.buildLeaveRequestMutationFingerprint(
      request,
      screenshot,
    );
    const conflictError = () =>
      new BadRequestException(
        'clientMutationId 重复但请休假内容不同，请重新打开申请后提交',
      );
    const completed = this.leaveRequestMutationCompleted.get(clientMutationId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      return Promise.resolve(completed.response);
    }
    const inFlight = this.leaveRequestMutationInFlight.get(clientMutationId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      return inFlight.promise;
    }
    const unknown = this.leaveRequestMutationUnknown.get(clientMutationId);
    if (unknown) {
      if (unknown.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      this.expireLeaveRequestPreparedWrite(unknown, now);
      const recovery = Promise.resolve()
        .then(reconcile)
        .then((response) => {
          if (response) {
            return response;
          }
          if (
            unknown.replayState.reconcileOnly ||
            unknown.replayState.preparedWrite?.reconcileOnly
          ) {
            throw new LeaveRequestAmbiguousWriteError(
              '请休假写入结果未知，请使用原申请标识安全重试',
              undefined,
            );
          }
          return operation(unknown.replayState);
        })
        .catch((error) => {
          throw new LeaveRequestAmbiguousWriteError(
            '请休假写入结果未知，请使用原申请标识安全重试',
            error,
          );
        });
      return this.trackLeaveRequestMutation(
        clientMutationId,
        fingerprint,
        recovery,
        unknown.replayState,
      );
    }

    const replayState: LeaveRequestMutationReplayState = {};
    const current = Promise.resolve()
      .then(() =>
        this.loadDurableLeaveRequestUnknownMutation(
          clientMutationId,
          fingerprint,
        ),
      )
      .then(async (durableUnknown) => {
        if (!durableUnknown) {
          return operation(replayState);
        }
        replayState.reconcileOnly = true;
        this.rememberLeaveRequestUnknownMutation(
          clientMutationId,
          fingerprint,
          replayState,
        );
        try {
          const response = await reconcile();
          if (response) {
            return response;
          }
        } catch (error) {
          throw new LeaveRequestAmbiguousWriteError(
            '请休假写入结果未知，请使用原申请标识安全重试',
            error,
          );
        }
        throw new LeaveRequestAmbiguousWriteError(
          '请休假写入结果未知，请使用原申请标识安全重试',
          undefined,
        );
      });
    return this.trackLeaveRequestMutation(
      clientMutationId,
      fingerprint,
      current,
      replayState,
    );
  }

  private trackLeaveRequestMutation(
    clientMutationId: string,
    fingerprint: string,
    current: Promise<LeaveRequestCreateResponse>,
    replayState: LeaveRequestMutationReplayState,
  ): Promise<LeaveRequestCreateResponse> {
    const tracked = current.catch(async (error: unknown) => {
      if (error instanceof LeaveRequestAmbiguousWriteError) {
        this.rememberLeaveRequestUnknownMutation(
          clientMutationId,
          fingerprint,
          replayState,
        );
        try {
          await this.persistLeaveRequestUnknownMutation(
            clientMutationId,
            fingerprint,
          );
        } catch {
          this.logger.error(
            '请休假未知写入状态落盘失败，已保留当前进程内的防重状态',
          );
        }
      }
      throw error;
    });
    this.leaveRequestMutationInFlight.set(clientMutationId, {
      fingerprint,
      promise: tracked,
    });
    void tracked.then(
      (response) => {
        if (
          this.leaveRequestMutationInFlight.get(clientMutationId)?.promise ===
          tracked
        ) {
          this.leaveRequestMutationInFlight.delete(clientMutationId);
        }
        this.leaveRequestMutationUnknown.delete(clientMutationId);
        this.clearLeaveRequestPreparedWriteExpiryTimer(clientMutationId);
        this.leaveRequestMutationCompleted.set(clientMutationId, {
          expiresAt: Date.now() + LEAVE_REQUEST_MUTATION_COMPLETED_TTL_MS,
          fingerprint,
          response,
        });
        while (
          this.leaveRequestMutationCompleted.size >
          LEAVE_REQUEST_MUTATION_COMPLETED_MAX_ENTRIES
        ) {
          const oldestKey = this.leaveRequestMutationCompleted.keys().next()
            .value as string | undefined;
          if (!oldestKey) {
            break;
          }
          this.leaveRequestMutationCompleted.delete(oldestKey);
        }
      },
      (error) => {
        if (
          this.leaveRequestMutationInFlight.get(clientMutationId)?.promise ===
          tracked
        ) {
          this.leaveRequestMutationInFlight.delete(clientMutationId);
        }
      },
    );
    return tracked;
  }

  private rememberLeaveRequestUnknownMutation(
    clientMutationId: string,
    fingerprint: string,
    replayState: LeaveRequestMutationReplayState = {},
  ): void {
    const existing = this.leaveRequestMutationUnknown.get(clientMutationId);
    if (replayState.preparedWrite?.reconcileOnly) {
      delete replayState.preparedWrite;
      replayState.reconcileOnly = true;
    } else if (!replayState.preparedWrite) {
      replayState.reconcileOnly = true;
    }
    const preparedWriteExpiresAt = replayState.preparedWrite
      ? existing?.preparedWriteExpiresAt ||
        Date.now() + LEAVE_REQUEST_MUTATION_PREPARED_WRITE_TTL_MS
      : null;
    const entry: LeaveRequestMutationUnknownEntry = {
      fingerprint,
      replayState,
      preparedWriteExpiresAt,
    };
    this.leaveRequestMutationUnknown.delete(clientMutationId);
    this.leaveRequestMutationUnknown.set(clientMutationId, entry);
    this.scheduleLeaveRequestPreparedWriteExpiry(clientMutationId, entry);
    while (
      this.leaveRequestMutationUnknown.size >
      LEAVE_REQUEST_MUTATION_UNKNOWN_MAX_ENTRIES
    ) {
      const oldestKey = this.leaveRequestMutationUnknown.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) {
        break;
      }
      this.leaveRequestMutationUnknown.delete(oldestKey);
      this.clearLeaveRequestPreparedWriteExpiryTimer(oldestKey);
    }
  }

  private clearLeaveRequestPreparedWriteExpiryTimer(
    clientMutationId: string,
  ): void {
    const timer =
      this.leaveRequestPreparedWriteExpiryTimers.get(clientMutationId);
    if (timer) {
      clearTimeout(timer);
      this.leaveRequestPreparedWriteExpiryTimers.delete(clientMutationId);
    }
  }

  private scheduleLeaveRequestPreparedWriteExpiry(
    clientMutationId: string,
    entry: LeaveRequestMutationUnknownEntry,
  ): void {
    this.clearLeaveRequestPreparedWriteExpiryTimer(clientMutationId);
    if (
      !entry.replayState.preparedWrite ||
      entry.preparedWriteExpiresAt === null
    ) {
      return;
    }
    const timer = setTimeout(
      () => {
        this.leaveRequestPreparedWriteExpiryTimers.delete(clientMutationId);
        if (this.leaveRequestMutationUnknown.get(clientMutationId) !== entry) {
          return;
        }
        this.expireLeaveRequestPreparedWrite(entry, Date.now());
      },
      Math.max(0, entry.preparedWriteExpiresAt - Date.now()),
    );
    timer.unref?.();
    this.leaveRequestPreparedWriteExpiryTimers.set(clientMutationId, timer);
  }

  private getLeaveRequestMutationLedgerKey(clientMutationId: string): string {
    return crypto.createHash('sha256').update(clientMutationId).digest('hex');
  }

  private getLeaveRequestMutationLedgerPath(clientMutationId: string): string {
    return join(
      this.leaveRequestMutationLedgerDir,
      `${this.getLeaveRequestMutationLedgerKey(clientMutationId)}.json`,
    );
  }

  private parseLeaveRequestUnknownLedgerEntry(
    contents: string,
    clientMutationId: string,
  ): LeaveRequestMutationUnknownLedgerEntry {
    let value: Partial<LeaveRequestMutationUnknownLedgerEntry> | undefined;
    try {
      value = JSON.parse(
        contents,
      ) as Partial<LeaveRequestMutationUnknownLedgerEntry>;
    } catch {
      throw new Error('请休假幂等台账损坏，已停止提交以避免重复记录');
    }
    if (
      !value ||
      value.version !== 1 ||
      value.state !== 'unknown' ||
      value.clientMutationHash !==
        this.getLeaveRequestMutationLedgerKey(clientMutationId) ||
      typeof value.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
      value.reconcileOnly !== true ||
      typeof value.firstSeenAt !== 'number' ||
      !Number.isSafeInteger(value.firstSeenAt) ||
      value.firstSeenAt <= 0
    ) {
      throw new Error('请休假幂等台账损坏，已停止提交以避免重复记录');
    }
    return value as LeaveRequestMutationUnknownLedgerEntry;
  }

  private async loadDurableLeaveRequestUnknownMutation(
    clientMutationId: string,
    fingerprint: string,
  ): Promise<LeaveRequestMutationUnknownLedgerEntry | null> {
    if (!this.leaveRequestMutationLedgerDir) return null;
    let contents: string;
    try {
      contents = await readFile(
        this.getLeaveRequestMutationLedgerPath(clientMutationId),
        'utf8',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw new LeaveRequestAmbiguousWriteError(
        '请休假幂等状态暂时无法确认，已停止重复提交',
        error,
      );
    }
    let entry: LeaveRequestMutationUnknownLedgerEntry;
    try {
      entry = this.parseLeaveRequestUnknownLedgerEntry(
        contents,
        clientMutationId,
      );
    } catch (error) {
      throw new LeaveRequestAmbiguousWriteError(
        '请休假幂等状态暂时无法确认，已停止重复提交',
        error,
      );
    }
    if (entry.fingerprint !== fingerprint) {
      throw new BadRequestException(
        'clientMutationId 重复但请休假内容不同，请重新打开申请后提交',
      );
    }
    return entry;
  }

  private async persistLeaveRequestUnknownMutation(
    clientMutationId: string,
    fingerprint: string,
  ): Promise<void> {
    if (!this.leaveRequestMutationLedgerDir) return;
    await mkdir(this.leaveRequestMutationLedgerDir, { recursive: true });
    const entry: LeaveRequestMutationUnknownLedgerEntry = {
      version: 1,
      state: 'unknown',
      clientMutationHash:
        this.getLeaveRequestMutationLedgerKey(clientMutationId),
      fingerprint,
      reconcileOnly: true,
      firstSeenAt: Date.now(),
    };
    const contents = await this.persistImmutableLeaveRequestMutationLedgerFile(
      this.getLeaveRequestMutationLedgerPath(clientMutationId),
      `${JSON.stringify(entry)}\n`,
    );
    const persisted = this.parseLeaveRequestUnknownLedgerEntry(
      contents,
      clientMutationId,
    );
    if (persisted.fingerprint !== fingerprint) {
      throw new Error(
        '相同 clientMutationId 已有不同的请休假幂等台账，已停止提交',
      );
    }
  }

  private async persistImmutableLeaveRequestMutationLedgerFile(
    targetPath: string,
    contents: string,
  ): Promise<string> {
    const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await link(temporaryPath, targetPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw error;
        }
      });
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {
        this.logger.warn('请休假幂等台账临时文件清理失败');
      });
    }
    return readFile(targetPath, 'utf8');
  }

  private expireLeaveRequestPreparedWrite(
    entry: LeaveRequestMutationUnknownEntry,
    now: number,
  ): void {
    if (
      entry.preparedWriteExpiresAt === null ||
      entry.preparedWriteExpiresAt > now
    ) {
      return;
    }
    delete entry.replayState.preparedWrite;
    entry.replayState.reconcileOnly = true;
    entry.preparedWriteExpiresAt = null;
  }

  private validateOvertimeRequestScreenshot(
    screenshot?: ConstructionUploadFile,
  ): ConstructionUploadFile {
    if (!screenshot) {
      throw new BadRequestException('请上传加班举证截图');
    }
    try {
      return this.validateLeaveRequestScreenshot(screenshot);
    } catch (error) {
      if (!(error instanceof BadRequestException)) {
        throw error;
      }
      const response = error.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : typeof response === 'object' &&
              response !== null &&
              typeof (response as { message?: unknown }).message === 'string'
            ? (response as { message: string }).message
            : error.message;
      throw new BadRequestException(
        message
          .replace(
            /请通过流程截图字段上传附件/g,
            '请通过 screenshot 字段上传加班举证',
          )
          .replace(/流程截图/g, '加班举证截图'),
      );
    }
  }

  private buildOvertimeRequestMutationFingerprint(
    request: OvertimeRequestCreateRequest,
    screenshot?: ConstructionUploadFile,
  ): string {
    const payload = {
      staffName: this.normalizeDutyStaffRepairValue(request?.staffName || ''),
      startAt: request?.startAt || '',
      endAt: request?.endAt || '',
      reason: this.normalizeDutyStaffRepairValue(request?.reason || ''),
      expectedImpact: createOvertimeRequestImpactComparisonKey(
        request?.expectedImpact,
      ),
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload));
    if (screenshot) {
      hash.update('\0');
      hash.update(screenshot.originalname || '');
      hash.update('\0');
      hash.update(screenshot.mimetype || '');
      hash.update('\0');
      hash.update(String(screenshot.size));
      hash.update('\0');
      if (screenshot.buffer) {
        hash.update(screenshot.buffer);
      }
    }
    return hash.digest('hex');
  }

  private async resolveOvertimeRequestStaff(
    staffName: string,
  ): Promise<{ userId: string; shift: string }> {
    if (!this.hasBitableSourceConfig(this.leavePersonProfileConfig)) {
      throw new BadRequestException(
        `${this.leavePersonProfileConfig.tableName}多维表待配置`,
      );
    }
    const plan = resolvePersonProfileReadPlan('leave', {
      leaveTableId: this.leavePersonProfileConfig.tableId,
    });
    let records: BitableRecordItem[];
    try {
      const snapshot = await readLatestPersistedBitableRecordSnapshot({
        appToken: this.leavePersonProfileConfig.appToken || undefined,
        tableId: plan.tableId,
        viewId: plan.viewId,
        tableName: plan.tableName,
        fieldNames: plan.fieldNames,
      });
      if (!snapshot) {
        throw new Error('local overtime personnel snapshot missing');
      }
      records = snapshot.records;
    } catch (error) {
      throw this.createOvertimeRequestDefinitelyNotWrittenException(
        '本地人员资料缓存尚未准备完成，尚未建立加班记录，请稍后重试',
        error,
      );
    }

    const normalizedStaffName =
      this.normalizeDutyPersonNameForCompare(staffName);
    const matches = records.filter((record) => {
      const fields = record.fields || {};
      const userField = pickField(fields, ['员工姓名', '人员']);
      const names = [
        extractDisplayText(
          pickField(fields, ['姓名', '员工姓名', '人员', '人员（文本）']),
          ' ',
        ),
        this.extractFirstUserNameFromBitableField(userField) || '',
      ]
        .map((name) => this.normalizeDutyPersonNameForCompare(name))
        .filter(Boolean);
      return names.includes(normalizedStaffName);
    });
    if (matches.length === 0) {
      throw new BadRequestException(`加班人员资料中未找到“${staffName}”`);
    }
    if (matches.length > 1) {
      throw new BadRequestException(
        `加班人员资料中存在多个“${staffName}”，请先在人员表中完成去重`,
      );
    }
    const matchedFields = matches[0].fields || {};
    const userField = pickField(matchedFields, ['员工姓名', '人员']);
    if (!Array.isArray(userField) || userField.length !== 1) {
      throw new BadRequestException(`加班人员“${staffName}”的飞书账号必须唯一`);
    }
    const userName = this.extractFirstUserNameFromBitableField(userField);
    if (
      userName &&
      this.normalizeDutyPersonNameForCompare(userName) !== normalizedStaffName
    ) {
      throw new BadRequestException(
        `加班人员“${staffName}”的飞书账号与姓名不一致`,
      );
    }
    const userId = this.extractFirstUserIdFromBitableField(userField);
    if (!userId) {
      throw new BadRequestException(`加班人员“${staffName}”缺少飞书用户标识`);
    }
    const shift =
      ['班组', '班次', '班别', '值班班次']
        .map((fieldName) =>
          this.normalizeDutyStaffRepairValue(
            extractDisplayText(pickField(matchedFields, [fieldName]), ' '),
          ),
        )
        .find(Boolean) || '';
    if (!shift) {
      throw new BadRequestException(
        `加班人员“${staffName}”缺少班次信息，请先在人员表维护`,
      );
    }
    return { userId, shift };
  }

  private assertOvertimeRequestTableConfig(): void {
    if (!this.hasBitableSourceConfig(this.leaveSubstituteConfig)) {
      throw new BadRequestException(
        `${this.leaveSubstituteConfig.tableName}多维表待配置`,
      );
    }
    if (this.leaveSubstituteConfig.tableId !== OVERTIME_REQUEST_TABLE_ID) {
      throw new BadRequestException(
        `加班申请仅允许写入固定多维表 ${OVERTIME_REQUEST_TABLE_ID}`,
      );
    }
  }

  private toOvertimeRequestBitableClientToken(
    clientMutationId: string,
  ): string {
    const normalizedMutationId =
      this.normalizeDutyStaffRepairValue(clientMutationId);
    const digest = crypto
      .createHash('sha256')
      .update(`overtime-request-client-token:${normalizedMutationId}`)
      .digest();
    digest[6] = (digest[6] & 0x0f) | 0x40;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  }

  private async findPersistedOvertimeRequest(
    appToken: string,
    clientMutationId: string,
    fingerprint: string,
  ): Promise<{ recordId: string } | null> {
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: OVERTIME_REQUEST_TABLE_ID,
      tableName: this.leaveSubstituteConfig.tableName,
      fieldNames: ['请求唯一ID', '请求指纹', '加班开始时间'],
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: '请求唯一ID',
            operator: 'is',
            value: [clientMutationId],
          },
        ],
      },
      cacheTtlMs: 0,
      forceRefresh: true,
      strict: true,
    });
    if (records.length === 0) {
      return null;
    }
    if (records.length > 1) {
      throw new ConflictException({
        message: `加班多维表存在多个相同请求唯一ID“${clientMutationId}”，已停止写入`,
        writeDisposition: 'definitely-not-written',
      });
    }
    const record = records[0];
    const storedFingerprint = this.normalizeDutyStaffRepairValue(
      extractDisplayText(pickField(record.fields || {}, ['请求指纹']), ''),
    );
    if (!storedFingerprint || storedFingerprint !== fingerprint) {
      throw new ConflictException({
        message: 'clientMutationId 重复但加班内容不同，请重新打开申请后提交',
        writeDisposition: 'definitely-not-written',
      });
    }
    const startValue = pickField(record.fields || {}, ['加班开始时间']);
    if (
      startValue === undefined ||
      startValue === null ||
      (typeof startValue === 'string' && !startValue.trim())
    ) {
      throw new ConflictException({
        message: `加班请求唯一ID“${clientMutationId}”命中记录但加班开始时间为空`,
        writeDisposition: 'definitely-not-written',
      });
    }
    const recordId = getRecordId(record);
    if (!recordId) {
      throw new ConflictException({
        message: `加班请求唯一ID“${clientMutationId}”命中记录但缺少记录 ID`,
        writeDisposition: 'definitely-not-written',
      });
    }
    return { recordId };
  }

  private buildOvertimeRequestResponse(
    request: OvertimeRequestCreateRequest,
    clientMutationId: string,
    requestFingerprint: string,
    impact: OvertimeRequestImpact,
    recordId: string,
    created: 0 | 1,
  ): OvertimeRequestCreateResponse {
    const staffName = this.normalizeDutyStaffRepairValue(request.staffName);
    const strictImpact: OvertimeRequestImpact = {
      rawHours: impact.rawHours,
      payableHours: impact.payableHours,
      conflictingSchedules: impact.conflictingSchedules.map(
        ({ recordId, date, building, team, shift, overlapHours }) => ({
          recordId,
          date,
          building,
          team,
          shift,
          overlapHours,
        }),
      ),
      isWholeHour: impact.isWholeHour,
      invalidRangeReason: impact.invalidRangeReason,
      canSubmit: impact.canSubmit,
    };
    return {
      success: true,
      created,
      recordId,
      clientMutationId,
      requestFingerprint,
      impact: strictImpact,
      message:
        created === 1
          ? `加班申请已提交：${staffName}，${strictImpact.payableHours} 小时`
          : `加班申请已存在：${staffName}，${strictImpact.payableHours} 小时（已返回原记录）`,
    };
  }

  private toOvertimeRequestReplayResponse(
    response: OvertimeRequestCreateResponse,
  ): OvertimeRequestCreateResponse {
    if (response.created === 0) {
      return response;
    }
    return {
      ...response,
      created: 0,
      message: response.message.replace('已提交', '已存在'),
    };
  }

  private createOvertimeRequestDefinitelyNotWrittenException(
    message: string,
    cause?: unknown,
    safeDetails: {
      operationPhase?: 'attachment-upload';
      upstreamStatus?: number | 'unknown';
      bitableCode?: string | 'unknown';
    } = {},
  ): BadGatewayException {
    return Object.assign(
      new BadGatewayException({
        message,
        writeDisposition: 'definitely-not-written',
        ...safeDetails,
      }),
      cause === undefined ? safeDetails : { cause, ...safeDetails },
    );
  }

  private toOvertimeRequestAttachmentUploadException(
    error: unknown,
  ): BadGatewayException {
    const details = this.getLeaveRequestWriteErrorDetails(error);
    const upstreamStatus: number | 'unknown' =
      Number.isInteger(details.upstreamStatus) &&
      Number(details.upstreamStatus) >= 100 &&
      Number(details.upstreamStatus) <= 599
        ? (details.upstreamStatus as number)
        : 'unknown';
    const bitableCode = details.bitableCode ?? 'unknown';
    const safeDetails = {
      operationPhase: 'attachment-upload' as const,
      upstreamStatus,
      bitableCode,
    };
    this.logger.error(
      `加班附件上传失败：operationPhase=${safeDetails.operationPhase}, upstreamStatus=${safeDetails.upstreamStatus}, bitableCode=${safeDetails.bitableCode}`,
    );
    return this.createOvertimeRequestDefinitelyNotWrittenException(
      '加班举证上传失败，尚未建立加班记录，请稍后重试',
      error,
      safeDetails,
    );
  }

  private toOvertimeRequestAmbiguousWriteError(
    error: unknown,
  ): OvertimeRequestAmbiguousWriteError | null {
    if (error instanceof OvertimeRequestAmbiguousWriteError) {
      return error;
    }
    const detected = this.toLeaveRequestAmbiguousWriteError(error);
    return detected
      ? new OvertimeRequestAmbiguousWriteError(
          '加班写入结果未知，请使用原申请标识安全重试',
          error,
        )
      : null;
  }

  private toOvertimeRequestRejectedWriteException(
    error: unknown,
    clientMutationId: string,
  ): BadGatewayException {
    const details = this.getLeaveRequestWriteErrorDetails(error);
    const requestRef = crypto
      .createHash('sha256')
      .update(clientMutationId)
      .digest('hex')
      .slice(0, 12);
    this.logger.error(
      `加班记录创建被飞书拒绝：requestRef=${requestRef}, upstreamStatus=${details.upstreamStatus ?? 'unknown'}, bitableCode=${details.bitableCode ?? 'unknown'}`,
    );
    const codeSuffix = details.bitableCode
      ? `（飞书错误码 ${details.bitableCode}）`
      : '';
    return Object.assign(
      this.createOvertimeRequestDefinitelyNotWrittenException(
        `加班提交失败，飞书未建立记录${codeSuffix}`,
        error,
      ),
      {
        upstreamStatus: details.upstreamStatus,
        bitableCode: details.bitableCode,
      },
    );
  }

  private withOvertimeRequestMutationIdempotency(
    clientMutationId: string,
    request: OvertimeRequestCreateRequest,
    screenshot: ConstructionUploadFile,
    operation: (
      replayState: OvertimeRequestMutationReplayState,
    ) => Promise<OvertimeRequestCreateResponse>,
    reconcile: () => Promise<OvertimeRequestCreateResponse | null>,
  ): Promise<OvertimeRequestCreateResponse> {
    const now = Date.now();
    for (const [key, entry] of this.overtimeRequestMutationCompleted) {
      if (entry.expiresAt <= now) {
        this.overtimeRequestMutationCompleted.delete(key);
      }
    }
    const fingerprint = this.buildOvertimeRequestMutationFingerprint(
      request,
      screenshot,
    );
    const conflictError = () =>
      new ConflictException({
        message: 'clientMutationId 重复但加班内容不同，请重新打开申请后提交',
        writeDisposition: 'definitely-not-written',
      });
    const completed =
      this.overtimeRequestMutationCompleted.get(clientMutationId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      return Promise.resolve(
        this.toOvertimeRequestReplayResponse(completed.response),
      );
    }
    const inFlight = this.overtimeRequestMutationInFlight.get(clientMutationId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      return inFlight.promise.then((response) =>
        this.toOvertimeRequestReplayResponse(response),
      );
    }
    const unknown = this.overtimeRequestMutationUnknown.get(clientMutationId);
    if (unknown) {
      if (unknown.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      const recovery = Promise.resolve()
        .then(reconcile)
        .then((response) => {
          if (response) {
            return response;
          }
          if (
            !unknown.replayState.reconcileOnly &&
            !unknown.replayState.preparedWrite?.reconcileOnly
          ) {
            return operation(unknown.replayState);
          }
          throw new OvertimeRequestAmbiguousWriteError(
            '加班写入结果未知，请使用原申请标识安全重试',
            undefined,
          );
        })
        .catch((error) => {
          if (error instanceof ConflictException) {
            throw error;
          }
          throw new OvertimeRequestAmbiguousWriteError(
            '加班写入结果未知，请使用原申请标识安全重试',
            error,
          );
        });
      return this.trackOvertimeRequestMutation(
        clientMutationId,
        fingerprint,
        recovery,
        unknown.replayState,
      );
    }

    const replayState: OvertimeRequestMutationReplayState = {};
    const current = Promise.resolve()
      .then(() =>
        this.loadDurableOvertimeRequestUnknownMutation(
          clientMutationId,
          fingerprint,
        ),
      )
      .catch((error) => {
        replayState.reconcileOnly = true;
        throw error;
      })
      .then(async (durableUnknown) => {
        if (!durableUnknown) {
          return operation(replayState);
        }
        replayState.reconcileOnly = false;
        this.rememberOvertimeRequestUnknownMutation(
          clientMutationId,
          fingerprint,
          replayState,
        );
        let response: OvertimeRequestCreateResponse | null;
        try {
          response = await reconcile();
        } catch (error) {
          if (error instanceof ConflictException) {
            throw error;
          }
          throw new OvertimeRequestAmbiguousWriteError(
            '加班写入结果未知，请使用原申请标识安全重试',
            error,
          );
        }
        if (response) {
          return response;
        }
        return operation(replayState);
      });
    return this.trackOvertimeRequestMutation(
      clientMutationId,
      fingerprint,
      current,
      replayState,
    );
  }

  private trackOvertimeRequestMutation(
    clientMutationId: string,
    fingerprint: string,
    current: Promise<OvertimeRequestCreateResponse>,
    replayState: OvertimeRequestMutationReplayState,
  ): Promise<OvertimeRequestCreateResponse> {
    const tracked = current
      .then(async (response) => {
        await this.clearOvertimeRequestUnknownMutationLedger(clientMutationId);
        return response;
      })
      .catch(async (error: unknown) => {
        if (error instanceof OvertimeRequestAmbiguousWriteError) {
          this.rememberOvertimeRequestUnknownMutation(
            clientMutationId,
            fingerprint,
            replayState,
          );
          try {
            await this.persistOvertimeRequestUnknownMutation(
              clientMutationId,
              fingerprint,
            );
          } catch {
            this.logger.error(
              '加班未知写入状态落盘失败，已保留当前进程内的防重状态',
            );
          }
        }
        throw error;
      });
    this.overtimeRequestMutationInFlight.set(clientMutationId, {
      fingerprint,
      promise: tracked,
    });
    void tracked.then(
      (response) => {
        if (
          this.overtimeRequestMutationInFlight.get(clientMutationId)
            ?.promise === tracked
        ) {
          this.overtimeRequestMutationInFlight.delete(clientMutationId);
        }
        this.overtimeRequestMutationUnknown.delete(clientMutationId);
        this.overtimeRequestMutationCompleted.set(clientMutationId, {
          expiresAt: Date.now() + OVERTIME_REQUEST_MUTATION_COMPLETED_TTL_MS,
          fingerprint,
          response,
        });
        while (
          this.overtimeRequestMutationCompleted.size >
          OVERTIME_REQUEST_MUTATION_COMPLETED_MAX_ENTRIES
        ) {
          const oldestKey = this.overtimeRequestMutationCompleted.keys().next()
            .value as string | undefined;
          if (!oldestKey) break;
          this.overtimeRequestMutationCompleted.delete(oldestKey);
        }
      },
      () => {
        if (
          this.overtimeRequestMutationInFlight.get(clientMutationId)
            ?.promise === tracked
        ) {
          this.overtimeRequestMutationInFlight.delete(clientMutationId);
        }
      },
    );
    return tracked;
  }

  private rememberOvertimeRequestUnknownMutation(
    clientMutationId: string,
    fingerprint: string,
    replayState: OvertimeRequestMutationReplayState = {},
  ): void {
    if (replayState.preparedWrite?.reconcileOnly) {
      delete replayState.preparedWrite;
      replayState.reconcileOnly = false;
    } else if (
      !replayState.preparedWrite &&
      replayState.reconcileOnly === undefined
    ) {
      replayState.reconcileOnly = false;
    }
    this.overtimeRequestMutationUnknown.delete(clientMutationId);
    this.overtimeRequestMutationUnknown.set(clientMutationId, {
      fingerprint,
      replayState,
    });
    while (
      this.overtimeRequestMutationUnknown.size >
      OVERTIME_REQUEST_MUTATION_UNKNOWN_MAX_ENTRIES
    ) {
      const oldestKey = this.overtimeRequestMutationUnknown.keys().next()
        .value as string | undefined;
      if (!oldestKey) break;
      this.overtimeRequestMutationUnknown.delete(oldestKey);
    }
  }

  private getOvertimeRequestMutationLedgerKey(
    clientMutationId: string,
  ): string {
    return crypto
      .createHash('sha256')
      .update(`overtime-request:${clientMutationId}`)
      .digest('hex');
  }

  private getOvertimeRequestMutationLedgerPath(
    clientMutationId: string,
  ): string {
    return join(
      this.overtimeRequestMutationLedgerDir,
      `${this.getOvertimeRequestMutationLedgerKey(clientMutationId)}.json`,
    );
  }

  private parseOvertimeRequestUnknownLedgerEntry(
    contents: string,
    clientMutationId: string,
  ): OvertimeRequestMutationUnknownLedgerEntry {
    let value: Partial<OvertimeRequestMutationUnknownLedgerEntry> | undefined;
    try {
      value = JSON.parse(
        contents,
      ) as Partial<OvertimeRequestMutationUnknownLedgerEntry>;
    } catch {
      throw new Error('加班幂等台账损坏，已停止提交以避免重复记录');
    }
    if (
      !value ||
      value.version !== 1 ||
      value.namespace !== 'overtime-request' ||
      value.state !== 'unknown' ||
      value.clientMutationHash !==
        this.getOvertimeRequestMutationLedgerKey(clientMutationId) ||
      typeof value.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
      value.reconcileOnly !== true ||
      typeof value.firstSeenAt !== 'number' ||
      !Number.isSafeInteger(value.firstSeenAt) ||
      value.firstSeenAt <= 0
    ) {
      throw new Error('加班幂等台账损坏，已停止提交以避免重复记录');
    }
    return value as OvertimeRequestMutationUnknownLedgerEntry;
  }

  private async loadDurableOvertimeRequestUnknownMutation(
    clientMutationId: string,
    fingerprint: string,
  ): Promise<OvertimeRequestMutationUnknownLedgerEntry | null> {
    if (!this.overtimeRequestMutationLedgerDir) return null;
    let contents: string;
    try {
      contents = await readFile(
        this.getOvertimeRequestMutationLedgerPath(clientMutationId),
        'utf8',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw new OvertimeRequestAmbiguousWriteError(
        '加班幂等状态暂时无法确认，已停止重复提交',
        error,
      );
    }
    let entry: OvertimeRequestMutationUnknownLedgerEntry;
    try {
      entry = this.parseOvertimeRequestUnknownLedgerEntry(
        contents,
        clientMutationId,
      );
    } catch (error) {
      throw new OvertimeRequestAmbiguousWriteError(
        '加班幂等状态暂时无法确认，已停止重复提交',
        error,
      );
    }
    if (entry.fingerprint !== fingerprint) {
      throw new ConflictException({
        message: 'clientMutationId 重复但加班内容不同，请重新打开申请后提交',
        writeDisposition: 'definitely-not-written',
      });
    }
    return entry;
  }

  private async persistOvertimeRequestUnknownMutation(
    clientMutationId: string,
    fingerprint: string,
  ): Promise<void> {
    if (!this.overtimeRequestMutationLedgerDir) return;
    await mkdir(this.overtimeRequestMutationLedgerDir, { recursive: true });
    const entry: OvertimeRequestMutationUnknownLedgerEntry = {
      version: 1,
      namespace: 'overtime-request',
      state: 'unknown',
      clientMutationHash:
        this.getOvertimeRequestMutationLedgerKey(clientMutationId),
      fingerprint,
      reconcileOnly: true,
      firstSeenAt: Date.now(),
    };
    const targetPath =
      this.getOvertimeRequestMutationLedgerPath(clientMutationId);
    const contents = await this.persistImmutableOvertimeRequestLedgerFile(
      targetPath,
      `${JSON.stringify(entry)}\n`,
    );
    const persisted = this.parseOvertimeRequestUnknownLedgerEntry(
      contents,
      clientMutationId,
    );
    if (persisted.fingerprint !== fingerprint) {
      throw new Error(
        '相同 clientMutationId 已有不同的加班幂等台账，已停止提交',
      );
    }
  }

  private async clearOvertimeRequestUnknownMutationLedger(
    clientMutationId: string,
  ): Promise<void> {
    if (!this.overtimeRequestMutationLedgerDir) return;
    try {
      await rm(this.getOvertimeRequestMutationLedgerPath(clientMutationId), {
        force: true,
      });
    } catch {
      this.logger.warn('加班幂等未知状态清理失败，将在后续成功请求中重试');
    }
  }

  private async persistImmutableOvertimeRequestLedgerFile(
    targetPath: string,
    contents: string,
  ): Promise<string> {
    const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await link(temporaryPath, targetPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw error;
        }
      });
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {
        this.logger.warn('加班幂等台账临时文件清理失败');
      });
    }
    return readFile(targetPath, 'utf8');
  }

  private async readChangeRequestSubmitterRecords(): Promise<BitableRecordItem[]> {
    if (!this.hasBitableSourceConfig(this.leavePersonProfileConfig)) {
      throw new BadRequestException(
        `${this.leavePersonProfileConfig.tableName}多维表待配置`,
      );
    }
    const plan = resolvePersonProfileReadPlan('leave', {
      leaveTableId: this.leavePersonProfileConfig.tableId,
    });
    let records: BitableRecordItem[];
    try {
      let snapshot = await readLatestPersistedBitableRecordSnapshot({
        appToken: this.leavePersonProfileConfig.appToken || undefined,
        tableId: plan.tableId,
        viewId: plan.viewId,
        tableName: plan.tableName,
        fieldNames: plan.fieldNames,
      });
      if (!snapshot) {
        const detailPlan = resolvePersonProfileDetailReadPlan('leave', {
          leaveTableId: this.leavePersonProfileConfig.tableId,
        });
        snapshot = await readLatestPersistedBitableRecordSnapshot({
          appToken: this.leavePersonProfileConfig.appToken || undefined,
          tableId: detailPlan.tableId,
          viewId: detailPlan.viewId,
          tableName: detailPlan.tableName,
          fieldNames: detailPlan.fieldNames,
        });
      }
      if (!snapshot) {
        throw new Error('local change-request personnel snapshot missing');
      }
      records = snapshot.records;
    } catch {
      this.logger.warn('变更申请本地人员资料快照不可用');
      throw new ServiceUnavailableException(
        '本地人员资料缓存尚未准备完成，尚未建立变更申请，请稍后重试',
      );
    }

    return records;
  }

  private async readActiveChangeRequestUserIds(): Promise<Set<string>> {
    const snapshot = await readLatestPersistedBitableRecordSnapshot({
      appToken: readEnv('FEISHU_ORG_APP_TOKEN', ['FEISHU_ORGANIZATION_APP_TOKEN']) || undefined,
      tableId: readEnv('FEISHU_ORG_TABLE_ID', ['FEISHU_ORGANIZATION_TABLE_ID']) || DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
      viewId: readEnv('FEISHU_ORG_VIEW_ID', ['FEISHU_ORGANIZATION_VIEW_ID']) || DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
      tableName: '在职人员',
    });
    if (!snapshot) throw new ServiceUnavailableException('在职人员缓存尚未就绪，请稍后重试');
    return new Set(buildActivePersonnelDirectory(snapshot).personnel.map((person) => person.openId));
  }

  async searchChangeRequestPeople(query: string) {
    const normalized = String(query || '').replace(/\s+/g, '').toLocaleLowerCase();
    if (!normalized) return { people: [], snapshotAt: Date.now() };
    if (normalized.length > 64) throw new BadRequestException('姓名搜索最多 64 个字符');
    const [records, activeIds] = await Promise.all([
      this.readChangeRequestSubmitterRecords(), this.readActiveChangeRequestUserIds(),
    ]);
    const people = listChangeRequestSubmitters(records, activeIds).filter((person) =>
      person.name.replace(/\s+/g, '').toLocaleLowerCase().includes(normalized)
    ).slice(0, 20);
    return { people, snapshotAt: Date.now() };
  }

  private async resolveChangeRequestSubmitter(
    submitterName: string,
    submitterId?: string,
  ): Promise<{ userId: string }> {
    const records = await this.readChangeRequestSubmitterRecords();
    const resolution = resolveChangeRequestSubmitterCandidate(
      records,
      submitterName,
      submitterId,
    );
    if (resolution.ok === true) {
      if (submitterId && !(await this.readActiveChangeRequestUserIds()).has(resolution.userId)) {
        throw new BadRequestException('提交人已不在在职人员名单，请重新选择');
      }
      return { userId: resolution.userId };
    }
    if (resolution.reason === 'identity-mismatch') {
      throw new BadRequestException('提交人身份与人员资料不一致，请重新搜索选择');
    }
    if (resolution.reason === 'not-found') {
      throw new BadRequestException(
        `人员资料中未找到变更提交人“${submitterName}”`,
      );
    }
    if (resolution.reason === 'duplicate') {
      throw new BadRequestException(
        `人员资料中存在多个变更提交人“${submitterName}”，请先在人员表中完成去重`,
      );
    }
    if (resolution.reason === 'account-count') {
      throw new BadRequestException(
        `变更提交人“${submitterName}”的飞书账号必须唯一`,
      );
    }
    if (resolution.reason === 'account-name-mismatch') {
      throw new BadRequestException(
        `变更提交人“${submitterName}”的飞书账号与姓名不一致`,
      );
    }
    throw new BadRequestException(
      `变更提交人“${submitterName}”缺少飞书用户标识`,
    );
  }

  async createChangeAdjustment(
    request: ChangeAdjustmentRequest,
  ): Promise<ChangeAdjustmentResponse> {
    const adjustmentService = this.changeAdjustmentService;
    const storage = this.changeAttachmentStorage;
    if (!adjustmentService) {
      throw new ServiceUnavailableException('变更调整服务尚未配置');
    }
    if (!storage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    const recordId = String(request?.recordId || '').trim();
    this.assertSafeChangeRecordAttachmentIdentity(recordId);
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }

    const deadlineAt = Date.now() + CHANGE_REQUEST_SYNC_DEADLINE_MS;
    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, {
        ...this.calendarChangeConfig,
        requestTimeoutMs: (stage) =>
          this.getChangeRequestBoundedAxiosTimeout(deadlineAt, stage),
        waitFor: (promise, stage) =>
          this.waitWithinChangeRequestDeadline(promise, deadlineAt, stage),
        waitBeforeRetry: (delayMs, stage) =>
          this.sleepWithinChangeRequestDeadline(delayMs, deadlineAt, stage),
      }),
      this.getFeishuTenantAccessToken(deadlineAt),
    ]);

    const readRecordStrict = async (targetRecordId: string) => {
      this.assertSafeChangeRecordAttachmentIdentity(targetRecordId);
      const record = await this.fetchBitableRecordById(
        appToken,
        this.calendarChangeConfig.tableId,
        this.calendarChangeConfig.tableName,
        targetRecordId,
        tenantAccessToken,
        deadlineAt,
      );
      if (!record) return null;
      const publicRecord = this.mapFeishuCalendarChangeRecord(record);
      if (!publicRecord) {
        throw new BadRequestException('变更记录缺少标题或计划时间');
      }
      return mapChangeAdjustmentRecordSnapshot(record, publicRecord, {
        resolveStorage: async ({ recordId: boundRecordId, fileToken }) => {
          const metadata =
            await storage.findByFileTokenForTrustedServer(fileToken);
          if (!metadata || metadata.boundRecordId !== boundRecordId) {
            return null;
          }
          return {
            id: metadata.id,
            filePath: metadata.filePath,
            bucketId: metadata.bucketId,
            url: metadata.url,
          };
        },
      });
    };

    const response = await this.changeAdjustmentService.execute(request, {
      readRecordStrict,
      updateRecord: async (targetRecordId, fields) => {
        this.assertSafeChangeRecordAttachmentIdentity(targetRecordId);
        await this.updateBitableRecordFields(
          appToken,
          this.calendarChangeConfig.tableId,
          this.calendarChangeConfig.tableName,
          targetRecordId,
          fields,
          tenantAccessToken,
        );
      },
      resolveOwnedStorage: (id, ownerMutationId) =>
        storage.resolveOwned(id, ownerMutationId),
      uploadToBitable: async ({ file, clientMutationId }) =>
        this.uploadStagedChangeRequestAttachment(
          tenantAccessToken,
          appToken,
          this.toChangeRequestUploadFile(file),
          clientMutationId,
          deadlineAt,
        ),
      bindStorageToRecord: async ({
        id,
        recordId: boundRecordId,
        fileToken,
        ownerMutationId,
      }) => {
        await storage.bindToRecord(id, boundRecordId, fileToken, {
          ownerMutationId,
        });
      },
      findBoundStorageByFileToken: (fileToken) =>
        storage.findByFileTokenForTrustedServer(fileToken),
      deleteBoundStorage: async ({
        id,
        recordId: boundRecordId,
        fileToken,
      }) => {
        const current =
          await storage.findByFileTokenForTrustedServer(fileToken);
        if (!current) return;
        if (
          current.id !== id ||
          current.fileToken !== fileToken ||
          current.boundRecordId !== boundRecordId
        ) {
          throw new ConflictException('待删除附件与变更记录归属不一致');
        }
        await storage.deleteForTrustedServer(id);
      },
    });
    invalidateBitableRecordCache({
      appToken,
      tableId: this.calendarChangeConfig.tableId,
    });
    return response;
  }

  async createChangeDrillReport(
    request: ChangeDrillReportCreateRequest,
  ): Promise<ChangeDrillReportCreateResponse> {
    const reportService = this.changeDrillReportService;
    const storage = this.changeAttachmentStorage;
    if (!reportService) {
      throw new ServiceUnavailableException('演练报告服务尚未配置');
    }
    if (!storage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }

    const deadlineAt = Date.now() + CHANGE_REQUEST_SYNC_DEADLINE_MS;
    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, {
        ...this.calendarChangeConfig,
        requestTimeoutMs: (stage) =>
          this.getChangeRequestBoundedAxiosTimeout(deadlineAt, stage),
        waitFor: (promise, stage) =>
          this.waitWithinChangeRequestDeadline(promise, deadlineAt, stage),
        waitBeforeRetry: (delayMs, stage) =>
          this.sleepWithinChangeRequestDeadline(delayMs, deadlineAt, stage),
      }),
      this.getFeishuTenantAccessToken(deadlineAt),
    ]);

    const parsePersistedReport = (
      record: BitableRecordItem,
    ): PersistedChangeDrillReportSnapshot | null => {
      const fields = record.fields || {};
      const recordId = getRecordId(record);
      const clientMutationId = extractDisplayText(
        pickField(fields, ['演练提交请求唯一ID']),
        '',
      ).trim();
      const fingerprint = extractDisplayText(
        pickField(fields, ['演练提交请求指纹']),
        '',
      ).trim();
      const changeRecordId = this.extractLinkedBitableRecordId(
        pickField(fields, ['变更关联']),
      );
      if (!recordId || !clientMutationId || !fingerprint || !changeRecordId) {
        return null;
      }
      return {
        recordId,
        clientMutationId,
        fingerprint,
        changeRecordId,
        buildings: extractDisplayValues(pickField(fields, ['演练楼栋']))
          .map((value) => value.trim())
          .filter(Boolean),
        reportFileTokens: this.extractBitableAttachmentTokens(
          pickField(fields, [CHANGE_DRILL_REPORT_ATTACHMENT_FIELD_NAME]),
        ),
      };
    };

    const findReportByMutationId = async (clientMutationId: string) => {
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: this.changeDrillReportTableId,
        tableName: this.changeDrillReportTableName,
        fieldNames: [
          '变更关联',
          CHANGE_DRILL_REPORT_ATTACHMENT_FIELD_NAME,
          '演练楼栋',
          '演练提交请求唯一ID',
          '演练提交请求指纹',
        ],
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '演练提交请求唯一ID',
              operator: 'is',
              value: [clientMutationId],
            },
          ],
        },
        cacheTtlMs: 0,
        forceRefresh: true,
        strict: true,
      });
      if (records.length === 0) return null;
      if (records.length > 1) {
        throw new ConflictException(
          `演练报告多维表存在多个相同请求唯一ID“${clientMutationId}”，已停止写入`,
        );
      }
      const persisted = parsePersistedReport(records[0]);
      if (!persisted) {
        throw new ConflictException(
          `演练报告请求唯一ID“${clientMutationId}”命中记录但关键字段不完整`,
        );
      }
      return persisted;
    };

    const response = await reportService.execute(request, {
      readChangeStrict: async (recordId) => {
        this.assertSafeChangeRecordAttachmentIdentity(recordId);
        const record = await this.fetchBitableRecordById(
          appToken,
          this.calendarChangeConfig.tableId,
          this.calendarChangeConfig.tableName,
          recordId,
          tenantAccessToken,
          deadlineAt,
        );
        if (!record) return null;
        const publicRecord = this.mapFeishuCalendarChangeRecord(record);
        if (!publicRecord) {
          throw new BadRequestException('变更记录缺少标题或计划时间');
        }
        const snapshot = await mapChangeAdjustmentRecordSnapshot(
          record,
          publicRecord,
        );
        if (!snapshot) {
          throw new BadRequestException('变更记录关键字段不完整');
        }
        return {
          recordId: snapshot.recordId,
          level: publicRecord.level,
          lifecycleStatus: this.resolveChangeDrillReportLifecycle(snapshot),
          buildings: [...publicRecord.buildings],
        };
      },
      findReportByMutationId,
      resolveOwnedStorage: (id, ownerMutationId) =>
        storage.resolveOwned(id, ownerMutationId),
      uploadToBitable: async ({ file, clientMutationId }) =>
        this.uploadStagedChangeRequestAttachment(
          tenantAccessToken,
          appToken,
          this.toChangeRequestUploadFile(file),
          clientMutationId,
          deadlineAt,
        ),
      createReport: async (input) => {
        const reportRecordId = await this.createBitableRecord(
          appToken,
          this.changeDrillReportTableId,
          this.changeDrillReportTableName,
          {
            变更关联: [input.changeRecordId],
            [CHANGE_DRILL_REPORT_ATTACHMENT_FIELD_NAME]:
              input.reportFileTokens.map((fileToken) => ({
                file_token: fileToken,
              })),
            演练楼栋: [...input.buildings],
            演练提交请求唯一ID: input.clientMutationId,
            演练提交请求指纹: input.fingerprint,
          },
          tenantAccessToken,
          {
            clientToken: input.clientToken,
            retryNetworkErrors: true,
            deadlineAt,
          },
        );
        const saved = await this.fetchBitableRecordById(
          appToken,
          this.changeDrillReportTableId,
          this.changeDrillReportTableName,
          reportRecordId,
          tenantAccessToken,
          deadlineAt,
        );
        const persisted = saved ? parsePersistedReport(saved) : null;
        if (!persisted) {
          throw new ServiceUnavailableException(
            '演练报告已写入但严格回读校验失败，请使用原请求重试',
          );
        }
        reportService.assertPersistedReportMatches(
          persisted,
          {
            ...request,
            clientMutationId: input.clientMutationId,
            changeRecordId: input.changeRecordId,
            buildings: [
              ...input.buildings,
            ] as ChangeDrillReportCreateRequest['buildings'],
          },
          input.fingerprint,
          input.reportFileTokens,
        );
        return reportRecordId;
      },
      bindStorageToRecord: async ({
        id,
        recordId,
        fileToken,
        ownerMutationId,
      }) => {
        await storage.bindToRecord(id, recordId, fileToken, {
          ownerMutationId,
        });
      },
    });
    invalidateBitableRecordCache({
      appToken,
      tableId: this.changeDrillReportTableId,
    });
    invalidateBitableRecordCache({
      appToken,
      tableId: this.calendarChangeConfig.tableId,
    });
    return response;
  }

  async createChangeSummaryReport(
    request: ChangeSummaryReportCreateRequest,
    ownerFingerprint: string,
    principal?: AccessPrincipal,
  ): Promise<ChangeSummaryReportCreateResponse> {
    if (isPersonalAccessAccount(principal)) {
      request = { ...request, submitterName: bindSelfServiceApplicant(request.submitterName || '', principal, true, '提交变更总结') };
      await this.resolveLeaveRequestStaff(request.submitterName, undefined, principal);
    }
    const reportService = this.changeSummaryReportService;
    if (!reportService) {
      throw new ServiceUnavailableException('变更总结服务尚未配置');
    }
    if (!this.changeAttachmentStorage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }
    return reportService.enqueue(
      request,
      this.createChangeSummaryReportPorts(reportService),
      ownerFingerprint,
    );
  }

  async getChangeSummaryReportSyncStatus(
    taskId: string,
    ownerFingerprint: string,
  ): Promise<ChangeSummaryReportSyncTaskResponse> {
    const reportService = this.changeSummaryReportService;
    if (!reportService) {
      throw new ServiceUnavailableException('变更总结服务尚未配置');
    }
    return reportService.getStatus(
      taskId,
      this.createChangeSummaryReportPorts(reportService),
      ownerFingerprint,
    );
  }

  async abandonChangeSummaryReport(
    request: ChangeSummaryReportAbandonRequest,
    ownerFingerprint: string,
  ): Promise<ChangeSummaryReportAbandonResponse> {
    const reportService = this.changeSummaryReportService;
    if (!reportService) {
      throw new ServiceUnavailableException('变更总结服务尚未配置');
    }
    return reportService.abandon(
      request,
      ownerFingerprint,
      this.createChangeSummaryReportPorts(reportService),
    );
  }

  async cleanupChangeSummarySelfTestBoundAttachment(
    request: ChangeSummaryReportSelfTestCleanupRequest,
    proof: string,
  ): Promise<ChangeSummaryReportSelfTestCleanupResponse> {
    const reportService = this.changeSummaryReportService;
    const storage = this.changeAttachmentStorage;
    if (!reportService) {
      throw new ServiceUnavailableException('变更总结服务尚未配置');
    }
    if (!storage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    const executionPorts = this.createChangeSummaryReportPorts(reportService);
    const cleanupPorts: ChangeSummaryReportCleanupPorts = {
      readChangeStrict: executionPorts.readChangeStrict,
      readReportStrict: executionPorts.readReportStrict,
      findBoundStorageForTrustedSelfTest: (objectId) =>
        storage.findBoundByIdForTrustedSelfTest(objectId),
      deleteBoundStorageForTrustedSelfTest: (expectation) =>
        storage.deleteBoundForTrustedSelfTest(expectation),
      scrubChangeRequestSelfTestLedger: async (input) => {
        if (!this.changeRequestMutationLedgerDir) {
          throw new ServiceUnavailableException(
            '变更申请幂等台账未配置，拒绝自测脱敏',
          );
        }
        await scrubChangeRequestSelfTestLedgerDirectory({
          ledgerDir: this.changeRequestMutationLedgerDir,
          ...input,
        });
      },
    };
    return reportService.cleanupBoundAttachment(request, proof, cleanupPorts);
  }

  async finalizeFailedChangeSummarySelfTestCleanup(
    request: FailedChangeSummarySelfTestCleanupRequest,
    proof: string,
  ): Promise<{
    success: true;
    alreadyFinalized: boolean;
    changeRequestAlreadyScrubbed: boolean;
  }> {
    const reportService = this.changeSummaryReportService;
    const storage = this.changeAttachmentStorage;
    if (!reportService) {
      throw new ServiceUnavailableException('变更总结服务尚未配置');
    }
    if (!storage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    if (!this.changeRequestMutationLedgerDir) {
      throw new ServiceUnavailableException(
        '变更申请幂等台账未配置，拒绝自测脱敏',
      );
    }
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }

    const cleanupSecret = String(
      process.env.LOCAL_ACCESS_SESSION_SECRET ||
        process.env.LOCAL_ADMIN_SESSION_SECRET ||
        '',
    ).trim();
    const deadlineAt = Date.now() + CHANGE_REQUEST_SYNC_DEADLINE_MS;
    let contextPromise:
      | Promise<{ appToken: string; tenantAccessToken: string }>
      | undefined;
    const getContext = () => {
      if (!contextPromise) {
        contextPromise = Promise.all([
          resolveBitableAppToken(this.httpService, {
            ...this.calendarChangeConfig,
            requestTimeoutMs: (stage) =>
              this.getChangeRequestBoundedAxiosTimeout(deadlineAt, stage),
            waitFor: (promise, stage) =>
              this.waitWithinChangeRequestDeadline(promise, deadlineAt, stage),
            waitBeforeRetry: (delayMs, stage) =>
              this.sleepWithinChangeRequestDeadline(delayMs, deadlineAt, stage),
          }),
          this.getFeishuTenantAccessToken(deadlineAt),
        ]).then(([appToken, tenantAccessToken]) => ({
          appToken,
          tenantAccessToken,
        }));
      }
      return contextPromise;
    };
    const countExact = async (
      tableId: string,
      tableName: string,
      fieldNames: string[],
      fieldName: string,
      value: string,
    ): Promise<number> => {
      const { appToken } = await getContext();
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        tableName,
        fieldNames,
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: fieldName, operator: 'is', value: [value] },
          ],
        },
        cacheTtlMs: 0,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      });
      return records.length;
    };

    const result = await finalizeFailedChangeSummarySelfTestCleanupAfterProof(
      request,
      proof,
      cleanupSecret,
      {
        readChangeRecordExact: async (recordId) => {
          const { appToken, tenantAccessToken } = await getContext();
          return this.fetchBitableRecordByIdWithDisplayValues(
            appToken,
            this.calendarChangeConfig.tableId,
            this.calendarChangeConfig.tableName,
            recordId,
            tenantAccessToken,
            deadlineAt,
          );
        },
        countChangeRecordsBySummaryMarker: (summaryMarker) =>
          countExact(
            this.calendarChangeConfig.tableId,
            this.calendarChangeConfig.tableName,
            ['变更简述'],
            '变更简述',
            summaryMarker,
          ),
        countSummaryReportsByMutationId: (clientMutationId) =>
          countExact(
            this.changeDrillReportTableId,
            this.changeDrillReportTableName,
            ['变更总结请求唯一ID'],
            '变更总结请求唯一ID',
            clientMutationId,
          ),
        countSummaryReportsByChangeRecordId: (changeRecordId) =>
          countExact(
            this.changeDrillReportTableId,
            this.changeDrillReportTableName,
            ['变更关联'],
            '变更关联',
            changeRecordId,
          ),
        getObjectDeletionState: (objectId) =>
          storage.getDeletionStateForTrustedServer(objectId),
        finalizeLedgers: (normalized) =>
          finalizeFailedChangeSummarySelfTestLedgers({
            summaryLedgerDir:
              reportService.getMutationLedgerDirectoryForTrustedSelfTest(),
            changeRequestLedgerDir: this.changeRequestMutationLedgerDir,
            clientMutationId: normalized.clientMutationId,
            changeRequestMutationId: normalized.changeRequestMutationId,
            changeRecordId: normalized.changeRecordId,
            summaryMarker: normalized.summaryMarker,
            fingerprint: normalized.summaryFingerprint,
            changeObjectIds: normalized.changeObjectIds,
            summaryObjectIds: normalized.summaryObjectIds,
          }),
      },
    );
    return { success: true, ...result };
  }

  private createChangeSummaryReportPorts(
    reportService: ChangeSummaryReportService,
  ): ChangeSummaryReportExecutionPorts & ChangeSummaryReportAbandonPorts {
    const storage = this.changeAttachmentStorage;
    if (!storage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    let contextPromise:
      | Promise<{
          appToken: string;
          tenantAccessToken: string;
          deadlineAt: number;
        }>
      | undefined;
    const getContext = () => {
      if (!contextPromise) {
        const deadlineAt = Date.now() + CHANGE_REQUEST_SYNC_DEADLINE_MS;
        contextPromise = Promise.all([
          resolveBitableAppToken(this.httpService, {
            ...this.calendarChangeConfig,
            requestTimeoutMs: (stage) =>
              this.getChangeRequestBoundedAxiosTimeout(deadlineAt, stage),
            waitFor: (promise, stage) =>
              this.waitWithinChangeRequestDeadline(promise, deadlineAt, stage),
            waitBeforeRetry: (delayMs, stage) =>
              this.sleepWithinChangeRequestDeadline(delayMs, deadlineAt, stage),
          }),
          this.getFeishuTenantAccessToken(deadlineAt),
        ]).then(([appToken, tenantAccessToken]) => ({
          appToken,
          tenantAccessToken,
          deadlineAt,
        }));
      }
      return contextPromise;
    };

    const parsePersistedReport = (
      record: BitableRecordItem,
    ): PersistedChangeSummaryReportSnapshot | null => {
      const fields = record.fields || {};
      const recordId = getRecordId(record);
      const clientMutationId = extractDisplayText(
        pickField(fields, ['变更总结请求唯一ID']),
        '',
      ).trim();
      const fingerprint = extractDisplayText(
        pickField(fields, ['变更总结请求指纹']),
        '',
      ).trim();
      const changeRecordId = this.extractLinkedBitableRecordId(
        pickField(fields, ['变更关联']),
      );
      if (!recordId || !clientMutationId || !fingerprint || !changeRecordId) {
        return null;
      }
      return {
        recordId,
        clientMutationId,
        fingerprint,
        changeRecordId,
        reportFileTokens: this.extractBitableAttachmentTokens(
          pickField(fields, ['变更总结报告（风险低及以上）']),
        ),
      };
    };

    const isSummaryReportCandidate = (record: BitableRecordItem): boolean => {
      const fields = record.fields || {};
      return Boolean(
        extractDisplayText(
          pickField(fields, ['变更总结请求唯一ID']),
          '',
        ).trim() ||
        extractDisplayText(
          pickField(fields, ['变更总结请求指纹']),
          '',
        ).trim() ||
        this.extractBitableAttachmentTokens(
          pickField(fields, ['变更总结报告（风险低及以上）']),
        ).length,
      );
    };

    const summaryFieldNames = [
      '变更关联',
      '变更总结报告（风险低及以上）',
      '变更总结请求唯一ID',
      '变更总结请求指纹',
    ];
    const findSingleReport = async (
      fieldName: '变更总结请求唯一ID' | '变更关联',
      value: string,
    ): Promise<PersistedChangeSummaryReportSnapshot | null> => {
      const { appToken } = await getContext();
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: this.changeDrillReportTableId,
        tableName: this.changeDrillReportTableName,
        fieldNames: summaryFieldNames,
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: fieldName,
              operator: 'is',
              value: [value],
            },
          ],
        },
        cacheTtlMs: 0,
        forceRefresh: true,
        strict: true,
      });
      if (records.length === 0) return null;
      const summaryRecords =
        fieldName === '变更关联'
          ? records.filter(isSummaryReportCandidate)
          : records;
      if (summaryRecords.length === 0) return null;
      if (summaryRecords.length > 1) {
        throw new ConflictException(
          `变更总结收口表存在多个相同${fieldName}，已停止写入`,
        );
      }
      const persisted = parsePersistedReport(summaryRecords[0]);
      if (!persisted) {
        throw new ConflictException(
          `变更总结收口表按${fieldName}命中记录但关键字段不完整`,
        );
      }
      return persisted;
    };

    return {
      readChangeStrict: async (recordId) => {
        this.assertSafeChangeRecordAttachmentIdentity(recordId);
        const { appToken, tenantAccessToken, deadlineAt } = await getContext();
        const record = await this.fetchBitableRecordByIdWithDisplayValues(
          appToken,
          this.calendarChangeConfig.tableId,
          this.calendarChangeConfig.tableName,
          recordId,
          tenantAccessToken,
          deadlineAt,
        );
        if (!record) return null;
        const baseRecord = this.mapFeishuCalendarChangeRecord(record);
        if (!baseRecord) {
          throw new BadRequestException('变更记录缺少标题或计划时间');
        }
        const normalized = await extendChangeInfoWithAdjustmentRecord(
          baseRecord,
          record,
        );
        return {
          recordId: normalized.bitableRecordId,
          title: normalized.title,
          submitterName: normalized.submitterName || null,
          progress: normalized.progress,
          level: normalized.level,
          workflowStatus: normalized.workflowStatus || null,
          hasSummaryReport: normalized.hasSummaryReport === true,
          plannedStartAt: normalized.startDate,
          plannedEndAt: normalized.endDate,
        };
      },
      findReportByMutationId: (clientMutationId) =>
        findSingleReport('变更总结请求唯一ID', clientMutationId),
      findReportByChangeRecordId: (changeRecordId) =>
        findSingleReport('变更关联', changeRecordId),
      resolveOwnedStorage: (id, ownerMutationId) =>
        storage.resolveOwned(id, ownerMutationId),
      uploadToBitable: async ({ file, clientMutationId }) => {
        const { appToken, tenantAccessToken, deadlineAt } = await getContext();
        return this.uploadStagedChangeRequestAttachment(
          tenantAccessToken,
          appToken,
          this.toChangeRequestUploadFile(file),
          clientMutationId,
          deadlineAt,
        );
      },
      createReport: async (input) => {
        const { appToken, tenantAccessToken, deadlineAt } = await getContext();
        try {
          return await this.createBitableRecord(
            appToken,
            this.changeDrillReportTableId,
            this.changeDrillReportTableName,
            {
              变更关联: [input.changeRecordId],
              '变更总结报告（风险低及以上）': input.reportFileTokens.map(
                (fileToken) => ({ file_token: fileToken }),
              ),
              变更总结请求唯一ID: input.clientMutationId,
              变更总结请求指纹: input.fingerprint,
            },
            tenantAccessToken,
            {
              clientToken: input.clientToken,
              retryNetworkErrors: true,
              deadlineAt,
            },
          );
        } catch (error) {
          this.logChangeSummaryReportWriteFailure(
            error,
            input.clientMutationId,
          );
          throw error;
        }
      },
      readReportStrict: async (recordId) => {
        const { appToken, tenantAccessToken, deadlineAt } = await getContext();
        const record = await this.fetchBitableRecordById(
          appToken,
          this.changeDrillReportTableId,
          this.changeDrillReportTableName,
          recordId,
          tenantAccessToken,
          deadlineAt,
        );
        return record ? parsePersistedReport(record) : null;
      },
      findBoundStorage: (id) => storage.findBoundByIdForTrustedServer(id),
      deleteOwnedStorage: (id, ownerMutationId) =>
        storage.delete(id, { ownerMutationId }),
      deleteBoundStorage: (expectation) =>
        storage.deleteBoundForTrustedServer(expectation),
      deleteReportStrict: async (expected) => {
        const { appToken, tenantAccessToken, deadlineAt } = await getContext();
        const record = await this.fetchBitableRecordById(
          appToken,
          this.changeDrillReportTableId,
          this.changeDrillReportTableName,
          expected.recordId,
          tenantAccessToken,
          deadlineAt,
        );
        if (!record) return;
        const current = parsePersistedReport(record);
        if (
          !current ||
          current.recordId !== expected.recordId ||
          current.clientMutationId !== expected.clientMutationId ||
          current.fingerprint !== expected.fingerprint ||
          current.changeRecordId !== expected.changeRecordId ||
          current.reportFileTokens.length !==
            expected.reportFileTokens.length ||
          current.reportFileTokens.some(
            (token, index) => token !== expected.reportFileTokens[index],
          )
        ) {
          throw new ConflictException(
            '变更总结收口记录在删除前已变化，拒绝放弃',
          );
        }
        await this.deleteBitableRecord(
          appToken,
          this.changeDrillReportTableId,
          this.changeDrillReportTableName,
          expected.recordId,
          tenantAccessToken,
        );
      },
      bindStorageToRecord: async ({
        id,
        recordId,
        fileToken,
        ownerMutationId,
      }) => {
        await storage.bindToRecord(id, recordId, fileToken, {
          ownerMutationId,
        });
      },
      invalidateChangeCaches: async () => {
        const { appToken } = await getContext();
        invalidateBitableRecordCache({
          appToken,
          tableId: this.changeDrillReportTableId,
        });
        invalidateBitableRecordCache({
          appToken,
          tableId: this.calendarChangeConfig.tableId,
        });
      },
    };
  }

  private resolveChangeDrillReportLifecycle(
    snapshot: ChangeAdjustmentRecordSnapshot,
  ): 'not-started' | 'in-progress' | 'finished' {
    const parse = (
      value: string | number | Date | null | undefined,
    ): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const parsed =
        value instanceof Date
          ? value.getTime()
          : typeof value === 'number'
            ? value < 100_000_000_000
              ? value * 1000
              : value
            : Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const actualEnd = parse(snapshot.actualEndAt);
    if (actualEnd !== null) return 'finished';
    const actualStart = parse(snapshot.actualStartAt);
    if (actualStart !== null) return 'in-progress';
    const effectiveStart =
      parse(snapshot.plannedDelayStartAt) ?? parse(snapshot.plannedStartAt);
    const effectiveEnd =
      parse(snapshot.plannedDelayEndAt) ?? parse(snapshot.plannedEndAt);
    if (
      effectiveStart === null ||
      effectiveEnd === null ||
      effectiveEnd <= effectiveStart
    ) {
      throw new BadRequestException('变更当前有效时间范围无效');
    }
    const now = Date.now();
    if (now >= effectiveEnd) return 'finished';
    return now >= effectiveStart ? 'in-progress' : 'not-started';
  }

  private extractLinkedBitableRecordId(value: unknown): string {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (
        typeof candidate === 'string' &&
        /^rec[A-Za-z0-9]{8,64}$/.test(candidate)
      ) {
        return candidate;
      }
      if (!candidate || typeof candidate !== 'object') continue;
      const item = candidate as Record<string, unknown>;
      for (const field of ['id', 'record_id', 'recordId']) {
        const id = typeof item[field] === 'string' ? item[field].trim() : '';
        if (/^rec[A-Za-z0-9]{8,64}$/.test(id)) return id;
      }
      for (const field of ['record_ids', 'link_record_ids']) {
        const recordIds = item[field];
        if (!Array.isArray(recordIds)) continue;
        const id = recordIds.find(
          (entry): entry is string =>
            typeof entry === 'string' && /^rec[A-Za-z0-9]{8,64}$/.test(entry),
        );
        if (id) return id;
      }
    }
    return '';
  }

  private extractBitableAttachmentTokens(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return '';
            const item = entry as Record<string, unknown>;
            const token = item.file_token ?? item.fileToken ?? item.token;
            return typeof token === 'string' ? token.trim() : '';
          })
          .filter(Boolean),
      ),
    );
  }

  async cleanupChangeSelfTestBoundAttachment(
    request: ChangeSelfTestBoundAttachmentCleanupRequest,
    proof: string,
  ): Promise<ChangeSelfTestBoundAttachmentCleanupResponse> {
    const normalized = verifyChangeSelfTestCleanupProof(request, proof);
    const storage = this.changeAttachmentStorage;
    if (!storage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }

    const deadlineAt = Date.now() + CHANGE_REQUEST_SYNC_DEADLINE_MS;
    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, {
        ...this.calendarChangeConfig,
        requestTimeoutMs: (stage) =>
          this.getChangeRequestBoundedAxiosTimeout(deadlineAt, stage),
        waitFor: (promise, stage) =>
          this.waitWithinChangeRequestDeadline(promise, deadlineAt, stage),
        waitBeforeRetry: (delayMs, stage) =>
          this.sleepWithinChangeRequestDeadline(delayMs, deadlineAt, stage),
      }),
      this.getFeishuTenantAccessToken(deadlineAt),
    ]);
    const record = await this.fetchBitableRecordById(
      appToken,
      this.calendarChangeConfig.tableId,
      this.calendarChangeConfig.tableName,
      normalized.recordId,
      tenantAccessToken,
      deadlineAt,
    );
    const publicRecord = record
      ? this.mapFeishuCalendarChangeRecord(record)
      : null;
    const snapshot =
      record && publicRecord
        ? await mapChangeAdjustmentRecordSnapshot(record, publicRecord)
        : null;
    if (
      !snapshot ||
      snapshot.recordId !== normalized.recordId ||
      snapshot.publicRecord.title !== normalized.summaryMarker
    ) {
      throw new ConflictException('变更自测记录身份不一致，拒绝清理附件');
    }
    if (
      normalized.adjustmentConfirmed &&
      (snapshot.adjustmentMutationId !== normalized.adjustmentMutationId ||
        snapshot.reason !== normalized.adjustmentReasonMarker)
    ) {
      throw new ConflictException('变更自测调整身份不一致，拒绝清理附件');
    }

    const bound = await storage.findBoundByIdForTrustedSelfTest(
      normalized.objectId,
    );
    if (!bound) {
      return {
        success: true,
        objectId: normalized.objectId,
        missing: true,
      };
    }
    if (
      bound.id !== normalized.objectId ||
      bound.boundRecordId !== normalized.recordId ||
      bound.ownerMutationId !== normalized.ownerMutationId
    ) {
      throw new ConflictException('变更自测附件绑定关系不一致，拒绝清理附件');
    }
    const activeTokens = new Set(
      [...snapshot.documents, ...(snapshot.evidence || [])].map(
        (document) => document.fileToken,
      ),
    );
    const removedOriginalAfterAdjustment =
      normalized.adjustmentConfirmed &&
      CHANGE_SELF_TEST_CREATE_OWNER_PATTERN.test(normalized.ownerMutationId);
    if (!activeTokens.has(bound.fileToken) && !removedOriginalAfterAdjustment) {
      throw new ConflictException(
        '变更自测附件令牌不属于当前记录，拒绝清理附件',
      );
    }

    const deleted = await storage.deleteBoundForTrustedSelfTest({
      id: bound.id,
      recordId: bound.boundRecordId,
      fileToken: bound.fileToken,
      ownerMutationId: bound.ownerMutationId,
    });
    return {
      success: true,
      objectId: normalized.objectId,
      missing: !deleted,
    };
  }

  async resolveChangeRecordAttachment(
    recordId: string,
    fileToken: string,
  ): Promise<
    | {
        kind: 'redirect';
        url: string;
        name: string;
        contentType: string;
      }
    | {
        kind: 'buffer';
        buffer: Buffer;
        name: string;
        contentType: string;
      }
  > {
    const normalizedRecordId = String(recordId || '').trim();
    const normalizedFileToken = String(fileToken || '').trim();
    this.assertSafeChangeRecordAttachmentIdentity(
      normalizedRecordId,
      normalizedFileToken,
    );
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }

    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, this.calendarChangeConfig),
      this.getFeishuTenantAccessToken(),
    ]);
    const record = await this.fetchBitableRecordById(
      appToken,
      this.calendarChangeConfig.tableId,
      this.calendarChangeConfig.tableName,
      normalizedRecordId,
      tenantAccessToken,
    );
    const publicRecord = record
      ? this.mapFeishuCalendarChangeRecord(record)
      : null;
    const snapshot =
      record && publicRecord
        ? await mapChangeAdjustmentRecordSnapshot(record, publicRecord)
        : null;
    const attachment = snapshot
      ? [...snapshot.documents, ...(snapshot.evidence || [])].find(
          (candidate) => candidate.fileToken === normalizedFileToken,
        )
      : undefined;
    if (!attachment) {
      throw new NotFoundException('未找到当前变更记录的附件');
    }

    const storage = this.changeAttachmentStorage;
    if (storage) {
      const metadata =
        await storage.findByFileTokenForTrustedServer(normalizedFileToken);
      if (metadata?.boundRecordId === normalizedRecordId) {
        const url = await storage.getSignedDownloadUrlForTrustedServer(
          metadata.id,
          300,
        );
        return {
          kind: 'redirect',
          url,
          name: attachment.name,
          contentType: attachment.mimeType,
        };
      }
    }

    const downloaded =
      await this.downloadConstructionAttachment(normalizedFileToken);
    return {
      kind: 'buffer',
      buffer: downloaded.buffer,
      name: attachment.name,
      contentType: downloaded.contentType || attachment.mimeType,
    };
  }

  private assertSafeChangeRecordAttachmentIdentity(
    recordId: string,
    fileToken?: string,
  ): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(recordId)) {
      throw new BadRequestException('变更记录 ID 无效');
    }
    if (fileToken !== undefined && !/^[A-Za-z0-9_-]{1,500}$/.test(fileToken)) {
      throw new BadRequestException('变更附件标识无效');
    }
  }

  async createChangeRequest(
    request: ChangeRequestCreateRequest,
    files: ConstructionUploadFile[] = [],
    options: { backgroundAttachments?: boolean; principal?: AccessPrincipal } = {},
  ): Promise<ChangeRequestCreateResponse> {
    if (isPersonalAccessAccount(options.principal)) {
      const principal = options.principal!;
      request = { ...request, submitterName: bindSelfServiceApplicant(request.submitterName || '', principal, true, '提交变更申请') };
      const staff = await this.resolveLeaveRequestStaff(request.submitterName || '', undefined, principal);
      const submitter = await this.resolveChangeRequestSubmitter(request.submitterName || '', request.submitterId);
      if (!staff.userId || staff.userId !== submitter.userId || !(await this.readActiveChangeRequestUserIds()).has(submitter.userId)) {
        throw new ForbiddenException('登录人员不具备变更提交资格，请联系管理员核对');
      }
      request = { ...request, submitterId: publicSubmitterId(staff.userId) };
    }
    const deadlineAt = Date.now() + CHANGE_REQUEST_SYNC_DEADLINE_MS;
    const stagedValue = hasOwnRuntimeProperty(request, 'stagedDocuments')
      ? request.stagedDocuments
      : undefined;
    if (stagedValue !== undefined && !Array.isArray(stagedValue)) {
      throw new BadRequestException('变更附件暂存引用格式无效');
    }
    const stagedDocuments = Array.isArray(stagedValue) ? stagedValue : [];
    if (files.length > 0 && stagedDocuments.length > 0) {
      throw new BadRequestException('不能同时提交文件和对象存储引用');
    }
    if (
      files.some(
        (file) => file.size > BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES,
      )
    ) {
      throw new BadRequestException(
        '超过 20 MiB 的变更文档请先上传到对象存储后再提交',
      );
    }
    const requestWithoutStaged = {
      ...(request as ChangeRequestCreateRequest),
    };
    delete requestWithoutStaged.stagedDocuments;
    const validationErrors = validateChangeRequest(
      requestWithoutStaged,
      files.length > 0
        ? { documents: files }
        : { documentCount: stagedDocuments.length },
    );
    if (validationErrors.length > 0) {
      throw new BadRequestException(validationErrors[0].message);
    }
    if (files.some((file) => file.fieldname !== 'documents')) {
      throw new BadRequestException('变更申请仅接受 documents 附件字段');
    }
    this.assertChangeRequestDocumentSignatures(files);

    let trustedFiles: ChangeRequestUploadFile[] = files;
    if (stagedDocuments.length > 0) {
      const storage = this.changeAttachmentStorage;
      if (!storage) {
        throw new ServiceUnavailableException('变更附件对象存储尚未配置');
      }
      const storageIds = stagedDocuments.map((document) => {
        const id =
          typeof document?.objectStorage?.id === 'string'
            ? document.objectStorage.id.trim()
            : '';
        if (!id) {
          throw new BadRequestException('变更附件暂存标识无效');
        }
        return id;
      });
      if (new Set(storageIds).size !== storageIds.length) {
        throw new BadRequestException('变更附件暂存标识不能重复');
      }
      const resolvedDocuments = await Promise.all(
        storageIds.map((id) =>
          storage.resolveOwned(id, requestWithoutStaged.clientMutationId),
        ),
      );
      trustedFiles = resolvedDocuments.map((document) =>
        this.toChangeRequestUploadFile(document),
      );
      const trustedValidationErrors = validateChangeRequest(
        requestWithoutStaged,
        { documents: trustedFiles },
      );
      if (trustedValidationErrors.length > 0) {
        throw new BadRequestException(trustedValidationErrors[0].message);
      }
      trustedFiles = await Promise.all(
        trustedFiles.map((file) =>
          this.validateOwnedStagedChangeRequestDocument(
            file,
            requestWithoutStaged.clientMutationId,
          ),
        ),
      );
    }

    const normalized = this.normalizeChangeRequest(requestWithoutStaged);
    const fingerprint = this.buildChangeRequestMutationFingerprint(
      normalized,
      trustedFiles,
    );
    this.assertChangeRequestDeadline(deadlineAt, '校验申请内容');
    let durableState: ChangeRequestMutationDurableState = {
      fingerprint,
      uploadedByIndex: new Map(),
      recordState: 'not-created',
      retryAction: 'retry-same-mutation',
    };
    try {
      durableState = await this.waitWithinChangeRequestDeadline(
        this.loadDurableChangeRequestMutationState(
          normalized.clientMutationId,
          fingerprint,
          trustedFiles,
          deadlineAt,
          durableState,
        ),
        deadlineAt,
        '读取幂等台账',
      );
    } catch (error) {
      if (error instanceof ChangeRequestDeadlineExceededError) {
        this.throwChangeRequestDeadlinePartialFailure(
          normalized,
          trustedFiles,
          durableState,
          error,
        );
      }
      throw error;
    }
    if (durableState.response) {
      return durableState.response;
    }
    if (durableState.retryAction === 'manual-reconcile') {
      this.throwStoredChangeRequestPartialFailure(
        normalized,
        trustedFiles,
        durableState,
        '飞书返回 Client token conflict，提交结果无法自动确认；已保留原申请标识，请人工核查多维表，禁止再次自动提交',
      );
    }
    const now = Date.now();
    for (const [key, entry] of this.changeRequestMutationCompleted) {
      if (entry.expiresAt <= now) {
        this.changeRequestMutationCompleted.delete(key);
      }
    }
    for (const [key, entry] of this.changeRequestMutationPartial) {
      if (entry.expiresAt <= now) {
        this.changeRequestMutationPartial.delete(key);
      }
    }

    const completed = this.changeRequestMutationCompleted.get(
      normalized.clientMutationId,
    );
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new ConflictException(
          '相同 clientMutationId 已用于不同的变更申请',
        );
      }
      return completed.response;
    }

    const partial = this.changeRequestMutationPartial.get(
      normalized.clientMutationId,
    );
    if (partial && partial.fingerprint !== fingerprint) {
      throw new ConflictException(
        '相同 clientMutationId 已用于内容不同的待补传变更申请',
      );
    }
    if (partial) {
      for (const [index, document] of partial.uploadedByIndex) {
        durableState.uploadedByIndex.set(index, document);
      }
      durableState.recordState = partial.recordState;
      durableState.retryAction = partial.retryAction;
      durableState.recordId = partial.recordId;
    }
    if (partial?.retryAction === 'manual-reconcile') {
      this.throwStoredChangeRequestPartialFailure(
        normalized,
        trustedFiles,
        durableState,
        '飞书返回 Client token conflict，提交结果无法自动确认；已保留原申请标识，请人工核查多维表，禁止再次自动提交',
      );
    }

    const inFlight = this.changeRequestMutationInFlight.get(
      normalized.clientMutationId,
    );
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw new ConflictException(
          '相同 clientMutationId 正在提交不同的变更申请',
        );
      }
      try {
        return await this.waitWithinChangeRequestDeadline(
          inFlight.promise,
          deadlineAt,
          '等待相同变更申请',
        );
      } catch (error) {
        if (error instanceof ChangeRequestDeadlineExceededError) {
          this.throwChangeRequestDeadlinePartialFailure(
            normalized,
            trustedFiles,
            durableState,
            error,
          );
        }
        throw error;
      }
    }

    const promise = options.backgroundAttachments
      ? this.createChangeRequestRecordFirstNow(
          normalized,
          trustedFiles,
          fingerprint,
          durableState,
          deadlineAt,
        )
      : this.createChangeRequestNow(
          normalized,
          trustedFiles,
          fingerprint,
          durableState,
          deadlineAt,
        );
    this.changeRequestMutationInFlight.set(normalized.clientMutationId, {
      fingerprint,
      promise,
    });
    try {
      const response = await this.waitWithinChangeRequestDeadline(
        promise,
        deadlineAt,
        '等待变更申请同步',
      );
      if (response.pendingSync) {
        return response;
      }
      this.changeRequestMutationPartial.delete(normalized.clientMutationId);
      this.changeRequestMutationCompleted.set(normalized.clientMutationId, {
        expiresAt: Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS,
        fingerprint,
        response,
      });
      while (
        this.changeRequestMutationCompleted.size >
        CHANGE_REQUEST_MUTATION_COMPLETED_MAX_ENTRIES
      ) {
        const oldestKey = this.changeRequestMutationCompleted.keys().next()
          .value as string | undefined;
        if (!oldestKey) break;
        this.changeRequestMutationCompleted.delete(oldestKey);
      }
      return response;
    } catch (error) {
      if (error instanceof ChangeRequestDeadlineExceededError) {
        this.throwChangeRequestDeadlinePartialFailure(
          normalized,
          trustedFiles,
          durableState,
          error,
        );
      }
      throw error;
    } finally {
      const current = this.changeRequestMutationInFlight.get(
        normalized.clientMutationId,
      );
      if (current?.promise === promise) {
        this.changeRequestMutationInFlight.delete(normalized.clientMutationId);
      }
    }
  }

  private normalizeChangeRequest(
    request: ChangeRequestCreateRequest,
  ): ChangeRequestCreateRequest {
    const nonStandard = request.nature === '非标准变更';
    return {
      clientMutationId: request.clientMutationId.trim(),
      submitterName: request.submitterName?.trim(),
      ...(request.submitterId ? { submitterId: request.submitterId } : {}),
      nature: request.nature,
      ...(nonStandard && request.meetingStartAt?.trim()
        ? { meetingStartAt: request.meetingStartAt.trim() }
        : {}),
      ...(nonStandard && request.meetingEndAt?.trim()
        ? { meetingEndAt: request.meetingEndAt.trim() }
        : {}),
      summary: request.summary.trim(),
      changeType: request.changeType,
      workType: request.workType,
      buildings: request.buildings.map((building) =>
        building.trim(),
      ) as ChangeRequestCreateRequest['buildings'],
      plannedStartAt: request.plannedStartAt.trim(),
      plannedEndAt: request.plannedEndAt.trim(),
      discipline: request.discipline,
      level: request.level,
      riskSummary: request.riskSummary.trim(),
    };
  }

  private toChangeRequestUploadFile(
    document: ChangeAttachmentMetadata,
  ): ChangeRequestUploadFile {
    return {
      fieldname: 'documents',
      originalname: document.name,
      mimetype: document.mimeType,
      size: document.size,
      storageId: document.id,
      sha256: document.sha256,
    };
  }

  private async validateOwnedStagedChangeRequestDocument(
    file: ChangeRequestUploadFile,
    ownerMutationId: string,
  ): Promise<ChangeRequestUploadFile> {
    const storage = this.changeAttachmentStorage;
    if (!storage || !file.storageId) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    const accessContext = { ownerMutationId } as const;
    if (file.size <= BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES) {
      const buffer = await storage.readAll(file.storageId, accessContext);
      this.assertStagedChangeRequestDocumentSignature(file, buffer, true);
      return { ...file, buffer, signatureValidated: true };
    }
    const headerEnd = Math.min(file.size - 1, 1023);
    const header = await storage.readRange(
      file.storageId,
      0,
      headerEnd,
      accessContext,
    );
    this.assertStagedChangeRequestDocumentSignature(file, header, false);
    return { ...file, signatureValidated: true };
  }

  private assertStagedChangeRequestDocumentSignature(
    file: ChangeRequestUploadFile,
    buffer: Buffer,
    completeFile: boolean,
  ): void {
    const extension = /\.[^.]+$/.exec(
      String(file.originalname || '')
        .trim()
        .toLowerCase(),
    )?.[0];
    const valid =
      extension === '.docx' || extension === '.xlsx'
        ? completeFile
          ? isValidOoxmlDocument(buffer, extension)
          : buffer.length >= 4 &&
            buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        : Boolean(
            extension && this.matchesDocumentSignature(extension, buffer),
          );
    if (!valid) {
      throw new BadRequestException('变更文档内容与文件类型不匹配');
    }
  }

  private assertChangeRequestDocumentSignatures(
    files: ChangeRequestUploadFile[],
  ): void {
    for (const file of files) {
      const extension = /\.[^.]+$/.exec(
        String(file.originalname || '')
          .trim()
          .toLowerCase(),
      )?.[0];
      const buffer = file.buffer;
      if (
        !extension ||
        !buffer ||
        !this.matchesDocumentSignature(extension, buffer)
      ) {
        throw new BadRequestException('变更文档内容与文件类型不匹配');
      }
    }
  }

  private matchesDocumentSignature(extension: string, buffer: Buffer): boolean {
    if (extension === '.pdf') {
      const headerIndex = buffer
        .subarray(0, 1024)
        .indexOf(Buffer.from('%PDF-'));
      return headerIndex >= 0;
    }
    if (extension === '.png') {
      return buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (extension === '.jpg' || extension === '.jpeg') {
      return (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      );
    }
    if (extension === '.doc' || extension === '.xls') {
      return buffer
        .subarray(0, 8)
        .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    }
    if (extension === '.docx' || extension === '.xlsx') {
      return isValidOoxmlDocument(buffer, extension);
    }
    return false;
  }

  private buildChangeRequestMutationFingerprint(
    request: ChangeRequestCreateRequest,
    files: ChangeRequestUploadFile[],
  ): string {
    const hash = crypto.createHash('sha256');
    hash.update(
      JSON.stringify({
        ...request,
        buildings: [...request.buildings].sort((a, b) =>
          a.localeCompare(b, 'zh-CN'),
        ),
      }),
    );
    for (const file of files) {
      hash.update('\0');
      hash.update(file.originalname || '');
      hash.update('\0');
      hash.update(file.mimetype || '');
      hash.update('\0');
      hash.update(String(file.size));
      hash.update('\0');
      if (file.storageId) {
        hash.update(file.storageId);
        hash.update('\0');
        hash.update(file.sha256 || '');
      } else if (file.buffer) {
        hash.update(file.buffer);
      }
    }
    return hash.digest('hex');
  }

  private toChangeRequestBitableClientToken(clientMutationId: string): string {
    const match =
      /^change-request-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
        clientMutationId,
      );
    if (!match) {
      throw new BadRequestException('变更申请 clientMutationId 格式无效');
    }
    return match[1].toLowerCase();
  }

  private async loadDurableChangeRequestMutationState(
    clientMutationId: string,
    fingerprint: string,
    files: ChangeRequestUploadFile[],
    deadlineAt?: number,
    state: ChangeRequestMutationDurableState = {
      fingerprint,
      uploadedByIndex: new Map(),
      recordState: 'not-created',
      retryAction: 'retry-same-mutation',
    },
  ): Promise<ChangeRequestMutationDurableState> {
    if (!this.changeRequestMutationLedgerDir) return state;

    await this.waitWithinChangeRequestDeadline(
      mkdir(this.changeRequestMutationLedgerDir, { recursive: true }),
      deadlineAt,
      '创建幂等台账目录',
    );
    const persistedFingerprint = (
      await this.persistImmutableChangeRequestMutationLedgerFile(
        this.getChangeRequestMutationLedgerPath(clientMutationId, 'sha256'),
        `${fingerprint}\n`,
        deadlineAt,
      )
    )
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(persistedFingerprint)) {
      throw new Error('变更申请幂等台账损坏，已停止提交以避免重复记录');
    }
    if (persistedFingerprint !== fingerprint.toLowerCase()) {
      throw new ConflictException(
        '相同 clientMutationId 已用于不同内容的变更申请',
      );
    }

    for (let index = 0; index < files.length; index += 1) {
      this.assertChangeRequestDeadline(deadlineAt, '读取附件幂等台账');
      const contents = await this.readOptionalChangeRequestMutationLedgerFile(
        this.getChangeRequestMutationLedgerPath(
          clientMutationId,
          `upload.${index}.json`,
        ),
        deadlineAt,
      );
      if (!contents) continue;
      const entry = this.parseChangeRequestUploadLedgerEntry(
        contents,
        clientMutationId,
        fingerprint,
        index,
        files[index],
      );
      state.uploadedByIndex.set(index, entry.document);
    }

    const unknownContents =
      await this.readOptionalChangeRequestMutationLedgerFile(
        this.getChangeRequestMutationLedgerPath(
          clientMutationId,
          'record-unknown.json',
        ),
        deadlineAt,
      );
    if (unknownContents) {
      this.parseChangeRequestRecordUnknownLedgerEntry(
        unknownContents,
        clientMutationId,
        fingerprint,
      );
      state.recordState = 'unknown';
      state.retryAction = 'retry-same-mutation';
    }

    const manualReconcileContents =
      await this.readOptionalChangeRequestMutationLedgerFile(
        this.getChangeRequestMutationLedgerPath(
          clientMutationId,
          'manual-reconcile.json',
        ),
        deadlineAt,
      );
    if (manualReconcileContents) {
      this.parseChangeRequestManualReconcileLedgerEntry(
        manualReconcileContents,
        clientMutationId,
        fingerprint,
      );
      state.recordState = 'unknown';
      state.retryAction = 'manual-reconcile';
    }

    const recordContents =
      await this.readOptionalChangeRequestMutationLedgerFile(
        this.getChangeRequestMutationLedgerPath(
          clientMutationId,
          'record.json',
        ),
        deadlineAt,
      );
    if (recordContents) {
      state.recordId = this.parseChangeRequestRecordLedgerEntry(
        recordContents,
        clientMutationId,
        fingerprint,
      ).recordId;
      state.recordState = 'created';
    }

    const completedContents =
      await this.readOptionalChangeRequestMutationLedgerFile(
        this.getChangeRequestMutationLedgerPath(
          clientMutationId,
          'completed.json',
        ),
        deadlineAt,
      );
    if (completedContents) {
      const completed = this.parseChangeRequestCompletedLedgerEntry(
        completedContents,
        clientMutationId,
        fingerprint,
      );
      if (state.recordId && state.recordId !== completed.recordId) {
        throw new Error('变更申请幂等台账中的正式记录 ID 不一致，已停止提交');
      }
      state.recordId = completed.recordId;
      state.recordState = 'created';
      state.response = completed.response;
    }
    return state;
  }

  private getChangeRequestMutationLedgerPath(
    clientMutationId: string,
    suffix: string,
  ): string {
    return join(
      this.changeRequestMutationLedgerDir,
      `${clientMutationId}.${suffix}`,
    );
  }

  private async persistImmutableChangeRequestMutationLedgerFile(
    targetPath: string,
    contents: string,
    deadlineAt?: number,
  ): Promise<string> {
    const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const writePromise = writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
    }).catch((error: unknown) => {
      throw new Error(
        `变更申请幂等台账临时文件写入失败：${getBitableAxiosErrorMessage(error)}`,
      );
    });
    try {
      await this.waitWithinChangeRequestDeadline(
        writePromise,
        deadlineAt,
        '写入幂等台账临时文件',
      );
    } catch (error) {
      void writePromise
        .then(
          () => rm(temporaryPath, { force: true }),
          () => rm(temporaryPath, { force: true }),
        )
        .catch(() => undefined);
      throw error;
    }
    try {
      await this.waitWithinChangeRequestDeadline(
        link(temporaryPath, targetPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
            throw error;
          }
        }),
        deadlineAt,
        '落盘幂等台账',
      );
    } catch (error) {
      if (error instanceof ChangeRequestDeadlineExceededError) throw error;
      throw new Error(
        `变更申请幂等台账原子落盘失败：${getBitableAxiosErrorMessage(error)}`,
      );
    } finally {
      await this.waitWithinChangeRequestDeadline(
        rm(temporaryPath, { force: true }).catch(() => undefined),
        deadlineAt,
        '清理幂等台账临时文件',
      );
    }
    return this.waitWithinChangeRequestDeadline(
      readFile(targetPath, 'utf8').catch((error: unknown) => {
        throw new Error(
          `变更申请幂等台账读取失败：${getBitableAxiosErrorMessage(error)}`,
        );
      }),
      deadlineAt,
      '确认幂等台账',
    );
  }

  private async readOptionalChangeRequestMutationLedgerFile(
    targetPath: string,
    deadlineAt?: number,
  ): Promise<string | null> {
    try {
      return await this.waitWithinChangeRequestDeadline(
        readFile(targetPath, 'utf8'),
        deadlineAt,
        '读取幂等台账文件',
      );
    } catch (error) {
      if (error instanceof ChangeRequestDeadlineExceededError) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw new Error(
        `变更申请幂等台账读取失败：${getBitableAxiosErrorMessage(error)}`,
      );
    }
  }

  private parseChangeRequestMutationLedgerJson(contents: string): unknown {
    try {
      return JSON.parse(contents);
    } catch {
      throw new Error('变更申请幂等台账损坏，已停止提交以避免重复记录');
    }
  }

  private parseChangeRequestUploadLedgerEntry(
    contents: string,
    clientMutationId: string,
    fingerprint: string,
    index: number,
    file: ChangeRequestUploadFile,
  ): ChangeRequestMutationUploadLedgerEntry {
    const value = this.parseChangeRequestMutationLedgerJson(contents) as
      | Partial<ChangeRequestMutationUploadLedgerEntry>
      | undefined;
    const expectedName =
      normalizeConstructionUploadFileName(file.originalname) || '未命名文件';
    if (
      !value ||
      value.version !== 1 ||
      value.state !== 'uploaded' ||
      value.clientMutationId !== clientMutationId ||
      value.fingerprint !== fingerprint ||
      value.index !== index ||
      !value.document ||
      typeof value.document.fileToken !== 'string' ||
      !value.document.fileToken.trim() ||
      value.document.name !== expectedName ||
      value.document.size !== file.size ||
      value.document.storageId !== file.storageId
    ) {
      throw new Error(`变更申请附件 ${index + 1} 的幂等台账损坏，已停止提交`);
    }
    return value as ChangeRequestMutationUploadLedgerEntry;
  }

  private parseChangeRequestRecordLedgerEntry(
    contents: string,
    clientMutationId: string,
    fingerprint: string,
  ): ChangeRequestMutationRecordLedgerEntry {
    const value = this.parseChangeRequestMutationLedgerJson(contents) as
      | Partial<ChangeRequestMutationRecordLedgerEntry>
      | undefined;
    if (
      !value ||
      value.version !== 1 ||
      value.state !== 'record-created' ||
      value.clientMutationId !== clientMutationId ||
      value.fingerprint !== fingerprint ||
      typeof value.recordId !== 'string' ||
      !value.recordId.trim()
    ) {
      throw new Error('变更申请正式记录幂等台账损坏，已停止提交以避免重复记录');
    }
    return value as ChangeRequestMutationRecordLedgerEntry;
  }

  private parseChangeRequestRecordUnknownLedgerEntry(
    contents: string,
    clientMutationId: string,
    fingerprint: string,
  ): ChangeRequestMutationRecordUnknownLedgerEntry {
    const value = this.parseChangeRequestMutationLedgerJson(contents) as
      | Partial<ChangeRequestMutationRecordUnknownLedgerEntry>
      | undefined;
    if (
      !value ||
      value.version !== 1 ||
      value.state !== 'record-unknown' ||
      value.clientMutationId !== clientMutationId ||
      value.fingerprint !== fingerprint ||
      (value.retryAction !== undefined &&
        value.retryAction !== 'retry-same-mutation') ||
      value.clientToken !==
        this.toChangeRequestBitableClientToken(clientMutationId)
    ) {
      throw new Error(
        '变更申请未知创建态幂等台账损坏，已停止提交以避免重复记录',
      );
    }
    return value as ChangeRequestMutationRecordUnknownLedgerEntry;
  }

  private parseChangeRequestManualReconcileLedgerEntry(
    contents: string,
    clientMutationId: string,
    fingerprint: string,
  ): ChangeRequestMutationManualReconcileLedgerEntry {
    const value = this.parseChangeRequestMutationLedgerJson(contents) as
      | Partial<ChangeRequestMutationManualReconcileLedgerEntry>
      | undefined;
    if (
      !value ||
      value.version !== 1 ||
      value.state !== 'manual-reconcile' ||
      value.clientMutationId !== clientMutationId ||
      value.fingerprint !== fingerprint ||
      value.clientToken !==
        this.toChangeRequestBitableClientToken(clientMutationId)
    ) {
      throw new Error('变更申请人工对账幂等台账损坏，已停止提交以避免重复记录');
    }
    return value as ChangeRequestMutationManualReconcileLedgerEntry;
  }

  private parseChangeRequestCompletedLedgerEntry(
    contents: string,
    clientMutationId: string,
    fingerprint: string,
  ): ChangeRequestMutationCompletedLedgerEntry {
    const value = this.parseChangeRequestMutationLedgerJson(contents) as
      | Partial<ChangeRequestMutationCompletedLedgerEntry>
      | undefined;
    const response = value?.response as
      | Partial<ChangeRequestCreateResponse>
      | undefined;
    const responseRecord = response?.record as
      | { id?: unknown; bitableRecordId?: unknown }
      | undefined;
    if (
      !value ||
      value.version !== 1 ||
      value.state !== 'completed' ||
      value.clientMutationId !== clientMutationId ||
      value.fingerprint !== fingerprint ||
      typeof value.recordId !== 'string' ||
      !value.recordId.trim() ||
      !response ||
      response.success !== true ||
      response.clientMutationId !== clientMutationId ||
      typeof response.message !== 'string' ||
      !responseRecord ||
      (responseRecord.id !== value.recordId &&
        responseRecord.bitableRecordId !== value.recordId)
    ) {
      throw new Error('变更申请终态幂等台账损坏，已停止提交以避免重复记录');
    }
    return value as ChangeRequestMutationCompletedLedgerEntry;
  }

  private async persistChangeRequestUploadedDocument(
    clientMutationId: string,
    fingerprint: string,
    index: number,
    file: ChangeRequestUploadFile,
    document: ChangeRequestUploadedDocument,
    deadlineAt?: number,
  ): Promise<ChangeRequestUploadedDocument> {
    if (!this.changeRequestMutationLedgerDir) return document;
    const entry: ChangeRequestMutationUploadLedgerEntry = {
      version: 1,
      state: 'uploaded',
      clientMutationId,
      fingerprint,
      index,
      document,
    };
    const contents = await this.persistImmutableChangeRequestMutationLedgerFile(
      this.getChangeRequestMutationLedgerPath(
        clientMutationId,
        `upload.${index}.json`,
      ),
      `${JSON.stringify(entry)}\n`,
      deadlineAt,
    );
    return this.parseChangeRequestUploadLedgerEntry(
      contents,
      clientMutationId,
      fingerprint,
      index,
      file,
    ).document;
  }

  private async persistChangeRequestRecordId(
    clientMutationId: string,
    fingerprint: string,
    recordId: string,
    deadlineAt?: number,
  ): Promise<string> {
    if (!this.changeRequestMutationLedgerDir) return recordId;
    const entry: ChangeRequestMutationRecordLedgerEntry = {
      version: 1,
      state: 'record-created',
      clientMutationId,
      fingerprint,
      recordId,
    };
    const contents = await this.persistImmutableChangeRequestMutationLedgerFile(
      this.getChangeRequestMutationLedgerPath(clientMutationId, 'record.json'),
      `${JSON.stringify(entry)}\n`,
      deadlineAt,
    );
    const persisted = this.parseChangeRequestRecordLedgerEntry(
      contents,
      clientMutationId,
      fingerprint,
    );
    if (persisted.recordId !== recordId) {
      throw new Error('相同变更申请返回了不一致的正式记录 ID，已停止提交');
    }
    return persisted.recordId;
  }

  private async persistChangeRequestRecordUnknown(
    clientMutationId: string,
    fingerprint: string,
    clientToken: string,
    deadlineAt?: number,
  ): Promise<void> {
    if (!this.changeRequestMutationLedgerDir) return;
    const entry: ChangeRequestMutationRecordUnknownLedgerEntry = {
      version: 1,
      state: 'record-unknown',
      clientMutationId,
      fingerprint,
      clientToken,
      retryAction: 'retry-same-mutation',
    };
    const contents = await this.persistImmutableChangeRequestMutationLedgerFile(
      this.getChangeRequestMutationLedgerPath(
        clientMutationId,
        'record-unknown.json',
      ),
      `${JSON.stringify(entry)}\n`,
      deadlineAt,
    );
    this.parseChangeRequestRecordUnknownLedgerEntry(
      contents,
      clientMutationId,
      fingerprint,
    );
  }

  private async persistChangeRequestManualReconcile(
    clientMutationId: string,
    fingerprint: string,
    clientToken: string,
    deadlineAt?: number,
  ): Promise<void> {
    if (!this.changeRequestMutationLedgerDir) return;
    const entry: ChangeRequestMutationManualReconcileLedgerEntry = {
      version: 1,
      state: 'manual-reconcile',
      clientMutationId,
      fingerprint,
      clientToken,
    };
    const contents = await this.persistImmutableChangeRequestMutationLedgerFile(
      this.getChangeRequestMutationLedgerPath(
        clientMutationId,
        'manual-reconcile.json',
      ),
      `${JSON.stringify(entry)}\n`,
      deadlineAt,
    );
    this.parseChangeRequestManualReconcileLedgerEntry(
      contents,
      clientMutationId,
      fingerprint,
    );
  }

  private async persistCompletedChangeRequestMutation(
    clientMutationId: string,
    fingerprint: string,
    recordId: string,
    response: ChangeRequestCreateResponse,
    deadlineAt?: number,
  ): Promise<ChangeRequestCreateResponse> {
    if (!this.changeRequestMutationLedgerDir) return response;
    const entry: ChangeRequestMutationCompletedLedgerEntry = {
      version: 1,
      state: 'completed',
      clientMutationId,
      fingerprint,
      recordId,
      response,
    };
    const contents = await this.persistImmutableChangeRequestMutationLedgerFile(
      this.getChangeRequestMutationLedgerPath(
        clientMutationId,
        'completed.json',
      ),
      `${JSON.stringify(entry)}\n`,
      deadlineAt,
    );
    const persisted = this.parseChangeRequestCompletedLedgerEntry(
      contents,
      clientMutationId,
      fingerprint,
    );
    if (persisted.recordId !== recordId) {
      throw new Error('相同变更申请保存了不一致的终态记录 ID，已停止提交');
    }
    return persisted.response;
  }

  private async createChangeRequestRecordFirstNow(
    request: ChangeRequestCreateRequest,
    files: ChangeRequestUploadFile[],
    fingerprint: string,
    durableState: ChangeRequestMutationDurableState,
    deadlineAt: number,
  ): Promise<ChangeRequestCreateResponse> {
    this.assertChangeRequestDeadline(deadlineAt, '准备建立正式记录');
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }

    const [appToken, tenantAccessToken] =
      await this.waitWithinChangeRequestDeadline(
        Promise.all([
          resolveBitableAppToken(this.httpService, {
            ...this.calendarChangeConfig,
            requestTimeoutMs: (stage) =>
              this.getChangeRequestBoundedAxiosTimeout(deadlineAt, stage),
            waitFor: (promise, stage) =>
              this.waitWithinChangeRequestDeadline(promise, deadlineAt, stage),
            waitBeforeRetry: (delayMs, stage) =>
              this.sleepWithinChangeRequestDeadline(delayMs, deadlineAt, stage),
          }),
          this.getFeishuTenantAccessToken(deadlineAt),
        ]),
        deadlineAt,
        '解析飞书鉴权与多维表',
      );
    let fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      this.calendarChangeConfig.tableId,
      this.calendarChangeConfig.tableName,
      tenantAccessToken,
      deadlineAt,
    );
    fieldMetas = await this.ensureChangeRequestSubmitterField(
      appToken,
      tenantAccessToken,
      fieldMetas,
      deadlineAt,
    );
    const fieldConfig = this.resolveChangeRequestFieldConfig(fieldMetas);
    const submitter = await this.resolveChangeRequestSubmitter(
      request.submitterName || '',
      request.submitterId,
    );
    const fields = this.buildChangeRequestBitableFields(
      request,
      fieldConfig,
      submitter.userId,
    );
    const partialEntry = this.getOrCreateChangeRequestPartialEntry(
      request.clientMutationId,
      fingerprint,
    );
    for (const [index, document] of durableState.uploadedByIndex) {
      partialEntry.uploadedByIndex.set(index, document);
    }
    partialEntry.recordState = durableState.recordState;
    partialEntry.retryAction = durableState.retryAction;
    partialEntry.recordId = durableState.recordId;

    let recordId = durableState.recordId;
    if (!recordId) {
      const clientToken = this.toChangeRequestBitableClientToken(
        request.clientMutationId,
      );
      try {
        if (durableState.recordState !== 'unknown') {
          await this.persistChangeRequestRecordUnknown(
            request.clientMutationId,
            fingerprint,
            clientToken,
            deadlineAt,
          );
          durableState.recordState = 'unknown';
          durableState.retryAction = 'retry-same-mutation';
          partialEntry.recordState = 'unknown';
          partialEntry.retryAction = 'retry-same-mutation';
        }
        recordId = await this.waitWithinChangeRequestDeadline(
          this.createBitableRecord(
            appToken,
            this.calendarChangeConfig.tableId,
            this.calendarChangeConfig.tableName,
            fields,
            tenantAccessToken,
            {
              clientToken,
              retryNetworkErrors: true,
              deadlineAt,
            },
          ),
          deadlineAt,
          '创建正式记录',
        );
      } catch (error) {
        if (this.isChangeRequestBitableClientTokenConflict(error)) {
          durableState.recordState = 'unknown';
          durableState.retryAction = 'manual-reconcile';
          partialEntry.recordState = 'unknown';
          partialEntry.retryAction = 'manual-reconcile';
          await this.persistChangeRequestManualReconcile(
            request.clientMutationId,
            fingerprint,
            clientToken,
            deadlineAt,
          );
          this.throwStoredChangeRequestPartialFailure(
            request,
            files,
            durableState,
            '飞书返回 Client token conflict，提交结果无法自动确认；请人工核查多维表，禁止再次自动提交',
          );
        }
        throw new BadGatewayException(
          `变更申请正式记录创建失败：${getBitableAxiosErrorMessage(error)}`,
        );
      }

      durableState.recordState = 'created';
      durableState.retryAction = 'retry-same-mutation';
      durableState.recordId = recordId;
      partialEntry.recordState = 'created';
      partialEntry.retryAction = 'retry-same-mutation';
      partialEntry.recordId = recordId;
      recordId = await this.persistChangeRequestRecordId(
        request.clientMutationId,
        fingerprint,
        recordId,
        deadlineAt,
      );
      durableState.recordId = recordId;
      partialEntry.recordId = recordId;
    }

    invalidateBitableRecordCache({
      appToken,
      tableId: this.calendarChangeConfig.tableId,
    });
    const taskId = request.clientMutationId;
    const acceptedRecord = {
      ...this.buildCreatedChangeRequestFallbackRecord(request, recordId),
      submitterName: request.submitterName || null,
      progress: '附件同步中',
    };
    const acceptedResponse: ChangeRequestCreateResponse = {
      success: true,
      clientMutationId: request.clientMutationId,
      record: acceptedRecord,
      pendingSync: true,
      taskId,
      message: '变更申请已受理，附件正在后台同步',
    };

    const activeTask = this.syncTasks.get(taskId);
    if (activeTask?.status === 'pending' || activeTask?.status === 'running') {
      return acceptedResponse;
    }
    if (activeTask?.status === 'completed' && activeTask.result) {
      return activeTask.result as ChangeRequestCreateResponse;
    }

    const task: SyncTask = {
      id: taskId,
      status: 'pending',
      startTime: new Date(),
      message: '变更附件等待后台同步',
    };
    this.syncTasks.set(taskId, task);
    queueMicrotask(() => {
      void this.completeChangeRequestAttachmentsInBackground(
        task,
        request,
        files,
        fingerprint,
        durableState,
      );
    });
    return acceptedResponse;
  }

  private async completeChangeRequestAttachmentsInBackground(
    task: SyncTask,
    request: ChangeRequestCreateRequest,
    files: ChangeRequestUploadFile[],
    fingerprint: string,
    durableState: ChangeRequestMutationDurableState,
  ): Promise<void> {
    task.status = 'running';
    task.message = '变更附件正在后台同步';
    try {
      const response = await this.createChangeRequestNow(
        request,
        files,
        fingerprint,
        durableState,
        Date.now() + CHANGE_REQUEST_SYNC_DEADLINE_MS,
      );
      this.changeRequestMutationPartial.delete(request.clientMutationId);
      this.changeRequestMutationCompleted.set(request.clientMutationId, {
        expiresAt: Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS,
        fingerprint,
        response,
      });
      task.status = 'completed';
      task.endTime = new Date();
      task.total = files.length;
      task.inserted = files.length;
      task.failed = 0;
      task.result = response;
      task.message = '变更申请及附件已同步飞书';
    } catch (error) {
      const partialFailure =
        this.parseChangeRequestAttachmentPartialFailure(error);
      const documents = (partialFailure?.documents || []).map((document) => ({
        ...document,
        ...(document.message
          ? {
              message: this.toSafeChangeRequestAttachmentFailureMessage(
                document.message,
                document.retryable,
              ),
            }
          : {}),
      }));
      const unresolvedDocuments = documents.filter(
        ({ status }) => status !== 'attached',
      );
      const failedNames = unresolvedDocuments
        .slice(0, 3)
        .map(({ name }) => `“${name}”`)
        .join('、');
      const firstFailureReason = unresolvedDocuments[0]?.message;
      const failureAction =
        unresolvedDocuments[0]?.stage === 'record-link' ? '关联' : '上传';
      task.status = 'failed';
      task.endTime = new Date();
      task.total = documents.length || files.length;
      task.inserted = documents.length
        ? documents.length - unresolvedDocuments.length
        : 0;
      task.failed = unresolvedDocuments.length || files.length;
      task.message = unresolvedDocuments.length
        ? `正式记录已建立，附件${failedNames}${failureAction}失败${
            firstFailureReason ? `（${firstFailureReason}）` : ''
          }，请使用原申请重试附件`
        : getBitableAxiosErrorMessage(error) || '变更附件同步失败';
      task.result = partialFailure
        ? {
            code: partialFailure.code,
            clientMutationId: partialFailure.clientMutationId,
            recordState: partialFailure.recordState,
            recordCreated: partialFailure.recordCreated,
            retryAction: partialFailure.retryAction,
            recordId: partialFailure.recordId,
            documents,
          }
        : {
            clientMutationId: request.clientMutationId,
            recordId: durableState.recordId,
          };
      this.logger.warn(
        `变更申请 ${request.clientMutationId} 的后台附件同步失败：${task.message}`,
      );
    }
  }

  private async ensureChangeRequestSubmitterField(
    appToken: string,
    tenantAccessToken: string,
    fieldMetas: BitableFieldMeta[],
    deadlineAt: number,
  ): Promise<BitableFieldMeta[]> {
    const writable = fieldMetas.find(
      (field) => field.field_name === '变更提交人' && field.type === 11,
    );
    if (writable) return fieldMetas;

    const inFlight = this.changeRequestSubmitterFieldMigrationInFlight;
    if (inFlight) return inFlight;

    const migration = this.ensureChangeRequestSubmitterFieldNow(
      appToken,
      tenantAccessToken,
      fieldMetas,
      deadlineAt,
    );
    this.changeRequestSubmitterFieldMigrationInFlight = migration;
    try {
      return await migration;
    } finally {
      if (this.changeRequestSubmitterFieldMigrationInFlight === migration) {
        this.changeRequestSubmitterFieldMigrationInFlight = null;
      }
    }
  }

  private async ensureChangeRequestSubmitterFieldNow(
    appToken: string,
    tenantAccessToken: string,
    fieldMetas: BitableFieldMeta[],
    deadlineAt: number,
  ): Promise<BitableFieldMeta[]> {
    const writable = fieldMetas.find(
      (field) => field.field_name === '变更提交人' && field.type === 11,
    );
    if (writable) return fieldMetas;

    const systemSubmitter = fieldMetas.find(
      (field) => field.field_name === '变更提交人' && field.type === 1003,
    );
    const renamedSystemSubmitter = fieldMetas.find(
      (field) =>
        field.type === 1003 &&
        /^系统创建人(?:（\d+）)?$/.test(field.field_name),
    );
    if (!systemSubmitter && !renamedSystemSubmitter) return fieldMetas;

    const occupiedNames = new Set(fieldMetas.map((field) => field.field_name));
    const fieldsUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${this.calendarChangeConfig.tableId}/fields`;
    const requestConfig = {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      timeout: this.getChangeRequestBoundedAxiosTimeout(
        deadlineAt,
        '迁移变更提交人字段',
      ),
    };
    if (systemSubmitter) {
      let systemFieldName = '系统创建人';
      for (let suffix = 2; occupiedNames.has(systemFieldName); suffix += 1) {
        systemFieldName = `系统创建人（${suffix}）`;
      }
      const renameResponse = await this.runBitableRecordWriteWithRetry(
        () =>
          this.httpService.axiosRef.put(
            `${fieldsUrl}/${systemSubmitter.field_id}`,
            { field_name: systemFieldName, type: 1003 },
            requestConfig,
          ),
        '迁移系统创建人字段',
        true,
        deadlineAt,
      );
      if (renameResponse.data?.code !== 0) {
        throw new BadGatewayException(
          `迁移系统创建人字段失败：${getBitableApiErrorMessage(renameResponse.data)}`,
        );
      }
    }
    const createResponse = await this.runBitableRecordWriteWithRetry(
      () =>
        this.httpService.axiosRef.post(
          fieldsUrl,
          {
            field_name: '变更提交人',
            type: 11,
            property: { multiple: false },
          },
          requestConfig,
        ),
      '创建变更提交人字段',
      true,
      deadlineAt,
    );
    if (createResponse.data?.code !== 0) {
      throw new BadGatewayException(
        `创建变更提交人字段失败：${getBitableApiErrorMessage(createResponse.data)}`,
      );
    }
    invalidateBitableRecordCache({
      appToken,
      tableId: this.calendarChangeConfig.tableId,
    });
    return this.fetchBitableFieldMetas(
      appToken,
      this.calendarChangeConfig.tableId,
      this.calendarChangeConfig.tableName,
      tenantAccessToken,
      deadlineAt,
    );
  }

  private buildChangeRequestBitableFields(
    request: ChangeRequestCreateRequest,
    fieldConfig: ChangeRequestFieldConfig,
    submitterUserId: string,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    this.setBitableFieldValue(fields, fieldConfig.submitter, [
      { id: submitterUserId },
    ]);
    this.setBitableFieldValue(fields, fieldConfig.nature, request.nature);
    if (request.nature === '非标准变更') {
      this.setBitableFieldValue(
        fields,
        fieldConfig.meetingStartAt,
        this.parseShanghaiDateTimeMs(
          request.meetingStartAt || '',
          '会议开始时间',
        ),
      );
      if (request.meetingEndAt) {
        this.setBitableFieldValue(
          fields,
          fieldConfig.meetingEndAt,
          this.parseShanghaiDateTimeMs(request.meetingEndAt, '会议结束时间'),
        );
      }
    }
    this.setBitableFieldValue(fields, fieldConfig.summary, request.summary);
    this.setBitableFieldValue(
      fields,
      fieldConfig.changeType,
      request.changeType,
    );
    this.setBitableFieldValue(fields, fieldConfig.workType, request.workType);
    this.setBitableFieldValue(fields, fieldConfig.buildings, request.buildings);
    this.setBitableFieldValue(
      fields,
      fieldConfig.plannedStartAt,
      this.parseShanghaiDateTimeMs(request.plannedStartAt, '计划开始时间'),
    );
    this.setBitableFieldValue(
      fields,
      fieldConfig.plannedEndAt,
      this.parseShanghaiDateTimeMs(request.plannedEndAt, '计划结束时间'),
    );
    this.setBitableFieldValue(
      fields,
      fieldConfig.discipline,
      request.discipline,
    );
    this.setBitableFieldValue(fields, fieldConfig.level, request.level);
    this.setBitableFieldValue(
      fields,
      fieldConfig.riskSummary,
      request.riskSummary,
    );
    return fields;
  }

  private async createChangeRequestNow(
    request: ChangeRequestCreateRequest,
    files: ChangeRequestUploadFile[],
    fingerprint: string,
    durableState: ChangeRequestMutationDurableState,
    deadlineAt: number,
  ): Promise<ChangeRequestCreateResponse> {
    this.assertChangeRequestDeadline(deadlineAt, '准备同步');
    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new BadRequestException('计划变更日历多维表待配置');
    }

    const [appToken, tenantAccessToken] =
      await this.waitWithinChangeRequestDeadline(
        Promise.all([
          resolveBitableAppToken(this.httpService, {
            ...this.calendarChangeConfig,
            requestTimeoutMs: (stage) =>
              this.getChangeRequestBoundedAxiosTimeout(deadlineAt, stage),
            waitFor: (promise, stage) =>
              this.waitWithinChangeRequestDeadline(promise, deadlineAt, stage),
            waitBeforeRetry: (delayMs, stage) =>
              this.sleepWithinChangeRequestDeadline(delayMs, deadlineAt, stage),
          }),
          this.getFeishuTenantAccessToken(deadlineAt),
        ]),
        deadlineAt,
        '解析飞书鉴权与多维表',
      );
    this.assertChangeRequestDeadline(deadlineAt, '读取多维表字段');
    let fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      this.calendarChangeConfig.tableId,
      this.calendarChangeConfig.tableName,
      tenantAccessToken,
      deadlineAt,
    );
    fieldMetas = await this.ensureChangeRequestSubmitterField(
      appToken,
      tenantAccessToken,
      fieldMetas,
      deadlineAt,
    );
    const fieldConfig = this.resolveChangeRequestFieldConfig(fieldMetas);
    const submitter = await this.resolveChangeRequestSubmitter(
      request.submitterName || '',
      request.submitterId,
    );

    const fields = this.buildChangeRequestBitableFields(
      request,
      fieldConfig,
      submitter.userId,
    );
    const partialEntry = this.getOrCreateChangeRequestPartialEntry(
      request.clientMutationId,
      fingerprint,
    );
    for (const [index, document] of durableState.uploadedByIndex) {
      partialEntry.uploadedByIndex.set(index, document);
    }
    partialEntry.recordState = durableState.recordState;
    partialEntry.retryAction = durableState.retryAction;
    partialEntry.recordId = durableState.recordId;
    const recordWasAlreadyCreated = Boolean(durableState.recordId);
    const uploadOutcomes = await this.uploadChangeRequestDocuments(
      tenantAccessToken,
      appToken,
      files,
      partialEntry.uploadedByIndex,
      request.clientMutationId,
      deadlineAt,
      async (index, file, document) => {
        partialEntry.uploadedByIndex.set(index, document);
        durableState.uploadedByIndex.set(index, document);
        const persisted = await this.persistChangeRequestUploadedDocument(
          request.clientMutationId,
          fingerprint,
          index,
          file,
          document,
          deadlineAt,
        );
        durableState.uploadedByIndex.set(index, persisted);
        return persisted;
      },
    );
    const uploadedDocuments = files.flatMap((_, index) => {
      const uploaded = partialEntry.uploadedByIndex.get(index);
      return uploaded ? [{ index, ...uploaded }] : [];
    });
    const uploadFailureCount = uploadOutcomes.filter(
      (outcome) => outcome?.error || !outcome?.fileToken,
    ).length;
    if (uploadFailureCount > 0) {
      const documentResults = this.buildChangeRequestDocumentSyncResults(
        files,
        uploadOutcomes,
        false,
        recordWasAlreadyCreated
          ? '正式记录已建立，等待附件补传'
          : '等待全部附件上传完成后建立正式记录',
      );
      const permanentFailureCount = documentResults.filter(
        ({ status, retryable }) => status === 'upload_failed' && !retryable,
      ).length;
      if (permanentFailureCount > 0) {
        throw new BadGatewayException(
          recordWasAlreadyCreated
            ? `正式记录已建立，但 ${permanentFailureCount} 个附件被飞书拒绝，请更换附件后重试`
            : `${permanentFailureCount} 个附件被飞书拒绝，正式记录尚未建立，请检查文件或权限后重新提交`,
        );
      }
      partialEntry.expiresAt =
        Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS;
      this.throwChangeRequestAttachmentPartialFailure(
        request,
        documentResults,
        recordWasAlreadyCreated
          ? `正式记录已建立，${uploadFailureCount} 个附件上传失败，请使用原申请重试附件`
          : `尚未建立正式记录，${uploadFailureCount} 个附件上传失败，请重试`,
        recordWasAlreadyCreated
          ? {
              recordState: 'created',
              recordId: durableState.recordId,
              retryAction: 'retry-same-mutation',
            }
          : undefined,
      );
    }

    this.setBitableFieldValue(
      fields,
      fieldConfig.documents,
      uploadedDocuments.map(({ fileToken }) => ({ file_token: fileToken })),
    );

    let recordId = durableState.recordId;
    if (!recordId) {
      let createdRecordId: string;
      const clientToken = this.toChangeRequestBitableClientToken(
        request.clientMutationId,
      );
      try {
        this.assertChangeRequestDeadline(deadlineAt, '创建正式记录');
        if (durableState.recordState !== 'unknown') {
          await this.persistChangeRequestRecordUnknown(
            request.clientMutationId,
            fingerprint,
            clientToken,
            deadlineAt,
          );
          durableState.recordState = 'unknown';
          durableState.retryAction = 'retry-same-mutation';
          partialEntry.recordState = 'unknown';
          partialEntry.retryAction = 'retry-same-mutation';
        }
        createdRecordId = await this.waitWithinChangeRequestDeadline(
          this.createBitableRecord(
            appToken,
            this.calendarChangeConfig.tableId,
            this.calendarChangeConfig.tableName,
            fields,
            tenantAccessToken,
            {
              clientToken,
              retryNetworkErrors: true,
              deadlineAt,
            },
          ),
          deadlineAt,
          '创建正式记录',
        );
      } catch (error) {
        const createError = getBitableAxiosErrorMessage(error);
        if (this.isChangeRequestBitableClientTokenConflict(error)) {
          durableState.recordState = 'unknown';
          durableState.retryAction = 'manual-reconcile';
          partialEntry.recordState = 'unknown';
          partialEntry.retryAction = 'manual-reconcile';
          await this.persistChangeRequestManualReconcile(
            request.clientMutationId,
            fingerprint,
            clientToken,
            deadlineAt,
          );
          const documentResults = this.buildChangeRequestDocumentSyncResults(
            files,
            uploadOutcomes,
            false,
            createError,
          );
          partialEntry.expiresAt =
            Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS;
          this.throwChangeRequestAttachmentPartialFailure(
            request,
            documentResults,
            '飞书返回 Client token conflict，提交结果无法自动确认；已保留原申请标识，请人工核查多维表，禁止再次自动提交',
            {
              recordState: 'unknown',
              retryAction: 'manual-reconcile',
            },
          );
        }
        if (!this.isRetryableChangeRequestRecordCreateError(error)) {
          throw new BadGatewayException(
            `附件已上传，但正式记录创建被飞书拒绝，请检查字段或权限后重新提交：${createError}`,
          );
        }
        const documentResults = this.buildChangeRequestDocumentSyncResults(
          files,
          uploadOutcomes,
          false,
          createError,
        );
        partialEntry.expiresAt =
          Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS;
        this.throwChangeRequestAttachmentPartialFailure(
          request,
          documentResults,
          `附件已上传，但正式记录同步暂未确认，请重试：${createError}`,
          {
            recordState: 'unknown',
            retryAction: 'retry-same-mutation',
          },
        );
      }
      durableState.recordState = 'created';
      durableState.retryAction = 'retry-same-mutation';
      durableState.recordId = createdRecordId;
      partialEntry.recordState = 'created';
      partialEntry.retryAction = 'retry-same-mutation';
      partialEntry.recordId = createdRecordId;
      recordId = await this.persistChangeRequestRecordId(
        request.clientMutationId,
        fingerprint,
        createdRecordId,
        deadlineAt,
      );
      durableState.recordId = recordId;
    } else if (recordWasAlreadyCreated) {
      const documentFields: Record<string, unknown> = {};
      this.setBitableFieldValue(
        documentFields,
        fieldConfig.documents,
        uploadedDocuments.map(({ fileToken }) => ({ file_token: fileToken })),
      );
      await this.updateBitableRecordFields(
        appToken,
        this.calendarChangeConfig.tableId,
        this.calendarChangeConfig.tableName,
        recordId,
        documentFields,
        tenantAccessToken,
      );
    }

    invalidateBitableRecordCache({
      appToken,
      tableId: this.calendarChangeConfig.tableId,
    });
    const documentResults = this.buildChangeRequestDocumentSyncResults(
      files,
      uploadOutcomes,
      true,
      '',
    );
    const incompleteDocumentCount = documentResults.filter(
      ({ status }) => status === 'upload_failed',
    ).length;
    if (incompleteDocumentCount > 0) {
      throw new Error('变更申请记录已建立，但附件状态不完整');
    }
    const savedRecord = await (async () => {
      this.assertChangeRequestDeadline(deadlineAt, '回读正式记录');
      return this.fetchBitableRecordById(
        appToken,
        this.calendarChangeConfig.tableId,
        this.calendarChangeConfig.tableName,
        recordId,
        tenantAccessToken,
        deadlineAt,
      );
    })().catch((error: unknown) => {
      this.logger.warn(
        `变更申请 ${recordId} 已写入，但定向回读失败，使用提交快照返回：${getBitableAxiosErrorMessage(error)}`,
      );
      return null;
    });
    let mappedRecord: ChangeRequestCreateResponse['record'] =
      (savedRecord ? this.mapFeishuCalendarChangeRecord(savedRecord) : null) ||
      this.buildCreatedChangeRequestFallbackRecord(request, recordId);

    try {
      await this.bindStagedChangeRequestDocuments(
        files,
        partialEntry.uploadedByIndex,
        recordId,
        request.clientMutationId,
        deadlineAt,
      );
    } catch {
      partialEntry.expiresAt =
        Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS;
      this.logger.warn(`变更申请 ${recordId} 的对象存储附件绑定失败`);
      this.throwChangeRequestAttachmentPartialFailure(
        request,
        documentResults.map((document, index) =>
          files[index]?.storageId
            ? {
                ...document,
                status: 'uploaded_pending_attach' as const,
                retryable: true,
                message: '对象存储附件绑定失败，请使用原申请重试',
              }
            : document,
        ),
        '正式记录已建立，但对象存储附件绑定失败，请使用原申请重试',
        {
          recordState: 'created',
          recordId,
          retryAction: 'retry-same-mutation',
        },
      );
    }

    if (savedRecord && mappedRecord) {
      try {
        const enrichedRecord = await extendChangeInfoWithAdjustmentRecord(
          mappedRecord,
          savedRecord,
          {
            resolveStorage: async ({ recordId: boundRecordId, fileToken }) => {
              const storage = this.changeAttachmentStorage;
              if (!storage) return null;
              const metadata =
                await storage.findByFileTokenForTrustedServer(fileToken);
              if (!metadata || metadata.boundRecordId !== boundRecordId) {
                return null;
              }
              return {
                id: metadata.id,
                filePath: metadata.filePath,
                bucketId: metadata.bucketId,
                url: metadata.url,
              };
            },
          },
        );
        if (enrichedRecord) mappedRecord = enrichedRecord;
      } catch (error) {
        this.logger.warn(
          `变更申请 ${recordId} 附件扩展映射失败，已保留基础记录：${getBitableAxiosErrorMessage(error)}`,
        );
      }
    }

    const response: ChangeRequestCreateResponse = {
      success: true,
      clientMutationId: request.clientMutationId,
      record: mappedRecord,
      message: `变更申请已提交：${request.summary}`,
    };
    return this.persistCompletedChangeRequestMutation(
      request.clientMutationId,
      fingerprint,
      recordId,
      response,
      deadlineAt,
    );
  }

  private getOrCreateChangeRequestPartialEntry(
    clientMutationId: string,
    fingerprint: string,
  ): ChangeRequestMutationPartialEntry {
    const existing = this.changeRequestMutationPartial.get(clientMutationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ConflictException(
          '相同 clientMutationId 已用于内容不同的待补传变更申请',
        );
      }
      existing.expiresAt =
        Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS;
      return existing;
    }

    const entry: ChangeRequestMutationPartialEntry = {
      expiresAt: Date.now() + CHANGE_REQUEST_MUTATION_COMPLETED_TTL_MS,
      fingerprint,
      uploadedByIndex: new Map(),
      recordState: 'not-created',
      retryAction: 'retry-same-mutation',
    };
    this.changeRequestMutationPartial.set(clientMutationId, entry);
    while (
      this.changeRequestMutationPartial.size >
      CHANGE_REQUEST_MUTATION_COMPLETED_MAX_ENTRIES
    ) {
      const oldestKey = this.changeRequestMutationPartial.keys().next()
        .value as string | undefined;
      if (!oldestKey || oldestKey === clientMutationId) break;
      this.changeRequestMutationPartial.delete(oldestKey);
    }
    return entry;
  }

  private async bindStagedChangeRequestDocuments(
    files: ChangeRequestUploadFile[],
    uploadedByIndex: Map<number, ChangeRequestUploadedDocument>,
    recordId: string,
    ownerMutationId: string,
    deadlineAt: number,
  ): Promise<void> {
    const stagedIndexes = files
      .map((file, index) => (file.storageId ? index : -1))
      .filter((index) => index >= 0);
    if (stagedIndexes.length === 0) return;
    const storage = this.changeAttachmentStorage;
    if (!storage) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    for (const index of stagedIndexes) {
      const file = files[index];
      const uploaded = uploadedByIndex.get(index);
      if (!file.storageId || !uploaded?.fileToken) {
        throw new Error(`变更附件 ${index + 1} 缺少绑定信息`);
      }
      await this.waitWithinChangeRequestDeadline(
        storage.bindToRecord(file.storageId, recordId, uploaded.fileToken, {
          ownerMutationId,
        }),
        deadlineAt,
        `绑定变更附件 ${index + 1}`,
      );
    }
  }

  private async uploadChangeRequestDocument(
    tenantAccessToken: string,
    appToken: string,
    file: ChangeRequestUploadFile,
    ownerMutationId: string,
    deadlineAt: number,
  ): Promise<string> {
    const name =
      normalizeConstructionUploadFileName(file.originalname) || '未命名文件';
    if (!file.storageId) {
      return this.uploadBitableAttachment(
        tenantAccessToken,
        appToken,
        file as ConstructionUploadFile,
        `变更文档“${name}”`,
        deadlineAt,
        {
          maxAttempts: CHANGE_REQUEST_ATTACHMENT_UPLOAD_MAX_ATTEMPTS,
          requestTimeoutMs: CHANGE_REQUEST_ATTACHMENT_REQUEST_TIMEOUT_MS,
        },
      );
    }
    return this.uploadStagedChangeRequestAttachment(
      tenantAccessToken,
      appToken,
      file,
      ownerMutationId,
      deadlineAt,
    );
  }

  private async uploadStagedChangeRequestAttachment(
    tenantAccessToken: string,
    appToken: string,
    file: ChangeRequestUploadFile,
    ownerMutationId: string,
    deadlineAt: number,
  ): Promise<string> {
    const storage = this.changeAttachmentStorage;
    if (!storage || !file.storageId) {
      throw new ServiceUnavailableException('变更附件对象存储尚未配置');
    }
    const name =
      normalizeConstructionUploadFileName(file.originalname) || '未命名文件';
    const accessContext = { ownerMutationId } as const;
    let signatureValidated = file.signatureValidated === true;
    if (
      !signatureValidated &&
      file.size > BITABLE_ATTACHMENT_SINGLE_UPLOAD_MAX_BYTES
    ) {
      const header = await storage.readRange(
        file.storageId,
        0,
        Math.min(file.size - 1, 1023),
        accessContext,
      );
      this.assertStagedChangeRequestDocumentSignature(file, header, false);
      signatureValidated = true;
    }

    return uploadStagedBitableAttachment(
      {
        id: file.storageId,
        name,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size,
      },
      appToken,
      {
        readAll: async (id) => {
          const contents =
            file.buffer || (await storage.readAll(id, accessContext));
          if (!signatureValidated) {
            this.assertStagedChangeRequestDocumentSignature(
              file,
              contents,
              true,
            );
            signatureValidated = true;
          }
          return contents;
        },
        readRange: (id, start, end) =>
          storage.readRange(id, start, end, accessContext),
        uploadAll: (_attachment, contents) =>
          this.uploadBitableAttachment(
            tenantAccessToken,
            appToken,
            {
              fieldname: 'documents',
              originalname: name,
              mimetype: file.mimetype,
              size: file.size,
              buffer: contents,
            } as ConstructionUploadFile,
            `变更文档“${name}”`,
            deadlineAt,
            {
              maxAttempts: CHANGE_REQUEST_ATTACHMENT_UPLOAD_MAX_ATTEMPTS,
              requestTimeoutMs: CHANGE_REQUEST_ATTACHMENT_REQUEST_TIMEOUT_MS,
            },
          ),
        prepare: async (payload: BitableMultipartPreparePayload) => {
          const data = await this.postChangeRequestMultipartRequest(
            appToken,
            name,
            '变更文档分片准备',
            deadlineAt,
            () =>
              this.httpService.axiosRef.post(
                'https://open.feishu.cn/open-apis/drive/v1/medias/upload_prepare',
                payload,
                {
                  headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                  },
                  timeout: this.getChangeRequestBoundedAxiosTimeout(
                    deadlineAt,
                    `准备分片附件 ${name}`,
                    CHANGE_REQUEST_ATTACHMENT_REQUEST_TIMEOUT_MS,
                  ),
                },
              ),
          );
          return {
            uploadId: String(data.upload_id || ''),
            blockSize: Number(data.block_size),
            blockNum: Number(data.block_num),
          };
        },
        uploadPart: async (part: BitableMultipartPart) => {
          await this.postChangeRequestMultipartRequest(
            appToken,
            name,
            `变更文档分片 ${part.seq + 1}`,
            deadlineAt,
            () => {
              const form = new FormData();
              form.append('upload_id', part.uploadId);
              form.append('seq', String(part.seq));
              form.append('size', String(part.size));
              form.append('file', part.file, {
                filename: name,
                contentType: file.mimetype || 'application/octet-stream',
              });
              return this.httpService.axiosRef.post(
                'https://open.feishu.cn/open-apis/drive/v1/medias/upload_part',
                form,
                {
                  headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    ...form.getHeaders(),
                    'Content-Length': form.getLengthSync(),
                  },
                  maxBodyLength: Infinity,
                  timeout: this.getChangeRequestBoundedAxiosTimeout(
                    deadlineAt,
                    `上传附件分片 ${part.seq + 1}`,
                    CHANGE_REQUEST_ATTACHMENT_REQUEST_TIMEOUT_MS,
                  ),
                },
              );
            },
          );
        },
        finish: async (payload: BitableMultipartFinishPayload) => {
          const data = await this.postChangeRequestMultipartRequest(
            appToken,
            name,
            '变更文档分片完成',
            deadlineAt,
            () =>
              this.httpService.axiosRef.post(
                'https://open.feishu.cn/open-apis/drive/v1/medias/upload_finish',
                {
                  upload_id: payload.uploadId,
                  block_num: payload.blockNum,
                },
                {
                  headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                  },
                  timeout: this.getChangeRequestBoundedAxiosTimeout(
                    deadlineAt,
                    `完成分片附件 ${name}`,
                    CHANGE_REQUEST_ATTACHMENT_REQUEST_TIMEOUT_MS,
                  ),
                },
              ),
          );
          const fileToken = String(data.file_token || data.media_token || '');
          if (!fileToken) {
            throw new Error('变更文档分片完成失败：响应中缺少 file_token');
          }
          return fileToken;
        },
      },
    );
  }

  private async postChangeRequestMultipartRequest(
    appToken: string,
    fileName: string,
    contextLabel: string,
    deadlineAt: number,
    request: () => Promise<{
      data?: {
        code?: number;
        msg?: string;
        data?: Record<string, unknown>;
      };
    }>,
  ): Promise<Record<string, unknown>> {
    const response = await this.runConstructionAttachmentUploadWithRetry(
      async () => {
        try {
          const result = await this.runBitableAttachmentUploadSerially(
            appToken,
            request,
            deadlineAt,
          );
          if (result.data?.code !== 0) {
            throw Object.assign(
              new Error(
                `${contextLabel}失败：${result.data?.msg || result.data?.code}`,
              ),
              { code: result.data?.code, response: result },
            );
          }
          return result;
        } catch (error) {
          throw this.createBitableAttachmentUploadError(contextLabel, error);
        }
      },
      fileName,
      contextLabel,
      deadlineAt,
      CHANGE_REQUEST_ATTACHMENT_UPLOAD_MAX_ATTEMPTS,
    );
    return response.data?.data || {};
  }

  private async uploadChangeRequestDocuments(
    tenantAccessToken: string,
    appToken: string,
    files: ChangeRequestUploadFile[],
    uploadedByIndex: Map<number, ChangeRequestUploadedDocument>,
    ownerMutationId: string,
    deadlineAt: number,
    persistUploaded: (
      index: number,
      file: ChangeRequestUploadFile,
      document: ChangeRequestUploadedDocument,
    ) => Promise<ChangeRequestUploadedDocument>,
  ): Promise<ChangeRequestDocumentUploadOutcome[]> {
    const outcomes: ChangeRequestDocumentUploadOutcome[] = files.map(
      (_, index) => {
        const uploaded = uploadedByIndex.get(index);
        return uploaded ? { fileToken: uploaded.fileToken } : {};
      },
    );
    const pendingIndexes = files
      .map((_, index) => index)
      .filter((index) => !uploadedByIndex.has(index));
    let cursor = 0;
    const worker = async () => {
      while (cursor < pendingIndexes.length) {
        const index = pendingIndexes[cursor];
        cursor += 1;
        const file = files[index];
        const name =
          normalizeConstructionUploadFileName(file.originalname) ||
          '未命名文件';
        try {
          this.assertChangeRequestDeadline(deadlineAt, `上传附件 ${name}`);
          const fileToken = await this.uploadChangeRequestDocument(
            tenantAccessToken,
            appToken,
            file,
            ownerMutationId,
            deadlineAt,
          );
          const uploaded = await persistUploaded(index, file, {
            fileToken,
            name,
            size: file.size,
            ...(file.storageId ? { storageId: file.storageId } : {}),
          });
          uploadedByIndex.set(index, uploaded);
          outcomes[index] = { fileToken: uploaded.fileToken };
        } catch (error) {
          outcomes[index] = {
            error: getBitableAxiosErrorMessage(error),
            retryable: this.isRetryableConstructionAttachmentUploadError(error),
          };
        }
      }
    };
    const workerCount = Math.min(
      CHANGE_REQUEST_ATTACHMENT_UPLOAD_CONCURRENCY,
      pendingIndexes.length,
    );
    await this.waitWithinChangeRequestDeadline(
      Promise.all(Array.from({ length: workerCount }, () => worker())),
      deadlineAt,
      '等待附件上传完成',
    );
    return outcomes;
  }

  private buildChangeRequestDocumentSyncResults(
    files: ChangeRequestUploadFile[],
    outcomes: ChangeRequestDocumentUploadOutcome[],
    recordCreated: boolean,
    recordError: string,
  ): ChangeRequestDocumentSyncResult[] {
    return files.map((file, index) => {
      const name =
        normalizeConstructionUploadFileName(file.originalname) || '未命名文件';
      const outcome = outcomes[index];
      if (outcome?.error || !outcome?.fileToken) {
        return {
          name,
          size: file.size,
          status: 'upload_failed',
          stage: 'upload',
          retryable: outcome?.retryable === true,
          message: outcome?.error || '附件上传未返回文件标识',
        };
      }
      if (!recordCreated) {
        return {
          name,
          size: file.size,
          status: 'uploaded_pending_attach',
          stage: 'record-link',
          retryable: true,
          message: recordError || '等待正式记录创建',
        };
      }
      return {
        name,
        size: file.size,
        status: 'attached',
        stage: 'record-link',
        retryable: false,
      };
    });
  }

  private throwChangeRequestAttachmentPartialFailure(
    request: ChangeRequestCreateRequest,
    documents: ChangeRequestDocumentSyncResult[],
    message: string,
    options: {
      recordState?: ChangeRequestRecordState;
      recordId?: string;
      retryAction?: ChangeRequestRetryAction;
    } = {},
  ): never {
    const recordState = options.recordState ?? 'not-created';
    const retryAction = options.retryAction ?? 'retry-same-mutation';
    const temporaryRecordId = `change-request-pending-${request.clientMutationId}`;
    const recordId = options.recordId || temporaryRecordId;
    const pendingRecord = {
      ...this.buildCreatedChangeRequestFallbackRecord(request, recordId),
      bitableRecordId: recordState === 'created' ? recordId : '',
      progress:
        recordState === 'unknown'
          ? '提交结果待确认'
          : recordState === 'created'
            ? '已提交待确认'
            : '附件待补传',
      recordUrl:
        recordState === 'created'
          ? this.buildBitableRecordUrl(this.calendarChangeConfig, recordId)
          : null,
    };
    const details: ChangeRequestAttachmentPartialFailure = {
      code: CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE_CODE,
      clientMutationId: request.clientMutationId,
      recordState,
      recordCreated:
        recordState === 'created'
          ? true
          : recordState === 'not-created'
            ? false
            : null,
      retryAction,
      recordId,
      record: pendingRecord,
      documents,
      message,
    };
    throw new BusinessException(
      ResponseCode.BAD_GATEWAY,
      message,
      HttpStatus.BAD_GATEWAY,
      JSON.stringify(details),
    );
  }

  private parseChangeRequestAttachmentPartialFailure(
    error: unknown,
  ): ChangeRequestAttachmentPartialFailure | null {
    const details = (error as { details?: unknown })?.details;
    if (typeof details !== 'string' || !details.trim()) return null;
    try {
      const parsed = JSON.parse(
        details,
      ) as Partial<ChangeRequestAttachmentPartialFailure>;
      if (
        parsed.code !== CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE_CODE ||
        typeof parsed.clientMutationId !== 'string' ||
        !Array.isArray(parsed.documents)
      ) {
        return null;
      }
      return parsed as ChangeRequestAttachmentPartialFailure;
    } catch {
      return null;
    }
  }

  private toSafeChangeRequestAttachmentFailureMessage(
    message: string,
    retryable: boolean,
  ): string {
    if (/绑定失败|关联失败/.test(message)) return '附件关联暂时失败';
    if (/ETIMEDOUT/i.test(message)) return '网络连接超时（ETIMEDOUT）';
    if (/ECONNABORTED/i.test(message)) return '上传请求超时（ECONNABORTED）';
    if (/ECONNRESET/i.test(message)) return '网络连接被重置（ECONNRESET）';
    if (/ENETDOWN|ENETUNREACH/i.test(message)) return '网络暂不可用';
    const httpStatus = message.match(/HTTP\s+(\d{3})/i)?.[1];
    if (httpStatus) return `飞书接口返回 HTTP ${httpStatus}`;
    const feishuCode = message.match(/\b(\d{6,})\b/)?.[1];
    if (feishuCode) return `飞书接口错误码 ${feishuCode}`;
    return retryable ? '飞书附件接口暂时不可用' : '飞书拒绝附件上传';
  }

  private throwStoredChangeRequestPartialFailure(
    request: ChangeRequestCreateRequest,
    files: ChangeRequestUploadFile[],
    durableState: ChangeRequestMutationDurableState,
    message: string,
  ): never {
    const outcomes: ChangeRequestDocumentUploadOutcome[] = files.map(
      (_, index) => {
        const uploaded = durableState.uploadedByIndex.get(index);
        return uploaded
          ? { fileToken: uploaded.fileToken }
          : { error: message, retryable: true };
      },
    );
    const documents = this.buildChangeRequestDocumentSyncResults(
      files,
      outcomes,
      durableState.recordState === 'created',
      message,
    );
    this.throwChangeRequestAttachmentPartialFailure(
      request,
      documents,
      message,
      {
        recordState: durableState.recordId
          ? 'created'
          : durableState.recordState,
        recordId: durableState.recordId,
        retryAction: durableState.retryAction,
      },
    );
  }

  private throwChangeRequestDeadlinePartialFailure(
    request: ChangeRequestCreateRequest,
    files: ChangeRequestUploadFile[],
    durableState: ChangeRequestMutationDurableState,
    error: ChangeRequestDeadlineExceededError,
  ): never {
    const partialEntry = this.changeRequestMutationPartial.get(
      request.clientMutationId,
    );
    if (partialEntry?.fingerprint === durableState.fingerprint) {
      for (const [index, document] of partialEntry.uploadedByIndex) {
        durableState.uploadedByIndex.set(index, document);
      }
      if (partialEntry.recordState !== 'not-created') {
        durableState.recordState = partialEntry.recordState;
      }
      durableState.retryAction = partialEntry.retryAction;
      durableState.recordId ||= partialEntry.recordId;
    }
    const recordState = durableState.recordId
      ? 'created'
      : durableState.recordState;
    const outcomes: ChangeRequestDocumentUploadOutcome[] = files.map(
      (_, index) => {
        const uploaded = durableState.uploadedByIndex.get(index);
        return uploaded
          ? { fileToken: uploaded.fileToken }
          : {
              error: error.message,
              retryable: true,
            };
      },
    );
    const documents = this.buildChangeRequestDocumentSyncResults(
      files,
      outcomes,
      recordState === 'created',
      error.message,
    );
    this.throwChangeRequestAttachmentPartialFailure(
      request,
      documents,
      `${error.message}，申请草稿与已完成同步进度已保留，请重试`,
      {
        recordState,
        recordId: durableState.recordId,
        retryAction: durableState.retryAction,
      },
    );
  }

  private isChangeRequestBitableClientTokenConflict(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 4; depth += 1) {
      if (typeof current !== 'object' || current === null) break;
      const record = current as {
        cause?: unknown;
        code?: unknown;
        data?: { code?: unknown };
        message?: unknown;
        response?: { data?: { code?: unknown } };
      };
      if (
        String(record.code ?? '') === '1255006' ||
        String(record.data?.code ?? '') === '1255006' ||
        String(record.response?.data?.code ?? '') === '1255006' ||
        (typeof record.message === 'string' &&
          /(?:^|\D)1255006(?:\D|$)/.test(record.message))
      ) {
        return true;
      }
      current = record.cause;
    }
    return false;
  }

  private isRetryableChangeRequestRecordCreateError(error: unknown): boolean {
    if (error instanceof ChangeRequestDeadlineExceededError) return true;
    if (this.isRetryableFeishuRequestError(error)) return true;
    const message = getBitableAxiosErrorMessage(error);
    return /1254290|1254291|1254607|1254608|1255001|1255002|1255040|too many request|write conflict|data not ready|duplicate|internal error|rpc error|request timeout|写入成功但未返回记录 ID/i.test(
      message,
    );
  }

  private assertChangeRequestDeadline(
    deadlineAt: number | undefined,
    stage: string,
  ): number {
    if (deadlineAt === undefined) return Number.POSITIVE_INFINITY;
    const remainingMs = Math.floor(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      throw new ChangeRequestDeadlineExceededError(stage);
    }
    return remainingMs;
  }

  private getChangeRequestBoundedAxiosTimeout(
    deadlineAt: number | undefined,
    stage: string,
    maxTimeoutMs = 30_000,
  ): number {
    const remainingMs = this.assertChangeRequestDeadline(deadlineAt, stage);
    return Number.isFinite(remainingMs)
      ? Math.max(1, Math.min(maxTimeoutMs, remainingMs))
      : maxTimeoutMs;
  }

  private async sleepWithinChangeRequestDeadline(
    delayMs: number,
    deadlineAt: number | undefined,
    stage: string,
  ): Promise<void> {
    if (deadlineAt === undefined) {
      await this.sleep(delayMs);
      return;
    }
    const remainingMs = this.assertChangeRequestDeadline(deadlineAt, stage);
    if (delayMs >= remainingMs) {
      throw new ChangeRequestDeadlineExceededError(stage);
    }
    await this.waitWithinChangeRequestDeadline(
      this.sleep(delayMs),
      deadlineAt,
      stage,
    );
    this.assertChangeRequestDeadline(deadlineAt, stage);
  }

  private async waitWithinChangeRequestDeadline<T>(
    promise: Promise<T>,
    deadlineAt: number | undefined,
    stage: string,
  ): Promise<T> {
    if (deadlineAt === undefined) return promise;
    const remainingMs = this.assertChangeRequestDeadline(deadlineAt, stage);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new ChangeRequestDeadlineExceededError(stage)),
        remainingMs,
      );
    });
    try {
      return await Promise.race([promise, deadlinePromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private buildCreatedChangeRequestFallbackRecord(
    request: ChangeRequestCreateRequest,
    recordId: string,
  ): YearlyChangeInfoResponse['changes'][number] {
    const now = new Date().toISOString();
    return {
      id: recordId,
      bitableRecordId: recordId,
      title: request.summary,
      startDate: request.plannedStartAt,
      endDate: request.plannedEndAt,
      actualStartDate: null,
      actualEndDate: null,
      plannedDelayStartDate: null,
      plannedDelayEndDate: null,
      level: request.level,
      type: request.changeType,
      progress: null,
      executor: null,
      buildings: [...request.buildings],
      riskSummary: request.riskSummary,
      isKey: request.level === '高',
      recordUrl: this.buildBitableRecordUrl(
        this.calendarChangeConfig,
        recordId,
      ),
      createdAt: now,
      updatedAt: now,
    };
  }

  async createLeaveRequest(
    request: LeaveRequestCreateRequest,
    screenshot?: ConstructionUploadFile,
    principal?: AccessPrincipal,
  ): Promise<LeaveRequestCreateResponse> {
    const validatedScreenshot = this.validateLeaveRequestScreenshot(screenshot);
    const clientMutationId = this.normalizeDutyStaffRepairValue(
      request?.clientMutationId || '',
    );
    if (!clientMutationId) {
      throw new BadRequestException('请休假请求缺少 clientMutationId');
    }
    if (clientMutationId.length > LEAVE_REQUEST_MUTATION_ID_MAX_LENGTH) {
      throw new BadRequestException(
        `clientMutationId 长度不能超过 ${LEAVE_REQUEST_MUTATION_ID_MAX_LENGTH}`,
      );
    }
    // Verify the actor before replay too; an existing mutation must not bypass identity checks.
    const authenticatedStaff = principal && /^(?:feishu-|local-external-)/.test(principal.accountId || '')
      ? await this.resolveLeaveRequestStaff(request.leaveStaffName, undefined, principal)
      : undefined;
    return this.withLeaveRequestMutationIdempotency(
      clientMutationId,
      request,
      validatedScreenshot,
      (replayState) =>
        this.createLeaveRequestNow(
          request,
          clientMutationId,
          validatedScreenshot,
          replayState,
          authenticatedStaff,
        ),
      () =>
        this.reconcilePersistedLeaveRequest(
          request,
          clientMutationId,
          validatedScreenshot,
        ),
    );
  }

  private async createLeaveRequestNow(
    request: LeaveRequestCreateRequest,
    clientMutationId: string,
    screenshot: ConstructionUploadFile,
    replayState: LeaveRequestMutationReplayState,
    authenticatedStaff?: { userId?: string; personRecordId: string },
  ): Promise<LeaveRequestCreateResponse> {
    const leaveStaffName = this.normalizeDutyStaffRepairValue(
      request?.leaveStaffName || '',
    );
    const leaveType = this.normalizeDutyStaffRepairValue(
      request?.leaveType || '',
    );
    const leaveReason = this.normalizeDutyStaffRepairValue(
      request?.leaveReason || '',
    );
    if (
      request?.needSubstitute !== undefined &&
      request?.needSubstitute !== null &&
      typeof request.needSubstitute !== 'boolean'
    ) {
      throw new BadRequestException('是否需要替班必须为布尔值');
    }
    if (!leaveStaffName) {
      throw new BadRequestException('请填写请休假人员');
    }
    if (!LEAVE_REQUEST_TYPES.has(leaveType as LeaveRequestType)) {
      throw new BadRequestException('请选择有效的休假类型');
    }
    if (!leaveReason) {
      throw new BadRequestException('请填写请假原因');
    }
    if (leaveReason.length > LEAVE_REQUEST_REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `请假原因不能超过 ${LEAVE_REQUEST_REASON_MAX_LENGTH} 个字符`,
      );
    }
    if (!this.hasBitableSourceConfig(this.leaveSubstituteConfig)) {
      throw new BadRequestException(
        `${this.leaveSubstituteConfig.tableName}多维表待配置`,
      );
    }
    const expectedImpactKey = createLeaveRequestImpactComparisonKey(
      request?.expectedImpact,
    );
    if (!expectedImpactKey) {
      throw new BadRequestException('请休假请求缺少有效的排班工时预览');
    }

    const { startAt, endAt, start, end } = this.normalizeLeaveRequestDateRange(
      request?.startAt,
      request?.endAt,
    );

    const requestFingerprint = this.buildLeaveRequestMutationFingerprint(
      request,
      screenshot,
    );
    if (replayState.preparedWrite) {
      if (replayState.preparedWrite.requestFingerprint !== requestFingerprint) {
        throw new BadRequestException(
          'clientMutationId 重复但请休假内容不同，请重新打开申请后提交',
        );
      }
      return this.createPreparedLeaveRequestRecord(
        request,
        clientMutationId,
        replayState.preparedWrite,
      );
    }
    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, this.leaveSubstituteConfig),
      this.getFeishuTenantAccessToken(),
    ]);
    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      this.leaveSubstituteConfig.tableId,
      this.leaveSubstituteConfig.tableName,
      tenantAccessToken,
    );
    const fieldConfig = this.resolveLeaveRequestFieldConfig(fieldMetas);
    const leaveProgramWorkflowFields = isLeaveProgramWorkflowEnabled()
      ? this.resolveLeaveProgramWorkflowInitialFieldConfig(fieldMetas)
      : null;
    const persistedRequest = await this.findPersistedLeaveRequest(
      appToken,
      clientMutationId,
      requestFingerprint,
    );
    if (persistedRequest) {
      return this.buildPersistedLeaveRequestResponse(
        request,
        clientMutationId,
        persistedRequest.recordId,
      );
    }
    const queryStartDate = new Date(`${start.dateKey}T00:00:00.000Z`);
    queryStartDate.setUTCDate(queryStartDate.getUTCDate() - 1);
    const scheduleStartDate = queryStartDate.toISOString().slice(0, 10);
    const queryEndDate = new Date(`${end.dateKey}T00:00:00.000Z`);
    queryEndDate.setUTCDate(queryEndDate.getUTCDate() + 1);
    const scheduleEndDate = queryEndDate.toISOString().slice(0, 10);
    const schedules = await this.getMonthlySchedulesFromFeishu(
      scheduleStartDate,
      scheduleEndDate,
      true,
      true,
    );
    const impactSchedules = schedules.map((schedule) => ({
      recordId: schedule.recordId,
      scheduleDate: schedule.scheduleDate,
      building: schedule.building,
      buildingText: schedule.buildingText,
      team: schedule.team,
      teamText: schedule.teamText,
      shift: schedule.shift,
      shiftText: schedule.shiftText,
      dutyStaffActual: schedule.dutyStaffActual,
    }));
    const impact = calculateLeaveRequestImpact(impactSchedules, {
      leaveStaffName,
      startAt,
      endAt,
    });
    const authoritativeImpactKey =
      createLeaveRequestImpactComparisonKey(impact);
    if (
      !authoritativeImpactKey ||
      authoritativeImpactKey !== expectedImpactKey
    ) {
      throw new ConflictException({
        message: '排班已发生变化，本次未提交，请核对最新班次和工时后再次确认',
        latestImpact: impact,
        writeDisposition: 'definitely-not-written',
      });
    }
    if (impact.invalidRange) {
      throw new BadRequestException('休假时间范围无效，不能提交请休假');
    }
    if (impact.unrecognizedShifts.length > 0) {
      throw new BadRequestException(
        `存在无法识别的班次：${impact.unrecognizedShifts.join('、')}，不能提交请休假`,
      );
    }
    if (impact.missingCalendarYears.length > 0) {
      throw new BadRequestException(
        `缺少 ${impact.missingCalendarYears.join('、')} 年工作日历，不能提交请休假`,
      );
    }
    const timeCandidates = createLeaveRequestTimeCandidates(impactSchedules, {
      leaveStaffName,
    });
    if (!timeCandidates.startOptions.includes(startAt)) {
      throw new BadRequestException('休假开始时间不在该人员的实际排班时段内');
    }
    if (!timeCandidates.endOptions.includes(endAt)) {
      throw new BadRequestException('休假结束时间不在该人员的实际排班时段内');
    }
    if (impact.rawHours < 4) {
      throw new BadRequestException(
        `休假工时不足 4 小时（实际 ${impact.rawHours} 小时），不能提交请休假`,
      );
    }
    const { userId: leaveStaffUserId } =
      authenticatedStaff ?? (await this.resolveLeaveRequestStaff(leaveStaffName));
    let screenshotFileToken: string;
    try {
      screenshotFileToken = await this.uploadBitableAttachment(
        tenantAccessToken,
        appToken,
        screenshot,
        '请休假流程截图',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw this.createLeaveRequestDefinitelyNotWrittenException(
        `流程截图上传失败，尚未建立请休假记录：${message}`,
        error,
      );
    }
    const fields: Record<string, unknown> = {};
    this.setBitableFieldValue(fields, fieldConfig.startDate, start.epochMs);
    this.setBitableFieldValue(fields, fieldConfig.endDate, end.epochMs);
    this.setBitableFieldValue(fields, fieldConfig.leaveType, leaveType);
    this.setBitableFieldValue(fields, fieldConfig.leaveReason, leaveReason);
    this.setBitableFieldValue(
      fields,
      fieldConfig.leaveStaffProgramName,
      leaveStaffName,
    );
    const leaveStaffUserValue = leaveStaffUserId
      ? [{ id: leaveStaffUserId }]
      : undefined;
    if (leaveStaffUserValue) {
      this.setBitableFieldValue(
        fields,
        fieldConfig.leaveStaffUser,
        leaveStaffUserValue,
      );
    }
    if (fieldConfig.legacyLeaveStaffUser && leaveStaffUserValue) {
      this.setBitableFieldValue(
        fields,
        fieldConfig.legacyLeaveStaffUser,
        leaveStaffUserValue,
      );
    }
    this.setBitableFieldValue(fields, fieldConfig.needSubstitute, false);
    this.setBitableFieldValue(fields, fieldConfig.substituteStaff, undefined);
    this.setBitableFieldValue(fields, fieldConfig.workHours, impact.rawHours);
    this.setBitableFieldValue(
      fields,
      fieldConfig.minimumHours,
      impact.rawHours,
    );
    this.setBitableFieldValue(
      fields,
      fieldConfig.requestUniqueId,
      clientMutationId,
    );
    this.setBitableFieldValue(
      fields,
      fieldConfig.requestFingerprint,
      requestFingerprint,
    );
    this.setBitableFieldValue(
      fields,
      fieldConfig.impactScheduleRecordIds,
      impact.affectedSchedules
        .map((schedule) => schedule.recordId)
        .filter(Boolean)
        .join(','),
    );
    this.setBitableFieldValue(fields, fieldConfig.screenshot, [
      { file_token: screenshotFileToken },
    ]);
    if (leaveProgramWorkflowFields) {
      this.setBitableFieldValue(
        fields,
        leaveProgramWorkflowFields.approvalSource,
        '程序卡片',
      );
      this.setBitableFieldValue(
        fields,
        leaveProgramWorkflowFields.workflowStatus,
        '待路由',
      );
    }
    const preparedWrite: LeaveRequestMutationPreparedWrite = {
      appToken,
      tableId: this.leaveSubstituteConfig.tableId,
      tableName: this.leaveSubstituteConfig.tableName,
      fields: JSON.parse(JSON.stringify(fields)) as Record<string, unknown>,
      requestFingerprint,
      reconcileOnly: false,
    };
    replayState.preparedWrite = preparedWrite;
    return this.createPreparedLeaveRequestRecord(
      request,
      clientMutationId,
      preparedWrite,
      tenantAccessToken,
    );
  }

  private async createPreparedLeaveRequestRecord(
    request: LeaveRequestCreateRequest,
    clientMutationId: string,
    preparedWrite: LeaveRequestMutationPreparedWrite,
    providedTenantAccessToken?: string,
  ): Promise<LeaveRequestCreateResponse> {
    if (preparedWrite.reconcileOnly) {
      throw new LeaveRequestAmbiguousWriteError(
        '请休假写入结果未知，请使用原申请标识安全重试',
        undefined,
      );
    }
    const tenantAccessToken =
      providedTenantAccessToken || (await this.getFeishuTenantAccessToken());
    let recordId: string;
    try {
      recordId = await this.createBitableRecord(
        preparedWrite.appToken,
        preparedWrite.tableId,
        preparedWrite.tableName,
        preparedWrite.fields,
        tenantAccessToken,
        {
          optionalMissingFieldNames: [],
          retryNetworkErrors: true,
          clientToken: this.toLeaveRequestBitableClientToken(clientMutationId),
        },
      );
    } catch (error) {
      const nativeClientTokenConflict =
        this.isLeaveRequestBitableClientTokenConflict(error);
      if (nativeClientTokenConflict) {
        preparedWrite.reconcileOnly = true;
      }
      const ambiguousError = nativeClientTokenConflict
        ? new LeaveRequestAmbiguousWriteError(
            '飞书已受理相同请休假请求，记录结果待回查',
            error,
          )
        : this.toLeaveRequestAmbiguousWriteError(error);
      if (!ambiguousError) {
        if (error instanceof HttpException) {
          throw error;
        }
        throw this.toLeaveRequestRejectedWriteException(
          error,
          clientMutationId,
        );
      }
      try {
        await this.persistLeaveRequestUnknownMutation(
          clientMutationId,
          preparedWrite.requestFingerprint,
        );
      } catch {
        this.logger.error('请休假写入结果未知，但防重状态落盘失败');
      }
      try {
        const persistedRequest = await this.findPersistedLeaveRequest(
          preparedWrite.appToken,
          clientMutationId,
          preparedWrite.requestFingerprint,
        );
        if (persistedRequest) {
          invalidateBitableRecordCache({
            appToken: preparedWrite.appToken,
            tableId: preparedWrite.tableId,
          });
          return this.buildPersistedLeaveRequestResponse(
            request,
            clientMutationId,
            persistedRequest.recordId,
          );
        }
      } catch (reconcileError) {
        this.logger.warn(
          '请休假写入结果暂未确认：严格回查失败，已保留结果未知状态',
        );
      }
      throw ambiguousError;
    }

    invalidateBitableRecordCache({
      appToken: preparedWrite.appToken,
      tableId: preparedWrite.tableId,
    });

    return this.buildCreatedLeaveRequestResponse(
      request,
      clientMutationId,
      recordId,
    );
  }

  private buildCreatedLeaveRequestResponse(
    request: LeaveRequestCreateRequest,
    clientMutationId: string,
    recordId: string,
  ): LeaveRequestCreateResponse {
    const impact = request.expectedImpact;
    const leaveStaffName = this.normalizeDutyStaffRepairValue(
      request.leaveStaffName,
    );
    const { startAt, endAt } = this.normalizeLeaveRequestDateRange(
      request.startAt,
      request.endAt,
    );
    return {
      success: true,
      total: 1,
      created: 1,
      recordIds: [recordId],
      startAt,
      endAt,
      leaveStaffName,
      clientMutationId,
      affectedSchedules: impact.affectedSchedules,
      shiftGroups: createLeaveRequestShiftGroups(impact.affectedSchedules),
      excludedSchedules: impact.excludedSchedules,
      rawHours: impact.rawHours,
      minimumHours: impact.minimumHours,
      unrecognizedShifts: impact.unrecognizedShifts,
      missingCalendarYears: impact.missingCalendarYears,
      message: `请休假已提交：${leaveStaffName}，${startAt} 至 ${endAt}`,
    };
  }

  async createOvertimeRequest(
    request: OvertimeRequestCreateRequest,
    screenshot?: ConstructionUploadFile,
    principal?: AccessPrincipal,
  ): Promise<OvertimeRequestCreateResponse> {
    let authenticatedStaff: { userId?: string; personRecordId: string } | undefined;
    if (isPersonalAccessAccount(principal) || principal?.role === 'site_member') {
      request = { ...request, staffName: bindWorkforceRequestApplicant(request.staffName || '', principal, true, '提交加班申请') };
      authenticatedStaff = await this.resolveLeaveRequestStaff(request.staffName, undefined, principal);
    }
    const validatedScreenshot =
      this.validateOvertimeRequestScreenshot(screenshot);
    const clientMutationId = this.normalizeDutyStaffRepairValue(
      request?.clientMutationId || '',
    );
    if (!clientMutationId) {
      throw new BadRequestException('加班请求缺少 clientMutationId');
    }
    if (
      !clientMutationId.startsWith(OVERTIME_REQUEST_MUTATION_ID_PREFIX) ||
      clientMutationId.length <= OVERTIME_REQUEST_MUTATION_ID_PREFIX.length
    ) {
      throw new BadRequestException(
        `加班 clientMutationId 必须以 ${OVERTIME_REQUEST_MUTATION_ID_PREFIX} 开头`,
      );
    }
    if (clientMutationId.length > OVERTIME_REQUEST_MUTATION_ID_MAX_LENGTH) {
      throw new BadRequestException(
        `clientMutationId 长度不能超过 ${OVERTIME_REQUEST_MUTATION_ID_MAX_LENGTH}`,
      );
    }
    return this.withOvertimeRequestMutationIdempotency(
      clientMutationId,
      request,
      validatedScreenshot,
      (replayState) =>
        this.createOvertimeRequestNow(
          request,
          clientMutationId,
          validatedScreenshot,
          replayState,
          authenticatedStaff,
        ),
      () =>
        this.reconcilePersistedOvertimeRequest(
          request,
          clientMutationId,
          validatedScreenshot,
        ),
    );
  }

  private async reconcilePersistedOvertimeRequest(
    request: OvertimeRequestCreateRequest,
    clientMutationId: string,
    screenshot: ConstructionUploadFile,
  ): Promise<OvertimeRequestCreateResponse | null> {
    this.assertOvertimeRequestTableConfig();
    const requestFingerprint = this.buildOvertimeRequestMutationFingerprint(
      request,
      screenshot,
    );
    const expectedImpactKey = createOvertimeRequestImpactComparisonKey(
      request?.expectedImpact,
    );
    if (!expectedImpactKey) {
      throw new BadRequestException('加班请求缺少有效的排班影响预览');
    }
    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, this.leaveSubstituteConfig),
      this.getFeishuTenantAccessToken(),
    ]);
    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      OVERTIME_REQUEST_TABLE_ID,
      this.leaveSubstituteConfig.tableName,
      tenantAccessToken,
    );
    this.resolveOvertimeRequestFieldConfig(fieldMetas);
    const persisted = await this.findPersistedOvertimeRequest(
      appToken,
      clientMutationId,
      requestFingerprint,
    );
    if (!persisted) {
      return null;
    }
    invalidateBitableRecordCache({
      appToken,
      tableId: OVERTIME_REQUEST_TABLE_ID,
    });
    return this.buildOvertimeRequestResponse(
      request,
      clientMutationId,
      requestFingerprint,
      request.expectedImpact,
      persisted.recordId,
      0,
    );
  }

  private async createOvertimeRequestNow(
    request: OvertimeRequestCreateRequest,
    clientMutationId: string,
    screenshot: ConstructionUploadFile,
    replayState: OvertimeRequestMutationReplayState,
    authenticatedStaff?: { userId?: string; personRecordId: string },
  ): Promise<OvertimeRequestCreateResponse> {
    const staffName = this.normalizeDutyStaffRepairValue(
      request?.staffName || '',
    );
    const reason = this.normalizeDutyStaffRepairValue(request?.reason || '');
    const startAt = typeof request?.startAt === 'string' ? request.startAt : '';
    const endAt = typeof request?.endAt === 'string' ? request.endAt : '';
    if (!staffName) {
      throw new BadRequestException('请选择加班人员');
    }
    if (staffName.length > OVERTIME_REQUEST_STAFF_NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `加班人员姓名不能超过 ${OVERTIME_REQUEST_STAFF_NAME_MAX_LENGTH} 个字符`,
      );
    }
    if (!reason) {
      throw new BadRequestException('请填写加班原因');
    }
    if (reason.length > OVERTIME_REQUEST_REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `加班原因不能超过 ${OVERTIME_REQUEST_REASON_MAX_LENGTH} 个字符`,
      );
    }
    const rangeImpact = calculateOvertimeRequestImpact([], {
      staffName,
      startAt,
      endAt,
    });
    switch (rangeImpact.invalidRangeReason) {
      case 'invalid_start_at':
        throw new BadRequestException('加班开始时间必须是带时区的有效整点');
      case 'invalid_end_at':
        throw new BadRequestException('加班结束时间必须是带时区的有效整点');
      case 'not_whole_hour':
        throw new BadRequestException('加班开始和结束时间必须为整点');
      case 'end_not_after_start':
        throw new BadRequestException('加班结束时间必须晚于开始时间');
      case 'below_minimum_hours':
        throw new BadRequestException('加班时长不能少于 1 小时');
      default:
        break;
    }
    const requestedStartDateKey = this.formatShanghaiDateKey(
      new Date(Date.parse(startAt)),
    );
    if (
      !isOvertimeHistoryDateAllowed(
        requestedStartDateKey,
        this.getShanghaiTodayDateKey(),
      )
    ) {
      throw new BadRequestException('加班历史日期仅支持过去 30 天内');
    }
    const expectedImpactKey = createOvertimeRequestImpactComparisonKey(
      request?.expectedImpact,
    );
    if (!expectedImpactKey) {
      throw new BadRequestException('加班请求缺少有效的排班影响预览');
    }
    this.assertOvertimeRequestTableConfig();

    const requestFingerprint = this.buildOvertimeRequestMutationFingerprint(
      request,
      screenshot,
    );
    if (replayState.reconcileOnly || replayState.preparedWrite?.reconcileOnly) {
      throw new OvertimeRequestAmbiguousWriteError(
        '加班写入结果未知，请使用原申请标识安全重试',
        undefined,
      );
    }
    if (replayState.preparedWrite) {
      if (replayState.preparedWrite.requestFingerprint !== requestFingerprint) {
        throw new ConflictException({
          message: 'clientMutationId 重复但加班内容不同，请重新打开申请后提交',
          writeDisposition: 'definitely-not-written',
        });
      }
      if (authenticatedStaff) {
        const preparedUserIds = Object.values(replayState.preparedWrite.fields).flatMap(value =>
          Array.isArray(value) ? value.flatMap(item => item && typeof item === 'object' && typeof item.id === 'string' ? [item.id] : []) : [],
        );
        if (!authenticatedStaff.userId || preparedUserIds.length !== 1 || preparedUserIds[0] !== authenticatedStaff.userId) {
          throw new ForbiddenException('登录人员与原加班申请不一致，请使用原账号核对结果');
        }
      }
      return this.createPreparedOvertimeRequestRecord(
        request,
        clientMutationId,
        replayState.preparedWrite,
      );
    }

    const [appToken, tenantAccessToken] = await Promise.all([
      resolveBitableAppToken(this.httpService, this.leaveSubstituteConfig),
      this.getFeishuTenantAccessToken(),
    ]);
    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      OVERTIME_REQUEST_TABLE_ID,
      this.leaveSubstituteConfig.tableName,
      tenantAccessToken,
    );
    const fieldConfig = this.resolveOvertimeRequestFieldConfig(fieldMetas);
    let persisted: { recordId: string } | null;
    try {
      persisted = await this.findPersistedOvertimeRequest(
        appToken,
        clientMutationId,
        requestFingerprint,
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      throw new OvertimeRequestAmbiguousWriteError(
        '加班请求唯一性回查失败，写入结果未知，请使用原申请标识安全重试',
        error,
      );
    }
    if (persisted) {
      invalidateBitableRecordCache({
        appToken,
        tableId: OVERTIME_REQUEST_TABLE_ID,
      });
      return this.buildOvertimeRequestResponse(
        request,
        clientMutationId,
        requestFingerprint,
        request.expectedImpact,
        persisted.recordId,
        0,
      );
    }

    const resolvedStaff = await this.resolveOvertimeRequestStaff(staffName);
    if (authenticatedStaff && (!authenticatedStaff.userId || resolvedStaff.userId !== authenticatedStaff.userId)) {
      throw new ForbiddenException('登录人员与加班人员缓存不一致，请联系管理员核对');
    }

    const startEpochMs = Date.parse(startAt);
    const endEpochMs = Date.parse(endAt);
    const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
    const startDateKey = new Date(startEpochMs + shanghaiOffsetMs)
      .toISOString()
      .slice(0, 10);
    const endDateKey = new Date(endEpochMs + shanghaiOffsetMs)
      .toISOString()
      .slice(0, 10);
    const shiftDateKey = (dateKey: string, days: number): string => {
      const date = new Date(`${dateKey}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    const scheduleRangeStart = shiftDateKey(startDateKey, -1);
    const scheduleRangeEnd = shiftDateKey(endDateKey, 1);
    let schedules: MonthlySchedule[];
    try {
      schedules = await this.getMonthlySchedulesFromLocalCache(
        scheduleRangeStart,
        scheduleRangeEnd,
      );
      const coveredDates = new Set(
        schedules.map((schedule) => schedule.scheduleDate).filter(Boolean),
      );
      for (
        let cursor = new Date(`${scheduleRangeStart}T00:00:00.000Z`);
        cursor <= new Date(`${scheduleRangeEnd}T00:00:00.000Z`);
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        if (!coveredDates.has(cursor.toISOString().slice(0, 10))) {
          throw new Error('local overtime schedule range incomplete');
        }
      }
    } catch (error) {
      throw this.createOvertimeRequestDefinitelyNotWrittenException(
        '本地排班缓存尚未覆盖本次加班校验范围，尚未建立加班记录，请稍后重试',
        error,
      );
    }
    const impactSchedules = schedules.map((schedule) => ({
      recordId: schedule.recordId,
      scheduleDate: schedule.scheduleDate,
      building: schedule.building,
      buildingText: schedule.buildingText,
      team: schedule.team,
      teamText: schedule.teamText,
      shift: schedule.shift,
      shiftText: schedule.shiftText,
      personText: schedule.personText,
      dutyStaffReference: schedule.dutyStaffReference,
      dutyStaffActual: schedule.dutyStaffActual,
      leaveStaff: schedule.leaveStaff,
      substituteStaff: schedule.substituteStaff,
    }));
    const impact = calculateOvertimeRequestImpact(impactSchedules, {
      staffName,
      startAt,
      endAt,
      staffShift: resolvedStaff.shift,
    });
    const authoritativeImpactKey =
      createOvertimeRequestImpactComparisonKey(impact);
    if (
      !authoritativeImpactKey ||
      authoritativeImpactKey !== expectedImpactKey
    ) {
      throw new ConflictException({
        message: '排班已发生变化，本次加班未提交，请核对最新班次后再次确认',
        latestImpact: impact,
        writeDisposition: 'definitely-not-written',
      });
    }
    if (!impact.canSubmit) {
      switch (impact.invalidRangeReason) {
        case 'long_white_workday_hours':
          throw new BadRequestException(
            '长白班工作日加班仅可选择 09:00 前或 18:00 后',
          );
        case 'continuous_duty_24_hours':
          throw new BadRequestException(
            '7×24 排班人员加班不得与本人排班连续值守达到 24 小时',
          );
        case 'calendar_data_missing':
          throw new BadRequestException(
            '法定工作日历数据不完整，暂不能提交该时段',
          );
        default:
          break;
      }
      if (impact.conflictingSchedules.length > 0) {
        throw new BadRequestException(
          '加班时段与本人正常排班冲突，不能提交加班申请',
        );
      }
      throw new BadRequestException('当前加班时间范围不允许提交');
    }

    const { userId } = resolvedStaff;
    let screenshotFileToken: string;
    try {
      screenshotFileToken = await this.uploadBitableAttachment(
        tenantAccessToken,
        appToken,
        screenshot,
        '加班举证',
      );
    } catch (error) {
      throw this.toOvertimeRequestAttachmentUploadException(error);
    }

    const fields: Record<string, unknown> = {};
    this.setBitableFieldValue(fields, fieldConfig.staffUser, [{ id: userId }]);
    this.setBitableFieldValue(fields, fieldConfig.staffName, staffName);
    this.setBitableFieldValue(fields, fieldConfig.startAt, startEpochMs);
    this.setBitableFieldValue(fields, fieldConfig.endAt, endEpochMs);
    this.setBitableFieldValue(fields, fieldConfig.hours, impact.payableHours);
    this.setBitableFieldValue(fields, fieldConfig.screenshot, [
      { file_token: screenshotFileToken },
    ]);
    this.setBitableFieldValue(fields, fieldConfig.reason, reason);
    this.setBitableFieldValue(
      fields,
      fieldConfig.requestUniqueId,
      clientMutationId,
    );
    this.setBitableFieldValue(
      fields,
      fieldConfig.requestFingerprint,
      requestFingerprint,
    );
    const preparedWrite: OvertimeRequestMutationPreparedWrite = {
      appToken,
      tableId: OVERTIME_REQUEST_TABLE_ID,
      tableName: this.leaveSubstituteConfig.tableName,
      fields: JSON.parse(JSON.stringify(fields)) as Record<string, unknown>,
      requestFingerprint,
      impact,
      reconcileOnly: false,
    };
    replayState.preparedWrite = preparedWrite;
    return this.createPreparedOvertimeRequestRecord(
      request,
      clientMutationId,
      preparedWrite,
      tenantAccessToken,
    );
  }

  private async createPreparedOvertimeRequestRecord(
    request: OvertimeRequestCreateRequest,
    clientMutationId: string,
    preparedWrite: OvertimeRequestMutationPreparedWrite,
    providedTenantAccessToken?: string,
  ): Promise<OvertimeRequestCreateResponse> {
    if (preparedWrite.reconcileOnly) {
      throw new OvertimeRequestAmbiguousWriteError(
        '加班写入结果未知，请使用原申请标识安全重试',
        undefined,
      );
    }
    const tenantAccessToken =
      providedTenantAccessToken || (await this.getFeishuTenantAccessToken());
    let recordId: string;
    try {
      recordId = await this.createBitableRecord(
        preparedWrite.appToken,
        preparedWrite.tableId,
        preparedWrite.tableName,
        preparedWrite.fields,
        tenantAccessToken,
        {
          optionalMissingFieldNames: [],
          retryNetworkErrors: true,
          clientToken:
            this.toOvertimeRequestBitableClientToken(clientMutationId),
        },
      );
    } catch (error) {
      const nativeClientTokenConflict =
        this.isLeaveRequestBitableClientTokenConflict(error);
      if (nativeClientTokenConflict) {
        preparedWrite.reconcileOnly = true;
      }
      const ambiguousError = nativeClientTokenConflict
        ? new OvertimeRequestAmbiguousWriteError(
            '飞书已受理相同加班请求，记录结果待回查',
            error,
          )
        : this.toOvertimeRequestAmbiguousWriteError(error);
      if (!ambiguousError) {
        if (error instanceof HttpException) {
          throw error;
        }
        throw this.toOvertimeRequestRejectedWriteException(
          error,
          clientMutationId,
        );
      }
      try {
        await this.persistOvertimeRequestUnknownMutation(
          clientMutationId,
          preparedWrite.requestFingerprint,
        );
      } catch {
        this.logger.error('加班写入结果未知，但防重状态落盘失败');
      }
      try {
        const persisted = await this.findPersistedOvertimeRequest(
          preparedWrite.appToken,
          clientMutationId,
          preparedWrite.requestFingerprint,
        );
        if (persisted) {
          invalidateBitableRecordCache({
            appToken: preparedWrite.appToken,
            tableId: preparedWrite.tableId,
          });
          return this.buildOvertimeRequestResponse(
            request,
            clientMutationId,
            preparedWrite.requestFingerprint,
            preparedWrite.impact,
            persisted.recordId,
            0,
          );
        }
      } catch (lookupError) {
        if (lookupError instanceof ConflictException) {
          throw lookupError;
        }
        this.logger.warn(
          '加班写入结果暂未确认：严格回查失败，已保留结果未知状态',
        );
      }
      throw ambiguousError;
    }

    invalidateBitableRecordCache({
      appToken: preparedWrite.appToken,
      tableId: preparedWrite.tableId,
    });
    return this.buildOvertimeRequestResponse(
      request,
      clientMutationId,
      preparedWrite.requestFingerprint,
      preparedWrite.impact,
      recordId,
      1,
    );
  }

  private mergeBitableRecordsById(
    ...recordGroups: BitableRecordItem[][]
  ): BitableRecordItem[] {
    const merged: BitableRecordItem[] = [];
    const seenRecordIds = new Set<string>();

    for (const records of recordGroups) {
      for (const record of records) {
        const recordId = getRecordId(record);
        if (recordId) {
          if (seenRecordIds.has(recordId)) {
            continue;
          }
          seenRecordIds.add(recordId);
        }
        merged.push(record);
      }
    }

    return merged;
  }

  private async fetchConstructionCrewLedgerRecordsForManagement(
    appToken: string,
    config: FocusBitableConfig,
    options: { cacheTtlMs: number; forceRefresh: boolean },
  ): Promise<BitableRecordItem[]> {
    const viewRecords = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: config.tableId,
      viewId: config.viewId || undefined,
      tableName: config.tableName,
      cacheTtlMs: options.cacheTtlMs,
      forceRefresh: options.forceRefresh,
    });

    if (!config.viewId) {
      return viewRecords;
    }

    try {
      const tableRecords = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: config.tableId,
        tableName: config.tableName,
        cacheTtlMs: options.cacheTtlMs,
        forceRefresh: options.forceRefresh,
      });
      return this.mergeBitableRecordsById(viewRecords, tableRecords);
    } catch (error) {
      this.logger.warn(
        `施工人员台账全表读取失败，已使用配置视图记录: ${getBitableAxiosErrorMessage(error)}`,
      );
      return viewRecords;
    }
  }

  private async fetchConstructionFollowupRecordsForManagement(
    appToken: string,
    config: FocusBitableConfig,
    options: { cacheTtlMs: number; forceRefresh: boolean },
  ): Promise<BitableRecordItem[]> {
    const viewRecords = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: config.tableId,
      viewId: config.viewId || undefined,
      tableName: config.tableName,
      cacheTtlMs: options.cacheTtlMs,
      forceRefresh: options.forceRefresh,
    });

    if (!config.viewId) {
      return viewRecords;
    }

    try {
      const tableRecords = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: config.tableId,
        tableName: config.tableName,
        cacheTtlMs: options.cacheTtlMs,
        forceRefresh: options.forceRefresh,
      });
      return this.mergeBitableRecordsById(tableRecords, viewRecords);
    } catch (error) {
      this.logger.warn(
        `施工跟进全表读取失败，已使用配置视图记录: ${getBitableAxiosErrorMessage(error)}`,
      );
      return viewRecords;
    }
  }

  rememberRecentConstructionOverviewRecord(record: BitableRecordItem): void {
    const recordId = getRecordId(record);
    if (!recordId) {
      return;
    }
    this.recentConstructionOverviewRecords.set(recordId, {
      record,
      expiresAt: Date.now() + CONSTRUCTION_RECENT_OVERVIEW_RECORD_TTL_MS,
    });
  }

  private mergeRecentConstructionOverviewRecords(
    viewRecords: BitableRecordItem[],
  ): BitableRecordItem[] {
    const now = Date.now();
    const visibleRecordIds = new Set(
      viewRecords.map((record) => getRecordId(record)).filter(Boolean),
    );
    const merged = [...viewRecords];

    for (const [recordId, entry] of this.recentConstructionOverviewRecords) {
      if (entry.expiresAt <= now || visibleRecordIds.has(recordId)) {
        this.recentConstructionOverviewRecords.delete(recordId);
        continue;
      }
      merged.push(entry.record);
      visibleRecordIds.add(recordId);
    }

    return merged;
  }

  async getConstructionManagement(
    forceRefresh = false,
    principal?: AccessPrincipal,
  ): Promise<ConstructionManagementResponse> {
    const aiAuditEnabled = this.isConstructionAiAuditEnabled();
    const generatedAt = new Date().toISOString();
    let overviewRecords: BitableRecordItem[] = [];
    let followupRecords: BitableRecordItem[] = [];
    let crewRecords: BitableRecordItem[] = [];
    let overviewStatus: TodayFocusSectionStatus = {
      configured: false,
      message: '施工总览多维表待配置',
    };
    let followupStatus: TodayFocusSectionStatus = {
      configured: false,
      message: '施工跟进多维表待配置',
    };

    const crewLedgerConfig = this.getConstructionCrewLedgerConfig();
    const overviewConfigured = this.hasBitableSourceConfig(
      this.constructionOverviewConfig,
    );
    const followupConfigured = this.hasBitableSourceConfig(
      this.constructionFollowupConfig,
    );
    const crewConfigured = this.hasBitableSourceConfig(crewLedgerConfig);
    const overviewReadTask: Promise<BitableRecordItem[] | null> =
      overviewConfigured
        ? (async () => {
            const appToken = await resolveBitableAppToken(
              this.httpService,
              this.constructionOverviewConfig,
            );
            return fetchBitableRecords(this.httpService, {
              appToken,
              tableId: this.constructionOverviewConfig.tableId,
              viewId: this.constructionOverviewConfig.viewId || undefined,
              tableName: this.constructionOverviewConfig.tableName,
              cacheTtlMs: 30 * 60 * 1000,
              forceRefresh,
            });
          })()
        : Promise.resolve(null);
    const followupReadTask: Promise<BitableRecordItem[] | null> =
      followupConfigured
        ? (async () => {
            const appToken = await resolveBitableAppToken(
              this.httpService,
              this.constructionFollowupConfig,
            );
            return this.fetchConstructionFollowupRecordsForManagement(
              appToken,
              this.constructionFollowupConfig,
              {
                cacheTtlMs: 30 * 60 * 1000,
                forceRefresh,
              },
            );
          })()
        : Promise.resolve(null);
    const crewReadTask: Promise<BitableRecordItem[] | null> = crewConfigured
      ? (async () => {
          const appToken = await resolveBitableAppToken(
            this.httpService,
            crewLedgerConfig,
          );
          return this.fetchConstructionCrewLedgerRecordsForManagement(
            appToken,
            crewLedgerConfig,
            { cacheTtlMs: 30 * 60 * 1000, forceRefresh },
          );
        })()
      : Promise.resolve(null);
    const [overviewRead, followupRead, crewRead] = await Promise.allSettled([
      overviewReadTask,
      followupReadTask,
      crewReadTask,
    ]);

    if (overviewConfigured) {
      overviewStatus = { configured: true };
      if (overviewRead.status === 'fulfilled') {
        overviewRecords = this.mergeRecentConstructionOverviewRecords(
          overviewRead.value || [],
        );
      } else {
        const message =
          overviewRead.reason instanceof Error
            ? overviewRead.reason.message
            : String(overviewRead.reason);
        this.logger.warn(`施工总览读取失败: ${message}`);
        overviewStatus = { configured: true, message: '施工总览读取失败' };
      }
    }

    if (followupConfigured) {
      followupStatus = { configured: true };
      if (followupRead.status === 'fulfilled') {
        followupRecords = followupRead.value || [];
      } else {
        const message =
          followupRead.reason instanceof Error
            ? followupRead.reason.message
            : String(followupRead.reason);
        this.logger.warn(`施工跟进读取失败: ${message}`);
        followupStatus = { configured: true, message: '施工跟进读取失败' };
      }
    }

    if (crewConfigured) {
      if (crewRead.status === 'fulfilled') {
        crewRecords = crewRead.value || [];
      } else {
        const message =
          crewRead.reason instanceof Error
            ? crewRead.reason.message
            : String(crewRead.reason);
        this.logger.warn(`施工人员台账读取失败: ${message}`);
      }
    }

    if (forceRefresh && !isProfessionalBusinessPrincipal(principal)) {
      try {
        const crewAuthorizationSynced =
          await this.syncConstructionCrewLedgerAuthorizationFields(
            crewRecords,
            new Date(),
          );
        if (crewAuthorizationSynced) {
          const crewLedgerAppToken = await resolveBitableAppToken(
            this.httpService,
            crewLedgerConfig,
          );
          crewRecords =
            await this.fetchConstructionCrewLedgerRecordsForManagement(
              crewLedgerAppToken,
              crewLedgerConfig,
              { cacheTtlMs: 0, forceRefresh: true },
            );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`施工人员台账授权字段同步失败: ${message}`);
      }

      if (aiAuditEnabled) {
        try {
          const permitAuditRefreshed =
            await this.refreshDailyPermitAuditFeedbacksIfNeeded(
              {
                overviewRecords,
                followupRecords,
                crewRecords,
                referenceDate: new Date(),
              },
              aiAuditEnabled,
            );
          if (permitAuditRefreshed) {
            const followupAppToken = await resolveBitableAppToken(
              this.httpService,
              this.constructionFollowupConfig,
            );
            followupRecords =
              await this.fetchConstructionFollowupRecordsForManagement(
                followupAppToken,
                this.constructionFollowupConfig,
                { cacheTtlMs: 0, forceRefresh: true },
              );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(`每日作业票核验刷新失败: ${message}`);
        }
      }
    }

    if (
      forceRefresh && !isProfessionalBusinessPrincipal(principal) &&
      followupRecords.length > 0 &&
      this.hasBitableSourceConfig(this.constructionFollowupConfig)
    ) {
      try {
        const roomManagerSynced =
          await this.syncConstructionRoomManagerAfterDepositConfirmation(
            followupRecords,
          );
        if (roomManagerSynced) {
          const followupAppToken = await resolveBitableAppToken(
            this.httpService,
            this.constructionFollowupConfig,
          );
          followupRecords =
            await this.fetchConstructionFollowupRecordsForManagement(
              followupAppToken,
              this.constructionFollowupConfig,
              {
                cacheTtlMs: 30 * 60 * 1000,
                forceRefresh: true,
              },
            );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`质保金确认同步机房经理失败: ${message}`);
      }
    }

    if (isProfessionalBusinessPrincipal(principal)) {
      overviewRecords = scopeProfessionalBitableRecords(principal, overviewRecords);
      const owned = new Set(overviewRecords.map(record => record.record_id));
      const linked = (record: BitableRecordItem, field: string) => {
        const ids = extractLinkRecordIds(record.fields[field]);
        return ids.length > 0 && ids.every(id => owned.has(id));
      };
      followupRecords = followupRecords.filter(record => linked(record, '施工总览'));
      crewRecords = crewRecords.filter(record => linked(record, '关联施工单'));
    }
    const response = buildConstructionManagementView({
      generatedAt,
      overviewRecords,
      followupRecords,
      crewRecords,
      overviewSourceUrl: this.constructionOverviewConfig.sourceUrl,
      followupSourceUrl: this.constructionFollowupConfig.sourceUrl,
    });
    const responseWithStatus: ConstructionManagementResponse = {
      ...response,
      sectionStatus: {
        overview: overviewStatus,
        followups: followupStatus,
      },
      imageAuditStatus: this.getConstructionImageAuditStatus(aiAuditEnabled),
    };
    return aiAuditEnabled
      ? responseWithStatus
      : this.sanitizeConstructionManagementResponseForManualReview(
          responseWithStatus,
        );
  }

  private async syncConstructionRoomManagerAfterDepositConfirmation(
    followupRecords: BitableRecordItem[],
  ): Promise<boolean> {
    const candidates = followupRecords.filter((record) => {
      const fields = (record.fields || {}) as Record<string, unknown>;
      const depositRaw = pickField(
        fields,
        CONSTRUCTION_FOLLOWUP_DEPOSIT_CONFIRMATION_FIELD_NAMES,
      );
      const depositText = extractDisplayText(depositRaw).trim();
      if (!depositText && depositRaw !== true) {
        return false;
      }

      const syncRaw = pickField(
        fields,
        CONSTRUCTION_ROOM_MANAGER_SYNC_FIELD_NAMES,
      );
      if (syncRaw === true) {
        return false;
      }
      const syncText = extractDisplayText(syncRaw).trim();
      return !/已同步|完成|是|true|✔|✓/i.test(syncText);
    });
    if (candidates.length === 0) {
      return false;
    }

    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const appToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionFollowupConfig,
    );
    for (const record of candidates) {
      const recordId = getRecordId(record);
      if (!recordId) {
        continue;
      }
      await this.updateBitableRecordFields(
        appToken,
        this.constructionFollowupConfig.tableId,
        this.constructionFollowupConfig.tableName,
        recordId,
        { 同步机房经理: true },
        tenantAccessToken,
        {
          optionalMissingFieldNames:
            CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
        },
      );
      record.fields = {
        ...((record.fields || {}) as Record<string, unknown>),
        同步机房经理: true,
      };
    }
    invalidateBitableRecordCache({
      appToken,
      tableId: this.constructionFollowupConfig.tableId,
      deletePersisted: true,
    });
    return true;
  }

  getConstructionImageAuditStatus(
    aiAuditEnabled = this.isConstructionAiAuditEnabled(),
  ) {
    if (!aiAuditEnabled) {
      return {
        enabled: false,
        configured: false,
        provider: '人工审核',
        model: null,
        baseUrl: null,
        supportsImageInput: false,
        message: '施工 AI/OCR 审核已关闭，当前仅使用人工审核',
      };
    }

    return {
      ...buildConstructionImageAuditStatus(
        this.getConstructionImageAuditConfig() || {
          apiKey: null,
          baseUrl: DEFAULT_QWEN_BASE_URL,
          model: DEFAULT_QWEN_VISION_MODEL,
        },
      ),
      enabled: true,
    };
  }

  private sanitizeConstructionManagementResponseForManualReview(
    response: ConstructionManagementResponse,
  ): ConstructionManagementResponse {
    type Followup = ConstructionManagementResponse['followups'][number];
    type Attachment = Followup['attachments'][number];

    const sanitizeAttachment = (attachment: Attachment): Attachment => ({
      ...attachment,
      status: attachment.files.length > 0 ? 'complete' : 'empty',
      feedback: null,
    });
    const sanitizeFollowup = (followup: Followup): Followup => ({
      ...followup,
      // Keep processFeedback: it is current manual input despite its legacy Bitable field name.
      isolationFeedback: null,
      closingFeedback: null,
      aiIssues: [],
      attachments: followup.attachments.map(sanitizeAttachment),
    });

    return {
      ...response,
      summary: {
        ...response.summary,
        attachmentIssues: 0,
      },
      followups: response.followups.map(sanitizeFollowup),
      items: response.items.map((item) => ({
        ...item,
        applicationAttachments:
          item.applicationAttachments.map(sanitizeAttachment),
        followups: item.followups.map(sanitizeFollowup),
        latestFollowup: item.latestFollowup
          ? sanitizeFollowup(item.latestFollowup)
          : null,
      })),
    };
  }

  async getConstructionOnsiteFollowers(
    query = '',
    forceRefresh = false,
  ): Promise<ConstructionStaffCandidatesResponse> {
    if (!this.hasBitableSourceConfig(this.constructionStaffConfig)) {
      return {
        configured: false,
        items: [],
        total: 0,
        message: '在职人员名单多维表待配置',
      };
    }

    try {
      const appToken = await resolveBitableAppToken(
        this.httpService,
        this.constructionStaffConfig,
      );
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: this.constructionStaffConfig.tableId,
        viewId: this.constructionStaffConfig.viewId || undefined,
        tableName: this.constructionStaffConfig.tableName,
        forceRefresh,
      });
      const normalizedQuery = this.normalizeDutyStaffRepairValue(query);
      const candidates = records
        .map((record) => this.mapConstructionStaffCandidate(record))
        .filter((item): item is ConstructionStaffCandidate => Boolean(item))
        .filter((item) =>
          this.matchesConstructionStaffQuery(item, normalizedQuery),
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

      return {
        configured: true,
        items: candidates.slice(0, 50),
        total: candidates.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`在职人员名单读取失败: ${message}`);
      return {
        configured: true,
        items: [],
        total: 0,
        message: '在职人员名单读取失败',
      };
    }
  }

  async getConstructionChangeOrders(
    query = '',
    forceRefresh = false,
  ): Promise<ConstructionChangeOrderCandidatesResponse> {
    if (!this.hasBitableSourceConfig(this.constructionChangeOrderConfig)) {
      return {
        configured: false,
        items: [],
        total: 0,
        message: '施工关联变更单多维表待配置',
      };
    }

    try {
      const appToken = await resolveBitableAppToken(
        this.httpService,
        this.constructionChangeOrderConfig,
      );
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: this.constructionChangeOrderConfig.tableId,
        viewId: this.constructionChangeOrderConfig.viewId || undefined,
        tableName: this.constructionChangeOrderConfig.tableName,
        forceRefresh,
      });
      const normalizedQuery = this.normalizeDutyStaffRepairValue(query);
      const candidates = records
        .map((record) => this.mapConstructionChangeOrderCandidate(record))
        .filter((item): item is ConstructionChangeOrderCandidate =>
          Boolean(item),
        )
        .filter((item) =>
          this.matchesConstructionChangeOrderQuery(item, normalizedQuery),
        )
        .sort(
          (a, b) =>
            this.getConstructionChangeOrderSortTime(b) -
            this.getConstructionChangeOrderSortTime(a),
        );

      return {
        configured: true,
        items: candidates.slice(0, 50),
        total: candidates.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`施工关联变更单读取失败: ${message}`);
      return {
        configured: true,
        items: [],
        total: 0,
        message: '施工关联变更单读取失败',
      };
    }
  }

  private serializeConstructionMutationFingerprintValue(
    value: unknown,
  ): string {
    if (value === null) {
      return 'null';
    }
    if (Buffer.isBuffer(value)) {
      return `buffer:${crypto.createHash('sha256').update(value).digest('hex')}`;
    }
    if (value instanceof Date) {
      return `date:${value.toISOString()}`;
    }
    if (Array.isArray(value)) {
      return `array:[${value
        .map((item) => this.serializeConstructionMutationFingerprintValue(item))
        .join(',')}]`;
    }
    switch (typeof value) {
      case 'undefined':
        return 'undefined';
      case 'string':
        return `string:${JSON.stringify(value)}`;
      case 'number':
        return `number:${Number.isNaN(value) ? 'NaN' : String(value)}`;
      case 'boolean':
        return `boolean:${value ? 'true' : 'false'}`;
      case 'bigint':
        return `bigint:${value.toString()}`;
      case 'object': {
        const record = value as Record<string, unknown>;
        return `object:{${Object.keys(record)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${this.serializeConstructionMutationFingerprintValue(
                record[key],
              )}`,
          )
          .join(',')}}`;
      }
      default:
        return `${typeof value}:${String(value)}`;
    }
  }

  private buildConstructionMutationFingerprint(
    request: unknown,
    files: ConstructionUploadFile[],
  ): string {
    const requestPayload =
      typeof request === 'object' && request !== null && !Array.isArray(request)
        ? Object.fromEntries(
            Object.entries(request as Record<string, unknown>).filter(
              ([key]) => key !== 'clientMutationId',
            ),
          )
        : request;
    const filePayloads = files
      .map((file) => {
        const buffer = Buffer.isBuffer(file?.buffer)
          ? file.buffer
          : Buffer.alloc(0);
        return {
          fieldname: String(file?.fieldname || ''),
          originalname: String(file?.originalname || ''),
          mimetype: String(file?.mimetype || ''),
          size: Number.isFinite(file?.size) ? file.size : buffer.length,
          bufferSha256: crypto
            .createHash('sha256')
            .update(buffer)
            .digest('hex'),
        };
      })
      .map((file) => this.serializeConstructionMutationFingerprintValue(file))
      .sort();
    const serialized = this.serializeConstructionMutationFingerprintValue({
      request: requestPayload,
      files: filePayloads,
    });
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  private withConstructionMutationIdempotency<T>(
    namespace: 'application' | 'followup',
    clientMutationId: string | null | undefined,
    request: unknown,
    files: ConstructionUploadFile[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const normalizedMutationId = String(clientMutationId || '').trim();
    if (!normalizedMutationId) {
      return operation();
    }
    if (normalizedMutationId.length > CONSTRUCTION_MUTATION_ID_MAX_LENGTH) {
      return Promise.reject(
        new Error(
          `clientMutationId 长度不能超过 ${CONSTRUCTION_MUTATION_ID_MAX_LENGTH}`,
        ),
      );
    }

    const now = Date.now();
    for (const [key, entry] of this.constructionMutationCompleted) {
      if (entry.expiresAt <= now) {
        this.constructionMutationCompleted.delete(key);
      }
    }

    const key = `${namespace}:${normalizedMutationId}`;
    const fingerprint = this.buildConstructionMutationFingerprint(
      request,
      files,
    );
    const conflictError = () =>
      new Error(
        'clientMutationId 重复但请求内容冲突，请为不同操作生成新的 clientMutationId',
      );
    const completed = this.constructionMutationCompleted.get(key);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      return Promise.resolve(completed.response as T);
    }
    const inFlight = this.constructionMutationInFlight.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return Promise.reject(conflictError());
      }
      return inFlight.promise as Promise<T>;
    }

    const current = Promise.resolve().then(operation);
    this.constructionMutationInFlight.set(key, {
      fingerprint,
      promise: current,
    });
    void current.then(
      (response) => {
        if (this.constructionMutationInFlight.get(key)?.promise === current) {
          this.constructionMutationInFlight.delete(key);
        }
        this.constructionMutationCompleted.set(key, {
          expiresAt: Date.now() + CONSTRUCTION_MUTATION_COMPLETED_TTL_MS,
          fingerprint,
          response,
        });
        while (
          this.constructionMutationCompleted.size >
          CONSTRUCTION_MUTATION_COMPLETED_MAX_ENTRIES
        ) {
          const oldestKey = this.constructionMutationCompleted.keys().next()
            .value as string | undefined;
          if (!oldestKey) {
            break;
          }
          this.constructionMutationCompleted.delete(oldestKey);
        }
      },
      () => {
        if (this.constructionMutationInFlight.get(key)?.promise === current) {
          this.constructionMutationInFlight.delete(key);
        }
      },
    );
    return current;
  }

  async createConstructionApplication(
    request: ConstructionApplicationCreateRequest,
    files: ConstructionUploadFile[] = [],
  ): Promise<ConstructionApplicationCreateResponse> {
    return this.withConstructionMutationIdempotency(
      'application',
      request?.clientMutationId,
      request,
      files,
      () => this.createConstructionApplicationNow(request, files),
    );
  }

  private async createConstructionApplicationNow(
    request: ConstructionApplicationCreateRequest,
    files: ConstructionUploadFile[] = [],
  ): Promise<ConstructionApplicationCreateResponse> {
    if (!this.hasBitableSourceConfig(this.constructionOverviewConfig)) {
      throw new Error(
        `${this.constructionOverviewConfig.tableName}多维表待配置`,
      );
    }
    if (!this.hasBitableSourceConfig(this.constructionFollowupConfig)) {
      throw new Error(
        `${this.constructionFollowupConfig.tableName}多维表待配置`,
      );
    }
    validateConstructionApplicationSubmission(files);
    const hasCrewRosterFiles = files.some(
      (file) => file.fieldname === 'crewRosterFiles',
    );
    let authorizationStartDate: string | null = null;
    let authorizationEndDate: string | null = null;
    if (hasCrewRosterFiles) {
      authorizationStartDate =
        this.normalizeConstructionCrewRosterAuthorizationDate(
          request?.authorizationStartDate,
          '授权开始日期',
        );
      authorizationEndDate =
        this.normalizeConstructionCrewRosterAuthorizationDate(
          request?.authorizationEndDate,
          '施工结束日期',
        );
      if (authorizationStartDate > authorizationEndDate) {
        throw new Error('授权开始日期不能晚于施工结束日期');
      }
      parseConstructionCrewRosterFiles(files);
    }

    const overviewAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionOverviewConfig,
    );
    const followupAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionFollowupConfig,
    );
    const changeOrderLinkRecordId =
      await this.resolveConstructionChangeLinkRecordId(
        request,
        overviewAppToken,
      );
    const { fields, normalized } = buildConstructionApplicationFields({
      ...request,
      changeOrderLinkRecordId,
    });
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const uploadedApplicationAttachmentsByKey =
      await this.uploadConstructionAttachmentTokensByFieldKey(
        tenantAccessToken,
        overviewAppToken,
        files,
        Object.keys(CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS),
      );
    Object.assign(
      fields,
      this.mapConstructionAttachmentTokensToFieldValues(
        uploadedApplicationAttachmentsByKey,
        CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS,
      ),
    );
    const uploadedFollowupAttachmentsByKey =
      followupAppToken === overviewAppToken
        ? uploadedApplicationAttachmentsByKey
        : await this.uploadConstructionAttachmentTokensByFieldKey(
            tenantAccessToken,
            followupAppToken,
            files,
            Object.keys(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS),
          );
    const initialFollowupForValidation = buildConstructionFollowupFields({
      constructionRecordId: 'pending',
      followupMode: 'supplemental',
      workTypes: normalized.workTypes,
    });
    validateConstructionFollowupSubmission(
      initialFollowupForValidation.normalized,
      files,
    );
    const recordId = await this.createBitableRecord(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      fields,
      tenantAccessToken,
      {
        optionalMissingFieldNames:
          CONSTRUCTION_OVERVIEW_OPTIONAL_MISSING_FIELD_NAMES,
      },
    );
    this.rememberRecentConstructionOverviewRecord({
      record_id: recordId,
      fields: { ...fields },
      created_time: Date.now(),
      last_modified_time: Date.now(),
    });
    invalidateBitableRecordCache({
      appToken: overviewAppToken,
      tableId: this.constructionOverviewConfig.tableId,
      deletePersisted: true,
    });
    const { fields: initialFollowupFields } = buildConstructionFollowupFields({
      constructionRecordId: recordId,
      followupMode: 'supplemental',
      workTypes: normalized.workTypes,
    });
    Object.assign(
      initialFollowupFields,
      this.mapConstructionAttachmentTokensToFieldValues(
        uploadedFollowupAttachmentsByKey,
        CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
      ),
    );
    const initialFollowupRecordId = await this.createBitableRecord(
      followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      initialFollowupFields,
      tenantAccessToken,
      {
        optionalMissingFieldNames:
          CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
      },
    );
    invalidateBitableRecordCache({
      appToken: followupAppToken,
      tableId: this.constructionFollowupConfig.tableId,
      deletePersisted: true,
    });
    if (hasCrewRosterFiles) {
      const constructionCode =
        await this.ensureConstructionCrewLedgerProjectViewFromOverviewRecord(
          overviewAppToken,
          recordId,
          fields,
          tenantAccessToken,
        );
      const synced = await this.syncConstructionCrewRosterFilesToLedger({
        files,
        overviewRecordId: recordId,
        constructionCode,
        overviewAppToken,
        tenantAccessToken,
        authorizationStartDate,
        authorizationEndDate,
      });
      void this.runConstructionCrewRosterCertificateBatchCheck({
        records: synced.records,
        overviewRecordId: recordId,
        constructionCode,
        tenantAccessToken,
        members: synced.members,
      })
        .then((summary) =>
          this.notifyConstructionCrewRosterUploadSuccess(
            `施工申请人员名单持证查询完成：${constructionCode}；${summary.summary}`,
          ),
        )
        .catch((error) =>
          this.logger.warn(
            `施工申请人员名单持证查询后台执行失败: ${getBitableAxiosErrorMessage(error)}`,
          ),
        );
    }

    return {
      success: true,
      recordId,
      recordUrl: this.buildBitableRecordUrl(
        this.constructionOverviewConfig,
        recordId,
      ),
      initialFollowupRecordId,
      initialFollowupRecordUrl: this.buildBitableRecordUrl(
        this.constructionFollowupConfig,
        initialFollowupRecordId,
      ),
      message: '施工申请已提交',
    };
  }

  async downloadConstructionAttachment(
    fileToken: string,
    options: { tmpUrl?: string | null } = {},
  ): Promise<{
    contentType: string;
    buffer: Buffer;
  }> {
    const normalizedToken = String(fileToken || '').trim();
    if (!normalizedToken) {
      throw new Error('缺少施工附件 fileToken');
    }

    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const tmpDownloadUrl =
      await this.resolveConstructionAttachmentTmpDownloadUrl(
        normalizedToken,
        tenantAccessToken,
        options.tmpUrl,
      );
    const apiUrl =
      tmpDownloadUrl || buildFeishuDirectDownloadUrl(normalizedToken);
    const response = await this.httpService.axiosRef
      .get<ArrayBuffer>(apiUrl, {
        responseType: 'arraybuffer',
        ...(tmpDownloadUrl
          ? {}
          : { headers: { Authorization: `Bearer ${tenantAccessToken}` } }),
        timeout: 30000,
      })
      .catch((error: unknown) => {
        throw new Error(
          `施工附件下载失败：${getBitableAxiosErrorMessage(error)}`,
        );
      });

    const headerContentType = response.headers['content-type'];
    const contentType =
      typeof headerContentType === 'string' && headerContentType
        ? headerContentType
        : 'application/octet-stream';

    return {
      contentType,
      buffer: Buffer.from(response.data),
    };
  }

  private async resolveConstructionAttachmentTmpDownloadUrl(
    fileToken: string,
    tenantAccessToken: string,
    sourceTmpUrl?: string | null,
  ): Promise<string | null> {
    const apiUrl =
      normalizeFeishuTmpDownloadApiUrl(fileToken, sourceTmpUrl) ||
      buildFeishuTmpDownloadUrl(fileToken);
    try {
      const response = await this.httpService.axiosRef.get(apiUrl, {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        timeout: 20000,
      });
      return extractFeishuTmpDownloadUrl(response.data);
    } catch (error) {
      this.logger.warn(
        `施工附件临时下载链接获取失败：${getBitableAxiosErrorMessage(error)}`,
      );
      return null;
    }
  }

  async authorizeProfessionalConstruction(principal: AccessPrincipal | undefined, recordId: string, source: 'overview' | 'followup' = 'overview'): Promise<void> {
    if (!isProfessionalBusinessPrincipal(principal)) return;
    if (!/^rec[A-Za-z0-9]+$/.test(recordId || '')) throw new Error('施工记录无效');
    const config = source === 'overview' ? this.constructionOverviewConfig : this.constructionFollowupConfig;
    const appToken = await resolveBitableAppToken(this.httpService, config);
    const token = await this.getFeishuTenantAccessToken();
    const record = await this.fetchBitableRecordById(appToken, config.tableId, config.tableName, recordId, token);
    if (source === 'overview') {
      assertProfessionalBitableRecord(principal, record || undefined);
    } else {
      const parents = extractLinkRecordIds(record?.fields['施工总览']);
      if (!parents.length || parents.length > 20) assertProfessionalRecordScope(principal, undefined);
      for (const parent of parents) await this.authorizeProfessionalConstruction(principal, parent);
    }
  }

  private readonly professionalConstructionTasks = new Map<string, AccessPrincipal>();
  bindProfessionalConstructionTasks(principal: AccessPrincipal | undefined, result: unknown): void {
    if (!isProfessionalBusinessPrincipal(principal) || !result || typeof result !== 'object') return;
    const value = result as { taskId?: string; retryTaskId?: string };
    for (const id of [value.taskId, value.retryTaskId]) if (typeof id === 'string') this.professionalConstructionTasks.set(id, businessAuthorizationSnapshot(principal));
  }
  authorizeProfessionalConstructionTask(principal: AccessPrincipal | undefined, taskId: string): void {
    if (!isProfessionalBusinessPrincipal(principal)) return;
    const owner = this.professionalConstructionTasks.get(taskId);
    if (!owner || owner.accountId !== principal.accountId || JSON.stringify(owner.specialties) !== JSON.stringify(principal.specialties)) throw new ForbiddenException('无权查看该施工任务');
  }

  async authorizeProfessionalConstructionAttachment(principal: AccessPrincipal | undefined, fileToken: string): Promise<void> {
    if (!isProfessionalBusinessPrincipal(principal)) return;
    const view = await this.getConstructionManagement(false, principal);
    const hasToken = (value: unknown): boolean => Boolean(value && typeof value === 'object' && (
      (value as { fileToken?: string }).fileToken === fileToken || Object.values(value).some(hasToken)
    ));
    const project = view.items.find(item => hasToken(item));
    if (!project) assertProfessionalRecordScope(principal, undefined);
    await this.authorizeProfessionalConstruction(principal, project!.recordId);
  }

  async createConstructionFollowup(
    request: ConstructionFollowupCreateRequest,
    files: ConstructionUploadFile[] = [],
    accessRole: AccessRole = 'guest',
    existingTenantAccessToken?: string,
    professionalPrincipal?: AccessPrincipal,
  ): Promise<ConstructionFollowupCreateResponse> {
    if (accessRole === 'professional_admin') {
      if (!isProfessionalBusinessPrincipal(professionalPrincipal)) throw new Error('专业主管身份缺失');
      await this.authorizeProfessionalConstruction(professionalPrincipal, request.constructionRecordId);
      if (request.followupRecordId) await this.authorizeProfessionalConstruction(professionalPrincipal, request.followupRecordId, 'followup');
    }
    const result = await this.withConstructionMutationIdempotency(
      'followup',
      request?.clientMutationId,
      request,
      files,
      async () => {
        const acceptsBackgroundSync =
          request?.backgroundSync === true ||
          String(request?.backgroundSync || '')
            .trim()
            .toLowerCase() === 'true';
        if (
          acceptsBackgroundSync &&
          String(request?.clientMutationId || '').trim()
        ) {
          const normalizedFiles = this.normalizeConstructionUploadFiles(files);
          const requestForValidation = shouldInferConstructionPermitOnlyUpload(
            request,
            normalizedFiles,
          )
            ? { ...request, permitOnlyUpload: 'true' }
            : request;
          const { normalized } =
            buildConstructionFollowupFields(requestForValidation);
          validateConstructionFollowupSubmission(normalized, normalizedFiles, {
            requirePermitValidityDates:
              isConstructionManualReviewAutoApprovalRole(accessRole, professionalPrincipal),
          });
          const acceptedTaskId = await this.enqueueConstructionFollowupSubmit(
            request,
            files,
            accessRole,
            professionalPrincipal,
          );
          return {
            success: true,
            recordId: String(request?.followupRecordId || '').trim(),
            recordUrl: null,
            constructionRecordId: String(request?.constructionRecordId || ''),
            updated: Boolean(request?.followupRecordId),
            attachmentSyncPending: true,
            pendingSync: true,
            taskId: acceptedTaskId,
            message: '施工跟进已受理，后台同步中',
          };
        }

        try {
          return await this.createConstructionFollowupNow(
            request,
            files,
            accessRole,
            existingTenantAccessToken,
            professionalPrincipal,
          );
        } catch (error) {
          if (
            !this.shouldQueueConstructionFollowupSubmitRetry(
              request,
              files,
              error,
            )
          ) {
            throw error;
          }

          const retryTaskId = await this.enqueueConstructionFollowupSubmitRetry(
            request,
            files,
            accessRole,
            error,
            professionalPrincipal,
          );
          return {
            success: true,
            recordId: '',
            recordUrl: null,
            constructionRecordId: String(request?.constructionRecordId || ''),
            updated: Boolean(request?.followupRecordId),
            attachmentSyncPending: true,
            pendingSync: true,
            retryTaskId,
            message: '施工跟进已暂存，飞书连接超时，后台同步中',
          };
        }
      },
    );
    if (isProfessionalBusinessPrincipal(professionalPrincipal)) {
      for (const id of [result.taskId, result.retryTaskId]) if (id) this.professionalConstructionTasks.set(id, businessAuthorizationSnapshot(professionalPrincipal));
    }
    return result;
  }

  async deleteConstructionAttachment(
    request: ConstructionAttachmentDeleteRequest,
  ): Promise<ConstructionAttachmentDeleteResponse> {
    const source = request?.source === 'overview' ? 'overview' : 'followup';
    const recordId = String(request?.recordId || '').trim();
    const fieldKey = String(request?.fieldKey || '').trim();
    const fileToken = String(request?.fileToken || '').trim();
    if (!recordId || !fieldKey || !fileToken) {
      throw new Error('删除附件需要 recordId、fieldKey 和 fileToken');
    }

    const config =
      source === 'overview'
        ? this.constructionOverviewConfig
        : this.constructionFollowupConfig;
    const fieldMap =
      source === 'overview'
        ? CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS
        : CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS;
    const optionalMissingFieldNames =
      source === 'overview'
        ? CONSTRUCTION_OVERVIEW_OPTIONAL_MISSING_FIELD_NAMES
        : CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES;
    const fieldName = fieldMap[fieldKey];
    if (!fieldName) {
      throw new Error(`未找到附件字段配置：${fieldKey}`);
    }
    if (!this.hasBitableSourceConfig(config)) {
      throw new Error(`${config.tableName}多维表待配置`);
    }

    return this.withConstructionAttachmentWriteLock(
      `${source}:${recordId}`,
      async () => {
        const appToken = await resolveBitableAppToken(this.httpService, config);
        const tenantAccessToken = await this.getFeishuTenantAccessToken();
        const record = await this.fetchBitableRecordById(
          appToken,
          config.tableId,
          config.tableName,
          recordId,
          tenantAccessToken,
        );
        const currentFiles = normalizeConstructionAttachmentFieldValue(
          record?.fields?.[fieldName],
        );
        const nextFiles = currentFiles.filter(
          (file) => file.file_token !== fileToken,
        );
        if (nextFiles.length !== currentFiles.length) {
          await this.updateBitableRecordFields(
            appToken,
            config.tableId,
            config.tableName,
            recordId,
            { [fieldName]: nextFiles },
            tenantAccessToken,
            { optionalMissingFieldNames },
          );
          invalidateBitableRecordCache({
            appToken,
            tableId: config.tableId,
            deletePersisted: true,
          });
        }

        return {
          success: true,
          source,
          recordId,
          fieldKey,
          field: fieldName,
          fileToken,
          remaining: nextFiles.length,
          message:
            nextFiles.length === currentFiles.length
              ? '附件已不在多维表中'
              : '附件已从多维表删除',
        };
      },
    );
  }

  private async createConstructionFollowupNow(
    request: ConstructionFollowupCreateRequest,
    files: ConstructionUploadFile[] = [],
    accessRole: AccessRole = 'guest',
    existingTenantAccessToken?: string,
    professionalPrincipal?: AccessPrincipal,
  ): Promise<ConstructionFollowupCreateResponse> {
    if (accessRole === 'professional_admin') {
      if (!isProfessionalBusinessPrincipal(professionalPrincipal)) throw new Error('专业主管身份缺失');
      await this.authorizeProfessionalConstruction(professionalPrincipal, request.constructionRecordId);
      if (request.followupRecordId) await this.authorizeProfessionalConstruction(professionalPrincipal, request.followupRecordId, 'followup');
    }
    if (!this.hasBitableSourceConfig(this.constructionFollowupConfig)) {
      throw new Error(
        `${this.constructionFollowupConfig.tableName}多维表待配置`,
      );
    }

    const normalizedFiles = this.normalizeConstructionUploadFiles(files);
    const requestForBuild = shouldInferConstructionPermitOnlyUpload(
      request,
      normalizedFiles,
    )
      ? { ...request, permitOnlyUpload: 'true' }
      : request;
    const { fields, normalized } =
      buildConstructionFollowupFields(requestForBuild);
    const hasCrewRosterUpload = normalizedFiles.some(
      (file) => file.fieldname === 'crewRosterFiles',
    );
    if (hasCrewRosterUpload) {
      parseConstructionCrewRosterFiles(
        normalizedFiles,
        normalized.followupDate
          ? new Date(`${normalized.followupDate}T00:00:00+08:00`)
          : new Date(),
      );
    }
    const generatedChecklistFile =
      normalized.followupMode === 'daily' &&
      normalized.dailyFollowupStage === 'close' &&
      normalized.completionChecklist
        ? buildConstructionCompletionChecklistFile({
            checklist: normalized.completionChecklist,
            templateItems: getConstructionCompletionChecklistItems(
              normalized.completed,
            ),
            title:
              normalized.completed === '否'
                ? '施工每日完工检查表'
                : '施工完工检查表',
            constructionCode: normalized.checklistContext.constructionCode,
            workContent: normalized.checklistContext.workContent,
            building: normalized.checklistContext.building,
            contractor: normalized.checklistContext.contractor,
            planStartTime: normalized.checklistContext.planStartTime,
            planEndTime: normalized.checklistContext.planEndTime,
          })
        : null;
    const followupAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionFollowupConfig,
    );
    const tenantAccessToken =
      existingTenantAccessToken || (await this.getFeishuTenantAccessToken());
    const fastSubmitExistingFollowupUpload =
      isConstructionManualReviewAutoApprovalRole(accessRole, professionalPrincipal) &&
      Boolean(normalized.followupRecordId && normalizedFiles.length > 0);
    let relatedProjectFollowupRecords: BitableRecordItem[] = [];
    const existingFollowupRecord = normalized.followupRecordId
      ? fastSubmitExistingFollowupUpload
        ? null
        : await this.fetchConstructionFollowupRecordById(
            followupAppToken,
            normalized.followupRecordId,
            tenantAccessToken,
          )
      : normalized.followupMode === 'daily'
        ? await this.findTodayConstructionDailyFollowupRecord(
            followupAppToken,
            normalized,
            (records) => {
              relatedProjectFollowupRecords = records;
            },
          )
        : null;
    const existingFollowupFields = existingFollowupRecord?.fields || {};
    const shouldAuditDailyPersonnel =
      normalized.followupMode === 'daily' &&
      normalized.dailyFollowupStage === 'prepare' &&
      !normalized.permitOnlyUpload &&
      (!normalized.partialDailySubmit ||
        normalized.dailyChecklistFocus === 'personnel');
    const isFocusedDailyPersonnelSubmit =
      shouldAuditDailyPersonnel &&
      normalized.partialDailySubmit &&
      normalized.dailyChecklistFocus === 'personnel';
    let dailyPersonnelAuditWorkTypes = normalized.workTypes;
    if (isFocusedDailyPersonnelSubmit) {
      delete fields.当日作业类型;
      delete fields[CONSTRUCTION_DAILY_PERSONNEL_CHECK_AUDIT_FIELD];
      dailyPersonnelAuditWorkTypes = extractDisplayValues(
        existingFollowupFields.当日作业类型,
      );
      if (dailyPersonnelAuditWorkTypes.length === 0) {
        throw new Error('请先完成当天作业类型校核');
      }
      normalized.workTypes = dailyPersonnelAuditWorkTypes;
    }
    if (shouldAuditDailyPersonnel && dailyPersonnelAuditWorkTypes.length > 0) {
      const requirementRecords =
        await this.fetchConstructionPermitAuditRequirementRecords();
      const dailyPersonnelCertificateAudit =
        buildDailyPersonnelCertificateAuditResult(
          dailyPersonnelAuditWorkTypes,
          normalized.dailyPersonnelCheckParticipants,
          requirementRecords,
        );
      if (dailyPersonnelCertificateAudit) {
        fields[CONSTRUCTION_DAILY_PERSONNEL_CHECK_AUDIT_FIELD] =
          dailyPersonnelCertificateAudit.feedback;
        if (!dailyPersonnelCertificateAudit.passed) {
          throw new Error(
            dailyPersonnelCertificateAudit.blockingMessage ||
              dailyPersonnelCertificateAudit.feedback,
          );
        }
      }
    }
    if (
      normalized.followupMode === 'daily' &&
      normalized.followupRecordId &&
      relatedProjectFollowupRecords.length === 0 &&
      !fastSubmitExistingFollowupUpload
    ) {
      relatedProjectFollowupRecords =
        await this.fetchConstructionRelatedProjectFollowupRecords(
          followupAppToken,
          normalized.constructionRecordId,
          normalized.checklistContext.constructionCode,
        );
    }
    const canReplacePermitAttachmentSet =
      normalized.permitOnlyUpload &&
      isConstructionAttachmentReplacementAllowed(accessRole, professionalPrincipal, true);
    const retainedFollowupAttachmentFieldMap = canReplacePermitAttachmentSet
      ? CONSTRUCTION_REPLACEABLE_PERMIT_ATTACHMENT_FIELDS
      : this.canReplaceConstructionAttachmentSet(accessRole, professionalPrincipal)
        ? CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS
        : {};
    const retainedFollowupAttachmentFields =
      this.mapRetainedConstructionAttachmentFieldValues(
        request.retainedAttachmentTokens,
        retainedFollowupAttachmentFieldMap,
      );
    const hasRetainedFollowupAttachmentFields =
      Object.keys(retainedFollowupAttachmentFields).length > 0;
    const retainedFollowupPermitFileKeys =
      Object.keys(retainedFollowupAttachmentFieldMap).length > 0
        ? Object.keys(
            this.parseConstructionRetainedAttachmentTokens(
              request.retainedAttachmentTokens,
            ),
          ).filter(
            (fieldName) =>
              Boolean(retainedFollowupAttachmentFieldMap[fieldName]) &&
              CONSTRUCTION_PERMIT_UPLOAD_FIELD_NAMES.has(fieldName),
          )
        : [];
    const existingFollowupFieldsForAttachments =
      hasRetainedFollowupAttachmentFields
        ? {
            ...existingFollowupFields,
            ...retainedFollowupAttachmentFields,
          }
        : existingFollowupFields;
    const changedNormalizedFiles = normalizedFiles;
    if (
      normalized.followupMode === 'supplemental' &&
      hasConstructionApprovalMaterialUpload(changedNormalizedFiles)
    ) {
      fields.材料是否上传完成 = true;
    }
    if (existingFollowupRecord) {
      const changedFields = omitUnchangedConstructionFieldValues(
        omitUnchangedConstructionPersonFields(fields, existingFollowupFields),
        existingFollowupFields,
      );
      Object.keys(fields).forEach((fieldName) => delete fields[fieldName]);
      Object.assign(fields, changedFields);
    }
    const shouldGenerateDailyPersonnelChecklist =
      normalized.followupMode === 'daily' &&
      normalized.dailyFollowupStage === 'prepare' &&
      (normalized.dailyPersonnelCheckParticipants.length > 0 ||
        Boolean(normalized.dailyPersonnelCheck));
    const immediateFiles = [
      ...changedNormalizedFiles,
      ...(generatedChecklistFile ? [generatedChecklistFile] : []),
    ];
    const shouldEnsureCrewLedgerProjectView =
      shouldGenerateDailyPersonnelChecklist ||
      immediateFiles.some((file) =>
        ['crewRosterFiles', 'dailyPersonnelChecklistFiles'].includes(
          file.fieldname,
        ),
      );
    const existingAttachmentFields = existingFollowupRecord
      ? this.getExistingConstructionAttachmentFieldKeys(
          existingFollowupFieldsForAttachments,
        )
      : [];
    if (
      shouldGenerateDailyPersonnelChecklist &&
      !existingAttachmentFields.includes('dailyPersonnelChecklistFiles')
    ) {
      existingAttachmentFields.push('dailyPersonnelChecklistFiles');
    }
    validateConstructionFollowupSubmission(
      normalized,
      normalized.permitOnlyUpload ? normalizedFiles : immediateFiles,
      {
        existingAttachmentFields,
        requirePermitValidityDates:
          isConstructionManualReviewAutoApprovalRole(accessRole, professionalPrincipal),
      },
    );
    const changedPermitFileKeys = changedNormalizedFiles
      .map((file) => file.fieldname)
      .filter((fieldName) =>
        CONSTRUCTION_PERMIT_UPLOAD_FIELD_NAMES.has(fieldName),
      );
    const inheritanceBlockedPermitFileKeys = Array.from(
      new Set([...changedPermitFileKeys, ...retainedFollowupPermitFileKeys]),
    );
    const referenceDate = normalized.followupDate
      ? new Date(`${normalized.followupDate}T00:00:00+08:00`)
      : new Date();
    const manualReviewAutoApprovalPending =
      isConstructionManualReviewAutoApprovalRole(accessRole, professionalPrincipal) &&
      changedPermitFileKeys.some((fileKey) =>
        Boolean(normalized.permitValidUntilByFileKey[fileKey]),
      );
    const attachmentSyncPending =
      immediateFiles.length > 0 ||
      shouldGenerateDailyPersonnelChecklist ||
      manualReviewAutoApprovalPending;
    const updatingRecordId =
      normalized.followupRecordId ||
      (normalized.followupMode === 'daily' && existingFollowupRecord
        ? getRecordId(existingFollowupRecord)
        : '');
    if (!attachmentSyncPending && !updatingRecordId) {
      Object.assign(
        fields,
        this.buildConstructionFollowupAttachmentBackfillFields({
          accessRole,
          professionalPrincipal,
          uploadedFollowupAttachmentFields: {},
          existingFollowupRecord,
          existingFollowupFieldsForAttachments,
          retainedFollowupAttachmentFields,
          hasRetainedFollowupAttachmentFields,
          changedPermitFileKeys,
          permitValidFromByFileKey: normalized.permitValidFromByFileKey,
          permitValidUntilByFileKey: normalized.permitValidUntilByFileKey,
          inheritanceBlockedPermitFileKeys,
          relatedProjectFollowupRecords,
          targetRecordId: updatingRecordId,
          referenceDate,
          savedFields: fields,
        }),
      );
    }

    let savedRecordId = updatingRecordId;
    const invalidateFollowupRecordCache = () =>
      invalidateBitableRecordCache({
        appToken: followupAppToken,
        tableId: this.constructionFollowupConfig.tableId,
        deletePersisted: true,
      });
    if (updatingRecordId) {
      const updateExistingFollowupRecord = async () => {
        await this.updateBitableRecordFields(
          followupAppToken,
          this.constructionFollowupConfig.tableId,
          this.constructionFollowupConfig.tableName,
          updatingRecordId,
          fields,
          tenantAccessToken,
          {
            optionalMissingFieldNames:
              CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
          },
        );
      };
      if (!attachmentSyncPending) {
        await this.withConstructionAttachmentWriteLock(
          `followup:${updatingRecordId}`,
          async () => {
            let currentFollowupRecord = existingFollowupRecord;
            let currentFollowupFieldsForAttachments =
              existingFollowupFieldsForAttachments;
            currentFollowupRecord =
              await this.fetchConstructionFollowupRecordById(
                followupAppToken,
                updatingRecordId,
                tenantAccessToken,
              );
            if (!currentFollowupRecord) {
              throw new Error('未找到施工跟进记录，无法合并附件');
            }
            currentFollowupFieldsForAttachments =
              currentFollowupRecord.fields || {};
            Object.assign(
              fields,
              this.buildConstructionFollowupAttachmentBackfillFields({
                accessRole,
                professionalPrincipal,
                uploadedFollowupAttachmentFields: {},
                existingFollowupRecord: currentFollowupRecord,
                existingFollowupFieldsForAttachments:
                  currentFollowupFieldsForAttachments,
                retainedFollowupAttachmentFields,
                hasRetainedFollowupAttachmentFields,
                changedPermitFileKeys,
                permitValidFromByFileKey: normalized.permitValidFromByFileKey,
                permitValidUntilByFileKey: normalized.permitValidUntilByFileKey,
                inheritanceBlockedPermitFileKeys,
                relatedProjectFollowupRecords,
                targetRecordId: updatingRecordId,
                referenceDate,
                savedFields: fields,
              }),
            );
            await updateExistingFollowupRecord();
            invalidateFollowupRecordCache();
          },
        );
      } else {
        await updateExistingFollowupRecord();
        invalidateFollowupRecordCache();
      }
    } else {
      savedRecordId = await this.createBitableRecord(
        followupAppToken,
        this.constructionFollowupConfig.tableId,
        this.constructionFollowupConfig.tableName,
        fields,
        tenantAccessToken,
        {
          optionalMissingFieldNames:
            CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
        },
      );
      invalidateFollowupRecordCache();
    }
    const postSaveSyncInput: ConstructionFollowupPostSaveSyncInput = {
      normalized,
      followupAppToken,
      followupRecordId: savedRecordId,
      tenantAccessToken,
      savedFields: { ...fields },
      existingFields: existingFollowupRecord?.fields || {},
      existingFollowupRecord,
      existingFieldsForAttachments: existingFollowupFieldsForAttachments,
      relatedProjectFollowupRecords,
      retainedFollowupAttachmentFields,
      hasRetainedFollowupAttachmentFields,
      normalizedFiles,
      changedNormalizedFiles,
      changedPermitFileKeys,
      inheritanceBlockedPermitFileKeys,
      generatedChecklistFile,
      hasCrewRosterUpload,
      shouldEnsureCrewLedgerProjectView,
      attachmentSyncPending,
      updatingRecordId,
      referenceDate,
      request,
      accessRole,
      ...(professionalPrincipal ? { professionalPrincipal: businessAuthorizationSnapshot(professionalPrincipal) } : {}),
    };
    let taskId: string | undefined;
    if (normalized.partialDailySubmit || attachmentSyncPending) {
      taskId = this.scheduleConstructionFollowupPostSaveSync(postSaveSyncInput);
    } else {
      await this.runConstructionFollowupPostSaveSync(postSaveSyncInput);
    }

    return {
      success: true,
      recordId: savedRecordId,
      recordUrl: this.buildBitableRecordUrl(
        this.constructionFollowupConfig,
        savedRecordId,
      ),
      constructionRecordId: normalized.constructionRecordId,
      updated: Boolean(updatingRecordId),
      attachmentSyncPending,
      pendingSync: Boolean(taskId),
      taskId,
      message: this.buildConstructionFollowupSubmitMessage(
        normalized.permitOnlyUpload,
        Boolean(updatingRecordId),
        attachmentSyncPending,
      ),
    };
  }

  private buildConstructionFollowupSubmitMessage(
    permitOnlyUpload: boolean,
    updated: boolean,
    attachmentSyncPending: boolean,
  ): string {
    const base = permitOnlyUpload
      ? updated
        ? '新作业票已更新'
        : '新作业票已提交'
      : updated
        ? '施工跟进已更新'
        : '施工跟进已提交';
    return attachmentSyncPending ? `${base}，附件后台同步中` : base;
  }

  private shouldQueueConstructionFollowupSubmitRetry(
    request: ConstructionFollowupCreateRequest,
    files: ConstructionUploadFile[],
    error: unknown,
  ): boolean {
    const followupMode = String(request?.followupMode || 'daily').trim();
    const dailyFollowupStage = String(
      request?.dailyFollowupStage || 'prepare',
    ).trim();
    return (
      followupMode === 'daily' &&
      dailyFollowupStage === 'close' &&
      this.isRetryableFeishuRequestError(error)
    );
  }

  private async enqueueConstructionFollowupSubmitRetry(
    request: ConstructionFollowupCreateRequest,
    files: ConstructionUploadFile[],
    accessRole: AccessRole,
    error: unknown,
    professionalPrincipal?: AccessPrincipal,
  ): Promise<string> {
    return this.enqueueConstructionFollowupSubmitTask(
      request,
      files,
      accessRole,
      getBitableAxiosErrorMessage(error),
      professionalPrincipal,
    );
  }

  private async enqueueConstructionFollowupSubmit(
    request: ConstructionFollowupCreateRequest,
    files: ConstructionUploadFile[],
    accessRole: AccessRole,
    professionalPrincipal?: AccessPrincipal,
  ): Promise<string> {
    return this.enqueueConstructionFollowupSubmitTask(
      request,
      files,
      accessRole,
      '',
      professionalPrincipal,
    );
  }

  private async enqueueConstructionFollowupSubmitTask(
    request: ConstructionFollowupCreateRequest,
    files: ConstructionUploadFile[],
    accessRole: AccessRole,
    lastError: string,
    professionalPrincipal?: AccessPrincipal,
  ): Promise<string> {
    const now = new Date().toISOString();
    const id = `construction-followup-${Date.now()}-${crypto
      .randomBytes(6)
      .toString('hex')}`;
    const task: QueuedConstructionFollowupSubmitTask = {
      id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      nextRunAt: new Date(
        Date.now() + CONSTRUCTION_FOLLOWUP_SUBMIT_RETRY_INITIAL_DELAY_MS,
      ).toISOString(),
      attempts: 0,
      request: { ...request },
      files: files.map((file) => this.serializeConstructionUploadFile(file)),
      accessRole,
      lastError,
      ...(professionalPrincipal ? { professionalPrincipal: businessAuthorizationSnapshot(professionalPrincipal) } : {}),
    };
    this.ensureQueuedConstructionFollowupSyncTask(task);
    await this.persistQueuedConstructionFollowupSubmitTask(task);
    this.scheduleQueuedConstructionFollowupSubmitRetry(
      id,
      CONSTRUCTION_FOLLOWUP_SUBMIT_RETRY_INITIAL_DELAY_MS,
    );
    if (lastError) {
      this.logger.warn(
        `施工跟进提交已进入本地后台队列：task=${id}，原因=${lastError}`,
      );
    } else {
      this.logger.log(`施工跟进已受理并进入本地后台队列：task=${id}`);
    }
    return id;
  }

  private serializeConstructionUploadFile(
    file: ConstructionUploadFile,
  ): QueuedConstructionUploadFile {
    const buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : Buffer.from(file.buffer || []);
    return {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype || 'application/octet-stream',
      size: file.size || buffer.length,
      bufferBase64: buffer.toString('base64'),
    };
  }

  private deserializeConstructionUploadFiles(
    files: readonly QueuedConstructionUploadFile[],
  ): ConstructionUploadFile[] {
    return files.map((file) => {
      const buffer = Buffer.from(file.bufferBase64 || '', 'base64');
      return {
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype || 'application/octet-stream',
        size: file.size || buffer.length,
        buffer,
      } as ConstructionUploadFile;
    });
  }

  private async persistQueuedConstructionFollowupSubmitTask(
    task: QueuedConstructionFollowupSubmitTask,
  ): Promise<void> {
    await mkdir(CONSTRUCTION_FOLLOWUP_SUBMIT_QUEUE_DIR, { recursive: true });
    const target = this.getQueuedConstructionFollowupSubmitTaskPath(task.id);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(task), 'utf8');
    await rename(temp, target);
  }

  private getQueuedConstructionFollowupSubmitTaskPath(id: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(CONSTRUCTION_FOLLOWUP_SUBMIT_QUEUE_DIR, `${safeId}.json`);
  }

  private scheduleExistingConstructionFollowupSubmitRetries(): void {
    void this.loadQueuedConstructionFollowupSubmitTasks()
      .then((tasks) => {
        const now = Date.now();
        tasks.forEach((task) =>
          this.ensureQueuedConstructionFollowupSyncTask(task),
        );
        tasks
          .filter((task) => task.status !== 'failed')
          .forEach((task) => {
            const delayMs = Math.max(
              1000,
              new Date(task.nextRunAt).getTime() - now,
            );
            this.scheduleQueuedConstructionFollowupSubmitRetry(
              task.id,
              delayMs,
            );
          });
      })
      .catch((error) => {
        this.logger.warn(
          `施工跟进本地队列加载失败: ${getBitableAxiosErrorMessage(error)}`,
        );
      });
  }

  private async loadQueuedConstructionFollowupSubmitTasks(): Promise<
    QueuedConstructionFollowupSubmitTask[]
  > {
    try {
      await mkdir(CONSTRUCTION_FOLLOWUP_SUBMIT_QUEUE_DIR, { recursive: true });
      const fileNames = await readdir(CONSTRUCTION_FOLLOWUP_SUBMIT_QUEUE_DIR);
      const tasks = await Promise.all(
        fileNames
          .filter((fileName) => fileName.endsWith('.json'))
          .map(async (fileName) =>
            this.readQueuedConstructionFollowupSubmitTaskByPath(
              join(CONSTRUCTION_FOLLOWUP_SUBMIT_QUEUE_DIR, fileName),
            ),
          ),
      );
      return tasks.filter(
        (task): task is QueuedConstructionFollowupSubmitTask => Boolean(task),
      );
    } catch (error) {
      this.logger.warn(
        `施工跟进本地队列读取失败: ${getBitableAxiosErrorMessage(error)}`,
      );
      return [];
    }
  }

  private async readQueuedConstructionFollowupSubmitTask(
    id: string,
  ): Promise<QueuedConstructionFollowupSubmitTask | null> {
    return this.readQueuedConstructionFollowupSubmitTaskByPath(
      this.getQueuedConstructionFollowupSubmitTaskPath(id),
    );
  }

  private async readQueuedConstructionFollowupSubmitTaskByPath(
    path: string,
  ): Promise<QueuedConstructionFollowupSubmitTask | null> {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as QueuedConstructionFollowupSubmitTask;
      if (!parsed?.id || !parsed?.request || !Array.isArray(parsed.files)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private scheduleQueuedConstructionFollowupSubmitRetry(
    id: string,
    delayMs: number,
  ): void {
    if (this.queuedConstructionFollowupSubmitTimers.has(id)) {
      return;
    }
    const timer = setTimeout(
      () => {
        this.queuedConstructionFollowupSubmitTimers.delete(id);
        void this.processQueuedConstructionFollowupSubmitTask(id);
      },
      Math.max(1000, delayMs),
    );
    timer.unref?.();
    this.queuedConstructionFollowupSubmitTimers.set(id, timer);
  }

  private async processQueuedConstructionFollowupSubmitTask(
    id: string,
  ): Promise<void> {
    const task = await this.readQueuedConstructionFollowupSubmitTask(id);
    if (!task || task.status === 'failed') {
      return;
    }
    const syncTask = this.ensureQueuedConstructionFollowupSyncTask(task);

    const now = new Date().toISOString();
    const runningTask: QueuedConstructionFollowupSubmitTask = {
      ...task,
      status: 'running',
      attempts: task.attempts + 1,
      updatedAt: now,
    };
    await this.persistQueuedConstructionFollowupSubmitTask(runningTask);
    syncTask.status = 'running';
    syncTask.message = '施工跟进后台重试同步中';

    let latestTask = runningTask;
    try {
      const result = await this.createConstructionFollowupNow(
        runningTask.request,
        this.deserializeConstructionUploadFiles(runningTask.files),
        runningTask.accessRole ?? 'guest',
        undefined,
        runningTask.professionalPrincipal,
      );
      const followupRecordId = result.recordId?.trim();
      if (
        followupRecordId &&
        latestTask.request.followupRecordId !== followupRecordId
      ) {
        latestTask = {
          ...latestTask,
          updatedAt: new Date().toISOString(),
          request: {
            ...latestTask.request,
            followupRecordId,
          },
        };
        await this.persistQueuedConstructionFollowupSubmitTask(latestTask);
      }
      if (result.taskId) {
        await this.waitForConstructionFollowupChildTask(result.taskId);
      }
      await rm(this.getQueuedConstructionFollowupSubmitTaskPath(id), {
        force: true,
      });
      syncTask.status = 'completed';
      syncTask.endTime = new Date();
      syncTask.total = 1;
      syncTask.inserted = 1;
      syncTask.failed = 0;
      syncTask.result = result;
      syncTask.message = '施工跟进后台重试同步完成';
      this.logger.log(`施工跟进本地队列同步成功：task=${id}`);
    } catch (error) {
      const retryable =
        !(error instanceof ConstructionFollowupChildTaskError) &&
        this.isRetryableFeishuRequestError(error);
      const delayMs = retryable
        ? Math.min(
            CONSTRUCTION_FOLLOWUP_SUBMIT_RETRY_BASE_DELAY_MS *
              2 ** Math.max(0, latestTask.attempts - 1),
            CONSTRUCTION_FOLLOWUP_SUBMIT_RETRY_MAX_DELAY_MS,
          )
        : 0;
      const failedTask: QueuedConstructionFollowupSubmitTask = {
        ...latestTask,
        status: retryable ? 'pending' : 'failed',
        updatedAt: new Date().toISOString(),
        nextRunAt: retryable
          ? new Date(Date.now() + delayMs).toISOString()
          : latestTask.nextRunAt,
        lastError: getBitableAxiosErrorMessage(error),
      };
      await this.persistQueuedConstructionFollowupSubmitTask(failedTask);
      syncTask.status = retryable ? 'pending' : 'failed';
      syncTask.message = retryable
        ? `施工跟进后台同步等待重试：${failedTask.lastError}`
        : `施工跟进后台同步失败：${failedTask.lastError}`;
      if (!retryable) {
        syncTask.endTime = new Date();
        syncTask.total = 1;
        syncTask.inserted = 0;
        syncTask.failed = 1;
      }
      this.logger.warn(
        `施工跟进本地队列同步失败：task=${id}，status=${failedTask.status}，原因=${failedTask.lastError}`,
      );
      if (retryable) {
        this.scheduleQueuedConstructionFollowupSubmitRetry(id, delayMs);
      }
    }
  }

  private async waitForConstructionFollowupChildTask(
    taskId: string,
  ): Promise<void> {
    const deadline =
      Date.now() + CONSTRUCTION_FOLLOWUP_CHILD_TASK_WAIT_TIMEOUT_MS;
    while (true) {
      const task = this.syncTasks.get(taskId);
      if (!task) {
        throw new ConstructionFollowupChildTaskError(
          `施工跟进后台子任务不存在：${taskId}`,
        );
      }
      if (task.status === 'completed') {
        return;
      }
      if (task.status === 'failed') {
        throw new ConstructionFollowupChildTaskError(
          task.message || '施工跟进附件与后处理同步失败',
        );
      }
      if (Date.now() >= deadline) {
        throw new ConstructionFollowupChildTaskError(
          `施工跟进后台子任务等待超时：${taskId}`,
        );
      }
      await this.sleep(CONSTRUCTION_FOLLOWUP_CHILD_TASK_POLL_INTERVAL_MS);
    }
  }

  private ensureQueuedConstructionFollowupSyncTask(
    queuedTask: QueuedConstructionFollowupSubmitTask,
  ): SyncTask {
    if (queuedTask.professionalPrincipal) this.professionalConstructionTasks.set(queuedTask.id, queuedTask.professionalPrincipal);
    const existing = this.syncTasks.get(queuedTask.id);
    if (existing) {
      return existing;
    }
    const startTime = new Date(queuedTask.createdAt);
    const task: SyncTask = {
      id: queuedTask.id,
      status:
        queuedTask.status === 'failed'
          ? 'failed'
          : queuedTask.status === 'running'
            ? 'running'
            : 'pending',
      startTime: Number.isFinite(startTime.getTime()) ? startTime : new Date(),
      message:
        queuedTask.status === 'failed'
          ? `施工跟进后台同步失败：${queuedTask.lastError || '未知错误'}`
          : `施工跟进已暂存，后台同步中${
              queuedTask.lastError ? `：${queuedTask.lastError}` : ''
            }`,
      ...(queuedTask.status === 'failed'
        ? {
            endTime: new Date(queuedTask.updatedAt),
            total: 1,
            inserted: 0,
            failed: 1,
          }
        : {}),
    };
    this.syncTasks.set(task.id, task);
    return task;
  }

  private buildConstructionFollowupAttachmentBackfillFields(input: {
    accessRole: AccessRole;
    professionalPrincipal?: AccessPrincipal;
    uploadedFollowupAttachmentFields: Record<
      string,
      Array<{ file_token: string }>
    >;
    existingFollowupRecord: BitableRecordItem | null;
    existingFollowupFieldsForAttachments: Record<string, unknown>;
    retainedFollowupAttachmentFields: Record<string, unknown>;
    hasRetainedFollowupAttachmentFields: boolean;
    changedPermitFileKeys: readonly string[];
    permitValidFromByFileKey: Readonly<Record<string, string>>;
    permitValidUntilByFileKey: Readonly<Record<string, string>>;
    inheritanceBlockedPermitFileKeys: readonly string[];
    relatedProjectFollowupRecords: BitableRecordItem[];
    targetRecordId: string;
    referenceDate: Date;
    savedFields: Record<string, unknown>;
  }): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    const dailyPersonnelChecklistFieldName =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles;
    const uploadedDailyPersonnelChecklist =
      input.uploadedFollowupAttachmentFields[dailyPersonnelChecklistFieldName];
    const uploadedFieldsForMerge = {
      ...input.uploadedFollowupAttachmentFields,
    };
    if (this.canReplaceConstructionAttachmentSet(input.accessRole, input.professionalPrincipal)) {
      delete uploadedFieldsForMerge[dailyPersonnelChecklistFieldName];
    }

    const retainedFields = this.canReplaceConstructionAttachmentSet(input.accessRole, input.professionalPrincipal)
      ? input.retainedFollowupAttachmentFields
      : isConstructionAttachmentReplacementAllowed(input.accessRole, input.professionalPrincipal, true)
        ? Object.fromEntries(Object.entries(input.retainedFollowupAttachmentFields).filter(([field]) =>
            Object.values(CONSTRUCTION_REPLACEABLE_PERMIT_ATTACHMENT_FIELDS).includes(field)))
        : {};
    const hasRetainedFields = input.hasRetainedFollowupAttachmentFields && Object.keys(retainedFields).length > 0;
    if (hasRetainedFields) Object.assign(fields, retainedFields);
    const existingFollowupFieldsForMerge =
      hasRetainedFields
        ? {
            ...input.existingFollowupFieldsForAttachments,
            ...retainedFields,
          }
        : input.existingFollowupFieldsForAttachments;
    Object.assign(
      fields,
      input.existingFollowupRecord || hasRetainedFields
        ? mergeConstructionAttachmentFieldValues(
            existingFollowupFieldsForMerge,
            uploadedFieldsForMerge,
          )
        : uploadedFieldsForMerge,
    );
    if (
      this.canReplaceConstructionAttachmentSet(input.accessRole, input.professionalPrincipal) &&
      uploadedDailyPersonnelChecklist
    ) {
      fields[dailyPersonnelChecklistFieldName] =
        uploadedDailyPersonnelChecklist;
    }
    Object.assign(
      fields,
      this.buildConstructionPermitManualReviewClearFields(
        input.changedPermitFileKeys,
      ),
    );

    const fieldsForInheritance = {
      ...input.existingFollowupFieldsForAttachments,
      ...input.savedFields,
      ...fields,
    };
    const inheritedFields = this.buildInheritedDailyPermitFields({
      fields: fieldsForInheritance,
      records: input.relatedProjectFollowupRecords,
      targetRecordId: input.targetRecordId,
      changedPermitFileKeys: input.inheritanceBlockedPermitFileKeys,
      referenceDate: input.referenceDate,
    });
    Object.assign(fields, inheritedFields);
    Object.assign(
      fields,
      this.buildDailyPermitManualReviewAutoApprovalFieldsFromRecords({
        fields: { ...fieldsForInheritance, ...inheritedFields },
        records: input.relatedProjectFollowupRecords,
        targetRecordId: input.targetRecordId,
        referenceDate: input.referenceDate,
      }),
    );
    if (isConstructionManualReviewAutoApprovalRole(input.accessRole, input.professionalPrincipal)) {
      Object.assign(fields, buildConstructionPermitManualReviewAutoApprovalFields(
        { ...fieldsForInheritance, ...inheritedFields, ...fields },
        input.accessRole,
        input.permitValidUntilByFileKey,
        input.changedPermitFileKeys,
        input.permitValidFromByFileKey,
      ));
    }
    if (!this.isConstructionAiAuditEnabled()) {
      Object.values(CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS).forEach(
        (config) => {
          delete fields[config.feedbackField];
          for (const fallbackField of config.fallbackFeedbackFields || []) {
            delete fields[fallbackField];
          }
        },
      );
    }

    return fields;
  }

  private scheduleConstructionFollowupPostSaveSync(
    input: ConstructionFollowupPostSaveSyncInput,
  ): string {
    const task = this.createSyncTask('construction');
    task.message = '施工跟进主记录已保存，附件与后处理后台同步中';
    setImmediate(() => {
      void this.runConstructionFollowupPostSaveSyncTask(task.id, input);
    });
    return task.id;
  }

  private async runConstructionFollowupPostSaveSyncTask(
    taskId: string,
    input: ConstructionFollowupPostSaveSyncInput,
  ): Promise<void> {
    const task = this.syncTasks.get(taskId);
    if (!task) {
      return;
    }
    task.status = 'running';
    try {
      await this.runConstructionFollowupPostSaveSync(input);
      task.status = 'completed';
      task.endTime = new Date();
      task.total = 1;
      task.inserted = 1;
      task.failed = 0;
      task.result = {
        recordId: input.followupRecordId,
        constructionRecordId: input.normalized.constructionRecordId,
      };
      task.message = '施工跟进附件与后处理同步完成';
    } catch (error) {
      const message = getBitableAxiosErrorMessage(error);
      task.status = 'failed';
      task.endTime = new Date();
      task.total = 1;
      task.inserted = 0;
      task.failed = 1;
      task.message = `施工跟进附件与后处理同步失败：${message}`;
      this.logger.warn(`施工跟进附件后台同步失败: ${message}`);
    }
  }

  private async withConstructionAttachmentWriteLock<T>(
    lockKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = lockKey.trim();
    if (!key) {
      return operation();
    }

    const previous =
      this.constructionAttachmentWriteTails.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.constructionAttachmentWriteTails.set(key, tail);

    try {
      return await current;
    } finally {
      if (this.constructionAttachmentWriteTails.get(key) === tail) {
        this.constructionAttachmentWriteTails.delete(key);
      }
    }
  }

  private canReplaceConstructionAttachmentSet(
    accessRole: AccessRole,
    professionalPrincipal?: AccessPrincipal,
  ): boolean {
    return isConstructionAttachmentReplacementAllowed(accessRole, professionalPrincipal);
  }

  private async runConstructionFollowupPostSaveSync(
    input: ConstructionFollowupPostSaveSyncInput,
  ): Promise<void> {
    let savedFields = { ...input.savedFields };
    let generatedDailyPersonnelChecklistFile: ConstructionUploadFile | null =
      null;
    try {
      generatedDailyPersonnelChecklistFile =
        await this.buildDailyPersonnelChecklistUploadFile(
          input.existingFields,
          input.normalized,
          input.tenantAccessToken,
        );
    } catch (error) {
      const dailyPersonnelChecklistFieldName =
        CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles;
      const hasReplacement =
        input.changedNormalizedFiles.some(
          (file) => file.fieldname === 'dailyPersonnelChecklistFiles',
        ) ||
        this.getExistingConstructionAttachmentFieldKeys(
          input.existingFieldsForAttachments,
        ).includes('dailyPersonnelChecklistFiles');
      if (!hasReplacement) {
        this.logger.warn(
          `每日人员核查清单后台生成失败，且无可用替代附件: ${getBitableAxiosErrorMessage(error)}`,
        );
        throw error;
      }
      this.logger.warn(
        `每日人员核查清单后台生成失败，已保留${dailyPersonnelChecklistFieldName}替代附件并继续同步其他施工跟进数据: ${getBitableAxiosErrorMessage(error)}`,
      );
    }
    const effectiveFiles = [
      ...input.changedNormalizedFiles,
      ...(input.generatedChecklistFile ? [input.generatedChecklistFile] : []),
      ...(generatedDailyPersonnelChecklistFile
        ? [generatedDailyPersonnelChecklistFile]
        : []),
    ];
    const permitAuditFiles = input.normalized.permitOnlyUpload
      ? input.normalizedFiles
      : effectiveFiles;
    const auditPromise = this.isConstructionAiAuditEnabled()
      ? this.auditConstructionFollowupFiles({
          normalized: input.normalized,
          effectiveFiles,
          permitAuditFiles,
          referenceDate: input.referenceDate,
        })
      : null;
    if (auditPromise) {
      // 上传可能慢于审核，先挂拒绝处理器；原 Promise 仍交给回填流程传播错误。
      void auditPromise.catch(() => undefined);
    }

    if (effectiveFiles.length > 0) {
      let attachmentUpdateFields: Record<string, unknown> = {};
      try {
        const uploadedFollowupAttachmentFields =
          await this.uploadConstructionAttachmentFieldValues(
            input.tenantAccessToken,
            input.followupAppToken,
            effectiveFiles,
            CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
          );
        await this.withConstructionAttachmentWriteLock(
          `followup:${input.followupRecordId}`,
          async () => {
            let existingFollowupRecord = input.existingFollowupRecord;
            let existingFollowupFieldsForAttachments =
              input.existingFieldsForAttachments;
            if (input.updatingRecordId) {
              existingFollowupRecord =
                await this.fetchConstructionFollowupRecordById(
                  input.followupAppToken,
                  input.followupRecordId,
                  input.tenantAccessToken,
                );
              if (!existingFollowupRecord) {
                throw new Error('未找到施工跟进记录，无法合并附件');
              }
              existingFollowupFieldsForAttachments =
                existingFollowupRecord.fields || {};
            }

            attachmentUpdateFields =
              this.buildConstructionFollowupAttachmentBackfillFields({
                accessRole: input.accessRole,
                professionalPrincipal: input.professionalPrincipal,
                uploadedFollowupAttachmentFields,
                existingFollowupRecord,
                existingFollowupFieldsForAttachments,
                retainedFollowupAttachmentFields:
                  input.retainedFollowupAttachmentFields,
                hasRetainedFollowupAttachmentFields:
                  input.hasRetainedFollowupAttachmentFields,
                changedPermitFileKeys: input.changedPermitFileKeys,
                permitValidFromByFileKey:
                  input.normalized.permitValidFromByFileKey,
                permitValidUntilByFileKey:
                  input.normalized.permitValidUntilByFileKey,
                inheritanceBlockedPermitFileKeys:
                  input.inheritanceBlockedPermitFileKeys,
                relatedProjectFollowupRecords:
                  input.relatedProjectFollowupRecords,
                targetRecordId: input.followupRecordId,
                referenceDate: input.referenceDate,
                savedFields,
              });
            Object.assign(
              attachmentUpdateFields,
              await this.buildConstructionIsolationManualReviewAutoApprovalFields(
                {
                  accessRole: input.accessRole,
            professionalPrincipal: input.professionalPrincipal,
                  fields: {
                    ...existingFollowupFieldsForAttachments,
                    ...savedFields,
                    ...attachmentUpdateFields,
                  },
                  followupAppToken: input.followupAppToken,
                  tenantAccessToken: input.tenantAccessToken,
                },
              ),
            );
            if (Object.keys(attachmentUpdateFields).length > 0) {
              await this.updateBitableRecordFields(
                input.followupAppToken,
                this.constructionFollowupConfig.tableId,
                this.constructionFollowupConfig.tableName,
                input.followupRecordId,
                attachmentUpdateFields,
                input.tenantAccessToken,
                {
                  optionalMissingFieldNames:
                    CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
                },
              );
              invalidateBitableRecordCache({
                appToken: input.followupAppToken,
                tableId: this.constructionFollowupConfig.tableId,
                deletePersisted: true,
              });
            }
          },
        );
      } catch (error) {
        if (auditPromise) {
          void auditPromise.catch((auditError) => {
            this.logger.warn(
              `施工跟进附件上传失败后审核任务终止: ${getBitableAxiosErrorMessage(auditError)}`,
            );
          });
        }
        throw error;
      }
      savedFields = { ...savedFields, ...attachmentUpdateFields };
    } else if (isConstructionManualReviewAutoApprovalRole(input.accessRole, input.professionalPrincipal)) {
      const currentFields = {
        ...input.existingFieldsForAttachments,
        ...savedFields,
      };
      const manualReviewUpdateFields = {
        ...buildConstructionPermitManualReviewAutoApprovalFields(
          currentFields,
          input.accessRole,
          input.normalized.permitValidUntilByFileKey,
          input.changedPermitFileKeys,
          input.normalized.permitValidFromByFileKey,
        ),
        ...(await this.buildConstructionIsolationManualReviewAutoApprovalFields(
          {
            accessRole: input.accessRole,
                  professionalPrincipal: input.professionalPrincipal,
            fields: currentFields,
            followupAppToken: input.followupAppToken,
            tenantAccessToken: input.tenantAccessToken,
          },
        )),
      };
      if (Object.keys(manualReviewUpdateFields).length > 0) {
        await this.updateBitableRecordFields(
          input.followupAppToken,
          this.constructionFollowupConfig.tableId,
          this.constructionFollowupConfig.tableName,
          input.followupRecordId,
          manualReviewUpdateFields,
          input.tenantAccessToken,
          {
            optionalMissingFieldNames:
              CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
          },
        );
        invalidateBitableRecordCache({
          appToken: input.followupAppToken,
          tableId: this.constructionFollowupConfig.tableId,
          deletePersisted: true,
        });
        savedFields = { ...savedFields, ...manualReviewUpdateFields };
      }
    }

    if (auditPromise) {
      this.scheduleConstructionFollowupAuditBackfill({
        auditPromise,
        followupAppToken: input.followupAppToken,
        followupRecordId: input.followupRecordId,
        tenantAccessToken: input.tenantAccessToken,
        savedFields,
        existingFields: input.existingFields,
        changedPermitFileKeys: input.changedPermitFileKeys,
      });
    }

    await this.syncConstructionFollowupPostSaveSideEffects(input);
  }

  private async syncConstructionFollowupPostSaveSideEffects(
    input: ConstructionFollowupPostSaveSyncInput,
  ): Promise<void> {
    try {
      await this.ensureConstructionFollowupOverviewLink(
        input.followupAppToken,
        input.followupRecordId,
        input.normalized.constructionRecordId,
        input.tenantAccessToken,
      );
    } catch (error) {
      this.logger.warn(
        `施工跟进总览关联后台同步失败，已保留本次施工跟进提交: ${getBitableAxiosErrorMessage(error)}`,
      );
    }

    if (input.hasCrewRosterUpload) {
      const synced = await this.syncConstructionCrewRosterFilesToLedger({
        files: input.normalizedFiles,
        overviewRecordId: input.normalized.constructionRecordId,
        constructionCode: input.normalized.checklistContext.constructionCode,
        tenantAccessToken: input.tenantAccessToken,
        referenceDate: input.referenceDate,
      });
      void this.runConstructionCrewRosterCertificateBatchCheck({
        records: synced.records,
        overviewRecordId: input.normalized.constructionRecordId,
        constructionCode: input.normalized.checklistContext.constructionCode,
        tenantAccessToken: input.tenantAccessToken,
        members: synced.members,
      })
        .then((summary) =>
          this.notifyConstructionCrewRosterUploadSuccess(
            `施工跟进人员名单持证查询完成：${input.normalized.checklistContext.constructionCode}；${summary.summary}`,
          ),
        )
        .catch((error) =>
          this.logger.warn(
            `施工跟进人员名单持证查询后台执行失败: ${getBitableAxiosErrorMessage(error)}`,
          ),
        );
    }
    if (input.shouldEnsureCrewLedgerProjectView) {
      try {
        await this.ensureConstructionCrewLedgerProjectView(
          input.normalized.checklistContext.constructionCode,
          input.tenantAccessToken,
        );
      } catch (error) {
        this.logger.warn(
          `施工人员台账项目视图同步失败，已保留本次施工跟进提交: ${getBitableAxiosErrorMessage(error)}`,
        );
      }
    }

    await this.syncConstructionFollowupOverviewFields(input);
  }

  private async syncConstructionFollowupOverviewFields(
    input: ConstructionFollowupPostSaveSyncInput,
  ): Promise<void> {
    if (!this.hasBitableSourceConfig(this.constructionOverviewConfig)) {
      return;
    }

    const overviewAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionOverviewConfig,
    );
    let existingOverviewRecord: BitableRecordItem | null = null;
    const getExistingOverviewRecord = async () => {
      if (!existingOverviewRecord) {
        existingOverviewRecord = await this.fetchBitableRecordById(
          overviewAppToken,
          this.constructionOverviewConfig.tableId,
          this.constructionOverviewConfig.tableName,
          input.normalized.constructionRecordId,
          input.tenantAccessToken,
        );
      }
      return existingOverviewRecord;
    };
    const retainedOverviewAttachmentFields =
      this.canReplaceConstructionAttachmentSet(input.accessRole, input.professionalPrincipal)
        ? this.mapRetainedConstructionAttachmentFieldValues(
            input.request.retainedAttachmentTokens,
            CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS,
          )
        : {};
    const hasRetainedOverviewAttachmentFields =
      Object.keys(retainedOverviewAttachmentFields).length > 0;

    if (input.normalized.followupMode === 'daily') {
      const overviewRecord = await getExistingOverviewRecord();
      await this.backfillConstructionActualStartDateIfEmpty(
        overviewAppToken,
        input.normalized.constructionRecordId,
        overviewRecord?.fields || {},
        input.tenantAccessToken,
      );
    }

    const overviewAttachmentFileKeys = new Set([
      'constructionIssueFiles',
      'depositAgreementFiles',
      'depositTransferFiles',
    ]);
    const overviewAttachmentCandidates: ConstructionUploadFile[] =
      input.changedNormalizedFiles.filter((file) =>
        overviewAttachmentFileKeys.has(file.fieldname),
      );
    if (input.generatedChecklistFile && input.normalized.completed === '是') {
      overviewAttachmentCandidates.push({
        ...input.generatedChecklistFile,
        fieldname: 'completionChecklistArchiveFiles',
      });
    }
    const overviewAttachmentFiles =
      overviewAttachmentCandidates.length > 0
        ? await (async () => {
            const overviewRecord = await getExistingOverviewRecord();
            const existingOverviewFieldsForAttachments =
              hasRetainedOverviewAttachmentFields
                ? {
                    ...(overviewRecord?.fields || {}),
                    ...retainedOverviewAttachmentFields,
                  }
                : overviewRecord?.fields || {};
            return filterChangedConstructionUploadFilesByContent(
              overviewAttachmentCandidates,
              existingOverviewFieldsForAttachments,
              CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS,
              async (fileToken, tmpUrl) => {
                const attachment = await this.downloadConstructionAttachment(
                  fileToken,
                  { tmpUrl },
                );
                return attachment.buffer;
              },
            );
          })()
        : [];
    const overviewUpdateFields = buildConstructionFollowupOverviewFields(
      input.normalized,
    );
    if (hasRetainedOverviewAttachmentFields) {
      Object.assign(overviewUpdateFields, retainedOverviewAttachmentFields);
    }
    const overviewArchiveFields =
      overviewAttachmentFiles.length > 0
        ? await this.uploadConstructionAttachmentFieldValues(
            input.tenantAccessToken,
            overviewAppToken,
            overviewAttachmentFiles,
            CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS,
          )
        : {};
    await this.withConstructionAttachmentWriteLock(
      `overview:${input.normalized.constructionRecordId}`,
      async () => {
        if (Object.keys(overviewArchiveFields).length > 0) {
          const latestOverviewRecord = await this.fetchBitableRecordById(
            overviewAppToken,
            this.constructionOverviewConfig.tableId,
            this.constructionOverviewConfig.tableName,
            input.normalized.constructionRecordId,
            input.tenantAccessToken,
          );
          if (!latestOverviewRecord) {
            throw new Error('未找到施工总览记录，无法合并附件');
          }
          const existingOverviewFieldsForAttachments =
            hasRetainedOverviewAttachmentFields
              ? {
                  ...(latestOverviewRecord.fields || {}),
                  ...retainedOverviewAttachmentFields,
                }
              : latestOverviewRecord.fields || {};
          Object.assign(
            overviewUpdateFields,
            mergeConstructionAttachmentFieldValues(
              existingOverviewFieldsForAttachments,
              overviewArchiveFields,
            ),
          );
        }
        if (Object.keys(overviewUpdateFields).length > 0) {
          await this.updateBitableRecordFields(
            overviewAppToken,
            this.constructionOverviewConfig.tableId,
            this.constructionOverviewConfig.tableName,
            input.normalized.constructionRecordId,
            overviewUpdateFields,
            input.tenantAccessToken,
            {
              optionalMissingFieldNames:
                CONSTRUCTION_OVERVIEW_OPTIONAL_MISSING_FIELD_NAMES,
            },
          );
        }
        invalidateBitableRecordCache({
          appToken: overviewAppToken,
          tableId: this.constructionOverviewConfig.tableId,
          deletePersisted: true,
        });
      },
    );
  }

  private buildConstructionPermitManualReviewClearFields(
    changedPermitFileKeys: readonly string[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const changedKeys = new Set(changedPermitFileKeys);
    Object.entries(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).forEach(
      ([fileKey, config]) => {
        if (!changedKeys.has(fileKey)) {
          return;
        }
        result[config.reviewField] = null;
        result[config.fingerprintField] = null;
      },
    );
    return result;
  }

  private scheduleConstructionFollowupAuditBackfill(input: {
    auditPromise: Promise<[string | null, Record<string, string>]>;
    followupAppToken: string;
    followupRecordId: string;
    tenantAccessToken: string;
    savedFields: Record<string, unknown>;
    existingFields: Record<string, unknown>;
    changedPermitFileKeys: readonly string[];
  }): void {
    void this.backfillConstructionFollowupAuditFields(input).catch((error) => {
      this.logger.warn(
        `施工跟进AI审核结果后台回填失败: ${getBitableAxiosErrorMessage(error)}`,
      );
    });
  }

  private async backfillConstructionFollowupAuditFields(input: {
    auditPromise: Promise<[string | null, Record<string, string>]>;
    followupAppToken: string;
    followupRecordId: string;
    tenantAccessToken: string;
    savedFields: Record<string, unknown>;
    existingFields: Record<string, unknown>;
    changedPermitFileKeys: readonly string[];
  }): Promise<void> {
    const [isolationPhotoAuditFeedback, permitAuditFields] =
      await input.auditPromise;
    if (!this.isConstructionAiAuditEnabled()) {
      return;
    }

    const updateFields: Record<string, unknown> = {};

    if (isolationPhotoAuditFeedback) {
      const currentFeedback =
        typeof input.savedFields['挂牌&隔离合规反馈'] === 'string'
          ? input.savedFields['挂牌&隔离合规反馈']
          : '';
      updateFields['AI审核结果-挂牌&隔离照片'] = isolationPhotoAuditFeedback;
      updateFields['AI审核结果-挂牌与隔离照片'] = isolationPhotoAuditFeedback;
      updateFields['AI审核结果-挂牌&隔离合规反馈'] =
        isolationPhotoAuditFeedback;
      updateFields['挂牌&隔离合规反馈'] = [
        isolationPhotoAuditFeedback,
        currentFeedback && `人工补充：${currentFeedback}`,
      ]
        .filter(Boolean)
        .join('；');
    }

    Object.assign(
      updateFields,
      this.mergeConstructionTextFieldValues(
        input.existingFields,
        permitAuditFields,
      ),
    );

    const permitFingerprintFields =
      buildConstructionPermitManualReviewResetFields(
        input.savedFields as Record<string, Array<{ file_token: string }>>,
        permitAuditFields,
        input.changedPermitFileKeys,
      );
    Object.entries(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).forEach(
      ([fileKey, config]) => {
        if (!input.changedPermitFileKeys.includes(fileKey)) {
          return;
        }
        delete permitFingerprintFields[config.reviewField];
        if (
          extractConstructionPermitManualReviewValidityDate(
            String(input.savedFields[config.fingerprintField] || ''),
          )
        ) {
          delete permitFingerprintFields[config.fingerprintField];
        }
      },
    );
    Object.assign(updateFields, permitFingerprintFields);

    if (Object.keys(updateFields).length === 0) {
      return;
    }

    await this.updateBitableRecordFields(
      input.followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      input.followupRecordId,
      updateFields,
      input.tenantAccessToken,
      {
        optionalMissingFieldNames:
          CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
      },
    );
    invalidateBitableRecordCache({
      appToken: input.followupAppToken,
      tableId: this.constructionFollowupConfig.tableId,
      deletePersisted: true,
    });
  }

  async requestConstructionPermitManualReview(
    request: ConstructionPermitManualReviewRequest,
  ): Promise<ConstructionPermitManualReviewResponse> {
    if (!this.hasBitableSourceConfig(this.constructionFollowupConfig)) {
      throw new Error(
        `${this.constructionFollowupConfig.tableName}多维表待配置`,
      );
    }

    const followupRecordId = String(request?.followupRecordId || '').trim();
    const fileKey = String(request?.fileKey || '').trim();
    if (!followupRecordId) {
      throw new Error('缺少施工跟进记录 ID');
    }
    if (!isConstructionPermitManualReviewWorkflowFileKey(fileKey)) {
      throw new Error('当前作业票暂未配置人工审核审批流');
    }

    const followupAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionFollowupConfig,
    );
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const existingFollowupRecord =
      await this.fetchConstructionFollowupRecordById(
        followupAppToken,
        followupRecordId,
        tenantAccessToken,
      );
    if (!existingFollowupRecord) {
      throw new Error('未找到施工跟进记录，无法触发人工审核');
    }

    const existingFields = existingFollowupRecord.fields || {};
    const update = buildConstructionPermitManualReviewWorkflowFields(
      existingFields,
      fileKey,
    );
    if (!update) {
      throw new Error('当前作业票暂未配置人工审核审批流');
    }

    const permitFiles = normalizeConstructionAttachmentFieldValue(
      existingFields[update.attachmentField],
    );
    if (permitFiles.length === 0) {
      throw new Error(
        `当前记录未上传${update.attachmentField}，无法触发人工审核`,
      );
    }

    const ehsEngineer = pickField(existingFields, [
      'EHS工程师',
      'EHS 工程师',
      'EHS负责人',
      'EHS',
    ]);
    if (!this.hasBitableRecordFieldValue(ehsEngineer)) {
      throw new Error('当前记录未填写 EHS工程师，无法触发审批流');
    }

    await this.updateBitableRecordFields(
      followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      followupRecordId,
      update.fields,
      tenantAccessToken,
      {
        optionalMissingFieldNames:
          CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
      },
    );
    invalidateBitableRecordCache({
      appToken: followupAppToken,
      tableId: this.constructionFollowupConfig.tableId,
      deletePersisted: true,
    });

    return {
      success: true,
      recordId: followupRecordId,
      fileKey,
      field: update.attachmentField,
      reviewField: update.reviewField,
      workflowTriggered: true,
      message: '已触发EHS工程师作业票人工审核',
    };
  }

  async updateConstructionPermitManualReview(
    request: ConstructionPermitManualReviewUpdateRequest,
  ): Promise<ConstructionPermitManualReviewUpdateResponse> {
    if (!this.hasBitableSourceConfig(this.constructionFollowupConfig)) {
      throw new Error(
        `${this.constructionFollowupConfig.tableName}多维表待配置`,
      );
    }

    const followupRecordId = String(request?.followupRecordId || '').trim();
    const fileKey = String(request?.fileKey || '').trim();
    const decision = request?.decision;
    const hasValidFrom = hasOwnRuntimeProperty(request, 'validFrom');
    const validFrom = this.normalizeConstructionPermitManualValidUntil(
      request?.validFrom,
    );
    const validUntil = this.normalizeConstructionPermitManualValidUntil(
      request?.validUntil,
    );
    if (!followupRecordId) {
      throw new Error('缺少施工跟进记录 ID');
    }
    if (decision !== 'passed' && decision !== 'rejected') {
      throw new Error('人工审核结果必须是通过或驳回');
    }
    if (decision === 'passed' && !validUntil) {
      throw new Error('人工审核通过时必须填写授权有效期');
    }
    if (decision === 'passed' && hasValidFrom && !validFrom) {
      throw new Error('人工审核通过时必须填写授权有效期开始日期');
    }
    if (
      decision === 'passed' &&
      validFrom &&
      validUntil &&
      validFrom > validUntil
    ) {
      throw new Error('授权有效期开始日期不得晚于结束日期');
    }

    const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey];
    const reviewConfig = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[fileKey];
    if (!attachmentField || !reviewConfig) {
      throw new Error('当前作业票暂未配置人工审核字段');
    }

    const followupAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionFollowupConfig,
    );
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const existingFollowupRecord =
      await this.fetchConstructionFollowupRecordById(
        followupAppToken,
        followupRecordId,
        tenantAccessToken,
      );
    if (!existingFollowupRecord) {
      throw new Error('未找到施工跟进记录，无法更新人工审核');
    }

    const existingFields = existingFollowupRecord.fields || {};
    const existingPermitFiles = normalizeConstructionAttachmentFieldValue(
      existingFields[attachmentField],
    );
    const sourcePermitFiles = (request?.permitFileTokens || [])
      .map((fileToken) => String(fileToken || '').trim())
      .filter(Boolean)
      .map((fileToken) => ({ file_token: fileToken }));
    const permitFiles = existingPermitFiles.length
      ? existingPermitFiles
      : sourcePermitFiles;
    const requestFingerprint = String(request?.permitFingerprint || '').trim();
    if (permitFiles.length === 0 && !requestFingerprint) {
      throw new Error(`未找到${attachmentField}，无法更新人工审核`);
    }

    const auditConfig = CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS[fileKey];
    const targetFeedback = auditConfig
      ? extractDisplayText(
          pickField(existingFields, [
            auditConfig.feedbackField,
            ...(auditConfig.fallbackFeedbackFields || []),
          ]),
        )
      : '';
    const feedback =
      targetFeedback || String(request?.sourceFeedback || '').trim();
    const storedFingerprint = extractDisplayText(
      existingFields[reviewConfig.fingerprintField],
      '',
    );
    const storedValidityRange =
      extractConstructionPermitManualReviewValidityRange(storedFingerprint);
    const storedValidUntil = storedValidityRange.validUntil;
    const currentFingerprint = buildConstructionPermitManualReviewFingerprint(
      permitFiles,
      storedValidUntil || extractConstructionPermitFeedbackExpiryDate(feedback),
      storedValidUntil ? 'manual' : 'ai',
      storedValidityRange.validFrom,
    );
    if (
      requestFingerprint &&
      currentFingerprint &&
      requestFingerprint !== currentFingerprint
    ) {
      throw new Error('作业票已变化，请刷新后重新人工审核');
    }
    const fingerprint =
      decision === 'passed' && validUntil
        ? buildConstructionPermitManualReviewFingerprint(
            permitFiles,
            validUntil,
            'manual',
            validFrom,
          )
        : /^(?:v1:[a-z0-9]+|v2:\d{4}-\d{2}-\d{2}:[a-z0-9]+|v3:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}:[a-z0-9]+)$/i.test(
              requestFingerprint,
            )
          ? requestFingerprint
          : buildConstructionPermitManualReviewFingerprint(
              permitFiles,
              extractConstructionPermitFeedbackExpiryDate(feedback),
            );
    const reviewText = decision === 'passed' ? '通过' : '驳回';
    const updateFields: Record<string, unknown> = {
      [reviewConfig.reviewField]: reviewText,
    };
    if (fingerprint) {
      updateFields[reviewConfig.fingerprintField] = fingerprint;
    }

    await this.updateBitableRecordFields(
      followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      followupRecordId,
      updateFields,
      tenantAccessToken,
      {
        optionalMissingFieldNames:
          CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
      },
    );
    invalidateBitableRecordCache({
      appToken: followupAppToken,
      tableId: this.constructionFollowupConfig.tableId,
      deletePersisted: true,
    });

    return {
      success: true,
      recordId: followupRecordId,
      fileKey,
      field: attachmentField,
      reviewField: reviewConfig.reviewField,
      decision,
      validFrom: decision === 'passed' ? validFrom : null,
      validUntil: decision === 'passed' ? validUntil : null,
      message: `${attachmentField}人工审核已标记为${reviewText}`,
    };
  }

  private normalizeConstructionPermitManualValidUntil(
    value: unknown,
  ): string | null {
    const dateKey = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return null;
    }
    const parsed = new Date(`${dateKey}T00:00:00+08:00`);
    return Number.isFinite(parsed.getTime()) &&
      this.formatShanghaiDateKey(parsed) === dateKey
      ? dateKey
      : null;
  }

  async updateConstructionIsolationPhotoManualReview(
    request: ConstructionIsolationPhotoManualReviewUpdateRequest,
  ): Promise<ConstructionIsolationPhotoManualReviewUpdateResponse> {
    if (!this.hasBitableSourceConfig(this.constructionFollowupConfig)) {
      throw new Error(
        `${this.constructionFollowupConfig.tableName}多维表待配置`,
      );
    }

    const followupRecordId = String(request?.followupRecordId || '').trim();
    const decision = request?.decision;
    if (!followupRecordId) {
      throw new Error('缺少施工跟进记录 ID');
    }
    if (decision !== 'passed' && decision !== 'rejected') {
      throw new Error('挂牌隔离人工审核结果必须是通过或驳回');
    }

    const attachmentField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles;
    const reviewField = '挂牌与隔离是否合规';
    const followupAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionFollowupConfig,
    );
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const existingFollowupRecord =
      await this.fetchConstructionFollowupRecordById(
        followupAppToken,
        followupRecordId,
        tenantAccessToken,
      );
    if (!existingFollowupRecord) {
      throw new Error('未找到施工跟进记录，无法更新挂牌隔离人工审核');
    }

    const existingFields = existingFollowupRecord.fields || {};
    const isolationFiles = normalizeConstructionAttachmentFieldValue(
      existingFields[attachmentField],
    );
    const isolationFeedback = extractDisplayText(
      pickField(existingFields, [
        'AI审核结果-挂牌&隔离照片',
        'AI审核结果-挂牌与隔离照片',
        'AI审核结果-挂牌&隔离合规反馈',
        '挂牌&隔离合规反馈',
      ]),
    );
    if (isolationFiles.length === 0 && !isolationFeedback) {
      throw new Error('当前记录未上传挂牌与隔离照片，无法更新人工审核');
    }

    const reviewText = decision === 'passed' ? '通过' : '驳回';
    const fieldMetas = await this.fetchBitableFieldMetas(
      followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      tenantAccessToken,
    );
    const updateFields =
      this.buildConstructionIsolationManualReviewUpdateFields(
        fieldMetas,
        decision,
      );
    const updatedReviewField = Object.keys(updateFields)[0] || reviewField;
    if (Object.keys(updateFields).length === 0) {
      throw new Error(
        '未找到挂牌隔离人工审核字段，请在施工跟进多维表添加「人工审核-挂牌&隔离审核」或「挂牌与隔离是否合规」字段',
      );
    }
    await this.updateBitableRecordFields(
      followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      followupRecordId,
      updateFields,
      tenantAccessToken,
      {
        optionalMissingFieldNames:
          CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
      },
    );
    invalidateBitableRecordCache({
      appToken: followupAppToken,
      tableId: this.constructionFollowupConfig.tableId,
      deletePersisted: true,
    });

    return {
      success: true,
      recordId: followupRecordId,
      field: attachmentField,
      reviewField: updatedReviewField,
      decision,
      message: `${attachmentField}人工审核已标记为${reviewText}`,
    };
  }

  private async buildConstructionIsolationManualReviewAutoApprovalFields(input: {
    accessRole: AccessRole;
    professionalPrincipal?: AccessPrincipal;
    fields: Record<string, unknown>;
    followupAppToken: string;
    tenantAccessToken: string;
  }): Promise<Record<string, unknown>> {
    if (!isConstructionManualReviewAutoApprovalRole(input.accessRole, input.professionalPrincipal)) {
      return {};
    }

    const attachmentField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles;
    const isolationFiles = normalizeConstructionAttachmentFieldValue(
      input.fields[attachmentField],
    );
    if (isolationFiles.length === 0) {
      return {};
    }

    try {
      const fieldMetas = await this.fetchBitableFieldMetas(
        input.followupAppToken,
        this.constructionFollowupConfig.tableId,
        this.constructionFollowupConfig.tableName,
        input.tenantAccessToken,
      );
      return this.buildConstructionIsolationManualReviewUpdateFields(
        fieldMetas,
        'passed',
      );
    } catch (error) {
      this.logger.warn(
        `施工挂牌隔离默认审核通过回填失败，已保留附件同步: ${getBitableAxiosErrorMessage(error)}`,
      );
      return {};
    }
  }

  private buildConstructionIsolationManualReviewUpdateFields(
    fieldMetas: readonly BitableFieldMeta[],
    decision: ConstructionPermitManualReviewDecision,
  ): Record<string, unknown> {
    const candidates = [
      '人工审核-挂牌&隔离审核',
      '人工审核--挂牌&隔离审批',
      '挂牌与隔离是否合规',
      '挂牌&隔离是否合规',
      '挂牌隔离是否合规',
      '挂牌隔离人工审核',
      '挂牌隔离审核状态',
      '挂牌审核状态',
    ];
    const fieldsByName = new Map<string, BitableFieldMeta>();
    candidates.forEach((candidate) => {
      const field = fieldMetas.find(
        (item) => item.field_name.trim() === candidate,
      );
      if (field && !fieldsByName.has(field.field_name)) {
        fieldsByName.set(field.field_name, field);
      }
    });

    return Object.fromEntries(
      Array.from(fieldsByName.values()).map((field) => [
        field.field_name,
        this.getConstructionIsolationManualReviewFieldValue(field, decision),
      ]),
    );
  }

  private getConstructionIsolationManualReviewFieldValue(
    field: BitableFieldMeta,
    decision: ConstructionPermitManualReviewDecision,
  ): unknown {
    if (field.type === 7) {
      return decision === 'passed';
    }
    return decision === 'passed' ? '通过' : '驳回';
  }

  async createExceptionFollowUp(
    request: ExceptionFollowUpCreateRequest,
  ): Promise<ExceptionFollowUpCreateResponse> {
    const { fields, normalized } = buildExceptionFollowUpFields(request);
    const config = this.exceptionFollowUpConfig;

    if (!this.hasBitableSourceConfig(config)) {
      throw new Error(`${config.tableName}多维表待配置`);
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    assertBitableTableConfig(config.tableName, appToken, config.tableId);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const issueKey = String(fields['异常唯一键'] || '');
    const existingRecordId = await this.findExceptionFollowUpRecordIdByIssueKey(
      appToken,
      config,
      issueKey,
    );
    const recordId =
      existingRecordId ||
      (await this.createBitableRecord(
        appToken,
        config.tableId,
        config.tableName,
        fields,
        tenantAccessToken,
      ));
    if (existingRecordId) {
      await this.updateBitableRecordFields(
        appToken,
        config.tableId,
        config.tableName,
        existingRecordId,
        fields,
        tenantAccessToken,
      );
    }
    invalidateBitableRecordCache({
      appToken,
      tableId: config.tableId,
    });

    const item = buildExceptionFollowUpItem({
      recordId,
      type: normalized.type,
      typeLabel: normalized.typeLabel,
      abnormalLabel: normalized.abnormalLabel,
      date: normalized.date,
      detail: normalized.detail,
      detailedContent: normalized.detailedContent,
      handling: normalized.handling,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      success: true,
      type: normalized.type,
      typeLabel: normalized.typeLabel,
      abnormalLabel: normalized.abnormalLabel,
      recordId,
      detail: normalized.detail,
      detailedContent: normalized.detailedContent,
      handling: normalized.handling,
      date: normalized.date,
      matchKey: item.matchKey,
      notified: false,
      message: '异常跟进已保存',
      item,
    };
  }

  async getExceptionFollowUps(
    date?: string,
    forceRefresh = false,
    endDate?: string,
  ): Promise<ExceptionFollowUpListResponse> {
    const targetDate = this.normalizeFocusDate(date);
    const validDate = (value: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (endDate !== undefined && (
      !date || !validDate(date) || !validDate(endDate) ||
      endDate < date ||
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000 >= 62
    )) throw new BadRequestException('跟进查询日期范围无效，最多查询62天');
    const range = endDate !== undefined ? {start:targetDate,end:endDate} : undefined;
    const config = this.exceptionFollowUpConfig;

    if (!this.hasBitableSourceConfig(config)) {
      return {
        date: targetDate,
        ...(range ? {range} : {}),
        items: [],
        total: 0,
      };
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: config.tableId,
      tableName: config.tableName,
      forceRefresh,
    });
    const items = records
      .map((record) => this.mapExceptionFollowUpRecord(record))
      .filter((item): item is ExceptionFollowUpItem => Boolean(item))
      .filter((item) => range
        ? item.date >= range.start && item.date <= range.end
        : item.date === targetDate)
      .sort(
        (a, b) =>
          this.getExceptionFollowUpSortTime(b) -
          this.getExceptionFollowUpSortTime(a),
      );

    return {
      date: targetDate,
      ...(range ? {range} : {}),
      items,
      total: items.length,
    };
  }

  async updateExceptionFollowUp(
    request: ExceptionFollowUpUpdateRequest,
  ): Promise<ExceptionFollowUpUpdateResponse> {
    const { fields, normalized } = buildExceptionFollowUpFields(request);
    const updatePayload = buildExceptionFollowUpUpdateFields(request);
    const config = this.exceptionFollowUpConfig;

    if (!this.hasBitableSourceConfig(config)) {
      throw new Error(`${config.tableName}多维表待配置`);
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    assertBitableTableConfig(config.tableName, appToken, config.tableId);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    let effectiveRecordId = updatePayload.recordId;

    try {
      await this.updateBitableRecordFields(
        appToken,
        config.tableId,
        config.tableName,
        effectiveRecordId,
        updatePayload.fields,
        tenantAccessToken,
      );
    } catch (error) {
      if (!this.isBitableRecordNotFoundError(error)) {
        throw error;
      }

      const fallbackItem = await this.findCurrentExceptionFollowUpItem(
        request,
        appToken,
        config,
        request.previousHandling,
      );
      if (!fallbackItem || fallbackItem.recordId === effectiveRecordId) {
        throw error;
      }

      effectiveRecordId = fallbackItem.recordId;
      await this.updateBitableRecordFields(
        appToken,
        config.tableId,
        config.tableName,
        effectiveRecordId,
        updatePayload.fields,
        tenantAccessToken,
      );
    }
    invalidateBitableRecordCache({
      appToken,
      tableId: config.tableId,
    });

    const item = buildExceptionFollowUpItem({
      recordId: effectiveRecordId,
      type: normalized.type,
      typeLabel: normalized.typeLabel,
      abnormalLabel: normalized.abnormalLabel,
      date: normalized.date,
      detail: normalized.detail,
      detailedContent: normalized.detailedContent,
      handling: normalized.handling,
      updatedAt: new Date().toISOString(),
    });
    return {
      success: true,
      recordId: effectiveRecordId,
      handling: String(fields['处理措施'] || ''),
      notified: false,
      message: '异常跟进已保存',
      item,
    };
  }

  async deleteExceptionFollowUp(
    request: ExceptionFollowUpDeleteRequest,
  ): Promise<ExceptionFollowUpDeleteResponse> {
    const recordId = request?.recordId?.trim();
    const config = this.exceptionFollowUpConfig;

    if (!recordId) {
      throw new Error('缺少异常跟进记录 ID');
    }
    if (!this.hasBitableSourceConfig(config)) {
      throw new Error(`${config.tableName}多维表待配置`);
    }

    const appToken = await resolveBitableAppToken(this.httpService, config);
    assertBitableTableConfig(config.tableName, appToken, config.tableId);
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    let effectiveRecordId = recordId;

    try {
      await this.deleteBitableRecord(
        appToken,
        config.tableId,
        config.tableName,
        effectiveRecordId,
        tenantAccessToken,
      );
    } catch (error) {
      if (!this.isBitableRecordNotFoundError(error)) {
        throw error;
      }

      const fallbackItem = await this.findCurrentExceptionFollowUpItem(
        request,
        appToken,
        config,
        request.handling,
      );
      if (!fallbackItem || fallbackItem.recordId === effectiveRecordId) {
        throw error;
      }

      effectiveRecordId = fallbackItem.recordId;
      await this.deleteBitableRecord(
        appToken,
        config.tableId,
        config.tableName,
        effectiveRecordId,
        tenantAccessToken,
      );
    }
    invalidateBitableRecordCache({
      appToken,
      tableId: config.tableId,
    });

    return {
      success: true,
      recordId: effectiveRecordId,
      notified: false,
      message: '异常跟进已删除',
    };
  }

  private isBitableRecordNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /RecordIdNotFound|1254043/.test(message);
  }

  private async findCurrentExceptionFollowUpItem(
    request: { abnormalLabel?: string; date?: string; detail?: string },
    appToken: string,
    config: FocusBitableConfig,
    expectedHandling?: string,
  ): Promise<ExceptionFollowUpItem | null> {
    const date = this.normalizeFocusDate(request.date);
    const detailedContent = buildExceptionFollowUpDetailedContent(
      request.abnormalLabel || '',
      request.detail || '',
    );
    const comparable = normalizeExceptionFollowUpComparable(detailedContent);
    const normalizedExpectedHandling = this.normalizeDutyStaffRepairValue(
      expectedHandling || '',
    );
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: config.tableId,
      tableName: config.tableName,
      forceRefresh: true,
    });
    const matches = records
      .map((record) => this.mapExceptionFollowUpRecord(record))
      .filter((item): item is ExceptionFollowUpItem => Boolean(item))
      .filter(
        (item) =>
          item.date === date &&
          normalizeExceptionFollowUpComparable(item.detailedContent) ===
            comparable,
      );
    const handlingMatches = normalizedExpectedHandling
      ? matches.filter(
          (item) =>
            this.normalizeDutyStaffRepairValue(item.handling) ===
            normalizedExpectedHandling,
        )
      : matches;

    if (handlingMatches.length === 1) {
      return handlingMatches[0];
    }
    if (!normalizedExpectedHandling && matches.length === 1) {
      return matches[0];
    }
    return null;
  }

  private async findExceptionFollowUpRecordIdByIssueKey(
    appToken: string,
    config: FocusBitableConfig,
    issueKey: string,
  ): Promise<string> {
    if (!issueKey) {
      return '';
    }
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: config.tableId,
      tableName: config.tableName,
      forceRefresh: true,
    });
    const matches = records
      .filter(
        (record) =>
          extractDisplayText(pickField(record.fields || {}, ['异常唯一键'])) ===
          issueKey,
      )
      .map(getRecordId)
      .filter(Boolean);
    if (matches.length > 1) {
      throw new ConflictException('异常跟进唯一键存在重复记录，请先清理后重试');
    }
    return matches[0] || '';
  }

  private mapExceptionFollowUpRecord(
    record: BitableRecordItem,
  ): ExceptionFollowUpItem | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const source = extractDisplayText(pickField(fields, ['来源']), ' ');
    if (source && source !== '人工登记' && source !== '历史手工跟进') {
      return null;
    }
    const typeLabel = extractDisplayText(
      pickField(fields, ['异常类型', 'fldSktJRcP', '异常项类型']),
      ' ',
    );
    const detailedContent = extractDisplayText(
      pickField(fields, ['异常说明', '异常项', 'fldq2jX9Tk', '详细内容']),
      ' ',
    );
    const date = extractDateValue(
      pickField(fields, ['日期', 'fld0UVgst3', '异常日期']),
    );
    const handling = extractDisplayText(
      pickField(fields, ['处理措施', 'fldbwRf5Uq', '异常修正与处理']),
      '\n',
    );

    if (!recordId || !date || !detailedContent || !handling) {
      return null;
    }

    const parsed = splitExceptionFollowUpDetailedContent(detailedContent);
    const type = typeLabel === '排班异常' ? 'schedule' : 'sealing_change';

    return buildExceptionFollowUpItem({
      recordId,
      type,
      typeLabel: typeLabel || (type === 'schedule' ? '排班异常' : '封网&变更'),
      abnormalLabel: parsed.abnormalLabel,
      date,
      detail: parsed.detail,
      detailedContent,
      handling,
      createdAt: extractDateTimeIso(record.created_time),
      updatedAt: extractDateTimeIso(record.last_modified_time),
    });
  }

  private getExceptionFollowUpSortTime(item: ExceptionFollowUpItem): number {
    const updatedAt = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
    const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : 0;
    return (
      (Number.isFinite(updatedAt) ? updatedAt : 0) ||
      (Number.isFinite(createdAt) ? createdAt : 0) ||
      0
    );
  }

  private buildDutyStaffActualRepairCandidate(
    record: BitableRecordItem,
    fieldConfig: DutyStaffActualRepairFieldConfig,
  ): DutyStaffActualRepairCandidate | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const personText = this.normalizeDutyStaffRepairValue(
      extractDisplayText(
        pickField(fields, [
          fieldConfig.source.field_id,
          fieldConfig.source.field_name,
          '人员（文本）',
          '人员',
        ]),
        ' ',
      ),
    );
    const currentValue = this.normalizeDutyStaffRepairValue(
      extractDisplayText(
        pickField(fields, [
          fieldConfig.target.field_id,
          fieldConfig.target.field_name,
        ]),
        ' ',
      ),
    );
    const reason = this.getDutyStaffActualRepairReason(
      currentValue,
      personText,
    );

    if (!recordId || !reason) {
      return null;
    }

    const suggestedValue = personText;

    return {
      recordId,
      dutyCode:
        extractDisplayText(
          pickField(fields, ['fldITqhd37', '值班编码', '值班编号']),
        ) || null,
      scheduleDate: extractDateValue(
        pickField(fields, ['fldZSaDbGf', '排班日期', '日期']),
      ),
      building:
        extractDisplayText(
          pickField(fields, ['fldUHstSKX', 'fldnP4gXMn', '机楼', '楼栋']),
        ) || null,
      team:
        extractDisplayText(
          pickField(fields, ['fld5x9advB', 'fldE9Gwnk7', '班组', '班别']),
        ) || null,
      sourceField: fieldConfig.source.field_name,
      targetField: fieldConfig.target.field_name,
      personText,
      currentValue,
      suggestedValue,
      reason,
      canRepair: currentValue !== suggestedValue,
      updatedAt: extractDateTimeIso(record.last_modified_time),
    };
  }

  private async updateScheduleTextField(
    recordId: string,
    field: BitableFieldMeta,
    value: string,
    tenantAccessToken: string,
  ): Promise<void> {
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.scheduleAppToken}/tables/${this.scheduleTableId}/records/${recordId}`;
    const fieldKeys = Array.from(
      new Set([field.field_name, field.field_id].filter(Boolean)),
    );
    let lastError = '';

    for (const fieldKey of fieldKeys) {
      try {
        const response = await this.httpService.axiosRef.put(
          apiUrl,
          { fields: { [fieldKey]: value } },
          {
            headers: { Authorization: `Bearer ${tenantAccessToken}` },
            timeout: 30000,
          },
        );

        if (response.data.code === 0) {
          return;
        }
        lastError = response.data.msg || String(response.data.code);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new Error(`飞书记录更新失败: ${lastError || '未知错误'}`);
  }

  private async updateScheduleTextFields(
    recordId: string,
    entries: Array<{ field: BitableFieldMeta; value: string }>,
    tenantAccessToken: string,
  ): Promise<void> {
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.scheduleAppToken}/tables/${this.scheduleTableId}/records/${recordId}`;
    const fieldNamePayload = Object.fromEntries(
      entries
        .map((entry) => [entry.field.field_name, entry.value])
        .filter(([key]) => Boolean(key)),
    );
    const fieldIdPayload = Object.fromEntries(
      entries
        .map((entry) => [entry.field.field_id, entry.value])
        .filter(([key]) => Boolean(key)),
    );
    const payloads = [fieldNamePayload, fieldIdPayload].filter(
      (payload) => Object.keys(payload).length > 0,
    );
    let lastError = '';

    for (const fields of payloads) {
      try {
        const response = await this.httpService.axiosRef.put(
          apiUrl,
          { fields },
          {
            headers: { Authorization: `Bearer ${tenantAccessToken}` },
            timeout: 30000,
          },
        );

        if (response.data.code === 0) {
          return;
        }
        lastError = response.data.msg || String(response.data.code);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new Error(`飞书记录更新失败: ${lastError || '未知错误'}`);
  }

  private async runBitableRecordWriteWithRetry<T>(
    operation: () => Promise<T>,
    context: string,
    retryNetworkErrors = true,
    deadlineAt?: number,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= CONSTRUCTION_BITABLE_WRITE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      this.assertChangeRequestDeadline(deadlineAt, context);
      try {
        const response = await this.waitWithinChangeRequestDeadline(
          operation(),
          deadlineAt,
          context,
        );
        const responseData = (
          response as {
            data?: unknown;
          }
        )?.data;
        if (
          responseData &&
          typeof responseData === 'object' &&
          !Array.isArray(responseData)
        ) {
          const bitableResponseData = responseData as Record<string, unknown>;
          if (!shouldRetryBitableWriteResponse(bitableResponseData)) {
            return response;
          }
          if (attempt >= CONSTRUCTION_BITABLE_WRITE_MAX_ATTEMPTS) {
            return response;
          }
          const delayMs =
            CONSTRUCTION_BITABLE_WRITE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          this.logger.warn(
            `${context}飞书数据暂未就绪，${delayMs}ms 后重试 (${attempt}/${CONSTRUCTION_BITABLE_WRITE_MAX_ATTEMPTS - 1})：${getBitableApiErrorMessage(bitableResponseData)}`,
          );
          await this.sleepWithinChangeRequestDeadline(
            delayMs,
            deadlineAt,
            `${context}退避`,
          );
          continue;
        }
        return response;
      } catch (error) {
        const errorResponseData = this.getBitableErrorResponseData(error);
        const isRetryableBusinessResponse = Boolean(
          errorResponseData &&
          shouldRetryBitableWriteResponse(errorResponseData),
        );
        if (
          attempt >= CONSTRUCTION_BITABLE_WRITE_MAX_ATTEMPTS ||
          !retryNetworkErrors ||
          (!isRetryableBusinessResponse &&
            !this.isRetryableFeishuRequestError(error))
        ) {
          throw error;
        }

        const delayMs =
          CONSTRUCTION_BITABLE_WRITE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `${context}飞书请求失败，${delayMs}ms 后重试 (${attempt}/${CONSTRUCTION_BITABLE_WRITE_MAX_ATTEMPTS - 1})：${getBitableAxiosErrorMessage(error)}`,
        );
        await this.sleepWithinChangeRequestDeadline(
          delayMs,
          deadlineAt,
          `${context}退避`,
        );
      }
    }

    throw new Error(`${context}失败`);
  }

  private async createBitableRecord(
    appToken: string,
    tableId: string,
    tableName: string,
    fields: Record<string, unknown>,
    tenantAccessToken: string,
    options: {
      clientToken?: string;
      optionalMissingFieldNames?: readonly string[];
      retryNetworkErrors?: boolean;
      deadlineAt?: number;
    } = {},
  ): Promise<string> {
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
    let payload = fields;
    const maxAttempts = (options.optionalMissingFieldNames?.length || 0) + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.assertChangeRequestDeadline(options.deadlineAt, `${tableName}写入`);
      const response = await this.runBitableRecordWriteWithRetry(
        () =>
          this.httpService.axiosRef.post(
            apiUrl,
            { fields: payload },
            {
              headers: { Authorization: `Bearer ${tenantAccessToken}` },
              ...(options.clientToken
                ? { params: { client_token: options.clientToken } }
                : {}),
              timeout: this.getChangeRequestBoundedAxiosTimeout(
                options.deadlineAt,
                `${tableName}写入`,
              ),
            },
          ),
        `${tableName}写入`,
        options.retryNetworkErrors !== false,
        options.deadlineAt,
      ).catch((error: unknown) => {
        if (error instanceof ChangeRequestDeadlineExceededError) {
          throw error;
        }
        const nextPayload = this.getBitablePayloadAfterMissingOptionalField(
          tableName,
          payload,
          this.getBitableErrorResponseData(error) || {
            msg: getBitableAxiosErrorMessage(error),
          },
          options.optionalMissingFieldNames,
        );
        if (nextPayload) {
          payload = nextPayload;
          return null;
        }
        const errorRecord =
          typeof error === 'object' && error !== null
            ? (error as {
                code?: unknown;
                response?: { status?: unknown };
                status?: unknown;
                statusCode?: unknown;
              })
            : null;
        throw Object.assign(
          new Error(
            `${tableName}写入失败: ${getBitableAxiosErrorMessage(error)}`,
          ),
          {
            cause: error,
            code: errorRecord?.code,
            response: errorRecord?.response,
            status: errorRecord?.status ?? errorRecord?.response?.status,
            statusCode: errorRecord?.statusCode,
          },
        );
      });

      if (!response) {
        continue;
      }

      if (response.data.code !== 0) {
        const nextPayload = this.getBitablePayloadAfterMissingOptionalField(
          tableName,
          payload,
          response.data,
          options.optionalMissingFieldNames,
        );
        if (nextPayload) {
          payload = nextPayload;
          continue;
        }
        throw Object.assign(
          new Error(
            `${tableName}写入失败: ${getBitableApiErrorMessage(response.data)}`,
          ),
          {
            bitableCode: response.data.code,
            responseData: {
              code: response.data.code,
              msg: response.data.msg,
            },
            upstreamStatus:
              typeof response.status === 'number' ? response.status : null,
          },
        );
      }

      const record = response.data.data?.record || {};
      const recordId =
        record.record_id || record.id || response.data.data?.record_id || '';
      if (!recordId) {
        throw new Error(`${tableName}写入成功但未返回记录 ID`);
      }

      return recordId;
    }

    throw new Error(`${tableName}写入失败: 可选缺失字段重试次数已用尽`);
  }

  private async ensureConstructionFollowupOverviewLink(
    followupAppToken: string,
    followupRecordId: string,
    overviewRecordId: string,
    tenantAccessToken: string,
  ): Promise<void> {
    const fieldMetas = await this.fetchBitableFieldMetas(
      followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      tenantAccessToken,
    );
    const overviewLinkField = this.findBitableField(
      fieldMetas,
      ['施工总览'],
      ['fldKX4B7sV'],
    );

    if (!overviewLinkField) {
      throw new Error('未找到“施工总览”关联字段，无法回填施工编码');
    }

    await this.updateBitableRecordFields(
      followupAppToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      followupRecordId,
      {
        [overviewLinkField.field_id || overviewLinkField.field_name]: [
          overviewRecordId,
        ],
      },
      tenantAccessToken,
    );
  }

  private async backfillConstructionActualStartDateIfEmpty(
    overviewAppToken: string,
    overviewRecordId: string,
    overviewFields: Record<string, unknown>,
    tenantAccessToken: string,
  ): Promise<void> {
    const actualStartFieldNames = ['实际开始日期', '实际开始时间', '实际开始'];
    if (
      this.hasBitableRecordFieldValue(
        pickField(overviewFields, actualStartFieldNames),
      )
    ) {
      return;
    }

    const fieldMetas = await this.fetchBitableFieldMetas(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      tenantAccessToken,
    );
    const actualStartField = this.findBitableField(
      fieldMetas,
      actualStartFieldNames,
    );

    if (!actualStartField) {
      throw new Error('未找到“实际开始日期”字段，无法回填首次跟进施工日期');
    }

    const currentValue =
      overviewFields[actualStartField.field_name] ??
      overviewFields[actualStartField.field_id];
    if (this.hasBitableRecordFieldValue(currentValue)) {
      return;
    }

    await this.updateBitableRecordFields(
      overviewAppToken,
      this.constructionOverviewConfig.tableId,
      this.constructionOverviewConfig.tableName,
      overviewRecordId,
      {
        [actualStartField.field_id || actualStartField.field_name]:
          this.getShanghaiTodayStartTimestamp(),
      },
      tenantAccessToken,
    );
  }

  private hasBitableRecordFieldValue(value: unknown): boolean {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }
    return value !== null && value !== undefined;
  }

  private getShanghaiTodayStartTimestamp(): number {
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return new Date(`${dateKey}T00:00:00+08:00`).getTime();
  }

  private async buildDailyPersonnelChecklistUploadFile(
    existingFields: Record<string, unknown>,
    normalized: ReturnType<
      typeof buildConstructionFollowupFields
    >['normalized'],
    tenantAccessToken: string,
  ): Promise<ConstructionUploadFile | null> {
    if (
      normalized.followupMode !== 'daily' ||
      normalized.dailyFollowupStage !== 'prepare'
    ) {
      return null;
    }

    const participants =
      normalized.dailyPersonnelCheckParticipants.length > 0
        ? normalized.dailyPersonnelCheckParticipants
        : normalized.dailyPersonnelCheck
          ? [
              {
                recordId: `manual-${new Intl.DateTimeFormat('en-CA', {
                  timeZone: 'Asia/Shanghai',
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                }).format(new Date())}`,
                name: normalized.dailyPersonnelCheck,
                certificateSummary: '手工填写核查结果',
                complianceStatus: null,
                issueSummary: null,
              },
            ]
          : [];
    if (participants.length === 0) {
      return null;
    }

    const existingWorkbookBuffer =
      await this.downloadExistingDailyPersonnelChecklist(
        existingFields,
        tenantAccessToken,
      );

    return buildDailyPersonnelChecklistFile({
      existingWorkbookBuffer,
      participants,
      constructionCode: normalized.checklistContext.constructionCode,
      workContent: normalized.checklistContext.workContent,
      building: normalized.checklistContext.building,
      checker: normalized.followupStaffIds.join('、'),
    });
  }

  private async downloadExistingDailyPersonnelChecklist(
    fields: Record<string, unknown>,
    tenantAccessToken: string,
  ): Promise<Buffer | null> {
    const fieldName =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles;
    const token = this.getLatestConstructionAttachmentToken(fields[fieldName]);
    if (!token) {
      return null;
    }

    try {
      const apiUrl = `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(
        token,
      )}/download`;
      const response = await this.httpService.axiosRef.get<ArrayBuffer>(
        apiUrl,
        {
          responseType: 'arraybuffer',
          headers: { Authorization: `Bearer ${tenantAccessToken}` },
          timeout: 30000,
        },
      );
      return Buffer.from(response.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`每日人员核查清单下载失败，将重新生成: ${message}`);
      return null;
    }
  }

  private getLatestConstructionAttachmentToken(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return null;
    }
    const item = [...value].reverse().find((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      return typeof (entry as Record<string, unknown>).file_token === 'string';
    }) as Record<string, unknown> | undefined;
    return typeof item?.file_token === 'string' ? item.file_token : null;
  }

  private async uploadConstructionAttachmentFieldValues(
    tenantAccessToken: string,
    appToken: string,
    files: ConstructionUploadFile[],
    fieldMap: Record<string, string>,
  ): Promise<Record<string, Array<{ file_token: string }>>> {
    const uploadedByKey =
      await this.uploadConstructionAttachmentTokensByFieldKey(
        tenantAccessToken,
        appToken,
        files,
        Object.keys(fieldMap),
      );

    return this.mapConstructionAttachmentTokensToFieldValues(
      uploadedByKey,
      fieldMap,
    );
  }

  private async uploadConstructionAttachmentTokensByFieldKey(
    tenantAccessToken: string,
    appToken: string,
    files: ConstructionUploadFile[],
    fieldKeys: readonly string[],
  ): Promise<Record<string, Array<{ file_token: string }>>> {
    const result: Record<string, Array<{ file_token: string }>> = {};
    const allowedFieldKeys = new Set(fieldKeys);
    const uploadItems = files
      .filter((file) => allowedFieldKeys.has(file.fieldname))
      .map((file) => ({ fieldKey: file.fieldname, file }));

    const uploadedItems = await this.mapWithConcurrency(
      uploadItems,
      CONSTRUCTION_ATTACHMENT_UPLOAD_CONCURRENCY,
      async ({ fieldKey, file }) => ({
        fieldKey,
        fileToken: await this.uploadConstructionAttachment(
          tenantAccessToken,
          appToken,
          file,
        ),
      }),
    );

    for (const { fieldKey, fileToken } of uploadedItems) {
      if (!result[fieldKey]) {
        result[fieldKey] = [];
      }
      result[fieldKey].push({ file_token: fileToken });
    }

    return result;
  }

  private mapConstructionAttachmentTokensToFieldValues(
    uploadedByKey: Record<string, Array<{ file_token: string }>>,
    fieldMap: Record<string, string>,
  ): Record<string, Array<{ file_token: string }>> {
    const result: Record<string, Array<{ file_token: string }>> = {};
    for (const [fieldKey, fieldName] of Object.entries(fieldMap)) {
      const uploaded = uploadedByKey[fieldKey];
      if (uploaded?.length) {
        result[fieldName] = uploaded;
      }
    }
    return result;
  }

  private parseConstructionRetainedAttachmentTokens(
    value: unknown,
  ): Record<string, string[]> {
    let parsedValue = value;
    if (typeof parsedValue === 'string') {
      const text = parsedValue.trim();
      if (!text) {
        return {};
      }
      try {
        parsedValue = JSON.parse(text);
      } catch {
        return {};
      }
    }
    if (
      !parsedValue ||
      typeof parsedValue !== 'object' ||
      Array.isArray(parsedValue)
    ) {
      return {};
    }

    const result: Record<string, string[]> = {};
    for (const [fieldKey, tokens] of Object.entries(
      parsedValue as Record<string, unknown>,
    )) {
      if (!Array.isArray(tokens)) {
        continue;
      }
      result[fieldKey] = Array.from(
        new Set(
          tokens.map((token) => String(token || '').trim()).filter(Boolean),
        ),
      );
    }
    return result;
  }

  private mapRetainedConstructionAttachmentFieldValues(
    value: unknown,
    fieldMap: Record<string, string>,
  ): Record<string, Array<{ file_token: string }>> {
    const retainedByKey = this.parseConstructionRetainedAttachmentTokens(value);
    const result: Record<string, Array<{ file_token: string }>> = {};
    for (const [fieldKey, tokens] of Object.entries(retainedByKey)) {
      const fieldName = fieldMap[fieldKey];
      if (!fieldName) {
        continue;
      }
      result[fieldName] = tokens.map((fileToken) => ({
        file_token: fileToken,
      }));
    }
    return result;
  }

  private async mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    };

    await Promise.all(Array.from({ length: limit }, () => runWorker()));
    return results;
  }

  private async auditConstructionFollowupFiles(input: {
    normalized: ReturnType<
      typeof buildConstructionFollowupFields
    >['normalized'];
    effectiveFiles: ConstructionUploadFile[];
    permitAuditFiles: ConstructionUploadFile[];
    referenceDate: Date;
  }): Promise<[string | null, Record<string, string>]> {
    if (!this.isConstructionAiAuditEnabled()) {
      return [null, {}];
    }

    const isolationAudit =
      input.normalized.followupMode === 'daily' &&
      input.normalized.dailyFollowupStage === 'prepare'
        ? this.auditConstructionIsolationPhotos(
            input.effectiveFiles,
            input.normalized.checklistContext,
          )
        : Promise.resolve(null);
    const permitAudit = this.auditConstructionPermitAttachments(
      input.permitAuditFiles,
      input.normalized.workTypes,
      input.referenceDate,
      {
        workContent: input.normalized.checklistContext.workContent,
        workTypes: input.normalized.workTypes,
        planStartTime: input.normalized.checklistContext.planStartTime,
      },
    );
    const trainingAssessmentAudit =
      this.auditConstructionTrainingAssessmentFiles(input.effectiveFiles);

    const [isolationFeedback, permitFields, trainingAssessmentFields] =
      await Promise.all([
        this.resolveConstructionFollowupAudit(
          isolationAudit,
          '挂牌与隔离照片视觉审核',
          () => buildIsolationPhotoAuditFeedback(input.effectiveFiles),
        ),
        this.resolveConstructionFollowupAudit(
          permitAudit,
          '作业票视觉审核',
          () =>
            this.buildConstructionPermitAuditFallbackFields(
              input.permitAuditFiles,
              input.referenceDate,
            ),
        ),
        this.resolveConstructionFollowupAudit(
          trainingAssessmentAudit,
          '培训考核审核',
          () =>
            this.buildConstructionTrainingAssessmentAuditFallbackFields(
              input.effectiveFiles,
            ),
        ),
      ]);

    return [
      isolationFeedback,
      {
        ...permitFields,
        ...trainingAssessmentFields,
      },
    ];
  }

  private async resolveConstructionFollowupAudit<T>(
    auditPromise: Promise<T>,
    label: string,
    fallback: () => T,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const guardedAuditPromise = auditPromise.catch((error) => {
      this.logger.warn(
        `${label}失败，已转人工复核并继续保存施工资料: ${this.getConstructionImageAuditErrorSummary(error)}`,
      );
      return fallback();
    });
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutId = setTimeout(() => {
        this.logger.warn(
          `${label}超过 ${Math.round(
            CONSTRUCTION_FOLLOWUP_AUDIT_DEADLINE_MS / 1000,
          )} 秒，已转人工复核并继续保存施工资料`,
        );
        resolve(fallback());
      }, CONSTRUCTION_FOLLOWUP_AUDIT_DEADLINE_MS);
    });

    try {
      return await Promise.race([guardedAuditPromise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private buildConstructionPermitAuditFallbackFields(
    files: ConstructionUploadFile[],
    referenceDate: Date,
  ): Record<string, string> {
    const result: Record<string, string> = {};

    Object.entries(CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS).forEach(
      ([fieldKey, config]) => {
        const permitFiles = files.filter((file) => file.fieldname === fieldKey);
        const feedback = buildConstructionPermitAuditFeedback(
          permitFiles,
          config.label,
          [],
          referenceDate,
          { requiresValidity: config.requiresValidity },
        );
        if (!feedback) {
          return;
        }

        const datedFeedback = buildDailyPermitAuditFeedbackWithDate(
          feedback,
          referenceDate,
        );
        result[config.feedbackField] = datedFeedback;
        for (const fallbackField of config.fallbackFeedbackFields || []) {
          result[fallbackField] = datedFeedback;
        }
      },
    );

    return result;
  }

  private buildConstructionTrainingAssessmentAuditFallbackFields(
    files: ConstructionUploadFile[],
  ): Record<string, string> {
    const assessmentFiles = files.filter(
      (file) => file.fieldname === 'entryTrainingAssessmentFiles',
    );
    const feedback = buildConstructionTrainingAssessmentAuditFeedback({
      signInPersonCount: inferConstructionTrainingSignInPersonCountFromFiles(
        files.filter((file) => file.fieldname === 'entryTrainingSignInFiles'),
      ),
      assessmentFileCount: assessmentFiles.length,
    });
    return feedback
      ? {
          [CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD]: feedback,
        }
      : {};
  }

  private async auditConstructionTrainingAssessmentFiles(
    files: ConstructionUploadFile[],
  ): Promise<Record<string, string>> {
    const signInFiles = files.filter(
      (file) => file.fieldname === 'entryTrainingSignInFiles',
    );
    const assessmentFiles = files.filter(
      (file) => file.fieldname === 'entryTrainingAssessmentFiles',
    );
    if (assessmentFiles.length === 0) {
      return {};
    }

    const localSignInPersonCount =
      inferConstructionTrainingSignInPersonCountFromFiles(signInFiles);
    const signInPersonCount =
      localSignInPersonCount ??
      (await this.auditConstructionTrainingSignInPersonCount(signInFiles));
    const feedback = buildConstructionTrainingAssessmentAuditFeedback({
      signInPersonCount,
      assessmentFileCount: assessmentFiles.length,
    });
    return feedback
      ? {
          [CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD]: feedback,
        }
      : {};
  }

  private async auditConstructionTrainingSignInPersonCount(
    files: ConstructionUploadFile[],
  ): Promise<number | null> {
    const imageFiles = files.filter(isConstructionImageUploadFile);
    if (imageFiles.length === 0) {
      return null;
    }

    const config = this.getConstructionImageAuditConfig();
    if (!config) {
      return null;
    }
    const status = buildConstructionImageAuditStatus(config);
    if (!status.supportsImageInput) {
      return null;
    }

    try {
      const payload = buildConstructionTrainingSignInCountVisionPayload(
        imageFiles,
        config.model,
        {
          disableThinking: this.isDeepSeekConstructionImageAuditConfig(config),
        },
      );
      const response = await this.postConstructionImageAudit(payload, config);
      const content = this.extractChatCompletionMessageContent(response.data);
      return parseConstructionTrainingSignInCountVisionResponse(content);
    } catch (error) {
      this.logger.warn(
        `入场培训签到人数视觉识别失败: ${this.getConstructionImageAuditErrorSummary(error)}`,
      );
      return null;
    }
  }

  private async auditConstructionIsolationPhotos(
    files: ConstructionUploadFile[],
    context?: IsolationPhotoVisionAuditContext,
  ): Promise<string | null> {
    const fallback = buildIsolationPhotoAuditFeedback(files);
    const imageFiles = files.filter(
      (file) =>
        file.fieldname === 'isolationPhotoFiles' &&
        /^image\//i.test(file.mimetype || ''),
    );
    if (!fallback || imageFiles.length === 0) {
      return fallback;
    }

    const config = this.getConstructionImageAuditConfig();
    if (!config) {
      return fallback;
    }
    const status = buildConstructionImageAuditStatus(config);
    if (!status.supportsImageInput) {
      return `${fallback}；${status.message}`;
    }

    try {
      const payload = buildIsolationPhotoVisionAuditPayload(
        imageFiles,
        config.model,
        {
          disableThinking: this.isDeepSeekConstructionImageAuditConfig(config),
          context,
        },
      );
      const response = await this.postConstructionImageAudit(payload, config);
      const content = this.extractChatCompletionMessageContent(response.data);
      const parsed = parseIsolationPhotoVisionAuditResponse(content);
      return formatIsolationPhotoVisionAuditFeedback(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`挂牌与隔离照片视觉审核失败: ${message}`);
      return fallback;
    }
  }

  private async auditConstructionPermitAttachments(
    files: ConstructionUploadFile[],
    workTypes: readonly string[] = [],
    referenceDate: Date = new Date(),
    context?: ConstructionPermitVisionAuditContext,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const permitEntries = Object.entries(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
    ).filter(([fieldKey]) => files.some((file) => file.fieldname === fieldKey));
    if (permitEntries.length === 0) {
      return result;
    }

    const requirementRecords =
      await this.fetchConstructionPermitAuditRequirementRecords();
    for (const [fieldKey, config] of permitEntries) {
      const permitFiles = files.filter((file) => file.fieldname === fieldKey);
      const requirementLines = buildConstructionPermitAuditRequirementLines(
        requirementRecords,
        config.label,
        workTypes,
      );
      const feedback = await this.auditConstructionPermitFiles(
        permitFiles,
        config.label,
        requirementLines,
        referenceDate,
        {
          requiresValidity: config.requiresValidity,
          context: {
            ...context,
            workTypes: context?.workTypes?.length
              ? context.workTypes
              : workTypes,
          },
        },
      );
      if (feedback) {
        const datedFeedback = buildDailyPermitAuditFeedbackWithDate(
          feedback,
          referenceDate,
        );
        result[config.feedbackField] = datedFeedback;
        for (const fallbackField of config.fallbackFeedbackFields || []) {
          result[fallbackField] = datedFeedback;
        }
      }
    }
    return result;
  }

  private async refreshDailyPermitAuditFeedbacksIfNeeded(
    input: {
      overviewRecords: BitableRecordItem[];
      followupRecords: BitableRecordItem[];
      crewRecords: BitableRecordItem[];
      referenceDate: Date;
    },
    aiAuditEnabled = this.isConstructionAiAuditEnabled(),
  ): Promise<boolean> {
    if (!aiAuditEnabled) {
      return false;
    }

    if (
      !this.hasBitableSourceConfig(this.constructionFollowupConfig) ||
      input.overviewRecords.length === 0 ||
      input.followupRecords.length === 0
    ) {
      return false;
    }

    const view = buildConstructionManagementView({
      generatedAt: input.referenceDate.toISOString(),
      overviewRecords: input.overviewRecords,
      followupRecords: input.followupRecords,
      crewRecords: input.crewRecords,
      overviewSourceUrl: this.constructionOverviewConfig.sourceUrl,
      followupSourceUrl: this.constructionFollowupConfig.sourceUrl,
      referenceDate: input.referenceDate,
    });
    const activeItems = view.items.filter((item) =>
      this.shouldRefreshDailyPermitAuditsForConstruction(item),
    );
    if (activeItems.length === 0) {
      return false;
    }

    const followupAppToken = await resolveBitableAppToken(
      this.httpService,
      this.constructionFollowupConfig,
    );
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    const requirementRecords =
      await this.fetchConstructionPermitAuditRequirementRecords();
    const updatesByRecordId = new Map<string, Record<string, unknown>>();
    const refreshedKeys = new Set<string>();

    for (const item of activeItems) {
      for (const [fieldKey, config] of Object.entries(
        CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
      )) {
        if (!this.isPermitRelevantToConstructionWorkTypes(fieldKey, item)) {
          continue;
        }

        const requiresValidity = config.requiresValidity !== false;
        const isApplicationAuditField = fieldKey === 'applicationFiles';
        const shouldAuditAllCandidates =
          !requiresValidity || isApplicationAuditField;
        const latestCandidate = shouldAuditAllCandidates
          ? null
          : requiresValidity
            ? this.findLatestPermitAttachmentCandidate(item, fieldKey)
            : null;
        const candidates = shouldAuditAllCandidates
          ? this.findPermitAttachmentCandidates(item, fieldKey)
          : requiresValidity
            ? latestCandidate
              ? [latestCandidate]
              : []
            : this.findPermitAttachmentCandidates(item, fieldKey);

        for (const candidate of candidates) {
          const manualReviewAutoFields =
            this.buildDailyPermitManualReviewAutoApprovalFields(
              item,
              candidate,
              input.referenceDate,
            );
          if (manualReviewAutoFields) {
            const updateFields =
              updatesByRecordId.get(candidate.followup.recordId) || {};
            Object.assign(updateFields, manualReviewAutoFields);
            updatesByRecordId.set(candidate.followup.recordId, updateFields);
          }

          const existingFeedback = String(
            candidate.group.feedback || '',
          ).trim();
          if (
            !requiresValidity &&
            existingFeedback &&
            /^结论[:：][^；;、\n\r]+[；;、]\s*1[.．]\s*/.test(
              existingFeedback,
            ) &&
            !/有效期至|未来日期|名称不一致|名称不同|行为告知书.*不一致|非要求的《?安全告知书|未明确|身份|应签人数无法确认|作业票列明|作业票中|施工计划开始时间|缺多人|EHS|负责人|作业人员|无法确认安全告知书人员数量|无法核对|日期无法判断|人员[:：]签字\d+人|签字[:：]已见\d+人签字/.test(
              existingFeedback,
            )
          ) {
            continue;
          }
          if (requiresValidity) {
            const hasFreshApplicationFeedback =
              isApplicationAuditField &&
              /^结论[:：][^；;、\n\r]+[；;、]\s*1[.．]\s*填写[:：]/.test(
                existingFeedback,
              ) &&
              /[；;、]\s*2[.．]\s*人员[:：][^；;\n\r]*(?:作业人数疑似\d+人|作业人数待核)[，,、][^；;\n\r]*身份证/.test(
                existingFeedback,
              ) &&
              !/分组[:：]|问题[:：]|完整性[:：]|人员[:：]\s*(但|且|并|其中)|视觉审核失败|Client network|ECONNRESET|ETIMEDOUT|socket disconnected/i.test(
                existingFeedback,
              );
            if (hasFreshApplicationFeedback) {
              continue;
            }
            if (
              !isApplicationAuditField &&
              !shouldRefreshDailyPermitAuditFeedback(
                candidate.group.feedback,
                input.referenceDate,
              )
            ) {
              continue;
            }
          }

          const refreshKey = `${candidate.followup.recordId}:${fieldKey}`;
          if (refreshedKeys.has(refreshKey)) {
            continue;
          }
          refreshedKeys.add(refreshKey);

          const reusableExpiryDate =
            requiresValidity &&
            !isApplicationAuditField &&
            this.canReuseDailyPermitAuditExpiry(candidate.group.feedback)
              ? extractConstructionPermitFeedbackExpiryDate(
                  candidate.group.feedback,
                )
              : null;
          const feedback = reusableExpiryDate
            ? formatConstructionPermitDailyValidityFeedback(
                {
                  result: '通过',
                  summary: '',
                  expiryDate: reusableExpiryDate,
                  issues: [],
                  suggestions: [],
                },
                input.referenceDate,
                config.label,
              )
            : await this.auditConstructionPermitFiles(
                await this.downloadPermitAttachmentUploadFiles(
                  fieldKey,
                  candidate.group.files,
                ),
                config.label,
                buildConstructionPermitAuditRequirementLines(
                  requirementRecords,
                  config.label,
                  item.workTypes,
                ),
                input.referenceDate,
                {
                  dailyValidityRefresh:
                    requiresValidity && !isApplicationAuditField,
                  requiresValidity: config.requiresValidity,
                  context: {
                    workContent: item.workContent,
                    workTypes: item.workTypes,
                    planStartTime: item.planStartTime,
                    crewMembers: item.crewMembers,
                  },
                },
              );
          if (!feedback) {
            continue;
          }

          const datedFeedback = buildDailyPermitAuditFeedbackWithDate(
            feedback,
            input.referenceDate,
          );
          const updateFields =
            updatesByRecordId.get(candidate.followup.recordId) || {};
          updateFields[config.feedbackField] = datedFeedback;
          for (const fallbackField of config.fallbackFeedbackFields || []) {
            updateFields[fallbackField] = datedFeedback;
          }
          updatesByRecordId.set(candidate.followup.recordId, updateFields);
        }
      }

      await this.refreshTrainingAssessmentAuditFeedbacksForConstruction(
        item,
        updatesByRecordId,
        refreshedKeys,
      );
    }

    if (updatesByRecordId.size === 0) {
      return false;
    }

    for (const [recordId, fields] of updatesByRecordId) {
      await this.updateBitableRecordFields(
        followupAppToken,
        this.constructionFollowupConfig.tableId,
        this.constructionFollowupConfig.tableName,
        recordId,
        fields,
        tenantAccessToken,
        {
          optionalMissingFieldNames:
            CONSTRUCTION_FOLLOWUP_OPTIONAL_MISSING_FIELD_NAMES,
        },
      );
    }

    invalidateBitableRecordCache({
      appToken: followupAppToken,
      tableId: this.constructionFollowupConfig.tableId,
    });
    return true;
  }

  private async refreshTrainingAssessmentAuditFeedbacksForConstruction(
    item: ConstructionOverviewItem,
    updatesByRecordId: Map<string, Record<string, unknown>>,
    refreshedKeys: Set<string>,
  ): Promise<void> {
    const assessmentCandidates = this.findPermitAttachmentCandidates(
      item,
      'entryTrainingAssessmentFiles',
    );
    if (assessmentCandidates.length === 0) {
      return;
    }

    for (const candidate of assessmentCandidates) {
      const existingFeedback = String(candidate.group.feedback || '').trim();
      if (this.hasFreshTrainingAssessmentFeedback(existingFeedback)) {
        continue;
      }
      const refreshKey = `${candidate.followup.recordId}:entryTrainingAssessmentFiles`;
      if (refreshedKeys.has(refreshKey)) {
        continue;
      }
      refreshedKeys.add(refreshKey);

      const signInCandidate =
        this.findTrainingSignInCandidateForFollowup(candidate.followup) ||
        this.findPermitAttachmentCandidates(
          item,
          'entryTrainingSignInFiles',
        )[0] ||
        null;
      const signInFiles = signInCandidate
        ? await this.downloadPermitAttachmentUploadFiles(
            'entryTrainingSignInFiles',
            signInCandidate.group.files,
          )
        : [];
      const localSignInPersonCount =
        inferConstructionTrainingSignInPersonCountFromFiles(signInFiles);
      const signInPersonCount =
        localSignInPersonCount ??
        (await this.auditConstructionTrainingSignInPersonCount(signInFiles));
      const feedback = buildConstructionTrainingAssessmentAuditFeedback({
        signInPersonCount,
        assessmentFileCount: candidate.group.files.length,
      });
      if (!feedback) {
        continue;
      }

      const updateFields =
        updatesByRecordId.get(candidate.followup.recordId) || {};
      updateFields[CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD] =
        feedback;
      updatesByRecordId.set(candidate.followup.recordId, updateFields);
    }
  }

  private findTrainingSignInCandidateForFollowup(
    followup: ConstructionOverviewItem['followups'][number],
  ): {
    followup: ConstructionOverviewItem['followups'][number];
    group: ConstructionOverviewItem['followups'][number]['attachments'][number];
  } | null {
    const signInField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.entryTrainingSignInFiles;
    const group = followup.attachments.find(
      (item) => item.field === signInField && item.files.length > 0,
    );
    return group ? { followup, group } : null;
  }

  private hasFreshTrainingAssessmentFeedback(feedback: string): boolean {
    return /^结论[:：][^；;、\n\r]+[；;、]\s*1[.．]\s*人数[:：][^；;\n\r]+[；;、]\s*2[.．]\s*文件[:：]考核\d+份[；;、]\s*3[.．]\s*匹配[:：]/.test(
      feedback,
    );
  }

  private buildDailyPermitManualReviewAutoApprovalFields(
    item: ConstructionOverviewItem,
    candidate: {
      followup: ConstructionOverviewItem['followups'][number];
      group: ConstructionOverviewItem['followups'][number]['attachments'][number];
    },
    referenceDate: Date,
  ): Record<string, unknown> | null {
    const targetReview = candidate.group.manualReview;
    if (!targetReview || targetReview.reviewed) {
      return null;
    }

    const targetFingerprint = String(
      targetReview.expectedFingerprint || targetReview.fingerprint || '',
    ).trim();
    if (!targetFingerprint) {
      return null;
    }

    const approvedSamePermit = item.followups
      .flatMap((followup) =>
        followup.attachments
          .filter(
            (group) =>
              group.field === candidate.group.field && group.files.length > 0,
          )
          .map((group) => ({ followup, group })),
      )
      .some((source) => {
        if (source.followup.recordId === candidate.followup.recordId) {
          return false;
        }
        const sourceReview = source.group.manualReview;
        if (
          !sourceReview?.reviewed ||
          !this.isDailyPermitFeedbackValidForManualReview(
            source.group.feedback,
            referenceDate,
          )
        ) {
          return false;
        }
        return this.isSameDailyPermitManualReviewBasis(
          source.group,
          candidate.group,
        );
      });

    if (!approvedSamePermit) {
      return null;
    }

    return {
      [targetReview.field]: '通过',
      [targetReview.fingerprintField]: targetFingerprint,
    };
  }

  private isSameDailyPermitManualReviewBasis(
    approvedGroup: ConstructionOverviewItem['followups'][number]['attachments'][number],
    targetGroup: ConstructionOverviewItem['followups'][number]['attachments'][number],
  ): boolean {
    const approvedFingerprint = String(
      approvedGroup.manualReview?.fingerprint ||
        approvedGroup.manualReview?.expectedFingerprint ||
        '',
    ).trim();
    const targetFingerprint = String(
      targetGroup.manualReview?.expectedFingerprint ||
        targetGroup.manualReview?.fingerprint ||
        '',
    ).trim();
    if (approvedFingerprint && targetFingerprint) {
      return approvedFingerprint === targetFingerprint;
    }

    return (
      this.getDailyPermitAttachmentTokenKey(approvedGroup) ===
        this.getDailyPermitAttachmentTokenKey(targetGroup) &&
      extractConstructionPermitFeedbackExpiryDate(approvedGroup.feedback) ===
        extractConstructionPermitFeedbackExpiryDate(targetGroup.feedback)
    );
  }

  private getDailyPermitAttachmentTokenKey(
    group: ConstructionOverviewItem['followups'][number]['attachments'][number],
  ): string {
    return group.files
      .map((file) => String(file.fileToken || '').trim())
      .filter(Boolean)
      .sort()
      .join('|');
  }

  private isDailyPermitFeedbackValidForManualReview(
    feedback: string | null | undefined,
    referenceDate: Date,
  ): boolean {
    const text = String(feedback || '').trim();
    if (
      !text ||
      /(?:审核结果|视觉审核|结论|状态)[:：]\s*(?:不通过|未通过)|有效期已过期|无效/.test(
        text,
      ) ||
      !/(?:审核结果|视觉审核|结论|状态)[:：]\s*通过/.test(text)
    ) {
      return false;
    }

    const expiryDate = extractConstructionPermitFeedbackExpiryDate(text);
    if (!expiryDate) {
      return false;
    }
    const expiryTime = new Date(`${expiryDate}T00:00:00+08:00`).getTime();
    const referenceDateKey = this.formatShanghaiDateKey(referenceDate);
    const referenceTime = new Date(
      `${referenceDateKey}T00:00:00+08:00`,
    ).getTime();
    return (
      Number.isFinite(expiryTime) &&
      Number.isFinite(referenceTime) &&
      expiryTime >= referenceTime
    );
  }

  private canReuseDailyPermitAuditExpiry(
    feedback: string | null | undefined,
  ): boolean {
    const text = String(feedback || '');
    if (!text) {
      return false;
    }
    if (/结论[:：]\s*通过/.test(text) && /问题[:：]\s*无/.test(text)) {
      return true;
    }
    return !/有效期已过期|结论[:：]\s*不通过/.test(text);
  }

  private shouldRefreshDailyPermitAuditsForConstruction(
    item: ConstructionOverviewItem,
  ): boolean {
    if (!item.constructionCode) {
      return false;
    }
    if (item.followups.some((followup) => followup.completed === '是')) {
      return false;
    }

    return Object.keys(CONSTRUCTION_PERMIT_WORK_TYPE_KEYWORDS).some(
      (fieldKey) =>
        this.isPermitRelevantToConstructionWorkTypes(fieldKey, item),
    );
  }

  private isPermitRelevantToConstructionWorkTypes(
    fieldKey: string,
    item: ConstructionOverviewItem,
  ): boolean {
    if (fieldKey.endsWith('RiskDisclosureFiles')) {
      return true;
    }
    const keywords = CONSTRUCTION_PERMIT_WORK_TYPE_KEYWORDS[fieldKey] || [];
    if (keywords.length === 0) {
      return true;
    }
    return item.workTypes.some((workType) =>
      keywords.some((keyword) => workType.includes(keyword)),
    );
  }

  private findLatestPermitAttachmentCandidate(
    item: ConstructionOverviewItem,
    fieldKey: string,
  ): {
    followup: ConstructionOverviewItem['followups'][number];
    group: ConstructionOverviewItem['followups'][number]['attachments'][number];
  } | null {
    return this.findPermitAttachmentCandidates(item, fieldKey)[0] || null;
  }

  private findPermitAttachmentCandidates(
    item: ConstructionOverviewItem,
    fieldKey: string,
  ): Array<{
    followup: ConstructionOverviewItem['followups'][number];
    group: ConstructionOverviewItem['followups'][number]['attachments'][number];
  }> {
    const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fieldKey];
    if (!attachmentField) {
      return [];
    }

    return item.followups
      .flatMap((followup) =>
        followup.attachments
          .filter(
            (group) =>
              group.field === attachmentField && group.files.length > 0,
          )
          .map((group) => ({ followup, group })),
      )
      .sort(
        (left, right) =>
          this.getDateTimeMs(
            right.followup.updatedAt || right.followup.createdAt,
          ) -
          this.getDateTimeMs(
            left.followup.updatedAt || left.followup.createdAt,
          ),
      );
  }

  private async downloadPermitAttachmentUploadFiles(
    fieldKey: string,
    attachments: readonly ConstructionAttachmentFile[],
  ): Promise<ConstructionUploadFile[]> {
    const files: ConstructionUploadFile[] = [];
    for (const attachment of attachments) {
      try {
        const downloaded = await this.downloadConstructionAttachment(
          attachment.fileToken,
          { tmpUrl: attachment.tmpUrl },
        );
        files.push({
          fieldname: fieldKey,
          originalname: attachment.name,
          mimetype:
            attachment.mimeType ||
            downloaded.contentType ||
            'application/octet-stream',
          size: downloaded.buffer.length,
          buffer: downloaded.buffer,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `每日作业票核验附件下载失败（${attachment.name}）: ${message}`,
        );
      }
    }
    return files;
  }

  private async fetchConstructionPermitAuditRequirementRecords(): Promise<
    ConstructionPermitAuditRequirementRecord[]
  > {
    if (
      !this.hasBitableSourceConfig(
        this.constructionPermitAuditRequirementConfig,
      )
    ) {
      return [];
    }

    try {
      const appToken = await resolveBitableAppToken(
        this.httpService,
        this.constructionPermitAuditRequirementConfig,
      );
      return await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: this.constructionPermitAuditRequirementConfig.tableId,
        viewId:
          this.constructionPermitAuditRequirementConfig.viewId || undefined,
        tableName: this.constructionPermitAuditRequirementConfig.tableName,
        cacheTtlMs: 30 * 60 * 1000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`施工表单审核要求读取失败: ${message}`);
      return [];
    }
  }

  private async auditConstructionPermitFiles(
    files: ConstructionUploadFile[],
    permitLabel: string,
    requirementLines: readonly string[] = [],
    referenceDate: Date = new Date(),
    options: {
      dailyValidityRefresh?: boolean;
      requiresValidity?: boolean;
      context?: ConstructionPermitVisionAuditContext;
    } = {},
  ): Promise<string | null> {
    const requiresValidity = options.requiresValidity !== false;
    const fallback = buildConstructionPermitAuditFeedback(
      files,
      permitLabel,
      requirementLines,
      referenceDate,
      { requiresValidity: options.requiresValidity },
    );
    const imageFiles = files.filter(isConstructionImageUploadFile);
    if (!fallback || imageFiles.length === 0) {
      return fallback;
    }

    const config = this.getConstructionImageAuditConfig();
    if (!config) {
      return fallback;
    }
    const status = buildConstructionImageAuditStatus(config);
    if (!status.supportsImageInput) {
      return `${fallback}；${status.message}`;
    }

    try {
      const payload = buildConstructionPermitVisionAuditPayload(
        files,
        config.model,
        permitLabel,
        {
          disableThinking: this.isDeepSeekConstructionImageAuditConfig(config),
          dailyValidityRefresh:
            requiresValidity && options.dailyValidityRefresh,
          referenceDate,
          requirementLines,
          requiresValidity: options.requiresValidity,
          context: options.context,
        },
      );
      const response = await this.postConstructionImageAudit(payload, config);
      const content = this.extractChatCompletionMessageContent(response.data);
      const parsed = parseConstructionPermitVisionAuditResponse(content, {
        requiresValidity: options.requiresValidity,
      });
      return requiresValidity && options.dailyValidityRefresh
        ? formatConstructionPermitDailyValidityFeedback(
            parsed,
            referenceDate,
            permitLabel,
          )
        : formatConstructionPermitVisionAuditFeedback(parsed, permitLabel, {
            requiresValidity: options.requiresValidity,
          });
    } catch (error) {
      const message = this.getConstructionImageAuditErrorSummary(error);
      this.logger.warn(`${permitLabel}视觉审核失败: ${message}`);
      return fallback;
    }
  }

  private mergeConstructionTextFieldValues(
    existingFields: Record<string, unknown>,
    uploadedFields: Record<string, string>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(uploadedFields).map(([fieldName, uploaded]) => [
        fieldName,
        uploaded,
      ]),
    );
  }

  private buildInheritedDailyPermitFields(input: {
    fields: Record<string, unknown>;
    records: BitableRecordItem[];
    targetRecordId?: string | null;
    changedPermitFileKeys: readonly string[];
    referenceDate: Date;
  }): Record<string, unknown> {
    const changedPermitFileKeys = new Set(input.changedPermitFileKeys);
    const sourceRecords = [...input.records]
      .filter((record) => getRecordId(record) !== input.targetRecordId)
      .sort(
        (left, right) =>
          this.getConstructionFollowupRecordSortTime(right) -
          this.getConstructionFollowupRecordSortTime(left),
      );
    const inherited: Record<string, unknown> = {};

    for (const [fileKey, auditConfig] of Object.entries(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
    )) {
      if (changedPermitFileKeys.has(fileKey)) {
        continue;
      }

      const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey];
      const reviewConfig = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[fileKey];
      if (!attachmentField || !reviewConfig) {
        continue;
      }
      if (this.hasConstructionFieldValue(input.fields[attachmentField])) {
        continue;
      }

      const source = sourceRecords
        .map((record) => ({ record, fields: record.fields || {} }))
        .find(({ fields }) => {
          if (!this.hasConstructionFieldValue(fields[attachmentField])) {
            return false;
          }
          const feedback = this.extractConstructionPermitFeedbackText(
            fields,
            fileKey,
          );
          const expiryDate =
            extractConstructionPermitFeedbackExpiryDate(feedback);
          if (
            !this.isConstructionPermitExpiryValidForReference(
              expiryDate,
              input.referenceDate,
            )
          ) {
            return false;
          }

          const reviewValue = pickField(fields, [
            reviewConfig.reviewField,
            ...reviewConfig.reviewAliases,
          ]);
          if (this.hasConstructionFieldValue(reviewValue)) {
            return this.isConstructionPermitManualReviewPassed(reviewValue);
          }
          return this.isDailyPermitFeedbackValidForManualReview(
            feedback,
            input.referenceDate,
          );
        });
      if (!source) {
        continue;
      }

      const sourceFields = source.fields;
      inherited[attachmentField] = sourceFields[attachmentField];
      const feedback = this.extractConstructionPermitFeedbackText(
        sourceFields,
        fileKey,
      );
      if (
        feedback &&
        !this.hasConstructionFieldValue(input.fields[auditConfig.feedbackField])
      ) {
        inherited[auditConfig.feedbackField] = feedback;
      }
      for (const fallbackField of auditConfig.fallbackFeedbackFields || []) {
        if (
          feedback &&
          !this.hasConstructionFieldValue(input.fields[fallbackField])
        ) {
          inherited[fallbackField] = feedback;
        }
      }

      const reviewValue = pickField(sourceFields, [
        reviewConfig.reviewField,
        ...reviewConfig.reviewAliases,
      ]);
      if (
        this.isConstructionPermitManualReviewPassed(reviewValue) &&
        !this.hasConstructionFieldValue(input.fields[reviewConfig.reviewField])
      ) {
        inherited[reviewConfig.reviewField] = '通过';
      }
      const fingerprintValue = pickField(sourceFields, [
        reviewConfig.fingerprintField,
        ...reviewConfig.fingerprintAliases,
      ]);
      const fingerprintText = extractDisplayText(fingerprintValue, '').trim();
      if (
        fingerprintText &&
        !this.hasConstructionFieldValue(
          input.fields[reviewConfig.fingerprintField],
        )
      ) {
        inherited[reviewConfig.fingerprintField] = fingerprintText;
      }
    }

    return inherited;
  }

  private buildDailyPermitManualReviewAutoApprovalFieldsFromRecords(input: {
    fields: Record<string, unknown>;
    records: BitableRecordItem[];
    targetRecordId?: string | null;
    referenceDate: Date;
  }): Record<string, unknown> {
    const sourceRecords = [...input.records]
      .filter((record) => getRecordId(record) !== input.targetRecordId)
      .sort(
        (left, right) =>
          this.getConstructionFollowupRecordSortTime(right) -
          this.getConstructionFollowupRecordSortTime(left),
      );
    if (sourceRecords.length === 0) {
      return {};
    }

    const autoFields: Record<string, unknown> = {};
    for (const fileKey of Object.keys(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
    )) {
      const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey];
      const reviewConfig = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[fileKey];
      if (!attachmentField || !reviewConfig) {
        continue;
      }
      if (!this.hasConstructionFieldValue(input.fields[attachmentField])) {
        continue;
      }
      if (
        this.isConstructionPermitManualReviewPassed(
          input.fields[reviewConfig.reviewField],
        )
      ) {
        continue;
      }

      const targetFingerprint = this.resolveDailyPermitManualReviewFingerprint(
        input.fields,
        fileKey,
      );
      if (!targetFingerprint) {
        continue;
      }

      const approvedSamePermit = sourceRecords.some((record) => {
        const sourceFields = record.fields || {};
        if (!this.hasConstructionFieldValue(sourceFields[attachmentField])) {
          return false;
        }
        const sourceReview = pickField(sourceFields, [
          reviewConfig.reviewField,
          ...reviewConfig.reviewAliases,
        ]);
        if (!this.isConstructionPermitManualReviewPassed(sourceReview)) {
          return false;
        }
        if (
          !this.isDailyPermitFeedbackValidForManualReview(
            this.extractConstructionPermitFeedbackText(sourceFields, fileKey),
            input.referenceDate,
          )
        ) {
          return false;
        }
        const sourceFingerprint =
          this.resolveDailyPermitManualReviewFingerprint(sourceFields, fileKey);
        return sourceFingerprint === targetFingerprint;
      });

      if (approvedSamePermit) {
        autoFields[reviewConfig.reviewField] = '通过';
        autoFields[reviewConfig.fingerprintField] = targetFingerprint;
      }
    }
    return autoFields;
  }

  private resolveDailyPermitManualReviewFingerprint(
    fields: Record<string, unknown>,
    fileKey: string,
  ): string | null {
    const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey];
    const reviewConfig = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[fileKey];
    if (!attachmentField || !reviewConfig) {
      return null;
    }
    const explicitFingerprint = extractDisplayText(
      pickField(fields, [
        reviewConfig.fingerprintField,
        ...reviewConfig.fingerprintAliases,
      ]),
      '',
    ).trim();
    if (explicitFingerprint) {
      return explicitFingerprint;
    }
    return buildConstructionPermitManualReviewFingerprint(
      normalizeConstructionAttachmentFieldValue(fields[attachmentField]),
      extractConstructionPermitFeedbackExpiryDate(
        this.extractConstructionPermitFeedbackText(fields, fileKey),
      ),
    );
  }

  private extractConstructionPermitFeedbackText(
    fields: Record<string, unknown>,
    fileKey: string,
  ): string {
    const auditConfig = CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS[fileKey];
    if (!auditConfig) {
      return '';
    }
    return (
      extractDisplayText(
        pickField(fields, [
          auditConfig.feedbackField,
          ...(auditConfig.fallbackFeedbackFields || []),
        ]),
      ) || ''
    );
  }

  private hasConstructionFieldValue(value: unknown): boolean {
    if (value === null || value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return String(value).trim().length > 0;
  }

  private isConstructionPermitManualReviewPassed(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.some((item) =>
        this.isConstructionPermitManualReviewPassed(item),
      );
    }
    const text = extractDisplayText(value);
    return /^(true|1|yes|y|是|已审核|已人工审核|人员已审|人工已审|通过|已通过|✔️?|✓|☑|√)$/i.test(
      text,
    );
  }

  private isConstructionPermitExpiryValidForReference(
    expiryDate: string | null,
    referenceDate: Date,
  ): boolean {
    if (!expiryDate) {
      return false;
    }
    const expiryTime = new Date(`${expiryDate}T00:00:00+08:00`).getTime();
    const referenceDateKey = this.formatShanghaiDateKey(referenceDate);
    const referenceTime = new Date(
      `${referenceDateKey}T00:00:00+08:00`,
    ).getTime();
    return (
      Number.isFinite(expiryTime) &&
      Number.isFinite(referenceTime) &&
      expiryTime >= referenceTime
    );
  }

  private getConstructionImageAuditConfig(): ConstructionImageAuditConfig | null {
    const externalEnv = this.readConstructionImageAuditExternalEnv();
    const getValue = (name: string, aliases: string[] = []) =>
      readEnv(name, aliases) ||
      externalEnv[name] ||
      aliases.map((alias) => externalEnv[alias]).find(Boolean) ||
      '';
    const apiKey =
      getValue('CONSTRUCTION_IMAGE_AUDIT_API_KEY') ||
      getValue('QWEN_API_KEY', ['DASHSCOPE_API_KEY']);
    if (!apiKey) {
      return null;
    }
    const timeoutMs = Number(
      getValue('CONSTRUCTION_IMAGE_AUDIT_TIMEOUT_MS', [
        'QWEN_VISION_TIMEOUT_MS',
      ]) || '120000',
    );
    const retryAttempts = Number(
      getValue('CONSTRUCTION_IMAGE_AUDIT_RETRY_ATTEMPTS', [
        'QWEN_API_RETRY_ATTEMPTS',
      ]) || DEFAULT_IMAGE_AUDIT_RETRY_ATTEMPTS,
    );
    const retryBaseDelaySeconds = Number(
      getValue('CONSTRUCTION_IMAGE_AUDIT_RETRY_BASE_DELAY_SECONDS', [
        'QWEN_API_RETRY_BASE_DELAY_SECONDS',
      ]) || DEFAULT_IMAGE_AUDIT_RETRY_BASE_DELAY_MS / 1000,
    );

    return {
      apiKey,
      baseUrl:
        getValue('CONSTRUCTION_IMAGE_AUDIT_BASE_URL', ['QWEN_BASE_URL']) ||
        DEFAULT_QWEN_BASE_URL,
      model:
        getValue('CONSTRUCTION_IMAGE_AUDIT_MODEL', ['QWEN_VISION_MODEL']) ||
        DEFAULT_QWEN_VISION_MODEL,
      timeoutMs:
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
      retryAttempts:
        Number.isFinite(retryAttempts) && retryAttempts > 0
          ? Math.min(10, Math.floor(retryAttempts))
          : DEFAULT_IMAGE_AUDIT_RETRY_ATTEMPTS,
      retryBaseDelayMs:
        Number.isFinite(retryBaseDelaySeconds) && retryBaseDelaySeconds >= 0
          ? Math.min(30000, retryBaseDelaySeconds * 1000)
          : DEFAULT_IMAGE_AUDIT_RETRY_BASE_DELAY_MS,
    };
  }

  private isConstructionAiAuditEnabled(): boolean {
    const processValue = process.env.CONSTRUCTION_AI_AUDIT_ENABLED;
    if (processValue !== undefined) {
      return /^(true|1|yes|on)$/i.test(processValue.trim());
    }

    const externalEnv = this.readConstructionImageAuditExternalEnv();
    return /^(true|1|yes|on)$/i.test(
      (externalEnv.CONSTRUCTION_AI_AUDIT_ENABLED || '').trim(),
    );
  }

  private readConstructionImageAuditExternalEnv(): Record<string, string> {
    const configuredPath = readEnv('CONSTRUCTION_IMAGE_AUDIT_ENV_PATH', [
      'CONSTRUCTION_CART_SERVICE_ENV_PATH',
    ]);
    const candidates = [
      configuredPath,
      DEFAULT_CONSTRUCTION_CART_SERVICE_ENV_PATH,
    ].filter((value): value is string => Boolean(value));
    const envPath = candidates.find((candidate) => existsSync(candidate));
    if (!envPath) {
      return {};
    }

    const allowedKeys = new Set([
      'QWEN_API_KEY',
      'DASHSCOPE_API_KEY',
      'QWEN_BASE_URL',
      'QWEN_VISION_MODEL',
      'QWEN_VISION_TIMEOUT_MS',
      'QWEN_API_RETRY_ATTEMPTS',
      'QWEN_API_RETRY_BASE_DELAY_SECONDS',
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'DEEPSEEK_MODEL',
      'DEEPSEEK_TIMEOUT_MS',
      'DEEPSEEK_API_RETRY_ATTEMPTS',
      'DEEPSEEK_API_RETRY_BASE_DELAY_SECONDS',
      'CONSTRUCTION_AI_AUDIT_ENABLED',
      'CONSTRUCTION_IMAGE_AUDIT_API_KEY',
      'CONSTRUCTION_IMAGE_AUDIT_BASE_URL',
      'CONSTRUCTION_IMAGE_AUDIT_MODEL',
      'CONSTRUCTION_IMAGE_AUDIT_TIMEOUT_MS',
      'CONSTRUCTION_IMAGE_AUDIT_RETRY_ATTEMPTS',
      'CONSTRUCTION_IMAGE_AUDIT_RETRY_BASE_DELAY_SECONDS',
    ]);
    let content: string;
    try {
      content = readFileSync(envPath, 'utf8');
    } catch {
      return {};
    }

    const result: Record<string, string> = {};
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) return;
      const key = trimmed.slice(0, separator).trim();
      if (!allowedKeys.has(key)) return;
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (value) result[key] = value;
    });
    return result;
  }

  private async postConstructionImageAudit(
    payload: ReturnType<typeof buildIsolationPhotoVisionAuditPayload>,
    config: ConstructionImageAuditConfig,
  ): Promise<{ data: unknown }> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let lastError: unknown;
    const modelCandidates =
      this.getConstructionImageAuditModelCandidates(config);
    for (
      let modelIndex = 0;
      modelIndex < modelCandidates.length;
      modelIndex += 1
    ) {
      const model = modelCandidates[modelIndex];
      const requestPayload =
        model === payload.model ? payload : { ...payload, model };
      for (let attempt = 1; attempt <= config.retryAttempts; attempt += 1) {
        try {
          return await this.httpService.axiosRef.post(url, requestPayload, {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: config.timeoutMs,
          });
        } catch (error) {
          lastError = error;
          if (
            this.isConstructionImageAuditPermissionError(error) &&
            modelIndex < modelCandidates.length - 1
          ) {
            this.logger.warn(
              `视觉审核模型 ${model} 返回权限错误，切换备用模型 ${modelCandidates[modelIndex + 1]}: ${this.getConstructionImageAuditErrorSummary(error)}`,
            );
            break;
          }
          if (
            attempt >= config.retryAttempts ||
            !this.isRetryableConstructionImageAuditError(error)
          ) {
            throw error;
          }
          const delayMs = config.retryBaseDelayMs * 2 ** (attempt - 1);
          this.logger.warn(
            `挂牌与隔离照片视觉审核请求失败，${delayMs}ms 后重试 (${attempt}/${config.retryAttempts - 1}): ${this.getConstructionImageAuditErrorSummary(error)}`,
          );
          await this.sleep(delayMs);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private getConstructionImageAuditModelCandidates(
    config: ConstructionImageAuditConfig,
  ): string[] {
    const configuredModel = String(config.model || '').trim();
    const candidates = [configuredModel];
    if (this.isQwenConstructionImageAuditConfig(config)) {
      candidates.push('qwen3-vl-plus', 'qwen-vl-plus', 'qwen-vl-max-latest');
    }
    return Array.from(new Set(candidates.filter(Boolean)));
  }

  private isQwenConstructionImageAuditConfig(
    config: ConstructionImageAuditConfig,
  ): boolean {
    const model = String(config.model || '');
    let hostname = '';
    try {
      hostname = new URL(config.baseUrl).hostname;
    } catch {
      hostname = '';
    }
    return (
      /qwen/i.test(model) || /(^|\.)dashscope\.aliyuncs\.com$/i.test(hostname)
    );
  }

  private isConstructionImageAuditPermissionError(error: unknown): boolean {
    const status = (error as { response?: { status?: unknown } })?.response
      ?.status;
    return status === 401 || status === 403;
  }

  private isDeepSeekConstructionImageAuditConfig(
    config: ConstructionImageAuditConfig,
  ): boolean {
    let hostname = '';
    try {
      hostname = new URL(config.baseUrl).hostname;
    } catch {
      hostname = '';
    }
    return (
      /^deepseek-/i.test(config.model) || /(^|\.)deepseek\.com$/i.test(hostname)
    );
  }

  private isRetryableConstructionImageAuditError(error: unknown): boolean {
    return this.isRetryableFeishuRequestError(error);
  }

  private isRetryableFeishuRequestError(error: unknown): boolean {
    const status = (error as { response?: { status?: unknown } })?.response
      ?.status;
    if (typeof status === 'number') {
      return (
        status === 408 ||
        status === 409 ||
        status === 425 ||
        status === 429 ||
        status >= 500
      );
    }
    const code = (error as { code?: unknown })?.code;
    const isCodeRetryable =
      typeof code === 'string' &&
      [
        'ECONNABORTED',
        'ECONNRESET',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ENOTFOUND',
        'ECONNREFUSED',
      ].includes(code);
    if (isCodeRetryable) {
      return true;
    }

    const message = getBitableAxiosErrorMessage(error);
    return /\b(?:ECONNABORTED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)\b|socket hang up|network error|timeout of \d+ms exceeded|connect timed out/i.test(
      message,
    );
  }

  private getConstructionImageAuditErrorSummary(error: unknown): string {
    const status = (error as { response?: { status?: unknown } })?.response
      ?.status;
    const message = error instanceof Error ? error.message : String(error);
    return typeof status === 'number' ? `HTTP ${status}: ${message}` : message;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extractChatCompletionMessageContent(payload: unknown): string {
    const data = payload as {
      choices?: Array<{
        message?: { content?: unknown };
      }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (content !== undefined) {
      return JSON.stringify(content);
    }
    throw new Error('视觉模型未返回识别内容');
  }

  private async fetchConstructionFollowupRecordById(
    appToken: string,
    recordId: string,
    tenantAccessToken: string,
  ): Promise<BitableRecordItem | null> {
    return this.fetchBitableRecordById(
      appToken,
      this.constructionFollowupConfig.tableId,
      this.constructionFollowupConfig.tableName,
      recordId,
      tenantAccessToken,
    );
  }

  private async findTodayConstructionDailyFollowupRecord(
    followupAppToken: string,
    normalized: ReturnType<
      typeof buildConstructionFollowupFields
    >['normalized'],
    onRelatedProjectRecords?: (records: BitableRecordItem[]) => void,
  ): Promise<BitableRecordItem | null> {
    if (normalized.followupMode !== 'daily') {
      return null;
    }

    const todayKey = this.getShanghaiTodayDateKey();
    const constructionCode = buildConstructionCrewLedgerViewName(
      normalized.checklistContext.constructionCode,
    );
    let records: BitableRecordItem[] = [];
    try {
      records = await fetchBitableRecords(this.httpService, {
        appToken: followupAppToken,
        tableId: this.constructionFollowupConfig.tableId,
        tableName: this.constructionFollowupConfig.tableName,
      });
    } catch (error) {
      if (!this.isRetryableFeishuRequestError(error)) {
        throw error;
      }
      this.logger.warn(
        `施工跟进当天记录查重失败，已改为新增跟进记录继续提交: ${getBitableAxiosErrorMessage(error)}`,
      );
      onRelatedProjectRecords?.([]);
      return null;
    }
    const relatedProjectRecords = records.filter((record) =>
      this.isConstructionRelatedRecordByProject(
        record,
        normalized.constructionRecordId,
        constructionCode,
      ),
    );
    onRelatedProjectRecords?.(relatedProjectRecords);
    const matchedRecords = relatedProjectRecords.filter(
      (record) =>
        this.getConstructionFollowupRecordDateKey(record) === todayKey,
    );

    matchedRecords.sort(
      (a, b) =>
        this.getConstructionFollowupRecordSortTime(b) -
        this.getConstructionFollowupRecordSortTime(a),
    );
    return matchedRecords[0] || null;
  }

  private async fetchConstructionRelatedProjectFollowupRecords(
    followupAppToken: string,
    overviewRecordId: string,
    constructionCode?: string | null,
    onRelatedProjectRecords?: (records: BitableRecordItem[]) => void,
  ): Promise<BitableRecordItem[]> {
    const normalizedConstructionCode =
      buildConstructionCrewLedgerViewName(constructionCode);
    let records: BitableRecordItem[] = [];
    try {
      records = await fetchBitableRecords(this.httpService, {
        appToken: followupAppToken,
        tableId: this.constructionFollowupConfig.tableId,
        tableName: this.constructionFollowupConfig.tableName,
      });
    } catch (error) {
      if (!this.isRetryableFeishuRequestError(error)) {
        throw error;
      }
      this.logger.warn(
        `施工跟进项目历史记录读取失败，已跳过历史票据继承继续提交: ${getBitableAxiosErrorMessage(error)}`,
      );
      onRelatedProjectRecords?.([]);
      return [];
    }
    const relatedProjectRecords = records.filter((record) =>
      this.isConstructionRelatedRecordByProject(
        record,
        overviewRecordId,
        normalizedConstructionCode,
      ),
    );
    onRelatedProjectRecords?.(relatedProjectRecords);
    return relatedProjectRecords;
  }

  private isConstructionRelatedRecordByProject(
    record: BitableRecordItem,
    overviewRecordId: string,
    constructionCode?: string | null,
  ): boolean {
    const fields = record.fields || {};
    if (
      this.extractConstructionLinkedRecordIds(fields).includes(overviewRecordId)
    ) {
      return true;
    }

    const recordConstructionCode = this.extractConstructionCodeValue(fields);
    return Boolean(
      constructionCode && recordConstructionCode === constructionCode,
    );
  }

  private getConstructionFollowupRecordDateKey(
    record: BitableRecordItem,
  ): string | null {
    const fields = record.fields || {};
    const rawRecord = record as BitableRecordItem & {
      created_time?: unknown;
      last_modified_time?: unknown;
    };
    const candidates: unknown[] = [
      pickField(fields, [
        '跟进日期',
        '跟进时间',
        '日期',
        '创建时间',
        '创建日期',
      ]),
      rawRecord.created_time,
      rawRecord.last_modified_time,
    ];

    for (const value of candidates) {
      const key = this.getShanghaiDateKey(value);
      if (key) {
        return key;
      }
    }
    return null;
  }

  private getConstructionFollowupRecordSortTime(
    record: BitableRecordItem,
  ): number {
    const fields = record.fields || {};
    const rawRecord = record as BitableRecordItem & {
      created_time?: unknown;
      last_modified_time?: unknown;
    };
    const candidates: unknown[] = [
      rawRecord.last_modified_time,
      rawRecord.created_time,
      pickField(fields, ['最后更新时间', '创建时间', '创建日期']),
    ];

    for (const value of candidates) {
      const time = this.getDateTimeMs(value);
      if (Number.isFinite(time)) {
        return time;
      }
    }
    return 0;
  }

  private getShanghaiTodayDateKey(): string {
    return this.formatShanghaiDateKey(new Date());
  }

  private getShanghaiDateKey(value: unknown): string | null {
    const time = this.getDateTimeMs(value);
    if (!Number.isFinite(time)) {
      return null;
    }
    return this.formatShanghaiDateKey(new Date(time));
  }

  private getDateTimeMs(value: unknown): number {
    const iso = extractDateTimeIso(value);
    if (iso) {
      const time = new Date(iso).getTime();
      return Number.isFinite(time) ? time : Number.NaN;
    }

    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? time : Number.NaN;
    }

    if (typeof value === 'number') {
      const time = value < 100000000000 ? value * 1000 : value;
      return Number.isFinite(time) ? time : Number.NaN;
    }

    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) {
        return Number.NaN;
      }
      if (/^\d+$/.test(text)) {
        const numeric = Number(text);
        const time = numeric < 100000000000 ? numeric * 1000 : numeric;
        return Number.isFinite(time) ? time : Number.NaN;
      }
      const time = new Date(text).getTime();
      return Number.isFinite(time) ? time : Number.NaN;
    }

    return Number.NaN;
  }

  private formatShanghaiDateKey(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private async fetchBitableRecordById(
    appToken: string,
    tableId: string,
    tableName: string,
    recordId: string,
    tenantAccessToken: string,
    deadlineAt?: number,
  ): Promise<BitableRecordItem | null> {
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;
    const response = await this.waitWithinChangeRequestDeadline(
      this.httpService.axiosRef
        .get(apiUrl, {
          headers: { Authorization: `Bearer ${tenantAccessToken}` },
          params: { automatic_fields: true },
          timeout: this.getChangeRequestBoundedAxiosTimeout(
            deadlineAt,
            `${tableName}记录读取`,
          ),
        })
        .catch((error: unknown) => {
          throw new Error(
            `${tableName}记录读取失败: ${getBitableAxiosErrorMessage(error)}`,
          );
        }),
      deadlineAt,
      `${tableName}记录读取`,
    );

    if (response.data.code !== 0) {
      throw new Error(
        `${tableName}记录读取失败: ${getBitableApiErrorMessage(response.data)}`,
      );
    }
    return response.data.data?.record || null;
  }

  private async fetchBitableRecordByIdWithDisplayValues(
    appToken: string,
    tableId: string,
    tableName: string,
    recordId: string,
    tenantAccessToken: string,
    deadlineAt?: number,
  ): Promise<BitableRecordItem | null> {
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_get`;
    const response = await this.waitWithinChangeRequestDeadline(
      this.httpService.axiosRef
        .post(
          apiUrl,
          {
            record_ids: [recordId],
            automatic_fields: true,
          },
          {
            headers: { Authorization: `Bearer ${tenantAccessToken}` },
            timeout: this.getChangeRequestBoundedAxiosTimeout(
              deadlineAt,
              `${tableName}记录精确读取`,
            ),
          },
        )
        .catch((error: unknown) => {
          throw new Error(
            `${tableName}记录精确读取失败: ${getBitableAxiosErrorMessage(error)}`,
          );
        }),
      deadlineAt,
      `${tableName}记录精确读取`,
    );

    if (response.data.code !== 0) {
      throw new Error(
        `${tableName}记录精确读取失败: ${getBitableApiErrorMessage(response.data)}`,
      );
    }
    const data = response.data.data || {};
    const records: BitableRecordItem[] = Array.isArray(data.records)
      ? data.records
      : [];
    const exact = records.find((record) => getRecordId(record) === recordId);
    if (exact) return exact;
    if (
      Array.isArray(data.forbidden_record_ids) &&
      data.forbidden_record_ids.includes(recordId)
    ) {
      throw new Error(`${tableName}记录精确读取失败: 当前身份无权读取目标记录`);
    }
    if (
      Array.isArray(data.absent_record_ids) &&
      data.absent_record_ids.includes(recordId)
    ) {
      return null;
    }
    if (records.length > 0) {
      throw new Error(`${tableName}记录精确读取失败: 返回记录标识不一致`);
    }
    return null;
  }

  private getExistingConstructionAttachmentFieldKeys(
    fields: Record<string, unknown>,
  ): string[] {
    return Object.entries(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS)
      .filter(([, fieldName]) => {
        const value = fields[fieldName];
        return Array.isArray(value) ? value.length > 0 : Boolean(value);
      })
      .map(([key]) => key);
  }

  private groupConstructionFilesByField(
    files: ConstructionUploadFile[],
    fieldMap: Record<string, string>,
  ): Record<string, ConstructionUploadFile[]> {
    const grouped: Record<string, ConstructionUploadFile[]> = {};
    files.forEach((file) => {
      const fieldName = fieldMap[file.fieldname];
      if (!fieldName) {
        return;
      }
      grouped[fieldName] = grouped[fieldName] || [];
      grouped[fieldName].push(file);
    });
    return grouped;
  }

  private normalizeConstructionUploadFiles(
    files: ConstructionUploadFile[],
  ): ConstructionUploadFile[] {
    return files.map((file) => {
      const originalname =
        normalizeConstructionUploadFileName(file.originalname) ||
        file.originalname;
      return originalname === file.originalname
        ? file
        : { ...file, originalname };
    });
  }

  private async runConstructionAttachmentUploadWithRetry<T>(
    operation: () => Promise<T>,
    fileName: string,
    contextLabel = '施工附件',
    deadlineAt?: number,
    maxAttempts = CONSTRUCTION_ATTACHMENT_UPLOAD_MAX_ATTEMPTS,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.assertChangeRequestDeadline(deadlineAt, `上传附件 ${fileName}`);
      try {
        return await this.waitWithinChangeRequestDeadline(
          operation(),
          deadlineAt,
          `上传附件 ${fileName}`,
        );
      } catch (error) {
        if (error instanceof ChangeRequestDeadlineExceededError) {
          throw error;
        }
        if (
          attempt >= maxAttempts ||
          !this.isRetryableConstructionAttachmentUploadError(error)
        ) {
          throw error;
        }

        const delayMs =
          CONSTRUCTION_ATTACHMENT_UPLOAD_RETRY_BASE_DELAY_MS *
            2 ** (attempt - 1) +
          Math.floor(Math.random() * 250);
        this.logger.warn(
          `${contextLabel}上传飞书请求失败，${delayMs}ms 后重试 (${attempt}/${maxAttempts - 1})：${fileName}，${getBitableAxiosErrorMessage(error)}`,
        );
        await this.sleepWithinChangeRequestDeadline(
          delayMs,
          deadlineAt,
          `等待重试附件 ${fileName}`,
        );
      }
    }

    throw new Error(`${contextLabel}上传失败：${fileName}`);
  }

  private isRetryableConstructionAttachmentUploadError(
    error: unknown,
  ): boolean {
    return (
      error instanceof ChangeRequestDeadlineExceededError ||
      this.isConstructionAttachmentUploadRateLimitError(error) ||
      this.isRetryableFeishuRequestError(error)
    );
  }

  private isConstructionAttachmentUploadRateLimitError(
    error: unknown,
  ): boolean {
    const message = getBitableAxiosErrorMessage(error);
    return /1061006|1061045|99991400|frequency limit|trigger frequency|rate limit|can retry/i.test(
      message,
    );
  }

  private async runBitableAttachmentUploadSerially<T>(
    appToken: string,
    operation: () => Promise<T>,
    deadlineAt?: number,
  ): Promise<T> {
    const previous =
      this.bitableAttachmentUploadTails.get(appToken) || Promise.resolve();
    let release = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.bitableAttachmentUploadTails.set(appToken, tail);

    try {
      await this.waitWithinChangeRequestDeadline(
        previous.catch(() => undefined),
        deadlineAt,
        '等待附件上传队列',
      );
      const elapsed =
        Date.now() -
        (this.bitableAttachmentUploadLastStartedAt.get(appToken) || 0);
      if (elapsed < BITABLE_ATTACHMENT_UPLOAD_MIN_INTERVAL_MS) {
        await this.sleepWithinChangeRequestDeadline(
          BITABLE_ATTACHMENT_UPLOAD_MIN_INTERVAL_MS - elapsed,
          deadlineAt,
          '等待附件上传限流',
        );
      }
      this.assertChangeRequestDeadline(deadlineAt, '开始附件上传');
      this.bitableAttachmentUploadLastStartedAt.set(appToken, Date.now());
      return await this.waitWithinChangeRequestDeadline(
        operation(),
        deadlineAt,
        '上传附件',
      );
    } finally {
      release();
      void tail.then(() => {
        if (this.bitableAttachmentUploadTails.get(appToken) === tail) {
          this.bitableAttachmentUploadTails.delete(appToken);
        }
      });
    }
  }

  private async uploadConstructionAttachment(
    tenantAccessToken: string,
    appToken: string,
    file: ConstructionUploadFile,
  ): Promise<string> {
    return this.uploadBitableAttachment(
      tenantAccessToken,
      appToken,
      file,
      '施工附件',
    );
  }

  private async uploadBitableAttachment(
    tenantAccessToken: string,
    appToken: string,
    file: ConstructionUploadFile,
    contextLabel: string,
    deadlineAt?: number,
    options: {
      maxAttempts?: number;
      requestTimeoutMs?: number;
    } = {},
  ): Promise<string> {
    const fileName =
      normalizeConstructionUploadFileName(file.originalname) ||
      'bitable-attachment';
    if (!file.buffer || file.size <= 0) {
      throw new Error(
        `${contextLabel}为空：${file.originalname || file.fieldname}`,
      );
    }

    const response = await this.runConstructionAttachmentUploadWithRetry(
      async () => {
        const form = new FormData();
        form.append('file_name', fileName);
        form.append('parent_type', 'bitable_file');
        form.append('parent_node', appToken);
        form.append('size', String(file.size));
        form.append('extra', JSON.stringify({ drive_route_token: appToken }));
        form.append('file', file.buffer, {
          filename: fileName,
          contentType: file.mimetype || 'application/octet-stream',
        });
        const contentLength = form.getLengthSync();

        const uploadResponse = await this.runBitableAttachmentUploadSerially(
          appToken,
          () =>
            this.httpService.axiosRef
              .post(
                'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
                form,
                {
                  headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    ...form.getHeaders(),
                    'Content-Length': contentLength,
                  },
                  maxBodyLength: Infinity,
                  timeout: this.getChangeRequestBoundedAxiosTimeout(
                    deadlineAt,
                    `上传附件 ${fileName}`,
                    options.requestTimeoutMs,
                  ),
                },
              )
              .catch((error: unknown) => {
                throw this.createBitableAttachmentUploadError(
                  contextLabel,
                  error,
                );
              }),
          deadlineAt,
        );

        if (uploadResponse.data?.code !== 0) {
          throw Object.assign(
            new Error(
              `${contextLabel}上传失败：${
                uploadResponse.data?.msg || uploadResponse.data?.code
              } (${uploadResponse.data?.code ?? 'unknown'})`,
            ),
            {
              code: uploadResponse.data?.code,
              response: uploadResponse,
            },
          );
        }

        return uploadResponse;
      },
      fileName,
      contextLabel,
      deadlineAt,
      options.maxAttempts,
    );

    const fileToken =
      response.data?.data?.file_token || response.data?.data?.media_token;
    if (!fileToken) {
      throw new Error(`${contextLabel}上传失败：响应中缺少 file_token`);
    }
    return fileToken;
  }

  private createBitableAttachmentUploadError(
    contextLabel: string,
    error: unknown,
  ): Error {
    const source =
      typeof error === 'object' && error !== null
        ? (error as {
            code?: unknown;
            response?: unknown;
            status?: unknown;
            statusCode?: unknown;
          })
        : null;
    return Object.assign(
      new Error(
        `${contextLabel}上传失败：${getBitableAxiosErrorMessage(error)}`,
        { cause: error },
      ),
      {
        code: source?.code,
        response: source?.response,
        status: source?.status,
        statusCode: source?.statusCode,
      },
    );
  }

  private async updateBitableRecordFields(
    appToken: string,
    tableId: string,
    tableName: string,
    recordId: string,
    fields: Record<string, unknown>,
    tenantAccessToken: string,
    options: { optionalMissingFieldNames?: readonly string[] } = {},
  ): Promise<void> {
    const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;
    let payload = fields;
    const maxAttempts = (options.optionalMissingFieldNames?.length || 0) + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (Object.keys(payload).length === 0) {
        return;
      }

      const response = await this.runBitableRecordWriteWithRetry(
        () =>
          this.httpService.axiosRef.put(
            apiUrl,
            { fields: payload },
            {
              headers: { Authorization: `Bearer ${tenantAccessToken}` },
              timeout: 30000,
            },
          ),
        `${tableName}记录更新`,
      ).catch((error: unknown) => {
        const nextPayload = this.getBitablePayloadAfterMissingOptionalField(
          tableName,
          payload,
          this.getBitableErrorResponseData(error) || {
            msg: getBitableAxiosErrorMessage(error),
          },
          options.optionalMissingFieldNames,
        );
        if (nextPayload) {
          payload = nextPayload;
          return null;
        }
        throw new Error(
          `${tableName}记录更新失败: ${getBitableAxiosErrorMessage(error)}`,
        );
      });

      if (!response) {
        continue;
      }

      if (response.data.code === 0) {
        return;
      }

      const nextPayload = this.getBitablePayloadAfterMissingOptionalField(
        tableName,
        payload,
        response.data,
        options.optionalMissingFieldNames,
      );
      if (nextPayload) {
        payload = nextPayload;
        continue;
      }

      let lastError = getBitableApiErrorMessage(response.data);

      if (shouldRetryBitableUpdateWithFieldNames(response.data, payload)) {
        const fieldMetas = await this.fetchBitableFieldMetas(
          appToken,
          tableId,
          tableName,
          tenantAccessToken,
        );
        const fieldNamePayload = toBitableFieldNamePayload(payload, fieldMetas);

        if (!isSameFieldPayload(payload, fieldNamePayload)) {
          const retryResponse = await this.runBitableRecordWriteWithRetry(
            () =>
              this.httpService.axiosRef.put(
                apiUrl,
                { fields: fieldNamePayload },
                {
                  headers: { Authorization: `Bearer ${tenantAccessToken}` },
                  timeout: 30000,
                },
              ),
            `${tableName}记录字段名更新`,
          );

          if (retryResponse.data.code === 0) {
            return;
          }

          const nextFieldNamePayload =
            this.getBitablePayloadAfterMissingOptionalField(
              tableName,
              fieldNamePayload,
              retryResponse.data,
              options.optionalMissingFieldNames,
            );
          if (nextFieldNamePayload) {
            payload = nextFieldNamePayload;
            continue;
          }

          lastError = getBitableApiErrorMessage(retryResponse.data);
        }
      }

      throw new Error(`${tableName}记录更新失败: ${lastError}`);
    }

    throw new Error(`${tableName}记录更新失败: 可选缺失字段重试次数已用尽`);
  }

  private getBitablePayloadAfterMissingOptionalField(
    tableName: string,
    fields: Record<string, unknown>,
    responseData: Record<string, unknown>,
    optionalFieldNames: readonly string[] = [],
  ): Record<string, unknown> | null {
    const missingFieldName = getMissingBitableFieldName(responseData);
    const nextFields = dropMissingOptionalBitableField(
      fields,
      missingFieldName,
      optionalFieldNames,
    );
    if (!nextFields) {
      return null;
    }
    this.logger.warn(
      `${tableName}字段不存在，已跳过可选字段：${missingFieldName}`,
    );
    return nextFields;
  }

  private getBitableErrorResponseData(
    error: unknown,
  ): Record<string, unknown> | null {
    const data = (
      error as {
        response?: {
          data?: unknown;
        };
      }
    )?.response?.data;
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  }

  private async notifyConstructionCrewRosterUploadSuccess(
    message: string,
  ): Promise<void> {
    const text = message.trim();
    if (!text || !this.constructionCrewRosterNotificationChatId) {
      return;
    }

    try {
      await this.sendFeishuTextMessage(
        await this.getFeishuTenantAccessToken(),
        this.constructionCrewRosterNotificationChatId,
        text,
      );
    } catch (error) {
      this.logger.warn(
        `施工人员名单更新结果群通知失败: ${getBitableAxiosErrorMessage(error)}`,
      );
    }
  }

  private async sendFeishuTextMessage(
    tenantAccessToken: string,
    receiveId: string,
    text: string,
    receiveIdType: FeishuMessageReceiveIdType = 'chat_id',
  ): Promise<void> {
    const response = await this.httpService.axiosRef.post(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        timeout: 30000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(
        `发送飞书群消息失败: ${response.data?.msg || response.data?.code}`,
      );
    }
  }

  private buildLeaveSubstituteRepairNotification(options: {
    source: string;
    scanStartDate: string;
    scanEndDate: string;
    updated: number;
    failed: number;
    manualReview: number;
    results: LeaveSubstituteRepairRunResult['results'];
    failures: LeaveSubstituteRepairRunResult['failures'];
    manualReviews: LeaveSubstituteManualReviewItem[];
  }): string {
    const lines = [
      '南通排班请休假替班自动修正',
      `来源：${options.source}`,
      `范围：${options.scanStartDate} ~ ${options.scanEndDate}`,
      `结果：修正 ${options.updated} 条，失败 ${options.failed} 条，待人工 ${options.manualReview} 条`,
    ];

    options.results.slice(0, 10).forEach((item) => {
      lines.push(
        `- ${item.date} ${item.building} ${item.team} ${item.shift}：${item.leaveName} 替班 ${item.currentSubstitute || '空'} -> ${item.suggestedSubstitute}`,
      );
    });
    options.failures.slice(0, 5).forEach((item) => {
      lines.push(`- 写入失败 ${item.date} ${item.leaveName}：${item.error}`);
    });
    options.manualReviews.slice(0, 5).forEach((item) => {
      lines.push(
        `- 待人工 ${item.date} ${item.building} ${item.team} ${item.shift} ${item.leaveName || '未知人员'}：${item.reason}`,
      );
    });

    return lines.join('\n');
  }

  private parseLeaveSubstituteReferenceDate(value?: string | Date): Date {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
        ? new Date(`${text}T12:00:00+08:00`)
        : new Date(text);
      if (Number.isFinite(date.getTime())) {
        return date;
      }
    }
    return new Date();
  }

  private async syncLocalDutyStaffActual(
    recordId: string,
    value: string,
  ): Promise<void> {
    if (isDatabaseDisabled()) {
      return;
    }

    try {
      await this.db
        .update(appRoomScheduleEnhanced)
        .set({ dutyStaffActual: this.splitDutyPersonText(value) })
        .where(eq(appRoomScheduleEnhanced.recordId, recordId));
    } catch (error) {
      this.logger.warn(
        `飞书记录 ${recordId} 已修正，但本地 dutyStaffActual 同步失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private getDutyStaffActualRepairReason(
    currentValue: string,
    personText: string,
  ): string | null {
    if (!currentValue) {
      return null;
    }

    const aiExplanationPatterns: Array<[RegExp, string]> = [
      [/<\|[^|]+?\|>/, '包含字段占位符'],
      [/由于|因此|最终输出|按照规则|任务要求/, '包含AI解释句式'],
      [
        /无法确定|未提供具体内容|无人员信息|字段为空|保持不变/,
        '包含异常说明文本',
      ],
      [
        /以上字不要填充|请假人员（请假表）|人员（文本）/,
        '包含规则说明或字段名',
      ],
      [/（注[:：]|注[:：]/, '包含备注说明'],
    ];

    for (const [pattern, reason] of aiExplanationPatterns) {
      if (pattern.test(currentValue)) {
        return reason;
      }
    }

    if (currentValue.length > 40 && /[。；;：“”"（）()]/.test(currentValue)) {
      return '内容过长且包含说明性标点';
    }

    if (
      personText &&
      currentValue !== personText &&
      !this.isLikelyDutyPersonList(currentValue)
    ) {
      return '当前值不像人员姓名';
    }

    return null;
  }

  private normalizeDutyStaffRepairValue(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
  }

  private normalizePersonnelMovementType(
    value: unknown,
  ): PersonnelMovementType {
    if (value === '差旅' || value === '异动' || value === '离职') {
      return value;
    }
    throw new Error('请选择有效的异动类型');
  }

  private normalizePersonnelMovementDate(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('请选择有效的异动时间');
    }
    return value;
  }

  private extractPersonnelMovementRecordNames(
    fields: Record<string, unknown>,
  ): string[] {
    const preferredText = extractDisplayText(
      pickField(fields, [
        '姓名',
        '员工姓名',
        '人员',
        '人员（文本）',
        '姓名（文本）',
      ]),
      ' ',
    );
    const fallbackText = Object.values(fields)
      .map((value) => extractDisplayText(value, ' '))
      .filter(Boolean)
      .join(' ');
    return Array.from(
      new Set(this.splitDutyPersonText(`${preferredText} ${fallbackText}`)),
    );
  }

  private async updatePersonnelMovementStatusIfNeeded(
    staffName: string,
    movementType: PersonnelMovementType,
    tenantAccessToken: string,
  ): Promise<{ updated: boolean; recordId?: string }> {
    if (movementType !== '离职') {
      return { updated: false };
    }

    const appToken = await resolveBitableAppToken(
      this.httpService,
      this.personnelMovementConfig,
    );
    assertBitableTableConfig(
      this.personnelMovementConfig.tableName,
      appToken,
      this.personnelMovementConfig.tableId,
    );
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: this.personnelMovementConfig.tableId,
      viewId: this.personnelMovementConfig.viewId || undefined,
      tableName: this.personnelMovementConfig.tableName,
      forceRefresh: true,
    });
    const compareName = this.normalizeDutyPersonNameForCompare(staffName);
    const record = records.find((item) =>
      this.extractPersonnelMovementRecordNames(item.fields || {}).some(
        (name) => this.normalizeDutyPersonNameForCompare(name) === compareName,
      ),
    );
    const recordId = record ? getRecordId(record) : '';
    if (!record || !recordId) {
      throw new Error(`在职人员表中未找到“${staffName}”`);
    }

    const fieldMetas = await this.fetchBitableFieldMetas(
      appToken,
      this.personnelMovementConfig.tableId,
      this.personnelMovementConfig.tableName,
      tenantAccessToken,
    );
    const statusField = this.findBitableField(fieldMetas, [
      '离职/异动情况',
      '离职异动情况',
      '离职/异动',
      '人员异动情况',
    ]);
    if (!statusField) {
      throw new Error('在职人员表未找到“离职/异动情况”字段');
    }

    await this.updateBitableRecordFields(
      appToken,
      this.personnelMovementConfig.tableId,
      this.personnelMovementConfig.tableName,
      recordId,
      { [statusField.field_name || statusField.field_id]: true },
      tenantAccessToken,
    );
    invalidateBitableRecordCache({
      appToken,
      tableId: this.personnelMovementConfig.tableId,
    });

    return { updated: true, recordId };
  }

  private appendDutyPersonName(value: string, name: string): string {
    const normalizedName = this.normalizeDutyStaffRepairValue(name);
    const normalizedValue = this.normalizeDutyStaffRepairValue(value);
    if (!normalizedName) {
      return normalizedValue;
    }
    if (!normalizedValue) {
      return normalizedName;
    }

    const existingNames = this.splitDutyPersonText(normalizedValue);
    if (existingNames.includes(normalizedName)) {
      return normalizedValue;
    }

    const separator = /[、，,;；/]/.test(normalizedValue) ? '、' : ' ';
    return this.normalizeDutyStaffRepairValue(
      `${normalizedValue}${separator}${normalizedName}`,
    );
  }

  private removeDutyPersonName(value: string, name: string): string {
    const normalizedValue = this.normalizeDutyStaffRepairValue(value);
    const normalizedName = this.normalizeDutyStaffRepairValue(name);
    const compareName = this.normalizeDutyPersonNameForCompare(normalizedName);
    if (!normalizedValue || !compareName) {
      return normalizedValue;
    }

    const nextNames = this.splitDutyPersonText(normalizedValue).filter(
      (item) => this.normalizeDutyPersonNameForCompare(item) !== compareName,
    );
    return this.normalizeDutyStaffRepairValue(nextNames.join(' '));
  }

  private hasDutyPersonName(value: string, name: string): boolean {
    const compareName = this.normalizeDutyPersonNameForCompare(name);
    if (!compareName) {
      return false;
    }

    return this.splitDutyPersonText(value).some(
      (item) => this.normalizeDutyPersonNameForCompare(item) === compareName,
    );
  }

  private getScheduleTextField(
    fields: Record<string, unknown>,
    field: BitableFieldMeta,
  ): string {
    return this.normalizeDutyStaffRepairValue(
      extractDisplayText(
        pickField(fields, [field.field_id, field.field_name]),
        ' ',
      ),
    );
  }

  private getSchedulePersonNamesFromCandidates(
    fields: Record<string, unknown>,
    candidates: string[],
  ): string[] {
    return extractDisplayValues(pickField(fields, candidates)).flatMap(
      (value) => this.splitDutyPersonText(value),
    );
  }

  private computeProgramModifiedDutyStaffText({
    baseStaff,
    leaveStaff,
    substituteStaff,
    vacancySubstituteStaff,
    travelStaff,
  }: {
    baseStaff: string[];
    leaveStaff: string[];
    substituteStaff: string[];
    vacancySubstituteStaff: string[];
    travelStaff: string[];
  }): string {
    const leaveNames = leaveStaff
      .map((name) => this.normalizeDutyPersonNameForCompare(name))
      .filter(Boolean);
    const substituteNames: string[] = [];
    substituteStaff.forEach((name) => {
      const normalized = this.normalizeDutyStaffRepairValue(name);
      if (
        normalized &&
        !substituteNames.some(
          (item) =>
            this.normalizeDutyPersonNameForCompare(item) ===
            this.normalizeDutyPersonNameForCompare(normalized),
        )
      ) {
        substituteNames.push(normalized);
      }
    });

    let substituteIndex = 0;
    let nextText = '';
    baseStaff.forEach((name) => {
      const normalized = this.normalizeDutyStaffRepairValue(name);
      if (!normalized) {
        return;
      }
      const isLeaveStaff = leaveNames.includes(
        this.normalizeDutyPersonNameForCompare(normalized),
      );
      if (isLeaveStaff) {
        const replacement = substituteNames[substituteIndex++];
        if (replacement) {
          nextText = this.appendDutyPersonName(nextText, replacement);
        }
        return;
      }
      nextText = this.appendDutyPersonName(nextText, normalized);
    });

    vacancySubstituteStaff.forEach((name) => {
      nextText = this.appendDutyPersonName(nextText, name);
    });
    travelStaff.forEach((name) => {
      nextText = this.removeDutyPersonName(nextText, name);
    });

    return this.normalizeDutyStaffRepairValue(nextText);
  }

  private extractScheduleDateFromFields(
    fields: Record<string, unknown>,
  ): string | null {
    return extractDateValue(
      pickField(fields, [
        'fldZSaDbGf',
        '排班日期',
        '日期',
        'schedule_date',
        '排班日期（日期）',
      ]),
    );
  }

  private buildPersonnelMovementMutationTarget(
    record: BitableRecordItem,
    fieldConfig: PersonnelMovementFieldConfig,
    staffName: string,
  ): PersonnelMovementMutationTarget | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const scheduleDate = this.extractScheduleDateFromFields(fields);
    if (!recordId || !scheduleDate) {
      return null;
    }

    const currentProgramText = this.getScheduleTextField(
      fields,
      fieldConfig.programModified,
    );
    const currentActualText = this.getScheduleTextField(
      fields,
      fieldConfig.dutyStaffActual,
    );
    const currentText = currentProgramText || currentActualText;
    if (!this.hasDutyPersonName(currentText, staffName)) {
      return null;
    }

    return {
      recordId,
      scheduleDate,
      staffName,
      currentText,
      nextText: this.removeDutyPersonName(currentText, staffName),
    };
  }

  private async applyPersonnelMovementMutationTargets(
    targets: PersonnelMovementMutationTarget[],
    fieldConfig: PersonnelMovementFieldConfig,
    tenantAccessToken: string,
  ): Promise<{
    updated: number;
    skipped: number;
    failed: number;
    results: PersonnelMovementCreateResponse['results'];
    failures: PersonnelMovementCreateResponse['failures'];
  }> {
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const results: PersonnelMovementCreateResponse['results'] = [];
    const failures: PersonnelMovementCreateResponse['failures'] = [];
    const queue = [...targets];
    const workerCount = Math.min(4, Math.max(queue.length, 1));
    const runWorker = async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) {
          continue;
        }

        try {
          if (target.nextText === target.currentText) {
            skipped++;
            results.push({
              recordId: target.recordId,
              scheduleDate: target.scheduleDate,
              staffName: target.staffName,
              previousValue: target.currentText,
              nextValue: target.nextText,
            });
            continue;
          }

          await this.updateScheduleTextFields(
            target.recordId,
            [{ field: fieldConfig.programModified, value: target.nextText }],
            tenantAccessToken,
          );
          await this.syncLocalDutyStaffActual(target.recordId, target.nextText);
          updated++;
          results.push({
            recordId: target.recordId,
            scheduleDate: target.scheduleDate,
            staffName: target.staffName,
            previousValue: target.currentText,
            nextValue: target.nextText,
          });
        } catch (error) {
          failed++;
          failures.push({
            recordId: target.recordId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    if (updated > 0) {
      invalidateBitableRecordCache({
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
      });
    }

    results.sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate));
    return { updated, skipped, failed, results, failures };
  }

  private buildTravelStaffMutationTarget(
    record: BitableRecordItem,
    fieldConfig: TravelStaffFieldConfig,
    staffName: string,
    action: 'add' | 'revoke',
  ): TravelStaffMutationTarget | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const scheduleDate = this.extractScheduleDateFromFields(fields);
    if (!recordId || !scheduleDate) {
      return null;
    }

    const currentActualText = this.getScheduleTextField(
      fields,
      fieldConfig.dutyStaffActual,
    );
    const currentTravelText = this.getScheduleTextField(
      fields,
      fieldConfig.travelStaff,
    );
    const shouldProcess =
      action === 'add'
        ? this.hasDutyPersonName(currentActualText, staffName)
        : this.hasDutyPersonName(currentTravelText, staffName);
    if (!shouldProcess) {
      return null;
    }

    return {
      recordId,
      scheduleDate,
      staffName,
      currentActualText,
      currentTravelText,
      nextActualText:
        action === 'add'
          ? this.removeDutyPersonName(currentActualText, staffName)
          : this.appendDutyPersonName(currentActualText, staffName),
      nextTravelText:
        action === 'add'
          ? this.appendDutyPersonName(currentTravelText, staffName)
          : this.removeDutyPersonName(currentTravelText, staffName),
    };
  }

  private async applyTravelStaffMutationTargets(
    targets: TravelStaffMutationTarget[],
    fieldConfig: TravelStaffFieldConfig,
    tenantAccessToken: string,
  ): Promise<{
    updated: number;
    skipped: number;
    failed: number;
    results: TravelStaffUpdateResponse['results'];
    failures: TravelStaffUpdateResponse['failures'];
  }> {
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const results: TravelStaffUpdateResponse['results'] = [];
    const failures: TravelStaffUpdateResponse['failures'] = [];
    const queue = [...targets];
    const workerCount = Math.min(4, Math.max(queue.length, 1));
    const runWorker = async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) {
          continue;
        }

        try {
          if (
            target.nextActualText === target.currentActualText &&
            target.nextTravelText === target.currentTravelText
          ) {
            skipped++;
            results.push({
              recordId: target.recordId,
              scheduleDate: target.scheduleDate,
              staffName: target.staffName,
              dutyStaffActual: this.splitDutyPersonText(target.nextActualText),
              dutyStaffActualText: target.nextActualText,
              travelStaff: target.nextTravelText,
            });
            continue;
          }

          await this.updateScheduleTextFields(
            target.recordId,
            [
              { field: fieldConfig.travelStaff, value: target.nextTravelText },
              {
                field: fieldConfig.dutyStaffActual,
                value: target.nextActualText,
              },
            ],
            tenantAccessToken,
          );
          await this.syncLocalDutyStaffActual(
            target.recordId,
            target.nextActualText,
          );
          updated++;
          results.push({
            recordId: target.recordId,
            scheduleDate: target.scheduleDate,
            staffName: target.staffName,
            dutyStaffActual: this.splitDutyPersonText(target.nextActualText),
            dutyStaffActualText: target.nextActualText,
            travelStaff: target.nextTravelText,
          });
        } catch (error) {
          failed++;
          failures.push({
            recordId: target.recordId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    if (updated > 0) {
      invalidateBitableRecordCache({
        appToken: this.scheduleAppToken,
        tableId: this.scheduleTableId,
      });
    }

    results.sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate));
    return { updated, skipped, failed, results, failures };
  }

  private buildTravelScheduleRecord(
    record: BitableRecordItem,
    fieldConfig: TravelStaffFieldConfig,
  ): TravelStaffScheduleRecord | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const scheduleDate = this.extractScheduleDateFromFields(fields);
    if (!recordId || !scheduleDate) {
      return null;
    }

    const buildingRaw = pickField(fields, [
      'fldnP4gXMn',
      'fldUHstSKX',
      '机楼',
      '楼栋',
      '值守机楼',
    ]);
    const teamRaw = pickField(fields, [
      'fldE9Gwnk7',
      'fld5x9advB',
      '班组',
      '班别',
    ]);
    const shiftRaw = pickField(fields, ['fldqPpOgW5', '班次', '值班班次']);
    const buildingText = extractDisplayText(buildingRaw);
    const teamText = extractDisplayText(teamRaw);
    const shiftText = extractDisplayText(shiftRaw);
    const dutyStaffActualText = this.getScheduleTextField(
      fields,
      fieldConfig.dutyStaffActual,
    );
    const travelStaffText = this.getScheduleTextField(
      fields,
      fieldConfig.travelStaff,
    );

    return {
      recordId,
      scheduleDate,
      building: normalizeBuildingForFrontend(buildingText),
      buildingText,
      team: normalizeTeamForFrontend(teamText),
      teamText,
      shift: normalizeShiftForFrontend(shiftText),
      shiftText,
      dutyStaffActual: this.splitDutyPersonText(dutyStaffActualText),
      dutyStaffActualText,
      travelStaff: this.splitDutyPersonText(travelStaffText),
      travelStaffText,
    };
  }

  private getTravelScheduleRecordScopeKey(
    record: TravelStaffScheduleRecord,
  ): string {
    return [
      record.building || record.buildingText,
      record.team || record.teamText,
      record.shift || record.shiftText,
    ].join('|');
  }

  private buildTravelStaffDetailsFromRecords(
    records: BitableRecordItem[],
    fieldConfig: TravelStaffFieldConfig,
    startDate: string,
    endDate: string,
    staffNameInput?: string,
  ): TravelStaffDetailResponse['details'] {
    const staffFilter = this.normalizeDutyPersonNameForCompare(
      staffNameInput || '',
    );
    const byStaff = new Map<string, Map<string, TravelStaffScheduleRecord[]>>();

    for (const record of records) {
      const scheduleRecord = this.buildTravelScheduleRecord(
        record,
        fieldConfig,
      );
      if (
        !scheduleRecord ||
        scheduleRecord.scheduleDate < startDate ||
        scheduleRecord.scheduleDate > endDate
      ) {
        continue;
      }

      for (const name of scheduleRecord.travelStaff) {
        if (
          staffFilter &&
          this.normalizeDutyPersonNameForCompare(name) !== staffFilter
        ) {
          continue;
        }

        const dateMap =
          byStaff.get(name) || new Map<string, TravelStaffScheduleRecord[]>();
        const dateRecords = dateMap.get(scheduleRecord.scheduleDate) || [];
        dateRecords.push(scheduleRecord);
        dateMap.set(scheduleRecord.scheduleDate, dateRecords);
        byStaff.set(name, dateMap);
      }
    }

    const details: TravelStaffDetailResponse['details'] = [];
    for (const [staffName, dateMap] of byStaff.entries()) {
      const dates = [...dateMap.keys()].sort();
      let groupDates: string[] = [];
      let groupRecords: TravelStaffScheduleRecord[] = [];
      const pushGroup = () => {
        if (groupDates.length === 0) {
          return;
        }

        details.push({
          id: `${staffName}-${groupDates[0]}-${groupDates[groupDates.length - 1]}`,
          staffName,
          startDate: groupDates[0],
          endDate: groupDates[groupDates.length - 1],
          dates: [...groupDates],
          recordCount: groupRecords.length,
          records: [...groupRecords].sort((a, b) => {
            const dateCompare = a.scheduleDate.localeCompare(b.scheduleDate);
            if (dateCompare !== 0) return dateCompare;
            return `${a.buildingText}${a.shiftText}`.localeCompare(
              `${b.buildingText}${b.shiftText}`,
              'zh-CN',
            );
          }),
        });
      };

      for (const date of dates) {
        const recordsForDate = dateMap.get(date) || [];
        const previousDate = groupDates[groupDates.length - 1];
        if (previousDate && !this.isNextDateKey(previousDate, date)) {
          pushGroup();
          groupDates = [];
          groupRecords = [];
        }

        groupDates.push(date);
        groupRecords.push(...recordsForDate);
      }

      pushGroup();
    }

    return details.sort((a, b) => {
      const dateCompare = a.startDate.localeCompare(b.startDate);
      if (dateCompare !== 0) return dateCompare;
      return a.staffName.localeCompare(b.staffName, 'zh-CN');
    });
  }

  private isDateKeyInRange(
    date: string,
    startDate: string,
    endDate: string,
  ): boolean {
    return date >= startDate && date <= endDate;
  }

  private isNextDateKey(previousDate: string, nextDate: string): boolean {
    const previous = new Date(`${previousDate}T00:00:00+08:00`).getTime();
    const next = new Date(`${nextDate}T00:00:00+08:00`).getTime();
    return next - previous === 24 * 60 * 60 * 1000;
  }

  private formatDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private normalizeTravelStaffDateRange(
    startDateInput?: string,
    endDateInput?: string,
  ): { startDate: string; endDate: string } {
    const startDate = this.normalizeTravelDateInput(startDateInput, '开始日期');
    const endDate = this.normalizeTravelDateInput(endDateInput, '结束日期');
    const start = this.parseFocusDate(startDate);
    const end = this.parseFocusDate(endDate);

    if (!start || !end) {
      throw new Error('差旅日期格式不正确');
    }
    if (end < start) {
      throw new Error('差旅结束日期不能早于开始日期');
    }
    if (startDate.slice(0, 7) !== endDate.slice(0, 7)) {
      throw new Error('差旅日期不能跨月');
    }

    const days =
      Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (days > 31) {
      throw new Error('差旅日期最长只允许 1 个月');
    }

    return { startDate, endDate };
  }

  private normalizeLeaveRequestDateRange(
    startAtInput?: string,
    endAtInput?: string,
  ): {
    startAt: string;
    endAt: string;
    start: ParsedShanghaiLocalDateTime;
    end: ParsedShanghaiLocalDateTime;
  } {
    const startAt = typeof startAtInput === 'string' ? startAtInput : '';
    const endAt = typeof endAtInput === 'string' ? endAtInput : '';
    const start = parseShanghaiLocalDateTime(startAt);
    if (!start) {
      throw new BadRequestException(
        '休假开始时间格式无效，仅支持 YYYY-MM-DDTHH:00 整点',
      );
    }
    const end = parseShanghaiLocalDateTime(endAt);
    if (!end) {
      throw new BadRequestException(
        '休假结束时间格式无效，仅支持 YYYY-MM-DDTHH:00 整点',
      );
    }
    if (end.wallClockHourIndex <= start.wallClockHourIndex) {
      throw new BadRequestException('休假结束时间必须晚于开始时间');
    }
    return { startAt, endAt, start, end };
  }

  private normalizeTravelDateInput(
    value: string | undefined,
    label: string,
  ): string {
    const normalized = this.normalizeDutyStaffRepairValue(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new Error(`请选择有效的${label}`);
    }
    return normalized;
  }

  private replaceDutyPersonName(
    value: string,
    targetName: string,
    replacementName: string,
  ): string {
    const names = this.splitDutyPersonText(
      this.normalizeDutyStaffRepairValue(value),
    );
    const normalizedTarget = this.normalizeDutyStaffRepairValue(targetName);
    const normalizedReplacement =
      this.normalizeDutyStaffRepairValue(replacementName);
    const compareTarget =
      this.normalizeDutyPersonNameForCompare(normalizedTarget);

    if (!normalizedReplacement) {
      throw new Error('请填写修正后的人员姓名');
    }
    if (names.length === 0) {
      throw new Error('当前记录没有可修正的值班人员');
    }

    let replaced = false;
    const nextNames: string[] = [];
    names.forEach((name) => {
      const isTargetName =
        this.normalizeDutyPersonNameForCompare(name) === compareTarget;
      const nextName = !replaced && isTargetName ? normalizedReplacement : name;
      if (nextName && !nextNames.includes(nextName)) {
        nextNames.push(nextName);
      }
      if (isTargetName) {
        replaced = true;
      }
    });

    if (!replaced) {
      throw new Error(`当前记录中未找到人员“${normalizedTarget}”`);
    }

    return this.normalizeDutyStaffRepairValue(nextNames.join(' '));
  }

  private normalizeDutyPersonNameForCompare(value: string): string {
    return this.normalizeDutyStaffRepairValue(value).replace(/\s+/g, '');
  }

  private getShanghaiDateStartMs(date: string): number {
    return new Date(`${date}T00:00:00+08:00`).getTime();
  }

  private isLikelyDutyPersonList(value: string): boolean {
    const names = this.splitDutyPersonText(value);
    if (names.length === 0 || names.length > 6) {
      return false;
    }

    return names.every(
      (name) =>
        /^[\u4e00-\u9fa5A-Za-z·.\-]{2,12}$/.test(name) &&
        !/(字段|为空|无法|输出|任务|规则|人员|请假)/.test(name),
    );
  }

  private splitDutyPersonText(value: string): string[] {
    return value
      .split(/[\s、,，;；/]+/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  private async getMonthlySchedulesFromFeishu(
    startDate: string,
    endDate: string,
    forceRefresh = false,
    strict = false,
  ): Promise<MonthlySchedule[]> {
    const records = await this.fetchFeishuScheduleRecords(
      forceRefresh, strict, undefined, { startDate, endDate },
    );
    const schedules = records
      .map((record) => this.mapFeishuScheduleRecord(record))
      .filter((schedule): schedule is MonthlySchedule => {
        if (!schedule?.scheduleDate) return false;
        return (
          schedule.scheduleDate >= startDate && schedule.scheduleDate <= endDate
        );
      })
      .sort((a, b) => {
        const dateCompare = (b.scheduleDate || '').localeCompare(
          a.scheduleDate || '',
        );
        if (dateCompare !== 0) return dateCompare;
        return b.building.localeCompare(a.building);
      });

    this.logger.log(
      `飞书直读月度排班: ${startDate} 到 ${endDate}, 共 ${schedules.length} 条`,
    );
    return schedules;
  }

  private async getMonthlySchedulesFromLocalCache(
    startDate: string,
    endDate: string,
  ): Promise<MonthlySchedule[]> {
    const snapshot = await readLatestPersistedBitableRecordSnapshot({
      appToken: this.scheduleAppToken || undefined,
      tableId: this.scheduleTableId,
      tableName: '值班排班',
    });
    if (!snapshot) {
      throw new ServiceUnavailableException(
        '本地排班缓存尚未准备完成，请稍后重试',
      );
    }

    const approvalSnapshot = await readCachedLeaveApprovalSnapshot();
    const monthlyRecords = snapshot.records.filter((record) => {
      const scheduleDate = this.extractScheduleDateFromFields(
        record.fields || {},
      );
      return Boolean(
        scheduleDate && scheduleDate >= startDate && scheduleDate <= endDate,
      );
    });
    const schedules = enrichScheduleRecordsWithLeaveApproval(
      monthlyRecords,
      approvalSnapshot,
    )
      .map((record) => this.mapFeishuScheduleRecord(record))
      .filter((schedule): schedule is MonthlySchedule => {
        if (!schedule?.scheduleDate) return false;
        return (
          schedule.scheduleDate >= startDate && schedule.scheduleDate <= endDate
        );
      })
      .sort((a, b) => {
        const dateCompare = (b.scheduleDate || '').localeCompare(
          a.scheduleDate || '',
        );
        if (dateCompare !== 0) return dateCompare;
        return b.building.localeCompare(a.building);
      });

    this.logger.debug(
      `本地缓存读取月度排班: ${startDate} 到 ${endDate}, 共 ${schedules.length} 条`,
    );
    return schedules;
  }

  private async getYearlySealingInfoFromFeishu(
    year: number,
    forceRefresh = false,
  ): Promise<YearlySealingInfoResponse> {
    const startOfYear = new Date(year, 0, 1).getTime();
    const startOfNextYear = new Date(year + 1, 0, 1).getTime();
    const records = await this.fetchFeishuSealingRecords(forceRefresh);
    const sealings = records
      .map((record) => this.mapFeishuSealingRecord(record))
      .filter(
        (sealing): sealing is YearlySealingInfoResponse['sealings'][number] => {
          if (!sealing?.sealingName || !sealing.startDate || !sealing.endDate)
            return false;
          const start = new Date(sealing.startDate).getTime();
          const end = new Date(sealing.endDate).getTime();
          if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
          return start < startOfNextYear && end > startOfYear;
        },
      )
      .sort(
        (a, b) =>
          new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
      );

    this.logger.log(`飞书直读 ${year} 年封网信息: ${sealings.length} 条`);
    return {
      sealings,
      total: sealings.length,
      sourceStatus: this.sealingSourceSnapshot?.stale ? 'stale' : 'fresh',
      syncedAt: this.sealingSourceSnapshot
        ? new Date(this.sealingSourceSnapshot.fetchedAt).toISOString()
        : undefined,
    };
  }

  private mapFeishuSealingRecord(
    record: BitableRecordItem,
  ): YearlySealingInfoResponse['sealings'][number] | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const now = new Date().toISOString();
    const sealingName = extractDisplayText(
      pickField(fields, ['封网信息', '名称', '封网名称']),
    );
    const startDate = extractDateTimeIso(
      pickField(fields, ['开始日期', '开始时间', '开始']),
    );
    const endDate =
      extractDateTimeIso(pickField(fields, ['结束日期', '结束时间', '结束'])) ||
      startDate;

    if (!recordId || !sealingName || !startDate || !endDate) {
      return null;
    }

    const sealingType = sealingName.includes('强管控')
      ? '强管控'
      : sealingName.includes('弱管控')
        ? '弱管控'
        : null;
    const today = new Date();
    const todayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const tomorrowStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + 1,
    );
    const isToday = isDateTimeRangeActiveInWindow(
      startDate,
      endDate,
      todayStart,
      tomorrowStart,
    );

    return {
      id: recordId,
      bitableRecordId: recordId,
      sealingCode:
        extractDisplayText(pickField(fields, ['编号', '封网编号']), '') || '',
      sealingName,
      startDate,
      endDate,
      sealingType,
      autoNumber:
        extractDisplayText(pickField(fields, ['自增编号', '序号']), '') || null,
      isToday,
      createdAt: extractDateTimeIso(record.created_time) || now,
      updatedAt: extractDateTimeIso(record.last_modified_time) || now,
    };
  }

  private async getYearlyChangeInfoFromFeishu(
    year: number,
    forceRefresh = false,
  ): Promise<YearlyChangeInfoResponse> {
    const startOfYear = new Date(year, 0, 1).getTime();
    const startOfNextYear = new Date(year + 1, 0, 1).getTime();
    const records = await this.fetchFeishuCalendarChangeRecords(forceRefresh);
    const mappedChanges = await Promise.all(
      records.map(async (record) => {
        const baseRecord = this.mapFeishuCalendarChangeRecord(record);
        if (!baseRecord) return null;
        try {
          return await extendChangeInfoWithAdjustmentRecord(
            baseRecord,
            record,
            {
              resolveStorage: async ({ recordId, fileToken }) => {
                const storage = this.changeAttachmentStorage;
                if (!storage) return null;
                const metadata =
                  await storage.findByFileTokenForTrustedServer(fileToken);
                if (!metadata || metadata.boundRecordId !== recordId) {
                  return null;
                }
                return {
                  id: metadata.id,
                  filePath: metadata.filePath,
                  bucketId: metadata.bucketId,
                  url: metadata.url,
                };
              },
            },
          );
        } catch (error) {
          this.logger.warn(
            `变更记录 ${baseRecord.id} 附件扩展映射失败，已保留基础信息：${getBitableAxiosErrorMessage(error)}`,
          );
          return baseRecord;
        }
      }),
    );
    const changes = mappedChanges
      .filter(
        (change): change is YearlyChangeInfoResponse['changes'][number] => {
          if (!change?.title || !change.startDate) return false;
          const start = new Date(change.startDate).getTime();
          const end = new Date(change.endDate || change.startDate).getTime();
          if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
          const normalizedEnd = end > start ? end : start + 60 * 1000;
          return start < startOfNextYear && normalizedEnd > startOfYear;
        },
      )
      .sort(
        (a, b) =>
          new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
      );

    this.logger.log(`飞书直读 ${year} 年计划变更信息: ${changes.length} 条`);
    return {
      changes,
      total: changes.length,
      keyTotal: changes.filter((change) => change.isKey).length,
    };
  }

  private mapFeishuCalendarChangeRecord(
    record: BitableRecordItem,
  ): YearlyChangeInfoResponse['changes'][number] | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const now = new Date().toISOString();
    const title = extractDisplayText(
      pickField(fields, [
        'fld4Mb34MM',
        '变更简述',
        '变更编码&描述',
        '变更名称',
        '内容',
      ]),
    );
    const startDate = extractDateTimeIso(
      pickField(fields, [
        'fldVD5BNEQ',
        '计划开始日期（阿里）',
        '计划开始时间',
        '计划开始日期',
        '计划时间',
      ]),
    );
    const endDate =
      extractDateTimeIso(
        pickField(fields, [
          'fldrl38KPS',
          '计划结束日期（阿里）',
          '计划结束时间',
          '计划结束日期',
        ]),
      ) || startDate;
    const actualStartDate = this.extractCalendarChangeDateTime(fields, [
      'fldu91qLqi',
      '实际开始时间',
      '实际开始日期',
      '实际开始',
    ]);
    const actualEndDate = this.extractCalendarChangeDateTime(fields, [
      'fldnKfcbCa',
      '实际结束时间',
      '实际结束日期',
      '实际结束',
    ]);
    const plannedDelayStartDate = this.extractCalendarChangeDateTime(fields, [
      'fldDnCn6n4',
      '计划延迟开始日期',
      '计划延迟开始',
      '计划延迟开始时间',
      '计划延期开始',
      '延期开始',
    ]);
    const plannedDelayEndDate = this.extractCalendarChangeDateTime(fields, [
      'fldThF1p25',
      '计划延迟结束日期',
      '计划延迟结束',
      '计划延迟结束时间',
      '计划延期结束',
      '延期结束',
    ]);

    if (!recordId || !title || !startDate || !endDate) {
      return null;
    }

    const level =
      extractDisplayText(
        pickField(fields, [
          'fldyx0s7Ra',
          '变更等级（阿里）',
          '变更等级',
          '风险等级',
        ]),
        '',
      ) || null;
    const type =
      extractDisplayText(
        pickField(fields, ['fldMCGLrqs', '变更类型', '类型']),
        '',
      ) || null;
    const progress =
      extractDisplayText(
        pickField(fields, ['fldMSZy9Qm', '变更进度', '进度', '状态']),
        '',
      ) || null;
    const executor =
      extractDisplayText(
        pickField(fields, [
          '执行人',
          '执行人员',
          '变更执行人',
          '实施人',
          '实施人员',
          '负责人',
          '责任人',
          'Owner',
        ]),
        '',
      ) || null;
    const buildings = extractDisplayValues(
      pickField(fields, ['fldpvaNYeb', '变更楼栋', '楼栋']),
    );
    const riskSummary =
      extractDisplayText(
        pickField(fields, [
          'fldx4xtjHB',
          '变更重要风险点（简述）',
          '重要风险点',
          '风险点',
        ]),
        '',
      ) || null;
    const keySignal = [level, type, title, ...buildings]
      .filter(Boolean)
      .join(' ');
    const stableUpdatedAt = extractDateTimeIso(record.last_modified_time);

    return {
      id: recordId,
      bitableRecordId: recordId,
      title,
      startDate,
      endDate,
      actualStartDate,
      actualEndDate,
      plannedDelayStartDate,
      plannedDelayEndDate,
      level,
      type,
      progress,
      executor,
      buildings,
      riskSummary,
      isKey: this.isI2OrAbove(keySignal) || this.isMediumRiskOrAbove(keySignal),
      recordUrl: this.buildBitableRecordUrl(
        this.calendarChangeConfig,
        recordId,
      ),
      createdAt: extractDateTimeIso(record.created_time) || now,
      updatedAt: stableUpdatedAt || now,
      adjustmentUpdatedAt: stableUpdatedAt,
    };
  }

  private parseShanghaiDateTimeMs(value: string, fieldName: string): number {
    const rawValue = value.trim();
    if (!rawValue) {
      throw new Error(`${fieldName}不能为空`);
    }

    let normalized = rawValue.replace(/\//g, '-').replace(/\s+/, 'T');
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      normalized = `${normalized}T00:00:00`;
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
      normalized = `${normalized}:00`;
    }

    const hasTimezone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized);
    const parsed = new Date(hasTimezone ? normalized : `${normalized}+08:00`);
    const timestamp = parsed.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error(`${fieldName}格式不正确`);
    }
    return timestamp;
  }

  private extractCalendarChangeDateTime(
    fields: Record<string, unknown>,
    names: string[],
  ): string | null {
    return this.extractCalendarChangeDateTimeValue(pickField(fields, names));
  }

  private extractCalendarChangeDateTimeValue(value: unknown): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const parsed = this.extractCalendarChangeDateTimeValue(item);
        if (parsed) return parsed;
      }
      return null;
    }

    if (typeof value === 'number') {
      return (
        this.extractExcelSerialDateTime(value) || extractDateTimeIso(value)
      );
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const key of [
        'timestamp',
        'date',
        'text',
        'value',
        'display_value',
      ]) {
        const parsed = this.extractCalendarChangeDateTimeValue(obj[key]);
        if (parsed) return parsed;
      }
    }

    return extractDateTimeIso(value);
  }

  private extractExcelSerialDateTime(value: number): string | null {
    if (!Number.isFinite(value) || value < 20000 || value > 80000) {
      return null;
    }

    const epoch = new Date(1899, 11, 30);
    return new Date(
      epoch.getTime() + value * 24 * 60 * 60 * 1000,
    ).toISOString();
  }

  private mapFeishuScheduleRecord(
    record: BitableRecordItem,
  ): MonthlySchedule | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const now = new Date().toISOString();

    const scheduleDate = extractDateValue(
      pickField(fields, [
        'fldZSaDbGf',
        '排班日期',
        '日期',
        'schedule_date',
        '排班日期（日期）',
      ]),
    );
    if (!scheduleDate) {
      return null;
    }

    const buildingRaw = pickField(fields, [
      'fldnP4gXMn',
      '机楼',
      '楼栋',
      '值守机楼',
    ]);
    const teamRaw = pickField(fields, ['fldE9Gwnk7', '班组', '班别']);
    const shiftRaw = pickField(fields, ['fldqPpOgW5', '班次', '值班班次']);
    const buildingText = extractDisplayText(buildingRaw);
    const teamText = extractDisplayText(teamRaw);
    const shiftText = extractDisplayText(shiftRaw);

    const personText = extractDisplayText(
      pickField(fields, ['fldJi5bxBG', '人员（文本）', '人员']),
    );
    const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);
    const fallbackStaff =
      approvedLeave.dutyStaff.length > 0
        ? approvedLeave.dutyStaff
        : extractDisplayValues(personText);

    const emergencyDutySchedule = extractDisplayText(
      pickField(fields, [
        '应急值班人员（排班表）',
        '应急值班人员（排班）',
        '应急值班安排',
        '应急值班人员排班',
        '应急值班',
        '应急',
        'emergency_schedule',
        'emergencyschedule',
      ]),
    );

    return {
      id: recordId,
      recordId,
      dutyCode:
        extractDisplayText(
          pickField(fields, ['fldITqhd37', '值班编码', '值班编号']),
        ) || recordId,
      scheduleDate,
      code: extractNumberValue(pickField(fields, ['fldRAVxqf7', '编码'])),
      building: normalizeBuildingForFrontend(buildingText),
      team: normalizeTeamForFrontend(teamText),
      shift: normalizeShiftForFrontend(shiftText),
      personText,
      dutyStaffReference: extractDisplayValues(
        pickField(fields, ['flddMP5Au3', '值班人员（对照）', '值班人员(对照)']),
      ),
      dutyStaffActual: fallbackStaff,
      remark: extractDisplayText(pickField(fields, ['fldQBMKyrd', '备注'])),
      emergencyDuty: extractDisplayText(
        pickField(fields, ['fldduEXCmp', '应急值班']),
      ),
      emergencyDutySchedule,
      leaveStaff: approvedLeave.leaveStaff,
      substituteStaff: approvedLeave.substituteStaff,
      leaveAssignments: readApprovedLeaveAssignmentsFromFields(fields),
      travelStaff: extractDisplayValues(
        pickField(fields, ['差旅人员', '出差人员', '差旅', '差旅人员信息']),
      ),
      actualDutyStaff: extractDisplayText(
        pickField(fields, ['fldZ2mFMdH', '实际值班人员']),
      ),
      buildingText: buildingText || normalizeBuildingLabel(buildingText),
      teamText,
      shiftText,
      createdAt: extractDateTimeIso(record.created_time) || now,
      updatedAt: extractDateTimeIso(record.last_modified_time) || now,
    };
  }

  /**
   * 解析 PostgreSQL 数组字符串为 JavaScript 数组
   * 例如: "{a,b,c}" -> ["a", "b", "c"]
   */
  private parsePostgresArray(
    value: string[] | string | null | undefined,
  ): string[] {
    if (value === null || value === undefined) {
      return [];
    }
    // 如果已经是数组，直接返回
    if (Array.isArray(value)) {
      return value;
    }
    // 如果是字符串，解析 PostgreSQL 数组格式
    if (typeof value === 'string') {
      // PostgreSQL 数组格式: {a,b,c} 或 {a,"b,c"}
      const trimmed = value.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const content = trimmed.slice(1, -1);
        if (content === '') {
          return [];
        }
        // 简单分割，不处理嵌套引号（当前数据没有这种情况）
        return content
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item);
      }
      // 如果不是 PostgreSQL 数组格式，按逗号分割
      return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item);
    }
    return [];
  }

  /**
   * 获取所有楼栋的基础信息（静态数据）
   */
  async getBuildings() {
    return [
      { id: 'A', name: 'A栋' },
      { id: 'B', name: 'B栋' },
      { id: 'C', name: 'C栋' },
      { id: 'D', name: 'D栋' },
      { id: 'E', name: 'E栋' },
      { id: 'H', name: 'H栋' },
      { id: '110', name: '110站' },
    ];
  }

  /**
   * 获取指定日期范围内的排班数据
   */
  async getDutySchedules(
    startDate?: string,
    endDate?: string,
    verifiedApprovalSnapshot?: LeaveApprovalSnapshot,
  ) {
    try {
      const records = await this.fetchFeishuScheduleRecords(
        Boolean(verifiedApprovalSnapshot),
        Boolean(verifiedApprovalSnapshot),
        verifiedApprovalSnapshot,
      );
      return records
        .map((record) => this.mapFeishuScheduleRecord(record))
        .filter((schedule): schedule is MonthlySchedule => {
          if (!schedule?.scheduleDate) return false;
          if (startDate && schedule.scheduleDate < startDate) return false;
          if (endDate && schedule.scheduleDate > endDate) return false;
          return true;
        })
        .sort((a, b) => {
          const dateCompare = (b.scheduleDate || '').localeCompare(
            a.scheduleDate || '',
          );
          return dateCompare || b.building.localeCompare(a.building);
        });
    } catch (error) {
      this.logger.error('获取排班数据失败', error);
      throw error;
    }
  }

  /**
   * 批量创建或更新排班数据
   */
  async batchUpsertDutySchedules(
    schedules: Array<{ buildingId: string; dutyDate: string; staffId: string }>,
    principal?:AccessPrincipal,
  ) {
    try {
      const buildingIdMap: Record<
        string,
        | 'app_a_building'
        | 'app_b_building'
        | 'app_c_building'
        | 'app_d_building'
        | 'app_e_building'
        | 'app_h_building'
        | 'station_110'
      > = {
        A: 'app_a_building',
        B: 'app_b_building',
        C: 'app_c_building',
        D: 'app_d_building',
        E: 'app_e_building',
        H: 'app_h_building',
        '110': 'station_110',
      };

      if (!Array.isArray(schedules) || schedules.some(schedule=>!schedule || !buildingIdMap[schedule.buildingId] || !/^\d{4}-\d{2}-\d{2}$/.test(schedule.dutyDate) || typeof schedule.staffId!=='string' || !schedule.staffId.trim())) throw new BadRequestException('排班楼栋、日期或人员无效');
      return await this.db.transaction(async transaction => {
      const results = [];
      for (const schedule of schedules) {
        const { buildingId, dutyDate, staffId } = schedule;
        const buildingEnum = buildingIdMap[buildingId];

        const existing = await transaction
          .select()
          .from(appRoomScheduleEnhanced)
          .where(
            and(
              eq(appRoomScheduleEnhanced.building, buildingEnum),
              eq(appRoomScheduleEnhanced.scheduleDate, dutyDate),
            ),
          )
          .limit(1);

        if (principal) assertBusinessOperation(principal,{module:'schedule_assignments',action:existing.length?'update':'create'});
        if (existing.length > 0) {
          const updated = await transaction
            .update(appRoomScheduleEnhanced)
            .set({ dutyStaffActual: [staffId] })
            .where(eq(appRoomScheduleEnhanced.id, existing[0].id))
            .returning();
          results.push(updated[0]);
        } else {
          const inserted = await transaction
            .insert(appRoomScheduleEnhanced)
            .values({
              recordId: `${buildingId}-${dutyDate}`,
              building: buildingEnum,
              scheduleDate: dutyDate,
              dutyStaffActual: [staffId],
            })
            .returning();
          results.push(inserted[0]);
        }
      }

      this.logger.debug(`批量创建/更新排班数据成功，共 ${results.length} 条`);
      return { success: true };
      });
    } catch (error) {
      this.logger.error('批量创建/更新排班数据失败', error);
      throw error;
    }
  }

  /**
   * 获取月度值班数据
   */
  private requiresApprovalAwareScheduleSourceRead(): boolean {
    // 本地排班表没有“审批已验证”标记，不能安全区分待审批与已审批记录。
    return true;
  }

  async getMonthlySchedules(year: number, month: number, forceRefresh = false) {
    try {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;

      if (forceRefresh) {
        return this.getMonthlySchedulesFromFeishu(
          startDate,
          endDate,
          true,
          true,
        );
      }

      if (
        this.requiresApprovalAwareScheduleSourceRead() ||
        isDatabaseDisabled()
      ) {
        return this.getMonthlySchedulesFromLocalCache(startDate, endDate);
      }

      const results = await this.db
        .select()
        .from(appRoomScheduleEnhanced)
        .where(
          and(
            gte(appRoomScheduleEnhanced.scheduleDate, startDate),
            lte(appRoomScheduleEnhanced.scheduleDate, endDate),
          ),
        )
        .orderBy(
          desc(appRoomScheduleEnhanced.scheduleDate),
          desc(appRoomScheduleEnhanced.building),
        );

      this.logger.log(
        `查询月度数据: ${startDate} 到 ${endDate}, 共查询到 ${results.length} 条记录`,
      );

      const buildingMap: Record<string, string> = {
        app_a_building: 'building_a',
        app_b_building: 'building_b',
        app_c_building: 'building_c',
        app_d_building: 'building_d',
        app_e_building: 'building_e',
        app_h_building: 'building_h',
        station_110: 'station_110',
        a_building: 'building_a',
        b_building: 'building_b',
        c_building: 'building_c',
        d_building: 'building_d',
        e_building: 'building_e',
        h_building: 'building_h',
      };

      const teamMap: Record<string, string> = {
        shift_a: 'shift_a',
        shift_b: 'shift_b',
        shift_c: 'shift_c',
        shift_d: 'shift_d',
        long_white_shift: 'long_white',
        a_shift: 'shift_a',
        b_shift: 'shift_b',
        c_shift: 'shift_c',
        d_shift: 'shift_d',
        changbai: 'long_white',
      };

      const shiftMap: Record<string, string> = {
        white_shift: 'white',
        night_shift: 'night',
        long_white_shift: 'long_white',
        white: 'white',
        night: 'night',
        changbai: 'long_white',
      };

      // 调试：打印第一条记录的 dutyStaffActual 原始值
      if (results.length > 0) {
        this.logger.log(
          `查询结果 dutyStaffActual 原始值: ${JSON.stringify(results[0].dutyStaffActual)}, 类型: ${typeof results[0].dutyStaffActual}, 是否数组: ${Array.isArray(results[0].dutyStaffActual)}`,
        );
      }

      const formattedResults = results
        .map((item) => ({
          id: item.id,
          recordId: item.recordId,
          dutyCode: item.dutyCode,
          scheduleDate: item.scheduleDate
            ? new Date(item.scheduleDate).toISOString().split('T')[0]
            : null,
          code: item.code,
          building:
            buildingMap[item.building as keyof typeof buildingMap] ||
            item.building,
          team: teamMap[item.team as keyof typeof teamMap] || item.team,
          shift: shiftMap[item.shift as keyof typeof shiftMap] || item.shift,
          personText: item.personText,
          dutyStaffReference: item.dutyStaffReference,
          dutyStaffActual: item.dutyStaffActual,
          remark: item.remark,
          emergencyDuty: item.emergencyDuty,
          emergencyDutySchedule: item.emergencyDutySchedule,
          leaveStaff: item.leaveStaff,
          substituteStaff: item.substituteStaff,
          actualDutyStaff: item.actualDutyStaff,
          buildingText: item.buildingText || '',
          teamText: item.teamText || '',
          shiftText: item.shiftText || '',
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }))
        .map((item) => {
          const parsedDutyStaffActual = this.parsePostgresArray(
            item.dutyStaffActual,
          );
          const parsedDutyStaffReference = this.parsePostgresArray(
            item.dutyStaffReference,
          );
          const parsedLeaveStaff = this.parsePostgresArray(item.leaveStaff);
          const parsedSubstituteStaff = this.parsePostgresArray(
            item.substituteStaff,
          );
          return {
            ...item,
            dutyStaffActual: parsedDutyStaffActual,
            dutyStaffReference: parsedDutyStaffReference,
            leaveStaff: parsedLeaveStaff,
            substituteStaff: parsedSubstituteStaff,
          };
        });

      return formattedResults;
    } catch (error) {
      this.logger.error('获取月度值班数据失败', error);
      throw error;
    }
  }

  /**
   * 从飞书多维表格同步数据到数据库
   */
  /**
   * 创建新的同步任务
   */
  createSyncTask(kind: SyncTaskKind = 'general'): SyncTask {
    const randomId = crypto.randomUUID();
    const taskId =
      kind === 'construction' ? `construction-${randomId}` : randomId;
    const task: SyncTask = {
      id: taskId,
      status: 'pending',
      startTime: new Date(),
    };
    this.syncTasks.set(taskId, task);
    return task;
  }

  /**
   * 获取同步任务状态
   */
  getSyncTask(taskId: string): SyncTask | undefined {
    return this.syncTasks.get(taskId);
  }

  /**
   * 获取当前正在执行的任务
   */
  getCurrentTask(): SyncTask | null {
    if (this.currentTaskId) {
      return this.syncTasks.get(this.currentTaskId) || null;
    }
    return null;
  }

  /**
   * 从飞书多维表格同步数据到数据库（异步执行）
   */
  async syncFromFeishuBaseAsync(taskId: string): Promise<void> {
    const task = this.syncTasks.get(taskId);
    if (!task) return;

    this.currentTaskId = taskId;
    task.status = 'running';

    try {
      const result = await this.syncFromFeishuBase();
      task.status = 'completed';
      task.endTime = new Date();
      task.total = result.total;
      task.inserted = result.inserted;
      task.failed = result.failed;
      task.message = result.message;
    } catch (error) {
      task.status = 'failed';
      task.endTime = new Date();
      task.message = error instanceof Error ? error.message : '同步失败';
      this.logger.error('异步同步任务失败', error);
    } finally {
      this.currentTaskId = null;
    }
  }

  /**
   * 启动同步任务（立即返回任务ID）
   */
  startSyncFromFeishuBase(): { taskId: string; status: string } {
    // 检查是否有正在运行的任务
    if (this.isSyncing) {
      const currentTask = this.getCurrentTask();
      if (currentTask && currentTask.status === 'running') {
        return {
          taskId: currentTask.id,
          status: 'running',
        };
      }
    }

    const task = this.createSyncTask();

    // 异步执行同步操作，不等待完成
    this.syncFromFeishuBaseAsync(task.id).catch((error) => {
      this.logger.error('异步同步执行失败', error);
    });

    return {
      taskId: task.id,
      status: 'pending',
    };
  }

  /**
   * 实际执行同步操作（供自动化任务和内部调用）
   */
  async syncFromFeishuBase() {
    // 检查是否正在同步
    if (this.isSyncing) {
      this.logger.warn('同步任务正在进行中，跳过本次同步请求');
      return {
        success: false,
        total: 0,
        inserted: 0,
        failed: 0,
        failedRecords: [],
        message: '同步任务正在进行中，请稍后再试',
      };
    }

    if (isDatabaseDisabled()) {
      const records = await this.fetchFeishuScheduleRecords(true);
      return {
        success: true,
        total: records.length,
        inserted: 0,
        failed: 0,
        failedRecords: [],
        message: `本地数据库未启用，已切换为飞书直读模式（值班排班表 ${records.length} 条）`,
      };
    }

    this.isSyncing = true;
    let totalInserted = 0;
    let totalFailed = 0;
    const failedRecords: Array<{ recordId: string; error: string }> = [];

    try {
      const tableId = this.scheduleTableId;
      const appToken = this.scheduleAppToken;
      assertBitableTableConfig('月度值班排班', appToken, tableId);
      // 不指定 viewId，获取表格的所有数据（包括所有视图）
      // const viewId = 'vewl3Fg9vD';

      this.logger.debug('开始从飞书多维表格同步数据');

      const tokenResponse = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
      );

      const tenantAccessToken = tokenResponse.data.tenant_access_token;

      this.logger.debug('获取 tenant_access_token 成功');

      this.logger.debug(
        `使用月度值班表配置：${maskSecret(appToken)} / ${tableId}`,
      );

      const records = [];
      let pageToken: string | undefined;
      const pageSize = 100; // 减小每页大小，加快响应
      let pageCount = 0;

      let hasMore: boolean;
      do {
        pageCount++;
        const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
        this.logger.debug(`调用飞书 API (第 ${pageCount} 页): ${apiUrl}`);

        const response = await this.httpService.axiosRef.get(apiUrl, {
          headers: {
            Authorization: 'Bearer ' + tenantAccessToken,
          },
          params: {
            page_size: pageSize,
            page_token: pageToken,
          },
          timeout: 30000, // 每个请求30秒超时
        });

        if (response.data.code !== 0) {
          this.logger.error(
            `飞书 API 错误: code=${response.data.code}, msg=${response.data.msg}, URL=${apiUrl}`,
          );
          throw new Error(
            `飞书 API 错误: code=${response.data.code}, msg=${response.data.msg}`,
          );
        }

        const currentBatch = response.data.data.items || [];
        records.push(...currentBatch);
        pageToken = response.data.data.page_token;
        hasMore = response.data.data.has_more;

        this.logger.debug(
          `第 ${pageCount} 页获取到 ${currentBatch.length} 条记录，累计 ${records.length} 条`,
        );
      } while (hasMore);

      this.logger.debug(`从飞书获取到 ${records.length} 条记录`);
      // 调试日志：输出获取到的记录数量（用于排查同步问题）
      if (records.length === 0) {
        return {
          success: true,
          total: 0,
          message: '没有需要同步的数据',
        };
      }

      const buildingMap: Record<string, string> = {
        A楼: 'app_a_building',
        B楼: 'app_b_building',
        C楼: 'app_c_building',
        D楼: 'app_d_building',
        E楼: 'app_e_building',
        H楼: 'app_h_building',
        '110站': 'station_110',
      };

      const teamMap: Record<string, string> = {
        A班: 'shift_a',
        B班: 'shift_b',
        C班: 'shift_c',
        D班: 'shift_d',
        长白: 'long_white_shift',
        长: 'long_white_shift',
      };

      const shiftMap: Record<string, string> = {
        白: 'white_shift',
        夜: 'night_shift',
        长: 'long_white_shift',
      };

      // 使用新的 appRoomScheduleEnhanced 表
      const insertData = records.map((record: any, index: number) => {
        const fields = record.fields || {};

        // 调试：打印第一条记录的完整内容和所有字段
        if (index === 0) {
          this.logger.log(
            `飞书记录完整内容: ${JSON.stringify(record, null, 2)}`,
          );
          const fieldNames = Object.keys(fields).join(', ');
          this.logger.log(`飞书记录字段名: ${fieldNames}`);
        }

        // 尝试多种可能的排班日期字段名（使用 field_id）
        let dateValue =
          fields['fldZSaDbGf'] || // 排班日期 field_id
          fields['排班日期'] || // field_name
          fields['日期'] ||
          fields['排班日期（文本）'] ||
          fields['日期（排班）'] ||
          fields['schedule_date'] ||
          fields['排班日期（日期）'] ||
          null;

        // 调试：打印排班日期的原始值（仅打印前10条记录）
        if (index < 10) {
          this.logger.log(
            `记录 ${record.record_id} 的排班日期原始值: ${JSON.stringify(dateValue)}, 类型: ${typeof dateValue}`,
          );
        }

        // 如果日期为空字符串或不存在，则设为 null
        if (!dateValue || dateValue === '') {
          dateValue = null;
        } else if (typeof dateValue === 'number') {
          // 如果是时间戳，转换为 YYYY-MM-DD 格式
          // 使用本地时区处理，因为飞书返回的时间戳通常是按本地时区设置的
          const dateObj = new Date(dateValue);
          const year = dateObj.getFullYear();
          const month = String(dateObj.getMonth() + 1).padStart(2, '0');
          const day = String(dateObj.getDate()).padStart(2, '0');
          dateValue = `${year}-${month}-${day}`;
          this.logger.log(
            `记录 ${record.record_id} 的排班日期从时间戳转换: ${dateValue}`,
          );
        } else if (typeof dateValue === 'string') {
          // 如果是字符串，尝试解析日期
          // 可能是 "2025-12-31" 或 "2025/12/31" 格式
          const dateObj = new Date(dateValue);
          if (!isNaN(dateObj.getTime())) {
            const year = dateObj.getFullYear();
            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getDate()).padStart(2, '0');
            dateValue = `${year}-${month}-${day}`;
            this.logger.log(
              `记录 ${record.record_id} 的排班日期从字符串转换: ${dateValue} - 类型: ${typeof dateValue}`,
            );
          } else {
            // 无法解析的日期，设为 null
            this.logger.warn(
              `记录 ${record.record_id} 的排班日期无法解析: ${dateValue}`,
            );
            dateValue = null;
          }
        }

        // 机楼：优先使用 field_id，其次使用 field_name
        const buildingSelect = fields['fldnP4gXMn'] || fields['机楼'];
        let buildingValue: string;
        if (
          buildingSelect &&
          typeof buildingSelect === 'object' &&
          buildingSelect.select
        ) {
          buildingValue =
            buildingMap[buildingSelect.select.name] ||
            buildingSelect.select.name;
        } else {
          buildingValue =
            buildingMap[buildingSelect] || buildingSelect || 'app_a_building';
        }

        const buildingTextValue = fields['fldUHstSKX'] || buildingValue;

        // 班组：优先使用 field_id，其次使用 field_name
        const teamSelect = fields['fldE9Gwnk7'] || fields['班组'];
        let teamValue: string;
        if (teamSelect && typeof teamSelect === 'object' && teamSelect.select) {
          teamValue = teamMap[teamSelect.select.name] || teamSelect.select.name;
        } else {
          teamValue = teamMap[teamSelect] || teamSelect || 'shift_a';
        }

        const teamTextValue = fields['fld5x9advB'] || teamValue;

        // 班次：优先使用 field_id，其次使用 field_name
        const shiftSelect = fields['fldqPpOgW5'] || fields['班次'];
        let shiftValue: string;
        if (
          shiftSelect &&
          typeof shiftSelect === 'object' &&
          shiftSelect.select
        ) {
          shiftValue =
            shiftMap[shiftSelect.select.name] || shiftSelect.select.name;
        } else {
          shiftValue = shiftMap[shiftSelect] || shiftSelect || 'white_shift';
        }

        const shiftTextValue = fields['fldu67xR8x'] || shiftValue;

        // 值班编码：优先使用 field_id
        const dutyCodeRawValue =
          fields['fldITqhd37'] || fields['值班编码'] || record.record_id;
        let dutyCodeValue: string;
        if (typeof dutyCodeRawValue === 'string') {
          dutyCodeValue = dutyCodeRawValue;
        } else if (typeof dutyCodeRawValue === 'object') {
          dutyCodeValue = JSON.stringify(dutyCodeRawValue);
        } else {
          dutyCodeValue = String(dutyCodeRawValue || '');
        }

        // 编号：优先使用 field_id
        const codeValue = fields['fldRAVxqf7'] || fields['编码'];

        // 处理值班人员（对照）字段 - 使用 field_id
        let dutyStaffReferenceList: string[] = [];
        const dutyStaffReferenceValue =
          fields['flddMP5Au3'] ||
          fields['值班人员（对照）'] ||
          fields['A#值班人员（对照）'];
        if (dutyStaffReferenceValue) {
          if (typeof dutyStaffReferenceValue === 'string') {
            dutyStaffReferenceList = dutyStaffReferenceValue
              .split(/[\s,，、]+/)
              .filter((s: string) => s.trim());
          }
        }

        // 处理 personText 字段，优先使用 field_id
        let personTextValue = '';
        const personFieldValue =
          fields['fldJi5bxBG'] || fields['人员（文本）'] || fields['人员'];
        if (typeof personFieldValue === 'string') {
          personTextValue = personFieldValue;
        } else if (personFieldValue && typeof personFieldValue === 'object') {
          personTextValue = JSON.stringify(personFieldValue);
        }

        // 处理值班人员（实际）字段 - 使用 field_id（公式字段）
        let dutyStaffActualList: string[] = [];
        const dutyStaffActualValue = pickDutyStaffActualField(fields);

        // 调试：打印前3条记录的值班人员（实际）字段
        if (index < 3) {
          this.logger.log(
            `记录 ${record.record_id} 值班人员（实际）原始值: ${JSON.stringify(dutyStaffActualValue)}, 类型: ${typeof dutyStaffActualValue}, 是否数组: ${Array.isArray(dutyStaffActualValue)}`,
          );
          this.logger.log(
            `记录 ${record.record_id} 所有字段名: ${Object.keys(fields).join(', ')}`,
          );
        }

        if (dutyStaffActualValue) {
          if (typeof dutyStaffActualValue === 'string') {
            dutyStaffActualList = dutyStaffActualValue
              .split(/[\s,，、]+/)
              .filter((s: string) => s.trim());
          } else if (Array.isArray(dutyStaffActualValue)) {
            // 处理对象数组，提取 name 或 text 字段（公式字段格式）
            dutyStaffActualList = dutyStaffActualValue
              .map((item: any) => {
                if (typeof item === 'string') {
                  return item;
                } else if (item && typeof item === 'object') {
                  // 飞书公式字段可能返回的对象格式
                  const name =
                    item.name ||
                    item.text ||
                    item.label ||
                    item.user_name ||
                    item.value ||
                    item.title;
                  if (name) return name;
                  // 如果是嵌套对象，尝试提取
                  if (
                    item.users &&
                    Array.isArray(item.users) &&
                    item.users.length > 0
                  ) {
                    return (
                      item.users[0].name ||
                      item.users[0].text ||
                      JSON.stringify(item)
                    );
                  }
                  return JSON.stringify(item);
                }
                return String(item);
              })
              .filter((s: string) => s && s.trim());
          } else if (typeof dutyStaffActualValue === 'object') {
            // 处理单个对象的情况
            const obj = dutyStaffActualValue as any;
            const name =
              obj.name ||
              obj.text ||
              obj.label ||
              obj.user_name ||
              obj.value ||
              obj.title;
            if (name) dutyStaffActualList = [name];
          }
        }

        // 处理休假人员字段 - 使用 field_id fld4xMPICY（请假人员（请假表））
        let leaveStaffList: string[] = [];
        const leaveStaffValue =
          fields['fld4xMPICY'] || fields['请假人员（请假表）'];
        this.logger.debug(
          `请假人员原始值: ${JSON.stringify({ recordId: record.record_id, leaveStaffValue, type: typeof leaveStaffValue, isArray: Array.isArray(leaveStaffValue) })}`,
        );

        if (leaveStaffValue) {
          if (typeof leaveStaffValue === 'string') {
            leaveStaffList = leaveStaffValue
              .split(/[\s,，、]+/)
              .filter((s: string) => s.trim());
          } else if (Array.isArray(leaveStaffValue)) {
            // 处理对象数组，提取 name 或 text 字段
            leaveStaffList = leaveStaffValue
              .map((item: any) => {
                if (typeof item === 'string') {
                  return item;
                } else if (item && typeof item === 'object') {
                  // 飞书公式字段可能返回的对象格式
                  // 尝试多种可能的字段名
                  const name =
                    item.name ||
                    item.text ||
                    item.label ||
                    item.user_name ||
                    item.value ||
                    item.title;
                  if (name) return name;
                  // 如果是嵌套对象，尝试提取
                  if (
                    item.users &&
                    Array.isArray(item.users) &&
                    item.users.length > 0
                  ) {
                    return (
                      item.users[0].name ||
                      item.users[0].text ||
                      JSON.stringify(item)
                    );
                  }
                  return JSON.stringify(item);
                }
                return String(item);
              })
              .filter((s: string) => s && s.trim());
          } else if (typeof leaveStaffValue === 'object') {
            // 处理单个对象的情况
            const obj = leaveStaffValue as any;
            const name =
              obj.name ||
              obj.text ||
              obj.label ||
              obj.user_name ||
              obj.value ||
              obj.title;
            if (name) leaveStaffList = [name];
          }
        }
        this.logger.debug(
          `请假人员解析结果: ${JSON.stringify({ recordId: record.record_id, leaveStaffList })}`,
        );

        // 处理替班人员字段 - 使用 field_id fldZnstUS3（替班人员（请假表））
        let substituteStaffList: string[] = [];
        const substituteStaffValue =
          fields['fldZnstUS3'] || fields['替班人员（请假表）'];
        if (substituteStaffValue) {
          if (typeof substituteStaffValue === 'string') {
            substituteStaffList = substituteStaffValue
              .split(/[\s,，、]+/)
              .filter((s: string) => s.trim());
          } else if (Array.isArray(substituteStaffValue)) {
            // 处理对象数组，提取 name 或 text 字段
            substituteStaffList = substituteStaffValue
              .map((item: any) => {
                if (typeof item === 'string') {
                  return item;
                } else if (item && typeof item === 'object') {
                  // 飞书公式字段可能返回的对象格式
                  return (
                    item.name || item.text || item.label || JSON.stringify(item)
                  );
                }
                return String(item);
              })
              .filter((s: string) => s.trim());
          }
        }

        const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);
        leaveStaffList = approvedLeave.leaveStaff;
        substituteStaffList = approvedLeave.substituteStaff;
        dutyStaffActualList = approvedLeave.dutyStaff;

        // 处理实际值班人员字段 - 使用 field_id
        const actualDutyStaffRawValue =
          fields['fldZ2mFMdH'] || fields['实际值班人员'];
        let actualDutyStaffValue: string;
        if (typeof actualDutyStaffRawValue === 'string') {
          actualDutyStaffValue = actualDutyStaffRawValue;
        } else if (
          typeof actualDutyStaffRawValue === 'object' &&
          actualDutyStaffRawValue !== null
        ) {
          actualDutyStaffValue = JSON.stringify(actualDutyStaffRawValue);
        } else {
          actualDutyStaffValue = '';
        }

        // 备选：如果 "值班人员（实际）" 字段为空，尝试从 person_text 的 JSON 中提取人员姓名
        if (dutyStaffActualList.length === 0 && personTextValue) {
          try {
            const personData = JSON.parse(personTextValue);
            if (personData.users && Array.isArray(personData.users)) {
              dutyStaffActualList = personData.users
                .map((u: any) => u.name || '')
                .filter((name: string) => name);
            }
          } catch (e) {
            // JSON 解析失败，忽略
          }
        }

        this.logger.debug(`处理记录: ${record.record_id}`);

        // 调试：打印所有字段名，帮助排查字段名问题
        const fieldNames = Object.keys(fields);
        this.logger.debug(
          `记录 ${record.record_id} 的所有字段: ${fieldNames.join(', ')}`,
        );

        // 打印应急相关的所有可能字段
        const emergencyRelatedFields = fieldNames.filter(
          (f) => f.includes('应急') || f.includes('Emergency'),
        );
        if (
          emergencyRelatedFields.length > 0 ||
          (dateValue && dateValue.startsWith('2026-01-'))
        ) {
          this.logger.log(
            `记录 ${record.record_id} (${dateValue || '无日期'}) 的应急相关字段:`,
          );
          emergencyRelatedFields.forEach((f) => {
            const fieldValue = fields[f];
            const displayValue =
              typeof fieldValue === 'object'
                ? JSON.stringify(fieldValue)
                : fieldValue;
            this.logger.log(`  ${f}: ${displayValue}`);
          });
        }

        // 处理应急值班安排字段 - 支持多种可能的字段名
        let emergencyDutyScheduleValue = '';
        const possibleEmergencyFields = [
          '应急值班',
          '应急值班人员（排班）',
          '应急值班安排',
          '应急值班人员排班',
          '应急',
          'emergencyschedule',
          'emergency_schedule',
          '应急值班表',
        ];

        for (const fieldName of possibleEmergencyFields) {
          const fieldValue = fields[fieldName];
          if (fieldValue) {
            // 如果是数组类型，提取所有元素的text或name
            if (Array.isArray(fieldValue)) {
              const names = fieldValue
                .map((item) => {
                  if (typeof item === 'string') {
                    // 如果是字符串，可能格式为 [xxx]，需要去掉方括号
                    return item.replace(/^[\s*(.+?)[\s]*]$/, '$1');
                  }
                  return item?.text || item?.name || '';
                })
                .filter((name) => name.trim());
              emergencyDutyScheduleValue = names.join('、');
            } else if (typeof fieldValue === 'object') {
              // 如果是对象类型，尝试从对象中提取姓名或文本
              if (fieldValue.users && Array.isArray(fieldValue.users)) {
                emergencyDutyScheduleValue = fieldValue.users
                  .map((u) => u.name || u.text || u)
                  .join('、');
              } else if (fieldValue.text) {
                // 如果text格式为 [xxx]，需要去掉方括号
                emergencyDutyScheduleValue = fieldValue.text.replace(
                  /^[\s*(.+?)[\s]*]$/,
                  '$1',
                );
              } else if (fieldValue.name) {
                emergencyDutyScheduleValue = fieldValue.name;
              } else {
                // 最后尝试序列化整个对象
                emergencyDutyScheduleValue = JSON.stringify(fieldValue);
              }
            } else {
              emergencyDutyScheduleValue = fieldValue as string;
              // 如果是字符串格式为 [xxx]，需要去掉方括号
              if (
                emergencyDutyScheduleValue.includes('[') &&
                emergencyDutyScheduleValue.includes(']')
              ) {
                emergencyDutyScheduleValue = emergencyDutyScheduleValue.replace(
                  /^[\s*(.+?)[\s]*]$/,
                  '$1',
                );
              }
            }
            if (emergencyDutyScheduleValue) {
              this.logger.debug(
                `找到应急值班安排字段: ${fieldName} = ${emergencyDutyScheduleValue}`,
              );
              break;
            }
          }
        }

        // 处理备注字段 - 使用 field_id
        const remarkRawValue = fields['fldQBMKyrd'] || fields['备注'];
        let remarkValue: string;
        if (typeof remarkRawValue === 'string') {
          remarkValue = remarkRawValue;
        } else if (
          typeof remarkRawValue === 'object' &&
          remarkRawValue !== null
        ) {
          remarkValue = JSON.stringify(remarkRawValue);
        } else {
          remarkValue = '';
        }

        // 处理应急值班字段 - 使用 field_id
        const emergencyDutyRawValue =
          fields['fldduEXCmp'] || fields['应急值班'];
        let emergencyDutyValue: string;
        if (typeof emergencyDutyRawValue === 'string') {
          emergencyDutyValue = emergencyDutyRawValue;
        } else if (
          typeof emergencyDutyRawValue === 'object' &&
          emergencyDutyRawValue !== null
        ) {
          emergencyDutyValue = JSON.stringify(emergencyDutyRawValue);
        } else {
          emergencyDutyValue = '';
        }

        return {
          recordId: record.record_id,
          dutyCode: dutyCodeValue,
          scheduleDate: dateValue,
          code: codeValue,
          building: buildingValue,
          team: teamValue,
          shift: shiftValue,
          dutyStaffReference: dutyStaffReferenceList,
          dutyStaffActual: dutyStaffActualList,
          remark: remarkValue,
          emergencyDuty: emergencyDutyValue,
          emergencyDutySchedule: emergencyDutyScheduleValue,
          leaveStaff: leaveStaffList,
          substituteStaff: substituteStaffList,
          actualDutyStaff: actualDutyStaffValue,
          buildingText: buildingTextValue,
          teamText: teamTextValue,
          shiftText: shiftTextValue,
          personText: personTextValue,
        };
      });

      let inserted;
      try {
        // 先删除旧数据，避免主键冲突
        const recordIds = insertData.map((d) => d.recordId);
        this.logger.debug(`准备删除 ${recordIds.length} 条旧数据`);

        const deleted = await this.db
          .delete(appRoomScheduleEnhanced)
          .where(inArray(appRoomScheduleEnhanced.recordId, recordIds));

        this.logger.debug(`删除旧数据完成`);

        // 使用批量插入，提高性能
        inserted = [];
        try {
          const batchSize = 100; // 每批处理100条
          for (let i = 0; i < insertData.length; i += batchSize) {
            const batch = insertData.slice(i, i + batchSize);
            this.logger.debug(
              `正在批量插入第 ${Math.floor(i / batchSize) + 1} 批数据（${batch.length} 条）`,
            );

            const result = await this.db
              .insert(appRoomScheduleEnhanced)
              .values(batch)
              .returning();

            inserted.push(...result);
            totalInserted += result.length;
            this.logger.debug(
              `批量插入完成，累计插入 ${totalInserted}/${insertData.length} 条`,
            );
          }
        } catch (batchError) {
          const errorMsg =
            batchError instanceof Error
              ? batchError.message
              : String(batchError);
          this.logger.error(`批量插入失败，尝试逐条插入: ${errorMsg}`);

          // 如果批量插入失败，回退到逐条插入
          totalInserted = 0;
          inserted = [];
          for (let i = 0; i < insertData.length; i++) {
            try {
              const result = await this.db
                .insert(appRoomScheduleEnhanced)
                .values(insertData[i])
                .returning();

              inserted.push(...result);
              totalInserted++;

              if ((i + 1) % 50 === 0) {
                this.logger.debug(
                  `逐条插入进度: ${i + 1}/${insertData.length}`,
                );
              }
            } catch (singleInsertError) {
              totalFailed++;
              const errMsg =
                singleInsertError instanceof Error
                  ? singleInsertError.message
                  : String(singleInsertError);
              this.logger.error(
                `插入第 ${i + 1} 条数据失败 (${insertData[i].recordId}): ${errMsg}`,
              );
              failedRecords.push({
                recordId: insertData[i].recordId,
                error: errMsg,
              });
            }
          }
        }

        this.logger.debug(
          `成功插入 ${totalInserted} 条数据到数据库，失败 ${totalFailed} 条`,
        );

        // 同步成功后，更新最后同步时间
        await this.updateLastSyncTime();
      } catch (dbError) {
        const errorMsg =
          dbError instanceof Error ? dbError.message : String(dbError);
        this.logger.error(`数据库插入失败: ${errorMsg}`);
        // 检查是否是平台级错误
        if (
          errorMsg.includes('SQLFederationRule') ||
          errorMsg.includes('should have and only have one instance')
        ) {
          this.logger.error(
            '检测到平台级数据库错误，建议稍后重试或联系平台管理员',
          );
        }
        throw dbError;
      }

      // 同步成功后，更新最后同步时间
      await this.updateLastSyncTime();

      let message = `成功同步 ${totalInserted} 条数据到增强版排班表`;
      if (totalFailed > 0) {
        message += `，失败 ${totalFailed} 条`;
      }

      return {
        success: totalInserted > 0,
        total: totalInserted,
        failed: totalFailed,
        failedRecords,
        message,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`从飞书同步数据失败: ${errorMsg}`);

      // 如果是数据库错误，返回更详细的错误信息
      if (errorMsg.includes('duplicate key') || errorMsg.includes('unique')) {
        return {
          success: false,
          total: 0,
          inserted: 0,
          failed: totalFailed,
          failedRecords,
          message: '数据同步失败：存在重复记录，请检查飞书数据',
        };
      }

      throw error;
    } finally {
      // 释放同步锁
      this.isSyncing = false;
    }
  }

  /**
   * 更新最后同步时间
   */
  async updateLastSyncTime() {
    try {
      const now = new Date().toISOString();
      const configKey = 'last_sync_time';

      // 检查是否已存在配置
      const existing = await this.db
        .select()
        .from(appSyncConfig)
        .where(eq(appSyncConfig.configKey, configKey))
        .limit(1);

      if (existing.length > 0) {
        // 更新现有配置
        await this.db
          .update(appSyncConfig)
          .set({ configValue: now })
          .where(eq(appSyncConfig.id, existing[0].id));
        this.logger.log(`更新最后同步时间: ${now}`);
      } else {
        // 插入新配置
        await this.db.insert(appSyncConfig).values({
          configKey,
          configValue: now,
        });
        this.logger.log(`初始化最后同步时间: ${now}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`更新最后同步时间失败: ${errorMsg}`);
      // 不抛出错误，避免影响同步结果
    }
  }

  /**
   * 获取最后同步时间
   */
  async getLastSyncTime() {
    try {
      const configKey = 'last_sync_time';
      const result = await this.db
        .select()
        .from(appSyncConfig)
        .where(eq(appSyncConfig.configKey, configKey))
        .limit(1);

      if (result.length > 0 && result[0].configValue) {
        return result[0].configValue;
      }
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取最后同步时间失败: ${errorMsg}`);
      return null;
    }
  }

  /**
   * 获取指定年份的封网信息
   */
  async getTodayFocusChecklist(
    date?: string,
    forceRefresh = false,
  ): Promise<TodayFocusChecklistResponse> {
    const targetDate = this.normalizeFocusDate(date);
    const { start, end } = this.getShanghaiDateRange(targetDate);
    const year = Number(targetDate.slice(0, 4));
    const generatedAt = new Date().toISOString();

    const [
      sealingResult,
      changeResult,
      incidentResult,
      otherResult,
      customerMatterResult,
    ] = await Promise.all([
      this.getFocusSealings(year, start, end, forceRefresh),
      this.getFocusItems(
        this.focusChangeConfig,
        (item) => this.isKeyChangeItem(item, start, end),
        forceRefresh,
      ),
      this.getFocusItems(
        this.focusIncidentConfig,
        (item) => this.isMajorIncidentItem(item),
        forceRefresh,
      ),
      this.getFocusItems(
        this.focusOtherConfig,
        (item) => this.isItemOnDate(item, start, end),
        forceRefresh,
        40,
      ),
      this.getFocusItems(
        this.customerMatterConfig,
        (item) => this.isItemOnDate(item, start, end),
        forceRefresh,
        40,
      ),
    ]);
    const otherItems = this.mergeFocusItems(
      otherResult.items,
      customerMatterResult.items,
    );
    const otherStatus = this.mergeFocusStatuses([
      otherResult.status,
      customerMatterResult.status,
    ]);

    return {
      date: targetDate,
      generatedAt,
      sealings: sealingResult.items,
      keyChanges: changeResult.items,
      majorIncidents: incidentResult.items,
      others: otherItems,
      sectionStatus: {
        sealings: sealingResult.status,
        keyChanges: changeResult.status,
        majorIncidents: incidentResult.status,
        others: otherStatus,
      },
    };
  }

  private async getFocusSealings(
    year: number,
    start: Date,
    end: Date,
    forceRefresh = false,
  ): Promise<{
    items: TodayFocusChecklistResponse['sealings'];
    status: TodayFocusSectionStatus;
  }> {
    try {
      const exclusiveEnd = new Date(end.getTime() + 1);
      const data = await this.getYearlySealingInfo(year, forceRefresh);
      const items = data.sealings
        .filter((sealing) => {
          return isDateTimeRangeActiveInWindow(
            sealing.startDate,
            sealing.endDate,
            start,
            exclusiveEnd,
          );
        })
        .map((sealing) => ({
          id: sealing.id || sealing.bitableRecordId,
          name: sealing.sealingName,
          type: sealing.sealingType,
          code: sealing.sealingCode || null,
          autoNumber: sealing.autoNumber,
          startDate: sealing.startDate,
          endDate: sealing.endDate,
          recordUrl: this.buildBitableRecordUrl(
            this.sealingConfig,
            sealing.bitableRecordId || sealing.id,
          ),
        }));

      return {
        items,
        status: { configured: true },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`今日重点清单封网信息读取失败: ${message}`);
      return {
        items: [],
        status: { configured: false, message: '封网信息读取失败' },
      };
    }
  }

  private async getFocusItems(
    config: FocusBitableConfig,
    includeItem: (item: TodayFocusListItem) => boolean,
    forceRefresh = false,
    limit = 8,
  ): Promise<{
    items: TodayFocusListItem[];
    status: TodayFocusSectionStatus;
  }> {
    if (!this.hasBitableSourceConfig(config)) {
      return {
        items: [],
        status: { configured: false, message: '多维表待配置' },
      };
    }

    try {
      const appToken = await resolveBitableAppToken(this.httpService, config);
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: config.tableId,
        viewId: config.viewId || undefined,
        tableName: config.tableName,
        forceRefresh,
      });
      const items = records
        .map((record) => this.mapFocusBitableRecord(record, config))
        .filter((item): item is TodayFocusListItem => Boolean(item))
        .filter(includeItem)
        .slice(0, Math.max(1, limit));

      return {
        items,
        status: { configured: true },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${config.tableName}读取失败: ${message}`);
      return {
        items: [],
        status: { configured: true, message: '多维表读取失败' },
      };
    }
  }

  private hasBitableSourceConfig(config: FocusBitableConfig): boolean {
    return Boolean(config.tableId && (config.appToken || config.wikiToken));
  }

  private getConstructionCrewLedgerConfig(): FocusBitableConfig {
    if (this.hasBitableSourceConfig(this.constructionCrewLedgerConfig)) {
      return this.constructionCrewLedgerConfig;
    }
    if (!this.hasBitableSourceConfig(this.constructionOverviewConfig)) {
      return this.constructionCrewLedgerConfig;
    }

    return {
      ...this.constructionOverviewConfig,
      tableId: 'tblgJT6SXjjw7iYN',
      viewId: '',
      tableName: '施工人员台账',
      sourceUrl: '',
    };
  }

  private mapConstructionChangeOrderCandidate(
    record: BitableRecordItem,
  ): ConstructionChangeOrderCandidate | null {
    const fields = record.fields || {};
    const id = getRecordId(record);
    const title = extractDisplayText(
      pickField(fields, ['变更编码&描述', '变更简述', '变更名称', '变更内容']),
    );
    const description =
      extractDisplayText(
        pickField(fields, ['变更简述', '变更内容', '变更标题']),
      ) || null;

    if (!id || !title) {
      return null;
    }

    return {
      id,
      title,
      description,
      workType: this.extractReadableBitableText(
        pickField(fields, ['作业类型']),
      ),
      progress: this.extractReadableBitableText(
        pickField(fields, ['变更进度']),
      ),
      status: this.extractReadableBitableText(
        pickField(fields, [
          '开始/结束状态打标',
          '变更情况（变更完成或取消后填写）',
        ]),
      ),
      buildings: this.extractReadableBitableValues(
        pickField(fields, ['变更楼栋', '楼栋']),
      ),
      specialties: this.extractReadableBitableValues(
        pickField(fields, ['专业']),
      ),
      level: this.extractReadableBitableText(
        pickField(fields, ['变更等级（阿里）', '变更等级', '风险等级']),
      ),
      planStartTime: extractDateTimeIso(
        pickField(fields, [
          '计划开始日期（阿里）',
          '计划开始日期',
          '计划开始时间',
        ]),
      ),
      planEndTime: extractDateTimeIso(
        pickField(fields, [
          '计划结束日期（阿里）',
          '计划结束日期',
          '计划结束时间',
        ]),
      ),
      submitter:
        extractDisplayText(
          pickField(fields, ['变更提交人', '提交人', '创建人']),
        ) || null,
      risk:
        extractDisplayText(
          pickField(fields, ['变更重要风险点（简述）', '重要风险点', '风险点']),
        ) || null,
    };
  }

  private extractReadableBitableText(field: unknown): string | null {
    const text = extractDisplayText(field);
    if (!text || /^opt[A-Za-z0-9_-]+$/.test(text)) {
      return null;
    }
    return text;
  }

  private extractReadableBitableValues(field: unknown): string[] {
    return extractDisplayValues(field).filter(
      (value) => !/^opt[A-Za-z0-9_-]+$/.test(value),
    );
  }

  private matchesConstructionChangeOrderQuery(
    item: ConstructionChangeOrderCandidate,
    normalizedQuery: string,
  ): boolean {
    if (!normalizedQuery) {
      return true;
    }
    const haystack = [
      item.title,
      item.description,
      item.workType,
      item.progress,
      item.status,
      item.level,
      item.submitter,
      item.risk,
      item.buildings.join(' '),
      item.specialties.join(' '),
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('zh-CN');

    return haystack.includes(normalizedQuery.toLocaleLowerCase('zh-CN'));
  }

  private getConstructionChangeOrderSortTime(
    item: ConstructionChangeOrderCandidate,
  ): number {
    const planned = item.planStartTime ? Date.parse(item.planStartTime) : NaN;
    return Number.isFinite(planned) ? planned : 0;
  }

  private async resolveConstructionChangeLinkRecordId(
    request: ConstructionApplicationCreateRequest,
    overviewAppToken: string,
  ): Promise<string | null> {
    if (String(request.relatedWorkType || '').trim() !== '变更') {
      return null;
    }

    const externalRecordId = String(request.changeOrderRecordId || '').trim();
    if (!externalRecordId) {
      throw new Error('关联作业类型为变更时，请选择对应变更单');
    }
    if (!this.constructionChangeLinkTableId) {
      throw new Error('施工变更关联底表待配置');
    }

    const records = await fetchBitableRecords(this.httpService, {
      appToken: overviewAppToken,
      tableId: this.constructionChangeLinkTableId,
      tableName: this.constructionChangeLinkTableName,
    });
    const matched = records.find((record) => {
      const localRecordId = getRecordId(record);
      if (localRecordId === externalRecordId) {
        return true;
      }
      const sourceId = extractDisplayText(
        pickField(record.fields || {}, ['SourceID', 'sourceId', '源记录ID']),
      );
      return (
        sourceId === externalRecordId ||
        sourceId.includes(`:${externalRecordId}:`) ||
        sourceId.includes(externalRecordId)
      );
    });
    const localRecordId = matched ? getRecordId(matched) : '';

    if (!localRecordId) {
      throw new Error(
        '未在施工变更关联底表中找到对应变更单，请确认变更数据已同步',
      );
    }

    return localRecordId;
  }

  private mapConstructionStaffCandidate(
    record: BitableRecordItem,
  ): ConstructionStaffCandidate | null {
    const fields = record.fields || {};
    const userField = pickField(fields, ['员工姓名', '人员']);
    const id = this.extractFirstUserIdFromBitableField(userField);
    const name =
      extractDisplayText(
        pickField(fields, ['姓名', '员工姓名', '人员', '人员（文本）']),
      ) ||
      this.extractFirstUserNameFromBitableField(userField) ||
      id;

    if (!id || !name) {
      return null;
    }

    return {
      id,
      name,
      recordId: getRecordId(record),
      employeeNo:
        extractDisplayText(pickField(fields, ['员工工号', '工号', '编码'])) ||
        null,
      phone:
        extractDisplayText(
          pickField(fields, [
            '手机号',
            '手机号码',
            '联系电话',
            '联系方式',
            '电话',
          ]),
        ) || null,
      position:
        extractDisplayText(pickField(fields, ['岗位', '职位', '楼岗位'])) ||
        null,
      buildingSpecialties: extractDisplayValues(
        pickField(fields, ['机楼/专业', '楼栋/专业', '楼栋', '机楼']),
      ),
      team:
        extractDisplayText(pickField(fields, ['班组', '班次', '班别'])) || null,
      shift: extractDisplayText(pickField(fields, ['班次', '班别'])) || null,
      onDutyToday:
        extractDisplayText(pickField(fields, ['今日是否上班'])) || null,
    };
  }

  private matchesConstructionStaffQuery(
    item: ConstructionStaffCandidate,
    normalizedQuery: string,
  ): boolean {
    if (!normalizedQuery) {
      return true;
    }
    const haystack = [
      item.name,
      item.employeeNo,
      item.phone,
      item.position,
      item.buildingSpecialties.join(' '),
      item.team,
      item.shift,
      item.onDutyToday,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('zh-CN');

    return haystack.includes(normalizedQuery.toLocaleLowerCase('zh-CN'));
  }

  private extractFirstUserIdFromBitableField(field: unknown): string | null {
    if (!field) {
      return null;
    }
    if (Array.isArray(field)) {
      const first = field[0];
      if (typeof first === 'object' && first !== null && 'id' in first) {
        return String((first as { id: unknown }).id || '').trim() || null;
      }
      if (typeof first === 'string') {
        return first.trim() || null;
      }
      return null;
    }
    if (typeof field === 'object' && field !== null && 'id' in field) {
      return String((field as { id: unknown }).id || '').trim() || null;
    }
    if (typeof field === 'string') {
      return field.trim() || null;
    }
    return null;
  }

  private extractFirstUserNameFromBitableField(field: unknown): string | null {
    if (!field) {
      return null;
    }
    if (Array.isArray(field)) {
      const first = field[0];
      if (typeof first === 'object' && first !== null && 'name' in first) {
        return String((first as { name: unknown }).name || '').trim() || null;
      }
    }
    if (typeof field === 'object' && field !== null && 'name' in field) {
      return String((field as { name: unknown }).name || '').trim() || null;
    }
    return null;
  }

  private mergeFocusItems(
    ...groups: TodayFocusListItem[][]
  ): TodayFocusListItem[] {
    const seen = new Set<string>();
    const merged: TodayFocusListItem[] = [];

    groups.flat().forEach((item) => {
      const key = `${item.source || 'unknown'}:${item.id}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(item);
    });

    return merged
      .sort(
        (a, b) => this.getFocusItemSortTime(b) - this.getFocusItemSortTime(a),
      )
      .slice(0, 8);
  }

  private getFocusItemSortTime(item: TodayFocusListItem): number {
    const updatedAt = this.parseFocusDate(item.updatedAt)?.getTime();
    if (updatedAt) {
      return updatedAt;
    }

    return (
      this.parseFocusDate(item.startTime)?.getTime() ||
      this.parseFocusDate(item.endTime)?.getTime() ||
      0
    );
  }

  private mergeFocusStatuses(
    statuses: TodayFocusSectionStatus[],
  ): TodayFocusSectionStatus {
    if (statuses.some((status) => status.configured && !status.message)) {
      return { configured: true };
    }

    const configured = statuses.some((status) => status.configured);
    const messages = Array.from(
      new Set(
        statuses
          .map((status) => status.message?.trim())
          .filter((message): message is string => Boolean(message)),
      ),
    );

    return {
      configured,
      ...(messages.length > 0 ? { message: messages.join('; ') } : {}),
    };
  }

  private mapFocusBitableRecord(
    record: BitableRecordItem,
    config: FocusBitableConfig,
  ): TodayFocusListItem | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const title = this.sanitizeTodayFocusText(
      extractDisplayText(
        pickField(fields, [
          '变更内容',
          '变更标题',
          '变更主题',
          '事件标题',
          '事件内容',
          '内容',
          '事项',
          '标题',
          '主题',
          '名称',
        ]),
      ),
    );

    if (!recordId || !title) {
      return null;
    }

    const level =
      extractDisplayText(
        pickField(fields, [
          '事件等级',
          '变更等级',
          '影响等级',
          '等级',
          '级别',
          'I级别',
          '优先级',
        ]),
      ) || null;
    const riskLevel =
      this.normalizeRiskLevelText(
        extractDisplayText(
          pickField(fields, [
            '阿里-变更等级',
            '阿里变更等级',
            '阿里等级',
            '阿里风险等级',
            '阿里-风险等级',
            '风险等级',
            '风险级别',
            '变更风险',
            '风险',
            '风险类型',
          ]),
        ),
      ) || null;
    const status =
      extractDisplayText(
        pickField(fields, [
          '最终状态',
          '状态',
          '当前状态',
          '处理状态',
          '闭环状态',
          '是否闭环',
          '流程状态',
        ]),
      ) || null;
    const startTime = this.extractFocusDateTime(fields, [
      '计划开始时间',
      '开始时间',
      '变更开始时间',
      '实施开始时间',
      '发生时间',
      '创建时间',
      '日期',
      '时间',
    ]);
    const endTime = this.extractFocusDateTime(fields, [
      '计划结束日期',
      '计划结束时间',
      '计划完成日期',
      '计划完成时间',
      '计划截止日期',
      '计划截止时间',
      '预计结束日期',
      '预计结束时间',
      '预计完成日期',
      '预计完成时间',
      '变更计划结束时间',
      '结束时间',
      '变更结束时间',
      '实施结束时间',
      '截止时间',
      '预计恢复时间',
      '闭环时间',
    ]);
    const todayFlag =
      extractDisplayText(
        pickField(fields, [
          '今日是否进行',
          '是否今日进行',
          '今日进行',
          '当天是否进行',
          '今日是否执行',
          '是否今日执行',
        ]),
      ) || null;

    const baseTags = extractDisplayValues(
      pickField(fields, [
        '专业（提取）',
        '专业-提取',
        '专业-使用',
        '专业',
        '楼栋',
        '机楼',
        '影响范围',
        '分类',
        '标签',
      ]),
    ).filter(
      (value): value is string =>
        Boolean(value?.trim()) &&
        !this.isRawBitableOptionToken(value) &&
        value !== level &&
        value !== riskLevel,
    );

    return {
      id: recordId,
      title,
      summary:
        this.sanitizeTodayFocusText(
          extractDisplayText(
            pickField(fields, [
              '变更说明',
              '事件描述',
              '处理进展',
              '跟进事项',
              '影响范围',
              '描述',
              '备注',
            ]),
          ),
        ) || null,
      level,
      riskLevel,
      status,
      owner:
        extractDisplayText(
          pickField(fields, [
            '负责人',
            '跟进人',
            '处理人',
            '责任人',
            '值班长',
            'Owner',
          ]),
        ) || null,
      startTime,
      endTime,
      todayFlag,
      updatedAt: extractDateTimeIso(record.last_modified_time),
      source: config.tableName,
      recordUrl: this.buildBitableRecordUrl(config, recordId),
      tags: Array.from(new Set(baseTags)).slice(0, 4),
    };
  }

  private sanitizeTodayFocusText(value: string): string {
    return value
      .replace(/需要/g, '')
      .replace(/^\s*\d+[、.．]\s*/, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,，、;；:：]+|[\s,，、;；:：]+$/g, '')
      .trim();
  }

  private buildBitableRecordUrl(
    config: FocusBitableConfig,
    recordId: string,
  ): string | null {
    if (!config.sourceUrl || !recordId) {
      return null;
    }

    try {
      const url = new URL(config.sourceUrl);
      if (config.tableId && !url.searchParams.get('table')) {
        url.searchParams.set('table', config.tableId);
      }
      if (config.viewId && !url.searchParams.get('view')) {
        url.searchParams.set('view', config.viewId);
      }
      url.searchParams.set('record', recordId);
      return url.toString();
    } catch {
      return null;
    }
  }

  private extractFocusDateTime(
    fields: Record<string, unknown>,
    names: string[],
  ): string | null {
    const value = pickField(fields, names);
    return extractDateTimeIso(value) || extractDateValue(value);
  }

  private isKeyChangeItem(
    item: TodayFocusListItem,
    dayStart: Date,
    dayEnd: Date,
  ): boolean {
    const signal = [
      item.level,
      item.riskLevel,
      item.title,
      item.summary,
      ...item.tags,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      this.isItemOnDate(item, dayStart, dayEnd) &&
      (this.isI2OrAbove(signal) || this.isMediumRiskOrAbove(signal))
    );
  }

  private isMajorIncidentItem(item: TodayFocusListItem): boolean {
    const levelSignal = [item.level, item.riskLevel, ...item.tags]
      .filter(Boolean)
      .join(' ');

    return (
      this.isRepairingStatus(item.status) &&
      this.isMajorIncidentLevel(levelSignal)
    );
  }

  private isItemOnDate(
    item: TodayFocusListItem,
    dayStart: Date,
    dayEnd: Date,
  ): boolean {
    if (this.isTodayFlagEnabled(item.todayFlag)) {
      return true;
    }

    const start = this.parseFocusDate(item.startTime);
    const end = this.parseFocusDate(item.endTime) || start;

    if (!start && !end) {
      return true;
    }

    if (start && end) {
      return start <= dayEnd && end >= dayStart;
    }

    const target = start || end;
    return Boolean(target && target >= dayStart && target <= dayEnd);
  }

  private isI2OrAbove(value: string): boolean {
    const text = value.toUpperCase().replace(/\s+/g, '');
    return /(I|L|P)[12]\b/.test(text) || /[ⅠⅡ]/.test(text);
  }

  private isMediumRiskOrAbove(value: string): boolean {
    if (
      /(中风险|中等风险|较高风险|高风险|重大风险|重大|严重|高危)/.test(value)
    ) {
      return true;
    }

    const tokens = value
      .split(/[\s,，、;；|/]+/)
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean);

    return tokens.some((token) =>
      [
        '中',
        '中等',
        '中级',
        '较高',
        '高',
        '重大',
        '严重',
        '高危',
        'MEDIUM',
        'HIGH',
        'CRITICAL',
      ].includes(token),
    );
  }

  private isTodayFlagEnabled(value: string | null | undefined): boolean {
    return /^(是|Y|YES|TRUE|1)$/i.test((value || '').trim());
  }

  private normalizeRiskLevelText(value: string): string {
    const text = value.trim();
    const aliases: Record<string, string> = {
      中: '中风险',
      中等: '中等风险',
      中级: '中风险',
      较高: '较高风险',
      高: '高风险',
      重大: '重大风险',
    };
    return aliases[text] || text;
  }

  private isRawBitableOptionToken(value: string): boolean {
    return /^opt[a-zA-Z0-9]+$/.test(value.trim());
  }

  private isMajorIncidentLevel(value: string): boolean {
    const text = value.toUpperCase().replace(/\s+/g, '');
    return (
      /I[12](?![A-Z0-9])/.test(text) ||
      /P(?:[12])?(?![A-Z0-9])/.test(text) ||
      /[ⅠⅡ]/.test(text)
    );
  }

  private isRepairingStatus(status: string | null): boolean {
    return /检修中/.test(status || '');
  }

  private isUnclosedStatus(status: string | null): boolean {
    const text = status || '';
    if (!text) {
      return true;
    }
    if (
      /(未闭环|未关闭|未完成|处理中|进行中|待处理|待跟进|open|pending|processing)/i.test(
        text,
      )
    ) {
      return true;
    }
    return !/(已闭环|已关闭|已完成|关闭|完成|closed|resolved|done)/i.test(text);
  }

  private parseFocusDate(value: string | null): Date | null {
    if (!value) {
      return null;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00+08:00`)
      : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private normalizeFocusDate(date?: string): string {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }

    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  private getShanghaiDateRange(date: string): { start: Date; end: Date } {
    const start = new Date(`${date}T00:00:00+08:00`);
    return {
      start,
      end: new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1),
    };
  }

  async getYearlyChangeInfo(
    year: number,
    forceRefresh = false,
  ): Promise<YearlyChangeInfoResponse> {
    try {
      if (!Number.isFinite(year)) {
        return { changes: [], total: 0, keyTotal: 0 };
      }
      if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
        return { changes: [], total: 0, keyTotal: 0 };
      }

      return this.getYearlyChangeInfoFromFeishu(year, forceRefresh);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取年度计划变更信息失败: ${errorMsg}`);
      throw error;
    }
  }

  async updateChangeScheduleAdjustment(
    request: ChangeScheduleAdjustmentRequest,
    accessRole: AccessRole = 'guest',
  ): Promise<ChangeScheduleAdjustmentResponse> {
    if (
      hasOwnRuntimeProperty(request, 'clearAdjustment') &&
      typeof request.clearAdjustment !== 'boolean'
    ) {
      throw new BadRequestException('clearAdjustment 必须为布尔值');
    }
    const clearAdjustment = request?.clearAdjustment === true;
    if (clearAdjustment === true && accessRole !== 'admin') {
      throw new ForbiddenException('仅管理员可以撤销变更计划调整');
    }
    const recordId = request?.recordId?.trim();
    if (!recordId) {
      throw new Error('缺少变更记录 ID');
    }

    const plannedDelayStartField = '计划延迟开始日期';
    const plannedDelayEndField = '计划延迟结束日期';
    const fields: Record<string, unknown> = {};
    let plannedDelayStartMs: number | null = null;
    let plannedDelayEndMs: number | null = null;

    if (clearAdjustment === true) {
      fields[plannedDelayStartField] = null;
      fields[plannedDelayEndField] = null;
    } else {
      const startValue = request.plannedDelayStartDate?.trim();
      const endValue = request.plannedDelayEndDate?.trim();
      if (startValue) {
        plannedDelayStartMs = this.parseShanghaiDateTimeMs(
          startValue,
          '延期开始时间',
        );
        fields[plannedDelayStartField] = plannedDelayStartMs;
      }
      if (endValue) {
        plannedDelayEndMs = this.parseShanghaiDateTimeMs(
          endValue,
          '延期结束时间',
        );
        fields[plannedDelayEndField] = plannedDelayEndMs;
      }
      if (
        plannedDelayStartMs !== null &&
        plannedDelayEndMs !== null &&
        plannedDelayEndMs < plannedDelayStartMs
      ) {
        throw new Error('延期结束不能早于延期开始');
      }
    }

    if (Object.keys(fields).length === 0) {
      return {
        success: true,
        recordId,
        plannedDelayStartDate: null,
        plannedDelayEndDate: null,
        message: '已确认，封网不影响变更执行',
      };
    }

    if (!this.hasBitableSourceConfig(this.calendarChangeConfig)) {
      throw new Error('变更信息多维表未配置');
    }

    const appToken = await resolveBitableAppToken(
      this.httpService,
      this.calendarChangeConfig,
    );
    assertBitableTableConfig(
      this.calendarChangeConfig.tableName,
      appToken,
      this.calendarChangeConfig.tableId,
    );
    const tenantAccessToken = await this.getFeishuTenantAccessToken();
    await this.updateBitableRecordFields(
      appToken,
      this.calendarChangeConfig.tableId,
      this.calendarChangeConfig.tableName,
      recordId,
      fields,
      tenantAccessToken,
    );
    invalidateBitableRecordCache({
      appToken,
      tableId: this.calendarChangeConfig.tableId,
    });

    return {
      success: true,
      recordId,
      plannedDelayStartDate:
        clearAdjustment === true || plannedDelayStartMs === null
          ? null
          : new Date(plannedDelayStartMs).toISOString(),
      plannedDelayEndDate:
        clearAdjustment === true || plannedDelayEndMs === null
          ? null
          : new Date(plannedDelayEndMs).toISOString(),
      message:
        clearAdjustment === true ? '变更计划调整已撤销' : '变更计划调整已提交',
    };
  }

  async getYearlySealingInfo(
    year: number,
    forceRefresh = false,
  ): Promise<YearlySealingInfoResponse> {
    try {
      if (this.hasBitableSourceConfig(this.sealingConfig)) {
        return this.getYearlySealingInfoFromFeishu(year, forceRefresh);
      }

      const startOfYear = new Date(year, 0, 1);
      const startOfNextYear = new Date(year + 1, 0, 1);

      const sealings = await this.db
        .select({
          id: appSealingInfo.id,
          bitableRecordId: appSealingInfo.bitableRecordId,
          sealingCode: appSealingInfo.sealingCode,
          sealingName: appSealingInfo.sealingName,
          startDate: appSealingInfo.startDate,
          endDate: appSealingInfo.endDate,
          sealingType: appSealingInfo.sealingType,
          autoNumber: appSealingInfo.autoNumber,
          isToday: appSealingInfo.isToday,
          createdAt: appSealingInfo.createdAt,
          updatedAt: appSealingInfo.updatedAt,
        })
        .from(appSealingInfo)
        .where(
          and(
            lt(appSealingInfo.startDate, startOfNextYear),
            gt(appSealingInfo.endDate, startOfYear),
          ),
        )
        .orderBy(appSealingInfo.startDate);

      this.logger.log(`获取 ${year} 年封网信息: ${sealings.length} 条`);

      return {
        sealings: sealings.map((s) => ({
          ...s,
          startDate:
            s.startDate instanceof Date
              ? s.startDate.toISOString()
              : s.startDate,
          endDate:
            s.endDate instanceof Date ? s.endDate.toISOString() : s.endDate,
          createdAt:
            s.createdAt instanceof Date
              ? s.createdAt.toISOString()
              : s.createdAt,
          updatedAt:
            s.updatedAt instanceof Date
              ? s.updatedAt.toISOString()
              : s.updatedAt,
        })),
        total: sealings.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取年度封网信息失败: ${errorMsg}`);
      throw error;
    }
  }
}
