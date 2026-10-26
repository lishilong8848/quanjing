import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowReceiptTaskService } from '../../server/modules/purchase-inventory/purchase-workflow-receipt-task.service';
import { PurchaseWorkflowService, type PurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';
import * as configuration from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { PurchasePersonnelHandoverAdapter } from '../../server/modules/purchase-inventory/purchase-personnel-handover.adapter';
import type { HandoverContext } from '../../shared/personnel-handover.interface';
import { pendingHandoverSelection } from '../../server/common/access/personnel-handover.preview';

describe('网页签收原队列持久受理', () => {
  let folder: string, parent: string, owner: string, store: PurchaseWorkflowStore;
  let previousApp: string | undefined;
  beforeEach(async () => {
    previousApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_receipt';
    parent = realpathSync(tmpdir()); folder = mkdtempSync(join(parent, 'nt-web-receipt-')); owner = randomUUID();
    writeFileSync(join(folder, '.test-owner'), owner, { flag: 'wx' });
    store = new PurchaseWorkflowStore(join(folder, 'purchase.json')); await store.onModuleInit();
    jest.spyOn(global, 'setImmediate').mockImplementation((() => ({ unref() {} })) as never);
  });
  afterEach(async () => {
    await store.onModuleDestroy(); jest.restoreAllMocks();
    if (previousApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousApp;
    if (dirname(resolve(folder)).toLowerCase() !== resolve(parent).toLowerCase() || !/^nt-web-receipt-[A-Za-z0-9]+$/.test(basename(folder)) || readFileSync(join(folder, '.test-owner'), 'utf8') !== owner) throw Error('Owned fixture mismatch');
    function check(path: string) {
      const stats = lstatSync(path), resolved = realpathSync(path);
      if (stats.isSymbolicLink() || resolve(resolved).toLowerCase() !== resolve(path).toLowerCase() || path !== folder && !path.toLowerCase().startsWith(folder.toLowerCase() + sep)) throw Error('Unsafe fixture');
      if (stats.isDirectory()) for (const name of readdirSync(path)) check(join(path, name));
      else if (!stats.isFile()) throw Error('Non-file fixture');
    }
    check(folder); rmSync(folder, { recursive: true, force: false });
  });

  it('返回已受理前正式保存意图与附件，重启保留任务且不保存登录令牌', async () => {
    const recordId = 'recWebReceipt', appId = 'cli_synthetic_receipt';
    const session: PurchaseWorkflowSession = { accessToken: 'synthetic-do-not-store-access', openId: 'ou_synthetic_operator', userName: '合成签收员', accessRole: 'admin', authenticationMode: 'delegated-app', permissionPrincipal: { accountId: 'local-synthetic-admin', authorizationVersion: 1, role: 'admin', displayName: '合成签收员' } };
    const prepared = { appId, record: { recordId, building: 'B楼', specialty: '电气', status: '下单完成（待签收）' }, actor: { openId: session.openId, name: session.userName, accessRole: 'admin', positions: [], buildings: ['B楼'] }, scope: { building: 'B楼', specialty: '电气' } };
    const core = { prepareReceiptSubmission: jest.fn(async () => prepared), assertReceiptSubmissionCurrent: jest.fn(), assertReceiptTaskReadable: jest.fn(), receive: jest.fn(), receiveAcceptedReceipt: jest.fn(async () => ({ notificationWarnings: [] })) };
    const gateway = { uploadAttachment: jest.fn(async () => 'synthetic-file-token'), getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-runtime-only-token') };
    let service = new PurchaseWorkflowReceiptTaskService(gateway as never, core as never, store);
    const input = { clientMutationId: '7ca21660-e4a5-4c12-92fd-d5ac9ef40508', signer: '合成签收员', signerOpenId: 'ou_synthetic_signer', receiptTime: Date.parse('2026-10-16T08:00:00+08:00'), note: '合成签收' };
    const buffer = Buffer.from('synthetic receipt photo');
    const files = { receiptPhotos: [{ originalname: 'synthetic.jpg', mimetype: 'image/jpeg', size: buffer.length, buffer }], invoices: [] };
    const accepted = await service.acceptReceipt(recordId, session, input, files);
    expect(accepted.pending).toBe(true); expect(existsSync(join(folder, 'purchase.json'))).toBe(true);
    const bytes = readFileSync(join(folder, 'purchase.json'), 'utf8');
    expect(bytes).toContain(accepted.taskId); expect(bytes).not.toContain(session.accessToken); expect(bytes).not.toContain('synthetic-runtime-only-token');
    expect(gateway.uploadAttachment).not.toHaveBeenCalled(); expect(core.receive).not.toHaveBeenCalled();
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(join(folder, 'purchase.json')); await store.onModuleInit();
    service = new PurchaseWorkflowReceiptTaskService(gateway as never, core as never, store);
    expect(await service.getReceiptTaskStatus(accepted.taskId, session)).toMatchObject({ success: true, task: { id: accepted.taskId, recordId, status: 'pending' } });
  });

  async function fixture() {
    const appId = process.env.FEISHU_APP_ID!, id = `feishu-${feishuIdentityFingerprint(appId, 'ou_synthetic_operator')}`;
    const config = new configuration.AccessConfigurationStore(join(folder, 'configuration.json'));
    jest.spyOn(configuration, 'getAccessConfigurationStore').mockReturnValue(config);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockReturnValue({});
    await config.mutate(0, randomUUID(), 'synthetic-seed', state => {
      state.accounts[id] = { id, kind: 'feishu', name: '合成签收员', role: 'admin', building: null, enabled: true, deleted: false, version: 1, source: 'configuration', appId, openId: 'ou_synthetic_operator', identityHash: feishuIdentityFingerprint(appId, 'ou_synthetic_operator') };
    });
    const access = new AccessConfigurationService();
    const session: PurchaseWorkflowSession = { accessToken: 'synthetic-never-store-token', openId: 'ou_synthetic_operator', userName: '合成签收员', accessRole: 'admin', authenticationMode: 'delegated-app', permissionPrincipal: access.currentPrincipal(id, 1)! };
    const record: PurchaseWorkflowRecord = { recordId: 'recWebActual', requestCode: 'SYNTHETIC', status: '下单完成（待签收）', itemName: '合成备件', building: 'B楼', specialty: '电气', requesterOpenId: 'ou_synthetic_operator', requesterName: '合成签收员', purchaserOpenId: 'ou_synthetic_purchaser', purchaserName: '合成采购员', purchaseMethod: '综合采购', requestedQuantity: 1, actualQuantity: 1, actualAmount: 10, approvalCompleted: true, warehouseConfirmed: true, purchaseCompleted: false, receiptConfirmed: false, receiptPhotoTokens: [], invoiceTokens: [], signer: '', receiptTime: null };
    const gateway = {
      resolveUser: jest.fn(async (openId: string) => ({ openId, name: '合成签收员', positions: [], buildings: ['B楼'] })),
      getExecutionRecord: jest.fn(async () => structuredClone(record)),
      getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-runtime-only-app-token'),
      uploadAttachment: jest.fn(async () => 'synthetic-uploaded-photo-token'),
      updateExecutionRecord: jest.fn(async (_recordId: string, patch: Record<string, unknown>) => {
        Object.assign(record, { status: patch.采购流程, purchaseCompleted: patch.采购完成, receiptConfirmed: patch['到货签收确认（签收内容填写完成后点击）'], receiptTime: patch.签收时间, signer: '合成签收员', signerOpenId: 'ou_synthetic_signer', receiptPhotoTokens: (patch.签收附件 as { file_token: string }[]).map(value => value.file_token), invoiceTokens: [], note: patch.采购备注 });
      }),
    };
    function core() {
      const result = new PurchaseWorkflowService(gateway as never, store, undefined, access);
      jest.spyOn(result, 'isEnabled').mockReturnValue(false);
      jest.spyOn(result, 'enqueueWarehouseInboundNotifications').mockResolvedValue(undefined);
      return result;
    }
    let service = new PurchaseWorkflowReceiptTaskService(gateway as never, core(), store);
    const input = { clientMutationId: randomUUID(), signer: '合成签收员', signerOpenId: 'ou_synthetic_signer', receiptTime: Date.now(), note: '合成签收' };
    const buffer = Buffer.from('synthetic photo');
    const files = { receiptPhotos: [{ originalname: 'photo.jpg', mimetype: 'image/jpeg', size: buffer.length, buffer }], invoices: [] };
    return { config, access, id, session, record, gateway, input, files, get service() { return service; },
      async restart() { await store.onModuleDestroy(); store = new PurchaseWorkflowStore(join(folder, 'purchase.json')); await store.onModuleInit(); service = new PurchaseWorkflowReceiptTaskService(gateway as never, core(), store); },
      async revoke() { await config.mutate(config.read().revision, randomUUID(), 'synthetic-revoke', state => { state.accounts[id].role = 'guest'; state.accounts[id].version++; }); },
    };
  }

  it('原Store受理先行，重启后收权仍完成一次原签收；原会话不能再查业务任务', async () => {
    const f = await fixture();
    const task = await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files);
    expect(await store.takeNextNotification()).toBeNull();
    await f.restart(); await f.revoke();
    f.gateway.resolveUser.mockRejectedValue(Error('人员已从原目录移除'));
    await f.service.runPendingTasks();
    expect((await store.findWebReceipt(task.taskId))?.status).toBe('completed');
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(1); expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect((await store.findWebReceipt(task.taskId))?.webReceipt?.filesRemoved).toBe(true);
    expect(readdirSync(store.webReceiptSpoolDirectory())).toEqual([]);
    await expect(f.service.getReceiptTaskStatus(task.taskId, f.session)).rejects.toThrow('无权');
    const before = readFileSync(join(folder, 'purchase.json'), 'utf8');
    expect((await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files)).taskId).toBe(task.taskId);
    await f.service.runPendingTasks();
    expect(readFileSync(join(folder, 'purchase.json'), 'utf8')).toBe(before);
    expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('并发相同提交只正式受理一次，改内容或共用操作人下的其他账号不能接管', async () => {
    const f = await fixture();
    const [first, duplicate] = await Promise.all([f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files), f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files)]);
    expect(first.taskId).toBe(duplicate.taskId);
    await expect(f.service.acceptReceipt(f.record.recordId, f.session, { ...f.input, note: '其他内容' }, f.files)).rejects.toThrow('其他内容');
    const other = { ...f.session, accessRole: 'purchase_applicant' as const, permissionPrincipal: { ...f.session.permissionPrincipal!, role: 'purchase_applicant' as const, accountId: 'local-synthetic-other' } };
    expect(await f.service.getReceiptTaskStatus(first.taskId, other)).toMatchObject({ success: false });
    await expect(f.service.acceptReceipt(f.record.recordId, other, f.input, f.files)).rejects.toThrow();
    expect((await store.listNotifications({ kind: 'web_receipt_command' })).length).toBe(1);
    expect(f.gateway.uploadAttachment).not.toHaveBeenCalled();
  });

  it('正式受理前撤权拒绝，不能返回已受理或后台上传', async () => {
    const f = await fixture(); await f.revoke();
    await expect(f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files)).rejects.toThrow('权限已变化');
    expect(await store.listNotifications({ kind: 'web_receipt_command' })).toEqual([]);
    expect(f.gateway.uploadAttachment).not.toHaveBeenCalled(); expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });

  it('异步人员解析后撤权，原受理锁再次拒绝并清理未受理附件', async () => {
    const f = await fixture(), original = f.gateway.resolveUser.getMockImplementation()!;
    f.gateway.resolveUser.mockImplementationOnce(async openId => { const actor = await original(openId); await f.revoke(); return actor; });
    await expect(f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files)).rejects.toThrow('权限已变化');
    expect(await store.listNotifications({ kind: 'web_receipt_command' })).toEqual([]);
    expect(f.gateway.uploadAttachment).not.toHaveBeenCalled();
  });

  it('附件上传结果未知时重启也不盲传，不把不确定结果显示成功', async () => {
    const f = await fixture(); const task = await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files);
    f.gateway.uploadAttachment.mockRejectedValueOnce(Error('synthetic response lost'));
    await f.service.runPendingTasks(); await f.restart(); await f.service.runPendingTasks(Date.now() + 2000);
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(1); expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
    expect(await f.service.getReceiptTaskStatus(task.taskId, f.session)).toMatchObject({ task: { status: 'failed', message: expect.stringContaining('待核对') } });
  });
  it('管理员明确恢复未确认附件，保留已上传步骤，重复请求和重启不重复业务写入',async()=>{
    const f=await fixture();f.files.receiptPhotos.push({...f.files.receiptPhotos[0],originalname:'second.jpg'});
    f.gateway.uploadAttachment.mockResolvedValueOnce('synthetic-confirmed-photo').mockRejectedValueOnce(Error('synthetic unknown photo')).mockResolvedValueOnce('synthetic-reuploaded-photo');
    const accepted=await f.service.acceptReceipt(f.record.recordId,f.session,f.input,f.files);
    await f.service.runPendingTasks();await f.service.runPendingTasks(Date.now()+2000);
    const task=(await f.service.listRecoveryTasks()).find(row=>row.id===accepted.taskId)!;
    expect(task.status).toBe('failed');
    const request={module:'purchase' as const,taskId:task.id,expectedVersion:task.version,clientMutationId:randomUUID()},actor={id:f.id,name:f.session.userName,authorizationVersion:1};
    const preview=await f.service.previewRecoveryTask(request);
    expect(preview).toMatchObject({version:task.version,canConfirm:true,choices:[]});
    expect(preview.facts.map(row=>row.value)).toEqual([expect.stringContaining('上传已确认'),expect.stringContaining('上传结果待核对')]);
    const guard=()=>{if(f.access.currentPrincipal(f.id,1)?.role!=='admin')throw Error('synthetic current administrator required');};
    const before=readFileSync(join(folder,'purchase.json'),'utf8');
    await expect(f.service.recoverTask({...request,expectedVersion:'0'.repeat(64)},actor,guard)).rejects.toThrow();expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(before);
    expect(await f.service.recoverTask(request,actor,guard)).toMatchObject({status:'pending'});
    const queued=readFileSync(join(folder,'purchase.json'),'utf8');await f.service.recoverTask(request,actor,guard);expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(queued);
    await f.restart();await f.service.runPendingTasks();
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(3);expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect((await store.findWebReceipt(task.id))?.status).toBe('completed');expect((await store.findWebReceipt(task.id))?.webReceipt?.recoveries).toHaveLength(1);
    expect((await store.findWebReceipt(task.id))?.webReceipt?.files.map(file=>file.token)).toEqual(['synthetic-confirmed-photo','synthetic-reuploaded-photo']);
  });

  it('附件被篡改不能执行签收', async () => {
    const f = await fixture(); const task = await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files);
    writeFileSync(join(store.webReceiptSpoolDirectory(), task.taskId, 'file-0.bin'), Buffer.from('tampered'));
    await f.service.runPendingTasks();
    expect((await store.findWebReceipt(task.taskId))?.status).toBe('failed'); expect(f.gateway.uploadAttachment).not.toHaveBeenCalled(); expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });

  it('签收业务写成响应丢失，重启沿原输入核对成功，不重传附件或重复写', async () => {
    const f = await fixture(); const task = await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files);
    const original = f.gateway.updateExecutionRecord.getMockImplementation()!;
    f.gateway.updateExecutionRecord.mockImplementationOnce(async (...args) => { await original(...args); throw Object.assign(Error('synthetic response lost'), { code: 'ECONNRESET' }); });
    await f.service.runPendingTasks();
    expect((await store.findWebReceipt(task.taskId))?.status).toBe('pending');
    await f.restart(); await f.revoke(); f.gateway.resolveUser.mockRejectedValue(Error('原人员已移除'));
    await f.service.runPendingTasks(Date.now() + 2000);
    expect((await store.findWebReceipt(task.taskId))?.status).toBe('completed');
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(1); expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('原任务的应用、领取token和scope绑定，伪造不能进入原签收command', async () => {
    const f = await fixture(); const task = await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files);
    const claimed = await store.takeNextNotification(new Date(), 10 * 60_000, ['web_receipt_command']);
    await store.updateWebReceipt(claimed!.key, claimed!.claimToken, payload => { payload.files[0].token = 'synthetic-confirmed-token'; });
    const core = new PurchaseWorkflowService(f.gateway as never, store, undefined, f.access);
    const proof = { notificationKey: claimed!.key, claimToken: claimed!.claimToken };
    await expect(core.receiveAcceptedReceipt({ ...proof, claimToken: randomUUID() })).rejects.toThrow('领取凭证');
    process.env.FEISHU_APP_ID = 'cli_synthetic_other_app';
    await expect(core.receiveAcceptedReceipt(proof)).rejects.toThrow('证明');
    process.env.FEISHU_APP_ID = 'cli_synthetic_receipt';
    f.record.building = 'A楼';
    await expect(core.receiveAcceptedReceipt(proof)).rejects.toThrow('范围已变化');
    expect(await store.findCommand(`receive:${f.record.recordId}`)).toBeNull();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
    expect((await store.findWebReceipt(task.taskId))?.status).toBe('processing');
  });

  it('网页签收受理与终态原子排入原卡刷新，原卡处理中及完成后均不保留签收按钮', async () => {
    const f = await fixture(), batchId = '2337a5f8-c769-4ea4-8b54-cc6c1933763e';
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, requesterOpenId: f.session.openId, recipientOpenId: f.session.openId, recordIds: [f.record.recordId] });
    const initial = (await store.takeNextManagerApprovalNotification())!;
    const cardContext = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterName: f.session.userName, requesterOpenId: f.session.openId, building: 'B楼', requestCode: 'SYNTHETIC', expectedDeliveryAt: '2026-10-20', createdAt: '2026-10-16 09:00', items: [{ executionRecordId: f.record.recordId, title: '合成备件', specification: '/', quantity: '1', unit: '件', amount: '10', status: 'pending', choice: '', rejectionReason: '' }] });
    await store.markManagerApprovalBatchSendStarted(initial.key, initial.claimToken, cardContext);
    await store.completeManagerApprovalBatchRequestAndRegisterCard(initial.key, initial.claimToken, { messageId: 'om_synthetic_approval' });
    await store.claimManagerApprovalBatchPendingApproval({ eventId: 'synthetic-web-approved', approvalBatchId: batchId, choice: 'comprehensive', messageId: 'om_synthetic_approval', actorOpenId: f.session.openId });
    const action = (await store.takeNextManagerApprovalBatchAction())!;
    await store.completeManagerApprovalBatchActionRecord(action.key, action.claimToken, f.record.recordId, { purchaserOpenId: f.record.purchaserOpenId, purchaserName: f.record.purchaserName, authorityTarget: { building: 'B楼', specialty: '电气' } });
    for (let index = 0; index < 10; index++) { const task = await store.takeNextManagerApprovalNotification(); if (!task) break; await store.completeNotification(task.key, task.claimToken, { messageId: `om_synthetic_initial_${index}` }); }
    for (let index = 0; index < 2; index++) {
      await store.enqueueNotification({ businessEventId: `manager_batch_receipt_requested:${batchId}:synthetic-copy-${index}`, kind: 'manager_batch_receipt_requested', recordId: f.record.recordId, recipientOpenId: f.session.openId, cardContext: (await store.findManagerApprovalBatch(batchId))!.cardContext });
      const task = (await store.takeNextManagerApprovalNotification())!;
      await store.markManagerApprovalBatchSendStarted(task.key, task.claimToken, task.cardContext);
      await store.completeNotification(task.key, task.claimToken, { messageId: `om_synthetic_receipt_${index}` });
    }
    const sdk = { getExecutionRecordAsApp: async () => structuredClone(f.record), updateInteractiveCard: jest.fn(async (_id: string, _card: Record<string, unknown>) => {}), updateExecutionRecordAsApp: jest.fn(async () => {}) };
    const manager = new PurchaseManagerApprovalService(sdk as never, store, undefined, undefined, undefined, f.access);
    const render = () => (manager as unknown as { renderPurchaseBatchReceiptCard(batch: unknown): Promise<unknown> }).renderPurchaseBatchReceiptCard(awaitedBatch);
    let awaitedBatch = (await store.findManagerApprovalBatch(batchId))!;
    expect(JSON.stringify(await render())).toContain('open_receipt');
    await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files);
    expect(await store.listNotifications({ kind: 'manager_batch_receipt_refresh' })).toHaveLength(1);
    expect(JSON.stringify(await render())).not.toContain('open_receipt');
    async function flushCard() {
      const task = (await store.takeNextManagerApprovalNotification())!, result = { processed: 0, failed: 0, manualReconciliation: 0, alerts: [], errors: [] };
      expect(task.kind).toBe('manager_batch_receipt_refresh');
      expect(await (manager as unknown as { processPurchaseBatchFulfillmentNotification(task: unknown, now: Date, result: unknown): Promise<boolean> }).processPurchaseBatchFulfillmentNotification(task, new Date(), result)).toBe(true);
      expect(result.errors).toEqual([]);
      expect((await store.getNotification(task.key))?.status).toBe('completed');
    }
    await flushCard();
    expect(sdk.updateInteractiveCard.mock.calls.map(([id]) => id)).toEqual(['om_synthetic_receipt_0', 'om_synthetic_receipt_1']);
    for (const [, card] of sdk.updateInteractiveCard.mock.calls) expect(JSON.stringify(card)).not.toContain('open_receipt');
    await f.service.runPendingTasks();
    awaitedBatch = (await store.findManagerApprovalBatch(batchId))!;
    expect(await store.listNotifications({ kind: 'manager_batch_receipt_refresh' })).toHaveLength(2);
    const terminal = JSON.stringify(await render()); expect(terminal).not.toContain('open_receipt'); expect(terminal).toContain('签收完成');
    await flushCard();
    expect(sdk.updateInteractiveCard).toHaveBeenCalledTimes(4);
    for (const [, card] of sdk.updateInteractiveCard.mock.calls.slice(2)) { expect(JSON.stringify(card)).toContain('签收完成'); expect(JSON.stringify(card)).not.toContain('open_receipt'); }
  });

  it('交接预览枚举原合法签收为保持原执行，未知上传结果须先核对', async () => {
    const f = await fixture(); await f.service.acceptReceipt(f.record.recordId, f.session, f.input, f.files);
    const person = (id: string, recordId: string, openId: string) => ({ id, recordId, openId, name: '合成人员', active: true, type: 'employee' as const, position: '采购员', systemPosition: '', buildings: ['B楼' as const], specialties: ['电气' as const], permissionTags: [], dutyRecordIds: ['recWebDuty'] });
    const from = person(`local-external-${'a'.repeat(64)}`, 'recWebSource', f.session.openId), to = person(`local-external-${'b'.repeat(64)}`, 'recWebTarget', 'ou_synthetic_target');
    const context: HandoverContext = { from, to, directoryVersion: 'synthetic-web-v1', duties: [{ recordId: 'recWebDuty', name: '合成采购', kind: 'purchase_executor', personnelIds: [from.id], buildings: ['B楼'], specialties: ['电气'], enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }] };
    const adapter = new PurchasePersonnelHandoverAdapter(store, f.access, { isEnabled: () => true } as never, {} as never);
    const items = await adapter.listPending(context);
    expect(items).toMatchObject([{ stageKey: 'web_receipt', status: 'in_progress', phase: 'execution' }]);
    expect(pendingHandoverSelection(items)).toMatchObject({ pending: [], excluded: [{ reason: '已受理处理保持原执行' }], conflicts: [] });
    f.gateway.uploadAttachment.mockRejectedValueOnce(Error('synthetic unknown upload'));
    await f.service.runPendingTasks(); await f.service.runPendingTasks(Date.now() + 2000);
    expect(pendingHandoverSelection(await adapter.listPending(context)).conflicts).toHaveLength(1);
  });
});
