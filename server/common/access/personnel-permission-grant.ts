import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '../../../shared/access-control.interface';
import { businessModuleDefinition, createBusinessPermissionEvaluator, personalPermissionPagePaths } from '../../../shared/business-permissions';
import { PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';
import { canonicalRequestedPermissions, validRequestedPermissions, type RequestedPermission } from '../../../shared/personnel-permission-request.interface';
import type { ConfigurationState, StoredAccount } from './access-configuration.store';
import { accountAuthorizationChange } from './authorization-profile.configuration';
import { authorizationPages } from './authorization-profile.policy';

export interface PermissionGrantRequest {
  id: string; version: number; accountId: string; applicantIdentity: string; permissions: RequestedPermission[];
}
export interface PermissionGrantReceipt {
  version: 1; kind: 'personnel-permission-grant'; decision: 'approve';
  requestId: string; requestVersion: number; accountId: string; applicantIdentity: string; permissionsHash: string;
  reviewerAccountId: string; reviewerName: string; clientMutationId: string; comment: string; reviewedAt: string;
}
export type VerifiedPermissionGrantReceipt = PermissionGrantReceipt & { configurationRevision: number };
const PREFIX = 'personnel-permission-grant-v1:';
const FIELDS = ['version','kind','decision','requestId','requestVersion','accountId','applicantIdentity','permissionsHash',
  'reviewerAccountId','reviewerName','clientMutationId','comment','reviewedAt'].sort().join(',');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, length: number, empty = false): value is string => typeof value === 'string' &&
  (empty || value.length > 0) && value.length <= length && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
export const permissionGrantKey = (request: PermissionGrantRequest): string => `permission-request-grant-${digest([request.id, request.version])}`;
export const permissionGrantPermissionsHash = (permissions: RequestedPermission[]): string => digest(canonicalRequestedPermissions(permissions));
export function permissionApplicantIdentity(account: StoredAccount, fallbackAppId: string): string {
  const identity = account.personnelIdentity || (account.loginMethod === 'personnel-password' ? account.id : undefined);
  return identity ? `${account.personnelAppId || account.appId || fallbackAppId}:${identity}` : `account:${account.id}`;
}
export function encodePermissionGrantReceipt(receipt: PermissionGrantReceipt): string {
  // Explicitly versioned canonical receipt in the existing, durable mutation fingerprint slot.
  return PREFIX + JSON.stringify({ version: receipt.version, kind: receipt.kind, decision: receipt.decision,
    requestId: receipt.requestId, requestVersion: receipt.requestVersion, accountId: receipt.accountId,
    applicantIdentity: receipt.applicantIdentity, permissionsHash: receipt.permissionsHash,
    reviewerAccountId: receipt.reviewerAccountId, reviewerName: receipt.reviewerName,
    clientMutationId: receipt.clientMutationId, comment: receipt.comment, reviewedAt: receipt.reviewedAt });
}
export function readPermissionGrantReceipt(state: ConfigurationState, request: PermissionGrantRequest): VerifiedPermissionGrantReceipt | undefined {
  const entry = state.mutations[permissionGrantKey(request)];
  if (!entry) return undefined;
  try {
    if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length > 4096 || !entry.fingerprint.startsWith(PREFIX)) throw new Error();
    const row = JSON.parse(entry.fingerprint.slice(PREFIX.length)) as PermissionGrantReceipt;
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== FIELDS ||
      row.version !== 1 || row.kind !== 'personnel-permission-grant' || row.decision !== 'approve' ||
      row.requestId !== request.id || row.requestVersion !== request.version || row.accountId !== request.accountId ||
      row.applicantIdentity !== request.applicantIdentity || !validRequestedPermissions(request.permissions) ||
      row.permissionsHash !== permissionGrantPermissionsHash(request.permissions) ||
      !text(row.reviewerAccountId, 160) || !/^[A-Za-z0-9_-]+$/u.test(row.reviewerAccountId) ||
      !text(row.reviewerName, 100) || /[\u0000-\u001f\u007f]/u.test(row.reviewerName) || !text(row.comment, 500, true) || row.comment.trim() !== row.comment ||
      typeof row.clientMutationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(row.clientMutationId) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.reviewedAt) || !Number.isFinite(Date.parse(row.reviewedAt)) ||
      !Number.isSafeInteger(entry.revision) || entry.revision <= 0 || entry.revision > state.revision ||
      encodePermissionGrantReceipt(row) !== entry.fingerprint) throw new Error();
    return { ...row, configurationRevision: entry.revision };
  } catch { throw new ConflictException('权限申请授权回执无法核验，请联系管理员，现有权限已保留'); }
}

/** Same evaluator as menus and request previews; no implicit administrator or workflow authority. */
export function requestedPermissionsSatisfied(principal: AccessPrincipal, permissions: RequestedPermission[]): boolean {
  const evaluate = createBusinessPermissionEvaluator(principal);
  const pages = personalPermissionPagePaths(principal, principal.effectiveAuthorization ? authorizationPages(principal.effectiveAuthorization) : []);
  return permissions.every(permission => {
    if (permission.kind === 'page') return pages.includes(permission.path);
    if (!businessModuleDefinition(permission.module).scoped) return evaluate({ module: permission.module, action: permission.action }).allowed;
    return (permission.buildings ?? BUILDING_ADMIN_BUILDINGS).every(building =>
      (permission.specialties ?? PROFESSIONAL_SPECIALTIES).every(specialty => evaluate({ module: permission.module, action: permission.action, building, specialty }).allowed));
  });
}
export function addRequestedAuthorization(state: ConfigurationState, account: StoredAccount, permissions: RequestedPermission[]): StoredAccount {
  if (!validRequestedPermissions(permissions) || !account.authorizationBinding || !account.effectiveAuthorization) {
    throw new ConflictException('权限申请内容无法核验，请刷新后重试');
  }
  const overrides = structuredClone(account.effectiveAuthorization.overrides);
  for (const permission of canonicalRequestedPermissions(permissions)) {
    const current: AccessPrincipal = { accountId: account.id, role: account.role, purchaseBuilding: account.building,
      buildings: account.buildings, specialties: account.specialties, personalRules: overrides.rules,
      effectiveAuthorization: { ...account.effectiveAuthorization, overrides } };
    if (requestedPermissionsSatisfied(current, [permission])) continue;
    if (permission.kind === 'page') {
      if (overrides.denyPages.includes(permission.path)) throw permissionGrantConflict();
      if (!overrides.allowPages.includes(permission.path)) overrides.allowPages.push(permission.path);
    } else {
      if (overrides.denyPages.includes(businessModuleDefinition(permission.module).page)) throw permissionGrantConflict();
      const id = `requested-${digest(permission).slice(0, 48)}`;
      const rule = { id, module: permission.module, actions: [permission.action], effect: 'allow' as const,
        buildings: permission.buildings, specialties: permission.specialties };
      const existing = overrides.rules.find(item => item.id === id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(rule)) throw permissionGrantConflict();
      if (!existing) overrides.rules.push(rule);
    }
  }
  if (overrides.rules.length > 100) throw new ConflictException('个人权限规则已达上限，请先在权限配置中整理后重试');
  const { account: next } = accountAuthorizationChange(state, { accountId: account.id, expectedRevision: state.revision,
    binding: account.authorizationBinding, overrides, building: account.building, buildings: account.buildings, specialties: account.specialties });
  const principal: AccessPrincipal = { accountId: next.id, displayName: next.name, authorizationVersion: next.version,
    role: next.role, purchaseBuilding: next.building, buildings: next.buildings, specialties: next.specialties,
    personalRules: next.personalRules, effectiveAuthorization: next.effectiveAuthorization };
  if (!requestedPermissionsSatisfied(principal, permissions)) throw permissionGrantConflict();
  return next.version === account.version ? account : next;
}
function permissionGrantConflict() { return new ConflictException('申请权限与现有禁止规则或查看范围冲突，请先在权限配置中调整后重试'); }
