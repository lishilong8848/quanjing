import { BadRequestException, Controller, Get, Req, type INestApplication } from '@nestjs/common';
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
import { ProfessionalScoped } from '../../server/common/access/unified-access.decorators';

// A read-only business probe exercises the real guard without loading business data or jobs.
@Controller('api/inventory-management')
class ImpersonationInventoryReadProbe {
  @ProfessionalScoped()
  @Get('items')
  read(@Req() request: { accessPrincipal?: { accountId?: string } }) {
    return { allowed: true, accountId: request.accessPrincipal?.accountId };
  }
}

const PASSWORD = 'synthetic-impersonation-password';
const PASSWORD_HASH = hashAccessPassword(PASSWORD);
const SECOND_ADMIN_HASH = hashAccessPassword('synthetic-second-admin-only');
const OWNER_COOKIE = 'vnet_impersonation_actor';
const SECURE_OWNER_COOKIE = '__Host-vnet_impersonation_actor';
const MAIN_COOKIE = 'vnet_access_session';
type HttpResult = { status: number; body: any; cookies: string[] };

function mergeCookies(existing: string, response: HttpResult): string {
  const jar = new Map(existing.split(/;\s*/).filter(Boolean).map(pair => {
    const equals = pair.indexOf('='); return [pair.slice(0, equals), pair.slice(equals + 1)];
  }));
  for (const line of response.cookies) {
    const pair = line.split(';', 1)[0], equals = pair.indexOf('=');
    const name = pair.slice(0, equals), value = pair.slice(equals + 1);
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
function cookiePair(cookie: string, name: string): string {
  return cookie.split(/;\s*/).find(pair => pair.startsWith(`${name}=`)) || '';
}

describe('administrator impersonation through the real UnifiedAccessModule HTTP middleware', () => {
  const appId = 'cli_impersonation_synthetic', openId = 'ou_impersonation_synthetic';
  const feishuId = `feishu-${feishuIdentityFingerprint(appId, openId)}`;
  const actorId = 'local-admin-all', localId = 'local-inventory-h', secondAdminId = 'local-admin-second';
  let app: INestApplication | undefined, directory: string, owner: string, url: string;
  let store: stores.AccessConfigurationStore, savedEnvironment: NodeJS.ProcessEnv;
  let adminCookie: string, ordinaryCookie: string, adminExpiresAt: number;

  const mutation = () => `synthetic-impersonation-${randomUUID()}`;
  const bytes = () => readFileSync(store.filePath);
  const audits = () => store.read().audit;
  async function request(path: string, body?: object, options: { cookie?: string; origin?: string; method?: string } = {}): Promise<HttpResult> {
    const response = await fetch(url + path, {
      method: options.method || (body === undefined ? 'GET' : 'POST'),
      headers: { cookie: options.cookie ?? adminCookie, ...(body === undefined ? {} : {
        origin: options.origin ?? url, 'content-type': 'application/json',
      }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  }
  const start = (accountId = feishuId, options?: { cookie?: string; origin?: string }, clientMutationId = mutation()) =>
    request('/api/access/impersonation/start', { accountId, clientMutationId }, options);
  const stop = (cookie: string, clientMutationId = mutation(), origin?: string) =>
    request('/api/access/impersonation/stop', { clientMutationId }, { cookie, origin });
  const session = (cookie: string) => request('/api/access/session', undefined, { cookie });
  async function updateAccount(id: string, update: Partial<stores.StoredAccount>) {
    await store.mutate(store.read().revision, mutation(), 'synthetic-fixture-only', state => {
      state.accounts[id] = { ...state.accounts[id], ...update };
    });
  }

  beforeEach(async () => {
    savedEnvironment = { ...process.env };
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-impersonation-http-'));
    owner = randomUUID(); writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' });
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.FEISHU_APP_ID = appId; process.env.FEISHU_APP_SECRET = '';
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    delete process.env.LOCAL_ACCESS_COOKIE_SECURE; delete process.env.LOCAL_ACCESS_TRUST_PROXY;
    delete process.env.CLIENT_BASE_PATH;
    const local = (id: string, role: stores.StoredAccount['role'], name: string, building: stores.StoredAccount['building'] = null): stores.StoredAccount => ({
      id, kind: 'local', role, name, building, enabled: true, deleted: false, version: 1, source: 'default', passwordHash: PASSWORD_HASH,
    });
    const native: Record<string, stores.StoredAccount> = {
      [actorId]: local(actorId, 'admin', '合成代登录管理员'),
      [secondAdminId]: { ...local(secondAdminId, 'admin', '合成其他管理员'), passwordHash: SECOND_ADMIN_HASH },
      'local-editor-all': local('local-editor-all', 'editor', '合成普通账号'),
      [localId]: local(localId, 'inventory_admin', '合成本地库存人员', 'H楼'),
      [feishuId]: { id: feishuId, kind: 'feishu', name: '合成飞书库存人员', role: 'inventory_admin', building: 'H楼',
        enabled: true, deleted: false, version: 1, source: 'configuration', appId, openId,
        identityHash: feishuIdentityFingerprint(appId, openId), permissionSource: 'manual',
        personalRules: [{ id: 'synthetic-no-export', module: 'inventory', effect: 'deny', actions: ['export'], buildings: ['H楼'], specialties: null }] },
    };
    store = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockImplementation(() => store);
    jest.spyOn(defaultsModule, 'defaultAccessAccounts').mockImplementation(() => structuredClone(native));
    await store.mutate(0, mutation(), 'synthetic-seed', state => {
      state.accounts = structuredClone(native); migrateAuthorizationState(state, native);
    });
    const module = await Test.createTestingModule({ imports: [UnifiedAccessModule], controllers: [ImpersonationInventoryReadProbe] })
      .overrideProvider(AccessConfigurationDirectory).useValue({
        read: async () => ({ appId, people: [{ name: '合成飞书库存人员', openId }], snapshotAt: Date.now(), personnelComplete: true, employees: [] }),
        assertKnown: async (ids: string[]) => { if (ids.some(id => id !== openId)) throw new BadRequestException('合成目录未知身份'); },
      }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1'); url = await app.getUrl(); process.env.PUBLIC_BASE_URL = url;
    const access = app.get(UnifiedAccessService), configuration = app.get(AccessConfigurationService);
    const targets = configuration.localTargets();
    const administrator = access.issueTrustedSession(targets.find(target => target.principal.accountId === actorId)!.principal);
    adminCookie = `${access.cookieName}=${administrator.token}`; adminExpiresAt = administrator.expiresAt;
    ordinaryCookie = `${access.cookieName}=${access.issueTrustedSession(targets.find(target => target.principal.accountId === 'local-editor-all')!.principal).token}`;
  });
  afterEach(async () => {
    await app?.close(); app = undefined;
    jest.restoreAllMocks(); process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('nt-impersonation-http-') || readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive: true, force: false });
  });

  it.each(['anonymous', 'ordinary'] as const)('rejects %s start without issuing cookies or audit changes', async kind => {
    const before = bytes(), result = await start(feishuId, { cookie: kind === 'anonymous' ? '' : ordinaryCookie });
    expect([401, 403]).toContain(result.status); expect(result.cookies).toEqual([]); expect(bytes()).toEqual(before);
  });
  it('rejects cross-origin start and stop without side effects', async () => {
    const before = bytes(), rejected = await start(feishuId, { origin: 'https://foreign.synthetic.invalid' });
    expect(rejected.status).toBe(403); expect(rejected.cookies).toEqual([]); expect(bytes()).toEqual(before);
    const begun = await start(), cookie = mergeCookies('', begun), started = bytes();
    expect(begun.status).toBe(201);
    const stopped = await stop(cookie, mutation(), 'https://foreign.synthetic.invalid');
    expect(stopped.status).toBe(403); expect(stopped.cookies).toEqual([]); expect(bytes()).toEqual(started);
  });
  it('rejects unsupported fields on both mutations', async () => {
    const before = bytes();
    const badStart = await request('/api/access/impersonation/start', { accountId: feishuId, clientMutationId: mutation(), role: 'admin' });
    expect(badStart.status).toBe(400); expect(bytes()).toEqual(before);
    const begun = await start(), cookie = mergeCookies('', begun), started = bytes();
    const badStop = await request('/api/access/impersonation/stop', { clientMutationId: mutation(), actorAccountId: actorId }, { cookie });
    expect(badStop.status).toBe(400); expect(bytes()).toEqual(started);
  });
  it.each(['feishu', 'local'] as const)('starts %s impersonation with only target permissions and HttpOnly cookies', async kind => {
    const id = kind === 'feishu' ? feishuId : localId, count = audits().length;
    const result = await start(id); expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ accountId: id, role: 'inventory_admin', purchaseBuilding: 'H楼',
      impersonation: { actorAccountId: actorId, actorName: '合成代登录管理员', targetName: kind === 'feishu' ? '合成飞书库存人员' : '合成本地库存人员' } });
    expect(result.body.impersonation.expiresAt).toBeGreaterThan(Date.now());
    const principal = app!.get(AccessConfigurationService).currentPrincipal(id, store.read().accounts[id].version)!;
    expect(result.body.effectiveAuthorization).toEqual(principal.effectiveAuthorization);
    expect(result.body.pagePaths).toContain('/inventory-management'); expect(result.body.pagePaths).not.toContain('/system-configuration');
    const cookie = mergeCookies('', result);
    for (const name of [MAIN_COOKIE, OWNER_COOKIE]) {
      expect(cookiePair(cookie, name)).not.toBe('');
      expect(result.cookies.filter(line => line.startsWith(`${name}=`) && !line.startsWith(`${name}=;`)).every(line => /;\s*HttpOnly(?:;|$)/i.test(line))).toBe(true);
    }
    const targetHeader = result.cookies.find(line => line.startsWith(`${MAIN_COOKIE}=`))!;
    const ownerHeader = result.cookies.find(line => line.startsWith(`${OWNER_COOKIE}=`))!;
    expect(/Max-Age=(\d+)/i.exec(targetHeader)?.[1]).toBe(/Max-Age=(\d+)/i.exec(ownerHeader)?.[1]);
    const browserLifetime = Number(/Max-Age=(\d+)/i.exec(targetHeader)?.[1]);
    expect(Math.abs(browserLifetime - (adminExpiresAt - Date.now()) / 1000)).toBeLessThan(2);
    expect(adminExpiresAt - result.body.impersonation.expiresAt).toBeGreaterThan(40 * 60_000);
    const serialized = JSON.stringify(result.body);
    for (const pair of cookie.split(/;\s*/)) expect(serialized).not.toContain(pair.slice(pair.indexOf('=') + 1));
    expect(serialized).not.toMatch(/sessionFamily|actorToken|ownerToken|passwordHash/i);
    expect(audits()).toHaveLength(count + 1); expect(audits().at(-1)).toMatchObject({ actorId });
    expect((await session(cookie)).body).toMatchObject({ accountId: id, impersonation: result.body.impersonation });
    expect(await request('/api/inventory-management/items', undefined, { cookie })).toMatchObject({ status: 200, body: { allowed: true, accountId: id } });
    expect((await request('/api/access/configuration', undefined, { cookie })).status).toBe(403);
  });
  it('writes Secure first-party owner and target companions when secure-cookie mode is enabled', async () => {
    process.env.LOCAL_ACCESS_COOKIE_SECURE = 'true';
    const result = await start(); expect(result.status).toBe(201);
    for (const name of [SECURE_OWNER_COOKIE, '__Host-vnet_access_session']) {
      expect(result.cookies.some(line => line.startsWith(`${name}=`) && /;\s*HttpOnly(?:;|$)/i.test(line) && /;\s*Secure(?:;|$)/i.test(line))).toBe(true);
    }
  });
  it('retries the same start without duplicating the audit or changing its target session', async () => {
    const id = mutation(), begun = await start(feishuId, undefined, id);
    expect(begun.status).toBe(201); const after = bytes();
    const retried = await start(feishuId, undefined, id);
    expect(retried.status).toBe(201); expect(bytes()).toEqual(after);
    expect(cookiePair(mergeCookies('', retried), MAIN_COOKIE)).toBe(cookiePair(mergeCookies('', begun), MAIN_COOKIE));
    expect(retried.body.impersonation).toEqual(begun.body.impersonation);
  });
  it.each(['disabled', 'deleted', 'offboarded'] as const)('never enters a %s target account', async state => {
    if (state === 'disabled') await updateAccount(feishuId, { enabled: false });
    if (state === 'deleted') await updateAccount(feishuId, { enabled: false, deleted: true });
    if (state === 'offboarded') await store.mutate(store.read().revision, mutation(), 'synthetic-offboarding', value => {
      value.personnelEmployment = { appId, snapshotAt: Date.now(), inactive: { [feishuId]: true }, loginBlocked: { [feishuId]: true } };
    });
    const before = bytes(), result = await start();
    expect(result.status).toBe(403); expect(result.cookies).toEqual([]); expect(bytes()).toEqual(before);
  });
  it('a delegated administrator cannot manage permissions or start another impersonation', async () => {
    const begun = await start(secondAdminId); expect(begun.status).toBe(201);
    const cookie = mergeCookies('', begun), before = bytes();
    expect((await request('/api/access/configuration', undefined, { cookie })).status).toBe(403);
    expect((await start(feishuId, { cookie })).status).toBe(403); expect(bytes()).toEqual(before);
  });
  it('a stolen target cookie alone cannot recover the administrator', async () => {
    const begun = await start(); expect(begun.status).toBe(201);
    const cookie = mergeCookies('', begun), before = bytes();
    const result = await stop(cookiePair(cookie, MAIN_COOKIE));
    expect([401, 403]).toContain(result.status); expect(result.cookies).toEqual([]); expect(bytes()).toEqual(before);
  });
  it('restores the original administrator after target disable and makes retry audit-idempotent', async () => {
    const initialCount = audits().length, begun = await start(); expect(begun.status).toBe(201);
    const cookie = mergeCookies('', begun);
    await updateAccount(feishuId, { enabled: false, version: store.read().accounts[feishuId].version + 1 });
    const recoverable = await session(cookie);
    expect(recoverable.body).toMatchObject({ role: 'guest', principalFingerprint: null, impersonation: { actorAccountId: actorId } });
    const id = mutation(), restored = await stop(cookie, id); expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ role: 'admin', accountId: actorId }); expect(restored.body.impersonation).toBeUndefined();
    const restoredCookie = mergeCookies(cookie, restored); expect(cookiePair(restoredCookie, OWNER_COOKIE)).toBe('');
    expect((await request('/api/access/configuration', undefined, { cookie: restoredCookie })).status).toBe(200);
    expect(audits()).toHaveLength(initialCount + 2);
    const after = bytes(), retry = await stop(cookie, id);
    expect(retry.status).toBe(201); expect(retry.body.accountId).toBe(actorId); expect(bytes()).toEqual(after);
  });
  it('exposes recovery context for an expired target only when its owner cookie remains valid', async () => {
    const begun = await start(); expect(begun.status).toBe(201);
    const cookie = mergeCookies('', begun), clock = jest.spyOn(Date, 'now').mockReturnValue(begun.body.impersonation.expiresAt + 1);
    try {
      const recovered = await session(cookie);
      expect(recovered.body).toMatchObject({ role: 'guest', principalFingerprint: null, impersonation: { actorAccountId: actorId } });
      expect((await request('/api/inventory-management/items', undefined, { cookie })).status).toBe(403);
      const orphan = await session(cookiePair(cookie, MAIN_COOKIE));
      expect(orphan.body.role).toBe('guest'); expect(orphan.body.impersonation).toBeUndefined();
    } finally { clock.mockRestore(); }
  });
  it('revoking the initiating administrator removes both target access and administrator recovery', async () => {
    const begun = await start(); expect(begun.status).toBe(201);
    const cookie = mergeCookies('', begun);
    await updateAccount(actorId, { enabled: false, version: store.read().accounts[actorId].version + 1 });
    const current = await session(cookie);
    expect(current.body.role).toBe('guest'); expect(current.body.impersonation).toBeUndefined();
    const before = bytes(), result = await stop(cookie);
    expect([401, 403]).toContain(result.status); expect(bytes()).toEqual(before);
  });
  it.each(['logout', 'login'] as const)('clears owner cookies on normal %s instead of leaving an admin recovery session', async operation => {
    const begun = await start(); expect(begun.status).toBe(201);
    const cookie = mergeCookies('', begun);
    const result = operation === 'logout'
      ? await request('/api/access/logout', {}, { cookie })
      : await request('/api/access/login', { password: PASSWORD, accountType: 'admin' }, { cookie });
    expect(result.status).toBe(201); expect(result.body.impersonation).toBeUndefined();
    expect(cookiePair(mergeCookies(cookie, result), OWNER_COOKIE)).toBe('');
    expect(result.cookies.some(line => line.startsWith(`${OWNER_COOKIE}=;`))).toBe(true);
  });
});
