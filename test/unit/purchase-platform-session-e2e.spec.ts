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
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';
import { canPerformBusinessAction } from '../../shared/business-permissions';

jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: (key: string, aliases: string[] = []) => [key, ...aliases].map(name => process.env[name] || '').find(Boolean) || '',
}));

describe('signed personal procurement session through controller and durable local ledger', () => {
  const now = Date.UTC(2026, 9, 28, 6), appId = 'cli_synthetic_purchase_e2e', employeeId = `local-external-${'c'.repeat(64)}`;
  let access: UnifiedAccessService, config: AccessConfigurationService, configStore: stores.AccessConfigurationStore, workflowStore: PurchaseWorkflowStore;
  let workflow: PurchaseWorkflowService, controller: PurchaseInventoryController, gateway: any, live: PurchaseWorkflowRecord;
  let directory: string, marker: string, adminToken: string, employeeToken: string, savedEnvironment: NodeJS.ProcessEnv, clock: jest.SpyInstance;
  beforeEach(async () => {
    savedEnvironment = process.env; process.env = { SystemRoot: savedEnvironment.SystemRoot, TEMP: savedEnvironment.TEMP, TMP: savedEnvironment.TMP };
    clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-purchase-e2e-')); marker = randomUUID();
    writeFileSync(join(directory, '.owner'), marker, { flag:'wx' });
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 39).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true'; process.env.FEISHU_APP_ID = appId;
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false'; process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    const hash = hashAccessPassword('synthetic-only-password');
    const accounts: Record<string, stores.StoredAccount> = {
      'local-admin-all': { id:'local-admin-all', kind:'local', name:'合成管理员', role:'admin', building:null, enabled:true, deleted:false, version:1, source:'default', passwordHash:hash },
      [employeeId]: { id:employeeId, kind:'local', name:'合成姓名人员', role:'purchase_admin', building:null, enabled:true, deleted:false, version:1, source:'configuration', passwordHash:hash, loginMethod:'personnel-password', personnelActive:true, personnelAppId:appId,
        personalRules:[{ id:'deny-a-order', effect:'deny', module:'purchase', actions:['order'], buildings:['A楼'], specialties:null }, { id:'allow-c-approve',effect:'allow',module:'purchase',actions:['approve'],buildings:['C楼'],specialties:null }] },
    };
    configStore = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(configStore);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockImplementation(() => structuredClone(accounts));
    await configStore.mutate(0, `seed-${randomUUID()}`, 'fixture-only', state => { state.accounts = structuredClone(accounts); migrateAuthorizationState(state, accounts); });
    config = new AccessConfigurationService(); access = new UnifiedAccessService(config);
    adminToken = access.issueTrustedSession(config.currentPrincipal('local-admin-all', 1)! as never, now).token;
    employeeToken = access.issueTrustedSession(config.currentPrincipal(employeeId, 1)! as never, now).token;
    live = { recordId:'rec_synthetic', requestCode:'CG-TEST', status:'审批通过（待下单）', itemName:'合成物品', building:'C楼', specialty:'电气', requesterOpenId:'ou_requester', requesterName:'合成申请人', purchaserOpenId:'ou_assigned', purchaserName:'原采购人', purchaseMethod:'综合采购', requestedQuantity:1, actualQuantity:null, actualAmount:null, approvalCompleted:true, warehouseConfirmed:true, purchaseCompleted:false, receiptConfirmed:false, signer:'', receiptTime:null, receiptPhotoTokens:[], invoiceTokens:[] };
    gateway = { getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-tenant-token'), getExecutionRecordAsApp: jest.fn(async () => structuredClone(live)), getExecutionRecord: jest.fn(async () => structuredClone(live)),
      resolveUser: jest.fn(async () => { throw new Error('无飞书身份不得虚构操作人'); }),
      updateExecutionRecord: jest.fn(async (_id: string, patch: Record<string, unknown>) => { live = { ...live, status:String(patch['采购流程']), actualQuantity:Number(patch['实际采购数量']), actualAmount:Number(patch['实际付款金额']), purchaseCompleted: true }; }) };
    workflowStore = new PurchaseWorkflowStore(join(directory, 'workflow.json')); await workflowStore.onModuleInit();
    workflow = new PurchaseWorkflowService(gateway, workflowStore, undefined, config);
    controller = new PurchaseInventoryController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, workflow, {} as never, {} as never, gateway, config, new PurchasePlatformSessionBinding(access, config));
  });
  afterEach(async () => {
    workflow.onModuleDestroy(); await workflowStore.onModuleDestroy(); clock.mockRestore(); jest.restoreAllMocks(); process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('nt-purchase-e2e-') || readFileSync(join(directory, '.owner'), 'utf8') !== marker) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive:true, force:false });
  });
  function request(token: string) {
    const identity = access.readSessionIdentity(token, now);
    return { headers:{ cookie:`${access.cookieName}=${encodeURIComponent(token)}` }, accessPrincipal:{ ...identity.principal, permissionContext:{ module:'purchase', action:'order' } }, accessPrincipalFingerprint:identity.principalFingerprint } as never;
  }
  it('offers approval to a signed personally authorized account without requiring a card roster position', async () => {
    live.status='未开始（待审批）'; live.approvalCompleted=false;
    const detail=await controller.getWorkflowDetail(request(employeeToken),'rec_synthetic');
    expect(detail.allowedActions).toContain('approve');
    expect(gateway.resolveUser).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  async function execute(token: string) {
    return controller.orderWorkflow(request(token), 'rec_synthetic', JSON.stringify({ actualQuantity:2, actualAmount:5, note:'' }), []);
  }
  async function checkStored(token: string, actorId: string, subjectId: string, source: 'platform' | 'impersonation') {
    const result = await execute(token); expect(result.idempotent).toBe(false);
    const command = await workflowStore.findCommand('order:rec_synthetic');
    expect(command).toMatchObject({ actorOpenId:'', platformIdentity:{ source, actorAccountId:actorId, subjectAccountId:subjectId,
      actorDisplayName:source === 'impersonation' ? '合成管理员' : '合成姓名人员', subjectDisplayName:'合成姓名人员' }, platformDispatch:'dispatch_started' });
    expect(command?.completedAt).toBeTruthy(); expect(command?.platformIdentity?.actorFeishuOpenId).toBeUndefined();
    expect(live.purchaserOpenId).toBe('ou_assigned'); expect(live.purchaserName).toBe('原采购人');
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1); expect(gateway.updateExecutionRecord.mock.calls[0][1]['采购人']).toBeUndefined();
    expect(gateway.resolveUser).not.toHaveBeenCalled();
    const bytes = readFileSync(join(directory, 'workflow.json'), 'utf8'); expect(bytes).not.toContain(token); expect(bytes).not.toContain('synthetic-tenant-token');
    const replay = await execute(token); expect(replay.idempotent).toBe(true); expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  }
  it('uses a signed name account with no linked Feishu identity', async () => { await checkStored(employeeToken, employeeId, employeeId, 'platform'); });
  it('records the real administrator and target separately for a signed impersonation', async () => {
    const delegation = await access.startImpersonation(adminToken, { accountId:employeeId, clientMutationId:`delegate-${randomUUID()}` }, now);
    await checkStored(delegation.token, 'local-admin-all', employeeId, 'impersonation');
  });
  it('does not write when the record stage changes', async () => {
    live.status = '驳回申请'; await expect(execute(employeeToken)).rejects.toThrow();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled(); expect(await workflowStore.findCommand('order:rec_synthetic')).toBeNull();
  });
  it('honors an explicit per-building order denial before claiming or writing', async () => {
    expect(canPerformBusinessAction(config.currentPrincipal(employeeId, 1)!, { module:'purchase', action:'order', building:'A楼', specialty:'电气' })).toBe(false);
    live.building = 'A楼'; await expect(execute(employeeToken)).rejects.toThrow();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled(); expect(await workflowStore.findCommand('order:rec_synthetic')).toBeNull();
  });
  it('does not write when the signed account is revoked after the request was authenticated', async () => {
    const priorRequest = request(employeeToken);
    await configStore.mutate(configStore.read().revision, `revoke-${randomUUID()}`, 'fixture-only', state => {
      state.accounts[employeeId]!.enabled = false; state.accounts[employeeId]!.version += 1;
    });
    await expect(controller.orderWorkflow(priorRequest, 'rec_synthetic', JSON.stringify({ actualQuantity:2, actualAmount:5, note:'' }), [])).rejects.toThrow();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled(); expect(await workflowStore.findCommand('order:rec_synthetic')).toBeNull();
  });
  it('does not write twice after the remote write succeeds but its response is lost', async () => {
    gateway.updateExecutionRecord.mockImplementationOnce(async () => { live = { ...live, status:'下单完成（待签收）', actualQuantity:2, actualAmount:5, purchaseCompleted:true }; throw new Error('synthetic lost response'); });
    await expect(execute(employeeToken)).rejects.toThrow();
    expect((await workflowStore.findCommand('order:rec_synthetic'))?.platformDispatch).toBe('dispatch_started');
    await expect(execute(employeeToken)).rejects.toThrow();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
  it('does not write twice when a successful write has a mismatching readback', async () => {
    gateway.updateExecutionRecord.mockImplementationOnce(async () => undefined);
    await expect(execute(employeeToken)).rejects.toThrow('回读不一致');
    const command=await workflowStore.findCommand('order:rec_synthetic'); expect(command?.platformDispatch).toBe('dispatch_started'); expect(command?.completedAt).toBeFalsy();
    await expect(execute(employeeToken)).rejects.toThrow(); expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
  it('does not write twice when post-write readback is unavailable', async () => {
    gateway.getExecutionRecord.mockImplementation(async () => { if (gateway.updateExecutionRecord.mock.calls.length) throw new Error('synthetic readback failure'); return structuredClone(live); });
    await expect(execute(employeeToken)).rejects.toThrow();
    expect((await workflowStore.findCommand('order:rec_synthetic'))?.platformDispatch).toBe('dispatch_started');
    await expect(execute(employeeToken)).rejects.toThrow(); expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
});
