
import { createLifecycleReceiptImageVerifier } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-binding';
import { createLifecycleReceiptImageStoreAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-store-adapter';
import { PurchaseLifecycleReceiptImageCoordinator } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-coordinator';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

let mockCurrentAppId='cli_test_app';
jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string)=>key==='FEISHU_APP_ID'?mockCurrentAppId:''}));

describe('receipt image upload with actual isolated ledger',()=>{
  const now=Date.now(),appId='cli_test_app',batchId='purchase-application-integration',recordId='rec_one',manager='ou_manager',requester='ou_requester',buyer='ou_buyer';
  let directory:string,file:string,store:PurchaseWorkflowStore,revision:number;
  const source={appId,batchId,recipientOpenId:manager};
  const context=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterOpenId:requester,requesterName:'申请人',building:'H楼',requestCode:'CG-TEST',expectedDeliveryAt:null,createdAt:null,items:[{executionRecordId:recordId,title:'测试',specification:'/',quantity:'1',unit:'个',amount:'1',status:'pending',choice:'',rejectionReason:''}]});
  async function deliver(identity:any,messageId:string){const outbox=(await store.getLifecycleOutbox(identity))!;const attempt=await store.beginLifecycleDelivery(identity,now+1000,outbox.desiredRevision,outbox.desiredPage,()=>{});await store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{});await store.completeLifecycleDelivery(identity,attempt.entry.attemptToken,{kind:'send',receipt:{source:'feishu_message_readback',uuid:attempt.entry.replica.uuid,messageId,sentAtMs:now-2000}});return outbox.desiredRevision;}
  beforeEach(async()=>{
    mockCurrentAppId=appId;
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

  async function imageTask() {
    const prepared=await store.acceptLifecycleReceiptPrepare(value(),()=>{});
    await store.completeLifecycleReceiptPrepare((await store.claimLifecycleReceiptPrepare(prepared.taskId))!,()=>{},()=>{});
    const identity={appId,batchId,recipientOpenId:requester};
    const outbox=(await store.getLifecycleOutbox(identity))!;
    const attempt=await store.beginLifecycleDelivery(identity,Date.now(),outbox.desiredRevision,1,()=>{});
    await store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{});
    await store.completeLifecycleDelivery(identity,attempt.entry.attemptToken,{kind:'update',messageId:'om_requester',revision:outbox.desiredRevision});
    const verifier=createLifecycleReceiptImageVerifier(async()=>({appId,eventId:'verified_image_event',actorOpenId:requester,chatId:'oc_private',imageMessageId:'om_uploaded_photo',imageKey:'img_synthetic',messageCreatedAtMs:Date.now(),senderType:'user',chatType:'p2p',messageType:'image'}));
    const snapshot=await verifier.verify({},appId);
    const accepted=await store.acceptVerifiedLifecycleReceiptImage(snapshot,()=>{});
    return {taskId:accepted.taskId!,verifier,snapshot};
  }
  const disk=async()=>JSON.parse(await readFile(file,'utf8'));
  it('routes only matching durable image work and keeps completed replays on the new path after restart',async()=>{
    expect(await store.ownsLifecycleReceiptImageMessage(appId,requester,'fresh_event','om_fresh')).toBe(false);
    const before=await readFile(file,'utf8');
    expect(await store.ownsLifecycleReceiptImageMessage(appId,buyer,'fresh_event','om_fresh')).toBe(false);
    expect(await readFile(file,'utf8')).toBe(before);
    const {taskId}=await imageTask();
    expect(await store.ownsLifecycleReceiptImageMessage(appId,requester,'verified_image_event','om_uploaded_photo')).toBe(true);
    await expect(store.ownsLifecycleReceiptImageMessage(appId,buyer,'verified_image_event','om_uploaded_photo')).rejects.toThrow('原事件身份');
    const task=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});
    await store.dispatchLifecycleReceiptImageUpload(taskId,task.leaseToken,()=>{});
    await store.recordLifecycleReceiptImageUploaded(taskId,task.leaseToken,'file_route');
    await store.commitLifecycleReceiptImageUploaded(taskId,task.leaseToken,()=>{});
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    expect(await store.ownsLifecycleReceiptImageMessage(appId,requester,'verified_image_event','om_uploaded_photo')).toBe(true);
    expect(await store.ownsLifecycleReceiptImageMessage(appId,requester,'another_event','om_other')).toBe(false);
  });
  it('keeps pending preparation on the new path without a network call or ledger mutation',async()=>{
    await store.acceptLifecycleReceiptPrepare(value(),()=>{});
    const bytes=await readFile(file,'utf8');
    expect(await store.ownsLifecycleReceiptImageMessage(appId,requester,'fresh_event','om_fresh')).toBe(true);
    expect(await store.ownsLifecycleReceiptImageMessage(appId,buyer,'fresh_event','om_fresh')).toBe(false);
    expect(await readFile(file,'utf8')).toBe(bytes);
  });
  it('completes once through the coordinator and updates attachments, intent, and all existing replicas atomically',async()=>{
    const {taskId,verifier}=await imageTask();
    const before=await disk();const gateway={downloadMessageImage:jest.fn(async()=>Buffer.from('synthetic image')),uploadAttachment:jest.fn(async()=>'file_confirmed')};
    const coordinator=new PurchaseLifecycleReceiptImageCoordinator(verifier,createLifecycleReceiptImageStoreAdapter(store),gateway,()=>appId,()=>{});
    expect(await coordinator.process(taskId)).toBe('completed');expect(await coordinator.process(taskId)).toBe('completed');
    const after=await disk();const batch=after.managerApprovalBatches.find((row:any)=>row.approvalBatchId===batchId);
    expect(batch.items[0].receiptPhotoTokens).toEqual(['file_confirmed']);expect(after.lifecycleReceiptImageLedger.tasks[0].state).toBe('completed');
    expect(after.lifecycleReceiptImageLedger.intents[0].state).toBe('completed');expect(after.lifecycleOutbox).toHaveLength(before.lifecycleOutbox.length);
    for(const replica of after.lifecycleOutbox)expect(replica.desiredRevision).toBeGreaterThan(before.lifecycleOutbox.find((row:any)=>row.replica.recipientOpenId===replica.replica.recipientOpenId).desiredRevision);
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
  });
  it('admits one concurrent lease and rejects forged tokens without mutating the ledger',async()=>{
    const {taskId}=await imageTask();const results=await Promise.allSettled([store.claimLifecycleReceiptImageUpload(taskId,()=>{}),store.claimLifecycleReceiptImageUpload(taskId,()=>{})]);
    expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);const bytes=await readFile(file,'utf8');
    await expect(store.dispatchLifecycleReceiptImageUpload(taskId,'forged',()=>{})).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(bytes);
  });
  it('releases a pre-upload download failure so a later attempt can retry without an upload',async()=>{
    const {taskId,verifier}=await imageTask(),gateway={downloadMessageImage:jest.fn(async()=>{throw Error('download failed');}),uploadAttachment:jest.fn()};
    const coordinator=new PurchaseLifecycleReceiptImageCoordinator(verifier,createLifecycleReceiptImageStoreAdapter(store),gateway,()=>appId,()=>{});
    await expect(coordinator.process(taskId)).rejects.toThrow('download failed');expect(gateway.uploadAttachment).not.toHaveBeenCalled();
    expect((await disk()).lifecycleReceiptImageLedger.tasks[0]).toMatchObject({state:'ready',leaseToken:''});
    expect((await store.claimLifecycleReceiptImageUpload(taskId,()=>{})).state).toBe('ready');
  });
  it('persists unknown upload across restart and never uploads again',async()=>{
    const {taskId,verifier}=await imageTask(),gateway={downloadMessageImage:jest.fn(async()=>Buffer.from('synthetic')),uploadAttachment:jest.fn(async()=>{throw Error('response lost');})};
    const run=()=>new PurchaseLifecycleReceiptImageCoordinator(verifier,createLifecycleReceiptImageStoreAdapter(store),gateway,()=>appId,()=>{}).process(taskId);
    await expect(run()).rejects.toThrow('response lost');await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    expect(await run()).toBe('manual_reconciliation');expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect((await disk()).managerApprovalBatches[0].items[0].receiptPhotoTokens).toEqual([]);
  });
  it('preserves the confirmed receipt when permission is revoked in flight but does not attach it',async()=>{
    const {taskId}=await imageTask();const task=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});
    await store.dispatchLifecycleReceiptImageUpload(taskId,task.leaseToken,()=>{});
    await store.recordLifecycleReceiptImageUploaded(taskId,task.leaseToken,'file_confirmed');
    const before=await readFile(file,'utf8');await expect(store.commitLifecycleReceiptImageUploaded(taskId,task.leaseToken,()=>{throw Error('revoked');})).rejects.toThrow('revoked');
    expect(await readFile(file,'utf8')).toBe(before);expect((await disk()).lifecycleReceiptImageLedger.tasks[0]).toMatchObject({state:'uploaded',fileToken:'file_confirmed'});
    await store.commitLifecycleReceiptImageUploaded(taskId,task.leaseToken,()=>{});
    expect((await disk()).managerApprovalBatches[0].items[0].receiptPhotoTokens).toEqual(['file_confirmed']);
  });
  it('restarts after confirmed upload and only commits the existing receipt',async()=>{
    const {taskId,verifier}=await imageTask(),task=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});
    await store.dispatchLifecycleReceiptImageUpload(taskId,task.leaseToken,()=>{});await store.recordLifecycleReceiptImageUploaded(taskId,task.leaseToken,'file_existing');
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    const clock=jest.spyOn(Date,'now').mockReturnValue(task.leaseUntilMs+1);
    try {const gateway={downloadMessageImage:jest.fn(),uploadAttachment:jest.fn()};const coordinator=new PurchaseLifecycleReceiptImageCoordinator(verifier,createLifecycleReceiptImageStoreAdapter(store),gateway,()=>appId,()=>{});
      expect(await coordinator.process(taskId)).toBe('completed');expect(gateway.uploadAttachment).not.toHaveBeenCalled();expect(gateway.downloadMessageImage).not.toHaveBeenCalled();
    }finally{clock.mockRestore();}
  });
  it('rejects changed app, revoked authorization and old-flow batches before dispatch',async()=>{
    const {taskId}=await imageTask();const original=await readFile(file,'utf8');
    await expect(store.claimLifecycleReceiptImageUpload(taskId,()=>{throw Error('revoked');})).rejects.toThrow('revoked');expect(await readFile(file,'utf8')).toBe(original);
    mockCurrentAppId='cli_other';
    try{await expect(store.claimLifecycleReceiptImageUpload(taskId,()=>{})).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(original);}finally{mockCurrentAppId=appId;}
    const raw=JSON.parse(original);raw.managerApprovalBatches[0].flowVersion='legacy';await writeFile(file,JSON.stringify(raw));
    const changed=await readFile(file,'utf8');await expect(store.claimLifecycleReceiptImageUpload(taskId,()=>{})).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(changed);
  });
  it('a failed atomic commit preserves the uploaded receipt, all replicas and business fields for commit-only retry',async()=>{
    const {taskId}=await imageTask(),task=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});
    await store.dispatchLifecycleReceiptImageUpload(taskId,task.leaseToken,()=>{});await store.recordLifecycleReceiptImageUploaded(taskId,task.leaseToken,'file_durable');
    const before=await readFile(file,'utf8');
    const fail=jest.spyOn(store as any,'writeLifecycleRaw').mockRejectedValueOnce(new Error('synthetic disk failure'));
    try{await expect(store.commitLifecycleReceiptImageUploaded(taskId,task.leaseToken,()=>{})).rejects.toThrow('synthetic disk failure');}finally{fail.mockRestore();}
    expect(await readFile(file,'utf8')).toBe(before);
    await store.commitLifecycleReceiptImageUploaded(taskId,task.leaseToken,()=>{});
    expect((await disk()).managerApprovalBatches[0].items[0].receiptPhotoTokens).toEqual(['file_durable']);
  });
  it('records a late original receipt after lease expiry without reopening the upload fence',async()=>{
    const {taskId}=await imageTask(),task=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});
    await store.dispatchLifecycleReceiptImageUpload(taskId,task.leaseToken,()=>{});
    const clock=jest.spyOn(Date,'now').mockReturnValue(task.leaseUntilMs+1);
    try{
      const unknown=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});
      expect(unknown.state).toBe('dispatching');expect(unknown.leaseToken).toBe(task.leaseToken);
      await store.recordLifecycleReceiptImageUploaded(taskId,task.leaseToken,'file_late');
      await expect(store.commitLifecycleReceiptImageUploaded(taskId,task.leaseToken,()=>{})).rejects.toThrow();
      const retry=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});expect(retry.state).toBe('uploaded');
      await store.commitLifecycleReceiptImageUploaded(taskId,retry.leaseToken,()=>{});
      expect((await disk()).managerApprovalBatches[0].items[0].receiptPhotoTokens).toEqual(['file_late']);
    }finally{clock.mockRestore();}
  });
  it('scans only retry-safe work and never schedules an uncertain upload for retransmission',async()=>{
    const {taskId}=await imageTask();expect(await store.listRecoverableLifecycleReceiptImageUploads()).toEqual([taskId]);
    expect(await store.listRecoverableLifecycleReceiptImageUploads(taskId)).toEqual([]);
    await expect(store.listRecoverableLifecycleReceiptImageUploads('',101)).rejects.toThrow();
    const task=await store.claimLifecycleReceiptImageUpload(taskId,()=>{});expect(await store.listRecoverableLifecycleReceiptImageUploads()).toEqual([]);
    await store.dispatchLifecycleReceiptImageUpload(taskId,task.leaseToken,()=>{});
    const clock=jest.spyOn(Date,'now').mockReturnValue(task.leaseUntilMs+1);
    try{expect(await store.listRecoverableLifecycleReceiptImageUploads()).toEqual([]);await store.markLifecycleReceiptImageUploadUncertain(taskId,task.leaseToken);expect(await store.listRecoverableLifecycleReceiptImageUploads()).toEqual([]);}finally{clock.mockRestore();}
  });
});
