import { createLifecycleReceiptFeishuTransport } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-feishu-transport';
import { createPurchaseLifecycleReceiptEventVerifier } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-event-verifier';
import { createLifecyclePrivateChatVerifier } from '../../server/modules/purchase-inventory/purchase-lifecycle-private-chat-verifier';

const appId='cli_synthetic', secret='synthetic-only-secret', appToken='synthetic-base';
const image=Buffer.from([137,80,78,71,13,10,26,10,0,1,2]);
const copyFrozen = <T>(value:T):T => { if (value && typeof value==='object') { Object.values(value).forEach(copyFrozen); Object.freeze(value); } return value; };
function fixture() {
  let config={appId,appSecret:secret,appToken};
  const trusted=new WeakSet<object>();
  const event=copyFrozen({header:{event_type:'im.message.receive_v1',event_id:'event_synthetic',app_id:appId},event:{sender:{sender_type:'user',sender_id:{open_id:'ou_person'}},message:{chat_type:'p2p',message_type:'image',message_id:'om_image',chat_id:'oc_private',content:JSON.stringify({image_key:'img_synthetic'})}}});
  const http={post:jest.fn(async (url:string)=>url.includes('/auth/') ? {data:{code:0,tenant_access_token:'synthetic-app-token'}} : {data:{code:0,data:{file_token:'synthetic-file-token'}}}),get:jest.fn(async (url:string)=> {
    if (url.includes('/resources/')) return {data:Buffer.from(image),headers:{'content-type':'image/png'}};
    if (url.endsWith('/members')) return {data:{code:0,data:{items:[{member_id:'ou_person',member_id_type:'open_id'}],has_more:false,trigger_security_conf_limit:false}}};
    if (url.includes('/chats/')) return {data:{code:0,data:{chat_id:'oc_private',chat_mode:'p2p'}}};
    if (url.endsWith('/om_card')) return {data:{code:0,data:{items:[{message_id:'om_card',chat_id:'oc_private',msg_type:'interactive',deleted:false,sender:{id:appId,id_type:'app_id',sender_type:'app'}}]}}};
    return {data:{code:0,data:{items:[{message_id:'om_image',chat_id:'oc_private',msg_type:'image',deleted:false,create_time:'1790000000000',sender:{id:'ou_person',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({image_key:'img_synthetic'})}}]}}};
  })};
  const transport=createLifecycleReceiptFeishuTransport({readConfig:()=>config,http,isAuthenticatedWsDelivery:(payload,id)=>id===appId && !!payload && typeof payload==='object' && trusted.has(payload)});
  return { event,transport,http,trust:()=>trusted.add(event),setConfig:(value:typeof config)=>{config=value;} };
}

describe('isolated Feishu receipt transport',()=>{
  it('only accepts an attested immutable WS payload and verifies the message and private chat independently',async()=>{
    const f=fixture(), verifier=createPurchaseLifecycleReceiptEventVerifier(f.transport);
    await expect(verifier.verify(f.event,appId)).rejects.toThrow(); f.trust();
    const snapshot=await verifier.verify(f.event,appId); expect(snapshot).toMatchObject({appId,actorOpenId:'ou_person',chatId:'oc_private',imageMessageId:'om_image',imageKey:'img_synthetic'});
    const privateVerifier=createLifecyclePrivateChatVerifier(f.transport,()=>1790000000000);
    const identity={appId,actorOpenId:'ou_person',chatId:'oc_private',cardMessageId:'om_card'};
    const proof=await privateVerifier.verify(identity); expect(()=>privateVerifier.assertProof(proof,identity)).not.toThrow();
    expect(f.http.get).toHaveBeenCalledTimes(4);
  });
  it('rejects fake or mutable events and a mismatched app',async()=>{
    const f=fixture(); f.trust();
    expect(await f.transport.verifyEventOrigin({...f.event},appId)).toBe(false);
    expect(await f.transport.verifyEventOrigin(f.event,'cli_other')).toBe(false);
    const shallow=Object.freeze({...f.event,event:{...f.event.event}});
    expect(await f.transport.verifyEventOrigin(shallow,appId)).toBe(false);
    const unattested=createLifecycleReceiptFeishuTransport({readConfig:()=>({appId,appSecret:secret,appToken}),http:f.http});
    expect(await unattested.verifyEventOrigin(f.event,appId)).toBe(false);
  });
  it('rejects missing or inconsistent message and private-chat evidence',async()=>{
    const f=fixture(); f.trust();
    f.http.get.mockResolvedValueOnce({data:{code:0,data:{items:[]}}} as never);
    await expect(createPurchaseLifecycleReceiptEventVerifier(f.transport).verify(f.event,appId)).rejects.toThrow();
    const g=fixture(); g.http.get.mockResolvedValueOnce({data:{code:0,data:{items:[]}}} as never);
    await expect(createLifecyclePrivateChatVerifier(g.transport).verify({appId,actorOpenId:'ou_person',chatId:'oc_private',cardMessageId:'om_card'})).rejects.toThrow();
  });
  it('binds downloads to application and content, uploads once and never retries unknown outcomes',async()=>{
    const f=fixture(), buffer=await f.transport.downloadMessageImage('om_image','img_synthetic');
    expect(await f.transport.uploadAttachment(buffer)).toBe('synthetic-file-token');
    await expect(f.transport.uploadAttachment(buffer)).rejects.toThrow();
    const next=await f.transport.downloadMessageImage('om_image','img_synthetic');
    f.http.post.mockImplementationOnce(async()=>({data:{code:0,tenant_access_token:'synthetic-app-token'}})).mockRejectedValueOnce(Error('synthetic lost response'));
    await expect(f.transport.uploadAttachment(next)).rejects.toThrow(); await expect(f.transport.uploadAttachment(next)).rejects.toThrow();
    expect(f.http.post.mock.calls.filter(([url])=>url.includes('/medias/upload_all'))).toHaveLength(2);
  });
  it('rejects mutated bytes, a changed app or malformed media',async()=>{
    const f=fixture(), buffer=await f.transport.downloadMessageImage('om_image','img_synthetic'); buffer[8]=9;
    await expect(f.transport.uploadAttachment(buffer)).rejects.toThrow();
    const g=fixture(), other=await g.transport.downloadMessageImage('om_image','img_synthetic'); g.setConfig({appId:'cli_other',appSecret:secret,appToken});
    await expect(g.transport.uploadAttachment(other)).rejects.toThrow();
    const h=fixture();h.http.get.mockResolvedValueOnce({data:Buffer.from('not-image'),headers:{'content-type':'image/png'}} as never);
    await expect(h.transport.downloadMessageImage('om_image','img_synthetic')).rejects.toThrow();
  });
  it('rejects credentials changing during message reads and never exposes upstream errors',async()=>{
    const f=fixture();
    f.http.get.mockImplementationOnce(async()=>{f.setConfig({appId:'cli_other',appSecret:secret,appToken});return {data:Buffer.from(image),headers:{'content-type':'image/png'}};});
    await expect(f.transport.downloadMessageImage('om_image','img_synthetic')).rejects.toThrow('来源不可核对');
    const g=fixture(); g.http.post.mockRejectedValueOnce(Error(`sensitive ${secret}`));
    await expect(g.transport.readCard(appId,'om_card')).rejects.not.toThrow(secret);
  });
});
