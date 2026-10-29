import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '../../../shared/access-control.interface';
import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import { businessModuleDefinition, createBusinessPermissionEvaluator, personalPermissionPagePaths } from '../../../shared/business-permissions';
import { PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';
import { canonicalRequestedPermissions, validRequestedPermissions, type CreatePersonnelPermissionRequest, type PersonnelPermissionRequest, type RequestedPermission, type ReviewPersonnelPermissionRequest } from '../../../shared/personnel-permission-request.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { getPersonnelPermissionRequestsStore, PersonnelPermissionRequestsStore, type PermissionRequestsState, type StoredPermissionRequest } from './personnel-permission-requests.store';

const MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
type VerifiedAccount = { account: ManagedAccount; principal: AccessPrincipal; identity: string; revision: number };

@Injectable()
export class PersonnelPermissionRequestsService {
  private readonly store: PersonnelPermissionRequestsStore;
  constructor(private readonly configuration: AccessConfigurationService, @Optional() store?: PersonnelPermissionRequestsStore) {
    this.store = store || getPersonnelPermissionRequestsStore();
  }

  listOwn(principal: AccessPrincipal): PersonnelPermissionRequest[] {
    const owner = this.verify(principal, true);
    return Object.values(this.store.read().requests).filter(row => row.applicantIdentity === owner.identity).map(publicRequest).sort(newestFirst);
  }

  listAdmin(actor: AccessPrincipal): PersonnelPermissionRequest[] {
    this.verifyAdministrator(actor);
    return Object.values(this.store.read().requests).map(publicRequest).sort(newestFirst);
  }

  async create(principal: AccessPrincipal, input: CreatePersonnelPermissionRequest): Promise<PersonnelPermissionRequest> {
    if (!record(input) || !exactKeys(input, ['clientMutationId','permissions','reason']) || !validMutationId(input.clientMutationId) || !validRequestedPermissions(input.permissions)) {
      throw new BadRequestException('权限申请内容无效，请重新选择真实页面、功能及范围');
    }
    const reason = cleanText(input.reason, true, '申请原因');
    const permissions = canonicalRequestedPermissions(input.permissions);
    const result = await this.store.mutate(state => {
      const owner = this.verify(principal, true);
      const key = hash(['create', owner.account.id, input.clientMutationId]);
      const fingerprint = hash({ permissions, reason });
      const previous = replay(state, key, fingerprint);
      if (previous) return previous;
      if (this.satisfied(owner, permissions)) throw new BadRequestException('所申请的权限已经具备，无需重复申请');
      const pending = Object.values(state.requests).filter(row => row.applicantIdentity === owner.identity && row.status === 'pending');
      const duplicate = pending.find(row => JSON.stringify(row.permissions) === JSON.stringify(permissions));
      if (duplicate) {
        state.mutations[key] = { fingerprint, requestId: duplicate.id };
        return duplicate;
      }
      if (pending.length >= 10) throw new BadRequestException('已有较多待处理申请，请等待管理员审核');
      const now = new Date().toISOString();
      const request: StoredPermissionRequest = {
        id: randomUUID(), version: 1, accountId: owner.account.id, applicantIdentity: owner.identity, applicantName: owner.account.name,
        permissions, reason, status: 'pending', createdAt: now, updatedAt: now,
      };
      state.requests[request.id] = request;
      state.mutations[key] = { fingerprint, requestId: request.id };
      state.audit.push({ requestId: request.id, actorId: owner.account.id, action: 'create', at: now, version: 1 });
      return request;
    });
    return publicRequest(result);
  }

  async review(actor: AccessPrincipal, input: ReviewPersonnelPermissionRequest): Promise<PersonnelPermissionRequest> {
    if (!record(input) || !allowedKeys(input, ['clientMutationId','requestId','expectedRequestVersion','decision','comment']) ||
      !validMutationId(input.clientMutationId) || typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(input.requestId) ||
      !Number.isSafeInteger(input.expectedRequestVersion) || input.expectedRequestVersion < 1 || !['approve','reject'].includes(input.decision)) {
      throw new BadRequestException('权限审核内容无效');
    }
    const comment = cleanText(input.comment, input.decision === 'reject', '审核说明');
    const result = await this.store.mutate(state => {
      const reviewer = this.verifyAdministrator(actor);
      const request = Object.hasOwn(state.requests, input.requestId) ? state.requests[input.requestId] : undefined;
      if (!request) throw new BadRequestException('权限申请不存在');
      const target = this.targetRecord(request.accountId);
      if (reviewer.account.id === target.account.id || reviewer.identity === target.identity || reviewer.identity === request.applicantIdentity) throw new ForbiddenException('不能审核本人或关联账号的权限申请');
      const key = hash(['review', reviewer.account.id, input.clientMutationId]);
      const fingerprint = hash({ requestId: input.requestId, expectedRequestVersion: input.expectedRequestVersion, decision: input.decision, comment });
      const previous = replay(state, key, fingerprint);
      if (previous) return previous;
      if (request.version !== input.expectedRequestVersion || request.status !== 'pending') throw new ConflictException('此申请已被处理，请刷新后查看结果');
      let verifiedRevision: number | undefined;
      if (input.decision === 'approve') {
        const eligible = this.verifyTarget(request.accountId);
        if (eligible.identity !== request.applicantIdentity) throw new ConflictException('申请人的账号身份已变化，请重新提交申请');
        if (!this.satisfied(eligible, request.permissions)) throw new ConflictException('申请权限尚未全部生效，请先在现有权限配置中保存并核对范围，再确认已授权');
        verifiedRevision = eligible.revision;
      }
      const now = new Date().toISOString();
      request.status = input.decision === 'approve' ? 'approved' : 'rejected';
      request.version += 1;
      request.updatedAt = now;
      request.reviewerAccountId = reviewer.account.id;
      request.reviewerName = reviewer.account.name;
      if (comment) request.comment = comment;
      if (input.decision === 'approve') request.verifiedConfigurationRevision = verifiedRevision;
      state.mutations[key] = { fingerprint, requestId: request.id };
      state.audit.push({ requestId: request.id, actorId: reviewer.account.id, action: input.decision, at: now, version: request.version });
      return request;
    });
    return publicRequest(result);
  }

  private verify(principal: AccessPrincipal, personal: boolean): VerifiedAccount {
    if (!principal || principal.impersonation) throw new ForbiddenException('代登录期间不能提交或审核权限申请');
    if ((principal as AccessPrincipal & { requiresPasswordChange?: boolean }).requiresPasswordChange) throw new ForbiddenException('请先修改初始密码，再办理权限申请');
    const current = this.configuration.currentPrincipal(principal.accountId, principal.authorizationVersion);
    if (!current || current.role !== principal.role) throw new UnauthorizedException('登录权限已变化，请重新登录');
    if ((current as AccessPrincipal & { requiresPasswordChange?: boolean }).requiresPasswordChange) throw new ForbiddenException('请先修改初始密码，再办理权限申请');
    return this.verifyTarget(current.accountId!, personal, current.authorizationVersion);
  }

  private verifyAdministrator(principal: AccessPrincipal): VerifiedAccount {
    const current = this.verify(principal, false);
    if (current.principal.role !== 'admin') throw new ForbiddenException('仅系统管理员可以审核权限申请');
    return current;
  }

  private verifyTarget(accountId: string, personal = true, version?: number): VerifiedAccount {
    const target = this.targetRecord(accountId);
    const { account } = target;
    if (!account.enabled || account.deleted || account.reactivationRequired || account.permissionsRevoked || account.personnelActive === false ||
      (personal && account.kind === 'local' && account.loginMethod !== 'personnel-password')) {
      throw new ForbiddenException('此账号当前不能申请或办理个人权限，请管理员核对在职及启用状态');
    }
    const principal = this.configuration.currentPrincipal(account.id, version ?? account.version);
    if (!principal) throw new ForbiddenException('此账号当前不可用，请管理员核对在职及启用状态');
    return { ...target, principal };
  }

  private targetRecord(accountId: string): Omit<VerifiedAccount, 'principal'> {
    const snapshot = this.configuration.snapshot();
    const account = snapshot.accounts.find(item => item.id === accountId);
    if (!account) throw new ForbiddenException('申请对应账号不存在，请管理员核对人员身份');
    const personnelIdentity = account.personnelIdentity || (account.loginMethod === 'personnel-password' ? account.id : undefined);
    return { account, revision: snapshot.revision, identity: personnelIdentity
      ? `${account.personnelAppId || account.appId || snapshot.appId}:${personnelIdentity}` : `account:${account.id}` };
  }

  private satisfied(target: VerifiedAccount, permissions: RequestedPermission[]): boolean {
    const paths = this.configuration.pagePermissions(target.principal.role, target.account.id, target.account.version);
    if (paths.revision !== target.revision) throw new ConflictException('权限配置已变化，请重新核对');
    const effectivePages = personalPermissionPagePaths(target.principal, paths.paths);
    const evaluate = createBusinessPermissionEvaluator(target.principal);
    return permissions.every(permission => {
      if (permission.kind === 'page') return effectivePages.includes(permission.path);
      const definition = businessModuleDefinition(permission.module);
      if (!definition.scoped) return evaluate({ module: permission.module, action: permission.action }).allowed;
      const buildings = permission.buildings ?? BUILDING_ADMIN_BUILDINGS;
      const specialties = permission.specialties ?? PROFESSIONAL_SPECIALTIES;
      return buildings.every(building => specialties.every(specialty => evaluate({ module: permission.module, action: permission.action, building, specialty }).allowed));
    });
  }
}

function publicRequest({ applicantIdentity: _identity, ...request }: StoredPermissionRequest): PersonnelPermissionRequest { return structuredClone(request); }
function newestFirst(a: PersonnelPermissionRequest, b: PersonnelPermissionRequest): number { return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: object, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function allowedKeys(value: object, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function validMutationId(value: unknown): value is string { return typeof value === 'string' && MUTATION_ID.test(value); }
function cleanText(value: unknown, required: boolean, label: string): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.trim().length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (required && !value.trim())) throw new BadRequestException(`${label}需填写1至500字`);
  return value.trim();
}
function replay(state: PermissionRequestsState, key: string, fingerprint: string): StoredPermissionRequest | undefined {
  const previous = state.mutations[key];
  if (!previous) return undefined;
  if (previous.fingerprint !== fingerprint) throw new ConflictException('重复提交内容不一致，请重新发起');
  return state.requests[previous.requestId];
}
