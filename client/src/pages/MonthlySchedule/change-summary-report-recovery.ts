import type { ChangeInfo } from '@shared/api.interface';
import {
  normalizeChangeSummaryReportSubmitterName,
  validateChangeSummaryReport,
  type ChangeSummaryReportCreateRequest,
} from '@shared/change-summary-report';
import { isEligibleChangeSummaryRecord } from './change-summary-report-state';

const CHANGE_SUMMARY_REPORT_RECOVERY_KEY_PREFIX =
  'monthly-schedule.change-summary-report.recovery.v3.';
const CHANGE_SUMMARY_REPORT_LEGACY_RECOVERY_KEY =
  'monthly-schedule.change-summary-report.recovery.v1';
const CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BYTES = 256 * 1024;
const CHANGE_SUMMARY_REPORT_RECOVERY_MAX_ERROR_LENGTH = 1_000;
const CHANGE_SUMMARY_REPORT_RECOVERY_MAX_TASK_ID_LENGTH = 256;

export const CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BINDINGS = 20;

export type ChangeSummaryReportRecoveryOriginal = Pick<
  ChangeInfo,
  | 'id'
  | 'bitableRecordId'
  | 'title'
  | 'startDate'
  | 'endDate'
  | 'level'
  | 'progress'
  | 'submitterName'
  | 'workflowStatus'
  | 'hasSummaryReport'
>;

export interface ChangeSummaryReportRecoveryBinding {
  request: ChangeSummaryReportCreateRequest;
  original: ChangeSummaryReportRecoveryOriginal;
  state: 'pending' | 'unknown' | 'failed' | 'cleanup-required';
  taskId?: string;
  error?: string;
}

export interface ChangeSummaryReportRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ChangeSummaryReportRecoveryEnvelope {
  version: 3;
  bindings: ChangeSummaryReportRecoveryBinding[];
}

export function createChangeSummaryReportRecoveryOriginal(
  original: ChangeSummaryReportRecoveryOriginal | ChangeInfo,
): ChangeSummaryReportRecoveryOriginal {
  return {
    id: original.id.trim(),
    bitableRecordId: original.bitableRecordId.trim(),
    title: original.title.trim(),
    startDate: original.startDate.trim(),
    endDate: original.endDate.trim(),
    level: normalizeOptionalString(original.level),
    progress: normalizeOptionalString(original.progress),
    submitterName:
      normalizeChangeSummaryReportSubmitterName(original.submitterName) || null,
    workflowStatus: normalizeOptionalString(original.workflowStatus),
    hasSummaryReport: original.hasSummaryReport === true,
  };
}

export function persistChangeSummaryReportRecovery(
  binding: ChangeSummaryReportRecoveryBinding,
  principalFingerprint: string,
  storage: ChangeSummaryReportRecoveryStorage | null = getSessionStorage(),
): boolean {
  const key = getRecoveryKey(principalFingerprint);
  if (!storage || !key || !isValidRecoveryBinding(binding)) return false;
  try {
    const current = readChangeSummaryReportRecoveries(
      principalFingerprint,
      storage,
    );
    const existing = current.some(
      (item) =>
        item.request.clientMutationId === binding.request.clientMutationId,
    );
    if (
      !existing &&
      current.length >= CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BINDINGS
    ) {
      return false;
    }
    return writeEnvelope(
      storage,
      key,
      upsertChangeSummaryReportRecoveryBinding(current, binding),
    );
  } catch {
    return false;
  }
}

export function readChangeSummaryReportRecovery(
  principalFingerprint: string,
  storage: ChangeSummaryReportRecoveryStorage | null = getSessionStorage(),
): ChangeSummaryReportRecoveryBinding | null {
  return (
    readChangeSummaryReportRecoveries(principalFingerprint, storage)[0] || null
  );
}

export function readChangeSummaryReportRecoveries(
  principalFingerprint: string,
  storage: ChangeSummaryReportRecoveryStorage | null = getSessionStorage(),
): ChangeSummaryReportRecoveryBinding[] {
  const key = getRecoveryKey(principalFingerprint);
  if (!storage || !key) return [];
  try {
    storage.removeItem(CHANGE_SUMMARY_REPORT_LEGACY_RECOVERY_KEY);
    const raw = storage.getItem(key);
    if (!raw) return [];
    if (utf8ByteLength(raw) > CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BYTES) {
      storage.removeItem(key);
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isEnvelope(parsed)) {
      storage.removeItem(key);
      return [];
    }
    const valid = parsed.bindings
      .slice(0, CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BINDINGS)
      .filter(isValidRecoveryBinding)
      .map(cloneBinding);
    if (valid.length === 0) storage.removeItem(key);
    return valid;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Recovery storage can disappear between operations.
    }
    return [];
  }
}

export function removeChangeSummaryReportRecovery(
  clientMutationId: string,
  principalFingerprint: string,
  storage: ChangeSummaryReportRecoveryStorage | null = getSessionStorage(),
): boolean {
  const key = getRecoveryKey(principalFingerprint);
  if (!storage || !key || !clientMutationId.trim()) return false;
  try {
    const remaining = readChangeSummaryReportRecoveries(
      principalFingerprint,
      storage,
    ).filter(
      (binding) => binding.request.clientMutationId !== clientMutationId,
    );
    if (remaining.length === 0) {
      storage.removeItem(key);
      return true;
    }
    return writeEnvelope(storage, key, remaining);
  } catch {
    return false;
  }
}

export function clearChangeSummaryReportRecovery(
  principalFingerprint: string,
  storage: ChangeSummaryReportRecoveryStorage | null = getSessionStorage(),
): boolean {
  const key = getRecoveryKey(principalFingerprint);
  if (!storage || !key) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function upsertChangeSummaryReportRecoveryBinding(
  bindings: readonly ChangeSummaryReportRecoveryBinding[],
  next: ChangeSummaryReportRecoveryBinding,
): ChangeSummaryReportRecoveryBinding[] {
  const index = bindings.findIndex(
    (binding) =>
      binding.request.clientMutationId === next.request.clientMutationId,
  );
  if (index < 0) return [...bindings.map(cloneBinding), cloneBinding(next)];
  return bindings.map((binding, currentIndex) =>
    currentIndex === index ? cloneBinding(next) : cloneBinding(binding),
  );
}

export function removeChangeSummaryReportRecoveryBinding(
  bindings: readonly ChangeSummaryReportRecoveryBinding[],
  clientMutationId: string,
): ChangeSummaryReportRecoveryBinding[] {
  return bindings
    .filter((binding) => binding.request.clientMutationId !== clientMutationId)
    .map(cloneBinding);
}

export function getPendingChangeSummaryReportRecordIds(
  bindings: readonly ChangeSummaryReportRecoveryBinding[],
): Set<string> {
  return new Set(
    bindings
      .filter(
        (binding) => binding.state === 'pending' || binding.state === 'unknown',
      )
      .map((binding) => binding.request.changeRecordId),
  );
}

export function consumeChangeSummaryReportRecoveryAuthorization(
  canSubmit: boolean,
  principalFingerprint: string,
  consumedPrincipalFingerprint: string | null,
  read: (principalFingerprint: string) => ChangeSummaryReportRecoveryBinding[],
): {
  consumedPrincipalFingerprint: string | null;
  bindings: ChangeSummaryReportRecoveryBinding[];
} {
  const normalizedFingerprint =
    normalizePrincipalFingerprint(principalFingerprint);
  if (!canSubmit || !normalizedFingerprint) {
    return { consumedPrincipalFingerprint: null, bindings: [] };
  }
  if (consumedPrincipalFingerprint === normalizedFingerprint) {
    return {
      consumedPrincipalFingerprint: normalizedFingerprint,
      bindings: [],
    };
  }
  return {
    consumedPrincipalFingerprint: normalizedFingerprint,
    bindings: read(normalizedFingerprint).map(cloneBinding),
  };
}

function writeEnvelope(
  storage: ChangeSummaryReportRecoveryStorage,
  key: string,
  bindings: readonly ChangeSummaryReportRecoveryBinding[],
): boolean {
  if (bindings.length > CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BINDINGS) {
    return false;
  }
  const envelope: ChangeSummaryReportRecoveryEnvelope = {
    version: 3,
    bindings: bindings.map(cloneBinding),
  };
  const serialized = JSON.stringify(envelope);
  if (utf8ByteLength(serialized) > CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BYTES) {
    return false;
  }
  storage.setItem(key, serialized);
  return true;
}

function isEnvelope(
  value: unknown,
): value is ChangeSummaryReportRecoveryEnvelope {
  return (
    isRecord(value) && value.version === 3 && Array.isArray(value.bindings)
  );
}

function isValidRecoveryBinding(
  value: unknown,
): value is ChangeSummaryReportRecoveryBinding {
  if (
    !isRecord(value) ||
    !isRecord(value.request) ||
    !isRecord(value.original) ||
    !['pending', 'unknown', 'failed', 'cleanup-required'].includes(
      String(value.state || ''),
    )
  ) {
    return false;
  }
  if (validateChangeSummaryReport(value.request).length > 0) return false;
  if (
    value.taskId !== undefined &&
    (typeof value.taskId !== 'string' ||
      !value.taskId.trim() ||
      value.taskId.length > CHANGE_SUMMARY_REPORT_RECOVERY_MAX_TASK_ID_LENGTH)
  ) {
    return false;
  }
  if (
    value.error !== undefined &&
    (typeof value.error !== 'string' ||
      !value.error.trim() ||
      value.error.length > CHANGE_SUMMARY_REPORT_RECOVERY_MAX_ERROR_LENGTH)
  ) {
    return false;
  }

  const request = value.request as unknown as ChangeSummaryReportCreateRequest;
  const original =
    value.original as unknown as ChangeSummaryReportRecoveryOriginal;
  return (
    typeof original.id === 'string' &&
    typeof original.bitableRecordId === 'string' &&
    typeof original.title === 'string' &&
    typeof original.startDate === 'string' &&
    typeof original.endDate === 'string' &&
    request.changeRecordId === original.bitableRecordId.trim() &&
    normalizeChangeSummaryReportSubmitterName(request.submitterName) ===
      normalizeChangeSummaryReportSubmitterName(original.submitterName) &&
    isEligibleChangeSummaryRecord(original, request.submitterName)
  );
}

function cloneBinding(
  binding: ChangeSummaryReportRecoveryBinding,
): ChangeSummaryReportRecoveryBinding {
  return {
    request: JSON.parse(
      JSON.stringify(binding.request),
    ) as ChangeSummaryReportCreateRequest,
    original: createChangeSummaryReportRecoveryOriginal(binding.original),
    state: binding.state,
    ...(binding.taskId ? { taskId: binding.taskId.trim() } : {}),
    ...(binding.error ? { error: binding.error.trim() } : {}),
  };
}

function getRecoveryKey(principalFingerprint: string): string | null {
  const normalized = normalizePrincipalFingerprint(principalFingerprint);
  return normalized
    ? `${CHANGE_SUMMARY_REPORT_RECOVERY_KEY_PREFIX}${encodeURIComponent(normalized)}`
    : null;
}

function normalizePrincipalFingerprint(value: string): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (
    normalized.length < 16 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return '';
  }
  return normalized;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./giu, 'x').length;
}

function getSessionStorage(): ChangeSummaryReportRecoveryStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
