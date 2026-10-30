export interface DutyLocalSyncResult {
  success: boolean;
  total: number;
  reset: number;
  ruleUpdated: number;
  localSynced: number;
  failed: number;
  failures?: Array<{ recordId: string; error: string }>;
  durationMs: number;
  message: string;
  scope?: 'full' | 'three_months';
  range?: { startDate: string; endDate: string };
  rangeCount?: number;
  storageMode?: 'snapshot' | 'database-and-snapshot';
}

export interface DutyLocalSyncTaskResponse {
  taskId: string;
  requestId: string;
  status: 'running' | 'succeeded' | 'failed';
  phase: string;
  startedAt: string;
  finishedAt?: string;
  result?: DutyLocalSyncResult;
  error?: { code: 'LOCAL_SYNC_FAILED'; message: string };
}
