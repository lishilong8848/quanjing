import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { ACCESS_SESSION_TTL_MS, UnifiedAccessService } from '../../server/common/access/unified-access.service';

describe('session cookie diagnostic header', () => {
  const keys = ['LOCAL_ACCESS_CONTROL_ENABLED', 'LOCAL_ACCESS_SESSION_SECRET', 'FEISHU_APP_ID'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let access: UnifiedAccessService;

  beforeEach(() => {
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 11).toString('base64');
    process.env.FEISHU_APP_ID = 'cli_synthetic_cookie_diagnostic';
    access = new UnifiedAccessService();
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function read(header?: string) {
    const response = { setHeader: jest.fn(), clearCookie: jest.fn(), cookie: jest.fn() };
    const controller = new UnifiedAccessController(access, {} as never);
    const body = controller.session({ headers: { cookie: header }, secure: false, protocol: 'http', socket: {} } as never, response as never);
    const diagnostic = response.setHeader.mock.calls.find(([name]) => name === 'X-Access-Session-Cookie')?.[1];
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(response.cookie).not.toHaveBeenCalled();
    expect(['absent', 'duplicate', 'malformed', 'rejected', 'valid', 'disabled']).toContain(diagnostic);
    return { body, diagnostic };
  }

  it.each([
    ['missing header', undefined, 'absent'],
    ['unrelated cookie', 'other-cookie=synthetic', 'absent'],
    ['empty value', 'vnet_access_session=', 'malformed'],
    ['bare cookie name', 'vnet_access_session', 'malformed'],
    ['invalid encoding', 'vnet_access_session=%E0%A4%A', 'malformed'],
    ['quoted value', 'vnet_access_session="synthetic"', 'malformed'],
    ['invalid token', 'vnet_access_session=synthetic.invalid', 'rejected'],
  ])('classifies %s without changing the anonymous response', (_label, header, expected) => {
    const result = read(header);
    expect(result.diagnostic).toBe(expected);
    expect(result.body).toMatchObject({ role: 'guest', expiresAt: null, principalFingerprint: null });
  });

  it.each([false, true])('rejects duplicate names, including equal valid values (bare duplicate: %s)', bare => {
    const signed = access.issueTrustedSession({ role: 'editor', purchaseBuilding: null });
    const header = `${access.cookieName}=${signed.token}; ${access.cookieName}${bare ? '' : `=${signed.token}`}`;
    const result = read(header);
    expect(result.diagnostic).toBe('duplicate');
    expect(result.body).toMatchObject({ role: 'guest', expiresAt: null, principalFingerprint: null });
  });

  it('accepts an encoded signed session and keeps the existing identity', () => {
    const signed = access.issueTrustedSession({ role: 'editor', purchaseBuilding: null });
    const result = read(`${access.cookieName}=${encodeURIComponent(signed.token).replace('.', '%2E')}`);
    expect(result.diagnostic).toBe('valid');
    expect(result.body).toMatchObject({ role: 'editor', expiresAt: signed.expiresAt, principalFingerprint: signed.principalFingerprint });
  });

  it('marks an authenticated Feishu guest as valid', () => {
    const signed = access.issueTrustedSession({ role: 'guest', purchaseBuilding: null,
      feishuAppId: process.env.FEISHU_APP_ID!, accountId: `feishu-${'a'.repeat(64)}`, displayName: '合成访客' });
    const result = read(`${access.cookieName}=${signed.token}`);
    expect(result.diagnostic).toBe('valid');
    expect(result.body).toMatchObject({ role: 'guest', expiresAt: signed.expiresAt, principalFingerprint: signed.principalFingerprint });
  });

  it('distinguishes an expired signed session from a malformed cookie', () => {
    const signed = access.issueTrustedSession({ role: 'editor', purchaseBuilding: null }, Date.now() - ACCESS_SESSION_TTL_MS - 1000);
    expect(read(`${access.cookieName}=${signed.token}`).diagnostic).toBe('rejected');
  });

  it('reports a signature rejected by another key without revealing a reason or token', () => {
    const signed = access.issueTrustedSession({ role: 'editor', purchaseBuilding: null });
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 22).toString('base64');
    access = new UnifiedAccessService();
    const result = read(`${access.cookieName}=${signed.token}`);
    expect(result.diagnostic).toBe('rejected');
    expect(result.body.principalFingerprint).toBeNull();
  });

  it('preserves unrestricted access when access control is disabled', () => {
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'false';
    access = new UnifiedAccessService();
    const result = read();
    expect(result.diagnostic).toBe('disabled');
    expect(result.body).toMatchObject({ role: 'admin', expiresAt: null });
  });
});
