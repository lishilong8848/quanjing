jest.mock('../../server/modules/purchase-inventory/purchase-manager-approval.config', () => ({isPurchaseManagerApprovalEnabled:()=>true,readPurchaseManagerApprovers:()=>[{openId:'ou_manager',name:'经理'}],readPurchaseManagerApprover:()=>({openId:'ou_manager',name:'经理'})}));
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
const saved=process.env.FEISHU_APP_ID;
beforeEach(()=>{process.env.FEISHU_APP_ID='cli_test';});afterEach(()=>{if(saved===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=saved;});
const target={building:'A楼'};
const item=(id:string)=>({executionRecordId:id,status:'pending',authorityTarget:target});
function fixture(batch:unknown, allowed=true){
 const store={claimManagerApprovalBatchPendingApproval:jest.fn(async (_input,_now,authorize)=>{authorize(batch);return {claimed:true};}),claimManagerApprovalBatchItemApproval:jest.fn(async (_input,_now,authorize)=>{authorize(batch,(batch as any).items[0]);return {claimed:true};})};
 const gateway={getExecutionRecordAsApp:jest.fn()};
 const config={canUseFeishuBusinessIdentity:()=>allowed,feishuPrincipal:()=>({role:'admin',purchaseBuilding:null}),currentDutyRoutePeople:()=>[{openId:'ou_manager'}]};
 const service=new PurchaseManagerApprovalService(gateway as never,store as never,undefined,undefined,undefined,config as never);
 return {service,store,gateway};
}
function action(name:string){return {kind:'manager_batch_action',action:name,approvalBatchId:'purchase-batch-01',operatorOpenId:'ou_manager',messageId:'om_card',eventId:'evt',executionRecordId:'rec_a',lifecycle:{cardRevision:1}} as never;}
describe('lifecycle manager action acceptance',()=>{
 it('claims a single approval with only local trusted state, not a slow Feishu read',async()=>{const f=fixture({recordIds:['rec_a'],items:[item('rec_a')]});await f.service.handleManagerBatchCardAction(action('approve_item_comprehensive'));expect(f.store.claimManagerApprovalBatchItemApproval).toHaveBeenCalled();expect(f.gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();});
 it('claims whole batch only after validating every item scope',async()=>{const f=fixture({recordIds:['rec_a','rec_b'],items:[item('rec_a'),item('rec_b')]});await f.service.handleManagerBatchCardAction(action('approve_pending_comprehensive'));expect(f.store.claimManagerApprovalBatchPendingApproval).toHaveBeenCalled();expect(f.gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();});
 it('denies the entire batch if any pending item lacks a scope or user is inactive',async()=>{const f=fixture({recordIds:['rec_a','rec_b'],items:[item('rec_a'),{executionRecordId:'rec_b',status:'pending'}]});await expect(f.service.handleManagerBatchCardAction(action('approve_pending_comprehensive'))).rejects.toThrow();const g=fixture({recordIds:['rec_a'],items:[item('rec_a')]},false);await expect(g.service.handleManagerBatchCardAction(action('approve_pending_comprehensive'))).rejects.toThrow();});
 it('does not allow self purchase for H building in whole-batch decision',async()=>{const f=fixture({recordIds:['rec_a'],items:[{...item('rec_a'),authorityTarget:{building:'H楼'}}]});await expect(f.service.handleManagerBatchCardAction(action('approve_pending_building_self'))).rejects.toThrow();});
});
