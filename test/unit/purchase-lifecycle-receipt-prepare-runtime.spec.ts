// Business isolation tests run after release activation. Release gating is tested separately.
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
  runHotfixInitialization: (_owner: object, initialize: () => unknown) => initialize(),
  cancelHotfixInitialization: async () => {},
}));
import { PurchaseLifecycleReceiptPrepareRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-prepare-runtime';

describe('isolated receipt preparation runtime',()=>{
  const input:any={appId:'cli_test',actorOpenId:'ou_test',chatId:'oc_test',cardMessageId:'om_test',eventId:'event_1',approvalBatchId:'batch_123',executionRecordId:'rec_test',cardRevision:1,materialType:'receipt_photo'};
  const taskId='receipt-prepare-'+'a'.repeat(64);
  function fixture(){
    const batch:any={approvalBatchId:'batch_123'},item:any={executionRecordId:'rec_test'},lease:any={taskId,leaseToken:'lease_1',input};
    const store:any={acceptLifecycleReceiptPrepare:jest.fn(async(_input:any,authorize:any)=>{authorize(batch,item);return {taskId,status:'pending'};}),claimLifecycleReceiptPrepare:jest.fn(async()=>lease),completeLifecycleReceiptPrepare:jest.fn(async(_lease:any,verify:any,authorize:any)=>{verify();authorize(batch,item);}),failLifecycleReceiptPrepare:jest.fn(async()=>{}),listRecoverableLifecycleReceiptPrepare:jest.fn(async()=>[taskId])};
    const verifier:any={verify:jest.fn(async()=>({proof:true})),assertProof:jest.fn()},authority=jest.fn();
    return {store,verifier,authority,runtime:new PurchaseLifecycleReceiptPrepareRuntime(store,verifier,authority)};
  }
  it('persists before acknowledgement and does not perform network verification in the callback',async()=>{
    const f=fixture(),authorize=jest.fn();expect(await f.runtime.accept(input,authorize)).toEqual({taskId,status:'pending'});expect(authorize).toHaveBeenCalled();expect(f.verifier.verify).not.toHaveBeenCalled();
  });
  it('deduplicates scheduled work and checks current authority in the completion transaction',async()=>{
    const f=fixture();f.runtime.schedule(taskId);f.runtime.schedule(taskId);
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    expect(f.store.claimLifecycleReceiptPrepare).toHaveBeenCalledTimes(1);expect(f.verifier.verify).toHaveBeenCalledTimes(1);expect(f.verifier.assertProof).toHaveBeenCalledTimes(1);expect(f.authority).toHaveBeenCalledTimes(1);expect(f.store.failLifecycleReceiptPrepare).not.toHaveBeenCalled();
  });
  it('does not offer upload when current authority is revoked',async()=>{
    const f=fixture();f.authority.mockImplementation(()=>{throw Error('revoked');});f.runtime.schedule(taskId);
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    expect(f.store.failLifecycleReceiptPrepare).toHaveBeenCalledTimes(1);
  });
  it('recovery is disabled by default and can be explicitly stopped',async()=>{
    jest.useFakeTimers();try {const f=fixture(),scan=jest.spyOn(f.runtime,'recoverOnce').mockResolvedValue();f.runtime.onModuleInit();await jest.advanceTimersByTimeAsync(0);expect(scan).not.toHaveBeenCalled();f.runtime.startRecovery(1000);await jest.advanceTimersByTimeAsync(0);expect(scan).toHaveBeenCalledTimes(1);f.runtime.onModuleDestroy();await jest.advanceTimersByTimeAsync(2000);expect(scan).toHaveBeenCalledTimes(1);}finally{jest.useRealTimers();}
  });
});
