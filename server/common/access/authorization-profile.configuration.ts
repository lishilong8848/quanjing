import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthorizationAccountChange, AuthorizationAccountPreview, AuthorizationRoleMutation, AuthorizationRolePreview, AuthorizationTemplate, EffectiveAuthorization } from '../../../shared/authorization-profile';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '../../../shared/site-member-backup';
import { personalPermissionPagePaths } from '../../../shared/business-permissions';
import type { ConfigurationState, StoredAccount } from './access-configuration.store';
import { validAccount } from './access-configuration.validation';
import { roleName } from './access-configuration.defaults';
import { validAccessPasswordHash } from './access-password';
import { authorizationChanged, authorizationPages, authorizationPolicyFingerprint, authorizationTemplateId, createAuthorizationTemplates, projectAuthorization, resolveAuthorization,
  validAuthorizationBinding, validAuthorizationOverrides, validAuthorizationPolicy, validAuthorizationTemplate } from './authorization-profile.policy';
import { legacyAuthorizationOverrides, legacyAuthorizationPages, legacyAuthorizationPolicy, type LegacyMigrationCheck, type LegacyMigrationConflict } from './legacy-authorization-migration';

export function migrateAuthorizationState(state: ConfigurationState, defaults: Record<string, StoredAccount>): void {
  const cleanDefaults=Object.fromEntries(Object.entries(defaults).map(([id,account])=>{
    const copy=structuredClone(account); if(copy.passwordHash !== undefined && !validAccessPasswordHash(copy.passwordHash)) delete copy.passwordHash;
    if(copy.kind === 'local' && copy.loginMethod === undefined) copy.credentialSource='default';
    return [id,copy];
  }));
  if (state.schemaVersion === 2) {
    for(const [id,account] of Object.entries(cleanDefaults)) if(!state.accounts[id]) state.accounts[id]=account;
    reprojectAuthorizationState(state);
    return;
  }
  const templates = createAuthorizationTemplates(state.rolePageRules, roleName);
  const accounts = { ...cleanDefaults, ...state.accounts };
  for (const [id, account] of Object.entries(accounts)) {
    const templateId = authorizationTemplateId(account.role);
    const { overrides } = legacyAuthorizationOverrides(account, templates[templateId].policy, state.rolePageRules);
    accounts[id] = projectAuthorization({ ...account, authorizationBinding: { mode: 'follow', templateId }, authorizationOverrides: overrides }, templates);
  }
  // A conflict above must leave even the caller's in-memory V1 snapshot unchanged.
  state.authorizationTemplates = templates;
  state.accounts = accounts;
  state.schemaVersion = 2;
}

export function reprojectAuthorizationState(state: ConfigurationState): void {
  if (state.schemaVersion !== 2 || !state.authorizationTemplates) return;
  for (const [id, account] of Object.entries(state.accounts)) {
    let next = account;
    if (!next.authorizationBinding) next = bindUnconfiguredAuthorization(next, state);
    // Existing personnel-managed builtin roles may still change with confirmed employment data.
    if (next.permissionSource === 'personnel' && next.authorizationBinding.mode === 'follow' && next.authorizationBinding.templateId.startsWith('builtin-') &&
      next.role !== next.effectiveAuthorization?.baseline.nativeRole)
      next = { ...next, authorizationBinding: { mode: 'follow', templateId: authorizationTemplateId(next.role) } };
    state.accounts[id] = projectAuthorization(next, state.authorizationTemplates);
  }
}

/** Newly discovered default credentials follow the current role; legacy exceptions are checked first. */
export function bindUnconfiguredAuthorization(account: StoredAccount, state: ConfigurationState): StoredAccount {
  const templateId = authorizationTemplateId(account.role), baseline = state.authorizationTemplates?.[templateId]?.policy;
  if (!baseline) throw new ConflictException('绑定角色不存在或无效，请重新选择');
  const overrides = account.personalRules?.length || account.pagePaths?.length
    ? legacyAuthorizationOverrides(account, baseline, state.rolePageRules).overrides : { rules: [], allowPages: [], denyPages: [] };
  return projectAuthorization({ ...account, authorizationBinding: { mode: 'follow', templateId }, authorizationOverrides: overrides }, state.authorizationTemplates!);
}

export function accountAuthorizationChange(state: ConfigurationState, change: AuthorizationAccountChange): { account: StoredAccount; preview: AuthorizationAccountPreview } {
  if (change.expectedRevision !== state.revision) throw new ConflictException('配置已更新，请刷新后重新预览，草稿已保留');
  const previous = state.accounts[change.accountId];
  if (!previous || previous.deleted || previous.id === SITE_MEMBER_BACKUP_ACCOUNT_ID) throw new BadRequestException('账号不存在或为固定备用入口');
  if (!validAuthorizationBinding(change.binding) || !validAuthorizationOverrides(change.overrides)) throw new BadRequestException('角色绑定或个人例外无效');
  if ((change.buildings !== undefined && !Array.isArray(change.buildings)) || (change.specialties !== undefined && !Array.isArray(change.specialties))) throw new BadRequestException('楼栋或专业范围无效');
  if (change.binding.mode === 'follow') {
    const target = state.authorizationTemplates?.[change.binding.templateId];
    if (!target) throw new BadRequestException('所选角色不存在');
    if (!target.enabled && !(previous.authorizationBinding?.mode === 'follow' && previous.authorizationBinding.templateId === target.id)) throw new BadRequestException('该角色已停止新增分配');
  }
  const before = resolveAuthorization(previous, state.authorizationTemplates, state.rolePageRules);
  let next: StoredAccount = { ...previous, authorizationBinding: structuredClone(change.binding), authorizationOverrides: structuredClone(change.overrides), permissionSource: 'manual',
    ...(change.building !== undefined ? { building: change.building } : {}), ...(change.buildings !== undefined ? { buildings: [...change.buildings] } : {}),
    ...(change.specialties !== undefined ? { specialties: [...change.specialties] } : {}) };
  next = projectAuthorization(next, state.authorizationTemplates!);
  if ((before.baseline.nativeRole === 'admin') !== (next.role === 'admin')) throw new BadRequestException('管理员身份须使用固定管理员入口维护，不能通过普通模板变更');
  if (!validAccount(next)) throw new BadRequestException('该角色需要有效楼栋或专业范围，请补齐后保存');
  const after = next.effectiveAuthorization!;
  const sessionWillBeRevoked = authorizationChanged({ ...previous, effectiveAuthorization: before }, next);
  return { account: { ...next, version: previous.version + (sessionWillBeRevoked ? 1 : 0) }, preview: { revision: state.revision, accountId: previous.id, before, after, sessionWillBeRevoked } };
}

export function roleAuthorizationChange(state: ConfigurationState, request: AuthorizationRoleMutation): AuthorizationRolePreview {
  if (request.expectedRevision !== state.revision) throw new ConflictException('配置已更新，请刷新后重新预览，草稿已保留');
  const id = request.id || `role-${createHash('sha256').update(request.clientMutationId).digest('hex').slice(0, 24)}`;
  const previous = state.authorizationTemplates?.[id];
  if (request.id && !previous) throw new BadRequestException('角色不存在');
  const role: AuthorizationTemplate = { id, name: request.name, description: request.description, enabled: request.enabled,
    version: (previous?.version || 0) + 1, builtin: previous?.builtin || false, policy: structuredClone(request.policy) };
  if (!validAuthorizationTemplate(role) || (request.deleted !== undefined && typeof request.deleted !== 'boolean')) throw new BadRequestException('角色名称、页面或业务权限无效');
  if (previous?.builtin && request.deleted) throw new BadRequestException('系统内置角色不能删除');
  if (previous?.builtin && previous.policy.nativeRole !== role.policy.nativeRole) throw new BadRequestException('内置角色的基础业务身份不能修改');
  if (previous?.policy.nativeRole === 'admin' && JSON.stringify({ ...role, version: previous.version }) !== JSON.stringify(previous)) throw new BadRequestException('系统管理员角色固定保护');
  const followers = Object.values(state.accounts).filter(account => account.authorizationBinding?.mode === 'follow' && account.authorizationBinding.templateId === id);
  if (request.deleted && followers.length) throw new ConflictException('角色仍被账号引用，请先转移或设为独立权限');
  const templates = { ...state.authorizationTemplates, [id]: role };
  const affectedAccounts = followers.map(account => {
    const before = resolveAuthorization(account, state.authorizationTemplates), projected = projectAuthorization(account, templates);
    if (!validAccount(projected)) throw new BadRequestException(`角色调整后账号 ${account.name} 的楼栋或专业范围无效`);
    const after = projected.effectiveAuthorization!;
    return { accountId: account.id, name: account.name, before, after,
      sessionWillBeRevoked: authorizationPolicyFingerprint(before) !== authorizationPolicyFingerprint(after) };
  });
  return { revision: state.revision, role, affectedAccounts };
}

/** Legacy handover/edit callers must detach, never silently mutate a followed template. */
export function captureIndependentAuthorization(account: StoredAccount, state: ConfigurationState, snapshot?: EffectiveAuthorization): StoredAccount {
  if(snapshot) return projectAuthorization({...account,authorizationBinding:{mode:'independent',policy:structuredClone(snapshot.baseline)},authorizationOverrides:structuredClone(snapshot.overrides)},state.authorizationTemplates!);
  const policy = legacyAuthorizationPolicy(account.role, state.rolePageRules);
  if (!validAuthorizationPolicy(policy)) throw new BadRequestException('权限快照无效');
  return projectAuthorization({ ...account, authorizationBinding: { mode: 'independent', policy },
    authorizationOverrides: legacyAuthorizationOverrides(account, policy, state.rolePageRules).overrides }, state.authorizationTemplates!);
}

/** No identity-provider IDs, credentials, or source account objects enter the preview. */
export function authorizationMigrationPreview(state: ConfigurationState, defaults: Record<string, StoredAccount>) {
  const originals = { ...defaults, ...state.accounts }, copy = structuredClone(state);
  const templates = state.authorizationTemplates || createAuthorizationTemplates(state.rolePageRules, roleName);
  const conflicts: LegacyMigrationConflict[] = [], checks = new Map<string, LegacyMigrationCheck[]>();
  if (state.schemaVersion === 1) for (const account of Object.values(originals)) {
    try { checks.set(account.id, legacyAuthorizationOverrides(account, templates[authorizationTemplateId(account.role)].policy, state.rolePageRules).checks); }
    catch (error) {
      const detail = error instanceof ConflictException ? error.getResponse() : undefined;
      if (!detail || typeof detail !== 'object' || !('code' in detail) || detail.code !== 'LEGACY_AUTHORIZATION_MIGRATION_CONFLICT') throw error;
      conflicts.push(detail as LegacyMigrationConflict);
    }
  }
  if (!conflicts.length) migrateAuthorizationState(copy, defaults);
  const accounts = Object.values(originals).map(account => {
    const next = !conflicts.length ? copy.accounts[account.id] : undefined;
    const summary = (value: StoredAccount, before: boolean) => ({ role: value.role,
      mode: value.authorizationBinding?.mode || 'legacy', templateId: value.authorizationBinding?.mode === 'follow' ? value.authorizationBinding.templateId : null,
      pages: before && !value.effectiveAuthorization ? legacyAuthorizationPages(value, state.rolePageRules)
        : value.effectiveAuthorization ? personalPermissionPagePaths({ role: value.role, purchaseBuilding: value.building, buildings: value.buildings,
          specialties: value.specialties, personalRules: value.personalRules, effectiveAuthorization: value.effectiveAuthorization }, authorizationPages(value.effectiveAuthorization)) : [],
      scope: { building: value.building, buildings: value.buildings || [], specialties: value.specialties || [] },
      rules: structuredClone(value.effectiveAuthorization ? { baseline: value.effectiveAuthorization.baseline.rules, personal: value.effectiveAuthorization.overrides.rules }
        : { baseline: [], personal: value.personalRules || [] }), authorizationVersion: value.version });
    const before = summary(account, true), after = next ? summary(next, false) : null;
    return { accountId: account.id, before, after,
      pageChanges: after ? { added: after.pages.filter(page => !before.pages.includes(page)), removed: before.pages.filter(page => !after.pages.includes(page)) } : null,
      behavior: { status: conflicts.some(item => item.accountId === account.id) ? 'conflict' : conflicts.length ? 'not-applied' : 'verified',
        checks: checks.get(account.id) || [], boundary: '旧范围查看及真实接口页面限制；其他动作沿用已审核的原生业务约束' } };
  });
  return { revision: state.revision, fromVersion: state.schemaVersion, toVersion: 2 as const, requiresMigration: state.schemaVersion === 1,
    canMigrate: conflicts.length === 0, accountCount: Object.keys(originals).length, defaultAccountCount: Object.keys(originals).filter(id => !state.accounts[id]).length,
    roleCount: Object.keys(templates).length, accounts, conflicts };
}
