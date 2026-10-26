import { createHash } from 'node:crypto';
import {
  calculateLeaveRequestImpact,
  calculateLeaveRequestSubstituteRule,
  containsExactPersonName,
  createLeaveRequestShiftGroups,
  isLeaveSubstituteStaffBlocked,
  type LeaveRequestImpactSchedule,
  type LeaveRequestShiftGroup,
} from '../../../shared/leave-request-impact';
import type { LeaveRoutePerson, LeaveSubstituteCandidate } from './leave-workflow.types';

export interface TwoLevelSubstituteCandidate {
  person: LeaveSubstituteCandidate;
  originalGroups: LeaveRequestShiftGroup[];
  backfillCandidates: LeaveSubstituteCandidate[];
}

export type TwoLevelSubstitutionResult =
  | {
      valid: true;
      primary: LeaveSubstituteCandidate;
      backfills: Array<{
        person: LeaveSubstituteCandidate;
        group: LeaveRequestShiftGroup;
      }>;
    }
  | { valid: false; message: string };

const nameKey = (value: string): string => value.replace(/\s+/g, '');

function samePerson(
  left: LeaveRoutePerson,
  right: LeaveRoutePerson,
): boolean {
  return (
    Boolean(left.personRecordId && left.personRecordId === right.personRecordId) ||
    Boolean(left.openId && left.openId === right.openId) ||
    nameKey(left.name) === nameKey(right.name)
  );
}

function removePerson(values: string[], name: string): string[] {
  return values.flatMap((value) => {
    if (!containsExactPersonName(value, name)) return [value];
    if (nameKey(value) === nameKey(name)) return [];
    return value
      .split(/[\s、,，;；/]+/)
      .filter((part) => part && nameKey(part) !== nameKey(name));
  });
}

function substituteRule(
  schedules: LeaveRequestImpactSchedule[],
  group: LeaveRequestShiftGroup,
  name: string,
) {
  return calculateLeaveRequestSubstituteRule(
    schedules,
    { leaveStaffName: name, startAt: group.startAt, endAt: group.endAt },
    { forceRequiresSubstitute: true },
  );
}

export function buildTwoLevelSubstituteCandidates(input: {
  group: LeaveRequestShiftGroup;
  schedules: LeaveRequestImpactSchedule[];
  applicant: LeaveRoutePerson;
  people: LeaveSubstituteCandidate[];
  selection?: { substitutePersonRecordId: string; backfillPersonRecordId?: string };
}): TwoLevelSubstituteCandidate[] {
  const { group, schedules, applicant } = input;
  // Schedules carry names; ambiguous directory identities cannot safely be joined.
  const people = input.people.filter(
    (person, index, all) =>
      Boolean(person.personRecordId && person.openId && nameKey(person.name)) &&
      !all.some((other, otherIndex) => otherIndex !== index && samePerson(person, other)),
  );
  const requestedRule = substituteRule(schedules, group, applicant.name);
  if (!requestedRule.requiresSubstitute) return [];

  const candidates: TwoLevelSubstituteCandidate[] = [];
  const impacts = new Map<string, ReturnType<typeof calculateLeaveRequestImpact>>();
  const impactFor = (name: string, target: LeaveRequestShiftGroup) => {
    const key = JSON.stringify([name, target.startAt, target.endAt]);
    let impact = impacts.get(key);
    if (!impact) {
      impact = calculateLeaveRequestImpact(schedules, { leaveStaffName: name, startAt: target.startAt, endAt: target.endAt });
      impacts.set(key, impact);
    }
    return impact;
  };
  for (const person of people) {
    if (input.selection && person.personRecordId !== input.selection.substitutePersonRecordId) continue;
    if (samePerson(applicant, person)) continue;
    const impact = impactFor(person.name, group);
    if (impact.invalidRange || impact.unrecognizedShifts.length || impact.missingCalendarYears.length) continue;
    const originalGroups = createLeaveRequestShiftGroups(impact.affectedSchedules);
    if (!originalGroups.length) {
      if (!isLeaveSubstituteStaffBlocked(requestedRule, person.name)) {
        candidates.push({ person, originalGroups: [], backfillCandidates: [] });
      }
      continue;
    }

    const originalRecordIds = new Set(originalGroups.flatMap((original) => original.scheduleRecordIds));
    const transferredSchedules = schedules.map((schedule) =>
      originalRecordIds.has(schedule.recordId)
        ? { ...schedule, dutyStaffActual: removePerson(schedule.dutyStaffActual, person.name) }
        : schedule,
    );
    // Moving an overlapping post does not waive rest restrictions on adjacent shifts.
    if (isLeaveSubstituteStaffBlocked(substituteRule(transferredSchedules, group, applicant.name), person.name)) continue;

    const originalRules = originalGroups.map((original) => substituteRule(schedules, original, person.name));
    const backfillCandidates = people.filter(
      (backup) =>
        (!input.selection || backup.personRecordId === input.selection.backfillPersonRecordId) &&
        !samePerson(applicant, backup) &&
        !samePerson(person, backup) &&
        originalRules.every((rule) => rule.requiresSubstitute && !isLeaveSubstituteStaffBlocked(rule, backup.name)) &&
        originalGroups.every((original) => {
          const backupImpact = impactFor(backup.name, original);
          return !backupImpact.invalidRange && !backupImpact.affectedSchedules.length && !backupImpact.unrecognizedShifts.length && !backupImpact.missingCalendarYears.length;
        }),
    );
    if (backfillCandidates.length) candidates.push({ person, originalGroups, backfillCandidates });
  }
  return candidates;
}

export function originalPostSignature(groups: LeaveRequestShiftGroup[]): string {
  const posts = groups.map((group) => ({
    shiftKey: group.shiftKey,
    scheduleDate: group.scheduleDate,
    startAt: group.startAt,
    endAt: group.endAt,
    kind: group.kind,
    shift: group.shift,
    buildings: [...group.buildings].sort(),
    teams: [...group.teams].sort(),
    scheduleRecordIds: [...group.scheduleRecordIds].sort(),
  })).sort((left, right) => left.shiftKey.localeCompare(right.shiftKey));
  return createHash('sha256').update(JSON.stringify(posts)).digest('hex');
}

export function resolveTwoLevelSubstitution(input: {
  candidates: TwoLevelSubstituteCandidate[];
  primaryPersonRecordId: string;
  backfillPersonRecordId?: string;
}): TwoLevelSubstitutionResult {
  const choice = input.candidates.find((candidate) => candidate.person.personRecordId === input.primaryPersonRecordId);
  if (!choice) return { valid: false, message: '替班人员已不可选，请重新选择' };
  if (!choice.originalGroups.length) {
    if (input.backfillPersonRecordId) return { valid: false, message: '原岗位已变化，请重新核对替班安排' };
    return { valid: true, primary: choice.person, backfills: [] };
  }
  const backup = choice.backfillCandidates.find((candidate) => candidate.personRecordId === input.backfillPersonRecordId);
  if (!backup || samePerson(choice.person, backup)) {
    return { valid: false, message: '请为替班人员的原岗位选择可用补位人员' };
  }
  return {
    valid: true,
    primary: choice.person,
    backfills: choice.originalGroups.map((original) => ({ person: backup, group: original })),
  };
}
