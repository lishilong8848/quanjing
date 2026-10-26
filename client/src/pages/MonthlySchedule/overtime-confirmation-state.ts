import type {
  OvertimeConfirmationDetailResponse,
  OvertimeConfirmationDisposition as ApiOvertimeConfirmationDisposition,
} from '@shared/api.interface';
import {
  addOvertimePayableHours,
  calculateOvertimePayableHours,
} from '@shared/overtime-request-impact';

export type OvertimeConfirmationDisposition =
  ApiOvertimeConfirmationDisposition;
export type OvertimeConfirmationDetail = OvertimeConfirmationDetailResponse;

export interface OvertimeConfirmationDraft {
  actualStartAt: string;
  actualEndAt?: string;
  actualHours: string;
  disposition: OvertimeConfirmationDisposition | '';
}

export interface OvertimeConfirmationSubmitRequest {
  recordId: string;
  actualStartAt: string;
  actualEndAt: string;
  actualHours: number;
  disposition: OvertimeConfirmationDisposition | null;
}

export type OvertimeConfirmationField =
  | 'actualStartAt'
  | 'actualHours'
  | 'actualEndAt'
  | 'disposition';

export type OvertimeConfirmationValidationErrors = Partial<
  Record<OvertimeConfirmationField, string>
>;

export interface OvertimeConfirmationState {
  phase: 'editing' | 'submitting';
  draft: OvertimeConfirmationDraft;
  error: string | null;
  submissionSnapshot: Readonly<OvertimeConfirmationDraft> | null;
}

export type OvertimeConfirmationSubmissionResult =
  | {
      ok: true;
      state: OvertimeConfirmationState;
      request: Readonly<OvertimeConfirmationSubmitRequest>;
    }
  | {
      ok: false;
      state: OvertimeConfirmationState;
      errors: OvertimeConfirmationValidationErrors;
    };

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_OVERTIME_HOURS = 72;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const INTEGER_PATTERN = /^\d+$/;
const EXPLICIT_TIME_ZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function createOvertimeConfirmationState(
  detail: OvertimeConfirmationDetail,
): OvertimeConfirmationState {
  const actualStartAt = normalizeDateTimeForInput(detail.actualStartAt);
  const plannedStartAt = normalizeDateTimeForInput(detail.plannedStartAt);
  const defaultHours = resolveDefaultHours(
    detail.actualHours,
    detail.plannedHours,
  );

  return {
    phase: 'editing',
    draft: {
      actualStartAt: actualStartAt || plannedStartAt,
      actualEndAt:
        normalizeDateTimeForInput(detail.actualEndAt) ||
        calculateOvertimeActualEndAt(
          actualStartAt || plannedStartAt,
          defaultHours,
        ),
      actualHours: defaultHours,
      disposition:
        parseOvertimeHours(defaultHours) === 0
          ? ''
          : isOvertimeConfirmationDisposition(detail.disposition)
            ? detail.disposition
            : '',
    },
    error: null,
    submissionSnapshot: null,
  };
}

export function updateOvertimeConfirmationDraft(
  state: OvertimeConfirmationState,
  patch: Partial<OvertimeConfirmationDraft>,
): OvertimeConfirmationState {
  if (state.phase === 'submitting') return state;
  const draft: OvertimeConfirmationDraft = { ...state.draft, ...patch };
  if (patch.actualEndAt !== undefined) {
    const hours = calculateHoursFromEnd(draft.actualStartAt, patch.actualEndAt);
    draft.actualHours = hours === null ? '' : String(hours);
  } else if (
    patch.actualStartAt !== undefined ||
    patch.actualHours !== undefined
  ) {
    draft.actualEndAt = calculateOvertimeActualEndAt(
      draft.actualStartAt,
      draft.actualHours,
    );
  }
  if (parseOvertimeHours(draft.actualHours) === 0) {
    draft.disposition = '';
  }
  return {
    ...state,
    draft,
    error: null,
  };
}

export function cancelOvertimeConfirmationDraft(
  draft: OvertimeConfirmationDraft,
): OvertimeConfirmationDraft {
  return {
    ...draft,
    actualEndAt: draft.actualStartAt,
    actualHours: '0',
    disposition: '',
  };
}

export function calculateOvertimeActualEndAt(
  actualStartAt: string,
  actualHours: string,
): string {
  const startTimestamp = parseShanghaiDateTimeInput(actualStartAt);
  const hours = parseOvertimeHours(actualHours);
  if (startTimestamp === null || hours === null) return '';

  const endTimestamp = addOvertimePayableHours(startTimestamp, hours);
  if (endTimestamp === null) return '';
  return formatShanghaiDateTimeInput(endTimestamp);
}

export function validateOvertimeConfirmationDraft(
  draft: OvertimeConfirmationDraft,
): OvertimeConfirmationValidationErrors {
  const errors: OvertimeConfirmationValidationErrors = {};
  const startTimestamp = parseShanghaiDateTimeInput(draft.actualStartAt);
  const hours = parseOvertimeHours(draft.actualHours);

  if (startTimestamp === null) {
    errors.actualStartAt = '请选择有效的实际开始时间';
  }
  if (hours === null) {
    errors.actualHours = '实际加班工时必须为 0 至 72 的整数';
  }
  if (
    hours !== null &&
    hours > 0 &&
    !isOvertimeConfirmationDisposition(draft.disposition)
  ) {
    errors.disposition = '请选择加班工时处置方式';
  }
  if (draft.actualEndAt !== undefined) {
    const endHours = calculateHoursFromEnd(
      draft.actualStartAt,
      draft.actualEndAt,
    );
    if (parseShanghaiDateTimeInput(draft.actualEndAt) === null) {
      errors.actualEndAt = '请选择有效的实际结束时间（整点）';
    } else if (startTimestamp !== null && endHours === null) {
      errors.actualEndAt =
        '结束时间不得早于开始时间，实际工时须为 0 至 72 小时';
    } else if (hours !== null && endHours !== null && hours !== endHours) {
      errors.actualEndAt = '实际结束时间与加班工时不一致';
    }
  }
  return errors;
}

export function beginOvertimeConfirmationSubmission(
  state: OvertimeConfirmationState,
  detail: OvertimeConfirmationDetail,
): OvertimeConfirmationSubmissionResult {
  if (state.phase === 'submitting') {
    return { ok: false, state, errors: {} };
  }

  const errors = validateOvertimeConfirmationDraft(state.draft);
  if (Object.keys(errors).length > 0) {
    return { ok: false, state, errors };
  }

  const actualEndAt =
    state.draft.actualEndAt ??
    calculateOvertimeActualEndAt(
      state.draft.actualStartAt,
      state.draft.actualHours,
    );
  const snapshot = Object.freeze({ ...state.draft });
  const request = Object.freeze({
    recordId: detail.recordId,
    actualStartAt: toShanghaiIsoString(snapshot.actualStartAt),
    actualEndAt: toShanghaiIsoString(actualEndAt),
    actualHours: Number(snapshot.actualHours),
    disposition:
      Number(snapshot.actualHours) === 0
        ? null
        : (snapshot.disposition as OvertimeConfirmationDisposition),
  });

  return {
    ok: true,
    state: {
      ...state,
      phase: 'submitting',
      error: null,
      submissionSnapshot: snapshot,
    },
    request,
  };
}

export function failOvertimeConfirmationSubmission(
  state: OvertimeConfirmationState,
  error: string,
): OvertimeConfirmationState {
  if (state.phase !== 'submitting' || !state.submissionSnapshot) return state;
  return {
    phase: 'editing',
    draft: { ...state.submissionSnapshot },
    error,
    submissionSnapshot: null,
  };
}

function resolveDefaultHours(
  actualHours: number | null | undefined,
  plannedHours: number,
): string {
  if (Number.isFinite(actualHours) && Number(actualHours) >= 0) {
    return String(actualHours);
  }
  if (Number.isFinite(plannedHours) && plannedHours > 0) {
    return String(plannedHours);
  }
  return '';
}

function calculateHoursFromEnd(start: string, end: string): number | null {
  const startTimestamp = parseShanghaiDateTimeInput(start);
  const endTimestamp = parseShanghaiDateTimeInput(end);
  if (
    startTimestamp === null ||
    endTimestamp === null ||
    endTimestamp < startTimestamp ||
    endTimestamp - startTimestamp > MAX_OVERTIME_HOURS * 2 * 60 * 60 * 1_000
  )
    return null;
  const hours = calculateOvertimePayableHours(startTimestamp, endTimestamp);
  if (hours === 0 && endTimestamp !== startTimestamp) return null;
  return Number.isInteger(hours) && hours <= MAX_OVERTIME_HOURS ? hours : null;
}

function isOvertimeConfirmationDisposition(
  value: unknown,
): value is OvertimeConfirmationDisposition {
  return value === 'compensatory_leave' || value === 'overtime_pay';
}

function parseOvertimeHours(value: string): number | null {
  const normalized = value.trim();
  if (!INTEGER_PATTERN.test(normalized)) return null;
  const hours = Number(normalized);
  return Number.isSafeInteger(hours) && hours <= MAX_OVERTIME_HOURS
    ? hours
    : null;
}

function normalizeDateTimeForInput(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return '';

  if (!EXPLICIT_TIME_ZONE_PATTERN.test(normalized)) {
    const localMatch =
      /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/u.exec(
        normalized,
      );
    if (!localMatch) return '';
    const candidate = `${localMatch[1]}T${localMatch[2]}`;
    return parseShanghaiDateTimeInput(candidate) === null ? '' : candidate;
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp)
    ? formatShanghaiDateTimeInput(timestamp)
    : '';
}

function parseShanghaiDateTimeInput(value: string): number | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute !== 0
  ) {
    return null;
  }

  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour - 8, minute, 0, 0);
  const timestamp = utc.getTime();
  if (!Number.isFinite(timestamp)) return null;
  return formatShanghaiDateTimeInput(timestamp) === value.trim()
    ? timestamp
    : null;
}

function formatShanghaiDateTimeInput(timestamp: number): string {
  const shanghai = new Date(timestamp + SHANGHAI_OFFSET_MS);
  if (!Number.isFinite(shanghai.getTime())) return '';
  return `${String(shanghai.getUTCFullYear()).padStart(4, '0')}-${String(
    shanghai.getUTCMonth() + 1,
  ).padStart(
    2,
    '0',
  )}-${String(shanghai.getUTCDate()).padStart(2, '0')}T${String(
    shanghai.getUTCHours(),
  ).padStart(2, '0')}:${String(shanghai.getUTCMinutes()).padStart(2, '0')}`;
}

function toShanghaiIsoString(value: string): string {
  return `${value}:00+08:00`;
}
