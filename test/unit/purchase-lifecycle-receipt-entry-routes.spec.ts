import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { PurchaseWorkflowCallbackController } from '../../server/modules/purchase-inventory/purchase-workflow-callback.controller';

describe('isolated lifecycle receipt entry routing', () => {
  const action = {kind:'purchase_batch_fulfillment_action',action:'prepare_receipt_photo',approvalBatchId:'purchase-application-123456',executionRecordId:'recFake',role:'requester',eventId:'synthetic-event',operatorOpenId:'ou_actor',messageId:'om_message',authenticatedChatId:'oc_private',lifecycle:{cardRevision:3}};
  function pair(service:object) {
    const ws:any=Object.create(FeishuCardActionRouter.prototype);ws.purchaseManagerApprovalService=service;
    const http:any=Object.create(PurchaseWorkflowCallbackController.prototype);http.managerApprovalService=service;
    return [(value:any)=>ws.handlePurchaseBatchFulfillment(value),(value:any)=>http.handlePurchaseBatchFulfillmentCardAction(value)];
  }
  it.each(['prepare_receipt_photo','prepare_invoice'])('dispatches trusted %s through both transports and handles duplicate receipts',async kind=>{
    const service={isEnabled:()=>true,handleLifecyclePrepareReceiptImage:jest.fn().mockResolvedValueOnce({status:'pending'}).mockResolvedValueOnce({status:'ready'})};
    const [ws,http]=pair(service);const value={...action,action:kind};
    expect((await ws(value)).toast.content).toContain('正在核验上传权限');
    expect((await http(value)).toast.content).toContain('当前私聊发送图片');
    expect(service.handleLifecyclePrepareReceiptImage).toHaveBeenCalledTimes(2);
    expect(service.handleLifecyclePrepareReceiptImage).toHaveBeenCalledWith(value);
  });
  it('shows a confirmed failure and rejects an unrecognized task state',async()=>{
    const service={isEnabled:()=>true,handleLifecyclePrepareReceiptImage:jest.fn().mockResolvedValueOnce({status:'failed'}).mockResolvedValueOnce({status:'unknown'})};
    const [ws,http]=pair(service); expect((await ws(action)).toast.content).toContain('失败');await expect(http(action)).rejects.toThrow();
  });
  it('rejects missing capability and missing verified private-chat context before dispatch',async()=>{
    const missing={isEnabled:()=>true};for(const route of pair(missing)) await expect(route(action)).rejects.toThrow();
    const service={isEnabled:()=>true,handleLifecyclePrepareReceiptImage:jest.fn()};
    for(const route of pair(service)) await expect(route({...action,authenticatedChatId:undefined})).rejects.toThrow();
    expect(service.handleLifecyclePrepareReceiptImage).not.toHaveBeenCalled();
  });
  it('does not fall back to the old image path when private-chat verification rejects',async()=>{
    const service={isEnabled:()=>true,handleLifecyclePrepareReceiptImage:jest.fn().mockRejectedValue(Error('私聊身份不可核对')),handlePurchaseBatchFulfillmentCardAction:jest.fn()};
    for(const route of pair(service)) await expect(route(action)).rejects.toThrow('私聊身份不可核对');
    expect(service.handlePurchaseBatchFulfillmentCardAction).not.toHaveBeenCalled();
  });
  it('keeps legacy receipt cards on the existing handler',async()=>{
    jest.useFakeTimers();
    try {
      const service={isEnabled:()=>true,handlePurchaseBatchFulfillmentCardAction:jest.fn().mockResolvedValue({claimed:false,card:{schema:'2.0'}}),patchPurchaseBatchFulfillmentCardView:jest.fn().mockResolvedValue(undefined)};
      const ws:any=Object.create(FeishuCardActionRouter.prototype);ws.purchaseManagerApprovalService=service;
      const http:any=Object.create(PurchaseWorkflowCallbackController.prototype);http.managerApprovalService=service;
      const {lifecycle,authenticatedChatId,...old}=action;
      await ws.handlePurchaseBatchFulfillment(old);
      await http.handlePurchaseBatchFulfillmentCardAction(old,{writableFinished:true});
      expect(service.handlePurchaseBatchFulfillmentCardAction).toHaveBeenCalledTimes(2);
    } finally {jest.clearAllTimers();jest.useRealTimers();}
  });
});
