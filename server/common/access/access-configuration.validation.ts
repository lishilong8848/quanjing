import { validBuildingScope } from '../../../shared/building-access';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '../../../shared/site-member-backup';
import { BadRequestException } from '@nestjs/common';
import { BUILDING_ADMIN_BUILDINGS, PURCHASE_ACCESS_BUILDINGS } from '../../../shared/access-control.interface';
import { CARD_ROLE_CODES, type CardRoleRule, type ManagedAccount } from '../../../shared/access-configuration.interface';
import { normalizeAccessDisplayName } from './access-display-name';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';
import { professionalScopeIsValid } from '../../../shared/professional-access';
import { validPersonalRules } from '../../../shared/business-permissions';
import { validPersonalPagePaths } from '../../../shared/page-access';
import { validAuthorizationBinding, validAuthorizationOverrides, validEffectiveAuthorization } from './authorization-profile.policy';

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
export const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
export const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SHARED_LOCAL_ACCOUNT = /^local-(?:(?:admin|editor|purchase_admin|construction_admin)-all|(?:inventory_admin|purchase_applicant)-[ABCDEH]|building_admin-(?:[ABCDEH]|110))$/u;
export function validRoleScope(role: unknown, building: unknown, buildings?: unknown): boolean {
  if (typeof role !== 'string' || !validBuildingScope(role, building, buildings)) return false;
  if (role === 'building_admin' || role === 'professional_engineer') return (BUILDING_ADMIN_BUILDINGS as readonly unknown[]).includes(building);
  if (role === 'inventory_admin' || role === 'purchase_applicant') return (PURCHASE_ACCESS_BUILDINGS as readonly unknown[]).includes(building);
  return ['site_member', 'admin', 'editor', 'purchase_admin', 'construction_admin', 'duty_editor', 'supply_chain_admin', 'professional_admin'].includes(String(role)) && building === null;
}
export function validAccount(account: ManagedAccount): boolean {
  if (account?.id === SITE_MEMBER_BACKUP_ACCOUNT_ID && (account.kind !== 'local' || account.role !== 'site_member' || account.building !== null ||
    account.buildings !== undefined || account.personalRules !== undefined || account.pagePaths !== undefined || account.personnelIdentity !== undefined || account.loginMethod !== undefined || account.siteMember !== undefined)) return false;
  return !!account && ID_PATTERN.test(account.id) && ['local', 'feishu'].includes(account.kind) &&
    (account.external === undefined || (typeof account.external === 'boolean' && (account.kind === 'feishu' || !account.external))) &&
    (account.siteMember === undefined || typeof account.siteMember === 'boolean') &&
    typeof account.name === 'string' && normalizeAccessDisplayName(account.name) === account.name &&
    (account.role === 'guest' ? (account.kind === 'feishu' || account.loginMethod === 'personnel-password' || account.kind === 'local' && account.loginMethod === undefined && SHARED_LOCAL_ACCOUNT.test(account.id) && !!account.authorizationBinding) && account.building === null && account.buildings === undefined : validRoleScope(account.role, account.building, account.buildings)) && typeof account.enabled === 'boolean' && typeof account.deleted === 'boolean' &&
    (['professional_admin', 'professional_engineer'].includes(account.role) ? (account.kind === 'feishu' || account.loginMethod === 'personnel-password') && professionalScopeIsValid(account.specialties) : account.specialties === undefined) &&
    (account.personalRules === undefined || validPersonalRules(account.personalRules)) &&
    (account.pagePaths === undefined || validPersonalPagePaths(account.role,account.pagePaths)) &&
    (account.authorizationBinding === undefined || validAuthorizationBinding(account.authorizationBinding)) &&
    (account.authorizationOverrides === undefined || validAuthorizationOverrides(account.authorizationOverrides)) &&
    (account.reactivationRequired === undefined || typeof account.reactivationRequired === 'boolean') &&
    (account.effectiveAuthorization === undefined || validEffectiveAuthorization(account.effectiveAuthorization)) &&
    (account.personnelIdentity === undefined || (typeof account.personnelIdentity === 'string' && /^local-external-[a-f0-9]{64}$/.test(account.personnelIdentity))) &&
    (account.permissionSource === undefined || ['personnel', 'manual'].includes(account.permissionSource)) &&
    (account.personnelSpecialties === undefined || (typeof account.personnelSpecialties === 'string' && account.personnelSpecialties.length <= 500)) &&
    Number.isSafeInteger(account.version) && account.version >= 1 && ['default', 'configuration'].includes(account.source) &&
    (account.loginMethod === undefined ? account.personnelActive === undefined && account.personnelAppId === undefined && !account.id.startsWith('local-external-') : account.loginMethod === 'personnel-password' && account.kind === 'local' && /^local-external-[a-f0-9]{64}$/.test(account.id) && typeof account.personnelActive === 'boolean' && typeof account.personnelAppId === 'string' && /^cli_[A-Za-z0-9_-]+$/.test(account.personnelAppId)) &&
    (account.kind === 'local' ? account.id.startsWith('local-') && account.appId === undefined && account.openId === undefined && account.identityHash === undefined : (typeof account.appId === 'string' && /^cli_[A-Za-z0-9_-]+$/.test(account.appId) &&
      typeof account.identityHash === 'string' && HASH_PATTERN.test(account.identityHash) &&
      account.id === `feishu-${account.identityHash}` && (account.openId === undefined || (typeof account.openId === 'string' && OPEN_ID_PATTERN.test(account.openId) && feishuIdentityFingerprint(account.appId, account.openId) === account.identityHash))));
}
export function validCardRule(rule: CardRoleRule): boolean {
  if (!rule || typeof rule.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(rule.appId)) return false;
  if (!rule || !(CARD_ROLE_CODES as readonly unknown[]).includes(rule.code) || !Number.isSafeInteger(rule.version) || rule.version < 1) return false;
  const scoped = ['building_executor', 'warehouse_responsible', 'warehouse_notify'].includes(rule.code);
  if (scoped ? !(PURCHASE_ACCESS_BUILDINGS as readonly unknown[]).includes(rule.building) : rule.building !== null) return false;
  if (!Array.isArray(rule.members) || rule.members.length > 100 || !rule.members.every(person => person && typeof person.openId === 'string' && OPEN_ID_PATTERN.test(person.openId) && typeof person.name === 'string' && normalizeAccessDisplayName(person.name) === person.name)) return false;
  const unique = new Set(rule.members.map(person => person.openId));
  if (unique.size !== rule.members.length) return false;
  if (['purchase_executor', 'building_executor'].includes(rule.code)) return rule.members.length === 1;
  return ['warehouse_notify', 'contract_notify'].includes(rule.code) || rule.members.length > 0;
}
export function ruleKey(code: string, building: string | null): string { return `${code}:${building || 'all'}`; }
export function requireMutation(value: unknown, allowedKeys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('配置请求无效');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !allowedKeys.includes(key))) throw new BadRequestException('请求包含服务端不支持的字段，请确认页面与服务端版本一致后重试');
  if (typeof item.clientMutationId !== 'string' || !/^[A-Za-z0-9_-]{12,160}$/.test(item.clientMutationId)) throw new BadRequestException('配置请求标识无效，请刷新页面后重试');
  if (!Number.isSafeInteger(item.expectedRevision) || Number(item.expectedRevision) < 0) throw new BadRequestException('配置版本无效，请刷新配置后重试');
}
