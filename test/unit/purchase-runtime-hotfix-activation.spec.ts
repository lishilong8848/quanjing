import { HotfixActivation } from '../../server/common/hotfix-activation';
import type { HotfixReleaseProof } from '../../server/common/hotfix-release-proof';
import { PurchasePlatformApprovalRuntime } from '../../server/modules/purchase-inventory/purchase-platform-approval-runtime';
import { PurchaseLifecycleReceiptPrepareRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-prepare-runtime';
import { PurchaseLifecycleRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-runtime';

let mockGate: HotfixActivation;
jest.mock('../../server/common/hotfix-runtime-activation',()=>({
  currentHotfixActivation:()=>mockGate,
  runHotfixInitialization:(owner:object,initialize:()=>void|Promise<void>)=>mockGate.run(owner,initialize),
  cancelHotfixInitialization:(owner:object)=>mockGate.cancel(owner),
}));

describe('purchase runtimes obey the real release activation state machine',()=>{
  let proof:HotfixReleaseProof,maintenance:boolean;
  beforeEach(()=>{
    jest.useFakeTimers();maintenance=true;
    proof={mode:'candidate-held',deploymentId:'release-test',maintenance:true,canInitialize:false,canAcceptNewWork:false};
    mockGate=new HotfixActivation({inspect:()=>proof,hasMaintenance:()=>maintenance});mockGate.completeBootstrap();
  });
  afterEach(async()=>{await mockGate.close();jest.useRealTimers();});
  async function committed(){proof={...proof,mode:'candidate-committed',canInitialize:true};await mockGate.refresh();}
  async function finalized(){maintenance=false;proof={...proof,mode:'installed',maintenance:false,canInitialize:true,canAcceptNewWork:true};await mockGate.refresh();}

  it('does not scan either recovery queue while held or committed, then starts after finalized',async()=>{
    const platformStore:any={listRecoverablePlatformLegacyApprovals:jest.fn(async()=>[])};
    const receiptStore:any={listRecoverableLifecycleReceiptPrepare:jest.fn(async()=>[])};
    const platform=new PurchasePlatformApprovalRuntime(platformStore,{} as never,{enabled:true,intervalMs:1000});
    const receipt=new PurchaseLifecycleReceiptPrepareRuntime(receiptStore,{} as never,()=>{},{enabled:true,intervalMs:1000});
    await platform.onApplicationBootstrap();await receipt.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(platformStore.listRecoverablePlatformLegacyApprovals).not.toHaveBeenCalled();expect(receiptStore.listRecoverableLifecycleReceiptPrepare).not.toHaveBeenCalled();
    await committed();await jest.advanceTimersByTimeAsync(1000);
    expect(platformStore.listRecoverablePlatformLegacyApprovals).not.toHaveBeenCalled();expect(receiptStore.listRecoverableLifecycleReceiptPrepare).not.toHaveBeenCalled();
    await finalized();await jest.advanceTimersByTimeAsync(1000);
    expect(platformStore.listRecoverablePlatformLegacyApprovals).toHaveBeenCalledTimes(1);expect(receiptStore.listRecoverableLifecycleReceiptPrepare).toHaveBeenCalledTimes(1);
    maintenance=true;await jest.advanceTimersByTimeAsync(2000);
    expect(platformStore.listRecoverablePlatformLegacyApprovals).toHaveBeenCalledTimes(1);expect(receiptStore.listRecoverableLifecycleReceiptPrepare).toHaveBeenCalledTimes(1);
    await platform.onModuleDestroy();await receipt.onModuleDestroy();
  });

  it('holds card delivery through committed and withdraws readiness immediately on new maintenance',async()=>{
    const worker={run:jest.fn(async()=>{})};const runtime=new PurchaseLifecycleRuntime(worker,{verify:async()=>true},jest.fn(),1000);
    await runtime.start(true);await runtime.tick();expect(worker.run).not.toHaveBeenCalled();expect(runtime.isReady()).toBe(false);
    await committed();await runtime.tick();expect(worker.run).not.toHaveBeenCalled();expect(runtime.isReady()).toBe(false);
    await finalized();expect(runtime.isReady()).toBe(true);await runtime.tick();expect(worker.run).toHaveBeenCalledTimes(1);
    maintenance=true;expect(runtime.isReady()).toBe(false);await runtime.tick();expect(worker.run).toHaveBeenCalledTimes(1);await runtime.stop();
  });

  it('cancelled pending initialization cannot start after a later finalize',async()=>{
    const store:any={listRecoverablePlatformLegacyApprovals:jest.fn(async()=>[])};
    const platform=new PurchasePlatformApprovalRuntime(store,{} as never,{enabled:true,intervalMs:1000});
    const receiptStore:any={listRecoverableLifecycleReceiptPrepare:jest.fn(async()=>[])};
    const receipt=new PurchaseLifecycleReceiptPrepareRuntime(receiptStore,{} as never,()=>{},{enabled:true,intervalMs:1000});
    const worker={run:jest.fn(async()=>{})},cards=new PurchaseLifecycleRuntime(worker,{verify:async()=>true},jest.fn(),1000);
    await platform.onApplicationBootstrap();await receipt.onModuleInit();await cards.start(true);
    await platform.onModuleDestroy();await receipt.onModuleDestroy();await cards.stop();
    await finalized();await jest.advanceTimersByTimeAsync(3000);
    expect(store.listRecoverablePlatformLegacyApprovals).not.toHaveBeenCalled();expect(receiptStore.listRecoverableLifecycleReceiptPrepare).not.toHaveBeenCalled();expect(worker.run).not.toHaveBeenCalled();
  });

  it('rejects direct new work during maintenance, not just HTTP requests',async()=>{
    const store:any={claimPlatformLegacyApproval:jest.fn()},source:any={verifyMarker:jest.fn()};
    const platform=new PurchasePlatformApprovalRuntime(store,source);
    await expect(platform.accept('rec_test',{decision:'approved'},{} as never)).rejects.toThrow('系统更新中');
    expect(store.claimPlatformLegacyApproval).not.toHaveBeenCalled();expect(source.verifyMarker).not.toHaveBeenCalled();
    const receiptStore:any={acceptLifecycleReceiptPrepare:jest.fn()};
    const receipt=new PurchaseLifecycleReceiptPrepareRuntime(receiptStore,{} as never,()=>{});
    await expect(receipt.accept({} as never,()=>{})).rejects.toThrow('系统更新中');
    expect(receiptStore.acceptLifecycleReceiptPrepare).not.toHaveBeenCalled();
    await platform.onModuleDestroy();await receipt.onModuleDestroy();
  });

  it('checks activation again after a slow delivery dependency read',async()=>{
    await finalized();let finish!:(value:boolean)=>void;
    const verify=jest.fn().mockResolvedValueOnce(true).mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
    const worker={run:jest.fn(async()=>{})},runtime=new PurchaseLifecycleRuntime(worker,{verify},jest.fn(),1000);
    await runtime.start(true);await mockGate.refresh();const tick=runtime.tick();maintenance=true;finish(true);await tick;
    expect(worker.run).not.toHaveBeenCalled();await runtime.stop();
  });
  it('keeps a receipt preparation recoverable when maintenance begins during its private-chat read',async()=>{
    await finalized();let finish!:(value:unknown)=>void;
    const taskId='receipt-prepare-'+'a'.repeat(64),input:any={appId:'cli_test',actorOpenId:'ou_test',chatId:'oc_test',cardMessageId:'om_test'};
    const store:any={claimLifecycleReceiptPrepare:jest.fn(async()=>({taskId,leaseToken:'lease',input})),
      completeLifecycleReceiptPrepare:jest.fn(async(_lease:unknown,verify:()=>void,authorize:(batch:unknown,item:unknown)=>void)=>{verify();authorize({},{});}),failLifecycleReceiptPrepare:jest.fn(async()=>{})};
    const verifier:any={verify:jest.fn(()=>new Promise(resolve=>{finish=resolve;})),assertProof:jest.fn()};
    const runtime=new PurchaseLifecycleReceiptPrepareRuntime(store,verifier,()=>{});
    runtime.schedule(taskId);await jest.advanceTimersByTimeAsync(0);
    expect(verifier.verify).toHaveBeenCalledTimes(1);maintenance=true;finish({});
    await jest.advanceTimersByTimeAsync(0);
    expect(store.failLifecycleReceiptPrepare).not.toHaveBeenCalled();
    await runtime.onModuleDestroy();
  });
});
