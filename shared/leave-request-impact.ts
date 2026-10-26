import { getChinaWorkdayInfo } from './china-work-calendar';

export interface LeaveRequestImpactSchedule {
  recordId: string;
  scheduleDate: string | null;
  building?: string;
  buildingText?: string;
  team?: string;
  teamText?: string;
  shift?: string;
  shiftText?: string;
  dutyStaffActual: string[];
}

export interface LeaveRequestImpactRequest {
  leaveStaffName: string;
  startAt: string;
  endAt: string;
}

export interface LeaveRequestSubstituteRule {
  requiresSubstitute: boolean;
  blockedStaffNames: string[];
}

export interface LeaveRequestTimeCandidates {
  startOptions: string[];
  endOptions: string[];
  fullShiftRanges: Array<{
    startAt: string;
    endAt: string;
  }>;
  shiftRanges: LeaveRequestShiftRange[];
}

export interface ParsedShanghaiLocalDateTime {
  value: string;
  dateKey: string;
  wallClockHourIndex: number;
  epochMs: number;
}

export type LeaveScheduleKind =
  | 'white'
  | 'night'
  | 'long_white'
  | 'station_110_white'
  | 'station_110_night';

export interface LeaveRequestShiftRange {
  scheduleDate: string;
  kind: LeaveScheduleKind;
  startAt: string;
  endAt: string;
}

export interface LeaveRequestAffectedSchedule {
  recordId: string;
  date: string;
  building: string;
  team: string;
  shift: string;
  kind?: LeaveScheduleKind | null;
  scheduledHours: number;
  leaveHours: number;
  countedHours: number;
}

export interface LeaveRequestShiftGroup {
  shiftKey: string;
  scheduleDate: string;
  startAt: string;
  endAt: string;
  kind: LeaveScheduleKind;
  shift: string;
  buildings: string[];
  teams: string[];
  scheduleRecordIds: string[];
  leaveHours: number;
}

export type LeaveRequestExclusionReason =
  | 'holiday'
  | 'weekend_rest'
  | 'calendar_data_missing';

export interface LeaveRequestExcludedSchedule {
  recordId: string;
  date: string;
  reason: LeaveRequestExclusionReason;
}

export type LeaveRequestInvalidRangeReason =
  | 'invalid_start_at'
  | 'invalid_end_at'
  | 'end_not_after_start';

export interface LeaveRequestImpact {
  affectedSchedules: LeaveRequestAffectedSchedule[];
  excludedSchedules: LeaveRequestExcludedSchedule[];
  rawHours: number;
  minimumHours: number;
  unrecognizedShifts: string[];
  missingCalendarYears: string[];
  invalidRange: boolean;
  invalidRangeReason: LeaveRequestInvalidRangeReason | null;
}

interface HourInterval {
  start: number;
  end: number;
}

interface ShiftWindowOffset {
  startHour: number;
  endHour: number;
}

const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

const WHITE_WINDOWS: readonly ShiftWindowOffset[] = [
  { startHour: 9, endHour: 12 },
  { startHour: 13, endHour: 18 },
];

const SCHEDULE_WINDOWS: Readonly<
  Record<LeaveScheduleKind, readonly ShiftWindowOffset[]>
> = {
  white: WHITE_WINDOWS,
  night: [{ startHour: 18, endHour: 24 + 9 }],
  long_white: WHITE_WINDOWS,
  station_110_white: [{ startHour: 8, endHour: 20 }],
  station_110_night: [{ startHour: 20, endHour: 24 + 8 }],
};

const POTENTIAL_SCHEDULE_WINDOW = Object.values(SCHEDULE_WINDOWS).reduce(
  (envelope, windows) =>
    windows.reduce<ShiftWindowOffset>(
      (current, window) => ({
        startHour: Math.min(current.startHour, window.startHour),
        endHour: Math.max(current.endHour, window.endHour),
      }),
      envelope,
    ),
  {
    startHour: Number.POSITIVE_INFINITY,
    endHour: Number.NEGATIVE_INFINITY,
  },
);

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

const WHITE_ALIASES = new Set([
  '白',
  '白班',
  'white',
  'white_shift',
  'whiteshift',
]);

const NIGHT_ALIASES = new Set([
  '夜',
  '夜班',
  'night',
  'night_shift',
  'nightshift',
]);

function createEmptyImpact(
  invalidRange = false,
  invalidRangeReason: LeaveRequestInvalidRangeReason | null = null,
): LeaveRequestImpact {
  return {
    affectedSchedules: [],
    excludedSchedules: [],
    rawHours: 0,
    minimumHours: 0,
    unrecognizedShifts: [],
    missingCalendarYears: [],
    invalidRange,
    invalidRangeReason,
  };
}

export function parseShanghaiLocalDateTime(
  value: string,
): ParsedShanghaiLocalDateTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):00$/.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour] = match;
  const dateKey = `${year}-${month}-${day}`;
  const wallClockValue = `${dateKey}T${hour}:00:00.000Z`;
  const wallClockMs = Date.parse(wallClockValue);
  if (
    Number.isNaN(wallClockMs) ||
    new Date(wallClockMs).toISOString() !== wallClockValue
  ) {
    return null;
  }

  return {
    value,
    dateKey,
    wallClockHourIndex: wallClockMs / HOUR_MS,
    epochMs: wallClockMs - SHANGHAI_OFFSET_MS,
  };
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '').replace(/-/g, '_');
}

function getCandidateValues(...values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim() || '')
    .filter((value) => value.length > 0);
}

function hasAlias(values: string[], aliases: ReadonlySet<string>): boolean {
  return values.some((value) => aliases.has(normalizeAlias(value)));
}

function isStation110Value(value: string): boolean {
  return /(?:^|\D)110(?:\D|$)/.test(normalizeAlias(value));
}

export function resolveLeaveScheduleKind(
  schedule: LeaveRequestImpactSchedule,
): LeaveScheduleKind | null {
  const teamValues = getCandidateValues(schedule.teamText, schedule.team);
  const shiftValues = getCandidateValues(schedule.shiftText, schedule.shift);
  const isLongWhite = hasAlias(
    [...teamValues, ...shiftValues],
    LONG_WHITE_ALIASES,
  );
  const isWhite = hasAlias(shiftValues, WHITE_ALIASES);
  const isNight = hasAlias(shiftValues, NIGHT_ALIASES);
  const isStation110 = getCandidateValues(
    schedule.buildingText,
    schedule.building,
  ).some(isStation110Value);

  if (isStation110) {
    if (isWhite && isNight) {
      return null;
    }
    if (isNight) {
      return 'station_110_night';
    }
    if (isWhite || isLongWhite) {
      return 'station_110_white';
    }
    return null;
  }

  if (isLongWhite) {
    return 'long_white';
  }
  if (isWhite === isNight) {
    return null;
  }

  return isWhite ? 'white' : 'night';
}

function normalizePersonName(value: string): string {
  return value.replace(/\s+/g, '');
}

function splitPersonNames(value: string): string[] {
  return value
    .split(/[\s、,，;；/]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function containsExactPersonName(
  value: string,
  targetName: string,
): boolean {
  const normalizedTargetName = normalizePersonName(targetName);
  if (!normalizedTargetName) {
    return false;
  }
  if (normalizePersonName(value) === normalizedTargetName) {
    return true;
  }

  return splitPersonNames(value).some(
    (name) => normalizePersonName(name) === normalizedTargetName,
  );
}

function getDisplayValue(...values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() || '';
}

function getUnrecognizedShiftLabel(
  schedule: LeaveRequestImpactSchedule,
): string {
  const candidates = getCandidateValues(schedule.shiftText, schedule.shift);
  return [...new Set(candidates)].join(' / ') || '(空)';
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function compareCanonicalValue(left: unknown, right: unknown): number {
  return compareText(JSON.stringify(left), JSON.stringify(right));
}

export function createLeaveRequestImpactComparisonKey(
  impact: unknown,
): string | null {
  if (
    !isRecord(impact) ||
    !Array.isArray(impact.affectedSchedules) ||
    !Array.isArray(impact.excludedSchedules) ||
    !isFiniteNumber(impact.rawHours) ||
    !isFiniteNumber(impact.minimumHours) ||
    !isStringArray(impact.unrecognizedShifts) ||
    !isStringArray(impact.missingCalendarYears) ||
    typeof impact.invalidRange !== 'boolean'
  ) {
    return null;
  }

  const affectedSchedules: LeaveRequestAffectedSchedule[] = [];
  for (const item of impact.affectedSchedules) {
    if (
      !isRecord(item) ||
      typeof item.recordId !== 'string' ||
      typeof item.date !== 'string' ||
      typeof item.building !== 'string' ||
      typeof item.team !== 'string' ||
      typeof item.shift !== 'string' ||
      !isFiniteNumber(item.scheduledHours) ||
      !isFiniteNumber(item.leaveHours) ||
      !isFiniteNumber(item.countedHours)
    ) {
      return null;
    }
    affectedSchedules.push({
      recordId: item.recordId,
      date: item.date,
      building: item.building,
      team: item.team,
      shift: item.shift,
      scheduledHours: item.scheduledHours,
      leaveHours: item.leaveHours,
      countedHours: item.countedHours,
    });
  }

  const exclusionReasons = new Set<LeaveRequestExclusionReason>([
    'holiday',
    'weekend_rest',
    'calendar_data_missing',
  ]);
  const excludedSchedules: LeaveRequestExcludedSchedule[] = [];
  for (const item of impact.excludedSchedules) {
    if (
      !isRecord(item) ||
      typeof item.recordId !== 'string' ||
      typeof item.date !== 'string' ||
      typeof item.reason !== 'string' ||
      !exclusionReasons.has(item.reason as LeaveRequestExclusionReason)
    ) {
      return null;
    }
    excludedSchedules.push({
      recordId: item.recordId,
      date: item.date,
      reason: item.reason as LeaveRequestExclusionReason,
    });
  }

  const invalidRangeReasons = new Set<LeaveRequestInvalidRangeReason>([
    'invalid_start_at',
    'invalid_end_at',
    'end_not_after_start',
  ]);
  const invalidRangeReason = impact.invalidRangeReason;
  if (
    (impact.invalidRange &&
      (typeof invalidRangeReason !== 'string' ||
        !invalidRangeReasons.has(
          invalidRangeReason as LeaveRequestInvalidRangeReason,
        ))) ||
    (!impact.invalidRange && invalidRangeReason !== null)
  ) {
    return null;
  }

  return JSON.stringify({
    affectedSchedules: affectedSchedules.sort(compareCanonicalValue),
    excludedSchedules: excludedSchedules.sort(compareCanonicalValue),
    rawHours: impact.rawHours,
    minimumHours: impact.minimumHours,
    unrecognizedShifts: [...impact.unrecognizedShifts].sort(compareText),
    missingCalendarYears: [...impact.missingCalendarYears].sort(compareText),
    invalidRange: impact.invalidRange,
    invalidRangeReason,
  });
}

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function getScheduleSortWindow(
  kind: LeaveScheduleKind | null,
): ShiftWindowOffset | null {
  if (!kind) {
    return null;
  }

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

function compareImpactSchedules(
  left: LeaveRequestImpactSchedule,
  right: LeaveRequestImpactSchedule,
): number {
  const leftKind = resolveLeaveScheduleKind(left);
  const rightKind = resolveLeaveScheduleKind(right);
  const leftWindow = getScheduleSortWindow(leftKind);
  const rightWindow = getScheduleSortWindow(rightKind);

  return (
    compareText(left.scheduleDate || '', right.scheduleDate || '') ||
    compareNumber(
      leftWindow?.startHour ?? Number.POSITIVE_INFINITY,
      rightWindow?.startHour ?? Number.POSITIVE_INFINITY,
    ) ||
    compareNumber(
      rightWindow?.endHour ?? Number.NEGATIVE_INFINITY,
      leftWindow?.endHour ?? Number.NEGATIVE_INFINITY,
    ) ||
    compareText(leftKind || 'unknown', rightKind || 'unknown') ||
    compareText(
      getDisplayValue(left.buildingText, left.building),
      getDisplayValue(right.buildingText, right.building),
    ) ||
    compareText(
      getDisplayValue(left.teamText, left.team),
      getDisplayValue(right.teamText, right.team),
    ) ||
    compareText(
      getDisplayValue(left.shiftText, left.shift),
      getDisplayValue(right.shiftText, right.shift),
    ) ||
    compareText(left.recordId, right.recordId)
  );
}

function getScheduleDayStartHourIndex(
  scheduleDate: string | null,
): number | null {
  if (!scheduleDate) {
    return null;
  }
  return (
    parseShanghaiLocalDateTime(`${scheduleDate}T00:00`)?.wallClockHourIndex ??
    null
  );
}

export function createLeaveRequestShiftGroups(
  affectedSchedules: LeaveRequestAffectedSchedule[],
): LeaveRequestShiftGroup[] {
  const groups = new Map<string, LeaveRequestShiftGroup>();
  const sortedSchedules = [...affectedSchedules].sort(
    (left, right) =>
      compareText(left.date, right.date) ||
      compareText(left.recordId, right.recordId),
  );

  for (const affected of sortedSchedules) {
    const schedule: LeaveRequestImpactSchedule = {
      recordId: affected.recordId,
      scheduleDate: affected.date,
      building: affected.building,
      team: affected.team,
      shift: affected.shift,
      dutyStaffActual: [],
    };
    const kind =
      affected.kind === undefined
        ? resolveLeaveScheduleKind(schedule)
        : affected.kind;
    const envelope = getScheduleSortWindow(kind);
    const dayStart = getScheduleDayStartHourIndex(affected.date);
    if (!kind || !envelope || dayStart === null) {
      throw new Error(`无法识别受影响班次：${affected.date} ${affected.shift}`);
    }

    const startAt = formatShanghaiWallClockHour(dayStart + envelope.startHour);
    const endAt = formatShanghaiWallClockHour(dayStart + envelope.endHour);
    const shiftKey = `${startAt}__${endAt}`;
    const current = groups.get(shiftKey) || {
      shiftKey,
      scheduleDate: affected.date,
      startAt,
      endAt,
      kind,
      shift: affected.shift.trim(),
      buildings: [],
      teams: [],
      scheduleRecordIds: [],
      leaveHours: 0,
    };

    current.buildings = sortedUnique([...current.buildings, affected.building]);
    current.teams = sortedUnique([...current.teams, affected.team]);
    current.scheduleRecordIds = sortedUnique([
      ...current.scheduleRecordIds,
      affected.recordId,
    ]);
    current.leaveHours = Math.max(current.leaveHours, affected.leaveHours);
    groups.set(shiftKey, current);
  }

  return [...groups.values()].sort((left, right) =>
    compareText(left.startAt, right.startAt),
  );
}

function formatShanghaiWallClockHour(hourIndex: number): string {
  return `${new Date(hourIndex * HOUR_MS).toISOString().slice(0, 13)}:00`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    compareText,
  );
}

function mergeHourIntervals(intervals: HourInterval[]): HourInterval[] {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: HourInterval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
    } else if (interval.end > last.end) {
      last.end = interval.end;
    }
  }

  return merged;
}

function sumIntervalHours(intervals: HourInterval[]): number {
  return intervals.reduce(
    (total, interval) => total + interval.end - interval.start,
    0,
  );
}

function sumIntervalOverlapHours(
  intervals: HourInterval[],
  requestStart: number,
  requestEnd: number,
): number {
  let total = 0;
  for (const interval of intervals) {
    if (interval.end <= requestStart) {
      continue;
    }
    if (interval.start >= requestEnd) {
      break;
    }
    total +=
      Math.min(interval.end, requestEnd) -
      Math.max(interval.start, requestStart);
  }
  return total;
}

function intersectsHourIntervals(
  intervals: HourInterval[],
  requestStart: number,
  requestEnd: number,
): boolean {
  return intervals.some(
    (interval) =>
      Math.min(interval.end, requestEnd) >
      Math.max(interval.start, requestStart),
  );
}

function intersectScheduleWindows(
  dayStartHourIndex: number,
  windows: readonly ShiftWindowOffset[],
  requestStart: number,
  requestEnd: number,
): HourInterval[] {
  const intersections = windows
    .map(({ startHour, endHour }) => ({
      start: Math.max(dayStartHourIndex + startHour, requestStart),
      end: Math.min(dayStartHourIndex + endHour, requestEnd),
    }))
    .filter((interval) => interval.end > interval.start);

  return mergeHourIntervals(intersections);
}

function getScheduledHours(kind: LeaveScheduleKind): number {
  return SCHEDULE_WINDOWS[kind].reduce(
    (total, window) => total + window.endHour - window.startHour,
    0,
  );
}

function formatWallClockHour(hourIndex: number): string {
  return `${new Date(hourIndex * HOUR_MS).toISOString().slice(0, 13)}:00`;
}

export function selectDefaultLeaveTimeRange<
  T extends { startAt: string; endAt: string },
>(ranges: readonly T[], notBeforeDateKey: string): T | null {
  const notBeforeAt = `${notBeforeDateKey}T00:00`;
  if (!parseShanghaiLocalDateTime(notBeforeAt)) {
    return null;
  }

  return (
    [...ranges]
      .filter(
        (range) =>
          Boolean(parseShanghaiLocalDateTime(range.startAt)) &&
          Boolean(parseShanghaiLocalDateTime(range.endAt)) &&
          range.endAt > range.startAt,
      )
      .sort(
        (left, right) =>
          compareText(left.startAt, right.startAt) ||
          compareText(left.endAt, right.endAt),
      )
      .find((range) => range.startAt >= notBeforeAt) ?? null
  );
}

export function selectDefaultLeaveEndAt<
  T extends { startAt: string; endAt: string },
>(
  shiftRanges: readonly T[],
  selectedStartAt: string,
  endOptions: readonly string[],
): string {
  const selectedStart = parseShanghaiLocalDateTime(selectedStartAt);
  if (!selectedStart) {
    return '';
  }

  const validEndOptions = endOptions.filter((endAt) => {
    const end = parseShanghaiLocalDateTime(endAt);
    return Boolean(
      end && end.wallClockHourIndex > selectedStart.wallClockHourIndex,
    );
  });
  if (validEndOptions.length === 0) {
    return '';
  }

  const validEndOptionSet = new Set(validEndOptions);
  const matchingShift = [...shiftRanges]
    .filter((range) => {
      const rangeStart = parseShanghaiLocalDateTime(range.startAt);
      const rangeEnd = parseShanghaiLocalDateTime(range.endAt);
      return Boolean(
        rangeStart &&
          rangeEnd &&
          rangeStart.wallClockHourIndex <= selectedStart.wallClockHourIndex &&
          selectedStart.wallClockHourIndex < rangeEnd.wallClockHourIndex &&
          validEndOptionSet.has(range.endAt),
      );
    })
    .sort((left, right) => left.endAt.localeCompare(right.endAt))[0];

  return matchingShift?.endAt || validEndOptions[0] || '';
}

export function createLeaveRequestTimeCandidates(
  schedules: LeaveRequestImpactSchedule[],
  options: {
    leaveStaffName: string;
    selectedStartAt?: string;
  },
): LeaveRequestTimeCandidates {
  const leaveStaffName = normalizePersonName(options?.leaveStaffName || '');
  if (!leaveStaffName) {
    return {
      startOptions: [],
      endOptions: [],
      fullShiftRanges: [],
      shiftRanges: [],
    };
  }

  const startOptions = new Set<string>();
  const endOptions = new Set<string>();
  const fullShiftRanges = new Map<string, { startAt: string; endAt: string }>();
  const shiftRanges = new Map<string, LeaveRequestShiftRange>();
  const availableWorkIntervals: HourInterval[] = [];
  const blockingIntervals: HourInterval[] = [];

  const relatedSchedules = schedules
    .filter((schedule) =>
      schedule.dutyStaffActual.some((name) =>
        containsExactPersonName(name || '', leaveStaffName),
      ),
    )
    .sort(compareImpactSchedules);

  for (const schedule of relatedSchedules) {
    const dayStartHourIndex = getScheduleDayStartHourIndex(
      schedule.scheduleDate,
    );
    const kind = resolveLeaveScheduleKind(schedule);
    if (dayStartHourIndex === null) {
      continue;
    }

    if (!kind) {
      blockingIntervals.push({
        start: dayStartHourIndex + POTENTIAL_SCHEDULE_WINDOW.startHour,
        end: dayStartHourIndex + POTENTIAL_SCHEDULE_WINDOW.endHour,
      });
      continue;
    }

    if (kind === 'long_white') {
      const calendarInfo = getChinaWorkdayInfo(schedule.scheduleDate || '');
      if (!calendarInfo.supported) {
        for (const window of SCHEDULE_WINDOWS[kind]) {
          blockingIntervals.push({
            start: dayStartHourIndex + window.startHour,
            end: dayStartHourIndex + window.endHour,
          });
        }
        continue;
      }
      if (
        calendarInfo.kind === 'holiday' ||
        calendarInfo.kind === 'weekend_rest'
      ) {
        continue;
      }
    }

    const windows = SCHEDULE_WINDOWS[kind];
    for (const window of windows) {
      availableWorkIntervals.push({
        start: dayStartHourIndex + window.startHour,
        end: dayStartHourIndex + window.endHour,
      });
      for (let hour = window.startHour; hour < window.endHour; hour += 1) {
        startOptions.add(formatWallClockHour(dayStartHourIndex + hour));
      }
      for (let hour = window.startHour + 1; hour <= window.endHour; hour += 1) {
        endOptions.add(formatWallClockHour(dayStartHourIndex + hour));
      }
    }

    const envelope = getScheduleSortWindow(kind);
    if (envelope) {
      const range = {
        startAt: formatWallClockHour(dayStartHourIndex + envelope.startHour),
        endAt: formatWallClockHour(dayStartHourIndex + envelope.endHour),
      };
      const rangeKey = `${range.startAt}\u0000${range.endAt}`;
      fullShiftRanges.set(rangeKey, range);
      shiftRanges.set(rangeKey, {
        scheduleDate: schedule.scheduleDate || range.startAt.slice(0, 10),
        kind,
        ...range,
      });
    }
  }

  const allSortedEndOptions = [...endOptions].sort(compareText);
  const mergedAvailableWorkIntervals = mergeHourIntervals(
    availableWorkIntervals,
  );
  const mergedBlockingIntervals = mergeHourIntervals(blockingIntervals);
  const parsedHourIndexByValue = new Map<string, number | null>();
  const getCandidateHourIndex = (value: string): number | null => {
    if (!parsedHourIndexByValue.has(value)) {
      parsedHourIndexByValue.set(
        value,
        parseShanghaiLocalDateTime(value)?.wallClockHourIndex ?? null,
      );
    }
    return parsedHourIndexByValue.get(value) ?? null;
  };
  const isValidCandidateRange = (startAt: string, endAt: string): boolean => {
    const startHourIndex = getCandidateHourIndex(startAt);
    const endHourIndex = getCandidateHourIndex(endAt);
    if (
      startHourIndex === null ||
      endHourIndex === null ||
      endHourIndex <= startHourIndex
    ) {
      return false;
    }

    return (
      !intersectsHourIntervals(
        mergedBlockingIntervals,
        startHourIndex,
        endHourIndex,
      ) &&
      sumIntervalOverlapHours(
        mergedAvailableWorkIntervals,
        startHourIndex,
        endHourIndex,
      ) >= 4
    );
  };
  const sortedStartOptions = [...startOptions]
    .sort(compareText)
    .filter((startAt) =>
      allSortedEndOptions.some(
        (endAt) =>
          compareText(endAt, startAt) > 0 &&
          isValidCandidateRange(startAt, endAt),
      ),
    );

  let sortedEndOptions =
    sortedStartOptions.length > 0 ? allSortedEndOptions : [];
  if (options.selectedStartAt) {
    sortedEndOptions = allSortedEndOptions.filter((endAt) =>
      isValidCandidateRange(options.selectedStartAt || '', endAt),
    );
  }

  return {
    startOptions: sortedStartOptions,
    endOptions: sortedEndOptions,
    fullShiftRanges: [...fullShiftRanges.values()]
      .filter((range) => isValidCandidateRange(range.startAt, range.endAt))
      .sort(
        (left, right) =>
          compareText(left.startAt, right.startAt) ||
          compareText(left.endAt, right.endAt),
      ),
    shiftRanges: [...shiftRanges.values()]
      .filter((range) => isValidCandidateRange(range.startAt, range.endAt))
      .sort(
        (left, right) =>
          compareText(left.startAt, right.startAt) ||
          compareText(left.endAt, right.endAt),
      ),
  };
}

function intersectsPotentialScheduleWindow(
  dayStartHourIndex: number,
  requestStart: number,
  requestEnd: number,
): boolean {
  return (
    Math.min(
      dayStartHourIndex + POTENTIAL_SCHEDULE_WINDOW.endHour,
      requestEnd,
    ) >
    Math.max(
      dayStartHourIndex + POTENTIAL_SCHEDULE_WINDOW.startHour,
      requestStart,
    )
  );
}

export function calculateLeaveRequestImpact(
  schedules: LeaveRequestImpactSchedule[],
  request: LeaveRequestImpactRequest,
): LeaveRequestImpact {
  const start = parseShanghaiLocalDateTime(request?.startAt || '');
  if (!start) {
    return createEmptyImpact(true, 'invalid_start_at');
  }

  const end = parseShanghaiLocalDateTime(request?.endAt || '');
  if (!end) {
    return createEmptyImpact(true, 'invalid_end_at');
  }

  if (end.wallClockHourIndex <= start.wallClockHourIndex) {
    return createEmptyImpact(true, 'end_not_after_start');
  }

  const leaveStaffName = normalizePersonName(request.leaveStaffName || '');
  if (!leaveStaffName) {
    return createEmptyImpact();
  }

  const affectedSchedules: LeaveRequestAffectedSchedule[] = [];
  const excludedSchedules: LeaveRequestExcludedSchedule[] = [];
  const unrecognizedShifts = new Set<string>();
  const missingCalendarYears = new Set<string>();
  let countedIntervals: HourInterval[] = [];

  const relatedSchedules = schedules
    .filter((schedule) =>
      schedule.dutyStaffActual.some((name) =>
        containsExactPersonName(name || '', leaveStaffName),
      ),
    )
    .sort(compareImpactSchedules);

  for (const schedule of relatedSchedules) {
    const date = schedule.scheduleDate || '';
    const dayStartHourIndex = getScheduleDayStartHourIndex(
      schedule.scheduleDate,
    );
    if (dayStartHourIndex === null) {
      continue;
    }

    const building = getDisplayValue(schedule.buildingText, schedule.building);
    const team = getDisplayValue(schedule.teamText, schedule.team);
    const shift = getDisplayValue(schedule.shiftText, schedule.shift);
    const kind = resolveLeaveScheduleKind(schedule);

    if (!kind) {
      if (
        intersectsPotentialScheduleWindow(
          dayStartHourIndex,
          start.wallClockHourIndex,
          end.wallClockHourIndex,
        )
      ) {
        const unknownShift = getUnrecognizedShiftLabel(schedule);
        unrecognizedShifts.add(unknownShift);
        affectedSchedules.push({
          recordId: schedule.recordId,
          date,
          building,
          team,
          shift: unknownShift === '(空)' ? shift : unknownShift,
          kind: null,
          scheduledHours: 0,
          leaveHours: 0,
          countedHours: 0,
        });
      }
      continue;
    }

    const intersections = intersectScheduleWindows(
      dayStartHourIndex,
      SCHEDULE_WINDOWS[kind],
      start.wallClockHourIndex,
      end.wallClockHourIndex,
    );
    if (intersections.length === 0) {
      continue;
    }

    if (kind === 'long_white') {
      const calendarInfo = getChinaWorkdayInfo(date);
      if (!calendarInfo.supported) {
        missingCalendarYears.add(date.slice(0, 4));
        excludedSchedules.push({
          recordId: schedule.recordId,
          date,
          reason: 'calendar_data_missing',
        });
        continue;
      }
      if (
        calendarInfo.kind === 'holiday' ||
        calendarInfo.kind === 'weekend_rest'
      ) {
        excludedSchedules.push({
          recordId: schedule.recordId,
          date,
          reason: calendarInfo.kind,
        });
        continue;
      }
    }

    const scheduledHours = getScheduledHours(kind);
    const leaveHours = sumIntervalHours(intersections);
    const previousHours = sumIntervalHours(countedIntervals);
    countedIntervals = mergeHourIntervals([
      ...countedIntervals,
      ...intersections,
    ]);
    const countedHours = sumIntervalHours(countedIntervals) - previousHours;

    affectedSchedules.push({
      recordId: schedule.recordId,
      date,
      building,
      team,
      shift,
      kind,
      scheduledHours,
      leaveHours,
      countedHours,
    });
  }

  const rawHours = sumIntervalHours(countedIntervals);
  return {
    affectedSchedules,
    excludedSchedules,
    rawHours,
    minimumHours: rawHours,
    unrecognizedShifts: [...unrecognizedShifts],
    missingCalendarYears: [...missingCalendarYears].sort(),
    invalidRange: false,
    invalidRangeReason: null,
  };
}

function intervalsOverlapOrTouch(
  left: HourInterval,
  right: HourInterval,
): boolean {
  return Math.min(left.end, right.end) >= Math.max(left.start, right.start);
}

export function calculateLeaveRequestSubstituteRule(
  schedules: LeaveRequestImpactSchedule[],
  request: LeaveRequestImpactRequest,
  options: { forceRequiresSubstitute?: boolean } = {},
): LeaveRequestSubstituteRule {
  const substituteWindows: HourInterval[] = [];
  const ordinaryWhiteSubstituteDates = new Set<string>();

  for (const schedule of schedules) {
    const scheduleImpact = calculateLeaveRequestImpact([schedule], request);
    if (scheduleImpact.affectedSchedules.length === 0) {
      continue;
    }

    const kind = resolveLeaveScheduleKind(schedule);
    if (kind === 'long_white' && !options.forceRequiresSubstitute) {
      continue;
    }

    if ((kind === 'white' || kind === 'long_white') && schedule.scheduleDate) {
      ordinaryWhiteSubstituteDates.add(schedule.scheduleDate);
    }

    const dayStartHourIndex = getScheduleDayStartHourIndex(
      schedule.scheduleDate,
    );
    const envelope = kind
      ? getScheduleSortWindow(kind)
      : POTENTIAL_SCHEDULE_WINDOW;
    if (dayStartHourIndex === null || !envelope) {
      continue;
    }

    substituteWindows.push({
      start: dayStartHourIndex + envelope.startHour,
      end: dayStartHourIndex + envelope.endHour,
    });
  }

  if (substituteWindows.length === 0) {
    return { requiresSubstitute: false, blockedStaffNames: [] };
  }

  const blockedStaffNames = new Map<string, string>();
  const addBlockedStaffName = (value: string): void => {
    const name = value.trim();
    const key = normalizePersonName(name);
    if (key && !blockedStaffNames.has(key)) {
      blockedStaffNames.set(key, name);
    }
  };
  addBlockedStaffName(request.leaveStaffName || '');

  for (const schedule of schedules) {
    const dayStartHourIndex = getScheduleDayStartHourIndex(
      schedule.scheduleDate,
    );
    if (dayStartHourIndex === null) {
      continue;
    }

    const kind = resolveLeaveScheduleKind(schedule);
    if (kind === 'long_white') {
      if (
        schedule.scheduleDate &&
        ordinaryWhiteSubstituteDates.has(schedule.scheduleDate)
      ) {
        continue;
      }
      const calendarInfo = getChinaWorkdayInfo(schedule.scheduleDate || '');
      if (
        calendarInfo.supported &&
        (calendarInfo.kind === 'holiday' ||
          calendarInfo.kind === 'weekend_rest')
      ) {
        continue;
      }
    }

    const envelope = kind
      ? getScheduleSortWindow(kind)
      : POTENTIAL_SCHEDULE_WINDOW;
    if (!envelope) {
      continue;
    }

    const candidateWindow = {
      start: dayStartHourIndex + envelope.startHour,
      end: dayStartHourIndex + envelope.endHour,
    };
    if (
      !substituteWindows.some((substituteWindow) =>
        intervalsOverlapOrTouch(candidateWindow, substituteWindow),
      )
    ) {
      continue;
    }

    for (const value of schedule.dutyStaffActual) {
      for (const name of splitPersonNames(value || '')) {
        addBlockedStaffName(name);
      }
    }
  }

  return {
    requiresSubstitute: true,
    blockedStaffNames: [...blockedStaffNames.values()].sort((left, right) =>
      compareText(normalizePersonName(left), normalizePersonName(right)),
    ),
  };
}

export function isLeaveSubstituteStaffBlocked(
  rule: LeaveRequestSubstituteRule,
  staffName: string,
): boolean {
  const normalizedStaffName = normalizePersonName(staffName || '');
  return (
    normalizedStaffName.length > 0 &&
    rule.blockedStaffNames.some((blockedName) =>
      containsExactPersonName(blockedName, normalizedStaffName),
    )
  );
}
