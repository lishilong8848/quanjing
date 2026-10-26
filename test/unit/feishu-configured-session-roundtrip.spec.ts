import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { readAccessCookie, writeAccessCookie } from '../../server/common/access/unified-access.guard';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import type { AccountMutation } from '../../shared/access-configuration.interface';

describe('configured Feishu identity session round trip', () => {
  const saved = { ...process.env };
  const appId = 'cli_login_roundtrip_fixture';
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-login-roundtrip-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(root, 'accounts.json');
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-only');
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { role: 'admin', building: null },
    { role: 'editor', building: null },
    { role: 'professional_admin', building: null, specialties: ['电气'] },
    { role: 'professional_engineer', building: 'B楼', buildings: ['B楼'], specialties: ['电气'] },
    { role: 'building_admin', building: 'B楼', buildings: ['B楼', 'C楼'] },
    { role: 'inventory_admin', building: 'A楼', buildings: ['A楼'] },
    { role: 'purchase_applicant', building: 'A楼' },
    { role: 'duty_editor', building: null },
  ])('keeps enabled $role identity and rejects a revoked version', async scope => {
    const configuration = new AccessConfigurationService();
    const access = new UnifiedAccessService(configuration);
    const actor = configuration.localTargets().find(value => value.principal.role === 'admin')!.principal;
    const request = { ...scope, clientMutationId: 'login-roundtrip-create', expectedRevision: 0,
      kind: 'feishu', name: '合成登录验收', openId: 'ou_login_roundtrip', enabled: true } as AccountMutation;
    await configuration.saveAccount(request, actor);
    const principal = configuration.feishuPrincipal(request.openId!, appId)!;
    const signed = access.issueTrustedSession(principal);
    const cookies = new Map<string, string>();
    writeAccessCookie({ clearCookie: (name: string) => { cookies.delete(name); }, cookie: (name: string, token: string) => { cookies.set(name, encodeURIComponent(token)); } } as never,
      { secure: true, headers: {}, socket: {} } as never, access.cookieName, signed, Date.now());
    const header = [...cookies].map(([name, token]) => `${name}=${token}`).join('; ');
    const cookie = readAccessCookie(header, access);
    expect(access.readSessionIdentity(cookie.value).principal).toEqual(principal);
    const controller = new UnifiedAccessController(access, {} as never);
    const result = controller.session({ headers: { cookie: header } } as never,
      { setHeader: () => undefined, clearCookie: () => undefined } as never);
    expect(result).toMatchObject({ role: principal.role, accountId: principal.accountId,
      principalFingerprint: signed.principalFingerprint, expiresAt: signed.expiresAt });
    await configuration.saveAccount({ ...request, id: principal.accountId, expectedRevision: 1,
      clientMutationId: 'login-roundtrip-disable', enabled: false }, actor);
    expect(access.readSessionIdentity(cookie.value).expiresAt).toBeNull();
  });
});
