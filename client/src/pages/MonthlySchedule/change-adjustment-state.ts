import type { ChangeInfo, ChangeInfoDocument } from '@shared/api.interface';
import {
  createEmptyChangeAdjustmentDraft,
  type ChangeAdjustmentDraft,
  type ChangeAdjustmentLifecycleStatus,
  type ChangeAdjustmentRequest,
} from '@shared/change-adjustment';

export interface PreparedChangeAdjustmentDraft {
  lifecycleStatus: ChangeAdjustmentLifecycleStatus;
  effectiveStartDate: string;
  effectiveEndDate: string;
  request: ChangeAdjustmentDraft;
}

export function getEffectiveChangeStartDate(change: ChangeInfo): string {
  return change.plannedDelayStartDate || change.startDate;
}

export function getEffectiveChangeEndDate(change: ChangeInfo): string {
  return change.plannedDelayEndDate || change.endDate;
}

export function getChangeAdjustmentLifecycle(
  change: ChangeInfo,
  now = new Date(),
): ChangeAdjustmentLifecycleStatus {
  const actualEnd = parseChangeDateTime(change.actualEndDate);
  if (actualEnd !== null) return 'finished';

  const actualStart = parseChangeDateTime(change.actualStartDate);
  if (actualStart !== null) return 'in-progress';

  const effectiveStart = parseChangeDateTime(
    getEffectiveChangeStartDate(change),
  );
  const effectiveEnd = parseChangeDateTime(getEffectiveChangeEndDate(change));
  if (
    effectiveStart === null ||
    effectiveEnd === null ||
    effectiveEnd <= effectiveStart
  ) {
    return 'finished';
  }

  const nowTime = now.getTime();
  if (nowTime >= effectiveEnd) return 'finished';
  if (nowTime >= effectiveStart) {
    return 'in-progress';
  }
  return 'not-started';
}

export function listAdjustableChanges(
  changes: readonly ChangeInfo[],
  now = new Date(),
): ChangeInfo[] {
  return changes.filter(
    (change) => getChangeAdjustmentLifecycle(change, now) !== 'finished',
  );
}

export function createChangeAdjustmentDraftForRecord(
  change: ChangeInfo,
  now = new Date(),
): PreparedChangeAdjustmentDraft {
  const lifecycleStatus = getChangeAdjustmentLifecycle(change, now);
  const effectiveStartDate = toLocalDateTimeInput(
    getEffectiveChangeStartDate(change),
  );
  const effectiveEndDate = toLocalDateTimeInput(
    getEffectiveChangeEndDate(change),
  );
  const empty = createEmptyChangeAdjustmentDraft();
  const tokens = uniqueTokens(change.planDocuments || []);

  return {
    lifecycleStatus,
    effectiveStartDate,
    effectiveEndDate,
    request: {
      ...empty,
      recordId: change.bitableRecordId || change.id,
      expectedUpdatedAt: change.adjustmentUpdatedAt || '',
      plannedDelayStartDate:
        lifecycleStatus === 'not-started' ? effectiveStartDate : null,
      plannedDelayEndDate: effectiveEndDate,
      retainedDocumentTokens: tokens,
    },
  };
}

export function applyPendingChangeAdjustment(
  change: ChangeInfo,
  request: ChangeAdjustmentRequest,
  now = new Date().toISOString(),
): ChangeInfo {
  const retained = new Set(request.retainedDocumentTokens);
  const retainedDocuments = (change.planDocuments || []).filter((document) =>
    retained.has(document.fileToken),
  );
  const newDocuments: ChangeInfoDocument[] = request.newSchemeDocuments.map(
    (document) => ({
      fileToken: `pending:${document.objectStorage?.id || document.name || 'file'}`,
      name: document.name || document.originalname || '新方案',
      size: document.size,
      mimeType: document.type || document.mimetype || null,
      url: document.objectStorage?.url || null,
      objectStorage: document.objectStorage || null,
    }),
  );

  return {
    ...change,
    plannedDelayStartDate:
      request.plannedDelayStartDate || change.plannedDelayStartDate,
    plannedDelayEndDate: request.plannedDelayEndDate,
    delayReason: request.reason.trim(),
    delayEvidence: request.evidenceDocuments.map((document) => ({
      fileToken: `pending:${document.objectStorage?.id || document.name || 'evidence'}`,
      name: document.name || document.originalname || '延期举证',
      size: document.size,
      mimeType: document.type || document.mimetype || null,
      url: document.objectStorage?.url || null,
      objectStorage: document.objectStorage || null,
    })),
    planDocuments: [...retainedDocuments, ...newDocuments],
    progress: '调整同步中',
    updatedAt: now,
  };
}

function uniqueTokens(documents: readonly ChangeInfoDocument[]): string[] {
  return Array.from(
    new Set(
      documents.map((document) => document.fileToken.trim()).filter(Boolean),
    ),
  );
}

function parseChangeDateTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  const hasExplicitTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (local && !hasExplicitTimeZone) {
    const timestamp = Date.UTC(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]) - 8,
      Number(local[5]),
    );
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toLocalDateTimeInput(value: string): string {
  const local = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(value);
  const hasExplicitTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (local && !hasExplicitTimeZone) return local[1];

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const shanghai = new Date(timestamp + 8 * 60 * 60 * 1000);
  return `${shanghai.getUTCFullYear()}-${String(
    shanghai.getUTCMonth() + 1,
  ).padStart(
    2,
    '0',
  )}-${String(shanghai.getUTCDate()).padStart(2, '0')}T${String(
    shanghai.getUTCHours(),
  ).padStart(2, '0')}:${String(shanghai.getUTCMinutes()).padStart(2, '0')}`;
}
