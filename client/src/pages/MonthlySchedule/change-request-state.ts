import type { ChangeInfo } from '@shared/api.interface';
import {
  CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE_CODE,
  type ChangeRequestAttachmentPartialFailure,
  type ChangeRequestCreateRequest,
  type ChangeRequestDocumentSyncResult,
} from '@shared/change-request';

const DATE_TIME_LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DEFAULT_CHANGE_REQUEST_DURATION_MS = 60 * 60 * 1000;

export function reconcileChangeRequestRangeAfterStartChange(
  currentStartAt: string,
  currentEndAt: string,
  nextStartAt: string,
): string {
  const nextStartMs = parseDateTimeLocalAsUtc(nextStartAt);
  if (nextStartMs === null) return currentEndAt;

  const currentStartMs = parseDateTimeLocalAsUtc(currentStartAt);
  const currentEndMs = parseDateTimeLocalAsUtc(currentEndAt);
  const currentDurationMs =
    currentStartMs !== null &&
    currentEndMs !== null &&
    currentEndMs > currentStartMs
      ? currentEndMs - currentStartMs
      : DEFAULT_CHANGE_REQUEST_DURATION_MS;

  return formatDateTimeLocalFromUtc(nextStartMs + currentDurationMs);
}

export function reconcileChangeRequestEndAfterStart(
  startAt: string,
  nextEndAt: string,
): string {
  const startMs = parseDateTimeLocalAsUtc(startAt);
  const nextEndMs = parseDateTimeLocalAsUtc(nextEndAt);
  if (startMs === null || nextEndMs === null || nextEndMs > startMs) {
    return nextEndAt;
  }
  return formatDateTimeLocalFromUtc(
    startMs + DEFAULT_CHANGE_REQUEST_DURATION_MS,
  );
}

export function createPendingChangeInfo(
  request: ChangeRequestCreateRequest,
  temporaryId: string,
  now = new Date().toISOString(),
): ChangeInfo {
  return {
    id: temporaryId,
    bitableRecordId: temporaryId,
    title: request.summary,
    startDate: request.plannedStartAt,
    endDate: request.plannedEndAt,
    actualStartDate: null,
    actualEndDate: null,
    plannedDelayStartDate: null,
    plannedDelayEndDate: null,
    level: request.level,
    type: request.changeType,
    progress: '同步中',
    executor: null,
    submitterName: request.submitterName || null,
    planDocuments: (request.stagedDocuments || []).map((document) => ({
      fileToken: `pending:${document.objectStorage.id}`,
      name: document.name || document.originalname || '变更文档',
      size: document.size,
      mimeType: document.type || document.mimetype || null,
      url: document.objectStorage.url,
      objectStorage: document.objectStorage,
    })),
    buildings: [...request.buildings],
    riskSummary: request.riskSummary,
    isKey: request.level === '高',
    recordUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function reconcilePendingChange(
  changes: readonly ChangeInfo[],
  temporaryId: string,
  saved: ChangeInfo,
): ChangeInfo[] {
  const savedIds = new Set(getChangeInfoIds(saved));
  let replaced = false;
  const reconciled: ChangeInfo[] = [];
  for (const change of changes) {
    if (change.id === temporaryId) {
      if (!replaced) reconciled.push(saved);
      replaced = true;
      continue;
    }
    if (getChangeInfoIds(change).some((id) => savedIds.has(id))) continue;
    reconciled.push(change);
  }
  return replaced ? reconciled : [saved, ...reconciled];
}

export function getChangeRequestAttachmentPartialFailure(
  error: unknown,
): ChangeRequestAttachmentPartialFailure | null {
  const responseData = (error as { response?: { data?: unknown } })?.response
    ?.data;
  if (!isRecord(responseData)) return null;

  const candidates: unknown[] = [responseData];
  const errorPayload = isRecord(responseData.error) ? responseData.error : null;
  if (errorPayload) {
    candidates.push(errorPayload);
    if (typeof errorPayload.details === 'string') {
      try {
        candidates.push(JSON.parse(errorPayload.details) as unknown);
      } catch {
        return null;
      }
    }
  }

  for (const candidate of candidates) {
    if (isChangeRequestAttachmentPartialFailure(candidate)) return candidate;
  }
  return null;
}

export function shouldRetainChangeRequestMutationIdAfterError(
  error: unknown,
): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current)) break;
    const status = Number(
      current.status ??
        current.statusCode ??
        (isRecord(current.response) ? current.response.status : undefined),
    );
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return true;
    }
    if (isRecord(current.response) && status >= 400) {
      return false;
    }
    const code = String(current.code || '').toUpperCase();
    if (
      [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EAI_AGAIN',
        'ENETDOWN',
        'ENETUNREACH',
        'ENOTFOUND',
        'ERR_NETWORK',
        'ETIMEDOUT',
      ].includes(code)
    ) {
      return true;
    }
    if (current.request !== undefined && current.response === undefined) {
      return true;
    }
    const message = String(current.message || '');
    if (
      /network error|failed to fetch|fetch failed|timeout|timed out|socket hang up|connection reset/i.test(
        message,
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function mergeChangeInfoOverlay(
  authoritative: readonly ChangeInfo[],
  overlay: readonly ChangeInfo[],
): ChangeInfo[] {
  const knownIds = new Set(authoritative.flatMap(getChangeInfoIds));
  const missingOverlay = overlay.filter((change) => {
    const ids = getChangeInfoIds(change);
    if (ids.some((id) => knownIds.has(id))) return false;
    ids.forEach((id) => knownIds.add(id));
    return true;
  });
  return [...missingOverlay, ...authoritative];
}

export interface VersionedChangeInfoOverlay {
  key: string;
  change: ChangeInfo;
  generation: number;
}

export interface ResolvedChangeInfoOverlayResponse {
  changes: ChangeInfo[];
  confirmedOverlayKeys: string[];
}

const SHANGHAI_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
});

export function getChangeInfoScheduleYear(startDate: string): number | null {
  const intendedLocalYear = /^(\d{4})-\d{2}-\d{2}(?:T.*)?$/.exec(startDate);
  const hasExplicitTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(startDate);
  if (intendedLocalYear && !hasExplicitTimeZone) {
    return Number.parseInt(intendedLocalYear[1], 10);
  }

  const parsed = new Date(startDate);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = Number.parseInt(SHANGHAI_YEAR_FORMATTER.format(parsed), 10);
  return Number.isFinite(year) ? year : null;
}

const CHANGE_PROGRESS_REQUIRING_LOCAL_OVERLAY = new Set([
  '同步中',
  '附件同步中',
  '附件待补传',
]);

export function resolveChangeInfoOverlayResponse(
  authoritative: readonly ChangeInfo[],
  overlay: readonly VersionedChangeInfoOverlay[],
  requestStartedAtGeneration: number,
): ResolvedChangeInfoOverlayResponse {
  const authoritativeIds = new Set(authoritative.flatMap(getChangeInfoIds));
  const confirmedOverlayKeys: string[] = [];
  const retainedOverlay: ChangeInfo[] = [];

  for (const entry of overlay) {
    const confirmedByServer = getChangeInfoIds(entry.change).some((id) =>
      authoritativeIds.has(id),
    );
    const writtenAfterRequestStarted =
      entry.generation > requestStartedAtGeneration;
    const requiresLocalOverlay = CHANGE_PROGRESS_REQUIRING_LOCAL_OVERLAY.has(
      entry.change.progress || '',
    );

    if (
      confirmedByServer &&
      !writtenAfterRequestStarted &&
      !requiresLocalOverlay
    ) {
      confirmedOverlayKeys.push(entry.key);
      continue;
    }
    retainedOverlay.push(entry.change);
  }

  const retainedIds = new Set(retainedOverlay.flatMap(getChangeInfoIds));
  const authoritativeWithoutRetainedOverlay = authoritative.filter(
    (change) => !getChangeInfoIds(change).some((id) => retainedIds.has(id)),
  );

  return {
    changes: mergeChangeInfoOverlay(
      authoritativeWithoutRetainedOverlay,
      retainedOverlay,
    ),
    confirmedOverlayKeys,
  };
}

export function rollbackPendingChange(
  changes: readonly ChangeInfo[],
  temporaryId: string,
): ChangeInfo[] {
  return changes.filter((change) => change.id !== temporaryId);
}

function getChangeInfoIds(change: ChangeInfo): string[] {
  return Array.from(
    new Set([change.id, change.bitableRecordId].filter(Boolean) as string[]),
  );
}

function isChangeRequestAttachmentPartialFailure(
  value: unknown,
): value is ChangeRequestAttachmentPartialFailure {
  if (!isRecord(value)) return false;
  return (
    value.code === CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE_CODE &&
    typeof value.clientMutationId === 'string' &&
    (value.recordState === 'not-created' ||
      value.recordState === 'unknown' ||
      value.recordState === 'created') &&
    (typeof value.recordCreated === 'boolean' ||
      value.recordCreated === null) &&
    (value.retryAction === 'retry-same-mutation' ||
      value.retryAction === 'manual-reconcile') &&
    typeof value.recordId === 'string' &&
    typeof value.message === 'string' &&
    isRecord(value.record) &&
    typeof value.record.id === 'string' &&
    Array.isArray(value.documents) &&
    value.documents.every(isChangeRequestDocumentSyncResult)
  );
}

function isChangeRequestDocumentSyncResult(
  value: unknown,
): value is ChangeRequestDocumentSyncResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    typeof value.size === 'number' &&
    (value.status === 'attached' ||
      value.status === 'uploaded_pending_attach' ||
      value.status === 'upload_failed') &&
    (value.stage === 'upload' || value.stage === 'record-link') &&
    typeof value.retryable === 'boolean' &&
    (value.message === undefined || typeof value.message === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDateTimeLocalAsUtc(value: string): number | null {
  const match = DATE_TIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) return null;
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5])
  ) {
    return null;
  }
  return timestamp;
}

function formatDateTimeLocalFromUtc(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
