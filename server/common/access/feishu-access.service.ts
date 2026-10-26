import { Injectable, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { PrivilegedAccessPrincipal, TrustedAccessPrincipal } from '@shared/access-control.interface';
import { normalizeAccessDisplayName } from './access-display-name';
import { AccessConfigurationService } from './access-configuration.service';
import {
  BUILDING_ADMIN_BUILDINGS,
  PURCHASE_ACCESS_BUILDINGS,
} from '../../../shared/access-control.interface';
import {
  feishuIdentityFingerprint,
  resolveApprovedFeishuPrincipal,
} from './feishu-access-approved-grants';

const MAX_FEISHU_OPEN_ID_LENGTH = 128;
const FEISHU_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FEISHU_OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const FEISHU_AUTHORIZE_URL =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const FEISHU_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const FEISHU_USER_INFO_URL =
  'https://open.feishu.cn/open-apis/authen/v1/user_info';
const FEISHU_CALLBACK_PATH = '/api/access/feishu/callback';
const DEFAULT_RETURN_TO = '/monthly-schedule';
const FEISHU_HTTP_TIMEOUT_MS = 8000;
const RETURN_TO_VALIDATION_ORIGIN = 'https://return-to.invalid';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type FeishuAccessErrorCode =
  | 'configuration'
  | 'invalid_request'
  | 'upstream_unavailable'
  | 'upstream_rejected'
  | 'invalid_response'
  | 'identity_not_allowed'
  | 'identity_inactive';

const FEISHU_ACCESS_ERROR_MESSAGES: Readonly<
  Record<FeishuAccessErrorCode, string>
> = {
  configuration: 'Feishu OAuth configuration is invalid',
  invalid_request: 'Feishu OAuth request is invalid',
  upstream_unavailable: 'Feishu OAuth service is unavailable',
  upstream_rejected: 'Feishu OAuth request was rejected',
  invalid_response: 'Feishu OAuth response is invalid',
  identity_not_allowed: 'Feishu identity is not allowed',
  identity_inactive: 'Feishu identity is inactive',
};

export class FeishuAccessError extends Error {
  readonly code: FeishuAccessErrorCode;

  constructor(code: FeishuAccessErrorCode) {
    super(FEISHU_ACCESS_ERROR_MESSAGES[code]);
    this.name = 'FeishuAccessError';
    this.code = code;
  }
}

interface FeishuOAuthConfig {
  appId: string;
  appSecret: string;
  callbackUrl: string;
}

const FEISHU_ACCESS_ROLE_CONFIGS = [
  {
    environmentName: 'FEISHU_ACCESS_ADMIN_OPEN_IDS',
    role: 'admin',
  },
  {
    environmentName: 'FEISHU_ACCESS_EDITOR_OPEN_IDS',
    role: 'editor',
  },
  {
    environmentName: 'FEISHU_ACCESS_DUTY_EDITOR_OPEN_IDS',
    role: 'duty_editor',
  },
  {
    environmentName: 'FEISHU_ACCESS_SUPPLY_CHAIN_ADMIN_OPEN_IDS',
    role: 'supply_chain_admin',
  },
  {
    environmentName: 'FEISHU_ACCESS_CONSTRUCTION_ADMIN_OPEN_IDS',
    role: 'construction_admin',
  },
  {
    environmentName: 'FEISHU_ACCESS_PURCHASE_ADMIN_OPEN_IDS',
    role: 'purchase_admin',
  },
  ...BUILDING_ADMIN_BUILDINGS.map((purchaseBuilding) => ({
    environmentName: `FEISHU_ACCESS_BUILDING_ADMIN_${purchaseBuilding === '110站' ? '110' : purchaseBuilding[0]}_OPEN_IDS`,
    role: 'building_admin' as const,
    purchaseBuilding,
  })),
  ...PURCHASE_ACCESS_BUILDINGS.map((purchaseBuilding) => ({
    environmentName: `FEISHU_ACCESS_INVENTORY_ADMIN_${purchaseBuilding[0]}_OPEN_IDS`,
    role: 'inventory_admin' as const,
    purchaseBuilding,
  })),
] as const satisfies ReadonlyArray<{
  environmentName: string;
  role: PrivilegedAccessPrincipal['role'];
  purchaseBuilding?: PrivilegedAccessPrincipal['purchaseBuilding'];
}>;

@Injectable()
export class FeishuAccessService {
  private readonly principalsByOpenId: ReadonlyMap<
    string,
    PrivilegedAccessPrincipal
  >;
  private readonly approvedAppId: string;
  private readonly approvedGrantsEnabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @Optional() private readonly configuration?: AccessConfigurationService,
  ) {
    this.approvedAppId =
      readNonEmptyString(configService.get<unknown>('FEISHU_APP_ID')) || '';
    const enabled = configService.get<unknown>(
      'FEISHU_ACCESS_APPROVED_GRANTS_ENABLED',
    );
    if (
      enabled !== undefined &&
      enabled !== null &&
      (typeof enabled !== 'string' ||
        !['', 'true', 'false'].includes(enabled.trim()))
    ) {
      throw new Error('FEISHU_ACCESS_APPROVED_GRANTS_ENABLED 配置类型错误');
    }
    this.approvedGrantsEnabled = String(enabled ?? '').trim() !== 'false';
    const mappings = new Map(readPrincipalMappings(this.configService));
    for (const [openId, principal] of mappings) {
      const approved = this.resolveApprovedPrincipal(openId);
      if (
        approved &&
        (approved.role !== principal.role ||
          approved.purchaseBuilding !== principal.purchaseBuilding)
      ) {
        if (!isApprovedLegacyRoleTransition(principal, approved)) {
          throw new Error('飞书访问角色配置存在跨角色冲突');
        }
        mappings.set(openId, approved);
      }
    }
    this.principalsByOpenId = mappings;
  }

  resolvePrincipal(openId: string): TrustedAccessPrincipal | null {
    const normalizedOpenId = normalizeOpenId(openId);
    if (!normalizedOpenId) return null;
    if (this.configuration) return this.configuration.feishuPrincipal(normalizedOpenId, this.approvedAppId);

    const principal =
      this.principalsByOpenId.get(normalizedOpenId) ??
      this.resolveApprovedPrincipal(normalizedOpenId);
    return principal ? { ...principal } : null;
  }

  private resolveApprovedPrincipal(
    openId: string,
  ): PrivilegedAccessPrincipal | null {
    return this.approvedGrantsEnabled
      ? resolveApprovedFeishuPrincipal(
          this.approvedAppId,
          feishuIdentityFingerprint(this.approvedAppId, openId),
        )
      : null;
  }

  buildAuthorizationUrl(state: string): string {
    const normalizedState = normalizeOAuthState(state);
    if (!normalizedState) {
      throw new FeishuAccessError('invalid_request');
    }

    const config = this.getOAuthConfig();
    const authorizationUrl = new URL(FEISHU_AUTHORIZE_URL);
    authorizationUrl.searchParams.set('client_id', config.appId);
    authorizationUrl.searchParams.set('redirect_uri', config.callbackUrl);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('state', normalizedState);
    return authorizationUrl.toString();
  }

  getCallbackUrl(): string {
    return this.getOAuthConfig().callbackUrl;
  }

  sanitizeReturnTo(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return DEFAULT_RETURN_TO;
    if (!value.startsWith('/') || value.startsWith('//')) {
      return DEFAULT_RETURN_TO;
    }
    if (
      value.includes('\\') ||
      CONTROL_CHARACTER_PATTERN.test(value) ||
      !isSafeEncodedPath(readRawRelativePath(value))
    ) {
      return DEFAULT_RETURN_TO;
    }

    try {
      const returnToUrl = new URL(value, RETURN_TO_VALIDATION_ORIGIN);
      if (
        returnToUrl.origin !== RETURN_TO_VALIDATION_ORIGIN ||
        returnToUrl.pathname.startsWith('//') ||
        !isSafeEncodedPath(returnToUrl.pathname)
      ) {
        return DEFAULT_RETURN_TO;
      }
      return `${returnToUrl.pathname}${returnToUrl.search}${returnToUrl.hash}`;
    } catch {
      return DEFAULT_RETURN_TO;
    }
  }

  async exchangeAuthorizationCode(
    code: string,
  ): Promise<TrustedAccessPrincipal> {
    try {
      const normalizedCode = normalizeAuthorizationCode(code);
      if (!normalizedCode) {
        throw new FeishuAccessError('invalid_request');
      }

      const config = this.getOAuthConfig();
      const accessToken = await this.exchangeAccessToken(
        normalizedCode,
        config,
      );
      const { openId, displayName } = await this.fetchUserIdentity(accessToken);
      if (this.configuration?.canUseFeishuGuestIdentity?.(`feishu-${feishuIdentityFingerprint(config.appId,openId)}`,config.appId) === false) throw new FeishuAccessError('identity_inactive');
      const principal: TrustedAccessPrincipal = this.resolvePrincipal(openId) ?? {
        role: 'guest', purchaseBuilding: null, feishuAppId: config.appId, accountId: `feishu-${feishuIdentityFingerprint(config.appId, openId)}`,
      };
      const loginName = principal.role === 'site_member' && principal.displayName ? principal.displayName : displayName;
      return loginName ? { ...principal, displayName: loginName } : principal;
    } catch (error) {
      if (error instanceof FeishuAccessError) throw error;
      throw new FeishuAccessError('upstream_unavailable');
    }
  }

  private getOAuthConfig(): FeishuOAuthConfig {
    try {
      const appId = readRequiredOAuthString(
        this.configService,
        'FEISHU_APP_ID',
      );
      const appSecret = readRequiredOAuthString(
        this.configService,
        'FEISHU_APP_SECRET',
      );
      const publicBaseUrl = readRequiredOAuthString(
        this.configService,
        'PUBLIC_BASE_URL',
      );
      const clientBasePath = readOptionalOAuthString(
        this.configService,
        'CLIENT_BASE_PATH',
      );

      return {
        appId,
        appSecret,
        callbackUrl: buildCallbackUrl(publicBaseUrl, clientBasePath),
      };
    } catch (error) {
      if (error instanceof FeishuAccessError) throw error;
      throw new FeishuAccessError('configuration');
    }
  }

  private async exchangeAccessToken(
    code: string,
    config: FeishuOAuthConfig,
  ): Promise<string> {
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.post(
        FEISHU_TOKEN_URL,
        {
          grant_type: 'authorization_code',
          client_id: config.appId,
          client_secret: config.appSecret,
          code,
          redirect_uri: config.callbackUrl,
        },
        {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          timeout: FEISHU_HTTP_TIMEOUT_MS,
          maxRedirects: 0,
        },
      );
    } catch (error) {
      throw classifyHttpFailure(error);
    }

    const body = asRecord(response?.data);
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'code')) {
      throw new FeishuAccessError('invalid_response');
    }
    if (!isSuccessfulFeishuCode(body.code)) {
      throw new FeishuAccessError('upstream_rejected');
    }

    const accessToken = readNonEmptyString(body.access_token);
    if (!accessToken) {
      throw new FeishuAccessError('invalid_response');
    }
    return accessToken;
  }

  private async fetchUserIdentity(accessToken: string): Promise<{
    openId: string;
    displayName?: string;
  }> {
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.get(FEISHU_USER_INFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: FEISHU_HTTP_TIMEOUT_MS,
        maxRedirects: 0,
      });
    } catch (error) {
      throw classifyHttpFailure(error);
    }

    const body = asRecord(response?.data);
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'code')) {
      throw new FeishuAccessError('invalid_response');
    }
    if (!isSuccessfulFeishuCode(body.code)) {
      throw new FeishuAccessError('upstream_rejected');
    }

    const userData = asRecord(body.data);
    const openId = userData?.open_id;
    if (typeof openId !== 'string' || !isValidFeishuOpenId(openId)) {
      throw new FeishuAccessError('invalid_response');
    }
    return { openId, displayName: normalizeAccessDisplayName(userData?.name) };
  }
}

function normalizeOAuthState(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return FEISHU_OAUTH_STATE_PATTERN.test(normalized) ? normalized : null;
}

function normalizeAuthorizationCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function readRequiredOAuthString(
  configService: ConfigService,
  environmentName: string,
): string {
  const value = configService.get<unknown>(environmentName);
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new FeishuAccessError('configuration');
  }
  return value.trim();
}

function readOptionalOAuthString(
  configService: ConfigService,
  environmentName: string,
): string {
  const value = configService.get<unknown>(environmentName);
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new FeishuAccessError('configuration');
  }
  return value.trim();
}

function buildCallbackUrl(
  publicBaseUrl: string,
  clientBasePath: string,
): string {
  if (
    !/^https?:\/\//i.test(publicBaseUrl) ||
    publicBaseUrl.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(publicBaseUrl)
  ) {
    throw new FeishuAccessError('configuration');
  }

  const rawPublicPath = readRawAbsolutePath(publicBaseUrl);
  if (rawPublicPath === null || !isSafeEncodedPath(rawPublicPath)) {
    throw new FeishuAccessError('configuration');
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(publicBaseUrl);
  } catch {
    throw new FeishuAccessError('configuration');
  }

  if (
    (parsedBaseUrl.protocol !== 'http:' &&
      parsedBaseUrl.protocol !== 'https:') ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash
  ) {
    throw new FeishuAccessError('configuration');
  }

  if (!isSafeEncodedPath(parsedBaseUrl.pathname)) {
    throw new FeishuAccessError('configuration');
  }

  const normalizedClientBasePath = normalizeConfiguredBasePath(clientBasePath);
  if (normalizedClientBasePath === null) {
    throw new FeishuAccessError('configuration');
  }

  const publicPath = removeTrailingSlashes(parsedBaseUrl.pathname);
  const callbackUrl = new URL(parsedBaseUrl.origin);
  callbackUrl.pathname = `${publicPath}${normalizedClientBasePath}${FEISHU_CALLBACK_PATH}`;
  if (callbackUrl.origin !== parsedBaseUrl.origin) {
    throw new FeishuAccessError('configuration');
  }
  return callbackUrl.toString();
}

function normalizeConfiguredBasePath(value: string): string | null {
  if (!value) return '';
  if (
    value.includes('\\') ||
    /[\u0000-\u001f\u007f?#]/.test(value) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(value) ||
    value.startsWith('//') ||
    !isSafeEncodedPath(value)
  ) {
    return null;
  }
  const normalized = removeTrailingSlashes(value);
  if (!normalized || normalized === '/') return '';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function removeTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function readRawAbsolutePath(value: string): string | null {
  const schemeMatch = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.exec(value);
  if (!schemeMatch) return null;

  const authorityStart = schemeMatch[0].length;
  const pathStart = value.indexOf('/', authorityStart);
  if (pathStart < 0) return '';

  const queryStart = value.indexOf('?', pathStart);
  const hashStart = value.indexOf('#', pathStart);
  const pathEnd = [queryStart, hashStart]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), value.length);
  return value.slice(pathStart, pathEnd);
}

function readRawRelativePath(value: string): string {
  const queryStart = value.indexOf('?');
  const hashStart = value.indexOf('#');
  const pathEnd = [queryStart, hashStart]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), value.length);
  return value.slice(0, pathEnd);
}

function isSafeEncodedPath(value: string): boolean {
  if (CONTROL_CHARACTER_PATTERN.test(value) || value.includes('\\')) {
    return false;
  }
  return value.split('/').every(isSafeEncodedPathSegment);
}

function isSafeEncodedPathSegment(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth <= 2; depth += 1) {
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      CONTROL_CHARACTER_PATTERN.test(decoded) ||
      hasInvalidPercentEncoding(decoded)
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

function hasInvalidPercentEncoding(value: string): boolean {
  for (
    let index = value.indexOf('%');
    index >= 0;
    index = value.indexOf('%', index + 1)
  ) {
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      return true;
    }
  }
  return false;
}

function isSuccessfulFeishuCode(value: unknown): boolean {
  return value === 0 || value === '0';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function classifyHttpFailure(error: unknown): FeishuAccessError {
  const errorRecord = asRecord(error);
  const response = asRecord(errorRecord?.response);
  const status = response?.status;
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  ) {
    return new FeishuAccessError('upstream_rejected');
  }
  return new FeishuAccessError('upstream_unavailable');
}

function readPrincipalMappings(
  configService: ConfigService,
): ReadonlyMap<string, PrivilegedAccessPrincipal> {
  const mappings = new Map<string, PrivilegedAccessPrincipal>();

  for (const config of FEISHU_ACCESS_ROLE_CONFIGS) {
    const openIds = readOpenIdList(configService, config.environmentName);
    for (const openId of openIds) {
      if (mappings.has(openId)) {
        throw new Error('飞书访问角色配置存在跨角色冲突');
      }
      mappings.set(openId, {
        role: config.role,
        purchaseBuilding:
          'purchaseBuilding' in config ? config.purchaseBuilding : null,
      });
    }
  }

  return mappings;
}

function isApprovedLegacyRoleTransition(
  previous: PrivilegedAccessPrincipal,
  approved: PrivilegedAccessPrincipal,
): boolean {
  if (previous.purchaseBuilding !== null || approved.purchaseBuilding !== null)
    return false;
  return (
    (previous.role === 'duty_editor' && approved.role === 'editor') ||
    (previous.role === 'supply_chain_admin' &&
      approved.role === 'purchase_admin')
  );
}

function readOpenIdList(
  configService: ConfigService,
  environmentName: string,
): string[] {
  const configured = configService.get<unknown>(environmentName);
  if (configured === undefined || configured === null) return [];
  if (typeof configured !== 'string') {
    throw new Error(`${environmentName} 配置类型错误`);
  }
  if (!configured.trim()) return [];

  const openIds = configured.split(',').map((value) => value.trim());
  if (openIds.some((openId) => !openId)) {
    throw new Error(`${environmentName} 配置包含空项`);
  }

  const uniqueOpenIds = new Set<string>();
  for (const openId of openIds) {
    if (!isValidFeishuOpenId(openId)) {
      throw new Error(`${environmentName} 配置包含格式错误的 open_id`);
    }
    if (uniqueOpenIds.has(openId)) {
      throw new Error(`${environmentName} 配置包含重复项`);
    }
    uniqueOpenIds.add(openId);
  }

  return [...uniqueOpenIds];
}

function normalizeOpenId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return isValidFeishuOpenId(normalized) ? normalized : null;
}

function isValidFeishuOpenId(value: string): boolean {
  return (
    value.length <= MAX_FEISHU_OPEN_ID_LENGTH &&
    FEISHU_OPEN_ID_PATTERN.test(value)
  );
}
