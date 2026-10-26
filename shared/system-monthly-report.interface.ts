export const SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES = 150 * 1024 * 1024;

export type SystemMonthlyReportStage = 'initial' | 'recheck' | 'final';
export type SystemMonthlyReportSubmissionOperation = 'create' | 'replace';
export type SystemMonthlyReportReviewRound = 'initial' | 'recheck';

export function buildSystemMonthlyReportVersionedFileName(
  room: string,
  reportYear: number,
  reportMonth: number,
  stage: SystemMonthlyReportStage,
  originalFileName: string,
): string {
  const extension =
    /\.[a-zA-Z0-9]{1,8}$/u.exec(originalFileName.trim())?.[0]?.toLowerCase() ||
    '.xlsx';
  const version =
    stage === 'initial' ? '初版' : stage === 'recheck' ? '复审版' : '终版';
  const safeRoom = room
    .normalize('NFKC')
    .replace(/[\r\n\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .trim();
  return `${safeRoom}-${reportYear}年${String(reportMonth).padStart(2, '0')}月体系月报-${version}${extension}`;
}
export type SystemMonthlyReportModuleKey =
  | 'event'
  | 'change'
  | 'maintenance'
  | 'drill'
  | 'other';

export type SystemMonthlyReportRoomStatus =
  | 'initial_pending'
  | 'initial_review'
  | 'recheck_pending'
  | 'recheck_review'
  | 'final_pending'
  | 'completed';

export type SystemMonthlyReportStepState = 'completed' | 'current' | 'pending';

export type SystemMonthlyReportStepKey =
  | 'initial_submit'
  | 'initial_review'
  | 'recheck_submit'
  | 'recheck_review'
  | 'final_submit';

export type SystemMonthlyReportArchiveStatus =
  | 'pending'
  | 'syncing'
  | 'archived'
  | 'error';

export interface SystemMonthlyReportArchiveRetryResponse {
  id: string;
  status: SystemMonthlyReportArchiveStatus;
}

export interface SystemMonthlyReportPerson {
  openId: string;
  name: string;
}

export interface SystemMonthlyReportIdentityOption {
  id: string;
  name: string;
}

export interface SystemMonthlyReportIdentityDirectoryResponse {
  identities: SystemMonthlyReportIdentityOption[];
}

export interface SystemMonthlyReportIdentitySessionResponse {
  selected: boolean;
  mode: 'privileged' | 'person' | 'none';
  person: SystemMonthlyReportIdentityOption | null;
  expiresAt: number | null;
}

export interface SystemMonthlyReportViewer {
  mode: 'privileged' | 'person';
  person: SystemMonthlyReportIdentityOption | null;
  canPackage: boolean;
  canForceRefresh: boolean;
}

export interface SystemMonthlyReportRoomAccess {
  canSubmit: boolean;
  canDownload: boolean;
  managed: boolean;
  reviewRounds: SystemMonthlyReportReviewRound[];
}

export interface SystemMonthlyReportStep {
  key: SystemMonthlyReportStepKey;
  label: string;
  state: SystemMonthlyReportStepState;
  date: string | null;
}

export interface SystemMonthlyReportMilestone {
  key: SystemMonthlyReportStepKey;
  label: string;
  workdayIndex: number;
  date: string | null;
  calendarSupported: boolean;
}

export interface SystemMonthlyReportRoom {
  recordId: string;
  code: string;
  room: string;
  status: SystemMonthlyReportRoomStatus;
  statusLabel: string;
  currentOwnerRole: string;
  currentOwnerName: string;
  latestAt: string | null;
  submitters: SystemMonthlyReportPerson[];
  leaders: SystemMonthlyReportPerson[];
  leader: SystemMonthlyReportPerson | null;
  initialReviewer: SystemMonthlyReportPerson | null;
  recheckReviewer: SystemMonthlyReportPerson | null;
  issueSummary: {
    initial: string;
    recheck: string;
  };
  steps: SystemMonthlyReportStep[];
  access?: SystemMonthlyReportRoomAccess;
}

export interface SystemMonthlyReportScheduleItem {
  recordId: string;
  year: number;
  month: number;
  round: SystemMonthlyReportReviewRound;
  room: string;
  reviewerRoom: string;
  reviewer: SystemMonthlyReportPerson;
  reviewDate: string | null;
}

export interface SystemMonthlyReportStandard {
  recordId: string;
  key: 'event' | 'change' | 'maintenance' | 'drill' | 'risk';
  module: string;
  weight: number;
  rule: string;
  regionalRule: string;
}

export interface SystemMonthlyReportHistoryItem {
  recordId: string;
  year: number;
  month: number;
  room: string;
  createdAt: string | null;
  finalSubmittedAt: string | null;
  initialAttachmentCount: number;
  recheckAttachmentCount: number;
  finalAttachmentCount: number;
  archiveStatus: SystemMonthlyReportArchiveStatus;
  archivedAttachmentCount: number;
  attachments: SystemMonthlyReportArchivedAttachment[];
}

export interface SystemMonthlyReportArchivedAttachment {
  id: string;
  name: string;
  size: number;
  status: SystemMonthlyReportArchiveStatus;
  retryable: boolean;
  message: string;
}

export interface SystemMonthlyReportSpreadsheetPreviewSheet {
  name: string;
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
}

export type SystemMonthlyReportArchivePreview =
  | {
      kind: 'pdf';
      name: string;
      url: string;
      expiresInSeconds: number;
    }
  | {
      kind: 'spreadsheet';
      name: string;
      sheets: SystemMonthlyReportSpreadsheetPreviewSheet[];
      truncated: boolean;
    };

export interface SystemMonthlyReportStageProgressDetail {
  completed: boolean;
  completedAt: string | null;
}

export interface SystemMonthlyReportMonthlyRoomProgress {
  room: string;
  stages: Record<
    SystemMonthlyReportStepKey,
    SystemMonthlyReportStageProgressDetail
  >;
}

export interface SystemMonthlyReportReviewIssue {
  key: SystemMonthlyReportModuleKey;
  label: string;
  description: string;
}

export interface SystemMonthlyReportReviewOpinion {
  recordId: string;
  year: number;
  month: number;
  room: string;
  round: SystemMonthlyReportReviewRound;
  reviewer: SystemMonthlyReportPerson | null;
  submittedAt: string;
  summary: string;
  conclusion: 'passed' | 'has_issues';
  issues: SystemMonthlyReportReviewIssue[];
  images: SystemMonthlyReportArchivedAttachment[];
}

export interface SystemMonthlyReportMonthlySnapshot {
  year: number;
  month: number;
  totalRooms: number;
  completedRooms: number;
  stageCompletedRooms: Record<SystemMonthlyReportStepKey, number>;
  rooms: SystemMonthlyReportMonthlyRoomProgress[];
  milestones: SystemMonthlyReportMilestone[];
}

export interface SystemMonthlyReportDashboard {
  generatedAt: string;
  sourceUpdatedAt: string;
  stale: boolean;
  period: {
    year: number;
    month: number;
    label: string;
    reminderDate: string | null;
    initialDueDate: string | null;
    recheckDueDate: string | null;
    finalDueDate: string | null;
    editable: boolean;
    editableUntil: string;
    calendarSupported: boolean;
    milestones: SystemMonthlyReportMilestone[];
  };
  summary: {
    totalRooms: number;
    completedRooms: number;
    inReviewRooms: number;
    pendingSubmissionRooms: number;
    overdueRooms: number;
  };
  rooms: SystemMonthlyReportRoom[];
  schedule: SystemMonthlyReportScheduleItem[];
  standards: SystemMonthlyReportStandard[];
  history: SystemMonthlyReportHistoryItem[];
  monthlySnapshots: SystemMonthlyReportMonthlySnapshot[];
  reviewOpinions: SystemMonthlyReportReviewOpinion[];
  warnings: string[];
  viewer?: SystemMonthlyReportViewer;
}

export type SystemMonthlyReportTaskStatus =
  | 'accepted'
  | 'syncing'
  | 'success'
  | 'error'
  | 'uncertain';

export interface SystemMonthlyReportTask {
  id: string;
  clientMutationId: string;
  action: 'submit_stage' | 'delete_stage' | 'submit_review';
  targetRecordId: string;
  status: SystemMonthlyReportTaskStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  feishuRecordId?: string;
  failedStep?: 'upload' | 'record' | 'readback';
  retryable?: boolean;
  sync?: {
    feishu: SystemMonthlyReportSyncBranch;
    cos: SystemMonthlyReportSyncBranch;
  };
}

export interface SystemMonthlyReportSyncBranch {
  status: 'pending' | 'syncing' | 'success' | 'error';
  message: string;
  completedAt?: string;
}

export interface SystemMonthlyReportAcceptedResponse {
  accepted: true;
  task: SystemMonthlyReportTask;
}

export interface SystemMonthlyReportSubmissionRequest {
  clientMutationId: string;
  currentRecordId: string;
  room: string;
  stage: SystemMonthlyReportStage;
  reportYear: number;
  reportMonth: number;
  versionedFileName: string;
  operation?: SystemMonthlyReportSubmissionOperation;
}

export interface SystemMonthlyReportSubmissionDeletionRequest {
  clientMutationId: string;
  currentRecordId: string;
  room: string;
  stage: SystemMonthlyReportStage;
  reportYear: number;
  reportMonth: number;
}

export interface SystemMonthlyReportReviewModuleInput {
  hasIssue: boolean;
  description: string;
}

export interface SystemMonthlyReportReviewRequest {
  clientMutationId: string;
  currentRecordId: string;
  room: string;
  round: SystemMonthlyReportReviewRound;
  completed: boolean;
  modules: Record<
    SystemMonthlyReportModuleKey,
    SystemMonthlyReportReviewModuleInput
  >;
}

export type SystemMonthlyReportPackageStatus =
  | 'accepted'
  | 'packaging'
  | 'uploading'
  | 'notifying'
  | 'success'
  | 'partial'
  | 'error';

export interface SystemMonthlyReportPackageRequest {
  clientMutationId: string;
  year: number;
  month: number;
}

export interface SystemMonthlyReportPackageTask {
  id: string;
  clientMutationId: string;
  year: number;
  month: number;
  status: SystemMonthlyReportPackageStatus;
  message: string;
  fileName: string;
  missingRooms: string[];
  packageReady: boolean;
  notified: boolean;
  notificationError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
