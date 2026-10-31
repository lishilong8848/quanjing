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
import { createBusinessPermissionEvaluator } from '../../shared/business-permissions';
import { permissionGrantKey } from '../../server/common/access/personnel-permission-grant';

describe('personnel permission requests grant only reviewed business permissions with durable recovery', () => {
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
  function failNextRequestCommit() {
    const nodeFs = require('node:fs') as typeof import('node:fs');
    const rename = nodeFs.renameSync;
    let fail = true;
    jest.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
      if (fail && String(to) === ledger.filePath) { fail = false; throw new Error('synthetic request commit failure'); }
      return rename(from, to);
    });
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
  it('grants the requested scope on approval once and keeps the original receipt on replay', async () => {
    const row = await service.create(applicant, input());
    const body = reviewInput(row.id); const approved = await service.review(admin, body);
    expect(approved.status).toBe('approved'); expect(approved.verifiedConfigurationRevision).toBe(configStore.read().revision);
    expect(approved.currentEffect).toBe('current');
    const account = config.snapshot().accounts.find(item => item.id === ids[0])!;
    const evaluate = createBusinessPermissionEvaluator(config.currentPrincipal(account.id, account.version)!);
    expect(evaluate({ module: 'inventory', action: 'create', building: 'A楼', specialty: '电气' }).allowed).toBe(true);
    expect(evaluate({ module: 'inventory', action: 'create', building: 'B楼', specialty: '电气' }).allowed).toBe(false);
    expect(evaluate({ module: 'inventory', action: 'create', building: 'A楼', specialty: '暖通' }).allowed).toBe(false);
    expect(evaluate({ module: 'purchase', action: 'create', building: 'A楼', specialty: '电气' }).allowed).toBe(false);
    expect(account.role).toBe('guest');
    const before = readFileSync(configStore.filePath, 'utf8');
    expect(await service.review(admin, body)).toEqual(approved);
    expect(ledger.read().audit).toHaveLength(2);
    expect(readFileSync(configStore.filePath, 'utf8')).toBe(before);
    expect(() => service.listOwn({ ...applicant, authorizationVersion: 1 })).toThrow('登录权限已变化');
  });
  it('requires every requested building-specialty point and honors deny over allow', async () => {
    const requested: RequestedPermission = { ...permission() as Extract<RequestedPermission, { kind: 'action' }>, buildings: ['A楼','B楼'] };
    const row = await service.create(applicant, input({ permissions: [requested] }));
    await grant([grantRule({ buildings: ['A楼','B楼'] }), grantRule({ id: 'cap-deny', effect: 'deny', buildings: ['B楼'] })]);
    const before = readFileSync(configStore.filePath, 'utf8');
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('冲突');
    expect(readFileSync(configStore.filePath, 'utf8')).toBe(before);
    await grant([grantRule()]);
    expect((await service.review(admin, reviewInput(row.id))).status).toBe('approved');
  });
  it('treats null scopes as all actual buildings and specialties, not any matching record', async () => {
    const row = await service.create(applicant, input({ permissions: [{ ...permission() as Extract<RequestedPermission, { kind: 'action' }>, buildings: null, specialties: null }] }));
    await grant([grantRule()]);
    expect((await service.review(admin, reviewInput(row.id)))).toMatchObject({status:'approved',currentEffect:'current'});
  });
  it('checks page entries through actual page permissions including whole-page deny', async () => {
    const row = await service.create(applicant, input({ permissions: [{ kind: 'page', path: '/inventory-management' }, permission()] }));
    await grant([grantRule({ actions: ['read', 'create'] })], [], ['/inventory-management']);
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('冲突');
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
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('冲突');
    expect(ledger.read().requests[row.id].status).toBe('pending');
  });
  it.each([
    [{ kind: 'page', path: '/system-configuration' }],
    [{ kind: 'page', path: 'https://unregistered.invalid/' }],
    [{ kind: 'action', module: 'external_twin', action: 'read', buildings: null, specialties: null }],
    [{ kind: 'action', module: 'organization', action: 'delete', buildings: null, specialties: null }],
    [{ kind: 'action', module: 'inventory', action: '*', buildings: null, specialties: null }],
    [{ kind: 'action', module: 'inventory', action: 'create', buildings: ['*'], specialties: null }],
    [{ kind: 'action', module: 'inventory', action: 'create', buildings: [], specialties: null }],
    [{ kind: 'action', module: 'organization', action: 'read', buildings: ['A楼'], specialties: null }],
  ])('rejects invented/admin/external-system actions and illegal scope %#', async permissions => {
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
    writeFileSync(ledger.filePath, good.replace('"schemaVersion":2', '"schemaVersion":3'));
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

  it('edits only the owner pending reason with version, original retry identity and audit', async () => {
    const row = await service.create(applicant, input());
    const edit = { requestId: row.id, expectedRequestVersion: 1, clientMutationId: randomUUID(), reason: '补充工作说明' };
    const updated = await service.update(applicant, edit);
    expect(updated).toMatchObject({ id: row.id, version: 2, reason: edit.reason, status: 'pending' });
    expect(await service.update(applicant, edit)).toEqual(updated);
    expect(ledger.read().audit.map(item => item.action)).toEqual(['create','update']);
    await expect(service.update(applicant, {...edit, reason:'不同内容'})).rejects.toThrow('重复提交内容不一致');
    await expect(service.update(config.currentPrincipal(ids[1],1)!, {...edit,clientMutationId:randomUUID()})).rejects.toThrow('本人的');
    await expect(service.review(admin,reviewInput(row.id,{decision:'reject',comment:'old version'}))).rejects.toThrow('已被处理');
  });

  it('cancels the owner pending request once, refuses stale review and permits a new application', async () => {
    const row = await service.create(applicant,input());
    const body = {requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()};
    const cancelled = await service.cancel(applicant,body);
    expect(cancelled).toMatchObject({status:'cancelled',version:2});
    expect(await service.cancel(applicant,body)).toEqual(cancelled);
    await expect(service.review(admin,reviewInput(row.id,{decision:'reject',comment:'late'}))).rejects.toThrow('已被处理');
    expect((await service.create(applicant,input())).id).not.toBe(row.id);
    expect(service.summaryOwn(applicant)).toMatchObject({total:2,pending:1,cancelled:1,capacity:{level:'normal'}});
    expect(service.summaryOwn(config.currentPrincipal(ids[1],1)!)).toMatchObject({total:0,pending:0});
  });

  it('allows just one winner when cancellation races administrator review', async () => {
    const row = await service.create(applicant,input());
    const results = await Promise.allSettled([service.cancel(applicant,{requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()}),
      service.review(admin,reviewInput(row.id,{decision:'reject',comment:'no longer needed'}))]);
    expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(ledger.read().audit).toHaveLength(2);
  });

  it('reports current/partial/none without rewriting grants or historical approval', async () => {
    const row = await service.create(applicant,input({permissions:[{...permission() as Extract<RequestedPermission,{kind:'action'}>,buildings:['A楼','B楼']}]}));
    await grant([grantRule({buildings:['A楼','B楼']})]);
    expect((await service.review(admin,reviewInput(row.id))).currentEffect).toBe('current');
    await grant([grantRule()]);
    expect(service.listOwn(applicant)[0]).toMatchObject({status:'approved',currentEffect:'partial',currentEffectRevision:configStore.read().revision});
    await grant([]);
    const before = readFileSync(configStore.filePath,'utf8');
    expect(service.listOwn(applicant)[0]).toMatchObject({status:'approved',currentEffect:'none'});
    expect(readFileSync(configStore.filePath,'utf8')).toBe(before);
    expect(ledger.read().requests[row.id]).not.toHaveProperty('currentEffect');
  });

  it('fails closed as unavailable when an approved record no longer has the same identity', async () => {
    const row=await service.create(applicant,input());await grant([grantRule()]);await service.review(admin,reviewInput(row.id));
    const snapshot=config.snapshot.bind(config);
    jest.spyOn(config,'snapshot').mockImplementation(()=>{const value=snapshot();value.accounts.find(item=>item.id===ids[0])!.personnelIdentity='local-external-'+ 'd'.repeat(64);return value;});
    expect(service.listAdmin(admin)[0]).toMatchObject({currentEffect:'unavailable',currentEffectRevision:null});
  });

  it('migrates v1 once under the writer lock and retains the original bytes', async () => {
    const row=await service.create(applicant,input());
    const legacy=JSON.stringify({...ledger.read(),schemaVersion:1},null,2);writeFileSync(ledger.filePath,legacy);
    const migrated=new PersonnelPermissionRequestsStore(ledger.filePath), next=new PersonnelPermissionRequestsService(config,migrated);
    expect(migrated.read().schemaVersion).toBe(2);
    expect(readFileSync(ledger.filePath,'utf8')).toBe(legacy);
    await next.update(applicant,{requestId:row.id,expectedRequestVersion:1,reason:'迁移后的补充',clientMutationId:randomUUID()});
    expect(readFileSync(ledger.filePath+'.v1.bak','utf8')).toBe(legacy);
    expect(JSON.parse(readFileSync(ledger.filePath,'utf8')).schemaVersion).toBe(2);
  });

  it('accepts non-enumerable redacted reasons while rejecting injected identity fields', async () => {
    const body=input();Object.defineProperty(body,'reason',{value:body.reason,enumerable:false});
    const row=await service.create(applicant,body);
    const edit={requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()} as any;
    Object.defineProperty(edit,'reason',{value:'非枚举补充',enumerable:false});
    expect((await service.update(applicant,edit)).reason).toBe('非枚举补充');
    Object.defineProperty(edit,'accountId',{value:ids[1],enumerable:false});
    await expect(service.update(applicant,edit)).rejects.toThrow('内容无效');
  });

  it('warns about capacity without pruning receipts or audit and never expires pending requests automatically', async () => {
    const row=await service.create(applicant,input());
    const state=ledger.read();
    for(let i=0;i<24000;i++) state.mutations[i.toString(16).padStart(64,'0')]={fingerprint:'a'.repeat(64),requestId:row.id};
    expect(ledger.capacity(state).level).toBe('warning');
    expect(Object.keys(state.mutations)).toHaveLength(24001);
    jest.spyOn(Date,'now').mockReturnValue(Date.now()+400*24*60*60*1000);
    expect(service.listOwn(applicant)[0].status).toBe('pending');
  });

  it('does not let impersonated/first-password owners edit or cancel, or cancel an already reviewed request',async()=>{
    const row=await service.create(applicant,input()),body={requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()};
    await expect(service.cancel({...applicant,requiresPasswordChange:true},body)).rejects.toThrow('初始密码');
    await expect(service.update({...applicant,impersonation:{actorAccountId:admin.accountId!,actorName:'合成管理员',targetName:'合成人员',expiresAt:Date.now()+1000}},{...body,reason:'changed'})).rejects.toThrow('代登录');
    await service.review(admin,reviewInput(row.id,{decision:'reject',comment:'已结束'}));
    await expect(service.cancel(applicant,{...body,expectedRequestVersion:2})).rejects.toThrow('已变化或已处理');
  });

  it('reports an explicitly disabled approved account as currently ineffective',async()=>{
    const row=await service.create(applicant,input());await grant([grantRule()]);await service.review(admin,reviewInput(row.id));
    const account=config.snapshot().accounts.find(item=>item.id===ids[0])!;
    await config.saveAccount({clientMutationId:randomUUID(),expectedRevision:configStore.read().revision,id:account.id,kind:account.kind,name:account.name,role:account.role,building:account.building,enabled:false},admin);
    expect(service.listAdmin(admin)[0]).toMatchObject({status:'approved',currentEffect:'none',currentEffectRevision:configStore.read().revision});
    expect(ledger.read().audit).toHaveLength(2);
  });

  it('does not overwrite a different legacy backup or commit a partially migrated ledger',async()=>{
    const row=await service.create(applicant,input());const original=JSON.stringify({...ledger.read(),schemaVersion:1});writeFileSync(ledger.filePath,original);writeFileSync(ledger.filePath+'.v1.bak','different original bytes');
    await expect(service.cancel(applicant,{requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()})).rejects.toThrow('旧版备份');
    expect(readFileSync(ledger.filePath,'utf8')).toBe(original);expect(readFileSync(ledger.filePath+'.v1.bak','utf8')).toBe('different original bytes');
  });
  it('builds each account permission reader once per listing and never reuses it across requests',async()=>{
    const row=await service.create(applicant,input());await grant([grantRule()]);await service.review(admin,reviewInput(row.id));
    const state=ledger.read(),original=state.requests[row.id];
    for(let i=0;i<50;i++){const id=randomUUID();state.requests[id]={...original,id};}
    writeFileSync(ledger.filePath,JSON.stringify(state));
    const pages=jest.spyOn(config,'pagePermissions');
    expect(service.listAdmin(admin)).toHaveLength(51);expect(pages).toHaveBeenCalledTimes(1);
    await grant([]);pages.mockClear();
    expect(service.listAdmin(admin).every(item=>item.currentEffect==='none')).toBe(true);expect(pages).toHaveBeenCalledTimes(1);
  });

  it('recovers a committed configuration grant after request-file failure without another grant or configuration audit', async () => {
    const row = await service.create(applicant, input()), body = reviewInput(row.id, { comment: '已核对业务范围' });
    failNextRequestCommit();
    await expect(service.review(admin, body)).rejects.toThrow('synthetic request commit failure');
    expect(ledger.read().requests[row.id].status).toBe('pending');
    expect(service.listAdmin(admin)[0]).toMatchObject({ status: 'approved', currentEffect: 'current', comment: body.comment });
    const before = readFileSync(configStore.filePath, 'utf8');
    const restarted = new PersonnelPermissionRequestsService(config, new PersonnelPermissionRequestsStore(ledger.filePath));
    const recovered = await restarted.review(admin, body);
    expect(recovered).toMatchObject({ status: 'approved', version: 2, reviewerAccountId: admin.accountId, comment: body.comment });
    expect(readFileSync(configStore.filePath, 'utf8')).toBe(before);
    expect(configStore.read().audit.filter(item => item.action === '同意权限申请并授权')).toHaveLength(1);
    expect(ledger.read().audit.map(item => item.action)).toEqual(['create', 'approve']);
    expect(await restarted.review(admin, body)).toEqual(recovered);
  });

  it.each(['reject', 'cancel', 'update'] as const)('returns the true approved result when %s follows an interrupted request commit', async action => {
    const row = await service.create(applicant, input()), original = reviewInput(row.id, { comment: '原审批意见' });
    failNextRequestCommit();
    await expect(service.review(admin, original)).rejects.toThrow('synthetic request commit failure');
    const before = readFileSync(configStore.filePath, 'utf8');
    const refreshed = config.snapshot().accounts.find(item => item.id === ids[0])!;
    applicant = config.currentPrincipal(refreshed.id, refreshed.version)!;
    const base = { requestId: row.id, expectedRequestVersion: 1, clientMutationId: randomUUID() };
    const result = action === 'reject' ? await service.review(admin, { ...base, decision: 'reject', comment: '后到拒绝' })
      : action === 'cancel' ? await service.cancel(applicant, base) : await service.update(applicant, { ...base, reason: '后到修改' });
    expect(result).toMatchObject({ status: 'approved', version: 2, comment: '原审批意见', reason: row.reason });
    expect(readFileSync(configStore.filePath, 'utf8')).toBe(before);
    expect(ledger.read().audit.map(item => item.action)).toEqual(['create', 'approve']);
    expect(service.summaryOwn(applicant)).toMatchObject({ pending: 0, approved: 1 });
  });

  it('recovers approval history without restoring a permission revoked after the original grant', async () => {
    const row = await service.create(applicant, input()), body = reviewInput(row.id);
    failNextRequestCommit();
    await expect(service.review(admin, body)).rejects.toThrow('synthetic request commit failure');
    const committedRevision = configStore.read().revision;
    await grant([]);
    const afterRevocation = readFileSync(configStore.filePath, 'utf8');
    expect(await service.review(admin, body)).toMatchObject({ status: 'approved', currentEffect: 'none', verifiedConfigurationRevision: committedRevision });
    expect(readFileSync(configStore.filePath, 'utf8')).toBe(afterRevocation);
    expect(configStore.read().audit.filter(item => item.action === '同意权限申请并授权')).toHaveLength(1);
  });

  it.each(['malformed', 'unknown-version', 'wrong-identity', 'wrong-permissions', 'wrong-request-version', 'oversized'] as const)('fails closed on a %s grant receipt rather than rejecting or regranting', async fault => {
    const row = await service.create(applicant, input()), body = reviewInput(row.id);
    failNextRequestCommit();
    await expect(service.review(admin, body)).rejects.toThrow('synthetic request commit failure');
    const request = ledger.read().requests[row.id], key = permissionGrantKey(request);
    await configStore.mutate(configStore.read().revision, randomUUID(), 'synthetic-invalid-receipt', state => {
      const prefix = 'personnel-permission-grant-v1:', entry = state.mutations[key];
      if (fault === 'malformed') entry.fingerprint = 'not-a-receipt';
      else if (fault === 'oversized') entry.fingerprint = prefix + 'x'.repeat(4096);
      else {
        const receipt = JSON.parse(entry.fingerprint.slice(prefix.length));
        if (fault === 'unknown-version') receipt.version = 2;
        if (fault === 'wrong-identity') receipt.applicantIdentity = 'different-person';
        if (fault === 'wrong-permissions') receipt.permissionsHash = '0'.repeat(64);
        if (fault === 'wrong-request-version') receipt.requestVersion++;
        entry.fingerprint = prefix + JSON.stringify(receipt);
      }
    });
    const before = readFileSync(configStore.filePath, 'utf8'), requestBytes = readFileSync(ledger.filePath, 'utf8');
    await expect(service.review(admin, reviewInput(row.id, { decision: 'reject', comment: '不应覆盖' }))).rejects.toThrow('回执无法核验');
    expect(readFileSync(configStore.filePath, 'utf8')).toBe(before);
    expect(readFileSync(ledger.filePath, 'utf8')).toBe(requestBytes);
  });

  it('preserves the followed role, native building and unrelated denies when granting another exact module scope', async () => {
    const original = config.snapshot().accounts.find(item => item.id === ids[0])!;
    const unrelated = grantRule({ id: 'unrelated-deny', module: 'thresholds', actions: ['update'], effect: 'deny', buildings: ['C楼'] });
    await config.saveAccount({ clientMutationId: randomUUID(), expectedRevision: configStore.read().revision, id: original.id,
      kind: original.kind, name: original.name, role: 'building_admin', building: 'A楼', buildings: ['A楼'], enabled: true,
      personalRules: [unrelated] }, admin);
    const before = config.snapshot().accounts.find(item => item.id === ids[0])!;
    applicant = config.currentPrincipal(before.id, before.version)!;
    const requested = { ...permission() as Extract<RequestedPermission, { kind: 'action' }>, buildings: ['B楼'] as ['B楼'] };
    const row = await service.create(applicant, input({ permissions: [requested] }));
    await service.review(admin, reviewInput(row.id));
    const after = config.snapshot().accounts.find(item => item.id === ids[0])!;
    expect(after.authorizationBinding).toEqual(before.authorizationBinding);
    expect(after.role).toBe('building_admin'); expect(after.building).toBe('A楼'); expect(after.buildings).toEqual(['A楼']);
    expect(after.authorizationOverrides!.rules).toContainEqual(unrelated);
    const evaluate = createBusinessPermissionEvaluator(config.currentPrincipal(after.id, after.version)!);
    expect(evaluate({ module: 'inventory', action: 'create', building: 'B楼', specialty: '电气' }).allowed).toBe(true);
    expect(evaluate({ module: 'inventory', action: 'create', building: 'C楼', specialty: '电气' }).allowed).toBe(false);
    expect(evaluate({ module: 'thresholds', action: 'update', building: 'C楼', specialty: '电气' }).allowed).toBe(false);
  });

  it('grants a requested static page through the unified page engine without granting business actions', async () => {
    await grant([]);
    const row = await service.create(applicant, input({ permissions: [{ kind: 'page', path: '/nantong-base' }] }));
    const approved = await service.review(admin, reviewInput(row.id));
    expect(approved).toMatchObject({ status: 'approved', currentEffect: 'current' });
    const account = config.snapshot().accounts.find(item => item.id === ids[0])!;
    expect(account.authorizationOverrides!.allowPages).toEqual(['/nantong-base']);
    expect(account.authorizationOverrides!.rules).toEqual([]);
    expect(account.authorizationBinding!.mode).toBe('independent');
  });

  it('grants only a registered external platform entry without changing any external system identity', async () => {
    await grant([]);
    const before = config.snapshot().accounts.find(item => item.id === ids[0])!;
    const row = await service.create(applicant, input({ permissions: [{ kind: 'page', path: 'https://www.sm.sjhl.online:8787/' }] }));
    expect((await service.review(admin, reviewInput(row.id)))).toMatchObject({ status: 'approved', currentEffect: 'current' });
    const after = config.snapshot().accounts.find(item => item.id === ids[0])!;
    expect(after.authorizationOverrides!.allowPages).toEqual(['https://www.sm.sjhl.online:8787/']);
    expect(after.authorizationOverrides!.rules).toEqual([]);
    expect(after.role).toBe(before.role); expect(after.identityHash).toBe(before.identityHash);
    expect(after.openId).toBe(before.openId); expect(after.appId).toBe(before.appId);
  });

  it('does not grant any permissions when a request is rejected', async () => {
    const row = await service.create(applicant, input()), before = JSON.stringify(configStore.read());
    expect((await service.review(admin, reviewInput(row.id, { decision: 'reject', comment: '不符合职责' }))).status).toBe('rejected');
    expect(JSON.stringify(configStore.read())).toBe(before);
  });

  it('enqueues create/replay durably and isolates wake failures from a committed approval', async () => {
    const notifier = { enqueue: jest.fn().mockRejectedValueOnce(new Error('synthetic notification disk unavailable')).mockResolvedValue(undefined),
      wake: jest.fn(() => { throw new Error('synthetic background wake failure'); }) };
    const notified = new PersonnelPermissionRequestsService(config, ledger, notifier as any), body = input();
    expect(notifier.enqueue).not.toHaveBeenCalled();
    await expect(notified.create(applicant, body)).rejects.toThrow('notification disk unavailable');
    const row = await notified.create(applicant, body);
    expect(notifier.enqueue).toHaveBeenCalledTimes(2);
    expect(Object.values(ledger.read().requests)).toHaveLength(1);
    expect(ledger.read().audit).toHaveLength(1);
    expect((await notified.review(admin, reviewInput(row.id))).status).toBe('approved');
    expect(notifier.wake).toHaveBeenCalledTimes(1);
    expect(ledger.read().audit).toHaveLength(2);
  });

  it('refuses a known full request ledger before committing any configuration grant', async () => {
    const row = await service.create(applicant, input()), state = ledger.read();
    state.audit = Array.from({ length: 20000 }, () => ({ ...state.audit[0] }));
    writeFileSync(ledger.filePath, JSON.stringify(state));
    const requestBytes = readFileSync(ledger.filePath, 'utf8'), before = JSON.stringify(configStore.read());
    const granting = jest.spyOn(config, 'grantPersonnelPermissionRequest');
    await expect(service.review(admin, reviewInput(row.id))).rejects.toThrow('台账容量已满');
    expect(granting).not.toHaveBeenCalled();
    expect(JSON.stringify(configStore.read())).toBe(before);
    expect(readFileSync(ledger.filePath, 'utf8')).toBe(requestBytes);
  });

  it('serializes actual grant and cancellation under the request lock without producing cancelled-but-granted state', async () => {
    const row = await service.create(applicant, input());
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalGrant = config.grantPersonnelPermissionRequest.bind(config);
    jest.spyOn(config, 'grantPersonnelPermissionRequest').mockImplementation(async (...args) => {
      entered(); await gate; return originalGrant(...args);
    });
    const approving = service.review(admin, reviewInput(row.id));
    await began;
    const cancelling = service.cancel(applicant, { requestId: row.id, expectedRequestVersion: 1, clientMutationId: randomUUID() });
    release();
    const results = await Promise.allSettled([approving, cancelling]);
    expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('rejected');
    expect(ledger.read().requests[row.id].status).toBe('approved');
    expect(configStore.read().audit.filter(item => item.action === '同意权限申请并授权')).toHaveLength(1);
    expect(ledger.read().audit.map(item => item.action)).toEqual(['create', 'approve']);
  });

  it('does not grant when cancellation wins before approval', async () => {
    const row = await service.create(applicant, input()), before = JSON.stringify(configStore.read());
    const granting = jest.spyOn(config, 'grantPersonnelPermissionRequest');
    const results = await Promise.allSettled([
      service.cancel(applicant, { requestId: row.id, expectedRequestVersion: 1, clientMutationId: randomUUID() }),
      service.review(admin, reviewInput(row.id)),
    ]);
    expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('rejected');
    expect(granting).not.toHaveBeenCalled();
    expect(JSON.stringify(configStore.read())).toBe(before);
    expect(ledger.read().requests[row.id].status).toBe('cancelled');
  });

  it('applies the same requested grant to the verified personnel login while preserving each login role and scope', async () => {
    const native = (defaults.defaultAccessAccounts as jest.Mock).mock.results[0].value as Record<string, stores.StoredAccount>;
    const localId = native[ids[0]].personnelIdentity!;
    native[localId] = { id: localId, kind: 'local', name: '合成关联姓名登录', role: 'inventory_admin', building: 'B楼',
      enabled: true, deleted: false, version: 1, source: 'default', passwordHash: adminHash, loginMethod: 'personnel-password',
      personnelActive: true, personnelAppId: appId, personnelIdentity: localId, siteMember: true, permissionSource: 'manual' };
    const row = await service.create(applicant, input());
    await service.review(admin, reviewInput(row.id));
    const snapshot = config.snapshot(), feishu = snapshot.accounts.find(item => item.id === ids[0])!, local = snapshot.accounts.find(item => item.id === localId)!;
    expect(feishu.role).toBe('guest'); expect(feishu.building).toBeNull();
    expect(local.role).toBe('inventory_admin'); expect(local.building).toBe('B楼');
    expect(local.authorizationBinding).toEqual({ mode: 'follow', templateId: 'builtin-inventory_admin' });
    expect(createBusinessPermissionEvaluator(config.currentPrincipal(local.id, local.version)!)({ module: 'inventory', action: 'create', building: 'A楼', specialty: '电气' }).allowed).toBe(true);
    expect(createBusinessPermissionEvaluator(config.currentPrincipal(local.id, local.version)!)({ module: 'inventory', action: 'create', building: 'C楼', specialty: '电气' }).allowed).toBe(false);
    expect(config.currentPrincipal(local.id, 1)).toBeUndefined();
  });

  it('reads one configuration snapshot for 1000 pending receipt checks and batches each listing and summary independently', async () => {
    const row = await service.create(applicant, input()), state = ledger.read();
    for (let i = 1; i < 1000; i++) { const id = randomUUID(); state.requests[id] = { ...state.requests[row.id], id }; }
    writeFileSync(ledger.filePath, JSON.stringify(state));
    const reading = jest.spyOn(configStore, 'read');
    const firstSnapshot = config.permissionRequestGrantReceipts(Object.values(state.requests));
    expect(reading).toHaveBeenCalledTimes(1); expect(firstSnapshot.size).toBe(0);
    const batch = jest.spyOn(config, 'permissionRequestGrantReceipts'), single = jest.spyOn(config, 'permissionRequestGrantReceipt');
    expect(service.listAdmin(admin)).toHaveLength(1000);
    expect(batch).toHaveBeenCalledTimes(1); expect(batch.mock.calls[0][0]).toHaveLength(1000); expect(single).not.toHaveBeenCalled();
    batch.mockClear();
    expect(service.summaryAdmin(admin)).toMatchObject({ total: 1000, pending: 1000, approved: 0 });
    expect(batch).toHaveBeenCalledTimes(1); expect(single).not.toHaveBeenCalled();
    await config.grantPersonnelPermissionRequest(state.requests[row.id], admin, { clientMutationId: randomUUID(), comment: '' });
    expect(firstSnapshot.size).toBe(0); // No cross-request mutable authorization cache.
    batch.mockClear();
    expect(service.summaryAdmin(admin)).toMatchObject({ total: 1000, pending: 999, approved: 1 });
    expect(batch).toHaveBeenCalledTimes(1); expect(single).not.toHaveBeenCalled();
  });
});
