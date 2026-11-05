import { createLifecycleReceiptWsIngress } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-ws-ingress';
import { createLifecycleReceiptFeishuTransport } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-feishu-transport';
import { createPurchaseLifecycleReceiptEventVerifier } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-event-verifier';
import * as Lark from '@larksuiteoapi/node-sdk';

const appId='cli_synthetic', secret='synthetic-secret';
const event=()=>({schema:'2.0',header:{event_type:'im.message.receive_v1',event_id:'event_synthetic',app_id:appId},event:{sender:{sender_type:'user',sender_id:{open_id:'ou_person'}},message:{chat_type:'p2p',message_type:'image',message_id:'om_image',chat_id:'oc_private',content:JSON.stringify({image_key:'img_synthetic'})}}});
function fixture(realDispatcher=false) {
  let credentials={appId,appSecret:secret}, receive:(payload:unknown)=>Promise<void>=async()=>{}, reconnect=()=>{}, reconnected=()=>{}, sdkOpts:any, state='connected';
  const received: unknown[]=[], snapshots: unknown[]=[];
  const sdk={createDispatcher:jest.fn((card:any,message:(payload:unknown)=>Promise<void>)=>{
    if (!realDispatcher) {receive=message;return { privateDispatcher:true };}
    const dispatcher=new Lark.EventDispatcher({loggerLevel:Lark.LoggerLevel.error}).register({'card.action.trigger':card,'im.message.receive_v1':message} as never);
    receive=async payload=>{await dispatcher.invoke(payload,{needCheck:false});}; return dispatcher;
  }),createClient:jest.fn((options:any)=>{sdkOpts=options; reconnect=options.onReconnecting; reconnected=options.onReconnected;return {start:jest.fn(async()=>{options.onReady();}),close:jest.fn(),getConnectionStatus:()=>({state})};})};
  const http={post:jest.fn(async()=>({data:{code:0,tenant_access_token:'synthetic-token'}})),get:jest.fn(async()=>({data:{code:0,data:{items:[{message_id:'om_image',chat_id:'oc_private',msg_type:'image',deleted:false,create_time:'1790000000000',sender:{id:'ou_person',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({image_key:'img_synthetic'})}}]}}}))};
  let ingress:ReturnType<typeof createLifecycleReceiptWsIngress>;
  const transport=createLifecycleReceiptFeishuTransport({readConfig:()=>({...credentials,appToken:'synthetic-base'}),http,isAuthenticatedWsDelivery:(payload,id)=>ingress.isAuthenticatedWsDelivery(payload,id)});
  const verifier=createPurchaseLifecycleReceiptEventVerifier(transport);
  ingress=createLifecycleReceiptWsIngress({readCredentials:()=>credentials,sdkForTests:sdk,onCard:async()=>({toast:{type:'info',content:'ok'}}),onFailure:()=>{},onMessage:async payload=>{received.push(payload);snapshots.push(await verifier.verify(payload,appId));}});
  return {ingress,sdk,verifier,received,snapshots,emit:(payload:unknown)=>receive(payload),setCredentials:(value:typeof credentials)=>{credentials=value;},disconnect:()=>{state='disconnected';},reconnect:()=>reconnect(),reconnected:()=>reconnected(),getOptions:()=>sdkOpts};
}
describe('隔离的 SDK 长连接事件来源',()=>{
  it('仅在实际派发回调执行期间证明深冻结的复制事件',async()=>{
    const f=fixture();await f.ingress.start();const raw=event();await f.emit(raw);
    expect(f.snapshots).toHaveLength(1); const delivered=f.received[0] as any;
    expect(delivered).not.toBe(raw);expect(Object.isFrozen(delivered.event.message)).toBe(true);
    expect(f.ingress.isAuthenticatedWsDelivery(delivered,appId)).toBe(false);
    await expect(f.verifier.verify(raw,appId)).rejects.toThrow();
    await expect(f.verifier.verify(delivered,appId)).rejects.toThrow();
    f.ingress.close();
  });
  it('拒绝跨应用、伪造对象及调用结束后的旧证明',async()=>{
    const f=fixture();await f.ingress.start();await f.emit(event());const old=f.received[0];
    expect(f.ingress.isAuthenticatedWsDelivery(old,'cli_other')).toBe(false);
    expect(f.ingress.isAuthenticatedWsDelivery(Object.freeze(event()),appId)).toBe(false);
    f.setCredentials({appId:'cli_other',appSecret:secret});await f.emit(event());expect(f.snapshots).toHaveLength(1);
    f.ingress.close();
  });
  it('断线及重连等待期间不签发证明，恢复后可接受正常派发',async()=>{
    const f=fixture();await f.ingress.start();f.reconnect();await f.emit(event());expect(f.snapshots).toHaveLength(0);
    f.reconnected();await f.emit(event());expect(f.snapshots).toHaveLength(1);
    f.disconnect();await f.emit(event());expect(f.snapshots).toHaveLength(1);f.ingress.close();
  });
  it('飞书重复派发获得两次独立来源证明，业务去重留给同锁账本',async()=>{
    const f=fixture();await f.ingress.start();const raw=event();await f.emit(raw);await f.emit(raw);
    expect(f.snapshots).toHaveLength(2);expect(f.received[0]).not.toBe(f.received[1]);
    expect(f.snapshots[0]).toMatchObject({eventId:'event_synthetic',imageMessageId:'om_image'});
    expect(f.snapshots[1]).toMatchObject({eventId:'event_synthetic',imageMessageId:'om_image'});f.ingress.close();
  });
  it('真实 SDK EventDispatcher 平铺事件后仍可验证，未连接网络',async()=>{
    const f=fixture(true); await f.ingress.start(); await f.emit(event());
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0]).toMatchObject({eventId:'event_synthetic',actorOpenId:'ou_person',imageMessageId:'om_image'});
    expect((f.received[0] as any).event_type).toBe('im.message.receive_v1');
    f.ingress.close();
  });
  it('连接尚未就绪时关闭会结束等待，迟到连接回调不能重开证明',async()=>{
    let options:any;
    const sdk={createDispatcher:()=>({}),createClient:(value:any)=>{options=value;return {start:()=>new Promise(()=>{}),close:()=>{},getConnectionStatus:()=>({state:'connected'})};}};
    const ingress=createLifecycleReceiptWsIngress({readCredentials:()=>({appId,appSecret:secret}),sdkForTests:sdk,onCard:async()=>({}),onMessage:async()=>{},onFailure:()=>{}});
    const starting=ingress.start();ingress.close();await expect(starting).rejects.toThrow('已关闭');options.onReady();
    expect(ingress.isAuthenticatedWsDelivery(Object.freeze({}),appId)).toBe(false);
  });
});
