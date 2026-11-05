jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string)=>key==='FEISHU_PURCHASE_INVENTORY_APP_TOKEN'?'synthetic_base':key==='FEISHU_PURCHASE_EXECUTION_TABLE_ID'?(process.env.SYNTHETIC_BATCH_TABLE || 'synthetic_table'):process.env[key]||''}));
import { lifecyclePaymentUploadSourceFingerprint } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-gateway';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

describe('lifecycle whole-batch approval with a real isolated ledger', () => {
  const appId = 'cli_batch_test', batchId = 'purchase-application-batch-test', manager = 'ou_manager', messageId = 'om_manager', recordIds = ['rec_one', 'rec_two'];
  const now = Date.now();
  const event = (eventId: string, action = 'approve_pending_comprehensive') => ({ kind: 'manager_batch_action', action, approvalBatchId: batchId, operatorOpenId: manager, messageId, eventId, lifecycle: { cardRevision: 1 } }) as never;
  let directory: string, ledger: string, store: PurchaseWorkflowStore, service: PurchaseManagerApprovalService, previous: string | undefined;
  let denied: Set<string>, gateway: { getManagerApprovalDecisionRecordAsApp: jest.Mock; updateManagerApprovalDecisionRecordAsApp: jest.Mock; resolvePurchaseAdminAsApp: jest.Mock };

  beforeEach(async () => {
    previous = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId; delete process.env.SYNTHETIC_BATCH_TABLE;
    denied = new Set(); directory = await mkdtemp(join(tmpdir(), 'purchase-batch-claim-')); ledger = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(ledger); await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: manager, requesterOpenId: 'ou_requester', recordIds, flowVersion: 'lifecycle_v1' }, now, { appId, recipients: [{ openId: manager, fullView: false }], authorityTargets: recordIds.map((recordId, index) => ({ recordId, target: { building: index ? 'B楼' : 'H楼' } })), authorize: () => {} });
    await store.bindLifecycleReceiptImageSource(appId,lifecyclePaymentUploadSourceFingerprint());
    const card = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: recordIds.map(executionRecordId => ({ executionRecordId, title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' })) });
    const source = await store.takeNextManagerApprovalNotification(now + 1000);
    await store.markManagerApprovalBatchSendStarted(source!.key, source!.claimToken, card, now + 1000);
    await store.completeManagerApprovalBatchRequestAndRegisterCard(source!.key, source!.claimToken, { messageId }, now + 1000);
    const identity = { appId, batchId, recipientOpenId: manager };
    const delivery = await store.beginLifecycleDelivery(identity, now + 1000, 1, 1, () => {});
    await store.markLifecycleDeliveryDispatched(identity, delivery.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(identity, delivery.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: delivery.entry.replica.uuid, messageId, sentAtMs: now - 500 } });
    const config = { canUseFeishuBusinessIdentity: () => true, feishuPrincipal: () => ({ role: 'admin', purchaseBuilding: null }), currentDutyRoutePeople: (_kind: string, target: { building: string }) => denied.has(target.building) ? [] : [{ openId: manager }] };
    gateway = { getManagerApprovalDecisionRecordAsApp: jest.fn(async (id: string) => ({ recordId: id, status: '未开始（待审批）', building: id === 'rec_one' ? 'H楼' : 'B楼', specialty: '', approvalBatchId: batchId, rejectionReason: '', purchaseMethod: '', purchaserOpenId: '', warehouseConfirmed: false })), updateManagerApprovalDecisionRecordAsApp: jest.fn(async () => {}), resolvePurchaseAdminAsApp: jest.fn(async () => ({ openId: 'ou_buyer', name: '采购员' })) };
    service = new PurchaseManagerApprovalService(gateway as never, store, undefined, undefined, undefined, config as never);
    jest.spyOn(service, 'isEnabled').mockReturnValue(true);
  });
  afterEach(async () => { jest.restoreAllMocks(); delete process.env.SYNTHETIC_BATCH_TABLE; await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previous; });

  it('denies all records when any one falls outside current duties', async () => {
    denied.add('B楼');
    await expect(service.handleManagerBatchCardAction(event('event-denied'))).rejects.toThrow('岗位已变化');
    expect((await store.findManagerApprovalBatch(batchId))!.items.map(item => item.status)).toEqual(['pending', 'pending']);
    expect(JSON.parse(await readFile(ledger, 'utf8')).managerApprovalBatchActions).toHaveLength(0);
  });

  it('admits at most one of two concurrent different events and replays the admitted one during processing', async () => {
    const results = await Promise.allSettled([service.handleManagerBatchCardAction(event('event-one')), service.handleManagerBatchCardAction(event('event-two'))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const state = JSON.parse(await readFile(ledger, 'utf8'));
    expect(state.managerApprovalBatchActions).toHaveLength(1);
    expect(state.managerApprovalBatches[0].items.map((item: { status: string }) => item.status)).toEqual(['processing', 'processing']);
    await expect(service.handleManagerBatchCardAction(event(state.managerApprovalBatchActions[0].eventId))).resolves.toBeDefined();
    expect(JSON.parse(await readFile(ledger, 'utf8')).managerApprovalBatchActions).toHaveLength(1);
  });

  it('rejects H-floor self-purchase for the entire batch', async () => {
    await expect(service.handleManagerBatchCardAction(event('self-event', 'approve_pending_building_self'))).rejects.toThrow();
    expect((await store.findManagerApprovalBatch(batchId))!.items.map(item => item.status)).toEqual(['pending', 'pending']);
  });

  it('rejects a completed card replay as stale without creating a new task', async () => {
    await service.handleManagerBatchCardAction(event('complete-event'));
    const task = await store.takeNextManagerApprovalBatchAction(now + 2000);
    await store.completeManagerApprovalBatchActionRecord(task!.key, task!.claimToken, 'rec_one', { purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, now + 2001);
    await store.completeManagerApprovalBatchActionRecord(task!.key, task!.claimToken, 'rec_two', { purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'B楼' } }, now + 2002);
    await expect(service.handleManagerBatchCardAction(event('complete-event'))).rejects.toThrow('版本已变化');
    const state = JSON.parse(await readFile(ledger, 'utf8'));
    expect(state.managerApprovalBatchActions).toHaveLength(1);
    expect(state.managerApprovalBatches[0].items.map((item: { status: string }) => item.status)).toEqual(['approved', 'approved']);
  });

  it('finishes the already accepted batch after a later duty revocation without repeating writes', async () => {
    await service.handleManagerBatchCardAction(event('partial-event'));
    const task = await store.takeNextManagerApprovalBatchAction(now + 2000), applied = new Set<string>();
    gateway.getManagerApprovalDecisionRecordAsApp.mockImplementation(async (id: string) => ({ recordId:id,status:applied.has(id)?'审批通过（待下单）':'未开始（待审批）',building:id==='rec_one'?'H楼':'B楼',specialty:'',approvalBatchId:batchId,approvalActionId:applied.has(id)?'partial-event':'',rejectionReason:'',purchaseMethod:applied.has(id)?'综合采购':'',purchaserOpenId:applied.has(id)?'ou_buyer':'',warehouseConfirmed:applied.has(id) }));
    gateway.updateManagerApprovalDecisionRecordAsApp.mockImplementation(async (id:string) => {applied.add(id);denied.add('B楼');});
    const result={processed:0,failed:0,manualReconciliation:0,alerts:[],errors:[]};
    await (service as any).processBatchAction(task,new Date(now+2001),result);
    expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(2);
    expect(gateway.updateManagerApprovalDecisionRecordAsApp.mock.calls.map(call=>call[0])).toEqual(recordIds);
    expect((await store.findManagerApprovalBatch(batchId))!.items.map(item=>item.status)).toEqual(['approved','approved']);
    await (service as any).processBatchAction(task,new Date(now+2002),result);
    expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(ledger,'utf8')).managerApprovalBatchActions).toHaveLength(1);
  });
  it.each(['building','specialty','batch','source'])('stops later writes when the accepted record %s changes',async change=>{
    await service.handleManagerBatchCardAction(event('boundary-event'));
    const task=await store.takeNextManagerApprovalBatchAction(now+2000);let firstApplied=false;
    gateway.getManagerApprovalDecisionRecordAsApp.mockImplementation(async(id:string)=>{if(id==='rec_two'&&firstApplied&&change==='source')process.env.SYNTHETIC_BATCH_TABLE='changed_table';return ({recordId:id,status:id==='rec_one'&&firstApplied?'审批通过（待下单）':'未开始（待审批）',building:id==='rec_one'?'H楼':firstApplied&&change==='building'?'A楼':'B楼',specialty:id==='rec_two'&&firstApplied&&change==='specialty'?'电气':'',approvalBatchId:id==='rec_two'&&firstApplied&&change==='batch'?'purchase-application-other':batchId,approvalActionId:id==='rec_one'&&firstApplied?'boundary-event':'',rejectionReason:'',purchaseMethod:id==='rec_one'&&firstApplied?'综合采购':'',purchaserOpenId:id==='rec_one'&&firstApplied?'ou_buyer':'',warehouseConfirmed:id==='rec_one'&&firstApplied});});
    gateway.updateManagerApprovalDecisionRecordAsApp.mockImplementation(async(id:string)=>{if(id==='rec_one')firstApplied=true;});
    const result={processed:0,failed:0,manualReconciliation:0,alerts:[],errors:[]};
    await (service as any).processBatchAction(task,new Date(now+2001),result);
    expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(gateway.updateManagerApprovalDecisionRecordAsApp.mock.calls[0][0]).toBe('rec_one');
    expect((await store.findManagerApprovalBatch(batchId))!.items.map(item=>item.status)).toEqual(['approved','processing']);
    expect(result.failed).toBeGreaterThan(0);
  });
});
