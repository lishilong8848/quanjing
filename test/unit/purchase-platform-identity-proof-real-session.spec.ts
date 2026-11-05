import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { hashAccessPassword, UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { createPurchasePlatformIdentityVerifier } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';

describe('platform identity proof against real signed sessions and isolated configuration', () => {
  const now = Date.UTC(2026, 9, 28, 6), appId = 'cli_synthetic_purchase_identity', employeeId = `local-external-${'b'.repeat(64)}`;
  const target = { status: '审批通过（待下单）', building: 'C楼', specialty: '电气' };
  let access: UnifiedAccessService, configuration: AccessConfigurationService, store: stores.AccessConfigurationStore;
  let directory: string, marker: string, adminToken: string, employeeToken: string, savedEnvironment: NodeJS.ProcessEnv;
  let clock: jest.SpyInstance;
  beforeEach(async () => {
    savedEnvironment = { ...process.env }; clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-purchase-identity-')); marker = randomUUID();
    writeFileSync(join(directory, '.owner'), marker, { flag: 'wx' });
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 39).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true'; process.env.FEISHU_APP_ID = appId;
    const hash = hashAccessPassword('synthetic-only-purchase-password');
    const accounts: Record<string, stores.StoredAccount> = {
      'local-admin-all': { id: 'local-admin-all', kind: 'local', name: '合成管理员', role: 'admin', building: null, enabled: true, deleted: false, version: 1, source: 'default', passwordHash: hash },
      [employeeId]: { id: employeeId, kind: 'local', name: '合成姓名人员', role: 'purchase_admin', building: null, enabled: true, deleted: false, version: 1, source: 'configuration', passwordHash: hash, loginMethod: 'personnel-password', personnelActive: true, personnelAppId: appId },
    };
    store = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(store);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockImplementation(() => structuredClone(accounts));
    await store.mutate(0, `seed-${randomUUID()}`, 'fixture-only', state => { state.accounts = structuredClone(accounts); migrateAuthorizationState(state, accounts); });
    configuration = new AccessConfigurationService(); access = new UnifiedAccessService(configuration);
    const admin = configuration.currentPrincipal('local-admin-all', 1)!, employee = configuration.currentPrincipal(employeeId, 1)!;
    adminToken = access.issueTrustedSession(admin as never, now).token;
    employeeToken = access.issueTrustedSession(employee as never, now).token;
  });
  afterEach(() => {
    clock.mockRestore(); jest.restoreAllMocks(); process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('nt-purchase-identity-') || readFileSync(join(directory, '.owner'), 'utf8') !== marker) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive: true, force: false });
  });
  function verifier() {
    return createPurchasePlatformIdentityVerifier({ readSignedSession: (token, at) => access.readSessionIdentity(token, at), snapshot: () => configuration.snapshot(), currentPrincipal: (id, version) => configuration.currentPrincipal(id, version) });
  }
  it('verifies a signed in-service name account without any Feishu binding', () => {
    const instance = verifier(), proof = instance.verify(employeeToken);
    expect(proof).toMatchObject({ source: 'platform', actorAccountId: employeeId, actorDisplayName: '合成姓名人员', subjectAccountId: employeeId, subjectDisplayName: '合成姓名人员' });
    expect(proof.actorFeishuOpenId).toBeUndefined(); expect(JSON.stringify(proof)).not.toContain(employeeToken);
    expect(() => instance.assertCurrent(proof, 'order', target)).not.toThrow();
    expect(() => instance.assertCurrent(proof, 'start', { ...target, status: '审批通过（待库房确认）' })).not.toThrow();
    expect(() => instance.assertCurrent(proof, 'start', target)).toThrow();
  });
  it('verifies a signed impersonation and rejects it immediately after explicit stop', async () => {
    const delegation = await access.startImpersonation(adminToken, { accountId: employeeId, clientMutationId: `delegate-${randomUUID()}` }, now);
    const instance = verifier(), proof = instance.verify(delegation.token);
    expect(proof).toMatchObject({ source: 'impersonation', actorAccountId: 'local-admin-all', actorAuthorizationVersion: 1, actorDisplayName: '合成管理员', subjectAccountId: employeeId, subjectAuthorizationVersion: 1, subjectDisplayName: '合成姓名人员' });
    expect(() => instance.assertCurrent(proof, 'order', target)).not.toThrow();
    await access.stopImpersonation(delegation.token, adminToken, `stop-${randomUUID()}`, now);
    expect(() => instance.assertCurrent(proof, 'order', target)).toThrow();
  });
  it('rejects a changed administrator version in a previously signed delegation', async () => {
    const delegation = await access.startImpersonation(adminToken, { accountId: employeeId, clientMutationId: `delegate-${randomUUID()}` }, now);
    const instance = verifier(), proof = instance.verify(delegation.token);
    await store.mutate(store.read().revision, `change-${randomUUID()}`, 'fixture-only', state => { state.accounts['local-admin-all'].version += 1; });
    expect(() => instance.assertCurrent(proof, 'order', target)).toThrow();
  });
});
