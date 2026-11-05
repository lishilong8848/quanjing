import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';

describe('receipt preparation manager entry (isolated, unregistered)',()=>{
  const previous=process.env.FEISHU_APP_ID;
  const callback:any={kind:'purchase_batch_fulfillment_action',eventId:'event-1',operatorOpenId:'ou_test',messageId:'om_test',authenticatedChatId:'oc_test',action:'prepare_receipt_photo',approvalBatchId:'batch_123',executionRecordId:'rec_test',lifecycle:{appId:'cli_test',cardRevision:2}};
  const batch:any={requesterOpenId:'ou_test'},item:any={status:'approved',authorityTarget:{building:'C楼',specialty:'电气'}};
  beforeEach(()=>{process.env.FEISHU_APP_ID='cli_test';});
  afterEach(()=>{if(previous===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=previous;jest.restoreAllMocks();});
  function fixture(enable=true){
    const access:any={canUseFeishuBusinessIdentity:jest.fn(()=>true),feishuPrincipal:jest.fn(()=>({role:'admin',purchaseBuilding:null}))};
    const runtime:any={accept:jest.fn(async(_input:any,authorize:any)=>{authorize(batch,item);return {taskId:'task-id',status:'pending'};}),schedule:jest.fn()};
    const service=new PurchaseManagerApprovalService({} as never,{} as never,undefined,undefined,undefined,access,enable?runtime:undefined);
    jest.spyOn(service,'isEnabled').mockReturnValue(true);return {access,runtime,service};
  }
  it('fails closed without the explicitly registered runtime',async()=>{const f=fixture(false);await expect(f.service.handleLifecyclePrepareReceiptImage(callback)).rejects.toThrow('尚未就绪');});
  it('persists a trusted callback and schedules background verification',async()=>{const f=fixture();expect(await f.service.handleLifecyclePrepareReceiptImage(callback)).toEqual({status:'pending'});expect(f.runtime.accept.mock.calls[0][0]).toMatchObject({actorOpenId:'ou_test',chatId:'oc_test',cardMessageId:'om_test',cardRevision:2,materialType:'receipt_photo'});expect(f.runtime.schedule).toHaveBeenCalledWith('task-id');});
  it('rejects revoked identity and non-requesters before accepting work',async()=>{const f=fixture();f.access.canUseFeishuBusinessIdentity.mockReturnValue(false);await expect(f.service.handleLifecyclePrepareReceiptImage(callback)).rejects.toThrow();expect(f.runtime.schedule).not.toHaveBeenCalled();f.access.canUseFeishuBusinessIdentity.mockReturnValue(true);await expect(f.service.handleLifecyclePrepareReceiptImage({...callback,operatorOpenId:'ou_other'})).rejects.toThrow();expect(f.runtime.schedule).not.toHaveBeenCalled();});
  it('keeps a persisted task pending if the wake-up fails',async()=>{const f=fixture();f.runtime.schedule.mockImplementation(()=>{throw Error('synthetic scheduler failure');});expect(await f.service.handleLifecyclePrepareReceiptImage(callback)).toEqual({status:'pending'});});
});
