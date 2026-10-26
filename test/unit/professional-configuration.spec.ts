import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { AccessPersonnelSyncService, personnelSyncDay } from '../../server/common/access/access-personnel-sync.service';
import { PROFESSIONAL_DEFAULTS } from '../../server/common/access/access-professional-defaults';
import { APPROVED_FEISHU_APP_ID } from '../../server/common/access/feishu-access-approved-grants';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { AccessPrincipal } from '../../shared/access-control.interface';

describe('专业配置、会话与人员对齐', () => {
  const saved = { ...process.env };
  let directory: string, configuration: AccessConfigurationService, access: UnifiedAccessService, actor: AccessPrincipal;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'professional-config-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'config.json');
    process.env.FEISHU_APP_ID = APPROVED_FEISHU_APP_ID;
    process.env.FEISHU_APP_SECRET = 'test-only-placeholder';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-only');
    configuration = new AccessConfigurationService(); access = new UnifiedAccessService(configuration);
    actor = configuration.localTargets().find(value => value.principal.role === 'admin')!.principal;
  });
  afterEach(() => { process.env = { ...saved }; rmSync(directory, { recursive: true, force: true }); });
  const snapshot = (): ConfigurationDirectorySnapshot => ({ appId: APPROVED_FEISHU_APP_ID, people: [], snapshotAt: Date.now(), personnelComplete: true,
    employees: PROFESSIONAL_DEFAULTS.map(person => ({ ...person, specialties: person.specialties.join('、'), position: '专业示例人员001', inactive: false })) });

  it('五人默认专业正确且没有本地专业示例人员001', () => {
    for (const person of PROFESSIONAL_DEFAULTS) expect(configuration.feishuPrincipal(person.openId, APPROVED_FEISHU_APP_ID)).toMatchObject({ role: 'professional_admin', displayName: person.name, specialties: person.specialties });
    expect(configuration.localTargets().some(value => value.principal.role === 'professional_admin')).toBe(false);
    expect(configuration.feishuPrincipal(PROFESSIONAL_DEFAULTS[0].openId, 'cli_other')).toBeNull();
  });
  it('专业范围签名、续期保留；调岗后旧会话撤销', async () => {
    const principal = configuration.feishuPrincipal(PROFESSIONAL_DEFAULTS[1].openId, APPROVED_FEISHU_APP_ID)!;
    const session = access.issueTrustedSession(principal);
    expect(access.readSession(session.token).principal).toEqual(principal);
    expect(access.renew(session.token)?.principal.specialties).toEqual(['暖通']);
    await configuration.synchronizePersonnel(snapshot());
    const changed = snapshot(); changed.employees[1].specialties = '电气';
    await configuration.synchronizePersonnel(changed);
    expect(access.readSession(session.token).principal.role).toBe('guest');
    expect(configuration.feishuPrincipal(PROFESSIONAL_DEFAULTS[1].openId, APPROVED_FEISHU_APP_ID)?.specialties).toEqual(['电气']);
  });
  it('拒绝本地角色、空专业与无配置会话', async () => {
    await expect(configuration.saveAccount({ clientMutationId: 'local-professional-invalid', expectedRevision: 0, id: 'local-admin-all', kind: 'local', name: '测试', role: 'professional_admin', building: null, specialties: ['暖通'], enabled: true }, actor)).rejects.toThrow();
    expect(() => access.issueTrustedSession({ role: 'professional_admin', purchaseBuilding: null, specialties: [] })).toThrow();
    expect(() => new UnifiedAccessService().issueTrustedSession({ role: 'professional_admin', purchaseBuilding: null, specialties: ['暖通'], accountId: 'feishu-example', authorizationVersion: 1 })).toThrow();
  });
  it('确认离职撤授权，缺失人员保留；幂等重复不改账号版本', async () => {
    const first = snapshot(); first.employees = first.employees.slice(0, 2); first.employees[0].inactive = true;
    await configuration.synchronizePersonnel(first);
    expect(configuration.feishuPrincipal(first.employees[0].openId, APPROVED_FEISHU_APP_ID)).toBeNull();
    expect(configuration.feishuPrincipal(PROFESSIONAL_DEFAULTS[2].openId, APPROVED_FEISHU_APP_ID)?.role).toBe('professional_admin');
    const accounts = configuration.snapshot().accounts;
    await configuration.synchronizePersonnel({ ...first, snapshotAt: Date.now() });
    expect(configuration.snapshot().accounts).toEqual(accounts);
    expect(new AccessConfigurationService().snapshot().personnelSync?.status).toBe('success');
  });
  it('手工覆盖不会被表同步修改', async () => {
    const account = configuration.snapshot().accounts.find(value => value.openId === PROFESSIONAL_DEFAULTS[1].openId)!;
    await configuration.saveAccount({ clientMutationId: 'manual-professional-override', expectedRevision: 0, id: account.id, kind: 'feishu', openId: account.openId, name: account.name, role: 'professional_admin', specialties: ['暖通', '消防'], building: null, enabled: false }, actor);
    await configuration.synchronizePersonnel(snapshot());
    expect(configuration.snapshot().accounts.find(value => value.id === account.id)).toMatchObject({ specialties: ['暖通', '消防'], enabled: false, permissionSource: 'manual', version: 2 });
  });
  it('失败及不完整快照不产生半份权限变更，状态可恢复', async () => {
    const before = configuration.snapshot().accounts;
    const invalid = snapshot(); invalid.employees[0].specialties = '暖通'; invalid.employees[1].position = '';
    await expect(configuration.synchronizePersonnel(invalid)).rejects.toThrow();
    expect(configuration.snapshot().accounts).toEqual(before);
    await expect(configuration.synchronizePersonnel({ ...snapshot(), personnelComplete: false })).rejects.toThrow();
    const service = new AccessPersonnelSyncService(configuration, { read: jest.fn().mockRejectedValue(new Error('synthetic source outage')) } as never);
    await expect(service.run()).rejects.toThrow('synthetic source outage');
    expect(configuration.snapshot().accounts).toEqual(before);
    expect(configuration.snapshot().personnelSync?.status).toBe('error');
    await configuration.synchronizePersonnel(snapshot());
    expect(configuration.snapshot().personnelSync?.status).toBe('success');
  });
  it('首次保留消防和EHS，后续表专业变化才调整范围', async () => {
    const first = snapshot(); first.employees[3].specialties = '消防、H楼'; first.employees[4].specialties = '安全、H楼';
    await configuration.synchronizePersonnel(first);
    expect(configuration.feishuPrincipal(first.employees[3].openId, APPROVED_FEISHU_APP_ID)?.specialties).toEqual(['消防', 'EHS']);
    expect(configuration.feishuPrincipal(first.employees[4].openId, APPROVED_FEISHU_APP_ID)?.specialties).toEqual(['消防', 'EHS']);
    first.employees[3].specialties = '电气、H楼';
    await configuration.synchronizePersonnel({ ...first, snapshotAt: Date.now() });
    expect(configuration.feishuPrincipal(first.employees[3].openId, APPROVED_FEISHU_APP_ID)?.specialties).toEqual(['电气']);
  });
  it('关联身份冲突整批保留，无关重复身份不阻断同步', async () => {
    const invalid = snapshot(); invalid.employees.push({ ...invalid.employees[0], name: '冲突人员' });
    const before = configuration.snapshot().accounts;
    await expect(configuration.synchronizePersonnel(invalid)).rejects.toThrow('身份冲突');
    expect(configuration.snapshot().accounts).toEqual(before);
    const valid = snapshot(); valid.employees.push({ ...valid.employees[0], openId: 'ou_synthetic_unmanaged', name: '示例人员004员' }, { ...valid.employees[1], openId: 'ou_synthetic_unmanaged', name: '示例人员004员2' });
    await configuration.synchronizePersonnel(valid);
    expect(configuration.snapshot().personnelSync?.status).toBe('success');
  });
  it('旧配置只迁移一次，新角色手工修改后重启仍保留', async () => {
    const person = PROFESSIONAL_DEFAULTS[0], account = configuration.snapshot().accounts.find(value => value.openId === person.openId)!;
    const store = (configuration as unknown as { store: { mutate: Function } }).store;
    await store.mutate(0, 'migration-fixture-key', 'migration-fixture-fingerprint', state => { state.accounts[account.id] = { ...account, role: 'editor', specialties: undefined, version: 8 }; });
    await Promise.all([configuration.onModuleInit(), configuration.onModuleInit()]);
    expect(configuration.feishuPrincipal(person.openId, APPROVED_FEISHU_APP_ID)).toMatchObject({ role: 'professional_admin', specialties: ['电气'], authorizationVersion: 9 });
    await configuration.saveAccount({ clientMutationId: 'professional-after-migration', expectedRevision: configuration.snapshot().revision, id: account.id, kind: 'feishu', openId: person.openId, name: person.name, role: 'professional_admin', specialties: ['暖通'], building: null, enabled: false }, actor);
    const before = configuration.snapshot();
    const restarted = new AccessConfigurationService(); await restarted.onModuleInit();
    expect(restarted.snapshot()).toEqual(before);
  });
  it('调度按北京时间02:00，不受主机时区影响', () => {
    expect(personnelSyncDay(new Date('2026-10-09T17:59:59Z'))).toBeNull();
    expect(personnelSyncDay(new Date('2026-10-09T18:00:00Z'))).toBe('2026-10-10');
  });
});
