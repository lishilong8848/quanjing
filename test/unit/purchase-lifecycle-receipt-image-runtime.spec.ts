import { PurchaseLifecycleReceiptImageRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-runtime';

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

describe('receipt image runtime with actual ledger and simulated Feishu HTTP',()=>{
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

  let runtime:PurchaseLifecycleReceiptImageRuntime|undefined;
  afterEach(async()=>{await runtime?.onModuleDestroy();runtime=undefined;});
  function liveRuntime() {
    let source={appId,appSecret:'synthetic-secret',appToken:'base_synthetic',tableId:'tbl_source'},enabled=true,accepting=true,permitted=true;
    const principal={accountId:'feishu-synthetic',authorizationVersion:1,role:'admin',purchaseBuilding:null};
    const access={feishuPrincipal:jest.fn(()=>permitted?principal:null),canUseFeishuBusinessIdentity:jest.fn(()=>permitted)};
    const ingress={isReady:()=>true,isAuthenticatedWsDelivery:()=>false};
    const http={get:jest.fn(async(url:string)=>{if(!url.includes('/resources/'))throw Error('unexpected GET');return {data:Buffer.from([137,80,78,71,13,10,26,10,0]),headers:{'content-type':'image/png'}};}),post:jest.fn(async(url:string)=>{
      if(url.includes('/auth/'))return {data:{code:0,tenant_access_token:'synthetic-token'}};
      if(url.includes('/records/batch_get'))return {data:{code:0,data:{records:[{record_id:recordId,fields:{'采购流程':'下单完成（待签收）','申请楼栋':'H楼','采购审批批次号':batchId,'需求人':[{id:requester}],'1️⃣物品采购方式':'综合采购'}}]}}};
      if(url.includes('/medias/upload_all'))return {data:{code:0,data:{file_token:'file_runtime'}}};
      throw Error('unexpected POST');
    })};
    const report=jest.fn();
    runtime=new PurchaseLifecycleReceiptImageRuntime(access as never,store,{axiosRef:http} as never,ingress as never,{readSource:()=>source,enabled:()=>enabled,acceptingWork:()=>accepting,intervalMs:60_000,reportFailure:report});
    return {http,access,report,source:()=>source,changeBase:()=>{source={...source,appToken:'base_other'};},deny:()=>{permitted=false;},pause:()=>{accepting=false;},disable:()=>{enabled=false;}};
  }
  it('does no construction I/O, binds durable source, verifies live receive permission and writes the original Base once',async()=>{
    const f=liveRuntime();expect(f.http.post).not.toHaveBeenCalled();await runtime!.start();const {taskId}=await imageTask();
    expect(await runtime!.process(taskId)).toBe('completed');
    expect(f.access.feishuPrincipal).toHaveBeenCalledWith(requester,appId);
    expect(f.access.canUseFeishuBusinessIdentity).toHaveBeenCalledWith('feishu-synthetic',appId);
    expect(f.http.post.mock.calls.filter(([url])=>url.includes('/medias/upload_all'))).toHaveLength(1);
    expect((await disk()).managerApprovalBatches[0].items[0].receiptPhotoTokens).toEqual(['file_runtime']);
    expect(await runtime!.process(taskId)).toBe('completed');expect(f.http.post.mock.calls.filter(([url])=>url.includes('/medias/upload_all'))).toHaveLength(1);
  });
  it('does not accept untrusted event objects and honors hot-update and current permission gates',async()=>{
    const f=liveRuntime();await runtime!.start();
    await expect(runtime!.accept({event:{}})).rejects.toThrow('来源未认证');expect(f.http.post).not.toHaveBeenCalled();
    const {taskId}=await imageTask();f.deny();await expect(runtime!.process(taskId)).rejects.toThrow('签收权限');expect(f.http.post).not.toHaveBeenCalled();
    f.pause();expect(runtime!.isReady()).toBe(false);await expect(runtime!.recoverOnce()).rejects.toThrow();
  });
  it('blocks runtime source drift before downloading or uploading',async()=>{
    const f=liveRuntime();await runtime!.start();const {taskId}=await imageTask();f.changeBase();
    await expect(runtime!.process(taskId)).rejects.toThrow('来源已变化');expect(f.http.post).not.toHaveBeenCalled();expect(f.http.get).not.toHaveBeenCalled();
  });
  it('saves the original receipt if Base changes while upload is in flight, but never attaches to the changed source',async()=>{
    const f=liveRuntime();await runtime!.start();const {taskId}=await imageTask();const original=f.http.post.getMockImplementation()!;
    f.http.post.mockImplementation(async(url:string)=>{const value=await original(url);if(url.includes('/medias/upload_all'))f.changeBase();return value;});
    await expect(runtime!.process(taskId)).rejects.toThrow('来源已变化');
    const state=await disk();expect(state.lifecycleReceiptImageLedger.tasks[0]).toMatchObject({state:'uploaded',fileToken:'file_runtime'});
    expect(state.managerApprovalBatches[0].items[0].receiptPhotoTokens).toEqual([]);expect(f.http.post.mock.calls.filter(([url])=>url.includes('/medias/upload_all'))).toHaveLength(1);
  });
  it('rejects startup after a restart with a different Base without altering pending work',async()=>{
    const f=liveRuntime();await runtime!.start();await imageTask();await runtime!.onModuleDestroy();
    const before=await readFile(file,'utf8');f.changeBase();await expect(runtime!.start()).rejects.toThrow('持久来源已变化');expect(await readFile(file,'utf8')).toBe(before);
  });
  it('binds source idempotently and preserves it through an ordinary ledger write',async()=>{
    liveRuntime();await runtime!.start();const source=(await disk()).lifecycleReceiptImageSource;
    await store.recordReminder('normal-write-source-preservation');expect((await disk()).lifecycleReceiptImageSource).toEqual(source);
    await store.bindLifecycleReceiptImageSource(source.appId,source.sourceFingerprint);await store.verifyLifecycleReceiptImageSource(source.appId,source.sourceFingerprint);
  });
  it('does not infer a source for existing unbound receipt work or accept a corrupted source marker',async()=>{
    await imageTask();const before=await readFile(file,'utf8');liveRuntime();await expect(runtime!.start()).rejects.toThrow('缺少持久来源');expect(await readFile(file,'utf8')).toBe(before);
    const raw=JSON.parse(before);raw.lifecycleReceiptImageSource={appId,sourceFingerprint:'invalid'};await writeFile(file,JSON.stringify(raw));
    await expect(store.recordReminder('must-not-overwrite-corruption')).rejects.toThrow('持久来源损坏');
  });
  it('stops scheduling on destroy while preserving an already dispatched successful receipt',async()=>{
    const f=liveRuntime();await runtime!.start();const {taskId}=await imageTask();const original=f.http.post.getMockImplementation()!;
    let entered!:()=>void,release!:(value:any)=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),response=new Promise<any>(resolve=>{release=resolve;});
    f.http.post.mockImplementation(async(url:string)=>{if(url.includes('/medias/upload_all')){entered();return response;}return original(url);});
    runtime!.schedule(taskId);runtime!.schedule(taskId);await started;
    const stopped=runtime!.onModuleDestroy();release({data:{code:0,data:{file_token:'file_shutdown'}}});await stopped;
    expect(runtime!.isReady()).toBe(false);expect(f.http.post.mock.calls.filter(([url])=>url.includes('/medias/upload_all'))).toHaveLength(1);
    expect((await disk()).lifecycleReceiptImageLedger.tasks[0]).toMatchObject({state:'uploaded',fileToken:'file_shutdown'});
    expect((await disk()).managerApprovalBatches[0].items[0].receiptPhotoTokens).toEqual([]);expect(f.report).toHaveBeenCalledTimes(1);
    await expect(runtime!.recoverOnce()).rejects.toThrow();
  });
});
