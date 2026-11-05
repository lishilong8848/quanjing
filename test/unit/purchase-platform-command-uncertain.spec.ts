import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
describe('native platform command uncertainty',()=>{
 it('does not release or write a persisted unfinished task even when its claim is old',async()=>{
  const entry:any={key:'order:rec_one',recordId:'rec_one',action:'order',fingerprint:'original',expectedResultFingerprint:'expected',startedAt:'2020-01-01T00:00:00Z',completedAt:'',notificationWarnings:[],platformIdentity:{}};
  const store:any={findCommand:jest.fn(async()=>entry),releaseCommandClaim:jest.fn()};const gateway:any={getExecutionRecord:jest.fn(),updateExecutionRecord:jest.fn()};
  const service=new PurchaseWorkflowService(gateway,store);
  await expect(service.order('rec_one',{openId:'',accessToken:'test',userName:''},{actualQuantity:1,actualAmount:1,paymentAttachmentTokens:[],note:''})).rejects.toThrow('结果待核对');
  expect(store.releaseCommandClaim).not.toHaveBeenCalled();expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
 });
});
