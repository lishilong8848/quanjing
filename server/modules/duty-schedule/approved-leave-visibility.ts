import {
  extractDisplayText,
  extractDisplayValues,
  pickField,
} from '@server/common/feishu/bitable-direct-read';
import {
  LEAVE_APPROVAL_COMPLETE_FIELD_CANDIDATES,
  RAW_LEAVE_STAFF_FIELD_CANDIDATES,
  RAW_SUBSTITUTE_STAFF_FIELD_CANDIDATES,
  SYSTEM_APPROVED_LEAVE_STAFF_FIELD,
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
  SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD,
  SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD,
  SYSTEM_LEAVE_APPROVAL_ERROR_FIELD,
  type ApprovedPostReplacement,
} from '@server/common/feishu/leave-approval-source';
import { buildDutyProgramModifiedRefreshItem } from './duty-program-modified-refresh';
import { pickDutyStaffActualField } from './duty-staff-actual-field';
import { normalizeDutyStaffDisplayName } from '@shared/duty-staff-name';

export const APPROVED_LEAVE_STAFF_FIELD_CANDIDATES = [
  SYSTEM_APPROVED_LEAVE_STAFF_FIELD,
] as const;

export const APPROVED_SUBSTITUTE_STAFF_FIELD_CANDIDATES = [
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
] as const;

export const LEAVE_APPROVAL_STATUS_FIELD_CANDIDATES = [
  ...LEAVE_APPROVAL_COMPLETE_FIELD_CANDIDATES,
] as const;

export interface ApprovedLeaveVisibility {
  leaveStaff: string[];
  substituteStaff: string[];
  allRawLeaveApproved: boolean;
  rawLeaveStaff: string[];
  rawSubstituteStaff: string[];
  hasUnapprovedLeave: boolean;
}

export interface ApprovedLeaveVisibilityInput {
  rawLeaveStaff: readonly string[];
  rawSubstituteStaff: readonly string[];
  approvedLeaveStaff: readonly string[];
  approvedSubstituteStaff?: readonly string[];
}

function normalizeComparableName(value: string): string {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function normalizeStaffNames(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  values.forEach((value) => {
    String(value || '')
      .split(/[\s、,，;；/]+/)
      .map(normalizeDutyStaffDisplayName)
      .filter(Boolean)
      .forEach((name) => {
        const key = normalizeComparableName(name);
        if (!key || seen.has(key)) return;
        seen.add(key);
        result.push(name);
      });
  });

  return result;
}

export function resolveApprovedLeaveVisibility(
  input: ApprovedLeaveVisibilityInput,
): ApprovedLeaveVisibility {
  const rawLeaveStaff = normalizeStaffNames(input.rawLeaveStaff);
  const rawSubstituteStaff = normalizeStaffNames(input.rawSubstituteStaff);
  const approvedLeaveStaff = normalizeStaffNames(input.approvedLeaveStaff);
  const rawLeaveKeys = new Set(rawLeaveStaff.map(normalizeComparableName));
  const approvedLeaveKeys = new Set(
    approvedLeaveStaff.map(normalizeComparableName),
  );
  const visibleApprovedLeaveStaff = rawLeaveStaff.filter((name) =>
    approvedLeaveKeys.has(normalizeComparableName(name)),
  );
  const visibleApprovedLeaveKeys = new Set(
    visibleApprovedLeaveStaff.map(normalizeComparableName),
  );
  const allRawLeaveApproved =
    rawLeaveKeys.size > 0 &&
    rawLeaveKeys.size === visibleApprovedLeaveKeys.size &&
    Array.from(rawLeaveKeys).every((key) => visibleApprovedLeaveKeys.has(key));
  const hasUnapprovedLeave = Array.from(rawLeaveKeys).some(
    (key) => !visibleApprovedLeaveKeys.has(key),
  );
  const approvedSubstituteStaff = normalizeStaffNames(
    input.approvedSubstituteStaff || [],
  );
  const hasExplicitApprovedSubstituteStaff =
    input.approvedSubstituteStaff !== undefined;

  return {
    leaveStaff: visibleApprovedLeaveStaff,
    substituteStaff: hasExplicitApprovedSubstituteStaff
      ? approvedSubstituteStaff
      : allRawLeaveApproved
        ? rawSubstituteStaff
        : [],
    allRawLeaveApproved,
    rawLeaveStaff,
    rawSubstituteStaff,
    hasUnapprovedLeave,
  };
}

export function resolveApprovedLeaveVisibilityFromFields(
  fields: Record<string, unknown>,
): ApprovedLeaveVisibility {
  const verified =
    pickField(fields, [SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD]) === true;
  return resolveApprovedLeaveVisibility({
    rawLeaveStaff: extractDisplayValues(
      pickField(fields, [...RAW_LEAVE_STAFF_FIELD_CANDIDATES]),
    ),
    rawSubstituteStaff: extractDisplayValues(
      pickField(fields, [...RAW_SUBSTITUTE_STAFF_FIELD_CANDIDATES]),
    ),
    approvedLeaveStaff: verified
      ? extractDisplayValues(
          pickField(fields, [...APPROVED_LEAVE_STAFF_FIELD_CANDIDATES]),
        )
      : [],
    approvedSubstituteStaff: verified
      ? extractDisplayValues(
          pickField(fields, [...APPROVED_SUBSTITUTE_STAFF_FIELD_CANDIDATES]),
        )
      : [],
  });
}

export function isLeaveRequestApprovalComplete(
  fields: Record<string, unknown>,
): boolean {
  return (
    extractDisplayText(
      pickField(fields, [...LEAVE_APPROVAL_STATUS_FIELD_CANDIDATES]),
    )
      .trim()
      .replace(/\s+/g, '') === '审批结束'
  );
}

export interface ApprovalAwareDutyStaffVisibility extends ApprovedLeaveVisibility {
  dutyStaff: string[];
}

export function resolveApprovalAwareDutyStaffFromFields(
  fields: Record<string, unknown>,
): ApprovalAwareDutyStaffVisibility {
  const approvedLeave = resolveApprovedLeaveVisibilityFromFields(fields);
  const currentDutyStaff = normalizeStaffNames(
    extractDisplayValues(pickDutyStaffActualField(fields)),
  );
  const travelStaff = normalizeStaffNames(
    extractDisplayValues(
      pickField(fields, ['差旅人员', '出差人员', '差旅', '差旅人员信息']),
    ),
  );
  const travelStaffKeys = new Set(travelStaff.map(normalizeComparableName));
  const activeDutyStaff = currentDutyStaff.filter(
    (name) => !travelStaffKeys.has(normalizeComparableName(name)),
  );
  if (fields[SYSTEM_LEAVE_APPROVAL_ERROR_FIELD]) return { ...approvedLeave, dutyStaff: activeDutyStaff };
  const rawReplacements = fields[SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD] === true ? fields[SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD] : [];
  const replacements = Array.isArray(rawReplacements) ? rawReplacements as ApprovedPostReplacement[] : [];
  if (replacements.length) {
    const plannedStaff = normalizeStaffNames(extractDisplayValues(pickField(fields, ['fldJi5bxBG', '人员（文本）', '人员文本', '人员', 'flddMP5Au3', '值班人员（对照）', '值班人员(对照)'])));
    const base = buildDutyProgramModifiedRefreshItem({
      recordId: '',
      plannedStaff: plannedStaff.length ? plannedStaff : activeDutyStaff,
      leaveStaff: approvedLeave.leaveStaff,
      substituteStaff: approvedLeave.substituteStaff,
      vacancySubstituteStaff: normalizeStaffNames(extractDisplayValues(pickField(fields, ['缺岗替班', '缺岗替班人员', '缺岗替代', '缺岗人员替班']))),
      travelStaff,
    });
    const removed = new Set(replacements.map((row) => normalizeComparableName(row.removedStaff)));
    return { ...approvedLeave, dutyStaff: normalizeStaffNames([
      ...normalizeStaffNames([base.finalText]).filter((name) => !removed.has(normalizeComparableName(name))),
      ...replacements.map((row) => row.addedStaff),
    ]).filter((name) => !travelStaffKeys.has(normalizeComparableName(name))) };
  }
  if (!approvedLeave.hasUnapprovedLeave) {
    return { ...approvedLeave, dutyStaff: activeDutyStaff };
  }

  const plannedStaff = normalizeStaffNames(
    extractDisplayValues(
      pickField(fields, [
        'fldJi5bxBG',
        '人员（文本）',
        '人员文本',
        '人员',
        'flddMP5Au3',
        '值班人员（对照）',
        '值班人员(对照)',
      ]),
    ),
  );
  const plannedKeys = new Set(plannedStaff.map(normalizeComparableName));
  const approvedSubstituteKeys = new Set(approvedLeave.substituteStaff.map(normalizeComparableName));
  const tentativeSubstituteKeys = new Set(
    approvedLeave.rawSubstituteStaff.map(normalizeComparableName)
      .filter(key => !approvedSubstituteKeys.has(key) && !plannedKeys.has(key)),
  );

  let baseline = plannedStaff;
  if (currentDutyStaff.length > 0) {
    const hasTentativeSubstitute = currentDutyStaff.some(name =>
      tentativeSubstituteKeys.has(normalizeComparableName(name)),
    );
    if (!hasTentativeSubstitute && approvedLeave.leaveStaff.length === 0) {
      return { ...approvedLeave, dutyStaff: activeDutyStaff };
    }

    // Only undo the named pending substitution. Restoring the whole planned
    // roster also undoes unrelated manual duty changes.
    const approvedLeaveKeys = new Set(approvedLeave.leaveStaff.map(normalizeComparableName));
    const restoredPending = hasTentativeSubstitute
      ? approvedLeave.rawLeaveStaff.filter(name => {
          const key = normalizeComparableName(name);
          return !approvedLeaveKeys.has(key) && (plannedKeys.size === 0 || plannedKeys.has(key));
        })
      : [];
    const actualAndRestored = normalizeStaffNames([
      ...activeDutyStaff.filter(name => !tentativeSubstituteKeys.has(normalizeComparableName(name))),
      ...restoredPending,
    ]);
    const restoredKeys = new Set(actualAndRestored.map(normalizeComparableName));
    baseline = [
      ...plannedStaff.filter(name => restoredKeys.has(normalizeComparableName(name))),
      ...actualAndRestored.filter(name => !plannedKeys.has(normalizeComparableName(name))),
    ];
  }
  const effective = buildDutyProgramModifiedRefreshItem({
    recordId: '',
    plannedStaff: baseline,
    leaveStaff: approvedLeave.leaveStaff,
    substituteStaff: approvedLeave.substituteStaff,
    vacancySubstituteStaff: normalizeStaffNames(
      extractDisplayValues(
        pickField(fields, [
          '缺岗替班',
          '缺岗替班人员',
          '缺岗替代',
          '缺岗人员替班',
        ]),
      ),
    ),
    travelStaff,
  });

  return {
    ...approvedLeave,
    dutyStaff: normalizeStaffNames([effective.finalText]),
  };
}
