import { createHmac } from 'node:crypto';
import { FeishuAccessService } from '../../server/common/access/feishu-access.service';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { canAccessPage } from '../../client/src/access/access-policy';
import { getAccessibleSwitcherPages } from '../../client/src/navigation/page-switcher';

describe('Feishu verified display name', () => {
  const originalSecret = process.env.LOCAL_ACCESS_SESSION_SECRET;
  const secret = Buffer.alloc(32, 17).toString('base64');
  beforeEach(() => {
    process.env.LOCAL_ACCESS_SESSION_SECRET = secret;
  });
  afterEach(() => {
    if (originalSecret === undefined)
      delete process.env.LOCAL_ACCESS_SESSION_SECRET;
    else process.env.LOCAL_ACCESS_SESSION_SECRET = originalSecret;
  });

  async function exchange(name: unknown) {
    const config: Record<string, unknown> = {
      FEISHU_APP_ID: 'cli_test_profile',
      FEISHU_APP_SECRET: 'fixture-only-secret',
      PUBLIC_BASE_URL: 'https://fixture.example.test',
      FEISHU_ACCESS_ADMIN_OPEN_IDS: 'ou_test_profile_admin',
    };
    const service = new FeishuAccessService(
      { get: (key: string) => config[key] } as never,
      {
        axiosRef: {
          post: jest
            .fn()
            .mockResolvedValue({
              data: { code: 0, access_token: 'fixture-only-token' },
            }),
          get: jest
            .fn()
            .mockResolvedValue({
              data: {
                code: 0,
                data: { open_id: 'ou_test_profile_admin', name },
              },
            }),
        },
      } as never,
    );
    return service.exchangeAuthorizationCode('fixture-only-code');
  }

  it('keeps the verified name through signing, reads and renewal without changing authorization', async () => {
    const principal = await exchange(' 马进宇 ');
    expect(principal).toEqual({
      role: 'admin',
      purchaseBuilding: null,
      displayName: '马进宇',
    });
    const access = new UnifiedAccessService();
    const session = access.issueTrustedSession(principal, 1000);
    expect(access.readSession(session.token, 2000).principal).toEqual(
      principal,
    );
    expect(access.readSessionIdentity(session.token, 2000).principal).toEqual(
      principal,
    );
    const renewed = access.renew(session.token, 3000)!;
    expect(renewed.principal).toEqual(principal);
    expect(renewed.principalFingerprint).toBe(session.principalFingerprint);
    expect(access.readSession(renewed.token, 4000).principal).toEqual(
      principal,
    );
    expect(session.token).not.toContain('ou_test_profile_admin');
  });

  it.each([
    undefined,
    null,
    '',
    '  ',
    123,
    {},
    'x'.repeat(129),
    '张\n三',
    '张\u202e三',
  ])(
    'falls back to role for invalid optional upstream name %p',
    async (name) => {
      expect(await exchange(name)).toEqual({
        role: 'admin',
        purchaseBuilding: null,
      });
    },
  );

  it('preserves the unnamed V3 format and accepts the old V2 format', () => {
    const access = new UnifiedAccessService();
    const principal = { role: 'editor', purchaseBuilding: null } as const;
    const session = access.issueTrustedSession(principal, 1000);
    expect(
      JSON.parse(
        Buffer.from(session.token.split('.')[0], 'base64url').toString(),
      ).version,
    ).toBe(3);
    const payload = Buffer.from(
      JSON.stringify({
        version: 2,
        ...principal,
        issuedAt: 1000,
        expiresAt: 10000,
      }),
    ).toString('base64url');
    const token = `${payload}.${createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url')}`;
    expect(access.readSession(token, 2000).principal).toEqual(principal);
    expect(access.renew(token, 2000)?.principal).toEqual(principal);
  });

  it.each(['', 'x'.repeat(129), '张\n三', '张\u202e三', 1, null])(
    'rejects signed malformed V4 name %p',
    (displayName) => {
      const payload = Buffer.from(
        JSON.stringify({
          version: 4,
          role: 'admin',
          purchaseBuilding: null,
          displayName,
          issuedAt: 1000,
          expiresAt: 10000,
          sessionFamilyId: 'a'.repeat(22),
        }),
      ).toString('base64url');
      const token = `${payload}.${createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url')}`;
      expect(
        new UnifiedAccessService().readSession(token, 2000).principal.role,
      ).toBe('guest');
    },
  );

  it('rejects name tampering without a valid signature', async () => {
    const access = new UnifiedAccessService();
    const session = access.issueTrustedSession(await exchange('马进宇'), 1000);
    const [body, signature] = session.token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.displayName = '其他人';
    const changed = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(
      access.readSession(`${changed}.${signature}`, 2000).principal.role,
    ).toBe('guest');
  });
});

describe('construction guest boundary', () => {
  it.each([
    '/construction-management',
    '/construction-management/',
    '/construction-management///',
  ])('rejects a guest direct route %s', (path) =>
    expect(canAccessPage('guest', path)).toBe(false),
  );
  it('hides the construction application from the guest switcher', () => {
    expect(
      getAccessibleSwitcherPages('guest').some(
        (page) => page.key === 'construction',
      ),
    ).toBe(false);
    expect(
      getAccessibleSwitcherPages('admin').some(
        (page) => page.key === 'construction',
      ),
    ).toBe(true);
  });
});
