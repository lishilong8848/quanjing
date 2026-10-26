import { ServiceUnavailableException } from '@nestjs/common';
import type { AuthorityDutyKind } from '../../../shared/personnel-authority.interface';
import type { CardRoleCode, ConfigurationPerson } from '../../../shared/access-configuration.interface';
import { getAccessConfigurationStore, type ConfigurationState } from './access-configuration.store';
import { CARD_PERSONNEL_DUTIES, resolvePersonnelDutyMembers } from './personnel-duty-routing';
import { ruleKey } from './access-configuration.validation';
import { filterActivePersonnelDutyMembers, type DutyEligibilityState } from './personnel-duty-eligibility';
export { filterActivePersonnelDutyMembers } from './personnel-duty-eligibility';
import { resolvePersonnelSourceMembers } from './personnel-source.policy';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import { AUTHORITY_DUTY_CATALOG } from '../../../shared/personnel-authority.interface';

/** A null result means this role has never been managed here; callers retain their existing source. */
export function readCurrentPersonnelDutyMembers(kind: AuthorityDutyKind, target: { building?: unknown; specialty?: unknown }): ConfigurationPerson[] | null {
  const state = getAccessConfigurationStore().read(), appId = process.env.FEISHU_APP_ID?.trim() || '';
  return resolveCurrentPersonnelDutyMembers(state,appId,kind,target);
}

export function resolveCurrentPersonnelDutyMembers(state:Pick<ConfigurationState,'personnelDutyAssignments'|'cardRules'|'personnelSource'> & DutyEligibilityState, appId:string, kind:AuthorityDutyKind, target:{building?:unknown;specialty?:unknown}):ConfigurationPerson[]|null {
  const source = resolvePersonnelSourceMembers(state.personnelSource, appId, kind, target);
  if (source !== null) return filterActivePersonnelDutyMembers(state, appId, source);
  const current = resolvePersonnelDutyMembers(state.personnelDutyAssignments, appId, kind, target);
  if (current !== null) return filterActivePersonnelDutyMembers(state, appId, current);
  const code = (Object.entries(CARD_PERSONNEL_DUTIES) as [CardRoleCode, AuthorityDutyKind][]).find(([, value]) => value === kind)?.[0];
  if (!code) return null;
  const building = ['building_executor', 'warehouse_responsible', 'warehouse_notify'].includes(code) ? target.building : null;
  if (building !== null && typeof building !== 'string') return null;
  const rule = state.cardRules[ruleKey(code, building as string | null)];
  if (rule && rule.appId !== appId) throw new ServiceUnavailableException('卡片人员配置属于其他飞书应用，已拒绝路由');
  return rule ? filterActivePersonnelDutyMembers(state, appId, structuredClone(rule.members)) : null;
}

export function resolveCurrentPersonnelDutyRoutePeople(state: Pick<ConfigurationState,'personnelDutyAssignments'|'cardRules'|'personnelSource'> & DutyEligibilityState, appId: string, kind: AuthorityDutyKind, target: { building?: unknown; specialty?: unknown }) {
  const source = resolvePersonnelSourceMembers(state.personnelSource, appId, kind, target);
  if (source === null) {
    const members = resolvePersonnelDutyMembers(state.personnelDutyAssignments, appId, kind, target);
    if (members === null) return null;
    return filterActivePersonnelDutyMembers(state, appId, members).map(member => {
      const identity = Object.values(state.personnelDutyAssignments || {}).flatMap(rule => rule.members).find(person => person.openId === member.openId)!;
      return { ...member, personRecordId: identity.recordId, position: AUTHORITY_DUTY_CATALOG.find(duty => duty.id === kind)!.label, buildings: normalizedBusinessBuildings(target.building) };
    });
  }
  return filterActivePersonnelDutyMembers(state, appId, source).map(member => {
    const identity = Object.values(state.personnelSource!.routes).flatMap(rule => rule.members).find(person => person.openId === member.openId)!;
    return { ...member, personRecordId: identity.recordId, position: AUTHORITY_DUTY_CATALOG.find(duty => duty.id === kind)!.label, buildings: normalizedBusinessBuildings(target.building) };
  });
}
