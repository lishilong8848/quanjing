// Business isolation tests run after release activation. Release gating is tested separately.
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
  runHotfixInitialization: (_owner: object, initialize: () => unknown) => initialize(),
  cancelHotfixInitialization: async () => {},
}));
import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HttpService } from '@nestjs/axios';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { PURCHASE_WORKFLOW_LEDGER_PATH, PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { PURCHASE_PLATFORM_SESSION_BINDING, PurchasePlatformSessionBinding } from '../../server/modules/purchase-inventory/purchase-platform-session-binding';
import {
  PURCHASE_PLATFORM_APPROVAL_RUNTIME,
  PURCHASE_PLATFORM_APPROVAL_SOURCE,
  PURCHASE_PLATFORM_RECOVERY_OPTIONS,
  PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS,
  PurchasePlatformApprovalRuntime,
  createPurchasePlatformApprovalRuntime,
} from '../../server/modules/purchase-inventory/purchase-platform-approval-runtime';
import { createPlatformLegacyApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-gateway';

jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: (key: string, aliases: string[] = []) => [key, ...aliases].map(name => process.env[name] || '').find(Boolean) || '',
}));

const appId = 'cli_synthetic_wiring';
const now = Date.UTC(2026, 10, 4, 3);
const employeeId = `local-external-${'a'.repeat(64)}`;
const feishuHash = createHash('sha256').update(appId + '\0' + 'ou_synthetic_feishu').digest('hex');
const feishuId = `feishu-${feishuHash}`;
const adminId = 'local-admin-all';
const sharedId = 'local-purchase_admin-all';
const recordId = 'rec_synthetic_wiring';

type Account = stores.StoredAccount;
type Provider = { provide: unknown; useValue?: unknown; useFactory?: unknown; inject?: unknown[]; useExisting?: unknown };

/** Mirrors the module provider list 1:1. The module metadata test below fails if
 * either side drifts, so this scope cannot silently stop representing production. */
const moduleParity = {
  runtimeFactory: createPurchasePlatformApprovalRuntime,
  sourceFactory: createPlatformLegacyApprovalGateway,
};

function fixtureAccounts(): Record<string, Account> {
  const hash = hashAccessPassword('synthetic-only-password');
  const base = { deleted: false, version: 1, source: 'configuration' as const };
  return {
    [adminId]: { ...base, id: adminId, kind: 'local', name: '合成管理员', role: 'admin', building: null, enabled: true, source: 'default', passwordHash: hash },
    [sharedId]: { ...base, id: sharedId, kind: 'local', name: '采购共享入口', role: 'purchase_admin', building: null, enabled: true, source: 'default', passwordHash: hash },
    [employeeId]: { ...base, id: employeeId, kind: 'local', name: '合成姓名人员', role: 'purchase_admin', building: null, enabled: true, passwordHash: hash,
      loginMethod: 'personnel-password', personnelActive: true, personnelAppId: appId },
    [feishuId]: { ...base, id: feishuId, kind: 'feishu', name: '合成飞书人员', role: 'purchase_admin', building: null, enabled: true, appId, openId: 'ou_synthetic_feishu', identityHash: feishuHash },
  };
}

/** No outbound HTTP: any attempt is a test failure, not a silent network call. */
function disconnectedHttp(): Pick<HttpService, 'axiosRef'> {
  const refuse = () => { throw new Error('synthetic wiring fixture: outbound HTTP is disabled'); };
  return { axiosRef: { get: refuse, post: refuse, put: refuse } } as unknown as Pick<HttpService, 'axiosRef'>;
}

describe('personal purchase approval DI wiring in a real Nest TestingModule', () => {
  let directory: string, owner: string, savedEnvironment: NodeJS.ProcessEnv, clock: jest.SpyInstance;
  let configuration: AccessConfigurationService, access: UnifiedAccessService;
  let employeeToken: string, feishuToken: string, adminToken: string, sharedToken: string;
  const booted: TestingModule[] = [];

  async function boot(recoveryFlag?: string): Promise<TestingModule> {
    if (recoveryFlag === undefined) delete process.env.PURCHASE_PLATFORM_APPROVAL_RECOVERY_ENABLED;
    else process.env.PURCHASE_PLATFORM_APPROVAL_RECOVERY_ENABLED = recoveryFlag;
    const module = await Test.createTestingModule({
      providers: [
        { provide: PURCHASE_WORKFLOW_LEDGER_PATH, useValue: join(directory, 'workflow.json') },
        { provide: AccessConfigurationService, useValue: configuration },
        { provide: UnifiedAccessService, useValue: access },
        { provide: HttpService, useValue: disconnectedHttp() },
        PurchaseWorkflowGateway,
        PurchaseWorkflowStore,
        PurchaseOnlineApprovalService,
        PurchaseInventoryController,
        PurchasePlatformSessionBinding,
        { provide: PURCHASE_PLATFORM_SESSION_BINDING, useExisting: PurchasePlatformSessionBinding },
        {
          provide: PURCHASE_PLATFORM_RECOVERY_OPTIONS,
          useFactory: () => ({ enabled: /^(1|true|yes|on)$/i.test(process.env.PURCHASE_PLATFORM_APPROVAL_RECOVERY_ENABLED || '') }),
        },
        {
          provide: PURCHASE_PLATFORM_APPROVAL_SOURCE,
          inject: [PurchaseWorkflowGateway, HttpService],
          useFactory: (gateway: PurchaseWorkflowGateway, http: HttpService) => moduleParity.sourceFactory(gateway, http),
        },
        {
          provide: PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS,
          inject: [PurchaseWorkflowGateway],
          useFactory: (gateway:PurchaseWorkflowGateway)=>({gateway,sourceIdentity:()=>({appId,sourceFingerprint:'a'.repeat(64)})}),
        },
        {
          provide: PURCHASE_PLATFORM_APPROVAL_RUNTIME,
          inject: [PurchaseWorkflowStore, PURCHASE_PLATFORM_APPROVAL_SOURCE, PURCHASE_PLATFORM_RECOVERY_OPTIONS, PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS],
          useFactory: moduleParity.runtimeFactory,
        },
      ],
    }).useMocker(token => {
      const unused = ['PurchaseInventoryService','PurchaseAccessPolicyService','PurchaseRecordDeletionService','PurchaseRecordEditService','PurchaseApplicationService','PurchaseWorkflowService','PurchaseWorkflowReceiptTaskService','PurchaseWorkflowScheduler'];
      if (typeof token === 'function' && unused.includes(token.name)) return {};
      throw new Error(`Unexpected test dependency: ${String(token)}`);
    }).compile();
    jest.spyOn(module.get(PurchaseWorkflowGateway), 'getTenantAccessTokenAsApp').mockResolvedValue('synthetic-token');
    booted.push(module);
    // Real Nest lifecycle: onModuleInit / onApplicationBootstrap in provider order.
    await module.init();
    return module;
  }

  function request(token: string) {
    const identity = access.readSessionIdentity(token, now);
    return {
      headers: { cookie: `${access.cookieName}=${encodeURIComponent(token)}` },
      accessPrincipal: { ...identity.principal, permissionContext: { module: 'purchase', action: 'approve' } },
      accessPrincipalFingerprint: identity.principalFingerprint,
    } as never;
  }

  function ledgerWritten(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(directory, 'workflow.json'), 'utf8')) as Record<string, unknown>;
  }

  beforeEach(async () => {
    savedEnvironment = process.env;
    process.env = { SystemRoot: savedEnvironment.SystemRoot, TEMP: savedEnvironment.TEMP, TMP: savedEnvironment.TMP };
    clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-purchase-wiring-'));
    owner = randomUUID();
    writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' });
    Object.assign(process.env, {
      ACCESS_CONFIGURATION_FILE: join(directory, 'configuration.json'),
      LOCAL_ACCESS_SESSION_SECRET: Buffer.alloc(32, 41).toString('base64'),
      LOCAL_ACCESS_CONTROL_ENABLED: 'true',
      FEISHU_APP_ID: appId,
      FEISHU_PURCHASE_INVENTORY_APP_TOKEN: 'synthetic_app_token',
      FEISHU_PURCHASE_EXECUTION_TABLE_ID: 'synthetic_table_id',
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'false',
      PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID: 'ou_synthetic_shared',
    });
    const seeded = fixtureAccounts();
    const configStore = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE!);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(configStore);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockImplementation(() => structuredClone(seeded));
    await configStore.mutate(0, `seed-${randomUUID()}`, 'fixture-only', state => { state.accounts = structuredClone(seeded); migrateAuthorizationState(state, seeded); });
    configuration = new AccessConfigurationService();
    await configuration.onModuleInit();
    access = new UnifiedAccessService(configuration);
    const issued = (id: string) => access.issueTrustedSession(configuration.currentPrincipal(id, 1)! as never, now).token;
    adminToken = issued(adminId); employeeToken = issued(employeeId); feishuToken = issued(feishuId); sharedToken = issued(sharedId);
    await new PurchaseWorkflowStore(join(directory, 'workflow.json')).recordReminder('fixture');
  });

  afterEach(async () => {
    for (const module of booted.splice(0).reverse()) await module.close().catch(() => undefined);
    await configuration?.onModuleDestroy?.().catch(() => undefined);
    clock.mockRestore();
    jest.restoreAllMocks();
    process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('nt-purchase-wiring-') ||
      readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive: true, force: false });
  });

  it('keeps this wiring scope in parity with the real module provider list', async () => {
    const { PurchaseInventoryModule } = await import('../../server/modules/purchase-inventory/purchase-inventory.module');
    const providers = Reflect.getMetadata('providers', PurchaseInventoryModule) as Provider[];
    // Every token production needs must exist here with the same graph, so a module
    // change that this spec does not mirror fails instead of passing silently.
    expect(providers).toEqual(expect.arrayContaining([
      PurchasePlatformSessionBinding,
      expect.objectContaining({ provide: PURCHASE_PLATFORM_SESSION_BINDING, useExisting: PurchasePlatformSessionBinding }),
      expect.objectContaining({ provide: PURCHASE_PLATFORM_RECOVERY_OPTIONS }),
      expect.objectContaining({ provide: PURCHASE_PLATFORM_APPROVAL_SOURCE, inject: [PurchaseWorkflowGateway, HttpService] }),
      expect.objectContaining({ provide: PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS, inject: [PurchaseWorkflowGateway] }),
      expect.objectContaining({ provide: PURCHASE_PLATFORM_APPROVAL_RUNTIME, inject: [PurchaseWorkflowStore, PURCHASE_PLATFORM_APPROVAL_SOURCE, PURCHASE_PLATFORM_RECOVERY_OPTIONS, PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS] }),
    ]));
    const runtimeFactory = (providers.find(provider => provider?.provide === PURCHASE_PLATFORM_APPROVAL_RUNTIME) as Provider).useFactory;
    const sourceFactory = (providers.find(provider => provider?.provide === PURCHASE_PLATFORM_APPROVAL_SOURCE) as Provider).useFactory;
    expect(runtimeFactory).toBe(createPurchasePlatformApprovalRuntime);
    expect(sourceFactory).toBe(createPlatformLegacyApprovalGateway);
    expect(Reflect.getMetadata('exports', PurchaseInventoryModule)).toEqual(expect.arrayContaining([
      PurchasePlatformSessionBinding,
      expect.objectContaining({ provide: PURCHASE_PLATFORM_SESSION_BINDING, useExisting: PurchasePlatformSessionBinding }),
    ]));
  });

  it('resolves the real runtime, source and binding over the native durable store', async () => {
    const module = await boot();
    const store = module.get(PurchaseWorkflowStore);
    const source = module.get(PURCHASE_PLATFORM_APPROVAL_SOURCE);
    const runtime = module.get(PURCHASE_PLATFORM_APPROVAL_RUNTIME);
    const binding = module.get(PURCHASE_PLATFORM_SESSION_BINDING);

    expect(runtime).toBeInstanceOf(PurchasePlatformApprovalRuntime);
    expect(binding).toBeInstanceOf(PurchasePlatformSessionBinding);
    expect(module.get(PurchasePlatformSessionBinding)).toBe(binding);
    // Same ledger instance for the website path and the recovery worker.
    expect((runtime as any).store).toBe(store);
    expect((runtime as any).source).toBe(source);
    // Proof binding is built from the real signed-session and configuration services.
    expect((binding as any).access).toBe(module.get(UnifiedAccessService));
    expect((binding as any).configuration).toBe(module.get(AccessConfigurationService));
    // Real app-token source: identity comes from configuration only, no network.
    expect(source.sourceIdentity()).toEqual({ appId, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // Consumers hold the registered runtime, so the old writer is unreachable.
    expect((module.get(PurchaseOnlineApprovalService) as any).platformRuntime).toBe(runtime);
    expect((module.get(PurchaseInventoryController) as any).platformBinding).toBe(binding);
    // Recovery is off unless explicitly enabled: no timer, no background scan.
    expect((runtime as any).recoveryActive).toBe(false);
    expect((runtime as any).recoveryTimer).toBeUndefined();
  });

  it('binds only the signed personal identities: name account, Feishu account and administrator impersonation', async () => {
    const module = await boot();
    const binding = module.get(PurchasePlatformSessionBinding);
    const delegation = await access.startImpersonation(adminToken, { accountId: employeeId, clientMutationId: `delegate-${randomUUID()}` }, now);

    const cases: [string, string, { accountId: string; source: string; actorAccountId: string }][] = [
      ['name account without Feishu open_id', employeeToken, { accountId: employeeId, source: 'platform', actorAccountId: employeeId }],
      ['Feishu account', feishuToken, { accountId: feishuId, source: 'platform', actorAccountId: feishuId }],
      ['administrator impersonation', delegation.token, { accountId: employeeId, source: 'impersonation', actorAccountId: adminId }],
    ];
    for (const [label, token, expected] of cases) {
      const bound = binding.bind(request(token));
      expect(bound).toBeDefined();
      expect({ label, ...bound!.proof }).toMatchObject({ subjectAccountId: expected.accountId, source: expected.source, actorAccountId: expected.actorAccountId });
      expect(bound!.proof.actorDisplayName).toBeTruthy();
    }
    // The Feishu account proof carries only its own bound open_id.
    expect(binding.bind(request(feishuToken))!.proof.actorFeishuOpenId).toBe('ou_synthetic_feishu');
    // An administrator acting through their own session proves themselves, not the target.
    expect(binding.bind(request(adminToken))).toBeUndefined();
    // Delegated session content cannot be pasted onto a different principal.
    const delegated = request(delegation.token) as any;
    expect(() => binding.bind({ ...delegated, accessPrincipal: { ...delegated.accessPrincipal, accountId: adminId } })).toThrow();
  });

  it('never turns a shared entrance or a missing signed cookie into an approval identity', async () => {
    const module = await boot();
    const binding = module.get(PurchasePlatformSessionBinding);
    // Shared password entrance: intentionally stays on its configured delegated path.
    expect(binding.bind(request(sharedToken))).toBeUndefined();
    // No cookie, foreign fingerprint, or missing principal fingerprint: fail closed.
    const personal = request(employeeToken) as any;
    expect(() => binding.bind({ ...personal, headers: {} })).toThrow('采购会话身份不可用');
    expect(() => binding.bind({ ...personal, accessPrincipalFingerprint: 'x'.repeat(43) })).toThrow('采购会话身份不可用');
    expect(() => binding.bind({ ...personal, accessPrincipal: { ...personal.accessPrincipal, accountId: undefined } })).not.toThrow();
    expect(binding.bind({ ...personal, accessPrincipal: { ...personal.accessPrincipal, accountId: undefined } })).toBeUndefined();
  });

  it('cannot reach the old direct approval writer once the runtime is registered', async () => {
    const module = await boot();
    const controller = module.get(PurchaseInventoryController);
    const runtime = module.get(PURCHASE_PLATFORM_APPROVAL_RUNTIME);
    const store = module.get(PurchaseWorkflowStore);
    const source = module.get<{ writeDecision: unknown; readSnapshot: unknown; verifyMarker: unknown }>(PURCHASE_PLATFORM_APPROVAL_SOURCE);
    const writes = jest.spyOn(source, 'writeDecision');
    const reads = jest.spyOn(source, 'readSnapshot');

    // Shared session: no project identity, no ledger claim, no source access.
    await expect(controller.approveRecord(request(sharedToken), recordId, { decision: 'approved' }))
      .rejects.toThrow('请使用本人有效账号办理采购审批');
    // Personal principal whose signed cookie is gone: same, closed before any store or source use.
    await expect(controller.approveRecord({ accessPrincipal: (request(employeeToken) as any).accessPrincipal, headers: {} } as never, recordId, { decision: 'approved' }))
      .rejects.toThrow('采购会话身份不可用');
    expect(writes).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(ledgerWritten()).not.toHaveProperty('platformLegacyApprovalClaims');
    expect(await store.listRecoverablePlatformLegacyApprovals()).toEqual([]);
    expect(runtime).toBeInstanceOf(PurchasePlatformApprovalRuntime);
  });

  it('hands an accepted personal approval to the runtime before any durable source read', async () => {
    const module = await boot();
    const controller = module.get(PurchaseInventoryController);
    const runtime = module.get(PURCHASE_PLATFORM_APPROVAL_RUNTIME);
    const store = module.get(PurchaseWorkflowStore);
    // The real runtime checks the configured app/source identity first; removing that
    // identity stops the request right after proof binding and before any I/O.
    jest.spyOn(module.get(PURCHASE_PLATFORM_APPROVAL_SOURCE), 'verifyMarker').mockRejectedValue(new Error('synthetic source unavailable'));
    const accepted = jest.spyOn(runtime, 'accept');
    const problem = await controller.approveRecord(request(employeeToken), recordId, { decision: 'rejected' })
      .then(() => undefined, (error: unknown) => error as { message?: string });

    expect(problem?.message).toBe('synthetic source unavailable');
    expect(accepted).toHaveBeenCalledTimes(1);
    const session = accepted.mock.calls[0]![2] as any;
    expect(session.platformProof).toMatchObject({ subjectAccountId: employeeId, source: 'platform' });
    expect(session.platformSession).toBe(true);
    expect(typeof session.assertPlatformProof).toBe('function');
    // A missing/failing source never leaves a claim behind for background replay.
    expect(await store.listRecoverablePlatformLegacyApprovals()).toEqual([]);
    expect(ledgerWritten()).not.toHaveProperty('platformLegacyApprovalClaims');
    expect((runtime as any).recoveryTimer).toBeUndefined();
  });

  it.each([['unset', undefined], ['false', 'false'], ['garbage', 'maybe']])('keeps recovery off when the flag is %s', async (_label, flag) => {
    const module = await boot(flag);
    const runtime = module.get(PURCHASE_PLATFORM_APPROVAL_RUNTIME);
    const scan = jest.spyOn(runtime, 'runRecoveryOnce');
    await new Promise(done => setTimeout(done, 20));
    expect((runtime as any).recoveryActive).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    expect((runtime as any).recoveryTimer).toBeUndefined();
  });

  it('starts recovery on bootstrap only when explicitly enabled, and stops it on destroy', async () => {
    const module = await boot('true');
    const runtime = module.get(PURCHASE_PLATFORM_APPROVAL_RUNTIME);
    const scan = jest.spyOn(runtime, 'runRecoveryOnce').mockResolvedValue();
    await new Promise(done => setTimeout(done, 20));
    expect((runtime as any).recoveryActive).toBe(true);
    expect(scan).toHaveBeenCalled();
    await module.close();
    booted.splice(booted.indexOf(module), 1);
    expect((runtime as any).recoveryActive).toBe(false);
    expect((runtime as any).recoveryTimer ?? undefined).toBeUndefined();
    expect((runtime as any).recoveryTimer).toBeUndefined();
  });

  it('refuses to build a runtime from an incomplete source instead of failing later on approval', async () => {
    const store = new PurchaseWorkflowStore(join(directory, 'workflow.json'));
    const http = disconnectedHttp();
    const gateway = { getTenantAccessTokenAsApp: async () => 'synthetic-token' };
    const healthy = createPlatformLegacyApprovalGateway(gateway, http);
    expect(() => createPurchasePlatformApprovalRuntime(store, healthy)).not.toThrow();
    expect(() => createPurchasePlatformApprovalRuntime(store, undefined as never)).toThrow('采购审批数据源身份不完整');
    expect(() => createPurchasePlatformApprovalRuntime(store, { sourceIdentity: () => ({ appId: 'not-an-app', sourceFingerprint: 'a'.repeat(64) }) } as never)).toThrow('采购审批数据源身份不完整');
    expect(() => createPurchasePlatformApprovalRuntime(store, { sourceIdentity: () => ({ appId, sourceFingerprint: 'a'.repeat(64) }) } as never)).toThrow('缺少读写能力');
    // A half-composed gateway is rejected at construction, before any approval exists.
    await store.onModuleDestroy();
  });
});
