import { createHash } from 'node:crypto';
import { AUTHORITY_DUTY_CATALOG, type AuthorityDuty, type AuthorityDutyKind, type AuthorityPerson } from '../../../shared/personnel-authority.interface';
import { normalizeProfessionalScope } from '../../../shared/professional-access';
import { BUILDING_ADMIN_BUILDINGS } from '../../../shared/access-control.interface';

export interface PersonnelPositionBinding { appId: string; appToken: string; tableId: string }

export function buildPersonnelPositionDuties(people: readonly AuthorityPerson[], binding: PersonnelPositionBinding) {
  const duties = new Map<string, AuthorityDuty>(), problems = new Set<string>(), issues: { recordId?: string; message: string }[] = [];
  const problem = (person: AuthorityPerson, reason: string) => { const message = `${person.name}：${reason}`; problems.add(message); issues.push({ recordId: person.recordId, message }); };
  const identities = new Map<string, number>();
  for (const person of people) if (person.active && person.openId) identities.set(person.openId, (identities.get(person.openId) || 0) + 1);
  for (const person of people) {
    if (!person.active || person.type !== 'employee') continue;
    const labels = [person.position, person.systemPosition].flatMap(value => value.split(/[、,，;；]/u)).map(value => value.trim()).filter(Boolean);
    const buildingLead = labels.some(value => ['设施运维主管','运维主管','H楼值班主管','110站站长'].includes(value));
    const professionalLead = labels.filter(value => value === '专业主管' || /^(电气|供配电|暖通|弱电|消防|EHS|安全|土建)(专业)?主管$/iu.test(value));
    const engineers = labels.filter(value => /工程师/u.test(value) && !/主管|经理|总监|负责人/u.test(value) &&
      (value === '工程师' || /电气|供配电|暖通|弱电|消防|EHS|安全|土建/iu.test(value) || person.specialties.length > 0));
    const manager = labels.some(value => ['设施运维经理','设施运维副经理'].includes(value));
    const purchaseExecutor = labels.includes('综合管理');
    const warehouseManager = person.permissionTags.includes('库房管理员') || labels.includes('库房管理人');
    const explicitKinds = AUTHORITY_DUTY_CATALOG.filter(duty => labels.includes(duty.label) && !['professional_engineer','professional_supervisor','building_supervisor'].includes(duty.id));
    if (!buildingLead && !professionalLead.length && !engineers.length && !manager && !purchaseExecutor && !warehouseManager && !explicitKinds.length) continue;
    if (!person.openId || identities.get(person.openId) !== 1) { problem(person, '岗位人员的同应用稳定身份缺失或重复，请核对'); continue; }
    const add = (kind: AuthorityDutyKind, buildings: AuthorityDuty['buildings'], specialties: AuthorityDuty['specialties']) => {
      buildings = buildings && BUILDING_ADMIN_BUILDINGS.filter(value => buildings!.includes(value));
      specialties = specialties && normalizeProfessionalScope(specialties);
      const definition = AUTHORITY_DUTY_CATALOG.find(duty => duty.id === kind)!;
      if (definition.buildingRequired && !buildings?.length || definition.specialtyRequired && !specialties?.length) { problem(person, '岗位楼栋或专业尚未明确，请核对'); return; }
      const key = `position-${createHash('sha256').update(JSON.stringify([binding.appId,binding.appToken,binding.tableId,kind,buildings,specialties])).digest('hex')}`;
      let duty = duties.get(key);
      if (!duty) {
        duty = { recordId:key,origin:'personnel_position',name:[buildings?.join('、'),specialties?.join('、'),definition.label].filter(Boolean).join(' · '),kind,
          personnelIds:[],buildings,specialties,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1 };
        duties.set(key,duty);
      }
      if (!duty.personnelIds.includes(person.id)) duty.personnelIds.push(person.id);
    };
    if (buildingLead) {
      if (!person.buildings.length) problem(person, '楼栋主管的楼栋尚未明确，请核对');
      for (const building of person.buildings) { add('building_supervisor',[building],null); add('building_executor',[building],null); add('warehouse_approver',[building],null); }
    }
    if (professionalLead.length || engineers.length && !buildingLead && !manager) {
      const positionScopes = (professionalLead.includes('专业主管') ? labels : professionalLead.length ? professionalLead : engineers).map(label => normalizeProfessionalScope(label.match(/电气|供配电|暖通|弱电|消防|EHS|安全|土建/giu) || []));
      const scopes = positionScopes.filter(scope => scope.length), specialty = scopes[0] || person.specialties;
      if (!specialty.length || scopes.some(scope => JSON.stringify(scope) !== JSON.stringify(specialty)) || person.specialties.some(scope => !specialty.includes(scope))) problem(person, '岗位与专业不一致或专业未明确，请核对');
      else if (professionalLead.length) for (const value of specialty) add('professional_supervisor',null,[value]);
      else if (!person.buildings.length) problem(person, '工程师楼栋尚未明确，请核对');
      else for (const building of person.buildings) add('professional_engineer',[building],[...specialty]);
    }
    if (manager) { add('leave_manager',null,null); add('overtime_manager',null,null); }
    if (purchaseExecutor) add('purchase_executor',null,null);
    if (warehouseManager) {
      if (!person.buildings.length) problem(person, '库房管理知会的楼栋尚未明确，请核对');
      for (const building of person.buildings) add('warehouse_notify',[building],null);
    }
    for (const definition of explicitKinds) add(definition.id, definition.buildingRequired ? person.buildings.length ? [...person.buildings] : null : null,
      definition.specialtyRequired ? person.specialties.length ? [...person.specialties] : null : null);
  }
  for (const duty of duties.values()) {
    duty.personnelIds.sort();
    duty.version = parseInt(createHash('sha256').update(JSON.stringify(duty.personnelIds)).digest('hex').slice(0,8),16) + 1;
    if (AUTHORITY_DUTY_CATALOG.find(item => item.id === duty.kind)!.singleHolder && duty.personnelIds.length > 1) {
      const message = `${duty.name}：同范围存在多名在任人员，请核对岗位`;
      problems.add(message); issues.push({ message });
    }
  }
  return { duties:[...duties.values()].sort((a,b) => a.recordId.localeCompare(b.recordId)), problems:[...problems], issues };
}
