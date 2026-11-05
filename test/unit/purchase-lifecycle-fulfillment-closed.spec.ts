import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { serializePurchaseBatchFulfillmentCommandContext } from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

describe('lifecycle fulfillment remains safely closed until its execution path is complete', () => {
  const batchId='purchase-application-safe-test', recordId='rec_one';
  const context = serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterOpenId:'ou_requester',requesterName:'申请人',building:'H楼',requestCode:'CG-TEST',expectedDeliveryAt:null,createdAt:null,items:[{executionRecordId:recordId,title:'测试',specification:'/',quantity:'1',unit:'个',amount:'1',status:'approved',choice:'comprehensive',rejectionReason:''}]});
  function setup() {
    const batch={flowVersion:'lifecycle_v1',approvalBatchId:batchId,requesterOpenId:'ou_requester',cardContext:context,recordIds:[recordId],items:[{executionRecordId:recordId,status:'approved',purchaserOpenId:'ou_buyer'}]};
    const gateway={sendInteractiveCard:jest.fn(),getExecutionRecordAsApp:jest.fn()};
    const store={findManagerApprovalBatch:jest.fn(async()=>batch),rescheduleNotification:jest.fn(),failNotification:jest.fn(),markManagerApprovalBatchSendStarted:jest.fn(),completeNotification:jest.fn()};
    const workflow={orderFromCard:jest.fn(),receiveFromCard:jest.fn()};
    const service=new PurchaseManagerApprovalService(gateway as never,store as never,undefined,workflow as never);
    return {gateway,store,workflow,service:service as any};
  }
  it.each(['order','receive'] as const)('does not treat a v1 %s business command as a card delivery or write',async action=>{
    const f=setup();
    const payload=action==='order'?{version:4 as const,workflowType:'purchase_batch_fulfillment' as const,action:'order' as const,approvalBatchId:batchId,executionRecordId:recordId,actorOpenId:'ou_buyer',actualQuantity:1,actualAmount:1,note:'',paymentAttachmentTokens:[]}:{version:4 as const,workflowType:'purchase_batch_fulfillment' as const,action:'receipt' as const,approvalBatchId:batchId,executionRecordId:recordId,actorOpenId:'ou_requester',signerOpenId:'ou_requester',receiptTime:Date.now(),note:'',receiptPhotoTokens:['file_token'],invoiceTokens:[]};
    const n={key:'task',claimToken:'claim',kind:`manager_batch_${action==='order'?'order':'receipt'}_command`,cardContext:serializePurchaseBatchFulfillmentCommandContext(payload),acceptedAppId:'cli_test',attempts:1};
    const result={failed:0,errors:[],alerts:[]};
    expect(await f.service.processPurchaseBatchFulfillmentCommand(n,new Date(),result)).toBe(false);
    expect(f.workflow.orderFromCard).not.toHaveBeenCalled();expect(f.workflow.receiveFromCard).not.toHaveBeenCalled();expect(f.gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(f.store.rescheduleNotification).toHaveBeenCalled(); expect(result.errors.join()).toContain('尚未就绪');
  });
  it('does not send a new legacy receipt-completed card for v1',async()=>{
    const f=setup(), result={failed:0,errors:[],alerts:[]};
    const n={key:'task',claimToken:'claim',kind:'manager_batch_receipt_completed',businessEventId:`manager_batch_receipt_completed:${batchId}:${recordId}`,recordId,recipientOpenId:'ou_buyer',cardContext:context,attempts:1};
    expect(await f.service.processPurchaseBatchReceiptCompletedNotification(n,new Date(),result)).toBe(false);
    expect(f.gateway.sendInteractiveCard).not.toHaveBeenCalled();expect(f.store.markManagerApprovalBatchSendStarted).not.toHaveBeenCalled();
    expect(f.store.rescheduleNotification).toHaveBeenCalled();expect(result.errors.join()).toContain('尚未就绪');
  });
});

