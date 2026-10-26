import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessConfigurationService } from './access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from './unified-access.service';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { AccountMutation } from '../../../shared/access-configuration.interface';

describe('managed access authorization', () => {
  const savedEnvironment = { ...process.env };
  let directory: string, configuration: AccessConfigurationService, access: UnifiedAccessService, actor: AccessPrincipal;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'vnet-access-service-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('admin-test-only-123');
    process.env.LOCAL_EDITOR_PASSWORD_HASH = hashAccessPassword('editor-test-only-123');
    process.env.FEISHU_APP_ID = 'cli_access_test';
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    configuration = new AccessConfigurationService();
    access = new UnifiedAccessService(configuration);
    actor = access.issueTrustedSession(configuration.localTargets().find(target => target.principal.role === 'admin')!.principal).principal;
  });
  afterEach(() => { process.env = { ...savedEnvironment }; rmSync(directory, { recursive: true, force: true }); });
  const update = (values: Partial<AccountMutation> = {}): AccountMutation => ({ clientMutationId: 'service-mutation-001', expectedRevision: 0,
    id: 'local-editor-all', kind: 'local', name: '值班共享入口', role: 'editor', building: null, enabled: true, ...values });

  it('preserves password-only login and returns a stable managed identity', async () => {
    const session = await access.login({ password: 'editor-test-only-123' }, 'test');
    expect(session.principal).toMatchObject({ role: 'editor', accountId: 'local-editor-all', authorizationVersion: 1 });
    expect(access.readSession(session.token).principal).toEqual(session.principal);
  });
  it('displays directory names for configured Feishu identities without changing authorization', async () => {
    await configuration.saveAccount(update({ id: undefined, kind: 'feishu', openId: 'ou_example', name: '旧姓名', role: 'editor' }), actor);
    const before = configuration.snapshot();
    const enriched = configuration.enrichedSnapshot([{ openId: 'ou_example', name: '真实姓名' }]);
    expect(enriched.accounts.find(account => account.openId === 'ou_example')).toMatchObject({ name: '真实姓名', role: 'editor', version: 1 });
    expect(configuration.snapshot()).toEqual(before);
    process.env.FEISHU_APP_ID = 'cli_another';
    expect(configuration.enrichedSnapshot([{ openId: 'ou_example', name: '其他应用姓名' }]).accounts.find(account => account.openId === 'ou_example')?.name).toBe('旧姓名');
  });
  it('clarifies legacy local display names without changing stored account or password', async () => {
    await configuration.saveAccount(update(), actor);
    expect(configuration.snapshot().accounts.find(account => account.id === 'local-editor-all')?.name).toBe('值班密码登录');
    await expect(access.login({ password: 'editor-test-only-123' }, 'test')).resolves.toMatchObject({ principal: { accountId: 'local-editor-all' } });
  });
  it('persists manual external grouping and app binding, remains idempotent and keeps explicit names', async () => {
    const request = update({ id: undefined, kind: 'feishu', openId: 'ou_external', name: '外部合成人员', external: true, role: 'inventory_admin', building: 'A楼' });
    await configuration.saveAccount(request, actor);
    await configuration.saveAccount(request, actor);
    const restarted = new AccessConfigurationService();
    const account = restarted.snapshot().accounts.find(account => account.openId === 'ou_external');
    expect(account).toMatchObject({ name: '外部合成人员', external: true, role: 'inventory_admin', building: 'A楼' });
    expect(restarted.snapshot().revision).toBe(1);
    expect(restarted.enrichedSnapshot([{ openId: 'ou_external', name: '目录其他显示名' }]).accounts.find(account => account.openId === 'ou_external')?.name).toBe('外部合成人员');
    expect(restarted.feishuPrincipal('ou_external', 'cli_another')).toBeNull();
    await expect(configuration.saveAccount(update({ expectedRevision: 1, external: true, clientMutationId: 'external-local-invalid' }), actor)).rejects.toThrow('只能使用飞书');
  });
  it('revokes old identity sessions on password reset and persists new login after restart', async () => {
    const session = await access.login({ password: 'editor-test-only-123' }, 'test');
    await configuration.saveAccount(update({ password: 'changed-test-only-123' }), actor);
    expect(access.readSession(session.token).principal.role).toBe('guest');
    await expect(access.login({ password: 'editor-test-only-123' }, 'test')).rejects.toThrow('登录凭据无效');
    const restarted = new UnifiedAccessService(new AccessConfigurationService());
    await expect(restarted.login({ password: 'changed-test-only-123' }, 'test')).resolves.toMatchObject({ principal: { role: 'editor', authorizationVersion: 2 } });
  });
  it('revokes all unmapped legacy cookies on the first account mutation only', async () => {
    const legacy = new UnifiedAccessService().issueTrustedSession({ role: 'admin', purchaseBuilding: null });
    expect(access.readSession(legacy.token).principal.role).toBe('admin');
    await configuration.saveAccount(update(), actor);
    expect(access.readSession(legacy.token).principal.role).toBe('guest');
    expect(access.readSession(access.issueTrustedSession(actor as never).token).principal.role).toBe('admin');
  });
  it('rejects duplicate passwords without leaking them into responses or audit', async () => {
    await expect(configuration.saveAccount(update({ password: 'admin-test-only-123' }), actor)).rejects.toThrow('此密码已用于');
    const result = await configuration.saveAccount(update({ password: 'new-test-only-123' }), actor);
    expect(JSON.stringify(result)).not.toMatch(/new-test-only|passwordHash|scrypt\$/);
  });
  it('refuses last-admin deletion and arbitrary local account creation', async () => {
    await expect(configuration.saveAccount(update({ id: 'local-admin-all', role: 'admin', enabled: false }), actor)).rejects.toThrow('至少一个可用管理员');
    await expect(configuration.saveAccount(update({ id: undefined }), actor)).rejects.toThrow('已有本地共享入口');
  });
  it('deletes a default account without falling back to its environment password', async () => {
    await configuration.saveAccount(update({ deleted: true, enabled: false }), actor);
    await expect(new UnifiedAccessService(new AccessConfigurationService()).login({ password: 'editor-test-only-123' }, 'test')).rejects.toThrow('登录凭据无效');
    expect(configuration.snapshot().accounts.find(account => account.id === 'local-editor-all')?.deleted).toBe(true);
  });
  it('rejects invalid role scope and identity substitution', async () => {
    await expect(configuration.saveAccount(update({ role: 'inventory_admin', building: '110站' }), actor)).rejects.toThrow('角色或楼栋');
    await expect(configuration.saveAccount(update({ kind: 'feishu', openId: 'ou_test' }), actor)).rejects.toThrow('稳定身份');
  });
  it('does not allow a revoked actor to make another mutation', async () => {
    await configuration.saveAccount(update({ id: 'local-admin-all', role: 'admin', password: 'new-admin-only-123' }), actor);
    await expect(configuration.saveAccount(update({ expectedRevision: 1, clientMutationId: 'service-mutation-002' }), actor)).rejects.toThrow('管理权限已变化');
  });
  it('binds Feishu grants to the application and persists explicit denial', async () => {
    const grant = update({ id: undefined, kind: 'feishu', openId: 'ou_example', name: '示例人员016', role: 'purchase_admin' });
    await configuration.saveAccount(grant, actor);
    expect(configuration.feishuPrincipal('ou_example', 'cli_access_test')?.role).toBe('purchase_admin');
    expect(configuration.feishuPrincipal('ou_example', 'cli_another')).toBeNull();
    const account = configuration.snapshot().accounts.find(account => account.openId === 'ou_example')!;
    await configuration.saveAccount({ ...grant, id: account.id, deleted: true, enabled: false, expectedRevision: 1, clientMutationId: 'service-mutation-003' }, actor);
    expect(configuration.feishuPrincipal('ou_example', 'cli_access_test')).toBeNull();
  });
  it('keeps card-only identities separate, accepts explicit empty notification lists and supports restoring defaults', async () => {
    const request = { clientMutationId: 'card-mutation-0001', expectedRevision: 0, code: 'contract_notify' as const, building: null, members: [] };
    await configuration.saveCardRule(request, actor);
    expect(configuration.cardMembers('contract_notify', null)).toEqual([]);
    expect(configuration.feishuPrincipal('ou_card_only', 'cli_access_test')).toBeNull();
    const restored = await configuration.saveCardRule({ ...request, clientMutationId: 'card-mutation-0002', expectedRevision: 1, restoreDefault: true }, actor);
    expect(restored.audit[0]).toMatchObject({ target: '合同通知人员 · 全基地', before: '无人接收', after: '沿用现有配置' });
    expect(configuration.cardMembers('contract_notify', null)).toBeNull();
  });
  it('rejects a missing person name, wrong card scope and cross-application card routing', async () => {
    const request = { clientMutationId: 'card-invalid-mutation-01', expectedRevision: 0, code: 'purchase_manager' as const, building: null, members: [{ openId: 'ou_example' }] };
    await expect(configuration.saveCardRule(request as never, actor)).rejects.toThrow('人数无效');
    await expect(configuration.saveCardRule({ ...request, building: 'A楼', members: [{ openId: 'ou_example', name: '示例人员016' }] }, actor)).rejects.toThrow('人数无效');
    await configuration.saveCardRule({ ...request, members: [{ openId: 'ou_example', name: '示例人员016' }] }, actor);
    process.env.FEISHU_APP_ID = 'cli_other_application';
    expect(() => configuration.cardMembers('purchase_manager', null)).toThrow('其他飞书应用');
  });
});
