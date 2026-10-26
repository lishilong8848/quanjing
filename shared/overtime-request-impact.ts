import { getChinaWorkdayInfo } from './china-work-calendar';
import {
  containsExactPersonName,
  resolveLeaveScheduleKind,
  type LeaveRequestImpactSchedule,
  type LeaveScheduleKind,
} from './leave-request-impact';

export interface OvertimeRequestImpactSchedule extends LeaveRequestImpactSchedule {
  personText?: string;
  dutyStaffReference?: string[];
  leaveStaff?: string[];
  substituteStaff?: string[];
}

export interface OvertimeRequestImpactRequest {
  staffName: string;
  startAt: string;
  endAt: string;
  staffShift?: string | null;
}

export interface OvertimeRequestConflictingSchedule {
  recordId: string;
  date: string;
  building: string;
  team: string;
  shift: string;
  overlapHours: number;
}

export type OvertimeRequestInvalidRangeReason =
  | 'invalid_start_at'
  | 'invalid_end_at'
  | 'not_whole_hour'
  | 'end_not_after_start'
  | 'below_minimum_hours'
  | 'long_white_workday_hours'
  | 'continuous_duty_24_hours'
  | 'calendar_data_missing';

export interface OvertimeRequestImpact {
  rawHours: number;
  payableHours: number;
  conflictingSchedules: OvertimeRequestConflictingSchedule[];
  isWholeHour: boolean;
  invalidRangeReason: OvertimeRequestInvalidRangeReason | null;
  canSubmit: boolean;
}

interface ParsedZonedDateTime {
  epochMs: number;
  isWholeHour: boolean;
}

interface ShiftWindowOffset {
  startHour: number;
  endHour: number;
}

interface TimeInterval {
  startMs: number;
  endMs: number;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const MAX_CONTINUOUS_DUTY_MS = 24 * HOUR_MS;
const MAX_CONFIRMATION_HOURS = 72;
const LUNCH_START_HOUR = 12;
const LUNCH_END_HOUR = 13;

const SCHEDULE_WINDOWS: Readonly<
  Record<LeaveScheduleKind, readonly ShiftWindowOffset[]>
> = {
  white: [
    { startHour: 9, endHour: 12 },
    { startHour: 13, endHour: 18 },
  ],
  night: [{ startHour: 18, endHour: 24 + 9 }],
  long_white: [
    { startHour: 9, endHour: 12 },
    { startHour: 13, endHour: 18 },
  ],
  station_110_white: [{ startHour: 8, endHour: 20 }],
  station_110_night: [{ startHour: 20, endHour: 24 + 8 }],
};

const POTENTIAL_SCHEDULE_WINDOWS: readonly ShiftWindowOffset[] = [
  { startHour: 8, endHour: 24 + 9 },
];

const LONG_WHITE_ALIASES = new Set([
  '长白',
  '长白班',
  'long_white',
  'longwhite',
  'long_white_shift',
  'longwhiteshift',
  'changbai',
  'changbai_shift',
]);

function createEmptyImpact(
  invalidRangeReason: OvertimeRequestInvalidRangeReason,
): OvertimeRequestImpact {
  return {
    rawHours: 0,
    payableHours: 0,
    conflictingSchedules: [],
    isWholeHour: false,
    invalidRangeReason,
    canSubmit: false,
  };
}

function parseZonedDateTime(value: string): ParsedZonedDateTime | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, secondValue, fractionValue, zone] =
    match;
  const second = secondValue || '00';
  const millisecond = (fractionValue || '').padEnd(3, '0') || '000';
  const wallClockValue = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
  const wallClockMs = Date.parse(wallClockValue);
  if (
    Number.isNaN(wallClockMs) ||
    new Date(wallClockMs).toISOString() !== wallClockValue
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour === 14 && offsetMinute !== 0) {
      return null;
    }
    const direction = zone[0] === '+' ? 1 : -1;
    offsetMinutes = direction * (offsetHour * 60 + offsetMinute);
  }

  const epochMs = wallClockMs - offsetMinutes * MINUTE_MS;
  const isShanghaiWholeHour =
    (((epochMs + SHANGHAI_OFFSET_MS) % HOUR_MS) + HOUR_MS) % HOUR_MS === 0;

  return {
    epochMs,
    isWholeHour: isShanghaiWholeHour,
  };
}

function getShanghaiScheduleDayStart(
  scheduleDate: string | null,
): number | null {
  if (!scheduleDate || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate)) {
    return null;
  }

  const wallClockValue = `${scheduleDate}T00:00:00.000Z`;
  const wallClockMs = Date.parse(wallClockValue);
  if (
    Number.isNaN(wallClockMs) ||
    new Date(wallClockMs).toISOString() !== wallClockValue
  ) {
    return null;
  }
  return wallClockMs - SHANGHAI_OFFSET_MS;
}

export function calculateOvertimePayableHours(
  startEpochMs: number,
  endEpochMs: number,
): number {
  if (
    !Number.isFinite(startEpochMs) ||
    !Number.isFinite(endEpochMs) ||
    endEpochMs <= startEpochMs
  ) {
    return 0;
  }

  const firstShanghaiDay = Math.floor(
    (startEpochMs + SHANGHAI_OFFSET_MS) / DAY_MS,
  );
  const lastShanghaiDay = Math.floor(
    (endEpochMs - 1 + SHANGHAI_OFFSET_MS) / DAY_MS,
  );
  let unpaidLunchMs = 0;

  for (let day = firstShanghaiDay; day <= lastShanghaiDay; day += 1) {
    const dayStartMs = day * DAY_MS - SHANGHAI_OFFSET_MS;
    const lunchStartMs = dayStartMs + LUNCH_START_HOUR * HOUR_MS;
    const lunchEndMs = dayStartMs + LUNCH_END_HOUR * HOUR_MS;
    unpaidLunchMs += Math.max(
      0,
      Math.min(endEpochMs, lunchEndMs) - Math.max(startEpochMs, lunchStartMs),
    );
  }

  return (endEpochMs - startEpochMs - unpaidLunchMs) / HOUR_MS;
}

export function addOvertimePayableHours(
  startEpochMs: number,
  payableHours: number,
): number | null {
  const isShanghaiWholeHour =
    Number.isFinite(startEpochMs) &&
    (((startEpochMs + SHANGHAI_OFFSET_MS) % HOUR_MS) + HOUR_MS) % HOUR_MS === 0;
  if (
    !isShanghaiWholeHour ||
    !Number.isSafeInteger(payableHours) ||
    payableHours < 0 ||
    payableHours > MAX_CONFIRMATION_HOURS
  ) {
    return null;
  }

  let endEpochMs = startEpochMs;
  let remainingHours = payableHours;
  while (remainingHours > 0) {
    const shanghaiHour = Math.floor(
      ((((endEpochMs + SHANGHAI_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS) /
        HOUR_MS,
    );
    endEpochMs += HOUR_MS;
    if (shanghaiHour < LUNCH_START_HOUR || shanghaiHour >= LUNCH_END_HOUR) {
      remainingHours -= 1;
    }
  }
  return endEpochMs;
}

function getDisplayValue(...values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() || '';
}

function containsStaffName(
  values: readonly string[] | undefined,
  staffName: string,
): boolean {
  return Boolean(
    values?.some((value) =>
      containsExactPersonName(String(value || ''), staffName),
    ),
  );
}

function isApprovedSubstituteAssignment(
  schedule: OvertimeRequestImpactSchedule,
  staffName: string,
): boolean {
  if (!containsStaffName(schedule.substituteStaff, staffName)) {
    return false;
  }

  const belongsToOriginalRoster =
    containsStaffName(schedule.dutyStaffReference, staffName) ||
    containsExactPersonName(schedule.personText || '', staffName);
  return !belongsToOriginalRoster;
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareConflictingSchedules(
  left: OvertimeRequestConflictingSchedule,
  right: OvertimeRequestConflictingSchedule,
): number {
  return (
    compareText(left.date, right.date) ||
    compareText(left.building, right.building) ||
    compareText(left.team, right.team) ||
    compareText(left.shift, right.shift) ||
    compareText(left.recordId, right.recordId) ||
    left.overlapHours - right.overlapHours
  );
}

function calculateScheduleOverlapHours(
  dayStartMs: number,
  windows: readonly ShiftWindowOffset[],
  requestStartMs: number,
  requestEndMs: number,
): number {
  return windows.reduce((total, window) => {
    const overlapStart = Math.max(
      dayStartMs + window.startHour * HOUR_MS,
      requestStartMs,
    );
    const overlapEnd = Math.min(
      dayStartMs + window.endHour * HOUR_MS,
      requestEndMs,
    );
    return total + Math.max(0, overlapEnd - overlapStart) / HOUR_MS;
  }, 0);
}

function normalizeShiftAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '').replace(/-/g, '_');
}

function isLongWhiteStaffShift(value: string): boolean {
  return LONG_WHITE_ALIASES.has(normalizeShiftAlias(value));
}

function resolveOvertimeStaffMode(
  relatedSchedules: OvertimeRequestImpactSchedule[],
  staffShift: string | null | undefined,
): 'long_white' | 'continuous_duty' | null {
  const explicitStaffShift = staffShift?.trim() || '';
  if (explicitStaffShift) {
    return isLongWhiteStaffShift(explicitStaffShift)
      ? 'long_white'
      : 'continuous_duty';
  }

  const recognizedKinds = relatedSchedules
    .map(resolveLeaveScheduleKind)
    .filter((kind): kind is LeaveScheduleKind => kind !== null);
  if (
    recognizedKinds.length > 0 &&
    recognizedKinds.every((kind) => kind === 'long_white')
  ) {
    return 'long_white';
  }
  if (recognizedKinds.some((kind) => kind !== 'long_white')) {
    return 'continuous_duty';
  }
  return null;
}

function getLongWhiteInvalidRangeReason(
  requestStartMs: number,
  requestEndMs: number,
): OvertimeRequestInvalidRangeReason | null {
  const firstShanghaiDayStart =
    Math.floor((requestStartMs + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS;
  const shanghaiEndMs = requestEndMs + SHANGHAI_OFFSET_MS;
  let hasMissingCalendarData = false;
  let overlapsWorkdayHours = false;

  for (
    let shanghaiDayStart = firstShanghaiDayStart;
    shanghaiDayStart < shanghaiEndMs;
    shanghaiDayStart += DAY_MS
  ) {
    const dateKey = new Date(shanghaiDayStart).toISOString().slice(0, 10);
    const workdayInfo = getChinaWorkdayInfo(dateKey);
    if (!workdayInfo.supported) {
      hasMissingCalendarData = true;
      continue;
    }
    if (!workdayInfo.isWorkday) {
      continue;
    }

    const dayStartMs = shanghaiDayStart - SHANGHAI_OFFSET_MS;
    const overlapStart = Math.max(requestStartMs, dayStartMs + 9 * HOUR_MS);
    const overlapEnd = Math.min(requestEndMs, dayStartMs + 18 * HOUR_MS);
    if (overlapEnd > overlapStart) {
      overlapsWorkdayHours = true;
    }
  }

  if (hasMissingCalendarData) {
    return 'calendar_data_missing';
  }
  return overlapsWorkdayHours ? 'long_white_workday_hours' : null;
}

function getScheduleEnvelope(kind: LeaveScheduleKind): ShiftWindowOffset {
  return SCHEDULE_WINDOWS[kind].reduce<ShiftWindowOffset>(
    (envelope, window) => ({
      startHour: Math.min(envelope.startHour, window.startHour),
      endHour: Math.max(envelope.endHour, window.endHour),
    }),
    {
      startHour: Number.POSITIVE_INFINITY,
      endHour: Number.NEGATIVE_INFINITY,
    },
  );
}

function mergeTouchingIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const sortedIntervals = [...intervals].sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
  );
  const mergedIntervals: TimeInterval[] = [];

  for (const interval of sortedIntervals) {
    if (interval.endMs <= interval.startMs) {
      continue;
    }
    const previous = mergedIntervals[mergedIntervals.length - 1];
    if (!previous || interval.startMs > previous.endMs) {
      mergedIntervals.push({ ...interval });
      continue;
    }
    previous.endMs = Math.max(previous.endMs, interval.endMs);
  }

  return mergedIntervals;
}

function hasContinuousDutyOfAtLeast24Hours(
  relatedSchedules: OvertimeRequestImpactSchedule[],
  requestStartMs: number,
  requestEndMs: number,
): boolean {
  const intervals: TimeInterval[] = [
    { startMs: requestStartMs, endMs: requestEndMs },
  ];

  for (const schedule of relatedSchedules) {
    const kind = resolveLeaveScheduleKind(schedule);
    if (!kind || kind === 'long_white') {
      continue;
    }
    const dayStartMs = getShanghaiScheduleDayStart(schedule.scheduleDate);
    if (dayStartMs === null) {
      continue;
    }
    const envelope = getScheduleEnvelope(kind);
    intervals.push({
      startMs: dayStartMs + envelope.startHour * HOUR_MS,
      endMs: dayStartMs + envelope.endHour * HOUR_MS,
    });
  }

  const requestSegment = mergeTouchingIntervals(intervals).find(
    (interval) =>
      interval.startMs <= requestStartMs && interval.endMs >= requestEndMs,
  );
  return Boolean(
    requestSegment &&
    requestSegment.endMs - requestSegment.startMs >= MAX_CONTINUOUS_DUTY_MS,
  );
}

export function calculateOvertimeRequestImpact(
  schedules: OvertimeRequestImpactSchedule[],
  request: OvertimeRequestImpactRequest,
): OvertimeRequestImpact {
  const start = parseZonedDateTime(request?.startAt || '');
  if (!start) {
    return createEmptyImpact('invalid_start_at');
  }

  const end = parseZonedDateTime(request?.endAt || '');
  if (!end) {
    return createEmptyImpact('invalid_end_at');
  }

  const durationMs = end.epochMs - start.epochMs;
  const rawHours = durationMs > 0 ? durationMs / HOUR_MS : 0;
  const payableHours = calculateOvertimePayableHours(
    start.epochMs,
    end.epochMs,
  );
  const isWholeHour =
    start.isWholeHour && end.isWholeHour && Number.isInteger(rawHours);

  if (!isWholeHour) {
    return {
      rawHours,
      payableHours: 0,
      conflictingSchedules: [],
      isWholeHour: false,
      invalidRangeReason: 'not_whole_hour',
      canSubmit: false,
    };
  }

  if (durationMs <= 0) {
    return {
      rawHours: 0,
      payableHours: 0,
      conflictingSchedules: [],
      isWholeHour: true,
      invalidRangeReason: 'end_not_after_start',
      canSubmit: false,
    };
  }

  if (payableHours < 1) {
    return {
      rawHours,
      payableHours,
      conflictingSchedules: [],
      isWholeHour: true,
      invalidRangeReason: 'below_minimum_hours',
      canSubmit: false,
    };
  }

  const staffName = request.staffName?.trim() || '';
  const relatedSchedules = staffName
    ? schedules.filter((schedule) =>
        schedule.dutyStaffActual.some((name) =>
          containsExactPersonName(name || '', staffName),
        ),
      )
    : [];
  const staffMode = resolveOvertimeStaffMode(
    relatedSchedules,
    request.staffShift,
  );
  const conflictingSchedules: OvertimeRequestConflictingSchedule[] = [];

  if (staffName) {
    for (const schedule of relatedSchedules) {
      const kind = resolveLeaveScheduleKind(schedule);
      const dayStartMs = getShanghaiScheduleDayStart(schedule.scheduleDate);
      if (dayStartMs === null) {
        continue;
      }

      if (kind === 'long_white') {
        const workdayInfo = getChinaWorkdayInfo(schedule.scheduleDate || '');
        if (
          workdayInfo.supported &&
          (workdayInfo.kind === 'holiday' ||
            workdayInfo.kind === 'weekend_rest')
        ) {
          continue;
        }
      }

      const overlapHours = calculateScheduleOverlapHours(
        dayStartMs,
        kind ? SCHEDULE_WINDOWS[kind] : POTENTIAL_SCHEDULE_WINDOWS,
        start.epochMs,
        end.epochMs,
      );
      if (overlapHours <= 0) {
        continue;
      }

      if (isApprovedSubstituteAssignment(schedule, staffName)) {
        continue;
      }

      conflictingSchedules.push({
        recordId: schedule.recordId,
        date: schedule.scheduleDate || '',
        building: getDisplayValue(schedule.buildingText, schedule.building),
        team: getDisplayValue(schedule.teamText, schedule.team),
        shift: getDisplayValue(schedule.shiftText, schedule.shift),
        overlapHours,
      });
    }
  }

  conflictingSchedules.sort(compareConflictingSchedules);
  let invalidRangeReason: OvertimeRequestInvalidRangeReason | null = null;
  if (staffMode === 'long_white') {
    invalidRangeReason = getLongWhiteInvalidRangeReason(
      start.epochMs,
      end.epochMs,
    );
  } else if (
    staffMode === 'continuous_duty' &&
    conflictingSchedules.length === 0 &&
    hasContinuousDutyOfAtLeast24Hours(
      relatedSchedules,
      start.epochMs,
      end.epochMs,
    )
  ) {
    invalidRangeReason = 'continuous_duty_24_hours';
  }

  return {
    rawHours,
    payableHours,
    conflictingSchedules,
    isWholeHour: true,
    invalidRangeReason,
    canSubmit:
      Boolean(staffName) &&
      conflictingSchedules.length === 0 &&
      invalidRangeReason === null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function createOvertimeRequestImpactComparisonKey(
  impact: unknown,
): string | null {
  if (
    !isRecord(impact) ||
    !isFiniteNonNegativeNumber(impact.rawHours) ||
    !isFiniteNonNegativeNumber(impact.payableHours) ||
    !Array.isArray(impact.conflictingSchedules) ||
    typeof impact.isWholeHour !== 'boolean' ||
    typeof impact.canSubmit !== 'boolean'
  ) {
    return null;
  }

  const invalidRangeReasons = new Set<OvertimeRequestInvalidRangeReason>([
    'invalid_start_at',
    'invalid_end_at',
    'not_whole_hour',
    'end_not_after_start',
    'below_minimum_hours',
    'long_white_workday_hours',
    'continuous_duty_24_hours',
    'calendar_data_missing',
  ]);
  const invalidRangeReason = impact.invalidRangeReason;
  if (
    invalidRangeReason !== null &&
    (typeof invalidRangeReason !== 'string' ||
      !invalidRangeReasons.has(
        invalidRangeReason as OvertimeRequestInvalidRangeReason,
      ))
  ) {
    return null;
  }

  const conflictingSchedules: OvertimeRequestConflictingSchedule[] = [];
  for (const item of impact.conflictingSchedules) {
    if (
      !isRecord(item) ||
      typeof item.recordId !== 'string' ||
      typeof item.date !== 'string' ||
      typeof item.building !== 'string' ||
      typeof item.team !== 'string' ||
      typeof item.shift !== 'string' ||
      !isFiniteNonNegativeNumber(item.overlapHours)
    ) {
      return null;
    }
    conflictingSchedules.push({
      recordId: item.recordId,
      date: item.date,
      building: item.building,
      team: item.team,
      shift: item.shift,
      overlapHours: item.overlapHours,
    });
  }

  return JSON.stringify({
    rawHours: impact.rawHours,
    payableHours: impact.payableHours,
    conflictingSchedules: conflictingSchedules.sort(
      compareConflictingSchedules,
    ),
    isWholeHour: impact.isWholeHour,
    invalidRangeReason,
    canSubmit: impact.canSubmit,
  });
}
