jest.mock('../../server/modules/purchase-inventory/purchase-manager-approval.config', () => ({isPurchaseManagerApprovalEnabled: () => true, readPurchaseManagerApprovers: () => [{openId:'ou_manager',name:'经理'}],readPurchaseManagerApprover:()=>({openId:'ou_manager',name:'经理'})}));
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
const previous = process.env.FEISHU_APP_ID;
beforeEach(() => { process.env.FEISHU_APP_ID = 'cli_test_app'; });
afterEach(() => { if(previous===undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID=previous; });
const action = {key:'a',claimToken:'claim',approvalBatchId:'purchase-application-123',recordIds:['rec_a'],eventId:'evt_a',actorOpenId:'ou_manager',choice:'reject',rejectionReason:'不合适',attempts:1};
function fixture(record: Record<string,unknown>, active=true) {
 const item = {executionRecordId:'rec_a',status:'processing',authorityTarget:{building:'A楼'}};
 const batch = {flowVersion:'lifecycle_v1',approvalBatchId:action.approvalBatchId,recordIds:['rec_a'],items:[item]};
 const store = {findManagerApprovalBatch:jest.fn().mockResolvedValue(batch),rescheduleManagerApprovalBatchAction:jest.fn(),markManagerApprovalBatchActionRecordManual:jest.fn(),completeManagerApprovalBatchActionRecord:jest.fn(),failManagerApprovalBatchActionAndEnqueueRefresh:jest.fn()};
 const gateway = {getExecutionRecordAsApp:jest.fn().mockResolvedValue(record),updateExecutionRecordAsApp:jest.fn()};
 const config = {canUseFeishuBusinessIdentity:jest.fn().mockReturnValue(active),feishuPrincipal:jest.fn().mockReturnValue({role:'admin',purchaseBuilding:null}),currentDutyRoutePeople:jest.fn().mockReturnValue([{openId:'ou_manager'}])};
 const service = new PurchaseManagerApprovalService(gateway as never,store as never,undefined,undefined,undefined,config as never);
 const result = {processed:0,failed:0,manualReconciliation:0,alerts:[] as string[],errors:[] as string[]};
 const run = () => (service as unknown as {processBatchAction(a:unknown,n:Date,r:unknown):Promise<boolean>}).processBatchAction(action,new Date(),result);
 return {store,gateway,config,result,run};
}
const initial = {recordId:'rec_a',status:'未开始（待审批）',building:'A楼',purchaseMethod:'综合采购',rejectionReason:'',approvalBatchId:action.approvalBatchId};
describe('lifecycle asynchronous approval revalidation',()=>{
 it('does not write if building has drifted',async()=>{const f=fixture({...initial,building:'B楼'});await f.run();expect(f.gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();expect(f.store.rescheduleManagerApprovalBatchAction).toHaveBeenCalled();});
 it('continues a durably accepted action when the operator is later disabled',async()=>{const f=fixture(initial,false);await f.run();expect(f.gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);});
 it('only closes an already applied result when the recorded event matches',async()=>{const applied={...initial,status:'驳回申请',purchaseMethod:'驳回',rejectionReason:'不合适',approvalBatchId:action.approvalBatchId};const bad=fixture({...applied,approvalActionId:'evt_other'});await bad.run();expect(bad.store.completeManagerApprovalBatchActionRecord).not.toHaveBeenCalled();expect(bad.store.markManagerApprovalBatchActionRecordManual).toHaveBeenCalled(); const good=fixture({...applied,approvalActionId:'evt_a'},false);await good.run();expect(good.store.completeManagerApprovalBatchActionRecord).toHaveBeenCalled();expect(good.gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();});
});

