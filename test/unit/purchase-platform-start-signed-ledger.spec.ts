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

describe('signed platform start through controller and durable local ledger', () => {
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
        personalRules:[{ id:'deny-a-order', effect:'deny', module:'purchase', actions:['create'], buildings:['A楼'], specialties:null }] },
    };
    configStore = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(configStore);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockImplementation(() => structuredClone(accounts));
    await configStore.mutate(0, `seed-${randomUUID()}`, 'fixture-only', state => { state.accounts = structuredClone(accounts); migrateAuthorizationState(state, accounts); });
    config = new AccessConfigurationService(); access = new UnifiedAccessService(config);
    adminToken = access.issueTrustedSession(config.currentPrincipal('local-admin-all', 1)! as never, now).token;
    employeeToken = access.issueTrustedSession(config.currentPrincipal(employeeId, 1)! as never, now).token;
    live = { recordId:'rec_synthetic', requestCode:'CG-TEST', status:'审批通过（待库房确认）', itemName:'合成物品', building:'C楼', specialty:'电气', requesterOpenId:'ou_requester', requesterName:'合成申请人', purchaserOpenId:'ou_assigned', purchaserName:'原采购人', purchaseMethod:'综合采购', requestedQuantity:1, actualQuantity:null, actualAmount:null, approvalCompleted:true, warehouseConfirmed:false, purchaseCompleted:false, receiptConfirmed:false, signer:'', receiptTime:null, receiptPhotoTokens:[], invoiceTokens:[] };
    gateway = { getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-tenant-token'), getExecutionRecordAsApp: jest.fn(async () => structuredClone(live)), getExecutionRecord: jest.fn(async () => structuredClone(live)),
      resolveUser: jest.fn(async () => { throw new Error('无飞书身份不得虚构操作人'); }),
      updateExecutionRecord: jest.fn(async (_id: string, patch: Record<string, unknown>) => { live = { ...live, status:String(patch['采购流程']), warehouseConfirmed: Boolean(patch['库房确认']) };  }) };
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
    return { headers:{ cookie:`${access.cookieName}=${encodeURIComponent(token)}` }, accessPrincipal:{ ...identity.principal, permissionContext:{ module:'purchase', action:'create' } }, accessPrincipalFingerprint:identity.principalFingerprint } as never;
  }
  async function execute(token: string) { return controller.startWorkflow(request(token), 'rec_synthetic'); }
  it('保留原采购人，真实签名身份写入隔离账本', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    const result = await execute(employeeToken); expect(result.idempotent).toBe(false);
    const patch = gateway.updateExecutionRecord.mock.calls[0][1];
    expect(patch['采购人']).toBeUndefined();
    expect(live.purchaserOpenId).toBe('ou_assigned');
    expect(gateway.resolveUser).not.toHaveBeenCalled();
    const command = await workflowStore.findCommand('start:rec_synthetic');
    expect(command).toMatchObject({ actorOpenId:'', platformIdentity:{ actorAccountId:employeeId, subjectAccountId:employeeId } });
    expect(command?.completedAt).toBeTruthy();
    expect(readFileSync(join(directory, 'workflow.json'), 'utf8')).not.toContain(employeeToken);
  });
  it('超出楼栋权限时不能认领或写入', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true'; live.building = 'A楼';
    await expect(execute(employeeToken)).rejects.toThrow();
    expect(await workflowStore.findCommand('start:rec_synthetic')).toBeNull();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('阶段变化时不能认领或写入', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true'; live.status = '驳回申请';
    await expect(execute(employeeToken)).rejects.toThrow();
    expect(await workflowStore.findCommand('start:rec_synthetic')).toBeNull();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('已认领后写前状态发生变化时，不写入且释放未发送的命令', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    gateway.getExecutionRecord.mockImplementationOnce(async () => structuredClone(live))
      .mockImplementationOnce(async () => ({ ...structuredClone(live), status:'驳回申请' }));
    await expect(execute(employeeToken)).rejects.toThrow();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
    expect(await workflowStore.findCommand('start:rec_synthetic')).toBeNull();
  });
  it('自采未指定采购人时由申请人办理', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    live.purchaseMethod = '需求自采'; live.purchaserOpenId = ''; live.purchaserName = '';
    gateway.updateExecutionRecord.mockImplementationOnce(async (_id: string, patch: Record<string, any>) => {
      live = { ...live, status:String(patch['采购流程']), warehouseConfirmed:true, purchaserOpenId:patch['采购人'][0].id };
    });
    await execute(employeeToken);
    expect(gateway.updateExecutionRecord.mock.calls[0][1]['采购人']).toEqual([{ id:'ou_requester' }]);
  });
  it('综合采购未指定采购人时使用服务端可信路由', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    live.purchaserOpenId = ''; live.purchaserName = '';
    gateway.findComprehensivePurchaser = jest.fn(async () => ({ openId:'ou_routed', name:'可信采购人', positions:[], buildings:['C楼'] }));
    gateway.updateExecutionRecord.mockImplementationOnce(async (_id: string, patch: Record<string, any>) => {
      live = { ...live, status:String(patch['采购流程']), warehouseConfirmed:true, purchaserOpenId:patch['采购人'][0].id };
    });
    await execute(employeeToken);
    expect(gateway.findComprehensivePurchaser).toHaveBeenCalledWith(expect.any(String), { building:'C楼', specialty:'电气' });
    expect(gateway.updateExecutionRecord.mock.calls[0][1]['采购人']).toEqual([{ id:'ou_routed' }]);
  });
  it('写前原采购人变化时停止而不覆盖', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    gateway.getExecutionRecord.mockImplementationOnce(async () => structuredClone(live))
      .mockImplementationOnce(async () => ({ ...structuredClone(live), purchaserOpenId:'ou_other' }));
    await expect(execute(employeeToken)).rejects.toThrow();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
    expect(await workflowStore.findCommand('start:rec_synthetic')).toBeNull();
  });
  it('全局开关关闭时普通人员即使有权限也不能认领或写入', async () => {
    expect(process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED).toBe('false');
    await expect(execute(employeeToken)).rejects.toThrow();
    expect(await workflowStore.findCommand('start:rec_synthetic')).toBeNull();
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('全局开关关闭仍保留既有管理员例外', async () => {
    process.env.PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID = 'ou_synthetic_admin';
    live.purchaseMethod = '需求自采';
    gateway.resolveUser.mockResolvedValue({ openId:'ou_synthetic_admin', name:'合成管理员', positions:[], buildings:[] });
    gateway.updateExecutionRecord.mockImplementationOnce(async (_id: string, patch: Record<string, any>) => {
      live = { ...live, status:String(patch['采购流程']), warehouseConfirmed:true, purchaserOpenId:patch['采购人'][0].id };
    });
    await expect(execute(adminToken)).resolves.toMatchObject({ idempotent:false });
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
});
