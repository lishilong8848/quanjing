jest.mock('../../server/modules/purchase-inventory/purchase-manager-approval.config', () => ({isPurchaseManagerApprovalEnabled:()=>true,readPurchaseManagerApprovers:()=>[{openId:'ou_manager',name:'经理'}],readPurchaseManagerApprover:()=>({openId:'ou_manager',name:'经理'})}));
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
const saved = process.env.FEISHU_APP_ID;
beforeEach(()=>{process.env.FEISHU_APP_ID='cli_test';});
afterEach(()=>{if(saved===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=saved;});
const batch = {flowVersion:'lifecycle_v1',lifecycleAppId:'cli_test',approvalBatchId:'purchase-application-123',requesterOpenId:'ou_user',recordIds:['rec_a'],items:[{executionRecordId:'rec_a',status:'approved',choice:'comprehensive',purchaserOpenId:'ou_user',authorityTarget:{building:'A楼'}}]};
function fixture(kind:string, delivered=true, authorized=true) {
 const notification={key:'notification',claimToken:'claim',kind,recordId:'rec_a',recipientOpenId:'ou_user'};
 const entry={replica:{state:delivered?'delivered':'unattempted',appliedRevision:delivered?3:0,batchId:batch.approvalBatchId},stageTargetRevision:3,desiredRevision:5};
 const store={enrollLifecycleRecipientFromNotification:jest.fn(async (_k,_c,authorize)=>{authorize(batch,notification);return entry;}),completeLifecycleStageNotification:jest.fn(async (_k,_c,_r,_ctx,authorize)=>{authorize(batch,notification);}),rescheduleNotification:jest.fn()};
 const gateway={sendInteractiveCard:jest.fn(),updateInteractiveCard:jest.fn()};
 const config={canUseFeishuBusinessIdentity:()=>authorized,feishuPrincipal:()=>({role:'admin',purchaseBuilding:null}),currentDutyRoutePeople:()=>[{openId:'ou_user'}]};
 const service=new PurchaseManagerApprovalService(gateway as never,store as never,undefined,undefined,undefined,config as never);
 const run=()=>(service as unknown as {processLifecycleStageNotification(n:unknown,now:Date):Promise<boolean>}).processLifecycleStageNotification(notification,new Date());
 return {store,gateway,run};
}
describe('manager lifecycle notification routing',()=>{
 it.each(['manager_batch_approval_refresh','manager_batch_purchase_refresh','manager_batch_receipt_refresh','manager_batch_approval_result','manager_batch_purchase_assigned','manager_batch_receipt_requested'])('binds an already delivered target revision without sending a second card: %s',async kind=>{const f=fixture(kind);expect(await f.run()).toBe(true);expect(f.store.completeLifecycleStageNotification).toHaveBeenCalledWith('notification','claim',3,undefined,expect.any(Function),expect.any(Date));expect(f.gateway.sendInteractiveCard).not.toHaveBeenCalled();expect(f.gateway.updateInteractiveCard).not.toHaveBeenCalled();});
 it('waits without binding or sending while replica delivery is pending',async()=>{const f=fixture('manager_batch_purchase_assigned',false);expect(await f.run()).toBe(false);expect(f.store.rescheduleNotification).toHaveBeenCalled();expect(f.store.completeLifecycleStageNotification).not.toHaveBeenCalled();expect(f.gateway.sendInteractiveCard).not.toHaveBeenCalled();});
 it('denies a revoked recipient without completing the notification',async()=>{const f=fixture('manager_batch_purchase_assigned',true,false);await expect(f.run()).rejects.toThrow();expect(f.store.completeLifecycleStageNotification).not.toHaveBeenCalled();expect(f.gateway.sendInteractiveCard).not.toHaveBeenCalled();});
});
