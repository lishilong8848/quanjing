import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PurchaseWorkflowStore} from '../../server/modules/purchase-inventory/purchase-workflow.store';
import {PurchasePlatformApprovalRuntime} from '../../server/modules/purchase-inventory/purchase-platform-approval-runtime';
import {serializePurchaseManagerBatchApprovalCardContext} from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
jest.mock('../../server/common/hotfix-runtime-activation',()=>({currentHotfixActivation:()=>({isAcceptingNewWork:()=>true}),cancelHotfixInitialization:async()=>{}}));
jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string)=>key==='FEISHU_APP_ID'?'cli_web':''}));
const appId='cli_web',fingerprint='a'.repeat(64),batchId='purchase-web-lifecycle',manager='ou_manager',recordId='rec_web';
const proof:any={source:'platform',actorAccountId:'real_person',subjectAccountId:'real_person',actorAuthorizationVersion:1,subjectAuthorizationVersion:1,actorDisplayName:'合成实名',subjectDisplayName:'合成实名',expiresAt:Date.now()+3600000,sessionFamilyFingerprint:'x'.repeat(43)};
describe('real lifecycle web approval admission and coordinator',()=>{
 let directory:string,file:string,store:PurchaseWorkflowStore,runtime:PurchasePlatformApprovalRuntime,row:any,source:any,gateway:any,session:any;
 beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'lifecycle-web-approval-'));file=join(directory,'ledger.json');store=new PurchaseWorkflowStore(file);await store.onModuleInit();await store.bindLifecycleReceiptImageSource(appId,fingerprint);
  await store.registerManagerApprovalBatch({approvalBatchId:batchId,recipientOpenId:manager,requesterOpenId:'ou_requester',recordIds:[recordId],flowVersion:'lifecycle_v1'},Date.now(),{appId,recipients:[{openId:manager,fullView:false}],authorityTargets:[{recordId,target:{building:'C楼',specialty:'电气'}}],authorize:()=>{}});
  const context=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterOpenId:'ou_requester',requesterName:'申请人',building:'C楼',requestCode:'CG-WEB',expectedDeliveryAt:null,createdAt:null,items:[{executionRecordId:recordId,title:'合成',specification:'/',quantity:'1',unit:'个',amount:'1',status:'pending',choice:'',rejectionReason:''}]});
  const task=(await store.takeNextManagerApprovalNotification(new Date(Date.now()+1000)))!;await store.markManagerApprovalBatchSendStarted(task.key,task.claimToken,context);await store.completeManagerApprovalBatchRequestAndRegisterCard(task.key,task.claimToken,{messageId:'om_manager'});
  const identity={appId,batchId,recipientOpenId:manager},outbox=(await store.getLifecycleOutbox(identity))!,attempt=await store.beginLifecycleDelivery(identity,Date.now(),outbox.desiredRevision,1,()=>{});await store.markLifecycleDeliveryDispatched(identity,attempt.entry.attemptToken,()=>{});await store.completeLifecycleDelivery(identity,attempt.entry.attemptToken,{kind:'send',receipt:{source:'feishu_message_readback',uuid:attempt.entry.replica.uuid,messageId:'om_manager',sentAtMs:Date.now()}});
  row={recordId,approvalBatchId:batchId,status:'未开始（待审批）',building:'C楼',specialty:'电气',purchaseMethod:'综合采购',requesterOpenId:'ou_requester',requesterName:'申请人',approvalCompleted:false,approvalActionId:'',rejectionReason:'',requestedQuantity:1,itemName:'合成',specification:'/',purchaseLinks:[],procurementForm:'',singleReason:''};
  source={sourceIdentity:()=>({appId,sourceFingerprint:fingerprint}),verifyMarker:jest.fn(async()=>{}),readSnapshot:jest.fn(async()=>({record:structuredClone(row),markerPresent:true})),writeDecision:jest.fn(()=>{throw Error('must not use legacy writer');})};
  gateway={getPlatformApprovalReadbackAsApp:jest.fn(async()=>structuredClone(row)),resolvePurchaseAdminAsApp:jest.fn(async()=>({openId:'ou_buyer',name:'采购员'})),resolveBuildingSupervisorAsApp:jest.fn(async()=>({openId:'ou_supervisor',name:'主管'})),updateManagerApprovalDecisionRecordAsApp:jest.fn(async(_id:string,fields:any,guard:()=>Promise<void>)=>{await guard();row={...row,status:fields.采购流程,purchaseMethod:fields['1️⃣物品采购方式'],rejectionReason:fields.驳回原因,purchaserOpenId:fields.采购人?.[0]?.id||'',warehouseConfirmed:fields.库房确认===true,approvalWorkflowStatus:fields.采购工作流状态,approvalActionId:fields.采购审批动作标识,platformApprovalTimeMs:fields.采购审批时间,platformCurrentApproverOpenIds:fields.采购当前审批人,platformActualApproverOpenIds:fields.采购实际审批人?.map((p:any)=>p.id)};})};
  session={platformProof:proof,assertPlatformProof:jest.fn(),assertPlatformPermission:jest.fn()};
  runtime=new PurchasePlatformApprovalRuntime(store,source,{}, {gateway,sourceIdentity:()=>({appId,sourceFingerprint:fingerprint})});runtime.setLifecycleReadiness(()=>true);
 });
 afterEach(async()=>{await runtime.onModuleDestroy();await store.onModuleDestroy();await rm(directory,{recursive:true,force:true});});
 async function settle(taskId:string,acceptFailure=true){for(let i=0;i<100;i++){const value=await runtime.status(taskId,session);if(value.task!.status==='completed'||acceptFailure&&value.task!.status==='failed')return value;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('worker not settled');}
 it('uses the selected method with real-name identity lacking a Feishu binding, refreshes originals, and replays without another write',async()=>{
  const before=(await store.getLifecycleOutbox({appId,batchId,recipientOpenId:manager}))!.desiredRevision;
  const result=await runtime.accept(recordId,{decision:'approved',purchaseMethod:'需求自采'},session);expect((await settle(result.taskId)).task!.status).toBe('completed');
  expect(row.purchaseMethod).toBe('需求自采');expect(row.purchaserOpenId).toBe('ou_supervisor');expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);expect(gateway.updateManagerApprovalDecisionRecordAsApp.mock.calls[0][1]).not.toHaveProperty('采购实际审批人');expect(source.writeDecision).not.toHaveBeenCalled();
  expect((await store.getLifecycleOutbox({appId,batchId,recipientOpenId:manager}))!.desiredRevision).toBeGreaterThan(before);
  const again=await runtime.accept(recordId,{decision:'approved',purchaseMethod:'需求自采'},session);expect(again.taskId).toBe(result.taskId);expect((await settle(again.taskId)).task!.status).toBe('completed');expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);
 });
 it('keeps web rejection reason empty and marks the actual platform source',async()=>{
  const result=await runtime.accept(recordId,{decision:'rejected'},session);expect((await settle(result.taskId)).task!.status).toBe('completed');
  expect(row.rejectionReason).toBe('');const batch=(await store.findManagerApprovalBatch(batchId))!;expect(batch.items[0]).toMatchObject({status:'rejected',decisionSource:'platform',rejectionReason:''});
 });
 it('maps the explicit building-self alias to the same real building supervisor route',async()=>{
  const result=await runtime.accept(recordId,{decision:'approved',purchaseMethod:'需求自采（楼内）'},session);expect((await settle(result.taskId)).task!.status).toBe('completed');expect(row.purchaseMethod).toBe('需求自采');expect(gateway.resolveBuildingSupervisorAsApp).toHaveBeenCalledWith('C楼','电气');expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
 });
 it('blocks source drift and an inactive owner without admitting or dispatching a new command',async()=>{
  runtime.setLifecycleReadiness(()=>false);await expect(runtime.accept(recordId,{decision:'approved'},session)).rejects.toThrow('暂未就绪');
  runtime.setLifecycleReadiness(()=>true);const sourceCheck=jest.spyOn(store,'verifyLifecycleReceiptImageSource').mockRejectedValueOnce(Error('source changed'));
  await expect(runtime.accept(recordId,{decision:'approved'},session)).rejects.toThrow('source changed');sourceCheck.mockRestore();
  expect(gateway.updateManagerApprovalDecisionRecordAsApp).not.toHaveBeenCalled();expect(JSON.parse(await readFile(file,'utf8')).platformApprovalClaims||[]).toHaveLength(0);
 });
 it('rechecks current permission before claim and shares one durable winner with a real card claim',async()=>{
  session.assertPlatformProof.mockImplementationOnce(()=>{throw Error('revoked');});await expect(runtime.accept(recordId,{decision:'approved'},session)).rejects.toThrow('revoked');expect(gateway.updateManagerApprovalDecisionRecordAsApp).not.toHaveBeenCalled();
  const result=await Promise.allSettled([runtime.accept(recordId,{decision:'approved'},session),store.claimManagerApprovalBatchItemApproval({approvalBatchId:batchId,executionRecordId:recordId,eventId:'card_winner',actorOpenId:manager,messageId:'om_manager',choice:'comprehensive',lifecycle:{appId,cardRevision:1}},Date.now(),()=>{})]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);const ledger=JSON.parse(await readFile(file,'utf8'));expect((ledger.platformApprovalClaims?.length||0)+(ledger.managerApprovalBatchActions?.length||0)).toBe(1);
 });
 it('denies another account task status and keeps in-flight unknown writes from dispatching twice',async()=>{
  const actual=gateway.updateManagerApprovalDecisionRecordAsApp.getMockImplementation();gateway.updateManagerApprovalDecisionRecordAsApp.mockImplementationOnce(async(...args:any[])=>{await actual(...args);throw Error('response lost');});
  const result=await runtime.accept(recordId,{decision:'approved'},session);expect((await settle(result.taskId)).task!.status).toBe('failed');
  await expect(runtime.status(result.taskId,{...session,platformProof:{...proof,actorAccountId:'other',subjectAccountId:'other'}})).rejects.toThrow();
  await runtime.runRecoveryOnce();expect((await settle(result.taskId,false)).task!.status).toBe('completed');expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);
 });
 it('recovers a previously accepted lifecycle web task after recreating both runtime and store',async()=>{
  runtime.stopRecovery();
  const accepted=await store.claimPlatformApprovalItem({approvalBatchId:batchId,record:row,identity:proof,lifecycleReady:true,lifecycleSource:{appId,sourceFingerprint:fingerprint},request:{requestId:'restart_lifecycle_123456789',recordId,choice:'comprehensive',rejectionReason:''}},()=>true);
  await runtime.onModuleDestroy();await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
  runtime=new PurchasePlatformApprovalRuntime(store,source,{}, {gateway,sourceIdentity:()=>({appId,sourceFingerprint:fingerprint})});runtime.setLifecycleReadiness(()=>true);await runtime.runRecoveryOnce();
  expect((await settle(accepted.action.eventId,false)).task!.status).toBe('completed');expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);expect(source.writeDecision).not.toHaveBeenCalled();
 });
});
