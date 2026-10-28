import { BadRequestException, type INestApplication, type NestInterceptor } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaultsModule from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessModule } from '../../server/common/access/unified-access.module';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { migrateAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { matchesAccessPassword } from '../../server/common/access/access-password';
import type { AccountMutation } from '../../shared/access-configuration.interface';
import type { AuthorizationBinding, AuthorizationOverrides, AuthorizationPolicy } from '../../shared/authorization-profile';
import { decideBusinessPermission } from '../../shared/business-permissions';
import { authorizationModuleState, editAuthorizationScope } from '../../client/src/pages/SystemConfiguration/authorization-editing';

describe('V2 account preview and save through the actual UnifiedAccessModule HTTP middleware', () => {
  const appId = 'cli_account_save_synthetic', openId = 'ou_account_save_synthetic';
  const accountId = `feishu-${feishuIdentityFingerprint(appId, openId)}`;
  let app: INestApplication | undefined, directory: string, owner: string, url: string, cookie: string;
  let store: stores.AccessConfigurationStore, native: Record<string, stores.StoredAccount>, savedEnvironment: NodeJS.ProcessEnv;
  const captured: { url: string; body: Record<string, unknown>; keys: string[]; json: string }[] = [];
  const overrides = (): AuthorizationOverrides => ({ rules: [{ id: 'personal-no-export', module: 'inventory', effect: 'deny', actions: ['export'], buildings: ['B楼'], specialties: null }], allowPages: [], denyPages: [] });
  const policy = (): AuthorizationPolicy => ({ nativeRole: null, pages: [], rules: [{ id: 'inventory-B', module: 'inventory', effect: 'allow', actions: ['read', 'update'], buildings: ['B楼'], specialties: ['电气'] }] });
  const independent = (): AuthorizationBinding => ({ mode: 'independent', policy: policy() });
  const payload = (extra: Partial<AccountMutation> = {}): AccountMutation => ({ clientMutationId: `synthetic-account-${randomUUID()}`, expectedRevision: store.read().revision,
    id: accountId, kind: 'feishu', name: '合成权限人员', openId, role: 'guest', building: null, enabled: true, deleted: false,
    authorizationBinding: independent(), authorizationOverrides: overrides(), ...extra });
  const bytes = () => readFileSync(store.filePath);

  async function openApplication() {
    const module = await Test.createTestingModule({ imports: [UnifiedAccessModule] })
      .overrideProvider(AccessConfigurationDirectory).useValue({
        read: async () => ({ appId, people: [{ name: '合成权限人员', openId }], snapshotAt: Date.now(), personnelComplete: true, employees: [] }),
        assertKnown: async (ids: string[]) => { if (ids.some(id => id !== openId)) throw new BadRequestException('合成目录不认识此身份'); },
      }).compile();
    app = module.createNestApplication({ logger: false });
    const capture: NestInterceptor = { intercept(context, next) {
      const request = context.switchToHttp().getRequest();
      if (request.url.startsWith('/api/access/configuration/accounts')) captured.push({ url: request.url, body: request.body, keys: Object.keys(request.body), json: JSON.stringify(request.body) });
      return next.handle();
    } };
    app.useGlobalInterceptors(capture);
    await app.listen(0, '127.0.0.1'); url = await app.getUrl(); process.env.PUBLIC_BASE_URL = url;
    const access = app.get(UnifiedAccessService), configuration = app.get(AccessConfigurationService);
    const admin = configuration.localTargets().find(item => item.principal.role === 'admin')!;
    cookie = `${access.cookieName}=${access.issueTrustedSession(admin.principal).token}`;
  }
  async function post(endpoint: string, body: object, options: { cookie?: string; origin?: string } = {}) {
    const response = await fetch(url + '/api/access/configuration' + endpoint, { method: 'POST', headers: {
      cookie: options.cookie ?? cookie, origin: options.origin ?? url, 'content-type': 'application/json',
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const save = (body: AccountMutation, options?: { cookie?: string; origin?: string }) => post('/accounts', body, options);
  const preview = (body: AccountMutation) => post('/permissions/preview', { accountId: body.id, expectedRevision: body.expectedRevision,
    binding: body.authorizationBinding, overrides: body.authorizationOverrides, building: body.building });

  beforeEach(async () => {
    savedEnvironment = { ...process.env }; captured.length = 0;
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-account-v2-http-')); owner = randomUUID(); writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' });
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64'); process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.FEISHU_APP_ID = appId; process.env.FEISHU_APP_SECRET = ''; process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    native = {
      'local-admin-all': { id: 'local-admin-all', kind: 'local', name: '合成管理员', role: 'admin', building: null, enabled: true, deleted: false, version: 1, source: 'default', passwordHash: hashAccessPassword('synthetic-admin-password') },
      'local-editor-all': { id: 'local-editor-all', kind: 'local', name: '合成共享入口', role: 'editor', building: null, enabled: true, deleted: false, version: 1, source: 'default', passwordHash: hashAccessPassword('synthetic-editor-password') },
      [accountId]: { id: accountId, kind: 'feishu', name: '合成权限人员', role: 'editor', building: null, enabled: true, deleted: false, version: 1, source: 'configuration',
        appId, openId, identityHash: feishuIdentityFingerprint(appId, openId), permissionSource: 'manual' },
    };
    store = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockImplementation(() => store);
    jest.spyOn(defaultsModule, 'defaultAccessAccounts').mockImplementation(() => structuredClone(native));
    await store.mutate(0, `synthetic-seed-${randomUUID()}`, 'fixture-only', state => { state.accounts = structuredClone(native); migrateAuthorizationState(state, native); });
    await openApplication();
  });
  afterEach(async () => {
    await app?.close(); app = undefined; jest.restoreAllMocks(); process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('nt-account-v2-http-') || readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive: true, force: false });
  });

  it.each(['independent', 'follow'] as const)('core preview then save retains %s authorization through real middleware and restart', async mode => {
    let binding = independent();
    if (mode === 'follow') {
      const created = await post('/roles', { clientMutationId: `synthetic-role-${randomUUID()}`, expectedRevision: store.read().revision, name: '合成跟随角色', description: '', enabled: true, policy: policy() });
      expect(created.status).toBe(201);
      binding = { mode: 'follow', templateId: created.body.authorizationTemplates.find((item: { name: string }) => item.name === '合成跟随角色').id };
    }
    const body = payload({ authorizationBinding: binding }), before = bytes(), originalVersion = store.read().accounts[accountId].version;
    const checked = await preview(body); expect(checked.status).toBe(201); expect(bytes()).toEqual(before);
    const result = await save(body);
    expect({ status: result.status, message: result.body.message }).toEqual({ status: 201, message: undefined });
    const saved = result.body.accounts.find((item: { id: string }) => item.id === accountId);
    expect(saved).toMatchObject({ role: 'guest', version: originalVersion + 1, authorizationBinding: binding, authorizationOverrides: body.authorizationOverrides });
    expect(saved.effectiveAuthorization).toEqual(checked.body.after); expect(result.body.revision).toBe(body.expectedRevision + 1);
    const observed = captured.at(-1)!; expect(observed.body.openId).toBe(openId); expect(observed.keys).not.toContain('openId'); expect(observed.json).not.toContain(openId);
    expect(observed.keys).toEqual(expect.arrayContaining(['authorizationBinding', 'authorizationOverrides'])); expect(observed.body).not.toHaveProperty('invalidFields');
    const persisted = bytes(); await app!.close(); app = undefined; store = new stores.AccessConfigurationStore(join(directory, 'configuration.json')); await openApplication();
    const reread = await fetch(url + '/api/access/configuration', { headers: { cookie } }); expect(reread.status).toBe(200);
    const restored = (await reread.json()).accounts.find((item: { id: string }) => item.id === accountId);
    expect(restored.authorizationBinding).toEqual(binding); expect(restored.authorizationOverrides).toEqual(body.authorizationOverrides); expect(restored.effectiveAuthorization).toEqual(checked.body.after);
    expect(bytes()).toEqual(persisted);
  });
  it('persists a scope-only editor change through preview, save, reread and service restart', async () => {
    const value = editAuthorizationScope({ mode: 'independent', baseline: { nativeRole: null, pages: [],
      rules: [{ id: 'all-inventory', module: 'inventory', effect: 'allow', actions: ['read', 'create'], buildings: null, specialties: null }] },
      overrides: { rules: [], allowPages: [], denyPages: [] } }, false, { module: 'inventory', buildings: ['B楼'], specialties: null });
    const body = payload({ authorizationBinding: { mode: 'independent', policy: value.baseline }, authorizationOverrides: value.overrides });
    const checked = await preview(body); expect(checked.status).toBe(201);
    const saved = await save(body); expect(saved.status).toBe(201);
    const persisted = bytes(); await app!.close(); app = undefined;
    store = new stores.AccessConfigurationStore(join(directory, 'configuration.json')); await openApplication();
    const response = await fetch(url + '/api/access/configuration', { headers: { cookie } });
    expect(response.status).toBe(200);
    const restored = (await response.json()).accounts.find((item: { id: string }) => item.id === accountId);
    expect(restored.effectiveAuthorization).toEqual(checked.body.after);
    const actor = { role: restored.role, purchaseBuilding: null, effectiveAuthorization: restored.effectiveAuthorization };
    expect(authorizationModuleState(restored.effectiveAuthorization, actor, 'inventory').scope.buildings).toEqual(['B楼']);
    expect(decideBusinessPermission(actor, { module: 'inventory', action: 'create', building: 'B楼', specialty: '电气' }).allowed).toBe(true);
    expect(decideBusinessPermission(actor, { module: 'inventory', action: 'create', building: 'A楼', specialty: '电气' }).allowed).toBe(false);
    expect(bytes()).toEqual(persisted);
  });
  it('rejects unknown top-level and nested policy fields without persisting anything', async () => {
    const before = bytes(), body = payload();
    expect((await save({ ...body, arbitrary: true } as AccountMutation)).status).toBe(400); expect(bytes()).toEqual(before);
    expect((await save({ ...body, authorizationOverrides: { ...overrides(), arbitrary: true } } as AccountMutation)).status).toBe(400); expect(bytes()).toEqual(before);
  });
  it('requires an administrator and same-origin request for the V2 payload', async () => {
    const before = bytes(), body = payload();
    expect([401, 403]).toContain((await save(body, { cookie: '' })).status);
    const access = app!.get(UnifiedAccessService), editor = app!.get(AccessConfigurationService).localTargets().find(item => item.principal.role === 'editor')!;
    const editorCookie = `${access.cookieName}=${access.issueTrustedSession(editor.principal).token}`;
    expect([401, 403]).toContain((await save(body, { cookie: editorCookie })).status);
    expect((await save(body, { origin: 'https://outside.synthetic.invalid' })).status).toBe(403); expect(bytes()).toEqual(before);
  });
  it('keeps mutation retries idempotent and rejects changed content and stale revisions', async () => {
    const body = payload(); expect((await save(body)).status).toBe(201); const after = bytes(), version = store.read().accounts[accountId].version;
    const retried = await save(body); expect(retried.status).toBe(201); expect(bytes()).toEqual(after); expect(store.read().accounts[accountId].version).toBe(version);
    expect((await save({ ...body, name: '合成修改姓名' })).status).toBe(409); expect(bytes()).toEqual(after);
    expect((await save({ ...body, clientMutationId: `synthetic-stale-${randomUUID()}` })).status).toBe(409); expect(bytes()).toEqual(after);
  });
  it('passes reactivation confirmation through middleware but still requires current confirmed employment', async () => {
    await store.mutate(store.read().revision, `synthetic-employment-${randomUUID()}`, 'fixture-only', state => {
      state.accounts[accountId] = { ...state.accounts[accountId], enabled: false, reactivationRequired: true, personnelSuspended: true };
      state.personnelEmployment = { appId, snapshotAt: Date.now(), inactive: { [accountId]: true }, loginBlocked: { [accountId]: true } };
    });
    let body = payload({ confirmReactivation: true }), before = bytes();
    const departed = await save(body); expect(departed.status).toBe(400); expect(departed.body.message).toContain('仍为离职'); expect(bytes()).toEqual(before);
    expect(captured.at(-1)!.body.confirmReactivation).toBe(true); expect(captured.at(-1)!.keys).toContain('confirmReactivation');
    await store.mutate(store.read().revision, `synthetic-return-${randomUUID()}`, 'fixture-only', state => { state.personnelEmployment!.inactive[accountId] = false; state.personnelEmployment!.snapshotAt = Date.now(); });
    body = payload(); before = bytes(); const unconfirmed = await save(body); expect(unconfirmed.status).toBe(400); expect(unconfirmed.body.message).toContain('明确确认'); expect(bytes()).toEqual(before);
    const confirmed = await save({ ...body, confirmReactivation: true }); expect(confirmed.status).toBe(201);
    expect(store.read().accounts[accountId]).toMatchObject({ enabled: true, reactivationRequired: false }); expect(store.read().personnelEmployment!.loginBlocked?.[accountId]).toBeUndefined();
  });
  it('does not accept stale employment evidence even when confirmation is true', async () => {
    await store.mutate(store.read().revision, `synthetic-stale-employment-${randomUUID()}`, 'fixture-only', state => {
      state.accounts[accountId] = { ...state.accounts[accountId], enabled: false, reactivationRequired: true };
      state.personnelEmployment = { appId, snapshotAt: Date.now() - 360_000, inactive: { [accountId]: false }, loginBlocked: { [accountId]: true } };
    });
    const before = bytes(), result = await save(payload({ confirmReactivation: true }));
    expect(result.status).toBe(400); expect(result.body.message).toContain('先同步并确认'); expect(bytes()).toEqual(before);
  });
  it('keeps sensitive passwords readable to the save handler but absent from JSON request logging', async () => {
    const password = 'synthetic-new-shared-password';
    const body = payload({ id: 'local-editor-all', kind: 'local', name: '合成共享入口', role: 'editor', openId: undefined, password,
      authorizationBinding: { mode: 'follow', templateId: 'builtin-editor' }, authorizationOverrides: { rules: [], allowPages: [], denyPages: [] } });
    const result = await save(body); expect(result.status).toBe(201); const observed = captured.at(-1)!;
    expect(observed.body.password).toBe(password); expect(observed.keys).not.toContain('password'); expect(observed.json).not.toContain(password); expect(JSON.stringify(result.body)).not.toContain(password);
    expect(observed.keys).toEqual(expect.arrayContaining(['authorizationBinding', 'authorizationOverrides']));
    expect(await matchesAccessPassword(password, store.read().accounts['local-editor-all'].passwordHash!)).toBe(true);
    const after = bytes(); expect((await save({ ...body, password: 'synthetic-other-shared-password' })).status).toBe(409); expect(bytes()).toEqual(after);
  });
  it('does not grant native administrator status or disable the last administrator through V2 fields', async () => {
    const before = bytes(); expect((await save(payload({ role: 'admin', authorizationBinding: { mode: 'follow', templateId: 'builtin-admin' } }))).status).toBe(400); expect(bytes()).toEqual(before);
    const body = payload({ id: 'local-admin-all', kind: 'local', openId: undefined, name: '合成管理员', role: 'admin', enabled: false,
      authorizationBinding: { mode: 'follow', templateId: 'builtin-admin' }, authorizationOverrides: { rules: [], allowPages: [], denyPages: [] } });
    const rejected = await save(body); expect(rejected.status).toBe(400); expect(rejected.body.message).toContain('至少一个可用管理员'); expect(bytes()).toEqual(before);
  });
});
