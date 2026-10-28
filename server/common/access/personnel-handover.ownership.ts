import type { AccountPermissionTemplate, HandoverGrantChoice, HandoverPermissionOwnership } from '../../../shared/personnel-handover.interface';
import { isAuthorityDutyKey } from '../../../shared/personnel-authority.interface';
export type { HandoverGrantChoice } from '../../../shared/personnel-handover.interface';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { BUSINESS_PERMISSION_CATALOG, canPerformBusinessAction, personalPermissionPagePaths } from '../../../shared/business-permissions';
import { effectivePagePaths } from '../../../shared/page-access';
import { BUILDING_ADMIN_BUILDINGS } from '../../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';
import { roleBuildingOptions } from '../../../shared/building-access';
import { copyAccountPermissionTemplate } from './personnel-handover.preview';
import type { AuthorizationGrantSnapshot, EffectiveAuthorization } from '../../../shared/authorization-profile';
import { authorizationPages } from './authorization-profile.policy';
import { authorizationGrantSignature, frozenHandoverAuthorization, uniqueAuthorizationGrants } from './personnel-handover.authorization';
export function normalizeHandoverPermissionOwnership(value: unknown, dutyRecordIds: readonly string[]): HandoverPermissionOwnership[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new BadRequestException('权限归属清单无效');
  const seen = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'grants,sourceAccountId' || typeof row.sourceAccountId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(row.sourceAccountId) || seen.has(row.sourceAccountId) || !Array.isArray(row.grants) || !row.grants.length || row.grants.length > 300) throw new BadRequestException('权限归属账号无效');
    seen.add(row.sourceAccountId); const keys = new Set<string>();
    const grants: HandoverGrantChoice[] = row.grants.map((grant: unknown) => {
      if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new BadRequestException('权限归属条目无效');
      const item = grant as HandoverGrantChoice;
      if (Object.keys(item).some(key => !['key', 'disposition', 'dutyRecordId'].includes(key)) || typeof item.key !== 'string' || !item.key || item.key.length > 512 || keys.has(item.key) ||
        !['transfer', 'retain', 'shared'].includes(item.disposition) || (item.disposition === 'retain' ? item.dutyRecordId !== undefined : !dutyRecordIds.includes(item.dutyRecordId!))) throw new BadRequestException('权限归属条目或职责无效');
      keys.add(item.key); return { key: item.key, disposition: item.disposition, ...(item.dutyRecordId ? { dutyRecordId: item.dutyRecordId } : {}) };
    });
    return { sourceAccountId: row.sourceAccountId, grants: grants.sort((a, b) => a.key.localeCompare(b.key)) };
  }).sort((a, b) => a.sourceAccountId.localeCompare(b.sourceAccountId));
}
export function handoverPermissionGrantKeys(source: AccountPermissionTemplate, rolePages: readonly string[] = effectivePagePaths(source.role), basePages: readonly string[] = effectivePagePaths('site_member')): string[] {
  const valid = copyAccountPermissionTemplate(source);
  if (valid.effectiveAuthorization) return profileGrantKeys(valid.effectiveAuthorization);
  const automatic = new Set([...basePages,...personalPermissionPagePaths({role:valid.role,purchaseBuilding:valid.building,buildings:valid.buildings,specialties:valid.specialties,personalRules:valid.personalRules},rolePages)]);
  return ['role', ...(valid.personalRules || []).filter(rule => rule.effect === 'allow').map(rule => `rule:${rule.id}`), ...[...valid.pagePaths].filter(path=>!automatic.has(path)).sort().map(path => `page:${path}`)];
}
export function handoverPermissionGrantMetadata(source: AccountPermissionTemplate): Record<string, {
  title: string; nativeRole: AuthorizationGrantSnapshot['baseline']['nativeRole']; scope: AuthorizationGrantSnapshot['scope'];
}> {
  const valid = copyAccountPermissionTemplate(source);
  if (!valid.effectiveAuthorization) return {};
  return Object.fromEntries(profileSnapshots(valid.effectiveAuthorization).map((snapshot, index) => [
    `v2:grant:${authorizationGrantSignature(snapshot)}`,
    { title: `交接保留权限 #${index + 1}（完整来源范围）`, nativeRole: snapshot.baseline.nativeRole, scope: structuredClone(snapshot.scope) },
  ]));
}
export function splitHandoverPermissionGrants(source: AccountPermissionTemplate, choices: readonly HandoverGrantChoice[], dutyRecordIds: readonly string[], basePages: readonly string[] = effectivePagePaths('site_member'), rolePages: readonly string[] = effectivePagePaths(source.role)): { transfer: AccountPermissionTemplate; retained: AccountPermissionTemplate } {
  const before = copyAccountPermissionTemplate(source), expected = handoverPermissionGrantKeys(before,rolePages,basePages);
  if (!Array.isArray(choices) || choices.length !== expected.length || choices.length > 300 || new Set(choices.map(row => row?.key)).size !== choices.length ||
    !Array.isArray(dutyRecordIds) || !dutyRecordIds.length || new Set(dutyRecordIds).size !== dutyRecordIds.length || dutyRecordIds.some(id => !isAuthorityDutyKey(id))) throw new BadRequestException('请完整确认个人权限归属');
  const byKey = new Map<string, HandoverGrantChoice>();
  for (const row of choices) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['key', 'disposition', 'dutyRecordId'].includes(key)) || !expected.includes(row.key) ||
      !['transfer', 'retain', 'shared'].includes(row.disposition) || (row.disposition === 'retain' ? row.dutyRecordId !== undefined : !dutyRecordIds.includes(row.dutyRecordId!))) throw new BadRequestException('权限归属或交接职责无效');
    byKey.set(row.key, { ...row });
  }
  const includes = (key: string, side: 'transfer' | 'retained') => {
    const decision = byKey.get(key)!.disposition;
    return decision === 'shared' || decision === (side === 'transfer' ? 'transfer' : 'retain');
  };
  if (before.effectiveAuthorization) {
    const transfer = projectProfile(before, key => includes(key, 'transfer'));
    const retained = projectProfile(before, key => includes(key, 'retained'));
    assertNoExpandedPermissions(before, [transfer, retained]);
    return { transfer, retained };
  }
  const project = (side: 'transfer' | 'retained'): AccountPermissionTemplate => {
    const roleRetained = includes('role', side);
    const rules = (before.personalRules || []).filter(rule => rule.effect === 'deny' || includes(`rule:${rule.id}`, side));
    const result: AccountPermissionTemplate = { ...(roleRetained ? before : { role: 'site_member' as const, building: null, sourceVersion: before.sourceVersion }),
      pagePaths: [...new Set([...(roleRetained?rolePages:basePages), ...before.pagePaths.filter(path => byKey.has(`page:${path}`)&&includes(`page:${path}`, side))])],
      ...(rules.length ? { personalRules: structuredClone(rules) } : {}) };
    if (!rules.length) delete result.personalRules;
    if (!roleRetained) restrictUnexpectedLegacyBaseActions(before, result);
    result.pagePaths=personalPermissionPagePaths({role:result.role,purchaseBuilding:result.building,buildings:result.buildings,specialties:result.specialties,personalRules:result.personalRules},result.pagePaths);
    return copyAccountPermissionTemplate(result);
  };
  const transfer = project('transfer'), retained = project('retained');
  assertNoExpandedPermissions(before, [transfer, retained]);
  return { transfer, retained };
}

function restrictUnexpectedLegacyBaseActions(before: AccountPermissionTemplate, candidate: AccountPermissionTemplate): void {
  // V1 used site_member as the post-transfer login identity. Its growing
  // default action set is not a grant from the relinquished role. Preserve
  // only its intersection with the source; explicit selected rules stay intact.
  const rules = [...(candidate.personalRules || [])], ids = new Set(rules.map(rule => rule.id));
  for (const definition of BUSINESS_PERMISSION_CATALOG) {
    if (definition.scoped) continue;
    const actions = [...definition.actions].filter(action =>
      canPerformBusinessAction(templatePrincipal(candidate), { module: definition.id, action }) &&
      !canPerformBusinessAction(templatePrincipal(before), { module: definition.id, action }));
    if (!actions.length) continue;
    const prefix = `handover-base-${definition.id}`;
    let id = prefix, suffix = 2;
    while (ids.has(id)) id = `${prefix}-${suffix++}`;
    ids.add(id);
    rules.push({ id, effect: 'deny', module: definition.id, actions, buildings: null, specialties: null });
  }
  if (rules.length > 100) throw new ConflictException('权限拆分所需限制超过100条，请先整合规则，原授权保持不变');
  if (rules.length) candidate.personalRules = rules;
}

function profileSnapshots(effective: EffectiveAuthorization): AuthorizationGrantSnapshot[] {
  return uniqueAuthorizationGrants(effective.baseline.grantSnapshots || []);
}

function profileGrantKeys(effective: EffectiveAuthorization): string[] {
  const keys = [
    'v2:role',
    ...effective.baseline.rules.filter(rule => rule.effect === 'allow').map(rule => `v2:base-rule:${rule.id}`),
    ...effective.baseline.pages.map(page => `v2:base-page:${page}`),
    ...profileSnapshots(effective).map(grant => `v2:grant:${authorizationGrantSignature(grant)}`),
    ...effective.overrides.rules.filter(rule => rule.effect === 'allow').map(rule => `v2:personal-rule:${rule.id}`),
    ...effective.overrides.allowPages.map(page => `v2:personal-page:${page}`),
  ];
  if (keys.length > 300 || new Set(keys).size !== keys.length) throw new BadRequestException('权限归属条目过多或重复，请先核对整合');
  return keys;
}

function templatePrincipal(value: AccountPermissionTemplate) {
  return { role: value.role, purchaseBuilding: value.building, buildings: value.buildings, specialties: value.specialties,
    personalRules: value.personalRules, effectiveAuthorization: value.effectiveAuthorization };
}

function projectedBaselineRules(before: AccountPermissionTemplate, effective: EffectiveAuthorization, keepNativeRole: boolean, includes: (key: string) => boolean) {
  const sourceRole = effective.baseline.nativeRole;
  return effective.baseline.rules.flatMap(rule => {
    if (rule.effect === 'deny') return [rule];
    if (!includes(`v2:base-rule:${rule.id}`)) return [];
    if (keepNativeRole || sourceRole === null || !BUSINESS_PERMISSION_CATALOG.find(definition => definition.id === rule.module)?.scoped) return [rule];
    // Removing a scoped native role must not uncap its template's global
    // allow rules. Personal overrides intentionally keep their own scope.
    const allowedBuildings = roleBuildingOptions(sourceRole) ? before.buildings || [before.building!] : null;
    const allowedSpecialties = ['professional_admin','professional_engineer'].includes(sourceRole) ? before.specialties! : null;
    const buildings = allowedBuildings ? rule.buildings === null ? [...allowedBuildings] : rule.buildings.filter(value => allowedBuildings.includes(value)) : rule.buildings;
    const specialties = allowedSpecialties ? rule.specialties === null ? [...allowedSpecialties] : rule.specialties.filter(value => allowedSpecialties.includes(value)) : rule.specialties;
    if (buildings?.length === 0 || specialties?.length === 0) return [];
    return [{ ...rule, buildings, specialties }];
  });
}

function projectProfile(before: AccountPermissionTemplate, includes: (key: string) => boolean): AccountPermissionTemplate {
  const effective = frozenHandoverAuthorization(before);
  const nativeRole = includes('v2:role') ? effective.baseline.nativeRole : null;
  const grants = profileSnapshots(effective).filter(grant => includes(`v2:grant:${authorizationGrantSignature(grant)}`));
  const projected: EffectiveAuthorization = {
    mode: 'independent',
    baseline: {
      nativeRole,
      pages: effective.baseline.pages.filter(page => includes(`v2:base-page:${page}`)),
      // Restrictions stay in their original layer and scope on both sides.
      rules: projectedBaselineRules(before, effective, nativeRole !== null, includes),
      ...(grants.length ? { grantSnapshots: grants } : {}),
    },
    overrides: {
      rules: effective.overrides.rules.filter(rule => rule.effect === 'deny' || includes(`v2:personal-rule:${rule.id}`)),
      allowPages: effective.overrides.allowPages.filter(page => includes(`v2:personal-page:${page}`)),
      denyPages: [...effective.overrides.denyPages],
    },
  };
  const result: AccountPermissionTemplate = {
    role: nativeRole || 'guest',
    building: nativeRole ? before.building : null,
    ...(nativeRole && before.buildings ? { buildings: [...before.buildings] } : {}),
    ...(nativeRole && before.specialties ? { specialties: [...before.specialties] } : {}),
    sourceVersion: before.sourceVersion,
    personalRules: structuredClone(projected.overrides.rules),
    effectiveAuthorization: projected,
    pagePaths: [],
  };
  result.pagePaths = personalPermissionPagePaths(templatePrincipal(result), authorizationPages(projected));
  if (result.pagePaths.some(page => !before.pagePaths.includes(page))) throw new ConflictException('权限拆分不能增加原授权之外的页面');
  const selectedPages = [...projected.baseline.pages, ...projected.overrides.allowPages].filter(page => before.pagePaths.includes(page));
  if (selectedPages.some(page => !result.pagePaths.includes(page))) {
    throw new ConflictException('所选页面仍依赖该基础角色的数据读取范围，请将角色共享或同时交接相关读取授权');
  }
  return copyAccountPermissionTemplate(result);
}

function assertNoExpandedPermissions(before: AccountPermissionTemplate, candidates: AccountPermissionTemplate[]): void {
  for (const candidate of candidates) {
    for (const definition of BUSINESS_PERMISSION_CATALOG) for (const action of definition.actions) {
      const targets = definition.scoped ? BUILDING_ADMIN_BUILDINGS.flatMap(building => PROFESSIONAL_SPECIALTIES.map(specialty => ({ building, specialty }))) : [{}];
      if (targets.some(target => canPerformBusinessAction(templatePrincipal(candidate), { module: definition.id, action, ...target }) && !canPerformBusinessAction(templatePrincipal(before), { module: definition.id, action, ...target }))) throw new ConflictException('权限拆分不能扩大原授权，请保留对应限制');
    }
  }
}
