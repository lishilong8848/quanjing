import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { PersonnelPermissionRequestsService } from '../../server/common/access/personnel-permission-requests.service';
import { PersonnelPermissionRequestsStore } from '../../server/common/access/personnel-permission-requests.store';
import { hashAccessPassword } from '../../server/common/access/unified-access.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { createProcessLockOwner } from '../../server/common/process-lock-owner';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { CreatePersonnelPermissionRequest, RequestedPermission, ReviewPersonnelPermissionRequest } from '../../shared/personnel-permission-request.interface';
import type { PersonalPermissionRule } from '../../shared/business-permissions';

describe('personnel permission requests use actual permissions without assigning grants', () => {
  const appId = 'cli_permission_requests_test';
  const ids = ['applicant', 'other', 'reviewer'].map(label => `feishu-${feishuIdentityFingerprint(appId, `ou_${label}`)}`);
  const adminHash = hashAccessPassword('synthetic-only-admin-password');
  let dir: string, owner: string, configStore: stores.AccessConfigurationStore, config: AccessConfigurationService;
  let ledger: PersonnelPermissionRequestsStore, service: PersonnelPermissionRequestsService, admin: AccessPrincipal, applicant: AccessPrincipal;
  let saved: Record<string, string | undefined>;
  const permission = (): RequestedPermission => ({ kind: 'action', module: 'inventory', action: 'create', buildings: ['A楼'], specialties: ['电气'] });
  const input = (extra: Partial<CreatePersonnelPermissionRequest> = {}): CreatePersonnelPermissionRequest => ({ clientMutationId: randomUUID(), permissions: [permission()], reason: '工作需要\n办理出库', ...extra });
  const reviewInput = (requestId: string, extra: Partial<ReviewPersonnelPermissionRequest> = {}): ReviewPersonnelPermissionRequest => ({ clientMutationId: randomUUID(), requestId, expectedRequestVersion: 1, decision: 'approve', ...extra });
  const grantRule = (extra: Partial<PersonalPermissionRule> = {}): PersonalPermissionRule => ({ id: 'synthetic-grant', module: 'inventory', actions: ['create'], effect: 'allow', buildings: ['A楼'], specialties: ['电气'], ...extra });
  beforeEach(() => {
    saved = Object.fromEntries(['FEISHU_APP_ID','FEISHU_APP_SECRET','LOCAL_ACCESS_SESSION_SECRET'].map(key => [key, process.env[key]]));
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_APP_SECRET = 'synthetic-not-real';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'nt-permission-request-'));
    owner = randomUUID(); writeFileSync(join(dir, '.owner'), owner, { flag: 'wx' });
    configStore = new stores.AccessConfigurationStore(join(dir, 'configuration.json'));
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(configStore);
    const native: Record<string, stores.StoredAccount> = {
      'local-admin-all': { id: 'local-admin-all', kind: 'local', name: '合成管理员', role: 'admin', building: null, enabled: true, deleted: false, version: 1, source: 'default', passwordHash: adminHash },
    };
    ids.forEach((id, index) => {
      const openId = `ou_${['applicant','other','reviewer'][index]}`;
      native[id] = { id, kind: 'feishu', name: `合成人员${index}`, role: index === 2 ? 'admin' : 'guest', building: null,
        enabled: true, deleted: false, version: 1, source: 'default', appId, openId, identityHash: feishuIdentityFingerprint(appId, openId),
        personnelIdentity: `local-external-${feishuIdentityFingerprint(appId, `person-${index}`)}`, siteMember: true, permissionSource: 'manual' };
    });
    jest.spyOn(defaults, 'defaultAccessAccounts').mockReturnValue(native);
    config = new AccessConfigurationService();
    admin = config.currentPrincipal('local-admin-all', 1)!;
    applicant = config.currentPrincipal(ids[0], 1)!;
    ledger = new PersonnelPermissionRequestsStore(join(dir, 'permission-requests.json'));
    service = new PersonnelPermissionRequestsService(config, ledger);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (resolve(dirname(dir)).toLowerCase() !== resolve(realpathSync(tmpdir())).toLowerCase() || readFileSync(join(dir, '.owner'), 'utf8') !== owner) throw new Error('test ownership mismatch');
    rmSync(dir, { recursive: true, force: false });
  });
  async function grant(rules: PersonalPermissionRule[], pages: string[] = [], denyPages: string[] = []) {
    const account = config.snapshot().accounts.find(row => row.id === ids[0])!;
    await config.saveAccount({ clientMutationId: randomUUID(), expectedRevision: configStore.read().revision, id: account.id,
      kind: account.kind, name: account.name, role: account.role, building: account.building, enabled: account.enabled,
      authorizationBinding: { mode: 'independent', policy: { nativeRole: null, pages: [], rules: [] } },
      authorizationOverrides: { rules, allowPages: pages, denyPages } }, admin);
    applicant = config.currentPrincipal(account.id, config.snapshot().accounts.find(row => row.id === account.id)!.version)!;
  }
  it('records only own requests, hides stable identity and never writes authorization configuration', async () => {
    const before = JSON.stringify(configStore.read());
    const row = await service.create(applicant, input());
    expect(row.status).toBe('pending'); expect(row.version).toBe(1); expect(row).not.toHaveProperty('applicantIdentity');
    expect(service.listOwn(applicant)).toEqual([row]);
    expect(service.listOwn(config.currentPrincipal(ids[1], 1)!)).toEqual([]);
    expect(service.listAdmin(admin)).toEqual([row]);
    expect(JSON.stringify(configStore.read())).toBe(before);
  });
  it('replays exact create after restart, conflicts changed reuse, and combines pending duplicates', async () => {
    const body = input(); const first = await service.create(applicant, body);
    const restarted = new PersonnelPermissionRequestsService(config, new PersonnelPermissionRequestsStore(ledger.filePath));
    expect(await restarted.create(applicant, body)).toEqual(first);
    await expect(service.create(applicant, { ...body, reason: 'changed' })).rejects.toThrow('重复提交内容不一致');
    expect((await service.create(applicant, input())).id).toBe(first.id);
    expect(ledger.read().audit).toHaveLength(1);
  });
  it('does not mark approved before current real grants are saved, then verifies without rewriting configuration', async () => {
    const row = await service.create(applicant, input());
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('尚未全部生效');
    expect(ledger.read().requests[row.id].status).toBe('pending');
    await grant([grantRule()]); const before = readFileSync(configStore.filePath, 'utf8');
    const body = reviewInput(row.id); const approved = await service.review(admin, body);
    expect(approved.status).toBe('approved'); expect(approved.verifiedConfigurationRevision).toBe(configStore.read().revision);
    expect(await service.review(admin, body)).toEqual(approved);
    expect(ledger.read().audit).toHaveLength(2);
    expect(readFileSync(configStore.filePath, 'utf8')).toBe(before);
    expect(() => service.listOwn({ ...applicant, authorizationVersion: 1 })).toThrow('登录权限已变化');
  });
  it('requires every requested building-specialty point and honors deny over allow', async () => {
    const requested: RequestedPermission = { ...permission() as Extract<RequestedPermission, { kind: 'action' }>, buildings: ['A楼','B楼'] };
    const row = await service.create(applicant, input({ permissions: [requested] }));
    await grant([grantRule()]);
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('尚未全部生效');
    await grant([grantRule({ buildings: ['A楼','B楼'] }), grantRule({ id: 'cap-deny', effect: 'deny', buildings: ['B楼'] })]);
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('尚未全部生效');
    await grant([grantRule({ buildings: ['A楼','B楼'] })]);
    expect((await service.review(admin, reviewInput(row.id))).status).toBe('approved');
  });
  it('treats null scopes as all actual buildings and specialties, not any matching record', async () => {
    const row = await service.create(applicant, input({ permissions: [{ ...permission() as Extract<RequestedPermission, { kind: 'action' }>, buildings: null, specialties: null }] }));
    await grant([grantRule()]);
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('尚未全部生效');
    await grant([grantRule({ buildings: null, specialties: null })]);
    expect((await service.review(admin, reviewInput(row.id))).status).toBe('approved');
  });
  it('checks page entries through actual page permissions including whole-page deny', async () => {
    const row = await service.create(applicant, input({ permissions: [{ kind: 'page', path: '/inventory-management' }, permission()] }));
    await grant([grantRule({ actions: ['read', 'create'] })], [], ['/inventory-management']);
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('尚未全部生效');
    await grant([grantRule({ actions: ['read', 'create'] })], ['/inventory-management']);
    expect((await service.review(admin, reviewInput(row.id))).status).toBe('approved');
  });
  it('accepts a page made visible by module read permission without a duplicate allowPages edit', async () => {
    const row = await service.create(applicant, input({ permissions: [{ kind: 'page', path: '/inventory-management' }] }));
    await grant([grantRule({ actions: ['read'] })]);
    const raw = config.pagePermissions(applicant.role, applicant.accountId, applicant.authorizationVersion);
    expect(raw.paths).not.toContain('/inventory-management');
    expect(config.effectiveAuthorization(ids[0]).after.overrides.allowPages).toEqual([]);
    expect((await service.review(admin, reviewInput(row.id))).status).toBe('approved');
  });
  it('does not accept a raw page entry when the same session would hide it for lacking read permission', async () => {
    const row = await service.create(applicant, input({ permissions: [{ kind: 'page', path: '/inventory-management' }] }));
    await grant([grantRule()], ['/inventory-management']);
    expect(config.pagePermissions(applicant.role, applicant.accountId, applicant.authorizationVersion).paths).toContain('/inventory-management');
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('尚未全部生效');
    expect(ledger.read().requests[row.id].status).toBe('pending');
  });
  it.each([
    [{ kind: 'page', path: '/system-configuration' }],
    [{ kind: 'page', path: 'https://www.sm.sjhl.online:8787/' }],
    [{ kind: 'action', module: 'organization', action: 'delete', buildings: null, specialties: null }],
    [{ kind: 'action', module: 'inventory', action: '*', buildings: null, specialties: null }],
    [{ kind: 'action', module: 'inventory', action: 'create', buildings: ['*'], specialties: null }],
    [{ kind: 'action', module: 'inventory', action: 'create', buildings: [], specialties: null }],
    [{ kind: 'action', module: 'organization', action: 'read', buildings: ['A楼'], specialties: null }],
  ])('rejects invented/admin/external permissions and illegal scope %#', async permissions => {
    await expect(service.create(applicant, input({ permissions: permissions as RequestedPermission[] }))).rejects.toThrow('权限申请内容无效');
    expect(ledger.read().audit).toEqual([]);
  });
  it('rejects caller-provided identity or grants and bounds text and request size', async () => {
    await expect(service.create(applicant, { ...input(), accountId: ids[1] } as CreatePersonnelPermissionRequest)).rejects.toThrow('内容无效');
    await expect(service.create(applicant, input({ reason: ' ' }))).rejects.toThrow('申请原因');
    await expect(service.create(applicant, input({ reason: 'a'.repeat(501) }))).rejects.toThrow('申请原因');
    await expect(service.create(applicant, input({ permissions: Array.from({ length: 21 }, permission) }))).rejects.toThrow('内容无效');
  });
  it('requires a real current admin, blocks impersonation, self-review, linked identity review and shared self-service', async () => {
    const row = await service.create(applicant, input());
    await expect(service.review(applicant, reviewInput(row.id))).rejects.toThrow('仅系统管理员');
    await expect(service.create(admin, input())).rejects.toThrow('账号当前不能');
    const impersonation = { actorAccountId: admin.accountId!, actorName: '管理员', targetName: '人员', expiresAt: Date.now() + 1000 };
    await expect(service.create({ ...applicant, impersonation }, input())).rejects.toThrow('代登录');
    await expect(service.review({ ...admin, impersonation }, reviewInput(row.id))).rejects.toThrow('代登录');
    const native = (defaults.defaultAccessAccounts as jest.Mock).mock.results[0].value as Record<string, stores.StoredAccount>;
    native[ids[2]].personnelIdentity = native[ids[0]].personnelIdentity;
    // A fresh configuration service rebuilds defaults to simulate an independently verified linked login.
    const linkedConfig = new AccessConfigurationService();
    const linkedService = new PersonnelPermissionRequestsService(linkedConfig, ledger);
    await expect(linkedService.review(linkedConfig.currentPrincipal(ids[2], 1)!, reviewInput(row.id))).rejects.toThrow('本人或关联账号');
  });
  it('rejects disabled targets and stale applicant sessions', async () => {
    const row = await service.create(applicant, input());
    await grant([grantRule()]);
    const account = config.snapshot().accounts.find(item => item.id === ids[0])!;
    await config.saveAccount({ clientMutationId: randomUUID(), expectedRevision: configStore.read().revision, id: account.id, kind: account.kind,
      name: account.name, role: account.role, building: account.building, enabled: false }, admin);
    await expect(service.create(applicant, input())).rejects.toThrow('登录权限已变化');
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('账号当前不能');
    expect(ledger.read().requests[row.id].status).toBe('pending');
    expect((await service.review(admin, reviewInput(row.id, { decision: 'reject', comment: '账号已停用' }))).status).toBe('rejected');
  });
  it('blocks explicit departure records even when the account still has a grant and enabled flag', async () => {
    const row = await service.create(applicant, input());
    await grant([grantRule()]);
    await configStore.mutate(configStore.read().revision, randomUUID(), 'synthetic-departure', state => {
      state.personnelEmployment = { appId, snapshotAt: Date.now(), inactive: { [ids[0]]: true } };
    });
    await expect(service.create(applicant, input())).rejects.toThrow('登录权限已变化');
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('账号当前不能');
    expect(ledger.read().requests[row.id].status).toBe('pending');
    expect((await service.review(admin, reviewInput(row.id, { decision: 'reject', comment: '人员已离职' }))).status).toBe('rejected');
  });
  it('normalizes a personnel password account without an explicit identity to its linked Feishu identity', async () => {
    const native = (defaults.defaultAccessAccounts as jest.Mock).mock.results[0].value as Record<string, stores.StoredAccount>;
    const localId = `local-external-${feishuIdentityFingerprint(appId, 'local-person')}`;
    native[localId] = { id: localId, kind: 'local', name: '合成本人姓名登录', role: 'guest', building: null,
      enabled: true, deleted: false, version: 1, source: 'default', passwordHash: adminHash,
      loginMethod: 'personnel-password', personnelActive: true, personnelAppId: appId, siteMember: true };
    native[ids[2]].personnelIdentity = localId;
    const relatedConfig = new AccessConfigurationService();
    const relatedService = new PersonnelPermissionRequestsService(relatedConfig, ledger);
    const local = relatedConfig.currentPrincipal(localId, 1)!;
    const row = await relatedService.create(local, input());
    const linkedAdmin = relatedConfig.currentPrincipal(ids[2], 1)!;
    await expect(relatedService.review(linkedAdmin, reviewInput(row.id, { decision: 'reject', comment: '不能自审' }))).rejects.toThrow('本人或关联账号');
    expect(relatedService.listOwn(linkedAdmin)[0].id).toBe(row.id);
  });
  it('blocks initial-password-only sessions at the service boundary', async () => {
    await expect(service.create({ ...applicant, requiresPasswordChange: true } as AccessPrincipal, input())).rejects.toThrow('先修改初始密码');
    const row = await service.create(applicant, input());
    await expect(service.review({ ...admin, requiresPasswordChange: true } as AccessPrincipal, reviewInput(row.id, { decision: 'reject', comment: '待处理' }))).rejects.toThrow('先修改初始密码');
    const original = config.currentPrincipal.bind(config);
    jest.spyOn(config, 'currentPrincipal').mockImplementation((id, version) => {
      const principal = original(id, version);
      return principal ? { ...principal, requiresPasswordChange: true } as AccessPrincipal : undefined;
    });
    await expect(service.create(applicant, input())).rejects.toThrow('先修改初始密码');
  });
  it('requires rejection reason, preserves one winner under concurrent reviews, and keeps audit', async () => {
    const row = await service.create(applicant, input());
    await expect(service.review(admin, reviewInput(row.id, { decision: 'reject' }))).rejects.toThrow('审核说明');
    const results = await Promise.allSettled([
      service.review(admin, reviewInput(row.id, { decision: 'reject', comment: '请补充用途' })),
      service.review(admin, reviewInput(row.id, { decision: 'reject', comment: '另一审核意见' })),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(ledger.read().audit).toHaveLength(2);
    expect(ledger.read().requests[row.id].version).toBe(2);
  });
  it('does not create a request when the exact permissions already exist', async () => {
    await grant([grantRule()]);
    await expect(service.create(applicant, input())).rejects.toThrow('已经具备');
    expect(ledger.read().requests).toEqual({});
  });
  it('fails closed on malformed/version-mismatched ledger and refuses a live writer lock', async () => {
    await service.create(applicant, input());
    const good = readFileSync(ledger.filePath, 'utf8');
    writeFileSync(ledger.filePath, good.replace('"schemaVersion":1', '"schemaVersion":2'));
    expect(() => ledger.read()).toThrow('台账无效');
    writeFileSync(ledger.filePath, good);
    writeFileSync(`${ledger.filePath}.lock`, JSON.stringify(createProcessLockOwner(randomUUID())));
    await expect(service.create(applicant, input())).rejects.toThrow('正在保存');
    expect(readFileSync(ledger.filePath, 'utf8')).toBe(good);
  });
  it('does not silently reset a previously persisted ledger that goes missing', async () => {
    await service.create(applicant, input());
    rmSync(ledger.filePath);
    expect(() => service.listAdmin(admin)).toThrow('台账无效');
  });
});
