import { personalPermissionPagePaths } from '../../../shared/business-permissions';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Optional,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AccessCapabilities,
  AccessLoginAccountType,
  AccessLoginRequest,
  AccessPrincipal,
  AccessRole,
  AccessSessionResponse,
  PurchaseAccessBuilding,
} from '@shared/access-control.interface';
import { BUILDING_ADMIN_BUILDINGS, PURCHASE_ACCESS_BUILDINGS } from '../../../shared/access-control.interface';
import { PublicAccess } from './unified-access.decorators';
import {
  FeishuAccessError,
  type FeishuAccessErrorCode,
  FeishuAccessService,
} from './feishu-access.service';
import {
  clearAccessCookie,
  readAccessCookie,
  readStrictCookie,
  writeAccessCookie,
} from './unified-access.guard';
import { normalizeAccessDisplayName } from './access-display-name';
import { UnifiedAccessService } from './unified-access.service';

import { AccessLoginNamesService } from './access-login-names.service';
import type { AccessLoginNamesResponse } from '../../../shared/access-login-names.interface';

const LEGACY_PURCHASE_COOKIE_NAME = 'purchase_application_user_session';
const FEISHU_STATE_COOKIE_NAME = 'vnet_feishu_oauth_state';
const FEISHU_RETURN_TO_COOKIE_NAME = 'vnet_feishu_oauth_return_to';
const FEISHU_OAUTH_COOKIE_TTL_MS = 5 * 60 * 1000;

@Controller('api/access')
export class UnifiedAccessController {
  constructor(
    private readonly access: UnifiedAccessService,
    private readonly feishu: FeishuAccessService,
    @Optional() private readonly loginNames?: AccessLoginNamesService,
  ) {}

  @PublicAccess()
  @Get('login-names')
  async names(@Res({ passthrough: true }) response: Response): Promise<AccessLoginNamesResponse> {
    response.setHeader('Cache-Control', 'private, no-store');
    return (this.loginNames || new AccessLoginNamesService()).read();
  }

  @PublicAccess()
  @Get('runtime')
  runtime(@Res({ passthrough: true }) response: Response): {
    schemaVersion: number;
    supportsInventoryAdministrator: boolean;
    accessControlEnabled: boolean;
    deploymentId: string | null;
    configuration: {
      core: boolean;
      inventory: boolean;
      purchase: boolean;
      construction: boolean;
    };
  } {
    response.setHeader('Cache-Control', 'no-store');
    return {
      schemaVersion: 3,
      supportsInventoryAdministrator: true,
      accessControlEnabled: this.access.isAccessControlEnabled(),
      deploymentId: runtimeDeploymentId(),
      configuration: this.access.configurationReadiness(),
    };
  }

  @PublicAccess()
  @Post('login')
  async login(
    @Body() body: AccessLoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccessSessionResponse> {
    clearLegacyPurchaseCookie(response, request);
    const employeeName = body?.employeeName;
    if (employeeName !== undefined && (typeof employeeName !== 'string' || normalizeAccessDisplayName(employeeName) !== employeeName || body.accountType !== undefined || body.purchaseBuilding !== undefined)) throw new BadRequestException('请输入有效的姓名和密码');
    const accountType = body?.accountType;
    const purchaseBuilding = body?.purchaseBuilding;
    const password = body?.password;
    const isUnifiedPasswordLogin =
      accountType === undefined && purchaseBuilding === undefined;
    if (
      (!isUnifiedPasswordLogin && !isLoginAccountType(accountType)) ||
      typeof password !== 'string' ||
      password.length < 1 ||
      password.length > 256 ||
      (accountType === 'purchase_applicant' || accountType === 'inventory_admin' || accountType === 'building_admin'
        ? !(accountType === 'building_admin' ? isBuildingAdminBuilding(purchaseBuilding) : isPurchaseAccessBuilding(purchaseBuilding))
        : purchaseBuilding !== undefined)
    ) {
      throw new BadRequestException('请输入有效的访问密码');
    }

    const now = Date.now();
    const source = request.ip || request.socket?.remoteAddress || 'unknown';
    const loginRequest: AccessLoginRequest = {
      password,
      ...(employeeName !== undefined ? { employeeName } : {}),
      ...(accountType === undefined ? {} : { accountType }),
      ...(accountType === 'purchase_applicant' ||
      accountType === 'inventory_admin' || accountType === 'building_admin'
        ? { purchaseBuilding: purchaseBuilding as AccessLoginRequest['purchaseBuilding'] }
        : {}),
    };
    const result = await this.access.login(loginRequest, source);
    writeAccessCookie(response, request, this.access.cookieName, result, now);
    return this.toSessionResponse(
      result.principal,
      result.expiresAt,
      result.principalFingerprint,
    );
  }

  private toSessionResponse(principal: AccessPrincipal, expiresAt: number | null, fingerprint: string | null): AccessSessionResponse {
    const permissions = this.access.pagePermissions?.(principal.role,principal.accountId,principal.authorizationVersion);
    return { ...toSessionResponse(principal, expiresAt, fingerprint), ...(permissions ? { pagePaths: personalPermissionPagePaths(principal, permissions.paths), pagePermissionsRevision: permissions.revision } : {}) };
  }
  @PublicAccess()
  @Get('session')
  session(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): AccessSessionResponse {
    response.setHeader('Cache-Control', 'private, no-store');
    clearLegacyPurchaseCookie(response, request);
    if (!this.access.isAccessControlEnabled()) {
      response.setHeader('X-Access-Session-Cookie', 'disabled');
      return this.toSessionResponse(
        unrestrictedPrincipal(),
        null,
        this.access.getUnrestrictedPrincipalFingerprint(),
      );
    }
    const now = Date.now();
    const cookie = readAccessCookie(
      request.headers?.cookie,
      this.access,
      now,
    );
    // Session reads must not rotate the cookie: an older response could arrive
    // after logout or an account switch and restore the previous privileges.
    const result = this.access.readSessionIdentity(cookie.value, now);
    response.setHeader(
      'X-Access-Session-Cookie',
      cookie.diagnostic ?? (!cookie.present ? 'absent'
          : !cookie.value ? 'malformed'
            : result.expiresAt !== null && result.principalFingerprint !== null ? 'valid'
              : 'rejected'),
    );
    return this.toSessionResponse(
      result.principal,
      result.expiresAt,
      result.principalFingerprint,
    );
  }

  @PublicAccess()
  @Post('logout')
  logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): AccessSessionResponse {
    clearAccessCookie(response, request, this.access.cookieName);
    clearLegacyPurchaseCookie(response, request);
    if (!this.access.isAccessControlEnabled()) {
      return this.toSessionResponse(
        unrestrictedPrincipal(),
        null,
        this.access.getUnrestrictedPrincipalFingerprint(),
      );
    }
    return this.toSessionResponse(guestPrincipal(), null, null);
  }

  @PublicAccess()
  @Get('feishu/authorize')
  feishuAuthorize(
    @Query('returnTo') returnTo: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): void {
    response.setHeader('Cache-Control', 'no-store');
    const safeReturnTo = this.feishu.sanitizeReturnTo(returnTo);
    try {
      const state = randomBytes(32).toString('base64url');
      const authorizationUrl = this.feishu.buildAuthorizationUrl(state);
      const now = Date.now();
      const options = oauthCookieOptions(request, now);
      response.cookie(FEISHU_STATE_COOKIE_NAME, state, options);
      response.cookie(FEISHU_RETURN_TO_COOKIE_NAME, safeReturnTo, options);
      response.redirect(302, authorizationUrl);
    } catch (error) {
      clearAccessCookie(response, request, this.access.cookieName);
      clearOAuthCookies(response, request);
      response.redirect(
        302,
        withFeishuAuthStatus(
          safeReturnTo,
          error instanceof FeishuAccessError && error.code === 'configuration'
            ? 'configuration_error'
            : 'unavailable',
        ),
      );
    }
  }

  @PublicAccess()
  @Get('feishu/callback')
  async feishuCallback(
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const stateCookie = readStrictCookie(
      request.headers?.cookie,
      FEISHU_STATE_COOKIE_NAME,
    );
    const returnToCookie = readStrictCookie(
      request.headers?.cookie,
      FEISHU_RETURN_TO_COOKIE_NAME,
    );
    const safeReturnTo = this.feishu.sanitizeReturnTo(returnToCookie.value);
    clearOAuthCookies(response, request);

    const queryState = query?.state;
    if (
      typeof queryState !== 'string' ||
      !stateCookie.value ||
      !secureStringEquals(queryState, stateCookie.value)
    ) {
      this.rejectFeishuCallback(
        'state_invalid',
        safeReturnTo,
        request,
        response,
      );
      return;
    }

    const providerError = query?.error;
    if (providerError !== undefined) {
      this.rejectFeishuCallback(
        typeof providerError === 'string' && providerError.trim()
          ? 'cancelled'
          : 'code_invalid',
        safeReturnTo,
        request,
        response,
      );
      return;
    }

    const code = query?.code;
    if (typeof code !== 'string' || !code.trim()) {
      this.rejectFeishuCallback(
        'code_invalid',
        safeReturnTo,
        request,
        response,
      );
      return;
    }

    try {
      const principal = await this.feishu.exchangeAuthorizationCode(code);
      const now = Date.now();
      const session = this.access.issueTrustedSession(principal, now);
      writeAccessCookie(
        response,
        request,
        this.access.cookieName,
        session,
        now,
      );
      response.redirect(302, withFeishuAuthStatus(safeReturnTo, 'success'));
    } catch (error) {
      this.rejectFeishuCallback(
        mapFeishuCallbackError(error),
        safeReturnTo,
        request,
        response,
      );
    }
  }

  private rejectFeishuCallback(
    status: string,
    returnTo: string,
    request: Request,
    response: Response,
  ): void {
    clearAccessCookie(response, request, this.access.cookieName);
    response.redirect(302, withFeishuAuthStatus(returnTo, status));
  }
}

function oauthCookieOptions(request: Request, now: number) {
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    path: '/',
    secure: isSecureRequest(request),
    expires: new Date(now + FEISHU_OAUTH_COOKIE_TTL_MS),
    maxAge: FEISHU_OAUTH_COOKIE_TTL_MS,
  };
}

function clearOAuthCookies(response: Response, request: Request): void {
  const options = {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    path: '/',
    secure: isSecureRequest(request),
  };
  response.clearCookie(FEISHU_STATE_COOKIE_NAME, options);
  response.clearCookie(FEISHU_RETURN_TO_COOKIE_NAME, options);
}

function secureStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function mapFeishuCallbackError(error: unknown): string {
  if (!(error instanceof FeishuAccessError)) return 'unavailable';
  const statuses: Record<FeishuAccessErrorCode, string> = {
    configuration: 'configuration_error',
    invalid_request: 'code_invalid',
    upstream_unavailable: 'unavailable',
    upstream_rejected: 'rejected',
    invalid_response: 'invalid_response',
    identity_not_allowed: 'identity_not_allowed',
    identity_inactive: 'identity_inactive',
  };
  return statuses[error.code];
}

function withFeishuAuthStatus(returnTo: string, status: string): string {
  const url = new URL(returnTo, 'https://return-to.invalid');
  url.searchParams.set('feishu_auth', status);
  const clientBasePath = normalizeClientBasePathForRedirect(
    process.env.CLIENT_BASE_PATH,
  );
  const pathname =
    clientBasePath &&
    url.pathname !== clientBasePath &&
    !url.pathname.startsWith(`${clientBasePath}/`)
      ? `${clientBasePath}${url.pathname}`
      : url.pathname;
  return `${pathname}${url.search}${url.hash}`;
}

function normalizeClientBasePathForRedirect(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed === '/') return '';
  if (
    trimmed.includes('\\') ||
    /[\u0000-\u001f\u007f?#]/.test(trimmed) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed) ||
    trimmed.startsWith('//')
  ) {
    return '';
  }

  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
  return normalized
    .split('/')
    .every((segment) => isSafeClientBasePathSegment(segment))
    ? normalized
    : '';
}

function isSafeClientBasePathSegment(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth <= 2; depth += 1) {
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      /%(?![0-9a-f]{2})/i.test(decoded)
    ) {
      return false;
    }
    if (depth === 2 || !decoded.includes('%')) return true;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
  }
  return true;
}

function runtimeDeploymentId(): string | null {
  const value = String(process.env.LOCAL_ACCESS_DEPLOYMENT_ID || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : null;
}

function toSessionResponse(
  principal: AccessPrincipal,
  expiresAt: number | null,
  principalFingerprint: string | null,
): AccessSessionResponse {
  return {
    ...principal,
    expiresAt,
    principalFingerprint,
    capabilities: capabilitiesForRole(principal.role),
  };
}

function capabilitiesForRole(role: AccessRole): AccessCapabilities {
  return {
    canEdit:
      role === 'professional_admin' ||
      role === 'professional_engineer' ||
      role === 'admin' ||
      role === 'editor' ||
      role === 'inventory_admin' ||
      role === 'building_admin' ||
      role === 'purchase_admin' ||
      role === 'duty_editor' ||
      role === 'supply_chain_admin' ||
      role === 'construction_admin',
    canDelete:
      role === 'professional_admin' ||
      role === 'professional_engineer' ||
      role === 'admin' ||
      role === 'building_admin' ||
      role === 'purchase_admin' ||
      role === 'supply_chain_admin' ||
      role === 'construction_admin',
    canForceRefresh: role !== 'guest' && role !== 'site_member',
    canAccessContracts:
      role === 'professional_admin' ||
      role === 'professional_engineer' ||
      role === 'admin' ||
      role === 'purchase_admin' ||
      role === 'supply_chain_admin',
  };
}

function isLoginAccountType(value: unknown): value is AccessLoginAccountType {
  return (
    value === 'admin' ||
    value === 'editor' ||
    value === 'inventory_admin' ||
    value === 'building_admin' ||
    value === 'purchase_admin' ||
    value === 'purchase_applicant' ||
    value === 'construction_admin'
  );
}

function isPurchaseAccessBuilding(
  value: unknown,
): value is PurchaseAccessBuilding {
  return (PURCHASE_ACCESS_BUILDINGS as readonly unknown[]).includes(value);
}

function isBuildingAdminBuilding(value: unknown): boolean {
  return (BUILDING_ADMIN_BUILDINGS as readonly unknown[]).includes(value);
}

function guestPrincipal(): AccessPrincipal {
  return { role: 'guest', purchaseBuilding: null };
}

function unrestrictedPrincipal(): AccessPrincipal {
  return { role: 'admin', purchaseBuilding: null };
}

function clearLegacyPurchaseCookie(response: Response, request: Request): void {
  response.clearCookie(LEGACY_PURCHASE_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: isSecureRequest(request),
    maxAge: 0,
  });
}

function isSecureRequest(request: Request): boolean {
  if (
    request.secure ||
    request.protocol === 'https' ||
    Boolean((request.socket as { encrypted?: boolean } | undefined)?.encrypted)
  ) {
    return true;
  }
  if (environmentFlag('LOCAL_ACCESS_COOKIE_SECURE')) return true;
  if (!environmentFlag('LOCAL_ACCESS_TRUST_PROXY')) return false;
  const forwarded = request.headers?.['x-forwarded-proto'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (
    String(first || '')
      .split(',')[0]
      .trim()
      .toLowerCase() === 'https'
  );
}

function environmentFlag(name: string): boolean {
  return (
    String(process.env[name] || '')
      .trim()
      .toLowerCase() === 'true'
  );
}
