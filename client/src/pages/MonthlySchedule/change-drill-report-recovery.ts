import type { ChangeInfo } from '@shared/api.interface';
import {
  validateChangeDrillReport,
  type ChangeDrillReportCreateRequest,
} from '@shared/change-drill-report';

const CHANGE_DRILL_REPORT_RECOVERY_KEY =
  'monthly-schedule.change-drill-report.recovery.v1';

export interface ChangeDrillReportRetryBinding {
  request: ChangeDrillReportCreateRequest;
  original: ChangeInfo;
}

export interface ChangeDrillReportRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function persistChangeDrillReportRecovery(
  binding: ChangeDrillReportRetryBinding,
  storage: ChangeDrillReportRecoveryStorage | null = getSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CHANGE_DRILL_REPORT_RECOVERY_KEY, JSON.stringify(binding));
    return true;
  } catch {
    return false;
  }
}

export function readChangeDrillReportRecovery(
  storage: ChangeDrillReportRecoveryStorage | null = getSessionStorage(),
): ChangeDrillReportRetryBinding | null {
  if (!storage) return null;

  try {
    const raw = storage.getItem(CHANGE_DRILL_REPORT_RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChangeDrillReportRetryBinding;
    if (!isValidRecoveryBinding(parsed)) {
      storage.removeItem(CHANGE_DRILL_REPORT_RECOVERY_KEY);
      return null;
    }
    return cloneBinding(parsed);
  } catch {
    try {
      storage.removeItem(CHANGE_DRILL_REPORT_RECOVERY_KEY);
    } catch {
      // Storage can become unavailable between reads; there is nothing else to recover.
    }
    return null;
  }
}

export function clearChangeDrillReportRecovery(
  storage: ChangeDrillReportRecoveryStorage | null = getSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(CHANGE_DRILL_REPORT_RECOVERY_KEY);
    return true;
  } catch {
    return false;
  }
}

function isValidRecoveryBinding(
  value: unknown,
): value is ChangeDrillReportRetryBinding {
  if (
    !isRecord(value) ||
    !isRecord(value.request) ||
    !isRecord(value.original)
  ) {
    return false;
  }
  if (validateChangeDrillReport(value.request).length > 0) return false;

  const changeRecordId = String(value.request.changeRecordId || '').trim();
  const bitableRecordId = String(value.original.bitableRecordId || '').trim();
  return (
    Boolean(changeRecordId) &&
    changeRecordId === bitableRecordId &&
    ['中', '高'].includes(String(value.original.level || '').trim())
  );
}

function cloneBinding(
  binding: ChangeDrillReportRetryBinding,
): ChangeDrillReportRetryBinding {
  return JSON.parse(JSON.stringify(binding)) as ChangeDrillReportRetryBinding;
}

function getSessionStorage(): ChangeDrillReportRecoveryStorage | null {
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
