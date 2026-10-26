import { getChinaWorkdayInfo } from './china-work-calendar';
import { calculateOvertimePayableHours } from './overtime-request-impact';

export interface SubstituteOvertimeInterval {
  startMs: number;
  endMs: number;
}

export interface SubstituteOvertimePolicyInput {
  // Must be resolved from the substitute's own personnel record, not the replaced shift.
  staff: { userId: string; workPattern: 'long_white' | 'rotating' } | null;
  substitute: SubstituteOvertimeInterval;
  // null means the read failed; [] means a complete snapshot contains no rows.
  schedules: ReadonlyArray<
    SubstituteOvertimeInterval & {
      staffUserId: string;
      source: 'original' | 'substitute' | 'actual';
    }
  > | null;
  applications: ReadonlyArray<
    SubstituteOvertimeInterval & {
      staffUserId: string;
      status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    }
  > | null;
}

type ReviewReason =
  | 'staff_data_missing'
  | 'schedule_data_missing'
  | 'application_data_missing'
  | 'invalid_interval'
  | 'original_schedule_unverified'
  | 'application_state_unknown'
  | 'calendar_data_missing';

export type SubstituteOvertimeRequirement =
  | {
      status: 'not_required' | 'already_applied' | 'required';
      reason: null;
      overtimeHours: number;
      unappliedHours: number;
      unappliedIntervals: SubstituteOvertimeInterval[];
    }
  | {
      status: 'needs_review';
      reason: ReviewReason;
      overtimeHours: null;
      unappliedHours: null;
      unappliedIntervals: [];
    };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

function needsReview(reason: ReviewReason): SubstituteOvertimeRequirement {
  return {
    status: 'needs_review',
    reason,
    overtimeHours: null,
    unappliedHours: null,
    unappliedIntervals: [],
  };
}

function validInterval(value: SubstituteOvertimeInterval): boolean {
  return (
    Boolean(value) &&
    Number.isSafeInteger(value.startMs) &&
    Number.isSafeInteger(value.endMs) &&
    Math.abs(value.startMs) <= 8.64e15 &&
    Math.abs(value.endMs) <= 8.64e15 &&
    value.endMs > value.startMs
  );
}

function overlaps(
  left: SubstituteOvertimeInterval,
  right: SubstituteOvertimeInterval,
): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function union(
  intervals: readonly SubstituteOvertimeInterval[],
): SubstituteOvertimeInterval[] {
  const merged: SubstituteOvertimeInterval[] = [];
  for (const current of [...intervals].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  )) {
    const previous = merged[merged.length - 1];
    if (previous && current.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, current.endMs);
    } else {
      merged.push({ startMs: current.startMs, endMs: current.endMs });
    }
  }
  return merged;
}

function subtract(
  intervals: readonly SubstituteOvertimeInterval[],
  covered: readonly SubstituteOvertimeInterval[],
): SubstituteOvertimeInterval[] {
  const coverage = union(covered);
  return intervals.flatMap(({ startMs, endMs }) => {
    let cursor = startMs;
    const remaining: SubstituteOvertimeInterval[] = [];
    for (const cover of coverage) {
      if (cover.endMs <= cursor) continue;
      if (cover.startMs >= endMs) break;
      if (cover.startMs > cursor)
        remaining.push({ startMs: cursor, endMs: cover.startMs });
      cursor = Math.min(endMs, Math.max(cursor, cover.endMs));
    }
    if (cursor < endMs) remaining.push({ startMs: cursor, endMs });
    return remaining;
  });
}

function payableHours(
  intervals: readonly SubstituteOvertimeInterval[],
): number {
  return intervals.reduce(
    (sum, item) =>
      sum + calculateOvertimePayableHours(item.startMs, item.endMs),
    0,
  );
}

export function calculateSubstituteOvertimeRequirement(
  input: SubstituteOvertimePolicyInput,
): SubstituteOvertimeRequirement {
  const { staff, substitute, schedules, applications } = input;
  if (
    !staff?.userId?.trim() ||
    !['long_white', 'rotating'].includes(staff.workPattern)
  ) {
    return needsReview('staff_data_missing');
  }
  if (!Array.isArray(schedules)) return needsReview('schedule_data_missing');
  if (!Array.isArray(applications))
    return needsReview('application_data_missing');
  // Bound iteration for corrupt snapshots; multi-year requests require separate review.
  if (
    !validInterval(substitute) ||
    substitute.endMs - substitute.startMs > 366 * DAY_MS
  ) {
    return needsReview('invalid_interval');
  }

  const normalDuty: SubstituteOvertimeInterval[] = [];
  if (staff.workPattern === 'long_white') {
    const firstDay = Math.floor(
      (substitute.startMs + SHANGHAI_OFFSET_MS) / DAY_MS,
    );
    const lastDay = Math.floor(
      (substitute.endMs - 1 + SHANGHAI_OFFSET_MS) / DAY_MS,
    );
    for (let day = firstDay; day <= lastDay; day += 1) {
      const info = getChinaWorkdayInfo(
        new Date(day * DAY_MS).toISOString().slice(0, 10),
      );
      if (!info.supported) return needsReview('calendar_data_missing');
      if (info.isWorkday) {
        const dayStartMs = day * DAY_MS - SHANGHAI_OFFSET_MS;
        normalDuty.push({
          startMs: dayStartMs + 9 * HOUR_MS,
          endMs: dayStartMs + 18 * HOUR_MS,
        });
      }
    }
  }

  for (const schedule of schedules) {
    if (schedule.staffUserId !== staff.userId) continue;
    if (!validInterval(schedule)) return needsReview('invalid_interval');
    if (!overlaps(schedule, substitute)) continue;
    if (schedule.source === 'substitute') continue;
    if (schedule.source !== 'original')
      return needsReview('original_schedule_unverified');
    normalDuty.push(schedule);
  }

  const applied: SubstituteOvertimeInterval[] = [];
  for (const application of applications) {
    if (application.staffUserId !== staff.userId) continue;
    if (application.status === 'rejected' || application.status === 'cancelled')
      continue;
    if (application.status !== 'pending' && application.status !== 'approved') {
      return needsReview('application_state_unknown');
    }
    if (!validInterval(application)) return needsReview('invalid_interval');
    if (overlaps(application, substitute)) applied.push(application);
  }

  const overtime = subtract([substitute], normalDuty);
  const overtimeHours = payableHours(overtime);
  const unappliedIntervals = subtract(overtime, applied).filter(
    (item) => payableHours([item]) > 0,
  );
  const unappliedHours = payableHours(unappliedIntervals);
  return {
    status:
      overtimeHours === 0
        ? 'not_required'
        : unappliedHours === 0
          ? 'already_applied'
          : 'required',
    reason: null,
    overtimeHours,
    unappliedHours,
    unappliedIntervals,
  };
}
