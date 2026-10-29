import { PersonnelAccountController } from '../../server/common/access/personnel-account.controller';
import { AccessLoginRedactionMiddleware } from '../../server/common/access/access-login-redaction.middleware';

describe('personnel self-service HTTP boundaries', () => {
  const savedUrl = process.env.PUBLIC_BASE_URL;
  let controller: PersonnelAccountController, access: any, config: any, credentials: any, requests: any;
  const principal = { role: 'site_member', purchaseBuilding: null, accountId: 'person-test', authorizationVersion: 4, displayName: '合成员工' };
  const req = (overrides = {}) => ({ headers: { origin: 'https://example.test', cookie: '' }, protocol: 'https', get: () => 'example.test', ip: 'synthetic', ...overrides } as any);
  const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn() } as any);
  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = 'https://example.test';
    access = { cookieName: 'vnet_access_session', readSessionIdentity: jest.fn(() => ({ principal, expiresAt: Date.now() + 10000, principalFingerprint: 'synthetic' })) };
    config = { currentPrincipal: jest.fn(() => principal) };
    credentials = { profile: jest.fn(async () => ({ canChangePassword: true, requiresPasswordChange: false })), changePassword: jest.fn(), resetPassword: jest.fn() };
    requests = { listOwn: jest.fn(), create: jest.fn() };
    controller = new PersonnelAccountController(access, config, credentials, requests);
  });
  afterEach(() => { if (savedUrl === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = savedUrl; });
  it('returns only the signed-in identity and does not expose credential objects', async () => {
    const result = await controller.profile(req({ query: { accountId: 'someone-else' } }));
    expect(result.accountId).toBe(principal.accountId);
    expect(result.effectiveAuthorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });
  it('rejects anonymous or stale sessions', async () => {
    config.currentPrincipal.mockReturnValue(undefined);
    await expect(controller.profile(req())).rejects.toThrow('请先登录');
  });
  it('rejects foreign origins and caller-supplied target IDs before any password write', async () => {
    const body = { currentPassword: 'old-pass', newPassword: 'new-pass-test', confirmPassword: 'new-pass-test', clientMutationId: 'synthetic-change' };
    await expect(controller.changePassword(req({ headers: { origin: 'https://foreign.test' } }), response(), body)).rejects.toThrow('本站');
    await expect(controller.changePassword(req(), response(), { ...body, accountId: 'other' } as any)).rejects.toThrow('格式');
    expect(credentials.changePassword).not.toHaveBeenCalled();
  });
  it('denies impersonation changes and prevents initial-password permission requests', async () => {
    access.readSessionIdentity.mockReturnValue({ principal: { ...principal, impersonation: { actorAccountId: 'admin' } }, expiresAt: Date.now() + 10000, principalFingerprint: 'p' });
    await expect(controller.changePassword(req(), response(), { currentPassword: 'old-pass', newPassword: 'new-pass-test', confirmPassword: 'new-pass-test', clientMutationId: 'synthetic-change' })).rejects.toThrow('代登录');
    access.readSessionIdentity.mockReturnValue({ principal: { ...principal, requiresPasswordChange: true }, expiresAt: Date.now() + 10000, principalFingerprint: 'p' });
    expect(() => controller.create(req(), {} as any)).toThrow('初始密码');
    expect(requests.create).not.toHaveBeenCalled();
  });
  it('redacts password and identity values while preserving validation and access', () => {
    const request: any = { originalUrl: '/api/access/personal/password/reset', body: { employeeName: '合成员工', identityNumber: 'synthetic-identity', newPassword: 'new-pass-test', confirmPassword: 'new-pass-test', clientMutationId: 'synthetic-reset', role: 'admin' } };
    new AccessLoginRedactionMiddleware().use(request, {} as any, jest.fn());
    expect(JSON.stringify(request.body)).not.toMatch(/合成员工|synthetic-identity|new-pass-test/);
    expect(request.body.identityNumber).toBe('synthetic-identity');
    expect(request.body.invalidFields).toBe(true);
  });
});
