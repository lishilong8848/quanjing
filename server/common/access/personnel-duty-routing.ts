import type { CardRoleCode, ConfigurationPerson } from '../../../shared/access-configuration.interface';
import type { AuthorityDutyKind } from '../../../shared/personnel-authority.interface';
import type { PersonnelDutyAssignment } from '../../../shared/personnel-duty-routing';
import { AUTHORITY_DUTY_CATALOG, validAuthorityDutyOrigin } from '../../../shared/personnel-authority.interface';
import { BUILDING_ADMIN_BUILDINGS } from '../../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES, normalizeProfessionalScope } from '../../../shared/professional-access';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthorityDuty, AuthorityPerson } from '../../../shared/personnel-authority.interface';
import type { PersonnelDutyRoutingChange } from '../../../shared/personnel-duty-routing';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const selection = (value: unknown, options: readonly string[]) => value === null || Array.isArray(value) && value.length > 0 && value.length <= options.length && new Set(value).size === value.length && value.every(item => typeof item === 'string' && options.includes(item));
export const CARD_PERSONNEL_DUTIES: Readonly<Record<CardRoleCode, AuthorityDutyKind>> = {
  purchase_manager: 'purchase_manager', purchase_approvers: 'purchase_approver', purchase_executor: 'purchase_executor',
  building_executor: 'building_executor', warehouse_responsible: 'warehouse_approver', warehouse_notify: 'warehouse_notify', contract_notify: 'contract_notify',
};

export function removePersonnelDutyCardOverride(assignments: Record<string, PersonnelDutyAssignment> | undefined, code: CardRoleCode, building: string | null): void {
  for (const [id, rule] of Object.entries(assignments || {})) {
    if (rule.kind !== CARD_PERSONNEL_DUTIES[code]) continue;
    if (building === null) { delete assignments![id]; continue; }
    if (rule.buildings !== null && !rule.buildings.includes(building as never)) continue;
    const remaining = (rule.buildings || [...BUILDING_ADMIN_BUILDINGS]).filter(value => value !== building);
    if (remaining.length) rule.buildings = remaining; else delete assignments![id];
  }
}
export function validPersonnelDutyAssignments(value: unknown): value is Record<string, PersonnelDutyAssignment> {
  if (!record(value) || Object.keys(value).length > 1000) return false;
  const identities = new Map<string, string>();
  for (const [id, rule] of Object.entries(value)) {
    if (!record(rule)) return false;
    const confirmation = typeof rule.baselineConfirmationId === 'string' ? 'baselineConfirmationId' : 'confirmedBatchId';
    if (Object.keys(rule).sort().join(',') !== ['appId','buildings',confirmation,'dutyRecordId','endsAt','kind','members','specialties','startsAt','version',...(rule.origin === undefined ? [] : ['origin'])].sort().join(',') ||
      id !== rule.dutyRecordId || !validAuthorityDutyOrigin(id,rule.origin) || typeof rule.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(rule.appId) ||
      typeof rule[confirmation] !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(rule[confirmation])) ||
      !Number.isSafeInteger(rule.version) || Number(rule.version) < 1 || !Number.isSafeInteger(rule.startsAt) || Number(rule.startsAt) < 0 ||
      rule.endsAt !== null && (!Number.isSafeInteger(rule.endsAt) || Number(rule.endsAt) <= Number(rule.startsAt)) ||
      !selection(rule.buildings, BUILDING_ADMIN_BUILDINGS) || !selection(rule.specialties, PROFESSIONAL_SPECIALTIES) || !Array.isArray(rule.members) || rule.members.length > 100) return false;
    const definition = AUTHORITY_DUTY_CATALOG.find(item => item.id === rule.kind);
    if (!definition || definition.buildingRequired && rule.buildings === null || definition.specialtyRequired && rule.specialties === null || definition.singleHolder && rule.members.length > 1) return false;
    const seen = new Set<string>();
    for (const person of rule.members) {
      if (!record(person) || Object.keys(person).sort().join(',') !== 'name,openId,personId,recordId' || typeof person.personId !== 'string' || !/^local-external-[a-f0-9]{64}$/.test(person.personId) ||
        typeof person.recordId !== 'string' || !/^rec[A-Za-z0-9_]{1,97}$/.test(person.recordId) || typeof person.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(person.openId) ||
        typeof person.name !== 'string' || !person.name.trim() || person.name !== person.name.trim() || person.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(person.name) || seen.has(person.openId)) return false;
      seen.add(person.openId);
      const identity = JSON.stringify([person.personId, person.recordId, person.openId]);
      for (const key of [person.personId, person.recordId, person.openId]) {
        const scopedKey = `${rule.appId}:${key}`, prior = identities.get(scopedKey);
        if (prior && prior !== identity) return false;
        identities.set(scopedKey, identity);
      }
    }
  }
  return true;
}

export function personnelDutyAssignmentFingerprint(value: PersonnelDutyAssignment | undefined): string {
  if (value !== undefined && !validPersonnelDutyAssignments({ [value.dutyRecordId]: value })) throw new ServiceUnavailableException('岗位配置无效');
  return createHash('sha256').update(JSON.stringify(value ? { appId: value.appId, dutyRecordId: value.dutyRecordId, kind: value.kind,
    buildings: value.buildings && [...value.buildings].sort(), specialties: value.specialties && [...value.specialties].sort(), startsAt: value.startsAt, endsAt: value.endsAt,
    version: value.version, ...(value.origin ? { origin:value.origin } : {}), ...(value.baselineConfirmationId ? { baselineConfirmationId: value.baselineConfirmationId } : { confirmedBatchId: value.confirmedBatchId }), members: [...value.members].sort((a, b) => a.openId.localeCompare(b.openId)).map(person => [person.personId, person.recordId, person.openId, person.name]) } : null)).digest('hex');
}

export function normalizePersonnelDutyRoutingChanges(value: unknown): PersonnelDutyRoutingChange[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new ServiceUnavailableException('岗位交接配置无效');
  const validationBatch = '00000000-0000-0000-0000-000000000000';
  const assignments: Record<string, PersonnelDutyAssignment> = {};
  const changes: PersonnelDutyRoutingChange[] = [];
  for (const row of value) {
    if (!record(row) || Object.keys(row).sort().join(',') !== 'assignment,previousFingerprint' || typeof row.previousFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.previousFingerprint) ||
      !record(row.assignment) || Object.prototype.hasOwnProperty.call(row.assignment, 'confirmedBatchId') || typeof row.assignment.dutyRecordId !== 'string' || assignments[row.assignment.dutyRecordId]) throw new ServiceUnavailableException('岗位交接配置结构无效');
    const rule = { ...row.assignment, confirmedBatchId: validationBatch } as unknown as PersonnelDutyAssignment;
    assignments[rule.dutyRecordId] = rule;
    if (!validPersonnelDutyAssignments(assignments)) throw new ServiceUnavailableException('岗位交接人员或范围无效');
    const { confirmedBatchId: _batch, ...assignment } = rule;
    changes.push({ previousFingerprint: row.previousFingerprint, assignment: structuredClone(assignment) });
  }
  return changes.sort((a, b) => a.assignment.dutyRecordId.localeCompare(b.assignment.dutyRecordId));
}

export function buildPersonnelDutyRoutingChanges(people: readonly AuthorityPerson[], duties: readonly AuthorityDuty[], from: AuthorityPerson, to: AuthorityPerson,
  current: Readonly<Record<string, PersonnelDutyAssignment>> | undefined, appId: string): PersonnelDutyRoutingChange[] {
  return normalizePersonnelDutyRoutingChanges(duties.map(duty => {
    const ids = [...new Set(duty.personnelIds.map(id => id === from.id ? to.id : id))];
    if (!ids.includes(to.id)) throw new ServiceUnavailableException('岗位尚未关联接任者');
    const members = ids.map(id => {
      const person = people.find(value => value.id === id);
      if (!person || !person.openId) throw new ServiceUnavailableException('岗位人员身份缺失');
      return person;
    }).filter(person => person.active).map(person => ({ personId: person.id, recordId: person.recordId, openId: person.openId!, name: person.name }));
    return { previousFingerprint: personnelDutyAssignmentFingerprint(current?.[duty.recordId]), assignment: { appId, dutyRecordId: duty.recordId, ...(duty.origin ? {origin:duty.origin} : {}), kind: duty.kind,
      buildings: duty.buildings && [...duty.buildings], specialties: duty.specialties && [...duty.specialties], startsAt: duty.startsAt, endsAt: duty.endsAt, version: duty.version, members } };
  }));
}

export function resolvePersonnelDutyMembers(assignments: Readonly<Record<string, PersonnelDutyAssignment>> | undefined, appId: string,
  kind: AuthorityDutyKind, target: { building?: unknown; specialty?: unknown }, now = Date.now()): ConfigurationPerson[] | null {
  if (assignments === undefined) return null;
  if (!validPersonnelDutyAssignments(assignments) || !Number.isFinite(now) || !/^cli_[A-Za-z0-9_-]+$/.test(appId) || Object.values(assignments).some(rule => rule.appId !== appId)) throw new ServiceUnavailableException('岗位配置或应用身份无效，请核对权限配置');
  const rules = Object.values(assignments).filter(rule => rule.kind === kind || ['leave_supervisor', 'overtime_supervisor'].includes(kind) && rule.kind === 'building_supervisor');
  if (!rules.length) return null;
  const buildings = normalizedBusinessBuildings(target.building), specialties = normalizeProfessionalScope(target.specialty);
  if ((target.building != null && !buildings.length) || !buildings.length && rules.some(rule => rule.buildings !== null)) throw new ServiceUnavailableException('岗位鉴权缺少明确楼栋');
  const relevant = rules.filter(rule => rule.buildings === null || buildings.some(building => rule.buildings!.includes(building)));
  if (!relevant.length) return null;
  const specialtyParts = Array.isArray(target.specialty) ? target.specialty : typeof target.specialty === 'string' ? target.specialty.split(/[、,，;；/]/u) : [];
  if (target.specialty != null && (!specialties.length || specialties.length !== specialtyParts.length) || !specialties.length && relevant.some(rule => rule.specialties !== null)) throw new ServiceUnavailableException('岗位鉴权缺少明确专业');
  const points = (buildings.length ? buildings : [null]).flatMap(building => (specialties.length ? specialties : [null]).map(specialty => ({ building, specialty })));
  const cells = points.map(point => relevant.filter(rule => (rule.buildings === null || point.building !== null && rule.buildings.includes(point.building)) && (rule.specialties === null || point.specialty !== null && rule.specialties.includes(point.specialty))));
  if (cells.every(cell => !cell.length)) return null;
  if (cells.some(cell => !cell.length)) throw new ServiceUnavailableException('岗位职责未覆盖全部范围，请核对');
  const members = cells.map(cell => new Map(cell.filter(rule => rule.startsAt <= now && (rule.endsAt === null || rule.endsAt > now)).flatMap(rule => rule.members).map(person => [person.openId, person])));
  return [...members[0].values()].filter(person => members.every(cell => cell.has(person.openId))).map(person => ({ openId: person.openId, name: person.name })).sort((a, b) => a.openId.localeCompare(b.openId));
}

export function resolvePersonnelDutyRoutePeople(assignments: Readonly<Record<string, PersonnelDutyAssignment>> | undefined, appId: string,
  kind: AuthorityDutyKind, target: { building?: unknown; specialty?: unknown }): { personRecordId: string; name: string; openId: string; position: string; buildings: string[] }[] | null {
  const members = resolvePersonnelDutyMembers(assignments, appId, kind, target);
  if (members === null) return null;
  return members.map(member => {
    const identity = Object.values(assignments || {}).flatMap(rule => rule.members).find(person => person.openId === member.openId)!;
    return { ...member, personRecordId: identity.recordId, position: AUTHORITY_DUTY_CATALOG.find(duty => duty.id === kind)!.label, buildings: normalizedBusinessBuildings(target.building) };
  });
}
