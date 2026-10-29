import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { buildExternalEmployeeCredentials, readExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { AccessConfigurationController } from '../../server/common/access/access-configuration.controller';
import { AccessLoginRedactionMiddleware } from '../../server/common/access/access-login-redaction.middleware';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { isConfirmedLoginSession } from '../../client/src/access/session-commit-coordinator';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import { readPersonnelAuthorizationState } from '../../server/common/access/personnel-employment-state';
import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';

describe('外部员工姓名密码登录', () => {
  const saved = { ...process.env };
  let root: string, configuration: AccessConfigurationService, access: UnifiedAccessService;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-external-access-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(root, 'accounts.json');
    process.env.FEISHU_APP_ID = 'cli_a9d1c9fe9d381cee';
    process.env.FEISHU_APP_SECRET = 'synthetic-only';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-only');
    configuration = new AccessConfigurationService(); access = new UnifiedAccessService(configuration);
  });
  afterEach(() => { process.env = { ...saved }; rmSync(root, { recursive: true, force: true }); });
  const rows = (password = 'synthetic-external-only') => [{ record_id: 'recExternalTest', fields: { 姓名: '外部验收员工', 密码: password, '离职/异动情况': false } }];
  async function sync(records: BitableRecordItem[] = rows()) {
    const externalEmployees = await buildExternalEmployeeCredentials(records, 'cli_a9d1c9fe9d381cee', 'synthetic-base', 'tblSynthetic');
    const snapshot: ConfigurationDirectorySnapshot = { appId: process.env.FEISHU_APP_ID!, people: [], employees: [], snapshotAt: Date.now(), personnelComplete: true, externalEmployees,
      employmentState:{complete:true,entries:externalEmployees.map((person,index)=>({personnelIdentity:person.id,inactive:readPersonnelAuthorizationState(records[index].fields || {})==='inactive'}))} };
    await configuration.synchronizePersonnel(snapshot);
    return configuration.snapshot().accounts.find(account => account.loginMethod === 'personnel-password')!;
  }
  it('默认游客，携带姓名、稳定账号和独立会话身份，重启后仍可登录', async () => {
    const account = await sync();
    const result = await access.login({ employeeName: '外部验收员工', password: 'synthetic-external-only' }, 'test');
    expect(result.principal).toMatchObject({ role: 'guest', displayName: '外部验收员工', accountId: account.id });
    expect(access.readSession(result.token).principal).toEqual(result.principal);
    expect(access.renew(result.token)?.principal).toEqual(result.principal);
    await expect(new UnifiedAccessService(new AccessConfigurationService()).login({ employeeName: '外部验收员工', password: 'synthetic-external-only' }, 'test')).resolves.toMatchObject({ principal: { accountId: account.id } });
  });
  it('外部密码不能单独登录，也不能与本地预设密码混用', async () => {
    await sync();
    await expect(access.login({ password: 'synthetic-external-only' }, 'test')).rejects.toThrow('登录凭据无效');
    await expect(access.login({ employeeName: '外部验收员工', password: 'synthetic-admin-only' }, 'test')).rejects.toThrow('登录凭据无效');
    await expect(access.login({ employeeName: '不存在人员', password: 'synthetic-external-only' }, 'test')).rejects.toThrow('登录凭据无效');
  });
  it('改密撤销旧会话；重复同步保留版本，密码不会进入响应、审计和磁盘明文', async () => {
    const account = await sync();
    const session = await access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test');
    await sync();
    expect(configuration.snapshot().accounts.find(value => value.id === account.id)?.version).toBe(account.version);
    await sync(rows('synthetic-new-external-only'));
    expect(access.readSession(session.token).expiresAt).toBeNull();
    await expect(access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test')).rejects.toThrow();
    await expect(access.login({ employeeName: account.name, password: 'synthetic-new-external-only' }, 'test')).resolves.toBeDefined();
    expect(JSON.stringify(configuration.snapshot())).not.toMatch(/synthetic-(?:new-)?external-only|passwordHash|scrypt\$/);
    expect(readFileSync(process.env.ACCESS_CONFIGURATION_FILE!, 'utf8')).not.toMatch(/synthetic-(?:new-)?external-only/);
  });
  it('权限配置支持多个楼栋，同步不会覆盖手工权限或手工停用', async () => {
    const account = await sync(), actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    await configuration.saveAccount({ clientMutationId: 'external-role-multi-scope', expectedRevision: configuration.snapshot().revision, id: account.id, kind: 'local', name: account.name, role: 'inventory_admin', building: 'A楼', buildings: ['A楼', 'H楼'], enabled: true }, actor);
    const session = await access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test');
    expect(session.principal).toMatchObject({ role: 'inventory_admin', buildings: ['A楼', 'H楼'] });
    await sync();
    expect(access.readSession(session.token).principal.role).toBe('inventory_admin');
    await configuration.saveAccount({ clientMutationId: 'external-disable-manual', expectedRevision: configuration.snapshot().revision, id: account.id, kind: 'local', name: account.name, role: 'inventory_admin', building: 'A楼', buildings: ['A楼', 'H楼'], enabled: false }, actor);
    await sync();
    await expect(access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test')).rejects.toThrow('登录凭据无效');
  });
  it('明确离职撤销旧会话并禁止实名游客登录；普通同步不能恢复', async () => {
    const account = await sync(), session = await access.login({ employeeName: '外部验收员工', password: 'synthetic-external-only' }, 'test');
    const inactive = [{ ...rows()[0], fields: { ...rows()[0].fields, '离职/异动情况': '已离职' } }];
    await sync(inactive);
    expect(access.readSession(session.token).expiresAt).toBeNull();
    await expect(access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test')).rejects.toThrow('登录凭据无效');
    await sync();
    await expect(access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test')).rejects.toThrow('登录凭据无效');
    await sync([]);
    await expect(access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test')).rejects.toThrow();
    await sync(rows(''));
    await expect(access.login({ employeeName: account.name, password: '' }, 'test')).rejects.toThrow();
  });
  it('同名不能串号；不同人员可以使用相同密码', async () => {
    const duplicate = [...rows(), { ...rows()[0], record_id: 'recOtherExternal' }];
    await sync(duplicate);
    await expect(access.login({ employeeName: '外部验收员工', password: 'synthetic-external-only' }, 'test')).rejects.toThrow('登录凭据无效');
    duplicate[1].fields = { ...duplicate[1].fields, 姓名: '其他验收员工' }; await sync(duplicate);
    const first = await access.login({ employeeName: '外部验收员工', password: 'synthetic-external-only' }, 'test');
    const second = await access.login({ employeeName: '其他验收员工', password: 'synthetic-external-only' }, 'test');
    expect(first.principal.accountId).not.toBe(second.principal.accountId);
  });
  it('禁止从配置页修改表内姓名和密码、伪造账号或跨应用复用身份', async () => {
    const account = await sync(), actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    const body = { clientMutationId: 'external-edit-source-reject', expectedRevision: configuration.snapshot().revision, id: account.id, kind: 'local' as const, name: account.name, role: 'guest' as const, building: null, enabled: true };
    await expect(configuration.saveAccount({ ...body, password: 'synthetic-overwrite-only' }, actor)).rejects.toThrow();
    await expect(configuration.saveAccount({ ...body, name: '替换人员' }, actor)).rejects.toThrow();
    await expect(configuration.saveAccount({ ...body, id: undefined }, actor)).rejects.toThrow();
    const session = await access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test');
    process.env.FEISHU_APP_ID = 'cli_other_application';
    expect(access.readSession(session.token).expiresAt).toBeNull();
    await expect(access.login({ employeeName: account.name, password: 'synthetic-external-only' }, 'test')).rejects.toThrow();
  });
  it('保留密码空格和重复文本片段，不把展示文字适配当作密码适配', async () => {
    await sync([{ ...rows()[0], fields: { ...rows()[0].fields, 密码: [{ text: ' pass ' }, { text: ' pass ' }] as never } }]);
    await expect(access.login({ employeeName: '外部验收员工', password: ' pass  pass ' }, 'test')).resolves.toBeDefined();
    await expect(access.login({ employeeName: '外部验收员工', password: 'pass pass' }, 'test')).rejects.toThrow();
  });
  it('生产登录中间件保留姓名和多楼栋字段，同时隐藏敏感值', async () => {
    await sync();
    const request = { originalUrl: '/api/access/login', body: { employeeName: '外部验收员工', password: 'synthetic-external-only' } };
    new AccessLoginRedactionMiddleware().use(request as never, {} as never, () => undefined);
    expect(JSON.stringify(request.body)).toBe('{}');
    const controller = new UnifiedAccessController(access, {} as never);
    const result = await controller.login(request.body, { headers: {}, ip: 'test', protocol: 'http', socket: {} } as never, { setHeader: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() } as never);
    expect(result).toMatchObject({ role: 'guest', displayName: '外部验收员工' });
    const mutation = { originalUrl: '/api/access/configuration/accounts', body: { buildings: ['A楼', 'H楼'], specialties: ['暖通'] } };
    new AccessLoginRedactionMiddleware().use(mutation as never, {} as never, () => undefined);
    expect(mutation.body).toEqual({ buildings: ['A楼', 'H楼'], specialties: ['暖通'] });
  });
  it('前端确认已登录游客身份，并拒绝匿名、串号或旧版本响应', async () => {
    await sync();
    const login = await access.login({ employeeName: '外部验收员工', password: 'synthetic-external-only' }, 'test');
    const submitted = { ...login.principal, principalFingerprint: login.principalFingerprint };
    expect(isConfirmedLoginSession(submitted, submitted)).toBe(true);
    expect(isConfirmedLoginSession({ role: 'guest', purchaseBuilding: null, principalFingerprint: null }, { role: 'guest', purchaseBuilding: null, principalFingerprint: null })).toBe(false);
    expect(isConfirmedLoginSession(submitted, { ...submitted, accountId: 'different' })).toBe(false);
    expect(isConfirmedLoginSession(submitted, { ...submitted, authorizationVersion: 100 })).toBe(false);
  });
  it('人员接口只返回展示资料，不返回外部员工凭据摘要', async () => {
    const credentials = await buildExternalEmployeeCredentials(rows(), process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic');
    const actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    const session = access.issueTrustedSession(actor);
    const controller = new AccessConfigurationController(configuration, { read: async () => ({ people: [], externalEmployees: credentials }) } as never, access, {} as never);
    const response = await controller.people({ headers: { cookie: `${access.cookieName}=${session.token}` } } as never);
    expect(JSON.stringify(response)).not.toMatch(/passwordHash|scrypt\$|externalEmployees|synthetic-external-only/);
  });
  it('直接读取限定视图与字段，分页失败不传播 Axios 的凭据响应', async () => {
    const fields = [{ field_name: '姓名', type: 1 }, { field_name: '密码', type: 1 }, { field_name: '离职/异动情况', type: 7 }];
    const views = [{ view_id: 'vewrQcypV4', view_name: '在职人员' }, { view_id: 'vewExternalTest', view_name: '外部账号人员' }];
    const post = jest.fn().mockResolvedValue({ data: { code: 0, data: { items: rows(), has_more: false } } });
    const employees = await readExternalEmployeeCredentials({ axiosRef: { post } } as never, process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic', 'synthetic-token', fields, views);
    expect(employees).toHaveLength(1);
    expect(post.mock.calls.map(call => call[1])).toEqual(views.map(view => ({ view_id: view.view_id, field_names: ['姓名', '密码', '离职/异动情况'] })));
    post.mockRejectedValue({ message: 'synthetic-external-only', response: { data: rows() } });
    await expect(readExternalEmployeeCredentials({ axiosRef: { post } } as never, process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic', 'synthetic-token', fields, views)).rejects.toThrow('外部员工资料读取失败');
    post.mockResolvedValue({ data: { code: 0, data: { items: rows(), has_more: true, page_token: 'repeat' } } });
    await expect(readExternalEmployeeCredentials({ axiosRef: { post } } as never, process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic', 'synthetic-token', fields, views)).rejects.toThrow('外部员工资料读取失败');
    await expect(readExternalEmployeeCredentials({ axiosRef: { post } } as never, process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic', 'synthetic-token', fields, [])).rejects.toThrow();
  });
});
