import type {
  LeaveApprovalClass,
  LeaveApprovalPlan,
  LeaveApprovalRoutingInput,
  LeaveApprovalStage,
  LeaveDiscipline,
  LeaveOrganizationRecord,
  LeaveRoutePerson,
  LeaveShiftAssignmentSelection,
  LeaveShiftCandidateSet,
  LeaveShiftSubstituteAssignment,
  LeaveSubstituteCandidate,
} from './leave-workflow.types';
import type { LeaveWorkflowApplicationEntry } from './leave-workflow.store';
import { buildTwoLevelSubstituteCandidates, originalPostSignature, resolveTwoLevelSubstitution } from './leave-two-level-substitution';
import {
  calculateLeaveRequestSubstituteRule,
  isLeaveSubstituteStaffBlocked,
  parseShanghaiLocalDateTime,
  type LeaveRequestImpactSchedule,
  type LeaveRequestShiftGroup,
} from '../../../shared/leave-request-impact';

export type LeaveNotificationDutyResolver = (kind: 'leave_supervisor' | 'leave_manager' | 'professional_supervisor', target: { building: string[]; specialty?: string }) => LeaveRoutePerson[] | null;
type LeaveNotificationApplication = Pick<LeaveWorkflowApplicationEntry, 'snapshot' | 'approvalPlan'>;

export function leaveWorkflowDutyTarget(application: LeaveNotificationApplication): { building: string[]; specialty?: string } {
  const discipline = application.approvalPlan?.discipline;
  const specialty = discipline && ({ electrical: '电气', hvac: '暖通', weak_current: '弱电', fire: '消防' } as const)[discipline];
  return { building: [application.snapshot.building], ...(specialty ? { specialty } : {}) };
}

export function fixedLeaveNotificationIds(application: LeaveNotificationApplication): Set<string | undefined> {
  const snapshot = application.snapshot;
  return new Set([snapshot.applicantOpenId, ...snapshot.applicantNotificationOpenIds, snapshot.substituteOpenId,
    ...(snapshot.shiftAssignments?.flatMap(row => [row.substituteOpenId, ...(row.originalPostBackfills || []).map(backup => backup.substituteOpenId)]) || []), ...(application.approvalPlan?.notificationPlan.substituteRecipients.map(row => row.openId) || [])]);
}

export function resolveCurrentLeaveAdjustmentApprovers(application: LeaveNotificationApplication, resolve: LeaveNotificationDutyResolver): LeaveRoutePerson[] {
  if (!application.approvalPlan) throw new LeaveApprovalRoutingError('INVALID_APPLICANT', '替班调整的审批岗位快照缺失');
  const target = leaveWorkflowDutyTarget(application);
  const people = application.approvalPlan.stages.flatMap(stage => stage.key === 'manager' && application.approvalPlan!.approvalClass === 'manager'
    ? stage.approvers : resolve(stage.key === 'manager' ? 'leave_manager' : 'leave_supervisor', target) ?? stage.approvers);
  return [...new Map(people.map(person => [person.openId, structuredClone(person)])).values()];
}

export function originalLeaveNotificationRoleRecipients(application: LeaveNotificationApplication, kind: 'supervisor' | 'manager' | 'professional'): LeaveRoutePerson[] {
  const plan = application.approvalPlan;
  if (!plan) throw new LeaveApprovalRoutingError('INVALID_APPLICANT', '请休假通知的岗位快照缺失，请先恢复原申请');
  if (kind === 'supervisor') return structuredClone(plan.stages.filter(stage => stage.key === 'supervisor').flatMap(stage => stage.approvers));
  if (kind === 'professional') return structuredClone(plan.notificationPlan.professionalRecipients);
  if (plan.approvalClass === 'manager') return [];
  const otherRoles = new Set([...plan.stages.filter(stage => stage.key === 'supervisor').flatMap(stage => stage.approvers), ...plan.notificationPlan.professionalRecipients].map(row => row.openId));
  const fixed = fixedLeaveNotificationIds(application);
  return structuredClone(plan.notificationPlan.managerRecipients ?? [
    ...plan.stages.filter(stage => stage.key === 'manager').flatMap(stage => stage.approvers),
    ...plan.notificationPlan.finalResultRecipients.filter(row => MANAGER_POSITIONS.has(normalizeCompactLabel(row.position)) || !fixed.has(row.openId) && !otherRoles.has(row.openId)),
  ]);
}

export function resolveCurrentLeaveNotificationRecipients(
  application: Pick<LeaveWorkflowApplicationEntry, 'snapshot' | 'approvalPlan' | 'resultRecipients'>,
  resolve: LeaveNotificationDutyResolver,
): LeaveRoutePerson[] {
  const plan = application.approvalPlan;
  if (!plan) throw new LeaveApprovalRoutingError('INVALID_APPLICANT', '请休假通知的岗位快照缺失，请先恢复原申请');
  const snapshot = application.snapshot;
  const target = leaveWorkflowDutyTarget(application);
  const supervisor = originalLeaveNotificationRoleRecipients(application, 'supervisor');
  const professional = originalLeaveNotificationRoleRecipients(application, 'professional');
  const managers = originalLeaveNotificationRoleRecipients(application, 'manager');
  const fixed = fixedLeaveNotificationIds(application);
  const currentSupervisor = supervisor.length ? resolve('leave_supervisor', target) : null;
  const currentManagers = managers.length ? resolve('leave_manager', target) : null;
  const currentProfessional = target.specialty ? resolve('professional_supervisor', target) : null;
  if (currentSupervisor === null && currentManagers === null && currentProfessional === null) return structuredClone(application.resultRecipients);
  const roleIds = new Set([...supervisor, ...managers, ...professional].map(row => row.openId));
  const knownPeople = new Map([...application.resultRecipients, ...plan.notificationPlan.finalResultRecipients, ...plan.notificationPlan.substituteRecipients].map(row => [row.openId, row]));
  const fixedPeople = [...fixed].filter((id): id is string => !!id).map(openId => knownPeople.get(openId) ?? {
    openId, name: openId === snapshot.substituteOpenId ? snapshot.substituteName || '替班人员' : snapshot.applicantName || '申请相关人员',
    position: '', buildings: [snapshot.building],
  });
  const recipients = [
    ...application.resultRecipients.filter(row => fixed.has(row.openId) || !roleIds.has(row.openId)),
    ...fixedPeople,
    ...(currentSupervisor ?? supervisor), ...(currentManagers ?? managers), ...(currentProfessional ?? professional),
  ];
  return [...new Map(recipients.map(row => [row.openId, structuredClone(row)])).values()];
}

export type LeaveApprovalRoutingErrorCode =
  | 'INVALID_APPLICANT'
  | 'INVALID_APPROVAL_DAY_COUNT'
  | 'ROUTE_TARGET_NOT_FOUND'
  | 'ROUTE_TARGET_NOT_UNIQUE'
  | 'APPROVER_NOT_FOUND'
  | 'APPROVER_NAME_NOT_UNIQUE'
  | 'NO_ELIGIBLE_APPROVER'
  | 'MANAGER_ESCALATION_NOT_CONFIGURED'
  | 'PROFESSIONAL_SUPERVISOR_NOT_FOUND';

export class LeaveApprovalRoutingError extends Error {
  constructor(
    public readonly code: LeaveApprovalRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LeaveApprovalRoutingError';
  }
}

const MANAGER_POSITIONS = new Set(['设施运维经理', '设施运维副经理']);
const DUTY_SUBSTITUTE_BUILDINGS = new Set(['A楼', 'B楼', 'C楼', 'H楼']);
const DUTY_POSITIONS = new Set([
  '运维值班员',
  '运维值班长',
  '值班员',
  '值班长',
  'H楼值班示例人员001',
]);
const MANDATORY_LONG_WHITE_SUBSTITUTE_POSITIONS = new Set(['H楼值班示例人员001']);
const DIRECT_MANAGER_POSITIONS = new Set([
  '综合管理',
  '消防工程师',
  '安全&消防工程师',
  '安全消防工程师',
  '设施运维示例人员001',
  '设施示例人员001',
  'H楼值班示例人员001',
  '电气示例人员001',
  '暖通示例人员001',
  '弱电示例人员001',
  '消防示例人员001',
]);

export function buildLeaveApprovalPlan(
  input: LeaveApprovalRoutingInput,
): LeaveApprovalPlan {
  const applicant = normalizePerson(input.applicant);
  if (!applicant.name || (!applicant.personRecordId && !applicant.openId)) {
    throw new LeaveApprovalRoutingError(
      'INVALID_APPLICANT',
      '请休假申请人缺少姓名或人员记录标识，无法确定审批人',
    );
  }

  const approvalDayCount = Number(input.approvalDayCount);
  if (!Number.isFinite(approvalDayCount) || approvalDayCount < 0) {
    throw new LeaveApprovalRoutingError(
      'INVALID_APPROVAL_DAY_COUNT',
      '请休假审批天数无效，无法确定审批阶段',
    );
  }

  const records = input.organizationRecords.map(normalizeRecord);
  const approvalClass = classifyApprovalClass(applicant);
  const discipline = classifyDiscipline(applicant.position);
  const specialty = discipline && ({ electrical: '电气', hvac: '暖通', weak_current: '弱电', fire: '消防' } as const)[discipline];
  const target = { building: applicant.buildings, ...(specialty ? { specialty } : {}) };
  const resolveDuty: NonNullable<LeaveApprovalRoutingInput['resolveDuty']> = (kind, fallback, scope) => input.resolveDuty ? input.resolveDuty(kind, fallback, scope) : fallback();
  const managerApprovers =
    approvalClass === 'manager'
      ? []
      : deduplicateEligible(applicant, resolveDuty('leave_manager', () => resolveManagerApprovers(applicant, records), target));
  const professionalRecipients = discipline
    ? deduplicateEligible(applicant, resolveDuty('professional_supervisor', () => resolveProfessionalRecipients(applicant, records, discipline), target), false, false)
    : [];

  const stages = buildStages({
    applicant,
    records,
    approvalClass,
    approvalDayCount,
    managerApprovers,
    managerEscalationApprovers: input.managerEscalationApprovers,
    resolveSupervisor: () => deduplicateEligible(applicant, resolveDuty('leave_supervisor', () => resolveOrdinarySupervisor(applicant, records), target)),
  });

  return {
    approvalClass,
    discipline,
    approvalDayCount,
    stages,
    notificationPlan: {
      managerRecipients: managerApprovers,
      finalResultRecipients: deduplicateEligible(
        applicant,
        [
          applicant,
          ...stages.flatMap((stage) => stage.approvers),
          ...managerApprovers,
          ...professionalRecipients,
        ],
        true,
      ),
      professionalRecipients,
      substituteRecipients: [],
    },
  };
}

function buildStages(input: {
  applicant: LeaveRoutePerson;
  records: LeaveOrganizationRecord[];
  approvalClass: LeaveApprovalClass;
  approvalDayCount: number;
  managerApprovers: LeaveRoutePerson[];
  managerEscalationApprovers?: LeaveRoutePerson[];
  resolveSupervisor: () => LeaveRoutePerson[];
}): LeaveApprovalStage[] {
  if (input.approvalClass === 'manager') {
    const escalation = deduplicateEligible(
      input.applicant,
      input.managerEscalationApprovers ?? [],
      false,
      false,
    );
    if (!escalation.length) {
      throw new LeaveApprovalRoutingError(
        'MANAGER_ESCALATION_NOT_CONFIGURED',
        '经理或副经理请休假未配置非本人上级审批组，已拒绝自动路由',
      );
    }
    return [stage('manager', escalation)];
  }

  if (input.approvalClass === 'manager_direct') {
    return [stage('manager', input.managerApprovers)];
  }

  const supervisorApprovers = input.resolveSupervisor();
  const stages = [stage('supervisor', supervisorApprovers)];
  if (input.approvalDayCount >= 3) {
    stages.push(stage('manager', input.managerApprovers));
  }
  return stages;
}

function resolveOrdinarySupervisor(
  applicant: LeaveRoutePerson,
  records: LeaveOrganizationRecord[],
): LeaveRoutePerson[] {
  const applicantRecord = findApplicantRecord(applicant, records);
  const names = applicantRecord?.supervisorNames ?? [];
  if (names.length) return resolvePeopleByNames(applicant, records, names);
  throw new LeaveApprovalRoutingError(
    'ROUTE_TARGET_NOT_FOUND',
    '未找到申请人的直属示例人员001配置，无法确定请休假审批人',
  );
}

function findApplicantRecord(
  applicant: LeaveRoutePerson,
  records: LeaveOrganizationRecord[],
): LeaveOrganizationRecord | undefined {
  if (applicant.personRecordId) {
    const byRecordId = records.find(
      (record) => record.personRecordId === applicant.personRecordId,
    );
    if (byRecordId) return byRecordId;
  }
  if (applicant.openId) {
    const byOpenId = records.find(
      (record) => record.openId === applicant.openId,
    );
    if (byOpenId) return byOpenId;
  }
  const byName = records.filter((record) => record.name === applicant.name);
  if (byName.length > 1) {
    throw new LeaveApprovalRoutingError(
      'ROUTE_TARGET_NOT_UNIQUE',
      `请休假申请人“${applicant.name}”在组织架构中无法唯一匹配`,
    );
  }
  return byName[0];
}

function resolveManagerApprovers(
  applicant: LeaveRoutePerson,
  records: LeaveOrganizationRecord[],
): LeaveRoutePerson[] {
  const managers = records.filter((record) =>
    MANAGER_POSITIONS.has(record.position),
  );
  if (!managers.length) {
    throw new LeaveApprovalRoutingError(
      'APPROVER_NOT_FOUND',
      '组织架构中未配置设施运维经理或副经理，无法确定请休假审批人',
    );
  }
  const namedManagers = managers.flatMap(
    (record) => record.supervisorNames ?? [],
  );
  const namedPeople = namedManagers.length
    ? resolvePeopleByNames(applicant, records, namedManagers, false)
    : [];
  const directPeople = managers.map(toRoutePerson);
  return deduplicateEligible(applicant, [...namedPeople, ...directPeople]);
}

function resolveProfessionalRecipients(
  applicant: LeaveRoutePerson,
  records: LeaveOrganizationRecord[],
  discipline: Exclude<LeaveDiscipline, null>,
): LeaveRoutePerson[] {
  const allowedPositions = {
    electrical: new Set(['电气示例人员001', '电气专业示例人员001']),
    hvac: new Set(['暖通示例人员001', '暖通专业示例人员001']),
    weak_current: new Set(['弱电示例人员001', '弱电专业示例人员001']),
    fire: new Set(['消防示例人员001', '消防专业示例人员001']),
  }[discipline];
  const candidates = records
    .filter((record) => allowedPositions.has(record.position))
    .map(toRoutePerson);
  const result = deduplicateEligible(applicant, candidates, true);
  if (!result.length) {
    throw new LeaveApprovalRoutingError(
      'PROFESSIONAL_SUPERVISOR_NOT_FOUND',
      '未找到对应专业示例人员001，无法安全发送请休假结果知会',
    );
  }
  return result;
}

function resolvePeopleByNames(
  applicant: LeaveRoutePerson,
  records: LeaveOrganizationRecord[],
  names: string[],
  requireEligible = true,
): LeaveRoutePerson[] {
  const uniqueNames = [...new Set(names.map(normalizeName).filter(Boolean))];
  const candidates = uniqueNames.flatMap((name) => {
    const matches = records.filter((record) => record.name === name);
    const eligible = matches.filter((record) => Boolean(record.openId));
    const openIds = new Set(eligible.map((record) => record.openId));
    if (!eligible.length) {
      throw new LeaveApprovalRoutingError(
        'APPROVER_NOT_FOUND',
        `审批人“${name}”在组织架构中不存在或缺少飞书账号`,
      );
    }
    if (openIds.size > 1) {
      throw new LeaveApprovalRoutingError(
        'APPROVER_NAME_NOT_UNIQUE',
        `审批人“${name}”在组织架构中存在多个飞书账号，无法唯一解析`,
      );
    }
    return [toRoutePerson(eligible[0])];
  });
  const result = deduplicateEligible(applicant, candidates, !requireEligible);
  if (requireEligible && !result.length) {
    throw new LeaveApprovalRoutingError(
      'NO_ELIGIBLE_APPROVER',
      '申请人不能审批自己的请休假申请，且没有其他可用审批人',
    );
  }
  return result;
}

export function requiresSupervisorSubstitute(
  applicant: LeaveRoutePerson,
): boolean {
  const normalized = normalizePerson(applicant);
  if (
    normalized.buildings.includes('D楼') ||
    normalized.buildings.includes('E楼') ||
    normalized.buildings.includes('110站')
  ) {
    return true;
  }
  return (
    normalized.buildings.some((building) =>
      DUTY_SUBSTITUTE_BUILDINGS.has(building),
    ) && DUTY_POSITIONS.has(normalized.position)
  );
}

export function requiresMandatoryLongWhiteSubstitute(
  applicant: LeaveRoutePerson,
): boolean {
  return MANDATORY_LONG_WHITE_SUBSTITUTE_POSITIONS.has(
    normalizePerson(applicant).position,
  );
}

export function requiresLongWhiteSubstituteDecision(
  groups: LeaveRequestShiftGroup[],
): boolean {
  return (
    groups.length > 0 && groups.every((group) => group.kind === 'long_white')
  );
}

export function buildLeaveShiftCandidateSets(input: {
  groups: LeaveRequestShiftGroup[];
  schedules: LeaveRequestImpactSchedule[];
  applicant: LeaveRoutePerson;
  selectablePeople: LeaveSubstituteCandidate[];
  allowOnDutySubstitution?: boolean;
  selections?: LeaveShiftAssignmentSelection[];
}): LeaveShiftCandidateSet[] {
  const applicant = normalizePerson(input.applicant);
  const selectablePeople = uniqueSubstituteCandidates(input.selectablePeople);

  return input.groups.map((group) => {
    if (input.allowOnDutySubstitution) {
      const twoLevelCandidates = buildTwoLevelSubstituteCandidates({
        group,
        schedules: input.schedules,
        applicant,
        people: input.selectablePeople,
        ...(input.selections ? { selection: input.selections.find((row) => row.shiftKey === group.shiftKey) || { substitutePersonRecordId: '' } } : {}),
      });
      return { shiftKey: group.shiftKey, candidates: twoLevelCandidates.map((choice) => choice.person), twoLevelCandidates };
    }
    const rule = calculateLeaveRequestSubstituteRule(
      input.schedules,
      {
        leaveStaffName: applicant.name,
        startAt: group.startAt,
        endAt: group.endAt,
      },
      { forceRequiresSubstitute: true },
    );
    const candidates = selectablePeople.filter(
      (candidate) =>
        !isSamePerson(applicant, candidate) &&
        !isLeaveSubstituteStaffBlocked(rule, candidate.name),
    );
    return { shiftKey: group.shiftKey, candidates };
  });
}

export function validateLeaveShiftAssignmentPlan(input: {
  groups: LeaveRequestShiftGroup[];
  selections: LeaveShiftAssignmentSelection[];
  candidateSets: LeaveShiftCandidateSet[];
  actorOpenId: string;
  actorName: string;
  changedAt: string;
}):
  | { valid: true; assignments: LeaveShiftSubstituteAssignment[] }
  | { valid: false; shiftKey: string; message: string } {
  const groupKeys = new Set(input.groups.map((group) => group.shiftKey));
  const selections = new Map<string, LeaveShiftAssignmentSelection>();

  for (const selection of input.selections) {
    const shiftKey = normalizeText(selection.shiftKey);
    if (!groupKeys.has(shiftKey)) {
      return assignmentError(shiftKey, '提交中包含未知班次，请刷新卡片后重试');
    }
    if (selections.has(shiftKey)) {
      return assignmentError(shiftKey, '同一班次只能选择一名替班人员');
    }
    selections.set(shiftKey, {
      shiftKey,
      substitutePersonRecordId: normalizeText(
        selection.substitutePersonRecordId,
      ),
      ...(selection.backfillPersonRecordId ? { backfillPersonRecordId: normalizeText(selection.backfillPersonRecordId) } : {}),
      ...(selection.originalPostSignature ? { originalPostSignature: normalizeText(selection.originalPostSignature) } : {}),
    });
  }

  const candidateSets = new Map(
    input.candidateSets.map((set) => [set.shiftKey, set] as const),
  );
  const assignments: LeaveShiftSubstituteAssignment[] = [];
  for (const group of input.groups) {
    const selection = selections.get(group.shiftKey);
    if (!selection?.substitutePersonRecordId) {
      return assignmentError(group.shiftKey, '请为每个班次选择替班人员');
    }
    const candidateSet = candidateSets.get(group.shiftKey);
    const candidate = (candidateSet?.candidates || []).find(
      (person) => person.personRecordId === selection.substitutePersonRecordId,
    );
    if (!candidate?.openId) {
      return assignmentError(
        group.shiftKey,
        '该替班人员当前不可用，请重新选择',
      );
    }
    let originalPostBackfills: LeaveShiftSubstituteAssignment['originalPostBackfills'];
    if (candidateSet?.twoLevelCandidates) {
      const choice = candidateSet.twoLevelCandidates.find((row) => row.person.personRecordId === candidate.personRecordId);
      if (choice?.originalGroups.length && selection.originalPostSignature !== originalPostSignature(choice.originalGroups)) {
        return assignmentError(group.shiftKey, '原岗位已变化，请重新核对替班安排');
      }
      const resolved = resolveTwoLevelSubstitution({
        candidates: candidateSet.twoLevelCandidates,
        primaryPersonRecordId: candidate.personRecordId,
        backfillPersonRecordId: selection.backfillPersonRecordId,
      });
      if (resolved.valid === false) return assignmentError(group.shiftKey, resolved.message);
      if (resolved.backfills.length) {
        originalPostBackfills = resolved.backfills.map(({ person, group: original }) => ({
          group: structuredClone(original),
          substitutePersonRecordId: person.personRecordId,
          substituteName: person.name,
          substituteOpenId: person.openId,
        }));
      }
    } else if (selection.backfillPersonRecordId || selection.originalPostSignature) {
      return assignmentError(group.shiftKey, '该班次不支持原岗补位，请重新核对');
    }
    assignments.push({
      shiftKey: group.shiftKey,
      substitutePersonRecordId: candidate.personRecordId,
      scheduleRecordIds: [...group.scheduleRecordIds],
      scheduleDate: group.scheduleDate,
      startAt: group.startAt,
      endAt: group.endAt,
      shift: group.shift,
      buildings: [...group.buildings],
      teams: [...group.teams],
      substituteName: candidate.name,
      substituteOpenId: candidate.openId,
      updatedByOpenId: normalizeText(input.actorOpenId),
      updatedByName: normalizeName(input.actorName),
      updatedAt: normalizeText(input.changedAt),
      ...(originalPostBackfills ? { originalPostBackfills, backfillPersonRecordId: selection.backfillPersonRecordId, originalPostSignature: selection.originalPostSignature } : {}),
    });
  }

  const occupiedPosts = assignments.flatMap((assignment) => [
    assignment,
    ...(assignment.originalPostBackfills || []).map((backup) => ({
      ...assignment,
      ...backup.group,
      substitutePersonRecordId: backup.substitutePersonRecordId,
      substituteName: backup.substituteName,
      substituteOpenId: backup.substituteOpenId,
    })),
  ]);
  for (let index = 0; index < occupiedPosts.length; index += 1) {
    const current = occupiedPosts[index];
    for (let comparedIndex = 0; comparedIndex < index; comparedIndex += 1) {
      const previous = occupiedPosts[comparedIndex];
      if (
        sameCandidate(previous, current) &&
        assignmentWindowsOverlapOrTouch(previous, current)
      ) {
        return assignmentError(
          current.shiftKey,
          `${current.substituteName}不能同时替两个时间重叠的班次`,
        );
      }
    }
  }

  return { valid: true, assignments };
}

function assignmentError(
  shiftKey: string,
  message: string,
): { valid: false; shiftKey: string; message: string } {
  return { valid: false, shiftKey, message };
}

function assignmentWindowsOverlapOrTouch(
  left: LeaveShiftSubstituteAssignment,
  right: LeaveShiftSubstituteAssignment,
): boolean {
  const leftStart = parseShanghaiLocalDateTime(
    left.startAt,
  )?.wallClockHourIndex;
  const leftEnd = parseShanghaiLocalDateTime(left.endAt)?.wallClockHourIndex;
  const rightStart = parseShanghaiLocalDateTime(
    right.startAt,
  )?.wallClockHourIndex;
  const rightEnd = parseShanghaiLocalDateTime(right.endAt)?.wallClockHourIndex;
  if (
    leftStart === undefined ||
    leftEnd === undefined ||
    rightStart === undefined ||
    rightEnd === undefined
  ) {
    return true;
  }
  return Math.min(leftEnd, rightEnd) >= Math.max(leftStart, rightStart);
}

function sameCandidate(
  left: LeaveShiftSubstituteAssignment,
  right: LeaveShiftSubstituteAssignment,
): boolean {
  return left.substituteOpenId === right.substituteOpenId;
}

function isSamePerson(
  applicant: LeaveRoutePerson,
  candidate: LeaveSubstituteCandidate,
): boolean {
  return Boolean(
    (applicant.personRecordId &&
      applicant.personRecordId === candidate.personRecordId) ||
    (applicant.openId && applicant.openId === candidate.openId),
  );
}

function uniqueSubstituteCandidates(
  people: LeaveSubstituteCandidate[],
): LeaveSubstituteCandidate[] {
  const result = new Map<string, LeaveSubstituteCandidate>();
  for (const person of people) {
    const personRecordId = normalizeText(person.personRecordId);
    const openId = normalizeText(person.openId);
    const name = normalizeName(person.name);
    if (!personRecordId || !openId || !name || result.has(personRecordId)) {
      continue;
    }
    result.set(personRecordId, {
      personRecordId,
      openId,
      name,
      position: normalizeCompactLabel(person.position),
      buildings: Array.isArray(person.buildings)
        ? person.buildings.map(normalizeBuilding).filter(Boolean)
        : [],
    });
  }
  return [...result.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'zh-CN') ||
      left.personRecordId.localeCompare(right.personRecordId),
  );
}

function classifyApprovalClass(person: LeaveRoutePerson): LeaveApprovalClass {
  const position = normalizeCompactLabel(person.position);
  if (MANAGER_POSITIONS.has(position)) return 'manager';
  if (is110StationChief(person)) return 'ordinary';
  if (
    DIRECT_MANAGER_POSITIONS.has(position) ||
    /(示例人员001|经理|站长)/u.test(position)
  ) {
    return 'manager_direct';
  }
  return 'ordinary';
}

function is110StationChief(person: LeaveRoutePerson): boolean {
  return (
    normalizeCompactLabel(person.position) === '110站站长' &&
    person.buildings.map(normalizeBuilding).includes('110站')
  );
}

function classifyDiscipline(position: string): LeaveDiscipline {
  const normalized = normalizeCompactLabel(position);
  if (normalized.includes('电气')) return 'electrical';
  if (normalized.includes('暖通')) return 'hvac';
  if (normalized.includes('弱电')) return 'weak_current';
  if (normalized.includes('消防')) return 'fire';
  return null;
}

function stage(
  key: LeaveApprovalStage['key'],
  approvers: LeaveRoutePerson[],
): LeaveApprovalStage {
  return {
    key,
    approvers,
    resolutionPolicy: 'first_legal_action',
  };
}

function deduplicateEligible(
  applicant: LeaveRoutePerson,
  candidates: LeaveRoutePerson[],
  includeApplicant = false,
  requireEligible = true,
): LeaveRoutePerson[] {
  const result = new Map<string, LeaveRoutePerson>();
  for (const candidate of candidates) {
    const person = normalizePerson(candidate);
    if (!person.openId) continue;
    if (
      !includeApplicant &&
      applicant.openId &&
      person.openId === applicant.openId
    )
      continue;
    if (!result.has(person.openId)) result.set(person.openId, person);
  }
  if (!includeApplicant && requireEligible && !result.size) {
    throw new LeaveApprovalRoutingError(
      'NO_ELIGIBLE_APPROVER',
      '申请人不能审批自己的请休假申请，且没有其他可用审批人',
    );
  }
  return [...result.values()];
}

function normalizeRecord(
  record: LeaveOrganizationRecord,
): LeaveOrganizationRecord {
  return {
    ...normalizePerson(record),
    supervisorNames: Array.isArray(record.supervisorNames)
      ? record.supervisorNames.map(normalizeName).filter(Boolean)
      : [],
  };
}

function normalizePerson(person: LeaveRoutePerson): LeaveRoutePerson {
  return {
    personRecordId:
      typeof person.personRecordId === 'string'
        ? person.personRecordId.trim()
        : undefined,
    name: normalizeName(person.name),
    openId: typeof person.openId === 'string' ? person.openId.trim() : '',
    position: normalizeCompactLabel(person.position),
    buildings: Array.isArray(person.buildings)
      ? person.buildings.map(normalizeBuilding).filter(Boolean)
      : [],
  };
}

function toRoutePerson(record: LeaveOrganizationRecord): LeaveRoutePerson {
  return normalizePerson(record);
}

function normalizeName(value: unknown): string {
  return normalizeText(value).replace(/\s+/gu, ' ');
}

function normalizeCompactLabel(value: unknown): string {
  return normalizeText(value).replace(/\s+/gu, '');
}

function normalizeBuilding(value: unknown): string {
  const label = normalizeCompactLabel(value).toUpperCase();
  if (['A', 'A楼', 'A栋'].includes(label)) return 'A楼';
  if (['B', 'B楼', 'B栋'].includes(label)) return 'B楼';
  if (['C', 'C楼', 'C栋'].includes(label)) return 'C楼';
  if (['D', 'D楼', 'D栋'].includes(label)) return 'D楼';
  if (['E', 'E楼', 'E栋'].includes(label)) return 'E楼';
  if (['H', 'H楼', 'H栋'].includes(label)) return 'H楼';
  if (label === '110' || label.includes('110站')) return '110站';
  return label;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string'
    ? value
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
        .trim()
    : '';
}
