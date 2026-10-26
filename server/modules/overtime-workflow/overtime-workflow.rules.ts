import type {
  OvertimeApprovalRoute,
  OvertimeApprovalRouteInput,
  OvertimeApprovalRouteKind,
  OvertimeOrganizationRecord,
  OvertimeRoutePerson,
} from './overtime-workflow.types';
import type { OvertimeWorkflowApplicationEntry } from './overtime-workflow.store';

export type OvertimeNotificationDutyResolver = (kind: 'overtime_supervisor' | 'overtime_manager' | 'professional_supervisor', target: { building: string[]; specialty?: string }) => OvertimeRoutePerson[] | null;

export function resolveCurrentOvertimeNotificationRecipients(
  application: Pick<OvertimeWorkflowApplicationEntry, 'snapshot' | 'approvers' | 'managerRecipients' | 'professionalRecipients'>,
  resolve: OvertimeNotificationDutyResolver,
  approved = true,
): OvertimeRoutePerson[] {
  const snapshot = application.snapshot, target = { building: [snapshot.building], ...positionSpecialty(snapshot.position) };
  const duty = overtimeApprovalDuty({ position: snapshot.position, buildings: target.building });
  const approvers = resolve(duty.kind, duty.target) ?? application.approvers;
  const managers = approved ? resolve('overtime_manager', target) ?? application.managerRecipients : [];
  const professionals = approved && application.professionalRecipients?.length
    ? resolve('professional_supervisor', target) ?? application.professionalRecipients : [];
  const recipients = [{ openId: snapshot.applicantOpenId, name: snapshot.applicantName, position: snapshot.position, buildings: target.building }, ...approvers, ...managers, ...professionals];
  return [...new Map(recipients.filter(row => row.openId).map(row => [row.openId, structuredClone(row)])).values()];
}

export type OvertimeApprovalRoutingErrorCode =
  | 'INVALID_APPLICANT'
  | 'ROUTE_TARGET_NOT_FOUND'
  | 'ROUTE_TARGET_NOT_UNIQUE'
  | 'APPROVER_NOT_FOUND'
  | 'APPROVER_NAME_NOT_UNIQUE'
  | 'PROFESSIONAL_SUPERVISOR_NOT_FOUND'
  | 'NO_ELIGIBLE_APPROVER';

export class OvertimeApprovalRoutingError extends Error {
  constructor(
    public readonly code: OvertimeApprovalRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OvertimeApprovalRoutingError';
  }
}

const MANAGER_POSITIONS = new Set(['设施运维经理', '设施运维副经理']);
const H_DUTY_POSITIONS = new Set(['运维值班员', '运维值班长']);
const LEADERSHIP_PATTERN = /(示例人员001|经理|站长)/u;
const STANDARD_BUILDINGS = new Set(['A楼', 'B楼', 'C楼', 'D楼', 'E楼']);

export function resolveOvertimeProfessionalRecipients(
  applicant: OvertimeRoutePerson,
  records: OvertimeOrganizationRecord[],
  resolveDuty?: OvertimeApprovalRouteInput['resolveDuty'],
): OvertimeRoutePerson[] {
  const position = normalizeCompactLabel(applicant.position);
  if (!position.includes('工程师')) return [];
  const discipline = ['电气', '暖通', '弱电', '消防'].find((label) =>
    position.includes(label),
  );
  if (!discipline) return [];
  if (resolveDuty) return finalizeRoute('manager_group', '专业岗位知会', applicant, resolveDuty('professional_supervisor', () => resolveOvertimeProfessionalRecipients(applicant, records), { building: applicant.buildings, specialty: discipline })).approvers;
  const recipients = new Map<string, OvertimeRoutePerson>();
  for (const record of records) {
    const person = normalizePerson(record);
    if (
      [`${discipline}示例人员001`, `${discipline}专业示例人员001`].includes(
        person.position,
      ) &&
      person.openId &&
      person.openId !== applicant.openId
    ) {
      recipients.set(person.openId, person);
    }
  }
  if (!recipients.size) {
    throw new OvertimeApprovalRoutingError(
      'PROFESSIONAL_SUPERVISOR_NOT_FOUND',
      `未找到有飞书账号的${discipline}专业示例人员001，无法发送加班结果知会`,
    );
  }
  return [...recipients.values()];
}

export function resolveOvertimeApprovalRoute(
  input: OvertimeApprovalRouteInput,
): OvertimeApprovalRoute {
  const applicant = normalizePerson(input.applicant);
  if (!applicant.name || !applicant.openId) {
    throw new OvertimeApprovalRoutingError(
      'INVALID_APPLICANT',
      '加班申请人缺少姓名或飞书账号，无法确定审批人',
    );
  }

  const records = input.organizationRecords.map(normalizeRecord);
  const position = normalizeCompactLabel(applicant.position);
  const buildings = [...new Set(applicant.buildings.map(normalizeBuilding))];

  if (!LEADERSHIP_PATTERN.test(position)) {
    if (buildings.includes('110站')) {
      return routeViaOrganizationRecord(
        applicant,
        records,
        'station_110_electrical_supervisor',
        (record) =>
          normalizeCompactLabel(record.position) === '电气示例人员001' &&
          record.buildings.map(normalizeBuilding).includes('110站'),
        '包含110站的“电气示例人员001”',
        '110站普通人员按电气示例人员001组织记录路由',
        input.resolveDuty,
      );
    }

    if (buildings.includes('H楼') && H_DUTY_POSITIONS.has(position)) {
      return routeViaOrganizationRecord(
        applicant,
        records,
        'h_duty_supervisor',
        (record) =>
          normalizeCompactLabel(record.position) === '值班账号' &&
          record.buildings.map(normalizeBuilding).includes('H楼'),
        'H楼“值班账号”',
        'H楼值班人员按H楼值班账号记录的示例人员001字段路由',
        input.resolveDuty,
      );
    }

    const standardBuildings = buildings.filter((building) =>
      STANDARD_BUILDINGS.has(building),
    );
    if (standardBuildings.length === 1 && buildings.length === 1) {
      const building = standardBuildings[0];
      return routeViaOrganizationRecord(
        applicant,
        records,
        'building_supervisor',
        (record) =>
          normalizeCompactLabel(record.position) === '值班账号' &&
          record.buildings.map(normalizeBuilding).includes(building),
        `${building}“值班账号”`,
        `${building}普通人员按楼栋值班账号记录的示例人员001字段路由`,
        input.resolveDuty,
      );
    }
  }

  if (input.resolveDuty) return finalizeRoute('manager_group', '按当前经理岗位路由', applicant, input.resolveDuty('overtime_manager', () => routeToManagerGroup(applicant, records).approvers, { building: applicant.buildings, ...positionSpecialty(applicant.position) }));
  return routeToManagerGroup(applicant, records);
}

function positionSpecialty(position: string): { specialty?: string } {
  const specialty = ['电气', '暖通', '弱电', '消防', 'EHS'].find(value => position.includes(value));
  return specialty ? { specialty } : {};
}

export function overtimeApprovalDuty(applicant: Pick<OvertimeRoutePerson, 'position' | 'buildings'>): { kind: 'overtime_supervisor' | 'overtime_manager'; target: { building: string[]; specialty?: string } } {
  const position = normalizeCompactLabel(applicant.position), buildings = [...new Set(applicant.buildings.map(normalizeBuilding))];
  const supervisor = !LEADERSHIP_PATTERN.test(position) && (buildings.includes('110站') || buildings.includes('H楼') && H_DUTY_POSITIONS.has(position) || buildings.length === 1 && STANDARD_BUILDINGS.has(buildings[0]));
  return { kind: supervisor ? 'overtime_supervisor' : 'overtime_manager', target: { building: buildings, ...(supervisor && buildings.includes('110站') ? { specialty: '电气' } : positionSpecialty(position)) } };
}

function routeViaOrganizationRecord(
  applicant: OvertimeRoutePerson,
  records: OvertimeOrganizationRecord[],
  kind: Exclude<OvertimeApprovalRouteKind, 'manager_group'>,
  matches: (record: OvertimeOrganizationRecord) => boolean,
  targetLabel: string,
  reason: string,
  resolveDuty?: OvertimeApprovalRouteInput['resolveDuty'],
): OvertimeApprovalRoute {
  if (resolveDuty) return finalizeRoute(kind, reason, applicant, resolveDuty('overtime_supervisor',
    () => routeViaOrganizationRecord(applicant, records, kind, matches, targetLabel, reason).approvers,
    { building: applicant.buildings, ...(kind === 'station_110_electrical_supervisor' ? { specialty: '电气' } : positionSpecialty(applicant.position)) }));
  const targets = records.filter(matches);
  if (targets.length === 0) {
    throw new OvertimeApprovalRoutingError(
      'ROUTE_TARGET_NOT_FOUND',
      `未找到${targetLabel}组织记录，无法确定加班审批人`,
    );
  }
  const targetNames = new Set(
    targets
      .flatMap((target) => target.supervisorNames ?? [])
      .map(normalizeName)
      .filter(Boolean),
  );
  if (targetNames.size === 0) {
    throw new OvertimeApprovalRoutingError(
      'APPROVER_NOT_FOUND',
      `${targetLabel}组织记录缺少示例人员001字段，无法确定加班审批人`,
    );
  }
  if (targetNames.size > 1) {
    throw new OvertimeApprovalRoutingError(
      'ROUTE_TARGET_NOT_UNIQUE',
      `${targetLabel}组织记录不唯一，无法确定加班审批人`,
    );
  }

  const approver = resolvePersonByUniqueName([...targetNames][0], records);
  return finalizeRoute(kind, reason, applicant, [approver]);
}

function routeToManagerGroup(
  applicant: OvertimeRoutePerson,
  records: OvertimeOrganizationRecord[],
): OvertimeApprovalRoute {
  const managers = records.filter((record) =>
    MANAGER_POSITIONS.has(normalizeCompactLabel(record.position)),
  );
  if (managers.length === 0) {
    throw new OvertimeApprovalRoutingError(
      'APPROVER_NOT_FOUND',
      '组织架构中未配置设施运维经理或设施运维副经理，无法确定加班审批人',
    );
  }

  const managerNames = [
    ...new Set(
      managers
        .flatMap((record) => record.supervisorNames ?? [])
        .map(normalizeName)
        .filter(Boolean),
    ),
  ];
  if (managerNames.length === 0) {
    throw new OvertimeApprovalRoutingError(
      'APPROVER_NOT_FOUND',
      '机房经理组织记录缺少示例人员001字段，无法确定加班审批人',
    );
  }
  const resolvedManagers = managerNames.map((name) =>
    resolvePersonByUniqueName(name, records),
  );
  assertNamesResolveUniquely(resolvedManagers);
  return finalizeRoute(
    'manager_group',
    '示例人员001、经理、H楼非值班或示例人员004员由机房经理组审批',
    applicant,
    resolvedManagers,
  );
}

function resolvePersonByUniqueName(
  name: string,
  records: OvertimeOrganizationRecord[],
): OvertimeRoutePerson {
  const matches = records.filter(
    (record) => normalizeName(record.name) === name,
  );
  if (matches.length === 0) {
    throw new OvertimeApprovalRoutingError(
      'APPROVER_NOT_FOUND',
      `审批人“${name}”在组织架构中不存在，无法发送加班审批卡`,
    );
  }

  const identities = new Set(
    matches.map((record) => record.openId).filter(Boolean),
  );
  if (identities.size === 0) {
    throw new OvertimeApprovalRoutingError(
      'APPROVER_NOT_FOUND',
      `审批人“${name}”缺少飞书账号，无法发送加班审批卡`,
    );
  }
  if (identities.size > 1) {
    throw new OvertimeApprovalRoutingError(
      'APPROVER_NAME_NOT_UNIQUE',
      `审批人“${name}”在组织架构中存在多条不同人员记录，无法唯一解析`,
    );
  }
  const resolvedOpenId = [...identities][0];
  return matches.find((record) => record.openId === resolvedOpenId)!;
}

function assertNamesResolveUniquely(
  records: OvertimeOrganizationRecord[],
): void {
  const byName = new Map<string, Set<string>>();
  records.forEach((record) => {
    const name = normalizeName(record.name);
    const identities = byName.get(name) ?? new Set<string>();
    if (record.openId) identities.add(record.openId);
    byName.set(name, identities);
  });
  for (const [name, identities] of byName) {
    if (identities.size !== 1) {
      throw new OvertimeApprovalRoutingError(
        'APPROVER_NAME_NOT_UNIQUE',
        `审批人“${name}”在组织架构中存在多条不同人员记录，无法唯一解析`,
      );
    }
  }
}

function finalizeRoute(
  kind: OvertimeApprovalRouteKind,
  reason: string,
  applicant: OvertimeRoutePerson,
  candidates: OvertimeRoutePerson[],
): OvertimeApprovalRoute {
  const deduplicated = new Map<string, OvertimeRoutePerson>();
  candidates.forEach((candidate) => {
    const person = normalizePerson(candidate);
    if (!person.openId) {
      throw new OvertimeApprovalRoutingError(
        'APPROVER_NOT_FOUND',
        `审批人“${person.name || '未知人员'}”缺少飞书账号，无法发送加班审批卡`,
      );
    }
    if (
      person.openId === applicant.openId ||
      normalizeName(person.name) === normalizeName(applicant.name)
    ) {
      return;
    }
    if (!deduplicated.has(person.openId)) {
      deduplicated.set(person.openId, person);
    }
  });

  const approvers = [...deduplicated.values()];
  if (approvers.length === 0) {
    throw new OvertimeApprovalRoutingError(
      'NO_ELIGIBLE_APPROVER',
      '申请人不能审批自己的加班申请，且没有其他可用审批人',
    );
  }

  return {
    kind,
    reason,
    approvers,
    approverNames: approvers.map((entry) => entry.name),
  };
}

function normalizeRecord(
  record: OvertimeOrganizationRecord,
): OvertimeOrganizationRecord {
  return {
    ...normalizePerson(record),
    supervisorNames: Array.isArray(record.supervisorNames)
      ? record.supervisorNames.map(normalizeName).filter(Boolean)
      : [],
  };
}

function normalizePerson(person: OvertimeRoutePerson): OvertimeRoutePerson {
  return {
    name: normalizeName(person.name),
    openId: typeof person.openId === 'string' ? person.openId.trim() : '',
    position: normalizeCompactLabel(person.position),
    buildings: Array.isArray(person.buildings)
      ? person.buildings.map(normalizeBuilding).filter(Boolean)
      : [],
  };
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
