import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState, reprojectAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { ACCESS_SESSION_TTL_MS, hashAccessPassword, UnifiedAccessService } from '../../server/common/access/unified-access.service';

describe('administrator impersonation security with an isolated real configuration store', () => {
  const now = Date.UTC(2026, 9, 28, 6), appId = 'cli_synthetic_impersonation';
  const openId = 'ou_synthetic_impersonated', targetId = `feishu-${feishuIdentityFingerprint(appId, openId)}`;
  const employeeId = `local-external-${'b'.repeat(64)}`;
  const secret = Buffer.alloc(32, 47), hash = hashAccessPassword('synthetic-impersonation-password');
  let access: UnifiedAccessService, configuration: AccessConfigurationService, store: stores.AccessConfigurationStore;
  let directory: string, marker: string, savedEnvironment: NodeJS.ProcessEnv;
  let clock: jest.SpyInstance, adminToken: string;
  const request = (accountId = targetId) => ({ accountId, clientMutationId: `impersonation-${randomUUID()}` });
  const actor = () => configuration.localTargets().find(item => item.principal.role === 'admin')!.principal;
  const start = (body = request(), at = now) => access.startImpersonation(adminToken, body, at);

  beforeEach(async () => {
    savedEnvironment = { ...process.env };
    clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-impersonation-security-'));
    marker = randomUUID(); writeFileSync(join(directory, '.owner'), marker, { flag: 'wx' });
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = secret.toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.FEISHU_APP_ID = appId;
    const accounts: Record<string, stores.StoredAccount> = {
      'local-admin-all': { id: 'local-admin-all', kind: 'local', name: '合成管理员', role: 'admin', building: null,
        enabled: true, deleted: false, version: 1, source: 'default', passwordHash: hash },
      'local-editor-all': { id: 'local-editor-all', kind: 'local', name: '合成共享入口', role: 'editor', building: null,
        enabled: true, deleted: false, version: 1, source: 'default', passwordHash: hash },
      [employeeId]: { id: employeeId, kind: 'local', name: '合成姓名登录人员', role: 'editor', building: null,
        enabled: true, deleted: false, version: 1, source: 'configuration', passwordHash: hash,
        loginMethod: 'personnel-password', personnelActive: true, personnelAppId: appId },
      [targetId]: { id: targetId, kind: 'feishu', name: '合成被代登录人员', role: 'inventory_admin', building: 'H楼',
        buildings: ['H楼'], enabled: true, deleted: false, version: 1, source: 'configuration', appId, openId,
        identityHash: feishuIdentityFingerprint(appId, openId), permissionSource: 'manual' },
    };
    store = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(store);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockImplementation(() => structuredClone(accounts));
    await store.mutate(0, `seed-${randomUUID()}`, 'fixture-only', state => {
      state.accounts = structuredClone(accounts); migrateAuthorizationState(state, accounts);
    });
    configuration = new AccessConfigurationService(); access = new UnifiedAccessService(configuration);
    adminToken = access.issueTrustedSession(actor(), now).token;
  });
  afterEach(() => {
    clock.mockRestore(); jest.restoreAllMocks(); process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() ||
      !basename(directory).startsWith('nt-impersonation-security-') || readFileSync(join(directory, '.owner'), 'utf8') !== marker) {
      throw new Error('Synthetic fixture ownership mismatch');
    }
    rmSync(directory, { recursive: true, force: false });
  });
  async function mutate(change: (state: stores.ConfigurationState) => void) {
    await store.mutate(store.read().revision, `change-${randomUUID()}`, 'fixture-only', change);
  }
  function resign(token: string, changes: Record<string, unknown>) {
    const payload = { ...JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')), ...changes };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
  }

  it('has canonical bound administrator, Feishu and personnel-password identities in the isolated fixture', () => {
    expect(actor()).toMatchObject({ accountId: 'local-admin-all', role: 'admin' });
    expect(configuration.currentPrincipal(targetId, 1)).toMatchObject({ accountId: targetId, role: 'inventory_admin', purchaseBuilding: 'H楼' });
    expect(configuration.currentPrincipal(employeeId, 1)).toMatchObject({ accountId: employeeId, role: 'editor' });
  });
  it('uses the exact target identity with a distinct fingerprint and a fixed fifteen minute lifetime', async () => {
    const admin = access.readSessionIdentity(adminToken, now), result = await start();
    expect(result.principal).toMatchObject({ role: 'inventory_admin', accountId: targetId, buildings: ['H楼'] });
    expect(result.principalFingerprint).not.toBe(admin.principalFingerprint);
    expect(result.expiresAt).toBe(now + 15 * 60_000);
    const renewed = access.renew(result.token, now + 14 * 60_000)!;
    expect(renewed.expiresAt).toBe(result.expiresAt);
    expect(renewed.principalFingerprint).toBe(result.principalFingerprint);
    expect(access.readSessionIdentity(renewed.token, result.expiresAt).principal.role).toBe('guest');
  });
  it('never extends past the original administrator expiry and cannot renew back to a normal target session', async () => {
    const at = now + 55 * 60_000; clock.mockReturnValue(at);
    const result = await start(request(), at);
    expect(result.expiresAt).toBe(now + ACCESS_SESSION_TTL_MS);
    const renewed = access.renew(result.token, result.expiresAt - 1)!;
    expect(renewed.expiresAt).toBe(result.expiresAt);
    expect(JSON.parse(Buffer.from(renewed.token.split('.')[0], 'base64url').toString('utf8')).version).toBe(11);
  });
  it('rejects non-admin sources, anonymous sources, legacy unbound sources and nested starts', async () => {
    const editor = configuration.localTargets().find(item => item.principal.role === 'editor')!.principal;
    const editorToken = access.issueTrustedSession(editor, now).token;
    await expect(access.startImpersonation(editorToken, request(), now)).rejects.toThrow();
    await expect(access.startImpersonation(undefined, request(), now)).rejects.toThrow();
    const unbound = new UnifiedAccessService().issueTrustedSession({ role: 'admin', purchaseBuilding: null }, now).token;
    await expect(access.startImpersonation(unbound, request(), now)).rejects.toThrow();
    const result = await start();
    await expect(access.startImpersonation(result.token, request('local-editor-all'), now)).rejects.toThrow();
  });
  it.each(['disabled', 'deleted', 'departed', 'password-missing'] as const)('rejects an ineligible %s target without accepting a new session', async mode => {
    let accountId = targetId;
    await mutate(state => {
      if (mode === 'disabled') state.accounts[targetId].enabled = false;
      if (mode === 'deleted') state.accounts[targetId].deleted = true;
      if (mode === 'departed') state.personnelEmployment = { appId, snapshotAt: now, inactive: { [targetId]: true }, loginBlocked: { [targetId]: true } };
      if (mode === 'password-missing') { accountId = 'local-editor-all'; delete state.accounts[accountId].passwordHash; }
    });
    await expect(start(request(accountId))).rejects.toThrow();
  });
  it('keeps shared local account login eligibility and the original administrator can restore only with the owner credential', async () => {
    const result = await start(request('local-editor-all'));
    expect(result.principal).toMatchObject({ accountId: 'local-editor-all', role: 'editor' });
    await expect(access.stopImpersonation(result.token, undefined, `stop-${randomUUID()}`, now)).rejects.toThrow();
    const anotherFamily = access.issueTrustedSession(actor(), now).token;
    await expect(access.stopImpersonation(result.token, anotherFamily, `stop-${randomUUID()}`, now)).rejects.toThrow();
    const restored = await access.stopImpersonation(result.token, adminToken, `stop-${randomUUID()}`, now);
    expect(restored.principal).toMatchObject({ role: 'admin', accountId: actor().accountId });
    const original = access.readSessionIdentity(adminToken, now);
    expect(restored.expiresAt).toBe(original.expiresAt);
    expect(restored.principalFingerprint).toBe(original.principalFingerprint);
    expect(access.readSessionIdentity(result.token, now).principal.role).toBe('guest');
  });
  it('supports a live personnel-password target but refuses the same person when its active source is removed', async () => {
    expect((await start(request(employeeId))).principal).toMatchObject({ accountId: employeeId, role: 'editor' });
    await mutate(state => { state.accounts[employeeId].personnelActive = false; state.accounts[employeeId].version++; });
    await expect(start(request(employeeId))).rejects.toThrow();
  });
  it('can restore a live owner after target revocation, without allowing the revoked target to execute requests', async () => {
    const result = await start();
    await mutate(state => { state.accounts[targetId].enabled = false; state.accounts[targetId].version++; });
    expect(access.readSessionIdentity(result.token, now).principal.role).toBe('guest');
    expect(access.impersonationReturnContext(result.token, adminToken, now)).toBeDefined();
    const restored = await access.stopImpersonation(result.token, adminToken, `stop-${randomUUID()}`, now);
    expect(restored.principal.role).toBe('admin');
  });
  it('can restore an expired delegate within the original owner expiry but not beyond it', async () => {
    const result = await start(), later = result.expiresAt + 1;
    clock.mockReturnValue(later);
    expect(access.readSessionIdentity(result.token, later).principal.role).toBe('guest');
    const restored = await access.stopImpersonation(result.token, adminToken, `stop-${randomUUID()}`, later);
    expect(restored.principal.role).toBe('admin');
    expect(restored.expiresAt).toBe(now + ACCESS_SESSION_TTL_MS);
    clock.mockReturnValue(now + ACCESS_SESSION_TTL_MS + 1);
    await expect(access.stopImpersonation(result.token, adminToken, `stop-${randomUUID()}`, now + ACCESS_SESSION_TTL_MS + 1)).rejects.toThrow();
  });
  it.each(['disabled', 'version', 'role'] as const)('revokes delegation and recovery when original administrator %s changes', async mode => {
    const result = await start();
    await mutate(state => {
      const account = state.accounts['local-admin-all'];
      if (mode === 'disabled') account.enabled = false;
      if (mode === 'version') account.version++;
      if (mode === 'role') { account.role = 'editor'; account.authorizationBinding = { mode: 'follow', templateId: 'builtin-editor' }; reprojectAuthorizationState(state); }
    });
    expect(access.readSessionIdentity(result.token, now).principal.role).toBe('guest');
    expect(access.impersonationReturnContext(result.token, adminToken, now)).toBeUndefined();
    await expect(access.stopImpersonation(result.token, adminToken, `stop-${randomUUID()}`, now)).rejects.toThrow();
  });
  it('fails closed on tampering, unknown signed fields and another signing key', async () => {
    const result = await start();
    expect(access.readSessionIdentity(`${result.token}x`, now).principal.role).toBe('guest');
    expect(access.readSessionIdentity(resign(result.token, { arbitraryRole: 'admin' }), now).principal.role).toBe('guest');
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 48).toString('base64');
    const rotated = new UnifiedAccessService(configuration);
    expect(rotated.readSessionIdentity(result.token, now).principal.role).toBe('guest');
    expect(rotated.impersonationReturnContext(result.token, adminToken, now)).toBeUndefined();
  });
  it('makes start and stop retry audits idempotent and binds a mutation to its original target', async () => {
    const body = request(), result = await start(body), afterStart = store.read().audit.length;
    const retried = await start(body, now + 1000);
    expect(retried.token).toBe(result.token);
    expect(store.read().audit).toHaveLength(afterStart);
    await expect(start({ ...body, accountId: 'local-editor-all' })).rejects.toThrow();
    const mutation = `stop-${randomUUID()}`;
    await access.stopImpersonation(result.token, adminToken, mutation, now);
    const afterStop = store.read().audit.length;
    await access.stopImpersonation(result.token, adminToken, mutation, now + 1000);
    expect(store.read().audit).toHaveLength(afterStop);
    expect(access.readSessionIdentity(result.token, now).principal.role).toBe('guest');
  });
});
