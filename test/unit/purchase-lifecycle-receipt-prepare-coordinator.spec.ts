import { PurchaseLifecycleReceiptPrepareCoordinator } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-prepare-coordinator';

describe('isolated lifecycle receipt prepare coordinator',()=>{
  const input:any={appId:'cli_test',actorOpenId:'ou_test',chatId:'oc_test',cardMessageId:'om_test',eventId:'event_1',approvalBatchId:'batch_123',executionRecordId:'rec_test',cardRevision:1,materialType:'receipt_photo'};
  function fixture(){
    const proof:any={...input,verifiedAtMs:1,validUntilMs:2};
    const verifier:any={verify:jest.fn(async()=>proof),assertProof:jest.fn()};
    const lease:any={taskId:'task_1',leaseToken:'lease_1',input};
    const store:any={accept:jest.fn(async(_input:any,authorize:()=>void)=>{authorize();return {taskId:'task_1',accepted:true};}),claim:jest.fn(async()=>lease),complete:jest.fn(async(_lease:any,verify:()=>void,authorize:()=>void)=>{verify();authorize();}),fail:jest.fn(async()=>{})};
    const authorize=jest.fn(),coordinator=new PurchaseLifecycleReceiptPrepareCoordinator(store,verifier,authorize);
    return {store,verifier,authorize,coordinator};
  }
  it('accepts synchronously without waiting for private chat network validation',async()=>{
    const f=fixture();expect(await f.coordinator.accept(input)).toEqual({taskId:'task_1',accepted:true});expect(f.authorize).toHaveBeenCalled();expect(f.verifier.verify).not.toHaveBeenCalled();
  });
  it('validates the private chat then rechecks proof and authorization in store commit',async()=>{
    const f=fixture();expect(await f.coordinator.process('task_1')).toBe('ready');expect(f.verifier.verify).toHaveBeenCalledWith({appId:'cli_test',actorOpenId:'ou_test',chatId:'oc_test',cardMessageId:'om_test'});expect(f.verifier.assertProof).toHaveBeenCalled();expect(f.authorize).toHaveBeenCalled();expect(f.store.complete).toHaveBeenCalledTimes(1);
  });
  it('records failure and does not create an intent if private chat cannot be proven',async()=>{
    const f=fixture();f.verifier.verify.mockRejectedValueOnce(Error('synthetic failure'));expect(await f.coordinator.process('task_1')).toBe('failed');expect(f.store.complete).not.toHaveBeenCalled();expect(f.store.fail).toHaveBeenCalledTimes(1);
  });
  it('is unavailable without the durable store and trusted verifier',async()=>{
    const coordinator=new PurchaseLifecycleReceiptPrepareCoordinator(undefined,undefined,()=>{});await expect(coordinator.accept(input)).rejects.toThrow('尚未就绪');
  });
});
