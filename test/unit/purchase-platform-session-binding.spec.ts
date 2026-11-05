import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { hashAccessPassword, UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { PurchasePlatformSessionBinding } from '../../server/modules/purchase-inventory/purchase-platform-session-binding';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';

describe('isolated procurement binding with actual signed sessions', () => {
  const now = Date.UTC(2026, 9, 28, 6), appId = 'cli_synthetic_purchase_binding', employeeId = `local-external-${'b'.repeat(64)}`;
  const record = { recordId:'rec_synthetic', status: '审批通过（待下单）', building: 'C楼', specialty: '电气' } as never;
  let access: UnifiedAccessService, configuration: AccessConfigurationService, store: stores.AccessConfigurationStore;
  let directory: string, marker: string, adminToken: string, employeeToken: string, savedEnvironment: NodeJS.ProcessEnv, clock: jest.SpyInstance;
  beforeEach(async () => {
    savedEnvironment = { ...process.env }; clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-purchase-binding-')); marker = randomUUID();
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
    adminToken = access.issueTrustedSession(configuration.currentPrincipal('local-admin-all', 1)! as never, now).token;
    employeeToken = access.issueTrustedSession(configuration.currentPrincipal(employeeId, 1)! as never, now).token;
  });
  afterEach(() => {
    clock.mockRestore(); jest.restoreAllMocks(); process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('nt-purchase-binding-') || readFileSync(join(directory, '.owner'), 'utf8') !== marker) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive: true, force: false });
  });
  function request(token: string) {
    const identity = access.readSessionIdentity(token, now);
    return { headers: { cookie: `${access.cookieName}=${encodeURIComponent(token)}` }, accessPrincipal: identity.principal, accessPrincipalFingerprint: identity.principalFingerprint } as never;
  }
  function controller(binding?: PurchasePlatformSessionBinding) {
    const workflow = { getDetail: jest.fn(async (_id: string, session: unknown) => session) };
    const gateway = { getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-token') };
    const instance = new PurchaseInventoryController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, workflow as never, {} as never, {} as never, gateway as never, configuration, binding);
    return { instance, workflow };
  }
  it('passes the same verifier proof and assertion from a signed personal cookie without fabricating a Feishu ID', async () => {
    const binding = new PurchasePlatformSessionBinding(access, configuration), { instance } = controller(binding);
    const session: any = await instance.getWorkflowDetail(request(employeeToken), 'rec_synthetic');
    expect(session).toMatchObject({ openId: '', platformSession: true, userName: '合成姓名人员', platformProof: { actorAccountId: employeeId, subjectAccountId: employeeId } });
    expect(JSON.stringify(session.platformProof)).not.toContain(employeeToken);
    expect(() => session.assertPlatformProof('order', record)).not.toThrow();
    expect(() => session.assertPlatformProof('order', { ...record as object, status:'下单完成（待签收）' } as never)).toThrow();
    expect(() => session.assertPlatformPermission('order', { building:'C楼', specialty:'电气' })).not.toThrow();
    expect(() => session.assertPlatformPermission('order', { building:'C楼', specialty:'电气', status:'伪造' })).toThrow();
  });
  it('keeps administrator and target distinct and rejects the proof after the administrator ends impersonation', async () => {
    const delegation = await access.startImpersonation(adminToken, { accountId: employeeId, clientMutationId: `delegate-${randomUUID()}` }, now);
    const { instance } = controller(new PurchasePlatformSessionBinding(access, configuration));
    const session: any = await instance.getWorkflowDetail(request(delegation.token), 'rec_synthetic');
    expect(session).toMatchObject({ impersonated: true, openId: '', platformProof: { source:'impersonation', actorAccountId:'local-admin-all', subjectAccountId:employeeId } });
    expect(() => session.assertPlatformProof('order', record)).not.toThrow();
    await access.stopImpersonation(delegation.token, adminToken, `stop-${randomUUID()}`, now);
    expect(() => session.assertPlatformProof('order', record)).toThrow();
    expect(() => session.assertPlatformPermission('order', { building:'C楼', specialty:'电气' })).toThrow();
  });
  it('rejects cookie, principal and session-family mismatches without accepting supplied body fields', async () => {
    const { instance, workflow } = controller(new PurchasePlatformSessionBinding(access, configuration));
    const forged: any = request(employeeToken); forged.accessPrincipalFingerprint = 'x'.repeat(43); forged.body = { platformProof: { actorAccountId:employeeId } };
    await expect(instance.getWorkflowDetail(forged, 'rec_synthetic')).rejects.toThrow(); expect(workflow.getDetail).not.toHaveBeenCalled();
    const wrong: any = request(employeeToken); wrong.headers.cookie = `${access.cookieName}=${encodeURIComponent(adminToken)}`;
    await expect(instance.getWorkflowDetail(wrong, 'rec_synthetic')).rejects.toThrow(); expect(workflow.getDetail).not.toHaveBeenCalled();
    const altered: any = request(employeeToken); altered.accessPrincipal = { ...altered.accessPrincipal, role: 'admin' };
    await expect(instance.getWorkflowDetail(altered, 'rec_synthetic')).rejects.toThrow(); expect(workflow.getDetail).not.toHaveBeenCalled();
    const duplicate: any = request(employeeToken); duplicate.headers.cookie += `; ${access.cookieName}=${encodeURIComponent(employeeToken)}`;
    await expect(instance.getWorkflowDetail(duplicate, 'rec_synthetic')).rejects.toThrow(); expect(workflow.getDetail).not.toHaveBeenCalled();
  });
  it('leaves the existing nonpersonal shared account on its prior route', () => {
    const binding = new PurchasePlatformSessionBinding(access, configuration);
    expect(binding.bind(request(adminToken))).toBeUndefined();
  });
  it('leaves the unregistered default path unchanged', async () => {
    const { instance } = controller(); const session: any = await instance.getWorkflowDetail(request(employeeToken), 'rec_synthetic');
    expect(session.platformProof).toBeUndefined(); expect(session.assertPlatformProof).toBeUndefined();
  });
});
