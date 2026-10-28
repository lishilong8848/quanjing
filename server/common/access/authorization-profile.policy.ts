import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import type { AuthorizationBinding, AuthorizationOverrides, AuthorizationPolicy, AuthorizationTemplate, EffectiveAuthorization, AuthorizationGrantSnapshot } from '../../../shared/authorization-profile';
import { validPersonalRules } from '../../../shared/business-permissions';
import { PAGE_ACCESS_ROLES, effectivePagePaths, validPagePaths, type RolePageRules } from '../../../shared/page-access';
import type { AccessRole } from '../../../shared/access-control.interface';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '../../../shared/site-member-backup';
import { validBuildingScope } from '../../../shared/building-access';
import { professionalScopeIsValid } from '../../../shared/professional-access';
import { legacyAuthorizationOverrides, legacyAuthorizationPolicy } from './legacy-authorization-migration';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
export const authorizationTemplateId = (role: AccessRole) => `builtin-${role}`;
export const emptyAuthorizationOverrides = (): AuthorizationOverrides => ({ rules: [], allowPages: [], denyPages: [] });
export function validAuthorizationPolicy(value: unknown): value is AuthorizationPolicy {
  return object(value) && exact(value, ['nativeRole', 'pages', 'rules', 'grantSnapshots']) &&
    (value.nativeRole === null || (PAGE_ACCESS_ROLES as readonly unknown[]).includes(value.nativeRole)) &&
    validPagePaths(value.pages) && (value.nativeRole === 'admin' || !value.pages.includes('/system-configuration')) && validPersonalRules(value.rules) &&
    (value.grantSnapshots === undefined || (Array.isArray(value.grantSnapshots) && value.grantSnapshots.length <= 8 && value.grantSnapshots.every(validAuthorizationGrantSnapshot)));
}
export function validAuthorizationGrantSnapshot(value: unknown): value is AuthorizationGrantSnapshot {
  if(!object(value) || !exact(value,['baseline','overrides','scope','overrideLayers']) || !object(value.baseline) || value.baseline.grantSnapshots !== undefined ||
    !validAuthorizationPolicy(value.baseline) || value.baseline.nativeRole === 'admin' || !validAuthorizationOverrides(value.overrides) || !object(value.scope) ||
    (value.overrideLayers !== undefined && (!Array.isArray(value.overrideLayers) || value.overrideLayers.length > 8 || !value.overrideLayers.every(validAuthorizationOverrides))) ||
    !exact(value.scope,['building','buildings','specialties'])) return false;
  const role=value.baseline.nativeRole || 'guest';
  return validBuildingScope(role,value.scope.building,value.scope.buildings) &&
    (['professional_admin','professional_engineer'].includes(role) ? professionalScopeIsValid(value.scope.specialties) : value.scope.specialties === undefined);
}
export function validAuthorizationOverrides(value: unknown): value is AuthorizationOverrides {
  return object(value) && exact(value, ['rules', 'allowPages', 'denyPages']) && validPersonalRules(value.rules) &&
    validPagePaths(value.allowPages) && validPagePaths(value.denyPages) && !value.allowPages.includes('/system-configuration') &&
    !value.allowPages.some(page => (value.denyPages as string[]).includes(page));
}
export function validAuthorizationBinding(value: unknown): value is AuthorizationBinding {
  if (!object(value)) return false;
  return value.mode === 'follow'
    ? exact(value, ['mode', 'templateId']) && typeof value.templateId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.templateId)
    : value.mode === 'independent' && exact(value, ['mode', 'policy']) && validAuthorizationPolicy(value.policy);
}
export function validEffectiveAuthorization(value: unknown): value is EffectiveAuthorization {
  return object(value) && exact(value,['mode','templateId','templateVersion','baseline','overrides']) && validAuthorizationPolicy(value.baseline) &&
    validAuthorizationOverrides(value.overrides) && (value.mode === 'independent' ? value.templateId === undefined && value.templateVersion === undefined :
      value.mode === 'follow' && typeof value.templateId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.templateId) && Number.isSafeInteger(value.templateVersion) && Number(value.templateVersion) >= 1);
}
export function validAuthorizationTemplate(value: unknown): value is AuthorizationTemplate {
  return object(value) && exact(value, ['id', 'name', 'description', 'version', 'builtin', 'enabled', 'policy']) &&
    typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.id) && typeof value.name === 'string' &&
    value.name.trim() === value.name && value.name.length > 0 && value.name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value.name) &&
    typeof value.description === 'string' && value.description.length <= 500 && typeof value.builtin === 'boolean' && typeof value.enabled === 'boolean' &&
    Number.isSafeInteger(value.version) && Number(value.version) >= 1 && validAuthorizationPolicy(value.policy) &&
    (value.builtin ? value.policy.nativeRole !== null && value.id === authorizationTemplateId(value.policy.nativeRole) : value.policy.nativeRole === null && !value.id.startsWith('builtin-'));
}
export function createAuthorizationTemplates(rolePages: RolePageRules | undefined, label: (role: AccessRole) => string): Record<string, AuthorizationTemplate> {
  return Object.fromEntries(PAGE_ACCESS_ROLES.map(role => {
    const id = authorizationTemplateId(role);
    return [id, { id, name: label(role), description: '沿用已有业务角色，审批名单独立管理', builtin: true, enabled: true, version: 1,
      policy: legacyAuthorizationPolicy(role, rolePages) }];
  }));
}
export function resolveAuthorization(account: ManagedAccount, templates?: Record<string, AuthorizationTemplate>, rolePages?: RolePageRules): EffectiveAuthorization {
  const binding = account.authorizationBinding;
  if (!binding) {
    const baseline = legacyAuthorizationPolicy(account.role, rolePages);
    return { mode: 'independent', baseline, overrides: legacyAuthorizationOverrides(account, baseline, rolePages).overrides };
  }
  const overrides = account.authorizationOverrides || { rules: account.personalRules || [], allowPages: account.pagePaths || [], denyPages: [] };
  if (!validAuthorizationOverrides(overrides) || (binding && !validAuthorizationBinding(binding))) throw new BadRequestException('账号权限配置无效');
  if (binding.mode === 'independent') return { mode: 'independent', baseline: structuredClone(binding.policy), overrides: structuredClone(overrides) };
  const template = templates?.[binding.templateId];
  if (!template || !validAuthorizationTemplate(template)) throw new ConflictException('绑定角色不存在或无效，请重新选择');
  return { mode: 'follow', templateId: template.id, templateVersion: template.version, baseline: structuredClone(template.policy), overrides: structuredClone(overrides) };
}
export function authorizationPolicyFingerprint(value: EffectiveAuthorization): string {
  return createHash('sha256').update(JSON.stringify({ baseline: value.baseline, overrides: value.overrides })).digest('hex');
}
export function authorizationPages(value: EffectiveAuthorization): string[] {
  if (value.baseline.nativeRole === 'admin') return effectivePagePaths('admin');
  const inherited=(value.baseline.grantSnapshots || []).flatMap(snapshot=>[snapshot.overrides,...snapshot.overrideLayers || []].reduce((pages,layer)=>
    [...new Set([...pages,...layer.allowPages])].filter(page=>!layer.denyPages.includes(page)),snapshot.baseline.pages));
  return [...new Set([...value.baseline.pages, ...inherited, ...value.overrides.allowPages])].filter(page => !value.overrides.denyPages.includes(page));
}
/** Store the legacy projection too: raw account consumers must see the same role. */
export function projectAuthorization<T extends ManagedAccount>(account: T, templates: Record<string, AuthorizationTemplate>, rolePages?: RolePageRules): T {
  const effective = resolveAuthorization(account, templates, rolePages);
  const role = effective.baseline.nativeRole || 'guest';
  const projected = { ...account, role, personalRules: structuredClone(effective.overrides.rules), pagePaths: [...effective.overrides.allowPages], effectiveAuthorization: effective };
  if (!['building_admin', 'inventory_admin', 'purchase_applicant', 'professional_engineer'].includes(role)) { projected.building = null; delete projected.buildings; }
  if (!['professional_admin', 'professional_engineer'].includes(role)) delete projected.specialties;
  if (account.id === SITE_MEMBER_BACKUP_ACCOUNT_ID) { delete projected.personalRules; delete projected.pagePaths; }
  return projected;
}
export function authorizationChanged(before: ManagedAccount, after: ManagedAccount): boolean {
  const fields = (account: ManagedAccount) => ({ role: account.role, building: account.building, buildings: account.buildings, specialties: account.specialties,
    policy: account.effectiveAuthorization ? authorizationPolicyFingerprint(account.effectiveAuthorization) : undefined });
  return JSON.stringify(fields(before)) !== JSON.stringify(fields(after));
}
