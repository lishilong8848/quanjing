import { Reflector } from '@nestjs/core';
import { createHmac } from 'node:crypto';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { UnifiedAccessService, ACCESS_SESSION_TTL_MS } from '../../server/common/access/unified-access.service';
import { AccessConfigurationController } from '../../server/common/access/access-configuration.controller';
import { TodayOperationsFollowUpController } from '../../server/modules/bitable-sync/today-operations-follow-up.controller';
import {
  FIRST_PARTY_ACCESS_COOKIE_NAME as FIRST,
  readAccessCookie, writeAccessCookie, clearAccessCookie, UnifiedAccessGuard,
} from '../../server/common/access/unified-access.guard';

describe('first-party access cookie compatibility', () => {
  const saved = { ...process.env };
  const now = 1_793_000_000_000;
  let access: UnifiedAccessService;
  beforeEach(() => {
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 17).toString('base64');
    process.env.FEISHU_APP_ID = 'cli_synthetic_first_party';
    delete process.env.LOCAL_ACCESS_COOKIE_SECURE;
    delete process.env.LOCAL_ACCESS_TRUST_PROXY;
    access = new UnifiedAccessService();
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });
  afterEach(() => { process.env = { ...saved }; jest.restoreAllMocks(); });

  function issue(role: 'admin' | 'editor' = 'editor', issuedAt = now - 1000) {
    return access.issueTrustedSession({ role, purchaseBuilding: null }, issuedAt);
  }
  function header(first?: string, legacy?: string) {
    return [first === undefined ? '' : `${FIRST}=${first}`,
      legacy === undefined ? '' : `${access.cookieName}=${legacy}`].filter(Boolean).join('; ');
  }
  function read(cookie: string) {
    const response = { setHeader: jest.fn(), clearCookie: jest.fn(), cookie: jest.fn() };
    const result = new UnifiedAccessController(access, {} as never).session(
      { headers: { cookie }, secure: true, socket: {} } as never, response as never,
    );
    expect(response.cookie).not.toHaveBeenCalled();
    return { result, diagnostic: response.setHeader.mock.calls.find(([name]) => name === 'X-Access-Session-Cookie')?.[1] };
  }

  it('writes one signed token with the same expiry to both HTTPS storage forms', () => {
    const signed = issue();
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    writeAccessCookie(response as never, { secure: true } as never, access.cookieName, signed, now);
    expect(response.cookie).toHaveBeenCalledTimes(2);
    expect(response.cookie).toHaveBeenCalledWith(FIRST, signed.token, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      expires: new Date(signed.expiresAt), maxAge: signed.expiresAt - now,
    });
    expect(response.cookie).toHaveBeenCalledWith(access.cookieName, signed.token,
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'none', partitioned: true }));
  });

  it.each(['first-party', 'legacy iframe', 'both'])('accepts %s storage without changing identity', mode => {
    const signed = issue();
    const result = read(header(mode === 'legacy iframe' ? undefined : signed.token,
      mode === 'first-party' ? undefined : signed.token));
    expect(result.result).toMatchObject({ role: 'editor', principalFingerprint: signed.principalFingerprint });
    expect(result.diagnostic).toBe('valid');
  });

  it.each(['', '%E0%A4%A', '"bad"', 'invalid.signature'])('never falls back from a broken first-party value %s', first => {
    const result = read(header(first, issue('admin').token));
    expect(result.result).toMatchObject({ role: 'guest', expiresAt: null, principalFingerprint: null });
    expect(['malformed', 'rejected']).toContain(result.diagnostic);
  });

  it.each([true, false])('rejects duplicate first-party names, equal or different (equal: %s)', equal => {
    const signed = issue();
    const result = read(`${header(signed.token, signed.token)}; ${FIRST}=${equal ? signed.token : issue('admin').token}`);
    expect(result.diagnostic).toBe('duplicate');
    expect(result.result.expiresAt).toBeNull();
  });

  it('keeps legacy duplicate rejection when first-party storage is absent', () => {
    expect(read(`${header(undefined, issue().token)}; ${access.cookieName}=other`).diagnostic).toBe('duplicate');
  });

  it('accepts a newer first-party account when an unwritable partition retains the old account', () => {
    const old = issue('admin', now - 2000);
    const current = issue('editor', now - 1000);
    expect(read(header(current.token, old.token)).result).toMatchObject({ role: 'editor', principalFingerprint: current.principalFingerprint });
  });

  it.each([now - 1000, now - 2000])('rejects an older or equally timed first-party account after a partial switch (%s)', firstIssuedAt => {
    const first = issue('admin', firstIssuedAt);
    const legacy = issue('editor', now - 1000);
    const result = read(header(first.token, legacy.token));
    expect(result.diagnostic).toBe('rejected');
    expect(result.result.principalFingerprint).toBeNull();
  });

  it('does not let an expired first-party identity fall back to a current legacy identity', () => {
    expect(read(header(issue('editor', now - ACCESS_SESSION_TTL_MS - 1).token, issue('admin').token)).result.expiresAt).toBeNull();
  });

  it('ignores an invalid legacy signature when the first-party session is valid', () => {
    expect(read(header(issue().token, 'invalid.signature')).result.role).toBe('editor');
  });

  it('conservatively rejects an older first-party token even for a renewed session family', () => {
    const initial = issue('editor', now - 2000);
    const renewed = access.renew(initial.token, now - 1000)!;
    expect(renewed.principalFingerprint).toBe(initial.principalFingerprint);
    expect(read(header(initial.token, renewed.token)).diagnostic).toBe('rejected');
    expect(read(header(renewed.token, initial.token)).result.principalFingerprint).toBe(initial.principalFingerprint);
  });

  it.each([FIRST, 'vnet_access_session'])('preserves a previously issued v6 Feishu guest from %s', name => {
    const payload = Buffer.from(JSON.stringify({ version: 6, role: 'guest', purchaseBuilding: null,
      feishuAppId: process.env.FEISHU_APP_ID, accountId: `feishu-${'a'.repeat(64)}`, displayName: '合成访客',
      issuedAt: now - 1000, expiresAt: now + 1000, sessionFamilyId: Buffer.alloc(16, 3).toString('base64url') })).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(process.env.LOCAL_ACCESS_SESSION_SECRET!, 'base64')).update(payload).digest('base64url');
    const result = read(`${name}=${payload}.${signature}`);
    expect(result.diagnostic).toBe('valid');
    expect(result.result.role).toBe('guest');
    expect(result.result.principalFingerprint).toEqual(expect.any(String));
  });

  it('uses the same selection for the real protected-route guard', () => {
    const signed = issue('admin');
    const guard = new UnifiedAccessGuard(new Reflector(), access);
    const request = { method: 'POST', originalUrl: '/api/access/configuration/accounts', headers: { cookie: header(signed.token) } };
    const context = { switchToHttp: () => ({ getRequest: () => request }), getClass: () => class Endpoint {}, getHandler: () => () => {} };
    expect(guard.canActivate(context as never)).toBe(true);
    request.headers.cookie = header('invalid.signature', signed.token);
    expect(guard.canActivate(context as never)).toBe(false);
  });

  it('uses the first-party identity for configuration reads and refuses a broken first-party fallback', () => {
    const configuration = { snapshot: jest.fn(() => ({ revision: 1 })) };
    const controller = new AccessConfigurationController(configuration as never, {} as never, access, {} as never);
    const signed = issue('admin');
    expect(controller.read({ headers: { cookie: header(signed.token) } } as never)).toEqual({ revision: 1 });
    expect(() => controller.read({ headers: { cookie: header('invalid.signature', signed.token) } } as never)).toThrow();
    expect(configuration.snapshot).toHaveBeenCalledTimes(1);
  });

  it('uses the first-party identity for follow-up reads and refuses a broken first-party fallback', async () => {
    const service = { listFollowUps: jest.fn(async () => []) };
    const tickets = { verify: () => ({ from: '2026-10-01', through: '2026-10-02' }) };
    const controller = new TodayOperationsFollowUpController(tickets as never, service as never, access);
    const signed = issue('admin');
    await expect(controller.list('synthetic-ticket', { headers: { cookie: header(signed.token) } } as never)).resolves.toMatchObject({ success: true });
    await expect(controller.list('synthetic-ticket', { headers: { cookie: header('invalid.signature', signed.token) } } as never)).rejects.toThrow();
    expect(service.listFollowUps).toHaveBeenCalledTimes(1);
  });

  it('clears both legacy variants and blocks legacy fallback for their maximum lifetime', () => {
    const response = { clearCookie: jest.fn(), cookie: jest.fn() };
    clearAccessCookie(response as never, { secure: true } as never, access.cookieName);
    expect(response.clearCookie.mock.calls.map(([name]) => name)).toEqual([access.cookieName, access.cookieName]);
    expect(response.cookie).toHaveBeenCalledWith(FIRST, 'logged-out', expect.objectContaining({ maxAge: ACCESS_SESSION_TTL_MS,
      expires: new Date(now + ACCESS_SESSION_TTL_MS), httpOnly: true, secure: true, sameSite: 'lax', path: '/' }));
  });

  it('keeps logout anonymous when a container persistently refuses partitioned writes and deletion', async () => {
    const retained = issue('admin', now - 2000);
    const current = issue('editor', now - 1000);
    const jar = new Map([[access.cookieName, retained.token]]);
    const response = {
      cookie: (name: string, value: string, options: { partitioned?: boolean }) => { if (!options.partitioned) jar.set(name, value); },
      clearCookie: (_name: string, _options: unknown) => {},
    };
    const request = () => ({ secure: true, headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } });
    writeAccessCookie(response as never, request() as never, access.cookieName, current, now);
    expect(read(request().headers.cookie).result.role).toBe('editor');
    const controller = new UnifiedAccessController(access, {} as never);
    expect(controller.logout(request() as never, response as never).principalFingerprint).toBeNull();
    const afterLogout = read(request().headers.cookie);
    expect(afterLogout.result.principalFingerprint).toBeNull();
    expect(afterLogout.diagnostic).toBe('absent');
    expect(jar.get(access.cookieName)).toBe(retained.token);
    const guard = new UnifiedAccessGuard(new Reflector(), access);
    expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ ...request(), method: 'POST', originalUrl: '/api/access/configuration/accounts' }) }),
      getClass: () => class Endpoint {}, getHandler: () => () => {} } as never)).toBe(false);
    writeAccessCookie(response as never, request() as never, access.cookieName, current, now);
    expect(read(request().headers.cookie).result.role).toBe('editor');
    expect(access.readSessionIdentity(retained.token, now + ACCESS_SESSION_TTL_MS).expiresAt).toBeNull();
  });

  it.each([false, true])('only trusts proxy HTTPS when explicitly enabled (%s)', trusted => {
    process.env.LOCAL_ACCESS_TRUST_PROXY = String(trusted);
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    writeAccessCookie(response as never, { protocol: 'http', headers: { 'x-forwarded-proto': 'https' } } as never,
      access.cookieName, issue(), now);
    expect(response.cookie.mock.calls.some(([name]) => name === FIRST)).toBe(trusted);
  });

  it('does not treat raw unverified timestamps as ordering evidence', () => {
    const valid = issue();
    const forged = `${Buffer.from(JSON.stringify({ issuedAt: now })).toString('base64url')}.invalid`;
    expect(readAccessCookie(header(forged, valid.token), access, now)).toMatchObject({ diagnostic: 'rejected' });
  });
});
