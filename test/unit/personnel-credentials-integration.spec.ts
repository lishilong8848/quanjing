import { Controller, Post, type INestApplication } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessPersonnelSyncService } from '../../server/common/access/access-personnel-sync.service';
import { PersonnelCredentialsService } from '../../server/common/access/personnel-credentials.service';
import { PersonnelCredentialsGateway, type PersonnelCredentialRecord } from '../../server/common/access/personnel-credentials.gateway';
import { PersonnelSecurityStore } from '../../server/common/access/personnel-security.store';
import { UnifiedAccessModule } from '../../server/common/access/unified-access.module';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { PublicAccess } from '../../server/common/access/unified-access.decorators';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';

@Controller('api/credential-public-probe')
@PublicAccess()
class CredentialPublicProbe {
  @Post()
  write() { return { allowed: true }; }
}

describe('personnel credential real module/configuration/guard integration', () => {
  const appId = 'cli_credential_synthetic', appToken = 'bascnCredentialSynthetic1', tableId = 'tblCredential1', recordId = 'recCredential1';
  const identity = '11010519491231002X', name = '合成人员', newPassword = 'new shared password';
  const id = 'local-external-' + createHash('sha256').update(JSON.stringify([appId, appToken, tableId, recordId])).digest('hex');
  const linkedId = 'feishu-' + feishuIdentityFingerprint(appId, 'ou_credential_synthetic');
  let app: INestApplication | undefined, directory: string, url: string, savedEnvironment: NodeJS.ProcessEnv;
  let store: stores.AccessConfigurationStore, access: UnifiedAccessService, configuration: AccessConfigurationService;
  let record: PersonnelCredentialRecord, gateway: any;
  const cookie = (token: string) => `vnet_access_session=${token}`;
  const passwordBody = (clientMutationId = randomUUID()) => ({ currentPassword: '31002x', newPassword, confirmPassword: newPassword, clientMutationId });
  async function request(path: string, options: { body?: unknown; cookie?: string; origin?: string } = {}) {
    const response = await fetch(url + path, { method: options.body === undefined ? 'GET' : 'POST',
      headers: { cookie: options.cookie || '', ...(options.body === undefined ? {} : { 'content-type': 'application/json', origin: options.origin || url }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  }
  beforeEach(async () => {
    savedEnvironment = { ...process.env };
    directory = mkdtempSync(join(tmpdir(), 'personnel-credentials-integration-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.PERSONNEL_SECURITY_FILE = join(directory, 'security.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_APP_SECRET = '';
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    delete process.env.LOCAL_ACCESS_COOKIE_SECURE; delete process.env.LOCAL_ACCESS_TRUST_PROXY; delete process.env.CLIENT_BASE_PATH;
    const credentials = await buildExternalEmployeeCredentials([{ record_id: recordId, fields: {
      姓名: name, 身份证号: identity, 密码: '', '离职/异动情况': false,
    } }], appId, appToken, tableId);
    const accounts: Record<string, stores.StoredAccount> = {
      [id]: { id, kind: 'local', name, role: 'editor', building: null, enabled: true, deleted: false, version: 1,
        source: 'configuration', loginMethod: 'personnel-password', personnelActive: true, personnelAppId: appId, passwordHash: credentials[0].passwordHash,
        personnelIdentity: id, permissionSource: 'manual' },
      [linkedId]: { id: linkedId, kind: 'feishu', name, role: 'editor', building: null, enabled: true, deleted: false, version: 1,
        source: 'configuration', appId, identityHash: feishuIdentityFingerprint(appId, 'ou_credential_synthetic'), personnelIdentity: id },
      'local-admin-all': { id: 'local-admin-all', kind: 'local', name: '合成管理员', role: 'admin', building: null,
        enabled: true, deleted: false, version: 1, source: 'default', passwordHash: hashAccessPassword('synthetic-admin-only') },
    };
    store = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(store);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockImplementation(() => structuredClone(accounts));
    await store.mutate(0, randomUUID(), 'isolated-credentials-fixture', state => { state.accounts = structuredClone(accounts); });
    record = { appId, appToken, tableId, recordId, accountId: id, name, identityNumber: identity, password: '', token: 'mock-only-token' };
    gateway = { findActive: jest.fn(async () => ({ ...record })), fresh: jest.fn(async () => ({ ...record })),
      writePassword: jest.fn(async (_record, hash) => { record.password = hash; }) };
    const module = await Test.createTestingModule({ imports: [UnifiedAccessModule], controllers: [CredentialPublicProbe] })
      .overrideProvider(PersonnelCredentialsGateway).useValue(gateway)
      .overrideProvider(AccessPersonnelSyncService).useValue({ refreshForLogin: jest.fn(async () => undefined) })
      .overrideProvider(HttpService).useValue({ axiosRef: { get: () => { throw new Error('Unexpected outbound HTTP'); },
        post: () => { throw new Error('Unexpected outbound HTTP'); }, put: () => { throw new Error('Unexpected outbound HTTP'); } } })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1'); url = await app.getUrl(); process.env.PUBLIC_BASE_URL = url;
    access = app.get(UnifiedAccessService); configuration = app.get(AccessConfigurationService);
  });
  afterEach(async () => {
    await app?.close(); app = undefined;
    jest.restoreAllMocks(); process.env = savedEnvironment;
    rmSync(directory, { recursive: true, force: true });
  });

  it('injects the credentials service, restricts first login even on PublicAccess, and revokes both old sessions after change', async () => {
    expect(app!.get(PersonnelCredentialsService)).toBeInstanceOf(PersonnelCredentialsService);
    expect(app!.get(PersonnelSecurityStore)).toBeInstanceOf(PersonnelSecurityStore);
    const initial = await access.login({ employeeName: name, password: ' 31002x ' }, '192.0.2.1');
    expect(initial.principal.requiresPasswordChange).toBe(true);
    const renewed = access.renew(initial.token)!;
    expect(renewed.principal.requiresPasswordChange).toBe(true);
    const linked = access.issueTrustedSession(configuration.currentPrincipal(linkedId, 1)!);
    expect((await request('/api/credential-public-probe', { body: {}, cookie: cookie(initial.token) })).status).toBe(403);
    const profile = await request('/api/access/personal/profile', { cookie: cookie(renewed.token) });
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ requiresPasswordChange: true, canChangePassword: true });
    const changed = await request('/api/access/personal/password/change', { body: passwordBody(), cookie: cookie(initial.token) });
    expect(changed).toMatchObject({ status: 201, body: { success: true } });
    expect(changed.cookies.some(value => value.includes('vnet_access_session=;'))).toBe(true);
    expect(access.renew(initial.token)).toBeNull();
    expect(access.renew(linked.token)).toBeNull();
    expect(store.read().accounts[id].role).toBe('editor');
    expect(store.read().accounts[linkedId].version).toBe(2);
    const next = await access.login({ employeeName: name, password: newPassword }, '192.0.2.1');
    expect(next.principal.requiresPasswordChange).not.toBe(true);
    expect((await request('/api/credential-public-probe', { body: {}, cookie: cookie(next.token) })).status).toBe(201);
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
    expect(store.read().audit.filter(row => row.action === '更新人员密码')).toHaveLength(1);
  });

  it('supports anonymous full-ID reset, rejects cross-origin writes and invalidates an existing login', async () => {
    const initial = await access.login({ employeeName: name, password: '31002X' }, '192.0.2.1');
    const body = { employeeName: name, identityNumber: identity, newPassword, confirmPassword: newPassword, clientMutationId: randomUUID() };
    const cross = await request('/api/access/personal/password/reset', { body, origin: 'https://foreign.invalid' });
    expect(cross.status).toBe(403);
    expect(gateway.writePassword).not.toHaveBeenCalled();
    expect((await request('/api/access/personal/password/reset', { body })).status).toBe(201);
    expect(access.renew(initial.token)).toBeNull();
    expect((await access.login({ employeeName: name, password: newPassword }, '192.0.2.1')).principal.accountId).toBe(id);
  });

  it('configuration commit is idempotent and cannot re-enable a revoked account', async () => {
    const initial = await access.login({ employeeName: name, password: '31002X' }, '192.0.2.1');
    const body = passwordBody();
    await app!.get(PersonnelCredentialsService).changePassword(initial.principal, body);
    const current = store.read().accounts[id];
    const revision = store.read().revision, audits = store.read().audit.length;
    const repeated = await configuration.commitPersonnelPassword(id, current.passwordHash!, current.passwordHash!, body.clientMutationId);
    expect(repeated.authorizationVersion).toBe(current.version);
    expect(store.read().revision).toBe(revision);
    expect(store.read().audit.length).toBe(audits);
    await store.mutate(revision, randomUUID(), 'disable-synthetic-only', state => { state.accounts[id].enabled = false; });
    await expect(configuration.commitPersonnelPassword(id, current.passwordHash!, current.passwordHash!, body.clientMutationId)).rejects.toThrow('不可用');
  });
  it('namespaces the credential receipt by account so two people can use the same request ID', async () => {
    const secondId = 'local-external-' + 'f'.repeat(64);
    const original = store.read().accounts[id];
    await store.mutate(store.read().revision, randomUUID(), 'second-synthetic-account', state => {
      state.accounts[secondId] = { ...original, id: secondId, personnelIdentity: secondId, name: '另一合成人员' };
    });
    const mutation = 'same-synthetic-request', firstHash = hashAccessPassword('synthetic-new-first'), secondHash = hashAccessPassword('synthetic-new-second');
    await configuration.commitPersonnelPassword(id, original.passwordHash!, firstHash, mutation);
    await configuration.commitPersonnelPassword(secondId, original.passwordHash!, secondHash, mutation);
    expect(store.read().accounts[id].passwordHash).toBe(firstHash);
    expect(store.read().accounts[secondId].passwordHash).toBe(secondHash);
    expect(store.read().audit.filter(row => row.action === '更新人员密码')).toHaveLength(2);
  });
});
