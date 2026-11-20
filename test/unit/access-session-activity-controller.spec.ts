import 'reflect-metadata';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AccessPrincipal, TrustedAccessPrincipal } from '../../shared/access-control.interface';
import { ACCESS_SESSION_ACTIVITY_PATH } from '../../shared/access-session-activity.interface';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { UnifiedAccessService, ACCESS_SESSION_TTL_MS } from '../../server/common/access/unified-access.service';
import { PublicAccessMetadataKey } from '../../server/common/access/unified-access.decorators';
import { FIRST_PARTY_ACCESS_COOKIE_NAME } from '../../server/common/access/unified-access.guard';

const DAY = 24 * 60 * 60 * 1000;
const BASE = 1_800_000_000_000;

describe('explicit same-identity session activity renewal', () => {
  let environment: NodeJS.ProcessEnv;
  let now: number;
  let service: UnifiedAccessService;
  let controller: UnifiedAccessController;
  let valid: boolean;
  let canonical: AccessPrincipal;

  beforeEach(() => {
    environment = { ...process.env };
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.PUBLIC_BASE_URL = 'https://synthetic.example.test:3001';
    process.env.FEISHU_APP_ID = 'cli_synthetic_activity';
    now = BASE;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    valid = true;
    canonical = { role: 'admin', purchaseBuilding: null, accountId: 'local-synthetic-admin', authorizationVersion: 3, displayName: '合成账号' };
    const configuration = {
      validateSession: jest.fn((id: string | undefined, version: number | undefined) => valid && id === canonical.accountId && version === canonical.authorizationVersion),
      currentPrincipal: jest.fn((id: string | undefined, version: number | undefined) => valid && id === canonical.accountId && version === canonical.authorizationVersion ? canonical : undefined),
      canUseFeishuGuestIdentity: jest.fn(() => valid),
      pagePermissions: jest.fn(() => ({ paths: ['/purchase-inventory-management'], revision: 1, configured: true })),
    };
    service = new UnifiedAccessService(configuration as never);
    controller = new UnifiedAccessController(service, {} as never);
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = environment; });

  const request = (token?: string, headers: Record<string, string> = {}) => ({
    protocol: 'https', secure: true, socket: {},
    get: () => 'synthetic.example.test:3001',
    headers: { origin: 'https://synthetic.example.test:3001', 'sec-fetch-site': 'same-origin',
      ...(token ? { cookie: `${FIRST_PARTY_ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}` } : {}), ...headers },
  }) as unknown as Request;
  const response = () => ({ setHeader: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() }) as unknown as Response;
  const signed = () => service.issueTrustedSession(canonical as TrustedAccessPrincipal, BASE);
  const call = (session = signed(), req = request(session.token), res = response()) => ({
    result: controller.renewSession({ principalFingerprint: session.principalFingerprint }, req, res), res,
  });

  it('exposes a public-access POST requiring the existing authenticated cookie, not a GET renewal', () => {
    const method = UnifiedAccessController.prototype.renewSession;
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('session/renew');
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PublicAccessMetadataKey, method)).toBe(true);
    expect(ACCESS_SESSION_ACTIVITY_PATH).toBe('/api/access/session/renew');
  });

  it('extends a verified session from actual activity by 24 hours and preserves identity and family', () => {
    expect(ACCESS_SESSION_TTL_MS).toBe(DAY);
    const previous = signed();
    now += 2 * 60 * 60 * 1000;
    const { result, res } = call(previous);
    expect(result).toMatchObject({ accountId: canonical.accountId, role: 'admin', expiresAt: now + DAY,
      principalFingerprint: previous.principalFingerprint });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    const cookies = (res.cookie as jest.Mock).mock.calls;
    expect(cookies.map(([name]) => name)).toEqual([service.cookieName, FIRST_PARTY_ACCESS_COOKIE_NAME]);
    expect(cookies[0][2]).toMatchObject({ httpOnly: true, secure: true, maxAge: DAY, expires: new Date(now + DAY) });
    expect(cookies[1][2]).toMatchObject({ httpOnly: true, secure: true, path: '/', maxAge: DAY });
    const renewedToken = cookies[0][1];
    expect(renewedToken).not.toBe(previous.token);
    expect(service.readSessionIdentity(renewedToken, now + DAY - 1)).toMatchObject({ expiresAt: now + DAY, principalFingerprint: previous.principalFingerprint });
    expect(service.readSessionIdentity(renewedToken, now + DAY).expiresAt).toBeNull();
    expect(service.readSessionIdentity(previous.token, BASE + DAY).expiresAt).toBeNull();
  });

  it('never extends the idle deadline during repeated GET session polling', () => {
    const previous = signed();
    const res = response();
    now += DAY - 1;
    expect(controller.session(request(previous.token), res).expiresAt).toBe(BASE + DAY);
    expect(res.cookie).not.toHaveBeenCalled();
    now += 1;
    expect(controller.session(request(previous.token), res).expiresAt).toBeNull();
  });

  it.each([DAY, DAY + 1])('does not revive a session at or after its expiry (%d)', elapsed => {
    const previous = signed(), res = response(); now += elapsed;
    expect(() => call(previous, request(previous.token), res)).toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('rejects a stale fingerprint after account switch without writing either cookie', () => {
    const old = signed(), current = signed(), res = response();
    expect(() => controller.renewSession({ principalFingerprint: old.principalFingerprint }, request(current.token), res)).toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('rechecks current authorization and cannot extend a revoked account', () => {
    const previous = signed(), res = response(); valid = false;
    expect(() => call(previous, request(previous.token), res)).toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('does not reuse a same-family token after authorization version changes', () => {
    const previous = signed(), res = response(); canonical = { ...canonical, authorizationVersion: 4 };
    expect(() => call(previous, request(previous.token), res)).toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it.each([undefined, 'invalid-signed-session'])('requires a valid authenticated cookie (%s)', token => {
    const previous = signed(), res = response();
    expect(() => call(previous, request(token), res)).toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('rejects anonymous Feishu guests without a managed account identity', () => {
    const previous = service.issueTrustedSession({ role: 'guest', purchaseBuilding: null, feishuAppId: 'cli_synthetic_activity' }, BASE), res = response();
    expect(() => call(previous, request(previous.token), res)).toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('permits an account-bound named guest without adding any privileges', () => {
    canonical = { ...canonical, role: 'guest' };
    const previous = signed(); now += 1000;
    expect(call(previous).result).toMatchObject({ role: 'guest', accountId: canonical.accountId, principalFingerprint: previous.principalFingerprint,
      capabilities: { canEdit: false, canDelete: false }, expiresAt: now + DAY });
  });

  it('refuses impersonation renewal and writes no cookie', () => {
    const previous = signed(), res = response();
    jest.spyOn(service, 'readSessionIdentity').mockReturnValue({ ...service.readSessionIdentity(previous.token), principal: { ...canonical,
      impersonation: { actorAccountId: 'synthetic-actor', actorName: '合成管理员', targetName: '合成目标', expiresAt: now + 15 * 60_000 } } });
    const renew = jest.spyOn(service, 'renew');
    expect(() => call(previous, request(previous.token), res)).toThrow(ForbiddenException);
    expect(renew).not.toHaveBeenCalled(); expect(res.cookie).not.toHaveBeenCalled();
  });

  it.each([{ origin: 'https://outside.example.test' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }])('requires a same-origin activity request: %j', headers => {
    const previous = signed(), res = response();
    expect(() => call(previous, request(previous.token, headers), res)).toThrow(ForbiddenException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { principalFingerprint: 'short' }, { principalFingerprint: 'a'.repeat(44) },
    { principalFingerprint: 123 }, { principalFingerprint: 'a'.repeat(43), accountId: 'spoofed' }])('rejects malformed or extra request fields: %j', body => {
    const previous = signed(), res = response();
    expect(() => controller.renewSession(body as never, request(previous.token), res)).toThrow(BadRequestException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('checks the renewed identity and response authorization before writing any cookie', () => {
    const previous = signed(), res = response();
    jest.spyOn(service, 'renew').mockReturnValue({ ...previous, principalFingerprint: 'a'.repeat(43) });
    expect(() => call(previous, request(previous.token), res)).toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('does not write a renewed cookie when final permission projection fails', () => {
    const previous = signed(), res = response();
    jest.spyOn(service, 'pagePermissions').mockImplementation(() => { throw new Error('synthetic local configuration read failure'); });
    expect(() => call(previous, request(previous.token), res)).toThrow('synthetic local configuration read failure');
    expect(res.cookie).not.toHaveBeenCalled();
  });
});
