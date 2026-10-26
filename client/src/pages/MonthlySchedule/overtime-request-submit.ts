import type { OvertimeRequestCreateResponse } from '@shared/api.interface';
import {
  createOvertimeRequestImpactComparisonKey,
  type OvertimeRequestImpact,
} from '@shared/overtime-request-impact';
import {
  getOvertimeHistoryEarliestDate,
  isOvertimeHistoryDateAllowed,
  listOvertimeHistoryScheduleCoverageDates,
} from '@shared/overtime-request-date-window';
import { getShanghaiBusinessDateKey } from './business-date';

export {
  getOvertimeHistoryEarliestDate,
  listOvertimeHistoryScheduleCoverageDates,
} from '@shared/overtime-request-date-window';

export type OvertimeRequestFailureDisposition =
  | 'definitely-not-written'
  | 'unknown-result';

export type OvertimeRequestMutationState =
  | 'in-flight'
  | 'editable-error'
  | 'unknown-result';

export interface OvertimeRequestSubmissionSnapshot {
  staffName: string;
  startAt: string;
  endAt: string;
  reason: string;
  expectedImpact: OvertimeRequestImpact;
  screenshot: File;
}

export interface OvertimeRequestMutationBinding {
  clientMutationId: string;
  snapshotDigest: string;
  snapshot: OvertimeRequestSubmissionSnapshot;
  state: OvertimeRequestMutationState;
}

export interface OvertimeRequestRecoveryCredential {
  clientMutationId: string;
  snapshotDigest: string;
}

export type OvertimeRequestMutationResolution =
  | {
      status: 'ready';
      binding: OvertimeRequestMutationBinding;
      reused: boolean;
    }
  | {
      status: 'blocked';
      binding: OvertimeRequestMutationBinding;
    };

export interface OvertimeRequestResponseIdentity {
  clientMutationId: string;
  expectedImpact: OvertimeRequestImpact;
}

export interface OvertimeRequestDefaultRange {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export interface OvertimeRequestPreparationToken {
  readonly sequence: number;
}

export interface OvertimeRequestPreparationLifecycle {
  begin: () => OvertimeRequestPreparationToken;
  invalidate: () => void;
  isCurrent: (token: OvertimeRequestPreparationToken) => boolean;
}

export interface CoordinateOvertimeRequestPreparationOptions<T> {
  lifecycle: OvertimeRequestPreparationLifecycle;
  prepare: () => Promise<T>;
  persist: (prepared: T) => boolean;
  commit: (prepared: T) => void;
  onPersistFailure: () => void;
  onPrepareFailure?: () => void;
  onSettled: () => void;
}

interface OvertimeScheduleDateSource {
  scheduleDate: string | null;
}

const OVERTIME_REQUEST_RECOVERY_STORAGE_KEY =
  'monthly-schedule.overtime-request.recovery.v2';
const OVERTIME_REQUEST_LEGACY_STORAGE_KEY =
  'monthly-schedule.overtime-request.unknown-mutation-id.v1';
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const screenshotDigestPromiseCache = new WeakMap<
  File,
  Promise<string | null>
>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOvertimeRequestMutationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length > 128 ||
    !/^overtime-request-[A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeSnapshotDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SHA256_DIGEST_PATTERN.test(normalized) ? normalized : null;
}

function normalizeRecoveryCredential(
  value: unknown,
): OvertimeRequestRecoveryCredential | null {
  if (!isObject(value)) return null;
  const clientMutationId = normalizeOvertimeRequestMutationId(
    value.clientMutationId,
  );
  const snapshotDigest = normalizeSnapshotDigest(value.snapshotDigest);
  return clientMutationId && snapshotDigest
    ? { clientMutationId, snapshotDigest }
    : null;
}

async function createSha256Digest(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return null;
  try {
    const ownedBytes = new Uint8Array(bytes.byteLength);
    ownedBytes.set(bytes);
    const digest = await subtle.digest('SHA-256', ownedBytes.buffer);
    return `sha256:${Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')}`;
  } catch {
    return null;
  }
}

function getScreenshotContentDigest(file: File): Promise<string | null> {
  const cached = screenshotDigestPromiseCache.get(file);
  if (cached) return cached;
  const digestPromise = (async () => {
    try {
      const content = await file.arrayBuffer();
      return await createSha256Digest(new Uint8Array(content));
    } catch {
      return null;
    }
  })();
  screenshotDigestPromiseCache.set(file, digestPromise);
  return digestPromise;
}

function hasDefinitelyNotWrittenDisposition(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 3 || !isObject(value)) return false;
  if (value.writeDisposition === 'definitely-not-written') return true;
  return (
    hasDefinitelyNotWrittenDisposition(value.data, depth + 1) ||
    hasDefinitelyNotWrittenDisposition(value.error, depth + 1)
  );
}

function isOvertimeRequestSuccessPayload(
  value: unknown,
): value is OvertimeRequestCreateResponse {
  if (!isObject(value)) return false;
  return (
    value.success === true &&
    Number.isInteger(value.created) &&
    (value.created === 0 || value.created === 1) &&
    typeof value.recordId === 'string' &&
    value.recordId.trim().length > 0 &&
    typeof value.clientMutationId === 'string' &&
    typeof value.requestFingerprint === 'string' &&
    value.requestFingerprint.trim().length > 0 &&
    typeof value.message === 'string' &&
    value.message.trim().length > 0 &&
    createOvertimeRequestImpactComparisonKey(value.impact) !== null
  );
}

function formatShanghaiDateTimeParts(epochMs: number): {
  date: string;
  time: string;
} {
  const shifted = new Date(epochMs + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  return { date: `${year}-${month}-${day}`, time: `${hour}:00` };
}

function parseShanghaiWallClock(date: string, time: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^([01]\d|2[0-3]):00$/.exec(time);
  if (!dateMatch || !timeMatch) return null;
  const wallClock = `${date}T${time}:00.000Z`;
  const wallClockMs = Date.parse(wallClock);
  if (
    Number.isNaN(wallClockMs) ||
    new Date(wallClockMs).toISOString() !== wallClock
  ) {
    return null;
  }
  return wallClockMs - SHANGHAI_OFFSET_MS;
}

export function createOvertimeRequestMutationId(): string {
  const cryptoApi = globalThis.crypto;
  const suffix =
    cryptoApi && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  return `overtime-request-${suffix}`;
}

export function readOvertimeRequestRecoveryCredential(
  storage: Pick<Storage, 'getItem'> | null,
): OvertimeRequestRecoveryCredential | null {
  if (!storage) return null;
  try {
    const rawValue = storage.getItem(OVERTIME_REQUEST_RECOVERY_STORAGE_KEY);
    return rawValue
      ? normalizeRecoveryCredential(JSON.parse(rawValue) as unknown)
      : null;
  } catch {
    return null;
  }
}

export function persistOvertimeRequestRecoveryCredential(
  storage: Pick<Storage, 'setItem'> | null,
  credential: OvertimeRequestRecoveryCredential,
): boolean {
  const normalized = normalizeRecoveryCredential(credential);
  if (!storage || !normalized) return false;
  try {
    storage.setItem(
      OVERTIME_REQUEST_RECOVERY_STORAGE_KEY,
      JSON.stringify(normalized),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearOvertimeRequestRecoveryCredential(
  storage: Pick<Storage, 'removeItem'> | null,
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(OVERTIME_REQUEST_RECOVERY_STORAGE_KEY);
    storage.removeItem(OVERTIME_REQUEST_LEGACY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function createOvertimeRequestSnapshotDigest(
  snapshot: OvertimeRequestSubmissionSnapshot,
): Promise<string | null> {
  const expectedImpact = createOvertimeRequestImpactComparisonKey(
    snapshot.expectedImpact,
  );
  if (!expectedImpact || !snapshot.screenshot) return null;
  const screenshotContentDigest = await getScreenshotContentDigest(
    snapshot.screenshot,
  );
  if (!screenshotContentDigest) return null;
  const canonicalSnapshot = JSON.stringify({
    version: 1,
    staffName: snapshot.staffName,
    startAt: snapshot.startAt,
    endAt: snapshot.endAt,
    reason: snapshot.reason,
    expectedImpact,
    screenshot: {
      name: snapshot.screenshot.name,
      type: snapshot.screenshot.type,
      size: snapshot.screenshot.size,
      contentDigest: screenshotContentDigest,
    },
  });
  return await createSha256Digest(new TextEncoder().encode(canonicalSnapshot));
}

export function primeOvertimeRequestScreenshotDigest(file: File): void {
  void getScreenshotContentDigest(file);
}

export function classifyOvertimeRequestSubmissionError(
  error: unknown,
): OvertimeRequestFailureDisposition {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isObject(current)) break;
    if (current instanceof OvertimeRequestResponseError) {
      return 'unknown-result';
    }

    const response = isObject(current.response) ? current.response : null;
    if (
      hasDefinitelyNotWrittenDisposition(current) ||
      hasDefinitelyNotWrittenDisposition(response)
    ) {
      return 'definitely-not-written';
    }

    const status = Number(
      current.status ?? current.statusCode ?? response?.status,
    );
    if (
      Number.isFinite(status) &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 409 &&
      status !== 425 &&
      status !== 429
    ) {
      return 'definitely-not-written';
    }
    if (
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    ) {
      return 'unknown-result';
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
      return 'unknown-result';
    }
    if (current.request !== undefined && current.response === undefined) {
      return 'unknown-result';
    }
    if (
      /network error|failed to fetch|fetch failed|timeout|timed out|socket hang up|connection reset/i.test(
        String(current.message || ''),
      )
    ) {
      return 'unknown-result';
    }
    current = current.cause;
  }
  return 'unknown-result';
}

export function markOvertimeRequestMutationFailure(
  binding: OvertimeRequestMutationBinding,
  error: unknown,
): OvertimeRequestMutationBinding {
  if (binding.state === 'unknown-result') return binding;
  return {
    ...binding,
    state:
      classifyOvertimeRequestSubmissionError(error) === 'definitely-not-written'
        ? 'editable-error'
        : 'unknown-result',
  };
}

export function resolveOvertimeRequestMutationBinding(
  binding: OvertimeRequestMutationBinding | null,
  snapshot: OvertimeRequestSubmissionSnapshot,
  snapshotDigest: string,
  createMutationId: () => string,
): OvertimeRequestMutationResolution {
  const normalizedSnapshotDigest = normalizeSnapshotDigest(snapshotDigest);
  if (!normalizedSnapshotDigest) {
    throw new Error('无法生成有效的加班申请摘要');
  }
  if (binding) {
    if (binding.snapshotDigest === normalizedSnapshotDigest) {
      return {
        status: 'ready',
        binding:
          binding.state === 'unknown-result'
            ? binding
            : { ...binding, state: 'in-flight' },
        reused: true,
      };
    }
    if (binding.state === 'unknown-result') {
      return { status: 'blocked', binding };
    }
  }

  const clientMutationId =
    normalizeOvertimeRequestMutationId(createMutationId());
  if (!clientMutationId) {
    throw new Error('无法生成有效的加班申请标识');
  }
  return {
    status: 'ready',
    binding: {
      clientMutationId,
      snapshotDigest: normalizedSnapshotDigest,
      snapshot: Object.freeze({ ...snapshot }),
      state: 'in-flight',
    },
    reused: false,
  };
}

type OvertimeRequestResponseErrorCode =
  | 'OVERTIME_REQUEST_RESPONSE_MALFORMED'
  | 'OVERTIME_REQUEST_RESPONSE_MISMATCH';

export class OvertimeRequestResponseError extends Error {
  constructor(
    message: string,
    readonly code: OvertimeRequestResponseErrorCode,
  ) {
    super(message);
    this.name = 'OvertimeRequestResponseError';
  }
}

export function resolveOvertimeRequestSuccessResponse(
  result: unknown,
  draft: OvertimeRequestResponseIdentity,
): OvertimeRequestCreateResponse {
  let candidate = result;
  for (let depth = 0; depth <= 2; depth += 1) {
    if (isOvertimeRequestSuccessPayload(candidate)) {
      const expectedImpactKey = createOvertimeRequestImpactComparisonKey(
        draft.expectedImpact,
      );
      const responseImpactKey = createOvertimeRequestImpactComparisonKey(
        candidate.impact,
      );
      if (
        candidate.clientMutationId !== draft.clientMutationId ||
        expectedImpactKey === null ||
        responseImpactKey !== expectedImpactKey
      ) {
        throw new OvertimeRequestResponseError(
          '加班响应与当前请求不一致，请保留草稿后重试',
          'OVERTIME_REQUEST_RESPONSE_MISMATCH',
        );
      }
      return candidate;
    }
    if (!isObject(candidate) || !('data' in candidate)) break;
    candidate = candidate.data;
  }
  throw new OvertimeRequestResponseError(
    '加班响应格式异常，请保留草稿后重试',
    'OVERTIME_REQUEST_RESPONSE_MALFORMED',
  );
}

export function createOvertimeRequestSubmissionSequence(): {
  next: () => number;
  isCurrent: (sequence: number) => boolean;
  invalidate: () => void;
} {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current;
    },
    isCurrent: (sequence) => sequence === current,
    invalidate: () => {
      current += 1;
    },
  };
}

export function createOvertimeRequestPreparationLifecycle(): OvertimeRequestPreparationLifecycle {
  let currentSequence = 0;
  return {
    begin: () => {
      currentSequence += 1;
      return Object.freeze({ sequence: currentSequence });
    },
    invalidate: () => {
      currentSequence += 1;
    },
    isCurrent: (token) => token.sequence === currentSequence,
  };
}

export async function coordinateOvertimeRequestPreparation<T>({
  lifecycle,
  prepare,
  persist,
  commit,
  onPersistFailure,
  onPrepareFailure,
  onSettled,
}: CoordinateOvertimeRequestPreparationOptions<T>): Promise<
  'committed' | 'cancelled' | 'prepare-failed' | 'persist-failed'
> {
  const token = lifecycle.begin();
  let prepared: T;
  try {
    prepared = await prepare();
  } catch {
    if (!lifecycle.isCurrent(token)) return 'cancelled';
    onPrepareFailure?.();
    if (lifecycle.isCurrent(token)) onSettled();
    return 'prepare-failed';
  }
  if (!lifecycle.isCurrent(token)) return 'cancelled';

  let persisted = false;
  try {
    if (!lifecycle.isCurrent(token)) return 'cancelled';
    persisted = persist(prepared);
  } catch {
    persisted = false;
  }
  if (!lifecycle.isCurrent(token)) return 'cancelled';
  if (!persisted) {
    onPersistFailure();
    if (lifecycle.isCurrent(token)) onSettled();
    return 'persist-failed';
  }

  if (!lifecycle.isCurrent(token)) return 'cancelled';
  commit(prepared);
  if (lifecycle.isCurrent(token)) onSettled();
  return 'committed';
}

export function listOvertimeScheduleDates(
  schedules: OvertimeScheduleDateSource[],
  todayDate: string,
): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayDate)) return [];
  const earliestDate = getOvertimeHistoryEarliestDate(todayDate);
  if (!earliestDate) return [];
  return Array.from(
    new Set(
      schedules
        .map((schedule) => schedule.scheduleDate || '')
        .filter(
          (date) =>
            /^\d{4}-\d{2}-\d{2}$/.test(date) &&
            parseShanghaiWallClock(date, '00:00') !== null &&
            date >= earliestDate,
        ),
    ),
  ).sort();
}

export function listOvertimeEndDates(
  availableDates: string[],
  startDate: string,
): string[] {
  if (parseShanghaiWallClock(startDate, '00:00') === null) return [];
  return Array.from(
    new Set(
      availableDates.filter(
        (date) =>
          date >= startDate && parseShanghaiWallClock(date, '00:00') !== null,
      ),
    ),
  ).sort();
}

export function listOvertimeEndTimes(
  hourOptions: string[],
  startDate: string,
  startTime: string,
  endDate: string,
): string[] {
  if (!startDate || !endDate || endDate < startDate) return [];
  return endDate === startDate
    ? hourOptions.filter((time) => time > startTime)
    : hourOptions;
}

export function reconcileOvertimeRangeAfterStartChange(
  currentRange: OvertimeRequestDefaultRange,
  change: Partial<Pick<OvertimeRequestDefaultRange, 'startDate' | 'startTime'>>,
): OvertimeRequestDefaultRange {
  const startDate = change.startDate ?? currentRange.startDate;
  const startTime = change.startTime ?? currentRange.startTime;
  const startDateChanged =
    change.startDate !== undefined &&
    change.startDate !== currentRange.startDate;
  const endDate = startDateChanged ? startDate : currentRange.endDate;
  let endTime = currentRange.endTime;

  if (endDate === startDate && (!endTime || endTime <= startTime)) {
    const startHourMatch = /^([01]\d|2[0-3]):00$/.exec(startTime);
    const startHour = startHourMatch ? Number(startHourMatch[1]) : null;
    endTime =
      startHour !== null && startHour < 23
        ? `${String(startHour + 1).padStart(2, '0')}:00`
        : '';
  }

  return { startDate, startTime, endDate, endTime };
}

export function getShanghaiTodayDate(now = new Date()): string {
  return getShanghaiBusinessDateKey(now);
}

export function createOvertimeDefaultRange(
  availableDates: string[],
  now = new Date(),
): OvertimeRequestDefaultRange {
  if (availableDates.length === 0) {
    return { startDate: '', startTime: '', endDate: '', endTime: '' };
  }

  const roundedStartMs =
    now.getTime() % HOUR_MS === 0
      ? now.getTime()
      : Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  const roundedStart = formatShanghaiDateTimeParts(roundedStartMs);
  const normalizedDates = Array.from(
    new Set(
      availableDates.filter(
        (date) => parseShanghaiWallClock(date, '00:00') !== null,
      ),
    ),
  ).sort();
  const selectedStartDate = normalizedDates.find(
    (date) => date >= roundedStart.date,
  );
  if (!selectedStartDate) {
    return { startDate: '', startTime: '', endDate: '', endTime: '' };
  }
  const selectedStartTime =
    selectedStartDate === roundedStart.date ? roundedStart.time : '00:00';
  const selectedStartMs = parseShanghaiWallClock(
    selectedStartDate,
    selectedStartTime,
  );
  if (selectedStartMs === null) {
    return { startDate: '', startTime: '', endDate: '', endTime: '' };
  }
  const end = formatShanghaiDateTimeParts(selectedStartMs + HOUR_MS);
  if (!normalizedDates.includes(end.date)) {
    return { startDate: '', startTime: '', endDate: '', endTime: '' };
  }
  return {
    startDate: selectedStartDate,
    startTime: selectedStartTime,
    endDate: end.date,
    endTime: end.time,
  };
}

export function isOvertimeRangeSelectable(
  availableDates: string[],
  range: OvertimeRequestDefaultRange,
  now = new Date(),
): boolean {
  const available = new Set(availableDates);
  if (!available.has(range.startDate) || !available.has(range.endDate)) {
    return false;
  }
  const startMs = parseShanghaiWallClock(range.startDate, range.startTime);
  const endMs = parseShanghaiWallClock(range.endDate, range.endTime);
  if (startMs === null || endMs === null || endMs <= startMs) return false;
  return isOvertimeHistoryDateAllowed(
    range.startDate,
    getShanghaiTodayDate(now),
  );
}

export function reconcileOvertimeRangeWithAvailability(
  availableDates: string[],
  currentRange: OvertimeRequestDefaultRange,
  now = new Date(),
): OvertimeRequestDefaultRange {
  return isOvertimeRangeSelectable(availableDates, currentRange, now)
    ? currentRange
    : createOvertimeDefaultRange(availableDates, now);
}

export function createShanghaiOvertimeDateTime(
  date: string,
  time: string,
): string | null {
  if (parseShanghaiWallClock(date, time) === null) return null;
  return `${date}T${time}:00+08:00`;
}

export function isOvertimeScheduleRangeCovered(
  schedules: OvertimeScheduleDateSource[],
  startDate: string,
  endDate: string,
): boolean {
  const startMs = parseShanghaiWallClock(startDate, '00:00');
  const endMs = parseShanghaiWallClock(endDate, '00:00');
  if (startMs === null || endMs === null || endMs < startMs) return false;
  const scheduleDates = new Set(
    schedules
      .map((schedule) => schedule.scheduleDate || '')
      .filter((date) => parseShanghaiWallClock(date, '00:00') !== null),
  );
  for (let cursor = startMs - DAY_MS; cursor <= endMs; cursor += DAY_MS) {
    if (!scheduleDates.has(formatShanghaiDateTimeParts(cursor).date)) {
      return false;
    }
  }
  return true;
}

export function resolveOvertimeAuthoritativeImpactAfterSchedulesChange(
  authoritativeImpact: OvertimeRequestImpact | null,
  recoveryState: OvertimeRequestMutationState | null,
): OvertimeRequestImpact | null {
  return recoveryState === 'unknown-result' ? authoritativeImpact : null;
}

export function getLatestOvertimeImpactFromError(
  error: unknown,
): OvertimeRequestImpact | null {
  if (!isObject(error)) return null;
  const response = isObject(error.response) ? error.response : null;
  const data = response && isObject(response.data) ? response.data : null;
  const errorPayload = data && isObject(data.error) ? data.error : null;
  let candidate: unknown = data?.latestImpact ?? errorPayload?.latestImpact;
  if (!candidate && errorPayload && isObject(errorPayload.details)) {
    candidate = errorPayload.details.latestImpact;
  }
  return createOvertimeRequestImpactComparisonKey(candidate) === null
    ? null
    : (candidate as OvertimeRequestImpact);
}

export function getOvertimeRequestErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (!isObject(error)) return fallback;
  const response = isObject(error.response) ? error.response : null;
  const data = response && isObject(response.data) ? response.data : null;
  const errorPayload = data && isObject(data.error) ? data.error : null;
  const candidates = [errorPayload?.message, data?.message];
  const message = candidates.find(
    (candidate) => typeof candidate === 'string' && candidate.trim().length > 0,
  );
  return typeof message === 'string' ? message.trim() : fallback;
}
