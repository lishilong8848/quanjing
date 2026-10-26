import { containsExactPersonName } from '@shared/leave-request-impact';

export interface OptimisticScheduleRecord {
  recordId: string;
  scheduleDate: string | null;
  building: string;
  team: string;
  shift: string;
  dutyStaffActual: string[];
  leaveStaff?: string[];
  substituteStaff?: string[];
}

interface DutyStaffAppend {
  recordId: string;
  staffName: string;
}

interface DutyStaffDateRange {
  startDate: string;
  endDate?: string;
}

interface OptimisticLeaveInput extends DutyStaffDateRange {
  staffName: string;
  substituteName?: string;
  building?: string;
  team?: string;
  shift?: string;
}

interface OptimisticLeaveRecordInput {
  staffName: string;
  substituteName?: string;
  recordIds: string[];
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

function compactScope(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_\-·]/g, '');
}

function normalizeBuildingScope(value: string): string {
  const compact = compactScope(value);
  if (compact.includes('110')) return '110';
  const match = compact.match(
    /^(?:nantong|南通)?(?:building)?([a-eh])(?:楼|栋|building)?$/,
  );
  return match?.[1] || compact;
}

function normalizeTeamScope(value: string): string {
  const compact = compactScope(value);
  const match = compact.match(
    /^(?:shift|group)?([a-d])(?:班|组|shift|group)?$/,
  );
  return match?.[1] || compact;
}

function normalizeShiftScope(value: string): string {
  const compact = compactScope(value);
  if (/^(?:white|whiteshift|白|白班)$/.test(compact)) return 'white';
  if (/^(?:night|nightshift|夜|夜班)$/.test(compact)) return 'night';
  if (/^(?:longwhite|longwhiteshift|长白|长白班)$/.test(compact)) {
    return 'longwhite';
  }
  return compact;
}

function appendUnique(names: string[], name: string): string[] {
  const normalized = name.trim();
  if (!normalized) return names;
  if (names.some((item) => normalizeName(item) === normalizeName(normalized))) {
    return names;
  }
  return [...names, normalized];
}

function isDateInRange(
  date: string | null,
  range: DutyStaffDateRange,
): boolean {
  return Boolean(
    date &&
    date >= range.startDate &&
    date <= (range.endDate || range.startDate),
  );
}

function getScheduleMonthKey(date: string | null): string | null {
  const match = date?.match(/^(\d{4}-\d{2})-\d{2}$/);
  return match?.[1] || null;
}

export function replaceScheduleMonthsFromAuthoritative<
  T extends OptimisticScheduleRecord,
>(
  current: T[],
  incoming: T[],
  monthDateKeys: string[],
  preservedRecordIds: Iterable<string> = [],
): T[] {
  const refreshedMonthKeys = new Set(
    monthDateKeys
      .map((dateKey) => getScheduleMonthKey(dateKey))
      .filter((monthKey): monthKey is string => Boolean(monthKey)),
  );
  const preservedIds = new Set(preservedRecordIds);
  const merged = new Map<string, T>();

  current.forEach((schedule) => {
    const monthKey = getScheduleMonthKey(schedule.scheduleDate);
    if (!monthKey || !refreshedMonthKeys.has(monthKey)) {
      merged.set(schedule.recordId, schedule);
    }
  });
  incoming.forEach((schedule) => merged.set(schedule.recordId, schedule));
  current.forEach((schedule) => {
    if (preservedIds.has(schedule.recordId)) {
      merged.set(schedule.recordId, schedule);
    }
  });

  return Array.from(merged.values());
}

export function appendOptimisticDutyStaff<T extends OptimisticScheduleRecord>(
  schedules: T[],
  additions: DutyStaffAppend[],
): T[] {
  const additionsByRecord = new Map<string, string[]>();
  additions.forEach(({ recordId, staffName }) => {
    const names = additionsByRecord.get(recordId) || [];
    additionsByRecord.set(recordId, appendUnique(names, staffName));
  });

  return schedules.map((schedule) => {
    const additionsForRecord = additionsByRecord.get(schedule.recordId);
    if (!additionsForRecord) return schedule;
    const nextNames = additionsForRecord.reduce(
      (names, name) => appendUnique(names, name),
      schedule.dutyStaffActual,
    );
    return nextNames === schedule.dutyStaffActual
      ? schedule
      : { ...schedule, dutyStaffActual: nextNames };
  });
}

export function replaceOptimisticDutyStaff<T extends OptimisticScheduleRecord>(
  schedules: T[],
  recordId: string,
  targetName: string,
  replacementName: string,
): T[] {
  const target = normalizeName(targetName);
  const replacement = replacementName.trim();
  return schedules.map((schedule) => {
    if (schedule.recordId !== recordId) return schedule;
    const nextNames: string[] = [];
    schedule.dutyStaffActual.forEach((name) => {
      const nextName = normalizeName(name) === target ? replacement : name;
      const appended = appendUnique(nextNames, nextName);
      nextNames.splice(0, nextNames.length, ...appended);
    });
    return { ...schedule, dutyStaffActual: nextNames };
  });
}

export function removeOptimisticDutyStaff<T extends OptimisticScheduleRecord>(
  schedules: T[],
  staffName: string,
  range: DutyStaffDateRange,
): T[] {
  const target = normalizeName(staffName);
  return schedules.map((schedule) => {
    if (!isDateInRange(schedule.scheduleDate, range)) return schedule;
    const nextNames = schedule.dutyStaffActual.filter(
      (name) => normalizeName(name) !== target,
    );
    return nextNames.length === schedule.dutyStaffActual.length
      ? schedule
      : { ...schedule, dutyStaffActual: nextNames };
  });
}

export function applyOptimisticLeave<T extends OptimisticScheduleRecord>(
  schedules: T[],
  input: OptimisticLeaveInput,
): T[] {
  const leaveName = normalizeName(input.staffName);
  return schedules.map((schedule) => {
    if (
      !isDateInRange(schedule.scheduleDate, input) ||
      (input.building &&
        normalizeBuildingScope(schedule.building) !==
          normalizeBuildingScope(input.building)) ||
      (input.team &&
        normalizeTeamScope(schedule.team) !== normalizeTeamScope(input.team)) ||
      (input.shift &&
        normalizeShiftScope(schedule.shift) !==
          normalizeShiftScope(input.shift))
    ) {
      return schedule;
    }
    if (
      !schedule.dutyStaffActual.some(
        (name) => normalizeName(name) === leaveName,
      )
    ) {
      return schedule;
    }

    const nextDutyStaff = schedule.dutyStaffActual.flatMap((name) =>
      normalizeName(name) === leaveName
        ? input.substituteName?.trim()
          ? [input.substituteName.trim()]
          : []
        : [name],
    );
    return {
      ...schedule,
      dutyStaffActual: nextDutyStaff,
      leaveStaff: appendUnique(schedule.leaveStaff || [], input.staffName),
      substituteStaff: input.substituteName
        ? appendUnique(schedule.substituteStaff || [], input.substituteName)
        : schedule.substituteStaff || [],
    };
  });
}

export function applyOptimisticLeaveToRecords<
  T extends OptimisticScheduleRecord,
>(schedules: T[], input: OptimisticLeaveRecordInput): T[] {
  const recordIds = new Set(input.recordIds.filter(Boolean));
  return schedules.map((schedule) => {
    if (
      !recordIds.has(schedule.recordId) ||
      !schedule.dutyStaffActual.some((name) =>
        containsExactPersonName(name, input.staffName),
      )
    ) {
      return schedule;
    }

    return {
      ...schedule,
      leaveStaff: appendUnique(schedule.leaveStaff || [], input.staffName),
      substituteStaff: input.substituteName
        ? appendUnique(schedule.substituteStaff || [], input.substituteName)
        : schedule.substituteStaff || [],
    };
  });
}

export function restoreOptimisticSchedules<T extends OptimisticScheduleRecord>(
  current: T[],
  snapshots: T[],
): T[] {
  const snapshotsByRecordId = new Map(
    snapshots.map((schedule) => [schedule.recordId, schedule]),
  );
  return current.map(
    (schedule) => snapshotsByRecordId.get(schedule.recordId) || schedule,
  );
}
