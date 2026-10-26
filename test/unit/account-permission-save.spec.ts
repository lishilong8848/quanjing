import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { AccountMutation } from '../../shared/access-configuration.interface';
import { canPerformBusinessAction } from '../../shared/business-permissions';
import { optionalAccountPermissions } from '../../client/src/pages/SystemConfiguration/account-mutation';
import { editPersonalPermission } from '../../client/src/pages/SystemConfiguration/personal-permission-editing';
import { AccessLoginRedactionMiddleware } from '../../server/common/access/access-login-redaction.middleware';

describe('账号角色与多选个人规则保存闭环', () => {
  const savedEnvironment = { ...process.env };
  let directory: string, root: string, configuration: AccessConfigurationService, actor: AccessPrincipal;
  const appId = 'cli_permission_save_synthetic';
  beforeEach(() => {
    root = realpathSync(tmpdir()); directory = mkdtempSync(join(root, 'nt-permission-save-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword(randomBytes(32).toString('hex'));
    process.env.FEISHU_APP_ID = appId; process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    configuration = new AccessConfigurationService();
    actor = new UnifiedAccessService(configuration).issueTrustedSession(configuration.localTargets().find(item => item.principal.role === 'admin')!.principal).principal;
  });
  afterEach(() => {
    process.env = { ...savedEnvironment };
    if (resolve(dirname(directory)).toLowerCase() !== resolve(root).toLowerCase() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('测试目录归属异常，保留现场');
    rmSync(directory, { recursive: true, force: false });
  });
  const create = (): AccountMutation => ({ clientMutationId: 'synthetic-account-create', expectedRevision: 0, kind: 'feishu', name: '合成权限人员', openId: 'ou_permission_save_synthetic', external: true, role: 'editor', building: null, enabled: true });
  it('实际角色请求保存、回读、重启与旧会话撤销', async () => {
    const before = await configuration.saveAccount(create(), actor);
    const original = before.accounts.find(item => item.openId === create().openId)!;
    const rules = editPersonalPermission([], { module: 'inventory', buildings: ['A楼', 'C楼'], specialties: ['电气', '暖通'] }, 'update', 'deny', () => 'synthetic-update-deny');
    const request: AccountMutation = { ...create(), id: original.id, clientMutationId: 'synthetic-role-save-001', expectedRevision: before.revision, role: 'professional_engineer', building: 'A楼', buildings: ['A楼', 'C楼'], specialties: ['电气', '暖通'], ...optionalAccountPermissions(original, rules, []) };
    const result = await configuration.saveAccount(request, actor);
    await configuration.saveAccount(request, actor);
    expect(configuration.snapshot().revision).toBe(result.revision);
    const restarted = new AccessConfigurationService(), principal = restarted.feishuPrincipal(create().openId!, appId)!;
    expect(principal).toMatchObject({ role: 'professional_engineer', buildings: ['A楼', 'C楼'], specialties: ['电气', '暖通'], personalRules: rules });
    for (const building of ['A楼', 'C楼']) for (const specialty of ['电气', '暖通']) {
      expect(canPerformBusinessAction(principal, { module: 'inventory', action: 'read', building, specialty })).toBe(true);
      expect(canPerformBusinessAction(principal, { module: 'inventory', action: 'update', building, specialty })).toBe(false);
    }
    expect(canPerformBusinessAction(principal, { module: 'inventory', action: 'read', building: 'B楼', specialty: '电气' })).toBe(false);
    expect(restarted.validateSession(original.id, original.version, 'editor', null)).toBe(false);
    const saved = result.accounts.find(item => item.id === original.id)!;
    const restored = await restarted.saveAccount({ ...request, role: 'professional_admin', building: null, buildings: undefined, expectedRevision: result.revision, clientMutationId: 'synthetic-role-save-002', ...optionalAccountPermissions(saved, [], []) }, actor);
    expect(restored.accounts.find(item => item.id === original.id)).toMatchObject({ role: 'professional_admin', personalRules: [] });
  });
  it('版本冲突与未知字段不改变持久化字节', async () => {
    await configuration.saveAccount(create(), actor);
    const path = join(directory, 'configuration.json'), bytes = readFileSync(path);
    await expect(configuration.saveAccount({ ...create(), clientMutationId: 'synthetic-stale-request' }, actor)).rejects.toThrow('配置已更新');
    await expect(configuration.saveAccount({ ...create(), expectedRevision: 1, unexpectedField: 'synthetic-private-value' } as never, actor)).rejects.toThrow('不支持的字段');
    expect(readFileSync(path)).toEqual(bytes);
  });
  it('经过生产脱敏中间件仍保留个人规则和页面字段，再由服务端校验持久化', async () => {
    const rules = editPersonalPermission([], { module: 'inventory', buildings: ['A楼', 'C楼'], specialties: ['电气', '暖通'] }, 'update', 'deny', () => 'synthetic-middleware-rule');
    const request = { originalUrl: '/api/access/configuration/accounts', body: { ...create(), personalRules: rules, pagePaths: ['/operations-kb'] } };
    new AccessLoginRedactionMiddleware().use(request as never, {} as never, () => undefined);
    await expect(configuration.saveAccount(request.body, actor)).resolves.toMatchObject({ accounts: expect.arrayContaining([expect.objectContaining({ name: '合成权限人员', personalRules: rules, pagePaths: ['/operations-kb'] })]) });
    expect(Object.keys(request.body)).not.toContain('openId');
  });
  it('新增合法字段后，未知字段与畸形个人权限仍拒绝写入', async () => {
    await configuration.saveAccount(create(), actor);
    const original = configuration.snapshot().accounts.find(item => item.openId === create().openId)!, bytes = readFileSync(join(directory, 'configuration.json'));
    for (const extra of [{ unknown: true }, { personalRules: [{ id: 'malformed' }] }]) {
      const request = { originalUrl: '/api/access/configuration/accounts', body: { ...create(), id: original.id, expectedRevision: configuration.snapshot().revision, clientMutationId: 'synthetic-invalid-personal', ...extra } };
      new AccessLoginRedactionMiddleware().use(request as never, {} as never, () => undefined);
      await expect(configuration.saveAccount(request.body as AccountMutation, actor)).rejects.toThrow();
      expect(readFileSync(join(directory, 'configuration.json'))).toEqual(bytes);
    }
  });
});
