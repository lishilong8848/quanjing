import { reconcileSiteMemberAccounts } from './site-member-accounts';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '../../../shared/site-member-backup';
import { cancelHotfixInitialization, runHotfixInitialization } from '../hotfix-runtime-activation';
import { PAGE_ACCESS_ROLES, PAGE_ACCESS_CATALOG, effectivePagePaths, effectiveAccountPagePaths, validPagePaths, validPersonalPagePaths } from '../../../shared/page-access';
import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { AccessPrincipal, PrivilegedAccessPrincipal, TrustedAccessPrincipal } from '../../../shared/access-control.interface';
import { ACCOUNT_MUTATION_FIELDS, type AccessConfigurationResponse, type PageRoleMutation, type AccountMutation, type CardRoleMutation, type CardRoleCode, type ConfigurationPerson } from '../../../shared/access-configuration.interface';
import { AccessConfigurationStore, getAccessConfigurationStore, type ConfigurationState, type StoredAccount } from './access-configuration.store';
import { defaultAccessAccounts, roleName } from './access-configuration.defaults';
import { normalizeAccessDisplayName } from './access-display-name';
import { createAccessPasswordHash, matchesAccessPassword, validAccessPasswordHash } from './access-password';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';
import { ID_PATTERN, OPEN_ID_PATTERN, requireMutation, ruleKey, validAccount, validCardRule } from './access-configuration.validation';
import { normalizeProfessionalScope, professionalScopeIsValid } from '../../../shared/professional-access';
import { validBuildingScope } from '../../../shared/building-access';
import type { ConfigurationDirectorySnapshot } from './access-configuration.directory';
import { BUSINESS_PERMISSION_CATALOG, BUSINESS_ACTION_LABELS } from '../../../shared/business-permissions';
import { capturePersonnelPermission } from './personnel-permission-archive';
import type { HandoverBatch } from '../../../shared/personnel-handover.interface';
import { copyHandoverPreview, permissionTemplateFingerprint } from './personnel-handover.baseline';
import { accountPermissionTemplate, previewPermissionInheritance } from './personnel-handover.preview';
import { handoverItemMutationId } from './personnel-handover.store';
import { CARD_PERSONNEL_DUTIES, personnelDutyAssignmentFingerprint, removePersonnelDutyCardOverride } from './personnel-duty-routing';
import { readCurrentPersonnelDutyMembers, resolveCurrentPersonnelDutyRoutePeople } from './personnel-duty-current';
import { splitHandoverPermissionGrants } from './personnel-handover.ownership';
import { acknowledgePersonnelSourceAssignments, markPersonnelSourceError, reconcilePersonnelSource } from './personnel-source.policy';
import { sourceOwnsCardRole } from '../../../shared/personnel-source.interface';
import type { AuthorizationAccountChange, AuthorizationAccountPreview, AuthorizationRoleList, AuthorizationRoleMutation, AuthorizationRolePreview } from '../../../shared/authorization-profile';
import { authorizationPages, authorizationPolicyFingerprint, authorizationTemplateId, createAuthorizationTemplates, projectAuthorization, resolveAuthorization, validAuthorizationBinding, validAuthorizationOverrides } from './authorization-profile.policy';
import { accountAuthorizationChange, authorizationMigrationPreview, bindUnconfiguredAuthorization, captureIndependentAuthorization, migrateAuthorizationState, reprojectAuthorizationState, roleAuthorizationChange } from './authorization-profile.configuration';
import { effectiveCardDuties } from './effective-card-duties';

@Injectable()
export class AccessConfigurationService implements OnModuleInit {
  private readonly store: AccessConfigurationStore;
  private readonly defaults: Record<string, StoredAccount>;
  constructor() { this.store = getAccessConfigurationStore(); this.defaults = defaultAccessAccounts(); }

  private defaultInitialization?: Promise<void>;
  onModuleInit(): Promise<void> {
    this.store.read();
    return runHotfixInitialization(this, () => this.defaultInitialization ||= this.initializeAuthorizationConfiguration());
  }
  async onModuleDestroy(): Promise<void> { await cancelHotfixInitialization(this); }
  private async initializeAuthorizationConfiguration(): Promise<void> {
    await this.initializeProfessionalDefaults();
    const state=this.store.read();
    if(state.schemaVersion === 2) await this.refreshDefaultCredentials(state);
  }
  previewAuthorizationMigration() {
    return authorizationMigrationPreview(this.store.read(), this.defaults);
  }
  /** Explicit operator-only initialization; ordinary reads and module startup never upgrade V1. */
  async migrateAuthorizationConfiguration(request: Pick<AccountMutation,'clientMutationId'|'expectedRevision'>, actor:AccessPrincipal):Promise<AccessConfigurationResponse> {
    requireMutation(request,['clientMutationId','expectedRevision']);
    this.assertActor(actor,this.store.read());
    if(this.store.read().schemaVersion === 2) return this.snapshot();
    await this.store.mutate(request.expectedRevision,request.clientMutationId,this.fingerprint(request,actor),state=>{
      this.assertActor(actor,state);migrateAuthorizationState(state,this.defaults);
    },{migrationOnly:true});
    return this.snapshot();
  }
  private async refreshDefaultCredentials(state: ConfigurationState): Promise<void> {
    const changed=Object.values(state.accounts).filter(account=>account.credentialSource === 'default' &&
      (account.passwordHash !== this.defaultPasswordHash(account.id) || account.enabled && !this.defaults[account.id]?.enabled));
    if(!changed.length) return;
    const id=`default-credentials-${randomUUID()}`;
    await this.store.mutate(state.revision,id,id,current=>{
      for(const previous of changed) {
        const account=current.accounts[previous.id],hash=this.defaultPasswordHash(previous.id);
        if(!account || account.credentialSource !== 'default') throw new ConflictException('默认凭据状态已变化，请重新启动核对');
        account.version+=1;account.enabled=account.enabled && !!hash && this.defaults[account.id]?.enabled === true;
        if(hash)account.passwordHash=hash;else delete account.passwordHash;
      }
    });
  }
  private defaultPasswordHash(id: string): string | undefined {
    const value=this.defaults[id]?.passwordHash;
    return validAccessPasswordHash(value) ? value : undefined;
  }
  private async initializeProfessionalDefaults(): Promise<void> {
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    const defaults = Object.values(this.defaults).filter(account => account.role === 'professional_admin');
    const state = this.store.read();
    if (!defaults.length || state.professionalDefaultsAppId === appId) return;
    const mutationId = `professional-defaults-${randomUUID()}`;
    await this.store.mutate(state.revision, mutationId, mutationId, current => {
      for (const account of defaults) {
        const previous = current.accounts[account.id];
        if (previous?.role === 'professional_admin' || (previous?.authorizationBinding && previous.permissionSource === 'manual')) continue;
        if (previous) this.preservePermission(current,previous);
        current.accounts[account.id] = { ...account, version: (previous?.version || account.version) + (previous ? 1 : 0) };
        this.audit(current, { role: 'admin', purchaseBuilding: null, displayName: '授权初始化' }, account.name, '初始化专业主管', previous ? describe(previous) : '无授权', describe(current.accounts[account.id]));
      }
      current.professionalDefaultsAppId = appId;
      reprojectAuthorizationState(current);
    });
  }

  private accounts(state = this.store.read()): Record<string, StoredAccount> {
    return Object.fromEntries(Object.entries({ ...this.defaults, ...state.accounts }).map(([id, original]) => {
      let account=original.kind === 'feishu' && original.source === 'default' && !original.external && !original.permissionSource ? { ...original, permissionSource:'personnel' as const } : original;
      if(account.credentialSource === 'default') {
        const hash=this.defaultPasswordHash(id),changed=account.passwordHash !== hash;
        account={...account,passwordHash:hash,enabled:account.enabled && !!hash && this.defaults[id]?.enabled === true,
          ...(changed ? {version:parseInt(createHash('sha256').update(JSON.stringify(['default-credential',account.version,hash || ''])).digest('hex').slice(0,13),16)+1} : {})};
      }
      if(state.schemaVersion === 2 && !account.authorizationBinding) account=bindUnconfiguredAuthorization(account,state);
      return [id,account];
    }));
  }
  pagePermissions(role: import('../../../shared/access-control.interface').AccessRole, accountId?: string, authorizationVersion?: number) {
    const state = this.store.read();
    const account=accountId ? this.accounts(state)[accountId] : undefined;
    const pages=account && !this.employmentInactive(account,state) && account.role === role && this.validateSession(accountId,authorizationVersion,role,account.building,account.specialties,account.buildings) ? account.pagePaths : undefined;
    const effective = account && pages !== undefined && account.effectiveAuthorization ? account.effectiveAuthorization :
      account && !this.employmentInactive(account,state) && this.validateSession(accountId,authorizationVersion,role,account.building,account.specialties,account.buildings) ? account.effectiveAuthorization : undefined;
    return { paths: effective ? authorizationPages(effective) : effectiveAccountPagePaths(role,state.rolePageRules,pages), revision: state.revision, configured: !!effective || state.rolePageRules?.[role] !== undefined || !!pages?.length };
  }

  authorizationRoles(state = this.store.read()): AuthorizationRoleList {
    const templates = state.authorizationTemplates || createAuthorizationTemplates(state.rolePageRules, roleName);
    const accounts = Object.values(this.accounts(state));
    return { revision: state.revision, roles: Object.values(templates).map(role => ({ ...structuredClone(role), followerCount: accounts.filter(account =>
      account.authorizationBinding?.mode === 'follow' ? account.authorizationBinding.templateId === role.id : !account.authorizationBinding && authorizationTemplateId(account.role) === role.id).length })) };
  }
  effectiveAuthorization(accountId: string): AuthorizationAccountPreview {
    const state = this.store.read(), accounts=this.accounts(state);
    const account=typeof accountId === 'string' && Object.hasOwn(accounts,accountId) ? accounts[accountId] : undefined;
    if (!account || account.deleted) throw new BadRequestException('账号不存在');
    const effective = resolveAuthorization(account, state.authorizationTemplates, state.rolePageRules);
    return { revision: state.revision, accountId, before: effective, after: structuredClone(effective), sessionWillBeRevoked: false };
  }
  previewAuthorization(change: AuthorizationAccountChange): AuthorizationAccountPreview {
    if (!change || typeof change !== 'object' || Object.keys(change).some(key => !['accountId','expectedRevision','binding','overrides','building','buildings','specialties'].includes(key))) throw new BadRequestException('权限预览字段无效');
    const state = this.store.read(); migrateAuthorizationState(state, this.defaults);
    return accountAuthorizationChange(state, change).preview;
  }
  previewAuthorizationRole(request: AuthorizationRoleMutation): AuthorizationRolePreview {
    this.validateRoleMutation(request);
    const state = this.store.read(); migrateAuthorizationState(state, this.defaults);
    return roleAuthorizationChange(state, request);
  }
  async saveAuthorizationRole(request: AuthorizationRoleMutation, actor: AccessPrincipal): Promise<AccessConfigurationResponse> {
    this.validateRoleMutation(request);
    await this.store.mutate(request.expectedRevision, request.clientMutationId, this.fingerprint(request, actor), state => {
      this.assertActor(actor, state); migrateAuthorizationState(state, this.defaults);
      const preview = roleAuthorizationChange(state, request);
      if (request.deleted) delete state.authorizationTemplates![preview.role.id];
      else state.authorizationTemplates![preview.role.id] = preview.role;
      for (const change of preview.affectedAccounts) {
        const previous = state.accounts[change.accountId]; this.preservePermission(state, previous);
        state.accounts[change.accountId] = projectAuthorization({ ...previous, version: previous.version + (change.sessionWillBeRevoked ? 1 : 0) }, state.authorizationTemplates!);
      }
      this.assertAdministratorRemains(this.accounts(state), state);
      if (preview.affectedAccounts.some(change => change.sessionWillBeRevoked)) state.legacySessionsRevoked = true;
      this.audit(state, actor, preview.role.name, request.deleted ? '删除权限角色' : '保存权限角色', request.id || '新角色', `${preview.affectedAccounts.length}个跟随账号；个人例外保留`);
    });
    return this.snapshot();
  }
  private validateRoleMutation(request: AuthorizationRoleMutation): void {
    requireMutation(request, ['clientMutationId','expectedRevision','id','name','description','enabled','policy','deleted']);
  }
  async savePageRole(request: PageRoleMutation, actor: AccessPrincipal): Promise<AccessConfigurationResponse> {
    requireMutation(request, ['clientMutationId', 'expectedRevision', 'role', 'pages', 'restoreDefault']);
    if (request.role === 'admin' || !(PAGE_ACCESS_ROLES as readonly string[]).includes(request.role) || !validPagePaths(request.pages) ||
      (request.restoreDefault !== undefined && typeof request.restoreDefault !== 'boolean')) throw new BadRequestException('页面权限配置无效，管理员权限固定');
    await this.store.mutate(request.expectedRevision, request.clientMutationId, this.fingerprint(request, actor), state => {
      this.assertActor(actor, state);
      migrateAuthorizationState(state, this.defaults);
      for (const account of Object.values(this.accounts(state))) if (account.role === request.role) this.preservePermission(state,account);
      const before = effectivePagePaths(request.role, state.rolePageRules);
      state.rolePageRules ||= {};
      if (request.restoreDefault) delete state.rolePageRules[request.role];
      else state.rolePageRules[request.role] = [...request.pages].sort();
      const template = state.authorizationTemplates![authorizationTemplateId(request.role)];
      template.policy.pages = effectivePagePaths(request.role, state.rolePageRules); template.version += 1;
      for (const account of Object.values(state.accounts)) if (account.authorizationBinding?.mode === 'follow' && account.authorizationBinding.templateId === template.id) {
        const next = projectAuthorization(account, state.authorizationTemplates!);
        if (authorizationPolicyFingerprint(account.effectiveAuthorization!) !== authorizationPolicyFingerprint(next.effectiveAuthorization!)) next.version += 1;
        state.accounts[account.id] = next;
      }
      const labels = (paths: string[]) => PAGE_ACCESS_CATALOG.filter(page => paths.includes(page.path)).map(page => page.label).join('、') || '无';
      this.audit(state, actor, roleName(request.role), request.restoreDefault ? '恢复默认页面权限' : '保存页面读取权限', labels(before), labels(effectivePagePaths(request.role, state.rolePageRules)));
    });
    return this.snapshot();
  }
  snapshot(): AccessConfigurationResponse {
    const state = this.store.read();
    return { revision: state.revision, schemaVersion: state.schemaVersion, authorizationTemplates: this.authorizationRoles(state).roles, appId: process.env.FEISHU_APP_ID?.trim() || '',
      accounts: Object.values(this.accounts(state)).map(({ passwordHash, personnelSuspended, credentialSource, ...account }) => ({ ...account, enabled:account.enabled && !this.employmentInactive(account,state),
        ...((this.employmentInactive(account,state) || account.reactivationRequired) ? {permissionsRevoked:true,guestLoginAllowed:false} : {}),
        ...(account.kind === 'local' ? { name: account.loginMethod ? account.name : account.name.replace(/共享入口$/, '密码登录'), passwordConfigured: validAccessPasswordHash(passwordHash) } : {}) })),
      cardRules: Object.values(state.cardRules), effectiveCardDuties:effectiveCardDuties(state,process.env.FEISHU_APP_ID?.trim() || ''), audit: state.audit.slice().reverse(), personnelSync: state.personnelSync, rolePageRules: state.rolePageRules,
      ...(state.personnelSource ? { personnelSource: structuredClone(state.personnelSource) } : {}),
      ...(state.personnelBaseline ? {personnelBaseline:(()=>{const row=state.personnelBaseline!.confirmations[state.personnelBaseline!.currentId];return {id:row.id,confirmedAt:row.confirmedAt,actorName:row.actorName,count:Object.keys(row.rows).length};})()} : {}),
      ...(state.personnelDutyAssignments ? {personnelDutyAssignments:state.personnelDutyAssignments} : {}) };
  }
  enrichedSnapshot(people: ConfigurationPerson[]): AccessConfigurationResponse {
    const snapshot = this.snapshot();
    const directory = new Map(people.map(person => [feishuIdentityFingerprint(snapshot.appId, person.openId), person]));
    snapshot.accounts = snapshot.accounts.map(account => {
      const person = !account.external && account.appId === snapshot.appId && account.identityHash ? directory.get(account.identityHash) : undefined;
      return person ? { ...account, openId: person.openId, name: person.name } : account;
    });
    return snapshot;
  }
  permissionArchives(): import('../../../shared/personnel-handover.interface').PersonnelPermissionArchive[] {
    return structuredClone(Object.values(this.store.read().personnelPermissionArchives || {}));
  }
  currentDutyRoutePeople(kind: import('../../../shared/personnel-authority.interface').AuthorityDutyKind, target: { building?: unknown; specialty?: unknown }) {
    const state = this.store.read(), appId = process.env.FEISHU_APP_ID?.trim() || '';
    return resolveCurrentPersonnelDutyRoutePeople(state, appId, kind, target);
  }
  localTargets(): { hash: string; principal: TrustedAccessPrincipal; credentialRole?: PrivilegedAccessPrincipal['role']; credentialBuilding?: StoredAccount['building'] }[] {
    return Object.values(this.accounts()).filter(account => account.kind === 'local' && account.loginMethod === undefined &&
      this.defaults[account.id]?.kind === 'local' && this.defaults[account.id]?.role !== 'guest' && account.enabled && !account.deleted && validAccessPasswordHash(account.passwordHash))
      .map(account => ({ hash: account.passwordHash!, principal: toPrincipal(account) as TrustedAccessPrincipal,
        credentialRole:this.defaults[account.id].role as PrivilegedAccessPrincipal['role'],credentialBuilding:this.defaults[account.id].building }));
  }
  employeeTargets(name: string): { hash: string; principal: AccessPrincipal }[] {
    const state=this.store.read();
    const accounts = Object.values(this.accounts(state)).filter(account => account.loginMethod === 'personnel-password' && account.name === name && this.canAuthenticatePersonnel(account,state));
    if (accounts.length !== 1) return [];
    const account = accounts[0];
    return [{ hash: account.passwordHash!, principal: toPrincipal(account) }];
  }
  feishuPrincipal(openId: string, appId: string): TrustedAccessPrincipal | null {
    const state=this.store.read(), account=this.accounts(state)[`feishu-${feishuIdentityFingerprint(appId, openId)}`];
    if (!account || account.kind !== 'feishu' || account.appId !== appId || !this.canAuthenticatePersonnel(account,state)) return null;
    if (this.employmentInactive(account,state)) return null;
    return toPrincipal(account) as TrustedAccessPrincipal;
  }
  canUseFeishuGuestIdentity(accountId: string | undefined, appId: string): boolean {
    if (appId !== process.env.FEISHU_APP_ID?.trim()) return false;
    if (!accountId) return true;
    const state=this.store.read(), account=this.accounts(state)[accountId];
    if (state.personnelEmployment?.appId === appId && (state.personnelEmployment.inactive[accountId] === true || state.personnelEmployment.loginBlocked?.[accountId])) return false;
    return !account || (account.kind === 'feishu' && account.appId === appId && this.canAuthenticatePersonnel(account,state));
  }
  canUseFeishuBusinessIdentity(accountId: string | undefined, appId: string): boolean {
    if (appId !== process.env.FEISHU_APP_ID?.trim() || !accountId) return false;
    const state=this.store.read(),account=this.accounts(state)[accountId];
    const revoked=state.personnelEmployment?.appId === appId && (state.personnelEmployment.inactive[accountId] === true || !!state.personnelEmployment.loginBlocked?.[accountId]);
    return !revoked && (!account || (account.kind === 'feishu' && account.appId === appId && account.enabled && !account.deleted && !account.reactivationRequired && !this.loginBlocked(account,state) && !this.employmentInactive(account,state)));
  }
  currentPrincipal(id: string | undefined, version: number | undefined): AccessPrincipal | undefined {
    if (!id) return undefined;
    const account = this.accounts()[id];
    return account && account.version === version && this.validateSession(id, version, account.role, account.building, account.specialties, account.buildings) ? toPrincipal(account) : undefined;
  }
  impersonationTarget(id: string): AccessPrincipal | undefined {
    const account = this.accounts()[id];
    return account ? this.currentPrincipal(id, account.version) : undefined;
  }
  impersonationStopped(family: string): boolean {
    return !!this.store.read().mutations[`impersonation-stop-${family}`];
  }
  async recordImpersonation(actor: AccessPrincipal, target: string, family: string, action: 'start' | 'stop', fingerprint: string, times: { issuedAt: number; expiresAt: number }): Promise<{ issuedAt: number; expiresAt: number }> {
    const id = `impersonation-${action}-${family}`;
    const state = await this.store.mutate(this.store.read().revision, id, fingerprint, current => {
      this.assertActor(actor, current);
      current.audit.push({ id, at: new Date(times.issuedAt).toISOString(), actorId: actor.accountId!, actorName: actor.displayName || '管理员',
        target, action: action === 'start' ? '开始代登录' : '结束代登录', before: '', after: JSON.stringify(times) });
    });
    const entry = state.audit.find(item => item.id === id);
    if (!entry) throw new ConflictException('代登录记录已过期，请重新发起');
    const recorded = JSON.parse(entry.after) as typeof times;
    if (!Number.isSafeInteger(recorded.issuedAt) || !Number.isSafeInteger(recorded.expiresAt)) throw new ServiceUnavailableException('代登录记录无法核对');
    return recorded;
  }
  validateSession(id: string | undefined, version: number | undefined, role: string, building: string | null, specialties?: readonly string[], buildings?: readonly string[]): boolean {
    const state = this.store.read();
    if (!id) return !['professional_admin', 'professional_engineer'].includes(role) && !state.legacySessionsRevoked;
    const account = this.accounts(state)[id];
    if (account && (this.employmentInactive(account,state) || account.reactivationRequired || this.loginBlocked(account,state))) return false;
    return !!account && account.enabled && !account.deleted && !this.employmentInactive(account,state) && (account.role !== 'site_member' || account.siteMember === true || account.id === SITE_MEMBER_BACKUP_ACCOUNT_ID) && account.version === version && account.role === role && account.building === building && JSON.stringify(account.buildings) === JSON.stringify(buildings) &&
      (!['professional_admin', 'professional_engineer'].includes(role) || JSON.stringify(account.specialties) === JSON.stringify(specialties)) &&
      (account.kind === 'local' ? validAccessPasswordHash(account.passwordHash) && (account.loginMethod === undefined || (account.personnelActive === true && account.personnelAppId === process.env.FEISHU_APP_ID?.trim())) : account.appId === process.env.FEISHU_APP_ID?.trim());
  }
  cardMembers(code: CardRoleCode, building: string | null): ConfigurationPerson[] | null {
    return readConfiguredCardMembers(code, building);
  }
  async synchronizePersonnel(directory: ConfigurationDirectorySnapshot): Promise<AccessConfigurationResponse> {
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    if (!appId || directory.appId !== appId || !directory.personnelComplete || !Number.isSafeInteger(directory.snapshotAt) ||
      Math.abs(Date.now() - directory.snapshotAt) > 5 * 60_000) throw new ServiceUnavailableException('人员表快照不完整或已过期，保留现有授权');
    if (directory.employmentState && !directory.employmentState.complete) throw new ServiceUnavailableException('人员状态快照不完整，保留现有授权');
    const people = new Map(directory.employees.map(person => [feishuIdentityFingerprint(appId, person.openId), person]));
    const state = this.store.read();
    const managed = new Set(Object.values(this.accounts(state)).filter(account => account.permissionSource === 'personnel' && !account.external && !account.deleted && account.appId === appId).map(account => account.identityHash));
    const seen = new Map<string, string>();
    for (const person of directory.employees) {
      const identity = feishuIdentityFingerprint(appId, person.openId), profile = JSON.stringify(person);
      if (managed.has(identity) && seen.has(identity) && seen.get(identity) !== profile) throw new ServiceUnavailableException('待同步人员身份冲突，保留现有授权');
      seen.set(identity, profile);
    }
    const mutationId = `personnel-sync-${randomUUID()}`;
    await this.store.mutate(state.revision, mutationId, mutationId, current => {
      migrateAuthorizationState(current, this.defaults);
      let changed = 0;
      for (const account of Object.values(this.accounts(current))) this.preservePermission(current,account);
      this.updateEmployment(current,directory);
      const actor: AccessPrincipal = { role: 'admin', purchaseBuilding: null, displayName: '人员同步' };
      for (const account of Object.values(this.accounts(current))) {
        if (account.kind !== 'feishu' || account.appId !== appId || account.external || account.deleted || ['site_member', 'professional_engineer'].includes(account.role) || account.permissionSource !== 'personnel') continue;
        const person = people.get(account.identityHash!);
        if (!person) continue;
        let specialties = account.specialties;
        const enabled = account.enabled;
        if (!person.inactive && account.role === 'professional_admin') {
          const fromTable = normalizeProfessionalScope(person.specialties);
          if (!person.position || !fromTable.length) throw new ServiceUnavailableException('专业主管岗位或专业未维护，保留现有授权');
          if (account.personnelSpecialties !== undefined && account.personnelSpecialties !== person.specialties) specialties = fromTable;
        }
        const authorizationChanged = account.name !== person.name || account.enabled !== enabled || JSON.stringify(account.specialties) !== JSON.stringify(specialties);
        if (!authorizationChanged && account.personnelSpecialties === person.specialties) continue;
        const next: StoredAccount = { ...account, name: person.name, enabled, specialties, personnelSpecialties: person.specialties, version: account.version + (authorizationChanged ? 1 : 0) };
        current.accounts[account.id] = next;
        this.audit(current, actor, next.name, '人员表同步', describe(account), describe(next));
        changed++;
      }
      if (directory.externalEmployees !== undefined) {
        if (!Array.isArray(directory.externalEmployees)) throw new ServiceUnavailableException('外部员工快照不完整，保留现有授权');
        const external = new Map(directory.externalEmployees.map(person => [person.id, person]));
        if (external.size !== directory.externalEmployees.length) throw new ServiceUnavailableException('外部员工身份冲突，保留现有授权');
        const existing = Object.values(this.accounts(current)).filter(account => account.loginMethod === 'personnel-password' && account.personnelAppId === appId);
        for (const id of new Set([...external.keys(), ...existing.map(account => account.id)])) {
          const previous = current.accounts[id], person = external.get(id);
          const next: StoredAccount = { ...(previous || { id, kind: 'local', role: 'guest', building: null, enabled: true, deleted: false, source: 'configuration', version: 1, permissionSource: 'personnel' }),
            name: person?.name || previous!.name, loginMethod: 'personnel-password', personnelAppId: appId, personnelActive: !!person?.active, passwordHash: person?.passwordHash };
          if (!validAccount(next) || (next.passwordHash !== undefined && !validAccessPasswordHash(next.passwordHash)) || (next.personnelActive && !next.passwordHash)) throw new ServiceUnavailableException('外部员工快照无效，保留现有授权');
          const differs = !previous || previous.name !== next.name || previous.personnelActive !== next.personnelActive || previous.passwordHash !== next.passwordHash;
          if (!differs) continue;
          next.version = previous ? previous.version + 1 : 1; current.accounts[id] = next;
          this.audit(current, actor, next.name, '外部员工同步', previous ? describe(previous) : '无账号', describe(next)); changed++;
        }
      }
      if (directory.activeMembers !== undefined) {
        const members=directory.activeMembers.filter(person=>current.personnelEmployment?.inactive[person.passwordAccountId] !== true && (!person.openId || current.personnelEmployment?.inactive[`feishu-${feishuIdentityFingerprint(appId,person.openId)}`] !== true));
        for (const { before, after } of reconcileSiteMemberAccounts(this.accounts(current), appId, members,directory.activeMembersComplete !== false)) {
          current.accounts[after.id] = after;
          this.audit(current, actor, after.name, '在职成员同步', before ? describe(before) : '无授权', describe(after)); changed++;
        }
      }
      for (const account of Object.values(this.accounts(current))) {
        if (account.deleted) continue;
        const blocked=this.employmentInactive(account,current);
        if (blocked && (account.enabled || !account.reactivationRequired)) {
          const next:StoredAccount={...account,enabled:false,personnelSuspended:true,reactivationRequired:true,version:account.version+1}; current.accounts[account.id]=next;
          this.audit(current,actor,account.name,'人员状态停用',describe(account),describe(next)); changed++;
        }
      }
      reprojectAuthorizationState(current);
      reconcilePersonnelSource(current, directory);
      const sourceError = current.personnelSource?.error || (directory.credentialsComplete === false ? '姓名登录资料同步失败，现有凭据保留，请重试' : undefined);
      current.personnelSync = { ...current.personnelSync, status: sourceError ? 'error' : 'success', lastAttemptAt: new Date().toISOString(),
        ...(sourceError ? { error: sourceError } : { lastSuccessAt: new Date().toISOString(), error: undefined }), changed,
        ...(directory.personnelWarnings?.length ? { warning: directory.personnelWarnings.join(' ') } : { warning: undefined }) };
    });
    return this.snapshot();
  }
  async recordPersonnelSyncError(): Promise<void> {
    const state = this.store.read(), id = `personnel-sync-error-${randomUUID()}`;
    await this.store.mutate(state.revision, id, id, current => {
      current.personnelSync = { ...current.personnelSync, status: 'error', lastAttemptAt: new Date().toISOString(), error: '人员同步失败，现有授权保留，请重试或检查人员表配置' };
      markPersonnelSourceError(current);
    });
  }
  async beginPersonnelSyncAttempt(day: string, now = new Date()): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(now.getTime())) throw new BadRequestException('人员同步时间无效');
    const state = this.store.read(), id = `personnel-sync-attempt-${randomUUID()}`;
    await this.store.mutate(state.revision, id, id, current => {
      const previous = current.personnelSync;
      current.personnelSync = { ...previous, status: 'syncing', error: undefined, attemptDay: day,
        attempts: Math.min(3, previous?.attemptDay === day ? (previous.attempts || 0) + 1 : 1),
        lastAttemptAt: now.toISOString(), nextAttemptAt: new Date(now.getTime() + 5 * 60_000).toISOString() };
    });
  }
  async saveAccount(request: AccountMutation, actor: AccessPrincipal): Promise<AccessConfigurationResponse> {
    requireMutation(request, ACCOUNT_MUTATION_FIELDS);
    // Validate the submitted scope before projection can normalize away invalid fields.
    if (!PAGE_ACCESS_ROLES.includes(request.role) || !validBuildingScope(request.role,request.building,request.buildings) ||
      (['professional_admin','professional_engineer'].includes(request.role) ? !professionalScopeIsValid(request.specialties) : request.specialties !== undefined)) throw new BadRequestException('角色或楼栋专业范围无效');
    if (typeof request.name !== 'string' || normalizeAccessDisplayName(request.name) !== request.name || typeof request.enabled !== 'boolean' ||
      (request.deleted !== undefined && typeof request.deleted !== 'boolean') || !['local','feishu'].includes(request.kind) ||
      (request.id !== undefined && (typeof request.id !== 'string' || !ID_PATTERN.test(request.id))) ||
      (request.password !== undefined && (typeof request.password !== 'string' || request.password.length < 8 || request.password.length > 256))) throw new BadRequestException('账号信息或密码无效，密码需为8至256字符');
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    if (request.pagePaths !== undefined && !validPersonalPagePaths(request.role,request.pagePaths)) throw new BadRequestException('个人页面读取配置无效');
    if ((request.authorizationBinding !== undefined && !validAuthorizationBinding(request.authorizationBinding)) ||
      (request.authorizationOverrides !== undefined && !validAuthorizationOverrides(request.authorizationOverrides))) throw new BadRequestException('角色绑定或个人例外无效');
    if (request.external !== undefined && (typeof request.external !== 'boolean' || (request.kind !== 'feishu' && request.external))) throw new BadRequestException('外部人员只能使用飞书账号');
    if (request.kind === 'feishu' && request.openId !== undefined && !OPEN_ID_PATTERN.test(request.openId)) throw new BadRequestException('飞书 Open ID 无效');
    if (request.kind === 'feishu' && request.password !== undefined) throw new BadRequestException('飞书账号不能设置本地密码');
    await this.store.mutate(request.expectedRevision, request.clientMutationId, this.fingerprint(request, actor), async state => {
      this.assertActor(actor, state);
      migrateAuthorizationState(state, this.defaults);
      const accounts = this.accounts(state);
      const id = request.id || (request.kind === 'feishu' && request.openId ? `feishu-${feishuIdentityFingerprint(appId, request.openId)}` : '');
      if (!id) throw new BadRequestException('请选择已有本地共享入口或填写飞书身份');
      const previous = accounts[id];
      if (request.role === 'site_member' && id !== SITE_MEMBER_BACKUP_ACCOUNT_ID && (!previous?.siteMember || request.external || (previous.kind === 'local' && previous.loginMethod !== 'personnel-password'))) throw new BadRequestException('基地成员仅适用于在职人员视图中的实名账号');
      if (request.id && !previous) throw new BadRequestException('账号不存在，请刷新列表');
      if (!request.id && previous && !previous.deleted) throw new ConflictException('飞书授权已存在，请编辑已有账号');
      if (previous && (previous.kind !== request.kind || (request.kind === 'feishu' && request.openId && previous.identityHash !== feishuIdentityFingerprint(appId, request.openId)))) throw new BadRequestException('账号稳定身份不能修改');
      if (previous?.loginMethod === 'personnel-password' && (request.name !== previous.name || request.password !== undefined || (request.enabled && previous.personnelActive !== true))) throw new BadRequestException('外部员工姓名、密码和在职状态请在人员表维护');
      let next: StoredAccount = { ...previous, id, kind: request.kind, name: request.name, role: request.role, building: request.building, buildings: request.buildings ? [...request.buildings] : undefined,
        specialties: ['professional_admin', 'professional_engineer'].includes(request.role) ? request.specialties : undefined,
        personalRules: request.personalRules === undefined ? previous?.personalRules : request.personalRules,
        pagePaths: request.pagePaths === undefined ? previous?.pagePaths : [...request.pagePaths].sort(),
        permissionSource: previous && request.role === previous.role && request.building === previous.building && JSON.stringify(request.buildings) === JSON.stringify(previous.buildings) && JSON.stringify(request.specialties) === JSON.stringify(previous.specialties) &&
          (request.authorizationBinding === undefined || JSON.stringify(request.authorizationBinding) === JSON.stringify(previous.authorizationBinding)) &&
          (request.authorizationOverrides === undefined || JSON.stringify(request.authorizationOverrides) === JSON.stringify(previous.authorizationOverrides)) &&
          (request.personalRules === undefined || JSON.stringify(request.personalRules) === JSON.stringify(previous.personalRules)) &&
          (request.pagePaths === undefined || JSON.stringify(request.pagePaths) === JSON.stringify(previous.pagePaths)) ? previous.permissionSource : 'manual',
        ...(request.external !== undefined ? { external: request.external } : {}),
        enabled: request.enabled && !request.deleted, deleted: !!request.deleted, version: (previous?.version || 0) + 1, source: 'configuration',
        ...(request.kind === 'feishu' ? { appId, identityHash: feishuIdentityFingerprint(appId, request.openId || previous?.openId || ''), openId: request.openId || previous?.openId } : {}) };
      if (request.kind === 'feishu' && !request.openId && previous) { next.identityHash = previous.identityHash; next.appId = previous.appId; }
      if (next.kind === 'local' && !validAccessPasswordHash(next.passwordHash)) delete next.passwordHash;
      if (request.confirmReactivation !== undefined && typeof request.confirmReactivation !== 'boolean') throw new BadRequestException('复职确认无效');
      if (request.enabled && this.employmentInactive(next,state)) throw new BadRequestException('人员状态仍为离职，不能启用登录');
      if (request.enabled && (next.reactivationRequired || this.loginBlocked(next,state)) && !request.confirmReactivation) throw new BadRequestException('复职账号须由管理员明确确认恢复登录');
      if (request.confirmReactivation) {
        if (!request.enabled || this.employmentInactive(next,state)) throw new BadRequestException('请核对在职状态后确认恢复登录');
        this.confirmAccountReactivation(next,state); delete next.personnelSuspended; next.reactivationRequired=false;
      }
      if (request.authorizationBinding || request.authorizationOverrides) {
        const requestedNative=request.authorizationBinding?.mode === 'follow' ? state.authorizationTemplates?.[request.authorizationBinding.templateId]?.policy.nativeRole :
          request.authorizationBinding?.mode === 'independent' ? request.authorizationBinding.policy.nativeRole : previous?.effectiveAuthorization?.baseline.nativeRole;
        if(requestedNative === 'admin' && previous?.role !== 'admin') throw new BadRequestException('管理员身份不能通过普通模板分配');
        const candidateState = { ...state, accounts: { ...state.accounts, [id]: { ...next, role: previous?.role || next.role } } };
        const changed = accountAuthorizationChange(candidateState, { accountId:id,expectedRevision:state.revision,
          binding: request.authorizationBinding || previous?.authorizationBinding || { mode:'follow',templateId:authorizationTemplateId(request.role) },
          overrides: request.authorizationOverrides || previous?.authorizationOverrides || { rules:next.personalRules || [],allowPages:next.pagePaths || [],denyPages:[] },
          building:request.building, buildings:request.buildings, specialties:request.specialties });
        next = { ...changed.account, version:(previous?.version || 0)+1 };
      } else {
        if (!previous?.authorizationBinding || previous.role !== request.role) next.authorizationBinding={mode:'follow',templateId:authorizationTemplateId(request.role)};
        next.authorizationOverrides={rules:request.personalRules === undefined ? previous?.authorizationOverrides?.rules || next.personalRules || [] : request.personalRules,
          allowPages:request.pagePaths === undefined ? previous?.authorizationOverrides?.allowPages || next.pagePaths || [] : request.pagePaths,
          denyPages:previous?.authorizationOverrides?.denyPages || []};
        next=projectAuthorization(next,state.authorizationTemplates!);
      }
      if (!validAccount(next) || (request.kind === 'local' && !this.defaults[id] && previous?.loginMethod !== 'personnel-password')) throw new BadRequestException('角色或楼栋范围无效');
      if (request.password !== undefined) {
        delete next.credentialSource;
        for (const other of Object.values(accounts)) {
          if (other.id !== id && other.kind === 'local' && other.loginMethod === undefined && other.enabled && !other.deleted && other.passwordHash && await matchesAccessPassword(request.password, other.passwordHash)) throw new BadRequestException('此密码已用于其他共享入口，请使用不同密码');
        }
        next.passwordHash = await createAccessPasswordHash(request.password);
      }
      if (next.kind === 'local' && next.loginMethod === undefined && next.enabled && (!validAccessPasswordHash(next.passwordHash) || ((!previous?.enabled || previous.deleted) && request.password === undefined))) throw new BadRequestException('启用共享入口时请设置新密码');
      if (previous) this.preservePermission(state,previous);
      state.accounts[id] = next;
      // 关联来自已核验的人员记录身份，不根据姓名推断；授权和规则在同一事务更新。
      if (next.personnelIdentity && next.siteMember && !next.external) {
        for (const linked of Object.values(accounts)) {
          if (linked.id === id || linked.personnelIdentity !== next.personnelIdentity || !linked.siteMember || linked.external || linked.deleted ||
            (linked.kind === 'feishu' ? linked.appId !== appId : linked.personnelAppId !== appId || !linked.personnelActive)) continue;
          const updated: StoredAccount = { ...linked, role: next.role, building: next.building, buildings: next.buildings, specialties: next.specialties, personalRules: next.personalRules, pagePaths:next.pagePaths,
            authorizationBinding:structuredClone(next.authorizationBinding!),authorizationOverrides:structuredClone(next.authorizationOverrides!),effectiveAuthorization:structuredClone(next.effectiveAuthorization!),
            ...(request.confirmReactivation ? {enabled:true,personnelSuspended:undefined,reactivationRequired:false} : {}),
            permissionSource: next.permissionSource, version: linked.version + 1 };
          if (!validAccount(updated)) throw new BadRequestException('关联账号权限无效，未保存');
          this.preservePermission(state,linked);
          state.accounts[linked.id] = updated;
          this.audit(state, actor, linked.name, '同步关联登录权限', describe(linked), describe(updated));
        }
      }
      this.assertAdministratorRemains(this.accounts(state),state);
      state.legacySessionsRevoked = true;
      this.audit(state, actor, next.name, next.deleted ? '删除授权' : !next.enabled ? '停用授权' : request.password !== undefined ? '设置权限及密码' : '保存授权',
        previous ? describe(previous) : '无授权', describe(next));
    });
    return this.snapshot();
  }
  async saveCardRule(request: CardRoleMutation, actor: AccessPrincipal): Promise<AccessConfigurationResponse> {
    requireMutation(request, ['clientMutationId','expectedRevision','code','building','members','restoreDefault']);
    const rule = { appId: process.env.FEISHU_APP_ID?.trim() || '', code: request.code, building: request.building, members: request.members, version: 1 };
    if ((request.restoreDefault !== undefined && typeof request.restoreDefault !== 'boolean') || !validCardRule(rule)) throw new BadRequestException('卡片角色、楼栋或人数无效');
    if (!process.env.FEISHU_APP_ID?.trim()) throw new ServiceUnavailableException('飞书应用未配置');
    await this.store.mutate(request.expectedRevision, request.clientMutationId, this.fingerprint(request, actor), state => {
      this.assertActor(actor, state);
      const key = ruleKey(request.code, request.building);
      if (sourceOwnsCardRole(state.personnelSource, request.code, request.building)) throw new ConflictException('该职责已由统一岗位来源管理，请维护岗位关联并核对交接');
      const previous = state.cardRules[key];
      removePersonnelDutyCardOverride(state.personnelDutyAssignments, request.code, request.building);
      if (request.restoreDefault) delete state.cardRules[key];
      else state.cardRules[key] = { ...rule, version: (previous?.version || 0) + 1 };
      this.audit(state, actor, `${cardRoleName(request.code)} · ${request.building || '全基地'}`, request.restoreDefault ? '恢复默认卡片人员' : '保存卡片人员', previous ? previous.members.map(person => person.name).join('、') || '无人接收' : '沿用现有配置', request.restoreDefault ? '沿用现有配置' : request.members.map(person => person.name).join('、') || '无人接收');
    });
    return this.snapshot();
  }
  private assertActor(actor: AccessPrincipal, state: ConfigurationState): void {
    if (actor.role !== 'admin' || actor.impersonation || (actor.accountId && !this.validateSession(actor.accountId, actor.authorizationVersion, actor.role, actor.purchaseBuilding)) || (!actor.accountId && state.legacySessionsRevoked)) throw new UnauthorizedException('管理权限已变化，请重新登录');
  }
  private preservePermission(state: ConfigurationState, account: StoredAccount): void {
    if (this.employmentInactive(account,state)) return;
    const archive=capturePersonnelPermission(account,state.rolePageRules,state.revision);
    if (!archive) return;
    state.personnelPermissionArchives ||= {};
    state.personnelPermissionArchives[account.id]=archive;
  }
  personnelPermissionArchives() {
    return this.store.read().personnelPermissionArchives || {};
  }
  // The execution port supplies a persisted, administrator-confirmed batch; HTTP input must not call this directly.
  async applyPersonnelHandoverPermissions(batch: HandoverBatch, mutationId: string): Promise<void> {
    const preview=copyHandoverPreview(batch.preview);
    if (mutationId!==handoverItemMutationId(batch.id,'permissions') || batch.fingerprint!==preview.fingerprint ||
      !ID_PATTERN.test(batch.actorId) || normalizeAccessDisplayName(batch.actorName)!==batch.actorName || !preview.permissions.length ||
      preview.conflicts.length || preview.permissions.some(item=>item.conflicts.length)) throw new BadRequestException('交接权限事务无效');
    const fingerprint=handoverPermissionMutationFingerprint(batch);
    await this.store.mutate(preview.baseline.configurationRevision,mutationId,fingerprint,state=>{
      const accounts=this.accounts(state),appId=process.env.FEISHU_APP_ID?.trim();
      if (!appId || state.personnelEmployment?.appId!==appId) throw new ConflictException('人员权限状态未对齐，请同步后重新核对交接');
      for(const row of preview.dutyRouting || []) {
        if(row.assignment.appId!==appId || personnelDutyAssignmentFingerprint(state.personnelDutyAssignments?.[row.assignment.dutyRecordId])!==row.previousFingerprint) throw new ConflictException('岗位归属已变化，请重新核对交接');
      }
      const belongs=(account:StoredAccount,person:typeof preview.to)=>account.kind==='feishu' ?
        account.appId===appId && !!person.openId && account.openId===person.openId && account.id===`feishu-${feishuIdentityFingerprint(appId,person.openId)}` :
        account.loginMethod==='personnel-password' && account.personnelAppId===appId && (account.personnelIdentity===person.id || account.id===person.id);
      const ownership=preview.requested.ownership;
      const sourceIds=Object.values(accounts).filter(account=>belongs(account,preview.from)).map(account=>account.id);
      if(preview.requested.mode==='rotation'&&(!ownership||ownership.length!==sourceIds.length||sourceIds.some(id=>!ownership.some(choice=>choice.sourceAccountId===id))))throw new ConflictException('轮岗必须确认全部登录方式的权限归属');
      const splitBySource=new Map<string,ReturnType<typeof splitHandoverPermissionGrants>>();
      for(const choice of ownership||[]) {
        const account=accounts[choice.sourceAccountId];if(!account||!sourceIds.includes(account.id))throw new ConflictException('权限归属账号不属于前任');
        const original=preview.requested.mode==='rotation'?accountPermissionTemplate(account,state.rolePageRules):state.personnelPermissionArchives?.[account.id]?.template;
        if(!original)throw new ConflictException('权限归属缺少原授权证明');
        if(!preview.permissions.some(item=>JSON.stringify({...item.source,sourceVersion:1})===JSON.stringify({...original,sourceVersion:1})))throw new ConflictException('前任不同登录方式的原授权不一致');
        splitBySource.set(account.id,splitHandoverPermissionGrants(original,choice.grants,preview.requested.dutyRecordIds,effectivePagePaths('site_member',state.rolePageRules),effectivePagePaths(original.role,state.rolePageRules)));
      }
      for (const entry of preview.baseline.accounts) if (accounts[entry.id]?.version!==entry.version) throw new ConflictException('交接账号权限已变化，请重新核对清单');
      const targetIds=Object.values(accounts).filter(account=>belongs(account,preview.to)).map(account=>account.id);
      if (targetIds.length!==preview.permissions.length || targetIds.some(id=>!preview.permissions.some(item=>item.targetAccountId===id))) throw new ConflictException('接任者登录账号已变化，请重新核对清单');
      for (const item of preview.permissions) {
        const source=accounts[item.sourceAccountId],target=accounts[item.targetAccountId];
        if (!source || !target || !belongs(source,preview.from) || !belongs(target,preview.to) ||
          !target.enabled || target.deleted || target.permissionsRevoked || target.personnelActive===false || this.employmentInactive(target,state) || !this.canAuthenticatePersonnel(target,state) ||
          state.personnelEmployment.inactive[target.id]!==false || state.personnelEmployment.inactive[preview.to.id]!==false) throw new ConflictException('接任者当前不可授予权限，请重新核对人员状态');
        const sourceInactive=this.employmentInactive(source,state);
        if (preview.requested.mode==='offboarding' ? !sourceInactive || !item.sourceArchive || state.personnelEmployment.inactive[preview.from.id]!==true :
          sourceInactive || !source.enabled || source.deleted || source.permissionsRevoked || state.personnelEmployment.inactive[source.id]!==false || state.personnelEmployment.inactive[preview.from.id]!==false) throw new ConflictException('前任人员状态已变化，请重新核对交接');
        if (permissionTemplateFingerprint(accountPermissionTemplate(target,state.rolePageRules))!==permissionTemplateFingerprint(item.before)) throw new ConflictException('接任者权限已变化，请重新核对清单');
        if (item.sourceArchive) {
          const archive=state.personnelPermissionArchives?.[source.id],reference=item.sourceArchive;
          if (!archive || archive.appId!==appId || archive.personnelIdentity!==preview.from.id || archive.configurationRevision!==reference.configurationRevision ||
            archive.template.sourceVersion!==reference.sourceVersion || permissionTemplateFingerprint(archive.template)!==reference.templateHash) throw new ConflictException('前任授权存档已变化，请重新核对清单');
        } else if (permissionTemplateFingerprint(accountPermissionTemplate(source,state.rolePageRules))!==permissionTemplateFingerprint(item.source)) throw new ConflictException('前任权限已变化，请重新核对清单');
        const split=splitBySource.get(source.id);
        if(split ? !item.transfer||permissionTemplateFingerprint(split.transfer)!==permissionTemplateFingerprint(item.transfer)||preview.requested.mode==='rotation'&&(!item.sourceRetained||permissionTemplateFingerprint(split.retained)!==permissionTemplateFingerprint(item.sourceRetained)) : item.transfer!==undefined||item.sourceRetained!==undefined)throw new ConflictException('权限归属与确认清单不一致');
        const inherited=previewPermissionInheritance(item.transfer||item.source,item.before);
        if (inherited.conflicts.length || permissionTemplateFingerprint(inherited.after)!==permissionTemplateFingerprint(item.after) ||
          (item.after.role==='admin' && target.role!=='admin')) throw new ConflictException('交接权限包含冲突或管理员升级，请单独配置后重新核对');
      }
      for (const item of preview.permissions) {
        const previous=accounts[item.targetAccountId],next:StoredAccount={...previous,role:item.after.role,building:item.after.building,pagePaths:[...item.after.pagePaths],version:previous.version+1,permissionSource:'manual'};
        delete next.buildings;delete next.specialties;delete next.personalRules;
        if (item.after.buildings) next.buildings=[...item.after.buildings];
        if (item.after.specialties) next.specialties=[...item.after.specialties];
        if (item.after.personalRules) next.personalRules=structuredClone(item.after.personalRules);
        this.preservePermission(state,previous);
        state.accounts[next.id]=state.schemaVersion === 2 ? captureIndependentAuthorization(next,state,item.after.effectiveAuthorization) : next;
        this.audit(state,{role:'admin',purchaseBuilding:null,accountId:batch.actorId,displayName:batch.actorName},next.name,'交接继承权限',describe(previous),describe(next));
      }
      if(preview.dutyRouting) {
        state.personnelDutyAssignments ||= {};
        for(const row of preview.dutyRouting) state.personnelDutyAssignments[row.assignment.dutyRecordId]={...structuredClone(row.assignment),confirmedBatchId:batch.id};
        acknowledgePersonnelSourceAssignments(state);
      }
      if(preview.requested.mode==='rotation') for(const [sourceId,split] of splitBySource) {
        const previous=accounts[sourceId],after=split.retained,next:StoredAccount={...previous,role:after.role,building:after.building,pagePaths:[...after.pagePaths],version:previous.version+1,permissionSource:'manual'};
        delete next.buildings;delete next.specialties;delete next.personalRules;
        if(after.buildings)next.buildings=[...after.buildings];if(after.specialties)next.specialties=[...after.specialties];if(after.personalRules)next.personalRules=structuredClone(after.personalRules);
        this.preservePermission(state,previous);state.accounts[sourceId]=state.schemaVersion === 2 ? captureIndependentAuthorization(next,state,after.effectiveAuthorization) : next;
        this.audit(state,{role:'admin',purchaseBuilding:null,accountId:batch.actorId,displayName:batch.actorName},next.name,'轮岗保留其他任职权限',describe(previous),describe(next));
      }
    });
  }
  personnelHandoverPermissionRevision(batch: HandoverBatch): number | undefined {
    const preview=copyHandoverPreview(batch.preview);
    if (batch.fingerprint!==preview.fingerprint) throw new BadRequestException('交接权限事务指纹无效');
    const previous=this.store.read().mutations[handoverItemMutationId(batch.id,'permissions')];
    if (previous && previous.fingerprint!==handoverPermissionMutationFingerprint(batch)) throw new ConflictException('交接权限回执不一致');
    return previous?.revision;
  }
  private canAuthenticatePersonnel(account: StoredAccount, state: ConfigurationState): boolean {
    if (account.deleted || !account.enabled || account.reactivationRequired || this.employmentInactive(account,state) || this.loginBlocked(account,state)) return false;
    if (account.kind === 'feishu') return account.appId === process.env.FEISHU_APP_ID?.trim();
    return account.loginMethod === 'personnel-password' && account.personnelActive === true && account.personnelAppId === process.env.FEISHU_APP_ID?.trim() && validAccessPasswordHash(account.passwordHash);
  }
  private loginBlocked(account: StoredAccount, state: ConfigurationState): boolean {
    const registry=state.personnelEmployment, appId=account.kind === 'feishu' ? account.appId : account.personnelAppId;
    return !!registry && registry.appId === appId && !!(registry.loginBlocked?.[account.id] || (account.personnelIdentity && registry.loginBlocked?.[account.personnelIdentity]));
  }
  private confirmAccountReactivation(account: StoredAccount, state: ConfigurationState): void {
    const registry=state.personnelEmployment;
    if (!registry || registry.appId !== (account.appId || account.personnelAppId) || Date.now()-registry.snapshotAt > 5*60_000 ||
      !(registry.inactive[account.id] === false || (account.personnelIdentity && registry.inactive[account.personnelIdentity] === false)))
      throw new BadRequestException('请先同步并确认人员在职状态，再恢复登录');
    const linked=Object.values(this.accounts(state)).filter(other=>other.id === account.id || (!!account.personnelIdentity && other.personnelIdentity === account.personnelIdentity));
    if (linked.some(other=>this.employmentInactive(other,state))) throw new BadRequestException('关联身份仍为离职，不能恢复登录');
    for(const key of [account.id,account.personnelIdentity,...linked.map(other=>other.id)].filter((key):key is string=>!!key)) if(registry.loginBlocked) delete registry.loginBlocked[key];
  }
  private employmentInactive(account: StoredAccount, state: ConfigurationState): boolean {
    const registry=state.personnelEmployment, appId=account.kind === 'feishu' ? account.appId : account.personnelAppId;
    if (!registry || registry.appId !== appId) return false;
    const direct=registry.inactive[account.id];
    return direct === true || (direct !== false && !!account.personnelIdentity && registry.inactive[account.personnelIdentity] === true);
  }
  private updateEmployment(state: ConfigurationState, directory: ConfigurationDirectorySnapshot): void {
    const inactive:Record<string,boolean>=Object.fromEntries(Object.entries(state.personnelEmployment?.appId === directory.appId ? state.personnelEmployment.inactive : {}).filter(([,flag])=>flag));
    const native=new Map<string,boolean>();
    const merge=(openId:string,flag:boolean)=>{
      if (!OPEN_ID_PATTERN.test(openId) || typeof flag !== 'boolean') throw new ServiceUnavailableException('人员状态快照无效，保留现有授权');
      const id=`feishu-${feishuIdentityFingerprint(directory.appId,openId)}`;
      native.set(id,native.has(id) ? native.get(id)! && flag : flag);
    };
    if (directory.employmentState) {
      if (!Array.isArray(directory.employmentState.entries) || directory.employmentState.entries.length > 10_000) throw new ServiceUnavailableException('人员状态快照无效，保留现有授权');
      const seen=new Set<string>();
      for (const person of directory.employmentState.entries) {
        if (!person || !/^local-external-[a-f0-9]{64}$/u.test(person.personnelIdentity) || seen.has(person.personnelIdentity) || typeof person.inactive !== 'boolean') throw new ServiceUnavailableException('人员状态快照无效，保留现有授权');
        seen.add(person.personnelIdentity); inactive[person.personnelIdentity]=person.inactive;
        if (person.openId) merge(person.openId,person.inactive);
      }
    } else for (const person of directory.employees) merge(person.openId,person.inactive);
    for (const [id,flag] of native) inactive[id]=flag;
    for (const account of Object.values(this.accounts(state))) {
      if (account.kind === 'feishu' && account.appId === directory.appId && account.personnelIdentity && inactive[account.personnelIdentity] === true && !native.has(account.id)) inactive[account.id]=true;
      if (account.kind === 'feishu' && account.appId === directory.appId && account.personnelIdentity && inactive[account.id] === true) inactive[account.personnelIdentity]=true;
    }
    const loginBlocked={...(state.personnelEmployment?.appId === directory.appId ? state.personnelEmployment.loginBlocked : {})};
    for(const [id,flag] of Object.entries(inactive)) if(flag) loginBlocked[id]=true;
    state.personnelEmployment={appId:directory.appId,snapshotAt:directory.snapshotAt,inactive,loginBlocked};
  }
  private assertAdministratorRemains(accounts: Record<string, StoredAccount>, state: ConfigurationState): void {
    const secret = process.env.LOCAL_ACCESS_SESSION_SECRET || process.env.LOCAL_ADMIN_SESSION_SECRET || '';
    const bytes = Buffer.from(secret.trim(), 'base64');
    const hasSecret = bytes.length === 32 && bytes.toString('base64') === secret.trim();
    const feishuReady = !!process.env.FEISHU_APP_ID?.trim() && !!process.env.FEISHU_APP_SECRET?.trim();
    if (!hasSecret || !Object.values(accounts).some(account => account.role === 'admin' && account.enabled && !account.deleted && !account.reactivationRequired && !this.loginBlocked(account,state) && !this.employmentInactive(account,state) &&
      (account.kind === 'local' ? validAccessPasswordHash(account.passwordHash) && (account.loginMethod === undefined || (account.personnelActive === true && account.personnelAppId === process.env.FEISHU_APP_ID?.trim())) : feishuReady && account.appId === process.env.FEISHU_APP_ID?.trim()))) throw new BadRequestException('必须保留至少一个可用管理员，未保存');
  }
  private fingerprint(request: AccountMutation | CardRoleMutation | PageRoleMutation | AuthorizationRoleMutation | Pick<AccountMutation,'clientMutationId'|'expectedRevision'>, actor: AccessPrincipal): string {
    const secret = process.env.LOCAL_ACCESS_SESSION_SECRET || process.env.LOCAL_ADMIN_SESSION_SECRET;
    if (!secret) throw new ServiceUnavailableException('管理会话密钥未配置');
    const fields = { ...request, ...('password' in request ? { password: request.password } : {}), ...('openId' in request ? { openId: request.openId } : {}) };
    return createHmac('sha256', secret).update('access-config-mutation\0').update(JSON.stringify({ actor: actor.accountId || `${actor.role}:${actor.purchaseBuilding}`, request: fields })).digest('hex');
  }
  private audit(state: ConfigurationState, actor: AccessPrincipal, target: string, action: string, before: string, after: string): void {
    state.audit.push({ id: randomUUID(), at: new Date().toISOString(), actorId: actor.accountId || 'legacy-local-admin', actorName: actor.displayName || '管理员共享入口', target, action, before, after });
  }
}
function handoverPermissionMutationFingerprint(batch: HandoverBatch): string {
  return createHash('sha256').update(JSON.stringify([batch.id,batch.clientMutationId,batch.actorId,batch.preview.fingerprint])).digest('hex');
}
function toPrincipal(account: StoredAccount): AccessPrincipal {
  return { role: account.role, purchaseBuilding: account.building, ...(account.buildings ? { buildings: [...account.buildings] } : {}), displayName: account.name, accountId: account.id, authorizationVersion: account.version,
    ...(account.effectiveAuthorization ? { effectiveAuthorization:structuredClone(account.effectiveAuthorization) } : {}),
    ...(account.specialties ? { specialties: [...account.specialties] } : {}), ...(account.personalRules ? { personalRules: structuredClone(account.personalRules) } : {}) };
}
function describe(account: StoredAccount): string {
  const rules = account.personalRules?.map(rule => `${rule.effect === 'deny' ? '限制' : '允许'}${BUSINESS_PERMISSION_CATALOG.find(item => item.id === rule.module)?.label}(${rule.buildings?.join('、') || '全部楼栋'}；${rule.specialties?.join('、') || '全部专业'}；${rule.actions.map(action => BUSINESS_ACTION_LABELS[action]).join('、')})`).join(' / ');
  return `${account.deleted ? '已删除' : account.enabled ? '启用' : '停用'} · ${roleName(account.role)} · ${[account.buildings?.join('、') || account.building, account.specialties?.join('、')].filter(Boolean).join(' · ') || '全基地'}${rules ? ` · ${rules}` : ''}`;
}
function cardRoleName(code: CardRoleCode): string {
  return { purchase_manager: '采购经理审批', purchase_approvers: '旧采购审批人员', purchase_executor: '综合采购执行人', building_executor: '楼栋自采执行人', warehouse_responsible: '库房责任人员', warehouse_notify: '库房管理知会人', contract_notify: '合同通知人员' }[code];
}
export function readConfiguredCardMembers(code: CardRoleCode, building: string | null, specialty?: unknown): ConfigurationPerson[] | null {
  return readCurrentPersonnelDutyMembers(CARD_PERSONNEL_DUTIES[code], { building, ...(specialty === undefined ? {} : { specialty }) });
}
export function useConfiguredCardAuthorizationSnapshots(): boolean { return getAccessConfigurationStore().read().revision > 0; }
