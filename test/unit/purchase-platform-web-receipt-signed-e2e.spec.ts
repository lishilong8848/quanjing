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
import { PurchaseWorkflowReceiptTaskService } from '../../server/modules/purchase-inventory/purchase-workflow-receipt-task.service';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';
import { canPerformBusinessAction } from '../../shared/business-permissions';

jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: (key: string, aliases: string[] = []) => [key, ...aliases].map(name => process.env[name] || '').find(Boolean) || '',
}));

describe('signed web receipt personal identity through controller and durable ledger', () => {
  const now = Date.UTC(2026, 9, 28, 6), appId = 'cli_synthetic_purchase_e2e', employeeId = `local-external-${'c'.repeat(64)}`;
  let access: UnifiedAccessService, config: AccessConfigurationService, configStore: stores.AccessConfigurationStore, workflowStore: PurchaseWorkflowStore;
  let receipt: PurchaseWorkflowReceiptTaskService, workflow: PurchaseWorkflowService, controller: PurchaseInventoryController, gateway: any, live: PurchaseWorkflowRecord;
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
        personalRules:[{ id:'deny-a-receive', effect:'deny', module:'purchase', actions:['receive'], buildings:['A楼'], specialties:null }] },
    };
    configStore = new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(configStore);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockImplementation(() => structuredClone(accounts));
    await configStore.mutate(0, `seed-${randomUUID()}`, 'fixture-only', state => { state.accounts = structuredClone(accounts); migrateAuthorizationState(state, accounts); });
    config = new AccessConfigurationService(); access = new UnifiedAccessService(config);
    adminToken = access.issueTrustedSession(config.currentPrincipal('local-admin-all', 1)! as never, now).token;
    employeeToken = access.issueTrustedSession(config.currentPrincipal(employeeId, 1)! as never, now).token;
    live = { recordId:'rec_synthetic', requestCode:'CG-TEST', status:'下单完成（待签收）', itemName:'合成物品', building:'C楼', specialty:'电气', requesterOpenId:'ou_requester', requesterName:'合成申请人', purchaserOpenId:'ou_assigned', purchaserName:'原采购人', purchaseMethod:'综合采购', requestedQuantity:1, actualQuantity:null, actualAmount:null, approvalCompleted:true, warehouseConfirmed:true, purchaseCompleted:false, receiptConfirmed:false, signer:'', receiptTime:null, receiptPhotoTokens:[], invoiceTokens:[] };
    gateway = { getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-tenant-token'), getExecutionRecordAsApp: jest.fn(async () => structuredClone(live)), getExecutionRecord: jest.fn(async () => structuredClone(live)),
      resolveUser: jest.fn(async () => { throw new Error('无飞书身份不得虚构操作人'); }),
      uploadAttachment: jest.fn(async () => 'synthetic-upload-token'),
      updateExecutionRecord: jest.fn(async (_id: string, patch: Record<string, unknown>) => { live = { ...live, status:String(patch['采购流程']), purchaseCompleted:patch['采购完成'] === true, receiptConfirmed:patch['到货签收确认（签收内容填写完成后点击）'] === true, receiptTime:Number(patch['签收时间']), note:String(patch['采购备注'] || ''), signer:'合成签收人', signerOpenId:'ou_synthetic_signer', receiptPhotoTokens:(patch['签收附件'] as { file_token:string }[]).map(row => row.file_token) }; }) };
    workflowStore = new PurchaseWorkflowStore(join(directory, 'workflow.json')); await workflowStore.onModuleInit();
    workflow = new PurchaseWorkflowService(gateway, workflowStore, undefined, config);
    receipt = new PurchaseWorkflowReceiptTaskService(gateway, workflow, workflowStore);
    const systemImmediate = global.setImmediate; jest.spyOn(global, 'setImmediate').mockImplementation(((fn: (...args: unknown[]) => void, ...args: unknown[]) => fn.length === 0 ? ({ unref() {} }) : systemImmediate(fn, ...args)) as never);
    controller = new PurchaseInventoryController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, workflow, receipt, {} as never, gateway, config, new PurchasePlatformSessionBinding(access, config));
  });
  afterEach(async () => {
    workflow.onModuleDestroy(); await workflowStore.onModuleDestroy(); clock.mockRestore(); jest.restoreAllMocks(); process.env = savedEnvironment;
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('nt-purchase-e2e-') || readFileSync(join(directory, '.owner'), 'utf8') !== marker) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive:true, force:false });
  });
  function request(token: string) {
    const identity = access.readSessionIdentity(token, now);
    return { headers:{ cookie:`${access.cookieName}=${encodeURIComponent(token)}` }, accessPrincipal:{ ...identity.principal, permissionContext:{ module:'purchase', action:'receive' } }, accessPrincipalFingerprint:identity.principalFingerprint } as never;
  }
  async function submit(token: string) {
    const buffer = Buffer.from('synthetic receipt');
    return controller.receiveWorkflow(request(token), 'rec_synthetic', JSON.stringify({ signer:'合成签收人', signerOpenId:'ou_synthetic_signer', receiptTime:now, note:'', clientMutationId:'synthetic-receipt' }), { receiptPhotos:[{ originalname:'receipt.jpg', mimetype:'image/jpeg', size:buffer.length, buffer }], invoices:[] });
  }
  it('接受真实签名的无飞书人员，并持久记录本人和独立业务签收人', async () => {
    const result = await submit(employeeToken);
    const task = await workflowStore.findWebReceipt(result.taskId);
    expect(task?.webReceipt).toMatchObject({ actor:{ openId:'', name:'合成姓名人员' }, platformIdentity:{ source:'platform', actorAccountId:employeeId, subjectAccountId:employeeId }, input:{ signerOpenId:'ou_synthetic_signer' } });
    expect(readFileSync(join(directory,'workflow.json'),'utf8')).not.toContain(employeeToken);
    await workflowStore.onModuleDestroy();
    workflowStore = new PurchaseWorkflowStore(join(directory, 'workflow.json')); await workflowStore.onModuleInit();
    expect((await workflowStore.findWebReceipt(result.taskId))?.webReceipt).toEqual(task?.webReceipt);
    const original = readFileSync(join(directory, 'workflow.json'), 'utf8');
    const damaged = JSON.parse(original);
    const entry = damaged.notifications.find((row: { kind:string }) => row.kind === 'web_receipt_command');
    entry.recipientOpenId = 'invalid-not-an-open-id';
    writeFileSync(join(directory, 'workflow.json'), JSON.stringify(damaged));
    await expect(workflowStore.findWebReceipt(result.taskId)).rejects.toThrow();
    entry.recipientOpenId = '';
    entry.kind = 'invalid-notification-kind';
    writeFileSync(join(directory, 'workflow.json'), JSON.stringify(damaged));
    await expect(workflowStore.findWebReceipt(result.taskId)).rejects.toThrow();
    writeFileSync(join(directory, 'workflow.json'), original);
  });
  it('代登录时持久区分实际管理员与目标账户', async () => {
    const delegated = await access.startImpersonation(adminToken, { accountId:employeeId, clientMutationId:`delegate-${randomUUID()}` }, now);
    const result = await submit(delegated.token);
    const task = await workflowStore.findWebReceipt(result.taskId);
    expect(task?.webReceipt).toMatchObject({ actor:{ openId:'', name:'合成管理员' }, platformIdentity:{ source:'impersonation', actorAccountId:'local-admin-all', subjectAccountId:employeeId }, input:{ signerOpenId:'ou_synthetic_signer' } });
    await expect(controller.getReceiptTask(request(employeeToken), result.taskId)).resolves.toMatchObject({ success:false });
  });
  it('跨楼无权限及失效阶段不创建签收任务', async () => {
    live.building = 'A楼'; await expect(submit(employeeToken)).rejects.toThrow();
    expect(await workflowStore.listNotifications({ kind:'web_receipt_command' })).toHaveLength(0);
    live.building = 'C楼'; live.status = '驳回申请'; await expect(submit(employeeToken)).rejects.toThrow();
    expect(await workflowStore.listNotifications({ kind:'web_receipt_command' })).toHaveLength(0);
  });
  it('已认证但受理前被停用的账号不能创建签收任务', async () => {
    const originalRequest = request(employeeToken);
    await configStore.mutate(configStore.read().revision, `revoke-${randomUUID()}`, 'fixture-only', state => { state.accounts[employeeId]!.enabled = false; state.accounts[employeeId]!.version += 1; });
    const buffer = Buffer.from('synthetic receipt');
    await expect(controller.receiveWorkflow(originalRequest, 'rec_synthetic', JSON.stringify({ signer:'合成签收人', signerOpenId:'ou_synthetic_signer', receiptTime:now, note:'' }), { receiptPhotos:[{ originalname:'receipt.jpg', mimetype:'image/jpeg', size:buffer.length, buffer }] })).rejects.toThrow();
    expect(await workflowStore.listNotifications({ kind:'web_receipt_command' })).toHaveLength(0);
  });
  it('受理后重启并撤权仍按原快照完成签收，附件只上传一次', async () => {
    const result = await submit(employeeToken);
    await workflowStore.onModuleDestroy();
    workflowStore = new PurchaseWorkflowStore(join(directory, 'workflow.json')); await workflowStore.onModuleInit();
    await configStore.mutate(configStore.read().revision, `revoke-${randomUUID()}`, 'fixture-only', state => { state.accounts[employeeId]!.enabled = false; state.accounts[employeeId]!.version += 1; });
    workflow = new PurchaseWorkflowService(gateway, workflowStore, undefined, config);
    jest.spyOn(workflow, 'isEnabled').mockReturnValue(false);
    jest.spyOn(workflow, 'enqueueWarehouseInboundNotifications').mockResolvedValue(undefined);
    receipt = new PurchaseWorkflowReceiptTaskService(gateway, workflow, workflowStore);
    await receipt.runPendingTasks(new Date(Date.now() + 365 * 24 * 60 * 60_000));
    expect(await workflowStore.findWebReceipt(result.taskId)).toMatchObject({ status:'completed', lastError:'' });
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(gateway.resolveUser).not.toHaveBeenCalled();
    await receipt.runPendingTasks(new Date(Date.now() + 365 * 24 * 60 * 60_000));
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
  it('账本内拒绝伪造受理身份，仅允许原双身份进入发送围栏', async () => {
    const result = await submit(employeeToken);
    const lease = (await workflowStore.takeNextNotification(new Date(Date.now() + 365 * 24 * 60 * 60_000), 600000, ['web_receipt_command']))!;
    expect(lease.webReceipt?.taskId).toBe(result.taskId);
    await workflowStore.updateWebReceipt(lease.key, lease.claimToken, payload => { payload.files[0]!.token = 'synthetic-file-token'; });
    const accepted = await workflowStore.readAcceptedFulfillmentCommand({ notificationKey:lease.key, claimToken:lease.claimToken }, 'rec_synthetic', 'receive', '');
    expect(accepted.platformIdentity?.actorAccountId).toBe(employeeId);
    const command = { key:'receive:rec_synthetic', recordId:'rec_synthetic', action:'receive' as const, fingerprint:'synthetic-fingerprint', expectedResultFingerprint:'synthetic-result', actorOpenId:'', accessRole:'purchase_admin' as const, authenticationMode:'delegated-app' as const, startedAt:new Date(now).toISOString(), platformIdentity:accepted.platformIdentity! };
    const forged = { ...command, platformIdentity:{ ...accepted.platformIdentity!, actorAuthorizationVersion:2, subjectAuthorizationVersion:2 } };
    await expect(workflowStore.claimCommand(forged, () => { throw Error('无需重新调用活动会话'); }, accepted.proof)).rejects.toThrow('受理证明不一致');
    expect(await workflowStore.findCommand(command.key)).toBeNull();
    const claim = await workflowStore.claimCommand(command, () => { throw Error('无需重新调用活动会话'); }, accepted.proof);
    expect(claim.claimed).toBe(true);
    expect(claim.entry).toMatchObject({ platformIdentity:accepted.platformIdentity, platformDispatch:'prepared' });
  });
  it('代登录任务受理后管理员被停用仍完成，真实管理员与目标账号进入命令审计', async () => {
    const delegated = await access.startImpersonation(adminToken, { accountId:employeeId, clientMutationId:`delegate-${randomUUID()}` }, now);
    const result = await submit(delegated.token);
    await workflowStore.onModuleDestroy();
    workflowStore = new PurchaseWorkflowStore(join(directory, 'workflow.json')); await workflowStore.onModuleInit();
    await configStore.mutate(configStore.read().revision, `revoke-admin-${randomUUID()}`, 'fixture-only', state => { state.accounts['local-admin-all']!.enabled = false; state.accounts['local-admin-all']!.version += 1; });
    workflow = new PurchaseWorkflowService(gateway, workflowStore, undefined, config);
    jest.spyOn(workflow, 'isEnabled').mockReturnValue(false);
    jest.spyOn(workflow, 'enqueueWarehouseInboundNotifications').mockResolvedValue(undefined);
    receipt = new PurchaseWorkflowReceiptTaskService(gateway, workflow, workflowStore);
    await receipt.runPendingTasks(new Date(Date.now() + 365 * 24 * 60 * 60_000));
    expect(await workflowStore.findWebReceipt(result.taskId)).toMatchObject({ status:'completed' });
    expect(await workflowStore.findCommand('receive:rec_synthetic')).toMatchObject({ actorOpenId:'', platformIdentity:{ source:'impersonation', actorAccountId:'local-admin-all', subjectAccountId:employeeId } });
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(gateway.resolveUser).not.toHaveBeenCalled();
  });
  it('远端签收结果不明时不会再次写入或上传附件', async () => {
    const result = await submit(employeeToken);
    gateway.updateExecutionRecord.mockImplementation(async () => { throw Object.assign(new Error('synthetic response lost'), { code:'ETIMEDOUT' }); });
    jest.spyOn(workflow, 'isEnabled').mockReturnValue(false);
    jest.spyOn(workflow, 'enqueueWarehouseInboundNotifications').mockResolvedValue(undefined);
    await receipt.runPendingTasks(new Date(Date.now() + 365 * 24 * 60 * 60_000));
    expect((await workflowStore.findCommand('receive:rec_synthetic'))?.platformDispatch).toBe('dispatch_started');
    await receipt.runPendingTasks(new Date(Date.now() + 366 * 24 * 60 * 60_000));
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect((await workflowStore.findWebReceipt(result.taskId))?.status).not.toBe('completed');
  });
});
