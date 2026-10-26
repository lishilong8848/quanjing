import type { AccountPermissionTemplate, HandoverGrantChoice, HandoverPermissionOwnership } from '../../../shared/personnel-handover.interface';
import { isAuthorityDutyKey } from '../../../shared/personnel-authority.interface';
export type { HandoverGrantChoice } from '../../../shared/personnel-handover.interface';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { BUSINESS_PERMISSION_CATALOG, canPerformBusinessAction, personalPermissionPagePaths } from '../../../shared/business-permissions';
import { effectivePagePaths } from '../../../shared/page-access';
import { BUILDING_ADMIN_BUILDINGS } from '../../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';
import { copyAccountPermissionTemplate } from './personnel-handover.preview';
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
  const automatic = new Set([...basePages,...personalPermissionPagePaths({role:valid.role,purchaseBuilding:valid.building,buildings:valid.buildings,specialties:valid.specialties,personalRules:valid.personalRules},rolePages)]);
  return ['role', ...(valid.personalRules || []).filter(rule => rule.effect === 'allow').map(rule => `rule:${rule.id}`), ...[...valid.pagePaths].filter(path=>!automatic.has(path)).sort().map(path => `page:${path}`)];
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
  const project = (side: 'transfer' | 'retained'): AccountPermissionTemplate => {
    const roleRetained = includes('role', side);
    const rules = (before.personalRules || []).filter(rule => rule.effect === 'deny' || includes(`rule:${rule.id}`, side));
    const result: AccountPermissionTemplate = { ...(roleRetained ? before : { role: 'site_member' as const, building: null, sourceVersion: before.sourceVersion }),
      pagePaths: [...new Set([...(roleRetained?rolePages:basePages), ...before.pagePaths.filter(path => byKey.has(`page:${path}`)&&includes(`page:${path}`, side))])],
      ...(rules.length ? { personalRules: structuredClone(rules) } : {}) };
    if (!rules.length) delete result.personalRules;
    result.pagePaths=personalPermissionPagePaths({role:result.role,purchaseBuilding:result.building,buildings:result.buildings,specialties:result.specialties,personalRules:result.personalRules},result.pagePaths);
    return copyAccountPermissionTemplate(result);
  };
  const transfer = project('transfer'), retained = project('retained');
  for (const candidate of [transfer, retained]) {
    const principal = (value: AccountPermissionTemplate) => ({ role: value.role, purchaseBuilding: value.building, buildings: value.buildings, specialties: value.specialties, personalRules: value.personalRules });
    for (const definition of BUSINESS_PERMISSION_CATALOG) for (const action of definition.actions) {
      const targets = definition.scoped ? BUILDING_ADMIN_BUILDINGS.flatMap(building => PROFESSIONAL_SPECIALTIES.map(specialty => ({ building, specialty }))) : [{}];
      if (targets.some(target => canPerformBusinessAction(principal(candidate), { module: definition.id, action, ...target }) && !canPerformBusinessAction(principal(before), { module: definition.id, action, ...target }))) throw new ConflictException('权限拆分不能扩大原授权，请保留对应限制');
    }
  }
  return { transfer, retained };
}
