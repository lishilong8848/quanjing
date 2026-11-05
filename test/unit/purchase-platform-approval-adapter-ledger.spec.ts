import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { createPlatformApprovalCoordinator, type PlatformApprovalReadback } from '../../server/modules/purchase-inventory/purchase-platform-approval-coordinator';
import { createPlatformApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-approval-gateway';

const now = new Date('2026-10-26T00:00:00Z');
const identity = Object.freeze({ source:'platform' as const, actorAccountId:'synthetic-person', actorAuthorizationVersion:1, actorDisplayName:'合成人员', subjectAccountId:'synthetic-person', subjectAuthorizationVersion:1, subjectDisplayName:'合成人员', sessionFamilyFingerprint:'x'.repeat(43), expiresAt:Date.parse('2027-01-01T00:00:00Z') });

describe('approval adapter with trusted temporary ledger jobs',()=>{
  let directory:string, owner:string, store:PurchaseWorkflowStore, actionId:string, gateway:any, record:PlatformApprovalReadback;
  beforeEach(async()=>{
    directory=mkdtempSync(join(realpathSync(tmpdir()),'platform-adapter-ledger-')); owner=randomUUID(); writeFileSync(join(directory,'.owner'),owner,{flag:'wx'});
    store=new PurchaseWorkflowStore(join(directory,'ledger.json')); await store.onModuleInit();
    const batchId='purchase-batch-1';
    await store.registerManagerApprovalBatch({approvalBatchId:batchId,recipientOpenId:'ou_manager',requesterOpenId:'ou_requester',recordIds:['recItem1']},now);
    const context=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterOpenId:'ou_requester',requesterName:'合成申请人',building:'C楼',requestCode:'TEST',expectedDeliveryAt:null,createdAt:null,
      items:[{executionRecordId:'recItem1',title:'合成',specification:'/',quantity:'1',unit:'个',amount:'1',status:'pending',choice:'',rejectionReason:''}]});
    const task=(await store.takeNextManagerApprovalNotification(now))!;
    await store.markManagerApprovalBatchSendStarted(task.key,task.claimToken,context,now);
    await store.completeManagerApprovalBatchRequestAndRegisterCard(task.key,task.claimToken,{messageId:'om_card_1'},now);
    const accepted=await store.claimPlatformApprovalItem({approvalBatchId:batchId,record:{recordId:'recItem1',status:'未开始（待审批）',building:'C楼',specialty:'电气'},
      request:{requestId:'synthetic_request_123456789',recordId:'recItem1',choice:'reject',rejectionReason:'合成驳回'},identity,lifecycleReady:false},()=>true,now);
    actionId=accepted.action.eventId;
    record={recordId:'recItem1',requestCode:'TEST',status:'未开始（待审批）',itemName:'合成',building:'C楼',specialty:'电气',requesterOpenId:'ou_requester',requesterName:'合成申请人',purchaserOpenId:'',purchaserName:'',purchaseMethod:'综合采购',rejectionReason:'',requestedQuantity:1,actualQuantity:null,actualAmount:null,approvalCompleted:false,warehouseConfirmed:false,purchaseCompleted:false,receiptConfirmed:false,signer:'',receiptTime:null,receiptPhotoTokens:[],invoiceTokens:[],approvalBatchId:batchId};
    gateway={getPlatformApprovalReadbackAsApp:jest.fn(async()=>structuredClone(record)),resolvePurchaseAdminAsApp:jest.fn(),resolveBuildingSupervisorAsApp:jest.fn(),
      updateManagerApprovalDecisionRecordAsApp:jest.fn(async (_id:string,fields:Record<string,unknown>)=>{record={...record,status:String(fields.采购流程),purchaseMethod:fields['1️⃣物品采购方式'] as '驳回',rejectionReason:String(fields.驳回原因),approvalWorkflowStatus:String(fields.采购工作流状态),approvalActionId:String(fields.采购审批动作标识),platformApprovalTimeMs:Number(fields.采购审批时间),platformCurrentApproverOpenIds:[]};})};
  });
  afterEach(async()=>{await store.onModuleDestroy(); if(dirname(resolve(directory)).toLowerCase()!==realpathSync(tmpdir()).toLowerCase()||!basename(directory).startsWith('platform-adapter-ledger-')||readFileSync(join(directory,'.owner'),'utf8')!==owner)throw new Error('Synthetic fixture ownership mismatch');rmSync(directory,{recursive:true,force:false});});
  it('writes the ledger-bound actor without inventing a Feishu identity and completes once',async()=>{
    const coordinator=createPlatformApprovalCoordinator(store.platformApprovalWorkerPort(),createPlatformApprovalGateway(gateway));
    expect(await coordinator.run(actionId)).toBe('completed');
    expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(gateway.updateManagerApprovalDecisionRecordAsApp.mock.calls[0][1]).not.toHaveProperty('采购实际审批人');
    expect(await coordinator.run(actionId)).toBe('completed'); expect(gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);
  });
  it.each(['actor','requester'] as const)('rejects a tampered %s before dispatch and never writes',async target=>{
    const actual=store.platformApprovalWorkerPort();
    const forged={...actual,claimPending:async(event:string)=>{const job=(await actual.claimPending(event))!;return target==='actor'?{...job,action:{...job.action,actorFeishuOpenId:'ou_forged'}}:{...job,batch:{...job.batch,requesterOpenId:'ou_forged'}};}};
    const coordinator=createPlatformApprovalCoordinator(forged,createPlatformApprovalGateway(gateway));
    await expect(coordinator.run(actionId)).rejects.toThrow(); expect(gateway.updateManagerApprovalDecisionRecordAsApp).not.toHaveBeenCalled();
  });
});
