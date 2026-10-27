import type { AccessRole } from '../../../shared/access-control.interface';
import { AUTHORITY_DUTY_CATALOG, type AuthorityDuty, type AuthorityPerson } from '../../../shared/personnel-authority.interface';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import { normalizeProfessionalScope } from '../../../shared/professional-access';
import { extractDisplayText, extractDisplayValues, getRecordId, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { authorityRecordIds } from './personnel-authority.people';
import { buildPersonnelPositionDuties, type PersonnelPositionBinding } from './personnel-authority.positions';

export const AUTHORITY_DUTY_FIELDS = ['职责名称','职责类型','在任人员','楼栋范围','专业范围','权限角色','启用','生效时间','结束时间','任职版本','上级职责'] as const;
const roles: Record<string, AccessRole> = { 基地成员: 'site_member', 专业主管: 'professional_admin', 专业工程师: 'professional_engineer', 管理员: 'admin', 子管理员: 'editor', 楼栋主管: 'building_admin', 库房管理员: 'inventory_admin', '采购与合同管理员': 'purchase_admin', 采购申请人: 'purchase_applicant', 施工管理员: 'construction_admin', 值班编辑: 'duty_editor', 采供存管理员: 'supply_chain_admin' };
function timestamp(value: unknown, fallback: number | null): number | null | undefined {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
}

export function buildAuthorityDuties(records: readonly BitableRecordItem[], people: readonly AuthorityPerson[], binding?: PersonnelPositionBinding) {
  const duties: AuthorityDuty[] = [], problems = new Set<string>(), ids = new Set<string>();
  const issues: { recordId?: string; message: string }[] = [], issueKeys = new Set<string>();
  let currentRecordId: string | undefined;
  const problem = (message: string) => {
    problems.add(message); const key = `${currentRecordId || ''}:${message}`;
    if (!issueKeys.has(key)) { issueKeys.add(key); issues.push({ ...(currentRecordId ? { recordId: currentRecordId } : {}), message }); }
  };
  const byRecord = new Map(people.map(person => [person.recordId, person]));
  for (const record of records) {
    const f = record.fields || {}, recordId = getRecordId(record), name = extractDisplayText(f.职责名称, '').trim();
    currentRecordId = /^rec[A-Za-z0-9_]+$/.test(recordId) ? recordId : undefined;
    if (!/^rec[A-Za-z0-9_]+$/.test(recordId) || ids.has(recordId)) { problem('职责记录身份缺失或重复'); continue; }
    ids.add(recordId);
    const definition = AUTHORITY_DUTY_CATALOG.find(item => item.label === extractDisplayText(f.职责类型, '').trim());
    if (!name || !definition) { problem('职责名称或类型无效'); continue; }
    const memberRecords = authorityRecordIds(f.在任人员), parentDutyIds = authorityRecordIds(f.上级职责);
    if (!memberRecords || !parentDutyIds) { problem('职责人员或上级关联无效'); continue; }
    const members = memberRecords.map(id => byRecord.get(id));
    if (members.some(person => !person)) { problem('职责关联人员不存在'); continue; }
    const buildingValues = extractDisplayValues(f.楼栋范围), specialtyValues = extractDisplayValues(f.专业范围);
    const buildings = buildingValues.length === 1 && buildingValues[0] === '全基地' || !buildingValues.length ? null : normalizedBusinessBuildings(buildingValues);
    const specialties = specialtyValues.length === 1 && specialtyValues[0] === '全部专业' || !specialtyValues.length ? null : normalizeProfessionalScope(specialtyValues);
    if (definition.buildingRequired && buildings === null || buildings !== null && (!buildings.length || buildings.length !== buildingValues.length)) problem('职责楼栋范围无效');
    if (definition.specialtyRequired && specialties === null || specialties !== null && (!specialties.length || specialties.length !== specialtyValues.length)) problem('职责专业范围无效');
    const label = extractDisplayText(f.权限角色, '').trim(), role = Object.prototype.hasOwnProperty.call(roles, label) ? roles[label] : undefined;
    if (label && !role) problem('职责权限角色无效');
    const startsAt = timestamp(f.生效时间, 0), endsAt = timestamp(f.结束时间, null);
    if (startsAt === undefined || startsAt === null || endsAt === undefined || endsAt !== null && endsAt <= startsAt) { problem('职责任职时间无效'); continue; }
    const enabled = f.启用 === true;
    if (f.启用 !== undefined && f.启用 !== null && typeof f.启用 !== 'boolean') problem('职责启用状态无效');
    if (!Number.isSafeInteger(f.任职版本) || Number(f.任职版本) < 1) { problem('职责任职版本无效'); continue; }
    if (enabled && (!members.length || members.some(person => !person!.active))) problem('职责在任人员为空或已停用');
    if (definition.singleHolder && members.length !== 1 && enabled) problem('职责只允许一名在任人员');
    for (const person of members) if (!person!.dutyRecordIds.includes(recordId)) problem('职责双向关联不一致');
    duties.push({ recordId, name, kind: definition.id, personnelIds: members.map(person => person!.id), buildings, specialties, ...(role ? { role } : {}), enabled, startsAt, endsAt, parentDutyIds, version: Number(f.任职版本) });
  }
  const byId = new Map(duties.map(duty => [duty.recordId, duty]));
  for (const person of people) for (const id of person.dutyRecordIds) {
    currentRecordId = person.recordId;
    const duty = byId.get(id);
    if (!duty || !duty.personnelIds.includes(person.id)) problem('人员职责反向关联不一致');
  }
  for (const duty of duties) {
    currentRecordId = duty.recordId;
    if (duty.parentDutyIds.some(id => !byId.has(id))) problem('上级职责关联不存在');
    const pending = [...duty.parentDutyIds], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === duty.recordId) { problem('上级职责循环关联'); break; }
      if (seen.has(id)) continue;
      seen.add(id); pending.push(...(byId.get(id)?.parentDutyIds || []));
    }
  }
  const seats = new Map<string, AuthorityDuty[]>();
  for (const duty of duties) {
    if (!duty.enabled || !AUTHORITY_DUTY_CATALOG.find(item => item.id === duty.kind)!.singleHolder) continue;
    const buildings = duty.buildings || ['A楼','B楼','C楼','D楼','E楼','H楼','110站'];
    const specialties = duty.specialties || ['电气','暖通','弱电','消防','EHS','土建'];
    for (const building of buildings) for (const specialty of specialties) {
      const key = `${duty.kind}:${building}:${specialty}`, values = seats.get(key) || [];
      values.push(duty); seats.set(key, values);
    }
  }
  for (const values of seats.values()) {
    values.sort((a,b) => a.startsAt - b.startsAt); let latestEnd = -Infinity;
    for (const duty of values) {
      currentRecordId = duty.recordId;
      if (duty.startsAt < latestEnd) problem('职责任职范围重叠');
      latestEnd = Math.max(latestEnd, duty.endsAt ?? Infinity);
    }
  }
  if (binding) {
    const positions = buildPersonnelPositionDuties(people,binding);
    positions.problems.forEach(message => problems.add(message)); issues.push(...positions.issues);
    for (const duty of positions.duties) {
      const explicit = duties.filter(row => row.origin === undefined && row.kind === duty.kind && (row.buildings === null || duty.buildings === null || duty.buildings.some(building => row.buildings!.includes(building))) &&
        (row.specialties === null || duty.specialties === null || duty.specialties.some(specialty => row.specialties!.includes(specialty))));
      if (explicit.length) {
        const scope = (values: readonly string[] | null) => JSON.stringify(values && [...values].sort());
        if (explicit.some(row => scope(row.buildings) !== scope(duty.buildings) || scope(row.specialties) !== scope(duty.specialties) ||
          row.enabled && JSON.stringify([...row.personnelIds].sort()) !== JSON.stringify([...duty.personnelIds].sort()))) {
          currentRecordId = undefined; problem(`${duty.name}：主表岗位与额外职责人员冲突，请核对`);
        }
        continue;
      }
      duties.push(duty);
    }
  }
  return { duties, problems: [...problems], issues };
}

export function authorityDutyMatchesTarget(duty: AuthorityDuty, target: { building?: unknown; specialty?: unknown }, now = Date.now()): boolean {
  if (!Number.isFinite(now) || !duty.enabled || duty.startsAt > now || duty.endsAt !== null && duty.endsAt <= now) return false;
  const hasBuilding = target.building !== undefined && target.building !== null;
  const hasSpecialty = target.specialty !== undefined && target.specialty !== null;
  const buildings = normalizedBusinessBuildings(target.building), specialties = normalizeProfessionalScope(target.specialty);
  const specialtyParts = Array.isArray(target.specialty) ? target.specialty : typeof target.specialty === 'string' ? target.specialty.split(/[、,，;；/]/u) : [];
  if (hasBuilding && !buildings.length || hasSpecialty && (!specialties.length || specialties.length !== specialtyParts.length)) return false;
  return (duty.buildings === null || buildings.length > 0 && buildings.every(value => duty.buildings!.includes(value))) &&
    (duty.specialties === null || specialties.length > 0 && specialties.every(value => duty.specialties!.includes(value)));
}
