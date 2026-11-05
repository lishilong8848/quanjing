import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { PurchaseLifecycleReceiptPrepareCoordinator } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-prepare-coordinator';
import { PurchaseLifecycleDeliveryService, type PurchaseLifecycleDeliveryGrant } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery.service';

jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string)=>key==='FEISHU_APP_ID'?'cli_test_app':''}));

describe('receipt prepare durable acceptance independently reviewed',()=>{
  const now=Date.now(),appId='cli_test_app',batchId='purchase-application-integration',recordId='rec_one',manager='ou_manager',requester='ou_requester',buyer='ou_buyer';
  let directory:string,file:string,store:PurchaseWorkflowStore,revision:number;
  const source={appId,batchId,recipientOpenId:manager};
  const context=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterOpenId:requester,requesterName:'申请人',building:'H楼',requestCode:'CG-TEST',expectedDeliveryAt:null,createdAt:null,items:[recordId,'rec_two'].map(executionRecordId=>({executionRecordId,title:'测试',specification:'/',quantity:'1',unit:'个',amount:'1',status:'pending',choice:'',rejectionReason:''}))});
  async function deliver(identity:any,messageId:string){const outbox=(await store.getLifecycleOutbox(identity))!;const attempt=await store.beginLifecycleDelivery(identity,now+1000,outbox.desiredRevision,outbox.desiredPage,()=>{});await store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{});await store.completeLifecycleDelivery(identity,attempt.entry.attemptToken,{kind:'send',receipt:{source:'feishu_message_readback',uuid:attempt.entry.replica.uuid,messageId,sentAtMs:now-2000}});return outbox.desiredRevision;}
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),'purchase-receipt-prepare-'));file=join(directory,'ledger.json');store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    await store.registerManagerApprovalBatch({approvalBatchId:batchId,recipientOpenId:manager,requesterOpenId:requester,recordIds:[recordId,'rec_two'],flowVersion:'lifecycle_v1'},now,{appId,recipients:[{openId:manager,fullView:false}],authorityTargets:[{recordId,target:{building:'H楼'}},{recordId:'rec_two',target:{building:'H楼'}}],authorize:()=>{}});
    const initial=await store.takeNextManagerApprovalNotification(new Date(now+2000));await store.markManagerApprovalBatchSendStarted(initial!.key,initial!.claimToken,context,new Date(now+2000));await store.completeManagerApprovalBatchRequestAndRegisterCard(initial!.key,initial!.claimToken,{messageId:'om_manager'},new Date(now+2000));await deliver(source,'om_manager');
    await store.claimManagerApprovalBatchPendingApproval({eventId:'approve',approvalBatchId:batchId,choice:'comprehensive',messageId:'om_manager',actorOpenId:manager,lifecycle:{appId,cardRevision:1}},now+2500,()=>{});
    const task=await store.takeNextManagerApprovalBatchAction(now+2500);await store.completeManagerApprovalBatchActionRecord(task!.key,task!.claimToken,recordId,{purchaserOpenId:buyer,purchaserName:'采购员',authorityTarget:{building:'H楼'}},now+2600);await store.completeManagerApprovalBatchActionRecord(task!.key,task!.claimToken,'rec_two',{purchaserOpenId:buyer,purchaserName:'采购员',authorityTarget:{building:'H楼'}},now+2601);
    const batch=(await store.findManagerApprovalBatch(batchId))!;await store.enqueueNotifications([{kind:'manager_batch_receipt_requested',businessEventId:'fixture-receipt',recordId,recipientOpenId:requester,cardContext:batch.cardContext}],new Date(now+2700));
    let notification=await store.takeNextManagerApprovalNotification(new Date(now+3000));while(notification&&notification.kind!=='manager_batch_receipt_requested'){await store.failNotification(notification.key,notification.claimToken,new Error('fixture only'),new Date(now+3000));notification=await store.takeNextManagerApprovalNotification(new Date(now+3000));}
    const enrolled=await store.enrollLifecycleRecipientFromNotification(notification!.key,notification!.claimToken,()=>{});
    revision=await deliver({appId,batchId,recipientOpenId:requester},'om_requester');
    await store.completeLifecycleStageNotification(notification!.key,notification!.claimToken,enrolled.stageTargetRevision,undefined,()=>{},now+3100);
  });
  afterEach(async()=>{await store.onModuleDestroy();await rm(directory,{recursive:true,force:true});});
  const value=()=>({appId,eventId:'event_prepare_1',actorOpenId:requester,chatId:'oc_private',cardMessageId:'om_requester',approvalBatchId:batchId,executionRecordId:recordId,cardRevision:revision,materialType:'receipt_photo' as const});
  it('真实账本持久受理、同事件重放并在授权撤销时拒绝',async()=>{
    const check=jest.fn(), accepted=await store.acceptLifecycleReceiptPrepare(value(),check);
    expect(accepted.status).toBe('pending');expect(check).toHaveBeenCalledTimes(1);
    expect(await store.acceptLifecycleReceiptPrepare(value(),check)).toEqual(accepted);
    await expect(store.acceptLifecycleReceiptPrepare({...value(),eventId:'event_restricted'},()=>{throw Error('synthetic revoked');})).rejects.toThrow('synthetic revoked');
    expect(JSON.parse(await readFile(file,'utf8')).lifecycleReceiptPrepareQueue.tasks).toHaveLength(1);
  });
  it('同一用户同时对两条明细准备签收图片时只允许一个意向',async()=>{
    const attempts=await Promise.allSettled([
      store.acceptLifecycleReceiptPrepare(value(),()=>{}),
      store.acceptLifecycleReceiptPrepare({...value(),eventId:'event_prepare_2',executionRecordId:'rec_two'},()=>{}),
    ]);
    expect(attempts.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    expect(JSON.parse(await readFile(file,'utf8')).lifecycleReceiptPrepareQueue.tasks).toHaveLength(1);
  });
  it('真实账本重启保留处理中租约，超时后可恢复且更换凭证',async()=>{
    const result=await store.acceptLifecycleReceiptPrepare(value(),()=>{});const start=Date.now();
    const clock=jest.spyOn(Date,'now').mockReturnValue(start+1);
    try {
      const first=await store.claimLifecycleReceiptPrepare(result.taskId);expect(first?.leaseToken).toBeTruthy();
      await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
      expect(await store.claimLifecycleReceiptPrepare(result.taskId)).toBeNull();
      clock.mockReturnValue(start+60002);const second=await store.claimLifecycleReceiptPrepare(result.taskId);
      expect(second?.leaseToken).toBeTruthy();expect(second?.leaseToken).not.toBe(first?.leaseToken);
    } finally {clock.mockRestore();}
  });
  it('私聊证据或权限失败不能创建意向，成功时同事务保存意向和卡片刷新',async()=>{
    const result=await store.acceptLifecycleReceiptPrepare(value(),()=>{}),lease=(await store.claimLifecycleReceiptPrepare(result.taskId))!;
    const before=await readFile(file,'utf8');
    await expect(store.completeLifecycleReceiptPrepare(lease,()=>{throw Error('synthetic invalid chat');},()=>{})).rejects.toThrow('synthetic invalid chat');
    expect(await readFile(file,'utf8')).toBe(before);
    await expect(store.completeLifecycleReceiptPrepare(lease,()=>{},()=>{throw Error('synthetic revoked');})).rejects.toThrow('synthetic revoked');
    expect(await readFile(file,'utf8')).toBe(before);
    await store.completeLifecycleReceiptPrepare(lease,()=>{},()=>{});
    const after=JSON.parse(await readFile(file,'utf8')),task=after.lifecycleReceiptPrepareQueue.tasks[0],intent=after.lifecycleReceiptImageLedger.intents[0];
    expect(task).toMatchObject({state:'completed',intentId:intent.id,refreshPending:true});
    expect(intent).toMatchObject({appId,actorOpenId:requester,chatId:'oc_private',executionRecordId:recordId,cardRevision:revision+1,state:'open'});
    expect(after.lifecycleOutbox.find((row:any)=>row.replica.recipientOpenId===requester).desiredRevision).toBe(revision+1);
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    expect(JSON.parse(await readFile(file,'utf8')).lifecycleReceiptImageLedger.intents[0]).toEqual(intent);
  });
  it('后台核验失败持久标记失败和原卡待刷新，不创建意向',async()=>{
    const result=await store.acceptLifecycleReceiptPrepare(value(),()=>{}),lease=(await store.claimLifecycleReceiptPrepare(result.taskId))!;
    const before=await readFile(file,'utf8');await expect(store.failLifecycleReceiptPrepare({...lease,leaseToken:'forged'})).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(before);
    await store.failLifecycleReceiptPrepare(lease);
    const after=JSON.parse(await readFile(file,'utf8'));
    expect(after.lifecycleReceiptPrepareQueue.tasks[0]).toMatchObject({state:'failed',failure:'chat_unverified',intentId:'',refreshPending:true});
    expect(after.lifecycleReceiptImageLedger?.intents ?? []).toHaveLength(0);
    expect(after.lifecycleOutbox.find((row:any)=>row.replica.recipientOpenId===requester).desiredRevision).toBe(revision+1);
    expect(await store.acceptLifecycleReceiptPrepare(value(),()=>{})).toMatchObject({status:'failed'});
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    expect(JSON.parse(await readFile(file,'utf8')).lifecycleReceiptPrepareQueue.tasks[0].state).toBe('failed');
  });
  it('成功意向已持久但响应丢失时，迟到失败处理不得覆盖结果',async()=>{
    const result=await store.acceptLifecycleReceiptPrepare(value(),()=>{}),lease=(await store.claimLifecycleReceiptPrepare(result.taskId))!;
    await store.completeLifecycleReceiptPrepare(lease,()=>{},()=>{});const before=await readFile(file,'utf8');
    await store.failLifecycleReceiptPrepare(lease);expect(await readFile(file,'utf8')).toBe(before);
    const raw=JSON.parse(before);expect(raw.lifecycleReceiptPrepareQueue.tasks[0].state).toBe('completed');expect(raw.lifecycleReceiptImageLedger.intents).toHaveLength(1);
  });
  it('已受理事件在原卡刷新后重放，仍返回原任务而不重复创建',async()=>{
    const accepted=await store.acceptLifecycleReceiptPrepare(value(),()=>{}),replica={appId,batchId,recipientOpenId:requester};
    await store.enqueueLifecycleRefresh(replica,revision+1,()=>{});
    const update=await store.beginLifecycleDelivery(replica,now+6000,revision+1,1,()=>{});
    expect(update.action).toBe('update');await store.markLifecycleDeliveryDispatched(replica,update.entry.attemptToken,()=>{});
    await store.completeLifecycleDelivery(replica,update.entry.attemptToken,{kind:'update',messageId:'om_requester',revision:revision+1});
    expect(await store.acceptLifecycleReceiptPrepare(value(),()=>{})).toEqual(accepted);
    expect(JSON.parse(await readFile(file,'utf8')).lifecycleReceiptPrepareQueue.tasks).toHaveLength(1);
  });
  async function deliveredOldCard() {
    const oldBatch='purchase-application-old',oldRecord='rec_old';
    const oldContext=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:oldBatch,requesterOpenId:requester,requesterName:'申请人',building:'H楼',requestCode:'CG-OLD',expectedDeliveryAt:null,createdAt:null,items:[{executionRecordId:oldRecord,title:'旧单',specification:'/',quantity:'1',unit:'个',amount:'1',status:'pending',choice:'',rejectionReason:''}]});
    await store.registerManagerApprovalBatch({approvalBatchId:oldBatch,recipientOpenId:manager,requesterOpenId:requester,recordIds:[oldRecord]},now);
    let notice=await store.takeNextManagerApprovalNotification(new Date(now+4000));
    while(notice && notice.kind!=='manager_batch_approval_requested'){await store.failNotification(notice.key,notice.claimToken,new Error('fixture only'),new Date(now+4000));notice=await store.takeNextManagerApprovalNotification(new Date(now+4000));}
    expect(notice).toBeTruthy();await store.markManagerApprovalBatchSendStarted(notice!.key,notice!.claimToken,oldContext,new Date(now+4000));
    await store.completeManagerApprovalBatchRequestAndRegisterCard(notice!.key,notice!.claimToken,{messageId:'om_old_manager'},new Date(now+4000));
    await store.claimManagerApprovalBatchPendingApproval({eventId:'event_old_approval',approvalBatchId:oldBatch,choice:'comprehensive',messageId:'om_old_manager',actorOpenId:manager},now+4001);
    const action=(await store.takeNextManagerApprovalBatchAction(now+4002))!;
    await store.completeManagerApprovalBatchActionRecord(action.key,action.claimToken,oldRecord,{purchaserOpenId:buyer,purchaserName:'采购员'},now+4003);
    const old=(await store.findManagerApprovalBatch(oldBatch))!;
    await store.enqueueNotification({kind:'manager_batch_receipt_requested',businessEventId:'fixture-old-receipt',recordId:oldRecord,recipientOpenId:requester,cardContext:old.cardContext},new Date(now+4004));
    notice=await store.takeNextManagerApprovalNotification(new Date(now+5000));
    while(notice && notice.kind!=='manager_batch_receipt_requested'){await store.failNotification(notice.key,notice.claimToken,new Error('fixture only'),new Date(now+5000));notice=await store.takeNextManagerApprovalNotification(new Date(now+5000));}
    expect(notice).toBeTruthy();await store.completeNotification(notice!.key,notice!.claimToken,{messageId:'om_old_requester'},new Date(now+5000));
    return { oldBatch,oldRecord, identity:{approvalBatchId:oldBatch,messageId:'om_old_requester',actorOpenId:requester,role:'requester' as const}, input:{executionRecordId:oldRecord,materialType:'receipt_photo' as const} };
  }
  it('新版准备中不能再打开同一用户的旧版图片意向，避免误绑旧单',async()=>{
    await store.acceptLifecycleReceiptPrepare(value(),()=>{});
    const {oldBatch,identity,input}=await deliveredOldCard();
    await expect(store.preparePurchaseBatchReceiptUpload(identity,input,now+5001)).rejects.toThrow();
    expect((await store.findManagerApprovalBatch(oldBatch))?.pendingReceiptUpload).toBeUndefined();
  });
  it('旧版意向仍有效时不接受同用户的新单准备，也不消费旧意向',async()=>{
    const {oldBatch,identity,input}=await deliveredOldCard();
    await store.preparePurchaseBatchReceiptUpload(identity,input,now+5001);
    await expect(store.acceptLifecycleReceiptPrepare(value(),()=>{})).rejects.toThrow();
    expect((await store.findManagerApprovalBatch(oldBatch))?.pendingReceiptUpload).toMatchObject({executionRecordId:input.executionRecordId});
  });
  it('混合历史状态收到图片时旧入口拒绝并保留旧意向',async()=>{
    await store.acceptLifecycleReceiptPrepare(value(),()=>{});
    await store.onModuleDestroy();let raw=JSON.parse(await readFile(file,'utf8'));const savedQueue=raw.lifecycleReceiptPrepareQueue;delete raw.lifecycleReceiptPrepareQueue;
    await writeFile(file,JSON.stringify(raw));store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    const {oldBatch,identity,input}=await deliveredOldCard();await store.preparePurchaseBatchReceiptUpload(identity,input,now+5001);
    await store.onModuleDestroy();raw=JSON.parse(await readFile(file,'utf8'));raw.lifecycleReceiptPrepareQueue=savedQueue;
    await writeFile(file,JSON.stringify(raw));store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    await expect(store.acceptPurchaseReceiptImageMessage({eventId:'event_ambiguous',actorOpenId:requester,messageId:'om_image',chatId:'oc_private',imageKey:'img_synthetic'},now+5002)).rejects.toThrow();
    expect((await store.findManagerApprovalBatch(oldBatch))?.pendingReceiptUpload).toMatchObject({executionRecordId:input.executionRecordId});
  });
  it('真实后台私聊核验失败后原卡显示失败提示，不创建可上传意向或重发卡片',async()=>{
    const identity={appId,batchId,recipientOpenId:requester};
    const opened=await store.queueLifecycleFormView(identity,'om_requester',revision,'open_receipt_failure',{kind:'receipt',recordId},()=>{});
    const opening=await store.beginLifecycleDelivery(identity,now+6000,opened.entry.desiredRevision,1,()=>{});
    await store.markLifecycleDeliveryDispatched(identity,opening.entry.attemptToken,()=>{});
    await store.completeLifecycleDelivery(identity,opening.entry.attemptToken,{kind:'update',messageId:'om_requester',revision:opened.entry.desiredRevision});
    revision=opened.entry.desiredRevision;
    const accepted=await store.acceptLifecycleReceiptPrepare(value(),()=>{});
    const coordinator=new PurchaseLifecycleReceiptPrepareCoordinator({
      accept:async()=>{throw Error('no resubmit');},claim:id=>store.claimLifecycleReceiptPrepare(id),
      complete:(lease,verify,authorize)=>store.completeLifecycleReceiptPrepare(lease,verify,authorize),fail:lease=>store.failLifecycleReceiptPrepare(lease),
    },{verify:async()=>{throw Error('private chat unavailable');},assertProof:()=>{throw Error('no proof');}},()=>{});
    expect(await coordinator.process(accepted.taskId)).toBe('failed');
    const grant:PurchaseLifecycleDeliveryGrant={assertCurrent:()=>{},verifyLatest:async()=>{},authorizeBatch:()=>{},authorizationFingerprint:()=> 'a'.repeat(64),project:()=>({
      items:[{recordId,status:'下单完成（待签收）',stages:[{stage:'receipt',fields:[{label:'物品',value:'合成测试'}]}]}],
      viewer:{kind:'participant',grants:[{recordId,visibleStages:['receipt'],allowedActions:['receive']}]},
      formPresentations:{[recordId]:{receipt:{signerOpenId:requester,receiptTime:'2026-11-05T10:00:00+08:00',purchaseMethod:'综合采购',receiptPhotoCount:0,invoiceCount:0}}},
    })};
    const transport={sendLifecycleCard:jest.fn(),updateLifecycleCard:jest.fn(async()=>{})};
    const delivery=new PurchaseLifecycleDeliveryService(store,{prepare:async selected=>{if(selected.recipientOpenId!==requester)throw Error('fixture other recipient');return grant;}},transport,()=>now+7000,()=> 'https://example.test',()=>true);
    const result=await delivery.run();expect(result.delivered).toBe(1);
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();expect(transport.updateLifecycleCard).toHaveBeenCalledTimes(1);
    expect(transport.updateLifecycleCard.mock.calls[0]![0]).toBe('om_requester');
    const card=JSON.stringify(transport.updateLifecycleCard.mock.calls[0]![1]);
    expect(card).toContain('上传权限核验失败');expect(card).not.toContain('已核验，请在当前私聊发送');
    const raw=JSON.parse(await readFile(file,'utf8'));expect(raw.lifecycleReceiptPrepareQueue.tasks[0].state).toBe('failed');
    expect(raw.lifecycleReceiptImageLedger?.intents || []).toHaveLength(0);
  });
});
