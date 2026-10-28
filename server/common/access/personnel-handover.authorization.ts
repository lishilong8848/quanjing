import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccountPermissionTemplate } from '../../../shared/personnel-handover.interface';
import type { AuthorizationGrantSnapshot, AuthorizationOverrides, EffectiveAuthorization } from '../../../shared/authorization-profile';
import { authorizationPages, validAuthorizationGrantSnapshot, validEffectiveAuthorization } from './authorization-profile.policy';
import { effectivePagePaths } from '../../../shared/page-access';

export function frozenHandoverAuthorization(template: AccountPermissionTemplate): EffectiveAuthorization {
  if(template.effectiveAuthorization) return {mode:'independent',baseline:structuredClone(template.effectiveAuthorization.baseline),overrides:structuredClone(template.effectiveAuthorization.overrides)};
  // A legacy page inferred from a scoped personal rule is an entry point,
  // not an unscoped baseline grant. Keep its original rule as the authority.
  const rolePages = new Set(effectivePagePaths(template.role));
  return {mode:'independent',baseline:{nativeRole:template.role,pages:template.pagePaths.filter(page=>rolePages.has(page)),rules:[]},overrides:{rules:structuredClone(template.personalRules || []),allowPages:[],denyPages:[]}};
}
function emptyOverrides(value: AuthorizationOverrides): boolean { return !value.rules.length && !value.allowPages.length && !value.denyPages.length; }
export function authorizationGrantSignature(value: AuthorizationGrantSnapshot): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function uniqueAuthorizationGrants(values: AuthorizationGrantSnapshot[]): AuthorizationGrantSnapshot[] {
  const unique=new Map<string,AuthorizationGrantSnapshot>();
  for(const value of values) {
    if(!validAuthorizationGrantSnapshot(value)) throw new ConflictException('交接授权快照无效，不能扩大原权限');
    const snapshot=structuredClone(value);
    const layers:AuthorizationOverrides[]=[];
    let previous=snapshot.overrides;
    for(const layer of snapshot.overrideLayers || []) if(!emptyOverrides(layer) && JSON.stringify(layer)!==JSON.stringify(previous)) {layers.push(layer);previous=layer;}
    if(layers.length) snapshot.overrideLayers=layers; else delete snapshot.overrideLayers;
    unique.set(authorizationGrantSignature(snapshot),snapshot);
  }
  if(unique.size>8) throw new ConflictException('交接保留的独立权限快照超过8份，请先核对整合，未保存');
  return [...unique.values()];
}
export function handoverAuthorizationGrants(template: AccountPermissionTemplate): AuthorizationGrantSnapshot[] {
  const effective=frozenHandoverAuthorization(template),{grantSnapshots:existing,...base}=effective.baseline;
  if(base.nativeRole==='admin') throw new ConflictException('管理员身份不能通过岗位交接授予');
  const own:AuthorizationGrantSnapshot={baseline:structuredClone(base),overrides:structuredClone(effective.overrides),
    scope:{building:template.building,...(template.buildings?{buildings:[...template.buildings]}:{}),...(template.specialties?{specialties:[...template.specialties]}:{})}};
  const inherited=(existing || []).map(value=>{
    const next=structuredClone(value);
    const previous=next.overrideLayers?.at(-1) || next.overrides;
    if(!emptyOverrides(effective.overrides) && JSON.stringify(previous)!==JSON.stringify(effective.overrides)) next.overrideLayers=[...next.overrideLayers || [],structuredClone(effective.overrides)];
    if((next.overrideLayers?.length || 0)>8) throw new ConflictException('交接个人例外叠加超过8层，请先核对整合，未保存');
    return next;
  });
  const ownHasGrant=base.nativeRole!==null || base.pages.length>0 || base.rules.some(rule=>rule.effect==='allow') || effective.overrides.rules.some(rule=>rule.effect==='allow') || effective.overrides.allowPages.length>0;
  return uniqueAuthorizationGrants([...(ownHasGrant?[own]:[]),...inherited]);
}
export function mergeHandoverAuthorization(source: AccountPermissionTemplate, before: AccountPermissionTemplate, replace: boolean): AccountPermissionTemplate {
  const sourceEffective=frozenHandoverAuthorization(source),receiver=frozenHandoverAuthorization(before);
  if(before.role==='admin') return structuredClone(before);
  if(sourceEffective.baseline.nativeRole==='admin') throw new ConflictException('管理员身份不能通过岗位交接授予');
  const emptyReceiver=receiver.baseline.nativeRole !== null && ['guest','site_member'].includes(receiver.baseline.nativeRole) &&
    receiver.baseline.pages.every(page=>effectivePagePaths(before.role).includes(page)) && !receiver.baseline.rules.length && !receiver.baseline.grantSnapshots?.length && emptyOverrides(receiver.overrides);
  if(replace || emptyReceiver) return {...structuredClone(source),sourceVersion:before.sourceVersion,effectiveAuthorization:sourceEffective};
  if(!['guest','site_member'].includes(source.role) && !['guest','site_member'].includes(before.role) && source.role!==before.role)
    throw new ConflictException('不同角色的现有任职不能安全合并，请先明确保留的岗位授权');
  const grants=uniqueAuthorizationGrants([...(receiver.baseline.grantSnapshots || []),...handoverAuthorizationGrants(source)]);
  const effective:EffectiveAuthorization={mode:'independent',baseline:{...receiver.baseline,...(grants.length?{grantSnapshots:grants}:{})},overrides:receiver.overrides};
  if(!validEffectiveAuthorization(effective)) throw new ConflictException('交接权限快照无法安全表达');
  return {...structuredClone(before),effectiveAuthorization:effective,personalRules:structuredClone(effective.overrides.rules),pagePaths:authorizationPages(effective)};
}
