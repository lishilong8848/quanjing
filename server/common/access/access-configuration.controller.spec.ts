import { Test } from '@nestjs/testing';
import { BadRequestException, type INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { UnifiedAccessModule } from './unified-access.module';
import { UnifiedAccessService, hashAccessPassword } from './unified-access.service';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { AccessConfigurationService } from './access-configuration.service';

describe('configuration HTTP authorization', () => {
  const saved = { ...process.env };
  let app: INestApplication, path: string, url: string, cookie: string;
  beforeEach(async () => {
    path = mkdtempSync(join(tmpdir(), 'vnet-admin-http-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(path, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-123');
    process.env.FEISHU_APP_ID = 'cli_test_configuration';
    process.env.FEISHU_APP_SECRET = ''; // Keep this HTTP fixture independent of background personnel sync.
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    const module = await Test.createTestingModule({ imports: [UnifiedAccessModule] })
      .overrideProvider(AccessConfigurationDirectory).useValue({ read: async () => ({ appId: process.env.FEISHU_APP_ID, people: [{ name: '示例人员016', openId: 'ou_configuration_test' }], snapshotAt: Date.now() }), assertKnown: async (ids: string[]) => { if (ids.some(id => id !== 'ou_configuration_test')) throw new BadRequestException('身份不可识别'); } }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    process.env.PUBLIC_BASE_URL = url;
    const access = app.get(UnifiedAccessService), configuration = app.get(AccessConfigurationService);
    const session = access.issueTrustedSession(configuration.localTargets().find(item => item.principal.role === 'admin')!.principal);
    cookie = `${access.cookieName}=${session.token}`;
  });
  afterEach(async () => { await app?.close(); process.env = { ...saved }; rmSync(path, { recursive: true, force: true }); });
  const payload = () => ({ clientMutationId: 'configuration-http-0001', expectedRevision: 0, id: 'local-editor-all', kind: 'local', name: '值班共享入口', role: 'editor', building: null, enabled: false });
  it('initializes the real module and forbids anonymous reads even in unrestricted mode', async () => {
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'false';
    expect([401,403]).toContain((await fetch(url + '/api/access/configuration')).status);
    const response = await fetch(url + '/api/access/configuration', { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('scrypt$');
  });
  it('requires same-origin writes, rejects unknown fields after redaction and keeps a clean audit', async () => {
    const post = (body: object, origin: string) => fetch(url + '/api/access/configuration/accounts', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(payload(), 'https://outside.example')).status).toBe(403);
    expect((await post({ ...payload(), arbitrary: 'not-allowed' }, url)).status).toBe(400);
    const response = await post(payload(), url);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ revision: 1, audit: [{ action: '停用授权' }] });
  });
  it('does not accept an editor cookie for configuration APIs', async () => {
    const access = app.get(UnifiedAccessService);
    cookie = `${access.cookieName}=${access.issueTrustedSession({ role: 'editor', purchaseBuilding: null }).token}`;
    expect([401,403]).toContain((await fetch(url + '/api/access/configuration', { headers: { cookie } })).status);
  });
  it('guards manual external authorization and saves it without directory or contact lookup', async () => {
    const body = { clientMutationId: 'external-fixture-save', expectedRevision: 0, kind: 'feishu', openId: 'ou_external_fixture', name: '外部合成人员', external: true, role: 'building_admin', building: 'A楼', enabled: true };
    const endpoint = url + '/api/access/configuration/accounts';
    const denied = await fetch(endpoint, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect([401,403]).toContain(denied.status);
    const response = await fetch(url + '/api/access/configuration/accounts', { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.accounts.find((account: { openId?: string }) => account.openId === body.openId)).toMatchObject({ name: '外部合成人员', external: true, role: 'building_admin', building: 'A楼' });
  });
  it('does not persist a new account when the external identity cannot be resolved', async () => {
    const body = { clientMutationId: 'external-rejected-save', expectedRevision: 0, kind: 'feishu', openId: 'ou_unknown', name: '任意姓名', role: 'editor', building: null, enabled: true };
    const response = await fetch(url + '/api/access/configuration/accounts', { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(app.get(AccessConfigurationService).snapshot().revision).toBe(0);
  });
  it('uses the directory name while retaining the non-enumerable Open ID on ordinary account creation', async () => {
    const body = { clientMutationId: 'directory-fixture-save', expectedRevision: 0, kind: 'feishu', openId: 'ou_configuration_test', name: '客户端旧姓名', role: 'editor', building: null, enabled: true };
    const response = await fetch(url + '/api/access/configuration/accounts', { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.accounts.find((account: { openId?: string }) => account.openId === body.openId)).toMatchObject({ name: '示例人员016', role: 'editor' });
  });
});
