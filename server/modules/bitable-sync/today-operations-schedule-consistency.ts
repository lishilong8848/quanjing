import { createHash } from 'node:crypto';

export interface TodayOperationsScheduleSnapshot {
  recordId: string;
  scheduleDate: string;
  building: string;
  shift: string;
  startAt: string;
  endAt: string;
  plannedStaff: string[];
  actualStaff: string[];
  approvedLeaveStaff: string[];
  approvedSubstituteStaff: string[];
}

export interface TodayOperationsApprovedLeaveAssignmentSnapshot {
  sourceRecordId: string;
  scheduleRecordId: string;
  shiftKey: string;
  leaveStaff: string[];
  substituteStaff: string[];
  effectiveAt?: string | null;
}

export type TodayOperationsScheduleConsistencyIssueKind =
  | 'approved_substitute_missing'
  | 'approved_leave_still_scheduled'
  | 'approved_leave_substitute_mismatch';

export interface TodayOperationsScheduleConsistencyIssue {
  issueId: string;
  kind: TodayOperationsScheduleConsistencyIssueKind;
  sourceRecordId: string;
  scheduleRecordId: string;
  scope: string;
  location: string;
  dataDate: string;
  details: string[];
}

export function detectTodayOperationsScheduleConsistencyIssues(input: {
  schedules: TodayOperationsScheduleSnapshot[];
  approvedLeaveAssignments: TodayOperationsApprovedLeaveAssignmentSnapshot[];
  detectedAt?: string;
  syncGraceMs?: number;
}): TodayOperationsScheduleConsistencyIssue[] {
  const issues: TodayOperationsScheduleConsistencyIssue[] = [];
  const schedulesByRecordId = new Map(
    input.schedules.map((schedule) => [schedule.recordId, schedule]),
  );

  for (const assignment of input.approvedLeaveAssignments) {
    if (
      isWithinSyncGrace(
        assignment.effectiveAt,
        input.detectedAt,
        input.syncGraceMs,
      )
    ) {
      continue;
    }
    const schedule = schedulesByRecordId.get(assignment.scheduleRecordId);
    if (!schedule) continue;
    if (
      isBeforeScheduleConsistencyReady(
        schedule.startAt,
        input.detectedAt,
        input.syncGraceMs,
      )
    ) {
      continue;
    }
    const actualKeys = new Set(schedule.actualStaff.map(normalizeStaffKey));
    const staleLeaveStaff = assignment.leaveStaff.filter((leaveName) =>
      actualKeys.has(normalizeStaffKey(leaveName)),
    );
    const missingSubstituteStaff = assignment.substituteStaff.filter(
      (substituteName) => !actualKeys.has(normalizeStaffKey(substituteName)),
    );
    if (staleLeaveStaff.length > 0 && missingSubstituteStaff.length > 0) {
      issues.push(
        createIssue({
          kind: 'approved_leave_substitute_mismatch',
          sourceRecordId: assignment.sourceRecordId,
          schedule,
          discriminator: `${displayNames(staleLeaveStaff)}|${displayNames(
            missingSubstituteStaff,
          )}`,
          details: [
            '已审批请假替班尚未同步到该班次实际排班',
            `仍在排班的请假人员：${displayNames(staleLeaveStaff)}`,
            `未进入排班的替班人员：${displayNames(missingSubstituteStaff)}`,
            `当前实际人员：${displayNames(schedule.actualStaff)}`,
          ],
        }),
      );
      continue;
    }
    for (const leaveName of assignment.leaveStaff) {
      if (!actualKeys.has(normalizeStaffKey(leaveName))) continue;
      issues.push(
        createIssue({
          kind: 'approved_leave_still_scheduled',
          sourceRecordId: assignment.sourceRecordId,
          schedule,
          discriminator: leaveName,
          details: [
            `已审批请假人员“${leaveName}”仍出现在该班次实际排班中`,
            `当前实际人员：${displayNames(schedule.actualStaff)}`,
            `已审批替班人员：${displayNames(assignment.substituteStaff)}`,
          ],
        }),
      );
    }
    for (const substituteName of assignment.substituteStaff) {
      if (actualKeys.has(normalizeStaffKey(substituteName))) continue;
      issues.push(
        createIssue({
          kind: 'approved_substitute_missing',
          sourceRecordId: assignment.sourceRecordId,
          schedule,
          discriminator: substituteName,
          details: [
            `已审批替班人员“${substituteName}”未出现在该班次实际排班中`,
            `当前实际人员：${displayNames(schedule.actualStaff)}`,
            `已审批请假人员：${displayNames(assignment.leaveStaff)}`,
            `已审批替班人员：${displayNames(assignment.substituteStaff)}`,
          ],
        }),
      );
    }
  }

  return dedupeIssues(issues).sort((left, right) =>
    `${left.dataDate}:${left.scope}:${left.kind}:${left.sourceRecordId}`.localeCompare(
      `${right.dataDate}:${right.scope}:${right.kind}:${right.sourceRecordId}`,
      'zh-CN',
    ),
  );
}

function isBeforeScheduleConsistencyReady(
  startAt: string | null | undefined,
  detectedAt: string | undefined,
  syncGraceMs: number | undefined,
): boolean {
  if (!startAt || !detectedAt || !syncGraceMs || syncGraceMs <= 0) {
    return false;
  }
  const startMs = Date.parse(startAt);
  const detectedMs = Date.parse(detectedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(detectedMs)) {
    return false;
  }
  return detectedMs < startMs + syncGraceMs;
}

function isWithinSyncGrace(
  effectiveAt: string | null | undefined,
  detectedAt: string | undefined,
  syncGraceMs: number | undefined,
): boolean {
  if (!effectiveAt || !detectedAt || !syncGraceMs || syncGraceMs <= 0) {
    return false;
  }
  const effectiveMs = Date.parse(effectiveAt);
  const detectedMs = Date.parse(detectedAt);
  if (!Number.isFinite(effectiveMs) || !Number.isFinite(detectedMs)) {
    return false;
  }
  const ageMs = detectedMs - effectiveMs;
  return ageMs >= 0 && ageMs < syncGraceMs;
}

function createIssue(input: {
  kind: TodayOperationsScheduleConsistencyIssueKind;
  sourceRecordId: string;
  schedule: TodayOperationsScheduleSnapshot;
  discriminator: string;
  details: string[];
}): TodayOperationsScheduleConsistencyIssue {
  const scope = [
    input.schedule.scheduleDate,
    input.schedule.building,
    input.schedule.shift,
  ]
    .filter(Boolean)
    .join(' ');
  const stableKey = [
    input.kind,
    input.sourceRecordId,
    input.schedule.recordId,
    normalizeStaffKey(input.discriminator),
  ].join('|');
  return {
    issueId: createHash('sha256').update(stableKey).digest('hex'),
    kind: input.kind,
    sourceRecordId: input.sourceRecordId,
    scheduleRecordId: input.schedule.recordId,
    scope,
    location: `排班页面 > ${scope}`,
    dataDate: input.schedule.scheduleDate,
    details: input.details,
  };
}

function normalizeStaffKey(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function displayNames(values: string[]): string {
  const names = Array.from(
    new Map(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => [normalizeStaffKey(value), value]),
    ).values(),
  );
  return names.length > 0 ? names.join('、') : '无';
}

function dedupeIssues(
  values: TodayOperationsScheduleConsistencyIssue[],
): TodayOperationsScheduleConsistencyIssue[] {
  return Array.from(
    new Map(values.map((value) => [value.issueId, value])).values(),
  );
}
