import type { ChangeInfo } from '@shared/api.interface';
import {
  CHANGE_SUMMARY_REPORT_MUTATION_ID_PREFIX,
  normalizeChangeSummaryReportSubmitterName,
} from '@shared/change-summary-report';

const FEISHU_RECORD_ID_PATTERN = /^rec[A-Za-z0-9]{8,64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const CHANGE_SUMMARY_REPORT_START_AT =
  Date.UTC(2026, 5, 1) - SHANGHAI_OFFSET_MS;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?$/i;

export const CHANGE_SUMMARY_REPORT_PERSON_OPTION_LIMIT = 100;

export interface ChangeSummaryReportUuidSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (bytes: Uint8Array) => void;
}

export type ChangeSummaryReportCacheStatus = 'loading' | 'ready' | 'error';

export interface ChangeSummaryReportCachePresentation {
  hasUsableData: boolean;
  blocking: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
}

export type ChangeSummaryReportEligibleRecord = Pick<
  ChangeInfo,
  | 'id'
  | 'bitableRecordId'
  | 'startDate'
  | 'level'
  | 'progress'
  | 'submitterName'
  | 'workflowStatus'
  | 'hasSummaryReport'
>;

export function resolveChangeSummaryReportCachePresentation(
  status: ChangeSummaryReportCacheStatus,
  itemCount: number,
): ChangeSummaryReportCachePresentation {
  const hasUsableData = Number.isFinite(itemCount) && itemCount > 0;
  return {
    hasUsableData,
    blocking: !hasUsableData && status === 'loading',
    refreshing: hasUsableData && status === 'loading',
    refreshFailed: hasUsableData && status === 'error',
  };
}

export function filterChangeSummaryReportPersonOptions(
  personOptions: readonly string[],
  query: string,
): string[] {
  const normalizedQuery = normalizeSearchText(query);
  return Array.from(
    new Set(
      personOptions
        .map(normalizeChangeSummaryReportSubmitterName)
        .filter(Boolean),
    ),
  )
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .filter(
      (name) =>
        !normalizedQuery || normalizeSearchText(name).includes(normalizedQuery),
    )
    .slice(0, CHANGE_SUMMARY_REPORT_PERSON_OPTION_LIMIT);
}

export function isEligibleChangeSummaryRecord(
  change: ChangeSummaryReportEligibleRecord,
  submitterName: string,
): boolean {
  const selectedSubmitterName =
    normalizeChangeSummaryReportSubmitterName(submitterName);
  if (
    !selectedSubmitterName ||
    normalizeChangeSummaryReportSubmitterName(change.submitterName) !==
      selectedSubmitterName
  ) {
    return false;
  }

  const recordId = change.bitableRecordId.trim();
  if (
    !FEISHU_RECORD_ID_PATTERN.test(recordId) ||
    !FEISHU_RECORD_ID_PATTERN.test(change.id.trim())
  ) {
    return false;
  }

  if (normalizeLabel(change.progress) !== '已结束') {
    return false;
  }
  const level = normalizeLabel(change.level);
  if (!level || level === '超低') {
    return false;
  }
  if (/(?:退回|驳回)/u.test(normalizeLabel(change.workflowStatus))) {
    return false;
  }
  if (change.hasSummaryReport === true) {
    return false;
  }

  const startAt = parseChangeStartDate(change.startDate);
  return startAt !== null && startAt >= CHANGE_SUMMARY_REPORT_START_AT;
}

export function listEligibleChangeSummaryRecords(
  changes: readonly ChangeInfo[],
  submitterName: string,
): ChangeInfo[] {
  return changes
    .filter((change) => isEligibleChangeSummaryRecord(change, submitterName))
    .sort(
      (left, right) =>
        (parseChangeStartDate(right.startDate) || 0) -
        (parseChangeStartDate(left.startDate) || 0),
    );
}

export function createChangeSummaryReportMutationId(
  uuidSource:
    | (() => string)
    | ChangeSummaryReportUuidSource = getDefaultUuidSource(),
): string {
  const source =
    typeof uuidSource === 'function' ? { randomUUID: uuidSource } : uuidSource;
  let uuid: string;
  if (typeof source.randomUUID === 'function') {
    uuid = source.randomUUID();
  } else if (typeof source.getRandomValues === 'function') {
    uuid = createUuidFromRandomValues(source.getRandomValues);
  } else {
    throw new Error('当前环境不支持安全生成变更总结请求标识');
  }
  if (!UUID_V4_PATTERN.test(uuid)) {
    throw new Error('无法生成有效的变更总结请求标识');
  }
  return `${CHANGE_SUMMARY_REPORT_MUTATION_ID_PREFIX}${uuid}`;
}

function normalizeLabel(value: string | null | undefined): string {
  return (value || '').normalize('NFKC').replace(/\s+/gu, '');
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function parseChangeStartDate(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const match = ISO_DATE_TIME_PATTERN.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const millisecond = Number((match[7] || '').padEnd(3, '0') || 0);
  if (hour > 23 || minute > 59 || second > 59 || millisecond > 999) {
    return null;
  }

  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, millisecond);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    parsed.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  let offsetMs = SHANGHAI_OFFSET_MS;
  if (match[8]) {
    offsetMs = 0;
  } else if (match[9]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
    const magnitude = (offsetHour * 60 + offsetMinute) * 60 * 1000;
    offsetMs = match[9] === '+' ? magnitude : -magnitude;
  }
  return parsed.getTime() - offsetMs;
}

function getDefaultUuidSource(): ChangeSummaryReportUuidSource {
  const cryptoApi = globalThis.crypto;
  return {
    ...(typeof cryptoApi?.randomUUID === 'function'
      ? { randomUUID: () => cryptoApi.randomUUID() }
      : {}),
    ...(typeof cryptoApi?.getRandomValues === 'function'
      ? {
          getRandomValues: (bytes: Uint8Array) => {
            cryptoApi.getRandomValues(bytes);
          },
        }
      : {}),
  };
}

function createUuidFromRandomValues(
  getRandomValues: (bytes: Uint8Array) => void,
): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
