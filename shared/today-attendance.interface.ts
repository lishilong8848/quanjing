export type TodayAttendanceDirection = 'OnDuty' | 'OffDuty';
export type TodayAttendanceStatus = 'normal' | 'anomaly';
export type TodayAttendanceDisplayScope = 'today' | 'previous-day';
export type TodayAttendanceSourceStatus =
  | 'pending'
  | 'not-run'
  | 'running'
  | 'failed'
  | 'fresh'
  | 'stale';

export type TodayAttendanceFailureScope = 'core' | 'personal-delivery';
export type TodayAttendanceExternalSyncState = 'syncing' | 'failed';

export interface TodayAttendanceRunStatus {
  state: 'waiting' | 'not-run' | 'running' | 'failed' | 'completed';
  scheduledAt: string;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  attemptCount?: number;
  maxAttempts?: number;
  completedAt?: string;
  failureReason?: string;
  failureScope?: TodayAttendanceFailureScope;
  archiveSyncState?: TodayAttendanceExternalSyncState;
  archiveSyncFailureReason?: string;
  correctionSyncState?: TodayAttendanceExternalSyncState;
  correctionSyncFailureReason?: string;
  nextRetryAt?: string;
  retryCutoffAt?: string;
  finalFailure?: boolean;
}

export type TodayAttendanceTask =
  | 'morning-on-duty-reminder'
  | 'morning-off-duty-check'
  | 'evening-on-duty-reminder'
  | 'evening-off-duty-check';

export type TodayAttendanceFinalTask = Extract<
  TodayAttendanceTask,
  'morning-off-duty-check' | 'evening-off-duty-check'
>;

export interface TodayAttendanceEntry {
  key: string;
  name: string;
  building: string;
  shiftLabel: string;
  direction: TodayAttendanceDirection;
  expectedAt: string;
  status: TodayAttendanceStatus;
  reason?: string;
}

export interface TodayAttendanceSnapshot {
  date: string;
  displayScope: TodayAttendanceDisplayScope;
  fetchedAt: string;
  sourceStatus: TodayAttendanceSourceStatus;
  runStatus?: TodayAttendanceRunStatus;
  checkedTasks: TodayAttendanceTask[];
  summary: {
    expected: number;
    normal: number;
    anomaly: number;
    excluded: number;
  };
  entries: TodayAttendanceEntry[];
}

export interface TodayAttendanceCorrectionEvidenceQuery {
  businessDate: string;
  entryKey: string;
}

export interface TodayAttendanceCorrectionEvidenceManifest extends TodayAttendanceCorrectionEvidenceQuery {
  name: string;
  direction: TodayAttendanceDirection;
  status: string;
  reason: string;
  imageCount: number;
  syncState: 'ready' | 'syncing' | 'failed';
  retryAfterMs?: number;
  failureReason?: string;
  images: Array<{
    transport?: 'proxy';
    url: string;
    contentType: string;
    expiresAt: string;
  }>;
}

export interface TodayAttendanceManualSyncRequest {
  clientMutationId: string;
  task?: TodayAttendanceFinalTask;
}

export interface TodayAttendanceManualSyncResponse {
  success: true;
  accepted: boolean;
  duplicate: boolean;
  inProgress: boolean;
  clientMutationId: string;
  task: TodayAttendanceFinalTask;
  date: string;
  state: 'running' | 'failed' | 'completed';
}
