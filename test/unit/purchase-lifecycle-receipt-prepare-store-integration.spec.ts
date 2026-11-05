import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string)=>key==='FEISHU_APP_ID'?'cli_test_app':''}));

describe('v1 receipt preparation with actual isolated ledger',()=>{
  const now=Date.now(),appId='cli_test_app',batchId='purchase-application-integration',recordId='rec_one',manager='ou_manager',requester='ou_requester',buyer='ou_buyer';
  let directory:string,file:string,store:PurchaseWorkflowStore,revision:number;
  const source={appId,batchId,recipientOpenId:manager};
  const context=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterOpenId:requester,requesterName:'申请人',building:'H楼',requestCode:'CG-TEST',expectedDeliveryAt:null,createdAt:null,items:[{executionRecordId:recordId,title:'测试',specification:'/',quantity:'1',unit:'个',amount:'1',status:'pending',choice:'',rejectionReason:''}]});
  async function deliver(identity:any,messageId:string){const outbox=(await store.getLifecycleOutbox(identity))!;const attempt=await store.beginLifecycleDelivery(identity,now+1000,outbox.desiredRevision,outbox.desiredPage,()=>{});await store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{});await store.completeLifecycleDelivery(identity,attempt.entry.attemptToken,{kind:'send',receipt:{source:'feishu_message_readback',uuid:attempt.entry.replica.uuid,messageId,sentAtMs:now-2000}});return outbox.desiredRevision;}
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),'purchase-receipt-prepare-'));file=join(directory,'ledger.json');store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    await store.registerManagerApprovalBatch({approvalBatchId:batchId,recipientOpenId:manager,requesterOpenId:requester,recordIds:[recordId],flowVersion:'lifecycle_v1'},now,{appId,recipients:[{openId:manager,fullView:false}],authorityTargets:[{recordId,target:{building:'H楼'}}],authorize:()=>{}});
    const initial=await store.takeNextManagerApprovalNotification(new Date(now+2000));await store.markManagerApprovalBatchSendStarted(initial!.key,initial!.claimToken,context,new Date(now+2000));await store.completeManagerApprovalBatchRequestAndRegisterCard(initial!.key,initial!.claimToken,{messageId:'om_manager'},new Date(now+2000));await deliver(source,'om_manager');
    await store.claimManagerApprovalBatchPendingApproval({eventId:'approve',approvalBatchId:batchId,choice:'comprehensive',messageId:'om_manager',actorOpenId:manager,lifecycle:{appId,cardRevision:1}},now+2500,()=>{});
    const task=await store.takeNextManagerApprovalBatchAction(now+2500);await store.completeManagerApprovalBatchActionRecord(task!.key,task!.claimToken,recordId,{purchaserOpenId:buyer,purchaserName:'采购员',authorityTarget:{building:'H楼'}},now+2600);
    const batch=(await store.findManagerApprovalBatch(batchId))!;await store.enqueueNotifications([{kind:'manager_batch_receipt_requested',businessEventId:'fixture-receipt',recordId,recipientOpenId:requester,cardContext:batch.cardContext}],new Date(now+2700));
    let notification=await store.takeNextManagerApprovalNotification(new Date(now+3000));while(notification&&notification.kind!=='manager_batch_receipt_requested'){await store.failNotification(notification.key,notification.claimToken,new Error('fixture only'),new Date(now+3000));notification=await store.takeNextManagerApprovalNotification(new Date(now+3000));}
    const enrolled=await store.enrollLifecycleRecipientFromNotification(notification!.key,notification!.claimToken,()=>{});
    revision=await deliver({appId,batchId,recipientOpenId:requester},'om_requester');
    await store.completeLifecycleStageNotification(notification!.key,notification!.claimToken,enrolled.stageTargetRevision,undefined,()=>{},now+3100);
  });
  afterEach(async()=>{await store.onModuleDestroy();await rm(directory,{recursive:true,force:true});});
  const value=()=>({appId,eventId:'event_prepare_1',actorOpenId:requester,chatId:'oc_private',cardMessageId:'om_requester',approvalBatchId:batchId,executionRecordId:recordId,cardRevision:revision,materialType:'receipt_photo' as const});
  it('persists a verified request once and replays the same event after restart',async()=>{
    const accepted=await store.acceptLifecycleReceiptPrepare(value(),()=>{});expect(accepted.status).toBe('pending');
    const bytes=await readFile(file,'utf8');expect(JSON.parse(bytes).lifecycleReceiptPrepareQueue.tasks).toHaveLength(1);
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    expect(await store.acceptLifecycleReceiptPrepare(value(),()=>{})).toEqual(accepted);expect(await readFile(file,'utf8')).toBe(bytes);
  });
  it('rejects altered event details, wrong identity, card, record or revision and revoked permissions',async()=>{
    await store.acceptLifecycleReceiptPrepare(value(),()=>{});const before=await readFile(file,'utf8');
    for(const change of [{chatId:'oc_other'},{actorOpenId:'ou_other'},{cardMessageId:'om_other'},{executionRecordId:'rec_other'},{cardRevision:revision+1},{materialType:'invoice' as const}]) await expect(store.acceptLifecycleReceiptPrepare({...value(),...change},()=>{})).rejects.toThrow();
    await expect(store.acceptLifecycleReceiptPrepare({...value(),eventId:'event_new'},()=>{throw Error('permission revoked');})).rejects.toThrow('permission revoked');
    expect(await readFile(file,'utf8')).toBe(before);
  });
  it('rejects the request if the delivered stage source is missing',async()=>{
    const raw=JSON.parse(await readFile(file,'utf8'));raw.notifications=raw.notifications.filter((item:any)=>item.kind!=='manager_batch_receipt_requested');
    await writeFile(file,JSON.stringify(raw),'utf8');const before=await readFile(file,'utf8');
    await expect(store.acceptLifecycleReceiptPrepare(value(),()=>{})).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(before);
  });
  it('rejects old-flow batches rather than creating new-flow prepare tasks',async()=>{
    const raw=JSON.parse(await readFile(file,'utf8'));raw.managerApprovalBatches.find((item:any)=>item.approvalBatchId===batchId).flowVersion='legacy';
    await writeFile(file,JSON.stringify(raw),'utf8');const before=await readFile(file,'utf8');
    await expect(store.acceptLifecycleReceiptPrepare(value(),()=>{})).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(before);
  });
  it('rejects a dispatch if receipt preparation fails after the feedback snapshot was read',async()=>{
    const accepted=await store.acceptLifecycleReceiptPrepare(value(),()=>{});
    const lease=(await store.claimLifecycleReceiptPrepare(accepted.taskId))!;
    const identity={appId,batchId,recipientOpenId:requester};
    const feedback=await store.getLifecycleReceiptPreparation(identity,'om_requester',()=>{});expect(feedback?.state).toBe('pending');
    const initial=(await store.getLifecycleOutbox(identity))!;await store.enqueueLifecycleRefresh(identity,initial.desiredRevision+1,()=>{});
    const outbox=(await store.getLifecycleOutbox(identity))!;
    const attempt=await store.beginLifecycleDelivery(identity,Date.now(),outbox.desiredRevision,outbox.desiredPage,()=>{});
    await store.failLifecycleReceiptPrepare(lease);
    await expect(store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{},feedback)).rejects.toThrow();
    await store.abortPreparedLifecycleDelivery(identity,attempt.entry.attemptToken);
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('delivered');
  });
  it('also fences a no-feedback projection against an in-flight new revision',async()=>{
    const identity={appId,batchId,recipientOpenId:requester};
    expect(await store.getLifecycleReceiptPreparation(identity,'om_requester',()=>{})).toBeNull();
    const initial=(await store.getLifecycleOutbox(identity))!;await store.enqueueLifecycleRefresh(identity,initial.desiredRevision+1,()=>{});
    const outbox=(await store.getLifecycleOutbox(identity))!;
    const attempt=await store.beginLifecycleDelivery(identity,Date.now(),outbox.desiredRevision,outbox.desiredPage,()=>{});
    await store.enqueueLifecycleRefresh(identity,outbox.desiredRevision+1,()=>{});
    await expect(store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{},null)).rejects.toThrow();
    await store.abortPreparedLifecycleDelivery(identity,attempt.entry.attemptToken);
  });
  it('does not dispatch a ready prompt once its intent expires under the ledger lock',async()=>{
    const accepted=await store.acceptLifecycleReceiptPrepare(value(),()=>{}),lease=(await store.claimLifecycleReceiptPrepare(accepted.taskId))!;
    await store.completeLifecycleReceiptPrepare(lease,()=>{},()=>{});
    const identity={appId,batchId,recipientOpenId:requester},feedback=await store.getLifecycleReceiptPreparation(identity,'om_requester',()=>{});
    expect(feedback?.state).toBe('ready');expect(feedback?.intentExpiresAtMs).toBeDefined();
    const outbox=(await store.getLifecycleOutbox(identity))!;
    const attempt=await store.beginLifecycleDelivery(identity,Date.now(),outbox.desiredRevision,outbox.desiredPage,()=>{});
    const clock=jest.spyOn(Date,'now').mockReturnValue(feedback!.intentExpiresAtMs!+1);
    try {await expect(store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{},feedback)).rejects.toThrow();}
    finally {clock.mockRestore();}
    await store.abortPreparedLifecycleDelivery(identity,attempt.entry.attemptToken);
  });
});
