import { mkdtemp, rm } from 'node:fs/promises';import { join } from 'node:path';import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext,parsePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { createPlatformLegacyApprovalWorker } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-worker';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
const batchId='purchase-batch-web-test', now=new Date('2026-11-04T00:00:00Z');
const proof:any={source:'platform',actorAccountId:'person',actorDisplayName:'姓名',actorAuthorizationVersion:1,subjectAccountId:'person',subjectDisplayName:'姓名',subjectAuthorizationVersion:1,sessionFamilyFingerprint:'x'.repeat(43),expiresAt:Date.parse('2027-01-01')};
const ctx=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterOpenId:'ou_requester',requesterName:'申请人',building:'C楼',requestCode:'CG',expectedDeliveryAt:null,createdAt:null,items:['recOne','recTwo'].map(executionRecordId=>({executionRecordId,title:'物品',specification:'/',quantity:'1',unit:'个',amount:'1',status:'pending',choice:'',rejectionReason:''}))});
describe('isolated platform website approval on a batch',()=>{
 let dir:string,store:PurchaseWorkflowStore;
 beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'platform-web-batch-'));store=new PurchaseWorkflowStore(join(dir,'ledger.json'));await store.onModuleInit();await store.registerManagerApprovalBatch({approvalBatchId:batchId,recipientOpenId:'ou_manager',requesterOpenId:'ou_requester',recordIds:['recOne','recTwo']},now);const n=(await store.takeNextManagerApprovalNotification(now))!;await store.markManagerApprovalBatchSendStarted(n.key,n.claimToken,ctx,now);await store.completeManagerApprovalBatchRequestAndRegisterCard(n.key,n.claimToken,{messageId:'om_card'},now);});
 afterEach(async()=>{await store.onModuleDestroy();await rm(dir,{recursive:true,force:true});});
 it.each(['approved','rejected'] as const)('keeps website semantics for %s without modifying other items',async decision=>{
  let record:any={recordId:'recOne',status:'未开始（待审批）',approvalCompleted:false,building:'C楼',specialty:'电气',purchaseMethod:'综合采购',requesterOpenId:'ou_requester',approvalBatchId:batchId,approvalActionId:''};
  const claim=await store.claimPlatformLegacyApproval({record,requestId:'request_batch_123456',decision,identity:proof,appId:'cli_test',sourceFingerprint:'a'.repeat(64)},()=>true);
  const gateway:any={verifyMarker:async()=>{},readSnapshot:async()=>({record:structuredClone(record),markerPresent:true}),writeDecision:async (_id:string,patch:any)=>{expect(Object.keys(patch).sort()).toEqual(['1️⃣物品采购方式','采购审批动作标识','采购流程'].sort());record={...record,status:patch['采购流程'],purchaseMethod:patch['1️⃣物品采购方式'],approvalActionId:patch['采购审批动作标识']};}};
  expect(await createPlatformLegacyApprovalWorker(store,gateway).run(claim.entry.eventId)).toBe('completed');
  const batch=(await store.findManagerApprovalBatch(batchId))!;expect(batch.items[0]).toMatchObject({status:decision==='rejected'?'rejected':'approved',rejectionReason:'',purchaserOpenId:''});expect(batch.items[1]!.status).toBe('pending');
  const card=parsePurchaseManagerBatchApprovalCardContext(batch.cardContext);expect(card.items[0]!.decisionSource).toBe(decision==='rejected'?'platform':undefined);
  const notification=(await store.takeNextManagerApprovalNotification(new Date(Date.now()+60_000)))!;
  expect(notification.kind).toBe('manager_batch_approval_refresh');
  const transport={updateInteractiveCard:jest.fn(async(_messageId:string,_card:unknown)=>{}),sendInteractiveCard:jest.fn(async()=>{throw Error('must update original');})};
  const manager=new PurchaseManagerApprovalService(transport as never,store);
  try {
   expect(await (manager as any).processNotification(notification,new Date(Date.now()+60_000),{processed:0,failed:0,manualReconciliation:0,alerts:[],errors:[]})).toBe(true);
   expect(transport.updateInteractiveCard).toHaveBeenCalledTimes(1);expect(transport.updateInteractiveCard.mock.calls[0][0]).toBe('om_card');
   const rendered=JSON.stringify(transport.updateInteractiveCard.mock.calls[0][1]);expect(rendered).toContain('物品');
   if(decision==='rejected'){expect(rendered).toContain('驳回');expect(rendered).not.toContain('驳回原因：');}
   expect(transport.sendInteractiveCard).not.toHaveBeenCalled();
   expect(await store.takeNextManagerApprovalNotification(new Date(Date.now()+120_000))).toBeNull();
  } finally {/* This service owns no timer or module-destroy hook. */}
 });
 it('rejects a conflicting batch identifier without mutating the original',async()=>{const record:any={recordId:'recOne',status:'未开始（待审批）',approvalCompleted:false,building:'C楼',specialty:'电气',purchaseMethod:'综合采购',requesterOpenId:'ou_requester',approvalBatchId:'other-batch',approvalActionId:''};await expect(store.claimPlatformLegacyApproval({record,requestId:'request_wrong_123456',decision:'approved',identity:proof,appId:'cli_test',sourceFingerprint:'a'.repeat(64)},()=>true)).rejects.toThrow();expect((await store.findManagerApprovalBatch(batchId))!.items[0]!.status).toBe('pending');});
 it('serializes a website decision against simultaneous legacy batch card approval',async()=>{
  const record:any={recordId:'recOne',status:'未开始（待审批）',approvalCompleted:false,building:'C楼',specialty:'电气',purchaseMethod:'综合采购',requesterOpenId:'ou_requester',approvalBatchId:batchId,approvalActionId:''};
  const claims=await Promise.allSettled([store.claimPlatformLegacyApproval({record,requestId:'request_race_123456',decision:'rejected',identity:proof,appId:'cli_test',sourceFingerprint:'a'.repeat(64)},()=>true),store.claimManagerApprovalBatchPendingApproval({approvalBatchId:batchId,eventId:'card-event',actorOpenId:'ou_manager',messageId:'om_card',choice:'comprehensive'},now)]);
  const web=claims[0].status==='fulfilled'&&claims[0].value.kind==='claim',card=claims[1].status==='fulfilled'&&claims[1].value.claimed;
  expect(Number(web)+Number(card)).toBe(1);
 });
});
