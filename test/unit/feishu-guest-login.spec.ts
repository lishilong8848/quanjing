import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { effectivePagePaths } from '../../shared/page-access';
import { createHmac } from 'node:crypto';
import { FeishuAccessService } from '../../server/common/access/feishu-access.service';
import { UnifiedAccessService, ACCESS_SESSION_TTL_MS } from '../../server/common/access/unified-access.service';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { GuestReadableMetadataKey } from '../../server/common/access/unified-access.decorators';
import { canAccessPage, capabilitiesForRole } from '../../client/src/access/access-policy';

describe('verified Feishu guest identity', () => {
  const appId = 'cli_guest_fixture';
  const secret = Buffer.alloc(32, 27).toString('base64');
  const original = { secret: process.env.LOCAL_ACCESS_SESSION_SECRET, appId: process.env.FEISHU_APP_ID, enabled: process.env.LOCAL_ACCESS_CONTROL_ENABLED };
  beforeEach(() => {
    process.env.LOCAL_ACCESS_SESSION_SECRET = secret;
    process.env.FEISHU_APP_ID = appId;
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
  });
  afterEach(() => {
    for (const [key, value] of Object.entries({ LOCAL_ACCESS_SESSION_SECRET: original.secret, FEISHU_APP_ID: original.appId, LOCAL_ACCESS_CONTROL_ENABLED: original.enabled })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  function services(name: unknown = '测试访客', openId: unknown = 'ou_guest_fixture') {
    const config: Record<string, unknown> = { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: 'fixture-only', PUBLIC_BASE_URL: 'https://fixture.example.test' };
    const configuration = { pagePermissions: (role: 'guest') => ({ paths: effectivePagePaths(role), revision: 0, configured: false }), feishuPrincipal: jest.fn(() => null), validateSession: jest.fn(() => false) };
    const feishu = new FeishuAccessService({ get: (key: string) => config[key] } as never, {
      axiosRef: { post: jest.fn().mockResolvedValue({ data: { code: 0, access_token: 'fixture-only' } }), get: jest.fn().mockResolvedValue({ data: { code: 0, data: { open_id: openId, name } } }) },
    } as never, configuration as never);
    return { feishu, access: new UnifiedAccessService(configuration as never), configuration };
  }

  it('signs an unmapped OAuth identity as a named guest and retains it on reads and renewal', async () => {
    const { feishu, access, configuration } = services('  测试访客  ');
    const principal = await feishu.exchangeAuthorizationCode('fixture-code');
    expect(principal).toMatchObject({ role: 'guest', purchaseBuilding: null, displayName: '测试访客' });
    const signed = access.issueTrustedSession(principal, 1000);
    const read = access.readSessionIdentity(signed.token, 2000);
    expect(read.principal).toEqual({ role: 'guest', purchaseBuilding: null, displayName: '测试访客', accountId: `feishu-${feishuIdentityFingerprint(appId, 'ou_guest_fixture')}` });
    expect(read.expiresAt).toBe(1000 + ACCESS_SESSION_TTL_MS);
    expect(read.principalFingerprint).toBe(signed.principalFingerprint);
    const renewed = access.renew(signed.token, 3000)!;
    expect(renewed.principal).toEqual(read.principal);
    expect(renewed.principalFingerprint).toBe(signed.principalFingerprint);
    expect(access.readSession(renewed.token, 4000).principal).toEqual(read.principal);
    expect(configuration.validateSession).not.toHaveBeenCalled();
    expect(signed.token).not.toContain('ou_guest_fixture');
  });

  it('completes the callback successfully, returns guest capabilities and clears identity on logout', async () => {
    const { feishu, access } = services();
    const controller = new UnifiedAccessController(access, feishu);
    const now = 1000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const response = { setHeader: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn() };
    const request = { headers: { cookie: 'vnet_feishu_oauth_state=fixture-state-1234567890123456; vnet_feishu_oauth_return_to=%2Fnantong-base' }, socket: {} };
    await controller.feishuCallback({ state: 'fixture-state-1234567890123456', code: 'fixture-code' }, request as never, response as never);
    expect(response.redirect).toHaveBeenCalledWith(302, '/nantong-base?feishu_auth=success');
    const token = response.cookie.mock.calls.find(([key]) => key === access.cookieName)?.[1];
    expect(typeof token).toBe('string');
    request.headers.cookie = `${access.cookieName}=${token}`;
    const session = controller.session(request as never, response as never);
    expect(session.displayName).toBe('测试访客');
    expect(session.capabilities).toEqual({ canEdit: false, canDelete: false, canForceRefresh: false, canAccessContracts: false });
    expect(canAccessPage(session.role, '/nantong-base')).toBe(true);
    for (const path of ['/system-configuration', '/construction-management', '/contract-management']) expect(canAccessPage(session.role, path)).toBe(false);
    const guard = new UnifiedAccessGuard({ getAllAndOverride: (key: string) => key === GuestReadableMetadataKey, get: () => false } as never, access);
    for (const [path, method, allowed] of [
      ['/api/duty-schedules/monthly-schedules', 'GET', true],
      ['/api/access/configuration', 'GET', false],
      ['/api/duty-schedules/construction-management', 'GET', false],
      ['/api/contract-management', 'GET', false],
      ['/api/inventory-management/records', 'POST', false],
      ['/api/purchase-inventory/records', 'POST', false],
    ] as const) {
      const guardedRequest = { ...request, originalUrl: path, url: path, method, query: {} };
      const context = { getHandler: () => () => {}, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => guardedRequest, getResponse: () => response }) };
      expect(guard.canActivate(context as never)).toBe(allowed);
    }
    expect(controller.logout(request as never, response as never)).toMatchObject({ role: 'guest', expiresAt: null, principalFingerprint: null });
    expect(controller.logout(request as never, response as never).displayName).toBeUndefined();
    expect(response.clearCookie).toHaveBeenCalledWith(access.cookieName, expect.any(Object));
  });

  it('expires back to anonymous guest and rejects a different application', async () => {
    const { feishu, access } = services();
    const signed = access.issueTrustedSession(await feishu.exchangeAuthorizationCode('fixture-code'), 1000);
    expect(access.readSessionIdentity(signed.token, 1000 + ACCESS_SESSION_TTL_MS)).toEqual({ principal: { role: 'guest', purchaseBuilding: null }, expiresAt: null, principalFingerprint: null });
    process.env.FEISHU_APP_ID = 'cli_another_fixture';
    expect(new UnifiedAccessService().readSession(signed.token, 2000).expiresAt).toBeNull();
  });

  it.each([null, '', '测试\n访客', 'x'.repeat(129)])('ignores an invalid optional name %p without denying a verified guest', async name => {
    const { feishu, access } = services(name);
    const principal = await feishu.exchangeAuthorizationCode('fixture-code');
    const signed = access.issueTrustedSession(principal, 1000);
    expect(access.readSession(signed.token, 2000).principal).toEqual({ role: 'guest', purchaseBuilding: null, accountId: `feishu-${feishuIdentityFingerprint(appId, 'ou_guest_fixture')}` });
  });

  it.each(['', 'wrong-id', null])('continues rejecting malformed OAuth identities %p', async openId => {
    const { feishu } = services('测试访客', openId);
    await expect(feishu.exchangeAuthorizationCode('fixture-code')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects role, scope and account fields injected into a signed guest payload', async () => {
    const { feishu, access } = services();
    const signed = access.issueTrustedSession(await feishu.exchangeAuthorizationCode('fixture-code'), 1000);
    const payload = JSON.parse(Buffer.from(signed.token.split('.')[0], 'base64url').toString());
    for (const mutation of [{ role: 'admin' }, { purchaseBuilding: 'A楼' }, { accountId: 'privileged', authorizationVersion: 1 }, { displayName: '坏\n名字' }, { feishuAppId: '' }]) {
      const body = Buffer.from(JSON.stringify({ ...payload, ...mutation })).toString('base64url');
      const token = `${body}.${createHmac('sha256', Buffer.from(secret, 'base64')).update(body).digest('base64url')}`;
      expect(access.readSessionIdentity(token, 2000)).toEqual({ principal: { role: 'guest', purchaseBuilding: null }, expiresAt: null, principalFingerprint: null });
    }
    expect(capabilitiesForRole('guest').canEdit).toBe(false);
    expect(() => access.issueTrustedSession({ role: 'guest', purchaseBuilding: null } as never, 1000)).toThrow();
  });
});
