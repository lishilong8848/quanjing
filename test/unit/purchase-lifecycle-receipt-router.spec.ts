import 'reflect-metadata';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { PurchaseInventoryModule } from '../../server/modules/purchase-inventory/purchase-inventory.module';
import { PurchaseLifecycleCardTransport } from '../../server/modules/purchase-inventory/purchase-lifecycle-card-transport';
import { PurchaseLifecycleReceiptImageRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-runtime';
import { PURCHASE_LIFECYCLE_RECEIPT_PROVIDERS } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt.providers';
import { PURCHASE_LIFECYCLE_PAYMENT_PROVIDERS } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment.providers';
import { FEISHU_CARD_ACTION_TRANSPORT,FeishuCardActionLongConnectionTransport } from '../../server/modules/overtime-workflow/overtime-workflow.card-action.consumer';
jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string)=>key==='FEISHU_APP_ID'?'cli_test':''}));
jest.mock('../../server/common/hotfix-runtime-activation',()=>({...jest.requireActual('../../server/common/hotfix-runtime-activation'),currentHotfixActivation:()=>({isAcceptingNewWork:()=>true})}));
const payload=()=>({header:{event_type:'im.message.receive_v1',event_id:'event_image',app_id:'cli_test'},event:{sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{chat_type:'p2p',message_type:'image',message_id:'om_photo',chat_id:'oc_private',content:JSON.stringify({image_key:'img_test'})}}});
function fixture(image:any,owned=true){const off={isEnabled:()=>false};const store={ownsLifecycleReceiptImageMessage:jest.fn(async()=>owned)};const old={isEnabled:()=>true,handlePurchaseReceiptImageMessage:jest.fn(async()=>({accepted:true,enqueued:true})),runPendingTasks:jest.fn(async()=>{})};const router=new FeishuCardActionRouter(off as never,off as never,off as never,store as never,old as never,off as never,off as never,undefined,undefined,undefined,undefined,image);return {router,store,old};}
describe('receipt message production routing',()=>{
  it('binds exactly one shared transport and retains payment providers',()=>{
    const providers:any[]=Reflect.getMetadata('providers',PurchaseInventoryModule);
    expect(providers.filter(p=>p===PurchaseLifecycleCardTransport)).toHaveLength(1);expect(providers).not.toContain(FeishuCardActionLongConnectionTransport);
    expect(providers.filter(p=>p?.provide===FEISHU_CARD_ACTION_TRANSPORT)).toEqual([{provide:FEISHU_CARD_ACTION_TRANSPORT,useExisting:PurchaseLifecycleCardTransport}]);
    for(const p of [...PURCHASE_LIFECYCLE_RECEIPT_PROVIDERS,...PURCHASE_LIFECYCLE_PAYMENT_PROVIDERS])expect(providers).toContain(p);
  });
  it('routes an owned message once to lifecycle and never runs the old worker',async()=>{
    const image={accept:jest.fn(async()=>({accepted:true,enqueued:true})),isReady:()=>true},f=fixture(image),message=payload();
    await f.router.handleMessage(message);expect(image.accept).toHaveBeenCalledWith(message);expect(f.old.handlePurchaseReceiptImageMessage).not.toHaveBeenCalled();expect(f.old.runPendingTasks).not.toHaveBeenCalled();
  });
  it('preserves old messages and non-image handling without a lifecycle network call',async()=>{
    const image={accept:jest.fn(),isReady:()=>true},f=fixture(image,false),message=payload();await f.router.handleMessage(message);
    expect(image.accept).not.toHaveBeenCalled();expect(f.old.handlePurchaseReceiptImageMessage).toHaveBeenCalledWith(message);expect(f.old.runPendingTasks).toHaveBeenCalledTimes(1);
    f.store.ownsLifecycleReceiptImageMessage.mockClear();await f.router.handleMessage({event_type:'not-an-image'});expect(f.store.ownsLifecycleReceiptImageMessage).not.toHaveBeenCalled();expect(image.accept).not.toHaveBeenCalled();
  });
  it('never falls back to old processing on ambiguous ownership or lifecycle verification failure',async()=>{
    const image={accept:jest.fn(async()=>{throw Error('untrusted lifecycle');}),isReady:()=>true},f=fixture(image);
    await expect(f.router.handleMessage(payload())).rejects.toThrow('untrusted lifecycle');expect(f.old.handlePurchaseReceiptImageMessage).not.toHaveBeenCalled();
    f.store.ownsLifecycleReceiptImageMessage.mockRejectedValueOnce(Error('ambiguous'));
    await expect(f.router.handleMessage(payload())).rejects.toThrow('ambiguous');expect(f.old.handlePurchaseReceiptImageMessage).not.toHaveBeenCalled();
  });
  it('rejects an HTTP-created lookalike with the real runtime and unconnected trusted transport',async()=>{
    const store={bindLifecycleReceiptImageSource:jest.fn(async()=>{}),verifyLifecycleReceiptImageSource:jest.fn(async()=>{}),acceptVerifiedLifecycleReceiptImage:jest.fn()},http={get:jest.fn(),post:jest.fn()},transport=new PurchaseLifecycleCardTransport();
    const image=new PurchaseLifecycleReceiptImageRuntime({} as never,store as never,{axiosRef:http} as never,transport,{readSource:()=>({appId:'cli_test',appSecret:'synthetic',appToken:'base_test',tableId:'tbl_test'}),enabled:()=>true,acceptingWork:()=>true,intervalMs:60_000});
    try{await image.start();const f=fixture(image);await expect(f.router.handleMessage(payload())).rejects.toThrow('来源未认证');expect(http.post).not.toHaveBeenCalled();expect(http.get).not.toHaveBeenCalled();expect(store.acceptVerifiedLifecycleReceiptImage).not.toHaveBeenCalled();expect(f.old.handlePurchaseReceiptImageMessage).not.toHaveBeenCalled();}
    finally{await image.onModuleDestroy();await transport.close();}
  });
});
