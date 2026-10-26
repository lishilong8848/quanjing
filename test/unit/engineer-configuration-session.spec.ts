import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { buildSiteMemberDirectory } from '../../server/common/access/site-member-directory';
import type { AccountMutation } from '../../shared/access-configuration.interface';
import type { PersonalPermissionRule } from '../../shared/business-permissions';

describe('工程师配置、同步和双登录会话', () => {
  const saved = { ...process.env }, appId = 'cli_engineer_fixture';
  let root: string, configuration: AccessConfigurationService, access: UnifiedAccessService;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-engineer-config-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(root, 'accounts.json');
    process.env.FEISHU_APP_ID = appId; process.env.FEISHU_APP_SECRET = 'synthetic-only';
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-only');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    configuration = new AccessConfigurationService(); access = new UnifiedAccessService(configuration);
  });
  afterEach(() => { process.env = { ...saved }; rmSync(root, { recursive: true, force: true }); });
  async function sync(building = 'B楼') {
    const records = [{ record_id: 'recEngineer', fields: { 姓名: '验收工程师', 密码: 'synthetic-engineer-only', 员工姓名: [{ id: 'ou_engineer', name: '验收工程师' }], 岗位: '电气工程师', 体系岗位: '电气专业工程师', '机楼/专业': [building] } }];
    const externalEmployees = await buildExternalEmployeeCredentials(records, appId, 'fixture', 'table');
    const { members: activeMembers } = buildSiteMemberDirectory(records, appId, 'fixture', 'table');
    return configuration.synchronizePersonnel({ appId, people: [], employees: [], snapshotAt: Date.now(), personnelComplete: true, externalEmployees, activeMembers });
  }
  function change(rules: PersonalPermissionRule[], mutationId = 'engineer-permission-change'): AccountMutation {
    const state = configuration.snapshot(), account = state.accounts.find(item => item.openId === 'ou_engineer')!;
    return { clientMutationId: mutationId, expectedRevision: state.revision, id: account.id, kind: account.kind, name: account.name,
      role: account.role, building: account.building, buildings: account.buildings, specialties: account.specialties, enabled: true, personalRules: rules };
  }
  const extra: PersonalPermissionRule = { id: 'extra-a', module: 'inventory', effect: 'allow', buildings: ['A楼'], specialties: ['电气'], actions: ['read'] };
  it('双登录签发工程师，读取和续期保持范围', async () => {
    await sync();
    const local = await access.login({ employeeName: '验收工程师', password: 'synthetic-engineer-only' }, 'fixture');
    const feishu = access.issueTrustedSession(configuration.feishuPrincipal('ou_engineer', appId)!);
    for (const session of [local, feishu]) {
      expect(session.principal).toMatchObject({ role: 'professional_engineer', buildings: ['B楼'], specialties: ['电气'], displayName: '验收工程师' });
      expect(access.readSession(session.token).principal).toEqual(session.principal);
      expect(access.renew(session.token)?.principal).toEqual(session.principal);
    }
  });
  it('保存一次独立规则原子应用两种身份、审计幂等、撤销两种旧会话', async () => {
    await sync();
    const sessions = [await access.login({ employeeName: '验收工程师', password: 'synthetic-engineer-only' }, 'fixture'), access.issueTrustedSession(configuration.feishuPrincipal('ou_engineer', appId)!)];
    const request = change([extra]); const actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    const first = await configuration.saveAccount(request, actor); await configuration.saveAccount(request, actor);
    const linked = configuration.snapshot().accounts.filter(item => item.name === '验收工程师');
    expect(linked).toHaveLength(2); expect(linked.every(item => JSON.stringify(item.personalRules) === JSON.stringify([extra]))).toBe(true);
    expect(configuration.snapshot().revision).toBe(first.revision);
    expect(linked.every(item => item.permissionSource === 'personnel')).toBe(true);
    for (const session of sessions) expect(access.readSession(session.token).principal.role).toBe('guest');
    expect(access.issueTrustedSession(configuration.feishuPrincipal('ou_engineer', appId)!).principal.personalRules).toEqual([extra]);
  });
  it('每天默认楼栋变化保留个人规则，恢复继承只清空规则', async () => {
    await sync(); const actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    await configuration.saveAccount(change([extra]), actor);
    await sync('C楼');
    const accounts = configuration.snapshot().accounts.filter(item => item.name === '验收工程师');
    expect(accounts.every(item => item.building === 'C楼' && item.personalRules?.length === 1)).toBe(true);
    await configuration.saveAccount(change([], 'engineer-restore-default'), actor);
    expect(configuration.snapshot().accounts.filter(item => item.name === '验收工程师').every(item => item.personalRules?.length === 0)).toBe(true);
  });
  it('非法规则和版本冲突不改变持久配置', async () => {
    await sync(); const actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    const before = configuration.snapshot();
    await expect(configuration.saveAccount(change([{ ...extra, actions: ['configure'] } as never]), actor)).rejects.toThrow();
    expect(configuration.snapshot()).toEqual(before);
    await expect(configuration.saveAccount({ ...change([extra]), expectedRevision: before.revision - 1 }, actor)).rejects.toThrow();
    expect(configuration.snapshot()).toEqual(before);
  });
});
