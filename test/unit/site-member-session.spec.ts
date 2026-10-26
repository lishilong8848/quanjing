import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { GuestReadable, GuestSubmittable, AdminOnly } from '../../server/common/access/unified-access.decorators';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { FeishuAccessService } from '../../server/common/access/feishu-access.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { buildSiteMemberDirectory } from '../../server/common/access/site-member-directory';

class Probe { read() {} submit() {} admin() {} }
for (const [name, decorator] of [['read', GuestReadable], ['submit', GuestSubmittable], ['admin', AdminOnly]] as const) decorator()(Probe.prototype, name, Object.getOwnPropertyDescriptor(Probe.prototype, name)!);

describe('基地成员登录与服务端鉴权', () => {
  const saved = { ...process.env };
  const appId = 'cli_member_fixture';
  let root: string, configuration: AccessConfigurationService, access: UnifiedAccessService;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-site-member-test-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(root, 'accounts.json');
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_APP_SECRET = 'synthetic-only';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-only');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    configuration = new AccessConfigurationService(); access = new UnifiedAccessService(configuration);
  });
  afterEach(() => { process.env = { ...saved }; rmSync(root, { recursive: true, force: true }); });
  async function sync(active = true) {
    const externalEmployees = await buildExternalEmployeeCredentials([{ record_id: 'recMember', fields: { 姓名: '验收成员甲', 密码: 'synthetic-member-only', '离职/异动情况': false } }], appId, 'fixture-base', 'tblFixture');
    await configuration.synchronizePersonnel({ appId, people: [], employees: [], snapshotAt: Date.now(), personnelComplete: true, externalEmployees,
      activeMembers: active ? [{ name: '验收成员甲', openId: 'ou_member', passwordAccountId: externalEmployees[0].id }] : [] });
    return externalEmployees[0].id;
  }
  it('双身份签发成员，离开完整视图撤旧会话并可重新游客登录', async () => {
    await sync();
    const local = await access.login({ employeeName: '验收成员甲', password: 'synthetic-member-only' }, 'fixture');
    const feishu = access.issueTrustedSession(configuration.feishuPrincipal('ou_member', appId)!);
    for (const value of [local, feishu]) {
      expect(value.principal).toMatchObject({ role: 'site_member', displayName: '验收成员甲' });
      expect(access.readSession(value.token).principal).toEqual(value.principal);
      expect(access.renew(value.token)?.principal).toEqual(value.principal);
    }
    await sync(); expect(access.readSession(feishu.token).expiresAt).not.toBeNull();
    await sync(false);
    expect(access.readSession(local.token).expiresAt).toBeNull(); expect(access.readSession(feishu.token).expiresAt).toBeNull();
    expect((await access.login({ employeeName: '验收成员甲', password: 'synthetic-member-only' }, 'fixture')).principal.role).toBe('guest');
    expect(configuration.feishuPrincipal('ou_member', appId)).toMatchObject({role:'guest',displayName:'验收成员甲'});
  });
  it('成员可安全读取完整排班、考勤、长白班和航图，只开放受保护本人申请', async () => {
    await sync(); const session = access.issueTrustedSession(configuration.feishuPrincipal('ou_member', appId)!);
    const guard = new UnifiedAccessGuard(new Reflector(), access);
    const check = (url: string, method = 'GET', target: keyof Probe = 'read') => {
      const req = { method, url, originalUrl: url, query: {}, headers: { cookie: `${access.cookieName}=${session.token}` }, socket: {} };
      return guard.canActivate({ getClass: () => Probe, getHandler: () => Probe.prototype[target], switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ once: (_event: string, callback: () => void) => callback() }) }) } as never);
    };
    for (const path of ['/api/monthly-schedules/2026/10', '/api/duty-schedules', '/api/duty-schedules/long-white-duty-staff', '/api/bitable/non-duty-schedules', '/api/attendance/today', '/api/bitable/today-operations-overview']) expect(check(path)).toBe(true);
    for (const path of ['/api/monthly-schedules/2026/10?refresh=1', '/api/attendance/today?force=true', '/api/contract-management/dashboard', '/api/duty-schedules/construction-management', '/api/operations-kb/search', '/api/access/configuration']) expect(check(path)).toBe(false);
    expect(check('/api/duty-schedules/leave-request', 'POST', 'submit')).toBe(true);
    expect(check('/api/duty-schedules/overtime-request', 'POST', 'submit')).toBe(true);
    for (const path of ['/api/duty-schedules/staff-adjustment', '/api/duty-schedules/travel-staff', '/api/duty-schedules/change-request', '/api/attendance/today/retry']) expect(check(path, 'POST', 'submit')).toBe(false);
    expect(check('/api/attendance/correction-evidence', 'GET', 'admin')).toBe(false);
  });
  it('不能用共享密码凭空签发成员；手工停用不被每日同步重新启用', async () => {
    const id = await sync();
    expect(() => access.issueTrustedSession({ role: 'site_member', purchaseBuilding: null } as never)).toThrow();
    const account = configuration.snapshot().accounts.find(account => account.id === id)!;
    const actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    await configuration.saveAccount({ clientMutationId: 'member-manual-disable', expectedRevision: configuration.snapshot().revision, id, kind: 'local', name: account.name, role: 'site_member', building: null, enabled: false }, actor);
    await sync(); await expect(access.login({ employeeName: account.name, password: 'synthetic-member-only' }, 'fixture')).rejects.toThrow();
  });
  it('隔离重复飞书关联后，两个在职姓名账号均获成员权限，旧冲突飞书会话失效', async () => {
    await sync(); const oldSession = access.issueTrustedSession(configuration.feishuPrincipal('ou_member', appId)!);
    const records = [
      { record_id: 'recMember', fields: { 姓名: '验收成员甲', 密码: 'synthetic-member-only', 员工姓名: [{ id: 'ou_member', name: '验收成员甲' }] } },
      { record_id: 'recSecond', fields: { 姓名: '验收成员乙', 密码: 'synthetic-second-only', 员工姓名: [{ id: 'ou_member', name: '验收成员甲' }] } },
    ];
    const externalEmployees = await buildExternalEmployeeCredentials(records, appId, 'fixture-base', 'tblFixture');
    const directory = buildSiteMemberDirectory(records, appId, 'fixture-base', 'tblFixture');
    const result = await configuration.synchronizePersonnel({ appId, people: [], employees: [], snapshotAt: Date.now(), personnelComplete: true, externalEmployees, activeMembers: directory.members, personnelWarnings: directory.warnings });
    expect(result.personnelSync).toMatchObject({ status: 'success', warning: expect.stringContaining('2 名人员') });
    expect(configuration.feishuPrincipal('ou_member', appId)).toMatchObject({role:'guest',displayName:'验收成员甲'});
    expect(access.readSession(oldSession.token).expiresAt).toBeNull();
    for (const person of [{ name: '验收成员甲', password: 'synthetic-member-only' }, { name: '验收成员乙', password: 'synthetic-second-only' }]) {
      expect((await access.login({ employeeName: person.name, password: person.password }, 'fixture')).principal).toMatchObject({ role: 'site_member', displayName: person.name });
    }
  });
  it('未映射飞书游客保留上游稳定哈希身份，不能以姓名冒充成员', async () => {
    const config = { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: 'synthetic-only', PUBLIC_BASE_URL: 'https://fixture.example.test' };
    const oauth = new FeishuAccessService({ get: (key: keyof typeof config) => config[key] } as never, { axiosRef: { post: jest.fn().mockResolvedValue({ data: { code: 0, access_token: 'synthetic-only' } }), get: jest.fn().mockResolvedValue({ data: { code: 0, data: { open_id: 'ou_other_member', name: '验收成员甲' } } }) } } as never, configuration);
    const signed = access.issueTrustedSession(await oauth.exchangeAuthorizationCode('synthetic-code'));
    expect(signed.principal).toMatchObject({ role: 'guest', accountId: `feishu-${feishuIdentityFingerprint(appId, 'ou_other_member')}` });
    expect(access.readSession(signed.token).principal).toEqual(signed.principal);
    expect(access.renew(signed.token)?.principal).toEqual(signed.principal);
  });
});
