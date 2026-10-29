import { validBuildingScope, canAccessBuilding } from '../../../shared/building-access';
import { isSiteMemberSessionAccountId } from '../../../shared/site-member-backup';
import { professionalScopeIsValid } from '../../../shared/professional-access';
import {
  HttpException,
  HttpStatus,
  ForbiddenException,
  BadRequestException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AccessRole,
  AccessLoginRequest,
  AccessPrincipal,
  PrivilegedAccessPrincipal,
  FeishuGuestAccessPrincipal,
  TrustedAccessPrincipal,
  BuildingAdminBuilding,
  PurchaseAccessBuilding,
} from '@shared/access-control.interface';
import {
  BUILDING_ADMIN_BUILDINGS,
  PURCHASE_ACCESS_BUILDINGS,
} from '../../../shared/access-control.interface';
import { normalizeAccessDisplayName } from './access-display-name';
import { verifyPersonnelPassword } from './personnel-password';
import { effectivePagePaths } from '../../../shared/page-access';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessPersonnelSyncService } from './access-personnel-sync.service';
import { IMPERSONATION_TTL_MS, validImpersonationPayload, type ImpersonationPayload } from './access-impersonation';
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export const ACCESS_SESSION_TTL_MS = 60 * 60 * 1000;

const ACCESS_SESSION_COOKIE_NAME = 'vnet_access_session';
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURE_SOURCES = 1024;
const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 2;
const MAX_SOURCE_LENGTH = 128;
const SESSION_VERSION = 3;
const SESSION_FAMILY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PRINCIPAL_FINGERPRINT_DOMAIN = 'vnet-access-principal-v1\0';
const LEGACY_SESSION_FAMILY_DOMAIN = 'vnet-access-legacy-family-v1\0';
const UNRESTRICTED_PRINCIPAL_FINGERPRINT = createHash('sha256')
  .update('vnet-access-unrestricted-principal-v1\0')
  .digest('base64url');

interface LoginFailureState {
  firstFailureAt: number;
}

interface ParsedPasswordHash {
  salt: Buffer;
  derived: Buffer;
}

interface AccessSessionPayloadV2 {
  version: 2;
  role: PrivilegedAccessPrincipal['role'];
  purchaseBuilding: PurchaseAccessBuilding | BuildingAdminBuilding | null;
  issuedAt: number;
  expiresAt: number;
}

interface AccessSessionPayloadV3 {
  version: 3;
  role: PrivilegedAccessPrincipal['role'];
  purchaseBuilding: PurchaseAccessBuilding | BuildingAdminBuilding | null;
  issuedAt: number;
  expiresAt: number;
  sessionFamilyId: string;
}

interface AccessSessionPayloadV4 extends Omit<AccessSessionPayloadV3, 'version'> {
  version: 4;
  displayName: string;
}
interface AccessSessionPayloadV5 extends Omit<AccessSessionPayloadV3, 'version'> {
  version: 5;
  displayName?: string;
  accountId: string;
  authorizationVersion: number;
}

interface AccessSessionPayloadV7 extends Omit<AccessSessionPayloadV5, 'version' | 'role'> {
  version: 7;
  role: 'professional_admin';
  specialties: import('../../../shared/professional-access').ProfessionalSpecialty[];
}
interface AccessSessionPayloadV10 extends Omit<AccessSessionPayloadV5, 'version' | 'role'> {
  version: 10; role: 'professional_engineer'; buildings: BuildingAdminBuilding[]; specialties: import('../../../shared/professional-access').ProfessionalSpecialty[];
}
interface AccessSessionPayloadV8 extends Omit<AccessSessionPayloadV5, 'version'> {
  version: 8;
  buildings: import('../../../shared/access-control.interface').BuildingAdminBuilding[];
}
interface AccessSessionPayloadV9 extends Omit<AccessSessionPayloadV5, 'version' | 'role'> { version: 9; role: 'guest'; purchaseBuilding: null; displayName: string; }
interface AccessSessionPayloadV6 extends Omit<AccessSessionPayloadV3, 'version' | 'role' | 'purchaseBuilding'> {
  version: 6;
  role: 'guest';
  purchaseBuilding: null;
  displayName?: string;
  feishuAppId: string;
  accountId?: string;
}

type AccessSessionPayload = AccessSessionPayloadV2 | AccessSessionPayloadV3 | AccessSessionPayloadV4 | AccessSessionPayloadV5 | AccessSessionPayloadV6 | AccessSessionPayloadV7 | AccessSessionPayloadV8 | AccessSessionPayloadV9 | AccessSessionPayloadV10;

interface ResolvedAccessSessionPayload {
  impersonationSession?: ImpersonationPayload;
  impersonation?: AccessPrincipal['impersonation'];
  effectiveAuthorization?: import('../../../shared/authorization-profile').EffectiveAuthorization;
  personalRules?: AccessPrincipal['personalRules'];
  buildings?: AccessPrincipal['buildings'];
  specialties?: AccessPrincipal['specialties'];
  displayName?: string;
  accountId?: string;
  authorizationVersion?: number;
  role: AccessPrincipal['role'];
  feishuAppId?: string;
  purchaseBuilding: PurchaseAccessBuilding | BuildingAdminBuilding | null;
  issuedAt: number;
  expiresAt: number;
  sessionFamilyId: string;
}

interface LoginTarget {
  hash: string;
  principal: AccessPrincipal;
}

export interface AccessLoginResult {
  token: string;
  principal: AccessPrincipal;
  expiresAt: number;
  principalFingerprint: string;
}

export interface AccessSessionStatus {
  principal: AccessPrincipal;
  expiresAt: number | null;
}

export interface AccessSessionIdentityStatus extends AccessSessionStatus {
  principalFingerprint: string | null;
}

@Injectable()
export class UnifiedAccessService {
  constructor(
    @Optional() private readonly configuration?: AccessConfigurationService,
    @Optional() private readonly personnelSync?: AccessPersonnelSyncService,
  ) {}
  pagePermissions(role: AccessRole, accountId?: string, authorizationVersion?: number) { return this.configuration?.pagePermissions(role,accountId,authorizationVersion) ?? { paths: effectivePagePaths(role), revision: 0, configured: false }; }

  readonly cookieName = ACCESS_SESSION_COOKIE_NAME;

  private readonly accessControlEnabled =
    String(process.env.LOCAL_ACCESS_CONTROL_ENABLED ?? '')
      .trim()
      .toLowerCase() !== 'false';

  private readonly adminPasswordHash = String(
    process.env.LOCAL_ADMIN_PASSWORD_HASH || '',
  ).trim();
  private readonly editorPasswordHash = String(
    process.env.LOCAL_EDITOR_PASSWORD_HASH || '',
  ).trim();
  private readonly purchaseAdminPasswordHash = String(
    process.env.LOCAL_PURCHASE_ADMIN_PASSWORD_HASH || '',
  ).trim();
  private readonly constructionAdminPasswordHash = String(
    process.env.LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH || '',
  ).trim();
  private readonly inventoryAdminPasswordHashes: Record<
    PurchaseAccessBuilding,
    string
  > = {
    A楼: String(process.env.LOCAL_INVENTORY_ADMIN_A_PASSWORD_HASH || '').trim(),
    B楼: String(process.env.LOCAL_INVENTORY_ADMIN_B_PASSWORD_HASH || '').trim(),
    C楼: String(process.env.LOCAL_INVENTORY_ADMIN_C_PASSWORD_HASH || '').trim(),
    D楼: String(process.env.LOCAL_INVENTORY_ADMIN_D_PASSWORD_HASH || '').trim(),
    E楼: String(process.env.LOCAL_INVENTORY_ADMIN_E_PASSWORD_HASH || '').trim(),
    H楼: String(process.env.LOCAL_INVENTORY_ADMIN_H_PASSWORD_HASH || '').trim(),
  };
  private readonly purchaseApplicantPasswordHashes: Record<
    PurchaseAccessBuilding,
    string
  > = {
    A楼: String(
      process.env.LOCAL_PURCHASE_APPLICANT_A_PASSWORD_HASH || '',
    ).trim(),
    B楼: String(
      process.env.LOCAL_PURCHASE_APPLICANT_B_PASSWORD_HASH || '',
    ).trim(),
    C楼: String(
      process.env.LOCAL_PURCHASE_APPLICANT_C_PASSWORD_HASH || '',
    ).trim(),
    D楼: String(
      process.env.LOCAL_PURCHASE_APPLICANT_D_PASSWORD_HASH || '',
    ).trim(),
    E楼: String(
      process.env.LOCAL_PURCHASE_APPLICANT_E_PASSWORD_HASH || '',
    ).trim(),
    H楼: String(
      process.env.LOCAL_PURCHASE_APPLICANT_H_PASSWORD_HASH || '',
    ).trim(),
  };
  private readonly buildingAdminPasswordHashes: Record<
    BuildingAdminBuilding,
    string
  > = {
    A楼: String(process.env.LOCAL_BUILDING_ADMIN_A_PASSWORD_HASH || '').trim(),
    B楼: String(process.env.LOCAL_BUILDING_ADMIN_B_PASSWORD_HASH || '').trim(),
    C楼: String(process.env.LOCAL_BUILDING_ADMIN_C_PASSWORD_HASH || '').trim(),
    D楼: String(process.env.LOCAL_BUILDING_ADMIN_D_PASSWORD_HASH || '').trim(),
    E楼: String(process.env.LOCAL_BUILDING_ADMIN_E_PASSWORD_HASH || '').trim(),
    H楼: String(process.env.LOCAL_BUILDING_ADMIN_H_PASSWORD_HASH || '').trim(),
    '110站': String(process.env.LOCAL_BUILDING_ADMIN_110_PASSWORD_HASH || '').trim(),
  };
  private readonly sessionSecret = parseSessionSecret(
    selectSessionSecret(
      process.env.LOCAL_ACCESS_SESSION_SECRET,
      process.env.LOCAL_ADMIN_SESSION_SECRET,
    ),
  );
  private readonly unrestrictedPrincipalFingerprint = this.sessionSecret
    ? principalFingerprint('unrestricted', this.sessionSecret)
    : UNRESTRICTED_PRINCIPAL_FINGERPRINT;
  private readonly failures = new Map<string, LoginFailureState>();
  private activePasswordVerifications = 0;
  private activePersonnelLoginRefreshes = 0;
  private readonly dummyEmployeeHash = `scrypt$${randomBytes(16).toString('base64')}$${randomBytes(32).toString('base64')}`;

  async login(
    request: AccessLoginRequest,
    source: string,
    now = Date.now(),
  ): Promise<AccessLoginResult> {
    if (request?.employeeName !== undefined && (typeof request.employeeName !== 'string' || normalizeAccessDisplayName(request.employeeName) !== request.employeeName || request.accountType !== undefined || request.purchaseBuilding !== undefined || typeof request.password !== 'string' || !request.password || request.password.length > 256)) throw invalidCredentials();
    let targets = this.resolveLoginTargets(request);
    if (!this.sessionSecret || targets.length === 0) {
      throw new ServiceUnavailableException('统一访问控制尚未安全配置');
    }
    this.pruneFailures(now);

    const sourceKey = normalizeSource(source);
    const failureState = this.failures.get(sourceKey);
    if (!failureState && this.failures.size >= MAX_FAILURE_SOURCES) {
      throw tooManyLoginAttempts();
    }
    if (
      this.activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS
    ) {
      throw tooManyLoginAttempts();
    }

    if (request.employeeName !== undefined && this.configuration && this.personnelSync &&
      this.configuration.employeeTargets(request.employeeName).length === 0) {
      if (this.activePersonnelLoginRefreshes >= 2) throw tooManyLoginAttempts();
      this.activePersonnelLoginRefreshes += 1;
      try {
        let refreshFailed = false;
        await this.personnelSync.refreshForLogin().catch(() => { refreshFailed = true; });
        if (refreshFailed && this.configuration.employeeTargets(request.employeeName).length === 0) {
          throw new ServiceUnavailableException('人员登录资料正在同步或暂时不可用，请稍后重试');
        }
        targets = this.resolveLoginTargets(request);
      } finally {
        this.activePersonnelLoginRefreshes -= 1;
      }
    }
    if (this.activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) throw tooManyLoginAttempts();
    this.activePasswordVerifications += 1;
    try {
      let matchedTarget: LoginTarget | null = null;
      let matchCount = 0;
      for (const target of targets) {
        const matches = await verifyAccessPassword(
          request.password,
          target.hash,
        );
        if (matches) {
          matchCount += 1;
          if (!matchedTarget) matchedTarget = target;
        }
      }

      if (matchCount > 1) {
        throw new ServiceUnavailableException('访问密码配置重复，请运行密码重置脚本');
      }

      if (!matchedTarget) {
        this.recordFailure(sourceKey, now);
        throw new UnauthorizedException('登录凭据无效');
      }

      this.failures.delete(sourceKey);
      return this.issueSession(matchedTarget.principal, now);
    } finally {
      this.activePasswordVerifications -= 1;
    }
  }

  readSession(
    token: string | undefined,
    now = Date.now(),
  ): AccessSessionStatus {
    const payload = this.readPayload(token, now);
    if (!payload) return guestSession();
    return {
      principal: {
        role: payload.role,
        purchaseBuilding: payload.purchaseBuilding,
        ...(payload.buildings ? { buildings: [...payload.buildings] } : {}),
        ...(payload.specialties ? { specialties: payload.specialties } : {}),
        ...(payload.personalRules ? { personalRules: payload.personalRules } : {}),
        ...(payload.effectiveAuthorization ? { effectiveAuthorization: structuredClone(payload.effectiveAuthorization) } : {}),
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        ...sessionIdentity(payload),
        ...(payload.impersonation ? { impersonation: payload.impersonation } : {}),
      },
      expiresAt: payload.expiresAt,
    };
  }

  readSessionIdentity(
    token: string | undefined,
    now = Date.now(),
  ): AccessSessionIdentityStatus {
    const payload = this.readPayload(token, now);
    if (!payload) return { ...guestSession(), principalFingerprint: null };
    return {
      principal: {
        role: payload.role,
        purchaseBuilding: payload.purchaseBuilding,
        ...(payload.buildings ? { buildings: [...payload.buildings] } : {}),
        ...(payload.specialties ? { specialties: payload.specialties } : {}),
        ...(payload.personalRules ? { personalRules: payload.personalRules } : {}),
        ...(payload.effectiveAuthorization ? { effectiveAuthorization: structuredClone(payload.effectiveAuthorization) } : {}),
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        ...sessionIdentity(payload),
        ...(payload.impersonation ? { impersonation: payload.impersonation } : {}),
      },
      expiresAt: payload.expiresAt,
      principalFingerprint: this.fingerprintFor(payload.sessionFamilyId),
    };
  }

  readSessionIssuedAt(token: string | undefined, now = Date.now()): number | null {
    return this.readPayload(token, now)?.issuedAt ?? null;
  }

  renew(token: string | undefined, now = Date.now()): AccessLoginResult | null {
    const payload = this.readPayload(token, now);
    if (!payload) return null;
    if (payload.impersonationSession) {
      const session = this.readSessionIdentity(token, now);
      if (session.expiresAt === null) return null;
      return { token: token!, principal: session.principal, expiresAt: payload.expiresAt, principalFingerprint: this.fingerprintFor(payload.sessionFamilyId) };
    }
    return this.issueSession(
      { role: payload.role, purchaseBuilding: payload.purchaseBuilding,
        ...(payload.buildings ? { buildings: [...payload.buildings] } : {}),
        ...(payload.specialties ? { specialties: payload.specialties } : {}),
        ...(payload.personalRules ? { personalRules: payload.personalRules } : {}),
        ...(payload.effectiveAuthorization ? { effectiveAuthorization: structuredClone(payload.effectiveAuthorization) } : {}),
        ...(payload.displayName ? { displayName: payload.displayName } : {}), ...sessionIdentity(payload),
        ...(payload.feishuAppId ? { feishuAppId: payload.feishuAppId } : {}) },
      now,
      payload.sessionFamilyId,
    );
  }

  async startImpersonation(token: string | undefined, request: { accountId: string; clientMutationId: string }, now = Date.now()): Promise<AccessLoginResult> {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).sort().join(',') !== 'accountId,clientMutationId' ||
      typeof request.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(request.accountId) ||
      typeof request.clientMutationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(request.clientMutationId)) throw new BadRequestException('代登录请求格式不正确');
    const original = this.readPayload(token, now);
    if (original?.impersonationSession) {
      if (original.impersonationSession.clientMutationId === request.clientMutationId && original.accountId === request.accountId) return this.renew(token, now)!;
      throw new ForbiddenException('请先返回管理员身份，再选择其他账号');
    }
    const actor = this.configuration?.currentPrincipal(original?.accountId, original?.authorizationVersion);
    if (!this.accessControlEnabled || !original || !actor || actor.role !== 'admin') throw new ForbiddenException('只有已登录的系统管理员可以代登录');
    const target = this.configuration!.impersonationTarget(request.accountId);
    if (!target?.accountId || !target.authorizationVersion) throw new ForbiddenException('该账号当前不能登录，请核对账号和在职状态');
    const family = createHmac('sha256', this.sessionSecret!).update('vnet-impersonation-v1\0').update(JSON.stringify([original.sessionFamilyId, request.clientMutationId])).digest().subarray(0, 16).toString('base64url');
    if (this.configuration!.impersonationStopped(family)) throw new ForbiddenException('此次代登录已结束，请重新发起');
    const fingerprint = createHash('sha256').update(JSON.stringify([original.accountId, original.authorizationVersion, original.sessionFamilyId, target.accountId, target.authorizationVersion])).digest('hex');
    const times = await this.configuration!.recordImpersonation(actor, `${target.displayName || target.accountId}（${target.accountId}）`, family, 'start', fingerprint,
      { issuedAt: now, expiresAt: Math.min(now + IMPERSONATION_TTL_MS, original.expiresAt) });
    const payload: ImpersonationPayload = { version: 11, accountId: target.accountId, authorizationVersion: target.authorizationVersion,
      actorAccountId: original.accountId!, actorAuthorizationVersion: original.authorizationVersion!, actorSessionFamilyId: original.sessionFamilyId, actorExpiresAt: original.expiresAt,
      sessionFamilyId: family, ...times, actorName: actor.displayName || '管理员', targetName: target.displayName || target.accountId, clientMutationId: request.clientMutationId };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signed = `${encoded}.${sign(encoded, this.sessionSecret!)}`;
    const result = this.renew(signed, now);
    if (!result) throw new ForbiddenException('账号权限已变化或此次代登录已过期，请重新核对');
    return result;
  }

  async stopImpersonation(token: string | undefined, ownerToken: string | undefined, clientMutationId: string, now = Date.now()): Promise<AccessLoginResult> {
    if (typeof clientMutationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientMutationId)) throw new BadRequestException('代登录请求编号不正确');
    const payload = this.readImpersonationPayload(token, now), owner = this.readPayload(ownerToken, now);
    if (!payload || !this.impersonationReturnContext(token, ownerToken, now) || !owner) throw new UnauthorizedException('管理员会话已失效，请重新登录');
    const actor = this.configuration!.currentPrincipal(payload.actorAccountId, payload.actorAuthorizationVersion)!;
    const fingerprint = createHash('sha256').update(JSON.stringify([payload.actorAccountId, payload.actorAuthorizationVersion, payload.actorSessionFamilyId, payload.accountId, payload.authorizationVersion])).digest('hex');
    await this.configuration!.recordImpersonation(actor, `${payload.targetName}（${payload.accountId}）`, payload.sessionFamilyId, 'stop', fingerprint, { issuedAt: now, expiresAt: payload.actorExpiresAt });
    const currentActor = this.configuration!.currentPrincipal(payload.actorAccountId, payload.actorAuthorizationVersion);
    if (currentActor?.role !== 'admin') throw new UnauthorizedException('管理员权限已变化，请重新登录');
    return this.issueSession(currentActor, now, payload.actorSessionFamilyId, Math.min(payload.actorExpiresAt, owner.expiresAt));
  }

  impersonationReturnContext(token: string | undefined, ownerToken: string | undefined, now = Date.now()): AccessPrincipal['impersonation'] {
    const payload = this.readImpersonationPayload(token, now), owner = this.readPayload(ownerToken, now);
    if (!payload || !owner || owner.impersonationSession || owner.role !== 'admin' || owner.accountId !== payload.actorAccountId ||
      owner.authorizationVersion !== payload.actorAuthorizationVersion || owner.sessionFamilyId !== payload.actorSessionFamilyId || owner.expiresAt !== payload.actorExpiresAt) return undefined;
    return { actorAccountId: payload.actorAccountId, actorName: payload.actorName, targetName: payload.targetName, expiresAt: payload.expiresAt };
  }

  private readImpersonationPayload(token: string | undefined, now: number): ImpersonationPayload | undefined {
    const payload = this.readSignedPayload(token);
    if (!validImpersonationPayload(payload, now) || !this.accessControlEnabled || this.configuration?.currentPrincipal(payload.actorAccountId, payload.actorAuthorizationVersion)?.role !== 'admin') return undefined;
    return payload;
  }

  issueTrustedSession(
    principal: TrustedAccessPrincipal,
    now = Date.now(),
  ): AccessLoginResult {
    return this.issueSession(principal, now);
  }

  isConfigured(): boolean {
    return Boolean(this.sessionSecret);
  }

  isAccessControlEnabled(): boolean {
    return this.accessControlEnabled;
  }

  getUnrestrictedPrincipalFingerprint(): string {
    return this.unrestrictedPrincipalFingerprint;
  }

  configurationReadiness(): {
    core: boolean;
    inventory: boolean;
    purchase: boolean;
    construction: boolean;
  } {
    const sessionConfigured = Boolean(this.sessionSecret);
    if (this.configuration) {
      const targets = this.configuration.localTargets();
      const has = (role: string, building: string | null = null) => targets.some(target => (target.credentialRole || target.principal.role) === role && (target.credentialBuilding !== undefined ? target.credentialBuilding : target.principal.purchaseBuilding) === building);
      return { core: sessionConfigured && has('admin') && has('editor'), inventory: sessionConfigured && PURCHASE_ACCESS_BUILDINGS.every(building => has('inventory_admin', building)),
        purchase: sessionConfigured && has('purchase_admin') && PURCHASE_ACCESS_BUILDINGS.every(building => has('purchase_applicant', building)), construction: sessionConfigured && has('construction_admin') };
    }
    return {
      core:
        sessionConfigured &&
        Boolean(parsePasswordHash(this.adminPasswordHash)) &&
        Boolean(parsePasswordHash(this.editorPasswordHash)),
      inventory:
        sessionConfigured &&
        Object.values(this.inventoryAdminPasswordHashes).every((hash) =>
          Boolean(parsePasswordHash(hash)),
        ),
      purchase:
        sessionConfigured &&
        Boolean(parsePasswordHash(this.purchaseAdminPasswordHash)) &&
        Object.values(this.purchaseApplicantPasswordHashes).every((hash) =>
          Boolean(parsePasswordHash(hash)),
        ),
      construction:
        sessionConfigured &&
        Boolean(parsePasswordHash(this.constructionAdminPasswordHash)),
    };
  }

  private assertConfigured(selectedHash: string): void {
    if (!this.sessionSecret || !parsePasswordHash(selectedHash)) {
      throw new ServiceUnavailableException('统一访问控制尚未安全配置');
    }
  }

  private resolveLoginTargets(request: AccessLoginRequest): LoginTarget[] {
    if (request.employeeName !== undefined) {
      if (!this.configuration) throw invalidCredentials();
      const targets = this.configuration.employeeTargets(request.employeeName);
      return targets.length ? targets : [{ hash: this.dummyEmployeeHash, principal: { role: 'guest', purchaseBuilding: null } }];
    }
    if (this.configuration) {
      if (request?.accountType === undefined && request?.purchaseBuilding !== undefined) throw invalidCredentials();
      const targets = this.configuration.localTargets();
      return request?.accountType === undefined ? targets : targets.filter(target =>
        (target.credentialRole || target.principal.role) === request.accountType &&
        (request.purchaseBuilding ? target.credentialBuilding !== undefined
          ? target.credentialBuilding === request.purchaseBuilding : canAccessBuilding(target.principal, request.purchaseBuilding)
          : (target.credentialBuilding !== undefined ? target.credentialBuilding : target.principal.purchaseBuilding) === null));
    }
    if (request?.accountType === undefined) {
      if (request?.purchaseBuilding !== undefined) throw invalidCredentials();
      return [
        {
          hash: this.adminPasswordHash,
          principal: { role: 'admin', purchaseBuilding: null },
        },
        {
          hash: this.editorPasswordHash,
          principal: { role: 'editor', purchaseBuilding: null },
        },
        {
          hash: this.purchaseAdminPasswordHash,
          principal: { role: 'purchase_admin', purchaseBuilding: null },
        },
        {
          hash: this.constructionAdminPasswordHash,
          principal: { role: 'construction_admin', purchaseBuilding: null },
        },
        ...PURCHASE_ACCESS_BUILDINGS.flatMap((building) => [
          {
            hash: this.inventoryAdminPasswordHashes[building],
            principal: { role: 'inventory_admin' as const, purchaseBuilding: building },
          },
          {
            hash: this.purchaseApplicantPasswordHashes[building],
            principal: { role: 'purchase_applicant' as const, purchaseBuilding: building },
          },
        ]),
        ...BUILDING_ADMIN_BUILDINGS.map((building) => ({
          hash: this.buildingAdminPasswordHashes[building],
          principal: { role: 'building_admin' as const, purchaseBuilding: building },
        })),
      ].filter((target) => Boolean(parsePasswordHash(target.hash))) as LoginTarget[];
    }
    const target = this.resolveLoginTarget(request);
    this.assertConfigured(target.hash);
    return [target];
  }

  private resolveLoginTarget(request: AccessLoginRequest): LoginTarget {
    if (request?.accountType === 'building_admin') {
      const building = request.purchaseBuilding;
      if (!isBuildingAdminBuilding(building)) throw invalidCredentials();
      return {
        hash: this.buildingAdminPasswordHashes[building],
        principal: { role: 'building_admin', purchaseBuilding: building },
      };
    }
    if (request?.accountType === 'inventory_admin') {
      const building = request.purchaseBuilding;
      if (!isPurchaseAccessBuilding(building)) throw invalidCredentials();
      return {
        hash: this.inventoryAdminPasswordHashes[building],
        principal: { role: 'inventory_admin', purchaseBuilding: building },
      };
    }

    if (request?.accountType === 'purchase_applicant') {
      const building = request.purchaseBuilding;
      if (!isPurchaseAccessBuilding(building)) throw invalidCredentials();
      return {
        hash: this.purchaseApplicantPasswordHashes[building],
        principal: {
          role: 'purchase_applicant',
          purchaseBuilding: building,
        },
      };
    }

    if (request?.purchaseBuilding !== undefined) throw invalidCredentials();
    if (request?.accountType === 'admin') {
      return {
        hash: this.adminPasswordHash,
        principal: { role: 'admin', purchaseBuilding: null },
      };
    }
    if (request?.accountType === 'editor') {
      return {
        hash: this.editorPasswordHash,
        principal: { role: 'editor', purchaseBuilding: null },
      };
    }
    if (request?.accountType === 'purchase_admin') {
      return {
        hash: this.purchaseAdminPasswordHash,
        principal: { role: 'purchase_admin', purchaseBuilding: null },
      };
    }
    if (request?.accountType === 'construction_admin') {
      return {
        hash: this.constructionAdminPasswordHash,
        principal: { role: 'construction_admin', purchaseBuilding: null },
      };
    }
    throw invalidCredentials();
  }

  private issueSession(
    principal: AccessPrincipal & { feishuAppId?: string },
    issuedAt: number,
    sessionFamilyId = randomBytes(16).toString('base64url'),
    expiresAt = issuedAt + ACCESS_SESSION_TTL_MS,
  ): AccessLoginResult {
    if (principal.impersonation) throw new UnauthorizedException('代登录会话不能转换为普通会话');
    if (!isValidPrivilegedPrincipal(principal) && !isValidFeishuGuestPrincipal(principal) && !isValidManagedGuestPrincipal(principal)) {
      throw new UnauthorizedException('访问身份无效');
    }
    if (!this.sessionSecret) {
      throw new ServiceUnavailableException('统一访问控制尚未安全配置');
    }
    if (principal.role === 'site_member' && !this.configuration) throw invalidCredentials();
    const sessionPrincipal: AccessPrincipal = {
      role: principal.role,
      purchaseBuilding: principal.purchaseBuilding,
      ...(principal.buildings ? { buildings: [...principal.buildings] } : {}),
      ...(principal.specialties ? { specialties: [...principal.specialties] } : {}),
      ...(principal.personalRules ? { personalRules: structuredClone(principal.personalRules) } : {}),
      ...(principal.effectiveAuthorization ? { effectiveAuthorization: structuredClone(principal.effectiveAuthorization) } : {}),
      ...(principal.displayName ? { displayName: principal.displayName } : {}),
      ...sessionIdentity(principal),
      ...(isValidFeishuGuestPrincipal(principal) && principal.accountId ? { accountId: principal.accountId } : {}),
    };
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > ACCESS_SESSION_TTL_MS) throw invalidCredentials();
    if (!SESSION_FAMILY_ID_PATTERN.test(sessionFamilyId)) {
      throw new UnauthorizedException('访问会话身份无效');
    }
    const commonPayload = {
      issuedAt,
      expiresAt,
      sessionFamilyId,
    };
    let payload: AccessSessionPayload;
    if (isValidManagedGuestPrincipal(principal)) {
      if (!this.configuration?.validateSession(principal.accountId, principal.authorizationVersion, 'guest', null)) throw invalidCredentials();
      payload = { ...commonPayload, version: 9, role: 'guest', purchaseBuilding: null, accountId: principal.accountId, authorizationVersion: principal.authorizationVersion, displayName: principal.displayName };
    } else if (isValidFeishuGuestPrincipal(principal)) {
      if (this.configuration?.canUseFeishuGuestIdentity?.(principal.accountId,principal.feishuAppId) === false) throw invalidCredentials();
      payload = { ...commonPayload, version: 6, role: 'guest', purchaseBuilding: null, feishuAppId: principal.feishuAppId,
        ...(principal.accountId ? { accountId: principal.accountId } : {}),
        ...(sessionPrincipal.displayName ? { displayName: sessionPrincipal.displayName } : {}) };
    } else if (principal.role === 'professional_engineer') {
      if (!this.configuration?.validateSession(principal.accountId, principal.authorizationVersion, principal.role, principal.purchaseBuilding, principal.specialties, principal.buildings)) throw new UnauthorizedException('工程师授权已变化，请重新登录');
      payload = { ...commonPayload, version: 10, role: 'professional_engineer', purchaseBuilding: principal.purchaseBuilding, buildings: [...principal.buildings!], specialties: [...principal.specialties!], accountId: principal.accountId!, authorizationVersion: principal.authorizationVersion!, ...(principal.displayName ? { displayName: principal.displayName } : {}) };
    } else if (principal.role === 'professional_admin') {
      if (!principal.accountId || principal.authorizationVersion === undefined || !this.configuration ||
        !this.configuration.validateSession(principal.accountId, principal.authorizationVersion, principal.role, null, principal.specialties)) throw new UnauthorizedException('专业授权已变化，请重新登录');
      payload = { ...commonPayload, version: 7, role: 'professional_admin', purchaseBuilding: null,
        specialties: [...principal.specialties!], accountId: principal.accountId, authorizationVersion: principal.authorizationVersion,
        ...(principal.displayName ? { displayName: principal.displayName } : {}) };
    } else {
      const basePayload: AccessSessionPayloadV3 = { ...commonPayload, version: SESSION_VERSION,
        role: principal.role as PrivilegedAccessPrincipal['role'], purchaseBuilding: principal.purchaseBuilding };
      payload = sessionPrincipal.displayName
        ? { ...basePayload, version: 4, displayName: sessionPrincipal.displayName }
        : basePayload;
      if (sessionPrincipal.accountId && sessionPrincipal.authorizationVersion !== undefined) {
        if (this.configuration && !this.configuration.validateSession(sessionPrincipal.accountId, sessionPrincipal.authorizationVersion, principal.role, principal.purchaseBuilding, undefined, principal.buildings)) throw new UnauthorizedException('访问权限已变化，请重新登录');
        payload = { ...basePayload, version: 5, accountId: sessionPrincipal.accountId, authorizationVersion: sessionPrincipal.authorizationVersion,
          ...(sessionPrincipal.displayName ? { displayName: sessionPrincipal.displayName } : {}) };
      }
    }
    if (principal.buildings && principal.role !== 'professional_engineer') {
      if (!this.configuration || !principal.accountId || principal.authorizationVersion === undefined) throw new UnauthorizedException('楼栋授权需绑定账号');
      payload = { ...commonPayload, version: 8, role: principal.role as PrivilegedAccessPrincipal['role'], purchaseBuilding: principal.purchaseBuilding, buildings: [...principal.buildings], accountId: principal.accountId, authorizationVersion: principal.authorizationVersion, ...(principal.displayName ? { displayName: principal.displayName } : {}) };
    }
    const encodedPayload = Buffer.from(
      JSON.stringify(payload),
      'utf8',
    ).toString('base64url');
    const signature = sign(encodedPayload, this.sessionSecret);
    return {
      token: `${encodedPayload}.${signature}`,
      principal: sessionPrincipal,
      expiresAt,
      principalFingerprint: this.fingerprintFor(sessionFamilyId),
    };
  }

  private fingerprintFor(sessionFamilyId: string): string {
    if (!this.sessionSecret) {
      throw new ServiceUnavailableException('统一访问控制尚未安全配置');
    }
    return principalFingerprint(sessionFamilyId, this.sessionSecret);
  }

  private readSignedPayload(token: string | undefined): unknown {
    if (!this.sessionSecret || !token) return null;
    try {
      if (token.length > 4096) return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [encodedPayload, encodedSignature] = parts;
      const payloadBytes = decodeStrictBase64Url(encodedPayload);
      const actualSignature = decodeStrictBase64Url(encodedSignature);
      if (!payloadBytes || !actualSignature || actualSignature.length !== 32) {
        return null;
      }

      const expectedSignature = createHmac('sha256', this.sessionSecret)
        .update(encodedPayload)
        .digest();
      if (
        actualSignature.length !== expectedSignature.length ||
        !timingSafeEqual(actualSignature, expectedSignature)
      ) {
        return null;
      }

      return JSON.parse(payloadBytes.toString('utf8')) as unknown;
    } catch { return null; }
  }

  private readPayload(
    token: string | undefined,
    now: number,
  ): ResolvedAccessSessionPayload | null {
    try {
      const parsed = this.readSignedPayload(token);
      if (validImpersonationPayload(parsed, now)) {
        const target = this.configuration?.currentPrincipal(parsed.accountId, parsed.authorizationVersion);
        if (!this.accessControlEnabled || parsed.expiresAt <= now || !target || this.configuration?.impersonationStopped(parsed.sessionFamilyId) ||
          this.configuration?.currentPrincipal(parsed.actorAccountId, parsed.actorAuthorizationVersion)?.role !== 'admin') return null;
        return { ...target, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt, sessionFamilyId: parsed.sessionFamilyId,
          impersonationSession: parsed, impersonation: { actorAccountId: parsed.actorAccountId, actorName: parsed.actorName, targetName: parsed.targetName, expiresAt: parsed.expiresAt } };
      }
      if (!validSessionPayload(parsed, now)) return null;
      if (parsed.version === 6 && this.configuration?.canUseFeishuGuestIdentity?.(parsed.accountId,parsed.feishuAppId) === false) return null;
      if ((parsed.version === 7 || parsed.version === 8 || (parsed.version === 9 || parsed.version === 10) || parsed.role === 'site_member') && !this.configuration) return null;
      if (parsed.version !== 6 && this.configuration && !this.configuration.validateSession(parsed.version === 5 || parsed.version === 7 || parsed.version === 8 || (parsed.version === 9 || parsed.version === 10) ? parsed.accountId : undefined, parsed.version === 5 || parsed.version === 7 || parsed.version === 8 || (parsed.version === 9 || parsed.version === 10) ? parsed.authorizationVersion : undefined, parsed.role, parsed.purchaseBuilding, (parsed.version === 7 || parsed.version === 10) ? parsed.specialties : undefined, (parsed.version === 8 || parsed.version === 10) ? parsed.buildings : undefined)) return null;
      const canonicalPrincipal = this.configuration?.currentPrincipal?.('accountId' in parsed ? parsed.accountId : undefined, 'authorizationVersion' in parsed ? parsed.authorizationVersion : undefined);
      return {
        role: parsed.role,
        purchaseBuilding: parsed.purchaseBuilding,
        issuedAt: parsed.issuedAt,
        expiresAt: parsed.expiresAt,
        ...((parsed.version === 4 || parsed.version === 5 || parsed.version === 6 || parsed.version === 7 || parsed.version === 8 || (parsed.version === 9 || parsed.version === 10)) && parsed.displayName ? { displayName: parsed.displayName } : {}),
        ...(parsed.version === 5 || parsed.version === 7 || parsed.version === 8 || (parsed.version === 9 || parsed.version === 10) ? { accountId: parsed.accountId, authorizationVersion: parsed.authorizationVersion } : {}),
        ...((parsed.version === 8 || parsed.version === 10) ? { buildings: [...parsed.buildings] } : {}),
        ...((parsed.version === 7 || parsed.version === 10) ? { specialties: parsed.specialties } : {}),
        ...(canonicalPrincipal?.personalRules ? { personalRules: [...canonicalPrincipal.personalRules] } : {}),
        ...(canonicalPrincipal?.effectiveAuthorization ? { effectiveAuthorization: structuredClone(canonicalPrincipal.effectiveAuthorization) } : {}),
        ...(parsed.version === 6 ? { feishuAppId: parsed.feishuAppId, ...(parsed.accountId ? { accountId: parsed.accountId } : {}) } : {}),
        sessionFamilyId:
          parsed.version !== 2
            ? parsed.sessionFamilyId
            : deriveLegacySessionFamilyId(token!.split('.')[0], this.sessionSecret!),
      };
    } catch {
      return null;
    }
  }

  private recordFailure(source: string, now: number): void {
    const previous = this.failures.get(source);
    const withinWindow = Boolean(
      previous && now - previous.firstFailureAt < FAILURE_WINDOW_MS,
    );

    if (!previous && this.failures.size >= MAX_FAILURE_SOURCES) {
      throw tooManyLoginAttempts();
    }

    this.failures.set(source, {
      firstFailureAt: withinWindow && previous ? previous.firstFailureAt : now,
    });
  }

  private pruneFailures(now: number): void {
    for (const [source, state] of this.failures) {
      const expiresAt = state.firstFailureAt + FAILURE_WINDOW_MS;
      if (expiresAt <= now) this.failures.delete(source);
    }
  }
}

export function hashAccessPassword(password: string): string {
  const candidate = String(password || '');
  if (!candidate) throw new Error('访问密码不能为空');

  const salt = randomBytes(16);
  const derived = scryptSync(candidate, salt, 32);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyAccessPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (typeof encodedHash === 'string' && encodedHash.startsWith('pbkdf2_sha256$')) return verifyPersonnelPassword(password, encodedHash);
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;

  try {
    const actual = await deriveScrypt(String(password || ''), parsed.salt, 32);
    return timingSafeEqual(actual, parsed.derived);
  } catch {
    return false;
  }
}

function parsePasswordHash(value: string): ParsedPasswordHash | null {
  const parts = String(value || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;

  const salt = decodeStrictBase64(parts[1]);
  const derived = decodeStrictBase64(parts[2]);
  if (!salt || salt.length < 16 || !derived || derived.length !== 32) {
    return null;
  }
  return { salt, derived };
}

function selectSessionSecret(
  preferred: string | undefined,
  legacy: string | undefined,
): string {
  const primary = String(preferred || '').trim();
  return primary || String(legacy || '').trim();
}

function parseSessionSecret(value: string): Buffer | null {
  const secret = decodeStrictBase64(String(value || '').trim());
  return secret?.length === 32 ? secret : null;
}

function decodeStrictBase64(value: string): Buffer | null {
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value ? decoded : null;
  } catch {
    return null;
  }
}

function decodeStrictBase64Url(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
}

function validSessionPayload(
  value: unknown,
  now: number,
): value is AccessSessionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const isV2 =
    payload.version === 2 &&
    keys.length === 5 &&
    keys.join(',') === 'expiresAt,issuedAt,purchaseBuilding,role,version';
  const isV3 =
    payload.version === SESSION_VERSION &&
    keys.length === 6 &&
    keys.join(',') ===
      'expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,version' &&
    typeof payload.sessionFamilyId === 'string' &&
    SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  const isV4 =
    payload.version === 4 &&
    keys.length === 7 &&
    keys.join(',') === 'displayName,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,version' &&
    typeof payload.displayName === 'string' &&
    normalizeAccessDisplayName(payload.displayName) === payload.displayName &&
    typeof payload.sessionFamilyId === 'string' &&
    SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  const isV5 = payload.version === 5 &&
    keys.join(',') === (payload.displayName === undefined ? 'accountId,authorizationVersion,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,version' : 'accountId,authorizationVersion,displayName,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,version') &&
    typeof payload.accountId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(payload.accountId) && Number.isSafeInteger(payload.authorizationVersion) && Number(payload.authorizationVersion) >= 1 &&
    (payload.displayName === undefined || (typeof payload.displayName === 'string' && normalizeAccessDisplayName(payload.displayName) === payload.displayName)) &&
    typeof payload.sessionFamilyId === 'string' && SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  const isV6 = payload.version === 6 &&
    keys.join(',') === [...(payload.accountId === undefined ? [] : ['accountId']), ...(payload.displayName === undefined ? [] : ['displayName']), 'expiresAt', 'feishuAppId', 'issuedAt', 'purchaseBuilding', 'role', 'sessionFamilyId', 'version'].join(',') &&
    isValidFeishuGuestPrincipal(payload) &&
    typeof payload.sessionFamilyId === 'string' && SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  const isV7 = payload.version === 7 &&
    keys.join(',') === (payload.displayName === undefined ? 'accountId,authorizationVersion,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,specialties,version' : 'accountId,authorizationVersion,displayName,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,specialties,version') &&
    payload.role === 'professional_admin' && isValidPrivilegedPrincipal(payload) &&
    typeof payload.sessionFamilyId === 'string' && SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  const isV8 = payload.version === 8 &&
    keys.join(',') === (payload.displayName === undefined ? 'accountId,authorizationVersion,buildings,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,version' : 'accountId,authorizationVersion,buildings,displayName,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,version') &&
    Array.isArray(payload.buildings) && isValidPrivilegedPrincipal(payload) && typeof payload.accountId === 'string' && payload.authorizationVersion !== undefined &&
    typeof payload.sessionFamilyId === 'string' && SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  const isV9 = payload.version === 9 &&
    keys.join(',') === 'accountId,authorizationVersion,displayName,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,version' &&
    isValidManagedGuestPrincipal(payload) && typeof payload.sessionFamilyId === 'string' && SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  const isV10 = payload.version === 10 && payload.role === 'professional_engineer' &&
    keys.join(',') === (payload.displayName === undefined ? 'accountId,authorizationVersion,buildings,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,specialties,version' : 'accountId,authorizationVersion,buildings,displayName,expiresAt,issuedAt,purchaseBuilding,role,sessionFamilyId,specialties,version') &&
    isValidPrivilegedPrincipal(payload) && typeof payload.sessionFamilyId === 'string' && SESSION_FAMILY_ID_PATTERN.test(payload.sessionFamilyId);
  if (payload.role === 'professional_engineer' && !isV10) return false;
  if (!isV10 && !isV2 && !isV3 && !isV4 && !isV5 && !isV6 && !isV7 && !isV8 && !isV9) return false;
  if (payload.role === 'professional_admin' && !isV7) return false;
  if (payload.role === 'site_member' && !isV5) return false;

  if (
    (!isV6 && !isV9 && !validRoleBuildingPair(payload.role, payload.purchaseBuilding)) ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt)
  ) {
    return false;
  }

  const issuedAt = payload.issuedAt as number;
  const expiresAt = payload.expiresAt as number;
  return (
    issuedAt >= 0 &&
    issuedAt <= now &&
    expiresAt > now &&
    expiresAt - issuedAt <= ACCESS_SESSION_TTL_MS
  );
}

function deriveLegacySessionFamilyId(
  encodedPayload: string,
  secret: Buffer,
): string {
  return createHmac('sha256', secret)
    .update(LEGACY_SESSION_FAMILY_DOMAIN)
    .update(encodedPayload)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

function principalFingerprint(sessionFamilyId: string, secret: Buffer): string {
  return createHmac('sha256', secret)
    .update(PRINCIPAL_FINGERPRINT_DOMAIN)
    .update(sessionFamilyId)
    .digest('base64url');
}

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function validRoleBuildingPair(
  role: unknown,
  building: unknown,
): role is PrivilegedAccessPrincipal['role'] {
  if (role === 'professional_engineer') return isBuildingAdminBuilding(building);
  if (role === 'building_admin') return isBuildingAdminBuilding(building);
  if (role === 'inventory_admin' || role === 'purchase_applicant') {
    return isPurchaseAccessBuilding(building);
  }
  return (
    (role === 'site_member' ||
      role === 'admin' ||
      role === 'editor' ||
      role === 'purchase_admin' ||
      role === 'duty_editor' ||
      role === 'supply_chain_admin' ||
      role === 'professional_admin' ||
      role === 'construction_admin') &&
    building === null
  );
}

function isValidManagedGuestPrincipal(value: unknown): value is AccessPrincipal & { role: 'guest'; purchaseBuilding: null; accountId: string; authorizationVersion: number; displayName: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  return principal.role === 'guest' && principal.purchaseBuilding === null && principal.buildings === undefined && principal.specialties === undefined && principal.feishuAppId === undefined &&
    typeof principal.accountId === 'string' && /^(?:local-[A-Za-z0-9_-]{1,153}|feishu-[a-f0-9]{64})$/.test(principal.accountId) && Number.isSafeInteger(principal.authorizationVersion) && Number(principal.authorizationVersion) >= 1 &&
    typeof principal.displayName === 'string' && normalizeAccessDisplayName(principal.displayName) === principal.displayName;
}

function isValidPrivilegedPrincipal(
  value: unknown,
): value is PrivilegedAccessPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  return validRoleBuildingPair(principal.role, principal.purchaseBuilding) && validBuildingScope(String(principal.role), principal.purchaseBuilding, principal.buildings) &&
    (principal.role !== 'site_member' || (isSiteMemberSessionAccountId(principal.accountId) && principal.authorizationVersion !== undefined)) &&
    (['professional_admin', 'professional_engineer'].includes(String(principal.role)) ? professionalScopeIsValid(principal.specialties) && typeof principal.accountId === 'string' && /^(?:feishu-|local-external-)[a-f0-9]{64}$/.test(principal.accountId) && principal.authorizationVersion !== undefined && (principal.role !== 'professional_engineer' || Array.isArray(principal.buildings)) : principal.specialties === undefined) &&
    ((principal.accountId === undefined && principal.authorizationVersion === undefined) ||
      (typeof principal.accountId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(principal.accountId) && Number.isSafeInteger(principal.authorizationVersion) && Number(principal.authorizationVersion) >= 1)) &&
    (principal.displayName === undefined ||
      (typeof principal.displayName === 'string' &&
        normalizeAccessDisplayName(principal.displayName) === principal.displayName));
}

function sessionIdentity(value: Pick<AccessPrincipal, 'accountId' | 'authorizationVersion'>): Pick<AccessPrincipal, 'accountId' | 'authorizationVersion'> {
  if (value.accountId && value.authorizationVersion !== undefined) return { accountId: value.accountId, authorizationVersion: value.authorizationVersion };
  return value.accountId && /^feishu-[a-f0-9]{64}$/.test(value.accountId) ? { accountId: value.accountId } : {};
}

function isValidFeishuGuestPrincipal(value: unknown): value is FeishuGuestAccessPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  return principal.role === 'guest' && principal.purchaseBuilding === null &&
    typeof principal.feishuAppId === 'string' && /^cli_[A-Za-z0-9_-]{1,128}$/.test(principal.feishuAppId) &&
    principal.feishuAppId === process.env.FEISHU_APP_ID?.trim() &&
    (principal.accountId === undefined || (typeof principal.accountId === 'string' && /^feishu-[a-f0-9]{64}$/.test(principal.accountId))) && principal.authorizationVersion === undefined &&
    (principal.displayName === undefined || (typeof principal.displayName === 'string' && normalizeAccessDisplayName(principal.displayName) === principal.displayName));
}

function isPurchaseAccessBuilding(
  value: unknown,
): value is PurchaseAccessBuilding {
  return (PURCHASE_ACCESS_BUILDINGS as readonly unknown[]).includes(value);
}

function isBuildingAdminBuilding(value: unknown): value is BuildingAdminBuilding {
  return (BUILDING_ADMIN_BUILDINGS as readonly unknown[]).includes(value);
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function tooManyLoginAttempts(): HttpException {
  return new HttpException(
    '登录请求过多，请稍后再试',
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException('登录凭据无效');
}

function normalizeSource(value: string): string {
  return (
    String(value || 'unknown')
      .trim()
      .slice(0, MAX_SOURCE_LENGTH) || 'unknown'
  );
}

function guestSession(): AccessSessionStatus {
  return {
    principal: { role: 'guest', purchaseBuilding: null },
    expiresAt: null,
  };
}
