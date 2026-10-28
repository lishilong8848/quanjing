import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PAGE_ACCESS_ROLES, effectivePagePaths, effectiveAccountPagePaths, validPagePaths, type RolePageRules } from '../../../shared/page-access';
import { validBuildingScope, roleBuildingOptions } from '../../../shared/building-access';
import { BUILDING_ADMIN_BUILDINGS } from '../../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES, professionalScopeIsValid } from '../../../shared/professional-access';
import { BUSINESS_PERMISSION_CATALOG, BUSINESS_ACTION_LABELS, decideBusinessPermission, personalPermissionPagePaths, validPersonalRules, type PersonalPermissionRule } from '../../../shared/business-permissions';
import type { AccountPermissionTemplate, PermissionInheritancePreview, PendingDuty } from '../../../shared/personnel-handover.interface';
import { authorizationPages, validEffectiveAuthorization } from './authorization-profile.policy';
import { mergeHandoverAuthorization } from './personnel-handover.authorization';

function copyTemplate(value: AccountPermissionTemplate): AccountPermissionTemplate {
  if (!(PAGE_ACCESS_ROLES as readonly string[]).includes(value.role) || !validBuildingScope(value.role,value.building,value.buildings) ||
    !validPagePaths(value.pagePaths) || !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1 ||
    (['professional_admin','professional_engineer'].includes(value.role) ? !professionalScopeIsValid(value.specialties) : value.specialties !== undefined) ||
    (value.personalRules !== undefined && !validPersonalRules(value.personalRules)) ||
    (value.effectiveAuthorization !== undefined && (!validEffectiveAuthorization(value.effectiveAuthorization) || value.role !== (value.effectiveAuthorization.baseline.nativeRole || 'guest')))) throw new BadRequestException('岗位权限模板无效，请核对楼栋、专业和个人规则');
  return { role:value.role,building:value.building,sourceVersion:value.sourceVersion,pagePaths:[...value.pagePaths],
    ...(value.buildings ? { buildings:[...value.buildings] } : {}), ...(value.specialties ? { specialties:[...value.specialties] } : {}),
    ...(value.personalRules ? { personalRules:value.personalRules.map(rule => ({ id:rule.id,effect:rule.effect,module:rule.module,actions:[...rule.actions],buildings:rule.buildings ? [...rule.buildings] : null,specialties:rule.specialties ? [...rule.specialties] : null })) } : {}),
    ...(value.effectiveAuthorization ? {effectiveAuthorization:structuredClone(value.effectiveAuthorization)} : {}) };
}
function principal(template: AccountPermissionTemplate) { return { role:template.role,purchaseBuilding:template.building,buildings:template.buildings,specialties:template.specialties,personalRules:template.personalRules,effectiveAuthorization:template.effectiveAuthorization }; }
export function copyAccountPermissionTemplate(value: AccountPermissionTemplate): AccountPermissionTemplate { return copyTemplate(value); }
export function accountPermissionTemplate(account: ManagedAccount, pageRules?: RolePageRules): AccountPermissionTemplate {
  const actor = { role:account.role,purchaseBuilding:account.building,buildings:account.buildings,specialties:account.specialties,personalRules:account.personalRules,effectiveAuthorization:account.effectiveAuthorization };
  return copyTemplate({ role:account.role,building:account.building,buildings:account.buildings,specialties:account.specialties,personalRules:account.personalRules,sourceVersion:account.version,
    ...(account.effectiveAuthorization ? {effectiveAuthorization:structuredClone(account.effectiveAuthorization)} : {}),
    pagePaths: account.role === 'admin' ? effectivePagePaths(account.role,pageRules) : personalPermissionPagePaths(actor,account.effectiveAuthorization ? authorizationPages(account.effectiveAuthorization) : effectiveAccountPagePaths(account.role,pageRules,account.pagePaths)) });
}
function mergeRules(rules: readonly PersonalPermissionRule[]): PersonalPermissionRule[] {
  const unique = new Map<string,PersonalPermissionRule>(), ids = new Set<string>();
  for (const rule of rules) {
    const semantic = JSON.stringify([rule.effect,rule.module,[...rule.actions].sort(),rule.buildings && [...rule.buildings].sort(),rule.specialties && [...rule.specialties].sort()]);
    if (!unique.has(semantic)) {
      const id = ids.has(rule.id) ? `handover-${createHash('sha256').update(semantic).digest('hex').slice(0,48)}` : rule.id;
      ids.add(id); unique.set(semantic,{ ...rule,id,actions:[...rule.actions],buildings:rule.buildings ? [...rule.buildings] : null,specialties:rule.specialties ? [...rule.specialties] : null });
    }
  }
  return [...unique.values()];
}
function roleIsPreciselyEvaluated(template: AccountPermissionTemplate): boolean { return !!template.effectiveAuthorization || ['admin','professional_admin','professional_engineer'].includes(template.role); }
function permissionLosses(from: AccountPermissionTemplate, after: AccountPermissionTemplate, defaults: boolean): string[] {
  const problems = new Set<string>();
  for (const definition of BUSINESS_PERMISSION_CATALOG) for (const action of definition.actions) {
    const explicitlyAllowed = from.personalRules?.some(rule => rule.effect === 'allow' && rule.module === definition.id && rule.actions.includes(action)) || false;
    if (!(defaults && roleIsPreciselyEvaluated(from)) && !explicitlyAllowed) continue;
    const targets = definition.scoped ? BUILDING_ADMIN_BUILDINGS.flatMap(building => PROFESSIONAL_SPECIALTIES.map(specialty => ({ building,specialty }))) : [{}];
    if (targets.some(target => decideBusinessPermission(principal(from),{ module:definition.id,action,...target }).allowed && !decideBusinessPermission(principal(after),{ module:definition.id,action,...target }).allowed)) problems.add(`${definition.label} · ${BUSINESS_ACTION_LABELS[action]}`);
  }
  return [...problems];
}
export function previewPermissionInheritance(sourceInput: AccountPermissionTemplate, targetInput: AccountPermissionTemplate, options: { replacePersonnelDefault?: boolean } = {}): PermissionInheritancePreview {
  const source = copyTemplate(sourceInput), before = copyTemplate(targetInput);
  let after = copyTemplate(before);
  const conflicts: string[] = [], warnings: string[] = [];
  if (options.replacePersonnelDefault !== undefined && typeof options.replacePersonnelDefault !== 'boolean') throw new BadRequestException('岗位授权替换条件无效');
  const replace = options.replacePersonnelDefault === true;
  if(source.effectiveAuthorization || before.effectiveAuthorization) {
    try {
      after=mergeHandoverAuthorization(source,before,replace);
      after.pagePaths=personalPermissionPagePaths(principal(after),after.pagePaths);
      const sourceLosses=permissionLosses(source,after,true),ownLosses=replace ? [] : permissionLosses(before,after,true);
      if(sourceLosses.length) conflicts.push(`前任权限无法完整继承：${sourceLosses.join('、')}`);
      if(ownLosses.length) conflicts.push(`继承会缩减接任者现有权限：${ownLosses.join('、')}`);
      if(source.pagePaths.some(path=>!after.pagePaths.includes(path))) conflicts.push('前任页面读取权限无法完整继承');
    } catch(error) { conflicts.push(error instanceof Error ? error.message : '交接权限无法安全合并'); }
    if(conflicts.length) after=copyTemplate(before);
    return {source,before,after:copyTemplate(after),conflicts,warnings,addedPages:after.pagePaths.filter(path=>!before.pagePaths.includes(path)),removedPages:before.pagePaths.filter(path=>!after.pagePaths.includes(path))};
  }
  const ownRules = before.personalRules || [], inheritedRules = source.personalRules || [];
  if (before.role === 'admin') warnings.push('保留接任者现有管理员权限');
  else if (replace || ['guest','site_member'].includes(before.role)) after = { ...copyTemplate(source),sourceVersion:before.sourceVersion };
  else if (['guest','site_member'].includes(source.role)) { /* Only explicitly selected rules and pages are added to the existing role. */ }
  else if (source.role !== before.role) conflicts.push('不同角色的现有任职不能安全合并，请先明确保留的岗位授权');
  else if (source.role === 'professional_engineer') {
    const additions: PersonalPermissionRule[] = BUSINESS_PERMISSION_CATALOG.filter(definition => definition.scoped).map(definition => ({ id:`inherited-${definition.id}`,effect:'allow',module:definition.id,actions:[...definition.actions],buildings:source.buildings || [source.building!],specialties:source.specialties! }));
    after.personalRules = mergeRules([...ownRules,...additions,...inheritedRules]);
  } else {
    if (roleBuildingOptions(source.role)) {
      const buildings = new Set([...(before.buildings || [before.building!]),...(source.buildings || [source.building!])]);
      after.buildings = [before.building!,...BUILDING_ADMIN_BUILDINGS.filter(building => building !== before.building && buildings.has(building))];
    }
    if (source.role === 'professional_admin') after.specialties = [...PROFESSIONAL_SPECIALTIES.filter(value => before.specialties!.includes(value) || source.specialties!.includes(value))];
  }
  if (!conflicts.length) {
    const rules = after.role === 'professional_engineer' && !replace && before.role === source.role ? after.personalRules! : mergeRules([...ownRules,...inheritedRules]);
    if (rules.length > 100) conflicts.push('继承后的个人规则超过100条，请先合并重复授权');
    else {
      if (rules.length) after.personalRules = rules; else delete after.personalRules;
      const inheritedPages = replace ? source.pagePaths : [...new Set([...source.pagePaths,...before.pagePaths])];
      after.pagePaths = after.role === 'admin' ? effectivePagePaths('admin') : personalPermissionPagePaths(principal(after),inheritedPages);
      const sourceLosses = permissionLosses(source,after,true);
      const ownLosses = permissionLosses(before,after,!replace);
      if (sourceLosses.length) conflicts.push(`前任权限无法完整继承：${sourceLosses.join('、')}`);
      if (ownLosses.length) conflicts.push(`继承会缩减接任者现有权限：${ownLosses.join('、')}`);
      if (source.pagePaths.some(path => !after.pagePaths.includes(path))) conflicts.push('前任页面读取权限无法完整继承');
    }
  }
  if (conflicts.length) after = copyTemplate(before);
  return { source,before,after:copyTemplate(after),conflicts,warnings,
    addedPages:after.pagePaths.filter(path => !before.pagePaths.includes(path)),removedPages:before.pagePaths.filter(path => !after.pagePaths.includes(path)) };
}
export function pendingHandoverSelection(items: readonly PendingDuty[]): { pending: PendingDuty[]; excluded: { key: string; reason: string }[]; conflicts: string[] } {
  const pending: PendingDuty[] = [], excluded: { key: string; reason: string }[] = [], conflicts = new Set<string>(), keys = new Set<string>();
  if (!Array.isArray(items) || items.length > 10_000) throw new BadRequestException('交接待办清单无效');
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 512) throw new BadRequestException('交接待办身份无效');
    if (keys.has(item.key)) { conflicts.add('待办身份重复'); continue; }
    keys.add(item.key);
    if (typeof item.version !== 'string' || !item.version) { conflicts.add('待办版本缺失'); continue; }
    if (item.status === 'terminal') { excluded.push({ key:item.key,reason:'已办结历史保持' }); continue; }
    if (item.phase === 'reconcile') { conflicts.add(`${item.key}：外部执行结果尚未确认，需先对账`); continue; }
    if (item.status === 'in_progress') { excluded.push({ key:item.key,reason:'已受理处理保持原执行' }); continue; }
    if (item.status !== 'pending' || !['purchase','inventory','contracts','leave','overtime'].includes(item.module) || !['approval','execution','notification'].includes(item.phase)) throw new BadRequestException('交接待办阶段无效');
    if (!Array.isArray(item.recipients) || item.recipients.length > 100 || !item.recipients.every(person => person && typeof person.name === 'string' && typeof person.openId === 'string' && /^ou_[A-Za-z0-9_-]{1,124}$/.test(person.openId)) ||
      ![item.recordId,item.title,item.dutyRecordId,item.stageKey].every(value => typeof value === 'string' && value.length > 0 && value.length <= 500)) throw new BadRequestException('交接待办字段无效');
    pending.push({ key:item.key,module:item.module,recordId:item.recordId,title:item.title,dutyRecordId:item.dutyRecordId,phase:item.phase,status:item.status,stageKey:item.stageKey,version:item.version,
      recipients:item.recipients.map(person => ({ name:person.name,openId:person.openId })) });
  }
  return { pending,excluded,conflicts:[...conflicts] };
}
